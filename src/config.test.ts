import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeGoogleAccounts,
  warnIfLegacyGoogleAccount,
  resolveCircuitBreakerConfig,
  resolveOutageQueueConfig,
  resolveToolSearchConfig,
  DEFAULT_TOOL_SEARCH_CONFIG,
} from "./config.js";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./agents/provider-circuit-breaker.js";
import { DEFAULT_OUTAGE_QUEUE_CONFIG } from "./outage/outage-queue-store.js";

describe("normalizeGoogleAccounts (KPR-242)", () => {
  it("returns an empty record for undefined or non-object input", () => {
    expect(normalizeGoogleAccounts(undefined)).toEqual({});
    expect(normalizeGoogleAccounts(null)).toEqual({});
    expect(normalizeGoogleAccounts("not an object")).toEqual({});
    expect(normalizeGoogleAccounts(42)).toEqual({});
  });

  it("returns an empty record for array input (typeof [] === 'object' edge case)", () => {
    // YAML maps can't produce arrays at this position, but the input is `unknown` —
    // lock the invariant defensively so a future caller can't smuggle in `[]`
    // or `[["agent", "email"]]` and get stringly-keyed garbage out.
    expect(normalizeGoogleAccounts([])).toEqual({});
    expect(normalizeGoogleAccounts([["agent", "a@x.com"]])).toEqual({});
  });

  it("normalizes a string-valued account entry to a one-element array", () => {
    expect(normalizeGoogleAccounts({ rae: "rae@dodihome.com" })).toEqual({
      rae: ["rae@dodihome.com"],
    });
  });

  it("preserves an array-valued account entry and its order", () => {
    const input = {
      mokie: ["may@dodihome.com", "may.huang@gmail.com", "may@keepur.io"],
    };
    expect(normalizeGoogleAccounts(input)).toEqual({
      mokie: ["may@dodihome.com", "may.huang@gmail.com", "may@keepur.io"],
    });
  });

  it("trims whitespace from string and array entries", () => {
    expect(normalizeGoogleAccounts({ rae: "  rae@dodihome.com  " })).toEqual({
      rae: ["rae@dodihome.com"],
    });
    expect(normalizeGoogleAccounts({ mokie: ["  a@x.com", "b@x.com  "] })).toEqual({
      mokie: ["a@x.com", "b@x.com"],
    });
  });

  it("drops empty strings and non-string array entries", () => {
    expect(normalizeGoogleAccounts({ rae: "" })).toEqual({});
    expect(normalizeGoogleAccounts({ mokie: ["", "  ", "a@x.com"] })).toEqual({
      mokie: ["a@x.com"],
    });
    expect(normalizeGoogleAccounts({ mokie: [null, 42, "a@x.com"] as unknown[] })).toEqual({
      mokie: ["a@x.com"],
    });
  });

  it("drops an agent whose array reduces to empty", () => {
    expect(normalizeGoogleAccounts({ mokie: ["", "  "] })).toEqual({});
  });
});

