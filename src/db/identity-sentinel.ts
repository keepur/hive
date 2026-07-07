import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Db, Collection } from "mongodb";
import { MongoServerSelectionError } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { WriteGuard } from "./write-guard.js";

/**
 * KPR-294 — DB identity sentinel contract + boot check + verify read.
 *
 * This module is intentionally pure/testable: no `process.exit`, no
 * process-lifecycle side effects. `index.ts` owns the fatal-exit decision
 * on a boot-time mismatch; this module only reports outcomes.
 *
 * `DbIdentityMonitor` (runtime SDAM-triggered re-verification, Task 3) is
 * implemented at the bottom of this file, per spec Integration Points.
 */

const log = createLogger("identity-sentinel");

/** Collection + singleton doc id — the Sentinel Contract's frozen identifiers. */
export const SENTINEL_COLLECTION = "instance_identity";
export const SENTINEL_ID = "identity_sentinel";
export const SENTINEL_SCHEMA_VERSION = 1;

/**
 * The Sentinel Contract (spec §Sentinel Contract) — stable interface that
 * KPR-296 (hive doctor) re-reads out-of-process. `_id`, `schemaVersion`,
 * `instanceId`, `dbName` are frozen fields; `sentinelId`/`stampedAt` are
 * stable diagnostics; `stampedBy` is advisory-only (never verified against).
 */
export interface IdentitySentinelDoc {
  _id: string; // "identity_sentinel"
  schemaVersion: number; // 1
  instanceId: string;
  dbName: string;
  sentinelId: string; // UUID v4 per stamp (crypto.randomUUID())
  stampedAt: Date;
  stampedBy: { engineVersion: string; hostname: string; pid: number };
}

export interface SentinelIdentity {
  instanceId: string;
  dbName: string;
}

export type BootCheckResult =
  | { outcome: "stamped" } // absent -> insertOne
  | { outcome: "verified"; schemaVersionNewer: boolean }
  | {
      outcome: "mismatch";
      observed: { instanceId: string; dbName: string; sentinelId: string | null };
    }
  | { outcome: "restamped"; previous: { instanceId: string; dbName: string } };

export type SentinelVerifyResult =
  | {
      state: "verified";
      sentinelPresent: true;
      schemaVersionNewer: boolean;
      observed: { instanceId: string; dbName: string; sentinelId: string | null };
    }
  | {
      state: "mismatch";
      sentinelPresent: boolean;
      observed: { instanceId: string; dbName: string; sentinelId: string | null } | null;
    };

/** Narrowed error shape for the E11000 duplicate-key discriminator (spec/plan Risk #7: don't use `instanceof MongoServerError`, keeps stub rejections testable). */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

function matches(doc: Pick<IdentitySentinelDoc, "instanceId" | "dbName">, expected: SentinelIdentity): boolean {
  return doc.instanceId === expected.instanceId && doc.dbName === expected.dbName;
}

function buildDoc(expected: SentinelIdentity): IdentitySentinelDoc {
  return {
    _id: SENTINEL_ID,
    schemaVersion: SENTINEL_SCHEMA_VERSION,
    instanceId: expected.instanceId,
    dbName: expected.dbName,
    sentinelId: randomUUID(),
    stampedAt: new Date(),
    stampedBy: {
      // Advisory-only field per the Sentinel Contract — never read package.json
      // via import.meta-relative paths; that breaks under the esbuild bundle
      // (repo lesson: shim-guard patterns fire from the parent bundle's entry).
      engineVersion: process.env.npm_package_version ?? "unknown",
      hostname: hostname(),
      pid: process.pid,
    },
  };
}

