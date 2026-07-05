# KPR-294 — DB identity sentinel (W1A.1)

**Epic:** KPR-293 W1A: Production hardening & hygiene (hive) — `epic-signed-off` (Gate 1 delegated; ⚠ marks delegated design choices).
**Consumers of this spec:** the KPR-294 implementation plan, and KPR-296 (hive doctor identity checks), which consumes the **Sentinel Contract** section below as a public interface.

## TL;DR

The engine stamps an instance-identity sentinel document into its MongoDB database on first boot, verifies it immediately after every connect, and re-verifies on driver topology/reconnect events plus a 30s periodic tick. On verified mismatch (or sentinel vanished at runtime — the Jul 4 impostor signature), the engine refuses all writes through the shared Mongo client via a collection-proxy write guard, logs at error level with a `critical: true` marker, and heartbeats a `db_identity_stats` telemetry doc. Detection latency: typically seconds (SDAM event → one `findOne`), worst case ~30s (periodic backstop when a seamless swap emits no usable event). Boot-time mismatch is fatal (exit 1); runtime mismatch is recoverable — a later successful verification (real mongod returns) automatically lifts the refusal.

## Key Points

- **Detection, not fencing.** This bounds the impostor-write window from 25 hours to seconds (worst case ~30s via the periodic backstop); it does not transactionally fence in-flight writes racing the verification read (explicit non-goal).
- **Sentinel = singleton doc** `_id: "identity_sentinel"` in new collection `instance_identity`, carrying `instanceId` + `dbName` + metadata. Verification compares `instanceId` and `dbName` against config. Frozen-field contract for KPR-296 below.
- **Asymmetric absent-doc handling:** at boot, absent → stamp it (this is the only sane upgrade path — every existing instance is sentinel-less today). At runtime re-verification, absent → treated as mismatch (that IS the incident: silent reconnect to an empty impostor).
- **Write refusal = Proxy wrap of the shared `Db`**: `db.collection()` returns a proxied `Collection` whose enumerated write methods reject with `DbIdentityMismatchError` while the guard is engaged. Covers every runtime engine consumer (all receive `db` from `src/index.ts:117`). Reads continue. Out-of-process CLI tools with private clients (wizard, doctor, import-hubspot, standalone CodeIndexer) are explicitly not covered — rationale below.
- **Fail-closed on persistent can't-verify:** transient read failures get a bounded retry grace (3 attempts / ~15s); if the server remains selectable but the sentinel remains unreadable, writes are refused until a verification succeeds. The incident argues reachable-but-unverifiable is exactly the suspect state.
- **Telemetry kind `db_identity_stats`** — singleton keyed `{kind}`, upserted on each monitor tick, matching the `prefix_cache_stats` / `spawn_coordinator_stats` / `memory_lifecycle_stats` family (snake_case, `*_stats`, 30s cadence, `updatedAt`).
- **Operator override:** `HIVE_DB_SENTINEL_RESTAMP=1` (env / `.env`, one boot) re-stamps the sentinel with the current identity. Needed only for the intentional adopt-another-instance's-DB case; fresh installs, upgrades, same-instance restores, dbName changes, and host moves all work with zero operator action (walkthrough below).
- ⚠ Delegated assumptions are collected in their own section: no new log level (`critical: true` marker on `log.error`), reads-not-blocked during mismatch, agents not paused, boot mismatch fatal, env-var override shape, new `src/db/` directory, timing constants.
- **Decision Register canon: NONE exists for this epic (pre-register epic).** Noted per process; not a blocker. The Sentinel Contract section is the de-facto registered decision for the KPR-296 dependency.

## Problem / Context

Jul 4 incident: the real mongod on `localhost:27017` went away; a stray/impostor mongod (writing under `/tmp`) came up on the same port. The Node driver's SDAM layer silently reconnected — `retryWrites`/`retryReads` made every operation "succeed" — and **both production hives wrote to the impostor for ~25 hours** with zero signal. Nothing in the engine verifies that the mongod behind `config.mongo.uri` is the database this instance stamped its data into. (System design audit §2/§9.)

