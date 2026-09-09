import { randomUUID } from "node:crypto";

import type { MetricsCollectedEvent } from "@livekit/agents";
import { describe, expect, it } from "vitest";

import type { VoiceDiagnosticEvent, VoiceTraceWriter } from "../voice/voice-trace.js";
import { SpeechTrace, type CallDiagnosticCounts, type SpeechHandle } from "./speech-trace.js";
import { bridgeTraceContext, synthesisTraceContext } from "./trace-context.js";

const BOOT = randomUUID();

function collectingWriter() {
  const rows: VoiceDiagnosticEvent[] = [];
  const logging = {
    attempted: 0,
    acknowledged: 0,
    filtered: 0,
    failed: 0,
    overflow: 0,
    pending: 0,
    unacknowledged: 0,
    sinkErrors: 0,
    complete: true,
  };
  const writer: VoiceTraceWriter = {
    write(row) {
      rows.push(row);
    },
    emit(row) {
      rows.push(row);
    },
    snapshot: () => ({ ...logging, attempted: rows.length, acknowledged: rows.length }),
    settleWrites: async () => ({ ...logging, attempted: rows.length, acknowledged: rows.length }),
  };
  return { rows, writer };
}

class FakeSpeechHandle {
  readonly id: string;
  interrupted = false;
  chatItems: Array<{
    type: "message";
    role: "assistant";
    textContent?: string;
    interrupted: boolean;
    metrics: { startedSpeakingAt?: number };
  }> = [];
  #error: unknown = null;
  #callbacks: Array<(handle: SpeechHandle) => void> = [];

  constructor(id: string) {
    this.id = id;
  }
  addDoneCallback(callback: (handle: SpeechHandle) => void): void {
    this.#callbacks.push(callback);
  }
  exception(): unknown {
    return this.#error;
  }
  settle(error: unknown = null): void {
    this.#error = error;
    for (const callback of this.#callbacks) callback(this as unknown as SpeechHandle);
  }
  asHandle(): SpeechHandle {
    return this as unknown as SpeechHandle;
  }
}

function setup(callId = "call") {
  const { rows, writer } = collectingWriter();
  return { rows, trace: new SpeechTrace({ callId, workerBootId: BOOT, writer }) };
}

function bridgeContext(callId: string, turnId: string) {
  return Object.freeze({ workerBootId: BOOT, callId, turnId });
}

function synthesisContext(callId: string, synthesisId: string) {
  return Object.freeze({ workerBootId: BOOT, callId, synthesisId });
}

function llmMetric(speechId: string, ttftMs = 5): MetricsCollectedEvent {
  return {
    type: "metrics_collected",
    createdAt: Date.now(),
    metrics: {
      type: "llm_metrics",
      label: "fixture",
      requestId: "",
      timestamp: Date.now(),
      durationMs: 9,
      ttftMs,
      cancelled: false,
      completionTokens: 1,
      promptTokens: 1,
      promptCachedTokens: 0,
      totalTokens: 2,
      tokensPerSecond: 1,
      speechId,
    },
  };
}

function ttsMetric(speechId: string, ttfbMs = 6): MetricsCollectedEvent {
  return {
    type: "metrics_collected",
    createdAt: Date.now(),
    metrics: {
      type: "tts_metrics",
      label: "fixture",
      requestId: "",
      timestamp: Date.now(),
      ttfbMs,
      durationMs: 8,
      audioDurationMs: 4,
      cancelled: false,
      charactersCount: 1,
      streamed: true,
      speechId,
    },
  };
}

function eouMetric(speechId: string, eouMs = 4): MetricsCollectedEvent {
  return {
    type: "metrics_collected",
    createdAt: Date.now(),
    metrics: {
      type: "eou_metrics",
      timestamp: Date.now(),
      endOfUtteranceDelayMs: eouMs,
      transcriptionDelayMs: 0,
      onUserTurnCompletedDelayMs: 0,
      lastSpeakingTimeMs: 0,
      speechId,
    },
  };
}

function completeEligibleSpeech(
  trace: SpeechTrace,
  handle: FakeSpeechHandle,
  index: number,
  options: { duplicateTtsObject?: boolean; secondTtsMetric?: boolean } = {},
): void {
  const speechId = handle.id;
  trace.speechCreated(handle.asHandle(), "sdk_response", index);
  const bridgeCtx = bridgeContext("call", `turn-${index}`);
  const bridge = trace.bridgeCreated(bridgeCtx);
  bridge.started();
  bridge.response(200);
  bridge.text(1, performance.now() + 5);
  bridge.finish("completed", "unknown");
  bridgeTraceContext.run(bridgeCtx, () => trace.metrics(llmMetric(speechId)));
  const synthCtx = synthesisContext("call", `synth-${index}`);
  const synth = trace.synthesisCreated(synthCtx);
  synth.frame({ sampleRate: 10, samplesPerChannel: 10 });
  const metric = ttsMetric(speechId, 6);
  synthesisTraceContext.run(synthCtx, () => trace.metrics(metric));
  if (options.duplicateTtsObject) synthesisTraceContext.run(synthCtx, () => trace.metrics(metric));
  if (options.secondTtsMetric) synthesisTraceContext.run(synthCtx, () => trace.metrics(ttsMetric(speechId, 6)));
  synth.finish("completed", "unknown");
  trace.metrics(eouMetric(speechId, 4));
  handle.settle();
}

describe("immutable trace contexts", () => {
  it("keeps bridge and synthesis scopes separate across overlapping async work", async () => {
    const bridge = Object.freeze({ workerBootId: BOOT, callId: "call", turnId: "turn-a" });
    const synthesis = Object.freeze({ workerBootId: BOOT, callId: "call", synthesisId: "synth-b" });
    const observed = await Promise.all([
      bridgeTraceContext.run(bridge, async () => {
        await Promise.resolve();
        return { bridge: bridgeTraceContext.getStore(), synthesis: synthesisTraceContext.getStore() };
      }),
      synthesisTraceContext.run(synthesis, async () => {
        await Promise.resolve();
        return { bridge: bridgeTraceContext.getStore(), synthesis: synthesisTraceContext.getStore() };
      }),
    ]);
    expect(observed).toEqual([
      { bridge, synthesis: undefined },
      { bridge: undefined, synthesis },
    ]);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(synthesis)).toBe(true);
  });
});

