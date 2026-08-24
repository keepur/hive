/**
 * KPR-381: module-level TTL cache for the Gemini live model lookup.
 *
 * Mirrors src/team-roster/team-cache.ts's CacheSlice shape, but lives at
 * module scope rather than inside a class instance: buildAdminTools() runs
 * once per AgentRunner spawn (fresh instance per turn post-KPR-220), so a
 * closure-scoped cache would never get a hit across turns. Module scope
 * makes it a process-wide singleton.
 *
 * ~10 minutes: long enough to avoid redundant vendor calls within one
 * conversation, short enough that a same-session "refresh" mentally still
 * feels live (spec, Gemini live-lookup section). A stale-but-present slice
 * is never served past TTL — expiry is a hard miss, and a fetch failure
 * never falls back to the stale slice (honest-failure posture).
 */

interface CacheSlice<T> {
  data: T[] | null;
  loadedAt: number;
}

export const GEMINI_CACHE_TTL_MS = 10 * 60_000;

let slice: CacheSlice<unknown> = { data: null, loadedAt: 0 };

export function getCachedGeminiModels<T>(): T[] | null {
  if (slice.data && Date.now() - slice.loadedAt < GEMINI_CACHE_TTL_MS) {
    return slice.data as T[];
  }
  return null;
}

export function setCachedGeminiModels<T>(data: T[]): void {
  slice = { data, loadedAt: Date.now() };
}

/** Test hook + honest-failure reset. Clears the slice unconditionally. */
export function invalidateGeminiModelCache(): void {
  slice = { data: null, loadedAt: 0 };
}
