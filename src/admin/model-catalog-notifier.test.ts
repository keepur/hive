/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

const testLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => testLog }));

import { MAX_NOTICE_DATE_MS, makePreparation, sameBinding, type NoticeRoute } from "./model-catalog-notification.js";
import { ModelCatalogNotifier, NOTIFIER_DEFAULTS } from "./model-catalog-notifier.js";
import { copy, ModelCatalogOutbox } from "./model-catalog-outbox.js";
import type { CatalogChangeDoc } from "./model-catalog-types.js";
import { cloneBson, createCatalogFake, deferred, faultDb } from "./testing/catalog-db.test-support.js";

const CHANGES = "agent_model_catalog_changes";
const BASE = Date.parse("2026-09-07T12:00:00.000Z");
const plus = (value: number | Date, milliseconds: number) =>
  new Date((value instanceof Date ? value.getTime() : value) + milliseconds);

const ROUTE_A: NoticeRoute = {
  agentId: "chief-a",
  agentName: "Chief A",
  homeBase: "ops-a",
  adapterId: "slack",
  channelId: "CA1234",
};

const ROUTE_B: NoticeRoute = {
  agentId: "chief-b",
  agentName: "Chief B",
  homeBase: "ops-b",
  adapterId: "slack",
  channelId: "CB1234",
};

function change(number = 1, now = BASE): CatalogChangeDoc {
  return {
    _id: `change-${String(number).padStart(3, "0")}`,
    provider: "codex",
    revision: number,
    snapshotId: `snapshot-${number}`,
    createdAt: plus(now, -120_000 + number),
    source: "manual",
    updatedBy: "unit-operator",
    modelCount: 2,
    bootstrap: number === 1,
    added: [`model-${number}`],
    removed: ["old-model"],
    delivery: { state: "pending", attempts: 0, nextAttemptAt: plus(now, -60_000) },
  };
}

function uuidSequence(prefix: string) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function dispatcherFixture(clock: { now: number }, initialRoute: NoticeRoute | undefined = ROUTE_A) {
  let route = initialRoute;
  const api = {
    resolveCatalogNotificationRoute: vi.fn(async (gate: { check(): Promise<boolean>; current(): boolean }) => {
      if (!(await gate.check()) || !gate.current()) {
        return { kind: "unresolved" as const, reason: "recipient-changed" as const };
      }
      return route
        ? { kind: "route" as const, route: copy(route) }
        : { kind: "unresolved" as const, reason: "recipient-missing" as const };
    }),
    catalogNotificationRouteCurrent: vi.fn(
      (candidate: NoticeRoute) => Boolean(route) && sameBinding(candidate, route!),
    ),
    prepareCatalogNotification: vi.fn(async (row: CatalogChangeDoc, selected: NoticeRoute, mayStart: () => boolean) =>
      mayStart()
        ? {
            kind: "prepared" as const,
            preparation: makePreparation(row, selected, `Processed ${row._id}.`, new Date(clock.now)),
          }
        : { kind: "unresolved" as const, reason: "recipient-changed" as const },
    ),
    sendPreparedCatalogNotification: vi.fn(
      async (preparation: ReturnType<typeof makePreparation>, mayStart: () => boolean) =>
        mayStart()
          ? {
              kind: "acknowledged" as const,
              channelId: preparation.binding.channelId,
              messageTs: `${Math.floor(clock.now / 1_000)}.000001`,
            }
          : { kind: "not-accepted" as const, reason: "recipient-changed" as const },
    ),
  };
  return { api, setRoute: (next: NoticeRoute | undefined) => (route = next) };
}

function subjectFixture(row = change()) {
  const clock = { now: BASE };
  const fake = createCatalogFake(() => new Date(clock.now));
  fake.rows(CHANGES).set(row._id, cloneBson(row));
  const outbox = new ModelCatalogOutbox(fake.db);
  const dispatcher = dispatcherFixture(clock);
  const notifier = new ModelCatalogNotifier(outbox, dispatcher.api as any, {
    now: () => new Date(clock.now),
    uuid: uuidSequence("unit"),
  });
  return { clock, fake, outbox, dispatcher, notifier };
}

function stored(fake: ReturnType<typeof createCatalogFake>, id: string): CatalogChangeDoc {
  return cloneBson(fake.rows(CHANGES).get(id) as CatalogChangeDoc);
}

beforeEach(() => {
  testLog.info.mockReset();
  testLog.warn.mockReset();
  vi.useRealTimers();
});

