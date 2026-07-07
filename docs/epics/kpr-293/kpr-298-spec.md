# KPR-298 — W1A.5: Docs corrections (CLAUDE.md + specs)

**Epic:** KPR-293 (Production hardening & hygiene). **Depends on:** KPR-294 (merged 5fd207b), KPR-295 (merged 5cfaa2e), KPR-296 (merged 5e837a3) — this ticket documents what those three shipped, plus the audit's standalone doc-hygiene items.

**Scope amendment (human ruling, May, 2026-07-07, recorded on the epic):** KPR-297 is parked indefinitely and the 298←297 dependency edge is dropped. **This spec contains zero KPR-297 documentation** — those docs ride KPR-297 whenever it lands.

**Docs-only ticket.** Zero source-code changes. Zero DB operations. Every diff lands in `CLAUDE.md` or `docs/`.

## TL;DR

Fix the documented-vs-actual drift the July-5 audit (§9) found in CLAUDE.md and `docs/architecture.md` — the session collection is `sessions` (not `agent_sessions`), structured memory lives in `agent_memory`, and `model_overrides`/`devices` have had zero engine references since March/April — and discharge the two binding propagation obligations from the epic's Decision Register: document the KPR-295 empty-roster reload guard (blocked-reload semantics + restart escape hatch) and the KPR-296 `hive doctor` "Datastore identity" section (the first and only doctor section that can flip the exit code; F1/F2/F3; both remediations; the 4-step operator drill). Provider-adapter documentation (KPR-231–234) is **deferred with a caveat** — that code is not on `main` or this branch. The KPR-241 spec-placement question is resolved by documenting current practice, with the relocation call flagged to the operator as non-blocking.

## Key Points

- **In scope:** corrections to `CLAUDE.md` (collections line, two new gotcha/section entries, one Specs-and-Plans clarification), `docs/architecture.md` (stale collections list), `docs/troubleshooting.md` (new Datastore-identity failure entries + operator drill), `docs/managing-your-hive.md` (doctor description).
- **Every correction below was verified against this worktree (`kpr-293` @ 5e837a3), not taken from the July-5 audit on faith.** Two of the ticket's original items were already fixed by sibling merges (see "Already done" below) and are **not** re-speced.
- **Session collection:** code has used `sessions` since the session store was created (`src/agents/session-store.ts:29`; `git log -S '"agent_sessions"' -- src/` is empty — the name `agent_sessions` never existed in source). CLAUDE.md:249 and `docs/architecture.md:54` both say `agent_sessions`. Fix both.
- **Structured memory:** lives in `agent_memory` (+ `agent_memory_autodream_state`) per `src/memory/memory-store.ts:63-64`; FS-style memory remains `memory`/`memory_versions` (`src/memory/memory-mcp-server.ts:41-42`). Both doc lines list only the latter. Fix both.
- ⚠ **`model_overrides` + `devices`: documented as vestigial, not silently dropped** (delegated call). Zero src references — last removed 2026-03-30 (a0a5985, admin MCP rewrite) and 2026-04-13 (a9fc671, KPR-9 device-registry deletion) respectively. The corrected line removes them from the active list and adds a one-line legacy note so an operator seeing them in `mongosh` isn't confused. Dropping the actual DB collections is operational, out of scope.
- **Propagation obligation (KPR-296 review, binding):** document the doctor "Datastore identity" section — exit-code semantics (first and only post-check section that can fail the doctor: F1 sentinel mismatch / F2 roster degraded / F3 fresh non-verified engine monitor, unknown states fail closed), the W1 absent-sentinel-with-data warn (upgrade window preserved), both remediations (`HIVE_DB_SENTINEL_RESTAMP=1`, SIGUSR1-after-restore), and the 4-step manual operator drill from `docs/epics/kpr-293/kpr-296-plan.md` §E2E (adapted into `docs/troubleshooting.md`).
- **Propagation obligation (KPR-295 register, binding):** document the empty-roster reload guard — →0-cliff predicate, blocked reload = full no-op, 30s auto-recovery, and the restart escape hatch (runtime full-roster deletion is blocked by design; an engine restart commits the empty set — no config knob).
- ⚠ **Provider adapters (KPR-231–234) NOT documented** (delegated call): the four commits (f19d719, 545e40e, 592f88d, 86003c1) exist **only** on `epic/kpr-230-phase-b-provider-adapters` — not ancestors of `main` or `kpr-293` (`git merge-base --is-ancestor` negative for both). Documenting an adapter layer in CLAUDE.md that the branch's code does not contain would manufacture exactly the drift this ticket exists to remove. The adapter docs ride the KPR-230 epic PR.
- ⚠ **Spec-placement (KPR-241): document current practice, flag relocation to operator** (delegated call, non-blocking). `docs/specs/` (5 files) + `docs/plans/` (16 files) exist on `main` — including KPR-241 and, notably, KPR-231–234 specs for code that isn't merged — and `docs/epics/kpr-293/` now carries live epic specs, while CLAUDE.md's "Specs and Plans" section says specs "were moved out" to private `keepur/hive-docs`. This spec amends that paragraph to match reality (non-sensitive, engine-shaped specs/plans may live publicly; sensitive/internal work goes to hive-docs). Whether to *relocate* the existing 21 files is an operator call — no file moves or deletions in this ticket.

