import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpSdkServerConfigWithInstance, SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { ToolBridge, normalizeSchema, shapeCallToolResult } from "./tool-bridge.js";
import type { ToolBridgeOptions } from "./tool-bridge.js";
import { BUILTIN_TOOL_DEFINITIONS } from "./builtin-executor.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import type { ProviderSkillIndexEntry } from "./turn-assembly.js";
// KPR-349 T5/T6: real round-trips through production code paths.
import { AgentRunner } from "../agent-runner.js";
import { buildProviderInstructions } from "../prefix-builder.js";
import { deriveProviderSkillIndex } from "./skill-index.js";
import type { AgentConfig } from "../../types/agent-config.js";

/**
 * KPR-348 Task 1 (Chunk 1): T1 (bridge half), T4, T5 (bridge half), T6, T9.
 * The bridge's three MCP mechanisms:
 *  - external (stdio/http/sse): @openai/agents MCP classes — mocked here.
 *  - in-process (sdk-in-process): real @modelcontextprotocol/sdk McpServer
 *    over the InMemoryTransport the bridge itself constructs.
 */

// --- @openai/agents mock: per-instance behavior keyed by server name -------

interface McpBehavior {
  connect?: () => Promise<void>;
  listTools?: () => Promise<unknown>;
  callTool?: (name: string, args: unknown) => Promise<unknown>;
  close?: () => Promise<void>;
}

const { mcpBehaviors, warnSpy } = vi.hoisted(() => ({
  mcpBehaviors: new Map<string, McpBehavior>(),
  warnSpy: vi.fn(),
}));

vi.mock("@openai/agents", () => {
  function factory() {
    return function (options: { name: string }) {
      const b = mcpBehaviors.get(options.name) ?? {};
      return {
        name: options.name,
        connect: b.connect ?? (async () => {}),
        listTools: b.listTools ?? (async () => []),
        callTool:
          b.callTool ??
          (async () => ({ content: [{ type: "text", text: "ok" }], isError: false })),
        close: b.close ?? (async () => {}),
      };
    };
  }
  return {
    MCPServerStdio: vi.fn(factory()),
    MCPServerStreamableHttp: vi.fn(factory()),
    MCPServerSSE: vi.fn(factory()),
  };
});

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// --- helpers ---------------------------------------------------------------

function setBehavior(name: string, behavior: McpBehavior): void {
  mcpBehaviors.set(name, behavior);
}

function makeEntry(overrides: Partial<HiveToolInventoryEntry> = {}): HiveToolInventoryEntry {
  return {
    name: "srv",
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
    ...overrides,
  };
}

function makeBridge(overrides: Partial<ToolBridgeOptions> = {}): ToolBridge {
  return new ToolBridge({
    inventory: [],
    inProcessServers: {},
    gate: async () => ({ behavior: "allow" }),
    signal: new AbortController().signal,
    agentId: "TestAgent",
    sessionCwd: tmpdir(),
    skillIndex: [],
    ...overrides,
  });
}

/** Build a real in-process McpServer fixture wrapped as the SDK config shape. */
function makeInProcessServer(
  register: (server: McpServer) => void,
): McpSdkServerConfigWithInstance {
  const server = new McpServer({ name: "fixture", version: "1.0.0" });
  register(server);
  return { type: "sdk", name: "fixture", instance: server };
}

