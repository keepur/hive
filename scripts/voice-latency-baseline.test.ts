import { describe, it, expect } from "vitest";
import {
  buildArtifact,
  nearestRank,
  parseVoiceTurnLine,
  type VoiceTurnSample,
} from "./voice-latency-baseline.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const AGENT = "mokie";

/** Build a well-formed "Voice turn complete" log line, with overrides. */
function line(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: "2026-08-01T12:00:00.000Z",
    level: "info",
    component: "voice-adapter",
    msg: "Voice turn complete",
    callId: "call_abc123",
    agentId: AGENT,
    firstTokenMs: 1500,
    totalMs: 4200,
    mode: "streaming",
    sdkSessionResumeAttempted: true,
    sdkSessionResumed: true,
    routedVia: "agentManager",
    ...overrides,
  });
}

function sample(over: Partial<VoiceTurnSample> = {}): VoiceTurnSample {
  return {
    tsMs: Date.parse("2026-08-01T12:00:00.000Z"),
    firstTokenMs: 1000,
    totalMs: 3000,
    resumed: true,
    ...over,
  };
}

const OPTS = {
  capturedAt: "2026-08-23T00:00:00.000Z",
  engineVersion: "0.12.0",
  gitSha: "abc1234",
  agentId: AGENT,
  from: "2026-07-24T00:00:00.000Z",
  to: "2026-08-23T00:00:00.000Z",
};

/** n usable samples in a bucket, so shortfall can be steered per-test. */
function bulk(n: number, resumed: boolean, firstTokenMs = 1000): VoiceTurnSample[] {
  return Array.from({ length: n }, () => sample({ resumed, firstTokenMs }));
}

// ---------------------------------------------------------------------------
// nearestRank — spec §3.1
// ---------------------------------------------------------------------------

