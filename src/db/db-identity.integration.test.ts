import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Db, Collection } from "mongodb";
import { MongoServerSelectionError } from "mongodb";
import { WriteGuard, guardDb, DbIdentityMismatchError } from "./write-guard.js";
import {
  SENTINEL_COLLECTION,
  DbIdentityMonitor,
  type IdentitySentinelDoc,
  type MonitoredMongoClient,
} from "./identity-sentinel.js";

/**
 * KPR-294 Task 4 — integration assembly test.
 *
 * Wires the REAL `WriteGuard` + `guardDb` + `DbIdentityMonitor` together over
 * a fake driver boundary (fake `EventEmitter` client, fake `Db`/`Collection`
 * objects) — no real mongod, per repo convention. This proves the pieces
 * cooperate end-to-end through the actual write path (`db.collection(...).
 * insertOne(...)`), not just that each piece behaves correctly in isolation
 * (already covered by write-guard.test.ts and identity-sentinel.test.ts).
 */

// `identity-sentinel.ts` calls `createLogger("identity-sentinel")` once at
// module load — the mock must return the SAME object every call so tests
// can assert against it (vi.hoisted required: vi.mock factories are hoisted
// above top-level const declarations). Same pattern as identity-sentinel.test.ts.
const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => mockLog,
}));

const EXPECTED = { instanceId: "hive", dbName: "hive_hive" };

function makeFakeClient(): MonitoredMongoClient & EventEmitter {
  return new EventEmitter() as unknown as MonitoredMongoClient & EventEmitter;
}

