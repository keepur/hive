/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guardDb, WriteGuard } from "../db/write-guard.js";
import type { AcquisitionObservation, CatalogProvider, DiscoveredModel } from "./model-catalog-types.js";
import { CatalogError, safeError, snapshotId } from "./model-catalog-value.js";
import { ModelCatalogStore } from "./model-catalog-store.js";
import { ATTEMPT_LEASE_MS, ModelCatalogScanner } from "./model-catalog-scanner.js";
import { catalogStatus, SCAN_INTERVAL_MS } from "./model-catalog-status.js";
import { cloneBson, deferred, faultDb } from "./testing/catalog-db.test-support.js";
import { startStandaloneMongo } from "./testing/standalone-mongo.js";

const CATALOG = "agent_model_catalog";
const VERSIONS = "agent_model_catalog_versions";
const CHANGES = "agent_model_catalog_changes";
const PROVIDERS: CatalogProvider[] = ["claude", "grok", "codex"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const models = (...ids: string[]): DiscoveredModel[] =>
  ids.map((modelId) => ({ id: modelId, displayName: modelId.toUpperCase() }));

let mongo: Awaited<ReturnType<typeof startStandaloneMongo>>;

type Mutation = {
  provider: string;
  phase: "claim" | "changed" | "unchanged" | "failure" | "export-clear";
  attemptId?: string;
  matchedCount: number;
};

type StoredState = Awaited<ReturnType<typeof completeState>>;

const serverNow = async (): Promise<Date> => (await mongo.db.admin().command({ hello: 1 })).localTime;

async function waitForActualExpiry(leaseExpiresAt: Date): Promise<number> {
  const deadline = Date.now() + 8_000;
  while (true) {
    const server = await serverNow();
    const client = Date.now();
    if (server >= leaseExpiresAt && client >= leaseExpiresAt.getTime()) {
      return Math.max(server.getTime(), client);
    }
    if (Date.now() >= deadline) throw new Error("Owned Mongo lease did not expire within the bounded test window");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function recordMutations(db: Db, rows: Mutation[]): Db {
  return faultDb(db, async (collection, method, args, run) => {
    const result = await run();
    if (collection !== CATALOG || method !== "updateOne" || typeof result?.matchedCount !== "number") return result;
    const filter = args[0] ?? {},
      update = args[1] ?? {};
    let phase: Mutation["phase"] | undefined;
    if (update.$set?.["scan.outcome"] === "running") phase = "claim";
    else if (update.$set?.["scan.outcome"] === "failed") phase = "failure";
    else if (update.$set?.pendingExport) phase = "changed";
    else if (update.$set?.["scan.outcome"] === "succeeded") phase = "unchanged";
    else if (update.$unset?.pendingExport !== undefined) phase = "export-clear";
    if (phase) {
      rows.push({
        provider: String(filter._id),
        phase,
        attemptId: update.$set?.["scan.attemptId"] ?? filter["scan.attemptId"],
        matchedCount: result.matchedCount,
      });
    }
    return result;
  });
}

async function completeState(provider = "codex") {
  const [catalog, versions, changes] = await Promise.all([
    mongo.db.collection(CATALOG).findOne({ _id: provider } as never),
    mongo.db.collection(VERSIONS).find({ provider }).sort({ revision: 1, _id: 1 }).toArray(),
    mongo.db.collection(CHANGES).find({ provider }).sort({ revision: 1, _id: 1 }).toArray(),
  ]);
  return cloneBson({ catalog, versions, changes });
}

function expectAuditIntegrity(state: StoredState, customDelivery = false): void {
  const versions = new Map(state.versions.map((row: any) => [row._id, row]));
  let previous: any[] = [];
  for (const [index, version] of (state.versions as any[]).entries()) {
    expect(Object.keys(version).sort()).toEqual(
      [
        "_id",
        "added",
        "bootstrap",
        "changeSummary",
        "createdAt",
        "modelCount",
        "provider",
        "removed",
        "revision",
        "snapshot",
        "snapshotId",
        "source",
        "updatedBy",
      ].sort(),
    );
    expect(version.provider).toBe(state.catalog?.provider);
    expect(version.revision).toBe(index + 1);
    expect(version.createdAt).toBeInstanceOf(Date);
    expect(["manual", "discovery"]).toContain(version.source);
    if (version.source === "discovery") expect(version.updatedBy).toBe("system:model-catalog-scanner");
    else expect(version.updatedBy).toEqual(expect.any(String));
    expect(version.modelCount).toBe(version.snapshot.length);
    expect(version.snapshot.every((model: any) => model.addedAt instanceof Date)).toBe(true);
    expect(version.snapshotId).toBe(
      snapshotId(
        version.provider,
        version.snapshot.map(({ id: modelId, displayName, notes }: any) => ({
          id: modelId,
          displayName,
          ...(notes === undefined ? {} : { notes }),
        })),
      ),
    );
    const previousIds = new Set(previous.map((model) => model.id)),
      currentIds = new Set(version.snapshot.map((model: any) => model.id));
    expect(version.bootstrap).toBe(previous.length === 0);
    expect(version.added).toEqual(
      version.snapshot.filter((model: any) => !previousIds.has(model.id)).map((model: any) => model.id),
    );
    expect(version.removed).toEqual(previous.filter((model) => !currentIds.has(model.id)).map((model) => model.id));
    previous = version.snapshot;
  }
  for (const change of state.changes as any[]) {
    const version = versions.get(change._id) as any;
    expect(version).toBeDefined();
    const common = cloneBson(version);
    delete common.snapshot;
    delete common.changeSummary;
    if (customDelivery) {
      const immutable = cloneBson(change);
      delete immutable.delivery;
      expect(immutable).toEqual(common);
    } else {
      expect(change).toEqual({
        ...common,
        delivery: { state: "pending", attempts: 0, nextAttemptAt: common.createdAt },
      });
    }
  }
  for (const version of state.versions as any[]) {
    const shouldChange = version.bootstrap || version.added.length > 0 || version.removed.length > 0;
    expect(state.changes.some((row: any) => row._id === version._id)).toBe(shouldChange);
  }
  if (state.versions.length) {
    const latest = state.versions.at(-1) as any;
    expect(state.catalog).toMatchObject({
      provider: latest.provider,
      models: latest.snapshot,
      revision: latest.revision,
      commitId: latest._id,
      snapshotId: latest.snapshotId,
      source: latest.source,
      updatedBy: latest.updatedBy,
      updatedAt: latest.createdAt,
    });
  }
}

function expectNoSavedMutation(before: StoredState, after: StoredState): void {
  const stripScan = (doc: any) => {
    if (!doc) return doc;
    const copy = cloneBson(doc);
    delete copy.scan;
    return copy;
  };
  expect(stripScan(after.catalog)).toEqual(stripScan(before.catalog));
  expect(after.versions).toEqual(before.versions);
  expect(after.changes).toEqual(before.changes);
}

function scanner(
  store: ModelCatalogStore,
  discover: (provider: CatalogProvider, options: { signal: AbortSignal }) => Promise<DiscoveredModel[]>,
  now: () => number,
  options: Record<string, unknown> = {},
) {
  return new ModelCatalogScanner(store, discover, {
    now,
    logger: { info: vi.fn(), warn: vi.fn() },
    ...options,
  });
}

function proposal(observed: AcquisitionObservation, now: number, attemptId = randomUUID(), leaseMs = ATTEMPT_LEASE_MS) {
  return {
    attemptId,
    startedAt: new Date(now),
    leaseExpiresAt: new Date(now + leaseMs),
    observed,
  };
}

async function manual(
  provider: string,
  at: number,
  modelIds: string[] = ["old"],
  operationId = randomUUID(),
  options: { updatedBy?: string; notes?: string; db?: Db; plugin?: boolean; changeSummary?: string } = {},
) {
  const store = new ModelCatalogStore(options.db ?? mongo.db, {
    now: () => new Date(at),
    uuid: () => operationId,
    ...(options.plugin ? { listPluginProviderIds: () => [provider] } : {}),
  });
  const result = await store.replaceManual({
    provider,
    updatedBy: options.updatedBy ?? "test-operator",
    models: modelIds.map((modelId) => ({
      id: modelId,
      displayName: modelId.toUpperCase(),
      ...(options.notes ? { notes: options.notes } : {}),
    })),
    ...(options.changeSummary ? { changeSummary: options.changeSummary } : {}),
  });
  expect(result.kind).toBe("committed");
  return { store, result };
}

async function begin(
  store: ModelCatalogStore,
  provider: CatalogProvider,
  at: number,
  attemptId = randomUUID(),
  leaseMs = ATTEMPT_LEASE_MS,
) {
  const due = await store.readCatalogState(provider);
  const result = await store.beginDiscoveryAttempt(provider, proposal(due.observed, at, attemptId, leaseMs));
  expect(result.kind).toBe("started");
  if (result.kind !== "started") throw new Error(`${provider} did not acquire`);
  return result.attempt;
}

async function seedRecentSuccess(provider: CatalogProvider, at: number, n: number, modelId = `${provider}-old`) {
  const operationId = id(n),
    attemptId = id(n + 1);
  const { store } = await manual(provider, at, [modelId], operationId);
  const attempt = await begin(store, provider, at, attemptId);
  expect(await store.applyDiscovery(attempt, models(modelId))).toMatchObject({ kind: "unchanged" });
  return { store, attempt, operationId };
}

async function makeOtherProvidersRecent(at: number, target = "codex") {
  let n = 10;
  for (const provider of PROVIDERS) {
    if (provider !== target) await seedRecentSuccess(provider, at, n, `${provider}-old`);
    n += 10;
  }
}

type DueFixture = "seeded-overdue" | "missing" | "legacy-scanless" | "expired-running";

async function prepareDueState(fixture: DueFixture, at: number) {
  await makeOtherProvidersRecent(at);
  if (fixture === "missing") return completeState();
  await manual("codex", at, ["old"], id(30));
  if (fixture === "legacy-scanless") return completeState();
  if (fixture === "seeded-overdue") {
    const store = new ModelCatalogStore(mongo.db, { now: () => new Date(at) });
    const attempt = await begin(store, "codex", at, id(31));
    expect(await store.applyDiscovery(attempt, models("old"))).toMatchObject({ kind: "unchanged" });
    const overdue = new Date(at - SCAN_INTERVAL_MS - 1);
    await mongo.db.collection(CATALOG).updateOne(
      { _id: "codex" },
      {
        $set: {
          "scan.startedAt": overdue,
          "scan.finishedAt": overdue,
          "scan.lastSucceededAt": overdue,
        },
      },
    );
    return completeState();
  }
  await mongo.db.collection(CATALOG).updateOne(
    { _id: "codex" },
    {
      $set: {
        scan: {
          attemptId: id(32),
          startedAt: new Date(at - ATTEMPT_LEASE_MS - 2_000),
          leaseExpiresAt: new Date(at - 1_000),
          outcome: "running",
        },
      },
    },
  );
  return completeState();
}

function mutations(rows: Mutation[], provider: string, phase: Mutation["phase"]) {
  return rows.filter((row) => row.provider === provider && row.phase === phase);
}

async function resetDatabase(): Promise<void> {
  expect(mongo.db.databaseName).toMatch(/^hive_kpr459_test_/);
  await mongo.db.dropDatabase();
}

beforeAll(async () => {
  mongo = await startStandaloneMongo();
}, 30_000);
afterAll(async () => {
  await mongo?.close();
}, 30_000);
beforeEach(resetDatabase, 30_000);

describe("standalone scanner startup, cadence, and isolation", () => {
  it("commits startup changes, then records due unchanged success without moving saved-write time", async () => {
    let now = (await serverNow()).getTime();
    const writes: Mutation[] = [];
    const store = new ModelCatalogStore(recordMutations(mongo.db, writes), { now: () => new Date(now) });
    const discover = vi.fn(async (provider: CatalogProvider) => models(`${provider}-model`));
    const subject = scanner(store, discover, () => now);
    try {
      await subject.tick();
      expect(discover.mock.calls.map(([provider]) => provider).sort()).toEqual([...PROVIDERS].sort());
      const first = new Map<string, StoredState>();
      for (const provider of PROVIDERS) {
        const state = await completeState(provider);
        first.set(provider, state);
        expect(state.catalog).toEqual({
          _id: provider,
          provider,
          models: [
            {
              id: `${provider}-model`,
              displayName: `${provider}-model`.toUpperCase(),
              addedAt: new Date(now),
            },
          ],
          revision: 1,
          commitId: state.catalog!.scan.attemptId,
          snapshotId: state.catalog!.snapshotId,
          source: "discovery",
          updatedBy: "system:model-catalog-scanner",
          updatedAt: new Date(now),
          scan: {
            attemptId: state.catalog!.scan.attemptId,
            startedAt: new Date(now),
            finishedAt: new Date(now),
            outcome: "succeeded",
            lastSucceededAt: new Date(now),
          },
        });
        expect(state.versions).toHaveLength(1);
        expect(state.changes).toHaveLength(1);
        expectAuditIntegrity(state);
        expect(mutations(writes, provider, "claim")).toEqual([
          expect.objectContaining({ matchedCount: 1, attemptId: state.catalog!.scan.attemptId }),
        ]);
        expect(mutations(writes, provider, "changed")).toEqual([
          expect.objectContaining({ matchedCount: 1, attemptId: state.catalog!.scan.attemptId }),
        ]);
        expect(state.catalog!.updatedAt).toEqual(state.catalog!.scan.lastSucceededAt);
      }

      now += SCAN_INTERVAL_MS - 1;
      await subject.tick();
      expect(discover).toHaveBeenCalledTimes(3);
      now++;
      await subject.tick();
      expect(discover).toHaveBeenCalledTimes(6);
      for (const provider of PROVIDERS) {
        const before = first.get(provider)!;
        const after = await completeState(provider);
        expect(after.catalog).toEqual({
          ...before.catalog,
          scan: {
            attemptId: after.catalog!.scan.attemptId,
            startedAt: new Date(now),
            finishedAt: new Date(now),
            outcome: "succeeded",
            lastSucceededAt: new Date(now),
          },
        });
        expect(after.versions).toEqual(before.versions);
        expect(after.changes).toEqual(before.changes);
        expect(after.catalog!.updatedAt).toEqual(before.catalog!.updatedAt);
        expect(after.catalog!.updatedAt).not.toEqual(after.catalog!.scan.lastSucceededAt);
        expect(mutations(writes, provider, "claim").map(({ matchedCount }) => matchedCount)).toEqual([1, 1]);
        expect(mutations(writes, provider, "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        expect(mutations(writes, provider, "unchanged").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        expectAuditIntegrity(after);
      }
    } finally {
      await subject.stop();
    }
  }, 30_000);

  it("rebases a manual edit during discovery, retains notes, and keeps the original cadence", async () => {
    let now = (await serverNow()).getTime();
    await prepareDueState("seeded-overdue", now);
    const writes: Mutation[] = [];
    const entered = deferred<void>(),
      release = deferred<void>();
    let held = false;
    const store = new ModelCatalogStore(recordMutations(mongo.db, writes), { now: () => new Date(now) });
    const discover = vi.fn(async (provider: CatalogProvider) => {
      if (provider === "codex" && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return models(provider === "codex" ? "old" : `${provider}-old`);
    });
    const subject = scanner(store, discover, () => now);
    const tick = subject.tick();
    try {
      await entered.promise;
      const originalAttempt = mutations(writes, "codex", "claim")[0].attemptId;
      now++;
      const manualAt = new Date(now);
      const editor = new ModelCatalogStore(mongo.db, { now: () => new Date(now), uuid: () => id(40) });
      expect(
        await editor.replaceManual({
          provider: "codex",
          updatedBy: "operator",
          models: [{ id: "old", displayName: "MANUAL", notes: "operator note" }],
        }),
      ).toMatchObject({ kind: "committed", revision: 2 });
      release.resolve();
      await tick;
      const completed = await completeState();
      expect(completed.catalog).toEqual({
        _id: "codex",
        provider: "codex",
        models: [
          { id: "old", displayName: "OLD", notes: "operator note", addedAt: completed.catalog!.models[0].addedAt },
        ],
        revision: 3,
        commitId: originalAttempt,
        snapshotId: completed.catalog!.snapshotId,
        source: "discovery",
        updatedBy: "system:model-catalog-scanner",
        updatedAt: manualAt,
        scan: {
          attemptId: originalAttempt,
          startedAt: new Date(manualAt.getTime() - 1),
          finishedAt: manualAt,
          outcome: "succeeded",
          lastSucceededAt: manualAt,
        },
      });
      expect(completed.versions).toHaveLength(3);
      expect(completed.changes).toHaveLength(1);
      expectAuditIntegrity(completed);
      expect(mutations(writes, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      expect(mutations(writes, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);

      const attemptStart = completed.catalog!.scan.startedAt.getTime();
      now = attemptStart + SCAN_INTERVAL_MS - 1;
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      now++;
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(2);
      const next = await completeState();
      expect(next.catalog!.updatedAt).toEqual(manualAt);
      expect(next.catalog!.scan).toEqual({
        attemptId: next.catalog!.scan.attemptId,
        startedAt: new Date(now),
        finishedAt: new Date(now),
        outcome: "succeeded",
        lastSucceededAt: new Date(now),
      });
      expect(next.versions).toEqual(completed.versions);
      expect(next.changes).toEqual(completed.changes);
    } finally {
      release.resolve();
      await tick;
      await subject.stop();
    }
  }, 30_000);

  it("isolates a failed provider while the other real provider lanes complete", async () => {
    const now = (await serverNow()).getTime();
    for (const [index, provider] of PROVIDERS.entries()) {
      await seedRecentSuccess(provider, now, 50 + index * 10, `${provider}-old`);
      const overdue = new Date(now - SCAN_INTERVAL_MS - 1);
      await mongo.db
        .collection(CATALOG)
        .updateOne(
          { _id: provider },
          { $set: { "scan.startedAt": overdue, "scan.finishedAt": overdue, "scan.lastSucceededAt": overdue } },
        );
    }
    const before = await completeState("codex");
    const writes: Mutation[] = [];
    const discover = vi.fn(async (provider: CatalogProvider) => {
      if (provider === "codex") throw new CatalogError(safeError(provider, "auth"));
      return models(`${provider}-new`);
    });
    const subject = scanner(
      new ModelCatalogStore(recordMutations(mongo.db, writes), { now: () => new Date(now) }),
      discover,
      () => now,
    );
    try {
      await subject.tick();
      const failed = await completeState("codex");
      expectNoSavedMutation(before, failed);
      expect(failed.catalog!.scan).toEqual({
        attemptId: failed.catalog!.scan.attemptId,
        startedAt: new Date(now),
        finishedAt: new Date(now),
        outcome: "failed",
        lastSucceededAt: before.catalog!.scan.lastSucceededAt,
        error: safeError("codex", "auth"),
      });
      for (const provider of PROVIDERS) {
        expect(mutations(writes, provider, "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        if (provider === "codex") {
          expect(mutations(writes, provider, "failure").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        } else {
          const state = await completeState(provider);
          expect(state.catalog!.scan).toEqual({
            attemptId: state.catalog!.scan.attemptId,
            startedAt: new Date(now),
            finishedAt: new Date(now),
            outcome: "succeeded",
            lastSucceededAt: new Date(now),
          });
          expect(state.catalog!.models.map((row: any) => row.id)).toEqual([`${provider}-new`]);
          expect(state.versions).toHaveLength(2);
          expect(state.changes).toHaveLength(2);
          expect(mutations(writes, provider, "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
          expectAuditIntegrity(state);
        }
      }
      expectAuditIntegrity(failed);
    } finally {
      await subject.stop();
    }
  }, 30_000);
});

describe("standalone two-reader exact-observation matrix", () => {
  const schedules = (["seeded-overdue", "missing", "legacy-scanless", "expired-running"] as DueFixture[]).flatMap(
    (fixture) => (["changed", "unchanged", "failure"] as const).map((outcome) => ({ fixture, outcome })),
  );

  it.each(schedules)(
    "$fixture predecessor $outcome makes B's delegated conditional claim miss",
    async ({ fixture, outcome }) => {
      const now = (await serverNow()).getTime();
      const initial = await prepareDueState(fixture, now);
      const aWrites: Mutation[] = [],
        bWrites: Mutation[] = [];
      const aId = id(70),
        bId = id(71),
        entered = deferred<void>(),
        release = deferred<void>();
      const bDb = faultDb(recordMutations(mongo.db, bWrites), async (collection, method, args, run) => {
        if (collection === CATALOG && method === "updateOne" && args[1]?.$set?.["scan.attemptId"] === bId) {
          entered.resolve();
          await release.promise;
        }
        return run();
      });
      const aDiscover = vi.fn(async (provider: CatalogProvider) => {
        if (provider === "codex" && outcome === "failure") throw new CatalogError(safeError(provider, "auth"));
        if (provider === "codex" && outcome === "unchanged" && fixture !== "missing") return models("old");
        return models(provider === "codex" ? "new" : `${provider}-old`);
      });
      const bDiscover = vi.fn(async (provider: CatalogProvider) => models(`${provider}-b`));
      const a = scanner(
        new ModelCatalogStore(recordMutations(mongo.db, aWrites), { now: () => new Date(now) }),
        aDiscover,
        () => now,
        { uuid: () => aId },
      );
      const b = scanner(new ModelCatalogStore(bDb, { now: () => new Date(now) }), bDiscover, () => now, {
        uuid: () => bId,
      });
      const bTick = b.tick();
      try {
        await entered.promise;
        await a.tick();
        const completed = await completeState();
        const changed = outcome === "changed" || (fixture === "missing" && outcome === "unchanged");
        if (outcome === "failure") {
          if (fixture === "missing") {
            expect(completed.versions).toEqual([]);
            expect(completed.changes).toEqual([]);
            expect(completed.catalog).toMatchObject({ _id: "codex", provider: "codex" });
          } else {
            expectNoSavedMutation(initial, completed);
          }
          expect(completed.catalog!.scan).toEqual({
            attemptId: aId,
            startedAt: new Date(now),
            finishedAt: new Date(now),
            outcome: "failed",
            ...(initial.catalog?.scan?.lastSucceededAt
              ? { lastSucceededAt: initial.catalog.scan.lastSucceededAt }
              : {}),
            error: safeError("codex", "auth"),
          });
          expect(mutations(aWrites, "codex", "failure").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        } else {
          expect(completed.catalog!.scan).toEqual({
            attemptId: aId,
            startedAt: new Date(now),
            finishedAt: new Date(now),
            outcome: "succeeded",
            lastSucceededAt: new Date(now),
          });
          expect(completed.catalog!.models.map((row: any) => row.id)).toEqual([changed ? "new" : "old"]);
          expect(completed.versions).toHaveLength(initial.versions.length + (changed ? 1 : 0));
          expect(completed.changes).toHaveLength(initial.changes.length + (changed ? 1 : 0));
          expect(
            mutations(aWrites, "codex", changed ? "changed" : "unchanged").map(({ matchedCount }) => matchedCount),
          ).toEqual([1]);
          if (fixture === "missing" && outcome === "unchanged") {
            expect(completed.versions[0]).toMatchObject({ bootstrap: true, added: ["new"], removed: [] });
          }
        }
        expect(mutations(aWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        expectAuditIntegrity(completed);
        release.resolve();
        await bTick;
        expect(mutations(bWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([0]);
        expect(bDiscover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(await completeState()).toEqual(completed);
        await b.tick();
        expect(mutations(bWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([0]);
        expect(bDiscover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(await completeState()).toEqual(completed);
      } finally {
        release.resolve();
        await bTick;
        await Promise.all([a.stop(), b.stop()]);
      }
    },
    30_000,
  );
});

describe("standalone acquisition observation scope", () => {
  it("invalidates a missing observation when a manual first seed wins before the real claim", async () => {
    const now = (await serverNow()).getTime();
    await makeOtherProvidersRecent(now);
    const writes: Mutation[] = [];
    const scannerId = id(80),
      manualId = id(81);
    let edited = false;
    const db = faultDb(recordMutations(mongo.db, writes), async (collection, method, args, run) => {
      if (
        !edited &&
        collection === CATALOG &&
        method === "updateOne" &&
        args[1]?.$set?.["scan.attemptId"] === scannerId
      ) {
        edited = true;
        await manual("codex", now, ["manual-first"], manualId, { updatedBy: "operator" });
      }
      return run();
    });
    const discover = vi.fn(async () => models("vendor"));
    const subject = scanner(new ModelCatalogStore(db, { now: () => new Date(now) }), discover, () => now, {
      uuid: () => scannerId,
    });
    try {
      await subject.tick();
      const state = await completeState();
      expect(mutations(writes, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([0]);
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(state.catalog).toEqual({
        _id: "codex",
        provider: "codex",
        models: [{ id: "manual-first", displayName: "MANUAL-FIRST", addedAt: new Date(now) }],
        revision: 1,
        commitId: manualId,
        snapshotId: state.catalog!.snapshotId,
        source: "manual",
        updatedBy: "operator",
        updatedAt: new Date(now),
      });
      expect(state.versions).toHaveLength(1);
      expect(state.changes).toHaveLength(1);
      expectAuditIntegrity(state);
    } finally {
      await subject.stop();
    }
  }, 30_000);

  it.each(["seeded-edit", "pending-export-clear"] as const)(
    "keeps the scanner's original due observation eligible across a real %s",
    async (action) => {
      const now = (await serverNow()).getTime();
      await prepareDueState("seeded-overdue", now);
      const writes: Mutation[] = [];
      const scannerId = id(82),
        editorId = id(83);
      const initial = await completeState();
      let intervened = false,
        clearMatched = -1;
      const cleared = deferred<void>();
      if (action === "pending-export-clear") {
        let block = true;
        const interrupted = faultDb(mongo.db, async (collection, method, args, run) => {
          if (block && collection === VERSIONS && method === "insertOne" && args[0]?._id === editorId) {
            block = false;
            throw new Error("test projection unavailable");
          }
          return run();
        });
        expect(
          (
            await manual("codex", now, ["old"], editorId, {
              updatedBy: "export-editor",
              db: interrupted,
              changeSummary: "pending exact export",
            })
          ).result,
        ).toMatchObject({ recoveryPending: true });
      }
      const beforeClaim = await completeState();
      const db = faultDb(recordMutations(mongo.db, writes), async (collection, method, args, run) => {
        const isClear =
          action === "pending-export-clear" &&
          collection === CATALOG &&
          method === "updateOne" &&
          args[1]?.$unset?.pendingExport !== undefined;
        if (isClear) {
          const result = await run();
          clearMatched = result.matchedCount;
          cleared.resolve();
          return result;
        }
        if (
          !intervened &&
          collection === CATALOG &&
          method === "updateOne" &&
          args[1]?.$set?.["scan.attemptId"] === scannerId
        ) {
          intervened = true;
          if (action === "seeded-edit") {
            const editor = new ModelCatalogStore(mongo.db, { now: () => new Date(now), uuid: () => editorId });
            expect(
              await editor.replaceManual({
                provider: "codex",
                updatedBy: "operator",
                models: [{ id: "old", displayName: "MANUAL", notes: "retain this note" }],
              }),
            ).toMatchObject({ kind: "committed" });
          } else {
            await cleared.promise;
          }
        }
        return run();
      });
      const discover = vi.fn(async (provider: CatalogProvider) =>
        models(provider === "codex" ? "old" : `${provider}-old`),
      );
      const subject = scanner(new ModelCatalogStore(db, { now: () => new Date(now) }), discover, () => now, {
        uuid: () => scannerId,
      });
      try {
        await subject.tick();
        const state = await completeState();
        expect(mutations(writes, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
        expect(state.catalog!.scan).toEqual({
          attemptId: scannerId,
          startedAt: new Date(now),
          finishedAt: new Date(now),
          outcome: "succeeded",
          lastSucceededAt: new Date(now),
        });
        expect(state.catalog!.models).toEqual([
          {
            id: "old",
            displayName: "OLD",
            ...(action === "seeded-edit" ? { notes: "retain this note" } : {}),
            addedAt: state.catalog!.models[0].addedAt,
          },
        ]);
        if (action === "seeded-edit") {
          expect(state.versions).toHaveLength(initial.versions.length + 2);
          expect(state.changes).toEqual(initial.changes);
          expect(mutations(writes, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        } else {
          expect(clearMatched).toBe(1);
          expect(state.catalog).not.toHaveProperty("pendingExport");
          expect(state.versions).toHaveLength(beforeClaim.versions.length + 1);
          expect(state.changes).toEqual(beforeClaim.changes);
          expect(mutations(writes, "codex", "unchanged").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        }
        expectAuditIntegrity(state);
      } finally {
        cleared.resolve();
        await subject.stop();
      }
    },
    30_000,
  );
});

describe("standalone proposal and acknowledgment clocks", () => {
  it.each(["no-successor", "successor"] as const)(
    "gets a real zero match when delegation waits past actual proposal expiry: %s",
    async (mode) => {
      let now = (await serverNow()).getTime();
      await makeOtherProvidersRecent(now);
      const writes: Mutation[] = [],
        successorWrites: Mutation[] = [],
        attemptId = id(90),
        entered = deferred<void>(),
        release = deferred<void>();
      let leaseExpiresAt: Date | undefined;
      const delayed = faultDb(recordMutations(mongo.db, writes), async (collection, method, args, run) => {
        if (collection === CATALOG && method === "updateOne" && args[1]?.$set?.["scan.attemptId"] === attemptId) {
          leaseExpiresAt = cloneBson(args[1].$set["scan.leaseExpiresAt"]);
          entered.resolve();
          await release.promise;
        }
        return run();
      });
      const discover = vi.fn(async () => models("expired-proposal"));
      const subject = scanner(new ModelCatalogStore(delayed, { now: () => new Date(now) }), discover, () => now, {
        uuid: () => attemptId,
        leaseMs: 700,
      });
      const tick = subject.tick();
      let successor: ModelCatalogScanner | undefined;
      try {
        await entered.promise;
        expect(leaseExpiresAt).toBeDefined();
        now = await waitForActualExpiry(leaseExpiresAt!);
        if (mode === "successor") {
          successor = scanner(
            new ModelCatalogStore(recordMutations(mongo.db, successorWrites), { now: () => new Date(now) }),
            async (provider) => models(`${provider}-successor`),
            () => now,
            { uuid: () => id(91) },
          );
          await successor.tick();
          const won = await completeState();
          expect(won.catalog!.scan).toEqual({
            attemptId: id(91),
            startedAt: new Date(now),
            finishedAt: new Date(now),
            outcome: "succeeded",
            lastSucceededAt: new Date(now),
          });
          expect(won.catalog!.models.map((row: any) => row.id)).toEqual(["codex-successor"]);
          expect(mutations(successorWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
          expect(mutations(successorWrites, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        }
        const beforeRelease = await completeState();
        release.resolve();
        await tick;
        expect(mutations(writes, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([0]);
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(await completeState()).toEqual(beforeRelease);
        if (mode === "no-successor") {
          expect(beforeRelease).toEqual({
            catalog: { _id: "codex", provider: "codex" },
            versions: [],
            changes: [],
          });
        } else {
          expectAuditIntegrity(beforeRelease);
        }
      } finally {
        release.resolve();
        await tick;
        await Promise.all([subject.stop(), successor?.stop()]);
      }
    },
    30_000,
  );

  it.each(["active-after-local-expiry", "stop-and-drain"] as const)(
    "keeps a real matched claim unchanged after its acknowledgment is held: %s",
    async (mode) => {
      let now = (await serverNow()).getTime();
      await makeOtherProvidersRecent(now);
      const writes: Mutation[] = [],
        heldId = id(92),
        entered = deferred<void>(),
        release = deferred<void>();
      let matched = -1;
      const delayed = faultDb(recordMutations(mongo.db, writes), async (collection, method, args, run) => {
        if (collection === CATALOG && method === "updateOne" && args[1]?.$set?.["scan.attemptId"] === heldId) {
          const result = await run();
          matched = result.matchedCount;
          entered.resolve();
          await release.promise;
          return result;
        }
        return run();
      });
      const store = new ModelCatalogStore(delayed, { now: () => new Date(now) });
      const apply = vi.spyOn(store, "applyDiscovery"),
        failure = vi.spyOn(store, "failDiscoveryAttempt");
      const discover = vi.fn(async () => models("must-not-run"));
      const subject = scanner(store, discover, () => now, { uuid: () => heldId, drainMs: 0 });
      const tick = subject.tick();
      try {
        await entered.promise;
        expect(matched).toBe(1);
        const accepted = await completeState();
        expect(accepted).toEqual({
          catalog: {
            _id: "codex",
            provider: "codex",
            scan: {
              attemptId: heldId,
              startedAt: new Date(now),
              leaseExpiresAt: new Date(now + ATTEMPT_LEASE_MS),
              outcome: "running",
            },
          },
          versions: [],
          changes: [],
        });
        if (mode === "stop-and-drain") await subject.stop();
        now += ATTEMPT_LEASE_MS + 1;
        release.resolve();
        await tick;
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(apply.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
        expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
        expect(await completeState()).toEqual(accepted);
        expect(mutations(writes, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      } finally {
        release.resolve();
        await tick;
        await subject.stop();
      }
    },
    30_000,
  );
});

describe("standalone ambiguous completion reconciliation", () => {
  it.each([
    ["changed", "negative"],
    ["unchanged", "unavailable"],
    ["changed", "recovery-failure"],
    ["changed", "guard-rejection"],
  ] as const)(
    "retains one %s completion UUID through %s evidence and resolves only after the real mutation",
    async (shape, evidence) => {
      const now = (await serverNow()).getTime();
      const initial = await prepareDueState("seeded-overdue", now);
      const writes: Mutation[] = [],
        attemptId = id(100),
        release = deferred<void>();
      const guard = new WriteGuard({ instanceId: "integration", dbName: mongo.db.databaseName });
      let detached: Promise<any> | undefined,
        obstruct = false,
        recoveryId: string | undefined;
      const base = evidence === "guard-rejection" ? guardDb(mongo.db, guard) : mongo.db;
      const db = faultDb(recordMutations(base, writes), async (collection, method, args, run) => {
        const changed =
            shape === "changed" &&
            collection === CATALOG &&
            method === "updateOne" &&
            args[0]?.["scan.attemptId"] === attemptId &&
            args[1]?.$set?.pendingExport,
          unchanged =
            shape === "unchanged" &&
            collection === CATALOG &&
            method === "updateOne" &&
            args[0]?.["scan.attemptId"] === attemptId &&
            args[1]?.$set?.["scan.outcome"] === "succeeded" &&
            !args[1]?.$set?.pendingExport;
        if (!detached && (changed || unchanged)) {
          detached = release.promise.then(run);
          void detached.catch(() => {});
          throw new Error("test completion acknowledgment unavailable");
        }
        if (obstruct && evidence === "unavailable") {
          if (collection === CATALOG && method === "findOne" && args[0]?._id === "codex") {
            throw new Error("test catalog evidence unavailable");
          }
          if (collection === VERSIONS && method === "findOne") throw new Error("test history evidence unavailable");
        }
        if (
          obstruct &&
          evidence === "recovery-failure" &&
          collection === VERSIONS &&
          method === "insertOne" &&
          args[0]?._id === recoveryId
        ) {
          throw new Error("test recovery projection unavailable");
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => new Date(now) });
      const beginSpy = vi.spyOn(store, "beginDiscoveryAttempt"),
        applySpy = vi.spyOn(store, "applyDiscovery"),
        failureSpy = vi.spyOn(store, "failDiscoveryAttempt");
      const allocated: string[] = [];
      const discover = vi.fn(async (provider: CatalogProvider) =>
        models(provider === "codex" ? (shape === "changed" ? "new" : "old") : `${provider}-old`),
      );
      const subject = scanner(store, discover, () => now, {
        uuid: () => {
          allocated.push(attemptId);
          return attemptId;
        },
      });
      try {
        await subject.tick();
        expect(detached).toBeDefined();
        const unknown = await completeState();
        expectNoSavedMutation(initial, unknown);
        expect(unknown.catalog!.scan).toEqual({
          attemptId,
          startedAt: new Date(now),
          leaseExpiresAt: new Date(now + ATTEMPT_LEASE_MS),
          outcome: "running",
          lastSucceededAt: initial.catalog!.scan.lastSucceededAt,
        });
        expect(mutations(writes, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        expect(mutations(writes, "codex", shape === "changed" ? "changed" : "unchanged")).toEqual([]);

        if (evidence === "recovery-failure" || evidence === "guard-rejection") {
          recoveryId = id(evidence === "recovery-failure" ? 101 : 102);
          let project = true;
          const interrupted = faultDb(mongo.db, async (collection, method, args, run) => {
            if (project && collection === VERSIONS && method === "insertOne" && args[0]?._id === recoveryId) {
              project = false;
              throw new Error("test initial plugin projection unavailable");
            }
            return run();
          });
          expect(
            (
              await manual("sol", now, ["sol-pending"], recoveryId, {
                plugin: true,
                db: interrupted,
                updatedBy: "plugin-operator",
              })
            ).result,
          ).toMatchObject({ recoveryPending: true });
        }
        obstruct = true;
        if (evidence === "guard-rejection") guard.engage("test current identity mismatch");
        await subject.tick();
        expect(beginSpy.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
        expect(allocated).toEqual([attemptId]);
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
        expect(applySpy.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(2);
        expect(applySpy.mock.calls.at(-1)?.[1]).toEqual([]);
        expect(failureSpy.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
        expect(await completeState()).toEqual(unknown);
        if (evidence === "recovery-failure" || evidence === "guard-rejection") {
          expect((await completeState("sol")).catalog).toHaveProperty("pendingExport");
        }
        if (evidence === "guard-rejection") expect(guard.refusedWriteCount).toBeGreaterThan(0);

        obstruct = false;
        guard.disengage();
        const lease = unknown.catalog!.scan.leaseExpiresAt as Date;
        expect((await serverNow()).getTime()).toBeLessThan(lease.getTime());
        release.resolve();
        expect((await detached!).matchedCount).toBe(1);
        await subject.tick();
        const resolved = await completeState();
        expect(resolved.catalog!.scan).toEqual({
          attemptId,
          startedAt: new Date(now),
          finishedAt: new Date(now),
          outcome: "succeeded",
          lastSucceededAt: new Date(now),
        });
        expect(resolved.catalog!.models.map((row: any) => row.id)).toEqual([shape === "changed" ? "new" : "old"]);
        expect(resolved.versions).toHaveLength(initial.versions.length + (shape === "changed" ? 1 : 0));
        expect(resolved.changes).toHaveLength(initial.changes.length + (shape === "changed" ? 1 : 0));
        expect(
          mutations(writes, "codex", shape === "changed" ? "changed" : "unchanged").map(
            ({ matchedCount }) => matchedCount,
          ),
        ).toEqual([1]);
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
        expect(failureSpy.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
        expectAuditIntegrity(resolved);
        if (recoveryId) {
          const plugin = await completeState("sol");
          expect(plugin.catalog).not.toHaveProperty("pendingExport");
          expect(plugin.versions).toHaveLength(1);
          expect(plugin.changes).toHaveLength(1);
          expectAuditIntegrity(plugin);
        }
      } finally {
        obstruct = false;
        guard.disengage();
        release.resolve();
        await detached?.catch(() => {});
        await subject.stop();
      }
    },
    30_000,
  );
});

describe("standalone restart, takeover, and obsolete operations", () => {
  it("waits for a real active lease, then takes over the actually expired token with a fresh UUID", async () => {
    let now = (await serverNow()).getTime();
    await makeOtherProvidersRecent(now);
    const { store: oldStore } = await manual("codex", now, ["old"], id(110));
    const oldAttempt = await begin(oldStore, "codex", now, id(111), 1_000);
    const active = await completeState();
    const writes: Mutation[] = [],
      allocated: string[] = [];
    const discover = vi.fn(async () => models("successor"));
    const subject = scanner(
      new ModelCatalogStore(recordMutations(mongo.db, writes), { now: () => new Date(now) }),
      discover,
      () => now,
      {
        uuid: () => {
          const value = id(112);
          allocated.push(value);
          return value;
        },
      },
    );
    try {
      await subject.tick();
      expect(allocated).toEqual([]);
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(await completeState()).toEqual(active);

      now = await waitForActualExpiry(oldAttempt.leaseExpiresAt);
      await subject.tick();
      const completed = await completeState();
      expect(allocated).toEqual([id(112)]);
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      expect(completed.catalog!.scan).toEqual({
        attemptId: id(112),
        startedAt: new Date(now),
        finishedAt: new Date(now),
        outcome: "succeeded",
        lastSucceededAt: new Date(now),
      });
      expect(completed.catalog!.models.map((row: any) => row.id)).toEqual(["successor"]);
      expect(completed.versions).toHaveLength(2);
      expect(completed.changes).toHaveLength(2);
      expect(mutations(writes, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      expect(mutations(writes, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      expectAuditIntegrity(completed);
    } finally {
      await subject.stop();
    }
  }, 30_000);

  it.each(["shell", "claim", "success", "failure"] as const)(
    "fences a detached old %s mutation released after a real successor completes",
    async (operation) => {
      let now = (await serverNow()).getTime();
      await makeOtherProvidersRecent(now);
      const oldWrites: Mutation[] = [],
        successorWrites: Mutation[] = [],
        oldId = id(120),
        successorId = id(121),
        release = deferred<void>();
      let detached: Promise<any> | undefined;
      const delayed = faultDb(recordMutations(mongo.db, oldWrites), async (collection, method, args, run) => {
        const target =
          (operation === "shell" && collection === CATALOG && method === "insertOne" && args[0]?._id === "codex") ||
          (operation === "claim" &&
            collection === CATALOG &&
            method === "updateOne" &&
            args[1]?.$set?.["scan.attemptId"] === oldId) ||
          (operation === "success" &&
            collection === CATALOG &&
            method === "updateOne" &&
            args[0]?.["scan.attemptId"] === oldId &&
            args[1]?.$set?.pendingExport) ||
          (operation === "failure" &&
            collection === CATALOG &&
            method === "updateOne" &&
            args[0]?.["scan.attemptId"] === oldId &&
            args[1]?.$set?.["scan.outcome"] === "failed");
        if (target && !detached) {
          detached = release.promise.then(run);
          void detached.catch(() => {});
          throw new Error(`test detached old ${operation}`);
        }
        return run();
      });
      if (operation === "success" || operation === "failure") {
        await manual("codex", now, ["old"], id(122));
      }
      const oldDiscover = vi.fn(async (provider: CatalogProvider) => {
        if (provider === "codex" && operation === "failure") throw new CatalogError(safeError(provider, "auth"));
        return models(provider === "codex" ? "obsolete" : `${provider}-old`);
      });
      const old = scanner(new ModelCatalogStore(delayed, { now: () => new Date(now) }), oldDiscover, () => now, {
        uuid: () => oldId,
        leaseMs: 900,
      });
      let oldTick: Promise<void> | undefined;
      let successor: ModelCatalogScanner | undefined;
      try {
        oldTick = old.tick();
        await oldTick;
        expect(detached).toBeDefined();
        if (operation === "success" || operation === "failure") {
          const running = await completeState();
          expect(running.catalog!.scan).toMatchObject({ attemptId: oldId, outcome: "running" });
          now = await waitForActualExpiry(running.catalog!.scan.leaseExpiresAt);
        }
        successor = scanner(
          new ModelCatalogStore(recordMutations(mongo.db, successorWrites), { now: () => new Date(now) }),
          async (provider) => models(`${provider}-successor`),
          () => now,
          { uuid: () => successorId },
        );
        await successor.tick();
        const completed = await completeState();
        expect(completed.catalog!.scan).toEqual({
          attemptId: successorId,
          startedAt: new Date(now),
          finishedAt: new Date(now),
          outcome: "succeeded",
          lastSucceededAt: new Date(now),
        });
        expect(completed.catalog!.models.map((row: any) => row.id)).toEqual(["codex-successor"]);
        expect(mutations(successorWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        expect(mutations(successorWrites, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        release.resolve();
        if (operation === "shell") {
          await expect(detached).rejects.toMatchObject({ code: 11000 });
        } else {
          expect((await detached!).matchedCount).toBe(0);
          const phase = operation === "claim" ? "claim" : operation === "success" ? "changed" : "failure";
          expect(mutations(oldWrites, "codex", phase).map(({ matchedCount }) => matchedCount)).toEqual([0]);
        }
        expect(await completeState()).toEqual(completed);
        expectAuditIntegrity(completed);
      } finally {
        release.resolve();
        await detached?.catch(() => {});
        await oldTick?.catch(() => {});
        await Promise.all([old.stop(), successor?.stop()]);
      }
    },
    30_000,
  );

  it("rejects takeover when the predecessor completes between the fresh read and claim delegation", async () => {
    const base = (await serverNow()).getTime();
    let now = base;
    await makeOtherProvidersRecent(base);
    const oldWrites: Mutation[] = [],
      takeoverWrites: Mutation[] = [];
    const { store: seeded } = await manual("codex", base, ["old"], id(130));
    const oldStore = new ModelCatalogStore(recordMutations(mongo.db, oldWrites), { now: () => new Date(base) });
    const oldAttempt = await begin(oldStore, "codex", base, id(131), 10_000);
    now = oldAttempt.leaseExpiresAt.getTime();
    const takeoverId = id(132);
    let completedBetween = false;
    const delayed = faultDb(recordMutations(mongo.db, takeoverWrites), async (collection, method, args, run) => {
      if (
        !completedBetween &&
        collection === CATALOG &&
        method === "updateOne" &&
        args[1]?.$set?.["scan.attemptId"] === takeoverId
      ) {
        completedBetween = true;
        expect(await oldStore.applyDiscovery(oldAttempt, models("late-predecessor"))).toMatchObject({
          kind: "committed",
        });
      }
      return run();
    });
    const discover = vi.fn(async () => models("must-not-run"));
    const subject = scanner(new ModelCatalogStore(delayed, { now: () => new Date(now) }), discover, () => now, {
      uuid: () => takeoverId,
    });
    try {
      await subject.tick();
      const completed = await completeState();
      expect(completedBetween).toBe(true);
      expect(mutations(oldWrites, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      expect(mutations(takeoverWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([0]);
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(completed.catalog!.scan).toEqual({
        attemptId: id(131),
        startedAt: new Date(base),
        finishedAt: new Date(base),
        outcome: "succeeded",
        lastSucceededAt: new Date(base),
      });
      expect(completed.catalog!.models.map((row: any) => row.id)).toEqual(["late-predecessor"]);
      expect(completed.versions).toHaveLength(2);
      expect(completed.changes).toHaveLength(2);
      expectAuditIntegrity(completed);
      await subject.tick();
      expect(mutations(takeoverWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([0]);
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(await completeState()).toEqual(completed);
      expect(seeded).toBeDefined();
    } finally {
      await subject.stop();
    }
  }, 30_000);
});

describe("standalone shutdown and durable recovery", () => {
  it("stops with an acquisition mutation outstanding, then a new scanner recovers its accepted token", async () => {
    let now = (await serverNow()).getTime();
    await makeOtherProvidersRecent(now);
    const oldWrites: Mutation[] = [],
      recoveryWrites: Mutation[] = [],
      oldId = id(140),
      successorId = id(141),
      release = deferred<void>();
    let detached: Promise<any> | undefined;
    const db = faultDb(recordMutations(mongo.db, oldWrites), async (collection, method, args, run) => {
      if (
        !detached &&
        collection === CATALOG &&
        method === "updateOne" &&
        args[1]?.$set?.["scan.attemptId"] === oldId
      ) {
        detached = release.promise.then(run);
        void detached.catch(() => {});
        throw new Error("test acquisition acknowledgment unavailable");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => new Date(now) });
    const read = vi.spyOn(store, "readCatalogState"),
      beginSpy = vi.spyOn(store, "beginDiscoveryAttempt"),
      apply = vi.spyOn(store, "applyDiscovery"),
      failure = vi.spyOn(store, "failDiscoveryAttempt");
    const discover = vi.fn(async () => models("old-request"));
    const subject = scanner(store, discover, () => now, { uuid: () => oldId, leaseMs: 1_200, drainMs: 0 });
    let tick: Promise<void> | undefined;
    let restarted: ModelCatalogScanner | undefined;
    try {
      tick = subject.tick();
      await tick;
      expect(detached).toBeDefined();
      const counts = [
        read.mock.calls.length,
        beginSpy.mock.calls.length,
        apply.mock.calls.length,
        failure.mock.calls.length,
      ];
      await subject.stop();
      subject.start();
      await subject.tick();
      expect([
        read.mock.calls.length,
        beginSpy.mock.calls.length,
        apply.mock.calls.length,
        failure.mock.calls.length,
      ]).toEqual(counts);
      const shell = await completeState();
      expect(shell).toEqual({ catalog: { _id: "codex", provider: "codex" }, versions: [], changes: [] });
      release.resolve();
      expect((await detached!).matchedCount).toBe(1);
      expect(mutations(oldWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      const interrupted = await completeState();
      expect(interrupted.catalog!.scan).toEqual({
        attemptId: oldId,
        startedAt: new Date(now),
        leaseExpiresAt: new Date(now + 1_200),
        outcome: "running",
      });
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(apply.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
      expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);

      now = await waitForActualExpiry(interrupted.catalog!.scan.leaseExpiresAt);
      const restartedDiscover = vi.fn(async () => models("recovered-token"));
      restarted = scanner(
        new ModelCatalogStore(recordMutations(mongo.db, recoveryWrites), { now: () => new Date(now) }),
        restartedDiscover,
        () => now,
        { uuid: () => successorId },
      );
      await restarted.tick();
      const final = await completeState();
      expect(final.catalog!.scan).toEqual({
        attemptId: successorId,
        startedAt: new Date(now),
        finishedAt: new Date(now),
        outcome: "succeeded",
        lastSucceededAt: new Date(now),
      });
      expect(final.catalog!.models.map((row: any) => row.id)).toEqual(["recovered-token"]);
      expect(final.versions).toHaveLength(1);
      expect(final.changes).toHaveLength(1);
      expect(mutations(recoveryWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      expect(mutations(recoveryWrites, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      const durable = await new ModelCatalogStore(mongo.db).readCatalogState("codex");
      expect(durable.snapshot).toEqual(final.catalog);
      expect(catalogStatus("codex", durable.snapshot, now)).toMatchObject({
        latest: "succeeded",
        recoveryPending: false,
        modelCount: 1,
        source: "discovery",
      });
      expectAuditIntegrity(final);
    } finally {
      release.resolve();
      await detached?.catch(() => {});
      await tick?.catch(() => {});
      await Promise.all([subject.stop(), restarted?.stop()]);
    }
  }, 30_000);

  it.each(["without-successor", "after-successor"] as const)(
    "stops with a completion mutation outstanding and reconciles it %s",
    async (mode) => {
      let now = (await serverNow()).getTime();
      const initial = await prepareDueState("seeded-overdue", now);
      const oldWrites: Mutation[] = [],
        successorWrites: Mutation[] = [],
        oldId = id(142),
        successorId = id(143),
        release = deferred<void>();
      let detached: Promise<any> | undefined;
      const db = faultDb(recordMutations(mongo.db, oldWrites), async (collection, method, args, run) => {
        if (
          !detached &&
          collection === CATALOG &&
          method === "updateOne" &&
          args[0]?.["scan.attemptId"] === oldId &&
          args[1]?.$set?.pendingExport
        ) {
          detached = release.promise.then(run);
          void detached.catch(() => {});
          throw new Error("test completion acknowledgment unavailable at shutdown");
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => new Date(now) });
      const read = vi.spyOn(store, "readCatalogState"),
        beginSpy = vi.spyOn(store, "beginDiscoveryAttempt"),
        apply = vi.spyOn(store, "applyDiscovery"),
        failure = vi.spyOn(store, "failDiscoveryAttempt");
      const discover = vi.fn(async (provider: CatalogProvider) =>
        models(provider === "codex" ? "old-completion" : `${provider}-old`),
      );
      const subject = scanner(store, discover, () => now, { uuid: () => oldId, leaseMs: 1_100, drainMs: 0 });
      let tick: Promise<void> | undefined;
      let restarted: ModelCatalogScanner | undefined;
      try {
        tick = subject.tick();
        await tick;
        expect(detached).toBeDefined();
        const running = await completeState();
        expectNoSavedMutation(initial, running);
        expect(running.catalog!.scan).toMatchObject({ attemptId: oldId, outcome: "running" });
        const counts = [
          read.mock.calls.length,
          beginSpy.mock.calls.length,
          apply.mock.calls.length,
          failure.mock.calls.length,
        ];
        await subject.stop();
        await subject.tick();
        expect([
          read.mock.calls.length,
          beginSpy.mock.calls.length,
          apply.mock.calls.length,
          failure.mock.calls.length,
        ]).toEqual(counts);

        const restartedDiscover = vi.fn(async () => models("shutdown-successor"));
        if (mode === "after-successor") {
          now = await waitForActualExpiry(running.catalog!.scan.leaseExpiresAt);
          restarted = scanner(
            new ModelCatalogStore(recordMutations(mongo.db, successorWrites), { now: () => new Date(now) }),
            restartedDiscover,
            () => now,
            { uuid: () => successorId },
          );
          await restarted.tick();
          expect((await completeState()).catalog!.scan.attemptId).toBe(successorId);
        } else {
          expect((await serverNow()).getTime()).toBeLessThan(running.catalog!.scan.leaseExpiresAt.getTime());
        }

        release.resolve();
        expect((await detached!).matchedCount).toBe(mode === "without-successor" ? 1 : 0);
        expect(mutations(oldWrites, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([
          mode === "without-successor" ? 1 : 0,
        ]);
        if (mode === "without-successor") {
          const pending = await completeState();
          expect(pending.catalog!.scan).toEqual({
            attemptId: oldId,
            startedAt: new Date(now),
            finishedAt: new Date(now),
            outcome: "succeeded",
            lastSucceededAt: new Date(now),
          });
          expect(pending.catalog).toHaveProperty("pendingExport");
          expect(pending.versions).toEqual(initial.versions);
          expect(pending.changes).toEqual(initial.changes);
          restarted = scanner(
            new ModelCatalogStore(recordMutations(mongo.db, successorWrites), { now: () => new Date(now) }),
            restartedDiscover,
            () => now,
            { uuid: () => successorId },
          );
          await restarted.tick();
          expect(restartedDiscover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        }
        const final = await completeState();
        expect(final.catalog).not.toHaveProperty("pendingExport");
        expect(final.catalog!.scan.outcome).toBe("succeeded");
        expect(final.catalog!.models.map((row: any) => row.id)).toEqual([
          mode === "without-successor" ? "old-completion" : "shutdown-successor",
        ]);
        expect(final.versions).toHaveLength(initial.versions.length + 1);
        expect(final.changes).toHaveLength(initial.changes.length + 1);
        if (mode === "after-successor") {
          expect(mutations(successorWrites, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
          expect(mutations(successorWrites, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        }
        const durable = await new ModelCatalogStore(mongo.db).readCatalogState("codex");
        expect(durable.snapshot).toEqual(final.catalog);
        expect(catalogStatus("codex", durable.snapshot, now)).toMatchObject({
          latest: "succeeded",
          recoveryPending: false,
          modelCount: 1,
          source: "discovery",
        });
        expectAuditIntegrity(final);
      } finally {
        release.resolve();
        await detached?.catch(() => {});
        await tick?.catch(() => {});
        await Promise.all([subject.stop(), restarted?.stop()]);
      }
    },
    30_000,
  );
});

describe("standalone export maintenance", () => {
  it("keeps a successful changed provider out of cadence while its exact failed projection is recovered", async () => {
    const now = (await serverNow()).getTime();
    await makeOtherProvidersRecent(now);
    const writes: Mutation[] = [],
      attemptId = id(150);
    let blockProjection = true;
    const db = faultDb(recordMutations(mongo.db, writes), async (collection, method, args, run) => {
      if (blockProjection && collection === VERSIONS && method === "insertOne" && args[0]?._id === attemptId) {
        throw new Error("test history projection unavailable");
      }
      return run();
    });
    const discover = vi.fn(async (provider: CatalogProvider) => models(`${provider}-new`));
    const subject = scanner(new ModelCatalogStore(db, { now: () => new Date(now) }), discover, () => now, {
      uuid: () => attemptId,
    });
    try {
      await subject.tick();
      const pending = await completeState();
      const envelope = cloneBson(pending.catalog!.pendingExport);
      expect(pending).toEqual({
        catalog: {
          _id: "codex",
          provider: "codex",
          models: [{ id: "codex-new", displayName: "CODEX-NEW", addedAt: new Date(now) }],
          revision: 1,
          commitId: attemptId,
          snapshotId: pending.catalog!.snapshotId,
          source: "discovery",
          updatedBy: "system:model-catalog-scanner",
          updatedAt: new Date(now),
          scan: {
            attemptId,
            startedAt: new Date(now),
            finishedAt: new Date(now),
            outcome: "succeeded",
            lastSucceededAt: new Date(now),
          },
          pendingExport: envelope,
        },
        versions: [],
        changes: [],
      });
      expect(envelope).toEqual({
        version: {
          _id: attemptId,
          provider: "codex",
          revision: 1,
          snapshotId: pending.catalog!.snapshotId,
          createdAt: new Date(now),
          source: "discovery",
          updatedBy: "system:model-catalog-scanner",
          bootstrap: true,
          added: ["codex-new"],
          removed: [],
          modelCount: 1,
          snapshot: [{ id: "codex-new", displayName: "CODEX-NEW", addedAt: new Date(now) }],
          changeSummary: "+1 (codex-new), -0",
        },
        change: {
          _id: attemptId,
          provider: "codex",
          revision: 1,
          snapshotId: pending.catalog!.snapshotId,
          createdAt: new Date(now),
          source: "discovery",
          updatedBy: "system:model-catalog-scanner",
          bootstrap: true,
          added: ["codex-new"],
          removed: [],
          modelCount: 1,
        },
      });
      expect(mutations(writes, "codex", "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      expect(mutations(writes, "codex", "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);

      blockProjection = false;
      await subject.tick();
      const recovered = await completeState();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      expect(recovered.catalog).toEqual((({ pendingExport: _pending, ...catalog }) => catalog)(pending.catalog!));
      expect(recovered.versions).toEqual([envelope.version]);
      expect(recovered.changes).toEqual([
        {
          ...envelope.change,
          delivery: { state: "pending", attempts: 0, nextAttemptAt: envelope.change.createdAt },
        },
      ]);
      expect(mutations(writes, "codex", "export-clear").map(({ matchedCount }) => matchedCount)).toContain(1);
      expectAuditIntegrity(recovered);
    } finally {
      blockProjection = false;
      await subject.stop();
    }
  }, 30_000);

  it("contains a failed plugin export while provider lanes complete, then preserves duplicate delivery bytes", async () => {
    const now = (await serverNow()).getTime();
    const pluginId = id(151);
    let blockProjection = true;
    const db = faultDb(mongo.db, async (collection, method, args, run) => {
      if (blockProjection && collection === VERSIONS && method === "insertOne" && args[0]?._id === pluginId) {
        throw new Error("test plugin projection unavailable");
      }
      return run();
    });
    expect(
      (
        await manual("sol", now, ["sol-model"], pluginId, {
          plugin: true,
          db,
          updatedBy: "plugin-operator",
          changeSummary: "manual plugin change",
        })
      ).result,
    ).toMatchObject({ kind: "committed", recoveryPending: true });
    const pending = await completeState("sol");
    const envelope = cloneBson(pending.catalog!.pendingExport);
    const delivery = {
      state: "pending",
      attempts: 7,
      nextAttemptAt: new Date(now + 9_000),
      claimToken: "preserve-sibling-delivery-fields",
    };
    const existingChange = { ...envelope.change, delivery };
    await mongo.db.collection(CHANGES).insertOne(cloneBson(existingChange));
    const deliveryBefore = cloneBson((await mongo.db.collection(CHANGES).findOne({ _id: pluginId }))!.delivery);

    const writes: Mutation[] = [];
    const discover = vi.fn(async (provider: CatalogProvider) => models(`${provider}-model`));
    const subject = scanner(
      new ModelCatalogStore(recordMutations(db, writes), { now: () => new Date(now) }),
      discover,
      () => now,
    );
    try {
      await subject.tick();
      expect(discover.mock.calls.map(([provider]) => provider).sort()).toEqual([...PROVIDERS].sort());
      expect((await completeState("sol")).catalog).toHaveProperty("pendingExport");
      for (const provider of PROVIDERS) {
        const state = await completeState(provider);
        expect(state.catalog!.scan).toEqual({
          attemptId: state.catalog!.scan.attemptId,
          startedAt: new Date(now),
          finishedAt: new Date(now),
          outcome: "succeeded",
          lastSucceededAt: new Date(now),
        });
        expect(state.versions).toHaveLength(1);
        expect(state.changes).toHaveLength(1);
        expect(mutations(writes, provider, "claim").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        expect(mutations(writes, provider, "changed").map(({ matchedCount }) => matchedCount)).toEqual([1]);
        expectAuditIntegrity(state);
      }

      blockProjection = false;
      await subject.tick();
      const recovered = await completeState("sol");
      expect(recovered.catalog).toEqual((({ pendingExport: _pending, ...catalog }) => catalog)(pending.catalog!));
      expect(recovered.versions).toEqual([envelope.version]);
      expect(recovered.changes).toEqual([existingChange]);
      expect(recovered.changes[0].delivery).toEqual(deliveryBefore);
      expect(discover).toHaveBeenCalledTimes(3);
      expectAuditIntegrity(recovered, true);
    } finally {
      blockProjection = false;
      await subject.stop();
    }
  }, 30_000);
});

describe("standalone predecessor-visible uncertain begin", () => {
  it.each(["before-expiry", "after-successor"] as const)(
    "retains the new UUID while the failed predecessor stays visible: %s",
    async (releaseAt) => {
      const seededAt = (await serverNow()).getTime();
      let now = seededAt;
      await makeOtherProvidersRecent(seededAt);
      const { store: seedStore } = await manual("codex", seededAt, ["old"], id(160), {
        updatedBy: "journaled-operator",
        changeSummary: "journaled manual seed",
      });
      const predecessorStartedAt = seededAt - SCAN_INTERVAL_MS - 1_000;
      const prior = await begin(seedStore, "codex", predecessorStartedAt, id(161), SCAN_INTERVAL_MS + 5_000);
      expect(await seedStore.failDiscoveryAttempt(prior, safeError("codex", "auth"), new Date(seededAt))).toEqual({
        kind: "recorded",
      });
      const before = await completeState();
      expect(before.catalog!.scan).toEqual({
        attemptId: id(161),
        startedAt: new Date(predecessorStartedAt),
        finishedAt: new Date(seededAt),
        outcome: "failed",
        error: safeError("codex", "auth"),
      });
      expect(before.versions).toHaveLength(1);
      expect(before.changes).toHaveLength(1);
      expectAuditIntegrity(before);

      now = (await serverNow()).getTime();
      const originalStart = now,
        originalId = id(162),
        successorId = id(163),
        leaseMs = 3_000,
        release = deferred<void>(),
        writes: Mutation[] = [];
      let detached: Promise<any> | undefined;
      const db = faultDb(recordMutations(mongo.db, writes), async (collection, method, args, run) => {
        if (
          !detached &&
          collection === CATALOG &&
          method === "updateOne" &&
          args[1]?.$set?.["scan.outcome"] === "running"
        ) {
          detached = release.promise.then(run);
          void detached.catch(() => {});
          throw new Error("test uncertain begin acknowledgment unavailable before delegation");
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => new Date(now) });
      const beginSpy = vi.spyOn(store, "beginDiscoveryAttempt"),
        applySpy = vi.spyOn(store, "applyDiscovery"),
        failureSpy = vi.spyOn(store, "failDiscoveryAttempt");
      const allocated: string[] = [];
      const discover = vi.fn(async () => models("successor-model"));
      const subject = scanner(store, discover, () => now, {
        leaseMs,
        uuid: () => {
          const value = allocated.length === 0 ? originalId : successorId;
          allocated.push(value);
          return value;
        },
      });
      try {
        await subject.tick();
        expect(detached).toBeDefined();
        const attempts = () => beginSpy.mock.calls.filter(([provider]) => provider === "codex");
        expect(attempts()).toHaveLength(1);
        expect(attempts()[0][1]).toMatchObject({
          attemptId: originalId,
          startedAt: new Date(originalStart),
          leaseExpiresAt: new Date(originalStart + leaseMs),
        });
        const originalLease = attempts()[0][1].leaseExpiresAt;
        expect(allocated).toEqual([originalId]);
        expect(await completeState()).toEqual(before);

        for (const at of [originalStart, originalLease.getTime() - 1]) {
          now = at;
          await subject.tick();
          expect(attempts()).toHaveLength(1);
          expect(allocated).toEqual([originalId]);
          expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
          expect(applySpy.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
          expect(failureSpy.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
          const stillPredecessor = await completeState();
          expect(stillPredecessor).toEqual(before);
          expect(stillPredecessor.catalog!.scan.attemptId).toBe(id(161));
        }

        if (releaseAt === "before-expiry") {
          expect(now).toBeLessThan(originalLease.getTime());
          expect((await serverNow()).getTime()).toBeLessThan(originalLease.getTime());
          release.resolve();
          expect((await detached!).matchedCount).toBe(1);
          expect(
            mutations(writes, "codex", "claim")
              .filter(({ attemptId }) => attemptId === originalId)
              .map(({ matchedCount }) => matchedCount),
          ).toEqual([1]);
          const accepted = await completeState();
          expectNoSavedMutation(before, accepted);
          expect(accepted.catalog!.scan).toEqual({
            attemptId: originalId,
            startedAt: new Date(originalStart),
            leaseExpiresAt: new Date(originalStart + leaseMs),
            outcome: "running",
          });
          expect(accepted.versions).toEqual(before.versions);
          expect(accepted.changes).toEqual(before.changes);
          await subject.tick();
          expect(attempts()).toHaveLength(1);
          expect(allocated).toEqual([originalId]);
          expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        }

        now = await waitForActualExpiry(originalLease);
        await subject.tick();
        expect(attempts()).toHaveLength(2);
        expect(attempts()[1][1].attemptId).toBe(successorId);
        expect(allocated).toEqual([originalId, successorId]);
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
        expect(applySpy.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(1);
        expect(failureSpy.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
        const successor = await completeState();
        expect(successor.catalog!.scan).toEqual({
          attemptId: successorId,
          startedAt: new Date(now),
          finishedAt: new Date(now),
          outcome: "succeeded",
          lastSucceededAt: new Date(now),
        });
        expect(successor.catalog!.models.map((row: any) => row.id)).toEqual(["successor-model"]);
        expect(successor.versions).toHaveLength(before.versions.length + 1);
        expect(successor.changes).toHaveLength(before.changes.length + 1);
        expect(
          mutations(writes, "codex", "claim")
            .filter(({ attemptId }) => attemptId === successorId)
            .map(({ matchedCount }) => matchedCount),
        ).toEqual([1]);
        expect(
          mutations(writes, "codex", "changed")
            .filter(({ attemptId }) => attemptId === successorId)
            .map(({ matchedCount }) => matchedCount),
        ).toEqual([1]);
        expectAuditIntegrity(successor);

        if (releaseAt === "after-successor") {
          release.resolve();
          expect((await detached!).matchedCount).toBe(0);
          expect(
            mutations(writes, "codex", "claim")
              .filter(({ attemptId }) => attemptId === originalId)
              .map(({ matchedCount }) => matchedCount),
          ).toEqual([0]);
          expect(await completeState()).toEqual(successor);
        }
      } finally {
        release.resolve();
        await detached?.catch(() => {});
        await subject.stop();
      }
    },
    30_000,
  );
});