describe("schema-v2 latency eligibility", () => {
  it("retains one eligible stage estimate and deduplicates the same metric object", () => {
    const { trace } = setup();
    completeEligibleSpeech(trace, new FakeSpeechHandle("speech-eligible"), 1, { duplicateTtsObject: true });
    const snapshot = trace.snapshot();
    expect(snapshot.eligibleLatencyEstimateCount).toBe(1);
    expect(snapshot.latencyEstimateSamples).toHaveLength(1);
    expect(snapshot.latencyEstimateSamples[0]).toBeGreaterThanOrEqual(14);
    expect(snapshot.latencyEstimateSamples[0]).toBeLessThan(20);
    expect(Object.values(snapshot.excludedByReason).reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it("excludes distinct TTS segment metrics as ambiguous instead of choosing by arrival", () => {
    const { trace } = setup();
    completeEligibleSpeech(trace, new FakeSpeechHandle("speech-segments"), 2, { secondTtsMetric: true });
    const snapshot = trace.snapshot();
    expect(snapshot.eligibleLatencyEstimateCount).toBe(0);
    expect(snapshot.latencyEstimateSamples).toEqual([]);
    expect(snapshot.excludedByReason.ambiguous_components).toBe(1);
  });

  it("keeps opening, interrupted, cancelled, incomplete, and missing-metric exclusions distinct", () => {
    const { trace } = setup();
    const opening = new FakeSpeechHandle("opening");
    trace.speechCreated(opening.asHandle(), "opening", 0);
    opening.settle();

    const interrupted = new FakeSpeechHandle("interrupted");
    trace.speechCreated(interrupted.asHandle(), "sdk_response", 1);
    interrupted.interrupted = true;
    interrupted.settle();

    const cancelled = new FakeSpeechHandle("cancelled");
    trace.speechCreated(cancelled.asHandle(), "sdk_response", 2);
    trace.markCancellation(cancelled.id, "startup_superseded");
    cancelled.interrupted = true;
    cancelled.settle();

    const incomplete = new FakeSpeechHandle("incomplete");
    trace.speechCreated(incomplete.asHandle(), "sdk_response", 3);
    incomplete.settle();

    expect(trace.snapshot()).toMatchObject({
      sdkInterruptions: 2,
      cancelledSpeechAttempts: 1,
      excludedByReason: {
        not_applicable: 1,
        interrupted: 1,
        cancelled: 1,
        incomplete: 1,
      },
    });
  });

  it("counts an interrupted handle independently when call close owns cancellation", () => {
    const { trace } = setup();
    const handle = new FakeSpeechHandle("speech-close-interrupted");
    trace.speechCreated(handle.asHandle(), "opening", 0);
    handle.interrupted = true;
    trace.close("call_closed");
    expect(trace.snapshot()).toMatchObject({
      sdkInterruptions: 1,
      cancelledSpeechAttempts: 1,
      speechOutcomes: { cancelled: 1 },
      excludedByReason: { not_applicable: 1 },
    });
  });

  it("retains only the deterministic first 1,024 eligible samples", () => {
    const { trace } = setup();
    for (let index = 0; index < 1_030; index += 1) {
      completeEligibleSpeech(trace, new FakeSpeechHandle(`speech-${index}`), index);
    }
    const snapshot = trace.snapshot();
    expect(snapshot.eligibleLatencyEstimateCount).toBe(1_030);
    expect(snapshot.latencyEstimateSamples).toHaveLength(1_024);
  });
});

describe("speech lifecycle", () => {
  it("records cancellation before metrics and finalizes a duplicate callback once", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-cancel");
    trace.speechCreated(handle.asHandle(), "opening", 1);
    trace.speechCreated(handle.asHandle(), "opening", 1);
    trace.markCancellation(handle.id, "startup_superseded");
    handle.interrupted = true;
    handle.settle();
    handle.settle();

    expect(rows.filter((row) => row.event === "speech_started")).toHaveLength(1);
    expect(rows.filter((row) => row.event === "speech_terminal")).toHaveLength(1);
    expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({
      speechId: handle.id,
      outcome: "cancelled",
      cause: "startup_superseded",
      sdkInterrupted: true,
    });
    expect(trace.snapshot().speechOutcomes.cancelled).toBe(1);
  });

  it("completes application say with genuine bound generated frames and no bridge", () => {
    const { trace } = setup();
    const handle = new FakeSpeechHandle("speech-say");
    trace.speechCreated(handle.asHandle(), "fallback", 0);
    const synth = trace.synthesisCreated(synthesisContext("call", "synth-say"));
    synth.bind(handle.id);
    synth.frame({ sampleRate: 24_000, samplesPerChannel: 2_400 });
    synth.finish("completed", "unknown");
    handle.chatItems.push({
      type: "message",
      role: "assistant",
      textContent: "hello",
      interrupted: false,
      metrics: { startedSpeakingAt: 123 },
    });
    handle.settle();

    expect(trace.snapshot()).toMatchObject({
      speechOutcomes: { completed: 1 },
      generatedAudioObserved: 1,
      knownPlayoutObserved: 1,
    });
  });

  it("records missing synthesis and missing generated-reply bridge as incomplete", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-missing");
    trace.speechCreated(handle.asHandle(), "sdk_response", 2);
    handle.settle();

    expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({
      outcome: "incomplete",
      generatedAudio: false,
      generatedDurationMs: { value: null, reason: "correlation_missing" },
    });
  });

  it("keeps an observed application failure ahead of cancellation and normal settlement", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-fail");
    trace.speechCreated(handle.asHandle(), "opening", 0);
    const synth = trace.synthesisCreated(synthesisContext("call", "synth-fail"));
    synth.bind(handle.id);
    synth.fail("tts_provider_failed");
    synth.finish("cancelled", "framework_cancelled");
    trace.markCancellation(handle.id, "call_closed");
    handle.settle();

    expect(rows.find((row) => row.event === "synthesis_terminal")).toMatchObject({ outcome: "failed" });
    expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({
      outcome: "failed",
      errorClass: "tts_provider_failed",
    });
  });

  it("retains frame totals when a provider failure arrives after the first frame", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-frame-fail");
    trace.speechCreated(handle.asHandle(), "opening", 0);
    const synth = trace.synthesisCreated(synthesisContext("call", "synth-frame-fail"));
    synth.bind(handle.id);
    synth.frame({ sampleRate: 24_000, samplesPerChannel: 1_200 });
    trace.synthesisFailure("synth-frame-fail", "tts_provider_failed");
    synth.finish("completed", "unknown");
    handle.settle();

    expect(rows.find((row) => row.event === "synthesis_terminal")).toMatchObject({
      outcome: "failed",
      frameCount: 1,
      sampleCount: 1200,
      generatedDurationMs: { value: 50, reason: null },
    });
    expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({ outcome: "failed" });
  });

  it("retains terminal precedence and emits only supplemental late evidence", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-late");
    trace.speechCreated(handle.asHandle(), "opening", 0);
    handle.settle();
    const before = trace.snapshot().speechOutcomes.incomplete;
    const synth = trace.synthesisCreated(synthesisContext("call", "synth-late"));
    synth.bind(handle.id);
    synth.frame({ sampleRate: 16_000, samplesPerChannel: 160 });
    synth.fail("tts_provider_failed");
    synth.finish("failed", "unknown");

    expect(trace.snapshot().speechOutcomes.incomplete).toBe(before);
    expect(rows.filter((row) => row.event === "speech_terminal")).toHaveLength(1);
    expect(rows.some((row) => row.event === "sdk_metric" && row.source === "late_observation")).toBe(true);
  });
});

