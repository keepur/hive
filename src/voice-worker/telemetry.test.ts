import { voice, type MetricsCollectedEvent } from "@livekit/agents";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VendorCell } from "./cells.js";
import type { WorkerConfig } from "./worker-config.js";

const { mockLog, mongoMocks } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mongoMocks: {
    insertOne: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    db: vi.fn(),
    collection: vi.fn(),
    MongoClient: vi.fn(),
  },
}));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => mockLog,
}));

vi.mock("mongodb", () => {
  mongoMocks.collection.mockImplementation(() => ({ insertOne: mongoMocks.insertOne }));
  mongoMocks.db.mockImplementation(() => ({ collection: mongoMocks.collection }));
  mongoMocks.MongoClient.mockImplementation(function MongoClient() {
    return {
      connect: mongoMocks.connect,
      db: mongoMocks.db,
      close: mongoMocks.close,
    };
  });
  return { MongoClient: mongoMocks.MongoClient };
});

import { CallStats, percentile, TurnMetrics, VoiceWorkerHeartbeat } from "./telemetry.js";

const CELL: VendorCell = { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" };

const WC = {
  livekitUrl: "wss://example.livekit.cloud",
  livekitApiKey: "k",
  livekitApiSecret: "s",
  sipTrunkId: "ST_x",
  inboundAgents: {},
  defaultStt: "deepgram/flux-general-en",
  defaultTts: "cartesia/sonic-3",
  deepgramApiKey: "dg",
  cartesiaApiKey: "c",
  elevenlabsApiKey: "e",
  bridgeToken: "t",
  bridgeUrl: "http://127.0.0.1:9/v1/chat/completions",
  mongoUri: "mongodb://localhost",
  mongoDbName: "hive",
} satisfies WorkerConfig;

const PII_KEYS = ["to", "from", "transcript", "text", "content", "textContent", "phone", "phoneNumber"];

function assertNoPii(obj: Record<string, unknown>): void {
  for (const key of PII_KEYS) {
    expect(obj, `logged object must not contain ${key}`).not.toHaveProperty(key);
  }
  expect(JSON.stringify(obj)).not.toMatch(/\+\d{10,}/);
}

function makeFakeCollection() {
  return {
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
  };
}

function makeFakeSession() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    on(event: string, cb: (payload: unknown) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(cb);
      listeners.set(event, arr);
      return this;
    },
    emit(event: string, payload: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
  };
}

function eouEvent(endOfUtteranceDelayMs: number): MetricsCollectedEvent {
  return {
    type: "metrics_collected",
    createdAt: Date.now(),
    metrics: {
      type: "eou_metrics",
      timestamp: Date.now(),
      endOfUtteranceDelayMs,
      transcriptionDelayMs: 0,
      onUserTurnCompletedDelayMs: 0,
      lastSpeakingTimeMs: 0,
    },
  };
}

function ttsEvent(ttfbMs: number): MetricsCollectedEvent {
  return {
    type: "metrics_collected",
    createdAt: Date.now(),
    metrics: {
      type: "tts_metrics",
      label: "tts",
      requestId: "r1",
      timestamp: Date.now(),
      ttfbMs,
      durationMs: 0,
      audioDurationMs: 0,
      cancelled: false,
      charactersCount: 0,
      streamed: true,
    },
  };
}

function llmEvent(ttftMs: number): MetricsCollectedEvent {
  return {
    type: "metrics_collected",
    createdAt: Date.now(),
    metrics: {
      type: "llm_metrics",
      label: "llm",
      requestId: "r1",
      timestamp: Date.now(),
      durationMs: 0,
      ttftMs,
      cancelled: false,
      completionTokens: 0,
      promptTokens: 0,
      promptCachedTokens: 0,
      totalTokens: 0,
      tokensPerSecond: 0,
    },
  };
}

function interruptionEvent(numInterruptions: number): MetricsCollectedEvent {
  return {
    type: "metrics_collected",
    createdAt: Date.now(),
    metrics: {
      type: "interruption_metrics",
      timestamp: Date.now(),
      totalDuration: 0,
      predictionDuration: 0,
      detectionDelay: 0,
      numInterruptions,
      numBackchannels: 0,
      numRequests: 1,
    },
  };
}

