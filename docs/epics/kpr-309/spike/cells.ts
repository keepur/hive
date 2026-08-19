/**
 * KPR-310 spike — the empirical matrix as data (spec: "Empirical question matrix").
 * Throwaway harness. No imports from src/**.
 */
import { nonceFrom } from "./rng.ts";

/** Spec-pinned model ids (mirrors TIER_MODELS in src/agents/model-router.ts:46-50 BY VALUE - never imported). */
export const MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
  bogus: "claude-nonexistent-9",
} as const;

/** Default nonce seed - single source of truth (CLI --seed overrides). */
export const DEFAULT_SEED = 310;

/** Fixed secret word returned by the M6 in-process MCP tool. */
export const SECRET_WORD = "marmalade-quintet-77";
export const TOOL_NAME = "get_secret_word";
export const MCP_SERVER_NAME = "spike";
export const MCP_TOOL_FULL_NAME = `mcp__${MCP_SERVER_NAME}__${TOOL_NAME}`;

export type NonceKey = "n1" | "n2" | "probe" | "sw";
export type Nonces = Record<NonceKey, string>;

/** Deterministic per-cell nonces. "sw" is the constant secret word so checks are uniform. */
export function noncesFor(cellId: string, seed: number): Nonces {
  return {
    n1: nonceFrom(`${cellId}:n1`, seed),
    n2: nonceFrom(`${cellId}:n2`, seed),
    probe: nonceFrom(`${cellId}:probe`, seed),
    sw: SECRET_WORD,
  };
}

export interface TurnSpec {
  /** Turn label - unique within the cell (T1, T2, T3, T3a, T3b, P1, P2). */
  label: string;
  model: string;
  /** Label of the earlier turn whose RETURNED session id this turn resumes; null = fresh session. */
  resumeOf: string | null;
  /** Pass forkSession: true (M7a T2). */
  fork?: boolean;
  prompt: (n: Nonces) => string;
  /** Nonce keys whose values MUST appear verbatim in the response (continuity PASS-gate). */
  expect: readonly NonceKey[];
  /** Nonce keys whose values must NOT appear (M7a T3b fork isolation - DEGRADED-not-FAIL on violation). */
  forbid?: readonly NonceKey[];
  /** Nonce keys whose presence is recorded but not graded (M7b T3: is n2 visible? either answer is the invariant). */
  observe?: readonly NonceKey[];
  /** This turn is the switch-back cache observation (T3 of M2-M6) - cache-TTL window enforced. */
  switchBack?: boolean;
  /** Attach the in-process MCP server (M6: all three turns). */
  withTool?: boolean;
  /** The turn must actually invoke the MCP tool (M6 T1). */
  requireToolCall?: boolean;
  /** M8 T2: a fault here is the expected observation - never triggers cell retry. */
  faultExpected?: boolean;
  /** M9: request thinking: { type: "adaptive" }. */
  adaptiveThinking?: boolean;
}

export interface CellSpec {
  id: string;
  title: string;
  turns: readonly TurnSpec[];
  /** M9: informative only - excluded from the ruling derivation. */
  optional?: boolean;
  /** M8: graded on clean-fault criteria, not the standard PASS rules. */
  faultCell?: boolean;
  /** M7a/M7b: id-model cells - failures on RESUMED turns grade DEGRADED with KPR-313 caveat, never
   *  FAIL (FAIL reserved for wrong-session content bleed). Spec-pinned. */
  idModelCell?: boolean;
}

// Fixed prompt strings (spec: "Prompts are fixed strings checked into the harness so runs are comparable").
const P_T1 = (n: Nonces): string => `Remember the code phrase: ${n.n1}. Reply with exactly: OK`;
const P_T2 = (n: Nonces): string =>
  `Remember a second code phrase: ${n.n2}. What was the first code phrase? Reply with the first code phrase only.`;
const P_T3 = (): string =>
  `What were both code phrases? Reply with both code phrases in order, separated by a single space.`;
const P_LIST = (): string =>
  `List every code phrase you have been told in this conversation, separated by single spaces.`;

/** Standard 3-turn A->B->A chain (M1-M5, M9). */
function standardChain(a: string, b: string, adaptiveOnA = false): TurnSpec[] {
  const isSwitch = a !== b;
  return [
    { label: "T1", model: a, resumeOf: null, prompt: P_T1, expect: [], adaptiveThinking: adaptiveOnA },
    { label: "T2", model: b, resumeOf: "T1", prompt: P_T2, expect: ["n1"] },
    {
      label: "T3", model: a, resumeOf: "T2", prompt: P_T3, expect: ["n1", "n2"],
      switchBack: isSwitch, adaptiveThinking: adaptiveOnA,
    },
  ];
}

