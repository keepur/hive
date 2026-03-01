import { MongoClient, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";

const log = createLogger("session-store");

interface SessionDoc {
  _id: string; // "{agentId}:{threadId}"
  agentId: string;
  threadId: string;
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
}

export class SessionStore {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection<SessionDoc>;

  constructor(uri: string, dbName = "hive") {
    this.client = new MongoClient(uri);
  }

  async connect(dbName = "hive"): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(dbName);
    this.collection = this.db.collection<SessionDoc>("sessions");

    // TTL index: expire sessions after 7 days of inactivity
    await this.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
    // Fast lookups by agent
    await this.collection.createIndex({ agentId: 1 });

    const count = await this.collection.countDocuments();
    log.info("Session store connected", { count });
  }

  async get(agentId: string, threadId: string): Promise<string | undefined> {
    const doc = await this.collection.findOne({ _id: `${agentId}:${threadId}` });
    if (doc) return doc.sessionId;

    // Fallback: try legacy key format for old "slack:{channel}:{ts}" threadIds
    if (threadId.startsWith("slack:")) {
      const legacyTs = threadId.split(":").pop()!;
      const legacy = await this.collection.findOne({ _id: `${agentId}:${legacyTs}` });
      return legacy?.sessionId;
    }

    return undefined;
  }

  async set(agentId: string, threadId: string, sessionId: string): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { _id: `${agentId}:${threadId}` },
      {
        $set: { agentId, threadId, sessionId, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  async delete(agentId: string, threadId: string): Promise<void> {
    await this.collection.deleteOne({ _id: `${agentId}:${threadId}` });
  }

  async clearAgent(agentId: string): Promise<void> {
    const result = await this.collection.deleteMany({ agentId });
    if (result.deletedCount > 0) {
      log.info("Cleared agent sessions", { agentId, deleted: result.deletedCount });
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
