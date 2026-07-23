# KPR-351 — Production validation: reassign a real agent end-to-end (Luna on keepur, codex surface)

**Child 6 of KPR-345** (two-lane provider-agnostic runtime). Epic spec: [kpr-345-spec.md](./kpr-345-spec.md), esp. §D6 (this child's charter: reassignment via admin surface, validation checklist across the parity dimensions, inverse transition exercising the KPR-313 handoff, spike-notes evidence).
**Shape:** validation runbook + four small in-place refinements. **No net-new subsystem.** The deliverables are (a) recorded live evidence on a production instance, (b) the refinements the sibling reviews assigned here, (c) KPR-355 row-fact updates flipping codex from "mechanism-verified" to "live-validated".
**Depends on:** KPR-348, KPR-349, KPR-350 (filed) — all merged; effectively the whole epic branch (346–350, 352–354, 356) at the pinned tip.
**Binding directives (epic register canon):** HUMAN_DIRECTIVE 2026-07-21 — **subscription-first**: live e2e tool-turn evidence runs on the **codex surface, keepur instance (Luna)**; the `openai/…` flagship live turn is key-conditioned + non-gating (no key purchase). HUMAN_DIRECTIVE 2026-07-23 — **validation ground = keepur, local, epic-branch build**: locally-built engine artifact (`npm run bundle` from the epic worktree → `pkg/`) deployed into `~/services/hive/keepur`, NOT an npm-tag `hive update`; this spec designs the upgrade + rollback mechanics; the ticket-title "candidate: Milo" (dodi) is superseded — dodi is not the test ground.
**Coherence obligations bound here:** KPR-346 (Lane A excluded from live scope), KPR-350 (L1–L3 key-conditioned legs; rule the openai codex-oauth doomed attempt; weigh the chain-orphan advisory; vacuous breaker-leg cleanup), KPR-354 (one delegate turn on codex; enum `subagent_type` live confirmation), KPR-353 §D7 (poisoned-replay behavior binds expectations), KPR-352 (optional non-gating gemini legs; no required analog).

## TL;DR

Deploy the epic-branch engine build onto the live keepur instance via the deploy.sh single-instance path (rsync-fallback from the epic worktree; `.hive.prev` = instant rollback to release 0.10.1), then run a runbook-shaped validation on **Luna** — the lowest-traffic keepur agent, who is *already* assigned `codex/gpt-5.5:medium` in production and has live-proven codex subscription auth (real token counts on her weekly cron under the tool-free release engine). The pass exercises the full flagship arc under the epic build: claude-era baseline → reassignment to codex → tools/memory/skills/resume/delegate/telemetry legs on real Slack traffic → deliberate poisoned-replay observation → inverse transition back to `claude/…` verifying the KPR-313 handoff (fresh session, provider tag flip, `provider_turn_history` cleared) → engine rollback and exact state restore. Alongside the runbook, four bounded code changes land: delete the openai adapter's spike-proven-doomed codex-oauth attempt, close the KPR-350 chain-orphan window with a post-lock store re-read in the stale-heal arm, strengthen the vacuous breaker record-once test leg, and (key-conditioned) refine `isStaleServerHandleError` against the live L2 capture.

## Key Points

- **Validation, not engineering.** Gating scope = the codex surface on keepur/Luna (subscription-first directive). The openai L1–L3 + flagship legs and the gemini legs are specified but key-conditioned/optional and **non-gating**. Lane A (kimi/deepseek) is **excluded** from live scope (KPR-346 canon: V2–V6 deferred, no funded vendor keys) — its matrix rows stay live-unvalidated.
- **Observed baseline changes the runbook's shape (verified 2026-07-23, read-only):** keepur runs release **0.10.1**; Luna's production model is **already `codex/gpt-5.5:medium`** (tool-free pilot under 0.10.1 — her only traffic is a Friday 14:30 memory-hygiene cron, and those turns complete with real token usage, proving codex OAuth works live on this instance). She has `delegateServers: []`, no archetype/autonomy config, budget = `maxConcurrent: 3` (≥ 2, delegate-capable). The flagship claude→codex transition is therefore *staged* by the runbook (baseline her on claude first), not inherited.
- **Upgrade mechanics (§D1): deploy.sh's own developer path, single-instance mode.** `npm run check:bundle` in the epic worktree → invoke the worktree's `service/deploy.sh` with `HIVE_SINGLE_*` env for keepur + `BUILD_DIR=<epic worktree>` + a non-registry sentinel tag, which deterministically routes fetch_engine to its rsync-from-`$BUILD_DIR` fallback. Everything else — bootout, port drain, `npm install --omit=dev`, `.hive` rotation, health-check with auto-rollback — is the shipped script, not runbook re-implementation. Rollback at any point = `hive rollback` (restores `.hive.prev` = 0.10.1). Engine swap touches only `<instance>/.hive/`; agent defs, sessions, memory, history all live in MongoDB and are untouched by construction (deploy.sh evidence cited in §D1).
- **Blast radius bounded (§D2):** only Luna's definition is mutated (via the token-gated admin REST API, which records version history); the engine swap affects all four keepur agents for the window, mitigated by: epic tip CI-green + Claude-lane golden gates, a Hermi Claude-lane smoke turn as a hard gate before any validation, a low-traffic window, same-pass rollback, and a pre-pass `mongodump` as belt-and-braces. Known accepted regression: the epic tip is 3 commits behind main (slack snippet-download fix #324, linear label mgmt #325) — absent for the window only.
- **The validation matrix (§D4)** covers every R3 parity dimension live on codex: tool turn (C1), stateless-replay continuity incl. encrypted-reasoning items (C2), memory hot-tier + `mcp__structured-memory__memory_recall` (C3), skills index + `load_skill` — which also live-checks the legacy double-`skills/` layout through the Lane B index (C4), guardrail posture (C5 — structural: Luna has no archetype ⇒ allow-all is *correct*; deny path stays unit-pinned, no unrepresentative config mutation), delegate Task turn with enum `subagent_type` (C6, temp `brave-search` delegate), deliberate poisoned-replay self-heal (C7 — mid-thread model flip, the KPR-353 §D7 canonical case), telemetry honesty (C8).
- **Inverse transition (§D5)** is gating: codex→claude on the live thread must show the KPR-313 guard warn, a fresh claude session with a real handle, and the thread's `provider_turn_history` cleared; the restore flip back re-trips the guard (free second data point).
- **Rulings (§R):** R1 — **delete** the openai adapter's codex-oauth attempt (spike-proven 401; openai lane becomes API-key single-path with an explicit auth-classified missing-key throw, gemini §D7 precedent). R2 — chain-orphan advisory **in scope**: post-lock `sessionStore` re-read in the stale-heal arm (adopt a contender's healed handle instead of orphaning it). R3 — strengthen the vacuous record-once breaker leg with a `record` spy. R4 — **roll back to the release engine at pass end** and **restore Luna's observed pre-pass definition exactly** (status quo ante); keeping the epic build is May's explicit call at the G3 gate, not a default.
- ⚠ Delegated assumptions (§Open): `ADMIN_API_TOKEN` availability on keepur (fallback: direct Mongo update + SIGUSR1); `brave-search` delegate-eligibility for C6 (fallback: another catalog-eligible tier-2 server); epic-branch rebase onto main before the pass is recommended but not required (re-pin the SHA if taken); L2's exact stale-handle string remains docs-sourced until the key-conditioned leg runs.

