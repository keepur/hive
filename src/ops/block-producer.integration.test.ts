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
  BLOCK_EVIDENCE_KIND_RULING,
  BLOCK_EVIDENCE_KIND_WORK_ITEM,
  BLOCK_SUBJECT_KIND,
  HIVE_AGENT_PRODUCER,
  REASON_BLOCK_CLEARED,
  REASON_COORDINATION_BLOCK,
  REASON_SEMANTIC_BLOCK,
} from "./block-reasons.js";
import { OPS_EVENTS_COLLECTION, OPS_REASONS_COLLECTION, type OpsEvent, type OpsPublishInput } from "./types.js";
import {
  CLEAR_BLOCK_TOOL,
  FLUSH_DEADLINE_MS,
  REFUSAL_BLOCKED_ON,
  REFUSAL_BLOCKED_ON_AGENT_ID,
  REFUSAL_KIND,
  REFUSAL_OUTCOME,
  REFUSAL_RULING_REF_SHAPE,
  REFUSAL_RULING_REQUIRED,
  REFUSAL_THREAD_ID_SHAPE,
  REPORT_BLOCK_TOOL,
  __resetBlockProducerCountersForTests,
  buildBlockTools,
  getBlockProducerSnapshot,
} from "./block-producer.js";
import { setOpsPublisher, __resetOpsPublisherForTests } from "./publisher-singleton.js";
import { clearingProvenanceOk } from "./ingest.js";
import type { OpsNotification } from "./notification-types.js";
import type { WorkItemContext, WorkItemContextRef } from "../agents/agent-runner.js";
import type { Db } from "mongodb";

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

// ───────────────────────────────────────────────────────────────────────────
// Handler level (Task 5): `buildBlockTools` descriptors invoked directly over
// the fixture's database, with a mutable `{ current }` context ref modelling
// successive turns. Lane cases (the real runner, the real bridge, the MCP
// layer's own validation) are separate describes.
// ───────────────────────────────────────────────────────────────────────────

type ToolAnswer = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Body = Record<string, unknown>;

/** The collections neither tool may ever write (D9/D10). */
const NEVER_WRITTEN = ["agent_events", "team_messages", "team_pending_requests", "agent_callbacks"];

const D9_KEYS = [
  "_id",
  "class",
  "dedupeKey",
  "detail",
  "evidence",
  "generation",
  "matchedSubscriptionIds",
  "matchedSubscriptions",
  "producer",
  "publishedAt",
  "reasonId",
  "retry",
  "schemaVersion",
  "subject",
  "waiting",
];

const SLACK_TS_1 = "1757000000.000101";
const SLACK_TS_2 = "1757000000.000102";
const SLACK_TS_3 = "1757000000.000103";
const THREAD_1 = "slack:C0AB12CD3EF:1757000000.000100";
const THREAD_2 = "slack:C0AB12CD3EF:1757000000.000900";

const RULING_REFS = ["1757900000.123456", "C0AB12CD3EF:1757900000.123456", "KPR-451", "KPR-451#comment-60079ae4"];
const CREDENTIAL_SHAPED = [
  "sk-ant-api03-Zx9_kLmN0pQrStUvWxYz-AbCdEf",
  "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
];

function turn(workItemId: string | undefined, threadId: string): WorkItemContext {
  return {
    ...(workItemId !== undefined ? { workItemId } : {}),
    adapterId: "slack",
    channelId: "C0AB12CD3EF",
    channelKind: "slack",
    channelLabel: "#ops",
    threadId,
    slackTs: workItemId ?? "",
    slackThreadTs: threadId,
  };
}

interface BlockTools {
  ref: WorkItemContextRef;
  report(args: Record<string, unknown>): Promise<{ result: ToolAnswer; body: Body }>;
  clear(args: Record<string, unknown>): Promise<{ result: ToolAnswer; body: Body }>;
}

function blockTools(db: Db, agentId = AGENT, current?: WorkItemContext): BlockTools {
  const ref: WorkItemContextRef = { current };
  const [report, clear] = buildBlockTools({ db, agentId, workItemContext: ref, eventSubscribersJson: "{}" });
  expect(report!.name).toBe(REPORT_BLOCK_TOOL);
  expect(clear!.name).toBe(CLEAR_BLOCK_TOOL);
  const run = async (descriptor: typeof report, args: Record<string, unknown>) => {
    const result = (await descriptor!.handler(args as never, {})) as ToolAnswer;
    expect(result.content).toHaveLength(1);
    return { result, body: JSON.parse(result.content[0]!.text) as Body };
  };
  return { ref, report: (args) => run(report, args), clear: (args) => run(clear, args) };
}

/** `isError` is ABSENT — not merely falsy — on every handler answer. */
function expectNonError(result: ToolAnswer): void {
  expect("isError" in result).toBe(false);
}

