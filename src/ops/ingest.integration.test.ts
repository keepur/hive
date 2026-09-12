/**
 * KPR-468 chunk 2b — IngestPhase against the in-memory Mongo double.
 *
 * ⚠ This file builds its OWN harness rather than importing a shared one.
 * `src/ops/testing/notifier-harness.ts` does not exist yet and, when it does,
 * it constructs an `OpsNotifier` — which would make this suite depend on the
 * phase runner it is meant to be independent of. The fixture builders below
 * follow `src/ops/testing/lane-harness.ts`'s conventions (plain builders with
 * an `overrides` parameter, real `ObjectId`s minted by the double) without
 * importing it.
 *
 * The store's indexes ARE created in the harness, deliberately: the
 * (subscriptionId, dedupeKey) unique index is what turns arm C's
 * duplicate-key error into D4's race detector, so a suite that skipped
 * `ensureIndexes()` would test an insert that can never conflict.
 */
import { describe, expect, it } from "vitest";
import type { ObjectId } from "mongodb";
import { IngestPhase, strictlyAfter } from "./ingest.js";
import { OpsNotificationStore, type SweepCursor } from "./notification-store.js";
import {
  GAUGE_COUNT_LIMIT,
  OPS_NOTIFICATIONS_COLLECTION,
  OPS_SYSTEM_PRINCIPAL,
  freshCounters,
  type OpsNotification,
  type OpsNotifierCounters,
} from "./notification-types.js";
import { FakeDb } from "./testing/fake-db.js";
import { OPS_EVENTS_COLLECTION, type OpsEvent, type OpsSubscription } from "./types.js";

const RETENTION_DAYS = 30;
const EPOCH = new Date("2026-01-01T00:00:00.000Z").getTime();
/** Seconds past a fixed epoch — every instant in this file is derived, never `new Date()`. */
const at = (seconds: number): Date => new Date(EPOCH + seconds * 1000);
/** The tick's `now`, deliberately far from every event's `publishedAt` (D4's stateAt rule). */
const NOW = at(10_000);
const KEY = "hive-runtime:work-item:wi-1:tool-failed:1";

function subscription(overrides: Partial<OpsSubscription> = {}): OpsSubscription {
  return {
    _id: "sub-1",
    subscriberId: "ops-team",
    subscriberKind: "human",
    enabled: true,
    filter: { producer: ["hive-runtime"] },
    transport: { adapterId: "slack", target: "C1" },
    ...overrides,
  };
}

function eventDraft(overrides: Partial<OpsEvent> = {}): OpsEvent {
  return {
    schemaVersion: 1,
    publishedAt: at(100),
    producer: "hive-runtime",
    reasonId: "tool-failed",
    class: "resource",
    retry: "transient",
    waiting: "human-now",
    subject: { kind: "work-item", id: "wi-1" },
    generation: 1,
    dedupeKey: KEY,
    detail: { toolName: "memory_save" },
    evidence: [{ kind: "work-item", id: "wi-1" }],
    matchedSubscriptions: 1,
    matchedSubscriptionIds: ["sub-1"],
    ...overrides,
  };
}

function notificationDraft(overrides: Partial<OpsNotification> = {}): OpsNotification {
  return {
    subscriptionId: "sub-1",
    subscriberId: "ops-team",
    dedupeKey: KEY,
    producer: "hive-runtime",
    reasonId: "tool-failed",
    class: "resource",
    waiting: "human-now",
    retry: "transient",
    subject: { kind: "work-item", id: "wi-1" },
    generation: 1,
    firstEventId: "000000000000000000000001",
    latestEventId: "000000000000000000000001",
    eventCount: 1,
    firstSeenAt: at(50),
    lastEventAt: at(50),
    state: "pending",
    stateAt: at(50),
    principal: OPS_SYSTEM_PRINCIPAL,
    principalAt: at(50),
    attempts: [],
    attemptCount: 0,
    nudgeCount: 0,
    appliedThroughAt: at(50),
    appliedThroughId: "000000000000000000000001",
    latestDetail: {},
    latestEvidence: [],
    ...overrides,
  };
}

