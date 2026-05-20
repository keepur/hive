import { describe, expect, it, vi } from "vitest";
import {
  invalidatePrefixCacheByMemoryPath,
  prefixInvalidationScopeForMemoryPath,
} from "./prefix-invalidation.js";

describe("prefixInvalidationScopeForMemoryPath", () => {
  it("invalidates only the owning agent for agent memory paths", () => {
    expect(prefixInvalidationScopeForMemoryPath("agents/river/memory.md")).toEqual({
      kind: "agent",
      agentId: "river",
    });
  });

  it("invalidates all agents for shared prompt memory", () => {
    expect(prefixInvalidationScopeForMemoryPath("shared/constitution.md")).toEqual({ kind: "all" });
  });

  it("does not invalidate prompt prefixes for operational status documents", () => {
    expect(prefixInvalidationScopeForMemoryPath("status/health.json")).toEqual({ kind: "none" });
  });

  it("keeps legacy all-agent invalidation for unknown non-agent paths", () => {
    expect(prefixInvalidationScopeForMemoryPath("legacy/global.md")).toEqual({ kind: "all" });
  });
});

describe("invalidatePrefixCacheByMemoryPath", () => {
  it("skips PrefixCache calls for status paths", () => {
    const cache = {
      invalidateAgent: vi.fn(),
      invalidateAll: vi.fn(),
    };

    invalidatePrefixCacheByMemoryPath(cache as any, "status/health.json", "memory-manager-write");

    expect(cache.invalidateAgent).not.toHaveBeenCalled();
    expect(cache.invalidateAll).not.toHaveBeenCalled();
  });
});
