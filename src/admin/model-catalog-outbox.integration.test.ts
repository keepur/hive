/* eslint-disable @typescript-eslint/no-explicit-any */
import { BSON, type CommandStartedEvent } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guardDb, WriteGuard } from "../db/write-guard.js";
import { JOURNALED } from "./model-catalog-export.js";
import { makePreparation, type ChangeDelivery, type NoticePreparation } from "./model-catalog-notification.js";
import {
  ModelCatalogOutbox,
  copy,
  transition,
  validChange,
  type MutationKind,
  type Transition,
} from "./model-catalog-outbox.js";
import { ModelCatalogStore } from "./model-catalog-store.js";
import type { CatalogChangeDoc } from "./model-catalog-types.js";
import { cloneBson, createCatalogFake, deferred, faultDb, type Row } from "./testing/catalog-db.test-support.js";
import { startStandaloneMongo } from "./testing/standalone-mongo.js";

const CATALOG = "agent_model_catalog";
const VERSIONS = "agent_model_catalog_versions";
const CHANGES = "agent_model_catalog_changes";

let mongo: Awaited<ReturnType<typeof startStandaloneMongo>>;
let commands: CommandStartedEvent[] = [];

const plus = (date: Date, milliseconds: number) => new Date(date.getTime() + milliseconds);
const id = (number: number) => `outbox-${String(number).padStart(3, "0")}`;

function pending(now: Date, version?: number): ChangeDelivery {
  return {
    state: "pending",
    attempts: 0,
    nextAttemptAt: plus(now, -60_000),
    ...(version === undefined ? {} : { version }),
  };
}

function change(now: Date, delivery: ChangeDelivery = pending(now), number = 1): CatalogChangeDoc {
  return {
    _id: id(number),
    provider: "codex",
    revision: number,
    snapshotId: `snapshot-${number}`,
    createdAt: plus(now, -120_000 + number),
    source: "manual",
    updatedBy: "integration-operator",
    modelCount: 2,
    bootstrap: number === 1,
    added: [`model-${number}`],
    removed: ["old-model"],
    delivery: copy(delivery),
  };
}

function claimDelivery(
  row: CatalogChangeDoc,
  now: Date,
  token = "token-a",
  leaseExpiresAt = plus(now, 120_000),
): ChangeDelivery {
  return {
    ...copy(row.delivery),
    state: "claimed",
    attempts: row.delivery.attempts + 1,
    lastAttemptAt: new Date(now),
    claim: {
      token,
      owner: `worker-${token}`,
      startedAt: new Date(now),
      leaseExpiresAt: new Date(leaseExpiresAt),
      stage: "preparing",
    },
  };
}

function preparation(row: CatalogChangeDoc, now: Date, label = "a"): NoticePreparation {
  return makePreparation(
    row,
    {
      agentId: `chief-${label}`,
      agentName: `Chief ${label}`,
      homeBase: `ops-${label}`,
      adapterId: "slack",
      channelId: `C${label.toUpperCase()}1234`,
    },
    `Processed by ${label}.`,
    plus(now, 1_000),
  );
}

function preparedDelivery(row: CatalogChangeDoc, now: Date, label = "a"): ChangeDelivery {
  return { ...copy(row.delivery), preparation: preparation(row, now, label) };
}

function sendingDelivery(row: CatalogChangeDoc, now: Date): ChangeDelivery {
  const prepared = row.delivery.preparation!;
  return {
    ...copy(row.delivery),
    claim: {
      ...copy(row.delivery.claim!),
      stage: "sending",
      sendIntent: {
        preparationId: prepared.id,
        startedAt: plus(now, 2_000),
        previouslyUncertain: Boolean(row.delivery.uncertainSend),
      },
    },
  };
}

function releaseDelivery(row: CatalogChangeDoc, now: Date): ChangeDelivery {
  const next = copy(row.delivery);
  delete next.claim;
  delete next.receipt;
  return {
    ...next,
    state: "pending",
    nextAttemptAt: plus(now, 300_000),
    diagnostic: { reason: "delivery-unconfirmed", at: plus(now, 3_000) },
    uncertainSend: Boolean(row.delivery.claim?.sendIntent),
  };
}

function deliveredDelivery(row: CatalogChangeDoc, now: Date): ChangeDelivery {
  const next = copy(row.delivery);
  delete next.claim;
  const prepared = row.delivery.preparation!;
  return {
    ...next,
    state: "delivered",
    receipt: {
      preparationId: prepared.id,
      binding: copy(prepared.binding),
      channelId: prepared.binding.channelId,
      messageTs: `${Math.floor(now.getTime() / 1_000)}.123456`,
      acknowledgedAt: plus(now, 3_000),
    },
  };
}

function mutationFixture(kind: MutationKind, now: Date, number = 1): Transition {
  const first = change(now, pending(now), number);
  if (kind === "claim") return transition("claim", first, claimDelivery(first, now), now, false);
  const claimed = transition("claim", first, claimDelivery(first, now), now, false).after;
  if (kind === "renew") {
    return transition(
      "renew",
      claimed,
      {
        ...copy(claimed.delivery),
        claim: { ...copy(claimed.delivery.claim!), leaseExpiresAt: plus(now, 180_000) },
      },
      plus(now, 30_000),
      true,
    );
  }
  if (kind === "prepare") {
    return transition("prepare", claimed, preparedDelivery(claimed, now), plus(now, 10_000), true);
  }
  const prepared = transition("prepare", claimed, preparedDelivery(claimed, now), plus(now, 10_000), true).after;
  if (kind === "send-intent") {
    return transition("send-intent", prepared, sendingDelivery(prepared, now), plus(now, 20_000), true);
  }
  const sending = transition("send-intent", prepared, sendingDelivery(prepared, now), plus(now, 20_000), true).after;
  if (kind === "release") {
    return transition("release", sending, releaseDelivery(sending, now), plus(now, 30_000), false);
  }
  return transition("ack", sending, deliveredDelivery(sending, now), plus(now, 180_000), false);
}

