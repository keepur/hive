/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { guardDb, WriteGuard } from "../db/write-guard.js";
import type { CatalogProvider, DiscoveryAttempt, DiscoveredModel, SafeCatalogError } from "./model-catalog-types.js";
import { CatalogError, safeError } from "./model-catalog-value.js";
import { ModelCatalogStore } from "./model-catalog-store.js";
import {
  ATTEMPT_LEASE_MS,
  MAINTENANCE_INTERVAL_MS,
  ModelCatalogScanner,
  SHUTDOWN_DRAIN_MS,
} from "./model-catalog-scanner.js";
import { catalogStatus, SCAN_INTERVAL_MS } from "./model-catalog-status.js";
import { cloneBson, createCatalogFake, deferred, faultDb, type Row } from "./testing/catalog-db.test-support.js";

const CATALOG = "agent_model_catalog";
const VERSIONS = "agent_model_catalog_versions";
const CHANGES = "agent_model_catalog_changes";
const BASE = Date.parse("2026-09-07T12:00:00.000Z");
const PROVIDERS: CatalogProvider[] = ["claude", "grok", "codex"];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const models = (...ids: string[]): DiscoveredModel[] =>
  ids.map((modelId) => ({ id: modelId, displayName: modelId.toUpperCase() }));

type Fake = ReturnType<typeof createCatalogFake>;

function catalog(fake: Fake, provider = "codex"): Row | undefined {
  return fake.rows(CATALOG).get(provider);
}

function providerState(fake: Fake, provider = "codex") {
  const select = (name: string) =>
    [...fake.rows(name).values()]
      .filter((row) => row._id === provider || row.provider === provider)
      .map((row) => cloneBson(row));
  return {
    catalog: catalog(fake, provider) ? cloneBson(catalog(fake, provider)!) : undefined,
    versions: select(VERSIONS),
    changes: select(CHANGES),
  };
}

function allState(fake: Fake) {
  const copy = (name: string) => [...fake.rows(name).values()].map((row) => cloneBson(row));
  return { catalogs: copy(CATALOG), versions: copy(VERSIONS), changes: copy(CHANGES) };
}

function testLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function scanner(
  store: ModelCatalogStore | any,
  discover: (provider: CatalogProvider, options: { signal: AbortSignal }) => Promise<DiscoveredModel[]>,
  now: () => number,
  options: Record<string, unknown> = {},
) {
  return new ModelCatalogScanner(store, discover, { now, logger: testLogger(), ...options });
}

async function manual(store: ModelCatalogStore, provider: string, ids: string[] = ["old"], updatedBy = "test") {
  const result = await store.replaceManual({ provider, updatedBy, models: models(...ids) });
  expect(result.kind).toBe("committed");
  return result;
}

async function begin(
  store: ModelCatalogStore,
  provider: CatalogProvider,
  at: number,
  duration = ATTEMPT_LEASE_MS,
  attemptId = randomUUID(),
) {
  const due = await store.readCatalogState(provider);
  const result = await store.beginDiscoveryAttempt(provider, {
    attemptId,
    startedAt: new Date(at),
    leaseExpiresAt: new Date(at + duration),
    observed: due.observed,
  });
  expect(result.kind).toBe("started");
  if (result.kind !== "started") throw new Error(`${provider} did not acquire`);
  return result.attempt;
}

async function seedSuccess(
  fake: Fake,
  clock: { now: number },
  provider: CatalogProvider,
  ids: string[] = ["old"],
  attemptAt = clock.now,
) {
  const original = clock.now;
  clock.now = attemptAt;
  const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
  if (!catalog(fake, provider)?.models) await manual(store, provider, ids);
  const attempt = await begin(store, provider, clock.now);
  const result = await store.applyDiscovery(attempt, models(...ids));
  expect(["committed", "unchanged"]).toContain(result.kind);
  clock.now = original;
  return { store, attempt, result };
}

async function seedFailure(
  fake: Fake,
  clock: { now: number },
  provider: CatalogProvider,
  attemptAt = clock.now,
  code: SafeCatalogError["code"] = "auth",
  seeded = true,
) {
  const original = clock.now;
  clock.now = attemptAt;
  const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
  if (seeded && !catalog(fake, provider)?.models) await manual(store, provider, ["old"]);
  const attempt = await begin(store, provider, clock.now);
  expect((await store.failDiscoveryAttempt(attempt, safeError(provider, code), new Date(clock.now))).kind).toBe(
    "recorded",
  );
  clock.now = original;
  return { store, attempt };
}

async function makeOtherProvidersRecent(fake: Fake, clock: { now: number }, target = "codex") {
  for (const provider of PROVIDERS) {
    if (provider !== target) await seedSuccess(fake, clock, provider, [`${provider}-old`]);
  }
}

type DueFixture = "seeded-overdue" | "missing" | "legacy-scanless" | "expired-running";

async function prepareDueState(fake: Fake, clock: { now: number }, fixture: DueFixture) {
  await makeOtherProvidersRecent(fake, clock);
  if (fixture === "missing") return;
  if (fixture === "legacy-scanless") {
    await manual(new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }), "codex", ["old"]);
    return;
  }
  if (fixture === "seeded-overdue") {
    await seedSuccess(fake, clock, "codex", ["old"], clock.now - SCAN_INTERVAL_MS - 1);
    return;
  }
  const original = clock.now;
  clock.now = original - ATTEMPT_LEASE_MS - 1;
  const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
  await manual(store, "codex", ["old"]);
  await begin(store, "codex", clock.now);
  clock.now = original;
}

function expectNoSavedMutation(before: ReturnType<typeof providerState>, after: ReturnType<typeof providerState>) {
  const withoutScan = (value: Row | undefined) => {
    if (!value) return value;
    const rest = { ...value };
    delete rest.scan;
    return rest;
  };
  expect(withoutScan(after.catalog)).toEqual(withoutScan(before.catalog));
  expect(after.versions).toEqual(before.versions);
  expect(after.changes).toEqual(before.changes);
}

describe("model catalog scanner lifecycle", () => {
  it("commits through the acquiring store, then records unchanged success without rewriting content", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    const discover = vi.fn(async (provider: string) => [{ id: `${provider}-model`, displayName: provider }]);
    const subject = scanner(store, discover, () => clock.now);
    try {
      await subject.tick();
      expect(discover.mock.calls.map(([p]) => p)).toEqual(["claude", "grok", "codex"]);
      const first = (await store.readCatalogState("codex")).snapshot!;
      expect(first.scan?.outcome).toBe("succeeded");
      expect(first.scan?.lastSucceededAt).toEqual(new Date(clock.now));
      expect(fake.rows(VERSIONS).size).toBe(3);
      expect(fake.rows(CHANGES).size).toBe(3);
      clock.now += SCAN_INTERVAL_MS - 1;
      await subject.tick();
      expect(discover).toHaveBeenCalledTimes(3);
      clock.now++;
      await subject.tick();
      expect(discover).toHaveBeenCalledTimes(6);
      const next = (await store.readCatalogState("codex")).snapshot!;
      expect(next.models).toEqual(first.models);
      expect(next.updatedAt).toEqual(first.updatedAt);
      expect(next.revision).toBe(first.revision);
      expect(next.commitId).toBe(first.commitId);
      expect(next.scan?.lastSucceededAt).toEqual(new Date(clock.now));
      expect(fake.rows(VERSIONS).size).toBe(3);
      expect(fake.rows(CHANGES).size).toBe(3);
    } finally {
      await subject.stop();
    }
  });

  it("does not manufacture a catalog when initial apply loses the acquiring store proof", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const acquiringStore = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    const applyingStore = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    const applyDiscovery = vi.fn(applyingStore.applyDiscovery.bind(applyingStore));
    const store = {
      readCatalogState: acquiringStore.readCatalogState.bind(acquiringStore),
      beginDiscoveryAttempt: acquiringStore.beginDiscoveryAttempt.bind(acquiringStore),
      applyDiscovery,
      failDiscoveryAttempt: acquiringStore.failDiscoveryAttempt.bind(acquiringStore),
      recoverPendingExports: acquiringStore.recoverPendingExports.bind(acquiringStore),
    };
    const discover = vi.fn(async (provider: string) => [{ id: `${provider}-model`, displayName: provider }]);
    const subject = scanner(store, discover, () => clock.now);
    try {
      await subject.tick();
      const state = (await acquiringStore.readCatalogState("codex")).snapshot!;
      expect(applyDiscovery).toHaveBeenCalledTimes(3);
      expect(state.scan?.outcome).toBe("running");
      expect(state.models).toBeUndefined();
      expect(fake.rows(VERSIONS).size).toBe(0);
      expect(fake.rows(CHANGES).size).toBe(0);
    } finally {
      await subject.stop();
    }
  });
});

