import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildArtifact,
  harvestDir,
  nearestRank,
  parseVoiceTurnLine,
  resolveLogFiles,
  resolveWindow,
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
    warmPath: false,
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
      warmPath: false,
    });
  });

  // Final round, issue 2: the warm-lease stamp on the same log line.
  it("carries warmPath from the log row (absent/false/true)", () => {
    // Pre-KPR-323 rows have no such field at all — must parse as cold.
    expect(parseVoiceTurnLine(line(), AGENT)?.warmPath).toBe(false);
    expect(parseVoiceTurnLine(line({ warmPath: false }), AGENT)?.warmPath).toBe(false);
    expect(parseVoiceTurnLine(line({ warmPath: true }), AGENT)?.warmPath).toBe(true);
    // Only a literal `true` counts — a truthy non-boolean is not a warm stamp.
    expect(parseVoiceTurnLine(line({ warmPath: "true" }), AGENT)?.warmPath).toBe(false);
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

  // Review round 4, issue 9: this used to default to 0, which then entered
  // the totalMs percentile distribution as a real (bogus) sample.
  it("carries totalMs undefined when the field is missing or non-numeric", () => {
    const raw = JSON.parse(line()) as Record<string, unknown>;
    delete raw.totalMs;
    expect(parseVoiceTurnLine(JSON.stringify(raw), AGENT)?.totalMs).toBeUndefined();
    expect(parseVoiceTurnLine(line({ totalMs: "4200" }), AGENT)?.totalMs).toBeUndefined();
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
    expect(artifact.samples).toEqual({
      resumed: 1,
      nonResumed: 1,
      excludedMissingFirstToken: 0,
      excludedWarmPath: 0,
    });
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
      excludedWarmPath: 0,
    });
    // The excluded rows' totalMs (9999) must not reach any metric.
    expect(artifact.metrics.resumed.totalMs.p95).toBe(3000);
    expect(artifact.metrics.nonResumed.totalMs.p95).toBe(3000);
  });

  // Review round 4, issue 9: a malformed row missing totalMs must not enter
  // the totalMs distribution (a 0 sample would drag p50 to the floor); its
  // firstTokenMs is still a valid sample and stays counted.
  it("drops a missing-totalMs row from the totalMs bucket only", () => {
    const samples = [
      sample({ resumed: true, firstTokenMs: 1000, totalMs: 3000 }),
      sample({ resumed: true, firstTokenMs: 1100, totalMs: 3100 }),
      sample({ resumed: true, firstTokenMs: 1200, totalMs: undefined }),
    ];
    const { artifact } = buildArtifact(samples, OPTS);

    expect(artifact.samples.resumed).toBe(3); // still a usable firstTokenMs row
    expect(artifact.metrics.resumed.firstTokenMs).toEqual({ p50: 1100, p95: 1200 });
    // Two-value distribution [3000, 3100] — NOT [0, 3000, 3100].
    expect(artifact.metrics.resumed.totalMs).toEqual({ p50: 3000, p95: 3100 });
  });

  // Final round, issue 2: the blessed artifact is the PRE-WARM comparand
  // KPR-322 P2 binds to. A re-harvest over a window that overlaps KPR-325's
  // pilot must not blend fast warm turns into the cold baseline.
  it("excludes warmPath rows from ALL metrics and counts them separately", () => {
    const samples = [
      sample({ resumed: true, firstTokenMs: 3000, totalMs: 6000, warmPath: false }),
      sample({ resumed: true, firstTokenMs: 200, totalMs: 400, warmPath: true }),
      sample({ resumed: false, firstTokenMs: 3200, totalMs: 6400, warmPath: false }),
      sample({ resumed: false, firstTokenMs: 250, totalMs: 500, warmPath: true }),
    ];
    const { artifact } = buildArtifact(samples, OPTS);

    expect(artifact.samples).toEqual({
      resumed: 1,
      nonResumed: 1,
      excludedMissingFirstToken: 0,
      excludedWarmPath: 2,
    });
    // The fast warm numbers (200/250/400/500) must not appear anywhere.
    expect(artifact.metrics.resumed.firstTokenMs).toEqual({ p50: 3000, p95: 3000 });
    expect(artifact.metrics.resumed.totalMs).toEqual({ p50: 6000, p95: 6000 });
    expect(artifact.metrics.nonResumed.firstTokenMs).toEqual({ p50: 3200, p95: 3200 });
    expect(artifact.metrics.nonResumed.totalMs).toEqual({ p50: 6400, p95: 6400 });
  });

  it("records the warm-path contamination caveat in notes", () => {
    const clean = buildArtifact([...bulk(50, true), ...bulk(20, false)], OPTS);
    expect(clean.artifact.samples.excludedWarmPath).toBe(0);
    expect(clean.artifact.notes).toBe("");

    const contaminated = buildArtifact(
      [...bulk(50, true), ...bulk(20, false), sample({ warmPath: true })],
      OPTS,
    );
    // No sample shortfall (warm rows never counted toward the minimums), but
    // the caveat still rides in notes.
    expect(contaminated.shortfall).toBeNull();
    expect(contaminated.artifact.notes).toContain("WARM-PATH TURNS EXCLUDED: 1");
  });

  it("counts a warm row missing firstTokenMs as warm, not as missing-firstToken", () => {
    const { artifact } = buildArtifact(
      [sample({ resumed: true }), sample({ warmPath: true, firstTokenMs: undefined })],
      OPTS,
    );
    expect(artifact.samples.excludedWarmPath).toBe(1);
    expect(artifact.samples.excludedMissingFirstToken).toBe(0);
  });

  it("is unchanged for a pre-KPR-323 cold-only sample set (backward compatible)", () => {
    const samples = [...bulk(3, true, 1000), sample({ resumed: false, firstTokenMs: 2000 })];
    const { artifact } = buildArtifact(samples, OPTS);
    expect(artifact.samples.resumed).toBe(3);
    expect(artifact.samples.nonResumed).toBe(1);
    expect(artifact.samples.excludedWarmPath).toBe(0);
    expect(artifact.metrics.resumed.firstTokenMs.p50).toBe(1000);
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
    expect(artifact.samples).toEqual({
      resumed: 0,
      nonResumed: 0,
      excludedMissingFirstToken: 0,
      excludedWarmPath: 0,
    });
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
      "excludedWarmPath",
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

// ---------------------------------------------------------------------------
// resolveWindow — CLI arg validation (review round 1, issue 5)
// ---------------------------------------------------------------------------

describe("resolveWindow", () => {
  const NOW = new Date("2026-08-23T00:00:00.000Z");

  it("defaults to the trailing 30 days ending now", () => {
    const w = resolveWindow({}, NOW);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.to.toISOString()).toBe("2026-08-23T00:00:00.000Z");
    expect(w.from.toISOString()).toBe("2026-07-24T00:00:00.000Z");
  });

  it("honours --days", () => {
    const w = resolveWindow({ days: "7" }, NOW);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.from.toISOString()).toBe("2026-08-16T00:00:00.000Z");
  });

  it("honours explicit --from/--to", () => {
    const w = resolveWindow({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-10T00:00:00.000Z" }, NOW);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  // The regression: NaN made every downstream guard vacuously pass and the
  // run died later on from.toISOString() with a bare RangeError.
  it("rejects a non-numeric --days instead of producing an Invalid Date", () => {
    const w = resolveWindow({ days: "abc" }, NOW);
    expect(w.ok).toBe(false);
    if (w.ok) return;
    expect(w.error).toContain("--days is not a number");
  });

  it("rejects a non-positive --days", () => {
    expect(resolveWindow({ days: "0" }, NOW).ok).toBe(false);
    expect(resolveWindow({ days: "-5" }, NOW).ok).toBe(false);
  });

  // Final round, issue 5: parseInt("30abc") === 30, so trailing garbage used
  // to be silently accepted while a fully non-numeric value errored.
  it("rejects --days with trailing garbage (no parseInt prefix leniency)", () => {
    for (const bad of ["30abc", "30.5", "3e2", " 30", "30 ", "+30", "0x1e"]) {
      const w = resolveWindow({ days: bad }, NOW);
      expect(w.ok, `expected --days ${JSON.stringify(bad)} to be rejected`).toBe(false);
      if (w.ok) continue;
      expect(w.error).toContain("--days is not a number");
    }
    // …and a clean integer still works.
    const good = resolveWindow({ days: "30" }, NOW);
    expect(good.ok).toBe(true);
  });

  it("rejects a malformed --from", () => {
    const w = resolveWindow({ from: "not-a-date" }, NOW);
    expect(w.ok).toBe(false);
    if (w.ok) return;
    expect(w.error).toContain("--from is not a valid ISO 8601 timestamp");
  });

  it("rejects a malformed --to", () => {
    const w = resolveWindow({ to: "2026-13-45" }, NOW);
    expect(w.ok).toBe(false);
    if (w.ok) return;
    expect(w.error).toContain("--to is not a valid ISO 8601 timestamp");
  });

  it("rejects an inverted window", () => {
    const w = resolveWindow({ from: "2026-08-10T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" }, NOW);
    expect(w.ok).toBe(false);
    if (w.ok) return;
    expect(w.error).toContain("--from must not be after --to");
  });

  it("still enforces the spec §3.2 30-day maximum", () => {
    const w = resolveWindow({ from: "2026-06-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" }, NOW);
    expect(w.ok).toBe(false);
    if (w.ok) return;
    expect(w.error).toContain("30 days");
  });

  it("(smoke) the CLI exits 1 with a usage error — not a RangeError stack", () => {
    const script = fileURLToPath(new URL("./voice-latency-baseline.ts", import.meta.url));
    const r = spawnSync(
      "npx",
      ["tsx", script, "--log-dir", "/tmp", "--agent", "nobody", "--out", "/tmp/kpr323-baseline-smoke.json", "--days", "abc"],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--days is not a number");
    expect(r.stderr).not.toContain("RangeError");
  }, 30_000);

  it("(smoke) the CLI exits 1 on --days 30abc rather than silently harvesting 30", () => {
    const script = fileURLToPath(new URL("./voice-latency-baseline.ts", import.meta.url));
    const r = spawnSync(
      "npx",
      ["tsx", script, "--log-dir", "/tmp", "--agent", "nobody", "--out", "/tmp/kpr323-baseline-smoke.json", "--days", "30abc"],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--days is not a number: 30abc");
    expect(r.stdout).toBe("");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// resolveLogFiles — log-dir validation (review round 4, issue 9)
// ---------------------------------------------------------------------------

describe("resolveLogFiles", () => {
  it("lists the regular files in an existing dir", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const r = resolveLogFiles(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.names).toContain("voice-latency-baseline.ts");
  });

  it("reports a clean usage error for a nonexistent dir instead of throwing ENOENT", () => {
    const r = resolveLogFiles("/tmp/kpr323-definitely-not-a-log-dir");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("log-dir not found or unreadable");
    expect(r.error).toContain("/tmp/kpr323-definitely-not-a-log-dir");
  });

  it("(smoke) the CLI exits 1 on a mistyped --log-dir — no uncaught ENOENT stack", () => {
    const script = fileURLToPath(new URL("./voice-latency-baseline.ts", import.meta.url));
    const r = spawnSync(
      "npx",
      [
        "tsx",
        script,
        "--log-dir",
        "/tmp/kpr323-definitely-not-a-log-dir",
        "--agent",
        "nobody",
        "--out",
        "/tmp/kpr323-baseline-smoke.json",
      ],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("log-dir not found or unreadable");
    expect(r.stderr).not.toContain("at Object.readdirSync");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// CLI argument validation (child-PR round 1, issue 2)
// ---------------------------------------------------------------------------

describe("CLI argument validation", () => {
  const script = () => fileURLToPath(new URL("./voice-latency-baseline.ts", import.meta.url));

  // parseArgs runs strict; unguarded it threw ERR_PARSE_ARGS_UNKNOWN_OPTION as
  // a raw stack instead of the clean exit-1 usage line the header comment and
  // every other malformed-input path promise.
  it("(smoke) the CLI exits 1 with a usage error on an unknown flag", () => {
    const r = spawnSync(
      "npx",
      [
        "tsx",
        script(),
        "--log-dir",
        "/tmp",
        "--agent",
        "nobody",
        "--out",
        "/tmp/kpr323-baseline-smoke.json",
        "--bogus",
      ],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid arguments");
    expect(r.stderr).toContain("required: --log-dir <dir> --agent <agentId> --out <file>");
    // The raw throw shape must not leak.
    expect(r.stderr).not.toContain("ERR_PARSE_ARGS_UNKNOWN_OPTION");
    expect(r.stderr).not.toContain("at parseArgs");
    expect(r.stdout).toBe("");
  }, 30_000);

  it("(smoke) the CLI exits 1 with a usage error on a stray positional", () => {
    const r = spawnSync(
      "npx",
      [
        "tsx",
        script(),
        "--log-dir",
        "/tmp",
        "--agent",
        "nobody",
        "--out",
        "/tmp/kpr323-baseline-smoke.json",
        "stray-positional",
      ],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid arguments");
    expect(r.stderr).not.toMatch(/^\s+at /m);
    expect(r.stdout).toBe("");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// harvestDir — per-file read errors (child-PR round 1, issue 3)
// ---------------------------------------------------------------------------

describe("harvestDir per-file error handling", () => {
  const FROM = Date.parse("2026-08-01T00:00:00.000Z");
  const TO = Date.parse("2026-08-08T00:00:00.000Z");
  const dirs: string[] = [];

  function tempLogDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "kpr323-logs-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      // Restore any chmod-000 file so the recursive remove can proceed.
      try {
        chmodSync(join(dir, "locked.log"), 0o600);
      } catch {
        /* not every dir has one */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The reviewer's production scenario: log rotation truncates/replaces a file
  // between `resolveLogFiles`' listing and the read. Pre-fix this aborted the
  // WHOLE harvest with an uncaught error and wrote no artifact at all.
  it("skips a file that vanished after listing, reports it, and harvests the rest", async () => {
    const dir = tempLogDir();
    writeFileSync(join(dir, "a.log"), line({ firstTokenMs: 1000 }) + "\n");
    writeFileSync(join(dir, "c.log"), line({ firstTokenMs: 2000 }) + "\n");
    const errs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errs.push(String(chunk));
      return true;
    });

    // "b.log" was listed by readdir but is gone by read time.
    const samples = await harvestDir(dir, ["a.log", "b.log", "c.log"], AGENT, FROM, TO);

    expect(samples.map((s) => s.firstTokenMs)).toEqual([1000, 2000]);
    expect(errs.join("")).toContain("skipping unreadable log file: b.log");
  });

  it("drops the partial rows of a file that fails mid-read (no torn half-file)", async () => {
    const dir = tempLogDir();
    writeFileSync(join(dir, "a.log"), line({ firstTokenMs: 1000 }) + "\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // The missing file contributes nothing at all — not even rows that would
    // have been read before the failure.
    const samples = await harvestDir(dir, ["missing.log", "a.log"], AGENT, FROM, TO);
    expect(samples).toHaveLength(1);
  });

  it.skipIf(process.getuid?.() === 0)(
    "(smoke) the CLI completes the harvest around a permissions-locked log file",
    () => {
      const dir = tempLogDir();
      writeFileSync(join(dir, "a.log"), line({ sdkSessionResumeAttempted: true }) + "\n");
      writeFileSync(join(dir, "b.log"), line({ sdkSessionResumeAttempted: false }) + "\n");
      // Five rows that must NOT reach the artifact — the file is unreadable.
      writeFileSync(
        join(dir, "locked.log"),
        Array.from({ length: 5 }, () => line({ firstTokenMs: 99 })).join("\n") + "\n",
      );
      chmodSync(join(dir, "locked.log"), 0o000);
      const out = join(dir, "artifact.json");

      const r = spawnSync(
        "npx",
        [
          "tsx",
          fileURLToPath(new URL("./voice-latency-baseline.ts", import.meta.url)),
          "--log-dir",
          dir,
          "--agent",
          AGENT,
          "--out",
          out,
          "--from",
          "2026-08-01T00:00:00.000Z",
          "--to",
          "2026-08-08T00:00:00.000Z",
        ],
        { encoding: "utf-8" },
      );

      // The harvest completed: exit 0, artifact written.
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("skipping unreadable log file: locked.log");
      const artifact = JSON.parse(readFileSync(out, "utf-8")) as {
        samples: { resumed: number; nonResumed: number };
        metrics: { resumed: { firstTokenMs: { p50: number } } };
      };
      // Only the two readable rows — none of locked.log's five.
      expect(artifact.samples.resumed).toBe(1);
      expect(artifact.samples.nonResumed).toBe(1);
      expect(artifact.metrics.resumed.firstTokenMs.p50).toBe(1500);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// main-guard path encoding (child-PR round 1, issue 1)
// ---------------------------------------------------------------------------

describe("CLI main-guard", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /**
   * Stage a runnable copy of the harvester plus one log row under `dir`, run
   * it, and assert it ACTUALLY harvested — the pre-fix bug's whole tell is a
   * clean exit that did nothing (no stdout, no stderr, no artifact), so exit
   * status alone proves nothing here.
   */
  function runHarvestFrom(dir: string): void {
    const script = join(dir, "voice-latency-baseline.ts");
    writeFileSync(
      script,
      readFileSync(fileURLToPath(new URL("./voice-latency-baseline.ts", import.meta.url)), "utf-8"),
    );
    // tsx picks the module format from the nearest package.json; the copy needs
    // its own or the top-level await at the entry point fails to transform.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", version: "0.0.0-test" }));
    const logDir = join(dir, "logs");
    mkdirSync(logDir);
    writeFileSync(join(logDir, "a.log"), line() + "\n");
    const out = join(dir, "artifact.json");

    const r = spawnSync(
      "npx",
      [
        "tsx",
        script,
        "--log-dir",
        logDir,
        "--agent",
        AGENT,
        "--out",
        out,
        "--from",
        "2026-08-01T00:00:00.000Z",
        "--to",
        "2026-08-08T00:00:00.000Z",
        // Keeps the copied script from resolving ../package.json / git.
        "--engine-version",
        "0.0.0-test",
        "--git-sha",
        "deadbeef",
      ],
      { encoding: "utf-8" },
    );

    expect(r.status).toBe(0);
    expect(r.stdout).not.toBe("");
    const artifact = JSON.parse(readFileSync(out, "utf-8")) as { samples: { resumed: number } };
    expect(artifact.samples.resumed).toBe(1);
  }

  // Pre-fix the guard compared `import.meta.url` against a raw
  // `file://${process.argv[1]}`, so a path component needing percent-encoding
  // (a space here) made the guard false and the harvest a SILENT no-op.
  // The dir is realpath'd so this case isolates the ENCODING bug.
  it("(smoke) runs the harvest when invoked from a path containing a space", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kpr323 space-")));
    dirs.push(dir);
    runHarvestFrom(dir);
  }, 30_000);

  // Same silent-no-op shape by a different route: node resolves
  // `import.meta.url` through symlinks while argv[1] stays as typed, so an
  // invocation via a symlinked path (macOS /tmp → /private/tmp, or a symlinked
  // checkout) needs the guard's realpath fallback.
  it("(smoke) runs the harvest when invoked through a symlinked path", () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "kpr323-real-")));
    dirs.push(real);
    const linked = join(realpathSync(tmpdir()), `kpr323-link-${process.pid}`);
    symlinkSync(real, linked, "dir");
    dirs.push(linked);
    runHarvestFrom(linked);
  }, 30_000);
});
