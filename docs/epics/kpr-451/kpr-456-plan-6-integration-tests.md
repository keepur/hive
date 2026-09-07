# KPR-456 plan chunk 6 — assembly, races, restart and CLI tests

Parent: [implementation plan](kpr-456-plan.md). Depends on the harness in chunk 5.

## Task 17: Shared real service assembly

**Create:** src/obligations/testing/harness.ts

- [ ] Add this code. No live provider, network, credential or Mongo process is used.

~~~typescript
import { randomUUID } from "node:crypto";
import { WriteGuard, guardDb } from "../../db/write-guard.js";
import { FakeDb } from "./fake-db.js";
import { ObligationStore } from "../store.js";
import { ReceiptStore } from "../receipts.js";
import { DeliveryService } from "../delivery.js";
import { ObligationSweeper } from "../sweeper.js";
import { ObligationReader } from "../reader.js";
import { SlackObligationPoster } from "../slack-post.js";
import type { Registration } from "../types.js";

export const COLLECTION = "delivery_obligation_occurrences";
export const REGISTRY = "delivery_obligations";
export const DUE = new Date("2026-09-07T08:00:00.000Z");
export const KEY = "demo/" + DUE.toISOString();
export const definition: Registration = {
  _id: "demo", deliverable: "Demo <@U00000001> <!channel>", producerAgentId: "demo-producer",
  deadline: { localTime: "08:00", weekdays: [0,1,2,3,4,5,6], timezone: "UTC" },
  destination: { kind: "slack", channelId: "C00000001" },
  noticeDestination: { kind: "slack", channelId: "C00000002" }, createdBy: "operator",
};
export type ResponseScript = {
  body?: unknown; rawBody?: string; status?: number; provenance?: boolean; accepted?: boolean; throws?: boolean; retryAfter?: string;
};
export async function harness(options: { instanceId?: string; dbName?: string; initialize?: boolean } = {}) {
  const instanceId = options.instanceId ?? "demo", dbName = options.dbName ?? "hive_" + instanceId;
  const fake = new FakeDb();
  const guard = new WriteGuard({ instanceId, dbName });
  const db = guardDb(fake.db, guard);
  let now = new Date("2026-09-07T06:00:00.000Z");
  const clock = () => new Date(now);
  const submitted: Array<{ channel: string | null; text: string | null }> = [];
  const accepted: Array<{ channel: string | null; text: string | null }> = [];
  const echo: Array<[string, string]> = [];
  const scripts: ResponseScript[] = [];
  let beforeResponse: (() => Promise<void>) | undefined;
  const poster = new SlackObligationPoster("fake-token", (channel, ts) => echo.push([channel, ts]),
    () => !guard.engaged, clock, async (_url, init) => {
      const params = new URLSearchParams(String(init?.body));
      const sent = { channel: params.get("channel"), text: params.get("text") };
      submitted.push(sent);
      const script = scripts.shift();
      const body = script?.body ?? { ok: true, channel: sent.channel, ts: String(submitted.length) + ".000001" };
      if (!script || script.accepted) accepted.push(sent);
      if (beforeResponse) await beforeResponse();
      if (script?.throws) throw new Error("simulated_timeout");
      const headers = new Headers({ "content-type": script?.rawBody === undefined ? "application/json" : "text/plain" });
      if (script?.provenance !== false) headers.set("x-slack-req-id", "fixture");
      if (script?.retryAfter) headers.set("retry-after", script.retryAfter);
      const response = new Response(script?.rawBody ?? JSON.stringify(body), { status: script?.status ?? 200, headers });
      Object.defineProperty(response, "url", { value: "https://slack.com/api/chat.postMessage" });
      return response;
    });
  await fake.collection("agent_definitions").insertOne({ _id: definition.producerAgentId, schedule: [] });
  await fake.collection("instance_identity").insertOne({
    _id: "identity_sentinel", schemaVersion: 1, instanceId, dbName,
    sentinelId: randomUUID(), stampedAt: clock(), stampedBy: { engineVersion: "test", hostname: "test", pid: 1 },
  });
  const store = new ObligationStore(db), receipts = new ReceiptStore(db, 1);
  if (options.initialize !== false) { await store.init(); await receipts.init(); }
  await store.register(definition, clock());
  function engine(bootId = randomUUID()) {
    const delivery = new DeliveryService(store, receipts, poster, bootId, clock, () => !guard.engaged);
    const sweeper = new ObligationSweeper(store, receipts, delivery, poster, bootId, clock, () => !guard.engaged);
    const reader = new ObligationReader(store, receipts, clock);
    return { delivery, sweeper, reader, bootId };
  }
  return {
    fake, guard, db, store, receipts, poster, submitted, accepted, echo, scripts, clock, engine,
    at: (value: Date | string) => { now = new Date(value); },
    beforeResponse: (hook?: () => Promise<void>) => { beforeResponse = hook; },
    send: (service: DeliveryService, dueAt = DUE, text = "Complete deliverable") =>
      service.deliver(definition.producerAgentId, { obligationId: "demo", dueAt: dueAt.toISOString(), text }),
    snapshot: () => structuredClone([...fake.collections].map(([name, collection]) =>
      ({ name, rows: [...collection.rows], indexes: collection.indexes }))),
    receiptInserts: () => fake.operations.filter((v) => v.collection === "activity_log" && v.operation === "insertOne").length,
  };
}
~~~

The pinned Slack SDK 8.1.1 serializes this text request as application/x-www-form-urlencoded; the fake decodes the actual outgoing body and never substitutes a pre-built request.

## Task 18: Critical local integration tests

**Create:** src/obligations/obligations.integration.test.ts

- [ ] Add these executable cases.

~~~typescript
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ActivityLogger } from "../activity/activity-logger.js";
import { ReceiptStore, reconcileReceipt } from "./receipts.js";
import { ObligationStore } from "./store.js";
import { DeliveryService } from "./delivery.js";
import { SPEC_REFUSALS } from "./testing/refusals.js";
import { definition, DUE, KEY, COLLECTION, REGISTRY, harness } from "./testing/harness.js";

