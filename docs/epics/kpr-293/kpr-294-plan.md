# KPR-294 — DB identity sentinel — Implementation Plan

**Spec:** `docs/epics/kpr-293/kpr-294-spec.md` (approved; ⚠-flagged assumptions are settled — do not re-litigate).
**Epic branch:** KPR-293 W1A. One commit per task (dodi-dev:implement convention). Every task leaves the tree green: `npm run typecheck` + scoped tests pass after each task.

**Verified anchors in current source** (line numbers as of this worktree):
- `src/index.ts:108-117` — shared `MongoClient` + `const db = mongoClient.db(config.mongo.dbName)`.
- `src/index.ts:120-125` — `agent_definitions` `createIndex` ×2 then `runMigrations(db)` (first writes after connect — the boot check must precede these).
- `src/index.ts:426` — `const telemetryCollection = db.collection("telemetry")` (existing heartbeat block at :422-458).
- `src/index.ts:723-755` — `shutdown()`; heartbeat `.stop()` calls at :744-745, `mongoClient.close()` at :752.
- `src/config.ts:86` — `instanceId` (default `"hive"`); `src/config.ts:135` — `config.instance.id`; `src/config.ts:185` — `config.mongo.dbName` (default `hive_${instanceId}`).
- Pattern to mirror: `src/agents/spawn-coordinator-heartbeat.ts` (+ its test) — class, `INTERVAL_MS = 30_000` static, injected telemetry `Collection`, `writeOnce()` for tests/initial write, `start()/stop()` with `unref()`'d interval, best-effort `catch → log.warn`.
- Logger: `createLogger(component)` from `src/logging/logger.ts` — levels `debug|info|warn|error`; "critical" = `log.error(msg, { critical: true, ... })`.
- mongodb driver `^7.1.0` (package.json:85).

**Out of scope (do not touch):** `hive doctor` / `src/cli/doctor-checks.ts` (KPR-296), CLI/wizard gating, any new log level, `src/config.ts` (no change — `HIVE_DB_SENTINEL_RESTAMP` is read from `process.env` at the call site in `index.ts`).

---

## Task 1 — Write guard module

**Goal:** `WriteGuard` state holder + `guardDb()` proxy factory + `DbIdentityMismatchError`, fully unit-tested. Standalone module; nothing imports it yet, tree stays green.

**Files:**
- `src/db/write-guard.ts` (new — creates the new `src/db/` directory, per spec ⚠9)
- `src/db/write-guard.test.ts` (new)

**Key symbols:**

```ts
export class DbIdentityMismatchError extends Error {
  readonly code = "DB_IDENTITY_MISMATCH";
  // message names expected/observed identity + points at `hive doctor`
}

export class WriteGuard {
  engaged: boolean;               // starts false
  reason: string | null;          // human-readable, set on engage
  refusedWriteCount: number;      // cumulative since boot
  expected: { instanceId: string; dbName: string };   // for error messages
  observed: { instanceId: string | null; dbName: string | null } | null;
  engage(reason: string, observed?: ...): void;
  disengage(): void;
}

export const GATED_COLLECTION_METHODS: ReadonlySet<string>; // exact spec list, see below
export const GATED_DB_METHODS: ReadonlySet<string>;         // dropDatabase, createCollection, renameCollection

export function guardDb(rawDb: Db, guard: WriteGuard): Db;
```

**Gated collection methods (exact list from spec — no additions, no omissions):**
`insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany, bulkWrite, findOneAndUpdate, findOneAndReplace, findOneAndDelete, createIndex, createIndexes, dropIndex, dropIndexes, drop, rename`

**Behavior contract (from spec §Write refusal):**
- `guardDb` returns `new Proxy(rawDb, dbHandler)` — a `Proxy<Db>` *is* typed `Db`; no cast needed at the return.
- Db `get` trap: `collection` returns a wrapper function that calls `rawDb.collection(...)` and wraps the result in a collection proxy. `dropDatabase` / `createCollection` / `renameCollection` return gate-checking wrappers. Everything else forwards, function values **bound to `rawDb`**.
- Collection `get` trap: if the property is in `GATED_COLLECTION_METHODS`, return a wrapper that checks `guard.engaged` **at call time** — if engaged: `guard.refusedWriteCount++` and `return Promise.reject(new DbIdentityMismatchError(...))` (**rejected promise, never a sync throw** — spec is explicit); if not engaged: invoke the method bound to the raw collection. Non-gated function properties (`find`, `findOne`, `aggregate`, `watch`, `countDocuments`, …) forward **bound to the raw target** (`value.bind(rawTarget)`) — unbound would run driver internals with `this` = Proxy, which breaks ES `#private` fields in the driver. Non-function properties forward via `Reflect.get`.
- Cache bound/wrapper functions per proxy in a `Map<string | symbol, unknown>` inside the handler closure so `col.insertOne === col.insertOne` holds across accesses (stable property identity; also keeps test spies sane). The gate check stays inside the wrapper body, so caching does not freeze guard state.
- Do NOT snapshot `guard.engaged` at proxy-creation or collection-acquisition time — collections obtained before engagement must still be gated (spec test requirement).

