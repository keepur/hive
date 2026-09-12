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
  INTAKE_DEADLINE_MS,
  OPS_NUDGE_STATES,
  SUBSCRIPTION_RELOAD_MS,
  SWEEP_INTERVAL_MS,
  freshCounters,
  ledgerRetentionDays,
  type OpsAcknowledgement,
  type OpsIntakeResult,
  type OpsNotifierCounters,
  type OpsPolicy,
  type StalledReason,
} from "./notification-types.js";
import { OpsNotificationStore } from "./notification-store.js";
import { IngestPhase } from "./ingest.js";
import { DeliveryPhase, type DeliveryResult } from "./delivery.js";
import { OpsIntake, parseHandle } from "./intake.js";

const log = createLogger("ops-notifier");

const unloadWarned = new Set<string>();

export class OpsNotifier {
  private readonly opsStore: OpsStore;
  private readonly store: OpsNotificationStore;
  private readonly ingestPhase: IngestPhase;
  private readonly deliveryPhase: DeliveryPhase;
  private readonly intake: OpsIntake;
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
    this.intake = new OpsIntake(this.store.notifications, retention, this.clock);
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
    // `StalledReason`, not `string`: the driver types the filter's operand
    // from the field, and the three call sites below pass exactly the three
    // members of that closed union.
    const stallGauge = (reason: StalledReason) =>
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
      rowsUnknownOutcome: await nf.countDocuments(
        { lastOutcome: "unknown", state: working },
        { limit: GAUGE_COUNT_LIMIT },
      ),
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

  /**
   * D6/D7/D10: the seam KPR-455's inbound edge calls. NEVER THROWS.
   *
   * `{ state: "unavailable" }` means exactly four things and no others: the
   * singleton is unset (pre-wiring, or a bare test construction — handled in
   * notifier-singleton.ts), init() did not complete, stop() has begun, or the
   * work did not finish inside INTAKE_DEADLINE_MS.
   * It is deliberately NOT gated on start(): intake depends on nothing start()
   * provides, and gating it there would widen its dead window across the whole
   * Slack connect for no gain.
   *
   * ⚠ THE ONE SENTENCE KPR-455's EDGE NEEDS: `unavailable` means UNKNOWN, NOT
   * "did not apply", and it is SAFE TO RETRY. The deadline below abandons the
   * work rather than cancelling it, so a write can land after the caller has
   * already been told `unavailable` — and a retry of the SAME
   * (actorId, act, at) is the correct response, because `lastAckKey` makes it
   * return `{ state: "noop", reason: "already-applied" }` if it did land and
   * apply it if it did not. An edge that treats `unavailable` as a failure and
   * surfaces an error to the human is reading it wrong.
   *
   * ⚠ AND ONE DETERMINISTIC INTERACTION, named because it is a property of
   * this seam rather than a race: `withDeadline` wraps `withRowLock`, so the
   * 5 s INTAKE_DEADLINE_MS covers LATCH ACQUISITION as well as the work. The
   * delivery phase holds that same per-row latch across
   * ATTEMPT_SPACING_MS + the adapter's own SLACK_POST_TIMEOUT_MS (up to 11 s),
   * so an acknowledgement landing on a row whose delivery is slow returns
   * `unavailable` EVERY TIME, not occasionally — and the act it names will
   * then apply on the retry the sentence above already asks for. The
   * alternative — taking the deadline INSIDE the lock — would make the
   * deadline unbounded from the caller's side, which is worse for a Slack
   * interaction callback that must answer its vendor in 3 s.
   */
  async accept(input: OpsAcknowledgement): Promise<OpsIntakeResult> {
    if (!this.initialized || this.stopping) return this.tallyIntake({ state: "unavailable" });
    if (!(input.at instanceof Date) || Number.isNaN(input.at.getTime())) {
      // Counted at the seam; intake.ts substitutes `now`. See its step-3
      // comment: the cost is a per-retry lastAckKey, so this is a real signal
      // about a mis-serializing edge, not noise.
      this.counters.intakeInvalidAt += 1;
      log.warn("ops intake received an unusable `at` — substituting the server clock", { act: input.act });
    }
    // Step 1 of D7's order is split across two files ON PURPOSE: the parsed id
    // is the per-row latch's key, so it must be resolved before the lock is
    // taken. Intake re-uses the parsed value rather than re-parsing.
    const rowId = parseHandle(input.handle);
    if (!rowId) return this.tallyIntake({ state: "refused", reason: "unknown-handle" });
    try {
      const result = await this.withDeadline(
        this.withRowLock(String(rowId), () => this.intake.accept(input, rowId, this.policy ?? null)),
      );
      return this.tallyIntake(result);
    } catch (err) {
      log.warn("ops intake unavailable", { error: String(err) });
      return this.tallyIntake({ state: "unavailable" });
    }
  }

  /**
   * The losing side of this race keeps running to completion — deliberately.
   * It is one bounded CAS whose write is idempotent under the same
   * preconditions, so abandoning the result is safe; cancelling it is not
   * expressible against the driver and inventing an AbortController path here
   * would add a second way for a half-applied write to exist.
   */
  private withDeadline<T extends OpsIntakeResult>(work: Promise<T>): Promise<T | OpsIntakeResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ state: "unavailable" }), INTAKE_DEADLINE_MS);
      timer.unref?.();
      void work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve({ state: "unavailable" });
        },
      );
    });
  }

  private tallyIntake(result: OpsIntakeResult): OpsIntakeResult {
    if (result.state === "applied") this.counters.intakeApplied += 1;
    else if (result.state === "noop") this.counters.intakeNoop += 1;
    else if (result.state === "refused") this.counters.intakeRefused += 1;
    else this.counters.intakeUnavailable += 1;
    return result;
  }
}
