# KPR-454 plan — chunk 3: the publisher

Implements design **D8**, **D9**, **D10**. One task, one commit. This is the ticket's centre of gravity: the accept path, the epoch resolver, the open-condition map with its `openSeq` identity, the bounded queue and its serial drainer, the counters, and the module-global singleton.

Read D8 in full before writing `drain()`. Three things in it are decided against a named alternative and must not be re-derived at the keyboard: **removal happens at accept, not at enqueue**; the drainer's pre-publish test is `entry?.openSeq === job.openSeq` and **membership is not sufficient**; and a superseded recovery is **dropped, not re-targeted**.

---

### Task 4: The `OpsPublisher`

**Files:**
- Create: `src/ops/store.ts`
- Create: `src/ops/publisher.ts`
- Create: `src/ops/publisher-singleton.ts`
- Create: `src/ops/observe.ts`
- Create: `src/ops/testing/fake-db.ts`
- Create: `src/ops/publisher.integration.test.ts`

- [ ] **Step 1:** Create `src/ops/testing/fake-db.ts` — the harness, first, because everything after this step is tested against it.

Requirements (the Testing Contract's Harness Requirements, restated as an interface):

- Collections keyed by name; documents held in insertion order in an array.
- `insertOne(doc)` — mints a client-side `ObjectId` if `_id` is absent (this matters: D8's `(publishedAt, _id)` tie-break rests on the driver's per-process incrementing counter, so the double must mint monotonically-increasing ids in insertion order, exactly as the real driver does).
- `findOne(filter, { sort })` — supports equality on nested paths (`"subject.kind"`), and `sort` on `{ publishedAt: -1, _id: -1 }`.
- `find(filter).sort(s).limit(n).toArray()`.
- `updateOne(filter, { $set, $setOnInsert }, { upsert })`.
- `createIndex(spec, options)` — resolves by default; programmable to reject with a supplied error (needed for the TTL-conflict and index-fault cases).
- A `failNext` / `failAll` switch per operation, so an insert fault, a read fault and a registry-upsert fault are each drivable independently.
- A **fully-throwing** variant, `throwingDb()`, whose every property access throws — used to prove the match evaluator performs no I/O (AC5) and that a dead database cannot alter a turn (AC8).

Follow `src/obligations/testing/fake-db.ts` and `src/db/db-identity.integration.test.ts` for conventions; do not introduce a new mocking library.

- [ ] **Step 2:** Create `src/ops/store.ts` — collections, indexes, registry upsert + read-back, subscription load.

```typescript
import type { Collection, Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import {
  OPS_EVENTS_COLLECTION,
  OPS_REASONS_COLLECTION,
  OPS_SUBSCRIPTIONS_COLLECTION,
  type OpsEvent,
  type OpsReason,
  type OpsSubscription,
} from "./types.js";
import { assertReasonTableLegal, compileDetailSchema } from "./reasons.js";
import type { z } from "zod";

const log = createLogger("ops-store");

export interface LoadedReason {
  row: OpsReason;
  detailSchema: z.ZodType<Record<string, unknown>>;
}

export class OpsStore {
  readonly events: Collection<OpsEvent>;
  readonly subscriptions: Collection<OpsSubscription>;
  readonly reasons: Collection<OpsReason & { _id: string }>;

  constructor(
    private readonly db: Db,
    private readonly retentionDays: number,
  ) {
    this.events = db.collection<OpsEvent>(OPS_EVENTS_COLLECTION);
    this.subscriptions = db.collection<OpsSubscription>(OPS_SUBSCRIPTIONS_COLLECTION);
    this.reasons = db.collection<OpsReason & { _id: string }>(OPS_REASONS_COLLECTION);
  }

  /**
   * D10: index creation is INDIVIDUALLY CONTAINED and a fault does NOT
   * prevent the publisher from being set. Every index here is on the
   * MeetingScribe side of the engine's own line (index.ts:456) rather than
   * the MeetingWorkerPool side: the two epoch-read indexes and the cursor
   * index are performance (a collection scan returns the same answer), the
   * TTL index is housekeeping, and ops_reasons uniqueness is already
   * structural because _id is "<producer>:<reasonId>" — the unique index
   * restates it rather than establishing it.
   *
   * Returns the number of index failures, for the counter.
   */
  async ensureIndexes(): Promise<number> {
    let failures = 0;
    const create = async (label: string, run: () => Promise<unknown>, remedy?: string) => {
      try {
        await run();
      } catch (err) {
        failures += 1;
        log.warn("ops index creation failed — continuing without it", {
          index: label,
          error: String(err),
          ...(remedy ? { remedy } : {}),
        });
      }
    };

    // D8's condition-side epoch read. `_id` is a KEY rather than an
    // afterthought: the resolver's comparison is the compound
    // (publishedAt, _id) order, which this index then COVERS instead of
    // forcing an in-memory sort.
    await create("ops_events.condition-epoch", () =>
      this.events.createIndex({ producer: 1, "subject.kind": 1, "subject.id": 1, reasonId: 1, publishedAt: -1, _id: -1 }),
    );
    // D8's clearing-side epoch read, in the same order the resolver compares.
    await create("ops_events.clearing-epoch", () =>
      this.events.createIndex({ clearsFamily: 1, publishedAt: -1, _id: -1 }, { sparse: true }),
    );
    // D2: NOT unique — the log appends every publish.
    await create("ops_events.dedupe", () => this.events.createIndex({ dedupeKey: 1, publishedAt: -1 }));
    // D12's cursor order. Created here because D12 assigns ops_events and its
    // indexes to this producer.
    //
    // ⚠ DO NOT CONSOLIDATE this with the TTL index below. They share a prefix,
    // which reliably invites a "the second is redundant" cleanup — it is not.
    // A TTL index must be SINGLE-FIELD (MongoDB refuses expireAfterSeconds on
    // a compound index), so the cursor index cannot carry the TTL; and
    // dropping the cursor index in favour of the TTL one costs D12's reader
    // its covered (publishedAt, _id) sort. Neither is a subset of the other in
    // any sense that matters.
    await create("ops_events.cursor", () => this.events.createIndex({ publishedAt: 1, _id: 1 }));
    // D9: aligned with existing activity-history retention.
    //
    // This is the index-fault case that actually happens: createIndex throws
    // IndexOptionsConflict when the index already exists with a DIFFERENT
    // expireAfterSeconds — i.e. on the first boot after an operator changes
    // config.activity.retentionDays. A retention change must NOT silently
    // switch off failure recording, so this is contained and counted like the
    // rest, and the warning names the remedy.
    await create(
      "ops_events.ttl",
      () => this.events.createIndex({ publishedAt: 1 }, { expireAfterSeconds: this.retentionDays * 86_400 }),
      `retention changed? drop the ops_events publishedAt TTL index (or collMod it to ${this.retentionDays * 86_400}s) and restart`,
    );
    await create("ops_subscriptions.enabled", () => this.subscriptions.createIndex({ enabled: 1 }));
    await create("ops_reasons.unique", () => this.reasons.createIndex({ producer: 1, reasonId: 1 }, { unique: true }));
    return failures;
  }

  /**
   * D5: upsert the code-resident rows, writing every field EXCEPT `enabled`,
   * which is $setOnInsert — so an operator who disabled a reason keeps it
   * disabled across upgrades, and a code change to a template or an
   * allow-list still lands. `enabled: false` + restart is this ticket's
   * entire kill switch.
   *
   * The array's ORDER is contract (reasons.ts) — clearing reason first.
   * A throw here propagates: D10 requires a registry fault to leave the
   * publisher UNSET, because a wired-but-registryless publisher would spend
   * the rejection counter — D9's mis-integrated-producer signal — on what is
   * actually a Mongo outage.
   */
  async upsertReasons(rows: readonly OpsReason[]): Promise<void> {
    assertReasonTableLegal(rows); // pure precondition, no I/O — throws only in development
    for (const row of rows) {
      const { enabled, ...rest } = row;
      await this.reasons.updateOne(
        { _id: `${row.producer}:${row.reasonId}` },
        { $set: rest, $setOnInsert: { enabled } },
        { upsert: true },
      );
    }
  }

  /**
   * D5: the accept path resolves rows from THE COLLECTION, never from the
   * code-resident table. That is what makes the kill switch work, and what
   * lets a row this code does not contain — a second reason added later as
   * data, or an out-of-engine producer's (D4, AC16) — take effect at the next
   * boot with no engine change. There is NO periodic reload: the map is built
   * once, in init(), so restart is the lever.
   */
  async loadReasons(): Promise<Map<string, LoadedReason>> {
    const map = new Map<string, LoadedReason>();
    for (const row of await this.reasons.find({}).toArray()) {
      map.set(`${row.producer}:${row.reasonId}`, { row, detailSchema: compileDetailSchema(row.detailKeys) });
    }
    return map;
  }

  /** D9: refreshed on a 60 s timer and on SIGUSR1. A fault leaves the previous set in place. */
  async loadSubscriptions(): Promise<OpsSubscription[]> {
    return this.subscriptions.find({ enabled: true }).toArray();
  }
}
```

- [ ] **Step 3:** Create `src/ops/publisher.ts`.

The code below is the whole class. Read the inline comments as normative — several of them record a decision against a named alternative.

```typescript
import type { Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { OpsStore, type LoadedReason } from "./store.js";
import { evaluateMatches } from "./match.js";
import { HIVE_RUNTIME_REASONS } from "./reasons.js";
import {
  OPS_SCHEMA_VERSION,
  type OpsEvent,
  type OpsPublishInput,
  type OpsSubscription,
} from "./types.js";
import { OPS_EVIDENCE_MAX, OPS_ID_MAX_LENGTH, isOpsToken } from "./ids.js";

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
 * this is a leak bound rather than an operating limit. ~150 bytes/entry ⇒
 * ~300 KB at full cap. Breach evicts oldest-first and costs one delayed epoch
 * boundary — the restart residual's exact shape and bound.
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

interface OpenCondition {
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
  private reloadTimer?: ReturnType<typeof setInterval>;
  private nextOpenSeq = 1;
  private readonly counters: OpsPublisherCounters = {
    published: 0, rejected: 0, publishFaults: 0, queueOverflow: 0, idOmitted: 0,
    recoveryCoalesced: 0, recoverySuperseded: 0, epochResolveFaults: 0,
    indexFailures: 0, subscriptionReloadFaults: 0, drainDropped: 0,
  };

  constructor(db: Db, retentionDays: number) {
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
    this.reasons = await this.store.loadReasons();
    await this.reloadSubscriptions();
    // unref()'d: an ops-diagnostics timer must never be the thing holding the
    // process open (the outage-replay-processor.ts:44 precedent).
    this.reloadTimer = setInterval(() => void this.reloadSubscriptions(), SUBSCRIPTION_RELOAD_MS);
    this.reloadTimer.unref();
    log.info("Ops publisher initialized", {
      reasons: this.reasons.size,
      subscriptions: this.subscriptions.length,
      indexFailures: this.counters.indexFailures,
    });
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
    if (this.stopping) return;
    if (this.queue.length >= PUBLISH_QUEUE_DEPTH) {
      // D9: drop the OLDEST. A full queue means a storm, and the newest
      // failures are the ones a responder needs.
      this.queue.shift();
      this.counters.queueOverflow += 1;
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
      this.open.set(family, { openSeq: this.nextOpenSeq++, dedupeKey: stored.dedupeKey, firstFailureAt: stored.publishedAt });
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
    const family = familyOf(input);
    const generation = input.clears === undefined ? await this.resolveGeneration(family, input) : 0;
    // THEN, and only then, the key — D2's formula embeds the epoch, so the key
    // cannot exist before the epoch does. Deriving it earlier would stamp an
    // unresolved generation onto the event, onto D8's map entry, and onto
    // every clearing fact that later republishes it as `clears`.
    const dedupeKey = `${family}:${generation}`;

    // 6. Match — pure, I/O-free, against the LOADED set.
    const draft = { producer: input.producer, reasonId: input.reasonId, class: cls, retry, waiting: input.waiting, subject: input.subject };
    const matchedSubscriptionIds = evaluateMatches(draft, this.subscriptions);

    // 7. The two server-owned envelope fields.
    const doc: OpsEvent = {
      schemaVersion: OPS_SCHEMA_VERSION,
      publishedAt: new Date(),
      producer: input.producer,
      reasonId: input.reasonId,
      class: cls,
      retry,
      waiting: input.waiting,
      subject: input.subject,
      generation,
      dedupeKey,
      detail: detail.data as OpsEvent["detail"],
      evidence: input.evidence, // ALWAYS present, [] when empty — never omitted
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
    // Reason and identifiers only — never the detail values that failed.
    log.warn("Ops publish rejected", { reason, producer: input.producer, reasonId: input.reasonId, subjectKind: input.subject.kind });
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
          { producer: input.producer, "subject.kind": input.subject.kind, "subject.id": input.subject.id, reasonId: input.reasonId },
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

export function stripGeneration(dedupeKey: string): string {
  return dedupeKey.slice(0, dedupeKey.lastIndexOf(":"));
}

export function generationOfDedupeKey(dedupeKey: string): number {
  const n = Number(dedupeKey.slice(dedupeKey.lastIndexOf(":") + 1));
  return Number.isFinite(n) ? n : 0;
}

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
```

⚠ **`reasonIdOfDedupeKey` and `stripGeneration` need a colon-safety note in review.** `subject.id` for this producer is `mcp__<server>__<tool>` or a builtin name, neither of which contains a colon, so splitting on `:` is unambiguous here. That is a property of *this* producer's subject ids, not of the formula. If a later producer mints colon-bearing subject ids, both helpers must move to a bounded split (first three components from the left, last one from the right) rather than a naive `split(":")`. Record this as a code comment on both helpers.

- [ ] **Step 4:** Create `src/ops/publisher-singleton.ts`.

```typescript
import type { OpsPublisher } from "./publisher.js";

/**
 * D10: a module-global singleton, the provider-registry.ts precedent — the
 * consumer (the capture points) is module-scope, so the publisher must be
 * too. UNSET ⇒ every observe call is a no-op, which is what keeps the
 * pre-wiring boot window and every bare test construction correct BY
 * CONSTRUCTION rather than by ordering luck.
 */
let current: OpsPublisher | undefined;

export function setOpsPublisher(publisher: OpsPublisher | undefined): void {
  current = publisher;
}

export function opsPublisher(): OpsPublisher | undefined {
  return current;
}

export function __resetOpsPublisherForTests(): void {
  current = undefined;
}
```

- [ ] **Step 5:** Create `src/ops/observe.ts` — the capture-point API. This is what chunk 4 calls.

```typescript
import { createLogger } from "../logging/logger.js";
import { waitingFor } from "../outage/outage-notices.js";
import { classifyToolError, type ToolErrorSignals } from "./error-tokens.js";
import { admissibleIdOrUndefined } from "./ids.js";
import { opsPublisher } from "./publisher-singleton.js";
import { familyOf } from "./publisher.js";
import { HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED, REASON_TOOL_RECOVERED } from "./reasons.js";
import type { OpsDetail } from "./types.js";

const log = createLogger("ops-observe");

export type CaptureLane = "claude" | "laneB";

export interface ToolFailureObservation {
  /** The canonical tool name — mcp__<server>__<tool> or a builtin, BEFORE any provider-side sanitization. */
  tool: string;
  error: string;
  lane: CaptureLane;
  agentId?: string;
  workItemId?: string;
  threadId?: string;
  durationMs?: number;
  signals?: ToolErrorSignals;
}

/**
 * SYNCHRONOUS, NON-THROWING, returns void (D9). It enqueues one job and
 * returns; the turn never awaits it and never sees a fault. Chosen over an
 * unawaited promise on four counts: the failure path performs two indexed
 * reads and a write, which under a storm would open unbounded concurrent
 * Mongo work from inside a turn; the drainer serializes per-family epoch
 * resolution against the open-condition map; a bounded queue has a drop
 * policy and a counter where an unawaited promise has neither; and shutdown
 * has something to drain.
 *
 * C15: every call is wrapped so no throw escapes to the tool path. The Lane B
 * site sits inside the one method whose header promise is "structurally
 * cannot throw", and the Claude-lane sites sit in hook callbacks the SDK
 * awaits mid-turn.
 */
export function observeToolFailure(obs: ToolFailureObservation): void {
  try {
    const publisher = opsPublisher();
    if (!publisher) return;

    // D6: the capture-point admissibility bound. A value that fails it is
    // OMITTED, never rejected — the check lives HERE and not in the accept
    // path so the two mechanisms stay separate and each stays honest.
    const workItemId = admissibleIdOrUndefined(obs.workItemId);
    const threadId = admissibleIdOrUndefined(obs.threadId);
    if ((obs.workItemId !== undefined && workItemId === undefined) ||
        (obs.threadId !== undefined && threadId === undefined)) {
      publisher.countIdOmitted();
    }

    const detail: OpsDetail = {
      tool: obs.tool,
      // The error text is classified HERE and DISCARDED. Nothing derived from
      // it is stored (C13).
      errorSig: classifyToolError(obs.error, obs.signals),
      lane: obs.lane,
      ...(obs.agentId !== undefined ? { agentId: obs.agentId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(workItemId !== undefined ? { workItemId } : {}),
      ...(obs.durationMs !== undefined ? { durationMs: obs.durationMs } : {}),
    };

    publisher.enqueueFailure({
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_FAILED,
      // D7. Derived from whatever id the runtime holds — NOT from the
      // admissibility-filtered one. That bound governs storage; re-classifying
      // an honest id whose only defect is an unstorable character would buy
      // nothing against policyFor's existing client-supplied-id caveat.
      waiting: waitingFor(obs.workItemId),
      subject: { kind: "tool", id: obs.tool },
      detail,
      // D6: this producer's ENTIRE `kind` vocabulary is "workItem". `[]` when
      // the id is absent or inadmissible — the detached worker/scribe case and
      // the untrusted-id case deliberately land in the same shape. threadId is
      // NOT mirrored here: it is a filterable attribute of the condition and
      // belongs in detail, whereas evidence points at the record a responder
      // would open next.
      evidence: workItemId !== undefined ? [{ kind: "workItem", id: workItemId }] : [],
    });
  } catch (err) {
    // Never reaches the turn. Not published (D10 invariant (a)).
    log.warn("observeToolFailure threw — contained", { error: String(err) });
  }
}

/** The recovery half. Two arguments and no others — the same closed pair on both lanes. */
export function observeToolSuccess(obs: { tool: string; lane: CaptureLane }): void {
  try {
    const publisher = opsPublisher();
    if (!publisher) return;
    const family = familyOf({
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_FAILED,
      subject: { kind: "tool", id: obs.tool },
    });
    publisher.enqueueRecoveryIfOpen(family, (clears) => ({
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_RECOVERED,
      // D8: a FIXED value, not a derived one. The succeeding turn is an
      // arbitrary later turn with nothing to do with the turn that failed, so
      // waitingFor would attribute a stranger's waiter to a recovery — and
      // worse, it would let an `informational` recovery be selected by a
      // subscription filtering waiting: "human-now". `nobody` is also simply
      // true: a recovery blocks no one.
      waiting: "nobody",
      subject: { kind: "tool", id: obs.tool },
      detail: { tool: obs.tool, lane: obs.lane },
      evidence: [], // always — the succeeding turn's work item is a stranger's record
      clears,
    }));
  } catch (err) {
    log.warn("observeToolSuccess threw — contained", { error: String(err) });
  }
}
```

- [ ] **Step 6:** Write `src/ops/publisher.integration.test.ts` against the fake db.

Minimum assertions (the acceptance suite in chunk 5 adds the AC-numbered cases; these are the mechanism-level ones):

- `init()` upserts both rows in the shipped order and does **not** overwrite an operator-set `enabled: false` on a second `init()`.
- `init()` with every `createIndex` rejecting still completes and `getSnapshot().indexFailures` equals the number of indexes.
- `init()` with the registry upsert rejecting **throws** (so `index.ts` leaves the publisher unset).
- A failure publish stores exactly one document with `generation: 0`, `dedupeKey` = `hive-runtime:tool:<tool>:tool-failed:0`, and creates one open-condition entry.
- A repeat leaves `generation` and the entry untouched and appends a second document.
- A success with no open condition performs **no** database access (assert against the throwing-db variant).
- A success with an open condition publishes one `tool-recovered` with `clears`, `clearsFamily`, `waiting: "nobody"`, `generation: 0`, and removes the entry.
- The epoch resolver's `(publishedAt, _id)` tie-break: two documents with the identical `publishedAt`, the clearing one inserted second, resolves to +1.
- A resolver fault falls back to the open-condition entry's generation, and to `0` with no entry.
- Queue overflow drops the **oldest** and increments `queueOverflow`.
- `stop()` clears the timer, drains within the bound, and drops+counts a queue it cannot drain.
- The map cap evicts oldest-first at `OPEN_CONDITION_MAP_CAP`.

- [ ] **Step 7:** Run the TTL index-conflict verification (`⚠ Verify at implementation`).

```bash
# Against a scratch database on the local mongod — never the live one.
mongosh --quiet --eval '
  const d = db.getSiblingDB("kpr454_ttl_probe");
  d.ops_events.drop();
  d.ops_events.createIndex({publishedAt: 1}, {expireAfterSeconds: 7776000});
  try { d.ops_events.createIndex({publishedAt: 1}, {expireAfterSeconds: 2592000}); print("NO ERROR — unexpected"); }
  catch (e) { print("codeName=" + e.codeName + " code=" + e.code); }
  d.dropDatabase();
'
```
Expected: `codeName=IndexOptionsConflict`. Record the actual `codeName`/`code` in the implementation report. If it differs on the deployed driver, adjust the `remedy` string in `ensureIndexes` so the warning names the observed shape; do **not** add a code-specific branch — the containment is already uniform, and this step's only product is the accuracy of the operator-facing text.

- [ ] **Step 8:** Verify and commit.

Run:
```
npx vitest run src/ops/publisher.integration.test.ts
npm run typecheck && npm run lint
```

```bash
git add src/ops/store.ts src/ops/publisher.ts src/ops/publisher-singleton.ts src/ops/observe.ts src/ops/testing/fake-db.ts src/ops/publisher.integration.test.ts
git commit -m "feat(KPR-454): ops publisher — accept path, epoch resolver, queue, open-condition map

D8/D9/D10: the eight-step accept path with dedupeKey derived after the epoch;
two bounded indexed reads compared on the compound (publishedAt, _id) order;
the drainer-owned open-condition map with openSeq identity, accept-time
removal and separate coalesced/superseded counters; a bounded queue dropping
oldest; contained index creation with a wired publisher, and a registry fault
that leaves it unset. No .start()-spelled method — the drainer is
demand-driven and the reload timer is armed in init().

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
