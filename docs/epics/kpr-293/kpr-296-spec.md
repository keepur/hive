# KPR-296 — W1A.3: `hive doctor` datastore identity checks

**Epic:** KPR-293 (Production hardening & hygiene). **Depends on:** KPR-294 (Sentinel Contract, merged 5fd207b) and KPR-295 (Roster Stats Contract, merged 5cfaa2e) — both contracts are frozen; this spec consumes them read-only and changes neither.

**Consumers of this spec:** the KPR-296 implementation plan, and KPR-298 (docs), which documents the doctor section this ticket ships.

## TL;DR

Add a **"Datastore identity"** section to `hive doctor` that answers, out-of-process, the question the Jul 4 incident proved nobody could answer: *is the mongod behind `config.mongo.uri` actually this instance's database?* It reports the connected server's fingerprint (host/pid/uptime/version + `dbPath` — the impostor's smoking gun was `--dbpath /tmp/...`), performs the doctor's own sentinel read against the KPR-294 contract, surfaces the engine's live identity-monitor and roster-guard telemetry, and compares the live `agent_definitions` count against the KPR-295 last-good roster. Unlike the existing informational telemetry sections, hard identity failures in this section **fail the doctor (exit 1)**.

## Key Points

- **In scope:** one new doctor section (render function in `src/cli/doctor.ts` + one read adapter in `src/cli/doctor-checks.ts`), reading: `serverStatus` + `getCmdLineOpts` fingerprint, the `instance_identity` sentinel, `db_identity_stats` and `agent_roster_stats` telemetry, and a live `agent_definitions` count. Strictly read-only — both producer contracts mandate "doctor MUST NOT write," and this spec adds no write of any kind.
- **Exit-code policy (deliberate departure from the informational-section precedent):** three conditions fail the doctor — (F1) sentinel present-but-mismatched, (F2) roster guard `degraded: true`, (F3) engine identity monitor reporting `state != "verified"` on a fresh (≤120s) heartbeat. Everything else is ⚠ warn or ○ info. This delivers the diagnostics that `DbIdentityMismatchError`'s message already promises ("Run `hive doctor` for identity diagnostics", `src/db/write-guard.ts:19`).
- **Contract compliance is the review bar:** match predicate is `instanceId` AND `dbName` equality only; tolerate `schemaVersion > 1` (warn, still trust frozen fields); `agent_roster_stats.updatedAt` is **not** a liveness signal (event-driven kind — no staleness warning for it, ever); `db_identity_stats` **is** heartbeat-cadence (stale >120s warns, same threshold as sibling sections).
- **Edge-#14 discriminator implemented as specified by canon E6:** `{docCount > 0, activeCount: 0, degraded: false}` → "validation evicted every agent" warn, distinguished from all-disabled via `disabledCount === docCount`.
- **Edge-#15 divergence check implemented as specified by KPR-295 edge table:** live `agent_definitions` count ≠ stats `docCount` → warn with SIGUSR1 remediation (covers restart-while-degraded, where the engine sits on an empty committed roster after the real DB returns).
- **Server fingerprint is best-effort:** `serverStatus`/`getCmdLineOpts` may be unauthorized once KPR-297 lands auth — print "unavailable" and continue, never fail on fingerprint absence. ⚠ warn when `dbPath` is under a temp root (`/tmp`, `/private/tmp`, `/var/folders`) — the exact incident signature.
- **Out of scope:** engine changes, telemetry-writer changes, restamp/repair actions from the doctor, new CLI flags, auth provisioning (KPR-297), fixing edge-15 (doctor only flags it), gating the doctor's own client through the write guard (doctor is deliberately out-of-process per KPR-294 R4/Non-Goals).
- ⚠ **Delegated assumptions** (Gate-1 blanket delegation, flagged inline): single shared MongoClient for the whole report; divergence warn on *any* live-vs-lastGood count delta (not just the →0 case); absent-sentinel-with-data is warn-not-fail; F3 keys on `state` (not `writesRefused`); section placement and exact line format.

## Problem

The Jul 4 incident: an impostor mongod took over port 27017 and both hives ran 25 hours against it. KPR-294 gave the *engine* boot-fatal + runtime-degrade detection; KPR-295 gave it an empty-roster reload guard. But the operator's first diagnostic tool, `hive doctor`, still knows nothing about datastore identity: it checks that *a* mongod is reachable (`mongoReachable`) and that *some* agents exist (`hasAnyAgent`) — both of which an impostor with stale data could satisfy, and both of which report generic failure ("run setup:seeds") for what is actually an identity incident. Audit §9 names the fix: "doctor check for the connected server's dbpath/identity." Additionally, `DbIdentityMismatchError` (shipped in KPR-294) already tells agents and operators to "Run `hive doctor` for identity diagnostics" — a promise the doctor cannot currently keep.

## Goals

1. Doctor performs its **own** sentinel verification (out-of-process, own client) against the Sentinel Contract — not merely relaying the engine's opinion.
2. Doctor fingerprints the **connected server** (host, pid, uptime, version, `dbPath`) so the operator can see *which mongod* answered, and gets a loud warn on temp-dir `dbPath`.
3. Doctor surfaces the **engine's live view** (`db_identity_stats`): state, writes-refused, refused count, freshness.
4. Doctor compares **live roster count vs last-known-good** (`agent_roster_stats`), implementing the canon discriminators (edge #14) and divergence remediation flag (edge #15).
5. Hard identity failures flip the doctor's exit code — an operator (or CI/cron wrapper) running `hive doctor` during an identity incident gets a non-zero exit, not a green report with a footnote.

## Non-Goals

- **No writes.** Both contracts: doctor MUST NOT write `instance_identity`, `agent_roster_stats`, `db_identity_stats`, or anything else. No repair/restamp action (that is the engine's `HIVE_DB_SENTINEL_RESTAMP` path, R8).
- **No engine-side changes.** Both producer surfaces are consumed as merged. Zero diffs outside `src/cli/`.
- **No auth work.** If `serverStatus`/`getCmdLineOpts` are refused under a KPR-297-authed mongod, degrade to "unavailable" — provisioning a doctor-readable role is KPR-297's (or a follow-up's) concern.
- **No new flags/config.** The section always renders (like the other post-check sections); `--verbose` behavior unchanged (remediation hints print inline on failing lines, matching the ⚠-inline style of the newer sections, not the Check-framework remedy style).
- **No boot-window fix for edge #15.** The doctor *flags* the divergence and names the SIGUSR1 remediation; closing the recovery gap itself is explicitly out of scope (KPR-295 Non-Goals).

## Design

### Shape: one adapter, one render function

Follows the established `doctor-checks.ts` / `doctor.ts` split (`prefixCacheStatsForDoctor` → `renderPrefixCacheSection` etc.):

1. **`datastoreIdentityForDoctor(uri, dbName, instanceId): Promise<DatastoreIdentityReport | null>`** in `src/cli/doctor-checks.ts`. Short-lived MongoClient (`serverSelectionTimeoutMS: 2000`, family pattern). Returns `null` only when the server is unreachable (the Agents-group `mongoReachable` check already fails and explains that case — the section prints "○ unreachable" and does **not** double-fail).
   ⚠ *Delegated:* one shared client for all sub-reads, unlike the existing one-client-per-check pattern — the report's value depends on all reads observing the *same* server; split clients could straddle a server flap and produce an incoherent report. Each sub-read is individually try/caught so one failing command (e.g. unauthorized `serverStatus`) yields a partial report, not a dead section.

2. **`renderDatastoreIdentitySection(report, emit): { failed: boolean }`** in `src/cli/doctor.ts`. Pure, emit-collector-testable (matches `renderPrefixCacheSection` test style). Returns the hard-failure verdict; `runDoctor` folds it into `allPassed` **before** the final verdict/exit. Rendered first among the post-check sections (identity outranks cache stats).

### Report shape

```ts
export interface DatastoreIdentityReport {
  // Connection target (from config; credentials redacted before display)
  uri: string;            // userinfo stripped: mongodb://<credentials>@host → mongodb://host
  dbName: string;
  instanceId: string;

  // Server fingerprint — each null when the command failed; note carries why
  server: {
    host: string | null;        // serverStatus.host (self-reported host:port)
    version: string | null;     // serverStatus.version
    pid: number | null;         // serverStatus.pid
    uptimeSeconds: number | null;
    dbPath: string | null;      // getCmdLineOpts.parsed.storage.dbPath
    note: string | null;        // e.g. "serverStatus unauthorized — expected under authed Mongo (KPR-297)"
  };

  // Doctor's own sentinel read (Sentinel Contract, KPR-294 R2)
  sentinel:
    | { state: "verified"; observed: { instanceId: string; dbName: string; sentinelId: string | null };
        schemaVersionNewer: boolean;
        stampedAt: Date | null; stampedBy: string | null }  // advisory display only, never verified (R2)
    | { state: "mismatch"; observed: { instanceId: string; dbName: string; sentinelId: string | null };
        schemaVersionNewer: boolean }
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
    staleSeconds: number | null;  // from updatedAt — heartbeat cadence, staleness IS meaningful here
  } | null;                       // null = no doc yet (engine never booted post-KPR-294)

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
    updatedAt: Date | null;       // displayed as a timestamp only — NEVER a staleness warning (canon E3)
  } | null;                       // null = no doc yet (engine never booted post-KPR-295)
}
```

Nullable telemetry fields mirror the wire contracts' TS-nullable-but-never-null-when-written semantics (E2): the adapter reads defensively with `??` defaults like the sibling adapters, but the doctor does not assume never-null — a pre-KPR-295 doc shape or partial doc still renders.

### Verdict table

| # | Condition | Icon / effect | Line + remediation |
|---|---|---|---|
| F1 | Sentinel present, `instanceId` or `dbName` ≠ expected | ✗ **fail** | `identity sentinel MISMATCH — expected <id>/<db>, observed <id>/<db> (sentinelId=…)` → "wrong DB or wrong instance config. To intentionally adopt this DB: set HIVE_DB_SENTINEL_RESTAMP=1 for one engine boot (remove after)." |
| F2 | `rosterStats.degraded === true` | ✗ **fail** | `roster guard DEGRADED since <t> — engine holding last-good roster (<docCount> docs @ <lastGoodAt>) but DB reload read empty (<blockedReloadCount> blocked)` → "restore the real DB; the engine auto-recovers within ~30s. If the engine was restarted mid-episode, SIGUSR1 after restore." |
| F3 | `identityStats` present, `staleSeconds ≤ 120`, `state !== "verified"` | ✗ **fail** | `engine identity monitor: <state> — writes refused=<bool>, refused=<n>, observed <id>/<db>` → "the running engine is refusing DB writes; see db_identity_stats and engine logs (critical marker)." ⚠ *Delegated:* keyed on `state` rather than `writesRefused` — the two agree by construction (`transitionTo` engages/disengages the guard atomically with state), and `state` also covers `cant_verify`. |
| W1 | Sentinel absent + `agentDefinitionsCount > 0` | ⚠ warn | `identity sentinel absent but DB has hive data (<n> agent defs)` → "pre-KPR-294 engine, or the engine hasn't booted since upgrade — start it to stamp. If it HAS booted: you may be looking at a different DB than the engine." ⚠ *Delegated:* warn not fail — the legitimate upgrade path (R2 read semantics: "suspect", not "mismatch") must not hard-fail every not-yet-rebooted 0.9.2→next instance. |
| W2 | Sentinel `schemaVersionNewer` | ⚠ warn | `sentinel schemaVersion is newer than this doctor knows — frozen fields still authoritative` (R2 forward-compat clause). |
| W3 | `dbPath` under `/tmp`, `/private/tmp`, or `/var/folders` | ⚠ warn | `connected mongod dbPath is a TEMP directory (<path>) — this is the Jul-4 impostor signature` → "verify you are talking to the production mongod (brew services list; lsof -i :27017)." |
| W4 | Edge #14: `docCount > 0 && activeCount === 0 && !degraded && disabledCount !== docCount` | ⚠ warn | `roster: <docCount> docs but 0 active and not all disabled — validation evicted every agent (engine/data version skew?)` (canon E6 discriminator, pinned by KPR-295 test 5b). |
| W5 | Edge #15 divergence: `agentDefinitionsCount !== rosterStats.docCount` (both non-null, not degraded) | ⚠ warn | `roster divergence: DB has <live> agent defs, engine last committed <docCount> (@ <lastGoodAt>)` → "if the engine restarted during a DB outage it may be running an empty/stale roster — send SIGUSR1 to reload." ⚠ *Delegated:* warns on any delta, not only `docCount === 0` — the change-stream/poll normally converges within seconds, so a persistent delta at doctor-time is worth an operator glance; the wording stays soft ("may be"). |
| W6 | `identityStats` present, `staleSeconds > 120` | ⚠ warn | `db_identity_stats heartbeat is stale (<n>s) — engine may not be running` (same 120s threshold as the prefix-cache/spawn-coordinator sections; heartbeat-cadence kind, so staleness is meaningful — contrast E3). |
| I1 | Sentinel absent + DB empty | ○ info | `identity sentinel absent, DB empty — pre-first-boot (not an error)` (R2). |
| I2 | `identityStats === null` / `rosterStats === null` | ○ info | `no <kind> telemetry yet — engine hasn't booted on this engine version` — cross-referenced with W1 wording when the sentinel is also absent (KPR-295 read semantics: absent doc + non-empty DB → "pre-upgrade engine, or telemetry collection is impostor-fresh; cross-check the sentinel"). |
| I3 | All-disabled: `activeCount === 0 && disabledCount === docCount && docCount > 0` | ○ info | `all <n> agents disabled (recorded operator state)` — explicitly NOT the incident (E1). |
| I4 | Fingerprint command failed | ○ info | `server fingerprint unavailable — <note>` — never fails the doctor (KPR-297 auth forward-compat). |
| I5 | Report `null` (server unreachable) | ○ info | `unreachable — see "MongoDB reachable" above` — no additional failure (already counted by the Agents group). |

Happy-path output sketch:

```
Datastore identity
  server: localhost:27017 — mongod 8.0.11, pid 4242, up 3d2h
    dbPath: /opt/homebrew/var/mongodb
  target: mongodb://localhost:27017 db=hive_dodi instance=dodi
  ✓ identity sentinel matches (instanceId=dodi, dbName=hive_dodi, stamped 2026-07-05 by 0.9.2@mokiemon)
  ✓ engine identity monitor: verified (heartbeat 12s ago, writes refused=false)
  ✓ roster: 11 docs live = 11 at last good load (active=10, disabled=1, source=reload @ 2026-07-06T04:11Z)
```

`stampedBy`/`stampedAt` are displayed (advisory, R2 allows display) and never verified against.

### Fingerprint commands

- `client.db(dbName).admin().command({ serverStatus: 1 })` → `host`, `version`, `pid`, `uptime`. (`db.command` from the doctor's own client is untouched by the engine's write guard — R4 deliberately leaves out-of-process CLIs ungated.)
- `admin().command({ getCmdLineOpts: 1 })` → `parsed.storage.dbPath` (absent for a mongod started with a bare CLI `--dbpath`? No — `parsed` reflects CLI args too; but `dbPath` may still be absent for config-file-less defaults → display `(default)` and skip W3).
- URI redaction before display: strip userinfo (`mongodb://user:pass@host` → `mongodb://<credentials>@host`) — log-redaction convention (CLAUDE.md Security).

### Wiring in `runDoctor`

```ts
if (config) {
  const identityReport = await datastoreIdentityForDoctor(config.mongo.uri, config.mongo.dbName, config.instance.id);
  const { failed } = renderDatastoreIdentitySection(identityReport, console.log);
  if (failed) allPassed = false;
  // ...existing informational sections follow (prompt cache, prefix cache, …)
} else {
  console.log("\nDatastore identity");
  console.log("  ○ skipped: config not loaded");
}
```

The `allPassed` fold must happen before the existing `if (!allPassed) … process.exit(1)` block; the section renders before the informational sections so the failure text sits near the check groups.

## Contract-compliance checklist (review bar)

- [ ] Sentinel read: `findOne({ _id: "identity_sentinel" })` on `instance_identity`; match = `instanceId` AND `dbName` equality **only** (R2). No comparison against `sentinelId`, `stampedAt`, `stampedBy`, or wall clock.
- [ ] `schemaVersion > 1` tolerated: warn, frozen fields still trusted (R2).
- [ ] Roster stats read: `findOne({ kind: "agent_roster_stats" })` on `telemetry`; **no staleness warning from `updatedAt`** (E3); verdicts keyed on `degraded` / `lastGoodAt` / counts.
- [ ] Identity stats read: `findOne({ kind: "db_identity_stats" })`; staleness threshold 120s (heartbeat family).
- [ ] Zero write operations in the adapter (grep-verifiable: no `insert|update|replace|delete|drop` driver calls in the diff).
- [ ] Edge-#14 discriminator exactly `{docCount > 0, activeCount: 0, degraded: false}` with all-disabled carve-out (E6).
- [ ] Edge-#15 divergence flag present with SIGUSR1 remediation (KPR-295 edge table row 15).

## Failure Modes & Edge Cases

| # | Scenario | Doctor behavior |
|---|---|---|
| 1 | **The incident** (engine running, driver flapped to impostor): doctor connects to the same impostor | Sentinel absent + DB empty reads as I1 on its own — but the engine's raw-handle telemetry lands on the impostor (KPR-294 "honest caveat"), so `db_identity_stats` shows `state: mismatch` fresh → **F3 fails**. `dbPath` under `/tmp` → W3. Roster stats doc (also impostor-written while degraded) shows `degraded: true` → **F2 fails**. Three independent signals; any one suffices. |
| 2 | **Restart-into-impostor** (boot-absent → engine stamps the impostor, R3's deliberate trade-off) | Sentinel reads *verified* (stamped with correct identity). Remaining discriminators: W3 temp-dbPath warn, the Agents-group "at least one agent exists" ✗, and W5 divergence if a stale roster-stats doc survived. Documented honestly: the sentinel alone cannot catch this case — by design (R3); the section's other signals compose to cover it. |
| 3 | Doctor and engine see **different servers** (port stolen between engine boot and doctor run) | Doctor's own sentinel read is authoritative for what *the doctor* sees; the engine's `identityStats` describes what *the engine* sees. Both render; a disagreement (doctor verified + engine mismatch fresh) still fails via F3 — correct, since the running engine is refusing writes. |
| 4 | KPR-297 lands auth; doctor's URI lacks privileges for `serverStatus`/`getCmdLineOpts` | I4 — fingerprint "unavailable," note names the auth cause, no failure. Sentinel/telemetry reads use normal collection reads on the instance DB and keep working under the engine's own credentials in the URI. |
| 5 | Sentinel read itself throws (network flap mid-report) | `sentinel: { state: "error" }` → rendered as ⚠ "sentinel read failed: <msg>" — warn, not fail (can't distinguish flap from incident in one shot; the operator re-runs). Other sub-reads render independently. |
| 6 | Pre-KPR-294/295 engine (upgrade not yet booted) | W1 + I2 — warns pointing at "boot the engine," no hard fail (legitimate upgrade window). |
| 7 | Fresh install, nothing booted yet | I1 + I2 + live count 0 — all info; section passes (the Agents group already handles "no agents" messaging). |
| 8 | All agents disabled | I3 info; F/W silent (`activeCount: 0` with `disabledCount === docCount` is recorded operator state, E1). |
| 9 | Validation evicted all (edge #14) | W4 warn with the canon discriminator; not degraded, not failed — matches KPR-295's "deliberately unguarded, doctor-visible" contract. |
| 10 | Engine restarted mid-episode, real DB back, engine sitting empty (edge #15) | `degraded: false` (restart cleared it), stats `docCount: 0` (boot committed empty), live count > 0 → W5 fires with the SIGUSR1 remediation. This is the named consumer of the E-register's "edge-15 divergence check" obligation. |
| 11 | Mongo entirely unreachable | Adapter returns `null` → I5; failure already counted once by `mongoReachable` — no double-fail, no crash. |
| 12 | Unknown future `identityStats.state` value | Treated as non-verified → F3 if fresh (fail-closed toward "engine says something is wrong"). |

## Integration Points (exact files)

| File | Change |
|---|---|
| `src/cli/doctor-checks.ts` | `DatastoreIdentityReport` interface + `datastoreIdentityForDoctor()` adapter (single short-lived client, per-sub-read try/catch, URI redaction helper). |
| `src/cli/doctor.ts` | `renderDatastoreIdentitySection()` (pure, exported for tests) + wiring into `runDoctor` (render first post-checks section; fold `failed` into `allPassed`; config-null skip line). |
| `src/cli/doctor.test.ts` | Render tests (emit-collector style, existing convention). |
| `src/cli/doctor-checks.test.ts` | Adapter-adjacent pure-helper tests (URI redaction, temp-dbPath predicate). |

No changes to `src/db/*`, `src/agents/*`, `src/index.ts`, telemetry writers, or either producer contract. No config surface.

## Testing Contract

Render-function tests (pure, no Mongo) covering every verdict row: F1 mismatch fails; F2 degraded fails; F3 fresh-non-verified fails (incl. unknown state, edge 12); W1 absent+data warns without failing; W2 schema-newer; W3 temp dbPath (incl. `/private/tmp` alias); W4 edge-14 discriminator incl. the all-disabled carve-out (I3); W5 divergence (incl. the edge-15 `docCount: 0` + live > 0 shape); W6 stale identity heartbeat vs **no staleness path existing at all for roster `updatedAt`** (assert no warn emitted for an ancient roster `updatedAt` with `degraded: false` — pins canon E3); I1/I2 absent-doc paths; I5 null report neither fails nor throws; happy path all-green returns `failed: false`. Pure-helper tests: URI userinfo redaction (with and without credentials, `mongodb+srv`), temp-dbPath predicate. Adapter I/O itself stays thin and untested-against-live-Mongo, matching every sibling adapter in this file.

## Open Questions / Delegated Assumptions

All ⚠ items below are routine implementation choices delegated under the Gate-1 blanket delegation (none blocks `spec-ready`):

1. ⚠ Single shared MongoClient for the report (coherence over the per-check-client pattern) — Design §adapter.
2. ⚠ W5 warns on any live-vs-lastGood delta, not only the →0 case — Verdict table.
3. ⚠ W1 (sentinel absent + data) is warn-not-fail, preserving the upgrade path — Verdict table.
4. ⚠ F3 keys on `state !== "verified"` rather than `writesRefused` — Verdict table.
5. ⚠ Exact line formats, section placement (first post-check section), and the 120s staleness threshold reuse — Design.
6. Non-blocking (KPR-297 coordination note, not a question for this ticket): if KPR-297 ends up requiring auth for `serverStatus`, a doctor-readable role would upgrade I4 from "unavailable" back to a full fingerprint — file as follow-up there if it materializes.
