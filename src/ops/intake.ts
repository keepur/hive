/**
 * KPR-468 D7: acknowledgement intake — the seam KPR-455's inbound edge calls.
 *
 * D12 item (5), and it belongs HERE rather than on the adapter: the ledger is
 * the only thing an acknowledgement writes, D6 bars an adapter from touching
 * it, and D7's rules are the same ones this component already enforces on
 * every other transition. Splitting intake into its own component would mean
 * two writers to one ledger enforcing one rule set, which is how the rule set
 * drifts.
 *
 * Records THE PRINCIPAL AND THE INSTANT AND NOTHING ELSE (D9): no display
 * name, no email, no device, no client, no location, and deliberately no
 * free-text reason for a dismissal.
 */
import { ObjectId, type Collection } from "mongodb";
import { createLogger } from "../logging/logger.js";
import {
  HARD_SNOOZE_CEILING_MS,
  OPS_SYSTEM_PRINCIPAL,
  expiresAtFor,
  type OpsAck,
  type OpsAcknowledgement,
  type OpsIntakeResult,
  type OpsNotification,
  type OpsNotificationState,
  type OpsNotifierCounters,
  type OpsPolicy,
} from "./notification-types.js";
import { WRITE } from "./notification-store.js";
import { OPS_ID_MAX_LENGTH } from "./ids.js";

const log = createLogger("ops-intake");

/** D7's table: the four states an attributed act may transition FROM. */
const LEGAL_FROM: readonly OpsNotificationState[] = ["pending", "delivered", "seen", "snoozed"];

/** D7's `OpsAck`: the only three states an attributed act may transition TO. */
const ACTS: readonly unknown[] = ["seen", "dismissed", "snoozed"] satisfies readonly OpsAck[];

/** Step 2b's membership test, exported so the seam's pre-validation log line can use the same one. */
export function isOpsAck(value: unknown): value is OpsAck {
  return ACTS.includes(value);
}

/** Signals a lost CAS to the one-retry loop. Never escapes this module. */
const LOST = Symbol("cas-lost");

/**
 * D7: the handle is the ledger row's `_id` rendered as a hex string, opaque by
 * contract. `ObjectId.isValid` also accepts 12-byte strings, so the hex
 * round-trip is what makes this total.
 *
 * The `.toLowerCase()` is deliberate and is the one widening here: an
 * ALL-UPPERCASE valid hex handle is ACCEPTED, because it names the same
 * twelve bytes and therefore the same row. The handle confers no authority
 * (D7, D9) — attribution is `actorId`'s job and every act is re-checked
 * against the row's own state — so a case-insensitive parse widens nothing
 * that matters, and refusing it would turn a vendor round-trip that upcased a
 * callback value into an `unknown-handle` refusal for a real act. What the
 * round-trip DOES reject is everything `ObjectId.isValid` admits that is not
 * 24 hex characters, which is the actual hazard (it accepts any 12-byte
 * string).
 */
export function parseHandle(handle: unknown): ObjectId | undefined {
  if (typeof handle !== "string" || handle.length !== 24) return undefined;
  if (!ObjectId.isValid(handle)) return undefined;
  const id = new ObjectId(handle);
  return id.toHexString() === handle.toLowerCase() ? id : undefined;
}

/** Per-call facts an attempt observed, so a retried attempt does not double-count them. */
interface AttemptNotes {
  atPredatesRow: boolean;
}

export class OpsIntake {
  constructor(
    private readonly notifications: Collection<OpsNotification>,
    private readonly counters: OpsNotifierCounters,
    private readonly retentionDays: number,
    private readonly clock: () => Date,
  ) {}

