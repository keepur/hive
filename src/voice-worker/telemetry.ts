/**
 * Voice-worker observability (KPR-322 §13). Three surfaces:
 *  1. per-turn JSONL log line (structured logger — callId only, no content)
 *  2. voice_worker_stats heartbeat upsert to db.telemetry every 30s
 *  3. voice_call_stats summary doc at call end (§14/§15 scoring substrate)
 *
 * No transcript text, no phone numbers, no `to` in any log/telemetry object.
 */
import { MongoClient, type Collection } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { nearestRankPercentile } from "../voice/percentile.js";
import type { VendorCell } from "./cells.js";
import type { BridgeFailureClass } from "./error-map.js";
import type { CallDiagnosticCounts } from "./speech-trace.js";
import type { WorkerConfig } from "./worker-config.js";

const log = createLogger("voice-worker-metrics");

export type CallDirection = "inbound" | "outbound";

/**
 * Nearest-rank percentile (C = n·p / 100, no interpolation). Empty → -1.
 * Matches the CallStats flush formula so unit tests can pin the math
 * without a live Mongo round-trip.
 */
export function percentile(samples: number[], p: number): number {
  return nearestRankPercentile(samples, p) ?? -1;
}

export class VoiceWorkerHeartbeat {
  static readonly INTERVAL_MS = 30_000;
  static readonly TELEMETRY_KIND = "voice_worker_stats";

  private timer: NodeJS.Timeout | null = null;
  activeCalls = 0;
  callsStarted = 0;
  callsCompleted = 0;
  lastError: string | null = null;

  constructor(
    private readonly telemetry: Collection,
    private readonly cellDefaults: { defaultStt: string; defaultTts: string },
    private readonly intervalMs = VoiceWorkerHeartbeat.INTERVAL_MS,
  ) {}

  /**
   * Supervisor liveness tick. Sets cellDefaults / updatedAt only.
   * Never $set lastError — forked jobs persist that via noteError; the
   * supervisor never calls noteError, so a tick $set would wipe a job error
   * with null. Never $set the call counters — those are owned by forked-job
   * $inc via noteCallStarted / noteCallEnded. $setOnInsert seeds lastError
   * null plus counter zeros on first upsert.
   */
  async writeOnce(): Promise<void> {
    await this.persist({
      $set: {
        cellDefaults: this.cellDefaults,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        lastError: null,
        activeCalls: 0,
        callsStarted: 0,
        callsCompleted: 0,
      },
    });
  }

  /**
   * Process boot: zero ghost in-flight calls left by a previous process that
   * $inc'd activeCalls and died without noteCallEnded. $set activeCalls: 0
   * plus cellDefaults/updatedAt. Does not $set lastError or lifetime
   * callsStarted/callsCompleted. $setOnInsert seeds first-ever upsert;
   * activeCalls is omitted there because it is already in $set (Mongo
   * rejects the same path in both).
   */
  async writeBoot(): Promise<void> {
    this.activeCalls = 0;
    await this.persist({
      $set: {
        cellDefaults: this.cellDefaults,
        updatedAt: new Date(),
        activeCalls: 0,
      },
      $setOnInsert: {
        lastError: null,
        callsStarted: 0,
        callsCompleted: 0,
      },
    });
  }

  async noteCallStarted(): Promise<void> {
    this.activeCalls += 1;
    this.callsStarted += 1;
    await this.persist({
      $inc: { activeCalls: 1, callsStarted: 1 },
      $set: { updatedAt: new Date() },
    });
  }

  async noteCallEnded(): Promise<void> {
    this.activeCalls = Math.max(0, this.activeCalls - 1);
    this.callsCompleted += 1;
    await this.persist({
      $inc: { activeCalls: -1, callsCompleted: 1 },
      $set: { updatedAt: new Date() },
    });
  }

  async noteError(msg: string): Promise<void> {
    this.lastError = msg;
    await this.persist({
      $set: { lastError: msg, updatedAt: new Date() },
    });
  }

