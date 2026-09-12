import type {
  AttemptOutcome,
  DiagnosticGapReason,
  Measure,
  SpeechOrigin,
  VoiceDiagnosticEvent,
  VoiceDiagnosticEventName,
} from "./voice-trace.js";
import { nearestRankPercentile } from "./percentile.js";

export const MAX_VOICE_DIAGNOSTIC_BYTES = 32 * 1024 * 1024;

export class VoiceDiagnosticInputError extends Error {}
export class UnsupportedVoiceDiagnosticVersionError extends VoiceDiagnosticInputError {}

type EntityKind = "speech" | "bridge" | "synthesis" | "engineRequest" | "engineAttempt";
type ReportOutcome = AttemptOutcome | "unknown";
type IncompleteReason = "process_loss_or_missing_terminal" | "missing_start" | "explicit_incomplete";

const OUTCOMES = ["completed", "interrupted", "cancelled", "failed", "incomplete", "unknown"] as const;
const ENTITY_KINDS = ["speech", "bridge", "synthesis", "engineRequest", "engineAttempt"] as const;
const ATTEMPT_OUTCOMES = new Set<AttemptOutcome>(["completed", "interrupted", "cancelled", "failed", "incomplete"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MISSING_REASONS = new Set(["not_reached", "not_applicable", "not_observed", "correlation_missing"]);
const GAP_REASONS = new Set<DiagnosticGapReason>([
  "association_overflow",
  "active_overflow",
  "recent_cache_evicted",
  "binding_conflict",
  "correlation_missing",
  "listener_failed",
  "log_write_failed",
  "late_error_observed",
  "cancel_failed",
  "action_ownership_unproved",
  "action_overflow",
  "provider_context_missing",
  "start_pending",
  "teardown_failed",
  "teardown_timeout",
]);

type OutcomeCounts = Record<ReportOutcome, number>;
type KindCounts = Record<EntityKind, number>;

export interface VoiceDiagnosticEntityDetail {
  kind: EntityKind;
  key: string;
  clockId: string;
  workerBootId: string | null;
  speechId: string | null;
  turnId: string | null;
  synthesisId: string | null;
  engineAttemptSeq: number | null;
  firstObservation: { eventId: string; event: VoiceDiagnosticEventName; ts: string; monoMs: number };
  started: boolean;
  terminalEventId: string | null;
  outcome: ReportOutcome;
  incompleteReason: IncompleteReason | null;
  boundSpeechId: string | null;
  bindings: Array<{ eventId: string; speechId: string }>;
  lateSupplements: Array<{
    eventId: string;
    event: VoiceDiagnosticEventName;
    ts: string;
    monoMs: number;
  }>;
}

export interface VoiceDiagnosticReport {
  schemaVersion: 2;
  callId: string;
  complete: boolean;
  speechAttempts: number;
  bridgeAttempts: number;
  synthesisAttempts: number;
  engineRequests: number;
  engineAttempts: number;
  byOutcome: Record<EntityKind, OutcomeCounts>;
  synthesizedAudioObserved: number;
  generatedAudioObserved: number;
  playoutObserved: number;
  unbound: { total: number; byEntity: KindCounts };
  incomplete: {
    total: number;
    byReason: Record<IncompleteReason, number>;
    byEntity: KindCounts;
  };
  gaps: { total: number; byReason: Partial<Record<DiagnosticGapReason, number>> };
  malformedRows: number;
  truncatedRows: number;
  conflictingTerminals: number;
  callerConfirmation: "unknown";
  callLevelObservations: {
    outputPlayback: number;
    falseInterruption: number;
  };
  distributions: {
    estimatedEouToFirstGeneratedAudioMs: {
      description: "stage sum: EOU + matching bridge first text + matching TTS TTFB; not measured end-to-end";
      unit: "ms";
      eligibleAttempts: number;
      samples: number[];
      min: number | null;
      p50: number | null;
      p95: number | null;
      max: number | null;
      excludedByReason: Record<LatencyExclusionReason, number>;
    };
  };
  details: Record<EntityKind, VoiceDiagnosticEntityDetail[]>;
}

export type LatencyExclusionReason =
  | "not_applicable"
  | "interrupted"
  | "cancelled"
  | "failed"
  | "incomplete"
  | "ambiguous_components"
  | "missing_eou"
  | "missing_bridge_first_text"
  | "missing_tts_metric"
  | "missing_generated_audio";

interface ParsedRows {
  events: VoiceDiagnosticEvent[];
  malformedRows: number;
  truncatedRows: number;
}

interface EntityState {
  kind: EntityKind;
  key: string;
  clockId: string;
  workerBootId: string | null;
  speechId: string | null;
  turnId: string | null;
  synthesisId: string | null;
  engineAttemptSeq: number | null;
  first: VoiceDiagnosticEvent;
  seenEventIds: Set<string>;
  started: boolean;
  terminal: VoiceDiagnosticEvent | null;
  terminalConflict: boolean;
  boundSpeechId: string | null | "conflict";
  origin: SpeechOrigin | null;
  eouMetrics: VoiceDiagnosticEvent[];
  ttsMetrics: VoiceDiagnosticEvent[];
  bridgeFirstText: Measure | null;
  generatedAudio: boolean;
  playout: boolean;
  bindings: Array<{ eventId: string; speechId: string }>;
  lateSupplements: VoiceDiagnosticEvent[];
}

const COMMON_FIELDS = new Set([
  "kind",
  "schemaVersion",
  "eventId",
  "event",
  "ts",
  "component",
  "clockId",
  "monoMs",
  "callId",
  "workerBootId",
  "speechId",
  "turnId",
  "synthesisId",
  "engineAttemptSeq",
  "level",
  "msg",
]);

const PAYLOAD_FIELDS: Record<VoiceDiagnosticEventName, readonly string[]> = {
  call_started: ["direction", "intendedParticipant"],
  session_started: ["direction", "intendedParticipant"],
  sip_answered: ["direction", "intendedParticipant"],
  participant_available: ["direction", "intendedParticipant"],
  caller_state: ["state"],
  caller_final_input: ["hasFinalInput"],
  caller_turn_accepted: ["acceptedEpoch", "hasFinalInput"],
  opening_decision: ["decision", "reason", "acceptedEpoch", "hasFinalInput"],
  call_closed: ["reason"],
  speech_started: ["origin", "acceptedEpoch", "source", "generatedAudio", "knownPlayout"],
  speech_terminal: [
    "origin",
    "acceptedEpoch",
    "source",
    "outcome",
    "cause",
    "generatedAudio",
    "knownPlayout",
    "sdkSettled",
    "sdkInterrupted",
    "textLength",
    "startedSpeakingAt",
    "generatedDurationMs",
    "errorClass",
  ],
  bridge_created: [],
  bridge_started: ["late"],
  bridge_response: ["status", "late"],
  bridge_first_text: ["textLength", "firstTextMs", "late"],
  bridge_terminal: ["status", "textLength", "firstTextMs", "maximumGapMs", "outcome", "cause", "errorClass", "late"],
  bridge_bound: ["source"],
  synthesis_bound: ["source"],
  synthesis_started: [],
  synthesis_first_frame: ["frameCount", "sampleCount", "sampleRate", "sampleRateReason", "generatedDurationMs", "late"],
  synthesis_terminal: [
    "frameCount",
    "sampleCount",
    "sampleRate",
    "sampleRateReason",
    "generatedDurationMs",
    "outcome",
    "cause",
    "errorClass",
    "late",
  ],
  sdk_metric: [
    "source",
    "metric",
    "eouMs",
    "transcriptionMs",
    "onUserTurnCompletedMs",
    "ttftMs",
    "ttfbMs",
    "durationMs",
    "startedSpeakingAt",
    "interruptionCount",
    "textLength",
    "interrupted",
    "errorClass",
  ],
  handle_playout_item: [
    "source",
    "metric",
    "textLength",
    "interrupted",
    "startedSpeakingAt",
    "durationMs",
    "errorClass",
  ],
  output_playback: ["source", "metric", "durationMs", "interrupted", "errorClass"],
  false_interruption: ["source", "durationMs", "errorClass"],
  engine_received: ["correlation"],
  engine_attempt_started: ["continuity"],
  engine_first_text: ["textLength", "firstTextMs"],
  engine_client_closed: [],
  engine_attempt_terminal: [
    "continuity",
    "launchAdmission",
    "selectedContinuity",
    "warm",
    "toolCount",
    "toolMs",
    "toolAckInjected",
    "outcome",
    "errorClass",
    "durationMs",
    "lockWaitMs",
    "spawnPrepMs",
    "initToFirstTokenMs",
    "firstTextMs",
    "stopped",
  ],
  engine_terminal: [
    "status",
    "outcome",
    "errorClass",
    "admissionMs",
    "firstTextMs",
    "durationMs",
    "promptBuildMs",
    "sessionLookupMs",
    "lockWaitMs",
    "spawnPrepMs",
    "initToFirstTokenMs",
    "responseCompleteMs",
    "clientGone",
    "correlation",
    "continuityAttempted",
    "stopped",
    "generatedAudio",
    "textLength",
    "warm",
    "toolCount",
    "toolMs",
    "toolAckInjected",
  ],
  diagnostic_gap: ["reason", "count"],
  teardown: ["result", "reason"],
  summary_persistence: ["status", "reason"],
};

const EVENT_NAMES = new Set(Object.keys(PAYLOAD_FIELDS));
const ENGINE_EVENTS = new Set<VoiceDiagnosticEventName>([
  "engine_received",
  "engine_attempt_started",
  "engine_first_text",
  "engine_client_closed",
  "engine_attempt_terminal",
  "engine_terminal",
]);

export function parseVoiceDiagnosticJsonl(input: string, callId: string): ParsedRows {
  assertBoundedInput(Buffer.byteLength(input));
  if (callId.trim().length === 0) throw new VoiceDiagnosticInputError("--call-id must be non-empty");
  const events: VoiceDiagnosticEvent[] = [];
  let malformedRows = 0;
  let truncatedRows = 0;
  const endsWithLineBreak = input.length === 0 || input.endsWith("\n") || input.endsWith("\r");
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformedRows += 1;
      if (index === lines.length - 1 && !endsWithLineBreak) truncatedRows += 1;
      continue;
    }
    if (!isRecord(value) || value.kind !== "voice_diagnostic") continue;
    if (value.callId !== callId) continue;
    if (value.schemaVersion !== 2) {
      throw new UnsupportedVoiceDiagnosticVersionError(
        `selected voice_diagnostic row uses unsupported schemaVersion ${String(value.schemaVersion)}; expected 2`,
      );
    }
    const parsed = parseVoiceDiagnosticEvent(value);
    if (parsed === null) malformedRows += 1;
    else events.push(parsed);
  }
  return { events, malformedRows, truncatedRows };
}