  /**
   * One indexed read plus one CAS. A lost CAS — a sweep tick moved the row
   * between read and write — retries ONCE and then returns unavailable, with
   * a warn of its own.
   *
   * `policy` is THE COPY THE LAST TICK RETAINED, never a fresh read (D5). That
   * is what keeps this inside the "one indexed read plus one CAS" bound, and
   * it is why `?? HARD_SNOOZE_CEILING_MS` below covers TWO paths rather than
   * one: no ops_policy document registered, AND no tick having completed yet
   * (intake is live from init() while the sweep starts later, D10). Both
   * resolve to the hard ceiling, which is the correct answer for both.
   */
  async accept(input: OpsAcknowledgement, rowId: ObjectId, policy: OpsPolicy | null): Promise<OpsIntakeResult> {
    const notes: AttemptNotes = { atPredatesRow: false };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.attempt(input, rowId, policy, notes);
      if (outcome !== LOST) {
        this.countNotes(notes, input);
        return outcome;
      }
    }
    this.countNotes(notes, input);
    // ⚠ The seventh `unavailable` (OpsNotifier.accept enumerates all seven),
    // and until this line the only one of the three WORK-shaped causes that
    // left no trace. Two lost CASes in one call mean the row's state or ack
    // marks moved between read and write twice running. This call holds the
    // per-row latch, so in-process only ingest's clearing arm can do that, and
    // a retry that reads the clear is refused `row-cleared` rather than lost —
    // a stream of these points at a writer outside this process (a second
    // engine, a hand edit). `act` is safe to print: a CAS is only reached
    // after step 2b validated it.
    log.warn("ops intake lost its CAS twice — answered unavailable; a retry of the same act is safe", {
      act: input.act,
    });
    return { state: "unavailable" };
  }

  /** Once per accept() call, never once per attempt. */
  private countNotes(notes: AttemptNotes, input: OpsAcknowledgement): void {
    if (!notes.atPredatesRow) return;
    this.counters.intakeInvalidAt += 1;
    log.warn(
      "ops intake received an `at` earlier than the notification it acknowledges — anchoring on the server clock",
      {
        act: input.act,
      },
    );
  }

  private async attempt(
    input: OpsAcknowledgement,
    rowId: ObjectId,
    policy: OpsPolicy | null,
    notes: AttemptNotes,
  ): Promise<OpsIntakeResult | typeof LOST> {
    // ── 1. Resolve the handle to exactly one row. ──
    const row = await this.notifications.findOne({ _id: rowId });
    if (!row) return { state: "refused", reason: "unknown-handle" };

    // ── 2. Attribute or refuse. ──
    // The OPS_SYSTEM_PRINCIPAL arm is an EXPLICIT REFUSAL, not an assumption.
    // Without it, a caller passing the reserved id — a mis-written KPR-455
    // edge, an operator command defaulting its actor, a transport handing back
    // its own service identity — lands seen/dismissed/snoozed attributed to
    // the system principal, which D7 rule 5 and C9 forbid ABSOLUTELY. Never
    // attributed to the adapter, to a service account, or to the system
    // principal.
    //
    // The LENGTH bound is `OPS_ID_MAX_LENGTH` by ADJACENCY, not derivation —
    // the same 200 KPR-454 bounds subject/evidence ids and a subscription
    // row's `_id` with (ids.ts). A real actorId is a Slack user id or an agent
    // slug, a small fraction of it. Unbounded, a caller-supplied string would
    // be STORED TWICE on the row (as `principal` and inside `lastAckKey`).
    // Refused rather than truncated: a truncated id attributes the act to an
    // identity nobody holds.
    if (
      typeof input.actorId !== "string" ||
      input.actorId.trim().length === 0 ||
      input.actorId.length > OPS_ID_MAX_LENGTH ||
      input.actorId === OPS_SYSTEM_PRINCIPAL
    ) {
      return { state: "refused", reason: "unattributed" };
    }

    // ── 2b. The act must be one of D7's three. ──
    // `act: OpsAck` is a compile-time claim, and D6 opens this seam to an agent
    // tool call and an operator CLI, so it is checked like handle, actorId and
    // `at` are — because step 8 writes it VERBATIM into `state`. Unchecked,
    // `cleared` lands a clear attributed to a person (D7 rule 5, C9 — only a
    // clearing fact clears); `pending`/`delivered` land a working state with
    // nextNudgeAt unset, which no delivery arm ever reads again (a terminal
    // state, C10); anything else stores a value outside D7's closed six.
    //
    // Refused as `illegal-transition` — no act outside the three is a legal
    // transition from any state — and HERE, ahead of the replay check, rather
    // than folded into step 6: a malformed act must never earn a `noop`
    // (`superseded`) or the benign `row-cleared` from steps 3–4, both of which
    // tell the edge its call was fine.
    if (!isOpsAck(input.act)) return { state: "refused", reason: "illegal-transition" };

    const now = this.clock();
    // ⚠ AN UNUSABLE `at` IS SUBSTITUTED WITH `now`, AND THE SUBSTITUTION IS
    // COUNTED AT THE SEAM (OpsNotifier.accept, Step 2) rather than being made
    // silently here. It matters because `lastAckKey` is derived from the RAW
    // `at`: a caller that passes an invalid Date derives a DIFFERENT key on
    // every retry, so a duplicated callback double-applies — precisely the
    // residual D7's idempotence rule exists to prevent. Substituting rather
    // than refusing is still right (an edge that mis-serializes a timestamp
    // must not lose a human's acknowledgement), but the operator gets a
    // counter and a warn instead of silence. Recorded in the plan index's
    // Assumptions as a named edge this child owes forward to KPR-455.
    const usableAt = input.at instanceof Date && !Number.isNaN(input.at.getTime());
    const at = usableAt ? input.at : now;
    // ⚠ THE PAST-SIDE BOUND, which `min(at, now)` alone does not have. D7 uses
    // a past `at` as given because a vendor act honestly precedes its callback
    // — but an `at` EARLIER THAN THE ROW'S OWN FIRST EVENT cannot be the
    // instant of an act on this row, and used as given it collapses every
    // horizon derived from anchorAt: a Slack `action_ts` read as milliseconds
    // instead of seconds lands in January 1970, so `expiresAt` (D9) is decades
    // past and the TTL deletes the row within a minute, and the snooze ceiling
    // is `anchorAt + 7 d` — also 1970 — so the pause expires on the next tick.
    // Such an `at` is treated exactly like an unusable one: the ANCHOR takes
    // the server clock and the substitution is counted (`intakeInvalidAt`,
    // once per call — countNotes) and warned. `lastAckKey` still keeps the RAW
    // value, so unlike the non-Date shape a retried duplicate DOES dedupe.
    //
    // `firstSeenAt`, not the `_id`'s embedded timestamp: it is a named,
    // immutable, engine-written field (the first event's publishedAt, which
    // KPR-454's publisher stamps from the engine's clock), where an ObjectId's
    // timestamp is second-granular and read nowhere else in this component.
    // The bound invents no number. An honest act follows its row's first event
    // by at least the ingest that created the row — plus, for a vendor act, a
    // post and a human — which ordinary clock skew does not reach; and a false
    // trip costs only a horizon measured from a few seconds later.
    //
    // ⚠ RESIDUAL, named in the plan index's Assumptions and owed to KPR-455 /
    // the spec lane: this bounds the anchor at the row's BIRTH, not at "now
    // minus some staleness window". A dishonest `at` that falls INSIDE the
    // row's lifetime still shortens its horizons by up to the row's age; and a
    // substituted anchor is its ARRIVAL instant, so a delayed duplicate of an
    // older predating act is applied rather than superseded (step 3's guard
    // orders by anchor). Choosing a window is a number D7 does not name.
    const atPredatesRow = usableAt && row.firstSeenAt instanceof Date && at.getTime() < row.firstSeenAt.getTime();
    if (atPredatesRow) notes.atPredatesRow = true;
    // The one derived value that governs every clock-bearing write.
    const anchorAt = atPredatesRow ? now : new Date(Math.min(at.getTime(), now.getTime()));

    // ── 3. Idempotence replay check, BEFORE legality — plus the monotonicity
    //       guard on the same step. ──
    // The key is a pure function of the CALLER'S INPUT (the raw `at`), or a
    // retried duplicate clamped against a later `now` would derive a different
    // key and re-apply.
    const lastAckKey = `${input.actorId}:${input.act}:${at.toISOString()}`;
    if (row.lastAckKey === lastAckKey) return { state: "noop", reason: "already-applied" };
    // ⚠ The anchor is `lastAckAt`, DELIBERATELY NOT `principalAt`, which is the
    // obvious-looking field and is wrong: principalAt advances on SYSTEM
    // transitions too (a delivery, a snooze expiry, a clear), so a nudge
    // landing one second after a human's click would make that human's
    // acknowledgement look stale and no-op it — losing a real act and nudging
    // forever, which is worse than the regression this guard prevents.
    if (row.lastAckAt !== undefined && anchorAt.getTime() <= row.lastAckAt.getTime()) {
      return { state: "noop", reason: "superseded" };
    }

    // ── 4. `cleared` refusal. ──
    // The ordinary race in which a clearing fact lands between a delivery and
    // the acknowledger's click. KPR-455's edge must treat this as BENIGN — a
    // no-op for the acknowledger, not an error they must surface.
    if (row.state === "cleared") return { state: "refused", reason: "row-cleared" };

    // ── 5. `integrity` dismissal refusal (D7 rule 3). ──
    if (input.act === "dismissed" && row.class === "integrity") {
      return { state: "refused", reason: "integrity-dismissal" };
    }

    // ── 6. Transition legality. ──
    if (!LEGAL_FROM.includes(row.state)) return { state: "refused", reason: "illegal-transition" };

    // ── 7. Snooze validation and the clamp. ──
    let snoozedUntil: Date | undefined;
    if (input.act === "snoozed") {
      const requested = input.snoozedUntil;
      // The refusal test is against anchorAt for the same reason the ceiling
      // is: with a bogus future `at`, a genuinely future snoozedUntil would
      // otherwise be refused as "not a pause".
      if (
        !(requested instanceof Date) ||
        Number.isNaN(requested.getTime()) ||
        requested.getTime() <= anchorAt.getTime()
      ) {
        return { state: "refused", reason: "snooze-not-future" };
      }
      const registered =
        typeof policy?.maxSnoozeMs === "number" && policy.maxSnoozeMs > 0 ? policy.maxSnoozeMs : HARD_SNOOZE_CEILING_MS;
      const ceiling = Math.min(HARD_SNOOZE_CEILING_MS, registered);
      // CLAMPED AND APPLIED, NEVER REFUSED (D12): refusing would leave the row
      // unpaused and nudging, the opposite of what the acknowledger asked for.
      // Anchored on anchorAt rather than on `at` — that is what makes it a
      // CEILING rather than a caller-supplied value, on an `integrity` row
      // included.
      snoozedUntil = new Date(Math.min(requested.getTime(), anchorAt.getTime() + ceiling));
    }

    // ── 8. Apply, as ONE CAS conditioned on state, lastAckKey and lastAckAt. ──
    const set: Record<string, unknown> = {
      state: input.act,
      stateAt: anchorAt,
      principal: input.actorId,
      principalAt: anchorAt,
      lastAckKey,
      lastAckAt: anchorAt,
    };
    // nextNudgeAt is unset on ALL THREE acts: for seen/dismissed because both
    // stop nudging, and for snoozed as well, because the row is suppressed
    // until snoozedUntil and the expiry phase re-sets nextNudgeAt = now on the
    // way back into a working state. Unsetting it is also what keeps a
    // RETAINED forceDeliver out of arm 2's index range while the row is not
    // working, which is why arm 2's index carries no `state` key.
    const unset: Record<string, ""> = { nextNudgeAt: "" };
    if (input.act === "snoozed") {
      // `snoozedUntil!` rather than the bare local: on this branch step 7 has
      // provably assigned it (every other path there RETURNS), but TypeScript
      // cannot narrow across the two blocks. Written with the assertion rather
      // than left to `set`'s `Record<string, unknown>` index signature to
      // swallow — that signature accepts `undefined` happily, which would
      // serialize to `null` and silently break "every write that sets
      // state: snoozed also sets snoozedUntil" the day `set` is given a real
      // type.
      set.snoozedUntil = snoozedUntil!;
      // The snoozed arm deliberately does NOT clear forceDeliver — the
      // re-delivery is still owed after the pause.
    } else {
      unset.snoozedUntil = "";
      unset.forceDeliver = "";
    }
    // D9's state invariant, one pattern at every state-changing write. `seen`
    // and `dismissed` set it; `snoozed` unsets it — INCLUDING on the
    // `seen → snoozed` arm, where the row arrives carrying a live one.
    const expires = expiresAtFor(input.act, anchorAt, this.retentionDays);
    if (expires) set.expiresAt = expires;
    else unset.expiresAt = "";

    // ⚠ An absent precondition is written `{ $exists: false }`, NEVER a
    // literal `undefined`. Passing undefined happens to work against this repo
    // today only because `ignoreUndefined` is not set anywhere in src/ and the
    // driver therefore serializes undefined → null, which matches a missing
    // field; that is an accident of an unset client option, not a guarantee,
    // and a later MongoClient option would silently turn every FIRST
    // acknowledgement into a lost CAS.
    const result = await this.notifications.updateOne(
      {
        _id: rowId,
        state: row.state,
        ...(row.lastAckKey === undefined ? { lastAckKey: { $exists: false } } : { lastAckKey: row.lastAckKey }),
        ...(row.lastAckAt === undefined ? { lastAckAt: { $exists: false } } : { lastAckAt: row.lastAckAt }),
      },
      { $set: set, $unset: unset },
      WRITE,
    );
    if (result.matchedCount === 0) return LOST;

    return {
      state: "applied",
      rowState: input.act,
      // The clamped value is echoed back so the edge can tell the human what
      // it actually did (D12).
      ...(snoozedUntil ? { snoozedUntil } : {}),
    };
  }
}
