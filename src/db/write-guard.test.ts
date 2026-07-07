import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Db, Collection } from "mongodb";
import {
  WriteGuard,
  guardDb,
  DbIdentityMismatchError,
  GATED_COLLECTION_METHODS,
  GATED_DB_METHODS,
} from "./write-guard.js";

/** All 17 gated collection methods, exactly per spec — no additions/omissions. */
const GATED_METHOD_LIST = [
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "bulkWrite",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
  "createIndex",
  "createIndexes",
  "dropIndex",
  "dropIndexes",
  "drop",
  "rename",
] as const;

function makeStubCollection() {
  const stub: Record<string, unknown> = {};
  for (const name of GATED_METHOD_LIST) {
    stub[name] = vi.fn().mockResolvedValue(`${name}-result`);
  }
  // Non-gated forwarding methods; each records the `this` it was called with.
  for (const name of ["find", "findOne", "aggregate", "watch", "countDocuments"]) {
    stub[name] = vi.fn(function (this: unknown) {
      return { name, self: this };
    });
  }
  return stub as unknown as Collection & Record<string, ReturnType<typeof vi.fn>>;
}

function makeStubDb(stubCollection: ReturnType<typeof makeStubCollection>) {
  const stub = {
    collection: vi.fn().mockReturnValue(stubCollection),
    dropDatabase: vi.fn().mockResolvedValue(true),
    createCollection: vi.fn().mockResolvedValue({ created: true }),
    renameCollection: vi.fn().mockResolvedValue({ renamed: true }),
  };
  return stub as unknown as Db & Record<string, ReturnType<typeof vi.fn>>;
}

