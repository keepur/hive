import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `store.ts` and `publisher.ts` call `createLogger` at module load; the mock
// hands back the SAME object every call so cases can count warn lines by
// message fragment (vi.hoisted — vi.mock factories hoist above top-level consts).
const mockLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));

import { buildOpsFixture, type OpsFixture } from "./testing/lane-harness.js";
import { OpsPublisher } from "./publisher.js";
import { observeToolFailure } from "./observe.js";
import { HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED } from "./reasons.js";
import {
  BLOCK_SUBJECT_KIND,
  HIVE_AGENT_PRODUCER,
  REASON_BLOCK_CLEARED,
  REASON_COORDINATION_BLOCK,
  REASON_SEMANTIC_BLOCK,
} from "./block-reasons.js";
import { OPS_EVENTS_COLLECTION, OPS_REASONS_COLLECTION, type OpsEvent, type OpsPublishInput } from "./types.js";

/**
 * KPR-501 — the agent-facing block producer, integration level.
 *
 * First describe: the four `OpsPublisher` additions (D1, D7 steps 4–5, D8, D9)
 * driven against a real publisher over the ops `FakeDb`. `fixture.drain()` is
 * the publish→assert barrier throughout.
 */

const RETENTION_DAYS = 90;
const AGENT = "mokie";
const THREAD = "1757000000.000100";

const subject = (thread = THREAD) => ({ kind: BLOCK_SUBJECT_KIND, id: `${AGENT}:${thread}` });

const conditionKey = (thread = THREAD) => ({
  producer: HIVE_AGENT_PRODUCER,
  reasonId: REASON_COORDINATION_BLOCK,
  subject: subject(thread),
});

const reportInput = (thread = THREAD): OpsPublishInput => ({
  producer: HIVE_AGENT_PRODUCER,
  reasonId: REASON_COORDINATION_BLOCK,
  waiting: "nobody",
  subject: subject(thread),
  detail: { agentId: AGENT, blockedOn: "agent" },
  evidence: [],
});

const clearInput = (clears: string, thread = THREAD): OpsPublishInput => ({
  producer: HIVE_AGENT_PRODUCER,
  reasonId: REASON_BLOCK_CLEARED,
  waiting: "nobody",
  subject: subject(thread),
  detail: { agentId: AGENT, outcome: "resumed" },
  evidence: [],
  clears,
});

const compareStored = (a: OpsEvent, b: OpsEvent): number => {
  const at = a.publishedAt.getTime();
  const bt = b.publishedAt.getTime();
  if (at !== bt) return at - bt;
  return String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0;
};

