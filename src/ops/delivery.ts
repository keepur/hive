/**
 * KPR-468 D5: cadence resolution, the three-armed delivery scan, the attempt
 * gate, the stall, and snooze expiry.
 */
import type { Collection } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { clipForLog } from "./ids.js";
import type { LoadedReason } from "./store.js";
import type { OpsSubscription } from "./types.js";
import type { DeliveryOutcome, NotificationView, OpsTransport } from "./transport.js";
import {
  ATTEMPTS_RING_CAP,
  ATTEMPT_SPACING_MS,
  DELIVERY_ARM_PAGE_SIZE,
  DELIVERY_BUDGET_MS,
  EXPIRY_PAGE_SIZE,
  OPS_NUDGE_STATES,
  OPS_SYSTEM_PRINCIPAL,
  expiresAtFor,
  stallRecheckAt,
  type NotificationAttempt,
  type OpsNotification,
  type OpsNotifierCounters,
  type OpsPolicy,
  type StalledReason,
} from "./notification-types.js";
import { WRITE } from "./notification-store.js";

const log = createLogger("ops-delivery");

/**
 * D5: the two stall reasons that hold a row the attempt gate would ADMIT. The
 * third, `cadence`, is the gate itself declining, and it cannot hold an
 * attemptCount-0 or forceDeliver row — see DeliveryPhase.run's two passes.
 */
const BLOCKED_STALL_REASONS = ["subscription", "transport"] as const satisfies readonly StalledReason[];

/** D5: warn-once PER PROCESS, memoized on (profileName, intervalMs). */
const floorWarned = new Set<string>();

const own = (record: Record<string, number> | undefined, key: string): number | undefined =>
  record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

/**
 * D5. Cadence comes from the contract's DATA, never from this component.
 *
 * The anti-merge rule is ENFORCED rather than documented: a subscription
 * naming a cadenceProfile SUBSTITUTES that profile WHOLESALE — the
 * (class, retry) table is not consulted at all, with no field-by-field merge,
 * no per-attribute override and no inheritance. An UNKNOWN profile name
 * therefore does NOT fall back to the table: the row resolves no cadence, is
 * counted, and does not nudge. A fallback would be precisely the
 * two-tables-and-an-implicit-precedence rules engine D5 refuses.
 *
 * Returns `undefined` for "no cadence resolved", which is the shipped default
 * (zero ops_policy rows) and is a DEPLOYMENT GATE, not a failure.
 */
export function resolveCadence(
  row: Pick<OpsNotification, "class" | "retry">,
  sub: OpsSubscription,
  policy: OpsPolicy | null,
): number | undefined {
  if (!policy) return undefined;
  const raw =
    sub.cadenceProfile !== undefined
      ? own(policy.profiles, sub.cadenceProfile)
      : own(policy.cadence, `${row.class}:${row.retry}`);
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  const floor = policy.minNudgeIntervalMs;
  if (typeof floor === "number" && floor > raw) {
    if (sub.cadenceProfile !== undefined) {
      // D5 says "loudly, at registration", and registration here is a Mongo
      // write no code path observes, so load time is the honest substitution.
      // PER PROCESS, not per load: the policy document is read on EVERY 30 s
      // tick, so a per-load rule would emit one line per bad profile every
      // 30 s forever — a permanent log loop in exactly the steady state a
      // mis-registered profile produces. Keying on the VALUE as well as the
      // name means a corrected-then-re-broken profile warns again.
      const key = `${sub.cadenceProfile}:${raw}`;
      if (!floorWarned.has(key)) {
        floorWarned.add(key);
        log.warn("ops cadence profile below the registered minimum — clamped up", {
          // Operator-written and unbounded, so clipped exactly as the same
          // row's `_id` is on the subscription-load warns (notifier.ts, C13).
          // The memo key above keeps the FULL name: it decides, it is not printed.
          profile: clipForLog(sub.cadenceProfile),
          requestedMs: raw,
          clampedToMs: floor,
        });
      }
    }
    return floor;
  }
  return raw;
}

