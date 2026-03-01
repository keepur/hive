import { MongoClient, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";

const log = createLogger("session-store");

interface SessionDoc {
  _id: string; // "{agentId}:{threadTs}"
  agentId: string;
  threadTs: string;
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

  async get(agentId: string, threadTs: string): Promise<string | undefined> {
    const doc = await this.collection.findOne({ _id: `${agentId}:${threadTs}` });
    return doc?.sessionId;
  }

  async set(agentId: string, threadTs: string, sessionId: string): Promise<void> {
    const now = new Date();
    await this.collection.updateOne(
      { _id: `${agentId}:${threadTs}` },
      {
        $set: { agentId, threadTs, sessionId, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  async delete(agentId: string, threadTs: string): Promise<void> {
    await this.collection.deleteOne({ _id: `${agentId}:${threadTs}` });
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
