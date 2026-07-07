# KPR-295 — Empty-roster reload guard + alarm — Implementation Plan

**Spec:** `docs/epics/kpr-293/kpr-295-spec.md` (reviewed clean, commit `0608ae0`; ⚠-flagged assumptions are settled — do not re-litigate).
**Epic branch:** KPR-293 W1A (branch `mature/kpr-295` off `kpr-293`). One commit per task (dodi-dev:implement convention). Every task leaves the tree green: `npm run typecheck` + scoped tests pass after each task.

**Verified anchors in current source** (line numbers as of this worktree):
- `src/agents/agent-registry.ts:13` — `POLL_INTERVAL_MS = 30_000` (reused for the degraded retry).
- `agent-registry.ts:119-246` — `load()`: single `await` at `:120` (`find().toArray()`), `previousIds` snapshot at `:121` (post-await), synchronous validate/diff, removal sweep `:234-240`, `lastPollTime`/`rebuildOriginIndex`/`firePostReload` at `:242-244`.
- `agent-registry.ts:267-282` — `startPolling()` with try/wrapped tick (precedent for the retry-tick wrapper); `:303-312` — `stopWatching()` (change stream + poll timer teardown).
- `agent-registry.ts:83` — `private onChangeDetected?: () => void` (retry funnel target).
- **`load()` call sites: exactly two** (grep-verified) — boot `await registry.load()` (`src/index.ts:212`, result discarded) and the `reload()` closure (`src/index.ts:181`, uses `added`/`updated`/`removed`). Widening the return type with an optional `blocked?: boolean` is non-breaking for both and for every existing test.
- `src/index.ts:150` — `rawTelemetryCollection` (KPR-294 guard-immune handle). `:465` — guarded `telemetryCollection` used by prefix-cache writer `:466-477` (family pattern: `{kind}`-keyed upsert, `$set: { ...stats, updatedAt }`, catch → `log.warn`).
- Fire-and-forget `reload()` sites (all five, no `.catch` today): debounce `:210`, skills watcher `:422`, agent-skills watcher `:444`, SIGUSR1 `:457`, AdminApi callback `:697` (`() => reload()`).
- `src/admin/admin-api.ts:19,26` — `onReload: () => void` (already discards the promise; **no admin-api.ts change needed** — passing `safeReload` at `index.ts:697` covers all 5 internal invocation sites `:200,229,240,254,293`).
- `src/index.ts:767` — `registry.stopWatching()` in `shutdown()` (retry-timer teardown rides this for free once Task 1 adds it to `stopWatching()`).
- Test conventions: `src/agents/agent-registry.test.ts` exists — `makeFakeCollection(docs)` closure-over-mutable-array pattern (`:180-184`, `:359-370`), `makeDefinition()` factory, stdout-spy log capture (`captureWarnings`, `:379-392`). Extend this file.
- Log discipline precedent: `identity-sentinel.ts` — `critical: true` on state entry only.

**Out of scope (do not touch):** `hive doctor` / KPR-296, `src/admin/admin-api.ts`, `AgentManager`, dispatcher, adapters, scheduler, KPR-294 modules (`src/db/*`), `src/config.ts` (no tunables — spec is explicit: no guard-disable knob), boot-time zero-roster detection, partial-shrinkage heuristics.

---

## Task 1 — Registry guard: state, blocked load, recovery, retry timer, getter

**Goal:** all roster-guard behavior inside `AgentRegistry`, fully unit-tested. `index.ts` untouched (optional `blocked` field is non-breaking), tree stays green.

**Files:**
- `src/agents/agent-registry.ts`
- `src/agents/agent-registry.test.ts` (extend)

**Changes (spec §Design, exact):**