beforeEach(() => {
  mcpBehaviors.clear();
  warnSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- T4: materialization ---------------------------------------------------

describe("T4 — materialization", () => {
  it("names MCP tools mcp__<server>__<tool> and never materializes claude-only entries", async () => {
    setBehavior("ext", { listTools: async () => [{ name: "foo", description: "", inputSchema: {} }] });
    const inProcess = makeInProcessServer((s) =>
      s.registerTool("bar", { description: "", inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "ok" }],
      })),
    );

    const bridge = makeBridge({
      inventory: [
        makeEntry({ name: "ext", transport: "stdio" }),
        makeEntry({ name: "inproc", transport: "sdk-in-process", serverConfig: undefined }),
        // claude-builtin entry still {kind:"unavailable"} — must never materialize.
        makeEntry({ name: "Bash", transport: "claude-builtin", schemas: { kind: "unavailable" } }),
      ],
      inProcessServers: { inproc: inProcess },
    });
    const tools = await bridge.connect();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["mcp__ext__foo", "mcp__inproc__bar"]);
    await bridge.close();
  });

  it("normalizes schemas missing required/additionalProperties", async () => {
    setBehavior("ext", {
      listTools: async () => [{ name: "foo", description: "", inputSchema: { type: "object", properties: { a: { type: "string" } } } }],
    });
    const bridge = makeBridge({ inventory: [makeEntry({ name: "ext" })] });
    const tools = await bridge.connect();
    expect(tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: { a: { type: "string" } },
      required: [],
      additionalProperties: false,
    });
    await bridge.close();
  });

  it("normalizeSchema unit cases: undefined, empty, full pass-through", () => {
    expect(normalizeSchema(undefined)).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
    expect(normalizeSchema({})).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
    const full = { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: true };
    expect(normalizeSchema(full)).toEqual(full);
  });

  it("fail-soft: a rejecting connect drops the server and records a runtimeOmission (no throw)", async () => {
    setBehavior("bad", { connect: async () => { throw new Error("connect refused"); } });
    setBehavior("good", { listTools: async () => [{ name: "ok", inputSchema: {} }] });
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "bad" }), makeEntry({ name: "good" })],
    });
    const tools = await bridge.connect();
    expect(tools.map((t) => t.name)).toEqual(["mcp__good__ok"]);
    expect(bridge.runtimeOmissions).toContainEqual({ server: "bad", reason: "Error" });
    await bridge.close();
  });

  it("fail-soft: entry missing serverConfig is omitted, no throw", async () => {
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "noconfig", serverConfig: undefined })],
    });
    const tools = await bridge.connect();
    expect(tools).toEqual([]);
    expect(bridge.runtimeOmissions.some((o) => o.server === "noconfig")).toBe(true);
    await bridge.close();
  });

  it("secrecy: no env value ever reaches logs or omission projections", async () => {
    setBehavior("leaky", { connect: async () => { throw new Error("boom"); } });
    const bridge = makeBridge({
      inventory: [
        makeEntry({
          name: "leaky",
          serverConfig: { command: "node", args: [], env: { API_KEY: "SECRET_SENTINEL" } } as never,
        }),
      ],
    });
    await bridge.connect();
    const logged = JSON.stringify(warnSpy.mock.calls);
    const omissions = JSON.stringify(bridge.runtimeOmissions);
    expect(logged).not.toContain("SECRET_SENTINEL");
    expect(omissions).not.toContain("SECRET_SENTINEL");
    await bridge.close();
  });

  it("shapeCallToolResult joins text with \\n and labels non-text content", () => {
    expect(
      shapeCallToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    ).toBe("a\nb");
    expect(shapeCallToolResult({ content: [{ type: "image", data: "…" }] })).toBe(
      "[non-text content: image — not supported on this provider lane]",
    );
  });

  describe("load_skill (spec §D6)", () => {
    let dir: string;
    let skillPath: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "kpr348-skill-"));
      skillPath = join(dir, "SKILL.md");
      writeFileSync(skillPath, "# Fixture skill\nInstructions here.");
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function skillIndex(): ProviderSkillIndexEntry[] {
      return [{ name: "fixture-skill", description: "A fixture", path: skillPath }];
    }

    it("renders load_skill when index is non-empty and returns SKILL.md content", async () => {
      const bridge = makeBridge({ skillIndex: skillIndex() });
      const tools = await bridge.connect();
      const loadSkill = tools.find((t) => t.name === "load_skill");
      expect(loadSkill).toBeDefined();
      const out = await loadSkill!.execute({ name: "fixture-skill" });
      expect(out).toBe("# Fixture skill\nInstructions here.");
      await bridge.close();
    });

    it("contains unknown skill name as error text (no throw)", async () => {
      const bridge = makeBridge({ skillIndex: skillIndex() });
      const tools = await bridge.connect();
      const loadSkill = tools.find((t) => t.name === "load_skill")!;
      await expect(loadSkill.execute({ name: "nonexistent" })).resolves.toBe(
        "load_skill failed: unknown skill 'nonexistent'",
      );
      await bridge.close();
    });

    it("contains non-string name argument as error text (no throw)", async () => {
      const bridge = makeBridge({ skillIndex: skillIndex() });
      const tools = await bridge.connect();
      const loadSkill = tools.find((t) => t.name === "load_skill")!;
      await expect(loadSkill.execute({ name: 123 })).resolves.toBe(
        "load_skill failed: 'name' must be a string",
      );
      await bridge.close();
    });

    it("omits load_skill entirely when the skill index is empty", async () => {
      const bridge = makeBridge({ skillIndex: [] });
      const tools = await bridge.connect();
      expect(tools.find((t) => t.name === "load_skill")).toBeUndefined();
      await bridge.close();
    });
  });
});

