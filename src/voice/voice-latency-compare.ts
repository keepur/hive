/**
 * KPR-465 §3.3: multi-call comparison over schema-v2 voice_diagnostic rows.
 * Pure: no config, no Mongo, no network, no clock. Deterministic for fixed
 * inputs and seed. Strata and stages come ONLY from the attempt terminal's
 * own fields and the explicit speech binding (never proximity).
 */
import { nearestRankPercentile } from "./percentile.js";
import {
  parseVoiceDiagnosticJsonl,
  reduceVoiceDiagnostics,
  VoiceDiagnosticInputError,
  type LatencyExclusionReason,
  type VoiceDiagnosticReport,
} from "./voice-diagnostic-reader.js";
import type { EnginePayload, Measure, TraceEnvelope, VoiceDiagnosticEvent } from "./voice-trace.js";

export type ArmKind = "cold" | "warm";
export type Stratum = "steady" | "first" | "retried" | "tool" | "unclassified";
export const STRATA: readonly Stratum[] = ["steady", "first", "retried", "tool", "unclassified"];
export const STAGES = [
  "eouMs",
  "lockQueueMs",
  "bootToInitMs",
  "initToFirstTokenMs",
  "engineFirstTextMs",
  "bridgeFirstTextMs",
  "ttsTtfbMs",
  "estimateMs",
] as const;
export type Stage = (typeof STAGES)[number];
/**
 * The stages that carry a between-arm claim (§3.1 — every claim has an interval; §3.4):
 * `initToFirstTokenMs` (powered, bench), `estimateMs` (confirmatory, live — always
 * `insufficient_samples` on an engine-only arm, which has no bound speech), and
 * `engineFirstTextMs` (powered, bench). The bench-composed estimate is one global
 * constant (pooled live EOU p50 + pooled live TTS TTFB p50) plus `engineFirstTextMs`,
 * so the `engineFirstTextMs` median-difference interval IS the bench-composed
 * estimate's between-arm interval; it needs no speech binding.
 */
export const CLAIM_STAGES = [
  "initToFirstTokenMs",
  "estimateMs",
  "engineFirstTextMs",
] as const satisfies readonly Stage[];

export interface CompareCall {
  callId: string;
  arm: string;
  /** Raw JSONL text (bounded by the caller) or already-parsed rows for this call. */
  jsonl: string;
}
export interface ComparePair {
  treatment: string;
  base: string;
}
export interface EngineLogRow {
  callId: string;
  turnId: string;
  bootToInitMs?: number;
  initToFirstTokenMs?: number;
  warmPath?: boolean;
  warmTurnSeq?: number;
}
/** One row of scripts/voice-engine-bench.ts's result file (chunk D produces it). Never carries text. */
export interface BenchResultRow {
  callId: string;
  arm: string;
  turnIndex: number;
  turnId: string;
  expectsTool: boolean;
  keywordPass: boolean | null;
  clientFirstTextMs: number | null;
  textLength: number;
  status: number | null;
}

export interface TurnRow {
  callId: string;
  turnId: string;
  attemptSeq: number;
  attempts: number;
  stratum: Stratum;
  warm: boolean;
  selectedContinuity: "fresh" | "resume" | "warm" | null;
  continuity: "fresh" | "resume" | "full_transcript" | null;
  toolCount: number | null;
  effort: string | null;
  outcome: string;
  speechId: string | null;
  stages: Record<Stage, number | null>;
  stageReasons: Record<Stage, string | null>;
  estimateExclusion: LatencyExclusionReason | null;
}

export interface Distribution {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  samples: number[];
  missingByReason: Record<string, number>;
}

export interface StratumReport {
  turns: number;
  stages: Record<Stage, Distribution>;
}

export interface ArmReport {
  arm: string;
  kind: ArmKind;
  engineOnly: boolean;
  calls: Array<{
    callId: string;
    /** The reader's own completeness, and false for a call with no engine attempts (nothing to compare). */
    complete: boolean;
    engineAttempts: number;
    incomplete: number;
    unbound: number;
    gaps: number;
    malformedRows: number;
  }>;
  consistency: {
    steadyTurns: number;
    steadyWarm: number;
    steadyCold: number;
    ok: boolean;
    failure: "warm_arm_has_cold_steady_turn" | "cold_arm_has_warm_steady_turn" | null;
  };
  turns: TurnRow[];
  byStratum: Record<Stratum, StratumReport>;
  benchComposedEstimateMs:
    | (Distribution & {
        description: "bench-composed: pooled live EOU p50 + engine firstTextMs + pooled live TTS TTFB p50; NOT the v2 in-call estimate";
        pool: { eouP50: number; ttsTtfbP50: number; eouN: number; ttsN: number; fromArms: string[] };
      })
    | { reason: "not_engine_only" | "no_live_pool" };
}

