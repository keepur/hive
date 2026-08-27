import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  GrokGatewayAdapter,
  DEFAULT_GROK_GATEWAY_URL,
  DEFAULT_GROK_MODEL,
  __resetGrokCoercionWarnedForTests,
} from "./grok-gateway-adapter.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import { ToolBridge } from "./tool-bridge.js";
import type { TurnHistoryStore } from "../turn-history-store.js";

// The adapter (and the real ToolBridge it drives) log — the §4.5 warn-once is
// assertable via this shared (hoisted) mock, cleared per test by beforeEach.
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../logging/logger.js", () => ({
  createLogger: () => logMock,
}));

// --- Fixture helpers (replicated from codex-subscription-adapter.test.ts /
// gemini-interactions-adapter.test.ts — deliberately NOT cross-imported) ----

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

function makeAdapter(
  overrides: Partial<ConstructorParameters<typeof GrokGatewayAdapter>[0]> = {},
  fetchMock = vi.fn<typeof fetch>(),
) {
  const adapter = new GrokGatewayAdapter({
    name: "Grok",
    assembly: makeAssembly(),
    model: "grok-4.6",
    apiKey: "test-key",
    baseUrl: "https://grok-gateway.test",
    fetch: fetchMock,
    ...overrides,
  });
  return { adapter, fetchMock };
}

/** Real in-process McpServer fixture wrapped as the SDK config shape. */
function makeInProcessServer(register: (server: McpServer) => void): McpSdkServerConfigWithInstance {
  const server = new McpServer({ name: "fixture", version: "1.0.0" });
  register(server);
  return { type: "sdk", name: "fixture", instance: server };
}

/** An sdk-in-process inventory entry whose name matches an inProcessServers key. */
function makeInProcEntry(name = "fixture"): HiveToolInventoryEntry {
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
      grok: "requires-hive-bridge",
    },
    schemas: { kind: "connect-time" },
  };
}

/** An echo in-process server registered under name "fixture"; optional
 *  onCall recorder for dedup/order assertions — real ToolBridge dispatch
 *  over InMemoryTransport (mirrors the gemini test's echo shape). */
function makeEchoServer(onCall?: (text: string) => void): McpSdkServerConfigWithInstance {
  return makeInProcessServer((s) =>
    s.registerTool("echo", { description: "echo", inputSchema: { text: z.string() } }, async ({ text }) => {
      onCall?.(text);
      return { content: [{ type: "text", text: `echo:${text}` }] };
    }),
  );
}

/** Assembly wired to the echo fixture (real bridge dispatch). */
function echoAssembly(onCall?: (text: string) => void): Partial<ProviderTurnAssembly> {
  return {
    toolInventory: [makeInProcEntry()],
    inProcessServers: { fixture: makeEchoServer(onCall) },
  };
}

const ECHO = "mcp__fixture__echo";

/** Fake TurnHistoryStore with spyable load/append/clear. */
function makeFakeStore(loadItems: unknown[] = []) {
  return {
    load: vi.fn(async () => loadItems),
    append: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  } as unknown as TurnHistoryStore & {
    load: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
}

/** A WorkItemContext carrying just the threadId the history key needs. */
const threadContext = (threadId: string) => ({ threadId }) as never;

// --- Chat-completions SSE chunk fixtures ------------------------------------

const textChunk = (id: string, text: string) => ({
  id,
  choices: [{ index: 0, delta: { content: text } }],
});
const finishChunk = (id: string, finishReason = "stop", usage?: Record<string, unknown>) => ({
  id,
  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
});
const toolCallDeltaChunk = (
  id: string,
  fragments: { index: number; toolCallId?: string; name?: string; arguments?: string }[],
) => ({
  id,
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: fragments.map((f) => ({
          index: f.index,
          id: f.toolCallId,
          function: { name: f.name, arguments: f.arguments },
        })),
      },
    },
  ],
});
const errorChunk = (code: number, message: string) => ({ error: { code, message } });

/** One mocked Response per round, each built from a chat.completion.chunk list. */
function sseScript(...rounds: unknown[][]): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>();
  for (const round of rounds) mock.mockResolvedValueOnce(new Response(sse(round)));
  return mock;
}

