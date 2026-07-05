import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Db, Collection } from "mongodb";
import { MongoServerSelectionError } from "mongodb";
import {
  SENTINEL_COLLECTION,
  SENTINEL_ID,
  SENTINEL_SCHEMA_VERSION,
  ensureIdentitySentinelAtBoot,
  verifySentinel,
  DbIdentityMonitor,
  type IdentitySentinelDoc,
  type MonitoredMongoClient,
} from "./identity-sentinel.js";
import { WriteGuard } from "./write-guard.js";

// `identity-sentinel.ts` calls `createLogger("identity-sentinel")` exactly
// once at module load, so the mock must return the SAME logger object every
// time (not a fresh one per call) for tests to observe calls against it.
// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// top-level const declarations.
const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => mockLog,
}));

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeStubCollection() {
  return {
    findOne: vi.fn(),
    insertOne: vi.fn(),
    replaceOne: vi.fn(),
  };
}

function makeStubDb(stubCollection: ReturnType<typeof makeStubCollection>) {
  return {
    collection: vi.fn(() => stubCollection),
  } as unknown as Db;
}

const EXPECTED = { instanceId: "hive", dbName: "hive_hive" };

describe("identity-sentinel: contract constants", () => {
  it("exports the exact frozen constants", () => {
    expect(SENTINEL_COLLECTION).toBe("instance_identity");
    expect(SENTINEL_ID).toBe("identity_sentinel");
    expect(SENTINEL_SCHEMA_VERSION).toBe(1);
  });
});