describe("ModelCatalogNotifier delivery and retries", () => {
  it("persists claim, preparation, send intent and receipt before becoming terminal", async () => {
    const fixture = subjectFixture();
    const apply = vi.spyOn(fixture.outbox, "apply");

    await fixture.notifier.tick();

    const row = stored(fixture.fake, "change-001");
    expect(apply.mock.calls.map(([transition]) => transition.kind)).toEqual(["claim", "prepare", "send-intent", "ack"]);
    expect(row.delivery).toMatchObject({
      state: "delivered",
      attempts: 1,
      version: 4,
      uncertainSend: false,
      receipt: {
        preparationId: row.delivery.preparation?.id,
        binding: row.delivery.preparation?.binding,
        channelId: ROUTE_A.channelId,
      },
    });
    expect(row.delivery.claim).toBeUndefined();
    expect(fixture.dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(fixture.dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(testLog.info).toHaveBeenCalledWith("Catalog notification delivered", {
      provider: '"codex"',
      changeId: row._id,
      attempts: 1,
      stage: "delivered",
    });

    await fixture.notifier.tick();
    expect(fixture.dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await fixture.notifier.stop();
  });

  it("uses the 1, 5, 15, 60 and capped 60 minute retry sequence", async () => {
    const fixture = subjectFixture();
    fixture.dispatcher.setRoute(undefined);
    const expected = [60_000, 300_000, 900_000, 3_600_000, 3_600_000];

    for (const delay of expected) {
      const attemptedAt = fixture.clock.now;
      await fixture.notifier.tick();
      const row = stored(fixture.fake, "change-001");
      expect(row.delivery.state).toBe("pending");
      expect(row.delivery.nextAttemptAt.getTime() - attemptedAt).toBe(delay);
      expect(row.delivery.diagnostic).toEqual({ reason: "recipient-missing", at: new Date(attemptedAt) });
      fixture.clock.now = row.delivery.nextAttemptAt.getTime();
    }

    const row = stored(fixture.fake, "change-001");
    expect(row.delivery.attempts).toBe(5);
    expect(fixture.dispatcher.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(fixture.dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    await fixture.notifier.stop();
  });

  it("uses a server retry delay as a lower bound and blocks an unrepresentable deadline", async () => {
    const fixture = subjectFixture();
    fixture.dispatcher.api.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
      retryAfterMs: 720_000,
    });
    await fixture.notifier.tick();
    let row = stored(fixture.fake, "change-001");
    expect(row.delivery.nextAttemptAt).toEqual(new Date(BASE + 720_000));
    expect(row.delivery.preparation).toBeDefined();

    fixture.clock.now = row.delivery.nextAttemptAt.getTime();
    fixture.dispatcher.api.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
      retryAfterMs: MAX_NOTICE_DATE_MS - fixture.clock.now + 1,
    });
    await fixture.notifier.tick();
    row = stored(fixture.fake, row._id);
    expect(row.delivery).toMatchObject({
      state: "pending",
      attempts: 2,
      retryBlocked: true,
      diagnostic: { reason: "retry-deadline-unrepresentable", at: new Date(fixture.clock.now) },
      nextAttemptAt: new Date(fixture.clock.now),
    });
    const attempts = row.delivery.attempts;
    await fixture.notifier.tick();
    expect(stored(fixture.fake, row._id).delivery.attempts).toBe(attempts);
    await fixture.notifier.stop();
  });

  it("does not increment attempts or start external work when a candidate claim misses", async () => {
    const row = change();
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    const refused = faultDb(fake.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (collection === CHANGES && method === "updateOne" && next?.state === "claimed") {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      return run();
    });
    const dispatcher = dispatcherFixture(clock);
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(refused), dispatcher.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("miss"),
    });

    await notifier.tick();

    expect(stored(fake, row._id).delivery).toEqual(row.delivery);
    expect(dispatcher.api.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(dispatcher.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    await notifier.stop();
  });

  it("reuses a same-binding preparation across restart and never repeats the CoS turn", async () => {
    const fixture = subjectFixture();
    fixture.dispatcher.api.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
    });
    await fixture.notifier.tick();
    await fixture.notifier.stop();
    const first = stored(fixture.fake, "change-001");
    const preparation = copy(first.delivery.preparation!);
    fixture.clock.now = first.delivery.nextAttemptAt.getTime();

    const restartedDispatcher = dispatcherFixture(fixture.clock);
    const restarted = new ModelCatalogNotifier(fixture.outbox, restartedDispatcher.api as any, {
      now: () => new Date(fixture.clock.now),
      uuid: uuidSequence("restart"),
    });
    await restarted.tick();

    const delivered = stored(fixture.fake, first._id);
    expect(restartedDispatcher.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(restartedDispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(restartedDispatcher.api.sendPreparedCatalogNotification.mock.calls[0]?.[0]).toEqual(preparation);
    expect(delivered.delivery.preparation).toEqual(preparation);
    expect(delivered.delivery.state).toBe("delivered");
    await restarted.stop();
  });

  it("regenerates preparation after a recipient binding changes", async () => {
    const fixture = subjectFixture();
    fixture.dispatcher.api.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
    });
    await fixture.notifier.tick();
    const first = stored(fixture.fake, "change-001");
    const oldPreparation = copy(first.delivery.preparation!);
    fixture.clock.now = first.delivery.nextAttemptAt.getTime();
    fixture.dispatcher.setRoute(ROUTE_B);

    await fixture.notifier.tick();

    const delivered = stored(fixture.fake, first._id);
    expect(fixture.dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(2);
    expect(delivered.delivery.preparation?.binding).toEqual({
      agentId: ROUTE_B.agentId,
      homeBase: ROUTE_B.homeBase,
      adapterId: ROUTE_B.adapterId,
      channelId: ROUTE_B.channelId,
    });
    expect(delivered.delivery.preparation?.id).not.toBe(oldPreparation.id);
    expect(delivered.delivery.state).toBe("delivered");
    await fixture.notifier.stop();
  });

  it.each(["resolution", "preparation", "send-intent"] as const)(
    "starts no stale Slack post when routing changes during %s",
    async (stage) => {
      const fixture = subjectFixture();
      if (stage === "resolution") {
        fixture.dispatcher.api.resolveCatalogNotificationRoute.mockImplementationOnce(async (gate) => {
          expect(await gate.check()).toBe(true);
          fixture.dispatcher.setRoute(ROUTE_B);
          return { kind: "route", route: copy(ROUTE_A) } as const;
        });
      } else {
        const originalApply = fixture.outbox.apply.bind(fixture.outbox);
        vi.spyOn(fixture.outbox, "apply").mockImplementation(async (transition, mayRead) => {
          const result = await originalApply(transition, mayRead);
          const mutation = stage === "preparation" ? "prepare" : "send-intent";
          if (result.kind === "applied" && transition.kind === mutation) fixture.dispatcher.setRoute(ROUTE_B);
          return result;
        });
      }

      await fixture.notifier.tick();

      const row = stored(fixture.fake, "change-001");
      expect(row.delivery).toMatchObject({
        state: "pending",
        attempts: 1,
        uncertainSend: false,
        diagnostic: { reason: "recipient-changed" },
      });
      expect(fixture.dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(stage === "resolution" ? 0 : 1);
      expect(fixture.dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
      await fixture.notifier.stop();
    },
  );

  it("continues serially to a later due change while an older change backs off", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    for (const row of [change(1), change(2)]) fake.rows(CHANGES).set(row._id, cloneBson(row));
    const outbox = new ModelCatalogOutbox(fake.db);
    const dispatcher = dispatcherFixture(clock);
    dispatcher.api.resolveCatalogNotificationRoute.mockImplementation(async (gate) => {
      if (!(await gate.check()) || !gate.current()) {
        return { kind: "unresolved", reason: "recipient-changed" } as const;
      }
      if (dispatcher.api.resolveCatalogNotificationRoute.mock.calls.length === 1) {
        return { kind: "unresolved", reason: "recipient-missing" } as const;
      }
      return { kind: "route", route: copy(ROUTE_A) } as const;
    });
    const notifier = new ModelCatalogNotifier(outbox, dispatcher.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("serial"),
    });

    await notifier.tick();

    expect(stored(fake, "change-001").delivery).toMatchObject({
      state: "pending",
      attempts: 1,
      diagnostic: { reason: "recipient-missing" },
    });
    expect(stored(fake, "change-002").delivery.state).toBe("delivered");
    expect(dispatcher.api.prepareCatalogNotification.mock.calls[0]?.[0]._id).toBe("change-002");
    await notifier.stop();
  });

  it("advances a bounded keyset past more than two invalid pages without mutating them", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const invalidBefore = new Map<string, CatalogChangeDoc>();
    for (let number = 1; number <= 21; number++) {
      const row = change(number);
      (row.delivery as any).preparation = number % 2 ? null : [];
      fake.rows(CHANGES).set(row._id, cloneBson(row));
      invalidBefore.set(row._id, cloneBson(row));
    }
    const valid = change(22);
    fake.rows(CHANGES).set(valid._id, cloneBson(valid));
    const dispatcher = dispatcherFixture(clock);
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), dispatcher.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("page"),
    });

    await notifier.tick();
    await notifier.tick();
    expect(dispatcher.api.prepareCatalogNotification).not.toHaveBeenCalled();
    await notifier.tick();
    expect(stored(fake, valid._id).delivery.state).toBe("delivered");
    for (const [id, before] of invalidBefore) expect(stored(fake, id)).toEqual(before);

    for (let tick = 0; tick < 4; tick++) await notifier.tick();
    expect(dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect((notifier as any).invalidPage.size).toBeLessThanOrEqual(NOTIFIER_DEFAULTS.batch);
    expect((notifier as any).nextCandidate).toEqual(
      expect.objectContaining({ createdAt: expect.any(Date), id: expect.any(String) }),
    );
    await notifier.stop();
  });
});

