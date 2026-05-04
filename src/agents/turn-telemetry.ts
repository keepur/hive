import { type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";

const log = createLogger("turn-telemetry");

export interface TurnTelemetryDoc {
  agentId: string;
  threadId: string;
  sessionId: string;
  model?: string;
  inputTokens: number; // Uncached new input only — disjoint from cache_read/cache_creation.
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ephemeral5mTokens?: number;
  ephemeral1hTokens?: number;
  createdAt: Date;
}

export interface TurnTelemetryInput {
  agentId: string;
  threadId: string;
  sessionId: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ephemeral5mTokens?: number;
  ephemeral1hTokens?: number;
}

export interface CacheHitRateRow {
  agentId: string;
  turns: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  ephemeral5mTokens: number;
  ephemeral1hTokens: number;
  // Null when the row has no measurable input (no turns OR all three counters zero).
  // Renderers translate null to "no data" rather than "0%".
  hitRate: number | null;
}

/**
 * Per-turn cache telemetry store. One document per agent turn captured from
 * `AgentManager` after `runner.send`, alongside the existing per-thread
 * `SessionStore.set` snapshot. Aggregator reads this for window-bound hit-rate
 * rows surfaced through `hive doctor` (KPR-140).
 */
export class TurnTelemetryStore {
  private collection!: Collection<TurnTelemetryDoc>;

  constructor(private db: Db) {}

  async init(): Promise<void> {
    this.collection = this.db.collection<TurnTelemetryDoc>("agent_turn_telemetry");
    // 14 days = one full 7-day measurement window plus headroom; keeps the collection bounded.
    await this.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });
    await this.collection.createIndex({ agentId: 1, createdAt: -1 });
    log.info("Turn telemetry store connected");
  }

  private async withRetry<T>(op: () => Promise<T>, fallback: T, label: string): Promise<T> {
    try {
      return await op();
    } catch (err: any) {
      log.error("MongoDB operation failed, using fallback", { label, error: String(err?.message ?? err) });
      return fallback;
    }
  }

  async record(input: TurnTelemetryInput): Promise<void> {
    await this.withRetry(
      async () => {
        const doc: TurnTelemetryDoc = { ...input, createdAt: new Date() };
        await this.collection.insertOne(doc);
      },
      undefined,
      `record(${input.agentId})`,
    );
  }

  /**
   * Per-agent cache hit-rate over the trailing `windowMs` (default 7 days).
   *
   * Formula: hitRate = cacheRead / (cacheRead + cacheCreation + input)
   * `inputTokens` here is the *uncached* counter from SDK usage (input_tokens),
   * not a total. The three counters are disjoint, so summing them is the
   * correct "total billable input" denominator.
   *
   * Rows with zero turns OR zero total input return `hitRate: null` so the
   * renderer can show "no data" instead of "0%".
   */
  async hitRatesByAgent(windowMs = 7 * 24 * 60 * 60 * 1000): Promise<CacheHitRateRow[]> {
    return this.withRetry(
      async () => {
        const since = new Date(Date.now() - windowMs);
        const cursor = this.collection.aggregate<{
          _id: string;
          turns: number;
          inputTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          ephemeral5mTokens: number;
          ephemeral1hTokens: number;
        }>([
          { $match: { createdAt: { $gte: since } } },
          {
            $group: {
              _id: "$agentId",
              turns: { $sum: 1 },
              inputTokens: { $sum: "$inputTokens" },
              cacheReadTokens: { $sum: "$cacheReadTokens" },
              cacheCreationTokens: { $sum: "$cacheCreationTokens" },
              ephemeral5mTokens: { $sum: { $ifNull: ["$ephemeral5mTokens", 0] } },
              ephemeral1hTokens: { $sum: { $ifNull: ["$ephemeral1hTokens", 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ]);
        const rows: CacheHitRateRow[] = [];
        for await (const r of cursor) {
          const denom = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
          rows.push({
            agentId: r._id,
            turns: r.turns,
            inputTokens: r.inputTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheCreationTokens: r.cacheCreationTokens,
            ephemeral5mTokens: r.ephemeral5mTokens,
            ephemeral1hTokens: r.ephemeral1hTokens,
            hitRate: denom > 0 ? r.cacheReadTokens / denom : null,
          });
        }
        return rows;
      },
      [],
      "hitRatesByAgent",
    );
  }
}
