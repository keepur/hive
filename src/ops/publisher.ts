import type { Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { OpsStore, type LoadedReason } from "./store.js";
import { evaluateMatches } from "./match.js";
import { assertReasonTableLegal, HIVE_RUNTIME_REASONS } from "./reasons.js";
import { OPS_SCHEMA_VERSION, type OpsEvent, type OpsPublishInput, type OpsSubscription } from "./types.js";
import { OPS_CLEARS_MAX_LENGTH, OPS_EVIDENCE_MAX, OPS_ID_MAX_LENGTH, clipForLog, isOpsToken } from "./ids.js";

const log = createLogger("ops-publisher");

/**
 * ⚠ The three constants the spec delegates to the plan (Assumptions,
 * "three numeric bounds carry no value in this spec"). The BEHAVIOUR on
 * breach is fixed by the spec and is implemented below; only the values are
 * chosen here. No hive.yaml key ships for any of them — changing one is a
 * code change (the standing "no preemptive levers" preference).
 */
/**
 * D8. One entry per DISTINCT FAILING TOOL, so the key space is bounded by the
 * installed tool inventory (low hundreds on a maximal hive), not by traffic.
 * 2000 is ~5x that ceiling: eviction is unreachable in normal operation and
 * this is a leak bound rather than an operating limit. Roughly 250-350 bytes
 * per entry once the family-string key and the V8 Map overhead are counted,
 * so ~600 KB at full cap — immaterial to the choice either way. Breach evicts
 * oldest-first and costs one delayed epoch boundary — the restart residual's
 * exact shape and bound.
 */
const OPEN_CONDITION_MAP_CAP = 2000;
/**
 * D9. A drain is two indexed reads plus one insert against a local mongod —
 * single-digit ms — so 1000 jobs is roughly 3-8 s of absorption, the right
 * window for the failure storm this queue exists to survive. ~300 KB.
 * Deeper buys little: past the first failure of a family every job is a
 * restatement of a condition already recorded.
 */
const PUBLISH_QUEUE_DEPTH = 1000;
/**
 * D10. Shutdown already awaits Slack and Mongo; the ops queue must not add a
 * visible stall to a kickstart. 2 s clears several hundred jobs — more than a
 * healthy queue ever holds.
 */
const SHUTDOWN_DRAIN_MS = 2000;

/** D9: stated AND delegated by the spec; adopted as written. */
const SUBSCRIPTION_RELOAD_MS = 60_000;

// EXPORTED so a test can name the return type of `__openEntryForTests`.
// (NOT because omitting `export` would fail the build: TS4053 covers a name
// imported from another module that cannot be named, not a same-file local
// declaration — with `export` removed, `tsc --declaration` emits cleanly and
// writes an unexported `interface OpenCondition` into publisher.d.ts.
// Reproduced round 2; the earlier comment asserted the opposite.)
export interface OpenCondition {
  /**
   * D8: a process-wide monotonic integer assigned by the drainer at the
   * moment it CREATES an entry — never reused, never re-assigned to an
   * existing entry. It is what keeps "the same open interval" decidable even
   * when a family closes and re-opens at the same generation (reachable
   * whenever the epoch resolver's reads fault and it falls back to its last
   * in-process value). It resets with the process, which is sound because the
   * queue and the map are in-process too: no job can outlive the counter it
   * was stamped against.
   */
  openSeq: number;
  /** The key of the failure that opened the interval; a recovery publishes it as `clears`. */
  dedupeKey: string;
  firstFailureAt: Date;
}

type Job =
  | { kind: "failure"; input: OpsPublishInput }
  | { kind: "recovery"; input: OpsPublishInput; family: string; openSeq: number };

export interface OpsPublisherCounters {
  published: number;
  rejected: number;
  publishFaults: number;
  queueOverflow: number;
  idOmitted: number;
  recoveryCoalesced: number;
  recoverySuperseded: number;
  epochResolveFaults: number;
  indexFailures: number;
  /** Data-sourced registry rows this engine normalized (reasons.ts auditReasonRow). */
  reasonRowAnomalies: number;
  subscriptionReloadFaults: number;
  drainDropped: number;
}

export class OpsPublisher {
  private readonly store: OpsStore;
  private reasons = new Map<string, LoadedReason>();
  private subscriptions: OpsSubscription[] = [];
  private readonly open = new Map<string, OpenCondition>();
  private readonly queue: Job[] = [];
  private draining = false;
  private stopping = false;
  /**
   * D9 + AC7's "a log line and a counter". ARMED on the transition INTO the
   * overflowing state, re-armed only once the drainer has emptied the queue.
   *
   * Overflow is a storm-only event by construction — the queue is
   * PUBLISH_QUEUE_DEPTH deep, so anything that reaches the cap is dropping on
   * every arrival until it drains — and a line per dropped job would be
   * exactly the operational flood this producer exists to replace. The
   * `noKeyWarned` latch in `meeting-classifier.ts` is the idiom; the one
   * difference is that this latch RE-ARMS, so a second storm an hour later is
   * reported rather than silently swallowed for the life of the process.
   */
  private overflowWarned = false;
  private reloadTimer?: ReturnType<typeof setInterval>;
  private nextOpenSeq = 1;
  private readonly counters: OpsPublisherCounters = {
    published: 0,
    rejected: 0,
    publishFaults: 0,
    queueOverflow: 0,
    idOmitted: 0,
    recoveryCoalesced: 0,
    recoverySuperseded: 0,
    epochResolveFaults: 0,
    indexFailures: 0,
    reasonRowAnomalies: 0,
    subscriptionReloadFaults: 0,
    drainDropped: 0,
  };

  constructor(db: Db, retentionDays: number) {
    // D5/D10: THE one loud failure mode, here rather than in init() on
    // purpose. A pure precondition over the code-resident table with no I/O,
    // so it runs before any await; and index.ts constructs the publisher
    // OUTSIDE the try wrapping init(), so a violation is an unhandled boot
    // throw — loud, immediate, unconfusable with a Mongo outage. Inside
    // init() that catch would swallow it into "init failed", the exact
    // degradation D10 forbids. Development-only: the shipped table passes.
    assertReasonTableLegal(HIVE_RUNTIME_REASONS);
    this.store = new OpsStore(db, retentionDays);
  }

  /**
   * D10. Order matters and each step's failure posture differs:
   *  1. indexes — individually contained; a fault keeps the publisher WIRED.
   *  2. registry upsert + read-back — a fault THROWS, so index.ts leaves the
   *     publisher UNSET and boot continues. These are one registry step: a
   *     read-back fault must not leave a wired publisher over an empty map,
   *     which is precisely the state D10 names as spending the
   *     mis-integration counter on a Mongo outage.
   *  3. subscriptions + reload timer + nothing else. There is deliberately no
   *     `.start(`-spelled method: the drainer is demand-driven and the timer
   *     is armed here, so boot-order.test.ts's superset sweep needs no new
   *     allowlist entry (AC13).
   */
  async init(): Promise<void> {
    this.counters.indexFailures = await this.store.ensureIndexes();
    await this.store.upsertReasons(HIVE_RUNTIME_REASONS);
    const loaded = await this.store.loadReasons();
    this.reasons = loaded.map;
    this.counters.reasonRowAnomalies = loaded.anomalies;
    await this.reloadSubscriptions();
    // init() is RE-ENTRANT BY DESIGN: Step 6's own second-init case and chunk
    // 5's AC16 both call it on an already-initialized publisher, so without
    // this clear each re-entry abandons a live interval (unref()'d, so it
    // never fails a test loudly — it just keeps reloading subscriptions from
    // a publisher the case has moved past).
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    // unref()'d: an ops-diagnostics timer must never be the thing holding the
    // process open (the outage-replay-processor.ts:44 precedent).
    this.reloadTimer = setInterval(() => void this.reloadSubscriptions(), SUBSCRIPTION_RELOAD_MS);
    this.reloadTimer.unref();
    this.auditLoadedEnableGate();
    log.info("Ops publisher initialized", {
      reasons: this.reasons.size,
      subscriptions: this.subscriptions.length,
      indexFailures: this.counters.indexFailures,
      reasonRowAnomalies: this.counters.reasonRowAnomalies,
    });
  }

  /**
   * D4's enable gate, RE-RUN over the LOADED map — the half
   * `assertReasonTableLegal` structurally cannot reach.
   *
   * That function is a pure precondition over the CODE-RESIDENT table, so it
   * sees both rows enabled and passes. At runtime `enabled: false` is a
   * per-row kill switch (D5), and disabling only the CLEARING row leaves a
   * legal-looking registry in an unclearable state: every success on an open
   * family enqueues a recovery that accept-path step 1 refuses, forever. The
   * operator then sees a climbing `rejected` — the counter D9 reserves for a
   * mis-integrated producer — plus D2's permanent silence, with nothing in the
   * log telling the two apart. This line is that missing signal.
   *
   * ONE `log.error`, never a throw: this is a runtime DATA condition an
   * operator created with a documented lever, not the development-time defect
   * the constructor gate refuses, and D10's rule is that init()'s data faults
   * leave the engine running. Total by construction (`Array.isArray`) and
   * contained anyway — a diagnostic added to init() must never become the
   * thing that leaves the publisher unset.
   */
  private auditLoadedEnableGate(): void {
    try {
      const rows = [...this.reasons.values()].map((loaded) => loaded.row);
      const unclearable = rows
        .filter(
          (row) =>
            row.enabled &&
            row.class === "resource" &&
            !rows.some(
              (other) =>
                other.enabled &&
                other.producer === row.producer &&
                Array.isArray(other.clearsReasonIds) &&
                other.clearsReasonIds.includes(row.reasonId),
            ),
        )
        .map((row) => clipForLog(`${row.producer}:${row.reasonId}`));
      if (unclearable.length === 0) return;
      log.error(
        "Ops registry: an enabled class:resource reason has no ENABLED clearing reason. Every recovery for it will be " +
          "rejected at accept step 1 and the condition can never close. Re-enable the clearing row in ops_reasons and " +
          "restart, or disable the condition row too.",
        { reasons: unclearable.slice(0, 20), count: unclearable.length },
      );
    } catch (err) {
      log.warn("Ops enable-gate audit failed — skipped", { error: String(err) });
    }
  }

  /** D9. A fault leaves the PREVIOUS set in place and counts — never empties it, because an empty set silently makes every event a zero-match. */
  async reloadSubscriptions(): Promise<void> {
    if (this.stopping) return;
    try {
      this.subscriptions = await this.store.loadSubscriptions();
    } catch (err) {
      this.counters.subscriptionReloadFaults += 1;
      log.warn("Ops subscription reload failed — keeping the previous set", { error: String(err) });
    }
  }

  /**
   * D10. Clear the timer and stop accepting FIRST, then drain — a reload
   * firing against a closing Mongo client is a warned-and-counted fault for
   * no benefit. Draining is bounded; on timeout the remainder is dropped and
   * counted, because a shutdown that blocks on an ops queue is worse than a
   * lost diagnostic row.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.reloadTimer = undefined;
    const deadline = Date.now() + SHUTDOWN_DRAIN_MS;
    while ((this.queue.length > 0 || this.draining) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (this.queue.length > 0) {
      this.counters.drainDropped += this.queue.length;
      log.warn("Ops publish queue not drained within the shutdown bound — dropping", { dropped: this.queue.length });
      this.queue.length = 0;
    }
    // ⚠ ACCEPTED RESIDUAL, stated rather than fixed. On deadline expiry an
    // in-flight `runJob` may still be awaiting Mongo; it is not in `queue`, so
    // `drainDropped` misses it, and its insert can land after index.ts closes
    // the client — throwing out of runJob (which has no try of its own) into
    // drain()'s catch, counted as a `publishFault`. Contained and honest;
    // awaiting the in-flight drain
    // promise past the deadline would reintroduce the unbounded shutdown stall
    // SHUTDOWN_DRAIN_MS exists to prevent.
  }

  /** D10 invariant (a). No caller in this diff, deliberately — the KPR-220 spawn-coordinator precedent. */
  getSnapshot(): OpsPublisherCounters & { queueDepth: number; openConditions: number; subscriptions: number } {
    return {
      ...this.counters,
      queueDepth: this.queue.length,
      openConditions: this.open.size,
      subscriptions: this.subscriptions.length,
    };
  }

  // ── Test-only surface (`__`-prefixed, the __resetOpsPublisherForTests
  // precedent). Both exist because the acceptance suite otherwise cannot make
  // an assertion that can fail. Neither has, or may acquire, a caller.
  //
  // Every existing `*ForTests` seam in this tree is a module-level FUNCTION;
  // these two are the first class MEMBERS to use the convention. Deliberate,
  // not an oversight: the state they expose (`queue`/`draining`, `open`) is
  // instance-private, so no module-level function can reach it.
  /**
   * THE DRAIN BARRIER. `enqueue()` is synchronous and fires `void this.drain()`,
   * so a test that publishes and immediately reads Mongo races the drainer —
   * ~40 acceptance assertions do exactly that; without this they are
   * intermittently green, worse than red, since the suite that decides whether
   * the other four chunks are verified would report coverage it lacks.
   * `stop()` cannot be the barrier mid-scenario: it sets `stopping`, so every
   * later `enqueue` silently no-ops.
   */
  async __drainForTests(): Promise<void> {
    while (this.queue.length > 0 || this.draining) await new Promise((r) => setTimeout(r, 1));
  }

  /**
   * One open-condition entry, as a copy. `open` is private and getSnapshot()
   * exposes only `openConditions: number`, so AC9's central assertion — that
   * the LIVE entry survives a superseded recovery's drop, the worst of D8's
   * three harms (permanent silence) — has nothing to read without it.
   */
  __openEntryForTests(family: string): Readonly<OpenCondition> | undefined {
    const entry = this.open.get(family);
    return entry ? { ...entry } : undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Enqueue side — called from the turn thread. Synchronous, non-throwing.
  // ─────────────────────────────────────────────────────────────────────────

  /** Called by observeToolFailure. Never awaited by a turn. */
  enqueueFailure(input: OpsPublishInput): void {
    this.enqueue({ kind: "failure", input });
  }

  /**
   * D8, on success: a map READ and nothing else. If the family is absent —
   * the overwhelmingly common case — this returns immediately. NO DATABASE
   * READ ON THE SUCCESS PATH (D2's explicit rejection of one, against C15).
   *
   * If the family is present, one recovery job is enqueued carrying BOTH
   * halves of the entry's identity: its dedupeKey, which the job publishes as
   * `clears`, and its openSeq, which is job-local bookkeeping checked at
   * drain and NEVER stored on the event (D2's key set is closed and openSeq
   * is not in it). The entry is removed later, by the drainer, if and when
   * that publish is accepted.
   */
  enqueueRecoveryIfOpen(family: string, build: (clears: string) => OpsPublishInput): void {
    const entry = this.open.get(family);
    if (!entry) return;
    this.enqueue({ kind: "recovery", input: build(entry.dedupeKey), family, openSeq: entry.openSeq });
  }

  countIdOmitted(): void {
    this.counters.idOmitted += 1;
  }

  private enqueue(job: Job): void {
    if (this.stopping) {
      // D10: observations arriving after `stopping` is set are refused. That
      // window is NOT instantaneous — `stop()` sets the latch and then drains
      // for up to SHUTDOWN_DRAIN_MS while turns are still running — so this
      // arm can swallow real failures, and swallowing them with no counter is
      // the one shutdown loss `drainDropped` did not see.
      //
      // COUNTED ON `drainDropped` rather than on a counter of its own: from
      // the only point of view that acts on it, both are "shutdown lost N ops
      // observations"; the two cannot overlap in time (this arm is live only
      // once the latch is set, the deadline arm runs once, after); and a
      // second field would split one shutdown-loss number across two entries
      // in `getSnapshot()` that no reader distinguishes. No log line: a
      // shutdown storm here would be the same flood the overflow latch exists
      // to prevent, and `stop()` already logs the drop it can see.
      this.counters.drainDropped += 1;
      return;
    }
    if (this.queue.length >= PUBLISH_QUEUE_DEPTH) {
      // D9: drop the OLDEST. A full queue means a storm, and the newest
      // failures are the ones a responder needs.
      //
      // The COUNTER moves on every dropped job — unchanged, and the only
      // per-drop work here. The LOG LINE is once per overflow EPISODE
      // (`overflowWarned`), because the per-drop shape of this same line would
      // be a thousand-line burst in the one situation the engine is already
      // struggling. C13: counts and a code-resident bound only. Nothing names
      // the dropped job — its tool, key, reason and subject are all
      // operator-adjacent text of unbounded shape, and none of it is needed to
      // act on "the ops queue overflowed".
      this.queue.shift();
      this.counters.queueOverflow += 1;
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        log.warn("Ops publish queue full — dropping the oldest job on each arrival until it drains", {
          depth: PUBLISH_QUEUE_DEPTH,
          totalDropped: this.counters.queueOverflow,
        });
      }
    }
    this.queue.push(job);
    void this.drain();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Drain side — the SINGLE writer of the open-condition map (D8).
  // ─────────────────────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        try {
          await this.runJob(job);
        } catch (err) {
          // C14/D10 invariant (a): logged and counted, NEVER published.
          this.counters.publishFaults += 1;
          log.warn("Ops publish job failed", { kind: job.kind, error: String(err) });
        }
      }
      // THE RE-ARM POINT, and deliberately the only one. Reaching here means
      // the `while` condition is false — the queue is empty as a matter of
      // control flow rather than of a sampled read — so the drainer has
      // absorbed every job the storm produced and the next overflow is a NEW
      // episode. A low-water mark (say, half depth) would re-arm mid-storm and
      // emit a line per oscillation across it, which is the flood again; a
      // timer would need its own constant and would fire while the storm was
      // still storming. Full drain needs neither: per D9's own sizing, 1000
      // jobs is seconds of Mongo work, so two lines can never be closer
      // together than the time it takes to clear a full queue.
      //
      // The two writers of this latch cannot race: `enqueue` sets it only at
      // depth PUBLISH_QUEUE_DEPTH and this clears it only at depth 0, and both
      // run on the one event loop. Skipping this line (only reachable if
      // something outside the inner try/catch throws — nothing here can) leaves
      // the latch set, i.e. errs toward silence rather than toward a flood.
      this.overflowWarned = false;
    } finally {
      this.draining = false;
    }
  }

  private async runJob(job: Job): Promise<void> {
    if (job.kind === "recovery") {
      // D8: the pre-publish test is IDENTITY, evaluated before any I/O.
      // Membership (`has(family)`) is NOT sufficient and specifying one is
      // itself a defect: it passes for an entry belonging to a LATER open
      // interval, and the stale job then publishes a clearing fact for a dead
      // epoch, deletes the live interval's map entry (permanent silence — the
      // exact defect accept-time removal was fixing) and leaves a clearing
      // fact more recent than the latest failure, so the next plain repeat
      // advances `generation` — the C18 flood, reached with no recovery.
      const entry = this.open.get(job.family);
      if (!entry) {
        // Benign burst case: a sibling recovery for the same open interval
        // already closed it. N successes in one drain window still yield
        // exactly one tool-recovered.
        this.counters.recoveryCoalesced += 1;
        return;
      }
      if (entry.openSeq !== job.openSeq) {
        // The tool re-failed and re-opened before this recovery could be
        // recorded — a signal about the TOOL, not about the queue, which is
        // why it is counted separately. The job's observation is a GENUINE
        // recovery of the live interval (FIFO enqueue + a serial drainer means
        // the reopening failure was observed BEFORE this job's success); what
        // is stale is only the `clears` key it carries. Re-targeting to
        // entry.dedupeKey was considered and declined (D8): `clears` is a
        // fixed statement made by the observer that read the map, and a
        // drainer rewriting it would publish an assertion no observer made.
        // Cost: one delayed boundary, self-healing at the next clean recovery.
        this.counters.recoverySuperseded += 1;
        return;
      }
      const accepted = await this.accept(job.input);
      // D8: removal at ACCEPT, by the drainer, only after a successful
      // publish. Because the drainer is serial and is the map's only writer,
      // nothing can replace the entry between the identity check above and
      // this removal, so it is unambiguously the entry just verified.
      // (Remove-at-enqueue was considered and declined: it makes the removal a
      // promise the queue may not keep — a recovery lost to overflow or a
      // publish fault would leave no clearing fact — and it puts a second
      // writer on the map.)
      if (accepted) this.open.delete(job.family);
      return;
    }

    const stored = await this.accept(job.input);
    if (!stored) return;
    // D8: entry CREATION on an accepted failure insert for a family holding no
    // live entry. A repeat that finds the family already present LEAVES THE
    // ENTRY UNTOUCHED — same openSeq, same dedupeKey, same firstFailureAt —
    // because a repeat is the same open interval under D2's own rule.
    const family = familyOf(job.input);
    if (!this.open.has(family)) {
      if (this.open.size >= OPEN_CONDITION_MAP_CAP) {
        const oldest = this.open.keys().next();
        if (!oldest.done) this.open.delete(oldest.value);
      }
      this.open.set(family, {
        openSeq: this.nextOpenSeq++,
        dedupeKey: stored.dedupeKey,
        firstFailureAt: stored.publishedAt,
      });
    }
  }

  /**
   * D9's eight-step accept path, in order. Returns the stored document on
   * success and `undefined` on rejection.
   *
   * Nothing here runs on the turn's await path.
   */
  private async accept(input: OpsPublishInput): Promise<OpsEvent | undefined> {
    // 1. Registry row, FROM THE IN-MEMORY MAP init() loaded. Unknown OR
    //    disabled ⇒ reject + count (C5). Never coerced to a generic reason.
    const loaded = this.reasons.get(`${input.producer}:${input.reasonId}`);
    if (!loaded || !loaded.row.enabled) return this.reject("unknown-or-disabled-reason", input);

    // 2. Bounds. subject.kind / evidence[].kind are tokens; subject.id and
    //    evidence[].id are 1..200. Over-length is REJECTED, never truncated:
    //    truncation would silently merge two tools into one condition, the one
    //    failure the tool subject exists to avoid.
    if (!isOpsToken(input.producer) || !isOpsToken(input.reasonId)) return this.reject("bad-token", input);
    if (!isOpsToken(input.subject.kind)) return this.reject("bad-subject-kind", input);
    if (input.subject.id.length < 1 || input.subject.id.length > OPS_ID_MAX_LENGTH) {
      return this.reject("subject-id-bounds", input);
    }
    if (input.evidence.length > OPS_EVIDENCE_MAX) return this.reject("evidence-count", input);
    for (const ref of input.evidence) {
      if (!isOpsToken(ref.kind)) return this.reject("evidence-kind", input);
      if (ref.id.length < 1 || ref.id.length > OPS_ID_MAX_LENGTH) return this.reject("evidence-id-bounds", input);
    }
    const detail = loaded.detailSchema.safeParse(input.detail);
    if (!detail.success) return this.reject("detail-schema", input);

    // 3. class/retry are STAMPED FROM THE ROW. The observe API has no
    //    parameter that could supply them, so C4 holds structurally.
    const { class: cls, retry } = loaded.row;

    // 4. `clears` legality + clearsFamily. Neither needs THIS event's
    //    generation: the legality check reads the registry row, and
    //    clearsFamily strips a generation rather than supplying one — which
    //    is why this step precedes step 5.
    let clearsFamily: string | undefined;
    if (input.clears !== undefined) {
      // `clears` is stored verbatim, and `clearsFamily` is derived from it and
      // INDEXED — yet step 2 bounds only subject/detail/evidence, and the
      // membership test below reads just one component. Its own two bounds
      // therefore live here.
      //
      // LENGTH: `OPS_CLEARS_MAX_LENGTH`, which is derived from the key's own
      // grammar and deliberately loose (see ids.ts — a tight bound would
      // reject a legitimate FOREIGN key, the opposite of the point). Rejected,
      // never truncated: a truncated key names a different family.
      if (input.clears.length > OPS_CLEARS_MAX_LENGTH) return this.reject("clears-bounds", input);
      // OWNERSHIP: a clearing fact may only clear a family of its OWN
      // producer. Without this, one producer's clearing reason could publish a
      // clearing fact — and a `clearsFamily` index entry the epoch resolver
      // reads — against another producer's family, closing a condition it has
      // no standing to close and advancing that producer's generations. The
      // leading component of a dedupeKey IS the producer (and a producer is
      // token-bounded, so colon-free), which is why this reads a component
      // rather than a prefix.
      if (input.clears.split(":", 1)[0] !== input.producer) return this.reject("clears-producer", input);
      // Unreachable from this producer's own capture points — `observe.ts`
      // always passes a dedupeKey THIS publisher minted for THIS producer —
      // but the accept path is the fail-closed gate AC16 deliberately drives
      // with a foreign producer's rows.
      const declared = loaded.row.clearsReasonIds ?? [];
      const clearedReason = reasonIdOfDedupeKey(input.clears);
      if (declared.length === 0 || clearedReason === undefined || !declared.includes(clearedReason)) {
        return this.reject("illegal-clears", input); // C19
      }
      clearsFamily = stripGeneration(input.clears);
    }

    // 5. generation — ON A FAILURE PUBLISH ONLY. D8's resolver is defined "on
    //    failure" and its two reads exist to find a clearing fact for a
    //    CONDITION family; running them for a recovery would be two reads
    //    whose answer is never used. A clearing publish carries generation 0
    //    always: this producer declares no advance rule for its clearing
    //    reason, and D2's rule for a reason with none is that it holds at 0.
    //
    //    The gate `input.clears === undefined` is a PROXY for D9's words ("on
    //    a failure publish"), not a restatement. For this producer they are
    //    exactly equivalent — only `tool-recovered` carries `clears` — and
    //    step 4 has already refused any `clears` outside the row's own
    //    `clearsReasonIds`, so a row reaching here with `clears` set is
    //    provably a registered clearing publish. Keying off
    //    `loaded.row.clearsReasonIds` instead reads the REASON rather than the
    //    event and is the right form for a future producer whose reason may or
    //    may not clear per publish. Noted so the equivalence is checked, not
    //    assumed.
    const family = familyOf(input);
    const generation = input.clears === undefined ? await this.resolveGeneration(family, input) : 0;
    // THEN, and only then, the key — D2's formula embeds the epoch, so the key
    // cannot exist before the epoch does. Deriving it earlier would stamp an
    // unresolved generation onto the event, onto D8's map entry, and onto
    // every clearing fact that later republishes it as `clears`.
    const dedupeKey = `${family}:${generation}`;

    // 6. Match — pure, I/O-free, against the LOADED set.
    const draft = {
      producer: input.producer,
      reasonId: input.reasonId,
      class: cls,
      retry,
      waiting: input.waiting,
      subject: input.subject,
    };
    const matchedSubscriptionIds = evaluateMatches(draft, this.subscriptions);

    // 7. Built FIELD BY FIELD, every composite value REBUILT as a literal
    //    rather than stored by reference. `subject` and `evidence` are
    //    caller-supplied objects: passing them through would carry any extra
    //    property the caller hung on them into the document — silently, past
    //    the allow-list and past AC1's key-set assertion, which inspects the
    //    top level only. D9 step 2 requires `evidence` validated "as
    //    {kind, id} references only"; this is the C13 surface. Unreachable
    //    from this producer's own observe* calls, but the accept path is the
    //    fail-closed gate AC16 drives with a FOREIGN producer's row.
    //    (`detail` is already rebuilt by zod's strict parse, same reason.)
    const doc: OpsEvent = {
      schemaVersion: OPS_SCHEMA_VERSION,
      publishedAt: new Date(),
      producer: input.producer,
      reasonId: input.reasonId,
      class: cls,
      retry,
      waiting: input.waiting,
      subject: { kind: input.subject.kind, id: input.subject.id },
      generation,
      dedupeKey,
      detail: detail.data as OpsEvent["detail"],
      // ALWAYS present, [] when empty — never omitted.
      evidence: input.evidence.map((ref) => ({ kind: ref.kind, id: ref.id })),
      matchedSubscriptions: matchedSubscriptionIds.length,
      matchedSubscriptionIds,
      ...(input.clears !== undefined ? { clears: input.clears, clearsFamily } : {}),
    };

    // 8. One immutable insert. Zero matches is a stored, queryable fact and
    //    never a failure (C2, C3). Nothing re-evaluates the match afterwards.
    await this.store.events.insertOne(doc);
    this.counters.published += 1;
    return doc;
  }

  private reject(reason: string, input: OpsPublishInput): undefined {
    this.counters.rejected += 1;
    // Reason and identifiers only — never the detail values that failed, and
    // never `subject.id`.
    //
    // CLIPPED (C13): two of these arms are reached PRECISELY BECAUSE the value
    // printed here failed its own bound — `bad-token` names producer/reasonId,
    // `bad-subject-kind` names subject.kind — so logging them raw would make
    // this the one unbounded log line in the producer. Defensive at this
    // diff's own capture points, where all three are module constants, and not
    // defensive at all on the fail-closed path AC16 drives with foreign input.
    log.warn("Ops publish rejected", {
      reason,
      producer: clipForLog(input.producer),
      reasonId: clipForLog(input.reasonId),
      subjectKind: clipForLog(input.subject?.kind),
    });
    return undefined;
  }

  /**
   * D8: two bounded indexed reads over the family — the latest event under
   * this reasonId, and the latest event whose clearsFamily equals the family.
   *
   * "Latest" and "more recent" are the COMPOUND order (publishedAt, _id),
   * never publishedAt alone: publishedAt is a single server clock at
   * millisecond resolution and the serial drainer can stamp a failure and a
   * clearing event inside the same millisecond under exactly the storm this
   * queue exists to absorb. On an exact tie "more recent" would be undefined,
   * making generation advancement nondeterministic — a live C18 hazard. The
   * driver mints _id client-side, in this process, with a per-process counter
   * that increments within a millisecond, and the drainer is the single
   * writer, so insertion order IS publish order and _id orders same-ms
   * siblings correctly. Both epoch-read indexes carry `_id: -1` last so each
   * sort is index-covered.
   */
  private async resolveGeneration(family: string, input: OpsPublishInput): Promise<number> {
    try {
      const [latestCondition, latestClearing] = await Promise.all([
        this.store.events.findOne(
          {
            producer: input.producer,
            "subject.kind": input.subject.kind,
            "subject.id": input.subject.id,
            reasonId: input.reasonId,
          },
          { sort: { publishedAt: -1, _id: -1 } },
        ),
        this.store.events.findOne({ clearsFamily: family }, { sort: { publishedAt: -1, _id: -1 } }),
      ]);
      if (!latestCondition) return 0;
      if (latestClearing && isMoreRecent(latestClearing, latestCondition)) return latestCondition.generation + 1;
      return latestCondition.generation;
    } catch (err) {
      // D2/D10: the publish still proceeds, contained, at the producer's last
      // in-process value for that family — READ OFF THE OPEN-CONDITION ENTRY,
      // never out of a second structure. A separate per-family fallback map
      // would be a second unbounded structure needing its own cap and could
      // evict independently of the live entry and hand back a generation the
      // entry contradicts. The entry's dedupeKey embeds the generation of the
      // interval it opened, so the fallback is that suffix, and 0 when the
      // family holds no entry (a first failure, an evicted entry, or a family
      // reopening after a recovery — D2's named residual, a bounded
      // mis-attachment, never a lost fact).
      this.counters.epochResolveFaults += 1;
      log.warn("Ops epoch resolve faulted — falling back to the open-condition entry", { error: String(err) });
      const entry = this.open.get(family);
      return entry ? generationOfDedupeKey(entry.dedupeKey) : 0;
    }
  }
}