// --- T1 (bridge half): containment ----------------------------------------

describe("T1 — dispatch containment", () => {
  it("gate throw → denial text", async () => {
    setBehavior("ext", { listTools: async () => [{ name: "foo", inputSchema: {} }] });
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "ext" })],
      gate: async () => { throw new Error("gate exploded"); },
    });
    const tools = await bridge.connect();
    await expect(tools[0].execute({})).resolves.toBe(
      "Tool call denied by policy: guardrail gate error: gate exploded",
    );
    await bridge.close();
  });

  it("gate deny → denial text and underlying NOT called", async () => {
    const callSpy = vi.fn(async () => ({ content: [{ type: "text", text: "should not run" }] }));
    setBehavior("ext", { listTools: async () => [{ name: "foo", inputSchema: {} }], callTool: callSpy });
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "ext" })],
      gate: async () => ({ behavior: "deny", reason: "not allowed" }),
    });
    const tools = await bridge.connect();
    await expect(tools[0].execute({})).resolves.toBe("Tool call denied by policy: not allowed");
    expect(callSpy).not.toHaveBeenCalled();
    await bridge.close();
  });

  it("MCP callTool rejection → contained 'Tool execution failed' text", async () => {
    setBehavior("x", {
      listTools: async () => [{ name: "y", inputSchema: {} }],
      callTool: async () => { throw new Error("network down"); },
    });
    const bridge = makeBridge({ inventory: [makeEntry({ name: "x", transport: "stdio" })] });
    // entry name "x" so the tool is mcp__x__y
    const tools = await bridge.connect();
    await expect(tools[0].execute({})).resolves.toBe("Tool execution failed (mcp__x__y): network down");
    await bridge.close();
  });

  it("in-process handler throw → contained text with exact prefix", async () => {
    const inProcess = makeInProcessServer((s) =>
      s.registerTool("boom", { description: "", inputSchema: {} }, async () => {
        throw new Error("handler kaboom");
      }),
    );
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "srv", transport: "sdk-in-process", serverConfig: undefined })],
      inProcessServers: { srv: inProcess },
    });
    const tools = await bridge.connect();
    const result = await tools[0].execute({});
    expect(result).toContain("Tool execution failed (mcp__srv__boom):");
    expect(result).toContain("handler kaboom");
    await bridge.close();
  });

  it("property: every bridged tool resolves to a string on bad input (never rejects)", async () => {
    setBehavior("ext", { listTools: async () => [{ name: "foo", inputSchema: {} }] });
    const inProcess = makeInProcessServer((s) =>
      s.registerTool("bar", { description: "", inputSchema: {} }, async () => ({
        content: [{ type: "text", text: "ok" }],
      })),
    );
    const dir = mkdtempSync(join(tmpdir(), "kpr348-prop-"));
    writeFileSync(join(dir, "SKILL.md"), "skill body");
    const bridge = makeBridge({
      inventory: [
        makeEntry({ name: "ext" }),
        makeEntry({ name: "inproc", transport: "sdk-in-process", serverConfig: undefined }),
      ],
      inProcessServers: { inproc: inProcess },
      skillIndex: [{ name: "s", description: "d", path: join(dir, "SKILL.md") }],
    });
    const tools = await bridge.connect();
    for (const t of tools) {
      await expect(t.execute(undefined)).resolves.toBeTypeOf("string");
      await expect(t.execute("not-json")).resolves.toBeTypeOf("string");
    }
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// --- T6: in-process round-trip --------------------------------------------

describe("T6 — in-process round-trip", () => {
  it("reads a mutable *ContextRef set before connect()", async () => {
    const contextRef = { current: { channel: "C-PLANTED", thread: "T-PLANTED" } };
    const inProcess = makeInProcessServer((s) =>
      s.registerTool("echo_context", { description: "", inputSchema: {} }, async () => ({
        content: [{ type: "text", text: JSON.stringify(contextRef.current) }],
      })),
    );
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "ctx", transport: "sdk-in-process", serverConfig: undefined })],
      inProcessServers: { ctx: inProcess },
    });
    const tools = await bridge.connect();
    const out = await tools[0].execute({});
    expect(out).toContain("C-PLANTED");
    expect(out).toContain("T-PLANTED");
    await bridge.close();
  });

  it("flows the fixture listTools schema into inputSchema", async () => {
    const inProcess = makeInProcessServer((s) =>
      s.registerTool(
        "with_schema",
        { description: "", inputSchema: { value: z.string().describe("v") } },
        async () => ({ content: [{ type: "text", text: "ok" }] }),
      ),
    );
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "sch", transport: "sdk-in-process", serverConfig: undefined })],
      inProcessServers: { sch: inProcess },
    });
    const tools = await bridge.connect();
    const schema = tools[0].inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("value");
    await bridge.close();
  });
});

