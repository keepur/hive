# KPR-296 — `hive doctor` datastore identity checks — Implementation Plan

**Spec:** `docs/epics/kpr-293/kpr-296-spec.md` (reviewed clean, commit `f70c5d7`; ⚠-flagged delegated assumptions are settled — do not re-litigate).
**Epic branch:** KPR-293 W1A (branch `mature/kpr-296` off `kpr-293`). One commit per task (dodi-dev:implement convention). Every task leaves the tree green: `npm run typecheck` + scoped tests pass after each task.
**Binding contracts consumed (read-only, zero producer diffs):** Sentinel Contract (KPR-294 R2, merged `5fd207b`) + Roster Stats Contract (KPR-295 E2/E3/E6, merged `5cfaa2e`).

**Verified anchors in current source** (line numbers as of this worktree):
- `src/cli/doctor.ts:197-446` — `runDoctor()`. Post-check sections block `:419-430` (`if (config) { cacheHitRatesForDoctor … }`) — the new section renders **first** inside this block, before the prompt-cache call at `:420`. Config-null skip lines `:431-438`. Exit block `if (!allPassed) … process.exit(1)` at `:441-444` — the fold happens strictly before it (structurally guaranteed: the section renders inside the `:419` block).
- `src/cli/doctor.ts:87-108` — `renderPrefixCacheSection(row, emit)`: the pure-render + emit-collector convention (default `console.log`, exported for tests). `:102` — the 120s staleness threshold precedent.
- `src/cli/doctor-checks.ts:105-118` — `mongoReachable`: short-lived client, `serverSelectionTimeoutMS: 2000`, dynamic `await import("mongodb")` so unit tests never pull the driver at module load. `:276-304` — `prefixCacheStatsForDoctor`: `{kind}`-keyed `findOne` on `telemetry`, defensive `??` mapping, `staleSeconds` computed at read time (`:297`). `:251-254` — `formatHitRate` (pure display helper precedent).
- `src/db/identity-sentinel.ts:22-24` — `SENTINEL_COLLECTION = "instance_identity"`, `SENTINEL_ID = "identity_sentinel"`, `SENTINEL_SCHEMA_VERSION = 1`. `:32-40` — `IdentitySentinelDoc` (frozen: `_id`/`schemaVersion`/`instanceId`/`dbName`; stable: `sentinelId`/`stampedAt`; advisory: `stampedBy {engineVersion, hostname, pid}`). `:74-76` — the match predicate (`instanceId` AND `dbName` only). **Note:** this module statically imports `mongodb` (`MongoServerSelectionError`) and the engine logger — see Risk #1 for why the doctor must NOT import it at runtime.
- `src/db/identity-sentinel.ts:282` — `DbIdentityMonitor.TELEMETRY_KIND = "db_identity_stats"`. `:633-662` — `writeOnce()` doc shape: `kind, state, expectedInstanceId, expectedDbName, sentinelPresent, observedInstanceId, observedDbName, observedSentinelId, writesRefused, refusedWriteCount, verifyCount, mismatchCount, lastVerifiedAt, lastMismatchAt, lastVerifyError, lastTriggerReason` + `updatedAt` on the `$set`. Heartbeat cadence (30s tick, `:362-371`).
- `src/db/write-guard.ts:19` — `DbIdentityMismatchError` message: "Run \`hive doctor\` for identity diagnostics" — the promise this ticket delivers.
- `src/index.ts:181-192` — `writeRosterStats`: `{kind: "agent_roster_stats"}` upsert, `$set: { ...buildRosterStatsDoc(...), updatedAt }`. Written at boot (`:239`) + every reload outcome (`:199`) — event-driven, NOT heartbeat.
- `src/agents/agent-registry.ts:104-128` — `buildRosterStatsDoc` field list: `docCount, activeCount, disabledCount, lastGoodAt, lastGoodSource, degraded, degradedSince, blockedReloadCount, lastBlockedAt, lastRecoveryAt` (all TS-nullable; never-null-when-written is a write-ordering guarantee per E2, not a type guarantee — read defensively anyway).
- `src/config.ts:135` — `config.instance.id`; `:185` — `config.mongo.dbName` (`optional("MONGODB_DB", \`hive_${instanceId}\`)`); `config.mongo.uri` from `MONGODB_URI`.
- Test conventions: `src/cli/doctor.test.ts` — emit-collector (`const lines: string[] = []; render(x, (l) => lines.push(l))`, assertions on `lines.join("\n")`). `src/cli/doctor-checks.test.ts` — pure-helper tests, `vi.mock("node:child_process")` only; **mongodb is never mocked and adapters have no I/O tests** (all five sibling adapters). Follow exactly.
- `src/cli.ts:234-235` — doctor entry (`await import("./cli/doctor.js")` then `runDoctor`); the CLI loads doctor modules lazily, nothing else to wire.

**Out of scope (do not touch):** `src/db/*`, `src/agents/*`, `src/index.ts`, telemetry writers, either producer contract, `src/config.ts` (no new flags/config), auth provisioning (KPR-297), restamp/repair actions, edge-15 recovery-gap fix (doctor only flags it), docs (KPR-298 documents this section).

---

## Task 1 — `doctor-checks.ts`: report shape, pure helpers/mappers, read adapter

**Goal:** `DatastoreIdentityReport` + all pure logic (URI redaction, temp-dbPath predicate, uptime formatting, the three doc→report mappers carrying the contract predicates) + the thin single-client adapter. Nothing imports it yet; tree stays green.

**Files:**
- `src/cli/doctor-checks.ts` (extend — new section at the bottom, after `memoryLifecycleStatsForDoctor`, before "resolved paths")
- `src/cli/doctor-checks.test.ts` (extend)

**Code (complete, append to `doctor-checks.ts`):**

