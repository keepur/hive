/* eslint-disable @typescript-eslint/no-explicit-any */
import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { guardDb, WriteGuard } from "../db/write-guard.js";
import { makePreparation, type ChangeDelivery, type NoticePreparation } from "./model-catalog-notification.js";
import {
  ModelCatalogOutbox,
  copy,
  transition,
  validChange,
  type MutationKind,
  type Transition,
} from "./model-catalog-outbox.js";
import type { CatalogChangeDoc } from "./model-catalog-types.js";
import { cloneBson, createCatalogFake, deferred, faultDb, type Row } from "./testing/catalog-db.test-support.js";

const CHANGES = "agent_model_catalog_changes";
const BASE = new Date("2026-09-07T00:00:00.000Z");
const at = (milliseconds: number) => new Date(BASE.getTime() + milliseconds);
const id = (number: number) => `change-${String(number).padStart(3, "0")}`;

function pending(version?: number): ChangeDelivery {
  return {
    state: "pending",
    attempts: 0,
    nextAttemptAt: new Date(BASE),
    ...(version === undefined ? {} : { version }),
  };
}

function change(delivery: ChangeDelivery = pending(), number = 1, createdAt = BASE): CatalogChangeDoc {
  return {
    _id: id(number),
    provider: "codex",
    revision: number,
    snapshotId: `snapshot-${number}`,
    createdAt: new Date(createdAt),
    source: "manual",
    updatedBy: "test-operator",
    modelCount: 2,
    bootstrap: number === 1,
    added: [`model-${number}`],
    removed: ["old-model"],
    delivery: copy(delivery),
  };
}

function claimDelivery(row: CatalogChangeDoc, token = "token-a", lease = at(120_000)): ChangeDelivery {
  return {
    ...copy(row.delivery),
    state: "claimed",
    attempts: row.delivery.attempts + 1,
    lastAttemptAt: new Date(BASE),
    claim: {
      token,
      owner: "worker-a",
      startedAt: new Date(BASE),
      leaseExpiresAt: new Date(lease),
      stage: "preparing",
    },
  };
}

function preparation(row: CatalogChangeDoc, processedAt = at(10_000)): NoticePreparation {
  return makePreparation(
    row,
    {
      agentId: "chief",
      agentName: "Chief of Staff",
      homeBase: "ops",
      adapterId: "slack",
      channelId: "C12345",
    },
    "Reviewed the saved catalog change.",
    processedAt,
  );
}

function preparedDelivery(row: CatalogChangeDoc): ChangeDelivery {
  return { ...copy(row.delivery), preparation: preparation(row) };
}

function sendingDelivery(row: CatalogChangeDoc): ChangeDelivery {
  const prepared = row.delivery.preparation ?? preparation(row);
  return {
    ...copy(row.delivery),
    preparation: prepared,
    claim: {
      ...copy(row.delivery.claim!),
      stage: "sending",
      sendIntent: {
        preparationId: prepared.id,
        startedAt: at(20_000),
        previouslyUncertain: false,
      },
    },
  };
}

function releasedDelivery(row: CatalogChangeDoc): ChangeDelivery {
  const rest = copy(row.delivery);
  delete rest.claim;
  delete rest.receipt;
  return {
    ...rest,
    state: "pending",
    nextAttemptAt: at(300_000),
    diagnostic: { reason: "delivery-unconfirmed", at: at(30_000) },
    uncertainSend: Boolean(row.delivery.claim?.sendIntent),
  };
}

function deliveredDelivery(row: CatalogChangeDoc, acknowledgedAt = at(180_000)): ChangeDelivery {
  const rest = copy(row.delivery);
  delete rest.claim;
  const prepared = row.delivery.preparation!;
  return {
    ...rest,
    state: "delivered",
    receipt: {
      preparationId: prepared.id,
      binding: copy(prepared.binding),
      channelId: prepared.binding.channelId,
      messageTs: "1725667200.123456",
      acknowledgedAt: new Date(acknowledgedAt),
    },
  };
}