function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"];
  return streamFromChunks(lines);
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** Read a fetchMock call's JSON body. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, callIndex: number): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[callIndex][1] as RequestInit).body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetGrokCoercionWarnedForTests();
});

// -----------------------------------------------------------------------------

describe("GrokGatewayAdapter identity", () => {
  it("exposes the grok provider id and reflects abort()", () => {
    const { adapter } = makeAdapter();
    expect(adapter.provider).toBe("grok");
    expect(adapter.wasAborted).toBe(false);
    adapter.abort();
    expect(adapter.wasAborted).toBe(true);
  });
});

describe("GrokGatewayAdapter — request body", () => {
  it("POSTs the full chat-completions shape: endpoint, auth header, model, stream flags", async () => {
    const fetchMock = sseScript([textChunk("cmpl-1", "hi"), finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({}, fetchMock);

    const result = await adapter.runTurn({ prompt: "say hi" });

    expect(fetchMock).toHaveBeenCalledWith("https://grok-gateway.test/v1/chat/completions", {
      method: "POST",
      signal: expect.any(AbortSignal),
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: expect.any(String),
    });
    expect(bodyOf(fetchMock, 0)).toMatchObject({
      model: "grok-4.6",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(result.text).toBe("hi");
    expect(result.aborted).toBe(false);
  });

  it("defaults the model to DEFAULT_GROK_MODEL when unset", async () => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({ model: undefined }, fetchMock);
    await adapter.runTurn({ prompt: "go" });
    expect(bodyOf(fetchMock, 0).model).toBe(DEFAULT_GROK_MODEL);
  });

  it("defaults the endpoint to DEFAULT_GROK_GATEWAY_URL when baseUrl is unset", async () => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({ baseUrl: undefined }, fetchMock);
    await adapter.runTurn({ prompt: "go" });
    expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_GROK_GATEWAY_URL}/v1/chat/completions`, expect.anything());
  });

  it("messages = [system(instructions), ...replayed, user(prompt)] — replayed items sit between system and user", async () => {
    const prevA = { role: "user", content: "earlier" };
    const prevB = { role: "assistant", content: "earlier reply" };
    const store = makeFakeStore([prevA, prevB]);
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({ historyStore: store, agentId: "agent-x" }, fetchMock);

    await adapter.runTurn({ prompt: "now", workItemContext: threadContext("sms:t1") });

    expect(bodyOf(fetchMock, 0).messages).toEqual([
      { role: "system", content: "Be useful." },
      prevA,
      prevB,
      { role: "user", content: "now" },
    ]);
  });

  it("systemPromptOverride replaces the assembly instructions when set", async () => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({}, fetchMock);
    await adapter.runTurn({ prompt: "hello", systemPromptOverride: "voice prompt" });
    expect((bodyOf(fetchMock, 0).messages as Array<{ role: string; content: string }>)[0]).toEqual({
      role: "system",
      content: "voice prompt",
    });
  });

  it("tools carry the chat function shape when the bridge yields entries", async () => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);
    await adapter.runTurn({ prompt: "go" });
    expect(bodyOf(fetchMock, 0).tools).toEqual([
      {
        type: "function",
        function: expect.objectContaining({ name: ECHO, description: "echo" }),
      },
    ]);
  });

  it("tools key is omitted entirely when the bridge yields none", async () => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({}, fetchMock);
    await adapter.runTurn({ prompt: "go" });
    expect(bodyOf(fetchMock, 0)).not.toHaveProperty("tools");
  });
});

describe("GrokGatewayAdapter — effort mapping (§4.5)", () => {
  it("xhigh delivers verbatim as reasoning_effort", async () => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({ reasoningEffort: "xhigh" }, fetchMock);
    await adapter.runTurn({ prompt: "go" });
    expect(bodyOf(fetchMock, 0).reasoning_effort).toBe("xhigh");
  });

  it.each(["high", "medium", "low"] as const)("%s delivers verbatim as reasoning_effort", async (effort) => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({ reasoningEffort: effort }, fetchMock);
    await adapter.runTurn({ prompt: "go" });
    expect(bodyOf(fetchMock, 0).reasoning_effort).toBe(effort);
  });

  it("no :effort suffix ⇒ no reasoning_effort key in the body", async () => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({ reasoningEffort: undefined }, fetchMock);
    await adapter.runTurn({ prompt: "go" });
    expect(bodyOf(fetchMock, 0)).not.toHaveProperty("reasoning_effort");
  });

  it.each(["minimal", "none"] as const)("%s coerces to low", async (effort) => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({ reasoningEffort: effort }, fetchMock);
    await adapter.runTurn({ prompt: "go" });
    expect(bodyOf(fetchMock, 0).reasoning_effort).toBe("low");
  });

  it("warns exactly once across two turns of the same adapter name (process-wide warn-once); a different agent name warns again", async () => {
    const fetchMock1 = sseScript([finishChunk("cmpl-1")]);
    const { adapter: sameNameTurn1 } = makeAdapter({ name: "Grok1", reasoningEffort: "none" }, fetchMock1);
    await sameNameTurn1.runTurn({ prompt: "go" });

    const fetchMock2 = sseScript([finishChunk("cmpl-2")]);
    const { adapter: sameNameTurn2 } = makeAdapter({ name: "Grok1", reasoningEffort: "none" }, fetchMock2);
    await sameNameTurn2.runTurn({ prompt: "go again" });

    const coercionWarns = () =>
      logMock.warn.mock.calls.filter((c) => String(c[0]).includes("coerced to low"));
    expect(coercionWarns()).toHaveLength(1);

    const fetchMock3 = sseScript([finishChunk("cmpl-3")]);
    const { adapter: otherName } = makeAdapter({ name: "Grok2", reasoningEffort: "none" }, fetchMock3);
    await otherName.runTurn({ prompt: "go" });

    expect(coercionWarns()).toHaveLength(2);
  });
});

describe("GrokGatewayAdapter — chunk application", () => {
  it("text deltas accumulate and stream through onStream; final round id captured as sessionId", async () => {
    const fetchMock = sseScript([textChunk("cmpl-x", "hel"), textChunk("cmpl-x", "lo"), finishChunk("cmpl-x")]);
    const { adapter } = makeAdapter({}, fetchMock);
    const onStream = vi.fn();

    const result = await adapter.runTurn({ prompt: "go", onStream });

    expect(onStream).toHaveBeenNthCalledWith(1, "hel");
    expect(onStream).toHaveBeenNthCalledWith(2, "lo");
    expect(result.text).toBe("hello");
    expect(result.sessionId).toBe("cmpl-x");
    expect(result.streamed).toBe(true);
  });

  it("final usage chunk sets token counts by assignment — a duplicated usage chunk does not double", async () => {
    const fetchMock = sseScript([
      { id: "cmpl-1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      finishChunk("cmpl-1", "stop", { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } }),
    ]);
    const { adapter } = makeAdapter({}, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(3);
    expect(result.cacheReadTokens).toBe(4);
  });

  it("absent usage ⇒ zeros (edge 4)", async () => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({}, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
  });

  it("fragmented tool_calls across chunks (id/name once, arguments split across 3 chunks) assemble into one call", async () => {
    const onCall = vi.fn();
    const fetchMock = sseScript(
      [
        toolCallDeltaChunk("cmpl-1", [{ index: 0, toolCallId: "call_1", name: ECHO }]),
        toolCallDeltaChunk("cmpl-1", [{ index: 0, arguments: '{"te' }]),
        toolCallDeltaChunk("cmpl-1", [{ index: 0, arguments: 'xt":"hi"}' }]),
        finishChunk("cmpl-1", "tool_calls"),
      ],
      [finishChunk("cmpl-2")],
    );
    const { adapter } = makeAdapter({ assembly: makeAssembly(echoAssembly(onCall)) }, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    expect(onCall).toHaveBeenCalledWith("hi");
    expect(result.error).toBeUndefined();
    const round1Assistant = (bodyOf(fetchMock, 1).messages as Array<Record<string, unknown>>)[2];
    expect(round1Assistant.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: ECHO, arguments: '{"text":"hi"}' } },
    ]);
  });

  it("two interleaved indices assemble in index order regardless of chunk arrival order", async () => {
    const fetchMock = sseScript(
      [
        toolCallDeltaChunk("cmpl-1", [{ index: 1, toolCallId: "call_B", name: "toolB", arguments: "{}" }]),
        toolCallDeltaChunk("cmpl-1", [{ index: 0, toolCallId: "call_A", name: "toolA", arguments: "{}" }]),
        finishChunk("cmpl-1", "tool_calls"),
      ],
      [finishChunk("cmpl-2")],
    );
    const { adapter } = makeAdapter({}, fetchMock);

    await adapter.runTurn({ prompt: "go" });

    const round1Assistant = (bodyOf(fetchMock, 1).messages as Array<{ tool_calls?: Array<{ id: string }> }>)[2];
    expect(round1Assistant.tool_calls?.map((c) => c.id)).toEqual(["call_A", "call_B"]);
  });
});

describe("GrokGatewayAdapter — tool round-trip", () => {
  it("round 1 emits a tool call → executeCall runs it → round-2 body carries the assistant tool_calls message and the role:tool result", async () => {
    const fetchMock = sseScript(
      [
        toolCallDeltaChunk("cmpl-1", [{ index: 0, toolCallId: "call_1", name: ECHO, arguments: '{"text":"hi"}' }]),
        finishChunk("cmpl-1", "tool_calls"),
      ],
      [textChunk("cmpl-2", "done"), finishChunk("cmpl-2")],
    );
    const { adapter } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const messages = bodyOf(fetchMock, 1).messages as Array<Record<string, unknown>>;
    expect(messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: ECHO, arguments: '{"text":"hi"}' } }],
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "echo:hi" });
    expect(result.text).toBe("done");
    expect(result.toolCalls).toBe(1);
  });

  // KPR-407 (finding 2): this used to pin an accepted asymmetry — the
  // assistant message carried BOTH duplicate tool_calls while only ONE
  // role:"tool" result answered them, an invalid chat-completions shape the
  // vendor 400s. Dedup moved into assembleToolCalls, so the assistant message
  // and the tool results now derive from one deduped list: exactly one
  // tool_call, first-wins ("hi", the lowest fragment index), one tool result.
  it("duplicate call id (two fragments, same id, different indices) → ONE tool_call in the assistant message and ONE tool result (first-wins)", async () => {
    const onCall = vi.fn();
    const fetchMock = sseScript(
      [
        toolCallDeltaChunk("cmpl-1", [
          { index: 0, toolCallId: "call_dup", name: ECHO, arguments: '{"text":"hi"}' },
          { index: 1, toolCallId: "call_dup", name: ECHO, arguments: '{"text":"bye"}' },
        ]),
        finishChunk("cmpl-1", "tool_calls"),
      ],
      [finishChunk("cmpl-2")],
    );
    const { adapter } = makeAdapter({ assembly: makeAssembly(echoAssembly(onCall)) }, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onCall).toHaveBeenCalledWith("hi");
    const messages = bodyOf(fetchMock, 1).messages as Array<Record<string, unknown>>;
    // The assistant message carries ONE tool_call — the first fragment wins.
    const assistant = messages[2] as { tool_calls?: Array<{ id: string; function: { arguments: string } }> };
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls?.[0]?.id).toBe("call_dup");
    expect(assistant.tool_calls?.[0]?.function.arguments).toBe('{"text":"hi"}');
    const toolMessages = (messages as Array<{ role: string }>).filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toEqual({ role: "tool", tool_call_id: "call_dup", content: "echo:hi" });
    expect(result.toolCalls).toBe(1);
  });

  it("hallucinated tool name → structured 'unknown tool' output text, never a throw", async () => {
    const fetchMock = sseScript(
      [
        toolCallDeltaChunk("cmpl-1", [{ index: 0, toolCallId: "call_x", name: "not_a_tool", arguments: "{}" }]),
        finishChunk("cmpl-1", "tool_calls"),
      ],
      [finishChunk("cmpl-2")],
    );
    const { adapter } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    const toolMessage = (bodyOf(fetchMock, 1).messages as Array<{ role: string; content?: string }>).find(
      (m) => m.role === "tool",
    );
    expect(toolMessage?.content).toBe("Tool execution failed (not_a_tool): unknown tool");
    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalid-JSON arguments → structured 'not valid JSON' output text, never a throw", async () => {
    const fetchMock = sseScript(
      [
        toolCallDeltaChunk("cmpl-1", [{ index: 0, toolCallId: "call_y", name: ECHO, arguments: "{nope" }]),
        finishChunk("cmpl-1", "tool_calls"),
      ],
      [finishChunk("cmpl-2")],
    );
    const { adapter } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    const toolMessage = (bodyOf(fetchMock, 1).messages as Array<{ role: string; content?: string }>).find(
      (m) => m.role === "tool",
    );
    expect(toolMessage?.content).toContain("arguments were not valid JSON");
    expect(result.error).toBeUndefined();
  });
});

describe("GrokGatewayAdapter — multi-round sessionId (advisory 2)", () => {
  it("two rounds with completion ids cmpl-1/cmpl-2 → success sessionId is the LAST round's id", async () => {
    const fetchMock = sseScript(
      [
        toolCallDeltaChunk("cmpl-1", [{ index: 0, toolCallId: "call_1", name: ECHO, arguments: '{"text":"hi"}' }]),
        finishChunk("cmpl-1", "tool_calls"),
      ],
      [textChunk("cmpl-2", "done"), finishChunk("cmpl-2")],
    );
    const { adapter } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.sessionId).toBe("cmpl-2");
  });
});

describe("GrokGatewayAdapter — C5 error decoration (§4.4)", () => {
  it("non-2xx response → 'Grok gateway request failed (503): ...' (status present, classifiable)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503 }));
    const store = makeFakeStore();
    const { adapter } = makeAdapter({ historyStore: store, agentId: "agent-x" }, fetchMock);

    const result = await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });

    expect(result.error).toBe("Grok gateway request failed (503): upstream unavailable");
    expect(store.append).not.toHaveBeenCalled();
  });

  it("in-stream error payload with `code` → 'Grok gateway stream failed (429): ...'", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(sse([errorChunk(429, "rate limited")])));
    const { adapter } = makeAdapter({}, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.error).toBe("Grok gateway stream failed (429): rate limited");
  });

  it("stream ending with no finish_reason → error containing 'terminated', never a success with empty text", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(sse([textChunk("cmpl-1", "partial")])));
    const { adapter } = makeAdapter({}, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.error).toContain("terminated");
    expect(result.text).toBe("");
  });

  it("finish_reason:tool_calls with zero assembled tool calls → error containing 'terminated', never a silent empty harvest", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse([finishChunk("cmpl-1", "tool_calls")])));
    const { adapter } = makeAdapter({}, fetchMock);

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.error).toContain("connection terminated mid-stream");
    expect(result.text).toBe("");
  });
});

describe("GrokGatewayAdapter — history policy (§4.2)", () => {
  it("success appends exactly [user, assistant, tool, assistant] under provider 'grok' — system never stored", async () => {
    const store = makeFakeStore();
    const fetchMock = sseScript(
      [
        toolCallDeltaChunk("cmpl-1", [{ index: 0, toolCallId: "call_1", name: ECHO, arguments: '{"text":"hi"}' }]),
        finishChunk("cmpl-1", "tool_calls"),
      ],
      [textChunk("cmpl-2", "done"), finishChunk("cmpl-2")],
    );
    const { adapter } = makeAdapter(
      { assembly: makeAssembly(echoAssembly()), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );

    await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });

    expect(store.append).toHaveBeenCalledTimes(1);
    const [agentId, threadId, provider, items] = store.append.mock.calls[0];
    expect(agentId).toBe("agent-x");
    expect(threadId).toBe("sms:t1");
    expect(provider).toBe("grok");
    expect(items).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: ECHO, arguments: '{"text":"hi"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "echo:hi" },
      { role: "assistant", content: "done" },
    ]);
    expect(JSON.stringify(items)).not.toContain('"role":"system"');
  });

  it("load rejection degrades to empty replay — turn still succeeds", async () => {
    const store = makeFakeStore();
    store.load.mockRejectedValueOnce(new Error("mongo down"));
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({ historyStore: store, agentId: "agent-x" }, fetchMock);

    const result = await adapter.runTurn({ prompt: "now", workItemContext: threadContext("sms:t1") });

    expect(result.error).toBeUndefined();
    expect(bodyOf(fetchMock, 0).messages).toEqual([
      { role: "system", content: "Be useful." },
      { role: "user", content: "now" },
    ]);
  });

  it("no historyStore/agentId/threadId ⇒ no store calls", async () => {
    const store = makeFakeStore();
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    // store present, agentId present, but no workItemContext ⇒ historyKey undefined.
    const { adapter } = makeAdapter({ historyStore: store }, fetchMock);

    await adapter.runTurn({ prompt: "solo" });

    expect(store.load).not.toHaveBeenCalled();
    expect(store.append).not.toHaveBeenCalled();
  });

  it("deadline turn appends nothing", async () => {
    const store = makeFakeStore();
    const hangingFetch = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit).signal as AbortSignal;
          const abortErr = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (signal.aborted) return abortErr();
          signal.addEventListener("abort", abortErr, { once: true });
        }),
    );
    const { adapter } = makeAdapter({ historyStore: store, agentId: "agent-x" }, hangingFetch);

    const result = await adapter.runTurn({
      prompt: "go",
      workItemContext: threadContext("sms:t1"),
      resourceLimits: { timeoutMs: 25, maxTurns: 10, budgetUsd: 0 },
    });

    expect(result.error).toBe("error_turn_deadline");
    expect(result.timedOut).toBe(true);
    expect(store.append).not.toHaveBeenCalled();
  });

  it("abort turn appends nothing", async () => {
    const store = makeFakeStore();
    const ref: { current?: GrokGatewayAdapter } = {};
    const inproc = makeInProcessServer((s) =>
      s.registerTool("echo", { description: "", inputSchema: { text: z.string() } }, async ({ text }) => {
        ref.current?.abort();
        return { content: [{ type: "text", text: `echo:${text}` }] };
      }),
    );
    const fetchMock = sseScript(
      [
        toolCallDeltaChunk("cmpl-1", [{ index: 0, toolCallId: "call_1", name: ECHO, arguments: '{"text":"hi"}' }]),
        finishChunk("cmpl-1", "tool_calls"),
      ],
      [finishChunk("cmpl-2")],
    );
    const { adapter } = makeAdapter(
      {
        assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }),
        historyStore: store,
        agentId: "agent-x",
      },
      fetchMock,
    );
    ref.current = adapter;

    const result = await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });

    expect(result.aborted).toBe(true);
    expect(store.append).not.toHaveBeenCalled();
  });
});

describe("GrokGatewayAdapter — session policy (stateless transport)", () => {
  it("request.sessionId never appears in the request body", async () => {
    const fetchMock = sseScript([finishChunk("cmpl-1")]);
    const { adapter } = makeAdapter({}, fetchMock);

    await adapter.runTurn({ prompt: "go", sessionId: "existing-session" });

    expect(JSON.stringify(bodyOf(fetchMock, 0))).not.toContain("existing-session");
  });

  it("catch-error result sessionId === request.sessionId ?? '' — no fabrication", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }));
    const { adapter } = makeAdapter({}, fetchMock);

    const withSession = await adapter.runTurn({ prompt: "go", sessionId: "existing-session" });
    expect(withSession.sessionId).toBe("existing-session");

    const fetchMock2 = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }));
    const { adapter: adapter2 } = makeAdapter({}, fetchMock2);
    const withoutSession = await adapter2.runTurn({ prompt: "go" });
    expect(withoutSession.sessionId).toBe("");
  });
});

describe("GrokGatewayAdapter — missing key (bare construction)", () => {
  it("no apiKey ⇒ error result naming GROK_GATEWAY_KEY; bridge.close still called (scaffold finally)", async () => {
    const closeSpy = vi.spyOn(ToolBridge.prototype, "close");
    try {
      const fetchMock = vi.fn<typeof fetch>();
      const { adapter } = makeAdapter({ apiKey: undefined }, fetchMock);

      const result = await adapter.runTurn({ prompt: "go" });

      expect(result.error).toContain("Grok gateway API key is not available");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });
});

describe("GrokGatewayAdapter — maxTurns 0", () => {
  it("maxTurns: 0 ⇒ error_max_turns with zero fetch calls (loop-owned)", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { adapter } = makeAdapter({}, fetchMock);

    const result = await adapter.runTurn({
      prompt: "go",
      resourceLimits: { timeoutMs: 60_000, maxTurns: 0, budgetUsd: 1 },
    });

    expect(result.error).toBe("error_max_turns");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
