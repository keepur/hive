# KPR-468 plan — chunk 3: delivery, nudging, the stall, snooze expiry, and the notifier

Implements design **D5** (cadence, the three scan arms, the attempt gate, the stall, snooze expiry, the heartbeat and its gauges), **D6**'s subscription-load and `validateTarget` rules, **D8** (single-flight, the delivery/expiry containment rule, the counters) and **D10**'s `init()`/`start()`/`stop()` postures. One task, one commit.

**Two constants must be added to `src/ops/notification-types.ts`** alongside the ones Task 1 wrote (`SLACK_POST_TIMEOUT_MS` was the first such addition, in chunk 1 Task 1 Step 1). Add both in this task's Step 1 rather than hunting for them later:

```typescript
/** Bounds the READ per delivery arm. Far larger than a tick can attempt
 *  (DELIVERY_BUDGET_MS / ATTEMPT_SPACING_MS ≈ 10), so it never decides what is
 *  delivered — it only keeps an arm's scan from materializing a huge ledger. */
export const DELIVERY_ARM_PAGE_SIZE = 200;
```

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
- Modify: `src/ops/notification-types.ts` (add `DELIVERY_ARM_PAGE_SIZE`)
- Create: `src/ops/delivery.integration.test.ts`

- [ ] **Step 1:** Add `DELIVERY_ARM_PAGE_SIZE` to `src/ops/notification-types.ts` (payload above), and confirm `SLACK_POST_TIMEOUT_MS` from chunk 1 Task 1 Step 1 is present:

