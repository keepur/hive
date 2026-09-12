/**
 * KPR-468 chunk 4 — acknowledgement intake, its deadline seam and the
 * notifier singleton, driven through the shared harness.
 *
 * Everything here goes through `harness()` (src/ops/testing/notifier-harness.ts)
 * and `notifier.accept(...)` rather than constructing a `FakeDb`/`OpsNotifier`
 * by hand. THE ONE EXCEPTION is the availability block's pre-`init()` case,
 * which must observe a notifier that has NOT been initialized and therefore
 * cannot use a harness that has already called `init()`; it says so at its own
 * site, following delivery.integration.test.ts's precedent.
 *
 * Ledger rows are seeded DIRECTLY (`seedRow`) rather than grown through ingest
 * and delivery: intake's rules are stated over a row's STATE, and driving a row
 * into `snoozed` or `dismissed` through the event path would make every case
 * here depend on two other phases' behaviour as well as its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The logger is mocked so the invalid-`at` warn can be COUNTED rather than
// asserted in prose. `vi.hoisted` is required — `vi.mock` factories are
// hoisted above top-level `const`s (delivery.integration.test.ts:17).
const mockLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));

import { ObjectId } from "mongodb";
import { WriteGuard } from "../db/write-guard.js";
import { OPS_ID_MAX_LENGTH } from "./ids.js";
import { parseHandle } from "./intake.js";
import { OpsNotifier } from "./notifier.js";
import { __resetOpsNotifierForTests, acceptOpsAcknowledgement, setOpsNotifier } from "./notifier-singleton.js";
import {
  HARD_SNOOZE_CEILING_MS,
  INTAKE_DEADLINE_MS,
  OPS_NOTIFICATIONS_COLLECTION,
  OPS_POLICY_COLLECTION,
  OPS_POLICY_ID,
  OPS_SYSTEM_PRINCIPAL,
  type OpsAcknowledgement,
  type OpsNotification,
} from "./notification-types.js";
import { FakeDb } from "./testing/fake-db.js";
import { BASE, harness, sub, t, type NotifierHarness } from "./testing/notifier-harness.js";

/** `ledgerRetentionDays(90)` — the harness's default activity retention, capped. */
const RETENTION_MS = 30 * 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** A syntactically valid handle that names no row. */
const ABSENT_HANDLE = "0".repeat(24);

const warnLines = (fragment: string) => mockLog.warn.mock.calls.filter((call) => String(call[0]).includes(fragment));

const hasKey = (row: object, key: string) => Object.prototype.hasOwnProperty.call(row, key);

/**
 * The keys whose values differ between two reads of one row. `JSON.stringify`
 * is what makes this total over the row's shapes: `ObjectId` and `Date` both
 * carry a `toJSON`, so an identity comparison that would fail on a re-read
 * copy compares equal here. An EMPTY result is this file's "recorded nothing"
 * / "byte-identical" assertion.
 */
function changedKeys(before: object, after: object): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const value = (row: object, key: string) => JSON.stringify((row as Record<string, unknown>)[key]);
  return [...keys].filter((key) => value(before, key) !== value(after, key)).sort();
}

let seq = 0;

/** A fully-formed ledger row. `resource` by default so a dismissal is legal. */
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

/**
 * ⚠ The double does NOT write `_id` back onto the caller's document
 * (fake-db.ts divergence 4), so the handle comes from `insertedId`.
 */
