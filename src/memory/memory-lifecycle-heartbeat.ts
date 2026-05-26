import type { Collection } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { MemoryStore } from "./memory-store.js";
import type { AutoDreamSpendSample } from "./memory-types.js";

const log = createLogger("memory-lifecycle-heartbeat");

/**
 * KPR-241: periodic heartbeat that snapshots per-agent memory lifecycle
 * state into `db.telemetry` (kind = `memory_lifecycle_stats`). The
 * out-of-process `hive doctor` CLI reads from this collection, mirroring
 * KPR-213's prefix-cache and KPR-220's spawn-coordinator heartbeats.
 *
 * Cadence: 30s. Per-agent upsert keyed by `{ kind, agentId }`.
 */
export class MemoryLifecycleHeartbeat {
  static readonly INTERVAL_MS = 30_000;
  static readonly TELEMETRY_KIND = "memory_lifecycle_stats";

  private timer: NodeJS.Timeout | null = null;
  private readonly store: MemoryStore;
  private readonly telemetryCollection: Collection;
  private readonly intervalMs: number;
  private readonly getActiveAgentIds?: () => Promise<Set<string>>;

  constructor(
    store: MemoryStore,
    telemetryCollection: Collection,
    options?: { intervalMs?: number; getActiveAgentIds?: () => Promise<Set<string>> },
  ) {
    this.store = store;
    this.telemetryCollection = telemetryCollection;
    this.intervalMs = options?.intervalMs ?? MemoryLifecycleHeartbeat.INTERVAL_MS;
    this.getActiveAgentIds = options?.getActiveAgentIds;
  }

  async writeOnce(): Promise<void> {
    const collection = this.store.getCollection();
    let agentIds = await this.store.getAgentIds();
    if (this.getActiveAgentIds) {
      const active = await this.getActiveAgentIds();
      agentIds = agentIds.filter((id) => active.has(id));
    }

    const updatedAt = new Date();
    const ops: Array<Promise<unknown>> = [];

    for (const agentId of agentIds) {
      ops.push(this.snapshotAgent(agentId, collection, updatedAt));
    }

    await Promise.all(ops);
  }

  private async snapshotAgent(
    agentId: string,
    memoryCollection: ReturnType<MemoryStore["getCollection"]>,
    updatedAt: Date,
  ): Promise<void> {
    try {
      const [hot, warm, cold, summarizedNotPurged, needsReview, oldestCold, state] = await Promise.all([
        memoryCollection.countDocuments({ agentId, tier: "hot", purged: { $ne: true } }),
        memoryCollection.countDocuments({ agentId, tier: "warm", purged: { $ne: true } }),
        memoryCollection.countDocuments({ agentId, tier: "cold", purged: { $ne: true } }),
        memoryCollection.countDocuments({ agentId, summarized: true, purged: { $ne: true } }),
        memoryCollection.countDocuments({ agentId, needsReview: true, purged: { $ne: true } }),
        memoryCollection
          .find({ agentId, tier: "cold", purged: { $ne: true } })
          .sort({ createdAt: 1 })
          .limit(1)
          .project({ createdAt: 1 })
          .toArray(),
        this.store.getAutoDreamState(agentId),
      ]);

      const oldestColdAgeDays = oldestCold[0]?.createdAt
        ? Math.floor((updatedAt.getTime() - oldestCold[0].createdAt.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      // Derive spend metrics from spendHistory rolling window.
      const history: AutoDreamSpendSample[] = state?.spendHistory ?? [];
      const cutoff = updatedAt.getTime() - 30 * 24 * 60 * 60 * 1000;
      const cumulativeSpentUsd30d = history
        .filter((s) => s.at.getTime() >= cutoff)
        .reduce((sum, s) => sum + s.spentUsd, 0);
      const lastRunSpentUsd = history.length > 0 ? history[history.length - 1].spentUsd : null;

      await this.telemetryCollection.updateOne(
        { kind: MemoryLifecycleHeartbeat.TELEMETRY_KIND, agentId },
        {
          $set: {
            agentId,
            counts: { hot, warm, cold },
            summarizedNotPurged,
            needsReview,
            oldestColdAgeDays,
            consolidation: {
              phase: state?.phase ?? "idle",
              topic: state?.topic ?? null,
              cursor: state?.cursor ?? null,
              lastAttemptAt: state?.lastAttemptAt ?? null,
              lastSuccessAt: state?.lastSuccessAt ?? null,
              lastError: state?.lastError ?? null,
              lastRunSpentUsd,
              cumulativeSpentUsd30d,
            },
            updatedAt,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      log.warn("memory-lifecycle heartbeat write failed", { agentId, error: String(err) });
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.writeOnce().catch((err) => log.warn("memory-lifecycle heartbeat tick failed", { error: String(err) }));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