describe("delivery obligation assembly", () => {
  it("notices missing cron once, survives schedule deletion/producer removal/restart, and uses a new identity tomorrow", async () => {
    const h = await harness(), first = h.engine();
    h.at(DUE); await first.sweeper.sweepOnce(); await first.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(1);
    const firstNotice = (await h.store.occurrence(KEY)).notice;
    expect(firstNotice?.state).toBe("acknowledged");
    expect(h.submitted[0]!.channel).toBe(definition.noticeDestination.channelId);
    expect(h.submitted[0]!.text).toContain("&lt;!channel&gt;");
    await h.fake.collection("agent_definitions").updateOne(
      { _id: definition.producerAgentId }, { $set: { schedule: [{ cron: "0 8 * * *", task: "x" }], enabled: false } },
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
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00.000Z");
    expect(await h.send(e.delivery)).toMatchObject({ state: "confirmed_delivery", history: "present" });
    h.at(DUE); await e.sweeper.sweepOnce();
    const o = await h.store.occurrence(KEY);
    expect(o.evaluation).toBe("on_time"); expect(o.notice).toBeUndefined();
    expect(h.submitted).toHaveLength(1); expect(h.echo).toHaveLength(1);
    const row = [...h.fake.collection("activity_log").rows.values()][0]!;
    expect(Object.keys(row).sort()).toEqual([
      "_id", "recordKind", "receiptId", "obligationId", "dueAt", "producerAgentId",
      "destination", "providerMessageTs", "acknowledgedAt", "timestamp", "schemaVersion",
    ].sort());
    expect(JSON.stringify(row)).not.toContain("Complete deliverable");
    expect(row.acknowledgedAt).toEqual(new Date("2026-09-07T07:00:00.000Z"));
  });
  it("works when turn logging is disabled, buffered, or drops a batch", async () => {
    const h = await harness(), e = h.engine();
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
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    for (const extra of [{ producerAgentId: "wrong" }, { success: true }, { destination: definition.destination },
      { acknowledgedAt: h.clock().toISOString() }, { providerMessageTs: "1" }]) {
      expect(await e.delivery.deliver("demo-producer", {
        obligationId: "demo", dueAt: DUE.toISOString(), text: "x", ...extra,
      })).toMatchObject({ state: "invalid_input" });
    }
    await expect(e.delivery.deliver("wrong", { obligationId: "demo", dueAt: DUE.toISOString(), text: "x" })).rejects.toThrow("wrong_producer");
    await expect(h.send(e.delivery, new Date("2026-09-08T08:00:00Z"))).rejects.toThrow("window_not_open");
    await expect(h.send(e.delivery, DUE, "x".repeat(3900))).rejects.toThrow("content_invalid");
    expect(await h.send(e.delivery, DUE, " ")).toMatchObject({ state: "invalid_input" });
    expect(h.submitted).toHaveLength(0);
    expect(h.fake.collection(COLLECTION).rows.size).toBe(0);
  });
  it("a late receipt cannot suppress the missed deadline or satisfy tomorrow", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T08:00:00.001Z");
    expect(await h.send(e.delivery)).toMatchObject({ state: "confirmed_delivery" });
    await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).evaluation).toBe("late");
    expect(h.submitted).toHaveLength(2);
    h.at("2026-09-08T08:00:00Z"); await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(3);
  });
  it("turn success and unrelated/wrong-producer/destination/deadline receipts do not satisfy", async () => {
    for (const mismatch of ["producer", "destination", "dueAt", "turn", "unrelated"] as const) {
      const h = await harness(), e = h.engine();
      const row = {
        recordKind: "delivery_receipt", receiptId: "wrong",
        obligationId: mismatch === "unrelated" ? "other" : "demo",
        dueAt: mismatch === "dueAt" ? new Date("2026-09-08T08:00:00Z") : DUE,
        producerAgentId: mismatch === "producer" ? "other" : "demo-producer",
        destination: mismatch === "destination" ? { kind: "slack", channelId: "C99999999" } : definition.destination,
        providerMessageTs: "unrelated", acknowledgedAt: new Date("2026-09-07T07:00:00Z"),
        timestamp: h.clock(), schemaVersion: 1,
      };
      await h.fake.collection("activity_log").insertOne(mismatch === "turn"
        ? { agentId: "demo-producer", timestamp: h.clock(), error: undefined, costUsd: 1 } : row);
      h.at(DUE); await e.sweeper.sweepOnce();
      expect((await h.store.occurrence(KEY)).evaluation).not.toBe("on_time");
      expect(h.submitted).toHaveLength(1);
    }
  });
  it("races two senders and two live sweepers without duplicate submissions", async () => {
    const h = await harness(), boot = randomUUID(), a = h.engine(boot), b = h.engine(boot);
    h.at("2026-09-07T07:00:00Z");
    await Promise.all([h.send(a.delivery), h.send(b.delivery)]);
    expect(h.submitted).toHaveLength(1);
    h.at(DUE); await Promise.all([a.sweeper.sweepOnce(), b.sweeper.sweepOnce()]);
    expect(h.submitted).toHaveLength(1);
    h.at("2026-09-08T08:00:00Z");
    await Promise.all([a.sweeper.sweepOnce(), b.sweeper.sweepOnce()]);
    expect(h.submitted).toHaveLength(2);
  });
  it("deactivation wins after stale validation and prevents admission", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    const gate = h.fake.pause(REGISTRY, "updateOne", (ctx) => Boolean(ctx.update?.$set?.deliveryAdmission));
    const sending = h.send(e.delivery);
    await gate.reached;
    await h.store.deactivate("demo", "stop", h.clock());
    gate.release(); await sending;
    expect(h.submitted).toHaveLength(0);
    h.at(DUE); await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(0);
  });
  it.each(["handoff", "request"] as const)("an admitted attempt may finish after deactivation during %s", async (where) => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    if (where === "handoff") {
      const gate = h.fake.pause(COLLECTION, "replaceOne", (ctx) => ctx.document?.delivery?.state === "sending");
      const sending = h.send(e.delivery);
      await gate.reached; await h.store.deactivate("demo", "stop", h.clock());
      gate.release(); await sending;
    } else {
      h.beforeResponse(async () => { await h.store.deactivate("demo", "stop", h.clock()); });
      await h.send(e.delivery); h.beforeResponse();
    }
    const o = await h.store.occurrence(KEY);
    expect(o.delivery.state).toBe("acknowledged");
    expect(o.acknowledgement?.receiptWriteState).toBe("persisted");
    h.at(DUE); await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).cancelled).toBe(true);
    expect(h.submitted).toHaveLength(1);
    expect(await h.send(e.delivery)).toMatchObject({ state: "confirmed_delivery", cancelled: true });
    expect(h.submitted).toHaveLength(1);
  });
  it("deactivation after early acknowledgement retains facts; stale future materialization cannot resurrect an expectation", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z"); await h.send(e.delivery);
    const stale = (await h.store.get("demo"))!;
    const cutoff = await h.store.deactivate("demo", "first", h.clock());
    h.at("2026-09-07T07:30:00Z");
    expect((await h.store.deactivate("demo", "second", h.clock())).deactivatedAt).toEqual(cutoff.deactivatedAt);
    await h.store.materialize(stale, new Date("2026-09-08T08:00:00Z"));
    h.at("2026-09-08T08:00:00Z"); await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(1);
    expect((await h.store.occurrence("demo/2026-09-08T08:00:00.000Z")).cancelled).toBe(true);
    expect((await h.store.occurrence(KEY)).delivery.state).toBe("acknowledged");
  });
  it("cutoff-equal and older deadlines remain due, discoverable and late-sendable", async () => {
    const h = await harness(), e = h.engine();
    h.at(DUE); await h.store.deactivate("demo", "stop", h.clock());
    await e.sweeper.sweepOnce();
    h.at("2026-09-07T09:00:00Z");
    const view = await e.reader.discover("demo-producer", { section: "overdue", limit: 1 }) as { occurrences: unknown[] };
    expect(view.occurrences).toHaveLength(1);
    expect(view.occurrences[0]).toMatchObject({ dueAt: DUE, sendable: true });
    await h.send(e.delivery); await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).evaluation).toBe("late");
    expect(h.submitted).toHaveLength(2);
  });
  it("a rejected pre-cutoff future attempt cannot retry after deactivation", async () => {
    const h = await harness(), e = h.engine();
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
      const h = await harness(), e = h.engine();
      h.at(side === "delivery" ? "2026-09-07T07:00:00Z" : DUE);
      h.scripts.push({ body: { ok: false, error } });
      const run = () => side === "delivery" ? h.send(e.delivery) : e.sweeper.sweepOnce();
      await run();
      const first = await h.store.occurrence(KEY);
      const intent = side === "delivery" ? first.delivery : first.notice!;
      expect(intent.state).toBe("rejected"); expect(h.accepted).toHaveLength(0);
      expect(h.receiptInserts()).toBe(0);
      await run(); expect(h.submitted).toHaveLength(1);
      h.at(intent.retryAt!); await run();
      const last = await h.store.occurrence(KEY);
      expect(side === "delivery" ? last.delivery : last.notice).toMatchObject({
        state: "acknowledged", intentId: intent.intentId,
      });
      expect(h.submitted).toHaveLength(2); expect(h.accepted).toHaveLength(1);
      expect(h.receiptInserts()).toBe(side === "delivery" ? 1 : 0);
    }
  });
  it.each(["delivery", "notice"] as const)("only authoritative %s refusal retries; same logical notice identity survives", async (side) => {
    const h = await harness(), e = h.engine();
    h.at(side === "delivery" ? "2026-09-07T07:00:00Z" : DUE);
    h.scripts.push({ body: { ok: false, error: "ratelimited" }, status: 429, retryAfter: "120" });
    if (side === "delivery") await h.send(e.delivery); else await e.sweeper.sweepOnce();
    const original = await h.store.occurrence(KEY);
    if (side === "delivery") await h.send(e.delivery); else await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(1);
    h.at(new Date(h.clock().getTime() + 120_000));
    if (side === "delivery") await h.send(e.delivery); else await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(2); expect(h.accepted).toHaveLength(1);
    if (side === "notice") expect((await h.store.occurrence(KEY)).notice?.intentId).toBe(original.notice?.intentId);
  });
  it.each(["invalid_auth", "not_in_channel"])("never retries a non-JSON %s body synthesized by the SDK", async (rawBody) => {
    for (const side of ["delivery", "notice"] as const) {
      const h = await harness(), e = h.engine();
      h.at(side === "delivery" ? "2026-09-07T07:00:00Z" : DUE);
      h.scripts.push({ rawBody, accepted: true });
      if (side === "delivery") await h.send(e.delivery); else await e.sweeper.sweepOnce();
      const original = await h.store.occurrence(KEY);
      expect(side === "delivery" ? original.delivery : original.notice).toMatchObject({ state: "unknown" });
      h.at(new Date(h.clock().getTime() + 120_000));
      for (let i = 0; i < 2; i++) {
        if (side === "delivery") await h.send(e.delivery); else await e.sweeper.sweepOnce();
      }
      await e.sweeper.stop(); const next = h.engine();
      for (let i = 0; i < 2; i++) {
        if (side === "delivery") await h.send(next.delivery); else await next.sweeper.sweepOnce();
      }
      expect(h.submitted).toHaveLength(1); expect(h.accepted).toHaveLength(1);
      expect(h.receiptInserts()).toBe(0);
    }
  });
  it.each(["internal_error", "fatal_error", "unrecognized_code", "timeout", "proxy"])("never reposts ambiguous %s on either side across restart", async (error) => {
    for (const side of ["delivery", "notice"]) {
      const h = await harness(), e = h.engine();
      h.at(side === "delivery" ? "2026-09-07T07:00:00Z" : DUE);
      h.scripts.push(error === "timeout" ? { throws: true, accepted: true } :
        { body: { ok: false, error }, status: error === "proxy" ? 502 : 200 });
      if (side === "delivery") await h.send(e.delivery); else await e.sweeper.sweepOnce();
      await e.sweeper.stop();
      const restarted = h.engine();
      for (let i = 0; i < 3; i++) {
        if (side === "delivery") await h.send(restarted.delivery); else await restarted.sweeper.sweepOnce();
      }
      expect(h.submitted).toHaveLength(1);
      const o = await h.store.occurrence(KEY);
      expect(side === "delivery" ? o.delivery.state : o.notice?.state).toBe("unknown");
    }
  });
  it.each(["admission", "sending"] as const)("recovers interrupted %s without a resend, including cancelled future expectations", async (phase) => {
    const h = await harness(), old = h.engine();
    h.at("2026-09-07T07:00:00Z");
    const o = await h.store.materialize((await h.store.get("demo"))!, DUE);
    const admission = (await h.store.admit(o, old.bootId))!;
    if (phase === "sending") await old.delivery.transfer(admission, "demo");
    await h.store.deactivate("demo", "stop", h.clock());
    await old.sweeper.stop();
    const next = h.engine(); await next.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).delivery.state).toBe("unknown");
    expect((await h.store.get("demo"))!.deliveryAdmission).toBeUndefined();
    expect(h.submitted).toHaveLength(0);
  });
  it("protects a real live invocation before and after transfer across same-Db wrappers", async () => {
    const h = await harness(), boot = randomUUID(), e = h.engine(boot);
    const otherStore = new ObligationStore(h.db), otherReceipts = new ReceiptStore(h.db, 1);
    const otherDelivery = new DeliveryService(otherStore, otherReceipts, h.poster, boot, h.clock, () => true);
    h.at("2026-09-07T07:00:00Z");
    const gate = h.fake.pause(COLLECTION, "replaceOne", (ctx) => ctx.document?.delivery?.state === "sending");
    const request = h.fake.pause(REGISTRY, "updateOne", (ctx) => ctx.update?.$unset?.deliveryAdmission !== undefined);
    const sending = h.send(e.delivery); await gate.reached;
    const admission = (await h.store.get("demo"))!.deliveryAdmission!;
    expect(otherStore.activeDeliveries.has(admission.claimToken)).toBe(true);
    await otherDelivery.recoverAdmission("demo", admission); await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.deliveryAdmission).toEqual(admission);
    expect((await h.store.occurrence(KEY)).delivery.state).toBe("pending");
    gate.release(); await request.reached;
    await otherDelivery.recoverAdmission("demo", admission); await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).delivery).toMatchObject({ state: "sending", claimToken: admission.claimToken });
    request.release(); expect(await sending).toMatchObject({ state: "confirmed_delivery" });
    expect(otherStore.activeDeliveries.size).toBe(0); expect(h.submitted).toHaveLength(1);
  });
  it("commit-then-throw admission/claim/acknowledgement writes resolve only by durable evidence", async () => {
    for (const stage of ["admission", "claim", "acknowledgement"] as const) {
      const h = await harness(), e = h.engine();
      h.at("2026-09-07T07:00:00Z");
      h.fake.failNext(stage === "admission" ? REGISTRY : COLLECTION, stage === "admission" ? "updateOne" : "replaceOne",
        true, (ctx) => stage === "admission" ? Boolean(ctx.update?.$set?.deliveryAdmission)
          : ctx.document?.delivery?.state === (stage === "claim" ? "sending" : "acknowledged"));
      expect(await h.send(e.delivery)).toMatchObject({ state: "confirmed_delivery" });
      expect(h.submitted).toHaveLength(1);
    }
  });
  it("lost acknowledgement checkpoint yields unknown and never reposts", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    h.fake.failNext(COLLECTION, "replaceOne", false, (ctx) => ctx.document?.delivery?.state === "acknowledged");
    expect(await h.send(e.delivery)).toMatchObject({ state: "delivery_outcome_unknown" });
    await h.send(e.delivery); await e.sweeper.stop();
    const next = h.engine(); await next.sweeper.sweepOnce(); await h.send(next.delivery);
    expect(h.submitted).toHaveLength(1); expect(h.receiptInserts()).toBe(0);
  });
  it.each(["insert", "marker", "insert_committed", "marker_committed"] as const)("recovers receipt %s evidence with its original timestamp", async (stage) => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    if (stage === "marker" || stage === "marker_committed") h.fake.failNext(COLLECTION, "replaceOne", stage === "marker_committed",
      (ctx) => ctx.document?.acknowledgement?.receiptWriteState === "persisted");
    else h.fake.failNext("activity_log", "insertOne", stage === "insert_committed");
    await h.send(e.delivery);
    const original = (await h.store.occurrence(KEY)).acknowledgement!;
    const count = h.receiptInserts();
    await e.sweeper.stop(); h.at("2026-09-07T07:10:00Z");
    const next = h.engine(); await next.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).acknowledgement).toMatchObject({
      timestamp: original.timestamp, receiptWriteState: "persisted",
    });
    expect(h.receiptInserts()).toBe(count + (stage === "insert" ? 1 : 0));
    expect(h.submitted).toHaveLength(1);
  });
  it("expired persisted history is never recreated by old tool calls or restart sweeps", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z"); await h.send(e.delivery);
    const original = (await h.store.occurrence(KEY)).acknowledgement!;
    h.fake.collection("activity_log").rows.clear(); h.at("2026-09-09T07:00:00Z");
    await e.sweeper.stop(); const next = h.engine();
    const count = h.receiptInserts();
    for (let i = 0; i < 3; i++) {
      expect(await h.send(next.delivery)).toMatchObject({
        state: "confirmed_delivery", history: "expired",
        acknowledgement: { receiptId: original.receiptId, timestamp: original.timestamp },
      });
    }
    expect(h.receiptInserts()).toBe(count); expect(h.submitted).toHaveLength(1);
    await next.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).evaluation).toBe("on_time");
    expect((await h.store.occurrence(KEY)).notice).toBeUndefined();
    expect(h.receiptInserts()).toBe(count);
  });
  it("expired absent pending history closes as evidence-incomplete without insertion", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z"); h.fake.failNext("activity_log", "insertOne");
    await h.send(e.delivery); const count = h.receiptInserts();
    h.at("2026-09-09T07:00:00Z"); await e.sweeper.sweepOnce();
    const o = await h.store.occurrence(KEY);
    expect(o.acknowledgement?.receiptWriteState).toBe("expired_unresolved");
    expect(o.evaluation).toBe("evidence_incomplete");
    expect(h.receiptInserts()).toBe(count);
    expect(await h.send(e.delivery)).toMatchObject({ history: "expired_unresolved", state: "delivery_evidence_incomplete" });
    expect(h.receiptInserts()).toBe(count);
  });
  it("missing pre-expiry history from a persisted checkpoint is an integrity error", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z"); await h.send(e.delivery);
    h.fake.collection("activity_log").rows.clear();
    await expect(reconcileReceipt(h.store, h.receipts, KEY, h.clock, true)).rejects.toThrow("evidence_integrity");
    expect(h.receiptInserts()).toBe(1);
  });
  it("receipt checkpoint publication defeats a stale notice CAS and retains corrections after submission", async () => {
    const h = await harness(), e = h.engine();
    h.at(DUE);
    const gate = h.fake.pause(COLLECTION, "replaceOne", (ctx) => ctx.document?.notice?.state === "sending");
    const sweep = e.sweeper.sweepOnce(); await gate.reached;
    await h.send(e.delivery); gate.release(); await sweep;
    expect(h.submitted).toHaveLength(1);
    expect((await h.store.occurrence(KEY)).evaluation).toBe("on_time");
    expect((await h.store.occurrence(KEY)).notice).toBeUndefined();
    const h2 = await harness(), e2 = h2.engine();
    h2.at(DUE); await e2.sweeper.sweepOnce(); // already submitted missed notice
    await h2.send(e2.delivery); await e2.sweeper.sweepOnce();
    expect((await h2.store.occurrence(KEY)).evaluation).toBe("on_time");
    expect((await h2.store.occurrence(KEY)).notice?.state).toBe("acknowledged");
    expect(h2.submitted).toHaveLength(2);
  });
  it("guard/read/write failures preserve pending work and never claim delivery", async () => {
    const h = await harness(), e = h.engine();
    h.guard.engage("test"); h.at(DUE);
    await e.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(0);
    expect(await h.send(e.delivery)).toMatchObject({ state: "delivery_outcome_unknown" });
    h.guard.disengage();
    h.fake.failNext(COLLECTION, "updateOne");
    await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough).toEqual(new Date("2026-09-07T06:00:00Z"));
    await e.sweeper.sweepOnce(); expect(h.submitted).toHaveLength(1);
    const telemetry = await h.fake.collection("telemetry").findOne({ kind: "delivery_obligations_stats" });
    expect(telemetry?.lastSuccessfulSweep).toBeInstanceOf(Date);
  });
  it("bounded catch-up resumes every overdue deadline without a cron", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-10-07T08:00:00Z");
    await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough < h.clock()).toBe(true);
    for (let i = 0; i < 40; i++) await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough).toEqual(h.clock());
    const rows = [...h.fake.collection(COLLECTION).rows.values()];
    expect(rows).toHaveLength(31);
    expect(new Set(rows.map((o) => o._id)).size).toBe(31);
    expect(h.submitted).toHaveLength(31);
    const view = await e.reader.discover("demo-producer", { section: "overdue", limit: 3 }) as { occurrences: unknown[]; nextCursor: string };
    expect(view.occurrences).toHaveLength(3); expect(view.nextCursor).toBeTruthy();
    const page2 = await e.reader.discover("demo-producer", { section: "overdue", limit: 3, cursor: view.nextCursor }) as { occurrences: unknown[] };
    expect(page2.occurrences).toHaveLength(3);
    expect(page2.occurrences[0]).not.toEqual(view.occurrences[0]);
  });
});
~~~

