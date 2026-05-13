/**
 * Prefix cache — write-through, in-memory cache of assembled system-prompt
 * prefixes. Keyed by agentId. Invalidated explicitly by every write path
 * that affects the prefix (agent-def updates, memory writes, constitution,
 * team roster, skills). Long-lived `query()` shape uses this as a
 * read-through fallback today; per-turn-spawn (KPR-216–219) reads it
 * directly per spawn.
 *
 * KPR-213 spec: §D2 of 2026-05-10-kpr-209-phase-a-design.md.
 *
 * Behaviors:
 *  - **Single-flight per agent**: concurrent getOrBuild for the same
 *    agentId share one in-flight build (avoids thundering-herd on cold
 *    cache after a global invalidate).
 *  - **Synchronous invalidation**: invalidateAgent / invalidateAll only
 *    mutate the in-memory map; safe to call from sync write paths and
 *    async tool handlers alike.
 *  - **No TTL**: invalidation is exclusively trigger-driven. A stale
 *    entry stays until something actively invalidates it.
 *  - **No persistence**: cache is process-local. Restart rebuilds on
 *    first request.
 */

import { createLogger } from "../logging/logger.js";

const log = createLogger("prefix-cache");

/**
 * Build callback shape — caller supplies the actual prefix-assembly
 * function. Cache treats this as a black box; it doesn't care about
 * inputs beyond agentId.
 */
export type PrefixBuilder = () => Promise<string>;

export interface PrefixCacheEntry {
  prefix: string;
  /** Wall-clock timestamp of build completion — used for `oldestEntryAgeMs`. */
  builtAt: number;
  /** Observed assembly cost — used for p99 telemetry. */
  buildDurationMs: number;
}

export interface PrefixCacheStats {
  hits: number;
  misses: number;
  /** p99 of the most recent N build durations (rolling window). */
  lastBuildP99Ms: number;
  entryCount: number;
  /** Age (ms) of the oldest cached entry, or 0 if cache empty. */
  oldestEntryAgeMs: number;
}

/** Rolling window size for p99 build-duration telemetry. */
const P99_WINDOW = 200;

interface InflightBuild {
  promise: Promise<string>;
  /** Generation snapshot at build start. A caller arriving later only joins
   * this in-flight build if both counters still match — otherwise the build
   * is operating on pre-invalidate state and a fresh build is started. */
  generations: { perAgent: number; global: number };
}

export class PrefixCache {
  private entries = new Map<string, PrefixCacheEntry>();
  private inflight = new Map<string, InflightBuild>();

  // KPR-220 PR #266 review fix: invalidation generation counters. `getOrBuild`
  // captures the (perAgent, global) generation at build start; on resolve, the
  // result is only committed to `entries` if both are unchanged. Without this,
  // an `invalidate*` that fires while a build is awaiting I/O is silently
  // overwritten when the (stale) build result resolves — leaving the cache
  // permanently stale until another invalidate fires.
  private generations = new Map<string, number>();
  private globalGeneration = 0;

  // Telemetry — incremented on every getOrBuild call.
  private hitCount = 0;
  private missCount = 0;
  // Rolling window of build durations for p99. Append-on-build, evict
  // from the head when length > P99_WINDOW.
  private buildDurations: number[] = [];

  constructor(private now: () => number = () => Date.now()) {}

