import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  GeminiInteractionsAdapter,
  type GeminiInteractionsClient,
  __resetCoercionWarnedForTests,
} from "./gemini-interactions-adapter.js";
import { ToolBridge } from "./tool-bridge.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import { BUILTIN_TOOL_DEFINITIONS } from "./builtin-executor.js";
import { classifyTurnResult } from "./error-classification.js";

// The adapter (and the real ToolBridge it drives) log. Shared (hoisted) mock
// so the §D5 coercion warn-once is assertable, cleared per test by
// vi.clearAllMocks() in beforeEach.
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../logging/logger.js", () => ({
  createLogger: () => logMock,
}));

// --- Injected client mock ---------------------------------------------------

type Script = Record<string, unknown>[] | Error;

/** A GeminiInteractionsClient whose `create` records (params, options) per call
 *  and returns an async iterable over the next script (or rejects with the
 *  Error — thrown errors carry a `status` to model ApiError). */
function makeClient(scripts: Script[]) {
  const calls: Array<{ params: Record<string, unknown>; options: unknown }> = [];
  let i = 0;
  const client: GeminiInteractionsClient = {
    create: vi.fn(async (params, options) => {
      calls.push({ params, options });
      const script = scripts[i++];
      if (script instanceof Error) throw script;
      if (!script) throw new Error(`no script for create call ${i}`);
      return (async function* () {
        for (const ev of script) yield ev;
      })();
    }),
  };
  return { client, calls };
}

/** A rejection error carrying an HTTP status (models @google/genai ApiError). */
function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

// --- Event fixture helpers (verbatim T0-spike shapes) -----------------------

const created = (id: string) => ({ event_type: "interaction.created", interaction: { id } });
const textDelta = (text: string) => ({ event_type: "step.delta", delta: { type: "text", text } });
const argsDelta = (index: number, fragment: string) => ({
  event_type: "step.delta",
  index,
  delta: { type: "arguments_delta", arguments: fragment },
});
const stepStart = (index: number, step: Record<string, unknown>) => ({
  event_type: "step.start",
  index,
  step,
});
const completed = (
  id: string,
  extra: { usage?: Record<string, unknown>; steps?: unknown[]; status?: string } = {},
) => ({
  event_type: "interaction.completed",
  interaction: {
    id,
    status: extra.status ?? "completed",
    ...(extra.usage ? { usage: extra.usage } : {}),
    ...(extra.steps ? { steps: extra.steps } : {}),
  },
});
const errorEvent = (message: string) => ({ event_type: "error", error: { message } });

/** A function_call step.start (streaming/live source, T0 spike Delta 1). */
const fnCallStart = (index: number, id: string, name: string) =>
  stepStart(index, { id, name, type: "function_call", signature: "sig-blob" });

// --- Assembly / bridge fixtures (replicated from openai/codex test files) ---

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

/** An echo in-process server registered under name "fixture"; optional delay +
 *  optional args-recorder for real ToolBridge dispatch over InMemoryTransport. */
