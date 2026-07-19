import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLog, mockConfig, mockAnthropicGenerate, mockGeminiGenerate, anthropicCtor, geminiCtor } = vi.hoisted(
  () => ({
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockConfig: {
      anthropic: { apiKey: "ant-key" },
      gemini: { apiKey: "gem-key", visionModel: "gemini-2.5-flash" },
      modelRouter: { model: "claude-haiku-4-5-20251001", timeoutMs: 4000 },
    },
    mockAnthropicGenerate: vi.fn(),
    mockGeminiGenerate: vi.fn(),
    anthropicCtor: vi.fn(),
    geminiCtor: vi.fn(),
  }),
);

vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));
vi.mock("../config.js", () => ({ config: mockConfig }));
vi.mock("./providers/anthropic-provider.js", () => ({
  AnthropicProvider: class {
    id = "anthropic" as const;
    generate = mockAnthropicGenerate;
    constructor(key: string) {
      anthropicCtor(key);
    }
  },
}));
vi.mock("./providers/gemini-provider.js", () => ({
  GeminiProvider: class {
    id = "gemini" as const;
    generate = mockGeminiGenerate;
    constructor(key: string) {
      geminiCtor(key);
    }
  },
}));

import { LLMRegistry, getLLMRegistry, __resetLLMRegistryForTests } from "./registry.js";
import { LLMProviderUnavailableError, LLMCapabilityError } from "./errors.js";
import { LLM_CATALOG, catalogModel, estimateCostUsdFromPricing } from "./catalog.js";

const HAIKU_PRICING = { inputPerMTok: 1, outputPerMTok: 5 };

function makeProviderResult(overrides: Record<string, unknown> = {}) {
  return {
    text: "out",
    model: "claude-haiku-4-5-20251001",
    provider: "anthropic" as const,
    durationMs: 5,
    stopReason: "end_turn",
    usage: { inputTokens: 500, outputTokens: 10 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetLLMRegistryForTests();
  mockConfig.modelRouter.model = "claude-haiku-4-5-20251001";
  mockConfig.gemini.visionModel = "gemini-2.5-flash";
  mockAnthropicGenerate.mockResolvedValue(makeProviderResult());
  mockGeminiGenerate.mockResolvedValue(makeProviderResult({ provider: "gemini", model: "gemini-2.5-flash" }));
});

describe("LLMRegistry — key-gated construction", () => {
  it("constructs a provider only when its key resolves", () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    expect(r.hasProvider("anthropic")).toBe(true);
    expect(r.hasProvider("gemini")).toBe(false);
    expect(anthropicCtor).toHaveBeenCalledWith("a");
    expect(geminiCtor).not.toHaveBeenCalled();
  });

  it("zero keys is a valid state — boots, both providers absent", () => {
    const r = new LLMRegistry({ anthropicApiKey: "", geminiApiKey: "" });
    expect(r.hasProvider("anthropic")).toBe(false);
    expect(r.hasProvider("gemini")).toBe(false);
  });

  it("throws typed unavailable error on task resolve without a key", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "", geminiApiKey: "" });
    await expect(r.generateForTask("meetingClassifier", { prompt: "p" })).rejects.toBeInstanceOf(
      LLMProviderUnavailableError,
    );
    expect(mockAnthropicGenerate).not.toHaveBeenCalled();
  });

  it("getLLMRegistry is a singleton keyed off config", () => {
    expect(getLLMRegistry()).toBe(getLLMRegistry());
  });
});

describe("LLMRegistry — task resolution", () => {
  it("classifier tasks honor config.modelRouter.model; memory is catalog-pinned; vision honors visionModel", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "g" });
    await r.generateForTask("routerClassifier", { prompt: "p" });
    await r.generateForTask("meetingClassifier", { prompt: "p" });
    await r.generateForTask("memory", { prompt: "p" });
    await r.generateForTask("vision", { prompt: "p" });
    expect(mockAnthropicGenerate.mock.calls.map((c) => c[0].model)).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5-20251001",
      "claude-haiku-4-5-20251001",
    ]);
    expect(mockGeminiGenerate.mock.calls[0][0].model).toBe("gemini-2.5-flash");
  });

  it("request fields pass through to the provider", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    await r.generateForTask("memory", { prompt: "p", maxOutputTokens: 256, temperature: 0, timeoutMs: 30_000 });
    expect(mockAnthropicGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "p", maxOutputTokens: 256, temperature: 0, timeoutMs: 30_000 }),
    );
  });
});

