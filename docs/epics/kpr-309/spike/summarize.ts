/**
 * KPR-310 spike — summary.json construction (spec: "Measurement and evidence format").
 * Pure over TurnRecord[]; the same function serves the full-run path (in-memory records)
 * and the --summarize path (records parsed from .jsonl). No imports from src/**.
 */
import { buildCells, foreignNoncesFor, MODELS } from "./cells.ts";
import type { GradedCell, Ruling, TurnRecord } from "./grade.ts";
import { deriveRuling, gradeCell, viewResult } from "./grade.ts";

export interface SummaryTurn {
  label: string;
  attempt: number;
  requestedModel: string;
  observedModels: string[];
  sessionId: string | null;
  resumedSessionId: string | null;
  cacheRead: number;
  cacheCreation: number;
  subtype: string | null;
  nonceRecall: Record<string, boolean>;
  costUsd: number | null;
  wallMs: number;
  timedOut: boolean;
  thrown: string | null;
  cacheWindowOk: boolean | null;
}

export interface SummaryCell {
  id: string;
  title: string;
  chain: string;
  provenance: { runId: string; sourceJsonl: string; attemptGraded: number };
  grade: GradedCell["grade"];
  caveats: string[];
  notes: string[];
  optional: boolean;
  faultCell: boolean;
  turns: SummaryTurn[];
}

export interface SummaryJson {
  runId: string;
  timestamp: string;
  sdkVersion: string;
  seed: number;
  withM9: boolean;
  ruling: Ruling;
  constraints: string[];
  totalCostUsd: number;
  totalTurnAttempts: number;
  cells: SummaryCell[];
}

/** Required cells for a run to count as complete (M9 optional). */
export const REQUIRED_CELLS = ["M1", "M2", "M3", "M4", "M5", "M6", "M7a", "M7b", "M8"] as const;

/** Final attempt per cell within a run (grader distinguishes attempts; grading uses the last). */
export function finalAttemptRecords(records: TurnRecord[], cellId: string, runId: string): TurnRecord[] {
  const cellRecs = records.filter((r) => r.cell === cellId && r.runId === runId);
  if (cellRecs.length === 0) return [];
  const maxAttempt = Math.max(...cellRecs.map((r) => r.attempt));
  return cellRecs.filter((r) => r.attempt === maxAttempt);
}

export function buildSummary(
  records: TurnRecord[],
  runId: string,
  sdkVersion: string,
  seed: number,
): SummaryJson {
  const runRecords = records.filter((r) => r.runId === runId);
  const withM9 = runRecords.some((r) => r.cell === "M9");
  const cells = buildCells(withM9);

  // Completeness gate (vacuous-ruling hazard): a partial run must never produce an
  // authoritative-looking summary.json. Refuse unless every required cell has records.
  const missing = REQUIRED_CELLS.filter((c) => finalAttemptRecords(runRecords, c, runId).length === 0);
  if (missing.length > 0) {
    throw new Error(
      `buildSummary: run ${runId} is incomplete - no final-attempt records for: ${missing.join(", ")}. ` +
        `summary.json refused. Complete the run with --cell <id> --run ${runId}, then rerun --summarize --run ${runId}.`,
    );
  }

  // M1 baseline: final-attempt T2 per-model cache read for the sonnet model.
  const m1Final = finalAttemptRecords(runRecords, "M1", runId);
  const m1T2 = m1Final.find((r) => r.turnLabel === "T2");
  const m1T2View = m1T2 ? viewResult(m1T2.resultMessage) : null;
  const baselineT2CacheRead = m1T2View?.modelUsage[MODELS.sonnet]?.cacheReadInputTokens ?? null;

  const summaryCells: SummaryCell[] = [];
  const graded: GradedCell[] = [];
  for (const cell of cells) {
    const finals = finalAttemptRecords(runRecords, cell.id, runId);
    if (finals.length === 0) continue; // only reachable for absent optional M9
    const g = gradeCell(cell, finals, {
      baselineT2CacheRead: cell.id === "M1" ? null : baselineT2CacheRead,
      foreignNonces: foreignNoncesFor(cell.id, seed, cells),
    });
    graded.push(g);
    summaryCells.push({
      id: cell.id,
      title: cell.title,
      chain: cell.turns.map((t) => t.model).join(" -> "),
      provenance: { runId, sourceJsonl: `evidence/${cell.id}.jsonl`, attemptGraded: finals[0]?.attempt ?? 1 },
      grade: g.grade,
      caveats: g.caveats,
      notes: g.notes,
      optional: g.optional,
      faultCell: g.faultCell,
      turns: finals.map((r): SummaryTurn => {
        const rv = viewResult(r.resultMessage);
        const mu = rv?.modelUsage[r.requestedModel];
        return {
          label: r.turnLabel,
          attempt: r.attempt,
          requestedModel: r.requestedModel,
          observedModels: rv ? Object.keys(rv.modelUsage) : [],
          sessionId: r.initSessionId,
          resumedSessionId: r.resumedSessionId,
          cacheRead: mu?.cacheReadInputTokens ?? rv?.aggregateCacheRead ?? 0,
          cacheCreation: mu?.cacheCreationInputTokens ?? rv?.aggregateCacheCreation ?? 0,
          subtype: rv?.subtype ?? null,
          nonceRecall: Object.fromEntries(r.nonceChecks.map((c) => [`${c.relation}:${c.key}`, c.found])),
          costUsd: rv?.totalCostUsd ?? null,
          wallMs: r.wallMs,
          timedOut: r.timedOut,
          thrown: r.thrown ? `${r.thrown.name}: ${r.thrown.message.slice(0, 300)}` : null,
          cacheWindowOk: r.cacheWindowOk,
        };
      }),
    });
  }

  const { ruling, constraints } = deriveRuling(graded);
  const totalCostUsd = runRecords.reduce((acc, r) => acc + (viewResult(r.resultMessage)?.totalCostUsd ?? 0), 0);
  return {
    runId,
    timestamp: new Date().toISOString(),
    sdkVersion,
    seed,
    withM9,
    ruling,
    constraints,
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    totalTurnAttempts: runRecords.length,
    cells: summaryCells,
  };
}

/** Latest run id (by max ts) that has records for every required cell. */
export function latestCompleteRunId(records: TurnRecord[]): string | null {
  const byRun = new Map<string, { cells: Set<string>; maxTs: string }>();
  for (const r of records) {
    const e = byRun.get(r.runId) ?? { cells: new Set<string>(), maxTs: "" };
    e.cells.add(r.cell);
    if (r.ts > e.maxTs) e.maxTs = r.ts;
    byRun.set(r.runId, e);
  }
  let best: { runId: string; ts: string } | null = null;
  for (const [runId, e] of byRun) {
    if (REQUIRED_CELLS.every((c) => e.cells.has(c))) {
      if (best === null || e.maxTs > best.ts) best = { runId, ts: e.maxTs };
    }
  }
  return best?.runId ?? null;
}
