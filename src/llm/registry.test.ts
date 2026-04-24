import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMRegistry } from "./registry.js";
import type { LLMRegistryConfig } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LLMRegistry", () => {
  it("resolves task aliases to configured provider models", () => {
    const registry = new LLMRegistry({
      providers: {
        local: { type: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" },
      },
      models: {
        "local-fast": { provider: "local", model: "llama3.2" },
      },
      tasks: {
        memory: "local-fast",
      },
    });

    const resolved = registry.resolveTask("memory");
    expect(resolved.alias).toBe("local-fast");
    expect(resolved.model.model).toBe("llama3.2");
    expect(resolved.provider.type).toBe("openai-compatible");
  });

  it("does not expose uncredentialed hosted providers", () => {
    const registry = new LLMRegistry({
      providers: {
        openai: { type: "openai" },
      },
      models: {
        "openai-fast": { provider: "openai", model: "gpt-test" },
      },
      tasks: {
        modelRouter: "openai-fast",
      },
    });

    expect(() => registry.resolveTask("modelRouter")).toThrow(/not configured/);
  });

  it("calls OpenAI-compatible endpoints without requiring an API key", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "local response" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const config: LLMRegistryConfig = {
      providers: {
        local: { type: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" },
      },
      models: {
        "local-fast": { provider: "local", model: "llama3.2" },
      },
      tasks: {
        memory: "local-fast",
      },
    };
    const registry = new LLMRegistry(config);

    const result = await registry.generateForTask("memory", { prompt: "Summarize this" });

    expect(result.text).toBe("local response");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
  });
});