interface Harness {
  db: FakeDb;
  store: OpsNotificationStore;
  counters: OpsNotifierCounters;
  phase: IngestPhase;
  /** Insert events into `ops_events` and hand back the stored docs, `_id` included. */
  seed(...drafts: Partial<OpsEvent>[]): Promise<OpsEvent[]>;
  /** Insert one ledger row directly, bypassing ingest — a pre-existing condition. */
  seedRow(overrides?: Partial<OpsNotification>): Promise<OpsNotification>;
  rows(): OpsNotification[];
  eventRows(): OpsEvent[];
  /** Every call recorded since `mark`, so a case counts only its own run's I/O. */
  since(mark: number): Array<{ collection: string; operation: string; context: Record<string, unknown> }>;
  mark(): number;
}

async function harness(
  options: { subscriptions?: OpsSubscription[]; stopped?: () => boolean; cursor?: SweepCursor } = {},
): Promise<Harness> {
  const db = new FakeDb();
  const store = new OpsNotificationStore(db.db);
  await store.ensureIndexes();
  if (options.cursor) await store.writeCursor(options.cursor);
  const counters = freshCounters();
  const subs = new Map<string, OpsSubscription>();
  for (const sub of options.subscriptions ?? [subscription()]) subs.set(sub._id, sub);
  const events = db.db.collection<OpsEvent>(OPS_EVENTS_COLLECTION);
  const phase = new IngestPhase(events, store, counters, () => subs, RETENTION_DAYS, options.stopped);

  return {
    db,
    store,
    counters,
    phase,
    seed: async (...drafts) => {
      const out: OpsEvent[] = [];
      for (const draft of drafts) {
        const doc = eventDraft(draft);
        // The double does NOT write `_id` back onto the caller's document
        // (fake-db.ts divergence 4), so the id comes off the result.
        const result = await db.collection(OPS_EVENTS_COLLECTION).insertOne(doc);
        out.push({ ...doc, _id: result.insertedId as ObjectId });
      }
      return out;
    },
    seedRow: async (overrides = {}) => {
      const doc = notificationDraft(overrides);
      const result = await db.collection(OPS_NOTIFICATIONS_COLLECTION).insertOne(doc);
      return { ...doc, _id: result.insertedId as ObjectId };
    },
    rows: () => db.collection(OPS_NOTIFICATIONS_COLLECTION).rows as unknown as OpsNotification[],
    eventRows: () => db.collection(OPS_EVENTS_COLLECTION).rows as unknown as OpsEvent[],
    since: (mark) => db.operations.slice(mark) as never,
    mark: () => db.operations.length,
  };
}

/** A cursor far enough back that every seeded event is in scan range. */
const FROM_START: SweepCursor = { publishedAt: at(0), eventId: null };

// ───────────────────────────────────────────────────────────────────────────

describe("strictlyAfter (D3): the position filter over (publishedAt, _id)", () => {
  it("with a null eventId selects only events published strictly after the cursor", async () => {
    const h = await harness({ cursor: FROM_START });
    const [, , third] = await h.seed(
      { publishedAt: at(100), dedupeKey: "k1" },
      { publishedAt: at(200), dedupeKey: "k2" },
      { publishedAt: at(300), dedupeKey: "k3" },
    );

    const found = await h.db
      .collection(OPS_EVENTS_COLLECTION)
      .find(strictlyAfter({ publishedAt: at(200), eventId: null }))
      .toArray();

    // Strictly after: the event AT the cursor instant is excluded.
    expect(found.map((e) => e.dedupeKey)).toEqual(["k3"]);
    expect(String(found[0]!._id)).toBe(String(third!._id));
  });

  it("with a real eventId breaks a publishedAt tie on _id", async () => {
    const h = await harness({ cursor: FROM_START });
    await h.seed(
      { publishedAt: at(100), dedupeKey: "tie-a" },
      { publishedAt: at(100), dedupeKey: "tie-b" },
      { publishedAt: at(100), dedupeKey: "tie-c" },
    );
    // The double mints REAL ObjectIds, so insertion order is _id order; read
    // them back through the same sort ingest uses rather than assuming it.
    const ordered = await h.db.collection(OPS_EVENTS_COLLECTION).find({}).sort({ publishedAt: 1, _id: 1 }).toArray();
    const cursor: SweepCursor = { publishedAt: at(100), eventId: String(ordered[0]!._id) };

    const found = await h.db.collection(OPS_EVENTS_COLLECTION).find(strictlyAfter(cursor)).toArray();

    expect(found.map((e) => e.dedupeKey)).toEqual([ordered[1]!.dedupeKey, ordered[2]!.dedupeKey]);
  });
});

