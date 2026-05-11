import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// KPR-122 in-process port: the admin MCP server is now a pure builder
// (`buildAdminTools(deps)`) that returns SDK tool definitions. Tests drive the
// handlers directly without spawning a subprocess. The fake Mongo Db routes
// collection lookups by name so the agent_definitions / agent_definition_versions
// store interactions stay isolated per test.
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    inputSchema: _schema,
    handler,
  })),
}));

let agentDocsStore = new Map<string, any>();
let agentVersionsStore: any[] = [];

function makeAgentDefsCollection(): any {
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
    find: vi.fn((_filter?: any, _opts?: any) => ({
      toArray: vi.fn(async () => [...agentDocsStore.values()]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    })),
    createIndex: vi.fn().mockResolvedValue("ok"),
  };
}

function makeAgentVersionsCollection(): any {
  return {
    insertOne: vi.fn(async (doc: any) => {
      agentVersionsStore.push({ ...doc });
      return { insertedId: "v" };
    }),
    find: vi.fn((_filter?: any) => ({
      toArray: vi.fn(async () => [...agentVersionsStore]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    })),
    createIndex: vi.fn().mockResolvedValue("ok"),
  };
}

function makeFakeDb(): any {
  const defs = makeAgentDefsCollection();
  const versions = makeAgentVersionsCollection();
  return {
    collection: (name: string) => {
      if (name === "agent_definitions") return defs;
      return versions;
    },
  };
}

import { buildAdminTools } from "./admin-mcp-server.js";
// Ensure the software-engineer archetype is registered in the registry.
await import("../archetypes/software-engineer/index.js");

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

function makeBaseAgent(overrides: Record<string, any> = {}): any {
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

function makeTools() {
  return buildAdminTools({
    db: makeFakeDb(),
    agentId: "admin",
    instanceCapabilitiesJson: "{}",
  });
}

describe("admin-mcp-server — agent_create homeBase validation", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
  });

  it("rejects agent_create when homeBase is absent from fields", async () => {
    const tools = makeTools();
    const handler = getHandler(tools, "agent_create");

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
    const handler = getHandler(makeTools(), "agent_create");
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
    const handler = getHandler(makeTools(), "agent_create");
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
    const handler = getHandler(makeTools(), "agent_create");
    const result = await handler({
      _id: "trimmed-agent",
      name: "Trimmed Agent",
      model: "haiku",
      homeBase: "  agent-foo  ",
      roles: ["X"],
    });
    expect(result.isError).toBeFalsy();
    const stored = agentDocsStore.get("trimmed-agent");
    expect(stored).toBeDefined();
    expect(stored.homeBase).toBe("agent-foo");
  });

  it("returns isError when agent already exists", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_create");
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
    agentVersionsStore = [];
  });

  it("applies coreServers baseline when not provided", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "new-agent",
      name: "New",
      model: "claude-haiku-4-5",
      homeBase: "agent-new",
      roles: ["Generic"],
    });
    expect(res.isError).toBeFalsy();
    const doc = agentDocsStore.get("new-agent");
    expect(doc.coreServers).toEqual([
      "memory",
      "structured-memory",
      "keychain",
      "contacts",
      "event-bus",
      "conversation-search",
      "callback",
      "schedule",
      "slack",
    ]);
    expect(doc.delegateServers).toEqual([]);
  });

  it("honors explicit coreServers override", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    await handler({
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
    const handler = getHandler(makeTools(), "agent_create");
    await handler({
      _id: "alex-test",
      name: "Alex",
      model: "claude-sonnet-4-6",
      homeBase: "agent-alex",
      roles: ["Engineering Lead"],
      archetype: "software-engineer",
      title: "Head of Product",
      fields: { archetypeConfig: { workshop: "/tmp", workspaces: [] } },
    });
    const doc = agentDocsStore.get("alex-test");
    expect(doc.archetype).toBe("software-engineer");
    expect(doc.title).toBe("Head of Product");
    expect(doc.archetypeConfig).toEqual({ workshop: "/tmp", workspaces: [] });
  });

  it("rejects unknown archetype", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
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
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
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
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "multi-role",
      name: "Multi",
      model: "claude-haiku-4-5",
      homeBase: "agent-multi",
      roles: ["A", "B"],
    });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("multi-role").roles).toEqual(["A", "B"]);
  });

  it("persists optional aliases when provided as top-level arg", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
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
    const tools = makeTools();
    const create = tools.find((t: any) => t.name === "agent_create")!;
    const { z } = await import("zod");
    const obj = z.object((create as any).inputSchema as Record<string, any>);
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
    const tools = makeTools();
    const create = getHandler(tools, "agent_create");
    await create({
      _id: "rendered-agent",
      name: "Rendered",
      model: "claude-haiku-4-5",
      homeBase: "agent-rendered",
      roles: ["A", "B"],
    });
    const get = getHandler(tools, "agent_get");
    const res = await get({ agent_id: "rendered-agent" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text as string).toMatch(/Roles: A \/ B/);
  });

  it("agent_get renders backfill hint when roles is empty", async () => {
    agentDocsStore.set("no-roles", makeBaseAgent({ _id: "no-roles", roles: [] }));
    const get = getHandler(makeTools(), "agent_get");
    const res = await get({ agent_id: "no-roles" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text as string).toMatch(/Roles: \(not set/);
  });

  it("KPR-220 Phase 4: agent_create writes spawnBudget; agent_get shows the resolved value + source", async () => {
    const tools = makeTools();
    const create = getHandler(tools, "agent_create");
    await create({
      _id: "budget-agent",
      name: "Budget",
      model: "claude-haiku-4-5",
      homeBase: "agent-budget",
      roles: ["X"],
      fields: { spawnBudget: 8 },
    });
    const stored = agentDocsStore.get("budget-agent");
    expect(stored.spawnBudget).toBe(8);

    const get = getHandler(tools, "agent_get");
    const res = await get({ agent_id: "budget-agent" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text as string).toMatch(/Spawn Budget: 8 \(source: spawnBudget\)/);
  });

  it("KPR-220 Phase 4: agent_get reports maxConcurrent fallback when spawnBudget unset", async () => {
    agentDocsStore.set(
      "legacy-agent",
      makeBaseAgent({ _id: "legacy-agent", maxConcurrent: 4 }),
    );
    const res = await getHandler(makeTools(), "agent_get")({ agent_id: "legacy-agent" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text as string).toMatch(
      /Spawn Budget: 4 \(source: maxConcurrent \(deprecated\)\)/,
    );
  });
});

describe("admin-mcp-server — agent_update homeBase passthrough", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
  });

  it("persists homeBase update via agent_update", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent({ homeBase: "agent-existing" }));

    const handler = getHandler(makeTools(), "agent_update");

    const result = await handler({
      agent_id: "existing-agent",
      fields: { homeBase: "new-channel" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/updated/i);
    expect(agentDocsStore.get("existing-agent")?.homeBase).toBe("new-channel");
  });

  it("returns isError when agent_update targets unknown agent", async () => {
    const handler = getHandler(makeTools(), "agent_update");
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
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({
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
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({ agent_id: "someone", archetype: "bookkeeper" });
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
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({ agent_id: "empty-update" });
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
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({ agent_id: "rolly", roles: ["New"] });
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
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({ agent_id: "preserved", title: "New Title" });
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
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({ agent_id: "alias-target", aliases: ["Sam"] });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("alias-target").aliases).toEqual(["Sam"]);
  });
});