## Observed baseline (read-only evidence, 2026-07-23)

| Fact | Evidence |
|---|---|
| keepur engine 0.10.1, launchd label `com.hive.keepur.agent`, runs `.hive/pkg/server.min.js`, cwd `~/services/hive/keepur`, logs `logs/hive.log` | `.hive/package.json`, `launchctl print` |
| Luna: `_id: luna`, model `codex/gpt-5.5:medium`, coreServers = universal-9-minus-admin + brave-search + browser, `delegateServers: []`, no `archetype`/`autonomy`, `maxConcurrent: 3` (no `spawnBudget`), schedule = `memory-hygiene-review` cron Fri 14:30 | `agent_definitions` export |
| Luna's codex turns complete live under 0.10.1 (tool-free): 246 in / 253 out tokens on 2026-07-17 cron turn — **codex subscription OAuth (`~/.codex/auth.json`, same user as launchd session) is production-proven on this instance** | `agent_turn_telemetry` |
| Luna's `sessions` rows: `provider: "codex"`, `sessionId: ""` (stateless pilot, correct) | `sessions` export |
| Other agents: Hermi (opus, delegate `google`), Alexandria + Samantha (sonnet) — all Claude-lane | `agent_definitions` export |
| Admin REST API: `PATCH /admin/agents/:id` (Bearer `config.adminApi.token`, port = portBase+4 = **3304**), records `agent_definition_versions`, `POST …/rollback` exists | `src/admin/admin-api.ts`, `src/config.ts:414` |
| Ports for single-instance deploy: 3300–3306 (portBase 3300, +0..+6) | `hive.yaml`, `single-instance-env.ts` |
| No deploy-check automation on this machine (no cron entry, no LaunchAgent) — nothing can clobber the epic build mid-pass | crontab + `~/Library/LaunchAgents` scan |
| Epic tip (c2f8e4e at draft time) is NOT a descendant of v0.10.1; main-only commits: #324 (slack snippet download), #325 (linear labels), release bump. Epic `package.json` reads 0.10.0 | `git merge-base` |
| Customer-space skill: `memory-hygiene-review` (`agents: ["*"]`), **legacy double-`skills/` layout** | `~/services/hive/keepur/skills/` |
| `mongodump`/`mongoexport` available; no mongosh on PATH | shell probe |