export interface PairInterval {
  treatment: string;
  base: string;
  stratum: "steady";
  intervals: Record<
    (typeof CLAIM_STAGES)[number],
    | { n1: number; n2: number; medianDiffMs: number; ci95: [number, number]; excludesZero: boolean }
    | { n1: number; n2: number; reason: "insufficient_samples" | "unknown_arm" }
  >;
}

export interface CrossCheck {
  /** Always `matched + mismatched + missingInJsonl + skippedNonCompleted`. */
  rows: number;
  matched: number;
  mismatched: number;
  missingInJsonl: number;
  /**
   * Log rows whose JSONL turn did not complete (cancelled/failed/...): not comparable,
   * so neither matched nor mismatched. The log row is outcome-blind by design while the
   * JSONL stage is outcome-aware (§3.2 source gate + this module's completed-only
   * pooling), so a field comparison there would always disagree without any data fault.
   */
  skippedNonCompleted: number;
  mismatches: Array<{
    callId: string;
    turnId: string;
    field: "bootToInitMs" | "initToFirstTokenMs";
    log: number | null;
    jsonl: number | null;
  }>;
  warmTurnSeqMonotonic: Record<string, boolean>;
}

export interface BenchAssertionSummary {
  rows: number;
  keyword: { pass: number; fail: number; notApplicable: number };
  tool: { pass: number; fail: number; unobserved: number };
}

export interface CompareReport {
  schemaVersion: 2;
  seed: number;
  resamples: number;
  arms: ArmReport[];
  pairs: PairInterval[];
  crossCheck: CrossCheck | null;
  benchAssertions: BenchAssertionSummary | null;
  ok: boolean;
  failures: string[];
}

export interface CompareInput {
  calls: CompareCall[];
  pairs?: ComparePair[];
  engineLog?: EngineLogRow[];
  benchResults?: BenchResultRow[];
  seed?: number;
  resamples?: number;
}

export const DEFAULT_SEED = 20260911;
export const DEFAULT_RESAMPLES = 2000;

export function armKindOf(label: string): ArmKind {
  const warm = /warm/i.test(label);
  const cold = /cold/i.test(label);
  if (warm === cold) {
    throw new VoiceDiagnosticInputError(`arm label "${label}" must contain exactly one of "warm" or "cold"`);
  }
  return warm ? "warm" : "cold";
}

function value(m: Measure | undefined): number | null {
  return m && m.value !== null && Number.isFinite(m.value) && m.value >= 0 ? m.value : null;
}
function reasonOf(m: Measure | undefined): string | null {
  if (!m) return "absent";
  return m.value === null ? m.reason : null;
}

export function classifyStratum(a: {
  continuity: TurnRow["continuity"];
  selectedContinuity: TurnRow["selectedContinuity"];
  warm: boolean;
  toolCount: number | null;
}): Stratum {
  if (a.continuity === "full_transcript") return "retried";
  if ((a.toolCount ?? 0) >= 1) return "tool";
  if (a.selectedContinuity === null) return "unclassified";
  if (a.warm) return a.selectedContinuity === "warm" ? "steady" : "first";
  return a.selectedContinuity === "resume" ? "steady" : "first";
}

