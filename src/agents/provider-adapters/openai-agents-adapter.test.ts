import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Agent, OpenAIProvider, Runner, run } from "@openai/agents";
import { OpenAIAgentsAdapter, coerceFinalOutput } from "./openai-agents-adapter.js";
import { ToolBridge } from "./tool-bridge.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import { BUILTIN_TOOL_DEFINITIONS } from "./builtin-executor.js";
import { classifyTurnResult } from "./error-classification.js";
import { ProviderCircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "../provider-circuit-breaker.js";

interface McpBehavior {
  connect?: () => Promise<void>;
  listTools?: () => Promise<unknown>;
  callTool?: (name: string, args: unknown) => Promise<unknown>;
  close?: () => Promise<void>;
}

const { runnerRunMock, mcpBehaviors } = vi.hoisted(() => ({
  runnerRunMock: vi.fn(),
  mcpBehaviors: new Map<string, McpBehavior>(),
}));

vi.mock("@openai/agents", () => {
  // External MCP transport classes — tool-bridge imports them at module load,
  // so the mock must export all three even though these adapter tests drive
  // dispatch through in-process fixtures + builtins (only the faulting-close
  // test uses an external server, via mcpBehaviors).
  function mcpFactory() {
    return function (options: { name: string }) {
      const b = mcpBehaviors.get(options.name) ?? {};
      return {
        name: options.name,
        connect: b.connect ?? (async () => {}),
        listTools: b.listTools ?? (async () => []),
        callTool: b.callTool ?? (async () => ({ content: [{ type: "text", text: "ok" }], isError: false })),
        close: b.close ?? (async () => {}),
      };
    };
  }
  return {
    Agent: vi.fn(function Agent(options: unknown) {
      return { options };
    }),
    OpenAIProvider: vi.fn(function OpenAIProvider(options: unknown) {
      return { options };
    }),
    Runner: vi.fn(function Runner(options: unknown) {
      return { options, run: runnerRunMock };
    }),
    run: vi.fn(),
    // bindTool passes the cfg through; tests read cfg.name/cfg.execute directly.
    tool: vi.fn((cfg: unknown) => cfg),
    MCPServerStdio: vi.fn(mcpFactory()),
    MCPServerStreamableHttp: vi.fn(mcpFactory()),
    MCPServerSSE: vi.fn(mcpFactory()),
  };
});

const AgentMock = vi.mocked(Agent);
const OpenAIProviderMock = vi.mocked(OpenAIProvider);
const RunnerMock = vi.mocked(Runner);
const runMock = vi.mocked(run);

function makeAdapter(overrides: Partial<ConstructorParameters<typeof OpenAIAgentsAdapter>[0]> = {}) {
  return new OpenAIAgentsAdapter({
    name: "Pilot",
    assembly: makeAssembly(),
    model: "gpt-5.4-mini",
    preferOAuth: false,
    ...overrides,
  });
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

function makeSdkResult(overrides: Record<string, unknown> = {}) {
  return {
    finalOutput: "hello",
    lastResponseId: "resp-1",
    ...overrides,
  };
}

// --- KPR-348 Task 3 (T1/T5/T7) helpers -------------------------------------

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

/** An external MCP inventory entry (drives the mcpBehaviors path). */
function makeExternalEntry(name: string): HiveToolInventoryEntry {
  return {
    name,
    transport: "stdio",
    source: "plugin",
    requiresTurnContext: false,
    requiresHiveRuntime: false,
    inProcess: false,
    compatibility: {
      claude: "direct",
      openai: "mcp-bridge-candidate",
      gemini: "mcp-bridge-candidate",
      codex: "mcp-bridge-candidate",
    },
    schemas: { kind: "connect-time" },
    serverConfig: { command: "node", args: [], env: {} } as never,
  };
}

/** KPR-354: a claude-subagent inventory entry (Task-synthesis input). */
function makeSubagentEntry(name: string, description?: string): HiveToolInventoryEntry {
  return {
    name,
    transport: "claude-subagent",
    source: "delegate",
    requiresTurnContext: false,
    requiresHiveRuntime: false,
    inProcess: false,
    compatibility: {
      claude: "direct",
      openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge",
      codex: "requires-hive-bridge",
    },
    schemas: { kind: "unavailable" },
    serverConfig: { type: "stdio", command: "x" } as never,
    description,
  };
}

/**
 * Drive the mocked non-streaming run: find the named tool on the agent, await
 * its execute(input), and fold the result into finalOutput.
 */
function driveNonStreaming(toolName: string, input: unknown, wrap = (r: unknown) => `model saw: ${r}`) {
  runMock.mockImplementationOnce(
    async (agent: { options: { tools?: Array<{ name: string; execute: (i: unknown) => Promise<string> }> } }) => {
      const t = agent.options.tools?.find((x) => x.name === toolName);
      const toolResult = t ? await t.execute(input) : undefined;
      return { finalOutput: wrap(toolResult), lastResponseId: "resp_tool" };
    },
  );
}

describe("OpenAIAgentsAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpBehaviors.clear();
    delete process.env.OPENAI_API_KEY;
  });

  it("exposes the OpenAI provider id", () => {
    expect(makeAdapter().provider).toBe("openai");
  });

  it("constructs an OpenAI agent and maps a non-streaming run result", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult({ finalOutput: "hi there", lastResponseId: "resp-next" }) as never);

    const adapter = makeAdapter();
    const result = await adapter.runTurn({
      prompt: "hello",
      sessionId: "resp-prev",
      resourceLimits: { timeoutMs: 60_000, maxTurns: 7, budgetUsd: 1 },
    });

    expect(AgentMock).toHaveBeenCalledWith({
      name: "Pilot",
      instructions: "Be useful.",
      model: "gpt-5.4-mini",
    });
    expect(runMock).toHaveBeenCalledWith(expect.anything(), "hello", {
      stream: false,
      maxTurns: 7,
      signal: expect.any(AbortSignal),
      previousResponseId: "resp-prev",
    });
    expect(result).toMatchObject({
      text: "hi there",
      sessionId: "resp-next",
      costUsd: 0,
      toolCalls: 0,
      toolSummary: "none",
      streamed: false,
      inputTokens: 0,
      outputTokens: 0,
      contextWindow: 0,
      compactions: 0,
      aborted: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.llmMs).toBe(result.durationMs);
  });

  it("uses systemPromptOverride", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult() as never);

    await makeAdapter().runTurn({
      prompt: "hello",
      systemPromptOverride: "voice prompt",
    });

    expect(AgentMock).toHaveBeenCalledWith({
      name: "Pilot",
      instructions: "voice prompt",
      model: "gpt-5.4-mini",
    });
  });

  it("streams text chunks to onStream and returns accumulated text", async () => {
    const textStream = {
      async *[Symbol.asyncIterator]() {
        yield "hel";
        yield "lo";
      },
    };
    const completed = Promise.resolve();
    runMock.mockResolvedValueOnce({
      finalOutput: "ignored",
      lastResponseId: "resp-stream",
      completed,
      toTextStream: vi.fn(() => textStream),
    } as never);

    const onStream = vi.fn();
    const result = await makeAdapter().runTurn({ prompt: "stream please", onStream });

    expect(runMock).toHaveBeenCalledWith(expect.anything(), "stream please", {
      stream: true,
      maxTurns: undefined,
      signal: expect.any(AbortSignal),
      previousResponseId: undefined,
    });
    expect(onStream).toHaveBeenNthCalledWith(1, "hel");
    expect(onStream).toHaveBeenNthCalledWith(2, "lo");
    expect(result).toMatchObject({
      text: "hello",
      sessionId: "resp-stream",
      streamed: true,
      aborted: false,
    });
  });

  it("maps abort rejection to an aborted RunResult", async () => {
    let capturedSignal: AbortSignal | undefined;
    runMock.mockImplementationOnce((_agent, _prompt, options) => {
      capturedSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 0);
      }) as never;
    });

    const adapter = makeAdapter();
    const promise = adapter.runTurn({ prompt: "stop", sessionId: "resp-prev" });
    adapter.abort();
    const result = await promise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(adapter.wasAborted).toBe(true);
    expect(result).toMatchObject({
      text: "",
      sessionId: "resp-prev",
      streamed: false,
      aborted: true,
    });
    expect(result.error).toBeUndefined();
  });

  it("maps normal SDK errors to a complete non-aborted RunResult", async () => {
    runMock.mockRejectedValueOnce(new Error("max turns exceeded"));

    const result = await makeAdapter().runTurn({ prompt: "fail", sessionId: "resp-prev" });

    expect(result).toMatchObject({
      text: "",
      sessionId: "resp-prev",
      costUsd: 0,
      toolCalls: 0,
      streamed: false,
      aborted: false,
      error: "max turns exceeded",
    });
  });

  it("prefers Codex OAuth and falls back to API-key auth on OpenAI auth failures", async () => {
    process.env.OPENAI_API_KEY = "sk-fallback";
    const dir = mkdtempSync(join(tmpdir(), "hive-codex-auth-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: makeJwt({ exp: 60 * 60 }) } }));
    runnerRunMock
      .mockRejectedValueOnce(Object.assign(new Error("Missing scopes: api.responses.write"), { status: 401 }))
      .mockResolvedValueOnce(makeSdkResult({ finalOutput: "used fallback", lastResponseId: "resp-fallback" }));

    try {
      const result = await makeAdapter({ preferOAuth: true, codexAuthPath: authPath }).runTurn({ prompt: "hello" });

      expect(result).toMatchObject({
        text: "used fallback",
        sessionId: "resp-fallback",
        aborted: false,
      });
      expect(runMock).not.toHaveBeenCalled();
      expect(RunnerMock).toHaveBeenCalledTimes(2);
      expect(OpenAIProviderMock).toHaveBeenCalledTimes(2);

      const firstClient = (OpenAIProviderMock.mock.calls[0][0] as any).openAIClient;
      const secondClient = (OpenAIProviderMock.mock.calls[1][0] as any).openAIClient;
      expect(typeof firstClient._options.apiKey).toBe("function");
      expect(secondClient._options.apiKey).toBe("sk-fallback");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("coerces finalOutput values", async () => {
    runMock
      .mockResolvedValueOnce(makeSdkResult({ finalOutput: undefined, lastResponseId: undefined }) as never)
      .mockResolvedValueOnce(makeSdkResult({ finalOutput: { ok: true } }) as never);

    await expect(makeAdapter().runTurn({ prompt: "undefined", sessionId: "existing" })).resolves.toMatchObject({
      text: "",
      sessionId: "existing",
    });
    await expect(makeAdapter().runTurn({ prompt: "object" })).resolves.toMatchObject({
      text: "{\"ok\":true}",
    });
    expect(coerceFinalOutput("plain")).toBe("plain");
    expect(coerceFinalOutput(null)).toBe("");
  });

  it("KPR-348 T7: zero-tools pin inverted (openai) — non-empty bridgeable inventory ⇒ tools advertised with bridged names", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult() as never);

    const inproc = makeInProcessServer((s) =>
      s.registerTool("echo", { description: "echo", inputSchema: { text: z.string() } }, async ({ text }) => ({
        content: [{ type: "text", text: `echo:${text}` }],
      })),
    );
    const adapter = makeAdapter({
      assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }),
    });
    await expect(adapter.runTurn({ prompt: "hello" })).resolves.toMatchObject({ text: "hello", aborted: false });

    const agentOptions = AgentMock.mock.calls[0]![0] as { tools?: Array<{ name: string }> };
    expect(agentOptions.tools?.map((t) => t.name)).toEqual(["mcp__fixture__echo"]);
  });

  it("KPR-348 T7: empty inventory ⇒ no tools key (pilot behavior still valid)", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult() as never);

    await makeAdapter({ assembly: makeAssembly({ toolInventory: [] }) }).runTurn({ prompt: "hello" });

    const agentOptions = AgentMock.mock.calls[0]![0] as Record<string, unknown>;
    expect("tools" in agentOptions).toBe(false);
  });

  it("KPR-347 T1: adapter forwards assembly instructions verbatim to the provider SDK", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult() as never);

    await makeAdapter({
      assembly: makeAssembly({ instructions: "soul\n\nsystem" }),
    }).runTurn({ prompt: "hello" });

    expect(AgentMock).toHaveBeenCalledWith({
      name: "Pilot",
      instructions: "soul\n\nsystem",
      model: "gpt-5.4-mini",
    });
  });
});

