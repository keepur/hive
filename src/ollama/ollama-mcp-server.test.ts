import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildOllamaTools,
  createOllamaMcpServer,
  stripDataUrlPrefix,
  summarizeModels,
  OLLAMA_DEFAULT_MODEL,
} from "./ollama-mcp-server.js";

/** Minimal shape of an SDK `tool()` result we assert against. */
interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

interface CallableTool {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;
}

function toolsByName(): Record<string, CallableTool> {
  const tools = buildOllamaTools({ ollamaUrl: "http://ollama.test:11434" }) as unknown as CallableTool[];
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

function call(tool: CallableTool, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return tool.handler(args, {});
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
}

describe("stripDataUrlPrefix", () => {
  it("strips a data URL prefix", () => {
    expect(stripDataUrlPrefix("data:image/png;base64,AAAA")).toBe("AAAA");
  });

  it("leaves bare base64 untouched", () => {
    expect(stripDataUrlPrefix("AAAA")).toBe("AAAA");
  });
});

describe("summarizeModels", () => {
  it("shapes /api/tags output", () => {
    const out = summarizeModels({
      models: [
        {
          name: "qwen2.5:14b",
          size: 9_000_000_000,
          details: { family: "qwen2", parameter_size: "14.8B", quantization_level: "Q4_K_M" },
        },
      ],
    });
    expect(out).toEqual([
      { name: "qwen2.5:14b", size_gb: "9.0", family: "qwen2", parameters: "14.8B", quantization: "Q4_K_M" },
    ]);
  });

  it("does not throw on missing or malformed fields", () => {
    expect(summarizeModels({ models: [{}] })).toEqual([
      { name: "unknown", size_gb: "unknown", family: "unknown", parameters: "unknown", quantization: "unknown" },
    ]);
    expect(summarizeModels({})).toEqual([]);
    expect(summarizeModels({ models: "nope" })).toEqual([]);
  });
});

describe("ollama tool surface", () => {
  it("exposes exactly the v1 tools — RAG is deliberately deferred", () => {
    expect(Object.keys(toolsByName()).sort()).toEqual(["ollama_list_models", "ollama_query"]);
  });

  it("builds an SDK server named ollama", () => {
    expect(createOllamaMcpServer({})).toBeDefined();
  });
});

describe("ollama_query", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses /api/generate and the default model for a bare prompt", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ response: "  local answer  " }));
    const res = await call(toolsByName().ollama_query, { prompt: "hi" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ollama.test:11434/api/generate");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      model: OLLAMA_DEFAULT_MODEL,
      prompt: "hi",
      stream: false,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe("local answer");
  });

  it("switches to /api/chat when a system prompt is supplied", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: { content: "chat answer" } }));
    await call(toolsByName().ollama_query, { prompt: "hi", system_prompt: "be terse" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ollama.test:11434/api/chat");
    expect(JSON.parse((init as RequestInit).body as string).messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
  });

  it("passes images through /api/chat with the data-URL prefix stripped", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: { content: "i see a cat" } }));
    await call(toolsByName().ollama_query, {
      prompt: "what is this",
      image: "data:image/png;base64,AAAA",
      model: "llama3.2-vision:11b",
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("llama3.2-vision:11b");
    expect(body.messages[0].images).toEqual(["AAAA"]);
  });

  it("returns a placeholder rather than empty content when the model says nothing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ response: "" }));
    const res = await call(toolsByName().ollama_query, { prompt: "hi" });
    expect(res.content[0].text).toBe("(empty response)");
  });

  it("reports a daemon-down failure as a tool error naming the url and model", async () => {
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    const res = await call(toolsByName().ollama_query, { prompt: "hi" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("fetch failed");
    expect(res.content[0].text).toContain(OLLAMA_DEFAULT_MODEL);
    expect(res.content[0].text).toContain("http://ollama.test:11434");
  });

  it("surfaces a non-2xx from Ollama instead of returning a body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
    } as unknown as Response);
    const res = await call(toolsByName().ollama_query, { prompt: "hi", model: "not-pulled" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("404");
  });

  it("sets an abort signal so a wedged model cannot hang the turn", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ response: "ok" }));
    await call(toolsByName().ollama_query, { prompt: "hi" });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeDefined();
  });
});

describe("ollama_list_models", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("GETs /api/tags and returns the summary as JSON", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ models: [{ name: "bge-large", size: 670_000_000, details: { family: "bert" } }] }),
    );
    const res = await call(toolsByName().ollama_list_models);

    expect(fetchMock.mock.calls[0][0]).toBe("http://ollama.test:11434/api/tags");
    expect(JSON.parse(res.content[0].text)[0].name).toBe("bge-large");
  });

  it("says so plainly when no models are pulled", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [] }));
    const res = await call(toolsByName().ollama_list_models);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("No models are pulled");
  });

  it("reports daemon-down as a tool error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await call(toolsByName().ollama_list_models);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("ECONNREFUSED");
  });
});