export function buildTurnRows(
  events: VoiceDiagnosticEvent[],
  report: VoiceDiagnosticReport,
  callId: string,
): TurnRow[] {
  // Not Extract<VoiceDiagnosticEvent, { event: "engine_attempt_terminal" }>: EnginePayload's
  // `event` is a six-literal union, so that Extract resolves to `never`.
  type Attempt = TraceEnvelope & EnginePayload;
  const byTurn = new Map<string, Attempt[]>();
  for (const row of events) {
    if (row.event !== "engine_attempt_terminal" || !row.turnId || row.engineAttemptSeq === null) continue;
    const list = byTurn.get(row.turnId) ?? [];
    list.push(row as Attempt);
    byTurn.set(row.turnId, list);
  }
  const speechByTurn = new Map<
    string,
    Array<NonNullable<VoiceDiagnosticReport["details"]["speech"][number]["latency"]> & { speechId: string | null }>
  >();
  for (const s of report.details.speech) {
    if (!s.latency?.boundTurnId) continue;
    const list = speechByTurn.get(s.latency.boundTurnId) ?? [];
    list.push({ ...s.latency, speechId: s.speechId });
    speechByTurn.set(s.latency.boundTurnId, list);
  }
  const rows: TurnRow[] = [];
  for (const [turnId, attempts] of byTurn) {
    attempts.sort((x, y) => (x.engineAttemptSeq ?? 0) - (y.engineAttemptSeq ?? 0));
    const final = attempts[attempts.length - 1]!;
    const retried = attempts.some((a) => a.continuity === "full_transcript");
    const warm = final.warm === true;
    const speeches = speechByTurn.get(turnId) ?? [];
    const speech = speeches.length === 1 ? speeches[0]! : null;
    const ambiguous = speeches.length > 1;
    const stratum = classifyStratum({
      continuity: retried ? "full_transcript" : ((final.continuity as TurnRow["continuity"]) ?? null),
      selectedContinuity: final.selectedContinuity ?? null,
      warm,
      toolCount: final.toolCount ?? null,
    });
    const lockQueue = warm ? final.queueWaitMs : final.lockWaitMs;
    // §3.2/§3.4: only a completed final attempt is a valid sample. A barge-in
    // (`cancelled`), `failed`, `incomplete` or outcome-less attempt stays in its
    // stratum's `turns` count, but every stage value is excluded here with the
    // outcome as its reason — the same "stay in the stratum, exclude the value"
    // pattern as the estimate. The raw rows keep `lockWaitMs`/`spawnPrepMs`/
    // `initToFirstTokenMs` outcome-blind by chunk A's design, so this aggregation
    // is where the exclusion has to happen. `bootToInitMs` needs no gate: the
    // adapter already stamps it `not_observed` on any non-completed outcome
    // (`bootToInitMeasure`, voice-adapter.ts), so `value()` reads null.
    const completed = final.outcome === "completed";
    const outcomeReason = completed ? null : (final.outcome ?? "unknown");
    const stages: Record<Stage, number | null> = {
      eouMs: completed ? (speech?.eouMs ?? null) : null,
      lockQueueMs: completed ? value(lockQueue) : null,
      bootToInitMs: value(final.bootToInitMs),
      initToFirstTokenMs: completed ? value(final.initToFirstTokenMs) : null,
      engineFirstTextMs: completed ? value(final.firstTextMs) : null,
      bridgeFirstTextMs: completed ? (speech?.bridgeFirstTextMs ?? null) : null,
      ttsTtfbMs: completed ? (speech?.ttsTtfbMs ?? null) : null,
      estimateMs: completed && !ambiguous ? (speech?.estimateMs ?? null) : null,
    };
    const workerReason = ambiguous ? "ambiguous_components" : speech ? null : "no_bound_speech";
    // A non-completed outcome is the reason for every excluded stage, ahead of the
    // generic fallbacks. The estimate keeps the speech binding's own exclusion
    // first (KPR-464's taxonomy; §3.4 names the barge-in exclusion `interrupted`),
    // so the outcome reason there only covers a binding that reports none.
    const stageReasons: Record<Stage, string | null> = {
      eouMs: stages.eouMs === null ? (outcomeReason ?? workerReason ?? "missing_eou") : null,
      lockQueueMs: stages.lockQueueMs === null ? (outcomeReason ?? reasonOf(lockQueue)) : null,
      bootToInitMs: stages.bootToInitMs === null ? (outcomeReason ?? reasonOf(final.bootToInitMs)) : null,
      initToFirstTokenMs:
        stages.initToFirstTokenMs === null ? (outcomeReason ?? reasonOf(final.initToFirstTokenMs)) : null,
      engineFirstTextMs: stages.engineFirstTextMs === null ? (outcomeReason ?? reasonOf(final.firstTextMs)) : null,
      bridgeFirstTextMs:
        stages.bridgeFirstTextMs === null ? (outcomeReason ?? workerReason ?? "missing_bridge_first_text") : null,
      ttsTtfbMs: stages.ttsTtfbMs === null ? (outcomeReason ?? workerReason ?? "missing_tts_metric") : null,
      estimateMs: stages.estimateMs === null ? (speech?.exclusion ?? outcomeReason ?? workerReason ?? "missing") : null,
    };
    rows.push({
      callId,
      turnId,
      attemptSeq: final.engineAttemptSeq ?? 0,
      attempts: attempts.length,
      stratum,
      warm,
      selectedContinuity: final.selectedContinuity ?? null,
      continuity: (final.continuity as TurnRow["continuity"]) ?? null,
      toolCount: final.toolCount ?? null,
      effort: final.effort ?? null,
      outcome: final.outcome ?? "unknown",
      speechId: speech?.speechId ?? null,
      stages,
      stageReasons,
      estimateExclusion: ambiguous ? "ambiguous_components" : (speech?.exclusion ?? null),
    });
  }
  rows.sort((a, b) => a.turnId.localeCompare(b.turnId));
  return rows;
}