## Task 19: Read-only, CLI and provider boundary assertions

The remaining tests below use the same production stores and SDK transport; they are not waived because Task 18 is comprehensive.

**Create:** src/obligations/reader.test.ts

- [ ] Add this complete reader test file.

~~~typescript
import { describe, expect, it } from "vitest";
import { harness, DUE, KEY, COLLECTION, REGISTRY } from "./testing/harness.js";
import { decodeCursor } from "./reader.js";
describe("read-only obligation views", () => {
  it("does not materialize, repair, index or send while showing current/backlog/history", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    const writes = h.fake.writes();
    const view = await e.reader.discover("demo-producer", { section: "definitions" });
    expect(JSON.stringify(view)).toContain(DUE.toISOString());
    expect(h.fake.writes()).toBe(writes); expect(h.submitted).toHaveLength(0);
    expect(await e.reader.discover("other", {})).toMatchObject({ definitions: [] });
    await expect(e.reader.show("unknown", { limit: 20 })).rejects.toThrow("unknown_obligation");
  });
  it("inspects pending initial history before and after retention without publishing or inserting", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z"); h.fake.failNext("activity_log", "insertOne");
    await h.send(e.delivery);
    expect((await h.store.occurrence(KEY)).acknowledgement?.receiptWriteState).toBe("pending");
    for (const expired of [false, true]) {
      if (expired) h.at("2026-09-09T07:00:00Z");
      const snapshot = h.snapshot(), writes = h.fake.writes(), inserts = h.receiptInserts(), posts = h.submitted.length;
      const definitions = await e.reader.discover("demo-producer", { section: "definitions" });
      const overdue = await e.reader.discover("demo-producer", { section: "overdue" });
      const shown = await e.reader.show("demo", { limit: 20 });
      for (const view of [definitions, overdue, shown]) expect(view).toMatchObject({ receiptRetentionMs: 86400_000 });
      expect(shown).toMatchObject({ occurrences: [{
        history: expired ? "expired_unresolved" : "initial_write_pending",
        acknowledgement: { receiptWriteState: "pending" }, sendable: false,
      }] });
      expect(h.snapshot()).toEqual(snapshot); expect(h.fake.writes()).toBe(writes);
      expect(h.receiptInserts()).toBe(inserts); expect(h.submitted).toHaveLength(posts);
    }
  });
  it("reports observed retention even when it differs from the writer's configured value", async () => {
    const h = await harness(), e = h.engine();
    h.fake.collection("activity_log").indexes.find((index) => index.key.timestamp === 1)!.expireAfterSeconds = 172800;
    const before = h.snapshot();
    expect(await e.reader.discover("demo-producer", {})).toMatchObject({ receiptRetentionMs: 172800_000 });
    expect(await e.reader.show("demo", { limit: 20 })).toMatchObject({ receiptRetentionMs: 172800_000 });
    expect(h.snapshot()).toEqual(before);
  });
  it("renders the newly reconciled occurrence rather than the caller's stale snapshot", async () => {
    const h = await harness(), e = h.engine(); h.at("2026-09-07T07:00:00Z");
    const stale = await h.store.materialize((await h.store.get("demo"))!, DUE);
    await h.send(e.delivery);
    expect(stale.delivery.state).toBe("pending");
    const before = h.snapshot();
    expect(await e.reader.occurrenceView(stale)).toMatchObject({
      delivery: { state: "acknowledged" }, acknowledgement: { receiptWriteState: "persisted" },
      history: "present", sendable: false,
    });
    expect(h.snapshot()).toEqual(before); expect(h.submitted).toHaveLength(1);
  });
  it.each(["admission", "scanned_current"] as const)("rejects missing required %s projection without fixing it", async (kind) => {
    const h = await harness(), e = h.engine(); h.at(DUE);
    const d = (await h.store.get("demo"))!, o = await h.store.materialize(d, DUE);
    if (kind === "admission") await h.store.admit(o, e.bootId);
    else await h.store.advance(d, DUE);
    h.fake.collection(COLLECTION).rows.delete(KEY);
    const before = h.snapshot(), writes = h.fake.writes();
    await expect(e.reader.discover("demo-producer", { section: "definitions" })).rejects.toThrow("evidence_integrity");
    await expect(e.reader.show("demo", { limit: 20 })).rejects.toThrow("evidence_integrity");
    expect(h.snapshot()).toEqual(before); expect(h.fake.writes()).toBe(writes);
    expect(h.submitted).toHaveLength(0);
    if (kind === "admission") expect(h.fake.collection(REGISTRY).rows.get("demo")!.deliveryAdmission).toBeDefined();
  });
  it("rejects invalid and cross-owner pagination cursors", () => {
    expect(() => decodeCursor("!!!", "overdue", "demo-producer")).toThrow("invalid_cursor");
    const cursor = Buffer.from(JSON.stringify({
      version: 1, section: "overdue", owner: "other", after: "x",
    })).toString("base64url");
    expect(() => decodeCursor(cursor, "overdue", "demo-producer")).toThrow("invalid_cursor");
  });
});
~~~

