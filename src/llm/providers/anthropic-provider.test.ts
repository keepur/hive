import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { AnthropicProvider } from "./anthropic-provider.js";
import type { LLMProviderConfig } from "../types.js";

function makeConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    type: "anthropic",
    apiKey: "sk-ant-test",
    ...overrides,
  };
}

function makeOkResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function anthropicBody(text: string, usage?: object): object {
  return {
    content: [{ type: "text", text }],
    usage: usage ?? {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnthropicProvider — constructor", () => {
  it("throws when API key is missing", () => {
    expect(() => new AnthropicProvider("my-ant", makeConfig({ apiKey: undefined }))).toThrow(
      "LLM provider 'my-ant' is missing an API key",
    );
  });

  it("throws when API key is empty string", () => {
    expect(() => new AnthropicProvider("my-ant", makeConfig({ apiKey: "" }))).toThrow(
      "LLM provider 'my-ant' is missing an API key",
    );
  });

  it("constructs successfully with a valid key", () => {
    expect(() => new AnthropicProvider("ant", makeConfig())).not.toThrow();
  });
});

describe("AnthropicProvider — request shape", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(anthropicBody("hello"))),
    );
  });

  it("posts to {baseUrl}/messages with correct headers", async () => {
    const provider = new AnthropicProvider("ant", makeConfig());
    await provider.generateText({ model: "claude-3-haiku-20240307", prompt: "Say hi" });

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
    expect((init!.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("uses a custom baseUrl when provided (trailing slash stripped)", async () => {
    const provider = new AnthropicProvider("ant", makeConfig({ baseUrl: "https://proxy.example.com/v1/" }));
    await provider.generateText({ model: "claude-3-haiku-20240307", prompt: "hi" });

    const [url] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe("https://proxy.example.com/v1/messages");
  });

  it("serializes model, max_tokens, and messages correctly", async () => {
    const provider = new AnthropicProvider("ant", makeConfig());
    await provider.generateText({
      model: "claude-3-5-sonnet-20241022",
      prompt: "What is 2+2?",
      maxOutputTokens: 256,
    });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("claude-3-5-sonnet-20241022");
    expect(body.max_tokens).toBe(256);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "What is 2+2?" }] }]);
  });

  it("defaults max_tokens to 1024 when not specified", async () => {
    const provider = new AnthropicProvider("ant", makeConfig());
    await provider.generateText({ model: "claude-3-haiku-20240307", prompt: "hi" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.max_tokens).toBe(1024);
  });

  it("includes system prompt when provided", async () => {
    const provider = new AnthropicProvider("ant", makeConfig());
    await provider.generateText({
      model: "claude-3-haiku-20240307",
      prompt: "hi",
      systemPrompt: "You are a helper",
    });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.system).toBe("You are a helper");
  });

  it("omits system key when no system prompt is provided", async () => {
    const provider = new AnthropicProvider("ant", makeConfig());
    await provider.generateText({ model: "claude-3-haiku-20240307", prompt: "hi" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body).not.toHaveProperty("system");
  });

  it("includes temperature when provided", async () => {
    const provider = new AnthropicProvider("ant", makeConfig());
    await provider.generateText({ model: "m", prompt: "hi", temperature: 0.2 });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.temperature).toBe(0.2);
  });
});

describe("AnthropicProvider — image handling", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(anthropicBody("described"))),
    );
  });

  it("appends image parts to the user content array", async () => {
    const provider = new AnthropicProvider("ant", makeConfig());
    await provider.generateText({
      model: "claude-3-5-sonnet-20241022",
      prompt: "Describe this image",
      images: [{ mimeType: "image/png", dataBase64: "abc123" }],
    });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    const content = body.messages[0].content;
    expect(content).toEqual([
      { type: "text", text: "Describe this image" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc123" },
      },
    ]);
  });

  it("appends multiple image parts in order", async () => {
    const provider = new AnthropicProvider("ant", makeConfig());
    await provider.generateText({
      model: "m",
      prompt: "Compare",
      images: [
        { mimeType: "image/png", dataBase64: "aaa" },
        { mimeType: "image/jpeg", dataBase64: "bbb" },
      ],
    });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "Compare" });
    expect(content[1].source.data).toBe("aaa");
    expect(content[2].source.data).toBe("bbb");
  });
});

describe("AnthropicProvider — response parsing", () => {
  it("joins text parts from content array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeOkResponse({
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      ),
    );

    const provider = new AnthropicProvider("ant", makeConfig());
    const result = await provider.generateText({ model: "m", prompt: "hi" });
    expect(result.text).toBe("Hello world");
  });

  it("skips non-text content parts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeOkResponse({
          content: [
            { type: "tool_use", id: "x" },
            { type: "text", text: "answer" },
          ],
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
      ),
    );

    const provider = new AnthropicProvider("ant", makeConfig());
    const result = await provider.generateText({ model: "m", prompt: "hi" });
    expect(result.text).toBe("answer");
  });

  it("maps usage fields correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeOkResponse({
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 2,
          },
        }),
      ),
    );

    const provider = new AnthropicProvider("ant", makeConfig());
    const result = await provider.generateText({ model: "m", prompt: "hi" });
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
    });
  });

  it("returns undefined usage when response has no usage field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse({ content: [{ type: "text", text: "ok" }] })),
    );

    const provider = new AnthropicProvider("ant", makeConfig());
    const result = await provider.generateText({ model: "m", prompt: "hi" });
    expect(result.usage).toBeUndefined();
  });

  it("returns correct provider id and model on result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(anthropicBody("ok"))),
    );

    const provider = new AnthropicProvider("ant-prod", makeConfig());
    const result = await provider.generateText({ model: "claude-3-5-sonnet-20241022", prompt: "hi" });
    expect(result.provider).toBe("ant-prod");
    expect(result.model).toBe("claude-3-5-sonnet-20241022");
  });
});

describe("AnthropicProvider — error handling", () => {
  it("throws when the HTTP response is not OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );

    const provider = new AnthropicProvider("ant", makeConfig());
    await expect(provider.generateText({ model: "m", prompt: "hi" })).rejects.toThrow(
      "LLM provider 'ant' returned 401: Unauthorized",
    );
  });

  it("throws on 429 rate limit responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limit exceeded", { status: 429 })),
    );

    const provider = new AnthropicProvider("ant", makeConfig());
    await expect(provider.generateText({ model: "m", prompt: "hi" })).rejects.toThrow("429");
  });
});
