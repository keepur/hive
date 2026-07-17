/**
 * KPR-310 spike — offline unit tests for grade.ts + summarize.ts (no API, no SDK import).
 * Run: npx tsx docs/epics/kpr-309/spike/selftest.ts
 * Deliberately NOT a vitest file: vitest include globs cover src|plugins|setup|scripts only,
 * and widening them for a throwaway spike would be a production-config change (D1).
 */
import assert from "node:assert/strict";
import { buildCells, DEFAULT_SEED, foreignNoncesFor, MODELS, noncesFor } from "./cells.ts";
import type { TurnRecord } from "./grade.ts";
import { CACHE_HIT_MIN, deriveRuling, gradeCell, type GradedCell } from "./grade.ts";
import { buildSummary, finalAttemptRecords, latestCompleteRunId } from "./summarize.ts";

const SEED = DEFAULT_SEED;
const RUN = "run-selftest";
const CELLS = buildCells(false);
const cellById = (id: string) => {
  const c = CELLS.find((x) => x.id === id);
  if (!c) throw new Error(`no cell ${id}`);
  return c;
};

interface MkOpts {
  cell: string;
  label: string;
  model: string;
  attempt?: number;
  runId?: string;
  response?: string;
  sessionId?: string;
  resumedSessionId?: string | null;
  cacheRead?: number;
  cacheCreation?: number;
  subtype?: string;
  thrown?: { name: string; message: string } | null;
  timedOut?: boolean;
  toolCalled?: boolean;
  observedModel?: string | null; // null => empty modelUsage
  cacheWindowOk?: boolean | null;
  ts?: string;
}

function mk(o: MkOpts): TurnRecord {
  const observed = o.observedModel === null ? {} : { [o.observedModel ?? o.model]: {
    cacheReadInputTokens: o.cacheRead ?? CACHE_HIT_MIN * 5,
    cacheCreationInputTokens: o.cacheCreation ?? 0,
    inputTokens: 100, outputTokens: 20, costUSD: 0.001,
  } };
  const failed = o.thrown != null || o.timedOut === true;
  return {
    runId: o.runId ?? RUN, seed: SEED, ts: o.ts ?? new Date().toISOString(),
    cell: o.cell, attempt: o.attempt ?? 1, turnLabel: o.label,
    requestedModel: o.model, resumeOf: null,
    resumedSessionId: o.resumedSessionId ?? null, fork: false,
    options: {}, messageTypes: [], apiKeySource: "none",
    initSessionId: o.sessionId ?? `sess-${o.cell}-${o.label}`,
    resultMessage: failed ? null : {
      type: "result", subtype: o.subtype ?? "success", is_error: (o.subtype ?? "success") !== "success",
      num_turns: 1, total_cost_usd: 0.001,
      usage: { cache_read_input_tokens: o.cacheRead ?? CACHE_HIT_MIN * 5, cache_creation_input_tokens: o.cacheCreation ?? 0 },
      modelUsage: observed,
    },
    responseText: o.response ?? "",
    toolCalled: o.toolCalled ?? false,
    thrown: o.thrown ? { ...o.thrown } : null,
    timedOut: o.timedOut ?? false,
    wallMs: 1000,
    cacheWindowOk: o.cacheWindowOk ?? null,
    nonceChecks: [],
  };
}

const gopts = (cellId: string) => ({
  baselineT2CacheRead: cellId === "M1" ? null : CACHE_HIT_MIN * 5,
  foreignNonces: foreignNoncesFor(cellId, SEED, CELLS),
});

/** Standard happy-path records for a 3-turn cell, chained ids (same id back each resume). */
function happy(cellId: string, a: string, b: string): TurnRecord[] {
  const n = noncesFor(cellId, SEED);
  const sid = `sess-${cellId}`;
  return [
    mk({ cell: cellId, label: "T1", model: a, response: "OK", sessionId: sid }),
    mk({ cell: cellId, label: "T2", model: b, response: n.n1, sessionId: sid, resumedSessionId: sid }),
    mk({ cell: cellId, label: "T3", model: a, response: `${n.n1} ${n.n2}`, sessionId: sid, resumedSessionId: sid, cacheWindowOk: true }),
  ];
}

