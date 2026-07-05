import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Db } from "mongodb";
import {
  SENTINEL_COLLECTION,
  SENTINEL_ID,
  SENTINEL_SCHEMA_VERSION,
  ensureIdentitySentinelAtBoot,
  verifySentinel,
  type IdentitySentinelDoc,
} from "./identity-sentinel.js";

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