describe("row creation (D4 step 2)", () => {
  it("creates one pending row due now from a fresh event with one stamped subscription", async () => {
    const h = await harness({ cursor: FROM_START });
    const [e] = await h.seed({});

    const result = await h.phase.run(NOW);

    expect(result).toEqual({
      ok: true,
      stoppedEarly: false,
      cursorAt: e!.publishedAt,
      eventsBehind: 0,
      oldestUnappliedAt: null,
    });
    expect(h.rows()).toHaveLength(1);
    const row = h.rows()[0]!;
    expect(row).toMatchObject({
      subscriptionId: "sub-1",
      subscriberId: "ops-team",
      dedupeKey: KEY,
      producer: "hive-runtime",
      reasonId: "tool-failed",
      class: "resource",
      waiting: "human-now",
      retry: "transient",
      generation: 1,
      state: "pending",
      eventCount: 1,
      attemptCount: 0,
      nudgeCount: 0,
      attempts: [],
      // D5: first delivery IS the first nudge.
      nextNudgeAt: NOW,
      // D4: a SYSTEM transition is stamped with the tick's now, not the event's.
      stateAt: NOW,
      principal: OPS_SYSTEM_PRINCIPAL,
      principalAt: NOW,
      firstSeenAt: e!.publishedAt,
      lastEventAt: e!.publishedAt,
      // The watermark sits at the event's own position.
      appliedThroughAt: e!.publishedAt,
      appliedThroughId: String(e!._id),
      firstEventId: String(e!._id),
      latestEventId: String(e!._id),
      latestDetail: { toolName: "memory_save" },
      latestEvidence: [{ kind: "work-item", id: "wi-1" }],
    });
    expect(h.counters.rowsCreated).toBe(1);
    expect(h.counters.eventsApplied).toBe(1);
    expect(h.counters.rowsRenewed).toBe(0);
  });

  it("creates no row for a stamped id absent from the loaded map, and leaves the event untouched", async () => {
    // The stamped id is honest for the set that existed at accept; it was
    // never a delivery promise, and the event's own count still stands.
    const h = await harness({ subscriptions: [], cursor: FROM_START });
    await h.seed({ matchedSubscriptionIds: ["sub-vanished"], matchedSubscriptions: 1 });
    const before = structuredClone(h.eventRows().map((e) => ({ ...e, _id: String(e._id) })));

    const result = await h.phase.run(NOW);

    expect(result.ok).toBe(true);
    expect(h.rows()).toHaveLength(0);
    expect(h.counters.rowsCreated).toBe(0);
    expect(h.counters.eventsApplied).toBe(1);
    expect(h.eventRows().map((e) => ({ ...e, _id: String(e._id) }))).toEqual(before);
    expect(h.eventRows()[0]!.matchedSubscriptions).toBe(1);
  });
});