**Typing approach (no `any`):** inside the `get` traps use `Reflect.get(target, prop, target)` typed as `unknown`, narrow with `typeof value === "function"`, and use one localized cast `value as (...args: unknown[]) => unknown` for `.bind`/invocation. If a single `as unknown as` is needed to place a wrapper back into the driver's method slot, keep it inside the handler with a one-line justification comment (this satisfies "no `any` without justification" — the external surface stays fully `Db`/`Collection` typed).

**Tests (`src/db/write-guard.test.ts`)** — stub `Db`/`Collection` as plain objects with `vi.fn()` methods, cast `as unknown as Db` (same style as `spawn-coordinator-heartbeat.test.ts`; no `vi.mock("mongodb")` needed since the module only imports types from mongodb):
1. Disengaged: every gated method + `find`/`findOne` forwards verbatim to the stub (args + return value pass through).
2. Engaged: **each** of the 17 gated collection methods rejects with `DbIdentityMismatchError` — assert via `await expect(p).rejects.toBeInstanceOf(DbIdentityMismatchError)` AND assert no sync throw (call inside a plain non-async function, capture the promise, `.catch()` it — the call itself must not throw).
3. Engaged: `refusedWriteCount` increments once per refused call.
4. Engaged: `find`/`findOne`/`aggregate`/`watch`/`countDocuments` still forward; assert `this` inside the stub method is the raw stub, not the proxy (stub records `this` and compares identity).
5. Db-level: `dropDatabase`/`createCollection`/`renameCollection` reject when engaged, forward when not.
6. Collection handle obtained **before** `engage()` is gated after `engage()`; disengage → same handle writes again (call-time check).
7. Property identity: `proxiedCol.insertOne === proxiedCol.insertOne`.
8. Error message contains expected instanceId/dbName and the string `hive doctor`.

**Acceptance:** all above pass; module has no runtime imports from `index.ts`/config (pure).

**Verify:**
```
npm run typecheck
npx vitest run src/db/write-guard.test.ts
```
Commit: `feat(db): write-guard proxy + DbIdentityMismatchError (KPR-294)`

---

## Task 2 — Sentinel contract + boot check + verify read

**Goal:** contract constants, doc type, `ensureIdentitySentinelAtBoot()`, `verifySentinel()` — pure/testable (no `process.exit` here; that lives in `index.ts`).

**Files:**
- `src/db/identity-sentinel.ts` (new)
- `src/db/identity-sentinel.test.ts` (new — boot-check + verify tests in this task; monitor tests added in Task 3)

**Key symbols:**

```ts
export const SENTINEL_COLLECTION = "instance_identity";
export const SENTINEL_ID = "identity_sentinel";
export const SENTINEL_SCHEMA_VERSION = 1;

export interface IdentitySentinelDoc {
  _id: string;                // "identity_sentinel"
  schemaVersion: number;      // 1
  instanceId: string;
  dbName: string;
  sentinelId: string;         // UUID v4 per stamp (crypto.randomUUID())
  stampedAt: Date;
  stampedBy: { engineVersion: string; hostname: string; pid: number };
}

export interface SentinelIdentity { instanceId: string; dbName: string; }

export type BootCheckResult =
  | { outcome: "stamped" }                                        // absent → insertOne
  | { outcome: "verified"; schemaVersionNewer: boolean }
  | { outcome: "mismatch"; observed: { instanceId: string; dbName: string; sentinelId: string | null } }
  | { outcome: "restamped"; previous: { instanceId: string; dbName: string } };

export async function ensureIdentitySentinelAtBoot(
  rawDb: Db,
  opts: SentinelIdentity & { restamp: boolean },
): Promise<BootCheckResult>;

export type SentinelVerifyResult =
  | { state: "verified"; sentinelPresent: true; schemaVersionNewer: boolean; observed: {...} }
  | { state: "mismatch"; sentinelPresent: boolean; observed: {...} | null };

export async function verifySentinel(rawDb: Db, expected: SentinelIdentity): Promise<SentinelVerifyResult>;
// findOne({ _id: SENTINEL_ID }, { maxTimeMS: 5000 }). Read errors PROPAGATE (caller decides).
// Absent doc → state: "mismatch", sentinelPresent: false (runtime semantics; boot path handles absent separately).
```

