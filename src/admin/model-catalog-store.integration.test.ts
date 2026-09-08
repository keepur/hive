/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { ObjectId, type CommandStartedEvent } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guardDb, WriteGuard } from "../db/write-guard.js";
import type { AcquisitionObservation, CatalogProvider } from "./model-catalog-types.js";
import { ModelCatalogStore } from "./model-catalog-store.js";
import { deferred, faultDb } from "./testing/catalog-db.test-support.js";
import { startStandaloneMongo } from "./testing/standalone-mongo.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((options: { name: string }) => ({ name: options.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: any) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
}));
vi.mock("../config.js", () => ({ config: { gemini: {}, modelRouter: { enabled: true } } }));

import { buildAdminTools } from "./admin-mcp-server.js";

let mongo: Awaited<ReturnType<typeof startStandaloneMongo>>;
let commands: CommandStartedEvent[] = [];

const input = (id: string, notes?: string) => ({
  provider: "codex",
  updatedBy: "test-operator",
  models: [{ id, displayName: id.toUpperCase(), ...(notes === undefined ? {} : { notes }) }],
});
const discovered = (id: string, displayName = id.toUpperCase()) => [{ id, displayName }];
const serverNow = async (): Promise<Date> => (await mongo.db.admin().command({ hello: 1 })).localTime;
const proposal = (observed: AcquisitionObservation, now: Date, leaseMs = 120_000, attemptId = randomUUID()) => ({
  attemptId,
  startedAt: new Date(now),
  leaseExpiresAt: new Date(now.getTime() + leaseMs),
  observed,
});
async function begin(
  store: ModelCatalogStore,
  provider: CatalogProvider = "codex",
  leaseMs = 120_000,
): Promise<ReturnType<ModelCatalogStore["beginDiscoveryAttempt"]> extends Promise<infer T> ? T : never> {
  const now = await serverNow();
  const due = await store.readCatalogState(provider);
  return store.beginDiscoveryAttempt(provider, proposal(due.observed, now, leaseMs));
}
async function completeState(store: ModelCatalogStore, provider = "codex") {
  return {
    catalog: (await store.readCatalogState(provider)).snapshot,
    versions: await store.collections.versions.find({ provider }).sort({ revision: 1 }).toArray(),
    changes: await store.collections.changes.find({ provider }).sort({ revision: 1 }).toArray(),
  };
}
async function clearDatabase(): Promise<void> {
  expect(mongo.db.databaseName).toMatch(/^hive_kpr459_test_/);
  await mongo.db.dropDatabase();
  commands = [];
}

beforeAll(async () => {
  mongo = await startStandaloneMongo();
  mongo.client.on("commandStarted", (event) => commands.push(event));
}, 30_000);
afterAll(async () => {
  await mongo?.close();
}, 30_000);
beforeEach(clearDatabase, 30_000);

