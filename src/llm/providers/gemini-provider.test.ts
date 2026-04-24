import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GeminiProvider } from "./gemini-provider.js";
import type { LLMProviderConfig } from "../types.js";

function makeConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    type: "gemini",
    apiKey: "gemini-test-key",
    ...overrides,
  };
}

function makeOkResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function geminiBody(text: string, usage?: object): object {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: usage ?? {
      promptTokenCount: 12,
      candidatesTokenCount: 6,
      totalTokenCount: 18,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeminiProvider — constructor", () => {
  it("throws when API key is missing", () => {
    expect(() => new GeminiProvider("gem", makeConfig({ apiKey: undefined }))).toThrow(
      "LLM provider 'gem' is missing an API key",
    );
  });

  it("throws when API key is empty string", () => {
    expect(() => new GeminiProvider("gem", makeConfig({ apiKey: "" }))).toThrow(
      "LLM provider 'gem' is missing an API key",
    );
  });

  it("constructs successfully with a valid key", () => {
    expect(() => new GeminiProvider("gem", makeConfig())).not.toThrow();
  });
});

describe("GeminiProvider — request shape", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(geminiBody("hello"))),
    );
  });

  it("posts to {baseUrl}/models/{model}:generateContent with key in query string", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" });

    const [url, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=gemini-test-key",
    );
    expect(init!.method).toBe("POST");
  });

  it("does not put the API key in an Authorization header", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("authorization");
  });

  it("uses content-type: application/json header", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("uses a custom baseUrl when provided (trailing slash stripped)", async () => {
    const provider = new GeminiProvider("gem", makeConfig({ baseUrl: "https://proxy.example.com/v1/" }));
    await provider.generateText({ model: "gemini-pro", prompt: "hi" });

    const [url] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toContain("https://proxy.example.com/v1/models/gemini-pro:generateContent");
  });

  it("URL-encodes the model name and key", async () => {
    const provider = new GeminiProvider("gem", makeConfig({ apiKey: "key/with+special=chars" }));
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" });

    const [url] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toContain(encodeURIComponent("key/with+special=chars"));
  });

  it("serializes user contents correctly", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "Hello Gemini" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello Gemini" }] }]);
  });

  it("includes system_instruction when systemPrompt is provided", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({
      model: "gemini-1.5-flash",
      prompt: "hi",
      systemPrompt: "You are a helpful assistant",
    });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.system_instruction).toEqual({
      parts: [{ text: "You are a helpful assistant" }],
    });
  });

  it("omits system_instruction when no systemPrompt is provided", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body).not.toHaveProperty("system_instruction");
  });

  it("includes maxOutputTokens in generationConfig when provided", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi", maxOutputTokens: 1024 });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.generationConfig.maxOutputTokens).toBe(1024);
  });

  it("includes temperature in generationConfig when provided", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi", temperature: 0.5 });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.generationConfig.temperature).toBe(0.5);
  });

  it("sets responseMimeType to application/json when responseFormat is 'json'", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi", responseFormat: "json" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("omits responseMimeType for text responseFormat", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi", responseFormat: "text" });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.generationConfig).not.toHaveProperty("responseMimeType");
  });
});

describe("GeminiProvider — image handling", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(geminiBody("described"))),
    );
  });

  it("prepends inline_data parts before the text part", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({
      model: "gemini-1.5-flash",
      prompt: "What is in this image?",
      images: [{ mimeType: "image/png", dataBase64: "abc123" }],
    });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    const parts = body.contents[0].parts;
    // Image part should come BEFORE the text part
    expect(parts[0]).toEqual({
      inline_data: { mime_type: "image/png", data: "abc123" },
    });
    expect(parts[1]).toEqual({ text: "What is in this image?" });
  });

  it("prepends multiple images in order before the text part", async () => {
    const provider = new GeminiProvider("gem", makeConfig());
    await provider.generateText({
      model: "gemini-1.5-flash",
      prompt: "Compare",
      images: [
        { mimeType: "image/png", dataBase64: "first" },
        { mimeType: "image/jpeg", dataBase64: "second" },
      ],
    });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    const parts = body.contents[0].parts;
    // Both images prepended — order: second image (last prepended), first image, text
    // Actually unshift prepends each in turn: after first unshift: [img1, text]
    // after second unshift: [img2, img1, text]
    expect(parts[0].inline_data.data).toBe("second");
    expect(parts[1].inline_data.data).toBe("first");
    expect(parts[2]).toEqual({ text: "Compare" });
  });
});

describe("GeminiProvider — response parsing", () => {
  it("joins text parts from candidates[0].content.parts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeOkResponse({
          candidates: [{ content: { parts: [{ text: "Hello " }, { text: "world" }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        }),
      ),
    );

    const provider = new GeminiProvider("gem", makeConfig());
    const result = await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" });
    expect(result.text).toBe("Hello world");
  });

  it("maps usage fields correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        makeOkResponse(
          geminiBody("ok", {
            promptTokenCount: 30,
            candidatesTokenCount: 15,
            totalTokenCount: 45,
          }),
        ),
      ),
    );

    const provider = new GeminiProvider("gem", makeConfig());
    const result = await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" });
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      totalTokens: 45,
    });
  });

  it("returns undefined usage when usageMetadata is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })),
    );

    const provider = new GeminiProvider("gem", makeConfig());
    const result = await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" });
    expect(result.usage).toBeUndefined();
  });

  it("returns empty string when candidates array is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse({ candidates: [], usageMetadata: {} })),
    );

    const provider = new GeminiProvider("gem", makeConfig());
    const result = await provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" });
    expect(result.text).toBe("");
  });

  it("returns correct provider id and model on result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOkResponse(geminiBody("ok"))),
    );

    const provider = new GeminiProvider("gem-prod", makeConfig());
    const result = await provider.generateText({ model: "gemini-1.5-pro", prompt: "hi" });
    expect(result.provider).toBe("gem-prod");
    expect(result.model).toBe("gemini-1.5-pro");
  });
});

describe("GeminiProvider — error handling", () => {
  it("throws when the HTTP response is not OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("API key not valid", { status: 400 })),
    );

    const provider = new GeminiProvider("gem", makeConfig());
    await expect(provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" })).rejects.toThrow(
      "LLM provider 'gem' returned 400: API key not valid",
    );
  });

  it("throws on 429 quota exceeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("quota exceeded", { status: 429 })),
    );

    const provider = new GeminiProvider("gem", makeConfig());
    await expect(provider.generateText({ model: "gemini-1.5-flash", prompt: "hi" })).rejects.toThrow("429");
  });
});