describe("bridge binding ownership", () => {
  it("supports read-before-subscribe, subscribe-before-bind, late bind, duplicates, and disposal", () => {
    const { trace } = setup();
    const first = trace.bridgeCreated(bridgeContext("call", "turn-first"));
    first.bind("speech-first");
    expect(trace.bridgeBinding("turn-first")).toEqual({ state: "bound", speechId: "speech-first" });

    const second = trace.bridgeCreated(bridgeContext("call", "turn-second"));
    const notifications: string[] = [];
    const dispose = trace.onBridgeBinding((turnId) => notifications.push(turnId));
    expect(trace.bridgeBinding("turn-second")).toEqual({ state: "unbound" });
    second.finish("completed", "unknown");
    expect(notifications).toEqual([]);
    second.bind("speech-second");
    second.bind("speech-second");
    expect(notifications).toEqual(["turn-second"]);
    expect(trace.bridgeBinding("turn-second")).toEqual({ state: "bound", speechId: "speech-second" });
    dispose();
    dispose();
    first.bind("speech-other");
    expect(notifications).toEqual(["turn-second"]);
  });

  it("makes conflict permanent and contains a throwing subscriber", () => {
    const { rows, trace } = setup();
    const bridge = trace.bridgeCreated(bridgeContext("call", "turn-conflict"));
    let calls = 0;
    trace.onBridgeBinding(() => {
      calls += 1;
      throw new Error("subscriber");
    });
    bridge.bind("speech-one");
    bridge.bind("speech-two");
    bridge.bind("speech-one");

    expect(trace.bridgeBinding("turn-conflict")).toEqual({ state: "unavailable", reason: "conflict" });
    expect(calls).toBe(2);
    expect(rows.filter((row) => row.event === "diagnostic_gap" && row.reason === "listener_failed")).toHaveLength(2);
  });

  it("invalidates retained lookups before close notifications and closes only once", () => {
    const { trace } = setup();
    const bridge = trace.bridgeCreated(bridgeContext("call", "turn-close"));
    bridge.bind("speech-close");
    const states: unknown[] = [];
    trace.onBridgeBinding((turnId) => states.push(trace.bridgeBinding(turnId)));
    trace.close("call_closed");
    trace.close("call_closed");

    expect(states).toEqual([{ state: "unavailable", reason: "closed" }]);
    expect(trace.snapshot().bridgeOutcomes.cancelled).toBe(1);
  });

  it("evicts the final recent lookup only after its terminal movement", () => {
    const { rows, trace } = setup();
    const first = trace.bridgeCreated(bridgeContext("call", "turn-0"));
    first.bind("speech-0");
    first.finish("completed", "unknown");
    const notified: string[] = [];
    trace.onBridgeBinding((turnId) => notified.push(turnId));
    for (let index = 1; index <= 256; index += 1) {
      trace.bridgeCreated(bridgeContext("call", `turn-${index}`)).finish("completed", "unknown");
    }

    expect(trace.bridgeBinding("turn-0")).toEqual({ state: "unavailable", reason: "evicted" });
    expect(notified).toContain("turn-0");
    expect(rows.some((row) => row.event === "diagnostic_gap" && row.reason === "recent_cache_evicted")).toBe(true);
    expect(trace.snapshot().registry.recentBridge).toBe(256);
  });
});