async function serverNow(): Promise<Date> {
  return (await mongo.db.admin().command({ hello: 1 })).localTime;
}

async function resetDatabase(): Promise<void> {
  expect(mongo.db.databaseName).toMatch(/^hive_kpr459_test_/);
  await mongo.db.dropDatabase();
  commands = [];
}

async function seed(row: CatalogChangeDoc | Row): Promise<void> {
  await mongo.db.collection(CHANGES).insertOne(copy(row), JOURNALED);
}

async function stored(idValue: string): Promise<CatalogChangeDoc> {
  const row = await mongo.db.collection<CatalogChangeDoc>(CHANGES).findOne({ _id: idValue });
  if (!row) throw new Error("missing integration fixture");
  return row;
}

async function applied(outbox: ModelCatalogOutbox, mutation: Transition): Promise<CatalogChangeDoc> {
  const result = await outbox.apply(mutation);
  if (result.kind !== "applied") throw new Error(`expected applied ${mutation.kind}, received ${result.kind}`);
  return result.row;
}

async function claim(
  outbox: ModelCatalogOutbox,
  row: CatalogChangeDoc,
  now: Date,
  token: string,
): Promise<CatalogChangeDoc> {
  return applied(outbox, transition("claim", row, claimDelivery(row, now, token), now, false));
}

async function prepareAndDeliver(
  outbox: ModelCatalogOutbox,
  row: CatalogChangeDoc,
  now: Date,
  label = "a",
): Promise<CatalogChangeDoc> {
  const prepared = await applied(outbox, transition("prepare", row, preparedDelivery(row, now, label), now, true));
  const sending = await applied(outbox, transition("send-intent", prepared, sendingDelivery(prepared, now), now, true));
  return applied(outbox, transition("ack", sending, deliveredDelivery(sending, now), now, false));
}

function immutableBytes(row: CatalogChangeDoc): Buffer {
  const immutable = copy(row) as Partial<CatalogChangeDoc>;
  delete immutable.delivery;
  return BSON.serialize(immutable);
}

const statusProjection = {
  _id: 1,
  provider: 1,
  createdAt: 1,
  delivery: {
    $cond: [
      { $eq: [{ $type: "$delivery" }, "object"] },
      {
        ...Object.fromEntries(
          [
            "state",
            "attempts",
            "version",
            "nextAttemptAt",
            "lastAttemptAt",
            "claim",
            "receipt",
            "uncertainSend",
            "diagnostic",
            "retryBlocked",
          ].map((key) => [key, `$delivery.${key}`]),
        ),
        preparation: {
          $cond: [
            { $eq: [{ $type: "$delivery.preparation" }, "object"] },
            {
              id: "$delivery.preparation.id",
              binding: "$delivery.preparation.binding",
              processedAt: "$delivery.preparation.processedAt",
            },
            "$delivery.preparation",
          ],
        },
      },
      "$delivery",
    ],
  },
};

beforeAll(async () => {
  mongo = await startStandaloneMongo();
  mongo.client.on("commandStarted", (event) => commands.push(event));
}, 30_000);

afterAll(async () => {
  await mongo?.close();
}, 30_000);

beforeEach(resetDatabase, 30_000);

