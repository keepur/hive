import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Db } from "mongodb";

/**
 * KPR-294 — DB identity sentinel contract + boot check + verify read.
 *
 * This module is intentionally pure/testable: no `process.exit`, no
 * process-lifecycle side effects. `index.ts` owns the fatal-exit decision
 * on a boot-time mismatch; this module only reports outcomes.
 *
 * `DbIdentityMonitor` (runtime SDAM-triggered re-verification) is added to
 * this file in Task 3 — not implemented here.
 */

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
