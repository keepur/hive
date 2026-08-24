import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// KPR-381: admin-mcp-server now imports the config singleton for the gemini
// key. Mock it — the real config.ts throws on missing SLACK_* env at import.
const mockConfig = vi.hoisted(() => ({ gemini: { apiKey: "test-gemini-key" } }));
vi.mock("../config.js", () => ({ config: mockConfig }));

let agentDocsStore = new Map<string, any>();
let agentVersionsStore: any[] = [];
let catalogDocsStore = new Map<string, any>();
let catalogVersionsStore: any[] = [];

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

function makeCatalogDocsCollection(): any {
  return {
    findOne: vi.fn(async (filter: any) => catalogDocsStore.get(filter?._id) ?? null),
    updateOne: vi.fn(async (filter: any, update: any, opts: any) => {
      const id = filter?._id;
      const existing = catalogDocsStore.get(id);
      if (existing && update.$set) Object.assign(existing, update.$set);
      else if (opts?.upsert) catalogDocsStore.set(id, { _id: id, ...update.$set });
      return { modifiedCount: existing ? 1 : 0 };
    }),
    createIndex: vi.fn().mockResolvedValue("ok"),
  };
}

function makeCatalogVersionsCollection(): any {
  return {
    insertOne: vi.fn(async (doc: any) => {
      catalogVersionsStore.push({ ...doc });
      return { insertedId: "cv" };
    }),
    createIndex: vi.fn().mockResolvedValue("ok"),
  };
}

function makeFakeDb(): any {
  const defs = makeAgentDefsCollection();
  const versions = makeAgentVersionsCollection();
  const catalogDocs = makeCatalogDocsCollection();
  const catalogVersions = makeCatalogVersionsCollection();
  return {
    collection: (name: string) => {
      if (name === "agent_definitions") return defs;
      if (name === "agent_model_catalog") return catalogDocs;
      if (name === "agent_model_catalog_versions") return catalogVersions;
      return versions;
    },
  };
}

import { buildAdminTools } from "./admin-mcp-server.js";
import { invalidateGeminiModelCache } from "./model-catalog-cache.js";
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
    agentDocsStore.set("legacy-agent", makeBaseAgent({ _id: "legacy-agent", maxConcurrent: 4 }));
    const res = await getHandler(makeTools(), "agent_get")({ agent_id: "legacy-agent" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text as string).toMatch(/Spawn Budget: 4 \(source: maxConcurrent \(deprecated\)\)/);
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

describe("toolSearch validation (KPR-329)", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
  });

  it("agent_create rejects an invalid toolSearch value", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "bad-toolsearch",
      name: "Bad",
      model: "claude-haiku-4-5",
      homeBase: "agent-bad-ts",
      roles: ["Generic"],
      fields: { toolSearch: "always" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid toolSearch");
    expect(agentDocsStore.has("bad-toolsearch")).toBe(false);
  });

  it("agent_create persists a valid toolSearch value", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const res = await handler({
      _id: "good-toolsearch",
      name: "Good",
      model: "claude-haiku-4-5",
      homeBase: "agent-good-ts",
      roles: ["Generic"],
      fields: { toolSearch: "off" },
    });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("good-toolsearch").toolSearch).toBe("off");
  });

  it("agent_create leaves toolSearch absent when omitted", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    await handler({
      _id: "no-toolsearch",
      name: "NoTS",
      model: "claude-haiku-4-5",
      homeBase: "agent-no-ts",
      roles: ["Generic"],
      fields: {},
    });
    expect(agentDocsStore.get("no-toolsearch").toolSearch).toBeUndefined();
  });

  it("agent_update rejects an invalid toolSearch value without writing", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({
      agent_id: "existing-agent",
      fields: { toolSearch: "TRUE" },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Invalid toolSearch");
    expect(agentDocsStore.get("existing-agent").toolSearch).toBeUndefined();
  });

  it("agent_update accepts a valid toolSearch value", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_update");
    const res = await handler({
      agent_id: "existing-agent",
      fields: { toolSearch: "on" },
    });
    expect(res.isError).toBeFalsy();
    expect(agentDocsStore.get("existing-agent").toolSearch).toBe("on");
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

describe("KPR-308 — floorCritical write boundary", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
  });

  it("agent_create persists floorCritical: true from the fields bag", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const result = await handler({
      _id: "floor-agent",
      name: "Floor Agent",
      model: "haiku",
      homeBase: "agent-floor",
      roles: ["Shop Floor"],
      fields: { floorCritical: true },
    });
    expect(result.isError).toBeUndefined();
    expect(agentDocsStore.get("floor-agent").floorCritical).toBe(true);
  });

  it("agent_create defaults floorCritical to false when absent", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    await handler({ _id: "plain-agent", name: "Plain", model: "haiku", homeBase: "agent-plain", roles: ["X"] });
    expect(agentDocsStore.get("plain-agent").floorCritical).toBe(false);
  });

  it("agent_update round-trips floorCritical", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_update");
    const result = await handler({ agent_id: "existing-agent", fields: { floorCritical: true } });
    expect(result.isError).toBeUndefined();
    expect(agentDocsStore.get("existing-agent").floorCritical).toBe(true);

    await handler({ agent_id: "existing-agent", fields: { floorCritical: false } });
    expect(agentDocsStore.get("existing-agent").floorCritical).toBe(false);
  });

  it("agent_update coerces garbage floorCritical to strict false", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_update");
    await handler({ agent_id: "existing-agent", fields: { floorCritical: "yes" } });
    expect(agentDocsStore.get("existing-agent").floorCritical).toBe(false);
  });
});

