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
  _id: "demo",
  deliverable: "Demo <@U00000001> <!channel>",
  producerAgentId: "demo-producer",
  deadline: { localTime: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC" },
  destination: { kind: "slack", channelId: "C00000001" },
  noticeDestination: { kind: "slack", channelId: "C00000002" },
  createdBy: "operator",
};
export type ResponseScript = {
  body?: unknown;
  rawBody?: string;
  status?: number;
  provenance?: boolean;
  accepted?: boolean;
  throws?: boolean;
  retryAfter?: string;
};
export async function harness(options: { instanceId?: string; dbName?: string; initialize?: boolean } = {}) {
  const instanceId = options.instanceId ?? "demo",
    dbName = options.dbName ?? "hive_" + instanceId;
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
  const poster = new SlackObligationPoster(
    "fake-token",
    (channel, ts) => echo.push([channel, ts]),
    () => !guard.engaged,
    clock,
    async (_url, init) => {
      const params = new URLSearchParams(String(init?.body));
      const sent = { channel: params.get("channel"), text: params.get("text") };
      submitted.push(sent);
      const script = scripts.shift();
      const body = script?.body ?? { ok: true, channel: sent.channel, ts: String(submitted.length) + ".000001" };
      if (!script || script.accepted) accepted.push(sent);
      if (beforeResponse) await beforeResponse();
      if (script?.throws) throw new Error("simulated_timeout");
      const headers = new Headers({
        "content-type": script?.rawBody === undefined ? "application/json" : "text/plain",
      });
      if (script?.provenance !== false) headers.set("x-slack-req-id", "fixture");
      if (script?.retryAfter) headers.set("retry-after", script.retryAfter);
      const response = new Response(script?.rawBody ?? JSON.stringify(body), {
        status: script?.status ?? 200,
        headers,
      });
      Object.defineProperty(response, "url", { value: "https://slack.com/api/chat.postMessage" });
      return response;
    },
  );
  await fake.collection("agent_definitions").insertOne({ _id: definition.producerAgentId, schedule: [] });
  await fake.collection("instance_identity").insertOne({
    _id: "identity_sentinel",
    schemaVersion: 1,
    instanceId,
    dbName,
    sentinelId: randomUUID(),
    stampedAt: clock(),
    stampedBy: { engineVersion: "test", hostname: "test", pid: 1 },
  });
  const store = new ObligationStore(db),
    receipts = new ReceiptStore(db, 1);
  if (options.initialize !== false) {
    await store.init();
    await receipts.init();
  }
  await store.register(definition, clock());
  function engine(bootId = randomUUID()) {
    const delivery = new DeliveryService(store, receipts, poster, bootId, clock, () => !guard.engaged);
    const sweeper = new ObligationSweeper(store, receipts, delivery, poster, bootId, clock, () => !guard.engaged);
    const reader = new ObligationReader(store, receipts, clock);
    return { delivery, sweeper, reader, bootId };
  }
  return {
    fake,
    guard,
    db,
    store,
    receipts,
    poster,
    submitted,
    accepted,
    echo,
    scripts,
    clock,
    engine,
    at: (value: Date | string) => {
      now = new Date(value);
    },
    beforeResponse: (hook?: () => Promise<void>) => {
      beforeResponse = hook;
    },
    send: (service: DeliveryService, dueAt = DUE, text = "Complete deliverable") =>
      service.deliver(definition.producerAgentId, { obligationId: "demo", dueAt: dueAt.toISOString(), text }),
    snapshot: () =>
      structuredClone(
        [...fake.collections].map(([name, collection]) => ({
          name,
          rows: [...collection.rows],
          indexes: collection.indexes,
        })),
      ),
    receiptInserts: () =>
      fake.operations.filter((v) => v.collection === "activity_log" && v.operation === "insertOne").length,
  };
}