/** Test-only: the warn-once memo is process-global by design. */
export function __resetCadenceWarningsForTests(): void {
  floorWarned.clear();
}

export interface DeliveryContext {
  subscriptions: Map<string, OpsSubscription>;
  transports: Map<string, OpsTransport>;
  reasons: Map<string, LoadedReason>;
  policy: OpsPolicy | null;
  lock: <T>(rowId: string, fn: () => Promise<T>) => Promise<T>;
  stopped: () => boolean;
  /**
   * KPR-294's write guard, threaded exactly as KPR-456 threads it
   * (`() => !writeGuard.engaged`, index.ts). `false` means the database's
   * identity is unverified: writes are refused and reads may be answering out
   * of another instance's database. Checked before every write this phase
   * makes AND immediately before every post — the post is the one step that
   * cannot be refused after the fact, and a post whose record the guard then
   * refuses leaves the row due, so the next tick would post it again.
   */
  canWrite: () => boolean;
  clock: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export interface DeliveryResult {
  ok: boolean;
  attempted: number;
  /** True when the phase stopped on its wall-clock budget with rows still due. */
  deferred: boolean;
}

export class DeliveryPhase {
  constructor(
    private readonly notifications: Collection<OpsNotification>,
    private readonly counters: OpsNotifierCounters,
    private readonly retentionDays: number,
  ) {}

  /**
   * D5's snooze expiry. Runs BEFORE delivery within a tick, so a row whose
   * snooze expires on this tick is re-delivered on THIS tick rather than
   * waiting for the next — the phase order is fixed because either order is
   * defensible and an unstated one becomes an accidental extra interval of
   * silence for a row the acknowledger explicitly asked to be reminded about.
   */
  async expire(now: Date, ctx: DeliveryContext): Promise<boolean> {
    let ok = true;
    const rows = await this.notifications
      .find({ state: "snoozed", snoozedUntil: { $lte: now } })
      .sort({ snoozedUntil: 1 })
      .limit(EXPIRY_PAGE_SIZE)
      .toArray();
    for (const row of rows) {
      if (ctx.stopped()) return ok;
      // The guard is a phase stop, not a per-row skip: every remaining row
      // would decline for the same reason, and the notifier counts the tick.
      if (!ctx.canWrite()) return false;
      try {
        await ctx.lock(String(row._id), async () => {
          // Re-checked INSIDE the latch, immediately before the write: the
          // latch can be held across a whole adapter deadline by intake or by
          // a slow post, and the guard can engage while this row waits for it.
          if (!ctx.canWrite()) return;
          // D7's table: `delivered` if the row has a recorded `accepted`
          // outcome IN THIS OCCURRENCE, else `pending`.
          //
          // ⚠ The marker is `deliveryReference`, NOT the attempts[] ring and
          // NOT `lastOutcome`. The ring is capped at ATTEMPTS_RING_CAP, so a
          // row nudged past the cap since its accepted delivery no longer
          // RECORDS that outcome in it; and `lastOutcome` is the LAST
          // attempt's outcome, so a row accepted and then nudged with a
          // `rejected` would be demoted, while a reopened row snoozed before
          // its first new attempt still carries the PREVIOUS occurrence's
          // `accepted`. deliveryReference is written only on an accepted
          // outcome and is unset ONLY by the `cleared → pending` reopen
          // (ingest.ts, Arm A) — the occurrence boundary — so it is exactly
          // "accepted since this occurrence began". Before the reopen unset
          // it, a reopen → rejected attempt → snooze → expiry reported
          // `delivered` for an occurrence no transport ever accepted.
          const next = row.deliveryReference !== undefined ? "delivered" : "pending";
          // ⚠ `snoozedUntil: { $lte: now }` IN THE FILTER, not only in the scan.
          // The scan's copy predates this latch, so a RE-SNOOZE (intake moves
          // snoozedUntil and nothing else — D7) landing between the scan and
          // here still satisfies `state: "snoozed"`. Filtered on state alone,
          // this write then expired a pause intake had just answered `applied`
          // with a later snoozedUntil for, and the row was re-delivered on this
          // tick. A miss is a benign lost race — the newer pause stands — so it
          // is not counted.
          await this.notifications.updateOne(
            { _id: row._id, state: "snoozed", snoozedUntil: { $lte: now } },
            {
              $set: {
                state: next,
                stateAt: now,
                principal: OPS_SYSTEM_PRINCIPAL,
                principalAt: now,
                nextNudgeAt: now,
                // D5: what makes C10's "snoozed ... EXPIRES" true rather than
                // nominal under the shipped default. The row's attemptCount is
                // by construction > 0 (it was being delivered when it was
                // snoozed), so the first disjunct cannot carry it.
                forceDeliver: true,
              },
              // D9's state invariant: the row re-enters a WORKING state, so
              // expiresAt is unset. (`expiresAtFor(next, ...)` is undefined
              // here by construction; the unset is the `else` branch of the
              // one pattern every state-changing write in this ticket uses.)
              $unset: { snoozedUntil: "", expiresAt: "" },
            },
            WRITE,
          );
        });
      } catch (err) {
        // Per-row containment — the phase continues to the next row.
        ok = false;
        this.counters.sweepFaults += 1;
        log.warn("ops snooze expiry fault — continuing", { error: String(err) });
      }
    }
    return ok;
  }

