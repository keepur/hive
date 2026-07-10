import { describe, it, expect, vi } from "vitest";
import {
  ProviderCircuitBreakerRegistry,
  ProviderCircuitOpenError,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  type CircuitBreakerConfig,
  type TurnPermit,
} from "./provider-circuit-breaker.js";
import type { TurnClassification } from "./provider-adapters/error-classification.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const hardFault = (message = "connect ECONNREFUSED"): TurnClassification => ({
  outcome: "fault",
  kind: "connect-fail",
  message,
});
const authFault = (message = "401 Unauthorized"): TurnClassification => ({
  outcome: "fault",
  kind: "auth",
  message,
});
const nonProviderFault = (): TurnClassification => ({
  outcome: "fault",
  kind: "non-provider",
  message: "tool exploded",
});
const success = (): TurnClassification => ({ outcome: "success" });
const aborted = (): TurnClassification => ({ outcome: "aborted" });

function makeRegistry(overrides: Partial<CircuitBreakerConfig> = {}) {
  let t = 0;
  const registry = new ProviderCircuitBreakerRegistry(
    { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...overrides },
    () => t,
  );
  return {
    registry,
    advance: (ms: number) => (t += ms),
    nowValue: () => t,
    turn: (c: TurnClassification, llmMs = 100): TurnPermit => {
      const permit = registry.acquire("claude");
      registry.record(permit, c, llmMs);
      return permit;
    },
  };
}

function expectOpenThrow(fn: () => unknown): ProviderCircuitOpenError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderCircuitOpenError);
    return err as ProviderCircuitOpenError;
  }
  throw new Error("expected ProviderCircuitOpenError");
}

describe("ProviderCircuitBreaker — hard-fault trip (closed state)", () => {
  it("opens after 3 consecutive hard faults with contract-complete error fields", () => {
    const { registry, turn, nowValue } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("closed");
    turn(hardFault("connect ECONNREFUSED 127.0.0.1:443"));

    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("open");
    expect(snap.reason).toBe("connect-fail");
    expect(snap.tripCount).toBe(1);
    expect(snap.lastTripAt).toBe(nowValue());

    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.name).toBe("ProviderCircuitOpenError");
    expect(err.provider).toBe("claude");
    expect(err.openedAt).toBe(nowValue());
    expect(err.retryAfterMs).toBe(15_000);
    expect(err.reason).toBe("connect-fail");
    expect(err.lastFaultMessage).toContain("ECONNREFUSED");
  });

  it("success resets the streak", () => {
    const { registry, turn } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    turn(success());
    turn(hardFault());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("closed");
    expect(registry.stateFor("claude")!.consecutiveHardFaults).toBe(2);
  });

  it("non-provider fault resets the streak (reachability logic)", () => {
    const { registry, turn } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    turn(nonProviderFault());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("closed");
    expect(registry.stateFor("claude")!.consecutiveHardFaults).toBe(1);
  });

  it("aborted leaves the streak unchanged (inconclusive)", () => {
    const { registry, turn } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    turn(aborted());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("open");
  });

  it("auth faults trip unconditionally (delegated-assumption pin)", () => {
    const { registry, turn } = makeRegistry();
    turn(authFault());
    turn(authFault());
    turn(authFault());
    expect(registry.stateFor("claude")!.state).toBe("open");
    expect(registry.stateFor("claude")!.reason).toBe("auth");
  });

  it("record is idempotent per permit", () => {
    const { registry } = makeRegistry();
    const permit = registry.acquire("claude");
    registry.record(permit, hardFault(), 0);
    registry.record(permit, hardFault(), 0);
    expect(registry.stateFor("claude")!.consecutiveHardFaults).toBe(1);
  });
});