describe("renewal (D7 rule 4): the same condition, seen again", () => {
  it("advances the snapshot on a pending row and never resets nextNudgeAt", async () => {
    const h = await harness({ cursor: FROM_START });
    const cadenceDue = at(5_000);
    await h.seedRow({ state: "pending", nextNudgeAt: cadenceDue, attemptCount: 3, nudgeCount: 2 });
    const [e] = await h.seed({
      publishedAt: at(200),
      detail: { toolName: "team_message" },
      evidence: [{ kind: "work-item", id: "wi-9" }],
    });

    await h.phase.run(NOW);

    const row = h.rows()[0]!;
    expect(row).toMatchObject({
      state: "pending",
      eventCount: 2,
      latestEventId: String(e!._id),
      lastEventAt: e!.publishedAt,
      latestDetail: { toolName: "team_message" },
      latestEvidence: [{ kind: "work-item", id: "wi-9" }],
      appliedThroughAt: e!.publishedAt,
      appliedThroughId: String(e!._id),
      // A repeat must not restart the cadence clock.
      nextNudgeAt: cadenceDue,
      attemptCount: 3,
      nudgeCount: 2,
    });
    expect(h.counters.rowsRenewed).toBe(1);
    expect(h.counters.rowsCreated).toBe(0);
  });

  it.each(["seen", "dismissed"] as const)("advances a %s row and sends nothing new", async (state) => {
    const h = await harness({ cursor: FROM_START });
    await h.seedRow({ state, stateAt: at(60), principal: "U123", principalAt: at(60) });
    const [e] = await h.seed({ publishedAt: at(200) });

    await h.phase.run(NOW);

    const row = h.rows()[0]!;
    expect(row.state).toBe(state);
    expect(row.eventCount).toBe(2);
    expect(row.latestEventId).toBe(String(e!._id));
    // Nothing was sent and nothing became due: an acknowledged row carries no
    // nextNudgeAt, and renewal does not mint one.
    expect(Object.prototype.hasOwnProperty.call(row, "nextNudgeAt")).toBe(false);
    expect(row.forceDeliver).toBeUndefined();
    // The human's acknowledgement stands — renewal is not a state transition.
    expect(row.principal).toBe("U123");
    expect(row.stateAt).toEqual(at(60));
  });

  it("advances a snoozed row and leaves snoozedUntil untouched", async () => {
    const h = await harness({ cursor: FROM_START });
    const until = at(9_000);
    await h.seedRow({ state: "snoozed", snoozedUntil: until, stateAt: at(60), principal: "U123" });
    const [e] = await h.seed({ publishedAt: at(200) });

    await h.phase.run(NOW);

    const row = h.rows()[0]!;
    expect(row.state).toBe("snoozed");
    expect(row.snoozedUntil).toEqual(until);
    expect(row.eventCount).toBe(2);
    expect(row.latestEventId).toBe(String(e!._id));
  });

  it("reopens a cleared row to pending with forceDeliver, clearing the stop-state markers", async () => {
    const h = await harness({ cursor: FROM_START });
    await h.seedRow({
      state: "cleared",
      stateAt: at(60),
      stateEventId: "000000000000000000000002",
      expiresAt: at(60 + 30 * 86_400),
      stalledAt: at(59),
      stalledReason: "cadence",
      attemptCount: 4,
      // The PREVIOUS occurrence's accepted delivery. A reopen is the
      // occurrence boundary, and snooze expiry reads this field as "accepted
      // in this occurrence" (delivery.ts, expire).
      deliveryReference: { kind: "fake", id: "previous-occurrence" },
      lastOutcome: "accepted",
    });
    const [e] = await h.seed({ publishedAt: at(200) });

    await h.phase.run(NOW);

    const row = h.rows()[0]!;
    expect(row).toMatchObject({
      state: "pending",
      stateAt: NOW,
      principal: OPS_SYSTEM_PRINCIPAL,
      principalAt: NOW,
      stateEventId: String(e!._id),
      nextNudgeAt: NOW,
      // attemptCount is monotonic and a reopen does not reset it, so without
      // this flag a condition that demonstrably came back would never be
      // delivered again under the shipped default.
      forceDeliver: true,
      attemptCount: 4,
      eventCount: 2,
    });
    for (const field of ["expiresAt", "stalledAt", "stalledReason", "deliveryReference"]) {
      expect(Object.prototype.hasOwnProperty.call(row, field), field).toBe(false);
    }
    // lastOutcome is the LAST ATTEMPT's, and no attempt has happened yet in
    // the new occurrence — it is left alone (notification-types.ts).
    expect(row.lastOutcome).toBe("accepted");
    expect(h.counters.rowsRenewed).toBe(1);
  });
});

describe("the apply-if-strictly-newer watermark (D3, C17)", () => {
  it("leaves eventCount at 1 when the same event is applied twice", async () => {
    const h = await harness({ cursor: FROM_START });
    await h.seed({ publishedAt: at(200) });

    await h.phase.run(NOW);
    expect(h.rows()[0]!.eventCount).toBe(1);

    // Rewind the cursor: exactly what a crash between the ledger writes and the
    // cursor write leaves behind.
    await h.store.writeCursor(FROM_START);
    await h.phase.run(NOW);

    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]!.eventCount).toBe(1);
    // Arms A and B both missed and arm C hit the unique index — the race
    // detector, resolving in favour of "the row exists and is not older".
    expect(h.counters.renewalStale).toBe(1);
    expect(h.counters.rowsCreated).toBe(1);
    expect(h.counters.rowsRenewed).toBe(0);
  });

  it("changes nothing when an older event is applied after a newer one", async () => {
    const h = await harness();
    const [older, newer] = await h.seed({ publishedAt: at(100) }, { publishedAt: at(300) });
    // Start positioned past the older event, so the first run applies only the
    // newer one.
    await h.store.writeCursor({ publishedAt: older!.publishedAt, eventId: String(older!._id) });
    await h.phase.run(NOW);
    const applied = structuredClone({ ...h.rows()[0]!, _id: String(h.rows()[0]!._id) });
    expect(applied.latestEventId).toBe(String(newer!._id));

    // Rewind so the OLDER event is back in scan range.
    await h.store.writeCursor(FROM_START);
    await h.phase.run(NOW);

    expect({ ...h.rows()[0]!, _id: String(h.rows()[0]!._id) }).toEqual(applied);
    expect(h.counters.renewalStale).toBe(2); // the older event, then the newer replay
  });
});