export function distribution(values: Array<number | null>, reasons: Array<string | null>): Distribution {
  const samples = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const missingByReason: Record<string, number> = {};
  values.forEach((v, i) => {
    if (v !== null) return;
    const r = reasons[i] ?? "missing";
    missingByReason[r] = (missingByReason[r] ?? 0) + 1;
  });
  return {
    n: samples.length,
    min: samples[0] ?? null,
    p50: nearestRankPercentile(samples, 50),
    p95: nearestRankPercentile(samples, 95),
    max: samples.at(-1) ?? null,
    samples,
    missingByReason,
  };
}

/** Deterministic 32-bit PRNG (mulberry32). Seeded once per report. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMedianDifference(
  treatment: readonly number[],
  base: readonly number[],
  rng: () => number,
  resamples: number,
): { medianDiffMs: number; ci95: [number, number]; excludesZero: boolean } {
  const median = (xs: number[]) => nearestRankPercentile(xs, 50)!;
  const draw = (xs: readonly number[]) => Array.from({ length: xs.length }, () => xs[Math.floor(rng() * xs.length)]!);
  const diffs: number[] = [];
  for (let i = 0; i < resamples; i += 1) diffs.push(median(draw(treatment)) - median(draw(base)));
  diffs.sort((a, b) => a - b);
  const lo = diffs[Math.max(0, Math.floor(0.025 * resamples))]!;
  const hi = diffs[Math.min(resamples - 1, Math.ceil(0.975 * resamples) - 1)]!;
  return { medianDiffMs: median([...treatment]) - median([...base]), ci95: [lo, hi], excludesZero: lo > 0 || hi < 0 };
}

export function parseEngineLog(
  text: string,
  callIds: ReadonlySet<string>,
): { rows: EngineLogRow[]; malformed: number } {
  const rows: EngineLogRow[] = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!v || typeof v !== "object" || (v as { msg?: unknown }).msg !== "Voice turn complete") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.callId !== "string" || typeof r.turnId !== "string" || !callIds.has(r.callId)) continue;
    rows.push({
      callId: r.callId,
      turnId: r.turnId,
      ...(typeof r.bootToInitMs === "number" ? { bootToInitMs: r.bootToInitMs } : {}),
      ...(typeof r.initToFirstTokenMs === "number" ? { initToFirstTokenMs: r.initToFirstTokenMs } : {}),
      ...(typeof r.warmPath === "boolean" ? { warmPath: r.warmPath } : {}),
      ...(typeof r.warmTurnSeq === "number" ? { warmTurnSeq: r.warmTurnSeq } : {}),
    });
  }
  return { rows, malformed };
}

export function crossCheck(log: EngineLogRow[], turns: TurnRow[]): CrossCheck {
  const byKey = new Map(turns.map((t) => [`${t.callId} ${t.turnId}`, t]));
  const out: CrossCheck = {
    rows: log.length,
    matched: 0,
    mismatched: 0,
    missingInJsonl: 0,
    skippedNonCompleted: 0,
    mismatches: [],
    warmTurnSeqMonotonic: {},
  };
  const seqByCall = new Map<string, number[]>();
  for (const row of log) {
    if (row.warmPath && row.warmTurnSeq !== undefined) {
      const s = seqByCall.get(row.callId) ?? [];
      s.push(row.warmTurnSeq);
      seqByCall.set(row.callId, s);
    }
    const turn = byKey.get(`${row.callId} ${row.turnId}`);
    if (!turn) {
      out.missingInJsonl += 1;
      continue;
    }
    if (turn.outcome !== "completed") {
      out.skippedNonCompleted += 1;
      continue;
    }
    let rowOk = true;
    for (const field of ["bootToInitMs", "initToFirstTokenMs"] as const) {
      const logValue = row[field] ?? null;
      const jsonlValue = turn.stages[field];
      if (logValue !== jsonlValue) {
        rowOk = false;
        out.mismatches.push({ callId: row.callId, turnId: row.turnId, field, log: logValue, jsonl: jsonlValue });
      }
    }
    if (rowOk) out.matched += 1;
    else out.mismatched += 1;
  }
  for (const [callId, seqs] of seqByCall) {
    out.warmTurnSeqMonotonic[callId] = seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);
  }
  return out;
}

export function compareVoiceLatency(input: CompareInput): CompareReport {
  const seed = input.seed ?? DEFAULT_SEED;
  const resamples = input.resamples ?? DEFAULT_RESAMPLES;
  const failures: string[] = [];
  const armOrder: string[] = [];
  const armCalls = new Map<
    string,
    Array<{ callId: string; events: VoiceDiagnosticEvent[]; report: VoiceDiagnosticReport; malformedRows: number }>
  >();
  // Structurally invalid input, like an unlabelled arm: a repeated call id would pool its turns twice.
  const seenCallIds = new Set<string>();
  for (const call of input.calls) {
    if (seenCallIds.has(call.callId)) {
      throw new VoiceDiagnosticInputError(`call id "${call.callId}" is listed more than once`);
    }
    seenCallIds.add(call.callId);
  }
  for (const call of input.calls) {
    if (!armCalls.has(call.arm)) {
      armKindOf(call.arm); // throws on an unlabelled arm
      armOrder.push(call.arm);
      armCalls.set(call.arm, []);
    }
    const parsed = parseVoiceDiagnosticJsonl(call.jsonl, call.callId);
    const report = reduceVoiceDiagnostics(parsed, call.callId);
    armCalls
      .get(call.arm)!
      .push({ callId: call.callId, events: parsed.events, report, malformedRows: parsed.malformedRows });
    if (!report.complete) failures.push(`call ${call.callId} (${call.arm}) is incomplete`);
    // Rows are filtered by call id, so a mistyped id reads back as an empty, reader-complete call.
    if (report.engineAttempts === 0) {
      failures.push(`call ${call.callId} (${call.arm}) has no engine attempts — check the --call id`);
    }
  }

  const arms: ArmReport[] = [];
  const allTurns: TurnRow[] = [];
  const liveSteady: { eou: number[]; tts: number[]; arms: Set<string> } = { eou: [], tts: [], arms: new Set() };
  for (const arm of armOrder) {
    const kind = armKindOf(arm);
    const calls = armCalls.get(arm)!;
    const turns = calls.flatMap((c) => buildTurnRows(c.events, c.report, c.callId));
    allTurns.push(...turns);
    const engineOnly = calls.every((c) => c.report.speechAttempts === 0);
    const steady = turns.filter((t) => t.stratum === "steady");
    const steadyWarm = steady.filter((t) => t.warm).length;
    const steadyCold = steady.length - steadyWarm;
    const failure =
      kind === "warm" && steadyCold > 0
        ? "warm_arm_has_cold_steady_turn"
        : kind === "cold" && steadyWarm > 0
          ? "cold_arm_has_warm_steady_turn"
          : null;
    if (failure) failures.push(`arm ${arm}: ${failure}`);
    const byStratum = Object.fromEntries(
      STRATA.map((s) => {
        const rows = turns.filter((t) => t.stratum === s);
        const stages = Object.fromEntries(
          STAGES.map((stage) => [
            stage,
            distribution(
              rows.map((r) => r.stages[stage]),
              rows.map((r) => r.stageReasons[stage]),
            ),
          ]),
        ) as Record<Stage, Distribution>;
        return [s, { turns: rows.length, stages }];
      }),
    ) as Record<Stratum, StratumReport>;
    if (!engineOnly) {
      for (const t of steady) {
        if (t.stages.eouMs !== null) liveSteady.eou.push(t.stages.eouMs);
        if (t.stages.ttsTtfbMs !== null) liveSteady.tts.push(t.stages.ttsTtfbMs);
      }
      liveSteady.arms.add(arm);
    }
    arms.push({
      arm,
      kind,
      engineOnly,
      calls: calls.map((c) => ({
        callId: c.callId,
        complete: c.report.complete && c.report.engineAttempts > 0,
        engineAttempts: c.report.engineAttempts,
        incomplete: c.report.incomplete.total,
        unbound: c.report.unbound.total,
        gaps: c.report.gaps.total,
        malformedRows: c.malformedRows,
      })),
      consistency: { steadyTurns: steady.length, steadyWarm, steadyCold, ok: failure === null, failure },
      turns,
      byStratum,
      benchComposedEstimateMs: { reason: engineOnly ? "no_live_pool" : "not_engine_only" },
    });
  }
  // Bench-composed estimate (§3.3): engine-only arms only, from the pooled live steady EOU/TTS p50.
  const eouP50 = nearestRankPercentile(liveSteady.eou, 50);
  const ttsP50 = nearestRankPercentile(liveSteady.tts, 50);
  for (const arm of arms) {
    if (!arm.engineOnly || eouP50 === null || ttsP50 === null) continue;
    const steady = arm.turns.filter((t) => t.stratum === "steady");
    const composed = steady.map((t) =>
      t.stages.engineFirstTextMs === null ? null : eouP50 + t.stages.engineFirstTextMs + ttsP50,
    );
    arm.benchComposedEstimateMs = {
      ...distribution(
        composed,
        steady.map((t) => t.stageReasons.engineFirstTextMs),
      ),
      description:
        "bench-composed: pooled live EOU p50 + engine firstTextMs + pooled live TTS TTFB p50; NOT the v2 in-call estimate",
      pool: {
        eouP50,
        ttsTtfbP50: ttsP50,
        eouN: liveSteady.eou.length,
        ttsN: liveSteady.tts.length,
        fromArms: [...liveSteady.arms].sort(),
      },
    };
  }

  const rng = mulberry32(seed);
  const pairs: PairInterval[] = (input.pairs ?? []).map((p) => {
    const t = arms.find((a) => a.arm === p.treatment);
    const b = arms.find((a) => a.arm === p.base);
    const intervals = Object.fromEntries(
      CLAIM_STAGES.map((stage) => {
        if (!t || !b) return [stage, { n1: 0, n2: 0, reason: "unknown_arm" as const }];
        const s1 = t.byStratum.steady.stages[stage].samples;
        const s2 = b.byStratum.steady.stages[stage].samples;
        if (s1.length < 2 || s2.length < 2)
          return [stage, { n1: s1.length, n2: s2.length, reason: "insufficient_samples" as const }];
        return [stage, { n1: s1.length, n2: s2.length, ...bootstrapMedianDifference(s1, s2, rng, resamples) }];
      }),
    ) as PairInterval["intervals"];
    if (!t || !b) failures.push(`pair ${p.treatment}=${p.base}: unknown arm`);
    return { treatment: p.treatment, base: p.base, stratum: "steady", intervals };
  });

  const cross = input.engineLog ? crossCheck(input.engineLog, allTurns) : null;
  let benchAssertions: BenchAssertionSummary | null = null;
  if (input.benchResults) {
    const byKey = new Map(allTurns.map((t) => [`${t.callId} ${t.turnId}`, t]));
    benchAssertions = {
      rows: input.benchResults.length,
      keyword: { pass: 0, fail: 0, notApplicable: 0 },
      tool: { pass: 0, fail: 0, unobserved: 0 },
    };
    for (const r of input.benchResults) {
      if (r.keywordPass === null) benchAssertions.keyword.notApplicable += 1;
      else if (r.keywordPass) benchAssertions.keyword.pass += 1;
      else benchAssertions.keyword.fail += 1;
      if (!r.expectsTool) continue;
      const turn = byKey.get(`${r.callId} ${r.turnId}`);
      if (!turn || turn.toolCount === null) benchAssertions.tool.unobserved += 1;
      else if (turn.toolCount >= 1) benchAssertions.tool.pass += 1;
      else benchAssertions.tool.fail += 1;
    }
  }

  return {
    schemaVersion: 2,
    seed,
    resamples,
    arms,
    pairs,
    crossCheck: cross,
    benchAssertions,
    ok: failures.length === 0,
    failures,
  };
}
