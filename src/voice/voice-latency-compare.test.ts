import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildCompareFixture } from "./testing/compare-fixture.js";
import {
  armKindOf,
  bootstrapMedianDifference,
  classifyStratum,
  compareVoiceLatency,
  distribution,
  mulberry32,
  parseEngineLog,
} from "./voice-latency-compare.js";
import { parseVoiceDiagnosticJsonl, VoiceDiagnosticInputError } from "./voice-diagnostic-reader.js";

const FIX = "docs/epics/kpr-462/fixtures";
const fixture = buildCompareFixture();
if (process.env.KPR465_WRITE_FIXTURES) {
  writeFileSync(`${FIX}/kpr-465-compare.jsonl`, fixture.jsonl);
  writeFileSync(`${FIX}/kpr-465-engine-log.jsonl`, fixture.engineLog);
  writeFileSync(`${FIX}/kpr-465-bench-results.jsonl`, fixture.benchResults);
}
const calls = (labels: Record<string, string>) =>
  Object.entries(labels).map(([callId, arm]) => ({ callId, arm, jsonl: fixture.jsonl }));

describe("KPR-465 comparison reader (R1)", () => {
  it("checked-in fixtures are byte-identical to the builder", () => {
    expect(existsSync(`${FIX}/kpr-465-compare.jsonl`)).toBe(true);
    expect(readFileSync(`${FIX}/kpr-465-compare.jsonl`, "utf8")).toBe(fixture.jsonl);
    expect(readFileSync(`${FIX}/kpr-465-engine-log.jsonl`, "utf8")).toBe(fixture.engineLog);
    expect(readFileSync(`${FIX}/kpr-465-bench-results.jsonl`, "utf8")).toBe(fixture.benchResults);
  });

  it("labels arms and stratifies turns from attempt fields only", () => {
    expect(armKindOf("A0-cold")).toBe("cold");
    expect(armKindOf("A2-warm-medium")).toBe("warm");
    expect(() => armKindOf("A9")).toThrow(/exactly one/);
    expect(() => armKindOf("warm-cold")).toThrow(/exactly one/);
    expect(
      classifyStratum({ continuity: "full_transcript", selectedContinuity: "fresh", warm: true, toolCount: 1 }),
    ).toBe("retried");
    expect(classifyStratum({ continuity: "resume", selectedContinuity: "warm", warm: true, toolCount: 1 })).toBe(
      "tool",
    );
    expect(classifyStratum({ continuity: "fresh", selectedContinuity: "fresh", warm: true, toolCount: 0 })).toBe(
      "first",
    );
    expect(classifyStratum({ continuity: "resume", selectedContinuity: "warm", warm: true, toolCount: 0 })).toBe(
      "steady",
    );
    expect(classifyStratum({ continuity: "resume", selectedContinuity: "resume", warm: false, toolCount: 0 })).toBe(
      "steady",
    );
    expect(classifyStratum({ continuity: "fresh", selectedContinuity: null, warm: false, toolCount: 0 })).toBe(
      "unclassified",
    );
  });

  it("produces per-arm, per-stratum stage tables with exclusions for a cold and a warm arm", () => {
    const report = compareVoiceLatency({
      calls: calls({ "call-cold-a": "A0-cold", "call-warm-a": "A1-warm" }),
      pairs: [{ treatment: "A1-warm", base: "A0-cold" }],
    });
    expect(report.ok).toBe(true);
    const cold = report.arms.find((a) => a.arm === "A0-cold")!;
    const warm = report.arms.find((a) => a.arm === "A1-warm")!;
    // t2, t3, t5, t6: t4 is the tool stratum; t5 (barge-in: engine attempt `cancelled`, selected
    // "resume", no tool) stays in the steady turn count, but none of its stage values are pooled —
    // the estimate is excluded as `interrupted`, every other stage as `cancelled`.
    expect(cold.byStratum.steady.turns).toBe(4);
    expect(cold.byStratum.first.turns).toBe(1);
    expect(cold.byStratum.tool.turns).toBe(1);
    expect(cold.byStratum.steady.stages.estimateMs.missingByReason).toEqual({ interrupted: 1 });
    expect(cold.byStratum.steady.stages.lockQueueMs).toMatchObject({
      samples: [0, 0, 831],
      missingByReason: { cancelled: 1 },
    });
    expect(warm.byStratum.steady.turns).toBe(3); // t2, t3, t6
    expect(warm.byStratum.first.turns).toBe(1);
    expect(warm.byStratum.retried.turns).toBe(1);
    expect(warm.byStratum.tool.turns).toBe(1);
    expect(warm.byStratum.first.stages.bootToInitMs.samples).toEqual([655]);
    expect(warm.byStratum.steady.stages.bootToInitMs).toMatchObject({ n: 0, missingByReason: { not_applicable: 3 } });
    expect(warm.byStratum.steady.stages.lockQueueMs.samples).toEqual([42, 43, 46]);
    expect(warm.turns.every((t) => t.effort === "medium")).toBe(true);
    expect(cold.turns.every((t) => t.effort === null)).toBe(true);
    expect(warm.turns.find((t) => t.turnId === "call-warm-a-t5")).toMatchObject({
      stratum: "retried",
      attempts: 2,
      selectedContinuity: "fresh",
    });
    // Cold steady n is 3, not 4: the cancelled t5 contributes no engine sample.
    expect(report.pairs[0]!.intervals.initToFirstTokenMs).toMatchObject({ n1: 3, n2: 3, ci95: expect.any(Array) });
    expect(report.pairs[0]!.intervals.estimateMs).toMatchObject({ n1: 3, n2: 3 });
    expect(report.pairs[0]!.intervals.engineFirstTextMs).toMatchObject({ n1: 3, n2: 3, ci95: expect.any(Array) });
  });

  it("interrupted turns stay in the stratum but are excluded from the estimate and every stage by reason", () => {
    const report = compareVoiceLatency({ calls: calls({ "call-cold-a": "A0-cold" }) });
    const cold = report.arms[0]!;
    const t5 = cold.turns.find((t) => t.turnId === "call-cold-a-t5")!;
    expect(t5).toMatchObject({ stratum: "steady", outcome: "cancelled", estimateExclusion: "interrupted" });
    // The raw row keeps outcome-blind initToFirstTokenMs/lockWaitMs (chunk A); pooling must not.
    expect(Object.values(t5.stages).every((v) => v === null)).toBe(true);
    expect(t5.stageReasons).toEqual({
      eouMs: "cancelled",
      lockQueueMs: "cancelled",
      bootToInitMs: "cancelled",
      initToFirstTokenMs: "cancelled",
      engineFirstTextMs: "cancelled",
      bridgeFirstTextMs: "cancelled",
      ttsTtfbMs: "cancelled",
      estimateMs: "interrupted",
    });
    const steady = cold.byStratum.steady;
    expect(steady.stages.initToFirstTokenMs).toMatchObject({
      samples: [1300, 1350, 1500],
      missingByReason: { cancelled: 1 },
    });
    expect(steady.stages.engineFirstTextMs).toMatchObject({
      samples: [2000, 2050, 2200],
      missingByReason: { cancelled: 1 },
    });
    for (const dist of Object.values(steady.stages)) {
      expect(dist.n + Object.values(dist.missingByReason).reduce((a, b) => a + b, 0)).toBe(steady.turns);
    }
  });

  it("R1 (12): an incomplete call report sets ok false with a named failure", () => {
    const truncated = fixture.jsonl
      .split("\n")
      .filter((l) => !(l.includes('"speechId":"call-cold-a-s2"') && l.includes('"event":"speech_terminal"')))
      .join("\n");
    expect(truncated).not.toBe(fixture.jsonl);
    const report = compareVoiceLatency({
      calls: [
        { callId: "call-cold-a", arm: "A0-cold", jsonl: truncated },
        { callId: "call-warm-a", arm: "A1-warm", jsonl: truncated },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(["call call-cold-a (A0-cold) is incomplete"]);
    expect(report.arms.find((a) => a.arm === "A0-cold")!.calls[0]).toMatchObject({ complete: false, incomplete: 1 });
    expect(report.arms.find((a) => a.arm === "A1-warm")!.calls[0]!.complete).toBe(true);
  });

  it("a call id with no rows in the input (a mistyped --call) sets ok false and is not reported complete", () => {
    const report = compareVoiceLatency({
      calls: calls({ "call-cold-a": "A0-cold", "call-cold-typo": "A0-cold" }),
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(["call call-cold-typo (A0-cold) has no engine attempts — check the --call id"]);
    const arm = report.arms[0]!;
    expect(arm.calls.find((c) => c.callId === "call-cold-typo")).toMatchObject({ complete: false, engineAttempts: 0 });
    expect(arm.calls.find((c) => c.callId === "call-cold-a")).toMatchObject({ complete: true });
    expect(arm.calls.find((c) => c.callId === "call-cold-a")!.engineAttempts).toBeGreaterThan(0);
    // The real call's data is untouched by the empty one.
    expect(arm.byStratum.steady.turns).toBe(4);
  });

  it("a call id listed twice is rejected up front instead of pooling its turns twice", () => {
    expect(() =>
      compareVoiceLatency({
        calls: [
          { callId: "call-warm-a", arm: "A1-warm", jsonl: fixture.jsonl },
          { callId: "call-cold-a", arm: "A0-cold", jsonl: fixture.jsonl },
          { callId: "call-warm-a", arm: "A1-warm", jsonl: fixture.jsonl },
        ],
      }),
    ).toThrow(VoiceDiagnosticInputError);
    // Also across arms: one call cannot be evidence for two arms.
    expect(() =>
      compareVoiceLatency({
        calls: [
          { callId: "call-warm-a", arm: "A1-warm", jsonl: fixture.jsonl },
          { callId: "call-warm-a", arm: "A2-warm-medium", jsonl: fixture.jsonl },
        ],
      }),
    ).toThrow(/call id "call-warm-a" is listed more than once/);
  });

  it("fails the run on a warm-labelled arm with a cold steady turn and on a cold-labelled arm with a warm steady turn", () => {
    const r1 = compareVoiceLatency({ calls: calls({ "call-warm-mislabel": "A1-warm" }) });
    expect(r1.ok).toBe(false);
    expect(r1.arms[0]!.consistency).toMatchObject({
      ok: false,
      failure: "warm_arm_has_cold_steady_turn",
      steadyCold: 1,
    });
    const r2 = compareVoiceLatency({ calls: calls({ "call-cold-mislabel": "A0-cold" }) });
    expect(r2.ok).toBe(false);
    expect(r2.arms[0]!.consistency.failure).toBe("cold_arm_has_warm_steady_turn");
  });

  it("engine-only arm: engine stages only, bench-composed estimate from the live pool, null without a pool", () => {
    const withPool = compareVoiceLatency({
      calls: calls({ "call-cold-a": "A0-cold", "call-warm-a": "A1-warm", "call-bench-1": "A1-warm-bench" }),
    });
    const bench = withPool.arms.find((a) => a.arm === "A1-warm-bench")!;
    expect(bench.engineOnly).toBe(true);
    expect(bench.byStratum.steady.stages.eouMs).toMatchObject({ n: 0, missingByReason: { no_bound_speech: 2 } });
    expect(bench.byStratum.steady.stages.initToFirstTokenMs.n).toBe(2);
    expect(bench.benchComposedEstimateMs).toMatchObject({
      description: expect.stringContaining("NOT the v2 in-call estimate"),
      pool: { fromArms: ["A0-cold", "A1-warm"] },
    });
    const noPool = compareVoiceLatency({ calls: calls({ "call-bench-1": "A1-warm-bench" }) });
    expect(noPool.arms[0]!.benchComposedEstimateMs).toEqual({ reason: "no_live_pool" });
    const live = compareVoiceLatency({ calls: calls({ "call-cold-a": "A0-cold" }) });
    expect(live.arms[0]!.benchComposedEstimateMs).toEqual({ reason: "not_engine_only" });
  });

  it("bench-only pair: engineFirstTextMs carries a real interval with no speech binding; cancelled bench turns excluded", () => {
    const report = compareVoiceLatency({
      calls: calls({ "call-bench-1": "A1-warm-bench", "call-bench-2": "A0-cold-bench" }),
      pairs: [{ treatment: "A1-warm-bench", base: "A0-cold-bench" }],
    });
    expect(report.ok).toBe(true);
    const coldBench = report.arms.find((a) => a.arm === "A0-cold-bench")!;
    expect(coldBench.engineOnly).toBe(true);
    // t2, t3, t4, t5 steady; t4 is the cancelled barge-in — in the turn count, out of every sample.
    expect(coldBench.byStratum.steady.turns).toBe(4);
    expect(coldBench.byStratum.steady.stages.engineFirstTextMs).toMatchObject({
      samples: [2000, 2050, 2150],
      missingByReason: { cancelled: 1 },
    });
    expect(coldBench.byStratum.steady.stages.initToFirstTokenMs.missingByReason).toEqual({ cancelled: 1 });
    const intervals = report.pairs[0]!.intervals;
    expect(intervals.estimateMs).toEqual({ n1: 0, n2: 0, reason: "insufficient_samples" });
    // warm bench steady [1330, 1370] → median 1330; cold bench [2000, 2050, 2150] → median 2050.
    expect(intervals.engineFirstTextMs).toMatchObject({ n1: 2, n2: 3, medianDiffMs: -720, excludesZero: true });
    const ef = intervals.engineFirstTextMs as { ci95: [number, number] };
    expect(ef.ci95[1]).toBeLessThan(0);
  });

  it("engine-log cross-check counts exactly the one disagreeing row, skips non-completed turns, checks warmTurnSeq monotonicity", () => {
    const callIds = new Set(["call-cold-a", "call-warm-a"]);
    const parsed = parseEngineLog(fixture.engineLog, callIds);
    expect(parsed.rows).toHaveLength(8);
    // The t5 log row carries outcome-blind real values the JSONL (correctly) excludes.
    expect(parsed.rows.find((r) => r.turnId === "call-cold-a-t5")).toMatchObject({
      bootToInitMs: 645,
      initToFirstTokenMs: 1450,
    });
    const report = compareVoiceLatency({
      calls: calls({ "call-cold-a": "A0-cold", "call-warm-a": "A1-warm" }),
      engineLog: parsed.rows,
    });
    expect(report.crossCheck).toMatchObject({
      rows: 8,
      matched: 6,
      mismatched: 1,
      missingInJsonl: 0,
      skippedNonCompleted: 1,
      warmTurnSeqMonotonic: { "call-warm-a": true },
    });
    const cc = report.crossCheck!;
    expect(cc.matched + cc.mismatched + cc.missingInJsonl + cc.skippedNonCompleted).toBe(cc.rows);
    expect(cc.mismatches).toHaveLength(1);
    expect(report.crossCheck!.mismatches[0]).toMatchObject({
      turnId: "call-warm-a-t2",
      field: "initToFirstTokenMs",
      log: 1231,
      jsonl: 1230,
    });
  });

  it("KPR-464-era rows (no new keys) parse; stages report missingByReason.absent", () => {
    const report = compareVoiceLatency({ calls: calls({ "call-old": "A0-cold" }) });
    expect(report.ok).toBe(true);
    expect(report.arms[0]!.byStratum.steady.stages.bootToInitMs.missingByReason).toEqual({ absent: 1 });
    expect(report.arms[0]!.turns[0]!.effort).toBeNull();
  });

  it("unknown keys are still rejected and surface as malformed rows", () => {
    const bad = fixture.jsonl.replace(
      '"event":"engine_received","correlation":"worker"',
      '"event":"engine_received","correlation":"worker","transcript":"secret"',
    );
    const parsed = parseVoiceDiagnosticJsonl(bad, "call-cold-a");
    expect(parsed.malformedRows).toBeGreaterThanOrEqual(1);
    const report = compareVoiceLatency({ calls: [{ callId: "call-cold-a", arm: "A0-cold", jsonl: bad }] });
    expect(report.arms[0]!.calls[0]!.malformedRows).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("percentiles are nearest-rank; bootstrap is seeded and reproducible", () => {
    expect(distribution([4, 1, 3, 2], [null, null, null, null])).toMatchObject({
      n: 4,
      min: 1,
      p50: 2,
      p95: 4,
      max: 4,
    });
    const a = bootstrapMedianDifference([10, 12, 14, 16], [20, 22, 24, 26], mulberry32(7), 500);
    const b = bootstrapMedianDifference([10, 12, 14, 16], [20, 22, 24, 26], mulberry32(7), 500);
    expect(a).toEqual(b);
    expect(a.medianDiffMs).toBe(-10);
    expect(a.excludesZero).toBe(true);
    // Four-point inputs have so few distinct resampled medians that the 2.5/97.5 order statistics are
    // seed-invariant; seed sensitivity is shown on wider inputs.
    const wideT = [10, 11, 13, 16, 20, 25, 31];
    const wideB = [18, 21, 22, 27, 29, 34, 40];
    const c7 = bootstrapMedianDifference(wideT, wideB, mulberry32(7), 500);
    const c8 = bootstrapMedianDifference(wideT, wideB, mulberry32(8), 500);
    expect(c7.ci95).not.toEqual(c8.ci95);
    const r1 = compareVoiceLatency({
      calls: calls({ "call-cold-a": "A0-cold", "call-warm-a": "A1-warm" }),
      pairs: [{ treatment: "A1-warm", base: "A0-cold" }],
      seed: 5,
    });
    const r2 = compareVoiceLatency({
      calls: calls({ "call-cold-a": "A0-cold", "call-warm-a": "A1-warm" }),
      pairs: [{ treatment: "A1-warm", base: "A0-cold" }],
      seed: 5,
    });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.seed).toBe(5);
  });

  it("bench assertions join toolCount by turnId and never carry text", () => {
    const rows = fixture.benchResults
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const report = compareVoiceLatency({ calls: calls({ "call-bench-1": "A1-warm-bench" }), benchResults: rows });
    expect(report.benchAssertions).toEqual({
      rows: 4,
      keyword: { pass: 3, fail: 0, notApplicable: 1 },
      tool: { pass: 1, fail: 0, unobserved: 0 },
    });
  });

  it("R7: the report never contains a transcript/phone/token sentinel from inputs", () => {
    const report = compareVoiceLatency({ calls: calls({ "call-cold-a": "A0-cold" }) });
    const text = JSON.stringify(report);
    for (const s of ["Bearer ", "+1555", "hive_agent_id", "systemPrompt"]) expect(text).not.toContain(s);
  });
});