Verified current state (all paths relative to repo root):

- Single shared `MongoClient` in `main()` — `src/index.ts:108-117` (`heartbeatFrequencyMS: 30_000`, `serverSelectionTimeoutMS: 10_000`, `retryWrites/retryReads: true`); `db = mongoClient.db(config.mongo.dbName)` is injected into all runtime consumers (KPR-121 comment at `src/index.ts:104-107` is accurate — the digest's caveat about memory-manager/session-store/scheduler private clients is **stale**; grep confirms the only `new MongoClient` sites outside `index.ts` are `src/setup/wizard.ts`, `src/contacts/import-hubspot.ts`, `src/code-index/indexer.ts` (standalone indexing, runtime prefetcher receives shared `db`), and `src/cli/doctor-checks.ts` — all operator-driven/out-of-process).
- Zero SDAM/topology event listeners anywhere today (greenfield).
- Startup order (`src/index.ts` `main()`): integrity checks (fatal) → `mongoClient.connect()` (throw = fatal) → `agent_definitions` `createIndex` × 2 → `runMigrations(db)` (fatal) → registry/manager/scheduler → adapters → heartbeats (`prefix_cache_stats` at :427-442, `SpawnCoordinatorHeartbeat` at :447-449, `MemoryLifecycleHeartbeat` at :454).
- Identity config: `config.instance.id` (`src/config.ts:86`, default `"hive"`), `config.mongo.dbName` (`src/config.ts:184-185`, default `hive_${instanceId}`).
- Logger (`src/logging/logger.ts`): levels `debug|info|warn|error` only; no `critical`.
- No write-gating/degraded-mode mechanism exists.
- mongodb driver `^7.1.0` (SDAM events `serverDescriptionChanged`, `topologyDescriptionChanged`, `connectionPoolCleared` available; `ServerDescription.topologyVersion.processId` present for MongoDB 4.4+).
- No `$out`/`$merge` aggregation stages anywhere in `src/` (aggregate can safely remain un-gated).

## Goals

1. Stamp an instance-identity sentinel at first engine boot (and on upgrade boots of pre-KPR-294 instances).
2. Verify the sentinel: immediately post-connect at boot, on driver reconnect/topology-change events, and on a periodic tick.
3. On mismatch: refuse writes through the shared client, log critical, emit telemetry — and auto-recover when verification later succeeds.
4. Publish a stable Sentinel Contract that KPR-296 (doctor) can read out-of-process.

## Non-Goals

- **Adversarial defense.** The sentinel defends against *accidental* wrong-DB (impostor process, wrong URI/port, restored-elsewhere data). An adversary who copies the sentinel doc into their mongod defeats it by construction. Honest threat model; in scope for a future ticket only if ever warranted.
- **Write fencing / transactional barriers.** Writes in flight between reconnect and verification completing may land on the impostor. Window is bounded by one `findOne` after the SDAM event fires (ms–seconds).
- **Gating out-of-process CLIs** (wizard, doctor, import-hubspot, standalone CodeIndexer) — operator-driven, short-lived, and doctor gets its own identity check in KPR-296.
- **Doctor-side rendering** — KPR-296's scope.
- **Pausing/quiescing agents on mismatch** — agents keep running; their writes fail loudly per-operation.
- **New log level.**

## Design

Two new files in a new `src/db/` directory (⚠ new dir; nothing suitable exists — `src/startup/` is boot-only, this is runtime-long-lived):

- `src/db/identity-sentinel.ts` — contract constants, `ensureIdentitySentinelAtBoot()`, `verifySentinel()`, `DbIdentityMonitor` class.
- `src/db/write-guard.ts` — `WriteGuard` state holder, `guardDb()` proxy factory, `DbIdentityMismatchError`.

### Boot flow (in `main()`, immediately after `mongoClient.connect()` / `mongoClient.db(...)`, **before** the `agent_definitions` `createIndex` calls and `runMigrations` — no write may precede identity verification)

```
const rawDb = mongoClient.db(config.mongo.dbName);
const bootResult = await ensureIdentitySentinelAtBoot(rawDb, {
  instanceId: config.instance.id,
  dbName: config.mongo.dbName,
  restamp: process.env.HIVE_DB_SENTINEL_RESTAMP === "1",
});
```

`ensureIdentitySentinelAtBoot` semantics:

| Sentinel state at boot | Action |
|---|---|
| Absent | Stamp it (`insertOne`), `log.info` "identity sentinel stamped (first boot)". Covers fresh installs AND first boot after upgrading a pre-KPR-294 instance. Duplicate-key (E11000) on the `insertOne` — two instances misconfigured onto one empty DB stamping concurrently — is caught: re-read the doc and fall through to the Present branches (the loser gets the explanatory mismatch fatal, not a raw driver error). |
| Present, `instanceId` + `dbName` both match config | Verified. `log.info`. |
| Present, mismatch | **Fatal**: `log.error` with `critical: true` + full expected/observed detail, `process.exit(1)`. ⚠ Boot mismatch = operator misconfiguration (two instances on one DB, renamed `instance.id`, adopted foreign backup) — the operator is present at boot; fail fast like the existing integrity checks, don't limp. The error message names the `HIVE_DB_SENTINEL_RESTAMP=1` override explicitly. |
| Present, mismatch, `restamp === true` | Overwrite sentinel with current identity (`replaceOne`, upsert), `log.warn` prominently with old + new identity. Proceed verified. |
| Read/write throws | Propagates — boot Mongo failures are already fatal (unguarded `connect()` at `src/index.ts:116`); same posture, no new handling. |

Then wrap: `const db = guardDb(rawDb, writeGuard);` — everything downstream of `src/index.ts:117` uses the guarded `db` exactly as today (one-line change at the assignment; no consumer signatures change).

### Runtime monitor — `DbIdentityMonitor`

Mirrors the `SpawnCoordinatorHeartbeat` pattern (class, `start()`/`stop()`, 30s unref'd interval, injected telemetry collection, `writeOnce`-style testability). Constructed with `(mongoClient, rawDb, writeGuard, rawTelemetryCollection, { instanceId, dbName, intervalMs? })`. Started immediately after the boot check + guard wrap (not deferred to the heartbeat block at :427 — a reconnect during the startup window must be caught). Stopped in `shutdown()` alongside the other heartbeats.

**Re-verification triggers** (all funnel into one `scheduleVerify(reason)` entry point):

1. `mongoClient.on("serverDescriptionChanged", e)` — trigger when `e.newDescription.type !== "Unknown"` and its `topologyVersion?.processId` (stringified, keyed by server address) differs from the last value seen for that address. `processId` is unique per mongod process lifetime — a changed value means a different (or restarted) mongod. First observation of an address seeds the map without triggering.
2. `mongoClient.on("topologyDescriptionChanged", e)` — trigger when any server transitions Unknown → known type (covers servers that report no `topologyVersion`).
3. `mongoClient.on("connectionPoolCleared", ...)` — belt-and-braces trigger (pool cleared ⇒ something reset underneath us).
4. Periodic: every tick of the 30s interval (backstop for missed events; one `findOne` per 30s is negligible; doubles as the telemetry heartbeat).

**Serialization / dedup / throw-safety:** single-flight — one in-flight verification promise; triggers arriving while a verification runs set a `dirty` flag causing exactly one re-run on completion. Every event callback body and the interval tick are wrapped so no exception can escape into the driver's emitter or the timer (catch → `log.warn`); `scheduleVerify` itself never throws.

**Verification read:** `rawDb.collection("instance_identity").findOne({ _id: "identity_sentinel" }, { maxTimeMS: 5000 })` — always via the **raw** (unguarded) db so the monitor can still verify while writes are refused.

**State machine** (monitor-owned; `WriteGuard.engaged` derived from it):

| State | Meaning | Writes |
|---|---|---|
| `verified` | Last read matched | allowed |
| `mismatch` | Doc read successfully, wrong identity **or absent-at-runtime** | **refused** |
| `cant_verify` | Reads failing past grace while server selectable | **refused** |

Transitions:
- Successful read + match → `verified` (from any state). If previously refusing, `log.error`→`log.info` recovery line ("identity re-verified — write refusal lifted"), guard disengaged, telemetry updated. Auto-recovery covers the real-mongod-comes-back case without a restart.
- Successful read + mismatch, or doc absent → `mismatch`: engage guard, `log.error("DB IDENTITY MISMATCH — refusing writes", { critical: true, expected…, observed…, reason })`, telemetry write.
- Read failure: retry up to 3 attempts, 5s apart (⚠ constants), within the single verification run. All fail → if the failure is a server-selection timeout (server unreachable; discriminator: `err instanceof MongoServerSelectionError` — any other error shape counts toward `cant_verify`), stay in current state (writes are failing at the driver anyway; nothing to protect) but record `lastVerifyError`; if the server **is** selectable yet the sentinel read keeps failing → `cant_verify`, engage guard. The periodic tick keeps retrying; any later success resolves to `verified` or `mismatch`.

**In-flight writes between reconnect and verification:** acknowledged as uncovered (Non-Goals). SDAM events fire at reconnect time; the verification is one indexed `findOne`; exposure is the event-to-verdict latency, typically < 1s.

### Write refusal — `guardDb()` proxy

`guardDb(rawDb, guard)` returns a `Proxy<Db>` whose `collection()` (and `collection<T>()`) returns a `Proxy<Collection>` gating this enumerated write-method list:

`insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany, bulkWrite, findOneAndUpdate, findOneAndReplace, findOneAndDelete, createIndex, createIndexes, dropIndex, dropIndexes, drop, rename`

Gate behavior: if `guard.engaged`, refuse the operation — **as a rejected promise, not a synchronous throw**: gated methods are all promise-returning driver APIs, so the gate returns `Promise.reject(new DbIdentityMismatchError(...))` (message names the expected/observed identity and points at `hive doctor`); also increment `guard.refusedWriteCount`. A sync throw would only become a rejection inside `async` callers — a non-async call site chaining `.catch()` or floating the promise would take an uncaught sync exception; the reject contract keeps refusal uniformly catchable. All other properties/methods (find, findOne, aggregate, watch, countDocuments, estimatedDocumentCount, …) forward with function properties **bound to the raw target** in the `get` trap (`value.bind(rawTarget)`) — returning them unbound would execute driver internals with `this` = Proxy, which breaks if the driver uses ES `#private` fields. `db.dropDatabase`, `db.createCollection`, `db.renameCollection` on the Db proxy are gated with the same check. Rejected errors flow into the codebase's existing catch+log convention (agents see a failed tool call; dispatcher and process survive).

Explicitly **not covered**, and why that's acceptable now:
- `src/setup/wizard.ts`, `src/contacts/import-hubspot.ts`, standalone `src/code-index/indexer.ts` (own clients): operator-invoked, short-lived, interactive contexts — the operator is looking at the terminal; the 25-hour-silent-corruption failure mode doesn't apply. The runtime prefetcher (`src/code-index/prefetcher.ts`) uses the shared `db` and **is** covered.
- `src/cli/doctor-checks.ts`: read-mostly, and KPR-296 gives doctor its own identity check.
- Aggregation `$out`/`$merge`: zero usages in `src/` (verified); listed here so a future usage knows it bypasses the guard.
- Raw commands via `db.command()`: zero runtime usages today (doctor's `ping` runs on its own client, `src/cli/doctor-checks.ts:111`); a future usage bypasses the guard.
- The `permits` datastore (`PERMITS_MONGO_URI`, `src/config.ts:242`): separate URI/DB, out of scope for the hive-identity sentinel.

## Sentinel Contract (stable interface — KPR-296 depends on this)

**Collection:** `instance_identity` (in the instance DB, i.e. `config.mongo.dbName`).
**Document:** exactly one, fixed `_id`.

| Field | Type | Frozen? | Semantics |
|---|---|---|---|
| `_id` | `string` = `"identity_sentinel"` | **frozen** | Singleton key. Read with `findOne({ _id: "identity_sentinel" })`. |
| `schemaVersion` | `number` = `1` | **frozen (field)** | Bumped only if the contract ever changes shape. Readers MUST tolerate values > known and still trust the frozen fields. |
| `instanceId` | `string` | **frozen** | `config.instance.id` at stamp time. **The** identity check: mismatch vs the reader's configured instance id ⇒ wrong DB/instance. |
| `dbName` | `string` | **frozen** | `config.mongo.dbName` at stamp time. Secondary check against dbName confusion. |
| `sentinelId` | `string` (UUID v4) | stable | Unique per stamp event; changes only on stamp/re-stamp. Correlate telemetry/logs to a stamp generation. Not part of the match predicate. |
| `stampedAt` | `Date` | stable | Diagnostic only. **Never compared to wall clock** — clock skew is irrelevant to this design. |
| `stampedBy` | `{ engineVersion: string, hostname: string, pid: number }` | advisory | Diagnostic only. Doctor may display, MUST NOT verify against. |

**Read semantics for consumers (doctor):**
- Doc present, `instanceId` === expected && `dbName` === expected → identity verified.
- Doc present, either differs → identity mismatch (report both expected and observed).
- Doc absent + DB has hive data (e.g. `agent_definitions` non-empty — doctor already has `hasAnyAgent`, `src/cli/doctor-checks.ts:120`) → suspect: either pre-KPR-294 engine hasn't booted since upgrade, or you are looking at an impostor.
- Doc absent + DB empty → pre-first-boot; not an error.
- Forward compat: `schemaVersion > 1` → warn "newer sentinel schema" but the frozen fields (`_id`, `schemaVersion`, `instanceId`, `dbName`) remain authoritative — future engine versions MUST keep them with identical semantics.
- Doctor MUST NOT write to this collection.

**Who writes:** only the engine (`ensureIdentitySentinelAtBoot`, and the restamp path). Engine-side match predicate is identical to the doctor's: `instanceId` + `dbName` equality.

## Telemetry

Kind: **`db_identity_stats`** — follows the family style (`prefix_cache_stats`, `spawn_coordinator_stats`, `memory_lifecycle_stats`): snake_case `*_stats`, `db.telemetry`, upsert keyed `{ kind }` (instance-scoped singleton like `prefix_cache_stats`, not per-agent), `$set: { ...stats, updatedAt: new Date() }`, 30s unref'd cadence, initial write at startup so doctor never sees "no telemetry yet".

```ts
{
  kind: "db_identity_stats",
  state: "verified" | "mismatch" | "cant_verify",
  expectedInstanceId: string,
  expectedDbName: string,
  sentinelPresent: boolean,
  observedInstanceId: string | null,
  observedDbName: string | null,
  observedSentinelId: string | null,
  writesRefused: boolean,
  refusedWriteCount: number,      // cumulative since boot
  verifyCount: number,             // cumulative since boot
  mismatchCount: number,
  lastVerifiedAt: Date | null,
  lastMismatchAt: Date | null,
  lastVerifyError: string | null,
  lastTriggerReason: string,       // "boot" | "periodic" | "serverDescriptionChanged" | ...
  updatedAt: Date,
}
```

Written via the **raw** telemetry collection (captured before `guardDb`), best-effort with catch+`log.warn` (same as existing heartbeats). Honest caveat: during a mismatch, this upsert lands on whatever server is connected — possibly the impostor. That is acceptable: telemetry is diagnostic breadcrumbs, the primary mismatch signals are the `critical: true` stderr log line and the sentinel read that KPR-296's doctor performs directly. (Exempting the monitor's own writes from the guard is deliberate — refusing them would silence the one subsystem reporting the problem.)

## Failure Modes & Edge Cases

| # | Scenario | Behavior |
|---|---|---|
| 1 | **The incident**: mongod dies, impostor appears on 27017, driver reconnects | `serverDescriptionChanged` (new `processId`) → verify → sentinel absent (or foreign) → `mismatch` → writes refused, critical log, telemetry. Damage window ≈ event-to-findOne latency. |
| 2 | Real mongod restarts (same data) | `processId` changes → verify → match → stays `verified`. One log line, no refusal. Restart-tolerance is why we verify content, not process identity. |
| 3 | Real mongod comes back after an impostor episode | Topology event → verify → match → refusal **auto-lifts**, recovery logged, telemetry flips. No operator restart required. |
| 4 | Sentinel read times out, server unreachable | Retries exhaust; state unchanged (driver writes are failing anyway); `lastVerifyError` recorded; periodic tick keeps trying. |
| 5 | Server selectable but sentinel read keeps failing (auth flip, hostile server) | `cant_verify` after grace → writes refused (fail-closed; reachable-but-unverifiable is the suspect state per the incident). |
| 6 | Sentinel exists but belongs to another instance (two instances aimed at one DB) | Boot: fatal exit 1 with explicit message. Runtime: `mismatch`, writes refused. This is a feature — it catches a real misconfig class. |
| 7 | Sentinel written by a newer engine (`schemaVersion` > 1) | Frozen fields still checked; match → verified + `log.warn` about version; mismatch → refuse. Never refuse *solely* because of a newer schemaVersion. |
| 8 | Impostor containing a copied sentinel | Not defended (see Non-Goals / threat model). Accidental-wrong-DB tool, not an adversary tool. |
| 9 | Clock skew | Irrelevant by design — `stampedAt` is never compared to anything. |
| 10 | Throw inside SDAM callback / interval tick | Impossible to escape: every entry point wrapped, single-flight promise has terminal `.catch`. Process never crashes from the monitor. |
| 11 | Verification racing engine shutdown | `stop()` clears the interval and removes listeners; an in-flight verify resolving after `close()` lands in its own catch → `log.warn`, no-op. |
| 12 | Writes in flight during reconnect-to-impostor, before verdict | Uncovered by design (Non-Goals); bounded to seconds. |

## Operator Override / Recovery

Walkthroughs (no false-positive may brick a legitimate operation):

- **Fresh instance:** empty DB, no sentinel → auto-stamp at first boot. No action.
- **Upgrade of an existing (pre-KPR-294) instance:** data present, no sentinel → auto-stamp at first post-upgrade boot. No action. (Absent-at-boot ⇒ stamp is precisely what makes the upgrade path safe.)
- **Restore from this instance's own backup:** sentinel restores with matching `instanceId`/`dbName` → verifies. No action. (`stampedAt`/`sentinelId` being old is irrelevant — not part of the predicate.)
- **`MONGODB_DB` / dbName change:** new DB has no sentinel → auto-stamp. No action. (Old DB keeps its sentinel harmlessly.)
- **Intentional move to a new mongod host:** dump/restore carries the sentinel → matches; or empty target → auto-stamp. No action either way. The engine only ever sees "sentinel matches" or "no sentinel at boot".
- **The one case needing the override — adopting a DB stamped by a different instance id** (cloning instance A's data into instance B, or renaming `instance.id` in `hive.yaml`): boot fails fatal with a message that names the fix. Operator sets `HIVE_DB_SENTINEL_RESTAMP=1` (in `.env` or the launchd environment) for **one boot**; engine re-stamps with the current identity, logs old→new prominently, operator removes the var. ⚠ The var is honored every boot it is set — the loud `log.warn` on each restamp is the guard against leaving it on permanently; a one-shot self-clearing mechanism is over-engineering for an operator-supervised escape hatch.
- **Manual alternative** (no restart cycle): documented one-liner in the fatal-error message, e.g. `mongosh <db> --eval 'db.instance_identity.replaceOne({_id:"identity_sentinel"}, {...}, {upsert:true})'` — but the env var is the paved path.

Runtime recovery: automatic on successful re-verification (edge #3); a restart with the real mongod back also recovers (boot verify passes).

## Integration Points (exact files/functions)

| File | Change |
|---|---|
| `src/db/identity-sentinel.ts` (new) | `SENTINEL_COLLECTION`, `SENTINEL_ID`, `SENTINEL_SCHEMA_VERSION` constants; `IdentitySentinelDoc` type; `ensureIdentitySentinelAtBoot(rawDb, opts)`; `verifySentinel(rawDb, expected)`; `DbIdentityMonitor` (start/stop/verifyOnce, SDAM listeners, state machine, telemetry writes). |
| `src/db/write-guard.ts` (new) | `WriteGuard` (engaged flag + refusedWriteCount + reason), `guardDb(rawDb, guard): Db`, `DbIdentityMismatchError`. |
| `src/index.ts` `main()` | After `:116-117` (`connect`/`db`): call `ensureIdentitySentinelAtBoot` (fatal on mismatch), create `WriteGuard`, replace `const db = mongoClient.db(...)` binding so downstream `db` is `guardDb(rawDb, guard)`; capture `rawDb.collection("telemetry")` for the monitor; construct + `start()` `DbIdentityMonitor` immediately (before the `createIndex` calls at `:120-122` run against the guarded db). In `shutdown()` (~`:752`): `monitor.stop()` before `mongoClient.close()`. |
| `src/config.ts` | No change (identity already exposed as `config.instance.id` / `config.mongo.dbName`). `HIVE_DB_SENTINEL_RESTAMP` read directly from `process.env` at the boot-check call site — it is a one-shot action flag, not instance config. ⚠ |
| `CLAUDE.md` | Add `instance_identity` to the MongoDB collections list; one gotcha line for the restamp var. |

No changes to consumers, adapters, MCP servers, doctor (KPR-296), or agent definitions.

## Testing outline

Conventions: `vi.mock` boundary mocks, no real mongod, tests beside source (`src/db/identity-sentinel.test.ts`, `src/db/write-guard.test.ts`).

**Unit — write-guard:**
- Guard disengaged: proxied collection forwards writes and reads verbatim (stub Collection records calls).
- Guard engaged: each enumerated write method rejects with `DbIdentityMismatchError` (assert rejection, not sync throw — a non-async caller chaining `.catch()` must catch it); `refusedWriteCount` increments; `find`/`findOne`/`aggregate`/`watch` still forward, bound to the raw target (assert `this` is not the Proxy).
- Db-level gated methods (`dropDatabase`, `createCollection`, `renameCollection`) reject when engaged.
- Collections obtained *before* engagement are still gated (proxy is per-collection-handle, state checked at call time).

**Unit — boot check** (`ensureIdentitySentinelAtBoot` with stubbed collection):
- Absent → `insertOne` called with full contract shape (assert every frozen field).
- Present + match → verified, no writes.
- Present + mismatch → returns mismatch result (fatal `process.exit` lives in `index.ts`, keep the function pure/testable).
- Present + mismatch + `restamp` → `replaceOne` upsert with new identity.
- First-boot stamp E11000 race: stub `insertOne` rejecting with duplicate-key → re-read path taken, Present-branch semantics applied.

**Unit — monitor state machine** (fake `MongoClient` = `EventEmitter`, stub raw collection, fake timers):
- `serverDescriptionChanged` with changed `processId` triggers verify; same `processId` does not; first-seen seeds silently.
- Unknown→known transition and `connectionPoolCleared` trigger verify.
- Single-flight: burst of 5 triggers while a verify is in flight → exactly one follow-up run (dirty flag).
- Runtime absent doc → `mismatch`, guard engaged, telemetry upsert has `state:"mismatch"`, `writesRefused:true`, log.error called with `critical: true`.
- Mismatch → later matching read → guard disengaged, recovery logged, telemetry `state:"verified"`.
- Read rejects 3× with server selectable → `cant_verify`, guard engaged; later success recovers.
- Read rejects with selection-timeout shape → state unchanged, `lastVerifyError` recorded.
- Throwing listener/tick never propagates (assert no unhandled rejection; wrap with `vi.fn` throwing).
- `schemaVersion: 2` doc with matching frozen fields → verified + warn.
- Telemetry doc shape/kind snapshot test (`kind: "db_identity_stats"`, keyed `{kind}` upsert — mirrors `spawn-coordinator-heartbeat` tests).

**Negative-verify (per operator convention):** for the incident-shaped test (runtime absent → refuse), confirm it fails against a stubbed pre-fix behavior (guard never engaged) before landing.

**Integration/e2e:** not feasible under vi.mock-only conventions (no mongodb-memory-server, no real mongod in CI). Real-world validation path: KPR-296 doctor check + a manual operator drill (stop mongod, start empty mongod on 27017, observe refusal within ~30s) — documented in the PR description, not automated. ⚠

## Delegated Assumptions (⚠)

1. ⚠ **No new log level** — "log critical" = `log.error(msg, { critical: true, ... })`. A fifth level touches every logger consumer for one call site; the marker field is greppable and doctor/telemetry carry the state anyway.
2. ⚠ **Boot-time mismatch is fatal (exit 1)**; runtime mismatch degrades (refuse writes, keep serving). Boot has an operator present; runtime does not.
3. ⚠ **Reads continue during mismatch** — refusal protects against corrupting/forking state, not against reading garbage; blocking reads would crash-loop half the engine for no data-integrity gain.
4. ⚠ **Agents are not paused on mismatch** — their writes fail per-operation with a descriptive error via existing catch+log paths. Simplest honest degraded mode; no new pause plumbing.
5. ⚠ **Enforcement point = Proxy over shared `Db`/`Collection`** rather than per-subsystem checks or a driver fork — the only point that covers all runtime consumers without touching them.
6. ⚠ **Override = `HIVE_DB_SENTINEL_RESTAMP=1` env var**, honored every boot it's set (loud warn each time), no self-clearing.
7. ⚠ **Auto-recovery on successful re-verification** (no operator ack required) — symmetric with auto-refusal; the state that engaged the guard has verifiably ended.
8. ⚠ **Timing constants**: 30s periodic tick (family cadence), 5s `maxTimeMS` on the sentinel read, 3 retries × 5s grace before `cant_verify`.
9. ⚠ **New `src/db/` directory** for the two modules.
10. ⚠ **Telemetry kind `db_identity_stats`**, `{kind}`-keyed singleton (instance-scoped like `prefix_cache_stats`, not per-agent).
11. ⚠ **Monitor's own telemetry writes bypass the guard** (raw collection) — best-effort breadcrumbs must not be silenced by the very condition they report.

## Decision Register note

KPR-293 is a **pre-register epic — no Decision Register canon exists**. Noted explicitly per process; not a blocker. The Sentinel Contract section above serves as the binding interface decision for the KPR-296 dependency until/unless a register entry supersedes it.
