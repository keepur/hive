# KPR-468 plan — chunk 3b: `OpsNotifier`, the shared harness, and the delivery suite

The second half of chunk 3 — **the same Task 5 and the same single commit**, split at the Step 2 | Step 3 seam because the combined file ran past this plan's 1,000-line bound once round 2's containment frame, stopped-latch checkpoints, record-CAS counter and harness contract landed. This is a **step** seam rather than a task seam (the chunk-1 / 1b and chunk-2 / 2b splits were both task seams), which is recorded in the plan index because the bound requires the exception to be recorded: `DeliveryPhase` and `OpsNotifier` are one commit and cannot be split into two without leaving a tree that does not compile.

**Read [chunk 3](kpr-468-plan-3-delivery.md) first** — Steps 1 and 2 live there, along with the three D5 rulings and the containment rule that govern this file too:

1. **`nextNudgeAt` is NEVER unset while a row is `pending` or `delivered`, and is never left at its due value either.**
2. **The attempt gate is THREE disjuncts:** `attemptCount === 0 ∨ forceDeliver === true ∨ a cadence resolved`.
3. **The scan is three ORDERED arms whose first two are index-immune to the stall set.**
4. **Delivery and snooze expiry are per-row `try`/`catch`, counted, continue** — the OPPOSITE of ingest's stop-at-the-event rule.

Steps 3–8 follow.

---

### Task 5 (continued): `OpsNotifier`, the harness, the suite

