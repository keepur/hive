/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { Binary, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { guardDb, WriteGuard } from "../db/write-guard.js";
import type { AcquisitionObservation, DiscoveryAttempt } from "./model-catalog-types.js";
import { CatalogError } from "./model-catalog-value.js";
import { ModelCatalogStore } from "./model-catalog-store.js";
import {
  applyUpdate,
  cloneBson,
  createCatalogFake,
  deferred,
  faultDb,
  matches,
  type Row,
} from "./testing/catalog-db.test-support.js";

const CATALOG = "agent_model_catalog";
const VERSIONS = "agent_model_catalog_versions";
const CHANGES = "agent_model_catalog_changes";
const BASE = new Date("2026-09-07T00:00:00.000Z");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const proposal = (observed: AcquisitionObservation, at: Date, duration = 120_000) => ({
  attemptId: randomUUID(),
  startedAt: new Date(at),
  leaseExpiresAt: new Date(at.getTime() + duration),
  observed,
});
const models = (...ids: string[]) => ids.map((modelId) => ({ id: modelId, displayName: modelId.toUpperCase() }));

function catalog(fake: ReturnType<typeof createCatalogFake>, provider = "codex"): Row | undefined {
  return fake.rows(CATALOG).get(provider);
}

function exported(fake: ReturnType<typeof createCatalogFake>) {
  return { versions: [...fake.rows(VERSIONS).values()], changes: [...fake.rows(CHANGES).values()] };
}

async function begin(store: ModelCatalogStore, provider: "claude" | "grok" | "codex", now: Date, duration = 120_000) {
  const due = await store.readCatalogState(provider);
  return store.beginDiscoveryAttempt(provider, proposal(due.observed, now, duration));
}

describe("stateful BSON catalog fake", () => {
  it("round-trips BSON values and compares ordered embedded values exactly", () => {
    const oid = new ObjectId();
    const original = {
      date: BASE,
      oid,
      long: Long.fromString("922337203685477580"),
      binary: new Binary(Buffer.from([1, 2, 3])),
      nested: { first: 1, second: 2 },
      nil: null,
    };
    const copy = cloneBson(original);
    expect(copy).toEqual(original);
    expect(matches({ scan: original }, { scan: cloneBson(original) })).toBe(true);
    expect(matches({ scan: original }, { scan: { ...original, nested: { second: 2, first: 1 } } })).toBe(false);
  });

  it("models Mongo absence, null, literal and guarded array expressions", () => {
    const now = BASE;
    const guardedSeeded = (expected: boolean) => ({
      $expr: {
        $eq: [{ $gt: [{ $size: { $cond: [{ $isArray: "$models" }, "$models", []] } }, 0] }, expected],
      },
    });
    expect(matches({}, { scan: null }, now)).toBe(true);
    expect(matches({ scan: null }, { $expr: { $eq: [{ $type: "$scan" }, "null"] } }, now)).toBe(true);
    expect(matches({}, { $expr: { $eq: [{ $type: "$scan" }, "missing"] } }, now)).toBe(true);
    expect(matches({ scan: {} }, { $expr: { $eq: [{ $type: "$scan.leaseExpiresAt" }, "missing"] } }, now)).toBe(true);
    expect(
      matches(
        { scan: { leaseExpiresAt: null } },
        { $expr: { $eq: [{ $type: "$scan.leaseExpiresAt" }, "missing"] } },
        now,
      ),
    ).toBe(false);
    expect(matches({ models: [{ id: "x" }] }, guardedSeeded(true), now)).toBe(true);
    for (const row of [{}, { models: null }, { models: "x" }, { models: [] }]) {
      expect(matches(row, guardedSeeded(false), now)).toBe(true);
    }
    for (const literal of ["$field", "$$NOW", { $gt: [1, 0] }, ["$field"]]) {
      expect(matches({ value: literal }, { $expr: { $eq: ["$value", { $literal: literal }] } }, now)).toBe(true);
    }
  });

  it("distinguishes date leases from date-looking malformed BSON values", () => {
    expect(matches({ lease: BASE }, { $expr: { $eq: [{ $type: "$lease" }, "date"] } }, BASE)).toBe(true);
    for (const lease of [BASE.toISOString(), BASE.getTime(), [BASE], { value: BASE }, null]) {
      expect(matches({ lease }, { $expr: { $eq: [{ $type: "$lease" }, "date"] } }, BASE)).toBe(false);
    }
    expect(() => matches({}, { $expr: { $unknown: [] } }, BASE)).toThrow("Unsupported test expression");
    expect(() => matches({}, { field: { $unknown: true } }, BASE)).toThrow("Unsupported test operator");
  });

  it("applies dotted updates to a clone without changing the source", () => {
    const source = { scan: { outcome: "running", error: { code: "timeout" } }, value: 1 };
    const next = cloneBson(source);
    applyUpdate(next, { $set: { "scan.outcome": "succeeded" }, $unset: { "scan.error": "" } });
    expect(source.scan).toEqual({ outcome: "running", error: { code: "timeout" } });
    expect(next).toEqual({ scan: { outcome: "succeeded" }, value: 1 });
  });
});

describe("manual CAS and immutable exports", () => {
  it("audits every manual write and emits changes only for bootstrap and ID diffs", async () => {
    let now = new Date(BASE);
    let sequence = 1;
    const fake = createCatalogFake(() => now);
    const store = new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(sequence++) });

    const seed = await store.replaceManual({
      provider: "codex",
      updatedBy: "alice",
      changeSummary: "initial",
      models: [
        { id: "one", displayName: "One", notes: "keep" },
        { id: "two", displayName: "Two" },
      ],
    });
    expect(seed).toMatchObject({ kind: "committed", revision: 1, bootstrap: true, added: ["one", "two"] });
    now = new Date(now.getTime() + 1000);
    expect(
      await store.replaceManual({
        provider: "codex",
        updatedBy: "bob",
        models: [
          { id: "one", displayName: "One", notes: "keep" },
          { id: "two", displayName: "Two" },
        ],
      }),
    ).toMatchObject({ kind: "committed", revision: 2, bootstrap: false, added: [], removed: [] });
    now = new Date(now.getTime() + 1000);
    expect(
      await store.replaceManual({
        provider: "codex",
        updatedBy: "carol",
        models: [
          { id: "two", displayName: "Second", notes: "new" },
          { id: "one", displayName: "First" },
        ],
      }),
    ).toMatchObject({ kind: "committed", revision: 3, added: [], removed: [] });
    now = new Date(now.getTime() + 1000);
    expect(
      await store.replaceManual({
        provider: "codex",
        updatedBy: "dana",
        models: [
          { id: "two", displayName: "Second", notes: "new" },
          { id: "three", displayName: "Third" },
        ],
      }),
    ).toMatchObject({ kind: "committed", revision: 4, added: ["three"], removed: ["one"] });

    const doc = catalog(fake)!;
    expect(doc).toMatchObject({ revision: 4, commitId: id(4), source: "manual", updatedBy: "dana" });
    expect(doc.models.map((row: Row) => [row.id, row.displayName, row.notes])).toEqual([
      ["two", "Second", "new"],
      ["three", "Third", undefined],
    ]);
    expect(doc.models[0].addedAt).toEqual(BASE);
    expect(doc.models[1].addedAt).toEqual(now);
    const out = exported(fake);
    expect(out.versions).toHaveLength(4);
    expect(out.versions.map((row) => [row.revision, row.changeSummary, row.updatedBy])).toEqual([
      [1, "initial", "alice"],
      [2, "+0, -0", "bob"],
      [3, "+0, -0", "carol"],
      [4, "+1 (three), -1 (one)", "dana"],
    ]);
    expect(out.changes).toHaveLength(2);
    expect(out.changes.map((row) => [row.revision, row.added, row.removed, row.delivery])).toEqual([
      [1, ["one", "two"], [], { state: "pending", attempts: 0, nextAttemptAt: BASE }],
      [4, ["three"], ["one"], { state: "pending", attempts: 0, nextAttemptAt: now }],
    ]);
  });

  it("retains addedAt across removal and assigns a new timestamp on reintroduction", async () => {
    let now = new Date(BASE);
    let sequence = 20;
    const fake = createCatalogFake(() => now);
    const store = new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(sequence++) });
    await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("one") });
    const original = catalog(fake)!.models[0].addedAt;
    now = new Date(now.getTime() + 1000);
    await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("two") });
    now = new Date(now.getTime() + 1000);
    await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("one", "two") });
    expect(catalog(fake)!.models.map((row: Row) => row.addedAt)).toEqual([now, new Date(BASE.getTime() + 1000)]);
    expect(catalog(fake)!.models[0].addedAt).not.toEqual(original);
    expect(exported(fake).versions).toHaveLength(3);
    expect(exported(fake).changes).toHaveLength(3);
  });

  it("supports plugin providers and preserves exact validation text", async () => {
    const fake = createCatalogFake(() => BASE);
    const store = new ModelCatalogStore(fake.db, {
      now: () => BASE,
      uuid: () => id(30),
      listPluginProviderIds: () => ["sol"],
    });
    expect(await store.replaceManual({ provider: "sol", updatedBy: "a", models: models("one") })).toMatchObject({
      kind: "committed",
      revision: 1,
    });
    const unknown = await store.replaceManual({ provider: "zeta", updatedBy: "a", models: models("one") });
    expect(unknown).toMatchObject({
      kind: "not-committed",
      error: { code: "malformed", message: "Unknown provider 'zeta'. Valid: claude, grok, codex, sol." },
    });
    expect(await store.replaceManual({ provider: "gemini", updatedBy: "a", models: models("one") })).toMatchObject({
      kind: "not-committed",
      error: { message: "Gemini is always resolved live and cannot be refreshed." },
    });
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("rebases a losing manual CAS on the winning revision and retained metadata", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(40) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: [{ id: "one", displayName: "One", notes: "original" }],
    });
    const entered = deferred<void>(),
      gate = deferred<void>();
    let held = true;
    const bDb = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (
        held &&
        collectionName === CATALOG &&
        method === "updateOne" &&
        args[1].$set?.pendingExport?.version?._id === id(42)
      ) {
        held = false;
        entered.resolve();
        await gate.promise;
      }
      return run();
    });
    const a = new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(41) });
    const b = new ModelCatalogStore(bDb, { now: () => BASE, uuid: () => id(42) });
    const pendingB = b.replaceManual({ provider: "codex", updatedBy: "b", models: models("one", "three") });
    await entered.promise;
    await a.replaceManual({
      provider: "codex",
      updatedBy: "a",
      models: [
        { id: "one", displayName: "A", notes: "winner" },
        { id: "two", displayName: "Two" },
      ],
    });
    gate.resolve();
    expect(await pendingB).toMatchObject({ kind: "committed", revision: 3, added: ["three"], removed: ["two"] });
    expect(catalog(fake)).toMatchObject({ revision: 3, updatedBy: "b" });
    expect(catalog(fake)!.models.map((row: Row) => [row.id, row.notes])).toEqual([
      ["one", undefined],
      ["three", undefined],
    ]);
    expect(fake.rows(VERSIONS).size).toBe(3);
    expect(fake.rows(CHANGES).size).toBe(3);
  });

  it("turns a concurrent first-document duplicate insert into a revision-aware retry", async () => {
    const fake = createCatalogFake(() => BASE),
      entered = deferred<void>(),
      gate = deferred<void>();
    let holdB = true;
    const bDb = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (holdB && collectionName === CATALOG && method === "insertOne" && args[0].commitId === id(44)) {
        holdB = false;
        entered.resolve();
        await gate.promise;
      }
      return run();
    });
    const a = new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(43) }),
      b = new ModelCatalogStore(bDb, { now: () => BASE, uuid: () => id(44) });
    const pendingB = b.replaceManual({ provider: "codex", updatedBy: "b", models: models("two") });
    await entered.promise;
    expect(await a.replaceManual({ provider: "codex", updatedBy: "a", models: models("one") })).toMatchObject({
      kind: "committed",
      revision: 1,
    });
    gate.resolve();
    expect(await pendingB).toMatchObject({ kind: "committed", revision: 2, added: ["two"], removed: ["one"] });
    expect(catalog(fake)).toMatchObject({ revision: 2, commitId: id(44), models: [{ id: "two" }] });
    expect(fake.rows(VERSIONS).size).toBe(2);
    expect(fake.rows(CHANGES).size).toBe(2);
  });

  it("bounds acknowledged CAS conflicts at eight and never writes unconditionally", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(50) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    let misses = 0;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.pendingExport) {
        misses++;
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      return run();
    });
    const result = await new ModelCatalogStore(db, { now: () => BASE, uuid: () => id(51) }).replaceManual({
      provider: "codex",
      updatedBy: "loser",
      models: models("two"),
    });
    expect(result).toMatchObject({ kind: "not-committed", retriable: true, error: { code: "storage" } });
    expect(misses).toBe(8);
    expect(catalog(fake)).toMatchObject({ revision: 1, updatedBy: "seed" });
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("creates exact history/outbox indexes and returns sorted bounded pending changes", async () => {
    let now = new Date(BASE);
    let sequence = 60;
    const fake = createCatalogFake(() => now);
    const store = new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(sequence++) });
    await store.replaceManual({ provider: "claude", updatedBy: "a", models: models("one") });
    now = new Date(now.getTime() + 1000);
    await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("two") });
    expect(fake.indexes).toEqual([
      { name: VERSIONS, keys: { provider: 1, createdAt: -1 }, options: undefined },
      {
        name: CHANGES,
        keys: { "delivery.state": 1, "delivery.nextAttemptAt": 1 },
        options: undefined,
      },
    ]);
    expect((await store.pendingChanges(now, 1)).map((row) => row.provider)).toEqual(["claude"]);
    await expect(store.pendingChanges(now, 0)).rejects.toMatchObject({ safe: { code: "malformed" } });
  });
});

