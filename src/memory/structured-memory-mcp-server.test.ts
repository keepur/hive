import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

// Mock MemoryStore + MemoryEmbedder so handlers exercise without real Mongo / Qdrant.
const mockSavedRecord = {
  _id: { toString: () => "deadbeefdeadbeefdeadbeef" },
  createdAt: new Date(),
};
const mockSave = vi.fn(async () => mockSavedRecord);
const mockUpsert = vi.fn(async () => undefined);

vi.mock("./memory-store.js", () => ({
  MemoryStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    save: mockSave,
    getByIds: vi.fn().mockResolvedValue([]),
    touchAccess: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    delete: vi.fn(),
    purge: vi.fn().mockResolvedValue(0),
    getHotTierWithStats: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("./memory-embedder.js", () => ({
  MemoryEmbedder: vi.fn().mockImplementation(() => ({
    upsert: mockUpsert,
    search: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { buildStructuredMemoryTools } from "./structured-memory-mcp-server.js";

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

describe("structured-memory-mcp-server (in-process)", () => {
  it("memory_save threads channel/thread from the mutable context ref", async () => {
    mockSave.mockClear();
    const ctx = { current: { channelId: "C1", threadId: "T1" } };
    const tools = buildStructuredMemoryTools({
      db: { collection: () => ({}) } as any,
      agentId: "alice",
      context: ctx,
    });

    const save = getHandler(tools, "memory_save");
    const res = await save({
      content: "first note",
      type: "fact",
      topic: "topic-a",
      importance: "low",
    });
    expect(res.isError).toBeFalsy();
    expect(mockSave).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ content: "first note" }),
      expect.any(String),
      "C1",
      "T1",
    );

    // Now mutate the ref and confirm a second save sees the new context — proves
    // the cached server picks up per-turn updates without rebuilding.
    ctx.current = { channelId: "C2", threadId: "T2" };
    await save({ content: "second note", type: "fact", topic: "topic-b", importance: "high" });
    expect(mockSave).toHaveBeenLastCalledWith(
      "alice",
      expect.objectContaining({ content: "second note" }),
      expect.any(String),
      "C2",
      "T2",
    );
  });

  it("memory_recall returns 'no matching' when search yields nothing", async () => {
    const tools = buildStructuredMemoryTools({
      db: { collection: () => ({}) } as any,
      agentId: "alice",
      context: { current: {} },
    });

    const recall = getHandler(tools, "memory_recall");
    const res = await recall({ query: "anything" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/No matching memories/);
  });

  it("memory_purge requires at least one filter", async () => {
    const tools = buildStructuredMemoryTools({
      db: { collection: () => ({}) } as any,
      agentId: "alice",
      context: { current: {} },
    });

    const purge = getHandler(tools, "memory_purge");
    const res = await purge({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/At least one filter/);
  });
});
