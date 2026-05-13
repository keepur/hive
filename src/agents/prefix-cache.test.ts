import { describe, expect, it, vi } from "vitest";
import { PrefixCache } from "./prefix-cache.js";

describe("PrefixCache.getOrBuild", () => {
  it("returns cached entry on second call without re-invoking the builder", async () => {
    const cache = new PrefixCache();
    const builder = vi.fn(async () => "PREFIX-A");

    const first = await cache.getOrBuild("agent-1", builder);
    const second = await cache.getOrBuild("agent-1", builder);

    expect(first).toBe("PREFIX-A");
    expect(second).toBe("PREFIX-A");
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after invalidateAgent", async () => {
    const cache = new PrefixCache();
    let nextValue = "PREFIX-1";
    const builder = vi.fn(async () => nextValue);

    const v1 = await cache.getOrBuild("agent-1", builder);
    expect(v1).toBe("PREFIX-1");

    nextValue = "PREFIX-2";
    cache.invalidateAgent("agent-1", "test-trigger");
    const v2 = await cache.getOrBuild("agent-1", builder);

    expect(v2).toBe("PREFIX-2");
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it("invalidateAll forces every agent to rebuild", async () => {
    const cache = new PrefixCache();
    let suffix = "v1";
    const buildA = vi.fn(async () => `A-${suffix}`);
    const buildB = vi.fn(async () => `B-${suffix}`);

    await cache.getOrBuild("a", buildA);
    await cache.getOrBuild("b", buildB);
    expect(cache.size()).toBe(2);

    suffix = "v2";
    cache.invalidateAll("global-trigger");
    expect(cache.size()).toBe(0);

    const a2 = await cache.getOrBuild("a", buildA);
    const b2 = await cache.getOrBuild("b", buildB);
    expect(a2).toBe("A-v2");
    expect(b2).toBe("B-v2");
    expect(buildA).toHaveBeenCalledTimes(2);
    expect(buildB).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent getOrBuild calls for the same agent", async () => {
    const cache = new PrefixCache();
    let resolveBuild!: (value: string) => void;
    const builder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveBuild = resolve;
        }),
    );

    // Three concurrent callers — only one underlying build should run.
    const p1 = cache.getOrBuild("agent-1", builder);
    const p2 = cache.getOrBuild("agent-1", builder);
    const p3 = cache.getOrBuild("agent-1", builder);

    expect(builder).toHaveBeenCalledTimes(1);

    resolveBuild("PREFIX");
    const [v1, v2, v3] = await Promise.all([p1, p2, p3]);
    expect(v1).toBe("PREFIX");
    expect(v2).toBe("PREFIX");
    expect(v3).toBe("PREFIX");
  });

  it("after a failed build, the next getOrBuild retries", async () => {
    const cache = new PrefixCache();
    let attempt = 0;
    const builder = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error("boom");
      return "PREFIX";
    });

    await expect(cache.getOrBuild("agent-1", builder)).rejects.toThrow("boom");
    const v = await cache.getOrBuild("agent-1", builder);
    expect(v).toBe("PREFIX");
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it("invalidateAgent is a no-op for an agent that was never cached", () => {
    const cache = new PrefixCache();
    expect(() => cache.invalidateAgent("never-seen", "test")).not.toThrow();
    expect(cache.size()).toBe(0);
  });

  it("invalidateAll is a no-op when cache is empty", () => {
    const cache = new PrefixCache();
    expect(() => cache.invalidateAll("test")).not.toThrow();
    expect(cache.size()).toBe(0);
  });
});

describe("PrefixCache.stats", () => {
  it("reports hits and misses accurately", async () => {
    const cache = new PrefixCache();
    const builder = vi.fn(async () => "PREFIX");

    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0, entryCount: 0 });

    await cache.getOrBuild("a", builder); // miss
    await cache.getOrBuild("a", builder); // hit
    await cache.getOrBuild("b", builder); // miss
    await cache.getOrBuild("b", builder); // hit
    await cache.getOrBuild("a", builder); // hit

    const s = cache.stats();
    expect(s.hits).toBe(3);
    expect(s.misses).toBe(2);
    expect(s.entryCount).toBe(2);
  });

  it("reports oldestEntryAgeMs based on the oldest builtAt", async () => {
    let now = 1_000;
    const cache = new PrefixCache(() => now);
    const builder = vi.fn(async () => "PREFIX");

    await cache.getOrBuild("a", builder); // builtAt = 1000
    now = 5_000;
    await cache.getOrBuild("b", builder); // builtAt = 5000

    now = 8_000;
    const s = cache.stats();
    // Oldest is "a" at builtAt=1000; age = 8000 - 1000 = 7000.
    expect(s.oldestEntryAgeMs).toBe(7_000);
  });

  it("oldestEntryAgeMs is 0 when cache is empty", () => {
    const cache = new PrefixCache();
    expect(cache.stats().oldestEntryAgeMs).toBe(0);
  });

  it("computes lastBuildP99Ms over the rolling window", async () => {
    let t = 0;
    const cache = new PrefixCache(() => t);

    // 100 builds with linearly increasing duration 1..100ms.
    for (let i = 1; i <= 100; i++) {
      cache.invalidateAll("reset");
      const builder = async () => {
        t += i;
        return `v-${i}`;
      };
      await cache.getOrBuild(`agent-${i}`, builder);
    }

    const s = cache.stats();
    // p99 of [1..100] sorted, idx = ceil(0.99 * 100) - 1 = 98 → value 99.
    expect(s.lastBuildP99Ms).toBe(99);
  });
});

