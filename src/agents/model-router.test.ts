import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (KPR-312) ────────────────────────────────────────────────────
// The Anthropic client is a module-level lazy singleton in model-router.ts;
// tests mock the SDK's default-export class (mirrors agent-runner.test.ts's
// module mock of the agent SDK) and reset the singleton via the exported
// __resetRouterClientForTests() seam so construction is order-independent.
const { mockParse, mockAnthropicCtor, mockConfig } = vi.hoisted(() => ({
  mockParse: vi.fn(),
  mockAnthropicCtor: vi.fn(),
  mockConfig: {
    anthropic: { apiKey: "test-key" },
    modelRouter: { enabled: true, model: "claude-haiku-4-5-20251001", timeoutMs: 4000 },
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { parse: mockParse };
    constructor(opts: unknown) {
      mockAnthropicCtor(opts);
    }
  },
}));
// NOTE: "@anthropic-ai/sdk/helpers/json-schema" is deliberately NOT mocked —
// jsonSchemaOutputFormat is a pure function; the real helper runs at module load.

vi.mock("../config.js", () => ({ config: mockConfig }));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  routeModel,
  resolveResourceLimits,
  RESOURCE_TIER_DEFAULTS,
  __resetRouterClientForTests,
  type ModelRouterResult,
} from "./model-router.js";

