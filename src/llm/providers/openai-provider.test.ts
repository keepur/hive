import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { OpenAIProvider, OpenAICompatibleProvider } from "./openai-provider.js";
import type { LLMProviderConfig } from "../types.js";

function makeConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    type: "openai",
    apiKey: "sk-openai-test",
    ...overrides,
  };
}

function makeOkResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function openAiBody(text: string, usage?: object): object {
  return {
    choices: [{ message: { content: text } }],
    usage: usage ?? { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIProvider — constructor", () => {
  it("throws when API key is missing", () => {
    expect(() => new OpenAIProvider("oai", makeConfig({ apiKey: undefined }))).toThrow(
      "LLM provider 'oai' is missing an API key",
    );
  });

  it("throws when API key is empty string", () => {
    expect(() => new OpenAIProvider("oai", makeConfig({ apiKey: "" }))).toThrow(
      "LLM provider 'oai' is missing an API key",
    );
  });

  it("constructs successfully with a valid key", () => {
    expect(() => new OpenAIProvider("oai", makeConfig())).not.toThrow();
  });
});

describe("OpenAIProvider — request shape", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(openAiBody("hello"))),
    );
  });

  it("posts to {baseUrl}/chat/completions with Bearer auth header", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({ model: "gpt-4o-mini", prompt: "Say hi" });

    const fetchMock = vi.mocked(global.fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init!.headers as Record<string, string>)["authorization"]).toBe("Bearer sk-openai-test");
    expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("uses a custom baseUrl when provided", async () => {
    const provider = new OpenAIProvider("oai", makeConfig({ baseUrl: "https://proxy.example.com/v1" }));
    await provider.generateText({ model: "gpt-4o", prompt: "hi" });

    const [url] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe("https://proxy.example.com/v1/chat/completions");
  });

  it("serializes model and messages correctly for a simple prompt", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({ model: "gpt-4o-mini", prompt: "What is 2+2?" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([{ role: "user", content: "What is 2+2?" }]);
  });

  it("includes a system message when systemPrompt is provided", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({ model: "gpt-4o", prompt: "hi", systemPrompt: "Be concise" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "Be concise" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("includes max_tokens when maxOutputTokens is set", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({ model: "gpt-4o", prompt: "hi", maxOutputTokens: 512 });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.max_tokens).toBe(512);
  });

  it("omits max_tokens when maxOutputTokens is not set", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({ model: "gpt-4o", prompt: "hi" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("includes temperature when provided", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({ model: "gpt-4o", prompt: "hi", temperature: 0.7 });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.temperature).toBe(0.7);
  });

  it("includes response_format: json_object when responseFormat is 'json'", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({ model: "gpt-4o", prompt: "hi", responseFormat: "json" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format for non-json responseFormat", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({ model: "gpt-4o", prompt: "hi", responseFormat: "text" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body).not.toHaveProperty("response_format");
  });
});

describe("OpenAIProvider — image handling", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(openAiBody("described"))),
    );
  });

  it("switches user content to multimodal parts when images are present", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({
      model: "gpt-4o",
      prompt: "What is in this image?",
      images: [{ mimeType: "image/png", dataBase64: "abc123" }],
    });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    const userMessage = body.messages.find((m: { role: string }) => m.role === "user");
    expect(Array.isArray(userMessage.content)).toBe(true);
    expect(userMessage.content[0]).toEqual({ type: "text", text: "What is in this image?" });
    expect(userMessage.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc123" },
    });
  });

  it("uses plain string content when no images are provided", async () => {
    const provider = new OpenAIProvider("oai", makeConfig());
    await provider.generateText({ model: "gpt-4o", prompt: "text only" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    const userMessage = body.messages.find((m: { role: string }) => m.role === "user");
    expect(typeof userMessage.content).toBe("string");
    expect(userMessage.content).toBe("text only");
  });
});

describe("OpenAIProvider — response parsing", () => {
  it("extracts text from choices[0].message.content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(openAiBody("The answer is 42"))),
    );

    const provider = new OpenAIProvider("oai", makeConfig());
    const result = await provider.generateText({ model: "gpt-4o", prompt: "hi" });
    expect(result.text).toBe("The answer is 42");
  });

  it("maps usage fields correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeOkResponse(openAiBody("ok", { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 })),
      ),
    );

    const provider = new OpenAIProvider("oai", makeConfig());
    const result = await provider.generateText({ model: "gpt-4o", prompt: "hi" });
    expect(result.usage).toEqual({
      inputTokens: 15,
      outputTokens: 7,
      totalTokens: 22,
    });
  });

  it("returns undefined usage when response has no usage field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse({ choices: [{ message: { content: "ok" } }] })),
    );

    const provider = new OpenAIProvider("oai", makeConfig());
    const result = await provider.generateText({ model: "gpt-4o", prompt: "hi" });
    expect(result.usage).toBeUndefined();
  });

  it("returns empty string when choices content is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse({ choices: [{ message: { content: null } }], usage: {} })),
    );

    const provider = new OpenAIProvider("oai", makeConfig());
    const result = await provider.generateText({ model: "gpt-4o", prompt: "hi" });
    expect(result.text).toBe("");
  });

  it("returns correct provider id and model on result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(openAiBody("ok"))),
    );

    const provider = new OpenAIProvider("oai-prod", makeConfig());
    const result = await provider.generateText({ model: "gpt-4o-mini", prompt: "hi" });
    expect(result.provider).toBe("oai-prod");
    expect(result.model).toBe("gpt-4o-mini");
  });
});

describe("OpenAIProvider — error handling", () => {
  it("throws when the HTTP response is not OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );

    const provider = new OpenAIProvider("oai", makeConfig());
    await expect(provider.generateText({ model: "gpt-4o", prompt: "hi" })).rejects.toThrow(
      "LLM provider 'oai' returned 401: Unauthorized",
    );
  });
});

describe("OpenAICompatibleProvider", () => {
  it("constructs without an API key and does not throw", () => {
    expect(
      () => new OpenAICompatibleProvider("local", { type: "openai-compatible", baseUrl: "http://localhost:11434/v1" }),
    ).not.toThrow();
  });

  it("omits the Authorization header when no key is provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(openAiBody("local reply"))),
    );

    const provider = new OpenAICompatibleProvider("local", {
      type: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    });
    await provider.generateText({ model: "llama3.2", prompt: "hi" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("authorization");
  });

  it("includes Bearer header when a key is provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(openAiBody("keyed reply"))),
    );

    const provider = new OpenAICompatibleProvider("local-keyed", {
      type: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local-secret",
    });
    await provider.generateText({ model: "llama3.2", prompt: "hi" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer local-secret");
  });

  it("posts to the correct endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(openAiBody("ok"))),
    );

    const provider = new OpenAICompatibleProvider("local", {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    await provider.generateText({ model: "llama3.2", prompt: "hi" });

    const [url] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("parses and returns text from response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(openAiBody("local answer"))),
    );

    const provider = new OpenAICompatibleProvider("local", {
      type: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    });
    const result = await provider.generateText({ model: "llama3.2", prompt: "hi" });
    expect(result.text).toBe("local answer");
  });
});
