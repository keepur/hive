import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeGoogleAccounts,
  warnIfLegacyGoogleAccount,
  resolveCircuitBreakerConfig,
  resolveOutageQueueConfig,
  resolveToolSearchConfig,
  resolveVoiceLivekitConfig,
  resolveVoiceWarmPathConfig,
  resolveVoiceToolAckConfig,
  resolveMeetingWorkersConfig,
  DEFAULT_TOOL_SEARCH_CONFIG,
} from "./config.js";
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from "./agents/provider-circuit-breaker.js";
import { DEFAULT_OUTAGE_QUEUE_CONFIG } from "./outage/outage-queue-store.js";
import { DEFAULT_MEETING_WORKERS_CONFIG } from "./workers/worker-pool-config.js";

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

describe("resolveMeetingWorkersConfig (KPR-390)", () => {
  it("returns all defaults for absent/garbage sections", () => {
    expect(resolveMeetingWorkersConfig(undefined)).toEqual(DEFAULT_MEETING_WORKERS_CONFIG);
    expect(resolveMeetingWorkersConfig(null)).toEqual(DEFAULT_MEETING_WORKERS_CONFIG);
    expect(resolveMeetingWorkersConfig("nope")).toEqual(DEFAULT_MEETING_WORKERS_CONFIG);
    expect(resolveMeetingWorkersConfig([])).toEqual(DEFAULT_MEETING_WORKERS_CONFIG);
  });

  it("returns a copy of defaults, not the shared object", () => {
    const a = resolveMeetingWorkersConfig(undefined);
    expect(a).not.toBe(DEFAULT_MEETING_WORKERS_CONFIG);
  });

  it("applies each key individually on partial sections", () => {
    expect(resolveMeetingWorkersConfig({ workerModel: "  opus  " }).workerModel).toBe("opus");
    expect(resolveMeetingWorkersConfig({ maxConcurrent: 9 }).maxConcurrent).toBe(9);
    expect(resolveMeetingWorkersConfig({ perMeetingMax: 7 }).perMeetingMax).toBe(7);
    expect(resolveMeetingWorkersConfig({ claimTtlMinutes: 45 }).claimTtlMinutes).toBe(45);
    expect(resolveMeetingWorkersConfig({ workerMaxTurns: 40 }).workerMaxTurns).toBe(40);
    // workerTimeoutMs of 60s ⇒ minTtl 2m, so the default 30m TTL still stands.
    expect(resolveMeetingWorkersConfig({ workerTimeoutMs: 60_000 }).workerTimeoutMs).toBe(60_000);
    expect(resolveMeetingWorkersConfig({ enabled: false }).enabled).toBe(false);
  });

  it("leaves untouched keys at their defaults on a partial section", () => {
    const resolved = resolveMeetingWorkersConfig({ maxConcurrent: 2 });
    expect(resolved).toEqual({ ...DEFAULT_MEETING_WORKERS_CONFIG, maxConcurrent: 2 });
  });

  it("rejects garbage-typed and non-positive values per key", () => {
    const resolved = resolveMeetingWorkersConfig({
      workerModel: "   ",
      maxConcurrent: "four",
      perMeetingMax: -3,
      claimTtlMinutes: NaN,
      workerMaxTurns: 0,
      workerTimeoutMs: Infinity,
      enabled: "yes",
    });
    expect(resolved).toEqual(DEFAULT_MEETING_WORKERS_CONFIG);
  });

  it("clamps a claim TTL that does not exceed the worker wall clock", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = resolveMeetingWorkersConfig({ workerTimeoutMs: 600_000, claimTtlMinutes: 5 });
      expect(resolved.claimTtlMinutes).toBe(11);
      expect(resolved.workerTimeoutMs).toBe(600_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("meetingWorkers.claimTtlMinutes");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("treats an empty section as defaults and ignores unknown keys", () => {
    expect(resolveMeetingWorkersConfig({})).toEqual(DEFAULT_MEETING_WORKERS_CONFIG);
    expect(resolveMeetingWorkersConfig({ perMeetingMax: 5, scribeCadenceMinutes: 3 })).toEqual({
      ...DEFAULT_MEETING_WORKERS_CONFIG,
      perMeetingMax: 5,
    });
  });

  it("KPR-409: scribe keys default when absent", () => {
    const c = resolveMeetingWorkersConfig({ workerModel: "opus" });
    expect(c.scribeEnabled).toBe(true);
    expect(c.scribeModel).toBe("haiku");
    expect(c.scribeDebounceMs).toBe(90_000);
    expect(c.scribeMinNewMessages).toBe(6);
    expect(c.scribeMaxConcurrent).toBe(2);
    expect(c.scribeMaxTurns).toBe(4);
    expect(c.scribeTimeoutMs).toBe(120_000);
  });

  it("KPR-409: garbage scribe values fall back to defaults", () => {
    const c = resolveMeetingWorkersConfig({
      scribeEnabled: "yes",
      scribeModel: "   ",
      scribeDebounceMs: -1,
      scribeMinNewMessages: "six",
      scribeMaxConcurrent: 0,
      scribeMaxTurns: null,
      scribeTimeoutMs: NaN,
    });
    expect(c).toMatchObject({
      scribeEnabled: true,
      scribeModel: "haiku",
      scribeDebounceMs: 90_000,
      scribeMinNewMessages: 6,
      scribeMaxConcurrent: 2,
      scribeMaxTurns: 4,
      scribeTimeoutMs: 120_000,
    });
  });

  it("KPR-409: valid scribe values pass through; scribeTimeoutMs never clamps claimTtlMinutes", () => {
    const c = resolveMeetingWorkersConfig({
      scribeEnabled: false,
      scribeModel: "  sonnet  ",
      scribeDebounceMs: 30_000,
      scribeMinNewMessages: 3,
      scribeMaxConcurrent: 5,
      scribeMaxTurns: 2,
      scribeTimeoutMs: 3_600_000, // 60m > claimTtlMinutes default 30m — must NOT clamp
    });
    expect(c.scribeEnabled).toBe(false);
    expect(c.scribeModel).toBe("sonnet");
    expect(c.scribeDebounceMs).toBe(30_000);
    expect(c.scribeMinNewMessages).toBe(3);
    expect(c.scribeMaxConcurrent).toBe(5);
    expect(c.scribeMaxTurns).toBe(2);
    expect(c.claimTtlMinutes).toBe(DEFAULT_MEETING_WORKERS_CONFIG.claimTtlMinutes);
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

describe("resolveVoiceLivekitConfig (KPR-322 E3)", () => {
  it("defaults on absent/garbage input", () => {
    for (const input of [undefined, null, 42, "x", []]) {
      const c = resolveVoiceLivekitConfig(input);
      expect(c.enabled).toBe(false);
      expect(c.url).toBe("");
      expect(c.sipTrunkId).toBe("");
      expect(c.inboundAgents).toEqual({});
      expect(c.agentVoices).toEqual({});
      expect(c.defaultStt).toBe("deepgram/flux-general-en");
      expect(c.defaultTts).toBe("cartesia/sonic-3");
    }
  });
  it("parses a full section and filters junk inboundAgents and agentVoices entries", () => {
    const c = resolveVoiceLivekitConfig({
      enabled: true,
      url: " wss://p.livekit.cloud ",
      sipTrunkId: "ST_1",
      inboundAgents: { "+15551230000": "nora", "+15551231111": 7, "+15551232222": " " },
      agentVoices: { mokie: " 47c38ca4-5f35-497b-b1a3-415245fb35e1 ", nora: 7, sige: " " },
      defaultStt: "deepgram/nova-3",
      defaultTts: "elevenlabs/eleven_flash_v2_5",
      unknownKey: "ignored",
    });
    expect(c.enabled).toBe(true);
    expect(c.url).toBe("wss://p.livekit.cloud");
    expect(c.inboundAgents).toEqual({ "+15551230000": "nora" });
    expect(c.agentVoices).toEqual({ mokie: "47c38ca4-5f35-497b-b1a3-415245fb35e1" });
    expect(c.defaultStt).toBe("deepgram/nova-3");
  });
  it("enabled must be literal true", () => {
    expect(resolveVoiceLivekitConfig({ enabled: "true" }).enabled).toBe(false);
  });
});

describe("resolveVoiceWarmPathConfig (KPR-323 C4)", () => {
  it("defaults to disabled on absent/garbage input", () => {
    for (const input of [undefined, null, 42, "x", [], { enabled: "true" }, { enabled: 1 }]) {
      expect(resolveVoiceWarmPathConfig(input).enabled).toBe(false);
    }
  });
  it("enables on literal true only", () => {
    expect(resolveVoiceWarmPathConfig({ enabled: true }).enabled).toBe(true);
  });
  it("ignores unknown keys", () => {
    expect(resolveVoiceWarmPathConfig({ enabled: true, idleMs: 5 }).enabled).toBe(true);
  });
});

describe("resolveVoiceToolAckConfig (KPR-324 C6)", () => {
  it("defaults to enabled on absent/garbage input (spec §12.1 #7)", () => {
    for (const input of [undefined, null, 42, "x", [], {}, { enabled: "false" }, { enabled: 0 }, { enabled: "no" }]) {
      expect(resolveVoiceToolAckConfig(input).enabled).toBe(true);
    }
  });
  it("disables on { enabled: false }", () => {
    expect(resolveVoiceToolAckConfig({ enabled: false }).enabled).toBe(false);
  });
  it("disables on the bare scalar false (child-PR/1 finding: the operator shorthand)", () => {
    expect(resolveVoiceToolAckConfig(false).enabled).toBe(false);
  });
  it("enables on literal true; ignores unknown keys", () => {
    expect(resolveVoiceToolAckConfig({ enabled: true, phrases: ["x"] }).enabled).toBe(true);
  });
});
