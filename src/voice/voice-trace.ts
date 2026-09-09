import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { createLogger, type Level, type LogWriteResult } from "../logging/logger.js";

export const VOICE_TRACE_VERSION = 2 as const;
export const VOICE_PROCESS_ID = randomUUID();

export type MissingReason = "not_reached" | "not_applicable" | "not_observed" | "correlation_missing";
export type Measure = { value: number; reason: null } | { value: null; reason: MissingReason };
export type AttemptOutcome = "completed" | "interrupted" | "cancelled" | "failed" | "incomplete";
export type CancellationCause = "framework_cancelled" | "call_closed" | "startup_superseded" | "unknown";

export type VoiceTraceMetadata = {
  schemaVersion: 2;
  workerBootId: string;
  turnId: string;
};

export type ParsedTrace = {
  turnId: string;
  workerBootId: string | null;
  correlation: "worker" | "legacy" | "invalid";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseVoiceTrace(metadata: unknown): ParsedTrace {
  const fallback = (correlation: "legacy" | "invalid"): ParsedTrace => ({
    turnId: randomUUID(),
    workerBootId: null,
    correlation,
  });
  if (metadata === undefined) return fallback("legacy");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fallback("invalid");
  const value = (metadata as Record<string, unknown>).voiceTrace;
  if (value === undefined) return fallback("legacy");
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback("invalid");
  const trace = value as Record<string, unknown>;
  const keys = Object.keys(trace);
  if (keys.length !== 3 || !keys.every((key) => ["schemaVersion", "workerBootId", "turnId"].includes(key))) {
    return fallback("invalid");
  }
  if (
    trace.schemaVersion !== VOICE_TRACE_VERSION ||
    typeof trace.workerBootId !== "string" ||
    typeof trace.turnId !== "string"
  ) {
    return fallback("invalid");
  }
  if (!UUID.test(trace.workerBootId) || !UUID.test(trace.turnId)) return fallback("invalid");
  return { workerBootId: trace.workerBootId, turnId: trace.turnId, correlation: "worker" };
}

export function measure(value: number | undefined, reason: MissingReason): Measure {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? { value, reason: null }
    : { value: null, reason };
}

export type VoiceDiagnosticEventName =
  | "call_started"
  | "session_started"
  | "sip_answered"
  | "participant_available"
  | "caller_state"
  | "caller_final_input"
  | "caller_turn_accepted"
  | "opening_decision"
  | "call_closed"
  | "speech_started"
  | "speech_terminal"
  | "bridge_created"
  | "bridge_started"
  | "bridge_response"
  | "bridge_first_text"
  | "bridge_terminal"
  | "bridge_bound"
  | "synthesis_bound"
  | "synthesis_started"
  | "synthesis_first_frame"
  | "synthesis_terminal"
  | "sdk_metric"
  | "handle_playout_item"
  | "output_playback"
  | "false_interruption"
  | "engine_received"
  | "engine_attempt_started"
  | "engine_first_text"
  | "engine_client_closed"
  | "engine_attempt_terminal"
  | "engine_terminal"
  | "diagnostic_gap"
  | "teardown"
  | "summary_persistence";

export interface TraceEnvelope {
  kind: "voice_diagnostic";
  schemaVersion: 2;
  eventId: string;
  event: VoiceDiagnosticEventName;
  ts: string;
  component: "voice-worker" | "voice-engine";
  clockId: string;
  monoMs: number;
  callId: string;
  workerBootId: string | null;
  speechId: string | null;
  turnId: string | null;
  synthesisId: string | null;
  engineAttemptSeq: number | null;
}

export type VoiceErrorClass =
  | "stream_construction_failed"
  | "bridge_auth"
  | "engine_auth"
  | "engine_unreachable"
  | "budget_saturated"
  | "spawn_failed"
  | "midstream_error"
  | "llm_provider_failed"
  | "tts_provider_failed"
  | "tts_node_failed"
  | "speech_handle_failed"
  | "unknown";

export type DiagnosticGapReason =
  | "association_overflow"
  | "active_overflow"
  | "recent_cache_evicted"
  | "binding_conflict"
  | "correlation_missing"
  | "listener_failed"
  | "log_write_failed"
  | "late_error_observed"
  | "cancel_failed"
  | "action_ownership_unproved"
  | "action_overflow"
  | "provider_context_missing";

type CallPayload = {
  event:
    | "call_started"
    | "session_started"
    | "sip_answered"
    | "participant_available"
    | "caller_state"
    | "caller_final_input"
    | "caller_turn_accepted"
    | "opening_decision"
    | "call_closed";
  direction?: "inbound" | "outbound";
  intendedParticipant?: boolean;
  state?: "initializing" | "listening" | "thinking" | "speaking" | "away" | "closed";
  decision?: "request" | "defer" | "consumed";
  reason?:
    | "call_close"
    | "setup_failed"
    | "accepted_caller_turn"
    | "final_input_pending"
    | "caller_speaking"
    | "quiet_answer"
    | "startup_superseded"
    | "not_applicable"
    | "unknown";
  acceptedEpoch?: number;
  hasFinalInput?: boolean;
};

export type SpeechOrigin = "opening" | "sdk_response" | "retry" | "fallback";
type SpeechPayload = {
  event: "speech_started" | "speech_terminal";
  origin: SpeechOrigin;
  acceptedEpoch: number;
  source?: "application" | "sdk_handle" | "sdk_wall" | "late_observation";
  outcome?: AttemptOutcome;
  cause?: CancellationCause;
  generatedAudio?: boolean;
  knownPlayout?: boolean;
  sdkSettled?: boolean;
  sdkInterrupted?: boolean;
  textLength?: number;
  startedSpeakingAt?: Measure;
  generatedDurationMs?: Measure;
  errorClass?: VoiceErrorClass | null;
};

type BridgePayload = {
  event: "bridge_created" | "bridge_started" | "bridge_response" | "bridge_first_text" | "bridge_terminal";
  status?: number;
  textLength?: number;
  firstTextMs?: Measure;
  maximumGapMs?: Measure;
  outcome?: AttemptOutcome;
  cause?: CancellationCause;
  errorClass?: VoiceErrorClass | null;
  late?: boolean;
};

type BindingPayload = {
  event: "bridge_bound" | "synthesis_bound";
  source: "sdk_metrics_context";
};

type SynthesisPayload = {
  event: "synthesis_started" | "synthesis_first_frame" | "synthesis_terminal";
  frameCount?: number;
  sampleCount?: number;
  sampleRate?: number | null;
  sampleRateReason?: MissingReason | null;
  generatedDurationMs?: Measure;
  outcome?: AttemptOutcome;
  cause?: CancellationCause;
  errorClass?: VoiceErrorClass | null;
  late?: boolean;
};

type SdkPayload = {
  event: "sdk_metric" | "handle_playout_item" | "output_playback" | "false_interruption";
  source: "sdk_wall" | "sdk_metrics_context" | "sdk_handle" | "media_output" | "late_observation";
  metric?: "eou" | "llm" | "tts" | "interruption" | "playout";
  eouMs?: Measure;
  transcriptionMs?: Measure;
  onUserTurnCompletedMs?: Measure;
  ttftMs?: Measure;
  ttfbMs?: Measure;
  durationMs?: Measure;
  startedSpeakingAt?: Measure;
  interruptionCount?: number;
  textLength?: number;
  interrupted?: boolean;
  errorClass?: VoiceErrorClass | null;
};

type EnginePayload = {
  event:
    | "engine_received"
    | "engine_attempt_started"
    | "engine_first_text"
    | "engine_client_closed"
    | "engine_attempt_terminal"
    | "engine_terminal";
  status?: number;
  continuity?: "fresh" | "warm" | "resume" | "full_transcript";
  launchAdmission?: "fresh" | "resume" | null;
  selectedContinuity?: "fresh" | "resume" | "warm" | null;
  warm?: boolean;
  toolCount?: number;
  textLength?: number;
  outcome?: AttemptOutcome;
  errorClass?: VoiceErrorClass | null;
  admissionMs?: Measure;
  firstTextMs?: Measure;
};

type GapPayload = {
  event: "diagnostic_gap";
  reason: DiagnosticGapReason;
  count: number;
};

type TeardownPayload = {
  event: "teardown";
  result: "closed" | "failed" | "timeout";
  reason: "call_close" | "late_start" | "late_start_failed";
};

type PersistencePayload = {
  event: "summary_persistence";
  status: "acknowledged" | "failed";
  reason?: "connect_failed" | "insert_failed" | "close_failed";
};

export type VoiceDiagnosticPayload =
  | CallPayload
  | SpeechPayload
  | BridgePayload
  | BindingPayload
  | SynthesisPayload
  | SdkPayload
  | EnginePayload
  | GapPayload
  | TeardownPayload
  | PersistencePayload;

export type VoiceDiagnosticEvent = TraceEnvelope & VoiceDiagnosticPayload;

export type TraceIdentity = {
  component: "voice-worker" | "voice-engine";
  callId: string;
  workerBootId?: string | null;
  speechId?: string | null;
  turnId?: string | null;
  synthesisId?: string | null;
  engineAttemptSeq?: number | null;
  clockId?: string;
};

export function voiceDiagnosticEvent(identity: TraceIdentity, payload: VoiceDiagnosticPayload): VoiceDiagnosticEvent {
  return {
    kind: "voice_diagnostic",
    schemaVersion: VOICE_TRACE_VERSION,
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    component: identity.component,
    clockId: identity.clockId ?? VOICE_PROCESS_ID,
    monoMs: performance.now(),
    callId: identity.callId,
    workerBootId: identity.workerBootId ?? null,
    speechId: identity.speechId ?? null,
    turnId: identity.turnId ?? null,
    synthesisId: identity.synthesisId ?? null,
    engineAttemptSeq: identity.engineAttemptSeq ?? null,
    ...payload,
  } as VoiceDiagnosticEvent;
}

export interface TrackedVoiceLogger {
  writeTracked(
    level: Level,
    msg: string,
    data: Record<string, unknown> | undefined,
    callback: (result: LogWriteResult) => void,
  ): void;
  trackedSinkSnapshot(): { sinkErrors: number };
}

export interface VoiceTraceWriteCounts {
  attempted: number;
  acknowledged: number;
  filtered: number;
  failed: number;
  overflow: number;
  pending: number;
  unacknowledged: number;
  sinkErrors: number;
  complete: boolean;
}

export interface VoiceTraceWriter {
  write(event: VoiceDiagnosticEvent): void;
  emit(event: VoiceDiagnosticEvent): void;
  snapshot(): VoiceTraceWriteCounts;
  settleWrites(timeoutMs?: number): Promise<VoiceTraceWriteCounts>;
}

export function createVoiceTraceWriter(
  logger: TrackedVoiceLogger = createLogger("voice-diagnostics"),
): VoiceTraceWriter {
  const startSinkErrors = safeSinkErrors(logger);
  const counts = { attempted: 0, acknowledged: 0, filtered: 0, failed: 0, overflow: 0 };
  const pending = new Set<object>();
  const waiters = new Set<() => void>();
  let unacknowledged = 0;
  let unreportedFailures = 0;
  let gapInFlight = false;

  const notifyWaiters = () => {
    if (pending.size !== 0) return;
    for (const waiter of [...waiters]) waiter();
    waiters.clear();
  };

  const writeInternal = (event: VoiceDiagnosticEvent, isGap: boolean): void => {
    counts.attempted += 1;
    const token = {};
    pending.add(token);
    let callbackRan = false;
    try {
      logger.writeTracked("info", event.event, event as unknown as Record<string, unknown>, (result) => {
        if (callbackRan) return;
        callbackRan = true;
        if (!pending.delete(token)) return;
        counts[result === "acknowledged" ? "acknowledged" : result] += 1;

        if (isGap) {
          gapInFlight = false;
          if (result === "acknowledged") {
            const reported = (event as TraceEnvelope & GapPayload).count;
            unreportedFailures = Math.max(0, unreportedFailures - reported);
          }
        } else if (result === "acknowledged") {
          if (unreportedFailures > 0 && !gapInFlight) {
            const reportCount = unreportedFailures;
            gapInFlight = true;
            writeInternal(
              voiceDiagnosticEvent(
                {
                  component: event.component,
                  callId: event.callId,
                  workerBootId: event.workerBootId,
                  clockId: event.clockId,
                },
                { event: "diagnostic_gap", reason: "log_write_failed", count: reportCount },
              ),
              true,
            );
          }
        } else {
          unreportedFailures += 1;
        }
        notifyWaiters();
      });
    } catch {
      if (!callbackRan && pending.delete(token)) {
        callbackRan = true;
        counts.failed += 1;
        if (!isGap) unreportedFailures += 1;
        else gapInFlight = false;
        notifyWaiters();
      }
    }
  };

  const snapshot = (): VoiceTraceWriteCounts => {
    const sinkErrors = Math.max(0, safeSinkErrors(logger) - startSinkErrors);
    return {
      ...counts,
      pending: pending.size,
      unacknowledged,
      sinkErrors,
      complete:
        counts.filtered === 0 &&
        counts.failed === 0 &&
        counts.overflow === 0 &&
        pending.size === 0 &&
        unacknowledged === 0 &&
        sinkErrors === 0,
    };
  };

  return {
    write: (event) => writeInternal(event, false),
    emit: (event) => writeInternal(event, false),
    snapshot,
    async settleWrites(timeoutMs = 250) {
      if (pending.size > 0) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            waiters.delete(finish);
            resolve();
          };
          const timer = setTimeout(finish, Math.max(0, timeoutMs));
          waiters.add(finish);
          if (pending.size === 0) finish();
        });
      }
      if (pending.size > 0) {
        unacknowledged += pending.size;
        pending.clear();
        notifyWaiters();
      }
      return snapshot();
    },
  };
}

function safeSinkErrors(logger: TrackedVoiceLogger): number {
  try {
    const value = logger.trackedSinkSnapshot().sinkErrors;
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}