**Boot-check semantics (spec table, exactly):**
- Absent → `insertOne` full `IdentitySentinelDoc` (every frozen field), return `stamped`. `stampedBy.engineVersion`: `process.env.npm_package_version ?? "unknown"` — advisory-only field per contract; do NOT read package.json via `import.meta`-relative paths (esbuild bundle breaks them; see Risks).
- `insertOne` rejects with duplicate-key (E11000 — detect via `err.code === 11000` on a narrowed error shape, not `instanceof MongoServerError`, so stubs work) → re-read the doc and fall through to the Present branches.
- Present + both `instanceId` and `dbName` match → `verified`. `schemaVersionNewer = doc.schemaVersion > SENTINEL_SCHEMA_VERSION` (frozen fields still authoritative — never fail solely on newer version).
- Present + mismatch + `restamp: false` → return `mismatch` (caller logs critical + exits).
- Present + mismatch + `restamp: true` → `replaceOne({ _id: SENTINEL_ID }, fullNewDoc, { upsert: true })`, return `restamped` with old identity (caller emits the loud `log.warn`).
- Match predicate is `instanceId` equality AND `dbName` equality — identical to the doctor-side predicate in the spec's Sentinel Contract. Nothing else (not `sentinelId`, not `stampedAt`) participates.
- Read/write errors propagate (boot Mongo failures are already fatal).

**Tests (boot-check portion of `src/db/identity-sentinel.test.ts`)** — stubbed collection object (`findOne`/`insertOne`/`replaceOne` as `vi.fn()`), stub `Db` = `{ collection: vi.fn(() => stubCollection) }` cast `as unknown as Db`:
1. Absent → `insertOne` called; assert **every** frozen + stable field on the inserted doc: `_id === "identity_sentinel"`, `schemaVersion === 1`, `instanceId`, `dbName`, `sentinelId` matches UUID-v4 regex, `stampedAt instanceof Date`, `stampedBy` has `engineVersion`/`hostname`/`pid`.
2. Present + match → returns `verified`, `insertOne`/`replaceOne` never called.
3. Present + mismatch → returns `mismatch` with observed identity; no writes; **no `process.exit` anywhere in this module** (grep-level assertion in review, not a test).
4. Present + mismatch + restamp → `replaceOne` upsert with the new identity; returns `restamped` carrying the old identity.
5. E11000 race: `insertOne` rejects with `{ code: 11000 }` → `findOne` re-read happens → Present-branch result returned (test both re-read-match → `verified` and re-read-foreign → `mismatch`).
6. `schemaVersion: 2` + matching frozen fields → `verified` with `schemaVersionNewer: true`.
7. `verifySentinel`: match → `verified`; foreign doc → `mismatch` + observed; `null` doc → `mismatch` + `sentinelPresent: false`; `findOne` passes `maxTimeMS: 5000`; read rejection propagates (`await expect(...).rejects.toThrow()`).

**Acceptance:** contract constants/type exported exactly as the spec's Sentinel Contract (KPR-296 imports nothing — it re-reads the doc out-of-process — but the constants are the in-repo source of truth).

**Verify:**
```
npm run typecheck
npx vitest run src/db/identity-sentinel.test.ts
```
Commit: `feat(db): identity sentinel contract + boot check (KPR-294)`

---

## Task 3 — `DbIdentityMonitor`

**Goal:** runtime re-verification state machine + SDAM listeners + telemetry heartbeat, in the same file as Task 2 per spec Integration Points.

**Files:**
- `src/db/identity-sentinel.ts` (extend)
- `src/db/identity-sentinel.test.ts` (extend)

**Key symbols:**

```ts
export type IdentityState = "verified" | "mismatch" | "cant_verify";

export class DbIdentityMonitor {
  static readonly INTERVAL_MS = 30_000;
  static readonly READ_MAX_TIME_MS = 5_000;
  static readonly RETRY_ATTEMPTS = 3;
  static readonly RETRY_DELAY_MS = 5_000;
  static readonly TELEMETRY_KIND = "db_identity_stats";

  constructor(
    mongoClient: MongoClient,          // needs .on/.removeListener — type as the event surface, accept a narrowed interface for testability
    rawDb: Db,                         // UNGUARDED — verification must work while writes are refused
    writeGuard: WriteGuard,
    rawTelemetryCollection: Collection, // captured from rawDb BEFORE guardDb — spec ⚠11
    opts: { instanceId: string; dbName: string; intervalMs?: number; retryDelayMs?: number },
  );
  start(): void;      // attach SDAM listeners + start unref'd interval; does NOT verify (boot check already did)
  stop(): void;       // clear interval, remove listeners
  async writeOnce(): Promise<void>;                 // telemetry upsert — exposed for tests + initial write (family pattern)
  async verifyOnce(reason: string): Promise<void>;  // exposed for tests; single verification run incl. retry grace
  // internal: scheduleVerify(reason), state, counters, processId map
}
```