## Problem

The July-5 system-design audit (§9) compared CLAUDE.md's claims against the running system and found the MongoDB collections line materially wrong: it names a session collection that has never existed in source (`agent_sessions`), lists two collections nothing has referenced for months (`model_overrides`, `devices`), and omits the collection structured memory actually writes (`agent_memory`). `docs/architecture.md` repeats the same stale list. Separately, the three merged W1A siblings shipped operator-facing behavior — a reload guard that can refuse to apply a roster wipe, and a doctor section that can now exit 1 — that exists nowhere in the docs an operator (or an AI session reading CLAUDE.md) would consult during an incident. The Jul-4 impostor incident is precisely the scenario where an operator hits these surfaces for the first time; the docs must describe them before, not after.

## Goals

1. CLAUDE.md's MongoDB collections line matches `grep`-verified source reality (correct names, structured-memory collections present, vestigial collections annotated as such).
2. `docs/architecture.md`'s datastore paragraph gets the same correction.
3. The KPR-295 roster guard is documented where operators and AI sessions will find it (CLAUDE.md gotcha + troubleshooting entry): what gets blocked, how auto-recovery works, and that restart — not a knob — is the escape hatch.
4. The KPR-296 doctor section is documented (CLAUDE.md + `docs/managing-your-hive.md` + `docs/troubleshooting.md`): its exit-code semantics, the three fail conditions, the W1 warn, both remediations, and the operator drill.
5. CLAUDE.md's "Specs and Plans" paragraph stops contradicting the repo's observable layout.

## Non-Goals

- **No source changes.** Not one line under `src/`, `scripts/`, `tests/`, or config.
- **No DB operations.** `model_overrides` (3 docs) and `devices` stay in the DB until an operator drops them; this ticket only corrects what the docs claim about them.
- **No KPR-297 documentation** (human ruling above). No speculation about mongod auth in any of the new text.
- **No provider-adapter documentation** (not on this branch — see Key Points).
- **No spec/plan file moves or deletions.** The KPR-241 placement question is documented + flagged, not acted on.
- **No new doc files.** All corrections land in the four existing files. (This spec and its plan are the only new files, per epic convention.)

## Corrections (exact list, with evidence)

Each item: current text → corrected text → source-of-truth citation. Wording below is normative in substance; the implementation plan may polish phrasing but must not drop or weaken any clause.

### C1 — CLAUDE.md:249, MongoDB collections line

**Current:**

> MongoDB collections: `memory`, `memory_versions`, `agent_definitions`, `agent_definition_versions`, `agent_sessions`, `model_overrides`, `devices`, `agent_callbacks`, `contacts`, `instance_identity` (identity sentinel, KPR-294), `telemetry` (…kinds…)

