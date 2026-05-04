import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { TurnTelemetryStore } from "./turn-telemetry.js";

function makeMockDb(rows: any[] = []) {
  const insertOne = vi.fn().mockResolvedValue({ insertedId: "x" });
  const createIndex = vi.fn().mockResolvedValue("ix");
  const aggregate = vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: async function* () {
      for (const r of rows) yield r;
    },
  });
  const collection = vi.fn().mockReturnValue({ insertOne, createIndex, aggregate });
  return { db: { collection } as any, mocks: { insertOne, createIndex, aggregate } };
}

describe("TurnTelemetryStore", () => {
  let store: TurnTelemetryStore;
  let mocks: ReturnType<typeof makeMockDb>["mocks"];

  beforeEach(async () => {
    const m = makeMockDb();
    store = new TurnTelemetryStore(m.db);
    mocks = m.mocks;
    await store.init();
  });

  it("creates TTL and agent indexes", () => {
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { createdAt: 1 },
      { expireAfterSeconds: 14 * 24 * 60 * 60 },
    );
    expect(mocks.createIndex).toHaveBeenCalledWith({ agentId: 1, createdAt: -1 });
  });

  it("record inserts a doc with createdAt populated", async () => {
    await store.record({
      agentId: "a",
      threadId: "t",
      sessionId: "s",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    });
    expect(mocks.insertOne).toHaveBeenCalledTimes(1);
    const arg = mocks.insertOne.mock.calls[0][0];
    expect(arg.agentId).toBe("a");
    expect(arg.createdAt).toBeInstanceOf(Date);
  });

  it("record swallows Mongo errors (fail-soft)", async () => {
    mocks.insertOne.mockRejectedValueOnce(new Error("boom"));
    await expect(
      store.record({
        agentId: "a",
        threadId: "t",
        sessionId: "s",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("TurnTelemetryStore.hitRatesByAgent", () => {
  it("returns empty array when no rows match", async () => {
    const m = makeMockDb([]);
    const s = new TurnTelemetryStore(m.db);
    await s.init();
    await expect(s.hitRatesByAgent()).resolves.toEqual([]);
  });

  it("computes hit rate from disjoint input + cache_read + cache_creation totals", async () => {
    // Aggregator $group output (agent-a aggregated).
    const m = makeMockDb([
      {
        _id: "agent-a",
        turns: 4,
        inputTokens: 200,
        cacheReadTokens: 800,
        cacheCreationTokens: 0,
        ephemeral5mTokens: 0,
        ephemeral1hTokens: 0,
      },
    ]);
    const s = new TurnTelemetryStore(m.db);
    await s.init();
    const [row] = await s.hitRatesByAgent();
    // 800 / (200 + 800 + 0) = 0.8
    expect(row.hitRate).toBeCloseTo(0.8, 4);
    expect(row.turns).toBe(4);
  });

  it("returns null hitRate when all counters are zero", async () => {
    const m = makeMockDb([
      {
        _id: "agent-a",
        turns: 1,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ephemeral5mTokens: 0,
        ephemeral1hTokens: 0,
      },
    ]);
    const s = new TurnTelemetryStore(m.db);
    await s.init();
    const [row] = await s.hitRatesByAgent();
    expect(row.hitRate).toBeNull();
  });

  it("emits one row per agent, sorted by agentId", async () => {
    const m = makeMockDb([
      {
        _id: "agent-a",
        turns: 2,
        inputTokens: 100,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
        ephemeral5mTokens: 0,
        ephemeral1hTokens: 0,
      },
      {
        _id: "agent-b",
        turns: 1,
        inputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 50,
        ephemeral5mTokens: 50,
        ephemeral1hTokens: 0,
      },
    ]);
    const s = new TurnTelemetryStore(m.db);
    await s.init();
    const rows = await s.hitRatesByAgent();
    expect(rows.map((r) => r.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(rows[0].hitRate).toBeCloseTo(0.5, 4);
    expect(rows[1].hitRate).toBeCloseTo(0, 4); // 0 / 100
    expect(rows[1].ephemeral5mTokens).toBe(50);
  });

  it("uses the requested window for the $gte cutoff", async () => {
    const m = makeMockDb([]);
    const s = new TurnTelemetryStore(m.db);
    await s.init();
    const before = Date.now();
    await s.hitRatesByAgent(60_000); // 1 minute
    const after = Date.now();
    const pipeline = m.mocks.aggregate.mock.calls[0][0];
    const since = pipeline[0].$match.createdAt.$gte as Date;
    expect(since.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    expect(since.getTime()).toBeLessThanOrEqual(after - 60_000 + 5);
  });

  it("falls back to [] when the aggregate cursor throws", async () => {
    const m = makeMockDb([]);
    m.mocks.aggregate.mockImplementationOnce(() => {
      throw new Error("network down");
    });
    const s = new TurnTelemetryStore(m.db);
    await s.init();
    await expect(s.hitRatesByAgent()).resolves.toEqual([]);
  });
});
