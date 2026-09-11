import type { Collection, Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import {
  OPS_EVENTS_COLLECTION,
  OPS_REASONS_COLLECTION,
  OPS_SUBSCRIPTIONS_COLLECTION,
  type OpsEvent,
  type OpsReason,
  type OpsSubscription,
} from "./types.js";
import { auditReasonRow, compileDetailSchema } from "./reasons.js";
import { clipForLog } from "./ids.js";
import type { z } from "zod";

const log = createLogger("ops-store");

export interface LoadedReason {
  row: OpsReason;
  detailSchema: z.ZodType<Record<string, unknown>>;
}

export class OpsStore {
  readonly events: Collection<OpsEvent>;
  readonly subscriptions: Collection<OpsSubscription>;
  readonly reasons: Collection<OpsReason & { _id: string }>;

  constructor(
    private readonly db: Db,
    private readonly retentionDays: number,
  ) {
    this.events = db.collection<OpsEvent>(OPS_EVENTS_COLLECTION);
    this.subscriptions = db.collection<OpsSubscription>(OPS_SUBSCRIPTIONS_COLLECTION);
    this.reasons = db.collection<OpsReason & { _id: string }>(OPS_REASONS_COLLECTION);
  }

  /**
   * D10: index creation is INDIVIDUALLY CONTAINED and a fault does NOT
   * prevent the publisher from being set. Every index here is on the
   * MeetingScribe side of the engine's own line (index.ts:456) rather than
   * the MeetingWorkerPool side: the two epoch-read indexes and the cursor
   * index are performance (a collection scan returns the same answer), the
   * TTL index is housekeeping, and ops_reasons uniqueness is already
   * structural because _id is "<producer>:<reasonId>" — the unique index
   * restates it rather than establishing it.
   *
   * Returns the number of index failures, for the counter.
   */
  async ensureIndexes(): Promise<number> {
    let failures = 0;
    const create = async (label: string, run: () => Promise<unknown>, remedy?: string) => {
      try {
        await run();
      } catch (err) {
        failures += 1;
        log.warn("ops index creation failed — continuing without it", {
          index: label,
          error: String(err),
          ...(remedy ? { remedy } : {}),
        });
      }
    };

    // D8's condition-side epoch read. `_id` is a KEY rather than an
    // afterthought: the resolver's comparison is the compound
    // (publishedAt, _id) order, which this index then COVERS instead of
    // forcing an in-memory sort.
    await create("ops_events.condition-epoch", () =>
      this.events.createIndex({
        producer: 1,
        "subject.kind": 1,
        "subject.id": 1,
        reasonId: 1,
        publishedAt: -1,
        _id: -1,
      }),
    );
    // D8's clearing-side epoch read, in the same order the resolver compares.
    //
    // ⚠ NO `sparse: true`. It was here and it was a NO-OP: a compound sparse
    // index omits a document only when it is missing EVERY indexed field, and
    // `publishedAt`/`_id` are present on every row, so all rows were indexed
    // regardless. Removing it changes nothing and stops the option claiming
    // something the index does not do. `partialFilterExpression:
    // { clearsFamily: { $exists: true } }` WOULD express the apparent intent
    // and was declined: it makes the clearing-side read depend on the planner
    // proving the query predicate a subset of the filter, and a planner that
    // declines degrades D8's per-failure read to a collection scan — trading a
    // correct-but-larger index for a possible full scan, against an index-size
    // problem nothing has reported on a collection that already carries a TTL
    // and four other indexes over the same rows.
    await create("ops_events.clearing-epoch", () =>
      this.events.createIndex({ clearsFamily: 1, publishedAt: -1, _id: -1 }),
    );
    // D2: NOT unique — the log appends every publish.
    await create("ops_events.dedupe", () => this.events.createIndex({ dedupeKey: 1, publishedAt: -1 }));
    // D12's cursor order. Created here because D12 assigns ops_events and its
    // indexes to this producer.
    //
    // ⚠ DO NOT CONSOLIDATE this with the TTL index below. They share a prefix,
    // which reliably invites a "the second is redundant" cleanup — it is not.
    // A TTL index must be SINGLE-FIELD (MongoDB refuses expireAfterSeconds on
    // a compound index), so the cursor index cannot carry the TTL; and
    // dropping the cursor index in favour of the TTL one costs D12's reader
    // its covered (publishedAt, _id) sort. Neither is a subset of the other in
    // any sense that matters.
    await create("ops_events.cursor", () => this.events.createIndex({ publishedAt: 1, _id: 1 }));
    // D9: aligned with existing activity-history retention.
    //
    // This is the index-fault case that actually happens: createIndex throws
    // IndexOptionsConflict when the index already exists with a DIFFERENT
    // expireAfterSeconds — i.e. on the first boot after an operator changes
    // config.activity.retentionDays. A retention change must NOT silently
    // switch off failure recording, so this is contained and counted like the
    // rest, and the warning names the remedy.
    await create(
      "ops_events.ttl",
      () => this.events.createIndex({ publishedAt: 1 }, { expireAfterSeconds: this.retentionDays * 86_400 }),
      `retention changed? drop the ops_events publishedAt TTL index (or collMod it to ${this.retentionDays * 86_400}s) and restart`,
    );
    await create("ops_subscriptions.enabled", () => this.subscriptions.createIndex({ enabled: 1 }));
    await create("ops_reasons.unique", () => this.reasons.createIndex({ producer: 1, reasonId: 1 }, { unique: true }));
    return failures;
  }

  /**
   * D5: upsert the code-resident rows, writing every field EXCEPT `enabled`,
   * which is $setOnInsert — so an operator who disabled a reason keeps it
   * disabled across upgrades, and a code change to a template or an
   * allow-list still lands. `enabled: false` + restart is this ticket's
   * entire kill switch.
   *
   * The array's ORDER is contract (reasons.ts) — clearing reason first.
   * A throw here propagates: D10 requires a registry fault to leave the
   * publisher UNSET, because a wired-but-registryless publisher would spend
   * the rejection counter — D9's mis-integrated-producer signal — on what is
   * actually a Mongo outage.
   */
  async upsertReasons(rows: readonly OpsReason[]): Promise<void> {
    // ⚠ `assertReasonTableLegal` is deliberately NOT called here. It runs in
    // the OpsPublisher CONSTRUCTOR, which chunk 4 executes OUTSIDE its
    // `try { await opsPublisher.init() } catch`. Called from here it would sit
    // inside that catch, and D10's one loud failure mode would degrade to the
    // warn-and-unset posture of a Mongo outage — an unclearable-reason table,
    // a development defect, indistinguishable in the log from a database blip.
    // D5: the gate is "untouched by D10's rule that init()'s I/O is non-fatal".
    for (const row of rows) {
      const { enabled, ...rest } = row;
      await this.reasons.updateOne(
        { _id: `${row.producer}:${row.reasonId}` },
        { $set: rest, $setOnInsert: { enabled } },
        { upsert: true },
      );
    }
  }

  /**
   * D5: the accept path resolves rows from THE COLLECTION, never from the
   * code-resident table. That is what makes the kill switch work, and what
   * lets a row this code does not contain — a second reason added later as
   * data, or an out-of-engine producer's (D4, AC16) — take effect at the next
   * boot with no engine change. There is NO periodic reload: the map is built
   * once, in init(), so restart is the lever.
   *
   * The per-row `auditReasonRow` call is the DIAGNOSTIC half of the data-
   * sourced path (reasons.ts). `compileDetailSchema` normalizes three things
   * silently — an over-ceiling maxLength, an unrecognized type, an unbounded
   * key NAME — all failing closed, so behaviour is contract-conformant either
   * way; without this loop the operator's only signal is the generic rejection
   * counter, which D9 reserves for a mis-integrated PRODUCER. Warn and count,
   * never refuse: refusing would let one operator row disable publishing.
   *
   * ⚠ THE PER-ROW try/catch IS THAT RULE, not belt-and-braces. `OpsReason` is a
   * compile-time claim about a runtime document and nothing validates the
   * shape a row arrives in: `ops_reasons` is operator- and foreign-producer-
   * writable BY DESIGN (D4 — "adding a reason is a row"; AC16 inserts foreign
   * rows directly), and both calls below iterate `row.detailKeys` with
   * `for…of`, so a row whose `detailKeys` is missing, null or a non-array
   * object throws `TypeError: … is not iterable`. Uncontained that throw
   * leaves `loadReasons`, leaves `init()`, is caught by index.ts as an init
   * failure and leaves the publisher UNSET — every tool failure and recovery
   * on both lanes unrecorded for the whole boot, behind a log line
   * indistinguishable from a Mongo outage. One malformed operator row must
   * cost that row, never the producer.
   */
  async loadReasons(): Promise<{ map: Map<string, LoadedReason>; anomalies: number }> {
    const map = new Map<string, LoadedReason>();
    let anomalies = 0;
    for (const row of await this.reasons.find({}).toArray()) {
      try {
        for (const anomaly of auditReasonRow(row)) {
          anomalies += 1;
          log.warn("ops reason row normalized — the row declares something this engine narrows", { anomaly });
        }
        map.set(`${row.producer}:${row.reasonId}`, { row, detailSchema: compileDetailSchema(row.detailKeys) });
      } catch (err) {
        // Counted on the SAME counter as the normalizations above: both mean
        // "a data-sourced row this engine could not take at face value", which
        // is the one thing an operator reading the snapshot acts on, and
        // neither is a `rejected` (D9's mis-integrated-producer signal).
        //
        // C13: the row's `_id` and nothing else — never the row body, whose
        // every field is operator-authored text of unbounded shape.
        anomalies += 1;
        log.warn("ops reason row unusable — skipped, the rest of the registry still loads", {
          id: clipForLog(row._id),
          error: String(err),
        });
      }
    }
    return { map, anomalies };
  }

  /** D9: refreshed on a 60 s timer and on SIGUSR1. A fault leaves the previous set in place. */
  async loadSubscriptions(): Promise<OpsSubscription[]> {
    return this.subscriptions.find({ enabled: true }).toArray();
  }
}
