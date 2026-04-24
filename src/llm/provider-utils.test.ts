import { describe, it, expect, afterEach, vi } from "vitest";
import {
  requireApiKey,
  normalizeBaseUrl,
  withTimeout,
  parseJsonResponse,
  textPromptParts,
  extractJsonObjectText,
  extractJsonArrayText,
} from "./provider-utils.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requireApiKey", () => {
  it("returns the key when provided", () => {
    expect(requireApiKey("my-provider", "sk-abc123")).toBe("sk-abc123");
  });

  it("throws when key is undefined", () => {
    expect(() => requireApiKey("my-provider", undefined)).toThrow("LLM provider 'my-provider' is missing an API key");
  });

  it("throws when key is an empty string", () => {
    expect(() => requireApiKey("my-provider", "")).toThrow("LLM provider 'my-provider' is missing an API key");
  });
});

describe("normalizeBaseUrl", () => {
  it("returns the provided URL with trailing slash stripped", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/", "https://fallback.com")).toBe("https://api.example.com/v1");
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1///", "https://fallback.com")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("uses fallback when URL is undefined", () => {
    expect(normalizeBaseUrl(undefined, "https://fallback.com/v1")).toBe("https://fallback.com/v1");
  });

  it("uses fallback when URL is an empty string", () => {
    expect(normalizeBaseUrl("", "https://fallback.com/v1")).toBe("https://fallback.com/v1");
  });

  it("does not modify a URL without trailing slash", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1", "https://fallback.com")).toBe("https://api.example.com/v1");
  });
});

describe("withTimeout", () => {
  it("returns undefined when ms is 0", () => {
    expect(withTimeout(0)).toBeUndefined();
  });

  it("returns undefined when ms is negative", () => {
    expect(withTimeout(-1)).toBeUndefined();
  });

  it("returns undefined when ms is undefined", () => {
    expect(withTimeout(undefined)).toBeUndefined();
  });

  it("returns an AbortSignal when ms is positive", () => {
    const signal = withTimeout(5000);
    expect(signal).toBeInstanceOf(AbortSignal);
    // Signal should not be immediately aborted
    expect(signal!.aborted).toBe(false);
  });
});

describe("parseJsonResponse", () => {
  it("returns parsed body for a 200 OK response", async () => {
    const payload = { answer: 42, text: "hello" };
    const response = new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const result = await parseJsonResponse<typeof payload>(response, "test-provider");
    expect(result).toEqual(payload);
  });

  it("throws with status and body snippet for a non-OK response", async () => {
    const response = new Response("Bad Request: invalid model", { status: 400 });
    await expect(parseJsonResponse(response, "test-provider")).rejects.toThrow(
      "LLM provider 'test-provider' returned 400: Bad Request: invalid model",
    );
  });

  it("throws for 500 status", async () => {
    const response = new Response("Internal Server Error", { status: 500 });
    await expect(parseJsonResponse(response, "my-prov")).rejects.toThrow("LLM provider 'my-prov' returned 500");
  });

  it("truncates body to 500 characters in the error message", async () => {
    const longBody = "x".repeat(600);
    const response = new Response(longBody, { status: 503 });
    await expect(parseJsonResponse(response, "p")).rejects.toThrow("x".repeat(500));
  });
});

describe("textPromptParts", () => {
  it("returns a single text part when no images are present", () => {
    const parts = textPromptParts({ model: "m", prompt: "Hello there" });
    expect(parts).toEqual([{ type: "text", text: "Hello there" }]);
  });

  it("prepends a text part then appends image_url parts for each image", () => {
    const parts = textPromptParts({
      model: "m",
      prompt: "Describe this",
      images: [
        { mimeType: "image/png", dataBase64: "abc123" },
        { mimeType: "image/jpeg", dataBase64: "def456" },
      ],
    });
    expect(parts).toEqual([
      { type: "text", text: "Describe this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,def456" } },
    ]);
  });

  it("produces correct data URL shape", () => {
    const parts = textPromptParts({
      model: "m",
      prompt: "Look",
      images: [{ mimeType: "image/webp", dataBase64: "zzz" }],
    });
    const imgPart = parts[1] as { type: string; image_url: { url: string } };
    expect(imgPart.image_url.url).toBe("data:image/webp;base64,zzz");
  });
});

describe("extractJsonObjectText", () => {
  it("returns trimmed JSON object as-is", () => {
    expect(extractJsonObjectText('{"a":1}')).toBe('{"a":1}');
  });

  it("strips surrounding prose and returns just the object", () => {
    expect(extractJsonObjectText('Here is the result: {"key":"value"} end')).toBe('{"key":"value"}');
  });

  it("returns null when no braces are found", () => {
    expect(extractJsonObjectText("no json here")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJsonObjectText("")).toBeNull();
  });

  it("handles whitespace around valid JSON object", () => {
    expect(extractJsonObjectText('  {"x":1}  ')).toBe('{"x":1}');
  });
});

describe("extractJsonArrayText", () => {
  it("returns trimmed JSON array as-is", () => {
    expect(extractJsonArrayText("[1,2,3]")).toBe("[1,2,3]");
  });

  it("strips surrounding prose and returns just the array", () => {
    expect(extractJsonArrayText('Result: [1,"two",3] done')).toBe('[1,"two",3]');
  });

  it("returns null when no brackets are found", () => {
    expect(extractJsonArrayText("no json here")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJsonArrayText("")).toBeNull();
  });

  it("handles whitespace around valid JSON array", () => {
    expect(extractJsonArrayText("  [1,2]  ")).toBe("[1,2]");
  });
});