let count = 0;
function check(name: string, fn: () => void): void {
  fn();
  count++;
  console.log(`  ok - ${name}`);
}

// 1. all-clean switch cell => PASS
check("clean M2 grades PASS", () => {
  const g = gradeCell(cellById("M2"), happy("M2", MODELS.sonnet, MODELS.haiku), gopts("M2"));
  assert.equal(g.grade, "PASS");
  assert.deepEqual(g.caveats, []);
});

// 2. T2 cache miss => DEGRADED with named cache caveat
check("M2 T2 cache miss grades DEGRADED", () => {
  const recs = happy("M2", MODELS.sonnet, MODELS.haiku);
  recs[1] = { ...recs[1], resultMessage: { ...(recs[1].resultMessage as object), modelUsage: { [MODELS.haiku]: { cacheReadInputTokens: 0, cacheCreationInputTokens: 6000, inputTokens: 100, outputTokens: 20, costUSD: 0.001 } } } };
  const g = gradeCell(cellById("M2"), recs, gopts("M2"));
  assert.equal(g.grade, "DEGRADED");
  assert.ok(g.caveats.some((c) => c.includes("prompt-cache miss")));
});

// 3. requested model absent from modelUsage => FAIL (silent substitution)
check("silent model substitution grades FAIL", () => {
  const recs = happy("M2", MODELS.sonnet, MODELS.haiku);
  recs[1] = mk({ cell: "M2", label: "T2", model: MODELS.haiku, response: noncesFor("M2", SEED).n1, observedModel: MODELS.sonnet, resumedSessionId: recs[1].resumedSessionId, sessionId: recs[1].initSessionId ?? undefined });
  const g = gradeCell(cellById("M2"), recs, gopts("M2"));
  assert.equal(g.grade, "FAIL");
  assert.ok(g.notes.some((x) => x.includes("silent model substitution")));
});

// 4. M7b stale-id T3 hard error => DEGRADED with KPR-313 caveat, not FAIL
check("M7b stale-id unresumable grades DEGRADED", () => {
  const n = noncesFor("M7b", SEED);
  const sid = "sess-M7b";
  const recs = [
    mk({ cell: "M7b", label: "T1", model: MODELS.sonnet, response: "OK", sessionId: sid }),
    mk({ cell: "M7b", label: "T2", model: MODELS.sonnet, response: n.n1, sessionId: sid, resumedSessionId: sid }),
    mk({ cell: "M7b", label: "T3", model: MODELS.sonnet, thrown: { name: "Error", message: "session not found" } }),
  ];
  const g = gradeCell(cellById("M7b"), recs, gopts("M7b"));
  assert.equal(g.grade, "DEGRADED");
  assert.ok(g.caveats.some((c) => c.includes("KPR-313")));
});

// 5. M7a T3a (forked-id resume) hard error => DEGRADED (id-model cap), not FAIL
check("M7a T3a hard error grades DEGRADED, not FAIL", () => {
  const n = noncesFor("M7a", SEED);
  const recs = [
    mk({ cell: "M7a", label: "T1", model: MODELS.sonnet, response: "OK", sessionId: "id-orig" }),
    mk({ cell: "M7a", label: "T2", model: MODELS.sonnet, response: n.n1, sessionId: "id-fork", resumedSessionId: "id-orig" }),
    mk({ cell: "M7a", label: "T3a", model: MODELS.sonnet, thrown: { name: "Error", message: "forked id resume failed" } }),
    mk({ cell: "M7a", label: "T3b", model: MODELS.sonnet, response: n.n1, sessionId: "id-orig", resumedSessionId: "id-orig" }),
  ];
  const g = gradeCell(cellById("M7a"), recs, gopts("M7a"));
  assert.equal(g.grade, "DEGRADED");
  assert.ok(g.caveats.some((c) => c.includes("T3a") && c.includes("KPR-313")));
});

