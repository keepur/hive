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
  parsed: { effort: string } | null,
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

describe("routeModel — effort-only classifier (KPR-338, registry transport KPR-314)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasProvider.mockReturnValue(true);
    mockSupportsEffort.mockImplementation((model: string) => !model.includes("haiku"));
    __resetRouterStateForTests();
    mockGenerateForTask.mockResolvedValue(makeLlmResult({ effort: "medium" }));
  });

  // KPR-338 §3.1: H1 deleted — superseded by prepareSpawn's haiku-skip (pinned in agent-manager.test.ts)

  describe("heuristics (H2–H3) — 312 pins, transport-agnostic", () => {
    it("H2: exact-match ack → {effort: low, method: heuristic}, no tier/model/limits keys, no registry call", async () => {
      const r = await routeModel("thanks");
      expect(r).toEqual({ costUsd: 0, durationMs: 0, effort: "low", method: "heuristic" });
      expect("tier" in r).toBe(false);
      expect("model" in r).toBe(false);
      expect("resourceLimits" in r).toBe(false);
      expect("provider" in r).toBe(false);
      expect(mockGenerateForTask).not.toHaveBeenCalled();
    });

    it.each(["thanks", "Thanks", "  ok  ", "THANK YOU", "👍", "got it", "will do"])(
      "H2: exact-match ack %j → effort:low heuristic, no registry call",
      async (msg) => {
        const r = await routeModel(msg);
        expect(r).toEqual({ costUsd: 0, durationMs: 0, effort: "low", method: "heuristic" });
        expect(mockGenerateForTask).not.toHaveBeenCalled();
      },
    );

    it("H2 is exact-match only: 'fire the sales team' goes to the model", async () => {
      mockGenerateForTask.mockResolvedValueOnce(makeLlmResult({ effort: "high" }));
      const r = await routeModel("fire the sales team");
      expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ effort: "high", method: "model" });
    });

    it("H2 is exact-match only: 'thanks, also rewrite the contract' goes to the model", async () => {
      await routeModel("thanks, also rewrite the contract");
      expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
    });

    it("H3: empty text without files → {effort: low, method: heuristic}", async () => {
      const r = await routeModel("   ", { hasFiles: false });
      expect(r).toEqual({ costUsd: 0, durationMs: 0, effort: "low", method: "heuristic" });
      expect(mockGenerateForTask).not.toHaveBeenCalled();
    });

    it("H3: empty text WITH files is not short-circuited — model path with placeholder input", async () => {
      await routeModel("", { hasFiles: true });
      expect(mockGenerateForTask).toHaveBeenCalledTimes(1);
      const req = mockGenerateForTask.mock.calls[0]![1];
      expect(req.prompt).toBe("(attachment-only message, no text)");
    });

    it("truncates classifier input above the bound; classification proceeds", async () => {
      const huge = "x".repeat(6000);
      const r = await routeModel(huge);
      const prompt: string = mockGenerateForTask.mock.calls[0]![1].prompt;
      expect(prompt.length).toBe(4000 + "\n[...truncated]".length);
      expect(prompt.endsWith("[...truncated]")).toBe(true);
      expect(r.method).toBe("model");
    });
  });

  describe("model path (mocked registry)", () => {
    it("KPR-314 request shape: routerClassifier task, v3 prompt, schema, 100 tokens, config timeout, no model key", async () => {
      await routeModel("draft the quarterly summary");
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

    it("schema pin: effort is the only required field; tier is gone from the output schema", async () => {
      await routeModel("draft the quarterly summary");
      const req = mockGenerateForTask.mock.calls[0]![1];
      expect(req.jsonSchema.required).toEqual(["effort"]);
      expect("tier" in req.jsonSchema.properties).toBe(false);
    });

    it("prompt pin: effort rubric only — no tier rubric survives", async () => {
      await routeModel("draft the quarterly summary");
      const sys: string = mockGenerateForTask.mock.calls[0]![1].systemPrompt;
      expect(sys).toContain("Effort");
      for (const gone of ["Tiers:", "haiku", "sonnet", "opus"]) expect(sys).not.toContain(gone);
    });

    it("returns {effort, method: model} with registry cost/duration passed through — no tier/model/limits/provider keys", async () => {
      mockGenerateForTask.mockResolvedValueOnce(
        makeLlmResult({ effort: "medium" }, { costUsd: 0.00042, durationMs: 11 }),
      );
      const r = await routeModel("summarize this thread");
      expect(r).toEqual({ costUsd: 0.00042, durationMs: 11, effort: "medium", method: "model" });
      expect("tier" in r).toBe(false);
      expect("model" in r).toBe(false);
      expect("resourceLimits" in r).toBe(false);
      expect("provider" in r).toBe(false);
    });

    it("off-catalog cost degradation: registry costUsd undefined ⇒ 0 (routing unaffected)", async () => {
      mockGenerateForTask.mockResolvedValueOnce(
        makeLlmResult({ effort: "low" }, { costUsd: undefined }),
      );
      const r = await routeModel("summarize");
      expect(r.costUsd).toBe(0);
      expect(r.effort).toBe("low");
      expect(r.method).toBe("model");
    });

    it("supportsEffort is not consulted — the deliverability gate moved to prepareSpawn (KPR-338)", async () => {
      await routeModel("summarize this thread");
      expect(mockSupportsEffort).not.toHaveBeenCalled();
    });

    it.each([
      ["refusal stop", makeLlmResult(null, { stopReason: "refusal" })],
      ["null parsed", makeLlmResult(null)],
      ["max_tokens stop", makeLlmResult({ effort: "low" }, { stopReason: "max_tokens" })],
      ["invalid effort (D5)", makeLlmResult({ effort: "extreme" })],
    ])("%s → fallback, method fallback, no effort", async (_label, resp) => {
      mockGenerateForTask.mockResolvedValueOnce(resp);
      const r = await routeModel("classify me");
      expect(r).toEqual({ costUsd: 0, durationMs: 0, method: "fallback" });
      expect("effort" in r).toBe(false);
    });

    it("thrown registry/API error (timeout/429/5xx/404) → fallback, no effort", async () => {
      mockGenerateForTask.mockRejectedValueOnce(new Error("408 request timed out"));
      const r = await routeModel("classify me");
      expect(r).toEqual({ costUsd: 0, durationMs: 0, method: "fallback" });
      expect("effort" in r).toBe(false);
    });
  });

  describe("no-key mode (truth condition: hasProvider)", () => {
    beforeEach(() => {
      mockHasProvider.mockReturnValue(false);
      __resetRouterStateForTests();
    });

    it("non-heuristic turns return {method: no-key}, no effort, no registry call", async () => {
      const r = await routeModel("summarize the quarter");
      expect(r).toEqual({ costUsd: 0, durationMs: 0, method: "no-key" } satisfies ModelRouterResult);
      expect("effort" in r).toBe(false);
      expect(mockGenerateForTask).not.toHaveBeenCalled();
    });

    it("heuristics still fire in no-key mode (H2 → heuristic)", async () => {
      const r = await routeModel("thanks");
      expect(r).toEqual({ costUsd: 0, durationMs: 0, effort: "low", method: "heuristic" });
    });
  });
});
