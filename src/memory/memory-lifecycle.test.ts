import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import type { MemoryRecord, MemoryLifecycleConfig } from "./memory-types.js";

// ── Logger mock ─────────────────────────────────────────────────────
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── SDK mock (used by summarizeCold) ────────────────────────────────
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn().mockReturnValue({
    close: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "Summary text",
      };
    },
  }),
}));

// ── Import after mocks ──────────────────────────────────────────────
import { MemoryLifecycle } from "./memory-lifecycle.js";

// ── Mock MemoryStore ────────────────────────────────────────────────
function makeMockStore() {
  return {
    getAgentIds: vi.fn().mockResolvedValue([]),
    getAllNonPinned: vi.fn().mockResolvedValue([]),
    getHotTier: vi.fn().mockResolvedValue([]),
    setTier: vi.fn().mockResolvedValue(undefined),
    setTierBulk: vi.fn().mockResolvedValue(undefined),
    getColdTopics: vi.fn().mockResolvedValue([]),
    getColdByTopic: vi.fn().mockResolvedValue([]),
    markSummarized: vi.fn().mockResolvedValue(undefined),
    deleteSummarizedOlderThan: vi.fn().mockResolvedValue(0),
    deletePurgedOlderThan: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockResolvedValue({ _id: new ObjectId() }),
    countNonHot: vi.fn().mockResolvedValue(0),
    getById: vi.fn(),
    update: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    delete: vi.fn(),
    touchAccess: vi.fn(),
    getByIds: vi.fn(),
    getAllForAgent: vi.fn(),
    getAgentIds2: vi.fn(),
    init: vi.fn(),
    close: vi.fn(),
    getByTiersForAgent: vi.fn().mockResolvedValue([]),
    getFactsAndDecisionsByTopic: vi.fn().mockResolvedValue(new Map()),
    getInteractionsByTopic: vi.fn().mockResolvedValue(new Map()),
    markSuperseded: vi.fn().mockResolvedValue(undefined),
    flagForReview: vi.fn().mockResolvedValue(undefined),
    getAutoDreamState: vi.fn().mockResolvedValue(null),
    countAutoDreamCandidates: vi.fn().mockResolvedValue(10),
    markAutoDreamRun: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Mock MemoryEmbedder ─────────────────────────────────────────────
function makeMockEmbedder() {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    findSimilar: vi.fn().mockResolvedValue([]),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────
const defaultConfig: MemoryLifecycleConfig = {
  hotBudgetTokens: 3000,
  sweepIntervalHours: 6,
  hotThreshold: 0.6,
  warmThreshold: 0.3,
  recencyHalfLifeDays: 7,
  coldSummaryMinRecords: 5,
  coldRetentionDays: 90,
  purgeRetentionDays: 7,
};

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

// ── Scoring tests (moved from tests/memory/) ───────────────────────
describe("MemoryLifecycle.computeScore", () => {
  const lifecycle = new MemoryLifecycle(null as any, null as any, defaultConfig);

  const baseRecord = makeRecord({
    importance: "high",
    accessCount: 5,
  });

  it("scores critical + recent + accessed fact near 1.0", () => {
    const record = { ...baseRecord, importance: "critical" as const, accessCount: 10 };
    const score = lifecycle.computeScore(record, 5);
    expect(score).toBeGreaterThan(0.8);
  });

  it("scores low importance + old + unaccessed interaction near 0", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const record = {
      ...baseRecord,
      importance: "low" as const,
      type: "interaction" as const,
      updatedAt: thirtyDaysAgo,
      accessCount: 0,
    };
    const score = lifecycle.computeScore(record, 5);
    expect(score).toBeLessThan(0.3);
  });

  it("gives decisions higher type weight than interactions", () => {
    const decision = { ...baseRecord, type: "decision" as const };
    const interaction = { ...baseRecord, type: "interaction" as const };
    const decisionScore = lifecycle.computeScore(decision, 5);
    const interactionScore = lifecycle.computeScore(interaction, 5);
    expect(decisionScore).toBeGreaterThan(interactionScore);
  });

  it("recency decays over time", () => {
    const fresh = { ...baseRecord, updatedAt: new Date() };
    const sevenDaysAgo = { ...baseRecord, updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
    const freshScore = lifecycle.computeScore(fresh, 5);
    const oldScore = lifecycle.computeScore(sevenDaysAgo, 5);
    expect(freshScore).toBeGreaterThan(oldScore);
    const recencyDiff = freshScore - oldScore;
    expect(recencyDiff).toBeGreaterThan(0.1);
  });
});

// ── sweep() tests ───────────────────────────────────────────────────
describe("MemoryLifecycle.sweep", () => {
  let store: ReturnType<typeof makeMockStore>;
  let embedder: ReturnType<typeof makeMockEmbedder>;
  let lifecycle: MemoryLifecycle;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeMockStore();
    embedder = makeMockEmbedder();
    lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig);
  });

  it("returns zero counts when no agents exist", async () => {
    store.getAgentIds.mockResolvedValueOnce([]);
    const result = await lifecycle.sweep();

    expect(result.component).toBe("memory-lifecycle");
    expect(result.pruned).toBe(0);
    expect(result.retried).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("calls sweepAgent for each agent and aggregates results", async () => {
    store.getAgentIds.mockResolvedValueOnce(["agent-a", "agent-b"]);

    // Agent A: has records that get demoted (score below hot threshold)
    const oldRecord = makeRecord({
      agentId: "agent-a",
      importance: "low",
      type: "interaction",
      tier: "hot",
      updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      accessCount: 0,
    });
    store.getAllNonPinned
      .mockResolvedValueOnce([oldRecord]) // agent-a
      .mockResolvedValueOnce([]); // agent-b

    store.getHotTier
      .mockResolvedValueOnce([]) // agent-a after tier changes
      .mockResolvedValueOnce([]); // agent-b

    store.getColdTopics
      .mockResolvedValueOnce([]) // agent-a
      .mockResolvedValueOnce([]); // agent-b

    store.deleteSummarizedOlderThan
      .mockResolvedValueOnce(0) // agent-a
      .mockResolvedValueOnce(0); // agent-b

    const result = await lifecycle.sweep();

    expect(store.getAllNonPinned).toHaveBeenCalledWith("agent-a");
    expect(store.getAllNonPinned).toHaveBeenCalledWith("agent-b");
    expect(result.errors).toEqual([]);
  });

  it("captures per-agent errors without stopping other agents", async () => {
    store.getAgentIds.mockResolvedValueOnce(["agent-good", "agent-bad"]);
    store.getAllNonPinned
      .mockResolvedValueOnce([]) // agent-good — no records, returns early
      .mockRejectedValueOnce(new Error("DB down")); // agent-bad — throws

    const result = await lifecycle.sweep();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("agent-bad");
    expect(result.errors[0]).toContain("DB down");
  });

  it("demotes hot records that score below threshold", async () => {
    store.getAgentIds.mockResolvedValueOnce(["agent-1"]);

    // Old, low-importance, unaccessed → score well below hotThreshold (0.6)
    const staleRecord = makeRecord({
      agentId: "agent-1",
      importance: "low",
      type: "interaction",
      tier: "hot",
      updatedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      accessCount: 0,
    });

    store.getAllNonPinned.mockResolvedValueOnce([staleRecord]);
    store.getHotTier.mockResolvedValueOnce([]); // After tier changes
    store.getColdTopics.mockResolvedValueOnce([]);
    store.deleteSummarizedOlderThan.mockResolvedValueOnce(0);

    const result = await lifecycle.sweep();

    // setTierBulk should have been called for demotion
    expect(store.setTierBulk).toHaveBeenCalled();
    expect(result.pruned).toBeGreaterThan(0);
  });
});

// ── Phase 6: hard-delete purged records ─────────────────────────────
describe("MemoryLifecycle Phase 6: hard-delete purged records", () => {
  let store: ReturnType<typeof makeMockStore>;
  let embedder: ReturnType<typeof makeMockEmbedder>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeMockStore();
    embedder = makeMockEmbedder();
  });

  it("calls deletePurgedOlderThan with the correct 7-day cutoff", async () => {
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig);
    store.getAgentIds.mockResolvedValueOnce(["agent-1"]);
    // Empty records — Phase 6 must still run even when agent has no active memories
    store.getAllNonPinned.mockResolvedValueOnce([]);
    store.deletePurgedOlderThan.mockResolvedValueOnce([]);

    const before = Date.now();
    await lifecycle.sweep();
    const after = Date.now();

    const [calledAgentId, calledBefore] = store.deletePurgedOlderThan.mock.calls[0];
    expect(calledAgentId).toBe("agent-1");
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(calledBefore.getTime()).toBeGreaterThanOrEqual(before - sevenDaysMs - 1000);
    expect(calledBefore.getTime()).toBeLessThanOrEqual(after - sevenDaysMs + 1000);
  });

  it("calls embedder.remove for each hard-deleted record's qdrantPointId", async () => {
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig);
    const deletedRecord = makeRecord({ purged: true, purgedAt: new Date("2026-01-01"), qdrantPointId: "pt-purged-1" });

    store.getAgentIds.mockResolvedValueOnce(["agent-1"]);
    // Empty records — Phase 6 must still run even when agent has no active memories
    store.getAllNonPinned.mockResolvedValueOnce([]);
    store.deletePurgedOlderThan.mockResolvedValueOnce([deletedRecord]);

    await lifecycle.sweep();

    expect(embedder.remove).toHaveBeenCalledOnce();
    expect(embedder.remove).toHaveBeenCalledWith("pt-purged-1");
  });

  it("does not call embedder.remove when no records are hard-deleted", async () => {
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig);
    store.getAgentIds.mockResolvedValueOnce(["agent-1"]);
    store.getAllNonPinned.mockResolvedValueOnce([]);
    store.getColdTopics.mockResolvedValueOnce([]);
    store.deleteSummarizedOlderThan.mockResolvedValueOnce(0);
    store.deletePurgedOlderThan.mockResolvedValueOnce([]);

    await lifecycle.sweep();

    expect(embedder.remove).not.toHaveBeenCalled();
  });

  it("continues sweep without throwing when phase 6 throws", async () => {
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig);
    store.getAgentIds.mockResolvedValueOnce(["agent-1"]);
    store.getAllNonPinned.mockResolvedValueOnce([]);
    store.getColdTopics.mockResolvedValueOnce([]);
    store.deleteSummarizedOlderThan.mockResolvedValueOnce(0);
    store.deletePurgedOlderThan.mockRejectedValueOnce(new Error("mongo timeout"));

    await expect(lifecycle.sweep()).resolves.not.toThrow();
  });
});