describe("ProviderCircuitBreaker — p95 trip", () => {
  it("trips on p95 breach after minSamples successful turns; lastFault untouched", () => {
    const { registry, turn } = makeRegistry({ p95WindowSize: 5, p95MinSamples: 3, p95ThresholdMs: 1_000 });
    turn(success(), 2_000);
    turn(success(), 2_000);
    expect(registry.stateFor("claude")!.state).toBe("closed"); // minSamples gate
    expect(registry.stateFor("claude")!.p95Ms).toBeNull();
    turn(success(), 2_000);
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("open");
    expect(snap.reason).toBe("p95-breach");
    expect(snap.lastFaultMessage).toBeNull();
    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.reason).toBe("p95-breach");
    expect(err.lastFaultMessage).toBeNull();
  });

  it("clears the window on close so stale latencies can't re-trip", () => {
    const { registry, turn, advance } = makeRegistry({
      p95WindowSize: 5,
      p95MinSamples: 3,
      p95ThresholdMs: 1_000,
    });
    turn(success(), 2_000);
    turn(success(), 2_000);
    turn(success(), 2_000); // open (p95)
    advance(15_000);
    turn(success(), 50); // probe succeeds → closed + window cleared
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("closed");
    expect(snap.sampleCount).toBe(1); // only the probe's own sample
    expect(snap.p95Ms).toBeNull();
  });

  it("close() clears stale fault telemetry — a later p95 trip pins lastFaultMessage null", () => {
    const { registry, turn, advance } = makeRegistry({
      p95WindowSize: 5,
      p95MinSamples: 3,
      p95ThresholdMs: 1_000,
    });
    turn(hardFault());
    turn(hardFault());
    turn(hardFault()); // opens; lastFaultMessage set to the hard-fault text
    advance(15_000);
    turn(success(), 50); // probe succeeds → closed; lastFault* must be cleared
    turn(success(), 2_000);
    turn(success(), 2_000); // 3rd sample — p95 breach, pure latency trip
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("open");
    expect(snap.reason).toBe("p95-breach");
    expect(snap.lastFaultMessage).toBeNull(); // not the stale hard-fault message
  });
});

