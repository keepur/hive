import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import type { MemoryRecord, MemoryLifecycleConfig, DreamConfig } from "./memory-types.js";

// ── Logger mock (KPR-314: hoisted shared spies so log emission is capturable) ─
const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));

// ── Import after mocks ──────────────────────────────────────────────
import { MemoryLifecycle, GATE_TOLERANCE } from "./memory-lifecycle.js";
import { estimateCostUsdFromPricing } from "../llm/catalog.js";

// ── Mock MemoryStore ────────────────────────────────────────────────
function makeMockStore() {
  return {
    getAgentIds: vi.fn().mockResolvedValue([]),
    getAllNonPinned: vi.fn().mockResolvedValue([]),
    getHotTier: vi.fn().mockResolvedValue([]),
    setTier: vi.fn().mockResolvedValue(undefined),
    setTierBulk: vi.fn().mockResolvedValue(undefined),
    getColdTopics: vi.fn().mockResolvedValue([]),
    getColdByTopicPaged: vi.fn().mockResolvedValue([]),
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
    getCollection: vi.fn(),
  };
}

function makeColdRecord(idx: number, topic: string, content: string = `cold-${idx}`): any {
  return {
    _id: new ObjectId(),
    content,
    type: "interaction",
    topic,
    importance: "medium",
    tier: "cold",
    createdAt: new Date(2026, 0, 1, 0, 0, idx),
    updatedAt: new Date(2026, 0, 1, 0, 0, idx),
    lastAccessedAt: new Date(2026, 0, 1, 0, 0, idx),
    accessCount: 0,
    pinned: false,
    summarized: false,
    qdrantPointId: `point-${idx}`,
  };
}