  /**
   * D5's three ordered arms, served under ONE shared wall-clock budget, with
   * arms 1 and 2 each read in TWO passes.
   *
   * The stall alone bounds the STEADY-STATE cost; it does not by itself
   * guarantee that a re-check tick's arriving cohort cannot crowd out a new
   * row on that tick. That guarantee is the arm split: arms 1 and 2 carry an
   * equality bound on their index's leading key, so the CADENCE-stall backlog
   * is not in their buckets AT ALL — structural immunity, not an ordering
   * convention a query planner could lose.
   *
   * ⚠ That equality bound does NOT exclude the OTHER two stall reasons, and
   * the two passes are what does. A row stalled on `subscription` or
   * `transport` has not been attempted, so it keeps `attemptCount: 0` (and a
   * forced row keeps `forceDeliver`) and sits in arm 1's (or arm 2's) bucket
   * for as long as it stays blocked — which, for a subscription whose
   * adapterId names no registered adapter (D6 loads it unvalidated), is
   * forever, and grows with traffic. Such rows sort OLDEST, so read in one
   * pass they took the page and the budget ahead of a healthy subscriber's
   * fresh row, re-arriving every stall re-check, and a large enough blocked
   * set starved that row indefinitely. So each of arms 1 and 2 is served:
   *
   *  (a) first over rows NOT blocked (`stalledReason ∉ {subscription,
   *      transport}` — a `cadence` stall cannot hold a row here, since the
   *      first two gate disjuncts pass by construction, and a snooze-expired
   *      row legitimately arrives still carrying one); then
   *  (b) over the blocked rows, still ahead of arm 3 — so D5's "an
   *      attemptCount 0 row stalled on subscription or transport is first
   *      delivered on a re-check tick once it clears" is not demoted behind
   *      the cadence backlog.
   *
   * The two passes PARTITION each arm exactly, so no row is read twice. What
   * pass (a)'s exclusion costs is stated plainly: it is a residual filter
   * over the arm's index, so the DATABASE still walks any due blocked rows in
   * that prefix. What it buys is that they no longer consume the page, the
   * per-row latch, a stall write or the phase's wall-clock budget ahead of a
   * servable row — which is the resource the starvation was over.
   */
  async run(now: Date, ctx: DeliveryContext): Promise<DeliveryResult> {
    // ⚠ The budget clock starts HERE, at the top of the delivery phase, from a
    // FRESH clock reading — NOT from the tick's `now`, which was captured
    // before ingest and snooze expiry ran. Measured from `now`, a tick whose
    // ingest alone took DELIVERY_BUDGET_MS (a warm restart draining a backlog,
    // i.e. exactly the surge the budget exists for) would reach this phase
    // with the budget already spent and starve every row, arm 1's guaranteed
    // first delivery included. D5's budget is per PHASE. `now` itself stays
    // the tick's instant for everything the rows record and for the due-scan.
    const budgetEnd = ctx.clock().getTime() + DELIVERY_BUDGET_MS;
    const working = { $in: [...OPS_NUDGE_STATES] };
    const notBlocked = { stalledReason: { $nin: [...BLOCKED_STALL_REASONS] } };
    const blocked = { stalledReason: { $in: [...BLOCKED_STALL_REASONS] } };
    const arm1 = { state: working, attemptCount: 0, nextNudgeAt: { $lte: now } };
    // Arm 2 — the two non-cadence re-delivery triggers. No `state` key: no
    // non-working row carries a nextNudgeAt at all (D5's scoping of the
    // never-unset rule), so this range holds only pending/delivered rows by
    // type bracketing rather than by a residual filter.
    const arm2 = { forceDeliver: true, nextNudgeAt: { $lte: now } };
    const arms = [
      // Arm 1 — the guaranteed first delivery — then arm 2, each over the rows
      // no subscription/transport stall is holding.
      { ...arm1, ...notBlocked },
      { ...arm2, ...notBlocked },
      // The same two arms over the rows such a stall IS holding (see above).
      { ...arm1, ...blocked },
      { ...arm2, ...blocked },
      // Arm 3 — ordinary cadence nudges. This is the arm a stall cohort lands
      // in, and it is drawn last.
      { state: working, nextNudgeAt: { $lte: now } },
    ];

    const seen = new Set<string>();
    let ok = true;
    let attempted = 0;
    let deferred = false;
    let nextAttemptAt = 0;

    for (const filter of arms) {
      const rows = await this.notifications
        .find(filter as never)
        .sort({ nextNudgeAt: 1 })
        .limit(DELIVERY_ARM_PAGE_SIZE)
        .toArray();
      for (const row of rows) {
        if (ctx.stopped()) return { ok, attempted, deferred: true };
        // A phase stop, like `stopped` — not ok, because work was left due.
        if (!ctx.canWrite()) return { ok: false, attempted, deferred: true };
        // The budget is wall-clock and is counted over EVERY row the phase
        // touches, attempted or declined — which is precisely why the stall
        // and the arm split exist rather than a bare cap on the scan.
        if (ctx.clock().getTime() >= budgetEnd) return { ok, attempted, deferred: true };
        const id = String(row._id);
        // A row matching more than one arm is attempted once per tick.
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          const result = await ctx.lock(id, async () => {
            const wait = nextAttemptAt - ctx.clock().getTime();
            return this.attemptRow(row, now, ctx, wait);
          });
          if (result !== "declined") {
            attempted += 1;
            nextAttemptAt = ctx.clock().getTime() + ATTEMPT_SPACING_MS;
          }
          if (result === "attempted-unrecorded") ok = false;
        } catch (err) {
          ok = false;
          this.counters.sweepFaults += 1;
          log.warn("ops delivery fault — continuing to the next row", { error: String(err) });
        }
      }
    }
    if (!deferred) {
      // Rows still due beyond an arm's page bound are backlog too.
      //
      // A HEURISTIC, deliberately, and named as one: `seen` spans every arm
      // pass, so this conflates "one pass's page was full" with "work
      // remains", and it can read `true` when the passes happened to sum to a
      // full page between them with nothing left behind. It feeds only the
      // heartbeat's `backlog` vs `ok` label — never a control decision — and
      // both of its failure directions cost an operator one 30 s tick of a
      // slightly pessimistic label. Do not build anything on it that needs the
      // exact answer; the exact answer is `rowsNudgeDue`.
      deferred = seen.size >= DELIVERY_ARM_PAGE_SIZE;
    }
    return { ok, attempted, deferred };
  }