```ts
// ── datastore identity (KPR-296) ────────────────────────────────────────

/**
 * Sentinel Contract identifiers (KPR-294 R2) and telemetry kinds, duplicated
 * as literals: `src/db/identity-sentinel.ts` statically imports the mongodb
 * driver + engine logger, and this module's convention is to never pull the
 * driver at module load (unit tests mock nothing). Drift against the
 * producer's exported constants is pinned by a test in doctor-checks.test.ts.
 */
export const DOCTOR_SENTINEL_COLLECTION = "instance_identity";
export const DOCTOR_SENTINEL_ID = "identity_sentinel";
export const DOCTOR_SENTINEL_SCHEMA_VERSION = 1;
export const DOCTOR_DB_IDENTITY_STATS_KIND = "db_identity_stats";
export const DOCTOR_ROSTER_STATS_KIND = "agent_roster_stats";

/** KPR-296 spec §Report shape — verbatim. */
export interface DatastoreIdentityReport {
  // Connection target (from config; credentials redacted before display)
  uri: string; // userinfo stripped: mongodb://<credentials>@host
  dbName: string;
  instanceId: string;

  // Server fingerprint — each null when the command failed; note carries why
  server: {
    host: string | null; // serverStatus.host (self-reported host:port)
    version: string | null; // serverStatus.version
    pid: number | null; // serverStatus.pid
    uptimeSeconds: number | null;
    dbPath: string | null; // getCmdLineOpts.parsed.storage.dbPath
    note: string | null; // e.g. "serverStatus unauthorized — expected under authed Mongo (KPR-297)"
  };

  // Doctor's own sentinel read (Sentinel Contract, KPR-294 R2)
  sentinel:
    | {
        state: "verified";
        observed: { instanceId: string; dbName: string; sentinelId: string | null };
        schemaVersionNewer: boolean;
        stampedAt: Date | null; // advisory display only, never verified (R2)
        stampedBy: string | null;
      }
    | {
        state: "mismatch";
        observed: { instanceId: string; dbName: string; sentinelId: string | null };
        schemaVersionNewer: boolean;
      }
    | { state: "absent" }
    | { state: "error"; message: string };

  // Live count — exact countDocuments({}), not estimated (it is a compare-target)
  agentDefinitionsCount: number | null;

  // Engine's identity monitor view (db_identity_stats — heartbeat kind)
  identityStats: {
    state: "verified" | "mismatch" | "cant_verify" | string; // tolerate unknown future states as non-verified
    writesRefused: boolean;
    refusedWriteCount: number;
    lastVerifiedAt: Date | null;
    lastMismatchAt: Date | null;
    observedInstanceId: string | null;
    observedDbName: string | null;
    staleSeconds: number | null; // from updatedAt — heartbeat cadence, staleness IS meaningful here
  } | null; // null = no doc yet (engine never booted post-KPR-294)

  // Roster guard view (agent_roster_stats — EVENT-DRIVEN kind)
  rosterStats: {
    docCount: number | null;
    activeCount: number | null;
    disabledCount: number | null;
    lastGoodAt: Date | null;
    lastGoodSource: "boot" | "reload" | null;
    degraded: boolean;
    degradedSince: Date | null;
    blockedReloadCount: number;
    lastBlockedAt: Date | null;
    updatedAt: Date | null; // displayed as a timestamp only — NEVER a staleness warning (canon E3)
  } | null; // null = no doc yet (engine never booted post-KPR-295)
}

/** Strip userinfo from a Mongo URI for display (log-redaction convention, CLAUDE.md Security). */
export function redactMongoUri(uri: string): string {
  // Userinfo cannot contain an unencoded `/`, so `[^@/]+@` never crosses
  // into the host/path and a credential-less URI passes through unchanged.
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]+@/, "$1<credentials>@");
}

/** Temp-directory roots — a dbPath under any of these is the Jul-4 impostor signature (spec W3). */
const TEMP_DB_PATH_ROOTS = ["/tmp", "/private/tmp", "/var/folders"];

export function isTempDbPath(dbPath: string): boolean {
  return TEMP_DB_PATH_ROOTS.some((root) => dbPath === root || dbPath.startsWith(`${root}/`));
}

/** Compact uptime for the fingerprint line: 266520 → "3d2h", 3700 → "1h1m", 90 → "1m". */
export function formatUptime(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86_400);
  const h = Math.floor((totalSeconds % 86_400) / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/** Loose read shapes — the doctor reads defensively; it never assumes the producer's TS types (E2). */
interface SentinelDocLike {
  instanceId?: unknown;
  dbName?: unknown;
  sentinelId?: unknown;
  schemaVersion?: unknown;
  stampedAt?: unknown;
  stampedBy?: unknown;
}

/**
 * Pure sentinel-doc → report mapping. Match = `instanceId` AND `dbName`
 * equality ONLY (Sentinel Contract, R2) — never `sentinelId`, `stampedAt`,
 * `stampedBy`, or wall clock. `schemaVersion > 1` is tolerated (W2 warn at
 * render time; frozen fields still trusted). The `error` variant is
 * assigned by the adapter's catch, not here.
 */
export function mapSentinelDoc(
  doc: SentinelDocLike | null,
  expected: { instanceId: string; dbName: string },
): DatastoreIdentityReport["sentinel"] {
  if (!doc) return { state: "absent" };
  const observed = {
    instanceId: typeof doc.instanceId === "string" ? doc.instanceId : "<invalid>",
    dbName: typeof doc.dbName === "string" ? doc.dbName : "<invalid>",
    sentinelId: typeof doc.sentinelId === "string" ? doc.sentinelId : null,
  };
  const schemaVersionNewer =
    typeof doc.schemaVersion === "number" && doc.schemaVersion > DOCTOR_SENTINEL_SCHEMA_VERSION;
  if (observed.instanceId === expected.instanceId && observed.dbName === expected.dbName) {
    const stampedBy = doc.stampedBy as { engineVersion?: unknown; hostname?: unknown } | null | undefined;
    return {
      state: "verified",
      observed,
      schemaVersionNewer,
      stampedAt: doc.stampedAt instanceof Date ? doc.stampedAt : null,
      stampedBy:
        stampedBy && (typeof stampedBy.engineVersion === "string" || typeof stampedBy.hostname === "string")
          ? `${String(stampedBy.engineVersion ?? "?")}@${String(stampedBy.hostname ?? "?")}`
          : null,
    };
  }
  return { state: "mismatch", observed, schemaVersionNewer };
}

interface IdentityStatsDocLike {
  state?: unknown;
  writesRefused?: unknown;
  refusedWriteCount?: unknown;
  lastVerifiedAt?: unknown;
  lastMismatchAt?: unknown;
  observedInstanceId?: unknown;
  observedDbName?: unknown;
  updatedAt?: unknown;
}

/** Pure db_identity_stats-doc → report mapping. Unknown/missing `state` maps to "unknown" — the renderer treats any non-"verified" as F3 when fresh (fail-closed, spec edge #12). */
export function mapIdentityStatsDoc(
  doc: IdentityStatsDocLike | null,
  now = Date.now(),
): DatastoreIdentityReport["identityStats"] {
  if (!doc) return null;
  const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt : null;
  return {
    state: typeof doc.state === "string" ? doc.state : "unknown",
    writesRefused: doc.writesRefused === true,
    refusedWriteCount: typeof doc.refusedWriteCount === "number" ? doc.refusedWriteCount : 0,
    lastVerifiedAt: doc.lastVerifiedAt instanceof Date ? doc.lastVerifiedAt : null,
    lastMismatchAt: doc.lastMismatchAt instanceof Date ? doc.lastMismatchAt : null,
    observedInstanceId: typeof doc.observedInstanceId === "string" ? doc.observedInstanceId : null,
    observedDbName: typeof doc.observedDbName === "string" ? doc.observedDbName : null,
    staleSeconds: updatedAt ? Math.round((now - updatedAt.getTime()) / 1000) : null,
  };
}

interface RosterStatsDocLike {
  docCount?: unknown;
  activeCount?: unknown;
  disabledCount?: unknown;
  lastGoodAt?: unknown;
  lastGoodSource?: unknown;
  degraded?: unknown;
  degradedSince?: unknown;
  blockedReloadCount?: unknown;
  lastBlockedAt?: unknown;
  updatedAt?: unknown;
}

/** Pure agent_roster_stats-doc → report mapping. Frozen fields per E2; `disabledCount`/`degradedSince`/`blockedReloadCount`/`lastBlockedAt` are merged-but-stable (spec §Report shape note) — a partial/pre-KPR-295 doc still maps without throwing. */
export function mapRosterStatsDoc(doc: RosterStatsDocLike | null): DatastoreIdentityReport["rosterStats"] {
  if (!doc) return null;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const date = (v: unknown): Date | null => (v instanceof Date ? v : null);
  return {
    docCount: num(doc.docCount),
    activeCount: num(doc.activeCount),
    disabledCount: num(doc.disabledCount),
    lastGoodAt: date(doc.lastGoodAt),
    lastGoodSource: doc.lastGoodSource === "boot" || doc.lastGoodSource === "reload" ? doc.lastGoodSource : null,
    degraded: doc.degraded === true,
    degradedSince: date(doc.degradedSince),
    blockedReloadCount: typeof doc.blockedReloadCount === "number" ? doc.blockedReloadCount : 0,
    lastBlockedAt: date(doc.lastBlockedAt),
    updatedAt: date(doc.updatedAt),
  };
}

/**
 * KPR-296 read adapter. Returns `null` only when the server is unreachable
 * (the Agents-group `mongoReachable` check already fails and explains that
 * case — the section renders "○ unreachable" and does not double-fail).
 *
 * ⚠ Delegated (spec §Design, settled): ONE shared client for all sub-reads,
 * unlike the sibling one-client-per-check pattern — the report's value
 * depends on every read observing the SAME server; split clients could
 * straddle a server flap and produce an incoherent report. Each sub-read is
 * individually try/caught so one failing command (e.g. unauthorized
 * `serverStatus` post-KPR-297) yields a partial report, not a dead section.
 *
 * STRICTLY READ-ONLY — both producer contracts mandate "doctor MUST NOT
 * write" (R2 / E2). No insert/update/replace/delete/drop of any kind.
 */
export async function datastoreIdentityForDoctor(
  uri: string,
  dbName: string,
  instanceId: string,
): Promise<DatastoreIdentityReport | null> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    await client.db(dbName).command({ ping: 1 });
  } catch {
    await client.close().catch(() => {});
    return null;
  }

  try {
    const db = client.db(dbName);
    const admin = db.admin();

    // Server fingerprint — best-effort, never fails the report (I4/KPR-297 forward-compat).
    const server: DatastoreIdentityReport["server"] = {
      host: null,
      version: null,
      pid: null,
      uptimeSeconds: null,
      dbPath: null,
      note: null,
    };
    const notes: string[] = [];
    try {
      const status = await admin.command({ serverStatus: 1 });
      server.host = typeof status.host === "string" ? status.host : null;
      server.version = typeof status.version === "string" ? status.version : null;
      // BSON int64 may surface as a bson.Long depending on driver serialization
      // (promoteLongs defaults to true, but don't assume the caller's client
      // config) — a genuine Long has no valueOf, so plain Number(...) can
      // yield NaN. Route through toString() first, which every plausible
      // shape (number, bson.Long, numeric string) supports correctly.
      server.pid = status.pid != null ? Number(status.pid.toString()) : null;
      server.uptimeSeconds = typeof status.uptime === "number" ? Math.round(status.uptime) : null;
    } catch (err) {
      notes.push(`serverStatus failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const opts = await admin.command({ getCmdLineOpts: 1 });
      const dbPath = (opts as { parsed?: { storage?: { dbPath?: unknown } } }).parsed?.storage?.dbPath;
      server.dbPath = typeof dbPath === "string" ? dbPath : null; // absent under bare defaults → renderer prints "(default)", skips W3
    } catch (err) {
      notes.push(`getCmdLineOpts failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    server.note = notes.length > 0 ? notes.join("; ") : null;

    // Doctor's OWN sentinel read (out-of-process, R4 leaves CLIs ungated by design).
    let sentinel: DatastoreIdentityReport["sentinel"];
    try {
      const doc = await db
        .collection<{ _id: string } & SentinelDocLike>(DOCTOR_SENTINEL_COLLECTION)
        .findOne({ _id: DOCTOR_SENTINEL_ID });
      sentinel = mapSentinelDoc(doc, { instanceId, dbName });
    } catch (err) {
      sentinel = { state: "error", message: err instanceof Error ? err.message : String(err) };
    }

    // Live roster count — exact countDocuments (compare-target for W5),
    // NOT estimatedDocumentCount.
    let agentDefinitionsCount: number | null = null;
    try {
      agentDefinitionsCount = await db.collection("agent_definitions").countDocuments({});
    } catch {
      agentDefinitionsCount = null;
    }

    // Engine telemetry views — absent doc and failed read both map to null
    // (renders I2); the report shape carries no error slot for these.
    let identityStats: DatastoreIdentityReport["identityStats"] = null;
    try {
      identityStats = mapIdentityStatsDoc(
        await db.collection("telemetry").findOne({ kind: DOCTOR_DB_IDENTITY_STATS_KIND }),
      );
    } catch {
      /* stays null */
    }

    let rosterStats: DatastoreIdentityReport["rosterStats"] = null;
    try {
      rosterStats = mapRosterStatsDoc(await db.collection("telemetry").findOne({ kind: DOCTOR_ROSTER_STATS_KIND }));
    } catch {
      /* stays null */
    }

    return {
      uri: redactMongoUri(uri),
      dbName,
      instanceId,
      server,
      sentinel,
      agentDefinitionsCount,
      identityStats,
      rosterStats,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
```

Note on typing: `admin.command()` returns the driver's `Document` (index signature) — the `typeof` narrowing on each field keeps this inside the repo's no-`any` rule without casts; the one structured cast (`opts as { parsed?: … }`) gets a shape, not `any`.

**Tests (extend `src/cli/doctor-checks.test.ts`):**

```ts
import {
  DOCTOR_DB_IDENTITY_STATS_KIND,
  DOCTOR_SENTINEL_COLLECTION,
  DOCTOR_SENTINEL_ID,
  DOCTOR_SENTINEL_SCHEMA_VERSION,
  formatUptime,
  isTempDbPath,
  mapIdentityStatsDoc,
  mapRosterStatsDoc,
  mapSentinelDoc,
  redactMongoUri,
} from "./doctor-checks.js";
// Producer constants — imported in TESTS only (the source module must not
// import identity-sentinel.ts; see the literal-duplication comment there).
import { SENTINEL_COLLECTION, SENTINEL_ID, SENTINEL_SCHEMA_VERSION, DbIdentityMonitor } from "../db/identity-sentinel.js";
```

1. **Contract drift pins:** `DOCTOR_SENTINEL_COLLECTION === SENTINEL_COLLECTION`, `DOCTOR_SENTINEL_ID === SENTINEL_ID`, `DOCTOR_SENTINEL_SCHEMA_VERSION === SENTINEL_SCHEMA_VERSION`, `DOCTOR_DB_IDENTITY_STATS_KIND === DbIdentityMonitor.TELEMETRY_KIND`. (`agent_roster_stats` has no exported producer constant — it is a literal inside the `writeRosterStats` closure in `index.ts`; pinned by the Task 3 grep acceptance instead.)
2. `redactMongoUri`: `mongodb://user:pass@localhost:27017/x` → `mongodb://<credentials>@localhost:27017/x`; `mongodb+srv://u:p@cluster.example.com` redacted; `mongodb://localhost:27017` unchanged; `mongodb://localhost:27017/db?replicaSet=rs@0` unchanged (no userinfo — `@` after first `/`).
3. `isTempDbPath`: true for `/tmp`, `/tmp/xyz`, `/private/tmp/mongo-impostor`, `/var/folders/ab/cd`; false for `/opt/homebrew/var/mongodb`, `/tmpfoo`, `/data/tmp`.
4. `formatUptime`: `266_520` → `"3d2h"`, `3_700` → `"1h1m"`, `90` → `"1m"`.
5. `mapSentinelDoc` — the R2 predicate pins:
   - `null` → `{ state: "absent" }`.
   - Exact match → `verified`, `stampedBy: "0.9.2@mokiemon"` formatting, `stampedAt` passthrough.
   - `instanceId` differs (dbName equal) → `mismatch`; `dbName` differs (instanceId equal) → `mismatch` (both directions — reviewer-lens: inverse-direction edge).
   - **Match ignores everything else:** doc with matching identity but foreign `sentinelId`, ancient `stampedAt`, different `stampedBy` → still `verified` (pins "no comparison against sentinelId/stampedAt/stampedBy/wall clock").
   - `schemaVersion: 2` + matching identity → `verified` with `schemaVersionNewer: true` (frozen fields still trusted); same on mismatch.
   - Malformed doc (missing `instanceId`) → `mismatch` with `observed.instanceId: "<invalid>"`, no throw.
6. `mapIdentityStatsDoc`: `null` → `null`; full doc → all fields + `staleSeconds` from a pinned `now`; missing `state` → `"unknown"`; missing counters → defaults; non-Date `updatedAt` → `staleSeconds: null`; unknown state string passes through verbatim.
7. `mapRosterStatsDoc`: `null` → `null`; full doc round-trips; partial doc (only frozen E2 fields, no `disabledCount`/`degradedSince`) → nulls/defaults, no throw; `degraded` missing → `false`.

Adapter I/O itself stays thin and untested-against-live-Mongo — matching every sibling adapter in this file (spec §Testing Contract sanctions this explicitly; all verdict-relevant logic lives in the exported pure mappers above).

**Verify:**
```
npm run typecheck
npx vitest run src/cli/doctor-checks.test.ts
```
Commit: `feat(cli): datastore-identity report adapter + pure contract mappers (KPR-296)`

---

## Task 2 — `doctor.ts`: `renderDatastoreIdentitySection` + full verdict-table tests

**Goal:** the pure render function implementing the spec's verdict table (F1–F3, W1–W6, I1–I5) with the hard-failure return, fully tested emit-collector style. Not wired yet; tree stays green.

**Files:**
- `src/cli/doctor.ts` (add render function after `renderMemoryLifecycleSection`, before `GROUP_TITLES`; extend the `./doctor-checks.js` import with `datastoreIdentityForDoctor`, `formatUptime`, `isTempDbPath`, `type DatastoreIdentityReport` — adapter import used in Task 3, added now so one import-edit covers both tasks)
- `src/cli/doctor.test.ts` (extend)

**Code (complete):**

```ts
/**
 * KPR-296: render the "Datastore identity" section — the doctor's answer to
 * "is the mongod behind config.mongo.uri actually this instance's database?"
 * (Jul-4 impostor incident; audit §9). Pure + emit-collector-testable.
 *
 * DELIBERATE departure from the informational-section precedent: returns a
 * hard-failure verdict that `runDoctor` folds into `allPassed` — F1 (sentinel
 * present-but-mismatched), F2 (roster guard degraded), F3 (engine identity
 * monitor fresh + non-verified) flip the doctor's exit code. This delivers
 * the diagnostics `DbIdentityMismatchError` already promises
 * ("Run `hive doctor` for identity diagnostics", src/db/write-guard.ts:19).
 *
 * Remediation hints print inline on failing lines unconditionally (the
 * ⚠-inline style of the newer sections, not the --verbose remedy style).
 */
export function renderDatastoreIdentitySection(
  report: DatastoreIdentityReport | null,
  emit: (line: string) => void = console.log,
): { failed: boolean } {
  emit("\nDatastore identity");
  if (!report) {
    // I5 — mongoReachable (Agents group) already failed and counted once.
    emit('  ○ unreachable — see "MongoDB reachable" above');
    return { failed: false };
  }

  let failed = false;
  const iso = (d: Date | null): string => (d ? d.toISOString() : "?");

  // ── server fingerprint (best-effort, never fails the doctor) ──
  const s = report.server;
  const haveFingerprint = s.host !== null || s.version !== null || s.pid !== null || s.dbPath !== null;
  if (haveFingerprint) {
    const up = s.uptimeSeconds === null ? "?" : formatUptime(s.uptimeSeconds);
    emit(`  server: ${s.host ?? "?"} — mongod ${s.version ?? "?"}, pid ${s.pid ?? "?"}, up ${up}`);
    emit(`    dbPath: ${s.dbPath ?? "(default)"}`);
  }
  if (s.note) {
    // I4 — e.g. unauthorized under a KPR-297-authed mongod.
    emit(`  ○ server fingerprint unavailable — ${s.note}`);
  }
  if (s.dbPath !== null && isTempDbPath(s.dbPath)) {
    // W3 — the exact incident signature (impostor ran --dbpath /tmp/...).
    emit(`  ⚠ connected mongod dbPath is a TEMP directory (${s.dbPath}) — this is the Jul-4 impostor signature`);
    emit(`      → verify you are talking to the production mongod (brew services list; lsof -i :27017)`);
  }

  emit(`  target: ${report.uri} db=${report.dbName} instance=${report.instanceId}`);

  // ── doctor's own sentinel read (Sentinel Contract, R2) ──
  const sen = report.sentinel;
  if (sen.state === "verified") {
    const stamp =
      sen.stampedAt || sen.stampedBy
        ? `, stamped ${sen.stampedAt ? sen.stampedAt.toISOString().slice(0, 10) : "?"} by ${sen.stampedBy ?? "?"}`
        : "";
    emit(`  ✓ identity sentinel matches (instanceId=${report.instanceId}, dbName=${report.dbName}${stamp})`);
  } else if (sen.state === "mismatch") {
    // F1 — hard fail.
    failed = true;
    emit(
      `  ✗ identity sentinel MISMATCH — expected ${report.instanceId}/${report.dbName}, ` +
        `observed ${sen.observed.instanceId}/${sen.observed.dbName} (sentinelId=${sen.observed.sentinelId ?? "<none>"})`,
    );
    emit(
      `      → wrong DB or wrong instance config. To intentionally adopt this DB: ` +
        `set HIVE_DB_SENTINEL_RESTAMP=1 for one engine boot (remove after).`,
    );
  } else if (sen.state === "absent") {
    if (report.agentDefinitionsCount === null) {
      emit(`  ⚠ identity sentinel absent and agent count unavailable — cannot confirm pre-first-boot; re-run doctor`);
    } else if (report.agentDefinitionsCount > 0) {
      // W1 — warn, not fail (⚠ delegated, settled): the legitimate 0.9.2→next
      // upgrade window must not hard-fail every not-yet-rebooted instance.
      emit(`  ⚠ identity sentinel absent but DB has hive data (${report.agentDefinitionsCount} agent defs)`);
      emit(
        `      → pre-KPR-294 engine, or the engine hasn't booted since upgrade — start it to stamp. ` +
          `If it HAS booted: you may be looking at a different DB than the engine.`,
      );
    } else {
      // I1 — pre-first-boot.
      emit(`  ○ identity sentinel absent, DB empty — pre-first-boot (not an error)`);
    }
  } else {
    // Edge #5 — read flap: warn, not fail (can't distinguish flap from incident in one shot).
    emit(`  ⚠ sentinel read failed: ${sen.message}`);
  }
  if ((sen.state === "verified" || sen.state === "mismatch") && sen.schemaVersionNewer) {
    // W2 — R2 forward-compat clause.
    emit(`  ⚠ sentinel schemaVersion is newer than this doctor knows — frozen fields still authoritative`);
  }

  // ── engine identity monitor (db_identity_stats — HEARTBEAT cadence) ──
  const ids = report.identityStats;
  if (ids === null) {
    // I2 — cross-referenced with the sentinel result when it is also absent.
    emit(
      `  ○ no db_identity_stats telemetry yet — engine hasn't booted on this engine version` +
        (sen.state === "absent" ? "; cross-check the sentinel result above" : ""),
    );
  } else {
    const fresh = ids.staleSeconds !== null && ids.staleSeconds <= 120;
    if (!fresh) {
      // W6 — same 120s threshold as the prefix-cache/spawn-coordinator sections.
      emit(
        `  ⚠ db_identity_stats heartbeat is stale (${ids.staleSeconds ?? "?"}s) — engine may not be running (last state: ${ids.state})`,
      );
    } else if (ids.state === "verified") {
      emit(`  ✓ engine identity monitor: verified (heartbeat ${ids.staleSeconds}s ago, writes refused=${ids.writesRefused})`);
    } else {
      // F3 — fresh non-verified, incl. unknown future states (fail-closed, edge #12).
      // ⚠ delegated (settled): keyed on `state`, not `writesRefused` — they agree
      // by construction (transitionTo engages/disengages atomically with state),
      // and `state` also covers cant_verify.
      failed = true;
      emit(
        `  ✗ engine identity monitor: ${ids.state} — writes refused=${ids.writesRefused}, refused=${ids.refusedWriteCount}, ` +
          `observed ${ids.observedInstanceId ?? "<absent>"}/${ids.observedDbName ?? "<absent>"}`,
      );
      emit(`      → the running engine is refusing DB writes; see db_identity_stats and engine logs (critical marker).`);
    }
  }

  // ── roster guard (agent_roster_stats — EVENT-DRIVEN kind; canon E3:
  // updatedAt is NOT liveness — no staleness warning here, ever) ──
  const rs = report.rosterStats;
  if (rs === null) {
    emit(`  ○ no agent_roster_stats telemetry yet — engine hasn't booted on this engine version`);
  } else if (rs.degraded) {
    // F2 — hard fail.
    failed = true;
    emit(
      `  ✗ roster guard DEGRADED since ${iso(rs.degradedSince)} — engine holding last-good roster ` +
        `(${rs.docCount ?? "?"} docs @ ${iso(rs.lastGoodAt)}) but DB reload read empty (${rs.blockedReloadCount} blocked)`,
    );
    emit(
      `      → restore the real DB; the engine auto-recovers within ~30s. ` +
        `If the engine was restarted mid-episode, SIGUSR1 after restore.`,
    );
  } else {
    const { docCount, activeCount, disabledCount } = rs;
    // Canon E6 discriminators (edge #14): all-disabled is recorded operator
    // state (I3); 0-active-not-all-disabled is validation-evicted-all (W4).
    const allDisabled = docCount !== null && docCount > 0 && activeCount === 0 && disabledCount === docCount;
    const evictedAll = docCount !== null && docCount > 0 && activeCount === 0 && !allDisabled;
    // Edge #15 (⚠ delegated, settled: any delta, not only →0). Both non-null, not degraded.
    const diverged =
      report.agentDefinitionsCount !== null && docCount !== null && report.agentDefinitionsCount !== docCount;

    if (evictedAll) {
      emit(
        `  ⚠ roster: ${docCount} docs but 0 active and not all disabled — validation evicted every agent (engine/data version skew?)`,
      );
    } else if (allDisabled) {
      emit(`  ○ all ${docCount} agents disabled (recorded operator state)`);
    }
    if (diverged) {
      emit(
        `  ⚠ roster divergence: DB has ${report.agentDefinitionsCount} agent defs, engine last committed ${docCount} (@ ${iso(rs.lastGoodAt)})`,
      );
      emit(
        `      → if the engine restarted during a DB outage it may be running an empty/stale roster — send SIGUSR1 to reload.`,
      );
    } else if (!evictedAll && !allDisabled) {
      emit(
        `  ✓ roster: ${report.agentDefinitionsCount ?? "?"} docs live = ${docCount ?? "?"} at last good load ` +
          `(active=${activeCount ?? "?"}, disabled=${disabledCount ?? "?"}, source=${rs.lastGoodSource ?? "?"} @ ${iso(rs.lastGoodAt)})`,
      );
    }
  }

  return { failed };
}
```

**Tests (extend `src/cli/doctor.test.ts`)** — new `describe("renderDatastoreIdentitySection (KPR-296)")` with an all-green factory:

```ts
function makeIdentityReport(overrides: Partial<DatastoreIdentityReport> = {}): DatastoreIdentityReport {
  return {
    uri: "mongodb://localhost:27017",
    dbName: "hive_test",
    instanceId: "test",
    server: {
      host: "localhost:27017",
      version: "8.0.11",
      pid: 4242,
      uptimeSeconds: 266_520,
      dbPath: "/opt/homebrew/var/mongodb",
      note: null,
    },
    sentinel: {
      state: "verified",
      observed: { instanceId: "test", dbName: "hive_test", sentinelId: "abc-123" },
      schemaVersionNewer: false,
      stampedAt: new Date("2026-07-05T00:00:00Z"),
      stampedBy: "0.9.2@mokiemon",
    },
    agentDefinitionsCount: 11,
    identityStats: {
      state: "verified",
      writesRefused: false,
      refusedWriteCount: 0,
      lastVerifiedAt: new Date(),
      lastMismatchAt: null,
      observedInstanceId: "test",
      observedDbName: "hive_test",
      staleSeconds: 12,
    },
    rosterStats: {
      docCount: 11,
      activeCount: 10,
      disabledCount: 1,
      lastGoodAt: new Date("2026-07-06T04:11:00Z"),
      lastGoodSource: "reload",
      degraded: false,
      degradedSince: null,
      blockedReloadCount: 0,
      lastBlockedAt: null,
      updatedAt: new Date("2026-07-06T04:11:00Z"),
    },
    ...overrides,
  };
}
```

Every verdict row gets a test (assert both the line content and the `failed` verdict):

1. **Happy path:** all-green factory → `failed: false`; output contains the section header, `server:`, `dbPath:`, `target:`, three `✓` lines; contains no `✗` and no `⚠`.
2. **I5:** `render(null)` → `failed: false`, contains `unreachable — see "MongoDB reachable" above`, does not throw.
3. **F1:** sentinel `{ state: "mismatch", observed: { instanceId: "other", dbName: "hive_other", sentinelId: "zzz" }, schemaVersionNewer: false }` → `failed: true`; line matches `/✗ identity sentinel MISMATCH — expected test\/hive_test, observed other\/hive_other/`; remediation contains `HIVE_DB_SENTINEL_RESTAMP=1`. **(← negative-verify target, Task 3.)**
4. **F2:** rosterStats `degraded: true, degradedSince: <date>, blockedReloadCount: 4` → `failed: true`; line matches `/✗ roster guard DEGRADED/`; remediation contains `SIGUSR1 after restore`. **(← negative-verify target.)**
5. **F3 (mismatch):** identityStats `state: "mismatch", writesRefused: true, refusedWriteCount: 7, staleSeconds: 10` → `failed: true`; line contains `engine identity monitor: mismatch` and `refused=7`. **(← negative-verify target.)**
6. **F3 (cant_verify):** same with `state: "cant_verify"` → `failed: true`.
7. **F3 (unknown future state, edge #12):** `state: "quarantined", staleSeconds: 5` → `failed: true` (fail-closed).
8. **F3 requires freshness:** `state: "mismatch", staleSeconds: 300` → `failed: false`, W6 stale warn instead (contains `heartbeat is stale (300s)` and `last state: mismatch`).
9. **W6 on verified-but-stale:** `state: "verified", staleSeconds: 300` → warn, `failed: false`. Also `staleSeconds: null` → treated stale (warn, no fail).
10. **W1:** sentinel `{ state: "absent" }` + `agentDefinitionsCount: 11` → `failed: false`, warn contains `sentinel absent but DB has hive data (11 agent defs)` and the "HAS booted" hint.
11. **I1:** absent + `agentDefinitionsCount: 0` → `○ identity sentinel absent, DB empty`, no `⚠` for the sentinel, `failed: false`.
12. Absent + `agentDefinitionsCount: null` → warn `cannot confirm pre-first-boot`, `failed: false`.
13. **W2:** verified with `schemaVersionNewer: true` → warn `schemaVersion is newer`; also emitted alongside F1 when mismatch has `schemaVersionNewer: true` (still `failed: true`).
14. **W3:** `dbPath: "/tmp/mongo-8DqT"` → warn `TEMP directory` + `Jul-4 impostor signature`; **`/private/tmp/x` alias** also warns; `dbPath: null` renders `(default)` and no W3; `/opt/homebrew/var/mongodb` no W3 (happy path already pins).
15. **I4:** server all-null with `note: "serverStatus failed: not authorized"` → `○ server fingerprint unavailable — …`, no `server:` line, `failed: false`.
16. **W4 (edge #14, canon E6):** rosterStats `docCount: 5, activeCount: 0, disabledCount: 2` (+ `agentDefinitionsCount: 5` so W5 stays quiet) → warn `validation evicted every agent`, `failed: false`.
17. **I3 (all-disabled carve-out, E1):** `docCount: 5, activeCount: 0, disabledCount: 5`, live 5 → `○ all 5 agents disabled (recorded operator state)`, **no** W4 warn, `failed: false`.
18. **W5 (any delta):** live 11 vs `docCount: 8` → warn `roster divergence: DB has 11 agent defs, engine last committed 8` + `SIGUSR1` remediation, `failed: false`.
19. **W5 (edge-#15 shape):** `docCount: 0, activeCount: 0, disabledCount: 0, degraded: false` + live 11 → divergence warn fires (and W4 does not — `docCount > 0` gate), `failed: false`.
20. **E3 pin (no roster staleness path exists):** rosterStats with `updatedAt: new Date("2026-05-01T00:00:00Z")` (ancient), `degraded: false`, counts all matching → **no** warn of any kind in the output (`expect(out).not.toContain("⚠")`), `failed: false`. Pins that roster `updatedAt` never produces a staleness warning.
21. **I2:** `identityStats: null` → `○ no db_identity_stats telemetry yet`; `rosterStats: null` → `○ no agent_roster_stats telemetry yet`; with sentinel also absent, the identity-stats line contains `cross-check the sentinel result above`; `failed: false`.
22. **Sentinel read error (edge #5):** `sentinel: { state: "error", message: "boom" }` → `⚠ sentinel read failed: boom`, `failed: false`.
23. **Composite incident shape (spec edge #1):** absent sentinel + `agentDefinitionsCount: 0` + fresh `state: "mismatch"` identityStats + `dbPath: "/tmp/x"` → `failed: true` (F3), W3 present, I1 present — pins that the incident is caught even when the doctor's own sentinel read sees only "absent + empty".

**Verify:**
```
npm run typecheck
npx vitest run src/cli/doctor.test.ts
```
Commit: `feat(cli): render "Datastore identity" doctor section — verdict table F1-F3/W1-W6/I1-I5 (KPR-296)`

---

## Task 3 — Wire into `runDoctor`, exit-code fold, negative-verify, final gate

**Goal:** section renders first among the post-check sections; F1/F2/F3 flip the doctor's exit code; config-null skip line; negative-verify evidence recorded; full gate green.

**Files:**
- `src/cli/doctor.ts` (wiring only)

**Changes (exact):**

1. In `runDoctor`, at the top of the existing `if (config)` block (`:419`, before `cacheHitRatesForDoctor`):

```ts
  if (config) {
    // KPR-296: datastore identity — rendered FIRST among the post-check
    // sections (identity outranks cache stats; failure text sits near the
    // check groups) and the ONLY post-check section that can fail the
    // doctor: F1 sentinel mismatch / F2 roster degraded / F3 fresh
    // non-verified engine monitor flip the exit code.
    const identityReport = await datastoreIdentityForDoctor(
      config.mongo.uri,
      config.mongo.dbName,
      config.instance.id,
    );
    const { failed: identityFailed } = renderDatastoreIdentitySection(identityReport, console.log);
    if (identityFailed) allPassed = false;

    const rows = await cacheHitRatesForDoctor(config.mongo.uri, config.mongo.dbName);
    // …existing informational sections unchanged…
```

2. In the `else` branch (`:431`), add the skip lines **first** (mirroring render order):

```ts
  } else {
    console.log("\nDatastore identity");
    console.log("  ○ skipped: config not loaded");
    console.log("\nPrompt cache (last 7 days)");
    // …existing skip lines unchanged…
```

3. No other changes. The fold lands before the `if (!allPassed) … process.exit(1)` block at `:441` by construction (same statement block). `--verbose` behavior untouched — the section's remediation lines print inline unconditionally per spec Non-Goals.

**Acceptance (grep-level, record in the commit message):**
- `grep -nE '\.(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|bulkWrite|findOneAnd(Update|Replace|Delete)|createIndex(es)?|dropIndex(es)?|drop|rename|dropDatabase|createCollection)\(' src/cli/doctor.ts src/cli/doctor-checks.ts` → **zero hits** (contract-compliance checklist: zero write operations in the diff; grep-verifiable).
- `grep -n "agent_roster_stats\|db_identity_stats\|instance_identity" src/cli/doctor-checks.ts` → hits only in the `DOCTOR_*` constant declarations + their read call sites (pins the `agent_roster_stats` literal against the producer's literal in `src/index.ts:184`, which has no exported constant).
- `grep -n "estimatedDocumentCount" src/cli/doctor-checks.ts` → only the pre-existing `hasAnyAgent` hit; the new live count uses `countDocuments`.

**Negative-verify (repo convention — record both outputs for the PR):**
- Target: the exit-code policy — the spec's key behavioral claim that F1/F2/F3 actually flip the verdict (a broken version that renders the ✗ lines but never sets `failed` would pass a text-only test suite).
- Procedure: temporarily neuter the fix — comment out all three `failed = true;` assignments in `renderDatastoreIdentitySection` (F1, F2, F3 branches) — run `npx vitest run src/cli/doctor.test.ts` → confirm the F1/F2/F3/edge-12/composite tests **fail** (each asserts `res.failed === true`); restore → confirm pass. This proves the tests detect a fail-open regression, not just their own line-matching plumbing.
- The one-line `runDoctor` fold (`if (identityFailed) allPassed = false`) is not unit-reachable (`runDoctor` runs every environment check); it is covered by the manual drill's `echo $?` step below plus code review of the wiring diff.

**Final gate:**
```
npm run typecheck
npm run lint
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
npm run bundle   # esbuild sanity — pkg/ artifact must stay green
```
Commit: `feat(cli): wire datastore identity into hive doctor — F1/F2/F3 flip exit code (KPR-296)`

---

## Testing Contract (MANDATORY)

### Unit
| File | Coverage |
|---|---|
| `src/cli/doctor.test.ts` (extend) | Render function, every verdict row: **F1** mismatch fails with restamp remediation; **F2** degraded fails with SIGUSR1-after-restore remediation; **F3** fresh non-verified fails — `mismatch`, `cant_verify`, and unknown future state (edge #12, fail-closed); F3 requires freshness (stale non-verified → W6 warn, no fail); **W1** absent+data warns without failing (upgrade window preserved); **W2** schema-newer (on verified and alongside F1); **W3** temp dbPath incl. the `/private/tmp` alias, `(default)` skip, non-temp negative; **W4** edge-14 discriminator `{docCount>0, activeCount:0, degraded:false}` with the all-disabled carve-out (**I3**, E1/E6); **W5** divergence on any delta + the edge-15 `docCount: 0` + live > 0 shape, with SIGUSR1 remediation; **W6** stale identity heartbeat (300s + null-staleSeconds) vs **no staleness path existing at all for roster `updatedAt`** (ancient `updatedAt`, `degraded: false` → zero `⚠` in output — pins canon E3); **I1/I2** absent-doc paths incl. sentinel cross-reference wording; **I4** fingerprint-unavailable never fails; **I5** null report neither fails nor throws; happy path all-green returns `failed: false`; composite incident shape (edge #1: F3+W3 with absent-sentinel-empty-DB) fails. |
| `src/cli/doctor-checks.test.ts` (extend) | Pure helpers: `redactMongoUri` (with/without credentials, `mongodb+srv`, `@`-after-path non-match); `isTempDbPath` (three roots, exact-root, prefix-collision negatives `/tmpfoo`, `/data/tmp`); `formatUptime`. Pure mappers: `mapSentinelDoc` — **R2 predicate pins**: match = `instanceId` AND `dbName` only, both mismatch directions, match ignores `sentinelId`/`stampedAt`/`stampedBy`, `schemaVersion > 1` tolerated-but-flagged, malformed doc doesn't throw; `mapIdentityStatsDoc` — defaults, unknown-state passthrough, staleSeconds derivation; `mapRosterStatsDoc` — full/partial/pre-KPR-295 doc shapes, `degraded` default false. **Contract drift pins**: `DOCTOR_*` literals === producer exports (`SENTINEL_COLLECTION`/`SENTINEL_ID`/`SENTINEL_SCHEMA_VERSION`/`DbIdentityMonitor.TELEMETRY_KIND`) — producer modules imported in tests only. |

All pure — emit-collector + plain object fixtures, no Mongo, no mocks of the driver, tests beside source per repo convention.

### Integration
**None required — deliberate.** The adapter (`datastoreIdentityForDoctor`) is thin I/O composition over the tested pure mappers, matching every sibling adapter in `doctor-checks.ts` (`prefixCacheStatsForDoctor`, `spawnCoordinatorStatsForDoctor`, `memoryLifecycleStatsForDoctor` — none has an I/O test). The spec's Testing Contract sanctions this explicitly ("Adapter I/O itself stays thin and untested-against-live-Mongo, matching every sibling adapter in this file"). The repo has no `mongodb-memory-server` dependency and CI forbids a real mongod (KPR-294/295 precedent). All verdict logic is reachable through the pure render/mapper tests above.

### E2E — manual operator drill (documented substitute for automated e2e)
Include verbatim in the PR description, with observed results if run pre-merge (recommended on a dev instance):

1. **Happy path:** on a healthy dev instance with the engine running, `hive doctor; echo $?` → "Datastore identity" section shows the server fingerprint, `✓` sentinel / `✓` engine monitor / `✓` roster lines; exit `0`.
2. **F1 + W3 (impostor-shaped):** start a scratch mongod on a spare port: `mongod --dbpath "$(mktemp -d)" --port 27099 &`. Stamp a *foreign* sentinel + one dummy agent def:
   `mongosh --port 27099 <dbName> --eval 'db.instance_identity.insertOne({_id:"identity_sentinel",schemaVersion:1,instanceId:"other",dbName:"hive_other",sentinelId:"drill",stampedAt:new Date(),stampedBy:{engineVersion:"drill",hostname:"drill",pid:1}}); db.agent_definitions.insertOne({_id:"dummy",isDefault:true})'`
   Then from the instance dir: `MONGODB_URI=mongodb://localhost:27099 hive doctor; echo $?` → **expected:** `✗ identity sentinel MISMATCH — expected …, observed other/hive_other` with the RESTAMP remediation, `⚠ … TEMP directory … Jul-4 impostor signature` (mktemp lands under `/var/folders` on macOS), exit `1`.
3. **W1 (upgrade window):** on the scratch mongod, `db.instance_identity.deleteOne({_id:"identity_sentinel"})`, re-run doctor → **expected:** `⚠ identity sentinel absent but DB has hive data (1 agent defs)`; the identity section itself does **not** fail (exit code may still be 1 from other groups on the scratch DB — read the section, not just `$?`).
4. Kill the scratch mongod; re-run step 1 to confirm the real instance is untouched (the drill wrote only to the throwaway `--dbpath`; the doctor itself wrote nothing — verifiable via `db.instance_identity.findOne(...)` unchanged `sentinelId` on the real DB).

### Negative-verify
Comment out the three `failed = true;` assignments in `renderDatastoreIdentitySection` → `npx vitest run src/cli/doctor.test.ts` must fail on the F1/F2/F3/edge-12/composite tests (each asserts the returned verdict, not just line text); restore → pass. Include both run outputs in the PR description as evidence that the exit-code policy is pinned by tests, not prose.

### Regression surface
- All existing `doctor.test.ts` / `doctor-checks.test.ts` tests pass unmodified (pure additions; no existing render function or adapter touched).
- Existing doctor exit behavior unchanged for every pre-existing check: the fold only ever sets `allPassed = false`, never true; a hive with healthy identity gets byte-identical behavior on all existing sections.
- Full `npm run check` with the Slack env stubs (repo convention) + `npm run bundle`.

---

## New/changed public surfaces (complete list)

| Surface | Change | Consumers affected |
|---|---|---|
| `DatastoreIdentityReport` | New exported interface in `doctor-checks.ts` (spec §Report shape verbatim) | `doctor.ts` render + tests. |
| `datastoreIdentityForDoctor(uri, dbName, instanceId)` | New read-only adapter — single shared short-lived client, per-sub-read try/catch, `null` only on unreachable | `runDoctor` only. |
| `redactMongoUri` / `isTempDbPath` / `formatUptime` | New exported pure helpers | Render + tests. |
| `mapSentinelDoc` / `mapIdentityStatsDoc` / `mapRosterStatsDoc` | New exported pure mappers carrying the contract predicates (R2 match, E2 defensive reads) | Adapter + tests. |
| `DOCTOR_SENTINEL_COLLECTION` / `DOCTOR_SENTINEL_ID` / `DOCTOR_SENTINEL_SCHEMA_VERSION` / `DOCTOR_DB_IDENTITY_STATS_KIND` / `DOCTOR_ROSTER_STATS_KIND` | New exported literal constants (drift-pinned against producers in tests) | Adapter + drift-pin tests. |
| `renderDatastoreIdentitySection(report, emit): { failed: boolean }` | New exported render function — first post-check section, only one with a failure verdict | `runDoctor` + tests. |
| `hive doctor` exit code | **Behavior change (spec-mandated):** F1/F2/F3 now exit 1 where the doctor previously reported green or generic Agents-group failures | Operators / CI-cron wrappers running `hive doctor` — this is the ticket's Goal 5. No existing green path changes. |

## Risks / Gotchas for the implementer

1. **Do not import `src/db/identity-sentinel.ts` from CLI source modules.** It statically imports the mongodb driver (`MongoServerSelectionError`) and the engine logger; `doctor-checks.ts`'s convention is dynamic `await import("mongodb")` only, so unit tests never load the driver. Duplicate the four literals with the `DOCTOR_*` constants and pin drift in the **test** file (tests may import producer modules freely).
2. **`countDocuments({})`, not `estimatedDocumentCount()`** for the live roster count — it is a compare-target for W5; the estimate can lag and manufacture phantom divergence warns.
3. **No staleness logic on roster `updatedAt` — ever** (canon E3, event-driven kind). Test #20 pins zero-`⚠` output for an ancient `updatedAt`; do not "helpfully" add a symmetry warn with the identity-stats section.
4. **Match predicate is `instanceId` AND `dbName` equality only** (R2). Never compare `sentinelId`, `stampedAt`, `stampedBy`, or wall clock — `stampedAt`/`stampedBy` are display-only in the verified line.
5. **Sub-read failure ≠ dead section.** Only connect+ping failure returns `null` (I5). Every subsequent read is individually try/caught: fingerprint failure → note (I4), sentinel read failure → `{state:"error"}` warn (edge #5), count/telemetry failure → null field. One unauthorized command under a future authed mongod must not take out the report (KPR-297 forward-compat).
6. **Zero writes.** The adapter must contain no write-method call of any kind — the Task 3 grep is part of acceptance, and the review bar (spec §Contract-compliance checklist) checks it. Doctor's own client is deliberately outside the engine's write guard (R4) — read-only discipline here is contractual, not enforced by code.
7. **F3 freshness gate:** fail only when `staleSeconds !== null && staleSeconds <= 120`. Stale-or-missing heartbeat with a non-verified last state is W6 (warn), not F3 — a dead engine's last gasp must not fail the doctor a week later. Conversely `staleSeconds: null` on an existing doc is treated as stale (warn), never fresh.
8. **W5 gating:** requires both counts non-null AND `degraded: false` (F2 already owns the degraded case). W4 requires `docCount > 0` so the edge-15 shape (`docCount: 0`) routes to W5 only.
9. **`report.uri` is pre-redacted in the adapter** — the renderer never sees raw credentials, so no render-path change can leak them.
10. **serverStatus `pid` may arrive as a BSON Long** depending on driver serialization — coerce via `Number(status.pid.toString())` (Task 1's code does this), never bare `Number(...)` on the raw value (a genuine `Long` has no `valueOf`, so plain `Number()` can yield `NaN`), and don't `typeof === "number"`-gate it to null.
11. **Section placement and fold:** render as the first statement of the existing `if (config)` block; fold `failed` into `allPassed` right there. It precedes the `process.exit(1)` block by construction — do not move the section after the informational renders or into a separate `if`.
12. **`--verbose` untouched:** remediation lines print unconditionally inline (newer-section ⚠ style). Do not thread `verbose` into the render signature.
13. **esbuild bundle** must stay green (`npm run bundle`); no `import.meta.url` entry-guard patterns (repo lesson, KPR-183).
14. **Unknown `identityStats.state` values fail closed** (F3 when fresh) — resist normalizing them to a warn; edge #12 is explicit.

## Rollback

Purely additive, read-only, CLI-only. Revert the (≤3) commits: the doctor returns to identity-blind behavior; no schema, data, config, engine, or telemetry impact of any kind. Both producer contracts are unconsumed again but unchanged. No operator action needed.
