import { MongoClient, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { MemoryStore } from "./memory-store.js";

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
  private _memoryStore?: MemoryStore;

  /** Set the MemoryStore for structured memory operations (hot-tier injection). */
  set memoryStore(store: MemoryStore) {
    this._memoryStore = store;
  }

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
    // List files under a directory prefix (e.g. "agents/mokie/")
    const prefix = relativePath.endsWith("/") ? relativePath : relativePath + "/";
    const docs = await this.collection
      .find({ path: { $regex: `^${escapeRegex(prefix)}[^/]+$` } })
      .project<{ path: string }>({ path: 1 })
      .toArray();
    return docs.map((d) => d.path.slice(prefix.length));
  }

  /**
   * Build the hot-tier memory section for system prompt injection.
   * Delegates to MemoryStore for the correctly-sorted hot-tier query.
   * Returns null if no structured memories exist for this agent.
   */
  async getHotTierPrompt(agentId: string, budgetTokens: number): Promise<string | null> {
    if (!this._memoryStore) return null;
    const hotRecords = await this._memoryStore.getHotTier(agentId);
    if (hotRecords.length === 0) return null;

    const sectionLabels: Record<string, string> = {
      task: "Active Tasks",
      fact: "Key Facts",
      decision: "Recent Decisions",
      preference: "Preferences",
      interaction: "Recent Interactions",
      summary: "Summaries",
    };

    const sections: Record<string, string[]> = {};
    const pinnedEntries: string[] = [];
    let tokenCount = 0;

    for (const r of hotRecords) {
      const date = r.updatedAt.toISOString().split("T")[0];
      const line = `- [${date}] ${r.content} (${r.importance})`;
      const lineTokens = Math.ceil(line.length / 4);

      if (tokenCount + lineTokens > budgetTokens && !r.pinned) break;
      tokenCount += lineTokens;

      if (r.pinned) {
        pinnedEntries.push(`- ${r.content} (${r.importance}, pinned)`);
      } else {
        const type = r.type as string;
        if (!sections[type]) sections[type] = [];
        sections[type].push(line);
      }
    }

    const parts: string[] = ["## Your Memory"];
    for (const [type, label] of Object.entries(sectionLabels)) {
      if (sections[type]?.length) {
        parts.push(`### ${label}\n${sections[type].join("\n")}`);
      }
    }
    if (pinnedEntries.length > 0) {
      parts.push(`### Pinned\n${pinnedEntries.join("\n")}`);
    }

    const warmColdCount = await this._memoryStore.countNonHot(agentId);
    if (warmColdCount > 0) {
      parts.push(
        `---\nYou have ${warmColdCount} additional memories available via \`memory_recall\`. Use it to search for context before starting tasks.`,
      );
    }

    return parts.join("\n\n");
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