function makeLifecycle(dreamOverrides: Partial<DreamConfig> = {}) {
  const store = makeMockStore();
  const embedder = makeMockEmbedder();
  const config: MemoryLifecycleConfig = {
    hotBudgetTokens: 3000,
    sweepIntervalHours: 6,
    hotThreshold: 0.6,
    warmThreshold: 0.3,
    recencyHalfLifeDays: 7,
    coldSummaryMinRecords: 1,
    coldRetentionDays: 90,
    purgeRetentionDays: 7,
  };
  const dreamConfig: DreamConfig = {
    enabled: true,
    cooldownMinutes: 0,
    similarityThreshold: 0.85,
    patternMinCount: 3,
    maxClustersPerRun: 20,
    maxContradictionPairsPerRun: 30,
    maxPromotionsPerRun: 2,
    maxRunBudgetUsd: 1.0,
    maxCallBudgetUsd: 0.1,
    minNewMemories: 0,
    coldSummaryPageSize: 20,
    coldSummaryPromptTokenBudget: 8000,
    ...dreamOverrides,
  };
  const lifecycle = new MemoryLifecycle(store as any, embedder as any, config, makeMockLlm(), dreamConfig);
  return { lifecycle, store, embedder };
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

// ── Mock LLM client (KPR-314 — replaces the SDK subprocess mock) ────────
// Defaults preserve legacy pins exactly: costUsd 0 matches the old mock's
// absent total_cost_usd; estimateCostUsd 0.001 clears every default gate.
function makeMockLlm(overrides: Record<string, unknown> = {}, ...texts: string[]) {
  let i = 0;
  return {
    generateForTask: vi.fn().mockImplementation(async () => {
      const text = texts[i] ?? texts[texts.length - 1] ?? "Summary text";
      i++;
      return {
        text,
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic" as const,
        durationMs: 1,
        costUsd: 0,
      };
    }),
    hasProvider: vi.fn(() => true),
    estimateCostUsd: vi.fn(() => 0.001),
    ...overrides,
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
  const lifecycle = new MemoryLifecycle(null as any, null as any, defaultConfig, makeMockLlm());

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
    lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm());
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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm());
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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm());
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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm());
    store.getAgentIds.mockResolvedValueOnce(["agent-1"]);
    store.getAllNonPinned.mockResolvedValueOnce([]);
    store.getColdTopics.mockResolvedValueOnce([]);
    store.deleteSummarizedOlderThan.mockResolvedValueOnce(0);
    store.deletePurgedOlderThan.mockResolvedValueOnce([]);

    await lifecycle.sweep();

    expect(embedder.remove).not.toHaveBeenCalled();
  });

  it("continues sweep without throwing when phase 6 throws", async () => {
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm());
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

    const lifecycle = new MemoryLifecycle(store as any, embedder as any, config, makeMockLlm());

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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm());
    const result = await lifecycle.dream();
    expect(result).toEqual({ merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] });
  });

  it("returns zeros when dreamConfig.enabled is false", async () => {
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm(), {
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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm(), dreamCfg);

    store.getAgentIds.mockResolvedValue(["quiet-agent"]);
    store.getAutoDreamState.mockResolvedValue({ lastDreamAt: new Date("2026-05-20T10:00:00Z") });
    store.countAutoDreamCandidates.mockResolvedValue(3);

    const result = await lifecycle.dream();

    expect(result.skippedAgents).toBe(1);
    expect(store.getByTiersForAgent).not.toHaveBeenCalled();
    expect(store.markAutoDreamRun).not.toHaveBeenCalled();
  });

  it("applies maxRunBudgetUsd across multiple autoDream LLM calls", async () => {
    // KPR-314: budget now accrues from registry-computed costUsd (was the
    // subprocess total_cost_usd). The per-call subprocess hard cap
    // (options.maxBudgetUsd) is gone — the estimate gate replaces it and is
    // pinned separately in the KPR-314 describe; here we pin run-budget
    // exhaustion across calls, which survives the transport swap unchanged.
    const llm = makeMockLlm();
    llm.generateForTask
      .mockResolvedValueOnce({
        text: "NO",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        durationMs: 1,
        costUsd: 0.01,
      })
      .mockResolvedValueOnce({
        text: "NO",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        durationMs: 1,
        costUsd: 0.005,
      });
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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, llm, dreamCfg);
    const recA = makeRecord({ agentId: "a1", type: "fact", topic: "t" });
    const recB = makeRecord({ agentId: "a1", type: "fact", topic: "t" });
    const recC = makeRecord({ agentId: "a1", type: "fact", topic: "t" });

    store.getAgentIds.mockResolvedValue(["a1"]);
    store.countAutoDreamCandidates.mockResolvedValue(3);
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map([["t", [recA, recB, recC]]]));
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    const result = await lifecycle.dream();

    expect(llm.generateForTask).toHaveBeenCalledTimes(2);
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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm(), dreamCfg);

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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm(), dreamCfg);

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
    // KPR-314: the single contradiction call returns "A_WINS" via the mock LLM
    // (merge is skipped — no duplicates — so this is the first generateForTask).
    const llm = makeMockLlm({}, "A_WINS");
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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, llm, dreamCfg);

    const recA = makeRecord({ agentId: "a1", type: "fact", topic: "pricing" });
    const recB = makeRecord({ agentId: "a1", type: "fact", topic: "pricing" });

    store.getAgentIds.mockResolvedValue(["a1"]);
    store.getByTiersForAgent.mockResolvedValue([]); // no duplicates
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map([["pricing", [recA, recB]]]));
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    const result = await lifecycle.dream();

    expect(result.contradictions).toBe(1);
    expect(store.markSuperseded).toHaveBeenCalledWith([recB._id!], recA._id!);
  });

  // ── Happy-path: detectContradictions — eliminated record skipped ──
  it("skips superseded records in later contradiction pairs", async () => {
    // Pair (A,B): B loses. Pair (A,C): no contradiction. Pair (B,C): SKIPPED.
    const llm = makeMockLlm({}, "A_WINS", "NO");
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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, llm, dreamCfg);

    const recA = makeRecord({ agentId: "a1", type: "fact", topic: "t" });
    const recB = makeRecord({ agentId: "a1", type: "fact", topic: "t" });
    const recC = makeRecord({ agentId: "a1", type: "fact", topic: "t" });

    store.getAgentIds.mockResolvedValue(["a1"]);
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map([["t", [recA, recB, recC]]]));
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    const result = await lifecycle.dream();

    // Only 1 resolved (A beats B). B is eliminated so (B,C) never evaluated.
    expect(result.contradictions).toBe(1);
    // markSuperseded called exactly once (B superseded by A)
    expect(store.markSuperseded).toHaveBeenCalledTimes(1);
    expect(store.markSuperseded).toHaveBeenCalledWith([recB._id!], recA._id!);
    // Only 2 LLM calls: (A,B) and (A,C). NOT (B,C).
    expect(llm.generateForTask).toHaveBeenCalledTimes(2);
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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm(), dreamCfg);

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
    const lifecycle = new MemoryLifecycle(
      store as any,
      embedder as any,
      defaultConfig,
      makeMockLlm(),
      dreamCfg,
      getActiveAgentIds,
    );

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
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, defaultConfig, makeMockLlm(), dreamCfg);

    store.getAgentIds.mockResolvedValue(["a1", "a2"]);
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());

    await lifecycle.dream();

    expect(store.getByTiersForAgent).toHaveBeenCalledWith("a1", expect.any(Array));
    expect(store.getByTiersForAgent).toHaveBeenCalledWith("a2", expect.any(Array));
  });
});

