import { MongoClient, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";

const log = createLogger("memory-manager");

interface MemoryDoc {
  path: string;
  content: string;
  updatedAt: Date;
  updatedBy?: string;
}

interface MemoryVersionDoc {
  path: string;
  content: string;
  savedAt: Date;
  savedBy?: string;
}

export class MemoryManager {
  private mongoUri: string;
  private dbName: string;
  private client!: MongoClient;
  private db!: Db;
  private collection!: Collection<MemoryDoc>;
  private versions!: Collection<MemoryVersionDoc>;

  constructor(mongoUri: string, dbName: string = "hive") {
    this.mongoUri = mongoUri;
    this.dbName = dbName;
  }

  async init(): Promise<void> {
    this.client = new MongoClient(this.mongoUri);
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<MemoryDoc>("memory");
    this.versions = this.db.collection<MemoryVersionDoc>("memory_versions");
    await this.collection.createIndex({ path: 1 }, { unique: true });
    await this.versions.createIndex({ path: 1, savedAt: -1 });
    log.info("Memory manager connected to MongoDB", { db: this.dbName });
  }

  async read(relativePath: string): Promise<string | null> {
    const doc = await this.collection.findOne({ path: relativePath });
    return doc?.content ?? null;
  }

  async list(relativePath: string): Promise<string[]> {
    // List files under a directory prefix (e.g. "agents/chief-of-staff/")
    const prefix = relativePath.endsWith("/") ? relativePath : relativePath + "/";
    const docs = await this.collection
      .find({ path: { $regex: `^${escapeRegex(prefix)}[^/]+$` } })
      .project<{ path: string }>({ path: 1 })
      .toArray();
    return docs.map((d) => d.path.slice(prefix.length));
  }

  async write(relativePath: string, content: string, updatedBy?: string): Promise<void> {
    // Save previous version before overwriting
    const existing = await this.collection.findOne({ path: relativePath });
    if (existing) {
      await this.versions.insertOne({
        path: relativePath,
        content: existing.content,
        savedAt: existing.updatedAt,
        savedBy: existing.updatedBy,
      });
    }

    await this.collection.updateOne(
      { path: relativePath },
      { $set: { content, updatedAt: new Date(), ...(updatedBy ? { updatedBy } : {}) } },
      { upsert: true },
    );
  }

  async commitAndPush(_message: string): Promise<void> {
    // No-op — Mongo writes are immediate, no git needed
  }

  async pull(): Promise<void> {
    // No-op — Mongo reads are always fresh
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