1. New private state (verbatim from spec — `hadNonEmptyLoad`, `rosterGuard {degraded, degradedSince, blockedReloadCount, lastBlockedAt, lastRecoveryAt}`, `lastGood {docCount, activeCount, disabledCount, at, source}`, `degradedRetryTimer`), plus a private `hasLoadedOnce = false` for `lastGood.source` tracking.
2. `load()` return type → `Promise<{ added: string[]; updated: string[]; removed: string[]; blocked?: boolean }>`. Guard check immediately after the `find()` resolves, before any mutation:
   ```ts
   const docs = await this.agentDefs.find().toArray();
   if (docs.length === 0 && this.hadNonEmptyLoad) {
     return this.blockEmptyReload();
   }
   ```
3. `private blockEmptyReload()` — synchronous, entire body past the early state flags try/wrapped (can never throw; Goals #1 holds even if the logger explodes):
   - State: `degraded = true`, `degradedSince ??= now`, `blockedReloadCount++`, `lastBlockedAt = now`.
   - Logging: on `degraded` false→true, `log.error("EMPTY ROSTER READ — keeping last-good roster", { critical: true, lastGoodDocCount, lastGoodAt, hint: "DB may be an impostor or wiped — see hive doctor / db_identity_stats. If you intentionally deleted all agents, restart the engine to apply." })`. Repeat blocks while already degraded: `log.info` with `blockedReloadCount` (canon: critical once per state entry).
   - Retry: start `degradedRetryTimer` if not running — `setInterval(() => { try { this.onChangeDetected?.(); } catch (err) { log.warn("degraded-retry tick failed", { error: String(err) }); } }, POLL_INTERVAL_MS)`, `.unref()`. Tick body try/wrapped (runs outside `blockEmptyReload()`'s wrapper — an uncaught throw there is an `uncaughtException`; same precedent as `startPolling()`'s tick).
   - Returns `{ added: [], updated: [], removed: [], blocked: true }`. No map mutation, no `lastPollTime` touch, **no `firePostReload()`** (state unchanged; prefix cache stays valid).
4. Commit path (docs > 0, or 0 with `hadNonEmptyLoad === false`): unchanged validation/diff, plus bookkeeping inserted just before `this.firePostReload()` (`:244`):
   - `hadNonEmptyLoad ||= docs.length > 0`
   - `lastGood = { docCount: docs.length, activeCount: this.agents.size, disabledCount: newDisabled.length, at: now, source: this.hasLoadedOnce ? "reload" : "boot" }`; then `hasLoadedOnce = true`. (No caller signature change.)
   - Recovery, if `degraded` was true: clear `degraded`/`degradedSince`, set `lastRecoveryAt`, `clearInterval(degradedRetryTimer)` + null it, `log.info("roster reload recovered — last-good roster replaced", { agents: docs.length, blockedReloadCount })`.
5. `getRosterGuardState()` — public getter returning the exact spec shape (degraded, degradedSince, blockedReloadCount, lastBlockedAt, lastRecoveryAt, lastGood). Return copies, not live references.
6. `buildRosterStatsDoc(state)` — **exported pure function** in this file mapping `getRosterGuardState()` output → the Roster Stats Contract doc body: `{ docCount, activeCount, disabledCount, lastGoodAt, lastGoodSource, degraded, degradedSince, blockedReloadCount, lastBlockedAt, lastRecoveryAt }` (no `kind`, no `updatedAt` — the writer adds those, matching the prefix-cache family where `kind` rides the upsert filter). No mongodb imports — the registry stays Mongo-collection-agnostic; the write itself lives in `index.ts` (Task 2). *This is the spec's sanctioned "extracted" option for making the KPR-296 field-name contract snapshot-testable — `writeRosterStats` is a closure in `main()` and not importable.*
7. `stopWatching()` additionally clears `degradedRetryTimer`.
8. Comment above the `await` at `:120` pinning the invariant: *`load()` must keep exactly one await before the synchronous commit; the guard's correctness (and the diff's atomicity) depends on it.* (Spec §Concurrency — **no mutex/serialization**; do not add one.)