export function parseVoiceDiagnosticEvent(value: unknown): VoiceDiagnosticEvent | null {
  if (!isRecord(value) || value.kind !== "voice_diagnostic" || value.schemaVersion !== 2) return null;
  if (typeof value.event !== "string" || !EVENT_NAMES.has(value.event)) return null;
  const event = value.event as VoiceDiagnosticEventName;
  const allowed = new Set([...COMMON_FIELDS, ...PAYLOAD_FIELDS[event]]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (
    !nonempty(value.eventId) ||
    !nonempty(value.ts) ||
    !Number.isFinite(Date.parse(value.ts)) ||
    (value.component !== "voice-worker" && value.component !== "voice-engine") ||
    !nonempty(value.clockId) ||
    !finiteNonnegative(value.monoMs) ||
    !nonempty(value.callId) ||
    !(value.workerBootId === null || (nonempty(value.workerBootId) && UUID.test(value.workerBootId))) ||
    !nullableString(value.speechId) ||
    !nullableString(value.turnId) ||
    !nullableString(value.synthesisId) ||
    !(value.engineAttemptSeq === null || positiveInteger(value.engineAttemptSeq))
  ) {
    return null;
  }
  if (
    ENGINE_EVENTS.has(event)
      ? value.component !== "voice-engine"
      : event !== "diagnostic_gap" && value.component !== "voice-worker"
  ) {
    return null;
  }
  if (value.component === "voice-worker" && value.engineAttemptSeq !== null) return null;
  if (ENGINE_EVENTS.has(event) && !nonempty(value.turnId)) return null;
  if (
    (event === "engine_attempt_started" || event === "engine_first_text" || event === "engine_attempt_terminal") &&
    !positiveInteger(value.engineAttemptSeq)
  ) {
    return null;
  }
  if ((event === "engine_received" || event === "engine_client_closed") && value.engineAttemptSeq !== null) return null;
  if (
    (event === "speech_started" || event === "speech_terminal") &&
    (!nonempty(value.workerBootId) || !nonempty(value.speechId))
  ) {
    return null;
  }
  if (event.startsWith("bridge_") && (!nonempty(value.workerBootId) || !nonempty(value.turnId))) return null;
  if (event.startsWith("synthesis_") && (!nonempty(value.workerBootId) || !nonempty(value.synthesisId))) return null;
  if ((event === "bridge_bound" || event === "synthesis_bound") && !nonempty(value.speechId)) return null;
  if (!validatePayload(value, event)) return null;
  return value as unknown as VoiceDiagnosticEvent;
}

export function reduceVoiceDiagnostics(input: string | ParsedRows, callId: string): VoiceDiagnosticReport {
  const parsed = typeof input === "string" ? parseVoiceDiagnosticJsonl(input, callId) : input;
  const maps: Record<EntityKind, Map<string, EntityState>> = {
    speech: new Map(),
    bridge: new Map(),
    synthesis: new Map(),
    engineRequest: new Map(),
    engineAttempt: new Map(),
  };
  const gaps: Partial<Record<DiagnosticGapReason, number>> = {};
  const engineReceived = new Map<string, VoiceDiagnosticEvent>();
  let gapTotal = 0;
  let conflictingTerminals = 0;
  let outputPlayback = 0;
  let falseInterruption = 0;
  const callObservationEventIds = new Set<string>();
  const gapEventIds = new Set<string>();
  const unresolvedIdentityEventIds = new Set<string>();
  const invalidatedBridgeBindings = new Set<string>();
  const invalidatedSynthesisBindings = new Set<string>();

  const recordCorrelationMissing = (row: VoiceDiagnosticEvent) => {
    if (unresolvedIdentityEventIds.has(row.eventId)) return;
    unresolvedIdentityEventIds.add(row.eventId);
    gaps.correlation_missing = (gaps.correlation_missing ?? 0) + 1;
    gapTotal += 1;
  };

  const observe = (kind: EntityKind, key: string, row: VoiceDiagnosticEvent, start: boolean, terminal: boolean) => {
    let state = maps[kind].get(key);
    if (!state) {
      state = makeState(kind, key, row);
      maps[kind].set(key, state);
    }
    if (state.seenEventIds.has(row.eventId)) return { state, isNew: false };
    const arrivedAfterTerminal = state.terminal !== null;
    state.seenEventIds.add(row.eventId);
    state.started ||= start;
    if (terminal) {
      if (state.terminal === null) state.terminal = row;
      else {
        state.terminalConflict = true;
        conflictingTerminals += 1;
      }
    }
    if (!terminal && (arrivedAfterTerminal || ("late" in row && row.late === true))) state.lateSupplements.push(row);
    return { state, isNew: true };
  };

  for (const row of parsed.events) {
    if (
      row.speechId === null &&
      (row.event === "output_playback" || row.event === "false_interruption") &&
      !callObservationEventIds.has(row.eventId)
    ) {
      callObservationEventIds.add(row.eventId);
      if (row.event === "output_playback") outputPlayback += 1;
      else falseInterruption += 1;
    }
    if (row.event === "diagnostic_gap") {
      if (gapEventIds.has(row.eventId)) continue;
      gapEventIds.add(row.eventId);
      const count = row.count;
      gaps[row.reason] = (gaps[row.reason] ?? 0) + count;
      gapTotal += count;
      if (row.reason === "binding_conflict" && row.workerBootId) {
        if (row.turnId) invalidatedBridgeBindings.add(workerKey(row.workerBootId, row.turnId));
        if (row.synthesisId) invalidatedSynthesisBindings.add(workerKey(row.workerBootId, row.synthesisId));
      }
      continue;
    }
    // Attempt-bearing supplemental observations (a playout handle, or an ID-bearing LLM/TTS SDK
    // metric) can carry a valid schema with an unresolved identity half — unlike primary lifecycle
    // rows (speech_started/terminal, bridge_*, synthesis_*), parsing does not require their full
    // correlation tuple. Left unchecked, such a row silently vanishes from the reduction (neither an
    // entity nor a gap), so a call can read back `complete: true` with zero incomplete entities while
    // a real attempt's evidence was dropped. Explicitly account it as a correlation gap instead of
    // letting it disappear — this must not fire for legitimate call-level observations (output_playback
    // / false_interruption with a null speechId, handled above) or for optional unbound associations
    // (an SDK metric row that carries neither correlating id at all, e.g. not tied to any attempt).
    if (row.event === "handle_playout_item" && (row.workerBootId === null || row.speechId === null)) {
      recordCorrelationMissing(row);
      continue;
    }
    if (
      row.event === "sdk_metric" &&
      row.source === "sdk_metrics_context" &&
      row.workerBootId === null &&
      ((row.metric === "llm" && row.turnId !== null) || (row.metric === "tts" && row.synthesisId !== null))
    ) {
      recordCorrelationMissing(row);
      continue;
    }
    if (isSpeechEvidence(row) && row.workerBootId && row.speechId) {
      const observed = observe(
        "speech",
        workerKey(row.workerBootId, row.speechId),
        row,
        row.event === "speech_started",
        row.event === "speech_terminal",
      );
      const { state } = observed;
      if (observed.isNew) {
        if (row.event === "speech_started" || row.event === "speech_terminal") state.origin = row.origin;
        if (row.event === "sdk_metric" && row.metric === "eou") state.eouMetrics.push(row);
        if (row.event === "speech_terminal") {
          state.generatedAudio ||= row.generatedAudio === true;
          state.playout ||= row.knownPlayout === true;
        }
        if (
          (row.event === "handle_playout_item" && measureValue(row.startedSpeakingAt) !== null) ||
          row.event === "output_playback"
        ) {
          state.playout = true;
        }
      }
    }
    if (isBridgeEvidence(row) && row.workerBootId && row.turnId) {
      const observed = observe(
        "bridge",
        workerKey(row.workerBootId, row.turnId),
        row,
        row.event === "bridge_created",
        row.event === "bridge_terminal",
      );
      const { state } = observed;
      if (observed.isNew) {
        if (row.event === "bridge_bound" && row.speechId) {
          bind(state, row.speechId);
          state.bindings.push({ eventId: row.eventId, speechId: row.speechId });
        }
        if (row.event === "bridge_first_text" && state.bridgeFirstText === null)
          state.bridgeFirstText = row.firstTextMs ?? null;
        if (row.event === "bridge_terminal" && state.bridgeFirstText === null)
          state.bridgeFirstText = row.firstTextMs ?? null;
      }
    }
    if (isSynthesisEvidence(row) && row.workerBootId && row.synthesisId) {
      const observed = observe(
        "synthesis",
        workerKey(row.workerBootId, row.synthesisId),
        row,
        row.event === "synthesis_started",
        row.event === "synthesis_terminal",
      );
      const { state } = observed;
      if (observed.isNew) {
        if (row.event === "synthesis_bound" && row.speechId) {
          bind(state, row.speechId);
          state.bindings.push({ eventId: row.eventId, speechId: row.speechId });
        }
        if (row.event === "sdk_metric" && row.metric === "tts" && row.source === "sdk_metrics_context")
          state.ttsMetrics.push(row);
        if (
          row.event === "synthesis_first_frame" ||
          (row.event === "synthesis_terminal" && (row.frameCount ?? 0) > 0)
        ) {
          state.generatedAudio = true;
        }
      }
    }
    if (isEngineEvent(row) && row.turnId) {
      const requestKey = engineRequestKey(row.clockId, row.turnId);
      observe("engineRequest", requestKey, row, row.event === "engine_received", row.event === "engine_terminal");
      if (row.event === "engine_received" && !engineReceived.has(requestKey)) engineReceived.set(requestKey, row);
      if (isEngineAttemptEvidence(row) && row.engineAttemptSeq !== null) {
        observe(
          "engineAttempt",
          `${requestKey}\u0000${row.engineAttemptSeq}`,
          row,
          row.event === "engine_attempt_started",
          row.event === "engine_attempt_terminal",
        );
      }
    }
  }

  for (const key of invalidatedBridgeBindings) {
    const bridge = maps.bridge.get(key);
    if (bridge) bridge.boundSpeechId = "conflict";
  }
  for (const key of invalidatedSynthesisBindings) {
    const synthesis = maps.synthesis.get(key);
    if (synthesis) synthesis.boundSpeechId = "conflict";
  }
  const invalidatedGeneratedSpeech = new Set<string>();
  for (const synthesis of maps.synthesis.values()) {
    if (synthesis.boundSpeechId !== "conflict" || !synthesis.workerBootId) continue;
    for (const binding of synthesis.bindings) {
      invalidatedGeneratedSpeech.add(workerKey(synthesis.workerBootId, binding.speechId));
    }
  }

  // Explicit worker binding plus valid engine trace metadata is the only cross-process join.
  for (const request of maps.engineRequest.values()) {
    const received = engineReceived.get(request.key);
    if (
      !received ||
      received.event !== "engine_received" ||
      received.correlation !== "worker" ||
      !received.workerBootId ||
      !UUID.test(received.workerBootId) ||
      !received.turnId
    )
      continue;
    const bridge = maps.bridge.get(workerKey(received.workerBootId, received.turnId));
    if (bridge?.boundSpeechId && bridge.boundSpeechId !== "conflict") request.boundSpeechId = bridge.boundSpeechId;
  }
  for (const attempt of maps.engineAttempt.values()) {
    const request = maps.engineRequest.get(attempt.key.slice(0, attempt.key.lastIndexOf("\u0000")));
    if (request?.boundSpeechId && request.boundSpeechId !== "conflict") attempt.boundSpeechId = request.boundSpeechId;
  }

  const byOutcome = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, emptyOutcomeCounts()])) as Record<
    EntityKind,
    OutcomeCounts
  >;
  const incompleteByEntity = emptyKindCounts();
  const incompleteByReason: Record<IncompleteReason, number> = {
    process_loss_or_missing_terminal: 0,
    missing_start: 0,
    explicit_incomplete: 0,
  };
  const unboundByEntity = emptyKindCounts();
  const details = Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, []])) as unknown as Record<
    EntityKind,
    VoiceDiagnosticEntityDetail[]
  >;
  let incompleteTotal = 0;
  let unboundTotal = 0;
  const effectiveStates = new Map<EntityState, EffectiveEntityState>();

  for (const kind of ENTITY_KINDS) {
    for (const state of maps[kind].values()) {
      const effective = effectiveEntityState(state);
      effectiveStates.set(state, effective);
      const { incompleteReason, outcome } = effective;
      byOutcome[kind][outcome] += 1;
      if (incompleteReason) {
        incompleteTotal += 1;
        incompleteByEntity[kind] += 1;
        incompleteByReason[incompleteReason] += 1;
      }
      if (
        (kind === "bridge" || kind === "synthesis" || kind === "engineRequest" || kind === "engineAttempt") &&
        state.boundSpeechId === null
      ) {
        unboundTotal += 1;
        unboundByEntity[kind] += 1;
      } else if (state.boundSpeechId === "conflict") {
        unboundTotal += 1;
        unboundByEntity[kind] += 1;
      }
      details[kind].push(toDetail(state, outcome, incompleteReason));
    }
    details[kind].sort((a, b) => a.key.localeCompare(b.key));
  }

  const exclusions = emptyLatencyExclusions();
  const samples: number[] = [];
  const bridgesBySpeech = groupBoundEntities(maps.bridge);
  const synthesesBySpeech = groupBoundEntities(maps.synthesis);
  for (const speech of maps.speech.values()) {
    const reason = latencyExclusion(
      speech,
      bridgesBySpeech.get(speech.key) ?? [],
      synthesesBySpeech.get(speech.key) ?? [],
      effectiveStates,
    );
    if (typeof reason === "string") exclusions[reason] += 1;
    else samples.push(reason);
  }
  samples.sort((a, b) => a - b);

  const generatedSpeech = new Set<string>();
  let synthesizedAudioObserved = 0;
  const playoutSpeech = new Set<string>();
  for (const speech of maps.speech.values()) {
    if (speech.generatedAudio && !invalidatedGeneratedSpeech.has(speech.key)) generatedSpeech.add(speech.key);
    if (speech.playout) playoutSpeech.add(speech.key);
  }
  for (const synthesis of maps.synthesis.values()) {
    if (synthesis.generatedAudio) synthesizedAudioObserved += 1;
    if (
      synthesis.generatedAudio &&
      synthesis.boundSpeechId &&
      synthesis.boundSpeechId !== "conflict" &&
      synthesis.workerBootId
    ) {
      generatedSpeech.add(workerKey(synthesis.workerBootId, synthesis.boundSpeechId));
    }
  }

  const complete =
    parsed.malformedRows === 0 &&
    parsed.truncatedRows === 0 &&
    gapTotal === 0 &&
    conflictingTerminals === 0 &&
    incompleteTotal === 0;
  return {
    schemaVersion: 2,
    callId,
    complete,
    speechAttempts: maps.speech.size,
    bridgeAttempts: maps.bridge.size,
    synthesisAttempts: maps.synthesis.size,
    engineRequests: maps.engineRequest.size,
    engineAttempts: maps.engineAttempt.size,
    byOutcome,
    synthesizedAudioObserved,
    generatedAudioObserved: generatedSpeech.size,
    playoutObserved: playoutSpeech.size,
    unbound: { total: unboundTotal, byEntity: unboundByEntity },
    incomplete: { total: incompleteTotal, byReason: incompleteByReason, byEntity: incompleteByEntity },
    gaps: { total: gapTotal, byReason: gaps },
    malformedRows: parsed.malformedRows,
    truncatedRows: parsed.truncatedRows,
    conflictingTerminals,
    callerConfirmation: "unknown",
    callLevelObservations: { outputPlayback, falseInterruption },
    distributions: {
      estimatedEouToFirstGeneratedAudioMs: {
        description: "stage sum: EOU + matching bridge first text + matching TTS TTFB; not measured end-to-end",
        unit: "ms",
        eligibleAttempts: samples.length,
        samples,
        min: samples[0] ?? null,
        p50: nearestRankPercentile(samples, 50),
        p95: nearestRankPercentile(samples, 95),
        max: samples.at(-1) ?? null,
        excludedByReason: exclusions,
      },
    },
    details,
  };
}