describe("startup and cadence schedules", () => {
  it.each(["missing", "empty", "shell", "legacy"] as const)(
    "discovers every built-in immediately from a %s startup state and never calls plugin or Gemini",
    async (state) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      const seed = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
      for (const provider of PROVIDERS) {
        if (state === "empty") fake.rows(CATALOG).set(provider, { _id: provider, provider, models: [] });
        if (state === "shell") fake.rows(CATALOG).set(provider, { _id: provider, provider });
        if (state === "legacy") await manual(seed, provider, [`${provider}-legacy`]);
      }
      const discover = vi.fn(async (provider: CatalogProvider) => models(`${provider}-fresh`));
      const subject = scanner(seed, discover, () => clock.now);
      try {
        await subject.tick();
        expect(discover.mock.calls.map(([provider]) => provider)).toEqual(PROVIDERS);
        expect(discover.mock.calls.flat().some((value) => value === "gemini" || value === "plugin")).toBe(false);
        for (const provider of PROVIDERS) {
          const stateAfter = providerState(fake, provider);
          expect(stateAfter.catalog).toMatchObject({
            provider,
            models: [{ id: `${provider}-fresh` }],
            scan: { outcome: "succeeded", startedAt: new Date(BASE), lastSucceededAt: new Date(BASE) },
          });
          expect(stateAfter.versions).toHaveLength(state === "legacy" ? 2 : 1);
          expect(stateAfter.changes).toHaveLength(state === "legacy" ? 2 : 1);
          expect(stateAfter.changes.at(-1)?.delivery).toEqual({
            state: "pending",
            attempts: 0,
            nextAttemptAt: new Date(BASE),
          });
        }
      } finally {
        await subject.stop();
      }
    },
  );

  it.each(["success", "failure", "active-lease"] as const)("skips seeded recent %s state on startup", async (state) => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    for (const provider of PROVIDERS) {
      if (state === "success") await seedSuccess(fake, clock, provider);
      if (state === "failure") await seedFailure(fake, clock, provider);
      if (state === "active-lease") {
        const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
        await manual(store, provider);
        await begin(store, provider, clock.now);
      }
    }
    const before = allState(fake);
    const discover = vi.fn(async () => models("new"));
    const subject = scanner(
      new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
      discover,
      () => clock.now,
    );
    try {
      await subject.tick();
      expect(discover).not.toHaveBeenCalled();
      expect(allState(fake)).toEqual(before);
    } finally {
      await subject.stop();
    }
  });

  it("consumes an unseeded recent-failure startup override once", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    for (const provider of PROVIDERS) await seedFailure(fake, clock, provider, clock.now, "auth", false);
    const discover = vi.fn(async (provider: CatalogProvider) => {
      throw new CatalogError(safeError(provider, "timeout"));
    });
    const subject = scanner(
      new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
      discover,
      () => clock.now,
    );
    try {
      await subject.tick();
      expect(discover).toHaveBeenCalledTimes(3);
      const once = allState(fake);
      clock.now += MAINTENANCE_INTERVAL_MS;
      await subject.tick();
      expect(discover).toHaveBeenCalledTimes(3);
      expect(allState(fake)).toEqual(once);
      for (const provider of PROVIDERS) {
        expect(catalog(fake, provider)).toMatchObject({
          scan: { outcome: "failed", error: { code: "timeout" } },
        });
        expect(catalog(fake, provider)).not.toHaveProperty("models");
      }
    } finally {
      await subject.stop();
    }
  });

  it.each(["success", "failure"] as const)(
    "anchors %s cadence to startedAt, retries exactly at eight hours, and does not burst missed intervals",
    async (outcome) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      const discover = vi.fn(async (provider: CatalogProvider) => {
        if (outcome === "failure") throw new CatalogError(safeError(provider, "auth"));
        return models(`${provider}-model`);
      });
      const subject = scanner(
        new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
        discover,
        () => clock.now,
      );
      try {
        await subject.tick();
        const first = allState(fake);
        for (let minute = 1; minute <= 3; minute++) {
          clock.now = BASE + minute * MAINTENANCE_INTERVAL_MS;
          await subject.tick();
        }
        expect(discover).toHaveBeenCalledTimes(3);
        expect(allState(fake)).toEqual(first);
        clock.now = BASE + SCAN_INTERVAL_MS - 1;
        await subject.tick();
        expect(discover).toHaveBeenCalledTimes(3);
        clock.now++;
        await subject.tick();
        expect(discover).toHaveBeenCalledTimes(6);
        clock.now = BASE + 4 * SCAN_INTERVAL_MS + 1;
        await subject.tick();
        expect(discover).toHaveBeenCalledTimes(9);
        await subject.tick();
        expect(discover).toHaveBeenCalledTimes(9);
        for (const provider of PROVIDERS) {
          expect(catalog(fake, provider)?.scan).toMatchObject({
            outcome: outcome === "success" ? "succeeded" : "failed",
            startedAt: new Date(BASE + 4 * SCAN_INTERVAL_MS + 1),
          });
        }
      } finally {
        await subject.stop();
      }
    },
  );

  it("keeps discovery cadence and last success separate from a later manual timestamp and notes edit", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    const discover = vi.fn(async (provider: CatalogProvider) => models(`${provider}-old`));
    const subject = scanner(store, discover, () => clock.now);
    try {
      await subject.tick();
      const success = cloneBson(catalog(fake, "codex")!.scan);
      clock.now = BASE + SCAN_INTERVAL_MS - 1;
      await store.replaceManual({
        provider: "codex",
        updatedBy: "editor",
        models: [{ id: "codex-old", displayName: "Edited", notes: "retained note" }],
      });
      expect(catalog(fake, "codex")!.updatedAt).toEqual(new Date(clock.now));
      expect(catalog(fake, "codex")!.scan).toEqual(success);
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      clock.now++;
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(2);
      expect(catalog(fake, "codex")).toMatchObject({
        models: [{ id: "codex-old", displayName: "CODEX-OLD", notes: "retained note" }],
        updatedBy: "system:model-catalog-scanner",
        updatedAt: new Date(BASE + SCAN_INTERVAL_MS),
        scan: { startedAt: new Date(BASE + SCAN_INTERVAL_MS), lastSucceededAt: new Date(BASE + SCAN_INTERVAL_MS) },
      });
    } finally {
      await subject.stop();
    }
  });

  it.each([
    ["future-start", new Date(BASE + SCAN_INTERVAL_MS), undefined, true],
    ["malformed-start", "not-a-date", undefined, true],
    ["future-lease-fence", "not-a-date", new Date(BASE + ATTEMPT_LEASE_MS), false],
    ["malformed-lease-refusal", "not-a-date", "not-a-date", false],
  ] as const)(
    "handles %s timing without bypassing the store lease predicate",
    async (_name, startedAt, lease, expected) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await makeOtherProvidersRecent(fake, clock);
      fake.rows(CATALOG).set("codex", {
        _id: "codex",
        provider: "codex",
        models: [{ id: "old", displayName: "OLD", addedAt: new Date(BASE - 1) }],
        scan: {
          attemptId: id(1),
          startedAt,
          ...(lease === undefined ? {} : { leaseExpiresAt: lease }),
          outcome: "running",
        },
      });
      const discover = vi.fn(async () => models("new"));
      const subject = scanner(
        new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
        discover,
        () => clock.now,
      );
      try {
        await subject.tick();
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(expected ? 1 : 0);
        if (!expected) expect(catalog(fake, "codex")?.scan).toMatchObject({ startedAt, leaseExpiresAt: lease });
      } finally {
        await subject.stop();
      }
    },
  );
});

