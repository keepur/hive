import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VendorCell } from "./cells.js";
import type { CallDiagnosticCounts } from "./speech-trace.js";
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

import { CallStats, percentile, VoiceWorkerHeartbeat } from "./telemetry.js";

const CELL: VendorCell = { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" };

const WC = {
  livekitUrl: "wss://example.livekit.cloud",
  livekitApiKey: "k",
  livekitApiSecret: "s",
  sipTrunkId: "ST_x",
  inboundAgents: {},
  agentVoices: {},
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

function diagnostics(overrides: Partial<CallDiagnosticCounts> = {}): CallDiagnosticCounts {
  const outcomes = { completed: 0, interrupted: 0, cancelled: 0, failed: 0, incomplete: 0 };
  return {
    speechAttempts: 0,
    speechOutcomes: { ...outcomes },
    bridgeAttempts: 0,
    bridgeOutcomes: { ...outcomes },
    synthesisAttempts: 0,
    synthesisOutcomes: { ...outcomes },
    generatedAudioObserved: 0,
    knownPlayoutObserved: 0,
    sdkInterruptions: 0,
    cancelledSpeechAttempts: 0,
    incomplete: 0,
    unbound: 0,
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
    ...overrides,
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

  it("flush inserts bounded schema-v2 denominators and explicitly labeled latency estimates", async () => {
    const stats = new CallStats(WC, { callId: "call-1", agentId: "luna", cell: CELL, direction: "outbound" });
    stats.retryConsumed("budget_saturated");
    const snapshot = diagnostics({
      speechAttempts: 5,
      speechOutcomes: { completed: 2, interrupted: 1, cancelled: 1, failed: 0, incomplete: 1 },
      bridgeAttempts: 4,
      bridgeOutcomes: { completed: 3, interrupted: 0, cancelled: 1, failed: 0, incomplete: 0 },
      synthesisAttempts: 3,
      synthesisOutcomes: { completed: 2, interrupted: 0, cancelled: 0, failed: 1, incomplete: 0 },
      generatedAudioObserved: 2,
      knownPlayoutObserved: 1,
      sdkInterruptions: 2,
      cancelledSpeechAttempts: 1,
      incomplete: 1,
      unbound: 2,
      diagnosticGaps: 3,
      latencyEstimateSamples: [100, 200],
      eligibleLatencyEstimateCount: 2,
      excludedByReason: {
        ...diagnostics().excludedByReason,
        cancelled: 1,
        incomplete: 1,
        ambiguous_components: 1,
      },
      logging: { ...diagnostics().logging, failed: 1, overflow: 2, complete: false },
    });
    await expect(stats.flush("completed", snapshot)).resolves.toEqual({ persisted: true, closeFailed: false });

    expect(mongoMocks.MongoClient).toHaveBeenCalledWith("mongodb://localhost", { serverSelectionTimeoutMS: 2000 });
    expect(mongoMocks.insertOne).toHaveBeenCalledTimes(1);
    const doc = mongoMocks.insertOne.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc.kind).toBe("voice_call_stats");
    expect(doc.callId).toBe("call-1");
    expect(doc.agentId).toBe("luna");
    expect(doc.cell).toEqual(CELL);
    expect(doc.direction).toBe("outbound");
    expect(doc.schemaVersion).toBe(2);
    expect(doc.speechAttempts).toBe(5);
    expect(doc.speechOutcomes).toEqual(snapshot.speechOutcomes);
    expect(doc.bridgeAttempts).toBe(4);
    expect(doc.synthesisAttempts).toBe(3);
    expect(doc.generatedAudioObserved).toBe(2);
    expect(doc.knownPlayoutObserved).toBe(1);
    expect(doc.incomplete).toBe(1);
    expect(doc.unbound).toBe(2);
    expect(doc.diagnosticGaps).toBe(3);
    expect(doc.loggingFailures).toBe(3);
    expect(doc.turns).toBe(2);
    expect(doc.interruptions).toBe(2);
    expect(doc.cancelled).toBe(1);
    expect(doc.retries).toBe(1);
    expect(doc.outcome).toBe("completed");
    expect(doc.latencyEstimateSamples).toEqual([100, 200]);
    expect(doc.excludedByReason).toEqual(snapshot.excludedByReason);
    expect(doc.latency).toEqual({
      kind: "estimated_eou_to_first_generated_audio",
      sampled: true,
      eligibleSampleCount: 2,
      retainedSampleCount: 2,
      truncated: false,
      p50: percentile([100, 200], 50),
      p95: percentile([100, 200], 95),
    });
    expect(doc.createdAt).toBeInstanceOf(Date);
    assertNoPii(doc);
    expect(mongoMocks.close).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith("summary_persistence", {
      callId: "call-1",
      status: "acknowledged",
    });
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

  it("concurrent flushes share one insert and retain the first terminal outcome", async () => {
    let acknowledge!: (value: { acknowledged: boolean }) => void;
    mongoMocks.insertOne.mockImplementation(
      () => new Promise<{ acknowledged: boolean }>((resolve) => (acknowledge = resolve)),
    );
    const stats = new CallStats(WC, { callId: "call-concurrent", agentId: "luna", cell: CELL, direction: "outbound" });
    const first = stats.flush("failed", diagnostics({ speechAttempts: 1 }));
    const second = stats.flush("completed", diagnostics({ speechAttempts: 99 }));
    expect(first).toBe(second);
    await vi.waitFor(() => expect(mongoMocks.insertOne).toHaveBeenCalledTimes(1));
    acknowledge({ acknowledged: true });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { persisted: true, closeFailed: false },
      { persisted: true, closeFailed: false },
    ]);
    const doc = mongoMocks.insertOne.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc.outcome).toBe("failed");
    expect(doc.speechAttempts).toBe(1);
  });

  it("insert failure is never marked persisted and still closes the client", async () => {
    mongoMocks.insertOne.mockRejectedValue(new Error("insert failed"));
    const stats = new CallStats(WC, { callId: "call-1", agentId: "luna", cell: CELL, direction: "outbound" });
    await expect(stats.flush("completed")).resolves.toEqual({ persisted: false, closeFailed: false });
    expect(mockLog.warn).toHaveBeenCalledWith("summary_persistence", {
      callId: "call-1",
      status: "failed",
      reason: "insert_failed",
    });
    expect(mockLog.info).not.toHaveBeenCalledWith("summary_persistence", expect.anything());
    expect(mongoMocks.close).toHaveBeenCalledTimes(1);
  });

  it("connect failure reports bounded failure without attempting an insert", async () => {
    mongoMocks.connect.mockRejectedValue(new Error("secret-bearing connection error"));
    const stats = new CallStats(WC, { callId: "call-connect", agentId: "luna", cell: CELL, direction: "outbound" });
    await expect(stats.flush("completed")).resolves.toEqual({ persisted: false, closeFailed: false });
    expect(mongoMocks.insertOne).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith("summary_persistence", {
      callId: "call-connect",
      status: "failed",
      reason: "connect_failed",
    });
  });

  it("keeps acknowledged persistence truthful when client close fails", async () => {
    mongoMocks.close.mockRejectedValue(new Error("close failed"));
    const observe = vi.fn();
    const stats = new CallStats(
      WC,
      { callId: "call-close", agentId: "luna", cell: CELL, direction: "outbound" },
      observe,
    );
    await expect(stats.flush("completed")).resolves.toEqual({ persisted: true, closeFailed: true });
    expect(observe.mock.calls).toEqual([["acknowledged"], ["failed", "close_failed"]]);
    expect(mockLog.info).toHaveBeenCalledWith("summary_persistence", {
      callId: "call-close",
      status: "acknowledged",
    });
    expect(mockLog.warn).toHaveBeenCalledWith("voice_call_stats close failed", { callId: "call-close" });
  });

  it("keeps acknowledged persistence truthful when reporting callbacks throw", async () => {
    mockLog.info.mockImplementationOnce(() => {
      throw new Error("logger failed");
    });
    const stats = new CallStats(
      WC,
      { callId: "call-reporting", agentId: "luna", cell: CELL, direction: "outbound" },
      () => {
        throw new Error("observer failed");
      },
    );
    await expect(stats.flush("completed")).resolves.toEqual({ persisted: true, closeFailed: false });
    expect(mongoMocks.insertOne).toHaveBeenCalledTimes(1);
  });

  it("caps persisted latency samples at 1,024 and marks overflow as truncated", async () => {
    const samples = Array.from({ length: 1_100 }, (_, i) => i);
    const stats = new CallStats(WC, { callId: "call-samples", agentId: "luna", cell: CELL, direction: "outbound" });
    await stats.flush(
      "completed",
      diagnostics({ latencyEstimateSamples: samples, eligibleLatencyEstimateCount: samples.length }),
    );
    const doc = mongoMocks.insertOne.mock.calls[0]![0] as {
      latencyEstimateSamples: number[];
      latency: { eligibleSampleCount: number; retainedSampleCount: number; truncated: boolean };
    };
    expect(doc.latencyEstimateSamples).toHaveLength(1_024);
    expect(doc.latency).toMatchObject({
      eligibleSampleCount: 1_100,
      retainedSampleCount: 1_024,
      truncated: true,
    });
  });
});

describe("percentile (KPR-322 Task 8)", () => {
  it("computes nearest-rank percentiles on a known array", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // nearest rank: ceil(0.50 * 10) - 1 = 4 → sorted[4] = 5
    expect(percentile(samples, 50)).toBe(5);
    expect(percentile(samples, 95)).toBe(10);
    expect(percentile([], 50)).toBe(-1);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([10, 1, 5], 50)).toBe(5);
  });
});