// --- T5 (bridge half): lifecycle ------------------------------------------

describe("T5 — lifecycle", () => {
  it("close() closes every connection and is idempotent", async () => {
    const closeA = vi.fn(async () => {});
    const closeB = vi.fn(async () => {});
    setBehavior("a", { listTools: async () => [{ name: "t", inputSchema: {} }], close: closeA });
    setBehavior("b", { listTools: async () => [{ name: "t", inputSchema: {} }], close: closeB });
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "a" }), makeEntry({ name: "b" })],
    });
    await bridge.connect();
    await bridge.close();
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
    await bridge.close(); // idempotent — no second close
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("a faulting close() never rejects bridge.close() and the other server still closes", async () => {
    const closeGood = vi.fn(async () => {});
    setBehavior("faulty", {
      listTools: async () => [{ name: "t", inputSchema: {} }],
      close: async () => { throw new Error("close blew up"); },
    });
    setBehavior("healthy", { listTools: async () => [{ name: "t", inputSchema: {} }], close: closeGood });
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "faulty" }), makeEntry({ name: "healthy" })],
    });
    await bridge.connect();
    await expect(bridge.close()).resolves.toBeUndefined();
    expect(closeGood).toHaveBeenCalledTimes(1);
  });

  it("already-aborted signal → aborted text without calling underlying", async () => {
    const callSpy = vi.fn(async () => ({ content: [{ type: "text", text: "ran" }] }));
    setBehavior("ext", { listTools: async () => [{ name: "foo", inputSchema: {} }], callTool: callSpy });
    const controller = new AbortController();
    controller.abort();
    const bridge = makeBridge({
      inventory: [makeEntry({ name: "ext" })],
      signal: controller.signal,
    });
    const tools = await bridge.connect();
    await expect(tools[0].execute({})).resolves.toBe("Tool execution aborted (mcp__ext__foo).");
    expect(callSpy).not.toHaveBeenCalled();
    await bridge.close();
  });
});

// --- T9: name / cap edges --------------------------------------------------

