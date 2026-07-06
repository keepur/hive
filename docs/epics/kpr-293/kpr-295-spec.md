# KPR-295 — Empty-roster reload guard + alarm (W1A.2)

**Epic:** KPR-293 W1A: Production hardening & hygiene (hive) — `epic-signed-off` (Gate 1 delegated; ⚠ marks delegated design choices).
**Consumers of this spec:** the KPR-295 implementation plan, and KPR-296 (hive doctor identity checks), which consumes the **Roster Stats Contract** section below as a public interface — frozen the way KPR-294 froze its Sentinel Contract.

## TL;DR

A registry reload that reads **0 `agent_definitions` docs after a previously non-empty roster** no longer commits: the last-good roster stays live, the reload aborts before any `stopAgent`, and the engine alarms with a `critical: true` error log plus an `agent_roster_stats` telemetry doc marked `degraded: true` (written via the KPR-294 guard-immune raw telemetry collection — the exact scenario that fires this guard is the scenario where guarded writes are refused). A 30s registry-owned retry keeps re-attempting; the first reload that returns a non-zero doc set commits normally, clears degraded state, and logs recovery — no operator ack (canon). This is the read-side complement to KPR-294's write guard: during the Jul 4 impostor incident, a single SIGUSR1 would have wiped the live roster via `stopAgent` on every agent.

## Key Points