describe("standalone model catalog outbox", () => {
  it("emits journaled state/index commands and no forbidden persistence mechanisms", async () => {
    const now = await serverNow();
    const outbox = new ModelCatalogOutbox(mongo.db);
    await outbox.ensureIndexes();
    for (const [index, kind] of (["claim", "renew", "prepare", "send-intent", "release", "ack"] as const).entries()) {
      const mutation = mutationFixture(kind, now, index + 1);
      await seed(mutation.before);
      expect(await outbox.apply(mutation)).toMatchObject({ kind: "applied", source: "ack" });
    }

    const writes = commands.filter(
      ({ commandName, command }) =>
        (commandName === "update" && command.update === CHANGES) ||
        (commandName === "createIndexes" && command.createIndexes === CHANGES),
    );
    expect(writes).toHaveLength(8);
    for (const event of writes) {
      expect(event.command.writeConcern).toEqual(expect.objectContaining({ w: 1, j: true }));
    }
    const updates = writes.filter(({ commandName }) => commandName === "update");
    expect(updates).toHaveLength(6);
    expect(updates.every(({ command }) => command.updates[0].upsert === false)).toBe(true);
    expect(updates.every(({ command }) => Object.keys(command.updates[0].u.$set).join() === "delivery")).toBe(true);
    const indexes = await mongo.db.collection(CHANGES).listIndexes().toArray();
    expect(indexes.filter((index) => index.name !== "_id_")).toHaveLength(2);
    expect(indexes.some((index) => "expireAfterSeconds" in index)).toBe(false);
    expect(commands.some(({ commandName }) => commandName === "delete")).toBe(false);
    expect(commands.some(({ command }) => command.autocommit === false)).toBe(false);
    expect(JSON.stringify(commands.map(({ command }) => command))).not.toContain("$changeStream");
  });

  it("matches the fake for keyset expressions, exact embedded equality and computed projections", async () => {
    const now = await serverNow();
    const fake = createCatalogFake(() => now);
    const invalidRows: CatalogChangeDoc[] = [];
    for (let number = 1; number <= 25; number++) {
      const row = change(now, pending(now), number);
      row.createdAt = plus(now, -50_000 + Math.floor((number - 1) / 2) * 1_000);
      if (number !== 25) (row.delivery as any).preparation = null;
      invalidRows.push(row);
      fake.rows(CHANGES).set(row._id, cloneBson(row));
    }
    await mongo.db.collection(CHANGES).insertMany(invalidRows.map(copy), JOURNALED);
    const fakeOutbox = new ModelCatalogOutbox(fake.db);
    const realOutbox = new ModelCatalogOutbox(mongo.db);
    let fakeAfter;
    let realAfter;
    const fakeIds: string[][] = [];
    const realIds: string[][] = [];
    for (let page = 0; page < 3; page++) {
      const fakePage = await fakeOutbox.due(now, 10, fakeAfter);
      const realPage = await realOutbox.due(now, 10, realAfter);
      fakeIds.push(fakePage.rows.map((row) => row._id));
      realIds.push(realPage.rows.map((row) => row._id));
      fakeAfter = fakePage.next;
      realAfter = realPage.next;
    }
    expect(realIds).toEqual(fakeIds);
    expect(realIds.map((ids) => ids.length)).toEqual([10, 10, 5]);
    expect(realIds[2].at(-1)).toBe(id(25));

    await resetDatabase();
    const blank = { ...change(now), _id: "", createdAt: now };
    const afterBlank = { ...change(now, pending(now), 2), _id: "after-blank", createdAt: now };
    fake.rows(CHANGES).clear();
    fake.rows(CHANGES).set(blank._id, cloneBson(blank));
    fake.rows(CHANGES).set(afterBlank._id, cloneBson(afterBlank));
    await mongo.db.collection(CHANGES).insertMany([blank, afterBlank], JOURNALED);
    const fakeBlank = await fakeOutbox.due(now, 1);
    const realBlank = await realOutbox.due(now, 1);
    expect(realBlank).toEqual(fakeBlank);
    expect(realBlank.next).toEqual({ createdAt: now, id: "" });
    expect(await realOutbox.due(now, 1, realBlank.next)).toEqual(await fakeOutbox.due(now, 1, fakeBlank.next));

    await resetDatabase();
    const observed = change(now);
    const reordered = {
      ...copy(observed),
      delivery: {
        attempts: observed.delivery.attempts,
        state: observed.delivery.state,
        nextAttemptAt: observed.delivery.nextAttemptAt,
      } as ChangeDelivery,
    };
    const mutation = transition("claim", observed, claimDelivery(observed, now), now, false);
    fake.rows(CHANGES).clear();
    fake.rows(CHANGES).set(observed._id, cloneBson(reordered));
    await seed(reordered);
    expect(await fakeOutbox.apply(mutation)).toEqual({ kind: "miss" });
    expect(await realOutbox.apply(mutation)).toEqual({ kind: "miss" });

    await resetDatabase();
    const prepared = mutationFixture("prepare", now, 30).after;
    const projections: Row[] = [
      prepared,
      { _id: "array", provider: "codex", createdAt: now, delivery: [1, 2] },
      { _id: "missing", provider: "codex", createdAt: now },
      { _id: "null", provider: "codex", createdAt: now, delivery: null },
      { _id: "scalar", provider: "codex", createdAt: now, delivery: "bad" },
      { _id: "gemini", provider: "gemini", createdAt: now, delivery: null },
    ];
    fake.rows(CHANGES).clear();
    for (const row of projections) fake.rows(CHANGES).set(row._id, cloneBson(row));
    await mongo.db.collection(CHANGES).insertMany(projections.map(copy), JOURNALED);
    const projectionQuery = (db: typeof mongo.db) =>
      db
        .collection(CHANGES)
        .find({ provider: { $ne: "gemini" } }, { projection: statusProjection })
        .sort({ _id: 1 })
        .toArray();
    const fakeProjected = await projectionQuery(fake.db);
    const realProjected = await projectionQuery(mongo.db);
    expect(realProjected).toEqual(fakeProjected);
    const projected = realProjected.find((row: any) => row._id === prepared._id) as any;
    expect(projected.delivery.preparation).not.toHaveProperty("text");
    expect(projected.delivery).not.toHaveProperty("receipt");
    expect(realProjected.find((row: any) => row._id === "missing")).not.toHaveProperty("delivery");

    const lazyProjection = {
      _id: 1,
      selected: { $cond: [true, "$provider", { $size: "$provider" }] },
    };
    const fakeLazy = await fake.db
      .collection(CHANGES)
      .find({ _id: prepared._id }, { projection: lazyProjection })
      .toArray();
    const realLazy = await mongo.db
      .collection(CHANGES)
      .find({ _id: prepared._id }, { projection: lazyProjection })
      .toArray();
    expect(realLazy).toEqual(fakeLazy);
    expect(realLazy).toEqual([{ _id: prepared._id, selected: "codex" }]);
  });

  it("preserves real-driver method binding through intercepted chained and async cursors", async () => {
    const now = await serverNow();
    await seed(change(now));
    const finds: any[][] = [];
    const wrapped = faultDb(mongo.db, async (collection, method, args, run) => {
      if (collection === CHANGES && method === "find") finds.push(args);
      return run();
    });
    expect((await new ModelCatalogOutbox(wrapped).due(now, 1)).rows).toHaveLength(1);
    const rows: Row[] = [];
    for await (const row of wrapped.collection(CHANGES).find({ provider: "codex" }).sort({ _id: 1 }).limit(1)) {
      rows.push(row);
    }
    expect(rows.map((row) => row._id)).toEqual([id(1)]);
    expect(finds).toHaveLength(2);
  });
});