describe("ModelCatalogNotifier fencing and lifecycle", () => {
  it("reserves a tick synchronously and keeps its latch through lease expiry", async () => {
    const fixture = subjectFixture();
    const held = deferred<ReturnType<typeof makePreparation>>();
    fixture.dispatcher.api.prepareCatalogNotification.mockImplementationOnce(async (row, route, mayStart) => {
      if (!mayStart()) return { kind: "unresolved", reason: "recipient-changed" } as const;
      return { kind: "prepared", preparation: await held.promise } as const;
    });

    const first = fixture.notifier.tick();
    const same = fixture.notifier.tick();
    expect(same).toBe(first);
    await vi.waitFor(() => expect(fixture.dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1));
    fixture.clock.now += NOTIFIER_DEFAULTS.leaseMs + 1;
    expect(fixture.notifier.tick()).toBe(first);
    held.resolve(makePreparation(change(), ROUTE_A, "late", new Date(fixture.clock.now)));
    await first;

    expect(fixture.dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(fixture.dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    expect(stored(fixture.fake, "change-001").delivery).toMatchObject({ state: "claimed", attempts: 1 });
    await fixture.notifier.stop();
  });

  it("never turns an uncertain acquisition into permission for external work", async () => {
    const row = change();
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    let thrown = false;
    const uncertainDb = faultDb(fake.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (!thrown && collection === CHANGES && method === "updateOne" && next?.state === "claimed") {
        thrown = true;
        await run();
        throw new Error("secret acquisition response");
      }
      return run();
    });
    const dispatcher = dispatcherFixture(clock);
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(uncertainDb), dispatcher.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("uncertain-claim"),
      pollMs: 10_000,
      leaseMs: 20_000,
      drainMs: 100,
    });
    const flight = notifier.tick();
    await vi.waitFor(() => expect(stored(fake, row._id).delivery.state).toBe("claimed"));

    await notifier.stop();
    await flight;

    expect(dispatcher.api.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(dispatcher.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    expect(stored(fake, row._id).delivery.attempts).toBe(1);
  });

  it.each(["prepare", "ack"] as const)(
    "accepts exact positive evidence when a %s write applies and then throws",
    async (kind) => {
      const row = change();
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      fake.rows(CHANGES).set(row._id, cloneBson(row));
      let thrown = false;
      const faulted = faultDb(fake.db, async (collection, method, args, run) => {
        const next = args[1]?.$set?.delivery;
        const isTarget =
          kind === "prepare"
            ? next?.state === "claimed" && next?.preparation && next?.claim?.stage === "preparing"
            : next?.state === "delivered";
        if (!thrown && collection === CHANGES && method === "updateOne" && isTarget) {
          thrown = true;
          await run();
          throw new Error("secret ambiguous write");
        }
        return run();
      });
      const dispatcher = dispatcherFixture(clock);
      const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(faulted), dispatcher.api as any, {
        now: () => new Date(clock.now),
        uuid: uuidSequence(`uncertain-${kind}`),
      });

      await notifier.tick();

      expect(stored(fake, row._id).delivery.state).toBe("delivered");
      expect(dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
      expect(dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([...testLog.info.mock.calls, ...testLog.warn.mock.calls])).not.toContain("secret");
      await notifier.stop();
    },
  );

  it.each(["prepare", "ack"] as const)("retries only the exact %s transition after negative evidence", async (kind) => {
    vi.useFakeTimers({ now: BASE });
    const fake = createCatalogFake(() => new Date());
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    let targetCalls = 0;
    let evidenceReadFailed = false;
    let targetFaulted = false;
    const faulted = faultDb(fake.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      const target =
        kind === "prepare"
          ? next?.state === "claimed" && next?.preparation && next?.claim?.stage === "preparing"
          : next?.state === "delivered";
      if (collection === CHANGES && method === "updateOne" && target) {
        targetCalls++;
        if (targetCalls === 1) {
          targetFaulted = true;
          throw new Error("private unresolved mutation");
        }
      }
      if (collection === CHANGES && method === "findOne" && targetFaulted && !evidenceReadFailed) {
        evidenceReadFailed = true;
        throw new Error("private unavailable evidence");
      }
      return run();
    });
    const clock = {
      get now() {
        return Date.now();
      },
    };
    const dispatcher = dispatcherFixture(clock as { now: number });
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(faulted), dispatcher.api as any, {
      now: () => new Date(),
      uuid: uuidSequence(`exact-${kind}`),
      pollMs: 10,
    });
    const flight = notifier.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(targetCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    await flight;

    expect(targetCalls).toBe(2);
    expect(stored(fake, row._id).delivery.state).toBe("delivered");
    expect(dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...testLog.info.mock.calls, ...testLog.warn.mock.calls])).not.toContain("private");
    await notifier.stop();
    vi.useRealTimers();
  });

  it("renews a long turn and serializes preparation behind an in-flight renewal", async () => {
    vi.useFakeTimers({ now: BASE });
    const fake = createCatalogFake(() => new Date());
    const row = change(1, BASE);
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    const renewalEntered = deferred<void>();
    const renewalResume = deferred<void>();
    let holdRenewal = true;
    const gatedDb = faultDb(fake.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (
        holdRenewal &&
        collection === CHANGES &&
        method === "updateOne" &&
        next?.claim?.leaseExpiresAt > new Date(BASE + 100)
      ) {
        holdRenewal = false;
        renewalEntered.resolve();
        await renewalResume.promise;
      }
      return run();
    });
    const clock = {
      get now() {
        return Date.now();
      },
    };
    const dispatcher = dispatcherFixture(clock as { now: number });
    const turn = deferred<ReturnType<typeof makePreparation>>();
    dispatcher.api.prepareCatalogNotification.mockImplementationOnce(async (selectedRow, route) => ({
      kind: "prepared",
      preparation: await turn.promise.then(() => makePreparation(selectedRow, route, "long", new Date())),
    }));
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(gatedDb), dispatcher.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("renew"),
      leaseMs: 100,
      renewMs: 30,
      pollMs: 1_000,
    });
    const flight = notifier.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30);
    await renewalEntered.promise;
    turn.resolve(makePreparation(row, ROUTE_A, "unused", new Date()));
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();

    renewalResume.resolve();
    await flight;

    expect(stored(fake, row._id).delivery.state).toBe("delivered");
    expect(dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(stored(fake, row._id).delivery.version).toBeGreaterThanOrEqual(5);
    await notifier.stop();
    vi.useRealTimers();
  });

  it("rebases a known receipt only after a delayed own-token renewal proves version advancement", async () => {
    vi.useFakeTimers({ now: BASE });
    const renewalEntered = deferred<void>();
    const renewalResume = deferred<void>();
    let holdRenewal = true;
    const fake = createCatalogFake(() => new Date(), {
      afterTimestamp: async ({ collection, update }) => {
        const next = update.$set?.delivery;
        if (
          holdRenewal &&
          collection === CHANGES &&
          next?.state === "claimed" &&
          next?.version === 4 &&
          next?.claim?.stage === "sending"
        ) {
          holdRenewal = false;
          renewalEntered.resolve();
          await renewalResume.promise;
        }
      },
    });
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    let lateRenewal: Promise<any> | undefined;
    let ackInterrupted = false;
    const faulted = faultDb(fake.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (
        collection === CHANGES &&
        method === "updateOne" &&
        next?.state === "claimed" &&
        next?.version === 4 &&
        next?.claim?.stage === "sending"
      ) {
        if (!lateRenewal) {
          lateRenewal = run();
          await renewalEntered.promise;
        }
        throw new Error("private renewal response");
      }
      if (!ackInterrupted && collection === CHANGES && method === "updateOne" && next?.state === "delivered") {
        ackInterrupted = true;
        renewalResume.resolve();
        await lateRenewal;
        throw new Error("private old acknowledgment response");
      }
      return run();
    });
    const clock = {
      get now() {
        return Date.now();
      },
    };
    const dispatcher = dispatcherFixture(clock as { now: number });
    const receipt = deferred<{ kind: "acknowledged"; channelId: string; messageTs: string }>();
    dispatcher.api.sendPreparedCatalogNotification.mockImplementationOnce(async () => receipt.promise);
    const outbox = new ModelCatalogOutbox(faulted);
    const apply = vi.spyOn(outbox, "apply");
    const notifier = new ModelCatalogNotifier(outbox, dispatcher.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("rebase"),
      leaseMs: 100,
      renewMs: 10,
      pollMs: 10,
    });
    const flight = notifier.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    await renewalEntered.promise;
    receipt.resolve({ kind: "acknowledged", channelId: ROUTE_A.channelId, messageTs: "1770000000.654321" });
    await vi.advanceTimersByTimeAsync(90);
    await flight;

    const delivered = stored(fake, row._id);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      version: 5,
      receipt: { messageTs: "1770000000.654321" },
    });
    expect(apply.mock.calls.filter(([transition]) => transition.kind === "ack")).toHaveLength(2);
    expect(dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...testLog.info.mock.calls, ...testLog.warn.mock.calls])).not.toContain("private");
    await notifier.stop();
    vi.useRealTimers();
  });

  it("starts an unreferenced maintenance timer and stop is terminal and idempotent", async () => {
    const fixture = subjectFixture();
    fixture.fake.rows(CHANGES).clear();
    const due = vi.spyOn(fixture.outbox, "due");

    fixture.notifier.start();
    fixture.notifier.start();
    await fixture.notifier.tick();
    const timer = (fixture.notifier as any).timer as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    expect(due).toHaveBeenCalledTimes(1);

    const first = fixture.notifier.stop();
    const same = fixture.notifier.stop();
    expect(same).toBe(first);
    await first;
    fixture.notifier.start();
    await fixture.notifier.tick();
    expect(due).toHaveBeenCalledTimes(1);
  });

  it("starts no store work after the drain when a held turn completes late", async () => {
    const fixture = subjectFixture();
    const held = deferred<ReturnType<typeof makePreparation>>();
    fixture.dispatcher.api.prepareCatalogNotification.mockImplementationOnce(async (row, route) => ({
      kind: "prepared",
      preparation: await held.promise.then(() => makePreparation(row, route, "late", new Date(fixture.clock.now))),
    }));
    const reads = vi.spyOn(fixture.outbox, "read");
    const applies = vi.spyOn(fixture.outbox, "apply");
    const notifier = new ModelCatalogNotifier(fixture.outbox, fixture.dispatcher.api as any, {
      now: () => new Date(fixture.clock.now),
      uuid: uuidSequence("late-stop"),
      drainMs: 10,
    });
    const flight = notifier.tick();
    await vi.waitFor(() => expect(fixture.dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1));

    await notifier.stop();
    const callsAfterDrain = reads.mock.calls.length + applies.mock.calls.length;
    held.resolve(makePreparation(change(), ROUTE_A, "late", new Date(fixture.clock.now)));
    await flight;
    await notifier.tick();

    expect(fixture.dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    expect(reads.mock.calls.length + applies.mock.calls.length).toBe(callsAfterDrain);
  });

  it("may persist an already received Slack receipt while stop drains", async () => {
    const fixture = subjectFixture();
    const receipt = deferred<{ kind: "acknowledged"; channelId: string; messageTs: string }>();
    fixture.dispatcher.api.sendPreparedCatalogNotification.mockImplementationOnce(async () => receipt.promise);
    const flight = fixture.notifier.tick();
    await vi.waitFor(() => expect(fixture.dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1));

    const stopping = fixture.notifier.stop();
    receipt.resolve({ kind: "acknowledged", channelId: ROUTE_A.channelId, messageTs: "1770000000.123456" });
    await stopping;
    await flight;

    expect(stored(fixture.fake, "change-001").delivery).toMatchObject({
      state: "delivered",
      receipt: { channelId: ROUTE_A.channelId, messageTs: "1770000000.123456" },
    });
  });
});
