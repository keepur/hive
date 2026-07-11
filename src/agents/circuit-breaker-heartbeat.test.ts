import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreakerHeartbeat } from "./circuit-breaker-heartbeat.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeMockAgentManager(snapshot: Record<string, unknown>) {
  return { circuitBreakers: { getSnapshot: vi.fn().mockReturnValue(snapshot) } };
}

function makeMockTelemetryCollection() {
  return { updateOne: vi.fn().mockResolvedValue({ acknowledged: true }) };
}

const claudeSnap = {
  provider: "claude",
  state: "open",
  enabled: true,
  openedAt: 1_000,
  reason: "connect-fail",
  consecutiveHardFaults: 3,
  tripCount: 1,
  lastTripAt: 1_000,
  fastFailCount: 7,
  lastFaultKind: "connect-fail",
  lastFaultMessage: "fetch failed",
  lastFaultAt: 999,
  p95Ms: null,
  sampleCount: 0,
  probeInFlight: false,
  nextProbeEligibleAt: 16_000,
};

describe("CircuitBreakerHeartbeat (KPR-306)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writeOnce upserts one document per provider under {kind, provider}", async () => {
    const am = makeMockAgentManager({ claude: claudeSnap, gemini: { ...claudeSnap, provider: "gemini", state: "closed" } });
    const coll = makeMockTelemetryCollection();
    const hb = new CircuitBreakerHeartbeat(am as any, coll as any);
    await hb.writeOnce();

    expect(coll.updateOne).toHaveBeenCalledTimes(2);
    const call = coll.updateOne.mock.calls.find((c: any[]) => c[0].provider === "claude")!;
    expect(call[0]).toEqual({ kind: "circuit_breaker_stats", provider: "claude" });
    expect(call[1].$set.state).toBe("open");
    expect(call[1].$set.fastFailCount).toBe(7);
    expect(call[1].$set.updatedAt).toBeInstanceOf(Date);
    expect(call[2]).toEqual({ upsert: true });
  });

  it("writeOnce is a no-op for an empty snapshot (no providers used yet)", async () => {
    const coll = makeMockTelemetryCollection();
    const hb = new CircuitBreakerHeartbeat(makeMockAgentManager({}) as any, coll as any);
    await hb.writeOnce();
    expect(coll.updateOne).not.toHaveBeenCalled();
  });

  it("swallows per-provider write failures (never throws)", async () => {
    const coll = makeMockTelemetryCollection();
    coll.updateOne.mockRejectedValueOnce(new Error("mongo down"));
    const hb = new CircuitBreakerHeartbeat(makeMockAgentManager({ claude: claudeSnap }) as any, coll as any);
    await expect(hb.writeOnce()).resolves.toBeUndefined();
  });

  it("start() ticks on the interval; stop() cancels", async () => {
    const coll = makeMockTelemetryCollection();
    const hb = new CircuitBreakerHeartbeat(makeMockAgentManager({ claude: claudeSnap }) as any, coll as any, {
      intervalMs: 1_000,
    });
    hb.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(coll.updateOne).toHaveBeenCalledTimes(3);
    hb.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(coll.updateOne).toHaveBeenCalledTimes(3);
  });
});
