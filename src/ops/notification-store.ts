/**
 * KPR-468 D1/D2/D3: the acknowledgement ledger's collections, its nine
 * indexes, the D12 sweep cursor and the operator policy read.
 *
 * Shaped on src/obligations/store.ts. Every durable write carries the same
 * { w: "majority", wtimeoutMS: 5000 } that file uses (:20, receipts.ts:70,
 * sweeper.ts:374) — D3's durability ordering is only NOMINAL if the ledger
 * upserts run at the driver default and a majority-durable cursor can then
 * outlive the writes it claims to trail.
 */
import type { Collection, Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import {
  OPS_NOTIFICATIONS_COLLECTION,
  OPS_POLICY_COLLECTION,
  OPS_POLICY_ID,
  type OpsNotification,
  type OpsPolicy,
} from "./notification-types.js";

const log = createLogger("ops-notification-store");

export const WRITE = { writeConcern: { w: "majority" as const, wtimeoutMS: 5000 } };

/** D12's cursor: a position in ops_events's (publishedAt, _id) total order. */
export interface SweepCursor {
  publishedAt: Date;
  /** The event's `_id` hex string, or null for a clock-initialized cursor. */
  eventId: string | null;
}

export const SWEEP_CURSOR_KIND = "ops_sweep_cursor";
export const NOTIFIER_STATS_KIND = "ops_notifier_stats";

export class OpsNotificationStore {
  readonly notifications: Collection<OpsNotification>;
  readonly policy: Collection<OpsPolicy>;
  /**
   * D3: the cursor and the heartbeat are SEPARATE documents in the same
   * engine-written, TTL-free, upserted-per-kind collection, so overwriting
   * stats can never clobber the cursor.
   */
  readonly telemetry: Collection;

  constructor(db: Db) {
    this.notifications = db.collection<OpsNotification>(OPS_NOTIFICATIONS_COLLECTION);
    this.policy = db.collection<OpsPolicy>(OPS_POLICY_COLLECTION);
    this.telemetry = db.collection("telemetry");
  }

  /**
   * D2/D10. The posture is SPLIT and differs from KPR-454's blanket one by
   * exactly one line: the (subscriptionId, dedupeKey) UNIQUE index carries a
   * CORRECTNESS role — it is the only thing preventing two rows for one
   * condition under a racing insert, and it is what makes D4's
   * conditional-update-then-insert a race DETECTOR rather than a duplicate
   * factory — so its failure leaves the notifier UNSTARTED and the singleton
   * UNSET (D10). Every other index is performance or housekeeping and is
   * contained individually.
   *
   * NO INDEX HERE IS `sparse`, and that is a correction rather than an
   * omission: a COMPOUND sparse index over ascending keys indexes a document
   * containing AT LEAST ONE of the keys, so {stalledReason, state} and
   * {lastOutcome, state} would index every row (every row has `state`) and
   * {forceDeliver, nextNudgeAt} would index every working row. What actually
   * delivers every boundedness property claimed in D2 is the EQUALITY BOUND ON
   * THE LEADING KEY plus MongoDB's type bracketing. `partialFilterExpression`
   * would deliver what `sparse` was claimed to and is declined for one
   * measured reason: under the shipped default every working row is
   * cadence-stalled and every attempted row carries a lastOutcome, so the set
   * it would exclude is nearly empty in the deployment that matters.
   */
  async ensureIndexes(): Promise<{ uniqueOk: boolean; failures: number }> {
    let failures = 0;
    let uniqueOk = true;
    const create = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        failures += 1;
        log.warn("ops notification index creation failed — continuing without it", {
          index: label,
          error: String(err),
        });
      }
    };

    // 1. Row identity. The duplicate-key error IS the race detector (D4).
    try {
      await this.notifications.createIndex({ subscriptionId: 1, dedupeKey: 1 }, { unique: true });
    } catch (err) {
      uniqueOk = false;
      failures += 1;
      log.error("ops_notifications identity index failed — the notifier will not start", { error: String(err) });
    }
    // 2. Clearing application fans out across every subscription holding the
    //    key, so it cannot use the compound index above.
    await create("ops_notifications.dedupe", () => this.notifications.createIndex({ dedupeKey: 1 }));
    // 3. Delivery ARM 1 — the guaranteed first delivery. Equality on
    //    attemptCount: 0 means an already-attempted row is not in this index's
    //    scanned prefix AT ALL, which is what makes arm 1 structurally immune
    //    to a stall backlog rather than merely ordered ahead of one.
    await create("ops_notifications.arm1", () =>
      this.notifications.createIndex({ state: 1, attemptCount: 1, nextNudgeAt: 1 }),
    );
    // 4. Delivery ARM 2 — the two non-cadence re-delivery triggers. The
    //    equality bound on forceDeliver: true confines the scan; the
    //    cadence-stall backlog carries no forceDeliver at all (step 5 consumes
    //    it), so it is not in this bucket. The absent `state` key is NOT an
    //    omission: no NON-WORKING row carries a nextNudgeAt (D5's scoping of
    //    the never-unset rule), so this index's range holds only
    //    pending/delivered rows by type bracketing rather than by a filter.
    await create("ops_notifications.arm2", () => this.notifications.createIndex({ forceDeliver: 1, nextNudgeAt: 1 }));
    // 5. Delivery ARM 3 — ordinary cadence nudges.
    await create("ops_notifications.arm3", () => this.notifications.createIndex({ state: 1, nextNudgeAt: 1 }));
    // 6. The three standing stall gauges, as bounded saturating counts.
    //    `state` is IN THE INDEX rather than a residual filter over it because
    //    a saturating `limit` over a residual filter does not saturate — it
    //    scans until it has found `limit` matches.
    await create("ops_notifications.stallGauge", () => this.notifications.createIndex({ stalledReason: 1, state: 1 }));
    // 7. The rowsUnknownOutcome gauge. REQUIRED rather than nice: without it
    //    this is an unindexed collection scan on every 30 s tick over a ledger
    //    whose working-state rows never TTL.
    await create("ops_notifications.unknownGauge", () => this.notifications.createIndex({ lastOutcome: 1, state: 1 }));
    // 8. The snooze-expiry scan.
    await create("ops_notifications.snooze", () => this.notifications.createIndex({ state: 1, snoozedUntil: 1 }));
    // 9. D9's state-dependent retention. A TTL on `stateAt` would delete
    //    WORKING rows; the conditional lives in the field, not the index.
    await create("ops_notifications.ttl", () =>
      this.notifications.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    );
    return { uniqueOk, failures };
  }

  /**
   * D3. `null` means no cursor exists; a storage fault THROWS and is the
   * CALLER's to contain — and the caller that contains it is named: chunk 3's
   * `OpsNotifier.run()` wraps its whole phase-and-gauge body so that a throw
   * from here (or from any other uncontained read: the ingest page `find`, the
   * six gauge counts) still attempts a best-effort `state: "degraded"`
   * heartbeat. Without that wrap this method's contract would be satisfied and
   * the spec's "Mongo unavailable for a tick ⇒ heartbeat degraded, no throw"
   * row would still be unsatisfiable.
   */
  async readCursor(): Promise<SweepCursor | null> {
    const doc = await this.telemetry.findOne({ kind: SWEEP_CURSOR_KIND });
    if (!doc || !(doc.publishedAt instanceof Date)) return null;
    return { publishedAt: doc.publishedAt, eventId: typeof doc.eventId === "string" ? doc.eventId : null };
  }

  async writeCursor(cursor: SweepCursor): Promise<void> {
    await this.telemetry.updateOne(
      { kind: SWEEP_CURSOR_KIND },
      { $set: { kind: SWEEP_CURSOR_KIND, publishedAt: cursor.publishedAt, eventId: cursor.eventId } },
      { upsert: true, ...WRITE },
    );
  }

  /**
   * D5. `findOne → null` (nothing registered) and `findOne → throw` (a
   * transient storage fault) are DISTINGUISHABLE at the driver and must stay
   * so: resolving a throw as "no policy" would mark every working row
   * cadence-stalled on that tick and turn a two-second Mongo blip into a full
   * re-check interval of silence for every subscriber. The throw propagates.
   */
  async readPolicy(): Promise<OpsPolicy | null> {
    return this.policy.findOne({ _id: OPS_POLICY_ID });
  }

  async writeHeartbeat(doc: Record<string, unknown>): Promise<void> {
    await this.telemetry.updateOne(
      { kind: NOTIFIER_STATS_KIND },
      { $set: { kind: NOTIFIER_STATS_KIND, ...doc } },
      { upsert: true, ...WRITE },
    );
  }
}

/** The duplicate-key signal D4 step 2 depends on. */
export function isDuplicateKey(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { code?: unknown }).code === 11000;
}
