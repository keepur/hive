/**
 * KPR-307: Mongo-backed outage queue — turns fast-failed by KPR-306's
 * provider circuit breaker persist here for automatic replay after recovery.
 * Distinct from the delivery retry queue (src/sweeper/retry-queue.ts), which
 * handles "turn succeeded, channel delivery failed" and is untouched.
 */
import type { Collection, ObjectId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { WorkItem } from "../types/work-item.js";

const log = createLogger("outage-queue");

export interface OutageQueueConfig {
  /** false = interception fully off; fast-fails fall back to today's raw error path. */
  enabled: boolean;
  /** Replay poller tick interval (own timer — NOT a sweeper step; must track the breaker's ≤60s probe cadence). */
  replayIntervalMs: number;
  /** Items older than this at replay time are marked expired, not run (§5-2c). */
  maxAgeHours: number;
  /** Global pending-depth cap; at cap new turns are NOT queued and get the overflow notice (§5-2f). */
  maxDepth: number;
  /** Real (non-fast-fail) replay attempts before terminal `failed` (§5-2g). */
  maxReplayAttempts: number;
}

/** ⚠ spec §10 delegated defaults, chosen for the 30-minute-outage profile. */
export const DEFAULT_OUTAGE_QUEUE_CONFIG: OutageQueueConfig = {
  enabled: true,
  replayIntervalMs: 15_000,
  maxAgeHours: 4,
  maxDepth: 500,
  maxReplayAttempts: 3,
};

export type OutagePolicy = "notify" | "silent";
export type OutageQueueStatus = "pending" | "replaying" | "done" | "expired" | "failed";

/**
 * KPR-400 (F2): why the doc was enqueued — drives claimNext's class
 * ordering. "fast-fail" = the turn never ran (ProviderCircuitOpenError,
 * rejected pre-router — zero evidence of being expensive, typically live
 * interactive traffic). "post-turn-fault" = the turn RAN and classified
 * into HARD_FAULT_KINDS with the breaker open (trip-crossing turns, incl.
 * zero-progress deadline burns). The string values are load-bearing:
 * "fast-fail" < "post-turn-fault" lexicographically, so a plain ascending
 * sort yields the class preference (pinned in outage-queue-store.test.ts,
 * spec ⚠A2 — a numeric weight field is an acceptable substitution).
 */
export type OutageEnqueueOrigin = "fast-fail" | "post-turn-fault";

export interface OutageQueueDoc {
  _id?: ObjectId;
  /** Original WorkItem.id — composite-unique with agentId: a fan-out dispatch
   *  produces one doc per fanned agent (Finding 4, spec review round 2). */
  itemId: string;
  /** Resolved agent, pinned for replay (meta.targetAgentId at redispatch). */
  agentId: string;
  /** Provider whose breaker was open at enqueue time (AgentProviderId value). */
  provider: string;
  /** Serialized verbatim — Date + meta survive the BSON round-trip. */
  workItem: WorkItem;
  policy: OutagePolicy;
  /** KPR-400 (F2): immutable after first enqueue ($setOnInsert; back-to-
   *  pending releases never touch it — a replay that fast-fails again keeps
   *  its original class, spec §Edge-7). Optional: absent on pre-KPR-400
   *  docs — BSON type ordering sorts missing before string, so legacy docs
   *  claim with top (fast-fail-class) priority for the one
   *  deploy-mid-outage window (spec ⚠A5, accepted). */
  enqueueOrigin?: OutageEnqueueOrigin;
  /** KPR-403: upper bound on ONE replay turn's wall clock for this doc's
   *  agent, captured at enqueue (D20 semantics via
   *  AgentManager.turnDeadlineUpperBoundMs; mirrors the breaker acquire
   *  meta's deadlineMs naming, KPR-400 F1). $setOnInsert-immutable —
   *  back-to-pending releases and recovery never touch it; a re-enqueue
   *  after config drift does not rewrite it (spec ⚠A3). Optional: absent
   *  on pre-KPR-403 docs, which take the recovery sweep's legacy 300s
   *  fallback (spec ⚠A2, D19-analog posture). */
  deadlineMs?: number;
  status: OutageQueueStatus;
  /** Real (non-fast-fail) replay attempts. Breaker-open retries are free and never counted. */
  attempts: number;
  enqueuedAt: Date;
  lastAttemptAt: Date | null;
  /** Truncated to 240 chars (mirrors the KPR-306 convention). */
  lastError: string | null;
  noticeSent: boolean;
  /** Set on terminal transitions (done/expired/failed); TTL hygiene target. */
  doneAt: Date | null;
}

export interface OutageEnqueueInput {
  itemId: string;
  agentId: string;
  provider: string;
  workItem: WorkItem;
  policy: OutagePolicy;
  /** KPR-400 (F2): required from callers — see OutageEnqueueOrigin. */
  enqueueOrigin: OutageEnqueueOrigin;
  /** KPR-403: required from callers — see OutageQueueDoc.deadlineMs. */
  deadlineMs: number;
}

/** Terminal-doc hygiene TTL (⚠ spec §10): 7 days. */
const TERMINAL_TTL_SECONDS = 7 * 24 * 3600;

/** Legacy-doc fallback: pre-KPR-403 docs carry no deadlineMs; 300s was the
 *  flat-deadline assumption the old STALE_REPLAYING_MS encoded. */
export const STALE_REPLAYING_FALLBACK_MS = 300_000;
/** Grace beyond the turn's deadline for outcome-write + delivery latency. */
export const STALE_REPLAYING_GRACE_MS = 60_000;

export class OutageQueueStore {
  constructor(
    private collection: Collection<OutageQueueDoc>,
    private now: () => Date = () => new Date(),
  ) {}

  async ensureIndexes(): Promise<void> {
    // Composite unique key: a unique index on itemId ALONE would collapse a
    // fan-out dispatch's N agents to one queued doc, silently dropping N−1
    // of the fanned agents' replies (spec §7.1).
    await this.collection.createIndex({ itemId: 1, agentId: 1 }, { unique: true });
    await this.collection.createIndex({ status: 1, enqueuedAt: 1 });
    // KPR-400 (F2): claimNext's class-ordered sort. The plain
    // { status, enqueuedAt } index above stays — expireOlderThan and
    // recoverStaleReplaying still read by it (harmless, other readers).
    await this.collection.createIndex({ status: 1, enqueueOrigin: 1, enqueuedAt: 1 });
    // TTL applies only to docs where doneAt is a Date (terminal states);
    // pending/replaying docs carry doneAt: null and Mongo TTL skips non-Date values.
    await this.collection.createIndex({ doneAt: 1 }, { expireAfterSeconds: TERMINAL_TTL_SECONDS });
  }

  /** Upsert on (itemId, agentId): double-enqueue for the same agent is a
   *  no-op; a fan-out enqueues one independent doc per fanned agent. */
  async enqueue(input: OutageEnqueueInput): Promise<void> {
    await this.collection.updateOne(
      { itemId: input.itemId, agentId: input.agentId },
      {
        $setOnInsert: {
          provider: input.provider,
          workItem: input.workItem,
          policy: input.policy,
          // KPR-400 (F2): $setOnInsert = immutable after first enqueue.
          enqueueOrigin: input.enqueueOrigin,
          // KPR-403: same immutability — the stamp is the enqueue-time truth.
          deadlineMs: input.deadlineMs,
          status: "pending",
          attempts: 0,
          enqueuedAt: this.now(),
          lastAttemptAt: null,
          lastError: null,
          noticeSent: false,
          doneAt: null,
        },
      },
      { upsert: true },
    );
  }

  /** Atomic pending→replaying claim — copies the callback poller's
   *  mark-before-dispatch pattern (scheduler.ts). KPR-400 (F2):
   *  class-ordered — fast-fail-class docs (turns that never ran) before
   *  post-turn-fault-class docs (turns that demonstrably ran into a hard
   *  fault, incl. full-deadline burns), oldest enqueuedAt first WITHIN each
   *  class — so after cooldown the drain's next claim (with high
   *  probability the half-open probe) is the cheapest available real turn.
   *  Ascending sort on the origin string IS the class preference
   *  ("fast-fail" < "post-turn-fault"); missing/legacy docs sort first
   *  under BSON type order (null/missing < string — documented Mongo
   *  behavior, mirrored in the test fake; spec ⚠A5). */
  async claimNext(): Promise<OutageQueueDoc | null> {
    return this.collection.findOneAndUpdate(
      { status: "pending" },
      { $set: { status: "replaying", lastAttemptAt: this.now() } },
      { sort: { enqueueOrigin: 1, enqueuedAt: 1 }, returnDocument: "after" },
    );
  }

  /**
   * Dispatcher-authored outcome write (§5-2g — the dispatcher decides, the
   * poller only re-reads). `pending` = fast-fail-again or transient thrown
   * error (attempts unchanged); `done`/`expired` are terminal. Real failures
   * go through recordFailedAttempt instead.
   */
  async release(
    itemId: string,
    agentId: string,
    outcome: "pending" | "done" | "expired",
    lastError?: string,
  ): Promise<void> {
    const terminal = outcome !== "pending";
    await this.collection.updateOne(
      { itemId, agentId },
      {
        $set: {
          status: outcome,
          doneAt: terminal ? this.now() : null,
          ...(lastError !== undefined ? { lastError: lastError.slice(0, 240) } : {}),
        },
      },
    );
  }

  /** Real (breaker-closed) replay failure: attempts+1; terminal `failed` at the cap. */
  async recordFailedAttempt(
    itemId: string,
    agentId: string,
    lastError: string,
    maxAttempts: number,
  ): Promise<{ terminal: boolean; doc: OutageQueueDoc | null }> {
    const doc = await this.collection.findOneAndUpdate(
      { itemId, agentId },
      { $inc: { attempts: 1 }, $set: { lastError: lastError.slice(0, 240) } },
      { returnDocument: "after" },
    );
    if (!doc) return { terminal: false, doc: null };
    const terminal = doc.attempts >= maxAttempts;
    await this.collection.updateOne(
      { itemId, agentId },
      { $set: terminal ? { status: "failed", doneAt: this.now() } : { status: "pending", doneAt: null } },
    );
    return { terminal, doc };
  }

  async markNoticeSent(itemId: string, agentId: string): Promise<void> {
    await this.collection.updateOne({ itemId, agentId }, { $set: { noticeSent: true } });
  }

  async pendingCount(): Promise<number> {
    return this.collection.countDocuments({ status: "pending" });
  }

  /** Drain-control re-read (§7.4 step 5 — Finding 7, review round 2). */
  async statusOf(itemId: string, agentId: string): Promise<OutageQueueStatus | null> {
    const doc = await this.collection.findOne({ itemId, agentId });
    return doc?.status ?? null;
  }

  /** §5-2c: mark over-age pending docs expired; returns them so the caller
   *  can group notify-policy docs by thread for the batched notice. */
  async expireOlderThan(cutoff: Date): Promise<OutageQueueDoc[]> {
    const docs = await this.collection.find({ status: "pending", enqueuedAt: { $lt: cutoff } }).toArray();
    if (docs.length === 0) return [];
    await this.collection.updateMany(
      { _id: { $in: docs.map((d) => d._id!) }, status: "pending" },
      { $set: { status: "expired", doneAt: this.now(), lastError: "expired before replay (maxAgeHours)" } },
    );
    return docs;
  }

  /** Recovery sweep: crash between claim and release leaves `replaying`
   *  orphans. Per-doc deadline-aware (KPR-403): a doc is stale only past its
   *  own stamped turn-deadline upper bound (+grace) — never while its replay
   *  turn could legitimately still be running. Runs at boot AND every poller
   *  tick (the boot-only sweep stranded young orphans forever). CAS on
   *  (_id, status, lastAttemptAt) so a doc that moved under the sweep —
   *  released and re-claimed between read and write — is left alone. */
  async recoverStaleReplaying(): Promise<number> {
    const nowMs = this.now().getTime();
    const docs = await this.collection.find({ status: "replaying" }).toArray();
    let recovered = 0;
    for (const doc of docs) {
      if (!doc.lastAttemptAt) {
        // Unreachable via claimNext (it always stamps lastAttemptAt) — skip,
        // but loudly: malformed data should be conspicuous, not recycled.
        log.warn("Replaying doc with no lastAttemptAt — skipped by recovery", {
          itemId: doc.itemId,
          agentId: doc.agentId,
        });
        continue;
      }
      const boundMs = (doc.deadlineMs ?? STALE_REPLAYING_FALLBACK_MS) + STALE_REPLAYING_GRACE_MS;
      if (nowMs - doc.lastAttemptAt.getTime() <= boundMs) continue;
      const result = await this.collection.updateOne(
        { _id: doc._id, status: "replaying", lastAttemptAt: doc.lastAttemptAt },
        { $set: { status: "pending" } },
      );
      recovered += result.modifiedCount;
    }
    if (recovered > 0) {
      log.warn("Recovered stale replaying outage docs to pending", { count: recovered });
    }
    return recovered;
  }
}
