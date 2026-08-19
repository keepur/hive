# KPR-310 — Implementation Plan: Spike harness for per-turn model switching on non-streaming resume (W3.1)

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** `docs/epics/kpr-309/kpr-310-spec.md` (authoritative protocol — this plan repeats its pinned decisions; it never re-decides them).
**Epic:** KPR-309 (pre-register epic — no Decision Register canon section; W2 canon R3/R7 from branch `kpr-305` @ `af74cf7` binds where relevant).
**Dispensations:** D1 (spike runs during maturity; throwaway harness only, no production code, verdict on epic branch), D3 (Claude Agent SDK path only).
**Worktree:** `/Users/mokie/github/kpr-310-mature` (branched off epic branch `kpr-309`; both == main @ `f147477`). All paths below are relative to this worktree root unless absolute.

## Goal

Run a throwaway 9-cell empirical matrix that characterizes `query({ resume, model })` model switching on the Claude Agent SDK, and produce the mechanical SAFE / SAFE-WITH-CONSTRAINTS / UNSAFE verdict at `docs/epics/kpr-309/kpr-310-verdict.md` that gates KPR-311/312/313.

## Architecture

A self-contained TypeScript harness at `docs/epics/kpr-309/spike/` (outside tsconfig/eslint/vitest/prettier scope — verified: `tsconfig.json` includes `src/**` only, `lint` covers `src/ setup/`, vitest includes `src|plugins|setup|scripts`, prettier covers `src|setup` and ignores `*.md`). It imports only `@anthropic-ai/claude-agent-sdk` (from repo `node_modules`) and Node stdlib — **zero imports from `src/**`** (D1 + R3 line). `run-matrix.ts` drives serial 3–5-turn chains per cell, writes per-turn evidence to gitignored `evidence/<cell>.jsonl`, and writes the committed `evidence/summary.json` only at full-matrix completion (or `--summarize` regeneration; the builder refuses incomplete runs). Post-abort recovery is first-class: `--cell <id> --run <runId>` appends the missing cell's evidence under the aborted run's id. Pure grading/derivation logic lives in `grade.ts`/`summarize.ts` and is unit-tested by an SDK-free `selftest.ts`.

## Tech Stack

- TypeScript (strict), run via `npx tsx` (repo devDep `tsx@^4.19.0`; repo is `"type": "module"`)
- `@anthropic-ai/claude-agent-sdk` `^0.2.63` from repo `node_modules` (dev checkout resolves 0.2.104; verdict pins whatever resolves)
- Node stdlib only otherwise (`node:fs`, `node:path`, `node:os`, `node:assert/strict`)
- No local `package.json` in the spike dir — the spec pins invocation as `npx tsx docs/epics/kpr-309/spike/run-matrix.ts` from the worktree root after `npm install`
- Auth: operator's Anthropic subscription via the logged-in `claude` CLI. The harness sets no `ANTHROPIC_API_KEY` and never touches `CLAUDE_CONFIG_DIR` (KPR-201 lesson)

---

## Testing Contract

### Required Test Groups

**Unit — `required`**
- **Scope:** the harness's own evidence-integrity logic: `gradeCell` (all three grades, the every-cell observed-model PASS-gate, the M7a/M7b DEGRADED-not-FAIL cap on all RESUMED turns including T3a and fork-T2, wrong-session bleed → FAIL), `gradeFaultCell` (clean / non-clean / poisoning), `deriveRuling` (all branches of the mechanical derivation), and `buildSummary` (run-id selection, provenance, final-attempt selection, **refusal of incomplete runs**).
- **Reason:** the committed `summary.json` and the verdict's ruling are derived mechanically from these functions; a bug here corrupts the deliverable silently. They are pure functions over plain records — cheap to test without the API.
- **Harness:** `docs/epics/kpr-309/spike/selftest.ts` using `node:assert/strict`, run with `npx tsx docs/epics/kpr-309/spike/selftest.ts`. (Deliberately NOT a vitest file: vitest's include globs don't cover `docs/`, and widening them would be a production-config change D1 forbids.)
- **Minimum assertions (13):** (1) all-clean switch cell → PASS; (2) T2 cache-read below threshold → DEGRADED with named cache caveat; (3) requested model absent from `modelUsage` keys → FAIL (silent substitution); (4) M7b T3 hard error → DEGRADED with KPR-313 caveat, not FAIL; (5) **M7a T3a hard error → DEGRADED (id-model cap), not FAIL**; (6) foreign-cell nonce in a response → FAIL (bleed); (7) M8 clean fault → PASS-equivalent (clean); (8) M8 silent-fallback → DEGRADED (non-clean); (9) M8 broken probe → FAIL (poisoning); (10) `deriveRuling`: SAFE, SWC-via-DEGRADED, SWC-via-M8-non-clean, UNSAFE-via-FAIL, UNSAFE-via-poisoning, M9-never-affects-ruling; (11) `buildSummary` picks the latest complete run and stamps provenance + graded attempt; (12) **`buildSummary` throws on an incomplete run (vacuous-ruling hazard)**; (13) new-session-id-per-resume → DEGRADED with chain-following caveat.

