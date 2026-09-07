# KPR-456 plan chunk 7 — remaining fault and lifecycle test code

Parent: [implementation plan](kpr-456-plan.md). This chunk supplies executable code for the remaining matrix in chunk 6, plus exact compatibility-test edits.

## Task 21: Fault, fairness, lifecycle and schedule independence

**Create:** src/obligations/faults.integration.test.ts

- [ ] Add this complete file.

~~~typescript
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createScheduleMcpServer } from "../schedule/schedule-mcp-server.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { ObligationRuntime } from "./runtime.js";
import { registrationSchema } from "./types.js";
import { definition, DUE, KEY, COLLECTION, REGISTRY, harness } from "./testing/harness.js";

vi.mock("../config.js", () => ({
  config: { scheduler: { heartbeatIntervalMs: 60_000 }, events: { retentionDays: 7 }, team: { enabled: false } },
}));
function gate() {
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, block: async () => { reached(); await waiting; } };
}
describe("obligation fault boundaries", () => {
  it("lost notice acknowledgement publication stays unknown across ticks/restart", async () => {
    const h = await harness(), e = h.engine();
    h.at(DUE);
    h.fake.failNext(COLLECTION, "replaceOne", false, (ctx) => ctx.document?.notice?.state === "acknowledged");
    await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).notice?.state).toBe("unknown");
    await e.sweeper.stop(); const next = h.engine();
    h.at("2026-09-07T08:01:00Z");
    await next.sweeper.sweepOnce(); await next.sweeper.sweepOnce();
    expect(h.submitted).toHaveLength(1);
    expect(await next.reader.occurrenceView(await h.store.occurrence(KEY))).toMatchObject({ notified: false });
  });
  it("guard engagement between durable claim and HTTP submission prevents the post", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z");
    const barrier = h.fake.pause(REGISTRY, "updateOne", (ctx) => Boolean(ctx.update?.$unset?.deliveryAdmission !== undefined), true);
    const sending = h.send(e.delivery); await barrier.reached;
    h.guard.engage("fixture"); barrier.release();
    expect(await sending).toMatchObject({ state: "delivery_outcome_unknown" });
    expect(h.submitted).toHaveLength(0);
    h.guard.disengage(); await e.sweeper.stop();
    const next = h.engine(); await next.sweeper.sweepOnce(); await h.send(next.delivery);
    expect(h.submitted).toHaveLength(0);
    expect((await h.store.occurrence(KEY)).delivery.state).toBe("unknown");
  });
  it("a failed overlapping sweep cannot interrupt another live notice claim", async () => {
    const h = await harness(), boot = randomUUID(), first = h.engine(boot), second = h.engine(boot);
    h.at(DUE);
    const barrier = gate(); h.beforeResponse(barrier.block);
    const posting = first.sweeper.sweepOnce(); await barrier.entered;
    const token = (await h.store.occurrence(KEY)).notice!.claimToken;
    h.fake.failNext(COLLECTION, "findOne");
    await second.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).notice).toMatchObject({ state: "sending", claimToken: token });
    barrier.release(); await posting; h.beforeResponse();
    expect((await h.store.occurrence(KEY)).notice?.state).toBe("acknowledged");
    expect(h.submitted).toHaveLength(1);
  });
  it("receipt read failures at the deadline stay pending until a later successful evaluation", async () => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z"); h.fake.failNext("activity_log", "insertOne");
    await h.send(e.delivery);
    h.at(DUE);
    h.fake.failNext("activity_log", "findOne"); // recovery lane
    h.fake.failNext("activity_log", "findOne"); // evaluation lane
    await e.sweeper.sweepOnce();
    const pending = await h.store.occurrence(KEY);
    expect(pending.evaluation).toBe("pending");
    expect(pending.evaluatedAt).toBeUndefined();
    expect(pending.notice).toBeUndefined(); expect(h.submitted).toHaveLength(1);
    h.at("2026-09-07T08:01:00Z"); await e.sweeper.sweepOnce();
    expect((await h.store.occurrence(KEY)).evaluation).toBe("on_time");
  });
  it.each(["receipt", "window", "notice"])("malformed %s evidence is explicit and never successful", async (field) => {
    const h = await harness(), e = h.engine();
    h.at("2026-09-07T07:00:00Z"); await h.send(e.delivery);
    if (field === "receipt") {
      [...h.fake.collection("activity_log").rows.values()][0]!.destination.channelId = "C99999999";
      expect(await e.reader.occurrenceView(await h.store.occurrence(KEY))).toMatchObject({
        state: "integrity_or_storage_error", reason: "evidence_integrity", sendable: false,
      });
    } else {
      const row = h.fake.collection(COLLECTION).rows.get(KEY)!;
      if (field === "window") delete row.windowStart;
      else row.notice = { intentId: KEY + "/notice", state: "acknowledged" };
      await expect(e.reader.show("demo", { limit: 20 })).rejects.toThrow("evidence_integrity");
    }
    expect(h.submitted).toHaveLength(1);
  });
  it("shutdown rejects new calls and drains the admitted receipt before closing dependencies", async () => {
    const h = await harness();
    h.at("2026-09-07T07:00:00Z");
    const runtime = new ObligationRuntime(h.db, 1, () => !h.guard.engaged, h.clock, randomUUID(), h.poster);
    await runtime.init(); await runtime.start("fake", () => {});
    const barrier = h.fake.pause("activity_log", "insertOne");
    const sending = runtime.deliver("demo-producer", { obligationId: "demo", dueAt: DUE.toISOString(), text: "Complete" });
    await barrier.reached;
    const closed: string[] = [];
    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; closed.push("runtime"); });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(await runtime.deliver("demo-producer", { obligationId: "demo", dueAt: DUE.toISOString(), text: "Again" }))
      .toMatchObject({ state: "unavailable" });
    barrier.release(); await sending; await stopping;
    closed.push("slack", "mongo"); // models index.ts's explicitly tested shutdown order
    expect(closed).toEqual(["runtime", "slack", "mongo"]);
    expect((await h.store.occurrence(KEY)).acknowledgement?.receiptWriteState).toBe("persisted");
    expect(h.submitted).toHaveLength(1);
  });
  it("a persistently failing first definition cannot starve later pages", async () => {
    const h = await harness(), e = h.engine();
    for (let i = 0; i < 25; i++) {
      await h.store.register({ ...definition, _id: "demo-" + String(i).padStart(2, "0") }, h.clock());
    }
    h.at(DUE);
    for (let i = 0; i < 4; i++) h.fake.failNext(COLLECTION, "updateOne", false,
      (ctx) => ctx.update?.$setOnInsert?.obligationId === "demo");
    for (let i = 0; i < 4; i++) await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough).toEqual(new Date("2026-09-07T06:00:00Z"));
    expect((await h.store.get("demo-24"))!.scanThrough).toEqual(DUE);
    expect(h.submitted.some((post) => post.text?.includes("Obligation demo-24;"))).toBe(true);
  });
  it("retains multiple legacy rows, applies partial receipt uniqueness and never TTLs deduplication", async () => {
    const h = await harness(), e = h.engine();
    await h.fake.collection("activity_log").insertOne({ agentId: "x", timestamp: h.clock() });
    await h.fake.collection("activity_log").insertOne({ agentId: "y", timestamp: h.clock() });
    h.at("2026-09-07T07:00:00Z"); await h.send(e.delivery);
    const receipt = [...h.fake.collection("activity_log").rows.values()].find((r) => r.recordKind === "delivery_receipt")!;
    const { _id, ...body } = receipt; void _id;
    await expect(h.fake.collection("activity_log").insertOne({ ...body, receiptId: "another" })).rejects.toMatchObject({ code: 11000 });
    await expect(h.fake.collection("activity_log").insertOne({ ...body, dueAt: new Date("2026-09-08T08:00:00Z") })).rejects.toMatchObject({ code: 11000 });
    expect(h.fake.collection(REGISTRY).indexes.some((index) => "expireAfterSeconds" in index)).toBe(false);
    expect(h.fake.collection(COLLECTION).indexes.some((index) => "expireAfterSeconds" in index)).toBe(false);
    expect(await h.receipts.retentionMs()).toBe(86400_000);
  });
  it("index failure prevents runtime readiness even if start is subsequently attempted", async () => {
    const h = await harness(), runtime = new ObligationRuntime(h.db, 1, () => true, h.clock, randomUUID(), h.poster);
    h.fake.failNext(REGISTRY, "createIndex");
    await expect(runtime.init()).rejects.toThrow("injected");
    await expect(runtime.start("fake", () => {})).rejects.toThrow("not_initialized");
    expect(await runtime.deliver("demo-producer", { obligationId: "demo", dueAt: DUE.toISOString(), text: "x" }))
      .toMatchObject({ state: "unavailable" });
    expect(h.submitted).toHaveLength(0);
  });
  it("registration rejects unknown producers and input fields without creating definitions", async () => {
    const h = await harness();
    const count = h.fake.collection(REGISTRY).rows.size;
    await expect(h.store.register({ ...definition, _id: "new", producerAgentId: "unknown" }, h.clock())).rejects.toThrow("unknown_producer");
    for (const input of [
      { ...definition, _id: "new", activeFrom: h.clock() },
      { ...definition, _id: "new", deliveryAdmission: {} },
      { ...definition, _id: "new", destination: { kind: "slack", channelId: "general" } },
      { ...definition, _id: "new", destination: { ...definition.destination, threadTs: "latest" } },
      { ...definition, _id: "new", noticeDestination: undefined },
    ]) {
      expect(registrationSchema.safeParse(input).success).toBe(false);
      await expect(h.store.register(input, h.clock())).rejects.toBeDefined();
    }
    expect(h.fake.collection(REGISTRY).rows.size).toBe(count);
  });
  it("actual schedule removal and reload do not affect registered expectations", async () => {
    const h = await harness(), e = h.engine();
    await h.fake.collection("agent_definitions").updateOne(
      { _id: "demo-producer" }, { $set: { schedule: [{ cron: "0 8 * * *", task: "demo-task" }] } },
    );
    const server = createScheduleMcpServer({ db: h.db, agentId: "demo-producer" });
    const client = new Client({ name: "fixture", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st); await client.connect(ct);
    try {
      const removed = await client.callTool({ name: "my_schedule_remove", arguments: { task: "demo-task", reason: "fixture" } });
      expect(removed.isError).not.toBe(true);
      const rows = await h.fake.collection("agent_definitions").find().toArray();
      const scheduler = new Scheduler({} as never, {} as never, {} as never, { getAll: () => rows } as never);
      await scheduler.reloadSchedules();
      h.at(DUE); await e.sweeper.sweepOnce();
      expect(h.submitted).toHaveLength(1);
      expect((await h.store.get("demo"))!.deactivatedAt).toBeUndefined();
    } finally { await client.close(); await server.instance.close(); }
  });
  it("missing service reports unavailable through the real strict schedule server", async () => {
    const h = await harness();
    const server = createScheduleMcpServer({ db: h.db, agentId: "demo-producer" });
    const client = new Client({ name: "fixture", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(st); await client.connect(ct);
    try {
      const result = await client.callTool({ name: "deliver_obligation", arguments: {
        obligationId: "demo", dueAt: DUE.toISOString(), text: "complete",
      } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain("unavailable");
      expect(h.submitted).toHaveLength(0);
    } finally { await client.close(); await server.instance.close(); }
  });
  it("clock rollback never regresses coverage or duplicates a deadline", async () => {
    const h = await harness(), e = h.engine();
    h.at(DUE); await e.sweeper.sweepOnce();
    const through = (await h.store.get("demo"))!.scanThrough;
    h.at("2026-09-07T05:00:00Z"); await e.sweeper.sweepOnce();
    expect((await h.store.get("demo"))!.scanThrough).toEqual(through);
    expect(h.submitted).toHaveLength(1);
    expect(h.fake.collection(COLLECTION).rows.size).toBe(1);
  });
});
~~~

## Task 22: Exact existing-test changes

**Modify:** src/agents/agent-runner.test.ts: SDK mock near baseline line 77

- [ ] Replace only instance: {} in the createSdkMcpServer mock result with:

~~~typescript
instance: { registerTool: vi.fn() },
~~~

Leave the query(), captured options and other mock outputs unchanged. Existing buildInProcessServers schedule assertions and worker containment cases must continue to pass.

**Modify:** src/agents/agent-manager.test.ts: inside describe("AgentManager — KPR-390 worker pool handshake")

- [ ] Add these two cases using that block's existing fixtures.

~~~typescript
it.each(["claude", "openai"] as const)("forwards obligation capability for the normal %s runner", async (provider) => {
  const capability = { discover: vi.fn(async () => ({})), deliver: vi.fn(async () => ({})) };
  manager.setDeliveryObligations(capability);
  await (manager as unknown as {
    createProviderAdapter(id: string, route: { provider: string; model: string }): Promise<unknown>;
  }).createProviderAdapter("agent-a", {
    provider, model: provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.4-mini",
  });
  expect(vi.mocked(AgentRunner).mock.calls.at(-1)?.[10]?.obligations).toBe(capability);
});
it("does not forward the obligation sender to contained workers", () => {
  const capability = { discover: vi.fn(async () => ({})), deliver: vi.fn(async () => ({})) };
  manager.setDeliveryObligations(capability);
  const pool = makeFakePool(); manager.setWorkerPool(pool as never);
  const hooks = pool.bindManager.mock.calls[0]![0];
  hooks.buildWorkerAdapter(makeAgentConfig({ id: "worker" }));
  const options = vi.mocked(AgentRunner).mock.calls.at(-1)?.[10];
  expect(options?.suppressAutoInjectedServers).toBe(true);
  expect(options?.obligations).toBeUndefined();
});
~~~

**Modify:** src/boot-order.test.ts: add a separate describe block after its existing tests.

~~~typescript
describe("KPR-456 obligation readiness and drain order", () => {
  const code = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8")
    .split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  function at(text: string): number {
    const offset = code.indexOf(text);
    expect(offset, "missing lifecycle anchor " + text).toBeGreaterThanOrEqual(0);
    return offset;
  }
  it("initializes outside optional turn logging and wires every spawn before use", () => {
    expect(at("await obligations.init()")).toBeLessThan(at("if (config.activity.enabled)"));
    expect(at("await obligations.init()")).toBeLessThan(at("agentManager.setDeliveryObligations(obligations)"));
    for (const surface of [
      "await bgTaskManager.start()", "await bgTaskManager.scanOrphans()",
      "await codeTaskManager.start()", "await slackAdapter.start(", "scheduler.start()",
    ]) expect(at("agentManager.setDeliveryObligations(obligations)")).toBeLessThan(at(surface));
    expect(at("await obligations.start(")).toBeGreaterThan(at("await slackAdapter.start("));
  });
  it("drains obligations before closing Slack or Mongo", () => {
    const shutdown = code.slice(at("const shutdown = async"));
    const stop = shutdown.indexOf("await obligations.stop()");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(shutdown.indexOf("await slackAdapter.stop()")).toBeGreaterThan(stop);
    expect(shutdown.indexOf("await mongoClient.close()")).toBeGreaterThan(stop);
  });
});
~~~

The shutdown assertion is scoped to the graceful-shutdown body; an earlier boot-failure Mongo close is unrelated to this lifecycle ordering.

**Modify:** src/activity/activity-logger.test.ts

- [ ] In its shared fake collection, replace estimatedDocumentCount: vi.fn().mockResolvedValue(0) (or the existing numeric fixture) with countDocuments returning the same value. Change the startup count assertion to expect countDocuments called with { recordKind: { $ne: "delivery_receipt" } }. Retain existing buffer/drop/retry/retention tests; do not add receipt fields to turn fixtures.

## Task 23: Verify the complete assembled change

- [ ] Run:

~~~bash
npx vitest run src/obligations/deadlines.test.ts src/obligations/slack-post.test.ts src/obligations/reader.test.ts
npx vitest run src/obligations/obligations.integration.test.ts src/obligations/faults.integration.test.ts src/cli/obligations.test.ts src/schedule/schedule-mcp-server.test.ts
npx vitest run src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/provider-adapters/tool-bridge.test.ts src/workers/meeting-worker-pool.test.ts src/boot-order.test.ts
npx vitest run src/scheduler/scheduler.test.ts src/activity/activity-logger.test.ts src/slack/slack-gateway.test.ts src/slack/outbound-ts-cache.test.ts src/db/db-identity.integration.test.ts src/cli/doctor.test.ts
npm run check
git diff --check
~~~

Expected: all commands exit 0 and every new contract case actually runs. If a harness mismatch occurs, resolve the fixture/SDK boundary and retain the assertion; do not silently skip it.

- [ ] Commit the verified fault/lifecycle additions:

~~~bash
git add src/obligations/faults.integration.test.ts src/obligations/runtime.ts src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/boot-order.test.ts src/activity/activity-logger.test.ts
git commit -m "test: verify obligation fault isolation lifecycle and schedule independence"
~~~

This completes the implementation checklist only after the required checks and review have passed. This planning artifact itself supplies no implementation test result.
