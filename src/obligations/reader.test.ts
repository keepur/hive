import { describe, expect, it } from "vitest";
import { harness, DUE, KEY, COLLECTION, REGISTRY } from "./testing/harness.js";
import { decodeCursor } from "./reader.js";
describe("read-only obligation views", () => {
  it("does not materialize, repair, index or send while showing current/backlog/history", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    const writes = h.fake.writes();
    const view = await e.reader.discover("demo-producer", { section: "definitions" });
    expect(JSON.stringify(view)).toContain(DUE.toISOString());
    expect(h.fake.writes()).toBe(writes);
    expect(h.submitted).toHaveLength(0);
    expect(await e.reader.discover("other", {})).toMatchObject({ definitions: [] });
    await expect(e.reader.show("unknown", { limit: 20 })).rejects.toThrow("unknown_obligation");
  });
  it("inspects pending initial history before and after retention without publishing or inserting", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    h.fake.failNext("activity_log", "insertOne");
    await h.send(e.delivery);
    expect((await h.store.occurrence(KEY)).acknowledgement?.receiptWriteState).toBe("pending");
    for (const expired of [false, true]) {
      if (expired) h.at("2026-09-09T07:00:00Z");
      const snapshot = h.snapshot(),
        writes = h.fake.writes(),
        inserts = h.receiptInserts(),
        posts = h.submitted.length;
      const definitions = await e.reader.discover("demo-producer", { section: "definitions" });
      const overdue = await e.reader.discover("demo-producer", { section: "overdue" });
      const shown = await e.reader.show("demo", { limit: 20 });
      for (const view of [definitions, overdue, shown]) expect(view).toMatchObject({ receiptRetentionMs: 86400_000 });
      expect(shown).toMatchObject({
        occurrences: [
          {
            history: expired ? "expired_unresolved" : "initial_write_pending",
            acknowledgement: { receiptWriteState: "pending" },
            sendable: false,
          },
        ],
      });
      expect(h.snapshot()).toEqual(snapshot);
      expect(h.fake.writes()).toBe(writes);
      expect(h.receiptInserts()).toBe(inserts);
      expect(h.submitted).toHaveLength(posts);
    }
  });
  it("reports observed retention even when it differs from the writer's configured value", async () => {
    const h = await harness(),
      e = h.engine();
    h.fake.collection("activity_log").indexes.find((index) => index.key.timestamp === 1)!.expireAfterSeconds = 172800;
    const before = h.snapshot();
    expect(await e.reader.discover("demo-producer", {})).toMatchObject({ receiptRetentionMs: 172800_000 });
    expect(await e.reader.show("demo", { limit: 20 })).toMatchObject({ receiptRetentionMs: 172800_000 });
    expect(h.snapshot()).toEqual(before);
  });
  it("renders the newly reconciled occurrence rather than the caller's stale snapshot", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    const stale = await h.store.materialize((await h.store.get("demo"))!, DUE);
    await h.send(e.delivery);
    expect(stale.delivery.state).toBe("pending");
    const before = h.snapshot();
    expect(await e.reader.occurrenceView(stale)).toMatchObject({
      delivery: { state: "acknowledged" },
      acknowledgement: { receiptWriteState: "persisted" },
      history: "present",
      sendable: false,
    });
    expect(h.snapshot()).toEqual(before);
    expect(h.submitted).toHaveLength(1);
  });
  it.each(["admission", "scanned_current"] as const)(
    "rejects missing required %s projection without fixing it",
    async (kind) => {
      const h = await harness(),
        e = h.engine();
      h.at(DUE);
      const d = (await h.store.get("demo"))!,
        o = await h.store.materialize(d, DUE);
      if (kind === "admission") await h.store.admit(o, e.bootId);
      else await h.store.advance(d, DUE);
      h.fake.collection(COLLECTION).rows.delete(KEY);
      const before = h.snapshot(),
        writes = h.fake.writes();
      await expect(e.reader.discover("demo-producer", { section: "definitions" })).rejects.toThrow(
        "evidence_integrity",
      );
      await expect(e.reader.show("demo", { limit: 20 })).rejects.toThrow("evidence_integrity");
      expect(h.snapshot()).toEqual(before);
      expect(h.fake.writes()).toBe(writes);
      expect(h.submitted).toHaveLength(0);
      if (kind === "admission") expect(h.fake.collection(REGISTRY).rows.get("demo")!.deliveryAdmission).toBeDefined();
    },
  );
  it("rejects invalid and cross-owner pagination cursors", () => {
    expect(() => decodeCursor("!!!", "overdue", "demo-producer")).toThrow("invalid_cursor");
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        section: "overdue",
        owner: "other",
        after: "x",
      }),
    ).toString("base64url");
    expect(() => decodeCursor(cursor, "overdue", "demo-producer")).toThrow("invalid_cursor");
  });
});
