import { describe, it, expect, vi } from "vitest";

// Mock SDK helpers so buildMemoryTools returns simple objects we can introspect.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

// Late-binding fake Mongo Db — we reset stores per-test below.
type Doc = Record<string, any>;
let memoryDocs = new Map<string, Doc>();
let versionDocs: Doc[] = [];

function makeFakeCollection(name: string): any {
  return {
    findOne: vi.fn(async (filter: any) => {
      if (name === "memory") return memoryDocs.get(filter.path) ?? null;
      return null;
    }),
    find: vi.fn((filter: any) => ({
      project: vi.fn(() => ({
        toArray: vi.fn(async () => {
          const regex = filter?.path?.$regex;
          if (!regex) return [];
          const re = new RegExp(regex);
          return [...memoryDocs.values()].filter((d) => re.test(d.path)).map((d) => ({ path: d.path }));
        }),
      })),
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({
          toArray: vi.fn(async () => {
            return versionDocs.filter((v) => v.path === filter.path).slice(0, 10);
          }),
          skip: vi.fn(() => ({
            limit: vi.fn(() => ({
              toArray: vi.fn(async () => versionDocs.filter((v) => v.path === filter.path)),
            })),
          })),
        })),
        skip: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn(async () => versionDocs.filter((v) => v.path === filter.path)),
          })),
        })),
      })),
      toArray: vi.fn(async () => []),
    })),
    insertOne: vi.fn(async (doc: any) => {
      if (name === "memory_versions") versionDocs.push({ ...doc });
      return { insertedId: "x" };
    }),
    updateOne: vi.fn(async (filter: any, update: any) => {
      if (name === "memory") {
        const existing = memoryDocs.get(filter.path) ?? { path: filter.path };
        Object.assign(existing, update.$set);
        existing.path = filter.path;
        memoryDocs.set(filter.path, existing);
      }
      return { matchedCount: 1 };
    }),
  };
}

function makeFakeDb(): any {
  return {
    collection: (name: string) => makeFakeCollection(name),
  };
}

import { buildMemoryTools } from "./memory-mcp-server.js";

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

describe("memory-mcp-server (in-process)", () => {
  it("memory_write then memory_read round-trip succeeds for self scope", async () => {
    memoryDocs = new Map();
    versionDocs = [];
    const tools = buildMemoryTools({ db: makeFakeDb(), agentId: "alice", memoryScopes: [] });

    const write = getHandler(tools, "memory_write");
    const read = getHandler(tools, "memory_read");

    const writeRes = await write({ path: "agents/alice/note.md", content: "hello world" });
    expect(writeRes.isError).toBeFalsy();
    expect(writeRes.content[0].text).toMatch(/Written/);

    const readRes = await read({ path: "agents/alice/note.md" });
    expect(readRes.isError).toBeFalsy();
    expect(readRes.content[0].text).toBe("hello world");
  });

  it("memory_read denies access to paths outside agent and shared/", async () => {
    memoryDocs = new Map();
    versionDocs = [];
    const tools = buildMemoryTools({ db: makeFakeDb(), agentId: "alice", memoryScopes: [] });
    const read = getHandler(tools, "memory_read");

    const res = await read({ path: "agents/bob/private.md" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Access denied/);
  });

  it("memory_read returns not-found error for missing files in self scope", async () => {
    memoryDocs = new Map();
    versionDocs = [];
    const tools = buildMemoryTools({ db: makeFakeDb(), agentId: "alice", memoryScopes: [] });
    const read = getHandler(tools, "memory_read");

    const res = await read({ path: "agents/alice/missing.md" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/File not found/);
  });

  it("memory_history rejects unknown filesystem scope", async () => {
    memoryDocs = new Map();
    versionDocs = [];
    const tools = buildMemoryTools({ db: makeFakeDb(), agentId: "alice", memoryScopes: [] });
    const history = getHandler(tools, "memory_history");

    const res = await history({ path: "agents/alice/x.md", scope: "workshop" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not supported/);
  });
});
