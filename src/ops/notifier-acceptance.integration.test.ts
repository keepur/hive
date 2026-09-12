/**
 * KPR-468 chunk 6 — the AC1–AC17 acceptance suite.
 *
 * SEVENTEEN criterion `describe`s across two files: AC2 and AC15's structural
 * half live in `notifier-isolation.test.ts`; the other sixteen — AC1, AC3–AC14,
 * AC15's runtime half, AC16 and AC17 — are here. A `describe` whose body is
 * prose is an empty suite that reports nothing, so every one of them carries at
 * least one real, asserting `it`.
 *
 * These are THE CRITERIA, not a second copy of the module suites. Chunks 2–4
 * each carry their own unit and integration coverage; what is re-driven here is
 * the subset a KPR-458 conformance criterion names, plus the ABLE-TO-FAIL cases
 * the spec calls out — the ones written so that a plausible-but-wrong
 * implementation goes red. Six of the plan's eight numbered negative-verify
 * points are hosted here (NV1–NV5 and NV7, seven mutations); NV6 is chunk 3b's
 * and NV8 is chunk 5's.
 *
 * Two standing rules:
 *  - every publish→assert and sweep→assert boundary goes through `h.tick()`
 *    (`OpsNotifier.__tickForTests()`), never a bare assertion after `start()`;
 *  - every fixture, seed, fault helper and the `FakeTransport` come from
 *    `./testing/notifier-harness.js`. Nothing here builds a `FakeDb` or an
 *    `OpsNotifier` by hand EXCEPT AC14, which must watch `init()` itself fail
 *    and therefore cannot use a harness that has already called it; and nothing
 *    here imports another `.test.ts` (vitest re-registers an imported test
 *    file's suites into the importer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The logger is mocked so AC9's "a log line and a counter" and AC11's
// warn-once claim can be COUNTED rather than asserted in prose. `vi.hoisted` is
// required — `vi.mock` factories are hoisted above top-level `const`s
// (delivery.integration.test.ts:17's precedent).
const mockLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));

import { ObjectId } from "mongodb";
import { __resetCadenceWarningsForTests } from "./delivery.js";
import { OpsNotifier } from "./notifier.js";
import { SWEEP_CURSOR_KIND } from "./notification-store.js";
import { __resetOpsNotifierForTests, acceptOpsAcknowledgement, setOpsNotifier } from "./notifier-singleton.js";
import { OpsPublisher } from "./publisher.js";
import { HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED } from "./reasons.js";
import { SlackOpsTransport } from "./slack-transport.js";
import { renderRemediation, type NotificationView } from "./transport.js";
import {
  ATTEMPTS_RING_CAP,
  DELIVERY_ARM_PAGE_SIZE,
  HARD_SNOOZE_CEILING_MS,
  OPS_NOTIFICATIONS_COLLECTION,
  OPS_POLICY_COLLECTION,
  OPS_POLICY_ID,
  OPS_SYSTEM_PRINCIPAL,
  STALL_RECHECK_MS,
  type OpsAcknowledgement,
  type OpsNotification,
  type OpsPolicy,
} from "./notification-types.js";
import {
  OPS_EVENTS_COLLECTION,
  OPS_REASONS_COLLECTION,
  OPS_SUBSCRIPTIONS_COLLECTION,
  type OpsClass,
  type OpsEvidence,
  type OpsSubscription,
} from "./types.js";
import { FakeDb } from "./testing/fake-db.js";
import {
  BASE,
  FakeTransport,
  failNth,
  failOn,
  harness,
  reason,
  sub,
  t,
  type NotifierHarness,
} from "./testing/notifier-harness.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The notifier's OWN file set — the same list `notifier-isolation.test.ts`
 * scans, restated here because AC8's `updateMany` scan and AC1's
 * no-default-subscription companion read it too. KPR-454's producer modules and
 * every test double are deliberately outside it.
 */
const NOTIFIER_FILES = [
  "notification-types.ts",
  "transport.ts",
  "slack-transport.ts",
  "notification-store.ts",
  "ingest.ts",
  "delivery.ts",
  "notifier.ts",
  "intake.ts",
  "notifier-singleton.ts",
].map((f) => join(here, f));

const MINUTE = 60_000;
const HOUR = 3_600_000;
const CADENCE = 600_000;
/** `ledgerRetentionDays(90)` — the harness's default activity retention, capped. */
const RETENTION_MS = 30 * 86_400_000;

/** AC4's own key, spelled as the plan spells it. */
const KEY = "p:tool:gog:tool-failed:0";
/** A clearable condition, and the recovery keys that clear it. */
const CONDITION_KEY = "tool:workItem:w1:r1:0";
const recoveryKey = (n: number) => `tool:workItem:w1:recovered:${n}`;

const policyWith = (over: Partial<OpsPolicy> = {}): OpsPolicy => ({
  _id: OPS_POLICY_ID,
  cadence: { "integrity:deterministic": CADENCE },
  ...over,
});

const warnLines = (fragment: string) => mockLog.warn.mock.calls.filter((call) => String(call[0]).includes(fragment));

const hasKey = (row: object, key: string) => Object.prototype.hasOwnProperty.call(row, key);

/** D5's due-scan predicate, spelled exactly as the delivery arms spell it. */
const DUE = (now: Date) => ({ state: { $in: ["pending", "delivered"] }, nextNudgeAt: { $lte: now } });

/**
 * Every ops_events operation that is not a read, from `mark` onward. AC9's
 * oracle. The mark is not optional bookkeeping: the HARNESS seeds `ops_events`
 * with its own `insertOne`, so an unmarked read would count the fixture's
 * writes as the notifier's and the criterion would be unassertable.
 */
const opsEventWrites = (h: NotifierHarness, mark: number) =>
  h.db.operations
    .slice(mark)
    .filter(
      (o) => o.collection === OPS_EVENTS_COLLECTION && !["find", "findOne", "countDocuments"].includes(o.operation),
    );

let seq = 0;

/**
 * A fully-formed ledger row, for the fixtures that must exist WITHOUT being
 * grown through ingest (AC7's starvation backlog, AC8's intake rules, AC13's
 * per-row containment limbs). `resource` by default so a dismissal is legal.
 */
function ledgerRow(over: Partial<OpsNotification> = {}): OpsNotification {
  seq += 1;
  return {
    subscriptionId: "s1",
    subscriberId: "s1-owner",
    dedupeKey: `tool:workItem:w1:r1:${seq}`,
    producer: "tool",
    reasonId: "r1",
    class: "resource",
    waiting: "nobody",
    retry: "transient",
    subject: { kind: "workItem", id: "w1" },
    generation: 1,
    firstEventId: "000000000000000000000001",
    latestEventId: "000000000000000000000001",
    eventCount: 1,
    firstSeenAt: BASE,
    lastEventAt: BASE,
    state: "delivered",
    stateAt: BASE,
    principal: OPS_SYSTEM_PRINCIPAL,
    principalAt: BASE,
    attempts: [],
    attemptCount: 1,
    nudgeCount: 0,
    // Far in the future, so no delivery arm draws a seeded row unless a case
    // deliberately sets it into the past.
    nextNudgeAt: t(10_000),
    appliedThroughAt: BASE,
    appliedThroughId: "000000000000000000000001",
    latestDetail: {},
    latestEvidence: [],
    ...over,
  };
}

/** ⚠ The double does not write `_id` back onto the caller's document (fake-db divergence 4). */
async function seedLedgerRow(
  h: NotifierHarness,
  over: Partial<OpsNotification> = {},
): Promise<{ id: ObjectId; handle: string }> {
  const res = await h.store.notifications.insertOne(ledgerRow(over));
  return { id: res.insertedId as ObjectId, handle: String(res.insertedId) };
}

const rowById = async (h: NotifierHarness, id: ObjectId): Promise<OpsNotification> => {
  const row = await h.store.notifications.findOne({ _id: id });
  if (!row) throw new Error("no ledger row for that id");
  return row as OpsNotification;
};

const ack = (handle: string, over: Partial<OpsAcknowledgement> = {}): OpsAcknowledgement => ({
  handle,
  act: "seen",
  actorId: "U1",
  at: BASE,
  ...over,
});

/** Every ledger row, as one comparable string. The "byte-identical" oracle. */
async function ledgerSnapshot(h: NotifierHarness): Promise<string> {
  const rows = await h.store.notifications.find({}).sort({ _id: 1 }).toArray();
  return JSON.stringify(rows);
}

beforeEach(() => {
  mockLog.debug.mockClear();
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
});

afterEach(() => {
  __resetOpsNotifierForTests();
});

// ───────────────────────────────────────────────────────────────────────────
// AC1
// ───────────────────────────────────────────────────────────────────────────

