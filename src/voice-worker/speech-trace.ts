import { performance } from "node:perf_hooks";

import type { MetricsCollectedEvent, SpeechCreatedEvent } from "@livekit/agents";

import {
  createVoiceTraceWriter,
  measure,
  voiceDiagnosticEvent,
  type AttemptOutcome,
  type CancellationCause,
  type SpeechOrigin,
  type VoiceErrorClass,
  type VoiceDiagnosticPayload,
  type VoiceTraceWriteCounts,
  type VoiceTraceWriter,
} from "../voice/voice-trace.js";
import {
  bridgeTraceContext,
  synthesisTraceContext,
  type BridgeTraceContext,
  type SynthesisTraceContext,
} from "./trace-context.js";

const ACTIVE_LIMIT = 256;
const RECENT_LIMIT = 256;
const SPEECH_BRIDGE_LIMIT = 16;
const SPEECH_SYNTHESIS_LIMIT = 32;
const SPEECH_FAILURE_SOURCE_LIMIT = SPEECH_BRIDGE_LIMIT + SPEECH_SYNTHESIS_LIMIT;
const LATENCY_SAMPLE_LIMIT = 1_024;

export type BridgeBinding =
  | { readonly state: "bound"; readonly speechId: string }
  | { readonly state: "unbound" }
  | { readonly state: "unavailable"; readonly reason: "evicted" | "conflict" | "closed" };

export type ActionGapReason = "cancel_failed" | "action_ownership_unproved" | "action_overflow";
export type SpeechHandle = SpeechCreatedEvent["speechHandle"];

export interface BridgeAttempt {
  started(): void;
  response(status: number): void;
  text(length: number, monoMs: number): void;
  fail(errorClass: VoiceErrorClass): void;
  finish(outcome: AttemptOutcome, cause: CancellationCause): void;
  bind(speechId: string): void;
}

export interface SynthesisAttempt {
  frame(frameMetadata: { sampleRate: number; samplesPerChannel: number }): void;
  fail(errorClass: "tts_provider_failed" | "tts_node_failed"): void;
  finish(outcome: AttemptOutcome, cause: CancellationCause): void;
  bind(speechId: string): void;
}

type OutcomeCounts = Record<AttemptOutcome, number>;

export interface AttemptKindCounts {
  speech: number;
  bridge: number;
  synthesis: number;
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

export type LatencyExclusions = Record<LatencyExclusionReason, number>;

export interface CallDiagnosticCounts {
  speechAttempts: number;
  speechOutcomes: OutcomeCounts;
  bridgeAttempts: number;
  bridgeOutcomes: OutcomeCounts;
  synthesisAttempts: number;
  synthesisOutcomes: OutcomeCounts;
  synthesizedAudioObserved: number;
  generatedAudioObserved: number;
  knownPlayoutObserved: number;
  sdkInterruptions: number;
  cancelledSpeechAttempts: number;
  incomplete: number;
  incompleteByAttemptKind: AttemptKindCounts;
  incompleteObservations: number;
  unbound: number;
  unboundByAttemptKind: AttemptKindCounts;
  unboundObservations: number;
  diagnosticGaps: number;
  latencyEstimateSamples: number[];
  eligibleLatencyEstimateCount: number;
  excludedByReason: LatencyExclusions;
  logging: VoiceTraceWriteCounts;
  registry: {
    activeSpeech: number;
    recentSpeech: number;
    activeBridge: number;
    recentBridge: number;
    activeSynthesis: number;
    recentSynthesis: number;
  };
}

export interface SpeechTracePort {
  call(
    event: Extract<
      VoiceDiagnosticPayload,
      {
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
      }
    >,
  ): void;
  speechCreated(handle: SpeechHandle, origin: SpeechOrigin, acceptedEpoch: number): void;
  bridgeCreated(context: BridgeTraceContext): BridgeAttempt;
  synthesisCreated(context: SynthesisTraceContext): SynthesisAttempt;
  bindBridge(turnId: string, speechId: string): void;
  bridgeBinding(turnId: string): BridgeBinding;
  onBridgeBinding(listener: (turnId: string) => void): () => void;
  bindSynthesis(synthesisId: string, speechId: string): void;
  markCancellation(speechId: string, cause: CancellationCause): void;
  synthesisFailure(synthesisId: string, errorClass: "tts_provider_failed"): void;
  unboundProviderFailure(kind: "tts" | "llm", errorClass: "tts_provider_failed" | "llm_provider_failed"): void;
  metrics(event: MetricsCollectedEvent): void;
  outputPlayback(durationMs?: number, interrupted?: boolean): void;
  falseInterruption(): void;
  actionGap(reason: ActionGapReason, speechId: string, turnId?: string): void;
  actionGap(reason: ActionGapReason, speechId: string | null, turnId: string): void;
  startupPending(): void;
  teardown(result: "closed" | "failed" | "timeout", reason: "call_close" | "late_start" | "late_start_failed"): void;
  summaryPersistence(
    status: "acknowledged" | "failed",
    reason?: "connect_failed" | "insert_failed" | "close_failed",
  ): void;
  close(cause: "call_closed" | "setup_failed"): void;
  snapshot(): CallDiagnosticCounts;
  settleWrites(timeoutMs?: number): Promise<VoiceTraceWriteCounts>;
}

interface SpeechOwner {
  readonly handle: SpeechHandle;
  readonly doneCallback: (handle: SpeechHandle) => void;
  readonly speechId: string;
  readonly origin: SpeechOrigin;
  readonly acceptedEpoch: number;
  terminalEmitted: boolean;
  errorClass: VoiceErrorClass | null;
  directErrorClass: VoiceErrorClass | null;
  readonly associatedFailures: Map<string, VoiceErrorClass>;
  evictedOverflowFailureClass: VoiceErrorClass | null;
  cancellationCause: CancellationCause | null;
  generatedAudio: boolean;
  audioAggregateCounted: boolean;
  generatedDurationMs: number;
  readonly audioBySynthesis: Map<string, number>;
  knownPlayout: boolean;
  readonly bridgeIds: Set<string>;
  readonly synthesisIds: Set<string>;
  bridgeAssociationOverflow: boolean;
  synthesisAssociationOverflow: boolean;
  eouMetricCount: number;
  eouDelayMs: number | null;
  latencyRecorded: boolean;
}

interface AudioContribution {
  readonly speechId: string;
  finalized: boolean;
}

interface BridgeOwner {
  readonly turnId: string;
  readonly startMonoMs: number;
  terminalEmitted: boolean;
  startedEmitted: boolean;
  status: number | null;
  textLength: number;
  firstTextMs: number | null;
  lastTextMonoMs: number | null;
  maximumGapMs: number | null;
  errorClass: VoiceErrorClass | null;
  outcome: AttemptOutcome | null;
  binding: string | null | "conflict";
  associationCounted: boolean;
}

interface SynthesisOwner {
  readonly synthesisId: string;
  terminalEmitted: boolean;
  frameCount: number;
  sampleCount: number;
  sampleRate: number | null;
  mixedSampleRates: boolean;
  generatedDurationMs: number;
  errorClass: "tts_provider_failed" | "tts_node_failed" | null;
  outcome: AttemptOutcome | null;
  binding: string | null | "conflict";
  associationCounted: boolean;
  metricCount: number;
  ttfbMs: number | null;
  audioContribution: AudioContribution | null;
}

function emptyOutcomes(): OutcomeCounts {
  return { completed: 0, interrupted: 0, cancelled: 0, failed: 0, incomplete: 0 };
}

function emptyAttemptKinds(): AttemptKindCounts {
  return { speech: 0, bridge: 0, synthesis: 0 };
}

function emptyLatencyExclusions(): LatencyExclusions {
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

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function terminalOnce<T>(emit: (value: T) => void, count: (value: T) => void) {
  let ended = false;
  return (value: T): boolean => {
    if (ended) return false;
    ended = true;
    count(value);
    emit(value);
    return true;
  };
}

export type SpeechTraceOptions = {
  callId: string;
  workerBootId: string;
  writer?: VoiceTraceWriter;
};

export class SpeechTrace implements SpeechTracePort {
  readonly #callId: string;
  readonly #workerBootId: string;
  readonly #writer: VoiceTraceWriter;
  readonly #handles = new WeakMap<SpeechHandle, SpeechOwner>();
  readonly #activeSpeech = new Map<string, SpeechOwner>();
  readonly #recentSpeech = new Map<string, SpeechOwner>();
  readonly #activeBridge = new Map<string, BridgeOwner>();
  readonly #recentBridge = new Map<string, BridgeOwner>();
  readonly #activeSynthesis = new Map<string, SynthesisOwner>();
  readonly #recentSynthesis = new Map<string, SynthesisOwner>();
  readonly #seenMetrics = new WeakSet<object>();
  readonly #speechOutcomes = emptyOutcomes();
  readonly #bridgeOutcomes = emptyOutcomes();
  readonly #synthesisOutcomes = emptyOutcomes();
  readonly #latencyEstimateSamples: number[] = [];
  readonly #excludedByReason = emptyLatencyExclusions();
  #speechAttempts = 0;
  #bridgeAttempts = 0;
  #synthesisAttempts = 0;
  #synthesizedAudioObserved = 0;
  #generatedAudioObserved = 0;
  #knownPlayoutObserved = 0;
  #sdkInterruptions = 0;
  #cancelledSpeechAttempts = 0;
  #eligibleLatencyEstimateCount = 0;
  #diagnosticGaps = 0;
  readonly #finalizedUnboundByAttemptKind = emptyAttemptKinds();
  #unboundObservations = 0;
  #unresolvedEvictedSynthesisCoverage = false;
  #teardownIncomplete = 0;
  #startupPendingRecorded = false;
  #closed = false;
  #bindingListener: ((turnId: string) => void) | null = null;

  constructor(options: SpeechTraceOptions) {
    this.#callId = options.callId;
    this.#workerBootId = options.workerBootId;
    this.#writer = options.writer ?? createVoiceTraceWriter();
  }

  call(
    event: Extract<
      VoiceDiagnosticPayload,
      {
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
      }
    >,
  ): void {
    this.#safe(() => this.#emit({}, event));
  }

  speechCreated(handle: SpeechHandle, origin: SpeechOrigin, acceptedEpoch: number): void {
    this.#safe(() => {
      if (this.#closed || this.#handles.has(handle)) return;
      if (this.#activeSpeech.has(handle.id) || this.#recentSpeech.has(handle.id)) {
        this.#gap("binding_conflict", { speechId: handle.id });
        return;
      }
      this.#evictActiveSpeechIfNeeded();
      const owner: SpeechOwner = {
        handle,
        doneCallback: (settled: SpeechHandle) => this.#safe(() => this.#speechSettled(owner, settled)),
        speechId: handle.id,
        origin,
        acceptedEpoch,
        terminalEmitted: false,
        errorClass: null,
        directErrorClass: null,
        associatedFailures: new Map(),
        evictedOverflowFailureClass: null,
        cancellationCause: null,
        generatedAudio: false,
        audioAggregateCounted: false,
        generatedDurationMs: 0,
        audioBySynthesis: new Map(),
        knownPlayout: false,
        bridgeIds: new Set(),
        synthesisIds: new Set(),
        bridgeAssociationOverflow: false,
        synthesisAssociationOverflow: false,
        eouMetricCount: 0,
        eouDelayMs: null,
        latencyRecorded: false,
      };
      this.#handles.set(handle, owner);
      this.#activeSpeech.set(owner.speechId, owner);
      this.#speechAttempts += 1;
      this.#emit(
        { speechId: owner.speechId },
        {
          event: "speech_started",
          origin,
          acceptedEpoch,
          source: "application",
          generatedAudio: false,
          knownPlayout: false,
        },
      );
      handle.addDoneCallback(owner.doneCallback);
    });
  }