export function buildCells(withM9: boolean): CellSpec[] {
  const { haiku, sonnet, opus, bogus } = MODELS;
  const cells: CellSpec[] = [
    { id: "M1", title: "control: sonnet->sonnet->sonnet", turns: standardChain(sonnet, sonnet) },
    { id: "M2", title: "router downshift: sonnet->haiku->sonnet", turns: standardChain(sonnet, haiku) },
    { id: "M3", title: "router upshift: haiku->sonnet->haiku", turns: standardChain(haiku, sonnet) },
    { id: "M4", title: "ceiling pair: sonnet->opus->sonnet", turns: standardChain(sonnet, opus) },
    { id: "M5", title: "max distance: opus->haiku->opus", turns: standardChain(opus, haiku) },
    {
      id: "M6",
      title: "tool-state carryover: sonnet->haiku->sonnet with in-process MCP tool",
      turns: [
        {
          label: "T1", model: sonnet, resumeOf: null, withTool: true, requireToolCall: true,
          prompt: (n) =>
            `Call the ${TOOL_NAME} tool now. Then remember the code phrase: ${n.n1}. Reply with exactly the word the tool returned.`,
          expect: ["sw"],
        },
        { label: "T2", model: haiku, resumeOf: "T1", withTool: true, prompt: P_T2, expect: ["n1"] },
        {
          label: "T3", model: sonnet, resumeOf: "T2", withTool: true, switchBack: true,
          prompt: () =>
            `What word did the ${TOOL_NAME} tool return earlier, and what were both code phrases? Reply with the tool word followed by both code phrases, separated by single spaces.`,
          expect: ["sw", "n1", "n2"],
        },
      ],
    },
    {
      id: "M7a",
      title: "fork semantics: sonnet chain with forkSession on T2",
      idModelCell: true,
      turns: [
        { label: "T1", model: sonnet, resumeOf: null, prompt: P_T1, expect: [] },
        { label: "T2", model: sonnet, resumeOf: "T1", fork: true, prompt: P_T2, expect: ["n1"] },
        { label: "T3a", model: sonnet, resumeOf: "T2", prompt: P_T3, expect: ["n1", "n2"] },
        { label: "T3b", model: sonnet, resumeOf: "T1", prompt: P_LIST, expect: ["n1"], forbid: ["n2"] },
      ],
    },
    {
      id: "M7b",
      title: "stale-id resume: plain sonnet chain, T3 resumes T1's superseded id",
      idModelCell: true,
      turns: [
        { label: "T1", model: sonnet, resumeOf: null, prompt: P_T1, expect: [] },
        { label: "T2", model: sonnet, resumeOf: "T1", prompt: P_T2, expect: ["n1"] },
        { label: "T3", model: sonnet, resumeOf: "T1", prompt: P_LIST, expect: ["n1"], observe: ["n2"] },
      ],
    },
  ];
  if (withM9) {
    cells.push({
      id: "M9",
      title: "OPTIONAL informative: opus+adaptive-thinking->haiku->opus",
      optional: true,
      turns: standardChain(opus, haiku, true),
    });
  }
  // M8 runs LAST so its post-fault probe (P1/P2 - the poisoning observable) is the final API activity.
  cells.push({
    id: "M8",
    title: "fault cell: sonnet->bogus->sonnet + post-fault probe",
    faultCell: true,
    turns: [
      { label: "T1", model: MODELS.sonnet, resumeOf: null, prompt: P_T1, expect: [] },
      { label: "T2", model: bogus, resumeOf: "T1", faultExpected: true, prompt: P_T2, expect: [] },
      {
        label: "T3", model: MODELS.sonnet, resumeOf: "T1",
        prompt: () => `What was the first code phrase? Reply with the first code phrase only.`,
        expect: ["n1"],
      },
      // Post-fault probe: fresh unrelated session - detects M8 "poisoning" per the ruling derivation.
      {
        label: "P1", model: MODELS.sonnet, resumeOf: null,
        prompt: (n) => `Remember the code phrase: ${n.probe}. Reply with exactly: OK`,
        expect: [],
      },
      {
        label: "P2", model: MODELS.sonnet, resumeOf: "P1",
        prompt: () => `What was the code phrase? Reply with the code phrase only.`,
        expect: ["probe"],
      },
    ],
  });
  return cells;
}

/** All nonce values belonging to OTHER cells (for wrong-session bleed detection). Excludes the shared secret word. */
export function foreignNoncesFor(cellId: string, seed: number, cells: readonly CellSpec[]): string[] {
  const out: string[] = [];
  for (const c of cells) {
    if (c.id === cellId) continue;
    const n = noncesFor(c.id, seed);
    out.push(n.n1, n.n2, n.probe);
  }
  return out;
}