export function assertBoundedInput(byteLength: number): void {
  if (byteLength > MAX_VOICE_DIAGNOSTIC_BYTES) {
    throw new VoiceDiagnosticInputError(
      `voice diagnostic input exceeds 32 MiB; supply a call-filtered file no larger than 32 MiB`,
    );
  }
}

function makeState(kind: EntityKind, key: string, row: VoiceDiagnosticEvent): EntityState {
  return {
    kind,
    key,
    clockId: row.clockId,
    workerBootId: row.workerBootId,
    speechId: kind === "speech" ? row.speechId : null,
    turnId: kind === "bridge" || kind === "engineRequest" || kind === "engineAttempt" ? row.turnId : null,
    synthesisId: kind === "synthesis" ? row.synthesisId : null,
    engineAttemptSeq: kind === "engineAttempt" ? row.engineAttemptSeq : null,
    first: row,
    seenEventIds: new Set(),
    started: false,
    terminal: null,
    terminalConflict: false,
    boundSpeechId: kind === "speech" ? row.speechId : null,
    origin: null,
    eouMetrics: [],
    ttsMetrics: [],
    bridgeFirstText: null,
    generatedAudio: false,
    playout: false,
    bindings: [],
    lateSupplements: [],
  };
}

function bind(state: EntityState, speechId: string): void {
  if (state.boundSpeechId === null) state.boundSpeechId = speechId;
  else if (state.boundSpeechId !== speechId) state.boundSpeechId = "conflict";
}