describe("KPR-501 OpsPublisher additions — accept-only job, bounded flush, log-resolved open condition, enabled read", () => {
  let fixture: OpsFixture;
  const extraPublishers: OpsPublisher[] = [];

  const opsEventOps = (operation: string) =>
    fixture.fakeDb.operations.filter((o) => o.collection === OPS_EVENTS_COLLECTION && o.operation === operation);

  beforeEach(async () => {
    mockLog.debug.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    fixture = await buildOpsFixture();
  });

  afterEach(async () => {
    for (const p of extraPublishers.splice(0)) await p.stop();
    await fixture.dispose();
  });

  it("enqueuePublish returns before any insert, and the drainer then stores the document", async () => {
    const before = opsEventOps("insertOne").length;
    fixture.publisher.enqueuePublish(reportInput());
    expect(opsEventOps("insertOne").length).toBe(before);
    expect(fixture.events()).toHaveLength(0);

    await fixture.drain();
    expect(fixture.events()).toHaveLength(1);
    expect(fixture.events()[0]).toMatchObject({
      producer: HIVE_AGENT_PRODUCER,
      reasonId: REASON_COORDINATION_BLOCK,
      generation: 0,
      matchedSubscriptions: 0,
    });
  });

  it("a publish job enqueued between two failure jobs is stored between them in (publishedAt, _id) order", async () => {
    observeToolFailure({ tool: "mcp__alpha__one", error: "boom", lane: "claude" });
    fixture.publisher.enqueuePublish(reportInput());
    observeToolFailure({ tool: "mcp__beta__two", error: "boom", lane: "claude" });
    await fixture.drain();

    const stored = [...fixture.events()].sort(compareStored);
    expect(stored.map((e) => [e.producer, e.reasonId, e.subject.id])).toEqual([
      [HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED, "mcp__alpha__one"],
      [HIVE_AGENT_PRODUCER, REASON_COORDINATION_BLOCK, `${AGENT}:${THREAD}`],
      [HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED, "mcp__beta__two"],
    ]);
  });

  it("publish jobs never change openConditions, whatever their class", async () => {
    observeToolFailure({ tool: "mcp__alpha__one", error: "boom", lane: "claude" });
    await fixture.drain();
    const baseline = fixture.publisher.getSnapshot().openConditions;
    expect(baseline).toBe(1);

    fixture.publisher.enqueuePublish(reportInput());
    fixture.publisher.enqueuePublish(reportInput("1757000000.000200"));
    fixture.publisher.enqueuePublish({
      ...reportInput(),
      reasonId: REASON_SEMANTIC_BLOCK,
      detail: { agentId: AGENT },
    });
    await fixture.drain();
    const key = await fixture.publisher.findOpenCondition(conditionKey());
    fixture.publisher.enqueuePublish(clearInput(key!));
    await fixture.drain();

    expect(fixture.events().filter((e) => e.producer === HIVE_AGENT_PRODUCER)).toHaveLength(4);
    expect(fixture.publisher.getSnapshot().openConditions).toBe(baseline);
  });

  it("findOpenCondition: undefined when never raised, exact key when open, undefined after a more recent clear, the new key after re-report", async () => {
    expect(await fixture.publisher.findOpenCondition(conditionKey())).toBeUndefined();

    fixture.publisher.enqueuePublish(reportInput());
    await fixture.drain();
    const opened = fixture.events().find((e) => e.reasonId === REASON_COORDINATION_BLOCK)!;
    const key = await fixture.publisher.findOpenCondition(conditionKey());
    expect(key).toBe(opened.dedupeKey);
    expect(key).toBe(`${HIVE_AGENT_PRODUCER}:${BLOCK_SUBJECT_KIND}:${AGENT}:${THREAD}:${REASON_COORDINATION_BLOCK}:0`);

    // A renewal keeps the same key.
    fixture.publisher.enqueuePublish(reportInput());
    await fixture.drain();
    expect(await fixture.publisher.findOpenCondition(conditionKey())).toBe(key);

    fixture.publisher.enqueuePublish(clearInput(key!));
    await fixture.drain();
    expect(fixture.events().filter((e) => e.reasonId === REASON_BLOCK_CLEARED)).toHaveLength(1);
    expect(await fixture.publisher.findOpenCondition(conditionKey())).toBeUndefined();

    fixture.publisher.enqueuePublish(reportInput());
    await fixture.drain();
    const reopened = await fixture.publisher.findOpenCondition(conditionKey());
    expect(reopened).toBe(
      `${HIVE_AGENT_PRODUCER}:${BLOCK_SUBJECT_KIND}:${AGENT}:${THREAD}:${REASON_COORDINATION_BLOCK}:1`,
    );
    expect(reopened).not.toBe(key);

    // A different thread's family is independent.
    expect(await fixture.publisher.findOpenCondition(conditionKey("1757000000.000900"))).toBeUndefined();
  });

  it("a second OpsPublisher over the same database (restart) resolves the same open condition", async () => {
    fixture.publisher.enqueuePublish(reportInput());
    await fixture.drain();
    const first = await fixture.publisher.findOpenCondition(conditionKey());
    expect(first).toBeDefined();
    await fixture.publisher.stop();

    const restarted = new OpsPublisher(fixture.fakeDb.db, RETENTION_DAYS);
    extraPublishers.push(restarted);
    await restarted.init();
    expect(restarted.getSnapshot().openConditions).toBe(0);
    expect(await restarted.findOpenCondition(conditionKey())).toBe(first);

    // And a clear through the restarted publisher closes it for both readers.
    restarted.enqueuePublish(clearInput(first!));
    await restarted.__drainForTests();
    expect(await restarted.findOpenCondition(conditionKey())).toBeUndefined();
    expect(await fixture.publisher.findOpenCondition(conditionKey())).toBeUndefined();
  });

  it("findOpenCondition rejects on a read fault, runs both reads concurrently, and moves no publisher counter", async () => {
    fixture.publisher.enqueuePublish(reportInput());
    await fixture.drain();
    const countersBefore = fixture.publisher.getSnapshot();
    const findsBefore = opsEventOps("findOne").length;
    const warnsBefore = mockLog.warn.mock.calls.filter(([msg]) => String(msg).includes("epoch resolve")).length;

    fixture.fakeDb.failNext(OPS_EVENTS_COLLECTION, "findOne");
    await expect(fixture.publisher.findOpenCondition(conditionKey())).rejects.toThrow("injected");

    expect(opsEventOps("findOne").length - findsBefore).toBe(2);
    const countersAfter = fixture.publisher.getSnapshot();
    expect(countersAfter.epochResolveFaults).toBe(countersBefore.epochResolveFaults);
    expect(countersAfter).toEqual(countersBefore);
    expect(mockLog.warn.mock.calls.filter(([msg]) => String(msg).includes("epoch resolve")).length).toBe(warnsBefore);
  });

  it("flush resolves not-idle while an insert is held past a small real deadline, and idle once released", async () => {
    const hold = fixture.fakeDb.pause(OPS_EVENTS_COLLECTION, "insertOne");
    fixture.publisher.enqueuePublish(reportInput());
    await hold.reached;

    const started = Date.now();
    await expect(fixture.publisher.flush(25)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fixture.publisher.getSnapshot().drainDropped).toBe(0);

    hold.release();
    await expect(fixture.publisher.flush(2000)).resolves.toBe(true);
    expect(fixture.events()).toHaveLength(1);

    // flush does not latch `stopping`: a later enqueue still lands.
    fixture.publisher.enqueuePublish(reportInput());
    await expect(fixture.publisher.flush(2000)).resolves.toBe(true);
    expect(fixture.events()).toHaveLength(2);
  });

  it("flush on an idle queue resolves idle immediately", async () => {
    await expect(fixture.publisher.flush(0)).resolves.toBe(true);
  });

  it("isReasonEnabled is false before init, reflects ops_reasons enabled after init, and is false for an unknown pair", async () => {
    const fresh = new OpsPublisher(fixture.fakeDb.db, RETENTION_DAYS);
    extraPublishers.push(fresh);
    expect(fresh.isReasonEnabled(HIVE_AGENT_PRODUCER, REASON_COORDINATION_BLOCK)).toBe(false);
    expect(fresh.isReasonEnabled(HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED)).toBe(false);

    await fresh.init();
    expect(fresh.isReasonEnabled(HIVE_AGENT_PRODUCER, REASON_COORDINATION_BLOCK)).toBe(true);
    expect(fresh.isReasonEnabled(HIVE_AGENT_PRODUCER, REASON_BLOCK_CLEARED)).toBe(true);
    expect(fresh.isReasonEnabled(HIVE_AGENT_PRODUCER, "no-such-reason")).toBe(false);
    expect(fresh.isReasonEnabled("no-such-producer", REASON_COORDINATION_BLOCK)).toBe(false);

    const row = fixture.fakeDb
      .collection(OPS_REASONS_COLLECTION)
      .rows.find((r) => r._id === `${HIVE_AGENT_PRODUCER}:${REASON_COORDINATION_BLOCK}`)!;
    row.enabled = false;
    await fresh.init();
    expect(fresh.isReasonEnabled(HIVE_AGENT_PRODUCER, REASON_COORDINATION_BLOCK)).toBe(false);
    expect(fresh.isReasonEnabled(HIVE_AGENT_PRODUCER, REASON_BLOCK_CLEARED)).toBe(true);
  });
});