describe("PrefixCache concurrency edge cases", () => {
  it("invalidate during in-flight build still returns the result to the caller", async () => {
    // The original caller awaiting the in-flight build still gets the
    // freshly-built value — dropping it would break correctness for the
    // in-flight request. What changes (post-KPR-220 PR #266 fix) is whether
    // that result gets COMMITTED to the entries cache. See subsequent tests.
    const cache = new PrefixCache();
    let resolveBuild!: (value: string) => void;
    const builder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveBuild = resolve;
        }),
    );

    const p = cache.getOrBuild("agent-1", builder);
    cache.invalidateAgent("agent-1", "mid-flight");
    resolveBuild("PREFIX");
    const value = await p;
    expect(value).toBe("PREFIX");
  });

  it("KPR-220 PR #266 fix: invalidateAgent during in-flight build does NOT commit the stale result", async () => {
    // Pre-fix: when invalidateAgent fired during an in-flight build, the
    // result still wrote to `entries` on resolve, leaving the cache
    // permanently stale until another invalidation fired. Post-fix: a
    // generation counter is bumped by invalidateAgent; the build commit
    // checks the generation and drops the write if it changed.
    const cache = new PrefixCache();
    let resolveStale!: (value: string) => void;
    const staleBuilder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveStale = resolve;
        }),
    );

    const p = cache.getOrBuild("agent-1", staleBuilder);
    cache.invalidateAgent("agent-1", "mid-flight-write");
    resolveStale("STALE_PREFIX");
    await p;

    // Next caller must re-build (the stale result was NOT committed to entries).
    // Negative-verify: remove the generation-check in getOrBuild → this test
    // fails because freshBuilder is never invoked (stale result was committed).
    const freshBuilder = vi.fn(async () => "FRESH_PREFIX");
    const v2 = await cache.getOrBuild("agent-1", freshBuilder);
    expect(v2).toBe("FRESH_PREFIX");
    expect(freshBuilder).toHaveBeenCalledTimes(1);

    // Stats: two misses total (the original cold miss + the post-invalidate miss).
    expect(cache.stats().misses).toBe(2);
    expect(cache.stats().hits).toBe(0);
  });

  it("KPR-220 PR #266 fix: invalidateAll during in-flight build does NOT commit stale result (cold cache)", async () => {
    // The empty-cache early-return in invalidateAll() was a particularly
    // sharp version of the bug: if entries was empty (cache cold), the
    // method early-returned and didn't bump anything — so an in-flight
    // cold build would commit pre-invalidate state. Post-fix: globalGeneration
    // bumps BEFORE the early return.
    const cache = new PrefixCache();
    let resolveStale!: (value: string) => void;
    const staleBuilder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveStale = resolve;
        }),
    );

    // entries is empty (cold cache), but a build is in flight.
    const p = cache.getOrBuild("agent-1", staleBuilder);
    cache.invalidateAll("global-mid-flight");
    resolveStale("STALE_PREFIX");
    await p;

    const freshBuilder = vi.fn(async () => "FRESH_PREFIX");
    const v2 = await cache.getOrBuild("agent-1", freshBuilder);
    expect(v2).toBe("FRESH_PREFIX");
    expect(freshBuilder).toHaveBeenCalledTimes(1);
  });

  it("KPR-220 PR #266 fix: invalidateAgent on one agent does NOT drop unrelated agents' in-flight builds", async () => {
    // Verifies the per-agent (not global-only) granularity of invalidateAgent.
    // Agent A's build is in flight; invalidating agent B must NOT cause
    // agent A's result to be dropped.
    const cache = new PrefixCache();
    let resolveA!: (value: string) => void;
    const builderA = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveA = resolve;
        }),
    );

    const pA = cache.getOrBuild("agent-a", builderA);
    cache.invalidateAgent("agent-b", "unrelated"); // different agent
    resolveA("A_PREFIX");
    await pA;

    // agent-a's prefix WAS committed (unrelated invalidate). Next call hits.
    const v2 = await cache.getOrBuild("agent-a", async () => "should-not-run");
    expect(v2).toBe("A_PREFIX");
  });
});