describe("admin-mcp-server — agent_model_catalog_refresh (KPR-381)", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
    catalogDocsStore = new Map();
    catalogVersionsStore = [];
    mockConfig.gemini.apiKey = "test-gemini-key";
  });

  it("upserts the catalog doc and appends a version row", async () => {
    const handler = getHandler(makeTools(), "agent_model_catalog_refresh");
    const result = await handler({
      provider: "grok",
      models: [
        { id: "grok-4.6", displayName: "Grok 4.6", notes: "subscription default" },
        { id: "grok-4.5", displayName: "Grok 4.5" },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/grok catalog updated: \+2 \(grok-4\.6, grok-4\.5\), -0\. 2 models total\./);

    const doc = catalogDocsStore.get("grok");
    expect(doc.provider).toBe("grok");
    expect(doc.models).toHaveLength(2);
    expect(doc.models[0].addedAt).toBeInstanceOf(Date);
    expect(doc.updatedBy).toBe("admin");
    expect(doc.updatedAt).toBeInstanceOf(Date);

    expect(catalogVersionsStore).toHaveLength(1);
    expect(catalogVersionsStore[0].provider).toBe("grok");
    expect(catalogVersionsStore[0].snapshot).toHaveLength(2);
    expect(catalogVersionsStore[0].changeSummary).toMatch(/\+2/);
    expect(catalogVersionsStore[0].createdAt).toBeInstanceOf(Date);
    expect(catalogVersionsStore[0].updatedBy).toBe("admin");
  });

  it("diffs against the current doc and preserves addedAt for retained ids", async () => {
    const handler = getHandler(makeTools(), "agent_model_catalog_refresh");
    const oldDate = new Date("2026-01-01T00:00:00Z");
    catalogDocsStore.set("claude", {
      _id: "claude",
      provider: "claude",
      models: [
        { id: "claude-opus-5", displayName: "Opus 5", addedAt: oldDate },
        { id: "claude-opus-4-7", displayName: "Opus 4.7", addedAt: oldDate },
      ],
      updatedAt: oldDate,
      updatedBy: "seed",
    });

    const result = await handler({
      provider: "claude",
      models: [
        { id: "claude-opus-5", displayName: "Opus 5" },
        { id: "claude-opus-6", displayName: "Opus 6" },
      ],
      changeSummary: "Opus 6 shipped; 4.7 deprecated",
    });
    expect(result.content[0].text).toMatch(/\+1 \(claude-opus-6\), -1 \(claude-opus-4-7\)\. 2 models total/);
    expect(result.content[0].text).toMatch(/Opus 6 shipped/);

    const doc = catalogDocsStore.get("claude");
    const retained = doc.models.find((m: any) => m.id === "claude-opus-5");
    const fresh = doc.models.find((m: any) => m.id === "claude-opus-6");
    expect(retained.addedAt).toEqual(oldDate);
    expect(fresh.addedAt.getTime()).toBeGreaterThan(oldDate.getTime());
    expect(catalogVersionsStore[0].changeSummary).toBe("Opus 6 shipped; 4.7 deprecated");
  });

  it("rejects duplicate model ids", async () => {
    const handler = getHandler(makeTools(), "agent_model_catalog_refresh");
    const result = await handler({
      provider: "codex",
      models: [
        { id: "gpt-5.5", displayName: "GPT-5.5" },
        { id: "gpt-5.5", displayName: "GPT-5.5 again" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Duplicate model ids/);
    expect(catalogDocsStore.size).toBe(0);
    expect(catalogVersionsStore).toHaveLength(0);
  });

  it("an explicit empty changeSummary falls back to the diff text — no blank audit row", async () => {
    const handler = getHandler(makeTools(), "agent_model_catalog_refresh");
    const result = await handler({
      provider: "codex",
      models: [{ id: "gpt-5.5", displayName: "GPT-5.5" }],
      changeSummary: "",
    });
    expect(result.isError).toBeUndefined();
    // Response text omits the empty summary; the version row must not be blank.
    expect(result.content[0].text).toBe("codex catalog updated: +1 (gpt-5.5), -0. 1 models total.");
    expect(catalogVersionsStore[0].changeSummary).toBe("+1 (gpt-5.5), -0");
  });

  it("excludes gemini at the Zod schema level — no handler rejection needed", () => {
    const tools = makeTools();
    const t = tools.find((x: any) => x.name === "agent_model_catalog_refresh")!;
    const providerSchema = (t.inputSchema as any).provider;
    expect(providerSchema.safeParse("gemini").success).toBe(false);
    expect(providerSchema.safeParse("claude").success).toBe(true);
    expect(providerSchema.safeParse("grok").success).toBe(true);
    expect(providerSchema.safeParse("codex").success).toBe(true);
  });
});

describe("admin-mcp-server — agent_model_catalog_list (KPR-381)", () => {
  const geminiOkResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      models: [
        {
          name: "models/gemini-3.1-pro-preview",
          displayName: "Gemini 3.1 Pro Preview",
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
        {
          name: "models/gemini-3.1-flash-image-preview",
          displayName: "Nano Banana 2",
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/text-embedding-005",
          displayName: "Text Embedding 005",
          supportedGenerationMethods: ["embedContent"],
        },
        {
          name: "models/veo-3.1-generate-preview",
          displayName: "Veo 3.1",
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    }),
  };

  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
    catalogDocsStore = new Map();
    catalogVersionsStore = [];
    invalidateGeminiModelCache();
    mockConfig.gemini.apiKey = "test-gemini-key";
    // KPR-382: the gemini leg now reads the adapter's env fallbacks — clear
    // any ambient dev-machine keys so missing-key tests stay deterministic.
    vi.stubEnv("GOOGLE_GENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function seedGrok() {
    catalogDocsStore.set("grok", {
      _id: "grok",
      provider: "grok",
      models: [
        { id: "grok-4.6", displayName: "Grok 4.6", notes: "subscription default", addedAt: new Date() },
        { id: "grok-4.5", displayName: "Grok 4.5", addedAt: new Date() },
      ],
      updatedAt: new Date("2026-08-23T00:00:00Z"),
      updatedBy: "hermi",
    });
  }

  it("returns curated entries with source/asOf for a seeded provider", async () => {
    seedGrok();
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "grok" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([
      {
        provider: "grok",
        id: "grok-4.6",
        displayName: "Grok 4.6",
        notes: "subscription default",
        source: "curated",
        asOf: "2026-08-23T00:00:00.000Z",
      },
      {
        provider: "grok",
        id: "grok-4.5",
        displayName: "Grok 4.5",
        source: "curated",
        asOf: "2026-08-23T00:00:00.000Z",
      },
    ]);
  });

  it("unseeded curated provider → empty entries array + prose note, not an error", async () => {
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "codex" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([]);
    expect(result.content[1].text).toMatch(/codex: not yet seeded — call agent_model_catalog_refresh first/);
  });

  it("gemini live lookup uses x-goog-api-key HEADER auth — key never in the URL", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse);
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; signal?: AbortSignal },
    ];
    expect(init.headers["x-goog-api-key"]).toBe("test-gemini-key");
    expect(url).not.toContain("test-gemini-key");
    expect(url).not.toContain("key=");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const parsed = JSON.parse(result.content[0].text);
    // Filtered: embedding (no generateContent), image + veo (family regex).
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      provider: "gemini",
      id: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro Preview",
      source: "live",
    });
    expect(typeof parsed[0].asOf).toBe("string");
  });

  it("second call within TTL serves the cache — zero extra fetches", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse);
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    await handler({ provider: "gemini" });
    await handler({ provider: "gemini" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("missing gemini key + provider=gemini → isError with credentials-add remediation", async () => {
    mockConfig.gemini.apiKey = "";
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/hive credentials add GEMINI_API_KEY/);
  });

  it("vendor 500 + provider=gemini → sanitized status-only error, no key, no URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Gemini model lookup failed: vendor returned HTTP 500.");
    expect(result.content[0].text).not.toContain("test-gemini-key");
    expect(result.content[0].text).not.toContain("generativelanguage");
  });

  it("network-level rejection → fixed sanitized message, never String(err)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED https://generativelanguage.googleapis.com/v1beta/models?leak=1");
      }),
    );
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/network error/);
    expect(result.content[0].text).not.toContain("leak=1");
  });

  it("all-4 listing with a failed gemini leg → partial results + prose note, NOT isError", async () => {
    seedGrok();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })),
    );
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.every((e: any) => e.provider !== "gemini")).toBe(true);
    expect(parsed.filter((e: any) => e.provider === "grok")).toHaveLength(2);
    const noteTexts = result.content
      .slice(1)
      .map((c: any) => c.text)
      .join("\n");
    expect(noteTexts).toMatch(/claude: not yet seeded/);
    expect(noteTexts).toMatch(/codex: not yet seeded/);
    expect(noteTexts).toMatch(/gemini: Gemini model lookup failed: vendor returned HTTP 429\./);
  });

  it("all-4 listing with a missing gemini key → partial results + prose note, NOT isError", async () => {
    seedGrok();
    mockConfig.gemini.apiKey = "";
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const noteTexts = result.content
      .slice(1)
      .map((c: any) => c.text)
      .join("\n");
    expect(noteTexts).toMatch(/gemini: Gemini API key not configured/);
  });

  const geminiZeroUsableResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      models: [
        {
          name: "models/text-embedding-005",
          displayName: "Text Embedding 005",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    }),
  };

  it("gemini-only: 200 with zero usable chat models → empty array + note, NOT isError (mirrors unseeded-curated shape)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => geminiZeroUsableResponse),
    );
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual([]);
    expect(result.content[1].text).toBe("gemini: vendor returned no usable chat models.");
  });

  it("all-4 listing: gemini 200 with zero usable chat models → note present alongside curated results", async () => {
    seedGrok();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => geminiZeroUsableResponse),
    );
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.every((e: any) => e.provider !== "gemini")).toBe(true);
    expect(parsed.filter((e: any) => e.provider === "grok")).toHaveLength(2);
    const noteTexts = result.content
      .slice(1)
      .map((c: any) => c.text)
      .join("\n");
    expect(noteTexts).toMatch(/gemini: vendor returned no usable chat models\./);
  });

  // ------------------------------------------------------------------
  // KPR-382: gemini key fallback chain — mirror of the adapter's
  // resolution (gemini-interactions-adapter.ts:194-198).
  // ------------------------------------------------------------------

  function headerKeyOf(fetchMock: ReturnType<typeof vi.fn>): string {
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    return init.headers["x-goog-api-key"];
  }

  it("falls back to GOOGLE_GENAI_API_KEY when the config key is empty (KPR-382)", async () => {
    mockConfig.gemini.apiKey = "";
    vi.stubEnv("GOOGLE_GENAI_API_KEY", "genai-fallback-key");
    const fetchMock = vi.fn(async () => geminiOkResponse);
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBeUndefined();
    expect(headerKeyOf(fetchMock)).toBe("genai-fallback-key");
    expect(JSON.parse(result.content[0].text)).toHaveLength(1);
  });

  it("falls back to GOOGLE_API_KEY as the last resort (KPR-382)", async () => {
    mockConfig.gemini.apiKey = "";
    vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
    const fetchMock = vi.fn(async () => geminiOkResponse);
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBeUndefined();
    expect(headerKeyOf(fetchMock)).toBe("google-fallback-key");
  });

  it("config.gemini.apiKey wins over env fallbacks (KPR-382)", async () => {
    vi.stubEnv("GOOGLE_GENAI_API_KEY", "genai-fallback-key");
    vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
    const fetchMock = vi.fn(async () => geminiOkResponse);
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    await handler({ provider: "gemini" });
    expect(headerKeyOf(fetchMock)).toBe("test-gemini-key");
  });

  it("GOOGLE_GENAI_API_KEY beats GOOGLE_API_KEY — adapter order (KPR-382)", async () => {
    mockConfig.gemini.apiKey = "";
    vi.stubEnv("GOOGLE_GENAI_API_KEY", "genai-fallback-key");
    vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
    const fetchMock = vi.fn(async () => geminiOkResponse);
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    await handler({ provider: "gemini" });
    expect(headerKeyOf(fetchMock)).toBe("genai-fallback-key");
  });

  it("whitespace-only fallback values are treated as missing (KPR-382)", async () => {
    mockConfig.gemini.apiKey = "";
    vi.stubEnv("GOOGLE_API_KEY", "   ");
    const fetchMock = vi.fn(async () => geminiOkResponse);
    vi.stubGlobal("fetch", fetchMock);
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing-key message names the full chain and keeps the credentials-add remediation (KPR-382)", async () => {
    mockConfig.gemini.apiKey = "";
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({ provider: "gemini" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/GOOGLE_GENAI_API_KEY/);
    expect(result.content[0].text).toMatch(/GOOGLE_API_KEY/);
    expect(result.content[0].text).toMatch(/hive credentials add GEMINI_API_KEY/);
  });

  it("all-4 call with only a fallback key → gemini leg succeeds, no gemini note (KPR-382)", async () => {
    seedGrok();
    mockConfig.gemini.apiKey = "";
    vi.stubEnv("GOOGLE_API_KEY", "google-fallback-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => geminiOkResponse),
    );
    const handler = getHandler(makeTools(), "agent_model_catalog_list");
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.some((e: any) => e.provider === "gemini")).toBe(true);
    const noteTexts = result.content.slice(1).map((c: any) => c.text);
    expect(noteTexts.some((n: string) => n.startsWith("gemini:"))).toBe(false);
  });
});

describe("admin-mcp-server — model field discoverability (KPR-381)", () => {
  it("agent_create's model describe teaches provider-prefix syntax and points at the lookup tool", () => {
    const tools = makeTools();
    const t = tools.find((x: any) => x.name === "agent_create")!;
    const desc = (t.inputSchema as any).model.description as string;
    expect(desc).toContain("<provider>/<model>[:effort]");
    expect(desc).toContain("agent_model_catalog_list");
    expect(desc).toContain("claude-haiku-4-5");
  });

  it("agent_update's fields describe covers the model syntax and the lookup tool", () => {
    const tools = makeTools();
    const t = tools.find((x: any) => x.name === "agent_update")!;
    const desc = (t.inputSchema as any).fields.description as string;
    expect(desc).toContain("<provider>/<model>[:effort]");
    expect(desc).toContain("agent_model_catalog_list");
  });
});
