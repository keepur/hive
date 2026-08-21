// Task 8 replaces this with JSONL + heartbeat + Mongo flush.
import type { VendorCell } from "./cells.js";
import type { BridgeFailureClass } from "./error-map.js";
import type { HiveLLM } from "./hive-llm.js";
import type { WorkerConfig } from "./worker-config.js";

export type CallDirection = "inbound" | "outbound";

/**
 * Minimal Task-7 stand-in. Task 8 wires LiveKit metrics_collected → JSONL.
 * No file writes, no Mongo.
 */
export class TurnMetrics {
  constructor(
    private readonly callId: string,
    private readonly cell: VendorCell,
    private readonly hiveLLM: HiveLLM,
    private readonly direction?: CallDirection,
  ) {
    void this.callId;
    void this.cell;
    void this.hiveLLM;
    void this.direction;
  }

  attach(_session: unknown): void {
    // Task 8: subscribe to metrics_collected and write per-turn JSONL.
  }
}

/**
 * Minimal Task-7 stand-in. `retryConsumed` is load-bearing for §8 retry budget
 * (true on the second call per failure class). `flush` is in-memory only.
 */
export class CallStats {
  private readonly consumed = new Set<BridgeFailureClass>();
  private flushedOutcome: string | null = null;
  interruptionCount = 0;
  failures: string[] = [];

  constructor(
    private readonly wc: WorkerConfig,
    private readonly meta: {
      callId: string;
      agentId: string;
      cell: VendorCell;
      direction: CallDirection;
    },
  ) {
    void this.wc;
    void this.meta;
  }

  recordInterruption(): void {
    this.interruptionCount += 1;
  }

  recordFailure(outcome: string): void {
    this.failures.push(outcome);
  }

  /** First call per class returns false (retry still available); second returns true. */
  retryConsumed(failureClass: BridgeFailureClass): boolean {
    if (this.consumed.has(failureClass)) return true;
    this.consumed.add(failureClass);
    return false;
  }

  async flush(outcome: string): Promise<void> {
    // First outcome wins so a terminal flush("failed") is not overwritten by
    // the shutdown-callback flush("completed").
    if (this.flushedOutcome !== null) return;
    this.flushedOutcome = outcome;
  }
}
