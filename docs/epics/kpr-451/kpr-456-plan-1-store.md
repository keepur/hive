# KPR-456 plan chunk 1 — contracts, recurrence and stores

Parent: [implementation plan](kpr-456-plan.md). Apply the following complete new files; their interfaces are consumed unchanged by later chunks.

## Task 1: Strict inputs and retained occurrence contracts

**Create:** src/obligations/types.ts
**Modify:** src/activity/types.ts
**Test:** src/obligations/deadlines.test.ts, src/obligations/obligations.integration.test.ts

- [ ] Create src/obligations/types.ts with this code.

~~~typescript
import { z } from "zod";

export const idSchema = z.string().regex(/^[a-z0-9-]{1,100}$/);
const label = (max: number) => z.string().trim().min(1).max(max);
export const destinationSchema = z.object({
  kind: z.literal("slack"),
  channelId: z.string().regex(/^[CDG][A-Z0-9]{8,31}$/),
  threadTs: z.string().max(100).regex(/^\d{10,}\.\d{6}$/).optional(),
}).strict();
export const deadlineSchema = z.object({
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, "duplicate_weekday")
    .transform((days) => [...days].sort()),
  timezone: z.string().max(100).refine((zone) => {
    if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(zone)) return false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0); return true; }
    catch { return false; }
  }, "invalid_timezone"),
}).strict();
export const registrationSchema = z.object({
  _id: idSchema,
  deliverable: label(200),
  producerAgentId: label(100),
  deadline: deadlineSchema,
  destination: destinationSchema,
  noticeDestination: destinationSchema,
  createdBy: label(100),
}).strict();
export type Registration = z.infer<typeof registrationSchema>;
export type Destination = z.infer<typeof destinationSchema>;
export type Deadline = z.infer<typeof deadlineSchema>;
export const admissionSchema = z.object({
  occurrenceId: z.string().max(150),
  dueAt: z.date(),
  intentId: z.string().max(180),
  claimToken: z.string().uuid(),
  ownerBootId: z.string().uuid(),
}).strict();
export type Admission = z.infer<typeof admissionSchema>;
export const obligationSchema = registrationSchema.extend({
  activeFrom: z.date(),
  createdAt: z.date(),
  scanThrough: z.date(),
  deactivatedAt: z.date().optional(),
  deactivationReason: label(300).optional(),
  deliveryAdmission: admissionSchema.optional(),
}).strict();
export type Obligation = z.infer<typeof obligationSchema>;
export const reasonSchema = z.enum([
  "authoritative_refusal", "rate_limited", "unconfirmed_response",
  "interrupted_attempt", "identity_unverified", "storage_unavailable",
  "evidence_integrity", "content_invalid", "unavailable",
]);
export const attemptSchema = z.object({
  intentId: z.string().max(180),
  state: z.enum(["pending", "sending", "acknowledged", "rejected", "unknown"]),
  claimToken: z.string().uuid().optional(),
  ownerBootId: z.string().uuid().optional(),
  startedAt: z.date().optional(),
  acknowledgedAt: z.date().optional(),
  providerMessageTs: z.string().min(1).max(100).optional(),
  reason: reasonSchema.optional(),
  retryAt: z.date().optional(),
}).strict().superRefine((attempt, ctx) => {
  if (attempt.state !== "pending" && (!attempt.claimToken || !attempt.ownerBootId)) {
    ctx.addIssue({ code: "custom", message: "missing_attempt_identity" });
  }
  if (attempt.state === "acknowledged" && (!attempt.acknowledgedAt || !attempt.providerMessageTs)) {
    ctx.addIssue({ code: "custom", message: "missing_acknowledgement" });
  }
});
export type Attempt = z.infer<typeof attemptSchema>;
export const acknowledgementSchema = z.object({
  receiptId: z.string().max(180),
  providerMessageTs: z.string().min(1).max(100),
  acknowledgedAt: z.date(),
  timestamp: z.date(),
  receiptWriteState: z.enum(["pending", "persisted", "expired_unresolved"]),
}).strict();
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;
export const occurrenceSchema = z.object({
  _id: z.string().max(150),
  obligationId: idSchema,
  producerAgentId: label(100),
  dueAt: z.date(),
  windowStart: z.date(),
  definition: registrationSchema,
  activeFrom: z.date(),
  revision: z.number().int().nonnegative(),
  cancelled: z.boolean(),
  delivery: attemptSchema,
  acknowledgement: acknowledgementSchema.optional(),
  notice: attemptSchema.optional(),
  evaluation: z.enum(["pending", "on_time", "late", "no_confirmed_delivery",
    "evidence_incomplete", "integrity_error"]),
  evaluatedAt: z.date().optional(),
  checkAt: z.date().nullable(),
  repairAt: z.date().nullable(),
}).strict();
export type Occurrence = z.infer<typeof occurrenceSchema>;
export const receiptSchema = z.object({
  recordKind: z.literal("delivery_receipt"),
  receiptId: z.string().max(180),
  obligationId: idSchema,
  dueAt: z.date(),
  producerAgentId: label(100),
  destination: destinationSchema,
  providerMessageTs: z.string().min(1).max(100),
  acknowledgedAt: z.date(),
  timestamp: z.date(),
  schemaVersion: z.literal(1),
}).strict();
export type DeliveryReceiptRecord = z.infer<typeof receiptSchema>;
export const deliveryInputSchema = z.object({
  obligationId: idSchema,
  dueAt: z.string().datetime({ offset: false }),
  text: z.string().min(1).max(3900).refine((text) => text.trim().length > 0),
}).strict();
export const discoveryInputSchema = z.object({
  section: z.enum(["definitions", "overdue"]).default("definitions"),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
export interface DeliveryCapability {
  discover(agentId: string, input: unknown): Promise<unknown>;
  deliver(agentId: string, input: unknown): Promise<unknown>;
}
export class ObligationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ObligationError"; }
}
export function fail(code: string): never { throw new ObligationError(code); }
export function parseStored<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value); } catch { return fail("evidence_integrity"); }
}
export function occurrenceId(id: string, dueAt: Date): string {
  return id + "/" + dueAt.toISOString();
}
export function definitionOf(o: Obligation): Registration {
  return {
    _id: o._id, deliverable: o.deliverable, producerAgentId: o.producerAgentId,
    deadline: o.deadline, destination: o.destination,
    noticeDestination: o.noticeDestination, createdBy: o.createdBy,
  };
}
export function cancelledAt(o: Obligation, dueAt: Date): boolean {
  return o.deactivatedAt !== undefined && dueAt > o.deactivatedAt;
}
export function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    const keys = Object.keys(x).filter((k) => x[k] !== undefined).sort();
    return same(keys, Object.keys(y).filter((k) => y[k] !== undefined).sort())
      && keys.every((k) => same(x[k], y[k]));
  }
  return a === b;
}
~~~

