import type { Collection } from "mongodb";
import type { AgentManager } from "./agent-manager.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("spawn-coordinator-heartbeat");

/**
 * KPR-220 Phase 11 / spec S6+S8: periodic heartbeat that snapshots the
 * AgentManager spawn coordinator's per-agent state into `db.telemetry`
 * (kind = `spawn_coordinator_stats`). The out-of-process `hive doctor`
 * CLI reads from this collection, mirroring KPR-213's prefix-cache
 * heartbeat pattern.
 *
 * Cadence: 30s (same as KPR-213). Cancels on service shutdown only — NOT
 * on `stopAll()` — so the doctor still sees the stopped-agent state.
 *
 * Per-agent upsert (one document per agent, keyed by `{ kind, agentId }`)
 * mirrors KPR-213's pattern but with per-agent granularity rather than a
 * single document. This keeps individual rows small enough for a doctor
 * lookup and lets a stale row reveal coordinator divergence per agent.
 */
export class SpawnCoordinatorHeartbeat {
  static readonly INTERVAL_MS = 30_000;
  static readonly TELEMETRY_KIND = "spawn_coordinator_stats";

  private timer: NodeJS.Timeout | null = null;
  private readonly agentManager: AgentManager;
  private readonly telemetryCollection: Collection;
  private readonly intervalMs: number;

  constructor(
    agentManager: AgentManager,
    telemetryCollection: Collection,
    options?: { intervalMs?: number },
  ) {
    this.agentManager = agentManager;
    this.telemetryCollection = telemetryCollection;
    this.intervalMs = options?.intervalMs ?? SpawnCoordinatorHeartbeat.INTERVAL_MS;
  }

  /**
   * Writes one full snapshot batch. Exposed for tests + initial-write at
   * startup so the doctor sees real data on the first poll rather than
   * "no heartbeat yet".
   */
  async writeOnce(): Promise<void> {
    const snapshot = this.agentManager.getSnapshot();
    const updatedAt = new Date();
    const ops: Array<Promise<unknown>> = [];
    for (const [agentId, perAgent] of Object.entries(snapshot.perAgent)) {
      ops.push(
        this.telemetryCollection
          .updateOne(
            { kind: SpawnCoordinatorHeartbeat.TELEMETRY_KIND, agentId },
            { $set: { ...perAgent, updatedAt } },
            { upsert: true },
          )
          .catch((err) =>
            log.warn("spawn-coordinator heartbeat write failed", {
              agentId,
              error: String(err),
            }),
          ),
      );
    }
    await Promise.all(ops);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.writeOnce().catch((err) =>
        log.warn("spawn-coordinator heartbeat tick failed", { error: String(err) }),
      );
    }, this.intervalMs);
    // Don't keep the event loop alive solely for this heartbeat.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
