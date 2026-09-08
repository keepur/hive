import type { Collection, Db } from "mongodb";
import {
  type DeliveryReceiptRecord,
  type Occurrence,
  type Acknowledgement,
  receiptSchema,
  same,
  fail,
  parseStored,
} from "./types.js";
import { ObligationStore, assertWrite, duplicate, DURABLE_READ } from "./store.js";

export type HistoryAvailability = "none" | "present" | "expired" | "initial_write_pending" | "expired_unresolved";
export interface Evidence {
  occurrence: Occurrence;
  history: HistoryAvailability;
  confirmed: boolean;
}
export class ReceiptStore {
  readonly collection: Collection<DeliveryReceiptRecord>;
  constructor(
    readonly db: Db,
    readonly retentionDays?: number,
  ) {
    if (retentionDays !== undefined && (!Number.isFinite(retentionDays) || retentionDays <= 0))
      fail("invalid_retention");
    this.collection = db.collection<DeliveryReceiptRecord>("activity_log");
  }
  async init(): Promise<void> {
    if (this.retentionDays === undefined) return fail("retention_required");
    await this.collection.createIndex({ timestamp: 1 }, { expireAfterSeconds: this.retentionDays * 86400 });
    const partialFilterExpression = { recordKind: "delivery_receipt" };
    await this.collection.createIndex({ receiptId: 1 }, { unique: true, partialFilterExpression });
    await this.collection.createIndex({ obligationId: 1, dueAt: 1 }, { unique: true, partialFilterExpression });
    await this.collection.createIndex({ producerAgentId: 1, dueAt: -1 }, { partialFilterExpression });
    await this.retentionMs();
  }
  async retentionMs(): Promise<number> {
    const indexes = await this.collection.listIndexes().toArray();
    const ttl = indexes.find((i) => same(i.key, { timestamp: 1 }) && typeof i.expireAfterSeconds === "number");
    if (!ttl || ttl.expireAfterSeconds! <= 0) return fail("receipt_retention_unavailable");
    return ttl.expireAfterSeconds! * 1000;
  }
  record(o: Occurrence, a: Acknowledgement): DeliveryReceiptRecord {
    return receiptSchema.parse({
      recordKind: "delivery_receipt",
      receiptId: a.receiptId,
      obligationId: o.obligationId,
      dueAt: o.dueAt,
      producerAgentId: o.producerAgentId,
      destination: o.definition.destination,
      providerMessageTs: a.providerMessageTs,
      acknowledgedAt: a.acknowledgedAt,
      timestamp: a.timestamp,
      schemaVersion: 1,
    });
  }
  async exact(o: Occurrence, a: Acknowledgement): Promise<boolean> {
    const raw = await this.collection.findOne({ recordKind: "delivery_receipt", receiptId: a.receiptId }, DURABLE_READ);
    if (!raw) return false;
    const { _id: ignored, ...body } = raw;
    void ignored;
    if (!same(parseStored(receiptSchema, body), this.record(o, a))) return fail("evidence_integrity");
    return true;
  }
  async insert(o: Occurrence, a: Acknowledgement): Promise<void> {
    try {
      assertWrite(
        await this.collection.insertOne(this.record(o, a), {
          writeConcern: { w: "majority", wtimeoutMS: 5000 },
        }),
      );
    } catch (err) {
      // Includes commit-then-throw; never blindly report persistence.
      if (await this.exact(o, a)) return;
      if (duplicate(err)) return fail("evidence_integrity");
      throw err;
    }
  }
}
/** Both the sender and checker use this one serialized initial-write path. */
export async function reconcileReceipt(
  store: ObligationStore,
  receipts: ReceiptStore,
  id: string,
  clock: () => Date,
  repair: boolean,
): Promise<Evidence> {
  return store.withReceiptLock(id, async () => {
    const retentionMs = await receipts.retentionMs();
    let initialPersistence: DeliveryReceiptRecord | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const o = await store.occurrence(id),
        a = o.acknowledgement;
      if (!a) {
        if (o.delivery.state === "acknowledged" || ["on_time", "late"].includes(o.evaluation))
          return fail("evidence_integrity");
        const unexpected = await receipts.collection.findOne(
          {
            recordKind: "delivery_receipt",
            obligationId: o.obligationId,
            dueAt: o.dueAt,
            producerAgentId: o.producerAgentId,
            destination: o.definition.destination,
          },
          DURABLE_READ,
        );
        if (unexpected) return fail("evidence_integrity");
        if (repair && o.repairAt !== null) {
          await store.cas(o, { repairAt: null });
          continue;
        }
        return { occurrence: o, history: "none", confirmed: false };
      }
      if (
        o.delivery.state !== "acknowledged" ||
        a.receiptId !== o._id + "/receipt" ||
        a.providerMessageTs !== o.delivery.providerMessageTs ||
        !same(a.acknowledgedAt, o.delivery.acknowledgedAt)
      )
        return fail("evidence_integrity");
      const exists = await receipts.exact(o, a);
      if (exists) initialPersistence = receipts.record(o, a);
      // Sample after acquiring the queue and finishing all eligibility reads.
      // No await separates this decision from submission of an initial insert.
      const now = clock();
      const expired = now.getTime() - a.timestamp.getTime() >= retentionMs;
      if (a.receiptWriteState === "persisted") {
        if (!exists && !expired) return fail("evidence_integrity");
        if (repair && o.repairAt !== null) {
          await store.cas(o, { repairAt: null });
          continue;
        }
        return { occurrence: o, history: exists ? "present" : "expired", confirmed: true };
      }
      if (a.receiptWriteState === "expired_unresolved") {
        if (repair && o.repairAt !== null) {
          await store.cas(o, { repairAt: null });
          continue;
        }
        return {
          occurrence: o,
          history: "expired_unresolved",
          confirmed: o.evaluation === "on_time" || o.evaluation === "late",
        };
      }
      if (!repair) {
        return {
          occurrence: o,
          history: expired && !exists ? "expired_unresolved" : "initial_write_pending",
          confirmed: false,
        };
      }
      if (!initialPersistence && !expired) {
        await receipts.insert(o, a);
        initialPersistence = receipts.record(o, a);
      }
      // Preserve acknowledged insertion proof across CAS contention, even if
      // TTL removes history while an unrelated occurrence revision is updated.
      const nextState = same(initialPersistence, receipts.record(o, a)) ? "persisted" : "expired_unresolved";
      try {
        if (
          await store.cas(o, {
            acknowledgement: { ...a, receiptWriteState: nextState },
            repairAt: null,
            checkAt: clock(),
          })
        )
          continue;
      } catch {
        const latest = await store.occurrence(id);
        if (same(latest.acknowledgement, { ...a, receiptWriteState: nextState })) continue;
        return fail("storage_unavailable");
      }
    }
    return fail("state_contention");
  });
}
