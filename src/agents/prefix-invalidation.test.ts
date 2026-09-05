import { describe, expect, it, vi } from "vitest";
import {
  invalidatePrefixCacheByMemoryPath,
  prefixInvalidationScopeForMemoryPath,
} from "./prefix-invalidation.js";

describe("prefixInvalidationScopeForMemoryPath", () => {
  it("KPR-434: agent memory paths never invalidate the prefix (memory rides the turn input)", () => {
    expect(prefixInvalidationScopeForMemoryPath("agents/river/memory.md")).toEqual({ kind: "none" });
    expect(prefixInvalidationScopeForMemoryPath("agents/river/projects.md")).toEqual({ kind: "none" });
    expect(prefixInvalidationScopeForMemoryPath("agents/chief-of-staff/notes/2026.md")).toEqual({ kind: "none" });
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

  it("KPR-434: skips PrefixCache calls for agent memory paths; constitution still invalidates all", () => {
    const cache = { invalidateAgent: vi.fn(), invalidateAll: vi.fn() };
    invalidatePrefixCacheByMemoryPath(cache as any, "agents/river/memory.md", "memory-manager-write");
    expect(cache.invalidateAgent).not.toHaveBeenCalled();
    expect(cache.invalidateAll).not.toHaveBeenCalled();
    invalidatePrefixCacheByMemoryPath(cache as any, "shared/constitution.md", "memory-manager-write");
    expect(cache.invalidateAll).toHaveBeenCalledTimes(1);
  });
});