```bash
grep -n "SLACK_POST_TIMEOUT_MS\|DELIVERY_ARM_PAGE_SIZE" src/ops/notification-types.ts
```

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

    await this.notifications.updateOne(
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

⚠ **The one named residual in this file, carried from D5 verbatim: the snooze-expiry arm does NOT unset `stalledAt`/`stalledReason`.** It is the only arm that returns a row to a working state without clearing the marker — the `cleared → pending` reopen unsets both explicitly (chunk 2), and every other transition out of a working state takes the row out of the gauges' `state ∈ {pending, delivered}` clause immediately. So a row that was stalled, then snoozed, then expired over-counts in the three gauges for **at most one tick**, because it arrives with `nextNudgeAt = now` and is attempted on the very next delivery phase. **Do not reconcile this paragraph with either of the two unsets that do exist by deleting one of them.**

- [ ] **Step 3:** Create `src/ops/notifier.ts`.

```typescript
/**
 * KPR-468 D8/D10: the notifier runtime — lifecycle, the bounded
 * non-overlapping sweep, the subscription map, the retained policy copy, the
 * per-row latch, the counters and the heartbeat.
 *
 * Shaped on src/obligations/runtime.ts (init/start/stop, a transport bound at
 * start, a single-flight sweeper). NOTHING here is imported from
 * src/obligations/ — see chunk 1.
 */
import type { Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { OpsStore, type LoadedReason } from "./store.js";
import type { OpsSubscription } from "./types.js";
import type { OpsTransport } from "./transport.js";
import {
  GAUGE_COUNT_LIMIT,
  OPS_NUDGE_STATES,
  SUBSCRIPTION_RELOAD_MS,
  SWEEP_INTERVAL_MS,
  freshCounters,
  ledgerRetentionDays,
  type OpsAcknowledgement,
  type OpsIntakeResult,
  type OpsNotifierCounters,
  type OpsPolicy,
} from "./notification-types.js";
import { OpsNotificationStore } from "./notification-store.js";
import { IngestPhase } from "./ingest.js";
import { DeliveryPhase } from "./delivery.js";

const log = createLogger("ops-notifier");

const unloadWarned = new Set<string>();

export class OpsNotifier {
  private readonly opsStore: OpsStore;
  private readonly store: OpsNotificationStore;
  private readonly ingestPhase: IngestPhase;
  private readonly deliveryPhase: DeliveryPhase;
  private readonly counters: OpsNotifierCounters = freshCounters();
  private readonly transports = new Map<string, OpsTransport>();
  private readonly locks = new Map<string, Promise<void>>();

  private subscriptions = new Map<string, OpsSubscription>();
  private reasons = new Map<string, LoadedReason>();
  /**
   * D5's three-valued policy state, and the third value is load-bearing.
   * `undefined` means NO findOne HAS RETURNED YET in this process — the cold
   * path, reachable only on a first tick whose read threw. `null` means a read
   * SUCCEEDED and nothing is registered, which is a RETAINED RESULT and is
   * every tick of the shipped default.
   */
  private policy: OpsPolicy | null | undefined = undefined;

  private initialized = false;
  private startable = true;
  private started = false;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private reloadTimer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private lastSuccessfulSweep?: Date;
  private lastCursorAt?: Date;

  constructor(
    db: Db,
    activityRetentionDays: number,
    private readonly clock: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  ) {
    // Integration point 1: the notifier constructs its OWN OpsStore and never
    // calls ensureIndexes() or upsertReasons() on it. KPR-454 owns ops_events,
    // ops_subscriptions and ops_reasons and their indexes.
    this.opsStore = new OpsStore(db, activityRetentionDays);
    this.store = new OpsNotificationStore(db);
    const retention = ledgerRetentionDays(activityRetentionDays);
    this.ingestPhase = new IngestPhase(
      this.opsStore.events,
      this.store,
      this.counters,
      () => this.subscriptions,
      retention,
    );
    this.deliveryPhase = new DeliveryPhase(this.store.notifications, this.counters, retention);
  }

  /**
   * D10. Non-fatal to boot, with a SPLIT posture, and the split is drawn one
   * line differently from KPR-454's because this child's unique index carries
   * a correctness role:
   *
   *  - The (subscriptionId, dedupeKey) UNIQUE index failing THROWS. index.ts
   *    then never runs setOpsNotifier, so the singleton stays unset, every
   *    intake call returns { state: "unavailable" }, and the sweep never
   *    starts. Running the ledger without its identity guarantee is worse than
   *    not running it — an intake CAS could resolve a handle against one of
   *    two rows for the same condition.
   *  - Every other index fault is contained and counted and keeps the notifier
   *    usable.
   *  - A REASON-MAP fault does NOT throw. It leaves the notifier UNSTARTABLE
   *    but INITIALIZED, so index.ts still runs setOpsNotifier and intake is
   *    LIVE: reasons are consumed only to attach `remediation` at delivery,
   *    intake consumes none of them, and an acknowledgement arriving against
   *    an existing ledger row is a legitimate write whether or not this
   *    process could read ops_reasons.
   *
   * init() deliberately does NOT load subscriptions and does not arm the
   * reload timer — both move to start(), because adapters are registered BELOW
   * the spawn-capable boundary and a load running here would have no adapter
   * to validate any target against (D6, D10).
   */
  async init(): Promise<void> {
    const { uniqueOk, failures } = await this.store.ensureIndexes();
    this.counters.indexFailures = failures;
    if (!uniqueOk) throw new Error("ops_notifications identity index unavailable");
    this.initialized = true;
    try {
      // ⚠ A heavier borrow than "read-only reuse" implies: loadReasons()
      // re-runs KPR-454's per-row auditReasonRow warnings and re-compiles a
      // zod schema per row, neither of which the notifier needs. ACCEPTED,
      // MEASURED: init() runs exactly once per boot and reasons never reload,
      // so the cost is one extra warn set and one extra compile pass per
      // PROCESS — not per turn, not per tick — and the duplicated lines are
      // identical text from a second module. The additive alternative
      // (integration point 1) is a cross-child edit and is not worth spending.
      this.reasons = (await this.opsStore.loadReasons()).map;
    } catch (err) {
      this.startable = false;
      log.error("ops reason map load failed — the sweep will not start; intake stays live", {
        error: String(err),
      });
    }
  }

  /** D6/D10. Called BELOW the boundary, before start(). */
  registerTransport(transport: OpsTransport): void {
    this.transports.set(transport.adapterId, transport);
  }

  /**
   * D10. Does the first subscription load — which is what puts every
   * validateTarget AFTER every registerTransport — arms the 60 s reload timer,
   * and begins the sweep. Contained: a first-load fault leaves the notifier
   * unstarted with intake live, never throwing into boot.
   */
  async start(): Promise<void> {
    if (this.started || this.stopping || !this.initialized || !this.startable) return;
    try {
      await this.reloadSubscriptions(true);
    } catch (err) {
      log.error("ops notifier first subscription load failed — sweep off, intake live", { error: String(err) });
      return;
    }
    this.started = true;
    this.reloadTimer = setInterval(() => void this.reloadSubscriptions(), SUBSCRIPTION_RELOAD_MS);
    this.reloadTimer.unref?.();
    await this.sweepOnce();
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => void this.sweepOnce(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.timer = undefined;
    this.reloadTimer = undefined;
    await this.flight;
  }

  /**
   * D6/D9. Refreshed on a 60 s timer and on the existing SIGUSR1 handler. A
   * fault leaves the previous set IN PLACE and counts — it NEVER empties it.
   *
   * ⚠ This reload is deliberately DUPLICATED with KPR-454's, not a missed DRY
   * opportunity: the publisher needs compiled FILTERS and loads in its own
   * init(); the notifier needs TRANSPORT BINDINGS validated against registered
   * adapters and therefore cannot load before start(). A shared loader would
   * have to be either the union — dragging filter compilation above the
   * boundary into a component that must never evaluate a match (AC2) — or a
   * cache with two shapes and two readiness points.
   */
  async reloadSubscriptions(rethrow = false): Promise<void> {
    try {
      const rows = await this.opsStore.loadSubscriptions();
      const next = new Map<string, OpsSubscription>();
      for (const sub of rows) {
        const adapter = this.transports.get(sub.transport.adapterId);
        if (adapter) {
          let valid = false;
          try {
            valid = adapter.validateTarget(sub.transport.target);
          } catch {
            // An adapter that cannot decide is not a reason to load a target
            // nobody judged — and it must never abort the load of the rest.
            valid = false;
          }
          if (!valid) {
            this.counters.subscriptionUnloaded += 1;
            // Never mutated in the database: operator data is not the
            // engine's to rewrite. Warn-once PER PROCESS on subscriptionId —
            // the map reloads every 60 s, so per-load would be one line per
            // rejected subscription per minute.
            if (!unloadWarned.has(sub._id)) {
              unloadWarned.add(sub._id);
              log.warn("ops subscription target rejected by its adapter — unloaded in memory", {
                subscriptionId: sub._id,
                adapterId: sub.transport.adapterId,
              });
            }
            continue;
          }
        }
        // No registered adapter ⇒ LOADS NORMALLY, UNVALIDATED. It is not an
        // invalid target; it is a target nobody can judge yet (D6). Its rows
        // are created and left to delivery-time transportUnbound.
        next.set(sub._id, sub);
      }
      this.subscriptions = next;
    } catch (err) {
      this.counters.subscriptionReloadFaults += 1;
      log.warn("ops subscription reload failed — retaining the previous set", { error: String(err) });
      if (rethrow) throw err;
    }
  }

  /** D8: one in-flight promise, so ticks never overlap (KPR-456's sweeper.ts:106-117). */
  sweepOnce(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.stopping) return Promise.resolve();
    this.flight = this.run()
      .catch((err) => {
        this.counters.sweepFaults += 1;
        log.warn("ops sweep unavailable", { error: String(err) });
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }

  /** Test barrier: one full tick, resolved after the heartbeat write. */
  __tickForTests(): Promise<void> {
    return this.sweepOnce();
  }

  private async run(): Promise<void> {
    const now = this.clock();

    // D5's policy read: ONE small findOne per tick, so it is always fresh and
    // needs no reload timer. `null` and `throw` are DISTINGUISHABLE and only
    // the first resolves as "no policy".
    let policyOk = true;
    try {
      this.policy = await this.store.readPolicy();
    } catch (err) {
      policyOk = false;
      this.counters.policyReadFaults += 1;
      log.warn("ops policy read failed — using the retained copy", { error: String(err) });
    }

    // Phase order is fixed: ingest (so a fresh row is deliverable on this
    // tick), then snooze expiry (D5: BEFORE delivery), then delivery.
    const ingest = await this.ingestPhase.run(now);
    this.lastCursorAt = ingest.cursorAt;

    const ctx = {
      subscriptions: this.subscriptions,
      transports: this.transports,
      reasons: this.reasons,
      policy: this.policy ?? null,
      lock: <T>(rowId: string, fn: () => Promise<T>) => this.withRowLock(rowId, fn),
      stopped: () => this.stopping,
      clock: this.clock,
      sleep: this.sleep,
    };

    const expiryOk = await this.deliveryPhase.expire(now, ctx);

    // D5: a tick whose read THREW and which has NO retained result — the first
    // tick of a process — skips the delivery phase ENTIRELY. No row is marked,
    // nothing is pushed forward. A tick whose read SUCCEEDED and returned null
    // has a retained result and runs NORMALLY, which is every tick of the
    // shipped default and the state AC11 drives.
    let delivery = { ok: true, attempted: 0, deferred: false };
    if (!policyOk && this.policy === undefined) {
      delivery = { ok: false, attempted: 0, deferred: false };
    } else {
      delivery = await this.deliveryPhase.run(now, ctx);
    }

    const allOk = ingest.ok && expiryOk && delivery.ok;
    if (allOk) this.lastSuccessfulSweep = now;
    const backlog = ingest.eventsBehind > 0 || delivery.deferred;

    const nf = this.store.notifications;
    const working = { $in: [...OPS_NUDGE_STATES] };
    const stallGauge = (reason: string) =>
      nf.countDocuments({ stalledReason: reason, state: working }, { limit: GAUGE_COUNT_LIMIT });

    await this.store.writeHeartbeat({
      timestamp: now,
      lastSuccessfulSweep: this.lastSuccessfulSweep,
      cursorAt: ingest.cursorAt,
      eventsBehind: ingest.eventsBehind,
      oldestUnappliedAt: ingest.oldestUnappliedAt,
      rowsPending: await nf.countDocuments({ state: "pending" }),
      rowsNudgeDue: await nf.countDocuments({ state: working, nextNudgeAt: { $lte: now } }),
      rowsSnoozed: await nf.countDocuments({ state: "snoozed" }),
      // The four saturating gauges — DEPTHS, not rates, and never to be read
      // as incident counts. Each is an equality on its index's leading key and
      // carries `state` IN the index rather than as a residual filter over it,
      // because a saturating limit over a residual filter does not saturate.
      rowsUnknownOutcome: await nf.countDocuments({ lastOutcome: "unknown", state: working }, { limit: GAUGE_COUNT_LIMIT }),
      rowsSubscriptionUnresolved: await stallGauge("subscription"),
      rowsTransportUnbound: await stallGauge("transport"),
      rowsCadenceUnresolved: await stallGauge("cadence"),
      ...this.counters,
      state: allOk ? (backlog ? "backlog" : "ok") : "degraded",
    });
  }

  /**
   * D8's per-row latch: a Map<rowId, Promise> chain with entries deleted on
   * settle, so the map is bounded by IN-FLIGHT work.
   *
   * ⚠ SCOPE, and it is forced rather than chosen. The latch keys on the row's
   * `_id`, because that is the only handle intake has. INGEST'S RENEWAL ARMS
   * ADDRESS ROWS BY (subscriptionId, dedupeKey) BEFORE ANY _id IS KNOWN, so
   * they cannot take an _id-keyed latch at all — and they do not need one:
   * every ingest write is a per-row CAS on the precondition it depends on (the
   * apply-if-newer watermark, plus a state clause), so a lost race there is
   * DETECTED rather than blended, which is D8's own standard. The latch
   * therefore covers delivery, snooze expiry and intake.
   */
  withRowLock<T>(rowId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(rowId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.locks.set(rowId, tail);
    void tail.then(() => {
      if (this.locks.get(rowId) === tail) this.locks.delete(rowId);
    });
    return run;
  }

  getSnapshot(): Record<string, unknown> {
    return {
      initialized: this.initialized,
      startable: this.startable,
      started: this.started,
      stopping: this.stopping,
      subscriptions: this.subscriptions.size,
      adapters: [...this.transports.keys()],
      lastSuccessfulSweep: this.lastSuccessfulSweep,
      cursorAt: this.lastCursorAt,
      ...this.counters,
    };
  }

  /** Chunk 4 replaces this stub with the real intake. */
  accept(_input: OpsAcknowledgement): Promise<OpsIntakeResult> {
    return Promise.resolve({ state: "unavailable" });
  }
}
```

⚠ **The `accept` stub is deliberate and is replaced whole in chunk 4 Task 6 Step 2.** It exists so Task 5 type-checks and so `notifier.ts` is complete at this commit; leaving it out would make chunk 4 a two-file edit for no gain. The stub's `{ state: "unavailable" }` is also the correct answer for every state it currently represents, so an accidental ship of this commit alone is inert rather than wrong.

- [ ] **Step 4:** Create `src/ops/delivery.integration.test.ts`.

Cover, at minimum, each of the following as a named case, driving a real `OpsNotifier` over the extended double with a fixed clock, a `FakeTransport`, and `__tickForTests()` as the barrier.

- **Cadence resolution** (unit-shaped, via the exported `resolveCadence`): the `(class, retry)` key is read exactly as D8 keys it; a `cadenceProfile` substitutes the table **wholesale** and an **unknown** profile resolves `undefined` **without** consulting the table; a below-floor profile clamps up and warns exactly once per `(name, value)`; a below-floor *table* entry clamps up **without** a warning; a `null` policy and a zero/negative/non-finite interval all resolve `undefined`; a profile named `constructor` does not read the prototype chain.
- **The three outcomes:** `accepted` transitions `pending → delivered`, sets `deliveryReference`, and sets `nextNudgeAt` from the resolved cadence; `rejected` and `unknown` leave `state` unchanged; `unknown` never reaches `delivered`; an adapter that **throws** is recorded as `unknown`/`transport-fault` and `transportFaults` increments.
- **An accepted nudge on an already-`delivered` row does not advance `stateAt`/`principalAt`** but does refresh `deliveryReference`.
- **`nudgeCount` excludes the first attempt** while `attemptCount` counts it; `attempts[]` never exceeds `ATTEMPTS_RING_CAP` across ten attempts while `attemptCount` reaches 10; the document count is unchanged across those ten.
- **The stall:** each of the three decline branches writes its own `stalledReason`, increments its own counter, and pushes `nextNudgeAt` into `(now + 0.8·STALL_RECHECK_MS, now + 1.2·STALL_RECHECK_MS)`; **`nextNudgeAt` is never unset**; the stall write does **not** land on a row that left the working states between the scan and the write.
- **The no-interval attempt branch** sets `stalledAt`/`stalledReason: "cadence"` in the same update that unsets `forceDeliver` — and, run with the mutation from Verification Rule 5, **throws** against the extended double.
- **Snooze expiry** returns a row with a `deliveryReference` to `delivered` and one without to `pending`, sets `forceDeliver: true` and `nextNudgeAt = now`, unsets `snoozedUntil` and `expiresAt`, and **runs before delivery in the same tick** (assert the expired row is *attempted* on that tick).
- **The heartbeat** carries every gauge and every counter, `state` is `ok`/`backlog`/`degraded` on the three drivable conditions, and the four saturating gauges **saturate** at `GAUGE_COUNT_LIMIT` (the case the harness extension made real).
- **Policy posture:** a read that returns `null` runs the delivery phase normally; a read that **throws** on a process's first tick **skips** the delivery phase, counts `policyReadFaults`, writes `degraded`, and leaves every row's `nextNudgeAt` and stall markers untouched; a read that throws on a **later** tick uses the retained copy and marks nothing.
- **`init()`/`start()`/`stop()`:** a unique-index failure throws out of `init()`; any other index failure does not; a reason-map failure leaves `initialized === true` and `startable === false`; a first-subscription-load failure leaves `started === false` without throwing; `start()` performs **no** `ops_subscriptions` read during `init()` (assert against the double's `operations` log); `stop()` clears both timers and awaits the in-flight tick.
- **`validateTarget` at load:** a subscription whose registered adapter rejects its target is unloaded, warned once, counted, and **not mutated in the database**; one whose `adapterId` names no registered adapter **loads normally**; an adapter whose `validateTarget` **throws** is treated as `false` and the remaining subscriptions still load.
- **Ticks never overlap:** a second `sweepOnce()` started while the first is in flight returns the same promise and performs no second set of phase reads.
- **The latch:** two concurrent `withRowLock` calls on one id run in series; on two different ids they interleave; the map is empty after both settle.

- [ ] **Step 5:** Verify.

```bash
npx vitest run src/ops/delivery.integration.test.ts src/ops/ingest.integration.test.ts src/ops/notification-store.test.ts
npx tsc --noEmit
```

- [ ] **Step 6:** **Negative-verify the `$set`/`$unset` guard — both halves.** This is Verification Rule 5 and it is the only mutation in the plan whose *evidence* is that it behaves differently against the two harness versions.

In `record()`'s no-interval branch, additionally emit `unset.stalledAt = ""` and `unset.stalledReason = ""`.

- Against the **extended** double: `npx vitest run src/ops/delivery.integration.test.ts` must fail on the no-interval case with a `would create a conflict` error. Record the message.
- Then revert only the harness change from chunk 2 Task 3 Step 2(b) and re-run: the same case must go **green**, while production would throw on the first tick of the shipped default. Record that too — it is the evidence the harness addition was load-bearing.

Restore both.

- [ ] **Step 7:** Commit.

```bash
git add src/ops/delivery.ts src/ops/notifier.ts src/ops/notification-types.ts src/ops/delivery.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(KPR-468): delivery, nudging, the stall, snooze expiry and the notifier sweep

D5/D6/D8/D10: cadence resolved from operator data with a profile
substituting the table wholesale and no fallback from an unknown profile;
the three-disjunct attempt gate (attemptCount === 0, forceDeliver, or a
resolved cadence); the three-armed scan whose first two arms are
index-immune to the cadence-stall backlog; the stall that pushes a
declined row forward on a bounded jittered re-check rather than unsetting
nextNudgeAt (invisible to the due-scan) or leaving it due (an ever-growing
never-TTL'd prefix at the head of the scan).

No retry ladder: rejected is recorded and the next attempt is the next
ordinary nudge, because D6 supplies no retry hint to schedule from.
unknown never reaches delivered.

The notifier's init/start split is D6's: subscriptions load in start(),
after registerTransport, so validateTarget has adapters to run against. A
unique-index fault leaves the notifier unstarted with the singleton unset;
a reason-map fault leaves intake live and the sweep off.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