**Errors:** `agent_sessions` (real name: `sessions`), `model_overrides` + `devices` (vestigial), missing `agent_memory`/`agent_memory_autodream_state` and roughly a dozen other engine-written collections.

**Corrected (two bullets replacing the one):**

> - MongoDB collections (engine-written): `agent_definitions`, `agent_definition_versions`, `sessions` (per-thread session resume), `memory`, `memory_versions` (FS-style agent memory), `agent_memory`, `agent_memory_autodream_state` (structured/tiered memory), `contacts`, `crm_contacts`, `agent_callbacks`, `agent_events`, `team_channels`, `team_messages`, `team_pending_requests`, `workflow_plans`, `workflow_tasks`, `workflow_task_comments`, `code_index`, `activity_log`, `imessage_threads`, `agent_turn_telemetry`, `migrations`, `instance_identity` (identity sentinel, KPR-294), `telemetry` (prefix-cache stats heartbeat KPR-213; spawn-coordinator stats heartbeat KPR-220; db-identity stats heartbeat `db_identity_stats` KPR-294; `agent_roster_stats` empty-roster guard KPR-295 — event-driven, `updatedAt` is not liveness)
> - Legacy collections you may still see in older DBs — nothing in the engine reads or writes them: `model_overrides` (last referenced 2026-03-30, superseded by the admin MCP rewrite), `devices` (removed with the device registry in KPR-9), `agent_sessions` (never a real source name — the session collection has always been `sessions`). Safe to drop operationally.

**Evidence:** full enumeration via `grep -rhoE '\.collection(<[^>]*>)?\(\s*["'\''][A-Za-z0-9_]+' src/ scripts/` (23 literals) + `instance_identity` via the `SENTINEL_COLLECTION` constant (`src/db/identity-sentinel.ts:22`). `sessions`: `src/agents/session-store.ts:29`. `agent_memory`: `src/memory/memory-store.ts:63-64`. Vestigial dates: `git log -S` (a0a5985, a9fc671). Note: `conversations` is a **Qdrant** collection (`src/search/conversation-index.ts`), not Mongo — it stays off this line; `code_index` is both (Mongo: `src/code-index/indexer.ts:57`) and stays on.

The `agent_sessions` clause in the legacy bullet exists because the string has appeared in this repo's docs since at least the audit; an operator who greps their DB for it should get a definitive answer. ⚠ Delegated: presenting the vestigial trio as a "legacy" bullet rather than deleting them without trace — silent deletion invites the next audit to re-flag the DB-vs-docs mismatch from the other side.

### C2 — docs/architecture.md:54, datastore paragraph

**Current:**

> **MongoDB** — agent definitions, agent memory, per-agent sessions, callbacks, contacts, devices, model overrides. Collections include `agent_definitions`, `agent_definition_versions`, `agent_sessions`, `memory`, `memory_versions`, `contacts`, `agent_callbacks`, `devices`, `model_overrides`.

**Corrected:**

> **MongoDB** — agent definitions, agent memory (FS-style + structured tiers), per-thread sessions, callbacks, contacts, team/workflow state, identity sentinel, telemetry. Collections include `agent_definitions`, `agent_definition_versions`, `sessions`, `memory`, `memory_versions`, `agent_memory`, `contacts`, `agent_callbacks`, `instance_identity`, `telemetry` (non-exhaustive — see CLAUDE.md for the full list).

**Evidence:** same as C1. Architecture.md's list is illustrative, not exhaustive — pointing at CLAUDE.md avoids maintaining two full lists.

### C3 — CLAUDE.md: empty-roster reload guard (KPR-295) — new entry