describe("nearestRank", () => {
  it("computes p50/p95 on [1..10]", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(nearestRank(xs, 50)).toBe(5);
    expect(nearestRank(xs, 95)).toBe(10);
  });

  it("returns the single value for n=1", () => {
    expect(nearestRank([7], 50)).toBe(7);
    expect(nearestRank([7], 95)).toBe(7);
  });

  it("handles n=2", () => {
    expect(nearestRank([10, 20], 50)).toBe(10);
    expect(nearestRank([10, 20], 95)).toBe(20);
  });

  it("returns 0 for an empty set", () => {
    expect(nearestRank([], 50)).toBe(0);
    expect(nearestRank([], 95)).toBe(0);
  });

  it("hits exact rank boundaries without rounding drift", () => {
    // n=20: p95 → ceil(0.95*20)=19 exactly → the 19th value.
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(nearestRank(xs, 95)).toBe(19);
    // n=4: p50 → ceil(0.5*4)=2 exactly → the 2nd value.
    expect(nearestRank([1, 2, 3, 4], 50)).toBe(2);
  });

  it("clamps the rank to at least 1", () => {
    expect(nearestRank([5, 6, 7], 0)).toBe(5);
    expect(nearestRank([5, 6, 7], 1)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// parseVoiceTurnLine — accept/reject matrix
// ---------------------------------------------------------------------------

describe("parseVoiceTurnLine", () => {
  it("accepts a well-formed streaming row for the target agent", () => {
    const s = parseVoiceTurnLine(line(), AGENT);
    expect(s).not.toBeNull();
    expect(s).toEqual({
      tsMs: Date.parse("2026-08-01T12:00:00.000Z"),
      firstTokenMs: 1500,
      totalMs: 4200,
      resumed: true,
    });
  });

  it("marks resumed=false when sdkSessionResumeAttempted is false", () => {
    const s = parseVoiceTurnLine(line({ sdkSessionResumeAttempted: false }), AGENT);
    expect(s?.resumed).toBe(false);
  });

  it("marks resumed=false when sdkSessionResumeAttempted is absent", () => {
    const raw = JSON.parse(line()) as Record<string, unknown>;
    delete raw.sdkSessionResumeAttempted;
    const s = parseVoiceTurnLine(JSON.stringify(raw), AGENT);
    expect(s?.resumed).toBe(false);
  });

  it("carries firstTokenMs undefined when the field is missing", () => {
    const raw = JSON.parse(line()) as Record<string, unknown>;
    delete raw.firstTokenMs;
    const s = parseVoiceTurnLine(JSON.stringify(raw), AGENT);
    expect(s).not.toBeNull();
    expect(s?.firstTokenMs).toBeUndefined();
  });

  it("defaults totalMs to 0 when the field is missing or non-numeric", () => {
    const raw = JSON.parse(line()) as Record<string, unknown>;
    delete raw.totalMs;
    expect(parseVoiceTurnLine(JSON.stringify(raw), AGENT)?.totalMs).toBe(0);
    expect(parseVoiceTurnLine(line({ totalMs: "4200" }), AGENT)?.totalMs).toBe(0);
  });

  it("rejects a different msg", () => {
    expect(parseVoiceTurnLine(line({ msg: "Voice turn started" }), AGENT)).toBeNull();
    // Same JSON but the pre-filter string is present elsewhere: still rejected.
    expect(
      parseVoiceTurnLine(line({ msg: "prefix Voice turn complete suffix" }), AGENT),
    ).toBeNull();
  });

  it("rejects a different component", () => {
    expect(parseVoiceTurnLine(line({ component: "voice-worker" }), AGENT)).toBeNull();
  });

  it("rejects a different agent", () => {
    expect(parseVoiceTurnLine(line({ agentId: "jessica" }), AGENT)).toBeNull();
    expect(parseVoiceTurnLine(line({ agentId: undefined }), AGENT)).toBeNull();
  });

  it("rejects non-streaming mode", () => {
    expect(parseVoiceTurnLine(line({ mode: "non-streaming" }), AGENT)).toBeNull();
    expect(parseVoiceTurnLine(line({ mode: undefined }), AGENT)).toBeNull();
  });

  it("rejects non-JSON lines (multi-writer logs)", () => {
    expect(parseVoiceTurnLine("Voice turn complete — plain text, not JSON", AGENT)).toBeNull();
    expect(parseVoiceTurnLine("{ broken json Voice turn complete", AGENT)).toBeNull();
    expect(parseVoiceTurnLine("", AGENT)).toBeNull();
  });

  it("rejects lines with an unparseable or missing ts", () => {
    expect(parseVoiceTurnLine(line({ ts: "not-a-date" }), AGENT)).toBeNull();
    const raw = JSON.parse(line()) as Record<string, unknown>;
    delete raw.ts;
    expect(parseVoiceTurnLine(JSON.stringify(raw), AGENT)).toBeNull();
  });

  it("skips unrelated lines cheaply without parsing", () => {
    expect(parseVoiceTurnLine(JSON.stringify({ msg: "Spawn complete" }), AGENT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// window filtering — the harvest boundary predicate (harvestDir applies
// `tsMs >= fromMs && tsMs <= toMs` to parser output before buildArtifact)
// ---------------------------------------------------------------------------

describe("window filtering (harvest boundary)", () => {
  const fromMs = Date.parse("2026-08-01T00:00:00.000Z");
  const toMs = Date.parse("2026-08-08T00:00:00.000Z");
  const inWindow = (s: VoiceTurnSample) => s.tsMs >= fromMs && s.tsMs <= toMs;

  it("includes both boundaries and excludes outside", () => {
    const all = [
      sample({ tsMs: fromMs - 1 }),
      sample({ tsMs: fromMs }),
      sample({ tsMs: (fromMs + toMs) / 2 }),
      sample({ tsMs: toMs }),
      sample({ tsMs: toMs + 1 }),
    ];
    const kept = all.filter(inWindow);
    expect(kept).toHaveLength(3);

    const { artifact } = buildArtifact(kept, OPTS);
    expect(artifact.samples.resumed).toBe(3);
  });

  it("buildArtifact counts exactly what the window predicate passed in", () => {
    const kept = [sample({ tsMs: fromMs }), sample({ tsMs: toMs, resumed: false })].filter(inWindow);
    const { artifact } = buildArtifact(kept, OPTS);
    expect(artifact.samples).toEqual({ resumed: 1, nonResumed: 1, excludedMissingFirstToken: 0 });
  });
});

// ---------------------------------------------------------------------------
// buildArtifact — exclusion, split, metrics
// ---------------------------------------------------------------------------

describe("buildArtifact", () => {
  it("excludes missing-firstTokenMs rows from BOTH buckets and counts them", () => {
    const samples = [
      sample({ resumed: true, firstTokenMs: 1000 }),
      sample({ resumed: true, firstTokenMs: undefined, totalMs: 9999 }),
      sample({ resumed: false, firstTokenMs: 2000 }),
      sample({ resumed: false, firstTokenMs: undefined, totalMs: 9999 }),
    ];
    const { artifact } = buildArtifact(samples, OPTS);

    expect(artifact.samples).toEqual({
      resumed: 1,
      nonResumed: 1,
      excludedMissingFirstToken: 2,
    });
    // The excluded rows' totalMs (9999) must not reach any metric.
    expect(artifact.metrics.resumed.totalMs.p95).toBe(3000);
    expect(artifact.metrics.nonResumed.totalMs.p95).toBe(3000);
  });

  it("splits resumed vs nonResumed on the resumed flag", () => {
    const samples = [
      ...bulk(3, true, 1000),
      sample({ resumed: false, firstTokenMs: 2500, totalMs: 5000 }),
    ];
    const { artifact } = buildArtifact(samples, OPTS);
    expect(artifact.samples.resumed).toBe(3);
    expect(artifact.samples.nonResumed).toBe(1);
    expect(artifact.metrics.resumed.firstTokenMs.p50).toBe(1000);
    expect(artifact.metrics.nonResumed.firstTokenMs.p50).toBe(2500);
    expect(artifact.metrics.nonResumed.totalMs.p95).toBe(5000);
  });

  it("computes per-bucket percentiles independently", () => {
    const resumed = [100, 200, 300, 400, 500].map((ms) =>
      sample({ resumed: true, firstTokenMs: ms, totalMs: ms * 2 }),
    );
    const nonResumed = [1000, 2000].map((ms) =>
      sample({ resumed: false, firstTokenMs: ms, totalMs: ms * 3 }),
    );
    const { artifact } = buildArtifact([...resumed, ...nonResumed], OPTS);

    expect(artifact.metrics.resumed.firstTokenMs).toEqual({ p50: 300, p95: 500 });
    expect(artifact.metrics.resumed.totalMs).toEqual({ p50: 600, p95: 1000 });
    expect(artifact.metrics.nonResumed.firstTokenMs).toEqual({ p50: 1000, p95: 2000 });
    expect(artifact.metrics.nonResumed.totalMs).toEqual({ p50: 3000, p95: 6000 });
  });

  it("yields zeroed metrics for an empty sample set", () => {
    const { artifact } = buildArtifact([], OPTS);
    expect(artifact.samples).toEqual({ resumed: 0, nonResumed: 0, excludedMissingFirstToken: 0 });
    expect(artifact.metrics.resumed).toEqual({
      firstTokenMs: { p50: 0, p95: 0 },
      totalMs: { p50: 0, p95: 0 },
    });
    expect(artifact.metrics.nonResumed).toEqual({
      firstTokenMs: { p50: 0, p95: 0 },
      totalMs: { p50: 0, p95: 0 },
    });
  });

  it("carries the passed-through window/version/agent fields", () => {
    const { artifact } = buildArtifact([], OPTS);
    expect(artifact.capturedAt).toBe(OPTS.capturedAt);
    expect(artifact.engineVersion).toBe(OPTS.engineVersion);
    expect(artifact.gitSha).toBe(OPTS.gitSha);
    expect(artifact.agentId).toBe(AGENT);
    expect(artifact.window).toEqual({ from: OPTS.from, to: OPTS.to });
    expect(artifact.source).toBe("vapi-production-logs");
    expect(artifact.mode).toBe("streaming");
  });
});

// ---------------------------------------------------------------------------
// sample-shortfall recording (spec §3.2 minimums: 50 resumed / 20 nonResumed)
// ---------------------------------------------------------------------------

describe("sample shortfall", () => {
  it("records both shortfalls in notes for small-n", () => {
    const { artifact, shortfall } = buildArtifact([...bulk(3, true), ...bulk(1, false)], OPTS);
    expect(shortfall).toMatch(/SAMPLE SHORTFALL/);
    expect(shortfall).toContain("resumed=3<50");
    expect(shortfall).toContain("nonResumed=1<20");
    expect(artifact.notes).toBe(shortfall);
  });

  it("records only the resumed shortfall when nonResumed meets the minimum", () => {
    const { artifact, shortfall } = buildArtifact([...bulk(10, true), ...bulk(20, false)], OPTS);
    expect(shortfall).toContain("resumed=10<50");
    expect(shortfall).not.toContain("nonResumed");
    expect(artifact.notes).toBe(shortfall);
  });

  it("records only the nonResumed shortfall when resumed meets the minimum", () => {
    const { artifact, shortfall } = buildArtifact([...bulk(50, true), ...bulk(19, false)], OPTS);
    expect(shortfall).toContain("nonResumed=19<20");
    expect(shortfall).not.toContain("resumed=");
    expect(artifact.notes).toBe(shortfall);
  });

  it("emits no shortfall and empty notes when both minimums are met", () => {
    const { artifact, shortfall } = buildArtifact([...bulk(50, true), ...bulk(20, false)], OPTS);
    expect(shortfall).toBeNull();
    expect(artifact.notes).toBe("");
  });

  it("counts only usable (non-excluded) rows toward the minimums", () => {
    const samples = [
      ...bulk(50, true),
      ...bulk(20, false),
      sample({ resumed: true, firstTokenMs: undefined }),
    ];
    const { artifact, shortfall } = buildArtifact(samples, OPTS);
    expect(shortfall).toBeNull();
    expect(artifact.samples.excludedMissingFirstToken).toBe(1);

    // Drop one usable resumed row → shortfall reappears even though the
    // excluded row would have made the raw count 50.
    const short = buildArtifact([...bulk(49, true), ...bulk(20, false), sample({ firstTokenMs: undefined })], OPTS);
    expect(short.shortfall).toContain("resumed=49<50");
  });
});

// ---------------------------------------------------------------------------
// artifact schema (spec §3.3) + aggregate-only guarantee
// ---------------------------------------------------------------------------

describe("artifact schema", () => {
  const { artifact } = buildArtifact([...bulk(50, true), ...bulk(20, false)], OPTS);

  it("matches the §3.3 top-level key set exactly", () => {
    expect(Object.keys(artifact)).toEqual([
      "kind",
      "version",
      "capturedAt",
      "engineVersion",
      "gitSha",
      "source",
      "window",
      "agentId",
      "mode",
      "samples",
      "metrics",
      "blessing",
      "notes",
    ]);
  });

  it("pins kind and version", () => {
    expect(artifact.kind).toBe("voice_latency_baseline");
    expect(artifact.version).toBe(1);
  });

  it("matches the §3.3 nested key sets exactly", () => {
    expect(Object.keys(artifact.window)).toEqual(["from", "to"]);
    expect(Object.keys(artifact.samples)).toEqual([
      "resumed",
      "nonResumed",
      "excludedMissingFirstToken",
    ]);
    expect(Object.keys(artifact.metrics)).toEqual(["resumed", "nonResumed"]);
    expect(Object.keys(artifact.metrics.resumed)).toEqual(["firstTokenMs", "totalMs"]);
    expect(Object.keys(artifact.metrics.nonResumed)).toEqual(["firstTokenMs", "totalMs"]);
    expect(Object.keys(artifact.metrics.resumed.firstTokenMs)).toEqual(["p50", "p95"]);
    expect(Object.keys(artifact.metrics.resumed.totalMs)).toEqual(["p50", "p95"]);
    expect(Object.keys(artifact.metrics.nonResumed.firstTokenMs)).toEqual(["p50", "p95"]);
    expect(Object.keys(artifact.metrics.nonResumed.totalMs)).toEqual(["p50", "p95"]);
    expect(Object.keys(artifact.blessing)).toEqual(["blessedBy", "blessedAt", "linearRef"]);
  });

  it("emits blessing EMPTY (operator stamps it post-review, spec §3.4)", () => {
    expect(artifact.blessing).toEqual({ blessedBy: "", blessedAt: "", linearRef: "" });
  });

  it("is aggregate-only: no callId, no text, no per-call rows", () => {
    // Build from parsed real-shaped log lines so any leak from the source row
    // (callId, sdkSessionResumed, routedVia, …) would surface here.
    const parsed = [
      parseVoiceTurnLine(line(), AGENT)!,
      parseVoiceTurnLine(line({ sdkSessionResumeAttempted: false }), AGENT)!,
    ];
    const full = buildArtifact(parsed, OPTS).artifact;
    const json = JSON.stringify(full);

    expect(json).not.toContain("callId");
    expect(json).not.toContain("call_abc123");
    expect(json).not.toContain("text");
    expect(json).not.toContain("routedVia");
    expect(json).not.toContain("sdkSession");
    // No arrays anywhere — per-call rows cannot be present.
    expect(json).not.toContain("[");
  });
});