  /**
   * Returns the cached prefix for `agentId`, building it via `builder`
   * on miss. Concurrent callers for the same agent share the in-flight
   * build (single-flight).
   */
  async getOrBuild(agentId: string, builder: PrefixBuilder): Promise<string> {
    const cached = this.entries.get(agentId);
    if (cached) {
      this.hitCount++;
      return cached.prefix;
    }

    const currentGen = {
      perAgent: this.generations.get(agentId) ?? 0,
      global: this.globalGeneration,
    };

    // Miss path. Coalesce concurrent builds for the same agent — but ONLY
    // when the in-flight build was started under the SAME generation as
    // current. If an invalidate fired between the in-flight build's start
    // and this caller's arrival, the in-flight is operating on stale
    // pre-invalidate state; this caller must NOT receive that result.
    // Start a fresh build instead. The old in-flight still resolves and
    // its result is dropped via the generation check in .then(); the
    // identity-check on .finally below prevents the old build from
    // deleting the new in-flight entry on cleanup.
    const inflight = this.inflight.get(agentId);
    if (
      inflight &&
      inflight.generations.perAgent === currentGen.perAgent &&
      inflight.generations.global === currentGen.global
    ) {
      // Don't double-count misses for the joiners — they're the same
      // logical miss as the original. Only the first caller incremented
      // the miss counter (handled below in the build branch).
      return inflight.promise;
    }

    this.missCount++;
    const buildStart = this.now();
    const genAtBuildStart = currentGen;
    const promise = builder()
      .then((prefix) => {
        const builtAt = this.now();
        const buildDurationMs = builtAt - buildStart;
        const perAgentNow = this.generations.get(agentId) ?? 0;
        if (
          perAgentNow === genAtBuildStart.perAgent &&
          this.globalGeneration === genAtBuildStart.global
        ) {
          this.entries.set(agentId, { prefix, builtAt, buildDurationMs });
        } else {
          log.debug("prefix-cache build dropped — invalidation fired during build", {
            agent: agentId,
            perAgentAtStart: genAtBuildStart.perAgent,
            perAgentNow,
            globalAtStart: genAtBuildStart.global,
            globalNow: this.globalGeneration,
          });
        }
        this.recordBuildDuration(buildDurationMs);
        return prefix;
      })
      .finally(() => {
        // Identity-check via the chained promise: only delete if WE are
        // still the registered in-flight entry. A newer build (started
        // after an intervening invalidation) may have replaced this entry;
        // that newer entry must NOT be deleted by this older build's
        // cleanup. The chained-promise reference is captured by closure
        // here; at run-time (after the chain resolves) the outer `const
        // promise` is fully bound.
        if (this.inflight.get(agentId)?.promise === promise) {
          this.inflight.delete(agentId);
        }
      });
    this.inflight.set(agentId, { promise, generations: genAtBuildStart });
    return promise;
  }

  /**
   * Invalidate a single agent's cached prefix. Safe to call when no
   * entry exists (no-op).
   */
  invalidateAgent(agentId: string, reason: string): void {
    // Bump generation BEFORE deleting the entry. If a build for this agent is
    // currently in flight, this bump ensures its resolution drops the result
    // instead of committing it (see getOrBuild's generation check).
    this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    const had = this.entries.delete(agentId);
    if (had) {
      log.debug("prefix-cache invalidated", { agent: agentId, reason });
    }
  }

  /**
   * Invalidate every cached prefix. Used for global triggers
   * (constitution edits, skill changes, team-roster changes, SIGUSR1).
   */
  invalidateAll(reason: string): void {
    // Bump global generation regardless of whether entries is empty — an
    // empty cache may still have in-flight builds that this invalidation
    // should cancel. Without this, a global invalidate during a cold build
    // would silently overwrite with the pre-invalidate prefix.
    this.globalGeneration++;
    if (this.entries.size === 0) return;
    const count = this.entries.size;
    this.entries.clear();
    log.info("prefix-cache invalidated all", { count, reason });
  }

  /** Number of entries currently cached. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Snapshot stats. Doctor surface (KPR-213 step 8) renders this; the
   * engine periodically heartbeats it to Mongo so the out-of-process
   * doctor CLI can read it.
   */
  stats(): PrefixCacheStats {
    const now = this.now();
    let oldestEntryAgeMs = 0;
    for (const entry of this.entries.values()) {
      const age = now - entry.builtAt;
      if (age > oldestEntryAgeMs) oldestEntryAgeMs = age;
    }
    return {
      hits: this.hitCount,
      misses: this.missCount,
      lastBuildP99Ms: this.computeP99(this.buildDurations),
      entryCount: this.entries.size,
      oldestEntryAgeMs,
    };
  }

  private recordBuildDuration(ms: number): void {
    this.buildDurations.push(ms);
    if (this.buildDurations.length > P99_WINDOW) {
      this.buildDurations.splice(0, this.buildDurations.length - P99_WINDOW);
    }
  }

  /**
   * Compute p99 of the rolling-window samples. Returns 0 for an empty
   * window. p99 here = the value at the 99th percentile by linear-rank
   * (no interpolation) — good enough for a debug surface.
   */
  private computeP99(samples: number[]): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    // Index = ceil(0.99 * n) - 1, clamped to [0, n-1].
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.99 * sorted.length) - 1));
    return sorted[idx];
  }
}
