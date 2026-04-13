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

// Mock the MCP SDK before any import
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: vi.fn((_name: string, _schema: any, handler: any) => {
      registeredTools.set(_name, handler);
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

    const result = await handler({ _id: "new-agent", name: "New Agent", model: "haiku", fields: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/homeBase/);
  });

  it("rejects agent_create when homeBase is empty string", async () => {
    const handler = registeredTools.get("agent_create")!;

    const result = await handler({
      _id: "new-agent",
      name: "New Agent",
      model: "haiku",
      fields: { homeBase: "" },
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
      fields: { homeBase: "   " },
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
      fields: { homeBase: "  agent-foo  " },
    });

    expect(result.isError).toBeFalsy();

    // Verify what was stored
    const stored = agentDocsStore.get("trimmed-agent");
    expect(stored).toBeDefined();
    expect(stored.homeBase).toBe("agent-foo");
  });

  it("rejects agent_create when fields is omitted entirely", async () => {
    const handler = registeredTools.get("agent_create")!;

    const result = await handler({ _id: "new-agent", name: "New Agent", model: "haiku" });

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
      fields: { homeBase: "agent-existing" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already exists/);
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
});