describe("same-read acquisition and retained unknown begin identity", () => {
  it("discards a consumed missing-catalog startup decision when another scanner fails", async () => {
    const now = Date.parse("2026-09-07T12:00:00Z"),
      fake = createCatalogFake(() => new Date(now));
    const gate = deferred<void>(),
      entered = deferred<void>(),
      delayedId = randomUUID();
    const delayedDb = faultDb(fake.db, async (name, method, args, run) => {
      if (name === CATALOG && method === "updateOne" && args[1].$set?.["scan.attemptId"] === delayedId) {
        entered.resolve();
        await gate.promise;
      }
      return run();
    });
    const discoverA = vi.fn(async () => {
      throw new CatalogError(safeError("codex", "auth"));
    });
    const discoverB = vi.fn(async (_provider: string) => [{ id: "new", displayName: "New" }]);
    let issued = 0;
    const a = scanner(new ModelCatalogStore(fake.db, { now: () => new Date(now) }), discoverA, () => now);
    const b = scanner(new ModelCatalogStore(delayedDb, { now: () => new Date(now) }), discoverB, () => now, {
      uuid: () => (++issued === 3 ? delayedId : randomUUID()),
    });
    const bTick = b.tick();
    try {
      await entered.promise;
      await a.tick();
      const before = cloneBson(catalog(fake, "codex")!);
      expect(before.scan.outcome).toBe("failed");
      gate.resolve();
      await bTick;
      expect(discoverB.mock.calls.filter((call) => call[0] === "codex")).toHaveLength(0);
      expect(catalog(fake, "codex")).toEqual(before);
      await b.tick();
      expect(discoverB.mock.calls.filter((call) => call[0] === "codex")).toHaveLength(0);
      expect(catalog(fake, "codex")).toEqual(before);
    } finally {
      gate.resolve();
      await bTick;
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it.each(["before-expiry", "after-successor"] as const)(
    "retains an uncertain begin while its predecessor is visible: %s",
    async (releaseAt) => {
      let now = Date.parse("2026-09-07T12:00:00Z") - SCAN_INTERVAL_MS - 1;
      const fake = createCatalogFake(() => new Date(now));
      const seed = new ModelCatalogStore(fake.db, { now: () => new Date(now) });
      await seed.replaceManual({
        provider: "codex",
        updatedBy: "test",
        models: [{ id: "old", displayName: "Old" }],
      });
      const due = await seed.readCatalogState("codex");
      const prior = await seed.beginDiscoveryAttempt("codex", {
        attemptId: randomUUID(),
        startedAt: new Date(now),
        leaseExpiresAt: new Date(now + ATTEMPT_LEASE_MS),
        observed: due.observed,
      });
      expect(prior.kind).toBe("started");
      if (prior.kind !== "started") throw new Error("Seed did not acquire");
      expect((await seed.failDiscoveryAttempt(prior.attempt, safeError("codex", "auth"), new Date(now))).kind).toBe(
        "recorded",
      );
      now += SCAN_INTERVAL_MS + 1;
      const originalStart = now;
      const release = deferred<void>();
      let delegated: Promise<{ matchedCount: number }> | undefined;
      const db = faultDb(fake.db, async (name, method, args, run) => {
        if (
          !delegated &&
          name === CATALOG &&
          method === "updateOne" &&
          args[0]._id === "codex" &&
          args[1].$set?.["scan.outcome"] === "running"
        ) {
          delegated = release.promise.then(run);
          void delegated.catch(() => {});
          throw new Error("test acknowledgment lost before delegation");
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => new Date(now) });
      const beginSpy = vi.spyOn(store, "beginDiscoveryAttempt"),
        apply = vi.spyOn(store, "applyDiscovery"),
        fail = vi.spyOn(store, "failDiscoveryAttempt");
      const allocated: string[] = [];
      const discover = vi.fn(async (provider: string) => [{ id: `${provider}-new`, displayName: provider }]);
      const subject = scanner(store, discover, () => now, {
        uuid: () => {
          const attemptId = randomUUID();
          allocated.push(attemptId);
          return attemptId;
        },
      });
      const persisted = () =>
        [CATALOG, VERSIONS, CHANGES].map((name) =>
          [...fake.rows(name).values()].filter((row) => row.provider === "codex").map((row) => cloneBson(row)),
        );
      const attempts = () => beginSpy.mock.calls.filter(([provider]) => provider === "codex");
      const before = persisted();
      try {
        await subject.tick();
        expect(delegated).toBeDefined();
        expect(attempts()).toHaveLength(1);
        const original = attempts()[0][1],
          allocatedBefore = allocated.length;
        expect(original.attemptId).not.toBe(prior.attempt.attemptId);
        for (const elapsed of [0, ATTEMPT_LEASE_MS - 1]) {
          now = originalStart + elapsed;
          await subject.tick();
          expect(attempts()).toHaveLength(1);
          expect(allocated).toHaveLength(allocatedBefore);
          expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
          expect(apply.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
          expect(fail.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
          expect(persisted()).toEqual(before);
        }
        if (releaseAt === "before-expiry") {
          release.resolve();
          expect((await delegated!).matchedCount).toBe(1);
          const accepted = persisted();
          expect(accepted[0][0].scan.attemptId).toBe(original.attemptId);
          expect(accepted[0][0].scan.outcome).toBe("running");
          expect(accepted[0][0].scan.startedAt).toEqual(original.startedAt);
          expect(accepted[0][0].scan.leaseExpiresAt).toEqual(original.leaseExpiresAt);
          const savedBefore = { ...before[0][0] },
            savedAfter = { ...accepted[0][0] };
          delete savedBefore.scan;
          delete savedAfter.scan;
          expect(savedAfter).toEqual(savedBefore);
          expect(accepted.slice(1)).toEqual(before.slice(1));
          expect(accepted[0][0].scan.lastSucceededAt).toEqual(before[0][0].scan.lastSucceededAt);
          await subject.tick();
          expect(attempts()).toHaveLength(1);
          expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        }
        now = original.leaseExpiresAt.getTime();
        await subject.tick();
        expect(attempts()).toHaveLength(2);
        expect(attempts()[1][1].attemptId).not.toBe(original.attemptId);
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
        const successor = persisted();
        expect(successor[0][0].scan.outcome).toBe("succeeded");
        expect(successor[0][0].scan.attemptId).toBe(attempts()[1][1].attemptId);
        expect(successor[1]).toHaveLength(before[1].length + 1);
        expect(successor[2]).toHaveLength(before[2].length + 1);
        if (releaseAt === "after-successor") {
          release.resolve();
          expect((await delegated!).matchedCount).toBe(0);
        }
        expect(persisted()).toEqual(successor);
      } finally {
        release.resolve();
        await delegated;
        await subject.stop();
      }
    },
  );
});

describe("two due scanner cross product", () => {
  const schedules = (["seeded-overdue", "missing", "legacy-scanless", "expired-running"] as DueFixture[]).flatMap(
    (fixture) => (["changed", "unchanged", "failure"] as const).map((outcome) => ({ fixture, outcome })),
  );

  it.each(schedules)(
    "$fixture predecessor $outcome consumes B's exact observation and leaves complete state unchanged",
    async ({ fixture, outcome }) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await prepareDueState(fake, clock, fixture);
      const delayedId = randomUUID(),
        entered = deferred<void>(),
        release = deferred<void>();
      let matched = -1;
      const delayedDb = faultDb(fake.db, async (name, method, args, run) => {
        if (name === CATALOG && method === "updateOne" && args[1].$set?.["scan.attemptId"] === delayedId) {
          entered.resolve();
          await release.promise;
          const result = await run();
          matched = result.matchedCount;
          return result;
        }
        return run();
      });
      const aDiscover = vi.fn(async (provider: CatalogProvider) => {
        if (provider === "codex" && outcome === "failure") throw new CatalogError(safeError(provider, "auth"));
        if (provider === "codex" && outcome === "unchanged" && fixture !== "missing") return models("old");
        return models(provider === "codex" ? "new" : `${provider}-old`);
      });
      const bDiscover = vi.fn(async (provider: CatalogProvider) => models(`${provider}-b`));
      const a = scanner(new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }), aDiscover, () => clock.now);
      const b = scanner(
        new ModelCatalogStore(delayedDb, { now: () => new Date(clock.now) }),
        bDiscover,
        () => clock.now,
        { uuid: () => delayedId },
      );
      const bTick = b.tick();
      try {
        await entered.promise;
        await a.tick();
        const completed = providerState(fake);
        if (outcome === "failure") {
          expect(completed.catalog?.scan).toMatchObject({ outcome: "failed", error: { code: "auth" } });
        } else {
          expect(completed.catalog?.scan).toMatchObject({ outcome: "succeeded", lastSucceededAt: new Date(clock.now) });
          if (outcome === "unchanged" && fixture !== "missing") {
            expect(completed.catalog?.models.map((row: Row) => row.id)).toEqual(["old"]);
          } else {
            // A genuinely missing catalog cannot have an unchanged bootstrap.
            expect(completed.catalog?.models.map((row: Row) => row.id)).toEqual(["new"]);
            expect(completed.versions.at(-1)?.bootstrap).toBe(fixture === "missing");
          }
        }
        for (const change of completed.changes) {
          expect(change.delivery).toMatchObject({ state: "pending", attempts: 0 });
        }
        release.resolve();
        await bTick;
        expect(matched).toBe(0);
        expect(bDiscover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(providerState(fake)).toEqual(completed);
        await b.tick();
        expect(bDiscover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(providerState(fake)).toEqual(completed);
      } finally {
        release.resolve();
        await bTick;
        await Promise.all([a.stop(), b.stop()]);
      }
    },
  );
});

describe("provider lane isolation and no overlap", () => {
  it.each(["read", "begin", "discovery", "apply", "failure", "recovery"] as const)(
    "isolates a held Claude %s while Grok and Codex finish, and reserves the lane across tick/start",
    async (phase) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      const real = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
      const entered = deferred<void>(),
        release = deferred<void>(),
        othersDone = deferred<void>();
      let heldCalls = 0;
      const hold = async <T>(name: typeof phase, provider: string | undefined, run: () => Promise<T>): Promise<T> => {
        if (phase === name && (name === "recovery" ? provider === undefined : provider === "claude")) {
          heldCalls++;
          entered.resolve();
          await release.promise;
        }
        const result = await run();
        if (name === "apply" && provider === "codex") othersDone.resolve();
        return result;
      };
      const store = {
        readCatalogState: (provider: string) => hold("read", provider, () => real.readCatalogState(provider)),
        beginDiscoveryAttempt: (provider: CatalogProvider, input: any) =>
          hold("begin", provider, () => real.beginDiscoveryAttempt(provider, input)),
        applyDiscovery: (attempt: DiscoveryAttempt, rows: unknown) =>
          hold("apply", attempt.provider, () => real.applyDiscovery(attempt, rows)),
        failDiscoveryAttempt: (attempt: DiscoveryAttempt, error: SafeCatalogError, finishedAt: Date) =>
          hold("failure", attempt.provider, () => real.failDiscoveryAttempt(attempt, error, finishedAt)),
        recoverPendingExports: (provider?: string) =>
          hold("recovery", provider, () => real.recoverPendingExports(provider)),
      };
      const discover = vi.fn(async (provider: CatalogProvider, { signal }: { signal: AbortSignal }) => {
        if (phase === "discovery" && provider === "claude") {
          heldCalls++;
          entered.resolve();
          await release.promise;
          if (signal.aborted) throw new CatalogError(safeError(provider, "canceled"));
        }
        if (phase === "failure" && provider === "claude") throw new CatalogError(safeError(provider, "auth"));
        return models(`${provider}-model`);
      });
      const subject = scanner(store, discover, () => clock.now);
      const first = subject.tick();
      subject.start();
      const overlapping = subject.tick();
      try {
        await entered.promise;
        await othersDone.promise;
        expect(catalog(fake, "grok")?.scan).toMatchObject({ outcome: "succeeded" });
        expect(catalog(fake, "codex")?.scan).toMatchObject({ outcome: "succeeded" });
        expect(heldCalls).toBe(1);
        clock.now += ATTEMPT_LEASE_MS + 1;
        await subject.tick();
        expect(heldCalls).toBe(1);
        release.resolve();
        await Promise.all([first, overlapping]);
        clock.now = BASE + SCAN_INTERVAL_MS;
        await subject.tick();
        expect(discover.mock.calls.filter(([provider]) => provider === "grok")).toHaveLength(2);
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(2);
        expect(providerState(fake, "grok").versions).toHaveLength(1);
        expect(providerState(fake, "codex").versions).toHaveLength(1);
      } finally {
        release.resolve();
        await Promise.allSettled([first, overlapping]);
        await subject.stop();
      }
    },
  );

  it("observes a held store rejection without leaking unhandledRejection", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const real = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    const entered = deferred<void>(),
      release = deferred<void>();
    const leaked: unknown[] = [];
    const listener = (error: unknown) => leaked.push(error);
    process.on("unhandledRejection", listener);
    const store = {
      readCatalogState: async (provider: string) => {
        if (provider === "claude") {
          entered.resolve();
          await release.promise;
          throw new Error("test-secret bearer=https://example.invalid/?token=secret account=private");
        }
        return real.readCatalogState(provider);
      },
      beginDiscoveryAttempt: real.beginDiscoveryAttempt.bind(real),
      applyDiscovery: real.applyDiscovery.bind(real),
      failDiscoveryAttempt: real.failDiscoveryAttempt.bind(real),
      recoverPendingExports: real.recoverPendingExports.bind(real),
    };
    const subject = scanner(
      store,
      async (provider) => models(`${provider}-model`),
      () => clock.now,
    );
    const tick = subject.tick();
    try {
      await entered.promise;
      release.resolve();
      await tick;
      await Promise.resolve();
      expect(leaked).toEqual([]);
      expect(catalog(fake, "grok")?.scan.outcome).toBe("succeeded");
      expect(catalog(fake, "codex")?.scan.outcome).toBe("succeeded");
    } finally {
      release.resolve();
      await tick;
      await subject.stop();
      process.off("unhandledRejection", listener);
    }
  });
});

describe("acquisition observation scope", () => {
  it("rejects a first manual seed between the scanner due read and claim", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await makeOtherProvidersRecent(fake, clock);
    const editor = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now), uuid: () => id(20) });
    let edited = false;
    const db = faultDb(fake.db, async (name, method, args, run) => {
      if (
        !edited &&
        name === CATALOG &&
        method === "updateOne" &&
        args[0]._id === "codex" &&
        args[1].$set?.["scan.outcome"] === "running"
      ) {
        edited = true;
        await manual(editor, "codex", ["manual-first"], "operator");
      }
      return run();
    });
    const discover = vi.fn(async () => models("vendor"));
    const subject = scanner(new ModelCatalogStore(db, { now: () => new Date(clock.now) }), discover, () => clock.now);
    try {
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(providerState(fake)).toEqual({
        catalog: expect.objectContaining({
          models: [expect.objectContaining({ id: "manual-first" })],
          source: "manual",
          updatedBy: "operator",
        }),
        versions: [expect.objectContaining({ _id: id(20), source: "manual" })],
        changes: [expect.objectContaining({ _id: id(20), source: "manual", delivery: expect.any(Object) })],
      });
      expect(catalog(fake)?.scan).toBeUndefined();
    } finally {
      await subject.stop();
    }
  });

  it.each(["seeded-edit", "export-recovery"] as const)(
    "keeps an eligible claim valid across %s because scan and seeded observation remain exact",
    async (action) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await prepareDueState(fake, clock, "seeded-overdue");
      const editor = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now), uuid: () => id(21) });
      let intervened = false;
      const beforeDelivery = cloneBson(providerState(fake).changes[0]?.delivery);
      if (action === "export-recovery") {
        const version = cloneBson(providerState(fake).versions[0]);
        const change = cloneBson(providerState(fake).changes[0]);
        delete change.delivery;
        catalog(fake)!.pendingExport = { version, change };
      }
      const db = faultDb(fake.db, async (name, method, args, run) => {
        if (
          !intervened &&
          name === CATALOG &&
          method === "updateOne" &&
          args[0]._id === "codex" &&
          args[1].$set?.["scan.outcome"] === "running"
        ) {
          intervened = true;
          if (action === "seeded-edit") {
            await editor.replaceManual({
              provider: "codex",
              updatedBy: "operator",
              models: [{ id: "old", displayName: "MANUAL", notes: "keep me" }],
            });
          } else {
            expect((await editor.recoverPendingExports("codex"))[0].kind).toBe("recovered");
          }
        }
        return run();
      });
      const discover = vi.fn(async () => models("old"));
      const subject = scanner(new ModelCatalogStore(db, { now: () => new Date(clock.now) }), discover, () => clock.now);
      try {
        await subject.tick();
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
        expect(catalog(fake)).toMatchObject({
          models: [
            expect.objectContaining({
              id: "old",
              ...(action === "seeded-edit" ? { notes: "keep me" } : {}),
            }),
          ],
          scan: { outcome: "succeeded", startedAt: new Date(BASE), lastSucceededAt: new Date(BASE) },
        });
        if (action === "export-recovery") {
          expect(providerState(fake).changes[0]?.delivery).toEqual(beforeDelivery);
        }
      } finally {
        await subject.stop();
      }
    },
  );

  it("rebases a manual edit during discovery, retains notes, and preserves the original attempt cadence", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await prepareDueState(fake, clock, "seeded-overdue");
    const entered = deferred<void>(),
      release = deferred<void>();
    const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    const discover = vi.fn(async (provider: CatalogProvider) => {
      if (provider === "codex") {
        entered.resolve();
        await release.promise;
      }
      return models(provider === "codex" ? "old" : `${provider}-old`);
    });
    const subject = scanner(store, discover, () => clock.now);
    const tick = subject.tick();
    try {
      await entered.promise;
      clock.now++;
      await store.replaceManual({
        provider: "codex",
        updatedBy: "operator",
        models: [{ id: "old", displayName: "MANUAL", notes: "operator note" }],
      });
      const manualTime = new Date(clock.now);
      release.resolve();
      await tick;
      expect(catalog(fake)).toMatchObject({
        models: [{ id: "old", displayName: "OLD", notes: "operator note" }],
        updatedAt: manualTime,
        updatedBy: "system:model-catalog-scanner",
        source: "discovery",
        scan: {
          outcome: "succeeded",
          startedAt: new Date(BASE),
          finishedAt: manualTime,
          lastSucceededAt: manualTime,
        },
      });
      expect(providerState(fake).versions.at(-1)).toMatchObject({
        source: "discovery",
        updatedBy: "system:model-catalog-scanner",
      });
      expect(providerState(fake).changes).toHaveLength(1);
    } finally {
      release.resolve();
      await tick;
      await subject.stop();
    }
  });
});