describe("KPR-501 block tools — handler level", () => {
  let fixture: OpsFixture;
  let tools: BlockTools;
  const extraPublishers: OpsPublisher[] = [];

  const agentEvents = () => fixture.events().filter((e) => e.producer === HIVE_AGENT_PRODUCER);
  const runtimeEvents = () => fixture.events().filter((e) => e.producer === HIVE_RUNTIME_PRODUCER);
  const opsEventOps = () => fixture.fakeDb.operations.filter((o) => o.collection === OPS_EVENTS_COLLECTION);
  const faultWarns = () =>
    mockLog.warn.mock.calls.filter(([msg]) => String(msg).includes("Ops block tool faulted")).length;
  const counters = () => getBlockProducerSnapshot();
  const pub = () => fixture.publisher.getSnapshot();

  beforeEach(async () => {
    mockLog.debug.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    __resetBlockProducerCountersForTests();
    fixture = await buildOpsFixture();
    tools = blockTools(fixture.fakeDb.db, AGENT, turn(SLACK_TS_1, THREAD_1));
  });

  afterEach(async () => {
    // AC9: across every case, the coordination-bus and team collections take no insert.
    const writes = fixture.fakeDb.operations.filter(
      (o) => NEVER_WRITTEN.includes(o.collection) && /insert|update|replace|delete/i.test(o.operation),
    );
    expect(writes).toEqual([]);
    for (const p of extraPublishers.splice(0)) await p.stop();
    await fixture.dispose();
    __resetOpsPublisherForTests();
  });

  // ── report_block ──────────────────────────────────────────────────────────

  describe("report_block", () => {
    it("critical flow: coordination on a Slack-ts turn stores one coordination-block with human-now, the agent-work subject and the work-item evidence; the tool returns before any insert", async () => {
      const hold = fixture.fakeDb.pause(OPS_EVENTS_COLLECTION, "insertOne");
      const { result, body } = await tools.report({
        kind: "coordination",
        blockedOn: "agent",
        blockedOnAgentId: "jasper",
      });
      expectNonError(result);
      expect(body).toEqual({ state: "queued", kind: "coordination" });
      // AC8 tool side: the answer landed while the insert is held.
      expect(fixture.events()).toHaveLength(0);
      hold.release();
      await fixture.drain();

      expect(agentEvents()).toHaveLength(1);
      const doc = agentEvents()[0]!;
      expect(Object.keys(doc).sort()).toEqual(D9_KEYS);
      expect(doc).toMatchObject({
        producer: HIVE_AGENT_PRODUCER,
        reasonId: REASON_COORDINATION_BLOCK,
        class: "resource",
        retry: "deterministic",
        waiting: "human-now",
        subject: { kind: BLOCK_SUBJECT_KIND, id: `${AGENT}:${THREAD_1}` },
        generation: 0,
        matchedSubscriptions: 0,
        matchedSubscriptionIds: [],
        detail: {
          agentId: AGENT,
          blockedOn: "agent",
          blockedOnAgentId: "jasper",
          workItemId: SLACK_TS_1,
          threadId: THREAD_1,
        },
        evidence: [{ kind: BLOCK_EVIDENCE_KIND_WORK_ITEM, id: SLACK_TS_1 }],
      });
      for (const absent of ["owner", "severity", "destination", "recipient", "clears", "clearsFamily"]) {
        expect(doc).not.toHaveProperty(absent);
      }
      expect(counters()).toMatchObject({ reported: 1, refused: 0, faults: 0, subjectFallback: 0 });
      expect(pub().rejected).toBe(0);
    });

    it("Edge 5: a repeated report is a renewal — same dedupeKey, generation unchanged", async () => {
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      tools.ref.current = turn(SLACK_TS_2, THREAD_1);
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      const [a, b] = agentEvents();
      expect(b!.dedupeKey).toBe(a!.dedupeKey);
      expect(b!.generation).toBe(a!.generation);
      expect(counters().reported).toBe(2);
    });

    it("Edge 6 / AC7: report → clear → report advances generation to 1 with a new dedupeKey", async () => {
      await tools.report({ kind: "coordination", blockedOn: "external" });
      await fixture.drain();
      const first = agentEvents()[0]!;
      const { body } = await tools.clear({ kind: "coordination", outcome: "resumed" });
      expect(body.state).toBe("queued");
      await fixture.drain();
      await tools.report({ kind: "coordination", blockedOn: "external" });
      await fixture.drain();
      const third = agentEvents().filter((e) => e.reasonId === REASON_COORDINATION_BLOCK)[1]!;
      expect(third.generation).toBe(1);
      expect(third.dedupeKey).not.toBe(first.dedupeKey);
    });

    it("Edge 3: an inadmissible thread falls back to the agent subject, counts subjectFallback and idOmitted, and omits detail.threadId", async () => {
      tools.ref.current = turn(SLACK_TS_1, "scheduler:mokie:daily digest run:1757000000");
      await tools.report({ kind: "semantic" });
      await fixture.drain();
      const doc = agentEvents()[0]!;
      expect(doc.subject).toEqual({ kind: BLOCK_SUBJECT_KIND, id: AGENT });
      expect(doc.detail).not.toHaveProperty("threadId");
      expect(doc.detail.workItemId).toBe(SLACK_TS_1);
      expect(counters().subjectFallback).toBe(1);
      expect(pub().idOmitted).toBe(1);
      expect(pub().rejected).toBe(0);
    });

    it("Edge 3: a composed subject id over 200 characters falls back while the admissible thread still rides detail", async () => {
      const longThread = "t".repeat(199);
      tools.ref.current = turn(SLACK_TS_1, longThread);
      await tools.report({ kind: "semantic" });
      await fixture.drain();
      const doc = agentEvents()[0]!;
      expect(doc.subject.id).toBe(AGENT);
      expect(doc.detail.threadId).toBe(longThread);
      expect(counters().subjectFallback).toBe(1);
      expect(pub().idOmitted).toBe(0);
      expect(pub().rejected).toBe(0);
    });

    it("Edge 4: an inadmissible work-item id is omitted from detail and evidence while waiting derives from the unfiltered id", async () => {
      tools.ref.current = turn("ws client asked twice", THREAD_1);
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      const doc = agentEvents()[0]!;
      expect(doc.detail).not.toHaveProperty("workItemId");
      expect(doc.evidence).toEqual([]);
      expect(doc.waiting).toBe("human-now");
      expect(doc.subject.id).toBe(`${AGENT}:${THREAD_1}`);
      expect(pub().idOmitted).toBe(1);
    });

    it("waiting derives from the live work item: team- ⇒ agent, sched:/callback:/event:/worker: ⇒ nobody", async () => {
      const cases: Array<[string, string]> = [
        ["team-river-mokie-1", "agent"],
        ["sched:mokie:daily:1757000000", "nobody"],
        ["callback:abc123", "nobody"],
        ["event:evt-1", "nobody"],
        ["worker:claim-1", "nobody"],
      ];
      for (const [id] of cases) {
        tools.ref.current = turn(id, THREAD_1);
        await tools.report({ kind: "semantic" });
      }
      await fixture.drain();
      expect(agentEvents().map((e) => e.waiting)).toEqual(cases.map(([, w]) => w));
    });

    it("Edge 18: a blockedOnAgentId naming no existing agent is stored as the bounded slug", async () => {
      await tools.report({ kind: "coordination", blockedOn: "agent", blockedOnAgentId: "no-such-agent-anywhere" });
      await fixture.drain();
      expect(agentEvents()[0]!.detail.blockedOnAgentId).toBe("no-such-agent-anywhere");
      expect(pub().rejected).toBe(0);
    });

    it("Edge 19: an epoch-resolver read fault on a report publishes at generation 0 and counts epochResolveFaults", async () => {
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      await tools.clear({ kind: "coordination", outcome: "resumed" });
      await fixture.drain();
      const before = pub().epochResolveFaults;

      fixture.fakeDb.failNext(OPS_EVENTS_COLLECTION, "findOne");
      const { result, body } = await tools.report({ kind: "coordination", blockedOn: "human" });
      expectNonError(result);
      expect(body.state).toBe("queued");
      await fixture.drain();

      const reports = agentEvents().filter((e) => e.reasonId === REASON_COORDINATION_BLOCK);
      expect(reports).toHaveLength(2);
      // Without the fault this would be generation 1; the map fallback holds no hive-agent entry.
      expect(reports[1]!.generation).toBe(0);
      expect(pub().epochResolveFaults).toBe(before + 1);
      expect(counters().faults).toBe(0);
    });

    it("Edge 21: with no live context the report still records — fallback subject, no ids, evidence [], waiting nobody", async () => {
      tools.ref.current = undefined;
      const { result, body } = await tools.report({ kind: "semantic" });
      expectNonError(result);
      expect(body.state).toBe("queued");
      await fixture.drain();
      const doc = agentEvents()[0]!;
      expect(doc.subject).toEqual({ kind: BLOCK_SUBJECT_KIND, id: AGENT });
      expect(doc.detail).toEqual({ agentId: AGENT });
      expect(doc.evidence).toEqual([]);
      expect(doc.waiting).toBe("nobody");
      expect(counters().subjectFallback).toBe(1);
      expect(pub().idOmitted).toBe(0);
    });

    it("identity is read at execution, not captured at build: a later turn's thread keys a different family", async () => {
      await tools.report({ kind: "semantic" });
      tools.ref.current = turn(SLACK_TS_2, THREAD_2);
      await tools.report({ kind: "semantic" });
      await fixture.drain();
      expect(agentEvents().map((e) => e.subject.id)).toEqual([`${AGENT}:${THREAD_1}`, `${AGENT}:${THREAD_2}`]);
      expect(agentEvents().map((e) => e.detail.workItemId)).toEqual([SLACK_TS_1, SLACK_TS_2]);
    });
  });

  // ── clear_block ───────────────────────────────────────────────────────────

  describe("clear_block", () => {
    it("Edge 7 / AC6: with nothing open, clear_block answers no-open-block and stores nothing", async () => {
      const { result, body } = await tools.clear({ kind: "coordination", outcome: "resumed" });
      expectNonError(result);
      expect(body).toEqual({ state: "no-open-block", queueIdle: true });
      await fixture.drain();
      expect(fixture.events()).toHaveLength(0);
      expect(counters()).toMatchObject({ clearNoOpen: 1, cleared: 0 });
    });

    it("critical flow / AC6 / AC15: a clear on a later turn of the same thread stores block-cleared naming the exact key", async () => {
      await tools.report({ kind: "coordination", blockedOn: "agent", blockedOnAgentId: "jasper" });
      await fixture.drain();
      const report = agentEvents()[0]!;

      tools.ref.current = turn(SLACK_TS_2, THREAD_1);
      const hold = fixture.fakeDb.pause(OPS_EVENTS_COLLECTION, "insertOne");
      const { result, body } = await tools.clear({ kind: "coordination", outcome: "resumed" });
      expectNonError(result);
      expect(body).toEqual({ state: "queued", clears: report.dedupeKey, outcome: "resumed", queueIdle: true });
      // AC8 tool side: answered while the clear's insert is held.
      expect(agentEvents()).toHaveLength(1);
      hold.release();
      await fixture.drain();

      const clear = agentEvents().find((e) => e.reasonId === REASON_BLOCK_CLEARED)!;
      expect(Object.keys(clear).sort()).toEqual([...D9_KEYS, "clears", "clearsFamily"].sort());
      expect(clear).toMatchObject({
        producer: HIVE_AGENT_PRODUCER,
        class: "informational",
        clears: report.dedupeKey,
        clearsFamily: `${HIVE_AGENT_PRODUCER}:${BLOCK_SUBJECT_KIND}:${AGENT}:${THREAD_1}:${REASON_COORDINATION_BLOCK}`,
        generation: 0,
        waiting: "nobody",
        subject: { kind: BLOCK_SUBJECT_KIND, id: `${AGENT}:${THREAD_1}` },
        detail: { agentId: AGENT, outcome: "resumed", workItemId: SLACK_TS_2, threadId: THREAD_1 },
        evidence: [{ kind: BLOCK_EVIDENCE_KIND_WORK_ITEM, id: SLACK_TS_2 }],
      });
      for (const absent of ["owner", "severity", "destination", "recipient"]) expect(clear).not.toHaveProperty(absent);

      // AC15: stored values equal the block-reasons exports.
      for (const doc of agentEvents()) {
        expect(doc.producer).toBe(HIVE_AGENT_PRODUCER);
        expect([REASON_COORDINATION_BLOCK, REASON_SEMANTIC_BLOCK, REASON_BLOCK_CLEARED]).toContain(doc.reasonId);
        expect(doc.subject.kind).toBe(BLOCK_SUBJECT_KIND);
        for (const ev of doc.evidence) {
          expect([BLOCK_EVIDENCE_KIND_WORK_ITEM, BLOCK_EVIDENCE_KIND_RULING]).toContain(ev.kind);
        }
      }

      const resourceRow = { producer: HIVE_AGENT_PRODUCER, class: "resource" } as OpsNotification;
      expect(clearingProvenanceOk(resourceRow, clear)).toBe(true);
      expect(counters()).toMatchObject({ reported: 1, cleared: 1 });
      expect(pub().rejected).toBe(0);
    });

    it("AC6 load-bearing: clear_block(semantic, resumed) without rulingRef on a Slack-ts turn is refused ruling-required, with zero ops_events operations", async () => {
      await tools.report({ kind: "semantic" });
      await fixture.drain();
      const stored = fixture.events().length;
      const opsBefore = opsEventOps().length;

      tools.ref.current = turn(SLACK_TS_2, THREAD_1);
      for (const args of [
        { kind: "semantic", outcome: "resumed" },
        { kind: "semantic", outcome: "resumed", rulingRef: "" },
      ]) {
        const { result, body } = await tools.clear(args);
        expectNonError(result);
        expect(body.state).toBe("refused");
        expect(body.reason).toBe(REFUSAL_RULING_REQUIRED);
        expect(String(body.admitted)).toContain("rulingRef");
      }
      expect(opsEventOps().length).toBe(opsBefore);
      await fixture.drain();
      expect(fixture.events()).toHaveLength(stored);
      expect(counters()).toMatchObject({ refused: 2, cleared: 0, clearNoOpen: 0 });
    });

    it("Edge 8: the ruling-required refusal wins over no-open-block when nothing is open", async () => {
      const opsBefore = opsEventOps().length;
      const { result, body } = await tools.clear({ kind: "semantic", outcome: "cancelled" });
      expectNonError(result);
      expect(body).toMatchObject({ state: "refused", reason: REFUSAL_RULING_REQUIRED });
      expect(opsEventOps()).toHaveLength(opsBefore);
      expect(counters()).toMatchObject({ refused: 1, clearNoOpen: 0 });
    });

    it("AC6: a semantic clear citing a ruling stores ruling + work-item evidence and passes judgment provenance; the same clear with evidence [] does not", async () => {
      await tools.report({ kind: "semantic" });
      await fixture.drain();
      tools.ref.current = turn(SLACK_TS_2, THREAD_1);
      const { result, body } = await tools.clear({
        kind: "semantic",
        outcome: "resumed",
        rulingRef: "KPR-451#comment-60079ae4",
      });
      expectNonError(result);
      expect(body.state).toBe("queued");
      await fixture.drain();

      const clear = agentEvents().find((e) => e.reasonId === REASON_BLOCK_CLEARED)!;
      expect(clear.evidence).toEqual([
        { kind: BLOCK_EVIDENCE_KIND_RULING, id: "KPR-451#comment-60079ae4" },
        { kind: BLOCK_EVIDENCE_KIND_WORK_ITEM, id: SLACK_TS_2 },
      ]);
      const judgmentRow = { producer: HIVE_AGENT_PRODUCER, class: "judgment" } as OpsNotification;
      expect(clearingProvenanceOk(judgmentRow, clear)).toBe(true);
      expect(clearingProvenanceOk(judgmentRow, { ...clear, evidence: [] })).toBe(false);
    });

    it("Edge 9: a report and a clear in one turn — the flush makes the report visible and the clear succeeds", async () => {
      await tools.report({ kind: "coordination", blockedOn: "human" });
      // No drain: the clear's own bounded flush is the only barrier.
      const { body } = await tools.clear({ kind: "coordination", outcome: "cancelled" });
      expect(body).toMatchObject({ state: "queued", queueIdle: true, outcome: "cancelled" });
      await fixture.drain();
      const clear = agentEvents().find((e) => e.reasonId === REASON_BLOCK_CLEARED)!;
      expect(clear.clears).toBe(agentEvents()[0]!.dedupeKey);
    });

    it(
      "Edge 9: with the drainer held inside an insert, the clear waits one real FLUSH_DEADLINE_MS and answers a qualified no-open-block",
      async () => {
        const hold = fixture.fakeDb.pause(OPS_EVENTS_COLLECTION, "insertOne");
        await tools.report({ kind: "coordination", blockedOn: "human" });
        await hold.reached;

        const started = Date.now();
        const { result, body } = await tools.clear({ kind: "coordination", outcome: "resumed" });
        expect(Date.now() - started).toBeGreaterThanOrEqual(FLUSH_DEADLINE_MS);
        expectNonError(result);
        expect(body).toEqual({ state: "no-open-block", queueIdle: false });
        expect(counters().clearNoOpen).toBe(1);

        hold.release();
        await fixture.drain();
        expect(agentEvents().map((e) => e.reasonId)).toEqual([REASON_COORDINATION_BLOCK]);
      },
      FLUSH_DEADLINE_MS * 5,
    );

    it("Edge 10: two agents on one thread — one agent's clear leaves the other's block open", async () => {
      const other = blockTools(fixture.fakeDb.db, "river", turn(SLACK_TS_1, THREAD_1));
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await other.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      expect(new Set(agentEvents().map((e) => e.dedupeKey)).size).toBe(2);

      const { body } = await tools.clear({ kind: "coordination", outcome: "resumed" });
      expect(body.state).toBe("queued");
      await fixture.drain();

      const riverKey = { producer: HIVE_AGENT_PRODUCER, reasonId: REASON_COORDINATION_BLOCK };
      expect(
        await fixture.publisher.findOpenCondition({
          ...riverKey,
          subject: { kind: BLOCK_SUBJECT_KIND, id: `river:${THREAD_1}` },
        }),
      ).toBeDefined();
      expect(
        await fixture.publisher.findOpenCondition({
          ...riverKey,
          subject: { kind: BLOCK_SUBJECT_KIND, id: `${AGENT}:${THREAD_1}` },
        }),
      ).toBeUndefined();
      expect(agentEvents().find((e) => e.reasonId === REASON_BLOCK_CLEARED)!.detail.agentId).toBe(AGENT);
    });

    it("Edge 17 / AC2: an explicit threadId override names the other family while detail stays the clearing turn's own", async () => {
      // Nothing open on the override family ⇒ no-open-block.
      tools.ref.current = turn(SLACK_TS_2, THREAD_2);
      const none = await tools.clear({ kind: "coordination", outcome: "resumed", threadId: THREAD_1 });
      expectNonError(none.result);
      expect(none.body.state).toBe("no-open-block");

      // Raised on T1, cleared from T2 naming T1.
      tools.ref.current = turn(SLACK_TS_1, THREAD_1);
      await tools.report({ kind: "coordination", blockedOn: "agent" });
      await fixture.drain();
      tools.ref.current = turn(SLACK_TS_3, THREAD_2);
      const { body } = await tools.clear({ kind: "coordination", outcome: "resumed", threadId: THREAD_1 });
      expect(body.state).toBe("queued");
      await fixture.drain();

      const clear = agentEvents().find((e) => e.reasonId === REASON_BLOCK_CLEARED)!;
      expect(clear.clearsFamily).toBe(
        `${HIVE_AGENT_PRODUCER}:${BLOCK_SUBJECT_KIND}:${AGENT}:${THREAD_1}:${REASON_COORDINATION_BLOCK}`,
      );
      expect(clear.detail.threadId).toBe(THREAD_2);
      expect(clear.detail.workItemId).toBe(SLACK_TS_3);
    });

    it("Edge 14 / AC7: a clear through a new OpsPublisher over the same database (simulated restart) finds and clears the block", async () => {
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      const key = agentEvents()[0]!.dedupeKey;
      await fixture.publisher.stop();

      const restarted = new OpsPublisher(fixture.fakeDb.db, RETENTION_DAYS);
      extraPublishers.push(restarted);
      await restarted.init();
      setOpsPublisher(restarted);
      expect(restarted.getSnapshot().openConditions).toBe(0);

      tools.ref.current = turn(SLACK_TS_2, THREAD_1);
      const { result, body } = await tools.clear({ kind: "coordination", outcome: "resumed" });
      expectNonError(result);
      expect(body).toMatchObject({ state: "queued", clears: key });
      await restarted.__drainForTests();
      expect(agentEvents().find((e) => e.reasonId === REASON_BLOCK_CLEARED)!.clears).toBe(key);
    });

    it("Edge 24 / AC7: a findOne fault armed on a drained queue answers unavailable/fault non-isError, counts faults, warns once, stores nothing", async () => {
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      const stored = fixture.events().length;

      fixture.fakeDb.failNext(OPS_EVENTS_COLLECTION, "findOne");
      const { result, body } = await tools.clear({ kind: "coordination", outcome: "resumed" });
      expectNonError(result);
      expect(body).toEqual({ state: "unavailable", cause: "fault" });
      expect(counters()).toMatchObject({ faults: 1, unavailable: 0, cleared: 0 });
      expect(faultWarns()).toBe(1);
      const [, payload] = mockLog.warn.mock.calls.find(([msg]) => String(msg).includes("Ops block tool faulted"))!;
      expect(payload).toEqual({ tool: CLEAR_BLOCK_TOOL, error: "Error: injected" });

      await fixture.drain();
      expect(fixture.events()).toHaveLength(stored);
      expect(agentEvents().filter((e) => e.reasonId === REASON_BLOCK_CLEARED)).toHaveLength(0);
      expect(runtimeEvents()).toHaveLength(0);
    });
  });

  // ── AC5: the handler value matrix ─────────────────────────────────────────

  describe("AC5 handler matrix", () => {
    it("every report_block value refusal answers non-isError refused with its code, counts refused, leaves rejected unchanged and stores nothing", async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ kind: "waiting" }, REFUSAL_KIND],
        [{ kind: "" }, REFUSAL_KIND],
        [{ kind: "coordination" }, REFUSAL_BLOCKED_ON],
        [{ kind: "coordination", blockedOn: "robot" }, REFUSAL_BLOCKED_ON],
        [{ kind: "coordination", blockedOn: "" }, REFUSAL_BLOCKED_ON],
        [{ kind: "semantic", blockedOn: "agent" }, REFUSAL_BLOCKED_ON],
        [{ kind: "semantic", blockedOnAgentId: "jasper" }, REFUSAL_BLOCKED_ON_AGENT_ID],
        [{ kind: "coordination", blockedOn: "human", blockedOnAgentId: "jasper" }, REFUSAL_BLOCKED_ON_AGENT_ID],
        [{ kind: "coordination", blockedOn: "agent", blockedOnAgentId: "" }, REFUSAL_BLOCKED_ON_AGENT_ID],
        [{ kind: "coordination", blockedOn: "agent", blockedOnAgentId: "has space" }, REFUSAL_BLOCKED_ON_AGENT_ID],
        [{ kind: "coordination", blockedOn: "agent", blockedOnAgentId: "Jasper" }, REFUSAL_BLOCKED_ON_AGENT_ID],
        [{ kind: "coordination", blockedOn: "agent", blockedOnAgentId: "agents/jasper" }, REFUSAL_BLOCKED_ON_AGENT_ID],
        // Credential-shaped values the slug rule refuses (a letter-leading lowercase hex string is slug-shaped by D6's rule).
        ...[CREDENTIAL_SHAPED[0]!, CREDENTIAL_SHAPED[2]!, "0a94a8fe5ccb19ba61c4c0873d391e987982fbbd"].map(
          (c): [Record<string, unknown>, string] => [
            { kind: "coordination", blockedOn: "agent", blockedOnAgentId: c },
            REFUSAL_BLOCKED_ON_AGENT_ID,
          ],
        ),
      ];
      for (const [i, [args, reason]] of cases.entries()) {
        const { result, body } = await tools.report(args);
        expectNonError(result);
        expect(body, JSON.stringify(args)).toMatchObject({ state: "refused", reason });
        expect(typeof body.admitted).toBe("string");
        expect(counters().refused).toBe(i + 1);
      }
      await fixture.drain();
      expect(fixture.events()).toHaveLength(0);
      expect(pub().rejected).toBe(0);
      expect(counters().reported).toBe(0);
    });

    it("every clear_block value refusal answers non-isError refused with its code, and a credential-shaped rulingRef is never stored", async () => {
      // An open semantic AND coordination block, so a wrongly admitted value would store a clear.
      await tools.report({ kind: "semantic" });
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      const stored = fixture.events().length;

      const cases: Array<[Record<string, unknown>, string]> = [
        [{ kind: "", outcome: "resumed" }, REFUSAL_KIND],
        [{ kind: "waiting", outcome: "resumed" }, REFUSAL_KIND],
        [{ kind: "coordination", outcome: "done" }, REFUSAL_OUTCOME],
        [{ kind: "coordination", outcome: "" }, REFUSAL_OUTCOME],
        [{ kind: "coordination", outcome: "escalated" }, REFUSAL_OUTCOME],
        ...["/", "https://example.com/ruling", "the CEO said yes", ...CREDENTIAL_SHAPED].flatMap(
          (ref): Array<[Record<string, unknown>, string]> => [
            [{ kind: "semantic", outcome: "resumed", rulingRef: ref }, REFUSAL_RULING_REF_SHAPE],
            [{ kind: "coordination", outcome: "resumed", rulingRef: ref }, REFUSAL_RULING_REF_SHAPE],
          ],
        ),
        [{ kind: "coordination", outcome: "resumed", threadId: "has space" }, REFUSAL_THREAD_ID_SHAPE],
        [{ kind: "coordination", outcome: "resumed", threadId: "a/b" }, REFUSAL_THREAD_ID_SHAPE],
        [{ kind: "coordination", outcome: "resumed", threadId: "" }, REFUSAL_THREAD_ID_SHAPE],
        [{ kind: "semantic", outcome: "resumed" }, REFUSAL_RULING_REQUIRED],
        [{ kind: "semantic", outcome: "resumed", rulingRef: "" }, REFUSAL_RULING_REQUIRED],
      ];
      const answers: Array<{ args: Record<string, unknown>; reason: string; result: ToolAnswer; body: Body }> = [];
      for (const [args, reason] of cases) answers.push({ args, reason, ...(await tools.clear(args)) });
      await fixture.drain();

      // The accepted outcome is refusal, not storage: nothing stored is asserted first.
      const serialized = JSON.stringify(fixture.events());
      for (const c of CREDENTIAL_SHAPED) expect(serialized).not.toContain(c);
      expect(fixture.events()).toHaveLength(stored);
      expect(pub().rejected).toBe(0);

      for (const { args, reason, result, body } of answers) {
        expectNonError(result);
        expect(body, JSON.stringify(args)).toMatchObject({ state: "refused", reason });
      }
      expect(counters()).toMatchObject({ refused: cases.length, cleared: 0, clearNoOpen: 0 });
    });

    it("each RULING_REF_RE shape is admitted and stored verbatim as evidence[].id", async () => {
      for (const [i, ref] of RULING_REFS.entries()) {
        tools.ref.current = turn(SLACK_TS_1, `${THREAD_1}.${i}`);
        await tools.report({ kind: "semantic" });
        await fixture.drain();
        const { result, body } = await tools.clear({ kind: "semantic", outcome: "resumed", rulingRef: ref });
        expectNonError(result);
        expect(body.state).toBe("queued");
        await fixture.drain();
      }
      const clears = agentEvents().filter((e) => e.reasonId === REASON_BLOCK_CLEARED);
      expect(clears.map((c) => c.evidence[0])).toEqual(
        RULING_REFS.map((id) => ({ kind: BLOCK_EVIDENCE_KIND_RULING, id })),
      );
      expect(pub().rejected).toBe(0);
    });

    it("a credential-shaped threadId override passes the shape rule, answers no-open-block and stores nothing", async () => {
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      const stored = fixture.events().length;
      for (const c of CREDENTIAL_SHAPED) {
        const { result, body } = await tools.clear({ kind: "coordination", outcome: "resumed", threadId: c });
        expectNonError(result);
        expect(body.state).toBe("no-open-block");
      }
      await fixture.drain();
      expect(fixture.events()).toHaveLength(stored);
      const serialized = JSON.stringify(fixture.events());
      for (const c of CREDENTIAL_SHAPED) expect(serialized).not.toContain(c);
      expect(counters()).toMatchObject({ clearNoOpen: CREDENTIAL_SHAPED.length, refused: 0 });
    });

    it("every legal parameter combination for both tools drains with rejected === 0 and stores each document", async () => {
      const reportCombos: Array<Record<string, unknown>> = [
        { kind: "coordination", blockedOn: "agent" },
        { kind: "coordination", blockedOn: "agent", blockedOnAgentId: "jasper" },
        { kind: "coordination", blockedOn: "human" },
        { kind: "coordination", blockedOn: "external" },
        { kind: "semantic" },
      ];
      let n = 0;
      let expected = 0;
      for (const args of reportCombos) {
        tools.ref.current = turn(SLACK_TS_1, `r${n++}`);
        const { body } = await tools.report(args);
        expect(body.state).toBe("queued");
        expected += 1;
      }
      await fixture.drain();
      expect(agentEvents()).toHaveLength(expected);

      const rulings: Array<string | undefined> = [undefined, "", ...RULING_REFS];
      for (const kind of ["coordination", "semantic"]) {
        for (const outcome of ["resumed", "cancelled"]) {
          for (const rulingRef of rulings) {
            if (kind === "semantic" && (rulingRef === undefined || rulingRef === "")) continue;
            for (const override of [false, true]) {
              const thread = `c${n++}`;
              tools.ref.current = turn(SLACK_TS_1, thread);
              await tools.report(kind === "semantic" ? { kind } : { kind, blockedOn: "human" });
              await fixture.drain();
              if (override) tools.ref.current = turn(SLACK_TS_2, `other${n}`);
              const args: Record<string, unknown> = { kind, outcome };
              if (rulingRef !== undefined) args.rulingRef = rulingRef;
              if (override) args.threadId = thread;
              const { result, body } = await tools.clear(args);
              expectNonError(result);
              expect(body.state, JSON.stringify(args)).toBe("queued");
              await fixture.drain();
              expected += 2;
            }
          }
        }
      }
      expect(agentEvents()).toHaveLength(expected);
      expect(pub().rejected).toBe(0);
      expect(counters().refused).toBe(0);
    });

    it("no stored field contains any fragment of a prose-shaped live workItemId or threadId; each is omitted and counted", async () => {
      tools.ref.current = turn("ws zanzibar quokka request", "voice marmalade platypus session");
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      const { body } = await tools.clear({ kind: "coordination", outcome: "resumed" });
      expect(body.state).toBe("queued");
      await fixture.drain();

      expect(agentEvents()).toHaveLength(2);
      const serialized = JSON.stringify(fixture.events());
      for (const fragment of ["zanzibar", "quokka", "marmalade", "platypus", "request", "session"]) {
        expect(serialized).not.toContain(fragment);
      }
      expect(pub().idOmitted).toBe(4);
      expect(pub().rejected).toBe(0);
    });
  });

  // ── AC10 / Edges 1–2: kill switch and boot window ─────────────────────────

  describe("AC10 kill switch and boot window", () => {
    it("Edge 1: with the singleton unset both tools answer unavailable/publisher-unset non-isError and nothing is written", async () => {
      __resetOpsPublisherForTests();
      const opsBefore = opsEventOps().length;
      const r = await tools.report({ kind: "coordination", blockedOn: "human" });
      const c = await tools.clear({ kind: "coordination", outcome: "resumed" });
      for (const { result, body } of [r, c]) {
        expectNonError(result);
        expect(body).toEqual({ state: "unavailable", cause: "publisher-unset" });
      }
      expect(counters()).toMatchObject({ unavailable: 2, faults: 0 });
      await fixture.drain();
      expect(fixture.events()).toHaveLength(0);
      expect(opsEventOps()).toHaveLength(opsBefore);
    });

    it("Edge 2: coordination-block disabled before init ⇒ disabled for coordination, semantic still works, and the disable survives a second init", async () => {
      await fixture.dispose();
      __resetBlockProducerCountersForTests();
      fixture = await buildOpsFixture({ init: false });
      fixture.fakeDb.collection(OPS_REASONS_COLLECTION).rows.push({
        _id: `${HIVE_AGENT_PRODUCER}:${REASON_COORDINATION_BLOCK}`,
        producer: HIVE_AGENT_PRODUCER,
        reasonId: REASON_COORDINATION_BLOCK,
        enabled: false,
      });
      await fixture.publisher.init();
      tools = blockTools(fixture.fakeDb.db, AGENT, turn(SLACK_TS_1, THREAD_1));

      const { result, body } = await tools.report({ kind: "coordination", blockedOn: "human" });
      expectNonError(result);
      expect(body).toEqual({ state: "disabled" });
      expect(counters().disabled).toBe(1);

      const semantic = await tools.report({ kind: "semantic" });
      expect(semantic.body.state).toBe("queued");
      await fixture.drain();
      expect(agentEvents().map((e) => e.reasonId)).toEqual([REASON_SEMANTIC_BLOCK]);
      expect(pub().rejected).toBe(0);
      expect(runtimeEvents()).toHaveLength(0);

      await fixture.publisher.init();
      const again = await tools.report({ kind: "coordination", blockedOn: "human" });
      expect(again.body).toEqual({ state: "disabled" });
      expect(counters().disabled).toBe(2);
    });

    it("a coordination block opened before the disable is still cleared afterwards — one block-cleared, rejected unchanged", async () => {
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      const row = fixture.fakeDb
        .collection(OPS_REASONS_COLLECTION)
        .rows.find((r) => r._id === `${HIVE_AGENT_PRODUCER}:${REASON_COORDINATION_BLOCK}`)!;
      row.enabled = false;
      await fixture.publisher.init();
      const rejectedBefore = pub().rejected;

      expect((await tools.report({ kind: "coordination", blockedOn: "human" })).body).toEqual({ state: "disabled" });
      const { result, body } = await tools.clear({ kind: "coordination", outcome: "cancelled" });
      expectNonError(result);
      expect(body.state).toBe("queued");
      await fixture.drain();
      expect(agentEvents().filter((e) => e.reasonId === REASON_BLOCK_CLEARED)).toHaveLength(1);
      expect(pub().rejected).toBe(rejectedBefore);
    });

    it("block-cleared disabled ⇒ clear_block answers disabled non-isError and reads nothing", async () => {
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      fixture.fakeDb
        .collection(OPS_REASONS_COLLECTION)
        .rows.find((r) => r._id === `${HIVE_AGENT_PRODUCER}:${REASON_BLOCK_CLEARED}`)!.enabled = false;
      await fixture.publisher.init();
      const opsBefore = opsEventOps().length;

      const { result, body } = await tools.clear({ kind: "coordination", outcome: "resumed" });
      expectNonError(result);
      expect(body).toEqual({ state: "disabled" });
      expect(counters().disabled).toBe(1);
      expect(opsEventOps().length).toBe(opsBefore);
      await fixture.drain();
      expect(agentEvents().filter((e) => e.reasonId === REASON_BLOCK_CLEARED)).toHaveLength(0);
    });
  });

  // ── AC8 / AC9 / AC11 / Edge 13 ────────────────────────────────────────────

  describe("ordering, nothing about itself, and faults", () => {
    it("AC8: a report_block issued between two tool failures is stored between them, and openConditions is unchanged by block reports and clears", async () => {
      observeToolFailure({ tool: "mcp__alpha__one", error: "boom", lane: "claude" });
      await tools.report({ kind: "coordination", blockedOn: "human" });
      observeToolFailure({ tool: "mcp__beta__two", error: "boom", lane: "claude" });
      await fixture.drain();

      const stored = [...fixture.events()].sort(compareStored);
      expect(stored.map((e) => [e.producer, e.reasonId])).toEqual([
        [HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED],
        [HIVE_AGENT_PRODUCER, REASON_COORDINATION_BLOCK],
        [HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED],
      ]);
      const baseline = pub().openConditions;
      expect(baseline).toBe(2);

      await tools.report({ kind: "semantic" });
      await tools.clear({ kind: "coordination", outcome: "resumed" });
      await fixture.drain();
      expect(agentEvents()).toHaveLength(3);
      expect(pub().openConditions).toBe(baseline);
    });

    it("AC9: unavailable, disabled, refused, no-open-block and the caught fault each store no ops_events document and count their own counter", async () => {
      const steps: Array<
        [string, () => Promise<{ result: ToolAnswer; body: Body }>, keyof ReturnType<typeof counters>]
      > = [
        ["refused", () => tools.report({ kind: "nope" }), "refused"],
        ["no-open-block", () => tools.clear({ kind: "coordination", outcome: "resumed" }), "clearNoOpen"],
        [
          "fault",
          async () => {
            fixture.fakeDb.failNext(OPS_EVENTS_COLLECTION, "findOne");
            return tools.clear({ kind: "coordination", outcome: "resumed" });
          },
          "faults",
        ],
        [
          "disabled",
          async () => {
            fixture.fakeDb
              .collection(OPS_REASONS_COLLECTION)
              .rows.find((r) => r._id === `${HIVE_AGENT_PRODUCER}:${REASON_SEMANTIC_BLOCK}`)!.enabled = false;
            await fixture.publisher.init();
            return tools.report({ kind: "semantic" });
          },
          "disabled",
        ],
        [
          "unavailable",
          async () => {
            __resetOpsPublisherForTests();
            return tools.report({ kind: "semantic" });
          },
          "unavailable",
        ],
      ];
      for (const [name, step, counter] of steps) {
        const before = counters()[counter];
        const { result } = await step();
        expectNonError(result);
        expect(counters()[counter], name).toBe(before + 1);
        await fixture.drain();
        expect(fixture.events(), name).toHaveLength(0);
      }
      expect(faultWarns()).toBe(1);
    });

    it("AC11 (i): a throwing enqueuePublish double makes each tool answer unavailable/fault non-isError, faults +1, one warn, nothing stored", async () => {
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      const stored = fixture.events().length;

      const spy = vi.spyOn(fixture.publisher, "enqueuePublish").mockImplementation(() => {
        throw new Error("enqueue double");
      });
      try {
        const r = await tools.report({ kind: "semantic" });
        expectNonError(r.result);
        expect(r.body).toEqual({ state: "unavailable", cause: "fault" });
        expect(counters().faults).toBe(1);
        expect(faultWarns()).toBe(1);

        const c = await tools.clear({ kind: "coordination", outcome: "resumed" });
        expectNonError(c.result);
        expect(c.body).toEqual({ state: "unavailable", cause: "fault" });
        expect(counters().faults).toBe(2);
        expect(faultWarns()).toBe(2);
      } finally {
        spy.mockRestore();
      }
      await fixture.drain();
      expect(fixture.events()).toHaveLength(stored);
      expect(runtimeEvents()).toHaveLength(0);
      expect(counters()).toMatchObject({ reported: 1, cleared: 0, unavailable: 0 });
    });

    it("AC11 (iii) / Edge 13: an insert rejecting once under each tool — each answers queued; after drain publishFaults +1 per call and nothing stored", async () => {
      fixture.fakeDb.failNext(OPS_EVENTS_COLLECTION, "insertOne");
      const r = await tools.report({ kind: "coordination", blockedOn: "human" });
      expectNonError(r.result);
      expect(r.body.state).toBe("queued");
      await fixture.drain();
      expect(pub().publishFaults).toBe(1);
      expect(fixture.events()).toHaveLength(0);

      // A stored block for the clear to name.
      await tools.report({ kind: "coordination", blockedOn: "human" });
      await fixture.drain();
      expect(agentEvents()).toHaveLength(1);

      fixture.fakeDb.failNext(OPS_EVENTS_COLLECTION, "insertOne");
      const c = await tools.clear({ kind: "coordination", outcome: "resumed" });
      expectNonError(c.result);
      expect(c.body.state).toBe("queued");
      await fixture.drain();
      expect(pub().publishFaults).toBe(2);
      expect(agentEvents()).toHaveLength(1);
      expect(runtimeEvents()).toHaveLength(0);
      expect(counters().faults).toBe(0);
    });

    it("Edge 13: a job refused by the stopping latch after a queued answer counts drainDropped and stores nothing", async () => {
      await fixture.publisher.stop();
      const before = pub().drainDropped;
      const { result, body } = await tools.report({ kind: "semantic" });
      expectNonError(result);
      expect(body.state).toBe("queued");
      await fixture.drain();
      expect(pub().drainDropped).toBe(before + 1);
      expect(fixture.events()).toHaveLength(0);
    });

    it("Edge 13: enqueuing past the queue depth with the drainer held drops the oldest block job and counts queueOverflow", async () => {
      const hold = fixture.fakeDb.pause(OPS_EVENTS_COLLECTION, "insertOne");
      await tools.report({ kind: "semantic" }); // taken by the drainer, held inside its insert
      await hold.reached;

      tools.ref.current = turn(SLACK_TS_2, THREAD_2);
      const { body } = await tools.report({ kind: "coordination", blockedOn: "human" }); // oldest queued job
      expect(body.state).toBe("queued");

      const depth = 1000; // PUBLISH_QUEUE_DEPTH
      const filler = {
        ...reportInput("1757000000.000777"),
        reasonId: REASON_SEMANTIC_BLOCK,
        detail: { agentId: AGENT },
      };
      for (let i = 0; i < depth; i++) fixture.publisher.enqueuePublish(filler);
      expect(pub().queueOverflow).toBe(1);

      hold.release();
      await fixture.drain();
      expect(agentEvents().filter((e) => e.subject.id === `${AGENT}:${THREAD_2}`)).toHaveLength(0);
      expect(runtimeEvents()).toHaveLength(0);
      // The held job plus the fillers; the dropped block job is the only loss.
      expect(agentEvents()).toHaveLength(depth + 1);
    }, 30_000);
  });
});