describe("MemoryLifecycle.summarizeColdPhase (KPR-241)", () => {
  it("calls getColdByTopicPaged with pageSize limit and returns drained=true when no records left", async () => {
    const { lifecycle, store } = makeLifecycle({ coldSummaryPageSize: 5 });
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    (store.getColdTopics as any).mockResolvedValue(["topic-a"]);
    const recs = [0, 1, 2, 3, 4].map((i) => makeColdRecord(i, "topic-a"));
    (store.getColdByTopicPaged as any).mockResolvedValueOnce(recs).mockResolvedValueOnce([]);
    await lifecycle.dream();
    const pagedCalls = (store.getColdByTopicPaged as any).mock.calls;
    expect(pagedCalls[0][3]).toBe(5);
  });

  it("returns drained=false when a probe finds remaining cold records", async () => {
    const { lifecycle, store } = makeLifecycle({ coldSummaryPageSize: 2 });
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    (store.getColdTopics as any).mockResolvedValue(["topic-a"]);
    const page1 = [makeColdRecord(0, "topic-a"), makeColdRecord(1, "topic-a")];
    (store.getColdByTopicPaged as any)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([makeColdRecord(2, "topic-a")]);
    await lifecycle.dream();
    const calls = (store.markAutoDreamRun as any).mock.calls;
    const lastCallOpts = calls[calls.length - 1][1];
    expect(lastCallOpts.phase).not.toBe("idle");
  });

  it("flags oversized records needsReview and continues with remaining records", async () => {
    const { lifecycle, store } = makeLifecycle({
      coldSummaryPageSize: 10,
      coldSummaryPromptTokenBudget: 100,
    });
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    (store.getColdTopics as any).mockResolvedValue(["topic-a"]);
    const huge = makeColdRecord(0, "topic-a", "x".repeat(5000));
    const normals = [1, 2, 3, 4].map((i) => makeColdRecord(i, "topic-a", "ok"));
    (store.getColdByTopicPaged as any).mockResolvedValueOnce([huge, ...normals]).mockResolvedValueOnce([]);
    await lifecycle.dream();
    expect(store.flagForReview).toHaveBeenCalledWith([huge._id]);
    expect(store.markSummarized).toHaveBeenCalled();
    const summarizedIds = (store.markSummarized as any).mock.calls[0][0];
    expect(summarizedIds).toEqual(normals.map((r) => r._id));
  });

  it("advances compound cursor to {lastRecord.createdAt, lastRecord._id}", async () => {
    const { lifecycle, store } = makeLifecycle({ coldSummaryPageSize: 3 });
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    (store.getColdTopics as any).mockResolvedValue(["topic-a"]);
    const page = [makeColdRecord(0, "topic-a"), makeColdRecord(1, "topic-a"), makeColdRecord(2, "topic-a")];
    (store.getColdByTopicPaged as any).mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    await lifecycle.dream();
    const cursorCall = (store.markAutoDreamRun as any).mock.calls.find((c: any) => c[1].phase === "summarizeCold");
    expect(cursorCall).toBeDefined();
    expect(cursorCall[1].cursor).toEqual({
      createdAt: page[2].createdAt,
      lastId: page[2]._id,
    });
  });
});

