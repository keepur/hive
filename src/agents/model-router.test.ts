import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (KPR-312 harness, re-anchored by KPR-314) ────────────────────
// The classifier's transport is the LLM registry (KPR-314); tests mock the
// registry module instead of the Anthropic SDK. Behavior pins carried over
// from 312 unchanged: heuristics, fallback shapes, no-key mode, effort rules.
const { mockGenerateForTask, mockHasProvider, mockSupportsEffort, mockConfig } = vi.hoisted(() => ({
  mockGenerateForTask: vi.fn(),
  mockHasProvider: vi.fn(() => true),
  // Real-catalog shape: haiku effort-less, sonnet/opus effort-capable.
  mockSupportsEffort: vi.fn((model: string) => !model.includes("haiku")),
  mockConfig: {
    anthropic: { apiKey: "test-key" },
    modelRouter: { enabled: true, model: "claude-haiku-4-5-20251001", timeoutMs: 4000 },
  },
}));

vi.mock("../llm/registry.js", () => ({
  getLLMRegistry: () => ({
    generateForTask: mockGenerateForTask,
    hasProvider: mockHasProvider,
    supportsEffort: mockSupportsEffort,
  }),
}));

vi.mock("../config.js", () => ({ config: mockConfig }));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  routeModel,
  resolveResourceLimits,
  RESOURCE_TIER_DEFAULTS,
  __resetRouterStateForTests,
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

function makeLlmResult(
  parsed: { tier: string; effort: string } | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    text: parsed ? JSON.stringify(parsed) : "",
    ...(parsed ? { parsed } : {}),
    model: "claude-haiku-4-5-20251001",
    provider: "anthropic" as const,
    durationMs: 7,
    stopReason: "end_turn",
    usage: { inputTokens: 500, outputTokens: 10 },
    costUsd: 0.00055,
    ...overrides,
  };
}

