import type { Collection } from "mongodb";
import type { AgentManager } from "./agent-manager.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("circuit-breaker-heartbeat");

/**
 * KPR-306: periodic heartbeat that snapshots the per-provider circuit
 * breakers into `db.telemetry` (kind = `circuit_breaker_stats`). Structural
 * copy of SpawnCoordinatorHeartbeat: 30s cadence, per-key upsert (one doc
 * per provider, keyed by `{ kind, provider }`), unref'd interval, writeOnce
 * for boot + tests, write failures warned and swallowed.
 *
 * Only providers that have been used get rows (the registry is lazy) — a
 * claude-only instance heartbeats one row, not four. Snapshot timestamps are
 * epoch ms; `updatedAt` (Date) is the doctor's staleness signal.
 */
export class CircuitBreakerHeartbeat {
  static readonly INTERVAL_MS = 30_000;
  static readonly TELEMETRY_KIND = "circuit_breaker_stats";

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
    this.intervalMs = options?.intervalMs ?? CircuitBreakerHeartbeat.INTERVAL_MS;
  }

  /** Writes one full snapshot batch. Exposed for tests + initial boot write. */
  async writeOnce(): Promise<void> {
    const snapshot = this.agentManager.circuitBreakers.getSnapshot();
    const updatedAt = new Date();
    const ops: Array<Promise<unknown>> = [];
    for (const [provider, perProvider] of Object.entries(snapshot)) {
      ops.push(
        this.telemetryCollection
          .updateOne(
            { kind: CircuitBreakerHeartbeat.TELEMETRY_KIND, provider },
            { $set: { ...perProvider, updatedAt } },
            { upsert: true },
          )
          .catch((err) =>
            log.warn("circuit-breaker heartbeat write failed", {
              provider,
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
        log.warn("circuit-breaker heartbeat tick failed", { error: String(err) }),
      );
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
