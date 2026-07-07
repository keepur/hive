# KPR-298 — W1A.5: Docs corrections (CLAUDE.md + specs) — Implementation Plan

**Spec:** `docs/epics/kpr-293/kpr-298-spec.md` (reviewed clean, commit `ef24f37`; ⚠-flagged delegated calls are settled — do not re-litigate).
**Epic branch:** KPR-293 W1A (branch `mature/kpr-298` off `kpr-293`). One commit per task (dodi-dev:implement convention). **Docs-only:** zero changes under `src/`, `scripts/`, `tests/`, or config; zero DB operations.

**Verified anchors in this worktree (`ef24f37`, re-checked at plan time — spec discipline #1 already discharged once):**

- `CLAUDE.md:249` — stale collections bullet (contains `agent_sessions`, `model_overrides`, `devices`; missing `agent_memory`). `CLAUDE.md:250` — `HIVE_DB_SENTINEL_RESTAMP` bullet, **correct, do not touch**.
- `CLAUDE.md:24-26` — "### Specs and Plans" heading + the one-paragraph body to amend (C5).
- `docs/architecture.md:54` — stale datastore paragraph (C2).
- `docs/managing-your-hive.md:83` — doctor description sentence (C4b).
- `docs/troubleshooting.md:9-17` — "Failure modes" TOC; `:176` — "### 8. Where to get help" (C4c inserts before it).
- **C1 enumeration re-verified:** `grep -rhoE '\.collection(<[^>]*>)?\(\s*["'"'"'][A-Za-z0-9_]+' src/ scripts/` → exactly the 23 literals in the spec's corrected bullet, + `instance_identity` via `SENTINEL_COLLECTION` (`src/db/identity-sentinel.ts:22`). `sessions` at `src/agents/session-store.ts:29`; `agent_memory`/`agent_memory_autodream_state` at `src/memory/memory-store.ts:63-64`; `memory`/`memory_versions` at `src/memory/memory-mcp-server.ts:41-42`.
- **"Already done" items re-verified:** `instance_identity` + telemetry kinds present on `CLAUDE.md:249`; RESTAMP bullet present at `:250`. C1 replaces line 249 wholesale and carries the telemetry parenthetical forward in substance.
- **Doctor render re-verified** against `src/cli/doctor.ts:193-352` (`renderDatastoreIdentitySection`): F1 mismatch / F2 degraded (fail assignment at `:311`) / F3 fresh non-verified fail-closed; W1 absent-with-data warn; temp-dbPath warn; validation-evicted-all + roster-divergence warns; fingerprint best-effort. The troubleshooting prose in Task 2 quotes the actual rendered line prefixes.
- **Baseline greps:** zero `KPR-297` hits and zero `Datastore identity` hits across the four target files today — the acceptance greps start from a clean slate.

**Out of scope (do not touch):** anything under `src/`; `docs/epics/**` (historical artifacts — deliberately outside the acceptance grep); the 21 files under `docs/specs/` + `docs/plans/` (C5 documents, does not relocate); KPR-297 / mongod auth / provider adapters as shipped capabilities (spec Non-Goals).

**If the epic branch advances before implementation:** re-run the C1 enumeration grep and the "Already done" checks first (spec Edge #1) — the failure mode of this ticket is correcting things that are already correct.

---

## Task 1 — CLAUDE.md + docs/architecture.md (C1, C2, C3, C4a, C5)

**Files:** `CLAUDE.md`, `docs/architecture.md`.

### 1.1 — C1: collections bullet (CLAUDE.md:249)

Replace the single bullet starting `- MongoDB collections:` **wholesale** with these two bullets (spec-verbatim; the telemetry parenthetical is carried forward per spec Edge #2):

> - MongoDB collections (engine-written): `agent_definitions`, `agent_definition_versions`, `sessions` (per-thread session resume), `memory`, `memory_versions` (FS-style agent memory), `agent_memory`, `agent_memory_autodream_state` (structured/tiered memory), `contacts`, `crm_contacts`, `agent_callbacks`, `agent_events`, `team_channels`, `team_messages`, `team_pending_requests`, `workflow_plans`, `workflow_tasks`, `workflow_task_comments`, `code_index`, `activity_log`, `imessage_threads`, `agent_turn_telemetry`, `migrations`, `instance_identity` (identity sentinel, KPR-294), `telemetry` (prefix-cache stats heartbeat KPR-213; spawn-coordinator stats heartbeat KPR-220; db-identity stats heartbeat `db_identity_stats` KPR-294; `agent_roster_stats` empty-roster guard KPR-295 — event-driven, `updatedAt` is not liveness)
> - Legacy collections you may still see in older DBs — nothing in the engine reads or writes them: `model_overrides` (last referenced 2026-03-30, superseded by the admin MCP rewrite), `devices` (removed with the device registry in KPR-9), `agent_sessions` (never a real source name — the session collection has always been `sessions`). Safe to drop operationally.

The `HIVE_DB_SENTINEL_RESTAMP` bullet on the next line stays byte-identical.

### 1.2 — C3 + C4a: two new Common Gotchas bullets

Insert **immediately after** the `HIVE_DB_SENTINEL_RESTAMP` bullet (plan's placement call per spec C3: keeps the identity/roster incident cluster adjacent), in this order, spec-verbatim:

> - **Empty-roster reload guard (KPR-295):** if an agent-definitions reload observes the collection at **zero docs after any non-empty load in this process's lifetime**, the reload is blocked as a **full no-op** — no roster mutation, no post-reload hooks, schedules/skills/plugins refresh all skipped — and the registry logs the alarm, marks `agent_roster_stats.degraded: true` in `db.telemetry`, and retries every 30s, auto-recovering (no operator ack) as soon as docs reappear. This is deliberate impostor/wipe protection: **runtime deletion of the entire roster is blocked by design and there is no bypass knob** — if you genuinely mean to run with an empty roster, restart the engine (a fresh process has no non-empty baseline and commits the empty set). A fresh-install empty boot, partial shrinkage, or all-agents-disabled all commit normally; only the →0 cliff blocks. `hive doctor`'s Datastore identity section surfaces the degraded state.
> - **`hive doctor` Datastore identity section (KPR-296):** the first and only post-check doctor section that can **fail the doctor (exit 1)**. Fail conditions: **F1** identity sentinel present-but-mismatched (instanceId/dbName), **F2** roster guard degraded, **F3** engine identity monitor reporting non-verified on a fresh (≤120s) heartbeat — unknown monitor states fail closed. Everything else warns or informs: absent-sentinel-with-data is a **warn**, not a fail (upgrade window preserved); a temp-dir `dbPath` (`/tmp`, `/var/folders`) warns — the Jul-4 impostor signature. Remediations: intentional DB adoption → `HIVE_DB_SENTINEL_RESTAMP=1` for one boot; roster/state recovery after a DB restore → `SIGUSR1`. Every other doctor section remains informational — identity-class incidents flip the exit code, telemetry health never does.

### 1.3 — C5: "Specs and Plans" paragraph (CLAUDE.md:26)

Replace the paragraph body under "### Specs and Plans" (currently: "Historical design specs and implementation plans live in the **private** companion repo … Public-facing engine docs live in `keepur/hive/docs/`.") with:

> Design specs and implementation plans live in two places. Sensitive/internal design work lands in the **private** companion repo `keepur/hive-docs` under `internal/specs/` and `internal/plans/`. Non-sensitive, engine-shaped specs and plans may live in the public repo — under `docs/specs/`, `docs/plans/`, and `docs/epics/<epic>/` (the epic-workflow convention: each epic directory carries its children's specs and plans). Public-facing engine docs live in `keepur/hive/docs/`. Note: the KPR-231–234 specs under `docs/specs/` describe provider-adapter work that lives on the `epic/kpr-230-phase-b-provider-adapters` branch and is not yet merged — don't expect a matching adapter layer in `src/`.

(The relocation question for the 21 existing public spec/plan files is an operator decision flagged in the spec — no file moves here.)

### 1.4 — C2: datastore paragraph (docs/architecture.md:54)

Replace the `**MongoDB** — …` bullet with (spec-verbatim):

> - **MongoDB** — agent definitions, agent memory (FS-style + structured tiers), per-thread sessions, callbacks, contacts, team/workflow state, identity sentinel, telemetry. Collections include `agent_definitions`, `agent_definition_versions`, `sessions`, `memory`, `memory_versions`, `agent_memory`, `contacts`, `agent_callbacks`, `instance_identity`, `telemetry` (non-exhaustive — see CLAUDE.md for the full list).

**Verify:**

```bash
grep -n "agent_sessions\|model_overrides\|devices" CLAUDE.md docs/architecture.md   # hits only in the legacy bullet
grep -n "agent_memory" CLAUDE.md docs/architecture.md                               # present in both
grep -n "KPR-297" CLAUDE.md docs/architecture.md                                    # no hits
```

Commit: `docs(kpr-298): correct MongoDB collections + specs-placement drift in CLAUDE.md and architecture.md`

---

## Task 2 — docs/managing-your-hive.md + docs/troubleshooting.md (C4b, C4c)

**Files:** `docs/managing-your-hive.md`, `docs/troubleshooting.md`.

### 2.1 — C4b: doctor description (managing-your-hive.md:83)

Replace the sentence `` `hive doctor` verifies prerequisites … port bindings). `` with:

> `hive doctor` verifies prerequisites (Node version, MongoDB reachable, required CLIs on PATH), config files (`hive.yaml`, `.env` keys present), agent definitions (loadable from MongoDB), and service state (launchd job loaded, process running, port bindings). It also prints a **Datastore identity** section (KPR-296): the connected mongod's server fingerprint (host, pid, uptime, version, dbPath), an independent verification of the DB identity sentinel, the engine's identity-monitor and roster-guard telemetry, and a live-vs-last-good roster count. Hard identity failures — sentinel mismatch, roster guard degraded, engine refusing writes — make the doctor **exit 1**, so CI or cron wrappers around `hive doctor` will see identity incidents as failures. Every other check remains informational.

### 2.2 — C4c: troubleshooting entries + operator drill

In `docs/troubleshooting.md`:

1. **TOC:** insert `8. [Datastore identity failures (\`hive doctor\` exits 1)](#8-datastore-identity-failures-hive-doctor-exits-1)` before the help entry; renumber "Where to get help" to 9 (TOC line and its `### 8.` heading → `### 9.`, anchor updated).
2. **Insert the following section** before "Where to get help" (line prefixes quote the actual `renderDatastoreIdentitySection` output, verified against `src/cli/doctor.ts:193-352`):

> ### 8. Datastore identity failures (`hive doctor` exits 1)
>
> The **Datastore identity** section (KPR-296) answers "is the mongod behind `config.mongo.uri` actually this instance's database?" It is the first and only doctor section that can **fail the doctor (exit 1)**. Three conditions fail; everything else warns or informs. Entries below are indexed by the failing line.
>
> #### `✗ identity sentinel MISMATCH — expected <id>/<db>, observed <other>/<other-db>` (F1)
>
> **Symptom:** exit code 1; the section's server fingerprint (host, pid, uptime, `dbPath`) may show a mongod you don't recognize.
>
> **Meaning:** the DB the doctor connected to carries another instance's identity sentinel — you're pointed at the wrong DB, the wrong mongod is answering on the configured port (the Jul-4 impostor scenario), or you intentionally adopted another instance's data.
>
> **Fix:** first verify *which* mongod answered using the fingerprint printed at the top of the section — cross-check with `brew services list` and `lsof -i :27017`. If the wrong mongod is answering, stop it and restore the right one; if the DB itself is wrong, restore the right DB. If the adoption is intentional (e.g. bringing another instance's backup under this instance id), set `HIVE_DB_SENTINEL_RESTAMP=1` for exactly one engine boot, then remove it — it re-stamps every boot it is set.
>
> #### `✗ roster guard DEGRADED since <ts> — engine holding last-good roster` (F2)
>
> **Symptom:** exit code 1; agents still respond (the engine is serving its last-good roster).
>
> **Meaning:** an agent-definitions reload read **zero** documents after this process had previously loaded a non-empty roster (KPR-295 empty-roster guard). The engine blocked the wipe as a full no-op and is retrying every 30s. Usual causes: DB wiped, restored empty, or an impostor mongod answering.
>
> **Fix:** restore or verify the DB (check the fingerprint/sentinel lines in the same section). Once agent definitions reappear the guard **auto-recovers within ~30s** — no restart, no operator ack. If the engine was restarted mid-episode and came up on an empty DB, send `SIGUSR1` after the restore to reload. If you genuinely mean to run with an empty roster: restart the engine — there is no bypass knob; a fresh process has no non-empty baseline and commits the empty set.
>
> #### `✗ engine identity monitor: <state> — writes refused=…` (F3)
>
> **Symptom:** exit code 1; the `db_identity_stats` heartbeat is fresh (≤120s) but reports a non-verified state (unknown states fail closed).
>
> **Meaning:** the *running engine* has detected an identity problem and **is refusing DB writes right now** — this is the live counterpart of F1; the doctor is relaying the engine's own alarm.
>
> **Fix:** read the engine logs (look for the `critical: true` marker) to see what the identity monitor observed, then resolve as F1 — verify the mongod, restore the right DB, or `HIVE_DB_SENTINEL_RESTAMP=1` if adoption is intentional. Writes resume automatically once the monitor re-verifies.
>
> #### `⚠ identity sentinel absent but DB has hive data (<n> agent defs)` (W1 — warn, not fail)
>
> **Meaning:** the DB has data but no sentinel — expected exactly once per pre-KPR-294 instance: the engine hasn't booted since the upgrade, and it stamps the sentinel on next boot. If the engine *has* booted since upgrading, you may be looking at a different DB than the engine is.
>
> **Fix:** start (or restart) the engine, re-run `hive doctor`, confirm the line flips to `✓ identity sentinel matches`.
>
> #### `⚠ connected mongod dbPath is a TEMP directory` (warn)
>
> **Meaning:** the answering mongod's `dbPath` is under `/tmp` or `/var/folders` — the exact Jul-4 impostor signature (a scratch mongod squatting on the production port).
>
> **Fix:** verify what's listening (`brew services list; lsof -i :27017`), kill the squatter, confirm the real mongod is bound, re-run the doctor.
>
> Remaining warn tier, one line each:
>
> - `⚠ roster: <n> docs but 0 active and not all disabled` — validation evicted every agent (engine/data version skew); check engine logs from the last reload.
> - `⚠ roster divergence: DB has <n> agent defs, engine last committed <m>` — live count ≠ last committed roster (e.g. the engine restarted during a DB outage); send `SIGUSR1` after restore to reload.
>
> #### Operator drill (safe — touches only a throwaway mongod)
>
> Adapted from the KPR-296 implementation plan's E2E drill (`docs/epics/kpr-293/kpr-296-plan.md`, Testing Contract → E2E). Exercises F1, the temp-path warn, and W1 without touching the real DB:
>
> 1. **Happy path:** on a healthy instance with the engine running: `hive doctor; echo $?` → the Datastore identity section shows the server fingerprint and `✓` sentinel / `✓` engine monitor / `✓` roster lines; exit `0`.
> 2. **F1 + temp-path (impostor-shaped):** start a scratch mongod on a spare port with a throwaway data dir: `mongod --dbpath "$(mktemp -d)" --port 27099 &`. Stamp a *foreign* sentinel + one dummy agent def:
>
>    ```
>    mongosh --port 27099 <dbName> --eval 'db.instance_identity.insertOne({_id:"identity_sentinel",schemaVersion:1,instanceId:"other",dbName:"hive_other",sentinelId:"drill",stampedAt:new Date(),stampedBy:{engineVersion:"drill",hostname:"drill",pid:1}}); db.agent_definitions.insertOne({_id:"dummy",isDefault:true})'
>    ```
>
>    Then from the instance dir: `MONGODB_URI=mongodb://localhost:27099 hive doctor; echo $?` → expect `✗ identity sentinel MISMATCH — expected …, observed other/hive_other` with the RESTAMP remediation, the `⚠ … TEMP directory …` warning (`mktemp` lands under `/var/folders` on macOS), exit `1`.
> 3. **W1 (upgrade window):** on the scratch mongod: `db.instance_identity.deleteOne({_id:"identity_sentinel"})`, re-run the doctor → expect `⚠ identity sentinel absent but DB has hive data (1 agent defs)`; the identity section itself does **not** fail (other sections may still fail on the scratch DB — read the section, not just `$?`).
> 4. **Teardown:** kill the scratch mongod; re-run step 1 against the real instance to confirm it is untouched (the drill wrote only to the throwaway `--dbpath`; the doctor itself writes nothing).

Drill safety properties preserved per spec Edge #3: scratch mongod on a spare port, throwaway `--dbpath`, teardown step confirming the real DB untouched — no step touches a live instance's DB.

**Verify:**

```bash
grep -n "Datastore identity" CLAUDE.md docs/managing-your-hive.md docs/troubleshooting.md   # present in all three
grep -n "KPR-297" docs/troubleshooting.md docs/managing-your-hive.md                        # no hits
```

Commit: `docs(kpr-298): document doctor Datastore identity section + operator drill (KPR-296) and roster guard (KPR-295)`

---

## Task 3 — Final gate

1. `npm run format` over the touched markdown (repo Prettier convention; spec Edge #5).
2. Full acceptance greps (spec Testing Contract, verbatim below).
3. `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`.

Commit only if `npm run format` modified files: `docs(kpr-298): format pass`. Otherwise Task 3 produces no commit.

---

## Testing Contract (MANDATORY)

### Unit

**None required — deliberate.** Docs-only ticket: zero changes under `src/`, `scripts/`, `tests/`, or config; there is no code to test. All existing tests must pass unmodified (nothing they cover is touched).

### Integration

**None required — deliberate.** No runtime surface changes; no DB operations.

### E2E

**None required — deliberate.** The operator drill embedded in troubleshooting.md is documentation *content* (KPR-296 already ran it as that ticket's E2E substitute); running it again is optional, recommended on a dev instance if convenient, and not a gate for this ticket.

### Acceptance (spec's grep contract, verbatim)

Docs-only — no unit tests. Acceptance is grep-verifiable:

- `grep -n "agent_sessions\|model_overrides\|devices" CLAUDE.md docs/architecture.md` → hits only inside the legacy-collections bullet (C1). (Epic docs under `docs/epics/` are deliberately outside this grep's file list — they are historical artifacts, not maintained reference docs.)
- `grep -n "agent_memory" CLAUDE.md docs/architecture.md` → present in both.
- `grep -n "Datastore identity" CLAUDE.md docs/managing-your-hive.md docs/troubleshooting.md` → present in all three.
- `grep -n "KPR-297" CLAUDE.md docs/troubleshooting.md docs/managing-your-hive.md docs/architecture.md` → no hits in any new text.
- `npm run check` green (format gate; with the Slack env stubs).

---

## Files touched (complete list)

| File | Change | Task |
| --- | --- | --- |
| `CLAUDE.md` | C1 (collections rewrite + legacy bullet), C3 (roster-guard gotcha), C4a (doctor gotcha), C5 (Specs-and-Plans amendment) | 1 |
| `docs/architecture.md` | C2 (datastore paragraph) | 1 |
| `docs/managing-your-hive.md` | C4b (doctor description) | 2 |
| `docs/troubleshooting.md` | C4c (new section 8 + TOC renumber; help → section 9) | 2 |
| `docs/epics/kpr-293/kpr-298-plan.md` | this plan (epic convention) | — |