describe("ProviderCircuitBreaker — open / half-open / recovery", () => {
  function tripped(overrides: Partial<CircuitBreakerConfig> = {}) {
    const h = makeRegistry(overrides);
    h.turn(hardFault());
    h.turn(hardFault());
    h.turn(hardFault());
    return h;
  }

  it("retryAfterMs counts down; probe admitted lazily at openedAt + cooldown", () => {
    const { registry, advance } = tripped();
    advance(5_000);
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(10_000);
    advance(10_000);
    const permit = registry.acquire("claude");
    expect(permit.isProbe).toBe(true);
    expect(registry.stateFor("claude")!.state).toBe("half-open");
    expect(registry.stateFor("claude")!.probeInFlight).toBe(true);
  });

  it("CONTRACT: concurrent acquire during an in-flight probe throws with retryAfterMs === 0", () => {
    const { registry, advance } = tripped();
    advance(15_000);
    registry.acquire("claude"); // probe out
    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.retryAfterMs).toBe(0);
  });

  it("probe success closes and resets streak + backoff", () => {
    const { registry, advance, turn } = tripped();
    advance(15_000);
    const probe = registry.acquire("claude");
    registry.record(probe, success(), 100);
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("closed");
    expect(snap.consecutiveHardFaults).toBe(0);
    expect(snap.openedAt).toBeNull();
    expect(snap.reason).toBeNull();
    // Backoff reset: re-trip → first cooldown is base again.
    turn(hardFault());
    turn(hardFault());
    turn(hardFault());
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(15_000);
  });

  it("probe non-provider fault closes (reachability proves provider up)", () => {
    const { registry, advance } = tripped();
    advance(15_000);
    const probe = registry.acquire("claude");
    registry.record(probe, nonProviderFault(), 0);
    expect(registry.stateFor("claude")!.state).toBe("closed");
  });

  it("probe hard fault reopens with doubled cooldown, capped at openMaxMs", () => {
    const { registry, advance } = tripped();
    // failed probe #1 → cooldown 30s
    advance(15_000);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    expect(registry.stateFor("claude")!.state).toBe("open");
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(30_000);
    // failed probe #2 → cooldown 60s
    advance(30_000);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(60_000);
    // failed probe #3 → still capped at 60s
    advance(60_000);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(60_000);
  });

  it("aborted probe reopens without backoff escalation", () => {
    const { registry, advance } = tripped();
    advance(15_000);
    registry.record(registry.acquire("claude"), aborted(), 0);
    expect(registry.stateFor("claude")!.state).toBe("open");
    expect(expectOpenThrow(() => registry.acquire("claude")).retryAfterMs).toBe(15_000);
  });

  it("tripCount counts closed→open only (reopen is not a trip)", () => {
    const { registry, advance, turn } = tripped();
    expect(registry.stateFor("claude")!.tripCount).toBe(1);
    advance(15_000);
    registry.record(registry.acquire("claude"), hardFault(), 0); // reopen
    expect(registry.stateFor("claude")!.tripCount).toBe(1);
    advance(30_000);
    registry.record(registry.acquire("claude"), success(), 100); // close
    turn(hardFault());
    turn(hardFault());
    turn(hardFault()); // second real trip
    expect(registry.stateFor("claude")!.tripCount).toBe(2);
  });

  it("late permit (acquired closed, recorded after trip) never transitions state", () => {
    const { registry } = makeRegistry();
    const late = registry.acquire("claude"); // closed at acquire time
    registry.record(registry.acquire("claude"), hardFault(), 0);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    registry.record(registry.acquire("claude"), hardFault(), 0); // open
    registry.record(late, success(), 100); // must NOT close the breaker
    expect(registry.stateFor("claude")!.state).toBe("open");
  });

  it("stale probe permit is reconciled as inconclusive on next acquire", () => {
    const { registry, advance } = tripped();
    advance(15_000);
    const probe = registry.acquire("claude"); // never recorded
    expect(probe.isProbe).toBe(true);
    advance(360_001);
    // Reconciliation reopens (exponent unchanged) and this acquire hits the
    // fresh cooldown window.
    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.retryAfterMs).toBe(15_000);
    expect(registry.stateFor("claude")!.probeInFlight).toBe(false);
    // After the fresh cooldown a new probe is admitted.
    advance(15_000);
    expect(registry.acquire("claude").isProbe).toBe(true);
  });

  it("fastFailCount counts rejected turns; nextProbeEligibleAt surfaces in snapshot", () => {
    const { registry, nowValue } = tripped();
    expectOpenThrow(() => registry.acquire("claude"));
    expectOpenThrow(() => registry.acquire("claude"));
    const snap = registry.stateFor("claude")!;
    expect(snap.fastFailCount).toBe(2);
    expect(snap.nextProbeEligibleAt).toBe(nowValue() + 15_000);
  });
});

