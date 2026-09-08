import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ActivityLogger } from "../activity/activity-logger.js";
import { ReceiptStore, reconcileReceipt } from "./receipts.js";
import { ObligationStore } from "./store.js";
import { DeliveryService } from "./delivery.js";
import { SPEC_REFUSALS } from "./testing/refusals.js";
import { definition, DUE, KEY, COLLECTION, REGISTRY, harness } from "./testing/harness.js";

function expectNoRawPersistence(h: Awaited<ReturnType<typeof harness>>, marker: string): void {
  for (const collection of [REGISTRY, COLLECTION, "activity_log"]) {
    expect(JSON.stringify([...h.fake.collection(collection).rows.values()]), collection).not.toContain(marker);
  }
}

describe("delivery obligation assembly", () => {
  it("rejects extra nested registration fields before writing", async () => {
    const h = await harness();
    const writes = h.fake.writes();
    for (const field of ["deadline", "destination", "noticeDestination"] as const) {
      await expect(
        h.store.register(
          { ...definition, _id: "nested", [field]: { ...definition[field], unapproved: true } },
          h.clock(),
        ),
      ).rejects.toThrow();
    }
    expect(h.fake.collection(REGISTRY).rows.size).toBe(1);
    expect(h.fake.writes()).toBe(writes);
    expect(h.submitted).toHaveLength(0);
  });
  it("rejects malformed nested registry data and serialized or invalid persisted dates", async () => {
    const h = await harness();
    const original = (await h.store.get("demo"))!;
    const o = await h.store.materialize(original, DUE);
    const admission = (await h.store.admit(o, randomUUID()))!;
    const row = (await h.store.get("demo"))!;
    const writes = h.fake.writes();
    const invalidDates = [DUE.toISOString(), new Date(NaN)];
    const patches: Record<string, unknown>[] = [
      { deliveryAdmission: { ...admission, unapproved: true } },
      { deadline: { ...row.deadline, unapproved: true } },
      { destination: { ...row.destination, unapproved: true } },
      { noticeDestination: { ...row.noticeDestination, unapproved: true } },
    ];
    for (const invalid of invalidDates) {
      for (const field of ["activeFrom", "createdAt", "scanThrough", "deactivatedAt"]) {
        patches.push({ [field]: invalid });
      }
      patches.push({ deliveryAdmission: { ...admission, dueAt: invalid } });
    }
    for (const patch of patches) {
      h.fake.collection(REGISTRY).rows.set("demo", { ...row, ...patch });
      await expect(h.store.get("demo")).rejects.toThrow("evidence_integrity");
    }
    h.fake.collection(REGISTRY).rows.set("demo", { ...row, _id: 456 });
    await expect(h.store.definitionsPage({}, undefined, 20)).rejects.toThrow("evidence_integrity");
    h.fake.collection(REGISTRY).rows.set("demo", row);
    expect(h.fake.writes()).toBe(writes);
    expect(h.submitted).toHaveLength(0);
  });
  it("rejects extra nested occurrence and receipt fields and invalid checkpoint dates", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    await h.send(e.delivery);
    const o = await h.store.occurrence(KEY);
    const acknowledgement = o.acknowledgement!;
    const writes = h.fake.writes();
    const patches: Record<string, unknown>[] = [
      { definition: { ...o.definition, unapproved: true } },
      { definition: { ...o.definition, deadline: { ...o.definition.deadline, unapproved: true } } },
      { definition: { ...o.definition, destination: { ...o.definition.destination, unapproved: true } } },
      { definition: { ...o.definition, noticeDestination: { ...o.definition.noticeDestination, unapproved: true } } },
      { delivery: { ...o.delivery, unapproved: true } },
      { notice: { ...o.delivery, intentId: KEY + "/notice", unapproved: true } },
      { acknowledgement: { ...acknowledgement, unapproved: true } },
    ];
    for (const invalid of [DUE.toISOString(), new Date(NaN)]) {
      for (const field of ["dueAt", "windowStart", "activeFrom", "evaluatedAt", "checkAt", "repairAt"]) {
        patches.push({ [field]: invalid });
      }
      for (const field of ["startedAt", "acknowledgedAt", "retryAt"]) {
        patches.push({ delivery: { ...o.delivery, [field]: invalid } });
        patches.push({ notice: { ...o.delivery, intentId: KEY + "/notice", [field]: invalid } });
      }
      for (const field of ["acknowledgedAt", "timestamp"]) {
        patches.push({ acknowledgement: { ...acknowledgement, [field]: invalid } });
      }
    }
    for (const patch of patches) {
      h.fake.collection(COLLECTION).rows.set(KEY, { ...o, ...patch });
      await expect(h.store.occurrence(KEY)).rejects.toThrow("evidence_integrity");
    }
    h.fake.collection(COLLECTION).rows.set(KEY, { ...o, _id: 456 });
    await expect(h.store.occurrencesPage({}, undefined, 20)).rejects.toThrow("evidence_integrity");
    h.fake.collection(COLLECTION).rows.set(KEY, o);
    const receipt = [...h.fake.collection("activity_log").rows.values()][0]!;
    const receiptPatches: Record<string, unknown>[] = [
      { destination: { ...receipt.destination, unapproved: true } },
      { unapproved: true },
    ];
    for (const invalid of [DUE.toISOString(), new Date(NaN)]) {
      for (const field of ["dueAt", "acknowledgedAt", "timestamp"]) receiptPatches.push({ [field]: invalid });
    }
    for (const patch of receiptPatches) {
      h.fake.collection("activity_log").rows.set(receipt._id, { ...receipt, ...patch });
      await expect(h.receipts.exact(o, acknowledgement)).rejects.toThrow("evidence_integrity");
    }
    h.fake.collection("activity_log").rows.set(receipt._id, receipt);
    expect(h.fake.writes()).toBe(writes);
    expect(h.submitted).toHaveLength(1);
  });
  it("enforces registry IDs and occurrence compound uniqueness atomically", async () => {
    const h = await harness();
    const d = (await h.store.get("demo"))!;
    await expect(h.fake.collection(REGISTRY).insertOne({ ...d })).rejects.toMatchObject({ code: 11000 });
    const [first, second] = await Promise.all([h.store.materialize(d, DUE), h.store.materialize(d, DUE)]);
    expect(first).toEqual(second);
    expect(h.fake.collection(COLLECTION).rows.size).toBe(1);
    await expect(h.fake.collection(COLLECTION).insertOne({ ...first, _id: "another-key" })).rejects.toMatchObject({
      code: 11000,
    });
    const tomorrow = new Date("2026-09-08T08:00:00Z");
    await expect(h.fake.collection(COLLECTION).insertOne({ ...first, dueAt: tomorrow })).rejects.toMatchObject({
      code: 11000,
    });
    await h.store.materialize(d, tomorrow);
    expect(h.fake.collection(COLLECTION).rows.size).toBe(2);
    const revisions = await Promise.all([
      h.store.cas(first, { evaluatedAt: DUE }),
      h.store.cas(second, { evaluatedAt: tomorrow }),
    ]);
    expect(revisions.sort()).toEqual([false, true]);
    expect((await h.store.occurrence(KEY)).revision).toBe(1);
    expect(h.submitted).toHaveLength(0);
  });
  it("notices missing cron once, survives schedule deletion/producer removal/restart, and uses a new identity tomorrow", async () => {
    const h = await harness(),
      first = h.engine();
    h.at(DUE);
    await first.sweeper.sweepOnce();
    await first.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(1);
    const firstNotice = (await h.store.occurrence(KEY)).notice;
    expect(firstNotice?.state).toBe("acknowledged");
    expect(h.submitted[0]!.channel).toBe(definition.noticeDestination.channelId);
    expect(h.submitted[0]!.text).toContain("&lt;!channel&gt;");
    await h.fake
      .collection("agent_definitions")
      .updateOne(
        { _id: definition.producerAgentId },
        { $set: { schedule: [{ cron: "0 8 * * *", task: "x" }], enabled: false } },
      );
    await h.fake.collection("agent_definitions").deleteMany({ _id: definition.producerAgentId });
    await first.sweeper.stop();
    const restarted = h.engine();
    await restarted.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(1);
    expect((await h.store.occurrence(KEY)).notice?.intentId).toBe(firstNotice?.intentId);
    h.at("2026-09-08T08:00:00.000Z");
    await restarted.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(2);
    const second = await h.store.occurrence("demo/2026-09-08T08:00:00.000Z");
    expect(second.notice?.intentId).not.toBe(firstNotice?.intentId);
  });
  it("acknowledged on-time send persists exact allow-listed evidence and suppresses its notice", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00.000Z");
    expect(await h.send(e.delivery)).toMatchObject({ state: "confirmed_delivery", history: "present" });
    h.at(DUE);
    await e.sweeper.sweepOnce();
    const o = await h.store.occurrence(KEY);
    expect(o.evaluation).toBe("on_time");
    expect(o.notice).toBeUndefined();
    expect(h.submitted).toHaveLength(1);
    expect(h.echo).toHaveLength(1);
    const row = [...h.fake.collection("activity_log").rows.values()][0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "_id",
        "recordKind",
        "receiptId",
        "obligationId",
        "dueAt",
        "producerAgentId",
        "destination",
        "providerMessageTs",
        "acknowledgedAt",
        "timestamp",
        "schemaVersion",
      ].sort(),
    );
    expect(JSON.stringify(row)).not.toContain("Complete deliverable");
    expect(row.acknowledgedAt).toEqual(new Date("2026-09-07T07:00:00.000Z"));
  });
  it("works when turn logging is disabled, buffered, or drops a batch", async () => {
    const h = await harness(),
      e = h.engine();
    for (const enabled of [false, true]) {
      const logger = new ActivityLogger(h.db, { enabled, bufferSize: 1000, flushIntervalMs: 999999, retentionDays: 1 });
      await logger.connect();
      logger.record({ agentId: "demo-producer", timestamp: h.clock() } as never);
      if (enabled) await logger.flush(); // Fake intentionally has no insertMany: both writes reject, dropping the batch.
      await logger.stop();
    }
    h.at("2026-09-07T07:00:00Z");
    expect(await h.send(e.delivery)).toMatchObject({ state: "confirmed_delivery" });
    expect(h.receiptInserts()).toBe(1);
  });
  it("rejects identity/input/window/content violations before any post or occurrence", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    for (const extra of [
      { producerAgentId: "wrong" },
      { success: true },
      { destination: definition.destination },
      { acknowledgedAt: h.clock().toISOString() },
      { providerMessageTs: "1" },
    ]) {
      expect(
        await e.delivery.deliver("demo-producer", {
          obligationId: "demo",
          dueAt: DUE.toISOString(),
          text: "x",
          ...extra,
        }),
      ).toMatchObject({ state: "invalid_input" });
    }
    await expect(
      e.delivery.deliver("wrong", { obligationId: "demo", dueAt: DUE.toISOString(), text: "x" }),
    ).rejects.toThrow("wrong_producer");
    await expect(h.send(e.delivery, new Date("2026-09-08T08:00:00Z"))).rejects.toThrow("window_not_open");
    await expect(h.send(e.delivery, DUE, "x".repeat(3900))).rejects.toThrow("content_invalid");
    expect(await h.send(e.delivery, DUE, " ")).toMatchObject({ state: "invalid_input" });
    expect(h.submitted).toHaveLength(0);
    expect(h.fake.collection(COLLECTION).rows.size).toBe(0);
  });
  it.each([
    { boundary: "registration", dueAt: "2026-09-07T08:00:00.000Z", lower: "2026-09-07T06:00:00.000Z" },
    { boundary: "previous deadline", dueAt: "2026-09-08T08:00:00.000Z", lower: "2026-09-07T08:00:00.000Z" },
  ])("rejects a send exactly at the $boundary windowStart, then admits it at +1ms", async ({ dueAt, lower }) => {
    const h = await harness(),
      e = h.engine(),
      deadline = new Date(dueAt),
      windowStart = new Date(lower);
    h.at(windowStart);
    const snapshot = h.snapshot(),
      writes = h.fake.writes();
    await expect(h.send(e.delivery, deadline)).rejects.toThrow("window_not_open");
    expect(h.submitted).toHaveLength(0);
    expect(h.receiptInserts()).toBe(0);
    expect(h.fake.collection(COLLECTION).rows.size).toBe(0);
    expect((await h.store.get("demo"))!.deliveryAdmission).toBeUndefined();
    expect(h.snapshot()).toEqual(snapshot);
    expect(h.fake.writes()).toBe(writes);
    h.at(new Date(windowStart.getTime() + 1));
    expect(await h.send(e.delivery, deadline)).toMatchObject({ state: "confirmed_delivery", history: "present" });
    expect(h.submitted).toHaveLength(1);
    expect(h.receiptInserts()).toBe(1);
    expect(await h.store.occurrence("demo/" + dueAt)).toMatchObject({
      dueAt: deadline,
      windowStart,
      delivery: { state: "acknowledged" },
      acknowledgement: { acknowledgedAt: h.clock(), receiptWriteState: "persisted" },
    });
  });
  it("accepts exactly 3900 attributed characters as one complete post", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00.000Z");
    const attribution = "[demo-producer]\n",
      text = "x".repeat(3900 - attribution.length);
    expect(await h.send(e.delivery, DUE, text)).toMatchObject({ state: "confirmed_delivery", history: "present" });
    expect(h.submitted).toEqual([{ channel: definition.destination.channelId, text: attribution + text }]);
    expect(h.submitted[0]!.text).toHaveLength(3900);
    expect(h.receiptInserts()).toBe(1);
  });
  it("a late receipt cannot suppress the missed deadline or satisfy tomorrow", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T08:00:00.001Z");
    expect(await h.send(e.delivery)).toMatchObject({ state: "confirmed_delivery" });
    await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).evaluation).toBe("late");
    expect(h.submitted).toHaveLength(2);
    h.at("2026-09-08T08:00:00Z");
    await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(3);
  });
  it("turn success and unrelated/wrong-producer/destination/deadline receipts do not satisfy", async () => {
    for (const mismatch of ["producer", "destination", "dueAt", "turn", "unrelated"] as const) {
      const h = await harness(),
        e = h.engine();
      const row = {
        recordKind: "delivery_receipt",
        receiptId: "wrong",
        obligationId: mismatch === "unrelated" ? "other" : "demo",
        dueAt: mismatch === "dueAt" ? new Date("2026-09-08T08:00:00Z") : DUE,
        producerAgentId: mismatch === "producer" ? "other" : "demo-producer",
        destination: mismatch === "destination" ? { kind: "slack", channelId: "C99999999" } : definition.destination,
        providerMessageTs: "unrelated",
        acknowledgedAt: new Date("2026-09-07T07:00:00Z"),
        timestamp: h.clock(),
        schemaVersion: 1,
      };
      await h.fake
        .collection("activity_log")
        .insertOne(
          mismatch === "turn" ? { agentId: "demo-producer", timestamp: h.clock(), error: undefined, costUsd: 1 } : row,
        );
      h.at(DUE);
      await e.sweeper.sweepOnce();
      expect((await h.store.occurrence(KEY)).evaluation).not.toBe("on_time");
      expect(h.submitted).toHaveLength(1);
    }
  });
  it("races two senders and two live sweepers without duplicate submissions", async () => {
    const h = await harness(),
      boot = randomUUID(),
      a = h.engine(boot),
      b = h.engine(boot);
    h.at("2026-09-07T07:00:00Z");
    await Promise.all([h.send(a.delivery), h.send(b.delivery)]);
    expect(h.submitted).toHaveLength(1);
    h.at(DUE);
    await Promise.all([a.sweeper.sweepOnce(), b.sweeper.sweepOnce()]);
    expect(h.submitted).toHaveLength(1);
    h.at("2026-09-08T08:00:00Z");
    await Promise.all([a.sweeper.sweepOnce(), b.sweeper.sweepOnce()]);
    expect(h.submitted).toHaveLength(2);
  });
  it("deactivation wins after stale validation and prevents admission", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    const gate = h.fake.pause(REGISTRY, "updateOne", (ctx) => Boolean(ctx.update?.$set?.deliveryAdmission));
    const sending = h.send(e.delivery);
    await gate.reached;
    await h.store.deactivate("demo", "stop", h.clock());
    gate.release();
    await sending;
    expect(h.submitted).toHaveLength(0);
    h.at(DUE);
    await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(0);
  });
  it.each(["handoff", "request"] as const)(
    "an admitted attempt may finish after deactivation during %s",
    async (where) => {
      const h = await harness(),
        e = h.engine();
      h.at("2026-09-07T07:00:00Z");
      if (where === "handoff") {
        const gate = h.fake.pause(COLLECTION, "replaceOne", (ctx) => ctx.document?.delivery?.state === "sending");
        const sending = h.send(e.delivery);
        await gate.reached;
        await h.store.deactivate("demo", "stop", h.clock());
        gate.release();
        await sending;
      } else {
        h.beforeResponse(async () => {
          await h.store.deactivate("demo", "stop", h.clock());
        });
        await h.send(e.delivery);
        h.beforeResponse();
      }
      const o = await h.store.occurrence(KEY);
      expect(o.delivery.state).toBe("acknowledged");
      expect(o.acknowledgement?.receiptWriteState).toBe("persisted");
      h.at(DUE);
      await e.sweeper.sweepOnce();
      expect((await h.store.occurrence(KEY)).cancelled).toBe(true);
      expect(h.submitted).toHaveLength(1);
      expect(await h.send(e.delivery)).toMatchObject({ state: "confirmed_delivery", cancelled: true });
      expect(h.submitted).toHaveLength(1);
    },
  );
  it("deactivation after early acknowledgement retains facts; stale future materialization cannot resurrect an expectation", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    await h.send(e.delivery);
    const stale = (await h.store.get("demo"))!;
    const cutoff = await h.store.deactivate("demo", "first", h.clock());
    h.at("2026-09-07T07:30:00Z");
    expect((await h.store.deactivate("demo", "second", h.clock())).deactivatedAt).toEqual(cutoff.deactivatedAt);
    await h.store.materialize(stale, new Date("2026-09-08T08:00:00Z"));
    h.at("2026-09-08T08:00:00Z");
    await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(1);
    expect((await h.store.occurrence("demo/2026-09-08T08:00:00.000Z")).cancelled).toBe(true);
    expect((await h.store.occurrence(KEY)).delivery.state).toBe("acknowledged");
  });
  it("cutoff-equal and older deadlines remain due, discoverable and late-sendable", async () => {
    const h = await harness(),
      e = h.engine();
    h.at(DUE);
    await h.store.deactivate("demo", "stop", h.clock());
    await e.sweeper.sweepOnce();
    h.at("2026-09-07T09:00:00Z");
    const view = (await e.reader.discover("demo-producer", { section: "overdue", limit: 1 })) as {
      occurrences: unknown[];
    };
    expect(view.occurrences).toHaveLength(1);
    expect(view.occurrences[0]).toMatchObject({ dueAt: DUE, sendable: true });
    await h.send(e.delivery);
    await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).evaluation).toBe("late");
    expect(h.submitted).toHaveLength(2);
  });
  it("a rejected pre-cutoff future attempt cannot retry after deactivation", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    h.scripts.push({ body: { ok: false, error: "not_in_channel" } });
    expect(await h.send(e.delivery)).toMatchObject({ state: "rejected" });
    await h.store.deactivate("demo", "stop", h.clock());
    h.at("2026-09-07T07:01:00Z");
    await expect(h.send(e.delivery)).rejects.toThrow("expectation_cancelled");
    expect(h.submitted).toHaveLength(1);
  });
  it.each(SPEC_REFUSALS)("retries the approved %s refusal on delivery and notice paths", async (error) => {
    for (const side of ["delivery", "notice"] as const) {
      const h = await harness(),
        e = h.engine();
      h.at(side === "delivery" ? "2026-09-07T07:00:00Z" : DUE);
      h.scripts.push({ body: { ok: false, error } });
      const run = () => (side === "delivery" ? h.send(e.delivery) : e.sweeper.sweepOnce());
      await run();
      const first = await h.store.occurrence(KEY);
      const intent = side === "delivery" ? first.delivery : first.notice!;
      expect(intent.state).toBe("rejected");
      expect(h.accepted).toHaveLength(0);
      expect(h.receiptInserts()).toBe(0);
      await run();
      expect(h.submitted).toHaveLength(1);
      h.at(intent.retryAt!);
      await run();
      const last = await h.store.occurrence(KEY);
      expect(side === "delivery" ? last.delivery : last.notice).toMatchObject({
        state: "acknowledged",
        intentId: intent.intentId,
      });
      expect(h.submitted).toHaveLength(2);
      expect(h.accepted).toHaveLength(1);
      expect(h.receiptInserts()).toBe(side === "delivery" ? 1 : 0);
    }
  });
  it.each(["delivery", "notice"] as const)(
    "only authoritative %s refusal retries; same logical notice identity survives",
    async (side) => {
      const h = await harness(),
        e = h.engine();
      h.at(side === "delivery" ? "2026-09-07T07:00:00Z" : DUE);
      h.scripts.push({ body: { ok: false, error: "ratelimited" }, status: 429, retryAfter: "120" });
      if (side === "delivery") await h.send(e.delivery);
      else await e.sweeper.sweepOnce();
      const original = await h.store.occurrence(KEY);
      if (side === "delivery") await h.send(e.delivery);
      else await e.sweeper.sweepOnce();
      expect(h.submitted).toHaveLength(1);
      h.at(new Date(h.clock().getTime() + 120_000));
      if (side === "delivery") await h.send(e.delivery);
      else await e.sweeper.sweepOnce();
      expect(h.submitted).toHaveLength(2);
      expect(h.accepted).toHaveLength(1);
      if (side === "notice") expect((await h.store.occurrence(KEY)).notice?.intentId).toBe(original.notice?.intentId);
    },
  );
  it.each(["invalid_auth", "not_in_channel", "RAW_BODY_PRIVATE_DIAGNOSTIC_456"])(
    "never retries a non-JSON %s body synthesized by the SDK",
    async (rawBody) => {
      for (const side of ["delivery", "notice"] as const) {
        const h = await harness(),
          e = h.engine();
        h.at(side === "delivery" ? "2026-09-07T07:00:00Z" : DUE);
        h.scripts.push({ rawBody, accepted: true });
        if (side === "delivery")
          expect(await h.send(e.delivery)).toEqual({ state: "unknown", retryAt: undefined, retryAllowed: false });
        else await e.sweeper.sweepOnce();
        const original = await h.store.occurrence(KEY);
        expect(side === "delivery" ? original.delivery : original.notice).toMatchObject({
          state: "unknown",
          reason: "unconfirmed_response",
        });
        expectNoRawPersistence(h, rawBody);
        h.at(new Date(h.clock().getTime() + 120_000));
        for (let i = 0; i < 2; i++) {
          if (side === "delivery") await h.send(e.delivery);
          else await e.sweeper.sweepOnce();
        }
        await e.sweeper.stop();
        const next = h.engine();
        for (let i = 0; i < 2; i++) {
          if (side === "delivery")
            expect(await h.send(next.delivery)).toEqual({ state: "unknown", retryAt: undefined, retryAllowed: false });
          else await next.sweeper.sweepOnce();
        }
        expect(await next.reader.occurrenceView(await h.store.occurrence(KEY))).toMatchObject({
          [side]: { state: "unknown", reason: "unconfirmed_response" },
          acknowledgement: null,
          notified: false,
        });
        expectNoRawPersistence(h, rawBody);
        expect(h.submitted).toHaveLength(1);
        expect(h.accepted).toHaveLength(1);
        expect(h.receiptInserts()).toBe(0);
      }
    },
  );
  it.each(["internal_error", "fatal_error", "unrecognized_code", "timeout", "proxy"])(
    "never reposts ambiguous %s on either side across restart",
    async (error) => {
      for (const side of ["delivery", "notice"] as const) {
        const h = await harness(),
          e = h.engine();
        const rawMarker = "RAW_PRIVATE_456_" + side + "_" + error;
        h.at(side === "delivery" ? "2026-09-07T07:00:00Z" : DUE);
        if (error === "timeout")
          h.beforeResponse(async () => {
            throw new Error(rawMarker);
          });
        h.scripts.push(
          error === "timeout"
            ? { accepted: true }
            : {
                body: { ok: false, error, response_metadata: { messages: [rawMarker] } },
                status: error === "proxy" ? 502 : 200,
              },
        );
        if (side === "delivery")
          expect(await h.send(e.delivery)).toEqual({ state: "unknown", retryAt: undefined, retryAllowed: false });
        else await e.sweeper.sweepOnce();
        expectNoRawPersistence(h, rawMarker);
        await e.sweeper.stop();
        const restarted = h.engine();
        for (let i = 0; i < 3; i++) {
          if (side === "delivery")
            expect(await h.send(restarted.delivery)).toEqual({
              state: "unknown",
              retryAt: undefined,
              retryAllowed: false,
            });
          else await restarted.sweeper.sweepOnce();
        }
        expect(h.submitted).toHaveLength(1);
        const o = await h.store.occurrence(KEY);
        expect(side === "delivery" ? o.delivery : o.notice).toMatchObject({
          state: "unknown",
          reason: "unconfirmed_response",
        });
        expect(await restarted.reader.occurrenceView(o)).toMatchObject({
          [side]: { state: "unknown", reason: "unconfirmed_response" },
          acknowledgement: null,
          notified: false,
        });
        expectNoRawPersistence(h, rawMarker);
        expect(h.receiptInserts()).toBe(0);
      }
    },
  );
  it.each(["admission", "sending"] as const)(
    "recovers interrupted %s without a resend, including cancelled future expectations",
    async (phase) => {
      const h = await harness(),
        old = h.engine();
      h.at("2026-09-07T07:00:00Z");
      const o = await h.store.materialize((await h.store.get("demo"))!, DUE);
      const admission = (await h.store.admit(o, old.bootId))!;
      if (phase === "sending") await old.delivery.transfer(admission, "demo");
      await h.store.deactivate("demo", "stop", h.clock());
      await old.sweeper.stop();
      const next = h.engine();
      await next.sweeper.sweepOnce();
      expect((await h.store.occurrence(KEY)).delivery.state).toBe("unknown");
      expect((await h.store.get("demo"))!.deliveryAdmission).toBeUndefined();
      expect(h.submitted).toHaveLength(0);
    },
  );
  it("protects a real live invocation before and after transfer across same-Db wrappers", async () => {
    const h = await harness(),
      boot = randomUUID(),
      e = h.engine(boot);
    const otherStore = new ObligationStore(h.db),
      otherReceipts = new ReceiptStore(h.db, 1);
    const otherDelivery = new DeliveryService(otherStore, otherReceipts, h.poster, boot, h.clock, () => true);
    h.at("2026-09-07T07:00:00Z");
    const gate = h.fake.pause(COLLECTION, "replaceOne", (ctx) => ctx.document?.delivery?.state === "sending");
    const request = h.fake.pause(REGISTRY, "updateOne", (ctx) => ctx.update?.$unset?.deliveryAdmission !== undefined);
    const sending = h.send(e.delivery);
    await gate.reached;
    const admission = (await h.store.get("demo"))!.deliveryAdmission!;
    expect(otherStore.activeDeliveries.has(admission.claimToken)).toBe(true);
    await otherDelivery.recoverAdmission("demo", admission);
    await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.deliveryAdmission).toEqual(admission);
    expect((await h.store.occurrence(KEY)).delivery.state).toBe("pending");
    gate.release();
    await request.reached;
    await otherDelivery.recoverAdmission("demo", admission);
    await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).delivery).toMatchObject({
      state: "sending",
      claimToken: admission.claimToken,
    });
    request.release();
    expect(await sending).toMatchObject({ state: "confirmed_delivery" });
    expect(otherStore.activeDeliveries.size).toBe(0);
    expect(h.submitted).toHaveLength(1);
  });
  it("commit-then-throw admission/claim/acknowledgement writes resolve only by durable evidence", async () => {
    for (const stage of ["admission", "claim", "acknowledgement"] as const) {
      const h = await harness(),
        e = h.engine();
      h.at("2026-09-07T07:00:00Z");
      h.fake.failNext(
        stage === "admission" ? REGISTRY : COLLECTION,
        stage === "admission" ? "updateOne" : "replaceOne",
        true,
        (ctx) =>
          stage === "admission"
            ? Boolean(ctx.update?.$set?.deliveryAdmission)
            : ctx.document?.delivery?.state === (stage === "claim" ? "sending" : "acknowledged"),
      );
      expect(await h.send(e.delivery)).toMatchObject({ state: "confirmed_delivery" });
      expect(h.submitted).toHaveLength(1);
    }
  });
  it("lost acknowledgement checkpoint yields unknown and never reposts", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    h.fake.failNext(COLLECTION, "replaceOne", false, (ctx) => ctx.document?.delivery?.state === "acknowledged");
    expect(await h.send(e.delivery)).toMatchObject({ state: "delivery_outcome_unknown" });
    await h.send(e.delivery);
    await e.sweeper.stop();
    const next = h.engine();
    await next.sweeper.sweepOnce();
    await h.send(next.delivery);
    expect(h.submitted).toHaveLength(1);
    expect(h.receiptInserts()).toBe(0);
  });
  it.each(["insert", "marker", "insert_committed", "marker_committed"] as const)(
    "recovers receipt %s evidence with its original timestamp",
    async (stage) => {
      const h = await harness(),
        e = h.engine();
      h.at("2026-09-07T07:00:00Z");
      if (stage === "marker" || stage === "marker_committed")
        h.fake.failNext(
          COLLECTION,
          "replaceOne",
          stage === "marker_committed",
          (ctx) => ctx.document?.acknowledgement?.receiptWriteState === "persisted",
        );
      else h.fake.failNext("activity_log", "insertOne", stage === "insert_committed");
      await h.send(e.delivery);
      const original = (await h.store.occurrence(KEY)).acknowledgement!;
      const count = h.receiptInserts();
      await e.sweeper.stop();
      h.at("2026-09-07T07:10:00Z");
      const next = h.engine();
      await next.sweeper.sweepOnce();
      expect((await h.store.occurrence(KEY)).acknowledgement).toMatchObject({
        timestamp: original.timestamp,
        receiptWriteState: "persisted",
      });
      expect(h.receiptInserts()).toBe(count + (stage === "insert" ? 1 : 0));
      expect(h.submitted).toHaveLength(1);
    },
  );
  it("expired persisted history is never recreated by old tool calls or restart sweeps", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    await h.send(e.delivery);
    const original = (await h.store.occurrence(KEY)).acknowledgement!;
    h.fake.collection("activity_log").rows.clear();
    h.at("2026-09-09T07:00:00Z");
    await e.sweeper.stop();
    const next = h.engine();
    const count = h.receiptInserts();
    for (let i = 0; i < 3; i++) {
      expect(await h.send(next.delivery)).toMatchObject({
        state: "confirmed_delivery",
        history: "expired",
        acknowledgement: { receiptId: original.receiptId, timestamp: original.timestamp },
      });
    }
    expect(h.receiptInserts()).toBe(count);
    expect(h.submitted).toHaveLength(1);
    await next.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).evaluation).toBe("on_time");
    expect((await h.store.occurrence(KEY)).notice).toBeUndefined();
    expect(h.receiptInserts()).toBe(count);
  });
  it("expired absent pending history closes as evidence-incomplete without insertion", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    h.fake.failNext("activity_log", "insertOne");
    await h.send(e.delivery);
    const count = h.receiptInserts();
    h.at("2026-09-09T07:00:00Z");
    await e.sweeper.sweepOnce();
    const o = await h.store.occurrence(KEY);
    expect(o.acknowledgement?.receiptWriteState).toBe("expired_unresolved");
    expect(o.evaluation).toBe("evidence_incomplete");
    expect(h.receiptInserts()).toBe(count);
    expect(await h.send(e.delivery)).toMatchObject({
      history: "expired_unresolved",
      state: "delivery_evidence_incomplete",
    });
    expect(h.receiptInserts()).toBe(count);
  });
  it("missing pre-expiry history from a persisted checkpoint is an integrity error", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    await h.send(e.delivery);
    h.fake.collection("activity_log").rows.clear();
    await expect(reconcileReceipt(h.store, h.receipts, KEY, h.clock, true)).rejects.toThrow("evidence_integrity");
    expect(h.receiptInserts()).toBe(1);
  });
  it("receipt checkpoint publication defeats a stale notice CAS and retains corrections after submission", async () => {
    const h = await harness(),
      e = h.engine();
    h.at(DUE);
    const gate = h.fake.pause(COLLECTION, "replaceOne", (ctx) => ctx.document?.notice?.state === "sending");
    const sweep = e.sweeper.sweepOnce();
    await gate.reached;
    await h.send(e.delivery);
    gate.release();
    await sweep;
    expect(h.submitted).toHaveLength(1);
    expect((await h.store.occurrence(KEY)).evaluation).toBe("on_time");
    expect((await h.store.occurrence(KEY)).notice).toBeUndefined();
    const h2 = await harness(),
      e2 = h2.engine();
    h2.at(DUE);
    await e2.sweeper.sweepOnce(); // already submitted missed notice
    await h2.send(e2.delivery);
    await e2.sweeper.sweepOnce();
    expect((await h2.store.occurrence(KEY)).evaluation).toBe("on_time");
    expect((await h2.store.occurrence(KEY)).notice?.state).toBe("acknowledged");
    expect(h2.submitted).toHaveLength(2);
  });
  it("guard/read/write failures preserve pending work and never claim delivery", async () => {
    const h = await harness(),
      e = h.engine();
    h.guard.engage("test");
    h.at(DUE);
    await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(0);
    expect(await h.send(e.delivery)).toMatchObject({ state: "delivery_outcome_unknown" });
    h.guard.disengage();
    h.fake.failNext(COLLECTION, "updateOne");
    await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough).toEqual(new Date("2026-09-07T06:00:00Z"));
    await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(1);
    const telemetry = await h.fake.collection("telemetry").findOne({ kind: "delivery_obligations_stats" });
    expect(telemetry?.lastSuccessfulSweep).toBeInstanceOf(Date);
  });
  it("bounded catch-up resumes every overdue deadline without a cron", async () => {
    const h = await harness(),
      e = h.engine();
    h.at("2026-10-07T08:00:00Z");
    await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough < h.clock()).toBe(true);
    for (let i = 0; i < 40; i++) await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough).toEqual(h.clock());
    const rows = [...h.fake.collection(COLLECTION).rows.values()];
    expect(rows).toHaveLength(31);
    expect(new Set(rows.map((o) => o._id)).size).toBe(31);
    expect(h.submitted).toHaveLength(31);
    const view = (await e.reader.discover("demo-producer", { section: "overdue", limit: 3 })) as {
      occurrences: unknown[];
      nextCursor: string;
    };
    expect(view.occurrences).toHaveLength(3);
    expect(view.nextCursor).toBeTruthy();
    const page2 = (await e.reader.discover("demo-producer", {
      section: "overdue",
      limit: 3,
      cursor: view.nextCursor,
    })) as { occurrences: unknown[] };
    expect(page2.occurrences).toHaveLength(3);
    expect(page2.occurrences[0]).not.toEqual(view.occurrences[0]);
  });
});
