import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpawnCoordinatorHeartbeat } from "./spawn-coordinator-heartbeat.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeMockAgentManager(snapshot: any) {
  return {
    getSnapshot: vi.fn().mockReturnValue(snapshot),
  };
}

function makeMockTelemetryCollection() {
  return {
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
  };
}

describe("SpawnCoordinatorHeartbeat (KPR-220 Phase 11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writeOnce upserts one document per agent under {kind, agentId}", async () => {
    const snapshot = {
      perAgent: {
        "agent-a": {
          activeSpawns: 1,
          activeThreadKeys: ["agent-a:t1"],
          budget: 3,
          budgetSource: "maxConcurrent" as const,
          saturationCount: 0,
          lastSaturationAt: null,
          lastSpawnAt: 1234,
          lastError: null,
          stopped: false,
        },
        "agent-b": {
          activeSpawns: 0,
          activeThreadKeys: [],
          budget: 5,
          budgetSource: "default" as const,
          saturationCount: 2,
          lastSaturationAt: 5678,
          lastSpawnAt: null,
          lastError: "boom",
          stopped: true,
        },
      },
    };
    const am = makeMockAgentManager(snapshot);
    const coll = makeMockTelemetryCollection();
    const hb = new SpawnCoordinatorHeartbeat(am as any, coll as any);
    await hb.writeOnce();

    expect(coll.updateOne).toHaveBeenCalledTimes(2);

    const calls = coll.updateOne.mock.calls;
    const aCall = calls.find((c: any[]) => c[0].agentId === "agent-a")!;
    expect(aCall[0]).toEqual({ kind: "spawn_coordinator_stats", agentId: "agent-a" });
    expect(aCall[1].$set.activeSpawns).toBe(1);
    expect(aCall[1].$set.budget).toBe(3);
    expect(aCall[1].$set.stopped).toBe(false);
    expect(aCall[1].$set.updatedAt).toBeInstanceOf(Date);
    expect(aCall[2]).toEqual({ upsert: true });

    const bCall = calls.find((c: any[]) => c[0].agentId === "agent-b")!;
    expect(bCall[1].$set.stopped).toBe(true);
    expect(bCall[1].$set.lastError).toBe("boom");
    expect(bCall[1].$set.saturationCount).toBe(2);
  });

  it("writeOnce with empty perAgent does not call updateOne", async () => {
    const am = makeMockAgentManager({ perAgent: {} });
    const coll = makeMockTelemetryCollection();
    const hb = new SpawnCoordinatorHeartbeat(am as any, coll as any);
    await hb.writeOnce();
    expect(coll.updateOne).not.toHaveBeenCalled();
  });

  it("start() schedules writes on the configured interval", async () => {
    const snapshot = {
      perAgent: {
        "agent-a": {
          activeSpawns: 0,
          activeThreadKeys: [],
          budget: 5,
          budgetSource: "default" as const,
          saturationCount: 0,
          lastSaturationAt: null,
          lastSpawnAt: null,
          lastError: null,
          stopped: false,
        },
      },
    };
    const am = makeMockAgentManager(snapshot);
    const coll = makeMockTelemetryCollection();
    const hb = new SpawnCoordinatorHeartbeat(am as any, coll as any, { intervalMs: 50 });
    hb.start();

    // No write yet — start() doesn't write immediately; the interval owns that
    expect(coll.updateOne).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60);
    expect(coll.updateOne).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60);
    expect(coll.updateOne).toHaveBeenCalledTimes(2);

    hb.stop();
  });

  it("stop() cancels the interval", async () => {
    const snapshot = { perAgent: { "agent-a": {} as any } };
    const am = makeMockAgentManager(snapshot);
    const coll = makeMockTelemetryCollection();
    const hb = new SpawnCoordinatorHeartbeat(am as any, coll as any, { intervalMs: 50 });
    hb.start();
    hb.stop();

    await vi.advanceTimersByTimeAsync(200);
    expect(coll.updateOne).not.toHaveBeenCalled();
  });

  it("idempotent start() — calling twice does not double-schedule", async () => {
    const snapshot = {
      perAgent: {
        "agent-a": {
          activeSpawns: 0,
          activeThreadKeys: [],
          budget: 5,
          budgetSource: "default" as const,
          saturationCount: 0,
          lastSaturationAt: null,
          lastSpawnAt: null,
          lastError: null,
          stopped: false,
        },
      },
    };
    const am = makeMockAgentManager(snapshot);
    const coll = makeMockTelemetryCollection();
    const hb = new SpawnCoordinatorHeartbeat(am as any, coll as any, { intervalMs: 50 });
    hb.start();
    hb.start(); // second start should be a no-op

    await vi.advanceTimersByTimeAsync(60);
    // Should have fired once, not twice (no doubled timers)
    expect(coll.updateOne).toHaveBeenCalledTimes(1);

    hb.stop();
  });

  it("write failure does not throw to caller (heartbeat is best-effort)", async () => {
    const snapshot = {
      perAgent: {
        "agent-a": {
          activeSpawns: 0,
          activeThreadKeys: [],
          budget: 5,
          budgetSource: "default" as const,
          saturationCount: 0,
          lastSaturationAt: null,
          lastSpawnAt: null,
          lastError: null,
          stopped: false,
        },
      },
    };
    const am = makeMockAgentManager(snapshot);
    const coll = {
      updateOne: vi.fn().mockRejectedValue(new Error("mongo down")),
    };
    const hb = new SpawnCoordinatorHeartbeat(am as any, coll as any);
    // writeOnce swallows errors per-agent
    await expect(hb.writeOnce()).resolves.toBeUndefined();
  });
});