The occurrence's checkAt/repairAt are bounded-work scheduling fields, not TTL or human workflow state. A cancelled expectation and acknowledged delivery may coexist.

- [ ] Append the following to src/activity/types.ts. Existing ActivityRecord fields and existing record() callers stay unchanged.

~~~typescript
/** Legacy documents without recordKind remain turn records. */
export type { DeliveryReceiptRecord } from "../obligations/types.js";
export type ActivityDocument =
  | (ActivityRecord & { recordKind?: "turn" })
  | import("../obligations/types.js").DeliveryReceiptRecord;

export const TURN_ACTIVITY_FILTER = { recordKind: { $ne: "delivery_receipt" } } as const;
~~~

## Task 2: One shared deadline evaluator

**Create:** src/obligations/deadlines.ts

- [ ] Add this complete implementation.

~~~typescript
import type { Deadline, Obligation } from "./types.js";
import { fail } from "./types.js";

const MINUTE = 60_000;
const SEARCH_MINUTES = 16 * 24 * 60;
const formatters = new Map<string, Intl.DateTimeFormat>();
const week = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit",
      hourCycle: "h23",
    });
    // Bounded cache; registration itself has no artificial count limit.
    if (formatters.size >= 100) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, f);
  }
  return f;
}
export function matches(rule: Deadline, date: Date): boolean {
  if (!Number.isFinite(date.getTime()) || date.getTime() % MINUTE !== 0) return false;
  const p = Object.fromEntries(formatter(rule.timezone).formatToParts(date).map((v) => [v.type, v.value]));
  return p.hour + ":" + p.minute === rule.localTime && rule.weekdays.includes(week.indexOf(p.weekday!));
}
export function adjacent(rule: Deadline, instant: Date, direction: 1 | -1): Date {
  let ms = direction === 1
    ? Math.floor(instant.getTime() / MINUTE) * MINUTE + MINUTE
    : Math.ceil(instant.getTime() / MINUTE) * MINUTE - MINUTE;
  for (let i = 0; i < SEARCH_MINUTES; i++, ms += direction * MINUTE) {
    const d = new Date(ms);
    if (matches(rule, d)) return d;
  }
  return fail("deadline_search_exhausted");
}
/** At most budget UTC minutes; through moves only across examined instants. */
export function scan(rule: Deadline, from: Date, to: Date, budget = 1440): {
  due: Date[]; through: Date;
} {
  if (!Number.isInteger(budget) || budget < 1) return fail("invalid_scan_budget");
  if (to <= from) return { due: [], through: from };
  const due: Date[] = [];
  let ms = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE;
  let examined = 0;
  let through = from;
  while (ms <= to.getTime() && examined < budget) {
    const date = new Date(ms);
    if (matches(rule, date)) due.push(date);
    through = date;
    examined++;
    ms += MINUTE;
  }
  if (ms > to.getTime()) through = to;
  return { due, through };
}
export function windowStart(o: Obligation, dueAt: Date): Date {
  if (dueAt <= o.activeFrom || !matches(o.deadline, dueAt)) return fail("invalid_occurrence");
  return new Date(Math.max(adjacent(o.deadline, dueAt, -1).getTime(), o.activeFrom.getTime()));
}
export function currentDue(o: Obligation, now: Date): Date | null {
  // The lower bound is exclusive. Exactly at a deadline, that occurrence
  // remains current; one millisecond later the next window is open.
  if (now <= o.activeFrom) return null;
  const due = matches(o.deadline, now) ? now : adjacent(o.deadline, now, 1);
  return o.deactivatedAt && due > o.deactivatedAt ? null : due;
}
export function localDeadline(o: Pick<Obligation, "deadline">, date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: o.deadline.timezone, dateStyle: "medium", timeStyle: "long",
  }).format(date) + " [" + o.deadline.timezone + "]";
}
~~~

