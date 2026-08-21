/**
 * Voice-worker observability (KPR-322 §13). Three surfaces:
 *  1. per-turn JSONL log line (structured logger — callId only, no content)
 *  2. voice_worker_stats heartbeat upsert to db.telemetry every 30s
 *  3. voice_call_stats summary doc at call end (§14/§15 scoring substrate)
 *
 * No transcript text, no phone numbers, no `to` in any log/telemetry object.
 */
import { voice, type MetricsCollectedEvent } from "@livekit/agents";
import { MongoClient, type Collection } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { VendorCell } from "./cells.js";
import type { BridgeFailureClass } from "./error-map.js";
import type { HiveLLM } from "./hive-llm.js";
import type { WorkerConfig } from "./worker-config.js";

const log = createLogger("voice-worker-metrics");

export type CallDirection = "inbound" | "outbound";

export interface TurnMetricsLine {
  ts: string;
  callId: string;
  turnSeq: number;
  direction: CallDirection;
  cell: VendorCell;
  eouDelayMs: number;
  llmTtftMs: number;
  maxInterChunkGapMs: number;
  ttsTtfbMs: number;
  totalToFirstAudioMs: number;
  interrupted: boolean;
  falseInterruption: boolean;
  errors: string[];
}

/**
 * Nearest-rank percentile (C = n·p / 100, no interpolation). Empty → -1.
 * Matches the CallStats flush formula so unit tests can pin the math
 * without a live Mongo round-trip.
 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return -1;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/**
 * 1.6.4 mapping (do not treat metrics_collected as a flat Record):
 * `session.on(AgentSessionEventTypes.MetricsCollected)` delivers
 * `{ type:"metrics_collected", metrics: AgentMetrics, createdAt }`.
 * AgentMetrics is a discriminated union — `eou_metrics.endOfUtteranceDelayMs`,
 * `tts_metrics.ttfbMs`, `llm_metrics.ttftMs`; `interruption_metrics` has
 * counts (not a boolean `falseInterruption`); there is no `totalToFirstAudioMs`.
 *
 * agents-js 1.6.4 emits `eou_metrics` immediately after `generateReply()` is
 * scheduled — before this turn's LLM stream or TTS TTFB exist. Production
 * order is EOU (with `speechId` = the new SpeechHandle) → this turn's LLM →
 * this turn's TTS TTFB. Hold the pending EOU; emit one TurnMetricsLine when
 * matching TTS TTFB arrives (join on `speechId`). `llmTtftMs` /
 * `maxInterChunkGapMs` come from `hiveLLM.lastTurnTiming` if set (HiveLLM
 * TTFT is this turn's by TTS TTFB), else matching `llm_metrics.ttftMs` for
 * that `speechId`, else -1. `ttsTtfbMs` is the matching TTS event.
 * `totalToFirstAudioMs` is the sum of EOU + LLM TTFT + TTS TTFB when all
 * are >= 0, else -1. Incomplete turns are dropped, not cross-wired with
 * another speech's TTS. `interrupted` is true when `numInterruptions`
 * increased since the last line; `falseInterruption` latches
 * `agent_false_interruption` until the next emitted line (the TTS-joined
 * line, not EOU). `speechId` is internal join key only — omit from JSONL.
 */
export class TurnMetrics {
  private turnSeq = 0;
  private pendingEou: { speechId: string; endOfUtteranceDelayMs: number } | null = null;
  private llmTtftBySpeechId = new Map<string, number>();
  private lastInterruptionCount = 0;
  private pendingInterrupted = false;
  private pendingFalseInterruption = false;

  constructor(
    private readonly callId: string,
    private readonly cell: VendorCell,
    private readonly hiveLLM: Pick<HiveLLM, "lastTurnTiming">,
    private readonly direction: CallDirection = "outbound",
    private readonly onTurn?: (line: TurnMetricsLine) => void,
  ) {}