describe("ensureIdentitySentinelAtBoot", () => {
  let stubCollection: ReturnType<typeof makeStubCollection>;
  let stubDb: Db;

  beforeEach(() => {
    stubCollection = makeStubCollection();
    stubDb = makeStubDb(stubCollection);
  });

  // --- Scenario 1: absent -> insertOne with full frozen shape ---
  it("absent: calls insertOne with every frozen + stable field populated", async () => {
    stubCollection.findOne.mockResolvedValueOnce(null);
    stubCollection.insertOne.mockResolvedValueOnce({ acknowledged: true });

    const result = await ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: false });

    expect(result).toEqual({ outcome: "stamped" });
    expect(stubCollection.insertOne).toHaveBeenCalledTimes(1);
    const inserted = stubCollection.insertOne.mock.calls[0][0] as IdentitySentinelDoc;

    expect(inserted._id).toBe("identity_sentinel");
    expect(inserted.schemaVersion).toBe(1);
    expect(inserted.instanceId).toBe(EXPECTED.instanceId);
    expect(inserted.dbName).toBe(EXPECTED.dbName);
    expect(inserted.sentinelId).toMatch(UUID_V4_RE);
    expect(inserted.stampedAt).toBeInstanceOf(Date);
    expect(inserted.stampedBy).toBeDefined();
    expect(typeof inserted.stampedBy.engineVersion).toBe("string");
    expect(typeof inserted.stampedBy.hostname).toBe("string");
    expect(typeof inserted.stampedBy.pid).toBe("number");
  });

  // --- Scenario 2: present + match -> verified, no writes ---
  it("present + match: returns verified, insertOne/replaceOne never called", async () => {
    stubCollection.findOne.mockResolvedValueOnce({
      _id: "identity_sentinel",
      schemaVersion: 1,
      instanceId: EXPECTED.instanceId,
      dbName: EXPECTED.dbName,
      sentinelId: "some-uuid",
      stampedAt: new Date(),
      stampedBy: { engineVersion: "0.9.2", hostname: "host", pid: 123 },
    } satisfies IdentitySentinelDoc);

    const result = await ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: false });

    expect(result).toEqual({ outcome: "verified", schemaVersionNewer: false });
    expect(stubCollection.insertOne).not.toHaveBeenCalled();
    expect(stubCollection.replaceOne).not.toHaveBeenCalled();
  });

  // --- Scenario 3: present + mismatch -> mismatch, no writes, no process.exit ---
  it("present + mismatch: returns mismatch with observed identity, no writes", async () => {
    stubCollection.findOne.mockResolvedValueOnce({
      _id: "identity_sentinel",
      schemaVersion: 1,
      instanceId: "other-instance",
      dbName: "hive_other",
      sentinelId: "foreign-uuid",
      stampedAt: new Date(),
      stampedBy: { engineVersion: "0.9.2", hostname: "otherhost", pid: 999 },
    } satisfies IdentitySentinelDoc);

    const result = await ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: false });

    expect(result).toEqual({
      outcome: "mismatch",
      observed: { instanceId: "other-instance", dbName: "hive_other", sentinelId: "foreign-uuid" },
    });
    expect(stubCollection.insertOne).not.toHaveBeenCalled();
    expect(stubCollection.replaceOne).not.toHaveBeenCalled();
  });

  // --- Scenario 4: present + mismatch + restamp -> replaceOne upsert, restamped w/ previous ---
  it("present + mismatch + restamp: replaceOne upsert with new identity, returns restamped with previous identity", async () => {
    stubCollection.findOne.mockResolvedValueOnce({
      _id: "identity_sentinel",
      schemaVersion: 1,
      instanceId: "other-instance",
      dbName: "hive_other",
      sentinelId: "foreign-uuid",
      stampedAt: new Date(),
      stampedBy: { engineVersion: "0.9.2", hostname: "otherhost", pid: 999 },
    } satisfies IdentitySentinelDoc);
    stubCollection.replaceOne.mockResolvedValueOnce({ acknowledged: true });

    const result = await ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: true });

    expect(result).toEqual({
      outcome: "restamped",
      previous: { instanceId: "other-instance", dbName: "hive_other" },
    });
    expect(stubCollection.replaceOne).toHaveBeenCalledTimes(1);
    const [filter, replacement, options] = stubCollection.replaceOne.mock.calls[0];
    expect(filter).toEqual({ _id: "identity_sentinel" });
    expect(options).toEqual({ upsert: true });
    const newDoc = replacement as IdentitySentinelDoc;
    expect(newDoc.instanceId).toBe(EXPECTED.instanceId);
    expect(newDoc.dbName).toBe(EXPECTED.dbName);
    expect(newDoc.sentinelId).toMatch(UUID_V4_RE);
    expect(stubCollection.insertOne).not.toHaveBeenCalled();
  });

  // --- Scenario 5: E11000 race -> re-read -> Present-branch semantics ---
  it("E11000 race: insertOne rejects with duplicate-key, re-read happens, re-read-match returns verified", async () => {
    stubCollection.findOne
      .mockResolvedValueOnce(null) // initial read: absent
      .mockResolvedValueOnce({
        _id: "identity_sentinel",
        schemaVersion: 1,
        instanceId: EXPECTED.instanceId,
        dbName: EXPECTED.dbName,
        sentinelId: "winner-uuid",
        stampedAt: new Date(),
        stampedBy: { engineVersion: "0.9.2", hostname: "winner-host", pid: 111 },
      } satisfies IdentitySentinelDoc); // re-read: the winner's doc, matches us
    stubCollection.insertOne.mockRejectedValueOnce({ code: 11000 });

    const result = await ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: false });

    expect(stubCollection.findOne).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ outcome: "verified", schemaVersionNewer: false });
  });

  it("E11000 race: re-read-foreign returns mismatch", async () => {
    stubCollection.findOne
      .mockResolvedValueOnce(null) // initial read: absent
      .mockResolvedValueOnce({
        _id: "identity_sentinel",
        schemaVersion: 1,
        instanceId: "foreign-winner",
        dbName: "hive_foreign",
        sentinelId: "winner-uuid",
        stampedAt: new Date(),
        stampedBy: { engineVersion: "0.9.2", hostname: "winner-host", pid: 111 },
      } satisfies IdentitySentinelDoc); // re-read: a different instance won the race
    stubCollection.insertOne.mockRejectedValueOnce({ code: 11000 });

    const result = await ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: false });

    expect(stubCollection.findOne).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      outcome: "mismatch",
      observed: { instanceId: "foreign-winner", dbName: "hive_foreign", sentinelId: "winner-uuid" },
    });
  });

  it("insertOne rejection that is NOT a duplicate-key error propagates", async () => {
    stubCollection.findOne.mockResolvedValueOnce(null);
    const boom = new Error("connection reset");
    stubCollection.insertOne.mockRejectedValueOnce(boom);

    await expect(ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: false })).rejects.toThrow(
      "connection reset",
    );
  });

  // --- Scenario 6: schemaVersion 2 + matching frozen fields -> verified w/ schemaVersionNewer true ---
  it("schemaVersion 2 with matching frozen fields: verified, schemaVersionNewer true", async () => {
    stubCollection.findOne.mockResolvedValueOnce({
      _id: "identity_sentinel",
      schemaVersion: 2,
      instanceId: EXPECTED.instanceId,
      dbName: EXPECTED.dbName,
      sentinelId: "future-uuid",
      stampedAt: new Date(),
      stampedBy: { engineVersion: "1.5.0", hostname: "futurehost", pid: 222 },
    } satisfies IdentitySentinelDoc);

    const result = await ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: false });

    expect(result).toEqual({ outcome: "verified", schemaVersionNewer: true });
  });

  it("read/write errors propagate (boot Mongo failures are already fatal elsewhere)", async () => {
    stubCollection.findOne.mockRejectedValueOnce(new Error("mongo unreachable"));

    await expect(ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: false })).rejects.toThrow(
      "mongo unreachable",
    );
  });

  it("no process.exit is invoked anywhere in this module's boot-check path", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit should never be called by ensureIdentitySentinelAtBoot");
    });
    try {
      stubCollection.findOne.mockResolvedValueOnce({
        _id: "identity_sentinel",
        schemaVersion: 1,
        instanceId: "other-instance",
        dbName: "hive_other",
        sentinelId: "foreign-uuid",
        stampedAt: new Date(),
        stampedBy: { engineVersion: "0.9.2", hostname: "otherhost", pid: 999 },
      } satisfies IdentitySentinelDoc);

      const result = await ensureIdentitySentinelAtBoot(stubDb, { ...EXPECTED, restamp: false });
      expect(result.outcome).toBe("mismatch");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// --- Scenario 7: verifySentinel ---
describe("verifySentinel", () => {
  let stubCollection: ReturnType<typeof makeStubCollection>;
  let stubDb: Db;

  beforeEach(() => {
    stubCollection = makeStubCollection();
    stubDb = makeStubDb(stubCollection);
  });

  it("match: returns verified with observed identity", async () => {
    stubCollection.findOne.mockResolvedValueOnce({
      _id: "identity_sentinel",
      schemaVersion: 1,
      instanceId: EXPECTED.instanceId,
      dbName: EXPECTED.dbName,
      sentinelId: "some-uuid",
      stampedAt: new Date(),
      stampedBy: { engineVersion: "0.9.2", hostname: "host", pid: 123 },
    } satisfies IdentitySentinelDoc);

    const result = await verifySentinel(stubDb, EXPECTED);

    expect(result).toEqual({
      state: "verified",
      sentinelPresent: true,
      schemaVersionNewer: false,
      observed: { instanceId: EXPECTED.instanceId, dbName: EXPECTED.dbName, sentinelId: "some-uuid" },
    });
  });

  it("foreign doc: returns mismatch with observed identity, sentinelPresent true", async () => {
    stubCollection.findOne.mockResolvedValueOnce({
      _id: "identity_sentinel",
      schemaVersion: 1,
      instanceId: "impostor",
      dbName: "hive_impostor",
      sentinelId: "impostor-uuid",
      stampedAt: new Date(),
      stampedBy: { engineVersion: "0.9.2", hostname: "impostor-host", pid: 666 },
    } satisfies IdentitySentinelDoc);

    const result = await verifySentinel(stubDb, EXPECTED);

    expect(result).toEqual({
      state: "mismatch",
      sentinelPresent: true,
      observed: { instanceId: "impostor", dbName: "hive_impostor", sentinelId: "impostor-uuid" },
    });
  });

  it("null doc: returns mismatch with sentinelPresent false and observed null", async () => {
    stubCollection.findOne.mockResolvedValueOnce(null);

    const result = await verifySentinel(stubDb, EXPECTED);

    expect(result).toEqual({ state: "mismatch", sentinelPresent: false, observed: null });
  });

  it("passes maxTimeMS: 5000 to findOne", async () => {
    stubCollection.findOne.mockResolvedValueOnce(null);

    await verifySentinel(stubDb, EXPECTED);

    expect(stubCollection.findOne).toHaveBeenCalledWith({ _id: "identity_sentinel" }, { maxTimeMS: 5000 });
  });

  it("read rejection propagates", async () => {
    stubCollection.findOne.mockRejectedValueOnce(new Error("read timeout"));

    await expect(verifySentinel(stubDb, EXPECTED)).rejects.toThrow("read timeout");
  });

  it("schemaVersion 2 with matching frozen fields: verified, schemaVersionNewer true", async () => {
    stubCollection.findOne.mockResolvedValueOnce({
      _id: "identity_sentinel",
      schemaVersion: 2,
      instanceId: EXPECTED.instanceId,
      dbName: EXPECTED.dbName,
      sentinelId: "future-uuid",
      stampedAt: new Date(),
      stampedBy: { engineVersion: "1.5.0", hostname: "futurehost", pid: 222 },
    } satisfies IdentitySentinelDoc);

    const result = await verifySentinel(stubDb, EXPECTED);

    expect(result).toEqual({
      state: "verified",
      sentinelPresent: true,
      schemaVersionNewer: true,
      observed: { instanceId: EXPECTED.instanceId, dbName: EXPECTED.dbName, sentinelId: "future-uuid" },
    });
  });
});

// ---------------------------------------------------------------------------
// Task 3 — DbIdentityMonitor
// ---------------------------------------------------------------------------

describe("DbIdentityMonitor", () => {
  const MONITOR_EXPECTED = { instanceId: "hive", dbName: "hive_hive" };

  function makeFakeClient(): MonitoredMongoClient & EventEmitter {
    return new EventEmitter() as unknown as MonitoredMongoClient & EventEmitter;
  }

  function makeSentinelCollection() {
    return { findOne: vi.fn() };
  }

  function makeTelemetryCollection() {
    return { updateOne: vi.fn().mockResolvedValue({ acknowledged: true }) };
  }

  function makeRawDb(sentinelCollection: ReturnType<typeof makeSentinelCollection>) {
    return {
      collection: vi.fn(() => sentinelCollection),
    } as unknown as Db;
  }

  function matchingDoc(overrides: Partial<IdentitySentinelDoc> = {}): IdentitySentinelDoc {
    return {
      _id: "identity_sentinel",
      schemaVersion: 1,
      instanceId: MONITOR_EXPECTED.instanceId,
      dbName: MONITOR_EXPECTED.dbName,
      sentinelId: "matching-uuid",
      stampedAt: new Date(),
      stampedBy: { engineVersion: "0.9.2", hostname: "host", pid: 1 },
      ...overrides,
    };
  }

  function foreignDoc(): IdentitySentinelDoc {
    return matchingDoc({ instanceId: "impostor", dbName: "hive_impostor", sentinelId: "impostor-uuid" });
  }

  function serverDescription(type: string, processId?: string) {
    return { type, topologyVersion: processId === undefined ? null : { processId } };
  }

  /** Builds a monitor wired to fresh fakes; returns everything a test needs. */
  function setup(opts?: { intervalMs?: number; retryDelayMs?: number }) {
    const client = makeFakeClient();
    const sentinelCollection = makeSentinelCollection();
    const rawDb = makeRawDb(sentinelCollection);
    const telemetryCollection = makeTelemetryCollection();
    const guard = new WriteGuard(MONITOR_EXPECTED);
    const monitor = new DbIdentityMonitor(client, rawDb, guard, telemetryCollection as unknown as Collection, {
      instanceId: MONITOR_EXPECTED.instanceId,
      dbName: MONITOR_EXPECTED.dbName,
      intervalMs: opts?.intervalMs ?? DbIdentityMonitor.INTERVAL_MS,
      retryDelayMs: opts?.retryDelayMs ?? DbIdentityMonitor.RETRY_DELAY_MS,
    });
    return { client, sentinelCollection, telemetryCollection, guard, monitor };
  }

  async function flush(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockLog.debug.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Scenario 1: serverDescriptionChanged trigger semantics ---
  it("serverDescriptionChanged: changed processId triggers verify; same processId does not; first-seen seeds silently", async () => {
    const { client, sentinelCollection, monitor } = setup();
    sentinelCollection.findOne.mockResolvedValue(matchingDoc());
    monitor.start();

    // First observation of this address: seeds silently, no verify.
    client.emit("serverDescriptionChanged", {
      address: "localhost:27017",
      previousDescription: serverDescription("Unknown"),
      newDescription: serverDescription("RSPrimary", "proc-1"),
    });
    await flush();
    expect(sentinelCollection.findOne).not.toHaveBeenCalled();

    // Same processId again: no trigger.
    client.emit("serverDescriptionChanged", {
      address: "localhost:27017",
      previousDescription: serverDescription("RSPrimary", "proc-1"),
      newDescription: serverDescription("RSPrimary", "proc-1"),
    });
    await flush();
    expect(sentinelCollection.findOne).not.toHaveBeenCalled();

    // Changed processId: triggers.
    client.emit("serverDescriptionChanged", {
      address: "localhost:27017",
      previousDescription: serverDescription("RSPrimary", "proc-1"),
      newDescription: serverDescription("RSPrimary", "proc-2"),
    });
    await flush();
    expect(sentinelCollection.findOne).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it("serverDescriptionChanged: skips when newDescription.type is Unknown", async () => {
    const { client, sentinelCollection, monitor } = setup();
    sentinelCollection.findOne.mockResolvedValue(matchingDoc());
    monitor.start();

    client.emit("serverDescriptionChanged", {
      address: "localhost:27017",
      previousDescription: serverDescription("RSPrimary", "proc-1"),
      newDescription: serverDescription("Unknown"),
    });
    await flush();
    expect(sentinelCollection.findOne).not.toHaveBeenCalled();

    monitor.stop();
  });

  // --- Scenario 2: topologyDescriptionChanged + connectionPoolCleared triggers ---
  it("topologyDescriptionChanged: Unknown -> known transition triggers verify", async () => {
    const { client, sentinelCollection, monitor } = setup();
    sentinelCollection.findOne.mockResolvedValue(matchingDoc());
    monitor.start();

    const previousServers = new Map([["localhost:27017", serverDescription("Unknown")]]);
    const newServers = new Map([["localhost:27017", serverDescription("RSPrimary", "proc-1")]]);

    client.emit("topologyDescriptionChanged", {
      previousDescription: { servers: previousServers },
      newDescription: { servers: newServers },
    });
    await flush();
    expect(sentinelCollection.findOne).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it("topologyDescriptionChanged: known -> known does not trigger", async () => {
    const { client, sentinelCollection, monitor } = setup();
    sentinelCollection.findOne.mockResolvedValue(matchingDoc());
    monitor.start();

    const previousServers = new Map([["localhost:27017", serverDescription("RSPrimary", "proc-1")]]);
    const newServers = new Map([["localhost:27017", serverDescription("RSPrimary", "proc-1")]]);

    client.emit("topologyDescriptionChanged", {
      previousDescription: { servers: previousServers },
      newDescription: { servers: newServers },
    });
    await flush();
    expect(sentinelCollection.findOne).not.toHaveBeenCalled();

    monitor.stop();
  });

  it("connectionPoolCleared: always triggers verify", async () => {
    const { client, sentinelCollection, monitor } = setup();
    sentinelCollection.findOne.mockResolvedValue(matchingDoc());
    monitor.start();

    client.emit("connectionPoolCleared", {});
    await flush();
    expect(sentinelCollection.findOne).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  // --- Scenario 3: single-flight dirty-flag dedup ---
  it("single-flight: burst of 5 triggers while in flight -> exactly one follow-up run", async () => {
    const { client, sentinelCollection, monitor } = setup();
    let releaseFirst!: () => void;
    const gate = new Promise<IdentitySentinelDoc>((resolve) => {
      releaseFirst = () => resolve(matchingDoc());
    });
    sentinelCollection.findOne.mockReturnValueOnce(gate).mockResolvedValue(matchingDoc());
    monitor.start();

    // First trigger starts the in-flight verification (gated on `gate`).
    client.emit("connectionPoolCleared", {});
    await flush();
    expect(sentinelCollection.findOne).toHaveBeenCalledTimes(1);

    // 5 more triggers while in flight — all should collapse into the dirty flag.
    for (let i = 0; i < 5; i++) {
      client.emit("connectionPoolCleared", {});
    }
    await flush();
    // Still just the one in-flight call — the burst hasn't run yet.
    expect(sentinelCollection.findOne).toHaveBeenCalledTimes(1);

    // Release the gate; in-flight settles, dirty flag fires exactly one follow-up.
    releaseFirst();
    await flush(15);
    expect(sentinelCollection.findOne).toHaveBeenCalledTimes(2);

    monitor.stop();
  });

  // --- Scenario 4: runtime absent doc -> mismatch (the incident-shaped regression test) ---
  it("runtime absent doc -> mismatch, guard engaged, telemetry + critical log", async () => {
    const { client, sentinelCollection, telemetryCollection, guard, monitor } = setup();
    sentinelCollection.findOne.mockResolvedValueOnce(null);
    monitor.start();

    client.emit("connectionPoolCleared", {});
    await flush(15);

    expect(guard.engaged).toBe(true);

    const upsertCall = telemetryCollection.updateOne.mock.calls.at(-1);
    expect(upsertCall[0]).toEqual({ kind: "db_identity_stats" });
    expect(upsertCall[1].$set.state).toBe("mismatch");
    expect(upsertCall[1].$set.writesRefused).toBe(true);

    expect(mockLog.error).toHaveBeenCalledWith(
      "DB IDENTITY MISMATCH — refusing writes",
      expect.objectContaining({ critical: true }),
    );

    monitor.stop();
  });

  // --- Scenario 5: mismatch -> matching read -> auto-recovery ---
  it("mismatch -> later matching read -> guard disengaged, recovery logged, telemetry verified", async () => {
    const { client, sentinelCollection, telemetryCollection, guard, monitor } = setup();
    sentinelCollection.findOne.mockResolvedValueOnce(null);
    monitor.start();

    client.emit("connectionPoolCleared", {});
    await flush(15);
    expect(guard.engaged).toBe(true);

    sentinelCollection.findOne.mockResolvedValue(matchingDoc());
    await vi.advanceTimersByTimeAsync(DbIdentityMonitor.INTERVAL_MS);
    await flush(15);

    expect(guard.engaged).toBe(false);
    expect(mockLog.info).toHaveBeenCalledWith("identity re-verified — write refusal lifted", expect.anything());
    const upsertCall = telemetryCollection.updateOne.mock.calls.at(-1);
    expect(upsertCall[1].$set.state).toBe("verified");

    monitor.stop();
  });

  // --- Scenario 6: 3x generic error -> cant_verify; later success recovers ---
  it("findOne rejects 3x with generic Error -> cant_verify, guard engaged; later success recovers", async () => {
    const { client, sentinelCollection, guard, monitor } = setup({ retryDelayMs: 5_000 });
    sentinelCollection.findOne
      .mockRejectedValueOnce(new Error("boom-1"))
      .mockRejectedValueOnce(new Error("boom-2"))
      .mockRejectedValueOnce(new Error("boom-3"));
    monitor.start();

    client.emit("connectionPoolCleared", {});
    await flush();
    // 2 retry delays between the 3 attempts.
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush(15);

    expect(sentinelCollection.findOne).toHaveBeenCalledTimes(3);
    expect(guard.engaged).toBe(true);

    sentinelCollection.findOne.mockResolvedValue(matchingDoc());
    await vi.advanceTimersByTimeAsync(DbIdentityMonitor.INTERVAL_MS);
    await flush(15);
    expect(guard.engaged).toBe(false);

    monitor.stop();
  });

  // --- Scenario 7: 3x MongoServerSelectionError -> state unchanged, guard NOT engaged ---
  it("findOne rejects 3x with MongoServerSelectionError -> state unchanged, guard not engaged, lastVerifyError recorded", async () => {
    const { client, sentinelCollection, telemetryCollection, guard, monitor } = setup({ retryDelayMs: 5_000 });

    function makeSelectionError(msg: string) {
      const err = Object.create(MongoServerSelectionError.prototype) as MongoServerSelectionError;
      (err as { message: string }).message = msg;
      return err;
    }

    sentinelCollection.findOne
      .mockRejectedValueOnce(makeSelectionError("unreachable-1"))
      .mockRejectedValueOnce(makeSelectionError("unreachable-2"))
      .mockRejectedValueOnce(makeSelectionError("unreachable-3"));
    monitor.start();

    client.emit("connectionPoolCleared", {});
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush(15);

    expect(sentinelCollection.findOne).toHaveBeenCalledTimes(3);
    // State started "verified" (constructor seed) and must remain unchanged.
    expect(guard.engaged).toBe(false);

    const upsertCall = telemetryCollection.updateOne.mock.calls.at(-1);
    expect(upsertCall[1].$set.state).toBe("verified");
    expect(upsertCall[1].$set.lastVerifyError).toContain("unreachable-3");

    monitor.stop();
  });

  // --- Scenario 8: throwing listener/tick never escapes ---
  it("throwing listener/tick: synchronous findOne throw does not produce an unhandled rejection; monitor stays responsive", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { client, sentinelCollection, monitor } = setup({ retryDelayMs: 5_000 });
      // Throws synchronously on every call within this run's retry loop
      // (all 3 attempts) — the retry/grace path must absorb this without
      // ever surfacing as an unhandled rejection.
      sentinelCollection.findOne.mockImplementation(() => {
        throw new Error("synchronous boom");
      });
      monitor.start();

      client.emit("connectionPoolCleared", {});
      await flush();
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
      await vi.advanceTimersByTimeAsync(5_000);
      await flush(15);

      expect(unhandled).not.toHaveBeenCalled();
      expect(sentinelCollection.findOne).toHaveBeenCalledTimes(3);

      // Monitor should still be responsive to a subsequent trigger.
      sentinelCollection.findOne.mockReset();
      sentinelCollection.findOne.mockResolvedValue(matchingDoc());
      client.emit("connectionPoolCleared", {});
      await flush(15);
      expect(sentinelCollection.findOne).toHaveBeenCalledTimes(1);

      monitor.stop();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });

  // --- Scenario 9: engaged-to-engaged cross-transitions ---
  it("cross-transitions: mismatch -> cant_verify -> mismatch -> stays mismatch under selection errors", async () => {
    const { client, sentinelCollection, guard, monitor } = setup({ retryDelayMs: 5_000 });

    // 1) mismatch (absent doc).
    sentinelCollection.findOne.mockResolvedValueOnce(null);
    monitor.start();
    client.emit("connectionPoolCleared", {});
    await flush(15);
    expect(guard.engaged).toBe(true);

    // 2) mismatch -> cant_verify (3x generic error).
    sentinelCollection.findOne
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockRejectedValueOnce(new Error("e3"));
    await vi.advanceTimersByTimeAsync(DbIdentityMonitor.INTERVAL_MS);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush(15);
    expect(guard.engaged).toBe(true);

    // 3) cant_verify -> mismatch (read succeeds with foreign doc).
    sentinelCollection.findOne.mockResolvedValue(foreignDoc());
    await vi.advanceTimersByTimeAsync(DbIdentityMonitor.INTERVAL_MS);
    await flush(15);
    expect(guard.engaged).toBe(true);

    // 4) mismatch -> 3x MongoServerSelectionError -> stays mismatch (state unchanged).
    function makeSelectionError(msg: string) {
      const err = Object.create(MongoServerSelectionError.prototype) as MongoServerSelectionError;
      (err as { message: string }).message = msg;
      return err;
    }
    sentinelCollection.findOne
      .mockRejectedValueOnce(makeSelectionError("s1"))
      .mockRejectedValueOnce(makeSelectionError("s2"))
      .mockRejectedValueOnce(makeSelectionError("s3"));
    await vi.advanceTimersByTimeAsync(DbIdentityMonitor.INTERVAL_MS);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush(15);

    // Still refusing (state stayed "mismatch"), and guard remains engaged throughout.
    expect(guard.engaged).toBe(true);
    expect(guard.reason).not.toBeNull();

    monitor.stop();
  });

  // --- Scenario 10 (plan lists two "9"s — schemaVersion tolerance) ---
  it("schemaVersion 2 matching doc -> stays verified, log.warn called", async () => {
    const { client, sentinelCollection, guard, monitor } = setup();
    sentinelCollection.findOne.mockResolvedValue(matchingDoc({ schemaVersion: 2 }));
    monitor.start();

    client.emit("connectionPoolCleared", {});
    await flush(15);

    expect(guard.engaged).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith(
      "identity sentinel schemaVersion is newer than this engine expects",
      expect.anything(),
    );

    monitor.stop();
  });

  // --- Scenario 11: telemetry doc shape snapshot ---
  it("telemetry doc shape: full key set and kind/filter of the upsert", async () => {
    const { telemetryCollection, monitor } = setup();

    await monitor.writeOnce();

    expect(telemetryCollection.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = telemetryCollection.updateOne.mock.calls[0];
    expect(filter).toEqual({ kind: "db_identity_stats" });
    expect(options).toEqual({ upsert: true });

    const setDoc = update.$set;
    expect(Object.keys(setDoc).sort()).toEqual(
      [
        "kind",
        "state",
        "expectedInstanceId",
        "expectedDbName",
        "sentinelPresent",
        "observedInstanceId",
        "observedDbName",
        "observedSentinelId",
        "writesRefused",
        "refusedWriteCount",
        "verifyCount",
        "mismatchCount",
        "lastVerifiedAt",
        "lastMismatchAt",
        "lastVerifyError",
        "lastTriggerReason",
        "updatedAt",
      ].sort(),
    );
    expect(setDoc.kind).toBe("db_identity_stats");
    expect(setDoc.updatedAt).toBeInstanceOf(Date);
  });

  // --- Scenario 12: stop() clears interval and removes listeners ---
  it("stop() clears the interval and removes listeners; emit after stop() causes no verify", async () => {
    const { client, sentinelCollection, monitor } = setup();
    sentinelCollection.findOne.mockResolvedValue(matchingDoc());
    monitor.start();
    monitor.stop();

    client.emit("connectionPoolCleared", {});
    client.emit("serverDescriptionChanged", {
      address: "localhost:27017",
      previousDescription: serverDescription("Unknown"),
      newDescription: serverDescription("RSPrimary", "proc-1"),
    });
    client.emit("topologyDescriptionChanged", {
      previousDescription: { servers: new Map([["localhost:27017", serverDescription("Unknown")]]) },
      newDescription: { servers: new Map([["localhost:27017", serverDescription("RSPrimary", "proc-1")]]) },
    });
    await flush(15);
    await vi.advanceTimersByTimeAsync(DbIdentityMonitor.INTERVAL_MS * 2);
    await flush(15);

    expect(sentinelCollection.findOne).not.toHaveBeenCalled();
    expect(client.listenerCount("connectionPoolCleared")).toBe(0);
    expect(client.listenerCount("serverDescriptionChanged")).toBe(0);
    expect(client.listenerCount("topologyDescriptionChanged")).toBe(0);
  });
});
