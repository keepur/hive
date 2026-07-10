/**
 * KPR-306: per-provider circuit breaker at the provider-adapter boundary.
 *
 * One ProviderCircuitBreaker per AgentProviderId, created lazily by the
 * registry on first use. The breaker owns NO timers — every transition is
 * evaluated lazily on acquire()/record() against the injected clock (the
 * test seam), so there is nothing to unref or shut down.
 *
 * State machine:
 *   closed ──(consecutive hard faults ≥ threshold)──────────────► open
 *   closed ──(p95(llmMs window) > threshold, n ≥ minSamples)────► open
 *   open ────(now ≥ openedAt + cooldown; next acquire)──────────► half-open
 *   half-open ──(probe: success OR non-provider fault)──────────► closed
 *   half-open ──(probe: hard fault)─────────────────────────────► open (backoff×2, cap)
 *   half-open ──(probe: aborted/inconclusive)───────────────────► open (backoff unchanged)
 *
 * OPEN-CIRCUIT CONTRACT (KPR-307 binds to ProviderCircuitOpenError and
 * CircuitBreakerSnapshot — frozen fields, additive evolution only).
 * Contract reconciliation (gate-ordered): while a half-open probe is in
 * flight, concurrent acquires throw with retryAfterMs === 0 — the contract's
 * "0 = probe currently in flight" is authoritative over the spec's half-open
 * prose ("the probe's remaining deadline budget").
 */
import type { AgentProviderId } from "./provider-adapters/types.js";
import {
  HARD_FAULT_KINDS,
  type ProviderFaultKind,
  type TurnClassification,
} from "./provider-adapters/error-classification.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("circuit-breaker");

export interface CircuitBreakerConfig {
  /** false = shadow mode: observe/classify/transition + telemetry, never fast-fail. */
  enabled: boolean;
  /** Hard faults in a row to trip (closed → open). */
  consecutiveFaultThreshold: number;
  /** First cooldown before a half-open probe. */
  openBaseMs: number;
  /** Cooldown cap (exponential backoff ceiling). */
  openMaxMs: number;
  /** llmMs ring-buffer size (successful turns only). */
  p95WindowSize: number;
  /** Samples required before p95 is evaluated. */
  p95MinSamples: number;
  /** p95 above this trips (reason: "p95-breach"). */
  p95ThresholdMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = Object.freeze({
  enabled: true,
  consecutiveFaultThreshold: 3,
  openBaseMs: 15_000,
  openMaxMs: 60_000,
  p95WindowSize: 50,
  p95MinSamples: 20,
  p95ThresholdMs: 240_000,
});

/** lastFaultMessage / lastSpawnError truncation bound (matches KPR-220 Phase 11). */
const FAULT_MESSAGE_MAX = 240;

/**
 * Probe-permit staleness bound: default 300s turn deadline + 60s grace. A
 * probe permit never recorded (caller lost between acquire and record —
 * structurally prevented at the wrap point, belt-and-braces here) is
 * reconciled as inconclusive on the next acquire.
 *
 * Agents with a custom `timeoutMs` > 300s can hit premature stale-probe
 * reconciliation here — bounded and safe: a late probe success still
 * records as telemetry-only, and the next post-cooldown turn re-probes.
 */
const PROBE_STALE_MS = 360_000;

/** Opaque turn-admission handle. `record(permit, …)` makes probe bookkeeping airtight. */
export interface TurnPermit {
  readonly provider: AgentProviderId;
  readonly isProbe: boolean;
}

interface InternalPermit extends TurnPermit {
  recorded: boolean;
  issuedAt: number;
}

/** OPEN-CIRCUIT CONTRACT — frozen fields; additive evolution only (KPR-307). */
export class ProviderCircuitOpenError extends Error {
  override readonly name = "ProviderCircuitOpenError";
  constructor(
    readonly provider: AgentProviderId,
    /** Epoch ms when the breaker (most recently) opened. */
    readonly openedAt: number,
    /** ms from now until the next half-open probe is eligible (0 = probe currently in flight). */
    readonly retryAfterMs: number,
    /** What tripped it: a hard fault kind, or "p95-breach". */
    readonly reason: ProviderFaultKind | "p95-breach",
    /** Last classified fault message, truncated to 240 chars; null for pure p95 trips. */
    readonly lastFaultMessage: string | null,
  ) {
    super(
      `Provider circuit open for ${provider} (reason=${reason}, retry in ~${Math.ceil(retryAfterMs / 1000)}s)`,
    );
  }
}

/** OPEN-CIRCUIT CONTRACT — frozen fields; additive evolution only (KPR-307). */
export interface CircuitBreakerSnapshot {
  provider: AgentProviderId;
  state: "closed" | "open" | "half-open";
  enabled: boolean; // false = shadow mode
  openedAt: number | null;
  reason: ProviderFaultKind | "p95-breach" | null;
  consecutiveHardFaults: number;
  tripCount: number; // lifetime (process) count of closed→open transitions
  lastTripAt: number | null;
  fastFailCount: number; // turns rejected while open (process lifetime)
  lastFaultKind: ProviderFaultKind | null;
  lastFaultMessage: string | null; // truncated 240
  lastFaultAt: number | null;
  p95Ms: number | null; // null until minSamples reached
  sampleCount: number;
  probeInFlight: boolean;
  nextProbeEligibleAt: number | null; // epoch ms; null unless open
}

export class ProviderCircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private consecutiveHardFaults = 0;
  private backoffExponent = 0;
  private openedAt: number | null = null;
  private reason: ProviderFaultKind | "p95-breach" | null = null;
  private tripCount = 0;
  private lastTripAt: number | null = null;
  private fastFailCount = 0;
  private fastFailLoggedSinceOpen = false;
  private lastFaultKind: ProviderFaultKind | null = null;
  private lastFaultMessage: string | null = null;
  private lastFaultAt: number | null = null;
  // Ring buffer of successful-turn llmMs samples. windowCursor counts total
  // insertions; index = windowCursor % p95WindowSize.
  private window: number[] = [];
  private windowCursor = 0;
  private probe: InternalPermit | null = null;
  private probeStartedAt: number | null = null;
  // Episode marker: epoch ms of the most recent half-open → closed
  // transition. -Infinity for a breaker that has never tripped, so no
  // permit issued at a real timestamp is ever rejected as cross-episode.
  // record() uses this to distinguish a stale pre-trip permit (belongs to
  // an already-resolved episode) from a genuine current-episode permit,
  // even once the breaker's *state* has cycled back to "closed" — see
  // record() for why the state check alone isn't sufficient.
  private lastClosedAt = -Infinity;