describe("recoverable immutable projection", () => {
  it("keeps the envelope when history insertion fails and a fresh store recovers exactly once", async () => {
    const fake = createCatalogFake(() => BASE);
    let failHistory = true;
    const db = faultDb(fake.db, async (collectionName, method, _args, run) => {
      if (failHistory && collectionName === VERSIONS && method === "insertOne")
        throw new Error("secret history failure");
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE, uuid: () => id(100) });
    expect(await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("one") })).toMatchObject({
      kind: "committed",
      commitId: id(100),
      recoveryPending: true,
    });
    expect(catalog(fake)).toMatchObject({ revision: 1, pendingExport: { version: { _id: id(100) } } });
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
    expect(await store.replaceManual({ provider: "codex", updatedBy: "b", models: models("two") })).toMatchObject({
      kind: "not-committed",
      retriable: true,
    });
    failHistory = false;
    const fresh = new ModelCatalogStore(db, { now: () => BASE });
    expect(await fresh.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
    expect(catalog(fake)).not.toHaveProperty("pendingExport");
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
    expect(await fresh.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("recovers an ambiguous history acknowledgment through duplicate payload verification", async () => {
    const fake = createCatalogFake(() => BASE);
    let ambiguous = true;
    const db = faultDb(fake.db, async (collectionName, method, _args, run) => {
      if (ambiguous && collectionName === VERSIONS && method === "insertOne") {
        ambiguous = false;
        await run();
        throw new Error("unknown acknowledgment with raw secret");
      }
      return run();
    });
    const result = await new ModelCatalogStore(db, { now: () => BASE, uuid: () => id(101) }).replaceManual({
      provider: "codex",
      updatedBy: "a",
      models: models("one"),
    });
    expect(result).toMatchObject({ kind: "committed", recoveryPending: true });
    expect(catalog(fake)).toHaveProperty("pendingExport");
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(0);
    expect(await new ModelCatalogStore(db).recoverPendingExports("codex")).toEqual([
      { provider: "codex", kind: "recovered" },
    ]);
    expect(catalog(fake)).not.toHaveProperty("pendingExport");
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("leaves history and change payload mismatches pending with a safe diagnostic", async () => {
    for (const target of [VERSIONS, CHANGES]) {
      const fake = createCatalogFake(() => BASE);
      let failTarget = true;
      const db = faultDb(fake.db, async (collectionName, method, _args, run) => {
        if (failTarget && collectionName === target && method === "insertOne") throw new Error("first failure");
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => BASE, uuid: () => id(target === VERSIONS ? 102 : 103) });
      const result = await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("one") });
      expect(result).toMatchObject({ kind: "committed", recoveryPending: true });
      failTarget = false;
      const envelope = cloneBson(catalog(fake)!.pendingExport);
      fake.rows(target).set(envelope.version._id, {
        ...(target === VERSIONS
          ? envelope.version
          : {
              ...envelope.change,
              delivery: { state: "pending", attempts: 0, nextAttemptAt: BASE },
            }),
        provider: "corrupted",
      });
      const recovered = await store.recoverPendingExports("codex");
      expect(recovered).toMatchObject([{ provider: "codex", kind: "pending", error: { code: "storage" } }]);
      expect(catalog(fake)).toHaveProperty("pendingExport");
      expect(fake.rows(target).size).toBe(1);
    }
  });

  it("does not overwrite delivery fields when retrying a matching change export", async () => {
    const fake = createCatalogFake(() => BASE);
    const store = new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(104) });
    await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("one") });
    const version = cloneBson(fake.rows(VERSIONS).get(id(104))),
      change = cloneBson(fake.rows(CHANGES).get(id(104)));
    const delivery = {
      state: "pending",
      attempts: 7,
      nextAttemptAt: new Date(BASE.getTime() + 5000),
      recipient: "C123",
      claimToken: "later-sibling-field",
    };
    fake.rows(CHANGES).set(id(104), { ...change, delivery });
    catalog(fake)!.pendingExport = {
      version,
      change: Object.fromEntries(Object.entries(change).filter(([key]) => key !== "delivery")),
    };
    expect(await store.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
    expect(fake.rows(CHANGES).get(id(104))!.delivery).toEqual(delivery);
    expect(catalog(fake)).not.toHaveProperty("pendingExport");
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("handles failed and ambiguous slot clears without losing immutable records", async () => {
    for (const applyBeforeThrow of [false, true]) {
      const fake = createCatalogFake(() => BASE);
      let fault = true;
      const db = faultDb(fake.db, async (collectionName, method, args, run) => {
        if (
          fault &&
          collectionName === CATALOG &&
          method === "updateOne" &&
          args[1].$unset?.pendingExport !== undefined
        ) {
          fault = false;
          if (applyBeforeThrow) await run();
          throw new Error("slot clear acknowledgment failed");
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => BASE, uuid: () => id(applyBeforeThrow ? 106 : 105) });
      expect(await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("one") })).toMatchObject({
        kind: "committed",
        recoveryPending: true,
      });
      expect(fake.rows(VERSIONS).size).toBe(1);
      expect(fake.rows(CHANGES).size).toBe(1);
      if (applyBeforeThrow) expect(catalog(fake)).not.toHaveProperty("pendingExport");
      else expect(catalog(fake)).toHaveProperty("pendingExport");
      expect(await new ModelCatalogStore(db).recoverPendingExports("codex")).toEqual([
        { provider: "codex", kind: "recovered" },
      ]);
      expect(fake.rows(VERSIONS).size).toBe(1);
      expect(fake.rows(CHANGES).size).toBe(1);
    }
  });

  it("recovers failed and ambiguous change insertions without duplicate rows", async () => {
    for (const applyBeforeThrow of [false, true]) {
      const fake = createCatalogFake(() => BASE);
      let fault = true;
      const db = faultDb(fake.db, async (collectionName, method, _args, run) => {
        if (fault && collectionName === CHANGES && method === "insertOne") {
          fault = false;
          if (applyBeforeThrow) await run();
          throw new Error("change insert acknowledgment failed");
        }
        return run();
      });
      const commit = id(applyBeforeThrow ? 112 : 111);
      const store = new ModelCatalogStore(db, { now: () => BASE, uuid: () => commit });
      expect(await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("one") })).toMatchObject({
        kind: "committed",
        recoveryPending: true,
      });
      expect(catalog(fake)).toHaveProperty("pendingExport");
      expect(fake.rows(VERSIONS).size).toBe(1);
      expect(fake.rows(CHANGES).size).toBe(applyBeforeThrow ? 1 : 0);
      expect(await new ModelCatalogStore(db).recoverPendingExports("codex")).toEqual([
        { provider: "codex", kind: "recovered" },
      ]);
      expect(catalog(fake)).not.toHaveProperty("pendingExport");
      expect(fake.rows(VERSIONS).size).toBe(1);
      expect(fake.rows(CHANGES).size).toBe(1);
      expect(fake.rows(CHANGES).get(commit)).toMatchObject({
        _id: commit,
        delivery: { state: "pending", attempts: 0, nextAttemptAt: BASE },
      });
    }
  });

  it("keeps a newer pending slot when an older delayed clear resumes", async () => {
    const fake = createCatalogFake(() => BASE);
    const entered = deferred<void>(),
      gate = deferred<void>();
    let held = true;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (held && collectionName === CATALOG && method === "updateOne" && args[1].$unset?.pendingExport !== undefined) {
        held = false;
        entered.resolve();
        await gate.promise;
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE, uuid: () => id(107) });
    const pending = store.replaceManual({ provider: "codex", updatedBy: "a", models: models("one") });
    await entered.promise;
    const firstEnvelope = cloneBson(catalog(fake)!.pendingExport);
    const newer = cloneBson(firstEnvelope);
    newer.version._id = id(108);
    newer.version.revision = 2;
    newer.change._id = id(108);
    newer.change.revision = 2;
    catalog(fake)!.pendingExport = newer;
    gate.resolve();
    expect(await pending).toMatchObject({ kind: "committed", recoveryPending: true });
    expect(catalog(fake)!.pendingExport.version._id).toBe(id(108));
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("allows competing recoveries and isolates one provider failure in all-provider recovery", async () => {
    const fake = createCatalogFake(() => BASE);
    for (const [provider, commit] of [
      ["codex", id(109)],
      ["claude", id(110)],
    ] as const) {
      let fail = true;
      const db = faultDb(fake.db, async (collectionName, method, _args, run) => {
        if (fail && collectionName === VERSIONS && method === "insertOne") {
          fail = false;
          throw new Error("leave pending");
        }
        return run();
      });
      await new ModelCatalogStore(db, { now: () => BASE, uuid: () => commit }).replaceManual({
        provider,
        updatedBy: "a",
        models: models(provider),
      });
    }
    const recover = new ModelCatalogStore(fake.db);
    const [one, two] = await Promise.all([
      recover.recoverPendingExports("codex"),
      new ModelCatalogStore(fake.db).recoverPendingExports("codex"),
    ]);
    expect(one).toEqual([{ provider: "codex", kind: "recovered" }]);
    expect(two).toEqual([{ provider: "codex", kind: "recovered" }]);
    expect(fake.rows(VERSIONS).has(id(109))).toBe(true);
    expect(fake.rows(CHANGES).has(id(109))).toBe(true);

    const failingDb = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === VERSIONS && method === "insertOne" && args[0].provider === "claude") {
        throw new Error("provider-local failure");
      }
      return run();
    });
    const all = await new ModelCatalogStore(failingDb).recoverPendingExports();
    expect(all).toEqual([
      { provider: "claude", kind: "pending", error: { code: "storage", message: "Model catalog claude: storage." } },
    ]);
    expect(catalog(fake, "claude")).toHaveProperty("pendingExport");
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });
});