describe("MemoryLifecycle sweep relocation (KPR-241)", () => {
  it("sweepAgent no longer calls summarizeCold path", async () => {
    const { lifecycle, store } = makeLifecycle();
    (store.getAgentIds as any).mockResolvedValue(["a1"]);
    await lifecycle.sweep();
    expect(store.getColdByTopicPaged).not.toHaveBeenCalled();
  });
});

describe("MemoryLifecycle.runConsolidationForAgent (KPR-241)", () => {
  it("returns drained=true when summarizeColdPhase reports drained", async () => {
    const { lifecycle } = makeLifecycle();
    (lifecycle as any).summarizeColdPhase = vi.fn().mockResolvedValue({ summarized: 5, drained: true });
    (lifecycle as any).mergeDuplicates = vi.fn().mockResolvedValue({ merged: 0 });
    (lifecycle as any).detectContradictions = vi.fn().mockResolvedValue({ resolved: 0, flagged: 0 });
    (lifecycle as any).promotePatterns = vi.fn().mockResolvedValue({ promoted: 0 });
    const result = await lifecycle.runConsolidationForAgent("a1", { maxPages: 50 });
    expect(result.drained).toBe(true);
    expect(result.summarized).toBe(5);
  });

  it("respects maxPages cap when not yet drained", async () => {
    const { lifecycle } = makeLifecycle();
    const summarizeStub = vi.fn().mockResolvedValue({ summarized: 5, drained: false });
    (lifecycle as any).summarizeColdPhase = summarizeStub;
    (lifecycle as any).mergeDuplicates = vi.fn().mockResolvedValue({ merged: 0 });
    (lifecycle as any).detectContradictions = vi.fn().mockResolvedValue({ resolved: 0, flagged: 0 });
    (lifecycle as any).promotePatterns = vi.fn().mockResolvedValue({ promoted: 0 });
    const result = await lifecycle.runConsolidationForAgent("a1", { maxPages: 3 });
    expect(summarizeStub).toHaveBeenCalledTimes(3);
    expect(result.pagesProcessed).toBe(3);
    expect(result.drained).toBe(false);
  });
});

// Real registry-side estimate math (config-free import by design) — the gate
// clearance pins run against the ACTUAL sent prompt, wrapper included.
const HAIKU_PRICING = { inputPerMTok: 1, outputPerMTok: 5 };
function realisticEstimate() {
  return vi.fn((_task: "memory", req: { prompt: string; systemPrompt?: string; maxOutputTokens?: number }) =>
    estimateCostUsdFromPricing(HAIKU_PRICING, req),
  );
}

