# KPR-465 comparison reader chunk (B) — multi-call, per-arm, per-stratum comparison

> **For agentic workers:** Use dodi-dev:implement after chunk A is merged into the ticket branch. Second in the binding order.

**Goal:** A pure, deterministic comparison mode over one or more `voice_diagnostic` JSONL inputs that groups calls into labelled arms, stratifies turns (steady/first/retried/tool), reports every §3.1 stage distribution per arm and stratum with nearest-rank percentiles and excluded-by-reason tables, fails the run on warm/cold mislabels, emits seeded bootstrap intervals for the difference of medians, cross-checks the retained engine log, and produces an explicitly labelled bench-composed estimate for engine-only inputs.

**Architecture:** `src/voice/voice-latency-compare.ts` reuses `reduceVoiceDiagnostics` per call (one small additive change to the reader exposes a per-speech `latency` detail with the three components and the bound `turnId`), builds one `TurnRow` per engine turn from the **final** `engine_attempt_terminal` (highest `engineAttemptSeq`), joins the worker stages through the bound speech, stratifies from the attempt's own `continuity`/`selectedContinuity`/`warm`/`toolCount` fields (never from proximity), and aggregates. A seeded `mulberry32` PRNG makes the bootstrap reproducible. `scripts/voice-latency-compare.ts` is a thin `parseArgs` CLI. Fixtures are produced by a checked-in deterministic builder and asserted byte-stable.

**Tech Stack:** TypeScript, existing `voice-diagnostic-reader.ts`/`percentile.ts`, `node:util.parseArgs`, Vitest.

Spec authority: §3.1 (stages, strata, percentiles, intervals), §3.3, §3.4 (which distribution carries which claim), §8 R1, R7. Canon R4 (compare on JSONL denominators; `voice-latency-baseline.ts` untouched; v1/v2 docs not comparable).

## Testing Contract (chunk B)

### Required Test Groups

- Unit: `required`
  - Scope: `voice-latency-compare.ts` (every exported function) via `src/voice/voice-latency-compare.test.ts`; the reader's additive `latency` detail via `src/voice/voice-diagnostic-reader.test.ts`; the CLI's argument/exit contract via `scripts/voice-latency-compare.test.ts`.
  - Reason: the whole module is a pure function of rows; determinism is a stated requirement (§3.3).
  - Minimum assertions (R1, one per clause): (1) warm and cold arms produce separate per-stratum tables; (2) tool, first and retried turns land in their own strata and never in `steady`; (3) exclusions are counted by reason per stratum; (4) an engine-only call yields engine-stage distributions and a `benchComposedEstimateMs` labelled as such, `null` with `reason: "no_live_pool"` when no live arm is present; (5) a warm-labelled arm with a cold steady turn sets `ok: false` with `warm_arm_has_cold_steady_turn`; (6) a cold-labelled arm with a warm steady turn sets `ok: false` with `cold_arm_has_warm_steady_turn`; (7) the engine-log cross-check reports exactly one mismatch for the one disagreeing row; (8) KPR-464-era rows (no `bootToInitMs`/`queueWaitMs`/`effort`) parse and report the stage as `missingByReason.absent`; (9) unknown keys are still rejected by the parser (malformed row count increments); (10) percentiles are nearest-rank (`[1,2,3,4]` → p50 = 2, p95 = 4); (11) bootstrap intervals are byte-identical across two runs with the same seed and differ with a different seed, and the seed is echoed in the report; (12) `ok` is false and `failures` non-empty when any call report is incomplete.
- Integration: `required`
  - Scope: CLI end-to-end over the checked-in fixtures (`spawnSync` of `npx tsx scripts/voice-latency-compare.ts`), asserting exit codes 0/1/2 and that stdout JSON equals the module's output for the same inputs.
  - Reason: the operator runs the CLI, not the module; exit codes are the run gate.
  - Harness: `existing` (`scripts/voice-latency-baseline.test.ts` shows the `spawnSync` + tmpdir pattern).
  - Minimum assertions: fixture run exits 0 with `ok: true`; mislabel fixture run exits 1; missing `--call` exits 2; unknown-key file exits 0 but reports `malformedRows ≥ 1` for that call.