// --- KPR-348 Task 3: T7 (integration), T1 (containment), T5 (abort) --------

async function withRejectionProbe(fn: () => Promise<void>): Promise<void> {
  const rejections: unknown[] = [];
  const handler = (r: unknown) => rejections.push(r);
  process.on("unhandledRejection", handler);
  try {
    await fn();
    // Let any late (post-resolution) rejection surface before we assert.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", handler);
  }
  expect(rejections).toEqual([]);
}

function pgrepCount(marker: string): number {
  try {
    const out = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
    return out.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function pollUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return pred();
}

describe("OpenAIAgentsAdapter — KPR-348 T7 (bridge integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpBehaviors.clear();
    delete process.env.OPENAI_API_KEY;
  });

  it("in-process fixture echo: gate consulted first → executed → result flows into finalOutput; honest stats", async () => {
    const gate = vi.fn(async () => ({ behavior: "allow" as const }));
    const inproc = makeInProcessServer((s) =>
      s.registerTool("echo", { description: "echo", inputSchema: { text: z.string() } }, async ({ text }) => {
        await new Promise((r) => setTimeout(r, 5)); // ensure toolMs > 0
        return { content: [{ type: "text", text: `echo:${text}` }] };
      }),
    );
    driveNonStreaming("mcp__fixture__echo", { text: "hi" });

    const adapter = makeAdapter({
      assembly: makeAssembly({
        toolInventory: [makeInProcEntry()],
        inProcessServers: { fixture: inproc },
        guardrailGate: gate,
      }),
    });
    const result = await adapter.runTurn({ prompt: "go", workItemContext: { channelId: "C1" } as never });

    expect(gate).toHaveBeenCalledWith({
      toolName: "mcp__fixture__echo",
      input: { text: "hi" },
      workItemContext: expect.objectContaining({ channelId: "C1" }),
    });
    expect(result.text).toContain("echo:hi");
    expect(result.toolCalls).toBe(1);
    expect(result.toolMs).toBeGreaterThan(0);
    expect(result.toolSummary).toBe("mcp__fixture__echo×1");
  });

  it("KPR-354: subagent entry + delegateTurnRunner ⇒ Agent gets a Task tool that reaches the runner", async () => {
    const runner = vi.fn(async () => "delegate result");
    driveNonStreaming("Task", { description: "do", prompt: "do it", subagent_type: "google" });

    const result = await makeAdapter({
      assembly: makeAssembly({
        toolInventory: [makeSubagentEntry("google", "Google MCP")],
        delegateTurnRunner: runner,
      }),
    }).runTurn({ prompt: "delegate please" });

    const agentOptions = AgentMock.mock.calls[0]![0] as { tools?: Array<{ name: string }> };
    expect(agentOptions.tools?.map((t) => t.name)).toEqual(["Task"]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ delegate: "google", prompt: "do it" }),
    );
    expect(result.text).toContain("delegate result");
  });

  it("builtin Read entry executes through the executor and returns cat -n text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kpr348-read-"));
    const file = join(dir, "f.txt");
    writeFileSync(file, "line one\nline two");
    driveNonStreaming("Read", { file_path: file });

    try {
      const result = await makeAdapter({
        assembly: makeAssembly({ toolInventory: [makeBuiltinEntry("Read")] }),
      }).runTurn({ prompt: "read it" });
      expect(result.text).toContain("1\tline one");
      expect(result.text).toContain("2\tline two");
      expect(result.toolCalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("llmMs pin: llmMs === durationMs - toolMs, clamped >= 0; classifyTurnResult → success (§D8 breaker samples tool-free time)", async () => {
    const inproc = makeInProcessServer((s) =>
      s.registerTool("slow", { description: "", inputSchema: {} }, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { content: [{ type: "text", text: "done" }] };
      }),
    );
    driveNonStreaming("mcp__fixture__slow", {});

    const result = await makeAdapter({
      assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }),
    }).runTurn({ prompt: "go" });

    expect(result.toolMs).toBeGreaterThan(0);
    expect(result.llmMs).toBe(result.durationMs - result.toolMs);
    expect(result.llmMs).toBeGreaterThanOrEqual(0);
    expect(classifyTurnResult(result)).toEqual({ outcome: "success" });
  });

  it("streamed variant: production awaits one tool execute → same stats, streamed: true", async () => {
    const inproc = makeInProcessServer((s) =>
      s.registerTool("echo", { description: "", inputSchema: { text: z.string() } }, async ({ text }) => {
        await new Promise((r) => setTimeout(r, 5));
        return { content: [{ type: "text", text: `echo:${text}` }] };
      }),
    );
    runMock.mockImplementationOnce(
      async (agent: { options: { tools?: Array<{ name: string; execute: (i: unknown) => Promise<string> }> } }) => {
        const t = agent.options.tools?.find((x) => x.name === "mcp__fixture__echo");
        const toolResult = t ? await t.execute({ text: "s" }) : undefined;
        const textStream = {
          async *[Symbol.asyncIterator]() {
            yield `saw:${toolResult}`;
          },
        };
        return { finalOutput: "ignored", lastResponseId: "resp_stream", completed: Promise.resolve(), toTextStream: () => textStream };
      },
    );

    const onStream = vi.fn();
    const result = await makeAdapter({
      assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }),
    }).runTurn({ prompt: "stream", onStream });

    expect(result.streamed).toBe(true);
    expect(result.text).toContain("echo:s");
    expect(result.toolCalls).toBe(1);
    expect(result.toolMs).toBeGreaterThan(0);
  });
});