describe("T9 — name and cap edges", () => {
  it("over-long tool name → deterministic mapped name ≤64 that still dispatches", async () => {
    const longTool = "x".repeat(80);
    setBehavior("srv", {
      listTools: async () => [{ name: longTool, inputSchema: {} }],
      callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    });

    const bridge1 = makeBridge({ inventory: [makeEntry({ name: "srv" })] });
    const tools1 = await bridge1.connect();
    const mapped1 = tools1[0].name;
    expect(mapped1.length).toBeLessThanOrEqual(64);
    expect(mapped1).toMatch(/^[a-zA-Z0-9_-]+$/);
    // dispatch still routes despite the provider-facing rename.
    await expect(tools1[0].execute({})).resolves.toBe("ok");
    await bridge1.close();

    const bridge2 = makeBridge({ inventory: [makeEntry({ name: "srv" })] });
    const tools2 = await bridge2.connect();
    expect(tools2[0].name).toBe(mapped1); // deterministic
    await bridge2.close();
  });

  it("two tools sanitizing to the same name → second gets a deterministic suffix", async () => {
    setBehavior("dup", { listTools: async () => [{ name: "same", inputSchema: {} }] });
    const bridge = makeBridge({
      // two inventory entries with the SAME server name both produce mcp__dup__same
      inventory: [makeEntry({ name: "dup" }), makeEntry({ name: "dup" })],
    });
    const tools = await bridge.connect();
    const names = tools.map((t) => t.name);
    expect(names).toContain("mcp__dup__same");
    expect(names).toContain("mcp__dup__same_2");
    await bridge.close();
  });

  it("130 tools → 128 survive, 2 recorded as provider-tool-cap omissions", async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ name: `t${i}`, inputSchema: {} }));
    setBehavior("big", { listTools: async () => many });
    const bridge = makeBridge({ inventory: [makeEntry({ name: "big" })] });
    const tools = await bridge.connect();
    expect(tools).toHaveLength(128);
    const capped = bridge.runtimeOmissions.filter((o) => o.reason === "provider-tool-cap");
    expect(capped).toHaveLength(2);
    await bridge.close();
  });
});

// --- KPR-349 T8: §D7 cap-priority ruling (two-tier pin) --------------------
// Tier 0 — the six executor builtins + load_skill — is structurally
// load-bearing (toolkit + skills prompt sections claim them) and is NEVER
// cap-dropped. Tier 1 (MCP-discovered) keeps inventory order and absorbs the
// entire tail-drop. The 348-shipped tail-splice inverted this: load_skill,
// pushed last in connectInner, was the first casualty.

describe("KPR-349 T8 — §D7 cap-priority (builtins + load_skill pinned)", () => {
  let dir: string;
  let skillPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kpr349-t8-"));
    skillPath = join(dir, "SKILL.md");
    writeFileSync(skillPath, "# T8 fixture skill\nbody");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const BUILTIN_NAMES = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];

  /**
   * 125 MCP tools (mcp__big__t0..t124) + 6 static builtins + load_skill = 132.
   * connectInner order: external MCP → in-process → builtins → load_skill, so
   * every MCP tool precedes every builtin, and load_skill is dead last.
   */
  function overCapBridge(mcpCount = 125): ToolBridge {
    const many = Array.from({ length: mcpCount }, (_, i) => ({ name: `t${i}`, inputSchema: {} }));
    setBehavior("big", { listTools: async () => many });
    return makeBridge({
      inventory: [
        makeEntry({ name: "big", transport: "stdio" }),
        makeEntry({
          name: "builtins",
          transport: "claude-builtin",
          serverConfig: undefined,
          schemas: { kind: "static", tools: BUILTIN_TOOL_DEFINITIONS },
        }),
      ],
      skillIndex: [{ name: "fixture-skill", description: "A fixture", path: skillPath }],
    });
  }

  it("pins builtins + load_skill and tail-drops the last 4 Tier-1 MCP tools", async () => {
    const bridge = overCapBridge(125);
    const tools = await bridge.connect();

    // Exactly at the cap.
    expect(tools).toHaveLength(128);

    const names = tools.map((t) => t.name);
    // Every pinned tool survived.
    for (const b of BUILTIN_NAMES) expect(names).toContain(b);
    expect(names).toContain("load_skill");

    // The four dropped are the LAST four Tier-1 tools in inventory order.
    const droppedNames = ["mcp__big__t121", "mcp__big__t122", "mcp__big__t123", "mcp__big__t124"];
    for (const d of droppedNames) expect(names).not.toContain(d);
    // The one just above the drop line survived.
    expect(names).toContain("mcp__big__t120");

    // Exactly four provider-tool-cap omissions, for those four names.
    const capped = bridge.runtimeOmissions.filter((o) => o.reason === "provider-tool-cap");
    expect(capped).toHaveLength(4);
    expect(capped.map((o) => o.server).sort()).toEqual([...droppedNames].sort());

    await bridge.close();
  });

  it("preserves original relative order — pinned tools are NOT hoisted to the front", async () => {
    const bridge = overCapBridge(125);
    const tools = await bridge.connect();
    const names = tools.map((t) => t.name);

    // mcp__big__t0 precedes Bash in the input inventory order; it must still
    // precede Bash in the output (no reordering of survivors to the front).
    expect(names.indexOf("mcp__big__t0")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("mcp__big__t0")).toBeLessThan(names.indexOf("Bash"));
    // load_skill remains last, as assembled.
    expect(names[names.length - 1]).toBe("load_skill");

    await bridge.close();
  });

  it("under the cap — builtins + load_skill present, list passes through untouched", async () => {
    const bridge = overCapBridge(10); // 10 MCP + 6 builtins + load_skill = 17
    const tools = await bridge.connect();
    const names = tools.map((t) => t.name);

    const expected = [
      ...Array.from({ length: 10 }, (_, i) => `mcp__big__t${i}`),
      ...BUILTIN_NAMES,
      "load_skill",
    ];
    expect(names).toEqual(expected); // exact contents AND order preserved

    // No cap omissions.
    expect(bridge.runtimeOmissions.filter((o) => o.reason === "provider-tool-cap")).toHaveLength(0);

    await bridge.close();
  });
});