describe("LLMRegistry — cost computation (the PR #194 defect fix)", () => {
  it("computes costUsd from usage × catalog pricing — 500 in / 10 out on haiku = $0.00055 (KPR-312's math re-anchored)", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    const result = await r.generateForTask("memory", { prompt: "p" });
    expect(result.costUsd).toBeCloseTo(0.00055, 8);
  });

  it("costUsd undefined when the model has no catalog pricing (gemini vision)", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "", geminiApiKey: "g" });
    const result = await r.generateForTask("vision", { prompt: "p" });
    expect(result.costUsd).toBeUndefined();
  });

  it("costUsd undefined when the provider returned no usage", async () => {
    mockAnthropicGenerate.mockResolvedValueOnce(makeProviderResult({ usage: undefined }));
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    const result = await r.generateForTask("memory", { prompt: "p" });
    expect(result.costUsd).toBeUndefined();
  });

  it("off-catalog model id: call proceeds, costUsd undefined, ONE warn across repeated calls", async () => {
    mockConfig.modelRouter.model = "my-custom-haiku";
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    const r1 = await r.generateForTask("routerClassifier", { prompt: "p" });
    const r2 = await r.generateForTask("routerClassifier", { prompt: "p" });
    expect(r1.costUsd).toBeUndefined();
    expect(r2.costUsd).toBeUndefined();
    expect(mockAnthropicGenerate).toHaveBeenCalledTimes(2);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });
});

describe("LLMRegistry — capability validation", () => {
  it("vision task bound to a catalog non-vision model throws LLMCapabilityError with ONE log.error", async () => {
    mockConfig.gemini.visionModel = "claude-haiku-4-5-20251001"; // catalog entry, no "vision"
    const r = new LLMRegistry({ anthropicApiKey: "", geminiApiKey: "g" });
    await expect(r.generateForTask("vision", { prompt: "p" })).rejects.toBeInstanceOf(LLMCapabilityError);
    await expect(r.generateForTask("vision", { prompt: "p" })).rejects.toBeInstanceOf(LLMCapabilityError);
    expect(mockGeminiGenerate).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });

  it("schema-bearing request passes on a structured-outputs model", async () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    await expect(
      r.generateForTask("meetingClassifier", { prompt: "p", jsonSchema: { type: "object" } }),
    ).resolves.toBeDefined();
  });
});

describe("catalog metadata (spec §3.2 pins)", () => {
  it("supportsEffort: haiku false, sonnet true, opus true, unknown false", () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    expect(r.supportsEffort("claude-haiku-4-5-20251001")).toBe(false);
    expect(r.supportsEffort("claude-sonnet-4-6")).toBe(true);
    expect(r.supportsEffort("claude-opus-4-7")).toBe(true);
    expect(r.supportsEffort("claude-opus-4-8")).toBe(true);
    expect(r.supportsEffort("claude-sonnet-5")).toBe(true);
    expect(r.supportsEffort("claude-fable-5")).toBe(true);
    expect(r.supportsEffort("mystery-model")).toBe(false);
  });

  it("haiku pricing is KPR-312's constants ($1/$5 per MTok)", () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "" });
    expect(r.pricingFor("claude-haiku-4-5-20251001")).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(r.pricingFor("gemini-2.5-flash")).toBeUndefined();
  });

  it("every catalog id is unique and provider-typed", () => {
    expect(new Set(LLM_CATALOG.map((m) => m.id)).size).toBe(LLM_CATALOG.length);
    expect(catalogModel("claude-haiku-4-5-20251001")?.provider).toBe("anthropic");
  });
});

describe("estimateCostUsd (the memory gate's math — spec §3.4 triple)", () => {
  it.each([
    [32_640, 0.00944], // fitted cold-summary page + wrapper (8,160 est. input tokens)
    [36_000, 0.01028], // shallow-over band page (9,000 est. input tokens)
    [96_000, 0.02528], // deep-over min-records page (24,000 est. input tokens; spec's ≈$0.0253)
  ])("prompt of %i chars at 256 max output ⇒ $%f", (chars, expected) => {
    const estimate = estimateCostUsdFromPricing(HAIKU_PRICING, {
      prompt: "x".repeat(chars),
      maxOutputTokens: 256,
    });
    expect(estimate).toBeCloseTo(expected, 8);
  });

  it("registry-level estimate uses the task's bound model pricing; pricing-less task ⇒ undefined", () => {
    const r = new LLMRegistry({ anthropicApiKey: "a", geminiApiKey: "g" });
    expect(r.estimateCostUsd("memory", { prompt: "x".repeat(32_640), maxOutputTokens: 256 })).toBeCloseTo(0.00944, 8);
    expect(r.estimateCostUsd("vision", { prompt: "p", maxOutputTokens: 2048 })).toBeUndefined();
  });

  it("systemPrompt chars count toward the input estimate", () => {
    const withSystem = estimateCostUsdFromPricing(HAIKU_PRICING, {
      prompt: "x".repeat(4000),
      systemPrompt: "y".repeat(4000),
      maxOutputTokens: 0,
    });
    expect(withSystem).toBeCloseTo(0.002, 8); // 2000 tokens × $1/MTok
  });
});
