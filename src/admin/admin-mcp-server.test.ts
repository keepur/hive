import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Strategy: admin-mcp-server.ts uses top-level await (client.connect, index
// creation) and registers tools via side-effects at import time. We mock out
// MongoDB and the MCP SDK so the module can be imported safely, then extract
// the registered tool handlers by intercepting server.registerTool().
//
// The key constraint: vi.mock() factories run before beforeEach, so we cannot
// reinitialize the store reference directly. Instead we use a late-binding
// proxy: makeCollectionStub returns an object whose methods always dereference
// the current value of `agentDocsStore` / `agentVersionsStore` at call time.
// ---------------------------------------------------------------------------

// In-memory stores, reassigned in beforeEach
let agentDocsStore: Map<string, any> = new Map();
let agentVersionsStore: Map<string, any> = new Map();

// Late-binding collection stubs: each method reads the current store variable
// at call time rather than capturing the reference at construction time.
function makeAgentDefsStub() {
  return {
    findOne: vi.fn(async (filter: any) => {
      const id = filter?._id;
      return agentDocsStore.get(id) ?? null;
    }),
    insertOne: vi.fn(async (doc: any) => {
      agentDocsStore.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    }),
    updateOne: vi.fn(async (filter: any, update: any) => {
      const id = filter?._id;
      const d = agentDocsStore.get(id);
      if (d && update.$set) Object.assign(d, update.$set);
      return { modifiedCount: d ? 1 : 0 };
    }),
    deleteOne: vi.fn(async (filter: any) => {
      const had = agentDocsStore.has(filter._id);
      agentDocsStore.delete(filter._id);
      return { deletedCount: had ? 1 : 0 };
    }),
    replaceOne: vi.fn(async (filter: any, doc: any) => {
      agentDocsStore.set(filter._id, { ...doc });
      return { modifiedCount: 1 };
    }),
    find: vi.fn((_filter?: any) => ({
      toArray: vi.fn(async () => [...agentDocsStore.values()]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    })),
    createIndex: vi.fn().mockResolvedValue("ok"),
  };
}

function makeAgentVersionsStub() {
  return {
    findOne: vi.fn(async (filter: any) => {
      const id = filter?._id ?? filter?.agentId;
      return agentVersionsStore.get(id) ?? null;
    }),
    insertOne: vi.fn(async (doc: any) => {
      const key = doc.agentId ?? doc._id;
      agentVersionsStore.set(key, { ...doc });
      return { insertedId: key };
    }),
    updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
    find: vi.fn((_filter?: any) => ({
      toArray: vi.fn(async () => [...agentVersionsStore.values()]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    })),
    createIndex: vi.fn().mockResolvedValue("ok"),
  };
}

// Persistent stubs (constructed once; they late-bind to the store variables)
const agentDefsStub = makeAgentDefsStub();
const agentVersionsStub = makeAgentVersionsStub();

// Captured tool handlers: name → async handler fn
const registeredTools: Map<string, (args: any) => Promise<any>> = new Map();
// Captured tool schemas: name → { description, inputSchema (zod shape) }
const registeredToolSchemas: Map<string, { description?: string; inputSchema?: Record<string, any> }> = new Map();

// Mock the MCP SDK before any import
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: vi.fn((_name: string, _schema: any, handler: any) => {
      registeredTools.set(_name, handler);
      registeredToolSchemas.set(_name, _schema);
    }),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({})),
}));

