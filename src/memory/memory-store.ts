import { ObjectId, type Collection, type Db, type WithoutId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { MemoryRecord, MemoryRecordInput, MemoryImportance, MemoryTier, PurgeFilters } from "./memory-types.js";

const log = createLogger("memory-store");

export interface AutoDreamAgentState {
  _id: string;
  agentId: string;
  lastDreamAt: Date;
  changedMemoryCount: number;
  spentUsd: number;
  llmCalls: number;
  updatedAt: Date;
}

export class MemoryStore {
  private collection!: Collection<MemoryRecord>;
  private autoDreamStateCollection!: Collection<AutoDreamAgentState>;
  /**
   * KPR-213 invalidation hook. Fired after any mutation that may affect an
   * agent's hot-tier composition (save, update, delete, pin, unpin,
   * setTier, supersede, purge, summary, flag-for-review). The callback is
   * synchronous + best-effort; callers (e.g. PrefixCache.invalidateAgent)
   * mutate in-memory state and don't await Mongo. Bulk-id paths that don't
   * have an agentId in scope (markSuperseded, markSummarized, setTierBulk)
   * fire `null` and the listener should treat that as "invalidate all".
   */
  private onMutate?: (agentId: string | null, reason: string) => void;

  constructor(private db: Db) {}

  setOnMutate(cb: (agentId: string | null, reason: string) => void): void {
    this.onMutate = cb;
  }

  async init(): Promise<void> {
    this.collection = this.db.collection<MemoryRecord>("agent_memory");
    this.autoDreamStateCollection = this.db.collection<AutoDreamAgentState>("agent_memory_autodream_state");

    await this.collection.createIndex({ agentId: 1, tier: 1 });
    await this.collection.createIndex({ agentId: 1, topic: 1 });
    await this.collection.createIndex({ agentId: 1, updatedAt: 1 });
    await this.collection.createIndex({ agentId: 1, type: 1 });
    await this.collection.createIndex({ agentId: 1, purged: 1, purgedAt: 1 });
    await this.autoDreamStateCollection.createIndex({ agentId: 1 }, { unique: true });
    log.info("Memory store initialized", { db: this.db.databaseName });
  }

  /** Expose collection for advanced queries (e.g., knowledge extractor delete-before-save) */
  getCollection(): Collection<MemoryRecord> {
    return this.collection;
  }

  async save(
    agentId: string,
    input: MemoryRecordInput,
    qdrantPointId: string,
    sourceChannel?: string,
    sourceThread?: string,
  ): Promise<MemoryRecord> {
    const now = new Date();
    const record: MemoryRecord = {
      agentId,
      content: input.content,
      type: input.type,
      topic: input.topic,
      importance: input.importance,
      tier: "hot",
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      sourceChannel,
      sourceThread,
      pinned: false,
      summarized: false,
      qdrantPointId,
    };
    const result = await this.collection.insertOne(record as WithoutId<MemoryRecord>);
    record._id = result.insertedId;
    this.onMutate?.(agentId, "memory-save");
    return record;
  }

  async getById(id: ObjectId): Promise<MemoryRecord | null> {
    return this.collection.findOne({ _id: id, purged: { $ne: true } });
  }

  async update(
    id: ObjectId,
    content: string,
    importance?: MemoryImportance,
    qdrantPointId?: string,
  ): Promise<MemoryRecord | null> {
    const updates: Partial<MemoryRecord> & { updatedAt: Date } = {
      content,
      updatedAt: new Date(),
    };
    if (importance) updates.importance = importance;
    if (qdrantPointId) updates.qdrantPointId = qdrantPointId;

    const result = await this.collection.findOneAndUpdate({ _id: id }, { $set: updates }, { returnDocument: "after" });
    if (result) this.onMutate?.(result.agentId, "memory-update");
    return result;
  }

  async pin(id: ObjectId): Promise<boolean> {
    const before = await this.collection.findOne({ _id: id }, { projection: { agentId: 1 } });
    const result = await this.collection.updateOne({ _id: id }, { $set: { pinned: true, tier: "hot" as MemoryTier } });
    if (result.modifiedCount > 0 && before) this.onMutate?.(before.agentId, "memory-pin");
    return result.modifiedCount > 0;
  }

  async unpin(id: ObjectId): Promise<boolean> {
    const before = await this.collection.findOne({ _id: id }, { projection: { agentId: 1 } });
    const result = await this.collection.updateOne({ _id: id }, { $set: { pinned: false } });
    if (result.modifiedCount > 0 && before) this.onMutate?.(before.agentId, "memory-unpin");
    return result.modifiedCount > 0;
  }

  async delete(id: ObjectId): Promise<MemoryRecord | null> {
    const result = await this.collection.findOneAndDelete({ _id: id });
    if (result) this.onMutate?.(result.agentId, "memory-delete");
    return result;
  }

  async touchAccess(ids: ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany(
      { _id: { $in: ids } },
      { $set: { lastAccessedAt: new Date() }, $inc: { accessCount: 1 } },
    );
  }

  async getHotTier(agentId: string): Promise<MemoryRecord[]> {
    // Sort in application code — importance is an enum that can't be sorted
    // correctly as a string (alphabetical: critical < high < low < medium).
    // We need weighted sort: pinned first, then by importance weight desc, then recency.
    const WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const records = await this.collection
      .find({ agentId, tier: "hot", purged: { $ne: true }, supersededBy: { $exists: false } })
      .toArray();
    return records.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const wDiff = (WEIGHT[b.importance] ?? 0) - (WEIGHT[a.importance] ?? 0);
      if (wDiff !== 0) return wDiff;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
  }

  async getHotTierWithStats(agentId: string): Promise<(MemoryRecord & { ageDays: number; daysSinceAccess: number })[]> {
    const records = await this.getHotTier(agentId);
    const now = Date.now();
    return records.map((r) => ({
      ...r,
      ageDays: Math.floor((now - r.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
      daysSinceAccess: Math.floor((now - r.lastAccessedAt.getTime()) / (1000 * 60 * 60 * 24)),
    }));
  }

  async getByIds(ids: ObjectId[]): Promise<MemoryRecord[]> {
    if (ids.length === 0) return [];
    return this.collection.find({ _id: { $in: ids }, purged: { $ne: true } }).toArray();
  }

  async countNonHot(agentId: string): Promise<number> {
    return this.collection.countDocuments({ agentId, tier: { $ne: "hot" }, purged: { $ne: true } });
  }

  async getAllNonPinned(agentId: string): Promise<MemoryRecord[]> {
    return this.collection
      .find({ agentId, pinned: false, purged: { $ne: true }, supersededBy: { $exists: false } })
      .toArray();
  }

  /** Get all non-purged, non-superseded records in specified tiers for an agent */
  async getByTiersForAgent(agentId: string, tiers: MemoryTier[]): Promise<MemoryRecord[]> {
    return this.collection
      .find({
        agentId,
        tier: { $in: tiers },
        purged: { $ne: true },
        summarized: false,
        supersededBy: { $exists: false },
      })
      .toArray();
  }

  /** Get fact and decision records grouped by topic for an agent */
  async getFactsAndDecisionsByTopic(agentId: string): Promise<Map<string, MemoryRecord[]>> {
    const records = await this.collection
      .find({
        agentId,
        type: { $in: ["fact", "decision"] },
        purged: { $ne: true },
        supersededBy: { $exists: false },
        needsReview: { $ne: true },
      })
      .toArray();
    const byTopic = new Map<string, MemoryRecord[]>();
    for (const r of records) {
      const list = byTopic.get(r.topic) ?? [];
      list.push(r);
      byTopic.set(r.topic, list);
    }
    return byTopic;
  }

  /** Get interaction records grouped by topic, with distinct sourceThread counts */
  async getInteractionsByTopic(agentId: string): Promise<Map<string, MemoryRecord[]>> {
    const records = await this.collection
      .find({
        agentId,
        type: "interaction",
        tier: { $in: ["hot", "warm"] as MemoryTier[] },
        purged: { $ne: true },
        supersededBy: { $exists: false },
        summarized: false,
      })
      .toArray();
    const byTopic = new Map<string, MemoryRecord[]>();
    for (const r of records) {
      const list = byTopic.get(r.topic) ?? [];
      list.push(r);
      byTopic.set(r.topic, list);
    }
    return byTopic;
  }

  /** Mark records as superseded by a merged/winning record */
  async markSuperseded(ids: ObjectId[], supersededBy: ObjectId): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany({ _id: { $in: ids } }, { $set: { supersededBy, tier: "cold" as MemoryTier } });
    // KPR-213: bulk path — agentId not in scope, listener treats null as "invalidate all".
    this.onMutate?.(null, "memory-superseded");
  }

  /** Flag records for human review (unresolvable contradictions) */
  async flagForReview(ids: ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany({ _id: { $in: ids } }, { $set: { needsReview: true } });
    // KPR-213: review-flagged records no longer surface via getFactsAndDecisionsByTopic;
    // hot-tier sort doesn't change but downstream consumers (autoDream) do.
    // Fire null-agent invalidation as a precaution.
    this.onMutate?.(null, "memory-flag-review");
  }

  async getAllForAgent(agentId: string): Promise<MemoryRecord[]> {
    return this.collection.find({ agentId }).toArray();
  }

  async setTier(id: ObjectId, tier: MemoryTier): Promise<void> {
    const before = await this.collection.findOne({ _id: id }, { projection: { agentId: 1 } });
    await this.collection.updateOne({ _id: id }, { $set: { tier } });
    if (before) this.onMutate?.(before.agentId, "memory-set-tier");
  }

  async setTierBulk(ids: ObjectId[], tier: MemoryTier): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany({ _id: { $in: ids } }, { $set: { tier } });
    // KPR-213: bulk path — fire null-agent (invalidate all). Tier moves can
    // promote/demote records into/out of hot-tier and thus change the prefix.
    this.onMutate?.(null, "memory-set-tier-bulk");
  }

  async getColdByTopic(agentId: string, topic: string): Promise<MemoryRecord[]> {
    return this.collection
      .find({ agentId, tier: "cold", topic, summarized: false, purged: { $ne: true } })
      .sort({ createdAt: 1 })
      .toArray();
  }

  async getColdTopics(agentId: string): Promise<string[]> {
    const result = await this.collection.distinct("topic", {
      agentId,
      tier: "cold",
      summarized: false,
      purged: { $ne: true },
    });
    return result;
  }

  async markSummarized(ids: ObjectId[], summaryGroupId: ObjectId): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany(
      { _id: { $in: ids } },
      { $set: { summarized: true, summaryGroup: summaryGroupId, summarizedAt: new Date() } },
    );
    // KPR-213: summarized records are filtered out of getByTiersForAgent;
    // bulk path so we invalidate all.
    this.onMutate?.(null, "memory-summarized");
  }

  async deleteSummarizedOlderThan(agentId: string, before: Date): Promise<number> {
    const result = await this.collection.deleteMany({
      agentId,
      summarized: true,
      summarizedAt: { $lt: before },
    });
    if (result.deletedCount > 0) this.onMutate?.(agentId, "memory-delete-summarized");
    return result.deletedCount;
  }

  async purge(agentId: string, filters: PurgeFilters): Promise<number> {
    const hasFilter =
      filters.topic !== undefined ||
      filters.type !== undefined ||
      filters.importance !== undefined ||
      filters.tier !== undefined ||
      filters.olderThan !== undefined;

    if (!hasFilter) {
      throw new Error("purge() requires at least one filter");
    }

    const query: Record<string, unknown> = {
      agentId,
      pinned: false,
      purged: { $ne: true },
    };

    if (filters.topic !== undefined) query.topic = filters.topic;
    if (filters.type !== undefined) query.type = filters.type;
    if (filters.importance !== undefined) query.importance = filters.importance;
    if (filters.tier !== undefined) query.tier = filters.tier;
    if (filters.olderThan !== undefined) query.updatedAt = { $lt: filters.olderThan };

    const result = await this.collection.updateMany(query, {
      $set: { purged: true, purgedAt: new Date() },
    });
    if (result.modifiedCount > 0) this.onMutate?.(agentId, "memory-purge");
    return result.modifiedCount;
  }

  async deletePurgedOlderThan(agentId: string, before: Date): Promise<MemoryRecord[]> {
    const records = await this.collection.find({ agentId, purged: true, purgedAt: { $lt: before } }).toArray();

    if (records.length === 0) return [];

    const ids = records.map((r) => r._id!);
    await this.collection.deleteMany({ _id: { $in: ids } });
    this.onMutate?.(agentId, "memory-delete-purged");
    return records;
  }

  async getAgentIds(): Promise<string[]> {
    return this.collection.distinct("agentId");
  }

  async getAutoDreamState(agentId: string): Promise<AutoDreamAgentState | null> {
    return this.autoDreamStateCollection.findOne({ _id: agentId });
  }

  async countAutoDreamCandidates(agentId: string, since?: Date): Promise<number> {
    const query: Record<string, unknown> = {
      agentId,
      purged: { $ne: true },
      supersededBy: { $exists: false },
      type: { $ne: "summary" },
    };
    if (since) query.updatedAt = { $gt: since };
    return this.collection.countDocuments(query);
  }

  async markAutoDreamRun(
    agentId: string,
    at: Date,
    changedMemoryCount: number,
    spentUsd: number,
    llmCalls: number,
  ): Promise<void> {
    await this.autoDreamStateCollection.updateOne(
      { _id: agentId },
      {
        $set: {
          agentId,
          lastDreamAt: at,
          changedMemoryCount,
          spentUsd,
          llmCalls,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async close(): Promise<void> {
    // No-op: shared MongoClient is owned by the main hive process
  }
}