function toDetail(
  state: EntityState,
  outcome: ReportOutcome,
  incompleteReason: IncompleteReason | null,
): VoiceDiagnosticEntityDetail {
  return {
    kind: state.kind,
    key: state.key,
    clockId: state.clockId,
    workerBootId: state.workerBootId,
    speechId: state.speechId,
    turnId: state.turnId,
    synthesisId: state.synthesisId,
    engineAttemptSeq: state.engineAttemptSeq,
    firstObservation: {
      eventId: state.first.eventId,
      event: state.first.event,
      ts: state.first.ts,
      monoMs: state.first.monoMs,
    },
    started: state.started,
    terminalEventId: state.terminal?.eventId ?? null,
    outcome,
    incompleteReason,
    boundSpeechId: state.boundSpeechId === "conflict" ? null : state.boundSpeechId,
    bindings: state.bindings,
    lateSupplements: state.lateSupplements.map((row) => ({
      eventId: row.eventId,
      event: row.event,
      ts: row.ts,
      monoMs: row.monoMs,
    })),
  };
}

function latencyExclusion(
  speech: EntityState,
  boundBridges: EntityState[],
  boundSyntheses: EntityState[],
  effectiveStates: Map<EntityState, EffectiveEntityState>,
): LatencyExclusionReason | number {
  if (speech.origin !== "sdk_response") return "not_applicable";
  const outcome = effectiveStates.get(speech)?.outcome ?? "incomplete";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "interrupted" || (speech.terminal?.event === "speech_terminal" && speech.terminal.sdkInterrupted))
    return "interrupted";
  if (outcome === "failed") return "failed";
  if (outcome !== "completed") return "incomplete";
  if (boundBridges.length > 1 || boundSyntheses.length > 1 || speech.eouMetrics.length > 1)
    return "ambiguous_components";
  const eou = speech.eouMetrics[0];
  if (!eou || eou.event !== "sdk_metric" || measureValue(eou.eouMs) === null) return "missing_eou";
  const bridge = boundBridges[0];
  const bridgeOutcome = bridge ? effectiveStates.get(bridge)?.outcome : null;
  if (bridgeOutcome && bridgeOutcome !== "completed") return componentExclusion(bridgeOutcome);
  if (!bridge || measureValue(bridge.bridgeFirstText) === null) {
    return "missing_bridge_first_text";
  }
  const synthesis = boundSyntheses[0];
  const synthesisOutcome = synthesis ? effectiveStates.get(synthesis)?.outcome : null;
  if (synthesisOutcome && synthesisOutcome !== "completed") return componentExclusion(synthesisOutcome);
  if (!synthesis) return "missing_generated_audio";
  if (synthesis.ttsMetrics.length > 1) return "ambiguous_components";
  const tts = synthesis.ttsMetrics[0];
  if (!tts || tts.event !== "sdk_metric" || measureValue(tts.ttfbMs) === null) return "missing_tts_metric";
  if (!synthesis.generatedAudio) return "missing_generated_audio";
  return measureValue(eou.eouMs)! + measureValue(bridge.bridgeFirstText)! + measureValue(tts.ttfbMs)!;
}