Registration/current lookup/backfill/explicit delivery all call this evaluator. UTC minute matching intentionally yields two distinct fold instants and no skipped-gap occurrence. SEARCH_MINUTES bounds next/previous lookup, including a weekly rule skipped once by a DST gap. Failure is explicit; never silently invent a deadline.

## Task 3: Acknowledged, guarded Mongo state transitions

**Create:** src/obligations/store.ts

- [ ] Add this complete implementation. Every store receives the existing guarded Db. Read construction has no side effects; only init() creates indexes.

~~~typescript
import { randomUUID } from "node:crypto";
import type { Collection, Db, Filter } from "mongodb";
import {
  type Admission, type Obligation, type Occurrence, type Registration,
  obligationSchema, occurrenceSchema, registrationSchema, definitionOf,
  occurrenceId, same, fail, cancelledAt, parseStored,
} from "./types.js";
import { windowStart } from "./deadlines.js";

const WRITE = { writeConcern: { w: "majority" as const, wtimeoutMS: 5000 } };
export const DURABLE_READ = {
  readConcern: { level: "majority" as const },
  readPreference: "primary" as const, maxTimeMS: 5000,
};
// All wrappers over the engine's one guarded Db share coordination. This
// never grants send authority; retained tokens and acknowledged CAS do that.
const coordination = new WeakMap<Db, {
  receiptTails: Map<string, Promise<void>>;
  activeDeliveries: Set<string>;
  activeNotices: Set<string>;
}>();
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
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.receiptTails.set(id, tail);
    await previous;
    try { return await run(); }
    finally {
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
    const producer = await this.db.collection<{ _id: string }>("agent_definitions").findOne({ _id: def.producerAgentId });
    if (!producer) return fail("unknown_producer");
    const row: Obligation = { ...def, activeFrom: now, createdAt: now, scanThrough: now };
    try { assertWrite(await this.definitions.insertOne(row, WRITE)); }
    catch (err) {
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
      assertWrite(await this.definitions.updateOne(
        { _id: id, deactivatedAt: { $exists: false } },
        { $set: { deactivatedAt: now, deactivationReason: reason.trim() } }, WRITE,
      ));
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
      _id, obligationId: o._id, producerAgentId: o.producerAgentId,
      dueAt, windowStart: windowStart(o, dueAt), definition: definitionOf(o),
      activeFrom: o.activeFrom, revision: 0, cancelled: cancelledAt(o, dueAt),
      delivery: { intentId: _id + "/delivery", state: "pending" },
      evaluation: "pending", checkAt: dueAt, repairAt: null,
    };
    assertWrite(await this.occurrences.updateOne(
      { _id }, { $setOnInsert: row }, { ...WRITE, upsert: true },
    ));
    const found = await this.occurrence(_id);
    if (!same(found.definition, row.definition) || !same(found.windowStart, row.windowStart)
      || !same(found.activeFrom, row.activeFrom) || !same(found.dueAt, dueAt)
      || found.obligationId !== o._id || found.producerAgentId !== o.producerAgentId) {
      return fail("evidence_integrity");
    }
    return found;
  }
  async advance(o: Obligation, through: Date): Promise<void> {
    if (through <= o.scanThrough) return;
    assertWrite(await this.definitions.updateOne(
      { _id: o._id, scanThrough: o.scanThrough },
      { $max: { scanThrough: through } }, WRITE,
    ));
  }
  async cas(o: Occurrence, patch: Partial<Occurrence>): Promise<boolean> {
    const next = occurrenceSchema.parse({ ...o, ...patch, _id: o._id, revision: o.revision + 1 });
    const result = await this.occurrences.replaceOne({ _id: o._id, revision: o.revision }, next, WRITE);
    assertWrite(result);
    return result.matchedCount === 1;
  }
  async admit(o: Occurrence, bootId: string, claimToken = randomUUID()): Promise<Admission | null> {
    const a: Admission = {
      occurrenceId: o._id, dueAt: o.dueAt, intentId: o.delivery.intentId,
      claimToken, ownerBootId: bootId,
    };
    try {
      const result = await this.definitions.updateOne({
        _id: o.obligationId, deliveryAdmission: { $exists: false },
        $or: [{ deactivatedAt: { $exists: false } }, { deactivatedAt: { $gte: o.dueAt } }],
      }, { $set: { deliveryAdmission: a } }, WRITE);
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
    assertWrite(await this.definitions.updateOne({
      _id: obligationId, "deliveryAdmission.claimToken": a.claimToken,
      "deliveryAdmission.ownerBootId": a.ownerBootId,
    }, { $unset: { deliveryAdmission: "" } }, WRITE));
  }
  async definitionsPage(filter: Filter<Obligation>, after: string | undefined, limit: number): Promise<Obligation[]> {
    const rows = await this.definitions.find({
      $and: [filter, ...(after ? [{ _id: { $gt: after } }] : [])],
    }, DURABLE_READ).sort({ _id: 1 }).limit(limit).toArray();
    return rows.map((v) => parseStored(obligationSchema, v));
  }
  async occurrencesPage(filter: Filter<Occurrence>, after: string | undefined, limit: number): Promise<Occurrence[]> {
    const rows = await this.occurrences.find({
      $and: [filter, ...(after ? [{ _id: { $gt: after } }] : [])],
    }, DURABLE_READ).sort({ _id: 1 }).limit(limit).toArray();
    return rows.map((v) => parseStored(occurrenceSchema, v));
  }
  async definitionFor(o: Occurrence): Promise<Obligation> {
    const d = (await this.get(o.obligationId)) ?? fail("definition_missing");
    if (!same(definitionOf(d), o.definition) || !same(d.activeFrom, o.activeFrom)
      || o._id !== occurrenceId(d._id, o.dueAt) || o.obligationId !== d._id
      || o.producerAgentId !== d.producerAgentId || !same(windowStart(d, o.dueAt), o.windowStart)
      || o.delivery.intentId !== o._id + "/delivery"
      || (o.notice !== undefined && o.notice.intentId !== o._id + "/notice")) {
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
    if (o.obligationId !== d._id || !same(o.dueAt, a.dueAt)
      || o._id !== occurrenceId(d._id, a.dueAt) || o.delivery.intentId !== a.intentId) {
      return fail("evidence_integrity");
    }
    return o;
  }
}
export type { Registration };
~~~

A CAS uncertain-result exception propagates; sender and reconciler explicitly re-read token/state before further action. Do not add a generic retry around a Slack call. The release operation matches the exact admission token; deactivation never unsets it.

Every observation that substitutes for an acknowledged write uses DURABLE_READ, including admission/transfer/settlement, registry idempotence and receipt/marker recovery. Local-only visibility after a write-concern timeout is insufficient: a missing majority-confirmed token leaves the outcome unresolved, and read failure propagates without permission to send. The bounded primary majority read applies to projected evidence pages as well. The per-Db queue serializes receipt insertion and terminal retention decisions across all sender/sweeper wrappers; all runtime wrappers must receive the same guarded Db object. Active delivery and notice tokens describe currently executing invocations only, are registered before their claim writes, and are removed in finally; they are never leases or durable proof.

- [ ] Verify the strict date/nesting schema and actual unique-index behavior using chunk 5's atomic fake. In tests, permit Mongo-generated _id on receipt/telemetry rows only; registry and occurrences always have string _id.

- [ ] Run:

~~~bash
npx vitest run src/obligations/deadlines.test.ts
npm run typecheck
git diff --check
~~~

Expected: exit 0, pure boundary/DST tests pass and no type errors. After dodi-dev:verify, commit:

~~~bash
git add src/obligations/types.ts src/obligations/deadlines.ts src/obligations/store.ts src/activity/types.ts src/obligations/deadlines.test.ts
git commit -m "feat: define independent delivery obligations and durable occurrence state"
~~~