describe("clearing (D4(a)): scope, provenance and the cleared-row no-op", () => {
  it("clears every row on the named key across subscriptions, independent of its own matches", async () => {
    // A clearing reason is `informational` and normally matches ZERO
    // subscriptions; a match-scoped clearing would clear nothing at all.
    const h = await harness({ cursor: FROM_START });
    await h.seedRow({ subscriptionId: "sub-1", state: "pending", nextNudgeAt: at(80) });
    await h.seedRow({ subscriptionId: "sub-2", subscriberId: "eng", state: "delivered", nextNudgeAt: at(80) });
    const [e] = await h.seed({
      publishedAt: at(200),
      reasonId: "tool-recovered",
      class: "informational",
      dedupeKey: "hive-runtime:work-item:wi-1:tool-recovered:1",
      clears: KEY,
      matchedSubscriptions: 0,
      matchedSubscriptionIds: [],
    });

    await h.phase.run(NOW);

    expect(h.rows()).toHaveLength(2);
    for (const row of h.rows()) {
      expect(row.state).toBe("cleared");
      expect(row.stateAt).toEqual(NOW);
      expect(row.principal).toBe(OPS_SYSTEM_PRINCIPAL);
      expect(row.stateEventId).toBe(String(e!._id));
      // D9: a stopped row carries a TTL horizon derived from the TICK's now.
      expect(row.expiresAt).toEqual(new Date(NOW.getTime() + RETENTION_DAYS * 86_400_000));
      expect(row.appliedThroughAt).toEqual(e!.publishedAt);
      expect(row.appliedThroughId).toBe(String(e!._id));
      expect(Object.prototype.hasOwnProperty.call(row, "nextNudgeAt")).toBe(false);
    }
    expect(h.counters.rowsCleared).toBe(2);
    expect(h.counters.clearRefused).toBe(0);
    // No renewal rows: the clearing event matched nothing of its own.
    expect(h.counters.rowsCreated).toBe(0);
  });

  it.each([
    ["resource, no evidence, same producer", "resource", 0, "hive-runtime", true],
    ["judgment, no evidence, same producer", "judgment", 0, "hive-runtime", false],
    ["judgment, with evidence, same producer", "judgment", 1, "hive-runtime", true],
    ["integrity, no evidence, same producer", "integrity", 0, "hive-runtime", false],
    ["integrity, with evidence, same producer", "integrity", 1, "hive-runtime", true],
    ["informational, with evidence, same producer", "informational", 1, "hive-runtime", false],
    // The clause that closes C19's reasonId-only publish check: the PRODUCER
    // component of a `clears` key is never constrained at publish.
    ["resource, with evidence, ANOTHER producer", "resource", 1, "other-producer", false],
  ] as const)("%s", async (_label, rowClass, evidenceCount, producer, expectCleared) => {
    const h = await harness({ cursor: FROM_START });
    await h.seedRow({ class: rowClass, state: "pending" });
    await h.seed({
      publishedAt: at(200),
      producer,
      class: "informational",
      dedupeKey: `${producer}:work-item:wi-1:tool-recovered:1`,
      clears: KEY,
      evidence: evidenceCount === 0 ? [] : [{ kind: "work-item", id: "wi-1" }],
      matchedSubscriptions: 0,
      matchedSubscriptionIds: [],
    });

    await h.phase.run(NOW);

    expect(h.rows()[0]!.state).toBe(expectCleared ? "cleared" : "pending");
    expect(h.counters.rowsCleared).toBe(expectCleared ? 1 : 0);
    expect(h.counters.clearRefused).toBe(expectCleared ? 0 : 1);
  });

  it("clears a dismissed row — an acknowledged condition that actually resolved still closes", async () => {
    const h = await harness({ cursor: FROM_START });
    await h.seedRow({ state: "dismissed", stateAt: at(60), principal: "U123", expiresAt: at(60 + 86_400) });
    await h.seed({
      publishedAt: at(200),
      class: "informational",
      dedupeKey: "hive-runtime:work-item:wi-1:tool-recovered:1",
      clears: KEY,
      matchedSubscriptions: 0,
      matchedSubscriptionIds: [],
    });

    await h.phase.run(NOW);

    expect(h.rows()[0]!.state).toBe("cleared");
    expect(h.rows()[0]!.principal).toBe(OPS_SYSTEM_PRINCIPAL);
    expect(h.counters.rowsCleared).toBe(1);
  });

  it("moves nothing and counts nothing when a NEWER clearing fact lands on an already-cleared row", async () => {
    // Against a watermark-only implementation every asserted field below would
    // move and rowsCleared would reach 2 — a flapping producer would extend a
    // closed row's retention horizon indefinitely and it would never age out.
    const h = await harness({ cursor: FROM_START });
    const [e1, e2] = await h.seed(
      {
        publishedAt: at(200),
        class: "informational",
        dedupeKey: "hive-runtime:work-item:wi-1:tool-recovered:1",
        clears: KEY,
        matchedSubscriptions: 0,
        matchedSubscriptionIds: [],
      },
      {
        publishedAt: at(400),
        class: "informational",
        dedupeKey: "hive-runtime:work-item:wi-1:tool-recovered:1",
        clears: KEY,
        matchedSubscriptions: 0,
        matchedSubscriptionIds: [],
      },
    );
    await h.seedRow({ state: "pending", nextNudgeAt: at(80) });

    // Apply e1 only.
    await h.store.writeCursor(FROM_START);
    const firstPass = new IngestPhase(
      h.db.db.collection<OpsEvent>(OPS_EVENTS_COLLECTION),
      h.store,
      h.counters,
      () => new Map([["sub-1", subscription()]]),
      RETENTION_DAYS,
      // Stop after the first event: the second is the strictly newer replay
      // this case is about.
      () => h.rows().some((row) => row.state === "cleared"),
    );
    await firstPass.run(NOW);
    expect(h.rows()[0]!.stateEventId).toBe(String(e1!._id));
    const closed = structuredClone({ ...h.rows()[0]!, _id: String(h.rows()[0]!._id) });
    const clearedBefore = h.counters.rowsCleared;
    const refusedBefore = h.counters.clearRefused;

    // Now apply the strictly newer e2 through the ordinary (non-stopping) phase.
    await h.phase.run(new Date(NOW.getTime() + 60_000));

    const row = h.rows()[0]!;
    expect(row.state).toBe("cleared");
    expect(row.stateAt).toEqual(closed.stateAt);
    // The FIRST clearing event is the honest answer to "what closed this row".
    expect(row.stateEventId).toBe(String(e1!._id));
    expect(String(e2!._id)).not.toBe(String(e1!._id));
    expect(row.expiresAt).toEqual(closed.expiresAt);
    expect(row.appliedThroughAt).toEqual(closed.appliedThroughAt);
    expect(row.appliedThroughId).toBe(closed.appliedThroughId);
    // Neither counter moves: a cleared row PASSES provenance, it simply
    // matched nothing.
    expect(h.counters.rowsCleared).toBe(clearedBefore);
    expect(h.counters.clearRefused).toBe(refusedBefore);
  });

  it("counts clearNoRow and nothing else when the named key holds no row", async () => {
    // Nobody was listening. D8 answers openness from the LOG, not the ledger.
    const h = await harness({ cursor: FROM_START });
    await h.seed({
      publishedAt: at(200),
      class: "informational",
      dedupeKey: "hive-runtime:work-item:wi-1:tool-recovered:1",
      clears: "hive-runtime:work-item:nobody:tool-failed:1",
      matchedSubscriptions: 0,
      matchedSubscriptionIds: [],
    });

    await h.phase.run(NOW);

    expect(h.counters.clearNoRow).toBe(1);
    expect(h.counters.rowsCleared).toBe(0);
    expect(h.counters.clearRefused).toBe(0);
    expect(h.counters.rowsCreated).toBe(0);
    expect(h.rows()).toHaveLength(0);
  });
});