// --- KPR-349 T5: memory tools pin (integration) ---------------------------
// Real AgentRunner → real in-process memory + structured-memory McpServers →
// real bridge → real InMemoryTransport round-trip. Fake Mongo db (handlers
// close over it; no real connection). Proves the memory family bridges and
// dispatches, not a synthetic fixture.

function makeMemMgr(): unknown {
  return {
    read: async () => null,
    write: async () => {},
    list: async () => [],
    delete: async () => {},
    history: async () => [],
    rollback: async () => {},
    getHotTierPrompt: async () => null,
  };
}

function makeFakeInProcessDb(): unknown {
  const col = {
    findOne: async () => null,
    find: () => ({
      project: () => ({ toArray: async () => [] }),
      toArray: async () => [],
      sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
    }),
    insertOne: async () => ({}),
    updateOne: async () => ({}),
    deleteOne: async () => ({}),
    deleteMany: async () => ({}),
    createIndex: async () => "idx",
    countDocuments: async () => 0,
  };
  return { collection: () => col };
}

function makeMemoryAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "mem-agent",
    name: "MemAgent",
    model: "openai/gpt-5.4-mini",
    channels: [],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    icon: "",
    coreServers: ["memory"],
    delegateServers: [],
    soul: "mem soul",
    systemPrompt: "mem system",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}

function makeMemoryRunner(): AgentRunner {
  // Constructor: (config, memoryManager, plugins, skillIndex, eventSubscribersJson,
  // prefetcher, teamRoster, db, ...). db present → in-process memory family wires.
  return new AgentRunner(
    makeMemoryAgentConfig(),
    makeMemMgr() as never,
    [],
    new Map(),
    "{}",
    undefined,
    undefined,
    makeFakeInProcessDb() as never,
  );
}

describe("KPR-349 T5 — memory tools pin (real AgentRunner + bridge)", () => {
  it("bridges memory + structured-memory and round-trips a real view/recall call", async () => {
    const runner = makeMemoryRunner();
    const inventory = runner
      .buildToolTransportInventory()
      .filter((e) => e.transport === "sdk-in-process");
    const inProcessServers = runner.buildInProcessServers();
    const bridge = new ToolBridge({
      inventory,
      inProcessServers,
      gate: async () => ({ behavior: "allow" }),
      signal: new AbortController().signal,
      agentId: "mem-agent",
      sessionCwd: tmpdir(),
      skillIndex: [],
    });
    const tools = await bridge.connect();
    const names = tools.map((t) => t.name);
    expect(names).toContain("mcp__memory__view");
    expect(names.some((n) => n.startsWith("mcp__structured-memory__"))).toBe(true);

    // Real round-trip through the memory handler — not a synthetic fixture.
    const view = tools.find((t) => t.name === "mcp__memory__view")!;
    const viewOut = await view.execute({ path: "/memories" });
    expect(typeof viewOut).toBe("string");
    expect(viewOut.startsWith("Tool execution failed")).toBe(false);

    // Structured-memory recall — content not asserted, only non-throw/string.
    const recall = tools.find((t) => t.name === "mcp__structured-memory__memory_recall")!;
    const recallOut = await recall.execute({ query: "x" });
    expect(typeof recallOut).toBe("string");

    await expect(bridge.close()).resolves.toBeUndefined();
  });

  it("file-tier guidance renders iff the memory entry is in the inventory", async () => {
    const runner = makeMemoryRunner();
    const inventory = runner
      .buildToolTransportInventory()
      .filter((e) => e.transport === "sdk-in-process");
    expect(inventory.some((e) => e.name === "memory")).toBe(true);
    const cfg = makeMemoryAgentConfig();
    const memMgr = makeMemMgr();
    const withMem = await buildProviderInstructions(cfg, {
      toolInventory: inventory,
      skillIndex: [],
      toolsExecutable: true,
      memoryManager: memMgr as never,
      plugins: [],
    });
    expect(withMem.instructions).toContain("## File-Tier Memory");
    const withoutMem = await buildProviderInstructions(cfg, {
      toolInventory: inventory.filter((e) => e.name !== "memory"),
      skillIndex: [],
      toolsExecutable: true,
      memoryManager: memMgr as never,
      plugins: [],
    });
    expect(withoutMem.instructions).not.toContain("## File-Tier Memory");
  });
});