**Integration — `required`**
- **Scope:** the matrix run itself against the live API — that IS the spike. Gate sequence: `--cell M1` smoke first (also the spec's cache-validity gate: M1-T2 must show nonzero per-model `cacheReadInputTokens`), then the full matrix.
- **Reason:** the empirical answers only exist in live SDK behavior.
- **Harness:** `run-matrix.ts` (retry-once-on-any-failure **including continuity misses**, 120s per-turn timeout, serial cells, M1-first gate, `--cell <id> --run <runId>` post-abort recovery — all automated in the runner per spec).
- **Minimum assertions (automated in-runner):** M1 gate passes before M2+ runs (gate failure exits nonzero in both `--cell` and full-matrix modes); every cell's final attempt has a recorded outcome for every turn; `summary.json` written only when every required cell has final-attempt records; total run within bounds (≈≤40 SDK turns nominal, <$5 API-equivalent, <30 min).

**E2E — `not-required`**
- **Scope/Reason:** none — throwaway spike with no user-facing flow, no channel, no production surface.

### Critical Flows
1. Full matrix run → committed `evidence/summary.json` with per-cell grades + mechanical ruling.
2. `--cell <id>` partial rerun → writes that cell's `.jsonl` evidence, **never** touches `summary.json`; with `--run <runId>` it appends under an existing run id (post-abort recovery).
3. `--summarize [--run <id>]` → regenerates `summary.json` wholesale from `.jsonl` files; **refuses** (exit 1, no file written) if any required cell lacks final-attempt records for that run.
4. Verdict authored from `summary.json` + spec template, ruling matching `deriveRuling` output.

### Regression Surface
**None in `src/`** — no production code is touched (D1). `docs/` is outside every `npm run check` gate (typecheck `src/**`, eslint `src/ setup/`, prettier `src|setup` + `*.md` ignored, vitest `src|plugins|setup|scripts`). The plan still verifies `npm run check` passes once on the branch (Task 1) and again at the end (Task 11) to prove the spike changed nothing gated.

### Commands
```bash
npm install                                                        # once, worktree has no node_modules
npx tsx docs/epics/kpr-309/spike/selftest.ts                       # unit tests (no API)
npx tsc --noEmit --strict --target es2022 --module esnext \
  --moduleResolution bundler --allowImportingTsExtensions \
  --skipLibCheck docs/epics/kpr-309/spike/*.ts                     # strict-TS gate for the spike (docs/ is outside tsconfig)
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --plan              # dry: prints matrix, no API calls
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --cell M1           # smoke + cache-validity gate (live, ~3 turns)
npx tsx docs/epics/kpr-309/spike/run-matrix.ts                     # full matrix (live)
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --cell M4 --run <runId>   # post-abort: rerun one cell under the aborted run id
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --summarize [--run <id>]  # regenerate summary.json from .jsonl
npm run check                                                      # must stay green (spike is out of scope, proves D1)
```

### Harness Requirements
- `selftest.ts` imports only `grade.ts`, `summarize.ts`, `cells.ts`, `rng.ts`, and `node:assert/strict` — runnable offline.
- `run-matrix.ts` is the only file that calls the API; it requires subscription auth (re-auth interactively if the smoke run reports auth failure).

### Non-Required Rationale
E2E: the harness is the deliverable's instrument, not a product; there is no user flow to exercise beyond the integration run itself.

### Verification Rules
1. A missing harness is not a skip reason — if `selftest.ts` or the runner doesn't exist yet at a task's Verify step, build it; do not mark the task done without running the listed commands.
2. When a test fails, fix the implementation, not the test — unless the test contradicts the spec's pinned grading/derivation rules, in which case the spec wins.
3. Spec/plan mismatch demotes to the spec lane: if executing this plan surfaces a conflict with `kpr-310-spec.md`, the spec is authoritative; note the deviation in the verdict's stated-reason discipline (spec: deviations from the mechanical derivation require a stated reason).

---

## File Structure

All new files. Nothing under `src/` is created or modified.

| File | Responsibility |
|---|---|
| `docs/epics/kpr-309/spike/README.md` | Throwaway warning + one-command run instructions + flag reference |
| `docs/epics/kpr-309/spike/.gitignore` | Ignore `evidence/*` except committed `evidence/summary.json` |
| `docs/epics/kpr-309/spike/rng.ts` | Seeded PRNG (mulberry32) + deterministic nonce derivation |
| `docs/epics/kpr-309/spike/prefix.ts` | Fixed, deterministic ≥4k-token system prompt (cache-measurable prefix), self-asserting size |
| `docs/epics/kpr-309/spike/cells.ts` | The matrix as data: models, `DEFAULT_SEED`, cell/turn specs M1–M9, fixed prompt strings, per-cell nonces |
| `docs/epics/kpr-309/spike/grade.ts` | `TurnRecord` type, result-view narrowing, per-cell grading (with the id-model FAIL-cap), fault-cell grading, mechanical ruling derivation — pure functions |
| `docs/epics/kpr-309/spike/summarize.ts` | Build `summary.json` content from turn records (in-memory or parsed from `.jsonl`); refuses incomplete runs — pure + small helpers |
| `docs/epics/kpr-309/spike/selftest.ts` | Offline unit tests for grade/summarize via `node:assert/strict` (13 checks) |
| `docs/epics/kpr-309/spike/run-matrix.ts` | Chain runner: `query()` invocation, session-id capture, 120s timeout, retry-once (incl. continuity misses), serial cells, M1 validity gate, evidence writing, CLI (`--cell [--run]/--seed/--summarize [--run]/--with-m9/--plan`) |
| `docs/epics/kpr-309/spike/evidence/summary.json` | Committed evidence digest — produced by the full-matrix run (Task 9), not hand-written |
| `docs/epics/kpr-309/kpr-310-verdict.md` | The verdict, from the spec's template — authored ONLY after the full matrix run (Task 10) |

---

## Tasks

### Task 1 — Scaffold: deps, spike dir, README, .gitignore, baseline check

**Files:** `docs/epics/kpr-309/spike/README.md`, `docs/epics/kpr-309/spike/.gitignore`

**Steps:**

- [ ] From the worktree root, install deps and confirm the SDK resolves (the worktree has no `node_modules` yet):

```bash
cd /Users/mokie/github/kpr-310-mature
npm install
npm ls @anthropic-ai/claude-agent-sdk
```

- [ ] Record the resolved SDK version from the `npm ls` output — it goes verbatim into `summary.json` (automated) and the verdict (Task 10).

- [ ] Run the baseline gate once to prove the branch starts green:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

- [ ] Create `docs/epics/kpr-309/spike/.gitignore`:

```gitignore
evidence/*
!evidence/summary.json
```

- [ ] Create `docs/epics/kpr-309/spike/README.md`:

```markdown
# KPR-310 throwaway spike harness — not production code, do not import.

Empirical matrix for per-turn model switching on non-streaming `query({ resume, model })`.
Protocol: `../kpr-310-spec.md`. Output verdict: `../kpr-310-verdict.md`.

## Run (from the worktree root, after `npm install`)

    npx tsx docs/epics/kpr-309/spike/run-matrix.ts

Flags:
- `--plan`                 print the matrix (cells, turns, models, prompts) — no API calls
- `--cell M2 [--run <id>]` run one cell only (writes its `.jsonl`; NEVER writes summary.json).
                           With `--run`, append under an EXISTING run id — the post-abort
                           recovery path (seed is adopted from that run for nonce comparability)
- `--seed 310`             nonce seed (default 310; fixed prompts + seeded nonces keep runs comparable)
- `--with-m9`              include optional informative cell M9 (adaptive-thinking interaction)
- `--summarize [--run <id>]` regenerate `evidence/summary.json` wholesale from existing `.jsonl`
                           files (default: latest COMPLETE run). Refuses incomplete runs.

## Evidence discipline (spec-pinned)
- Raw per-turn JSONL: `evidence/<cell>.jsonl` — gitignored, stays local. Both retry attempts recorded.
- `evidence/summary.json` — the ONLY committed artifact. Written at full-matrix completion or by
  `--summarize`; partial `--cell` runs never touch it; the builder refuses runs missing any
  required cell (vacuous-ruling hazard).
- Cache-validity gate: M1 runs first; its T2 must show nonzero per-model `cacheReadInputTokens`
  or the run aborts nonzero (enlarge `prefix.ts`, restart the full matrix).

## Post-abort recovery
1. Note the aborted run's id (printed at start, embedded in every .jsonl line).
2. Rerun each missing/failed cell: `npx tsx docs/epics/kpr-309/spike/run-matrix.ts --cell M4 --run <runId>`
3. Regenerate: `npx tsx docs/epics/kpr-309/spike/run-matrix.ts --summarize --run <runId>`

## Auth & isolation
- Subscription auth via the logged-in `claude` CLI. No `ANTHROPIC_API_KEY` is set by the harness.
  Do NOT set `CLAUDE_CONFIG_DIR` (breaks auth + sessions — KPR-201).
- Every `query()` runs with `cwd` = an isolated scratch dir under the OS tmpdir, so SDK session
  files land in a dedicated `~/.claude/projects/` slot. The harness never touches hive code or
  hive's Mongo `agent_sessions` store.

## Selftest (offline, no API)

    npx tsx docs/epics/kpr-309/spike/selftest.ts
```

**Verify:**

```bash
npm ls @anthropic-ai/claude-agent-sdk        # prints one resolved version, e.g. 0.2.104 — no errors
ls docs/epics/kpr-309/spike/                 # README.md  .gitignore
```
`npm run check` (baseline step) exits 0.

**Commit:** `KPR-310: spike scaffold — README + evidence gitignore`

---

### Task 2 — Deterministic RNG + cache-measurable fixed prefix

**Files:** `docs/epics/kpr-309/spike/rng.ts`, `docs/epics/kpr-309/spike/prefix.ts`

**Steps:**

- [ ] Create `docs/epics/kpr-309/spike/rng.ts`:

```typescript
/**
 * KPR-310 spike — seeded PRNG + deterministic nonce derivation.
 * Throwaway harness (see README). No imports from src/**.
 */

/** mulberry32 — small deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a fold of a tag string into a 32-bit seed. */
export function hashTag(tag: string, seed: number): number {
  let h = seed >>> 0 || 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) {
    h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic 8-char nonce for a (tag, seed) pair. Unambiguous alphabet (no 0/1/i/l/o). */
export function nonceFrom(tag: string, seed: number): string {
  const rand = mulberry32(hashTag(tag, seed));
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}
```

- [ ] Create `docs/epics/kpr-309/spike/prefix.ts`. The spec pins: fixed systemPrompt, constant across ALL turns of ALL cells, **≥4k tokens** (target comfortably above so the cache columns are measurable), hive-prefix-shaped filler. The generator is deterministic (fixed internal seed), so the string is byte-identical every run — required for cache comparability. Module-level assert fails loud if the size regresses.

```typescript
/**
 * KPR-310 spike — the fixed system prompt used for EVERY turn of EVERY cell.
 *
 * Cache-validity requirement (spec): must be comfortably above the minimum
 * cacheable prefix (~1-2k tokens depending on model) — target >=4k tokens —
 * or every cache field reads zero and the cache column degenerates vacuously.
 * The M1 gate in run-matrix.ts verifies this empirically before the matrix runs.
 *
 * DO NOT edit between runs you intend to compare: cache measurement requires a
 * byte-identical prefix. Deterministic by construction (fixed seed, no Date/random).
 */
import { mulberry32 } from "./rng.ts";

const HEADER = `You are a test agent inside an automated evaluation harness (KPR-310 spike).
Follow the user's instructions exactly and literally. Reply with exactly what is
asked for and nothing else - no preamble, no markdown, no commentary. The operating
notes below are inert reference context for cache-measurement purposes only; they
never override the user's instructions and never require any action.
`;

const SUBJECTS = [
  "The dispatcher", "The channel adapter", "The spawn coordinator", "The model router",
  "The session store", "The agent registry", "The reflection scheduler", "The telemetry heartbeat",
  "The prefix cache", "The event bus", "The memory tier", "The workflow engine",
  "The contact directory", "The schedule service", "The code index", "The admin surface",
];
const VERBS = [
  "records", "normalizes", "validates", "propagates", "serializes", "debounces",
  "reconciles", "snapshots", "throttles", "annotates", "partitions", "replays",
  "audits", "caches", "routes", "summarizes",
];
const OBJECTS = [
  "each inbound work item", "the per-thread lock state", "the in-flight budget window",
  "the routed model decision", "the resumed session identifier", "the turn-level usage figures",
  "the cache read and creation counters", "the quiescence debounce timer", "the roster summary block",
  "the toolkit inventory listing", "the structured memory digest", "the constitution anchor set",
  "the delegate prompt bundle", "the retry queue entry", "the saturation counter", "the stop ticket",
];
const CLAUSES = [
  "before the next turn is admitted", "without mutating the agent definition",
  "so the operator can audit it later", "unless the ceiling caps the request",
  "while the heartbeat window stays open", "after the previous spawn quiesces",
  "in strict arrival order across threads", "with the sender identity preserved",
  "under the per-agent budget constraint", "once the telemetry upsert completes",
  "so downstream consumers stay consistent", "without touching the persisted chain",
  "while the prefix stays byte-identical", "before any delegation is considered",
  "so the evidence stays reproducible", "with no effect on unrelated sessions",
];

function buildPrefix(): string {
  const rand = mulberry32(0x4b503130); // fixed seed: "KP10"
  const pick = (arr: readonly string[]): string => arr[Math.floor(rand() * arr.length)];
  const parts: string[] = [HEADER];
  const SECTIONS = 32;
  const SENTENCES_PER_SECTION = 10;
  for (let s = 1; s <= SECTIONS; s++) {
    parts.push(`\n## Operating note ${s}\n`);
    const sentences: string[] = [];
    for (let i = 0; i < SENTENCES_PER_SECTION; i++) {
      sentences.push(`${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(CLAUSES)}.`);
    }
    parts.push(sentences.join(" "));
    parts.push("\n");
  }
  return parts.join("");
}