describe("VoiceWorkerHeartbeat (KPR-322 Task 8)", () => {
  const cellDefaults = { defaultStt: CELL.stt, defaultTts: CELL.tts };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writeOnce $sets cellDefaults/updatedAt only — not lastError or local counters", async () => {
    const coll = makeFakeCollection();
    const hb = new VoiceWorkerHeartbeat(coll as never, cellDefaults);
    hb.activeCalls = 2;
    hb.callsStarted = 5;
    hb.callsCompleted = 3;
    hb.lastError = "budget_saturated";
    await hb.writeOnce();

    expect(coll.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = coll.updateOne.mock.calls[0]!;
    expect(filter).toEqual({ kind: "voice_worker_stats" });
    expect(update.$set).not.toHaveProperty("activeCalls");
    expect(update.$set).not.toHaveProperty("callsStarted");
    expect(update.$set).not.toHaveProperty("callsCompleted");
    expect(update.$set).not.toHaveProperty("lastError");
    expect(update.$set.cellDefaults).toEqual(cellDefaults);
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    expect(update.$setOnInsert).toEqual({
      lastError: null,
      activeCalls: 0,
      callsStarted: 0,
      callsCompleted: 0,
    });
    expect(options).toEqual({ upsert: true });
    assertNoPii(update.$set as Record<string, unknown>);
    assertNoPii(update.$setOnInsert as Record<string, unknown>);
  });

  it("writeBoot $sets activeCalls 0 plus cellDefaults/updatedAt — not lastError or lifetime counters", async () => {
    const coll = makeFakeCollection();
    const hb = new VoiceWorkerHeartbeat(coll as never, cellDefaults);
    hb.activeCalls = 2;
    hb.callsStarted = 5;
    hb.callsCompleted = 3;
    hb.lastError = "budget_saturated";
    await hb.writeBoot();

    expect(hb.activeCalls).toBe(0);
    expect(hb.callsStarted).toBe(5);
    expect(hb.callsCompleted).toBe(3);
    expect(hb.lastError).toBe("budget_saturated");
    expect(coll.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = coll.updateOne.mock.calls[0]!;
    expect(filter).toEqual({ kind: "voice_worker_stats" });
    expect(update.$set.activeCalls).toBe(0);
    expect(update.$set.cellDefaults).toEqual(cellDefaults);
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    expect(update.$set).not.toHaveProperty("lastError");
    expect(update.$set).not.toHaveProperty("callsStarted");
    expect(update.$set).not.toHaveProperty("callsCompleted");
    expect(options).toEqual({ upsert: true });
    assertNoPii(update.$set as Record<string, unknown>);
    assertNoPii(update.$setOnInsert as Record<string, unknown>);
  });

  it("noteCallStarted $incs counters, updates in-memory, and does not include PII", async () => {
    const coll = makeFakeCollection();
    const hb = new VoiceWorkerHeartbeat(coll as never, cellDefaults);
    await hb.noteCallStarted();

    expect(hb.activeCalls).toBe(1);
    expect(hb.callsStarted).toBe(1);
    expect(coll.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = coll.updateOne.mock.calls[0]!;
    expect(filter).toEqual({ kind: "voice_worker_stats" });
    expect(update.$inc).toEqual({ activeCalls: 1, callsStarted: 1 });
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    expect(update.$set).not.toHaveProperty("activeCalls");
    expect(options).toEqual({ upsert: true });
    assertNoPii(update as Record<string, unknown>);
    assertNoPii(update.$inc as Record<string, unknown>);
    assertNoPii(update.$set as Record<string, unknown>);
  });

  it("noteCallEnded $incs completed and decrements activeCalls", async () => {
    const coll = makeFakeCollection();
    const hb = new VoiceWorkerHeartbeat(coll as never, cellDefaults);
    await hb.noteCallStarted();
    await hb.noteCallEnded();

    expect(hb.activeCalls).toBe(0);
    expect(hb.callsCompleted).toBe(1);
    const update = coll.updateOne.mock.calls[1]![1] as {
      $inc: Record<string, number>;
      $set: Record<string, unknown>;
    };
    expect(update.$inc).toEqual({ activeCalls: -1, callsCompleted: 1 });
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    assertNoPii(update.$inc);
    assertNoPii(update.$set);
  });

  it("noteError $sets lastError without PII", async () => {
    const coll = makeFakeCollection();
    const hb = new VoiceWorkerHeartbeat(coll as never, cellDefaults);
    await hb.noteError("budget_saturated");

    expect(hb.lastError).toBe("budget_saturated");
    const update = coll.updateOne.mock.calls[0]![1] as { $set: Record<string, unknown> };
    expect(update.$set.lastError).toBe("budget_saturated");
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    assertNoPii(update.$set);
  });

  it("write failure logs and does not throw", async () => {
    const coll = {
      updateOne: vi.fn().mockRejectedValue(new Error("mongo down")),
    };
    const hb = new VoiceWorkerHeartbeat(coll as never, cellDefaults);
    await expect(hb.writeOnce()).resolves.toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledWith("voice-worker heartbeat write failed", {
      error: "Error: mongo down",
    });
  });
});

describe("TurnMetrics (KPR-322 Task 8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits one JSONL line on eou_metrics with callId only — no to / number / text fields", () => {
    const hiveLLM = { lastTurnTiming: { llmTtftMs: 200, maxInterChunkGapMs: 15 } };
    const metrics = new TurnMetrics("call-abc", CELL, hiveLLM, "outbound");
    const session = makeFakeSession();
    metrics.attach(session as unknown as Pick<voice.AgentSession, "on">);

    session.emit(voice.AgentSessionEventTypes.MetricsCollected, ttsEvent(80));
    session.emit(voice.AgentSessionEventTypes.MetricsCollected, eouEvent(110));

    expect(mockLog.info).toHaveBeenCalledTimes(1);
    const [msg, logged] = mockLog.info.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("voice turn metrics");
    expect(logged.callId).toBe("call-abc");
    expect(logged.turnSeq).toBe(0);
    expect(logged.direction).toBe("outbound");
    expect(logged.cell).toBe("deepgram/flux-general-en+cartesia/sonic-3");
    expect(typeof logged.cell).toBe("string");
    expect(logged.eouDelayMs).toBe(110);
    expect(logged.llmTtftMs).toBe(200);
    expect(logged.maxInterChunkGapMs).toBe(15);
    expect(logged.ttsTtfbMs).toBe(80);
    expect(logged.totalToFirstAudioMs).toBe(110 + 200 + 80);
    expect(logged.interrupted).toBe(false);
    expect(logged.falseInterruption).toBe(false);
    assertNoPii(logged);
  });

  it("missing numbers stay -1 when TTS/LLM have not been seen", () => {
    const hiveLLM = { lastTurnTiming: null };
    const metrics = new TurnMetrics("call-xyz", CELL, hiveLLM, "inbound");
    const session = makeFakeSession();
    metrics.attach(session as unknown as Pick<voice.AgentSession, "on">);

    session.emit(voice.AgentSessionEventTypes.MetricsCollected, eouEvent(50));

    const logged = mockLog.info.mock.calls[0]![1] as Record<string, unknown>;
    expect(logged.eouDelayMs).toBe(50);
    expect(logged.llmTtftMs).toBe(-1);
    expect(logged.maxInterChunkGapMs).toBe(-1);
    expect(logged.ttsTtfbMs).toBe(-1);
    expect(logged.totalToFirstAudioMs).toBe(-1);
    expect(logged.direction).toBe("inbound");
    assertNoPii(logged);
  });

  it("falls back to last-seen llm_metrics.ttftMs when hiveLLM.lastTurnTiming is null", () => {
    const hiveLLM = { lastTurnTiming: null };
    const metrics = new TurnMetrics("call-fb", CELL, hiveLLM);
    const session = makeFakeSession();
    metrics.attach(session as unknown as Pick<voice.AgentSession, "on">);

    session.emit(voice.AgentSessionEventTypes.MetricsCollected, llmEvent(333));
    session.emit(voice.AgentSessionEventTypes.MetricsCollected, eouEvent(10));

    const logged = mockLog.info.mock.calls[0]![1] as Record<string, unknown>;
    expect(logged.llmTtftMs).toBe(333);
    assertNoPii(logged);
  });

  it("maps interruption_metrics counts and agent_false_interruption onto the next eou line", () => {
    const hiveLLM = { lastTurnTiming: { llmTtftMs: 1, maxInterChunkGapMs: 0 } };
    const metrics = new TurnMetrics("call-int", CELL, hiveLLM);
    const session = makeFakeSession();
    metrics.attach(session as unknown as Pick<voice.AgentSession, "on">);

    session.emit(voice.AgentSessionEventTypes.MetricsCollected, interruptionEvent(1));
    session.emit(voice.AgentSessionEventTypes.AgentFalseInterruption, {
      type: "agent_false_interruption",
      resumed: true,
      createdAt: Date.now(),
    });
    session.emit(voice.AgentSessionEventTypes.MetricsCollected, eouEvent(20));

    const logged = mockLog.info.mock.calls[0]![1] as Record<string, unknown>;
    expect(logged.interrupted).toBe(true);
    expect(logged.falseInterruption).toBe(true);
    assertNoPii(logged);

    session.emit(voice.AgentSessionEventTypes.MetricsCollected, eouEvent(20));
    const next = mockLog.info.mock.calls[1]![1] as Record<string, unknown>;
    expect(next.interrupted).toBe(false);
    expect(next.falseInterruption).toBe(false);
  });

  it("does not emit a turn line on tts/llm metrics alone", () => {
    const metrics = new TurnMetrics("call-none", CELL, { lastTurnTiming: null });
    const session = makeFakeSession();
    metrics.attach(session as unknown as Pick<voice.AgentSession, "on">);
    session.emit(voice.AgentSessionEventTypes.MetricsCollected, ttsEvent(9));
    session.emit(voice.AgentSessionEventTypes.MetricsCollected, llmEvent(9));
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it("invokes onTurn with the emitted line", () => {
    const onTurn = vi.fn();
    const hiveLLM = { lastTurnTiming: { llmTtftMs: 200, maxInterChunkGapMs: 15 } };
    const metrics = new TurnMetrics("call-abc", CELL, hiveLLM, "outbound", onTurn);
    const session = makeFakeSession();
    metrics.attach(session as unknown as Pick<voice.AgentSession, "on">);

    session.emit(voice.AgentSessionEventTypes.MetricsCollected, ttsEvent(80));
    session.emit(voice.AgentSessionEventTypes.MetricsCollected, eouEvent(110));

    expect(onTurn).toHaveBeenCalledTimes(1);
    const line = onTurn.mock.calls[0]![0] as Record<string, unknown>;
    expect(line.callId).toBe("call-abc");
    expect(line.turnSeq).toBe(0);
    expect(line.direction).toBe("outbound");
    expect(line.cell).toEqual(CELL);
    expect(line.eouDelayMs).toBe(110);
    expect(line.llmTtftMs).toBe(200);
    expect(line.ttsTtfbMs).toBe(80);
    expect(line.totalToFirstAudioMs).toBe(110 + 200 + 80);
    assertNoPii(line);
  });
});

describe("CallStats (KPR-322 Task 8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mongoMocks.insertOne.mockResolvedValue({ acknowledged: true });
    mongoMocks.connect.mockResolvedValue(undefined);
    mongoMocks.close.mockResolvedValue(undefined);
  });

  it("retryConsumed is true only on the second call per class", () => {
    const stats = new CallStats(WC, { callId: "call-1", agentId: "luna", cell: CELL, direction: "outbound" });
    expect(stats.retryConsumed("budget_saturated")).toBe(false);
    expect(stats.retryConsumed("budget_saturated")).toBe(true);
    expect(stats.retryConsumed("spawn_failed")).toBe(false);
    expect(stats.retryConsumed("spawn_failed")).toBe(true);
  });

  it("flush inserts voice_call_stats without to / phone / transcript fields", async () => {
    const stats = new CallStats(WC, { callId: "call-1", agentId: "luna", cell: CELL, direction: "outbound" });
    stats.recordTurnLatency(100);
    stats.recordTurnLatency(200);
    stats.recordInterruption();
    stats.retryConsumed("budget_saturated");
    await stats.flush("completed");

    expect(mongoMocks.MongoClient).toHaveBeenCalledWith("mongodb://localhost", { serverSelectionTimeoutMS: 2000 });
    expect(mongoMocks.insertOne).toHaveBeenCalledTimes(1);
    const doc = mongoMocks.insertOne.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc.kind).toBe("voice_call_stats");
    expect(doc.callId).toBe("call-1");
    expect(doc.agentId).toBe("luna");
    expect(doc.cell).toEqual(CELL);
    expect(doc.direction).toBe("outbound");
    expect(doc.turns).toBe(2);
    expect(doc.interruptions).toBe(1);
    expect(doc.retries).toBe(1);
    expect(doc.outcome).toBe("completed");
    expect(doc.latency).toEqual({ p50: percentile([100, 200], 50), p95: percentile([100, 200], 95) });
    expect(doc.createdAt).toBeInstanceOf(Date);
    assertNoPii(doc);
    expect(mongoMocks.close).toHaveBeenCalledTimes(1);
  });

  it("first-wins flush: failed is not overwritten by completed", async () => {
    const stats = new CallStats(WC, { callId: "call-1", agentId: "luna", cell: CELL, direction: "inbound" });
    stats.recordFailure("engine_unreachable");
    await stats.flush("failed");
    await stats.flush("completed");

    expect(mongoMocks.insertOne).toHaveBeenCalledTimes(1);
    const doc = mongoMocks.insertOne.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc.outcome).toBe("engine_unreachable");
  });

  it("flush write failure logs, does not throw, and still closes the client", async () => {
    mongoMocks.insertOne.mockRejectedValue(new Error("insert failed"));
    const stats = new CallStats(WC, { callId: "call-1", agentId: "luna", cell: CELL, direction: "outbound" });
    await expect(stats.flush("completed")).resolves.toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledWith("voice_call_stats flush failed", {
      callId: "call-1",
      error: "Error: insert failed",
    });
    expect(mongoMocks.close).toHaveBeenCalledTimes(1);
  });
});

describe("percentile (KPR-322 Task 8)", () => {
  it("computes nearest-rank percentiles on a known array", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // floor(0.50 * 10) = 5 → sorted[5] = 6; floor(0.95 * 10) = 9 → 10
    expect(percentile(samples, 50)).toBe(6);
    expect(percentile(samples, 95)).toBe(10);
    expect(percentile([], 50)).toBe(-1);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([10, 1, 5], 50)).toBe(5);
  });
});