describe("ProviderCircuitBreaker — cross-episode late records (post-recovery flapping guard)", () => {
  it("late hard-fault records from a stale pre-trip cohort are ignored after trip→recover (flapping scenario in miniature)", () => {
    const { registry, advance } = makeRegistry();
    // A hang-type outage: these three turns were admitted while the breaker
    // was still closed, but they don't resolve until well after recovery.
    const stale1 = registry.acquire("claude");
    const stale2 = registry.acquire("claude");
    const stale3 = registry.acquire("claude");
    // Trip the breaker via three unrelated, fresher permits.
    registry.record(registry.acquire("claude"), hardFault(), 0);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    expect(registry.stateFor("claude")!.state).toBe("open");
    expect(registry.stateFor("claude")!.tripCount).toBe(1);
    // Recover via a successful half-open probe.
    advance(15_000);
    registry.record(registry.acquire("claude"), success(), 100);
    expect(registry.stateFor("claude")!.state).toBe("closed");
    // The stale, pre-trip permits finally resolve as hard faults — a burst
    // of exactly the trip threshold, from an already-resolved episode. Pre-
    // fix these pass the `state !== "closed"` gate (state is closed again)
    // and re-trip a healthy provider.
    registry.record(stale1, hardFault(), 0);
    registry.record(stale2, hardFault(), 0);
    registry.record(stale3, hardFault(), 0);
    const snap = registry.stateFor("claude")!;
    expect(snap.state).toBe("closed");
    expect(snap.consecutiveHardFaults).toBe(0);
    expect(snap.tripCount).toBe(1); // unchanged — no re-open from stale evidence
  });

  it("late SUCCESS records from a stale pre-trip cohort do not seed the p95 window", () => {
    const { registry, advance } = makeRegistry({
      p95WindowSize: 5,
      p95MinSamples: 3,
      p95ThresholdMs: 1_000,
    });
    const stale = registry.acquire("claude"); // issued pre-trip, closed
    registry.record(registry.acquire("claude"), hardFault(), 0);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    registry.record(registry.acquire("claude"), hardFault(), 0);
    expect(registry.stateFor("claude")!.state).toBe("open");
    advance(15_000);
    // Probe succeeds → closes and seeds the fresh window with its own sample.
    registry.record(registry.acquire("claude"), success(), 50);
    expect(registry.stateFor("claude")!.sampleCount).toBe(1);
    // Stale cross-episode success resolves after recovery.
    registry.record(stale, success(), 2_000);
    const snap = registry.stateFor("claude")!;
    expect(snap.sampleCount).toBe(1); // unchanged — stale sample not admitted
    expect(snap.state).toBe("closed");
  });

  it("a permit issued in the current episode (post-close, same tick as lastClosedAt) still records normally", () => {
    const { registry, advance, turn } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    turn(hardFault()); // trip
    advance(15_000);
    registry.record(registry.acquire("claude"), success(), 100); // probe closes
    expect(registry.stateFor("claude")!.state).toBe("closed");
    // Acquired at the exact same clock tick as the close (no advance in
    // between) — issuedAt === lastClosedAt. Must count as current-episode
    // (strict `<` in the episode gate), not stale.
    const current = registry.acquire("claude");
    expect(registry.stateFor("claude")!.consecutiveHardFaults).toBe(0);
    registry.record(current, hardFault(), 0);
    expect(registry.stateFor("claude")!.consecutiveHardFaults).toBe(1);
  });
});

describe("ProviderCircuitBreakerRegistry — isolation, shadow mode, defaults", () => {
  it("per-provider isolation: claude open, gemini still grants", () => {
    const { registry, turn } = makeRegistry();
    turn(hardFault());
    turn(hardFault());
    turn(hardFault());
    expectOpenThrow(() => registry.acquire("claude"));
    expect(registry.acquire("gemini").provider).toBe("gemini");
    expect(registry.stateFor("gemini")!.state).toBe("closed");
  });

  it("stateFor returns null for a never-used provider; getSnapshot only carries used ones", () => {
    const { registry, turn } = makeRegistry();
    turn(success());
    expect(registry.stateFor("codex")).toBeNull();
    expect(Object.keys(registry.getSnapshot())).toEqual(["claude"]);
  });

  it("shadow mode: acquire never throws, transitions still tracked, fastFailCount stays 0", () => {
    const { registry, turn, advance } = makeRegistry({ enabled: false });
    turn(hardFault());
    turn(hardFault());
    turn(hardFault());
    expect(registry.stateFor("claude")!.state).toBe("open");
    expect(registry.stateFor("claude")!.enabled).toBe(false);
    const granted = registry.acquire("claude"); // would have fast-failed
    expect(granted.isProbe).toBe(false);
    expect(registry.stateFor("claude")!.fastFailCount).toBe(0);
    // Recovery still works in shadow.
    advance(15_000);
    const probe = registry.acquire("claude");
    expect(probe.isProbe).toBe(true);
    registry.record(probe, success(), 100);
    expect(registry.stateFor("claude")!.state).toBe("closed");
  });

  it("constructor defaults fill an absent/partial config (test-mock safety)", () => {
    const registry = new ProviderCircuitBreakerRegistry(undefined, () => 0);
    const permit = registry.acquire("claude");
    expect(permit.isProbe).toBe(false);
    expect(registry.stateFor("claude")!.enabled).toBe(true);
  });
});