describe("list_archetypes", () => {
  it("returns the registered archetype catalog with discovery fields", async () => {
    const handler = getHandler(makeTools(), "list_archetypes");
    const result = await handler({});
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
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
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
    const handler = getHandler(makeTools(), "verify_path");
    const res = await handler({ path: "/tmp" });
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
      const handler = getHandler(makeTools(), "verify_path");
      const res = await handler({ path: filePath });
      expect(res.isError).toBeFalsy();
      const payload = JSON.parse(res.content[0].text as string);
      expect(payload.exists).toBe(true);
      expect(payload.isDirectory).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns exists=false for a missing path without erroring", async () => {
    const handler = getHandler(makeTools(), "verify_path");
    const res = await handler({ path: "/definitely/does/not/exist/anywhere-xyz-123" });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text as string);
    expect(payload.exists).toBe(false);
    expect(payload.isDirectory).toBe(false);
  });

  it("rejects non-absolute paths as isError", async () => {
    const handler = getHandler(makeTools(), "verify_path");
    const res = await handler({ path: "relative/path" });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text as string);
    expect(payload.error).toContain("absolute");
  });

  it("rejects empty path as isError", async () => {
    const handler = getHandler(makeTools(), "verify_path");
    const res = await handler({ path: "" });
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
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({ agent_id: "to-clear", archetype: "" });
    expect(res.isError).toBeFalsy();
    const doc = agentDocsStore.get("to-clear");
    expect(doc.archetype).toBe("");
  });
});

