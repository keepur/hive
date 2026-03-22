import { describe, it, expect } from "vitest";
import { MemoryLifecycle } from "../../src/memory/memory-lifecycle.js";
import type { MemoryRecord } from "../../src/memory/memory-types.js";

// Test scoring in isolation — no MongoDB or Qdrant needed
describe("MemoryLifecycle.computeScore", () => {
  const lifecycle = new MemoryLifecycle(null as any, null as any, {
    hotBudgetTokens: 3000,
    sweepIntervalHours: 6,
    hotThreshold: 0.6,
    warmThreshold: 0.3,
    recencyHalfLifeDays: 7,
    coldSummaryMinRecords: 5,
    coldRetentionDays: 90,
  });

  const baseRecord: MemoryRecord = {
    agentId: "test",
    content: "test memory",
    type: "fact",
    topic: "test",
    importance: "high",
    tier: "hot",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: new Date(),
    accessCount: 5,
    pinned: false,
    summarized: false,
    qdrantPointId: "test-id",
  };

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
    // At exactly one half-life, recency should be ~0.5 of fresh
    const recencyDiff = freshScore - oldScore;
    expect(recencyDiff).toBeGreaterThan(0.1);
  });
});
