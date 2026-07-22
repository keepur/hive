import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "mongodb";
import {
  CodexSubscriptionAdapter,
  consumeBufferedSseEvents,
  consumeCodexSse,
} from "./codex-subscription-adapter.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import { ToolBridge } from "./tool-bridge.js";
import { BUILTIN_TOOL_DEFINITIONS } from "./builtin-executor.js";
import { classifyTurnResult } from "./error-classification.js";
import { TurnHistoryStore } from "../turn-history-store.js";

// The adapter (and the real TurnHistoryStore / ToolBridge it drives) now log.
vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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

// --- KPR-353 Task 3 fixtures (replicated from openai-agents-adapter.test.ts:105-152) ---

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
    },
    schemas: { kind: "connect-time" },
  };
}

/** A claude-builtin inventory entry carrying one static builtin tool def by name. */
function makeBuiltinEntry(toolName: string): HiveToolInventoryEntry {
  const def = BUILTIN_TOOL_DEFINITIONS.find((d) => d.name === toolName)!;
  return {
    name: toolName,
    transport: "claude-builtin",
    source: "core",
    requiresTurnContext: false,
    requiresHiveRuntime: false,
    inProcess: false,
    compatibility: {
      claude: "direct",
      openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge",
      codex: "requires-hive-bridge",
    },
    schemas: { kind: "static", tools: [def] },
  };
}

/** An echo in-process server registered under name "fixture" — real ToolBridge
 *  dispatch over InMemoryTransport (mirrors the openai test's echo shape). */
function makeEchoServer(delayMs = 0): McpSdkServerConfigWithInstance {
  return makeInProcessServer((s) =>
    s.registerTool("echo", { description: "echo", inputSchema: { text: z.string() } }, async ({ text }) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { content: [{ type: "text", text: `echo:${text}` }] };
    }),
  );
}

/** Assembly wired to the echo fixture (real bridge dispatch). */
function echoAssembly(overrides: Partial<ProviderTurnAssembly> = {}, delayMs = 0): Partial<ProviderTurnAssembly> {
  return {
    toolInventory: [makeInProcEntry()],
    inProcessServers: { fixture: makeEchoServer(delayMs) },
    ...overrides,
  };
}

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
const threadContext = (threadId: string) => ({ threadId } as never);

/** A Db whose findOne/updateOne/deleteMany reject connect-fail; createIndex
 *  resolves so init() succeeds (Task 1 fake-collection pattern). */
function makeFailingDb(): Db {
  const reject = () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:27017"));
  const collection = vi.fn().mockReturnValue({
    findOne: vi.fn(reject),
    updateOne: vi.fn(reject),
    deleteMany: vi.fn(reject),
    createIndex: vi.fn().mockResolvedValue("ix"),
  });
  return { collection } as unknown as Db;
}

const reasoningItem = { type: "reasoning", id: "rs_1", encrypted_content: "ENC-OPAQUE-1", summary: [] };
const callItem = (name: string, args = "{}") => ({
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name,
  arguments: args,
  status: "completed",
});
const completed = (output: unknown[], usage?: Record<string, unknown>) => ({
  event: "response.completed",
  data: { type: "response.completed", response: { id: "resp_x", output, ...(usage ? { usage } : {}) } },
});

/** One mocked Response per round, each built with sse(). */
function sseScript(...rounds: { event: string; data: unknown }[][]): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>();
  for (const round of rounds) mock.mockResolvedValueOnce(new Response(sse(round)));
  return mock;
}