describe("routeModel — classifier v2 (KPR-312, registry transport KPR-314)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasProvider.mockReturnValue(true);
    mockSupportsEffort.mockImplementation((model: string) => !model.includes("haiku"));
    __resetRouterStateForTests();
    mockGenerateForTask.mockResolvedValue(makeLlmResult({ tier: "sonnet", effort: "medium" }));
  });

  describe("heuristics (H1–H3) — 312 pins, transport-agnostic", () => {
    it("H1: haiku ceiling short-circuits — $0, method heuristic, no effort, no registry call", async () => {
      const r = await routeModel("do something elaborate", "claude-haiku-4-5-20251001");
      expect(r).toMatchObject({ tier: "haiku", costUsd: 0, durationMs: 0, method: "heuristic" });
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
      expect("effort" in r).toBe(false);
      expect(mockGenerateForTask).not.toHaveBeenCalled();
    });

    it.each(["thanks", "Thanks", "  ok  ", "THANK YOU", "👍", "got it", "will do"])(
      "H2: exact-match ack %j → haiku heuristic, no registry call",
      async (msg) => {
        const r = await routeModel(msg, "claude-opus-4-7");
        expect(r).toMatchObject({ tier: "haiku", costUsd: 0, method: "heuristic" });
        expect("effort" in r).toBe(false);
        expect(mockGenerateForTask).not.toHaveBeenCalled();
      },
    );

    it("H2 is exact-match only: 'fire the sales team' goes to the model", async () => {
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "opus", effort: "high" }));
      const r = await routeModel("fire the sales team", "claude-opus-4-7");
      expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ tier: "opus", method: "model" });
    });

    it("H2 is exact-match only: 'thanks, also rewrite the contract' goes to the model", async () => {
      await routeModel("thanks, also rewrite the contract", "claude-opus-4-7");
      expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
    });

    it("H3: empty text without files → haiku heuristic", async () => {
      const r = await routeModel("   ", "claude-opus-4-7", undefined, { hasFiles: false });
      expect(r).toMatchObject({ tier: "haiku", costUsd: 0, method: "heuristic" });
      expect(mockGenerateForTask).not.toHaveBeenCalled();
    });

    it("H3: empty text WITH files is not short-circuited — model path with placeholder input", async () => {
      await routeModel("", "claude-opus-4-7", undefined, { hasFiles: true });
      expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
      const req = mockGenerateForTask.mock.calls[0]![1];
      expect(req.prompt).toBe("(attachment-only message, no text)");
    });

    it("truncates classifier input above the bound; classification proceeds", async () => {
      const huge = "x".repeat(6000);
      const r = await routeModel(huge, "claude-opus-4-7");
      const prompt: string = mockGenerateForTask.mock.calls[0]![1].prompt;
      expect(prompt.length).toBe(4000 + "\n[...truncated]".length);
      expect(prompt.endsWith("[...truncated]")).toBe(true);
      expect(r.method).toBe("model");
    });
  });

  describe("model path (mocked registry)", () => {
    it("KPR-314 request shape: routerClassifier task, v2 prompt, schema, 100 tokens, config timeout", async () => {
      await routeModel("draft the quarterly summary", "claude-opus-4-7");
      const [task, req] = mockGenerateForTask.mock.calls[0]!;
      expect(task).toBe("routerClassifier");
      expect(req.maxOutputTokens).toBe(100);
      expect(req.timeoutMs).toBe(4000);
      expect(req.jsonSchema).toBeDefined();
      expect(req.systemPrompt).toContain("Effort");
      expect(req.systemPrompt).not.toContain("Respond with ONLY a JSON object");
      expect(req.systemPrompt).not.toContain("Scheduled/cron");
      expect("model" in req).toBe(false); // the registry owns model resolution
    });

    it("returns parsed tier + effort with registry-computed cost/duration passed through", async () => {
      mockGenerateForTask.mockResolvedValueOnce(
        makeLlmResult({ tier: "sonnet", effort: "medium" }, { costUsd: 0.00042, durationMs: 11 }),
      );
      const r = await routeModel("summarize this thread", "claude-opus-4-7");
      expect(r.tier).toBe("sonnet");
      expect(r.model).toBe("claude-sonnet-4-6");
      expect(r.effort).toBe("medium");
      expect(r.method).toBe("model");
      expect(r.costUsd).toBe(0.00042); // passthrough — the math itself is pinned in registry.test.ts
      expect(r.durationMs).toBe(11);
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
    });

    it("off-catalog cost degradation: registry costUsd undefined ⇒ 0 (routing unaffected)", async () => {
      mockGenerateForTask.mockResolvedValueOnce(
        makeLlmResult({ tier: "sonnet", effort: "low" }, { costUsd: undefined }),
      );
      const r = await routeModel("summarize", "claude-opus-4-7");
      expect(r.costUsd).toBe(0);
      expect(r.method).toBe("model");
    });

    it("ceiling cap (opus→sonnet) preserves effort", async () => {
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "opus", effort: "high" }));
      const r = await routeModel("complex judgment call", "claude-sonnet-4-6");
      expect(r.tier).toBe("sonnet");
      expect(r.effort).toBe("high");
      expect(r.method).toBe("model");
    });

    it("drops effort when the final model is effort-less per the CATALOG (haiku today)", async () => {
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "haiku", effort: "low" }));
      const r = await routeModel("quick status check please", "claude-opus-4-7");
      expect(r.tier).toBe("haiku");
      expect(r.method).toBe("model");
      expect("effort" in r).toBe(false);
      expect(mockSupportsEffort).toHaveBeenCalledWith("claude-haiku-4-5-20251001");
    });

    it("keeps effort when supportsEffort says yes — consulted on the POST-CAP model", async () => {
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "opus", effort: "high" }));
      const r = await routeModel("hard problem", "claude-sonnet-4-6");
      expect(mockSupportsEffort).toHaveBeenCalledWith("claude-sonnet-4-6");
      expect(r.effort).toBe("high");
    });

    it("effort-drop follows the catalog, not the tier name (next-model-generation proof)", async () => {
      mockSupportsEffort.mockReturnValue(true); // a future effort-capable haiku
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ tier: "haiku", effort: "low" }));
      const r = await routeModel("quick check", "claude-opus-4-7");
      expect(r.effort).toBe("low");
    });

    it.each([
      ["refusal stop", makeLlmResult(null, { stopReason: "refusal" })],
      ["null parsed", makeLlmResult(null)],
      ["max_tokens stop", makeLlmResult({ tier: "sonnet", effort: "low" }, { stopReason: "max_tokens" })],
    ])("%s → sonnet fallback, method fallback, no effort", async (_label, resp) => {
      mockGenerateForTask.mockResolvedValueOnce(resp);
      const r = await routeModel("classify me", "claude-opus-4-7");
      expect(r).toMatchObject({ tier: "sonnet", model: "claude-sonnet-4-6", costUsd: 0, method: "fallback" });
      expect("effort" in r).toBe(false);
    });

    it("thrown registry/API error (timeout/429/5xx/404) → sonnet fallback", async () => {
      mockGenerateForTask.mockRejectedValueOnce(new Error("408 request timed out"));
      const r = await routeModel("classify me", "claude-opus-4-7");
      expect(r).toMatchObject({ tier: "sonnet", costUsd: 0, durationMs: 0, method: "fallback" });
      expect(r.resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
    });
  });

  describe("no-key mode (truth condition: hasProvider)", () => {
    beforeEach(() => {
      mockHasProvider.mockReturnValue(false);
      __resetRouterStateForTests();
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
      expect(mockGenerateForTask).not.toHaveBeenCalled();
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