**Create:** src/cli/obligations.test.ts. Mock fromKeychain to return null, isolate environment selection and temporary config/.env fixtures, and route exact CliSelection values to distinct fake databases. The complete test file is:

- [ ] Add this complete CLI test file.

~~~typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runObligations, type CliSelection } from "./obligations.js";
import { harness, definition, KEY } from "../obligations/testing/harness.js";
vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: () => null }));
const roots: string[] = [];
beforeEach(() => {
  for (const key of ["MONGODB_URI", "MONGODB_DB", "HIVE_HOME", "HIVE_CONFIG"]) vi.stubEnv(key, "");
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hive-obligations-test-")); roots.push(root); return root;
}
function fixture(instanceId = "demo", filename = "hive.yaml", root = temporaryRoot()) {
  mkdirSync(root, { recursive: true });
  const path = join(root, filename), uri = "mongodb://" + instanceId + ".invalid", dbName = "hive_" + instanceId;
  writeFileSync(path, "instance:\n  id: " + instanceId + "\n");
  const suffix = filename.match(/^hive-(.+)\.yaml$/)?.[1];
  writeFileSync(join(root, suffix ? ".env-" + suffix : ".env"),
    "MONGODB_URI=" + uri + "\nMONGODB_DB=" + dbName + "\n");
  return { root, path, selection: { configPath: path, instanceId, uri, dbName } satisfies CliSelection };
}
function connection(h: Awaited<ReturnType<typeof harness>>, f: ReturnType<typeof fixture>) {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async (selection: CliSelection) => {
    expect(selection).toEqual(f.selection);
    return { db: h.fake.db, close };
  });
  return { connect, close };
}
describe("instance-bound obligations CLI", () => {
  it("reads pending and expired initial history without any mutations and closes every client", async () => {
    const h = await harness(), f = fixture(), c = connection(h, f), emit = vi.fn();
    const e = h.engine(); h.at("2026-09-07T07:00:00Z");
    h.fake.failNext("activity_log", "insertOne"); await h.send(e.delivery);
    for (const expired of [false, true]) {
      if (expired) h.at("2026-09-09T07:00:00Z");
      const snapshot = h.snapshot(), writes = h.fake.writes(), inserts = h.receiptInserts(), posts = h.submitted.length;
      for (const command of [["list"], ["show", "demo"]]) {
        await runObligations(["obligations", ...command, "--config", f.path, "--json"], {
          connect: c.connect, clock: h.clock, emit,
        });
        const view = JSON.parse(emit.mock.calls.at(-1)![0]);
        expect(view.receiptRetentionMs).toBe(86400_000);
        if (command[0] === "show") expect(view.occurrences[0]).toMatchObject({
          history: expired ? "expired_unresolved" : "initial_write_pending",
          acknowledgement: { receiptWriteState: "pending" }, sendable: false,
        });
        else expect(view).toHaveProperty("definitions");
      }
      expect(h.snapshot()).toEqual(snapshot); expect(h.fake.writes()).toBe(writes);
      expect(h.receiptInserts()).toBe(inserts); expect(h.submitted).toHaveLength(posts);
      expect((await h.store.occurrence(KEY)).acknowledgement?.receiptWriteState).toBe("pending");
    }
    expect(c.connect).toHaveBeenCalledTimes(4); expect(c.close).toHaveBeenCalledTimes(4);
  });
  it("refuses absent/mismatched sentinels without restamping", async () => {
    for (const absent of [true, false]) {
      const h = await harness(), f = fixture(), c = connection(h, f);
      const sentinel = h.fake.collection("instance_identity");
      if (absent) sentinel.rows.clear();
      else sentinel.rows.get("identity_sentinel")!.instanceId = "other";
      const writes = h.fake.writes();
      await expect(runObligations(["obligations", "deactivate", "demo", "--reason", "stop", "--config", f.path], {
        connect: c.connect, clock: h.clock, emit: () => {},
      })).rejects.toThrow("identity_unverified");
      expect(h.fake.writes()).toBe(writes); expect(c.close).toHaveBeenCalledTimes(1);
    }
  });
  it("registers identically, rejects conflicts, and deactivates only once without changing schedules", async () => {
    const h = await harness(), f = fixture(), c = connection(h, f), json = join(f.root, "definition.json");
    writeFileSync(json, JSON.stringify(definition));
    const deps = { connect: c.connect, clock: h.clock, emit: () => {} };
    const args = ["obligations", "register", "--file", json, "--config", f.path];
    await runObligations(args, deps); await runObligations(args, deps);
    writeFileSync(json, JSON.stringify({ ...definition, deliverable: "Different" }));
    await expect(runObligations(args, deps)).rejects.toThrow("definition_conflict");
    await runObligations(["obligations", "deactivate", "demo", "--reason", "first", "--config", f.path], deps);
    const cutoff = (await h.store.get("demo"))!.deactivatedAt;
    h.at("2026-09-08T08:00:00Z");
    await runObligations(["obligations", "deactivate", "demo", "--reason", "second", "--config", f.path], deps);
    expect((await h.store.get("demo"))!.deactivatedAt).toEqual(cutoff);
    expect((await h.fake.collection("agent_definitions").findOne({ _id: "demo-producer" }))!.schedule).toEqual([]);
    expect(c.close).toHaveBeenCalledTimes(5);
  });
  it.each(["config_file", "config_directory", "config_suffix", "home", "home_config", "instance"] as const)(
    "routes %s to the selected instance and leaves the other database intact", async (mode) => {
      const original = await harness(), selected = await harness({ instanceId: "other" });
      const f1 = fixture(), homeRoot = temporaryRoot();
      const f2 = fixture("other", ["config_suffix", "home_config"].includes(mode) ? "hive-selected.yaml" : "hive.yaml",
        mode === "instance" ? join(homeRoot, "services", "hive", "other") : undefined);
      let args: string[];
      if (mode === "instance") { vi.stubEnv("HOME", homeRoot); args = ["--instance", "other"]; }
      else if (mode === "home" || mode === "home_config") {
        vi.stubEnv("HIVE_HOME", f2.root);
        if (mode === "home_config") vi.stubEnv("HIVE_CONFIG", "hive-selected.yaml");
        args = [];
      } else args = ["--config", mode === "config_directory" ? f2.root : f2.path];
      const c1 = connection(original, f1), c2 = connection(selected, f2);
      const connect = vi.fn(async (selection: CliSelection) => {
        if (selection.dbName === f1.selection.dbName) return c1.connect(selection);
        if (selection.dbName === f2.selection.dbName) return c2.connect(selection);
        throw new Error("unexpected_target");
      });
      const untouched = original.snapshot(), writes = selected.fake.writes();
      selected.at("2026-09-07T07:00:00Z");
      await runObligations(["obligations", "deactivate", "demo", "--reason", "selected", ...args], {
        connect, clock: selected.clock, emit: () => {},
      });
      expect(connect).toHaveBeenCalledWith(f2.selection);
      expect(c1.connect).not.toHaveBeenCalled(); expect(c2.close).toHaveBeenCalledTimes(1);
      expect(original.snapshot()).toEqual(untouched);
      expect(selected.fake.writes()).toBeGreaterThan(writes);
      expect((await selected.store.get("demo"))!.deactivatedAt).toEqual(selected.clock());
    },
  );
  it("captures environment overrides in the selected target before sentinel verification", async () => {
    const h = await harness({ instanceId: "other", dbName: "hive_override" }), f = fixture("other");
    vi.stubEnv("MONGODB_URI", "mongodb://override.invalid"); vi.stubEnv("MONGODB_DB", "hive_override");
    const selected = { ...f, selection: { ...f.selection, uri: "mongodb://override.invalid", dbName: "hive_override" } };
    const c = connection(h, selected);
    await runObligations(["obligations", "list", "--config", f.path], { connect: c.connect, clock: h.clock, emit: () => {} });
    expect(c.connect).toHaveBeenCalledWith(selected.selection); expect(c.close).toHaveBeenCalledTimes(1);
  });
  it("rejects missing/conflicting selection before connecting", async () => {
    const f = fixture(), connect = vi.fn(async () => { throw new Error("must_not_connect"); });
    const deps = { connect, clock: () => new Date(0), emit: vi.fn() };
    await expect(runObligations(["obligations", "list"], deps)).rejects.toThrow("explicit_instance_required");
    await expect(runObligations(["obligations", "list", "--config", f.path, "--instance", "demo"], deps))
      .rejects.toThrow("choose_config_or_instance");
    expect(connect).not.toHaveBeenCalled(); expect(deps.emit).not.toHaveBeenCalled();
  });
});
~~~