## Goals

- G1: The epic-branch engine runs healthily on keepur (deploy, health gates, Claude-lane smoke), with a rehearsed instant rollback.
- G2: Flagship arc live on Luna/codex: staged claude baseline → reassignment → all gating matrix legs (C1–C8) → inverse transition with KPR-313 evidence → exact restore.
- G3: The four assigned refinements land: R1 openai auth simplification, R2 chain-orphan re-read, R3 record-once test strengthening, and (key-conditioned) the L2 matcher refinement.
- G4: Evidence recorded in `kpr-351-spike-notes.md` (per-leg contract, §D6); KPR-355 row-fact deltas recorded (codex → live-validated; openai/gemini/Lane A statuses restated honestly).
- G5: Non-gating legs specified and attempted where cheap: openai L1–L3 + flagship (key-conditioned), gemini expiry-observation + delegate (optional), KPR-354 enum confirmation (part of C6).

## Non-goals

- Any net-new subsystem, adapter change beyond §R's refinements, or bridge/assembly/session-store edits.
- Lane A (kimi/deepseek) live validation — excluded per KPR-346 canon (funded-key gated).
- Production reassignment as a *lasting* state change: the pass restores Luna's observed definition and the release engine (R4); making any of it permanent is an operator decision outside this ticket.
- dodi instance — anything. The revenue instance is not touched.
- The parity matrix document itself (KPR-355) — this child hands it row facts.
- Voice legs (voice pins the Claude lane — epic ruling), cron-schedule redesign, performance benchmarking.
- Forcing a live guardrail *denial* via unrepresentative config mutation (C5 rationale in §D4).

## §R — Rulings on the assigned dispositions