// ── Budget enforcement tests ────────────────────────────────────────
describe("MemoryLifecycle budget enforcement", () => {
  let store: ReturnType<typeof makeMockStore>;
  let embedder: ReturnType<typeof makeMockEmbedder>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeMockStore();
    embedder = makeMockEmbedder();
  });

  it("pinned tokens do not count against hot budget", async () => {
    // Budget: 60 tokens. Pinned record uses 200 chars (~50 tokens).
    // Non-pinned records use 200 chars each (~50 tokens each).
    // Without the pinned fix, the pinned record would eat budget and overflow non-pinned.
    const config: MemoryLifecycleConfig = {
      ...defaultConfig,
      hotBudgetTokens: 60, // ~240 chars budget for non-pinned only
    };

    const lifecycle = new MemoryLifecycle(store as any, embedder as any, config);

    store.getAgentIds.mockResolvedValueOnce(["agent-1"]);

    const pinnedRecord = makeRecord({
      agentId: "agent-1",
      content: "P".repeat(200), // ~50 tokens — would bust budget if counted
      pinned: true,
      tier: "hot",
    });
    const nonPinned1 = makeRecord({
      agentId: "agent-1",
      content: "A".repeat(200), // ~50 tokens
      pinned: false,
      tier: "hot",
      importance: "critical",
    });
    const nonPinned2 = makeRecord({
      agentId: "agent-1",
      content: "B".repeat(200), // ~50 tokens — cumulative exceeds budget
      pinned: false,
      tier: "hot",
      importance: "high",
    });

    // getAllNonPinned must return records so sweepAgent doesn't bail early
    store.getAllNonPinned.mockResolvedValueOnce([nonPinned1, nonPinned2]);
    // getHotTier is called after tier scoring — return all hot records including pinned
    store.getHotTier.mockResolvedValueOnce([pinnedRecord, nonPinned1, nonPinned2]);
    store.getColdTopics.mockResolvedValueOnce([]);
    store.deleteSummarizedOlderThan.mockResolvedValueOnce(0);

    await lifecycle.sweep();

    // nonPinned1 = 50 tokens (within budget), nonPinned2 = 100 cumulative (over 60)
    // So nonPinned2 should overflow to warm
    // setTierBulk is called for tier scoring AND for overflow — find the overflow call
    const warmCalls = store.setTierBulk.mock.calls.filter(([_ids, tier]: [ObjectId[], string]) => tier === "warm");
    const overflowedIds = warmCalls.flatMap(([ids]: [ObjectId[]]) => ids);
    expect(overflowedIds).toContain(nonPinned2._id);
    // The pinned record should NOT have been overflowed
    expect(overflowedIds).not.toContain(pinnedRecord._id);
  });
});