/** D2's family: the dedupeKey without its generation component. */
export function familyOf(input: Pick<OpsPublishInput, "producer" | "subject" | "reasonId">): string {
  return `${input.producer}:${input.subject.kind}:${input.subject.id}:${input.reasonId}`;
}

/**
 * RIGHT-ANCHORED, and safe for ANY subject.id including a colon-bearing one:
 * `generation` is a decimal integer, colon-free by its own bounds, so
 * `lastIndexOf(":")` always finds the separator before it and the family is
 * components 0..n-2 whatever n is (`subject.id = "a:b"` ⇒
 * `acme:tool:a:b:tool-failed` — a neutral producer on purpose; this file must
 * contain no producer literal, AC16). Do NOT "harden" this into a bounded
 * split taking the first three components from the left — the family is not
 * components 0..2, so that change is a regression, not a fix.
 */
export function stripGeneration(dedupeKey: string): string {
  return dedupeKey.slice(0, dedupeKey.lastIndexOf(":"));
}

export function generationOfDedupeKey(dedupeKey: string): number {
  const n = Number(dedupeKey.slice(dedupeKey.lastIndexOf(":") + 1));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Also RIGHT-ANCHORED, same reason: `reasonId` is an OPS_TOKEN_RE token and
 * `generation` a decimal integer, both colon-free by their own bounds, so the
 * second component from the right is the reasonId regardless of how many
 * colons `subject.id` contributes. `>= 5` is a MINIMUM-arity check on the
 * formula, not an exact one — more parts still resolve correctly.
 */
export function reasonIdOfDedupeKey(dedupeKey: string): string | undefined {
  const parts = dedupeKey.split(":");
  return parts.length >= 5 ? parts[parts.length - 2] : undefined;
}

function isMoreRecent(a: OpsEvent, b: OpsEvent): boolean {
  const at = a.publishedAt.getTime();
  const bt = b.publishedAt.getTime();
  if (at !== bt) return at > bt;
  return String(a._id) > String(b._id);
}