interface EffectiveEntityState {
  outcome: ReportOutcome;
  incompleteReason: IncompleteReason | null;
}

function effectiveEntityState(state: EntityState): EffectiveEntityState {
  if (state.terminalConflict) return { outcome: "unknown", incompleteReason: null };
  if (!state.started) return { outcome: "incomplete", incompleteReason: "missing_start" };
  if (state.terminal === null) {
    return { outcome: "incomplete", incompleteReason: "process_loss_or_missing_terminal" };
  }
  const outcome = terminalOutcome(state.terminal);
  return outcome === "incomplete"
    ? { outcome, incompleteReason: "explicit_incomplete" }
    : { outcome, incompleteReason: null };
}

function componentExclusion(outcome: ReportOutcome): LatencyExclusionReason {
  if (outcome === "failed") return "failed";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "interrupted") return "interrupted";
  return "incomplete";
}

function groupBoundEntities(entities: Map<string, EntityState>): Map<string, EntityState[]> {
  const grouped = new Map<string, EntityState[]>();
  for (const entity of entities.values()) {
    if (!entity.workerBootId || !entity.boundSpeechId || entity.boundSpeechId === "conflict") continue;
    const key = workerKey(entity.workerBootId, entity.boundSpeechId);
    const values = grouped.get(key);
    if (values) values.push(entity);
    else grouped.set(key, [entity]);
  }
  return grouped;
}

