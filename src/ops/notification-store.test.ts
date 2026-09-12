import { describe, it, expect } from "vitest";
import { FakeDb } from "./testing/fake-db.js";
import { OpsNotificationStore, SWEEP_CURSOR_KIND, isDuplicateKey } from "./notification-store.js";
import { OPS_NOTIFICATIONS_COLLECTION, OPS_POLICY_COLLECTION } from "./notification-types.js";

// SCOPE NOTE: the double models neither index selection nor index options, so
// these cases pin the index SHAPES that were requested and nothing about how a
// planner uses them. D2/D5's boundedness claims are carried behaviourally by
// AC7's starvation case (chunk 6), not here.
//
// The two collection-name constants are imported rather than spelled inline so
// a rename is a compile error here, not a silently-passing test against a
// collection nobody writes.

describe("OpsNotificationStore.ensureIndexes (D2, D10)", () => {
  it("creates exactly the nine indexes, none sparse, with the unique one first", async () => {
    const db = new FakeDb();
    const store = new OpsNotificationStore(db.db);
    const result = await store.ensureIndexes();
    expect(result).toEqual({ uniqueOk: true, failures: 0 });

    const created = db
      .collection(OPS_NOTIFICATIONS_COLLECTION)
      .indexes.filter((i) => i.name !== "_id_")
      .map((i) => ({ key: i.key, unique: Boolean(i.unique), sparse: Boolean(i.sparse), ttl: i.expireAfterSeconds }));

    expect(created).toEqual([
      { key: { subscriptionId: 1, dedupeKey: 1 }, unique: true, sparse: false, ttl: undefined },
      { key: { dedupeKey: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { state: 1, attemptCount: 1, nextNudgeAt: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { forceDeliver: 1, nextNudgeAt: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { state: 1, nextNudgeAt: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { stalledReason: 1, state: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { lastOutcome: 1, state: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { state: 1, snoozedUntil: 1 }, unique: false, sparse: false, ttl: undefined },
      { key: { expiresAt: 1 }, unique: false, sparse: false, ttl: 0 },
    ]);
  });

  it("reports uniqueOk: false when the identity index fails, and contains every other failure", async () => {
    const db = new FakeDb();
    db.failNext(OPS_NOTIFICATIONS_COLLECTION, "createIndex"); // the identity index is created first
    const store = new OpsNotificationStore(db.db);
    const result = await store.ensureIndexes();
    expect(result.uniqueOk).toBe(false);
    expect(result.failures).toBe(1);
    // Contained: the remaining eight still exist.
    expect(db.collection(OPS_NOTIFICATIONS_COLLECTION).indexes.length).toBe(1 /* _id_ */ + 8);
  });

  it("keeps uniqueOk: true when a non-identity index fails", async () => {
    const db = new FakeDb();
    const store = new OpsNotificationStore(db.db);
    // The nth-call fault, expressed through failNext's own `when` predicate
    // rather than through new double API: the fault stays armed until the
    // predicate returns true, so indexes 1 and 2 succeed and index 3 — arm 1 —
    // throws.
    let seen = 0;
    db.failNext(OPS_NOTIFICATIONS_COLLECTION, "createIndex", new Error("injected"), () => (seen += 1) === 3);
    const result = await store.ensureIndexes();
    expect(result).toEqual({ uniqueOk: true, failures: 1 });
  });
});

describe("the D12 cursor lives in db.telemetry (D3)", () => {
  it("round-trips a position and never shares a document with the heartbeat", async () => {
    const db = new FakeDb();
    const store = new OpsNotificationStore(db.db);
    expect(await store.readCursor()).toBeNull();

    const at = new Date("2026-01-01T00:00:00.000Z");
    await store.writeCursor({ publishedAt: at, eventId: "65a1b2c3d4e5f60718293a4b" });
    await store.writeHeartbeat({ state: "ok", eventsBehind: 0 });

    expect(await store.readCursor()).toEqual({ publishedAt: at, eventId: "65a1b2c3d4e5f60718293a4b" });
    const docs = [...db.collection("telemetry").rows];
    expect(docs.map((d) => d.kind).sort()).toEqual(["ops_notifier_stats", "ops_sweep_cursor"]);
    // Overwriting stats must never clobber the cursor.
    expect(docs.find((d) => d.kind === SWEEP_CURSOR_KIND)?.state).toBeUndefined();
  });

  it("writes the cursor with majority write concern", async () => {
    const db = new FakeDb();
    const store = new OpsNotificationStore(db.db);
    await store.writeCursor({ publishedAt: new Date(0), eventId: null });
    const op = db.operations.filter((o) => o.collection === "telemetry" && o.operation === "updateOne").at(-1);
    // The double records the option; it does not honour it. That is the honest
    // limit of the assertion and is why it is written as "was passed".
    expect(op?.context.options).toMatchObject({ writeConcern: { w: "majority", wtimeoutMS: 5000 } });
  });
});

describe("readPolicy distinguishes absent from faulted (D5)", () => {
  it("returns null when nothing is registered", async () => {
    const db = new FakeDb();
    expect(await new OpsNotificationStore(db.db).readPolicy()).toBeNull();
  });

  it("THROWS on a storage fault rather than resolving it as 'no policy'", async () => {
    // Resolving a throw as absent would mark every working row cadence-stalled
    // on that tick — a two-second blip turned into a full re-check interval of
    // silence for every subscriber (D5).
    const db = new FakeDb();
    db.failNext(OPS_POLICY_COLLECTION, "findOne");
    await expect(new OpsNotificationStore(db.db).readPolicy()).rejects.toBeTruthy();
  });
});

describe("the double round-trips an ObjectId (KPR-454's clone, relied on here)", () => {
  it("returns a real ObjectId from insertOne, find and findOne", async () => {
    // `copy()` already branches on ObjectId (KPR-454 shipped it that way); this
    // case exists because NO other suite would notice a regression to bare
    // structuredClone, under which every id degrades to "[object Object]" and
    // the whole (publishedAt, _id) watermark collapses to one identical string.
    // Not `instanceof ObjectId`: the assertion that matters is the one the
    // ledger actually performs on every event reference it stores.
    const db = new FakeDb();
    const res = await db.collection("probe").insertOne({ n: 1 });
    const [found] = await db.collection("probe").find({}).toArray();
    const one = await db.collection("probe").findOne({});
    for (const id of [res.insertedId, found._id, one!._id]) expect(String(id)).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("failAll is the persistent fault failNext is not", () => {
  it("fires on two consecutive matching calls, and clearFaults disarms it", async () => {
    // The ledger's wedge signature (D8(b)) needs one event to fault on two
    // successive ticks; the one-shot failNext cannot express it.
    const db = new FakeDb();
    db.failAll("probe", "findOne");
    await expect(db.collection("probe").findOne({})).rejects.toBeTruthy();
    await expect(db.collection("probe").findOne({})).rejects.toBeTruthy();
    db.clearFaults();
    expect(await db.collection("probe").findOne({})).toBeNull();

    // The contrast, on the same surface: failNext fires once and disarms itself.
    db.failNext("probe", "findOne");
    await expect(db.collection("probe").findOne({})).rejects.toBeTruthy();
    expect(await db.collection("probe").findOne({})).toBeNull();
  });
});

describe("the harness extensions this ticket added (KPR-468)", () => {
  it("saturates countDocuments at options.limit", async () => {
    const db = new FakeDb();
    for (const n of [1, 2, 3, 4, 5]) await db.collection("probe").insertOne({ n });
    expect(await db.collection("probe").countDocuments({})).toBe(5);
    expect(await db.collection("probe").countDocuments({}, { limit: 2 })).toBe(2);
    // Saturating means a smaller match is reported as-is, not as the limit.
    expect(await db.collection("probe").countDocuments({ n: 1 }, { limit: 2 })).toBe(1);
  });

  it("applies $unset as a real delete, so Object.keys no longer reports the field", async () => {
    const db = new FakeDb();
    await db.collection("probe").insertOne({ _id: "a", keep: 1, drop: 2, nested: { gone: 3, stays: 4 } });
    await db.collection("probe").updateOne({ _id: "a" }, { $unset: { drop: "", "nested.gone": "" } });
    const row = await db.collection("probe").findOne({ _id: "a" });
    expect(Object.keys(row!).sort()).toEqual(["_id", "keep", "nested"]);
    expect(Object.keys(row!.nested)).toEqual(["stays"]);
  });

  it("rejects an update naming one path in both $set and $unset, as real MongoDB does", async () => {
    const db = new FakeDb();
    await db.collection("probe").insertOne({ _id: "a", x: 1 });
    await expect(db.collection("probe").updateOne({ _id: "a" }, { $set: { x: 2 }, $unset: { x: "" } })).rejects.toThrow(
      /conflict at 'x'/,
    );
    // The row is untouched — the guard runs before any mutation.
    expect((await db.collection("probe").findOne({ _id: "a" }))!.x).toBe(1);
  });

  it("raises a duplicate-key error on a unique index, from insertOne and from an upserting updateOne", async () => {
    // D4 uses this error as its RACE DETECTOR, so it must exist on whichever
    // create idiom the ledger ends up using.
    const db = new FakeDb();
    await db.collection("probe").createIndex({ a: 1, b: 1 }, { unique: true });
    await db.collection("probe").insertOne({ a: 1, b: 2 });

    const insertErr = await db
      .collection("probe")
      .insertOne({ a: 1, b: 2 })
      .catch((e) => e);
    expect(isDuplicateKey(insertErr)).toBe(true);

    const upsertErr = await db
      .collection("probe")
      .updateOne({ a: 1, b: 2, other: "x" }, { $set: { n: 1 } }, { upsert: true })
      .catch((e) => e);
    expect(isDuplicateKey(upsertErr)).toBe(true);

    // A non-conflicting write on the same index still succeeds, and a
    // collection with no unique index is unaffected.
    await db.collection("probe").insertOne({ a: 1, b: 3 });
    await db.collection("other").insertOne({ a: 1, b: 2 });
    await db.collection("other").insertOne({ a: 1, b: 2 });
    expect(db.collection("probe").rows.length).toBe(2);
    expect(db.collection("other").rows.length).toBe(2);
  });

  it("supports $lt/$lte/$gt/$gte with ObjectId string-coercion, and nothing else", async () => {
    const db = new FakeDb();
    for (const n of [1, 2, 3]) await db.collection("probe").insertOne({ n });
    const ids = db
      .collection("probe")
      .rows.map((r) => r._id)
      .sort((x, y) => (String(x) < String(y) ? -1 : 1));

    // The ingest page-scan filter's exact shape: an ObjectId cursor compared
    // against stored ObjectIds, both String-coerced the way `compare()` does.
    const after = await db
      .collection("probe")
      .find({ _id: { $gt: ids[0] } })
      .toArray();
    expect(after.length).toBe(2);

    const bounded = await db
      .collection("probe")
      .find({ n: { $gt: 1, $lte: 3 } })
      .toArray();
    expect(bounded.map((r: { n: number }) => r.n).sort()).toEqual([2, 3]);
    expect(await db.collection("probe").countDocuments({ n: { $gte: 3 } })).toBe(1);
    expect(await db.collection("probe").countDocuments({ n: { $lt: 2 } })).toBe(1);

    // Every other operator stays loud, per the double's original design.
    await expect(db.collection("probe").findOne({ n: { $in: [1] } })).rejects.toThrow("unsupported_filter_$in");
  });
});