// --- KPR-349 T6: load_skill end-to-end ------------------------------------
// deriveProviderSkillIndex (real plugin-tree read) → bridge load_skill →
// real SKILL.md read-and-return, plus the deny-gate and empty-index dark pin.

describe("KPR-349 T6 — load_skill end-to-end", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kpr349-e2e-skill-"));
    mkdirSync(join(dir, "skills", "golden-e2e"), { recursive: true });
    writeFileSync(
      join(dir, "skills", "golden-e2e", "SKILL.md"),
      "---\nname: golden-e2e\ndescription: E2E fixture skill\n---\nE2E-SKILL-BODY: follow these steps.\n",
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function e2eIndex(): ProviderSkillIndexEntry[] {
    const plugins: SdkPluginConfig[] = [{ type: "local", path: dir }];
    return deriveProviderSkillIndex(plugins);
  }

  function makeSkillBridge(
    skillIndex: ProviderSkillIndexEntry[],
    gate: ToolBridgeOptions["gate"] = async () => ({ behavior: "allow" }),
  ): ToolBridge {
    return new ToolBridge({
      inventory: [],
      inProcessServers: {},
      gate,
      signal: new AbortController().signal,
      agentId: "skill-agent",
      sessionCwd: tmpdir(),
      skillIndex,
    });
  }

  it("derives one entry and load_skill returns the SKILL.md body", async () => {
    const index = e2eIndex();
    expect(index).toHaveLength(1);
    const bridge = makeSkillBridge(index);
    const tools = await bridge.connect();
    const loadSkill = tools.find((t) => t.name === "load_skill");
    expect(loadSkill).toBeDefined();
    const out = await loadSkill!.execute({ name: "golden-e2e" });
    expect(out).toContain("E2E-SKILL-BODY");
    await bridge.close();
  });

  it("unknown skill name → contained error text", async () => {
    const bridge = makeSkillBridge(e2eIndex());
    const tools = await bridge.connect();
    const loadSkill = tools.find((t) => t.name === "load_skill")!;
    await expect(loadSkill.execute({ name: "nope" })).resolves.toBe(
      "load_skill failed: unknown skill 'nope'",
    );
    await bridge.close();
  });

  it("deny-all gate → load_skill dispatch is blocked by policy", async () => {
    const bridge = makeSkillBridge(e2eIndex(), async () => ({ behavior: "deny", reason: "e2e-denied" }));
    const tools = await bridge.connect();
    const loadSkill = tools.find((t) => t.name === "load_skill")!;
    await expect(loadSkill.execute({ name: "golden-e2e" })).resolves.toBe(
      "Tool call denied by policy: e2e-denied",
    );
    await bridge.close();
  });

  it("dark pin: empty skillIndex → no load_skill in the bridged tool list (348 invariant)", async () => {
    const bridge = makeSkillBridge([]);
    const tools = await bridge.connect();
    expect(tools.find((t) => t.name === "load_skill")).toBeUndefined();
    await bridge.close();
  });
});
