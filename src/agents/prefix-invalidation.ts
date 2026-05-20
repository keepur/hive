import type { PrefixCache } from "./prefix-cache.js";

export type PrefixInvalidationScope =
  | { kind: "agent"; agentId: string }
  | { kind: "all" }
  | { kind: "none" };

/**
 * Translate a MemoryManager path into the prompt-prefix cache scope it can affect.
 *
 * Prompt prefix inputs currently read FS-style memory from:
 * - shared/*, especially shared/constitution.md
 * - agents/<id>/*, for legacy memory.md and available-memory listings
 *
 * Operational status documents live in the same Mongo memory collection for
 * convenience, but they are not injected into prompts and must not churn every
 * agent's prefix cache on heartbeat writes.
 */
export function prefixInvalidationScopeForMemoryPath(path: string): PrefixInvalidationScope {
  const agentMatch = path.match(/^agents\/([^/]+)\//);
  if (agentMatch) return { kind: "agent", agentId: agentMatch[1] };

  if (path.startsWith("status/")) return { kind: "none" };

  if (path.startsWith("shared/")) return { kind: "all" };

  // Legacy safety: unknown non-agent paths used to invalidate everyone. Keep
  // that conservative behavior unless a path family is known not to affect prompts.
  return { kind: "all" };
}

export function invalidatePrefixCacheByMemoryPath(cache: PrefixCache, path: string, reason: string): void {
  const scope = prefixInvalidationScopeForMemoryPath(path);
  if (scope.kind === "agent") {
    cache.invalidateAgent(scope.agentId, reason);
  } else if (scope.kind === "all") {
    cache.invalidateAll(reason);
  }
}