describe("standalone outbox contention and uncertain writes", () => {
  it.each([
    { label: "absent version to delivered", version: undefined, expired: false, terminal: "delivered" },
    { label: "explicit zero to released", version: 0, expired: false, terminal: "pending" },
    { label: "expired claim to delivered", version: 4, expired: true, terminal: "delivered" },
  ] as const)("fences a delayed second claim from $label", async ({ version, expired, terminal }) => {
    const now = await serverNow();
    let initial = change(now, pending(now, version));
    if (expired) {
      initial = change(now, {
        ...pending(now, version),
        state: "claimed",
        attempts: 2,
        lastAttemptAt: plus(now, -180_000),
        claim: {
          token: "expired-token",
          owner: "expired-worker",
          startedAt: plus(now, -180_000),
          leaseExpiresAt: plus(now, -60_000),
          stage: "preparing",
        },
      });
    }
    expect(validChange(initial)).toBe(true);
    await seed(initial);
    const rawA = new ModelCatalogOutbox(mongo.db);
    const observedA = await rawA.read(initial._id);
    const observedB = await new ModelCatalogOutbox(mongo.db).read(initial._id);
    if (!observedA || !observedB) throw new Error("missing observations");
    const aClaim = transition("claim", observedA, claimDelivery(observedA, now, "token-a"), now, false);
    const bClaim = transition("claim", observedB, claimDelivery(observedB, now, "token-b"), now, false);
    const entered = deferred<void>();
    const resume = deferred<void>();
    const matched: number[] = [];
    const delayedB = new ModelCatalogOutbox(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.claim?.token === "token-b") {
          entered.resolve();
          await resume.promise;
          const result = await run();
          matched.push(result.matchedCount);
          return result;
        }
        return run();
      }),
    );
    const delayedClaim = delayedB.apply(bClaim);
    await entered.promise;
    const claimedA = await applied(rawA, aClaim);
    if (terminal === "delivered") await prepareAndDeliver(rawA, claimedA, now, "a");
    else await applied(rawA, transition("release", claimedA, releaseDelivery(claimedA, now), now, false));
    const snapshot = await stored(initial._id);
    resume.resolve();
    expect(await delayedClaim).toEqual({ kind: "superseded" });
    expect(matched).toEqual([0]);
    expect(await stored(initial._id)).toEqual(snapshot);
    expect(snapshot.delivery.state).toBe(terminal);
    expect(immutableBytes(snapshot)).toEqual(immutableBytes(initial));
  });

  it("rejects expired/equal proposals and requires both local and server candidate clocks", async () => {
    const server = await serverNow();
    const row = change(server);
    await seed(row);
    const outbox = new ModelCatalogOutbox(mongo.db);

    const equalProposal = claimDelivery(row, plus(server, -1_000), "equal", server);
    const exact = transition("claim", row, equalProposal, server, false);
    expect(await outbox.apply(exact)).toEqual({ kind: "miss" });
    expect(await stored(row._id)).toEqual(row);

    const observed = await outbox.read(row._id);
    if (!observed) throw new Error("missing row");
    const shortLease = plus(await serverNow(), 40);
    const expiring = transition(
      "claim",
      observed,
      claimDelivery(observed, server, "expires-before-delegation", shortLease),
      server,
      false,
    );
    const matched: number[] = [];
    const delayed = new ModelCatalogOutbox(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (
          collection === CHANGES &&
          method === "updateOne" &&
          args[1]?.$set?.delivery?.claim?.token === "expires-before-delegation"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          const result = await run();
          matched.push(result.matchedCount);
          return result;
        }
        return run();
      }),
    );
    expect(await delayed.apply(expiring)).toEqual({ kind: "miss" });
    expect(matched).toEqual([0]);
    expect(await stored(row._id)).toEqual(row);

    await resetDatabase();
    const currentServer = await serverNow();
    const futureForServer = change(
      currentServer,
      { ...pending(currentServer), nextAttemptAt: plus(currentServer, 60_000) },
      1,
    );
    const futureForLocal = change(
      currentServer,
      { ...pending(currentServer), nextAttemptAt: plus(currentServer, -1_000) },
      2,
    );
    await mongo.db.collection(CHANGES).insertMany([futureForServer, futureForLocal], JOURNALED);
    expect(
      (await new ModelCatalogOutbox(mongo.db).due(plus(currentServer, 120_000))).rows.map((item) => item._id),
    ).toEqual([futureForLocal._id]);
    expect((await new ModelCatalogOutbox(mongo.db).due(plus(currentServer, -120_000))).rows).toEqual([]);
    expect((await new ModelCatalogOutbox(mongo.db).due(currentServer)).rows.map((item) => item._id)).toEqual([
      futureForLocal._id,
    ]);
  });

  it("can return an acknowledged claim after its short lease expires while the response is held", async () => {
    const now = await serverNow();
    const row = change(now);
    await seed(row);
    const leaseExpiresAt = plus(now, 500);
    const mutation = transition("claim", row, claimDelivery(row, now, "held-response", leaseExpiresAt), now, false);
    const entered = deferred<void>();
    const resume = deferred<void>();
    const outbox = new ModelCatalogOutbox(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (
          collection === CHANGES &&
          method === "updateOne" &&
          args[1]?.$set?.delivery?.claim?.token === "held-response"
        ) {
          const result = await run();
          expect(result.matchedCount).toBe(1);
          entered.resolve();
          await resume.promise;
          return result;
        }
        return run();
      }),
    );
    const operation = outbox.apply(mutation);
    await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 525));
    expect((await serverNow()).getTime()).toBeGreaterThanOrEqual(leaseExpiresAt.getTime());
    resume.resolve();
    expect(await operation).toMatchObject({ kind: "applied", source: "ack" });
    expect((await stored(row._id)).delivery.claim?.leaseExpiresAt.getTime()).toBeLessThanOrEqual(
      (await serverNow()).getTime(),
    );
  });

  it("excludes malformed/future/blocked states while retaining due invalid optional shapes unchanged", async () => {
    const now = await serverNow();
    const fixtures: CatalogChangeDoc[] = [];
    for (const [index, value] of [null, false, 0, "", []].entries()) {
      const row = change(now, pending(now), index + 1);
      (row.delivery as any).preparation = value;
      fixtures.push(row);
    }
    for (const [offset, value] of [null, false, 0, "", []].entries()) {
      const base = change(now, pending(now), offset + 10);
      const claimed = claimDelivery(base, plus(now, -120_000), `intent-${offset}`, plus(now, -1_000));
      claimed.claim!.sendIntent = value as never;
      fixtures.push(change(now, claimed, offset + 10));
    }
    const future = change(now, { ...pending(now), nextAttemptAt: plus(now, 60_000) }, 20);
    const blocked = change(
      now,
      {
        ...pending(now),
        retryBlocked: true,
        diagnostic: { reason: "retry-deadline-unrepresentable", at: now },
      },
      21,
    );
    const suppliedBlockedFalse = change(now, { ...pending(now), retryBlocked: false as never }, 22);
    const malformedLease = change(now, pending(now), 23);
    Object.assign(malformedLease.delivery, {
      state: "claimed",
      claim: {
        token: "bad-lease",
        owner: "worker",
        startedAt: plus(now, -2_000),
        leaseExpiresAt: "expired",
        stage: "preparing",
      },
    });
    const unknown = change(now, { ...pending(now), state: "unknown" as never }, 24);
    const terminal = mutationFixture("ack", now, 25).after;
    await mongo.db
      .collection(CHANGES)
      .insertMany([...fixtures, future, blocked, suppliedBlockedFalse, malformedLease, unknown, terminal], JOURNALED);
    const before = await mongo.db.collection(CHANGES).find({}).sort({ _id: 1 }).toArray();
    const due = await new ModelCatalogOutbox(mongo.db).due(now, 10);
    expect(due.rows.map((row) => row._id)).toEqual(
      fixtures
        .map((row) => row._id)
        .sort()
        .slice(0, 10),
    );
    expect(due.rows.every((row) => !validChange(row))).toBe(true);
    expect(await mongo.db.collection(CHANGES).find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    for (const row of [future, blocked, suppliedBlockedFalse, malformedLease, unknown, terminal]) {
      expect(due.rows.map((candidate) => candidate._id)).not.toContain(row._id);
    }
  });

  it.each(["before", "after", "unavailable-read"] as const)(
    "keeps a thrown claim nonauthoritative with $label evidence",
    async (label) => {
      const now = await serverNow();
      const row = change(now);
      await seed(row);
      const claimMutation = transition("claim", row, claimDelivery(row, now, `claim-${label}`), now, false);
      const outbox = new ModelCatalogOutbox(
        faultDb(mongo.db, async (collection, method, _args, run) => {
          if (collection === CHANGES && method === "findOne" && label === "unavailable-read") {
            throw new Error("evidence unavailable");
          }
          if (collection === CHANGES && method === "updateOne") {
            if (label === "after") await run();
            throw new Error("claim acknowledgment unavailable");
          }
          return run();
        }),
      );
      expect(await outbox.apply(claimMutation)).toEqual({ kind: "unknown" });
      const actual = await stored(row._id);
      expect(actual).toEqual(label === "after" ? claimMutation.after : row);
      expect(immutableBytes(actual)).toEqual(immutableBytes(row));
    },
  );

  it("lets a fresh claim fence an unexecuted thrown predecessor", async () => {
    const now = await serverNow();
    const row = change(now);
    await seed(row);
    let delayedRun: (() => Promise<any>) | undefined;
    const oldMutation = transition("claim", row, claimDelivery(row, now, "old-token"), now, false);
    const uncertain = new ModelCatalogOutbox(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.claim?.token === "old-token") {
          delayedRun = run;
          throw new Error("delegation unknown");
        }
        return run();
      }),
    );
    expect(await uncertain.apply(oldMutation)).toEqual({ kind: "unknown" });
    const fresh = new ModelCatalogOutbox(mongo.db);
    const freshObserved = await fresh.read(row._id);
    if (!freshObserved) throw new Error("missing fresh observation");
    expect(
      await fresh.apply(
        transition("claim", freshObserved, claimDelivery(freshObserved, now, "fresh-token"), now, false),
      ),
    ).toMatchObject({
      kind: "applied",
    });
    if (!delayedRun) throw new Error("old mutation was not captured");
    expect((await delayedRun()).matchedCount).toBe(0);
    expect((await stored(row._id)).delivery.claim?.token).toBe("fresh-token");
  });

  it.each(["renew", "prepare", "send-intent", "release", "ack"] as const)(
    "uses exact positive evidence when a $kind write applies and then throws",
    async (kind) => {
      const now = await serverNow();
      const mutation = mutationFixture(kind, now);
      await seed(mutation.before);
      const outbox = new ModelCatalogOutbox(
        faultDb(mongo.db, async (collection, method, args, run) => {
          if (collection === CHANGES && method === "updateOne" && args[0]._id === mutation.before._id) {
            await run();
            throw new Error("write acknowledgment unavailable");
          }
          return run();
        }),
      );
      expect(await outbox.apply(mutation)).toMatchObject({ kind: "applied", source: "evidence" });
      expect(await stored(mutation.before._id)).toEqual(mutation.after);
    },
  );

  it("keeps a known acknowledgment unknown until its delayed write supplies exact evidence", async () => {
    const now = await serverNow();
    const ack = mutationFixture("ack", now);
    await seed(ack.before);
    let delayedRun: (() => Promise<any>) | undefined;
    const uncertain = new ModelCatalogOutbox(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.state === "delivered") {
          delayedRun = run;
          throw new Error("delegation unknown");
        }
        return run();
      }),
    );
    expect(await uncertain.apply(ack)).toEqual({ kind: "unknown" });
    expect(await stored(ack.before._id)).toEqual(ack.before);
    if (!delayedRun) throw new Error("acknowledgment was not captured");
    expect((await delayedRun()).matchedCount).toBe(1);
    expect(await new ModelCatalogOutbox(mongo.db).apply(ack)).toMatchObject({
      kind: "applied",
      source: "evidence",
    });
    expect(await stored(ack.before._id)).toEqual(ack.after);
  });
});

