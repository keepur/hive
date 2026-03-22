import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { MemoryRecord, MemoryRecordInput, MemoryTier } from "./memory-types.js";

const log = createLogger("memory-store");

export class MemoryStore {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection<MemoryRecord>;

  constructor(private mongoUri: string, private dbName: string) {
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
    log.info("Memory store initialized", { db: this.dbName });
  }

  async save(agentId: string, input: MemoryRecordInput, qdrantPointId: string, sourceChannel?: string, sourceThread?: string): Promise<MemoryRecord> {
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
    const result = await this.collection.insertOne(record as any);
    record._id = result.insertedId;
    return record;
  }

  async getById(id: ObjectId): Promise<MemoryRecord | null> {
    return this.collection.findOne({ _id: id });
  }

  async update(id: ObjectId, content: string, importance?: string, qdrantPointId?: string): Promise<MemoryRecord | null> {
    const updates: Record<string, any> = {
      content,
      updatedAt: new Date(),
    };
    if (importance) updates.importance = importance;
    if (qdrantPointId) updates.qdrantPointId = qdrantPointId;

    const result = await this.collection.findOneAndUpdate(
      { _id: id },
      { $set: updates },
      { returnDocument: "after" },
    );
    return result;
  }

  async pin(id: ObjectId): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id },
      { $set: { pinned: true, tier: "hot" as MemoryTier } },
    );
    return result.modifiedCount > 0;
  }

  async unpin(id: ObjectId): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id },
      { $set: { pinned: false } },
    );
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
    const records = await this.collection.find({ agentId, tier: "hot" }).toArray();
    return records.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const wDiff = (WEIGHT[b.importance] ?? 0) - (WEIGHT[a.importance] ?? 0);
      if (wDiff !== 0) return wDiff;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
  }

  async getAllNonPinned(agentId: string): Promise<MemoryRecord[]> {
    return this.collection.find({ agentId, pinned: false }).toArray();
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
      .find({ agentId, tier: "cold", topic, summarized: false })
      .sort({ createdAt: 1 })
      .toArray();
  }

  async getColdTopics(agentId: string): Promise<string[]> {
    const result = await this.collection.distinct("topic", {
      agentId,
      tier: "cold",
      summarized: false,
    });
    return result;
  }

  async markSummarized(ids: ObjectId[], summaryGroupId: ObjectId): Promise<void> {
    if (ids.length === 0) return;
    await this.collection.updateMany(
      { _id: { $in: ids } },
      { $set: { summarized: true, summaryGroup: summaryGroupId } },
    );
  }

  async deleteSummarizedOlderThan(agentId: string, before: Date): Promise<number> {
    const result = await this.collection.deleteMany({
      agentId,
      summarized: true,
      updatedAt: { $lt: before },
    });
    return result.deletedCount;
  }

  async getAgentIds(): Promise<string[]> {
    return this.collection.distinct("agentId");
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