/** Read a fetchMock call's JSON body. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, callIndex: number): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[callIndex][1] as RequestInit).body as string);
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

  it("KPR-353 T1: bridged inventory is advertised as Responses function tools (inverts the 347 tools:[] pin)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(sse([completed([{ type: "message", role: "assistant", content: [] }])])),
    );
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly({ toolInventory: [makeBuiltinEntry("Read"), makeBuiltinEntry("Bash")] }) },
      fetchMock,
    );
    try {
      await expect(adapter.runTurn({ prompt: "hello" })).resolves.toMatchObject({ aborted: false });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.tools).toEqual([
        expect.objectContaining({ type: "function", name: "Read", strict: false }),
        expect.objectContaining({ type: "function", name: "Bash", strict: false }),
      ]);
      expect(body.tools[0].parameters).toMatchObject({ type: "object" });
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
    } finally {
      cleanup();
    }
  });

  it("KPR-353 T1: empty inventory still posts tools: [] (tool-less agent body shape stays honest)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(sse([{ event: "response.output_text.done", data: { text: "done" } }])),
    );
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly({ toolInventory: [] }) }, fetchMock);
    try {
      await expect(adapter.runTurn({ prompt: "hello" })).resolves.toMatchObject({ text: "done", aborted: false });
      expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).tools).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("KPR-347 T1: adapter forwards assembly instructions verbatim to the provider SDK", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(sse([{ event: "response.output_text.done", data: { text: "done" } }])));
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly({ instructions: "soul\n\nsystem" }) },
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

describe("CodexSubscriptionAdapter — KPR-353 T2 (hive-owned dispatch loop)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("single round, no calls → text delivered, one fetch, toolCalls 0, summary none", async () => {
    const fetchMock = sseScript([
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "hi" } },
      completed([{ type: "message", role: "assistant", content: [] }]),
    ]);
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);
    try {
      const result = await adapter.runTurn({ prompt: "go" });
      expect(result.text).toBe("hi");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.toolCalls).toBe(0);
      expect(result.toolSummary).toBe("none");
    } finally {
      cleanup();
    }
  });

  it("two rounds: reasoning + call → dispatch → round-2 input = [user, reasoning, call, function_call_output]; final text is round-2 only", async () => {
    const fetchMock = sseScript(
      [completed([reasoningItem, callItem("mcp__fixture__echo", '{"text":"hi"}')])],
      [
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "done" } },
        completed([{ type: "message", role: "assistant", content: [] }]),
      ],
    );
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);
    try {
      const result = await adapter.runTurn({ prompt: "go" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodyOf(fetchMock, 1).input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        reasoningItem,
        callItem("mcp__fixture__echo", '{"text":"hi"}'),
        { type: "function_call_output", call_id: "call_1", output: "echo:hi" },
      ]);
      expect(result.text).toBe("done");
      expect(result.toolCalls).toBe(1);
      expect(result.toolSummary).toContain("mcp__fixture__echo×1");
    } finally {
      cleanup();
    }
  });

  it("gate deny → function_call_output carries the bridge denial text; loop continues; turn succeeds", async () => {
    const fetchMock = sseScript(
      [completed([callItem("mcp__fixture__echo", '{"text":"hi"}')])],
      [completed([{ type: "message", role: "assistant", content: [] }])],
    );
    const { adapter, cleanup } = makeAdapter(
      {
        assembly: makeAssembly(
          echoAssembly({ guardrailGate: async () => ({ behavior: "deny", reason: "nope" }) }),
        ),
      },
      fetchMock,
    );
    try {
      const result = await adapter.runTurn({ prompt: "go" });
      const out = (bodyOf(fetchMock, 1).input as Array<{ type?: string; output?: string }>).find(
        (i) => i.type === "function_call_output",
      );
      expect(out?.output).toContain("denied by policy");
      expect(out?.output).toContain("nope");
      expect(result.error).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it("unknown tool name → 'unknown tool' output, no throw, round 2 proceeds", async () => {
    const fetchMock = sseScript(
      [completed([callItem("not_a_tool")])],
      [completed([{ type: "message", role: "assistant", content: [] }])],
    );
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);
    try {
      const result = await adapter.runTurn({ prompt: "go" });
      const out = (bodyOf(fetchMock, 1).input as Array<{ type?: string; output?: string }>).find(
        (i) => i.type === "function_call_output",
      );
      expect(out?.output).toBe("Tool execution failed (not_a_tool): unknown tool");
      expect(result.error).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it("bad-JSON arguments → 'arguments were not valid JSON' output, no throw", async () => {
    const fetchMock = sseScript(
      [completed([callItem("mcp__fixture__echo", "{nope")])],
      [completed([{ type: "message", role: "assistant", content: [] }])],
    );
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);
    try {
      const result = await adapter.runTurn({ prompt: "go" });
      const out = (bodyOf(fetchMock, 1).input as Array<{ type?: string; output?: string }>).find(
        (i) => i.type === "function_call_output",
      );
      expect(out?.output).toContain("arguments were not valid JSON");
      expect(result.error).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("resourceLimits.maxTurns 1 with a round-1 call → error_max_turns, one fetch, non-provider, append NOT called", async () => {
    const store = makeFakeStore();
    const fetchMock = sseScript([completed([callItem("mcp__fixture__echo", '{"text":"hi"}')])]);
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly(echoAssembly()), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );
    try {
      const result = await adapter.runTurn({
        prompt: "go",
        resourceLimits: { timeoutMs: 60_000, maxTurns: 1, budgetUsd: 1 },
        workItemContext: threadContext("sms:t1"),
      });
      expect(result.error).toBe("error_max_turns");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(classifyTurnResult(result)).toMatchObject({ outcome: "fault", kind: "non-provider" });
      expect(store.append).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

describe("CodexSubscriptionAdapter — KPR-353 T3/§D3 (history replay + persist)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replay: loaded items prepended → first POST input = [prevA, prevB, userItem]; load keyed (agent-x, sms:t1, codex)", async () => {
    const prevA = { role: "user", content: [{ type: "input_text", text: "earlier" }] };
    const prevB = { type: "message", id: "msg_prev", role: "assistant", content: [] };
    const store = makeFakeStore([prevA, prevB]);
    const fetchMock = sseScript([completed([{ type: "message", role: "assistant", content: [] }])]);
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly(), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );
    try {
      await adapter.runTurn({ prompt: "now", workItemContext: threadContext("sms:t1") });
      expect(store.load).toHaveBeenCalledWith("agent-x", "sms:t1", "codex");
      expect(bodyOf(fetchMock, 0).input).toEqual([
        prevA,
        prevB,
        { role: "user", content: [{ type: "input_text", text: "now" }] },
      ]);
    } finally {
      cleanup();
    }
  });

  it("persist on success: append called once with (agent-x, sms:t1, codex, exact thisTurnItems)", async () => {
    const store = makeFakeStore();
    const fetchMock = sseScript(
      [completed([reasoningItem, callItem("mcp__fixture__echo", '{"text":"hi"}')])],
      [completed([{ type: "message", id: "msg_final", role: "assistant", content: [] }])],
    );
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly(echoAssembly()), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );
    try {
      await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });
      expect(store.append).toHaveBeenCalledTimes(1);
      expect(store.append).toHaveBeenCalledWith("agent-x", "sms:t1", "codex", [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        reasoningItem,
        callItem("mcp__fixture__echo", '{"text":"hi"}'),
        { type: "function_call_output", call_id: "call_1", output: "echo:hi" },
        { type: "message", id: "msg_final", role: "assistant", content: [] },
      ]);
    } finally {
      cleanup();
    }
  });

  it("no persist on error result (non-ok fetch)", async () => {
    const store = makeFakeStore();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "boom" }), { status: 400 }));
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly(), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );
    try {
      const result = await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });
      expect(result.error).toContain("400");
      expect(store.append).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("no historyStore/agentId/workItemContext → load/append never called; input = [userItem] (pre-353 floor)", async () => {
    const store = makeFakeStore();
    const fetchMock = sseScript([completed([{ type: "message", role: "assistant", content: [] }])]);
    // store present but NO agentId and NO workItemContext ⇒ historyKey undefined.
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(), historyStore: store }, fetchMock);
    try {
      await adapter.runTurn({ prompt: "solo" });
      expect(store.load).not.toHaveBeenCalled();
      expect(store.append).not.toHaveBeenCalled();
      expect(bodyOf(fetchMock, 0).input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "solo" }] },
      ]);
    } finally {
      cleanup();
    }
  });

  it("T4 ordering companion: load is invoked before the first fetch (invocationCallOrder)", async () => {
    const store = makeFakeStore();
    const fetchMock = sseScript([completed([{ type: "message", role: "assistant", content: [] }])]);
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly(), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );
    try {
      await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });
      expect(store.load.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    } finally {
      cleanup();
    }
  });

  it("T3 breaker-safety: a real TurnHistoryStore over a failing Mongo db → turn completes, no error, classify success, no Mongo text", async () => {
    const store = new TurnHistoryStore(makeFailingDb());
    await store.init();
    const fetchMock = sseScript([
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "hi" } },
      completed([{ type: "message", role: "assistant", content: [] }]),
    ]);
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly(), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );
    try {
      const result = await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });
      expect(result.text).toBe("hi");
      expect(result.error).toBeUndefined();
      expect(classifyTurnResult(result)).toEqual({ outcome: "success" });
      expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    } finally {
      cleanup();
    }
  });
});

describe("CodexSubscriptionAdapter — KPR-353 §D7 (poisoned-replay self-heal)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("T7: first-round 429 after a non-empty replay → history cleared + ONE fresh retry (no history), turn succeeds", async () => {
    const store = makeFakeStore([{ role: "user", content: [{ type: "input_text", text: "poison" }] }]);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "rate limited" }), { status: 429 }))
      .mockResolvedValueOnce(new Response(sse([completed([{ type: "message", role: "assistant", content: [] }])])));
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly(), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );
    try {
      const result = await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });
      expect(result.error).toBeUndefined();
      expect(store.clear).toHaveBeenCalledWith("agent-x", "sms:t1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // retry dropped the replayed history — only the user item is posted.
      expect(bodyOf(fetchMock, 1).input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "go" }] },
      ]);
    } finally {
      cleanup();
    }
  });

  it("a 4xx WITHOUT replayed history does not self-heal (surfaces as error, one fetch, no clear)", async () => {
    const store = makeFakeStore(); // empty ⇒ replayedNonEmpty false
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "bad" }), { status: 400 }));
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly(), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );
    try {
      const result = await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });
      expect(result.error).toContain("400");
      expect(store.clear).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("a 5xx after a non-empty replay does NOT self-heal (breaker weight preserved, no retry, no clear)", async () => {
    const store = makeFakeStore([{ role: "user", content: [{ type: "input_text", text: "poison" }] }]);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "upstream" }), { status: 503 }));
    const { adapter, cleanup } = makeAdapter(
      { assembly: makeAssembly(), historyStore: store, agentId: "agent-x" },
      fetchMock,
    );
    try {
      const result = await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });
      expect(result.error).toContain("503");
      expect(store.clear).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });
});

describe("CodexSubscriptionAdapter — KPR-353 T6 (telemetry)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("two-round tool turn → toolMs > 0 and llmMs === durationMs - toolMs (>= 0)", async () => {
    const fetchMock = sseScript(
      [completed([callItem("mcp__fixture__echo", '{"text":"hi"}')])],
      [completed([{ type: "message", role: "assistant", content: [] }])],
    );
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(echoAssembly({}, 5)) }, fetchMock);
    try {
      const result = await adapter.runTurn({ prompt: "go" });
      expect(result.toolMs).toBeGreaterThan(0);
      expect(result.llmMs).toBe(result.durationMs - result.toolMs);
      expect(result.llmMs).toBeGreaterThanOrEqual(0);
      expect(result.toolCalls).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("usage summed across rounds; in_progress usage inside round 2 does not change totals", async () => {
    const fetchMock = sseScript(
      [completed([callItem("mcp__fixture__echo", '{"text":"hi"}')], { input_tokens: 10, output_tokens: 2 })],
      [
        {
          event: "response.in_progress",
          data: { type: "response.in_progress", response: { id: "resp-p", usage: { input_tokens: 999, output_tokens: 999 } } },
        },
        completed(
          [{ type: "message", role: "assistant", content: [] }],
          { input_tokens: 30, output_tokens: 5, input_tokens_details: { cached_tokens: 8 } },
        ),
      ],
    );
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);
    try {
      const result = await adapter.runTurn({ prompt: "go" });
      expect(result.inputTokens).toBe(40);
      expect(result.outputTokens).toBe(7);
      expect(result.cacheReadTokens).toBe(8);
    } finally {
      cleanup();
    }
  });
});

describe("CodexSubscriptionAdapter — KPR-353 T8 (abort + bridge lifecycle)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mid-tool abort: echo handler aborts before resolving → aborted, one fetch, append not called", async () => {
    const store = makeFakeStore();
    const ref: { current?: CodexSubscriptionAdapter } = {};
    const inproc = makeInProcessServer((s) =>
      s.registerTool("echo", { description: "", inputSchema: { text: z.string() } }, async ({ text }) => {
        ref.current?.abort();
        return { content: [{ type: "text", text: `echo:${text}` }] };
      }),
    );
    const fetchMock = sseScript(
      [completed([callItem("mcp__fixture__echo", '{"text":"hi"}')])],
      [completed([{ type: "message", role: "assistant", content: [] }])],
    );
    const { adapter, cleanup } = makeAdapter(
      {
        assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }),
        historyStore: store,
        agentId: "agent-x",
      },
      fetchMock,
    );
    ref.current = adapter;
    try {
      const result = await adapter.runTurn({ prompt: "go", workItemContext: threadContext("sms:t1") });
      expect(result.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.append).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("between-round abort: onStream aborts during round-1 SSE → aborted, no second fetch", async () => {
    const ref: { current?: CodexSubscriptionAdapter } = {};
    const fetchMock = sseScript(
      [
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "x" } },
        completed([callItem("mcp__fixture__echo", '{"text":"hi"}')]),
      ],
      [completed([{ type: "message", role: "assistant", content: [] }])],
    );
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);
    ref.current = adapter;
    try {
      const result = await adapter.runTurn({ prompt: "go", onStream: () => ref.current?.abort() });
      expect(result.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("bridge.close() called exactly once on success, error, and abort paths; no unhandled rejections", async () => {
    const rejections: unknown[] = [];
    const onRej = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRej);
    const closeSpy = vi.spyOn(ToolBridge.prototype, "close");
    try {
      // success
      const okFetch = sseScript([completed([{ type: "message", role: "assistant", content: [] }])]);
      const ok = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, okFetch);
      await ok.adapter.runTurn({ prompt: "go" });
      ok.cleanup();
      expect(closeSpy).toHaveBeenCalledTimes(1);

      // error
      closeSpy.mockClear();
      const errFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "boom" }), { status: 400 }));
      const err = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, errFetch);
      await err.adapter.runTurn({ prompt: "go" });
      err.cleanup();
      expect(closeSpy).toHaveBeenCalledTimes(1);

      // abort
      closeSpy.mockClear();
      const ref: { current?: CodexSubscriptionAdapter } = {};
      const inproc = makeInProcessServer((s) =>
        s.registerTool("echo", { description: "", inputSchema: { text: z.string() } }, async ({ text }) => {
          ref.current?.abort();
          return { content: [{ type: "text", text: `echo:${text}` }] };
        }),
      );
      const abFetch = sseScript([completed([callItem("mcp__fixture__echo", '{"text":"hi"}')])]);
      const ab = makeAdapter(
        { assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }) },
        abFetch,
      );
      ref.current = ab.adapter;
      await ab.adapter.runTurn({ prompt: "go" });
      ab.cleanup();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
      await new Promise((r) => setTimeout(r, 20));
      process.off("unhandledRejection", onRej);
    }
    expect(rejections).toEqual([]);
  });
});

describe("CodexSubscriptionAdapter — KPR-353 Delta 1 (output_item.done harvesting, production path)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("function_call via response.output_item.done (store:false real-backend shape) → harvested, dispatched, round 2 proceeds", async () => {
    const fnItem = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "mcp__fixture__echo",
      arguments: '{"text":"hi"}',
      status: "completed",
    };
    const fetchMock = sseScript(
      [
        { event: "response.output_item.done", data: { type: "response.output_item.done", item: fnItem } },
        // completed.output is EMPTY under store:false — the whole point of Delta 1.
        { event: "response.completed", data: { type: "response.completed", response: { id: "resp_1", output: [] } } },
      ],
      [
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "done" } },
        { event: "response.completed", data: { type: "response.completed", response: { id: "resp_2", output: [] } } },
      ],
    );
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);
    try {
      const result = await adapter.runTurn({ prompt: "go" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const out = (bodyOf(fetchMock, 1).input as Array<{ type?: string }>).find(
        (i) => i.type === "function_call_output",
      );
      expect(out).toEqual({ type: "function_call_output", call_id: "call_1", output: "echo:hi" });
      expect(result.text).toBe("done");
      expect(result.toolCalls).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("dedup: same item id from BOTH output_item.done and completed.output → captured once (no double dispatch)", async () => {
    const fnItem = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "mcp__fixture__echo",
      arguments: '{"text":"hi"}',
      status: "completed",
    };
    const fetchMock = sseScript(
      [
        { event: "response.output_item.done", data: { type: "response.output_item.done", item: fnItem } },
        { event: "response.completed", data: { type: "response.completed", response: { id: "resp_1", output: [fnItem] } } },
      ],
      [{ event: "response.completed", data: { type: "response.completed", response: { id: "resp_2", output: [{ type: "message", role: "assistant", content: [] }] } } }],
    );
    const { adapter, cleanup } = makeAdapter({ assembly: makeAssembly(echoAssembly()) }, fetchMock);
    try {
      const result = await adapter.runTurn({ prompt: "go" });
      const outs = (bodyOf(fetchMock, 1).input as Array<{ type?: string }>).filter(
        (i) => i.type === "function_call_output",
      );
      expect(outs).toHaveLength(1);
      expect(result.toolCalls).toBe(1);
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
    const state = { text: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, outputItems: [] };
    const remainder = consumeBufferedSseEvents(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there"}',
      state,
    );

    expect(state.text).toBe("hi");
    expect(remainder).toContain(" there");
  });
});

describe("consumeCodexSse — KPR-353 SSE consumer groundwork (Task 2)", () => {
  it("captures response.completed output items verbatim", async () => {
    const output = [
      { id: "rs_1", type: "reasoning", content: [], encrypted_content: "blob", summary: null },
      {
        id: "msg_1",
        type: "message",
        status: "completed",
        content: [{ type: "output_text", annotations: [], logprobs: [], text: "hi" }],
        role: "assistant",
      },
    ];
    const result = await consumeCodexSse(
      sse([
        {
          event: "response.completed",
          data: { type: "response.completed", response: { id: "resp-c", output } },
        },
      ]),
      undefined,
    );

    expect(result.outputItems).toEqual(output);
  });

  it("prefers the completed response id over an earlier created id", async () => {
    const result = await consumeCodexSse(
      sse([
        { event: "response.created", data: { type: "response.created", response: { id: "resp-created" } } },
        { event: "response.completed", data: { type: "response.completed", response: { id: "resp-complete" } } },
      ]),
      undefined,
    );

    expect(result.responseId).toBe("resp-complete");
  });

  it("T6: accumulates usage from response.completed only, not interim in_progress payloads", async () => {
    const result = await consumeCodexSse(
      sse([
        {
          event: "response.in_progress",
          data: { type: "response.in_progress", response: { id: "resp-p", usage: { input_tokens: 7, output_tokens: 2 } } },
        },
        {
          event: "response.completed",
          data: { type: "response.completed", response: { id: "resp-c", usage: { input_tokens: 10, output_tokens: 3 } } },
        },
      ]),
      undefined,
    );

    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(3);
  });

  it("leaves outputItems empty when the stream is cut before completion", async () => {
    const result = await consumeCodexSse(
      sse([
        { event: "response.created", data: { type: "response.created", response: { id: "resp-created" } } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "partial" } },
      ]),
      undefined,
    );

    expect(result.outputItems).toEqual([]);
    expect(result.text).toBe("partial");
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