describe("OpenAIAgentsAdapter — KPR-348 T1 (exception containment seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpBehaviors.clear();
    delete process.env.OPENAI_API_KEY;
  });

  it("gate throws every call → turn resolves, error unset, denial text model-visible, classify → success", async () => {
    const inproc = makeInProcessServer((s) =>
      s.registerTool("echo", { description: "", inputSchema: { text: z.string() } }, async ({ text }) => ({
        content: [{ type: "text", text: `echo:${text}` }],
      })),
    );
    driveNonStreaming("mcp__fixture__echo", { text: "x" });

    const result = await makeAdapter({
      assembly: makeAssembly({
        toolInventory: [makeInProcEntry()],
        inProcessServers: { fixture: inproc },
        guardrailGate: async () => {
          throw new Error("gate boom");
        },
      }),
    }).runTurn({ prompt: "go" });

    expect(result.error).toBeUndefined();
    expect(result.text).toContain("denied by policy");
    expect(classifyTurnResult(result)).toEqual({ outcome: "success" });
  });

  it("in-process handler throws → turn resolves, error unset, failure text model-visible, classify → success", async () => {
    const inproc = makeInProcessServer((s) =>
      s.registerTool("boom", { description: "", inputSchema: {} }, async () => {
        throw new Error("handler exploded");
      }),
    );
    driveNonStreaming("mcp__fixture__boom", {});

    const result = await makeAdapter({
      assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }),
    }).runTurn({ prompt: "go" });

    expect(result.error).toBeUndefined();
    expect(result.text).toContain("Tool execution failed");
    expect(classifyTurnResult(result)).toEqual({ outcome: "success" });
  });

  it("breaker-neutrality: 3 consecutive tool-throw turns keep a real ProviderCircuitBreaker closed", async () => {
    const breaker = new ProviderCircuitBreaker("openai", DEFAULT_CIRCUIT_BREAKER_CONFIG);
    for (let i = 0; i < 3; i++) {
      const inproc = makeInProcessServer((s) =>
        s.registerTool("boom", { description: "", inputSchema: {} }, async () => {
          throw new Error("handler exploded");
        }),
      );
      driveNonStreaming("mcp__fixture__boom", {});
      const result = await makeAdapter({
        assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }),
      }).runTurn({ prompt: "go" });
      const permit = breaker.acquire();
      breaker.record(permit, classifyTurnResult(result), result.llmMs);
    }
    expect(breaker.snapshot().state).toBe("closed");
  });

  it("negative-verify: a RAW (unwrapped) throwing execute sets RunResult.error; the real bridge leaves it unset", async () => {
    // Raw: runMock invokes a throwing execute NOT routed through the bridge —
    // the throw propagates to the SDK run loop, surfacing via the adapter's
    // last-resort catch (a documented refinement of spec §Critical-flows T1:
    // it becomes RunResult.error SET, runTurn still RESOLVES rather than
    // rejects). This proves the bridge wrapper — not the adapter catch — is
    // what keeps contained tool faults out of RunResult.error.
    runMock.mockImplementationOnce(async () => {
      const rawExecute = async () => {
        throw new Error("unwrapped tool boom");
      };
      await rawExecute();
      return { finalOutput: "unreachable", lastResponseId: "x" };
    });
    const rawResult = await makeAdapter().runTurn({ prompt: "go" });
    expect(rawResult.error).toBe("unwrapped tool boom");
    expect(rawResult.aborted).toBe(false);

    // Bridged: the same underlying fault, this time through the real wrapper.
    const inproc = makeInProcessServer((s) =>
      s.registerTool("boom", { description: "", inputSchema: {} }, async () => {
        throw new Error("unwrapped tool boom");
      }),
    );
    driveNonStreaming("mcp__fixture__boom", {});
    const bridgedResult = await makeAdapter({
      assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }),
    }).runTurn({ prompt: "go" });
    expect(bridgedResult.error).toBeUndefined();
  });
});