async function seedRow(
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

/** The ops_notifications `updateOne`s intake issued — its CAS, and only its CAS. */
const casWrites = (h: NotifierHarness, from = 0) =>
  h.db.operations
    .slice(from)
    .filter(
      (op) =>
        op.collection === OPS_NOTIFICATIONS_COLLECTION &&
        op.operation === "updateOne" &&
        (op.context.update?.$set as Record<string, unknown> | undefined)?.lastAckKey !== undefined,
    );

/** Yields microtasks until the row satisfies `until`. No timers are involved. */
async function settleRow(
  h: NotifierHarness,
  id: ObjectId,
  until: (row: OpsNotification) => boolean,
): Promise<OpsNotification> {
  for (let i = 0; i < 200; i += 1) {
    const row = await h.store.notifications.findOne({ _id: id });
    if (row && until(row as OpsNotification)) return row as OpsNotification;
  }
  throw new Error("the row never reached the expected state");
}

beforeEach(() => {
  mockLog.debug.mockClear();
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  __resetOpsNotifierForTests();
});

// ───────────────────────────────────────────────────────────────────────────
// parseHandle — unit-shaped; the exported function takes no harness.
// ───────────────────────────────────────────────────────────────────────────

describe("parseHandle — the hex round-trip, not ObjectId.isValid", () => {
  const hex = "507f1f77bcf86cd799439011";

  it("accepts a lowercase handle and an ALL-UPPERCASE one, and both name the same row", () => {
    const lower = parseHandle(hex);
    const upper = parseHandle(hex.toUpperCase());
    expect(lower).toBeInstanceOf(ObjectId);
    expect(upper).toBeInstanceOf(ObjectId);
    // The same twelve bytes: a vendor round-trip that upcased a callback value
    // must not become an `unknown-handle` refusal for a real act.
    expect(String(lower)).toBe(hex);
    expect(String(upper)).toBe(hex);
    expect(lower!.equals(upper!)).toBe(true);
  });

  it("rejects a 12-CHARACTER string, and the 12-BYTE value ObjectId.isValid does admit", () => {
    // ⚠ MEASURED, not assumed: on the driver this repo pins (mongodb 7.6.0)
    // `isValid` ALREADY rejects a 12-character STRING — the widening intake.ts's
    // comment names is historical. What it still admits is a 12-BYTE BUFFER,
    // which `typeof handle !== "string"` is what catches. So the length test is
    // defence against a driver whose isValid is looser, not against today's,
    // and this case asserts the FUNCTION rather than pinning the driver.
    expect(parseHandle("123456789012")).toBeUndefined();
    expect(ObjectId.isValid(Buffer.alloc(12))).toBe(true);
    expect(parseHandle(Buffer.alloc(12))).toBeUndefined();
  });

  it.each([
    ["23 characters", hex.slice(0, 23)],
    ["25 characters", `${hex}a`],
    ["non-hex", "zzzzzzzzzzzzzzzzzzzzzzzz"],
    ["a number", 12 as unknown],
    ["an object", {} as unknown],
    ["undefined", undefined],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(parseHandle(value)).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D7's check ORDER — the two cases that must be written separately.
// ───────────────────────────────────────────────────────────────────────────

describe("the check order — the replay check precedes legality, and the anchor is lastAckAt", () => {
  it("a duplicated dismissal returns already-applied, never illegal-transition", async () => {
    const h = await harness();
    const { handle } = await seedRow(h);
    const input = ack(handle, { act: "dismissed" });

    await expect(h.notifier.accept(input)).resolves.toEqual({ state: "applied", rowState: "dismissed" });
    // `dismissed` is NOT a legal FROM state. Under a legality-first order the
    // acknowledger's own duplicated callback is told its act failed.
    await expect(h.notifier.accept(input)).resolves.toEqual({ state: "noop", reason: "already-applied" });
    expect(h.snapshot().intakeNoop).toBe(1);
    expect(h.snapshot().intakeRefused).toBe(0);
  });

  it("a delayed duplicate of an older act is superseded, not applied", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h);

    h.advance(MINUTE);
    const first = h.now();
    const seen = ack(handle, { act: "seen", at: first });
    await expect(h.notifier.accept(seen)).resolves.toEqual({ state: "applied", rowState: "seen" });

    h.advance(MINUTE);
    const second = h.now();
    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", at: second, snoozedUntil: new Date(second.getTime() + HOUR) })),
    ).resolves.toMatchObject({ state: "applied", rowState: "snoozed" });
    const before = await rowById(h, id);

    // The OLDER act's callback arrives late. Its key differs from the row's,
    // so only the monotonicity guard can catch it.
    await expect(h.notifier.accept(seen)).resolves.toEqual({ state: "noop", reason: "superseded" });
    const after = await rowById(h, id);
    expect(changedKeys(before, after)).toEqual([]);
    expect(after.state).toBe("snoozed");
    expect(after.snoozedUntil).toEqual(new Date(second.getTime() + HOUR));
    expect(hasKey(after, "expiresAt")).toBe(false);
  });

  it("a SYSTEM transition landing between a human act and its callback does not supersede that callback", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const { id, handle } = await seedRow(h, { deliveryReference: { kind: "fake", id: "x" } });

    // The human pauses the row at t(1).
    h.advance(MINUTE);
    const humanAt = h.now();
    await expect(
      h.notifier.accept(
        ack(handle, { act: "snoozed", at: humanAt, snoozedUntil: new Date(humanAt.getTime() + MINUTE) }),
      ),
    ).resolves.toMatchObject({ state: "applied" });

    // The human's SECOND act happens at t(2) — its callback is delayed.
    h.advance(MINUTE);
    const callbackAt = h.now();

    // ... and a SYSTEM transition lands first: the snooze expires on this tick,
    // which rewrites principal and principalAt and leaves lastAckAt alone.
    h.advance(MINUTE);
    await h.tick();
    const expired = await rowById(h, id);
    expect(expired.principal).toBe(OPS_SYSTEM_PRINCIPAL);
    expect(expired.principalAt).toEqual(h.now());
    expect(expired.lastAckAt).toEqual(humanAt);

    // The delayed callback now arrives. Against a principalAt-anchored guard
    // this is "superseded" and a real human act is LOST — and the row nudges
    // forever.
    await expect(h.notifier.accept(ack(handle, { act: "seen", at: callbackAt }))).resolves.toEqual({
      state: "applied",
      rowState: "seen",
    });
    expect((await rowById(h, id)).state).toBe("seen");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D7 rule 5 / C9 — attribution.
// ───────────────────────────────────────────────────────────────────────────

describe("attribution — the principal and the instant and nothing else", () => {
  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["whitespace-only", "   "],
    ["a number", 7 as unknown],
    ["null", null as unknown],
  ])("refuses unattributed when actorId is %s", async (_label, actorId) => {
    const h = await harness();
    const { id, handle } = await seedRow(h);
    const before = await rowById(h, id);

    await expect(h.notifier.accept({ ...ack(handle), actorId: actorId as string })).resolves.toEqual({
      state: "refused",
      reason: "unattributed",
    });
    expect(changedKeys(before, await rowById(h, id))).toEqual([]);
  });

  it("refuses an actorId longer than OPS_ID_MAX_LENGTH — never truncates it — and admits one at the bound", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h);
    const before = await rowById(h, id);

    // Unbounded, a caller-supplied string was stored TWICE on the row: as
    // `principal` and inside `lastAckKey`.
    await expect(h.notifier.accept(ack(handle, { actorId: "U".repeat(OPS_ID_MAX_LENGTH + 1) }))).resolves.toEqual({
      state: "refused",
      reason: "unattributed",
    });
    expect(changedKeys(before, await rowById(h, id))).toEqual([]);

    const atBound = "U".repeat(OPS_ID_MAX_LENGTH);
    await expect(h.notifier.accept(ack(handle, { actorId: atBound }))).resolves.toEqual({
      state: "applied",
      rowState: "seen",
    });
    expect((await rowById(h, id)).principal).toBe(atBound);
  });

  it("refuses the RESERVED system principal and leaves the row byte-identical", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h);
    const before = await rowById(h, id);

    // Without an explicit refusal a mis-written edge, an operator command
    // defaulting its actor, or a transport handing back its own service
    // identity lands an act attributed to the system principal.
    await expect(h.notifier.accept(ack(handle, { actorId: OPS_SYSTEM_PRINCIPAL }))).resolves.toEqual({
      state: "refused",
      reason: "unattributed",
    });
    expect(changedKeys(before, await rowById(h, id))).toEqual([]);
    expect(h.snapshot().intakeRefused).toBe(1);
  });

  it("records the actor and the instant on an applied act, and nothing else about them", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h);
    const before = await rowById(h, id);

    // The clock is moved first, so stateAt/principalAt actually MOVE and the
    // changed-key set is evidence rather than a coincidence of the fixture.
    h.advance(MINUTE);
    await h.notifier.accept(ack(handle, { actorId: "U0ACKER", at: h.now() }));
    const after = await rowById(h, id);

    expect(after.principal).toBe("U0ACKER");
    expect(after.principalAt).toEqual(h.now());
    expect(after.stateAt).toEqual(h.now());
    expect(changedKeys(before, after)).toEqual(
      ["expiresAt", "lastAckAt", "lastAckKey", "nextNudgeAt", "principal", "principalAt", "state", "stateAt"].sort(),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The three refusals that are not about attribution.
// ───────────────────────────────────────────────────────────────────────────

describe("a cleared row", () => {
  it.each(["seen", "dismissed", "snoozed"] as const)("refuses %s with row-cleared and records nothing", async (act) => {
    const h = await harness();
    const { id, handle } = await seedRow(h, { state: "cleared", stateAt: BASE, expiresAt: t(60) });
    const before = await rowById(h, id);

    await expect(
      h.notifier.accept(ack(handle, { act, snoozedUntil: new Date(BASE.getTime() + HOUR) })),
    ).resolves.toEqual({ state: "refused", reason: "row-cleared" });
    expect(changedKeys(before, await rowById(h, id))).toEqual([]);
  });
});

describe("an integrity-class row", () => {
  it("refuses a dismissal (D7 rule 3) and records nothing", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h, { class: "integrity" });
    const before = await rowById(h, id);

    await expect(h.notifier.accept(ack(handle, { act: "dismissed" }))).resolves.toEqual({
      state: "refused",
      reason: "integrity-dismissal",
    });
    expect(changedKeys(before, await rowById(h, id))).toEqual([]);
  });

  it("accepts seen and snoozed on the same class", async () => {
    const h = await harness();
    const a = await seedRow(h, { class: "integrity" });
    await expect(h.notifier.accept(ack(a.handle, { act: "seen" }))).resolves.toEqual({
      state: "applied",
      rowState: "seen",
    });

    const b = await seedRow(h, { class: "integrity" });
    await expect(
      h.notifier.accept(ack(b.handle, { act: "snoozed", snoozedUntil: new Date(BASE.getTime() + HOUR) })),
    ).resolves.toEqual({
      state: "applied",
      rowState: "snoozed",
      snoozedUntil: new Date(BASE.getTime() + HOUR),
    });
  });
});

