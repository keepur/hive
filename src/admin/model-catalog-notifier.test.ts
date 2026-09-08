/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

const testLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => testLog }));

import { MAX_NOTICE_DATE_MS, makePreparation, sameBinding, type NoticeRoute } from "./model-catalog-notification.js";
import { ModelCatalogNotifier, NOTIFIER_DEFAULTS } from "./model-catalog-notifier.js";
import { copy, ModelCatalogOutbox, validChange } from "./model-catalog-outbox.js";
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

function immutable(row: CatalogChangeDoc): Omit<CatalogChangeDoc, "delivery"> {
  const value = cloneBson(row) as Partial<CatalogChangeDoc>;
  delete value.delivery;
  return value as Omit<CatalogChangeDoc, "delivery">;
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
      kind: "outcome-unknown",
      reason: "delivery-unconfirmed",
      retryAfterMs: MAX_NOTICE_DATE_MS - fixture.clock.now + 1,
    });
    await fixture.notifier.tick();
    row = stored(fixture.fake, row._id);
    expect(row.delivery).toMatchObject({
      state: "pending",
      attempts: 2,
      retryBlocked: true,
      uncertainSend: true,
      diagnostic: { reason: "retry-deadline-unrepresentable", at: new Date(fixture.clock.now) },
      nextAttemptAt: new Date(fixture.clock.now),
    });
    const attempts = row.delivery.attempts;
    const preparation = copy(row.delivery.preparation!);
    await fixture.notifier.stop();
    fixture.clock.now += NOTIFIER_DEFAULTS.leaseMs + 1;
    const restartedDispatcher = dispatcherFixture(fixture.clock);
    const restarted = new ModelCatalogNotifier(fixture.outbox, restartedDispatcher.api as any, {
      now: () => new Date(fixture.clock.now),
      uuid: uuidSequence("blocked-restart"),
    });
    await restarted.tick();
    expect(stored(fixture.fake, row._id).delivery.attempts).toBe(attempts);
    expect(stored(fixture.fake, row._id).delivery.preparation).toEqual(preparation);
    expect(restartedDispatcher.api.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    await restarted.stop();
  });

  it("persists an accepted retry exactly at the maximum representable Date", async () => {
    const fixture = subjectFixture();
    fixture.dispatcher.api.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "outcome-unknown",
      reason: "delivery-unconfirmed",
      retryAfterMs: MAX_NOTICE_DATE_MS - fixture.clock.now,
    });

    await expect(fixture.notifier.tick()).resolves.toBeUndefined();

    const row = stored(fixture.fake, "change-001");
    expect(row.delivery).toMatchObject({
      state: "pending",
      attempts: 1,
      nextAttemptAt: new Date(MAX_NOTICE_DATE_MS),
      uncertainSend: true,
      preparation: expect.objectContaining({ id: expect.any(String), text: expect.any(String) }),
    });
    expect(row.delivery.retryBlocked).toBeUndefined();
    fixture.clock.now = MAX_NOTICE_DATE_MS - 1;
    await fixture.notifier.tick();
    expect(stored(fixture.fake, row._id).delivery.attempts).toBe(1);
    expect(fixture.dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
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

  it.each([
    { label: "an absent version", version: undefined, expired: false, terminal: "delivered" },
    { label: "an explicit numeric version", version: 7, expired: false, terminal: "pending" },
    { label: "an expired prior claim", version: 4, expired: true, terminal: "delivered" },
  ] as const)("lets only the fresh consumer work after both observe $label", async ({ version, expired, terminal }) => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const row = change();
    row.delivery = {
      ...row.delivery,
      ...(version === undefined ? {} : { version }),
      ...(expired
        ? {
            state: "claimed" as const,
            attempts: 2,
            lastAttemptAt: plus(BASE, -180_000),
            claim: {
              token: "expired-token",
              owner: "expired-owner",
              startedAt: plus(BASE, -180_000),
              leaseExpiresAt: new Date(BASE),
              stage: "preparing" as const,
            },
          }
        : {}),
    };
    expect(validChange(row)).toBe(true);
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    const delayedEntered = deferred<void>();
    const delayedResume = deferred<void>();
    const matched: number[] = [];
    const delayedDb = faultDb(fake.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (
        collection === CHANGES &&
        method === "updateOne" &&
        next?.state === "claimed" &&
        next?.claim?.token === "consumer-b-2"
      ) {
        delayedEntered.resolve();
        await delayedResume.promise;
        const result = await run();
        matched.push(result.matchedCount);
        return result;
      }
      return run();
    });
    const dispatchA = dispatcherFixture(clock);
    const dispatchB = dispatcherFixture(clock);
    if (terminal === "pending") {
      dispatchA.api.sendPreparedCatalogNotification.mockResolvedValueOnce({
        kind: "not-accepted",
        reason: "delivery-unconfirmed",
      });
    }
    const consumerB = new ModelCatalogNotifier(new ModelCatalogOutbox(delayedDb), dispatchB.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("consumer-b"),
    });
    const consumerA = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), dispatchA.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("consumer-a"),
    });

    const delayed = consumerB.tick();
    await delayedEntered.promise;
    await consumerA.tick();
    const survivor = stored(fake, row._id);
    delayedResume.resolve();
    await delayed;

    expect(matched).toEqual([0]);
    expect(stored(fake, row._id)).toEqual(survivor);
    expect(survivor.delivery.state).toBe(terminal);
    expect(immutable(survivor)).toEqual(immutable(row));
    expect(dispatchA.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatchA.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatchB.api.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(dispatchB.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatchB.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    await Promise.all([consumerA.stop(), consumerB.stop()]);
  });

  it("blocks external work after a fake claim installs at its frozen operation time but returns expired", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now), {
      afterTimestamp: async ({ update, serverNow }) => {
        if (update.$set?.delivery?.claim?.token !== "frozen-2") return;
        expect(serverNow).toEqual(new Date(BASE));
        clock.now = BASE + 100;
      },
    });
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    const firstDispatch = dispatcherFixture(clock);
    const first = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), firstDispatch.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("frozen"),
      leaseMs: 100,
    });

    await first.tick();

    const expired = stored(fake, row._id);
    expect(expired.delivery).toMatchObject({
      state: "claimed",
      attempts: 1,
      claim: { token: "frozen-2", leaseExpiresAt: new Date(BASE + 100) },
    });
    expect(firstDispatch.api.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(firstDispatch.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(firstDispatch.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();

    clock.now++;
    const recoveredDispatch = dispatcherFixture(clock);
    const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), recoveredDispatch.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("recovered"),
    });
    await recovered.tick();
    expect(stored(fake, row._id).delivery).toMatchObject({ state: "delivered", attempts: 2 });
    expect(recoveredDispatch.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(recoveredDispatch.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await Promise.all([first.stop(), recovered.stop()]);
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

    const terminalDispatcher = dispatcherFixture(fixture.clock);
    const terminalRestart = new ModelCatalogNotifier(fixture.outbox, terminalDispatcher.api as any, {
      now: () => new Date(fixture.clock.now),
      uuid: uuidSequence("terminal-restart"),
    });
    await terminalRestart.tick();
    expect(terminalDispatcher.api.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(terminalDispatcher.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(terminalDispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    await terminalRestart.stop();
  });

  it.each([
    ["default agent binding", { ...ROUTE_A, agentId: "chief-next", agentName: "Chief Next" }],
    ["home base binding", { ...ROUTE_A, homeBase: "ops-next" }],
    ["adapter binding", { ...ROUTE_A, adapterId: "slack-next" }],
    ["channel binding", { ...ROUTE_A, channelId: "CNEXT12" }],
    ["bot label", { ...ROUTE_A, botLabel: "secondary" }],
  ] as const)("regenerates preparation after the %s changes", async (_label, nextRoute) => {
    const fixture = subjectFixture();
    fixture.dispatcher.api.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "outcome-unknown",
      reason: "delivery-unconfirmed",
    });
    await fixture.notifier.tick();
    const first = stored(fixture.fake, "change-001");
    const oldPreparation = copy(first.delivery.preparation!);
    expect(first.delivery.uncertainSend).toBe(true);
    fixture.clock.now = first.delivery.nextAttemptAt.getTime();
    fixture.dispatcher.setRoute(nextRoute);

    await fixture.notifier.tick();

    const delivered = stored(fixture.fake, first._id);
    expect(fixture.dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(2);
    expect(fixture.dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(2);
    expect(delivered.delivery.preparation?.binding).toEqual({
      agentId: nextRoute.agentId,
      homeBase: nextRoute.homeBase,
      adapterId: nextRoute.adapterId,
      channelId: nextRoute.channelId,
      ...(nextRoute.botLabel === undefined ? {} : { botLabel: nextRoute.botLabel }),
    });
    expect(delivered.delivery.preparation?.id).not.toBe(oldPreparation.id);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      uncertainSend: true,
      receipt: {
        preparationId: delivered.delivery.preparation?.id,
        binding: delivered.delivery.preparation?.binding,
        channelId: nextRoute.channelId,
      },
    });
    fixture.dispatcher.setRoute(ROUTE_B);
    await fixture.notifier.tick();
    expect(fixture.dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(2);
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

  it("records a returned receipt against the posted preparation when the default changes in flight", async () => {
    const fixture = subjectFixture();
    const receipt = deferred<{ kind: "acknowledged"; channelId: string; messageTs: string }>();
    fixture.dispatcher.api.sendPreparedCatalogNotification.mockImplementationOnce(async () => receipt.promise);
    const flight = fixture.notifier.tick();
    await vi.waitFor(() => expect(fixture.dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1));
    const posted = copy(fixture.dispatcher.api.sendPreparedCatalogNotification.mock.calls[0]![0]);

    fixture.dispatcher.setRoute(ROUTE_B);
    receipt.resolve({ kind: "acknowledged", channelId: ROUTE_A.channelId, messageTs: "1770000000.777777" });
    await flight;

    const delivered = stored(fixture.fake, "change-001");
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      preparation: posted,
      receipt: {
        preparationId: posted.id,
        binding: posted.binding,
        channelId: ROUTE_A.channelId,
        messageTs: "1770000000.777777",
      },
    });
    expect(fixture.dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(fixture.dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await fixture.notifier.stop();
  });

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

  it("leaves every BSON falsey preparation and preparing send intent untouched in actual candidate work", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const before = new Map<string, CatalogChangeDoc>();
    const falsey = [null, false, 0, "", []] as const;
    for (const [offset, value] of falsey.entries()) {
      const prepared = change(offset + 1);
      (prepared.delivery as any).preparation = value;
      fake.rows(CHANGES).set(prepared._id, cloneBson(prepared));
      before.set(prepared._id, cloneBson(prepared));

      const intent = change(offset + 11);
      intent.delivery = {
        state: "claimed",
        attempts: 1,
        nextAttemptAt: plus(BASE, -60_000),
        version: 2,
        lastAttemptAt: plus(BASE, -120_000),
        claim: {
          token: `intent-${offset}`,
          owner: "prior-owner",
          startedAt: plus(BASE, -120_000),
          leaseExpiresAt: plus(BASE, -1),
          stage: "preparing",
          sendIntent: value as never,
        },
      };
      fake.rows(CHANGES).set(intent._id, cloneBson(intent));
      before.set(intent._id, cloneBson(intent));
    }
    const undefinedPreparation = change(30);
    (undefinedPreparation.delivery as any).preparation = undefined;
    const undefinedIntent = change(31);
    undefinedIntent.delivery = {
      state: "claimed",
      attempts: 1,
      nextAttemptAt: plus(BASE, -1),
      claim: {
        token: "undefined-intent",
        owner: "prior-owner",
        startedAt: plus(BASE, -120_000),
        leaseExpiresAt: plus(BASE, -1),
        stage: "preparing",
        sendIntent: undefined as never,
      },
    };
    expect(validChange(undefinedPreparation)).toBe(false);
    expect(validChange(undefinedIntent)).toBe(false);

    const dispatcher = dispatcherFixture(clock);
    const outbox = new ModelCatalogOutbox(fake.db);
    const apply = vi.spyOn(outbox, "apply");
    const notifier = new ModelCatalogNotifier(outbox, dispatcher.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("falsey"),
    });
    await notifier.tick();

    expect(apply).not.toHaveBeenCalled();
    expect(dispatcher.api.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(dispatcher.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    for (const [rowId, original] of before) {
      const actual = stored(fake, rowId);
      expect(validChange(actual), rowId).toBe(false);
      expect(actual, rowId).toEqual(original);
    }
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

  it.each([
    { label: "the token appears", applyBeforeThrow: true, readUnavailable: false },
    { label: "the evidence read is negative", applyBeforeThrow: false, readUnavailable: false },
    { label: "the evidence read is unavailable", applyBeforeThrow: false, readUnavailable: true },
  ])(
    "never turns an uncertain acquisition into permission when $label",
    async ({ applyBeforeThrow, readUnavailable }) => {
      const row = change();
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      fake.rows(CHANGES).set(row._id, cloneBson(row));
      let thrown = false;
      const uncertainDb = faultDb(fake.db, async (collection, method, args, run) => {
        const next = args[1]?.$set?.delivery;
        if (collection === CHANGES && method === "findOne" && thrown && readUnavailable) {
          throw new Error("secret acquisition evidence");
        }
        if (!thrown && collection === CHANGES && method === "updateOne" && next?.state === "claimed") {
          thrown = true;
          if (applyBeforeThrow) await run();
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
      await vi.waitFor(() => expect(thrown).toBe(true));

      await notifier.stop();
      await flight;

      expect(dispatcher.api.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
      expect(dispatcher.api.prepareCatalogNotification).not.toHaveBeenCalled();
      expect(dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
      const uncertain = stored(fake, row._id);
      expect(uncertain.delivery.state).toBe(applyBeforeThrow ? "claimed" : "pending");
      expect(immutable(uncertain)).toEqual(immutable(row));

      clock.now += 20_001;
      const recoveredDispatch = dispatcherFixture(clock);
      const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), recoveredDispatch.api as any, {
        now: () => new Date(clock.now),
        uuid: uuidSequence("fresh-token"),
      });
      await recovered.tick();
      expect(stored(fake, row._id).delivery).toMatchObject({
        state: "delivered",
        attempts: applyBeforeThrow ? 2 : 1,
        receipt: { preparationId: expect.any(String) },
      });
      expect(recoveredDispatch.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
      expect(recoveredDispatch.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("secret");
      await recovered.stop();
    },
  );

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

  it("resends only the exact persisted preparation after a crash loses durable acknowledgment", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    const ackEntered = deferred<void>();
    const crashDb = faultDb(fake.db, async (collection, method, args, run) => {
      if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.state === "delivered") {
        ackEntered.resolve();
        throw new Error("private lost acknowledgment");
      }
      return run();
    });
    const firstDispatch = dispatcherFixture(clock);
    const first = new ModelCatalogNotifier(new ModelCatalogOutbox(crashDb), firstDispatch.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("crashed"),
      leaseMs: 100,
      pollMs: 1_000,
      drainMs: 100,
    });
    const flight = first.tick();
    await ackEntered.promise;
    await first.stop();
    await flight;

    const stranded = stored(fake, row._id);
    const preparation = copy(stranded.delivery.preparation!);
    expect(stranded.delivery).toMatchObject({
      state: "claimed",
      attempts: 1,
      claim: {
        stage: "sending",
        sendIntent: { preparationId: preparation.id },
      },
    });
    expect(firstDispatch.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(firstDispatch.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    clock.now = stranded.delivery.claim!.leaseExpiresAt.getTime() + 1;
    const recoveredDispatch = dispatcherFixture(clock);
    const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), recoveredDispatch.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("after-crash"),
    });
    await recovered.tick();

    const delivered = stored(fake, row._id);
    expect(recoveredDispatch.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(recoveredDispatch.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(recoveredDispatch.api.sendPreparedCatalogNotification.mock.calls[0]![0]).toEqual(preparation);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      attempts: 2,
      preparation,
      uncertainSend: true,
      receipt: {
        preparationId: preparation.id,
        binding: preparation.binding,
        channelId: preparation.binding.channelId,
      },
    });
    expect(immutable(delivered)).toEqual(immutable(row));
    expect(
      firstDispatch.api.sendPreparedCatalogNotification.mock.calls.length +
        recoveredDispatch.api.sendPreparedCatalogNotification.mock.calls.length,
    ).toBe(2);
    expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
    await recovered.stop();
  });

  it("keeps a known receipt while a delayed acknowledgment applies before its exact retry", async () => {
    vi.useFakeTimers({ now: BASE });
    const delayedEntered = deferred<void>();
    const delayedResume = deferred<void>();
    let holdFirst = true;
    const fake = createCatalogFake(() => new Date(), {
      afterTimestamp: async ({ collection, update }) => {
        if (holdFirst && collection === CHANGES && update.$set?.delivery?.state === "delivered") {
          holdFirst = false;
          delayedEntered.resolve();
          await delayedResume.promise;
        }
      },
    });
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    let ackCalls = 0;
    let delayedAck: Promise<any> | undefined;
    const matched: number[] = [];
    const faultedDb = faultDb(fake.db, async (collection, method, args, run) => {
      if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.state === "delivered") {
        ackCalls++;
        if (ackCalls === 1) {
          delayedAck = run();
          await delayedEntered.promise;
          throw new Error("private first ack response");
        }
        delayedResume.resolve();
        const first = await delayedAck!;
        matched.push(first.matchedCount);
        const second = await run();
        matched.push(second.matchedCount);
        return second;
      }
      return run();
    });
    const clock = {
      get now() {
        return Date.now();
      },
    };
    const dispatcher = dispatcherFixture(clock as { now: number });
    const notifier = new ModelCatalogNotifier(new ModelCatalogOutbox(faultedDb), dispatcher.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("delayed-ack"),
      pollMs: 10,
    });
    const flight = notifier.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(ackCalls).toBe(1);
    expect(dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    await flight;

    const delivered = stored(fake, row._id);
    expect(matched).toEqual([1, 0]);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      receipt: {
        preparationId: delivered.delivery.preparation?.id,
        binding: delivered.delivery.preparation?.binding,
      },
    });
    expect(dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatcher.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
    await notifier.stop();
    vi.useRealTimers();
  });

  it("settles a stale known receipt after a successor releases a newer pending state", async () => {
    vi.useFakeTimers({ now: BASE });
    const delayedEntered = deferred<void>();
    const delayedResume = deferred<void>();
    let holdAck = true;
    const fake = createCatalogFake(() => new Date(), {
      afterTimestamp: async ({ collection, update }) => {
        if (holdAck && collection === CHANGES && update.$set?.delivery?.state === "delivered") {
          holdAck = false;
          delayedEntered.resolve();
          await delayedResume.promise;
        }
      },
    });
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    let ackFaulted = false;
    let delayedAck: Promise<any> | undefined;
    const faultedDb = faultDb(fake.db, async (collection, method, args, run) => {
      if (
        !ackFaulted &&
        collection === CHANGES &&
        method === "updateOne" &&
        args[1]?.$set?.delivery?.state === "delivered"
      ) {
        delayedAck = run();
        await delayedEntered.promise;
        ackFaulted = true;
        throw new Error("private stale ack response");
      }
      return run();
    });
    const clock = {
      get now() {
        return Date.now();
      },
    };
    const dispatchA = dispatcherFixture(clock as { now: number });
    const notifierA = new ModelCatalogNotifier(new ModelCatalogOutbox(faultedDb), dispatchA.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("ack-a"),
      leaseMs: 100,
      renewMs: 1_000,
      pollMs: 10,
    });
    const flightA = notifierA.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(ackFaulted).toBe(true);
    expect(dispatchA.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    const preparation = copy(stored(fake, row._id).delivery.preparation!);

    vi.setSystemTime(BASE + 101);
    const dispatchB = dispatcherFixture(clock as { now: number });
    dispatchB.api.sendPreparedCatalogNotification.mockResolvedValueOnce({
      kind: "not-accepted",
      reason: "delivery-unconfirmed",
    });
    const notifierB = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), dispatchB.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("ack-b"),
    });
    await notifierB.tick();
    const pendingSuccessor = stored(fake, row._id);
    expect(pendingSuccessor.delivery).toMatchObject({
      state: "pending",
      attempts: 2,
      preparation,
      uncertainSend: true,
    });
    expect(pendingSuccessor.delivery.claim).toBeUndefined();
    expect(dispatchB.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatchB.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    await flightA;
    delayedResume.resolve();
    expect(await delayedAck!).toMatchObject({ matchedCount: 0 });
    expect(stored(fake, row._id)).toEqual(pendingSuccessor);
    expect(dispatchA.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    vi.setSystemTime(pendingSuccessor.delivery.nextAttemptAt);
    const dispatchC = dispatcherFixture(clock as { now: number });
    const notifierC = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), dispatchC.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("ack-c"),
    });
    await notifierC.tick();
    const delivered = stored(fake, row._id);
    expect(delivered.delivery).toMatchObject({
      state: "delivered",
      attempts: 3,
      preparation,
      uncertainSend: true,
      receipt: { preparationId: preparation.id, binding: preparation.binding },
    });
    expect(dispatchC.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatchC.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    expect(immutable(delivered)).toEqual(immutable(row));
    expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
    await Promise.all([notifierA.stop(), notifierB.stop(), notifierC.stop()]);
    vi.useRealTimers();
  });

  it.each([
    { label: "an unexecuted predecessor with negative evidence", persisted: false },
    { label: "a persisted predecessor with unavailable evidence", persisted: true },
  ])("lets a fresh owner recover after uncertain preparation from $label", async ({ persisted }) => {
    vi.useFakeTimers({ now: BASE });
    const delayedEntered = deferred<void>();
    const delayedResume = deferred<void>();
    let holdDelayed = !persisted;
    const fake = createCatalogFake(() => new Date(), {
      afterTimestamp: async ({ collection, update }) => {
        const next = update.$set?.delivery;
        if (
          holdDelayed &&
          collection === CHANGES &&
          next?.state === "claimed" &&
          next?.claim?.token === "prep-a-2" &&
          next?.preparation
        ) {
          holdDelayed = false;
          delayedEntered.resolve();
          await delayedResume.promise;
        }
      },
    });
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    let firstTarget = true;
    let faulted = false;
    let delayedMutation: Promise<any> | undefined;
    const faultedDb = faultDb(fake.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      const target =
        collection === CHANGES &&
        method === "updateOne" &&
        next?.state === "claimed" &&
        next?.claim?.token === "prep-a-2" &&
        next?.preparation;
      if (collection === CHANGES && method === "findOne" && faulted && persisted) {
        throw new Error("private preparation evidence");
      }
      if (target && firstTarget) {
        firstTarget = false;
        if (persisted) await run();
        else {
          delayedMutation = run();
          await delayedEntered.promise;
        }
        faulted = true;
        throw new Error("private preparation response");
      }
      return run();
    });
    const clock = {
      get now() {
        return Date.now();
      },
    };
    const dispatchA = dispatcherFixture(clock as { now: number });
    const notifierA = new ModelCatalogNotifier(new ModelCatalogOutbox(faultedDb), dispatchA.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("prep-a"),
      leaseMs: 100,
      renewMs: 1_000,
      pollMs: 1_000,
    });
    const flightA = notifierA.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(faulted).toBe(true);
    expect(dispatchA.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatchA.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();

    vi.setSystemTime(BASE + 101);
    const dispatchB = dispatcherFixture(clock as { now: number });
    const notifierB = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), dispatchB.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("prep-b"),
    });
    await notifierB.tick();
    const successor = stored(fake, row._id);
    expect(successor.delivery.state).toBe("delivered");
    expect(dispatchB.api.prepareCatalogNotification).toHaveBeenCalledTimes(persisted ? 0 : 1);
    expect(dispatchB.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

    if (delayedMutation) {
      delayedResume.resolve();
      expect(await delayedMutation).toMatchObject({ matchedCount: 0 });
    }
    await vi.advanceTimersByTimeAsync(100);
    await flightA;
    expect(stored(fake, row._id)).toEqual(successor);
    expect(immutable(successor)).toEqual(immutable(row));
    expect(dispatchA.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatchA.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
    await Promise.all([notifierA.stop(), notifierB.stop()]);
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

  it("advances repeated leases monotonically and keeps a competitor out past the original lease", async () => {
    vi.useFakeTimers({ now: BASE });
    const fake = createCatalogFake(() => new Date());
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    const clock = {
      get now() {
        return Date.now();
      },
    };
    const dispatchA = dispatcherFixture(clock as { now: number });
    const turn = deferred<void>();
    dispatchA.api.prepareCatalogNotification.mockImplementationOnce(async (selected, route) => {
      await turn.promise;
      return {
        kind: "prepared",
        preparation: makePreparation(selected, route, "long turn", new Date()),
      };
    });
    const notifierA = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), dispatchA.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("renewing-a"),
      leaseMs: 100,
      renewMs: 30,
      pollMs: 1_000,
    });
    const flight = notifierA.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchA.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    const leases = [stored(fake, row._id).delivery.claim!.leaseExpiresAt.getTime()];

    for (let renewal = 0; renewal < 4; renewal++) {
      await vi.advanceTimersByTimeAsync(30);
      leases.push(stored(fake, row._id).delivery.claim!.leaseExpiresAt.getTime());
    }
    expect(leases.every((lease, index) => index === 0 || lease > leases[index - 1]!)).toBe(true);
    expect(Date.now()).toBeGreaterThan(BASE + 100);

    const dispatchB = dispatcherFixture(clock as { now: number });
    const notifierB = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), dispatchB.api as any, {
      now: () => new Date(),
      uuid: uuidSequence("renewing-b"),
    });
    await notifierB.tick();
    expect(dispatchB.api.resolveCatalogNotificationRoute).not.toHaveBeenCalled();
    expect(dispatchB.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatchB.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();

    turn.resolve();
    await flight;
    expect(stored(fake, row._id).delivery.state).toBe("delivered");
    expect(dispatchA.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatchA.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await Promise.all([notifierA.stop(), notifierB.stop()]);
    vi.useRealTimers();
  });

  it.each([
    {
      label: "a pre-application throw and negative read",
      applyBeforeThrow: false,
      readUnavailable: false,
      successorState: "delivered",
    },
    {
      label: "a pre-application throw and unavailable read",
      applyBeforeThrow: false,
      readUnavailable: true,
      successorState: "pending",
    },
    {
      label: "a post-application throw and unavailable read",
      applyBeforeThrow: true,
      readUnavailable: true,
      successorState: "delivered",
    },
  ] as const)(
    "starts no later stage after uncertain renewal from $label",
    async ({ applyBeforeThrow, readUnavailable, successorState }) => {
      vi.useFakeTimers({ now: BASE });
      const fake = createCatalogFake(() => new Date());
      const row = change();
      fake.rows(CHANGES).set(row._id, cloneBson(row));
      let renewalFaulted = false;
      let renewalCalls = 0;
      const faultedDb = faultDb(fake.db, async (collection, method, args, run) => {
        const next = args[1]?.$set?.delivery;
        const target =
          collection === CHANGES &&
          method === "updateOne" &&
          next?.state === "claimed" &&
          next?.claim?.token === "renew-a-2" &&
          next?.version === 2;
        if (collection === CHANGES && method === "findOne" && renewalFaulted && readUnavailable) {
          throw new Error("private renewal evidence");
        }
        if (target) {
          renewalCalls++;
          if (!renewalFaulted && applyBeforeThrow) await run();
          renewalFaulted = true;
          throw new Error("private renewal response");
        }
        return run();
      });
      const clock = {
        get now() {
          return Date.now();
        },
      };
      const dispatchA = dispatcherFixture(clock as { now: number });
      const turn = deferred<void>();
      dispatchA.api.prepareCatalogNotification.mockImplementationOnce(async (selected, route) => {
        await turn.promise;
        return {
          kind: "prepared",
          preparation: makePreparation(selected, route, "old owner turn", new Date()),
        };
      });
      const notifierA = new ModelCatalogNotifier(new ModelCatalogOutbox(faultedDb), dispatchA.api as any, {
        now: () => new Date(),
        uuid: uuidSequence("renew-a"),
        leaseMs: 100,
        renewMs: 30,
        pollMs: 1_000,
      });
      const flightA = notifierA.tick();
      await vi.advanceTimersByTimeAsync(30);
      expect(renewalFaulted).toBe(true);
      expect(renewalCalls).toBe(1);
      expect(dispatchA.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
      expect(dispatchA.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();

      const uncertain = stored(fake, row._id);
      const successorAt = uncertain.delivery.claim!.leaseExpiresAt.getTime() + 1;
      vi.setSystemTime(successorAt);
      const dispatchB = dispatcherFixture(clock as { now: number });
      if (successorState === "pending") {
        dispatchB.api.sendPreparedCatalogNotification.mockResolvedValueOnce({
          kind: "not-accepted",
          reason: "delivery-unconfirmed",
        });
      }
      const notifierB = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), dispatchB.api as any, {
        now: () => new Date(),
        uuid: uuidSequence("renew-b"),
      });
      await notifierB.tick();
      const successor = stored(fake, row._id);
      expect(successor.delivery.state).toBe(successorState);
      expect(dispatchB.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
      expect(dispatchB.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      turn.resolve();
      await flightA;
      expect(stored(fake, row._id)).toEqual(successor);
      expect(immutable(successor)).toEqual(immutable(row));
      expect(dispatchA.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
      expect(dispatchA.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
      expect(JSON.stringify(testLog.warn.mock.calls)).not.toContain("private");
      await Promise.all([notifierA.stop(), notifierB.stop()]);
      vi.useRealTimers();
    },
  );

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

  it.each(["index", "due", "claim", "lookup", "prepare", "send-intent"] as const)(
    "stops within the drain bound during a held %s stage and starts no following stage",
    async (stage) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      const row = change();
      fake.rows(CHANGES).set(row._id, cloneBson(row));
      const entered = deferred<void>();
      const resume = deferred<void>();
      let held = false;
      const gatedDb = faultDb(fake.db, async (collection, method, args, run) => {
        const next = args[1]?.$set?.delivery;
        const target =
          (stage === "index" && method === "createIndex") ||
          (stage === "due" && method === "find") ||
          (stage === "claim" && method === "updateOne" && next?.state === "claimed" && next?.version === 1) ||
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
      const dispatcher = dispatcherFixture(clock);
      if (stage === "lookup") {
        dispatcher.api.resolveCatalogNotificationRoute.mockImplementationOnce(async (gate) => {
          expect(await gate.check()).toBe(true);
          held = true;
          entered.resolve();
          await resume.promise;
          return { kind: "route", route: copy(ROUTE_A) } as const;
        });
      }
      const notifier = new ModelCatalogNotifier(outbox, dispatcher.api as any, {
        now: () => new Date(clock.now),
        uuid: uuidSequence(`stop-${stage}`),
        leaseMs: 100,
        renewMs: 1_000,
        drainMs: 10,
      });
      const flight = notifier.tick();
      await entered.promise;

      const started = Date.now();
      await notifier.stop();
      expect(Date.now() - started).toBeLessThan(5_000);
      const callsAtDrain = storeCalls();
      resume.resolve();
      await flight;

      expect(storeCalls()).toBe(callsAtDrain);
      expect(dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(
        stage === "prepare" || stage === "send-intent" ? 1 : 0,
      );
      expect(dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
      const stranded = stored(fake, row._id);
      expect(immutable(stranded)).toEqual(immutable(row));

      clock.now += 101;
      const recoveredDispatch = dispatcherFixture(clock);
      const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), recoveredDispatch.api as any, {
        now: () => new Date(clock.now),
        uuid: uuidSequence(`recover-${stage}`),
      });
      await recovered.tick();
      expect(stored(fake, row._id).delivery.state).toBe("delivered");
      expect(recoveredDispatch.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
      await recovered.stop();
    },
  );

  it("closes the store while the lookup ownership gate DB read is held", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    const entered = deferred<void>();
    const resume = deferred<void>();
    let gateReadArmed = false;
    let held = false;
    const gatedDb = faultDb(fake.db, async (collection, method, _args, run) => {
      if (gateReadArmed && !held && collection === CHANGES && method === "findOne") {
        held = true;
        entered.resolve();
        await resume.promise;
      }
      return run();
    });
    const outbox = new ModelCatalogOutbox(gatedDb);
    const reads = vi.spyOn(outbox, "read");
    const applies = vi.spyOn(outbox, "apply");
    const dispatcher = dispatcherFixture(clock);
    dispatcher.api.resolveCatalogNotificationRoute.mockImplementationOnce(async (gate) => {
      gateReadArmed = true;
      return (await gate.check()) && gate.current()
        ? ({ kind: "route", route: copy(ROUTE_A) } as const)
        : ({ kind: "unresolved", reason: "recipient-changed" } as const);
    });
    const notifier = new ModelCatalogNotifier(outbox, dispatcher.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("gate-stop"),
      leaseMs: 100,
      drainMs: 10,
    });
    const flight = notifier.tick();
    await entered.promise;

    await notifier.stop();
    const callsAtDrain = reads.mock.calls.length + applies.mock.calls.length;
    resume.resolve();
    await flight;

    expect(reads.mock.calls.length + applies.mock.calls.length).toBe(callsAtDrain);
    expect(dispatcher.api.prepareCatalogNotification).not.toHaveBeenCalled();
    expect(dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    clock.now += 101;
    const recoveredDispatch = dispatcherFixture(clock);
    const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), recoveredDispatch.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("gate-recovery"),
    });
    await recovered.tick();
    expect(stored(fake, row._id).delivery.state).toBe("delivered");
    await recovered.stop();
  });

  it("observes an in-flight renewal through bounded stop and starts no later external stage", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const row = change();
    fake.rows(CHANGES).set(row._id, cloneBson(row));
    const entered = deferred<void>();
    const resume = deferred<void>();
    let held = false;
    const gatedDb = faultDb(fake.db, async (collection, method, args, run) => {
      const next = args[1]?.$set?.delivery;
      if (
        !held &&
        collection === CHANGES &&
        method === "updateOne" &&
        next?.state === "claimed" &&
        next?.claim?.token === "renew-stop-2" &&
        next?.version === 2
      ) {
        held = true;
        entered.resolve();
        await resume.promise;
      }
      return run();
    });
    const outbox = new ModelCatalogOutbox(gatedDb);
    const reads = vi.spyOn(outbox, "read");
    const applies = vi.spyOn(outbox, "apply");
    const dispatcher = dispatcherFixture(clock);
    const turn = deferred<void>();
    dispatcher.api.prepareCatalogNotification.mockImplementationOnce(async (selected, route) => {
      await turn.promise;
      return {
        kind: "prepared",
        preparation: makePreparation(selected, route, "late renewal turn", new Date(clock.now)),
      };
    });
    const notifier = new ModelCatalogNotifier(outbox, dispatcher.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("renew-stop"),
      leaseMs: 100,
      renewMs: 5,
      drainMs: 10,
    });
    const flight = notifier.tick();
    await entered.promise;

    await notifier.stop();
    const callsAtDrain = reads.mock.calls.length + applies.mock.calls.length;
    resume.resolve();
    turn.resolve();
    await flight;

    expect(reads.mock.calls.length + applies.mock.calls.length).toBe(callsAtDrain);
    expect(dispatcher.api.prepareCatalogNotification).toHaveBeenCalledTimes(1);
    expect(dispatcher.api.sendPreparedCatalogNotification).not.toHaveBeenCalled();
    const stranded = stored(fake, row._id);
    clock.now = stranded.delivery.claim!.leaseExpiresAt.getTime() + 1;
    const recoveredDispatch = dispatcherFixture(clock);
    const recovered = new ModelCatalogNotifier(new ModelCatalogOutbox(fake.db), recoveredDispatch.api as any, {
      now: () => new Date(clock.now),
      uuid: uuidSequence("renew-stop-recovery"),
    });
    await recovered.tick();
    expect(stored(fake, row._id).delivery.state).toBe("delivered");
    expect(recoveredDispatch.api.sendPreparedCatalogNotification).toHaveBeenCalledTimes(1);
    await recovered.stop();
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