  constructor(
    readonly provider: AgentProviderId,
    private readonly config: CircuitBreakerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private cooldownMs(): number {
    return Math.min(this.config.openBaseMs * 2 ** this.backoffExponent, this.config.openMaxMs);
  }

  /**
   * Admit or reject a turn. Throws ProviderCircuitOpenError while open (and
   * in half-open when the probe slot is taken) unless shadow mode. Lazy
   * transitions: open → half-open happens here, on the first acquire at or
   * after openedAt + cooldown — that acquire becomes the probe.
   */
  acquire(meta?: { agentId?: string; threadId?: string }): TurnPermit {
    const now = this.now();

    // Belt-and-braces: reconcile a probe permit that was never recorded.
    if (
      this.state === "half-open" &&
      this.probe !== null &&
      this.probeStartedAt !== null &&
      now - this.probeStartedAt > PROBE_STALE_MS
    ) {
      log.warn("Provider circuit probe went stale — treating as inconclusive", {
        provider: this.provider,
        ageMs: now - this.probeStartedAt,
      });
      this.probe = null;
      this.probeStartedAt = null;
      this.reopen(now, false);
    }

    if (this.state === "open" && this.openedAt !== null && now >= this.openedAt + this.cooldownMs()) {
      this.state = "half-open"; // fall through — this acquire becomes the probe
    }

    if (this.state === "closed") {
      return this.issuePermit(false, now);
    }

    if (this.state === "half-open") {
      if (this.probe === null) {
        const permit = this.issuePermit(true, now);
        this.probe = permit;
        this.probeStartedAt = now;
        log.info("Provider circuit half-open — admitting probe turn", {
          provider: this.provider,
          agentId: meta?.agentId,
          threadId: meta?.threadId,
        });
        return permit;
      }
      // Concurrent acquire while the probe is in flight.
      // CONTRACT: retryAfterMs === 0 signals "probe currently in flight".
      return this.reject(0, now);
    }

    // open, cooldown not yet elapsed
    const retryAfterMs = Math.max(0, (this.openedAt ?? now) + this.cooldownMs() - now);
    return this.reject(retryAfterMs, now);
  }

  /**
   * Record the outcome of a permitted turn. Idempotent per permit. Only the
   * designated half-open probe's outcome drives half-open transitions; late
   * permits (acquired closed, finishing after a trip) feed lastFault*
   * telemetry only and never transition state. Permits that outlive a full
   * trip→recover cycle (issued before the breaker's most recent close) are
   * likewise telemetry-only even though the breaker is "closed" again by
   * the time they resolve — otherwise a stale cohort of pre-trip turns can
   * re-pollute the freshly reset streak/p95 window and flap a recovered
   * provider back open.
   */
  record(permit: TurnPermit, classification: TurnClassification, llmMs: number): void {
    const p = permit as InternalPermit;
    if (p.recorded) return;
    p.recorded = true;
    const now = this.now();

    if (classification.outcome === "fault") {
      this.lastFaultKind = classification.kind;
      this.lastFaultMessage = classification.message.slice(0, FAULT_MESSAGE_MAX);
      this.lastFaultAt = now;
    }

    if (this.probe === p) {
      this.probe = null;
      this.probeStartedAt = null;
      this.settleProbe(classification, now, llmMs);
      return;
    }

    if (this.state !== "closed") return; // late permit — telemetry only

    // Episode gate: a permit issued before the breaker's most recent close
    // belongs to a prior (already-resolved) episode — a late hard-fault or
    // success from a stale pre-trip cohort must not feed the current
    // episode's streak or p95 window. Strict `<` so a permit issued at
    // exactly lastClosedAt (same clock tick as the close) still counts as
    // current-episode. Never true for a breaker that hasn't tripped yet
    // (lastClosedAt is -Infinity).
    if (p.issuedAt < this.lastClosedAt) return; // cross-episode — telemetry only

    switch (classification.outcome) {
      case "success": {
        this.consecutiveHardFaults = 0;
        this.pushSample(llmMs);
        if (this.sampleCount() >= this.config.p95MinSamples) {
          const p95 = this.computeP95();
          if (p95 !== null && p95 > this.config.p95ThresholdMs) {
            // Pure latency trip — lastFaultMessage stays whatever it was;
            // the error surface reports null for p95 trips via `reason`.
            this.open(now, "p95-breach");
          }
        }
        return;
      }
      case "aborted":
        // Inconclusive — the turn never reached a provider-attributable
        // outcome. Streak unchanged.
        return;
      case "fault": {
        if (HARD_FAULT_KINDS.has(classification.kind)) {
          this.consecutiveHardFaults++;
          if (this.consecutiveHardFaults >= this.config.consecutiveFaultThreshold) {
            this.open(now, classification.kind);
          }
        } else {
          // non-provider: the turn traversed the provider path and got a
          // response — proves the provider is up. Resets the streak (same
          // reachability logic as the half-open close rule).
          this.consecutiveHardFaults = 0;
        }
        return;
      }
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      provider: this.provider,
      state: this.state,
      enabled: this.config.enabled,
      openedAt: this.openedAt,
      reason: this.reason,
      consecutiveHardFaults: this.consecutiveHardFaults,
      tripCount: this.tripCount,
      lastTripAt: this.lastTripAt,
      fastFailCount: this.fastFailCount,
      lastFaultKind: this.lastFaultKind,
      lastFaultMessage: this.lastFaultMessage,
      lastFaultAt: this.lastFaultAt,
      p95Ms: this.sampleCount() >= this.config.p95MinSamples ? this.computeP95() : null,
      sampleCount: this.sampleCount(),
      probeInFlight: this.probe !== null,
      nextProbeEligibleAt:
        this.state === "open" && this.openedAt !== null ? this.openedAt + this.cooldownMs() : null,
    };
  }

  // ── internals ──────────────────────────────────────────────────────

  private issuePermit(isProbe: boolean, now: number): InternalPermit {
    return { provider: this.provider, isProbe, recorded: false, issuedAt: now };
  }

  private reject(retryAfterMs: number, now: number): TurnPermit {
    if (!this.config.enabled) {
      // Shadow mode: would have fast-failed — grant a normal (non-probe)
      // permit and keep observing. fastFailCount stays literal ("turns
      // rejected"): nothing is rejected in shadow.
      return this.issuePermit(false, now);
    }
    this.fastFailCount++;
    if (!this.fastFailLoggedSinceOpen) {
      // Sustained-condition discipline (KPR-295): first fast-fail after each
      // open transition, then silent — fastFailCount carries the volume.
      this.fastFailLoggedSinceOpen = true;
      log.warn("Provider circuit open — fast-failing turns", {
        provider: this.provider,
        reason: this.reason,
        retryAfterMs,
      });
    }
    // Invariant: reason is set on every open()/reopen() path; the fallback
    // exists only for type narrowing.
    throw new ProviderCircuitOpenError(
      this.provider,
      this.openedAt ?? now,
      retryAfterMs,
      this.reason ?? "connect-fail",
      this.lastFaultMessage,
    );
  }

  /** closed → open. The only path that increments tripCount (contract). */
  private open(now: number, reason: ProviderFaultKind | "p95-breach"): void {
    this.state = "open";
    this.openedAt = now;
    this.reason = reason;
    this.tripCount++;
    this.lastTripAt = now;
    this.fastFailLoggedSinceOpen = false;
    log.error("Provider circuit OPENED", {
      provider: this.provider,
      reason,
      consecutiveHardFaults: this.consecutiveHardFaults,
      lastFaultMessage: this.lastFaultMessage,
      cooldownMs: this.cooldownMs(),
    });
  }

  /** half-open → open (failed/inconclusive probe). Not a trip for tripCount. */
  private reopen(now: number, escalate: boolean, reason?: ProviderFaultKind): void {
    this.state = "open";
    this.openedAt = now;
    if (escalate) this.backoffExponent++;
    if (reason) this.reason = reason;
    this.fastFailLoggedSinceOpen = false;
    log.error("Provider circuit OPENED", {
      provider: this.provider,
      reason: this.reason,
      consecutiveHardFaults: this.consecutiveHardFaults,
      lastFaultMessage: this.lastFaultMessage,
      cooldownMs: this.cooldownMs(),
    });
  }

  /** half-open → closed. Resets counters, clears window, resets backoff. */
  private close(now: number): void {
    const openForMs = this.openedAt !== null ? now - this.openedAt : 0;
    this.state = "closed";
    this.openedAt = null;
    this.reason = null;
    this.consecutiveHardFaults = 0;
    this.backoffExponent = 0;
    // Mark the episode boundary — record() uses this to reject stale
    // pre-trip permits that resolve after recovery (cross-episode gate).
    this.lastClosedAt = now;
    // Clear the window so pre-outage latencies can't instantly re-trip a
    // recovered provider.
    this.window = [];
    this.windowCursor = 0;
    // Clear stale fault telemetry too — otherwise a later pure p95 trip
    // would carry a fault message from an unrelated, already-recovered
    // incident (contract: lastFaultMessage is null for pure p95 trips).
    this.lastFaultKind = null;
    this.lastFaultMessage = null;
    this.lastFaultAt = null;
    this.fastFailLoggedSinceOpen = false;
    log.info("Provider circuit CLOSED — provider recovered", {
      provider: this.provider,
      openForMs,
      tripCount: this.tripCount,
    });
  }

  private settleProbe(classification: TurnClassification, now: number, llmMs: number): void {
    if (
      classification.outcome === "success" ||
      (classification.outcome === "fault" && !HARD_FAULT_KINDS.has(classification.kind))
    ) {
      // A turn that reached the provider and failed on something else still
      // proves the provider is reachable — closes.
      this.close(now);
      if (classification.outcome === "success") {
        // Seed the fresh window with the probe's own successful latency —
        // discarding a genuine successful turn would blind the p95 window's
        // warm-up right after recovery (plan-review round-1 decision).
        this.pushSample(llmMs);
      }
      return;
    }
    if (classification.outcome === "aborted") {
      this.reopen(now, false); // inconclusive: exponent unchanged
      return;
    }
    this.reopen(now, true, classification.kind); // hard fault: cooldown doubles (capped)
  }

  private pushSample(llmMs: number): void {
    if (!Number.isFinite(llmMs) || llmMs < 0) return;
    this.window[this.windowCursor % this.config.p95WindowSize] = llmMs;
    this.windowCursor++;
  }

  private sampleCount(): number {
    return Math.min(this.windowCursor, this.config.p95WindowSize);
  }

  private computeP95(): number | null {
    const n = this.sampleCount();
    if (n === 0) return null;
    const sorted = this.window.slice(0, n).sort((a, b) => a - b);
    return sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)] ?? null;
  }
}