Constructor seeds state `verified` / `lastVerifiedAt = new Date()` / `lastTriggerReason = "boot"` / `verifyCount = 1` — the boot check in `main()` has already verified before the monitor is constructed.

**Triggers (all funnel into `scheduleVerify(reason)`):**
1. `serverDescriptionChanged`: skip if `e.newDescription.type === "Unknown"`. Key = server address (`e.address`); value = `String(e.newDescription.topologyVersion?.processId)` (or a sentinel string when undefined). First observation of an address seeds the map **without** triggering; a changed value triggers.
2. `topologyDescriptionChanged`: trigger when any server transitions Unknown → known type (compare `e.previousDescription` vs `e.newDescription` server maps).
3. `connectionPoolCleared`: always trigger (belt-and-braces).
4. Interval tick (default 30s, `unref()`'d): `scheduleVerify("periodic")`; the same tick calls `writeOnce()` — the periodic verify doubles as the telemetry heartbeat.

**Single-flight + throw-safety (spec §Serialization):** one in-flight verification promise; triggers during flight set a `dirty` flag → exactly one follow-up run on settle. Every listener body and the tick body are wrapped in try/catch → `log.warn`; the in-flight promise carries a terminal `.catch`. `scheduleVerify` never throws. Nothing can escape into the driver's emitter or the timer (spec edge #10).

**Verification run (`verifyOnce`):**
- Read via `verifySentinel(rawDb, expected)` (raw db — guard-immune).
- Success + match → state `verified`; if previously refusing: `writeGuard.disengage()`, `log.info("identity re-verified — write refusal lifted", ...)`, immediate `writeOnce()` (symmetric with the mismatch transition — spec transition list says "telemetry updated" on recovery). If `schemaVersionNewer` → `log.warn` once per observation.
- Success + mismatch or absent → state `mismatch`; `writeGuard.engage(reason, observed)`; `log.error("DB IDENTITY MISMATCH — refusing writes", { critical: true, expected, observed, reason })`; immediate `writeOnce()`.
- Read rejection → retry up to 3 attempts total, `RETRY_DELAY_MS` apart (plain `setTimeout` sleep — `unref()` the sleep timer so shutdown isn't held). All fail:
  - `err instanceof MongoServerSelectionError` (import from `mongodb`) → server unreachable → **state unchanged**, record `lastVerifyError` (driver writes are failing anyway; nothing to protect).
  - Any other error shape → server selectable but sentinel unreadable → state `cant_verify`, `writeGuard.engage(...)`, `log.error(..., { critical: true })` (fail-closed — reachable-but-unverifiable is the suspect state).
  - Periodic tick keeps retrying; any later success resolves to `verified` or `mismatch`.
- Log transitions once per state change, not per tick (don't spam `log.error` every 30s while in `mismatch`; re-log only on state change or changed observed identity).

**Telemetry (`writeOnce`):** upsert on `rawTelemetryCollection` keyed `{ kind: "db_identity_stats" }` (instance-scoped singleton like `prefix_cache_stats`), `$set: { ...stats, updatedAt: new Date() }`, best-effort `catch → log.warn`. Doc fields exactly per spec §Telemetry: `kind, state, expectedInstanceId, expectedDbName, sentinelPresent, observedInstanceId, observedDbName, observedSentinelId, writesRefused, refusedWriteCount (from writeGuard), verifyCount, mismatchCount, lastVerifiedAt, lastMismatchAt, lastVerifyError, lastTriggerReason, updatedAt`.

**Tests (monitor portion of `src/db/identity-sentinel.test.ts`)** — fake client = `new EventEmitter()` cast to the narrowed client type; stub sentinel collection with switchable `findOne`; real `WriteGuard` instance (from Task 1 — cheap and honest); stub telemetry collection; `vi.useFakeTimers()`:
1. `serverDescriptionChanged` with changed `processId` → verify runs; same `processId` → no verify; first-seen address seeds silently (no verify).
2. Unknown→known `topologyDescriptionChanged` triggers; `connectionPoolCleared` triggers.
3. Single-flight: gate the stubbed `findOne` on a manually-resolved promise, emit 5 triggers while in flight → exactly **one** follow-up verification after release (assert `findOne` call count = 2).
4. Runtime absent doc (`findOne → null`) → state `mismatch`, `guard.engaged === true`, telemetry upsert `$set` has `state: "mismatch"`, `writesRefused: true`, `log.error` called with object containing `critical: true`. **(← the incident-shaped regression test — see negative-verify below.)**
5. Mismatch → flip stub to matching doc → advance timers 30s → guard disengaged, recovery `log.info`, telemetry `state: "verified"`.
6. `findOne` rejects 3× with a generic `Error` → `cant_verify`, guard engaged (use `vi.advanceTimersByTimeAsync` to walk through the 2 retry delays); later success → recovered.
7. `findOne` rejects 3× with `MongoServerSelectionError` (construct via `Object.create(MongoServerSelectionError.prototype)` + assign `message` if the real constructor demands a TopologyDescription — see Risks) → state unchanged from `verified`, guard NOT engaged, `lastVerifyError` recorded in next telemetry write.
8. Throwing listener/tick: make `findOne` throw synchronously → no unhandled rejection (attach `process.on("unhandledRejection")` spy or rely on vitest's default failure on unhandled rejections), monitor still responsive.
9. Engaged-to-engaged cross-transitions (guard stays engaged throughout; telemetry `state` must track): `mismatch` → reads start failing 3× generic → `cant_verify`; `cant_verify` → read succeeds with foreign doc → `mismatch`; `mismatch` → 3× `MongoServerSelectionError` → stays `mismatch` (state unchanged, `lastVerifyError` recorded).
9. `schemaVersion: 2` matching doc → stays `verified`, `log.warn` called.
10. Telemetry doc shape snapshot: assert the full key set and `kind`/filter of the upsert (mirrors `spawn-coordinator-heartbeat.test.ts` style).
11. `stop()` clears the interval and removes listeners (emit after `stop()` → no verify).

**Verify:**
```
npm run typecheck
npx vitest run src/db/identity-sentinel.test.ts src/db/write-guard.test.ts
```
Commit: `feat(db): DbIdentityMonitor — SDAM-triggered re-verification + telemetry (KPR-294)`

---

## Task 4 — Integration test (in-process assembly, fake driver)

**Goal:** wire the real pieces together — `DbIdentityMonitor` + `WriteGuard` + `guardDb` — end-to-end with a fake client/db, proving the incident scenario and recovery through the actual write path.

**Files:**
- `src/db/db-identity.integration.test.ts` (new)

**Setup:** fake `MongoClient` = `EventEmitter`; fake raw `Db` = object whose `collection(name)` returns the sentinel stub for `"instance_identity"`, a telemetry stub for `"telemetry"`, and a generic data-collection stub (recording `insertOne` etc.) otherwise; `const guard = new WriteGuard(...)`; `const db = guardDb(fakeRawDb, guard)`; monitor constructed on the fake client + fake raw db + guard + telemetry stub; `vi.useFakeTimers()`.

**Scenarios:**
1. **The incident, end-to-end:** boot state verified → fake client emits `serverDescriptionChanged` with a new `processId` → sentinel stub returns `null` (impostor: empty DB) → flush microtasks → a write through the guarded db (`db.collection("agent_definitions").insertOne({...})`) rejects with `DbIdentityMismatchError`; telemetry stub recorded an upsert with `state: "mismatch"`, `writesRefused: true`; `refusedWriteCount` reflected in the next telemetry write.
2. **Auto-recovery:** continue from (1) — flip sentinel stub to the matching doc → advance 30s (periodic tick) → the same write now forwards to the raw stub; telemetry `state: "verified"`, recovery log emitted.
3. **Foreign sentinel variant:** stub returns a doc with a different `instanceId` → same refusal path, telemetry carries `observedInstanceId`.
4. **cant_verify end-to-end:** sentinel `findOne` rejects with generic errors through the retry grace → guarded write rejects; then reads succeed again → writes flow.
5. **Reads flow during mismatch:** while in state `mismatch`, `db.collection(...).findOne(...)` forwards to the raw stub (spec ⚠3).

**Verify:**
```
npm run typecheck
npx vitest run src/db/
```
Commit: `test(db): identity sentinel integration assembly tests (KPR-294)`

---

## Task 5 — `index.ts` wiring

**Goal:** boot check + guard wrap + monitor lifecycle in `main()`/`shutdown()`.

**Files:**
- `src/index.ts`

**Changes (exact placement):**

1. Imports: `ensureIdentitySentinelAtBoot`, `DbIdentityMonitor` from `./db/identity-sentinel.js`; `WriteGuard`, `guardDb` from `./db/write-guard.js`.
2. At :117, replace the single binding:
   ```ts
   const rawDb = mongoClient.db(config.mongo.dbName);

   // KPR-294: verify DB identity BEFORE any write (createIndex/migrations below).
   const bootResult = await ensureIdentitySentinelAtBoot(rawDb, {
     instanceId: config.instance.id,
     dbName: config.mongo.dbName,
     restamp: process.env.HIVE_DB_SENTINEL_RESTAMP === "1",
   });
   if (bootResult.outcome === "mismatch") {
     log.error("DB IDENTITY MISMATCH at boot — refusing to start", {
       critical: true,
       expected: { instanceId: config.instance.id, dbName: config.mongo.dbName },
       observed: bootResult.observed,
       hint: "If adopting this DB intentionally, set HIVE_DB_SENTINEL_RESTAMP=1 for one boot. Manual alternative: mongosh <db> --eval 'db.instance_identity.replaceOne({_id:\"identity_sentinel\"}, {...}, {upsert:true})'",
     });
     process.exit(1);
   }
   if (bootResult.outcome === "restamped") {
     log.warn("identity sentinel RE-STAMPED via HIVE_DB_SENTINEL_RESTAMP", {
       previous: bootResult.previous,
       current: { instanceId: config.instance.id, dbName: config.mongo.dbName },
       action: "remove HIVE_DB_SENTINEL_RESTAMP from the environment now",
     });
   }
   if (bootResult.outcome === "stamped") {
     log.info("identity sentinel stamped (first boot)");
   }

   const writeGuard = new WriteGuard({ instanceId: config.instance.id, dbName: config.mongo.dbName });
   const db = guardDb(rawDb, writeGuard);   // downstream `db` consumers unchanged

   const rawTelemetryCollection = rawDb.collection("telemetry"); // guard-immune (spec ⚠11)
   const dbIdentityMonitor = new DbIdentityMonitor(mongoClient, rawDb, writeGuard, rawTelemetryCollection, {
     instanceId: config.instance.id,
     dbName: config.mongo.dbName,
   });
   await dbIdentityMonitor.writeOnce();  // initial telemetry so doctor never sees "no telemetry yet"
   dbIdentityMonitor.start();            // started NOW, not in the heartbeat block — reconnects during startup must be caught
   ```
   The `createIndex` calls (:120-122) and `runMigrations(db)` (:125) now run against the **guarded** db, strictly after verification — order requirement satisfied; guard is disengaged so they forward normally.
3. Leave :426 `const telemetryCollection = db.collection("telemetry")` untouched — other heartbeats intentionally go through the guarded db (only the monitor's own writes bypass, spec ⚠11; refused heartbeat writes land in their existing `catch → log.warn`).
4. `shutdown()`: add `dbIdentityMonitor.stop();` next to the other heartbeat stops (after :745 `memoryLifecycleHeartbeat.stop()`), i.e. **before** `await mongoClient.close()` at :752 — an in-flight verify resolving after close lands in its own catch → `log.warn` (spec edge #11).

**Acceptance:** no consumer signature changes; grep confirms no other reference to `mongoClient.db(` was introduced/left unguarded in runtime paths; boot order is verify → guard → monitor → createIndex → migrations.

**Verify:**
```
npm run typecheck
npm run lint
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run test
```
(Full test run here — index.ts wiring can break unrelated suites; env stubs per repo convention.)
Commit: `feat(db): wire identity sentinel boot check + monitor into main() (KPR-294)`

---

## Task 6 — Docs, negative-verify, final gate

**Goal:** CLAUDE.md updates, negative-verify evidence for the incident regression test, full check, bundle sanity.

**Files:**
- `CLAUDE.md`

**Changes:**
1. CLAUDE.md MongoDB collections list (Common Gotchas section): add `instance_identity` (identity sentinel, KPR-294) and note `db_identity_stats` alongside the existing telemetry-kind parentheticals.
2. CLAUDE.md gotcha line: `HIVE_DB_SENTINEL_RESTAMP=1` re-stamps the DB identity sentinel for one boot (adopting another instance's DB); remove after use — it is honored every boot it is set.

**Negative-verify (repo convention — do this, record output for the PR):**
- Target: the incident-shaped test (Task 3 test #4 / Task 4 scenario #1: runtime absent doc → guard engages, write refused).
- Procedure: temporarily neuter the fix — comment out the `writeGuard.engage(...)` call in the monitor's mismatch branch — run `npx vitest run src/db/` → confirm those tests **fail**; restore the line → confirm they pass. Capture both outputs as evidence in the PR description. This proves the tests detect the pre-fix behavior (guard never engaged), not just their own plumbing.

**Final gate:**
```
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
npm run bundle   # esbuild sanity — new modules must not break the pkg/ artifact
```
Commit: `docs: instance_identity collection + restamp gotcha (KPR-294)`

---

## Testing Contract (MANDATORY)

### Unit
| File | Coverage |
|---|---|
| `src/db/write-guard.test.ts` | Reject/bind semantics: all 17 gated collection methods reject-with-`DbIdentityMismatchError` when engaged (as rejection, not sync throw); reads/aggregate/watch forward bound to raw target (`this` ≠ proxy); Db-level gates (`dropDatabase`/`createCollection`/`renameCollection`); pre-engagement handles gated at call time; `refusedWriteCount`; stable property identity; error message names identity + `hive doctor`. |
| `src/db/identity-sentinel.test.ts` (boot) | All 5 boot-table branches incl. **E11000 race** (insertOne dup-key → re-read → Present-branch semantics); full frozen-field shape of the stamped doc; restamp `replaceOne` upsert; `schemaVersion > 1` tolerance; `verifySentinel` match/mismatch/absent/propagating-error/`maxTimeMS`. |
| `src/db/identity-sentinel.test.ts` (monitor) | State machine with fake `EventEmitter` client + `vi.useFakeTimers()`: processId-change trigger / same-processId no-trigger / first-seen seeds; Unknown→known + poolCleared triggers; single-flight dirty-flag (burst of 5 → exactly one follow-up); runtime-absent → `mismatch` + guard engaged + `critical: true` log; auto-recovery disengage; 3×-retry → `cant_verify` (generic error) vs state-unchanged (`MongoServerSelectionError`); engaged-to-engaged cross-transitions (`mismatch`↔`cant_verify`, `mismatch` + selection error stays `mismatch`); throw-safety (no escape from listeners/tick); telemetry doc shape/kind (`db_identity_stats`, `{kind}`-keyed upsert). |

All boundary-mocked (stub objects / `vi.fn()`), no real mongod, tests beside source per repo convention.

### Integration
`src/db/db-identity.integration.test.ts` — in-process assembly, still fake-driver (no mongod): real `DbIdentityMonitor` + real `WriteGuard` + real `guardDb` wired over a fake `EventEmitter` client and stub raw `Db`. Scenarios: (1) incident end-to-end — `serverDescriptionChanged` with new processId → stubbed sentinel read returns null/foreign → write through guarded db rejects with `DbIdentityMismatchError` + telemetry upsert recorded; (2) recovery — matching read → writes flow again + telemetry `verified`; (3) foreign-sentinel variant; (4) `cant_verify` end-to-end + recovery; (5) reads forward during mismatch.

### E2E — manual operator drill (documented substitute for automated e2e)
**Automated e2e is not possible in CI**: the repo has no `mongodb-memory-server` dependency and test conventions (CLAUDE.md + spec ⚠) forbid a real mongod in CI. The following manual drill **substitutes for automated e2e** and MUST be included verbatim in the PR description, with the implementer's observed results if run pre-merge (recommended on a dev instance):

1. On a dev/non-production instance, confirm baseline: engine running; `mongosh <db> --eval 'db.telemetry.findOne({kind:"db_identity_stats"})'` shows `state: "verified"`.
2. Stop the real mongod (it runs as a LaunchAgent: `launchctl stop <mongod-label>` or `brew services stop mongodb-community`).
3. Start an empty impostor on the same port: `mongod --dbpath "$(mktemp -d)" --port 27017`.
4. **Expected within ~30s** (typically seconds — SDAM event): engine log shows `DB IDENTITY MISMATCH — refusing writes` with `critical: true`; engine process stays alive.
5. Trigger an agent action that writes (e.g. a memory write via Slack) → **expected**: the operation fails with `DbIdentityMismatchError` in logs; response/read paths still function; no crash.
6. On the impostor: `db.telemetry.findOne({kind:"db_identity_stats"})` shows `state: "mismatch"`, `writesRefused: true` (telemetry deliberately lands on the connected server — diagnostic breadcrumbs).
7. Kill the impostor; restart the real mongod.
8. **Expected within ~30s**: log line `identity re-verified — write refusal lifted`; writes succeed; telemetry back to `verified`. **No engine restart at any point.**

### Negative-verify
For the incident-shaped regression tests (unit test "runtime absent → mismatch + guard engaged" and integration scenario 1): neuter the fix (comment out the monitor's `writeGuard.engage(...)` call — the "guard never engaged" pre-fix stub), run `npx vitest run src/db/`, confirm the tests **fail**, restore, confirm they pass. Include both run outputs in the PR description as evidence.

---

## Risks / Gotchas for the implementer

1. **Proxy typing vs mongodb ^7 generics.** `new Proxy(target, handler)` is typed as the target's type, so `guardDb` returns `Db` and `db.collection<T>()` keeps its generic signature *externally* for free. The messiness is internal to the traps: `Reflect.get` yields `unknown`; narrow with `typeof === "function"` and use one localized `as (...args: unknown[]) => unknown` cast with a justification comment. Never widen the public surface; never `any`.
2. **Bind, don't arrow-wrap blindly, and cache.** Forwarded function properties must be `value.bind(rawTarget)` — the driver uses ES `#private` fields internally; calling with `this` = Proxy throws `TypeError: Cannot read private member`. Cache bound/wrapper functions in a per-proxy `Map` so repeated property access returns the identical function (stable identity for spies and for any driver-internal comparisons). Keep the `guard.engaged` check *inside* the wrapper body — caching the wrapper must not cache the verdict.
3. **Monitor uses raw, consumers get guarded.** Easy to slip: the monitor's sentinel read AND its telemetry writes go through `rawDb`/`rawTelemetryCollection` captured **before** `guardDb`. If the monitor accidentally receives the guarded db, a mismatch permanently wedges (it could never write telemetry, and in `cant_verify` design intent breaks). The integration test's recovery scenario catches this if wired correctly — wire it correctly.
4. **Boot ordering in `main()`.** The boot check must run between `mongoClient.connect()` (:116) and the `agent_definitions` `createIndex` calls (:120) — those are the first writes. `runMigrations` also must see the guarded db only after verification. Don't move the monitor start into the heartbeat block at :427 — startup-window reconnects must be caught.
5. **Timers in tests.** All timers (30s interval, 5s retry sleeps) must be `unref()`'d in production code, and tests must use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` (async variant — the retry path awaits between timer hops). Restore real timers in `afterEach`. The single-flight promise means some assertions need an explicit microtask flush (`await Promise.resolve()` chains or `vi.runAllTicks`) after emitting an event.
6. **`MongoServerSelectionError` in tests.** The real constructor may require a `TopologyDescription`. If constructing one is awkward, build the rejection value with `Object.create(MongoServerSelectionError.prototype)` and assign `message` — `instanceof` still holds and no `vi.mock("mongodb")` is needed (do NOT mock the whole mongodb module; the source imports the real class for the `instanceof` discriminator).
7. **E11000 detection.** Match on `(err as { code?: number }).code === 11000`, not `instanceof MongoServerError` — keeps the branch testable with plain stub rejections and robust across driver minor versions.
8. **`shutdown()` ordering.** `dbIdentityMonitor.stop()` goes with the other heartbeat stops, before `mongoClient.close()`. An in-flight verify racing `close()` must land in the monitor's own catch (`log.warn`), never crash — covered by the throw-safety wrapping; don't "optimize" it away.
9. **esbuild bundle.** `npm run bundle` must stay green. No `import.meta.url === ...` entry-guard patterns in these library modules (repo feedback: shim-guards fire from the parent bundle's entry). For `stampedBy.engineVersion`, use `process.env.npm_package_version ?? "unknown"` — advisory field, not worth a bundle-hostile package.json path resolution.
10. **Don't gate more than the spec lists.** `aggregate` stays un-gated ($out/$merge verified absent from `src/`), `db.command()` un-gated (zero runtime usages). The enumerated list is the contract; additions are scope creep, omissions are holes.
11. **Log discipline.** State transitions log once; the 30s tick must not re-emit `log.error` every pass while in `mismatch`. `critical: true` goes in the metadata object of `log.error` — there is no fifth log level and you must not add one.

## Out of scope (reminder)
- No `hive doctor` changes — KPR-296 consumes the Sentinel Contract; nothing here touches `src/cli/doctor-checks.ts`.
- No CLI/wizard/import-hubspot/standalone-indexer gating (own clients, operator-driven — spec Non-Goals).
- No new log level.
- No config.ts changes; no agent-definition, adapter, or MCP-server changes.
- No `permits` datastore coverage (`PERMITS_MONGO_URI` — separate DB, out of scope).