describe("the cursor (D3)", () => {
  it("advances to the last fully-applied event and is written once, with majority write concern", async () => {
    const h = await harness({ cursor: FROM_START });
    const seeded = await h.seed(
      { publishedAt: at(100), dedupeKey: "k1" },
      { publishedAt: at(200), dedupeKey: "k2" },
      { publishedAt: at(300), dedupeKey: "k3" },
    );
    const last = seeded[2]!;
    const mark = h.mark();

    const result = await h.phase.run(NOW);

    expect(result.cursorAt).toEqual(last.publishedAt);
    expect(await h.store.readCursor()).toEqual({ publishedAt: last.publishedAt, eventId: String(last._id) });
    const cursorWrites = h.since(mark).filter((op) => op.collection === "telemetry" && op.operation === "updateOne");
    expect(cursorWrites).toHaveLength(1);
    expect((cursorWrites[0]!.context as { options?: Record<string, unknown> }).options).toMatchObject({
      upsert: true,
      writeConcern: { w: "majority", wtimeoutMS: 5000 },
    });
  });

  it("initializes an absent cursor to now, counts it, and backfills nothing", async () => {
    const h = await harness();
    const drafts = Array.from({ length: 50 }, (_, i) => ({ publishedAt: at(i + 1), dedupeKey: `k${i}` }));
    await h.seed(...drafts);
    expect(await h.store.readCursor()).toBeNull();

    const result = await h.phase.run(NOW);

    expect(result).toEqual({
      ok: true,
      stoppedEarly: false,
      cursorAt: NOW,
      eventsBehind: 0,
      oldestUnappliedAt: null,
    });
    expect(await h.store.readCursor()).toEqual({ publishedAt: NOW, eventId: null });
    expect(h.counters.cursorReinitialized).toBe(1);
    // The whole point: weeks of accumulated KPR-454 backlog is NOT delivered.
    expect(h.rows()).toHaveLength(0);
    expect(h.counters.eventsApplied).toBe(0);
  });
});

