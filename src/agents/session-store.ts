import { MongoClient, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";

const log = createLogger("session-store");

interface SessionDoc {
  _id: string; // "{agentId}:{threadId}"
  agentId: string;
  threadId: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  compactions: number; // Cumulative via $inc
  lastCompactedAt?: Date;
  preCompactTokens?: number;
  createdAt: Date;
  updatedAt: Date;
}

export class SessionStore {
  private client: MongoClient;
  private db!: Db;
  private collection!: Collection<SessionDoc>;
  private uri: string;
  private dbName: string;

  constructor(uri: string, dbName = "hive") {
    this.uri = uri;
    this.dbName = dbName;
    this.client = new MongoClient(uri, {
      // Keep the connection alive overnight
      heartbeatFrequencyMS: 30_000,        // Ping server every 30s (default 10s is fine too)
      serverSelectionTimeoutMS: 10_000,     // Wait up to 10s to find a server
      socketTimeoutMS: 30_000,             // Kill stale sockets after 30s
      maxIdleTimeMS: 300_000,              // Close idle connections after 5 min (driver recreates on demand)
      retryWrites: true,                   // Auto-retry failed writes (transient errors)
      retryReads: true,                    // Auto-retry failed reads
    });
  }

  async connect(dbName?: string): Promise<void> {
    this.dbName = dbName ?? this.dbName;
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<SessionDoc>("sessions");

    // TTL index: expire sessions after 7 days of inactivity
    await this.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
    // Fast lookups by agent
    await this.collection.createIndex({ agentId: 1 });
    // Fast lookups by threadId (for thread→agent resolution after restart)
    await this.collection.createIndex({ threadId: 1 });

    const count = await this.collection.countDocuments();
    log.info("Session store connected", { count });
  }

  /**
   * Reconnect after a connection failure. Creates a fresh client.
   */
  private async reconnect(): Promise<void> {
    log.warn("Reconnecting to MongoDB...");
    try {
      await this.client.close().catch(() => {}); // best-effort close old client
    } catch {}
    this.client = new MongoClient(this.uri, {
      heartbeatFrequencyMS: 30_000,
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 30_000,
      maxIdleTimeMS: 300_000,
      retryWrites: true,
      retryReads: true,
    });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<SessionDoc>("sessions");
    log.info("MongoDB reconnected");
  }

  /**
   * Run a MongoDB operation with one retry on connection failure.
   * If both attempts fail, returns the fallback value instead of throwing.
   */
  private async withRetry<T>(op: () => Promise<T>, fallback: T, label: string): Promise<T> {
    try {
      return await op();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      log.warn("MongoDB operation failed, retrying after reconnect", { label, error: msg });
      try {
        await this.reconnect();
        return await op();
      } catch (retryErr: any) {
        log.error("MongoDB operation failed after retry, using fallback", {
          label,
          error: String(retryErr?.message ?? retryErr),
        });
        return fallback;
      }
    }
  }

  async get(agentId: string, threadId: string): Promise<string | undefined> {
    return this.withRetry(async () => {
      const doc = await this.collection.findOne({ _id: `${agentId}:${threadId}` });
      if (doc) return doc.sessionId;

      // Fallback: try legacy key format for old "slack:{channel}:{ts}" threadIds
      if (threadId.startsWith("slack:")) {
        const legacyTs = threadId.split(":").pop()!;
        const legacy = await this.collection.findOne({ _id: `${agentId}:${legacyTs}` });
        return legacy?.sessionId;
      }

      return undefined;
    }, undefined, `get(${agentId}:${threadId})`);
  }

  async set(agentId: string, threadId: string, sessionId: string, tokenData?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    contextWindow: number;
    compactions: number;
    preCompactTokens?: number;
  }): Promise<void> {
    await this.withRetry(async () => {
      const now = new Date();
      const update: Record<string, any> = {
        $set: {
          agentId, threadId, sessionId, updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
          compactions: 0,
        },
      };

      if (tokenData) {
        // Overwrite per-turn token stats
        update.$set.inputTokens = tokenData.inputTokens;
        update.$set.outputTokens = tokenData.outputTokens;
        update.$set.cacheReadTokens = tokenData.cacheReadTokens;
        update.$set.cacheCreationTokens = tokenData.cacheCreationTokens;
        update.$set.contextWindow = tokenData.contextWindow;

        // Compactions are cumulative — only $inc when this turn had compactions
        if (tokenData.compactions > 0) {
          update.$inc = { compactions: tokenData.compactions };
          update.$set.lastCompactedAt = now;
          if (tokenData.preCompactTokens !== undefined) {
            update.$set.preCompactTokens = tokenData.preCompactTokens;
          }
          // Remove compactions from $setOnInsert since $inc handles both insert and update
          delete update.$setOnInsert.compactions;
        }
      } else {
        // No token data — set defaults on insert only
        Object.assign(update.$setOnInsert, {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
          cacheCreationTokens: 0, contextWindow: 0,
        });
      }

      await this.collection.updateOne(
        { _id: `${agentId}:${threadId}` },
        update,
        { upsert: true },
      );
    }, undefined, `set(${agentId}:${threadId})`);
  }

  async delete(agentId: string, threadId: string): Promise<void> {
    await this.withRetry(async () => {
      await this.collection.deleteOne({ _id: `${agentId}:${threadId}` });
    }, undefined, `delete(${agentId}:${threadId})`);
  }

  async clearAgent(agentId: string): Promise<void> {
    await this.withRetry(async () => {
      const result = await this.collection.deleteMany({ agentId });
      if (result.deletedCount > 0) {
        log.info("Cleared agent sessions", { agentId, deleted: result.deletedCount });
      }
    }, undefined, `clearAgent(${agentId})`);
  }

  /**
   * Find which agent was handling a given thread.
   * Used by Dispatcher for thread-continuity after restart.
   */
  async findAgentByThread(threadId: string): Promise<string | undefined> {
    return this.withRetry(async () => {
      const doc = await this.collection.findOne(
        { threadId },
        { sort: { updatedAt: -1 }, projection: { agentId: 1 } },
      );
      return doc?.agentId;
    }, undefined, `findAgentByThread(${threadId})`);
  }

  /**
   * Find ALL agents that have sessions for a given thread.
   * Used by Dispatcher to recover multi-agent participant sets after restart.
   */
  async findAgentsByThread(threadId: string): Promise<string[]> {
    return this.withRetry(async () => {
      const docs = await this.collection
        .find({ threadId }, { projection: { agentId: 1 }, sort: { updatedAt: -1 } })
        .toArray();
      return [...new Set(docs.map((d) => d.agentId))];
    }, [], `findAgentsByThread(${threadId})`);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