// ── dream() tests ────────────────────────────────────────────────────
describe("dream()", () => {
  let store: ReturnType<typeof makeMockStore>;
  let embedder: ReturnType<typeof makeMockEmbedder>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeMockStore();
    embedder = makeMockEmbedder();
  });

  it("returns zeros when dreamConfig is not provided", async () => {
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig);
    const result = await lifecycle.dream();
    expect(result).toEqual({ merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] });
  });

  it("returns zeros when dreamConfig.enabled is false", async () => {
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, {
      enabled: false,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxBudgetUsd: 0.1,
    });
    const result = await lifecycle.dream();
    expect(result).toEqual({ merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] });
  });

  it("skips agents without enough changed memories since their last autoDream", async () => {
    const dreamCfg = {
      enabled: true,
      quietPeriodMinutes: 120,
      cooldownMinutes: 60,
      minNewMemories: 10,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxRunBudgetUsd: 0.05,
      maxCallBudgetUsd: 0.01,
    };
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, dreamCfg);

    store.getAgentIds.mockResolvedValue(["quiet-agent"]);
    store.getAutoDreamState.mockResolvedValue({ lastDreamAt: new Date("2026-05-20T10:00:00Z") });
    store.countAutoDreamCandidates.mockResolvedValue(3);

    const result = await lifecycle.dream();

    expect(result.skippedAgents).toBe(1);
    expect(store.getByTiersForAgent).not.toHaveBeenCalled();
    expect(store.markAutoDreamRun).not.toHaveBeenCalled();
  });

  it("applies maxRunBudgetUsd across multiple autoDream SDK calls", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const dreamCfg = {
      enabled: true,
      quietPeriodMinutes: 120,
      cooldownMinutes: 60,
      minNewMemories: 1,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxRunBudgetUsd: 0.015,
      maxCallBudgetUsd: 0.01,
    };
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, dreamCfg);
    const recA = makeRecord({ agentId: "a1", type: "fact", topic: "t" });
    const recB = makeRecord({ agentId: "a1", type: "fact", topic: "t" });
    const recC = makeRecord({ agentId: "a1", type: "fact", topic: "t" });

    store.getAgentIds.mockResolvedValue(["a1"]);
    store.countAutoDreamCandidates.mockResolvedValue(3);
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map([["t", [recA, recB, recC]]]));
    store.getInteractionsByTopic.mockResolvedValue(new Map());
    (mockQuery as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        close: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          yield { type: "result", subtype: "success", result: "NO", total_cost_usd: 0.01 };
        },
      })
      .mockReturnValueOnce({
        close: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          yield { type: "result", subtype: "success", result: "NO", total_cost_usd: 0.005 };
        },
      });

    const result = await lifecycle.dream();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect((mockQuery as ReturnType<typeof vi.fn>).mock.calls[0][0].options.maxBudgetUsd).toBe(0.01);
    expect((mockQuery as ReturnType<typeof vi.fn>).mock.calls[1][0].options.maxBudgetUsd).toBeCloseTo(0.005, 5);
    expect(result.errors[0]).toContain("autoDream run budget exhausted");
    expect(result.spentUsd).toBe(0.015);
    expect(result.llmCalls).toBe(2);
  });

  it("catches per-agent errors without stopping other agents", async () => {
    const dreamCfg = {
      enabled: true,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxBudgetUsd: 0.1,
    };
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, dreamCfg);

    // Mock getAgentIds returns two agents
    store.getAgentIds.mockResolvedValue(["agent-a", "agent-b"]);
    // First agent throws on getByTiersForAgent, second succeeds and returns empty (no work to do)
    store.getByTiersForAgent.mockRejectedValueOnce(new Error("db error")).mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    const result = await lifecycle.dream();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("agent-a");
  });

  // ── Happy-path: mergeDuplicates ───────────────────────────────────
  it("merges duplicate cluster and supersedes originals", async () => {
    const dreamCfg = {
      enabled: true,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxBudgetUsd: 0.1,
    };
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, dreamCfg);

    const rec1 = makeRecord({ agentId: "a1", qdrantPointId: "pt-1", importance: "high" });
    const rec2 = makeRecord({ agentId: "a1", qdrantPointId: "pt-2", importance: "medium" });
    const mergedId = new ObjectId();

    store.getAgentIds.mockResolvedValue(["a1"]);
    store.getByTiersForAgent.mockResolvedValue([rec1, rec2]);
    // pt-1 finds pt-2 as similar
    embedder.findSimilar.mockResolvedValueOnce([{ mongoId: rec2._id!.toString(), score: 0.9, pointId: "pt-2" }]);
    // pt-2 already processed — returns empty
    embedder.findSimilar.mockResolvedValueOnce([]);
    store.getByIds.mockResolvedValue([rec2]);
    store.save.mockResolvedValue({ _id: mergedId });
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    const result = await lifecycle.dream();

    expect(result.merged).toBe(2); // both originals counted
    expect(store.save).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ type: "fact", topic: "general", importance: "high" }),
      expect.any(String),
    );
    expect(store.markSuperseded).toHaveBeenCalledWith([rec1._id!, rec2._id!], mergedId);
    expect(embedder.upsert).toHaveBeenCalled();
  });

  // ── Happy-path: detectContradictions ──────────────────────────────
  it("resolves contradiction with A_WINS and supersedes loser", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const dreamCfg = {
      enabled: true,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxBudgetUsd: 0.1,
    };
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, dreamCfg);

    const recA = makeRecord({ agentId: "a1", type: "fact", topic: "pricing" });
    const recB = makeRecord({ agentId: "a1", type: "fact", topic: "pricing" });

    store.getAgentIds.mockResolvedValue(["a1"]);
    store.getByTiersForAgent.mockResolvedValue([]); // no duplicates
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map([["pricing", [recA, recB]]]));
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    // SDK mock: first call is for merge (skipped, no duplicates), second for contradiction
    // The global mock returns "Summary text" — override for this test
    (mockQuery as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      close: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield { type: "result", subtype: "success", result: "A_WINS" };
      },
    });

    const result = await lifecycle.dream();

    expect(result.contradictions).toBe(1);
    expect(store.markSuperseded).toHaveBeenCalledWith([recB._id!], recA._id!);
  });

  // ── Happy-path: detectContradictions — eliminated record skipped ──
  it("skips superseded records in later contradiction pairs", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const dreamCfg = {
      enabled: true,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxBudgetUsd: 0.1,
    };
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, dreamCfg);

    const recA = makeRecord({ agentId: "a1", type: "fact", topic: "t" });
    const recB = makeRecord({ agentId: "a1", type: "fact", topic: "t" });
    const recC = makeRecord({ agentId: "a1", type: "fact", topic: "t" });

    store.getAgentIds.mockResolvedValue(["a1"]);
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map([["t", [recA, recB, recC]]]));
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    // Pair (A,B): B loses. Pair (A,C): no contradiction. Pair (B,C): should be SKIPPED.
    (mockQuery as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({
        close: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          yield { type: "result", subtype: "success", result: "A_WINS" };
        },
      })
      .mockReturnValueOnce({
        close: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          yield { type: "result", subtype: "success", result: "NO" };
        },
      });

    const result = await lifecycle.dream();

    // Only 1 resolved (A beats B). B is eliminated so (B,C) never evaluated.
    expect(result.contradictions).toBe(1);
    // markSuperseded called exactly once (B superseded by A)
    expect(store.markSuperseded).toHaveBeenCalledTimes(1);
    expect(store.markSuperseded).toHaveBeenCalledWith([recB._id!], recA._id!);
    // Only 2 LLM calls: (A,B) and (A,C). NOT (B,C).
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  // ── Happy-path: promotePatterns ───────────────────────────────────
  it("promotes pattern to fact and supersedes source interactions", async () => {
    const dreamCfg = {
      enabled: true,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxBudgetUsd: 0.1,
    };
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, dreamCfg);

    const interactions = [
      makeRecord({ agentId: "a1", type: "interaction", topic: "greetings", sourceThread: "t1" }),
      makeRecord({ agentId: "a1", type: "interaction", topic: "greetings", sourceThread: "t2" }),
      makeRecord({ agentId: "a1", type: "interaction", topic: "greetings", sourceThread: "t3" }),
    ];
    const factId = new ObjectId();

    store.getAgentIds.mockResolvedValue(["a1"]);
    store.getByTiersForAgent.mockResolvedValue([]); // no duplicates
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map()); // no contradictions
    store.getInteractionsByTopic.mockResolvedValue(new Map([["greetings", interactions]]));
    store.save.mockResolvedValue({ _id: factId });

    const result = await lifecycle.dream();

    expect(result.promoted).toBe(1);
    // Saved a fact on topic "greetings"
    expect(store.save).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ type: "fact", topic: "greetings", importance: "medium" }),
      expect.any(String),
    );
    // Source interactions superseded by the new fact
    expect(store.markSuperseded).toHaveBeenCalledWith(
      interactions.map((r) => r._id!),
      factId,
    );
  });

  // ── Retired-agent filter ──────────────────────────────────────────
  it("skips retired agents when getActiveAgentIds is provided", async () => {
    const dreamCfg = {
      enabled: true,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxBudgetUsd: 0.1,
    };
    const getActiveAgentIds = vi.fn().mockResolvedValue(new Set(["active-agent"]));
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, dreamCfg, getActiveAgentIds);

    // Memory collection surfaces one active + one retired agent
    store.getAgentIds.mockResolvedValue(["active-agent", "retired-agent"]);
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    await lifecycle.dream();

    // Only the active agent was iterated — retired-agent never fetched
    expect(getActiveAgentIds).toHaveBeenCalledOnce();
    expect(store.getByTiersForAgent).toHaveBeenCalledWith("active-agent", expect.any(Array));
    expect(store.getByTiersForAgent).not.toHaveBeenCalledWith("retired-agent", expect.any(Array));
  });

  it("iterates all agents when getActiveAgentIds is NOT provided (backward compat)", async () => {
    const dreamCfg = {
      enabled: true,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxBudgetUsd: 0.1,
    };
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, dreamCfg);

    store.getAgentIds.mockResolvedValue(["a1", "a2"]);
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    await lifecycle.dream();

    expect(store.getByTiersForAgent).toHaveBeenCalledWith("a1", expect.any(Array));
    expect(store.getByTiersForAgent).toHaveBeenCalledWith("a2", expect.any(Array));
  });
});