- E2E: `not-required` (the reader consumes bench/live artifacts produced by chunks D/E).

### Critical Flows

- Cold call → 1 first + N steady + tool + interrupted turns → correct strata and exclusions.
- Warm call → opener (first) + steady + one retried (`continuity: full_transcript`, `selectedContinuity: fresh`, `warm: true`) → retried never pooled.
- Engine-only bench call → engine stages only; bench-composed estimate from the live pool.
- Cross-check → per-`turnId` equality of `bootToInitMs`/`initToFirstTokenMs`; `warmTurnSeq` strictly increasing per call.

### Regression Surface

- `reduceVoiceDiagnostics`'s report is unchanged except the additive `details.speech[].latency` field; every existing reader test stays green (`toMatchObject` assertions are unaffected by an added key).
- `scripts/read-voice-diagnostics.ts` unchanged. `scripts/voice-latency-baseline.ts` unchanged (canon R4).

### Commands

- Unit: `npx vitest run src/voice/voice-latency-compare.test.ts src/voice/voice-diagnostic-reader.test.ts`
- Integration: `npx vitest run scripts/voice-latency-compare.test.ts`
- Fixture CLI: `npx tsx scripts/voice-latency-compare.ts --input docs/epics/kpr-462/fixtures/kpr-465-compare.jsonl --call call-cold-a=A0-cold --call call-warm-a=A1-warm --call call-bench-1=A1-warm-bench --pair A1-warm=A0-cold --engine-log docs/epics/kpr-462/fixtures/kpr-465-engine-log.jsonl --bench-results docs/epics/kpr-462/fixtures/kpr-465-bench-results.jsonl --seed 20260911`
  Expected: exit 0; `ok: true`; `arms[].kind` = cold/warm/warm; `pairs[0].intervals.initToFirstTokenMs.ci95` a two-number array; `crossCheck.mismatched === 1`.
- Broader: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- Fixture builder `src/voice/testing/compare-fixture.ts` is deterministic (fixed ids, fixed timestamps); the test regenerates and compares to the checked-in files; `KPR465_WRITE_FIXTURES=1 npx vitest run src/voice/voice-latency-compare.test.ts` rewrites them (documented in the test header).
- No config import anywhere in this chunk (the module and CLI must load in a bare process).

### Non-Required Rationale

- E2E: none is unique to this chunk.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Never derive a stratum from timestamps, row order or "latest attempt for the call" — only from the attempt row's own fields keyed by `turnId` and the explicit speech binding.

---

### Task B1: Additive per-speech latency detail in the reader

**Files:**
- Modify: `src/voice/voice-diagnostic-reader.ts:46-68` (`VoiceDiagnosticEntityDetail`), `:649-663` (latency loop), `:769-800` (`toDetail`), `:805-833` (`latencyExclusion`)
- Test: `src/voice/voice-diagnostic-reader.test.ts`

- [ ] **Step 1: Types.**

```typescript
/** KPR-465 §3.3: per-speech components of the v2 estimate, exposed for the comparison reader. */
export interface SpeechLatencyDetail {
  estimateMs: number | null;
  exclusion: LatencyExclusionReason | null;
  eouMs: number | null;
  bridgeFirstTextMs: number | null;
  ttsTtfbMs: number | null;
  /** turnId of the single bound bridge, when exactly one bridge is bound; else null. */
  boundTurnId: string | null;
}
```

Add `latency?: SpeechLatencyDetail;` as the last field of `VoiceDiagnosticEntityDetail` (speech entities only; other kinds leave it absent).

- [ ] **Step 2: Compute components beside the existing exclusion.**

Replace the latency loop (lines 649–663) with:

```typescript
  const exclusions = emptyLatencyExclusions();
  const samples: number[] = [];
  const latencyBySpeechKey = new Map<string, SpeechLatencyDetail>();
  const bridgesBySpeech = groupBoundEntities(maps.bridge);
  const synthesesBySpeech = groupBoundEntities(maps.synthesis);
  for (const speech of maps.speech.values()) {
    const boundBridges = bridgesBySpeech.get(speech.key) ?? [];
    const boundSyntheses = synthesesBySpeech.get(speech.key) ?? [];
    const reason = latencyExclusion(speech, boundBridges, boundSyntheses, effectiveStates);
    if (typeof reason === "string") exclusions[reason] += 1;
    else samples.push(reason);
    const eou = speech.eouMetrics.length === 1 ? speech.eouMetrics[0]! : null;
    const bridge = boundBridges.length === 1 ? boundBridges[0]! : null;
    const synthesis = boundSyntheses.length === 1 ? boundSyntheses[0]! : null;
    const tts = synthesis && synthesis.ttsMetrics.length === 1 ? synthesis.ttsMetrics[0]! : null;
    latencyBySpeechKey.set(speech.key, {
      estimateMs: typeof reason === "number" ? reason : null,
      exclusion: typeof reason === "string" ? reason : null,
      eouMs: eou && eou.event === "sdk_metric" ? measureValue(eou.eouMs) : null,
      bridgeFirstTextMs: bridge ? measureValue(bridge.bridgeFirstText) : null,
      ttsTtfbMs: tts && tts.event === "sdk_metric" ? measureValue(tts.ttfbMs) : null,
      boundTurnId: bridge?.turnId ?? null,
    });
  }
  samples.sort((a, b) => a - b);
  for (const detail of details.speech) {
    const latency = latencyBySpeechKey.get(detail.key);
    if (latency) detail.latency = latency;
  }
```

(`details` is built before this loop; the patch-in keeps `toDetail` untouched.)

- [ ] **Step 3: Test.**

```typescript
  it("KPR-465: speech details expose the estimate components and the bound turnId", () => {
    const text = readFileSync("docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl", "utf8");
    const report = reduceVoiceDiagnostics(text, "call-fixture");
    const replacement = report.details.speech.find((s) => s.speechId === "speech-replacement")!;
    expect(replacement.latency).toEqual({
      estimateMs: 60, exclusion: null, eouMs: 10, bridgeFirstTextMs: 20, ttsTtfbMs: 30, boundTurnId: "turn-replacement",
    });
    const opening = report.details.speech.find((s) => s.speechId === "speech-opening")!;
    expect(opening.latency).toMatchObject({ estimateMs: null, exclusion: "not_applicable", boundTurnId: null });
    expect(report.details.bridge[0]).not.toHaveProperty("latency");
  });
```

- [ ] **Step 4: Verify and commit.**

Run: `npx vitest run src/voice/voice-diagnostic-reader.test.ts` — pass (existing cases unchanged).

```bash
git add src/voice/voice-diagnostic-reader.ts src/voice/voice-diagnostic-reader.test.ts
git commit -m "feat(voice): expose per-speech latency components on the diagnostic report (KPR-465)"
```

### Task B2: The comparison module

**Files:**
- Create: `src/voice/voice-latency-compare.ts`
- Test: `src/voice/voice-latency-compare.test.ts` (Task B4)

- [ ] **Step 1: Write the module.**

