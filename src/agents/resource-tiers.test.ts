import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  describeLimitSource, explainResourceLimits, inertTopLevelFields, modelToTier,
  resolveResourceLimits, type ModelTier, type ResourceTierOverrides,
} from "./resource-tiers.js";

beforeEach(() => mockWarn.mockClear());

describe("explainResourceLimits (KPR-433 D2)", () => {
  // The KPR-422 fixture matrix: tier default / top-level ≠ 300_000 / = 300_000 / override / garbage.
  const matrix: Array<[string, ModelTier, ResourceTierOverrides | undefined, number | undefined]> = [
    ["tier default", "haiku", undefined, undefined],
    ["override on another tier", "haiku", { opus: { timeoutMs: 900_000 } }, undefined],
    ["top-level ≠ 300_000 (the fable shape)", "sonnet", undefined, 1_800_000],
    ["sentinel 300_000 on opus", "opus", undefined, 300_000],
    ["sentinel 300_000 on haiku", "haiku", undefined, 300_000],
    ["top-level tightens haiku", "haiku", undefined, 60_000],
    ["override beats top-level", "sonnet", { sonnet: { timeoutMs: 600_000 } }, 1_800_000],
    ["partial override", "opus", { opus: { timeoutMs: 900_000 } }, undefined],
    ["full override", "sonnet", { sonnet: { timeoutMs: 60_000, maxTurns: 10, budgetUsd: 0.5 } }, undefined],
    ["garbage 0", "sonnet", undefined, 0],
    ["garbage negative", "sonnet", undefined, -5],
    ["garbage NaN", "sonnet", undefined, Number.NaN],
    ["garbage string", "sonnet", undefined, "900000" as unknown as number],
  ];
  it.each(matrix)("equals resolveResourceLimits value-for-value: %s", (_name, tier, ov, t) => {
    const { timeoutMs, maxTurns, budgetUsd, tier: got } = explainResourceLimits(tier, ov, t);
    expect({ timeoutMs, maxTurns, budgetUsd }).toEqual(resolveResourceLimits(tier, ov, t));
    expect(got).toBe(tier);
  });
  it("sources per field: top-level only ever on timeoutMs (KPR-422); override; tier default; sentinel + garbage → tier-default (§7.7/§7.8)", () => {
    expect(explainResourceLimits("sonnet", undefined, 1_800_000).sources).toEqual({ timeoutMs: "top-level", maxTurns: "tier-default", budgetUsd: "tier-default" });
    expect(explainResourceLimits("sonnet", { sonnet: { timeoutMs: 600_000, budgetUsd: 40 } }, 1_800_000).sources).toEqual({ timeoutMs: "resourceTiers", maxTurns: "tier-default", budgetUsd: "resourceTiers" });
    expect(explainResourceLimits("opus", { opus: { maxTurns: 80 } }, 1_800_000).sources).toEqual({ timeoutMs: "top-level", maxTurns: "resourceTiers", budgetUsd: "tier-default" });
    const sentinel = explainResourceLimits("sonnet", undefined, 300_000);
    expect([sentinel.timeoutMs, sentinel.sources.timeoutMs]).toEqual([300_000, "tier-default"]);
    for (const bad of [0, -5, Number.NaN, "900000" as unknown as number]) {
      expect(explainResourceLimits("sonnet", undefined, bad).sources.timeoutMs).toBe("tier-default");
    }
  });
});

describe("describeLimitSource / inertTopLevelFields (KPR-433 D3/D5 helpers)", () => {
  const labels = (top: Parameters<typeof inertTopLevelFields>[0], tier: ModelTier, ov?: ResourceTierOverrides, t?: number) =>
    inertTopLevelFields(top, resolveResourceLimits(tier, ov, t)).map((f) => f.label);
  it("labels sources", () => {
    expect(describeLimitSource("resourceTiers", "opus")).toBe("resourceTiers.opus");
    expect(describeLimitSource("top-level", "opus")).toBe("top-level");
    expect(describeLimitSource("tier-default", "opus")).toBe("tier default");
  });
  it("the fable shape: budgetUsd then maxTurns inert; the delivered top-level timeoutMs is not listed", () => {
    expect(labels({ budgetUsd: 40, maxTurns: 80, timeoutMs: 1_800_000 }, "opus", { sonnet: { timeoutMs: 1_800_000 } }, 1_800_000)).toEqual(["budgetUsd=$40", "maxTurns=80"]);
  });
  it("nothing when equal; the 300_000 sentinel, null and strings are never listed; an override-displaced timeoutMs is", () => {
    expect(labels({ budgetUsd: 50, maxTurns: 200, timeoutMs: 300_000 }, "opus")).toEqual([]);
    expect(labels({ budgetUsd: null, maxTurns: "80", timeoutMs: undefined }, "opus")).toEqual([]);
    expect(labels({ timeoutMs: 1_800_000 }, "sonnet", { sonnet: { timeoutMs: 600_000 } }, 1_800_000)).toEqual(["timeoutMs=1800000"]);
  });
  it("materialized 10 / 200 flag as inert (both off-opus, budgetUsd on opus) — accepted noise, not special-cased", () => {
    expect(labels({ budgetUsd: 10, maxTurns: 200 }, "sonnet")).toEqual(["budgetUsd=$10", "maxTurns=200"]);
    expect(labels({ budgetUsd: 10, maxTurns: 200 }, "opus")).toEqual(["budgetUsd=$10"]);
  });
});

// Task 2 appends `describe("modelToTier (KPR-433 D1)")` here.
void modelToTier;
