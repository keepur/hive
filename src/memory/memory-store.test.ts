import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import type { MemoryRecord } from "./memory-types.js";

// ── Logger mock ─────────────────────────────────────────────────────
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── MongoDB mock ────────────────────────────────────────────────────
const mockToArray = vi.fn().mockResolvedValue([]);
const mockSort = vi.fn().mockReturnValue({ toArray: mockToArray });
const mockFind = vi.fn().mockReturnValue({ toArray: mockToArray, sort: mockSort });
const mockFindOne = vi.fn().mockResolvedValue(null);
const mockInsertOne = vi.fn().mockResolvedValue({ insertedId: new ObjectId() });
const mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
const mockUpdateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 });
const mockFindOneAndUpdate = vi.fn().mockResolvedValue(null);
const mockFindOneAndDelete = vi.fn().mockResolvedValue(null);
const mockDistinct = vi.fn().mockResolvedValue([]);
const mockCountDocuments = vi.fn().mockResolvedValue(0);
const mockCreateIndex = vi.fn().mockResolvedValue("ok");
const mockDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });

const mockCollection = {
  find: mockFind,
  findOne: mockFindOne,
  insertOne: mockInsertOne,
  updateOne: mockUpdateOne,
  updateMany: mockUpdateMany,
  findOneAndUpdate: mockFindOneAndUpdate,
  findOneAndDelete: mockFindOneAndDelete,
  distinct: mockDistinct,
  countDocuments: mockCountDocuments,
  createIndex: mockCreateIndex,
  deleteMany: mockDeleteMany,
};

const mockDb = {
  collection: vi.fn().mockReturnValue(mockCollection),
};

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  db: vi.fn().mockReturnValue(mockDb),
};

vi.mock("mongodb", async (importOriginal) => {
  const original = await importOriginal<typeof import("mongodb")>();
  return {
    ...original,
    MongoClient: vi.fn().mockImplementation(() => mockClient),
  };
});

// ── Import after mocks ──────────────────────────────────────────────
import { MemoryStore } from "./memory-store.js";

// ── Helpers ─────────────────────────────────────────────────────────
function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    _id: new ObjectId(),
    agentId: "test-agent",
    content: "test content",
    type: "fact",
    topic: "general",
    importance: "medium",
    tier: "hot",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
    accessCount: 0,
    pinned: false,
    summarized: false,
    qdrantPointId: "pt-1",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────
describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockToArray.mockResolvedValue([]);
    mockFind.mockReturnValue({ toArray: mockToArray, sort: mockSort });
    mockSort.mockReturnValue({ toArray: mockToArray });
    store = new MemoryStore("mongodb://localhost:27017", "hive-test");
    await store.init();
  });

  describe("init", () => {
    it("connects and creates indexes", async () => {
      expect(mockClient.connect).toHaveBeenCalled();
      expect(mockCreateIndex).toHaveBeenCalledTimes(5);
    });
  });

  describe("save", () => {
    it("creates a record with correct defaults", async () => {
      const insertedId = new ObjectId();
      mockInsertOne.mockResolvedValueOnce({ insertedId });

      const result = await store.save(
        "agent-1",
        { content: "remember this", type: "fact", topic: "work", importance: "high" },
        "qdrant-pt-1",
        "#channel",
        "thread-1",
      );

      expect(mockInsertOne).toHaveBeenCalledOnce();
      const inserted = mockInsertOne.mock.calls[0][0];
      expect(inserted.agentId).toBe("agent-1");
      expect(inserted.content).toBe("remember this");
      expect(inserted.type).toBe("fact");
      expect(inserted.tier).toBe("hot");
      expect(inserted.pinned).toBe(false);
      expect(inserted.summarized).toBe(false);
      expect(inserted.accessCount).toBe(0);
      expect(inserted.sourceChannel).toBe("#channel");
      expect(inserted.sourceThread).toBe("thread-1");
      expect(inserted.qdrantPointId).toBe("qdrant-pt-1");
      expect(result._id).toBe(insertedId);
    });
  });

  describe("getById", () => {
    it("excludes purged records", async () => {
      mockFindOne.mockResolvedValueOnce(null);
      const id = new ObjectId();
      await store.getById(id);

      expect(mockFindOne).toHaveBeenCalledWith({ _id: id, purged: { $ne: true } });
    });
  });

  describe("getHotTier", () => {
    it("sorts pinned records first", async () => {
      const pinned = makeRecord({ pinned: true, importance: "low" });
      const unpinned = makeRecord({ pinned: false, importance: "critical" });
      mockToArray.mockResolvedValueOnce([unpinned, pinned]);

      const result = await store.getHotTier("test-agent");

      expect(result[0]).toBe(pinned);
      expect(result[1]).toBe(unpinned);
    });

    it("sorts by importance weight: critical > high > medium > low", async () => {
      const low = makeRecord({ importance: "low", updatedAt: new Date() });
      const med = makeRecord({ importance: "medium", updatedAt: new Date() });
      const high = makeRecord({ importance: "high", updatedAt: new Date() });
      const crit = makeRecord({ importance: "critical", updatedAt: new Date() });
      mockToArray.mockResolvedValueOnce([low, med, crit, high]);

      const result = await store.getHotTier("test-agent");

      expect(result.map((r) => r.importance)).toEqual(["critical", "high", "medium", "low"]);
    });

    it("breaks importance ties by recency (newer first)", async () => {
      const older = makeRecord({ importance: "high", updatedAt: new Date("2026-01-01") });
      const newer = makeRecord({ importance: "high", updatedAt: new Date("2026-03-01") });
      mockToArray.mockResolvedValueOnce([older, newer]);

      const result = await store.getHotTier("test-agent");

      expect(result[0]).toBe(newer);
      expect(result[1]).toBe(older);
    });

    it("queries for correct agentId and tier, excluding purged", async () => {
      mockToArray.mockResolvedValueOnce([]);
      await store.getHotTier("my-agent");

      expect(mockFind).toHaveBeenCalledWith({ agentId: "my-agent", tier: "hot", purged: { $ne: true } });
    });
  });

  describe("pin", () => {
    it("sets pinned true and tier to hot", async () => {
      mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 });
      const id = new ObjectId();
      const result = await store.pin(id);

      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: id }, { $set: { pinned: true, tier: "hot" } });
      expect(result).toBe(true);
    });

    it("returns false when no document matched", async () => {
      mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 0 });
      const result = await store.pin(new ObjectId());

      expect(result).toBe(false);
    });
  });

  describe("touchAccess", () => {
    it("increments accessCount and updates lastAccessedAt", async () => {
      const ids = [new ObjectId(), new ObjectId()];
      await store.touchAccess(ids);

      expect(mockUpdateMany).toHaveBeenCalledWith(
        { _id: { $in: ids } },
        { $set: { lastAccessedAt: expect.any(Date) }, $inc: { accessCount: 1 } },
      );
    });

    it("skips empty array", async () => {
      await store.touchAccess([]);
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("getByIds", () => {
    it("returns records matching the given IDs, excluding purged", async () => {
      const records = [makeRecord(), makeRecord()];
      mockToArray.mockResolvedValueOnce(records);
      const ids = [records[0]._id!, records[1]._id!];

      const result = await store.getByIds(ids);

      expect(mockFind).toHaveBeenCalledWith({ _id: { $in: ids }, purged: { $ne: true } });
      expect(result).toEqual(records);
    });

    it("returns empty array for empty input", async () => {
      const result = await store.getByIds([]);
      expect(result).toEqual([]);
    });
  });

  describe("getAllNonPinned", () => {
    it("queries with purged: { $ne: true }", async () => {
      mockToArray.mockResolvedValueOnce([]);
      await store.getAllNonPinned("agent-1");
      expect(mockFind).toHaveBeenCalledWith({ agentId: "agent-1", pinned: false, purged: { $ne: true } });
    });
  });

  describe("purge", () => {
    it("throws when no filters are provided", async () => {
      await expect(store.purge("agent-1", {})).rejects.toThrow("at least one filter");
    });

    it("sets purged:true and purgedAt on matching unpinned records", async () => {
      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 3 });
      const count = await store.purge("agent-1", { topic: "pipeline-review" });
      expect(mockUpdateMany).toHaveBeenCalledWith(
        { agentId: "agent-1", pinned: false, purged: { $ne: true }, topic: "pipeline-review" },
        { $set: { purged: true, purgedAt: expect.any(Date) } },
      );
      expect(count).toBe(3);
    });

    it("ANDs all provided filters together", async () => {
      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 1 });
      const olderThan = new Date("2026-01-01");
      await store.purge("agent-1", { type: "task", tier: "cold", olderThan });
      expect(mockUpdateMany).toHaveBeenCalledWith(
        {
          agentId: "agent-1",
          pinned: false,
          purged: { $ne: true },
          type: "task",
          tier: "cold",
          updatedAt: { $lt: olderThan },
        },
        { $set: { purged: true, purgedAt: expect.any(Date) } },
      );
    });

    it("returns 0 when no records match", async () => {
      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 0 });
      const count = await store.purge("agent-1", { topic: "nonexistent" });
      expect(count).toBe(0);
    });
  });

  describe("deletePurgedOlderThan", () => {
    it("returns empty array and skips deleteMany when no records match", async () => {
      mockToArray.mockResolvedValueOnce([]);
      const result = await store.deletePurgedOlderThan("agent-1", new Date());
      expect(result).toEqual([]);
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    it("fetches then deletes matching records by _id", async () => {
      const record = makeRecord({ purged: true, purgedAt: new Date("2026-01-01") });
      mockToArray.mockResolvedValueOnce([record]);
      mockDeleteMany.mockResolvedValueOnce({ deletedCount: 1 });
      const before = new Date("2026-03-01");
      const result = await store.deletePurgedOlderThan("agent-1", before);
      expect(mockFind).toHaveBeenCalledWith({
        agentId: "agent-1",
        purged: true,
        purgedAt: { $lt: before },
      });
      expect(mockDeleteMany).toHaveBeenCalledWith({ _id: { $in: [record._id] } });
      expect(result).toEqual([record]);
    });
  });

  describe("markSummarized", () => {
    it("sets summarized, summaryGroup, and summarizedAt", async () => {
      const ids = [new ObjectId(), new ObjectId()];
      const groupId = new ObjectId();
      await store.markSummarized(ids, groupId);

      expect(mockUpdateMany).toHaveBeenCalledWith(
        { _id: { $in: ids } },
        { $set: { summarized: true, summaryGroup: groupId, summarizedAt: expect.any(Date) } },
      );
    });

    it("skips empty array", async () => {
      await store.markSummarized([], new ObjectId());
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("unpin", () => {
    it("sets pinned to false", async () => {
      mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 });
      const id = new ObjectId();
      const result = await store.unpin(id);

      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: id }, { $set: { pinned: false } });
      expect(result).toBe(true);
    });
  });

  describe("setTierBulk", () => {
    it("updates tier for multiple IDs", async () => {
      const ids = [new ObjectId(), new ObjectId()];
      await store.setTierBulk(ids, "warm");

      expect(mockUpdateMany).toHaveBeenCalledWith({ _id: { $in: ids } }, { $set: { tier: "warm" } });
    });

    it("skips empty array", async () => {
      await store.setTierBulk([], "warm");
      expect(mockUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("countNonHot", () => {
    it("counts documents not in hot tier, excluding purged", async () => {
      mockCountDocuments.mockResolvedValueOnce(42);
      const result = await store.countNonHot("agent-1");

      expect(mockCountDocuments).toHaveBeenCalledWith({
        agentId: "agent-1",
        purged: { $ne: true },
        tier: { $ne: "hot" },
      });
      expect(result).toBe(42);
    });
  });

  describe("getAgentIds", () => {
    it("returns distinct agent IDs", async () => {
      mockDistinct.mockResolvedValueOnce(["agent-a", "agent-b"]);
      const result = await store.getAgentIds();

      expect(mockDistinct).toHaveBeenCalledWith("agentId");
      expect(result).toEqual(["agent-a", "agent-b"]);
    });
  });

  describe("getHotTierWithStats", () => {
    it("computes ageDays and daysSinceAccess correctly", async () => {
      const now = Date.now();
      const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
      const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);

      mockFind.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValueOnce([
          makeRecord({
            createdAt: tenDaysAgo,
            updatedAt: tenDaysAgo,
            lastAccessedAt: threeDaysAgo,
            accessCount: 5,
          }),
        ]),
      });

      const results = await store.getHotTierWithStats("test-agent");
      expect(results).toHaveLength(1);
      expect(results[0].ageDays).toBe(10);
      expect(results[0].daysSinceAccess).toBe(3);
    });

    it("returns empty array when no hot records", async () => {
      mockFind.mockReturnValueOnce({
        toArray: vi.fn().mockResolvedValueOnce([]),
      });

      const results = await store.getHotTierWithStats("test-agent");
      expect(results).toHaveLength(0);
    });
  });
});
