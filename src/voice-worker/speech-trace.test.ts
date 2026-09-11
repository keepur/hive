import { randomUUID } from "node:crypto";

import type { MetricsCollectedEvent } from "@livekit/agents";
import { describe, expect, it } from "vitest";

import type { VoiceDiagnosticEvent, VoiceTraceWriter } from "../voice/voice-trace.js";
import { parseVoiceDiagnosticEvent, reduceVoiceDiagnostics } from "../voice/voice-diagnostic-reader.js";
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
  removeDoneCallback(callback: (handle: SpeechHandle) => void): void {
    this.#callbacks = this.#callbacks.filter((candidate) => candidate !== callback);
  }
  get callbackCount(): number {
    return this.#callbacks.length;
  }
  callbacksSnapshot(): Array<(handle: SpeechHandle) => void> {
    return [...this.#callbacks];
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
  it("removes the exact public handle callback on settlement, active eviction, and close", () => {
    const settled = setup("settled");
    const settledHandle = new FakeSpeechHandle("speech-settled");
    settled.trace.speechCreated(settledHandle.asHandle(), "opening", 0);
    expect(settledHandle.callbackCount).toBe(1);
    settledHandle.settle();
    expect(settledHandle.callbackCount).toBe(0);

    const evicted = setup("evicted");
    const oldest = new FakeSpeechHandle("speech-oldest");
    evicted.trace.speechCreated(oldest.asHandle(), "opening", 0);
    for (let index = 0; index < 256; index += 1) {
      evicted.trace.speechCreated(new FakeSpeechHandle(`speech-${index}`).asHandle(), "opening", 0);
    }
    expect(oldest.callbackCount).toBe(0);

    const closed = setup("closed");
    const closedHandle = new FakeSpeechHandle("speech-closed");
    closed.trace.speechCreated(closedHandle.asHandle(), "opening", 0);
    const queuedCallback = closedHandle.callbacksSnapshot()[0]!;
    closed.trace.close("call_closed");
    expect(closedHandle.callbackCount).toBe(0);
    const rowsAfterClose = closed.rows.length;
    queuedCallback(closedHandle.asHandle());
    closedHandle.settle();
    expect(closed.rows).toHaveLength(rowsAfterClose);
  });

  it("emits producer-shaped rows accepted by the reader, including call-level public SDK observations", () => {
    const { rows, trace } = setup("producer-reader");
    const handle = new FakeSpeechHandle("speech-producer");
    trace.speechCreated(handle.asHandle(), "opening", 0);
    const bridge = trace.bridgeCreated(bridgeContext("producer-reader", "turn-producer"));
    bridge.started();
    bridge.response(200);
    bridge.finish("completed", "unknown");
    handle.chatItems.push({
      type: "message",
      role: "assistant",
      textContent: "content is counted only",
      interrupted: false,
      metrics: { startedSpeakingAt: 1 },
    });
    handle.settle();
    trace.outputPlayback();
    trace.outputPlayback(125, false);
    trace.falseInterruption();

    expect(rows.map(parseVoiceDiagnosticEvent)).not.toContain(null);
    expect(rows.filter((row) => row.event === "output_playback")).toEqual([
      expect.objectContaining({ speechId: null }),
      expect.objectContaining({ speechId: null }),
    ]);
    expect(rows.find((row) => row.event === "false_interruption")).toMatchObject({ speechId: null });
    expect(JSON.stringify(rows)).not.toContain("content is counted only");
  });

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

  it.each(["call_closed", "setup_failed"] as const)(
    "keeps an associated bridge failure ahead of %s cleanup",
    (cause) => {
      const { rows, trace } = setup();
      const handle = new FakeSpeechHandle(`speech-${cause}`);
      trace.speechCreated(handle.asHandle(), "sdk_response", 1);
      const bridge = trace.bridgeCreated(bridgeContext("call", `turn-${cause}`));
      bridge.bind(handle.id);
      bridge.fail("spawn_failed");
      bridge.finish("failed", "unknown");

      trace.close(cause);

      expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({
        outcome: "failed",
        errorClass: "spawn_failed",
      });
      expect(trace.snapshot().speechOutcomes).toMatchObject({ failed: 1, cancelled: 0, incomplete: 0 });
    },
  );

  it("keeps a known speech failure ahead of active-registry overflow cleanup", () => {
    const { rows, trace } = setup();
    const oldest = new FakeSpeechHandle("speech-overflow-failed");
    trace.speechCreated(oldest.asHandle(), "sdk_response", 0);
    const bridge = trace.bridgeCreated(bridgeContext("call", "turn-overflow-failed"));
    bridge.bind(oldest.id);
    bridge.fail("spawn_failed");
    bridge.finish("failed", "unknown");
    for (let index = 0; index < 256; index += 1) {
      trace.speechCreated(new FakeSpeechHandle(`overflow-${index}`).asHandle(), "opening", index);
    }

    expect(rows.find((row) => row.event === "speech_terminal" && row.speechId === oldest.id)).toMatchObject({
      outcome: "failed",
      errorClass: "spawn_failed",
    });
    expect(trace.snapshot().speechOutcomes.failed).toBe(1);
  });

  it.each([
    ["bridge", "spawn_failed"],
    ["synthesis", "tts_provider_failed"],
  ] as const)("removes only a conflicted %s failure attribution before speech settlement", (kind, errorClass) => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle(`speech-${kind}-conflict`);
    trace.speechCreated(handle.asHandle(), "fallback", 0);

    if (kind === "bridge") {
      const failed = trace.bridgeCreated(bridgeContext("call", "turn-failed"));
      failed.bind(handle.id);
      failed.fail(errorClass);
      failed.finish("failed", "unknown");
      failed.bind("speech-other");
    } else {
      const failed = trace.synthesisCreated(synthesisContext("call", "synth-failed"));
      failed.bind(handle.id);
      failed.fail(errorClass);
      failed.finish("failed", "unknown");
      failed.bind("speech-other");
    }
    handle.settle();

    expect(rows.find((row) => row.event === `${kind}_terminal`)).toMatchObject({ outcome: "failed" });
    expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({
      outcome: "incomplete",
      errorClass: null,
    });
    expect(trace.snapshot().speechOutcomes).toMatchObject({ failed: 0, incomplete: 1 });
    expect(trace.snapshot().unboundByAttemptKind[kind]).toBe(1);
    const report = reduceVoiceDiagnostics(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "call");
    expect(report.byOutcome.speech).toMatchObject({ failed: 0, incomplete: 1 });
    expect(report.unbound.byEntity[kind]).toBe(1);
  });

  it("retains another valid failure source when a failed owner later conflicts", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-two-errors");
    trace.speechCreated(handle.asHandle(), "sdk_response", 0);
    const first = trace.bridgeCreated(bridgeContext("call", "turn-first-error"));
    first.bind(handle.id);
    first.fail("spawn_failed");
    const second = trace.bridgeCreated(bridgeContext("call", "turn-second-error"));
    second.bind(handle.id);
    second.fail("engine_unreachable");
    first.bind("speech-conflict");
    handle.settle();

    expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({
      outcome: "failed",
      errorClass: "engine_unreachable",
    });
  });

  it.each(["bridge", "synthesis"] as const)(
    "keeps a terminal %s late error supplemental while an unsettled speech completes",
    (kind) => {
      const { rows, trace } = setup();
      const handle = new FakeSpeechHandle(`speech-late-${kind}-error`);
      trace.speechCreated(handle.asHandle(), "fallback", 0);

      const synthesis = trace.synthesisCreated(synthesisContext("call", `synth-late-${kind}-coverage`));
      synthesis.bind(handle.id);
      synthesis.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
      synthesis.finish("completed", "unknown");

      if (kind === "bridge") {
        const bridge = trace.bridgeCreated(bridgeContext("call", "turn-late-error"));
        bridge.bind(handle.id);
        bridge.finish("completed", "unknown");
        bridge.fail("spawn_failed");
      } else {
        synthesis.fail("tts_provider_failed");
      }
      handle.settle();

      expect(rows.find((row) => row.event === `${kind}_terminal`)).toMatchObject({
        outcome: "completed",
        errorClass: null,
      });
      expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({
        outcome: "completed",
        errorClass: null,
      });
      expect(rows.filter((row) => row.event === "diagnostic_gap" && row.reason === "late_error_observed")).toHaveLength(
        1,
      );
    },
  );

  it.each(["bridge", "synthesis"] as const)("keeps a preterminal %s error causal", (kind) => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle(`speech-preterminal-${kind}-error`);
    trace.speechCreated(handle.asHandle(), "fallback", 0);

    const synthesis = trace.synthesisCreated(synthesisContext("call", `synth-preterminal-${kind}`));
    synthesis.bind(handle.id);
    synthesis.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    if (kind === "bridge") {
      synthesis.finish("completed", "unknown");
      const bridge = trace.bridgeCreated(bridgeContext("call", "turn-preterminal-error"));
      bridge.bind(handle.id);
      bridge.fail("spawn_failed");
      bridge.finish("completed", "unknown");
    } else {
      synthesis.fail("tts_provider_failed");
      synthesis.finish("completed", "unknown");
    }
    handle.settle();

    expect(rows.find((row) => row.event === `${kind}_terminal`)).toMatchObject({ outcome: "failed" });
    expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({
      outcome: "failed",
      errorClass: kind === "bridge" ? "spawn_failed" : "tts_provider_failed",
    });
  });

  it("preserves a direct speech-handle failure after a terminal synthesis late error", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-direct-after-late-error");
    trace.speechCreated(handle.asHandle(), "fallback", 0);
    const synthesis = trace.synthesisCreated(synthesisContext("call", "synth-direct-after-late-error"));
    synthesis.bind(handle.id);
    synthesis.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    synthesis.finish("completed", "unknown");
    synthesis.fail("tts_provider_failed");
    handle.settle(new Error("direct handle failure"));

    expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({
      outcome: "failed",
      errorClass: "speech_handle_failed",
    });
  });

  it.each(["bridge", "synthesis"] as const)(
    "keeps a settled speech outcome immutable when a failed %s owner later conflicts",
    (kind) => {
      const { rows, trace } = setup();
      const handle = new FakeSpeechHandle(`speech-settled-${kind}`);
      trace.speechCreated(handle.asHandle(), "fallback", 0);
      if (kind === "bridge") {
        const failed = trace.bridgeCreated(bridgeContext("call", "turn-settled"));
        failed.bind(handle.id);
        failed.fail("spawn_failed");
        failed.finish("failed", "unknown");
        handle.settle();
        failed.fail("unknown");
        failed.bind("speech-other");
      } else {
        const failed = trace.synthesisCreated(synthesisContext("call", "synth-settled"));
        failed.bind(handle.id);
        failed.fail("tts_provider_failed");
        failed.finish("failed", "unknown");
        handle.settle();
        failed.fail("tts_node_failed");
        failed.bind("speech-other");
      }

      expect(rows.filter((row) => row.event === "speech_terminal")).toHaveLength(1);
      expect(rows.find((row) => row.event === "speech_terminal")).toMatchObject({ outcome: "failed" });
      expect(rows.some((row) => row.event === "sdk_metric" && row.source === "late_observation")).toBe(false);
      expect(rows.some((row) => row.event === "diagnostic_gap" && row.reason === "late_error_observed")).toBe(true);
      expect(rows.some((row) => row.event === "diagnostic_gap" && row.reason === "binding_conflict")).toBe(true);
      const report = reduceVoiceDiagnostics(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "call");
      expect(report.byOutcome.speech).toMatchObject({ failed: 1 });
      expect(report.details.speech[0]?.lateSupplements).toHaveLength(0);
    },
  );

  it.each(["active", "terminated"] as const)(
    "keeps successful bound speech incomplete while %s unbound synthesis coverage is unresolved",
    (state) => {
      const { trace } = setup();
      const unknown = trace.synthesisCreated(synthesisContext("call", `synth-unbound-${state}`));
      if (state === "terminated") {
        unknown.fail("tts_provider_failed");
        unknown.finish("failed", "unknown");
      }

      const handle = new FakeSpeechHandle(`speech-covered-${state}`);
      trace.speechCreated(handle.asHandle(), "fallback", 0);
      const bound = trace.synthesisCreated(synthesisContext("call", `synth-bound-${state}`));
      bound.bind(handle.id);
      bound.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
      bound.finish("completed", "unknown");
      handle.settle();

      expect(trace.snapshot()).toMatchObject({
        speechOutcomes: { completed: 0, failed: 0, incomplete: 1 },
        synthesisOutcomes: state === "terminated" ? { failed: 1, completed: 1 } : { failed: 0, completed: 1 },
      });
    },
  );

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
    expect(snapshot).toMatchObject({
      unbound: 1,
      unboundByAttemptKind: { speech: 0, bridge: 1, synthesis: 0 },
      unboundObservations: 1,
    });
    expect(snapshot.registry.activeBridge).toBe(0);
  });

  it("counts unbound attempts once per entity and separates synthesized from bound-speech audio", () => {
    const { rows, trace } = setup();
    const bridge = trace.bridgeCreated(bridgeContext("call", "unbound-bridge"));
    bridge.finish("cancelled", "call_closed");
    const synthesis = trace.synthesisCreated(synthesisContext("call", "unbound-synthesis"));
    synthesis.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    synthesis.finish("failed", "unknown");

    expect(trace.snapshot()).toMatchObject({
      synthesizedAudioObserved: 1,
      generatedAudioObserved: 0,
      unbound: 2,
      unboundByAttemptKind: { speech: 0, bridge: 1, synthesis: 1 },
      unboundObservations: 0,
    });
    const report = reduceVoiceDiagnostics(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "call");
    expect(report).toMatchObject({
      bridgeAttempts: 1,
      synthesisAttempts: 1,
      synthesizedAudioObserved: 1,
      generatedAudioObserved: 0,
      unbound: { total: 2, byEntity: { bridge: 1, synthesis: 1 } },
      byOutcome: { bridge: { cancelled: 1 }, synthesis: { failed: 1 } },
      incomplete: { total: 0 },
    });
    trace.close("call_closed");
    expect(trace.snapshot().unboundByAttemptKind).toEqual({ speech: 0, bridge: 1, synthesis: 1 });
  });

  it("resolves genuine late bindings, counts conflicts once, and accounts final retention eviction", () => {
    const late = setup();
    const lateBridge = late.trace.bridgeCreated(bridgeContext("call", "late-bridge"));
    lateBridge.finish("completed", "unknown");
    lateBridge.bind("speech-late");
    const lateSynthesis = late.trace.synthesisCreated(synthesisContext("call", "late-synthesis"));
    lateSynthesis.finish("completed", "unknown");
    lateSynthesis.bind("speech-late");
    expect(late.trace.snapshot().unbound).toBe(0);

    const conflict = setup();
    const conflicting = conflict.trace.bridgeCreated(bridgeContext("call", "conflicting-bridge"));
    conflicting.bind("speech-a");
    conflicting.bind("speech-b");
    conflicting.bind("speech-a");
    expect(conflict.trace.snapshot().unboundByAttemptKind.bridge).toBe(1);

    const speech = new FakeSpeechHandle("speech-synthesis-conflict");
    conflict.trace.speechCreated(speech.asHandle(), "fallback", 0);
    const conflictingSynthesis = conflict.trace.synthesisCreated(synthesisContext("call", "conflicting-synthesis"));
    conflictingSynthesis.bind(speech.id);
    conflictingSynthesis.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    expect(conflict.trace.snapshot().generatedAudioObserved).toBe(1);
    conflictingSynthesis.bind("speech-other");
    expect(conflict.trace.snapshot()).toMatchObject({
      synthesizedAudioObserved: 1,
      generatedAudioObserved: 0,
      unboundByAttemptKind: { bridge: 1, synthesis: 1 },
    });

    const eviction = setup();
    for (let index = 0; index <= 256; index += 1) {
      eviction.trace.bridgeCreated(bridgeContext("call", `evicted-${index}`)).finish("completed", "unknown");
    }
    expect(eviction.trace.snapshot()).toMatchObject({
      unbound: 257,
      unboundByAttemptKind: { speech: 0, bridge: 257, synthesis: 0 },
      registry: { recentBridge: 256 },
    });
  });

  it("keeps producer and reader generated-audio totals consistent after a terminal late binding", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-late-audio");
    trace.speechCreated(handle.asHandle(), "fallback", 0);
    handle.settle();
    const synthesis = trace.synthesisCreated(synthesisContext("call", "synth-late-audio"));
    synthesis.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    synthesis.finish("completed", "unknown");
    synthesis.bind(handle.id);

    const report = reduceVoiceDiagnostics(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "call");
    expect(trace.snapshot()).toMatchObject({ synthesizedAudioObserved: 1, generatedAudioObserved: 1 });
    expect(report).toMatchObject({ synthesizedAudioObserved: 1, generatedAudioObserved: 1 });
  });

  it("counts generated audio once per speech while retaining independent synthesis totals", () => {
    const { trace } = setup();
    const handle = new FakeSpeechHandle("speech-multiple-syntheses");
    trace.speechCreated(handle.asHandle(), "fallback", 0);
    const first = trace.synthesisCreated(synthesisContext("call", "synth-first"));
    first.bind(handle.id);
    first.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    const second = trace.synthesisCreated(synthesisContext("call", "synth-second"));
    second.bind(handle.id);
    second.frame({ sampleRate: 24_000, samplesPerChannel: 240 });

    expect(trace.snapshot()).toMatchObject({ synthesizedAudioObserved: 2, generatedAudioObserved: 1 });
    first.bind("speech-conflict-a");
    expect(trace.snapshot()).toMatchObject({ synthesizedAudioObserved: 2, generatedAudioObserved: 1 });
    second.bind("speech-conflict-b");
    expect(trace.snapshot()).toMatchObject({ synthesizedAudioObserved: 2, generatedAudioObserved: 0 });
  });

  it("restores one audio aggregate after terminal conflict invalidation and a valid late rebind", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-terminal-audio-rebind");
    trace.speechCreated(handle.asHandle(), "fallback", 0);
    const original = trace.synthesisCreated(synthesisContext("call", "synth-terminal-audio-original"));
    original.bind(handle.id);
    original.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    original.finish("completed", "unknown");
    handle.settle();
    expect(trace.snapshot().generatedAudioObserved).toBe(1);

    original.bind("speech-conflict");
    expect(trace.snapshot().generatedAudioObserved).toBe(0);

    const rebound = trace.synthesisCreated(synthesisContext("call", "synth-terminal-audio-rebound"));
    rebound.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    rebound.finish("completed", "unknown");
    rebound.bind(handle.id);
    rebound.bind(handle.id);
    const duplicate = trace.synthesisCreated(synthesisContext("call", "synth-terminal-audio-duplicate"));
    duplicate.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    duplicate.finish("completed", "unknown");
    duplicate.bind(handle.id);
    expect(trace.snapshot().generatedAudioObserved).toBe(1);

    for (let index = 0; index < 257; index += 1) {
      trace
        .synthesisCreated(synthesisContext("call", `synth-terminal-audio-empty-${index}`))
        .finish("completed", "unknown");
    }
    expect(trace.snapshot()).toMatchObject({ generatedAudioObserved: 1, registry: { recentSynthesis: 256 } });
    trace.close("call_closed");

    const report = reduceVoiceDiagnostics(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "call");
    expect(trace.snapshot()).toMatchObject({ generatedAudioObserved: 1, registry: { recentSynthesis: 0 } });
    expect(report.generatedAudioObserved).toBe(1);
  });

  it("finalizes generated-audio accounting when its retained synthesis owner is evicted and on close", () => {
    const { rows, trace } = setup();
    const handle = new FakeSpeechHandle("speech-finalized-audio");
    trace.speechCreated(handle.asHandle(), "fallback", 0);
    const synthesis = trace.synthesisCreated(synthesisContext("call", "synth-finalized-audio"));
    synthesis.bind(handle.id);
    synthesis.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    synthesis.finish("completed", "unknown");
    handle.settle();
    for (let index = 0; index <= 256; index += 1) {
      trace.synthesisCreated(synthesisContext("call", `synth-empty-${index}`)).finish("completed", "unknown");
    }

    expect(trace.snapshot()).toMatchObject({ generatedAudioObserved: 1, registry: { recentSynthesis: 256 } });
    trace.close("call_closed");
    const report = reduceVoiceDiagnostics(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "call");
    expect(trace.snapshot()).toMatchObject({ generatedAudioObserved: 1, registry: { recentSynthesis: 0 } });
    expect(report.generatedAudioObserved).toBe(1);
  });

  it("reverses retained generated-audio contribution after speech-cache eviction and binding conflict", () => {
    const { rows, trace } = setup();
    const target = new FakeSpeechHandle("speech-evicted-audio");
    trace.speechCreated(target.asHandle(), "fallback", 0);
    const synthesis = trace.synthesisCreated(synthesisContext("call", "synth-evicted-audio"));
    synthesis.bind(target.id);
    synthesis.frame({ sampleRate: 24_000, samplesPerChannel: 240 });
    synthesis.finish("completed", "unknown");
    target.settle();
    for (let index = 0; index <= 256; index += 1) {
      const handle = new FakeSpeechHandle(`settled-${index}`);
      trace.speechCreated(handle.asHandle(), "opening", index);
      handle.settle();
    }
    synthesis.bind("speech-conflict");

    const report = reduceVoiceDiagnostics(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "call");
    expect(trace.snapshot()).toMatchObject({ synthesizedAudioObserved: 1, generatedAudioObserved: 0 });
    expect(report).toMatchObject({ synthesizedAudioObserved: 1, generatedAudioObserved: 0 });
  });
});