describe("resolveResourceLimits", () => {
  it("returns global defaults when no agent overrides", () => {
    const limits = resolveResourceLimits("haiku");
    expect(limits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
  });

  it("returns global defaults when agent overrides is undefined", () => {
    const limits = resolveResourceLimits("sonnet", undefined);
    expect(limits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
  });

  it("returns global defaults when agent has no override for the tier", () => {
    const limits = resolveResourceLimits("haiku", { opus: { timeoutMs: 900_000 } });
    expect(limits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
  });

  it("merges partial agent overrides with global defaults", () => {
    const limits = resolveResourceLimits("opus", {
      opus: { timeoutMs: 900_000 },
    });
    expect(limits).toEqual({
      timeoutMs: 900_000,
      maxTurns: RESOURCE_TIER_DEFAULTS.opus.maxTurns,
      budgetUsd: RESOURCE_TIER_DEFAULTS.opus.budgetUsd,
    });
  });

  it("fully overrides all fields when all specified", () => {
    const limits = resolveResourceLimits("sonnet", {
      sonnet: { timeoutMs: 60_000, maxTurns: 10, budgetUsd: 0.5 },
    });
    expect(limits).toEqual({ timeoutMs: 60_000, maxTurns: 10, budgetUsd: 0.5 });
  });

  it("returns a copy, not a reference to defaults", () => {
    const limits = resolveResourceLimits("haiku");
    limits.timeoutMs = 999;
    expect(RESOURCE_TIER_DEFAULTS.haiku.timeoutMs).toBe(120_000);
  });
});

function makeParseResponse(
  parsed: { tier: string; effort: string } | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    stop_reason: "end_turn",
    parsed_output: parsed,
    usage: { input_tokens: 500, output_tokens: 10 },
    ...overrides,
  };
}

describe("routeModel — classifier v2 (KPR-312)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.anthropic.apiKey = "test-key";
    __resetRouterClientForTests();
    mockParse.mockResolvedValue(makeParseResponse({ tier: "sonnet", effort: "medium" }));
  });

  describe("heuristics (H1–H3)", () => {
    it("H1: haiku ceiling short-circuits — $0, method heuristic, no effort, no API call", async () => {
      const r = await routeModel("do something elaborate", "claude-haiku-4-5-20251001");
      expect(r).toMatchObject({ tier: "haiku", costUsd: 0, durationMs: 0, method: "heuristic" });
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
      expect("effort" in r).toBe(false);
      expect(mockParse).not.toHaveBeenCalled();
      expect(mockAnthropicCtor).not.toHaveBeenCalled();
    });

    it.each(["thanks", "Thanks", "  ok  ", "THANK YOU", "👍", "got it", "will do"])(
      "H2: exact-match ack %j → haiku heuristic, no API call",
      async (msg) => {
        const r = await routeModel(msg, "claude-opus-4-7");
        expect(r).toMatchObject({ tier: "haiku", costUsd: 0, method: "heuristic" });
        expect("effort" in r).toBe(false);
        expect(mockParse).not.toHaveBeenCalled();
      },
    );

    it("H2 is exact-match only: 'fire the sales team' goes to the model", async () => {
      mockParse.mockResolvedValueOnce(makeParseResponse({ tier: "opus", effort: "high" }));
      const r = await routeModel("fire the sales team", "claude-opus-4-7");
      expect(mockParse).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ tier: "opus", method: "model" });
    });

    it("H2 is exact-match only: 'thanks, also rewrite the contract' goes to the model", async () => {
      await routeModel("thanks, also rewrite the contract", "claude-opus-4-7");
      expect(mockParse).toHaveBeenCalledTimes(1);
    });

    it("H3: empty text without files → haiku heuristic", async () => {
      const r = await routeModel("   ", "claude-opus-4-7", undefined, { hasFiles: false });
      expect(r).toMatchObject({ tier: "haiku", costUsd: 0, method: "heuristic" });
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("H3: empty text WITH files is not short-circuited — model path with placeholder input", async () => {
      await routeModel("", "claude-opus-4-7", undefined, { hasFiles: true });
      expect(mockParse).toHaveBeenCalledTimes(1);
      const req = mockParse.mock.calls[0]![0];
      expect(req.messages[0].content).toBe("(attachment-only message, no text)");
    });

    it("truncates classifier input above the bound; classification proceeds", async () => {
      const huge = "x".repeat(6000);
      const r = await routeModel(huge, "claude-opus-4-7");
      const content: string = mockParse.mock.calls[0]![0].messages[0].content;
      expect(content.length).toBe(4000 + "\n[...truncated]".length);
      expect(content.endsWith("[...truncated]")).toBe(true);
      expect(r.method).toBe("model");
    });
  });

  describe("model path (mocked Anthropic client)", () => {
    it("constructs the client once with apiKey/timeout/maxRetries:0 and reuses it", async () => {
      await routeModel("draft the quarterly summary", "claude-opus-4-7");
      await routeModel("draft another quarterly summary", "claude-opus-4-7");
      expect(mockAnthropicCtor).toHaveBeenCalledTimes(1);
      expect(mockAnthropicCtor).toHaveBeenCalledWith({
        apiKey: "test-key",
        timeout: 4000,
        maxRetries: 0,
      });
      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("returns parsed tier + effort with usage-derived cost and tier limits", async () => {
      mockParse.mockResolvedValueOnce(makeParseResponse({ tier: "sonnet", effort: "medium" }));
      const r = await routeModel("summarize this thread", "claude-opus-4-7");
      expect(r.tier).toBe("sonnet");
      expect(r.model).toBe("claude-sonnet-4-6");
      expect(r.effort).toBe("medium");
      expect(r.method).toBe("model");
      // (500 in × $1 + 10 out × $5) / 1M
      expect(r.costUsd).toBeCloseTo(0.00055, 8);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
      // Request shape pin: structured outputs, v2 prompt, no thinking key.
      const req = mockParse.mock.calls[0]![0];
      expect(req.model).toBe("claude-haiku-4-5-20251001");
      expect(req.max_tokens).toBe(100);
      expect(req.output_config?.format).toBeDefined();
      expect("thinking" in req).toBe(false);
      expect(req.system).toContain("Effort");
      expect(req.system).not.toContain("Respond with ONLY a JSON object");
      expect(req.system).not.toContain("Scheduled/cron");
    });

    it("ceiling cap (opus→sonnet) preserves effort", async () => {
      mockParse.mockResolvedValueOnce(makeParseResponse({ tier: "opus", effort: "high" }));
      const r = await routeModel("complex judgment call", "claude-sonnet-4-6");
      expect(r.tier).toBe("sonnet");
      expect(r.effort).toBe("high");
      expect(r.method).toBe("model");
    });

    it("drops effort when the final tier is haiku (haiku rejects the param)", async () => {
      mockParse.mockResolvedValueOnce(makeParseResponse({ tier: "haiku", effort: "low" }));
      const r = await routeModel("quick status check please", "claude-opus-4-7");
      expect(r.tier).toBe("haiku");
      expect(r.method).toBe("model");
      expect("effort" in r).toBe(false);
    });

    it.each([
      ["refusal stop", makeParseResponse(null, { stop_reason: "refusal" })],
      ["null parsed_output", makeParseResponse(null)],
      ["max_tokens stop", makeParseResponse({ tier: "sonnet", effort: "low" }, { stop_reason: "max_tokens" })],
    ])("%s → sonnet fallback, method fallback, no effort", async (_label, resp) => {
      mockParse.mockResolvedValueOnce(resp);
      const r = await routeModel("classify me", "claude-opus-4-7");
      expect(r).toMatchObject({ tier: "sonnet", model: "claude-sonnet-4-6", costUsd: 0, method: "fallback" });
      expect("effort" in r).toBe(false);
    });

    it("thrown API error (timeout/429/5xx/404) → sonnet fallback", async () => {
      mockParse.mockRejectedValueOnce(new Error("408 request timed out"));
      const r = await routeModel("classify me", "claude-opus-4-7");
      expect(r).toMatchObject({ tier: "sonnet", costUsd: 0, durationMs: 0, method: "fallback" });
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
    });
  });

  describe("no-key mode", () => {
    beforeEach(() => {
      mockConfig.anthropic.apiKey = "";
      __resetRouterClientForTests();
    });

    it("heuristic-missing turns keep the agent default model with resolved default-tier limits", async () => {
      const r = await routeModel("summarize the quarter", "claude-opus-4-7");
      expect(r).toEqual({
        tier: "opus",
        model: "claude-opus-4-7",
        costUsd: 0,
        durationMs: 0,
        resourceLimits: RESOURCE_TIER_DEFAULTS.opus,
        method: "no-key",
      } satisfies ModelRouterResult);
      expect(mockAnthropicCtor).not.toHaveBeenCalled();
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("resolves default-tier limits through per-agent overrides", async () => {
      const r = await routeModel("draft an email", "claude-sonnet-4-6", {
        sonnet: { timeoutMs: 99_000 },
      });
      expect(r.method).toBe("no-key");
      expect(r.resourceLimits).toEqual({ ...RESOURCE_TIER_DEFAULTS.sonnet, timeoutMs: 99_000 });
    });

    it("heuristics still fire in no-key mode", async () => {
      const r = await routeModel("thanks", "claude-opus-4-7");
      expect(r.method).toBe("heuristic");
      expect(r.tier).toBe("haiku");
    });
  });
});