// 6. foreign-cell nonce in response => FAIL (wrong-session bleed) even in id-model cells
check("wrong-session bleed grades FAIL", () => {
  const foreign = noncesFor("M2", SEED).n1;
  const recs = happy("M7b", MODELS.sonnet, MODELS.sonnet);
  const n = noncesFor("M7b", SEED);
  recs[2] = { ...recs[2], responseText: `${n.n1} ${foreign}` };
  const g = gradeCell(cellById("M7b"), recs, gopts("M7b"));
  assert.equal(g.grade, "FAIL");
});

// 7-9. M8 fault-cell grading
function m8recs(mut?: (r: TurnRecord[]) => void): TurnRecord[] {
  const n = noncesFor("M8", SEED);
  const sid = "sess-M8";
  const recs = [
    mk({ cell: "M8", label: "T1", model: MODELS.sonnet, response: "OK", sessionId: sid }),
    mk({ cell: "M8", label: "T2", model: MODELS.bogus, thrown: { name: "Error", message: "model not found: claude-nonexistent-9" } }),
    mk({ cell: "M8", label: "T3", model: MODELS.sonnet, response: n.n1, sessionId: sid, resumedSessionId: sid }),
    mk({ cell: "M8", label: "P1", model: MODELS.sonnet, response: "OK", sessionId: "sess-M8-probe" }),
    mk({ cell: "M8", label: "P2", model: MODELS.sonnet, response: n.probe, sessionId: "sess-M8-probe", resumedSessionId: "sess-M8-probe" }),
  ];
  mut?.(recs);
  return recs;
}
check("M8 clean fault grades PASS", () => {
  const g = gradeCell(cellById("M8"), m8recs(), gopts("M8"));
  assert.equal(g.grade, "PASS");
});
check("M8 silent fallback grades DEGRADED", () => {
  const g = gradeCell(cellById("M8"), m8recs((r) => {
    r[1] = mk({ cell: "M8", label: "T2", model: MODELS.bogus, response: "whatever", observedModel: MODELS.sonnet });
  }), gopts("M8"));
  assert.equal(g.grade, "DEGRADED");
  assert.ok(g.caveats.some((c) => c.includes("SILENT FALLBACK")));
});
check("M8 broken probe grades FAIL (poisoning)", () => {
  const g = gradeCell(cellById("M8"), m8recs((r) => {
    r[4] = mk({ cell: "M8", label: "P2", model: MODELS.sonnet, thrown: { name: "Error", message: "boom" } });
  }), gopts("M8"));
  assert.equal(g.grade, "FAIL");
});

// 10. deriveRuling branches
const G = (id: string, grade: GradedCell["grade"], o?: Partial<GradedCell>): GradedCell => ({
  id, title: id, grade, caveats: grade === "DEGRADED" ? [`${id}: caveat`] : [], notes: [],
  optional: false, faultCell: false, ...o,
});
check("deriveRuling covers all branches", () => {
  const core = ["M1", "M2", "M3", "M4", "M5", "M6", "M7a", "M7b"];
  const allPass = core.map((c) => G(c, "PASS"));
  assert.equal(deriveRuling([...allPass, G("M8", "PASS", { faultCell: true })]).ruling, "SAFE");
  const oneDegraded = [G("M1", "PASS"), G("M2", "DEGRADED"), ...core.slice(2).map((c) => G(c, "PASS"))];
  const r2 = deriveRuling([...oneDegraded, G("M8", "PASS", { faultCell: true })]);
  assert.equal(r2.ruling, "SAFE-WITH-CONSTRAINTS");
  assert.ok(r2.constraints.length > 0);
  assert.equal(deriveRuling([...allPass, G("M8", "DEGRADED", { faultCell: true })]).ruling, "SAFE-WITH-CONSTRAINTS");
  assert.equal(deriveRuling([G("M1", "FAIL"), ...core.slice(1).map((c) => G(c, "PASS")), G("M8", "PASS", { faultCell: true })]).ruling, "UNSAFE");
  assert.equal(deriveRuling([...allPass, G("M8", "FAIL", { faultCell: true })]).ruling, "UNSAFE");
  // M9 never affects the ruling
  assert.equal(deriveRuling([...allPass, G("M9", "FAIL", { optional: true }), G("M8", "PASS", { faultCell: true })]).ruling, "SAFE");
});

