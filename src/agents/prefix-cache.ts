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

export class PrefixCache {
  private entries = new Map<string, PrefixCacheEntry>();
  private inflight = new Map<string, Promise<string>>();

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

    // Miss path. Coalesce concurrent builds for the same agent.
    const inflight = this.inflight.get(agentId);
    if (inflight) {
      // Don't double-count misses for the joiners — they're the same
      // logical miss as the original. Only the first caller increments
      // the miss counter (handled below in the build branch).
      return inflight;
    }

    this.missCount++;
    const buildStart = this.now();
    const promise = builder()
      .then((prefix) => {
        const builtAt = this.now();
        const buildDurationMs = builtAt - buildStart;
        this.entries.set(agentId, { prefix, builtAt, buildDurationMs });
        this.recordBuildDuration(buildDurationMs);
        return prefix;
      })
      .finally(() => {
        // Drop the in-flight entry whether or not the build succeeded —
        // a failed build should not block future retries.
        this.inflight.delete(agentId);
      });
    this.inflight.set(agentId, promise);
    return promise;
  }

  /**
   * Invalidate a single agent's cached prefix. Safe to call when no
   * entry exists (no-op).
   */
  invalidateAgent(agentId: string, reason: string): void {
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
