import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexSubscriptionAdapter,
  consumeBufferedSseEvents,
  consumeCodexSse,
} from "./codex-subscription-adapter.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import { buildPilotInstructions } from "./turn-assembly.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";

function makeAdapter(
  overrides: Partial<ConstructorParameters<typeof CodexSubscriptionAdapter>[0]> = {},
  fetchMock = vi.fn<typeof fetch>(),
) {
  const dir = mkdtempSync(join(tmpdir(), "hive-codex-subscription-auth-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: makeJwt({ exp: 60 * 60 }) } }));

  const adapter = new CodexSubscriptionAdapter({
    name: "Pilot",
    assembly: makeAssembly(),
    model: "gpt-5.4-mini",
    endpoint: "https://chatgpt.test/backend-api/codex/responses",
    codexAuthPath: authPath,
    fetch: fetchMock,
    ...overrides,
  });

  return {
    adapter,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    fetchMock,
  };
}

function makeAssembly(overrides: Partial<ProviderTurnAssembly> = {}): ProviderTurnAssembly {
  return {
    instructions: "Be useful.",
    toolInventory: [],
    omittedTools: [],
    guardrailGate: async () => ({ behavior: "allow" }),
    memory: {},
    skillIndex: [],
    inProcessServers: {},
    sessionCwd: tmpdir(),
    ...overrides,
  };
}

function makeInventoryEntry(name = "memory"): HiveToolInventoryEntry {
  return {
    name,
    transport: "sdk-in-process",
    source: "core",
    requiresTurnContext: false,
    requiresHiveRuntime: true,
    inProcess: true,
    compatibility: {
      claude: "direct",
      openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge",
      codex: "requires-hive-bridge",
    },
    schemas: { kind: "connect-time" },
  };
}

describe("CodexSubscriptionAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the Codex provider id", () => {
    const { adapter, cleanup } = makeAdapter();
    try {
      expect(adapter.provider).toBe("codex");
    } finally {
      cleanup();
    }
  });

  it("sends a streaming Codex subscription request and maps SSE output", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        sse([
          {
            event: "response.created",
            data: {
              type: "response.created",
              response: { id: "resp-created" },
            },
          },
          { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "hel" } },
          { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "lo" } },
          {
            event: "response.completed",
            data: {
              type: "response.completed",
              response: {
                id: "resp-complete",
                usage: {
                  input_tokens: 11,
                  output_tokens: 3,
                  input_tokens_details: { cached_tokens: 5 },
                },
              },
            },
          },
        ]),
        { status: 200 },
      ),
    );
    const { adapter, cleanup } = makeAdapter({}, fetchMock);

    try {
      const onStream = vi.fn();
      const result = await adapter.runTurn({
        prompt: "say hello",
        sessionId: "resp-prev",
        systemPromptOverride: "voice prompt",
        onStream,
      });

      expect(fetchMock).toHaveBeenCalledWith("https://chatgpt.test/backend-api/codex/responses", {
        method: "POST",
        signal: expect.any(AbortSignal),
        headers: {
          authorization: expect.stringMatching(/^Bearer /),
          "content-type": "application/json",
          accept: "text/event-stream",
          "openai-beta": "responses=v1",
        },
        body: expect.any(String),
      });
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
        model: "gpt-5.4-mini",
        instructions: "voice prompt",
        input: [{ role: "user", content: [{ type: "input_text", text: "say hello" }] }],
        stream: true,
        store: false,
        tools: [],
      });
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).not.toHaveProperty(
        "previous_response_id",
      );
      expect(onStream).toHaveBeenNthCalledWith(1, "hel");
      expect(onStream).toHaveBeenNthCalledWith(2, "lo");
      expect(result).toMatchObject({
        text: "hello",
        sessionId: "resp-complete",
        streamed: true,
        inputTokens: 11,
        outputTokens: 3,
        cacheReadTokens: 5,
        aborted: false,
      });
    } finally {
      cleanup();
    }
  });

  // KPR-338 D3: modelOverride deleted from AgentProviderTurnRequest — nothing left to ignore

  it("sends reasoning effort when configured", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse([{ event: "response.output_text.done", data: { text: "done" } }])));
    const { adapter, cleanup } = makeAdapter({ reasoningEffort: "medium" }, fetchMock);

    try {
      await adapter.runTurn({ prompt: "think" });

      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
        reasoning: { effort: "medium" },
      });
    } finally {
      cleanup();
    }
  });

  it("collects streaming output even when the caller did not request onStream", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse([{ event: "response.output_text.done", data: { text: "done" } }])));
    const { adapter, cleanup } = makeAdapter({}, fetchMock);

    try {
      await expect(adapter.runTurn({ prompt: "non-stream caller" })).resolves.toMatchObject({
        text: "done",
        streamed: false,
        aborted: false,
      });
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).stream).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("maps HTTP errors into RunResult errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Stream must be set to true" }), { status: 400 }));
    const { adapter, cleanup } = makeAdapter({}, fetchMock);

    try {
      await expect(adapter.runTurn({ prompt: "fail", sessionId: "existing" })).resolves.toMatchObject({
        text: "",
        sessionId: "existing",
        aborted: false,
        error: "Codex subscription request failed (400): Stream must be set to true",
      });
    } finally {
      cleanup();
    }
  });

  it("maps response.failed SSE events into RunResult errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        sse([
          {
            event: "response.failed",
            data: {
              type: "response.failed",
              response: { error: { message: "model unavailable" } },
            },
          },
        ]),
      ),
    );
    const { adapter, cleanup } = makeAdapter({}, fetchMock);

    try {
      await expect(adapter.runTurn({ prompt: "fail" })).resolves.toMatchObject({
        text: "",
        aborted: false,
        error: "model unavailable",
      });
    } finally {
      cleanup();
    }
  });

  it("maps abort rejection to an aborted RunResult", async () => {
    let rejectFetch: ((error: unknown) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        rejectFetch = reject;
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }) as Promise<Response>;
    });
    const { adapter, cleanup } = makeAdapter({}, fetchMock);

    try {
      const promise = adapter.runTurn({ prompt: "stop", sessionId: "existing" });
      while (fetchMock.mock.calls.length === 0) {
        await Promise.resolve();
      }
      adapter.abort();
      rejectFetch?.(Object.assign(new Error("aborted"), { name: "AbortError" }));
      await expect(promise).resolves.toMatchObject({
        text: "",
        sessionId: "existing",
        aborted: true,
      });
      expect(adapter.wasAborted).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("KPR-347 T1: construction + runTurn with a non-empty bridgeable inventory resolves and posts tools: []", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse([{ event: "response.output_text.done", data: { text: "done" } }])));
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly({ toolInventory: [makeInventoryEntry()] }) },
      fetchMock,
    );

    try {
      await expect(adapter.runTurn({ prompt: "hello" })).resolves.toMatchObject({
        text: "done",
        aborted: false,
      });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.tools).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("KPR-347 T1: instructions are byte-identical to buildPilotInstructions output", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse([{ event: "response.output_text.done", data: { text: "done" } }])));
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly({ instructions: buildPilotInstructions("Pilot", "soul", "system") }) },
      fetchMock,
    );

    try {
      await adapter.runTurn({ prompt: "hello" });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.instructions).toBe("soul\n\nsystem");
    } finally {
      cleanup();
    }
  });
});

describe("consumeCodexSse", () => {
  it("handles split events and output_text.done dedupe", async () => {
    const onStream = vi.fn();
    const result = await consumeCodexSse(
      streamFromChunks([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"he"}\n',
        '\nevent: response.output_text.done\ndata: {"type":"response.output_text.done","text":"hello"}\n\n',
      ]),
      onStream,
    );

    expect(result.text).toBe("hello");
    expect(onStream).toHaveBeenNthCalledWith(1, "he");
    expect(onStream).toHaveBeenNthCalledWith(2, "llo");
  });

  it("returns incomplete buffered SSE frames", () => {
    const state = { text: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const remainder = consumeBufferedSseEvents(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there"}',
      state,
    );

    expect(state.text).toBe("hi");
    expect(remainder).toContain(" there");
  });
});

function sse(events: { event: string; data: unknown }[]): ReadableStream<Uint8Array> {
  return streamFromChunks(
    events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
  );
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function makeJwt(payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(
    JSON.stringify({
      aud: ["https://api.openai.com/v1"],
      ...payload,
      exp: now + Number(payload.exp ?? 60 * 60),
    }),
  ).toString("base64url");
  return `header.${encoded}.signature`;
}
