import { describe, expect, it } from "vitest";
import type { VendorCell } from "./cells.js";
import { resolveFailureAction, type BridgeFailureClass } from "./error-map.js";
import { resolveInboundAgent } from "./session.js";
import { CallStats } from "./telemetry.js";
import type { WorkerConfig } from "./worker-config.js";

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
