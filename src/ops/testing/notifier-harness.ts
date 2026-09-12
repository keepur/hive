/**
 * KPR-468 — the shared notifier harness.
 *
 * ⚠ A PLAIN MODULE, not a `.test.ts` export, and that is load-bearing rather
 * than stylistic: under this repo's vitest config a `.test.ts` imported by
 * another file RE-REGISTERS its suites into the importer, so every case in the
 * exporting file runs again inside every consumer. Shared fixtures therefore
 * never live in a `.test.ts`. (Measured on this tree by KPR-454's own plan.)
 *
 * ⚠ TEARDOWN. `harness({ start: true })` — or any case that calls
 * `notifier.start()` itself — arms two REAL `setInterval`s (the 30 s sweep and
 * the 60 s subscription reload). Every such case MUST `await h.notifier.stop()`
 * before it ends. The default (`start: false`) arms nothing and needs no
 * teardown: it reproduces `start()`'s first subscription load through a direct
 * `reloadSubscriptions(true)` so that every tick in a suite is one the case
 * asked for.
 *
 * This file lives under `src/ops/testing/`, which `acceptance.integration.test.ts`
 * excludes from its producer-source scans — so it may name collections and
 * state literals freely.
 */
import { guardDb, type WriteGuard } from "../../db/write-guard.js";
import { OpsNotifier } from "../notifier.js";
import { OpsNotificationStore, NOTIFIER_STATS_KIND } from "../notification-store.js";
import { OPS_POLICY_COLLECTION, OPS_POLICY_ID, type OpsNotification, type OpsPolicy } from "../notification-types.js";
import type { DeliveryOutcome, NotificationView, OpsTransport } from "../transport.js";
import {
  OPS_EVENTS_COLLECTION,
  OPS_REASONS_COLLECTION,
  OPS_SUBSCRIPTIONS_COLLECTION,
  type OpsEvent,
  type OpsReason,
  type OpsSubscription,
} from "../types.js";
import { FakeDb } from "./fake-db.js";

/** The fixed epoch every fixture is derived from. Nothing here reads the wall clock. */
export const BASE = new Date("2026-01-01T00:00:00.000Z");

/** `BASE + minutes · 60_000`. Negative is allowed — `t(-1)` is the seeded cursor. */
export const t = (minutes: number): Date => new Date(BASE.getTime() + minutes * 60_000);

/** A row of `ops_reasons` as KPR-454 stores it. */
export type OpsReasonRow = OpsReason & { _id: string };

/**
 * A minimal enabled subscription. Its `filter` matches nothing on purpose: the
 * notifier NEVER evaluates a filter (AC2) — ingest reads the event's stamped
 * `matchedSubscriptionIds` — so a filter that would match is a claim this
 * component does not make.
 */
export function sub(id: string, over: Partial<OpsSubscription> = {}): OpsSubscription {
  return {
    _id: id,
    subscriberId: `${id}-owner`,
    subscriberKind: "human",
    enabled: true,
    filter: { producer: ["__matches-nothing__"] },
    transport: { adapterId: "fake", target: "C0000001" },
    ...over,
  };
}

/**
 * A reason-registry row. `producer` defaults to `"tool"` — PINNED, because the
 * notifier's only reason read is `reasons.get(`${producer}:${reasonId}`)`
 * against a map KPR-454 keys the same way, so a `reason()` whose producer
 * differs from `seedEvent()`'s never resolves and `remediation` is silently
 * omitted. Only `remediationTemplate` is read by this child.
 */
export function reason(id: string, over: Partial<OpsReasonRow> = {}): OpsReasonRow {
  const producer = over.producer ?? "tool";
  return {
    _id: `${producer}:${id}`,
    producer,
    reasonId: id,
    class: "integrity",
    retry: "deterministic",
    remediationTemplate: `re-run {toolName}`,
    detailKeys: [],
    enabled: true,
    ...over,
  };
}

