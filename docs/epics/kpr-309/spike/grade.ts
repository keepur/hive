/**
 * KPR-310 spike — grading + mechanical ruling derivation (spec-pinned rules).
 * Pure functions over TurnRecord data. Throwaway harness. No imports from src/**.
 */
import type { CellSpec, TurnSpec } from "./cells.ts";
import { DEFAULT_SEED, noncesFor } from "./cells.ts";

/** One JSONL line = one turn attempt. Written by run-matrix.ts, consumed here and by summarize.ts. */
export interface TurnRecord {
  runId: string;
  seed: number;
  ts: string;
  cell: string;
  attempt: number;
  turnLabel: string;
  requestedModel: string;
  resumeOf: string | null;
  resumedSessionId: string | null;
  fork: boolean;
  /** Loggable options subset - no env, no server instances, no controller. */
  options: Record<string, unknown>;
  messageTypes: string[];
  apiKeySource: string | null;
  initSessionId: string | null;
  /** Verbatim SDK result message, or null if none arrived. */
  resultMessage: unknown;
  responseText: string;
  toolCalled: boolean;
  thrown: { name: string; message: string; stack?: string } | null;
  timedOut: boolean;
  wallMs: number;
  /** Only meaningful on switchBack turns: T3 started within the cache-TTL window of T1's end. */
  cacheWindowOk: boolean | null;
  nonceChecks: Array<{ key: string; value: string; relation: "expect" | "forbid" | "observe"; found: boolean }>;
}