**Tests** (extend `agent-registry.test.ts`; reuse `makeDefinition`/`makeFakeCollection` mutable-docs pattern; log assertions via the existing stdout-spy pattern generalized to capture `"level":"error"` / `"level":"info"` / `"critical":true`; `vi.useFakeTimers()` for timer tests, restore in `afterEach`):
1. Boot-shaped first load with 0 docs → commits (`blocked` falsy), guard unarmed — a *second* empty load also commits (still no non-empty commit).
   1b. **Fresh-install arming arc** (spec edge #3, second half): empty boot → non-empty load (arms — seeding) → empty load → third load returns `blocked: true`. Pins that `hadNonEmptyLoad` is set by *any* non-empty commit, not only the first load of the process — an implementation gating it on a first-load flag would pass tests 1–2 and fail the common OOB seed-after-boot path.
2. **Incident shape:** non-empty load → mutate docs to `[]` → `load()` returns `blocked: true`, `removed: []`, `get()`/`getAll()`/`getDisabled()`/`findByOrigin()` all unchanged, post-reload handler NOT fired (subscribe via `onPostReload`, assert call count stays 1), exactly one `log.error` with `critical: true`. **(← negative-verify target, Task 4.)**
3. Blocked → blocked again → second emits `log.info` not `log.error`; `blockedReloadCount` reaches 2.
4. Recovery: non-empty → empty (blocked) → non-empty → commit applies (new roster visible), `degraded` false, `lastRecoveryAt` set, retry timer cleared (advance fake timers past 30s → `onChangeDetected` NOT called again), recovery `log.info`.
5. Shrinkage 5 → 2 commits, guard silent (no error log, `blocked` falsy). All-disabled (docs > 0, 0 active) commits, guard silent, `lastGood` shows `activeCount: 0` / `disabledCount: n`.
   5b. **Validation-evicts-all stays unguarded** (spec edge #14 — pins the raw-doc-count predicate as a KPR-296 discriminator): non-empty committed roster → all docs fail archetype validation (invalid `archetypeConfig` via `makeDefinition`) → load **commits** (`blocked` falsy, no `critical: true` log), previously-loaded agents land in `removed`, `getRosterGuardState().lastGood` shows `{ docCount: n, activeCount: 0 }`, `degraded` stays false. Guards against a future predicate switch to active-count that the rest of the suite wouldn't catch.
6. Retry timer: blocked load starts a 30s interval invoking the constructor's `onChangeDetected` (fake timers, advance 30s → called); second blocked load doesn't double-start (advance 30s → called exactly once more); `stopWatching()` clears it.
7. Retry tick with a throwing `onChangeDetected` → warn logged, no throw escapes (advance timers inside `expect(...).not.toThrow()` shape / no unhandled error).
8. Throwing logger inside the blocked path (stdout spy `mockImplementation(() => { throw ... })`) → `load()` still resolves `{ blocked: true }`, roster untouched (fail-open).
9. `getRosterGuardState()` snapshot after each transition; `lastGood.source === "boot"` after load #1, `"reload"` after load #2 (including when load #1 was empty-boot).
10. `buildRosterStatsDoc`: exact key-set snapshot (the 10 contract fields above, no extras) + value mapping from a populated guard state — this is the KPR-296 interface test.

**Acceptance:** all existing agent-registry tests still pass unmodified (optional field, no behavior change on the commit path).

**Verify:**
```
npm run typecheck
npx vitest run src/agents/agent-registry.test.ts
```
Commit: `feat(agents): empty-roster reload guard + degraded retry in AgentRegistry (KPR-295)`

---

## Task 2 — `index.ts` wiring: `safeReload`, `writeRosterStats`, blocked short-circuit

**Goal:** the five fire-and-forget sites can no longer produce an unhandled rejection; blocked reloads skip stops/schedules/skills/plugins; the contract doc is written on every load outcome via the guard-immune raw collection.

**Files:**
- `src/index.ts`

**Changes (exact placement):**

1. Import `buildRosterStatsDoc` from `./agents/agent-registry.js`.
2. **`writeRosterStats`** — const arrow defined immediately before the `reload` closure (`:176`) so both `reload()` and the boot path can call it (the spec's "beside the prefix-cache writer" placement is not reachable from the boot load at `:212`; keep a comment pointing at the family pattern at `:466`):
   ```ts
   const writeRosterStats = async () => {
     try {
       await rawTelemetryCollection.updateOne(
         { kind: "agent_roster_stats" },
         { $set: { ...buildRosterStatsDoc(registry.getRosterGuardState()), updatedAt: new Date() } },
         { upsert: true },
       );
     } catch (err) {
       log.warn("roster stats write failed", { error: String(err) });
     }
   };
   ```
   **Must use `rawTelemetryCollection` (`:150`), never the guarded `telemetryCollection` (`:465`)** — spec ⚠5: guarded writes are refused in the exact scenario this guard fires.
3. **`reload()` short-circuit** — replace `:181-182`:
   ```ts
   const result = await registry.load();
   await writeRosterStats();                // every outcome, incl. blocked
   if (result.blocked) return;              // roster kept; skip stops/schedules/skills/plugins
   ```
   Everything below (`added`/`updated` logs, `provisionAgentDirs`, `stopAgent` loop, disabled sweep, `reloadSchedules`, `reloadSkills`, `rescanPlugins`) is unreachable on a blocked load — spec ⚠3.
4. **`safeReload`** — defined right after the `reload` const:
   ```ts
   const safeReload = () => {
     reload().catch((err) => log.error("hot-reload failed — roster unchanged", { error: String(err) }));
   };
   ```
   (`String(err)` coercion only — the catch handler itself must not be able to throw.) Substitute at all five sites:
   - `:210` debounce → `reloadTimer = setTimeout(safeReload, 500)`
   - `:422` skills watcher → same
   - `:444` agent-skills watcher → same
   - `:457` SIGUSR1 → `safeReload()`
   - `:697` AdminApi → pass `safeReload` instead of `() => reload()` (no `admin-api.ts` change)
5. **Boot:** `:212` keeps `await registry.load()` with its current fatal-on-throw posture; add `await writeRosterStats();` immediately after it (initial write so the doctor never sees "no telemetry yet"; also the reason `lastGoodAt` is never null in a written doc — first write happens strictly after the boot commit).

**Acceptance (grep-level, record in commit/PR):**
- `grep -nE '(^|[^a-zA-Z])reload\(\)' src/index.ts` → no remaining bare fire-and-forget invocation; the only expected survivor is `safeReload`'s interior `reload().catch(...)` call (the pattern already excludes `safeReload()` and `registry.load()` by case/prefix). The word-boundary form is deliberate — plain `grep "reload()"` misses paren-less callback passes (`setTimeout(safeReload, 500)` leftovers can't be distinguished) and arrow-wrapped leftovers under reformatting. **Additionally**: manual five-site checklist in the Task 2 commit message — debounce `:210`, skills watcher `:422`, agents watcher `:444`, SIGUSR1 `:457`, AdminApi `:697` — each confirmed switched to `safeReload`.
- `grep -n "agent_roster_stats" src/index.ts` → single writer, on `rawTelemetryCollection`.
- Blocked-path behavior (`stopAgent`/`reloadSchedules`/`reloadSkills`/`rescanPlugins` not called) is structurally guaranteed by the early `return`; runtime-proven in Task 3's integration harness and the Task 4 manual drill — `reload()` is a `main()` closure and not directly unit-testable (spec Testing outline anticipates exactly this fallback).

**Verify:**
```
npm run typecheck
npm run lint
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run test
```
(Full run — index.ts wiring can break unrelated suites; env stubs per repo convention.)
Commit: `feat(engine): safeReload + blocked short-circuit + agent_roster_stats writer (KPR-295)`

---

## Task 3 — Integration test: incident + recovery through the mirrored reload path

**Goal:** wire the real `AgentRegistry` + real `buildRosterStatsDoc` over a switchable fake collection and a harness that mirrors `index.ts`'s wiring (`onChangeDetected` → 500ms debounce → `safeReload` → short-circuit → `writeRosterStats`), proving the incident scenario and auto-recovery end-to-end. Same posture as `src/db/db-identity.integration.test.ts` (fake driver, real modules, no mongod). **Drift guard:** the harness is a mirror, not the wired code — the test file MUST open with a header comment naming the mirrored `index.ts` anchors (`reload` closure `:176-206`, debounce `:208-211`, `safeReload` sites, `writeRosterStats`) so future editors of `index.ts` can discover and re-sync the mirror.

**Files:**
- `src/agents/roster-guard.integration.test.ts` (new)

**Setup:** mutable `docs` array behind `makeFakeCollection`-style stub; stub telemetry collection recording `updateOne(filter, update, opts)` calls; harness reproduces the index.ts closure verbatim in miniature — `stopAgent` / `reloadSchedules` / `reloadSkills` / `rescanPlugins` as `vi.fn()`; registry constructed with `onChangeDetected` = debounce(500ms) → `safeReload`; `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` (the debounce + 30s retry both hop timers around awaits).

**Scenarios:**
1. **The incident, end-to-end:** commit a 3-agent roster → set `docs = []` → fire the trigger (call `onChangeDetected` path or `safeReload()` directly, then flush) → `stopAgent` NOT called, `reloadSchedules`/`reloadSkills`/`rescanPlugins` NOT called, registry still serves all 3 agents, telemetry stub recorded an `agent_roster_stats` upsert with `degraded: true`, `docCount: 3` (last-good), `lastGoodAt` non-null. **(← second negative-verify target.)**
2. **Auto-recovery:** continue from (1) — restore `docs` → `advanceTimersByTimeAsync(30_000 + 500)` (retry tick + debounce) → commit applied, `degraded: false` in the next stats upsert, `lastRecoveryAt` set, retry stops (advance another 30s+500ms → no further reload).
3. **`safeReload` swallows rejection (edge #8):** make `find()` reject → `safeReload()` → no unhandled rejection (vitest fails on unhandled rejections by default), roster untouched, `degraded` still false (load failure ≠ guard event), `log.error` emitted.
4. **Stats write fail-open (edge #10):** telemetry stub `updateOne` rejects → blocked reload still completes, warn logged, no throw (roster decision already made).

**Verify:**
```
npm run typecheck
npx vitest run src/agents/roster-guard.integration.test.ts src/agents/agent-registry.test.ts
```
Commit: `test(agents): roster-guard integration — incident + recovery + fail-open (KPR-295)`

---

## Task 4 — Docs, negative-verify, final gate

**Goal:** CLAUDE.md contract note, negative-verify evidence for the incident-shaped tests, full check + bundle sanity.

**Files:**
- `CLAUDE.md`

**Changes:**
1. CLAUDE.md MongoDB collections line (Common Gotchas): add `agent_roster_stats` to the telemetry-kinds parenthetical — e.g. `telemetry (prefix-cache stats heartbeat KPR-213; spawn-coordinator stats heartbeat KPR-220; agent_roster_stats empty-roster guard KPR-295)`.

**Negative-verify (repo convention — record both outputs for the PR):**
- Target: the incident-shaped tests (Task 1 test #2 + Task 3 scenario #1).
- Procedure: temporarily neuter the fix — comment out the guard early-return in `load()` (the `if (docs.length === 0 && this.hadNonEmptyLoad)` block) — run `npx vitest run src/agents/agent-registry.test.ts src/agents/roster-guard.integration.test.ts` → confirm those tests **fail** with the pre-fix signature (roster swept into `removed`, `stopAgent` called); restore → confirm pass. This proves the tests detect the pre-fix wipe, not just their own plumbing.

**Final gate:**
```
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
npm run bundle   # esbuild sanity — pkg/ artifact must stay green
```
Commit: `docs: agent_roster_stats telemetry kind (KPR-295)`

---

## Testing Contract (MANDATORY)

### Unit
| File | Coverage |
|---|---|
| `src/agents/agent-registry.test.ts` (extend) | Guard predicate: boot-empty commits + guard stays unarmed (incl. second empty load); **non-empty → 0 blocks** — `blocked: true`, `removed: []`, roster/disabled/origin-index/post-reload-handlers all untouched, one `log.error` with `critical: true`; repeat block → `log.info` + counter (state-entry discipline); recovery — commit applies, degraded cleared, `lastRecoveryAt`, timer stopped, recovery `log.info`; shrinkage 5→2 and all-disabled commit silently; **fresh-install arming arc** (empty boot → seed arms → empty blocks, test 1b); **validation-evicts-all commits unguarded** with the KPR-296 doctor signature `{docCount: n, activeCount: 0, degraded: false}` (test 5b); retry timer starts/no-double-start/cleared-by-recovery-and-`stopWatching()` (fake timers); throwing `onChangeDetected` in the tick → warn, no escape; throwing logger in blocked path → still resolves `blocked: true` (fail-open); `getRosterGuardState()` transitions + `lastGood.source` boot→reload; `buildRosterStatsDoc` exact contract key-set snapshot (the KPR-296 interface). |

All boundary-mocked (fake collection objects, stdout-spy log capture, `vi.useFakeTimers()`), no real mongod, tests beside source per repo convention.

### Integration
`src/agents/roster-guard.integration.test.ts` — real `AgentRegistry` + real `buildRosterStatsDoc` over a switchable fake collection, with a harness mirroring the `index.ts` wiring (`onChangeDetected` → 500ms debounce → `safeReload` → blocked short-circuit → `writeRosterStats` on a recording telemetry stub; `stopAgent`/`reloadSchedules`/`reloadSkills`/`rescanPlugins` as spies). Scenarios: (1) incident end-to-end — empty read blocks, no agent stopped, no schedules/skills/plugins refresh, `degraded: true` stats upsert recorded; (2) auto-recovery via the 30s retry + debounce under fake timers, degraded cleared, retry stops; (3) rejecting `find()` through `safeReload` → no unhandled rejection, not degraded; (4) rejecting stats write → warn, fail-open.

### E2E — manual operator drill (documented substitute for automated e2e)
**Automated e2e is not possible in CI** — no `mongodb-memory-server` dependency and repo/spec conventions forbid a real mongod in CI (same posture as KPR-294's plan, followed as precedent). The following drill (spec §Manual drill) MUST be included verbatim in the PR description, with observed results if run pre-merge (recommended on a dev instance):

1. On a dev/non-production instance with seeded agents, confirm baseline: agents respond; `mongosh <db> --eval 'db.telemetry.findOne({kind:"agent_roster_stats"})'` shows `degraded: false`, correct `docCount`.
2. Simulate the incident: point the engine at an empty mongod (impostor on 27017, per the KPR-294 drill) **or** `db.agent_definitions.drop()` on a throwaway instance.
3. Send SIGUSR1 (`kill -USR1 <pid>`).
4. **Expected:** agents keep responding (roster held); log line `EMPTY ROSTER READ — keeping last-good roster` with `critical: true`; `agent_roster_stats` shows `degraded: true`, `blockedReloadCount` climbing ~every 30s.
5. Restore the DB (kill impostor / restore collection).
6. **Expected within ~30s:** recovery `log.info` (`roster reload recovered`), `degraded: false`, `lastRecoveryAt` set. **No engine restart, no operator ack at any point.**

### Negative-verify
For the incident-shaped regression tests (Task 1 test #2, Task 3 scenario #1): comment out the guard early-return in `load()`, run `npx vitest run src/agents/agent-registry.test.ts src/agents/roster-guard.integration.test.ts`, confirm they **fail** (roster swept / `stopAgent` fires — the pre-fix behavior), restore, confirm they pass. Include both run outputs in the PR description as evidence.

---

## New/changed public surfaces (complete list)

| Surface | Change | Consumers affected |
|---|---|---|
| `AgentRegistry.load()` | Return type gains optional `blocked?: boolean`; `{added:[],updated:[],removed:[],blocked:true}` on a blocked load | Exactly two callers: `src/index.ts:212` (boot — result discarded; unaffected) and the `reload()` closure `src/index.ts:181` (gains the short-circuit). All existing tests unaffected (optional field). |
| `AgentRegistry.getRosterGuardState()` | New getter — spec shape `{degraded, degradedSince, blockedReloadCount, lastBlockedAt, lastRecoveryAt, lastGood:{docCount, activeCount, disabledCount, at, source}}` | `writeRosterStats` (index.ts) + tests. No HealthReporter/Slack wiring (spec ⚠9). |
| `buildRosterStatsDoc(state)` | New pure export from `agent-registry.ts` — maps guard state → contract doc body | `writeRosterStats` + the contract snapshot test. |
| `safeReload` | New `main()` closure — `.catch → log.error` wrapper; replaces bare `reload()` at 5 sites | `index.ts` only. `AdminApi.onReload` signature unchanged. |
| `writeRosterStats` | New `main()` closure — `{kind:"agent_roster_stats"}` upsert on `rawTelemetryCollection`, `$set:{...doc, updatedAt}`, catch → warn | Called after boot load + on every `reload()` outcome. |
| `agent_roster_stats` doc | New telemetry kind — frozen contract per spec §Roster Stats Contract: `kind, docCount, activeCount, disabledCount, lastGoodAt, lastGoodSource, degraded, degradedSince, blockedReloadCount, lastBlockedAt, lastRecoveryAt, updatedAt`. Event-driven cadence (not a liveness heartbeat). Engine-only writer. | KPR-296 doctor (read-only). |

## Risks / Gotchas for the implementer

1. **Do not add awaits to `load()`'s commit or blocked paths.** The single-await invariant is the concurrency design (spec ⚠6). Telemetry is written by the *caller* (`reload()` / boot path) — never from inside the registry.
2. **No `firePostReload()` on a blocked load** — firing it would spuriously invalidate the prefix cache and team cache for a no-op.
3. **`rawTelemetryCollection`, not `telemetryCollection`.** The guarded handle rejects during the exact incident this guard exists for. Grep acceptance in Task 2 checks this.
4. **`blocked` must never be set on a legitimate empty boot commit** (`hadNonEmptyLoad === false`) — that path commits and records `lastGood.docCount: 0`, `source: "boot"`.
5. **Retry tick throw-safety.** The interval callback runs outside `blockEmptyReload()`'s try — it needs its own try/catch or a throwing `onChangeDetected` crashes the process while degraded (worst moment). `.unref()` the interval.
6. **Log assertions via stdout spy are format-coupled** — reuse the existing `captureWarnings` pattern (`agent-registry.test.ts:379`) generalized per level; don't invent a logger mock.
7. **Fake timers + debounce + retry interplay** (Task 3): use `vi.advanceTimersByTimeAsync` (async hops), flush microtasks after triggers, restore real timers in `afterEach`.
8. **`getRosterGuardState()` must return copies** — a caller mutating `lastGood` through the getter would corrupt guard state.
9. **Escape-hatch wording stays in the alarm hint** (restart commits the empty set — spec ⚠2); don't soften or drop it.
10. **esbuild bundle** must stay green (`npm run bundle`); no `import.meta.url` entry-guard patterns in touched modules (repo feedback, KPR-183).
11. **Log discipline:** `critical: true` in the `log.error` metadata on state entry only; repeat blocks are `log.info`. No new log level.

## Rollback

Purely additive hardening — no schema migration, no config surface, no data rewrite. Rollback = revert the (≤4) commits; the engine returns to unconditional-commit behavior. An orphaned `agent_roster_stats` doc in `db.telemetry` is inert (doctor treats doc-absent and doc-stale identically per contract read semantics). `safeReload` and the short-circuit have no state; removing them restores the prior fire-and-forget wiring verbatim.