/**
 * Lazy per-provider breaker map. A claude-only instance gets exactly one
 * breaker and one telemetry row. Accepts a partial/absent config (test
 * mocks of appConfig may omit `circuitBreaker`) — defaults fill the gaps.
 */
export class ProviderCircuitBreakerRegistry {
  private readonly breakers = new Map<AgentProviderId, ProviderCircuitBreaker>();
  private readonly config: CircuitBreakerConfig;

  constructor(
    config?: Partial<CircuitBreakerConfig>,
    private readonly now: () => number = Date.now,
  ) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  private breakerFor(provider: AgentProviderId): ProviderCircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new ProviderCircuitBreaker(provider, this.config, this.now);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  /** Throws ProviderCircuitOpenError if open (and no probe permit available). */
  acquire(provider: AgentProviderId, meta?: { agentId?: string; threadId?: string }): TurnPermit {
    return this.breakerFor(provider).acquire(meta);
  }

  /** Record the outcome of a permitted turn. Idempotent per permit. */
  record(permit: TurnPermit, classification: TurnClassification, llmMs: number): void {
    this.breakers.get(permit.provider)?.record(permit, classification, llmMs);
  }

  /** null = provider never used in this process. */
  stateFor(provider: AgentProviderId): CircuitBreakerSnapshot | null {
    return this.breakers.get(provider)?.snapshot() ?? null;
  }

  getSnapshot(): Partial<Record<AgentProviderId, CircuitBreakerSnapshot>> {
    const out: Partial<Record<AgentProviderId, CircuitBreakerSnapshot>> = {};
    for (const [provider, breaker] of this.breakers) out[provider] = breaker.snapshot();
    return out;
  }
}