**Files** (the task's full list is in chunk 3; these are the ones this half creates):

- Create: `src/ops/notifier.ts`
- Create: `src/ops/testing/notifier-harness.ts`
- Create: `src/ops/delivery.integration.test.ts`

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
import { DeliveryPhase, type DeliveryResult } from "./delivery.js";

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
      // D5/D10: the same stopped latch the delivery and expiry phases read.
      // Ingest is the phase with the largest budget (INGEST_EVENT_BUDGET
      // events), so it is the one that decides whether "the drain is bounded
      // by one adapter deadline" is true or is prose.
      () => this.stopping,
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
    // do not wrap this in the try below — the unique-index fault is the one
    // that must reach index.ts, which is what leaves the singleton unset.
    if (!uniqueOk) throw new Error("ops_notifications identity index unavailable");
    // ⚠ Set DELIBERATELY BETWEEN THE TWO FAULTS, and this one unremarkable
    // statement IS the whole split posture: above it the unique-index throw
    // leaves `initialized === false` (singleton unset, intake dead); below it
    // the reason-map catch leaves `initialized === true` (singleton set,
    // INTAKE LIVE, sweep off). Move this line either way and one of D10's two
    // postures silently becomes the other.
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

  /**
   * Test seam for the RETAINED policy copy — deliberately NOT a general
   * backdoor. Intake reads the copy the last tick retained (D5), so the COLD
   * PATH (intake before any tick has completed, `policy === undefined`) is
   * only assertable if a test can set the copy to a known value and then show
   * intake did not go looking for another one. AC10's companion assertion —
   * "intake performs no ops_policy read" — is checked against the double's
   * `operations` log, never against this member; this member exists so the
   * cold path can be entered and left deliberately rather than by timing.
   */
  __setPolicyForTests(doc: OpsPolicy | null | undefined): void {
    this.policy = doc;
  }

  /**
   * ⚠ THE WHOLE BODY IS WRAPPED, and the wrap is load-bearing rather than
   * defensive. Several reads in a tick are legitimately UNCONTAINED at their
   * own level — the store's own doc comment says a cursor fault "THROWS and is
   * the caller's to contain", the ingest page `find` sits outside every
   * per-event `try` by design (a page that cannot be read is not an event
   * fault), and the six gauge `countDocuments` plus `writeHeartbeat` itself
   * are outside any `try` below. Without this frame all of them propagate to
   * `sweepOnce`'s `.catch`, which counts `sweepFaults` and writes NOTHING —
   * so the spec's "Mongo unavailable for a tick ⇒ tick fails, counted,
   * heartbeat degraded, no throw" row would be unsatisfiable, and the wedge
   * signal KPR-455 reads would go silent on exactly the fault class an
   * operator most needs to see. AC13 limb 3 does not catch this on its own:
   * it injects on `ops_notifications.insertOne`, which IS inside the per-event
   * try, so the gap is invisible to a suite that only drives that fault.
   */
  private async run(): Promise<void> {
    const now = this.clock();
    try {
      await this.runPhases(now);
    } catch (err) {
      this.counters.sweepFaults += 1;
      log.warn("ops sweep phase fault — writing a degraded heartbeat", { error: String(err) });
      await this.writeDegradedHeartbeat(now);
    }
  }

  /**
   * Best effort by construction: if the heartbeat write is itself what is
   * failing, there is nothing left to report WITH, and a throw here would
   * re-enter sweepOnce's catch and double-count. No gauges — they are among
   * the reads that may be throwing.
   *
   * ⚠ CONTRACT FOR KPR-455, WHICH IS THE READER OF THIS DOCUMENT. This is a
   * `$set` upsert over a STRICT SUBSET of the ok-path fields, so every field
   * it does not name — eventsBehind, oldestUnappliedAt, rowsPending,
   * rowsNudgeDue, rowsSnoozed and the four saturating gauges — RETAINS THE
   * PREVIOUS TICK'S VALUE and carries no staleness marker of its own. There is
   * deliberately none: `state: "degraded"` plus `timestamp` is the tell, and a
   * renderer must treat every gauge on a degraded document as as-of
   * `lastSuccessfulSweep`, not as-of `timestamp`. Clearing them instead would
   * be worse — an operator would read a real backlog as zero.
   *
   * `cursorAt: this.lastCursorAt` is `undefined` when the FIRST tick of a
   * process degrades (nothing has set it yet); the driver writes that as
   * `null`, which is the same shape a clock-initialized cursor produces.
   */
  private async writeDegradedHeartbeat(now: Date): Promise<void> {
    try {
      await this.store.writeHeartbeat({
        timestamp: now,
        lastSuccessfulSweep: this.lastSuccessfulSweep,
        cursorAt: this.lastCursorAt,
        ...this.counters,
        state: "degraded",
      });
    } catch (err) {
      log.warn("ops heartbeat write failed — this tick reports nothing", { error: String(err) });
    }
  }

  private async runPhases(now: Date): Promise<void> {
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
    // D5/D10 — the BETWEEN-PHASES half of "the tick checks its stopped latch
    // between rows and phases". Ingest checks between events; these two
    // checkpoints are what stop a drain from paying a whole expiry page and a
    // whole delivery budget after stop() has already returned to the caller.
    // No heartbeat on this path: a stop is not a tick outcome, `stop()` runs
    // before mongoClient.close() and the next boot's first tick writes one.
    if (this.stopping) return;

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
    if (this.stopping) return;

    // D5: a tick whose read THREW and which has NO retained result — the first
    // tick of a process — skips the delivery phase ENTIRELY. No row is marked,
    // nothing is pushed forward. A tick whose read SUCCEEDED and returned null
    // has a retained result and runs NORMALLY, which is every tick of the
    // shipped default and the state AC11 drives.
    let delivery: DeliveryResult;
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
      // ⚠ THESE THREE CARRY NO `limit` AND ARE EXACT, deliberately, and it is
      // the one place in the tick where an unbounded count is accepted.
      // `rowsNudgeDue` is named in chunk 3's delivery phase as THE exact answer
      // the `deferred` heuristic must not be mistaken for, so saturating it
      // would falsify a claim already made at its point of use; the other two
      // are its peers and a mixed posture across three adjacent depths would be
      // worse than either uniform one. The cost is bounded and it is not
      // bounded by traffic: all three are covered by `ensureIndexes` (chunk 2)
      // — index 3 or 5 for the first two, index 8 for the third, every one of
      // them leading on `state` — so each is an index count restricted by its
      // leading `state` key to the operator's OPEN-CONDITION set (`rowsPending`
      // is one working state, `rowsNudgeDue` is both, `rowsSnoozed` is a state
      // outside OPS_NUDGE_STATES entirely — the bound is the leading key, not
      // membership of the working pair) — the operator's own subscriber × open
      // condition surface, the same bound the clearing fan-out already accepts —
      // and never a collection scan. If that set is ever large enough to matter,
      // saturate them and correct chunk 3's sentence in the same change.
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
   * ⚠ SCOPE. The latch keys on the row's `_id`, because that is the only
   * handle intake has, and INGEST'S RENEWAL ARMS ADDRESS ROWS BY
   * (subscriptionId, dedupeKey) BEFORE ANY _id EXISTS — on the create path
   * there is no row yet — so those two arms cannot take an _id-keyed latch at
   * all. The CLEARING arm is different and the distinction is worth stating
   * precisely: it does `find({dedupeKey}).toArray()` and then
   * `updateOne({_id: row._id, …})`, so the `_id` IS in hand and it COULD take
   * the latch. It does not need to, because its write is a CAS whose only
   * concurrent writer is state-disjoint (delivery and intake never write
   * `state: "cleared"`, and the CAS's own `state: { $ne: "cleared" }` plus the
   * watermark make a lost race a matchedCount-0 no-op rather than a blend).
   *
   * STANDING RULE for anything added to ingest later: **every new ingest write
   * must either be a CAS on the precondition it depends on, or take this
   * latch.** A plain unconditional `updateOne` from ingest is the one shape
   * neither mechanism covers, and it would blend silently against a
   * concurrent delivery or intake write on the same row.
   *
   * The latch therefore covers delivery, snooze expiry and intake.
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

- [ ] **Step 4:** Create `src/ops/testing/notifier-harness.ts` — **the shared harness, and the contract chunks 3, 4 and 6 are all written against.**

**Why a plain module and not an export from a `.test.ts`.** Chunks 3, 4 and 6 each need the same seeding, the same fixtures and the same tick barrier, and the obvious shortcut — export the helper from whichever test file defines it — is measured-wrong on this tree. KPR-454's plan records the probe (vitest 4.1.11): **a consumer importing a `.test.ts` re-registers that file's suites and file-scope hooks into the importer**, so the exporter's cases run twice under the importer's fixtures. The repository has zero cross-`.test.ts` imports, the established pattern is a plain module (`src/obligations/testing/{fake-db,harness,refusals}.ts`), and a plain module additionally gets `tsc --noEmit` coverage that a `.test.ts` does not (`tsconfig.json` excludes `src/**/*.test.ts`). This plan is exposed to exactly that trap and takes the same exit.

**Two files do NOT import it, deliberately:** `notification-store.test.ts` and `ingest.integration.test.ts` (chunk 2 / 2b). This module constructs an `OpsNotifier`, which does not exist until this task, and Task 4's independence from Task 5 is a stated ordering constraint. Those two build a `FakeDb` and construct their subject directly.

**It is also excluded from every source scan by construction** — chunk 6's isolation scan skips `/testing/`, and KPR-454's `opsSources` scan skips `src/ops/testing/`. That exclusion is load-bearing here: this module legitimately mentions collection names and `state:` literals that those scans forbid in the notifier's own sources.

**The exported surface — this is the contract; nothing outside this list may be assumed by a test.**

| export | shape | notes |
| --- | --- | --- |
| `BASE` | `Date` | The fixed epoch every fixture is derived from. `2026-01-01T00:00:00.000Z`. |
| `t(minutes: number)` | `Date` | `BASE + minutes · 60 000`. Negative is allowed and is how a cursor is placed before the first seeded event. |
| `sub(id, over?)` | `OpsSubscription` | A minimal enabled subscription: `_id: id`, `subscriberId: \`${id}-owner\``, `transport: { adapterId: "fake", target: "C0000001" }`, a filter that matches nothing (**the notifier never evaluates it** — AC2 — so its content is deliberately inert). `over` shallow-merges. |
| `reason(id, over?)` | the `ops_reasons` row shape KPR-454 defines | `producer` defaults to `"tool"` — **pinned, not incidental**: the notifier's only reason read is ``reasons.get(`${row.producer}:${row.reasonId}`)`` (chunk 3) against a map KPR-454 keys `` `${producer}:${reasonId}` ``, so a `reason()` whose producer differs from `seedEvent()`'s `"tool"` never resolves. Only `remediationTemplate` is read by this child. |
| `FakeTransport` | class implementing `OpsTransport` | Below. |
| `harness(options?)` | `Promise<NotifierHarness>` | Below. |
| `failNth(db, collection, operation, n)` | `void` | `let seen = 0; db.failNext(collection, operation, false, () => (seen += 1) === n)`. Named here so three chunks spell it one way. |
| `failOn(db, collection, operation, when)` | `void` | `db.failNext(collection, operation, false, when)`; `when` receives `{filter?, update?, document?, options?}`. |

Persistent faults and the reset are **methods on the double**, not harness helpers: `db.failAlways(collection, operation, when?)` and `db.clearFaults()` (chunk 2 Task 3 Step 2(e)).

**Seeding defaults — the contract, not an implementation detail.** Five chunk-6 cases are "seed, tick, assert a row", which is only true if the seeded event actually matches a subscription; leaving that to the implementer's judgement is how those cases end up asserting against an empty ledger. Every default below is fixed:

| what | default | why it is this |
| --- | --- | --- |
| the injected clock's initial value | `BASE` | `cursorAt: t(-1)` and `advance()` are both defined relative to it. `now()` returns it until `advance()` moves it. |
| `seedEvent().publishedAt` | `t(0)` | One minute after the seeded cursor, so a single seeded event is unambiguously ahead of it. |
| `seedEvent().dedupeKey` | `` `tool:workItem:w1:r1:${n}` `` , `n` a per-harness counter | Distinct per call, so `seedEvents(5)` produces five rows rather than five renewals of one. Under KPR-454's `producer:subjectKind:subjectId:reasonId:generation` (chunk 2b) its four leading components agree with the `producer`, `subject` and `reasonId` defaults below, and the counter occupies the generation slot — the one component that legitimately varies within a family (so `seedEvents(5)` reads as five generations, not five unrelated keys); the `generation` **field**'s own default of `1` coincides with the counter only at `n === 1`, which is inert because **nothing in KPR-468 parses a dedupeKey at all** (the D6 acknowledgement handle is `String(row._id)`, chunk 3). Readability, not function — but a fixture that contradicts its own table is what a later reader trips on. |
| **`seedEvent().matchedSubscriptionIds`** | **the `_id`s of `options.subscriptions`, in order** | ⚠ **The load-bearing one.** Ingest reads the stamped list and never re-evaluates a filter (AC3), so an unstamped event creates nothing. AC4, AC7, AC11 and AC13 limbs 1 and 3 all depend on this default; AC3's own cases override it explicitly, which is the whole point of that criterion. |
| `seedEvent().producer` | `"tool"` | Matches the default `dedupeKey`'s producer component, matches `reason()`'s own default (below), and satisfies clearing provenance's same-producer clause without a per-case override. |
| `seedEvent().class` / `retry` | `"integrity"` / `"deterministic"` | ⚠ Both are UNIONS (`OpsClass`, `OpsRetry` — KPR-454's contract), so the value has to be one of theirs. The pair is the cadence table's key (`` `${class}:${retry}` ``), and this one is what the policy fixtures in the cadence cases seed. |
| `seedEvent().waiting` | `"nobody"` | Also a union (`Waiting`), not a boolean. The stall and view-shape cases that care set it. |
| `seedEvent().reasonId` | `"r1"` | The id `reason("r1")` mints, so `options.reasons: [reason("r1")]` is the whole wiring — true only because both default `producer` to `"tool"` and the lookup is keyed on the pair. A mismatch is loud (`reasonUnknown` plus a red AC12 remediation assertion), not silent, but it is a class of implementer judgement this table exists to remove. |
| `seedEvent().subject` | `{ kind: "workItem", id: "w1" }` | `OpsSubject` is `{kind, id}` and both are required. |
| `seedEvent().schemaVersion` / `generation` / `detail` / `evidence` / `matchedSubscriptions` | `1` / `1` / `{}` / `[]` / `matchedSubscriptionIds.length` | All five are **required** on `OpsEvent`. `detail` is inert. `evidence` is inert for a **non-clearing** event and is the **provenance gate** for a `judgment`/`integrity` clearing — `clearingProvenanceOk` reads `e.evidence.length >= 1` for both classes (chunk 2b) — so with this default (`class: "integrity"`, `evidence: []`) a clearing event seeded through the default is **refused** and counted `clearRefused`. AC6's clearing rows set it, as AC6 independently specifies; AC12's view-shape cases set both. |
| `seedEvents(n, over)` | `over` applied to all `n`, `publishedAt` overridden to `t(0) … t(n-1)` | An explicit `publishedAt` in `over` is **ignored** for this reason; pass individual `seedEvent` calls if a case needs one. |

Any case that depends on one of these rather than setting it should say so in a comment — AC13 limb 3 is the model (it passes `cursorAt: t(-1)` explicitly *because* it depends on it).

**Teardown.** `harness({ start: true })` arms two real `setInterval`s (`SWEEP_INTERVAL_MS`, `SUBSCRIPTION_RELOAD_MS`). **Every case that passes `start: true`, or calls `notifier.start()` itself, must `await h.notifier.stop()` before it ends** — in the case body or an `afterEach`, either is fine, but it is not optional and `unref()` is not a substitute under a live vitest runner. The default `start: false` arms nothing, which is the other reason it is the default.

**`NotifierHarness` — every member, because chunks 3, 4 and 6 use all of them.**

```typescript
export interface HarnessOptions {
  subscriptions?: OpsSubscription[];
  reasons?: Row[];
  /** Written to ops_policy BEFORE init(); zero rows is the shipped default. */
  policy?: OpsPolicy | null;
  /**
   * The sweep cursor seeded before the first tick. DEFAULTS TO `t(-1)`, not to
   * absent: with no cursor the first tick takes D3's cold-start arm, sets the
   * cursor to `now` and applies NOTHING, so every "seed events, tick, assert a
   * row" case would silently assert against an empty ledger. Pass `null`
   * explicitly for the cold-start cases (AC5).
   */
  cursorAt?: Date | null;
  activityRetentionDays?: number; // default 90, config.ts:659's own default
  transport?: FakeTransport | null; // null ⇒ register none (the unbound-adapter cases)
  /**
   * Default FALSE. The harness reproduces start()'s FIRST SUBSCRIPTION LOAD
   * (`reloadSubscriptions(true)`) without arming its timers or running its
   * immediate sweep, so every tick in a test is one the test asked for. Pass
   * `true` for the AC14 lifecycle cases that are ABOUT start().
   */
  start?: boolean;
}

export interface NotifierHarness {
  db: FakeDb;
  store: OpsNotificationStore;
  notifier: OpsNotifier;
  transport: FakeTransport;
  now(): Date;
  /** Moves the injected clock forward; nothing is scheduled off it. */
  advance(ms: number): void;
  /** THE BARRIER. One full tick — `notifier.__tickForTests()`. */
  tick(): Promise<void>;
  /** Inserts one ops_events document; returns it WITH its minted `_id`. */
  seedEvent(over?: Partial<OpsEvent>): Promise<OpsEvent>;
  /** `n` events on distinct dedupeKeys at `t(0) … t(n-1)`, in order. */
  seedEvents(n: number, over?: Partial<OpsEvent>): Promise<OpsEvent[]>;
  /** The one ledger row for a (subscriptionId, dedupeKey). THROWS if absent. */
  row(subscriptionId: string, dedupeKey: string): Promise<OpsNotification>;
  /**
   * PINNED to `notifications.countDocuments({})` — NOT `find({}).toArray().length`.
   * The stop-seam case (Step 5) marks `db.operations`, then asserts that no
   * `ops_notifications` `find` follows; a `find`-based ledgerCount() lands its
   * own operation inside that window and turns the assertion red for the wrong
   * reason, whose obvious "fix" is a widened filter that quietly weakens the
   * seam. The double logs `find` and `countDocuments` as distinct operation
   * names, so the pinned spelling is invisible to that assertion.
   */
  ledgerCount(): Promise<number>;
  /** `notifier.getSnapshot()` — counters included. */
  snapshot(): Record<string, unknown>;
  /** The `kind: "ops_notifier_stats"` telemetry document. THROWS if absent. */
  heartbeat(): Promise<Record<string, unknown>>;
}
```

`row()` and `heartbeat()` **throw rather than return `undefined`** on purpose: both are read by assertions of the form `expect((await h.heartbeat()).state).toBe(...)`, and an `undefined` there produces a confusing property error three lines later instead of naming the missing document.

**`FakeTransport`** — the only way to assert what a `NotificationView` carried and what it did **not** (AC12):

```typescript
export class FakeTransport implements OpsTransport {
  /** Every view handed to deliver(), in order. AC12 reads this. */
  readonly views: NotificationView[] = [];
  /**
   * Runs INSIDE deliver(), after the view is recorded and before the outcome
   * is returned — i.e. at the one instant in the component where an
   * irreversible external side effect has happened and the ledger has not been
   * written yet. Assigned per case (`h.transport.onDeliver = …`); it is part of
   * this contract, not a monkeypatch. The `deliveryRecordLost` case is its only
   * caller today and cannot be written without it: `record()`'s CAS is
   * `{_id, state, attemptCount}`, and moving the row out from under it is only
   * possible from in here.
   */
  onDeliver?: (view: NotificationView) => Promise<void> | void;
  private readonly queue: Array<DeliveryOutcome | "throw"> = [];
  constructor(
    readonly adapterId = "fake",
    private readonly clock: () => Date = () => BASE,
    /** Overridable so the "adapter rejects the target" load case is drivable. */
    private readonly valid: (target: unknown) => boolean = (target) => typeof target === "string",
  ) {}
  /** Programs the NEXT calls. The LAST entry repeats once the queue is down to it. */
  program(...outcomes: Array<DeliveryOutcome | "throw">): void {
    this.queue.push(...outcomes);
  }
  validateTarget(target: unknown): boolean {
    return this.valid(target);
  }
  async deliver(view: NotificationView): Promise<DeliveryOutcome> {
    this.views.push(view);
    await this.onDeliver?.(view);
    const next = this.queue.length > 1 ? this.queue.shift()! : this.queue[0];
    if (next === "throw") throw new Error("fake transport fault");
    return next ?? { status: "accepted", reference: { kind: "fake", id: view.handle }, at: this.clock() };
  }
}
```

The default is `accepted`, because "the transport accepts" is the case most assertions are about; a suite that never calls `program` still gets deterministic behaviour. **A `validateTarget` that throws** (one named delivery case) is programmed by passing a `valid` that throws, not by a separate flag.

`harness(...)` itself: build a `FakeDb`; write `options.policy` into `ops_policy` under `_id: OPS_POLICY_ID` when given; insert `options.subscriptions` into `ops_subscriptions` and `options.reasons` into `ops_reasons`; construct `new OpsNotifier(db.db, options.activityRetentionDays ?? 90, () => clock, sleep)` with a **mutable** `clock` the `advance()` closure moves and a `sleep` that resolves immediately (`ATTEMPT_SPACING_MS` must not put real seconds into a suite); `await notifier.init()`; `registerTransport(transport)` unless `transport: null`; seed the cursor unless `cursorAt: null`; then either `await notifier.start()` or `await notifier.reloadSubscriptions(true)`.

⚠ **The immediate-resolve `sleep` is why `ATTEMPT_SPACING_MS` is invisible in tests, and that is deliberate** — the spacing is a Slack-rate property, not a correctness one. The one thing it costs: the delivery phase's wall-clock budget cannot be exhausted by spacing alone in a test, so AC7's starvation case must create its backlog with **rows**, not with time.

- [ ] **Step 5:** Create `src/ops/delivery.integration.test.ts`.

Cover, at minimum, each of the following as a named case, driving a real `OpsNotifier` through **Step 4's harness** (`harness(...)`, `h.tick()` as the barrier, `h.transport.program(...)` for outcomes). Nothing in this file constructs a `FakeDb` or an `OpsNotifier` by hand.

- **Cadence resolution** (unit-shaped, via the exported `resolveCadence`): the `(class, retry)` key is read exactly as D8 keys it; a `cadenceProfile` substitutes the table **wholesale** and an **unknown** profile resolves `undefined` **without** consulting the table; a below-floor profile clamps up and warns exactly once per `(name, value)`; a below-floor *table* entry clamps up **without** a warning; a `null` policy and a zero/negative/non-finite interval all resolve `undefined`; a profile named `constructor` does not read the prototype chain.
- **The three outcomes:** `accepted` transitions `pending → delivered`, sets `deliveryReference`, and sets `nextNudgeAt` from the resolved cadence; `rejected` and `unknown` leave `state` unchanged; `unknown` never reaches `delivered`; an adapter that **throws** is recorded as `unknown`/`transport-fault` and `transportFaults` increments.
- **An accepted nudge on an already-`delivered` row does not advance `stateAt`/`principalAt`** but does refresh `deliveryReference`.
- **`nudgeCount` excludes the first attempt** while `attemptCount` counts it; `attempts[]` never exceeds `ATTEMPTS_RING_CAP` across ten attempts while `attemptCount` reaches 10; the document count is unchanged across those ten.
- **The stall:** each of the three decline branches writes its own `stalledReason`, increments its own counter, and pushes `nextNudgeAt` into `(now + 0.8·STALL_RECHECK_MS, now + 1.2·STALL_RECHECK_MS)`; **`nextNudgeAt` is never unset**; the stall write does **not** land on a row that left the working states between the scan and the write.
- **The no-interval attempt branch** sets `stalledAt`/`stalledReason: "cadence"` in the same update that unsets `forceDeliver` — and, run with mutation **NV6** (the plan index's Verification Rules), **throws** against the extended double.
- **Snooze expiry** returns a row with a `deliveryReference` to `delivered` and one without to `pending`, sets `forceDeliver: true` and `nextNudgeAt = now`, unsets `snoozedUntil` and `expiresAt`, and **runs before delivery in the same tick** (assert the expired row is *attempted* on that tick).
- **The record CAS that loses:** drive an attempt whose `record()` update matches nothing — `failOn(h.db, "ops_notifications", "updateOne", (ctx) => ctx.update?.$inc?.attemptCount === 1)` is the wrong instrument (it throws); instead move the row out from under the CAS from **inside** `deliver()`, through the harness's `onDeliver` hook (Step 4's `FakeTransport` contract — the row is written *between* the side effect and the CAS, which is the whole point and is not reachable any other way):

  ```typescript
  h.transport.onDeliver = async () => {
    // The CAS is { _id, state, attemptCount }. Moving attemptCount is enough
    // and is the smallest change that models a concurrent writer.
    await h.store.notifications.updateOne({ dedupeKey: KEY }, { $inc: { attemptCount: 1 } });
    h.transport.onDeliver = undefined; // once, or the next attempt loses too
  };
  ```

  Assert: **no throw**, `deliveryRecordLost === 1`, one warn line, and the row's `attempts[]`/`lastOutcome`/`deliveryReference` **unchanged**. This is the one CAS in the component that runs after an irreversible external side effect, so the case exists to pin that the miss is *counted* rather than silent — it is unreachable through the latch today, which is exactly why nothing else would catch a future latch change.
- **The heartbeat** carries every gauge and every counter, `state` is `ok`/`backlog`/`degraded` on the three drivable conditions, and the four saturating gauges **saturate** at `GAUGE_COUNT_LIMIT` (the case the harness extension made real).
- **A heartbeat is written even when a phase read THROWS** — the containment frame from Step 3. Drive it on a read that is deliberately **outside** every inner `try`: `failOn(h.db, "ops_events", "find", () => true)` (the ingest page read) and, separately, `failOn(h.db, "ops_notifications", "countDocuments", () => true)` (a gauge). Each must leave `h.tick()` **resolved, not rejected**, `sweepFaults` incremented once, and `(await h.heartbeat()).state === "degraded"`. ⚠ **Able-to-fail:** against an implementation whose `run()` is unwrapped, the throw reaches `sweepOnce`'s `.catch`, `sweepFaults` still increments — so the counter assertion alone passes — and **no heartbeat document exists at all**, which is the assertion that goes red. Include a third limb where the heartbeat write itself fails (`failOn(h.db, "telemetry", "updateOne", …)`): the tick still resolves and nothing is left half-written.
- **The stopped latch between phases.** ⚠ **The latch must flip DURING the tick, and there is exactly one way to arrange that.** `sweepOnce()` opens `if (this.flight) return this.flight; if (this.stopping) return Promise.resolve();` and `__tickForTests()` is a bare forward to it, so on an already-stopping notifier **no phase runs at all** and `runPhases`' two seams are unreachable. Use the double's existing `pause` to hold the tick open at a point *after* ingest has finished its work, flip the latch from the test, then release:

  ```typescript
  const h = await harness({ subscriptions: [sub("s1")] });
  await h.seedEvent();
  // IngestPhase.run's writeCursor is the tick's FIRST `telemetry` updateOne and
  // it runs after the page has fully applied — so this seam is "ingest done,
  // expiry and delivery not yet entered". (The heartbeat write is the same
  // collection+operation, but this tick never reaches it, and `pause` is
  // one-shot regardless.) Arming it AFTER harness() matters: harness() seeds
  // the cursor through the same write.
  const gate = h.db.pause("telemetry", "updateOne");
  const tick = h.tick();
  await gate.reached;
  const stopped = h.notifier.stop(); // sets `stopping` SYNCHRONOUSLY, then awaits this tick
  const mark = h.db.operations.length;
  gate.release();
  await Promise.all([tick, stopped]);

  expect(await h.ledgerCount()).toBe(1); // the ingest phase DID run
  const after = h.db.operations.slice(mark);
  expect(after.filter((o) => o.collection === OPS_NOTIFICATIONS_COLLECTION && o.operation === "find")).toHaveLength(0);
  await expect(h.heartbeat()).rejects.toBeTruthy(); // a stop is not a tick outcome
  ```

  ⚠ **Able-to-fail:** against an implementation missing the post-ingest `if (this.stopping) return`, the expiry scan's `ops_notifications` `find` lands after `mark` and the length assertion goes red. Drive the second seam the same way one phase later — `h.db.pause("ops_notifications", "find", (ctx) => ctx.filter?.state === "snoozed")`, which `expire()` always issues exactly once whether or not any row is snoozed — so the post-**expiry** checkpoint is covered too rather than inferred from the first, and assert no delivery-arm `find` after the mark. **Then, separately, stop before the tick and assert no `ops_events` `find` at all** — that limb is real but it exercises `sweepOnce`'s own guard, not either between-phases checkpoint, and must not be labelled as the latter.
- **Policy posture:** a read that returns `null` runs the delivery phase normally; a read that **throws** on a process's first tick **skips** the delivery phase, counts `policyReadFaults`, writes `degraded`, and leaves every row's `nextNudgeAt` and stall markers untouched; a read that throws on a **later** tick uses the retained copy and marks nothing.
- **`init()`/`start()`/`stop()`:** a unique-index failure throws out of `init()` **and leaves `initialized === false`** (the statement placement, not just the throw); any other index failure does not throw; a reason-map failure leaves `initialized === true` and `startable === false`; a first-subscription-load failure leaves `started === false` without throwing; `start()` performs **no** `ops_subscriptions` read during `init()` (assert against the double's `operations` log); `stop()` clears both timers and awaits the in-flight tick. (These are the cases that use `harness({ start: true })` or drive `init()`/`start()` themselves — see the harness contract.)
- **`validateTarget` at load:** a subscription whose registered adapter rejects its target is unloaded, warned once, counted, and **not mutated in the database**; one whose `adapterId` names no registered adapter **loads normally**; an adapter whose `validateTarget` **throws** is treated as `false` and the remaining subscriptions still load.
- **Ticks never overlap:** a second `sweepOnce()` started while the first is in flight returns the same promise and performs no second set of phase reads.
- **The latch:** two concurrent `withRowLock` calls on one id run in series; on two different ids they interleave; the map is empty after both settle.

- [ ] **Step 6:** Verify.

```bash
npx vitest run src/ops/delivery.integration.test.ts src/ops/ingest.integration.test.ts src/ops/notification-store.test.ts
npx tsc --noEmit
```

- [ ] **Step 7:** ⛳ **NV6 — negative-verify the `$set`/`$unset` guard, both halves.** One of the plan's two negative-verify points outside chunk 6 (the other is **NV8**, boot order, in chunk 5), and the only mutation in the plan whose *evidence* is that it behaves differently against the two harness versions.

In `record()`'s no-interval branch, additionally emit `unset.stalledAt = ""` and `unset.stalledReason = ""`.

- Against the **extended** double: `npx vitest run src/ops/delivery.integration.test.ts` must fail on the no-interval case with a `would create a conflict` error. Record the message.
- Then revert only the harness change from chunk 2 Step 2(b) and re-run: the same case must go **green**, while production would throw on the first tick of the shipped default. Record that too — it is the evidence the harness addition was load-bearing.

Restore both.

- [ ] **Step 8:** Commit.

```bash
git add src/ops/delivery.ts src/ops/notifier.ts src/ops/testing/notifier-harness.ts src/ops/delivery.integration.test.ts
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

The tick's phase-and-gauge body is wrapped so an uncontained read — the
cursor read, the ingest page find, a gauge count, the heartbeat write —
still yields a degraded heartbeat instead of a silent tick, and the
stopped latch is checked between phases as well as between rows, so a
drain is bounded by one event's application rather than a whole ingest
budget. record()'s CAS — the one write that follows an irreversible
external side effect — counts its own miss rather than blending it.

Adds src/ops/testing/notifier-harness.ts, the shared plain-module harness
chunks 3, 4 and 6 all drive through (a .test.ts export would re-register
its suites into every importer — KPR-454's measured probe).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