function mutationFixture(kind: MutationKind): Transition {
  const first = change();
  if (kind === "claim") return transition("claim", first, claimDelivery(first), BASE, false);
  const claimed = transition("claim", first, claimDelivery(first), BASE, false).after;
  if (kind === "renew") {
    return transition(
      "renew",
      claimed,
      {
        ...copy(claimed.delivery),
        claim: { ...copy(claimed.delivery.claim!), leaseExpiresAt: at(180_000) },
      },
      at(30_000),
      true,
    );
  }
  if (kind === "prepare") {
    return transition("prepare", claimed, preparedDelivery(claimed), at(10_000), true);
  }
  const prepared = transition("prepare", claimed, preparedDelivery(claimed), at(10_000), true).after;
  if (kind === "send-intent") {
    return transition("send-intent", prepared, sendingDelivery(prepared), at(20_000), true);
  }
  const sending = transition("send-intent", prepared, sendingDelivery(prepared), at(20_000), true).after;
  if (kind === "release") {
    return transition("release", sending, releasedDelivery(sending), at(30_000), false);
  }
  return transition("ack", sending, deliveredDelivery(sending), at(180_000), false);
}

function immutableBytes(row: CatalogChangeDoc): Buffer {
  const immutable = copy(row) as Partial<CatalogChangeDoc>;
  delete immutable.delivery;
  return BSON.serialize(immutable);
}