describe("standalone delayed transition fencing", () => {
  it("does not renew an expired claim or replace its immutable payload", async () => {
    const now = await serverNow();
    const fixture = mutationFixture("renew", now);
    const expired = copy(fixture.before);
    expired.delivery.claim = {
      ...copy(expired.delivery.claim!),
      startedAt: plus(now, -2_000),
      leaseExpiresAt: plus(now, -1_000),
    };
    await seed(expired);
    const proposed = transition(
      "renew",
      expired,
      {
        ...copy(expired.delivery),
        claim: { ...copy(expired.delivery.claim!), leaseExpiresAt: plus(now, 120_000) },
      },
      now,
      true,
    );
    expect(await new ModelCatalogOutbox(mongo.db).apply(proposed)).toEqual({ kind: "miss" });
    expect(await stored(expired._id)).toEqual(expired);
    expect(immutableBytes(await stored(expired._id))).toEqual(immutableBytes(expired));
  });

  it.each(["renew", "prepare", "send-intent", "release", "ack"] as const)(
    "records an actual zero match when delayed old $kind runs after takeover",
    async (kind) => {
      const now = await serverNow();
      const old = mutationFixture(kind, now);
      await seed(old.before);
      const entered = deferred<void>();
      const resume = deferred<void>();
      const matched: number[] = [];
      const delayed = new ModelCatalogOutbox(
        faultDb(mongo.db, async (collection, method, args, run) => {
          if (
            collection === CHANGES &&
            method === "updateOne" &&
            args[0]._id === old.before._id &&
            args[0]["delivery.version"] === old.before.delivery.version &&
            args[0]["delivery.claim.token"] === old.before.delivery.claim?.token
          ) {
            entered.resolve();
            await resume.promise;
            const result = await run();
            matched.push(result.matchedCount);
            return result;
          }
          return run();
        }),
      );
      const oldOperation = delayed.apply(old);
      await entered.promise;
      let snapshot: CatalogChangeDoc;
      try {
        const takeoverAt = await serverNow();
        const expiredDelivery = copy(old.before.delivery);
        expiredDelivery.version = (old.before.delivery.version ?? 0) + 1;
        expiredDelivery.claim = {
          ...copy(old.before.delivery.claim!),
          startedAt: plus(takeoverAt, -2_000),
          leaseExpiresAt: plus(takeoverAt, -1_000),
        };
        const expiry = await mongo.db.collection(CHANGES).updateOne(
          {
            _id: old.before._id,
            "delivery.version": old.before.delivery.version,
            "delivery.claim.token": old.before.delivery.claim!.token,
          },
          { $set: { delivery: expiredDelivery } },
          { ...JOURNALED, upsert: false },
        );
        expect(expiry.matchedCount).toBe(1);
        const expired = await stored(old.before._id);
        expect(validChange(expired)).toBe(true);
        const bNow = await serverNow();
        const due = await new ModelCatalogOutbox(mongo.db).due(bNow);
        expect(due.rows.map((row) => row._id)).toEqual([old.before._id]);
        const b = new ModelCatalogOutbox(mongo.db);
        const claimedB = await claim(b, due.rows[0], bNow, "token-b");
        await prepareAndDeliver(b, claimedB, bNow, "b");
        snapshot = await stored(old.before._id);
      } finally {
        resume.resolve();
      }
      expect(await oldOperation).toEqual({ kind: "superseded" });
      expect(matched).toEqual([0]);
      expect(await stored(old.before._id)).toEqual(snapshot!);
      expect(snapshot!.delivery.state).toBe("delivered");
      expect(snapshot!.delivery.claim).toBeUndefined();
      expect(immutableBytes(snapshot!)).toEqual(immutableBytes(old.before));
    },
  );

  it("preserves a newer pending successor when an uncertain old ack finally delegates", async () => {
    const now = await serverNow();
    const oldAck = mutationFixture("ack", now);
    await seed(oldAck.before);
    const entered = deferred<void>();
    const resume = deferred<void>();
    const matched: number[] = [];
    const delayed = new ModelCatalogOutbox(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.state === "delivered") {
          entered.resolve();
          await resume.promise;
          const result = await run();
          matched.push(result.matchedCount);
          return result;
        }
        return run();
      }),
    );
    const oldOperation = delayed.apply(oldAck);
    await entered.promise;
    const takeoverAt = await serverNow();
    const expiredDelivery = copy(oldAck.before.delivery);
    expiredDelivery.version = (oldAck.before.delivery.version ?? 0) + 1;
    expiredDelivery.claim = {
      ...copy(oldAck.before.delivery.claim!),
      startedAt: plus(takeoverAt, -2_000),
      leaseExpiresAt: plus(takeoverAt, -1_000),
    };
    expect(
      (
        await mongo.db
          .collection(CHANGES)
          .updateOne(
            { _id: oldAck.before._id, "delivery.version": oldAck.before.delivery.version },
            { $set: { delivery: expiredDelivery } },
            JOURNALED,
          )
      ).matchedCount,
    ).toBe(1);
    const b = new ModelCatalogOutbox(mongo.db);
    const bNow = await serverNow();
    const claimedB = await claim(b, (await b.due(bNow)).rows[0], bNow, "token-b");
    const pendingB = await applied(b, transition("release", claimedB, releaseDelivery(claimedB, bNow), bNow, false));
    const snapshot = await stored(oldAck.before._id);
    expect(snapshot).toEqual(pendingB);
    resume.resolve();
    expect(await oldOperation).toEqual({ kind: "superseded" });
    expect(matched).toEqual([0]);
    expect(await stored(oldAck.before._id)).toEqual(snapshot);
  });

  it("fences an obsolete ack with a same-token renewal and applies only a rebased known receipt", async () => {
    const now = await serverNow();
    const oldAck = mutationFixture("ack", now);
    await seed(oldAck.before);
    let delayedRun: (() => Promise<any>) | undefined;
    const uncertain = new ModelCatalogOutbox(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (collection === CHANGES && method === "updateOne" && args[1]?.$set?.delivery?.state === "delivered") {
          delayedRun = run;
          throw new Error("ack delegation unknown");
        }
        return run();
      }),
    );
    expect(await uncertain.apply(oldAck)).toEqual({ kind: "unknown" });
    const outbox = new ModelCatalogOutbox(mongo.db);
    const renewal = transition(
      "renew",
      oldAck.before,
      {
        ...copy(oldAck.before.delivery),
        claim: {
          ...copy(oldAck.before.delivery.claim!),
          leaseExpiresAt: plus(now, 180_000),
        },
      },
      plus(now, 30_000),
      true,
    );
    const renewed = await applied(outbox, renewal);
    expect(await outbox.evidence(oldAck)).toMatchObject({
      kind: "advanced",
      row: { delivery: { version: renewed.delivery.version } },
    });
    if (!delayedRun) throw new Error("old ack was not captured");
    expect((await delayedRun()).matchedCount).toBe(0);
    const rebased = transition("ack", renewed, copy(oldAck.after.delivery), now, false);
    expect(await outbox.apply(rebased)).toMatchObject({ kind: "applied", source: "ack" });
    const final = await stored(oldAck.before._id);
    expect(final.delivery.state).toBe("delivered");
    expect(final.delivery.receipt).toEqual(oldAck.after.delivery.receipt);
    expect(final.delivery.version).toBe((renewed.delivery.version ?? 0) + 1);
  });

  it("allows a same-token exact acknowledgment after lease expiry but never clears a changed preparation", async () => {
    const now = await serverNow();
    const ack = mutationFixture("ack", now);
    const expired = copy(ack.before);
    expired.delivery.claim = {
      ...copy(expired.delivery.claim!),
      startedAt: plus(now, -2_000),
      leaseExpiresAt: plus(now, -1_000),
    };
    const exactExpiredAck = transition("ack", expired, deliveredDelivery(expired, now), now, false);
    await seed(expired);
    expect(await new ModelCatalogOutbox(mongo.db).apply(exactExpiredAck)).toMatchObject({ kind: "applied" });

    await resetDatabase();
    const changed = copy(expired);
    changed.delivery.version = (expired.delivery.version ?? 0) + 1;
    changed.delivery.preparation = preparation(changed, now, "changed");
    changed.delivery.claim = {
      ...copy(changed.delivery.claim!),
      stage: "preparing",
    };
    delete changed.delivery.claim.sendIntent;
    await seed(changed);
    expect(await new ModelCatalogOutbox(mongo.db).apply(exactExpiredAck)).toMatchObject({
      kind: "advanced",
    });
    expect((await stored(changed._id)).delivery).toEqual(changed.delivery);
    expect((await stored(changed._id)).delivery.receipt).toBeUndefined();
  });
});

