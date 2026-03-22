import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryRecord } from "./memory-types.js";
import { ObjectId } from "mongodb";

// ── Logger mock ─────────────────────────────────────────────────────
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── MongoDB mock (MemoryManager uses its own MongoClient) ───────────
const mockCollection = {
  findOne: vi.fn().mockResolvedValue(null),
  find: vi.fn().mockReturnValue({ project: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }) }),
  updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  insertOne: vi.fn().mockResolvedValue({ insertedId: new ObjectId() }),
  createIndex: vi.fn().mockResolvedValue("ok"),
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
import { MemoryManager } from "./memory-manager.js";

// ── Mock MemoryStore ────────────────────────────────────────────────
function makeMockMemoryStore() {
  return {
    getHotTier: vi.fn().mockResolvedValue([]),
    countNonHot: vi.fn().mockResolvedValue(0),
    // Include other methods for completeness but they aren't exercised here
    save: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    delete: vi.fn(),
    touchAccess: vi.fn(),
    getByIds: vi.fn(),
    getAllNonPinned: vi.fn(),
    getAllForAgent: vi.fn(),
    setTier: vi.fn(),
    setTierBulk: vi.fn(),
    getColdByTopic: vi.fn(),
    getColdTopics: vi.fn(),
    markSummarized: vi.fn(),
    deleteSummarizedOlderThan: vi.fn(),
    getAgentIds: vi.fn(),
    init: vi.fn(),
    close: vi.fn(),
  };
}

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
    createdAt: new Date("2026-03-15"),
    updatedAt: new Date("2026-03-15"),
    lastAccessedAt: new Date("2026-03-15"),
    accessCount: 0,
    pinned: false,
    summarized: false,
    qdrantPointId: "pt-1",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────
describe("MemoryManager.getHotTierPrompt", () => {
  let manager: MemoryManager;
  let mockStore: ReturnType<typeof makeMockMemoryStore>;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new MemoryManager("mongodb://localhost:27017", "hive-test");
    await manager.init();
    mockStore = makeMockMemoryStore();
  });

  it("returns null when no memoryStore is set", async () => {
    const result = await manager.getHotTierPrompt("agent-1", 3000);
    expect(result).toBeNull();
  });

  it("returns null when memoryStore.getHotTier returns empty array", async () => {
    mockStore.getHotTier.mockResolvedValueOnce([]);
    manager.memoryStore = mockStore as any;

    const result = await manager.getHotTierPrompt("agent-1", 3000);
    expect(result).toBeNull();
  });

  it("renders hot records grouped by type into correct sections", async () => {
    const records = [
      makeRecord({ type: "fact", content: "The sky is blue", importance: "high" }),
      makeRecord({ type: "decision", content: "Use MongoDB", importance: "critical" }),
      makeRecord({ type: "task", content: "Deploy v2", importance: "medium" }),
      makeRecord({ type: "preference", content: "Prefers concise answers", importance: "low" }),
    ];
    mockStore.getHotTier.mockResolvedValueOnce(records);
    mockStore.countNonHot.mockResolvedValueOnce(0);
    manager.memoryStore = mockStore as any;

    const result = await manager.getHotTierPrompt("agent-1", 10000);

    expect(result).not.toBeNull();
    expect(result).toContain("## Your Memory");
    expect(result).toContain("### Active Tasks");
    expect(result).toContain("Deploy v2");
    expect(result).toContain("### Key Facts");
    expect(result).toContain("The sky is blue");
    expect(result).toContain("### Recent Decisions");
    expect(result).toContain("Use MongoDB");
    expect(result).toContain("### Preferences");
    expect(result).toContain("Prefers concise answers");
  });

  it("respects token budget — truncates when over budget", async () => {
    // Each record ~50 chars → ~13 tokens. With budget of 20, only ~1-2 fit.
    const records = [
      makeRecord({ content: "A".repeat(80), importance: "critical" }),
      makeRecord({ content: "B".repeat(80), importance: "high" }),
      makeRecord({ content: "C".repeat(80), importance: "medium" }),
    ];
    mockStore.getHotTier.mockResolvedValueOnce(records);
    mockStore.countNonHot.mockResolvedValueOnce(0);
    manager.memoryStore = mockStore as any;

    // Budget for ~1 record (line = "- [2026-03-15] AAAA...(80) (critical)" ~= 100 chars → 25 tokens)
    const result = await manager.getHotTierPrompt("agent-1", 30);

    expect(result).not.toBeNull();
    // Should contain first record but not the last
    expect(result).toContain("A".repeat(80));
    expect(result).not.toContain("C".repeat(80));
  });

  it("pinned records always included even over budget", async () => {
    const records = [
      makeRecord({ content: "PINNED IMPORTANT", importance: "critical", pinned: true }),
      makeRecord({ content: "UNPINNED", importance: "low", pinned: false }),
    ];
    mockStore.getHotTier.mockResolvedValueOnce(records);
    mockStore.countNonHot.mockResolvedValueOnce(0);
    manager.memoryStore = mockStore as any;

    // Extremely small budget — pinned should still appear
    const result = await manager.getHotTierPrompt("agent-1", 1);

    expect(result).not.toBeNull();
    expect(result).toContain("PINNED IMPORTANT");
    expect(result).toContain("### Pinned");
    // Non-pinned should be truncated at this budget
    expect(result).not.toContain("UNPINNED");
  });

  it("includes warm/cold count hint when non-hot memories exist", async () => {
    const records = [makeRecord({ content: "active memory" })];
    mockStore.getHotTier.mockResolvedValueOnce(records);
    mockStore.countNonHot.mockResolvedValueOnce(15);
    manager.memoryStore = mockStore as any;

    const result = await manager.getHotTierPrompt("agent-1", 10000);

    expect(result).toContain("15 additional memories");
    expect(result).toContain("memory_recall");
  });

  it("omits warm/cold hint when count is zero", async () => {
    const records = [makeRecord({ content: "only hot" })];
    mockStore.getHotTier.mockResolvedValueOnce(records);
    mockStore.countNonHot.mockResolvedValueOnce(0);
    manager.memoryStore = mockStore as any;

    const result = await manager.getHotTierPrompt("agent-1", 10000);

    expect(result).not.toContain("additional memories");
  });

  it("renders pinned entries in a separate Pinned section", async () => {
    const records = [
      makeRecord({ content: "pinned fact", pinned: true, importance: "critical" }),
      makeRecord({ content: "regular fact", type: "fact", importance: "medium" }),
    ];
    mockStore.getHotTier.mockResolvedValueOnce(records);
    mockStore.countNonHot.mockResolvedValueOnce(0);
    manager.memoryStore = mockStore as any;

    const result = await manager.getHotTierPrompt("agent-1", 10000);

    expect(result).toContain("### Pinned");
    expect(result).toContain("pinned fact");
    expect(result).toContain("(critical, pinned)");
  });
});