  private async persist(update: object): Promise<void> {
    await this.telemetry
      .updateOne({ kind: VoiceWorkerHeartbeat.TELEMETRY_KIND }, update, { upsert: true })
      .catch((err) => log.warn("voice-worker heartbeat write failed", { error: String(err) }));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.writeOnce().catch((err) => log.warn("voice-worker heartbeat tick failed", { error: String(err) }));
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

export class CallStats {
  private readonly consumed = new Set<BridgeFailureClass>();
  private terminalOutcome: string | null = null;
  private flushPromise: Promise<CallStatsFlushResult> | null = null;
  private retries = 0;
  private failureCount = 0;
  private lastFailureClass: string | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly wc: WorkerConfig,
    private readonly meta: {
      callId: string;
      agentId: string;
      cell: VendorCell;
      direction: CallDirection;
    },
    private readonly observePersistence?: (
      status: "acknowledged" | "failed",
      reason?: "connect_failed" | "insert_failed" | "close_failed",
    ) => void,
  ) {}

  recordFailure(outcome: string): void {
    this.failureCount += 1;
    this.lastFailureClass = outcome.slice(0, 128);
  }

  recordTerminalOutcome(outcome: string): void {
    this.terminalOutcome ??= outcome.slice(0, 128);
  }

  /** First call per class returns false (retry still available); second returns true. */
  retryConsumed(failureClass: BridgeFailureClass): boolean {
    if (this.consumed.has(failureClass)) return true;
    this.consumed.add(failureClass);
    this.retries += 1;
    return false;
  }

  flush(outcome: string, diagnostics: CallDiagnosticCounts = EMPTY_DIAGNOSTICS): Promise<CallStatsFlushResult> {
    this.recordTerminalOutcome(outcome);
    if (this.flushPromise) return this.flushPromise;
    const snapshot = copyDiagnostics(diagnostics);
    const callState = {
      terminalOutcome: this.terminalOutcome ?? "unknown",
      failureCount: this.failureCount,
      lastFailureClass: this.lastFailureClass,
      retries: this.retries,
    };
    this.flushPromise = this.persist(snapshot, callState);
    return this.flushPromise;
  }

  private async persist(
    diagnostics: CallDiagnosticCounts,
    callState: { terminalOutcome: string; failureCount: number; lastFailureClass: string | null; retries: number },
  ): Promise<CallStatsFlushResult> {
    let client: MongoClient | undefined;
    let connected = false;
    let persisted = false;
    let closeFailed = false;
    let persistenceFailure: "connect_failed" | "insert_failed" | null = null;
    try {
      client = new MongoClient(this.wc.mongoUri, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      connected = true;
      const resolvedOutcome =
        callState.failureCount > 0 && callState.terminalOutcome === "failed"
          ? callState.lastFailureClass
          : callState.terminalOutcome;
      const result = await client
        .db(this.wc.mongoDbName)
        .collection("telemetry")
        .insertOne({
          kind: "voice_call_stats",
          schemaVersion: 2,
          callId: this.meta.callId,
          agentId: this.meta.agentId,
          cell: this.meta.cell,
          direction: this.meta.direction,
          speechAttempts: diagnostics.speechAttempts,
          speechOutcomes: diagnostics.speechOutcomes,
          bridgeAttempts: diagnostics.bridgeAttempts,
          bridgeOutcomes: diagnostics.bridgeOutcomes,
          synthesisAttempts: diagnostics.synthesisAttempts,
          synthesisOutcomes: diagnostics.synthesisOutcomes,
          synthesizedAudioObserved: diagnostics.synthesizedAudioObserved,
          generatedAudioObserved: diagnostics.generatedAudioObserved,
          knownPlayoutObserved: diagnostics.knownPlayoutObserved,
          incomplete: diagnostics.incomplete,
          incompleteByAttemptKind: diagnostics.incompleteByAttemptKind,
          incompleteObservations: diagnostics.incompleteObservations,
          unbound: diagnostics.unbound,
          unboundByAttemptKind: diagnostics.unboundByAttemptKind,
          unboundObservations: diagnostics.unboundObservations,
          diagnosticGaps: diagnostics.diagnosticGaps,
          loggingFailures:
            diagnostics.logging.filtered +
            diagnostics.logging.failed +
            diagnostics.logging.overflow +
            diagnostics.logging.pending +
            diagnostics.logging.unacknowledged +
            diagnostics.logging.sinkErrors,
          turns: diagnostics.eligibleLatencyEstimateCount,
          interruptions: diagnostics.sdkInterruptions,
          cancelled: diagnostics.cancelledSpeechAttempts,
          retries: callState.retries,
          outcome: resolvedOutcome,
          failureCount: callState.failureCount,
          lastFailureClass: callState.lastFailureClass,
          durationMs: Date.now() - this.startedAt,
          latencyEstimateSamples: diagnostics.latencyEstimateSamples,
          excludedByReason: diagnostics.excludedByReason,
          latency: {
            kind: "estimated_eou_to_first_generated_audio",
            sampled: true,
            eligibleSampleCount: diagnostics.eligibleLatencyEstimateCount,
            retainedSampleCount: diagnostics.latencyEstimateSamples.length,
            truncated: diagnostics.eligibleLatencyEstimateCount > diagnostics.latencyEstimateSamples.length,
            p50: percentile(diagnostics.latencyEstimateSamples, 50),
            p95: percentile(diagnostics.latencyEstimateSamples, 95),
          },
          createdAt: new Date(),
        });
      if (result.acknowledged !== true) throw new Error("summary insert was not acknowledged");
      persisted = true;
    } catch {
      persistenceFailure = connected ? "insert_failed" : "connect_failed";
    } finally {
      try {
        await client?.close();
      } catch {
        closeFailed = true;
      }
    }
    if (persisted) {
      this.safeLog("info", "summary_persistence", { callId: this.meta.callId, status: "acknowledged" });
      this.safeObservePersistence("acknowledged");
    } else {
      const reason = persistenceFailure ?? "insert_failed";
      this.safeLog("warn", "summary_persistence", { callId: this.meta.callId, status: "failed", reason });
      this.safeObservePersistence("failed", reason);
    }
    if (closeFailed) {
      this.safeLog("warn", "voice_call_stats close failed", { callId: this.meta.callId });
      this.safeObservePersistence("failed", "close_failed");
    }
    return { persisted, closeFailed };
  }

  private safeLog(level: "info" | "warn", message: string, data: Record<string, unknown>): void {
    try {
      log[level](message, data);
    } catch {
      // Summary persistence truth is independent of diagnostic logging.
    }
  }

  private safeObservePersistence(
    status: "acknowledged" | "failed",
    reason?: "connect_failed" | "insert_failed" | "close_failed",
  ): void {
    try {
      if (reason === undefined) this.observePersistence?.(status);
      else this.observePersistence?.(status, reason);
    } catch {
      // A diagnostic observer cannot rewrite acknowledged persistence.
    }
  }
}

export interface CallStatsFlushResult {
  persisted: boolean;
  closeFailed: boolean;
}

const EMPTY_OUTCOMES = { completed: 0, interrupted: 0, cancelled: 0, failed: 0, incomplete: 0 } as const;
const EMPTY_DIAGNOSTICS: CallDiagnosticCounts = {
  speechAttempts: 0,
  speechOutcomes: { ...EMPTY_OUTCOMES },
  bridgeAttempts: 0,
  bridgeOutcomes: { ...EMPTY_OUTCOMES },
  synthesisAttempts: 0,
  synthesisOutcomes: { ...EMPTY_OUTCOMES },
  synthesizedAudioObserved: 0,
  generatedAudioObserved: 0,
  knownPlayoutObserved: 0,
  sdkInterruptions: 0,
  cancelledSpeechAttempts: 0,
  incomplete: 0,
  incompleteByAttemptKind: { speech: 0, bridge: 0, synthesis: 0 },
  incompleteObservations: 0,
  unbound: 0,
  unboundByAttemptKind: { speech: 0, bridge: 0, synthesis: 0 },
  unboundObservations: 0,
  diagnosticGaps: 0,
  latencyEstimateSamples: [],
  eligibleLatencyEstimateCount: 0,
  excludedByReason: {
    not_applicable: 0,
    interrupted: 0,
    cancelled: 0,
    failed: 0,
    incomplete: 0,
    ambiguous_components: 0,
    missing_eou: 0,
    missing_bridge_first_text: 0,
    missing_tts_metric: 0,
    missing_generated_audio: 0,
  },
  logging: {
    attempted: 0,
    acknowledged: 0,
    filtered: 0,
    failed: 0,
    overflow: 0,
    pending: 0,
    unacknowledged: 0,
    sinkErrors: 0,
    complete: true,
  },
  registry: {
    activeSpeech: 0,
    recentSpeech: 0,
    activeBridge: 0,
    recentBridge: 0,
    activeSynthesis: 0,
    recentSynthesis: 0,
  },
};

function copyDiagnostics(diagnostics: CallDiagnosticCounts): CallDiagnosticCounts {
  return {
    ...diagnostics,
    speechOutcomes: { ...diagnostics.speechOutcomes },
    bridgeOutcomes: { ...diagnostics.bridgeOutcomes },
    synthesisOutcomes: { ...diagnostics.synthesisOutcomes },
    incompleteByAttemptKind: { ...diagnostics.incompleteByAttemptKind },
    unboundByAttemptKind: { ...diagnostics.unboundByAttemptKind },
    latencyEstimateSamples: diagnostics.latencyEstimateSamples.slice(0, 1_024),
    excludedByReason: { ...diagnostics.excludedByReason },
    logging: { ...diagnostics.logging },
    registry: { ...diagnostics.registry },
  };
}
