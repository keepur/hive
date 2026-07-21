import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { ToolBridge, normalizeSchema, shapeCallToolResult } from "./tool-bridge.js";
import type { ToolBridgeOptions } from "./tool-bridge.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import type { ProviderSkillIndexEntry } from "./turn-assembly.js";

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
