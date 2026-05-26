import { describe, it, expect, vi } from "vitest";
import { MemoryLifecycleHeartbeat } from "./memory-lifecycle-heartbeat.js";

function makeStore(state: { agentIds: string[]; counts: Record<string, any>; dreamState?: any }) {
  return {
    getCollection: () => ({
      countDocuments: vi.fn((filter: any) => {
        const key = `${filter.tier ?? ""}${filter.summarized ? "summarized" : ""}${filter.needsReview ? "needsReview" : ""}`;
        return Promise.resolve(state.counts[filter.agentId]?.[key] ?? 0);
      }),
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            project: () => ({
              toArray: () => Promise.resolve(state.counts[state.agentIds[0]]?.oldestCold ?? []),
            }),
          }),
        }),
      })),
    }),
    getAgentIds: vi.fn(() => Promise.resolve(state.agentIds)),
    getAutoDreamState: vi.fn(() => Promise.resolve(state.dreamState)),
  };
}

describe("MemoryLifecycleHeartbeat", () => {
  it("upserts one doc per agent under kind=memory_lifecycle_stats", async () => {
    const updateOne = vi.fn().mockResolvedValue({});
    const telemetry = { updateOne };
    const store = makeStore({
      agentIds: ["a1", "a2"],
      counts: {
        a1: { hot: 2, warm: 5, cold: 10, summarized: 1, needsReview: 0, oldestCold: [{ createdAt: new Date("2026-04-01") }] },
        a2: { hot: 0, warm: 0, cold: 0, summarized: 0, needsReview: 0, oldestCold: [] },
      },
    });
    const heartbeat = new MemoryLifecycleHeartbeat(store as any, telemetry as any);
    await heartbeat.writeOnce();
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls[0][0]).toMatchObject({
      kind: "memory_lifecycle_stats",
      agentId: expect.any(String),
    });
  });

  it("filters by active agents when getActiveAgentIds is provided", async () => {
    const updateOne = vi.fn().mockResolvedValue({});
    const telemetry = { updateOne };
    const store = makeStore({
      agentIds: ["a1", "a2"],
      counts: { a1: {}, a2: {} },
    });
    const heartbeat = new MemoryLifecycleHeartbeat(store as any, telemetry as any, {
      getActiveAgentIds: () => Promise.resolve(new Set(["a1"])),
    });
    await heartbeat.writeOnce();
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(updateOne.mock.calls[0][0].agentId).toBe("a1");
  });

  it("derives cumulativeSpentUsd30d from spendHistory window", async () => {
    const updateOne = vi.fn().mockResolvedValue({});
    const telemetry = { updateOne };
    const now = Date.now();
    const store = makeStore({
      agentIds: ["a1"],
      counts: { a1: {} },
      dreamState: {
        spendHistory: [
          { at: new Date(now - 45 * 24 * 60 * 60 * 1000), spentUsd: 0.5 },
          { at: new Date(now - 5 * 24 * 60 * 60 * 1000), spentUsd: 0.1 },
          { at: new Date(now - 1 * 24 * 60 * 60 * 1000), spentUsd: 0.05 },
        ],
      },
    });
    const heartbeat = new MemoryLifecycleHeartbeat(store as any, telemetry as any);
    await heartbeat.writeOnce();
    const updateBody = updateOne.mock.calls[0][1].$set;
    expect(updateBody.consolidation.cumulativeSpentUsd30d).toBeCloseTo(0.15, 2);
    expect(updateBody.consolidation.lastRunSpentUsd).toBe(0.05);
  });
});