// Mock MongoDB — collections are routed by name
vi.mock("mongodb", () => ({
  MongoClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    db: vi.fn().mockImplementation(() => ({
      collection: vi.fn().mockImplementation((name: string) => {
        if (name === "agent_definitions") return agentDefsStub;
        return agentVersionsStub;
      }),
    })),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import the server module — triggers top-level await (mocked) and tool registration
await import("./admin-mcp-server.js");
// Ensure the software-engineer archetype is registered in the registry
await import("../archetypes/software-engineer/index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseAgent(overrides: Record<string, any> = {}) {
  return {
    _id: "existing-agent",
    name: "Existing Agent",
    model: "haiku",
    homeBase: "agent-existing",
    channels: ["general"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    coreServers: [],
    delegateServers: [],
    delegatePrompts: {},
    soul: "",
    systemPrompt: "",
    schedule: [],
    budgetUsd: 10,
    maxTurns: 200,
    maxConcurrent: 3,
    timeoutMs: 300_000,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: "admin",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin-mcp-server — agent_create homeBase validation", () => {
  beforeEach(() => {
    // Reset in-memory stores between tests
    agentDocsStore = new Map();
    agentVersionsStore = new Map();
  });

  it("rejects agent_create when homeBase is absent from fields", async () => {
    const handler = registeredTools.get("agent_create")!;
    expect(handler).toBeDefined();

    const result = await handler({
      _id: "new-agent",
      name: "New Agent",
      model: "haiku",
      homeBase: undefined,
      roles: ["X"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/homeBase/);
  });

  it("rejects agent_create when homeBase is empty string", async () => {
    const handler = registeredTools.get("agent_create")!;

    const result = await handler({
      _id: "new-agent",
      name: "New Agent",
      model: "haiku",
      homeBase: "",
      roles: ["X"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/homeBase/);
  });

  it("rejects agent_create when homeBase is whitespace-only", async () => {
    const handler = registeredTools.get("agent_create")!;

    const result = await handler({
      _id: "new-agent",
      name: "New Agent",
      model: "haiku",
      homeBase: "   ",
      roles: ["X"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/homeBase/);
  });

  it("trims homeBase before persisting", async () => {
    const handler = registeredTools.get("agent_create")!;

    const result = await handler({
      _id: "trimmed-agent",
      name: "Trimmed Agent",
      model: "haiku",
      homeBase: "  agent-foo  ",
      roles: ["X"],
    });

    expect(result.isError).toBeFalsy();

    // Verify what was stored
    const stored = agentDocsStore.get("trimmed-agent");
    expect(stored).toBeDefined();
    expect(stored.homeBase).toBe("agent-foo");
  });

  it("rejects agent_create when fields is omitted entirely", async () => {
    const handler = registeredTools.get("agent_create")!;

    const result = await handler({
      _id: "new-agent",
      name: "New Agent",
      model: "haiku",
      homeBase: undefined,
      roles: ["X"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/homeBase/);
  });

  it("returns isError when agent already exists", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = registeredTools.get("agent_create")!;

    const result = await handler({
      _id: "existing-agent",
      name: "Dupe",
      model: "haiku",
      homeBase: "agent-existing",
      roles: ["X"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already exists/);
  });
});

describe("agent_create — schema promotion and archetype support", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = new Map();
  });

  it("applies coreServers baseline when not provided", async () => {
    const handler = registeredTools.get("agent_create");
    const res = await handler!({
      _id: "new-agent",
      name: "New",
      model: "claude-haiku-4-5",
      homeBase: "agent-new",
      roles: ["Generic"],
    });
    expect(res.isError).toBeFalsy();
    const doc = agentDocsStore.get("new-agent");
    expect(doc.coreServers).toEqual(["memory", "structured-memory", "keychain", "event-bus", "contacts"]);
    expect(doc.delegateServers).toEqual([]);
  });

  it("honors explicit coreServers override", async () => {
    const handler = registeredTools.get("agent_create");
    await handler!({
      _id: "explicit-server-agent",
      name: "X",
      model: "claude-haiku-4-5",
      homeBase: "agent-x",
      roles: ["Generic"],
      fields: { coreServers: ["admin"] },
    });
    expect(agentDocsStore.get("explicit-server-agent").coreServers).toEqual(["admin"]);
  });

  it("writes archetype, title, and archetypeConfig into the document", async () => {
    const handler = registeredTools.get("agent_create");
    await handler!({
      _id: "alex-test",
      name: "Alex",
      model: "claude-sonnet-4-6",
      homeBase: "agent-alex",
      roles: ["Engineering Lead"],
      archetype: "software-engineer",
      title: "Head of Product",
      fields: {
        archetypeConfig: { workshop: "/tmp", workspaces: [] },
      },
    });
    const doc = agentDocsStore.get("alex-test");
    expect(doc.archetype).toBe("software-engineer");
    expect(doc.title).toBe("Head of Product");
    expect(doc.archetypeConfig).toEqual({ workshop: "/tmp", workspaces: [] });
  });

  it("rejects unknown archetype", async () => {
    const handler = registeredTools.get("agent_create");
    const res = await handler!({
      _id: "bad-archetype",
      name: "Bad",
      model: "claude-haiku-4-5",
      homeBase: "agent-bad",
      roles: ["Generic"],
      archetype: "bookkeeper",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown archetype");
    expect(agentDocsStore.has("bad-archetype")).toBe(false);
  });

  it("still requires homeBase", async () => {
    const handler = registeredTools.get("agent_create");
    const res = await handler!({
      _id: "no-home",
      name: "No",
      model: "claude-haiku-4-5",
      homeBase: "",
      roles: ["Generic"],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("homeBase");
  });

  it("persists roles array as provided (multiple labels)", async () => {
    const handler = registeredTools.get("agent_create");
    const res = await handler!({
      _id: "multi-role",
      name: "Multi",
      model: "claude-haiku-4-5",
      homeBase: "agent-multi",
      roles: ["A", "B"],
    });
    expect(res.isError).toBeFalsy();
    const doc = agentDocsStore.get("multi-role");
    expect(doc.roles).toEqual(["A", "B"]);
  });

  it("persists optional aliases when provided as top-level arg", async () => {
    const handler = registeredTools.get("agent_create");
    const res = await handler!({
      _id: "aliased",
      name: "Samantha",
      model: "claude-haiku-4-5",
      homeBase: "agent-aliased",
      roles: ["Marketing Ops"],
      aliases: ["Sam"],
    });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("aliased").aliases).toEqual(["Sam"]);
  });

  it("rejects roles=[] at the schema layer (zod .min(1))", async () => {
    // The mock harness bypasses schema validation when calling handlers directly,
    // so we validate the registered zod schema independently.
    const schema = registeredToolSchemas.get("agent_create");
    expect(schema).toBeDefined();
    expect(schema!.inputSchema).toBeDefined();
    const { z } = await import("zod");
    const obj = z.object(schema!.inputSchema as Record<string, any>);
    const result = obj.safeParse({
      _id: "x",
      name: "X",
      model: "haiku",
      homeBase: "agent-x",
      roles: [],
    });
    expect(result.success).toBe(false);
  });

  it("agent_get renders Roles line for an agent with roles", async () => {
    const createHandler = registeredTools.get("agent_create")!;
    await createHandler({
      _id: "rendered-agent",
      name: "Rendered",
      model: "claude-haiku-4-5",
      homeBase: "agent-rendered",
      roles: ["A", "B"],
    });
    const getHandler = registeredTools.get("agent_get")!;
    const res = await getHandler({ agent_id: "rendered-agent" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text as string).toMatch(/Roles: A \/ B/);
  });

  it("agent_get renders backfill hint when roles is empty", async () => {
    agentDocsStore.set("no-roles", makeBaseAgent({ _id: "no-roles", roles: [] }));
    const getHandler = registeredTools.get("agent_get")!;
    const res = await getHandler({ agent_id: "no-roles" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text as string).toMatch(/Roles: \(not set/);
  });
});

describe("admin-mcp-server — agent_update homeBase passthrough", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = new Map();
  });

  it("persists homeBase update via agent_update", async () => {
    // Seed an existing agent
    agentDocsStore.set("existing-agent", makeBaseAgent({ homeBase: "agent-existing" }));

    const handler = registeredTools.get("agent_update")!;
    expect(handler).toBeDefined();

    const result = await handler({
      agent_id: "existing-agent",
      fields: { homeBase: "new-channel" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/updated/i);

    const stored = agentDocsStore.get("existing-agent");
    expect(stored?.homeBase).toBe("new-channel");
  });

  it("returns isError when agent_update targets unknown agent", async () => {
    const handler = registeredTools.get("agent_update")!;

    const result = await handler({
      agent_id: "ghost-agent",
      fields: { homeBase: "somewhere" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });

  it("accepts archetype via top-level promotion", async () => {
    agentDocsStore.set("alex-test", {
      _id: "alex-test",
      name: "Alex",
      model: "claude-sonnet-4-6",
      homeBase: "agent-alex",
      coreServers: ["memory"],
    });
    const handler = registeredTools.get("agent_update");
    const res = await handler!({
      agent_id: "alex-test",
      archetype: "software-engineer",
      title: "Head of Product",
      fields: { archetypeConfig: { workshop: "/tmp", workspaces: [] } },
    });
    expect(res.isError).toBeFalsy();
    const doc = agentDocsStore.get("alex-test");
    expect(doc.archetype).toBe("software-engineer");
    expect(doc.title).toBe("Head of Product");
    expect(doc.archetypeConfig).toEqual({ workshop: "/tmp", workspaces: [] });
  });

  it("rejects unknown archetype on update", async () => {
    agentDocsStore.set("someone", {
      _id: "someone",
      name: "S",
      model: "claude-haiku-4-5",
      homeBase: "agent-s",
    });
    const handler = registeredTools.get("agent_update");
    const res = await handler!({ agent_id: "someone", archetype: "bookkeeper" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Unknown archetype");
  });

  it("errors when no updatable fields are provided", async () => {
    agentDocsStore.set("empty-update", {
      _id: "empty-update",
      name: "E",
      model: "claude-haiku-4-5",
      homeBase: "agent-e",
    });
    const handler = registeredTools.get("agent_update");
    const res = await handler!({ agent_id: "empty-update" });
    expect(res.isError).toBe(true);
  });

  it("updates roles via top-level promotion", async () => {
    agentDocsStore.set("rolly", {
      _id: "rolly",
      name: "Rolly",
      model: "claude-haiku-4-5",
      homeBase: "agent-rolly",
      roles: ["Old"],
    });
    const handler = registeredTools.get("agent_update");
    const res = await handler!({ agent_id: "rolly", roles: ["New"] });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("rolly").roles).toEqual(["New"]);
  });

  it("preserves existing roles when agent_update is called without roles", async () => {
    agentDocsStore.set("preserved", {
      _id: "preserved",
      name: "Preserved",
      model: "claude-haiku-4-5",
      homeBase: "agent-preserved",
      roles: ["Stable"],
    });
    const handler = registeredTools.get("agent_update");
    const res = await handler!({ agent_id: "preserved", title: "New Title" });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("preserved").roles).toEqual(["Stable"]);
    expect(agentDocsStore.get("preserved").title).toBe("New Title");
  });

  it("updates aliases via top-level promotion", async () => {
    agentDocsStore.set("alias-target", {
      _id: "alias-target",
      name: "Samantha",
      model: "claude-haiku-4-5",
      homeBase: "agent-sam",
      roles: ["Marketing Ops"],
      aliases: ["S"],
    });
    const handler = registeredTools.get("agent_update");
    const res = await handler!({ agent_id: "alias-target", aliases: ["Sam"] });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("alias-target").aliases).toEqual(["Sam"]);
  });
});

describe("list_archetypes", () => {
  it("returns the registered archetype catalog with discovery fields", async () => {
    const handler = registeredTools.get("list_archetypes");
    expect(handler).toBeDefined();
    const result = await handler!({});
    const text = result.content[0].text as string;
    const catalog = JSON.parse(text) as Array<{
      id: string;
      description: string | null;
      whenToUse: string | null;
      configSchema: Record<string, unknown> | null;
    }>;
    const se = catalog.find((c) => c.id === "software-engineer");
    expect(se).toBeDefined();
    expect(se?.description).toContain("codebases");
    expect(se?.whenToUse).toContain("production code");
    expect(se?.configSchema).toHaveProperty("workshop");
    expect(se?.configSchema?.workshop).toMatchObject({ type: "string", required: true });
    expect(se?.configSchema?.workspaces).toMatchObject({ type: "array", required: false });
  });
});

describe("agent_create — archetype edge cases", () => {
  it("accepts archetype without archetypeConfig (validateConfig runs at load time, not create)", async () => {
    const handler = registeredTools.get("agent_create");
    const res = await handler!({
      _id: "se-no-config",
      name: "NoConfig",
      model: "claude-sonnet-4-6",
      homeBase: "agent-nc",
      archetype: "software-engineer",
    });
    expect(res.isError).toBeFalsy();
    const doc = agentDocsStore.get("se-no-config");
    expect(doc.archetype).toBe("software-engineer");
    expect(doc.archetypeConfig).toBeUndefined();
  });
});

describe("verify_path", () => {
  it("returns exists+isDirectory for a real directory", async () => {
    const handler = registeredTools.get("verify_path");
    expect(handler).toBeDefined();
    const res = await handler!({ path: "/tmp" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text as string);
    expect(payload.exists).toBe(true);
    expect(payload.isDirectory).toBe(true);
    expect(payload.resolved).toBe("/tmp");
  });

  it("returns isDirectory=false for a path that is a file, not a directory", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "verify-path-"));
    const filePath = join(dir, "f.txt");
    writeFileSync(filePath, "x");
    try {
      const handler = registeredTools.get("verify_path");
      const res = await handler!({ path: filePath });
      expect(res.isError).toBeFalsy();
      const payload = JSON.parse(res.content[0].text as string);
      expect(payload.exists).toBe(true);
      expect(payload.isDirectory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns exists=false for a missing path without erroring", async () => {
    const handler = registeredTools.get("verify_path");
    const res = await handler!({ path: "/definitely/does/not/exist/anywhere-xyz-123" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text as string);
    expect(payload.exists).toBe(false);
    expect(payload.isDirectory).toBe(false);
  });

  it("rejects non-absolute paths as isError", async () => {
    const handler = registeredTools.get("verify_path");
    const res = await handler!({ path: "relative/path" });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text as string);
    expect(payload.error).toContain("absolute");
  });

  it("rejects empty path as isError", async () => {
    const handler = registeredTools.get("verify_path");
    const res = await handler!({ path: "" });
    expect(res.isError).toBe(true);
  });
});

describe("agent_update — archetype clear semantics", () => {
  it("accepts empty-string archetype as an explicit clear (skips registry validation)", async () => {
    agentDocsStore.set("to-clear", {
      _id: "to-clear",
      name: "TC",
      model: "claude-sonnet-4-6",
      homeBase: "agent-tc",
      archetype: "software-engineer",
    });
    const handler = registeredTools.get("agent_update");
    const res = await handler!({ agent_id: "to-clear", archetype: "" });
    expect(res.isError).toBeFalsy();
    const doc = agentDocsStore.get("to-clear");
    expect(doc.archetype).toBe("");
  });
});