```typescript
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
import type { Measure, VoiceDiagnosticEvent } from "./voice-trace.js";

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
/** The two stages that carry a between-arm claim (§3.4): powered (bench) and confirmatory (live). */
export const CLAIM_STAGES: readonly Stage[] = ["initToFirstTokenMs", "estimateMs"];

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
  calls: Array<{ callId: string; complete: boolean; incomplete: number; unbound: number; gaps: number; malformedRows: number }>;
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
  rows: number;
  matched: number;
  mismatched: number;
  missingInJsonl: number;
  mismatches: Array<{ callId: string; turnId: string; field: "bootToInitMs" | "initToFirstTokenMs"; log: number | null; jsonl: number | null }>;
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

export function buildTurnRows(events: VoiceDiagnosticEvent[], report: VoiceDiagnosticReport, callId: string): TurnRow[] {
  type Attempt = Extract<VoiceDiagnosticEvent, { event: "engine_attempt_terminal" }>;
  const byTurn = new Map<string, Attempt[]>();
  for (const row of events) {
    if (row.event !== "engine_attempt_terminal" || !row.turnId || row.engineAttemptSeq === null) continue;
    const list = byTurn.get(row.turnId) ?? [];
    list.push(row as Attempt);
    byTurn.set(row.turnId, list);
  }
  const speechByTurn = new Map<string, Array<NonNullable<VoiceDiagnosticReport["details"]["speech"][number]["latency"]> & { speechId: string | null }>>();
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
      continuity: retried ? "full_transcript" : (final.continuity as TurnRow["continuity"]) ?? null,
      selectedContinuity: final.selectedContinuity ?? null,
      warm,
      toolCount: final.toolCount ?? null,
    });
    const lockQueue = warm ? final.queueWaitMs : final.lockWaitMs;
    const stages: Record<Stage, number | null> = {
      eouMs: speech?.eouMs ?? null,
      lockQueueMs: value(lockQueue),
      bootToInitMs: value(final.bootToInitMs),
      initToFirstTokenMs: value(final.initToFirstTokenMs),
      engineFirstTextMs: value(final.firstTextMs),
      bridgeFirstTextMs: speech?.bridgeFirstTextMs ?? null,
      ttsTtfbMs: speech?.ttsTtfbMs ?? null,
      estimateMs: ambiguous ? null : (speech?.estimateMs ?? null),
    };
    const workerReason = ambiguous ? "ambiguous_components" : speech ? null : "no_bound_speech";
    const stageReasons: Record<Stage, string | null> = {
      eouMs: stages.eouMs === null ? workerReason ?? "missing_eou" : null,
      lockQueueMs: stages.lockQueueMs === null ? reasonOf(lockQueue) : null,
      bootToInitMs: stages.bootToInitMs === null ? reasonOf(final.bootToInitMs) : null,
      initToFirstTokenMs: stages.initToFirstTokenMs === null ? reasonOf(final.initToFirstTokenMs) : null,
      engineFirstTextMs: stages.engineFirstTextMs === null ? reasonOf(final.firstTextMs) : null,
      bridgeFirstTextMs: stages.bridgeFirstTextMs === null ? workerReason ?? "missing_bridge_first_text" : null,
      ttsTtfbMs: stages.ttsTtfbMs === null ? workerReason ?? "missing_tts_metric" : null,
      estimateMs: stages.estimateMs === null ? workerReason ?? speech?.exclusion ?? "missing" : null,
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
      effort: typeof (final as { effort?: unknown }).effort === "string" ? ((final as { effort?: string }).effort ?? null) : null,
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

export function parseEngineLog(text: string, callIds: ReadonlySet<string>): { rows: EngineLogRow[]; malformed: number } {
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
  const byKey = new Map(turns.map((t) => [`${t.callId} ${t.turnId}`, t]));
  const out: CrossCheck = { rows: log.length, matched: 0, mismatched: 0, missingInJsonl: 0, mismatches: [], warmTurnSeqMonotonic: {} };
  const seqByCall = new Map<string, number[]>();
  for (const row of log) {
    if (row.warmPath && row.warmTurnSeq !== undefined) {
      const s = seqByCall.get(row.callId) ?? [];
      s.push(row.warmTurnSeq);
      seqByCall.set(row.callId, s);
    }
    const turn = byKey.get(`${row.callId} ${row.turnId}`);
    if (!turn) {
      out.missingInJsonl += 1;
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
  const armCalls = new Map<string, Array<{ callId: string; events: VoiceDiagnosticEvent[]; report: VoiceDiagnosticReport; malformedRows: number }>>();
  for (const call of input.calls) {
    if (!armCalls.has(call.arm)) {
      armKindOf(call.arm); // throws on an unlabelled arm
      armOrder.push(call.arm);
      armCalls.set(call.arm, []);
    }
    const parsed = parseVoiceDiagnosticJsonl(call.jsonl, call.callId);
    const report = reduceVoiceDiagnostics(parsed, call.callId);
    armCalls.get(call.arm)!.push({ callId: call.callId, events: parsed.events, report, malformedRows: parsed.malformedRows });
    if (!report.complete) failures.push(`call ${call.callId} (${call.arm}) is incomplete`);
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
          STAGES.map((stage) => [stage, distribution(rows.map((r) => r.stages[stage]), rows.map((r) => r.stageReasons[stage]))]),
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
        complete: c.report.complete,
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
    const composed = steady.map((t) => (t.stages.engineFirstTextMs === null ? null : eouP50 + t.stages.engineFirstTextMs + ttsP50));
    arm.benchComposedEstimateMs = {
      ...distribution(composed, steady.map((t) => t.stageReasons.engineFirstTextMs)),
      description: "bench-composed: pooled live EOU p50 + engine firstTextMs + pooled live TTS TTFB p50; NOT the v2 in-call estimate",
      pool: { eouP50, ttsTtfbP50: ttsP50, eouN: liveSteady.eou.length, ttsN: liveSteady.tts.length, fromArms: [...liveSteady.arms].sort() },
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
        if (s1.length < 2 || s2.length < 2) return [stage, { n1: s1.length, n2: s2.length, reason: "insufficient_samples" as const }];
        return [stage, { n1: s1.length, n2: s2.length, ...bootstrapMedianDifference(s1, s2, rng, resamples) }];
      }),
    ) as PairInterval["intervals"];
    if (!t || !b) failures.push(`pair ${p.treatment}=${p.base}: unknown arm`);
    return { treatment: p.treatment, base: p.base, stratum: "steady", intervals };
  });

  const cross = input.engineLog ? crossCheck(input.engineLog, allTurns) : null;
  let benchAssertions: BenchAssertionSummary | null = null;
  if (input.benchResults) {
    const byKey = new Map(allTurns.map((t) => [`${t.callId} ${t.turnId}`, t]));
    benchAssertions = { rows: input.benchResults.length, keyword: { pass: 0, fail: 0, notApplicable: 0 }, tool: { pass: 0, fail: 0, unobserved: 0 } };
    for (const r of input.benchResults) {
      if (r.keywordPass === null) benchAssertions.keyword.notApplicable += 1;
      else if (r.keywordPass) benchAssertions.keyword.pass += 1;
      else benchAssertions.keyword.fail += 1;
      if (!r.expectsTool) continue;
      const turn = byKey.get(`${r.callId} ${r.turnId}`);
      if (!turn || turn.toolCount === null) benchAssertions.tool.unobserved += 1;
      else if (turn.toolCount >= 1) benchAssertions.tool.pass += 1;
      else benchAssertions.tool.fail += 1;
    }
  }

  return { schemaVersion: 2, seed, resamples, arms, pairs, crossCheck: cross, benchAssertions, ok: failures.length === 0, failures };
}
```