describe("standalone model catalog", () => {
  it("uses a standalone WiredTiger server and journaled state/index commands without forbidden mechanisms", async () => {
    const store = new ModelCatalogStore(mongo.db);
    await store.ensureIndexes();
    expect(await store.replaceManual(input("model-a"))).toMatchObject({ kind: "committed", revision: 1 });

    const relevant = commands.filter(
      ({ commandName, command }) =>
        ["insert", "update", "createIndexes"].includes(commandName) &&
        ["agent_model_catalog", "agent_model_catalog_versions", "agent_model_catalog_changes"].includes(
          command[commandName],
        ),
    );
    expect(relevant.length).toBeGreaterThanOrEqual(5);
    for (const event of relevant)
      expect(event.command.writeConcern).toEqual(expect.objectContaining({ w: 1, j: true }));
    expect(
      commands.some(({ commandName }) =>
        ["startTransaction", "commitTransaction", "abortTransaction"].includes(commandName),
      ),
    ).toBe(false);
    expect(commands.some(({ command }) => command.autocommit === false)).toBe(false);
    expect(JSON.stringify(commands.map(({ command }) => command))).not.toContain("$changeStream");

    const indexes = await Promise.all([
      store.collections.versions.listIndexes().toArray(),
      store.collections.changes.listIndexes().toArray(),
    ]);
    expect(indexes.flat().some((index) => "expireAfterSeconds" in index)).toBe(false);

    const legacyId = new ObjectId();
    await mongo.db.collection("agent_model_catalog_versions").insertOne({ _id: legacyId, provider: "legacy" });
    await store.ensureIndexes();
    expect(await mongo.db.collection("agent_model_catalog_versions").findOne({ _id: legacyId })).not.toBeNull();
  });

  it("serializes concurrent first replacements and preserves journal identity", async () => {
    const a = new ModelCatalogStore(mongo.db);
    const b = new ModelCatalogStore(mongo.db);
    const [left, right] = await Promise.all([a.replaceManual(input("model-a")), b.replaceManual(input("model-b"))]);
    expect([left.kind, right.kind]).toEqual(["committed", "committed"]);
    const state = await completeState(a);
    expect(state.catalog?.revision).toBe(2);
    expect(state.versions).toHaveLength(2);
    expect(state.changes).toHaveLength(2);
    expect(new Set(state.versions.map((row) => row._id)).size).toBe(2);
    expect(state.catalog).not.toHaveProperty("pendingExport");
  });

  it("rebases discovery on the latest manual notes and manual writes on the latest discovery", async () => {
    const scanner = new ModelCatalogStore(mongo.db);
    await scanner.replaceManual(input("model-a", "old note"));
    const started = await begin(scanner);
    if (started.kind !== "started") throw new Error("attempt did not start");
    await new ModelCatalogStore(mongo.db).replaceManual(input("model-a", "latest note"));
    const changed = await scanner.applyDiscovery(started.attempt, discovered("model-b", "Vendor B"));
    expect(changed).toMatchObject({ kind: "committed", revision: 3, added: ["model-b"], removed: ["model-a"] });

    const second = await begin(scanner);
    if (second.kind !== "started") throw new Error("second attempt did not start");
    await new ModelCatalogStore(mongo.db).replaceManual({
      provider: "codex",
      updatedBy: "editor",
      models: [{ id: "model-b", displayName: "Manual B", notes: "keep me" }],
    });
    expect(await scanner.applyDiscovery(second.attempt, discovered("model-b", "Discovered B"))).toMatchObject({
      kind: "committed",
      revision: 5,
      added: [],
      removed: [],
    });
    expect((await scanner.readCatalogState("codex")).snapshot?.models).toMatchObject([
      { id: "model-b", displayName: "Discovered B", notes: "keep me" },
    ]);
  });

  it("advances only scan freshness for unchanged discovery after a manual revision race", async () => {
    const store = new ModelCatalogStore(mongo.db);
    await store.replaceManual(input("model-a", "one"));
    const started = await begin(store);
    if (started.kind !== "started") throw new Error("attempt did not start");
    await new ModelCatalogStore(mongo.db).replaceManual(input("model-a", "two"));
    const before = await completeState(store);
    const result = await store.applyDiscovery(started.attempt, discovered("model-a"));
    expect(result.kind).toBe("unchanged");
    const after = await completeState(store);
    expect(after.catalog?.revision).toBe(2);
    expect(after.catalog?.scan).toMatchObject({ attemptId: started.attempt.attemptId, outcome: "succeeded" });
    expect(after.versions).toHaveLength(before.versions.length);
    expect(after.changes).toHaveLength(before.changes.length);
    expect(after.catalog?.models?.[0].notes).toBe("two");
  });

  it("records failure without changing saved content, successful freshness, or audit rows", async () => {
    const store = new ModelCatalogStore(mongo.db);
    await store.replaceManual(input("model-a"));
    const success = await begin(store);
    if (success.kind !== "started") throw new Error("success attempt did not start");
    await store.applyDiscovery(success.attempt, discovered("model-a"));
    const before = await completeState(store);
    const failed = await begin(store);
    if (failed.kind !== "started") throw new Error("failure attempt did not start");
    expect(
      await store.failDiscoveryAttempt(failed.attempt, { code: "timeout", message: "raw secret" }, new Date()),
    ).toEqual({
      kind: "recorded",
    });
    const after = await completeState(store);
    expect(after.catalog?.models).toEqual(before.catalog?.models);
    expect(after.catalog?.scan?.lastSucceededAt).toEqual(before.catalog?.scan?.lastSucceededAt);
    expect(after.catalog?.scan?.error).toEqual({ code: "timeout", message: "Model catalog codex: timeout." });
    expect(after.versions).toEqual(before.versions);
    expect(after.changes).toEqual(before.changes);
  });

  it.each(["history", "change", "clear"] as const)(
    "recovers the %s export boundary exactly once through a fresh store",
    async (fault) => {
      let tripped = false;
      const broken = faultDb(mongo.db, async (collection, method, args, run) => {
        const targeted =
          (!tripped &&
            fault === "history" &&
            collection === "agent_model_catalog_versions" &&
            method === "insertOne") ||
          (!tripped && fault === "change" && collection === "agent_model_catalog_changes" && method === "insertOne") ||
          (!tripped &&
            fault === "clear" &&
            collection === "agent_model_catalog" &&
            method === "updateOne" &&
            args[1].$unset?.pendingExport === "");
        if (targeted) {
          tripped = true;
          throw new Error(`test ${fault} unavailable`);
        }
        return run();
      });
      const result = await new ModelCatalogStore(broken).replaceManual(input("model-a"));
      expect(result).toMatchObject({ kind: "committed", recoveryPending: true });
      const readable = await new ModelCatalogStore(mongo.db).readCatalogState("codex");
      expect(readable.snapshot?.models?.[0].id).toBe("model-a");
      expect(readable.recoveryPending).toBe(true);
      const fresh = new ModelCatalogStore(mongo.db);
      expect(await fresh.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
      expect(await fresh.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
      expect(await fresh.collections.versions.countDocuments()).toBe(1);
      expect(await fresh.collections.changes.countDocuments()).toBe(1);
      expect((await fresh.readCatalogState("codex")).recoveryPending).toBe(false);
    },
  );

  it.each(["history", "change", "clear"] as const)(
    "recovers a lost acknowledgment after the real %s export exactly once",
    async (fault) => {
      let tripped = false;
      const uncertain = faultDb(mongo.db, async (collection, method, args, run) => {
        const targeted =
          (!tripped &&
            fault === "history" &&
            collection === "agent_model_catalog_versions" &&
            method === "insertOne") ||
          (!tripped && fault === "change" && collection === "agent_model_catalog_changes" && method === "insertOne") ||
          (!tripped &&
            fault === "clear" &&
            collection === "agent_model_catalog" &&
            method === "updateOne" &&
            args[1].$unset?.pendingExport === "");
        if (targeted) {
          tripped = true;
          await run();
          throw new Error(`test ${fault} acknowledgment lost`);
        }
        return run();
      });
      const result = await new ModelCatalogStore(uncertain).replaceManual({
        ...input("model-a", "operator note"),
        changeSummary: "post-write acknowledgment test",
      });
      expect(result).toMatchObject({ kind: "committed", revision: 1, recoveryPending: true });
      expect(tripped).toBe(true);
      if (result.kind !== "committed") throw new Error("replacement did not commit");

      const afterLostAck = await mongo.db.collection("agent_model_catalog").findOne({ _id: "codex" });
      expect(Boolean(afterLostAck?.pendingExport)).toBe(fault !== "clear");
      expect(await mongo.db.collection("agent_model_catalog_versions").countDocuments()).toBe(1);

      if (fault === "history") {
        let held = false;
        const keepEnvelope = faultDb(mongo.db, async (collection, method, args, run) => {
          if (
            !held &&
            collection === "agent_model_catalog" &&
            method === "updateOne" &&
            args[1].$unset?.pendingExport === ""
          ) {
            held = true;
            throw new Error("test recovery slot clear unavailable");
          }
          return run();
        });
        expect(await new ModelCatalogStore(keepEnvelope).recoverPendingExports("codex")).toMatchObject([
          { provider: "codex", kind: "pending", error: { code: "storage" } },
        ]);
        expect(held).toBe(true);
      }

      const versionBefore = await mongo.db.collection("agent_model_catalog_versions").findOne({ _id: result.commitId });
      const changeBefore = await mongo.db.collection("agent_model_catalog_changes").findOne({ _id: result.commitId });
      if (!versionBefore || !changeBefore) throw new Error("immutable exports were not persisted");
      expect(versionBefore).toMatchObject({
        _id: result.commitId,
        provider: "codex",
        revision: result.revision,
        snapshotId: result.snapshotId,
        bootstrap: true,
        added: ["model-a"],
        removed: [],
        source: "manual",
        updatedBy: "test-operator",
        modelCount: 1,
        snapshot: [{ id: "model-a", displayName: "MODEL-A", notes: "operator note" }],
        changeSummary: "post-write acknowledgment test",
      });
      expect(changeBefore).toMatchObject({
        _id: result.commitId,
        provider: "codex",
        revision: result.revision,
        snapshotId: result.snapshotId,
        bootstrap: true,
        added: ["model-a"],
        removed: [],
        source: "manual",
        updatedBy: "test-operator",
        modelCount: 1,
      });

      const immutableChange = { ...changeBefore };
      delete immutableChange.delivery;
      const delivery = {
        state: "pending",
        attempts: 7,
        nextAttemptAt: new Date(0),
        owner: `future-kpr461-${fault}`,
      };
      const deliveryMutation = await mongo.db
        .collection("agent_model_catalog_changes")
        .updateOne({ _id: result.commitId }, { $set: { delivery } });
      expect(deliveryMutation.matchedCount).toBe(1);

      const fresh = new ModelCatalogStore(mongo.db);
      expect(await fresh.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
      expect(await fresh.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
      expect(await fresh.collections.versions.find({}).toArray()).toEqual([versionBefore]);
      const changes = await mongo.db.collection("agent_model_catalog_changes").find({}).toArray();
      expect(changes).toHaveLength(1);
      const finalImmutableChange = { ...changes[0] };
      delete finalImmutableChange.delivery;
      expect(finalImmutableChange).toEqual(immutableChange);
      expect(changes[0].delivery).toEqual(delivery);
      const finalCatalog = (await fresh.readCatalogState("codex")).snapshot;
      expect(finalCatalog).not.toHaveProperty("pendingExport");
      expect(finalCatalog).toMatchObject({
        revision: result.revision,
        commitId: result.commitId,
        snapshotId: result.snapshotId,
        models: [{ id: "model-a", notes: "operator note" }],
      });
    },
  );

  it("preserves mutated delivery while duplicate recovery validates immutable fields", async () => {
    let failClear = true;
    const broken = faultDb(mongo.db, async (collection, method, args, run) => {
      if (
        failClear &&
        collection === "agent_model_catalog" &&
        method === "updateOne" &&
        args[1].$unset?.pendingExport === ""
      ) {
        failClear = false;
        throw new Error("test clear unavailable");
      }
      return run();
    });
    await new ModelCatalogStore(broken).replaceManual(input("model-a"));
    const change = await mongo.db.collection("agent_model_catalog_changes").findOne({ provider: "codex" });
    await mongo.db
      .collection("agent_model_catalog_changes")
      .updateOne(
        { _id: change!._id },
        { $set: { delivery: { state: "pending", attempts: 7, nextAttemptAt: new Date(0), owner: "future-kpr461" } } },
      );
    expect(await new ModelCatalogStore(mongo.db).recoverPendingExports("codex")).toEqual([
      { provider: "codex", kind: "recovered" },
    ]);
    expect(
      (await mongo.db.collection("agent_model_catalog_changes").findOne({ _id: change!._id }))?.delivery,
    ).toMatchObject({
      attempts: 7,
      owner: "future-kpr461",
    });
  });

  it.each(["history", "change"] as const)(
    "reports an immutable duplicate %s mismatch and keeps the envelope",
    async (target) => {
      let failTarget = true;
      const collectionName = target === "history" ? "agent_model_catalog_versions" : "agent_model_catalog_changes";
      const broken = faultDb(mongo.db, async (collection, method, _args, run) => {
        if (failTarget && collection === collectionName && method === "insertOne") {
          failTarget = false;
          throw new Error(`test ${target} unavailable`);
        }
        return run();
      });
      const saved = await new ModelCatalogStore(broken).replaceManual(input("model-a"));
      if (saved.kind !== "committed") throw new Error("seed did not commit");
      await mongo.db.collection(collectionName).insertOne({
        _id: saved.commitId,
        provider: "wrong",
        ...(target === "change" ? { delivery: { state: "pending", attempts: 9, nextAttemptAt: new Date(0) } } : {}),
      });
      const recovery = await new ModelCatalogStore(mongo.db).recoverPendingExports("codex");
      expect(recovery).toMatchObject([{ provider: "codex", kind: "pending", error: { code: "storage" } }]);
      expect((await new ModelCatalogStore(mongo.db).readCatalogState("codex")).recoveryPending).toBe(true);
      expect(await mongo.db.collection(collectionName).countDocuments({ _id: saved.commitId })).toBe(1);
      expect((await mongo.db.collection(collectionName).findOne({ _id: saved.commitId }))?.provider).toBe("wrong");
      expect(
        (await mongo.db.collection("agent_model_catalog").findOne({ _id: "codex" }))?.pendingExport?.version?._id,
      ).toBe(saved.commitId);
    },
  );

  it("reconciles an acknowledgment thrown after a real commit without replay", async () => {
    let tripped = false;
    const uncertain = faultDb(mongo.db, async (collection, method, args, run) => {
      if (!tripped && collection === "agent_model_catalog" && method === "insertOne" && args[0].pendingExport) {
        tripped = true;
        await run();
        throw new Error("test acknowledgment lost");
      }
      return run();
    });
    const result = await new ModelCatalogStore(uncertain).replaceManual(input("model-a"));
    expect(result).toMatchObject({ kind: "committed", revision: 1 });
    expect(await mongo.db.collection("agent_model_catalog").countDocuments()).toBe(1);
    expect(await mongo.db.collection("agent_model_catalog_versions").countDocuments()).toBe(1);
    expect(await mongo.db.collection("agent_model_catalog_changes").countDocuments()).toBe(1);
  });

  it("does not replay when a failed acknowledgment precedes the actual commit", async () => {
    let delayed: (() => Promise<any>) | undefined;
    const uncertain = faultDb(mongo.db, async (collection, method, args, run) => {
      if (!delayed && collection === "agent_model_catalog" && method === "insertOne" && args[0].pendingExport) {
        delayed = run;
        throw new Error("test lost acknowledgment before server execution");
      }
      return run();
    });
    const result = await new ModelCatalogStore(uncertain).replaceManual(input("model-a"));
    expect(result).toMatchObject({ kind: "commit-unknown" });
    expect(await mongo.db.collection("agent_model_catalog").countDocuments()).toBe(0);
    const delegated = await delayed!();
    expect(delegated.acknowledged).toBe(true);
    const fresh = new ModelCatalogStore(mongo.db);
    expect(await fresh.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
    expect((await fresh.collections.versions.findOne({}))?._id).toBe(
      result.kind === "commit-unknown" ? result.operationId : "unexpected",
    );
    expect(await fresh.collections.versions.countDocuments()).toBe(1);
    expect(await fresh.collections.changes.countDocuments()).toBe(1);
  });

  it("rejects stale observations after changed, failed, and unchanged-success outcomes", async () => {
    for (const fixture of ["missing", "legacy", "expired", "unchanged"] as const) {
      await clearDatabase();
      if (fixture === "legacy") {
        await mongo.db.collection("agent_model_catalog").insertOne({
          _id: "codex",
          provider: "codex",
          models: [{ id: "model-a", displayName: "A", addedAt: new Date(0) }],
        });
      }
      if (fixture === "expired") {
        const now = await serverNow();
        await mongo.db.collection("agent_model_catalog").insertOne({
          _id: "codex",
          provider: "codex",
          models: [{ id: "model-a", displayName: "A", addedAt: new Date(0) }],
          scan: {
            attemptId: randomUUID(),
            startedAt: new Date(now.getTime() - 10_000),
            leaseExpiresAt: new Date(now.getTime() - 1_000),
            outcome: "running",
          },
        });
      }
      if (fixture === "unchanged") await new ModelCatalogStore(mongo.db).replaceManual(input("model-a"));
      const a = new ModelCatalogStore(mongo.db);
      const dueA = await a.readCatalogState("codex");
      const dueB = await a.readCatalogState("codex");
      const now = await serverNow();
      const delayedProposal = proposal(dueB.observed, now);
      const entered = deferred<void>();
      const gate = deferred<void>();
      const delayed = new ModelCatalogStore(
        faultDb(mongo.db, async (collection, method, args, run) => {
          if (
            collection === "agent_model_catalog" &&
            method === "updateOne" &&
            args[1].$set?.["scan.attemptId"] === delayedProposal.attemptId
          ) {
            entered.resolve();
            await gate.promise;
          }
          return run();
        }),
      );
      const pending = delayed.beginDiscoveryAttempt("codex", delayedProposal);
      try {
        await entered.promise;
        const winner = await a.beginDiscoveryAttempt("codex", proposal(dueA.observed, now));
        expect(winner.kind).toBe("started");
        if (winner.kind !== "started") throw new Error("winner did not start");
        if (fixture === "expired") {
          expect(
            await a.failDiscoveryAttempt(winner.attempt, { code: "timeout", message: "ignored" }, new Date()),
          ).toEqual({
            kind: "recorded",
          });
        } else if (fixture === "unchanged") {
          expect(await a.applyDiscovery(winner.attempt, discovered("model-a"))).toMatchObject({ kind: "unchanged" });
        } else {
          expect(
            await a.applyDiscovery(winner.attempt, discovered(fixture === "legacy" ? "model-b" : "model-a")),
          ).toMatchObject({
            kind: "committed",
          });
        }
        const before = await completeState(a);
        if (fixture === "unchanged") {
          expect(before.catalog?.scan).toMatchObject({
            attemptId: winner.attempt.attemptId,
            outcome: "succeeded",
          });
          expect(before.versions).toHaveLength(1);
          expect(before.changes).toHaveLength(1);
        }
        gate.resolve();
        expect(await pending).toEqual({ kind: "busy" });
        expect(await completeState(a)).toEqual(before);
      } finally {
        gate.resolve();
        await pending.catch(() => undefined);
      }
    }
  }, 30_000);

  it("invalidates a missing seeded bit but permits seeded metadata and export changes", async () => {
    const missingStore = new ModelCatalogStore(mongo.db);
    const missing = await missingStore.readCatalogState("codex");
    await new ModelCatalogStore(mongo.db).replaceManual(input("model-a"));
    const now = await serverNow();
    expect(await missingStore.beginDiscoveryAttempt("codex", proposal(missing.observed, now))).toEqual({
      kind: "busy",
    });

    const seeded = new ModelCatalogStore(mongo.db);
    const observed = await seeded.readCatalogState("codex");
    await mongo.db
      .collection("agent_model_catalog")
      .updateOne({ _id: "codex" }, { $set: { updatedBy: "metadata-only" } });
    const accepted = await seeded.beginDiscoveryAttempt("codex", proposal(observed.observed, await serverNow()));
    expect(accepted.kind).toBe("started");
  });

  it("uses actual server time for expired/future proposals and strict timestamp equality", async () => {
    const store = new ModelCatalogStore(mongo.db);
    const due = await store.readCatalogState("codex");
    const sample = await serverNow();
    await expect(
      store.beginDiscoveryAttempt("codex", {
        ...proposal(due.observed, sample),
        startedAt: new Date(sample.getTime() - 2_000),
        leaseExpiresAt: new Date(sample.getTime() - 1_000),
      }),
    ).rejects.toMatchObject({ safe: { code: "malformed" } });

    await store.replaceManual(input("model-a"));
    const beforeServerExpiredProposal = await completeState(store);
    const serverSample = await serverNow();
    const clientNow = new Date(serverSample.getTime() - 60_000);
    const behindClock = new ModelCatalogStore(mongo.db, { now: () => clientNow });
    const behindObserved = await behindClock.readCatalogState("codex");
    const serverExpiredProposal = {
      attemptId: randomUUID(),
      startedAt: new Date(serverSample.getTime() - 2_000),
      leaseExpiresAt: new Date(serverSample.getTime() - 1_000),
      observed: behindObserved.observed,
    };
    expect(serverExpiredProposal.leaseExpiresAt.getTime()).toBeGreaterThan(clientNow.getTime());
    expect((await serverNow()).getTime()).toBeGreaterThanOrEqual(serverExpiredProposal.leaseExpiresAt.getTime());
    expect(await behindClock.beginDiscoveryAttempt("codex", serverExpiredProposal)).toEqual({ kind: "busy" });
    expect(
      await behindClock.applyDiscovery(
        {
          provider: "codex",
          attemptId: serverExpiredProposal.attemptId,
          startedAt: serverExpiredProposal.startedAt,
          leaseExpiresAt: serverExpiredProposal.leaseExpiresAt,
        },
        discovered("model-server-expired"),
      ),
    ).toMatchObject({ kind: "commit-unknown", operationId: serverExpiredProposal.attemptId });
    expect(await completeState(behindClock)).toEqual(beforeServerExpiredProposal);

    const observed = await behindClock.readCatalogState("codex");
    expect(
      await behindClock.beginDiscoveryAttempt("codex", {
        attemptId: randomUUID(),
        startedAt: new Date(serverSample.getTime() - 500),
        leaseExpiresAt: new Date(serverSample.getTime() + 30_000),
        observed: observed.observed,
      }),
    ).toMatchObject({ kind: "started" });

    const equality = await mongo.db
      .collection("agent_model_catalog")
      .updateOne({ _id: "codex", $expr: { $gt: ["$$NOW", "$$NOW"] } }, { $set: { equalityShouldNotMatch: true } });
    expect(equality.matchedCount).toBe(0);
  });

  it("refuses malformed BSON lease values through the production claim predicate", async () => {
    const malformed: unknown[] = ["tomorrow", null, 42, { date: new Date(0) }];
    for (const leaseExpiresAt of malformed) {
      await clearDatabase();
      await mongo.db.collection("agent_model_catalog").insertOne({
        _id: "codex",
        provider: "codex",
        scan: { attemptId: randomUUID(), startedAt: new Date(0), leaseExpiresAt, outcome: "running" },
      });
      const store = new ModelCatalogStore(mongo.db);
      const due = await store.readCatalogState("codex");
      expect(await store.beginDiscoveryAttempt("codex", proposal(due.observed, await serverNow()))).toEqual({
        kind: "busy",
      });
      expect((await store.readCatalogState("codex")).snapshot?.scan?.leaseExpiresAt).toEqual(leaseExpiresAt);
    }
  });

  it("holds a real matched acknowledgment past expiry without granting submission proof", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    let delayedId = "";
    const db = faultDb(mongo.db, async (collection, method, args, run) => {
      const result = await run();
      if (
        collection === "agent_model_catalog" &&
        method === "updateOne" &&
        args[1].$set?.["scan.attemptId"] === delayedId
      ) {
        expect(result.matchedCount).toBe(1);
        entered.resolve();
        await gate.promise;
      }
      return result;
    });
    const store = new ModelCatalogStore(db);
    await store.ensureIndexes();
    const due = await store.readCatalogState("codex");
    const now = await serverNow();
    delayedId = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 1_200);
    const pending = store.beginDiscoveryAttempt("codex", {
      attemptId: delayedId,
      startedAt: now,
      leaseExpiresAt,
      observed: due.observed,
    });
    try {
      await entered.promise;
      const deadline = Date.now() + 5_000;
      while (true) {
        const sample = await serverNow();
        if (sample >= leaseExpiresAt && new Date() >= leaseExpiresAt) break;
        if (Date.now() >= deadline) throw new Error("Test lease did not expire");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      gate.resolve();
      const acquired = await pending;
      expect(acquired.kind).toBe("started");
      if (acquired.kind !== "started") throw new Error("matched claim not acknowledged");
      expect(await store.applyDiscovery(acquired.attempt, discovered("model-a"))).toMatchObject({
        kind: "commit-unknown",
        operationId: delayedId,
      });
      expect(await store.collections.versions.countDocuments()).toBe(0);
      expect(await store.collections.changes.countDocuments()).toBe(0);
    } finally {
      gate.resolve();
      await pending.catch(() => undefined);
    }
  }, 30_000);

  it("keeps an uncertain unchanged completion fenced until its delayed mutation becomes positive evidence", async () => {
    let delayed: (() => Promise<any>) | undefined;
    const uncertain = new ModelCatalogStore(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (
          !delayed &&
          collection === "agent_model_catalog" &&
          method === "updateOne" &&
          args[1].$set?.["scan.outcome"] === "succeeded" &&
          !args[1].$set?.pendingExport
        ) {
          delayed = run;
          throw new Error("test delayed unchanged completion");
        }
        return run();
      }),
    );
    await uncertain.replaceManual(input("model-a"));
    const started = await begin(uncertain);
    if (started.kind !== "started") throw new Error("attempt did not start");
    const unknown = await uncertain.applyDiscovery(started.attempt, discovered("model-a"));
    expect(unknown).toMatchObject({ kind: "commit-unknown", operationId: started.attempt.attemptId });
    expect((await uncertain.readCatalogState("codex")).snapshot?.scan?.outcome).toBe("running");
    expect((await delayed!()).matchedCount).toBe(1);
    const resolved = await new ModelCatalogStore(mongo.db).applyDiscovery(started.attempt, discovered("model-a"));
    expect(resolved).toMatchObject({ kind: "commit-unknown", operationId: started.attempt.attemptId });
    expect((await uncertain.readCatalogState("codex")).snapshot?.scan).toMatchObject({
      attemptId: started.attempt.attemptId,
      outcome: "succeeded",
    });
    expect(await uncertain.collections.versions.countDocuments()).toBe(1);
    expect(await uncertain.collections.changes.countDocuments()).toBe(1);
  });

  it("does not let a delayed old completion overwrite a manual winner", async () => {
    let delayed: (() => Promise<any>) | undefined;
    const store = new ModelCatalogStore(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (!delayed && collection === "agent_model_catalog" && method === "updateOne" && args[1].$set?.pendingExport) {
          delayed = run;
          throw new Error("test delayed discovery commit");
        }
        return run();
      }),
    );
    await store.replaceManual(input("model-a"));
    const started = await begin(store);
    if (started.kind !== "started") throw new Error("attempt did not start");
    expect(await store.applyDiscovery(started.attempt, discovered("model-b"))).toMatchObject({
      kind: "commit-unknown",
    });
    await new ModelCatalogStore(mongo.db).replaceManual(input("model-c"));
    const winner = await completeState(store);
    expect((await delayed!()).matchedCount).toBe(0);
    expect(await completeState(store)).toEqual(winner);
  });

  it("bounds acquisition operations and same-token rereads without granting fresh-store proof", async () => {
    const counts = { findOne: 0, insertOne: 0, updateOne: 0, createIndex: 0 };
    const counted = faultDb(mongo.db, async (_collection, method, _args, run) => {
      if (method in counts) counts[method as keyof typeof counts]++;
      return run();
    });
    const store = new ModelCatalogStore(counted);
    const started = await begin(store);
    expect(started.kind).toBe("started");
    if (started.kind !== "started") throw new Error("attempt did not start");
    expect(counts.insertOne).toBeLessThanOrEqual(1);
    expect(counts.updateOne).toBe(1);
    const before = { ...counts };
    const fresh = new ModelCatalogStore(counted);
    const due = await fresh.readCatalogState("codex");
    expect(await fresh.beginDiscoveryAttempt("codex", { ...started.attempt, observed: due.observed })).toMatchObject({
      kind: "started",
    });
    expect(counts.insertOne).toBe(before.insertOne);
    expect(counts.updateOne).toBe(before.updateOne);
    expect(await fresh.applyDiscovery(started.attempt, discovered("model-a"))).toMatchObject({
      kind: "commit-unknown",
      operationId: started.attempt.attemptId,
    });
  });

  it("allows only one simultaneous apply submission for a locally proven token", async () => {
    const store = new ModelCatalogStore(mongo.db);
    const started = await begin(store);
    if (started.kind !== "started") throw new Error("attempt did not start");
    const [a, b] = await Promise.all([
      store.applyDiscovery(started.attempt, discovered("model-a")),
      store.applyDiscovery(started.attempt, discovered("model-a")),
    ]);
    expect([a.kind, b.kind]).toContain("committed");
    expect(await store.collections.versions.countDocuments()).toBe(1);
    expect(await store.collections.changes.countDocuments()).toBe(1);
    expect((await store.readCatalogState("codex")).snapshot?.revision).toBe(1);
  });

  it("keeps a thrown shell acknowledgment uncertain and permits only a fresh observed retry", async () => {
    let shellRuns = 0;
    const uncertain = new ModelCatalogStore(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (collection === "agent_model_catalog" && method === "insertOne" && !args[0].pendingExport) {
          shellRuns++;
          await run();
          throw new Error("test shell acknowledgment lost");
        }
        return run();
      }),
    );
    const due = await uncertain.readCatalogState("codex");
    await expect(
      uncertain.beginDiscoveryAttempt("codex", proposal(due.observed, await serverNow())),
    ).rejects.toMatchObject({
      safe: { code: "storage" },
    });
    expect(shellRuns).toBe(1);
    expect(await mongo.db.collection("agent_model_catalog").findOne({ _id: "codex" })).toEqual({
      _id: "codex",
      provider: "codex",
    });
    const retry = new ModelCatalogStore(mongo.db);
    expect(await begin(retry)).toMatchObject({ kind: "started" });
  });

  it("lets a successor take over an expired lease and ignores the late old matched acknowledgment", async () => {
    let oldId = "";
    const entered = deferred<void>();
    const release = deferred<void>();
    const db = faultDb(mongo.db, async (collection, method, args, run) => {
      const result = await run();
      if (
        collection === "agent_model_catalog" &&
        method === "updateOne" &&
        args[1].$set?.["scan.attemptId"] === oldId
      ) {
        expect(result.matchedCount).toBe(1);
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const store = new ModelCatalogStore(db);
    await store.ensureIndexes();
    const due = await store.readCatalogState("codex");
    const now = await serverNow();
    oldId = randomUUID();
    const oldLease = new Date(now.getTime() + 1_200);
    const oldPending = store.beginDiscoveryAttempt("codex", {
      attemptId: oldId,
      startedAt: now,
      leaseExpiresAt: oldLease,
      observed: due.observed,
    });
    try {
      await entered.promise;
      const deadline = Date.now() + 5_000;
      while ((await serverNow()) < oldLease) {
        if (Date.now() > deadline) throw new Error("Old test lease did not expire");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const successorDue = await store.readCatalogState("codex");
      const successorNow = await serverNow();
      const successor = await store.beginDiscoveryAttempt("codex", proposal(successorDue.observed, successorNow));
      expect(successor.kind).toBe("started");
      if (successor.kind !== "started") throw new Error("successor did not acquire");
      release.resolve();
      expect((await oldPending).kind).toBe("started");
      expect(await store.applyDiscovery(successor.attempt, discovered("model-a"))).toMatchObject({
        kind: "committed",
        commitId: successor.attempt.attemptId,
      });
      expect(
        await store.failDiscoveryAttempt(
          { provider: "codex", attemptId: oldId, startedAt: now, leaseExpiresAt: oldLease },
          { code: "timeout", message: "ignored" },
          new Date(),
        ),
      ).toEqual({
        kind: "superseded",
      });
      expect((await store.readCatalogState("codex")).snapshot?.scan?.attemptId).toBe(successor.attempt.attemptId);
    } finally {
      release.resolve();
      await oldPending.catch(() => undefined);
    }
  }, 30_000);

  it("settles committed UUID evidence before failed index initialization and never replays", async () => {
    let blockHistory = true;
    const original = new ModelCatalogStore(
      faultDb(mongo.db, async (collection, method, _args, run) => {
        if (blockHistory && collection === "agent_model_catalog_versions" && method === "insertOne") {
          throw new Error("test projection unavailable");
        }
        return run();
      }),
    );
    const started = await begin(original);
    if (started.kind !== "started") throw new Error("attempt did not start");
    expect(await original.applyDiscovery(started.attempt, discovered("model-a"))).toMatchObject({
      kind: "committed",
      commitId: started.attempt.attemptId,
      recoveryPending: true,
    });

    let indexCalls = 0;
    const unavailable = faultDb(mongo.db, async (collection, method, _args, run) => {
      if (method === "createIndex") {
        indexCalls++;
        throw new Error("test index unavailable");
      }
      if (collection === "agent_model_catalog_versions" && method === "insertOne") {
        throw new Error("test projection still unavailable");
      }
      return run();
    });
    expect(
      await new ModelCatalogStore(unavailable).applyDiscovery(started.attempt, [{ malformed: true }]),
    ).toMatchObject({
      kind: "committed",
      commitId: started.attempt.attemptId,
      recoveryPending: true,
    });
    expect(indexCalls).toBe(0);
    expect(await mongo.db.collection("agent_model_catalog").countDocuments()).toBe(1);
    expect(await mongo.db.collection("agent_model_catalog_versions").countDocuments()).toBe(0);
    blockHistory = false;
    expect(await new ModelCatalogStore(mongo.db).recoverPendingExports("codex")).toEqual([
      { provider: "codex", kind: "recovered" },
    ]);
    expect(await mongo.db.collection("agent_model_catalog_versions").countDocuments()).toBe(1);
    expect(await mongo.db.collection("agent_model_catalog_changes").countDocuments()).toBe(1);
  });

  it("keeps an unresolved UUID unknown when evidence is unavailable and a later guard cannot license replay", async () => {
    let delayed: (() => Promise<any>) | undefined;
    const original = new ModelCatalogStore(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (!delayed && collection === "agent_model_catalog" && method === "updateOne" && args[1].$set?.pendingExport) {
          delayed = run;
          throw new Error("test deferred initial commit");
        }
        return run();
      }),
    );
    const started = await begin(original);
    if (started.kind !== "started") throw new Error("attempt did not start");
    expect(await original.applyDiscovery(started.attempt, discovered("model-a"))).toMatchObject({
      kind: "commit-unknown",
      operationId: started.attempt.attemptId,
    });

    let indexCalls = 0;
    let mutationCalls = 0;
    const unavailable = faultDb(mongo.db, async (collection, method, _args, run) => {
      if (
        (collection === "agent_model_catalog" || collection === "agent_model_catalog_versions") &&
        method === "findOne"
      ) {
        throw new Error("test all evidence unavailable");
      }
      if (method === "createIndex") indexCalls++;
      if (collection === "agent_model_catalog" && ["insertOne", "updateOne"].includes(method)) mutationCalls++;
      return run();
    });
    expect(await new ModelCatalogStore(unavailable).applyDiscovery(started.attempt, [{ invalid: true }])).toMatchObject(
      {
        kind: "commit-unknown",
        operationId: started.attempt.attemptId,
      },
    );
    expect(indexCalls).toBe(0);
    expect(mutationCalls).toBe(0);

    expect((await delayed!()).acknowledged).toBe(true);
    const guard = new WriteGuard({ instanceId: "test", dbName: mongo.db.databaseName });
    guard.engage("private post-submission identity mismatch");
    expect(
      await new ModelCatalogStore(guardDb(mongo.db, guard)).applyDiscovery(started.attempt, [{ invalid: true }]),
    ).toMatchObject({
      kind: "committed",
      commitId: started.attempt.attemptId,
      recoveryPending: true,
    });
    expect(guard.refusedWriteCount).toBeGreaterThanOrEqual(1);
    expect(await mongo.db.collection("agent_model_catalog").countDocuments()).toBe(1);
    expect(await mongo.db.collection("agent_model_catalog_versions").countDocuments()).toBe(0);
    expect(await mongo.db.collection("agent_model_catalog_changes").countDocuments()).toBe(0);
    guard.disengage();
    expect(await new ModelCatalogStore(mongo.db).recoverPendingExports("codex")).toEqual([
      { provider: "codex", kind: "recovered" },
    ]);
  });

  it("sanitizes an initial acquisition read refusal without installing scan state", async () => {
    const base = new ModelCatalogStore(mongo.db);
    await base.ensureIndexes();
    const due = await base.readCatalogState("codex");
    let refused = false;
    const unreadable = new ModelCatalogStore(
      faultDb(mongo.db, async (collection, method, _args, run) => {
        if (!refused && collection === "agent_model_catalog" && method === "findOne") {
          refused = true;
          throw new Error("private database read detail");
        }
        return run();
      }),
    );
    await expect(
      unreadable.beginDiscoveryAttempt("codex", proposal(due.observed, await serverNow())),
    ).rejects.toMatchObject({
      safe: { code: "storage", message: "Model catalog codex: storage." },
    });
    expect(await mongo.db.collection("agent_model_catalog").countDocuments()).toBe(0);
    expect(await begin(new ModelCatalogStore(mongo.db))).toMatchObject({ kind: "started" });
  });

  it("returns retriable refusal after eight acknowledged CAS misses and safely retries the same proof", async () => {
    let refuse = true;
    let misses = 0;
    const db = faultDb(mongo.db, async (collection, method, args, run) => {
      if (refuse && collection === "agent_model_catalog" && method === "updateOne" && args[1].$set?.pendingExport) {
        misses++;
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      return run();
    });
    const store = new ModelCatalogStore(db);
    await store.replaceManual(input("model-a"));
    const started = await begin(store);
    if (started.kind !== "started") throw new Error("attempt did not start");
    expect(await store.applyDiscovery(started.attempt, discovered("model-b"))).toMatchObject({
      kind: "not-committed",
      retriable: true,
      error: { code: "storage" },
    });
    expect(misses).toBe(8);
    expect((await store.readCatalogState("codex")).snapshot).toMatchObject({
      revision: 1,
      models: [{ id: "model-a" }],
    });
    refuse = false;
    expect(await store.applyDiscovery(started.attempt, discovered("model-b"))).toMatchObject({
      kind: "committed",
      revision: 2,
      added: ["model-b"],
      removed: ["model-a"],
    });
  });

  it("makes concurrent fresh-store recoveries idempotent", async () => {
    let blockClear = true;
    const original = new ModelCatalogStore(
      faultDb(mongo.db, async (collection, method, args, run) => {
        if (
          blockClear &&
          collection === "agent_model_catalog" &&
          method === "updateOne" &&
          args[1].$unset?.pendingExport === ""
        ) {
          throw new Error("test clear unavailable");
        }
        return run();
      }),
    );
    expect(await original.replaceManual(input("model-a"))).toMatchObject({ kind: "committed", recoveryPending: true });
    blockClear = false;
    const [a, b] = await Promise.all([
      new ModelCatalogStore(mongo.db).recoverPendingExports("codex"),
      new ModelCatalogStore(mongo.db).recoverPendingExports("codex"),
    ]);
    expect([a[0].kind, b[0].kind].every((kind) => kind === "recovered")).toBe(true);
    expect(await mongo.db.collection("agent_model_catalog_versions").countDocuments()).toBe(1);
    expect(await mongo.db.collection("agent_model_catalog_changes").countDocuments()).toBe(1);
    expect((await original.readCatalogState("codex")).recoveryPending).toBe(false);
  });

  it("sanitizes initial index/acquisition and pending-recovery guard refusals, then retries", async () => {
    const guard = new WriteGuard({ instanceId: "test", dbName: mongo.db.databaseName });
    const guarded = guardDb(mongo.db, guard);
    const observed = await new ModelCatalogStore(guarded).readCatalogState("codex");
    guard.engage("private identity evidence");
    await expect(
      new ModelCatalogStore(guarded).beginDiscoveryAttempt("codex", proposal(observed.observed, await serverNow())),
    ).rejects.toMatchObject({ safe: { code: "storage", message: "Model catalog codex: storage." } });
    expect(guard.refusedWriteCount).toBe(2);
    guard.disengage();
    expect(await begin(new ModelCatalogStore(guarded))).toMatchObject({ kind: "started" });

    await clearDatabase();
    let blockHistory = true;
    const pending = new ModelCatalogStore(
      faultDb(mongo.db, async (collection, method, _args, run) => {
        if (blockHistory && collection === "agent_model_catalog_versions" && method === "insertOne") {
          throw new Error("test history unavailable");
        }
        return run();
      }),
    );
    await pending.replaceManual(input("model-a"));
    const recoveryGuard = new WriteGuard({ instanceId: "test", dbName: mongo.db.databaseName });
    const recoveryStore = new ModelCatalogStore(guardDb(mongo.db, recoveryGuard));
    recoveryGuard.engage("private recovery identity evidence");
    expect(await recoveryStore.recoverPendingExports("codex")).toMatchObject([
      { provider: "codex", kind: "pending", error: { code: "storage" } },
    ]);
    expect(recoveryGuard.refusedWriteCount).toBeGreaterThanOrEqual(1);
    expect((await recoveryStore.readCatalogState("codex")).recoveryPending).toBe(true);
    recoveryGuard.disengage();
    blockHistory = false;
    expect(await recoveryStore.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
  });

  it("guards every writer while reads remain available and diagnostics stay sanitized", async () => {
    const guard = new WriteGuard({ instanceId: "test", dbName: mongo.db.databaseName });
    const guarded = guardDb(mongo.db, guard);
    const store = new ModelCatalogStore(guarded);
    await store.ensureIndexes();
    await store.replaceManual(input("model-a"));
    const started = await begin(store);
    if (started.kind !== "started") throw new Error("attempt did not start");
    const before = await completeState(store);
    guard.engage("secret database mismatch detail");
    expect(await store.replaceManual(input("model-b"))).toMatchObject({
      kind: "not-committed",
      retriable: true,
      error: { code: "storage", message: "Model catalog codex: storage." },
    });
    expect(await store.applyDiscovery(started.attempt, discovered("model-a"))).toMatchObject({
      kind: "not-committed",
      retriable: true,
      error: { code: "storage" },
    });
    await expect(
      store.failDiscoveryAttempt(started.attempt, { code: "timeout", message: "raw" }, new Date()),
    ).rejects.toMatchObject({
      safe: { code: "storage" },
    });
    expect((await store.recoverPendingExports("codex"))[0]).toMatchObject({ kind: "recovered" });
    expect((await store.readCatalogState("codex")).snapshot).toEqual(before.catalog);
    expect(await completeState(store)).toEqual(before);
    expect(JSON.stringify(await completeState(store))).not.toContain("secret database mismatch detail");
    expect(guard.refusedWriteCount).toBeGreaterThanOrEqual(3);
  });

  it("runs the real manual handler through the guarded shared store", async () => {
    const guard = new WriteGuard({ instanceId: "test", dbName: mongo.db.databaseName });
    const tools = buildAdminTools({
      db: guardDb(mongo.db, guard),
      agentId: "integration-operator",
      instanceCapabilitiesJson: "{}",
    }) as any[];
    const handler = tools.find((tool) => tool.name === "agent_model_catalog_refresh")?.handler;
    expect(handler).toBeTypeOf("function");
    const result = await handler({
      provider: "codex",
      models: [{ id: "gpt-test", displayName: "GPT Test", notes: "operator note" }],
      changeSummary: "integration seed",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("codex catalog updated: +1 (gpt-test), -0");
    const state = await completeState(new ModelCatalogStore(mongo.db));
    expect(state.catalog).toMatchObject({
      updatedBy: "integration-operator",
      source: "manual",
      models: [{ id: "gpt-test", notes: "operator note" }],
    });
    expect(state.versions).toHaveLength(1);
    expect(state.changes).toHaveLength(1);
  });
});
