/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => testLog }));

import { JOURNALED } from "./model-catalog-export.js";
import { makePreparation, sameBinding, type NoticeRoute } from "./model-catalog-notification.js";
import { ModelCatalogNotifier } from "./model-catalog-notifier.js";
import { copy, ModelCatalogOutbox } from "./model-catalog-outbox.js";
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

function dispatcherFixture() {
  const api = {
    resolveCatalogNotificationRoute: vi.fn(async (gate: { check(): Promise<boolean>; current(): boolean }) =>
      (await gate.check()) && gate.current()
        ? { kind: "route" as const, route: copy(ROUTE) }
        : { kind: "unresolved" as const, reason: "recipient-changed" as const },
    ),
    catalogNotificationRouteCurrent: vi.fn((candidate: NoticeRoute) => sameBinding(candidate, ROUTE)),
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
    const a = new ModelCatalogNotifier(new ModelCatalogOutbox(mongo.db), dispatchA as any, {
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

  it("keyset-pages past invalid rows without mutation and delivers the valid successor once", async () => {
    const now = new Date();
    const rows: CatalogChangeDoc[] = [];
    for (let number = 10; number <= 30; number++) {
      const row = change(number, now);
      (row.delivery as any).preparation = number % 2 ? null : [];
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
});
