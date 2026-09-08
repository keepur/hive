import { randomUUID } from "node:crypto";
import type { Collection, Db, Filter } from "mongodb";
import {
  type Admission,
  type Obligation,
  type Occurrence,
  type Registration,
  obligationSchema,
  occurrenceSchema,
  registrationSchema,
  definitionOf,
  occurrenceId,
  same,
  fail,
  cancelledAt,
  parseStored,
} from "./types.js";
import { windowStart } from "./deadlines.js";

const WRITE = { writeConcern: { w: "majority" as const, wtimeoutMS: 5000 } };
export const DURABLE_READ = {
  readConcern: { level: "majority" as const },
  readPreference: "primary" as const,
  maxTimeMS: 5000,
};
// All wrappers over the engine's one guarded Db share coordination. This
// never grants send authority; retained tokens and acknowledged CAS do that.
const coordination = new WeakMap<
  Db,
  {
    receiptTails: Map<string, Promise<void>>;
    activeDeliveries: Set<string>;
    activeNotices: Set<string>;
  }
>();
export function duplicate(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === 11000;
}
export function assertWrite(result: { acknowledged: boolean }): void {
  if (!result.acknowledged) fail("storage_unavailable");
}
export class ObligationStore {
  readonly definitions: Collection<Obligation>;
  readonly occurrences: Collection<Occurrence>;
  readonly telemetry: Collection;
  readonly activeDeliveries: Set<string>;
  readonly activeNotices: Set<string>;
  private readonly receiptTails: Map<string, Promise<void>>;
  constructor(readonly db: Db) {
    let shared = coordination.get(db);
    if (!shared) {
      shared = { receiptTails: new Map(), activeDeliveries: new Set(), activeNotices: new Set() };
      coordination.set(db, shared);
    }
    this.receiptTails = shared.receiptTails;
    this.activeDeliveries = shared.activeDeliveries;
    this.activeNotices = shared.activeNotices;
    this.definitions = db.collection<Obligation>("delivery_obligations");
    this.occurrences = db.collection<Occurrence>("delivery_obligation_occurrences");
    this.telemetry = db.collection("telemetry");
  }
  async withReceiptLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.receiptTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.receiptTails.set(id, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.receiptTails.get(id) === tail) this.receiptTails.delete(id);
    }
  }
  async init(): Promise<void> {
    await this.definitions.createIndex({ producerAgentId: 1, _id: 1 });
    await this.definitions.createIndex({ scanThrough: 1, _id: 1 });
    await this.occurrences.createIndex({ obligationId: 1, dueAt: 1 }, { unique: true });
    await this.occurrences.createIndex({ dueAt: 1, "notice.state": 1 });
    await this.occurrences.createIndex({ checkAt: 1, _id: 1 });
    await this.occurrences.createIndex({ repairAt: 1, _id: 1 });
    await this.occurrences.createIndex({ producerAgentId: 1, dueAt: 1, _id: 1 });
  }
  async get(id: string): Promise<Obligation | null> {
    const raw = await this.definitions.findOne({ _id: id }, DURABLE_READ);
    return raw ? parseStored(obligationSchema, raw) : null;
  }
  async occurrence(id: string): Promise<Occurrence> {
    const raw = await this.occurrences.findOne({ _id: id }, DURABLE_READ);
    if (!raw) return fail("occurrence_missing");
    return parseStored(occurrenceSchema, raw);
  }
  async register(input: unknown, now: Date): Promise<Obligation> {
    const def = registrationSchema.parse(input);
    const existing = await this.get(def._id);
    if (existing) {
      if (!same(definitionOf(existing), def)) return fail("definition_conflict");
      return existing;
    }
    const producer = await this.db
      .collection<{ _id: string }>("agent_definitions")
      .findOne({ _id: def.producerAgentId });
    if (!producer) return fail("unknown_producer");
    const row: Obligation = { ...def, activeFrom: now, createdAt: now, scanThrough: now };
    try {
      assertWrite(await this.definitions.insertOne(row, WRITE));
    } catch (err) {
      const observed = await this.get(def._id);
      if (observed && same(definitionOf(observed), def)) return observed;
      if (duplicate(err)) return fail("definition_conflict");
      throw err;
    }
    return row;
  }
  async deactivate(id: string, reason: string, now: Date): Promise<Obligation> {
    if (!reason.trim() || reason.trim().length > 300) return fail("invalid_reason");
    try {
      assertWrite(
        await this.definitions.updateOne(
          { _id: id, deactivatedAt: { $exists: false } },
          { $set: { deactivatedAt: now, deactivationReason: reason.trim() } },
          WRITE,
        ),
      );
    } catch (err) {
      // Commit-then-throw is resolved by the durable first cutoff.
      const observed = await this.get(id);
      if (!observed?.deactivatedAt) throw err;
      return observed;
    }
    return (await this.get(id)) ?? fail("unknown_obligation");
  }
  async materialize(o: Obligation, dueAt: Date): Promise<Occurrence> {
    const _id = occurrenceId(o._id, dueAt);
    const row: Occurrence = {
      _id,
      obligationId: o._id,
      producerAgentId: o.producerAgentId,
      dueAt,
      windowStart: windowStart(o, dueAt),
      definition: definitionOf(o),
      activeFrom: o.activeFrom,
      revision: 0,
      cancelled: cancelledAt(o, dueAt),
      delivery: { intentId: _id + "/delivery", state: "pending" },
      evaluation: "pending",
      checkAt: dueAt,
      repairAt: null,
    };
    assertWrite(await this.occurrences.updateOne({ _id }, { $setOnInsert: row }, { ...WRITE, upsert: true }));
    const found = await this.occurrence(_id);
    if (
      !same(found.definition, row.definition) ||
      !same(found.windowStart, row.windowStart) ||
      !same(found.activeFrom, row.activeFrom) ||
      !same(found.dueAt, dueAt) ||
      found.obligationId !== o._id ||
      found.producerAgentId !== o.producerAgentId
    ) {
      return fail("evidence_integrity");
    }
    return found;
  }
  async advance(o: Obligation, through: Date): Promise<void> {
    if (through <= o.scanThrough) return;
    assertWrite(
      await this.definitions.updateOne(
        { _id: o._id, scanThrough: o.scanThrough },
        { $max: { scanThrough: through } },
        WRITE,
      ),
    );
  }
  async cas(o: Occurrence, patch: Partial<Occurrence>): Promise<boolean> {
    const next = occurrenceSchema.parse({ ...o, ...patch, _id: o._id, revision: o.revision + 1 });
    const result = await this.occurrences.replaceOne({ _id: o._id, revision: o.revision }, next, WRITE);
    assertWrite(result);
    return result.matchedCount === 1;
  }
  async admit(o: Occurrence, bootId: string, claimToken = randomUUID()): Promise<Admission | null> {
    const a: Admission = {
      occurrenceId: o._id,
      dueAt: o.dueAt,
      intentId: o.delivery.intentId,
      claimToken,
      ownerBootId: bootId,
    };
    try {
      const result = await this.definitions.updateOne(
        {
          _id: o.obligationId,
          deliveryAdmission: { $exists: false },
          $or: [{ deactivatedAt: { $exists: false } }, { deactivatedAt: { $gte: o.dueAt } }],
        },
        { $set: { deliveryAdmission: a } },
        WRITE,
      );
      assertWrite(result);
      if (result.matchedCount === 1) return a;
    } catch {
      // An uncertain write never authorizes submission from local memory.
      const observed = await this.get(o.obligationId);
      if (same(observed?.deliveryAdmission, a)) return a;
      return null;
    }
    return null;
  }
  async release(obligationId: string, a: Admission): Promise<void> {
    assertWrite(
      await this.definitions.updateOne(
        {
          _id: obligationId,
          "deliveryAdmission.claimToken": a.claimToken,
          "deliveryAdmission.ownerBootId": a.ownerBootId,
        },
        { $unset: { deliveryAdmission: "" } },
        WRITE,
      ),
    );
  }
  async definitionsPage(filter: Filter<Obligation>, after: string | undefined, limit: number): Promise<Obligation[]> {
    const rows = await this.definitions
      .find(
        {
          $and: [filter, ...(after ? [{ _id: { $gt: after } }] : [])],
        },
        DURABLE_READ,
      )
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    return rows.map((v) => parseStored(obligationSchema, v));
  }
  async occurrencesPage(filter: Filter<Occurrence>, after: string | undefined, limit: number): Promise<Occurrence[]> {
    const rows = await this.occurrences
      .find(
        {
          $and: [filter, ...(after ? [{ _id: { $gt: after } }] : [])],
        },
        DURABLE_READ,
      )
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    return rows.map((v) => parseStored(occurrenceSchema, v));
  }
  async definitionFor(o: Occurrence): Promise<Obligation> {
    const d = (await this.get(o.obligationId)) ?? fail("definition_missing");
    if (
      !same(definitionOf(d), o.definition) ||
      !same(d.activeFrom, o.activeFrom) ||
      o._id !== occurrenceId(d._id, o.dueAt) ||
      o.obligationId !== d._id ||
      o.producerAgentId !== d.producerAgentId ||
      !same(windowStart(d, o.dueAt), o.windowStart) ||
      o.delivery.intentId !== o._id + "/delivery" ||
      (o.notice !== undefined && o.notice.intentId !== o._id + "/notice")
    ) {
      return fail("evidence_integrity");
    }
    return d;
  }
  async admittedOccurrence(d: Obligation): Promise<Occurrence | null> {
    const a = d.deliveryAdmission;
    if (!a) return null;
    const raw = await this.occurrences.findOne({ _id: a.occurrenceId }, DURABLE_READ);
    if (!raw) return fail("evidence_integrity");
    const o = parseStored(occurrenceSchema, raw);
    await this.definitionFor(o);
    if (
      o.obligationId !== d._id ||
      !same(o.dueAt, a.dueAt) ||
      o._id !== occurrenceId(d._id, a.dueAt) ||
      o.delivery.intentId !== a.intentId
    ) {
      return fail("evidence_integrity");
    }
    return o;
  }
}
export type { Registration };