describe("typed failures and store outcomes", () => {
  it.each(["auth", "http", "client-version", "empty", "malformed", "too-large", "timeout"] as const)(
    "records sanitized %s failure while preserving saved content, audit delivery, and prior success",
    async (code) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await prepareDueState(fake, clock, "seeded-overdue");
      const before = providerState(fake);
      let fail = true;
      const discover = vi.fn(async (provider: CatalogProvider) => {
        if (provider === "codex" && fail) {
          throw new CatalogError(safeError(provider, code, code === "http" ? 429 : undefined));
        }
        return models(provider === "codex" ? "old" : `${provider}-old`);
      });
      const subject = scanner(
        new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
        discover,
        () => clock.now,
      );
      try {
        await subject.tick();
        const failed = providerState(fake);
        expectNoSavedMutation(before, failed);
        expect(failed.catalog?.scan).toEqual({
          attemptId: expect.any(String),
          startedAt: new Date(BASE),
          finishedAt: new Date(BASE),
          outcome: "failed",
          lastSucceededAt: before.catalog?.scan.lastSucceededAt,
          error: safeError("codex", code, code === "http" ? 429 : undefined),
        });
        expect(failed.changes).toEqual(before.changes);
        fail = false;
        clock.now += SCAN_INTERVAL_MS;
        await subject.tick();
        const recovered = providerState(fake);
        expectNoSavedMutation(before, recovered);
        expect(recovered.catalog?.scan).toMatchObject({
          outcome: "succeeded",
          startedAt: new Date(clock.now),
          finishedAt: new Date(clock.now),
          lastSucceededAt: new Date(clock.now),
        });
        expect(recovered.catalog?.scan).not.toHaveProperty("error");
        expect(recovered.catalog?.scan).not.toHaveProperty("leaseExpiresAt");
      } finally {
        await subject.stop();
      }
    },
  );

  it("keeps an untyped discovery exception unfinished and never logs its raw text", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await prepareDueState(fake, clock, "seeded-overdue");
    const before = providerState(fake);
    const logger = testLogger();
    const discover = vi.fn(async (provider: CatalogProvider) => {
      if (provider === "codex") {
        throw new Error("test-secret Bearer abc https://vendor.invalid/account/private command=whoami");
      }
      return models(`${provider}-old`);
    });
    const subject = new ModelCatalogScanner(
      new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
      discover,
      { now: () => clock.now, logger },
    );
    try {
      await subject.tick();
      const after = providerState(fake);
      expectNoSavedMutation(before, after);
      expect(after.catalog?.scan).toMatchObject({ outcome: "running", startedAt: new Date(BASE) });
      expect(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])).not.toMatch(
        /test-secret|Bearer|vendor\.invalid|private|whoami/,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "Model catalog scanner status",
        expect.objectContaining({ provider: "codex", status: "discovery-unfinished", code: "storage" }),
      );
    } finally {
      await subject.stop();
    }
  });

  it.each([false, true])("accepts a committed changed result with recoveryPending=%s", async (pending) => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await makeOtherProvidersRecent(fake, clock);
    let blockVersion = pending;
    const db = faultDb(fake.db, async (name, method, _args, run) => {
      if (blockVersion && name === VERSIONS && method === "insertOne") {
        blockVersion = false;
        throw new Error("test-secret history unavailable");
      }
      return run();
    });
    const logger = testLogger();
    const subject = new ModelCatalogScanner(
      new ModelCatalogStore(db, { now: () => new Date(clock.now) }),
      async (provider) => models(`${provider}-new`),
      { now: () => clock.now, logger },
    );
    try {
      await subject.tick();
      const after = providerState(fake);
      expect(after.catalog).toMatchObject({
        models: [{ id: "codex-new" }],
        scan: { outcome: "succeeded", lastSucceededAt: new Date(BASE) },
      });
      expect(Boolean(after.catalog?.pendingExport)).toBe(pending);
      expect(after.versions).toHaveLength(pending ? 0 : 1);
      expect(after.changes).toHaveLength(pending ? 0 : 1);
      expect(logger.info).toHaveBeenCalledWith(
        "Model catalog scanner status",
        expect.objectContaining({ provider: "codex", status: "committed", recoveryPending: pending }),
      );
    } finally {
      await subject.stop();
    }
  });

  it("turns a retriable pre-submission refusal into one fenced safe failure without replay", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await prepareDueState(fake, clock, "seeded-overdue");
    const before = providerState(fake);
    const guard = new WriteGuard({ instanceId: "hive", dbName: "hive_hive" });
    let refuse = true;
    const db = faultDb(guardDb(fake.db, guard), async (name, method, args, run) => {
      if (refuse && name === CATALOG && method === "updateOne" && args[1].$set?.pendingExport) {
        refuse = false;
        guard.engage("test mismatch");
        try {
          return await run();
        } finally {
          guard.disengage();
        }
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
    const failure = vi.spyOn(store, "failDiscoveryAttempt");
    const discover = vi.fn(async (provider: CatalogProvider) =>
      models(provider === "codex" ? "new" : `${provider}-old`),
    );
    const subject = scanner(store, discover, () => clock.now);
    try {
      await subject.tick();
      const after = providerState(fake);
      expectNoSavedMutation(before, after);
      expect(after.catalog?.scan).toMatchObject({ outcome: "failed", error: { code: "storage" } });
      expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(1);
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      expect(providerState(fake)).toEqual(after);
    } finally {
      guard.disengage();
      await subject.stop();
    }
  });

  it("does not record another failure when apply reports superseded", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await prepareDueState(fake, clock, "seeded-overdue");
    const real = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    let supersede = true;
    const failure = vi.spyOn(real, "failDiscoveryAttempt");
    const store = {
      readCatalogState: real.readCatalogState.bind(real),
      beginDiscoveryAttempt: real.beginDiscoveryAttempt.bind(real),
      applyDiscovery: async (attempt: DiscoveryAttempt, rows: unknown) => {
        if (attempt.provider === "codex" && supersede) {
          supersede = false;
          expect((await real.failDiscoveryAttempt(attempt, safeError("codex", "auth"), new Date(clock.now))).kind).toBe(
            "recorded",
          );
        }
        return real.applyDiscovery(attempt, rows);
      },
      failDiscoveryAttempt: real.failDiscoveryAttempt.bind(real),
      recoverPendingExports: real.recoverPendingExports.bind(real),
    };
    const subject = scanner(
      store,
      async (provider) => models(provider === "codex" ? "new" : `${provider}-old`),
      () => clock.now,
    );
    try {
      await subject.tick();
      const after = providerState(fake);
      expect(after.catalog?.scan).toMatchObject({ outcome: "failed", error: { code: "auth" } });
      expect(after.catalog?.models.map((row: Row) => row.id)).toEqual(["old"]);
      expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(1);
    } finally {
      await subject.stop();
    }
  });
});