- **R1 — openai adapter codex-oauth attempt: DELETE.** `buildAuthAttempts` currently tries `createCodexOpenAITokenProvider` first (`openai-agents-adapter.ts:200-215`); the KPR-348 spike proved the codex subscription token 401s against `api.openai.com` Responses — the attempt can only burn a doomed network round-trip per turn and keeps a dead org-affinity hazard alive (KPR-350 §Edge). Ruling mirrors KPR-352 §D7's Vertex deletion (surface-driven single-path auth): remove the oauth attempt, `preferOAuth`/`codexAuthPath`/`codexRefreshCommand` options, and simplify `runWithAuthFallback` to the single API-key path; add an explicit pre-request throw when no `OPENAI_API_KEY` resolves, message shaped to the existing auth-row alternate (`… API key is not available; set OPENAI_API_KEY (hive credentials add)`) so persistent misconfig fast-fails into the honest-outage path (codex/gemini posture). `createCodexOpenAITokenProvider` itself stays — the codex adapter is its consumer. Revisit trigger recorded: if OpenAI ever serves Responses under subscription auth, re-adding is a new ticket.
- **R2 — chain-orphan advisory: IN SCOPE (bounded).** Failure shape: two same-thread turns both resolve the same stale handle pre-lock; the first heals and persists a fresh chain head; the queued second then trips the stale-heal arm and retries *fresh*, orphaning the healed chain (one exchange of context lost, and the healed handle overwritten). Fix at the arm (`agent-manager.ts` stale-heal branch): before the fresh retry, re-read `sessionStore.get(agentId, threadId)` (post-lock ⇒ authoritative — the KPR-313 adopt-branch's own idiom); if it holds a different non-empty handle than `effectiveCtx.sessionId`, retry **with** that handle (adopt); else retry fresh as today. Single retry semantics, record-once, and the auth-rebuild arm are untouched. Unit-tested (T2).
- **R3 — vacuous breaker record-once leg: IN SCOPE (test-only).** The KPR-350 leg (`agent-manager.test.ts:2967`) asserts streak 0 after stale→success and stale→failure — but both classifications are non-provider, so the assertion passes even if the first attempt *were* recorded. Strengthen with a `circuitBreakers.record` spy: exactly one record per spawnTurn, argument classification = the finalized attempt's.
- **R4 — end-state: roll back + restore.** At pass end the release engine (0.10.1, from `.hive.prev`) is restored and Luna's definition is re-set to the *observed pre-pass export* (re-captured at Phase 0, not assumed from this spec). Rationale: an unreleased engine has no business running a production instance indefinitely, and a validation ticket has no mandate to change production posture. Two explicit May-decision points at G3 (recorded in spike notes, no default drift): keep the epic build until the epic releases (skips a rollback/redeploy cycle if the epic PR is imminent), and/or park Luna on `claude-sonnet-4-6` instead of tool-free codex until release. Residual `provider_turn_history` docs after rollback are inert to 0.10.1 and TTL-reap in 7d — left alone.
- **R5 — L2 matcher refinement: key-conditioned, in place.** If the openai legs run and the live stale-handle payload doesn't match `isStaleServerHandleError`, refine the matcher in this ticket (KPR-350 §D3 delegation). No key ⇒ no-op, matcher ships as-is (status-quo worst case already accepted by KPR-350).

## Design

### D1 — Upgrade + rollback mechanics (the 2026-07-23 directive's design ask)

**Build (epic worktree, pinned SHA recorded in spike notes):**
1. `npm ci` (if node_modules stale) then **`npm run check:bundle`** — bundle + the four bundle gates (strings, pack, runtime, qdrant-stub). This is the artifact gate; a red gate is a hard stop before any instance contact.
2. Note: epic `package.json` reads **0.10.0** while keepur runs 0.10.1 — the deployed engine will *display* an older version. Identification is by content, not version string: post-swap, write `~/services/hive/keepur/.hive/BUILD_INFO` (`kpr-345 epic <sha> <date>`) and record the SHA in spike notes. The 2-commit main delta (#324, #325) is accepted for the window (Key Points); ⚠ if the driver rebases the epic branch onto main first (recommended, not required), re-pin and rebuild.

**Deploy (single-instance mode, the script's own path — nothing re-implemented):**
```bash
cd <epic-worktree>
HIVE_SINGLE_INSTANCE=1 HIVE_SINGLE_ID=keepur HIVE_SINGLE_CONFIG=hive.yaml \
HIVE_SINGLE_LOGS=logs HIVE_SINGLE_PORTS="3300 3301 3302 3303 3304 3305 3306" \
HIVE_SINGLE_ROOT=$HOME/services/hive/keepur \
BUILD_DIR=<epic-worktree> \
  ./service/deploy.sh --tag=0.0.0-kpr351-local
```
Mechanism: `fetch_engine` first tries `npm pack @keepur/hive@0.0.0-kpr351-local` — a version that cannot exist in the registry — and on that failure takes its documented developer-ergonomics fallback: rsync `pkg/ seeds/ templates/ install/ service/ scripts/honeypot package.json` from `$BUILD_DIR` into `.hive.next/`, sanity-checked on `pkg/server.min.js`. The script then runs its shipped sequence: `launchctl bootout` (true unload — KeepAlive can't respawn mid-swap), port drain 3300–3306, `npm install --omit=dev` in `.hive.next/` (runtime externals incl. `@google/genai`), `.hive` → `.hive.prev` rotation, `bootstrap`, and the KPR-185/240 offset-anchored health check with **automatic rollback on failure**. Single-instance mode structurally cannot touch dodi (no instances.conf read).

**Why this instance-state is safe by construction:** deploy.sh's swap operates on `<root>/.hive{,.prev,.next}` only; `hive.yaml`, `.env`, `plugins/`, `skills/`, `agents/`, `logs/` live at the instance root, and all agent/session/memory/history state is in MongoDB (`hive_keepur`) which no deploy step touches. Belt-and-braces anyway (Phase 0): `mongodump --db hive_keepur` to the session scratchpad + a `mongoexport` snapshot of Luna's full definition (the restore artifact for R4).

**Rollback (rehearsed, three layers):**
1. Automatic — health-check failure inside deploy.sh boots the old engine back (`.hive.prev` restore, failed build preserved in `.hive.broken`).
2. Operator — `cd ~/services/hive/keepur && hive rollback` at any later point (the post-swap `hive` CLI is the epic build's; `runRollback` drives the same deploy.sh `--rollback` short-circuit in single-instance mode). Post-swap gate: verify `.hive.prev/pkg/server.min.js` exists and `.hive.prev/package.json` reads 0.10.1 **before** proceeding past G1.
3. Data — the Phase-0 mongodump (expected unused; engine swaps are data-free).

**Restart primitive for def changes:** the admin API's PATCH triggers the registry reload callback; `kill -USR1 $(launchctl print gui/$(id -u)/com.hive.keepur.agent | awk '/pid/ …)` (or pgrep on the server.min.js path) is the belt-and-braces reload. ⚠ Plan verifies PATCH→reload wiring once; if absent, SIGUSR1 after every PATCH.

### D2 — Blast radius, window, and abort conditions

- **Mutation surface:** Luna's `agent_definitions` doc only (model field; temporarily `delegateServers` for C6) — via `PATCH /admin/agents/luna` (Bearer `ADMIN_API_TOKEN`, port 3304), which snapshots prior versions to `agent_definition_versions`. Every mutation in the runbook has its inverse recorded next to it in the spike notes *before* it is applied.
- **Window:** May schedules it (G0 gate); low-traffic hours; target one working session end-to-end (deploy → validate → restore same day). Luna's Friday 14:30 cron is avoided or observed deliberately (a cron turn on the epic build is a bonus non-gating data point, not a hazard — KPR-353 covers reflection/cron turns).
- **Abort conditions (any ⇒ `hive rollback` + Luna-def restore + spike-notes record):** (A1) deploy health-check failure (auto); (A2) post-deploy `hive doctor` datastore-identity failure; (A3) Claude-lane degradation — Hermi/Alexandria/Samantha turn errors or a `claude` breaker episode in `circuit_breaker_stats`/`hive.err`; (A4) Luna's live behavior harmful beyond her own channel (she is the validation subject — garbage *replies* in #agent-luna are evidence, not aborts; anything reaching other channels/tools destructively is an abort); (A5) May says stop.
- **Non-Luna agents on the epic engine:** accepted for the window — Claude-lane behavior is golden-gated byte-identical through KPR-349/354 and the epic tip is CI-green; the C0 smoke turn is the live confirmation gate.

### D3 — Runbook phases and gates

| Phase | Content | Gate to proceed |
|---|---|---|
| **P0 pre-flight** | Pin SHA; `npm run check:bundle`; mongodump + Luna-def export + `sessions`/`provider_turn_history` thread-state snapshot; verify `ADMIN_API_TOKEN` + admin API reachable (GET /admin/agents); verify `.codex/auth.json` present; re-verify no deploy automation; May confirms window | **G0** (May) |
| **P1 deploy** | §D1 deploy; BUILD_INFO stamp; `.hive.prev` verified; `launchctl` state + "Hive is running" marker; `hive doctor` (datastore identity PASS); **C0**: one Hermi Claude-lane smoke turn in #agent-hermi (tools + reply) | **G1** |
| **P2 staging** | PATCH Luna → `claude-sonnet-4-6`; new validation thread in #agent-luna; one baseline claude turn (plant a recall fact); verify `sessions` row → `provider: "claude"`, real handle. Then PATCH Luna → `codex/gpt-5.5:medium`; next turn in the SAME thread ⇒ **KPR-313 claude→codex handoff observed** (guard warn log, fresh session, `sessionHandoff` annotation path, history clear no-op) | **G2a** |
| **P3 matrix** | Legs C1–C8 (§D4) on the validation thread(s) | **G2b** (all gating legs GREEN) |
| **P4 inverse** | §D5: PATCH Luna → `claude-sonnet-4-6`; same-thread turn ⇒ codex→claude handoff verified (guard warn, `provider_turn_history` cleared, claude session minted); one more claude turn resumes the new claude session | **G2c** |
| **P5 restore** | `hive rollback` → 0.10.1 verified healthy (health marker + doctor + Hermi smoke); PATCH Luna → observed P0 definition (model + delegateServers); final state diff vs P0 snapshot = empty; May's two G3 decision points recorded | **G3** (May) |
| **P6 non-gating** | Key-conditioned openai legs (§D4 L-series) and optional gemini legs — only if credentials resolve and the window allows; skippable without affecting DRAFT→Done | — |

### D4 — Validation matrix (P3 legs; all on Luna/codex unless noted)

Gating legs (each with the §D6 evidence contract):

- **C1 — tool turn:** Slack message asking Luna for something requiring ≥1 real tool (e.g. a contacts or brave-search lookup). Verify: correct reply in-channel; `agent_turn_telemetry` row with `provider`-attributed model, `toolCalls ≥ 1`; `hive.log` bridge/dispatch lines redaction-clean.
- **C2 — continuity (stateless-replay):** second message, same thread, requiring the P2 planted fact + turn-1 context. Verify recall in the reply; `provider_turn_history` doc `{agentId: "luna", threadId, provider: "codex"}` with appended whole turns; **reasoning items with `encrypted_content` present** (Luna's `:medium` effort ⇒ effort-gated replay is exercised — KPR-353 canon); `sessions` row still `sessionId: ""`.
- **C3 — memory:** hot-tier content visible in behavior (instructions carry the memory block) and a turn that drives `mcp__structured-memory__memory_recall` (the KPR-349 §D5 Lane B tool name) returns real memories.
- **C4 — skills:** ask Luna to run her memory-hygiene review (or trigger the schedule task). Verify the skill index reached her instructions and `load_skill` returns the SKILL.md content. **This leg doubles as the legacy-layout check:** keepur's only skill sits in the deprecated double-`skills/` layout — if `deriveProviderSkillIndex` misses it, that is a genuine parity finding (file or fix per size; a loader-side miss is likely out of "small refinement" scope ⇒ follow-up ticket + matrix caveat).
- **C5 — guardrails (structural):** Luna has no archetype ⇒ the gate's allow-all branch is her *correct* production posture; every bridged call passes through `wrap()`'s gate unconditionally (KPR-348 merged pins: fail-closed, throw-is-deny). Live evidence limited to "gate in path" (spawn-time gate construction log + C1's tool calls flowing through it). **Ruled: no live denial leg** — forcing one requires assigning an unrepresentative archetype; the deny path stays unit-pinned. Matrix-noted honestly.
- **C6 — delegate turn (KPR-354 obligation):** PATCH Luna `delegateServers: ["brave-search"]` (⚠ plan verifies catalog delegate-eligibility; fallback: any other eligible tier-2 server configured on keepur), reload, ask Luna to delegate a lookup. Verify: synthesized `Task` tool advertised (enum-restricted `subagent_type` — **the live enum-acceptance confirmation KPR-354 delegated here**); nested turn completes (completion info log, route-keyed); budget accounting visible (`maxConcurrent: 3` ⇒ no saturation expected); nested turn leaves `sessions`/`provider_turn_history` untouched. Revert `delegateServers` after the leg. If the codex backend rejects the enum schema: record it, apply KPR-354's pre-authorized fallback (plain string + runner-side validation, a one-line schema change) — in scope by that spec's own contingency.
- **C7 — poisoned-replay self-heal (KPR-353 §D7, made deliberate):** on the (non-empty-history) validation thread, PATCH Luna's model to `codex/gpt-5.4-mini:medium` and send a turn — the canonical mid-thread model change. Two acceptable outcomes, both recorded: (a) backend 4xx on foreign encrypted reasoning ⇒ exactly one fresh retry + history clear (warn log) and a coherent reply — §D7 proven live; (b) backend tolerates the replay ⇒ no self-heal fires, observation recorded (the containment stays unit-pinned). Restore the model to `codex/gpt-5.5:medium` after. Non-gating on *which* outcome; gating that the thread survives either way.
- **C8 — telemetry honesty:** across C1–C7 rows: `llmMs = durationMs − toolMs` shape holds (tool time excluded from the breaker's food), usage nonzero and single-counted, `costUsd` 0, `toolSummary` populated; `circuit_breaker_stats` for codex stays closed throughout.

Key-conditioned, non-gating (P6 — run only if `OPENAI_API_KEY` resolves via `hive credentials list` / Honeypot; no purchase):

- **L0 — openai flagship tool turn** (closes KPR-348 T0b's deferred live half): one real `openai/…` turn with a tool call, on a scratch agent or a temporarily-flipped Luna.
- **L1 — two-turn resume:** turn 2 carries `previous_response_id`, context recalled; `sessions` handle rewritten.
- **L2 — stale-handle capture:** fabricate/expire a `resp_` handle; capture the exact error payload; confirm `isStaleServerHandleError` matches — refine in place if not (R5); confirm one fresh retry + recovery.
- **L3 — posture acceptance:** `store: true` + `truncation: "auto"` accepted; chain advances across a tool-loop turn.

Optional, non-gating (gemini — only if the pass has slack and a dev key resolves; production gemini stays paid-key-gated):

- **N1 — genuine-expiry observation:** resume the KPR-352 T0 dev-key thread's now->1d-idle handle; record the live status/payload (the suspected 403 the sentinel currently doesn't tag — fold-in is adapter-side only, and only if observed).
- **N2 — one delegate turn on gemini** (KPR-352 §D6 inheritance smoke).

### D5 — Inverse transition (P4) — the KPR-313 proof

On the same validation thread carrying real codex history: PATCH Luna → `claude-sonnet-4-6`, reload, send a turn. Gating evidence:

1. Guard warn: `"Session provider mismatch — fresh session with memory handoff (KPR-313)"` with `stored: "codex", turn: "claude"`.
2. `provider_turn_history` doc for the thread **deleted** (the awaited clear — this is the first time §D4's clear runs against a *non-empty* production doc).
3. `sessions` row flips to `provider: "claude"` with a real resumable handle; a follow-up turn resumes it (claude-lane resume intact post-epic).
4. Handoff annotation: prompt content is log-redacted by posture, so live evidence is the `sessionHandoff` code path having fired (the warn + fresh session) — the annotation text itself stays pinned by the merged KPR-313/347 unit tests, not by log inspection. Stated honestly in the spike notes.
5. Behavioral: Luna's claude reply is coherent without the codex-era in-thread context (fresh session by design; memory is the continuity bridge).

The P5 restore flip (claude→codex under 0.10.1 after rollback, or before rollback under the epic build — plan's ordering choice; default: restore def *after* engine rollback so 0.10.1's simpler path handles it) re-trips the transition machinery once more; under 0.10.1 the legacy `RESUMABLE_SESSION_PROVIDERS` path governs — expected and unremarkable, recorded only if surprising.

### D6 — Evidence contract (spike notes)

`docs/epics/kpr-345/kpr-351-spike-notes.md`, KPR-346/348/352-style. Per leg: **intent → action (message text/command) → observed (Slack thread ref, redaction-clean log excerpt, mongo snapshot via mongoexport) → verdict GREEN/AMBER/RED → deltas** (anything diverging from the sibling specs' predictions, each tagged with the spec section it refines). Global sections: pinned SHA + build gates output; P0 state snapshot; every def mutation with its inverse and timestamps; G0–G3 gate sign-offs; the R4 decision-point record; KPR-355 row-fact delta list (codex rows → live-validated with citations into the leg evidence; openai unchanged unless P6 ran; Lane A explicitly restated live-unvalidated).

### D7 — Code changes (the whole in-repo diff besides docs)

| Seam | Change | Ruling |
|---|---|---|
| `openai-agents-adapter.ts` | delete codex-oauth attempt + `preferOAuth`/`codexAuthPath`/`codexRefreshCommand`; single API-key path; explicit missing-key throw (auth-alternate-shaped message) | R1 |
| `agent-manager.ts` | stale-heal arm: post-lock `sessionStore.get` re-read → adopt-or-fresh retry | R2 |
| `agent-manager.test.ts` | record-once leg strengthened with `record` spy; R2 tests | R2/R3 |
| `openai-agents-adapter.test.ts` | auth-fallback tests updated/removed (negative-verify: old fallback pins fail post-deletion); missing-key classification pin | R1 |
| `error-classification.ts` | **no code** — R1's message reuses the existing auth alternate; test pin only | R1 |
| `isStaleServerHandleError` | refined only against L2 live capture | R5 (key-conditioned) |
| CLAUDE.md | provider-adapters paragraph: openai auth = API-key single path (codex-oauth attempt removed, KPR-351); one clause noting codex live-validated on keepur | riders |
| Everything else (`codex-subscription-adapter.ts`, `tool-bridge.ts`, `turn-assembly.ts`, `session-store.ts`, `turn-history-store.ts`, `gemini-interactions-adapter.ts`, `types.ts` values) | **none** | validation shape |

## Edge cases

- **Deploy health-check fails:** deploy.sh auto-rolls back; pass aborts at G1 with the failed build in `.hive.broken` for diagnosis — that outcome is itself a validation finding (epic build can't boot production config).
- **npm registry down during deploy:** sentinel-tag fetch fails identically ⇒ fallback engages anyway (we want the fallback); no behavior difference.
- **A non-Luna turn lands mid-swap:** service is booted out — Slack events during the ~1–2 min window are missed, not queued (Socket Mode). Accepted; window chosen for low traffic; dispatcher dedup handles Slack retries.
- **Luna's Friday cron fires mid-pass:** a scheduler turn on whatever model she currently carries — harmless on codex (KPR-353 covers cron/reflection); on the C7 flip window it just adds a data point. Cron turns skip the outage queue by design if a breaker were open.
- **C6 saturation denial:** `maxConcurrent: 3` ⇒ parent + nested fits; a denial would indicate concurrent Luna spawns — record and retry in a quiet moment.
- **C7 heals but C2 history was the evidence:** C7 runs *after* C2's snapshots are captured; the clear destroys the doc — snapshot ordering is load-bearing and encoded in the runbook order.
- **Admin API token absent/unset on keepur:** fallback mechanic — direct `agent_definitions` update (mongo shell via node/mongoexport-import or a 5-line script) + SIGUSR1; version-history snapshot then done manually in spike notes. ⚠ Open assumption.
- **PATCH-triggered reload doesn't cover schedules/prefix cache edge:** SIGUSR1 belt-and-braces after every def mutation (flushes prefix cache + full reload — KPR-213 says caches self-invalidate on def writes, SIGUSR1 is the escape hatch anyway).
- **Rollback after C7 left Luna on gpt-5.4-mini:** P5's final-state diff against the P0 export catches any missed restore — the diff-empty gate is the safety net for *all* mid-pass mutations.
- **Epic PR merges mid-pass:** irrelevant to the running instance (no auto-deploy); G3 decision simply gets easier.

## Testing contract sketch

Unit (in-repo, `npm run check` green, negative-verify where behavior inverts):
- **T1 (R1):** openai adapter constructs exactly one auth attempt from `apiKey`/env; no `OpenAI` client ever built from a codex token provider (negative-verify: pre-deletion fallback test fails); missing key ⇒ pre-request throw, `classifyThrown` = `auth`; existing 401-boundary and modelSettings pins stay green.
- **T2 (R2):** stale-heal with a contender-updated store row ⇒ retry carries the adopted handle (not undefined), success persists normally; store row unchanged/absent ⇒ fresh retry (existing behavior pinned); adopted-handle retry that errors stale again ⇒ no second retry; auth-rebuild arm untouched (its tests unmodified and green).
- **T3 (R3):** record spy — one `record` per spawnTurn across stale→success and stale→failure, classification = finalized attempt's.
- **T4 (R5, conditional):** matcher refinement pinned against the captured L2 string; classification stays non-provider.

Live (the runbook itself): C0–C8 gating, L0–L3 key-conditioned, N1–N2 optional — pass/fail semantics per §D4, evidence per §D6. The negative-verify discipline for live legs is the staged transition design: every "X happened" leg has a before-state snapshot proving X was absent.

## Open assumptions / questions

**Blocking:** none for drafting; **G0 (May schedules the window) is the single human gate to execution.**

**Non-blocking (⚠ delegated/verified at plan or run time):**
- ⚠ `ADMIN_API_TOKEN` configured on keepur (admin API only starts when set) — probe at P0; fallback mechanic specified (§Edge).
- ⚠ `brave-search` is delegate-eligible (catalog entry + not delegate-unsafe) — plan-time check; fallback server named at plan time.
- ⚠ PATCH → registry-reload wiring covers model changes without SIGUSR1 — verified once at P2; SIGUSR1 belt-and-braces regardless.
- ⚠ Epic-branch rebase onto main (#324/#325) before the pass — recommended to shrink the regression window; if taken, re-pin SHA + rebuild; not required.
- ⚠ Legacy-layout skill visibility through `deriveProviderSkillIndex` (C4) — a miss is a real finding; disposition sized on discovery (in-place if trivial, else follow-up + matrix caveat).
- ⚠ Luna's end-state and the epic-build-retention question are May's explicit G3 calls; defaults are restore + rollback (R4).
- ⚠ openai/gemini non-gating legs may not run at all (no key / no slack in the window) — their absence changes nothing downstream except KPR-355 row wording.