  bridgeCreated(context: BridgeTraceContext): BridgeAttempt {
    let owner: BridgeOwner | null = null;
    this.#safe(() => {
      if (!this.#validBridgeContext(context) || this.#closed) {
        this.#gap("correlation_missing", { turnId: context.turnId });
        return;
      }
      const existing = this.#activeBridge.get(context.turnId) ?? this.#recentBridge.get(context.turnId);
      if (existing) {
        owner = existing;
        this.#gap("binding_conflict", { turnId: context.turnId });
        return;
      }
      this.#evictActiveBridgeIfNeeded();
      owner = {
        turnId: context.turnId,
        startMonoMs: performance.now(),
        terminalEmitted: false,
        startedEmitted: false,
        status: null,
        textLength: 0,
        firstTextMs: null,
        lastTextMonoMs: null,
        maximumGapMs: null,
        errorClass: null,
        outcome: null,
        binding: null,
        associationCounted: false,
      };
      this.#activeBridge.set(context.turnId, owner);
      this.#bridgeAttempts += 1;
      this.#emit({ turnId: context.turnId }, { event: "bridge_created" });
    });
    return this.#bridgeAttempt(owner, context.turnId);
  }

  synthesisCreated(context: SynthesisTraceContext): SynthesisAttempt {
    let owner: SynthesisOwner | null = null;
    this.#safe(() => {
      if (!this.#validSynthesisContext(context) || this.#closed) {
        this.#gap("correlation_missing", { synthesisId: context.synthesisId });
        return;
      }
      const existing = this.#activeSynthesis.get(context.synthesisId) ?? this.#recentSynthesis.get(context.synthesisId);
      if (existing) {
        owner = existing;
        this.#gap("binding_conflict", { synthesisId: context.synthesisId });
        return;
      }
      this.#evictActiveSynthesisIfNeeded();
      owner = {
        synthesisId: context.synthesisId,
        terminalEmitted: false,
        frameCount: 0,
        sampleCount: 0,
        sampleRate: null,
        mixedSampleRates: false,
        generatedDurationMs: 0,
        errorClass: null,
        outcome: null,
        binding: null,
        associationCounted: false,
        metricCount: 0,
        ttfbMs: null,
        audioContribution: null,
      };
      this.#activeSynthesis.set(context.synthesisId, owner);
      this.#synthesisAttempts += 1;
      this.#emit({ synthesisId: context.synthesisId }, { event: "synthesis_started" });
    });
    return this.#synthesisAttempt(owner, context.synthesisId);
  }

  bindBridge(turnId: string, speechId: string): void {
    this.#safe(() => this.#bindBridge(turnId, speechId, "sdk_metrics_context"));
  }

  bridgeBinding(turnId: string): BridgeBinding {
    if (this.#closed) return { state: "unavailable", reason: "closed" };
    const owner = this.#activeBridge.get(turnId) ?? this.#recentBridge.get(turnId);
    if (!owner) return { state: "unavailable", reason: "evicted" };
    if (owner.binding === "conflict") return { state: "unavailable", reason: "conflict" };
    return owner.binding === null ? { state: "unbound" } : { state: "bound", speechId: owner.binding };
  }

  onBridgeBinding(listener: (turnId: string) => void): () => void {
    this.#bindingListener = listener;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.#bindingListener === listener) this.#bindingListener = null;
    };
  }

  bindSynthesis(synthesisId: string, speechId: string): void {
    this.#safe(() => this.#bindSynthesis(synthesisId, speechId, "sdk_metrics_context"));
  }

  markCancellation(speechId: string, cause: CancellationCause): void {
    this.#safe(() => {
      const speech = this.#activeSpeech.get(speechId) ?? this.#recentSpeech.get(speechId);
      if (!speech) {
        this.#gap("correlation_missing", { speechId });
        return;
      }
      if (!speech.terminalEmitted) speech.cancellationCause ??= cause;
      else this.#lateSpeechEvidence(speech, null);
    });
  }

  synthesisFailure(synthesisId: string, errorClass: "tts_provider_failed"): void {
    this.#safe(() => {
      const owner = this.#activeSynthesis.get(synthesisId) ?? this.#recentSynthesis.get(synthesisId);
      if (!owner) {
        this.#unboundObservations += 1;
        this.#gap("provider_context_missing", { synthesisId });
        return;
      }
      this.#synthesisFail(owner, errorClass);
    });
  }

  unboundProviderFailure(kind: "tts" | "llm", errorClass: "tts_provider_failed" | "llm_provider_failed"): void {
    this.#safe(() => {
      this.#unboundObservations += 1;
      this.#emit(
        {},
        {
          event: "sdk_metric",
          source: "late_observation",
          metric: kind,
          errorClass,
        },
      );
      this.#gap("provider_context_missing", {});
    });
  }

  metrics(event: MetricsCollectedEvent): void {
    this.#safe(() => {
      const metric = event.metrics;
      if (this.#seenMetrics.has(metric)) return;
      this.#seenMetrics.add(metric);

      if (metric.type === "llm_metrics") {
        const context = bridgeTraceContext.getStore();
        const valid = context && this.#validBridgeContext(context);
        if (valid && metric.speechId) this.#bindBridge(context.turnId, metric.speechId, "sdk_metrics_context");
        else if (!valid || !metric.speechId) this.#unboundObservations += 1;
        this.#emit(
          { speechId: metric.speechId ?? null, turnId: valid ? context.turnId : null },
          {
            event: "sdk_metric",
            source: "sdk_metrics_context",
            metric: "llm",
            ttftMs: measure(finiteNonnegative(metric.ttftMs), "not_observed"),
            durationMs: measure(finiteNonnegative(metric.durationMs), "not_observed"),
          },
        );
        if (!valid || !metric.speechId) this.#gap("correlation_missing", {});
        return;
      }

      if (metric.type === "tts_metrics") {
        const context = synthesisTraceContext.getStore();
        const valid = context && this.#validSynthesisContext(context);
        if (valid) {
          const synthesis =
            this.#activeSynthesis.get(context.synthesisId) ?? this.#recentSynthesis.get(context.synthesisId);
          if (synthesis) {
            synthesis.metricCount += 1;
            synthesis.ttfbMs ??= finiteNonnegative(metric.ttfbMs) ?? null;
          }
          if (metric.speechId) this.#bindSynthesis(context.synthesisId, metric.speechId, "sdk_metrics_context");
        }
        if (!valid || !metric.speechId) this.#unboundObservations += 1;
        this.#emit(
          { speechId: metric.speechId ?? null, synthesisId: valid ? context.synthesisId : null },
          {
            event: "sdk_metric",
            source: "sdk_metrics_context",
            metric: "tts",
            ttfbMs: measure(finiteNonnegative(metric.ttfbMs), "not_observed"),
            durationMs: measure(finiteNonnegative(metric.durationMs), "not_observed"),
          },
        );
        if (!valid || !metric.speechId) this.#gap("correlation_missing", {});
        return;
      }

      if (metric.type === "eou_metrics") {
        const speech = metric.speechId ? this.#speechById(metric.speechId) : undefined;
        if (!metric.speechId || !speech) this.#unboundObservations += 1;
        if (speech && !speech.terminalEmitted) {
          speech.eouMetricCount += 1;
          speech.eouDelayMs ??= finiteNonnegative(metric.endOfUtteranceDelayMs) ?? null;
        }
        this.#emit(
          { speechId: metric.speechId ?? null },
          {
            event: "sdk_metric",
            source: "sdk_wall",
            metric: "eou",
            eouMs: measure(finiteNonnegative(metric.endOfUtteranceDelayMs), "not_observed"),
            transcriptionMs: measure(finiteNonnegative(metric.transcriptionDelayMs), "not_observed"),
            onUserTurnCompletedMs: measure(finiteNonnegative(metric.onUserTurnCompletedDelayMs), "not_observed"),
          },
        );
        return;
      }

      if (metric.type === "interruption_metrics") {
        this.#emit(
          {},
          {
            event: "sdk_metric",
            source: "sdk_wall",
            metric: "interruption",
            interruptionCount: Math.max(0, Math.trunc(metric.numInterruptions)),
            durationMs: measure(finiteNonnegative(metric.totalDuration), "not_observed"),
          },
        );
      }
    });
  }

  outputPlayback(durationMs?: number, interrupted?: boolean): void {
    this.#safe(() => {
      if (this.#closed) return;
      this.#emit(
        {},
        {
          event: "output_playback",
          source: "media_output",
          metric: "playout",
          durationMs: measure(finiteNonnegative(durationMs), "not_observed"),
          ...(interrupted === undefined ? {} : { interrupted }),
        },
      );
    });
  }

  falseInterruption(): void {
    this.#safe(() => {
      if (this.#closed) return;
      this.#emit({}, { event: "false_interruption", source: "sdk_wall" });
    });
  }

  actionGap(reason: ActionGapReason, speechId: string, turnId?: string): void;
  actionGap(reason: ActionGapReason, speechId: string | null, turnId: string): void;
  actionGap(reason: ActionGapReason, speechId: string | null, turnId?: string): void {
    this.#safe(() => {
      if (speechId === null && turnId === undefined) return;
      this.#gap(reason, { speechId, turnId: turnId ?? null });
    });
  }

  startupPending(): void {
    this.#safe(() => {
      if (this.#startupPendingRecorded) return;
      this.#startupPendingRecorded = true;
      this.#teardownIncomplete += 1;
      this.#gap("start_pending", {});
    });
  }

  teardown(result: "closed" | "failed" | "timeout", reason: "call_close" | "late_start" | "late_start_failed"): void {
    this.#safe(() => {
      this.#emit({}, { event: "teardown", result, reason });
      if (result !== "closed") {
        this.#teardownIncomplete += 1;
        this.#gap(result === "failed" ? "teardown_failed" : "teardown_timeout", {});
      }
    });
  }

  summaryPersistence(
    status: "acknowledged" | "failed",
    reason?: "connect_failed" | "insert_failed" | "close_failed",
  ): void {
    this.#safe(() =>
      this.#emit(
        {},
        {
          event: "summary_persistence",
          status,
          ...(reason === undefined ? {} : { reason }),
        },
      ),
    );
  }

  close(cause: "call_closed" | "setup_failed"): void {
    this.#safe(() => {
      if (this.#closed) return;
      this.#closed = true;

      const retainedTurns = new Set([...this.#activeBridge.keys(), ...this.#recentBridge.keys()]);
      for (const speech of [...this.#activeSpeech.values()]) {
        let sdkInterrupted = false;
        try {
          sdkInterrupted = speech.handle.interrupted;
        } catch {
          // Missing late handle state remains unknown.
        }
        this.#finalizeSpeech(
          speech,
          cause === "call_closed" ? "cancelled" : "incomplete",
          cause === "call_closed" ? "call_closed" : "unknown",
          false,
          sdkInterrupted,
          0,
          undefined,
        );
      }
      for (const bridge of [...this.#activeBridge.values()]) {
        this.#finishBridge(
          bridge,
          cause === "call_closed" ? "cancelled" : "incomplete",
          cause === "call_closed" ? "call_closed" : "unknown",
        );
        this.#countUnboundAssociation("bridge", bridge);
      }
      for (const synthesis of [...this.#activeSynthesis.values()]) {
        this.#finishSynthesis(
          synthesis,
          cause === "call_closed" ? "cancelled" : "incomplete",
          cause === "call_closed" ? "call_closed" : "unknown",
        );
        this.#countUnboundAssociation("synthesis", synthesis);
      }
      for (const bridge of this.#recentBridge.values()) this.#countUnboundAssociation("bridge", bridge);
      for (const synthesis of this.#recentSynthesis.values()) this.#countUnboundAssociation("synthesis", synthesis);

      this.#activeBridge.clear();
      this.#recentBridge.clear();
      for (const turnId of retainedTurns) this.#notifyBinding(turnId);
      this.#bindingListener = null;
      this.#activeSpeech.clear();
      this.#recentSpeech.clear();
      this.#activeSynthesis.clear();
      this.#recentSynthesis.clear();
    });
  }

  snapshot(): CallDiagnosticCounts {
    const incompleteByAttemptKind: AttemptKindCounts = {
      speech: this.#speechOutcomes.incomplete,
      bridge: this.#bridgeOutcomes.incomplete,
      synthesis: this.#synthesisOutcomes.incomplete,
    };
    const incomplete = Object.values(incompleteByAttemptKind).reduce((sum, count) => sum + count, 0);
    const unboundByAttemptKind = this.#currentUnboundByAttemptKind();
    const unbound = Object.values(unboundByAttemptKind).reduce((sum, count) => sum + count, 0);
    return {
      speechAttempts: this.#speechAttempts,
      speechOutcomes: { ...this.#speechOutcomes },
      bridgeAttempts: this.#bridgeAttempts,
      bridgeOutcomes: { ...this.#bridgeOutcomes },
      synthesisAttempts: this.#synthesisAttempts,
      synthesisOutcomes: { ...this.#synthesisOutcomes },
      synthesizedAudioObserved: this.#synthesizedAudioObserved,
      generatedAudioObserved: this.#generatedAudioObserved,
      knownPlayoutObserved: this.#knownPlayoutObserved,
      sdkInterruptions: this.#sdkInterruptions,
      cancelledSpeechAttempts: this.#cancelledSpeechAttempts,
      incomplete,
      incompleteByAttemptKind,
      incompleteObservations: this.#teardownIncomplete,
      unbound,
      unboundByAttemptKind,
      unboundObservations: this.#unboundObservations,
      diagnosticGaps: this.#diagnosticGaps,
      latencyEstimateSamples: [...this.#latencyEstimateSamples],
      eligibleLatencyEstimateCount: this.#eligibleLatencyEstimateCount,
      excludedByReason: { ...this.#excludedByReason },
      logging: this.#writer.snapshot(),
      registry: {
        activeSpeech: this.#activeSpeech.size,
        recentSpeech: this.#recentSpeech.size,
        activeBridge: this.#activeBridge.size,
        recentBridge: this.#recentBridge.size,
        activeSynthesis: this.#activeSynthesis.size,
        recentSynthesis: this.#recentSynthesis.size,
      },
    };
  }

  settleWrites(timeoutMs = 250): Promise<VoiceTraceWriteCounts> {
    return this.#writer.settleWrites(timeoutMs);
  }

  #bridgeAttempt(owner: BridgeOwner | null, turnId: string): BridgeAttempt {
    return Object.freeze({
      started: () => this.#safe(() => owner && this.#bridgeStarted(owner)),
      response: (status: number) => this.#safe(() => owner && this.#bridgeResponse(owner, status)),
      text: (length: number, monoMs: number) => this.#safe(() => owner && this.#bridgeText(owner, length, monoMs)),
      fail: (errorClass: VoiceErrorClass) => this.#safe(() => owner && this.#bridgeFail(owner, errorClass)),
      finish: (outcome: AttemptOutcome, cause: CancellationCause) =>
        this.#safe(() => owner && this.#finishBridge(owner, outcome, cause)),
      bind: (speechId: string) => this.#safe(() => this.#bindBridge(turnId, speechId, "sdk_metrics_context")),
    });
  }

  #synthesisAttempt(owner: SynthesisOwner | null, synthesisId: string): SynthesisAttempt {
    return Object.freeze({
      frame: (metadata: { sampleRate: number; samplesPerChannel: number }) =>
        this.#safe(() => owner && this.#synthesisFrame(owner, metadata)),
      fail: (errorClass: "tts_provider_failed" | "tts_node_failed") =>
        this.#safe(() => owner && this.#synthesisFail(owner, errorClass)),
      finish: (outcome: AttemptOutcome, cause: CancellationCause) =>
        this.#safe(() => owner && this.#finishSynthesis(owner, outcome, cause)),
      bind: (speechId: string) => this.#safe(() => this.#bindSynthesis(synthesisId, speechId, "sdk_metrics_context")),
    });
  }

  #bridgeStarted(owner: BridgeOwner): void {
    if (owner.startedEmitted) return;
    owner.startedEmitted = true;
    this.#emit(
      { turnId: owner.turnId, speechId: this.#boundId(owner.binding) },
      {
        event: "bridge_started",
        late: owner.terminalEmitted,
      },
    );
  }

  #bridgeResponse(owner: BridgeOwner, status: number): void {
    const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    if (!owner.terminalEmitted) owner.status = safeStatus;
    this.#emit(
      { turnId: owner.turnId, speechId: this.#boundId(owner.binding) },
      {
        event: "bridge_response",
        status: safeStatus,
        late: owner.terminalEmitted,
      },
    );
  }

  #bridgeText(owner: BridgeOwner, length: number, monoMs: number): void {
    const safeLength = Number.isFinite(length) && length > 0 ? Math.trunc(length) : 0;
    if (safeLength === 0) return;
    const now = finiteNonnegative(monoMs) ?? performance.now();
    if (owner.terminalEmitted) {
      this.#emit(
        { turnId: owner.turnId, speechId: this.#boundId(owner.binding) },
        {
          event: "bridge_first_text",
          textLength: safeLength,
          firstTextMs: measure(undefined, "not_observed"),
          late: true,
        },
      );
      return;
    }
    owner.textLength += safeLength;
    if (owner.lastTextMonoMs !== null) {
      const gap = Math.max(0, now - owner.lastTextMonoMs);
      owner.maximumGapMs = Math.max(owner.maximumGapMs ?? 0, gap);
    }
    owner.lastTextMonoMs = now;
    if (owner.firstTextMs !== null) return;
    owner.firstTextMs = Math.max(0, now - owner.startMonoMs);
    this.#emit(
      { turnId: owner.turnId, speechId: this.#boundId(owner.binding) },
      {
        event: "bridge_first_text",
        textLength: safeLength,
        firstTextMs: measure(owner.firstTextMs, "not_reached"),
      },
    );
  }

  #bridgeFail(owner: BridgeOwner, errorClass: VoiceErrorClass): void {
    if (!owner.terminalEmitted) {
      owner.errorClass ??= errorClass;
      const speech = this.#speechForBinding(owner.binding);
      if (speech) this.#applySpeechFailure(speech, this.#bridgeFailureSource(owner.turnId), errorClass);
    } else {
      this.#gap("late_error_observed", {
        turnId: owner.turnId,
        speechId: this.#boundId(owner.binding),
      });
    }
  }

  #finishBridge(owner: BridgeOwner, outcome: AttemptOutcome, cause: CancellationCause): void {
    const terminal = terminalOnce<AttemptOutcome>(
      (finalOutcome) => {
        this.#emit(
          { turnId: owner.turnId, speechId: this.#boundId(owner.binding) },
          {
            event: "bridge_terminal",
            status: owner.status ?? undefined,
            textLength: owner.textLength,
            firstTextMs: measure(owner.firstTextMs ?? undefined, "not_reached"),
            maximumGapMs: measure(
              owner.maximumGapMs ?? undefined,
              owner.textLength > 0 ? "not_applicable" : "not_reached",
            ),
            outcome: finalOutcome,
            cause,
            errorClass: owner.errorClass,
          },
        );
      },
      (finalOutcome) => {
        this.#bridgeOutcomes[finalOutcome] += 1;
      },
    );
    if (owner.terminalEmitted) return;
    const finalOutcome = owner.errorClass ? "failed" : outcome;
    owner.terminalEmitted = true;
    owner.outcome = finalOutcome;
    terminal(finalOutcome);
    this.#activeBridge.delete(owner.turnId);
    if (!this.#closed) this.#addRecentBridge(owner);
  }

  #synthesisFrame(owner: SynthesisOwner, metadata: { sampleRate: number; samplesPerChannel: number }): void {
    const sampleRate = finiteNonnegative(metadata.sampleRate);
    const samples = finiteNonnegative(metadata.samplesPerChannel);
    if (!sampleRate || samples === undefined) {
      this.#gap("correlation_missing", { synthesisId: owner.synthesisId });
      return;
    }
    if (owner.terminalEmitted) {
      this.#emit(
        { synthesisId: owner.synthesisId, speechId: this.#boundId(owner.binding) },
        {
          event: "synthesis_first_frame",
          frameCount: 1,
          sampleCount: samples,
          sampleRate,
          generatedDurationMs: measure((samples / sampleRate) * 1000, "not_observed"),
          late: true,
        },
      );
      return;
    }
    if (owner.frameCount === 0) this.#synthesizedAudioObserved += 1;
    owner.frameCount += 1;
    owner.sampleCount += samples;
    owner.generatedDurationMs += (samples / sampleRate) * 1000;
    if (owner.sampleRate === null) owner.sampleRate = sampleRate;
    else if (owner.sampleRate !== sampleRate) owner.mixedSampleRates = true;
    const speech = this.#speechForBinding(owner.binding);
    this.#attachAudioContribution(owner);
    if (speech && !speech.terminalEmitted && speech.synthesisIds.has(owner.synthesisId)) {
      speech.audioBySynthesis.set(owner.synthesisId, owner.generatedDurationMs);
      this.#refreshSpeechAudio(speech);
    }
    if (owner.frameCount === 1) {
      this.#emit(
        { synthesisId: owner.synthesisId, speechId: this.#boundId(owner.binding) },
        {
          event: "synthesis_first_frame",
          frameCount: 1,
          sampleCount: samples,
          sampleRate,
          generatedDurationMs: measure((samples / sampleRate) * 1000, "not_observed"),
        },
      );
    }
  }

  #synthesisFail(owner: SynthesisOwner, errorClass: "tts_provider_failed" | "tts_node_failed"): void {
    if (!owner.terminalEmitted) {
      owner.errorClass ??= errorClass;
      const speech = this.#speechForBinding(owner.binding);
      if (speech) this.#applySpeechFailure(speech, this.#synthesisFailureSource(owner.synthesisId), errorClass);
    } else {
      this.#gap("late_error_observed", {
        synthesisId: owner.synthesisId,
        speechId: this.#boundId(owner.binding),
      });
    }
  }

  #finishSynthesis(owner: SynthesisOwner, outcome: AttemptOutcome, cause: CancellationCause): void {
    if (owner.terminalEmitted) return;
    const finalOutcome = owner.errorClass ? "failed" : outcome;
    owner.terminalEmitted = true;
    owner.outcome = finalOutcome;
    this.#synthesisOutcomes[finalOutcome] += 1;
    this.#emit(
      { synthesisId: owner.synthesisId, speechId: this.#boundId(owner.binding) },
      {
        event: "synthesis_terminal",
        frameCount: owner.frameCount,
        sampleCount: owner.sampleCount,
        sampleRate: owner.mixedSampleRates ? null : owner.sampleRate,
        sampleRateReason: owner.mixedSampleRates || owner.sampleRate === null ? "not_applicable" : null,
        generatedDurationMs: measure(
          owner.frameCount > 0 ? owner.generatedDurationMs : undefined,
          owner.frameCount > 0 ? "not_observed" : "not_reached",
        ),
        outcome: finalOutcome,
        cause,
        errorClass: owner.errorClass,
      },
    );
    this.#activeSynthesis.delete(owner.synthesisId);
    if (!this.#closed) this.#addRecentSynthesis(owner);
  }

  #bindBridge(turnId: string, speechId: string, source: "sdk_metrics_context"): void {
    const owner = this.#activeBridge.get(turnId) ?? this.#recentBridge.get(turnId);
    if (!owner) {
      this.#unboundObservations += 1;
      this.#gap("correlation_missing", { turnId, speechId });
      this.#notifyBinding(turnId);
      return;
    }
    if (owner.binding === "conflict") return;
    if (owner.binding !== null) {
      if (owner.binding === speechId) return;
      const priorSpeechId = owner.binding;
      owner.binding = "conflict";
      const priorSpeech = this.#speechById(priorSpeechId);
      if (priorSpeech && !priorSpeech.terminalEmitted) {
        priorSpeech.bridgeIds.delete(turnId);
        this.#removeSpeechFailure(priorSpeech, this.#bridgeFailureSource(turnId));
      }
      this.#countUnboundAssociation("bridge", owner);
      this.#gap("binding_conflict", { turnId, speechId: null });
      this.#notifyBinding(turnId);
      return;
    }
    owner.binding = speechId;
    this.#associateBridge(speechId, turnId);
    this.#emit({ turnId, speechId }, { event: "bridge_bound", source });
    if (owner.errorClass) {
      const speech = this.#speechById(speechId);
      if (speech) this.#applySpeechFailure(speech, this.#bridgeFailureSource(turnId), owner.errorClass);
    }
    this.#notifyBinding(turnId);
  }

  #bindSynthesis(synthesisId: string, speechId: string, source: "sdk_metrics_context"): void {
    const owner = this.#activeSynthesis.get(synthesisId) ?? this.#recentSynthesis.get(synthesisId);
    if (!owner) {
      this.#unboundObservations += 1;
      this.#gap("correlation_missing", { synthesisId, speechId });
      return;
    }
    if (owner.binding === "conflict") return;
    if (owner.binding !== null) {
      if (owner.binding === speechId) return;
      const priorSpeechId = owner.binding;
      this.#detachAudioContribution(owner);
      owner.binding = "conflict";
      this.#countUnboundAssociation("synthesis", owner);
      const priorSpeech = this.#speechById(priorSpeechId);
      if (priorSpeech) {
        if (!priorSpeech.terminalEmitted) {
          priorSpeech.synthesisIds.delete(synthesisId);
          this.#removeSpeechFailure(priorSpeech, this.#synthesisFailureSource(synthesisId));
          priorSpeech.audioBySynthesis.delete(synthesisId);
          this.#refreshSpeechAudio(priorSpeech);
        }
      }
      this.#gap("binding_conflict", { synthesisId, speechId: null });
      return;
    }
    owner.binding = speechId;
    const associationRetained = this.#associateSynthesis(speechId, synthesisId);
    this.#emit({ synthesisId, speechId }, { event: "synthesis_bound", source });
    const speech = this.#speechById(speechId);
    this.#attachAudioContribution(owner);
    if (speech && owner.errorClass)
      this.#applySpeechFailure(speech, this.#synthesisFailureSource(synthesisId), owner.errorClass);
    if (speech && !speech.terminalEmitted && owner.frameCount > 0 && associationRetained) {
      speech.audioBySynthesis.set(owner.synthesisId, owner.generatedDurationMs);
      this.#refreshSpeechAudio(speech);
    } else if (speech?.terminalEmitted && (owner.errorClass || owner.frameCount > 0)) {
      this.#lateSpeechEvidence(speech, owner.errorClass);
    }
  }

  #speechSettled(owner: SpeechOwner, handle: SpeechHandle): void {
    if (this.#closed) return;
    let directErrorClass: VoiceErrorClass | null = null;
    try {
      if (handle.exception() != null) directErrorClass = "speech_handle_failed";
    } catch {
      directErrorClass = "speech_handle_failed";
    }
    if (directErrorClass) {
      owner.directErrorClass ??= directErrorClass;
      this.#refreshSpeechFailure(owner);
    }
    const errorClass = owner.errorClass;

    let interrupted = false;
    let knownPlayout = false;
    let textLength = 0;
    let startedSpeakingAt: number | undefined;
    try {
      interrupted = handle.interrupted;
      for (const item of handle.chatItems) {
        if (item.type !== "message" || item.role !== "assistant") continue;
        const text = item.textContent;
        if (typeof text === "string") textLength += text.length;
        if (item.interrupted) interrupted = true;
        const started = finiteNonnegative(item.metrics.startedSpeakingAt);
        if (started !== undefined) {
          knownPlayout = true;
          startedSpeakingAt ??= started;
        }
        this.#emit(
          { speechId: owner.speechId },
          {
            event: "handle_playout_item",
            source: "sdk_handle",
            metric: "playout",
            textLength: typeof text === "string" ? text.length : 0,
            interrupted: item.interrupted,
            startedSpeakingAt: measure(started, "not_observed"),
          },
        );
      }
    } catch {
      // A malformed late SDK observation becomes missing evidence, not a media exception.
    }
    if (knownPlayout && !owner.knownPlayout) this.#knownPlayoutObserved += 1;
    owner.knownPlayout ||= knownPlayout;

    if (owner.terminalEmitted) {
      if (errorClass || knownPlayout || textLength > 0) this.#lateSpeechEvidence(owner, errorClass);
      return;
    }

    let outcome: AttemptOutcome;
    if (owner.errorClass) outcome = "failed";
    else if (owner.cancellationCause) outcome = "cancelled";
    else if (interrupted) outcome = "interrupted";
    else outcome = this.#speechCoverageComplete(owner) ? "completed" : "incomplete";
    this.#finalizeSpeech(
      owner,
      outcome,
      owner.cancellationCause ?? "unknown",
      true,
      interrupted,
      textLength,
      startedSpeakingAt,
    );
  }

  #recordLatency(owner: SpeechOwner, outcome: AttemptOutcome, sdkInterrupted: boolean): void {
    if (owner.latencyRecorded) return;
    owner.latencyRecorded = true;

    let excluded: LatencyExclusionReason | null = null;
    if (owner.origin !== "sdk_response") excluded = "not_applicable";
    else if (outcome === "cancelled") excluded = "cancelled";
    else if (sdkInterrupted || outcome === "interrupted") excluded = "interrupted";
    else if (outcome === "failed") excluded = "failed";
    else if (outcome === "incomplete") excluded = "incomplete";
    else if (
      owner.bridgeAssociationOverflow ||
      owner.synthesisAssociationOverflow ||
      owner.bridgeIds.size > 1 ||
      owner.synthesisIds.size > 1 ||
      owner.eouMetricCount > 1
    ) {
      excluded = "ambiguous_components";
    } else if (owner.eouMetricCount !== 1 || owner.eouDelayMs === null) excluded = "missing_eou";
    else if (owner.bridgeIds.size !== 1) excluded = "missing_bridge_first_text";
    else if (owner.synthesisIds.size !== 1) excluded = "missing_generated_audio";

    const bridgeId = owner.bridgeIds.values().next().value as string | undefined;
    const bridge = bridgeId ? (this.#activeBridge.get(bridgeId) ?? this.#recentBridge.get(bridgeId)) : undefined;
    const synthesisId = owner.synthesisIds.values().next().value as string | undefined;
    const synthesis = synthesisId
      ? (this.#activeSynthesis.get(synthesisId) ?? this.#recentSynthesis.get(synthesisId))
      : undefined;

    if (excluded === null && (!bridge || bridge.firstTextMs === null)) excluded = "missing_bridge_first_text";
    if (excluded === null && synthesis?.metricCount !== 1) {
      excluded = synthesis && synthesis.metricCount > 1 ? "ambiguous_components" : "missing_tts_metric";
    }
    if (excluded === null && (!synthesis || synthesis.ttfbMs === null)) excluded = "missing_tts_metric";
    if (excluded === null && (!owner.generatedAudio || !synthesis || synthesis.frameCount === 0)) {
      excluded = "missing_generated_audio";
    }

    if (excluded !== null) {
      this.#excludedByReason[excluded] += 1;
      return;
    }

    const estimate = owner.eouDelayMs! + bridge!.firstTextMs! + synthesis!.ttfbMs!;
    this.#eligibleLatencyEstimateCount += 1;
    if (this.#latencyEstimateSamples.length < LATENCY_SAMPLE_LIMIT) this.#latencyEstimateSamples.push(estimate);
  }

  #speechCoverageComplete(owner: SpeechOwner): boolean {
    if (owner.origin !== "fallback") {
      if (owner.bridgeIds.size === 0 || owner.bridgeAssociationOverflow) return false;
      for (const id of owner.bridgeIds) {
        const bridge = this.#activeBridge.get(id) ?? this.#recentBridge.get(id);
        if (!bridge?.terminalEmitted || bridge.outcome !== "completed" || bridge.binding !== owner.speechId)
          return false;
      }
    }
    if (owner.synthesisIds.size === 0 || owner.synthesisAssociationOverflow || !owner.generatedAudio) return false;
    for (const id of owner.synthesisIds) {
      const synthesis = this.#activeSynthesis.get(id) ?? this.#recentSynthesis.get(id);
      if (!synthesis?.terminalEmitted || synthesis.outcome !== "completed" || synthesis.binding !== owner.speechId) {
        return false;
      }
    }
    if (this.#hasUnresolvedSynthesisCoverage()) return false;
    return true;
  }

  #finalizeSpeech(
    owner: SpeechOwner,
    outcome: AttemptOutcome,
    cause: CancellationCause,
    sdkSettled: boolean,
    sdkInterrupted: boolean,
    textLength: number,
    startedSpeakingAt: number | undefined,
  ): void {
    if (owner.terminalEmitted) return;
    const finalOutcome: AttemptOutcome = owner.errorClass ? "failed" : outcome;
    this.#detachSpeechHandle(owner);
    if (sdkInterrupted) this.#sdkInterruptions += 1;
    if (finalOutcome === "cancelled") this.#cancelledSpeechAttempts += 1;
    this.#recordLatency(owner, finalOutcome, sdkInterrupted);
    owner.terminalEmitted = true;
    this.#speechOutcomes[finalOutcome] += 1;
    this.#emit(
      { speechId: owner.speechId },
      {
        event: "speech_terminal",
        origin: owner.origin,
        acceptedEpoch: owner.acceptedEpoch,
        source: "sdk_handle",
        outcome: finalOutcome,
        cause,
        generatedAudio: owner.generatedAudio,
        knownPlayout: owner.knownPlayout,
        sdkSettled,
        sdkInterrupted,
        textLength,
        startedSpeakingAt: measure(startedSpeakingAt, "not_observed"),
        generatedDurationMs: measure(
          owner.generatedAudio ? owner.generatedDurationMs : undefined,
          owner.generatedAudio ? "not_observed" : owner.synthesisIds.size > 0 ? "not_observed" : "correlation_missing",
        ),
        errorClass: owner.errorClass,
      },
    );
    this.#activeSpeech.delete(owner.speechId);
    if (!this.#closed) this.#addRecentSpeech(owner);
  }

  #lateSpeechEvidence(owner: SpeechOwner, errorClass: VoiceErrorClass | null): void {
    this.#emit(
      { speechId: owner.speechId },
      {
        event: "sdk_metric",
        source: "late_observation",
        metric: "playout",
        errorClass,
      },
    );
  }

  #applySpeechFailure(speech: SpeechOwner, source: string, errorClass: VoiceErrorClass): void {
    if (speech.terminalEmitted) {
      this.#lateSpeechEvidence(speech, errorClass);
      return;
    }
    if (speech.associatedFailures.has(source) || speech.associatedFailures.size < SPEECH_FAILURE_SOURCE_LIMIT) {
      speech.associatedFailures.set(source, errorClass);
    }
    this.#refreshSpeechFailure(speech);
  }

  #removeSpeechFailure(speech: SpeechOwner, source: string): void {
    if (speech.terminalEmitted) return;
    speech.associatedFailures.delete(source);
    this.#refreshSpeechFailure(speech);
  }

  #refreshSpeechFailure(speech: SpeechOwner): void {
    for (const owner of this.#activeBridge.values()) this.#retainBridgeFailure(speech, owner);
    for (const owner of this.#recentBridge.values()) this.#retainBridgeFailure(speech, owner);
    for (const owner of this.#activeSynthesis.values()) this.#retainSynthesisFailure(speech, owner);
    for (const owner of this.#recentSynthesis.values()) this.#retainSynthesisFailure(speech, owner);
    speech.errorClass =
      speech.directErrorClass ?? speech.associatedFailures.values().next().value ?? speech.evictedOverflowFailureClass;
  }

  #retainBridgeFailure(speech: SpeechOwner, owner: BridgeOwner): void {
    if (owner.binding !== speech.speechId || !owner.errorClass) return;
    this.#retainFailure(speech, this.#bridgeFailureSource(owner.turnId), owner.errorClass);
  }

  #retainSynthesisFailure(speech: SpeechOwner, owner: SynthesisOwner): void {
    if (owner.binding !== speech.speechId || !owner.errorClass) return;
    this.#retainFailure(speech, this.#synthesisFailureSource(owner.synthesisId), owner.errorClass);
  }

  #retainFailure(speech: SpeechOwner, source: string, errorClass: VoiceErrorClass): void {
    if (speech.associatedFailures.has(source) || speech.associatedFailures.size < SPEECH_FAILURE_SOURCE_LIMIT) {
      speech.associatedFailures.set(source, errorClass);
    }
  }

  #sealEvictedOverflowFailure(speech: SpeechOwner, source: string, errorClass: VoiceErrorClass | null): void {
    if (speech.terminalEmitted || !errorClass || speech.associatedFailures.has(source)) return;
    speech.evictedOverflowFailureClass ??= errorClass;
    this.#refreshSpeechFailure(speech);
  }

  #bridgeFailureSource(turnId: string): string {
    return `bridge:${turnId}`;
  }

  #synthesisFailureSource(synthesisId: string): string {
    return `synthesis:${synthesisId}`;
  }

  #associateBridge(speechId: string, turnId: string): void {
    const speech = this.#speechById(speechId);
    if (!speech) {
      this.#gap("correlation_missing", { speechId, turnId });
      return;
    }
    if (speech.bridgeIds.has(turnId)) return;
    if (speech.bridgeIds.size >= SPEECH_BRIDGE_LIMIT) {
      if (!speech.terminalEmitted) speech.bridgeAssociationOverflow = true;
      this.#gap("association_overflow", { speechId, turnId });
      return;
    }
    if (speech.terminalEmitted) {
      this.#lateSpeechEvidence(speech, null);
      return;
    }
    speech.bridgeIds.add(turnId);
  }

  #associateSynthesis(speechId: string, synthesisId: string): boolean {
    const speech = this.#speechById(speechId);
    if (!speech) {
      this.#gap("correlation_missing", { speechId, synthesisId });
      return false;
    }
    if (speech.synthesisIds.has(synthesisId)) return true;
    if (speech.synthesisIds.size >= SPEECH_SYNTHESIS_LIMIT) {
      if (!speech.terminalEmitted) speech.synthesisAssociationOverflow = true;
      this.#gap("association_overflow", { speechId, synthesisId });
      return false;
    }
    if (speech.terminalEmitted) {
      this.#lateSpeechEvidence(speech, null);
      return false;
    }
    speech.synthesisIds.add(synthesisId);
    return true;
  }

  #speechById(speechId: string): SpeechOwner | undefined {
    return this.#activeSpeech.get(speechId) ?? this.#recentSpeech.get(speechId);
  }

  #speechForBinding(binding: string | null | "conflict"): SpeechOwner | undefined {
    return binding === null || binding === "conflict" ? undefined : this.#speechById(binding);
  }

  #boundId(binding: string | null | "conflict"): string | null {
    return binding === "conflict" ? null : binding;
  }

  #evictActiveSpeechIfNeeded(): void {
    if (this.#activeSpeech.size < ACTIVE_LIMIT) return;
    const oldest = this.#activeSpeech.values().next().value as SpeechOwner | undefined;
    if (!oldest) return;
    this.#gap("active_overflow", { speechId: oldest.speechId });
    this.#finalizeSpeech(oldest, "incomplete", "unknown", false, false, 0, undefined);
  }

  #evictActiveBridgeIfNeeded(): void {
    if (this.#activeBridge.size < ACTIVE_LIMIT) return;
    const oldest = this.#activeBridge.values().next().value as BridgeOwner | undefined;
    if (!oldest) return;
    this.#gap("active_overflow", { turnId: oldest.turnId, speechId: this.#boundId(oldest.binding) });
    this.#finishBridge(oldest, "incomplete", "unknown");
  }

  #evictActiveSynthesisIfNeeded(): void {
    if (this.#activeSynthesis.size < ACTIVE_LIMIT) return;
    const oldest = this.#activeSynthesis.values().next().value as SynthesisOwner | undefined;
    if (!oldest) return;
    this.#gap("active_overflow", {
      synthesisId: oldest.synthesisId,
      speechId: this.#boundId(oldest.binding),
    });
    this.#finishSynthesis(oldest, "incomplete", "unknown");
  }

  #addRecentSpeech(owner: SpeechOwner): void {
    this.#recentSpeech.set(owner.speechId, owner);
    if (this.#recentSpeech.size <= RECENT_LIMIT) return;
    const oldestId = this.#recentSpeech.keys().next().value as string;
    this.#recentSpeech.delete(oldestId);
    this.#gap("recent_cache_evicted", { speechId: oldestId });
  }

  #detachSpeechHandle(owner: SpeechOwner): void {
    try {
      owner.handle.removeDoneCallback(owner.doneCallback);
    } catch {
      this.#gap("listener_failed", { speechId: owner.speechId });
    }
  }

  #addRecentBridge(owner: BridgeOwner): void {
    this.#recentBridge.set(owner.turnId, owner);
    if (this.#recentBridge.size <= RECENT_LIMIT) return;
    const oldestId = this.#recentBridge.keys().next().value as string;
    const evicted = this.#recentBridge.get(oldestId);
    this.#recentBridge.delete(oldestId);
    if (evicted) {
      this.#countUnboundAssociation("bridge", evicted);
      const speech = this.#speechForBinding(evicted.binding);
      if (speech) {
        this.#sealEvictedOverflowFailure(speech, this.#bridgeFailureSource(evicted.turnId), evicted.errorClass);
      }
    }
    this.#gap("recent_cache_evicted", {
      turnId: oldestId,
      speechId: evicted ? this.#boundId(evicted.binding) : null,
    });
    this.#notifyBinding(oldestId);
  }

  #addRecentSynthesis(owner: SynthesisOwner): void {
    this.#recentSynthesis.set(owner.synthesisId, owner);
    if (this.#recentSynthesis.size <= RECENT_LIMIT) return;
    const oldestId = this.#recentSynthesis.keys().next().value as string;
    const evicted = this.#recentSynthesis.get(oldestId);
    this.#recentSynthesis.delete(oldestId);
    if (evicted) {
      if (evicted.audioContribution) evicted.audioContribution.finalized = true;
      this.#countUnboundAssociation("synthesis", evicted);
      if (evicted.binding === null || evicted.binding === "conflict") this.#unresolvedEvictedSynthesisCoverage = true;
      const speech = this.#speechForBinding(evicted.binding);
      if (speech) {
        this.#sealEvictedOverflowFailure(speech, this.#synthesisFailureSource(evicted.synthesisId), evicted.errorClass);
      }
    }
    this.#gap("recent_cache_evicted", {
      synthesisId: oldestId,
      speechId: evicted ? this.#boundId(evicted.binding) : null,
    });
  }

  #notifyBinding(turnId: string): void {
    const listener = this.#bindingListener;
    if (!listener) return;
    try {
      listener(turnId);
    } catch {
      this.#gap("listener_failed", { turnId });
    }
  }

  #countUnboundAssociation(kind: "bridge" | "synthesis", owner: BridgeOwner | SynthesisOwner): void {
    if (owner.associationCounted) return;
    owner.associationCounted = true;
    if (owner.binding === null || owner.binding === "conflict") this.#finalizedUnboundByAttemptKind[kind] += 1;
  }

  #currentUnboundByAttemptKind(): AttemptKindCounts {
    const counts = { ...this.#finalizedUnboundByAttemptKind };
    for (const owner of [...this.#activeBridge.values(), ...this.#recentBridge.values()]) {
      if (!owner.associationCounted && (owner.binding === null || owner.binding === "conflict")) counts.bridge += 1;
    }
    for (const owner of [...this.#activeSynthesis.values(), ...this.#recentSynthesis.values()]) {
      if (!owner.associationCounted && (owner.binding === null || owner.binding === "conflict")) counts.synthesis += 1;
    }
    return counts;
  }

  #hasUnresolvedSynthesisCoverage(): boolean {
    if (this.#unresolvedEvictedSynthesisCoverage) return true;
    for (const owner of [...this.#activeSynthesis.values(), ...this.#recentSynthesis.values()]) {
      if (owner.binding === null || owner.binding === "conflict") return true;
    }
    return false;
  }

  #refreshSpeechAudio(speech: SpeechOwner): void {
    const generatedAudio = speech.audioBySynthesis.size > 0;
    const generatedDurationMs = [...speech.audioBySynthesis.values()].reduce((sum, duration) => sum + duration, 0);
    speech.generatedAudio = generatedAudio;
    speech.generatedDurationMs = generatedDurationMs;
  }

  #attachAudioContribution(owner: SynthesisOwner): void {
    if (owner.audioContribution || owner.frameCount === 0 || owner.binding === null || owner.binding === "conflict") {
      return;
    }
    const retained = [...this.#activeSynthesis.values(), ...this.#recentSynthesis.values()].find(
      (candidate) =>
        candidate !== owner &&
        candidate.audioContribution !== null &&
        candidate.audioContribution.speechId === owner.binding,
    );
    if (retained?.audioContribution) {
      owner.audioContribution = retained.audioContribution;
      return;
    }
    const speech = this.#speechById(owner.binding);
    if (speech?.audioAggregateCounted) {
      owner.audioContribution = { speechId: owner.binding, finalized: true };
      return;
    }
    owner.audioContribution = { speechId: owner.binding, finalized: false };
    this.#generatedAudioObserved += 1;
    if (speech) speech.audioAggregateCounted = true;
  }

  #detachAudioContribution(owner: SynthesisOwner): void {
    const contribution = owner.audioContribution;
    if (!contribution) return;
    owner.audioContribution = null;
    const retained = [...this.#activeSynthesis.values(), ...this.#recentSynthesis.values()].some(
      (candidate) => candidate !== owner && candidate.audioContribution === contribution,
    );
    if (!contribution.finalized && !retained) {
      this.#generatedAudioObserved -= 1;
      const speech = this.#speechById(contribution.speechId);
      if (speech) speech.audioAggregateCounted = false;
    }
  }

  #validBridgeContext(context: BridgeTraceContext): boolean {
    return context.callId === this.#callId && context.workerBootId === this.#workerBootId && context.turnId.length > 0;
  }

  #validSynthesisContext(context: SynthesisTraceContext): boolean {
    return (
      context.callId === this.#callId && context.workerBootId === this.#workerBootId && context.synthesisId.length > 0
    );
  }

  #gap(
    reason:
      | ActionGapReason
      | "association_overflow"
      | "active_overflow"
      | "recent_cache_evicted"
      | "binding_conflict"
      | "correlation_missing"
      | "listener_failed"
      | "late_error_observed"
      | "provider_context_missing"
      | "start_pending"
      | "teardown_failed"
      | "teardown_timeout",
    ids: { speechId?: string | null; turnId?: string | null; synthesisId?: string | null },
  ): void {
    this.#diagnosticGaps += 1;
    this.#emit(ids, { event: "diagnostic_gap", reason, count: 1 });
  }

  #emit(
    ids: { speechId?: string | null; turnId?: string | null; synthesisId?: string | null },
    payload: Parameters<typeof voiceDiagnosticEvent>[1],
  ): void {
    try {
      this.#writer.write(
        voiceDiagnosticEvent(
          {
            component: "voice-worker",
            callId: this.#callId,
            workerBootId: this.#workerBootId,
            ...ids,
          },
          payload,
        ),
      );
    } catch {
      // Diagnostics never become a media-path failure and cannot recursively log.
    }
  }

  #safe(callback: () => void): void {
    try {
      callback();
    } catch {
      // Public recorder methods are synchronous and throw-safe by contract.
    }
  }
}

export function createSpeechTrace(options: SpeechTraceOptions): SpeechTrace {
  return new SpeechTrace(options);
}
