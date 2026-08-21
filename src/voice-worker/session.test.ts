import { describe, expect, it, vi, beforeEach } from "vitest";
import type { VendorCell } from "./cells.js";
import { resolveFailureAction, type BridgeFailureClass } from "./error-map.js";
import type { WorkerConfig } from "./worker-config.js";

const { mongoMocks } = vi.hoisted(() => ({
  mongoMocks: {
    insertOne: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    db: vi.fn(),
    collection: vi.fn(),
    MongoClient: vi.fn(),
  },
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

import { recordSetupFailure, resolveInboundAgent, runJobShutdown } from "./session.js";
import { CallStats, VoiceWorkerHeartbeat } from "./telemetry.js";

const INBOUND_COPY = {
  goal: "Answer this inbound vendor callback professionally and help the caller.",
  context: "Inbound call to the DodiHome ops line (vendor callback).",
} as const;

describe("resolveInboundAgent (KPR-322)", () => {
  const inboundAgents = { "+15551234567": "nora", "+15557654321": "luna" };

  it("maps a known called-number to agentId plus generic vendor-callback goal/context", () => {
    expect(resolveInboundAgent("+15551234567", inboundAgents)).toEqual({
      agentId: "nora",
      ...INBOUND_COPY,
    });
    expect(resolveInboundAgent("+15557654321", inboundAgents)).toEqual({
      agentId: "luna",
      ...INBOUND_COPY,
    });
  });

  it("returns null for an unmapped number", () => {
    expect(resolveInboundAgent("+19990000000", inboundAgents)).toBeNull();
  });

  it("returns null when the called-number is undefined or empty", () => {
    expect(resolveInboundAgent(undefined, inboundAgents)).toBeNull();
    expect(resolveInboundAgent("", inboundAgents)).toBeNull();
  });
});

describe("resolveFailureAction session-layer truth table (KPR-322 §8)", () => {
  const cases: Array<{
    cls: BridgeFailureClass;
    consumed: boolean;
    expected: ReturnType<typeof resolveFailureAction>;
  }> = [
    {
      cls: "budget_saturated",
      consumed: false,
      expected: { kind: "retry", sayFirst: "hold_on", delayMs: 2000 },
    },
    { cls: "budget_saturated", consumed: true, expected: { kind: "end", say: "apologize_end" } },
    { cls: "spawn_failed", consumed: false, expected: { kind: "retry", sayFirst: null, delayMs: 0 } },
    { cls: "spawn_failed", consumed: true, expected: { kind: "end", say: "apologize_end" } },
    { cls: "engine_auth", consumed: false, expected: { kind: "end", say: "apologize_end" } },
    { cls: "engine_auth", consumed: true, expected: { kind: "end", say: "apologize_end" } },
    { cls: "bridge_auth", consumed: false, expected: { kind: "end", say: "apologize_end" } },
    { cls: "bridge_auth", consumed: true, expected: { kind: "end", say: "apologize_end" } },
    { cls: "engine_unreachable", consumed: false, expected: { kind: "end", say: "canned_engine_down" } },
    { cls: "engine_unreachable", consumed: true, expected: { kind: "end", say: "canned_engine_down" } },
    { cls: "midstream_error", consumed: false, expected: { kind: "continue" } },
    { cls: "midstream_error", consumed: true, expected: { kind: "continue" } },
  ];

  it("covers every BridgeFailureClass × {retry-available, retry-consumed}", () => {
    for (const { cls, consumed, expected } of cases) {
      expect(resolveFailureAction(cls, consumed), `${cls} consumed=${consumed}`).toEqual(expected);
    }
  });

  it("yields at most one spoken line per terminal outcome", () => {
    for (const { cls, consumed } of cases) {
      const action = resolveFailureAction(cls, consumed);
      if (action.kind === "end") {
        expect(["apologize_end", "canned_engine_down"]).toContain(action.say);
      }
      if (action.kind === "retry") {
        expect(action.sayFirst === "hold_on" || action.sayFirst === null).toBe(true);
      }
    }
  });
});

describe("CallStats.retryConsumed (KPR-322 Task 7 stand-in)", () => {
  const cell: VendorCell = { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" };
  const wc = {
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

  it("returns false on the first call per class and true on the second", () => {
    const stats = new CallStats(wc, { callId: "call-1", agentId: "luna", cell, direction: "outbound" });
    expect(stats.retryConsumed("budget_saturated")).toBe(false);
    expect(stats.retryConsumed("budget_saturated")).toBe(true);
    expect(stats.retryConsumed("spawn_failed")).toBe(false);
    expect(stats.retryConsumed("spawn_failed")).toBe(true);
  });
});

describe("recordSetupFailure (KPR-322 setup telemetry)", () => {
  const cell: VendorCell = { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" };
  const wc = {
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

  beforeEach(() => {
    vi.clearAllMocks();
    mongoMocks.insertOne.mockResolvedValue({ acknowledged: true });
    mongoMocks.connect.mockResolvedValue(undefined);
    mongoMocks.close.mockResolvedValue(undefined);
  });

  it("first-wins: subsequent flush(completed) keeps outcome setup_failed", async () => {
    const stats = new CallStats(wc, { callId: "call-1", agentId: "luna", cell, direction: "outbound" });
    const coll = { updateOne: vi.fn().mockResolvedValue({ acknowledged: true }) };
    const heartbeat = new VoiceWorkerHeartbeat(coll as never, {
      defaultStt: wc.defaultStt,
      defaultTts: wc.defaultTts,
    });

    await recordSetupFailure(stats, heartbeat);
    await stats.flush("completed");

    expect(mongoMocks.insertOne).toHaveBeenCalledTimes(1);
    const doc = mongoMocks.insertOne.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc.outcome).toBe("setup_failed");
    expect(doc).not.toHaveProperty("to");
    expect(doc).not.toHaveProperty("phone");

    expect(coll.updateOne).toHaveBeenCalledTimes(1);
    const update = coll.updateOne.mock.calls[0]![1] as { $set: Record<string, unknown> };
    expect(update.$set.lastError).toBe("setup_failed");
  });
});

describe("runJobShutdown (KPR-322 call-end heartbeat)", () => {
  it("invokes closeMongo only after releaseCall resolves, even if close is faster", async () => {
    const order: string[] = [];
    let finishRelease!: () => void;
    const releaseCall = () =>
      new Promise<void>((resolve) => {
        order.push("release-started");
        finishRelease = () => {
          order.push("release-finished");
          resolve();
        };
      });
    const flush = async () => {
      order.push("flush");
    };
    const closeMongo = () => {
      order.push("close");
      return Promise.resolve();
    };

    const running = runJobShutdown({ releaseCall, flush, closeMongo });
    await Promise.resolve();
    expect(order).toEqual(["release-started"]);
    finishRelease();
    await running;
    expect(order).toEqual(["release-started", "release-finished", "flush", "close"]);
  });
});
