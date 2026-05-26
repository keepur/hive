import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";

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
const mockSearch = vi.fn().mockResolvedValue([]);
const mockGetById = vi.fn().mockResolvedValue(null);
const mockGetByIds = vi.fn().mockResolvedValue([]);
const mockMarkSummarized = vi.fn().mockResolvedValue(undefined);

vi.mock("./memory-store.js", () => ({
  MemoryStore: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    save: mockSave,
    getById: mockGetById,
    getByIds: mockGetByIds,
    touchAccess: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    delete: vi.fn(),
    purge: vi.fn().mockResolvedValue(0),
    getHotTierWithStats: vi.fn().mockResolvedValue([]),
    markSummarized: mockMarkSummarized,
  })),
}));

vi.mock("./memory-embedder.js", () => ({
  MemoryEmbedder: vi.fn().mockImplementation(() => ({
    upsert: mockUpsert,
    search: mockSearch,
    remove: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { buildStructuredMemoryTools } from "./structured-memory-mcp-server.js";

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

function buildToolsForTest() {
  return buildStructuredMemoryTools({
    db: { collection: () => ({}) } as any,
    agentId: "a1",
    context: { current: {} },
  });
}

describe("structured-memory-mcp-server (in-process)", () => {
  it("memory_save threads channel/thread from the mutable context ref", async () => {
    mockSave.mockClear();
    mockSearch.mockResolvedValue([]);
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
    mockSearch.mockResolvedValue([]);
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

describe("memory_save burst guard (KPR-241)", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetById.mockReset();
    mockSave.mockClear();
  });

  it("rejects when a recent same-topic record exceeds similarity threshold", async () => {
    const existingId = new ObjectId();
    mockSearch.mockResolvedValueOnce([{ mongoId: existingId.toString(), score: 0.95 }]);
    mockGetById.mockResolvedValueOnce({ _id: existingId, topic: "t", createdAt: new Date() });
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({ content: "first variant", type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("too similar to existing record");
    expect(res.content[0].text).toContain("sourceRef");
  });

  it("does not reject when score is below threshold", async () => {
    mockSearch.mockResolvedValueOnce([{ mongoId: "abc", score: 0.5 }]);
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({ content: "novel content", type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBeFalsy();
  });

  it("does not reject when topic differs (Mongo lookup confirms cross-topic mismatch)", async () => {
    const existingId = new ObjectId();
    mockSearch.mockResolvedValueOnce([{ mongoId: existingId.toString(), score: 0.99 }]);
    mockGetById.mockResolvedValueOnce({ _id: existingId, topic: "topicA", createdAt: new Date() });
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({ content: "x", type: "fact", topic: "topicB", importance: "medium" });
    expect(res.isError).toBeFalsy();
  });

  it("fails open when embedder.search throws — save proceeds", async () => {
    mockSearch.mockRejectedValueOnce(new Error("Qdrant down"));
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({ content: "novel content", type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Saved memory");
  });
});

describe("memory_save oversize guard (KPR-241)", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockSave.mockClear();
  });

  it("rejects content longer than maxChars", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const longContent = "x".repeat(7000);
    const res = await save({ content: longContent, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("content too long");
    expect(res.content[0].text).toContain("sourceRef");
  });

  it("accepts content below maxChars", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    // Use multi-line content so the monolith heuristic doesn't fire; we're
    // testing the oversize guard boundary only.
    const ok = ("x".repeat(100) + "\n").repeat(50); // 5050 chars, multi-line, no JSON/table shape
    const res = await save({ content: ok, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBeFalsy();
  });

  it("still fires even when burst guard is bypassed by Qdrant error", async () => {
    mockSearch.mockRejectedValueOnce(new Error("Qdrant down"));
    const save = getHandler(buildToolsForTest(), "memory_save");
    const longContent = "x".repeat(7000);
    const res = await save({ content: longContent, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
  });
});

describe("memory_save raw-dump heuristic (KPR-241)", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockSave.mockClear();
  });

  it("rejects JSON-shaped content without sourceRef", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const json = '{"foo": "bar", "baz": "' + "x".repeat(2000) + '"}';
    const res = await save({ content: json, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("raw dump");
  });

  it("accepts JSON-shaped content WITH sourceRef", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const json = '{"foo": "bar", "baz": "' + "x".repeat(2000) + '"}';
    const res = await save({
      content: json,
      type: "fact",
      topic: "t",
      importance: "medium",
      sourceRef: "https://example.com/source",
    });
    expect(res.isError).toBeFalsy();
  });

  it("rejects table-shaped content without sourceRef", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const tbl = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |";
    const res = await save({ content: tbl, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
  });

  it("rejects single-line monolith without sourceRef", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const monolith = "x".repeat(2500);
    const res = await save({ content: monolith, type: "fact", topic: "t", importance: "medium" });
    expect(res.isError).toBe(true);
  });

  it("accepts short normal content with no shape signal", async () => {
    const save = getHandler(buildToolsForTest(), "memory_save");
    const res = await save({
      content: "we decided to use X because of Y constraint",
      type: "decision",
      topic: "t",
      importance: "medium",
    });
    expect(res.isError).toBeFalsy();
  });
});

describe("memory_recall fidelity filters (KPR-241)", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetByIds.mockReset();
  });

  it("adds must_not: tier=cold to Qdrant filter when caller omits tier", async () => {
    mockSearch.mockResolvedValueOnce([]);
    const recall = getHandler(buildToolsForTest(), "memory_recall");
    await recall({ query: "anything" });
    const callArgs = mockSearch.mock.calls[0];
    expect(callArgs[3]).toEqual([{ key: "tier", match: { value: "cold" } }]);
  });

  it("omits must_not filter when caller passes explicit tier", async () => {
    mockSearch.mockResolvedValueOnce([]);
    const recall = getHandler(buildToolsForTest(), "memory_recall");
    await recall({ query: "anything", tier: "warm" });
    const callArgs = mockSearch.mock.calls[0];
    expect(callArgs[3]).toEqual([]);
  });

  it("calls getByIds with excludeSummarized:true", async () => {
    mockSearch.mockResolvedValueOnce([{ mongoId: "deadbeefdeadbeefdeadbeef", score: 0.9 }]);
    mockGetByIds.mockResolvedValueOnce([]);
    const recall = getHandler(buildToolsForTest(), "memory_recall");
    await recall({ query: "anything" });
    expect(mockGetByIds.mock.calls[0][1]).toEqual({ excludeSummarized: true });
  });
});
