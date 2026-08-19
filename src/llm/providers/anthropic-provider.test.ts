import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockParse, mockCreate, mockCtor } = vi.hoisted(() => ({
  mockParse: vi.fn(),
  mockCreate: vi.fn(),
  mockCtor: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { parse: mockParse, create: mockCreate };
    constructor(opts: unknown) {
      mockCtor(opts);
    }
  },
}));
// jsonSchemaOutputFormat deliberately NOT mocked — pure helper, no network.

import { AnthropicProvider } from "./anthropic-provider.js";

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: '{"ok":true}' }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockParse.mockResolvedValue(makeMessage({ parsed_output: { ok: true } }));
  mockCreate.mockResolvedValue(makeMessage());
});

describe("AnthropicProvider", () => {
  it("constructs one client with apiKey and maxRetries: 0; empty key throws", () => {
    new AnthropicProvider("k");
    expect(mockCtor).toHaveBeenCalledWith({ apiKey: "k", maxRetries: 0 });
    expect(() => new AnthropicProvider("")).toThrow("missing an API key");
  });

  it("schema request → messages.parse with output_config; parsed mapped from parsed_output", async () => {
    const p = new AnthropicProvider("k");
    const result = await p.generate({
      model: "claude-haiku-4-5-20251001",
      prompt: "classify",
      systemPrompt: "sys",
      maxOutputTokens: 100,
      jsonSchema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 4000,
    });
    expect(mockParse).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    const [params, opts] = mockParse.mock.calls[0]!;
    expect(params.model).toBe("claude-haiku-4-5-20251001");
    expect(params.max_tokens).toBe(100);
    expect(params.system).toBe("sys");
    expect(params.output_config?.format).toBeDefined();
    expect(opts).toEqual({ timeout: 4000 });
    expect(result.parsed).toEqual({ ok: true });
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(result.provider).toBe("anthropic");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("plain request → messages.create, no parse, parsed key absent", async () => {
    const p = new AnthropicProvider("k");
    const result = await p.generate({ model: "m", prompt: "summarize", maxOutputTokens: 256, temperature: 0 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockParse).not.toHaveBeenCalled();
    expect(mockCreate.mock.calls[0]![0].temperature).toBe(0);
    expect("parsed" in result).toBe(false);
    expect(result.text).toBe('{"ok":true}');
  });

  it("no timeoutMs ⇒ no request options object", async () => {
    const p = new AnthropicProvider("k");
    await p.generate({ model: "m", prompt: "x" });
    expect(mockCreate.mock.calls[0]![1]).toBeUndefined();
  });

  it("images map to base64 image blocks BEFORE the text block", async () => {
    const p = new AnthropicProvider("k");
    await p.generate({
      model: "m",
      prompt: "describe",
      images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
    });
    const content = mockCreate.mock.calls[0]![0].messages[0].content;
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(content[1]).toEqual({ type: "text", text: "describe" });
  });

  it("propagates thrown SDK errors (no swallowing — callers own fallback)", async () => {
    mockCreate.mockRejectedValueOnce(new Error("529 overloaded"));
    const p = new AnthropicProvider("k");
    await expect(p.generate({ model: "m", prompt: "x" })).rejects.toThrow("529 overloaded");
  });
});
