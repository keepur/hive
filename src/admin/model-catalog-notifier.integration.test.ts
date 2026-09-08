/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => testLog }));

import { JOURNALED } from "./model-catalog-export.js";
import { MAX_NOTICE_DATE_MS, makePreparation, sameBinding, type NoticeRoute } from "./model-catalog-notification.js";
import { ModelCatalogNotifier } from "./model-catalog-notifier.js";
import { copy, ModelCatalogOutbox, transition } from "./model-catalog-outbox.js";
import type { CatalogChangeDoc } from "./model-catalog-types.js";
import { deferred, faultDb } from "./testing/catalog-db.test-support.js";
import { startStandaloneMongo } from "./testing/standalone-mongo.js";

const CHANGES = "agent_model_catalog_changes";
const ROUTE: NoticeRoute = {
  agentId: "chief-of-staff",
  agentName: "Chief of Staff",
  homeBase: "operations",
  adapterId: "slack",
  channelId: "CNOTICES",
};

let mongo: Awaited<ReturnType<typeof startStandaloneMongo>>;

function uuidSequence(prefix: string) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function change(number: number, now = new Date()): CatalogChangeDoc {
  return {
    _id: `notifier-${String(number).padStart(3, "0")}`,
    provider: "codex",
    revision: number,
    snapshotId: `snapshot-${number}`,
    createdAt: new Date(now.getTime() - 120_000 + number),
    source: "manual",
    updatedBy: "integration-operator",
    modelCount: 2,
    bootstrap: number === 1,
    added: [`model-${number}`],
    removed: ["old-model"],
    delivery: { state: "pending", attempts: 0, nextAttemptAt: new Date(now.getTime() - 60_000) },
  };
}

function dispatcherFixture(initialRoute: NoticeRoute = ROUTE) {
  let currentRoute = copy(initialRoute);
  const api = {
    resolveCatalogNotificationRoute: vi.fn(async (gate: { check(): Promise<boolean>; current(): boolean }) =>
      (await gate.check()) && gate.current()
        ? { kind: "route" as const, route: copy(currentRoute) }
        : { kind: "unresolved" as const, reason: "recipient-changed" as const },
    ),
    catalogNotificationRouteCurrent: vi.fn((candidate: NoticeRoute) => sameBinding(candidate, currentRoute)),
    prepareCatalogNotification: vi.fn(async (row: CatalogChangeDoc, route: NoticeRoute, mayStart: () => boolean) =>
      mayStart()
        ? {
            kind: "prepared" as const,
            preparation: makePreparation(row, route, `Processed ${row._id}.`, new Date()),
          }
        : { kind: "unresolved" as const, reason: "recipient-changed" as const },
    ),
    sendPreparedCatalogNotification: vi.fn(
      async (preparation: ReturnType<typeof makePreparation>, mayStart: () => boolean) =>
        mayStart()
          ? {
              kind: "acknowledged" as const,
              channelId: preparation.binding.channelId,
              messageTs: `${Math.floor(Date.now() / 1_000)}.000001`,
            }
          : { kind: "not-accepted" as const, reason: "recipient-changed" as const },
    ),
    setRoute(route: NoticeRoute) {
      currentRoute = copy(route);
    },
  };
  return api;
}

async function resetDatabase(): Promise<void> {
  expect(mongo.db.databaseName).toMatch(/^hive_kpr459_test_/);
  await mongo.db.dropDatabase();
  testLog.info.mockReset();
  testLog.warn.mockReset();
}

async function seed(row: CatalogChangeDoc): Promise<void> {
  await mongo.db.collection<CatalogChangeDoc>(CHANGES).insertOne(copy(row), JOURNALED);
}

async function stored(id: string): Promise<CatalogChangeDoc> {
  const row = await mongo.db.collection<CatalogChangeDoc>(CHANGES).findOne({ _id: id });
  if (!row) throw new Error("missing notifier integration fixture");
  return row;
}

async function serverNow(): Promise<Date> {
  return (await mongo.db.admin().command({ hello: 1 })).localTime as Date;
}

