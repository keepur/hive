import { describe, it, expect, vi, afterEach } from "vitest";
import { GeminiProvider } from "./gemini-provider.js";

function makeOkResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function geminiBody(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GeminiProvider", () => {
  it("throws without an API key", () => {
    expect(() => new GeminiProvider("")).toThrow("missing an API key");
  });

  it("sends generateContent with inline base64 parts before text, system_instruction, generationConfig", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeOkResponse(geminiBody("a cat")));
    vi.stubGlobal("fetch", fetchSpy);
    const p = new GeminiProvider("gem-key");
    const result = await p.generate({
      model: "gemini-2.5-flash",
      prompt: "describe",
      systemPrompt: "be thorough",
      maxOutputTokens: 2048,
      temperature: 0,
      timeoutMs: 30_000,
      images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/models/gemini-2.5-flash:generateContent");
    expect(url).toContain("key=gem-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0]).toEqual({ inline_data: { mime_type: "image/png", data: "AAAA" } });
    expect(body.contents[0].parts[1]).toEqual({ text: "describe" });
    expect(body.system_instruction.parts[0].text).toBe("be thorough");
    expect(body.generationConfig).toEqual({ maxOutputTokens: 2048, temperature: 0 });
    expect(result.text).toBe("a cat");
    expect(result.stopReason).toBe("STOP");
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 8 });
  });

  it("no timeoutMs ⇒ no abort signal", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(makeOkResponse(geminiBody("x")));
    vi.stubGlobal("fetch", fetchSpy);
    await new GeminiProvider("k").generate({ model: "m", prompt: "p" });
    expect(fetchSpy.mock.calls[0]![1].signal).toBeUndefined();
  });

  it("non-OK response throws with status and body slice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("quota exceeded", { status: 429 })));
    await expect(new GeminiProvider("k").generate({ model: "m", prompt: "p" })).rejects.toThrow(
      "LLM provider 'gemini' returned 429: quota exceeded",
    );
  });

  it("never leaks the API key into thrown errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
    const err = (await new GeminiProvider("gem-secret").generate({ model: "m", prompt: "p" }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain("gem-secret");
  });

  it("empty candidates yield empty text (caller treats as failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeOkResponse({})));
    const result = await new GeminiProvider("k").generate({ model: "m", prompt: "p" });
    expect(result.text).toBe("");
    expect(result.usage).toBeUndefined();
  });
});
