/**
 * KPR-468 chunk 3 — the delivery phase, the stall, snooze expiry and the
 * notifier sweep, driven through the shared harness.
 *
 * Everything here goes through `harness()` (src/ops/testing/notifier-harness.ts)
 * rather than constructing a `FakeDb`/`OpsNotifier` by hand. THE ONE EXCEPTION
 * is the `init()`-failure block, which must observe `init()` itself throwing and
 * therefore cannot use a harness that has already called it; that block uses a
 * small local builder and says so at its own site.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The logger is mocked so warn-once and one-line-per-fault claims can be
// COUNTED rather than asserted in prose. `vi.hoisted` is required — `vi.mock`
// factories are hoisted above top-level `const`s (the publisher suite's
// pattern, src/ops/publisher.integration.test.ts:9).
const mockLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));

import { ObjectId } from "mongodb";
import { DeliveryPhase, __resetCadenceWarningsForTests, resolveCadence } from "./delivery.js";
import { OpsNotifier } from "./notifier.js";
import { NOTIFIER_STATS_KIND, OpsNotificationStore } from "./notification-store.js";
import {
  ATTEMPTS_RING_CAP,
  GAUGE_COUNT_LIMIT,
  OPS_NOTIFICATIONS_COLLECTION,
  OPS_POLICY_COLLECTION,
  OPS_POLICY_ID,
  OPS_SYSTEM_PRINCIPAL,
  STALL_JITTER_FRACTION,
  STALL_RECHECK_MS,
  freshCounters,
  type OpsNotification,
  type OpsPolicy,
} from "./notification-types.js";
import { OPS_EVENTS_COLLECTION, OPS_SUBSCRIPTIONS_COLLECTION, type OpsSubscription } from "./types.js";
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
  type FaultContext,
  type NotifierHarness,
} from "./testing/notifier-harness.js";

const CADENCE = 600_000;
const policyWith = (over: Partial<OpsPolicy> = {}): OpsPolicy => ({
  _id: OPS_POLICY_ID,
  cadence: { "integrity:deterministic": CADENCE },
  ...over,
});

const warnLines = (fragment: string) => mockLog.warn.mock.calls.filter((call) => String(call[0]).includes(fragment));

/** The ops_notifications `updateOne` that step 5 of a delivery writes. */
const recordWrites = (h: NotifierHarness) =>
  h.db.operations.filter(
    (op) =>
      op.collection === OPS_NOTIFICATIONS_COLLECTION &&
      op.operation === "updateOne" &&
      (op.context.update?.$set as Record<string, unknown> | undefined)?.lastOutcome !== undefined,
  );

/** The ops_notifications `updateOne` snooze expiry writes. */
const expiryWrites = (h: NotifierHarness) =>
  h.db.operations.filter(
    (op) =>
      op.collection === OPS_NOTIFICATIONS_COLLECTION &&
      op.operation === "updateOne" &&
      (op.context.filter as Record<string, unknown> | undefined)?.state === "snoozed",
  );

const heartbeatWrite = (ctx: FaultContext) =>
  (ctx.update?.$set as { kind?: string } | undefined)?.kind === NOTIFIER_STATS_KIND;

/** A fully-formed ledger row, for the gauge-saturation fixtures only. */
function ledgerRow(over: Partial<OpsNotification> = {}): OpsNotification {
  return {
    subscriptionId: "s1",
    subscriberId: "s1-owner",
    dedupeKey: "tool:workItem:w1:r1:x",
    producer: "tool",
    reasonId: "r1",
    class: "integrity",
    waiting: "nobody",
    retry: "deterministic",
    subject: { kind: "workItem", id: "w1" },
    generation: 1,
    firstEventId: "000000000000000000000001",
    latestEventId: "000000000000000000000001",
    eventCount: 1,
    firstSeenAt: t(0),
    lastEventAt: t(0),
    state: "pending",
    stateAt: t(0),
    principal: OPS_SYSTEM_PRINCIPAL,
    principalAt: t(0),
    attempts: [],
    attemptCount: 1,
    nudgeCount: 0,
    // Far in the future, so no delivery arm ever draws these fixtures.
    nextNudgeAt: t(10_000),
    appliedThroughAt: t(0),
    appliedThroughId: "000000000000000000000001",
    latestDetail: {},
    latestEvidence: [],
    ...over,
  };
}

beforeEach(() => {
  mockLog.debug.mockClear();
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
});

// ───────────────────────────────────────────────────────────────────────────
// resolveCadence — unit-shaped; the exported function takes no harness.
// ───────────────────────────────────────────────────────────────────────────