  /**
   * D5's five steps, plus the pre-post re-read. `declined` covers a stall and
   * a row that stopped being postable since the scan — neither is an attempt.
   */
  private async attemptRow(
    row: OpsNotification,
    now: Date,
    ctx: DeliveryContext,
    waitMs: number,
  ): Promise<"declined" | "attempted" | "attempted-unrecorded"> {
    // 0. The identity guard, before the first write this method can make (a
    //    stall). The latch this runs under may have been queued behind a slow
    //    post or an intake call, so the loop-head check is not enough.
    if (!ctx.canWrite()) return "declined";

    // 1. Resolve the subscription. Unresolved ⇒ stall. This is D11 lever 1 —
    //    ops_subscriptions.enabled: false — taking effect.
    const sub = ctx.subscriptions.get(row.subscriptionId);
    if (!sub) {
      this.counters.subscriptionUnresolved += 1;
      await this.stall(row, "subscription", now);
      return "declined";
    }

    // 2. Resolve the cadence and apply the THREE-DISJUNCT attempt gate.
    const interval = resolveCadence(row, sub, ctx.policy);
    if (!(row.attemptCount === 0 || row.forceDeliver === true || interval !== undefined)) {
      this.counters.cadenceUnresolved += 1;
      await this.stall(row, "cadence", now);
      return "declined";
    }

    // 3. Resolve the adapter. Unbound ⇒ stall. This is the single, already
    //    specified home for a subscription whose adapterId names no registered
    //    adapter (D6's "unjudged binding" branch).
    const adapter = ctx.transports.get(sub.transport.adapterId);
    if (!adapter) {
      this.counters.transportUnbound += 1;
      await this.stall(row, "transport", now);
      return "declined";
    }

    if (waitMs > 0) await ctx.sleep(waitMs);

    // 4. RE-READ THE ROW, immediately before the irreversible side effect, and
    //    decline if the decision this attempt was admitted on no longer stands.
    //
    // ⚠ Not defensive. `row` is the copy the arm's scan read BEFORE its loop,
    // and the per-row latch serializes WRITES, not that read: an
    // acknowledgement on this row that landed while an EARLIER row's post held
    // the phase (a post can take ATTEMPT_SPACING_MS + SLACK_POST_TIMEOUT_MS)
    // took this row's latch uncontended and applied. Deciding from the stale
    // copy then posted a row a human had already seen, dismissed or snoozed —
    // and record()'s CAS below could only refuse the bookkeeping AFTER the post.
    // The read is inside the latch, so no intake write can land between it and
    // record(); it sits after the spacing sleep so that window is covered too.
    //
    // Postable = still in a working state, still due, and not attempted since
    // the scan (an unchanged attemptCount is what record()'s CAS conditions on,
    // so a row that passes here and then loses that CAS was moved by a writer
    // outside this process's latch). Declining is not an attempt and writes
    // nothing: a row that left the working states is not nudge-eligible, and a
    // row that is no longer due is some other writer's schedule to keep.
    const fresh = await this.notifications.findOne({ _id: row._id });
    if (
      !fresh ||
      !(OPS_NUDGE_STATES as readonly string[]).includes(fresh.state) ||
      !(fresh.nextNudgeAt instanceof Date) ||
      fresh.nextNudgeAt.getTime() > now.getTime() ||
      fresh.attemptCount !== row.attemptCount
    ) {
      return "declined";
    }

    // 4b. THE IDENTITY GUARD, immediately before the irreversible side effect —
    //     KPR-456's `if (!this.canSend()) return … "identity_unverified"`
    //     (slack-post.ts:55), carried here rather than into the adapter
    //     because D10 fixes SlackOpsTransport's constructor at two arguments.
    //
    // ⚠ Not defensive, and the failure it closes is a LOOP. `db` is
    // guardDb(rawDb, writeGuard): reads pass through an engaged guard and
    // writes are refused. Without this check the phase read a due row, posted
    // it, then had record() refused — leaving attemptCount, forceDeliver and
    // nextNudgeAt exactly as due as before, so the NEXT tick posted it again,
    // every tick, for as long as the guard stayed engaged. It is also a
    // correctness check, not only a rate one: an engaged guard means the
    // reads that chose this row may be answering out of ANOTHER instance's
    // database. Declining writes nothing and is not an attempt.
    if (!ctx.canWrite()) return "declined";

    // 5. Build the view FROM THE FRESH READ and deliver, bounded by THE
    //    ADAPTER'S OWN DEADLINE, not by the sweep's patience (D12).
    let outcome: DeliveryOutcome;
    try {
      outcome = await adapter.deliver(this.buildView(fresh, sub, ctx.reasons));
    } catch (err) {
      // An adapter that THROWS rather than returning an outcome is contained
      // and recorded as unknown/transport-fault, counted, never escaping.
      this.counters.transportFaults += 1;
      log.warn("ops transport threw — recorded as unknown", {
        adapterId: adapter.adapterId,
        error: String(err),
      });
      outcome = { status: "unknown", reason: "transport-fault" };
    }

    // 6. Record, against the fresh read — its (state, attemptCount) is the CAS
    //    precondition, and its attempts[] ring is the one the append extends.
    //
    // The guard can engage DURING the post (an adapter deadline is seconds),
    // and a guarded write would only be refused. The attempt is then spent and
    // unrecorded exactly as on the two other shapes below, and counted on the
    // same counter. What bounds it to ONE post rather than one per tick is
    // that every later tick is skipped whole while the guard stays engaged
    // (OpsNotifier.run); on disengagement the row is still due and is posted
    // once more — a bounded duplicate, the direction D4 errs in.
    if (!ctx.canWrite()) {
      this.counters.deliveryRecordLost += 1;
      log.warn(
        "ops delivery record withheld — DB identity unverified after an external side effect; the attempt is unrecorded",
        {
          adapterId: adapter.adapterId,
          outcome: outcome.status,
        },
      );
      return "attempted-unrecorded";
    }
    try {
      // `false` is a lost CAS — record() has already counted and logged it.
      // Returned as `attempted-unrecorded` like the thrown shape, so both
      // mark the phase not-ok and the heartbeat reads `degraded` for either
      // (notification-types.ts, deliveryRecordLost).
      if (!(await this.record(fresh, outcome, interval, adapter.adapterId, now))) return "attempted-unrecorded";
    } catch (err) {
      // ⚠ COUNTED ON deliveryRecordLost, NOT sweepFaults. The side effect is
      // spent: the message is posted and, for Slack, its ts registered as an
      // echo. A record() that THROWS (a storage fault, not a lost CAS) leaves
      // the row exactly as unrecorded as a lost CAS does — attemptCount and
      // forceDeliver untouched, so the row is re-attempted on the next tick,
      // a duplicate post — and the generic per-row fault counter would bury
      // that one specific consequence among faults that spent nothing. It is
      // still a phase fault, so the caller marks the phase not-ok and the
      // heartbeat reads `degraded`; and it is still an attempt, so the spacing
      // to the next row applies.
      this.counters.deliveryRecordLost += 1;
      log.warn("ops delivery record write failed after an external side effect — the attempt is unrecorded", {
        adapterId: adapter.adapterId,
        outcome: outcome.status,
        error: String(err),
      });
      return "attempted-unrecorded";
    }
    return "attempted";
  }