describe("event-level containment (D8(b))", () => {
  it("stops at the faulting event, and the next tick applies 3, 4 and 5", async () => {
    const h = await harness({ cursor: FROM_START });
    const seeded = await h.seed(
      ...Array.from({ length: 5 }, (_, i) => ({ publishedAt: at(100 + i), dedupeKey: `k${i + 1}` })),
    );
    // Exactly one call: event 3's insert. Distinct dedupeKeys make every
    // event's application an insert, so the predicate names one write.
    h.db.failNext(
      OPS_NOTIFICATIONS_COLLECTION,
      "insertOne",
      new Error("injected"),
      (ctx) => ctx.document?.dedupeKey === "k3",
    );

    const first = await h.phase.run(NOW);

    expect(first.ok).toBe(false);
    expect(h.counters.ingestFaults).toBe(1);
    expect(h.counters.eventsApplied).toBe(2);
    expect(h.rows().map((r) => r.dedupeKey)).toEqual(["k1", "k2"]);
    // The cursor advanced no further than the faulting event's PREDECESSOR —
    // events 3..5 are behind it, never under it.
    expect(await h.store.readCursor()).toEqual({
      publishedAt: seeded[1]!.publishedAt,
      eventId: String(seeded[1]!._id),
    });
    expect(first.oldestUnappliedAt).toEqual(seeded[2]!.publishedAt);
    expect(first.eventsBehind).toBe(3);

    const second = await h.phase.run(NOW);

    expect(second.ok).toBe(true);
    expect(second.eventsBehind).toBe(0);
    expect(h.rows().map((r) => r.dedupeKey)).toEqual(["k1", "k2", "k3", "k4", "k5"]);
    expect(h.counters.eventsApplied).toBe(5);
    // The two already-applied events were re-read on the retry and were total
    // no-ops — CAS'd apply-if-newer, so eventCount counts distinct events.
    expect(h.rows().every((r) => r.eventCount === 1)).toBe(true);
    expect(await h.store.readCursor()).toEqual({
      publishedAt: seeded[4]!.publishedAt,
      eventId: String(seeded[4]!._id),
    });
  });
});

