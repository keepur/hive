import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createScheduleMcpServer } from "../schedule/schedule-mcp-server.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { ActivityLogger } from "../activity/activity-logger.js";
import { ObligationStore } from "./store.js";
import { ReceiptStore, reconcileReceipt } from "./receipts.js";
import { ObligationRuntime } from "./runtime.js";
import { registrationSchema } from "./types.js";
import { definition, DUE, KEY, COLLECTION, REGISTRY, harness } from "./testing/harness.js";

vi.mock("../config.js", () => ({
  config: {
    scheduler: { heartbeatIntervalMs: 60_000 },
    events: { retentionDays: 7 },
    team: { enabled: false },
    activity: { enabled: false, retentionDays: 1 },
  },
}));
function gate() {
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    block: async () => {
      reached();
      await waiting;
    },
  };
}
async function pendingHistory() {
  const h = await harness(),
    e = h.engine();
  h.at("2026-09-07T07:00:00Z");
  h.fake.failNext("activity_log", "insertOne");
  await h.send(e.delivery);
  expect((await h.store.occurrence(KEY)).acknowledgement?.receiptWriteState).toBe("pending");
  return h;
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("obligation fault boundaries", () => {
  it.each(["admission", "transfer", "acknowledgement", "receipt", "marker"] as const)(
    "local-only %s visibility never supplies durable send or success authority",
    async (stage) => {
      const h = await harness(),
        e = h.engine();
      h.at("2026-09-07T07:00:00Z");
      const name = stage === "admission" ? REGISTRY : stage === "receipt" ? "activity_log" : COLLECTION;
      const operation = stage === "admission" ? "updateOne" : stage === "receipt" ? "insertOne" : "replaceOne";
      const offset = h.fake.operations.length;
      h.fake.localTimeoutNext(name, operation, (ctx) => {
        if (stage === "admission") return Boolean(ctx.update?.$set?.deliveryAdmission);
        if (stage === "transfer") return ctx.document?.delivery?.state === "sending";
        if (stage === "acknowledgement") return ctx.document?.delivery?.state === "acknowledged";
        if (stage === "marker") return ctx.document?.acknowledgement?.receiptWriteState === "persisted";
        return true;
      });
      expect(await h.send(e.delivery)).not.toMatchObject({ state: "confirmed_delivery" });
      const posts = stage === "admission" || stage === "transfer" ? 0 : 1;
      expect(h.submitted).toHaveLength(posts);
      const production = h.fake.operations.slice(offset);
      for (const op of production.filter(
        (v) => v.operation === "findOne" && [REGISTRY, COLLECTION, "activity_log"].includes(v.collection),
      )) {
        expect(op.context.options).toMatchObject({
          readConcern: { level: "majority" },
          readPreference: "primary",
          maxTimeMS: 5000,
        });
      }
      const writes = production.filter((v) => v.operation === operation && v.collection === name);
      expect(writes.length).toBeGreaterThan(0);
      for (const op of writes)
        expect(op.context.options).toMatchObject({ writeConcern: { w: "majority", wtimeoutMS: 5000 } });
      const filter =
        stage === "receipt" ? { receiptId: KEY + "/receipt" } : { _id: stage === "admission" ? "demo" : KEY };
      const local = await h.fake.collection(name).findOne(filter);
      const durable = await h.fake.collection(name).findOne(filter, { readConcern: { level: "majority" } });
      expect(local).not.toEqual(durable);
      if (stage === "receipt") expect(durable).toBeNull();
      if (stage === "marker") expect(durable?.acknowledgement.receiptWriteState).toBe("pending");
      h.fake.rollbackLocal(name);
      await e.sweeper.sweepOnce();
      expect(h.submitted).toHaveLength(posts);
      if (stage === "transfer" || stage === "acknowledgement")
        expect((await h.store.occurrence(KEY)).delivery.state).toBe("unknown");
      expect((await h.store.get("demo"))!.deliveryAdmission).toBeUndefined();
    },
  );
  it("a later majority commit of an uncertain admission is recovered without submission", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    h.fake.localTimeoutNext(REGISTRY, "updateOne", (ctx) => Boolean(ctx.update?.$set?.deliveryAdmission));
    await h.send(e.delivery);
    expect((await h.store.get("demo"))!.deliveryAdmission).toBeUndefined();
    h.fake.commitLocal(REGISTRY);
    const token = (await h.store.get("demo"))!.deliveryAdmission!.claimToken;
    await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).delivery).toMatchObject({ state: "unknown", claimToken: token });
    expect((await h.store.get("demo"))!.deliveryAdmission).toBeUndefined();
    expect(h.submitted).toHaveLength(0);
  });
  it.each(["read", "transfer"] as const)(
    "recovers an ended same-boot %s failure and releases only that admission",
    async (stage) => {
      const h = await harness(),
        e = h.engine();
      h.at("2026-09-07T07:00:00Z");
      const admitted = h.fake.pause(REGISTRY, "updateOne", (ctx) => Boolean(ctx.update?.$set?.deliveryAdmission), true);
      const sending = h.send(e.delivery);
      await admitted.reached;
      const a = (await h.store.get("demo"))!.deliveryAdmission!;
      if (stage === "read") h.fake.failNext(COLLECTION, "findOne");
      else h.fake.failNext(COLLECTION, "replaceOne", false, (ctx) => ctx.document?.delivery?.state === "sending");
      admitted.release();
      expect(await sending).toMatchObject({ state: "delivery_outcome_unknown" });
      expect(h.store.activeDeliveries.has(a.claimToken)).toBe(false);
      await e.sweeper.sweepOnce();
      expect((await h.store.occurrence(KEY)).delivery).toMatchObject({ state: "unknown", claimToken: a.claimToken });
      expect((await h.store.get("demo"))!.deliveryAdmission).toBeUndefined();
      const release = h.fake.operations.find(
        (op) => op.collection === REGISTRY && op.context.update?.$unset?.deliveryAdmission !== undefined,
      );
      expect(release?.context.filter).toMatchObject({
        "deliveryAdmission.claimToken": a.claimToken,
        "deliveryAdmission.ownerBootId": e.bootId,
      });
      await h.send(e.delivery);
      expect(h.submitted).toHaveLength(0);
      h.at("2026-09-07T08:00:00.001Z");
      expect(await h.send(e.delivery, new Date("2026-09-08T08:00:00Z"))).toMatchObject({ state: "confirmed_delivery" });
      expect(h.submitted).toHaveLength(1);
    },
  );
  it("serializes concurrent pending repairs across distinct stores and recovers an exact duplicate insert", async () => {
    const h = await pendingHistory(),
      other = new ObligationStore(h.db),
      receipts = new ReceiptStore(h.db, 1);
    const original = (await h.store.occurrence(KEY)).acknowledgement!;
    const inserted = h.fake.pause("activity_log", "insertOne");
    const first = reconcileReceipt(h.store, h.receipts, KEY, h.clock, true);
    await inserted.reached;
    const operations = h.fake.operations.length;
    let finished = false;
    const second = reconcileReceipt(other, receipts, KEY, h.clock, true).finally(() => {
      finished = true;
    });
    await turn();
    expect(finished).toBe(false);
    expect(h.fake.operations).toHaveLength(operations);
    inserted.release();
    expect(await first).toMatchObject({ confirmed: true, history: "present" });
    expect(await second).toMatchObject({ confirmed: true, history: "present" });
    const o = await h.store.occurrence(KEY);
    expect(o.acknowledgement).toMatchObject({ receiptWriteState: "persisted", timestamp: original.timestamp });
    expect(h.receiptInserts()).toBe(2);
    expect(h.fake.collection("activity_log").rows.size).toBe(1);
    const row = structuredClone([...h.fake.collection("activity_log").rows.values()][0]);
    const before = h.fake.operations.length;
    // Directly exercise the primitive's duplicate-key branch; production
    // reconciliation cannot enter two inserts together because of the queue.
    await receipts.insert(o, o.acknowledgement!);
    expect(h.receiptInserts()).toBe(3);
    expect([...h.fake.collection("activity_log").rows.values()]).toEqual([row]);
    expect(h.fake.operations.slice(before)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: "activity_log",
          operation: "findOne",
          context: expect.objectContaining({
            filter: { recordKind: "delivery_receipt", receiptId: original.receiptId },
            options: expect.objectContaining({ readConcern: { level: "majority" } }),
          }),
        }),
      ]),
    );
    expect(h.submitted).toHaveLength(1);
  });
  it("samples retention after delayed eligibility reads and closes absent history before queued repair", async () => {
    const h = await pendingHistory(),
      other = new ObligationStore(h.db);
    const original = (await h.store.occurrence(KEY)).acknowledgement!;
    const read = h.fake.pause("activity_log", "findOne", (ctx) => ctx.filter?.receiptId === original.receiptId);
    const first = reconcileReceipt(h.store, h.receipts, KEY, h.clock, true);
    await read.reached;
    const second = reconcileReceipt(other, new ReceiptStore(h.db, 1), KEY, h.clock, true);
    const inserts = h.receiptInserts();
    h.at(new Date(original.timestamp.getTime() + 86400_000));
    read.release();
    await Promise.all([first, second]);
    expect((await h.store.occurrence(KEY)).acknowledgement).toMatchObject({
      receiptWriteState: "expired_unresolved",
      timestamp: original.timestamp,
    });
    expect(h.receiptInserts()).toBe(inserts);
    expect(h.submitted).toHaveLength(1);
  });
  it("a queued reconciler cannot recreate history after another publishes persisted and TTL removes it", async () => {
    const h = await pendingHistory(),
      other = new ObligationStore(h.db);
    const original = (await h.store.occurrence(KEY)).acknowledgement!;
    const marker = h.fake.pause(
      COLLECTION,
      "replaceOne",
      (ctx) => ctx.document?.acknowledgement?.receiptWriteState === "persisted",
      true,
    );
    const first = reconcileReceipt(h.store, h.receipts, KEY, h.clock, true);
    await marker.reached;
    const second = reconcileReceipt(other, new ReceiptStore(h.db, 1), KEY, h.clock, true);
    h.at(new Date(original.timestamp.getTime() + 86400_000));
    h.fake.collection("activity_log").rows.clear();
    const inserts = h.receiptInserts();
    marker.release();
    for (const result of await Promise.all([first, second]))
      expect(result).toMatchObject({ history: "expired", confirmed: true });
    expect(h.receiptInserts()).toBe(inserts);
    expect(h.fake.collection("activity_log").rows.size).toBe(0);
    expect((await h.store.occurrence(KEY)).acknowledgement).toMatchObject({
      receiptWriteState: "persisted",
      timestamp: original.timestamp,
    });
    expect(h.submitted).toHaveLength(1);
  });
  it("a submitted insert holds the queue through retention and preserves proof across CAS contention", async () => {
    const h = await pendingHistory(),
      other = new ObligationStore(h.db);
    const original = (await h.store.occurrence(KEY)).acknowledgement!;
    const insert = h.fake.pause("activity_log", "insertOne");
    const marker = h.fake.pause(
      COLLECTION,
      "replaceOne",
      (ctx) => ctx.document?.acknowledgement?.receiptWriteState === "persisted",
    );
    const first = reconcileReceipt(h.store, h.receipts, KEY, h.clock, true);
    await insert.reached;
    let finished = false;
    const second = reconcileReceipt(other, new ReceiptStore(h.db, 1), KEY, h.clock, true).finally(() => {
      finished = true;
    });
    h.at(new Date(original.timestamp.getTime() + 86400_000));
    await turn();
    expect(finished).toBe(false);
    insert.release();
    await marker.reached;
    const current = await h.store.occurrence(KEY);
    await h.store.cas(current, { checkAt: h.clock() }); // unrelated revision wins while insert proof is retained
    h.fake.collection("activity_log").rows.clear();
    marker.release();
    for (const result of await Promise.all([first, second]))
      expect(result).toMatchObject({ history: "expired", confirmed: true });
    expect((await h.store.occurrence(KEY)).acknowledgement).toMatchObject({
      receiptWriteState: "persisted",
      timestamp: original.timestamp,
    });
    expect(h.receiptInserts()).toBe(2);
    expect(h.submitted).toHaveLength(1);
  });
  it("counts future cancelled admissions and pending receipts beyond one recovery page", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    for (const kind of ["receipt", "admission"] as const)
      for (let i = 0; i < 102; i++) {
        const id = kind + "-" + String(i).padStart(3, "0");
        const d = await h.store.register({ ...definition, _id: id }, new Date("2026-09-07T06:00:00Z"));
        const o = await h.store.materialize(d, DUE);
        if (kind === "admission") await h.store.admit(o, e.bootId);
        else
          await h.store.cas(o, {
            delivery: {
              ...o.delivery,
              state: "acknowledged",
              claimToken: randomUUID(),
              ownerBootId: e.bootId,
              acknowledgedAt: h.clock(),
              providerMessageTs: id,
            },
            acknowledgement: {
              receiptId: o._id + "/receipt",
              providerMessageTs: id,
              acknowledgedAt: h.clock(),
              timestamp: h.clock(),
              receiptWriteState: "pending",
            },
            repairAt: h.clock(),
          });
        await h.store.deactivate(id, "cancel future", h.clock());
        await h.store.advance(d, h.clock());
      }
    await e.sweeper.sweepOnce();
    expect(await e.reader.heartbeat()).toMatchObject({
      state: "backlog",
      pendingAdmissions: 2,
      pendingRecoveryOccurrences: 2,
      pendingOccurrences: 0,
      backlogCount: 4,
    });
    await e.sweeper.sweepOnce();
    expect(await e.reader.heartbeat()).toMatchObject({
      state: "ok",
      pendingAdmissions: 0,
      pendingRecoveryOccurrences: 0,
      backlogCount: 0,
    });
    expect(h.submitted).toHaveLength(0);
    expect(h.receiptInserts()).toBe(102);
  }, 30_000);
  it("counts delayed recovery and clears obsolete terminal scheduling without reopening receipt state", async () => {
    const h = await pendingHistory(),
      e = h.engine();
    const o = await h.store.occurrence(KEY),
      delayed = new Date(h.clock().getTime() + 60_000);
    await h.store.cas(o, { repairAt: delayed });
    await e.sweeper.sweepOnce();
    expect(await e.reader.heartbeat()).toMatchObject({ state: "backlog", pendingRecoveryOccurrences: 1 });
    h.at(delayed);
    await e.sweeper.sweepOnce();
    const persisted = await h.store.occurrence(KEY);
    expect(persisted.acknowledgement?.receiptWriteState).toBe("persisted");
    const inserts = h.receiptInserts();
    await h.store.cas(persisted, { repairAt: h.clock() });
    await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).repairAt).toBeNull();
    expect((await h.store.occurrence(KEY)).acknowledgement).toEqual(persisted.acknowledgement);
    expect(h.receiptInserts()).toBe(inserts);
    expect(h.submitted).toHaveLength(1);
    expect(await e.reader.heartbeat()).toMatchObject({ state: "ok", pendingRecoveryOccurrences: 0 });
  });
  it.each(["store", "write_guard"] as const)(
    "ages a successful heartbeat to unknown during persistent %s failures",
    async (failure) => {
      const h = await harness(),
        e = h.engine();
      await e.sweeper.sweepOnce();
      const lastSuccess = h.clock();
      expect(await e.reader.heartbeat()).toMatchObject({
        state: "ok",
        stale: false,
        lastSuccessfulSweep: lastSuccess,
      });
      const telemetry = structuredClone([...h.fake.collection("telemetry").rows.values()]);
      if (failure === "write_guard") h.guard.engage("fixture");
      for (const elapsed of [30_000, 120_000, 120_001, 150_000]) {
        h.at(new Date(lastSuccess.getTime() + elapsed));
        if (failure === "store") h.fake.failNext(REGISTRY, "find");
        await e.sweeper.sweepOnce();
        const expected = {
          state: elapsed > 120_000 ? "unknown" : "ok",
          stale: elapsed > 120_000,
          lastSuccessfulSweep: lastSuccess,
          timestamp: lastSuccess,
        };
        expect(await e.reader.heartbeat()).toMatchObject(expected);
        expect(await e.reader.show("demo", { limit: 20 })).toMatchObject({ heartbeat: expected });
        expect([...h.fake.collection("telemetry").rows.values()]).toEqual(telemetry);
      }
      expect(h.submitted).toHaveLength(0);
    },
  );
  it("clears obsolete expired_unresolved scheduling without reopening its receipt write", async () => {
    const h = await pendingHistory(),
      e = h.engine();
    h.at("2026-09-08T07:00:00Z");
    await reconcileReceipt(h.store, h.receipts, KEY, h.clock, true);
    const terminal = await h.store.occurrence(KEY);
    expect(terminal.acknowledgement?.receiptWriteState).toBe("expired_unresolved");
    await h.store.cas(terminal, { repairAt: h.clock() });
    const inserts = h.receiptInserts();
    await e.sweeper.sweepOnce();
    const recovered = await h.store.occurrence(KEY);
    expect(recovered.repairAt).toBeNull();
    expect(recovered.acknowledgement).toEqual(terminal.acknowledgement);
    expect(h.receiptInserts()).toBe(inserts);
    expect(h.submitted).toHaveLength(1);
    expect(await e.reader.heartbeat()).toMatchObject({ pendingRecoveryOccurrences: 0 });
  });
  it("stop during the initial awaited sweep never installs a later timer", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness(),
        e = h.engine();
      const barrier = h.fake.pause(REGISTRY, "find");
      const starting = e.sweeper.start();
      await barrier.reached;
      const stopping = e.sweeper.stop();
      barrier.release();
      await Promise.all([starting, stopping]);
      expect(vi.getTimerCount()).toBe(0);
      const operations = h.fake.operations.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.fake.operations).toHaveLength(operations);
      expect(h.submitted).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["claim", "publication"] as const)(
    "recovers an abandoned same-boot notice after %s and cleanup failures",
    async (stage) => {
      const h = await harness(),
        e = h.engine();
      h.at(DUE);
      h.fake.failNext(
        COLLECTION,
        "replaceOne",
        stage === "claim",
        (ctx) => ctx.document?.notice?.state === (stage === "claim" ? "sending" : "acknowledged"),
      );
      h.fake.failNext(COLLECTION, "replaceOne", false, (ctx) => ctx.document?.notice?.state === "unknown");
      await e.sweeper.sweepOnce();
      const retained = (await h.store.occurrence(KEY)).notice!;
      expect(retained.state).toBe("sending");
      expect(h.store.activeNotices.size).toBe(0);
      expect(h.submitted).toHaveLength(stage === "claim" ? 0 : 1);
      await e.sweeper.sweepOnce();
      expect((await h.store.occurrence(KEY)).notice).toMatchObject({
        state: "unknown",
        intentId: retained.intentId,
        claimToken: retained.claimToken,
      });
      h.at("2026-09-07T08:02:00Z");
      await e.sweeper.sweepOnce();
      await e.sweeper.sweepOnce();
      expect(h.submitted).toHaveLength(stage === "claim" ? 0 : 1);
      expect(await e.reader.occurrenceView(await h.store.occurrence(KEY))).toMatchObject({ notified: false });
    },
  );
  it.each(["claim_return", "http"] as const)(
    "preserves a genuinely live same-boot notice paused at %s",
    async (phase) => {
      const h = await harness(),
        boot = randomUUID(),
        first = h.engine(boot);
      const other = new ObligationRuntime(h.db, 1, () => true, h.clock, boot, h.poster);
      h.at(DUE);
      const request = gate();
      if (phase === "http") h.beforeResponse(request.block);
      const claim =
        phase === "claim_return"
          ? h.fake.pause(COLLECTION, "replaceOne", (ctx) => ctx.document?.notice?.state === "sending", true)
          : undefined;
      const posting = first.sweeper.sweepOnce();
      if (claim) await claim.reached;
      else await request.entered;
      const retained = (await h.store.occurrence(KEY)).notice!;
      expect(other.store.activeNotices.has(retained.claimToken!)).toBe(true);
      await other.sweeper.sweepOnce();
      expect((await h.store.occurrence(KEY)).notice).toMatchObject({
        state: "sending",
        claimToken: retained.claimToken,
      });
      expect(h.submitted).toHaveLength(phase === "http" ? 1 : 0);
      if (claim) claim.release();
      else request.release();
      await posting;
      h.beforeResponse();
      expect((await h.store.occurrence(KEY)).notice).toMatchObject({
        state: "acknowledged",
        claimToken: retained.claimToken,
      });
      expect(other.store.activeNotices.size).toBe(0);
      expect(h.submitted).toHaveLength(1);
      await other.stop();
    },
  );
  it.each(["timestamp", "schemaVersion"] as const)(
    "invalid receipt %s reports evidence_integrity to reader and evaluation",
    async (field) => {
      const h = await harness(),
        e = h.engine();
      h.at("2026-09-07T07:00:00Z");
      await h.send(e.delivery);
      const row = [...h.fake.collection("activity_log").rows.values()][0]!;
      if (field === "timestamp") delete row.timestamp;
      else row.schemaVersion = 99;
      expect(await e.reader.occurrenceView(await h.store.occurrence(KEY))).toMatchObject({
        state: "integrity_or_storage_error",
        reason: "evidence_integrity",
        sendable: false,
      });
      h.at(DUE);
      await e.sweeper.sweepOnce();
      expect((await h.store.occurrence(KEY)).evaluation).toBe("integrity_error");
      expect((await h.store.occurrence(KEY)).notice).toBeUndefined();
      expect(h.submitted).toHaveLength(1);
    },
  );
  it("lost notice acknowledgement publication stays unknown across ticks/restart", async () => {
    const h = await harness(),
      e = h.engine();
    h.at(DUE);
    h.fake.failNext(COLLECTION, "replaceOne", false, (ctx) => ctx.document?.notice?.state === "acknowledged");
    await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).notice?.state).toBe("unknown");
    await e.sweeper.stop();
    const next = h.engine();
    h.at("2026-09-07T08:01:00Z");
    await next.sweeper.sweepOnce();
    await next.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(1);
    expect(await next.reader.occurrenceView(await h.store.occurrence(KEY))).toMatchObject({ notified: false });
  });
  it("guard engagement between durable claim and HTTP submission prevents the post", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    const barrier = h.fake.pause(
      REGISTRY,
      "updateOne",
      (ctx) => Boolean(ctx.update?.$unset?.deliveryAdmission !== undefined),
      true,
    );
    const sending = h.send(e.delivery);
    await barrier.reached;
    h.guard.engage("fixture");
    barrier.release();
    expect(await sending).toMatchObject({ state: "delivery_outcome_unknown" });
    expect(h.submitted).toHaveLength(0);
    h.guard.disengage();
    await e.sweeper.stop();
    const next = h.engine();
    await next.sweeper.sweepOnce();
    await h.send(next.delivery);
    expect(h.submitted).toHaveLength(0);
    expect((await h.store.occurrence(KEY)).delivery.state).toBe("unknown");
  });
  it("a failed overlapping sweep cannot interrupt another live notice claim", async () => {
    const h = await harness(),
      boot = randomUUID(),
      first = h.engine(boot),
      second = h.engine(boot);
    h.at(DUE);
    const barrier = gate();
    h.beforeResponse(barrier.block);
    const posting = first.sweeper.sweepOnce();
    await barrier.entered;
    const token = (await h.store.occurrence(KEY)).notice!.claimToken;
    h.fake.failNext(COLLECTION, "findOne");
    await second.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).notice).toMatchObject({ state: "sending", claimToken: token });
    barrier.release();
    await posting;
    h.beforeResponse();
    expect((await h.store.occurrence(KEY)).notice?.state).toBe("acknowledged");
    expect(h.submitted).toHaveLength(1);
  });
  it("receipt read failures at the deadline stay pending until a later successful evaluation", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    h.fake.failNext("activity_log", "insertOne");
    await h.send(e.delivery);
    h.at(DUE);
    h.fake.failNext("activity_log", "findOne"); // recovery lane
    h.fake.failNext("activity_log", "findOne"); // evaluation lane
    await e.sweeper.sweepOnce();
    const pending = await h.store.occurrence(KEY);
    expect(pending.evaluation).toBe("pending");
    expect(pending.evaluatedAt).toBeUndefined();
    expect(pending.notice).toBeUndefined();
    expect(h.submitted).toHaveLength(1);
    h.at("2026-09-07T08:01:00Z");
    await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).evaluation).toBe("on_time");
  });
  it.each(["receipt", "window", "notice"])("malformed %s evidence is explicit and never successful", async (field) => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    await h.send(e.delivery);
    if (field === "receipt") {
      [...h.fake.collection("activity_log").rows.values()][0]!.destination.channelId = "C99999999";
      expect(await e.reader.occurrenceView(await h.store.occurrence(KEY))).toMatchObject({
        state: "integrity_or_storage_error",
        reason: "evidence_integrity",
        sendable: false,
      });
    } else {
      const row = h.fake.collection(COLLECTION).rows.get(KEY)!;
      if (field === "window") delete row.windowStart;
      else row.notice = { intentId: KEY + "/notice", state: "acknowledged" };
      await expect(e.reader.show("demo", { limit: 20 })).rejects.toThrow("evidence_integrity");
    }
    expect(h.submitted).toHaveLength(1);
  });
  it("shutdown rejects new calls and waits for the admitted receipt write", async () => {
    const h = await harness();
    h.at("2026-09-07T07:00:00Z");
    const runtime = new ObligationRuntime(h.db, 1, () => !h.guard.engaged, h.clock, randomUUID(), h.poster);
    await runtime.init();
    await runtime.start("fake", () => {});
    const barrier = h.fake.pause("activity_log", "insertOne");
    const sending = runtime.deliver("demo-producer", {
      obligationId: "demo",
      dueAt: DUE.toISOString(),
      text: "Complete",
    });
    await barrier.reached;
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(
      await runtime.deliver("demo-producer", { obligationId: "demo", dueAt: DUE.toISOString(), text: "Again" }),
    ).toMatchObject({ state: "unavailable" });
    barrier.release();
    await sending;
    await stopping;
    expect(stopped).toBe(true);
    expect((await h.store.occurrence(KEY)).acknowledgement?.receiptWriteState).toBe("persisted");
    expect(h.submitted).toHaveLength(1);
  });
  it("a persistently failing first definition cannot starve later pages", async () => {
    const h = await harness(),
      e = h.engine();
    for (let i = 0; i < 25; i++) {
      await h.store.register({ ...definition, _id: "demo-" + String(i).padStart(2, "0") }, h.clock());
    }
    h.at(DUE);
    for (let i = 0; i < 4; i++)
      h.fake.failNext(COLLECTION, "updateOne", false, (ctx) => ctx.update?.$setOnInsert?.obligationId === "demo");
    for (let i = 0; i < 4; i++) await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough).toEqual(new Date("2026-09-07T06:00:00Z"));
    expect((await h.store.get("demo-24"))!.scanThrough).toEqual(DUE);
    expect(h.submitted.some((post) => post.text?.includes("Obligation demo-24;"))).toBe(true);
  });
  it("retains multiple legacy rows, applies partial receipt uniqueness and never TTLs deduplication", async () => {
    const h = await harness(),
      e = h.engine();
    await h.fake.collection("activity_log").insertOne({ agentId: "x", timestamp: h.clock() });
    await h.fake.collection("activity_log").insertOne({ agentId: "y", timestamp: h.clock() });
    h.at("2026-09-07T07:00:00Z");
    await h.send(e.delivery);
    const receipt = [...h.fake.collection("activity_log").rows.values()].find(
      (r) => r.recordKind === "delivery_receipt",
    )!;
    const { _id, ...body } = receipt;
    void _id;
    await expect(h.fake.collection("activity_log").insertOne({ ...body, receiptId: "another" })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(
      h.fake.collection("activity_log").insertOne({ ...body, dueAt: new Date("2026-09-08T08:00:00Z") }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(h.fake.collection(REGISTRY).indexes.some((index) => "expireAfterSeconds" in index)).toBe(false);
    expect(h.fake.collection(COLLECTION).indexes.some((index) => "expireAfterSeconds" in index)).toBe(false);
    expect(await h.receipts.retentionMs()).toBe(86400_000);
  });
  it("initializes fresh receipt indexes even while turn logging is disabled", async () => {
    const h = await harness({ initialize: false });
    const logger = new ActivityLogger(h.db, {
      enabled: false,
      bufferSize: 1000,
      flushIntervalMs: 999999,
      retentionDays: 1,
    });
    await logger.connect();
    expect(h.fake.collection("activity_log").indexes).toHaveLength(1);
    const runtime = new ObligationRuntime(h.db, 1, () => true, h.clock, randomUUID(), h.poster);
    expect(
      await runtime.deliver("demo-producer", { obligationId: "demo", dueAt: DUE.toISOString(), text: "x" }),
    ).toMatchObject({ state: "unavailable" });
    await runtime.init();
    const indexes = h.fake.collection("activity_log").indexes;
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { timestamp: 1 }, expireAfterSeconds: 86400 }),
        expect.objectContaining({
          key: { receiptId: 1 },
          unique: true,
          partialFilterExpression: { recordKind: "delivery_receipt" },
        }),
        expect.objectContaining({
          key: { obligationId: 1, dueAt: 1 },
          unique: true,
          partialFilterExpression: { recordKind: "delivery_receipt" },
        }),
      ]),
    );
    await runtime.start("fake", () => {});
    h.at("2026-09-07T07:00:00Z");
    expect(
      await runtime.deliver("demo-producer", { obligationId: "demo", dueAt: DUE.toISOString(), text: "x" }),
    ).toMatchObject({ state: "confirmed_delivery" });
    expect(h.submitted).toHaveLength(1);
    await runtime.stop();
    await logger.stop();
  });
  it.each([REGISTRY, "activity_log"])(
    "%s index failure prevents readiness from an uninitialized database",
    async (name) => {
      const h = await harness({ initialize: false });
      const runtime = new ObligationRuntime(h.db, 1, () => true, h.clock, randomUUID(), h.poster);
      h.fake.failNext(name, "createIndex");
      await expect(runtime.init()).rejects.toThrow("injected");
      await expect(runtime.start("fake", () => {})).rejects.toThrow("not_initialized");
      expect(
        await runtime.deliver("demo-producer", { obligationId: "demo", dueAt: DUE.toISOString(), text: "x" }),
      ).toMatchObject({ state: "unavailable" });
      expect(h.fake.collection("activity_log").indexes).toHaveLength(1);
      expect(h.submitted).toHaveLength(0);
      await runtime.stop();
    },
  );
  it("leaves an incompatible existing timestamp TTL untouched and refuses readiness", async () => {
    const h = await harness({ initialize: false });
    await h.fake.collection("activity_log").createIndex({ timestamp: 1 }, { expireAfterSeconds: 172800 });
    const original = structuredClone(h.fake.collection("activity_log").indexes);
    const runtime = new ObligationRuntime(h.db, 1, () => true, h.clock, randomUUID(), h.poster);
    await expect(runtime.init()).rejects.toMatchObject({ code: 85 });
    expect(h.fake.collection("activity_log").indexes).toEqual(original);
    await expect(runtime.start("fake", () => {})).rejects.toThrow("not_initialized");
    expect(
      await runtime.deliver("demo-producer", { obligationId: "demo", dueAt: DUE.toISOString(), text: "x" }),
    ).toMatchObject({ state: "unavailable" });
    expect(h.submitted).toHaveLength(0);
    await runtime.stop();
  });
  it("registration rejects unknown producers and input fields without creating definitions", async () => {
    const h = await harness();
    const count = h.fake.collection(REGISTRY).rows.size;
    await expect(
      h.store.register({ ...definition, _id: "new", producerAgentId: "unknown" }, h.clock()),
    ).rejects.toThrow("unknown_producer");
    for (const input of [
      { ...definition, _id: "new", activeFrom: h.clock() },
      { ...definition, _id: "new", deliveryAdmission: {} },
      { ...definition, _id: "new", destination: { kind: "slack", channelId: "general" } },
      { ...definition, _id: "new", destination: { ...definition.destination, threadTs: "latest" } },
      { ...definition, _id: "new", destination: { ...definition.destination, threadTs: "1".repeat(94) + ".000001" } },
      {
        ...definition,
        _id: "new",
        noticeDestination: { ...definition.noticeDestination, threadTs: "1".repeat(94) + ".000001" },
      },
      { ...definition, _id: "new", noticeDestination: undefined },
    ]) {
      expect(registrationSchema.safeParse(input).success).toBe(false);
      await expect(h.store.register(input, h.clock())).rejects.toBeDefined();
    }
    expect(h.fake.collection(REGISTRY).rows.size).toBe(count);
  });
  it.each(["destination", "noticeDestination"] as const)(
    "enforces channel length boundaries and accepts the maximum thread length for %s",
    async (field) => {
      const h = await harness();
      for (const prefix of ["C", "D", "G"]) {
        for (const length of [9, 32]) {
          const destination = {
            kind: "slack",
            channelId: prefix + "A".repeat(length - 1),
            ...(length === 32 ? { threadTs: "1".repeat(93) + ".000001" } : {}),
          };
          const id = "boundary-" + prefix.toLowerCase() + "-" + length;
          await h.store.register({ ...definition, _id: id, [field]: destination }, h.clock());
          expect((await h.store.get(id))![field]).toEqual(destination);
        }
      }
      const before = h.snapshot(),
        writes = h.fake.writes();
      for (const length of [8, 33]) {
        await expect(
          h.store.register(
            {
              ...definition,
              _id: "invalid-boundary",
              [field]: { kind: "slack", channelId: "C" + "A".repeat(length - 1) },
            },
            h.clock(),
          ),
        ).rejects.toBeDefined();
      }
      expect(h.snapshot()).toEqual(before);
      expect(h.fake.writes()).toBe(writes);
      expect(h.submitted).toHaveLength(0);
    },
  );
  it("actual schedule removal and reload do not affect registered expectations", async () => {
    const h = await harness(),
      e = h.engine();
    await h.fake
      .collection("agent_definitions")
      .updateOne({ _id: "demo-producer" }, { $set: { schedule: [{ cron: "0 8 * * *", task: "demo-task" }] } });
    const server = createScheduleMcpServer({ db: h.db, agentId: "demo-producer" });
    const client = new Client({ name: "fixture", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    await client.connect(ct);
    try {
      const removed = await client.callTool({
        name: "my_schedule_remove",
        arguments: { task: "demo-task", reason: "fixture" },
      });
      expect(removed.isError).not.toBe(true);
      const rows = await h.fake.collection("agent_definitions").find().toArray();
      const scheduler = new Scheduler({} as never, {} as never, {} as never, { getAll: () => rows } as never);
      await scheduler.reloadSchedules();
      h.at(DUE);
      await e.sweeper.sweepOnce();
      expect(h.submitted).toHaveLength(1);
      expect((await h.store.get("demo"))!.deactivatedAt).toBeUndefined();
    } finally {
      await client.close();
      await server.instance.close();
    }
  });
  it("missing service reports unavailable through the real strict schedule server", async () => {
    const h = await harness();
    const server = createScheduleMcpServer({ db: h.db, agentId: "demo-producer" });
    const client = new Client({ name: "fixture", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st);
    await client.connect(ct);
    try {
      const result = await client.callTool({
        name: "deliver_obligation",
        arguments: {
          obligationId: "demo",
          dueAt: DUE.toISOString(),
          text: "complete",
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("unavailable");
      expect(h.submitted).toHaveLength(0);
    } finally {
      await client.close();
      await server.instance.close();
    }
  });
  it("clock rollback never regresses coverage or duplicates a deadline", async () => {
    const h = await harness(),
      e = h.engine();
    h.at(DUE);
    await e.sweeper.sweepOnce();
    const through = (await h.store.get("demo"))!.scanThrough;
    h.at("2026-09-07T05:00:00Z");
    await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough).toEqual(through);
    expect(h.submitted).toHaveLength(1);
    expect(h.fake.collection(COLLECTION).rows.size).toBe(1);
  });
});