describe("standalone outbox guards and export recovery", () => {
  it.each(["claim", "renew", "prepare", "send-intent", "release", "ack"] as const)(
    "engages guardDb at the real $kind delegation boundary",
    async (kind) => {
      const now = await serverNow();
      const mutation = mutationFixture(kind, now);
      await seed(mutation.before);
      const writesBefore = commands.filter(
        ({ commandName, command }) => commandName === "update" && command.update === CHANGES,
      ).length;
      const guard = new WriteGuard({ instanceId: "test", dbName: mongo.db.databaseName });
      let delegated = 0;
      const guarded = new ModelCatalogOutbox(
        faultDb(guardDb(mongo.db, guard), async (collection, method, _args, run) => {
          if (collection === CHANGES && method === "updateOne") {
            delegated++;
            guard.engage("test mismatch");
          }
          return run();
        }),
      );
      expect(await guarded.apply(mutation)).toEqual({ kind: "unknown" });
      expect(delegated).toBe(1);
      expect(guard.refusedWriteCount).toBe(1);
      expect(await stored(mutation.before._id)).toEqual(mutation.before);
      expect(
        commands.filter(({ commandName, command }) => commandName === "update" && command.update === CHANGES),
      ).toHaveLength(writesBefore);
    },
  );

  it("guards real index delegation, reports read faults, and suppresses late exception evidence", async () => {
    const guard = new WriteGuard({ instanceId: "test", dbName: mongo.db.databaseName });
    let refuse = true;
    let delegated = 0;
    const db = faultDb(guardDb(mongo.db, guard), async (collection, method, _args, run) => {
      if (collection === CHANGES && method === "createIndex") {
        delegated++;
        if (refuse) guard.engage("test mismatch");
      }
      return run();
    });
    const outbox = new ModelCatalogOutbox(db);
    await expect(outbox.ensureIndexes()).rejects.toThrow("storage");
    expect(delegated).toBe(2);
    expect(guard.refusedWriteCount).toBe(2);
    expect(commands.filter(({ commandName }) => commandName === "createIndexes")).toEqual([]);
    refuse = false;
    guard.disengage();
    await outbox.ensureIndexes();
    expect(
      commands.filter(
        ({ commandName, command }) => commandName === "createIndexes" && command.createIndexes === CHANGES,
      ),
    ).toHaveLength(2);

    const now = await serverNow();
    const mutation = mutationFixture("prepare", now);
    await seed(mutation.before);
    let evidenceReads = 0;
    const late = new ModelCatalogOutbox(
      faultDb(mongo.db, async (collection, method, _args, run) => {
        if (collection === CHANGES && method === "updateOne") throw new Error("late failure");
        if (collection === CHANGES && method === "findOne") evidenceReads++;
        return run();
      }),
    );
    expect(await late.apply(mutation, () => false)).toEqual({ kind: "unknown" });
    expect(evidenceReads).toBe(0);
    expect(await stored(mutation.before._id)).toEqual(mutation.before);

    const unavailable = new ModelCatalogOutbox(
      faultDb(mongo.db, async (collection, method, _args, run) => {
        if (collection === CHANGES && method === "find") throw new Error("read unavailable");
        return run();
      }),
    );
    await expect(unavailable.due(now)).rejects.toThrow("read unavailable");
  });

  it.each(["pending", "claimed", "prepared", "uncertain", "delivered"] as const)(
    "preserves the complete $state delivery across repeated immutable export recovery",
    async (state) => {
      const now = await serverNow();
      const base = change(now);
      let row = base;
      if (state !== "pending") {
        row = mutationFixture(
          state === "claimed" ? "claim" : state === "prepared" ? "prepare" : state === "uncertain" ? "release" : "ack",
          now,
        ).after;
      }
      const immutable = copy(row) as Partial<CatalogChangeDoc>;
      delete immutable.delivery;
      const version = {
        ...copy(immutable),
        snapshot: [{ id: "model-1", displayName: "MODEL-1", addedAt: row.createdAt }],
        changeSummary: "+1 (model-1), -1 (old-model)",
      };
      await mongo.db.collection(VERSIONS).insertOne(version, JOURNALED);
      await seed(row);
      await mongo.db.collection(CATALOG).insertOne(
        {
          _id: "codex",
          provider: "codex",
          pendingExport: { version, change: immutable },
        },
        JOURNALED,
      );
      const deliveryBytes = BSON.serialize(row.delivery);
      const store = new ModelCatalogStore(mongo.db);
      for (let recovery = 0; recovery < 2; recovery++) {
        expect(await store.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
        expect(BSON.serialize((await stored(row._id)).delivery)).toEqual(deliveryBytes);
        expect(await mongo.db.collection(VERSIONS).countDocuments({ _id: row._id })).toBe(1);
        expect(await mongo.db.collection(CHANGES).countDocuments({ _id: row._id })).toBe(1);
        if (recovery === 0) {
          expect(
            (
              await mongo.db
                .collection(CATALOG)
                .updateOne({ _id: "codex" }, { $set: { pendingExport: { version, change: immutable } } }, JOURNALED)
            ).matchedCount,
          ).toBe(1);
        }
      }
      expect(await mongo.db.collection(CATALOG).findOne({ _id: "codex" })).not.toHaveProperty("pendingExport");
    },
  );
});