- **Guard predicate: `docs.length === 0 && hadNonEmptyLoad`** — fires only on the →0 cliff after at least one committed non-empty load this process lifetime. First-ever boot load against an empty DB (fresh install pre-seed) commits normally. Partial shrinkage (5 agents → 2) commits normally — only the cliff is the incident signature.
- ⚠ **Guard keys on raw doc count, not active-agent count.** All-agents-disabled (docs > 0, active roster 0) commits normally — `disabled: true` is explicit operator state recorded in the DB; the incident signature is an *empty collection*, i.e. data that was never written there. Corollary: docs > 0 with every doc failing validation also commits (evicting all — existing fail-closed intent, edge #14); the guard bounds the empty-collection signature only.
- **Blocked reload = full no-op commit**: `this.agents` / `disabledAgents` / `originToAgent` / `lastPollTime` untouched, `removed` empty (so `reload()` calls `stopAgent` on no one), post-reload handlers not fired. `load()` returns `blocked: true` and the `reload()` closure short-circuits — schedules/skills/plugins refresh is also skipped (⚠ same-DB reads are equally suspect; `scheduler.reloadSchedules()` against an impostor has the same wipe shape).
- **Alarm is fail-open**: the keep-last-good decision is an early `return` that performs no I/O; the critical log and telemetry write happen after the decision, each throw-safe (telemetry failure → `log.warn`, continue). A blocked load can never reject.
- **Telemetry kind `agent_roster_stats`** — `{kind}`-keyed singleton in `db.telemetry` (family: `prefix_cache_stats` / `db_identity_stats`), written on every load outcome via the **raw guard-immune** telemetry collection (`src/index.ts:150`, KPR-294 ⚠11 rationale applies verbatim). ⚠ Event-driven cadence (per load, ~30s while degraded via the retry), not a free-running 30s heartbeat — no monitor loop exists here; KPR-296 must key on `degraded`/`lastGoodAt`, not `updatedAt` freshness.
- **Auto-recovery (canon)**: degraded state starts a registry-owned 30s unref'd retry that funnels through the existing `onChangeDetected` → debounced-reload path; first non-empty load commits, clears degraded, logs recovery at `info`. Sustained-condition discipline: `critical` once at state entry, quiet (`info` with counter) on repeat blocks.
- ⚠ **No reload serialization added.** `load()` has exactly one `await` (the `find().toArray()`) followed by a fully synchronous validate+commit; concurrent loads therefore commit atomically in event-loop order and the guard predicate reads committed state after the await. Correct as-is; a code comment pins the single-await invariant for future editors.
- ⚠ **SIGUSR1/debounce unhandled-rejection hardening is in scope** (a few lines): all five fire-and-forget `reload()` call sites — debounce, both skills watchers, SIGUSR1, and the AdminApi `onReload` callback — route through a `safeReload()` wrapper with `.catch` → `log.error`. A rejecting `load()` (DB unreachable) already leaves the roster untouched — the fix stops the rejection from killing the process. A load *failure* is not a guard event (no empty read was observed): log, keep roster, not degraded.
- ⚠ **Intentional full-roster deletion is blocked at runtime by design**; the alarm message names the escape hatch (restart the engine — the boot load has no previous roster and commits the empty set). Deleting every agent including the default agent is decommissioning, not an operation the hot path needs to honor.

## Problem / Context

Jul 4 incident: an impostor mongod on 27017 served an empty database while the driver silently reconnected. KPR-294 (merged, `5fd207b`) closed the **write** side — identity mismatch engages a write guard, reads continue. But reads continuing is exactly how the roster dies: `AgentRegistry.load()` (`src/agents/agent-registry.ts:119`) does `this.agentDefs.find().toArray()` and **unconditionally commits** — every previously-loaded agent absent from `docs` is deleted from `this.agents` and pushed to `removed` (`:234-240`); the `reload()` closure (`src/index.ts:176`) then calls `agentManager.stopAgent(id)` for each (`:186-191`). Zero docs ⇒ the entire live roster is swept and every agent stopped. During the incident, one SIGUSR1 — or one tick of the 500ms-debounced change-stream/poll trigger (`:208-211`), or a skills-dir watcher event (`:421-423`, `:443-444`) — would have done it. (Audit §2/§9.)

Verified current state (paths relative to repo root, epic branch `kpr-293` with KPR-294 merged):

- `load()` call sites: exactly two — boot `await registry.load()` (`src/index.ts:212`) and the `reload()` closure (`:181`). All reload triggers (SIGUSR1 `:455-458`, change-stream/poll debounce `:208-211`, both skills watchers, and the AdminApi `onReload` callback `:697` — invoked synchronously at 5 handler sites in `src/admin/admin-api.ts:200,229,240,254,293`) funnel into `reload()`.
- `reload()` is invoked fire-and-forget with no `.catch` at every trigger site — a rejecting `load()` is an unhandled rejection (process-fatal under Node's default policy).
- `load()` structure: one `await` (`:120`), then synchronous diff+commit through `firePostReload()` (`:244`). `previousIds` is snapshotted *after* the await (`:121`).
- KPR-294 plumbing available in `main()`: `rawTelemetryCollection` (guard-immune, `src/index.ts:150`), `writeGuard`, `DbIdentityMonitor`. During an impostor episode the guarded `db.collection("telemetry")` write path **rejects** — the prefix-cache heartbeat's guarded writes fail into their catch. Roster alarm telemetry must therefore use the raw collection.
- Registry already owns a 30s constant (`POLL_INTERVAL_MS`, `agent-registry.ts:13`), a `stopWatching()` teardown, and the `onChangeDetected` callback that feeds the debounced reload.
- Telemetry family pattern: `{kind}`-keyed upsert, `$set: { ...stats, updatedAt }`, best-effort catch+warn (`spawn-coordinator-heartbeat.ts:46-67`, prefix-cache writer `index.ts:466-477`).
- Log discipline precedent: `DbIdentityMonitor` logs `critical: true` only on state *entry* (`src/db/identity-sentinel.ts:600-610`), quiet on sustained condition.

## Goals

1. A reload observing 0 docs after a committed non-empty load keeps the last-good roster intact and stops no agents.
2. Alarm loudly on guard entry: `log.error` with `critical: true` + `agent_roster_stats` telemetry with `degraded: true`, both fail-open.
3. Auto-recover on the first non-empty reload; log recovery; clear degraded state.
4. Persist a stable last-good-roster contract (count, timestamp, source) that KPR-296's out-of-process doctor can read.
5. Fire-and-forget `reload()` call sites can no longer produce an unhandled rejection.

## Non-Goals

- **Boot-time zero-roster detection.** The boot load has no in-process history (`hadNonEmptyLoad` starts false), and reading persisted `agent_roster_stats` from the *connected* DB proves nothing — an empty impostor has no stats doc either, indistinguishable from a fresh install. Boot-into-impostor is covered by KPR-294's sentinel (absent-at-boot → stamp is the deliberate upgrade-path trade-off) and by KPR-296's doctor, which can compare independently.
- **Partial-shrinkage heuristics** (e.g. alarm on >50% roster drop). Only the →0 cliff is the incident signature; partial deletes are routine operator actions. Explicitly out to avoid false-positive fatigue.
- **Coupling the registry to the KPR-294 write guard** (e.g. refusing all roster commits while identity mismatch is engaged). Considered and rejected: adds coupling for a scenario (impostor pre-populated with *plausible non-empty* agent docs) that is adversarial territory — outside KPR-294's stated threat model — and would block legitimate reloads during `cant_verify` false positives.
- **Doctor-side rendering / checks** — KPR-296's scope; this ticket only freezes the contract.
- **Guarding `scheduler.reloadSchedules()` / skills / plugins refresh independently** — they are skipped when the roster load is blocked (cheap, same trigger), but get no guards of their own.
- **HealthReporter / Slack surfacing of degraded state** — in-process surface is a registry getter + telemetry; anything richer is future work.

## Design

All roster-guard state lives in `AgentRegistry` (it owns the maps being protected); telemetry writing lives in `src/index.ts` next to its family (the registry stays Mongo-collection-agnostic beyond `agentDefs`).

### Guard in `AgentRegistry.load()`

New private state:

```ts
private hadNonEmptyLoad = false;          // true after any commit with docs.length > 0
private rosterGuard = {
  degraded: false,
  degradedSince: null as Date | null,
  blockedReloadCount: 0,                  // cumulative since boot
  lastBlockedAt: null as Date | null,
  lastRecoveryAt: null as Date | null,
};
private lastGood = {
  docCount: 0,
  activeCount: 0,
  disabledCount: 0,
  at: null as Date | null,
  source: "boot" as "boot" | "reload",
};
private degradedRetryTimer: ReturnType<typeof setInterval> | null = null;
```

`load()` gains the guard check immediately after the `find()` resolves, before any mutation:

```ts
const docs = await this.agentDefs.find().toArray();
if (docs.length === 0 && this.hadNonEmptyLoad) {
  return this.blockEmptyReload();        // ← mutates nothing, never throws
}
```

`blockEmptyReload()` semantics:

| Aspect | Behavior |
|---|---|
| Roster state | `this.agents`, `disabledAgents`, `originToAgent`, `lastPollTime` — all untouched. No `firePostReload()` (state did not change; prefix cache stays valid). |
| Return value | `{ added: [], updated: [], removed: [], blocked: true }` — `removed` empty is the load-bearing part: `reload()` stops no agents. |
| Logging | State entry (`degraded` false→true): `log.error("EMPTY ROSTER READ — keeping last-good roster", { critical: true, lastGoodDocCount, lastGoodAt, hint: "DB may be an impostor or wiped — see hive doctor / db_identity_stats. If you intentionally deleted all agents, restart the engine to apply." })`. Repeat blocks while already degraded: `log.info` with `blockedReloadCount` (canon: critical once per state change, not every tick). |
| State updates | `degraded = true`, `degradedSince ??= now`, `blockedReloadCount++`, `lastBlockedAt = now`. |
| Retry | Starts `degradedRetryTimer` (30s, unref'd, reuses `POLL_INTERVAL_MS`) if not already running. The tick body is try/wrapped — `setInterval(() => { try { this.onChangeDetected?.(); } catch (err) { log.warn("degraded-retry tick failed", { error: String(err) }); } }, POLL_INTERVAL_MS)` — because the interval callback runs outside `blockEmptyReload()`'s wrapper and an uncaught throw there is an `uncaughtException` → process crash, firing only while already degraded (worst moment). Same precedent as `startPolling()`'s wrapped tick (`agent-registry.ts:268-279`). Funneling through `onChangeDetected` reuses the existing 500ms debounce and the full `reload()` closure — no second reload path. Needed because neither existing trigger fires on recovery: the change stream has typically errored into polling by then, and the poll predicate (`updatedAt > lastPollTime`) can miss docs whose `updatedAt` predates the incident. |
| Throw-safety | The entire method body past the early state updates is try/wrapped; it cannot reject (Goals #1 must hold even if logging explodes). |

Commit path (docs.length > 0, or 0 with `hadNonEmptyLoad === false`): unchanged validation/diff logic, plus at the end:

- `hadNonEmptyLoad ||= docs.length > 0`
- `lastGood = { docCount: docs.length, activeCount: this.agents.size, disabledCount: newDisabled.length, at: now, source }` — `source` is `"boot"` for the first `load()` of the process, `"reload"` after (tracked with a `hasLoadedOnce` flag; no caller signature change).
- Recovery (`degraded === true` entering a commit): clear `degraded`/`degradedSince`, set `lastRecoveryAt`, stop `degradedRetryTimer`, `log.info("roster reload recovered — last-good roster replaced", { agents: docs.length, blockedReloadCount })`. Recovery on *any* committed load — including a legitimate-boot-shaped empty commit, which cannot occur here since `hadNonEmptyLoad` is already true; in practice recovery is always non-empty.

New public surface (design question #6 — minimal):

```ts
getRosterGuardState(): {
  degraded: boolean;
  degradedSince: Date | null;
  blockedReloadCount: number;
  lastBlockedAt: Date | null;
  lastRecoveryAt: Date | null;
  lastGood: { docCount: number; activeCount: number; disabledCount: number; at: Date | null; source: "boot" | "reload" };
}
```

`stopWatching()` additionally clears `degradedRetryTimer`.

A code comment above the `await` pins the concurrency invariant: *`load()` must keep exactly one await before the synchronous commit; the guard's correctness (and the diff's atomicity) depends on it.*

### Concurrency (design question #2 — resolved: no serialization)

Two overlapping `load()`s (SIGUSR1 calls `reload()` directly while the debounced timer fires another) each: await their own `find()`, then run a fully synchronous diff+commit against whatever state the *other* already committed (`previousIds` is read after the await, `agent-registry.ts:121`). Commits interleave at event-loop granularity — i.e., not at all mid-commit. Worst case is last-writer-wins between two self-consistent snapshots, which is today's behavior, unchanged. The guard adds no new hazard: a blocked load mutates nothing, and its predicate reads `hadNonEmptyLoad` post-await, so a concurrent non-empty commit landing first simply makes the empty read block (correct — the empty read is stale or hostile either way). Adding a mutex/coalescer would be dead weight (YAGNI); the invariant comment is the cheap insurance.

### `src/index.ts` changes

1. **`safeReload` wrapper (design question #5 — in scope):**

   ```ts
   const safeReload = () => {
     reload().catch((err) => log.error("hot-reload failed — roster unchanged", { error: String(err) }));
   };
   ```

   The catch handler passes only primitive fields (`String(err)` coercion, no raw error objects) so the handler itself cannot throw during serialization — a rejecting catch handler would recreate the unhandled rejection Goal 5 eliminates.

   Used at all five fire-and-forget sites: the debounce `setTimeout` in the registry callback (`:210`), both skills watchers (`:422`, `:444`), SIGUSR1 (`:457`), and the AdminApi constructor callback (`:697` — pass `safeReload` instead of `() => reload()`; `AdminApi.onReload` is `() => void` and discards the promise, so its 5 handler invocations are equally fire-and-forget). The boot `await registry.load()` (`:212`) keeps its current fatal-on-throw posture — boot Mongo failures are already fatal, same as KPR-294's stance.

2. **`reload()` short-circuit:**

   ```ts
   const result = await registry.load();
   await writeRosterStats();                     // every outcome, incl. blocked
   if (result.blocked) return;                   // roster kept; skip stops/schedules/skills/plugins
   ```

3. **`writeRosterStats()`** — inline helper beside the prefix-cache writer, upserting the contract doc below to **`rawTelemetryCollection`** (the KPR-294 guard-immune handle, `:150`), best-effort catch + `log.warn` (family pattern). Called: once after the boot load (initial write so doctor never sees "no telemetry yet"), and once per `reload()` (step 2). While degraded, the 30s retry → debounced reload → `writeRosterStats` chain refreshes it every ~30s automatically.

### Alarm fail-open (design question #3 — resolved)

Ordering inside a blocked load: (1) early-return decision + state flags — pure memory, cannot throw; (2) log call; (3) telemetry happens *outside* the registry, in `reload()`'s `writeRosterStats`, itself wrapped. The registry never awaits telemetry; `blockEmptyReload()` is synchronous and wrapped so even a throwing logger cannot convert a blocked load into a rejection. Nothing on the alarm path can prevent keeping the roster or crash the reload.

## Roster Stats Contract (stable interface — KPR-296 depends on this)

**Collection:** `telemetry` (instance DB). **Document:** `{kind}`-keyed singleton, upserted with `$set: { ...stats, updatedAt }`.

| Field | Type | Frozen? | Semantics |
|---|---|---|---|
| `kind` | `"agent_roster_stats"` | **frozen** | Singleton key. Read with `findOne({ kind: "agent_roster_stats" })`. |
| `docCount` | `number` | **frozen** | `agent_definitions` doc count at the last **committed** load. The doctor's compare-target: current live count vs this. |
| `activeCount` | `number` | **frozen** | Enabled agents loaded at last committed load (post-validation evictions). |
| `disabledCount` | `number` | stable | Disabled agents at last committed load. |
| `lastGoodAt` | `Date` | **frozen** | Timestamp of the last committed load. Never compared to wall clock by the engine. Never null in a written doc: `writeRosterStats` first runs after the boot commit, and a blocked load presupposes a prior commit — the doc is only ever written with `lastGood.at` populated (the in-process getter's `Date \| null` is pre-first-commit state that never reaches telemetry). |
| `lastGoodSource` | `"boot" \| "reload"` | **frozen** | Which path committed it. |
| `degraded` | `boolean` | **frozen** | Guard currently engaged (last read was a blocked empty roster). |
| `degradedSince` | `Date \| null` | stable | Entry time of the current degraded episode, else null. |
| `blockedReloadCount` | `number` | stable | Cumulative blocked reloads since boot. |
| `lastBlockedAt` | `Date \| null` | stable | Most recent blocked reload. |
| `lastRecoveryAt` | `Date \| null` | stable | Most recent degraded→recovered transition. |
| `updatedAt` | `Date` | **frozen (field)** | Write time. **Event-driven** — see below. |

**Read semantics for consumers (doctor):**
- `degraded: true` → the engine is holding a last-good roster in memory that the DB no longer reflects. Report `docCount`/`lastGoodAt` vs the DB's current `agent_definitions` count.
- Doc absent + `agent_definitions` non-empty → pre-KPR-295 engine or engine hasn't booted since upgrade (same posture as the sentinel's absent-doc row) — or the telemetry collection itself is impostor-fresh; cross-check `db_identity_stats` and the sentinel.
- Doc absent + DB empty → fresh install or impostor; the sentinel check (KPR-296) is the discriminator, not this doc.
- **`updatedAt` is not a liveness signal.** Healthy engines write this doc only on load events (boot, reloads); a days-old `updatedAt` with `degraded: false` is normal. While degraded it refreshes ~every 30s via the retry loop. Doctor liveness checks belong to the free-running heartbeat kinds (`prefix_cache_stats` etc.).
- Doctor MUST NOT write this doc.

**Who writes:** only the engine (`writeRosterStats` in `src/index.ts`), always via the guard-immune raw telemetry collection.

## Failure Modes & Edge Cases

| # | Scenario | Behavior |
|---|---|---|
| 1 | **The incident**: impostor DB, SIGUSR1 (or watcher/change-stream trigger) fires reload | `find()` → 0 docs, `hadNonEmptyLoad` true → blocked. Roster + agents untouched, `stopAgent` never called, critical log, `degraded: true` telemetry via raw collection (guarded writes are refused right then — KPR-294 mismatch — raw handle is why this still lands). 30s retry begins. |
| 2 | Real mongod returns after the episode | Retry tick → debounced reload → `find()` returns real docs → normal commit, degraded cleared, retry timer stopped, recovery `log.info`, telemetry flips. No operator ack (canon), symmetric with KPR-294 edge #3. |
| 3 | Fresh install, boot, empty DB | `hadNonEmptyLoad` false → guard silent, empty roster commits, `lastGoodSource: "boot"`, `docCount: 0`. Seeding later triggers a normal non-empty reload which arms the guard. |
| 4 | Boot against impostor (restart during episode) | Not this guard's scenario (no in-process history; Non-Goals) — KPR-294 boot sentinel + KPR-296 doctor own the boot window. Recovery gap after such a boot: see edge #15. |
| 5 | Operator disables every agent | Docs > 0 → commits normally (`activeCount: 0`, `disabledCount: n`). Explicit recorded operator state, not the incident signature. |
| 6 | Operator deletes agents 5 → 2 | Commits normally — partial shrinkage is legitimate; only →0 blocks. Boundary stated in the alarm hint and here. |
| 7 | Operator intentionally deletes ALL agents | Blocked + alarm (indistinguishable from the incident at runtime, by design). Escape hatch in the log hint: restart the engine — boot load commits the empty set. |
| 8 | `find()` rejects (DB unreachable) during reload | Not a guard event — no empty read observed. `load()` rejects before any mutation (roster naturally kept); `safeReload` catches → `log.error`; not degraded; existing change-stream/poll machinery retriggers. |
| 9 | Two concurrent reloads (SIGUSR1 + debounce) | Safe without serialization — single-await + synchronous commit; see Concurrency. Blocked loads mutate nothing regardless of interleaving. |
| 10 | Telemetry write fails during alarm | `log.warn`, continue — roster decision already made, log already emitted. Fail-open verified by test. |
| 11 | Repeat blocked reloads while degraded | No repeat criticals — `log.info` with counter (sustained-condition discipline, canon). |
| 12 | Engine shutdown while degraded | `stopWatching()` clears the retry timer alongside the change stream/poll timer. |
| 13 | Empty read races a concurrent non-empty commit | Whichever commits first wins the map; the empty read blocks either way once any non-empty commit has set `hadNonEmptyLoad`. Never wipes. |
| 14 | **Validation evicts every agent** (docs > 0, all fail archetype validation or KPR-221 delegate checks) | Commits normally — every previously-loaded agent lands in `removed`, roster stops, guard silent. **Deliberately unguarded** (⚠1: raw-doc-count predicate; fail-closed validation is existing intent; a non-empty-invalid-docs impostor is the stated adversarial non-goal). This is the one remaining single-reload full-wipe path (e.g. engine/data version skew). Doctor-visible signature for KPR-296: `docCount > 0`, `activeCount: 0`, `degraded: false` — distinguishable from both the incident (degraded) and all-disabled (`disabledCount` = n). |
| 15 | Restart while degraded (engine restarts mid-episode) | Boot load has no history → commits the empty set (this **is** edge #7's escape hatch — by design). No degraded retry armed; when the real DB returns, the poll predicate misses docs whose `updatedAt` predates the incident and the change stream was established against the impostor — the engine can sit empty until a trigger. Operator remediation: SIGUSR1 after DB restore (or any agent-def touch); KPR-296's doctor flags the divergence (stats doc vs live count). Boot window is a stated Non-Goal; this row exists to name the remediation. |

## Integration Points (exact files/functions)

| File | Change |
|---|---|
| `src/agents/agent-registry.ts` | Guard state + `hadNonEmptyLoad` + `lastGood` tracking; empty-read early return in `load()` (`blockEmptyReload()`); `blocked?: boolean` on the `load()` result; degraded 30s retry timer (via `onChangeDetected`, cleared in `stopWatching()` + on recovery); `getRosterGuardState()` getter; single-await invariant comment. |
| `src/index.ts` | `safeReload()` wrapper replacing bare `reload()` at `:210`, `:422`, `:444`, `:457`, and the AdminApi callback `:697`; `reload()` writes roster stats then short-circuits on `blocked`; `writeRosterStats()` helper using `rawTelemetryCollection` (`:150`); initial stats write after the boot load (`:212`). |
| `CLAUDE.md` | Add `agent_roster_stats` to the telemetry kinds note in the MongoDB collections line. |

No changes to `AgentManager`, dispatcher, adapters, doctor (KPR-296), scheduler, or the KPR-294 modules. No config surface — the guard has no tunables (⚠ deliberately: a "disable the guard" knob is an anti-feature for an incident-response hardening; the restart escape hatch covers the one legitimate bypass).

## Testing outline

Conventions: `vi.mock` boundary stubs, no real mongod, tests beside source (`src/agents/agent-registry.test.ts` — extend existing file if present, else create).

**Unit — guard predicate:**
- Boot-shaped first load with 0 docs → commits (empty roster, `blocked` undefined/false), guard unarmed.
- Non-empty load then 0-doc load → `blocked: true`, `removed` empty, `agents`/`getDisabled()`/origin index unchanged, post-reload handlers NOT fired, `log.error` called once with `critical: true`.
- 0-doc load then another 0-doc load → second logs `info` not `error` (state-entry discipline), counter increments.
- Non-empty → 0 (blocked) → non-empty → recovery: commit applies, `degraded` false, `lastRecoveryAt` set, retry timer cleared, recovery `log.info`.
- Shrinkage 5 → 2 → commits, guard silent. All-disabled (docs > 0, 0 active) → commits, guard silent.
- Retry timer: blocked load starts a 30s interval invoking `onChangeDetected` (fake timers); recovery/`stopWatching()` clears it; second blocked load doesn't double-start.
- Retry tick with a throwing `onChangeDetected` (fake timers) → warn logged, no throw escapes the tick (process-crash guard).
- Throwing logger inside the blocked path → `load()` still resolves with `blocked: true` (fail-open).
- `getRosterGuardState()` snapshot matches after each transition; `lastGood.source` is `"boot"` for load #1, `"reload"` after.

**Unit — index wiring** (extracted or closure-tested per existing index-test patterns; if `reload()` isn't unit-testable today, cover via the registry result contract + a focused test on `writeRosterStats` shape):
- `writeRosterStats` upserts `{ kind: "agent_roster_stats" }` with the full contract shape (field-name snapshot — this is the KPR-296 interface).
- Stats write rejecting → warn, no throw.
- Blocked result → `stopAgent` not called, `reloadSchedules`/`reloadSkills`/`rescanPlugins` not called.

**Negative-verify (operator convention):** for the incident-shaped test (non-empty → 0 keeps roster), confirm it fails against pre-fix `load()` (roster swept into `removed`) before landing.

**Manual drill (PR description, not automated):** on a dev instance — seed agents, point the engine at an empty mongod (or drop `agent_definitions`), send SIGUSR1, observe: agents keep responding, critical log line, `agent_roster_stats.degraded: true`; restore the DB, observe recovery within ~30s. ⚠ Same not-CI-automatable posture as KPR-294.

## Delegated Assumptions (⚠)

1. ⚠ **Raw-doc-count predicate** (`docs.length === 0`), not active-agent count — all-disabled is recorded operator intent; empty collection is the incident signature.
2. ⚠ **Runtime full-roster deletion is blocked**; escape hatch = engine restart (boot load commits empty). Named in the alarm hint. No bypass knob.
3. ⚠ **Blocked reload short-circuits the entire `reload()` closure** — schedule/skill/plugin refresh skipped too, since they read the same suspect DB.
4. ⚠ **Telemetry kind `agent_roster_stats`**, `{kind}`-keyed singleton, **event-driven cadence** (per load; ~30s while degraded) rather than a free-running heartbeat — no monitor loop exists here; contract tells KPR-296 not to use `updatedAt` as liveness.
5. ⚠ **Alarm telemetry uses the KPR-294 raw guard-immune collection** — guarded writes are refused in the exact scenario this guard fires (canon ⚠11 rationale extended to the read-side complement).
6. ⚠ **No reload serialization** — single-await + synchronous-commit structure makes concurrent loads safe; invariant pinned by comment, not by mutex.
7. ⚠ **`safeReload` hardening in scope** (five call sites: debounce, two skills watchers, SIGUSR1, AdminApi `onReload`); boot load keeps fatal-on-throw. Load *rejection* ≠ guard event: roster kept, logged, not degraded.
8. ⚠ **Degraded retry = registry-owned 30s unref'd interval** funneling through `onChangeDetected` → existing debounced reload (reuses `POLL_INTERVAL_MS`; no second reload path).
9. ⚠ **In-process surface = `getRosterGuardState()` getter only** — no HealthReporter/Slack wiring; doctor consumes telemetry (KPR-296).
10. ⚠ **Recovery logs at `info`** (critical reserved for state entry), matching KPR-294's recovery-line precedent.

## Decision Register note

Canon (KPR-294, merged `5fd207b`) is followed, not re-litigated: detection-not-fencing posture; `{kind}`-keyed `*_stats` telemetry family; `critical: true` marker on `log.error` (no new level); sustained-condition log discipline (critical once per state change); auto-recovery without operator ack; guard-immune telemetry for the alarm path. The **Roster Stats Contract** section above is this ticket's registered interface decision for the KPR-296 dependency.