/** The shape the double hands a fault/pause predicate. */
export interface FaultContext {
  filter?: Record<string, unknown>;
  update?: Record<string, unknown>;
  document?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

/**
 * ⚠ The double's real signature is `failNext(collection, operation, error, when)`
 * — NOT `(collection, operation, after, when)`. These two helpers are the
 * n-th-call and predicate forms written against the real one.
 *
 * Persistent faults and the reset are methods on the double itself
 * (`db.failAll`, `db.clearFaults`) and are deliberately NOT wrapped here.
 */
export function failNth(db: FakeDb, collection: string, operation: string, n: number): void {
  let seen = 0;
  db.failNext(collection, operation, new Error("injected"), () => (seen += 1) === n);
}

export function failOn(db: FakeDb, collection: string, operation: string, when: (ctx: FaultContext) => boolean): void {
  db.failNext(collection, operation, new Error("injected"), when as never);
}

export class FakeTransport implements OpsTransport {
  /** Every view handed to deliver(), in order. Later tests read this. */
  readonly views: NotificationView[] = [];
  /**
   * Runs INSIDE deliver(), after the view is recorded and before the outcome
   * is returned — i.e. at the one instant where an irreversible external side
   * effect has happened and the ledger has not been written yet. Assigned per
   * case (`h.transport.onDeliver = …`); part of this contract, not a
   * monkeypatch.
   */
  onDeliver?: (view: NotificationView) => Promise<void> | void;
  private readonly queue: Array<DeliveryOutcome | "throw"> = [];
  constructor(
    readonly adapterId = "fake",
    private readonly clock: () => Date = () => BASE,
    /** Overridable so the "adapter rejects the target" load case is drivable. */
    private readonly valid: (target: unknown) => boolean = (target) => typeof target === "string",
  ) {}
  /** Programs the NEXT calls. The LAST entry repeats once the queue is down to it. */
  program(...outcomes: Array<DeliveryOutcome | "throw">): void {
    this.queue.push(...outcomes);
  }
  validateTarget(target: unknown): boolean {
    return this.valid(target);
  }
  async deliver(view: NotificationView): Promise<DeliveryOutcome> {
    this.views.push(view);
    await this.onDeliver?.(view);
    const next = this.queue.length > 1 ? this.queue.shift()! : this.queue[0];
    if (next === "throw") throw new Error("fake transport fault");
    return next ?? { status: "accepted", reference: { kind: "fake", id: view.handle }, at: this.clock() };
  }
}

export interface HarnessOptions {
  subscriptions?: OpsSubscription[];
  reasons?: OpsReasonRow[];
  /** Written to ops_policy BEFORE init(); zero rows is the shipped default. */
  policy?: OpsPolicy | null;
  /**
   * The sweep cursor seeded before the first tick. DEFAULTS TO `t(-1)`, not to
   * absent: with no cursor the first tick takes the cold-start arm, sets the
   * cursor to `now`, and applies NOTHING. Pass `null` explicitly for the
   * cold-start cases.
   */
  cursorAt?: Date | null;
  activityRetentionDays?: number;
  /** `null` ⇒ register none (the unbound-adapter cases). */
  transport?: FakeTransport | null;
  /**
   * KPR-294's write guard, wired the way index.ts wires it: the notifier sees
   * `guardDb(db, guard)` and `() => !guard.engaged`. Absent ⇒ the raw double
   * and an always-writable guard. Only the NOTIFIER is guarded — the harness's
   * own `store`, `seedEvent` and `row` keep the raw double, so a case can seed
   * and inspect while the guard is engaged.
   */
  writeGuard?: WriteGuard;
  /**
   * Default FALSE. Reproduces start()'s first subscription load
   * (reloadSubscriptions(true)) without arming timers or running the
   * immediate sweep, so every tick in a test is one the test asked for. Pass
   * true only for lifecycle cases that are ABOUT start().
   */
  start?: boolean;
}

export interface NotifierHarness {
  db: FakeDb;
  store: OpsNotificationStore;
  notifier: OpsNotifier;
  transport: FakeTransport;
  now(): Date;
  /** Moves the injected clock forward; nothing is scheduled off it. */
  advance(ms: number): void;
  /** THE BARRIER. One full tick — notifier.__tickForTests(). */
  tick(): Promise<void>;
  /** Inserts one ops_events document; returns it WITH its minted _id. */
  seedEvent(over?: Partial<OpsEvent>): Promise<OpsEvent>;
  /** n events on distinct dedupeKeys at t(0)…t(n-1), in order. */
  seedEvents(n: number, over?: Partial<OpsEvent>): Promise<OpsEvent[]>;
  /** The one ledger row for a (subscriptionId, dedupeKey). THROWS if absent. */
  row(subscriptionId: string, dedupeKey: string): Promise<OpsNotification>;
  /**
   * PINNED to notifications.countDocuments({}) — NOT find({}).toArray().length.
   * A stop-seam case marks db.operations, then asserts no ops_notifications
   * `find` follows; a find-based ledgerCount() would land its own operation
   * inside that window. find and countDocuments are distinct operation names.
   */
  ledgerCount(): Promise<number>;
  /** notifier.getSnapshot() — counters included. */
  snapshot(): Record<string, unknown>;
  /** The kind: "ops_notifier_stats" telemetry document. THROWS if absent. */
  heartbeat(): Promise<Record<string, unknown>>;
}

export async function harness(options: HarnessOptions = {}): Promise<NotifierHarness> {
  const db = new FakeDb();
  let clock = BASE;

  const subscriptions = options.subscriptions ?? [];
  for (const s of subscriptions) await db.collection(OPS_SUBSCRIPTIONS_COLLECTION).insertOne(s);
  for (const r of options.reasons ?? []) await db.collection(OPS_REASONS_COLLECTION).insertOne(r);
  if (options.policy) {
    // `_id` is forced: the store reads exactly one document, by OPS_POLICY_ID.
    await db.collection(OPS_POLICY_COLLECTION).insertOne({ ...options.policy, _id: OPS_POLICY_ID });
  }

  const transport = options.transport ?? new FakeTransport("fake", () => clock);
  const store = new OpsNotificationStore(db.db);
  const guard = options.writeGuard;
  const notifier = new OpsNotifier(
    guard ? guardDb(db.db, guard) : db.db,
    options.activityRetentionDays ?? 90,
    guard ? () => !guard.engaged : () => true,
    () => clock,
    // No real wall-clock delay: ATTEMPT_SPACING_MS must not cost a suite a
    // second per attempt.
    async () => {},
  );
  await notifier.init();
  if (options.transport !== null) notifier.registerTransport(transport);

  if (options.cursorAt !== null) {
    await store.writeCursor({ publishedAt: options.cursorAt ?? t(-1), eventId: null });
  }

  if (options.start) await notifier.start();
  else await notifier.reloadSubscriptions(true);

  let keys = 0;
  const seedEvent = async (over: Partial<OpsEvent> = {}): Promise<OpsEvent> => {
    keys += 1;
    const ids = subscriptions.map((s) => s._id);
    const draft: OpsEvent = {
      schemaVersion: 1,
      publishedAt: t(0),
      producer: "tool",
      reasonId: "r1",
      class: "integrity",
      retry: "deterministic",
      waiting: "nobody",
      subject: { kind: "workItem", id: "w1" },
      generation: 1,
      dedupeKey: `tool:workItem:w1:r1:${keys}`,
      detail: {},
      evidence: [],
      // ⚠ THE LOAD-BEARING DEFAULT. Ingest reads the stamped list and never
      // re-evaluates a filter (AC2/AC3), so an unstamped event creates nothing.
      matchedSubscriptionIds: ids,
      matchedSubscriptions: ids.length,
      ...over,
    };
    if (over.matchedSubscriptions === undefined) draft.matchedSubscriptions = draft.matchedSubscriptionIds.length;
    const res = await db.collection(OPS_EVENTS_COLLECTION).insertOne(draft);
    return { ...draft, _id: res.insertedId };
  };

  return {
    db,
    store,
    notifier,
    transport,
    now: () => clock,
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    tick: () => notifier.__tickForTests(),
    seedEvent,
    seedEvents: async (n, over = {}) => {
      const out: OpsEvent[] = [];
      // An explicit `publishedAt` in `over` is deliberately ignored: these n
      // events must be strictly ordered for the cursor to walk them.
      for (let i = 0; i < n; i += 1) out.push(await seedEvent({ ...over, publishedAt: t(i) }));
      return out;
    },
    row: async (subscriptionId, dedupeKey) => {
      const found = await store.notifications.findOne({ subscriptionId, dedupeKey });
      if (!found) throw new Error(`no ledger row for ${subscriptionId} / ${dedupeKey}`);
      return found as OpsNotification;
    },
    ledgerCount: () => store.notifications.countDocuments({}),
    snapshot: () => notifier.getSnapshot(),
    heartbeat: async () => {
      const doc = await store.telemetry.findOne({ kind: NOTIFIER_STATS_KIND });
      if (!doc) throw new Error("no ops_notifier_stats heartbeat document");
      return doc as Record<string, unknown>;
    },
  };
}