/**
 * Boot-time sentinel check (spec §Boot flow). Must run before any other
 * write against the instance DB. Pure/testable — no `process.exit` here;
 * the caller (`index.ts`) decides what to do with a `mismatch` outcome.
 *
 * Semantics (exact per spec table):
 * - Absent -> `insertOne` the full frozen doc, return `stamped`.
 * - `insertOne` E11000 (two instances racing an empty DB) -> re-read and
 *   fall through to the Present branches.
 * - Present + match (`instanceId` AND `dbName`) -> `verified`.
 * - Present + mismatch + `restamp: false` -> `mismatch` (caller is fatal).
 * - Present + mismatch + `restamp: true` -> `replaceOne` upsert, `restamped`
 *   carrying the previous identity (caller logs the loud warn).
 * - Read/write errors propagate.
 */
export async function ensureIdentitySentinelAtBoot(
  rawDb: Db,
  opts: SentinelIdentity & { restamp: boolean },
): Promise<BootCheckResult> {
  const collection = rawDb.collection<IdentitySentinelDoc>(SENTINEL_COLLECTION);
  const expected: SentinelIdentity = { instanceId: opts.instanceId, dbName: opts.dbName };

  let doc = await collection.findOne({ _id: SENTINEL_ID });

  if (!doc) {
    const newDoc = buildDoc(expected);
    try {
      await collection.insertOne(newDoc);
      return { outcome: "stamped" };
    } catch (err) {
      if (!isDuplicateKeyError(err)) {
        throw err;
      }
      // Two instances misconfigured onto one empty DB, racing the stamp.
      // Re-read and fall through to the Present branches below — the
      // loser gets the explanatory mismatch/verified outcome, not a raw
      // driver error.
      doc = await collection.findOne({ _id: SENTINEL_ID });
      if (!doc) {
        // Should not happen (someone just inserted it), but propagate
        // rather than silently treat as stamped.
        throw err;
      }
    }
  }

  if (matches(doc, expected)) {
    return { outcome: "verified", schemaVersionNewer: doc.schemaVersion > SENTINEL_SCHEMA_VERSION };
  }

  if (!opts.restamp) {
    return {
      outcome: "mismatch",
      observed: { instanceId: doc.instanceId, dbName: doc.dbName, sentinelId: doc.sentinelId ?? null },
    };
  }

  const previous = { instanceId: doc.instanceId, dbName: doc.dbName };
  const replacement = buildDoc(expected);
  await collection.replaceOne({ _id: SENTINEL_ID }, replacement, { upsert: true });
  return { outcome: "restamped", previous };
}

/**
 * Runtime verify-read (spec §Runtime monitor / Sentinel Contract read
 * semantics). Always called against the RAW (unguarded) db by the monitor
 * so verification keeps working while writes are refused.
 *
 * Unlike the boot check, an absent doc at runtime is treated as a mismatch
 * (that IS the incident signature — silent reconnect to an empty impostor)
 * rather than "stamp it".
 *
 * Read errors PROPAGATE — the caller (monitor) owns retry/grace policy.
 */
export async function verifySentinel(rawDb: Db, expected: SentinelIdentity): Promise<SentinelVerifyResult> {
  const collection = rawDb.collection<IdentitySentinelDoc>(SENTINEL_COLLECTION);
  const doc = await collection.findOne({ _id: SENTINEL_ID }, { maxTimeMS: 5000 });

  if (!doc) {
    return { state: "mismatch", sentinelPresent: false, observed: null };
  }

  const observed = { instanceId: doc.instanceId, dbName: doc.dbName, sentinelId: doc.sentinelId ?? null };

  if (matches(doc, expected)) {
    return {
      state: "verified",
      sentinelPresent: true,
      schemaVersionNewer: doc.schemaVersion > SENTINEL_SCHEMA_VERSION,
      observed,
    };
  }

  return { state: "mismatch", sentinelPresent: true, observed };
}

// ---------------------------------------------------------------------------
// Task 3 — DbIdentityMonitor (runtime SDAM-triggered re-verification)
// ---------------------------------------------------------------------------

export type IdentityState = "verified" | "mismatch" | "cant_verify";

/**
 * Minimal server-description shape the monitor reads off SDAM events.
 * Narrowed from the driver's `ServerDescription` to exactly what the
 * trigger logic needs (spec §Runtime monitor triggers #1/#2).
 */
