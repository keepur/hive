import { describe, it, expect, vi } from "vitest";

// model-router.ts imports ../config.js, which reads required env vars (e.g.
// SLACK_APP_TOKEN) at module load. These tests only exercise pure helpers, so
// stub config.js so the suite runs without any env wiring.
vi.mock("../config.js", () => ({
  config: {},
}));

import { resolveResourceLimits, RESOURCE_TIER_DEFAULTS } from "./model-router.js";

describe("resolveResourceLimits", () => {
  it("returns global defaults when no agent overrides", () => {
    const limits = resolveResourceLimits("haiku");
    expect(limits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
  });

  it("returns global defaults when agent overrides is undefined", () => {
    const limits = resolveResourceLimits("sonnet", undefined);
    expect(limits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
  });

  it("returns global defaults when agent has no override for the tier", () => {
    const limits = resolveResourceLimits("haiku", { opus: { timeoutMs: 900_000 } });
    expect(limits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
  });

  it("merges partial agent overrides with global defaults", () => {
    const limits = resolveResourceLimits("opus", {
      opus: { timeoutMs: 900_000 },
    });
    expect(limits).toEqual({
      timeoutMs: 900_000,
      maxTurns: RESOURCE_TIER_DEFAULTS.opus.maxTurns,
      budgetUsd: RESOURCE_TIER_DEFAULTS.opus.budgetUsd,
    });
  });

  it("fully overrides all fields when all specified", () => {
    const limits = resolveResourceLimits("sonnet", {
      sonnet: { timeoutMs: 60_000, maxTurns: 10, budgetUsd: 0.5 },
    });
    expect(limits).toEqual({ timeoutMs: 60_000, maxTurns: 10, budgetUsd: 0.5 });
  });

  it("returns a copy, not a reference to defaults", () => {
    const limits = resolveResourceLimits("haiku");
    limits.timeoutMs = 999;
    expect(RESOURCE_TIER_DEFAULTS.haiku.timeoutMs).toBe(120_000);
  });
});