function matchingDoc(overrides: Partial<IdentitySentinelDoc> = {}): IdentitySentinelDoc {
  return {
    _id: "identity_sentinel",
    schemaVersion: 1,
    instanceId: EXPECTED.instanceId,
    dbName: EXPECTED.dbName,
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

/** Generic data-collection stub — records calls, resolves like a real driver call would. */
function makeDataCollectionStub() {
  return {
    insertOne: vi.fn().mockResolvedValue({ acknowledged: true, insertedId: "fake-id" }),
    findOne: vi.fn().mockResolvedValue({ _id: "fake-id", found: true }),
  };
}

function makeSentinelStub() {
  return { findOne: vi.fn() };
}

function makeTelemetryStub() {
  return { updateOne: vi.fn().mockResolvedValue({ acknowledged: true }) };
}

/**
 * Fake raw `Db`: `collection(name)` dispatches by name — the sentinel stub
 * for `"instance_identity"`, the telemetry stub for `"telemetry"`, and a
 * shared generic data-collection stub for everything else (e.g.
 * `"agent_definitions"`). Mirrors the plan's Task 4 Setup section exactly.
 */
function makeFakeRawDb(
  sentinelStub: ReturnType<typeof makeSentinelStub>,
  telemetryStub: ReturnType<typeof makeTelemetryStub>,
  dataStub: ReturnType<typeof makeDataCollectionStub>,
) {
  const collection = vi.fn((name: string) => {
    if (name === SENTINEL_COLLECTION) return sentinelStub;
    if (name === "telemetry") return telemetryStub;
    return dataStub;
  });
  return { collection } as unknown as Db;
}

async function flush(times = 15): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** Assembles the real pieces (WriteGuard, guardDb, DbIdentityMonitor) over fresh fakes. */
function setup(opts?: { intervalMs?: number; retryDelayMs?: number }) {
  const client = makeFakeClient();
  const sentinelStub = makeSentinelStub();
  const telemetryStub = makeTelemetryStub();
  const dataStub = makeDataCollectionStub();
  const fakeRawDb = makeFakeRawDb(sentinelStub, telemetryStub, dataStub);

  const guard = new WriteGuard(EXPECTED);
  const db = guardDb(fakeRawDb, guard);

  const monitor = new DbIdentityMonitor(client, fakeRawDb, guard, telemetryStub as unknown as Collection, {
    instanceId: EXPECTED.instanceId,
    dbName: EXPECTED.dbName,
    intervalMs: opts?.intervalMs ?? DbIdentityMonitor.INTERVAL_MS,
    retryDelayMs: opts?.retryDelayMs ?? DbIdentityMonitor.RETRY_DELAY_MS,
  });

  return { client, sentinelStub, telemetryStub, dataStub, fakeRawDb, guard, db, monitor };
}

describe("db-identity integration (real WriteGuard + guardDb + DbIdentityMonitor, fake driver)", () => {
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

  // --- Scenario 1: the incident, end-to-end ---
  it("incident end-to-end: serverDescriptionChanged with new processId + null sentinel -> guarded write rejects, telemetry mismatch recorded", async () => {
    const { client, sentinelStub, telemetryStub, dataStub, db, guard, monitor } = setup();

    // Boot state: verified (monitor constructor default).
    expect(guard.engaged).toBe(false);

    monitor.start();

    // Seed the address (first observation — no trigger).
    client.emit("serverDescriptionChanged", {
      address: "localhost:27017",
      previousDescription: serverDescription("Unknown"),
      newDescription: serverDescription("RSPrimary", "proc-1"),
    });
    await flush();
    expect(sentinelStub.findOne).not.toHaveBeenCalled();

    // Impostor: a new processId shows up on the same address — SDAM signature
    // of a silent reconnect to a different mongod. Sentinel read returns null
    // (empty impostor DB).
    sentinelStub.findOne.mockResolvedValueOnce(null);
    client.emit("serverDescriptionChanged", {
      address: "localhost:27017",
      previousDescription: serverDescription("RSPrimary", "proc-1"),
      newDescription: serverDescription("RSPrimary", "proc-2"),
    });
    await flush();

    expect(guard.engaged).toBe(true);

    // A write through the GUARDED db must reject with DbIdentityMismatchError
    // — proving the assembly (monitor -> guard -> guardDb proxy), not just
    // the guard in isolation.
    await expect(db.collection("agent_definitions").insertOne({ foo: "bar" } as never)).rejects.toBeInstanceOf(
      DbIdentityMismatchError,
    );
    expect(dataStub.insertOne).not.toHaveBeenCalled();

    // Telemetry recorded the mismatch with writesRefused: true.
    const upsertCall = telemetryStub.updateOne.mock.calls.at(-1);
    expect(upsertCall[0]).toEqual({ kind: "db_identity_stats" });
    expect(upsertCall[1].$set.state).toBe("mismatch");
    expect(upsertCall[1].$set.writesRefused).toBe(true);

    // refusedWriteCount reflected in the NEXT telemetry write.
    expect(guard.refusedWriteCount).toBe(1);
    await monitor.writeOnce();
    const nextUpsert = telemetryStub.updateOne.mock.calls.at(-1);
    expect(nextUpsert[1].$set.refusedWriteCount).toBe(1);

    monitor.stop();
  });

  // --- Scenario 2: auto-recovery ---
  it("auto-recovery: matching sentinel on periodic tick -> guarded write forwards again, telemetry verified, recovery logged", async () => {
    const { client, sentinelStub, telemetryStub, dataStub, db, guard, monitor } = setup();
    monitor.start();

    // Drive into mismatch first (same as scenario 1).
    sentinelStub.findOne.mockResolvedValueOnce(null);
    client.emit("connectionPoolCleared", {});
    await flush();
    expect(guard.engaged).toBe(true);
    await expect(db.collection("agent_definitions").insertOne({} as never)).rejects.toBeInstanceOf(
      DbIdentityMismatchError,
    );

    // Now the real mongod comes back — sentinel matches again. Advance the
    // 30s periodic tick.
    sentinelStub.findOne.mockResolvedValue(matchingDoc());
    await vi.advanceTimersByTimeAsync(DbIdentityMonitor.INTERVAL_MS);
    await flush();

    expect(guard.engaged).toBe(false);
    expect(mockLog.info).toHaveBeenCalledWith("identity re-verified — write refusal lifted", expect.anything());

    // Same write, through the same guarded db handle, now forwards to the raw stub.
    await expect(db.collection("agent_definitions").insertOne({ foo: "bar" } as never)).resolves.toEqual({
      acknowledged: true,
      insertedId: "fake-id",
    });
    expect(dataStub.insertOne).toHaveBeenCalledTimes(1);

    const upsertCall = telemetryStub.updateOne.mock.calls.at(-1);
    expect(upsertCall[1].$set.state).toBe("verified");

    monitor.stop();
  });

  // --- Scenario 3: foreign sentinel variant ---
  it("foreign sentinel: doc with different instanceId -> same refusal path, telemetry carries observedInstanceId", async () => {
    const { client, sentinelStub, telemetryStub, db, guard, monitor } = setup();
    monitor.start();

    sentinelStub.findOne.mockResolvedValueOnce(foreignDoc());
    client.emit("connectionPoolCleared", {});
    await flush();

    expect(guard.engaged).toBe(true);
    expect(guard.observed).toEqual({ instanceId: "impostor", dbName: "hive_impostor" });

    await expect(db.collection("agent_definitions").insertOne({} as never)).rejects.toBeInstanceOf(
      DbIdentityMismatchError,
    );

    const upsertCall = telemetryStub.updateOne.mock.calls.at(-1);
    expect(upsertCall[1].$set.state).toBe("mismatch");
    expect(upsertCall[1].$set.observedInstanceId).toBe("impostor");
    expect(upsertCall[1].$set.observedDbName).toBe("hive_impostor");

    monitor.stop();
  });

  // --- Scenario 4: cant_verify end-to-end ---
  it("cant_verify end-to-end: sentinel findOne rejects through retry grace -> guarded write rejects; later success -> writes flow", async () => {
    const { client, sentinelStub, db, guard, monitor } = setup({ retryDelayMs: 5_000 });
    monitor.start();

    sentinelStub.findOne
      .mockRejectedValueOnce(new Error("boom-1"))
      .mockRejectedValueOnce(new Error("boom-2"))
      .mockRejectedValueOnce(new Error("boom-3"));

    client.emit("connectionPoolCleared", {});
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();

    expect(sentinelStub.findOne).toHaveBeenCalledTimes(3);
    expect(guard.engaged).toBe(true);

    // Guarded write rejects while cant_verify.
    await expect(db.collection("agent_definitions").insertOne({} as never)).rejects.toBeInstanceOf(
      DbIdentityMismatchError,
    );

    // Reads succeed again on the next periodic tick.
    sentinelStub.findOne.mockResolvedValue(matchingDoc());
    await vi.advanceTimersByTimeAsync(DbIdentityMonitor.INTERVAL_MS);
    await flush();

    expect(guard.engaged).toBe(false);
    await expect(db.collection("agent_definitions").insertOne({} as never)).resolves.toEqual({
      acknowledged: true,
      insertedId: "fake-id",
    });

    monitor.stop();
  });

  // --- Scenario 4b: MongoServerSelectionError variant of cant_verify path (state unchanged, guard not engaged) ---
  it("cant_verify variant: MongoServerSelectionError x3 leaves state/guard unchanged, guarded writes keep flowing", async () => {
    const { client, sentinelStub, db, guard, monitor } = setup({ retryDelayMs: 5_000 });

    function makeSelectionError(msg: string) {
      const err = Object.create(MongoServerSelectionError.prototype) as MongoServerSelectionError;
      (err as { message: string }).message = msg;
      return err;
    }

    monitor.start();
    sentinelStub.findOne
      .mockRejectedValueOnce(makeSelectionError("unreachable-1"))
      .mockRejectedValueOnce(makeSelectionError("unreachable-2"))
      .mockRejectedValueOnce(makeSelectionError("unreachable-3"));

    client.emit("connectionPoolCleared", {});
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();

    // Boot state was "verified" and must remain unchanged — server-unreachable
    // means driver writes are already failing on their own; nothing new to protect.
    expect(guard.engaged).toBe(false);
    await expect(db.collection("agent_definitions").insertOne({} as never)).resolves.toEqual({
      acknowledged: true,
      insertedId: "fake-id",
    });

    monitor.stop();
  });

  // --- Scenario 5: reads flow during mismatch ---
  it("reads flow during mismatch: db.collection(...).findOne(...) forwards to the raw stub while writes are refused", async () => {
    const { client, sentinelStub, dataStub, db, guard, monitor } = setup();
    monitor.start();

    sentinelStub.findOne.mockResolvedValueOnce(null);
    client.emit("connectionPoolCleared", {});
    await flush();
    expect(guard.engaged).toBe(true);

    // Write refused...
    await expect(db.collection("agent_definitions").insertOne({} as never)).rejects.toBeInstanceOf(
      DbIdentityMismatchError,
    );

    // ...but reads on the SAME guarded collection handle still forward
    // (spec: refusal protects against corrupting/forking state, not against
    // reading).
    const col = db.collection("agent_definitions");
    const readResult = await col.findOne({ _id: "fake-id" } as never);
    expect(readResult).toEqual({ _id: "fake-id", found: true });
    expect(dataStub.findOne).toHaveBeenCalledWith({ _id: "fake-id" });

    monitor.stop();
  });
});