export const FIXED_SYSTEM_PROMPT: string = buildPrefix();

/** chars/4 heuristic — the empirical M1 gate is authoritative; this catches gross regressions. */
export function estimatedPrefixTokens(): number {
  return Math.ceil(FIXED_SYSTEM_PROMPT.length / 4);
}

// Fail loud at import time if the prefix shrinks below the measurable floor.
// Target is >=4k tokens (spec); we assert an estimate of >=5000 for margin.
if (estimatedPrefixTokens() < 5000) {
  throw new Error(
    `prefix.ts: estimated prefix tokens ${estimatedPrefixTokens()} < 5000 - enlarge SECTIONS in buildPrefix()`,
  );
}
```

**Verify:**

```bash
npx tsx -e "import('./docs/epics/kpr-309/spike/prefix.ts').then(m => { console.log('est tokens:', m.estimatedPrefixTokens()); console.log('len:', m.FIXED_SYSTEM_PROMPT.length); })"
# Expected: "est tokens: <N>" with N >= 5000, no throw.
npx tsx -e "import('./docs/epics/kpr-309/spike/prefix.ts').then(async m => { const c = await import('node:crypto'); console.log(c.createHash('sha256').update(m.FIXED_SYSTEM_PROMPT).digest('hex').slice(0,16)); })"
# Run the hash command TWICE - identical output both times (byte-determinism).
```

**Commit:** `KPR-310: spike rng + fixed >=4k-token cache prefix`

---

### Task 3 — The matrix as data (`cells.ts`)

**Files:** `docs/epics/kpr-309/spike/cells.ts`

**Steps:**

- [ ] Create `docs/epics/kpr-309/spike/cells.ts`. Everything here is spec-pinned: the model ids (spec / `model-router.ts:46-50`), the 3-turn chain protocol and prompt shapes, M6's in-process tool, M7a's four turns, M7b's stale-id T3, M8's bogus id `claude-nonexistent-9`, and optional M9. The M8 post-fault probe (P1/P2) is the mechanical observable for the spec's "M8 poisoning" ruling input ("later valid-model resumes of unrelated sessions misbehave") — a fresh 2-turn sonnet chain run immediately after M8's T3. `DEFAULT_SEED` is the single source of truth for the nonce seed.

```typescript
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
```

**Verify:**

```bash
npx tsx -e "import('./docs/epics/kpr-309/spike/cells.ts').then(m => { const cs = m.buildCells(true); console.log(cs.map(c => c.id + ':' + c.turns.length + 'T').join(' ')); console.log('M2 nonces @' + m.DEFAULT_SEED + ':', JSON.stringify(m.noncesFor('M2', m.DEFAULT_SEED))); })"
# Expected: "M1:3T M2:3T M3:3T M4:3T M5:3T M6:3T M7a:4T M7b:3T M9:3T M8:5T"
# and a stable nonce object - run twice, identical output (determinism).
```

**Commit:** `KPR-310: spike matrix cells M1-M9 as data`

---

### Task 4 — Grading + ruling derivation (`grade.ts`)

**Files:** `docs/epics/kpr-309/spike/grade.ts`

**Steps:**

- [ ] Create `docs/epics/kpr-309/spike/grade.ts`. This encodes the spec's grading rules and mechanical ruling derivation exactly (spec: "Grading per cell" + "Overall ruling derivation"). Pure functions — no fs, no SDK. The `idModelCapped` helper implements the spec's FAIL-cap for M7a/M7b: **every RESUMED turn** (fork-T2, T3, T3a, T3b) that hard-errors or loses recall grades DEGRADED with a named KPR-313 constraint — FAIL in those cells is reserved for wrong-session content bleed. T1 (fresh session) stays FAIL-able because its failure is not id-model behavior.

```typescript
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
```

**Verify:**

```bash
npx tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck docs/epics/kpr-309/spike/*.ts
# Expected: exit 0, no output.
```

**Commit:** `KPR-310: spike grading + mechanical ruling derivation`

---

### Task 5 — Summary builder (`summarize.ts`)

**Files:** `docs/epics/kpr-309/spike/summarize.ts`

**Steps:**

- [ ] Create `docs/epics/kpr-309/spike/summarize.ts`. Spec-pinned `summary.json` shape: header `{runId, timestamp, sdkVersion}`, per cell — chain, provenance (run id + source `.jsonl`), per-turn `{requestedModel, observedModels, sessionId, cacheRead, cacheCreation, subtype, nonceRecall}`, and the judged grade. **Completeness gate:** the builder throws (no file written) when any required cell lacks final-attempt records for the run — a partial run must never yield an authoritative-looking ruling.

```typescript
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
```

**Verify:**

```bash
npx tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck docs/epics/kpr-309/spike/*.ts
# Expected: exit 0.
```

**Commit:** `KPR-310: spike summary builder + run-id selection + completeness gate`

---

### Task 6 — Offline unit tests (`selftest.ts`)

**Files:** `docs/epics/kpr-309/spike/selftest.ts`

**Steps:**

- [ ] Create `docs/epics/kpr-309/spike/selftest.ts` — SDK-free, covers the Testing Contract's 13 minimum assertions:

```typescript
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
```

**Verify:**

```bash
npx tsx docs/epics/kpr-309/spike/selftest.ts
# Expected: 13 "ok - ..." lines then "selftest OK (13 checks)", exit 0.
npx tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck docs/epics/kpr-309/spike/*.ts
# Expected: exit 0.
```

**Commit:** `KPR-310: spike selftest — grading + summary unit coverage`

---

### Task 7 — Chain runner + CLI (`run-matrix.ts`)

**Files:** `docs/epics/kpr-309/spike/run-matrix.ts`

**Steps:**

- [ ] Create `docs/epics/kpr-309/spike/run-matrix.ts`. Spec-pinned behaviors implemented here: per-turn `query()` with `{ resume, model }`, session id captured from the `system`/`init` message, 120s per-turn timeout via `AbortController`, retry-once-on-ANY-failure per cell — **including expect-nonce continuity misses on otherwise-successful turns** (except M8-T2 where the fault IS the observation; forbid/observe are evidence-not-failure and never retry), serial cells with M1 first, the automated M1 cache-validity gate (nonzero exit on failure in both `--cell` and full-matrix modes), per-cell `.jsonl` evidence, `summary.json` only at full-matrix completion or `--summarize`, **post-abort recovery via `--cell <id> --run <runId>`** (appends under the existing run id, adopting its seed), session isolation via a dedicated tmpdir `cwd`, `settingSources: []` + `extraArgs: { "strict-mcp-config": null }` mirroring hive's isolation posture, no `ANTHROPIC_API_KEY` added, no `CLAUDE_CONFIG_DIR`, cache-TTL window enforcement on T3, M6's in-process MCP server via `createSdkMcpServer` (an SDK import, not a `src/` import). A turn whose resume target never returned an id is skipped (attempt fails) but independent branches (M7a T3b, M8 T3/P1/P2) still run. The harness spawns no subprocesses itself (the SDK manages its own CLI child), so the argv-array rule is satisfied vacuously.

```typescript
/**
 * KPR-310 spike — chain runner for the model-switching matrix.
 * Spec: docs/epics/kpr-309/kpr-310-spec.md. Throwaway harness (D1) - no imports from src/**.
 *
 * Usage (from worktree root, after npm install):
 *   npx tsx docs/epics/kpr-309/spike/run-matrix.ts [--plan] [--cell M2 [--run <id>]] [--seed 310] [--with-m9] [--summarize [--run <id>]]
 */
import { mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  query,
  createSdkMcpServer,
  tool,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { FIXED_SYSTEM_PROMPT } from "./prefix.ts";
import {
  buildCells,
  noncesFor,
  DEFAULT_SEED,
  MODELS,
  SECRET_WORD,
  TOOL_NAME,
  MCP_SERVER_NAME,
  MCP_TOOL_FULL_NAME,
  type CellSpec,
  type TurnSpec,
} from "./cells.ts";
import { viewResult, type TurnRecord } from "./grade.ts";
import { buildSummary, latestCompleteRunId, REQUIRED_CELLS } from "./summarize.ts";

const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(SPIKE_DIR, "evidence");
const SUMMARY_PATH = join(EVIDENCE_DIR, "summary.json");
/** Isolated session cwd: SDK session files land under a dedicated ~/.claude/projects/ slot (spec). */
const SCRATCH_CWD = join(tmpdir(), "kpr-310-spike-sessions");
const TURN_TIMEOUT_MS = 120_000; // spec-pinned per-turn wall-clock bound
const CACHE_WINDOW_MS = 240_000; // T3 must start within this of T1's end (5m TTL minus margin)
const MAX_TURNS = 6; // spec-pinned

function sdkVersion(): string {
  // Spike dir is docs/epics/kpr-309/spike -> repo root is 4 levels up.
  const p = join(SPIKE_DIR, "..", "..", "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
  const pkg = JSON.parse(readFileSync(p, "utf8")) as { version: string };
  return pkg.version;
}

const spikeServer = createSdkMcpServer({
  name: MCP_SERVER_NAME,
  version: "1.0.0",
  tools: [
    tool(TOOL_NAME, "Returns the secret word for the KPR-310 spike.", {}, async () => ({
      content: [{ type: "text", text: SECRET_WORD }],
    })),
  ],
});

interface CliArgs {
  plan: boolean;
  cell: string | null;
  seed: number;
  withM9: boolean;
  summarize: boolean;
  run: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { plan: false, cell: null, seed: DEFAULT_SEED, withM9: false, summarize: false, run: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") args.plan = true;
    else if (a === "--with-m9") args.withM9 = true;
    else if (a === "--summarize") args.summarize = true;
    else if (a === "--cell") args.cell = argv[++i] ?? null;
    else if (a === "--run") args.run = argv[++i] ?? null;
    else if (a === "--seed") args.seed = Number(argv[++i] ?? String(DEFAULT_SEED));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(args.seed)) throw new Error("--seed must be an integer");
  return args;
}

function buildOptions(turn: TurnSpec, resumeId: string | null, controller: AbortController): Options {
  const options: Options = {
    model: turn.model,
    systemPrompt: FIXED_SYSTEM_PROMPT,
    maxTurns: MAX_TURNS,
    cwd: SCRATCH_CWD,
    settingSources: [],
    // Mirror hive's isolation posture (KPR-201): sandbox MCP discovery only; auth and
    // session storage stay on the default ~/.claude/. Never set CLAUDE_CONFIG_DIR.
    extraArgs: { "strict-mcp-config": null },
    abortController: controller,
    env: {
      ...process.env,
      CLAUDECODE: undefined, // avoid nested-session guard when run from inside a Claude Code session
      CLAUDE_AGENT_SDK_CLIENT_APP: "kpr-310-spike/0.0.1",
    },
  };
  if (resumeId !== null) options.resume = resumeId;
  if (turn.fork === true) options.forkSession = true;
  if (turn.withTool === true) {
    options.mcpServers = { [MCP_SERVER_NAME]: spikeServer };
    options.allowedTools = [MCP_TOOL_FULL_NAME];
  }
  if (turn.adaptiveThinking === true) options.thinking = { type: "adaptive" };
  return options;
}

/** Serializable subset of the options for the evidence line (spec: "full options object (minus env)"). */
function loggableOptions(turn: TurnSpec, resumeId: string | null): Record<string, unknown> {
  return {
    model: turn.model,
    systemPromptChars: FIXED_SYSTEM_PROMPT.length,
    maxTurns: MAX_TURNS,
    cwd: SCRATCH_CWD,
    settingSources: [],
    extraArgs: { "strict-mcp-config": null },
    ...(resumeId !== null ? { resume: resumeId } : {}),
    ...(turn.fork === true ? { forkSession: true } : {}),
    ...(turn.withTool === true ? { mcpServers: [MCP_SERVER_NAME], allowedTools: [MCP_TOOL_FULL_NAME] } : {}),
    ...(turn.adaptiveThinking === true ? { thinking: { type: "adaptive" } } : {}),
  };
}

interface TurnOutcome {
  record: TurnRecord;
  returnedSessionId: string | null;
  failed: boolean; // triggers cell retry unless faultExpected
}

async function runTurn(
  cell: CellSpec,
  turn: TurnSpec,
  resumeId: string | null,
  runId: string,
  seed: number,
  attempt: number,
  cacheWindowOk: boolean | null,
): Promise<TurnOutcome> {
  const nonces = noncesFor(cell.id, seed);
  const prompt = turn.prompt(nonces);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TURN_TIMEOUT_MS);

  const messageTypes: string[] = [];
  const assistantTexts: string[] = [];
  let initSessionId: string | null = null;
  let apiKeySource: string | null = null;
  let resultMessage: unknown = null;
  let responseText = "";
  let toolCalled = false;
  let thrown: TurnRecord["thrown"] = null;
  const started = Date.now();

  try {
    const q = query({ prompt, options: buildOptions(turn, resumeId, controller) });
    for await (const msg of q) {
      const subtype = "subtype" in msg && typeof (msg as { subtype?: unknown }).subtype === "string"
        ? `:${(msg as { subtype: string }).subtype}`
        : "";
      messageTypes.push(`${msg.type}${subtype}`);
      if (msg.type === "system" && msg.subtype === "init") {
        initSessionId = msg.session_id;
        apiKeySource = String(msg.apiKeySource);
      } else if (msg.type === "assistant") {
        // Structural access into the Beta API message content (SDK types the payload loosely).
        const content = (msg as unknown as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "text" && typeof block.text === "string") assistantTexts.push(block.text);
            if (block.type === "tool_use" && block.name === MCP_TOOL_FULL_NAME) toolCalled = true;
          }
        }
      } else if (msg.type === "result") {
        resultMessage = msg;
        if (msg.subtype === "success") responseText = msg.result;
      }
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    thrown = { name: e.name, message: e.message, stack: e.stack };
  } finally {
    clearTimeout(timer);
  }
  if (responseText === "") responseText = assistantTexts.join("\n");

  const nonceChecks: TurnRecord["nonceChecks"] = [
    ...turn.expect.map((key) => ({ key, value: nonces[key], relation: "expect" as const, found: responseText.includes(nonces[key]) })),
    ...(turn.forbid ?? []).map((key) => ({ key, value: nonces[key], relation: "forbid" as const, found: responseText.includes(nonces[key]) })),
    ...(turn.observe ?? []).map((key) => ({ key, value: nonces[key], relation: "observe" as const, found: responseText.includes(nonces[key]) })),
  ];

  const record: TurnRecord = {
    runId, seed, ts: new Date().toISOString(), cell: cell.id, attempt,
    turnLabel: turn.label, requestedModel: turn.model, resumeOf: turn.resumeOf,
    resumedSessionId: resumeId, fork: turn.fork === true,
    options: loggableOptions(turn, resumeId),
    messageTypes, apiKeySource, initSessionId, resultMessage, responseText,
    toolCalled, thrown, timedOut, wallMs: Date.now() - started, cacheWindowOk, nonceChecks,
  };

  const rv = viewResult(resultMessage);
  const turnErrored = thrown !== null || timedOut || rv === null || rv.subtype !== "success" || rv.isError;
  // Retry-once on ANY failure (spec): a continuity break on an otherwise-successful turn
  // counts as a failure too - expect-misses trigger the retry (forbid/observe are
  // evidence-not-failure and never do).
  const expectMiss = nonceChecks.some((c) => c.relation === "expect" && !c.found);
  const toolMissing = turn.requireToolCall === true && !toolCalled;
  const windowBlown = turn.switchBack === true && cacheWindowOk === false;
  const failed =
    ((turnErrored || expectMiss) && turn.faultExpected !== true) || toolMissing || windowBlown;
  return { record, returnedSessionId: initSessionId, failed };
}