describe("the backlog gauges (D5)", () => {
  it("saturates eventsBehind at GAUGE_COUNT_LIMIT and still reports oldestUnappliedAt", async () => {
    const h = await harness({ cursor: FROM_START });
    const seeded = await h.seed(
      ...Array.from({ length: GAUGE_COUNT_LIMIT + 10 }, (_, i) => ({
        publishedAt: at(100 + i),
        dedupeKey: `k${i + 1}`,
      })),
    );
    // Fault the very FIRST event, so nothing applies and the whole log is behind.
    h.db.failNext(
      OPS_NOTIFICATIONS_COLLECTION,
      "insertOne",
      new Error("injected"),
      (ctx) => ctx.document?.dedupeKey === "k1",
    );

    const result = await h.phase.run(NOW);

    expect(result.ok).toBe(false);
    // "At least N" — the count is bounded, never a full collection scan.
    expect(result.eventsBehind).toBe(GAUGE_COUNT_LIMIT);
    expect(result.oldestUnappliedAt).toEqual(seeded[0]!.publishedAt);
    // No event was fully applied, so the cursor never moved.
    expect(result.cursorAt).toEqual(FROM_START.publishedAt);
    expect(await h.store.readCursor()).toEqual(FROM_START);
  });
});

describe("the stopped checkpoint (D5/D10)", () => {
  it("stops between events, and a following run resumes at the third", async () => {
    let stopping = true;
    const h = await harness({
      cursor: FROM_START,
      // True from the third event onward: two rows exist by then.
      stopped: () => stopping && h.rows().length >= 2,
    });
    const seeded = await h.seed(
      ...Array.from({ length: 5 }, (_, i) => ({ publishedAt: at(100 + i), dedupeKey: `k${i + 1}` })),
    );

    const first = await h.phase.run(NOW);

    expect(first.stoppedEarly).toBe(true);
    // A stop is not a fault.
    expect(first.ok).toBe(true);
    expect(h.counters.ingestFaults).toBe(0);
    expect(h.counters.eventsApplied).toBe(2);
    expect(h.rows().map((r) => r.dedupeKey)).toEqual(["k1", "k2"]);
    expect(await h.store.readCursor()).toEqual({
      publishedAt: seeded[1]!.publishedAt,
      eventId: String(seeded[1]!._id),
    });
    // Always reported, on the stopped stop too.
    expect(first.oldestUnappliedAt).toEqual(seeded[2]!.publishedAt);
    expect(first.eventsBehind).toBe(3);

    stopping = false;
    const second = await h.phase.run(NOW);

    expect(second).toEqual({
      ok: true,
      stoppedEarly: false,
      cursorAt: seeded[4]!.publishedAt,
      eventsBehind: 0,
      oldestUnappliedAt: null,
    });
    expect(h.rows().map((r) => r.dedupeKey)).toEqual(["k1", "k2", "k3", "k4", "k5"]);
  });

  it("reads no event page at all when stopped before the first one", async () => {
    const h = await harness({ cursor: FROM_START, stopped: () => true });
    await h.seed(...Array.from({ length: 3 }, (_, i) => ({ publishedAt: at(100 + i), dedupeKey: `k${i + 1}` })));
    const mark = h.mark();

    const result = await h.phase.run(NOW);

    expect(result.stoppedEarly).toBe(true);
    expect(result.ok).toBe(true);
    expect(h.counters.eventsApplied).toBe(0);
    expect(h.rows()).toHaveLength(0);
    const eventOps = h.since(mark).filter((op) => op.collection === OPS_EVENTS_COLLECTION);
    // The PAGE read never happened...
    expect(eventOps.filter((op) => op.operation === "find")).toHaveLength(0);
    // ...but the gauge pair is always paid, so no caller has to know which
    // stop produced this result.
    expect(eventOps.map((op) => op.operation)).toEqual(["findOne", "countDocuments"]);
    expect(result.eventsBehind).toBe(3);
    expect(result.oldestUnappliedAt).toEqual(at(100));
    // Nothing applied ⇒ no cursor write.
    expect(h.since(mark).filter((op) => op.collection === "telemetry" && op.operation === "updateOne")).toHaveLength(0);
  });
});