**Modify:** src/agents/provider-adapters/tool-bridge.test.ts. Append to its existing real AgentRunner/InMemoryTransport test harness (makeMemoryAgentConfig and makeMemMgr already exist). Import harness, definition, DUE from ../../obligations/testing/harness.js, Client from @modelcontextprotocol/sdk/client/index.js, and InMemoryTransport from @modelcontextprotocol/sdk/inMemory.js.

- [ ] Add the imports and append the provider cases below.

~~~typescript
import { harness, definition, DUE } from "../../obligations/testing/harness.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("KPR-456 provider schedule capability", () => {
  it.each(["claude", "lane-b"] as const)("keeps two overlapping %s runners bound to their own producer", async (lane) => {
    const h = await harness(), e = h.engine();
    await h.fake.collection("agent_definitions").insertOne({ _id: "other-producer", schedule: [] });
    await h.store.register({ ...definition, _id: "other", producerAgentId: "other-producer",
      destination: { kind: "slack", channelId: "C00000003" } }, h.clock());
    h.at("2026-09-07T07:00:00Z");
    const calls: Array<{ producer: string; input: unknown }> = [];
    const capability = {
      discover: (id: string, input: unknown) => e.reader.discover(id, input),
      deliver: (id: string, input: unknown) => { calls.push({ producer: id, input }); return e.delivery.deliver(id, input); },
    };
    const closers: Array<() => Promise<void>> = [];
    async function open(id: string) {
      const runner = new AgentRunner(makeMemoryAgentConfig({ id, coreServers: ["schedule"] }),
        makeMemMgr() as never, [], new Map(), "{}", undefined, undefined, h.db, undefined, undefined,
        { obligations: capability });
      const servers = runner.buildInProcessServers();
      if (lane === "claude") {
        const client = new Client({ name: id, version: "1" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await servers.schedule!.instance.connect(st); await client.connect(ct);
        closers.push(async () => { await client.close(); await servers.schedule!.instance.close(); });
        return async (input: Record<string, unknown>) => JSON.stringify(await client.callTool({ name: "deliver_obligation", arguments: input }));
      }
      const bridge = new ToolBridge({
        inventory: runner.buildToolTransportInventory().filter((entry) => entry.name === "schedule"),
        inProcessServers: servers, gate: async () => ({ behavior: "allow" }),
        signal: new AbortController().signal, agentId: id, sessionCwd: tmpdir(), skillIndex: [],
      });
      const tools = await bridge.connect(); closers.push(() => bridge.close());
      return async (input: Record<string, unknown>) => tools.find((tool) => tool.name === "mcp__schedule__deliver_obligation")!.execute(input);
    }
    let release!: () => void, reached!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const bothEntered = new Promise<void>((resolve) => { reached = resolve; }); let entered = 0;
    try {
      const a = await open("demo-producer"), b = await open("other-producer");
      const inputA = { obligationId: "demo", dueAt: DUE.toISOString(), text: "A" };
      const inputB = { obligationId: "other", dueAt: DUE.toISOString(), text: "B" };
      expect(await a(inputB)).not.toContain("confirmed_delivery");
      expect(await b(inputA)).not.toContain("confirmed_delivery"); expect(h.submitted).toHaveLength(0);
      calls.length = 0;
      h.beforeResponse(async () => { if (++entered === 2) reached(); await waiting; });
      const sendingA = a(inputA), sendingB = b(inputB); await bothEntered;
      expect(h.submitted.map((post) => post.channel).sort()).toEqual(["C00000001", "C00000003"]);
      expect(calls).toEqual(expect.arrayContaining([
        { producer: "demo-producer", input: inputA }, { producer: "other-producer", input: inputB },
      ]));
      release();
      for (const result of await Promise.all([sendingA, sendingB])) expect(result).toContain("confirmed_delivery");
      const rows = [...h.fake.collection("activity_log").rows.values()];
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ obligationId: "demo", producerAgentId: "demo-producer", destination: definition.destination }),
        expect.objectContaining({ obligationId: "other", producerAgentId: "other-producer", destination: { kind: "slack", channelId: "C00000003" } }),
      ]));
      expect(rows).toHaveLength(2); expect(h.submitted).toHaveLength(2);
    } finally { release(); h.beforeResponse(); for (const close of closers) await close(); }
  });
  it.each(["claude", "lane-b"] as const)("round-trips the strict delivery tool through %s", async (lane) => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    const capability = {
      discover: (id: string, input: unknown) => e.reader.discover(id, input),
      deliver: (id: string, input: unknown) => e.delivery.deliver(id, input),
    };
    const runner = new AgentRunner(makeMemoryAgentConfig({ id: "demo-producer", coreServers: ["schedule"] }),
      makeMemMgr() as never, [], new Map(), "{}", undefined, undefined, h.db, undefined, undefined,
      { obligations: capability });
    const servers = runner.buildInProcessServers();
    const input = { obligationId: "demo", dueAt: DUE.toISOString(), text: "Complete report" };
    if (lane === "claude") {
      const client = new Client({ name: "fixture", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await servers.schedule!.instance.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const rejected = await client.callTool({ name: "deliver_obligation", arguments: { ...input, success: true } });
        expect(rejected.isError).toBe(true); expect(h.submitted).toHaveLength(0);
        const sent = await client.callTool({ name: "deliver_obligation", arguments: input });
        expect(JSON.stringify(sent)).toContain("confirmed_delivery");
      } finally { await client.close(); await servers.schedule!.instance.close(); }
    } else {
      const bridge = new ToolBridge({
        inventory: runner.buildToolTransportInventory().filter((entry) => entry.name === "schedule"),
        inProcessServers: servers, gate: async () => ({ behavior: "allow" }),
        signal: new AbortController().signal, agentId: "demo-producer", sessionCwd: tmpdir(), skillIndex: [],
      });
      try {
        const tools = await bridge.connect();
        const send = tools.find((tool) => tool.name === "mcp__schedule__deliver_obligation")!;
        expect(await send.execute({ ...input, producerAgentId: "other" })).not.toContain("confirmed_delivery");
        expect(h.submitted).toHaveLength(0);
        expect(await send.execute(input)).toContain("confirmed_delivery");
        expect(await send.execute(input)).toContain("confirmed_delivery");
      } finally { await bridge.close(); }
    }
    expect(h.submitted).toHaveLength(1);
    const worker = new AgentRunner(makeMemoryAgentConfig({ id: "worker", coreServers: [] }),
      makeMemMgr() as never, [], new Map(), "{}", undefined, undefined, h.db, undefined, undefined,
      { suppressAutoInjectedServers: true });
    expect(worker.buildInProcessServers().schedule).toBeUndefined();
  });
});
~~~