function terminalOutcome(row: VoiceDiagnosticEvent | null): ReportOutcome {
  return row && "outcome" in row && ATTEMPT_OUTCOMES.has(row.outcome as AttemptOutcome)
    ? (row.outcome as AttemptOutcome)
    : "unknown";
}

function isSpeechEvidence(row: VoiceDiagnosticEvent): boolean {
  if (row.speechId === null || row.workerBootId === null || !UUID.test(row.workerBootId)) return false;
  if (
    ["speech_started", "speech_terminal", "sdk_metric", "handle_playout_item", "output_playback"].includes(row.event)
  ) {
    return true;
  }
  return row.event.startsWith("bridge_") || row.event.startsWith("synthesis_");
}

function isBridgeEvidence(row: VoiceDiagnosticEvent): boolean {
  return (
    row.event.startsWith("bridge_") ||
    (row.event === "sdk_metric" &&
      row.metric === "llm" &&
      row.source === "sdk_metrics_context" &&
      row.turnId !== null &&
      row.workerBootId !== null &&
      UUID.test(row.workerBootId))
  );
}

function isSynthesisEvidence(row: VoiceDiagnosticEvent): boolean {
  return (
    row.event.startsWith("synthesis_") ||
    (row.event === "sdk_metric" && row.metric === "tts" && row.synthesisId !== null)
  );
}

