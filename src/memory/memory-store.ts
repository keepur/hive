import { MongoClient, ObjectId, type Collection, type Db, type WithoutId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { MemoryRecord, MemoryRecordInput, MemoryImportance, MemoryTier, PurgeFilters } from "./memory-types.js";

const log = createLogger("memory-store");

export class MemoryStore {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection<MemoryRecord>;

  constructor(
    private mongoUri: string,
    private dbName: string,
  ) {
    this.client = new MongoClient(mongoUri);
  }

  async init(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<MemoryRecord>("agent_memory");

    await this.collection.createIndex({ agentId: 1, tier: 1 });
    await this.collection.createIndex({ agentId: 1, topic: 1 });
    await this.collection.createIndex({ agentId: 1, updatedAt: 1 });
    await this.collection.createIndex({ agentId: 1, type: 1 });
    await this.collection.createIndex({ agentId: 1, purged: 1, purgedAt: 1 });
    log.info("Memory store initialized", { db: this.dbName });
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
    return result;
  }

  async pin(id: ObjectId): Promise<boolean> {
    const result = await this.collection.updateOne({ _id: id }, { $set: { pinned: true, tier: "hot" as MemoryTier } });
    return result.modifiedCount > 0;
  }

  async unpin(id: ObjectId): Promise<boolean> {
    const result = await this.collection.updateOne({ _id: id }, { $set: { pinned: false } });
    return result.modifiedCount > 0;
  }

  async delete(id: ObjectId): Promise<MemoryRecord | null> {
    return this.collection.findOneAndDelete({ _id: id });
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
  }

  /** Flag records for human review (unresolvable contradictions) */
  async flagForReview(ids: ObjectId[]): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany({ _id: { $in: ids } }, { $set: { needsReview: true } });
  }

  async getAllForAgent(agentId: string): Promise<MemoryRecord[]> {
    return this.collection.find({ agentId }).toArray();
  }

  async setTier(id: ObjectId, tier: MemoryTier): Promise<void> {
    await this.collection.updateOne({ _id: id }, { $set: { tier } });
  }

  async setTierBulk(ids: ObjectId[], tier: MemoryTier): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany({ _id: { $in: ids } }, { $set: { tier } });
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
  }

  async deleteSummarizedOlderThan(agentId: string, before: Date): Promise<number> {
    const result = await this.collection.deleteMany({
      agentId,
      summarized: true,
      summarizedAt: { $lt: before },
    });
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
    return result.modifiedCount;
  }

  async deletePurgedOlderThan(agentId: string, before: Date): Promise<MemoryRecord[]> {
    const records = await this.collection.find({ agentId, purged: true, purgedAt: { $lt: before } }).toArray();

    if (records.length === 0) return [];

    const ids = records.map((r) => r._id!);
    await this.collection.deleteMany({ _id: { $in: ids } });
    return records;
  }

  async getAgentIds(): Promise<string[]> {
    return this.collection.distinct("agentId");
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