describe("MemoryLifecycle — sidecar LLM registry (KPR-314)", () => {
  // dreamConfig with today's defaults: run $0.05, call $0.01 → gate $0.013.
  const dreamDefaults = {
    enabled: true,
    cooldownMinutes: 0,
    minNewMemories: 0,
    similarityThreshold: 0.9,
    patternMinCount: 3,
    maxClustersPerRun: 5,
    maxContradictionPairsPerRun: 5,
    maxPromotionsPerRun: 5,
    maxRunBudgetUsd: 0.05,
    maxCallBudgetUsd: 0.01,
    coldSummaryPageSize: 20,
    coldSummaryPromptTokenBudget: 8000,
  };
  // Config with min-records 3 for the deep-over/band constructions.
  const gateConfig = { ...defaultConfig, coldSummaryMinRecords: 3 };

  let store: ReturnType<typeof makeMockStore>;
  let embedder: ReturnType<typeof makeMockEmbedder>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = makeMockStore();
    embedder = makeMockEmbedder();
  });

  /** One agent, one cold topic, `contents` as the page. */
  function wireColdSummary(contents: string[]) {
    store.getAgentIds.mockResolvedValue(["agent-1"]);
    store.countAutoDreamCandidates.mockResolvedValue(99);
    store.getAutoDreamState.mockResolvedValue(null);
    store.getColdTopics.mockResolvedValue(["topic-a"]);
    store.getColdByTopicPaged.mockResolvedValue(
      contents.map((content) =>
        makeRecord({ _id: new ObjectId(), content, type: "interaction", importance: "medium", topic: "topic-a" }),
      ),
    );
    // Other phases idle:
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());
  }

  it("pins GATE_TOLERANCE at 1.3", () => {
    expect(GATE_TOLERANCE).toBe(1.3);
  });

  it("records the registry-computed cost, including post-hoc exceedance of callBudgetUsd", async () => {
    const llm = makeMockLlm();
    llm.generateForTask.mockResolvedValue({
      text: "Summary text",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      durationMs: 1,
      usage: { inputTokens: 9000, outputTokens: 90 },
      costUsd: 0.012, // > maxCallBudgetUsd 0.01 — tolerance-admitted band actuals
    });
    wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(400)));
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    const result = await lifecycle.dream();
    expect(result.spentUsd).toBeCloseTo(0.012, 8); // overshoot recorded, consumes run budget
    expect(result.gateSkips).toBe(0);
  });

  it("wires the 30s timeout and temperature 0 into every memory request", async () => {
    const llm = makeMockLlm();
    wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(400)));
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    await lifecycle.dream();
    expect(llm.generateForTask).toHaveBeenCalledWith(
      "memory",
      expect.objectContaining({ timeoutMs: 30_000, temperature: 0, maxOutputTokens: 256 }),
    );
  });

  it("cold-summary/merge/promote requests carry 256 max output tokens; contradiction verdicts carry 32", async () => {
    const llm = makeMockLlm({}, "Summary text", "NO");
    const idA = new ObjectId();
    const idB = new ObjectId();
    store.getAgentIds.mockResolvedValue(["agent-1"]);
    store.countAutoDreamCandidates.mockResolvedValue(99);
    store.getAutoDreamState.mockResolvedValue(null);
    store.getColdTopics.mockResolvedValue([]);
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getInteractionsByTopic.mockResolvedValue(new Map());
    store.getFactsAndDecisionsByTopic.mockResolvedValue(
      new Map([
        [
          "t",
          [
            makeRecord({ _id: idA, type: "fact", content: "A", topic: "t" }),
            makeRecord({ _id: idB, type: "fact", content: "B", topic: "t" }),
          ],
        ],
      ]),
    );
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    await lifecycle.dream();
    const verdictCall = llm.generateForTask.mock.calls.find((c: any[]) => String(c[1].prompt).includes("contradict"));
    expect(verdictCall![1].maxOutputTokens).toBe(32);
  });

  describe("estimate gate — clearance against real estimate math (spec §3.4 case analysis)", () => {
    it("a default-fitted cold-summary page + wrapper passes the ×1.3 gate and is attempted (≈$0.0094)", async () => {
      const llm = makeMockLlm({ estimateCostUsd: realisticEstimate() });
      // 20 records × 1,596 chars: content-only est. 7,985 tok ≤ 8,000 — the
      // shrink loop does not fire; the SENT prompt adds preamble + prefixes.
      wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(1596)));
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const result = await lifecycle.dream();
      expect(llm.generateForTask).toHaveBeenCalledTimes(1);
      const estimate = llm.estimateCostUsd.mock.results[0]!.value as number;
      expect(estimate).toBeGreaterThan(0.008); // wrapper counted (bare 8,000-tok content = $0.0093 incl. output)
      expect(estimate).toBeLessThan(0.013); // clears the gate
      expect(result.gateSkips).toBe(0);
    });

    it("a shallow-over band page (min-records stop above the content budget) PASSES under ×1.3 and is attempted (≈$0.0103)", async () => {
      const llm = makeMockLlm({ estimateCostUsd: realisticEstimate() });
      // 3 records × 12,000 chars: content est. 9,000 tok > 8,000 but the
      // shrink loop can't go below coldSummaryMinRecords (3) — sent anyway,
      // exactly today's behavior; estimate ≈ $0.0103 ∈ (0.01, 0.013].
      wireColdSummary(Array.from({ length: 3 }, () => "m".repeat(12_000)));
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const result = await lifecycle.dream();
      expect(llm.generateForTask).toHaveBeenCalledTimes(1); // attempted — the class a raw ceiling would have permanently skipped
      const estimate = llm.estimateCostUsd.mock.results[0]!.value as number;
      expect(estimate).toBeGreaterThan(0.01);
      expect(estimate).toBeLessThan(0.013);
      expect(result.gateSkips).toBe(0);
    });

    it("a deep-over min-records page is GATED — skipped without spend, counted, surfaced (≈$0.0253)", async () => {
      const llm = makeMockLlm({ estimateCostUsd: realisticEstimate() });
      // 3 records × 31,900 chars: each ≤ 8,000 tok (passes the oversize
      // filter) but the page est. ≈ 24,000 tok — today this is attempted and
      // cap-aborted (~$0.01 burned, "" returned); the gate skips it for $0.
      wireColdSummary(Array.from({ length: 3 }, () => "m".repeat(31_900)));
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const result = await lifecycle.dream();
      expect(llm.generateForTask).not.toHaveBeenCalled();
      const estimate = llm.estimateCostUsd.mock.results[0]!.value as number;
      expect(estimate).toBeGreaterThan(0.013);
      expect(result.gateSkips).toBe(1);
      expect(result.spentUsd).toBe(0);
    });

    it("a gate skip behaves as empty text: continue, no throw, drained semantics unchanged, checkpoint preserved", async () => {
      const llm = makeMockLlm({ estimateCostUsd: vi.fn(() => 99) }); // force-gate everything
      wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(400)));
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const result = await lifecycle.dream();
      expect(result.errors).toEqual([]);
      expect(result.summarized).toBe(0);
      expect(result.gateSkips).toBeGreaterThan(0);
      // The skipped topic's records remain ≥ min-records ⇒ the end-of-topics
      // probe reports not-drained ⇒ dream()'s finally must NOT reset the
      // checkpoint to idle (today's continue rule, unchanged).
      const markCalls = store.markAutoDreamRun.mock.calls.map((c: any[]) => c[1]);
      expect(markCalls.some((u: any) => u.phase === "idle")).toBe(false);
      // Blocking pin: the completion log fires on an ALL-SKIPPED run
      // (totalActions 0) and carries the skip count — the guard widening
      // in Task 5 step 9 is load-bearing for spec §3.4's observability claim.
      expect(mockLog.info).toHaveBeenCalledWith(
        "autoDream complete",
        expect.objectContaining({ gateSkips: result.gateSkips }),
      );
    });
  });

  it("canSpend pre-gate still throws run-budget exhaustion (recorded per agent, loop break preserved)", async () => {
    const llm = makeMockLlm();
    llm.generateForTask.mockResolvedValue({
      text: "Summary text",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      durationMs: 1,
      costUsd: 0.05, // one call exhausts the run budget
    });
    wireColdSummary(Array.from({ length: 20 }, () => "m".repeat(400)));
    store.getAgentIds.mockResolvedValue(["agent-1", "agent-2"]);
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    const result = await lifecycle.dream();
    expect(result.errors.some((e) => e.includes("autoDream run budget exhausted"))).toBe(true);
  });

  it("a phase throw aborts that AGENT's remaining phases; the run continues at the next agent", async () => {
    const llm = makeMockLlm();
    llm.generateForTask
      .mockRejectedValueOnce(new Error("429 rate limited")) // agent-1's first LLM call
      .mockResolvedValue({
        text: "Summary text",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        durationMs: 1,
        costUsd: 0,
      });
    store.getAgentIds.mockResolvedValue(["agent-1", "agent-2"]);
    store.countAutoDreamCandidates.mockResolvedValue(99);
    store.getAutoDreamState.mockResolvedValue(null);
    store.getColdTopics.mockResolvedValue(["topic-a"]);
    store.getColdByTopicPaged.mockResolvedValue(
      Array.from({ length: 20 }, () => makeRecord({ _id: new ObjectId(), content: "m".repeat(400), topic: "topic-a" })),
    );
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    const result = await lifecycle.dream();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("agent-1");
    // Agent-1 aborted after 1 call (remaining phases skipped); agent-2's
    // cold-summary call still ran: 2 total.
    expect(llm.generateForTask).toHaveBeenCalledTimes(2);
    // KPR-314: a 429-shaped error no longer breaks the agent loop (the dead
    // "hit your limit" break is gone) — pinned by agent-2 having run at all.
  });

  it("the removed subscription-limit break: an error CONTAINING 'hit your limit' no longer aborts the run", async () => {
    const llm = makeMockLlm();
    llm.generateForTask
      .mockRejectedValueOnce(new Error("You've hit your limit for today"))
      .mockResolvedValue({
        text: "Summary text",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        durationMs: 1,
        costUsd: 0,
      });
    store.getAgentIds.mockResolvedValue(["agent-1", "agent-2"]);
    store.countAutoDreamCandidates.mockResolvedValue(99);
    store.getAutoDreamState.mockResolvedValue(null);
    store.getColdTopics.mockResolvedValue(["topic-a"]);
    store.getColdByTopicPaged.mockResolvedValue(
      Array.from({ length: 20 }, () => makeRecord({ _id: new ObjectId(), content: "m".repeat(400), topic: "topic-a" })),
    );
    store.getByTiersForAgent.mockResolvedValue([]);
    store.getFactsAndDecisionsByTopic.mockResolvedValue(new Map());
    store.getInteractionsByTopic.mockResolvedValue(new Map());
    const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
    const result = await lifecycle.dream();
    expect(llm.generateForTask.mock.calls.length).toBeGreaterThanOrEqual(2); // agent-2 ran
    expect(result.errors).toHaveLength(1);
  });

  describe("no-key steady state", () => {
    it("dream() short-circuits to zero counts; generateForTask never called; repeatable without error spam", async () => {
      const llm = makeMockLlm({ hasProvider: vi.fn(() => false) });
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const r1 = await lifecycle.dream();
      const r2 = await lifecycle.dream();
      expect(r1).toEqual({ merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] });
      expect(r2.errors).toEqual([]);
      expect(llm.generateForTask).not.toHaveBeenCalled();
      expect(store.getAgentIds).not.toHaveBeenCalled();
    });

    it("runConsolidationForAgent returns an explicit operator-facing error", async () => {
      const llm = makeMockLlm({ hasProvider: vi.fn(() => false) });
      const lifecycle = new MemoryLifecycle(store as any, embedder as any, gateConfig, llm, dreamDefaults);
      const r = await lifecycle.runConsolidationForAgent("agent-1", { maxPages: 3 });
      expect(r.errors).toEqual(["no ANTHROPIC_API_KEY — autoDream LLM phases unavailable"]);
      expect(r.gateSkips).toBe(0); // field present on the operator path too
      expect(llm.generateForTask).not.toHaveBeenCalled();
    });
  });
});