describe("OpenAIAgentsAdapter — KPR-348 T5 (abort, adapter half)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpBehaviors.clear();
    delete process.env.OPENAI_API_KEY;
  });

  it("abort during an in-flight in-process tool → aborted result, bridge.close() invoked, wasAborted, no unhandledRejection", async () => {
    await withRejectionProbe(async () => {
      const closeSpy = vi.spyOn(ToolBridge.prototype, "close");
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const inproc = makeInProcessServer((s) =>
        s.registerTool("slow", { description: "", inputSchema: {} }, async () => {
          await gate; // in-flight until the test releases it (after close)
          return { content: [{ type: "text", text: "done" }] };
        }),
      );
      runMock.mockImplementationOnce(
        (agent: { options: { tools?: Array<{ name: string; execute: (i: unknown) => Promise<string> }> } }, _prompt, options: { signal: AbortSignal }) => {
          const t = agent.options.tools?.find((x) => x.name === "mcp__fixture__slow");
          void t?.execute({}); // fire the sleeping tool; never awaited by the model
          return new Promise((_res, rej) => {
            options.signal.addEventListener("abort", () =>
              rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }) as never;
        },
      );

      const adapter = makeAdapter({
        assembly: makeAssembly({ toolInventory: [makeInProcEntry()], inProcessServers: { fixture: inproc } }),
      });
      const promise = adapter.runTurn({ prompt: "go" });
      await new Promise((r) => setTimeout(r, 100)); // let the tool start
      adapter.abort();
      const result = await promise;

      expect(result.aborted).toBe(true);
      expect(adapter.wasAborted).toBe(true);
      expect(closeSpy).toHaveBeenCalled();

      release(); // let the in-flight handler settle; SDK contains send-after-close
      await new Promise((r) => setTimeout(r, 10));
      closeSpy.mockRestore();
    });
  });

  it("abort during a real Bash sleep → child process gone within ~6s (pid probe), aborted result", async () => {
    await withRejectionProbe(async () => {
      const marker = `kpr348-t5-${randomUUID()}`;
      runMock.mockImplementationOnce(
        (agent: { options: { tools?: Array<{ name: string; execute: (i: unknown) => Promise<string> }> } }, _prompt, options: { signal: AbortSignal }) => {
          const t = agent.options.tools?.find((x) => x.name === "Bash");
          void t?.execute({ command: `sleep 30 ; echo ${marker}` });
          return new Promise((_res, rej) => {
            options.signal.addEventListener("abort", () =>
              rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }) as never;
        },
      );

      const adapter = makeAdapter({
        assembly: makeAssembly({ toolInventory: [makeBuiltinEntry("Bash")], sessionCwd: tmpdir() }),
      });
      const promise = adapter.runTurn({ prompt: "go" });
      const started = await pollUntil(() => pgrepCount(marker) > 0, 3000);
      expect(started).toBe(true);
      adapter.abort();
      const result = await promise;
      expect(result.aborted).toBe(true);

      const gone = await pollUntil(() => pgrepCount(marker) === 0, 6000);
      expect(gone).toBe(true);
    });
  }, 15_000);

  it("faulting close: an external server whose close() rejects → runTurn still resolves normally (advisory 1)", async () => {
    await withRejectionProbe(async () => {
      mcpBehaviors.set("extsrv", {
        listTools: async () => [],
        close: async () => {
          throw new Error("close boom");
        },
      });
      runMock.mockResolvedValueOnce(makeSdkResult() as never);

      const result = await makeAdapter({
        assembly: makeAssembly({ toolInventory: [makeExternalEntry("extsrv")] }),
      }).runTurn({ prompt: "go" });

      expect(result.error).toBeUndefined();
      expect(result.aborted).toBe(false);
    });
  });
});

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