export interface ModelUsageView {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface ResultView {
  subtype: string | null;
  isError: boolean;
  modelUsage: Record<string, ModelUsageView>;
  aggregateCacheRead: number;
  aggregateCacheCreation: number;
  totalCostUsd: number | null;
  numTurns: number | null;
  errors: string[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Structural narrowing of a verbatim result message (records round-trip through JSON). */
export function viewResult(raw: unknown): ResultView | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "result") return null;
  const modelUsage: Record<string, ModelUsageView> = {};
  if (r.modelUsage !== null && typeof r.modelUsage === "object") {
    for (const [k, v] of Object.entries(r.modelUsage as Record<string, unknown>)) {
      if (v !== null && typeof v === "object") {
        const m = v as Record<string, unknown>;
        modelUsage[k] = {
          cacheReadInputTokens: num(m.cacheReadInputTokens),
          cacheCreationInputTokens: num(m.cacheCreationInputTokens),
          inputTokens: num(m.inputTokens),
          outputTokens: num(m.outputTokens),
          costUSD: num(m.costUSD),
        };
      }
    }
  }
  const usage = (r.usage ?? {}) as Record<string, unknown>;
  return {
    subtype: typeof r.subtype === "string" ? r.subtype : null,
    isError: r.is_error === true,
    modelUsage,
    aggregateCacheRead: num(usage.cache_read_input_tokens),
    aggregateCacheCreation: num(usage.cache_creation_input_tokens),
    totalCostUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : null,
    numTurns: typeof r.num_turns === "number" ? r.num_turns : null,
    errors: Array.isArray(r.errors) ? r.errors.map((e) => String(e)) : [],
  };
}

export type Grade = "PASS" | "DEGRADED" | "FAIL";

export interface GradedCell {
  id: string;
  title: string;
  grade: Grade;
  /** Named caveats - these become the verdict's enumerated constraints (spec). */
  caveats: string[];
  notes: string[];
  optional: boolean;
  faultCell: boolean;
}

/** A per-model cache read below this counts as a miss. The fixed prefix is >=4-5k tokens, so a
 *  genuine hit reads well above this; SDK-internal small reads stay below it. */
export const CACHE_HIT_MIN = 1024;

function hardError(rec: TurnRecord, rv: ResultView | null): boolean {
  return (
    rec.thrown !== null ||
    rec.timedOut ||
    rv === null ||
    rv.subtype !== "success" ||
    rv.isError ||
    rv.errors.length > 0
  );
}

/** Spec-pinned FAIL-cap for id-model cells (M7a/M7b): failures on RESUMED turns (fork-T2, T3,
 *  T3a, T3b) grade DEGRADED with a named KPR-313 constraint, never FAIL - FAIL is reserved for
 *  wrong-session content bleed. T1 (fresh session) is not id-model behavior and stays FAIL-able. */
function idModelCapped(cell: CellSpec, spec: TurnSpec): boolean {
  return cell.idModelCell === true && spec.resumeOf !== null;
}

export interface GradeOptions {
  /** M1's T2 per-model cacheReadInputTokens - the baseline every cache caveat quotes. Null when grading M1 itself. */
  baselineT2CacheRead: number | null;
  /** Nonce values belonging to OTHER cells - any appearance in a response is wrong-session bleed => FAIL. */
  foreignNonces: string[];
}

/** Grade one cell from its final-attempt records (spec: "Grading per cell"). */
export function gradeCell(cell: CellSpec, turns: TurnRecord[], opts: GradeOptions): GradedCell {
  if (cell.faultCell) return gradeFaultCell(cell, turns, opts);
  const caveats: string[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  const nonces = noncesFor(cell.id, turns[0]?.seed ?? DEFAULT_SEED);
  const byLabel = new Map(turns.map((t) => [t.turnLabel, t]));

  for (const spec of cell.turns) {
    const rec = byLabel.get(spec.label);
    if (!rec) {
      if (idModelCapped(cell, spec)) {
        caveats.push(`${cell.id} ${spec.label}: no record - resumed turn never ran (chain broke) - KPR-313-binding constraint`);
      } else {
        failures.push(`${spec.label}: no record (chain broke earlier)`);
      }
      continue;
    }
    const rv = viewResult(rec.resultMessage);

    // Wrong-session bleed - FAIL in EVERY cell, including id-model cells (spec-pinned).
    for (const foreign of opts.foreignNonces) {
      if (rec.responseText.includes(foreign)) {
        failures.push(`${spec.label}: wrong-session content bleed - foreign nonce "${foreign}" in response`);
      }
    }

    if (hardError(rec, rv)) {
      const desc = rec.timedOut
        ? "timeout"
        : rec.thrown
          ? `thrown ${rec.thrown.name}: ${rec.thrown.message}`
          : `subtype=${rv?.subtype ?? "none"} errors=${JSON.stringify(rv?.errors ?? [])}`;
      if (idModelCapped(cell, spec)) {
        caveats.push(`${cell.id} ${spec.label}: id-model limitation - resumed turn failed (${desc}) - KPR-313-binding constraint`);
      } else {
        failures.push(`${spec.label}: unrecoverable error mid-chain (${desc})`);
      }
      continue;
    }
    // rv is non-null past hardError.
    const view = rv as ResultView;

    // Observed-model attribution - PASS-gate in EVERY cell (spec: silent substitution = FAIL).
    if (!(spec.model in view.modelUsage)) {
      failures.push(
        `${spec.label}: silent model substitution - requested ${spec.model}, modelUsage keys=[${Object.keys(view.modelUsage).join(", ")}]`,
      );
    } else {
      const extras = Object.keys(view.modelUsage).filter((k) => k !== spec.model);
      if (extras.length > 0) notes.push(`${spec.label}: extra modelUsage keys [${extras.join(", ")}]`);
    }

    // Continuity - exact nonce containment.
    for (const key of spec.expect) {
      if (!rec.responseText.includes(nonces[key])) {
        if (idModelCapped(cell, spec)) {
          caveats.push(`${cell.id} ${spec.label}: recall of "${key}" lost on resumed turn - KPR-313-binding constraint`);
        } else {
          failures.push(`${spec.label}: continuity broken - expected nonce "${key}" (${nonces[key]}) not in response`);
        }
      }
    }
    for (const key of spec.forbid ?? []) {
      if (rec.responseText.includes(nonces[key])) {
        // M7a T3b seeing the post-fork nonce: evidence, not FAIL (spec-pinned DEGRADED-with-caveat).
        caveats.push(`${cell.id} ${spec.label}: fork isolation violation - forbidden nonce "${key}" visible - KPR-313-binding constraint`);
      }
    }
    for (const key of spec.observe ?? []) {
      notes.push(`${spec.label}: observed nonce "${key}" ${rec.responseText.includes(nonces[key]) ? "VISIBLE" : "not visible"} (recorded invariant for KPR-313)`);
    }

    // Tool-call requirement (M6 T1).
    if (spec.requireToolCall && !rec.toolCalled) {
      failures.push(`${spec.label}: required MCP tool call did not occur`);
    }

    // Session-id chaining semantics.
    if (spec.resumeOf && rec.initSessionId && rec.resumedSessionId) {
      if (!spec.fork && rec.initSessionId !== rec.resumedSessionId) {
        caveats.push(`${cell.id} ${spec.label}: resume minted a new session id (chain-following required) - KPR-313-binding constraint`);
      }
      if (spec.fork && rec.initSessionId === rec.resumedSessionId) {
        caveats.push(`${cell.id} ${spec.label}: forkSession did NOT mint a new id - KPR-313-binding constraint`);
      }
    }

    // Cache behavior (material-cost caveats => DEGRADED, spec examples).
    const mu = view.modelUsage[spec.model];
    if (mu) {
      if (spec.label === "T2" && mu.cacheReadInputTokens < CACHE_HIT_MIN) {
        const base = opts.baselineT2CacheRead;
        caveats.push(
          `${cell.id} T2: prompt-cache miss on ${cell.id === "M1" ? "control resume" : "switch"} - cacheRead=${mu.cacheReadInputTokens}${base !== null ? ` vs M1 baseline ${base}` : ""}, creation=${mu.cacheCreationInputTokens}`,
        );
      }
      if (spec.switchBack) {
        if (rec.cacheWindowOk === false) {
          notes.push(`${spec.label}: cache-TTL window exceeded - T3 cache observation not valid`);
        } else if (mu.cacheReadInputTokens < CACHE_HIT_MIN) {
          caveats.push(
            `${cell.id} ${spec.label}: switch-back pays cache re-creation (cacheRead=${mu.cacheReadInputTokens}, creation=${mu.cacheCreationInputTokens}) - no cross-switch cache retention`,
          );
        }
      }
    }
  }

  const grade: Grade = failures.length > 0 ? "FAIL" : caveats.length > 0 ? "DEGRADED" : "PASS";
  if (failures.length > 0) notes.push(...failures.map((f) => `FAIL: ${f}`));
  return { id: cell.id, title: cell.title, grade, caveats, notes, optional: cell.optional === true, faultCell: false };
}

/**
 * M8 grading (spec: M8 is EXPECTED to fault; grades on whether the failure is CLEAN).
 * Grade encoding for the ruling derivation:
 *   PASS = clean fault; DEGRADED = non-clean but non-poisoning (named constraint for 312/313);
 *   FAIL = poisoning (post-fault probe on an unrelated session misbehaves).
 */
export function gradeFaultCell(cell: CellSpec, turns: TurnRecord[], opts: GradeOptions): GradedCell {
  const caveats: string[] = [];
  const notes: string[] = [];
  const nonces = noncesFor(cell.id, turns[0]?.seed ?? DEFAULT_SEED);
  const byLabel = new Map(turns.map((t) => [t.turnLabel, t]));
  const get = (l: string): TurnRecord | undefined => byLabel.get(l);

  let poisoning = false;
  let nonClean = false;

  // Bleed check applies here too.
  for (const rec of turns) {
    for (const foreign of opts.foreignNonces) {
      if (rec.responseText.includes(foreign)) {
        poisoning = true;
        notes.push(`${rec.turnLabel}: wrong-session content bleed - foreign nonce in response`);
      }
    }
  }

  // T1 must establish the baseline session.
  const t1 = get("T1");
  const t1v = t1 ? viewResult(t1.resultMessage) : null;
  if (!t1 || hardError(t1, t1v)) {
    nonClean = true;
    caveats.push("M8: could not establish fault-cell baseline session (T1 failed) - evidence incomplete");
  }

  // T2 - the fault observation.
  const t2 = get("T2");
  const t2v = t2 ? viewResult(t2.resultMessage) : null;
  if (!t2) {
    nonClean = true;
    caveats.push("M8 T2: no record - fault shape unobserved");
  } else if (t2.thrown) {
    notes.push(`M8 T2 fault shape: THROWN ${t2.thrown.name}: ${t2.thrown.message.slice(0, 500)}`);
  } else if (t2v && (t2v.subtype !== "success" || t2v.isError || t2v.errors.length > 0)) {
    notes.push(`M8 T2 fault shape: RESULT subtype=${t2v.subtype} errors=${JSON.stringify(t2v.errors).slice(0, 500)}`);
  } else if (t2v && t2v.subtype === "success") {
    // Bogus model "succeeded" - silent CLI-default fallback. Non-clean: masks a rejected switch.
    nonClean = true;
    caveats.push(
      `M8 T2: SILENT FALLBACK - bogus model returned success, modelUsage keys=[${Object.keys(t2v.modelUsage).join(", ")}] - masks rejected switches; constraint for KPR-312`,
    );
  } else {
    nonClean = true;
    caveats.push("M8 T2: no result message and no thrown error - fault shape unclassifiable; constraint for KPR-312");
  }

  // T3 - original session must still be resumable and recall n1.
  const t3 = get("T3");
  const t3v = t3 ? viewResult(t3.resultMessage) : null;
  if (!t3 || hardError(t3, t3v) || !t3.responseText.includes(nonces.n1)) {
    nonClean = true;
    caveats.push("M8 T3: original session NOT cleanly resumable after the fault - constraint for KPR-312/KPR-313");
  }

  // Probe - poisoning detector (fresh unrelated session after the fault).
  const p2 = get("P2");
  const p2v = p2 ? viewResult(p2.resultMessage) : null;
  const p1 = get("P1");
  const p1v = p1 ? viewResult(p1.resultMessage) : null;
  if (!p1 || hardError(p1, p1v) || !p2 || hardError(p2, p2v) || !p2.responseText.includes(nonces.probe)) {
    poisoning = true;
    notes.push("M8 probe: post-fault fresh-session chain misbehaved - poisoning per ruling derivation");
  }

  const grade: Grade = poisoning ? "FAIL" : nonClean ? "DEGRADED" : "PASS";
  return { id: cell.id, title: cell.title, grade, caveats, notes, optional: false, faultCell: true };
}

export type Ruling = "SAFE" | "SAFE-WITH-CONSTRAINTS" | "UNSAFE";

/** Mechanical ruling derivation (spec-pinned, exhaustive). M9 (optional) never affects it. */
export function deriveRuling(graded: GradedCell[]): { ruling: Ruling; constraints: string[] } {
  const core = graded.filter((g) => !g.optional && !g.faultCell); // M1-M7b
  const m8 = graded.find((g) => g.faultCell) ?? null;
  const constraints = [
    ...core.filter((g) => g.grade === "DEGRADED").flatMap((g) => g.caveats),
    ...(m8 && m8.grade === "DEGRADED" ? m8.caveats : []),
  ];
  if (core.some((g) => g.grade === "FAIL") || (m8 !== null && m8.grade === "FAIL")) {
    return { ruling: "UNSAFE", constraints };
  }
  if (core.every((g) => g.grade === "PASS") && m8 !== null && m8.grade === "PASS") {
    return { ruling: "SAFE", constraints: [] };
  }
  return { ruling: "SAFE-WITH-CONSTRAINTS", constraints };
}