describe("acquisition observations and attempt fences", () => {
  it("refuses B's stale due observation after A completes", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    const gate = deferred<void>(),
      entered = deferred<void>();
    let bId = "";
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.["scan.attemptId"] === bId) {
        entered.resolve();
        await gate.promise;
      }
      return run();
    });
    const a = new ModelCatalogStore(db, { now: () => now, uuid: () => id(70) }),
      b = new ModelCatalogStore(db, { now: () => now });
    await a.replaceManual({ provider: "codex", updatedBy: "test", models: models("one") });
    const dueA = await a.readCatalogState("codex"),
      dueB = await b.readCatalogState("codex");
    const proposedB = proposal(dueB.observed, now);
    bId = proposedB.attemptId;
    const pendingB = b.beginDiscoveryAttempt("codex", proposedB);
    try {
      await entered.promise;
      const startedA = await a.beginDiscoveryAttempt("codex", proposal(dueA.observed, now));
      expect(startedA.kind).toBe("started");
      if (startedA.kind !== "started") throw new Error("A did not acquire");
      expect((await a.applyDiscovery(startedA.attempt, models("one"))).kind).toBe("unchanged");
      const completed = cloneBson(catalog(fake));
      gate.resolve();
      expect(await pendingB).toEqual({ kind: "busy" });
      expect(catalog(fake)).toEqual(completed);
      expect(fake.rows(VERSIONS).size).toBe(1);
      expect(fake.rows(CHANGES).size).toBe(1);
    } finally {
      gate.resolve();
      await pendingB;
    }
  });

  it("accepts a frozen-timestamp late claim without granting expired submission proof", async () => {
    let now = new Date(BASE),
      delayedId = "";
    const gate = deferred<void>(),
      entered = deferred<void>();
    const fake = createCatalogFake(() => now, {
      afterTimestamp: async ({ update, serverNow }) => {
        if (update.$set?.["scan.attemptId"] === delayedId) {
          expect(serverNow).toEqual(BASE);
          entered.resolve();
          await gate.promise;
        }
      },
    });
    const store = new ModelCatalogStore(fake.db, { now: () => now });
    const due = await store.readCatalogState("codex"),
      proposed = proposal(due.observed, now);
    delayedId = proposed.attemptId;
    const pending = store.beginDiscoveryAttempt("codex", proposed);
    try {
      await entered.promise;
      now = new Date(proposed.leaseExpiresAt.getTime() + 1);
      gate.resolve();
      const started = await pending;
      expect(started.kind).toBe("started");
      if (started.kind !== "started") throw new Error("Expected acknowledged match");
      const expired = cloneBson(catalog(fake));
      expect(expired).toMatchObject({ provider: "codex", scan: { attemptId: proposed.attemptId, outcome: "running" } });
      expect(expired.models).toBeUndefined();
      expect((await store.applyDiscovery(started.attempt, models("two"))).kind).toBe("commit-unknown");
      expect(catalog(fake)).toEqual(expired);
      expect(fake.rows(VERSIONS).size).toBe(0);
      expect(fake.rows(CHANGES).size).toBe(0);
      const nextDue = await store.readCatalogState("codex");
      const next = await store.beginDiscoveryAttempt("codex", proposal(nextDue.observed, now));
      expect(next.kind).toBe("started");
      if (next.kind !== "started") throw new Error("Takeover did not acquire");
      expect(await store.applyDiscovery(next.attempt, models("two"))).toMatchObject({
        kind: "committed",
        revision: 1,
      });
      expect(await store.failDiscoveryAttempt(started.attempt, { code: "timeout", message: "ignored" }, now)).toEqual({
        kind: "superseded",
      });
      expect(catalog(fake)).toMatchObject({
        revision: 1,
        scan: { attemptId: next.attempt.attemptId, outcome: "succeeded" },
      });
      expect(fake.rows(VERSIONS).size).toBe(1);
      expect(fake.rows(CHANGES).size).toBe(1);
    } finally {
      gate.resolve();
      await pending;
    }
  });

  it("binds observations to provider and copies scan BSON before caller mutation", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    fake.rows(CATALOG).set("codex", {
      _id: "codex",
      provider: "codex",
      models: models("one").map((row) => ({ ...row, addedAt: now })),
      scan: {
        outcome: "failed",
        attemptId: id(80),
        startedAt: new Date(now.getTime() - 200_000),
        finishedAt: new Date(now.getTime() - 190_000),
        error: { code: "storage", message: "$literal", detail: new ObjectId() },
      },
    });
    const store = new ModelCatalogStore(fake.db, { now: () => now });
    const due = await store.readCatalogState("codex");
    due.snapshot!.scan!.error!.message = "mutated";
    expect(await store.beginDiscoveryAttempt("codex", proposal(due.observed, now))).toMatchObject({ kind: "started" });
    const foreign = await store.readCatalogState("claude");
    await expect(store.beginDiscoveryAttempt("codex", proposal(foreign.observed, now))).rejects.toMatchObject({
      safe: { code: "malformed" },
    });
    await expect(
      store.beginDiscoveryAttempt("codex", proposal(Object.freeze({}) as AcquisitionObservation, now)),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("rejects absent-versus-null scan and every malformed or live lease without rewriting it", async () => {
    const malformed: unknown[] = [null, BASE.toISOString(), BASE.getTime(), [BASE], { at: BASE }];
    for (const [index, lease] of malformed.entries()) {
      const now = new Date(BASE),
        fake = createCatalogFake(() => now);
      fake.rows(CATALOG).set("codex", {
        _id: "codex",
        provider: "codex",
        scan: {
          attemptId: id(90 + index),
          startedAt: new Date(now.getTime() - 10),
          leaseExpiresAt: lease,
          outcome: "running",
        },
      });
      const store = new ModelCatalogStore(fake.db, { now: () => now });
      const due = await store.readCatalogState("codex"),
        before = cloneBson(catalog(fake));
      expect(await store.beginDiscoveryAttempt("codex", proposal(due.observed, now))).toEqual({ kind: "busy" });
      expect(catalog(fake)).toEqual(before);
      expect(fake.rows(VERSIONS).size).toBe(0);
      expect(fake.rows(CHANGES).size).toBe(0);
    }
    const fake = createCatalogFake(() => BASE);
    fake.rows(CATALOG).set("codex", {
      _id: "codex",
      provider: "codex",
      scan: {
        attemptId: id(99),
        startedAt: BASE,
        leaseExpiresAt: new Date(BASE.getTime() + 10_000),
        outcome: "running",
      },
    });
    const store = new ModelCatalogStore(fake.db, { now: () => BASE }),
      due = await store.readCatalogState("codex");
    expect(await store.beginDiscoveryAttempt("codex", proposal(due.observed, BASE))).toEqual({ kind: "busy" });
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("requires proposal expiry after server operation time including exact equality and clock disagreement", async () => {
    let local = new Date(BASE),
      server = new Date(BASE);
    const fake = createCatalogFake(() => server);
    const store = new ModelCatalogStore(fake.db, { now: () => local });
    const due = await store.readCatalogState("codex");
    const proposed = proposal(due.observed, local, 1000);
    server = new Date(proposed.leaseExpiresAt);
    expect(await store.beginDiscoveryAttempt("codex", proposed)).toEqual({ kind: "busy" });
    expect(catalog(fake)).toEqual({ _id: "codex", provider: "codex" });
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);

    local = new Date(BASE);
    server = new Date(BASE.getTime() + 10_000);
    const laterDue = await store.readCatalogState("codex");
    expect(await store.beginDiscoveryAttempt("codex", proposal(laterDue.observed, local, 5000))).toEqual({
      kind: "busy",
    });
    expect(catalog(fake)).toEqual({ _id: "codex", provider: "codex" });
  });

  it("expires a ready proof before submission and rejects caller date edits without consuming safe retry", async () => {
    let now = new Date(BASE);
    const fake = createCatalogFake(() => now),
      store = new ModelCatalogStore(fake.db, { now: () => now });
    const started = await begin(store, "codex", now, 1000);
    expect(started.kind).toBe("started");
    if (started.kind !== "started") throw new Error("missing start");
    const original = cloneBson(started.attempt);
    started.attempt.leaseExpiresAt = new Date(started.attempt.leaseExpiresAt.getTime() + 5000);
    expect(await store.applyDiscovery(started.attempt, models("one"))).toMatchObject({
      kind: "not-committed",
      error: { code: "malformed" },
    });
    expect(await store.applyDiscovery(original, models("one"))).toMatchObject({ kind: "committed", revision: 1 });
    const second = await begin(store, "claude", now, 1000);
    if (second.kind !== "started") throw new Error("missing start");
    now = new Date(second.attempt.leaseExpiresAt);
    expect(await store.applyDiscovery(second.attempt, models("one"))).toEqual({ kind: "superseded" });
    expect(catalog(fake, "claude")).toMatchObject({ scan: { outcome: "running" } });
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("allows only the first simultaneous apply to enter submission", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    const entered = deferred<void>(),
      gate = deferred<void>();
    let reads = 0;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "findOne" && ++reads === 3) {
        entered.resolve();
        await gate.promise;
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => now });
    const started = await begin(store, "codex", now);
    if (started.kind !== "started") throw new Error("missing start");
    const first = store.applyDiscovery(started.attempt, models("one"));
    await entered.promise;
    const second = await store.applyDiscovery(started.attempt, models("one"));
    expect(second).toMatchObject({ kind: "commit-unknown", operationId: started.attempt.attemptId });
    gate.resolve();
    expect(await first).toMatchObject({ kind: "committed", commitId: started.attempt.attemptId });
    expect(catalog(fake)).toMatchObject({ revision: 1, scan: { outcome: "succeeded" } });
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });
});