describe("warnIfLegacyGoogleAccount (KPR-242)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when legacy `google.account` is present", () => {
    warnIfLegacyGoogleAccount({ google: { account: "legacy@example.com" } });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("`google.account` is deprecated");
  });

  it("does not warn when `google.account` is absent", () => {
    warnIfLegacyGoogleAccount({ google: { accounts: { rae: "rae@x.com" } } });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when `google` is absent entirely", () => {
    warnIfLegacyGoogleAccount({});
    warnIfLegacyGoogleAccount(undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when `google` is non-object", () => {
    warnIfLegacyGoogleAccount({ google: "not an object" } as unknown as Record<string, unknown>);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("resolveCircuitBreakerConfig (KPR-306)", () => {
  it("returns all defaults for an absent or garbage section", () => {
    expect(resolveCircuitBreakerConfig(undefined)).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    expect(resolveCircuitBreakerConfig(null)).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    expect(resolveCircuitBreakerConfig("nope")).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    expect(resolveCircuitBreakerConfig([])).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
  });

  it("applies per-key ?? semantics for a partial section", () => {
    const resolved = resolveCircuitBreakerConfig({ enabled: false, openBaseMs: 5_000 });
    expect(resolved.enabled).toBe(false);
    expect(resolved.openBaseMs).toBe(5_000);
    expect(resolved.consecutiveFaultThreshold).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.consecutiveFaultThreshold);
    expect(resolved.p95ThresholdMs).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.p95ThresholdMs);
  });

  it("rejects garbage-typed values back to defaults and clamps p95MinSamples to the window", () => {
    const resolved = resolveCircuitBreakerConfig({
      enabled: "yes",
      consecutiveFaultThreshold: -1,
      openBaseMs: "fast",
      p95WindowSize: 10,
      p95MinSamples: 500,
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.consecutiveFaultThreshold).toBe(3);
    expect(resolved.openBaseMs).toBe(15_000);
    expect(resolved.p95WindowSize).toBe(10);
    expect(resolved.p95MinSamples).toBe(10); // clamped
  });
});

describe("resolveOutageQueueConfig (KPR-307)", () => {
  it("returns all defaults for absent/garbage sections", () => {
    expect(resolveOutageQueueConfig(undefined)).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
    expect(resolveOutageQueueConfig(null)).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
    expect(resolveOutageQueueConfig("nope")).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
    expect(resolveOutageQueueConfig([])).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
  });

  it("applies per-key ?? on partial sections", () => {
    const resolved = resolveOutageQueueConfig({ enabled: false, maxDepth: 100 });
    expect(resolved.enabled).toBe(false);
    expect(resolved.maxDepth).toBe(100);
    expect(resolved.replayIntervalMs).toBe(15_000);
    expect(resolved.maxAgeHours).toBe(4);
    expect(resolved.maxReplayAttempts).toBe(3);
  });

  it("rejects garbage-typed and non-positive values per key", () => {
    const resolved = resolveOutageQueueConfig({
      enabled: "yes",
      replayIntervalMs: "fast",
      maxAgeHours: -4,
      maxDepth: NaN,
      maxReplayAttempts: 0,
    });
    expect(resolved).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
  });
});

describe("resolveToolSearchConfig (KPR-329)", () => {
  it("returns defaults for absent/garbage section", () => {
    expect(resolveToolSearchConfig(undefined)).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig(null)).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig("off")).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig(42)).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig([])).toEqual({ mode: "auto", source: "default" });
  });

  it("returns a copy of defaults, not the shared object", () => {
    const a = resolveToolSearchConfig(undefined);
    expect(a).not.toBe(DEFAULT_TOOL_SEARCH_CONFIG);
  });

  it("accepts each valid mode with source hive.yaml", () => {
    expect(resolveToolSearchConfig({ mode: "auto" })).toEqual({ mode: "auto", source: "hive.yaml" });
    expect(resolveToolSearchConfig({ mode: "on" })).toEqual({ mode: "on", source: "hive.yaml" });
    expect(resolveToolSearchConfig({ mode: "off" })).toEqual({ mode: "off", source: "hive.yaml" });
  });

  it("warns and defaults to auto on an invalid mode value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveToolSearchConfig({ mode: "yes" })).toEqual({ mode: "auto", source: "default" });
      expect(resolveToolSearchConfig({ mode: true })).toEqual({ mode: "auto", source: "default" });
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(String(warnSpy.mock.calls[0][0])).toContain("toolSearch.mode");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("treats an empty section as defaults and ignores unknown keys", () => {
    expect(resolveToolSearchConfig({})).toEqual({ mode: "auto", source: "default" });
    expect(resolveToolSearchConfig({ mode: "on", autoThresholdPercent: 5 })).toEqual({
      mode: "on",
      source: "hive.yaml",
    });
  });
});
