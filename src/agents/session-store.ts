import { type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { RESUMABLE_SESSION_PROVIDERS, type AgentProviderId } from "./provider-adapters/types.js";

const log = createLogger("session-store");

interface SessionDoc {
  _id: string; // "{agentId}:{threadId}"
  agentId: string;
  threadId: string;
  sessionId: string; // "" ⇒ row exists for thread-mapping only; nothing resumable (KPR-313)
  provider?: AgentProviderId; // KPR-313: producer tag; absent ⇒ legacy (pre-313) row
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

/**
 * KPR-313: normalized session reference returned by get(). sessionId is
 * present ONLY when the stored handle is genuinely resumable by the tagged
 * provider; provider is undefined only for scrubbed legacy rows (no
 * provenance survives).
 */
export interface StoredSessionRef {
  sessionId: string | undefined; // undefined ⇒ nothing to resume
  provider: AgentProviderId | undefined;
}

/** KPR-313: legacy fabricated pilot ids (and unprovenanced resp_ chain ids) — scrub on read. */
const FABRICATED_SESSION_ID = /^(codex-pilot-|gemini-pilot-|resp_)/;

export class SessionStore {
  private collection!: Collection<SessionDoc>;

  /** KPR-313: scrub warnings fire once per key per process (bounded by poisoned-row count; rows TTL out ≤7d). */
  private scrubWarned = new Set<string>();

  constructor(private db: Db) {}

  async init(): Promise<void> {
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
   * Run a MongoDB operation with fail-soft fallback.
   * The shared MongoClient handles transient reconnects via retryWrites/retryReads;
   * this wrapper preserves the "return a fallback on persistent failure" semantics.
   */
  private async withRetry<T>(op: () => Promise<T>, fallback: T, label: string): Promise<T> {
    try {
      return await op();
    } catch (err: any) {
      log.error("MongoDB operation failed, using fallback", {
        label,
        error: String(err?.message ?? err),
      });
      return fallback;
    }
  }

  /**
   * KPR-313: the single normalization choke point for stored session
   * identity. undefined ⇒ no row at all. Tagged rows normalize ("" ⇒ no
   * handle; non-resumable provider ⇒ no handle, belt-and-braces — post-313
   * writes never store one anyway). Legacy untagged rows: fabricated pilot
   * ids scrub (warn + lazy delete; the 7-day TTL is the backstop — no
   * migration script), anything else grandfathers as claude so the fleet's
   * pre-313 Claude rows keep resuming on upgrade day (spec ⚠A3).
   */
  async get(agentId: string, threadId: string): Promise<StoredSessionRef | undefined> {
    return this.withRetry(async () => {
      let doc = await this.collection.findOne({ _id: `${agentId}:${threadId}` });

      // Fallback: try legacy key format for old "slack:{channel}:{ts}" threadIds
      if (!doc && threadId.startsWith("slack:")) {
        const legacyTs = threadId.split(":").pop()!;
        doc = await this.collection.findOne({ _id: `${agentId}:${legacyTs}` });
      }

      if (!doc) return undefined;
      return this.normalizeRef(doc);
    }, undefined, `get(${agentId}:${threadId})`);
  }

  private normalizeRef(doc: SessionDoc): StoredSessionRef {
    // Tagged row (post-KPR-313 write).
    if (doc.provider) {
      return {
        sessionId: RESUMABLE_SESSION_PROVIDERS.has(doc.provider) ? doc.sessionId || undefined : undefined,
        provider: doc.provider,
      };
    }

    // Legacy untagged row carrying a fabricated pilot id or an unprovenanced
    // resp_ chain id: scrub. The resp_ case is a deliberate tradeoff (spec
    // §3.1): an untagged row has no provenance, and a wrongly-grandfathered
    // resp_ id handed to a Claude resume reproduces exactly the churn loop
    // this ticket kills. One bounded reset beats an unbounded failure mode.
    if (FABRICATED_SESSION_ID.test(doc.sessionId)) {
      if (!this.scrubWarned.has(doc._id)) {
        this.scrubWarned.add(doc._id);
        log.warn("Scrubbed legacy fabricated session id — treating thread as fresh (KPR-313)", {
          key: doc._id,
        });
      }
      // Lazy cleanup, fire-and-forget. MUST stay .catch-swallowed: get() runs
      // inside the R7 breaker window on the reflection re-resolve path — a
      // rejected floating promise from a Mongo blip must not become an
      // unhandled rejection or a new throw surface there (spec §3.1). The
      // sessionId filter guards against deleting a row a concurrent turn
      // already rewrote.
      this.collection.deleteOne({ _id: doc._id, sessionId: doc.sessionId }).catch((err) => {
        log.warn("Lazy scrub delete failed — TTL will reap the row", {
          key: doc._id,
          error: String(err),
        });
      });
      return { sessionId: undefined, provider: undefined };
    }

    // Legacy untagged plain id: grandfathered as claude (pre-313 fleet rows).
    return { sessionId: doc.sessionId || undefined, provider: "claude" };
  }

  async set(agentId: string, threadId: string, sessionId: string, provider: AgentProviderId, tokenData?: {
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
          agentId, threadId, sessionId, provider, updatedAt: now,
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
    // No-op: shared MongoClient is owned by the main hive process
  }
}
