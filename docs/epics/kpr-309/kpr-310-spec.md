# KPR-310 — Spike: per-turn model switching on non-streaming resume (W3.1)

**Epic:** KPR-309 (W3) — spike protocol, not a production feature design. This ticket BLOCKS KPR-311/312/313.
**Consumers of this spec:** the KPR-310 implement-phase worker (runs the harness, writes the verdict), and — via the verdict document — KPR-311 (router→adapter seam), KPR-312 (classifier v2), KPR-313 (session-identity guards).
**Decision Register canon:** KPR-309 has **no** `## Decision Register — Canon` section (pre-register epic — noted per process, not a blocker). W2's register (epic KPR-305, merged canon at branch `kpr-305` @ `af74cf7`) binds where relevant: **R3** (classifier export freeze) and **R7** (wrap-point semantics) are addressed explicitly below.
**Gate 1 dispensations (operator-approved 2026-07-09):** D1 — the spike RUNS during maturity; throwaway harness only, no production code; verdict lands at `docs/epics/kpr-309/kpr-310-verdict.md` on the epic branch. D3 — Claude Agent SDK path only; non-Claude adapters are pilot-grade in W3 and out of scope here.

## TL;DR

Hive already switches models per turn on resumed sessions in production — `prepareSpawn` computes a router `modelOverride` and `AgentRunner.send()` passes `{ model: effectiveModel, resume: sessionId }` into every `query()` — but this behavior has never been empirically characterized, and `setModel()` (the SDK's documented switching mechanism) is streaming-input-mode only, which is not hive's shape. This spike runs a throwaway harness that drives model A→B→A chains across resumed non-streaming `query()` calls and measures conversational continuity, session-id stability, prompt-cache behavior, tool-state carryover, and fault shapes. The output is a written verdict — SAFE / SAFE-WITH-CONSTRAINTS / UNSAFE, with constraints enumerated — that gates KPR-311/312/313.

## Key Points

- **The mechanism under test is already live.** `agent-manager.ts:1055-1070` routes per turn (gated by `modelRouter.enabled`), and `agent-runner.ts:1744-1763` passes `model` + `resume` together into `query()`. The spike de-risks by characterizing existing implicit behavior, not by trialing something new — but the verdict must rest on harness evidence, not on "prod hasn't visibly broken."
- **Empirical matrix**: 9 cells covering control (no switch), the three tier-pair switches hive actually routes (haiku/sonnet/opus per `TIER_MODELS` in `model-router.ts:46-50`), tool-state carryover across a switch, session-id semantics (fork-semantics cell M7a + a separate stale-id chain M7b), and a deliberate fault cell (bogus model mid-chain).
- **Per-cell observables**: nonce-recall continuity, per-turn `session_id` chain (init message), `modelUsage` + cache read/creation tokens from the result message, result subtype / error string, wall-clock per turn.
- **Harness is committed throwaway** at `docs/epics/kpr-309/spike/` on the epic branch — outside `src/` (never compiled, never tested by `npm run check`), runnable by the implement-phase worker with one command (`npx tsx docs/epics/kpr-309/spike/run-matrix.ts`). No imports from `src/**`.
- **Session isolation**: the harness runs with a dedicated scratch `cwd` so SDK session files land in an isolated `~/.claude/projects/` slot; the harness never touches hive code or hive's Mongo `agent_sessions` store, so contamination is structurally impossible. Do NOT use `CLAUDE_CONFIG_DIR` for isolation (known to break auth + sessions — KPR-201 lesson).
- **R3/R7 compliance**: the harness imports nothing from `src/` — fault-cell outputs are classified against the frozen R3 taxonomy **by reading** `kpr-305:src/agents/provider-adapters/error-classification.ts`, not by importing it. The verdict's KPR-311 statements must be compatible with R7's wrap-point order (breaker `acquire()` → sessionId re-resolve → `prepareSpawn`/router → adapter).
- **SDK version pinning**: `package.json` declares `^0.2.63`; the dev checkout currently resolves to `0.2.104`. The verdict must pin the exact resolved version the matrix ran against (`npm ls @anthropic-ai/claude-agent-sdk`), and flag re-verification if `.2` delivery lands on a different minor.
- ⚠ Delegated assumptions collected in the final section — all currently non-blocking.

## Problem / Context

W3's children need to know whether `query({ resume, model })` with a *different* model than the previous turn is a supported, well-behaved operation on the Claude Agent SDK path:

- **KPR-311** wants to unify the router→adapter seam. Today `createProviderAdapter` (`agent-manager.ts:396-434`) selects the provider from **static** `config.model` via `resolveProviderModel` and — for non-Claude providers — bakes the model into the adapter constructor. It is blind to the per-turn router decision; only the Claude path threads `modelOverride` through `AgentProviderTurnRequest` (`provider-adapters/types.ts:11`). 311 can only pass the router's per-turn model through the seam if per-turn switching on resume is safe.
- **KPR-312** (classifier v2) needs to know whether model switching introduces new provider-fault shapes the frozen R3 taxonomy doesn't cover.
- **KPR-313** (session-identity guards, turn-boundary switching) needs the observed session-id invariants: does a resumed turn return the same id, a new id chained to the old, and does hive's persist-last-returned-id discipline (`agent-manager.ts:1155-1159` → `sessionStore.set`) survive a mid-chain switch?

The SDK's own documentation is asymmetric: `setModel(model?)` is explicitly "Only available in streaming input mode" (`sdk.d.ts:1723`), while the plain `model?: string` query option says only "Claude model to use. Defaults to the CLI default model" — silent on resume interaction. Hive's non-streaming per-turn spawn shape (post-KPR-220) can only use the latter. Nobody has written down what actually happens.

### Verified current state (all paths relative to repo root; verified against worktree `kpr-310-mature`, branched off epic branch `kpr-309` — both == main @ `f147477`)

- `src/agents/agent-manager.ts:1055-1070` — `prepareSpawn` calls `routeModel(item.text, agentConfig.model, agentConfig.resourceTiers)` when `appConfig.modelRouter.enabled && item.sender !== "system"`; sets `modelOverride` only when the routed model differs from the agent's static model.
- `src/agents/agent-manager.ts:963-1003` — `runOneSpawnAttempt` builds a fresh adapter per spawn and passes `modelOverride` in the `runTurn` request.
- `src/agents/provider-adapters/claude-agent-adapter.ts` — forwards `request.modelOverride` to `AgentRunner.send()`.
- `src/agents/agent-runner.ts:1495-1496` — `effectiveModel = modelOverride ?? this.agentConfig.model`; `agent-runner.ts:1744-1763` — `query({ options: { model: effectiveModel, ..., ...(sessionId ? { resume: sessionId } : {}) } })`. **So a Haiku-routed turn resuming a Sonnet session is a normal production event today.**
- `src/agents/agent-runner.ts:1824-1826` — session id captured from the `system`/`init` message; returned on `RunResult.sessionId`.
- `src/agents/agent-manager.ts:1155-1173` — the returned session id is persisted (`sessionStore.set`) and becomes the next turn's `resume` value. Hive is therefore **id-chain tolerant by construction**: if resume mints a new id each turn, hive follows the chain.
- `src/agents/session-store.ts` — Mongo `agent_sessions`, keyed `(agentId, threadId)`, 7-day TTL, also accumulates token/cache/compaction telemetry per turn.
- `src/agents/model-router.ts:46-50` — the three concrete model ids hive routes between: `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-7`; router result is ceiling-capped at the agent's configured model.
- Hive does **not** set the SDK `thinking` option anywhere today; `fallbackModel` is likewise unused. (Thinking-interaction is therefore an informative cell at most, not load-bearing — see optional cell M9.)
- SDK (`@anthropic-ai/claude-agent-sdk`, declared `^0.2.63`, resolves to `0.2.104` in the dev checkout): `resume?: string` (`sdk.d.ts:1322-1324`), `forkSession?: boolean` ("resumed sessions will fork to a new session ID rather than continuing", `sdk.d.ts:1099-1102`), `resumeSessionAt?: string`, `model?: string`, `fallbackModel?: string`, `setModel()` streaming-only (`sdk.d.ts:1723`). Result message carries `modelUsage: Record<string, ModelUsage>` (`sdk.d.ts:2604`) with **camelCase** per-model fields `cacheReadInputTokens` / `cacheCreationInputTokens` (`sdk.d.ts:923-932`) — the exact instrument needed for cache measurement across a switch. (The snake_case `cache_read_input_tokens` / `cache_creation_input_tokens` fields belong to the **aggregate** `usage` object only.)
- `src/agents/provider-adapters/error-classification.ts` does **not exist** on this worktree — it is W2 canon on branch `kpr-305` @ `af74cf7` (R3 freeze: `classifyTurnResult(input: TurnFaultInput)`, `HARD_FAULT_KINDS`, `classifyThrown`; taxonomy `connect-fail | timeout | rate-limit | auth | server-error | non-provider`; adapters resolve provider faults into `RunResult.error: string`, they do not throw). The harness must not depend on W2 having merged.

## Goals

1. Answer, with harness evidence: **is per-turn model switching on non-streaming resume SAFE / SAFE-WITH-CONSTRAINTS / UNSAFE** on the Claude Agent SDK path?
2. Characterize, per matrix cell: conversational continuity, session-id behavior, prompt-cache behavior (including the switch-back case), tool-state/MCP continuity, and fault shapes.
3. Produce the verdict document at `docs/epics/kpr-309/kpr-310-verdict.md` with explicit, separately-stated implications for KPR-311, KPR-312, and KPR-313.

## Non-goals

- **No production code.** No changes under `src/`. No router changes, no adapter changes, no session-store changes.
- **No non-Claude providers** (D3 — Codex/OpenAI/Gemini adapters are pilot-grade; their model handling is constructor-static and out of scope).
- **No streaming-input-mode `setModel()` path.** Hive doesn't use streaming input. The verdict must, however, NOTE `setModel()` as the SDK-documented alternative in its remediation section **if** the empirical `{resume, model}` path proves UNSAFE.
- **No statistical performance benchmarking.** Cache-token deltas are read from usage fields; we are not running latency benchmarks (first-principles bound + usage evidence suffices, per the KPR-220 bench pattern).
- **No touching R7 machinery.** The harness never exercises hive's breaker/withSpawnTicket path; R7 enters only as a constraint on how the verdict phrases 311 implications.

## Empirical question matrix

Every cell follows the same 3-turn chain protocol unless stated: **T1 (model A, new session) → T2 (model B, `resume` last returned id) → T3 (model A, `resume` last returned id)**. T1 plants a nonce (`"Remember the code phrase: <random-8-chars>. Reply only OK."`), T2 plants a second nonce and asks for the first, T3 asks for both. Prompts are fixed strings checked into the harness so runs are comparable.

| Cell | Chain (A→B→A) | Question it answers |
|------|---------------|---------------------|
| **M1 — control** | sonnet→sonnet→sonnet | Baseline: continuity, id behavior, and cache read/write on resume with NO switch. Every other cell is judged against M1. |
| **M2 — router downshift** | sonnet→haiku→sonnet | The most common production shape (router downshifts a simple turn below the agent's static model). |
| **M3 — router upshift** | haiku→sonnet→haiku | Inverse direction — do not assume symmetry with M2. |
| **M4 — ceiling pair** | sonnet→opus→sonnet | Opus involvement (CoS agents route up to opus). |
| **M5 — max distance** | opus→haiku→opus | Largest capability/context-format gap hive can produce. |
| **M6 — tool-state carryover** | sonnet→haiku→sonnet, with a harness-local in-process MCP server (one trivial tool, e.g. `get_secret_word`) attached to all three turns; T1 must call the tool; T3 asks what the tool returned in T1 | Does resumed history containing `tool_use`/`tool_result` blocks from model A replay cleanly into model B and back? (In-process server built with the SDK's `createSdkMcpServer` — an SDK import, not a `src/` import.) |
| **M7a — fork semantics** | sonnet chain: T1 (new session, plants nonce) → T2 (`resume` T1's id + `forkSession: true`, plants second nonce) → then **both** follow-ups: **T3a** resumes T2's returned (forked) id — hive's last-returned-id discipline — and **T3b** resumes T1's pre-fork original id | Establishes the id model: same-id vs new-id-per-resume vs fork. **Nonce expectation (the KPR-313 observable): T2 — the forked session — must recall T1's nonce.** T3a PASS: recalls both nonces, id chains from T2's forked id. T3b PASS: original session still resumable and recalls T1's nonce but NOT T2's (fork isolation); if T3b instead sees T2's nonce or the original id is unresumable, record as the finding — either outcome is evidence, graded DEGRADED-with-caveat (not FAIL) unless T3a shows wrong-session content bleed. |
| **M7b — stale-id resume** | separate plain (non-fork) sonnet chain: T1 → T2 (`resume` T1's id, normally) → **T3** resumes T1's now-superseded id (deliberately stale — T2 already consumed it) | Hive's crash-recovery shape: a retry/crash path can replay an older persisted id. PASS: T3 gets a working session that recalls T1's nonce (state whether T2's nonce is visible — either answer is the invariant KPR-313 encodes). **Unresumable or content-lossy stale-id resume grades DEGRADED with a named KPR-313-binding constraint, NOT FAIL** — this chain is sonnet-only (no model switch exercised), so an SDK stale-id limitation is a pre-existing production condition (crash-recovery corner; fix territory = KPR-313) and must not force the switching verdict to UNSAFE. FAIL is reserved for **wrong-SESSION content bleeding** (T3 surfaces content from an unrelated session — genuine id-model poisoning). Mirrors M7a's DEGRADED-with-caveat treatment of an unresumable pre-fork id. |
| **M8 — fault cell** | sonnet→**bogus model id** (`claude-nonexistent-9`)→sonnet | What does a bad model on resume produce — thrown exception, `result` subtype error, silent CLI-default fallback? Is the original session still resumable afterward (T3)? Fault text is transcribed into the verdict and mapped **by reading** onto the frozen R3 taxonomy (expected: `non-provider` under fail-safe bias — confirm and state whether that's the *right* classification for 312 to revisit). |

**Cells deliberately excluded** (state in verdict as untested): `thinking`/effort interaction (hive sets no `thinking` config today — informative only; run as an optional **M9** `opus+adaptive-thinking→haiku` chain ONLY if time permits, and mark it informative — M9 never affects the ruling derivation); `fallbackModel` (unused in hive); alias model names like `"sonnet"` (hive always passes full ids from `TIER_MODELS`); cross-provider switches (D3).

**Per-cell observables (captured for every turn of every cell):**

1. **Continuity** — nonce recall, exact-match check on the response text.
2. **Session id** — `session_id` from the `system`/`init` message; the full chain `T1→T2→T3`; whether each resume returned the same id or a new one; whether the *last-returned-id* discipline (hive's) always yields a resumable session.
3. **Cache behavior** — from the result message: aggregate `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens` (snake_case on the aggregate object), and the per-model `modelUsage` map (**camelCase** fields: `cacheReadInputTokens` / `cacheCreationInputTokens`). Key questions: does the switch turn (T2) read ~0 cache (per-model prompt cache miss) and pay full re-creation? Does the switch-*back* turn (T3) re-read model A's cache (5m TTL window) or pay creation again? Quantify the cost cliff in tokens and USD (`total_cost_usd`).
4. **Result health** — result subtype (`success` vs error subtypes), `RunResult`-equivalent error strings, any thrown exceptions, `num_turns`, wall-clock duration.
5. **Model attribution** — which model(s) appear in `modelUsage` keys per turn (detects silent fallback to the CLI default model — a failure mode that would *mask* a broken switch).

## Harness design

- **Location: `docs/epics/kpr-309/spike/`** on the epic branch, committed. Rationale over a gitignored scratch dir: (a) D1 requires the verdict to land on the epic branch — a committed harness makes the verdict reproducible and reviewable; (b) the implement-phase worker must run it with one command, which a scratch dir can't guarantee across sessions; (c) `docs/` is outside `tsconfig`/vitest/eslint scope (`src/**`), so nothing under it is compiled, linted, or shipped — it is structurally incapable of becoming production code. The directory carries a README line: "KPR-310 throwaway spike harness — not production code, do not import."
- **Files** (suggested; implement-phase worker may adjust within these constraints):
  - `run-matrix.ts` — runs all cells sequentially, writes raw evidence.
  - `cells.ts` — the matrix as data (chains, prompts, nonce generation with a fixed seed option).
  - `evidence/` — gitignored inside the spike dir **except** a committed `summary.json` (per-cell verdict inputs); full transcripts stay local. Rationale: transcripts are bulky and contain nothing load-bearing beyond what `summary.json` captures; the verdict quotes the relevant excerpts.
  - **`summary.json` write discipline (throw-safety for the one committed artifact):** it carries a run id, run timestamp, exact SDK version, and per-cell provenance (which run id / which `.jsonl` produced each cell's row). It is written **only** at the end of a **full-matrix** run — or regenerated wholesale from the per-cell `.jsonl` files by a dedicated `--summarize` pass — never incrementally mid-run. A mid-matrix throw leaves the previous `summary.json` untouched (its run id will not match the aborted run's `.jsonl` files, so the mismatch is detectable). Partial `--cell` reruns write their `.jsonl` evidence but **never touch `summary.json`**.
- **Imports**: `@anthropic-ai/claude-agent-sdk` (from repo `node_modules`) and Node stdlib only. **Zero imports from `src/**`** — this is the D1 line and also the R3 line (frozen classifier surfaces are consulted by reading `kpr-305`'s file, never imported).
- **Invocation**: `npx tsx docs/epics/kpr-309/spike/run-matrix.ts [--cell M2] [--seed 42]` from the worktree root, after `npm install` (worktree currently has no `node_modules`).
- **Auth**: dev sessions use the operator's Anthropic subscription via the logged-in `claude` CLI (repo convention — LaunchAgent/GUI session auth). The harness sets no `ANTHROPIC_API_KEY` and does not touch `CLAUDE_CONFIG_DIR`. If the subscription session is expired at run time, re-auth interactively before running.
- **Session isolation**: every `query()` runs with `cwd` set to a dedicated scratch dir (e.g. `<scratchpad>/kpr-310-spike-sessions/`), so SDK session files land under an isolated `~/.claude/projects/<hash>` slot. The harness never instantiates hive code, so hive's Mongo `agent_sessions` store cannot be touched. `settingSources: []` + `extraArgs: { "strict-mcp-config": null }` mirror hive's isolation posture so user-level plugins/connectors don't contaminate transcripts or cache measurements.
- **Query options per turn** mirror hive's shape minimally: `model`, `resume` (when chained), `maxTurns: 6`, a fixed `systemPrompt` (constant across turns of a cell — cache measurement needs a stable prefix), `permissionMode: "bypassPermissions"` is NOT needed (no tools except M6's in-process server; default permissions suffice for an MCP tool call — if the SDK prompts, M6 may set `allowedTools` for the one tool instead).
- **Cache-measurable prefix (validity requirement):** the fixed `systemPrompt` must be **comfortably above the minimum cacheable prefix** (~1-2k tokens depending on model — target ≥4k tokens of filler-but-stable text, hive-prefix-shaped). Below the minimum, every cache field reads zero and the entire cache column degenerates vacuously without anyone noticing. **Validity gate: M1 (control) runs first and must show nonzero `cacheReadInputTokens` on its T2 before the matrix proceeds; if it reads zero, the harness aborts, the fixed prompt is enlarged, and the full matrix restarts.** The gate is automated in `run-matrix.ts`, not a judgment call.
- **Cost/runtime bounds**: 9 cells × ≤4 query calls × short prompts ≈ ≤40 SDK turns. On subscription auth the marginal cost is quota, not dollars; if run against an API key instead, expected spend is **under $5** (opus cells dominate). Wall-clock: **under 30 minutes** including retries. **Retry policy: retry a failed cell once on ANY failure (not just transient-looking ones); both attempts are recorded in the cell's `.jsonl`, and the grader distinguishes them.** A cell that fails twice is recorded as its graded outcome with both attempts as evidence, not silently skipped.
- **Per-turn wall-clock timeout**: every `query()` turn is bounded at **120s** — on expiry the harness aborts the turn (SDK abort/interrupt), records the timeout as evidence in the `.jsonl`, and treats it as that attempt's failure. This both bounds total runtime and protects the 5-minute cache-TTL window for the T3 switch-back measurement (a hung T2 must not silently invalidate T3's cache observation).
- **Determinism hygiene**: fixed prompt strings, seeded nonces, cells run serially (never parallel — avoids cross-session cache pollution and subscription rate-limit noise), M1 runs first as the baseline (it is also the cache validity gate — see above), and the T3 switch-back turn runs within 5 minutes of T1 (cache TTL window) — the harness enforces this with per-cell timing, not sleeps between cells.

## Measurement and evidence format

Raw capture per turn (JSON lines in `evidence/<cell>.jsonl`, local): timestamp, cell id, turn index, requested model, full options object (minus env), every SDK message type observed, init `session_id`, result message verbatim (usage, `modelUsage`, subtype, `total_cost_usd`, `num_turns`, duration), response text, and any thrown error with stack.

Committed `summary.json`: header `{runId, timestamp, sdkVersion}`; per cell — chain, provenance (run id + source `.jsonl`), per-turn `{requestedModel, observedModels, sessionId, cacheRead, cacheCreation, subtype, nonceRecall}`, and the judged grade. Written only at full-matrix completion (or via `--summarize` regeneration from `.jsonl`); `--cell` partial runs never write it (see Harness design).

**Grading per cell:**

- **PASS** — continuity intact (all nonce recalls exact), no error subtypes, no thrown exceptions, observed model matches requested model each turn, session chain resumable end-to-end.
- **DEGRADED** — chain completes and continuity holds, but with a material cost/behavior caveat (e.g. full cache re-creation on every switch; new session id per resume requiring chain-following; recall present but lossy). Every DEGRADED cell must name its caveat — these become the verdict's enumerated constraints.
- **FAIL** — continuity broken, session unresumable, silent model substitution, or an unrecoverable error mid-chain.

**Overall ruling derivation** (mechanical, so the verdict can't be vibes). M8 is *expected* to produce an error; it grades on whether the failure is **clean** (well-formed error, classifiable against R3, original session still resumable at T3). The rules, exhaustively:

- **SAFE** = M1–M7b all PASS **AND** M8 clean.
- **SAFE-WITH-CONSTRAINTS** = no FAIL in M1–M7b, but any of: (a) one or more DEGRADED cells in M1–M7b (constraints = the union of their named caveats), or (b) M8 non-clean but non-poisoning (e.g. ugly/unclassifiable error text, original session unresumable after the fault) — this maps to a **named constraint** binding 312/313.
- **UNSAFE** = any FAIL in M1–M7b, **or** M8 poisoning (the fault corrupts subsequent M1-shaped usage — e.g. later valid-model resumes of unrelated sessions misbehave).

The cell definitions cap what can grade FAIL in the id-model cells: M7a and M7b are sonnet-only chains (no model switch exercised), so SDK id-model limitations observed there — unresumable pre-fork or stale ids, content-lossy stale resume — grade **DEGRADED with named KPR-313-binding constraints**, never FAIL; their FAIL grade is reserved for wrong-session content bleeding (genuine id-model poisoning). This keeps a pre-existing production condition from mis-escalating the *switching* verdict to UNSAFE and blocking KPR-311/312.

Note: **observed-model attribution (`modelUsage` keys must match the requested model) is a PASS-gate in EVERY cell** — M2–M4 as much as M5. A silent fallback to the CLI default model in any cell is a FAIL (silent model substitution), because it would mask a rejected switch as success.

## Verdict document template (`docs/epics/kpr-309/kpr-310-verdict.md`)

```markdown
# KPR-310 Verdict — per-turn model switching on non-streaming resume

**Ruling: SAFE | SAFE-WITH-CONSTRAINTS | UNSAFE**
**SDK version pinned:** @anthropic-ai/claude-agent-sdk@<exact resolved version> (package.json range ^0.2.63)
**Run environment:** <machine, date, auth mode (subscription/API), harness commit sha>

## Results matrix
| Cell | Chain | Continuity | Session-id behavior | Cache (T2 read/creation vs M1) | Cache (T3 switch-back) | Subtype/errors | Grade |
|...one row per cell...|
("Cache (T3 switch-back)" is N/A where no switch occurs: M1 baseline, M7a/M7b, M8.)

## Enumerated constraints (binding on KPR-311/312/313)
C1. ... (each constraint: observed evidence → the rule downstream must follow)

## Consumer statements
### KPR-311 (router→adapter seam)
Explicit answer: can the seam pass the router's per-turn model into the adapter on resume?
[Must be phrased compatibly with R7: the router runs inside prepareSpawn, i.e. AFTER breaker
acquire() and sessionId re-resolve, with exactly one record() per spawnTurn on the finalized
attempt — state whether anything observed requires moving where the model decision binds.]

### KPR-312 (classifier v2)
New classifier-visible fault modes observed (M8 + any incidental), each mapped onto the frozen
R3 taxonomy (connect-fail|timeout|rate-limit|auth|server-error|non-provider) with a note where
the fail-safe `non-provider` default mis-buckets a model-switch fault.

### KPR-313 (session-identity guards)
Observed invariants: id stability per resume, fork semantics, stale-id resume behavior,
last-returned-id discipline validity. Stated as testable invariants.

## Untested / out of scope
thinking-config interaction (unless optional M9 ran), fallbackModel, alias model names, non-Claude
providers (D3), streaming-input setModel path.
[If ruling is UNSAFE: NOTE setModel() (streaming-input mode, sdk.d.ts:1723) as the
SDK-documented alternative and what adopting it would mean for hive's non-streaming shape.]

## Raw evidence
summary.json committed beside the harness; full transcripts local to the run machine.
```

## Edge cases / risks

1. **Resume with a model the session never used** — covered head-on by M2–M5 T2; the specific risk is silent fallback to the CLI default model (observable in every cell's `modelUsage` keys — the normative every-cell PASS-gate in the ruling derivation) masking a rejected switch as success.
2. **Cache invalidation cost cliff** — prompt cache is per-model; every switch may pay full prefix re-creation twice (switch and switch-back). Hive's prefixes are large (soul+prompt+constitution+roster+toolkit+memory). Quantified by M2–M5 cache fields; if severe, it is a SAFE-WITH-CONSTRAINTS constraint (e.g. "router downshifts only when prompt-cache saving < model-cost saving") — a 311/router-policy input, not a blocker by itself.
3. **SDK version drift between spike time and .2 delivery** — `^0.2.63` floats (dev checkout already resolves 0.2.104). Verdict pins the exact version; .2's plan must re-run the harness (one command) if its lockfile resolves a different minor.
4. **Session-store contamination** — none possible via hive (harness never touches hive code or Mongo); SDK-side session files are isolated by dedicated `cwd`. Never use `CLAUDE_CONFIG_DIR` for isolation (breaks auth + sessions — KPR-201).
5. **Stale-id resume** (M7b) — hive persists the last *returned* id, but crash/retry paths can replay an older id; the spike characterizes rather than fixes this (fix territory = KPR-313).
6. **Subscription rate limits / quota** — serial execution and ≤40 turns keep this negligible; a 429-shaped failure is captured as evidence (relevant to 312) and the cell retried once per the retry policy (both attempts in `.jsonl`).
7. **Non-determinism in recall grading** — exact-match nonces (not semantic judgment) keep grading mechanical; `maxTurns: 6` bounds runaway turns.
8. **W2 not merged into this worktree** — R3 surfaces referenced by reading branch `kpr-305` @ `af74cf7`; the harness has zero dependency on W2 code, so merge order cannot break the spike.

## Open assumptions

- ⚠ **Non-blocking** — Harness location `docs/epics/kpr-309/spike/` (committed, outside `src/`) satisfies D1's "throwaway, no production code"; if the driver prefers a gitignored scratch dir, only the reproducibility rationale changes.
- ⚠ **Non-blocking** — Operator subscription auth is available on the dev machine at run time; no separate cost approval needed (≤$5 API-equivalent).
- ⚠ **Non-blocking** — `npm install` in the worktree resolves the SDK within `^0.2.63`; whatever resolves is pinned in the verdict as the tested version.
- ⚠ **Non-blocking** — Committing `summary.json` (evidence digest) to the epic branch alongside the verdict is acceptable; full transcripts stay local.
- ⚠ **Non-blocking** — M9 (optional, thinking-interaction) is informative-only since hive sets no `thinking` config today; skipping it is recorded in the verdict's Untested section, not a gap.
- ⚠ **Non-blocking** — The mechanical grade→ruling derivation above is binding on the verdict author; deviations require a stated reason in the verdict.