Also extend existing runner mocks whose createSdkMcpServer returns a bare object to include instance.registerTool; otherwise the new strict registration fails in unrelated runner tests. Preserve those mocks' captured options and legacy behavior. Add explicit missing-service call coverage through a real schedule server in the same provider test: call deliver_obligation without obligations and assert isError:true plus unavailable, zero posts.

For manager forwarding, extend its existing new-AgentRunner spy fixture: a normal manager with setDeliveryObligations(capability) forwards that exact object for Claude and a Lane B route; the bound worker factory omits it. Assert constructor options, not source text. The existing worker tests already cover all three auto-injection/denylist gates and must remain green.

## Task 20: Finish fault coverage and final verification

- [ ] Add the following cases to the above assembly suite using FakeDb.pause/failNext; these are mandatory assertions, not optional tests:

| Case | Exact injection and required result |
| --- | --- |
| Lost notice acknowledgement write | Pause/fail COLLECTION replaceOne with document.notice.state=acknowledged after Slack accepts; repeated ticks and service recreation produce one submission, terminal unknown/sending until orphan recovery, never notified=true |
| Guard flips after claim | Pause the registry release update after durable occurrence sending; engage guard before release resolves; resume → no HTTP request, unknown response; guard recovery never blindly replays |
| Live notice request overlaps another sweep | Block h.beforeResponse; run a second same-boot sweeper and force a Mongo read failure there; first claim remains sending under the same exact token, then may acknowledge once |
| Receipt read failure at deadline | Deliver/ack checkpoint pending, fail activity_log.findOne, sweep → no notice and no evaluatedAt success; next tick repairs and evaluates |
| Receipt/checkpoint exact mismatch | Mutate retained destination/message timestamp or row fields; reader shows integrity error and never reports confirmed delivery |
| Shutdown drain | Delay a real runtime's poster/receipt insertion; call runtime.stop, assert it has not resolved, new deliver returns unavailable, release barrier, assert stop completes only after the receipt write; source-anchor tests verify the production dependency-close order |
| Scan fairness | Seed 25 definitions, fail the first definition's occurrence persistence repeatedly; bounded page rotation still advances later definitions, failed cursor does not skip its due instant |
| Malformed projections | Remove/malformed window/definition/ack fields; show returns an explicit bounded integrity error, never manufactures missing state |
| Registration validation | Unknown producer, extra engine fields, invalid thread/channel, conflicting identical ID, missing noticeDestination; zero registration side effects |
| Retention and indices | Multiple legacy rows without receipt fields coexist; unique receipt ID and occurrence collisions reject; timestamp TTL unchanged, no TTL on registry/occurrences; receipt init fails before runtime readiness when index creation fails |
| Schedule independence | Execute actual my_schedule_remove handler and Scheduler.reloadSchedules with the registered producer; upcoming obligation still materializes and notices; scheduler regression suite remains unchanged |
| Clock rollback | Complete one scan, move clock backwards, sweep and inspect → scanThrough never regresses or duplicates an occurrence |
| Notice content boundary | Malicious description containing Slack mentions/markup stays escaped; explicit notice destination used; no user mention, urgency, audit/home destination fallback |
| Acknowledgement equality | At dueAt counts on time; at dueAt+1ms is late; at windowStart is not admitted; first registration due instant is not retroactively monitored |

The table is a coverage index. Apply the complete tests in [chunk 7](kpr-456-plan-7-fault-tests.md) for these cases; boundary/content assertions already present above and in chunk 5 are not duplicated. No test may be replaced with a call-shape-only mock, TODO, skip, or snapshot of fabricated results.

- [ ] Run every focused command in the parent Testing Contract, then npm run check and git diff --check. Record actual outputs. Do not run broader repeats after green unless a subsequent change or unresolved concern justifies them.
- [ ] Inspect git diff for production enrollments/prompt changes, arbitrary diagnostics, receipt content leakage, hidden SDK retries and unbounded registry arrays; none is in scope.
- [ ] Commit remaining verified tests with:

~~~bash
git add src/obligations/testing/harness.ts src/obligations/testing/fake-db.ts src/obligations/testing/refusals.ts src/obligations/obligations.integration.test.ts src/obligations/reader.test.ts src/cli/obligations.test.ts src/agents/provider-adapters/tool-bridge.test.ts src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/boot-order.test.ts
git commit -m "test: cover delivery obligation races retention recovery and provider boundaries"
~~~