describe("discovery completion and concurrent catalog writers", () => {
  it("rebases discovery membership and names on a concurrent manual winner while retaining its notes", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    const setup = new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(120) });
    await setup.replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: [{ id: "one", displayName: "One", notes: "old" }],
    });
    const discoveryEntered = deferred<void>(),
      releaseDiscovery = deferred<void>();
    let attemptId = "";
    const discoveryDb = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (
        collectionName === CATALOG &&
        method === "updateOne" &&
        args[1].$set?.pendingExport?.version?._id === attemptId
      ) {
        discoveryEntered.resolve();
        await releaseDiscovery.promise;
      }
      return run();
    });
    const discovery = new ModelCatalogStore(discoveryDb, { now: () => now }),
      manual = new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(121) });
    const started = await begin(discovery, "codex", now);
    if (started.kind !== "started") throw new Error("missing start");
    attemptId = started.attempt.attemptId;
    const pending = discovery.applyDiscovery(started.attempt, [
      { id: "one", displayName: "Discovered One" },
      { id: "three", displayName: "Discovered Three" },
    ]);
    await discoveryEntered.promise;
    expect(
      await manual.replaceManual({
        provider: "codex",
        updatedBy: "operator",
        models: [
          { id: "one", displayName: "Manual One", notes: "latest" },
          { id: "two", displayName: "Manual Two", notes: "manual-only" },
        ],
      }),
    ).toMatchObject({ kind: "committed", revision: 2 });
    const scanBefore = cloneBson(catalog(fake)!.scan);
    releaseDiscovery.resolve();
    expect(await pending).toMatchObject({
      kind: "committed",
      revision: 3,
      added: ["three"],
      removed: ["two"],
    });
    expect(catalog(fake)).toMatchObject({
      revision: 3,
      source: "discovery",
      updatedBy: "system:model-catalog-scanner",
      scan: { attemptId, outcome: "succeeded", lastSucceededAt: now },
    });
    expect(catalog(fake)!.models.map((row: Row) => [row.id, row.displayName, row.notes])).toEqual([
      ["one", "Discovered One", "latest"],
      ["three", "Discovered Three", undefined],
    ]);
    expect(scanBefore).toMatchObject({ attemptId, outcome: "running" });
    expect(fake.rows(VERSIONS).size).toBe(3);
    expect(fake.rows(CHANGES).size).toBe(3);
  });

  it("rechecks an unchanged discovery after a manual edit and commits against the new revision", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    await new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(122) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    const entered = deferred<void>(),
      gate = deferred<void>();
    let held = true;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (
        held &&
        collectionName === CATALOG &&
        method === "updateOne" &&
        args[1].$set?.["scan.outcome"] === "succeeded" &&
        !args[1].$set?.pendingExport
      ) {
        held = false;
        entered.resolve();
        await gate.promise;
      }
      return run();
    });
    const discovery = new ModelCatalogStore(db, { now: () => now }),
      manual = new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(123) });
    const started = await begin(discovery, "codex", now);
    if (started.kind !== "started") throw new Error("missing start");
    const pending = discovery.applyDiscovery(started.attempt, models("one"));
    await entered.promise;
    await manual.replaceManual({ provider: "codex", updatedBy: "manual", models: models("one", "two") });
    gate.resolve();
    expect(await pending).toMatchObject({ kind: "committed", revision: 3, added: [], removed: ["two"] });
    expect(catalog(fake)).toMatchObject({
      revision: 3,
      models: [{ id: "one", displayName: "ONE", addedAt: BASE }],
      scan: { attemptId: started.attempt.attemptId, outcome: "succeeded" },
    });
    expect(fake.rows(VERSIONS).size).toBe(3);
    expect(fake.rows(CHANGES).size).toBe(3);
  });

  it("records a sanitized failure without changing snapshot freshness or immutable exports", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    await new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(124) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    catalog(fake)!.scan = {
      attemptId: id(125),
      startedAt: new Date(now.getTime() - 200_000),
      finishedAt: new Date(now.getTime() - 190_000),
      outcome: "succeeded",
      lastSucceededAt: new Date(now.getTime() - 190_000),
    };
    const store = new ModelCatalogStore(fake.db, { now: () => now });
    const started = await begin(store, "codex", now);
    if (started.kind !== "started") throw new Error("missing start");
    const snapshot = cloneBson(catalog(fake)!.models),
      freshness = catalog(fake)!.scan.lastSucceededAt;
    expect(
      await store.failDiscoveryAttempt(
        started.attempt,
        { code: "http", message: "raw secret token", httpStatus: 503 },
        new Date(now.getTime() + 10),
      ),
    ).toEqual({ kind: "recorded" });
    expect(catalog(fake)!.models).toEqual(snapshot);
    expect(catalog(fake)!.scan).toEqual({
      attemptId: started.attempt.attemptId,
      startedAt: now,
      outcome: "failed",
      finishedAt: new Date(now.getTime() + 10),
      lastSucceededAt: freshness,
      error: { code: "http", message: "Model catalog codex: http (HTTP 503).", httpStatus: 503 },
    });
    expect(JSON.stringify(catalog(fake))).not.toContain("raw secret");
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("reconciles applied failure acknowledgments and preserves uncertainty before application", async () => {
    for (const applyBeforeThrow of [true, false]) {
      const fake = createCatalogFake(() => BASE),
        store = new ModelCatalogStore(fake.db, { now: () => BASE }),
        started = await begin(store, "codex", BASE);
      if (started.kind !== "started") throw new Error("missing start");
      let fault = true;
      const db = faultDb(fake.db, async (collectionName, method, args, run) => {
        if (
          fault &&
          collectionName === CATALOG &&
          method === "updateOne" &&
          args[1].$set?.["scan.outcome"] === "failed"
        ) {
          fault = false;
          if (applyBeforeThrow) await run();
          throw new Error("failure acknowledgment uncertain");
        }
        return run();
      });
      const failing = new ModelCatalogStore(db, { now: () => BASE });
      if (applyBeforeThrow) {
        expect(await failing.failDiscoveryAttempt(started.attempt, { code: "timeout", message: "raw" }, BASE)).toEqual({
          kind: "recorded",
        });
        expect(catalog(fake)).toMatchObject({ scan: { attemptId: started.attempt.attemptId, outcome: "failed" } });
      } else {
        await expect(
          failing.failDiscoveryAttempt(started.attempt, { code: "timeout", message: "raw" }, BASE),
        ).rejects.toMatchObject({ safe: { code: "storage" } });
        expect(catalog(fake)).toMatchObject({ scan: { attemptId: started.attempt.attemptId, outcome: "running" } });
      }
      expect(fake.rows(VERSIONS).size).toBe(0);
      expect(fake.rows(CHANGES).size).toBe(0);
    }
  });

  it("handles legacy nonempty, status-only, and empty documents without false bootstrap", async () => {
    for (const [provider, initialModels, expectedKind, expectedVersions] of [
      ["codex", [{ id: "one", displayName: "ONE", addedAt: BASE }], "unchanged", 0],
      ["claude", undefined, "committed", 1],
      ["grok", [], "committed", 1],
    ] as const) {
      const fake = createCatalogFake(() => BASE);
      fake.rows(CATALOG).set(provider, {
        _id: provider,
        provider,
        ...(initialModels === undefined ? {} : { models: cloneBson(initialModels) }),
      });
      const store = new ModelCatalogStore(fake.db, { now: () => BASE });
      const started = await begin(store, provider, BASE);
      if (started.kind !== "started") throw new Error("missing start");
      const result = await store.applyDiscovery(started.attempt, models("one"));
      expect(result.kind).toBe(expectedKind);
      expect(catalog(fake, provider)).toMatchObject({
        provider,
        scan: { attemptId: started.attempt.attemptId, outcome: "succeeded", lastSucceededAt: BASE },
      });
      if (expectedKind === "unchanged") expect(catalog(fake, provider)!.revision).toBeUndefined();
      else {
        expect(catalog(fake, provider)).toMatchObject({ revision: 1 });
        expect(catalog(fake, provider)).not.toHaveProperty("pendingExport");
      }
      expect(fake.rows(VERSIONS).size).toBe(expectedVersions);
      expect(fake.rows(CHANGES).size).toBe(expectedVersions);
    }
  });
});

