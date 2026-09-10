# KPR-468 plan — chunk 3: delivery, nudging, the stall, snooze expiry, and the notifier

Implements design **D5** (cadence, the three scan arms, the attempt gate, the stall, snooze expiry, the heartbeat and its gauges), **D6**'s subscription-load and `validateTarget` rules, **D8** (single-flight, the delivery/expiry containment rule, the counters) and **D10**'s `init()`/`start()`/`stop()` postures. One task, one commit — **Steps 3–8 are in [chunk 3b](kpr-468-plan-3b-notifier.md)**, split at the Step 2 | Step 3 seam because the combined file ran past this plan's 1,000-line bound. It is a step seam rather than a task seam (both earlier splits were task seams) because `DeliveryPhase` and `OpsNotifier` are one commit and a tree with only the first would not compile; the exception is recorded in the plan index.

**No constant is added here — two are CONFIRMED.** `DELIVERY_ARM_PAGE_SIZE` and `SLACK_POST_TIMEOUT_MS` both live in chunk 1 Task 1 Step 1's constant block with every other bound this ticket fixes. (Round 2 moved `DELIVERY_ARM_PAGE_SIZE` there: a "complete new-file payload" that a later chunk appends to is the one place this plan's completeness rule would have bent, and it bought nothing.) Step 1 is a grep, not an edit.

**Three things in D5 are decided against a named alternative and must not be re-derived at the keyboard.**

1. **`nextNudgeAt` is NEVER unset while a row is `pending` or `delivered`, and is never left at its due value either.** Unsetting hides the row from the `$lte` due-scan forever under MongoDB's type bracketing — which the repo's own double reproduces (`src/obligations/testing/fake-db.ts:40-41`, `case "$lte": return actual !== undefined && actual <= value`) — stranding it permanently. Leaving it at its due value parks a monotonically growing, never-TTL'd set at the head of the scan and silently starves the one guaranteed delivery. The rule is neither: **stalled forward on a bounded, jittered re-check.**
2. **The attempt gate is THREE disjuncts:** `attemptCount === 0 ∨ forceDeliver === true ∨ a cadence resolved`. The middle one is not decoration. `attemptCount` is monotonic and neither the `cleared → pending` reopen nor a snooze expiry resets it, so a two-disjunct gate turns a condition that demonstrably came back — and every expired snooze — into permanent silence under the shipped default.
3. **The scan is three ORDERED arms whose first two are index-immune to the stall set**, not one scan with a tidy ordering. The immunity is the leading-key equality bound (`attemptCount: 0`, `forceDeliver: true`), which a query planner cannot lose.

**And the containment rule here is the OPPOSITE of ingest's.** Delivery and snooze expiry are **per-row `try`/`catch`, counted, continue to the next row** — these phases have no cursor and no ordering obligation, so a skipped row costs that row one tick and nothing else. Do not carry ingest's stop-at-the-event rule into this file, and do not carry this file's rule back into ingest.

---

### Task 5: `DeliveryPhase` and `OpsNotifier`

**Files:**

- Create: `src/ops/delivery.ts`
- Create: `src/ops/notifier.ts`
- Create: `src/ops/testing/notifier-harness.ts` (the shared harness — see "Harness contract" in Step 4)
- Create: `src/ops/delivery.integration.test.ts`

- [ ] **Step 1:** Confirm both constants from chunk 1 Task 1 Step 1 are present. No edit.

```bash
grep -n "SLACK_POST_TIMEOUT_MS\|DELIVERY_ARM_PAGE_SIZE" src/ops/notification-types.ts
```

Expected: one declaration each. A miss means chunk 1's payload was truncated — fix it there, not here.

- [ ] **Step 2:** Create `src/ops/delivery.ts`.