  attach(session: Pick<voice.AgentSession, "on">): void {
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      this.onMetricsCollected(ev);
    });
    session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, () => {
      this.pendingFalseInterruption = true;
    });
  }

  private onMetricsCollected(ev: MetricsCollectedEvent): void {
    const m = ev.metrics;
    switch (m.type) {
      case "tts_metrics":
        if (m.speechId !== undefined && this.pendingEou?.speechId === m.speechId) {
          const eou = this.pendingEou;
          this.pendingEou = null;
          this.emitTurn(eou.endOfUtteranceDelayMs, m.ttfbMs, m.speechId);
        }
        return;
      case "llm_metrics":
        if (m.speechId !== undefined) this.llmTtftBySpeechId.set(m.speechId, m.ttftMs);
        return;
      case "interruption_metrics":
        if (m.numInterruptions > this.lastInterruptionCount) this.pendingInterrupted = true;
        this.lastInterruptionCount = m.numInterruptions;
        return;
      case "eou_metrics":
        // Hold until matching TTS TTFB. A new EOU replaces an unmatched one
        // (incomplete turns are dropped, never flushed with another speech's TTS).
        this.pendingEou =
          m.speechId !== undefined ? { speechId: m.speechId, endOfUtteranceDelayMs: m.endOfUtteranceDelayMs } : null;
        return;
      default:
        return;
    }
  }

  private emitTurn(eouDelayMs: number, ttsTtfbMs: number, speechId: string): void {
    const bridge = this.hiveLLM.lastTurnTiming;
    const llmTtftMs = bridge?.llmTtftMs ?? this.llmTtftBySpeechId.get(speechId) ?? -1;
    const maxInterChunkGapMs = bridge?.maxInterChunkGapMs ?? -1;
    this.llmTtftBySpeechId.delete(speechId);
    const totalToFirstAudioMs =
      eouDelayMs >= 0 && llmTtftMs >= 0 && ttsTtfbMs >= 0 ? eouDelayMs + llmTtftMs + ttsTtfbMs : -1;
    const line: TurnMetricsLine = {
      ts: new Date().toISOString(),
      callId: this.callId,
      turnSeq: this.turnSeq++,
      direction: this.direction,
      cell: this.cell,
      eouDelayMs,
      llmTtftMs,
      maxInterChunkGapMs,
      ttsTtfbMs,
      totalToFirstAudioMs,
      interrupted: this.pendingInterrupted,
      falseInterruption: this.pendingFalseInterruption,
      errors: [],
    };
    this.pendingInterrupted = false;
    this.pendingFalseInterruption = false;
    // Flatten cell so the log object has no nested vendor dump.
    log.info("voice turn metrics", { ...line, cell: `${this.cell.stt}+${this.cell.tts}` });
    this.onTurn?.(line);
  }
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
  private flushedOutcome: string | null = null;
  private interruptions = 0;
  private retries = 0;
  private readonly failures: string[] = [];
  private readonly startedAt = Date.now();
  private readonly turnLatencies: number[] = [];

  constructor(
    private readonly wc: WorkerConfig,
    private readonly meta: {
      callId: string;
      agentId: string;
      cell: VendorCell;
      direction: CallDirection;
    },
  ) {}

  recordInterruption(): void {
    this.interruptions += 1;
  }

  recordTurnLatency(ms: number): void {
    this.turnLatencies.push(ms);
  }

  recordFailure(outcome: string): void {
    this.failures.push(outcome);
  }

  /** First call per class returns false (retry still available); second returns true. */
  retryConsumed(failureClass: BridgeFailureClass): boolean {
    if (this.consumed.has(failureClass)) return true;
    this.consumed.add(failureClass);
    this.retries += 1;
    return false;
  }

  async flush(outcome: string): Promise<void> {
    // First outcome wins so a terminal flush("failed") is not overwritten by
    // the shutdown-callback flush("completed").
    if (this.flushedOutcome !== null) return;
    this.flushedOutcome = outcome;

    let client: MongoClient | undefined;
    try {
      client = new MongoClient(this.wc.mongoUri, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      const resolvedOutcome =
        this.failures.length && outcome === "failed" ? this.failures[this.failures.length - 1]! : outcome;
      await client
        .db(this.wc.mongoDbName)
        .collection("telemetry")
        .insertOne({
          kind: "voice_call_stats",
          callId: this.meta.callId,
          agentId: this.meta.agentId,
          cell: this.meta.cell,
          direction: this.meta.direction,
          turns: this.turnLatencies.length,
          interruptions: this.interruptions,
          retries: this.retries,
          outcome: resolvedOutcome,
          durationMs: Date.now() - this.startedAt,
          latency: { p50: percentile(this.turnLatencies, 50), p95: percentile(this.turnLatencies, 95) },
          createdAt: new Date(),
        });
    } catch (err) {
      log.warn("voice_call_stats flush failed", { callId: this.meta.callId, error: String(err) });
    } finally {
      await client?.close().catch(() => {});
    }
  }
}