function appendEvidence(record: TurnRecord): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  appendFileSync(join(EVIDENCE_DIR, `${record.cell}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

async function runCellAttempt(cell: CellSpec, runId: string, seed: number, attempt: number): Promise<{ records: TurnRecord[]; failed: boolean }> {
  const returnedIds = new Map<string, string>();
  const records: TurnRecord[] = [];
  let failed = false;
  let t1EndedAt: number | null = null;
  for (const turn of cell.turns) {
    let resumeId: string | null = null;
    if (turn.resumeOf !== null) {
      resumeId = returnedIds.get(turn.resumeOf) ?? null;
      if (resumeId === null) {
        // Only turns whose resume target never returned an id are skipped; independent
        // branches (M7a T3b, M8 T3/P1/P2) still run after an earlier turn failed.
        console.error(`  ${cell.id}/${turn.label}: no returned id for ${turn.resumeOf} - skipping turn`);
        failed = true;
        continue;
      }
    }
    const cacheWindowOk = turn.switchBack === true && t1EndedAt !== null
      ? Date.now() - t1EndedAt <= CACHE_WINDOW_MS
      : turn.switchBack === true
        ? false
        : null;
    console.log(`  ${cell.id}/${turn.label} attempt ${attempt}: model=${turn.model}${resumeId ? ` resume=${resumeId.slice(0, 8)}...` : " (new session)"}${turn.fork ? " fork" : ""}`);
    const outcome = await runTurn(cell, turn, resumeId, runId, seed, attempt, cacheWindowOk);
    appendEvidence(outcome.record);
    records.push(outcome.record);
    if (outcome.returnedSessionId !== null) returnedIds.set(turn.label, outcome.returnedSessionId);
    if (turn.label === "T1") t1EndedAt = Date.now();
    const rv = viewResult(outcome.record.resultMessage);
    console.log(
      `    -> ${outcome.record.timedOut ? "TIMEOUT" : outcome.record.thrown ? `THROWN ${outcome.record.thrown.name}` : `subtype=${rv?.subtype}`} id=${outcome.record.initSessionId?.slice(0, 8) ?? "none"} wall=${outcome.record.wallMs}ms cacheRead=${rv?.modelUsage[turn.model]?.cacheReadInputTokens ?? "n/a"}`,
    );
    if (outcome.failed) failed = true;
  }
  return { records, failed };
}

/** Retry policy (spec-pinned): retry a failed cell ONCE on ANY failure; both attempts recorded. */
async function runCell(cell: CellSpec, runId: string, seed: number): Promise<TurnRecord[]> {
  console.log(`\n== ${cell.id} - ${cell.title}`);
  const a1 = await runCellAttempt(cell, runId, seed, 1);
  if (!a1.failed) return a1.records;
  console.log(`  ${cell.id}: attempt 1 failed - retrying once (spec retry policy)`);
  const a2 = await runCellAttempt(cell, runId, seed, 2);
  return [...a1.records, ...a2.records]; // grader/summary use the final attempt
}

/** Spec-pinned cache-validity gate: M1's T2 must show nonzero per-model cacheReadInputTokens. */
function checkM1Gate(m1Records: TurnRecord[]): boolean {
  const finalAttempt = Math.max(...m1Records.map((r) => r.attempt));
  const t2 = m1Records.find((r) => r.attempt === finalAttempt && r.turnLabel === "T2");
  const mu = t2 ? viewResult(t2.resultMessage)?.modelUsage[MODELS.sonnet] : undefined;
  const read = mu?.cacheReadInputTokens ?? 0;
  if (read > 0) {
    console.log(`\nM1 cache-validity gate PASS: T2 cacheReadInputTokens=${read}`);
    return true;
  }
  console.error(
    `\nM1 cache-validity gate FAILED: T2 cacheReadInputTokens=${read}.\n` +
      `The fixed prefix is below the minimum cacheable size for this model - every cache\n` +
      `column would read zero vacuously. Enlarge SECTIONS in prefix.ts, then RESTART THE\n` +
      `FULL MATRIX (spec: gate is automated, not a judgment call).`,
  );
  return false;
}

function readAllRecords(): TurnRecord[] {
  if (!existsSync(EVIDENCE_DIR)) return [];
  const records: TurnRecord[] = [];
  for (const f of readdirSync(EVIDENCE_DIR)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(EVIDENCE_DIR, f), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      records.push(JSON.parse(line) as TurnRecord);
    }
  }
  return records;
}

function writeSummary(records: TurnRecord[], runId: string, seed: number): void {
  const summary = buildSummary(records, runId, sdkVersion(), seed);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nsummary.json written: ruling=${summary.ruling} cost=$${summary.totalCostUsd} turnAttempts=${summary.totalTurnAttempts}`);
  for (const c of summary.cells) console.log(`  ${c.id}: ${c.grade}${c.caveats.length ? ` (${c.caveats.length} caveat${c.caveats.length > 1 ? "s" : ""})` : ""}`);
  if (summary.constraints.length > 0) {
    console.log("constraints:");
    for (const k of summary.constraints) console.log(`  - ${k}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cells = buildCells(args.withM9 || args.cell === "M9");

  if (args.plan) {
    console.log(`KPR-310 matrix plan (seed=${args.seed}, sdk=${sdkVersion()}) - NO API calls`);
    for (const cell of cells) {
      const n = noncesFor(cell.id, args.seed);
      console.log(`\n${cell.id} - ${cell.title}${cell.optional ? " [OPTIONAL]" : ""}`);
      for (const t of cell.turns) {
        console.log(`  ${t.label}: model=${t.model} resumeOf=${t.resumeOf ?? "(new)"}${t.fork ? " fork" : ""}${t.withTool ? " +tool" : ""}`);
        console.log(`      prompt: ${t.prompt(n)}`);
      }
    }
    return;
  }

  if (args.summarize) {
    const records = readAllRecords();
    if (records.length === 0) {
      console.error("no evidence found - run the matrix first");
      process.exitCode = 1;
      return;
    }
    const runId = args.run ?? latestCompleteRunId(records);
    if (runId === null) {
      console.error(`no COMPLETE run found (required cells: ${REQUIRED_CELLS.join(", ")}); pass --run <id> to force`);
      process.exitCode = 1;
      return;
    }
    const seed = records.find((r) => r.runId === runId)?.seed ?? args.seed;
    try {
      writeSummary(records, runId, seed);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exitCode = 1;
    }
    return;
  }

  mkdirSync(SCRATCH_CWD, { recursive: true });

  if (args.cell !== null) {
    // Partial run: writes .jsonl evidence, NEVER touches summary.json (spec-pinned).
    // --run <id> appends to an EXISTING run id (post-abort recovery: rerun the failed
    // cells under the aborted run's id, then --summarize --run <id> completes it).
    const cell = cells.find((c) => c.id === args.cell);
    if (!cell) {
      console.error(`unknown cell ${args.cell} - known: ${cells.map((c) => c.id).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    let runId: string;
    let seed = args.seed;
    if (args.run !== null) {
      runId = args.run;
      const prior = readAllRecords().filter((r) => r.runId === runId);
      if (prior.length > 0 && prior[0].seed !== seed) {
        seed = prior[0].seed;
        console.log(`adopting seed=${seed} from existing run ${runId} (nonce comparability)`);
      }
    } else {
      runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    }
    console.log(`KPR-310 --cell ${cell.id} run ${runId} seed=${seed} sdk=${sdkVersion()} cwd=${SCRATCH_CWD}`);
    const records = await runCell(cell, runId, seed);
    if (cell.id === "M1" && !checkM1Gate(records)) process.exitCode = 1;
    console.log(`\n--cell run complete (${records.length} turn attempts). summary.json NOT written (partial-run discipline).`);
    return;
  }

  // Full matrix: serial, M1 first (gate), M8 last (post-fault probe is final API activity).
  if (args.run !== null) {
    console.error("--run is only valid with --cell or --summarize; full-matrix runs always mint a fresh run id");
    process.exitCode = 1;
    return;
  }
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`KPR-310 matrix run ${runId} seed=${args.seed} sdk=${sdkVersion()} cwd=${SCRATCH_CWD}`);
  console.log(`prefix: ${FIXED_SYSTEM_PROMPT.length} chars (~${Math.ceil(FIXED_SYSTEM_PROMPT.length / 4)} tokens)`);
  const allRecords: TurnRecord[] = [];
  for (const cell of cells) {
    const records = await runCell(cell, runId, args.seed);
    allRecords.push(...records);
    if (cell.id === "M1" && !checkM1Gate(records)) {
      process.exitCode = 1;
      return; // abort BEFORE M2+ burns turns; summary.json untouched (spec throw-safety)
    }
  }
  writeSummary(allRecords, runId, args.seed);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
```

**Verify (no API burned):**

```bash
npx tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck docs/epics/kpr-309/spike/*.ts
# Expected: exit 0.
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --plan
# Expected: prints all cells/turns/models/prompts with resolved nonces; "NO API calls"; exit 0.
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --summarize
# Expected: "no evidence found - run the matrix first", exit 1.
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --run run-x
# Expected: "--run is only valid with --cell or --summarize; ...", exit 1.
npx tsx docs/epics/kpr-309/spike/selftest.ts
# Expected: still "selftest OK (13 checks)".
```

**Commit:** `KPR-310: spike chain runner — timeout, retry, M1 gate, evidence + recovery discipline`

---

### Task 8 — Smoke gate: live `--cell M1` (does NOT burn the matrix)

**Files:** none (evidence is gitignored)

**Steps:**

- [ ] Preconditions: subscription auth must be live (the repo convention — logged-in `claude` CLI in the GUI session). If the run below fails with an auth-shaped error, re-auth interactively (`claude` → login) and rerun.

- [ ] Run the smoke cell (~3 SDK turns, sonnet only):

```bash
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --cell M1
```

- [ ] Confirm all of:
   - Console shows three turns T1/T2/T3, each with `subtype=success` and a session id.
   - `M1 cache-validity gate PASS: T2 cacheReadInputTokens=<nonzero>` and exit code 0 — **if the gate FAILS the command exits 1; enlarge `SECTIONS` in `prefix.ts` (e.g. 32 → 48), commit the change, and rerun this task before proceeding** (spec: gate must pass before the matrix).
   - The line `summary.json NOT written (partial-run discipline)`.

```bash
ls docs/epics/kpr-309/spike/evidence/
# Expected: M1.jsonl only - NO summary.json
wc -l docs/epics/kpr-309/spike/evidence/M1.jsonl
# Expected: 3 (or 6 if the cell retried once)
git status --short
# Expected: NO evidence files listed (gitignore working); nothing staged
```

- [ ] Sanity-read one JSONL line (evidence completeness): it must contain `initSessionId`, `resultMessage.modelUsage` with a `claude-sonnet-4-6` key, `apiKeySource`, `messageTypes`, and `nonceChecks`.

```bash
head -c 2000 docs/epics/kpr-309/spike/evidence/M1.jsonl
```

**Verify:** all checks above pass. If the gate failed and `prefix.ts` was enlarged: `npx tsx docs/epics/kpr-309/spike/selftest.ts` still passes, and this task's smoke run is repeated until the gate passes.

**Commit:** only if `prefix.ts` changed: `KPR-310: enlarge cache prefix after M1 gate reading`. Otherwise nothing to commit (evidence is local-only by design).

---

### Task 9 — Full matrix run + commit `summary.json`

**Depends on Task 8 having passed the M1 gate.**

**Files:** `docs/epics/kpr-309/spike/evidence/summary.json` (produced, then committed)

**Steps:**

- [ ] Run the full matrix (M1→M7b, optional M9, M8 last; serial; ~28–33 SDK turns nominal, <30 min, <$5 API-equivalent — subscription quota in practice). Include M9 only if time/quota permits (it is informative-only and never affects the ruling). **Note the run id printed on the first line** — you need it if recovery becomes necessary.

```bash
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --with-m9
# (or without --with-m9 - record the skip; the verdict lists M9 under Untested either way)
```

- [ ] Watch the console: the M1 gate must print PASS before M2 starts. Each cell prints per-turn `subtype`/`cacheRead` lines and any retry. M8's T2 is EXPECTED to error — that is the observation, not a failure.

- [ ] On completion the runner prints per-cell grades, the constraints list, and writes `evidence/summary.json` with the mechanical ruling.

- [ ] **Post-abort recovery (only if the run aborted mid-matrix):** the previous `summary.json` is untouched (throw-safety discipline), and `--summarize` refuses incomplete runs — you cannot accidentally produce a partial ruling. Recover under the SAME run id so the digest stays a single-run artifact with truthful provenance:

```bash
# 1. rerun each missing/failed cell under the aborted run's id (seed is adopted automatically):
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --cell M4 --run <runId>
# 2. when every required cell has records, regenerate the digest wholesale:
npx tsx docs/epics/kpr-309/spike/run-matrix.ts --summarize --run <runId>
```

   A full fresh run is still preferred over stitching if quota allows (cleanest cache-timing evidence); recovery exists so an interrupted run near completion doesn't force a full re-burn.

**Verify:**

```bash
cat docs/epics/kpr-309/spike/evidence/summary.json | head -40
# Expected: {"runId": "...", "timestamp": "...", "sdkVersion": "0.2.x", "seed": 310, "ruling": "SAFE|SAFE-WITH-CONSTRAINTS|UNSAFE", ...}
node -e "const s=require('/Users/mokie/github/kpr-310-mature/docs/epics/kpr-309/spike/evidence/summary.json'); console.log('cells:', s.cells.map(c=>c.id+'='+c.grade).join(' ')); console.log('ruling:', s.ruling); console.log('cost:', s.totalCostUsd, 'attempts:', s.totalTurnAttempts)"
# Expected: all of M1 M2 M3 M4 M5 M6 M7a M7b M8 present (+M9 if run); a ruling; totalTurnAttempts ~30-33 nominal.
# NOTE: totalTurnAttempts counts BOTH attempts of retried cells, so it can exceed 40 if several
# cells retried (bounded at 2x the nominal turn count) - that is expected, not a bug; the <$5
# cost bound is the operative limit.
git add -f docs/epics/kpr-309/spike/evidence/summary.json && git status --short
# Expected: only summary.json staged (the .gitignore negation admits it; -f belt-and-braces)
```

**Commit:** `KPR-310: matrix evidence digest (summary.json)`

---

### Task 10 — Author the verdict (ONLY after Task 9)

**Hard dependency: this task is executable ONLY after the full matrix run has produced and committed `summary.json`. Do not draft the verdict from expectations.**

**Files:** `docs/epics/kpr-309/kpr-310-verdict.md`

**Steps:**

- [ ] Gather inputs:

```bash
node -e "const s=require('/Users/mokie/github/kpr-310-mature/docs/epics/kpr-309/spike/evidence/summary.json'); console.log(JSON.stringify(s, null, 2))" | less
npm ls @anthropic-ai/claude-agent-sdk          # exact pinned version for the header
git log -1 --format=%h -- docs/epics/kpr-309/spike/   # harness commit sha for the header
grep -o '"thrown":[^,]*' docs/epics/kpr-309/spike/evidence/M8.jsonl | head   # M8 fault text, verbatim
```

- [ ] R3 mapping is **by reading, never importing** (W2 register R3 — classifier exports frozen at `kpr-305` @ `af74cf7`; the file does not exist on this worktree). Fetch and read the frozen taxonomy:

```bash
git fetch origin kpr-305:refs/remotes/origin/kpr-305 2>/dev/null || true
git show af74cf7:src/agents/provider-adapters/error-classification.ts
# Taxonomy: connect-fail | timeout | rate-limit | auth | server-error | non-provider
```

   Transcribe M8's fault text into the verdict and map it onto that taxonomy by hand (expected: `non-provider` under the fail-safe bias — confirm, and state whether that is the *right* classification for KPR-312 to revisit).

- [ ] Write `docs/epics/kpr-309/kpr-310-verdict.md` using the spec's template **exactly** (spec §"Verdict document template" — reproduce that structure verbatim, filling in):
   - **Ruling** = `summary.json`'s `ruling` field. The derivation is mechanical and binding; any deviation requires a stated reason in the verdict (spec, final open assumption).
   - **SDK version pinned** = exact resolved version; note the `^0.2.63` range and the re-verification requirement if `.2` delivery resolves a different minor.
   - **Run environment** = machine, date, auth mode (from `apiKeySource` in the evidence — subscription vs API key), harness commit sha.
   - **Results matrix** — one row per cell from `summary.json` (`Cache (T3 switch-back)` is N/A for M1, M7a/M7b, M8).
   - **Enumerated constraints** — the `constraints` array, each stated as observed evidence → the rule downstream must follow (C1, C2, …).
   - **Consumer statements** — KPR-311 (can the seam pass the per-turn model on resume? phrased R7-compatibly: router runs inside `prepareSpawn`, AFTER breaker `acquire()` and sessionId re-resolve, exactly one `record()` per spawnTurn — state whether anything observed requires moving where the model decision binds); KPR-312 (each observed fault mapped onto the frozen R3 taxonomy, mis-bucketing noted); KPR-313 (observed id invariants as testable invariants: id stability per resume, fork semantics from M7a, stale-id behavior from M7b, last-returned-id discipline validity).
   - **Untested / out of scope** — thinking-config interaction (unless M9 ran — if it ran, summarize as informative), `fallbackModel`, alias model names, non-Claude providers (D3), streaming-input `setModel()` path. **If the ruling is UNSAFE:** note `setModel()` (streaming-input mode, `sdk.d.ts:1723`) as the SDK-documented alternative and what adopting it would mean for hive's non-streaming shape.
   - **Raw evidence** — summary.json committed beside the harness; full transcripts local to the run machine.

**Verify:**

```bash
grep -c "^## " docs/epics/kpr-309/kpr-310-verdict.md   # >= 5 (Results matrix, constraints, consumer statements, untested, raw evidence)
grep "Ruling:" docs/epics/kpr-309/kpr-310-verdict.md    # matches summary.json's ruling exactly
node -e "const s=require('/Users/mokie/github/kpr-310-mature/docs/epics/kpr-309/spike/evidence/summary.json'); console.log(s.ruling)"
```
Cross-check by hand: every DEGRADED cell's caveat appears as an enumerated constraint; the three consumer sections each contain an explicit answer, not a summary.

**Commit:** `KPR-310: verdict — per-turn model switching on non-streaming resume`

---

### Task 11 — Final verification: D1 compliance + branch hygiene

**Files:** none

**Steps:**

- [ ] Run the full hygiene sweep:

```bash
cd /Users/mokie/github/kpr-310-mature
git diff --stat kpr-309...HEAD -- src/ setup/ plugins/ scripts/ package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.mjs
# Expected: EMPTY - the spike touched nothing production-gated (D1). If anything shows, revert it.
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
# Expected: exit 0 - identical gate result to Task 1 baseline.
npx tsx docs/epics/kpr-309/spike/selftest.ts            # still green
git status --short                                       # clean (no unignored evidence, no stray files)
git log --oneline kpr-309..HEAD
# Expected commits (order may interleave with any prefix-enlargement fix):
#   KPR-310: spike scaffold - README + evidence gitignore
#   KPR-310: spike rng + fixed >=4k-token cache prefix
#   KPR-310: spike matrix cells M1-M9 as data
#   KPR-310: spike grading + mechanical ruling derivation
#   KPR-310: spike summary builder + run-id selection + completeness gate
#   KPR-310: spike selftest - grading + summary unit coverage
#   KPR-310: spike chain runner - timeout, retry, M1 gate, evidence + recovery discipline
#   KPR-310: matrix evidence digest (summary.json)
#   KPR-310: verdict - per-turn model switching on non-streaming resume
ls docs/epics/kpr-309/
# Expected: kpr-310-spec.md  kpr-310-plan.md  kpr-310-verdict.md  spike/
```

- [ ] Confirm the deliverables on the branch are exactly the D1 set (harness, evidence digest, verdict; nothing else):
   - `docs/epics/kpr-309/spike/` (harness + committed `evidence/summary.json`)
   - `docs/epics/kpr-309/kpr-310-verdict.md`

**Commit:** none (verification only).

---

## Assumptions

- Operator subscription auth is live on the dev machine at run time; re-auth interactively if the Task 8 smoke reports an auth failure (spec: non-blocking assumption; no separate cost approval needed, ≤$5 API-equivalent).
- `npm install` in the worktree resolves the SDK within `^0.2.63` (dev checkout resolves 0.2.104); whatever resolves is pinned in `summary.json` + verdict.
- Committing `summary.json` and the harness to the epic branch is acceptable (spec: non-blocking; committed-throwaway rationale in spec §Harness design).
- M9 is optional/informative; skipping it is recorded in the verdict's Untested section, not a gap.
- The M8 post-fault probe (P1/P2, 2 extra sonnet turns) is the mechanical observable for the spec's "poisoning" ruling input; it keeps the nominal run within the ≈≤40-turn/<$5 bound (retries can exceed the turn count, bounded 2×; the cost bound governs).
- `docs/` remains outside all `npm run check` gates (verified against `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, prettier globs at `f147477`); strict TS for the spike is enforced by the standalone `tsc --noEmit` command instead.
- The `system:init` message reliably carries `session_id` per turn (verified in `sdk.d.ts` `SDKSystemMessage` and mirrored from hive's `agent-runner.ts:1824-1826` capture pattern).
- W2 (`kpr-305` @ `af74cf7`) need not be merged; the R3 file is consulted via `git show` (fetch the branch ref first if the object is absent locally).