describe("transition legality", () => {
  it("refuses an act on a dismissed row — with a DIFFERENT key, so the replay check cannot absorb it", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h);
    await h.notifier.accept(ack(handle, { act: "dismissed" }));

    h.advance(MINUTE);
    const before = await rowById(h, id);
    await expect(h.notifier.accept(ack(handle, { act: "seen", at: h.now(), actorId: "U2" }))).resolves.toEqual({
      state: "refused",
      reason: "illegal-transition",
    });
    expect(changedKeys(before, await rowById(h, id))).toEqual([]);
  });

  it.each([
    ["cleared — a clear attributed to a person", "cleared"],
    ["pending — a working state with no nextNudgeAt", "pending"],
    ["delivered — a working state with no nextNudgeAt", "delivered"],
    ["an arbitrary string", "resolved"],
    ["empty", ""],
    ["missing", undefined],
    ["a number", 7],
  ] as Array<[string, unknown]>)(
    "refuses an act outside D7's three (%s) as illegal-transition and records nothing",
    async (_label, act) => {
      const h = await harness();
      const { id, handle } = await seedRow(h, { state: "delivered", nextNudgeAt: t(5) });
      const before = await rowById(h, id);

      await expect(h.notifier.accept({ ...ack(handle), act: act as OpsAcknowledgement["act"] })).resolves.toEqual({
        state: "refused",
        reason: "illegal-transition",
      });
      expect(changedKeys(before, await rowById(h, id))).toEqual([]);
      expect(casWrites(h)).toHaveLength(0);
    },
  );

  it("a malformed act is refused AHEAD of the replay, monotonicity and cleared checks", async () => {
    // Each of those would otherwise answer a malformed call with a result that
    // tells the edge it was fine: `superseded` or the benign `row-cleared`.
    const h = await harness();

    const acked = await seedRow(h, { lastAckAt: t(5), lastAckKey: "U9:seen:x" });
    await expect(h.notifier.accept({ ...ack(acked.handle), act: "pending" as never, at: BASE })).resolves.toEqual({
      state: "refused",
      reason: "illegal-transition",
    });

    const cleared = await seedRow(h, { state: "cleared", expiresAt: t(60) });
    await expect(h.notifier.accept({ ...ack(cleared.handle), act: "cleared" as never })).resolves.toEqual({
      state: "refused",
      reason: "illegal-transition",
    });
  });

  it("refuses an unknown handle without touching the ledger", async () => {
    const h = await harness();
    await seedRow(h);
    const mark = h.db.operations.length;

    await expect(h.notifier.accept(ack(ABSENT_HANDLE))).resolves.toEqual({
      state: "refused",
      reason: "unknown-handle",
    });
    expect(casWrites(h, mark)).toHaveLength(0);
  });

  it("refuses a MALFORMED handle before taking any lock or reading anything", async () => {
    const h = await harness();
    const mark = h.db.operations.length;
    await expect(h.notifier.accept(ack("not-a-handle"))).resolves.toEqual({
      state: "refused",
      reason: "unknown-handle",
    });
    expect(h.db.operations.slice(mark)).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D12's clamp — always present, clamped and applied, never refused.
// ───────────────────────────────────────────────────────────────────────────

describe("the snooze clamp", () => {
  it("clamps to a registered maxSnoozeMs and ECHOES the clamped value", async () => {
    const h = await harness();
    h.notifier.__setPolicyForTests({ _id: OPS_POLICY_ID, maxSnoozeMs: HOUR });
    const { id, handle } = await seedRow(h);

    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", snoozedUntil: new Date(BASE.getTime() + 86_400_000) })),
    ).resolves.toEqual({
      state: "applied",
      rowState: "snoozed",
      snoozedUntil: new Date(BASE.getTime() + HOUR),
    });
    expect((await rowById(h, id)).snoozedUntil).toEqual(new Date(BASE.getTime() + HOUR));
  });

  it("clamps to the HARD ceiling on the cold path and on the shipped default alike", async () => {
    // Cold path: no tick has completed, so no policy copy has been retained.
    const cold = await harness();
    const a = await seedRow(cold);
    await expect(
      cold.notifier.accept(ack(a.handle, { act: "snoozed", snoozedUntil: t(60 * 24 * 365) })),
    ).resolves.toEqual({
      state: "applied",
      rowState: "snoozed",
      snoozedUntil: new Date(BASE.getTime() + HARD_SNOOZE_CEILING_MS),
    });

    // The shipped default: a read SUCCEEDED and nothing is registered.
    const shipped = await harness();
    shipped.notifier.__setPolicyForTests(null);
    const b = await seedRow(shipped);
    await expect(
      shipped.notifier.accept(ack(b.handle, { act: "snoozed", snoozedUntil: t(60 * 24 * 365) })),
    ).resolves.toEqual({
      state: "applied",
      rowState: "snoozed",
      snoozedUntil: new Date(BASE.getTime() + HARD_SNOOZE_CEILING_MS),
    });
  });

  it("a registered maximum LARGER than the hard ceiling still yields the hard ceiling", async () => {
    const h = await harness();
    // A registered maximum can only TIGHTEN the contract-side ceiling.
    h.notifier.__setPolicyForTests({ _id: OPS_POLICY_ID, maxSnoozeMs: HARD_SNOOZE_CEILING_MS * 10 });
    const { id, handle } = await seedRow(h);

    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", snoozedUntil: t(60 * 24 * 365) })),
    ).resolves.toMatchObject({
      snoozedUntil: new Date(BASE.getTime() + HARD_SNOOZE_CEILING_MS),
    });
    expect((await rowById(h, id)).snoozedUntil).toEqual(new Date(BASE.getTime() + HARD_SNOOZE_CEILING_MS));
  });

  it.each([
    ["absent", undefined],
    ["not a Date", "2026-01-02T00:00:00.000Z" as unknown as Date],
    ["NaN", new Date("nonsense")],
    ["in the past", new Date(BASE.getTime() - 1)],
    ["equal to anchorAt", BASE],
  ] as Array<[string, Date | undefined]>)(
    "refuses snooze-not-future when snoozedUntil is %s, and records nothing",
    async (_label, snoozedUntil) => {
      const h = await harness();
      const { id, handle } = await seedRow(h);
      const before = await rowById(h, id);

      await expect(h.notifier.accept(ack(handle, { act: "snoozed", snoozedUntil }))).resolves.toEqual({
        state: "refused",
        reason: "snooze-not-future",
      });
      expect(changedKeys(before, await rowById(h, id))).toEqual([]);
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────
// min(at, now) — the one derived value that governs every clock-bearing write.
// ───────────────────────────────────────────────────────────────────────────

describe("the anchor", () => {
  it("a bogus FUTURE `at` buys no unbounded snooze, no stretched retention and no lockout", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h, { class: "integrity" });
    const tenYears = new Date(BASE.getTime() + 10 * 365 * 86_400_000);
    const input = ack(handle, {
      act: "snoozed",
      at: tenYears,
      snoozedUntil: new Date(tenYears.getTime() + 86_400_000),
    });

    // The ceiling is anchored on anchorAt, so it is a CEILING rather than a
    // caller-supplied value — on an `integrity` row included.
    await expect(h.notifier.accept(input)).resolves.toEqual({
      state: "applied",
      rowState: "snoozed",
      snoozedUntil: new Date(BASE.getTime() + HARD_SNOOZE_CEILING_MS),
    });
    const row = await rowById(h, id);
    expect(row.stateAt).toEqual(BASE);
    expect(row.principalAt).toEqual(BASE);
    expect(row.lastAckAt).toEqual(BASE);
    expect(row.snoozedUntil!.getTime()).toBeLessThanOrEqual(BASE.getTime() + HARD_SNOOZE_CEILING_MS);

    // lastAckKey alone keeps the RAW `at`, so a retried duplicate is idempotent.
    expect(row.lastAckKey).toBe(`U1:snoozed:${tenYears.toISOString()}`);
    await expect(h.notifier.accept(input)).resolves.toEqual({ state: "noop", reason: "already-applied" });

    // ... and the actor is not locked out of the row for ten years.
    h.advance(MINUTE);
    await expect(h.notifier.accept(ack(handle, { act: "seen", at: h.now() }))).resolves.toEqual({
      state: "applied",
      rowState: "seen",
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D9's state invariant and the two flags a transition owns.
// ───────────────────────────────────────────────────────────────────────────

describe("D9's expiresAt invariant", () => {
  it("seen sets it, dismissed sets it, and snoozed UNSETS it — including on the seen → snoozed arm", async () => {
    const h = await harness();

    const seen = await seedRow(h);
    await h.notifier.accept(ack(seen.handle, { act: "seen" }));
    expect((await rowById(h, seen.id)).expiresAt).toEqual(new Date(BASE.getTime() + RETENTION_MS));

    const dismissed = await seedRow(h);
    await h.notifier.accept(ack(dismissed.handle, { act: "dismissed" }));
    expect((await rowById(h, dismissed.id)).expiresAt).toEqual(new Date(BASE.getTime() + RETENTION_MS));

    // The arm an enumeration of transitions misses: the row arrives in a
    // STOPPED state carrying a live TTL horizon and moves back into a WORKING
    // one, where a retained TTL would delete it mid-pause.
    h.advance(MINUTE);
    const at = h.now();
    await expect(
      h.notifier.accept(ack(seen.handle, { act: "snoozed", at, snoozedUntil: new Date(at.getTime() + HOUR) })),
    ).resolves.toMatchObject({ state: "applied" });
    const row = await rowById(h, seen.id);
    expect(row.state).toBe("snoozed");
    expect(hasKey(row, "expiresAt")).toBe(false);
  });
});

describe("forceDeliver and nextNudgeAt", () => {
  it("snoozed RETAINS forceDeliver and unsets nextNudgeAt — the re-delivery is still owed", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h, { forceDeliver: true, nextNudgeAt: t(5) });

    await expect(
      h.notifier.accept(ack(handle, { act: "snoozed", snoozedUntil: new Date(BASE.getTime() + HOUR) })),
    ).resolves.toMatchObject({ state: "applied" });
    const row = await rowById(h, id);
    expect(row.forceDeliver).toBe(true);
    expect(hasKey(row, "nextNudgeAt")).toBe(false);
  });

  it.each(["seen", "dismissed"] as const)("%s clears both", async (act) => {
    const h = await harness();
    const { id, handle } = await seedRow(h, { forceDeliver: true, nextNudgeAt: t(5) });

    await expect(h.notifier.accept(ack(handle, { act }))).resolves.toMatchObject({ state: "applied" });
    const row = await rowById(h, id);
    expect(hasKey(row, "forceDeliver")).toBe(false);
    expect(hasKey(row, "nextNudgeAt")).toBe(false);
  });
});

describe("re-snoozing", () => {
  it("moves snoozedUntil and nothing else beyond the attribution and idempotence marks", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h);

    h.advance(MINUTE);
    const first = h.now();
    await h.notifier.accept(ack(handle, { act: "snoozed", at: first, snoozedUntil: new Date(first.getTime() + HOUR) }));
    const before = await rowById(h, id);

    h.advance(MINUTE);
    const second = h.now();
    await expect(
      h.notifier.accept(
        ack(handle, { act: "snoozed", at: second, snoozedUntil: new Date(second.getTime() + 2 * HOUR) }),
      ),
    ).resolves.toMatchObject({ state: "applied", rowState: "snoozed" });
    const after = await rowById(h, id);

    expect(changedKeys(before, after)).toEqual(
      ["lastAckAt", "lastAckKey", "principalAt", "snoozedUntil", "stateAt"].sort(),
    );
    expect(after.state).toBe("snoozed");
    expect(after.snoozedUntil).toEqual(new Date(second.getTime() + 2 * HOUR));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The substituted `at`, and the residual it is counted for.
// ───────────────────────────────────────────────────────────────────────────

describe("an unusable `at`", () => {
  it("is substituted with the server clock, counted at the seam, and warned", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h);

    await expect(h.notifier.accept(ack(handle, { at: new Date("nonsense") }))).resolves.toEqual({
      state: "applied",
      rowState: "seen",
    });
    expect((await rowById(h, id)).stateAt).toEqual(h.now());
    expect(h.snapshot().intakeInvalidAt).toBe(1);
    expect(warnLines("unusable `at`")).toHaveLength(1);

    // A value that is not a Date at all takes the same arm.
    h.advance(1_000);
    await expect(
      h.notifier.accept(ack(handle, { at: "2026-01-01T00:00:00.000Z" as unknown as Date })),
    ).resolves.toEqual({ state: "applied", rowState: "seen" });
    expect(h.snapshot().intakeInvalidAt).toBe(2);
  });

  it("names the act in that warn only once it is one of D7's three — the line runs BEFORE act validation", async () => {
    const h = await harness();
    const { handle } = await seedRow(h);
    const hostile = "<!channel> " + "z".repeat(5_000);

    await expect(h.notifier.accept(ack(handle, { act: hostile as never, at: new Date("nonsense") }))).resolves.toEqual({
      state: "refused",
      reason: "illegal-transition",
    });
    await h.notifier.accept(ack(handle, { act: "dismissed", at: new Date("nonsense") }));

    expect(warnLines("unusable `at`").map((call) => call[1])).toEqual([{ act: "invalid" }, { act: "dismissed" }]);
  });

  it("⚠ the NAMED consequence: two such calls derive DIFFERENT lastAckKeys, so a duplicate double-applies", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h);
    // Byte-identical input, twice — the shape a duplicated vendor callback has.
    const input = ack(handle, { at: new Date("nonsense") });

    await expect(h.notifier.accept(input)).resolves.toEqual({ state: "applied", rowState: "seen" });
    const firstKey = (await rowById(h, id)).lastAckKey;

    // The server clock is what the key now derives from, and it advances
    // between a callback and its retry.
    h.advance(1_000);
    await expect(h.notifier.accept(input)).resolves.toEqual({ state: "applied", rowState: "seen" });
    const secondKey = (await rowById(h, id)).lastAckKey;

    expect(secondKey).not.toBe(firstKey);
    expect(h.snapshot().intakeNoop).toBe(0);
    expect(h.snapshot().intakeApplied).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The deadline seam, and the CAS.
// ───────────────────────────────────────────────────────────────────────────

describe("the INTAKE_DEADLINE_MS seam", () => {
  it("returns unavailable without throwing, the abandoned write still lands, and the retry is already-applied", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h);
    const input = ack(handle);

    // The deadline is a REAL setTimeout, not the harness's injected clock —
    // the injected clock only drives ledger arithmetic.
    vi.useFakeTimers();
    const gate = h.db.pause(OPS_NOTIFICATIONS_COLLECTION, "findOne");
    const call = h.notifier.accept(input);
    await gate.reached;
    await vi.advanceTimersByTimeAsync(INTAKE_DEADLINE_MS + 1);

    await expect(call).resolves.toEqual({ state: "unavailable" });
    expect(h.snapshot().intakeUnavailable).toBe(1);
    // Logged as a DEADLINE, distinguishable from a storage fault (below).
    expect(warnLines("ops intake deadline elapsed")).toHaveLength(1);
    expect(warnLines("ops intake work failed")).toHaveLength(0);

    // The losing side keeps running to completion — deliberately.
    gate.release();
    const landed = await settleRow(h, id, (row) => row.state === "seen");
    expect(landed.principal).toBe("U1");
    vi.useRealTimers();

    // ⚠ The one sentence KPR-455's edge needs: unavailable means UNKNOWN, and
    // retrying the SAME (actorId, act, at) is the correct response.
    await expect(h.notifier.accept(input)).resolves.toEqual({ state: "noop", reason: "already-applied" });
  });
});

describe("a storage fault inside intake", () => {
  it("answers unavailable AND logs the underlying reason — it is not silent, and not logged as a deadline", async () => {
    // ⚠ THE ABLE-TO-FAIL CASE: the deadline wrapper turned a rejection into
    // `unavailable` and dropped the reason, and accept()'s own warn could not
    // fire because that wrapper never rejects — a Mongo fault left no trace.
    const h = await harness();
    const { handle } = await seedRow(h);
    h.db.failNext(OPS_NOTIFICATIONS_COLLECTION, "findOne", new Error("injected storage fault"));

    await expect(h.notifier.accept(ack(handle))).resolves.toEqual({ state: "unavailable" });

    const lines = warnLines("ops intake work failed");
    expect(lines).toHaveLength(1);
    expect(String(lines[0]![1].error)).toContain("injected storage fault");
    expect(warnLines("ops intake deadline elapsed")).toHaveLength(0);
    expect(h.snapshot().intakeUnavailable).toBe(1);
  });
});

describe("the CAS", () => {
  it("writes $exists: false for a row that has never been acknowledged, and the retained values afterwards", async () => {
    const h = await harness();
    const { handle } = await seedRow(h);

    const mark = h.db.operations.length;
    await h.notifier.accept(ack(handle));
    const first = casWrites(h, mark)[0]!;
    // NEVER a literal `undefined`: that works today only because
    // `ignoreUndefined` is unset, which is an accident of a client option.
    expect(first.context.filter!.lastAckKey).toEqual({ $exists: false });
    expect(first.context.filter!.lastAckAt).toEqual({ $exists: false });
    expect(first.context.filter!.state).toBe("delivered");

    h.advance(MINUTE);
    const at = h.now();
    const secondMark = h.db.operations.length;
    await h.notifier.accept(ack(handle, { act: "snoozed", at, snoozedUntil: new Date(at.getTime() + HOUR) }));
    const second = casWrites(h, secondMark)[0]!;
    expect(second.context.filter!.lastAckKey).toBe(`U1:seen:${BASE.toISOString()}`);
    expect(second.context.filter!.lastAckAt).toEqual(BASE);
    expect(second.context.filter!.state).toBe("seen");
  });

  it("a lost CAS retries ONCE and then returns unavailable, applying nothing", async () => {
    const h = await harness();
    const { id, handle } = await seedRow(h, { state: "pending" });
    const before = await rowById(h, id);

    // Moved UNDER the read — an after-hook, so the read has already snapshotted
    // the row when the test mutates it and the CAS's precondition is stale.
    // The flip writes through `updateOne`, which matches neither hook.
    let state: OpsNotification["state"] = "pending";
    const flip = async () => {
      state = state === "pending" ? "delivered" : "pending";
      await h.store.notifications.updateOne({ _id: id }, { $set: { state } });
    };
    const first = h.db.pause(OPS_NOTIFICATIONS_COLLECTION, "findOne", () => true, true);
    const second = h.db.pause(OPS_NOTIFICATIONS_COLLECTION, "findOne", () => true, true);

    const mark = h.db.operations.length;
    const call = h.notifier.accept(ack(handle));
    await first.reached;
    await flip();
    first.release();
    await second.reached;
    await flip();
    second.release();

    await expect(call).resolves.toEqual({ state: "unavailable" });
    expect(casWrites(h, mark)).toHaveLength(2); // one retry, and only one
    expect(h.snapshot().intakeUnavailable).toBe(1);
    const after = await rowById(h, id);
    expect(hasKey(after, "lastAckKey")).toBe(false);
    expect(hasKey(after, "lastAckAt")).toBe(false);
    // The two flips returned the row to its seeded state, so an EMPTY set is
    // the whole claim: nothing intake could have written is on the row.
    expect(changedKeys(before, after)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D5 — intake reads the RETAINED policy copy, never a fresh one.
// ───────────────────────────────────────────────────────────────────────────

describe("the retained policy copy", () => {
  it("performs no ops_policy read, and exactly one indexed read plus one CAS", async () => {
    const h = await harness();
    h.notifier.__setPolicyForTests({ _id: OPS_POLICY_ID, maxSnoozeMs: HOUR });
    const { handle } = await seedRow(h);

    const mark = h.db.operations.length;
    await h.notifier.accept(ack(handle, { act: "snoozed", snoozedUntil: new Date(BASE.getTime() + 86_400_000) }));
    const after = h.db.operations.slice(mark);

    expect(after.filter((op) => op.collection === OPS_POLICY_COLLECTION)).toHaveLength(0);
    expect(
      after.filter((op) => op.collection === OPS_NOTIFICATIONS_COLLECTION && op.operation === "findOne"),
    ).toHaveLength(1);
    expect(
      after.filter((op) => op.collection === OPS_NOTIFICATIONS_COLLECTION && op.operation === "updateOne"),
    ).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D10 — availability, and the singleton.
// ───────────────────────────────────────────────────────────────────────────

describe("availability", () => {
  it("an accept BEFORE init() returns unavailable, never throws, and reads nothing", async () => {
    // ⚠ THE ONE PLACE THIS FILE BUILDS A NOTIFIER BY HAND: `harness()` calls
    // `init()` internally, so the pre-init posture is not reachable through it.
    const db = new FakeDb();
    const notifier = new OpsNotifier(
      db.db,
      90,
      () => true,
      () => BASE,
      async () => {},
    );

    await expect(notifier.accept(ack(ABSENT_HANDLE))).resolves.toEqual({ state: "unavailable" });
    expect(db.operations).toHaveLength(0);
    expect(notifier.getSnapshot().intakeUnavailable).toBe(1);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "0".repeat(24)],
    ["a number", 42],
  ])("an input that is %s is REFUSED, never thrown, and reads nothing", async (_label, input) => {
    // The seam is documented as never throwing; before this, `accept(undefined)`
    // threw on its first property read.
    const h = await harness();
    const mark = h.db.operations.length;

    await expect(h.notifier.accept(input as unknown as OpsAcknowledgement)).resolves.toEqual({
      state: "refused",
      reason: "unknown-handle",
    });
    expect(h.db.operations.slice(mark)).toHaveLength(0);
    expect(h.snapshot().intakeRefused).toBe(1);
  });

  it("answers unavailable and reads nothing while the DB identity guard is engaged, and applies once it clears", async () => {
    // KPR-456's `discover` answers the same way. An engaged guard means a read
    // may answer out of ANOTHER instance's database, where this handle could
    // resolve to nothing and be REFUSED `unknown-handle` — an answer an edge
    // must not retry, for an act that is real. `unavailable` is retry-safe.
    const guard = new WriteGuard({ instanceId: "test", dbName: "test" });
    const h = await harness({ writeGuard: guard });
    const { handle } = await seedRow(h);

    guard.engage("mismatch");
    const mark = h.db.operations.length;
    await expect(h.notifier.accept(ack(handle))).resolves.toEqual({ state: "unavailable" });
    expect(h.db.operations.slice(mark)).toHaveLength(0);

    guard.disengage();
    await expect(h.notifier.accept(ack(handle))).resolves.toEqual({ state: "applied", rowState: "seen" });
  });

  it("an accept after stop() returns unavailable and reads nothing", async () => {
    const h = await harness();
    const { handle } = await seedRow(h);
    await h.notifier.stop();

    const mark = h.db.operations.length;
    await expect(h.notifier.accept(ack(handle))).resolves.toEqual({ state: "unavailable" });
    expect(h.db.operations.slice(mark)).toHaveLength(0);
  });

  it("acceptOpsAcknowledgement answers unavailable while the singleton is UNSET", async () => {
    __resetOpsNotifierForTests();
    await expect(acceptOpsAcknowledgement(ack(ABSENT_HANDLE))).resolves.toEqual({ state: "unavailable" });
  });

  it("acceptOpsAcknowledgement routes to the notifier once it is set", async () => {
    const h = await harness();
    const { handle } = await seedRow(h);
    setOpsNotifier(h.notifier);

    await expect(acceptOpsAcknowledgement(ack(handle))).resolves.toEqual({ state: "applied", rowState: "seen" });
  });

  it("intake is LIVE from init() and is not gated on start()", async () => {
    const h = await harness(); // start: false — no timers, no sweep
    expect(h.notifier.getSnapshot().started).toBe(false);
    const { handle } = await seedRow(h);

    await expect(h.notifier.accept(ack(handle))).resolves.toEqual({ state: "applied", rowState: "seen" });
    expect(h.snapshot().intakeApplied).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The per-row latch — intake and delivery on ONE row.
// ───────────────────────────────────────────────────────────────────────────

describe("intake and delivery on one row", () => {
  it("serialize on the per-row latch — an acknowledgement waits for an in-flight delivery", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const { id, handle } = await seedRow(h, { state: "pending", attemptCount: 0, nextNudgeAt: BASE });

    // onDeliver runs INSIDE the delivery's own hold on the latch.
    let inside!: () => void;
    const reached = new Promise<void>((resolve) => {
      inside = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.transport.onDeliver = async () => {
      inside();
      await held;
    };

    const tick = h.tick();
    await reached;

    let settled = false;
    const mark = h.db.operations.length;
    const call = h.notifier.accept(ack(handle)).then((result) => {
      settled = true;
      return result;
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    // Blocked on the latch: it has not even taken its read.
    expect(settled).toBe(false);
    expect(h.db.operations.slice(mark)).toHaveLength(0);

    release();
    await tick;
    await expect(call).resolves.toEqual({ state: "applied", rowState: "seen" });

    // The delivery's own record landed FIRST and was not blended over.
    const row = await rowById(h, id);
    expect(row.state).toBe("seen");
    expect(row.attemptCount).toBe(1);
    expect(row.lastOutcome).toBe("accepted");
    expect(h.snapshot().deliveryRecordLost).toBe(0);
  });

  it("a delivery whose scan copy intake invalidated does NOT post — the pre-post re-read declines it", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const { id, handle } = await seedRow(h, { state: "pending", attemptCount: 0, nextNudgeAt: BASE });

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

    // NOTHING was posted: the decision to post is made from a read taken
    // inside the latch, and that read shows a row the human has already seen.
    // (Before the re-read this case posted and then lost record()'s CAS.)
    expect(h.transport.views).toHaveLength(0);
    expect(h.snapshot().deliveryRecordLost).toBe(0);
    expect(h.snapshot().deliveriesAccepted).toBe(0);
    const row = await rowById(h, id);
    expect(row.state).toBe("seen");
    expect(row.principal).toBe("U1");
    expect(row.attemptCount).toBe(0);
    expect(row.lastOutcome).toBeUndefined();
    // Declined, not stalled: the decline writes nothing to a stopped row.
    expect(hasKey(row, "stalledReason")).toBe(false);
    expect(hasKey(row, "nextNudgeAt")).toBe(false);
  });

  it("an acknowledgement landing on row B DURING row A's post keeps B from being posted", async () => {
    // ⚠ THE ABLE-TO-FAIL CASE for the pre-post re-read, in the shape the race
    // actually takes in production: B's latch is FREE while A's post holds the
    // phase (a real post can run ATTEMPT_SPACING_MS + SLACK_POST_TIMEOUT_MS), so
    // the acknowledgement applies at once — and the arm's scan copy of B still
    // says `pending`. Without the re-read, B is posted to a human who has
    // already dismissed it.
    const h = await harness({ subscriptions: [sub("s1")] });
    const a = await seedRow(h, { state: "pending", attemptCount: 0, nextNudgeAt: t(-1) });
    const b = await seedRow(h, { state: "pending", attemptCount: 0, nextNudgeAt: BASE });

    let bAck: Promise<unknown> | undefined;
    h.transport.onDeliver = async (view) => {
      if (view.handle !== a.handle) return;
      bAck = h.notifier.accept(ack(b.handle, { act: "dismissed" }));
      await expect(bAck).resolves.toEqual({ state: "applied", rowState: "dismissed" });
    };

    await h.tick();

    expect(bAck).toBeDefined();
    expect(h.transport.views.map((v) => v.handle)).toEqual([a.handle]);
    expect(h.snapshot().deliveriesAccepted).toBe(1);
    expect(h.snapshot().deliveryRecordLost).toBe(0);
    const rowB = await rowById(h, b.id);
    expect(rowB.state).toBe("dismissed");
    expect(rowB.attemptCount).toBe(0);
    expect(rowB.lastOutcome).toBeUndefined();
    expect((await rowById(h, a.id)).state).toBe("delivered");
  });
});