describe("KPR-184 — delegateServers validation rejects in-process-ported servers", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
  });

  const PORTED = [
    "memory",
    "structured-memory",
    "event-bus",
    "callback",
    "contacts",
    "schedule",
    "team",
    "admin",
    "code-search",
    "workflow",
  ];

  it.each(PORTED)("agent_create rejects delegateServers containing '%s'", async (server) => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "bad-delegate",
      name: "Bad",
      model: "claude-haiku-4-5",
      homeBase: "agent-bad",
      roles: ["Generic"],
      fields: { delegateServers: [server] },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("delegateServers");
    expect(res.content[0].text).toContain(server);
    // Reject is hard — agent must NOT be persisted.
    expect(agentDocsStore.has("bad-delegate")).toBe(false);
  });

  it("agent_create rejects when delegateServers mixes valid and invalid entries", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "mixed-delegate",
      name: "Mixed",
      model: "claude-haiku-4-5",
      homeBase: "agent-mixed",
      roles: ["Generic"],
      fields: { delegateServers: ["google", "memory", "linear"] },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("memory");
    expect(agentDocsStore.has("mixed-delegate")).toBe(false);
  });

  it("agent_create accepts delegateServers with only legitimate stdio servers", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "good-delegate",
      name: "Good",
      model: "claude-haiku-4-5",
      homeBase: "agent-good",
      roles: ["Generic"],
      fields: { delegateServers: ["google", "linear", "clickup"] },
    });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("good-delegate")?.delegateServers).toEqual(["google", "linear", "clickup"]);
  });

  it("agent_update rejects delegateServers containing in-process-ported servers", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({
      agent_id: "existing-agent",
      fields: { delegateServers: ["event-bus"] },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("event-bus");
    // Doc must be unchanged.
    expect(agentDocsStore.get("existing-agent").delegateServers).toEqual([]);
  });

  it("agent_update accepts delegateServers update when entries are clean", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({
      agent_id: "existing-agent",
      fields: { delegateServers: ["google"] },
    });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("existing-agent").delegateServers).toEqual(["google"]);
  });
});

describe("KPR-221 — delegateServers validation rejects context-dependent servers", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
  });

  // The unique-to-KPR-221 set: context-dependent but not also in-process
  // ported. Memory, structured-memory, and callback overlap with KPR-184
  // and are caught there first; the other three are uniquely caught here.
  const CONTEXT_DEPENDENT_NEW = ["background", "code-task", "recall"];

  it.each(CONTEXT_DEPENDENT_NEW)("agent_create rejects delegateServers containing '%s'", async (server) => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "bad-context-delegate",
      name: "Bad",
      model: "claude-haiku-4-5",
      homeBase: "agent-bad",
      roles: ["Generic"],
      fields: { delegateServers: [server] },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("context-dependent");
    expect(res.content[0].text).toContain(server);
    expect(agentDocsStore.has("bad-context-delegate")).toBe(false);
  });

  it("agent_create rejects when delegateServers mixes valid and context-dependent entries", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "mixed-context-delegate",
      name: "Mixed",
      model: "claude-haiku-4-5",
      homeBase: "agent-mixed",
      roles: ["Generic"],
      fields: { delegateServers: ["google", "background", "linear"] },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("background");
    expect(agentDocsStore.has("mixed-context-delegate")).toBe(false);
  });

  it("agent_update rejects delegateServers containing context-dependent servers", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({
      agent_id: "existing-agent",
      fields: { delegateServers: ["recall"] },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("recall");
    expect(res.content[0].text).toContain("context-dependent");
    // Doc must be unchanged.
    expect(agentDocsStore.get("existing-agent").delegateServers).toEqual([]);
  });

  it("error message lists all context-dependent servers for operator awareness", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "doc-test",
      name: "Doc",
      model: "claude-haiku-4-5",
      homeBase: "agent-doc",
      roles: ["Generic"],
      fields: { delegateServers: ["background"] },
    });
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    // The full set is enumerated so the operator can see what to avoid.
    for (const s of ["callback", "background", "code-task", "recall", "structured-memory", "memory"]) {
      expect(text).toContain(s);
    }
  });
});