describe("acquisition timing schedules", () => {
  it("refuses a stale missing-document observation after a changed success", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    const dueA = await new ModelCatalogStore(fake.db).readCatalogState("codex"),
      dueB = await new ModelCatalogStore(fake.db).readCatalogState("codex");
    const entered = deferred<void>(),
      gate = deferred<void>();
    const proposedB = proposal(dueB.observed, now);
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (
        collectionName === CATALOG &&
        method === "updateOne" &&
        args[1].$set?.["scan.attemptId"] === proposedB.attemptId
      ) {
        entered.resolve();
        await gate.promise;
      }
      return run();
    });
    const a = new ModelCatalogStore(db, { now: () => now }),
      b = new ModelCatalogStore(db, { now: () => now });
    const pendingB = b.beginDiscoveryAttempt("codex", proposedB);
    await entered.promise;
    const startedA = await a.beginDiscoveryAttempt("codex", proposal(dueA.observed, now));
    if (startedA.kind !== "started") throw new Error("missing start");
    expect(await a.applyDiscovery(startedA.attempt, models("one"))).toMatchObject({ kind: "committed", revision: 1 });
    const completed = cloneBson(catalog(fake));
    gate.resolve();
    expect(await pendingB).toEqual({ kind: "busy" });
    expect(catalog(fake)).toEqual(completed);
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("refuses a stale legacy scanless observation after a changed success", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    fake.rows(CATALOG).set("codex", {
      _id: "codex",
      provider: "codex",
      models: [{ id: "one", displayName: "ONE", addedAt: BASE }],
    });
    const a = new ModelCatalogStore(fake.db, { now: () => now }),
      dueA = await a.readCatalogState("codex"),
      dueB = await a.readCatalogState("codex"),
      bProposal = proposal(dueB.observed, now),
      entered = deferred<void>(),
      gate = deferred<void>();
    const b = new ModelCatalogStore(
      faultDb(fake.db, async (collectionName, method, args, run) => {
        if (
          collectionName === CATALOG &&
          method === "updateOne" &&
          args[1].$set?.["scan.attemptId"] === bProposal.attemptId
        ) {
          entered.resolve();
          await gate.promise;
        }
        return run();
      }),
      { now: () => now },
    );
    const pendingB = b.beginDiscoveryAttempt("codex", bProposal);
    await entered.promise;
    const startedA = await a.beginDiscoveryAttempt("codex", proposal(dueA.observed, now));
    if (startedA.kind !== "started") throw new Error("missing start");
    expect(await a.applyDiscovery(startedA.attempt, models("two"))).toMatchObject({
      kind: "committed",
      revision: 1,
      bootstrap: false,
      added: ["two"],
      removed: ["one"],
    });
    const completed = cloneBson(catalog(fake));
    gate.resolve();
    expect(await pendingB).toEqual({ kind: "busy" });
    expect(catalog(fake)).toEqual(completed);
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("refuses a stale expired-running observation after the winner records failure", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    fake.rows(CATALOG).set("codex", {
      _id: "codex",
      provider: "codex",
      models: [{ id: "one", displayName: "ONE", addedAt: BASE }],
      scan: {
        attemptId: id(130),
        startedAt: new Date(now.getTime() - 200_000),
        leaseExpiresAt: new Date(now.getTime() - 1000),
        outcome: "running",
      },
    });
    const a = new ModelCatalogStore(fake.db, { now: () => now }),
      dueA = await a.readCatalogState("codex"),
      dueB = await a.readCatalogState("codex"),
      bProposal = proposal(dueB.observed, now);
    const entered = deferred<void>(),
      gate = deferred<void>();
    const b = new ModelCatalogStore(
      faultDb(fake.db, async (collectionName, method, args, run) => {
        if (
          collectionName === CATALOG &&
          method === "updateOne" &&
          args[1].$set?.["scan.attemptId"] === bProposal.attemptId
        ) {
          entered.resolve();
          await gate.promise;
        }
        return run();
      }),
      { now: () => now },
    );
    const pendingB = b.beginDiscoveryAttempt("codex", bProposal);
    await entered.promise;
    const startedA = await a.beginDiscoveryAttempt("codex", proposal(dueA.observed, now));
    if (startedA.kind !== "started") throw new Error("missing start");
    expect(await a.failDiscoveryAttempt(startedA.attempt, { code: "timeout", message: "ignored" }, now)).toEqual({
      kind: "recorded",
    });
    const completed = cloneBson(catalog(fake));
    gate.resolve();
    expect(await pendingB).toEqual({ kind: "busy" });
    expect(catalog(fake)).toEqual(completed);
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("uses the original missing observation after a delayed shell loses to a manual first seed", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now);
    const due = await new ModelCatalogStore(fake.db).readCatalogState("codex"),
      proposed = proposal(due.observed, now);
    const entered = deferred<void>(),
      gate = deferred<void>();
    let held = true;
    const delayed = new ModelCatalogStore(
      faultDb(fake.db, async (collectionName, method, _args, run) => {
        if (held && collectionName === CATALOG && method === "insertOne") {
          held = false;
          entered.resolve();
          await gate.promise;
        }
        return run();
      }),
      { now: () => now },
    );
    const pending = delayed.beginDiscoveryAttempt("codex", proposed);
    await entered.promise;
    await new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(131) }).replaceManual({
      provider: "codex",
      updatedBy: "manual",
      models: models("one"),
    });
    gate.resolve();
    expect(await pending).toEqual({ kind: "busy" });
    expect(catalog(fake)).toMatchObject({ revision: 1, models: [{ id: "one" }] });
    expect(catalog(fake)!.scan).toBeUndefined();
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("leaves only a harmless shell when setup delay carries the proposal past server expiry", async () => {
    let now = new Date(BASE);
    const fake = createCatalogFake(() => now),
      due = await new ModelCatalogStore(fake.db).readCatalogState("codex"),
      proposed = proposal(due.observed, now, 1000);
    const db = faultDb(fake.db, async (collectionName, method, _args, run) => {
      if (collectionName === VERSIONS && method === "createIndex") now = new Date(proposed.leaseExpiresAt);
      return run();
    });
    expect(await new ModelCatalogStore(db, { now: () => BASE }).beginDiscoveryAttempt("codex", proposed)).toEqual({
      kind: "busy",
    });
    expect(catalog(fake)).toEqual({ _id: "codex", provider: "codex" });
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("checks a frozen claim predicate against successor state before mutation", async () => {
    const now = new Date(BASE);
    let oldId = "";
    const entered = deferred<void>(),
      gate = deferred<void>();
    const fake = createCatalogFake(() => now, {
      afterTimestamp: async ({ update }) => {
        if (update.$set?.["scan.attemptId"] === oldId) {
          entered.resolve();
          await gate.promise;
        }
      },
    });
    const oldStore = new ModelCatalogStore(fake.db, { now: () => now }),
      oldDue = await oldStore.readCatalogState("codex"),
      oldProposal = proposal(oldDue.observed, now);
    oldId = oldProposal.attemptId;
    const pendingOld = oldStore.beginDiscoveryAttempt("codex", oldProposal);
    await entered.promise;
    const winner = new ModelCatalogStore(fake.db, { now: () => now });
    const winnerDue = await winner.readCatalogState("codex"),
      started = await winner.beginDiscoveryAttempt("codex", proposal(winnerDue.observed, now));
    if (started.kind !== "started") throw new Error("winner did not start");
    await winner.applyDiscovery(started.attempt, models("one"));
    const completed = cloneBson(catalog(fake));
    gate.resolve();
    expect(await pendingOld).toEqual({ kind: "busy" });
    expect(catalog(fake)).toEqual(completed);
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("does not let a delayed old acknowledgment replace a successor proof", async () => {
    let now = new Date(BASE),
      oldId = "";
    const entered = deferred<void>(),
      gate = deferred<void>();
    const fake = createCatalogFake(() => now);
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.["scan.attemptId"] === oldId) {
        const result = await run();
        entered.resolve();
        await gate.promise;
        return result;
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => now });
    const oldDue = await store.readCatalogState("codex"),
      oldProposal = proposal(oldDue.observed, now, 1000);
    oldId = oldProposal.attemptId;
    const pendingOld = store.beginDiscoveryAttempt("codex", oldProposal);
    await entered.promise;
    now = new Date(oldProposal.leaseExpiresAt.getTime() + 1);
    const nextDue = await store.readCatalogState("codex"),
      next = await store.beginDiscoveryAttempt("codex", proposal(nextDue.observed, now));
    expect(next.kind).toBe("started");
    gate.resolve();
    expect((await pendingOld).kind).toBe("started");
    if (next.kind !== "started") throw new Error("successor did not start");
    expect(await store.applyDiscovery(next.attempt, models("one"))).toMatchObject({ kind: "committed", revision: 1 });
    expect(catalog(fake)).toMatchObject({ scan: { attemptId: next.attempt.attemptId, outcome: "succeeded" } });
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("does not let a delayed old claim acknowledgment disturb an already uncertain successor", async () => {
    let now = new Date(BASE),
      oldId = "",
      successorRun: (() => Promise<any>) | undefined;
    const oldAckEntered = deferred<void>(),
      releaseOldAck = deferred<void>();
    const fake = createCatalogFake(() => now);
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName !== CATALOG || method !== "updateOne") return run();
      if (args[1].$set?.["scan.attemptId"] === oldId) {
        const result = await run();
        oldAckEntered.resolve();
        await releaseOldAck.promise;
        return result;
      }
      if (args[1].$set?.pendingExport && !successorRun) {
        successorRun = run;
        throw new Error("successor uncertain");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => now }),
      oldDue = await store.readCatalogState("codex"),
      oldProposal = proposal(oldDue.observed, now, 1000);
    oldId = oldProposal.attemptId;
    const oldPending = store.beginDiscoveryAttempt("codex", oldProposal);
    await oldAckEntered.promise;
    now = new Date(oldProposal.leaseExpiresAt.getTime() + 1);
    const successor = await begin(store, "codex", now);
    if (successor.kind !== "started") throw new Error("successor did not start");
    expect(await store.applyDiscovery(successor.attempt, models("one"))).toMatchObject({
      kind: "commit-unknown",
      operationId: successor.attempt.attemptId,
    });
    releaseOldAck.resolve();
    expect((await oldPending).kind).toBe("started");
    expect(await store.applyDiscovery(successor.attempt, models("one"))).toMatchObject({
      kind: "commit-unknown",
      operationId: successor.attempt.attemptId,
    });
    expect(await successorRun!()).toMatchObject({ matchedCount: 1 });
    expect(await store.applyDiscovery(successor.attempt, models("one"))).toMatchObject({
      kind: "committed",
      commitId: successor.attempt.attemptId,
    });
    expect(catalog(fake)).toMatchObject({
      revision: 1,
      scan: { attemptId: successor.attempt.attemptId, outcome: "succeeded" },
    });
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("allows seeded manual edits and export recovery between observation and claim", async () => {
    for (const action of ["edit", "recover"] as const) {
      const now = new Date(BASE),
        fake = createCatalogFake(() => now);
      const seedStore = new ModelCatalogStore(fake.db, {
        now: () => now,
        uuid: () => id(action === "edit" ? 132 : 133),
      });
      await seedStore.replaceManual({
        provider: "codex",
        updatedBy: "seed",
        models: [{ id: "one", displayName: "One", notes: "old" }],
      });
      const due = await seedStore.readCatalogState("codex");
      if (action === "edit") {
        await new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(134) }).replaceManual({
          provider: "codex",
          updatedBy: "editor",
          models: [{ id: "one", displayName: "Edited", notes: "new" }],
        });
      } else {
        const version = cloneBson(fake.rows(VERSIONS).values().next().value);
        const change = cloneBson(fake.rows(CHANGES).values().next().value);
        catalog(fake)!.pendingExport = {
          version,
          change: Object.fromEntries(Object.entries(change).filter(([key]) => key !== "delivery")),
        };
        await seedStore.recoverPendingExports("codex");
      }
      const before = cloneBson(catalog(fake));
      const started = await seedStore.beginDiscoveryAttempt("codex", proposal(due.observed, now));
      expect(started.kind).toBe("started");
      expect(catalog(fake)).toMatchObject({
        revision: before.revision,
        models: before.models,
        scan: { outcome: "running" },
      });
      expect(fake.rows(VERSIONS).size).toBe(action === "edit" ? 2 : 1);
      expect(fake.rows(CHANGES).size).toBe(1);
    }
  });
});

describe("guarded database protocol", () => {
  it("treats a guard refusal before a changed snapshot commit as definitely not committed", async () => {
    const fake = createCatalogFake(() => BASE),
      guard = new WriteGuard({ instanceId: "hive", dbName: "hive_hive" });
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(139) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    let engageOnce = true;
    const db = faultDb(guardDb(fake.db, guard), async (collectionName, method, args, run) => {
      if (engageOnce && collectionName === CATALOG && method === "updateOne" && args[1].$set?.pendingExport) {
        engageOnce = false;
        guard.engage("test mismatch");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE }),
      started = await begin(store, "codex", BASE);
    if (started.kind !== "started") throw new Error("missing start");
    const before = cloneBson(catalog(fake));
    expect(await store.applyDiscovery(started.attempt, models("two"))).toMatchObject({
      kind: "not-committed",
      retriable: true,
      error: { code: "storage" },
    });
    expect(guard.refusedWriteCount).toBe(1);
    expect(catalog(fake)).toEqual(before);
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
    guard.disengage();
    expect(await store.applyDiscovery(started.attempt, models("two"))).toMatchObject({
      kind: "committed",
      revision: 2,
      added: ["two"],
      removed: ["one"],
    });
    expect(catalog(fake)).toMatchObject({ revision: 2, scan: { outcome: "succeeded" } });
    expect(fake.rows(VERSIONS).size).toBe(2);
    expect(fake.rows(CHANGES).size).toBe(2);
  });

  it("treats a guard refusal before unchanged completion delegation as definitely not committed", async () => {
    const now = new Date(BASE),
      fake = createCatalogFake(() => now),
      guard = new WriteGuard({ instanceId: "hive", dbName: "hive_hive" });
    const guarded = guardDb(fake.db, guard);
    let engageOnce = true;
    const db = faultDb(guarded, async (collectionName, method, args, run) => {
      if (
        engageOnce &&
        collectionName === CATALOG &&
        method === "updateOne" &&
        args[1].$set?.["scan.outcome"] === "succeeded"
      ) {
        engageOnce = false;
        guard.engage("test mismatch");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => now, uuid: () => id(140) });
    await store.replaceManual({ provider: "codex", updatedBy: "seed", models: models("one") });
    await store.ensureIndexes();
    const started = await begin(store, "codex", now);
    if (started.kind !== "started") throw new Error("missing start");
    const before = {
      catalog: cloneBson(catalog(fake)),
      versions: cloneBson([...fake.rows(VERSIONS).values()]),
      changes: cloneBson([...fake.rows(CHANGES).values()]),
    };
    expect(await store.applyDiscovery(started.attempt, models("one"))).toMatchObject({
      kind: "not-committed",
      retriable: true,
      error: { code: "storage" },
    });
    expect(guard.refusedWriteCount).toBe(1);
    expect(catalog(fake)).toEqual(before.catalog);
    expect([...fake.rows(VERSIONS).values()]).toEqual(before.versions);
    expect([...fake.rows(CHANGES).values()]).toEqual(before.changes);
    guard.disengage();
    expect(await store.applyDiscovery(started.attempt, models("one"))).toMatchObject({
      kind: "unchanged",
      revision: 1,
    });
    expect(catalog(fake)).toMatchObject({ scan: { outcome: "succeeded", lastSucceededAt: now } });
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("forwards journaled collection options and preserves bound methods through faultDb", async () => {
    const fake = createCatalogFake(() => BASE),
      calls: Array<{ name: string; options: unknown }> = [];
    const recording = new Proxy(fake.db, {
      get(target, key) {
        if (key === "collection") {
          return (name: string, options?: unknown) => {
            calls.push({ name, options });
            return target.collection(name, options as never);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let delegated = 0;
    const db = faultDb(recording, async (_collection, _method, _args, run) => {
      delegated++;
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE, uuid: () => id(141) });
    await store.replaceManual({ provider: "codex", updatedBy: "a", models: models("one") });
    await db.collection(CATALOG).findOne({ _id: "codex" });
    expect(calls).toEqual([
      { name: CATALOG, options: { writeConcern: { w: 1, j: true } } },
      { name: VERSIONS, options: { writeConcern: { w: 1, j: true } } },
      { name: CHANGES, options: { writeConcern: { w: 1, j: true } } },
      { name: CATALOG, options: undefined },
    ]);
    expect(fake.indexes.every((entry) => entry.options === undefined)).toBe(true);
    expect(delegated).toBeGreaterThan(0);
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });
});

describe("begin uncertainty and bounded evidence", () => {
  it("stops after a thrown shell insert and one negative evidence read", async () => {
    const fake = createCatalogFake(() => BASE);
    let inserts = 0,
      claimCalls = 0,
      catalogReads = 0;
    const db = faultDb(fake.db, async (collectionName, method, _args, run) => {
      if (collectionName === CATALOG && method === "findOne") catalogReads++;
      if (collectionName === CATALOG && method === "insertOne") {
        inserts++;
        throw new Error("uncertain shell failure");
      }
      if (collectionName === CATALOG && method === "updateOne") claimCalls++;
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE }),
      due = await store.readCatalogState("codex"),
      beforeReads = catalogReads;
    await expect(store.beginDiscoveryAttempt("codex", proposal(due.observed, BASE))).rejects.toMatchObject({
      safe: { code: "storage", message: "Model catalog codex: storage." },
    });
    expect(inserts).toBe(1);
    expect(claimCalls).toBe(0);
    expect(catalogReads - beforeReads).toBe(2);
    expect(catalog(fake)).toBeUndefined();
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("returns proof-free started when a claim applies but its acknowledgment throws", async () => {
    const fake = createCatalogFake(() => BASE);
    let throwAfterApply = true;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (
        throwAfterApply &&
        collectionName === CATALOG &&
        method === "updateOne" &&
        args[1].$set?.["scan.outcome"] === "running"
      ) {
        throwAfterApply = false;
        await run();
        throw new Error("ambiguous claim acknowledgment");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE }),
      due = await store.readCatalogState("codex"),
      proposed = proposal(due.observed, BASE),
      started = await store.beginDiscoveryAttempt("codex", proposed);
    expect(started).toMatchObject({ kind: "started", attempt: { attemptId: proposed.attemptId } });
    if (started.kind !== "started") throw new Error("missing evidence start");
    expect(await store.applyDiscovery(started.attempt, models("one"))).toMatchObject({
      kind: "commit-unknown",
      operationId: proposed.attemptId,
    });
    expect(catalog(fake)).toMatchObject({ scan: { attemptId: proposed.attemptId, outcome: "running" } });
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("keeps a pre-application claim unknown when it applies after the evidence read", async () => {
    const fake = createCatalogFake(() => BASE);
    let delayedRun: (() => Promise<any>) | undefined;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (
        collectionName === CATALOG &&
        method === "updateOne" &&
        args[1].$set?.["scan.outcome"] === "running" &&
        !delayedRun
      ) {
        delayedRun = run;
        throw new Error("delegation outcome unknown");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE }),
      due = await store.readCatalogState("codex"),
      proposed = proposal(due.observed, BASE);
    await expect(store.beginDiscoveryAttempt("codex", proposed)).rejects.toMatchObject({ safe: { code: "storage" } });
    expect(catalog(fake)).toEqual({ _id: "codex", provider: "codex" });
    expect(delayedRun).toBeTypeOf("function");
    expect(await delayedRun!()).toMatchObject({ matchedCount: 1 });
    const reread = await new ModelCatalogStore(fake.db, { now: () => BASE }).beginDiscoveryAttempt("codex", proposed);
    expect(reread.kind).toBe("started");
    const attempt = { provider: "codex", ...proposed } as DiscoveryAttempt;
    expect(await new ModelCatalogStore(fake.db).applyDiscovery(attempt, models("one"))).toMatchObject({
      kind: "commit-unknown",
      operationId: proposed.attemptId,
    });
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("rejects expired or different-date evidence for a reused attempt token", async () => {
    let now = new Date(BASE);
    const fake = createCatalogFake(() => now),
      store = new ModelCatalogStore(fake.db, { now: () => now }),
      due = await store.readCatalogState("codex"),
      proposed = proposal(due.observed, now, 1000),
      started = await store.beginDiscoveryAttempt("codex", proposed);
    expect(started.kind).toBe("started");
    const currentDue = await store.readCatalogState("codex");
    expect(
      await new ModelCatalogStore(fake.db, { now: () => now }).beginDiscoveryAttempt("codex", {
        ...proposed,
        startedAt: new Date(proposed.startedAt.getTime() + 1),
        observed: currentDue.observed,
      }),
    ).toEqual({ kind: "busy" });
    now = new Date(proposed.leaseExpiresAt);
    await expect(
      new ModelCatalogStore(fake.db, { now: () => now }).beginDiscoveryAttempt("codex", {
        ...proposed,
        observed: currentDue.observed,
      }),
    ).rejects.toMatchObject({ safe: { code: "malformed" } });
    expect(catalog(fake)).toMatchObject({ scan: { attemptId: proposed.attemptId, outcome: "running" } });
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("surfaces storage uncertainty when an applied claim is already expired at its evidence read", async () => {
    let now = new Date(BASE);
    const fake = createCatalogFake(() => now);
    let proposedLease: Date | undefined;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.["scan.outcome"] === "running") {
        proposedLease = args[1].$set["scan.leaseExpiresAt"];
        await run();
        now = new Date(proposedLease!.getTime());
        throw new Error("late ambiguous acknowledgment");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => now }),
      due = await store.readCatalogState("codex"),
      proposed = proposal(due.observed, now, 1000);
    await expect(store.beginDiscoveryAttempt("codex", proposed)).rejects.toMatchObject({ safe: { code: "storage" } });
    expect(catalog(fake)).toMatchObject({ scan: { attemptId: proposed.attemptId, outcome: "running" } });
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("does not call claim again when uncertain evidence itself is unavailable", async () => {
    const fake = createCatalogFake(() => BASE);
    let claimCalls = 0,
      throwEvidence = false;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (throwEvidence && collectionName === CATALOG && method === "findOne") {
        throwEvidence = false;
        throw new Error("evidence unavailable");
      }
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.["scan.outcome"] === "running") {
        claimCalls++;
        throwEvidence = true;
        throw new Error("claim uncertain");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE }),
      due = await store.readCatalogState("codex");
    await expect(store.beginDiscoveryAttempt("codex", proposal(due.observed, BASE))).rejects.toMatchObject({
      safe: { code: "storage" },
    });
    expect(claimCalls).toBe(1);
    expect(catalog(fake)).toEqual({ _id: "codex", provider: "codex" });
    expect(fake.rows(VERSIONS).size).toBe(0);
    expect(fake.rows(CHANGES).size).toBe(0);
  });

  it("refuses a client-delayed proposal after a successor completes", async () => {
    let serverNow = new Date(BASE);
    const fake = createCatalogFake(() => serverNow),
      oldStore = new ModelCatalogStore(fake.db, { now: () => BASE });
    const oldDue = await oldStore.readCatalogState("codex"),
      oldProposal = proposal(oldDue.observed, BASE, 1000),
      entered = deferred<void>(),
      gate = deferred<void>();
    const delayedDb = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (
        collectionName === CATALOG &&
        method === "updateOne" &&
        args[1].$set?.["scan.attemptId"] === oldProposal.attemptId
      ) {
        entered.resolve();
        await gate.promise;
      }
      return run();
    });
    const pendingOld = new ModelCatalogStore(delayedDb, { now: () => BASE }).beginDiscoveryAttempt(
      "codex",
      oldProposal,
    );
    await entered.promise;
    serverNow = new Date(oldProposal.leaseExpiresAt);
    const winner = new ModelCatalogStore(fake.db, { now: () => serverNow }),
      winnerDue = await winner.readCatalogState("codex"),
      winnerStart = await winner.beginDiscoveryAttempt("codex", proposal(winnerDue.observed, serverNow));
    if (winnerStart.kind !== "started") throw new Error("winner did not start");
    await winner.applyDiscovery(winnerStart.attempt, models("one"));
    const completed = cloneBson(catalog(fake));
    gate.resolve();
    expect(await pendingOld).toEqual({ kind: "busy" });
    expect(catalog(fake)).toEqual(completed);
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("requires an expired stored lease to be expired against both local and server clocks", async () => {
    for (const [local, server, lease] of [
      [new Date(BASE), new Date(BASE.getTime() - 2000), new Date(BASE.getTime() - 1000)],
      [new Date(BASE.getTime() - 2000), new Date(BASE), new Date(BASE.getTime() - 1000)],
    ]) {
      const fake = createCatalogFake(() => server);
      fake.rows(CATALOG).set("codex", {
        _id: "codex",
        provider: "codex",
        scan: {
          attemptId: id(145),
          startedAt: new Date(BASE.getTime() - 5000),
          leaseExpiresAt: lease,
          outcome: "running",
        },
      });
      const store = new ModelCatalogStore(fake.db, { now: () => local }),
        due = await store.readCatalogState("codex");
      expect(await store.beginDiscoveryAttempt("codex", proposal(due.observed, local, 10_000))).toEqual({
        kind: "busy",
      });
      expect(catalog(fake)).toMatchObject({ scan: { attemptId: id(145), leaseExpiresAt: lease } });
      expect(fake.rows(VERSIONS).size).toBe(0);
      expect(fake.rows(CHANGES).size).toBe(0);
    }
  });
});

describe("replacement and unchanged uncertainty", () => {
  it("recovers a replacement that applied before throwing and reports its exact identity", async () => {
    const fake = createCatalogFake(() => BASE);
    let ambiguous = true;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (ambiguous && collectionName === CATALOG && (method === "insertOne" || args[1]?.$set?.pendingExport)) {
        ambiguous = false;
        await run();
        throw new Error("raw write acknowledgment secret");
      }
      return run();
    });
    const result = await new ModelCatalogStore(db, { now: () => BASE, uuid: () => id(150) }).replaceManual({
      provider: "codex",
      updatedBy: "a",
      models: models("one"),
    });
    expect(result).toMatchObject({
      kind: "committed",
      commitId: id(150),
      revision: 1,
      bootstrap: true,
      added: ["one"],
      removed: [],
      recoveryPending: false,
    });
    expect(catalog(fake)).toMatchObject({ revision: 1, commitId: id(150) });
    expect(catalog(fake)).not.toHaveProperty("pendingExport");
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("returns the original operation unknown, then reconciles one delayed discovery commit", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(151) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    let delayedRun: (() => Promise<any>) | undefined,
      failHistory = false,
      replacementCalls = 0;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.pendingExport) {
        replacementCalls++;
        if (!delayedRun) {
          delayedRun = run;
          throw new Error("delayed discovery write");
        }
      }
      if (failHistory && collectionName === VERSIONS && method === "insertOne") throw new Error("history unavailable");
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE }),
      started = await begin(store, "codex", BASE);
    if (started.kind !== "started") throw new Error("missing start");
    const first = await store.applyDiscovery(started.attempt, models("two"));
    expect(first).toMatchObject({ kind: "commit-unknown", operationId: started.attempt.attemptId });
    expect(replacementCalls).toBe(1);
    expect(catalog(fake)).toMatchObject({ revision: 1, models: [{ id: "one" }], scan: { outcome: "running" } });
    failHistory = true;
    expect(await delayedRun!()).toMatchObject({ matchedCount: 1 });
    const saved = cloneBson(catalog(fake));
    const second = await store.applyDiscovery(started.attempt, models("two"));
    expect(second).toMatchObject({
      kind: "committed",
      commitId: started.attempt.attemptId,
      revision: 2,
      added: ["two"],
      removed: ["one"],
      recoveryPending: true,
    });
    expect(replacementCalls).toBe(1);
    expect(catalog(fake)).toEqual(saved);
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
    expect(
      await new ModelCatalogStore(db, { now: () => BASE, uuid: () => id(152) }).replaceManual({
        provider: "codex",
        updatedBy: "next",
        models: models("three"),
      }),
    ).toMatchObject({ kind: "not-committed", retriable: true });
  });

  it("rechecks catalog evidence after recovery when the delayed commit lands between history and recovery reads", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(153) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    let delayedRun: (() => Promise<any>) | undefined,
      releaseOnNullHistory = false,
      released = false;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.pendingExport && !delayedRun) {
        delayedRun = run;
        throw new Error("deferred");
      }
      if (releaseOnNullHistory && !released && collectionName === VERSIONS && method === "findOne" && args[0]._id) {
        const found = await run();
        expect(found).toBeNull();
        released = true;
        await delayedRun!();
        return found;
      }
      if (released && collectionName === VERSIONS && method === "insertOne") throw new Error("projection blocked");
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE }),
      started = await begin(store, "codex", BASE);
    if (started.kind !== "started") throw new Error("missing start");
    expect(await store.applyDiscovery(started.attempt, models("two"))).toMatchObject({ kind: "commit-unknown" });
    releaseOnNullHistory = true;
    expect(await store.applyDiscovery(started.attempt, models("two"))).toMatchObject({
      kind: "committed",
      commitId: started.attempt.attemptId,
      recoveryPending: true,
    });
    expect(released).toBe(true);
    expect(catalog(fake)).toMatchObject({
      revision: 2,
      pendingExport: { version: { _id: started.attempt.attemptId } },
    });
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("keeps unresolved reentry on the reconciliation path and never initializes indexes", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(154) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    let delayedRun: (() => Promise<any>) | undefined;
    const initialDb = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.pendingExport && !delayedRun) {
        delayedRun = run;
        throw new Error("deferred");
      }
      return run();
    });
    const firstStore = new ModelCatalogStore(initialDb, { now: () => BASE }),
      started = await begin(firstStore, "codex", BASE);
    if (started.kind !== "started") throw new Error("missing start");
    expect(await firstStore.applyDiscovery(started.attempt, models("two"))).toMatchObject({ kind: "commit-unknown" });
    let indexCalls = 0,
      replacementCalls = 0;
    const freshDb = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (method === "createIndex") {
        indexCalls++;
        throw new Error("must be unreachable");
      }
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.pendingExport) replacementCalls++;
      return run();
    });
    const fresh = new ModelCatalogStore(freshDb, { now: () => BASE });
    expect(await fresh.applyDiscovery(started.attempt, "malformed rows ignored during reconciliation")).toMatchObject({
      kind: "commit-unknown",
      operationId: started.attempt.attemptId,
    });
    const malformedDates: DiscoveryAttempt = {
      ...started.attempt,
      startedAt: new Date(Number.NaN),
      leaseExpiresAt: new Date(Number.NaN),
    };
    expect(await fresh.applyDiscovery(malformedDates, [{ malformed: true }])).toMatchObject({
      kind: "commit-unknown",
      operationId: started.attempt.attemptId,
    });
    expect(indexCalls).toBe(0);
    expect(replacementCalls).toBe(0);
    expect(await delayedRun!()).toMatchObject({ matchedCount: 1 });
    expect(await fresh.applyDiscovery(started.attempt, models("two"))).toMatchObject({
      kind: "committed",
      commitId: started.attempt.attemptId,
    });
    expect(indexCalls).toBe(0);
    expect(replacementCalls).toBe(0);
    expect(catalog(fake)).toMatchObject({ revision: 2, scan: { outcome: "succeeded" } });
    expect(fake.rows(VERSIONS).size).toBe(2);
    expect(fake.rows(CHANGES).size).toBe(2);
  });

  it("lets transient evidence failures recover but all unavailable evidence stays unknown", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(155) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    const base = new ModelCatalogStore(fake.db, { now: () => BASE }),
      started = await begin(base, "codex", BASE);
    if (started.kind !== "started") throw new Error("missing start");
    await base.applyDiscovery(started.attempt, models("two"));
    let transient = true;
    const transientDb = faultDb(fake.db, async (collectionName, method, _args, run) => {
      if (transient && collectionName === CATALOG && method === "findOne") {
        transient = false;
        throw new Error("one read failed");
      }
      return run();
    });
    expect(await new ModelCatalogStore(transientDb).applyDiscovery(started.attempt, models("two"))).toMatchObject({
      kind: "committed",
      commitId: started.attempt.attemptId,
    });
    const unavailableDb = faultDb(fake.db, async (collectionName, method, _args, run) => {
      if ((collectionName === CATALOG || collectionName === VERSIONS) && method === "findOne") {
        throw new Error("all evidence unavailable");
      }
      return run();
    });
    expect(await new ModelCatalogStore(unavailableDb).applyDiscovery(started.attempt, models("two"))).toMatchObject({
      kind: "commit-unknown",
      operationId: started.attempt.attemptId,
    });
    expect(catalog(fake)).toMatchObject({ revision: 2, scan: { outcome: "succeeded" } });
    expect(fake.rows(VERSIONS).size).toBe(2);
    expect(fake.rows(CHANGES).size).toBe(2);
  });

  it("does not replay a delayed write and allows a newer revision to fence it", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(156) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    let delayedRun: (() => Promise<any>) | undefined,
      submissions = 0;
    const db = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.pendingExport) {
        submissions++;
        if (!delayedRun) {
          delayedRun = run;
          throw new Error("delayed");
        }
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => BASE }),
      started = await begin(store, "codex", BASE);
    if (started.kind !== "started") throw new Error("missing start");
    expect(await store.applyDiscovery(started.attempt, models("two"))).toMatchObject({ kind: "commit-unknown" });
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(157) }).replaceManual({
      provider: "codex",
      updatedBy: "winner",
      models: models("three"),
    });
    expect(await delayedRun!()).toMatchObject({ matchedCount: 0 });
    expect(await store.applyDiscovery(started.attempt, [{ bad: "rows are not revalidated on unknown" }])).toMatchObject(
      {
        kind: "commit-unknown",
        operationId: started.attempt.attemptId,
      },
    );
    expect(submissions).toBe(1);
    expect(catalog(fake)).toMatchObject({ revision: 2, updatedBy: "winner", models: [{ id: "three" }] });
    expect(fake.rows(VERSIONS).size).toBe(2);
    expect(fake.rows(CHANGES).size).toBe(2);
  });

  it("reconciles an unchanged mutation that applied before throwing and fences a delayed one", async () => {
    for (const applies of [true, false]) {
      const fake = createCatalogFake(() => BASE);
      await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(applies ? 158 : 159) }).replaceManual({
        provider: "codex",
        updatedBy: "seed",
        models: models("one"),
      });
      let delayedRun: (() => Promise<any>) | undefined;
      const db = faultDb(fake.db, async (collectionName, method, args, run) => {
        if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.["scan.outcome"] === "succeeded") {
          if (applies) {
            await run();
            throw new Error("applied status ack failed");
          }
          delayedRun = run;
          throw new Error("deferred status");
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => BASE }),
        started = await begin(store, "codex", BASE);
      if (started.kind !== "started") throw new Error("missing start");
      const result = await store.applyDiscovery(started.attempt, models("one"));
      if (applies) {
        expect(result).toMatchObject({ kind: "unchanged", revision: 1, lastSucceededAt: BASE });
        expect(catalog(fake)).toMatchObject({ revision: 1, scan: { outcome: "succeeded", lastSucceededAt: BASE } });
      } else {
        expect(result).toMatchObject({ kind: "commit-unknown", operationId: started.attempt.attemptId });
        await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(160) }).replaceManual({
          provider: "codex",
          updatedBy: "winner",
          models: models("two"),
        });
        expect(await delayedRun!()).toMatchObject({ matchedCount: 0 });
        expect(catalog(fake)).toMatchObject({ revision: 2, models: [{ id: "two" }], scan: { outcome: "running" } });
      }
      expect(fake.rows(VERSIONS).size).toBe(applies ? 1 : 2);
      expect(fake.rows(CHANGES).size).toBe(applies ? 1 : 2);
    }
  });

  it("does not let an older proven refusal restore over a newer ready or consumed proof", async () => {
    for (const consumeSuccessor of [false, true]) {
      let now = new Date(BASE);
      const fake = createCatalogFake(() => now),
        guard = new WriteGuard({ instanceId: "hive", dbName: "hive_hive" });
      await new ModelCatalogStore(fake.db, { now: () => now, uuid: () => id(170) }).replaceManual({
        provider: "codex",
        updatedBy: "seed",
        models: models("one"),
      });
      const aEntered = deferred<void>(),
        releaseA = deferred<void>();
      let aId = "",
        bId = "",
        bRun: (() => Promise<any>) | undefined;
      const db = faultDb(guardDb(fake.db, guard), async (collectionName, method, args, run) => {
        const operationId = args[1]?.$set?.pendingExport?.version?._id;
        if (collectionName === CATALOG && method === "updateOne" && operationId === aId) {
          aEntered.resolve();
          await releaseA.promise;
          return run();
        }
        if (consumeSuccessor && collectionName === CATALOG && method === "updateOne" && operationId === bId && !bRun) {
          bRun = run;
          throw new Error("successor remains uncertain");
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => now });
      const aStart = await begin(store, "codex", now, 1000);
      if (aStart.kind !== "started") throw new Error("A did not start");
      aId = aStart.attempt.attemptId;
      const pendingA = store.applyDiscovery(aStart.attempt, models("two"));
      await aEntered.promise;
      now = new Date(aStart.attempt.leaseExpiresAt.getTime() + 1);
      const bStart = await begin(store, "codex", now);
      if (bStart.kind !== "started") throw new Error("B did not start");
      bId = bStart.attempt.attemptId;
      let bUnknown: Awaited<ReturnType<ModelCatalogStore["applyDiscovery"]>> | undefined;
      if (consumeSuccessor) {
        bUnknown = await store.applyDiscovery(bStart.attempt, models("three"));
        expect(bUnknown).toMatchObject({ kind: "commit-unknown", operationId: bId });
      }
      guard.engage("refuse old delegated mutation");
      releaseA.resolve();
      expect(await pendingA).toMatchObject({ kind: "not-committed", retriable: true });
      expect(guard.refusedWriteCount).toBe(1);
      if (consumeSuccessor) {
        expect(await store.applyDiscovery(bStart.attempt, models("three"))).toMatchObject({
          kind: "commit-unknown",
          operationId: bId,
        });
        guard.disengage();
        expect(await bRun!()).toMatchObject({ matchedCount: 1 });
        expect(await store.applyDiscovery(bStart.attempt, models("three"))).toMatchObject({
          kind: "committed",
          commitId: bId,
        });
      } else {
        guard.disengage();
        expect(await store.applyDiscovery(bStart.attempt, models("three"))).toMatchObject({
          kind: "committed",
          commitId: bId,
        });
      }
      expect(catalog(fake)).toMatchObject({
        revision: 2,
        models: [{ id: "three" }],
        scan: { attemptId: bId, outcome: "succeeded" },
      });
      expect(fake.rows(VERSIONS).size).toBe(2);
      expect(fake.rows(CHANGES).size).toBe(2);
    }
  });

  it("preserves delayed commit evidence across an explicit failing index initialization", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(171) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    let delayedRun: (() => Promise<any>) | undefined;
    const firstDb = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.pendingExport && !delayedRun) {
        delayedRun = run;
        throw new Error("delayed");
      }
      return run();
    });
    const first = new ModelCatalogStore(firstDb, { now: () => BASE }),
      started = await begin(first, "codex", BASE);
    if (started.kind !== "started") throw new Error("missing start");
    expect(await first.applyDiscovery(started.attempt, models("two"))).toMatchObject({ kind: "commit-unknown" });
    let released = false,
      indexCalls = 0;
    const freshDb = faultDb(fake.db, async (_collectionName, method, _args, run) => {
      if (method === "createIndex") {
        indexCalls++;
        if (!released) {
          released = true;
          await delayedRun!();
        }
        throw new Error("index unavailable");
      }
      return run();
    });
    const fresh = new ModelCatalogStore(freshDb, { now: () => BASE });
    await expect(fresh.ensureIndexes()).rejects.toThrow("index unavailable");
    expect(indexCalls).toBeGreaterThan(0);
    expect(await fresh.applyDiscovery(started.attempt, models("two"))).toMatchObject({
      kind: "committed",
      commitId: started.attempt.attemptId,
      revision: 2,
    });
    expect(catalog(fake)).toMatchObject({ revision: 2, scan: { outcome: "succeeded" } });
    expect(fake.rows(VERSIONS).size).toBe(2);
    expect(fake.rows(CHANGES).size).toBe(2);
  });

  it("finds exported old-operation history after a later manual revision despite history read failure", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(172) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    const discovery = new ModelCatalogStore(fake.db, { now: () => BASE }),
      started = await begin(discovery, "codex", BASE);
    if (started.kind !== "started") throw new Error("missing start");
    await discovery.applyDiscovery(started.attempt, models("two"));
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(173) }).replaceManual({
      provider: "codex",
      updatedBy: "later",
      models: models("three"),
    });
    let failHistoryOnce = true;
    const transient = faultDb(fake.db, async (collectionName, method, _args, run) => {
      if (failHistoryOnce && collectionName === VERSIONS && method === "findOne") {
        failHistoryOnce = false;
        throw new Error("transient history read");
      }
      return run();
    });
    expect(await new ModelCatalogStore(transient).applyDiscovery(started.attempt, models("two"))).toMatchObject({
      kind: "committed",
      commitId: started.attempt.attemptId,
      revision: 2,
    });
    const unavailable = faultDb(fake.db, async (collectionName, method, _args, run) => {
      if (collectionName === VERSIONS && method === "findOne") throw new Error("history unavailable");
      return run();
    });
    expect(await new ModelCatalogStore(unavailable).applyDiscovery(started.attempt, models("two"))).toMatchObject({
      kind: "commit-unknown",
      operationId: started.attempt.attemptId,
    });
    expect(catalog(fake)).toMatchObject({ revision: 3, updatedBy: "later", models: [{ id: "three" }] });
    expect(fake.rows(VERSIONS).size).toBe(3);
    expect(fake.rows(CHANGES).size).toBe(3);
  });

  it("does not reach an engaged guard while reconciling an unresolved operation", async () => {
    const fake = createCatalogFake(() => BASE);
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(174) }).replaceManual({
      provider: "codex",
      updatedBy: "seed",
      models: models("one"),
    });
    let delayedRun: (() => Promise<any>) | undefined;
    const firstDb = faultDb(fake.db, async (collectionName, method, args, run) => {
      if (collectionName === CATALOG && method === "updateOne" && args[1].$set?.pendingExport && !delayedRun) {
        delayedRun = run;
        throw new Error("unknown");
      }
      return run();
    });
    const store = new ModelCatalogStore(firstDb, { now: () => BASE }),
      started = await begin(store, "codex", BASE);
    if (started.kind !== "started") throw new Error("missing start");
    expect(await store.applyDiscovery(started.attempt, models("two"))).toMatchObject({ kind: "commit-unknown" });
    const guard = new WriteGuard({ instanceId: "hive", dbName: "hive_hive" });
    guard.engage("writes blocked");
    expect(
      await new ModelCatalogStore(guardDb(fake.db, guard)).applyDiscovery(started.attempt, models("two")),
    ).toMatchObject({
      kind: "commit-unknown",
      operationId: started.attempt.attemptId,
    });
    expect(guard.refusedWriteCount).toBe(0);
    expect(await delayedRun!()).toMatchObject({ matchedCount: 1 });
    expect(catalog(fake)).toMatchObject({
      revision: 2,
      pendingExport: { version: { _id: started.attempt.attemptId } },
    });
    expect(fake.rows(VERSIONS).size).toBe(1);
    expect(fake.rows(CHANGES).size).toBe(1);
  });

  it("leaves legacy ObjectId history untouched while new versions use UUID strings", async () => {
    const fake = createCatalogFake(() => BASE),
      legacyId = new ObjectId();
    fake.rows(VERSIONS).set(legacyId.toHexString(), {
      _id: legacyId,
      provider: "codex",
      snapshot: [],
      createdAt: new Date(BASE.getTime() - 1000),
    });
    await new ModelCatalogStore(fake.db, { now: () => BASE, uuid: () => id(175) }).replaceManual({
      provider: "codex",
      updatedBy: "a",
      models: models("one"),
    });
    expect(fake.rows(VERSIONS).get(legacyId.toHexString())!._id).toEqual(legacyId);
    expect(typeof fake.rows(VERSIONS).get(id(175))!._id).toBe("string");
    expect(fake.rows(VERSIONS).size).toBe(2);
    expect(fake.rows(CHANGES).size).toBe(1);
  });
});