describe("resolveCadence — D5's data-sourced cadence, with no merge and no fallback", () => {
  beforeEach(() => __resetCadenceWarningsForTests());

  const row = { class: "integrity", retry: "deterministic" } as Pick<OpsNotification, "class" | "retry">;

  it("reads the (class, retry) table exactly as it is keyed", () => {
    expect(resolveCadence(row, sub("s1"), policyWith())).toBe(CADENCE);
    // A key for a DIFFERENT (class, retry) pair is not consulted.
    expect(resolveCadence(row, sub("s1"), { _id: OPS_POLICY_ID, cadence: { "integrity:transient": 1 } })).toBe(
      undefined,
    );
  });

  it("a cadenceProfile SUBSTITUTES the table wholesale", () => {
    const policy = policyWith({ profiles: { hourly: 3_600_000 } });
    expect(resolveCadence(row, sub("s1", { cadenceProfile: "hourly" }), policy)).toBe(3_600_000);
  });

  it("an UNKNOWN profile resolves undefined and does NOT fall back to the table", () => {
    const policy = policyWith({ profiles: { hourly: 3_600_000 } });
    // The table holds a live entry for this row's (class, retry) pair; the
    // point is that naming a profile takes the row out of the table entirely.
    expect(policy.cadence!["integrity:deterministic"]).toBe(CADENCE);
    expect(resolveCadence(row, sub("s1", { cadenceProfile: "nope" }), policy)).toBe(undefined);
  });

  it("a below-floor PROFILE clamps up and warns exactly once per (name, value)", () => {
    const policy = policyWith({ profiles: { fast: 1_000 }, minNudgeIntervalMs: 60_000 });
    const s = sub("s1", { cadenceProfile: "fast" });
    expect(resolveCadence(row, s, policy)).toBe(60_000);
    expect(resolveCadence(row, s, policy)).toBe(60_000);
    expect(resolveCadence(row, s, policy)).toBe(60_000);
    expect(warnLines("ops cadence profile below the registered minimum")).toHaveLength(1);

    // A DIFFERENT value under the same name warns again — the memo is keyed on
    // the pair, so a corrected-then-re-broken profile is not silenced forever.
    const changed = policyWith({ profiles: { fast: 2_000 }, minNudgeIntervalMs: 60_000 });
    expect(resolveCadence(row, s, changed)).toBe(60_000);
    expect(warnLines("ops cadence profile below the registered minimum")).toHaveLength(2);
  });

  it("a below-floor TABLE entry clamps up WITHOUT a warning", () => {
    const policy: OpsPolicy = {
      _id: OPS_POLICY_ID,
      cadence: { "integrity:deterministic": 1_000 },
      minNudgeIntervalMs: 60_000,
    };
    expect(resolveCadence(row, sub("s1"), policy)).toBe(60_000);
    expect(warnLines("ops cadence profile below the registered minimum")).toHaveLength(0);
  });

  it("a null policy and every non-positive or non-finite interval resolve undefined", () => {
    expect(resolveCadence(row, sub("s1"), null)).toBe(undefined);
    expect(resolveCadence(row, sub("s1"), { _id: OPS_POLICY_ID })).toBe(undefined);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveCadence(row, sub("s1"), { _id: OPS_POLICY_ID, cadence: { "integrity:deterministic": bad } })).toBe(
        undefined,
      );
    }
  });

  it("a profile named `constructor` does not read the prototype chain", () => {
    const policy = policyWith({ profiles: {} });
    expect(resolveCadence(row, sub("s1", { cadenceProfile: "constructor" }), policy)).toBe(undefined);
    expect(resolveCadence(row, sub("s1", { cadenceProfile: "toString" }), policy)).toBe(undefined);
    // And the same for the (class, retry) table, which is read through the
    // same `own` helper.
    const proto = { _id: OPS_POLICY_ID, cadence: {} } as OpsPolicy;
    expect(resolveCadence({ class: "constructor", retry: "x" } as never, sub("s1"), proto)).toBe(undefined);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The three outcomes.
// ───────────────────────────────────────────────────────────────────────────

describe("the three delivery outcomes", () => {
  it("accepted transitions pending → delivered, stores the reference, and schedules from the cadence", async () => {
    const h = await harness({ subscriptions: [sub("s1")], reasons: [reason("r1")], policy: policyWith() });
    const e = await h.seedEvent();
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.state).toBe("delivered");
    expect(row.stateAt).toEqual(BASE);
    expect(row.principal).toBe(OPS_SYSTEM_PRINCIPAL);
    expect(row.deliveryReference).toEqual({ kind: "fake", id: String(row._id) });
    expect(row.lastOutcome).toBe("accepted");
    expect(row.nextNudgeAt).toEqual(new Date(BASE.getTime() + CADENCE));
    expect(row.stalledAt).toBeUndefined();
    expect(row.stalledReason).toBeUndefined();
    expect(h.snapshot().deliveriesAccepted).toBe(1);
    // The view is structured and carries the RESOLVED target, plus remediation
    // from the registry row.
    expect(h.transport.views[0]!.target).toBe("C0000001");
    expect(h.transport.views[0]!.remediation).toEqual({ template: "re-run {toolName}", parameters: {} });
  });

  it("rejected leaves the state unchanged and records the closed reason", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    h.transport.program({ status: "rejected", reason: "target-unknown" });
    const e = await h.seedEvent();
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.state).toBe("pending");
    expect(row.lastOutcome).toBe("rejected");
    expect(row.deliveryReference).toBeUndefined();
    expect(row.attempts).toEqual([{ at: BASE, outcome: "rejected", adapterId: "fake", reason: "target-unknown" }]);
    // No retry ladder: the next schedule is the ordinary cadence, not a backoff.
    expect(row.nextNudgeAt).toEqual(new Date(BASE.getTime() + CADENCE));
    expect(h.snapshot().deliveriesRejected).toBe(1);
  });

  it("unknown never reaches delivered and is recorded as uncertainty", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    h.transport.program({ status: "unknown", reason: "timeout" });
    const e = await h.seedEvent();
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.state).toBe("pending");
    expect(row.lastOutcome).toBe("unknown");
    expect(row.deliveryReference).toBeUndefined();
    expect(h.snapshot().deliveriesUnknown).toBe(1);
    expect(h.snapshot().deliveriesAccepted).toBe(0);
  });

  it("an adapter that THROWS is contained and recorded as unknown / transport-fault", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    h.transport.program("throw");
    const e = await h.seedEvent();
    await expect(h.tick()).resolves.toBeUndefined();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.lastOutcome).toBe("unknown");
    expect(row.attempts[0]!.reason).toBe("transport-fault");
    expect(h.snapshot().transportFaults).toBe(1);
    expect(h.snapshot().deliveriesUnknown).toBe(1);
    expect(warnLines("ops transport threw")).toHaveLength(1);
  });

  it("an accepted nudge on an already-delivered row refreshes the reference without re-transitioning", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    h.transport.program(
      { status: "accepted", reference: { kind: "fake", id: "first" }, at: BASE },
      { status: "accepted", reference: { kind: "fake", id: "second" }, at: BASE },
    );
    const e = await h.seedEvent();
    await h.tick();
    const first = await h.row("s1", e.dedupeKey);
    expect(first.deliveryReference).toEqual({ kind: "fake", id: "first" });

    h.advance(CADENCE);
    await h.tick();
    const second = await h.row("s1", e.dedupeKey);
    expect(second.state).toBe("delivered");
    expect(second.deliveryReference).toEqual({ kind: "fake", id: "second" });
    expect(second.stateAt).toEqual(first.stateAt);
    expect(second.principalAt).toEqual(first.principalAt);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Attempt/nudge accounting and the attempts[] ring.
// ───────────────────────────────────────────────────────────────────────────

describe("attempt accounting", () => {
  it("counts the first attempt but not as a nudge, and caps attempts[] at the ring", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    const e = await h.seedEvent();

    await h.tick();
    const afterFirst = await h.row("s1", e.dedupeKey);
    expect(afterFirst.attemptCount).toBe(1);
    expect(afterFirst.nudgeCount).toBe(0);

    for (let i = 0; i < 9; i += 1) {
      h.advance(CADENCE);
      await h.tick();
    }

    const row = await h.row("s1", e.dedupeKey);
    expect(row.attemptCount).toBe(10);
    expect(row.nudgeCount).toBe(9);
    expect(row.attempts).toHaveLength(ATTEMPTS_RING_CAP);
    expect(h.transport.views).toHaveLength(10);
    // The ledger did not grow a row per attempt.
    expect(await h.ledgerCount()).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The stall.
// ───────────────────────────────────────────────────────────────────────────

describe("the stall — a declined row is PUSHED FORWARD, never left untouched", () => {
  const inRecheckWindow = (nextNudgeAt: Date | undefined, now: Date) => {
    expect(nextNudgeAt).toBeInstanceOf(Date);
    const delta = nextNudgeAt!.getTime() - now.getTime();
    expect(delta).toBeGreaterThan(STALL_RECHECK_MS * (1 - STALL_JITTER_FRACTION));
    expect(delta).toBeLessThan(STALL_RECHECK_MS * (1 + STALL_JITTER_FRACTION));
  };

  it("an unresolvable subscription stalls with its own reason and counter", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    const e = await h.seedEvent();
    await h.tick();

    // D11 lever 1 — the operator disables the subscription.
    await h.db.collection(OPS_SUBSCRIPTIONS_COLLECTION).updateOne({ _id: "s1" }, { $set: { enabled: false } });
    await h.notifier.reloadSubscriptions();
    h.advance(CADENCE);
    const now = h.now();
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.stalledReason).toBe("subscription");
    expect(row.stalledAt).toEqual(now);
    inRecheckWindow(row.nextNudgeAt, now);
    expect(h.snapshot().subscriptionUnresolved).toBe(1);
    // Declined, not attempted.
    expect(h.transport.views).toHaveLength(1);
  });

  it("an unbound adapter stalls with its own reason and counter", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith(), transport: null });
    const e = await h.seedEvent();
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.stalledReason).toBe("transport");
    inRecheckWindow(row.nextNudgeAt, BASE);
    expect(h.snapshot().transportUnbound).toBe(1);
    expect(row.attemptCount).toBe(0);
  });

  it("an unresolvable cadence stalls once the row is past its guaranteed first delivery", async () => {
    // No policy at all — the shipped default.
    const h = await harness({ subscriptions: [sub("s1")] });
    const e = await h.seedEvent();
    await h.tick();
    // The first attempt is guaranteed by `attemptCount === 0`, so it happened.
    expect(h.transport.views).toHaveLength(1);
    expect(h.snapshot().cadenceUnresolved).toBe(0);

    h.advance(STALL_RECHECK_MS * 2);
    const now = h.now();
    await h.tick();

    const row = await h.row("s1", e.dedupeKey);
    expect(row.stalledReason).toBe("cadence");
    expect(row.stalledAt).toEqual(now);
    inRecheckWindow(row.nextNudgeAt, now);
    expect(h.snapshot().cadenceUnresolved).toBe(1);
    // Still exactly one delivery — the second tick declined.
    expect(h.transport.views).toHaveLength(1);
  });

  it("nextNudgeAt is never unset by a stall — the row stays visible to the due-scan", async () => {
    const h = await harness({ subscriptions: [sub("s1")], transport: null });
    const e = await h.seedEvent();
    await h.tick();
    const row = await h.row("s1", e.dedupeKey);
    expect(Object.keys(row)).toContain("nextNudgeAt");
    expect(row.nextNudgeAt).toBeInstanceOf(Date);
  });

  it("the stall write does not land on a row that left the working states mid-scan", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    const e = await h.seedEvent();
    await h.tick();
    const created = await h.row("s1", e.dedupeKey);

    await h.db.collection(OPS_SUBSCRIPTIONS_COLLECTION).updateOne({ _id: "s1" }, { $set: { enabled: false } });
    await h.notifier.reloadSubscriptions();
    h.advance(CADENCE);

    // Arm 3's find — the only delivery arm whose filter names neither
    // `attemptCount` nor `forceDeliver`. `after: true` hands the phase a
    // snapshot taken BEFORE the mutation below, which is exactly the race the
    // stall's `state ∈ {pending, delivered}` precondition exists for.
    const gate = h.db.pause(
      OPS_NOTIFICATIONS_COLLECTION,
      "find",
      (ctx) =>
        ctx.filter?.attemptCount === undefined &&
        ctx.filter?.forceDeliver === undefined &&
        ctx.filter?.nextNudgeAt !== undefined,
      true,
    );
    const tick = h.tick();
    await gate.reached;
    await h.store.notifications.updateOne(
      { _id: created._id },
      { $set: { state: "cleared" }, $unset: { nextNudgeAt: "" } },
    );
    gate.release();
    await tick;

    const row = await h.row("s1", e.dedupeKey);
    expect(row.state).toBe("cleared");
    expect(row.nextNudgeAt).toBeUndefined();
    expect(row.stalledReason).toBeUndefined();
    // The decline was still observed and counted — only the write missed.
    expect(h.snapshot().subscriptionUnresolved).toBe(1);
  });

  it("the no-interval attempt branch sets the cadence stall in the SAME update that unsets forceDeliver", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const e = await h.seedEvent();
    await h.tick();

    const writes = recordWrites(h);
    expect(writes).toHaveLength(1);
    const update = writes[0]!.context.update!;
    expect(update.$set).toMatchObject({ stalledReason: "cadence", stalledAt: BASE });
    // `expiresAt` rides along because this is also a `pending → delivered`
    // transition and D9's state-invariant pattern unsets it on every working
    // state — it is the `else` half of that pattern, not a second rule.
    expect(update.$unset).toEqual({ forceDeliver: "", expiresAt: "" });
    // ⚠ The whole point: stalledAt/stalledReason appear in $set and NOT in
    // $unset. A build that emitted both is rejected by MongoDB — and by the
    // double (see NV6).
    expect(Object.keys(update.$unset as Record<string, unknown>)).not.toContain("stalledAt");
    expect(Object.keys(update.$unset as Record<string, unknown>)).not.toContain("stalledReason");

    const row = await h.row("s1", e.dedupeKey);
    expect(row.stalledReason).toBe("cadence");
    expect(row.lastOutcome).toBe("accepted");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Snooze expiry.
// ───────────────────────────────────────────────────────────────────────────

describe("snooze expiry", () => {
  /** Puts the one ledger row into `snoozed` the way intake (chunk 4) will. */
  const snooze = async (h: NotifierHarness, id: ObjectId, until: Date) => {
    await h.store.notifications.updateOne(
      { _id: id },
      {
        $set: { state: "snoozed", stateAt: h.now(), snoozedUntil: until, expiresAt: t(10_000) },
        $unset: { nextNudgeAt: "" },
      },
    );
  };

  it("a row with an accepted delivery returns to `delivered`", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    const e = await h.seedEvent();
    await h.tick();
    const row = await h.row("s1", e.dedupeKey);
    expect(row.deliveryReference).toBeDefined();

    await snooze(h, row._id!, t(5));
    h.advance(10 * 60_000);
    await h.tick();

    const after = await h.row("s1", e.dedupeKey);
    expect(after.state).toBe("delivered");
    expect(after.snoozedUntil).toBeUndefined();
    expect(after.expiresAt).toBeUndefined();
  });

  it("a row that never took an accepted delivery returns to `pending`", async () => {
    // transport: null ⇒ the row stalls and never gains a deliveryReference.
    const h = await harness({ subscriptions: [sub("s1")], transport: null });
    const e = await h.seedEvent();
    await h.tick();
    const row = await h.row("s1", e.dedupeKey);
    expect(row.deliveryReference).toBeUndefined();

    await snooze(h, row._id!, t(5));
    h.advance(10 * 60_000);
    const now = h.now();
    await h.tick();

    const after = await h.row("s1", e.dedupeKey);
    expect(after.state).toBe("pending");
    expect(after.snoozedUntil).toBeUndefined();
    expect(after.expiresAt).toBeUndefined();

    // The expiry write itself: forceDeliver set, nextNudgeAt = now, both
    // markers unset. Read off the operation rather than the row, because the
    // delivery phase legitimately rewrites nextNudgeAt later in the same tick.
    const writes = expiryWrites(h);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.context.update!.$set).toMatchObject({
      state: "pending",
      forceDeliver: true,
      nextNudgeAt: now,
      principal: OPS_SYSTEM_PRINCIPAL,
    });
    expect(writes[0]!.context.update!.$unset).toEqual({ snoozedUntil: "", expiresAt: "" });
  });

  it("runs BEFORE delivery, so an expiring row is re-delivered on the SAME tick", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    const e = await h.seedEvent();
    await h.tick();
    const row = await h.row("s1", e.dedupeKey);
    expect(h.transport.views).toHaveLength(1);

    await snooze(h, row._id!, t(5));
    h.advance(10 * 60_000);
    await h.tick();

    // Arm 2 (forceDeliver) picked it up on this very tick.
    expect(h.transport.views).toHaveLength(2);
    const after = await h.row("s1", e.dedupeKey);
    expect(after.attemptCount).toBe(2);
    // The attempt CONSUMED the forced re-delivery.
    expect(after.forceDeliver).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The one CAS whose miss is counted.
// ───────────────────────────────────────────────────────────────────────────

describe("record()'s CAS — the one write that follows an irreversible side effect", () => {
  it("a lost race is counted and logged, and nothing is half-written", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    const e = await h.seedEvent();
    const KEY = e.dedupeKey;

    h.transport.onDeliver = async () => {
      // Moves the row out from under record()'s (state, attemptCount) CAS at
      // the exact instant the external side effect has happened.
      await h.store.notifications.updateOne({ dedupeKey: KEY }, { $inc: { attemptCount: 1 } });
      h.transport.onDeliver = undefined; // once, or the next attempt loses too
    };

    await expect(h.tick()).resolves.toBeUndefined();

    expect(h.snapshot().deliveryRecordLost).toBe(1);
    expect(warnLines("ops delivery record lost a CAS")).toHaveLength(1);

    const row = await h.row("s1", KEY);
    expect(row.attempts).toEqual([]);
    expect(row.lastOutcome).toBeUndefined();
    expect(row.deliveryReference).toBeUndefined();
    expect(row.state).toBe("pending");
    // The concurrent writer's own increment stands; nothing was blended.
    expect(row.attemptCount).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The heartbeat.
// ───────────────────────────────────────────────────────────────────────────

describe("the heartbeat", () => {
  it("carries every gauge and every counter", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    await h.seedEvent();
    await h.tick();

    const hb = await h.heartbeat();
    for (const gauge of [
      "timestamp",
      "lastSuccessfulSweep",
      "cursorAt",
      "eventsBehind",
      "oldestUnappliedAt",
      "rowsPending",
      "rowsNudgeDue",
      "rowsSnoozed",
      "rowsUnknownOutcome",
      "rowsSubscriptionUnresolved",
      "rowsTransportUnbound",
      "rowsCadenceUnresolved",
      "state",
    ]) {
      expect(Object.keys(hb), `heartbeat is missing ${gauge}`).toContain(gauge);
    }
    for (const counter of Object.keys(freshCounters())) {
      expect(Object.keys(hb), `heartbeat is missing counter ${counter}`).toContain(counter);
    }
    expect(hb.state).toBe("ok");
    expect(hb.rowsPending).toBe(0);
    expect(hb.eventsApplied).toBe(1);
    expect(hb.rowsCreated).toBe(1);
  });

  it("reports `backlog` when the ingest budget leaves events behind", async () => {
    // No subscriptions: 1001 events apply cheaply and create no ledger rows.
    // INGEST_EVENT_BUDGET is 1000, so exactly one is left behind.
    const h = await harness();
    await h.seedEvents(1_001);
    await h.tick();

    const hb = await h.heartbeat();
    expect(hb.state).toBe("backlog");
    expect(hb.eventsBehind).toBe(1);
    expect(hb.oldestUnappliedAt).toEqual(t(1_000));
  });

  it("reports `degraded` when a phase read throws, and still writes a heartbeat", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    await h.seedEvent();
    // The ingest page `find` — outside every per-event try by design.
    failOn(h.db, OPS_EVENTS_COLLECTION, "find", () => true);

    await expect(h.tick()).resolves.toBeUndefined();
    expect((await h.heartbeat()).state).toBe("degraded");
    expect(h.snapshot().sweepFaults).toBe(1);
  });

  it("reports `degraded` when a GAUGE count throws — the read outside every inner try", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    await h.seedEvent();
    failOn(h.db, OPS_NOTIFICATIONS_COLLECTION, "countDocuments", () => true);

    await expect(h.tick()).resolves.toBeUndefined();
    expect((await h.heartbeat()).state).toBe("degraded");
    expect(h.snapshot().sweepFaults).toBe(1);
    // The delivery still happened — only the reporting failed.
    expect(h.snapshot().deliveriesAccepted).toBe(1);
  });

  it("a failing heartbeat write leaves the tick resolved and nothing half-written", async () => {
    const h = await harness({ subscriptions: [sub("s1")], policy: policyWith() });
    await h.seedEvent();
    // BOTH the ok-path write and the degraded fallback.
    h.db.failAll("telemetry", "updateOne", new Error("injected"), heartbeatWrite as never);

    await expect(h.tick()).resolves.toBeUndefined();
    await expect(h.heartbeat()).rejects.toBeTruthy();
    expect(h.snapshot().sweepFaults).toBe(1);
    expect(warnLines("ops heartbeat write failed")).toHaveLength(1);
  });

  it("the four saturating gauges saturate at GAUGE_COUNT_LIMIT", async () => {
    const h = await harness();
    let n = 0;
    for (const stalledReason of ["subscription", "transport", "cadence"] as const) {
      for (let i = 0; i <= GAUGE_COUNT_LIMIT; i += 1) {
        n += 1;
        await h.store.notifications.insertOne(
          ledgerRow({
            dedupeKey: `k-${n}`,
            state: i % 2 === 0 ? "pending" : "delivered",
            stalledReason,
            stalledAt: t(0),
            lastOutcome: "unknown",
          }),
        );
      }
    }
    await h.tick();

    const hb = await h.heartbeat();
    expect(hb.rowsUnknownOutcome).toBe(GAUGE_COUNT_LIMIT);
    expect(hb.rowsSubscriptionUnresolved).toBe(GAUGE_COUNT_LIMIT);
    expect(hb.rowsTransportUnbound).toBe(GAUGE_COUNT_LIMIT);
    expect(hb.rowsCadenceUnresolved).toBe(GAUGE_COUNT_LIMIT);
    // The three exact gauges are NOT saturated — they are the counterpart claim.
    expect(hb.rowsSnoozed).toBe(0);
    expect(hb.rowsPending).toBeGreaterThan(GAUGE_COUNT_LIMIT);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The stopped latch.
// ───────────────────────────────────────────────────────────────────────────

describe("the stopped latch", () => {
  it("seam 1 — a stop observed after ingest pays neither expiry nor delivery", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    await h.seedEvent();
    // The first telemetry updateOne of a tick is ingest's cursor write; the
    // heartbeat is the last. Pausing here puts the latch exactly between the
    // ingest phase and the expiry phase.
    const gate = h.db.pause("telemetry", "updateOne");
    const tick = h.tick();
    await gate.reached;
    const stopped = h.notifier.stop();
    const mark = h.db.operations.length;
    gate.release();
    await Promise.all([tick, stopped]);

    expect(await h.ledgerCount()).toBe(1); // the ingest phase DID run
    const after = h.db.operations.slice(mark);
    expect(after.filter((o) => o.collection === OPS_NOTIFICATIONS_COLLECTION && o.operation === "find")).toHaveLength(
      0,
    );
    await expect(h.heartbeat()).rejects.toBeTruthy(); // a stop is not a tick outcome
  });

  it("seam 2 — a stop observed after expiry pays no delivery", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    await h.seedEvent();
    // `expire()` always issues exactly this find once per tick.
    const gate = h.db.pause(OPS_NOTIFICATIONS_COLLECTION, "find", (ctx) => ctx.filter?.state === "snoozed");
    const tick = h.tick();
    await gate.reached;
    const stopped = h.notifier.stop();
    const mark = h.db.operations.length;
    gate.release();
    await Promise.all([tick, stopped]);

    const after = h.db.operations.slice(mark);
    expect(after.filter((o) => o.collection === OPS_NOTIFICATIONS_COLLECTION && o.operation === "find")).toHaveLength(
      0,
    );
    expect(h.transport.views).toHaveLength(0);
    await expect(h.heartbeat()).rejects.toBeTruthy();
  });

  it("sweepOnce's OWN guard — a tick requested after stop() reads nothing at all", async () => {
    // A DIFFERENT mechanism from the two seams above: this one never enters
    // run() at all, so it is not a phase checkpoint.
    const h = await harness({ subscriptions: [sub("s1")] });
    await h.seedEvent();
    await h.notifier.stop();
    const mark = h.db.operations.length;
    await h.tick();
    expect(h.db.operations.slice(mark)).toHaveLength(0);
    expect(await h.ledgerCount()).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Policy posture.
// ───────────────────────────────────────────────────────────────────────────

describe("the policy read — null, throw-cold and throw-warm are three different things", () => {
  it("a read returning null runs the delivery phase normally", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const e = await h.seedEvent();
    await h.tick();

    expect(h.snapshot().policyReadFaults).toBe(0);
    expect(h.snapshot().deliveriesAccepted).toBe(1);
    expect((await h.row("s1", e.dedupeKey)).stalledReason).toBe("cadence");
    expect((await h.heartbeat()).state).toBe("ok");
  });

  it("a read that throws on a process's FIRST tick skips delivery entirely and marks nothing", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const e = await h.seedEvent();
    failOn(h.db, OPS_POLICY_COLLECTION, "findOne", () => true);

    await expect(h.tick()).resolves.toBeUndefined();

    expect(h.snapshot().policyReadFaults).toBe(1);
    expect(h.transport.views).toHaveLength(0);
    const row = await h.row("s1", e.dedupeKey);
    expect(row.attemptCount).toBe(0);
    expect(row.stalledReason).toBeUndefined();
    expect(row.stalledAt).toBeUndefined();
    // Untouched: still exactly what ingest wrote.
    expect(row.nextNudgeAt).toEqual(BASE);
    expect((await h.heartbeat()).state).toBe("degraded");
  });

  it("a read that throws with a RETAINED copy delivers on the retained cadence", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    const e = await h.seedEvent();
    // The retained result a prior successful tick would have left behind.
    h.notifier.__setPolicyForTests(policyWith());
    failOn(h.db, OPS_POLICY_COLLECTION, "findOne", () => true);

    await h.tick();

    expect(h.snapshot().policyReadFaults).toBe(1);
    expect(h.snapshot().deliveriesAccepted).toBe(1);
    const row = await h.row("s1", e.dedupeKey);
    expect(row.nextNudgeAt).toEqual(new Date(BASE.getTime() + CADENCE));
    expect(row.stalledReason).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Lifecycle.
// ───────────────────────────────────────────────────────────────────────────

describe("init / start / stop", () => {
  /**
   * ⚠ THE ONE PLACE THIS FILE BUILDS A NOTIFIER BY HAND. `harness()` calls
   * `init()` internally, so a case that must WATCH `init()` fail cannot use it.
   * Everything else about the construction matches the harness exactly.
   */
  const rawNotifier = (arm: (db: FakeDb) => void) => {
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

  it("a UNIQUE-index failure throws out of init() and leaves the notifier uninitialized", async () => {
    // The (subscriptionId, dedupeKey) unique index is the FIRST createIndex
    // ops_notifications receives.
    const { notifier } = rawNotifier((db) => failNth(db, OPS_NOTIFICATIONS_COLLECTION, "createIndex", 1));
    await expect(notifier.init()).rejects.toThrow(/identity index unavailable/);
    expect(notifier.getSnapshot().initialized).toBe(false);
    expect(notifier.getSnapshot().indexFailures).toBe(1);
  });

  it("any OTHER index failure is contained, counted, and leaves the notifier usable", async () => {
    const { notifier } = rawNotifier((db) => failNth(db, OPS_NOTIFICATIONS_COLLECTION, "createIndex", 2));
    await expect(notifier.init()).resolves.toBeUndefined();
    expect(notifier.getSnapshot().initialized).toBe(true);
    expect(notifier.getSnapshot().startable).toBe(true);
    expect(notifier.getSnapshot().indexFailures).toBe(1);
  });

  it("a reason-map failure leaves the notifier INITIALIZED (intake live) but UNSTARTABLE", async () => {
    const { notifier } = rawNotifier((db) => db.failAll("ops_reasons", "find"));
    await expect(notifier.init()).resolves.toBeUndefined();
    expect(notifier.getSnapshot().initialized).toBe(true);
    expect(notifier.getSnapshot().startable).toBe(false);
    await notifier.start();
    expect(notifier.getSnapshot().started).toBe(false);
    expect(mockLog.error.mock.calls.some((c) => String(c[0]).includes("ops reason map load failed"))).toBe(true);
  });

  it("init() performs no ops_subscriptions read — the load moves to start()", async () => {
    const { db, notifier } = rawNotifier(() => {});
    await notifier.init();
    expect(db.operations.filter((o) => o.collection === OPS_SUBSCRIPTIONS_COLLECTION)).toHaveLength(0);

    notifier.registerTransport(new FakeTransport());
    await notifier.start();
    try {
      expect(
        db.operations.filter((o) => o.collection === OPS_SUBSCRIPTIONS_COLLECTION && o.operation === "find").length,
      ).toBeGreaterThan(0);
      expect(notifier.getSnapshot().started).toBe(true);
    } finally {
      await notifier.stop(); // start() armed two real intervals
    }
  });

  it("a first-subscription-load failure leaves the notifier unstarted without throwing", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    failOn(h.db, OPS_SUBSCRIPTIONS_COLLECTION, "find", () => true);
    await expect(h.notifier.start()).resolves.toBeUndefined();
    expect(h.notifier.getSnapshot().started).toBe(false);
    expect(h.notifier.getSnapshot().subscriptionReloadFaults).toBe(1);
    // The previous set was RETAINED, never emptied.
    expect(h.notifier.getSnapshot().subscriptions).toBe(1);
  });

  it("stop() clears the timers and awaits the in-flight tick", async () => {
    const h = await harness({ subscriptions: [sub("s1")], start: true });
    const gate = h.db.pause("telemetry", "updateOne", heartbeatWrite as never);
    const tick = h.tick();
    await gate.reached;

    let settled = false;
    const stopped = h.notifier.stop().then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.release();
    await Promise.all([tick, stopped]);
    expect(settled).toBe(true);
    expect(h.notifier.getSnapshot().started).toBe(false);
    expect(h.notifier.getSnapshot().stopping).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Subscription loading and validateTarget.
// ───────────────────────────────────────────────────────────────────────────

describe("validateTarget at subscription-load time", () => {
  it("a rejected target is unloaded in memory, counted, warned once, and never mutated in the database", async () => {
    const rejecting = new FakeTransport(
      "fake",
      () => BASE,
      () => false,
    );
    // A subscription id unique to this case: the warn-once memo is process-global.
    const h = await harness({ subscriptions: [sub("s-rejected-target")], transport: rejecting });

    expect(h.snapshot().subscriptions).toBe(0);
    expect(h.snapshot().subscriptionUnloaded).toBe(1);
    expect(warnLines("ops subscription target rejected by its adapter")).toHaveLength(1);

    await h.notifier.reloadSubscriptions();
    expect(h.snapshot().subscriptionUnloaded).toBe(2);
    // Counted every load; logged once per process.
    expect(warnLines("ops subscription target rejected by its adapter")).toHaveLength(1);

    const stored = (await h.db.collection(OPS_SUBSCRIPTIONS_COLLECTION).findOne({ _id: "s-rejected-target" }))!;
    expect(stored.enabled).toBe(true);
    expect(stored.transport).toEqual({ adapterId: "fake", target: "C0000001" });
  });

  it("a subscription whose adapterId names no registered adapter loads normally, unvalidated", async () => {
    const h = await harness({ subscriptions: [sub("s1", { transport: { adapterId: "nobody", target: "X" } })] });
    expect(h.snapshot().subscriptions).toBe(1);
    expect(h.snapshot().subscriptionUnloaded).toBe(0);

    // Its rows are created and left to delivery-time transportUnbound.
    const e = await h.seedEvent();
    await h.tick();
    expect((await h.row("s1", e.dedupeKey)).stalledReason).toBe("transport");
    expect(h.snapshot().transportUnbound).toBe(1);
  });

  it("an adapter whose validateTarget THROWS is treated as false, and the rest still load", async () => {
    const throwing = new FakeTransport(
      "fake",
      () => BASE,
      () => {
        throw new Error("cannot decide");
      },
    );
    const h = await harness({
      subscriptions: [
        sub("s-throwing-validate"),
        sub("s-unjudged", { transport: { adapterId: "nobody", target: "X" } }),
      ],
      transport: throwing,
    });

    expect(h.snapshot().subscriptionUnloaded).toBe(1);
    expect(h.snapshot().subscriptions).toBe(1);
    const e = await h.seedEvent();
    await h.tick();
    // Only the unjudged subscription minted a row.
    expect(await h.ledgerCount()).toBe(1);
    expect((await h.row("s-unjudged", e.dedupeKey)).subscriptionId).toBe("s-unjudged");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The single-flight sweep and the per-row latch.
// ───────────────────────────────────────────────────────────────────────────

describe("the sweep never overlaps itself", () => {
  it("a second tick started while the first is in flight joins it", async () => {
    const h = await harness({ subscriptions: [sub("s1")] });
    await h.seedEvent();
    const first = h.tick();
    const second = h.tick();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(
      h.db.operations.filter((o) => o.collection === OPS_EVENTS_COLLECTION && o.operation === "find"),
    ).toHaveLength(1);
    expect(h.db.operations.filter((o) => o.collection === OPS_POLICY_COLLECTION)).toHaveLength(1);
  });
});

describe("the per-row latch", () => {
  const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  it("two calls on ONE id run in series", async () => {
    const h = await harness();
    const order: string[] = [];
    const gate = deferred();
    const a = h.notifier.withRowLock("row-a", async () => {
      order.push("a-start");
      await gate.promise;
      order.push("a-end");
    });
    const b = h.notifier.withRowLock("row-a", async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a-start"]);
    gate.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("calls on DIFFERENT ids interleave, and the map is empty once both settle", async () => {
    const h = await harness();
    const order: string[] = [];
    const gate = deferred();
    const a = h.notifier.withRowLock("row-a", async () => {
      order.push("a-start");
      await gate.promise;
      order.push("a-end");
    });
    const b = h.notifier.withRowLock("row-b", async () => {
      order.push("b");
    });
    await b;
    expect(order).toEqual(["a-start", "b"]);
    gate.release();
    await a;

    // White-box, deliberately: the latch's only stated bound is "entries are
    // deleted on settle", and a leak has no black-box symptom short of memory.
    const locks = (h.notifier as unknown as { locks: Map<string, unknown> }).locks;
    await Promise.resolve();
    await Promise.resolve();
    expect(locks.size).toBe(0);
  });

  it("a rejecting holder still releases the latch", async () => {
    const h = await harness();
    const failed = h.notifier.withRowLock("row-a", async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(h.notifier.withRowLock("row-a", async () => "ok")).resolves.toBe("ok");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A structural pin on the phase the rest of this file drives indirectly.
// ───────────────────────────────────────────────────────────────────────────

describe("DeliveryPhase is constructible on its own", () => {
  it("takes exactly the collection, the counters and the retention", async () => {
    const db = new FakeDb();
    const store = new OpsNotificationStore(db.db);
    const counters = freshCounters();
    const phase = new DeliveryPhase(store.notifications, counters, 30);
    const ctx = {
      subscriptions: new Map<string, OpsSubscription>(),
      transports: new Map(),
      reasons: new Map(),
      policy: null,
      lock: <T>(_id: string, fn: () => Promise<T>) => fn(),
      stopped: () => false,
      clock: () => BASE,
      sleep: async () => {},
    };
    await expect(phase.expire(BASE, ctx)).resolves.toBe(true);
    await expect(phase.run(BASE, ctx)).resolves.toEqual({ ok: true, attempted: 0, deferred: false });
    expect(new ObjectId().toHexString()).toHaveLength(24);
  });
});