describe("bounded attempt registries and metrics", () => {
  it("preserves a nullable speech action gap with the original turn identity", () => {
    const { rows, trace } = setup();
    trace.actionGap("action_overflow", null, "evicted-turn");
    expect(rows).toContainEqual(
      expect.objectContaining({
        event: "diagnostic_gap",
        reason: "action_overflow",
        speechId: null,
        turnId: "evicted-turn",
      }),
    );
  });

  it("terminalizes the oldest of 257 active entities and keeps all maps bounded", () => {
    const { rows, trace } = setup();
    for (let index = 0; index < 257; index += 1) {
      trace.bridgeCreated(bridgeContext("call", `active-${index}`));
      trace.synthesisCreated(synthesisContext("call", `synth-${index}`));
    }
    const snapshot = trace.snapshot();
    expect(snapshot.registry).toMatchObject({
      activeBridge: 256,
      recentBridge: 1,
      activeSynthesis: 256,
      recentSynthesis: 1,
    });
    expect(snapshot.bridgeOutcomes.incomplete).toBe(1);
    expect(snapshot.synthesisOutcomes.incomplete).toBe(1);
    expect(rows.filter((row) => row.event === "diagnostic_gap" && row.reason === "active_overflow")).toHaveLength(2);
  });

  it("preserves association rows but caps speech-side bridge and synthesis sets", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-associations");
    trace.speechCreated(handle.asHandle(), "sdk_response", 0);
    for (let index = 0; index < 17; index += 1) {
      trace.bridgeCreated(bridgeContext("call", `bridge-${index}`)).bind(handle.id);
    }
    for (let index = 0; index < 33; index += 1) {
      trace.synthesisCreated(synthesisContext("call", `synthesis-${index}`)).bind(handle.id);
    }
    expect(rows.filter((row) => row.event === "bridge_bound")).toHaveLength(17);
    expect(rows.filter((row) => row.event === "synthesis_bound")).toHaveLength(33);
    expect(rows.filter((row) => row.event === "diagnostic_gap" && row.reason === "association_overflow")).toHaveLength(
      2,
    );
  });

  it("joins reversed overlapping metrics only through their immutable ALS contexts", () => {
    const { rows, trace } = setup();
    trace.bridgeCreated(bridgeContext("call", "turn-a"));
    trace.bridgeCreated(bridgeContext("call", "turn-b"));
    bridgeTraceContext.run(bridgeContext("call", "turn-b"), () => trace.metrics(llmMetric("speech-b")));
    bridgeTraceContext.run(bridgeContext("call", "turn-a"), () => trace.metrics(llmMetric("speech-a", -1)));

    expect(trace.bridgeBinding("turn-a")).toEqual({ state: "bound", speechId: "speech-a" });
    expect(trace.bridgeBinding("turn-b")).toEqual({ state: "bound", speechId: "speech-b" });
    expect(rows.find((row) => row.event === "sdk_metric" && row.turnId === "turn-a")).toMatchObject({
      speechId: "speech-a",
      ttftMs: { value: null, reason: "not_observed" },
    });
  });

  it("binds TTS from its own context after first frame and retains mixed-rate duration", () => {
    const { rows, trace } = setup();
    const synth = trace.synthesisCreated(synthesisContext("call", "synth-mixed"));
    synth.frame({ sampleRate: 10, samplesPerChannel: 10 });
    synth.frame({ sampleRate: 20, samplesPerChannel: 20 });
    synthesisTraceContext.run(synthesisContext("call", "synth-mixed"), () => trace.metrics(ttsMetric("speech-mixed")));
    synth.finish("completed", "unknown");

    expect(rows.find((row) => row.event === "synthesis_terminal")).toMatchObject({
      speechId: "speech-mixed",
      frameCount: 2,
      sampleCount: 30,
      sampleRate: null,
      sampleRateReason: "not_applicable",
      generatedDurationMs: { value: 2000, reason: null },
    });
  });

  it("counts each terminal once through close and reports call-level unbound provider failures", () => {
    const { trace } = setup();
    trace.unboundProviderFailure("tts", "tts_provider_failed");
    const bridge = trace.bridgeCreated(bridgeContext("call", "empty"));
    bridge.started();
    bridge.finish("completed", "unknown");
    bridge.finish("failed", "unknown");
    trace.close("call_closed");

    const snapshot: CallDiagnosticCounts = trace.snapshot();
    expect(snapshot.bridgeOutcomes.completed).toBe(1);
    expect(snapshot.bridgeOutcomes.failed).toBe(0);
    expect(snapshot.unbound).toBe(1);
    expect(snapshot.registry.activeBridge).toBe(0);
  });
});