```typescript
/**
 * KPR-468 D5: cadence resolution, the three-armed delivery scan, the attempt
 * gate, the stall, and snooze expiry.
 */
import type { Collection } from "mongodb";
import { createLogger } from "../logging/logger.js";
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
          profile: sub.cadenceProfile,
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
      try {
        await ctx.lock(String(row._id), async () => {
          // D7's table verbatim: `delivered` if the row has a recorded
          // `accepted` outcome, else `pending`.
          //
          // ⚠ The marker is `deliveryReference`, NOT the attempts[] ring. The
          // ring is capped at ATTEMPTS_RING_CAP, so a row nudged past the cap
          // since its accepted delivery no longer RECORDS that outcome in the
          // ring and a ring-derived test would wrongly demote it.
          // deliveryReference is written only on an accepted outcome and is
          // never unset, so it is the durable form of the same question.
          const next = row.deliveryReference !== undefined ? "delivered" : "pending";
          await this.notifications.updateOne(
            { _id: row._id, state: "snoozed" },
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
   * D5's three ordered arms, served under ONE shared wall-clock budget.
   *
   * The stall alone bounds the STEADY-STATE cost; it does not by itself
   * guarantee that a re-check tick's arriving cohort cannot crowd out a new
   * row on that tick. That guarantee is the arm split: arms 1 and 2 carry an
   * equality bound on their index's leading key, so the cadence-stall backlog
   * is not in their buckets AT ALL — structural immunity, not an ordering
   * convention a query planner could lose.
   */
  async run(now: Date, ctx: DeliveryContext): Promise<DeliveryResult> {
    const budgetEnd = now.getTime() + DELIVERY_BUDGET_MS;
    const working = { $in: [...OPS_NUDGE_STATES] };
    const arms = [
      // Arm 1 — the guaranteed first delivery.
      { state: working, attemptCount: 0, nextNudgeAt: { $lte: now } },
      // Arm 2 — the two non-cadence re-delivery triggers. No `state` key: no
      // non-working row carries a nextNudgeAt at all (D5's scoping of the
      // never-unset rule), so this range holds only pending/delivered rows by
      // type bracketing rather than by a residual filter.
      { forceDeliver: true, nextNudgeAt: { $lte: now } },
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
        // The budget is wall-clock and is counted over EVERY row the phase
        // touches, attempted or declined — which is precisely why the stall
        // and the arm split exist rather than a bare cap on the scan.
        if (ctx.clock().getTime() >= budgetEnd) return { ok, attempted, deferred: true };
        const id = String(row._id);
        // A row matching more than one arm is attempted once per tick.
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          const madeAttempt = await ctx.lock(id, async () => {
            const wait = nextAttemptAt - ctx.clock().getTime();
            const made = await this.attemptRow(row, now, ctx, wait);
            return made;
          });
          if (madeAttempt) {
            attempted += 1;
            nextAttemptAt = ctx.clock().getTime() + ATTEMPT_SPACING_MS;
          }
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
      // A HEURISTIC, deliberately, and named as one: `seen` spans all three
      // arms, so this conflates "one arm's page was full" with "work remains",
      // and it can read `true` when the three arms happened to sum to a full
      // page between them with nothing left behind. It feeds only the
      // heartbeat's `backlog` vs `ok` label — never a control decision — and
      // both of its failure directions cost an operator one 30 s tick of a
      // slightly pessimistic label. Do not build anything on it that needs the
      // exact answer; the exact answer is `rowsNudgeDue`.
      deferred = seen.size >= DELIVERY_ARM_PAGE_SIZE;
    }
    return { ok, attempted, deferred };
  }

  /** D5's five steps. Returns whether an ATTEMPT was made (a stall is not one). */
  private async attemptRow(
    row: OpsNotification,
    now: Date,
    ctx: DeliveryContext,
    waitMs: number,
  ): Promise<boolean> {
    // 1. Resolve the subscription. Unresolved ⇒ stall. This is D11 lever 1 —
    //    ops_subscriptions.enabled: false — taking effect.
    const sub = ctx.subscriptions.get(row.subscriptionId);
    if (!sub) {
      this.counters.subscriptionUnresolved += 1;
      await this.stall(row, "subscription", now);
      return false;
    }

    // 2. Resolve the cadence and apply the THREE-DISJUNCT attempt gate.
    const interval = resolveCadence(row, sub, ctx.policy);
    if (!(row.attemptCount === 0 || row.forceDeliver === true || interval !== undefined)) {
      this.counters.cadenceUnresolved += 1;
      await this.stall(row, "cadence", now);
      return false;
    }

    // 3. Resolve the adapter. Unbound ⇒ stall. This is the single, already
    //    specified home for a subscription whose adapterId names no registered
    //    adapter (D6's "unjudged binding" branch).
    const adapter = ctx.transports.get(sub.transport.adapterId);
    if (!adapter) {
      this.counters.transportUnbound += 1;
      await this.stall(row, "transport", now);
      return false;
    }

    if (waitMs > 0) await ctx.sleep(waitMs);

    // 4. Build the view and deliver, bounded by THE ADAPTER'S OWN DEADLINE,
    //    not by the sweep's patience (D12).
    let outcome: DeliveryOutcome;
    try {
      outcome = await adapter.deliver(this.buildView(row, sub, ctx.reasons));
    } catch (err) {
      // An adapter that THROWS rather than returning an outcome is contained
      // and recorded as unknown/transport-fault, counted, never escaping.
      this.counters.transportFaults += 1;
      log.warn("ops transport threw — recorded as unknown", { adapterId: adapter.adapterId, error: String(err) });
      outcome = { status: "unknown", reason: "transport-fault" };
    }

    // 5. Record.
    await this.record(row, outcome, interval, adapter.adapterId, now);
    return true;
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
   * blending it here is the one place with a side effect already spent. The
   * in-process per-row latch makes it unreachable today; it is counted anyway
   * precisely because the latch is the thing a future edit changes.
   */
  private async record(
    row: OpsNotification,
    outcome: DeliveryOutcome,
    interval: number | undefined,
    adapterId: string,
    now: Date,
  ): Promise<void> {
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
    const unset: Record<string, string> = { forceDeliver: "" };

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
    }
  }

  /** D6. Structured, carrying the RESOLVED target; never a rendered string. */
  private buildView(
    row: OpsNotification,
    sub: OpsSubscription,
    reasons: Map<string, LoadedReason>,
  ): NotificationView {
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
```

⚠ **The one named residual in this file, carried from D5 verbatim: the snooze-expiry arm does NOT unset `stalledAt`/`stalledReason`.** It is the only arm that returns a row to a working state without clearing the marker — the `cleared → pending` reopen unsets both explicitly ([chunk 2b](kpr-468-plan-2b-ingest.md)), and every other transition out of a working state takes the row out of the gauges' `state ∈ {pending, delivered}` clause immediately. So a row that was stalled, then snoozed, then expired over-counts in the three gauges for **at most one tick**, because it arrives with `nextNudgeAt = now` and is attempted on the very next delivery phase. **Do not reconcile this paragraph with either of the two unsets that do exist by deleting one of them.**

**Continue in [chunk 3b](kpr-468-plan-3b-notifier.md)** — Step 3 (`notifier.ts`), Step 4 (the shared harness and its contract), Step 5 (the delivery suite), Steps 6–8 (verify, negative-verify NV6, commit).
