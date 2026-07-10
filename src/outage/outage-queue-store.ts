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
}

/** Terminal-doc hygiene TTL (⚠ spec §10): 7 days. */
const TERMINAL_TTL_SECONDS = 7 * 24 * 3600;

/** `replaying` docs older than one turn deadline (300s) + slack revert to
 *  pending at boot — crash between claim and release (spec §7.1). */
export const STALE_REPLAYING_MS = 300_000 + 60_000;

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

  /** Atomic pending→replaying claim, oldest enqueuedAt first — copies the
   *  callback poller's mark-before-dispatch pattern (scheduler.ts). */
  async claimNext(): Promise<OutageQueueDoc | null> {
    return this.collection.findOneAndUpdate(
      { status: "pending" },
      { $set: { status: "replaying", lastAttemptAt: this.now() } },
      { sort: { enqueuedAt: 1 }, returnDocument: "after" },
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

  /** Boot recovery: crash between claim and release leaves `replaying` orphans. */
  async recoverStaleReplaying(staleMs: number = STALE_REPLAYING_MS): Promise<number> {
    const cutoff = new Date(this.now().getTime() - staleMs);
    const result = await this.collection.updateMany(
      { status: "replaying", lastAttemptAt: { $lt: cutoff } },
      { $set: { status: "pending" } },
    );
    if (result.modifiedCount > 0) {
      log.warn("Recovered stale replaying outage docs to pending", { count: result.modifiedCount });
    }
    return result.modifiedCount;
  }
}
