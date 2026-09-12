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
import {
  HARD_SNOOZE_CEILING_MS,
  OPS_SYSTEM_PRINCIPAL,
  expiresAtFor,
  type OpsAcknowledgement,
  type OpsIntakeResult,
  type OpsNotification,
  type OpsNotificationState,
  type OpsPolicy,
} from "./notification-types.js";
import { WRITE } from "./notification-store.js";

/** D7's table: the four states an attributed act may transition FROM. */
const LEGAL_FROM: readonly OpsNotificationState[] = ["pending", "delivered", "seen", "snoozed"];

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

export class OpsIntake {
  constructor(
    private readonly notifications: Collection<OpsNotification>,
    private readonly retentionDays: number,
    private readonly clock: () => Date,
  ) {}

  /**
   * One indexed read plus one CAS. A lost CAS — a sweep tick moved the row
   * between read and write — retries ONCE and then returns unavailable.
   *
   * `policy` is THE COPY THE LAST TICK RETAINED, never a fresh read (D5). That
   * is what keeps this inside the "one indexed read plus one CAS" bound, and
   * it is why `?? HARD_SNOOZE_CEILING_MS` below covers TWO paths rather than
   * one: no ops_policy document registered, AND no tick having completed yet
   * (intake is live from init() while the sweep starts later, D10). Both
   * resolve to the hard ceiling, which is the correct answer for both.
   */
  async accept(input: OpsAcknowledgement, rowId: ObjectId, policy: OpsPolicy | null): Promise<OpsIntakeResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await this.attempt(input, rowId, policy);
      if (outcome !== LOST) return outcome;
    }
    return { state: "unavailable" };
  }

  private async attempt(
    input: OpsAcknowledgement,
    rowId: ObjectId,
    policy: OpsPolicy | null,
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
    if (
      typeof input.actorId !== "string" ||
      input.actorId.trim().length === 0 ||
      input.actorId === OPS_SYSTEM_PRINCIPAL
    ) {
      return { state: "refused", reason: "unattributed" };
    }

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
    const at = input.at instanceof Date && !Number.isNaN(input.at.getTime()) ? input.at : now;
    // The one derived value that governs every clock-bearing write.
    const anchorAt = new Date(Math.min(at.getTime(), now.getTime()));

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