describe("AC1 — with no subscriptions nothing is minted, nothing is delivered (C2, C3)", () => {
  it("ingesting any number of events with an EMPTY ops_subscriptions creates zero rows and zero deliveries", async () => {
    const h = await harness(); // no subscriptions at all — the shipped default
    await h.seedEvents(25);
    const before = JSON.stringify(h.db.collection(OPS_EVENTS_COLLECTION).rows);
    const mark = h.db.operations.length;

    await h.tick();

    expect(await h.ledgerCount()).toBe(0);
    expect(h.transport.views).toHaveLength(0);
    expect(h.snapshot().eventsApplied).toBe(25);
    expect(h.snapshot().rowsCreated).toBe(0);
    // The events themselves are BYTE-IDENTICAL — the ledger child never writes
    // to the log it reads (AC9's structural cousin).
    expect(JSON.stringify(h.db.collection(OPS_EVENTS_COLLECTION).rows)).toBe(before);
    expect(opsEventWrites(h, mark)).toEqual([]);
  });

  it("registers NO adapter of its own, and a due row with an unbound adapter STALLS rather than falling back", async () => {
    const h = await harness({ subscriptions: [sub("s1")], transport: null });
    // `adapters` is `[...transports.keys()]` — an empty list IS transports.size === 0.
    expect(h.snapshot().adapters).toEqual([]);

    const e = await h.seedEvent();
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.state).toBe("pending");
    expect(row.attemptCount).toBe(0);
    expect(row.stalledReason).toBe("transport");
    expect(h.snapshot().transportUnbound).toBe(1);
    // No fallback recipient was invented for it.
    expect(h.transport.views).toHaveLength(0);
  });

  it("only ever READS ops_subscriptions — no code path creates a default subscription", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    // The harness seeds the fixture's own rows with an insertOne before this
    // mark; everything after it is the notifier's.
    const mark = h.db.operations.length;
    await h.seedEvent();
    await h.tick();
    await h.notifier.reloadSubscriptions();

    const ops = h.db.operations.slice(mark).filter((o) => o.collection === OPS_SUBSCRIPTIONS_COLLECTION);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.map((o) => o.operation).filter((op) => op !== "find")).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC3
// ───────────────────────────────────────────────────────────────────────────

describe("AC3 — ingest reads the STAMPED list and never re-evaluates a match (C17)", () => {
  it("creates a row for the stamped subscription ONLY, even when an enabled peer would also match", async () => {
    // s2's filter is the one that WOULD match this event's attributes. Nothing
    // evaluates it, so nothing acquires the event.
    const h = await harness({ subscriptions: [sub("s1"), sub("s2", { filter: { producer: ["tool"] } })] });
    const e = await h.seedEvent({ matchedSubscriptionIds: ["s1"] });

    await h.tick();

    expect(await h.ledgerCount()).toBe(1);
    expect((await h.row("s1", e.dedupeKey)).subscriptionId).toBe("s1");
    await expect(h.row("s2", e.dedupeKey)).rejects.toThrow(/no ledger row/);
  });

  it("a stamped id whose subscription has since been DISABLED yields no row and leaves the stored count untouched", async () => {
    const h = await harness({ subscriptions: [sub("s1"), sub("s2")] });
    await h.db.collection(OPS_SUBSCRIPTIONS_COLLECTION).updateOne({ _id: "s2" }, { $set: { enabled: false } });
    await h.notifier.reloadSubscriptions();

    const e = await h.seedEvent(); // still stamped [s1, s2] — the accept-time truth
    expect(e.matchedSubscriptions).toBe(2);
    await h.tick();

    expect(await h.ledgerCount()).toBe(1);
    expect((await h.row("s1", e.dedupeKey)).subscriptionId).toBe("s1");
    // The count STILL STANDS: it was honest for the set that existed at accept
    // and was never a delivery promise.
    const stored = (await h.db.collection(OPS_EVENTS_COLLECTION).findOne({ _id: e._id }))!;
    expect(stored.matchedSubscriptions).toBe(2);
    expect(stored.matchedSubscriptionIds).toEqual(["s1", "s2"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC4 — ⛳ NV1
// ───────────────────────────────────────────────────────────────────────────

describe("AC4 — re-processing any prefix of the log is a total no-op (C17)", () => {
  it("leaves eventCount at 2 when a page holding TWO events for one dedupeKey is replayed", async () => {
    // ⚠ THE ABLE-TO-FAIL CASE. D12 offers `latestEventId` equality, which
    // guards an exact replay of the LAST event only. A crash mid-page
    // re-processes a page in which one dedupeKey was touched twice, and the
    // OLDER of the two touches then passes an equality test and double-counts.
    //
    // Both wrong implementations are PREDICTED, because a wrong predicted
    // number is what gets a genuine harness bug filed as an implementation bug:
    //   - unconditional $set of the event fields  ⇒ 4
    //     (the replay admits e1, which also REGRESSES latestEventId to e1, and
    //      then admits e2 as well)
    //   - refuse-to-regress latestEventId + equality ⇒ 3
    //     (e1 replays, leaving latestEventId at e2, whose own equality test
    //      then blocks it)
    const h = await harness({ subscriptions: [sub("s1")] });
    const e1 = await h.seedEvent({ dedupeKey: KEY, publishedAt: t(0) });
    const e2 = await h.seedEvent({ dedupeKey: KEY, publishedAt: t(1) });
    await h.tick();
    expect(await h.row("s1", KEY)).toMatchObject({ eventCount: 2, latestEventId: String(e2._id) });
    expect(String(e1._id) < String(e2._id)).toBe(true);

    // Simulate the crash D12 describes: rewind the cursor to before e1 and
    // re-run. Every ledger write from the first pass must be a no-op.
    await h.store.writeCursor({ publishedAt: t(-1), eventId: null });
    await h.tick();

    const row = await h.row("s1", KEY);
    expect(row.eventCount).toBe(2);
    expect(row.latestEventId).toBe(String(e2._id));
    expect(row.attemptCount).toBe(1); // one delivery on the first tick, none added
    expect(row.nudgeCount).toBe(0);
  });

  it("discards an out-of-order (older) event rather than applying it", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const e1 = await h.seedEvent({ dedupeKey: KEY, publishedAt: t(0), detail: { tool: "first" } });
    const e2 = await h.seedEvent({ dedupeKey: KEY, publishedAt: t(2), detail: { tool: "second" } });
    await h.tick();
    expect(await h.row("s1", KEY)).toMatchObject({ eventCount: 2, latestDetail: { tool: "second" } });

    // A BACKDATED publication — the shape a clock-skewed producer yields —
    // swept only now, with the cursor rewound so the page actually returns it.
    // Without the rewind it would sit behind the cursor and never be offered to
    // the watermark at all, which would make this case assert nothing.
    const older = await h.seedEvent({ dedupeKey: KEY, publishedAt: t(1), detail: { tool: "backdated" } });
    await h.store.writeCursor({ publishedAt: t(0), eventId: String(e1._id) });
    await h.tick();

    const after = await h.row("s1", KEY);
    expect(after.eventCount).toBe(2);
    expect(after.latestEventId).toBe(String(e2._id));
    expect(after.latestDetail).toEqual({ tool: "second" });
    expect(after.appliedThroughAt).toEqual(t(2));
    expect(after.appliedThroughId).toBe(String(e2._id));
    expect(after.latestEventId).not.toBe(String(older._id));
    // Both re-offered events fell through to arm C and were caught by the
    // unique index — the one signal that says "not newer" rather than "absent".
    expect(h.snapshot().renewalStale).toBe(2);
  });

  it("leaves state, attemptCount and nudgeCount byte-identical across a whole-prefix replay", async () => {
    // ⚠ The prefix deliberately contains a TWICE-TOUCHED dedupeKey. A page of
    // five events on five distinct keys is guarded by D12's bare equality test
    // alone, so a fixture without a repeat asserts nothing the headline case
    // above does not already cover, and stays green against BOTH wrong
    // implementations.
    const h = await harness({ subscriptions: [sub("s1"), sub("s2")] });
    await h.seedEvent({ publishedAt: t(0) });
    await h.seedEvent({ publishedAt: t(1) });
    await h.seedEvent({ dedupeKey: KEY, publishedAt: t(2) });
    await h.seedEvent({ publishedAt: t(3) });
    await h.seedEvent({ dedupeKey: KEY, publishedAt: t(4) });
    await h.tick();
    expect(await h.ledgerCount()).toBe(8); // four distinct keys × two subscriptions
    expect(await h.row("s1", KEY)).toMatchObject({ eventCount: 2 });

    const before = await ledgerSnapshot(h);
    await h.store.writeCursor({ publishedAt: t(-1), eventId: null });
    await h.tick();

    // Not "the counters agree" — the whole ledger, field for field.
    expect(await ledgerSnapshot(h)).toBe(before);
    expect(h.snapshot().rowsCreated).toBe(8);
    expect(h.snapshot().rowsRenewed).toBe(2);
    expect(h.snapshot().renewalStale).toBe(10); // five events × two subscriptions
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC5
// ───────────────────────────────────────────────────────────────────────────

describe("AC5 — the cursor advances only after the page's ledger writes (C17)", () => {
  it("a crash between the ledger writes and the cursor write RE-PROCESSES rather than skips", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const e = await h.seedEvent();
    // Discard the cursor write — the exact window D3 orders against. It sits
    // outside every per-event try, so it reaches the tick's own containment.
    failOn(
      h.db,
      "telemetry",
      "updateOne",
      (ctx) => (ctx.update?.$set as { kind?: string } | undefined)?.kind === SWEEP_CURSOR_KIND,
    );

    await expect(h.tick()).resolves.toBeUndefined();

    // The LEDGER write landed; the cursor did not.
    expect((await h.row("s1", e.dedupeKey)).eventCount).toBe(1);
    expect(await h.store.readCursor()).toEqual({ publishedAt: t(-1), eventId: null });
    expect((await h.heartbeat()).state).toBe("degraded");

    await h.tick(); // the crash's replay

    const after = await h.row("s1", e.dedupeKey);
    expect(after.eventCount).toBe(1); // re-processed, never double-counted
    expect(h.snapshot().rowsCreated).toBe(1);
    expect(h.snapshot().renewalStale).toBe(1);
    expect((await h.store.readCursor())!.eventId).toBe(String(e._id));
  });

  it("an ABSENT cursor initializes to the clock, counts it, and creates NO rows for events already in the log", async () => {
    // The one place the harness's seeded default is deliberately turned off.
    const h = await harness({ subscriptions: [sub("s1")], cursorAt: null });
    await h.seedEvents(50);
    // Every one of the 50 is now strictly BEHIND the instant the cursor will
    // take, so "no backfill" is a claim about all of them rather than about the
    // first tick's timing.
    h.advance(HOUR);

    await h.tick();

    expect(h.snapshot().cursorReinitialized).toBe(1);
    expect(h.snapshot().eventsApplied).toBe(0);
    expect(await h.ledgerCount()).toBe(0);
    expect(await h.store.readCursor()).toEqual({ publishedAt: h.now(), eventId: null });
    expect(warnLines("ops sweep cursor absent")).toHaveLength(1);

    await h.tick(); // and the log stays behind it forever

    expect(await h.ledgerCount()).toBe(0);
    expect(h.snapshot().eventsApplied).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC6 — ⛳ NV2, NV3
// ───────────────────────────────────────────────────────────────────────────

describe("AC6 — clearing (D4, D8)", () => {
  /** The condition, delivered, on however many subscriptions the harness holds. */
  const openCondition = async (h: NotifierHarness, cls: OpsClass = "resource") => {
    await h.seedEvent({ dedupeKey: CONDITION_KEY, class: cls, publishedAt: t(0) });
    await h.tick();
  };

  /**
   * A clearing fact. STAMPED with a matching subscription by default, and that
   * default is deliberate: the zero-match case below is the ONE case about the
   * fan-out's SCOPE, so every other case here carries a stamp a match-scoped
   * implementation would still reach. Without that split, a scope regression
   * would redden the whole block and the one case that isolates it would prove
   * nothing.
   */
  const clearingEvent = (n: number, over: Record<string, unknown> = {}) => ({
    dedupeKey: recoveryKey(n),
    clears: CONDITION_KEY,
    class: "informational" as OpsClass,
    reasonId: "recovered",
    publishedAt: t(n + 1),
    matchedSubscriptionIds: ["s1"],
    ...over,
  });

  it("a clearing event with ZERO matchedSubscriptionIds clears EVERY row on the named dedupeKey", async () => {
    // ⚠ ABLE-TO-FAIL against a match-scoped implementation. A clearing reason
    // is `informational` and normally matches NOBODY, so a match-scoped
    // clearing would clear nothing, every `resource` condition would nudge
    // forever, and D12's own guarantee that recovering resource conditions
    // fall silent on their own would be false.
    const h = await harness({ subscriptions: [sub("s1"), sub("s2")] });
    await openCondition(h);
    expect(await h.ledgerCount()).toBe(2);

    // A real `informational` recovery reason matches NOBODY. This is the one
    // case that drives that shape.
    const clearing = await h.seedEvent(clearingEvent(0, { matchedSubscriptionIds: [] }));
    expect(clearing.matchedSubscriptionIds).toEqual([]);
    h.advance(MINUTE);
    await h.tick();

    for (const id of ["s1", "s2"]) {
      const row = await h.row(id, CONDITION_KEY);
      expect(row.state, id).toBe("cleared");
      expect(row.principal, id).toBe(OPS_SYSTEM_PRINCIPAL);
      expect(row.stateEventId, id).toBe(String(clearing._id));
      // stateAt is the TICK's now, never the event's publishedAt — expiresAt
      // derives from it, so a backlogged sweep must not shorten retention.
      expect(row.stateAt, id).toEqual(h.now());
      expect(row.expiresAt, id).toEqual(new Date(h.now().getTime() + RETENTION_MS));
      expect(hasKey(row, "nextNudgeAt"), id).toBe(false);
    }
    expect(h.snapshot().rowsCleared).toBe(2);
    expect(h.snapshot().clearRefused).toBe(0);
  });

  const PROVENANCE: Array<[string, OpsClass, OpsEvidence[], boolean]> = [
    ["resource clears on the producer's word alone", "resource", [], true],
    ["judgment without evidence does not clear", "judgment", [], false],
    ["judgment with evidence clears", "judgment", [{ kind: "work-item", id: "w1" }], true],
    ["integrity without evidence does not clear", "integrity", [], false],
    ["integrity with evidence clears", "integrity", [{ kind: "work-item", id: "w1" }], true],
    ["informational never clears", "informational", [{ kind: "work-item", id: "w1" }], false],
  ];

  it.each(PROVENANCE)(
    "provenance — %s (every failing case increments clearRefused and transitions nothing)",
    async (_label, cls, evidence, clears) => {
      const h = await harness({ subscriptions: [sub("s1")] });
      await openCondition(h, cls);
      const before = await h.row("s1", CONDITION_KEY);

      await h.seedEvent(clearingEvent(0, { evidence }));
      h.advance(MINUTE);
      await h.tick();

      const after = await h.row("s1", CONDITION_KEY);
      expect(after.state).toBe(clears ? "cleared" : before.state);
      expect(h.snapshot().rowsCleared).toBe(clears ? 1 : 0);
      expect(h.snapshot().clearRefused).toBe(clears ? 0 : 1);
      if (!clears) {
        expect(after.stateAt).toEqual(before.stateAt);
        expect(hasKey(after, "stateEventId")).toBe(false);
      }
    },
  );

  it("a dismissed row CLEARS and a cleared row is a no-op", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    await openCondition(h);
    const row = await h.row("s1", CONDITION_KEY);

    h.advance(MINUTE);
    await expect(h.notifier.accept(ack(String(row._id), { act: "dismissed", at: h.now() }))).resolves.toMatchObject({
      state: "applied",
      rowState: "dismissed",
    });

    const clearing = await h.seedEvent(clearingEvent(0));
    h.advance(MINUTE);
    await h.tick();

    const cleared = await h.row("s1", CONDITION_KEY);
    expect(cleared.state).toBe("cleared");
    expect(cleared.principal).toBe(OPS_SYSTEM_PRINCIPAL);
    expect(h.snapshot().rowsCleared).toBe(1);

    // ... and an exact REPLAY of that same clearing event changes nothing.
    const snapshot = await ledgerSnapshot(h);
    await h.store.writeCursor({ publishedAt: t(0), eventId: null });
    h.advance(MINUTE);
    await h.tick();
    expect(await ledgerSnapshot(h)).toBe(snapshot);
    expect(h.snapshot().rowsCleared).toBe(1);
    expect(String(clearing._id)).toHaveLength(24);
  });

  it("a NEWER clearing fact on an already-cleared row changes nothing and counts nothing", async () => {
    // ⚠ THE PLAN-WRITER'S OWN DEVIATION, tested as one. D4 says the cleared-row
    // no-op happens "by the D3 watermark", and the watermark ALONE admits a
    // strictly newer clearing fact: state stays `cleared`, but stateAt,
    // stateEventId, appliedThrough* and expiresAt all advance, so a flapping
    // recovery extends a closed row's retention horizon indefinitely. The
    // implementation adds `state: { $ne: "cleared" }` to the clearing CAS,
    // which makes this a matchedCount-0 no-op instead.
    const h = await harness({ subscriptions: [sub("s1")] });
    await openCondition(h);
    const first = await h.seedEvent(clearingEvent(0));
    h.advance(MINUTE);
    await h.tick();

    const cleared = await h.row("s1", CONDITION_KEY);
    expect(cleared.state).toBe("cleared");
    expect(cleared.stateEventId).toBe(String(first._id));
    const clearedCount = h.snapshot().rowsCleared;
    const refusedCount = h.snapshot().clearRefused;

    // A strictly NEWER clearing fact with IDENTICAL provenance. The clock moves
    // first, so every field this write could touch would visibly move.
    h.advance(HOUR);
    await h.seedEvent(clearingEvent(1));
    await h.tick();

    const after = await h.row("s1", CONDITION_KEY);
    for (const field of [
      "state",
      "stateAt",
      "stateEventId",
      "expiresAt",
      "appliedThroughAt",
      "appliedThroughId",
    ] as const) {
      expect(JSON.stringify(after[field]), field).toBe(JSON.stringify(cleared[field]));
    }
    // NEITHER counter moved — the second is deliberate: a cleared row PASSES
    // provenance, so counting a refusal would be a lie about why nothing
    // happened.
    expect(h.snapshot().rowsCleared).toBe(clearedCount);
    expect(h.snapshot().clearRefused).toBe(refusedCount);
  });

  it("a clearing event from ANOTHER producer does not clear, and increments clearRefused", async () => {
    // ⚠ ITS OWN ROW rather than riding along incidentally. C19 enforces
    // clearsReasonIds membership at publish over the REASONID COMPONENT ONLY,
    // so a `clears` naming another producer's dedupeKey whose reasonId happens
    // to collide passes publish intact. This clause is the only check that
    // catches it.
    const h = await harness({ subscriptions: [sub("s1")] });
    await openCondition(h); // producer "tool", class resource
    const before = await h.row("s1", CONDITION_KEY);

    await h.seedEvent(
      clearingEvent(0, {
        producer: "other",
        dedupeKey: "other:workItem:w1:recovered:0",
        evidence: [{ kind: "work-item", id: "w1" }],
      }),
    );
    h.advance(MINUTE);
    await h.tick();

    const after = await h.row("s1", CONDITION_KEY);
    expect(after.state).toBe(before.state);
    expect(after.state).not.toBe("cleared");
    expect(h.snapshot().clearRefused).toBe(1);
    expect(h.snapshot().rowsCleared).toBe(0);
  });

  it("a clearing event naming a dedupeKey with NO row is a counted no-op", async () => {
    // Openness is answered from the LOG, not the ledger (D8).
    const h = await harness({ subscriptions: [sub("s1")] });
    // Unstamped, so "the ledger is empty" stays the whole claim. Scope is
    // irrelevant here either way: with no rows on the key the fan-out counts
    // and returns before any per-row work.
    await h.seedEvent(clearingEvent(0, { clears: "tool:workItem:nobody:r1:0", matchedSubscriptionIds: [] }));
    await h.tick();

    expect(h.snapshot().clearNoRow).toBe(1);
    expect(h.snapshot().rowsCleared).toBe(0);
    expect(h.snapshot().clearRefused).toBe(0);
    expect(await h.ledgerCount()).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC7 — ⛳ NV4
// ───────────────────────────────────────────────────────────────────────────

describe("AC7 — delivery and nudging (C8, C10)", () => {
  it("accepted transitions pending → delivered, records the reference, and schedules from the RESOLVED cadence", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    const e = await h.seedEvent();
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.state).toBe("delivered");
    expect(row.stateAt).toEqual(BASE);
    expect(row.lastOutcome).toBe("accepted");
    expect(row.deliveryReference).toEqual({ kind: "fake", id: String(row._id) });
    expect(row.nextNudgeAt).toEqual(new Date(BASE.getTime() + CADENCE));
  });

  it.each(["rejected", "unknown"] as const)(
    "%s leaves the state unchanged and never reaches delivered",
    async (kind) => {
      const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
      h.transport.program(
        kind === "rejected"
          ? { status: "rejected", reason: "target-unknown" }
          : { status: "unknown", reason: "timeout" },
      );
      const e = await h.seedEvent();
      await h.tick();

      const row = await h.row("s1", e.dedupeKey);
      expect(row.state).toBe("pending");
      expect(row.lastOutcome).toBe(kind);
      expect(row.deliveryReference).toBeUndefined();
      expect(row.attemptCount).toBe(1);
      // The schedule is the CADENCE's on every outcome alike — the outcome never
      // changes the schedule, only the state.
      expect(row.nextNudgeAt).toEqual(new Date(BASE.getTime() + CADENCE));
    },
  );

  it("NO automatic resend follows an `unknown` — the next attempt is the cadence's, not a retry's", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    h.transport.program({ status: "unknown", reason: "timeout" });
    await h.seedEvent();
    await h.tick();
    expect(h.transport.views).toHaveLength(1);

    // Three ticks short of the cadence. A retry ladder would have fired by now.
    for (let i = 0; i < 3; i += 1) {
      h.advance(CADENCE / 4);
      await h.tick();
      expect(h.transport.views, `at +${((i + 1) * CADENCE) / 4}ms`).toHaveLength(1);
    }

    h.advance(CADENCE / 4); // exactly the cadence boundary
    await h.tick();
    expect(h.transport.views).toHaveLength(2);
  });

  it("a nudge re-delivers the SAME row: ten nudges, ONE document, and nudgeCount excludes the first attempt", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    const e = await h.seedEvent();
    await h.tick();

    for (let i = 0; i < 10; i += 1) {
      h.advance(CADENCE);
      await h.tick();
    }

    const row = await h.row("s1", e.dedupeKey);
    expect(await h.ledgerCount()).toBe(1); // the ledger did not grow a row per nudge
    expect(h.transport.views).toHaveLength(11);
    expect(row.attemptCount).toBe(11);
    expect(row.nudgeCount).toBe(10);
    // No attempt ceiling, no terminal give-up: the eleventh attempt is an
    // ordinary one, and attempts[] is a RING while attemptCount keeps counting.
    expect(row.attempts).toHaveLength(ATTEMPTS_RING_CAP);
    expect(h.snapshot().deliveriesAccepted).toBe(11);
  });

  it("a freshly-minted row is delivered on a tick where a large stall backlog is already due", async () => {
    // ⚠ THE STARVATION CASE, and it is its own able-to-fail limb because the
    // property is STRUCTURAL: a single-query implementation passes every other
    // assertion in this block.
    //
    // More cadence-unresolved stalled rows than one arm's page can hold, all
    // carrying OLDER nextNudgeAt values than the fresh row — so they sort ahead
    // of it and fill any single ascending `{ state, nextNudgeAt }` page
    // completely. Arms 1 and 2 carry an equality bound on their index's leading
    // key, so the backlog is not in their buckets AT ALL.
    const h = await harness({ subscriptions: [sub("s1")] });
    for (let i = 0; i < DELIVERY_ARM_PAGE_SIZE; i += 1) {
      await h.store.notifications.insertOne(
        ledgerRow({
          dedupeKey: `stalled-${i}`,
          state: "delivered",
          attemptCount: 1,
          stalledAt: BASE,
          stalledReason: "cadence",
          nextNudgeAt: new Date(BASE.getTime() + i),
          deliveryReference: { kind: "fake", id: `ref-${i}` },
        }),
      );
    }
    h.advance(STALL_RECHECK_MS * 2); // every stalled row is now due
    const e = await h.seedEvent({ publishedAt: t(0) });

    await h.tick();

    const fresh = await h.row("s1", e.dedupeKey);
    expect(fresh.state).toBe("delivered");
    expect(fresh.attemptCount).toBe(1);
    expect(h.transport.views).toHaveLength(1);
    expect(h.transport.views[0]!.handle).toBe(String(fresh._id));
    // The backlog WAS observed — it was declined, which is the point: the fresh
    // row was not behind it.
    expect(h.snapshot().cadenceUnresolved).toBe(DELIVERY_ARM_PAGE_SIZE);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC8 — ⛳ NV7
// ───────────────────────────────────────────────────────────────────────────

describe("AC8 — every transition to seen/dismissed/snoozed arrives through accept() (C9)", () => {
  it("records a stable actor id and instant, and a replayed act is an idempotent noop", async () => {
    const h = await harness();
    const { id, handle } = await seedLedgerRow(h);

    h.advance(MINUTE);
    const at = h.now();
    await expect(h.notifier.accept(ack(handle, { actorId: "U0ACKER", at }))).resolves.toEqual({
      state: "applied",
      rowState: "seen",
    });
    const applied = await rowById(h, id);
    expect(applied.principal).toBe("U0ACKER");
    expect(applied.principalAt).toEqual(at);
    expect(applied.stateAt).toEqual(at);
    expect(applied.lastAckKey).toBe(`U0ACKER:seen:${at.toISOString()}`);

    const before = JSON.stringify(applied);
    await expect(h.notifier.accept(ack(handle, { actorId: "U0ACKER", at }))).resolves.toEqual({
      state: "noop",
      reason: "already-applied",
    });
    expect(JSON.stringify(await rowById(h, id))).toBe(before);
  });

  it("a duplicated dismissal returns noop/already-applied, NOT refused/illegal-transition", async () => {
    // The replay check precedes legality. `dismissed` is not a legal FROM
    // state, so a legality-first order tells the acknowledger their own
    // duplicated callback failed.
    const h = await harness();
    const { handle } = await seedLedgerRow(h);
    const input = ack(handle, { act: "dismissed" });

    await expect(h.notifier.accept(input)).resolves.toEqual({ state: "applied", rowState: "dismissed" });
    await expect(h.notifier.accept(input)).resolves.toEqual({ state: "noop", reason: "already-applied" });
    expect(h.snapshot().intakeRefused).toBe(0);
  });

  it("a delayed duplicate of an OLDER act is superseded, not applied", async () => {
    // ⚠ ABLE-TO-FAIL on the monotonicity guard specifically: `lastAckKey` alone
    // passes the duplicate test above and fails this one, because the replayed
    // act's key differs from the row's.
    const h = await harness();
    const { id, handle } = await seedLedgerRow(h);

    h.advance(MINUTE);
    const first = h.now();
    const seen = ack(handle, { act: "seen", at: first });
    await expect(h.notifier.accept(seen)).resolves.toEqual({ state: "applied", rowState: "seen" });

    h.advance(MINUTE);
    const second = h.now();
    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", at: second, snoozedUntil: new Date(second.getTime() + HOUR) })),
    ).resolves.toMatchObject({ state: "applied", rowState: "snoozed" });
    const before = JSON.stringify(await rowById(h, id));

    await expect(h.notifier.accept(seen)).resolves.toEqual({ state: "noop", reason: "superseded" });

    const after = await rowById(h, id);
    expect(JSON.stringify(after)).toBe(before);
    expect(after.state).toBe("snoozed");
    expect(after.snoozedUntil).toEqual(new Date(second.getTime() + HOUR));
    expect(hasKey(after, "expiresAt")).toBe(false);
  });

  it("a SYSTEM transition between a human act and its callback does not supersede it", async () => {
    // The paired negative that pins the anchor choice: false of any
    // implementation guarding on `principalAt`, which advances on system
    // transitions too.
    const h = await harness({ subscriptions: [sub("s1")] });
    const { id, handle } = await seedLedgerRow(h, { deliveryReference: { kind: "fake", id: "x" } });

    h.advance(MINUTE);
    const humanAt = h.now();
    await expect(
      h.notifier.accept(
        ack(handle, { act: "snoozed", at: humanAt, snoozedUntil: new Date(humanAt.getTime() + MINUTE) }),
      ),
    ).resolves.toMatchObject({ state: "applied" });

    h.advance(MINUTE);
    const callbackAt = h.now(); // the human's SECOND act; its callback is delayed

    h.advance(MINUTE);
    await h.tick(); // ... and the snooze expiry lands first
    const expired = await rowById(h, id);
    expect(expired.principal).toBe(OPS_SYSTEM_PRINCIPAL);
    expect(expired.principalAt).toEqual(h.now());
    expect(expired.lastAckAt).toEqual(humanAt);

    await expect(h.notifier.accept(ack(handle, { act: "seen", at: callbackAt }))).resolves.toEqual({
      state: "applied",
      rowState: "seen",
    });
    expect((await rowById(h, id)).state).toBe("seen");
  });

  it("the clock anchor is min(at, now) — a bogus future `at` buys no lockout and no unbounded pause", async () => {
    const h = await harness();
    const { id, handle } = await seedLedgerRow(h, { class: "integrity" });
    const tenYears = new Date(BASE.getTime() + 10 * 365 * 86_400_000);

    await expect(
      h.notifier.accept(
        ack(handle, { act: "snoozed", at: tenYears, snoozedUntil: new Date(tenYears.getTime() + 86_400_000) }),
      ),
    ).resolves.toEqual({
      state: "applied",
      rowState: "snoozed",
      snoozedUntil: new Date(BASE.getTime() + HARD_SNOOZE_CEILING_MS),
    });
    const row = await rowById(h, id);
    expect(row.stateAt).toEqual(BASE);
    expect(row.principalAt).toEqual(BASE);
    expect(row.lastAckAt).toEqual(BASE);

    // ... and the actor is not locked out of the row for ten years.
    h.advance(MINUTE);
    await expect(h.notifier.accept(ack(handle, { act: "seen", at: h.now() }))).resolves.toEqual({
      state: "applied",
      rowState: "seen",
    });
  });

  it("the SYSTEM principal can never produce those three states — an accept presenting it is refused", async () => {
    // The case that ESTABLISHES the property rather than the one that assumes
    // it: a mis-written edge, an operator command defaulting its actor, or a
    // transport handing back its own service identity.
    const h = await harness();
    const { id, handle } = await seedLedgerRow(h);
    const before = JSON.stringify(await rowById(h, id));

    await expect(h.notifier.accept(ack(handle, { actorId: OPS_SYSTEM_PRINCIPAL }))).resolves.toEqual({
      state: "refused",
      reason: "unattributed",
    });
    expect(JSON.stringify(await rowById(h, id))).toBe(before);
    expect(h.snapshot().intakeRefused).toBe(1);
    // The constant's SHAPE — that it matches neither the agent-id nor the Slack
    // user-id namespace — is pinned in notification-types.test.ts and is
    // re-referenced here, not duplicated.
    expect(OPS_SYSTEM_PRINCIPAL).toContain(":");
  });

  it("a dismissal on an `integrity` row is refused (D7 rule 3)", async () => {
    const h = await harness();
    const { id, handle } = await seedLedgerRow(h, { class: "integrity" });
    const before = JSON.stringify(await rowById(h, id));

    await expect(h.notifier.accept(ack(handle, { act: "dismissed" }))).resolves.toEqual({
      state: "refused",
      reason: "integrity-dismissal",
    });
    expect(JSON.stringify(await rowById(h, id))).toBe(before);
  });

  it.each(["seen", "dismissed", "snoozed"] as const)("any act on a CLEARED row is refused (%s)", async (act) => {
    const h = await harness();
    const { id, handle } = await seedLedgerRow(h, { state: "cleared", expiresAt: t(60) });
    const before = JSON.stringify(await rowById(h, id));

    await expect(
      h.notifier.accept(ack(handle, { act, snoozedUntil: new Date(BASE.getTime() + HOUR) })),
    ).resolves.toEqual({ state: "refused", reason: "row-cleared" });
    expect(JSON.stringify(await rowById(h, id))).toBe(before);
  });

  it("no code path issues an updateMany against ops_notifications", async () => {
    // The apply-if-newer watermark is a PER-ROW precondition: two rows on one
    // dedupeKey can sit at different appliedThrough* positions, so a bulk
    // update cannot express "apply only where this row's watermark is older".
    // An implementer who reaches for updateMany in the clearing fan-out will
    // hit this and should read it as the design, not a harness bug.
    // ⚠ The scan is for the CALL, not the word: `ingest.ts`'s clearing fan-out
    // documents this very prohibition in prose ("Per-row CAS'd updateOne, NEVER
    // an updateMany"), so a bare `not.toContain("updateMany")` fails against
    // correct source and would have to be satisfied by deleting the comment
    // that explains the rule.
    for (const file of NOTIFIER_FILES) expect(readFileSync(file, "utf8"), file).not.toMatch(/\.updateMany\s*\(/);

    // And at runtime — over THIS CASE'S harness, which is the only scope
    // `h.db.operations` has: every case builds its own harness, so "the whole
    // suite run" is not a thing this array can express. A scenario exercising
    // all three phases plus an intake, so the assertion is over a populated log
    // rather than an empty one.
    //
    // ⚠ The double implements no `updateMany` AT ALL, so this half cannot go
    // red on its own — a notifier that called it would throw a TypeError into
    // the tick instead. It is kept as the runtime restatement of the same
    // claim; the source scan above is the half that fails.
    const h = await harness({ subscriptions: [sub("s1"), sub("s2")] });
    await h.seedEvent({ dedupeKey: CONDITION_KEY, class: "resource", publishedAt: t(0) });
    await h.tick();
    const row = await h.row("s1", CONDITION_KEY);
    h.advance(MINUTE);
    await h.notifier.accept(
      ack(String(row._id), { act: "snoozed", at: h.now(), snoozedUntil: new Date(h.now().getTime() + MINUTE) }),
    );
    await h.seedEvent({
      dedupeKey: recoveryKey(0),
      clears: CONDITION_KEY,
      class: "informational",
      publishedAt: t(1),
      matchedSubscriptionIds: [],
    });
    h.advance(HOUR); // the snooze expires on the next tick
    await h.tick();

    expect(h.db.operations.filter((o) => o.operation === "updateMany")).toEqual([]);
    expect(h.db.operations.some((o) => o.collection === OPS_NOTIFICATIONS_COLLECTION)).toBe(true);
  });

  it("no sweep path can set `dismissed` — half 1, the literal scan with its one named exception", () => {
    for (const name of ["ingest.ts", "delivery.ts"]) {
      const source = readFileSync(join(here, name), "utf8");
      // The two acts a sweep must never write do not exist in these files AT
      // ALL — prose included, which is the strict direction.
      expect(source, name).not.toMatch(/"dismissed"/);
      expect(source, name).not.toMatch(/"seen"/);
      // ⚠ The state-literal scans read CODE lines only. `ingest.ts`'s own prose
      // legitimately QUOTES `state: "snoozed"` while explaining why a cleared
      // row's snooze residue is inert, and a scan that cannot tell a comment
      // from a write fails against correct source.
      const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
      // Every `state:` LITERAL is drawn from the sweep's own set.
      for (const match of code.join("\n").matchAll(/\bstate:\s*"([a-z]+)"/g)) {
        expect(["pending", "delivered", "cleared", "snoozed"], `${name}: state: "${match[1]}"`).toContain(match[1]);
      }
      // ... and `snoozed`, the one member of that set no sweep write may
      // PRODUCE, appears only in FILTER position — the expiry scan and its CAS
      // precondition, both of which name `find(` or `_id:` on the same line.
      let snoozedSites = 0;
      for (const line of code) {
        if (!/\bstate:\s*"snoozed"/.test(line)) continue;
        snoozedSites += 1;
        expect(/find\(|_id:/.test(line), `${name}: ${line.trim()}`).toBe(true);
      }
      if (name === "delivery.ts") expect(snoozedSites, "the expiry scan and its CAS").toBe(2);
    }
  });

  it("no sweep path can set `dismissed` — half 2, the one VARIABLE write, bounded behaviourally", async () => {
    // ⚠ A bare literal scan proves nothing about the write it most needs to
    // cover: `delivery.ts`'s expire() writes `state: next`, a VARIABLE. Its two
    // possible values are driven in AC10's expiry cases (delivered when the row
    // carries a deliveryReference, pending when it does not) and are NOT
    // re-seeded here. What this case adds is the complement — after a sweep
    // that no intake touched, no row is in seen, dismissed or snoozed.
    const h = await harness({ subscriptions: [sub("s1"), sub("s2")] });
    await h.seedEvent({ dedupeKey: CONDITION_KEY, class: "resource", publishedAt: t(0) });
    await h.tick();
    await seedLedgerRow(h, { state: "snoozed", snoozedUntil: t(1), deliveryReference: { kind: "fake", id: "x" } });
    await seedLedgerRow(h, { state: "snoozed", snoozedUntil: t(1) });
    await h.seedEvent({
      dedupeKey: recoveryKey(0),
      clears: CONDITION_KEY,
      class: "informational",
      publishedAt: t(2),
      matchedSubscriptionIds: [],
    });
    h.advance(HOUR);
    await h.tick();

    const rows = (await h.store.notifications.find({}).toArray()) as OpsNotification[];
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(["pending", "delivered", "cleared"], `${row.dedupeKey} is ${row.state}`).toContain(row.state);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC9
// ───────────────────────────────────────────────────────────────────────────

describe("AC9 — nothing in this diff publishes an ops_event, on success or on any fault (C14, D10)", () => {
  it("a successful tick writes to ops_events not at all", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith(), reasons: [reason("r1")] });
    await h.seedEvent();
    const mark = h.db.operations.length;
    await h.tick();

    expect(h.snapshot().deliveriesAccepted).toBe(1);
    expect((await h.heartbeat()).state).toBe("ok");
    expect(opsEventWrites(h, mark)).toEqual([]);
  });

  it("a fault in EVERY phase is logged, counted and degraded — and still writes no ops_event", async () => {
    // Ingest — the per-event try.
    const ingest = await harness({ subscriptions: [sub("s1")] });
    await ingest.seedEvent();
    const ingestMark = ingest.db.operations.length;
    ingest.db.failAll(OPS_NOTIFICATIONS_COLLECTION, "insertOne");
    await expect(ingest.tick()).resolves.toBeUndefined();
    expect(ingest.snapshot().ingestFaults).toBe(1);
    expect(warnLines("ops ingest fault")).toHaveLength(0); // logged at ERROR, not warn
    expect(mockLog.error.mock.calls.some((c) => String(c[0]).includes("ops ingest fault"))).toBe(true);
    expect((await ingest.heartbeat()).state).toBe("degraded");
    expect(opsEventWrites(ingest, ingestMark)).toEqual([]);

    // Snooze expiry — per-row containment.
    const expiry = await harness({ subscriptions: [sub("s1")] });
    await seedLedgerRow(expiry, { state: "snoozed", snoozedUntil: t(-5) });
    const expiryMark = expiry.db.operations.length;
    failOn(expiry.db, OPS_NOTIFICATIONS_COLLECTION, "updateOne", (ctx) => ctx.filter?.state === "snoozed");
    await expect(expiry.tick()).resolves.toBeUndefined();
    expect(expiry.snapshot().sweepFaults).toBe(1);
    expect(warnLines("ops snooze expiry fault")).toHaveLength(1);
    expect((await expiry.heartbeat()).state).toBe("degraded");
    expect(opsEventWrites(expiry, expiryMark)).toEqual([]);

    // Delivery — the record write, after an irreversible external side effect.
    const delivery = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    await delivery.seedEvent();
    const deliveryMark = delivery.db.operations.length;
    failOn(
      delivery.db,
      OPS_NOTIFICATIONS_COLLECTION,
      "updateOne",
      (ctx) => (ctx.update?.$set as Record<string, unknown> | undefined)?.lastOutcome !== undefined,
    );
    await expect(delivery.tick()).resolves.toBeUndefined();
    expect(delivery.snapshot().sweepFaults).toBe(1);
    expect(warnLines("ops delivery fault")).toHaveLength(1);
    expect((await delivery.heartbeat()).state).toBe("degraded");
    expect(opsEventWrites(delivery, deliveryMark)).toEqual([]);

    // The gauge reads, which sit outside every inner try.
    const gauge = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    await gauge.seedEvent();
    const gaugeMark = gauge.db.operations.length;
    failOn(gauge.db, OPS_NOTIFICATIONS_COLLECTION, "countDocuments", () => true);
    await expect(gauge.tick()).resolves.toBeUndefined();
    expect(gauge.snapshot().sweepFaults).toBe(1);
    expect((await gauge.heartbeat()).state).toBe("degraded");
    expect(opsEventWrites(gauge, gaugeMark)).toEqual([]);
  });

  it("the Slack transport registers every accepted post's ts through the echo callback", async () => {
    // Without this the post re-enters the bot's own listener as a WorkItem and
    // SPAWNS AN AGENT TURN — D10 invariant (b) violated, and a turn that then
    // fails a tool republishes and the loop closes.
    const echo = vi.fn();
    const ENDPOINT = "https://slack.com/api/chat.postMessage";
    const transport = new SlackOpsTransport(
      "xoxb-test",
      echo,
      () => BASE,
      async () => {
        const headers = new Headers({ "content-type": "application/json", "x-slack-req-id": "req-1" });
        const response = new Response(JSON.stringify({ ok: true, channel: "C0123456", ts: "1725465600.000100" }), {
          status: 200,
          headers,
        });
        Object.defineProperty(response, "url", { value: ENDPOINT });
        return response;
      },
    );

    const view: NotificationView = {
      handle: "65a1b2c3d4e5f60718293a4b",
      target: "C0123456",
      event: {
        producer: "hive-runtime",
        reasonId: "tool-failed",
        class: "resource",
        retry: "transient",
        waiting: "agent",
        subject: { kind: "tool", id: "gog" },
        generation: 0,
        dedupeKey: "hive-runtime:tool:gog:tool-failed:0",
        publishedAt: BASE,
        detail: {},
        evidence: [],
      },
      ledger: { state: "pending", eventCount: 1, nudgeCount: 0, attemptCount: 0, firstSeenAt: BASE, lastEventAt: BASE },
    };

    const outcome = await transport.deliver(view);
    expect(outcome).toEqual({
      status: "accepted",
      reference: { kind: "slackMessage", id: "C0123456:1725465600.000100" },
      at: BASE,
    });
    expect(echo).toHaveBeenCalledWith("C0123456", "1725465600.000100");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC10 — ⛳ NV5 is asserted in AC11 below; the clamp is here
// ───────────────────────────────────────────────────────────────────────────

describe("AC10 — the snooze clamp always exists, is applied and is echoed (C10)", () => {
  it("clamps to a registered maxSnoozeMs and ECHOES the clamped value", async () => {
    const h = await harness();
    h.notifier.__setPolicyForTests({ _id: OPS_POLICY_ID, maxSnoozeMs: HOUR });
    const { id, handle } = await seedLedgerRow(h);

    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", snoozedUntil: new Date(BASE.getTime() + 86_400_000) })),
    ).resolves.toEqual({ state: "applied", rowState: "snoozed", snoozedUntil: new Date(BASE.getTime() + HOUR) });
    expect((await rowById(h, id)).snoozedUntil).toEqual(new Date(BASE.getTime() + HOUR));
  });

  it("with NO ops_policy registered it clamps to the hard ceiling", async () => {
    const h = await harness();
    h.notifier.__setPolicyForTests(null); // a read SUCCEEDED and nothing is registered
    const { handle } = await seedLedgerRow(h);

    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", snoozedUntil: t(60 * 24 * 365) })),
    ).resolves.toMatchObject({ snoozedUntil: new Date(BASE.getTime() + HARD_SNOOZE_CEILING_MS) });
  });

  it("a snooze arriving BEFORE the first tick clamps to the hard ceiling and reads no ops_policy", async () => {
    // The COLD path: intake is live from init() while the sweep starts later,
    // so no findOne has returned yet and there is no retained copy.
    const h = await harness(); // start: false — no tick has run
    const { handle } = await seedLedgerRow(h);

    const mark = h.db.operations.length;
    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", snoozedUntil: t(60 * 24 * 365) })),
    ).resolves.toMatchObject({ snoozedUntil: new Date(BASE.getTime() + HARD_SNOOZE_CEILING_MS) });

    const after = h.db.operations.slice(mark);
    expect(after.filter((o) => o.collection === OPS_POLICY_COLLECTION)).toEqual([]);
    // One indexed read plus one CAS, and nothing else.
    expect(
      after.filter((o) => o.collection === OPS_NOTIFICATIONS_COLLECTION && o.operation === "findOne"),
    ).toHaveLength(1);
    expect(
      after.filter((o) => o.collection === OPS_NOTIFICATIONS_COLLECTION && o.operation === "updateOne"),
    ).toHaveLength(1);
  });

  it("a caller-supplied far-future `at` is clamped to now + HARD_SNOOZE_CEILING_MS — on an integrity row", async () => {
    // ⚠ THE ABLE-TO-FAIL CASE: false of any implementation anchoring the
    // ceiling on `at`, which admits an arbitrarily distant pause — the terminal
    // state D12 and C10 forbid, reachable through a surface D6 opens to an
    // agent tool call.
    const h = await harness();
    const { id, handle } = await seedLedgerRow(h, { class: "integrity" });
    const far = new Date(BASE.getTime() + 3650 * 86_400_000);

    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", at: far, snoozedUntil: new Date(far.getTime() + HOUR) })),
    ).resolves.toMatchObject({ state: "applied" });

    const row = await rowById(h, id);
    expect(row.snoozedUntil!.getTime()).toBeLessThanOrEqual(h.now().getTime() + HARD_SNOOZE_CEILING_MS);
  });

  it.each([
    ["absent", undefined],
    ["not a Date", "2026-01-02T00:00:00.000Z" as unknown as Date],
    ["NaN", new Date("nonsense")],
    ["in the past", new Date(BASE.getTime() - 1)],
    ["equal to the anchor", BASE],
  ] as Array<[string, Date | undefined]>)("refuses a snooze whose target is %s", async (_label, snoozedUntil) => {
    const h = await harness();
    const { id, handle } = await seedLedgerRow(h);
    const before = JSON.stringify(await rowById(h, id));

    await expect(h.notifier.accept(ack(handle, { act: "snoozed", snoozedUntil }))).resolves.toEqual({
      state: "refused",
      reason: "snooze-not-future",
    });
    expect(JSON.stringify(await rowById(h, id))).toBe(before);
  });

  it("expiry returns the row to `delivered` and RE-DELIVERS it under no registered cadence", async () => {
    const h = await harness({ subscriptions: [sub("s1")] }); // no policy — the shipped default
    const e = await h.seedEvent();
    await h.tick();
    const row = await h.row("s1", e.dedupeKey);
    expect(row.deliveryReference).toBeDefined();

    h.advance(MINUTE);
    const at = h.now();
    await expect(
      h.notifier.accept(ack(String(row._id), { act: "snoozed", at, snoozedUntil: new Date(at.getTime() + HOUR) })),
    ).resolves.toMatchObject({ state: "applied" });

    h.advance(2 * HOUR);
    await h.tick();

    const after = await h.row("s1", e.dedupeKey);
    expect(after.state).toBe("delivered");
    expect(hasKey(after, "snoozedUntil")).toBe(false);
    expect(hasKey(after, "expiresAt")).toBe(false);
    // Re-delivered on the very tick the snooze expired, with NO cadence.
    expect(h.transport.views).toHaveLength(2);
    expect(after.attemptCount).toBe(2);
    expect(after.forceDeliver).toBeUndefined();
  });

  it("expiry returns a row that never took an accepted delivery to `pending`", async () => {
    const h = await harness({ subscriptions: [sub("s1")], transport: null });
    const e = await h.seedEvent();
    await h.tick();
    const row = await h.row("s1", e.dedupeKey);
    expect(row.deliveryReference).toBeUndefined();

    await h.store.notifications.updateOne(
      { _id: row._id },
      { $set: { state: "snoozed", snoozedUntil: t(5), expiresAt: t(10_000) }, $unset: { nextNudgeAt: "" } },
    );
    h.advance(HOUR);
    await h.tick();

    expect((await h.row("s1", e.dedupeKey)).state).toBe("pending");
  });

  it("a `seen` row snoozed through intake comes out with expiresAt UNSET", async () => {
    // D9's state invariant, and the arm an enumeration of out-transitions
    // misses: the row arrives STOPPED carrying a live TTL horizon and moves
    // back into a WORKING state, where a retained TTL would delete it mid-pause.
    const h = await harness();
    const { id, handle } = await seedLedgerRow(h);

    await expect(h.notifier.accept(ack(handle, { act: "seen" }))).resolves.toMatchObject({ state: "applied" });
    expect((await rowById(h, id)).expiresAt).toEqual(new Date(BASE.getTime() + RETENTION_MS));

    h.advance(MINUTE);
    const at = h.now();
    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", at, snoozedUntil: new Date(at.getTime() + HOUR) })),
    ).resolves.toMatchObject({ state: "applied", rowState: "snoozed" });

    const row = await rowById(h, id);
    expect(row.state).toBe("snoozed");
    expect(hasKey(row, "expiresAt")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC11 — ⛳ NV5
// ───────────────────────────────────────────────────────────────────────────

describe("AC11 — cadence is SOURCED from operator data, and its absence is a deployment gate", () => {
  beforeEach(() => __resetCadenceWarningsForTests());

  it("limb 1 — never unset: between deliveries the row is still returned by the due-scan predicate", async () => {
    // False of any implementation that unsets the field. MongoDB's comparison
    // operators are TYPE-BRACKETED and fake-db.ts reproduces it
    // (`case "$lte": return actual !== undefined && actual <= value`), so the
    // double fails it too — which is what makes this limb real rather than a
    // claim about the driver.
    const h = await harness({ subscriptions: [sub("s1")] });
    await h.seedEvent();
    await h.tick();
    const now = h.now();

    const later = new Date(now.getTime() + STALL_RECHECK_MS * 1.5);
    expect(await h.db.collection(OPS_NOTIFICATIONS_COLLECTION).countDocuments(DUE(later))).toBe(1);
  });

  it("limb 2 — pushed forward, not left due, and never unset", async () => {
    // False of the "leave it at its due value" implementation, which parks an
    // ever-growing, never-TTL'd prefix at the head of the delivery scan.
    const h = await harness({ subscriptions: [sub("s1")] });
    const e = await h.seedEvent();
    await h.tick();
    const now = h.now();

    expect(await h.db.collection(OPS_NOTIFICATIONS_COLLECTION).countDocuments(DUE(now))).toBe(0);
    // ⚠ THE TWO COMPANIONS ARE NOT DECORATION — the count above passes
    // VACUOUSLY under the "unset it" implementation: an unset field is not at
    // its due value either, so DUE(now) matches nothing and the count is 0 for
    // the wrong reason. A limb whose only assertion is satisfied by both a
    // correct and an incorrect implementation asserts nothing about half the
    // space.
    const row = await h.row("s1", e.dedupeKey);
    expect(row.nextNudgeAt, "never unset").toBeInstanceOf(Date);
    expect(row.nextNudgeAt!.getTime(), "pushed forward").toBeGreaterThan(now.getTime());
  });

  it("limb 3 — the two re-delivery triggers still fire under no ops_policy", async () => {
    // Both false of a two-disjunct `attemptCount === 0 ∨ cadence` gate, which
    // turns a demonstrated recurrence and an expired snooze into PERMANENT
    // SILENCE under the shipped default.
    //
    // (a) a row cleared and then renewed is DELIVERED AGAIN.
    const a = await harness({ subscriptions: [sub("s1")] });
    await a.seedEvent({ dedupeKey: CONDITION_KEY, class: "resource", publishedAt: t(0) });
    await a.tick();
    expect((await a.row("s1", CONDITION_KEY)).attemptCount).toBe(1);
    await a.seedEvent({
      dedupeKey: recoveryKey(0),
      clears: CONDITION_KEY,
      class: "informational",
      publishedAt: t(1),
      matchedSubscriptionIds: [],
    });
    a.advance(MINUTE);
    await a.tick();
    expect((await a.row("s1", CONDITION_KEY)).state).toBe("cleared");

    a.advance(MINUTE);
    await a.seedEvent({ dedupeKey: CONDITION_KEY, class: "resource", publishedAt: t(3) });
    await a.tick();
    const reopened = await a.row("s1", CONDITION_KEY);
    expect(reopened.state).toBe("delivered");
    expect(reopened.attemptCount).toBe(2);
    expect(reopened.forceDeliver).toBeUndefined();

    // (b) a row snoozed and then expired is DELIVERED AGAIN.
    const b = await harness({ subscriptions: [sub("s1")] });
    const e = await b.seedEvent();
    await b.tick();
    const row = await b.row("s1", e.dedupeKey);
    b.advance(MINUTE);
    const at = b.now();
    await b.notifier.accept(ack(String(row._id), { act: "snoozed", at, snoozedUntil: new Date(at.getTime() + HOUR) }));
    b.advance(2 * HOUR);
    await b.tick();
    expect((await b.row("s1", e.dedupeKey)).attemptCount).toBe(2);
    expect(b.transport.views).toHaveLength(2);
  });

  it("a cadence-unresolved row is RE-OBSERVED every re-check, and the first re-check after a cadence DELIVERS", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const e = await h.seedEvent();
    await h.tick();
    expect(h.transport.views).toHaveLength(1); // the guaranteed first delivery

    for (let i = 1; i <= 3; i += 1) {
      h.advance(STALL_RECHECK_MS * 2);
      await h.tick();
      // The delivery pass's own counter ...
      expect(h.snapshot().cadenceUnresolved, `re-check ${i}`).toBe(i);
      // ... and the gauge, which is derived from the {stalledReason, state}
      // index rather than from the pass.
      expect((await h.heartbeat()).rowsCadenceUnresolved, `re-check ${i}`).toBe(1);
      expect(h.transport.views, `re-check ${i}`).toHaveLength(1);
    }

    // The operator registers a cadence. No restart, no reload timer.
    await h.db.collection(OPS_POLICY_COLLECTION).insertOne(policyWith());
    h.advance(STALL_RECHECK_MS * 2);
    await h.tick();

    expect(h.transport.views).toHaveLength(2);
    const row = await h.row("s1", e.dedupeKey);
    expect(row.nextNudgeAt).toEqual(new Date(h.now().getTime() + CADENCE));
    expect(row.stalledReason).toBeUndefined();
    expect((await h.heartbeat()).rowsCadenceUnresolved).toBe(0);
  });

  it("a subscription naming a PROFILE uses that profile and never the (class, retry) table", async () => {
    const h = await harness({
      subscriptions: [sub("s1", { cadenceProfile: "hourly" })],
      policy: policyWith({ profiles: { hourly: HOUR } }),
    });
    const e = await h.seedEvent();
    await h.tick();

    // The table holds a live entry for this row's (class, retry) pair; naming a
    // profile takes the row out of the table entirely.
    expect((await h.row("s1", e.dedupeKey)).nextNudgeAt).toEqual(new Date(BASE.getTime() + HOUR));
  });

  it("an UNKNOWN profile resolves no cadence and does NOT fall back to the table", async () => {
    const h = await harness({
      subscriptions: [sub("s1", { cadenceProfile: "nope" })],
      policy: policyWith({ profiles: { hourly: HOUR } }),
    });
    const e = await h.seedEvent();
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.stalledReason).toBe("cadence");
    expect(row.nextNudgeAt!.getTime()).toBeLessThan(BASE.getTime() + CADENCE);
    h.advance(CADENCE);
    await h.tick();
    expect(h.snapshot().cadenceUnresolved).toBe(1);
    expect(h.transport.views).toHaveLength(1);
  });

  it("a profile below the registered floor is clamped UP and warned", async () => {
    const h = await harness({
      subscriptions: [sub("s1", { cadenceProfile: "ac11-fast" })],
      policy: policyWith({ profiles: { "ac11-fast": 1_000 }, minNudgeIntervalMs: 60_000 }),
    });
    const e = await h.seedEvent();
    await h.tick();

    expect((await h.row("s1", e.dedupeKey)).nextNudgeAt).toEqual(new Date(BASE.getTime() + 60_000));
    expect(warnLines("ops cadence profile below the registered minimum")).toHaveLength(1);
  });

  it("this child registers ZERO ops_policy rows — the collection is empty after init() and start()", async () => {
    const h = await harness({ subscriptions: [sub("s1")], start: true });
    try {
      // Read the OPERATIONS first: the countDocuments below is this case's own
      // and would otherwise appear in the log it is asserting over.
      expect(
        h.db.operations.filter((o) => o.collection === OPS_POLICY_COLLECTION && o.operation !== "findOne"),
      ).toEqual([]);
      expect(await h.db.collection(OPS_POLICY_COLLECTION).countDocuments({})).toBe(0);
    } finally {
      await h.notifier.stop(); // start() armed two real intervals
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC12
// ───────────────────────────────────────────────────────────────────────────

describe("AC12 — the ledger stores references and closed-set tokens, never text (C13)", () => {
  /** D2's complete key set. Anything else on a row is a redaction hole. */
  const ROW_KEYS = new Set([
    "_id",
    "subscriptionId",
    "subscriberId",
    "dedupeKey",
    "producer",
    "reasonId",
    "class",
    "waiting",
    "retry",
    "subject",
    "generation",
    "firstEventId",
    "latestEventId",
    "eventCount",
    "firstSeenAt",
    "lastEventAt",
    "state",
    "stateAt",
    "principal",
    "principalAt",
    "snoozedUntil",
    "attempts",
    "attemptCount",
    "lastOutcome",
    "deliveryReference",
    "nudgeCount",
    "lastNudgeAt",
    "nextNudgeAt",
    "appliedThroughAt",
    "appliedThroughId",
    "stateEventId",
    "latestDetail",
    "latestEvidence",
    "lastAckKey",
    "lastAckAt",
    "forceDeliver",
    "stalledAt",
    "stalledReason",
    "expiresAt",
  ]);

  it("neither a credential-shaped nor a path-shaped transport error reaches the row", async () => {
    const h = await harness({ subscriptions: [sub("s1")], reasons: [reason("r1")] });
    h.transport.onDeliver = () => {
      throw new Error("xoxb-1234-secret rejected while reading /Users/mokie/.env");
    };
    const e = await h.seedEvent();

    await expect(h.tick()).resolves.toBeUndefined();

    const row = await h.row("s1", e.dedupeKey);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("xoxb-1234-secret");
    expect(serialized).not.toContain("/Users/mokie/.env");
    expect(serialized).not.toMatch(/https?:\/\//);
    // What IS recorded is a member of D6's closed uncertainty set.
    expect(row.attempts).toEqual([{ at: BASE, outcome: "unknown", adapterId: "fake", reason: "transport-fault" }]);
    expect(Object.keys(row).filter((k) => !ROW_KEYS.has(k))).toEqual([]);
  });

  it("remediation is a registry template plus allow-listed parameters, rendered IN THE ADAPTER", async () => {
    const h = await harness({
      subscriptions: [sub("s1")],
      reasons: [reason("r1", { remediationTemplate: "re-run {toolName}" })],
    });
    const e = await h.seedEvent({ detail: { toolName: "gog" } });
    await h.tick();

    // The adapter is handed the TEMPLATE and its parameters, never a string.
    const view = h.transport.views[0]!;
    expect(view.remediation).toEqual({ template: "re-run {toolName}", parameters: { toolName: "gog" } });
    // Rendering is the adapter's, and this is where it happens.
    expect(renderRemediation(view.remediation!.template, view.remediation!.parameters)).toBe("re-run gog");

    // The ledger holds no rendered string and no field for one.
    const row = await h.row("s1", e.dedupeKey);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("re-run gog");
    expect(serialized).not.toContain("re-run {toolName}");
    expect(Object.keys(row).filter((k) => !ROW_KEYS.has(k))).toEqual([]);
    // `latestDetail` is the registry's allow-listed snapshot — the one place
    // producer-supplied values live, and they are scalars the accept path
    // already validated.
    expect(row.latestDetail).toEqual({ toolName: "gog" });
  });

  it("a row that has been through every phase carries no key outside D2's set", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith(), reasons: [reason("r1")] });
    const e = await h.seedEvent();
    await h.tick();
    const created = await h.row("s1", e.dedupeKey);
    h.advance(MINUTE);
    await h.notifier.accept(
      ack(String(created._id), { act: "snoozed", at: h.now(), snoozedUntil: new Date(h.now().getTime() + MINUTE) }),
    );
    h.advance(HOUR);
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(Object.keys(row).filter((k) => !ROW_KEYS.has(k))).toEqual([]);
    for (const attempt of row.attempts) {
      expect(Object.keys(attempt).sort().join(",")).toMatch(/^adapterId,at,outcome(,reason)?$/);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC13
// ───────────────────────────────────────────────────────────────────────────

describe("AC13 — a tick contains its own faults (D8(b))", () => {
  it("delivery and snooze expiry: a per-row fault is caught and counted, and the phase continues", async () => {
    // These phases have no cursor and no ordering obligation, so a skipped row
    // costs that row one tick and nothing else.
    const delivery = await harness({ subscriptions: [sub("s1"), sub("s2")], policy: policyWith() });
    const e = await delivery.seedEvent();
    let records = 0;
    failOn(
      delivery.db,
      OPS_NOTIFICATIONS_COLLECTION,
      "updateOne",
      (ctx) => (ctx.update?.$set as Record<string, unknown> | undefined)?.lastOutcome !== undefined && ++records === 1,
    );

    await expect(delivery.tick()).resolves.toBeUndefined();

    expect(delivery.transport.views).toHaveLength(2); // the phase CONTINUED
    expect(delivery.snapshot().sweepFaults).toBe(1);
    const first = await delivery.row("s1", e.dedupeKey);
    const second = await delivery.row("s2", e.dedupeKey);
    expect(first.lastOutcome).toBeUndefined();
    expect(first.attemptCount).toBe(0);
    expect(second.lastOutcome).toBe("accepted");
    expect(second.attemptCount).toBe(1);

    // Snooze expiry, the same shape.
    const expiry = await harness({ subscriptions: [sub("s1")] });
    const a = await seedLedgerRow(expiry, { state: "snoozed", snoozedUntil: t(-5) });
    const b = await seedLedgerRow(expiry, { state: "snoozed", snoozedUntil: t(-4) });
    let expiries = 0;
    failOn(
      expiry.db,
      OPS_NOTIFICATIONS_COLLECTION,
      "updateOne",
      (ctx) => ctx.filter?.state === "snoozed" && ++expiries === 1,
    );

    await expect(expiry.tick()).resolves.toBeUndefined();

    expect(expiry.snapshot().sweepFaults).toBe(1);
    expect((await rowById(expiry, a.id)).state).toBe("snoozed"); // the faulting row
    expect((await rowById(expiry, b.id)).state).toBe("delivered"); // the phase CONTINUED
  });

  it("ingest limb 1 — a fault on the THIRD of a five-event page stops the phase at it", async () => {
    // ⚠ ABLE-TO-FAIL against the per-row-continue implementation, which applies
    // 4 and 5, advances the cursor to 5, and leaves event 3 permanently
    // unnotified, uncounted, and invisible to eventsBehind — not BEHIND the
    // cursor but UNDER it.
    const h = await harness({ subscriptions: [sub("s1")] });
    const events = await h.seedEvents(5);
    // failOn is the harness's one-line wrapper over the double's own
    // failNext(coll, op, error, when) — see the harness contract.
    failOn(
      h.db,
      OPS_NOTIFICATIONS_COLLECTION,
      "insertOne",
      (ctx) => ctx.document?.latestEventId === String(events[2]!._id),
    );
    await h.tick();

    const cursor = await h.store.readCursor();
    expect(cursor!.eventId).toBe(String(events[1]!._id)); // at or before the SECOND
    expect(await h.ledgerCount()).toBe(2);
    expect(h.snapshot().ingestFaults).toBe(1);

    h.db.clearFaults();
    await h.tick();
    expect(await h.ledgerCount()).toBe(5); // 3, 4 and 5 applied on the next tick
  });

  it("ingest limb 2 — the unit is the EVENT: a fault in the second row of a clearing fan-out stops at that event", async () => {
    // The retry re-applies the whole event, with the already-cleared row a
    // no-op via the watermark.
    const h = await harness({ subscriptions: [sub("s1"), sub("s2")] });
    const opening = await h.seedEvent({ dedupeKey: CONDITION_KEY, class: "resource", publishedAt: t(0) });
    await h.tick();
    expect(await h.ledgerCount()).toBe(2);

    await h.seedEvent({
      dedupeKey: recoveryKey(0),
      clears: CONDITION_KEY,
      class: "informational",
      publishedAt: t(1),
      matchedSubscriptionIds: [],
    });
    await h.seedEvent({ publishedAt: t(2) }); // a LATER event, to prove the phase stopped
    let clears = 0;
    failOn(
      h.db,
      OPS_NOTIFICATIONS_COLLECTION,
      "updateOne",
      (ctx) => (ctx.update?.$set as Record<string, unknown> | undefined)?.state === "cleared" && ++clears === 2,
    );
    h.advance(MINUTE);
    await h.tick();

    expect(h.snapshot().ingestFaults).toBe(1);
    // The cursor advanced no further than the clearing event's PREDECESSOR.
    expect((await h.store.readCursor())!.eventId).toBe(String(opening._id));
    expect(await h.ledgerCount()).toBe(2); // the later event was NOT applied
    const cleared = (await h.store.notifications.find({ state: "cleared" }).toArray()) as OpsNotification[];
    expect(cleared).toHaveLength(1);
    expect(h.snapshot().rowsCleared).toBe(1);

    h.db.clearFaults();
    await h.tick();

    expect((await h.row("s1", CONDITION_KEY)).state).toBe("cleared");
    expect((await h.row("s2", CONDITION_KEY)).state).toBe("cleared");
    // The already-cleared row was a no-op on the retry, not a second clear.
    expect(h.snapshot().rowsCleared).toBe(2);
    expect(await h.ledgerCount()).toBe(4); // ... and the later event applied
  });

  it("ingest limb 3 — the WEDGE signature: a deterministic fault holds the cursor across two ticks", async () => {
    // ⚠ This is the only limb that asserts D8(b)'s "no automatic skip and no
    // quarantine" RULING rather than merely stating it. The able-to-fail case
    // is the bounded-quarantine implementation this spec declines, which
    // advances the cursor past the poison event on the second tick — limb 1
    // injects the fault once and so PASSES against it.
    //
    // The cursor must be SEEDED and the faulting event must be the FIRST
    // un-applied one — otherwise tick 1 either takes D3's cold-start arm and
    // applies nothing (so the fault never fires) or advances legitimately over
    // predecessors (so the byte-identity assertion has to skip a tick). The
    // harness seeds `cursorAt: t(-1)` by default, which is exactly this shape;
    // it is passed explicitly here because THIS case depends on it.
    const h = await harness({ subscriptions: [sub("s1")], cursorAt: t(-1) });
    const poison = await h.seedEvent({ publishedAt: t(0) });
    // failAll, not failNext: a one-shot hook is spliced out when it fires, so
    // tick 2 would succeed and this limb would pass against the
    // bounded-quarantine implementation it exists to reject. This is the whole
    // reason chunk 2 Step 2(e) adds a persistent fault.
    h.db.failAll(OPS_NOTIFICATIONS_COLLECTION, "insertOne");
    const before = await h.store.readCursor();
    await h.tick();
    const after1 = await h.store.readCursor();
    await h.tick();
    const after2 = await h.store.readCursor();

    expect(after1).toEqual(before);
    expect(after2).toEqual(before);
    expect(h.snapshot().ingestFaults).toBe(2);
    expect(await h.heartbeat()).toMatchObject({ state: "degraded" });
    expect((await h.heartbeat()).oldestUnappliedAt).toEqual(poison.publishedAt);
  });

  it("ticks never overlap under a slow adapter", async () => {
    // A second sweepOnce() started while the first is in flight returns the
    // same promise and performs no second set of phase reads.
    const h = await harness({ subscriptions: [sub("s1")] });
    await h.seedEvent();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.transport.onDeliver = async () => {
      await held;
    };

    const first = h.tick();
    const second = h.tick();
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);

    expect(
      h.db.operations.filter((o) => o.collection === OPS_EVENTS_COLLECTION && o.operation === "find"),
    ).toHaveLength(1);
    expect(h.db.operations.filter((o) => o.collection === OPS_POLICY_COLLECTION)).toHaveLength(1);
    expect(h.transport.views).toHaveLength(1);
  });

  it("a per-row latch serializes an intake write against a tick on the same row", async () => {
    // The loser observes a CAS failure rather than a merged write.
    const h = await harness({ subscriptions: [sub("s1")] });
    const { id, handle } = await seedLedgerRow(h, { state: "pending", attemptCount: 0, nextNudgeAt: BASE });

    // Held after delivery arm 1's scan, before it takes the latch.
    const gate = h.db.pause(
      OPS_NOTIFICATIONS_COLLECTION,
      "find",
      (ctx) => (ctx.filter as { attemptCount?: number } | undefined)?.attemptCount === 0,
      true,
    );
    const tick = h.tick();
    await gate.reached;

    await expect(h.notifier.accept(ack(handle))).resolves.toEqual({ state: "applied", rowState: "seen" });
    gate.release();
    await tick;

    // The post HAPPENED — that is the honest cost — but the record is refused
    // rather than written over the acknowledgement.
    expect(h.transport.views).toHaveLength(1);
    expect(h.snapshot().deliveryRecordLost).toBe(1);
    const row = await rowById(h, id);
    expect(row.state).toBe("seen");
    expect(row.principal).toBe("U1");
    expect(row.attemptCount).toBe(0);
    expect(row.lastOutcome).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC14
// ───────────────────────────────────────────────────────────────────────────

describe("AC14 — boot postures: what a fault at init() or start() leaves live", () => {
  /**
   * ⚠ THE ONE PLACE THIS FILE BUILDS A NOTIFIER BY HAND. `harness()` calls
   * `init()` internally, so a case that must WATCH `init()` fail cannot use it
   * (delivery.integration.test.ts:814's precedent). Everything else about the
   * construction matches the harness exactly.
   */
  const rawNotifier = (arm: (db: FakeDb) => void = () => {}) => {
    const db = new FakeDb();
    arm(db);
    return {
      db,
      notifier: new OpsNotifier(
        db.db,
        90,
        () => BASE,
        async () => {},
      ),
    };
  };

  it("a UNIQUE-index failure leaves the singleton UNSET, so acceptOpsAcknowledgement is unavailable, and boot completes", async () => {
    const { notifier } = rawNotifier((db) => failNth(db, OPS_NOTIFICATIONS_COLLECTION, "createIndex", 1));

    // index.ts awaits init() inside its own try; the throw is catchable and
    // boot continues past it — what it never reaches is setOpsNotifier.
    await expect(notifier.init()).rejects.toThrow(/identity index unavailable/);
    expect(notifier.getSnapshot().initialized).toBe(false);

    await expect(acceptOpsAcknowledgement(ack("0".repeat(24)))).resolves.toEqual({ state: "unavailable" });
    await notifier.start();
    expect(notifier.getSnapshot().started).toBe(false);
  });

  it("a failure of any OTHER index leaves the notifier started", async () => {
    const { notifier } = rawNotifier((db) => failNth(db, OPS_NOTIFICATIONS_COLLECTION, "createIndex", 2));
    await expect(notifier.init()).resolves.toBeUndefined();
    notifier.registerTransport(new FakeTransport());
    await notifier.start();
    try {
      expect(notifier.getSnapshot().started).toBe(true);
      expect(notifier.getSnapshot().indexFailures).toBe(1);
    } finally {
      await notifier.stop();
    }
  });

  it("a first-subscription-load failure in start() leaves the notifier unstarted with intake LIVE", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const { handle } = await seedLedgerRow(h);
    failOn(h.db, OPS_SUBSCRIPTIONS_COLLECTION, "find", () => true);

    await expect(h.notifier.start()).resolves.toBeUndefined();
    expect(h.notifier.getSnapshot().started).toBe(false);
    expect(h.notifier.getSnapshot().subscriptionReloadFaults).toBe(1);

    await expect(h.notifier.accept(ack(handle))).resolves.toEqual({ state: "applied", rowState: "seen" });
  });

  it("an init()-side REASON-MAP fault resolves the other way: the singleton is set, the sweep never starts, intake applies", async () => {
    const { db, notifier } = rawNotifier((d) => d.failAll(OPS_REASONS_COLLECTION, "find"));
    await expect(notifier.init()).resolves.toBeUndefined();
    expect(notifier.getSnapshot().initialized).toBe(true);
    expect(notifier.getSnapshot().startable).toBe(false);

    // index.ts still runs setOpsNotifier on this posture.
    setOpsNotifier(notifier);
    await notifier.start();
    expect(notifier.getSnapshot().started).toBe(false);

    // Reasons feed only `remediation` at delivery; intake consumes none of them.
    const res = await db.collection(OPS_NOTIFICATIONS_COLLECTION).insertOne(ledgerRow());
    await expect(acceptOpsAcknowledgement(ack(String(res.insertedId)))).resolves.toEqual({
      state: "applied",
      rowState: "seen",
    });
  });

  it("intake availability is pinned to init(), not start() — and goes away at stop()", async () => {
    const h = await harness(); // start: false
    const { handle } = await seedLedgerRow(h);
    expect(h.notifier.getSnapshot().started).toBe(false);
    await expect(h.notifier.accept(ack(handle))).resolves.toEqual({ state: "applied", rowState: "seen" });

    // ... and the singleton is what an unwired boot window answers with.
    __resetOpsNotifierForTests();
    await expect(acceptOpsAcknowledgement(ack(handle))).resolves.toEqual({ state: "unavailable" });

    setOpsNotifier(h.notifier);
    await h.notifier.stop();
    await expect(acceptOpsAcknowledgement(ack(handle, { actorId: "U2" }))).resolves.toEqual({ state: "unavailable" });
  });

  it("NO ops_subscriptions read occurs during init() — the load moves to start()", async () => {
    // A load running in init() would have no registered adapter to run
    // validateTarget against and would unload every subscription on a warm
    // restart.
    const { db, notifier } = rawNotifier();
    await notifier.init();
    expect(db.operations.filter((o) => o.collection === OPS_SUBSCRIPTIONS_COLLECTION)).toEqual([]);

    notifier.registerTransport(new FakeTransport());
    await notifier.start();
    try {
      expect(
        db.operations.filter((o) => o.collection === OPS_SUBSCRIPTIONS_COLLECTION && o.operation === "find").length,
      ).toBeGreaterThan(0);
    } finally {
      await notifier.stop();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC15 — the RUNTIME half (the structural scans are notifier-isolation.test.ts)
// ───────────────────────────────────────────────────────────────────────────

describe("AC15 — activity_log is not a failure oracle here (C12) — the runtime half", () => {
  it("a full lifecycle touches only the ops collections and telemetry", async () => {
    // The STRUCTURAL half — that no notifier source names activity_log,
    // costUsd, agent_events, EVENT_SCHEMAS or checkEvents — is asserted in
    // `notifier-isolation.test.ts` and is deliberately not duplicated here.
    // This is the behavioural complement: over a tick that ingests, clears,
    // delivers, expires a snooze and takes an acknowledgement, the set of
    // collections the notifier touched is closed.
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith(), reasons: [reason("r1")] });
    const e = await h.seedEvent();
    await h.tick();
    const row = await h.row("s1", e.dedupeKey);
    h.advance(MINUTE);
    await h.notifier.accept(
      ack(String(row._id), { act: "snoozed", at: h.now(), snoozedUntil: new Date(h.now().getTime() + MINUTE) }),
    );
    h.advance(HOUR);
    await h.tick();

    const touched = [...new Set(h.db.operations.map((o) => o.collection))].sort();
    expect(touched).toEqual(
      [
        OPS_EVENTS_COLLECTION,
        OPS_NOTIFICATIONS_COLLECTION,
        OPS_POLICY_COLLECTION,
        OPS_REASONS_COLLECTION,
        OPS_SUBSCRIPTIONS_COLLECTION,
        "telemetry",
      ].sort(),
    );
    expect(touched).not.toContain("activity_log");
    expect(touched).not.toContain("agent_events");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC16
// ───────────────────────────────────────────────────────────────────────────

describe("AC16 — a subscriber, a transport binding, a reason and a cadence are DATA (C16, D11)", () => {
  /**
   * ⚠ THE ONE CASE IN THE SUITE THAT USES KPR-454's REAL ACCEPT PATH. Every
   * other case seeds `ops_events` directly; this one publishes through
   * `OpsPublisher` so the handoff is an end-to-end claim rather than a fixture.
   * It is also why AC9's "zero ops_events writes" assertion is scoped to its
   * own harness rather than to the suite run.
   *
   * Nothing below edits the envelope, the filter grammar or the transport
   * interface — the fact that this case compiles against the shipped
   * `OpsPublishInput`, `OpsSubscription` and `OpsTransport` types IS that claim.
   */
  it("adding them to an ALREADY-INITIALIZED notifier creates, delivers and schedules a row, with no engine change", async () => {
    const h = await harness(); // initialized, zero subscriptions, zero policy
    const publisher = new OpsPublisher(h.db.db, 90);
    await publisher.init();
    try {
      // ── the levers, as data ──
      const subscription: OpsSubscription = {
        _id: "ops-team",
        subscriberId: "U-ops",
        subscriberKind: "human",
        enabled: true,
        filter: { producer: [HIVE_RUNTIME_PRODUCER] },
        transport: { adapterId: "fake", target: "C0000001" },
      };
      await h.db.collection(OPS_SUBSCRIPTIONS_COLLECTION).insertOne(subscription);
      await h.db.collection(OPS_POLICY_COLLECTION).insertOne({
        _id: OPS_POLICY_ID,
        cadence: { "resource:transient": CADENCE },
      });
      await publisher.reloadSubscriptions();
      await h.notifier.reloadSubscriptions();

      publisher.enqueueFailure({
        producer: HIVE_RUNTIME_PRODUCER,
        reasonId: REASON_TOOL_FAILED,
        waiting: "nobody",
        subject: { kind: "tool", id: "gog" },
        detail: { tool: "gog", errorSig: "timeout", lane: "claude" },
        evidence: [],
      });
      await publisher.__drainForTests();

      const events = h.db.collection(OPS_EVENTS_COLLECTION).rows;
      expect(events).toHaveLength(1);
      expect(events[0]!.matchedSubscriptionIds).toEqual(["ops-team"]);
      const key = String(events[0]!.dedupeKey);

      await h.tick();

      const row = await h.row("ops-team", key);
      expect(row.state).toBe("delivered");
      expect(row.subscriberId).toBe("U-ops");
      expect(row.deliveryReference).toEqual({ kind: "fake", id: String(row._id) });
      expect(row.nextNudgeAt).toEqual(new Date(h.now().getTime() + CADENCE));
      expect(h.transport.views).toHaveLength(1);

      // ── the reverse lever: enabled: false stops delivery and nudging within
      //    one reload, RETAINING the row ──
      await h.db.collection(OPS_SUBSCRIPTIONS_COLLECTION).updateOne({ _id: "ops-team" }, { $set: { enabled: false } });
      await h.notifier.reloadSubscriptions();
      h.advance(CADENCE);
      await h.tick();

      expect(h.transport.views).toHaveLength(1);
      expect(await h.ledgerCount()).toBe(1); // retained, never deleted
      expect((await h.row("ops-team", key)).stalledReason).toBe("subscription");

      // ── and re-enabling resumes ──
      await h.db.collection(OPS_SUBSCRIPTIONS_COLLECTION).updateOne({ _id: "ops-team" }, { $set: { enabled: true } });
      await h.notifier.reloadSubscriptions();
      h.advance(STALL_RECHECK_MS * 2);
      await h.tick();

      expect(h.transport.views).toHaveLength(2);
      expect((await h.row("ops-team", key)).stalledReason).toBeUndefined();
    } finally {
      await publisher.stop();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC17
// ───────────────────────────────────────────────────────────────────────────

describe("AC17 — documentation", () => {
  const claude = readFileSync(join(here, "..", "..", "CLAUDE.md"), "utf8");
  it("documents both collections, both telemetry kinds and the operator-facing defaults", () => {
    expect(claude).toContain("ops_notifications");
    expect(claude).toContain("ops_policy");
    expect(claude).toContain("ops_notifier_stats");
    expect(claude).toContain("ops_sweep_cursor");
    expect(claude).toMatch(/attempted[^.]*once per occurrence/i);
    expect(claude).toContain("KPR-455");
  });

  it("marks the cursor as DURABLE SWEEP PROGRESS rather than a heartbeat, and states the drop consequence", () => {
    // The distinction KPR-455's reader must not generalize away: every other
    // document in `telemetry` is disposable stats.
    const cursor = claude.slice(claude.indexOf("ops_sweep_cursor"));
    expect(cursor).toMatch(/DURABLE SWEEP PROGRESS, NOT A HEARTBEAT/);
    expect(cursor).toMatch(/never notified/);
    expect(claude).toMatch(/ops_subscriptions\.enabled: false/);
  });
});