Add a short block (suggested home: a new bullet in Common Gotchas, adjacent to the SIGUSR1/prefix-cache bullets, or a compact subsection near "Spawn coordinator"; plan's choice):

> **Empty-roster reload guard (KPR-295):** if an agent-definitions reload observes the collection at **zero docs after any non-empty load in this process's lifetime**, the reload is blocked as a **full no-op** — no roster mutation, no post-reload hooks, schedules/skills/plugins refresh all skipped — and the registry logs the alarm, marks `agent_roster_stats.degraded: true` in `db.telemetry`, and retries every 30s, auto-recovering (no operator ack) as soon as docs reappear. This is deliberate impostor/wipe protection: **runtime deletion of the entire roster is blocked by design and there is no bypass knob** — if you genuinely mean to run with an empty roster, restart the engine (a fresh process has no non-empty baseline and commits the empty set). A fresh-install empty boot, partial shrinkage, or all-agents-disabled all commit normally; only the →0 cliff blocks. `hive doctor`'s Datastore identity section surfaces the degraded state.

**Evidence:** epic Decision Register canon E1/E5/E7/E8 (KPR-295 entry, 5cfaa2e); register comment 2026-07-07T01:33 on KPR-293.

### C4 — Doctor "Datastore identity" section (KPR-296) — three doc surfaces

**(a) CLAUDE.md** — new Common Gotchas bullet (place beside the existing `HIVE_DB_SENTINEL_RESTAMP` line, which is already correct — do not touch it):

> **`hive doctor` Datastore identity section (KPR-296):** the first and only post-check doctor section that can **fail the doctor (exit 1)**. Fail conditions: **F1** identity sentinel present-but-mismatched (instanceId/dbName), **F2** roster guard degraded, **F3** engine identity monitor reporting non-verified on a fresh (≤120s) heartbeat — unknown monitor states fail closed. Everything else warns or informs: absent-sentinel-with-data is a **warn**, not a fail (upgrade window preserved); a temp-dir `dbPath` (`/tmp`, `/var/folders`) warns — the Jul-4 impostor signature. Remediations: intentional DB adoption → `HIVE_DB_SENTINEL_RESTAMP=1` for one boot; roster/state recovery after a DB restore → `SIGUSR1`. Every other doctor section remains informational — identity-class incidents flip the exit code, telemetry health never does.

**(b) docs/managing-your-hive.md:83** — extend the doctor description sentence to add the Datastore identity section: connected-server fingerprint (host/pid/uptime/version/dbPath), independent sentinel verification, engine identity-monitor + roster-guard telemetry, live-vs-last-good roster count — and note that hard identity failures exit 1 (CI/cron wrappers around `hive doctor` will see identity incidents as failures).

**(c) docs/troubleshooting.md** — new section(s) following the file's established symptom/meaning/what-to-do format, indexed by failing check name, covering: F1 (mismatch → verify which mongod answered via the fingerprint; restore the right DB, or `HIVE_DB_SENTINEL_RESTAMP=1` if adoption is intentional), F2 (roster degraded → restore/verify DB, SIGUSR1, guard auto-recovers), F3 (engine monitor non-verified → read engine logs, writes are being refused), W1 (absent sentinel + data → expected once per pre-KPR-294 upgrade; engine stamps on next boot), and the temp-dbPath warn. Include the **4-step manual operator drill** adapted from `docs/epics/kpr-293/kpr-296-plan.md` §E2E (happy path → scratch-mongod impostor F1+temp-path → W1 upgrade window → teardown/verify-untouched), with a link back to the plan for provenance.

**Evidence:** canon D1–D6 (KPR-296 register entry, 5e837a3); propagation comment on KPR-298 (2026-07-07T02:42); render implementation `src/cli/doctor.ts:178-310`; drill at `docs/epics/kpr-293/kpr-296-plan.md:761-770`.

### C5 — CLAUDE.md "Specs and Plans" paragraph — align with observable layout

**Current claim:** historical specs/plans "were moved out of the public `keepur/hive` repo" to private `keepur/hive-docs`; new sensitive/internal design work lands there.

**Observable reality:** `docs/specs/` (5 files incl. KPR-241, KPR-231–234) and `docs/plans/` (16 files) exist on `main`, and `docs/epics/kpr-293/` carries this epic's live specs/plans.

**Corrected:** amend the paragraph to state both halves: sensitive/internal design work lands in private `keepur/hive-docs`; **non-sensitive, engine-shaped specs and plans may live in the public repo** under `docs/specs/`, `docs/plans/`, and `docs/epics/<epic>/` (the epic-workflow convention). Add one sentence noting the KPR-231–234 specs describe work still on the `epic/kpr-230-phase-b-provider-adapters` branch, so readers don't grep `src/` for an adapter layer that isn't merged.

⚠ Delegated: this documents the exception rather than relocating files. The relocation question (should the 21 public spec/plan files move to hive-docs? they're already in public git history, so moving doesn't unpublish) is flagged to the operator below — non-blocking, and explicitly not acted on in this ticket.

### Already done — verify, do not re-fix

- **`instance_identity` on the collections line + `HIVE_DB_SENTINEL_RESTAMP` bullet:** landed with KPR-294's merge. Current CLAUDE.md:249-250 verified correct as of 5e837a3.
- **Telemetry kinds (`db_identity_stats`, `agent_roster_stats`) on the collections line:** landed with KPR-294/KPR-295 merges. Verified present. C1's rewritten line must **carry these forward verbatim in substance** (the parenthetical in C1 does).

## Edge Cases / Discipline

1. **Re-verify at implementation time.** This spec was verified against 5e837a3. If the epic branch advances before implementation, re-run the C1 enumeration grep and the "Already done" checks first — the whole failure mode of this ticket is correcting things that are already correct.
2. **C1 supersedes, not appends.** The corrected collections bullet *replaces* line 249 wholesale; the telemetry parenthetical must survive the rewrite (it is current canon, not drift).
3. **The drill adaptation must keep the safety properties:** scratch mongod on a spare port, throwaway `--dbpath`, teardown step confirming the real DB untouched. Do not simplify it into instructions that touch a live instance's DB.
4. **No forward references:** none of the new text may mention KPR-297, mongod auth, or the provider-adapter layer as shipped capabilities.
5. **Formatting gate:** `npm run check` includes Prettier — run `npm run format` over the touched markdown before commit (repo convention; the Slack env stubs apply to `check`).

## Integration Points (exact files)

| File | Change |
|---|---|
| `CLAUDE.md` | C1 (collections line rewrite + legacy bullet), C3 (roster-guard entry), C4a (doctor-section gotcha), C5 (Specs-and-Plans amendment) |
| `docs/architecture.md` | C2 (line 54 datastore paragraph) |
| `docs/managing-your-hive.md` | C4b (doctor description, ~line 83) |
| `docs/troubleshooting.md` | C4c (Datastore identity failure entries + operator drill) |

## Testing Contract

Docs-only — no unit tests. Acceptance is grep-verifiable:

- `grep -rn "agent_sessions\|model_overrides\|devices" CLAUDE.md docs/architecture.md` → hits only inside the legacy-collections bullet (C1) and epic docs under `docs/epics/`.
- `grep -n "agent_memory" CLAUDE.md docs/architecture.md` → present in both.
- `grep -n "Datastore identity" CLAUDE.md docs/managing-your-hive.md docs/troubleshooting.md` → present in all three.
- `grep -n "KPR-297" CLAUDE.md docs/troubleshooting.md docs/managing-your-hive.md docs/architecture.md` → no hits in any new text.
- `npm run check` green (format gate; with the Slack env stubs).

## Open Questions / Delegated Assumptions

All ⚠ items are Gate-1-delegated calls made in this spec, flagged for review — none blocks:

1. ⚠ **Vestigial collections documented as legacy, not silently removed** (C1) — non-blocking.
2. ⚠ **Provider adapters deferred to the KPR-230 epic merge, with only a one-sentence pointer in C5** (not a full caveated section) — non-blocking.
3. ⚠ **Spec-placement resolved by documenting the exception; relocation of the 21 public spec/plan files left as an operator decision** (C5) — non-blocking, surface to May at Gate 2 or in the epic wrap-up, not as a ticket blocker.
4. ⚠ **Drill inlined into troubleshooting.md (adapted) rather than only linked** (C4c) — troubleshooting.md is the operator's incident surface; a link to an epic plan file is one hop too far mid-incident. Non-blocking.