describe("write-guard", () => {
  let guard: WriteGuard;
  let stubCollection: ReturnType<typeof makeStubCollection>;
  let stubDb: ReturnType<typeof makeStubDb>;
  let db: Db;

  beforeEach(() => {
    guard = new WriteGuard({ instanceId: "hive", dbName: "hive_hive" });
    stubCollection = makeStubCollection();
    stubDb = makeStubDb(stubCollection);
    db = guardDb(stubDb, guard);
  });

  it("sanity: GATED_COLLECTION_METHODS matches the exact spec list", () => {
    expect([...GATED_COLLECTION_METHODS].sort()).toEqual([...GATED_METHOD_LIST].sort());
    expect(GATED_COLLECTION_METHODS.size).toBe(17);
  });

  it("sanity: GATED_DB_METHODS matches the exact spec list", () => {
    expect([...GATED_DB_METHODS].sort()).toEqual(["dropDatabase", "createCollection", "renameCollection"].sort());
  });

  // --- Scenario 1: disengaged, everything forwards verbatim ---
  it("disengaged: every gated method forwards verbatim (args + return value)", async () => {
    const col = db.collection("agent_definitions");
    for (const name of GATED_METHOD_LIST) {
      const arg = { probe: name };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (col as any)[name](arg);
      expect(result).toBe(`${name}-result`);
      expect((stubCollection as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]).toHaveBeenCalledWith(arg);
    }
  });

  it("disengaged: find/findOne forward verbatim", () => {
    const col = db.collection("agent_definitions");
    const findResult = col.find({ a: 1 } as never);
    expect(findResult).toEqual({ name: "find", self: stubCollection });
    expect(stubCollection.find).toHaveBeenCalledWith({ a: 1 });

    const findOneResult = col.findOne({ b: 2 } as never);
    expect(findOneResult).toEqual({ name: "findOne", self: stubCollection });
    expect(stubCollection.findOne).toHaveBeenCalledWith({ b: 2 });
  });

  // --- Scenario 2: engaged, every gated method rejects, no sync throw ---
  it("engaged: each of the 17 gated collection methods rejects with DbIdentityMismatchError, never sync-throws", async () => {
    guard.engage("test mismatch");
    const col = db.collection("agent_definitions");

    for (const name of GATED_METHOD_LIST) {
      let caughtSync = false;
      let capturedPromise: unknown;

      // Plain non-async function: if the call itself threw synchronously,
      // this try/catch would catch it as a sync throw rather than a
      // rejected promise.
      function callIt() {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          capturedPromise = (col as any)[name]();
        } catch {
          caughtSync = true;
        }
      }
      callIt();

      expect(caughtSync).toBe(false);
      expect(capturedPromise).toBeInstanceOf(Promise);
      // Attach .catch immediately so it doesn't register as unhandled.
      (capturedPromise as Promise<unknown>).catch(() => {});

      await expect(capturedPromise).rejects.toBeInstanceOf(DbIdentityMismatchError);
    }
  });

  // --- Scenario 3: refusedWriteCount increments once per refused call ---
  it("engaged: refusedWriteCount increments once per refused call", async () => {
    guard.engage("test mismatch");
    const col = db.collection("agent_definitions");

    expect(guard.refusedWriteCount).toBe(0);
    await col.insertOne({} as never).catch(() => {});
    expect(guard.refusedWriteCount).toBe(1);
    await col.updateOne({} as never, {} as never).catch(() => {});
    expect(guard.refusedWriteCount).toBe(2);
    await col.deleteOne({} as never).catch(() => {});
    expect(guard.refusedWriteCount).toBe(3);
  });

  // --- Scenario 4: engaged, non-gated methods still forward, bound to raw target ---
  it("engaged: find/findOne/aggregate/watch/countDocuments still forward, bound to the raw stub (not the proxy)", () => {
    guard.engage("test mismatch");
    const col = db.collection("agent_definitions");

    for (const name of ["find", "findOne", "aggregate", "watch", "countDocuments"] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (col as any)[name]();
      expect(result.self).toBe(stubCollection);
      expect(result.self).not.toBe(col);
    }
  });

  // --- Scenario 5: Db-level gated methods ---
  it("Db-level: dropDatabase/createCollection/renameCollection reject when engaged, forward when not", async () => {
    // Not engaged: forward.
    await expect(db.dropDatabase()).resolves.toBe(true);
    await expect(db.createCollection("foo" as never)).resolves.toEqual({ created: true });
    await expect(db.renameCollection("a" as never, "b")).resolves.toEqual({ renamed: true });

    // Engaged: reject.
    guard.engage("test mismatch");
    await expect(db.dropDatabase()).rejects.toBeInstanceOf(DbIdentityMismatchError);
    await expect(db.createCollection("foo" as never)).rejects.toBeInstanceOf(DbIdentityMismatchError);
    await expect(db.renameCollection("a" as never, "b")).rejects.toBeInstanceOf(DbIdentityMismatchError);
  });

  // --- Scenario 6: collection handle obtained before engage() is still gated (call-time check) ---
  it("collection handle obtained before engage() is gated after engage(); disengage() restores writes", async () => {
    const colBeforeEngage = db.collection("agent_definitions");

    // Not engaged yet: forwards.
    await expect(colBeforeEngage.insertOne({} as never)).resolves.toBe("insertOne-result");

    guard.engage("mismatch detected");
    await expect(colBeforeEngage.insertOne({} as never)).rejects.toBeInstanceOf(DbIdentityMismatchError);

    guard.disengage();
    await expect(colBeforeEngage.insertOne({} as never)).resolves.toBe("insertOne-result");
  });

  // --- Scenario 7: property identity ---
  it("property identity: proxiedCol.insertOne === proxiedCol.insertOne (stable across accesses)", () => {
    const col = db.collection("agent_definitions");
    expect(col.insertOne).toBe(col.insertOne);
    expect(col.find).toBe(col.find);
  });

  it("property identity: db.collection === db.collection", () => {
    expect(db.collection).toBe(db.collection);
  });

  // --- Scenario 8: error message contents ---
  it("error message contains expected instanceId/dbName and the string 'hive doctor'", async () => {
    guard.engage("simulated mismatch", { instanceId: "impostor", dbName: "hive_impostor" });
    const col = db.collection("agent_definitions");

    try {
      await col.insertOne({} as never);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(DbIdentityMismatchError);
      const message = (err as Error).message;
      expect(message).toContain("hive"); // expected instanceId
      expect(message).toContain("hive_hive"); // expected dbName
      expect(message).toContain("impostor"); // observed instanceId
      expect(message).toContain("hive_impostor"); // observed dbName
      expect(message).toContain("hive doctor");
      expect((err as DbIdentityMismatchError).code).toBe("DB_IDENTITY_MISMATCH");
    }
  });

  it("error message handles absent observed identity gracefully", async () => {
    guard.engage("sentinel absent at runtime");
    const col = db.collection("agent_definitions");

    try {
      await col.deleteMany({} as never);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(DbIdentityMismatchError);
      expect((err as Error).message).toContain("hive doctor");
      expect((err as Error).message).toContain("<absent>");
    }
  });

  // Extra: WriteGuard state transitions in isolation (module is pure, cheap to verify directly).
  it("WriteGuard starts disengaged with null reason/observed and zero refused count", () => {
    const g = new WriteGuard({ instanceId: "x", dbName: "y" });
    expect(g.engaged).toBe(false);
    expect(g.reason).toBeNull();
    expect(g.observed).toBeNull();
    expect(g.refusedWriteCount).toBe(0);
  });

  it("WriteGuard.disengage() resets reason and observed", () => {
    const g = new WriteGuard({ instanceId: "x", dbName: "y" });
    g.engage("reason", { instanceId: "z", dbName: "w" });
    expect(g.engaged).toBe(true);
    g.disengage();
    expect(g.engaged).toBe(false);
    expect(g.reason).toBeNull();
    expect(g.observed).toBeNull();
  });
});