  /**
   * D5. A row the tick declines is PUSHED FORWARD, never left untouched.
   *
   * The `state ∈ {pending, delivered}` precondition is load-bearing rather
   * than defensive: without it, a row that left the working states between the
   * scan and this write would have a nextNudgeAt written back onto it,
   * breaking the "no non-working row carries a nextNudgeAt" property that is
   * exactly what lets arm 2's index carry no `state` key.
   */
  private async stall(row: OpsNotification, reason: StalledReason, now: Date): Promise<void> {
    await this.notifications.updateOne(
      { _id: row._id, state: { $in: [...OPS_NUDGE_STATES] } },
      { $set: { stalledAt: now, stalledReason: reason, nextNudgeAt: stallRecheckAt(now) } },
      WRITE,
    );
  }

  /**
   * D5 step 5. `nextNudgeAt = now + interval` is written on ALL THREE outcomes
   * alike — the outcome never changes the schedule, only the state.
   *
   * ⚠ THE $set/$unset RULE. On the NO-INTERVAL branch this update SETS
   * stalledAt/stalledReason and does NOT also carry the head-of-step unset for
   * them. MongoDB rejects any update naming one path in both ("Updating the
   * path 'stalledAt' would create a conflict at 'stalledAt'"), so a build that
   * emits both THROWS inside the delivery phase — on the shipped-default path,
   * which is the most common configuration there is. Chunk 2 Task 3 Step 2
   * taught the test double to reject it too, which is what makes this rule
   * checked rather than merely written down.
   *
   * ⚠ AND THE ONE CAS IN THIS COMPONENT WHOSE MISS MUST BE COUNTED. This is
   * the only write that happens AFTER an irreversible external side effect —
   * the message is posted and its ts is already registered as an echo. If the
   * CAS misses, attempts[], attemptCount, lastOutcome and deliveryReference
   * are all lost and the row is re-attempted on the next tick: a DUPLICATE
   * POST WITH NO TRACE. Every other CAS in this ticket inspects matchedCount
   * (applyClearing → rowsCleared, both renewal arms, intake → LOST), because
   * D8's standard is that a lost race is DETECTED rather than blended — and
   * blending it here is the one place with a side effect already spent.
   *
   * What keeps it from firing is TWO mechanisms together, and neither alone:
   * the per-row latch serializes intake's write against this one, and
   * attemptRow's pre-post re-read (step 4) makes the decision to post from a
   * copy read INSIDE that latch. The latch alone was not enough — the arm's
   * scan reads its rows before the loop, so an acknowledgement landing while
   * an earlier row's post held the phase applied uncontended, and the stale
   * copy was then posted and lost this CAS (a posted notification the human
   * had already acknowledged). With both in place no in-process writer can
   * move the row between the re-read and this write; a miss now means a
   * writer outside this process's latch (a second engine, a hand edit). It is
   * counted anyway, because the latch and the re-read are exactly the things
   * a future edit changes.
   */
  private async record(
    row: OpsNotification,
    outcome: DeliveryOutcome,
    interval: number | undefined,
    adapterId: string,
    now: Date,
  ): Promise<boolean> {
    const entry: NotificationAttempt = {
      at: now,
      outcome: outcome.status,
      adapterId,
      ...(outcome.status === "accepted" ? {} : { reason: outcome.reason }),
    };
    // The ring is written with $set from the row in hand rather than with
    // $push/$slice: the update is already CAS'd on (state, attemptCount), so a
    // concurrent write is DETECTED rather than blended, and it keeps this
    // update inside the operator set the repo's double supports.
    const attempts = [...row.attempts, entry].slice(-ATTEMPTS_RING_CAP);

    const set: Record<string, unknown> = { attempts, lastOutcome: outcome.status, lastNudgeAt: now };
    // The attempt is what CONSUMES the forced re-delivery, on every outcome
    // alike, since a rejected or unknown attempt was still made.
    // ⚠ `Record<string, "">`, not `Record<string, string>`: the driver's
    // `$unset` operand type is `true | "" | 1`, and a wider value type is not
    // assignable to it (tsc 6.0.3 / mongodb 7.6.0). The literal type is the
    // only adaptation this file makes to the driver's shape.
    const unset: Record<string, ""> = { forceDeliver: "" };

    if (interval !== undefined) {
      set.nextNudgeAt = new Date(now.getTime() + interval);
      unset.stalledAt = "";
      unset.stalledReason = "";
    } else {
      // The row has taken the delivery it was owed and is now an ordinary
      // cadence-unresolved row, on the same footing as one step 2 declined.
      set.nextNudgeAt = stallRecheckAt(now);
      set.stalledAt = now;
      set.stalledReason = "cadence";
    }

    if (outcome.status === "accepted") {
      set.deliveryReference = outcome.reference;
      // Only `pending → delivered` is a TRANSITION. An accepted nudge on an
      // already-delivered row must not advance stateAt/principalAt.
      if (row.state === "pending") {
        set.state = "delivered";
        set.stateAt = now;
        set.principal = OPS_SYSTEM_PRINCIPAL;
        set.principalAt = now;
        // D9's state invariant, written as the ONE pattern every
        // state-changing write in this ticket uses. ⚠ The `if` half is
        // UNREACHABLE HERE: `delivered` is a working state, so expiresAtFor
        // returns undefined by construction and only the unset ever runs. The
        // pattern is kept whole anyway — it is a total map over D7's six
        // states, and an enumeration of the reachable arms is exactly the form
        // that missed `seen → snoozed`. Do not delete the `if` half as dead
        // code; delete it and the next state added here writes no expiresAt.
        const expires = expiresAtFor("delivered", now, this.retentionDays);
        if (expires) set.expiresAt = expires;
        else unset.expiresAt = "";
      }
      this.counters.deliveriesAccepted += 1;
    } else if (outcome.status === "rejected") {
      // NO RETRY LADDER SHIPS. D6's { status: "rejected"; reason } carries no
      // retry hint, so this component has nothing to schedule a retry FROM,
      // and inventing a backoff would be cadence policy by another name. C8
      // PERMITS an automatic retry; it does not require one, and the row's
      // next ordinary nudge IS the retry.
      this.counters.deliveriesRejected += 1;
    } else {
      // `unknown` never reaches `delivered` and is surfaced as UNCERTAINTY,
      // never as notified (C8). Nothing is re-sent on the strength of it.
      this.counters.deliveriesUnknown += 1;
    }

    const res = await this.notifications.updateOne(
      { _id: row._id, state: row.state, attemptCount: row.attemptCount },
      {
        $set: set,
        $inc: {
          attemptCount: 1,
          // The first delivery is an attempt but NOT a nudge, even though it
          // travels the nudge path.
          ...(row.attemptCount > 0 ? { nudgeCount: 1 } : {}),
        },
        $unset: unset,
      },
      WRITE,
    );
    if (res.matchedCount === 0) {
      // See the ⚠ above. Nothing is re-attempted here and nothing is repaired:
      // the attempt HAPPENED, the record did not land, and inventing a second
      // write against a row another writer just moved is how a half-applied
      // state gets created. The honest surface is the counter plus this line,
      // and the counter is what a reviewer of a future latch change reads.
      this.counters.deliveryRecordLost += 1;
      log.warn("ops delivery record lost a CAS after an external side effect — the attempt is unrecorded", {
        adapterId,
        outcome: outcome.status,
      });
      return false;
    }
    return true;
  }

  /** D6. Structured, carrying the RESOLVED target; never a rendered string. */
  private buildView(row: OpsNotification, sub: OpsSubscription, reasons: Map<string, LoadedReason>): NotificationView {
    const reason = reasons.get(`${row.producer}:${row.reasonId}`);
    if (!reason) this.counters.reasonUnknown += 1;
    return {
      handle: String(row._id),
      target: sub.transport.target,
      event: {
        producer: row.producer,
        reasonId: row.reasonId,
        class: row.class,
        retry: row.retry,
        waiting: row.waiting,
        subject: row.subject,
        generation: row.generation,
        dedupeKey: row.dedupeKey,
        publishedAt: row.lastEventAt,
        detail: row.latestDetail,
        evidence: row.latestEvidence,
      },
      // An unknown reason OMITS remediation and never blocks delivery.
      ...(reason ? { remediation: { template: reason.row.remediationTemplate, parameters: row.latestDetail } } : {}),
      ledger: {
        state: row.state,
        eventCount: row.eventCount,
        nudgeCount: row.nudgeCount,
        attemptCount: row.attemptCount,
        firstSeenAt: row.firstSeenAt,
        lastEventAt: row.lastEventAt,
      },
    };
  }
}