function isEngineEvent(row: VoiceDiagnosticEvent): boolean {
  return row.component === "voice-engine" && row.event.startsWith("engine_");
}

function isEngineAttemptEvidence(row: VoiceDiagnosticEvent): boolean {
  return (
    row.event === "engine_attempt_started" ||
    row.event === "engine_first_text" ||
    row.event === "engine_attempt_terminal"
  );
}

function workerKey(workerBootId: string, id: string): string {
  return `${workerBootId}\u0000${id}`;
}

function engineRequestKey(clockId: string, turnId: string): string {
  return `${clockId}\u0000${turnId}`;
}

function emptyOutcomeCounts(): OutcomeCounts {
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as OutcomeCounts;
}

function emptyKindCounts(): KindCounts {
  return Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, 0])) as KindCounts;
}

function emptyLatencyExclusions(): Record<LatencyExclusionReason, number> {
  return {
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
  };
}

function measureValue(value: Measure | null | undefined): number | null {
  return value?.value !== null && value?.value !== undefined && finiteNonnegative(value.value) ? value.value : null;
}

function validatePayload(value: Record<string, unknown>, event: VoiceDiagnosticEventName): boolean {
  if ("outcome" in value && value.outcome !== undefined && !ATTEMPT_OUTCOMES.has(value.outcome as AttemptOutcome))
    return false;
  for (const field of [
    "firstTextMs",
    "maximumGapMs",
    "generatedDurationMs",
    "eouMs",
    "transcriptionMs",
    "onUserTurnCompletedMs",
    "ttftMs",
    "ttfbMs",
    "durationMs",
    "startedSpeakingAt",
    "admissionMs",
    "promptBuildMs",
    "sessionLookupMs",
    "lockWaitMs",
    "spawnPrepMs",
    "initToFirstTokenMs",
    "responseCompleteMs",
  ]) {
    if (field in value && value[field] !== undefined && !validMeasure(value[field])) return false;
  }
  for (const field of [
    "acceptedEpoch",
    "textLength",
    "frameCount",
    "sampleCount",
    "toolCount",
    "interruptionCount",
    "count",
  ]) {
    if (field in value && value[field] !== undefined && !nonnegativeInteger(value[field])) return false;
  }
  if (
    "status" in value &&
    value.status !== undefined &&
    event !== "summary_persistence" &&
    !nonnegativeInteger(value.status)
  ) {
    return false;
  }
  for (const field of ["sampleRate", "toolMs"]) {
    if (field in value && value[field] !== undefined && value[field] !== null && !finiteNonnegative(value[field]))
      return false;
  }
  for (const field of [
    "intendedParticipant",
    "hasFinalInput",
    "knownPlayout",
    "sdkSettled",
    "sdkInterrupted",
    "late",
    "interrupted",
    "warm",
    "toolAckInjected",
    "clientGone",
    "continuityAttempted",
    "stopped",
  ]) {
    if (field in value && value[field] !== undefined && typeof value[field] !== "boolean") return false;
  }
  if (
    "generatedAudio" in value &&
    value.generatedAudio !== undefined &&
    typeof value.generatedAudio !== "boolean" &&
    value.generatedAudio !== "unknown"
  ) {
    return false;
  }
  if (
    "origin" in value &&
    value.origin !== undefined &&
    !["opening", "sdk_response", "retry", "fallback"].includes(String(value.origin))
  ) {
    return false;
  }
  if (
    "source" in value &&
    value.source !== undefined &&
    !["application", "sdk_handle", "sdk_wall", "late_observation", "sdk_metrics_context", "media_output"].includes(
      String(value.source),
    )
  ) {
    return false;
  }
  if (
    "cause" in value &&
    value.cause !== undefined &&
    !["framework_cancelled", "call_closed", "startup_superseded", "unknown"].includes(String(value.cause))
  ) {
    return false;
  }
  if (
    "errorClass" in value &&
    value.errorClass !== undefined &&
    value.errorClass !== null &&
    ![
      "stream_construction_failed",
      "bridge_auth",
      "engine_auth",
      "engine_unreachable",
      "budget_saturated",
      "spawn_failed",
      "sse_write_failed",
      "midstream_error",
      "llm_provider_failed",
      "tts_provider_failed",
      "tts_node_failed",
      "speech_handle_failed",
      "unknown",
    ].includes(String(value.errorClass))
  ) {
    return false;
  }
  if (
    "correlation" in value &&
    value.correlation !== undefined &&
    !["worker", "legacy", "invalid"].includes(String(value.correlation))
  ) {
    return false;
  }
  if (
    "continuity" in value &&
    value.continuity !== undefined &&
    !["fresh", "warm", "resume", "full_transcript"].includes(String(value.continuity))
  ) {
    return false;
  }
  if (
    "sampleRateReason" in value &&
    value.sampleRateReason !== undefined &&
    value.sampleRateReason !== null &&
    !["not_reached", "not_applicable", "not_observed", "correlation_missing"].includes(String(value.sampleRateReason))
  ) {
    return false;
  }
  if (event === "speech_started" && (!nonempty(value.origin) || !nonnegativeInteger(value.acceptedEpoch))) return false;
  if (
    event === "speech_terminal" &&
    (!nonempty(value.origin) ||
      !nonnegativeInteger(value.acceptedEpoch) ||
      !ATTEMPT_OUTCOMES.has(value.outcome as AttemptOutcome))
  )
    return false;
  if (
    (event === "bridge_terminal" ||
      event === "synthesis_terminal" ||
      event === "engine_attempt_terminal" ||
      event === "engine_terminal") &&
    !ATTEMPT_OUTCOMES.has(value.outcome as AttemptOutcome)
  )
    return false;
  if ((event === "bridge_bound" || event === "synthesis_bound") && value.source !== "sdk_metrics_context") return false;
  if (
    event === "sdk_metric" &&
    (!nonempty(value.source) || !["eou", "llm", "tts", "interruption", "playout"].includes(String(value.metric)))
  )
    return false;
  if (event === "engine_received" && !["worker", "legacy", "invalid"].includes(String(value.correlation))) return false;
  if (
    event === "engine_attempt_started" &&
    !["fresh", "resume", "full_transcript"].includes(String(value.continuity))
  ) {
    return false;
  }
  if (
    event === "teardown" &&
    (!["closed", "failed", "timeout"].includes(String(value.result)) ||
      !["call_close", "late_start", "late_start_failed"].includes(String(value.reason)))
  )
    return false;
  if (event === "summary_persistence" && !["acknowledged", "failed"].includes(String(value.status))) return false;
  if (
    event === "diagnostic_gap" &&
    (!nonempty(value.reason) || !GAP_REASONS.has(value.reason as DiagnosticGapReason) || !positiveInteger(value.count))
  ) {
    return false;
  }
  return true;
}

function validMeasure(value: unknown): value is Measure {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "value" && key !== "reason")) return false;
  if (value.value === null) return typeof value.reason === "string" && MISSING_REASONS.has(value.reason);
  return finiteNonnegative(value.value) && value.reason === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): boolean {
  return value === null || nonempty(value);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