async function waitForServerAfter(deadline: Date): Promise<Date> {
  const limit = Date.now() + 2_000;
  for (;;) {
    const current = await serverNow();
    if (current > deadline) return current;
    if (Date.now() >= limit) throw new Error("standalone Mongo clock did not pass lease deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function immutable(row: CatalogChangeDoc): Omit<CatalogChangeDoc, "delivery"> {
  const value = copy(row) as Partial<CatalogChangeDoc>;
  delete value.delivery;
  return value as Omit<CatalogChangeDoc, "delivery">;
}

async function makeDue(id: string): Promise<CatalogChangeDoc> {
  const before = await stored(id);
  const delivery = {
    ...copy(before.delivery),
    nextAttemptAt: new Date(Date.now() - 1_000),
    version: (before.delivery.version ?? 0) + 1,
  };
  // Fixture-only exact-version advancement; production still uses fenced outbox transitions.
  const result = await mongo.db.collection<CatalogChangeDoc>(CHANGES).updateOne(
    {
      _id: id,
      "delivery.state": "pending",
      "delivery.version": before.delivery.version,
    },
    { $set: { delivery } },
    { ...JOURNALED, upsert: false },
  );
  expect(result.acknowledged).toBe(true);
  expect(result.matchedCount).toBe(1);
  return stored(id);
}

beforeAll(async () => {
  mongo = await startStandaloneMongo();
}, 30_000);

afterAll(async () => {
  await mongo?.close();
}, 30_000);

beforeEach(resetDatabase, 30_000);

describe("ModelCatalogNotifier with owned standalone Mongo", () => {
  it("reuses a durable preparation after restart and records the accepted receipt", async () => {
    const row = change(1);
    await seed(row);
    const firstDispatch = dispatcherFixture();
    firstDispatch.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
    });
    const first = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), firstDispatch as any, {
      uuid: uuidSequence("first"),
    });
    await first.tick();
    await first.stop();

    const pending = await stored(row._id);
    expect(pending.delivery).toMatchObject({
      state: "pending",
      attempts: 1,
      version: 4,
      diagnostic: { reason: "delivery-unconfirmed" },
      uncertainSend: false,
    });
    const preparation = copy(pending.delivery.preparation!);
    await makeDue(row._id);

    const restartedDispatch = dispatcherFixture();
    const restarted = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), restartedDispatch as any, {
      uuid: uuidSequence("restarted"),
    });
    await restarted.tick();

    const delivered = await stored(row._id);
    expect(restartedDispatch.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(restartedDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(restartedDispatch.sendPreparedCatalogNotification.mock.calls[0]?.[0]).toEqual(preparation);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      attempts: 2,
      version: 8,
      preparation,
      receipt: {
        preparationId: preparation.id,
        binding: preparation.binding,
        channelId: preparation.binding.channelId,
      },
    });
    await restarted.tick();
    expect(restartedDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await restarted.stop();
  });

  it.each([
    ["default agent", { ...ROUTE, agentId: "chief-next", agentName: "Chief Next" }],
    ["home base", { ...ROUTE, homeBase: "executive" }],
    ["adapter", { ...ROUTE, adapterId: "slack-secondary" }],
    ["channel", { ...ROUTE, channelId: "CSECONDARY" }],
    ["bot label", { ...ROUTE, botLabel: "secondary" }],
  ] as const)("reprepares against Mongo after the %s binding changes", async (_label, nextRoute) => {
    const row = change(40);
    await seed(row);
    const firstDispatch = dispatcherFixture();
    firstDispatch.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "outcome-unknown",
      reason: "delivery-unconfirmed",
    });
    const first = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), firstDispatch as any, {
      uuid: uuidSequence("binding-first"),
    });
    await first.tick();
    await first.stop();

    const unresolved = await stored(row._id);
    const firstPreparation = copy(unresolved.delivery.preparation!);
    expect(unresolved.delivery).toMatchObject({ state: "pending", uncertainSend: true });
    await makeDue(row._id);

    const changedDispatch = dispatcherFixture(nextRoute);
    const changed = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), changedDispatch as any, {
      uuid: uuidSequence("binding-changed"),
    });
    await changed.tick();

    const delivered = await stored(row._id);
    expect(firstDispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(firstDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(changedDispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(changedDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(delivered.delivery.preparation?.id).not.toBe(firstPreparation.id);
    expect(delivered.delivery.preparation?.binding).toEqual({
      agentId: nextRoute.agentId,
      homeBase: nextRoute.homeBase,
      adapterId: nextRoute.adapterId,
      channelId: nextRoute.channelId,
      ...(nextRoute.botLabel === undefined ? {} : { botLabel: nextRoute.botLabel }),
    });
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      uncertainSend: true,
      receipt: {
        preparationId: delivered.delivery.preparation?.id,
        binding: delivered.delivery.preparation?.binding,
        channelId: nextRoute.channelId,
      },
    });
    expect(immutable(delivered)).toEqual(immutable(row));
    changedDispatch.setRoute({ ...nextRoute, channelId: "CIGNORED" });
    await changed.tick();
    expect(changedDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await changed.stop();
  });

  it.each(["resolution", "preparation", "send-intent"] as const)(
    "does not post after a real-Mongo %s route drift",
    async (stage) => {
      const row = change(41);
      await seed(row);
      const nextRoute: NoticeRoute = { ...ROUTE, channelId: "CCHANGED" };
      const dispatch = dispatcherFixture();
      let mutationRan = 0;
      const db = faultDb(mongo.db, async (collection, method, args, run) => {
        const next = args[1]?.$set?.delivery;
        const target =
          collection === CHANGES &&
          method === "updateOne" &&
          ((stage === "preparation" && next?.preparation && next?.claim?.stage === "preparing") ||
            (stage === "send-intent" && next?.claim?.stage === "sending"));
        const result = await run();
        if (target && result.matchedCount === 1) {
          mutationRan++;
          dispatch.setRoute(nextRoute);
        }
        return result;
      });
      if (stage === "resolution") {
        dispatch.resolveCatalogNotificationRoute.mockImplementationOnce(async (gate) => {
          expect(await gate.check()).toBe(true);
          dispatch.setRoute(nextRoute);
          return { kind: "route", route: copy(ROUTE) };
        });
      }
      const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(db), dispatch as any, {
        uuid: uuidSequence(`drift-${stage}`),
      });

      await notifier.tick();

      const pending = await stored(row._id);
      expect(mutationRan).toBe(stage === "resolution" ? 0 : 1);
      expect(pending.delivery).toMatchObject({
        state: "pending",
        attempts: 1,
        uncertainSend: false,
        diagnostic: { reason: "recipient-changed" },
      });
      expect(dispatch.prepareCatalogNotification).toHaveBeenCalledTimes(stage === "resolution" ? 0 : 1);
      expect(dispatch.sendPreparedCatalogNotification).not.toHaveBeenCalled();
      expect(immutable(pending)).toEqual(immutable(row));
      await notifier.stop();
    },
  );

  it("records the posted binding when the default changes before the receipt", async () => {
    const row = change(42);
    await seed(row);
    const receipt = deferred<{ kind: "acknowledged"; channelId: string; messageTs: string }>();
    const dispatch = dispatcherFixture();
    dispatch.sendPreparedCatalogNotification.mockImplementationOnce(async () => receipt.promise);
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatch as any, {
      uuid: uuidSequence("receipt-binding"),
    });
    const flight = notifier.tick();
    await vi.waitFor(() => expect(dispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1));
    const posted = copy(dispatch.sendPreparedCatalogNotification.mock.calls[0]![0]);

    dispatch.setRoute({ ...ROUTE, agentId: "chief-next", agentName: "Chief Next", channelId: "CCHANGED" });
    receipt.resolve({ kind: "acknowledged", channelId: ROUTE.channelId, messageTs: "1770000000.777777" });
    await flight;

    const delivered = await stored(row._id);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      preparation: posted,
      receipt: {
        preparationId: posted.id,
        binding: posted.binding,
        channelId: ROUTE.channelId,
        messageTs: "1770000000.777777",
      },
    });
    expect(dispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await notifier.stop();
  });

  it("allows only one of two consumers that observed the same due version to perform external work", async () => {
    const row = change(2);
    await seed(row);
    const bothEntered = deferred<void>();
    let entered = 0;
    const wrap = () =>
      faultDb(mongo.db, async (collection, method, args, run) => {
        const next = args[1]?.$set?.delivery;
        if (
          collection === CHANGES &&
          method === "updateOne" &&
          args[0]?.["delivery.state"] === "pending" &&
          next?.state === "claimed" &&
          next?.attempts === 1
        ) {
          entered++;
          if (entered === 2) bothEntered.resolve();
          await bothEntered.promise;
        }
        return run();
      });
    const dispatchA = dispatcherFixture();
    const dispatchB = dispatcherFixture();
    const a = new ModelCatalogNotifier(new ModelCatalogOutbox(wrap()), dispatchA as any, {
      uuid: uuidSequence("consumer-a"),
    });
    const b = new ModelCatalogNotifier(new ModelCatalogOutbox(wrap()), dispatchB as any, {
      uuid: uuidSequence("consumer-b"),
    });

    await Promise.all([a.tick(), b.tick()]);

    const delivered = await stored(row._id);
    expect(entered).toBe(2);
    expect(delivered.delivery).toMatchObject({ state: "delivered", attempts: 1 });
    expect(
      dispatchA.prepareCatalogNotification.mock.calls.length + dispatchB.prepareCatalogNotification.mock.calls.length,
    ).toBe(1);
    expect(
      dispatchA.sendPreparedCatalogNotification.mock.calls.length +
        dispatchB.sendPreparedCatalogNotification.mock.calls.length,
    ).toBe(1);
    await Promise.all([a.stop(), b.stop()]);
  });

  it("starts no external work when a real claim response arrives after its lease expires", async () => {
    const row = change(60);
    await seed(row);
    const entered = deferred<void>();
    const resume = deferred<void>();
    const matched: number[] = [];
    const delayedDb = faultDb(mongo.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (collection === CHANGES && method === "updateOne" && next?.state === "claimed" && next?.version === 1) {
        const result = await run();
        matched.push(result.matchedCount);
        entered.resolve();
        await resume.promise;
        return result;
      }
      return run();
    });
    const dispatch = dispatcherFixture();
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(delayedDb), dispatch as any, {
      uuid: uuidSequence("late-claim"),
      leaseMs: 80,
      renewMs: 1_000,
    });
    const flight = notifier.tick();
    await entered.promise;
    const claimed = await stored(row._id);
    await waitForServerAfter(claimed.delivery.claim!.leaseExpiresAt);
    resume.resolve();
    await flight;

    expect(matched).toEqual([1]);
    expect(dispatch.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(dispatch.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatch.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    expect((await stored(row._id)).delivery).toEqual(claimed.delivery);

    const recoveredDispatch = dispatcherFixture();
    const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), recoveredDispatch as any, {
      uuid: uuidSequence("late-claim-recovery"),
    });
    await recovered.tick();
    expect((await stored(row._id)).delivery).toMatchObject({ state: "delivered", attempts: 2 });
    expect(recoveredDispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(recoveredDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await Promise.all([notifier.stop(), recovered.stop()]);
  });

  it("never processes an acquisition whose acknowledged outcome was lost", async () => {
    const row = change(3);
    await seed(row);
    let threw = false;
    const ambiguous = faultDb(mongo.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (!threw && collection === CHANGES && method === "updateOne" && next?.state === "claimed") {
        threw = true;
        await run();
        throw new Error("private claim response");
      }
      return run();
    });
    const firstDispatch = dispatcherFixture();
    const first = new ModelCatalogNotifier(new ModelCatalogOutbox(ambiguous), firstDispatch as any, {
      uuid: uuidSequence("ambiguous"),
      leaseMs: 150,
      pollMs: 1_000,
      drainMs: 500,
    });
    const flight = first.tick();
    await vi.waitFor(async () => expect((await stored(row._id)).delivery.state).toBe("claimed"));
    await first.stop();
    await flight;

    expect(firstDispatch.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(firstDispatch.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(firstDispatch.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 175));

    const recoveredDispatch = dispatcherFixture();
    const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), recoveredDispatch as any, {
      uuid: uuidSequence("recovered"),
    });
    await recovered.tick();
    expect((await stored(row._id)).delivery).toMatchObject({ state: "delivered", attempts: 2 });
    expect(recoveredDispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(recoveredDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
    await recovered.stop();
  });

  it.each(["prepare", "ack"] as const)(
    "uses exact persisted evidence after the %s acknowledgment is lost",
    async (kind) => {
      const row = change(kind === "prepare" ? 4 : 5);
      await seed(row);
      let threw = false;
      const ambiguous = faultDb(mongo.db, async (collection, method, args, run) => {
        const next = args[1]?.$set?.delivery;
        const target =
          kind === "prepare"
            ? next?.state === "claimed" && next?.preparation && next?.claim?.stage === "preparing"
            : next?.state === "delivered";
        if (!threw && collection === CHANGES && method === "updateOne" && target) {
          threw = true;
          await run();
          throw new Error("private mutation response");
        }
        return run();
      });
      const dispatch = dispatcherFixture();
      const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(ambiguous), dispatch as any, {
        uuid: uuidSequence(`evidence-${kind}`),
      });

      await notifier.tick();

      expect((await stored(row._id)).delivery.state).toBe("delivered");
      expect(dispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
      expect(dispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([...testLog.info.mock.calls, ...testLog.warn.mock.calls])).not.toContain("private");
      await notifier.stop();
    },
  );

  it.each([
    { label: "unexecuted predecessor with negative evidence", persisted: false },
    { label: "persisted predecessor with unavailable evidence", persisted: true },
  ])("recovers with a fresh owner after $label", async ({ persisted }) => {
    const row = change(persisted ? 62 : 61);
    await seed(row);
    let delayedRun: (() => Promise<any>) | undefined;
    let preparationFaulted = false;
    const matched: number[] = [];
    const faultedDb = faultDb(mongo.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      const target =
        collection === CHANGES &&
        method === "updateOne" &&
        next?.state === "claimed" &&
        next?.claim?.stage === "preparing" &&
        next?.preparation;
      if (collection === CHANGES && method === "findOne" && preparationFaulted && persisted) {
        throw new Error("private preparation evidence");
      }
      if (target && !preparationFaulted) {
        preparationFaulted = true;
        if (persisted) {
          const result = await run();
          matched.push(result.matchedCount);
        } else {
          delayedRun = run;
        }
        throw new Error("private preparation response");
      }
      return run();
    });
    const dispatchA = dispatcherFixture();
    const notifierA = new ModelCatalogNotifier(new ModelCatalogOutbox(faultedDb), dispatchA as any, {
      uuid: uuidSequence("prepare-a"),
      leaseMs: 90,
      renewMs: 1_000,
      pollMs: 1_000,
    });
    const flightA = notifierA.tick();
    await vi.waitFor(() => expect(preparationFaulted).toBe(true));
    expect(dispatchA.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatchA.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    const stranded = await stored(row._id);
    await waitForServerAfter(stranded.delivery.claim!.leaseExpiresAt);
    await flightA;

    const dispatchB = dispatcherFixture();
    const notifierB = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatchB as any, {
      uuid: uuidSequence("prepare-b"),
    });
    await notifierB.tick();
    const successor = await stored(row._id);
    expect(successor.delivery.state).toBe("delivered");
    expect(dispatchB.prepareCatalogNotification).toHaveBeenCalledTimes(persisted ? 0 : 1);
    expect(dispatchB.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    if (delayedRun) {
      const result = await delayedRun();
      matched.push(result.matchedCount);
    }
    expect(matched).toEqual(persisted ? [1] : [0]);
    expect(await stored(row._id)).toEqual(successor);
    expect(immutable(successor)).toEqual(immutable(row));
    expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
    await Promise.all([notifierA.stop(), notifierB.stop()]);
  });

  it.each([
    { label: "exact maximum Date", overflow: 0, blocked: false },
    { label: "one millisecond beyond maximum Date", overflow: 1, blocked: true },
  ])("persists a retry at $label and preserves it across restart", async ({ overflow, blocked }) => {
    const now = await mongo.db
      .admin()
      .command({ hello: 1 })
      .then(({ localTime }) => localTime as Date);
    const row = change(50, now);
    await seed(row);
    const dispatch = dispatcherFixture();
    dispatch.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "outcome-unknown",
      reason: "delivery-unconfirmed",
      retryAfterMs: MAX_NOTICE_DATE_MS - now.getTime() + overflow,
    });
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatch as any, {
      now: () => new Date(now),
      uuid: uuidSequence("maximum-date"),
    });

    await notifier.tick();
    await notifier.stop();

    const pending = await stored(row._id);
    const preparation = copy(pending.delivery.preparation!);
    expect(pending.delivery).toMatchObject({
      state: "pending",
      attempts: 1,
      uncertainSend: true,
      preparation,
      ...(blocked
        ? {
            retryBlocked: true,
            nextAttemptAt: now,
            diagnostic: { reason: "retry-deadline-unrepresentable", at: now },
          }
        : { nextAttemptAt: new Date(MAX_NOTICE_DATE_MS), diagnostic: { reason: "delivery-unconfirmed" } }),
    });
    expect(pending.delivery.retryBlocked).toBe(blocked ? true : undefined);

    const restartedDispatch = dispatcherFixture();
    const restarted = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), restartedDispatch as any, {
      now: () => new Date(now.getTime() + 86_400_000),
      uuid: uuidSequence("maximum-restart"),
    });
    await restarted.tick();
    expect(await stored(row._id)).toEqual(pending);
    expect(restartedDispatch.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(restartedDispatch.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(restartedDispatch.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    await restarted.stop();
  });

  it("resends the exact persisted preparation after a crash before durable acknowledgment", async () => {
    const row = change(51);
    await seed(row);
    const ackEntered = deferred<void>();
    let blockedAck = true;
    const crashDb = faultDb(mongo.db, async (collection, method, args, run) => {
      if (
        blockedAck &&
        collection === CHANGES &&
        method === "updateOne" &&
        args[1]?.$set?.delivery?.state === "delivered"
      ) {
        blockedAck = false;
        ackEntered.resolve();
        throw new Error("private lost acknowledgment");
      }
      return run();
    });
    const crashOutbox = new ModelCatalogOutbox(crashDb);
    const crashReads = vi.spyOn(crashOutbox, "read");
    const crashApplies = vi.spyOn(crashOutbox, "apply");
    const firstDispatch = dispatcherFixture();
    const first = new ModelCatalogNotifier(crashOutbox, firstDispatch as any, {
      uuid: uuidSequence("crashed"),
      leaseMs: 80,
      renewMs: 1_000,
      pollMs: 1_000,
      drainMs: 250,
    });
    const flight = first.tick();
    await ackEntered.promise;
    await first.stop();
    const callsAtDrain = crashReads.mock.calls.length + crashApplies.mock.calls.length;
    await flight;
    expect(crashReads.mock.calls.length + crashApplies.mock.calls.length).toBe(callsAtDrain);

    const stranded = await stored(row._id);
    const preparation = copy(stranded.delivery.preparation!);
    expect(stranded.delivery).toMatchObject({
      state: "claimed",
      attempts: 1,
      preparation,
      claim: { stage: "sending", sendIntent: { preparationId: preparation.id } },
    });
    expect(firstDispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(firstDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    const remaining = stranded.delivery.claim!.leaseExpiresAt.getTime() - Date.now();
    if (remaining >= 0) await new Promise((resolve) => setTimeout(resolve, remaining + 25));
    const serverTime = (await mongo.db.admin().command({ hello: 1 })).localTime as Date;
    expect(serverTime.getTime()).toBeGreaterThan(stranded.delivery.claim!.leaseExpiresAt.getTime());

    const recoveredDispatch = dispatcherFixture();
    const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), recoveredDispatch as any, {
      uuid: uuidSequence("after-crash"),
    });
    await recovered.tick();

    const delivered = await stored(row._id);
    expect(recoveredDispatch.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(recoveredDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(recoveredDispatch.sendPreparedCatalogNotification.mock.calls[0]![0]).toEqual(preparation);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      attempts: 2,
      preparation,
      uncertainSend: true,
      receipt: { preparationId: preparation.id, binding: preparation.binding },
    });
    expect(immutable(delivered)).toEqual(immutable(row));
    expect(
      firstDispatch.sendPreparedCatalogNotification.mock.calls.length +
        recoveredDispatch.sendPreparedCatalogNotification.mock.calls.length,
    ).toBe(2);
    expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
    await recovered.stop();
  });

  it("executes a delayed acknowledgment and its exact retry with real matched counts [1, 0]", async () => {
    const row = change(52);
    await seed(row);
    let delayedRun: (() => Promise<any>) | undefined;
    let ackCalls = 0;
    const matched: number[] = [];
    const delayedDb = faultDb(mongo.db, async (collection, method, args, run) => {
      if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.state === "delivered") {
        ackCalls++;
        if (ackCalls === 1) {
          delayedRun = run;
          throw new Error("private first ack response");
        }
        if (!delayedRun) throw new Error("missing delayed acknowledgment");
        const first = await delayedRun();
        matched.push(first.matchedCount);
        const second = await run();
        matched.push(second.matchedCount);
        return second;
      }
      return run();
    });
    const dispatch = dispatcherFixture();
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(delayedDb), dispatch as any, {
      uuid: uuidSequence("delayed-ack"),
      pollMs: 10,
    });

    await notifier.tick();

    const delivered = await stored(row._id);
    expect(ackCalls).toBe(2);
    expect(matched).toEqual([1, 0]);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      receipt: {
        preparationId: delivered.delivery.preparation?.id,
        binding: delivered.delivery.preparation?.binding,
      },
    });
    expect(dispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
    await notifier.stop();
  });

  it("preserves a successor pending state when an old known acknowledgment executes late", async () => {
    const row = change(53);
    await seed(row);
    let delayedAck: (() => Promise<any>) | undefined;
    let ackFaulted = false;
    const ackEntered = deferred<void>();
    const faultedDb = faultDb(mongo.db, async (collection, method, args, run) => {
      if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.state === "delivered") {
        if (!ackFaulted) {
          ackFaulted = true;
          delayedAck = run;
          ackEntered.resolve();
        }
        throw new Error("private stale acknowledgment response");
      }
      return run();
    });
    const dispatchA = dispatcherFixture();
    const notifierA = new ModelCatalogNotifier(new ModelCatalogOutbox(faultedDb), dispatchA as any, {
      uuid: uuidSequence("stale-ack-a"),
      leaseMs: 80,
      renewMs: 1_000,
      pollMs: 20,
    });
    const flightA = notifierA.tick();
    await ackEntered.promise;
    const stranded = await stored(row._id);
    const preparation = copy(stranded.delivery.preparation!);
    expect(dispatchA.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await waitForServerAfter(stranded.delivery.claim!.leaseExpiresAt);

    const dispatchB = dispatcherFixture();
    dispatchB.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
    });
    const notifierB = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatchB as any, {
      uuid: uuidSequence("stale-ack-b"),
    });
    await notifierB.tick();
    const pendingSuccessor = await stored(row._id);
    expect(pendingSuccessor.delivery).toMatchObject({
      state: "pending",
      attempts: 2,
      preparation,
      uncertainSend: true,
    });
    expect(pendingSuccessor.delivery.claim).toBeUndefined();
    expect(dispatchB.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatchB.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    await flightA;
    if (!delayedAck) throw new Error("missing delayed old acknowledgment");
    expect((await delayedAck()).matchedCount).toBe(0);
    expect(await stored(row._id)).toEqual(pendingSuccessor);
    expect(dispatchA.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    await makeDue(row._id);
    const dispatchC = dispatcherFixture();
    const notifierC = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatchC as any, {
      uuid: uuidSequence("stale-ack-c"),
    });
    await notifierC.tick();
    const delivered = await stored(row._id);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      attempts: 3,
      preparation,
      uncertainSend: true,
      receipt: { preparationId: preparation.id, binding: preparation.binding },
    });
    expect(dispatchC.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatchC.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(immutable(delivered)).toEqual(immutable(row));
    expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
    await Promise.all([notifierA.stop(), notifierB.stop(), notifierC.stop()]);
  });

  it("renews a long CoS turn beyond the original lease and keeps a competitor out", async () => {
    const row = change(6);
    await seed(row);
    const dispatchA = dispatcherFixture();
    const turn = deferred<void>();
    dispatchA.prepareCatalogNotification.mockImplementationOnce(async (selected, route) => {
      await turn.promise;
      return {
        kind: "prepared",
        preparation: makePreparation(selected, route, "long turn complete", new Date()),
      };
    });
    const renewalLeases: number[] = [];
    const renewalMatches: number[] = [];
    const renewalDb = faultDb(mongo.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      const result = await run();
      if (
        collection === CHANGES &&
        method === "updateOne" &&
        next?.state === "claimed" &&
        next?.version >= 2 &&
        next?.claim?.stage === "preparing" &&
        !next?.preparation
      ) {
        renewalMatches.push(result.matchedCount);
        if (result.matchedCount === 1) renewalLeases.push(next.claim.leaseExpiresAt.getTime());
      }
      return result;
    });
    const a = new ModelCatalogNotifier(new ModelCatalogOutbox(renewalDb), dispatchA as any, {
      uuid: uuidSequence("renewing-a"),
      leaseMs: 250,
      renewMs: 50,
      pollMs: 1_000,
    });
    const flight = a.tick();
    await vi.waitFor(() => expect(dispatchA.prepareCatalogNotification).toHaveBeenCalledTimes(1));
    const original = (await stored(row._id)).delivery.claim!.leaseExpiresAt;
    await new Promise((resolve) => setTimeout(resolve, 325));
    const renewed = await stored(row._id);
    expect(renewed.delivery.claim!.leaseExpiresAt.getTime()).toBeGreaterThan(original.getTime());
    expect(renewalLeases.length).toBeGreaterThanOrEqual(4);
    expect(renewalLeases.every((lease, index) => index === 0 || lease > renewalLeases[index - 1]!)).toBe(true);
    expect(renewalMatches.every((matched) => matched === 1)).toBe(true);

    const dispatchB = dispatcherFixture();
    const b = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatchB as any, {
      uuid: uuidSequence("renewing-b"),
    });
    await b.tick();
    expect(dispatchB.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(renewed.delivery.attempts).toBe(1);

    turn.resolve();
    await flight;
    expect((await stored(row._id)).delivery.state).toBe("delivered");
    expect(dispatchA.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatchA.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await Promise.all([a.stop(), b.stop()]);
  });

  it.each([
    {
      label: "pre-application throw with negative evidence",
      applyBeforeThrow: false,
      readUnavailable: false,
      successor: "delivered",
    },
    {
      label: "pre-application throw with unavailable evidence",
      applyBeforeThrow: false,
      readUnavailable: true,
      successor: "pending",
    },
    {
      label: "post-application throw with unavailable evidence",
      applyBeforeThrow: true,
      readUnavailable: true,
      successor: "delivered",
    },
  ] as const)(
    "starts no later stage after a renewal $label",
    async ({ applyBeforeThrow, readUnavailable, successor }) => {
      const row = change(70);
      await seed(row);
      const renewalEntered = deferred<void>();
      let renewalFaulted = false;
      const renewalMatches: number[] = [];
      const faultedDb = faultDb(mongo.db, async (collection, method, args, run) => {
        const next = args[1]?.$set?.delivery;
        const target =
          collection === CHANGES &&
          method === "updateOne" &&
          next?.state === "claimed" &&
          next?.version === 2 &&
          next?.claim?.stage === "preparing";
        if (collection === CHANGES && method === "findOne" && renewalFaulted && readUnavailable) {
          throw new Error("private renewal evidence");
        }
        if (target) {
          if (!renewalFaulted && applyBeforeThrow) {
            const result = await run();
            renewalMatches.push(result.matchedCount);
          }
          renewalFaulted = true;
          renewalEntered.resolve();
          throw new Error("private renewal response");
        }
        return run();
      });
      const dispatchA = dispatcherFixture();
      const turn = deferred<void>();
      dispatchA.prepareCatalogNotification.mockImplementationOnce(async (selected, route) => {
        await turn.promise;
        return {
          kind: "prepared",
          preparation: makePreparation(selected, route, "old owner turn", new Date()),
        };
      });
      const notifierA = new ModelCatalogNotifier(new ModelCatalogOutbox(faultedDb), dispatchA as any, {
        uuid: uuidSequence("renew-a"),
        leaseMs: 90,
        renewMs: 20,
        pollMs: 20,
      });
      const flightA = notifierA.tick();
      await renewalEntered.promise;
      expect(dispatchA.prepareCatalogNotification).toHaveBeenCalledTimes(1);
      expect(dispatchA.sendPreparedCatalogNotification).not.toHaveBeenCalled();

      const uncertain = await stored(row._id);
      await waitForServerAfter(uncertain.delivery.claim!.leaseExpiresAt);
      const dispatchB = dispatcherFixture();
      if (successor === "pending") {
        dispatchB.sendPreparedCatalogNotification.mockResolvedValueOnce({
          kind: "not-accepted",
          reason: "delivery-unconfirmed",
        });
      }
      const notifierB = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatchB as any, {
        uuid: uuidSequence("renew-b"),
      });
      await notifierB.tick();
      const successorRow = await stored(row._id);
      expect(successorRow.delivery.state).toBe(successor);
      expect(dispatchB.prepareCatalogNotification).toHaveBeenCalledTimes(1);
      expect(dispatchB.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

      turn.resolve();
      await flightA;
      expect(await stored(row._id)).toEqual(successorRow);
      expect(immutable(successorRow)).toEqual(immutable(row));
      expect(dispatchA.prepareCatalogNotification).toHaveBeenCalledTimes(1);
      expect(dispatchA.sendPreparedCatalogNotification).not.toHaveBeenCalled();
      expect(renewalMatches).toEqual(applyBeforeThrow ? [1] : []);
      expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
      await Promise.all([notifierA.stop(), notifierB.stop()]);
    },
  );

  it("rebases a known receipt after a real same-token renewal advances the version", async () => {
    const row = change(71);
    await seed(row);
    const rawOutbox = new ModelCatalogOutbox(mongo.db);
    const ackMatches: number[] = [];
    const renewalMatches: number[] = [];
    let advanced = false;
    const faultedDb = faultDb(mongo.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (collection === CHANGES && method === "updateOne" && next?.state === "delivered") {
        if (!advanced) {
          advanced = true;
          const current = await stored(row._id);
          const at = await serverNow();
          const renewed = transition(
            "renew",
            current,
            {
              ...copy(current.delivery),
              claim: {
                ...copy(current.delivery.claim!),
                leaseExpiresAt: new Date(current.delivery.claim!.leaseExpiresAt.getTime() + 1_000),
              },
            },
            at,
            true,
          );
          const renewal = await rawOutbox.apply(renewed);
          expect(renewal).toMatchObject({ kind: "applied", source: "ack" });
          renewalMatches.push(1);
        }
        const result = await run();
        ackMatches.push(result.matchedCount);
        return result;
      }
      return run();
    });
    const dispatch = dispatcherFixture();
    dispatch.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "acknowledged",
      channelId: ROUTE.channelId,
      messageTs: "1770000000.654321",
    });
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(faultedDb), dispatch as any, {
      uuid: uuidSequence("ack-rebase"),
    });

    await notifier.tick();

    const delivered = await stored(row._id);
    expect(renewalMatches).toEqual([1]);
    expect(ackMatches).toEqual([0, 1]);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      version: 5,
      receipt: { messageTs: "1770000000.654321" },
    });
    expect(dispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await notifier.stop();
  });

  it.each(["index", "due", "claim", "lookup-route", "lookup-db", "prepare", "send-intent"] as const)(
    "stops during a held real %s stage and starts no following external stage",
    async (stage) => {
      const row = change(80);
      await seed(row);
      const entered = deferred<void>();
      const resume = deferred<void>();
      let held = false;
      let gateReadArmed = false;
      const gatedDb = faultDb(mongo.db, async (collection, method, args, run) => {
        const next = args[1]?.$set?.delivery;
        const target =
          (stage === "index" && method === "createIndex") ||
          (stage === "due" && method === "find") ||
          (stage === "claim" && method === "updateOne" && next?.state === "claimed" && next?.version === 1) ||
          (stage === "lookup-db" && gateReadArmed && method === "findOne") ||
          (stage === "prepare" &&
            method === "updateOne" &&
            next?.state === "claimed" &&
            next?.claim?.stage === "preparing" &&
            next?.preparation) ||
          (stage === "send-intent" &&
            method === "updateOne" &&
            next?.state === "claimed" &&
            next?.claim?.stage === "sending");
        if (!held && collection === CHANGES && target) {
          held = true;
          entered.resolve();
          await resume.promise;
        }
        return run();
      });
      const outbox = new ModelCatalogOutbox(gatedDb);
      const ensure = vi.spyOn(outbox, "ensureIndexes");
      const due = vi.spyOn(outbox, "due");
      const read = vi.spyOn(outbox, "read");
      const apply = vi.spyOn(outbox, "apply");
      const storeCalls = () =>
        ensure.mock.calls.length + due.mock.calls.length + read.mock.calls.length + apply.mock.calls.length;
      const dispatch = dispatcherFixture();
      if (stage === "lookup-route") {
        dispatch.resolveCatalogNotificationRoute.mockImplementationOnce(async (gate) => {
          expect(await gate.check()).toBe(true);
          entered.resolve();
          await resume.promise;
          return { kind: "route", route: copy(ROUTE) };
        });
      } else if (stage === "lookup-db") {
        dispatch.resolveCatalogNotificationRoute.mockImplementationOnce(async (gate) => {
          gateReadArmed = true;
          return (await gate.check()) && gate.current()
            ? { kind: "route", route: copy(ROUTE) }
            : { kind: "unresolved", reason: "recipient-changed" };
        });
      }
      const notifier = new ModelCatalogNotifier(outbox, dispatch as any, {
        uuid: uuidSequence(`stop-${stage}`),
        leaseMs: 120,
        renewMs: 1_000,
        drainMs: 20,
      });
      const flight = notifier.tick();
      let callsAtDrain: number;
      const started = Date.now();
      try {
        await entered.promise;
        await notifier.stop();
        expect(Date.now() - started).toBeLessThan(1_000);
        callsAtDrain = storeCalls();
      } finally {
        resume.resolve();
        await flight;
      }

      expect(storeCalls()).toBe(callsAtDrain);
      expect(dispatch.prepareCatalogNotification).toHaveBeenCalledTimes(
        stage === "prepare" || stage === "send-intent" ? 1 : 0,
      );
      expect(dispatch.sendPreparedCatalogNotification).not.toHaveBeenCalled();
      const stranded = await stored(row._id);
      expect(immutable(stranded)).toEqual(immutable(row));
      if (stranded.delivery.state === "claimed") {
        await waitForServerAfter(stranded.delivery.claim!.leaseExpiresAt);
      }

      const recoveredDispatch = dispatcherFixture();
      const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), recoveredDispatch as any, {
        uuid: uuidSequence(`recover-${stage}`),
      });
      await recovered.tick();
      expect((await stored(row._id)).delivery.state).toBe("delivered");
      expect(recoveredDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
      await recovered.stop();
    },
  );

  it.each(["turn", "send"] as const)(
    "stops during a held %s promise and recovers the real persisted state",
    async (stage) => {
      const row = change(stage === "turn" ? 81 : 82);
      await seed(row);
      const entered = deferred<void>();
      const resume = deferred<void>();
      const dispatch = dispatcherFixture();
      if (stage === "turn") {
        dispatch.prepareCatalogNotification.mockImplementationOnce(async (selected, route) => {
          entered.resolve();
          await resume.promise;
          return {
            kind: "prepared",
            preparation: makePreparation(selected, route, "late turn", new Date()),
          };
        });
      } else {
        dispatch.sendPreparedCatalogNotification.mockImplementationOnce(async () => {
          entered.resolve();
          await resume.promise;
          return { kind: "acknowledged", channelId: ROUTE.channelId, messageTs: "1770000000.820000" };
        });
      }
      const outbox = new ModelCatalogOutbox(mongo.db);
      const reads = vi.spyOn(outbox, "read");
      const applies = vi.spyOn(outbox, "apply");
      const notifier = new ModelCatalogNotifier(outbox, dispatch as any, {
        uuid: uuidSequence(`external-stop-${stage}`),
        leaseMs: 120,
        renewMs: 1_000,
        drainMs: 20,
      });
      const flight = notifier.tick();
      let callsAtDrain: number;
      try {
        await entered.promise;
        await notifier.stop();
        callsAtDrain = reads.mock.calls.length + applies.mock.calls.length;
      } finally {
        resume.resolve();
        await flight;
      }
      expect(reads.mock.calls.length + applies.mock.calls.length).toBe(callsAtDrain);
      expect(dispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(stage === "send" ? 1 : 0);
      const stranded = await stored(row._id);
      expect(stranded.delivery.state).toBe("claimed");
      if (stage === "send") expect(stranded.delivery.preparation).toBeDefined();
      else expect(stranded.delivery.preparation).toBeUndefined();
      await waitForServerAfter(stranded.delivery.claim!.leaseExpiresAt);

      const recoveredDispatch = dispatcherFixture();
      const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), recoveredDispatch as any, {
        uuid: uuidSequence(`external-recovery-${stage}`),
      });
      await recovered.tick();
      const delivered = await stored(row._id);
      expect(delivered.delivery.state).toBe("delivered");
      expect(recoveredDispatch.prepareCatalogNotification).toHaveBeenCalledTimes(stage === "turn" ? 1 : 0);
      expect(recoveredDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
      expect(delivered.delivery.uncertainSend).toBe(stage === "send");
      await recovered.stop();
    },
  );

  it("allows an acknowledgment already in flight to persist while stop drains", async () => {
    const row = change(83);
    await seed(row);
    const entered = deferred<void>();
    const resume = deferred<void>();
    const matched: number[] = [];
    const gatedDb = faultDb(mongo.db, async (collection, method, args, run) => {
      if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.state === "delivered") {
        entered.resolve();
        await resume.promise;
        const result = await run();
        matched.push(result.matchedCount);
        return result;
      }
      return run();
    });
    const outbox = new ModelCatalogOutbox(gatedDb);
    const reads = vi.spyOn(outbox, "read");
    const applies = vi.spyOn(outbox, "apply");
    const dispatch = dispatcherFixture();
    const notifier = new ModelCatalogNotifier(outbox, dispatch as any, {
      uuid: uuidSequence("ack-stop"),
      drainMs: 20,
    });
    const flight = notifier.tick();
    let callsAtDrain: number;
    try {
      await entered.promise;
      await notifier.stop();
      callsAtDrain = reads.mock.calls.length + applies.mock.calls.length;
    } finally {
      resume.resolve();
      await flight;
    }

    expect(matched).toEqual([1]);
    expect(reads.mock.calls.length + applies.mock.calls.length).toBe(callsAtDrain);
    expect((await stored(row._id)).delivery).toMatchObject({
      state: "delivered",
      receipt: { preparationId: expect.any(String), channelId: ROUTE.channelId },
    });
    expect(dispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    const terminalDispatch = dispatcherFixture();
    const terminal = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), terminalDispatch as any, {
      uuid: uuidSequence("ack-stop-terminal"),
    });
    await terminal.tick();
    expect(terminalDispatch.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    await terminal.stop();
  });

  it("observes an in-flight real renewal through bounded stop and starts no later stage", async () => {
    const row = change(84);
    await seed(row);
    const entered = deferred<void>();
    const resume = deferred<void>();
    let held = false;
    const matched: number[] = [];
    const gatedDb = faultDb(mongo.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (
        !held &&
        collection === CHANGES &&
        method === "updateOne" &&
        next?.state === "claimed" &&
        next?.version === 2
      ) {
        held = true;
        entered.resolve();
        await resume.promise;
        const result = await run();
        matched.push(result.matchedCount);
        return result;
      }
      return run();
    });
    const outbox = new ModelCatalogOutbox(gatedDb);
    const reads = vi.spyOn(outbox, "read");
    const applies = vi.spyOn(outbox, "apply");
    const dispatch = dispatcherFixture();
    const turn = deferred<void>();
    dispatch.prepareCatalogNotification.mockImplementationOnce(async (selected, route) => {
      await turn.promise;
      return {
        kind: "prepared",
        preparation: makePreparation(selected, route, "late renewal turn", new Date()),
      };
    });
    const notifier = new ModelCatalogNotifier(outbox, dispatch as any, {
      uuid: uuidSequence("renew-stop"),
      leaseMs: 100,
      renewMs: 10,
      drainMs: 20,
    });
    const flight = notifier.tick();
    let callsAtDrain: number;
    try {
      await entered.promise;
      await notifier.stop();
      callsAtDrain = reads.mock.calls.length + applies.mock.calls.length;
    } finally {
      resume.resolve();
      turn.resolve();
      await flight;
    }

    expect(matched).toEqual([1]);
    expect(reads.mock.calls.length + applies.mock.calls.length).toBe(callsAtDrain);
    expect(dispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatch.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    const stranded = await stored(row._id);
    expect(stranded.delivery).toMatchObject({ state: "claimed", version: 2 });
    await waitForServerAfter(stranded.delivery.claim!.leaseExpiresAt);

    const recoveredDispatch = dispatcherFixture();
    const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), recoveredDispatch as any, {
      uuid: uuidSequence("renew-stop-recovery"),
    });
    await recovered.tick();
    expect((await stored(row._id)).delivery.state).toBe("delivered");
    expect(recoveredDispatch.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(recoveredDispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await recovered.stop();
  });

  it("keyset-pages past invalid rows without mutation and delivers the valid successor once", async () => {
    const now = new Date();
    const rows: CatalogChangeDoc[] = [];
    const falsey = [null, false, 0, "", []] as const;
    for (let number = 10; number <= 30; number++) {
      const row = change(number, now);
      (row.delivery as any).preparation = falsey[(number - 10) % falsey.length];
      rows.push(row);
    }
    const valid = change(31, now);
    rows.push(valid);
    await mongo.db.collection(CHANGES).insertMany(rows.map(copy), JOURNALED);
    const before = await mongo.db.collection(CHANGES).find({}).sort({ _id: 1 }).toArray();
    const dispatch = dispatcherFixture();
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatch as any, {
      uuid: uuidSequence("paging"),
    });

    await notifier.tick();
    await notifier.tick();
    expect(dispatch.prepareCatalogNotification).not.toHaveBeenCalled();
    await notifier.tick();
    expect((await stored(valid._id)).delivery.state).toBe("delivered");
    for (const original of before.filter((candidate) => candidate._id !== valid._id)) {
      expect(await stored(original._id)).toEqual(original);
    }
    for (let index = 0; index < 4; index++) await notifier.tick();
    expect(dispatch.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect((notifier as any).invalidPage.size).toBeLessThanOrEqual(10);
    await notifier.stop();
  });

  it.each(
    ["preparation", "sendIntent"].flatMap((field) =>
      [
        ["null", null],
        ["false", false],
        ["zero", 0],
        ["blank", ""],
        ["array", []],
      ].map(([label, value]) => ({ field, label, value })),
    ),
  )("leaves a BSON $label $field untouched in an actual candidate tick", async ({ field, value }) => {
    const now = new Date();
    const row = change(90, now);
    if (field === "preparation") {
      (row.delivery as any).preparation = value;
    } else {
      row.delivery = {
        state: "claimed",
        attempts: 1,
        lastAttemptAt: new Date(now.getTime() - 120_000),
        claim: {
          token: "invalid-intent",
          owner: "old-worker",
          startedAt: new Date(now.getTime() - 120_000),
          leaseExpiresAt: new Date(now.getTime() - 60_000),
          stage: "preparing",
          sendIntent: value as never,
        },
      };
    }
    await seed(row);
    const before = await stored(row._id);
    const dispatch = dispatcherFixture();
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatch as any, {
      uuid: uuidSequence(`falsey-${field}`),
    });

    await notifier.tick();

    expect(await stored(row._id)).toEqual(before);
    expect(dispatch.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(dispatch.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatch.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    await notifier.stop();
  });
});