interface NarrowedServerDescription {
  type: string;
  topologyVersion?: { processId?: unknown } | null;
}

interface NarrowedServerDescriptionChangedEvent {
  address: string;
  previousDescription: NarrowedServerDescription;
  newDescription: NarrowedServerDescription;
}

interface NarrowedTopologyDescription {
  servers: Map<string, NarrowedServerDescription>;
}

interface NarrowedTopologyDescriptionChangedEvent {
  previousDescription: NarrowedTopologyDescription;
  newDescription: NarrowedTopologyDescription;
}

/**
 * The event surface `DbIdentityMonitor` needs off `MongoClient` — narrowed
 * for testability (spec/plan: "type as the event surface, accept a narrowed
 * interface"). A real `MongoClient` satisfies this structurally; tests pass
 * a plain `EventEmitter` cast to this type.
 */
export interface MonitoredMongoClient {
  on(event: "serverDescriptionChanged", listener: (e: NarrowedServerDescriptionChangedEvent) => void): unknown;
  on(event: "topologyDescriptionChanged", listener: (e: NarrowedTopologyDescriptionChangedEvent) => void): unknown;
  on(event: "connectionPoolCleared", listener: (e: unknown) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface DbIdentityStats {
  kind: string;
  state: IdentityState;
  expectedInstanceId: string;
  expectedDbName: string;
  sentinelPresent: boolean;
  observedInstanceId: string | null;
  observedDbName: string | null;
  observedSentinelId: string | null;
  writesRefused: boolean;
  refusedWriteCount: number;
  verifyCount: number;
  mismatchCount: number;
  lastVerifiedAt: Date | null;
  lastMismatchAt: Date | null;
  lastVerifyError: string | null;
  lastTriggerReason: string;
}

/** Sentinel string for a server address whose `topologyVersion.processId` is undefined. */
const NO_PROCESS_ID = "none";

function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * KPR-294 Task 3 — runtime re-verification state machine. Mirrors the
 * `SpawnCoordinatorHeartbeat` pattern: class, unref'd 30s interval, injected
 * telemetry collection, `writeOnce()` exposed for tests + initial write.
 *
 * Reads/writes exclusively through `rawDb`/`rawTelemetryCollection` — both
 * captured BEFORE `guardDb` wraps the shared `Db` (spec ⚠11). This is what
 * lets the monitor keep verifying (and reporting) while writes elsewhere are
 * refused; if it were handed the guarded db it could permanently wedge a
 * `cant_verify`/`mismatch` state (see plan Risk #3).
 */
export class DbIdentityMonitor {
  static readonly INTERVAL_MS = 30_000;
  static readonly READ_MAX_TIME_MS = 5_000;
  static readonly RETRY_ATTEMPTS = 3;
  static readonly RETRY_DELAY_MS = 5_000;
  static readonly TELEMETRY_KIND = "db_identity_stats";

  private readonly mongoClient: MonitoredMongoClient;
  private readonly rawDb: Db;
  private readonly writeGuard: WriteGuard;
  private readonly rawTelemetryCollection: Collection;
  private readonly expected: SentinelIdentity;
  private readonly intervalMs: number;
  private readonly retryDelayMs: number;

  private timer: NodeJS.Timeout | null = null;
  private readonly lastProcessIdByAddress = new Map<string, string>();

  // Single-flight state (spec §Serialization).
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private dirtyReason = "periodic";

  // State machine.
  private state: IdentityState = "verified";
  private lastVerifiedAt: Date | null = new Date();
  private lastMismatchAt: Date | null = null;
  private lastVerifyError: string | null = null;
  private lastTriggerReason = "boot";
  private verifyCount = 1;
  private mismatchCount = 0;
  private sentinelPresent = true;
  private observedInstanceId: string | null = null;
  private observedDbName: string | null = null;
  private observedSentinelId: string | null = null;
  private warnedSchemaVersionNewer = false;

  private readonly serverDescriptionChangedListener = (e: NarrowedServerDescriptionChangedEvent): void => {
    try {
      this.onServerDescriptionChanged(e);
    } catch (err) {
      log.warn("db-identity-monitor: serverDescriptionChanged listener threw", { error: String(err) });
    }
  };

  private readonly topologyDescriptionChangedListener = (e: NarrowedTopologyDescriptionChangedEvent): void => {
    try {
      this.onTopologyDescriptionChanged(e);
    } catch (err) {
      log.warn("db-identity-monitor: topologyDescriptionChanged listener threw", { error: String(err) });
    }
  };

  private readonly connectionPoolClearedListener = (): void => {
    try {
      this.scheduleVerify("connectionPoolCleared");
    } catch (err) {
      log.warn("db-identity-monitor: connectionPoolCleared listener threw", { error: String(err) });
    }
  };

  constructor(
    mongoClient: MonitoredMongoClient,
    rawDb: Db,
    writeGuard: WriteGuard,
    rawTelemetryCollection: Collection,
    opts: { instanceId: string; dbName: string; intervalMs?: number; retryDelayMs?: number },
  ) {
    this.mongoClient = mongoClient;
    this.rawDb = rawDb;
    this.writeGuard = writeGuard;
    this.rawTelemetryCollection = rawTelemetryCollection;
    this.expected = { instanceId: opts.instanceId, dbName: opts.dbName };
    this.intervalMs = opts.intervalMs ?? DbIdentityMonitor.INTERVAL_MS;
    this.retryDelayMs = opts.retryDelayMs ?? DbIdentityMonitor.RETRY_DELAY_MS;
  }

  /** Attach SDAM listeners + start the unref'd interval. Does NOT verify immediately — the boot check already verified. */
  start(): void {
    if (this.timer) return;

    this.mongoClient.on("serverDescriptionChanged", this.serverDescriptionChangedListener);
    this.mongoClient.on("topologyDescriptionChanged", this.topologyDescriptionChangedListener);
    this.mongoClient.on("connectionPoolCleared", this.connectionPoolClearedListener);

    this.timer = setInterval(() => {
      try {
        this.scheduleVerify("periodic");
        this.writeOnce().catch((err) =>
          log.warn("db-identity-monitor: periodic telemetry write failed", { error: String(err) }),
        );
      } catch (err) {
        log.warn("db-identity-monitor: periodic tick threw", { error: String(err) });
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Clear the interval and remove listeners. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.mongoClient.removeListener(
      "serverDescriptionChanged",
      this.serverDescriptionChangedListener as (...args: unknown[]) => void,
    );
    this.mongoClient.removeListener(
      "topologyDescriptionChanged",
      this.topologyDescriptionChangedListener as (...args: unknown[]) => void,
    );
    this.mongoClient.removeListener("connectionPoolCleared", this.connectionPoolClearedListener);
  }

  private onServerDescriptionChanged(e: NarrowedServerDescriptionChangedEvent): void {
    if (e.newDescription.type === "Unknown") return;

    const address = e.address;
    const processId = String(e.newDescription.topologyVersion?.processId ?? NO_PROCESS_ID);
    const previous = this.lastProcessIdByAddress.get(address);
    this.lastProcessIdByAddress.set(address, processId);

    if (previous === undefined) {
      // First observation of this address — seed silently, no trigger.
      return;
    }
    if (previous !== processId) {
      this.scheduleVerify("serverDescriptionChanged");
    }
  }

  private onTopologyDescriptionChanged(e: NarrowedTopologyDescriptionChangedEvent): void {
    const previousServers = e.previousDescription.servers;
    const newServers = e.newDescription.servers;
    for (const [address, newServer] of newServers) {
      const previousServer = previousServers.get(address);
      const wasUnknown = previousServer === undefined || previousServer.type === "Unknown";
      const isKnown = newServer.type !== "Unknown";
      if (wasUnknown && isKnown) {
        this.scheduleVerify("topologyDescriptionChanged");
        return;
      }
    }
  }

  /**
   * Entry point for every trigger. Never throws. Single-flight: if a
   * verification is already running, sets `dirty` so exactly one follow-up
   * run happens after the in-flight one settles.
   */
  private scheduleVerify(reason: string): void {
    try {
      if (this.inFlight) {
        this.dirty = true;
        this.dirtyReason = reason;
        return;
      }

      this.inFlight = this.verifyOnce(reason)
        .catch((err) => {
          // verifyOnce is expected to handle its own errors internally; this
          // terminal catch exists purely so nothing can escape as an
          // unhandled rejection (spec edge #10).
          log.warn("db-identity-monitor: verifyOnce rejected unexpectedly", { error: String(err), reason });
        })
        .then(() => {
          this.inFlight = null;
          if (this.dirty) {
            this.dirty = false;
            const nextReason = this.dirtyReason;
            this.scheduleVerify(nextReason);
          }
        });
    } catch (err) {
      log.warn("db-identity-monitor: scheduleVerify threw", { error: String(err), reason });
    }
  }

  /**
   * Single verification run, exposed for tests + used internally by
   * `scheduleVerify`. Includes the bounded retry grace on read failure.
   */
  async verifyOnce(reason: string): Promise<void> {
    this.lastTriggerReason = reason;

    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const result = await verifySentinel(this.rawDb, this.expected);
        this.verifyCount++;
        await this.applyResult(result, reason);
        return;
      } catch (err) {
        this.lastVerifyError = String(err instanceof Error ? err.message : err);

        if (attempt < DbIdentityMonitor.RETRY_ATTEMPTS) {
          await sleepUnref(this.retryDelayMs);
          continue;
        }

        // All retries exhausted.
        if (err instanceof MongoServerSelectionError) {
          // Server unreachable — driver writes are failing anyway, nothing
          // new to protect. State is left unchanged.
          await this.writeOnce();
          return;
        }

        // Server selectable but the sentinel read keeps failing — fail
        // closed: this is the "reachable but unverifiable" suspect state.
        // `this.observedInstanceId`/`this.observedDbName` are untouched on
        // this path, so the observed identity is definitionally unchanged.
        await this.transitionTo("cant_verify", reason, {
          sentinelPresent: this.sentinelPresent,
          observedInstanceId: this.observedInstanceId,
          observedDbName: this.observedDbName,
          observedSentinelId: this.observedSentinelId,
          observedChanged: false,
        });
        return;
      }
    }
  }

  private async applyResult(result: SentinelVerifyResult, reason: string): Promise<void> {
    // Capture the PREVIOUS observed identity before any mutation below, so
    // `observedChanged` reflects an actual before/after comparison instead
    // of comparing the post-mutation value against itself.
    const prevObserved = { instanceId: this.observedInstanceId, dbName: this.observedDbName };

    if (result.state === "verified") {
      this.lastVerifiedAt = new Date();
      this.sentinelPresent = true;
      this.observedInstanceId = result.observed.instanceId;
      this.observedDbName = result.observed.dbName;
      this.observedSentinelId = result.observed.sentinelId;

      if (result.schemaVersionNewer && !this.warnedSchemaVersionNewer) {
        this.warnedSchemaVersionNewer = true;
        log.warn("identity sentinel schemaVersion is newer than this engine expects", {
          expected: this.expected,
          observed: result.observed,
        });
      }

      const observedChanged =
        result.observed.instanceId !== prevObserved.instanceId || result.observed.dbName !== prevObserved.dbName;
      await this.transitionTo("verified", reason, {
        sentinelPresent: true,
        observedInstanceId: result.observed.instanceId,
        observedDbName: result.observed.dbName,
        observedSentinelId: result.observed.sentinelId,
        observedChanged,
      });
      return;
    }

    // mismatch (wrong identity, or absent-at-runtime).
    this.lastMismatchAt = new Date();
    this.sentinelPresent = result.sentinelPresent;
    this.observedInstanceId = result.observed?.instanceId ?? null;
    this.observedDbName = result.observed?.dbName ?? null;
    this.observedSentinelId = result.observed?.sentinelId ?? null;

    const observedChanged =
      this.observedInstanceId !== prevObserved.instanceId || this.observedDbName !== prevObserved.dbName;
    await this.transitionTo("mismatch", reason, {
      sentinelPresent: result.sentinelPresent,
      observedInstanceId: this.observedInstanceId,
      observedDbName: this.observedDbName,
      observedSentinelId: this.observedSentinelId,
      observedChanged,
    });
  }

  /**
   * Applies a new state, engaging/disengaging the write guard and logging
   * transitions exactly once (not per-tick) per spec §Log discipline.
   */
  private async transitionTo(
    next: IdentityState,
    reason: string,
    observed: {
      sentinelPresent: boolean;
      observedInstanceId: string | null;
      observedDbName: string | null;
      observedSentinelId: string | null;
      /**
       * Precomputed by the caller (`applyResult`/`verifyOnce`) BEFORE
       * `this.observed*` was mutated to the new values — comparing against
       * `this.observed*` here would always be false, since by the time
       * `transitionTo` runs the fields already hold the new (observed)
       * values (KPR-294 code-review fix).
       */
      observedChanged: boolean;
    },
  ): Promise<void> {
    const previous = this.state;
    const observedChanged = observed.observedChanged;
    this.state = next;

    if (next === "verified") {
      if (previous !== "verified") {
        this.writeGuard.disengage();
        log.info("identity re-verified — write refusal lifted", {
          expected: this.expected,
          observed: { instanceId: observed.observedInstanceId, dbName: observed.observedDbName },
          reason,
        });
      }
      await this.writeOnce();
      return;
    }

    if (next === "mismatch") {
      this.mismatchCount++;
      const observedForGuard = {
        instanceId: observed.observedInstanceId,
        dbName: observed.observedDbName,
      };
      this.writeGuard.engage(reason, observedForGuard);
      if (previous !== "mismatch" || observedChanged) {
        log.error("DB IDENTITY MISMATCH — refusing writes", {
          critical: true,
          expected: this.expected,
          observed: observedForGuard,
          reason,
        });
      }
      await this.writeOnce();
      return;
    }

    // cant_verify
    this.writeGuard.engage(reason, {
      instanceId: this.observedInstanceId,
      dbName: this.observedDbName,
    });
    if (previous !== "cant_verify") {
      log.error("DB IDENTITY cannot be verified — refusing writes", {
        critical: true,
        expected: this.expected,
        lastVerifyError: this.lastVerifyError,
        reason,
      });
    }
    await this.writeOnce();
  }

  /**
   * Telemetry upsert — exposed for tests + the initial write at startup
   * (family pattern, mirrors `SpawnCoordinatorHeartbeat.writeOnce`).
   * Best-effort: failures are caught and logged, never thrown.
   */
  async writeOnce(): Promise<void> {
    const stats: DbIdentityStats = {
      kind: DbIdentityMonitor.TELEMETRY_KIND,
      state: this.state,
      expectedInstanceId: this.expected.instanceId,
      expectedDbName: this.expected.dbName,
      sentinelPresent: this.sentinelPresent,
      observedInstanceId: this.observedInstanceId,
      observedDbName: this.observedDbName,
      observedSentinelId: this.observedSentinelId,
      writesRefused: this.writeGuard.engaged,
      refusedWriteCount: this.writeGuard.refusedWriteCount,
      verifyCount: this.verifyCount,
      mismatchCount: this.mismatchCount,
      lastVerifiedAt: this.lastVerifiedAt,
      lastMismatchAt: this.lastMismatchAt,
      lastVerifyError: this.lastVerifyError,
      lastTriggerReason: this.lastTriggerReason,
    };

    try {
      await this.rawTelemetryCollection.updateOne(
        { kind: DbIdentityMonitor.TELEMETRY_KIND },
        { $set: { ...stats, updatedAt: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      log.warn("db-identity-monitor: telemetry write failed", { error: String(err) });
    }
  }
}