function makeEchoServer(opts: { delayMs?: number; onCall?: (text: string) => void } = {}) {
  return makeInProcessServer((s) =>
    s.registerTool("echo", { description: "echo", inputSchema: { text: z.string() } }, async ({ text }) => {
      opts.onCall?.(text);
      if (opts.delayMs && opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { content: [{ type: "text", text: `echo:${text}` }] };
    }),
  );
}

/** Assembly wired to the echo fixture (real bridge dispatch). */
function echoAssembly(opts: { delayMs?: number; onCall?: (text: string) => void } = {}): ProviderTurnAssembly {
  return makeAssembly({
    toolInventory: [makeInProcEntry()],
    inProcessServers: { fixture: makeEchoServer(opts) },
  });
}

const ECHO = "mcp__fixture__echo";

// --- Adapter factory (guardrail: ALWAYS both client + apiKey) ---------------

function makeAdapter(
  overrides: Partial<ConstructorParameters<typeof GeminiInteractionsAdapter>[0]> & {
    client: GeminiInteractionsClient;
  },
) {
  return new GeminiInteractionsAdapter({
    name: "Gem",
    assembly: makeAssembly(),
    apiKey: "test-key",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCoercionWarnedForTests();
});

// ---------------------------------------------------------------------------
// provider id / wasAborted
// ---------------------------------------------------------------------------

describe("GeminiInteractionsAdapter identity", () => {
  it("exposes the gemini provider id and reflects abort()", () => {
    const { client } = makeClient([]);
    const adapter = makeAdapter({ client });
    expect(adapter.provider).toBe("gemini");
    expect(adapter.wasAborted).toBe(false);
    adapter.abort();
    expect(adapter.wasAborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T1 — tool advertisement
// ---------------------------------------------------------------------------

describe("T1 tool advertisement", () => {
  it("posts every bridged tool as {type:function, name, description, parameters} with store + system_instruction", async () => {
    const { client, calls } = makeClient([[created("i1"), textDelta("hi"), completed("i1")]]);
    const assembly = makeAssembly({
      toolInventory: [makeInProcEntry(), makeBuiltinEntry("Read")],
      inProcessServers: { fixture: makeEchoServer() },
    });
    const adapter = makeAdapter({ client, assembly });

    await adapter.runTurn({ prompt: "hello" });

    const params = calls[0].params;
    expect(params.store).toBe(true);
    expect(params.system_instruction).toBe("Be useful.");
    const tools = params.tools as Array<{ type: string; name: string; description: unknown; parameters: unknown }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["Read", ECHO].sort());
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(typeof t.description).toBe("string");
      expect(t.parameters).toBeTypeOf("object");
    }
  });

  it("posts tools: [] when the inventory is empty", async () => {
    const { client, calls } = makeClient([[created("i1"), textDelta("hi"), completed("i1")]]);
    const adapter = makeAdapter({ client });
    await adapter.runTurn({ prompt: "hello" });
    expect(calls[0].params.tools).toEqual([]);
  });

  it("systemPromptOverride wins over assembly instructions and store+system_instruction ride every round", async () => {
    const { client, calls } = makeClient([
      [created("i1"), fnCallStart(0, "c1", ECHO), argsDelta(0, '{"text":"a"}'), completed("i1", { status: "requires_action" })],
      [created("i2"), textDelta("done"), completed("i2")],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly() });

    await adapter.runTurn({ prompt: "go", systemPromptOverride: "OVERRIDE PROMPT" });

    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.params.store).toBe(true);
      expect(c.params.system_instruction).toBe("OVERRIDE PROMPT");
    }
  });
});

// ---------------------------------------------------------------------------
// T2 — dispatch loop
// ---------------------------------------------------------------------------

describe("T2 dispatch loop", () => {
  it("single round: accumulates text, streams per delta, sessionId = completed id, no previous_interaction_id when absent", async () => {
    const { client, calls } = makeClient([
      [created("i1"), textDelta("hel"), textDelta("lo"), completed("i1")],
    ]);
    const adapter = makeAdapter({ client });
    const onStream = vi.fn();

    const result = await adapter.runTurn({ prompt: "hi", onStream });

    expect(result.text).toBe("hello");
    expect(onStream.mock.calls.map((c) => c[0])).toEqual(["hel", "lo"]);
    expect(result.sessionId).toBe("i1");
    expect(calls).toHaveLength(1);
    expect(calls[0].params).not.toHaveProperty("previous_interaction_id");
    expect(result.streamed).toBe(true);
  });

  it("resume: round-1 previous_interaction_id === request.sessionId", async () => {
    const { client, calls } = makeClient([[created("i9"), textDelta("ok"), completed("i9")]]);
    const adapter = makeAdapter({ client });
    await adapter.runTurn({ prompt: "hi", sessionId: "interactions/abc" });
    expect(calls[0].params.previous_interaction_id).toBe("interactions/abc");
  });

  it("two rounds (streaming-reconstruction source): tool executes with streamed args, round-2 input is only the function_result chained off round-1 id", async () => {
    const seen: string[] = [];
    const { client, calls } = makeClient([
      [
        created("i1"),
        fnCallStart(0, "c1", ECHO),
        argsDelta(0, '{"text":'),
        argsDelta(0, '"hi"}'),
        completed("i1", { status: "requires_action" }),
      ],
      [created("i2"), textDelta("all done"), completed("i2")],
    ]);
    const onStream = vi.fn();
    const adapter = makeAdapter({ client, assembly: echoAssembly({ onCall: (t) => seen.push(t) }) });

    const result = await adapter.runTurn({ prompt: "use echo", onStream });

    expect(seen).toEqual(["hi"]); // real handler received the parsed args
    expect(result.text).toBe("all done"); // final round only
    expect(onStream).toHaveBeenCalled(); // round-1 deltas reached onStream
    expect(calls).toHaveLength(2);
    expect(calls[1].params.previous_interaction_id).toBe("i1");
    expect(calls[1].params.input).toEqual([
      { type: "function_result", name: ECHO, call_id: "c1", result: [{ type: "text", text: "echo:hi" }] },
    ]);
    expect(result.sessionId).toBe("i2");
  });

  it("two rounds (completed-steps source): a populated interaction.steps also drives execution", async () => {
    const seen: string[] = [];
    const { client, calls } = makeClient([
      [
        created("i1"),
        completed("i1", {
          status: "requires_action",
          steps: [{ id: "c1", name: ECHO, type: "function_call", arguments: { text: "yo" } }],
        }),
      ],
      [created("i2"), textDelta("fin"), completed("i2")],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly({ onCall: (t) => seen.push(t) }) });

    const result = await adapter.runTurn({ prompt: "go" });

    expect(seen).toEqual(["yo"]);
    expect(calls[1].params.input).toEqual([
      { type: "function_result", name: ECHO, call_id: "c1", result: [{ type: "text", text: "echo:yo" }] },
    ]);
    expect(result.text).toBe("fin");
  });

  it("both sources carry the same call id: executed ONCE (dedupe)", async () => {
    const seen: string[] = [];
    const { client, calls } = makeClient([
      [
        created("i1"),
        fnCallStart(0, "c1", ECHO),
        argsDelta(0, '{"text":"once"}'),
        completed("i1", {
          status: "requires_action",
          steps: [{ id: "c1", name: ECHO, type: "function_call", arguments: { text: "once" } }],
        }),
      ],
      [created("i2"), textDelta("fin"), completed("i2")],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly({ onCall: (t) => seen.push(t) }) });

    await adapter.runTurn({ prompt: "go" });

    expect(seen).toEqual(["once"]);
    expect((calls[1].params.input as unknown[]).length).toBe(1);
  });

  it("parallel calls: both executed sequentially, both function_result items in ONE follow-up round", async () => {
    const seen: string[] = [];
    const { client, calls } = makeClient([
      [
        created("i1"),
        fnCallStart(0, "c1", ECHO),
        argsDelta(0, '{"text":"a"}'),
        fnCallStart(1, "c2", ECHO),
        argsDelta(1, '{"text":"b"}'),
        completed("i1", { status: "requires_action" }),
      ],
      [created("i2"), textDelta("fin"), completed("i2")],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly({ onCall: (t) => seen.push(t) }) });

    await adapter.runTurn({ prompt: "go" });

    expect(seen).toEqual(["a", "b"]);
    const input = calls[1].params.input as unknown[];
    expect(input).toEqual([
      { type: "function_result", name: ECHO, call_id: "c1", result: [{ type: "text", text: "echo:a" }] },
      { type: "function_result", name: ECHO, call_id: "c2", result: [{ type: "text", text: "echo:b" }] },
    ]);
  });

  it("containment: hallucinated tool name → structured error result, loop continues, no throw", async () => {
    const { client, calls } = makeClient([
      [created("i1"), fnCallStart(0, "c1", "nope"), argsDelta(0, "{}"), completed("i1", { status: "requires_action" })],
      [created("i2"), textDelta("fin"), completed("i2")],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly() });

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.error).toBeUndefined();
    expect(calls[1].params.input).toEqual([
      { type: "function_result", name: "nope", call_id: "c1", result: [{ type: "text", text: "Tool execution failed (nope): unknown tool" }] },
    ]);
  });

  it("containment: unparseable arguments_delta → 'arguments were not valid JSON' result text", async () => {
    const { client, calls } = makeClient([
      [created("i1"), fnCallStart(0, "c1", ECHO), argsDelta(0, "{not json"), completed("i1", { status: "requires_action" })],
      [created("i2"), textDelta("fin"), completed("i2")],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly() });

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.error).toBeUndefined();
    expect(calls[1].params.input).toEqual([
      { type: "function_result", name: ECHO, call_id: "c1", result: [{ type: "text", text: "Tool execution failed (mcp__fixture__echo): arguments were not valid JSON" }] },
    ]);
  });

  it("bounds: maxTurns 1 with a call-bearing round → error_max_turns", async () => {
    const { client } = makeClient([
      [created("i1"), fnCallStart(0, "c1", ECHO), argsDelta(0, '{"text":"a"}'), completed("i1", { status: "requires_action" })],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly() });
    const result = await adapter.runTurn({ prompt: "go", resourceLimits: { maxTurns: 1 } as never });
    expect(result.error).toBe("error_max_turns");
  });

  it("bounds: maxTurns 0 → error_max_turns with ZERO create calls", async () => {
    const { client, calls } = makeClient([]);
    const adapter = makeAdapter({ client });
    const result = await adapter.runTurn({ prompt: "go", resourceLimits: { maxTurns: 0 } as never });
    expect(result.error).toBe("error_max_turns");
    expect(calls).toHaveLength(0);
  });

  it("missing id: call-bearing round with no interaction id → non-tagged error", async () => {
    const { client } = makeClient([
      [fnCallStart(0, "c1", ECHO), argsDelta(0, "{}")], // no created/completed ⇒ no id
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly() });
    const result = await adapter.runTurn({ prompt: "go" });
    expect(result.error).toBe("Gemini interaction stream ended without an interaction id");
    expect(result.error).not.toMatch(/resume rejected/i);
  });
});

// ---------------------------------------------------------------------------
// T5 — stale-handle tag emission + scoping (adapter half)
// ---------------------------------------------------------------------------

describe("T5 stale-handle tag (adapter half)", () => {
  it("resume-carrying round-1 400 with invalid-argument message → tagged sentinel", async () => {
    const { client } = makeClient([statusError(400, "Request contains an invalid argument.")]);
    const adapter = makeAdapter({ client });
    const result = await adapter.runTurn({ prompt: "hi", sessionId: "interactions/old" });
    expect(result.error).toBe(
      "gemini interaction resume rejected (status 400): Request contains an invalid argument.",
    );
  });

  it("scoping — mid-turn round-2 400 (chained off just-minted id) is UNTAGGED", async () => {
    const { client } = makeClient([
      [created("i1"), fnCallStart(0, "c1", ECHO), argsDelta(0, '{"text":"a"}'), completed("i1", { status: "requires_action" })],
      statusError(400, "Request contains an invalid argument."),
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly() });
    const result = await adapter.runTurn({ prompt: "go", sessionId: "interactions/old" });
    expect(result.error).toBe("Gemini interaction request failed (400): Request contains an invalid argument.");
    expect(result.error).not.toMatch(/resume rejected/i);
  });

  it("scoping — no request.sessionId → round-1 400 is UNTAGGED", async () => {
    const { client } = makeClient([statusError(400, "Request contains an invalid argument.")]);
    const adapter = makeAdapter({ client });
    const result = await adapter.runTurn({ prompt: "hi" });
    expect(result.error).toBe("Gemini interaction request failed (400): Request contains an invalid argument.");
  });

  it("scoping — status breadth: only 400+invalid-argument tags; 403/404/429/500 stay untagged with breaker weight", async () => {
    const cases: Array<[number, string]> = [
      [403, "You do not have permission to access the content"],
      [404, "not found"],
      [429, "rate limit exceeded"],
      [500, "internal server error"],
    ];
    for (const [status, msg] of cases) {
      const { client } = makeClient([statusError(status, msg)]);
      const adapter = makeAdapter({ client });
      const result = await adapter.runTurn({ prompt: "hi", sessionId: "interactions/old" });
      expect(result.error).toBe(`Gemini interaction request failed (${status}): ${msg}`);
      expect(result.error).not.toMatch(/resume rejected/i);
    }
  });

  it("scoping — a 400 whose message is NOT invalid-argument-shaped stays untagged (generic-400 guard)", async () => {
    const { client } = makeClient([statusError(400, "malformed body: field 'model' required")]);
    const adapter = makeAdapter({ client });
    const result = await adapter.runTurn({ prompt: "hi", sessionId: "interactions/old" });
    expect(result.error).toBe("Gemini interaction request failed (400): malformed body: field 'model' required");
    expect(result.error).not.toMatch(/resume rejected/i);
  });

  it("network passthrough: a statusless throw surfaces its message verbatim (connect-fail reachable)", async () => {
    const { client } = makeClient([new Error("connect ECONNREFUSED 10.0.0.1:443")]);
    const adapter = makeAdapter({ client });
    const result = await adapter.runTurn({ prompt: "hi", sessionId: "interactions/old" });
    expect(result.error).toBe("connect ECONNREFUSED 10.0.0.1:443");
    expect(classifyTurnResult(result)).toMatchObject({ kind: "connect-fail" });
  });
});

// ---------------------------------------------------------------------------
// T7 — effort → thinking_level
// ---------------------------------------------------------------------------

describe("T7 effort → thinking_level", () => {
  it("high passes through to generation_config.thinking_level", async () => {
    const { client, calls } = makeClient([[created("i1"), textDelta("ok"), completed("i1")]]);
    const adapter = makeAdapter({ client, reasoningEffort: "high" });
    await adapter.runTurn({ prompt: "hi" });
    expect(calls[0].params.generation_config).toEqual({ thinking_level: "high" });
  });

  it("xhigh coerces to high", async () => {
    const { client, calls } = makeClient([[created("i1"), textDelta("ok"), completed("i1")]]);
    const adapter = makeAdapter({ client, reasoningEffort: "xhigh" });
    await adapter.runTurn({ prompt: "hi" });
    expect(calls[0].params.generation_config).toEqual({ thinking_level: "high" });
  });

  it("none coerces to minimal and warns ONCE across two same-name adapters", async () => {
    const c1 = makeClient([[created("i1"), textDelta("ok"), completed("i1")]]);
    const c2 = makeClient([[created("i2"), textDelta("ok"), completed("i2")]]);
    const a1 = makeAdapter({ client: c1.client, reasoningEffort: "none" });
    const a2 = makeAdapter({ client: c2.client, reasoningEffort: "none" });

    await a1.runTurn({ prompt: "hi" });
    await a2.runTurn({ prompt: "hi" });

    expect(c1.calls[0].params.generation_config).toEqual({ thinking_level: "minimal" });
    expect(c2.calls[0].params.generation_config).toEqual({ thinking_level: "minimal" });
    const coercionWarns = logMock.warn.mock.calls.filter((c) =>
      String(c[0]).includes("coerced to nearest thinking_level"),
    );
    expect(coercionWarns).toHaveLength(1);
  });

  it("no suffix ⇒ NO generation_config key", async () => {
    const { client, calls } = makeClient([[created("i1"), textDelta("ok"), completed("i1")]]);
    const adapter = makeAdapter({ client });
    await adapter.runTurn({ prompt: "hi" });
    expect(calls[0].params).not.toHaveProperty("generation_config");
  });
});

// ---------------------------------------------------------------------------
// T8 — telemetry / usage
// ---------------------------------------------------------------------------

describe("T8 telemetry / usage", () => {
  const usage = (input: number, output: number, cached: number) => ({
    total_tokens: input + output,
    total_input_tokens: input,
    total_output_tokens: output,
    total_cached_tokens: cached,
    input_tokens_by_modality: { text: input },
    total_tool_use_tokens: 0,
    total_thought_tokens: 0,
  });

  it("sums usage from interaction.completed across two rounds; cacheReadTokens from total_cached_tokens; costUsd 0", async () => {
    const { client } = makeClient([
      [
        created("i1"),
        fnCallStart(0, "c1", ECHO),
        argsDelta(0, '{"text":"a"}'),
        completed("i1", { status: "requires_action", usage: usage(10, 3, 2) }),
      ],
      [created("i2"), textDelta("fin"), completed("i2", { usage: usage(5, 7, 1) })],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly() });

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.inputTokens).toBe(15);
    expect(result.outputTokens).toBe(10);
    expect(result.cacheReadTokens).toBe(3);
    expect(result.costUsd).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
  });

  it("counts the completed usage ONCE even when step.stop/metadata carry usage-shaped fields (multi-count guard)", async () => {
    const { client } = makeClient([
      [
        created("i1"),
        { event_type: "step.stop", index: 0, step_usage: { total_input_tokens: 999, total_output_tokens: 999 } },
        { event_type: "interaction.status_update", metadata: { total_usage: { total_input_tokens: 999 } } },
        completed("i1", { usage: usage(10, 3, 2) }),
      ],
    ]);
    const adapter = makeAdapter({ client });
    const result = await adapter.runTurn({ prompt: "hi" });
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(3);
  });

  it("llmMs = max(0, durationMs − toolMs); toolCalls/toolSummary from bridge.stats", async () => {
    const { client } = makeClient([
      [
        created("i1"),
        fnCallStart(0, "c1", ECHO),
        argsDelta(0, '{"text":"a"}'),
        completed("i1", { status: "requires_action" }),
      ],
      [created("i2"), textDelta("fin"), completed("i2")],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly({ delayMs: 20 }) });

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.toolCalls).toBe(1);
    expect(result.toolSummary).toBe(`${ECHO}×1`);
    expect(result.toolMs).toBeGreaterThan(0);
    expect(result.llmMs).toBe(Math.max(0, result.durationMs - result.toolMs));
    expect(result.llmMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// T9 — abort + error sessionId
// ---------------------------------------------------------------------------

describe("T9 abort", () => {
  it("mid-stream abort → aborted, sessionId = request.sessionId ?? '', no round-2, bridge.close called", async () => {
    const closeSpy = vi.spyOn(ToolBridge.prototype, "close");
    const { client, calls } = makeClient([
      [
        created("i1"),
        textDelta("start"), // triggers abort via onStream
        fnCallStart(0, "c1", ECHO),
        argsDelta(0, '{"text":"a"}'),
        completed("i1", { status: "requires_action" }),
      ],
      [created("i2"), textDelta("should-not-run"), completed("i2")],
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly() });
    const onStream = vi.fn(() => adapter.abort());

    const result = await adapter.runTurn({ prompt: "go", onStream });

    expect(result.aborted).toBe(true);
    expect(result.sessionId).toBe("");
    expect(calls).toHaveLength(1);
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("mid-tool abort → aborted, no second create", async () => {
    const closeSpy = vi.spyOn(ToolBridge.prototype, "close");
    const holder: { adapter?: GeminiInteractionsAdapter } = {};
    const { client, calls } = makeClient([
      [
        created("i1"),
        fnCallStart(0, "c1", ECHO),
        argsDelta(0, '{"text":"a"}'),
        completed("i1", { status: "requires_action" }),
      ],
      [created("i2"), textDelta("should-not-run"), completed("i2")],
    ]);
    const assembly = echoAssembly({ onCall: () => holder.adapter?.abort() });
    const adapter = makeAdapter({ client, assembly });
    holder.adapter = adapter;

    const result = await adapter.runTurn({ prompt: "go", sessionId: "interactions/keep" });

    expect(result.aborted).toBe(true);
    expect(result.sessionId).toBe("interactions/keep");
    expect(calls).toHaveLength(1);
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("mid-turn error after round-1 minted id → sessionId = request.sessionId ?? '' (never the minted id)", async () => {
    const { client } = makeClient([
      [created("i1"), fnCallStart(0, "c1", ECHO), argsDelta(0, '{"text":"a"}'), completed("i1", { status: "requires_action" })],
      statusError(500, "internal server error"),
    ]);
    const adapter = makeAdapter({ client, assembly: echoAssembly() });

    const result = await adapter.runTurn({ prompt: "go" });

    expect(result.error).toBe("Gemini interaction request failed (500): internal server error");
    expect(result.sessionId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// T10 — missing key (adapter half)
// ---------------------------------------------------------------------------

describe("T10 missing key (adapter half)", () => {
  it("no key (apiKey undefined, env {}) → exact §D7 error, classifies auth, bridge.close still called", async () => {
    const closeSpy = vi.spyOn(ToolBridge.prototype, "close");
    const { client, calls } = makeClient([]);
    const adapter = makeAdapter({ client, apiKey: undefined, env: {} });

    const result = await adapter.runTurn({ prompt: "hi" });

    expect(result.error).toBe(
      "Gemini API key is not available; set GEMINI_API_KEY (hive credentials add GEMINI_API_KEY) or GOOGLE_API_KEY",
    );
    expect(classifyTurnResult(result)).toMatchObject({ kind: "auth" });
    expect(calls).toHaveLength(0); // threw before any create
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("resolves the key from env when apiKey option is unset", async () => {
    const { client, calls } = makeClient([[created("i1"), textDelta("ok"), completed("i1")]]);
    const adapter = makeAdapter({ client, apiKey: undefined, env: { GEMINI_API_KEY: "from-env" } });
    const result = await adapter.runTurn({ prompt: "hi" });
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stream consumer units (exported helpers)
// ---------------------------------------------------------------------------

describe("stream consumer units", () => {
  it("harvestFunctionCalls dedupes across both sources and reconstructs streamed args", async () => {
    const { harvestFunctionCalls, consumeInteractionStream } = await import("./gemini-interactions-adapter.js");
    async function* gen() {
      yield created("i1");
      yield fnCallStart(0, "c1", "toolA");
      yield argsDelta(0, '{"x":1}');
      yield completed("i1", {
        status: "requires_action",
        steps: [{ id: "c1", name: "toolA", type: "function_call", arguments: { x: 1 } }],
      });
    }
    const state = await consumeInteractionStream(gen(), undefined);
    const calls = harvestFunctionCalls(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: "c1", name: "toolA", arguments: { x: 1 } });
  });

  it("applyInteractionEvent throws on an error event", async () => {
    const { applyInteractionEvent } = await import("./gemini-interactions-adapter.js");
    const state = {
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      completedSteps: [],
      startedSteps: new Map(),
      argumentsByIndex: new Map(),
      sawCompleted: false,
    };
    expect(() => applyInteractionEvent(errorEvent("boom"), state)).toThrow(/boom/);
  });
});