function seed(fake: ReturnType<typeof createCatalogFake>, row: CatalogChangeDoc): void {
  fake.rows(CHANGES).set(row._id, cloneBson(row));
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

describe("model catalog outbox validation and candidates", () => {
  it("validates complete immutable and mutable state without normalizing optional presence", () => {
    const absent = change();
    expect(validChange(absent)).toBe(true);
    expect(validChange(change(pending(0)))).toBe(true);
    expect(validChange({ ...absent, delivery: { ...absent.delivery, version: undefined } })).toBe(false);
    expect(validChange({ ...absent, delivery: { ...absent.delivery, version: null } as never })).toBe(false);

    const plugin = { ...absent, provider: "plugin-provider", source: "manual" as const };
    expect(validChange(plugin)).toBe(true);
    expect(validChange({ ...plugin, source: "discovery" })).toBe(false);
    expect(validChange({ ...absent, provider: "gemini" })).toBe(false);
    expect(validChange({ ...absent, createdAt: new Date(Number.NaN) })).toBe(false);
    expect(validChange({ ...absent, revision: Number.POSITIVE_INFINITY })).toBe(false);
    expect(validChange({ ...absent, modelCount: -1 })).toBe(false);

    for (const field of ["preparation", "claim", "receipt", "diagnostic"] as const) {
      for (const value of [null, false, 0, "", [], undefined]) {
        expect(validChange({ ...absent, delivery: { ...absent.delivery, [field]: value } as never })).toBe(false);
      }
    }
    for (const value of [null, false, 0, "", [], undefined]) {
      expect(validChange({ ...absent, delivery: { ...absent.delivery, retryBlocked: value } as never })).toBe(false);
    }
    expect(validChange(absent)).toBe(true);
    expect(copy(absent)).toEqual(absent);
    expect(copy(absent).createdAt).toBeInstanceOf(Date);
  });

  it("requires valid local and server dates and returns sorted bounded eligible rows", async () => {
    let serverTime = at(50_000);
    const fake = createCatalogFake(() => serverTime);
    const due = change(pending(), 1, at(1_000));
    const equalPending = change({ ...pending(), nextAttemptAt: at(50_000) }, 2, at(2_000));
    const localAheadOnly = change({ ...pending(), nextAttemptAt: at(75_000) }, 3, at(3_000));
    const serverAheadOnly = change({ ...pending(), nextAttemptAt: at(25_000) }, 4, at(4_000));
    const blocked = change(
      { ...pending(), retryBlocked: true, diagnostic: { reason: "retry-deadline-unrepresentable", at: BASE } },
      5,
      at(5_000),
    );
    const expiredClaim = change(
      {
        ...claimDelivery(change(), "expired", at(50_000)),
        version: 4,
      },
      6,
      at(6_000),
    );
    const activeClaim = change(
      {
        ...claimDelivery(change(), "active", at(50_001)),
        version: 4,
      },
      7,
      at(7_000),
    );
    const malformedLease = change(
      {
        ...claimDelivery(change(), "bad", at(40_000)),
        claim: { ...claimDelivery(change(), "bad", at(40_000)).claim!, leaseExpiresAt: "soon" as never },
      },
      8,
      at(8_000),
    );
    const unknown = change({ ...pending(), state: "unknown" as never }, 9, at(9_000));
    const malformedCreated = { ...change(pending(), 10), createdAt: "yesterday" as never };
    const malformedId = { ...change(pending(), 11), _id: 99 as never };
    for (const row of [
      activeClaim,
      malformedLease,
      unknown,
      localAheadOnly,
      blocked,
      due,
      equalPending,
      expiredClaim,
      serverAheadOnly,
      malformedCreated,
      malformedId,
    ]) {
      fake.rows(CHANGES).set(row._id as never, cloneBson(row));
    }

    const outbox = new ModelCatalogOutbox(fake.db);
    expect((await outbox.due(at(50_000))).rows.map((row) => row._id)).toEqual([
      due._id,
      equalPending._id,
      serverAheadOnly._id,
      expiredClaim._id,
    ]);
    serverTime = at(100_000);
    expect((await outbox.due(at(50_000))).rows.map((row) => row._id)).toEqual([
      due._id,
      equalPending._id,
      serverAheadOnly._id,
      expiredClaim._id,
    ]);
    expect((await outbox.due(at(100_000))).rows.map((row) => row._id)).toContain(localAheadOnly._id);
    await expect(outbox.due(new Date(Number.NaN))).rejects.toThrow("invalid-state");
    await expect(outbox.due(BASE, 0)).rejects.toThrow("invalid-state");
    await expect(outbox.due(BASE, 11)).rejects.toThrow("invalid-state");
    await expect(outbox.due(BASE, 10, { createdAt: new Date(Number.NaN), id: "x" })).rejects.toThrow("invalid-state");
    await expect(outbox.due(BASE, 10, { createdAt: BASE, id: 1 as never })).rejects.toThrow("invalid-state");
  });

  it("advances deterministic keyset pages across more than two full invalid pages", async () => {
    const fake = createCatalogFake(() => at(100_000));
    for (let number = 1; number <= 25; number++) {
      const row = change(pending(), number, at(Math.floor((number - 1) / 2) * 1_000));
      if (number !== 25) (row.delivery as any).preparation = null;
      seed(fake, row);
    }
    const before = cloneBson([...fake.rows(CHANGES).values()]);
    const outbox = new ModelCatalogOutbox(fake.db);
    const first = await outbox.due(at(100_000));
    const second = await outbox.due(at(100_000), 10, first.next);
    const third = await outbox.due(at(100_000), 10, second.next);
    expect(first.rows).toHaveLength(10);
    expect(second.rows).toHaveLength(10);
    expect(third.rows).toHaveLength(5);
    expect(first.next).toEqual({ createdAt: at(4_000), id: id(10) });
    expect(second.next).toEqual({ createdAt: at(9_000), id: id(20) });
    expect(third.next).toBeUndefined();
    expect(third.rows.at(-1)?._id).toBe(id(25));
    expect(validChange(third.rows.at(-1)!)).toBe(true);
    expect([...first.rows, ...second.rows].every((row) => !validChange(row))).toBe(true);
    expect([...fake.rows(CHANGES).values()]).toEqual(before);
  });

  it("uses even an invalid blank string identity as a sortable keyset cursor", async () => {
    const fake = createCatalogFake(() => BASE);
    const blank = { ...change(pending(), 1), _id: "" };
    const next = { ...change(pending(), 2), _id: "next" };
    seed(fake, blank);
    seed(fake, next);
    const outbox = new ModelCatalogOutbox(fake.db);
    const first = await outbox.due(BASE, 1);
    expect(first.rows.map((row) => row._id)).toEqual([""]);
    expect(first.next).toEqual({ createdAt: BASE, id: "" });
    expect((await outbox.due(BASE, 1, first.next)).rows.map((row) => row._id)).toEqual(["next"]);
  });
});

describe("model catalog outbox transitions", () => {
  it("distinguishes absent version from explicit zero and compares the complete embedded delivery", async () => {
    const fake = createCatalogFake(() => BASE);
    const absent = change();
    const absentClaim = transition("claim", absent, claimDelivery(absent), BASE, false);
    seed(fake, change(pending(0)));
    expect(await new ModelCatalogOutbox(fake.db).apply(absentClaim)).toEqual({ kind: "miss" });

    seed(fake, absent);
    expect(await new ModelCatalogOutbox(fake.db).apply(absentClaim)).toMatchObject({
      kind: "applied",
      source: "ack",
      row: { delivery: { version: 1 } },
    });

    const explicit = change(pending(0));
    const explicitClaim = transition("claim", explicit, claimDelivery(explicit), BASE, false);
    seed(fake, absent);
    expect(await new ModelCatalogOutbox(fake.db).apply(explicitClaim)).toEqual({ kind: "miss" });

    const observed = change();
    const reordered = {
      ...observed,
      delivery: {
        attempts: observed.delivery.attempts,
        state: observed.delivery.state,
        nextAttemptAt: observed.delivery.nextAttemptAt,
      } as ChangeDelivery,
    };
    expect(validChange(reordered)).toBe(true);
    seed(fake, reordered);
    expect(
      await new ModelCatalogOutbox(fake.db).apply(transition("claim", observed, claimDelivery(observed), BASE, false)),
    ).toEqual({
      kind: "miss",
    });
  });

  it.each([
    { label: "exact delegation equality", delegationAt: at(100), successor: false },
    { label: "server ahead of the local claimant", delegationAt: at(101), successor: false },
    { label: "exact equality after a successor release", delegationAt: at(100), successor: true },
  ])("refuses a claim proposal that expires before $label", async ({ delegationAt, successor }) => {
    let serverTime = new Date(BASE);
    const fake = createCatalogFake(() => serverTime);
    const initial = change();
    const immutable = immutableBytes(initial);
    seed(fake, initial);
    const raw = new ModelCatalogOutbox(fake.db);
    const proposal = transition("claim", initial, claimDelivery(initial, "expiring-proposal", at(100)), BASE, false);
    const matched: number[] = [];
    let survivor = cloneBson(initial);
    const delayed = new ModelCatalogOutbox(
      faultDb(fake.db, async (collection, method, args, run) => {
        if (
          collection === CHANGES &&
          method === "updateOne" &&
          args[1]?.$set?.delivery?.claim?.token === "expiring-proposal"
        ) {
          serverTime = new Date(delegationAt);
          if (successor) {
            const observed = await raw.read(initial._id);
            if (!observed) throw new Error("missing successor observation");
            const claimed = await raw.apply(
              transition("claim", observed, claimDelivery(observed, "successor", at(120_100)), delegationAt, false),
            );
            if (claimed.kind !== "applied") throw new Error("successor claim failed");
            const prepared = await raw.apply(
              transition("prepare", claimed.row, preparedDelivery(claimed.row), delegationAt, true),
            );
            if (prepared.kind !== "applied") throw new Error("successor preparation failed");
            const released = await raw.apply(
              transition("release", prepared.row, releasedDelivery(prepared.row), delegationAt, false),
            );
            if (released.kind !== "applied") throw new Error("successor release failed");
            survivor = cloneBson(released.row);
          }
          const result = await run();
          matched.push(result.matchedCount);
          return result;
        }
        return run();
      }),
    );

    expect(await delayed.apply(proposal)).toEqual(successor ? { kind: "superseded" } : { kind: "miss" });
    expect(matched).toEqual([0]);
    expect(await raw.read(initial._id)).toEqual(survivor);
    expect(immutableBytes(survivor)).toEqual(immutable);
  });

  it("runs monotonic claim, renewal, preparation, intent and post-expiry acknowledgment without changing immutable bytes", async () => {
    let serverTime = new Date(BASE);
    const fake = createCatalogFake(() => serverTime);
    const initial = change();
    const immutable = immutableBytes(initial);
    seed(fake, initial);
    const outbox = new ModelCatalogOutbox(fake.db);

    const claim = transition("claim", initial, claimDelivery(initial), BASE, false);
    const claimed = await outbox.apply(claim);
    expect(claimed).toMatchObject({ kind: "applied", row: { delivery: { version: 1 } } });
    const row1 = await outbox.read(initial._id);
    expect(immutableBytes(row1!)).toEqual(immutable);

    const nonIncreasing = transition(
      "renew",
      row1!,
      { ...copy(row1!.delivery), claim: { ...copy(row1!.delivery.claim!), leaseExpiresAt: at(120_000) } },
      at(10_000),
      true,
    );
    expect(await outbox.apply(nonIncreasing)).toEqual({ kind: "miss" });
    expect(await outbox.read(initial._id)).toEqual(row1);

    const renew = transition(
      "renew",
      row1!,
      { ...copy(row1!.delivery), claim: { ...copy(row1!.delivery.claim!), leaseExpiresAt: at(180_000) } },
      at(30_000),
      true,
    );
    expect(await outbox.apply(renew)).toMatchObject({ kind: "applied", row: { delivery: { version: 2 } } });
    const row2 = await outbox.read(initial._id);
    expect(row2!.delivery.claim!.leaseExpiresAt).toEqual(at(180_000));
    expect(immutableBytes(row2!)).toEqual(immutable);

    const prepare = transition("prepare", row2!, preparedDelivery(row2!), at(40_000), true);
    expect(await outbox.apply(prepare)).toMatchObject({ kind: "applied", row: { delivery: { version: 3 } } });
    const row3 = await outbox.read(initial._id);
    expect(row3!.delivery.preparation).toEqual(preparation(row2!));
    expect(validChange(row3!)).toBe(true);

    const intent = transition("send-intent", row3!, sendingDelivery(row3!), at(50_000), true);
    expect(await outbox.apply(intent)).toMatchObject({ kind: "applied", row: { delivery: { version: 4 } } });
    const row4 = await outbox.read(initial._id);
    expect(row4!.delivery.claim?.sendIntent?.preparationId).toBe(row4!.delivery.preparation?.id);

    serverTime = at(180_000);
    const resurrect = transition(
      "renew",
      row4!,
      { ...copy(row4!.delivery), claim: { ...copy(row4!.delivery.claim!), leaseExpiresAt: at(240_000) } },
      at(180_000),
      true,
    );
    expect(await outbox.apply(resurrect)).toEqual({ kind: "miss" });
    expect(await outbox.read(initial._id)).toEqual(row4);

    const ack = transition("ack", row4!, deliveredDelivery(row4!, at(180_000)), at(180_000), false);
    expect(await outbox.apply(ack)).toMatchObject({
      kind: "applied",
      row: { delivery: { state: "delivered", version: 5 } },
    });
    const terminal = await outbox.read(initial._id);
    expect(terminal!.delivery.receipt?.preparationId).toBe(terminal!.delivery.preparation?.id);
    expect(immutableBytes(terminal!)).toEqual(immutable);
    expect((await outbox.due(at(300_000))).rows).toEqual([]);
  });

  it.each(["renew", "prepare", "send-intent"] as const)(
    "refuses live %s mutation when either observed claim clock is expired",
    async (kind) => {
      const mutation = mutationFixture(kind);
      for (const [label, serverTime, localTime] of [
        ["server", mutation.before.delivery.claim!.leaseExpiresAt, mutation.localNow],
        ["local", BASE, mutation.before.delivery.claim!.leaseExpiresAt],
      ] as const) {
        const fake = createCatalogFake(() => serverTime);
        seed(fake, mutation.before);
        const candidate = { ...mutation, localNow: new Date(localTime) };
        expect(await new ModelCatalogOutbox(fake.db).apply(candidate), label).toEqual({ kind: "miss" });
        expect(await new ModelCatalogOutbox(fake.db).read(mutation.before._id)).toEqual(mutation.before);
      }
    },
  );

  it("classifies exact, advanced and superseded evidence for every mutation kind", async () => {
    for (const kind of ["claim", "renew", "prepare", "send-intent", "release", "ack"] as const) {
      const transitionValue = mutationFixture(kind);
      const fake = createCatalogFake(() => BASE);
      const outbox = new ModelCatalogOutbox(fake.db);

      seed(fake, transitionValue.after);
      expect(await outbox.evidence(transitionValue)).toMatchObject({ kind: "applied", source: "evidence" });

      const ownerToken =
        kind === "claim" ? transitionValue.after.delivery.claim!.token : transitionValue.before.delivery.claim!.token;
      const advanced = {
        ...copy(transitionValue.before),
        delivery: {
          ...copy(transitionValue.before.delivery),
          state: "claimed" as const,
          version: (transitionValue.before.delivery.version ?? 0) + 2,
          claim: {
            ...(transitionValue.before.delivery.claim ?? transitionValue.after.delivery.claim!),
            token: ownerToken,
          },
        },
      };
      seed(fake, advanced);
      expect(await outbox.evidence(transitionValue)).toMatchObject({
        kind: "advanced",
        row: { delivery: { version: advanced.delivery.version } },
      });

      const successor = {
        ...copy(advanced),
        delivery: {
          ...copy(advanced.delivery),
          claim: { ...copy(advanced.delivery.claim!), token: "successor-token" },
        },
      };
      seed(fake, successor);
      expect(await outbox.evidence(transitionValue)).toEqual({ kind: "superseded" });

      const pendingSuccessor = change(
        { ...pending((transitionValue.before.delivery.version ?? 0) + 3), attempts: 4 },
        1,
      );
      seed(fake, pendingSuccessor);
      expect(await outbox.evidence(transitionValue)).toEqual({ kind: "superseded" });
    }
  });

  it("requires positive evidence after zero matches and keeps thrown claims nonauthoritative", async () => {
    const prepare = mutationFixture("prepare");
    const exactFake = createCatalogFake(() => BASE);
    seed(exactFake, prepare.after);
    expect(await new ModelCatalogOutbox(exactFake.db).apply(prepare)).toMatchObject({
      kind: "applied",
      source: "evidence",
    });

    const missFake = createCatalogFake(() => BASE);
    seed(missFake, prepare.before);
    const refused = new ModelCatalogOutbox(
      faultDb(missFake.db, async (collection, method, _args, run) => {
        if (collection === CHANGES && method === "updateOne") {
          return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
        }
        return run();
      }),
    );
    expect(await refused.apply(prepare)).toEqual({ kind: "miss" });
    expect(await refused.read(prepare.before._id)).toEqual(prepare.before);

    for (const { kind, applyBeforeThrow, readUnavailable, expected } of [
      { kind: "claim", applyBeforeThrow: true, readUnavailable: false, expected: "unknown" },
      { kind: "claim", applyBeforeThrow: false, readUnavailable: false, expected: "unknown" },
      { kind: "claim", applyBeforeThrow: false, readUnavailable: true, expected: "unknown" },
      { kind: "renew", applyBeforeThrow: true, readUnavailable: false, expected: "applied" },
      { kind: "prepare", applyBeforeThrow: true, readUnavailable: false, expected: "applied" },
    ] as const) {
      const mutation = mutationFixture(kind);
      const fake = createCatalogFake(() => BASE);
      seed(fake, mutation.before);
      const outbox = new ModelCatalogOutbox(
        faultDb(fake.db, async (collection, method, _args, run) => {
          if (collection === CHANGES && method === "findOne" && readUnavailable) {
            throw new Error("evidence unavailable");
          }
          if (collection === CHANGES && method === "updateOne") {
            if (applyBeforeThrow) await run();
            throw new Error("acknowledgment lost");
          }
          return run();
        }),
      );
      expect(await outbox.apply(mutation)).toMatchObject({ kind: expected });
      expect(await new ModelCatalogOutbox(fake.db).read(mutation.before._id)).toEqual(
        applyBeforeThrow ? mutation.after : mutation.before,
      );
    }

    const beforeFake = createCatalogFake(() => BASE);
    seed(beforeFake, prepare.before);
    const unknown = new ModelCatalogOutbox(
      faultDb(beforeFake.db, async (collection, method, _args, run) => {
        if (collection === CHANGES && method === "updateOne") throw new Error("not delegated");
        return run();
      }),
    );
    expect(await unknown.apply(prepare)).toEqual({ kind: "unknown" });
    expect(await unknown.read(prepare.before._id)).toEqual(prepare.before);
  });

  it("does not begin exception evidence reads after the supplied store gate closes", async () => {
    const mutation = mutationFixture("prepare");
    const fake = createCatalogFake(() => BASE);
    seed(fake, mutation.before);
    let reads = 0;
    const outbox = new ModelCatalogOutbox(
      faultDb(fake.db, async (collection, method, _args, run) => {
        if (collection === CHANGES && method === "updateOne") throw new Error("late write failure");
        if (collection === CHANGES && method === "findOne") reads++;
        return run();
      }),
    );
    expect(await outbox.apply(mutation, () => false)).toEqual({ kind: "unknown" });
    expect(reads).toBe(0);
    expect(await outbox.read(mutation.before._id)).toEqual(mutation.before);
  });

  it("keeps the fake operation timestamp fixed when a claim mutation pauses after capture", async () => {
    let current = new Date(BASE);
    const proposalExpires = at(100);
    const fake = createCatalogFake(() => current, {
      afterTimestamp: async ({ update, serverNow }) => {
        if (update.$set?.delivery?.claim?.token !== "paused-token") return;
        expect(serverNow).toEqual(BASE);
        current = new Date(proposalExpires);
      },
    });
    const row = change();
    seed(fake, row);
    const result = await new ModelCatalogOutbox(fake.db).apply(
      transition("claim", row, claimDelivery(row, "paused-token", proposalExpires), BASE, false),
    );
    expect(result).toMatchObject({ kind: "applied", source: "ack" });
    const persisted = await new ModelCatalogOutbox(fake.db).read(row._id);
    expect(persisted?.delivery.claim?.leaseExpiresAt).toEqual(current);
    expect(persisted?.delivery.claim?.leaseExpiresAt.getTime()).toBeLessThanOrEqual(current.getTime());
  });

  it.each(["renew", "prepare", "send-intent", "release", "ack"] as const)(
    "lets an actually delayed old %s CAS miss a newer successor",
    async (kind) => {
      const mutation = mutationFixture(kind);
      const fake = createCatalogFake(() => BASE);
      seed(fake, mutation.before);
      const entered = deferred<void>();
      const resume = deferred<void>();
      const matched: number[] = [];
      const delayed = new ModelCatalogOutbox(
        faultDb(fake.db, async (collection, method, args, run) => {
          if (
            collection === CHANGES &&
            method === "updateOne" &&
            args[0]["delivery.claim.token"] === mutation.before.delivery.claim?.token
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
      const pendingSuccessor = change(
        {
          ...pending((mutation.before.delivery.version ?? 0) + 5),
          attempts: mutation.before.delivery.attempts + 1,
          preparation: mutation.before.delivery.preparation,
        },
        1,
      );
      const operation = delayed.apply(mutation);
      await entered.promise;
      seed(fake, pendingSuccessor);
      const snapshot = cloneBson(pendingSuccessor);
      resume.resolve();
      expect(await operation).toEqual({ kind: "superseded" });
      expect(matched).toEqual([0]);
      expect(await new ModelCatalogOutbox(fake.db).read(snapshot._id)).toEqual(snapshot);
      expect(immutableBytes(snapshot)).toEqual(immutableBytes(mutation.before));
    },
  );
});

describe("model catalog outbox guard and shared fake boundaries", () => {
  it.each(["claim", "renew", "prepare", "send-intent", "release", "ack"] as const)(
    "checks guardDb at the actual %s delegation boundary",
    async (kind) => {
      const mutation = mutationFixture(kind);
      const fake = createCatalogFake(() => BASE);
      seed(fake, mutation.before);
      const guard = new WriteGuard({ instanceId: "test", dbName: "test" });
      let delegated = 0;
      const db = faultDb(guardDb(fake.db, guard), async (collection, method, _args, run) => {
        if (collection === CHANGES && method === "updateOne") {
          delegated++;
          guard.engage("test mismatch");
        }
        return run();
      });
      expect(await new ModelCatalogOutbox(db).apply(mutation)).toEqual({ kind: "unknown" });
      expect(delegated).toBe(1);
      expect(guard.refusedWriteCount).toBe(1);
      expect(await new ModelCatalogOutbox(fake.db).read(mutation.before._id)).toEqual(mutation.before);
    },
  );

  it("guards index creation at delegation, retries after refusal, and inherits journaled collection options", async () => {
    const fake = createCatalogFake(() => BASE);
    const collectionCalls: Array<{ name: string; options: unknown }> = [];
    const recording = new Proxy(fake.db, {
      get(target, key) {
        if (key === "collection") {
          return (name: string, options?: unknown) => {
            collectionCalls.push({ name, options });
            return target.collection(name, options as never);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const guard = new WriteGuard({ instanceId: "test", dbName: "test" });
    let delegated = 0;
    let refuse = true;
    const db = faultDb(guardDb(recording, guard), async (collection, method, _args, run) => {
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
    expect(fake.indexes).toEqual([]);
    refuse = false;
    guard.disengage();
    await outbox.ensureIndexes();
    expect(fake.indexes).toHaveLength(2);
    expect(fake.indexes.every((entry) => entry.options === undefined)).toBe(true);
    expect(collectionCalls).toEqual(
      ["agent_model_catalog", "agent_model_catalog_versions", CHANGES].map((name) => ({
        name,
        options: { writeConcern: { w: 1, j: true } },
      })),
    );
  });

  it("evaluates the exact computed projection lazily and preserves malformed parents", async () => {
    const fake = createCatalogFake(() => BASE);
    const prepared = mutationFixture("prepare").after;
    const fixtures: Row[] = [
      prepared,
      { _id: "null", provider: "codex", createdAt: BASE, delivery: null },
      { _id: "scalar", provider: "codex", createdAt: BASE, delivery: "bad" },
      { _id: "array", provider: "codex", createdAt: BASE, delivery: [1, 2] },
      { _id: "missing", provider: "codex", createdAt: BASE },
      { _id: "gemini", provider: "gemini", createdAt: BASE, delivery: null },
    ];
    for (const fixture of fixtures) fake.rows(CHANGES).set(fixture._id, cloneBson(fixture));
    const rows = await fake.db
      .collection(CHANGES)
      .find({ provider: { $ne: "gemini" } }, { projection: statusProjection })
      .sort({ _id: 1 })
      .toArray();
    expect(rows.map((row: any) => row._id)).toEqual(["array", prepared._id, "missing", "null", "scalar"]);
    const projected = rows.find((row: any) => row._id === prepared._id) as any;
    expect(projected.delivery.preparation).toEqual({
      id: prepared.delivery.preparation?.id,
      binding: prepared.delivery.preparation?.binding,
      processedAt: prepared.delivery.preparation?.processedAt,
    });
    expect(projected.delivery.preparation).not.toHaveProperty("text");
    expect(projected.delivery).not.toHaveProperty("receipt");
    expect(rows.find((row: any) => row._id === "null")?.delivery).toBeNull();
    expect(rows.find((row: any) => row._id === "scalar")?.delivery).toBe("bad");
    expect(rows.find((row: any) => row._id === "array")?.delivery).toEqual([1, 2]);
    expect(rows.find((row: any) => row._id === "missing")).not.toHaveProperty("delivery");

    const lazy = await fake.db
      .collection(CHANGES)
      .find(
        { _id: prepared._id },
        {
          projection: {
            _id: 1,
            selected: { $cond: [true, "$provider", { $size: "$provider" }] },
          },
        },
      )
      .toArray();
    expect(lazy).toEqual([{ _id: prepared._id, selected: "codex" }]);
  });

  it("intercepts cursor execution while preserving chaining, async iteration and collection options", async () => {
    const fake = createCatalogFake(() => BASE);
    seed(fake, change());
    const finds: any[][] = [];
    const db = faultDb(fake.db, async (collection, method, args, run) => {
      if (collection === CHANGES && method === "find") finds.push(args);
      return run();
    });
    const outbox = new ModelCatalogOutbox(db);
    expect((await outbox.due(BASE, 1)).rows).toHaveLength(1);
    const iterated: Row[] = [];
    for await (const row of db.collection(CHANGES).find({ provider: "codex" }).sort({ _id: 1 }).limit(1)) {
      iterated.push(row as Row);
    }
    expect(iterated.map((row) => row._id)).toEqual([id(1)]);
    expect(finds).toHaveLength(2);
    expect(finds[0][0]).toEqual(expect.any(Object));
    expect(finds[1]).toEqual([{ provider: "codex" }]);
  });
});