// 11. buildSummary + run selection + provenance + final-attempt selection
check("buildSummary picks latest complete run and final attempts", () => {
  const mkRun = (runId: string, ts: string): TurnRecord[] =>
    ["M1", "M2", "M3", "M4", "M5", "M6", "M7a", "M7b", "M8"].flatMap((cellId) => {
      const cell = cellById(cellId);
      return cell.turns.map((t) =>
        mk({ cell: cellId, label: t.label, model: t.model, runId, ts, response: "x", sessionId: `s-${cellId}` }));
    });
  const older = mkRun("run-A", "2026-07-09T01:00:00Z");
  const newer = mkRun("run-B", "2026-07-09T02:00:00Z");
  const partial = mkRun("run-C", "2026-07-09T03:00:00Z").filter((r) => r.cell !== "M8"); // incomplete
  const all = [...older, ...newer, ...partial];
  assert.equal(latestCompleteRunId(all), "run-B");
  // final-attempt selection
  const retried = [
    mk({ cell: "M1", label: "T1", model: MODELS.sonnet, attempt: 1, runId: "run-R" }),
    mk({ cell: "M1", label: "T1", model: MODELS.sonnet, attempt: 2, runId: "run-R" }),
  ];
  assert.deepEqual(finalAttemptRecords(retried, "M1", "run-R").map((r) => r.attempt), [2]);
  const summary = buildSummary(newer, "run-B", "0.2.104-test", SEED);
  assert.equal(summary.runId, "run-B");
  assert.equal(summary.cells.length, 9);
  assert.equal(summary.cells[0].provenance.sourceJsonl, "evidence/M1.jsonl");
  assert.ok(["SAFE", "SAFE-WITH-CONSTRAINTS", "UNSAFE"].includes(summary.ruling));
});

// 12. buildSummary refuses incomplete runs (vacuous-ruling hazard)
check("buildSummary refuses incomplete runs", () => {
  const onlyM1 = cellById("M1").turns.map((t) =>
    mk({ cell: "M1", label: t.label, model: t.model, runId: "run-X", response: "x" }));
  assert.throws(() => buildSummary(onlyM1, "run-X", "0.2.104-test", SEED), /incomplete/);
});

// 13. new session id per resume => DEGRADED with chain-following caveat
check("new-id-per-resume grades DEGRADED with KPR-313 caveat", () => {
  const n = noncesFor("M1", SEED);
  const recs = [
    mk({ cell: "M1", label: "T1", model: MODELS.sonnet, response: "OK", sessionId: "id-1" }),
    mk({ cell: "M1", label: "T2", model: MODELS.sonnet, response: n.n1, sessionId: "id-2", resumedSessionId: "id-1" }),
    mk({ cell: "M1", label: "T3", model: MODELS.sonnet, response: `${n.n1} ${n.n2}`, sessionId: "id-3", resumedSessionId: "id-2" }),
  ];
  const g = gradeCell(cellById("M1"), recs, gopts("M1"));
  assert.equal(g.grade, "DEGRADED");
  assert.ok(g.caveats.some((c) => c.includes("chain-following")));
});

console.log(`selftest OK (${count} checks)`);
