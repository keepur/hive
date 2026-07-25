# KPR-355 Implementation Plan — Parity matrix + supported-provider ruling (closing doc)

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** [kpr-355-spec.md](./kpr-355-spec.md) (final review clean, `spec-ready` @ `ea6783b`) — the contract AND the transcription source. Epic: [kpr-345-spec.md](./kpr-345-spec.md) §D9 (this child's charter). Evidence baseline for every §D3 citation: epic branch `kpr-345` @ `4d2a9de` (KPR-351 merge) — **verified current at plan time: worktree HEAD is `4d2a9de`, no `src/` changes since.** If the epic branch advances before delivery, re-verify the §D3 citations against the new tip before transcribing (spec G2); a moved citation is a spec-lane question, not a silent doc edit.

**Goal:** Ship the public engine doc **`docs/providers.md`** ("Supported providers & parity matrix"): 16 capability rows + a validation-status row × 5 provider columns, every cell `full | caveat(note) | claude-only | n/a`, transcribed cell-by-cell from spec §D3; plus the ruled non-goals (§D4), out-of-scope rulings + revisit triggers (§D5), and per-provider validation status. Same pass: correct the two stale doc surfaces (§D6) — `docs/architecture.md`'s pre-KPR-348 "tool-free pilots"/`GeminiAdkAdapter` passages and CLAUDE.md's `:effort` sentence. **Zero runtime code changes** (spec Non-goals; ⚠ A1/A2 are documented caveats, not fixes).

**Shape:** doc-only. The spec is the research artifact — the doc writer transcribes §D3, they do not re-research. The only content judgments this plan itself rules on (so the writer doesn't have to) are pinned in the "Plan-ruled cell resolutions" block below; everything else copies from the spec.

**Decision-register canon honored:** every canon line ending in a "KPR-355 matrix" obligation is already baked into a §D3 cell (spec header confirms the sweep: KPR-349 recall-name edges + toolkit fail-soft honesty, KPR-353 stateless-replay/effort-gated-reasoning/`maxTurns:0`/§D7 facts, KPR-350 openai row facts, KPR-352 gemini retention/coercion/auth facts, KPR-354 subagent rows + Task-builtin delta, KPR-346 entry-2 live-unvalidated caveat, KPR-351 C6 provisioning gate + R2 "unit-pinned, no live exercise" wording). Transcription fidelity IS the canon compliance mechanism — hence the mandatory row-by-row fidelity check (Task 5).

## Plan-ruled cell resolutions (spec-review advisories — the writer follows these, not their own judgment)

1. **Row 6, Lane A cell value is `caveat(tool-search off; eager schemas only)` — NOT `full`.** Spec §D3 Row 6's first line reads "claude, kimi/deepseek: `full` — …" and then overrides Lane A at the end of the sentence ("→ note as `caveat(...)` for Lane A"). The `full` lead token belongs to the claude column ONLY. Final Row 6 cells: claude `full` (tool-search deferral available per KPR-329); kimi/deepseek `caveat(tool-search off; eager schemas only)`; openai/gemini/codex `caveat(128-tool cap, two-tier)` with the honesty footnote (assembly-time toolkit vs connect-time fail-soft).
2. **Row 15 merges into ONE cell per column** — the spec states it as two half-rows ("All five: `full` for breaker/outage/attribution" + per-provider usage/cost caveats); the doc must not ship it that way. Final Row 15 cells: claude `full`; kimi/deepseek `caveat(costUsd nominal — Claude pricing math)`; openai `caveat(token counts report 0)`; gemini `caveat(costUsd 0; real token counts)`; codex `caveat(costUsd 0; real token counts)`. One shared footnote carries the whole-row truth: circuit breaker, honest-outage queue, and telemetry attribution are **full on all five columns**, keyed on the route provider (a kimi outage trips the `kimi` breaker only; tool/assembly faults never trip; `llmMs` excludes tool time on every tool-executing lane) — the caveats scope to usage/cost reporting only. The openai footnote may note this is a flagged follow-up candidate (spec ⚠ A2), without a ticket number in the matrix body.
3. **Row 5's claude cell drops `Task`** for row orthogonality — it lists WebFetch/WebSearch/NotebookEdit/TodoWrite only; Row 11 owns subagents/Task entirely. (Spec review authorized this drop.)
4. **The public doc carries NO `src/…` file:line citations** — spec §Edge-cases rules this explicitly ("don't — the public doc states behavior; file:line stays in this spec"). Notes name behaviors and, where useful, plain mechanism nouns (e.g. "hive-persisted replay history", "the tool bridge"); never paths-with-line-numbers. Ticket references stay out of the matrix; the trailing History line names the KPR-345 epic.
5. **Validation status ships as the final matrix row** (row 17), not a standalone section — spec §D1 item 7 leaves this as the writer's polish call; this plan pins the single-table form for one-glance readability. Cell values use spec §D3 Row 17's canon-bound wording verbatim, subject to the Task 5 A4 refresh.

---

## Testing Contract

### Required Test Groups

- Unit: **not required** — no runtime code is created or modified; there is no unit surface. (Spec Non-goals: "Any runtime code change." Task 5 proves the zero-code-diff by git.)
- Integration: **not required** — same rationale; nothing crosses a module boundary.
- E2E: **not required** — no behavior to exercise; the doc documents behavior already validated by KPR-346–354/351.

### What replaces them (doc-only verification, all mandatory)

1. **`npm run check` green** — docs are outside the TS build, but the gate is the workflow standard and cheap; run it with the env stubs at every commit. Expected: exit 0, trivially (no compiled surface changes).
2. **Zero-code-diff proof** — `git diff 4d2a9de..HEAD --stat -- src/` → **empty output**. The whole child's diff is `docs/providers.md` (new), `docs/architecture.md`, `CLAUDE.md`, and this epic-docs directory.
3. **Cell-fidelity self-check (Task 5)** — the writer re-reads spec §D3 row by row against the shipped matrix and checks off all 17 rows × 5 columns: cell value token correct (`full`/`caveat`/`claude-only`/`n/a`), note substance preserved, no invented content, no dropped canon-bound clause. Recorded as a checklist in the PR description.
4. **Citation-policy check** — `grep -nE 'src/[A-Za-z0-9_/.-]+\.ts' docs/providers.md` → **no matches** (no source paths in the public doc; ruling 4 above).
5. **Staleness-purge greps** — `grep -n 'tool-free\|GeminiAdk\|until the provider tool bridge lands' docs/architecture.md` → **no matches**; `grep -n 'applies to codex/openai' CLAUDE.md` → **no matches**.
6. **Markdown rendering sanity** — `awk -F'|' '/^\|/ {print NF}' docs/providers.md | sort -u` prints exactly **one** value (every table line has the same column count — 7 fields for a 5-column matrix with row labels); visually confirm the rendered table (any markdown preview) has no broken pipes and each `caveat(note)` stays on one line (long notes go to footnotes per §D1).

### Commands

- Full gate (every commit): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0.
- Verification greps: as listed above, run in Task 5 with expected outputs recorded.

### Harness Requirements

- `npm ci` in the worktree if `node_modules` is absent. Node 22/24 (dev-mode Node 26 broken per KPR-344). No credentials, no network, no Mongo — nothing in this child touches a live surface.

### Non-Required Rationale

- Unit/Integration/E2E: doc-only child — no runtime diff exists to test (proven by the zero-code-diff check, item 2 above).

### Verification Rules

- If any §D3 citation no longer matches the epic-branch tip at delivery time (branch moved), STOP and surface it — re-verify or demote to the spec lane; never "fix" a cell to match drifted code silently.
- If a transcription check exposes a spec-internal contradiction not covered by the four plan rulings above, surface it to the reviewer — do not adjudicate new content questions inside the implement lane.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/providers.md` | create (Tasks 1–2, refresh in Task 5) | The parity matrix doc — legend, 17-row × 5-column matrix, footnotes, ruled non-goals, out-of-scope, revisit triggers, History line |
| `docs/architecture.md` | modify (Task 3) | §D6.1 staleness corrections: flow-diagram line 20, overview line 27, key-files line 43, §"Provider tool transport compatibility" block (87–99); cross-link to `docs/providers.md` |
| `CLAUDE.md` | modify (Task 4) | §D6.2: the one `:effort` sentence at line 243 — nothing else in the paragraph |

**NOT touched:** anything under `src/` (zero-code-diff proven in Task 5); all test files; `docs/managing-your-hive.md` (how-to home, spec Non-goals); `docs/troubleshooting.md`; CLAUDE.md's provider-adapters paragraph beyond the one sentence (current and accurate — spec Non-goals); the Lane B session-handoff notice variant (spec §D6.3 — recorded code-change follow-up, explicitly out of this doc child).

---

## Task 1 (Chunk 1): `docs/providers.md` — structure, legend, the 17-row matrix, footnotes

**Files:**
- Create: `docs/providers.md`

- [ ] **Step 1.1: Scaffold the doc per spec §D1**

Title: `# Supported providers & parity matrix`. Section order (spec §D1 item "Structure of the doc"):
1. Intro + two-lane model in ~6 lines: route grammar `<provider>/<model>[:<effort>]`, bare id → Claude, unknown prefix → Claude fallback; Lane A (kimi/deepseek — full Claude runtime via vendor Anthropic-compat endpoints, per-spawn env substitution) vs Lane B (openai/gemini/codex — native provider loops executing real hive tools through the tool bridge), one paragraph each.
2. Cell legend, defined once above the matrix, verbatim from epic §D9: `full` | `caveat(note)` | `claude-only` | `n/a`.
3. The matrix (Step 1.2).
4. Footnotes (Step 1.3).
5.–7. Ruled non-goals / Out of scope / Revisit triggers (Task 2).
8. History line (Task 2).

Tone: matches `architecture.md` — factual, present-tense, **no ticket numbers in the matrix or notes** (History line only). Audience per §D1: operators choosing an agent's `model` field + commercialization prospects ("are we locked into Anthropic?").

- [ ] **Step 1.2: Transcribe the matrix — 17 rows × 5 columns from spec §D3**

Columns exactly: `claude` · `kimi / deepseek (Lane A)` · `openai` · `gemini` · `codex`. Rows 1–16 in spec §D2 order plus Row 17 (Validation status) as the final row (plan ruling 5). For every cell: copy the value token and note substance from the matching §D3 row — shortening prose for in-table fit is fine; changing a value token, dropping a canon-bound clause, or adding unsourced content is not. Strip all file:line evidence (plan ruling 4). Apply the four plan rulings:

  - [ ] Row 5: claude cell lists WebFetch/WebSearch/NotebookEdit/TodoWrite — **no Task** (ruling 3)
  - [ ] Row 6: Lane A cell is `caveat(tool-search off; eager schemas only)` — **not** `full` (ruling 1)
  - [ ] Row 15: single merged cell per column with the values pinned in ruling 2; whole-row breaker/outage/attribution truth goes to a shared footnote
  - [ ] Row 17: §D3 Row 17 canon wording verbatim — claude `production (baseline)`; codex `production-validated`; gemini `live-validated (dev key); production gated on paid tier`; openai `unit + 401-boundary; live legs key-conditioned, open`; kimi/deepseek `live-unvalidated; production reassignment gated on funded-key validation` (subject to the Task 5 A4 refresh)

Rows with heavy notes (10 — resume; 11 — subagents; 12 — effort) will not fit in-table: keep the cell to `caveat(short-tag)` + footnote marker, and carry the full §D3 substance in the footnote (next step). The §D3 Row 10 closing line (cross-provider reassignment = fresh session + memory-handoff annotation; codex also clears replay history) applies to all columns — carry it as a row-level footnote, not five repeated cells.

- [ ] **Step 1.3: Footnotes section**

One footnote per marker used in Step 1.2 (§D1: notes over ~1 line go here). Must-carry substance (all from §D3 — verify each against its row during Task 5):
  - Row 6 honesty note: toolkit prompt renders from the assembly-time inventory; bridge connects are runtime fail-soft — a listed server can be absent for one turn (omission-logged).
  - Row 8 memory-name notes: Lane B's qualified `mcp__structured-memory__memory_recall` (staleness edge if ever renamed) vs the Claude lane's bare-name imprecision (documented; the callable tool is the qualified name).
  - Row 10 per-provider resume mechanics (openai 7d horizon + ZDR caveat + "chain-orphan closure unit-pinned, no live exercise"; gemini 1d free-tier retention degradation; codex hive-persisted replay + `maxTurns: 0` zero-POST divergence + §D7 heal) + the all-columns fresh-session/handoff footnote.
  - Row 11: general-purpose Task = claude-only; `spawnBudget ≥ 2` for Lane B delegates; nested-turn observability note; per-agent account-provisioning gate (lane-symmetric).
  - Row 12: openai `:effort` parsed-but-not-delivered (⚠ A1 truth); codex effort-gated encrypted-reasoning replay; gemini coercion.
  - Row 15 shared ops footnote (ruling 2) incl. the openai zero-token-counts truth (⚠ A2).
  - Row 16 auth one-liners (Lane A endpoint/key/default-model table from §D3 Row 16; openai `.env`-only; gemini paid-tier-key-for-production warning — free tier trains on data).

- [ ] **Step 1.4: Verify + commit**

`awk -F'|' '/^\|/ {print NF}' docs/providers.md | sort -u` → one value. `grep -nE 'src/[A-Za-z0-9_/.-]+\.ts' docs/providers.md` → empty. `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` → exit 0.

```bash
git add docs/providers.md
git commit -m "KPR-355: docs/providers.md — supported providers & parity matrix (17 rows x 5 columns, spec §D1-D3 transcription)"
```

---

## Task 2 (Chunk 2): `docs/providers.md` — ruled non-goals, out-of-scope, revisit triggers, History

**Files:**
- Modify: `docs/providers.md`

- [ ] **Step 2.1: "Ruled non-goals" section** — transcribe spec §D4's three items with their one-line rationales: (1) translation proxies (LiteLLM, claude-code-router) in production Lane A; (2) cross-provider history carry (fresh session + memory-handoff annotation is the bridge; codex replay history cleared on handoff); (3) catalog-driven per-turn effort tuning for foreign models (static `:effort` only).

- [ ] **Step 2.2: "Out of scope (epic rulings)" section** — transcribe spec §D5's four rulings: voice pinned to the Claude lane (code-enforced; voice turns on a non-Claude agent run the engine's default Claude model — post-matrix revisit); openai-compatible sidecar providers for `src/llm/` one-shot calls; Gemini Managed Agents (preview); cost/pricing normalization.

- [ ] **Step 2.3: "Revisit triggers" subsection** — the four recorded triggers from §D5: sessions TTL >30d or >30d continuity ⇒ Conversations re-evaluation (new ticket); Interactions ships on Vertex ⇒ Vertex auth re-evaluation; OpenAI serves Responses under subscription auth ⇒ new ticket, not a re-add; a future tool-less Lane B provider must re-gate `toolsExecutable` explicitly.

- [ ] **Step 2.4: History line** — one line: matrix ruled and transcribed under the KPR-345 provider-agnostic-runtime epic; evidence baseline `kpr-345` @ `4d2a9de`; future provider children inherit the row-update duty. (This is the one place ticket ids appear.)

- [ ] **Step 2.5: Verify + commit**

Re-run the Step 1.4 checks (table-shape, citation grep, `npm run check`) → same expected results.

```bash
git add docs/providers.md
git commit -m "KPR-355: providers.md — ruled non-goals, out-of-scope rulings, revisit triggers, history line (spec §D4/§D5)"
```

---

## Task 3 (Chunk 3): `docs/architecture.md` staleness corrections (§D6.1)

**Files:**
- Modify: `docs/architecture.md` (ONLY the four cited provider passages + the cross-link — everything else byte-identical)

- [ ] **Step 3.1: Flow diagram (line 20)** — replace `       Tool transport inventory → future provider-specific tool bridge` with:

```
       Claude lane: AgentRunner + direct SDK MCP wiring · Lane B: hive tool bridge (bridged MCP + hive builtins)
```

- [ ] **Step 3.2: Overview sentence (line 27)** — replace the sentence `Claude still receives the direct SDK MCP wiring; non-Claude adapters remain tool-free until the provider tool bridge lands.` with:

```
Claude receives the direct SDK MCP wiring; the Lane B adapters (`openai/...`, `gemini/...`, `codex/...`) execute the same hive tool surface through the hive tool bridge, and the Lane A passthrough providers (`kimi/...`, `deepseek/...`) run the full Claude runtime against vendor Anthropic-compatible endpoints. See [docs/providers.md](./providers.md) for the supported-provider parity matrix.
```

(The trailing `A new AgentRunner instance…` sentence in that paragraph stays verbatim.) This sentence doubles as the §D1-required cross-link.

- [ ] **Step 3.3: Key-files entry (line 43)** — replace the final sentence of the `src/agents/provider-adapters/` bullet (`` `ClaudeAgentAdapter` delegates to `AgentRunner`; `OpenAIAgentsAdapter`, `GeminiAdkAdapter`, and `CodexSubscriptionAdapter` are tool-free provider paths until the tool bridge lands. ``) with:

```
`ClaudeAgentAdapter` delegates to `AgentRunner`; `OpenAIAgentsAdapter`, `GeminiInteractionsAdapter`, and `CodexSubscriptionAdapter` execute real hive tools through the hive tool bridge; `kimi/...` and `deepseek/...` route through the Claude runtime with per-spawn env substitution (Lane A passthrough).
```

- [ ] **Step 3.4: Rewrite §"Provider tool transport compatibility" (lines 87–99)** — replace the whole section body (keep the heading) with a summary-depth account of merged reality, ~3 short paragraphs (the matrix doc owns the detail — end with a pointer to `docs/providers.md`):
  - The tool-transport inventory classifies every tool a turn can see (`direct` | `mcp-bridge-candidate` | `requires-hive-bridge` | `claude-only` | `unsupported`); the compatibility path `Provider adapter → tool transport inventory → hive tool bridge` is **live**, not future.
  - The bridge lives inside hive (not inside each provider adapter): external MCP servers are consumed as MCP clients, in-process engine MCPs ride the same server instances over an in-memory transport, six builtins (Bash/Read/Write/Edit/Glob/Grep) run on a hive-native executor, and every execution crosses one fail-closed guardrail gate. Honeypot/Keychain resolution stays local; `WorkItemContext` is preserved for context-dependent servers.
  - Claude-only tools (WebFetch, WebSearch, NotebookEdit, TodoWrite, general-purpose Task) are partition-omitted with logged reasons — never silently dropped. Claude continues to use direct SDK wiring end-to-end. Full per-capability truth: `docs/providers.md`.

- [ ] **Step 3.5: Verify + commit**

`grep -n 'tool-free\|GeminiAdk\|until the provider tool bridge lands' docs/architecture.md` → **no matches**. `git diff --stat -- docs/architecture.md` shows only the four regions + heading-adjacent lines. `npm run check` (env stubs) → exit 0.

```bash
git add docs/architecture.md
git commit -m "KPR-355: architecture.md provider passages updated to merged two-lane reality + providers.md cross-link (spec §D6.1)"
```

---

## Task 4 (Chunk 4): CLAUDE.md `:effort` sentence (§D6.2)

**Files:**
- Modify: `CLAUDE.md` (ONE sentence at line 243 — nothing else in the paragraph)

- [ ] **Step 4.1: Replace** `The optional `` `:effort` `` suffix (`` `minimal`|`none`|`low`|`medium`|`high`|`xhigh` ``) applies to codex/openai.` **with:**

```
The optional `:effort` suffix (`minimal`|`none`|`low`|`medium`|`high`|`xhigh`) is consumed by codex (`reasoning.effort` — also gates encrypted-reasoning replay) and gemini (`thinking_level`, `none→minimal`/`xhigh→high` coerced), delivered clamped to `{low,medium,high}` on Lane A, and currently parsed-but-not-delivered on openai.
```

- [ ] **Step 4.2: Verify + commit**

`grep -n 'applies to codex/openai' CLAUDE.md` → **no matches**. `git diff -- CLAUDE.md` → exactly one changed sentence in the Provider adapters paragraph. `npm run check` (env stubs) → exit 0.

```bash
git add CLAUDE.md
git commit -m "KPR-355: CLAUDE.md :effort sentence corrected — codex+gemini consume, Lane A clamped, openai parsed-not-delivered (spec §D6.2)"
```

---

## Task 5 (Chunk 5): A4 validation-status refresh, cell-fidelity check, final verification

**Files:**
- Modify (conditionally): `docs/providers.md` (Row 17 cells only)

- [ ] **Step 5.1: A4 refresh — re-read the then-current epic register (MANDATORY, even if it changes nothing).** Spec A4: validation-status wording was transcribed from canon as of 2026-07-24; keys may have been seeded between spec time and delivery. Re-read the epic's Decision Register (the orchestrator-refreshed `.dodi-context/epic-register-entries.md` at the worktree root, or the live epic description canon if the orchestrator provides a fresher copy) for any post-`4d2a9de` entries touching openai/gemini/kimi/deepseek validation status (key seeding, live legs run). If new entries exist: update the affected Row 17 cells (and only those cells) to the then-current canon wording, and record the register entry consumed in the PR description. If none: state "A4 checked — register unchanged since 2026-07-24" in the PR description.

- [ ] **Step 5.2: Cell-fidelity self-check** — re-read spec §D3 top to bottom against the shipped `docs/providers.md`, one row at a time. For each of the 17 rows check: value tokens match per column (with plan rulings 1–3 applied); note substance preserved (footnote or in-cell); nothing invented; nothing canon-bound dropped (use the spec-header canon sweep list as the checklist for the "must-carry" clauses). Also confirm the doc contains everything spec §Verification requires: legend; 5 columns × 16 rows + validation status; footnotes; 3 ruled non-goals; 4 out-of-scope rulings; 4 revisit triggers. Record the row-by-row checklist in the PR description.

- [ ] **Step 5.3: Final verification battery** (record each command + output in the PR description):

```bash
git diff 4d2a9de..HEAD --stat -- src/                                   # expected: empty
grep -n 'tool-free\|GeminiAdk\|until the provider tool bridge lands' docs/architecture.md   # expected: no matches
grep -n 'applies to codex/openai' CLAUDE.md                             # expected: no matches
grep -nE 'src/[A-Za-z0-9_/.-]+\.ts' docs/providers.md                   # expected: no matches
awk -F'|' '/^\|/ {print NF}' docs/providers.md | sort -u                # expected: exactly one value
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check   # expected: exit 0
```

Plus a rendered-markdown eyeball of the matrix (columns align, no broken pipes, footnote markers resolve).

- [ ] **Step 5.4: Commit (only if Step 5.1 changed cells)**

```bash
git add docs/providers.md
git commit -m "KPR-355: A4 validation-status refresh from then-current epic register"
```

---

## Notes for the reviewer (plan-level decisions and their rationale)

1. **The plan transcribes almost nothing from §D3 by design** — the spec is the single transcription source (spec G2, TL;DR); duplicating 17 rows here would create a second divergence surface. The only cell content stated in this plan is what the plan itself had to rule on: the four spec-review-advisory resolutions (Row 6 Lane A token, Row 15 merge, Row 5 Task drop, Row 17 placement).
2. **Row 15's merged values put `caveat` on all four non-claude columns** rather than `full`-with-asterisk: the legend's `caveat(note)` is exactly "works, with a documented delta", and usage/cost reporting is part of the row's capability ("Ops integration … usage/cost reporting" — §D2 row title). Claude keeps `full` as the baseline. The shared footnote prevents the false read that breaker/outage/attribution are degraded off-claude.
3. **Verbatim replacement text for §D6 edits is in-plan** (Tasks 3–4) — unlike the matrix, these are small, judgment-bearing prose edits where reviewer pre-approval of exact wording is cheaper than post-hoc review; the writer may polish phrasing but not facts. The Task 3.4 rewrite is deliberately summary-depth per §D6.1 ("the matrix doc owns the detail").
4. **A4 is a Task-5 step, not a pre-Task-1 step** — the refresh window should close as late as possible (keys could be seeded mid-delivery); putting it last means the final commit reflects the then-current register.
5. **No spike, no tests, no negative-verify legs** — nothing here is executable. The doc-only analog of negative-verify is the staleness-purge greps (they fail on pre-fix content, pass after) and the fidelity checklist.
6. **Delivery-tier recommendation: standard.** The spec pre-bakes every cell (value + note + evidence) and this plan pins all four residual judgment calls; the remaining work is careful transcription and four scoped prose edits, guarded by a mechanical verification battery — no code, no research, no live surfaces. (The plan reviewer makes the binding classification.)