Note on `final.effort`: the `EnginePayload` type gains `effort` only in chunk C; the cast above keeps this module compiling before and after C lands (the reader allowlist rejects an `effort` key until C adds it, so the field is simply absent on chunk-B-era rows).

- [ ] **Step 2: Typecheck.**

Run: `npx tsc --noEmit` — exit 0.

- [ ] **Step 3: Commit.**

```bash
git add src/voice/voice-latency-compare.ts
git commit -m "feat(voice): add the multi-call latency comparison module (KPR-465)"
```

### Task B3: CLI

**Files:**
- Create: `scripts/voice-latency-compare.ts`
- Test: `scripts/voice-latency-compare.test.ts` (Task B4)

- [ ] **Step 1: Write the CLI (mirrors `scripts/read-voice-diagnostics.ts`'s bounded read and entrypoint guard).**

```typescript
#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { assertBoundedInput, VoiceDiagnosticInputError } from "../src/voice/voice-diagnostic-reader.js";
import {
  compareVoiceLatency,
  parseEngineLog,
  DEFAULT_RESAMPLES,
  DEFAULT_SEED,
  type BenchResultRow,
  type ComparePair,
} from "../src/voice/voice-latency-compare.js";

async function readBoundedFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new VoiceDiagnosticInputError(`input is not a file: ${path}`);
    assertBoundedInput(info.size);
    const chunks: Buffer[] = [];
    for await (const chunk of handle.createReadStream({ autoClose: false })) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

function splitPair(raw: string, flag: string): [string, string] {
  const i = raw.indexOf("=");
  if (i <= 0 || i === raw.length - 1) throw new VoiceDiagnosticInputError(`${flag} expects <a>=<b>, got "${raw}"`);
  return [raw.slice(0, i), raw.slice(i + 1)];
}

function parseBenchResults(text: string): BenchResultRow[] {
  const rows: BenchResultRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const v = JSON.parse(line) as Record<string, unknown>;
    if (typeof v.callId !== "string" || typeof v.turnId !== "string" || typeof v.arm !== "string") {
      throw new VoiceDiagnosticInputError("bench result row missing callId/turnId/arm");
    }
    rows.push({
      callId: v.callId,
      arm: v.arm,
      turnIndex: Number(v.turnIndex),
      turnId: v.turnId,
      expectsTool: v.expectsTool === true,
      keywordPass: typeof v.keywordPass === "boolean" ? v.keywordPass : null,
      clientFirstTextMs: typeof v.clientFirstTextMs === "number" ? v.clientFirstTextMs : null,
      textLength: typeof v.textLength === "number" ? v.textLength : 0,
      status: typeof v.status === "number" ? v.status : null,
    });
  }
  return rows;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        input: { type: "string", multiple: true },
        call: { type: "string", multiple: true },
        pair: { type: "string", multiple: true },
        "engine-log": { type: "string" },
        "bench-results": { type: "string" },
        seed: { type: "string" },
        resamples: { type: "string" },
      },
    });
    if (!values.input?.length || !values.call?.length) {
      throw new VoiceDiagnosticInputError(
        "usage: voice-latency-compare --input <jsonl> [--input ...] --call <callId>=<armLabel> [--call ...] [--pair <treatment>=<base>] [--engine-log <jsonl>] [--bench-results <jsonl>] [--seed n] [--resamples n]",
      );
    }
    const texts = await Promise.all(values.input.map(readBoundedFile));
    const jsonl = texts.join("\n");
    assertBoundedInput(Buffer.byteLength(jsonl));
    const calls = values.call.map((raw) => {
      const [callId, arm] = splitPair(raw, "--call");
      return { callId, arm, jsonl };
    });
    const pairs: ComparePair[] = (values.pair ?? []).map((raw) => {
      const [treatment, base] = splitPair(raw, "--pair");
      return { treatment, base };
    });
    const callIds = new Set(calls.map((c) => c.callId));
    const engineLog = values["engine-log"] ? parseEngineLog(await readBoundedFile(values["engine-log"]), callIds).rows : undefined;
    const benchResults = values["bench-results"] ? parseBenchResults(await readBoundedFile(values["bench-results"])) : undefined;
    const seed = values.seed === undefined ? DEFAULT_SEED : Number.parseInt(values.seed, 10);
    const resamples = values.resamples === undefined ? DEFAULT_RESAMPLES : Number.parseInt(values.resamples, 10);
    if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(resamples) || resamples < 1) {
      throw new VoiceDiagnosticInputError("--seed and --resamples must be integers (resamples ≥ 1)");
    }
    const report = compareVoiceLatency({ calls, pairs, engineLog, benchResults, seed, resamples });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`voice-latency-compare: ${message}\n`);
    return 2;
  }
}

export function isEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
```

- [ ] **Step 2: Commit.**

```bash
git add scripts/voice-latency-compare.ts
git commit -m "feat(voice): voice-latency-compare CLI (KPR-465)"
```

### Tasks B4–B5

The deterministic fixtures, the R1/R7 regression suite, the CLI test and the chunk gate live in [kpr-465-plan-reader-fixtures.md](./kpr-465-plan-reader-fixtures.md) (split for the ≤ 1,000-line review bound; same chunk, same Testing Contract, sequenced immediately after Task B3).