describe("unknown acquisition, application, and failure outcomes", () => {
  it("retains the attempted UUID when index initialization fails before acquisition", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await makeOtherProvidersRecent(fake, clock);
    let indexCalls = 0;
    const db = faultDb(fake.db, async (name, method, _args, run) => {
      if (method === "createIndex") {
        indexCalls++;
        if (name === VERSIONS) throw new Error("test-secret index failure");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
    const beginSpy = vi.spyOn(store, "beginDiscoveryAttempt");
    const allocated: string[] = [];
    const discover = vi.fn(async () => models("new"));
    const logger = testLogger();
    const subject = new ModelCatalogScanner(store, discover, {
      now: () => clock.now,
      uuid: () => {
        const attemptId = randomUUID();
        allocated.push(attemptId);
        return attemptId;
      },
      logger,
    });
    try {
      await subject.tick();
      expect(indexCalls).toBe(2);
      expect(beginSpy.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      expect(allocated).toHaveLength(1);
      expect(discover).not.toHaveBeenCalled();
      expect(catalog(fake)).toBeUndefined();
      await subject.tick();
      expect(beginSpy.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      expect(allocated).toHaveLength(1);
      expect(indexCalls).toBe(2);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("test-secret");
      expect(logger.warn).toHaveBeenCalledWith(
        "Model catalog scanner status",
        expect.objectContaining({ provider: "codex", status: "acquisition-unknown", code: "storage" }),
      );
    } finally {
      await subject.stop();
    }
  });

  it("retains an ambiguously acknowledged begin UUID until expiry when its evidence read is unavailable", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await makeOtherProvidersRecent(fake, clock);
    let throwClaim = true,
      throwEvidence = false;
    const db = faultDb(fake.db, async (name, method, args, run) => {
      const isCodexClaim =
        name === CATALOG &&
        method === "updateOne" &&
        args[0]._id === "codex" &&
        args[1].$set?.["scan.outcome"] === "running";
      if (throwClaim && isCodexClaim) {
        throwClaim = false;
        const result = await run();
        expect(result.matchedCount).toBe(1);
        throwEvidence = true;
        throw new Error("test-secret claim acknowledgment lost");
      }
      if (throwEvidence && name === CATALOG && method === "findOne" && args[0]._id === "codex") {
        throwEvidence = false;
        throw new Error("test-secret evidence unavailable");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
    const beginSpy = vi.spyOn(store, "beginDiscoveryAttempt"),
      apply = vi.spyOn(store, "applyDiscovery"),
      failure = vi.spyOn(store, "failDiscoveryAttempt");
    const allocated: string[] = [];
    const discover = vi.fn(async () => models("new"));
    const subject = scanner(store, discover, () => clock.now, {
      uuid: () => {
        const attemptId = randomUUID();
        allocated.push(attemptId);
        return attemptId;
      },
    });
    try {
      await subject.tick();
      const first = beginSpy.mock.calls.find(([provider]) => provider === "codex")![1];
      const allocatedAfterFirst = allocated.length;
      expect(catalog(fake)?.scan).toEqual({
        attemptId: first.attemptId,
        startedAt: first.startedAt,
        leaseExpiresAt: first.leaseExpiresAt,
        outcome: "running",
      });
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(apply.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
      expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
      for (const at of [BASE, first.leaseExpiresAt.getTime() - 1]) {
        clock.now = at;
        await subject.tick();
        expect(beginSpy.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
        expect(allocated).toHaveLength(allocatedAfterFirst);
      }
      clock.now = first.leaseExpiresAt.getTime();
      await subject.tick();
      expect(beginSpy.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(2);
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      expect(catalog(fake)?.scan).toMatchObject({
        outcome: "succeeded",
        attemptId: beginSpy.mock.calls.filter(([provider]) => provider === "codex")[1][1].attemptId,
      });
      expect(providerState(fake).versions).toHaveLength(1);
      expect(providerState(fake).changes).toHaveLength(1);
    } finally {
      await subject.stop();
    }
  });

  it.each([
    ["changed-envelope", "changed", "envelope"],
    ["changed-history", "changed", "history"],
    ["unchanged-scan", "unchanged", "scan"],
  ] as const)("resolves an ambiguous %s apply only from later positive %s evidence", async (_name, shape, evidence) => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await prepareDueState(fake, clock, "seeded-overdue");
    let delayedRun: (() => Promise<any>) | undefined;
    const db = faultDb(fake.db, async (name, method, args, run) => {
      const changed = shape === "changed" && args[1]?.$set?.pendingExport;
      const unchanged =
        shape === "unchanged" && args[1]?.$set?.["scan.outcome"] === "succeeded" && !args[1]?.$set?.pendingExport;
      if (!delayedRun && name === CATALOG && method === "updateOne" && (changed || unchanged)) {
        delayedRun = run;
        throw new Error("test-secret ambiguous apply");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
    const apply = vi.spyOn(store, "applyDiscovery"),
      failure = vi.spyOn(store, "failDiscoveryAttempt");
    const discover = vi.fn(async (provider: CatalogProvider) =>
      models(provider === "codex" ? (shape === "changed" ? "new" : "old") : `${provider}-old`),
    );
    const subject = scanner(store, discover, () => clock.now);
    try {
      await subject.tick();
      expect(delayedRun).toBeDefined();
      const unknown = providerState(fake);
      expect(unknown.catalog?.scan).toMatchObject({ outcome: "running" });
      expect(unknown.catalog?.models.map((row: Row) => row.id)).toEqual(["old"]);
      const callsAfterSubmission = apply.mock.calls.length;
      await subject.tick();
      expect(apply.mock.calls).toHaveLength(callsAfterSubmission + 1);
      expect(apply.mock.calls.at(-1)?.[1]).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
      expect(providerState(fake)).toEqual(unknown);
      expect((await delayedRun!()).matchedCount).toBe(1);
      if (evidence === "history") {
        expect((await store.recoverPendingExports("codex"))[0].kind).toBe("recovered");
        expect(catalog(fake)).not.toHaveProperty("pendingExport");
        expect(providerState(fake).versions.some((row) => row._id === catalog(fake)?.scan.attemptId)).toBe(true);
      }
      await subject.tick();
      const resolved = providerState(fake);
      expect(resolved.catalog?.scan).toMatchObject({ outcome: "succeeded", lastSucceededAt: new Date(BASE) });
      expect(failure).not.toHaveBeenCalled();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      if (shape === "changed") {
        expect(resolved.catalog?.models.map((row: Row) => row.id)).toEqual(["new"]);
        expect(resolved.versions).toHaveLength(2);
        expect(resolved.changes).toHaveLength(2);
        expect(resolved.changes.at(-1)?.delivery).toMatchObject({ state: "pending", attempts: 0 });
      } else {
        expect(resolved.catalog?.models.map((row: Row) => row.id)).toEqual(["old"]);
        expect(resolved.versions).toHaveLength(1);
        expect(resolved.changes).toHaveLength(1);
      }
    } finally {
      if (delayedRun && catalog(fake)?.scan?.outcome === "running") await delayedRun();
      await subject.stop();
    }
  });

  it.each(["catalog-read", "history-read", "recovery", "guard"] as const)(
    "keeps ambiguous changed apply unknown through a failing %s path without replay or failure",
    async (fault) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await prepareDueState(fake, clock, "seeded-overdue");
      let delayedRun: (() => Promise<any>) | undefined,
        obstruct = false;
      const guard = new WriteGuard({ instanceId: "hive", dbName: "hive_hive" });
      const baseDb = fault === "guard" ? guardDb(fake.db, guard) : fake.db;
      const db = faultDb(baseDb, async (name, method, args, run) => {
        if (!delayedRun && name === CATALOG && method === "updateOne" && args[1]?.$set?.pendingExport) {
          delayedRun = run;
          throw new Error("test-secret delayed apply");
        }
        if (obstruct) {
          if (fault === "catalog-read" && name === CATALOG && method === "findOne")
            throw new Error("catalog unavailable");
          if (fault === "history-read" && name === VERSIONS && method === "findOne")
            throw new Error("history unavailable");
          if (fault === "recovery" && name === CATALOG && method === "findOne") throw new Error("recovery unavailable");
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
      const apply = vi.spyOn(store, "applyDiscovery"),
        failure = vi.spyOn(store, "failDiscoveryAttempt");
      const subject = scanner(
        store,
        async (provider) => models(provider === "codex" ? "new" : `${provider}-old`),
        () => clock.now,
      );
      try {
        await subject.tick();
        const unknown = providerState(fake);
        obstruct = true;
        if (fault === "guard") guard.engage("writes blocked during reconciliation");
        const submitted = apply.mock.calls.length;
        await subject.tick();
        expect(apply.mock.calls).toHaveLength(submitted + 1);
        expect(apply.mock.calls.at(-1)?.[1]).toEqual([]);
        expect(failure).not.toHaveBeenCalled();
        expect(providerState(fake)).toEqual(unknown);
        expect(guard.refusedWriteCount).toBe(0);
      } finally {
        obstruct = false;
        guard.disengage();
        if (delayedRun) await delayedRun().catch(() => {});
        await subject.stop();
      }
    },
  );

  it.each(["applied", "absent-through-expiry"] as const)(
    "reconciles an unknown failure acknowledgment from durable evidence: %s",
    async (mode) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await prepareDueState(fake, clock, "seeded-overdue");
      let delayed: (() => Promise<any>) | undefined,
        throwEvidence = false;
      const db = faultDb(fake.db, async (name, method, args, run) => {
        if (!delayed && name === CATALOG && method === "updateOne" && args[1]?.$set?.["scan.outcome"] === "failed") {
          delayed = run;
          throwEvidence = true;
          throw new Error("test-secret failure acknowledgment lost");
        }
        if (throwEvidence && name === CATALOG && method === "findOne") {
          throwEvidence = false;
          throw new Error("test-secret failure evidence unavailable");
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
      const apply = vi.spyOn(store, "applyDiscovery"),
        failure = vi.spyOn(store, "failDiscoveryAttempt");
      let shouldFail = true;
      const discover = vi.fn(async (provider: CatalogProvider) => {
        if (provider === "codex" && shouldFail) throw new CatalogError(safeError(provider, "auth"));
        return models(provider === "codex" ? "new" : `${provider}-old`);
      });
      const subject = scanner(store, discover, () => clock.now);
      try {
        await subject.tick();
        const running = providerState(fake);
        expect(running.catalog?.scan).toMatchObject({ outcome: "running" });
        expect(apply.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
        expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(1);
        if (mode === "applied") {
          expect((await delayed!()).matchedCount).toBe(1);
          await subject.tick();
          expect(catalog(fake)?.scan).toMatchObject({ outcome: "failed", error: { code: "auth" } });
          await subject.tick();
          expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
        } else {
          const originalAttempt = catalog(fake)?.scan.attemptId;
          const lease = catalog(fake)?.scan.leaseExpiresAt.getTime();
          clock.now = lease - 1;
          await subject.tick();
          expect(catalog(fake)?.scan.attemptId).toBe(originalAttempt);
          expect(catalog(fake)?.scan.outcome).toBe("running");
          shouldFail = false;
          clock.now = lease;
          await subject.tick();
          const successor = providerState(fake);
          expect(successor.catalog?.scan).toMatchObject({ outcome: "succeeded" });
          expect(successor.catalog?.scan.attemptId).not.toBe(originalAttempt);
          expect(successor.catalog?.scan).not.toHaveProperty("error");
          expect((await delayed!()).matchedCount).toBe(0);
          expect(providerState(fake)).toEqual(successor);
        }
      } finally {
        if (delayed) await delayed().catch(() => {});
        await subject.stop();
      }
    },
  );
});

describe("proposal, server timestamp, and acknowledgment clocks", () => {
  it.each(["no-successor", "successor"] as const)(
    "rejects a claim delayed before delegation beyond proposal expiry: %s",
    async (mode) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await makeOtherProvidersRecent(fake, clock);
      const attemptId = randomUUID(),
        entered = deferred<void>(),
        release = deferred<void>();
      let matched = -1;
      const delayedDb = faultDb(fake.db, async (name, method, args, run) => {
        if (name === CATALOG && method === "updateOne" && args[1]?.$set?.["scan.attemptId"] === attemptId) {
          entered.resolve();
          await release.promise;
          const result = await run();
          matched = result.matchedCount;
          return result;
        }
        return run();
      });
      const oldDiscover = vi.fn(async () => models("old-request"));
      const old = scanner(
        new ModelCatalogStore(delayedDb, { now: () => new Date(clock.now) }),
        oldDiscover,
        () => clock.now,
        { uuid: () => attemptId },
      );
      const pending = old.tick();
      let newer: ModelCatalogScanner | undefined;
      try {
        await entered.promise;
        clock.now = BASE + ATTEMPT_LEASE_MS;
        if (mode === "successor") {
          newer = scanner(
            new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
            async (provider) => models(`${provider}-successor`),
            () => clock.now,
          );
          await newer.tick();
          expect(catalog(fake)?.scan).toMatchObject({ outcome: "succeeded" });
        }
        const beforeRelease = providerState(fake);
        release.resolve();
        await pending;
        expect(matched).toBe(0);
        expect(oldDiscover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(providerState(fake)).toEqual(beforeRelease);
        if (mode === "no-successor") {
          expect(catalog(fake)).toEqual({ _id: "codex", provider: "codex" });
          expect(providerState(fake).versions).toEqual([]);
          expect(providerState(fake).changes).toEqual([]);
        }
      } finally {
        release.resolve();
        await pending;
        await Promise.all([old.stop(), newer?.stop()]);
      }
    },
  );

  it.each(["unchanged-observation", "changed-observation"] as const)(
    "uses one frozen $$NOW claim timestamp but still checks the exact observation: %s",
    async (mode) => {
      const clock = { now: BASE };
      let heldId = "";
      const entered = deferred<void>(),
        release = deferred<void>();
      const fake = createCatalogFake(() => new Date(clock.now), {
        afterTimestamp: async ({ collection, update, serverNow }) => {
          if (collection === CATALOG && update.$set?.["scan.attemptId"] === heldId) {
            expect(serverNow).toEqual(new Date(BASE));
            entered.resolve();
            await release.promise;
          }
        },
      });
      await makeOtherProvidersRecent(fake, clock);
      heldId = randomUUID();
      const discover = vi.fn(async () => models("new"));
      const subject = scanner(
        new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
        discover,
        () => clock.now,
        { uuid: () => heldId },
      );
      const tick = subject.tick();
      try {
        await entered.promise;
        if (mode === "changed-observation") {
          await manual(
            new ModelCatalogStore(fake.db, { now: () => new Date(clock.now), uuid: () => id(30) }),
            "codex",
            ["manual"],
          );
        }
        const before = providerState(fake);
        clock.now = BASE + ATTEMPT_LEASE_MS + 1;
        release.resolve();
        await tick;
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        if (mode === "unchanged-observation") {
          expect(catalog(fake)?.scan).toEqual({
            attemptId: heldId,
            startedAt: new Date(BASE),
            leaseExpiresAt: new Date(BASE + ATTEMPT_LEASE_MS),
            outcome: "running",
          });
          expect(catalog(fake)).not.toHaveProperty("models");
          expect(providerState(fake).versions).toEqual([]);
          expect(providerState(fake).changes).toEqual([]);
        } else {
          expect(providerState(fake)).toEqual(before);
          expect(catalog(fake)?.scan).toBeUndefined();
        }
      } finally {
        release.resolve();
        await tick;
        await subject.stop();
      }
    },
  );

  it("accepts a matched claim acknowledgment held past expiry without starting provider work", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await makeOtherProvidersRecent(fake, clock);
    const heldId = randomUUID(),
      entered = deferred<void>(),
      release = deferred<void>();
    let matched = -1;
    const db = faultDb(fake.db, async (name, method, args, run) => {
      if (name === CATALOG && method === "updateOne" && args[1]?.$set?.["scan.attemptId"] === heldId) {
        const result = await run();
        matched = result.matchedCount;
        entered.resolve();
        await release.promise;
        return result;
      }
      return run();
    });
    const discover = vi.fn(async () => models("new"));
    const store = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
    const apply = vi.spyOn(store, "applyDiscovery"),
      failure = vi.spyOn(store, "failDiscoveryAttempt");
    const subject = scanner(store, discover, () => clock.now, { uuid: () => heldId });
    const tick = subject.tick();
    try {
      await entered.promise;
      expect(matched).toBe(1);
      const accepted = providerState(fake);
      clock.now = BASE + ATTEMPT_LEASE_MS + 1;
      release.resolve();
      await tick;
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(apply.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
      expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
      expect(providerState(fake)).toEqual(accepted);
      expect(catalog(fake)?.scan).toEqual({
        attemptId: heldId,
        startedAt: new Date(BASE),
        leaseExpiresAt: new Date(BASE + ATTEMPT_LEASE_MS),
        outcome: "running",
      });
    } finally {
      release.resolve();
      await tick;
      await subject.stop();
    }
  });
});

describe("cancellation and lease rechecks between scanner phases", () => {
  it.each(["stop", "expire"] as const)("rechecks %s after begin resolves before discovery starts", async (mode) => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await makeOtherProvidersRecent(fake, clock);
    const real = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    let stopAfterBegin = () => {};
    const beginSpy = vi.fn(async (provider: CatalogProvider, input: any) => {
      const result = await real.beginDiscoveryAttempt(provider, input);
      if (provider === "codex" && result.kind === "started") {
        if (mode === "stop") stopAfterBegin();
        else clock.now = result.attempt.leaseExpiresAt.getTime();
      }
      return result;
    });
    const store = {
      readCatalogState: real.readCatalogState.bind(real),
      beginDiscoveryAttempt: beginSpy,
      applyDiscovery: vi.fn(real.applyDiscovery.bind(real)),
      failDiscoveryAttempt: vi.fn(real.failDiscoveryAttempt.bind(real)),
      recoverPendingExports: real.recoverPendingExports.bind(real),
    };
    const discover = vi.fn(async () => models("new"));
    const subject = scanner(store, discover, () => clock.now, { drainMs: 0 });
    stopAfterBegin = () => {
      void subject.stop();
    };
    try {
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(store.applyDiscovery).not.toHaveBeenCalled();
      expect(store.failDiscoveryAttempt).not.toHaveBeenCalled();
      expect(catalog(fake)?.scan).toMatchObject({ outcome: "running", startedAt: new Date(BASE) });
      expect(providerState(fake).versions).toEqual([]);
      expect(providerState(fake).changes).toEqual([]);
    } finally {
      await subject.stop();
    }
  });

  it.each(["stop", "expire"] as const)("rechecks %s after discovery resolves before apply starts", async (mode) => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await makeOtherProvidersRecent(fake, clock);
    const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    const apply = vi.spyOn(store, "applyDiscovery"),
      failure = vi.spyOn(store, "failDiscoveryAttempt");
    let stopAfterDiscovery = () => {};
    const discover = vi.fn((provider: CatalogProvider) => {
      if (provider !== "codex") return Promise.resolve(models(`${provider}-old`));
      return {
        then(resolve: (rows: DiscoveredModel[]) => void) {
          resolve(models("new"));
          if (mode === "stop") stopAfterDiscovery();
          else clock.now = catalog(fake)!.scan.leaseExpiresAt.getTime();
        },
      } as Promise<DiscoveredModel[]>;
    });
    const subject = scanner(store, discover, () => clock.now, { drainMs: 0 });
    stopAfterDiscovery = () => {
      void subject.stop();
    };
    try {
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      expect(apply.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
      expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
      expect(catalog(fake)?.scan).toMatchObject({ outcome: "running" });
      expect(catalog(fake)).not.toHaveProperty("models");
    } finally {
      await subject.stop();
    }
  });

  it("allows a proof-free ambiguous started response to fetch but only performs reconciliation-only apply", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await makeOtherProvidersRecent(fake, clock);
    let ambiguous = true;
    const db = faultDb(fake.db, async (name, method, args, run) => {
      if (
        ambiguous &&
        name === CATALOG &&
        method === "updateOne" &&
        args[0]._id === "codex" &&
        args[1]?.$set?.["scan.outcome"] === "running"
      ) {
        ambiguous = false;
        const result = await run();
        expect(result.matchedCount).toBe(1);
        throw new Error("test-secret ambiguous claim acknowledgment");
      }
      return run();
    });
    const store = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
    const apply = vi.spyOn(store, "applyDiscovery"),
      failure = vi.spyOn(store, "failDiscoveryAttempt");
    const discover = vi.fn(async () => models("new"));
    const subject = scanner(store, discover, () => clock.now);
    try {
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      const codexApply = apply.mock.calls.filter(([attempt]) => attempt.provider === "codex");
      expect(codexApply).toHaveLength(1);
      expect(codexApply[0][1]).toEqual(models("new"));
      expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
      expect(catalog(fake)?.scan).toMatchObject({ outcome: "running" });
      expect(catalog(fake)).not.toHaveProperty("models");
      expect(providerState(fake).versions).toEqual([]);
      expect(providerState(fake).changes).toEqual([]);
      await subject.tick();
      expect(apply.mock.calls.filter(([attempt]) => attempt.provider === "codex").at(-1)?.[1]).toEqual([]);
      expect(catalog(fake)?.scan.outcome).toBe("running");
    } finally {
      await subject.stop();
    }
  });
});

describe("restart, takeover, and late obsolete store operations", () => {
  it("waits on an active old token, then takes over its expired same-read state with a fresh UUID", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await makeOtherProvidersRecent(fake, clock);
    const oldStore = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    await manual(oldStore, "codex", ["old"]);
    const oldAttempt = await begin(oldStore, "codex", clock.now);
    const before = providerState(fake);
    const allocated: string[] = [];
    const discover = vi.fn(async () => models("successor"));
    const subject = scanner(
      new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
      discover,
      () => clock.now,
      {
        uuid: () => {
          const attemptId = randomUUID();
          allocated.push(attemptId);
          return attemptId;
        },
      },
    );
    try {
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
      expect(allocated).toEqual([]);
      expect(providerState(fake)).toEqual(before);
      clock.now = oldAttempt.leaseExpiresAt.getTime();
      await subject.tick();
      expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
      expect(allocated).toHaveLength(1);
      expect(allocated[0]).not.toBe(oldAttempt.attemptId);
      expect(catalog(fake)?.scan).toMatchObject({ outcome: "succeeded", attemptId: allocated[0] });
      expect(catalog(fake)?.models.map((row: Row) => row.id)).toEqual(["successor"]);
      expect(providerState(fake).versions).toHaveLength(2);
      expect(providerState(fake).changes).toHaveLength(2);
    } finally {
      await subject.stop();
    }
  });

  it.each(["before-recovery-reread", "after-recovery-reread"] as const)(
    "observes a late positive predecessor success %s and avoids a fresh request",
    async (timing) => {
      const clock = { now: BASE };
      const oldId = randomUUID(),
        oldEntered = deferred<void>(),
        releaseOld = deferred<void>();
      const fake = createCatalogFake(() => new Date(clock.now), {
        afterTimestamp: async ({ collection, update }) => {
          if (collection === CATALOG && update.$set?.pendingExport?.version?._id === oldId) {
            oldEntered.resolve();
            await releaseOld.promise;
          }
        },
      });
      await makeOtherProvidersRecent(fake, clock);
      const oldStore = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
      await manual(oldStore, "codex", ["old"]);
      const oldAttempt = await begin(oldStore, "codex", clock.now, ATTEMPT_LEASE_MS, oldId);
      const oldApply = oldStore.applyDiscovery(oldAttempt, models("late-success"));
      await oldEntered.promise;
      clock.now = oldAttempt.leaseExpiresAt.getTime();
      const rawFreshStore = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
      const releaseOnClaim = randomUUID();
      let claimMatched = -1,
        recovered = false;
      const delayedDb = faultDb(fake.db, async (name, method, args, run) => {
        if (
          timing === "after-recovery-reread" &&
          name === CATALOG &&
          method === "updateOne" &&
          args[1]?.$set?.["scan.attemptId"] === releaseOnClaim
        ) {
          releaseOld.resolve();
          await oldApply;
          const result = await run();
          claimMatched = result.matchedCount;
          return result;
        }
        return run();
      });
      const freshStore =
        timing === "before-recovery-reread"
          ? {
              readCatalogState: rawFreshStore.readCatalogState.bind(rawFreshStore),
              beginDiscoveryAttempt: rawFreshStore.beginDiscoveryAttempt.bind(rawFreshStore),
              applyDiscovery: rawFreshStore.applyDiscovery.bind(rawFreshStore),
              failDiscoveryAttempt: rawFreshStore.failDiscoveryAttempt.bind(rawFreshStore),
              recoverPendingExports: async (provider?: string) => {
                if (provider === "codex" && !recovered) {
                  recovered = true;
                  releaseOld.resolve();
                  await oldApply;
                }
                return rawFreshStore.recoverPendingExports(provider);
              },
            }
          : new ModelCatalogStore(delayedDb, { now: () => new Date(clock.now) });
      const discover = vi.fn(async () => models("fresh-request"));
      const subject = scanner(freshStore, discover, () => clock.now, { uuid: () => releaseOnClaim });
      try {
        await subject.tick();
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(catalog(fake)?.scan).toMatchObject({
          attemptId: oldId,
          outcome: "succeeded",
          lastSucceededAt: new Date(BASE),
        });
        expect(catalog(fake)?.models.map((row: Row) => row.id)).toEqual(["late-success"]);
        expect(providerState(fake).versions).toHaveLength(2);
        expect(providerState(fake).changes).toHaveLength(2);
        if (timing === "after-recovery-reread") expect(claimMatched).toBe(0);
        const saved = providerState(fake);
        await subject.tick();
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(providerState(fake)).toEqual(saved);
      } finally {
        releaseOld.resolve();
        await oldApply;
        await subject.stop();
      }
    },
  );

  it.each(["shell", "apply", "failure"] as const)(
    "fences a late old %s operation released after a successor completes",
    async (operation) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await makeOtherProvidersRecent(fake, clock);
      const release = deferred<void>();
      let delegated: Promise<any> | undefined, oldAttempt: DiscoveryAttempt | undefined;
      const db = faultDb(fake.db, async (name, method, args, run) => {
        const target =
          (operation === "shell" && name === CATALOG && method === "insertOne" && args[0]._id === "codex") ||
          (operation === "apply" && name === CATALOG && method === "updateOne" && args[1]?.$set?.pendingExport) ||
          (operation === "failure" &&
            name === CATALOG &&
            method === "updateOne" &&
            args[1]?.$set?.["scan.outcome"] === "failed");
        if (target && !delegated) {
          delegated = release.promise.then(run);
          void delegated.catch(() => {});
          throw new Error(`test-secret delayed ${operation}`);
        }
        return run();
      });
      const oldStore = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
      let oldCall: Promise<unknown>;
      if (operation === "shell") {
        const due = await oldStore.readCatalogState("codex");
        oldCall = oldStore
          .beginDiscoveryAttempt("codex", {
            attemptId: randomUUID(),
            startedAt: new Date(clock.now),
            leaseExpiresAt: new Date(clock.now + ATTEMPT_LEASE_MS),
            observed: due.observed,
          })
          .catch(() => undefined);
      } else {
        await manual(oldStore, "codex", ["old"]);
        oldAttempt = await begin(oldStore, "codex", clock.now);
        oldCall =
          operation === "apply"
            ? oldStore.applyDiscovery(oldAttempt, models("obsolete"))
            : oldStore
                .failDiscoveryAttempt(oldAttempt, safeError("codex", "auth"), new Date(clock.now))
                .catch(() => undefined);
      }
      await oldCall;
      expect(delegated).toBeDefined();
      const expiry = oldAttempt?.leaseExpiresAt.getTime() ?? BASE + ATTEMPT_LEASE_MS;
      clock.now = expiry;
      const successor = scanner(
        new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
        async (provider) => models(`${provider}-successor`),
        () => clock.now,
      );
      try {
        await successor.tick();
        const completed = providerState(fake);
        expect(completed.catalog?.scan).toMatchObject({ outcome: "succeeded" });
        expect(completed.catalog?.models.map((row: Row) => row.id)).toEqual(["codex-successor"]);
        release.resolve();
        if (operation === "shell") await expect(delegated).rejects.toMatchObject({ code: 11000 });
        else expect((await delegated!).matchedCount).toBe(0);
        expect(providerState(fake)).toEqual(completed);
      } finally {
        release.resolve();
        await delegated?.catch(() => {});
        await successor.stop();
      }
    },
  );
});

describe("independent export maintenance", () => {
  it("recovers built-in and plugin envelopes on startup while no provider is due", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    for (const provider of PROVIDERS) await seedSuccess(fake, clock, provider, [`${provider}-old`]);
    const pendingIds = new Set([id(40), id(41)]);
    const db = faultDb(fake.db, async (name, method, args, run) => {
      if (name === VERSIONS && method === "insertOne" && pendingIds.has(args[0]._id)) {
        throw new Error("test-secret export unavailable");
      }
      return run();
    });
    const writer = new ModelCatalogStore(db, {
      now: () => new Date(clock.now),
      uuid: () => id(40),
      listPluginProviderIds: () => ["sol"],
    });
    expect(
      await writer.replaceManual({ provider: "codex", updatedBy: "operator", models: models("codex-manual") }),
    ).toMatchObject({ kind: "committed", recoveryPending: true });
    const pluginWriter = new ModelCatalogStore(db, {
      now: () => new Date(clock.now),
      uuid: () => id(41),
      listPluginProviderIds: () => ["sol"],
    });
    expect(
      await pluginWriter.replaceManual({ provider: "sol", updatedBy: "plugin", models: models("sol-model") }),
    ).toMatchObject({ kind: "committed", recoveryPending: true });
    expect(catalog(fake, "codex")).toHaveProperty("pendingExport");
    expect(catalog(fake, "sol")).toHaveProperty("pendingExport");
    pendingIds.clear();
    const discover = vi.fn(async () => models("unexpected"));
    const subject = scanner(
      new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
      discover,
      () => clock.now,
    );
    try {
      await subject.tick();
      expect(discover).not.toHaveBeenCalled();
      expect(catalog(fake, "codex")).not.toHaveProperty("pendingExport");
      expect(catalog(fake, "sol")).not.toHaveProperty("pendingExport");
      expect(fake.rows(VERSIONS).get(id(40))).toMatchObject({ source: "manual", snapshot: [{ id: "codex-manual" }] });
      expect(fake.rows(CHANGES).get(id(40))).toMatchObject({ delivery: { state: "pending", attempts: 0 } });
      expect(fake.rows(VERSIONS).get(id(41))).toMatchObject({ source: "manual", snapshot: [{ id: "sol-model" }] });
      expect(fake.rows(CHANGES).get(id(41))).toMatchObject({ delivery: { state: "pending", attempts: 0 } });
    } finally {
      await subject.stop();
    }
  });

  it("preserves an existing delivery subdocument byte-for-byte during duplicate recovery", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now), uuid: () => id(42) });
    await manual(store, "codex", ["old"]);
    const discovery = await begin(store, "codex", clock.now);
    expect((await store.applyDiscovery(discovery, models("old"))).kind).toBe("unchanged");
    await makeOtherProvidersRecent(fake, clock);
    const version = cloneBson(fake.rows(VERSIONS).get(id(42))!);
    const original = cloneBson(fake.rows(CHANGES).get(id(42))!);
    const delivery = {
      state: "pending",
      attempts: 7,
      nextAttemptAt: new Date(BASE + 9000),
      claimToken: "keep-sibling-delivery-fields",
    };
    fake.rows(CHANGES).get(id(42))!.delivery = cloneBson(delivery);
    const immutable = { ...original };
    delete immutable.delivery;
    catalog(fake)!.pendingExport = { version, change: immutable };
    const beforeRead = providerState(fake);
    const { snapshot } = await store.readCatalogState("codex");
    expect(catalogStatus("codex", snapshot, clock.now).recoveryPending).toBe(true);
    expect(providerState(fake)).toEqual(beforeRead);
    const subject = scanner(
      store,
      async () => models("unused"),
      () => clock.now,
    );
    try {
      await subject.tick();
      expect(catalog(fake)).not.toHaveProperty("pendingExport");
      expect(fake.rows(CHANGES).get(id(42))!.delivery).toEqual(delivery);
      expect(providerState(fake).versions).toHaveLength(1);
      expect(providerState(fake).changes).toHaveLength(1);
    } finally {
      await subject.stop();
    }
  });

  it.each(["pending-result", "sweep-throw"] as const)(
    "contains a %s export failure while every provider lane completes",
    async (mode) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      const real = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
      const recover = vi.fn(async (provider?: string) => {
        if (provider === undefined) {
          if (mode === "sweep-throw") throw new Error("test-secret sweep failed");
          return [{ provider: "sol", kind: "pending", error: safeError("sol", "storage") }] as const;
        }
        return real.recoverPendingExports(provider);
      });
      const store = {
        readCatalogState: real.readCatalogState.bind(real),
        beginDiscoveryAttempt: real.beginDiscoveryAttempt.bind(real),
        applyDiscovery: real.applyDiscovery.bind(real),
        failDiscoveryAttempt: real.failDiscoveryAttempt.bind(real),
        recoverPendingExports: recover,
      };
      const discover = vi.fn(async (provider: CatalogProvider) => models(`${provider}-model`));
      const subject = scanner(store, discover, () => clock.now);
      try {
        await subject.tick();
        expect(discover.mock.calls.map(([provider]) => provider)).toEqual(PROVIDERS);
        for (const provider of PROVIDERS) {
          expect(catalog(fake, provider)?.scan).toMatchObject({ outcome: "succeeded" });
          expect(providerState(fake, provider).versions).toHaveLength(1);
          expect(providerState(fake, provider).changes).toHaveLength(1);
        }
        expect(recover.mock.calls.filter(([provider]) => provider === undefined)).toHaveLength(1);
      } finally {
        await subject.stop();
      }
    },
  );
});

describe("bounded scanner stop matrix", () => {
  it.each(["read", "begin", "discovery", "apply", "failure", "recovery"] as const)(
    "latches and aborts synchronously during a held %s acknowledgment without starting a later scanner step",
    async (phase) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await makeOtherProvidersRecent(fake, clock);
      const real = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
      const entered = deferred<void>(),
        release = deferred<void>();
      const holdAfter = async <T>(name: typeof phase, provider: string | undefined, run: () => Promise<T>) => {
        const result = await run();
        if (phase === name && (name === "recovery" ? provider === undefined : provider === "codex")) {
          entered.resolve();
          await release.promise;
        }
        return result;
      };
      const readCatalogState = vi.fn((provider: string) =>
          holdAfter("read", provider, () => real.readCatalogState(provider)),
        ),
        beginDiscoveryAttempt = vi.fn((provider: CatalogProvider, input: any) =>
          holdAfter("begin", provider, () => real.beginDiscoveryAttempt(provider, input)),
        ),
        applyDiscovery = vi.fn((attempt: DiscoveryAttempt, rows: unknown) =>
          holdAfter("apply", attempt.provider, () => real.applyDiscovery(attempt, rows)),
        ),
        failDiscoveryAttempt = vi.fn((attempt: DiscoveryAttempt, error: SafeCatalogError, finishedAt: Date) =>
          holdAfter("failure", attempt.provider, () => real.failDiscoveryAttempt(attempt, error, finishedAt)),
        ),
        recoverPendingExports = vi.fn((provider?: string) =>
          holdAfter("recovery", provider, () => real.recoverPendingExports(provider)),
        );
      let activeSignal: AbortSignal | undefined;
      const discover = vi.fn(async (provider: CatalogProvider, { signal }: { signal: AbortSignal }) => {
        if (provider === "codex") activeSignal = signal;
        if (phase === "discovery" && provider === "codex") {
          entered.resolve();
          await release.promise;
        }
        if (phase === "failure" && provider === "codex") throw new CatalogError(safeError(provider, "auth"));
        return models(`${provider}-new`);
      });
      const intervalIds = new Set<ReturnType<typeof setInterval>>();
      const timers = {
        setInterval: vi.fn((fn: () => void, ms: number) => {
          const value = setInterval(fn, ms);
          intervalIds.add(value);
          return value;
        }),
        clearInterval: vi.fn((value: ReturnType<typeof setInterval>) => {
          intervalIds.delete(value);
          clearInterval(value);
        }),
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (value: ReturnType<typeof setTimeout>) => clearTimeout(value),
      };
      const store = {
        readCatalogState,
        beginDiscoveryAttempt,
        applyDiscovery,
        failDiscoveryAttempt,
        recoverPendingExports,
      };
      const subject = scanner(store, discover, () => clock.now, { timers, drainMs: 0 });
      const tick = subject.tick();
      subject.start();
      try {
        await entered.promise;
        const counts = {
          read: readCatalogState.mock.calls.length,
          begin: beginDiscoveryAttempt.mock.calls.length,
          discover: discover.mock.calls.length,
          apply: applyDiscovery.mock.calls.length,
          failure: failDiscoveryAttempt.mock.calls.length,
          recovery: recoverPendingExports.mock.calls.length,
        };
        const lane = (subject as any).lanes.get("codex");
        expect(lane.controller.signal.aborted).toBe(false);
        const stopped = subject.stop();
        expect(lane.controller.signal.aborted).toBe(true);
        expect(intervalIds.size).toBe(0);
        expect(timers.clearInterval).toHaveBeenCalledTimes(1);
        await stopped;
        subject.start();
        await subject.tick();
        expect(readCatalogState).toHaveBeenCalledTimes(counts.read);
        expect(beginDiscoveryAttempt).toHaveBeenCalledTimes(counts.begin);
        expect(discover).toHaveBeenCalledTimes(counts.discover);
        expect(applyDiscovery).toHaveBeenCalledTimes(counts.apply);
        expect(failDiscoveryAttempt).toHaveBeenCalledTimes(counts.failure);
        expect(recoverPendingExports).toHaveBeenCalledTimes(counts.recovery);
        release.resolve();
        await tick;
        if (phase === "read") expect(beginDiscoveryAttempt).toHaveBeenCalledTimes(counts.begin);
        if (phase === "begin") expect(discover).toHaveBeenCalledTimes(counts.discover);
        if (phase === "discovery") {
          expect(applyDiscovery).toHaveBeenCalledTimes(counts.apply);
          expect(failDiscoveryAttempt).toHaveBeenCalledTimes(counts.failure);
        }
        if (phase === "apply" || phase === "failure") {
          expect(recoverPendingExports).toHaveBeenCalledTimes(counts.recovery);
        }
        expect(activeSignal?.aborted ?? true).toBe(true);
      } finally {
        release.resolve();
        await tick;
        await subject.stop();
        for (const value of intervalIds) clearInterval(value);
      }
    },
  );

  it("returns one stop promise and makes later direct start/tick calls inert", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    for (const provider of PROVIDERS) await seedSuccess(fake, clock, provider);
    const store = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    const read = vi.spyOn(store, "readCatalogState");
    const recover = vi.spyOn(store, "recoverPendingExports");
    const subject = scanner(
      store,
      async () => models("unused"),
      () => clock.now,
    );
    subject.start();
    await subject.tick();
    const first = subject.stop(),
      second = subject.stop();
    expect(second).toBe(first);
    await first;
    const counts = [read.mock.calls.length, recover.mock.calls.length];
    subject.start();
    await subject.tick();
    expect([read.mock.calls.length, recover.mock.calls.length]).toEqual(counts);
    expect(subject.stop()).toBe(first);
  });

  it("keeps drain pending at 4999ms, resolves once at 5000ms, and observes a later rejection", async () => {
    vi.useFakeTimers();
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    const real = new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) });
    const entered = deferred<void>(),
      release = deferred<void>();
    const leaked: unknown[] = [];
    const listener = (error: unknown) => leaked.push(error);
    process.on("unhandledRejection", listener);
    const logger = testLogger();
    const store = {
      readCatalogState: async (provider: string) => {
        if (provider === "codex") {
          entered.resolve();
          await release.promise;
          throw new Error("test-secret late read rejection");
        }
        return real.readCatalogState(provider);
      },
      beginDiscoveryAttempt: real.beginDiscoveryAttempt.bind(real),
      applyDiscovery: real.applyDiscovery.bind(real),
      failDiscoveryAttempt: real.failDiscoveryAttempt.bind(real),
      recoverPendingExports: real.recoverPendingExports.bind(real),
    };
    const subject = new ModelCatalogScanner(store, async (provider) => models(`${provider}-model`), {
      now: () => clock.now,
      logger,
      drainMs: SHUTDOWN_DRAIN_MS,
    });
    const tick = subject.tick();
    try {
      await entered.promise;
      let settled = false;
      const stopped = subject.stop().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopped;
      expect(settled).toBe(true);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith("Model catalog scanner shutdown drain incomplete", { code: "storage" });
      release.resolve();
      await tick;
      await Promise.resolve();
      expect(leaked).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await tick;
      await subject.stop();
      process.off("unhandledRejection", listener);
      vi.useRealTimers();
    }
  });

  it.each(["before-expiry", "after-expiry"] as const)(
    "does not continue from a matched begin acknowledgment released after stop/drain: %s",
    async (releaseAt) => {
      const clock = { now: BASE };
      const fake = createCatalogFake(() => new Date(clock.now));
      await makeOtherProvidersRecent(fake, clock);
      const heldId = randomUUID(),
        entered = deferred<void>(),
        release = deferred<void>();
      let matched = -1;
      const db = faultDb(fake.db, async (name, method, args, run) => {
        if (name === CATALOG && method === "updateOne" && args[1]?.$set?.["scan.attemptId"] === heldId) {
          const result = await run();
          matched = result.matchedCount;
          entered.resolve();
          await release.promise;
          return result;
        }
        return run();
      });
      const store = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
      const apply = vi.spyOn(store, "applyDiscovery"),
        failure = vi.spyOn(store, "failDiscoveryAttempt");
      const discover = vi.fn(async () => models("old-request"));
      const subject = scanner(store, discover, () => clock.now, { uuid: () => heldId, drainMs: 0 });
      const tick = subject.tick();
      try {
        await entered.promise;
        expect(matched).toBe(1);
        const stopA = subject.stop();
        expect(subject.stop()).toBe(stopA);
        await stopA;
        if (releaseAt === "after-expiry") clock.now = BASE + ATTEMPT_LEASE_MS;
        release.resolve();
        await tick;
        expect(discover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(0);
        expect(apply.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
        expect(failure.mock.calls.filter(([attempt]) => attempt.provider === "codex")).toHaveLength(0);
        expect(catalog(fake)?.scan).toEqual({
          attemptId: heldId,
          startedAt: new Date(BASE),
          leaseExpiresAt: new Date(BASE + ATTEMPT_LEASE_MS),
          outcome: "running",
        });
        clock.now = BASE + ATTEMPT_LEASE_MS;
        const restartedDiscover = vi.fn(async () => models("recovered"));
        const restarted = scanner(
          new ModelCatalogStore(fake.db, { now: () => new Date(clock.now) }),
          restartedDiscover,
          () => clock.now,
        );
        try {
          await restarted.tick();
          expect(restartedDiscover.mock.calls.filter(([provider]) => provider === "codex")).toHaveLength(1);
          expect(catalog(fake)?.scan).toMatchObject({ outcome: "succeeded" });
          expect(catalog(fake)?.models.map((row: Row) => row.id)).toEqual(["recovered"]);
        } finally {
          await restarted.stop();
        }
      } finally {
        release.resolve();
        await tick;
        await subject.stop();
      }
    },
  );
});

describe("sanitized bounded diagnostics", () => {
  it("deduplicates alternating unknown/read failures per current UUID and forgets prior attempts/export state", async () => {
    const clock = { now: BASE };
    const fake = createCatalogFake(() => new Date(clock.now));
    await prepareDueState(fake, clock, "seeded-overdue");
    let delayNext = true,
      readsUnavailable = false,
      exportPending = true;
    const delegated: Array<() => Promise<any>> = [];
    const db = faultDb(fake.db, async (name, method, args, run) => {
      if (
        delayNext &&
        name === CATALOG &&
        method === "updateOne" &&
        args[1]?.$set?.pendingExport &&
        args[0]._id === "codex"
      ) {
        delayNext = false;
        delegated.push(run);
        throw new Error("test-secret Bearer abc https://vendor.invalid/private account=customer command=env");
      }
      if (readsUnavailable && method === "findOne" && (name === CATALOG || name === VERSIONS)) {
        throw new Error("test-secret mongodb://user:pass@private.invalid/account");
      }
      return run();
    });
    const real = new ModelCatalogStore(db, { now: () => new Date(clock.now) });
    const recoverPendingExports = vi.fn(async (provider?: string) => {
      if (provider === undefined && exportPending) {
        return [{ provider: "sol", kind: "pending", error: safeError("sol", "storage") }];
      }
      return real.recoverPendingExports(provider);
    });
    const store = {
      readCatalogState: real.readCatalogState.bind(real),
      beginDiscoveryAttempt: real.beginDiscoveryAttempt.bind(real),
      applyDiscovery: real.applyDiscovery.bind(real),
      failDiscoveryAttempt: real.failDiscoveryAttempt.bind(real),
      recoverPendingExports,
    };
    let generation = 1;
    const discover = vi.fn(async (provider: CatalogProvider) =>
      models(provider === "codex" ? `new-${generation}` : `${provider}-old`),
    );
    const logger = testLogger();
    const subject = new ModelCatalogScanner(store, discover, { now: () => clock.now, logger });
    const warnings = (status: string) =>
      logger.warn.mock.calls.filter(
        ([, fields]) => (fields as Row).provider === "codex" && (fields as Row).status === status,
      );
    try {
      await subject.tick();
      expect(delegated).toHaveLength(1);
      const firstAttempt = catalog(fake)?.scan.attemptId;
      expect(warnings("commit-unknown")).toHaveLength(1);
      expect((subject as any).diagnostics.has("*")).toBe(true);
      for (const unavailable of [true, false, true, true, false]) {
        readsUnavailable = unavailable;
        await subject.tick();
      }
      expect(warnings("commit-unknown")).toHaveLength(1);
      expect(warnings("storage-unavailable")).toHaveLength(1);
      readsUnavailable = false;
      exportPending = false;
      expect((await delegated[0]()).matchedCount).toBe(1);
      await subject.tick();
      expect(
        logger.info.mock.calls.some(
          ([, fields]) => (fields as Row).provider === "codex" && (fields as Row).status === "committed",
        ),
      ).toBe(true);
      expect((subject as any).diagnostics.has("*")).toBe(false);
      generation = 2;
      delayNext = true;
      clock.now = BASE + SCAN_INTERVAL_MS;
      await subject.tick();
      expect(delegated).toHaveLength(2);
      const secondAttempt = catalog(fake)?.scan.attemptId;
      expect(secondAttempt).not.toBe(firstAttempt);
      expect(warnings("commit-unknown")).toHaveLength(2);
      const diagnostics = (subject as any).diagnostics as Map<string, { attemptId?: string; seen: Set<string> }>;
      expect(diagnostics.size).toBeLessThanOrEqual(4);
      expect(diagnostics.get("codex")?.attemptId).toBe(secondAttempt);
      expect(diagnostics.get("codex")?.seen.size).toBeLessThanOrEqual(3);
      expect(JSON.stringify([...diagnostics.entries()])).not.toContain(firstAttempt);
      expect((await delegated[1]()).matchedCount).toBe(1);
      await subject.tick();
      expect(catalog(fake)?.models.map((row: Row) => row.id)).toEqual(["new-2"]);
      expect(catalog(fake)?.scan).toMatchObject({ outcome: "succeeded" });
      const output = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
      expect(output).not.toMatch(/test-secret|Bearer|vendor\.invalid|mongodb:\/\/|private|customer|command|user:pass/);
    } finally {
      readsUnavailable = false;
      for (const run of delegated) await run().catch(() => {});
      await subject.stop();
    }
  });
});
