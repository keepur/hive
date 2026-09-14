import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `store.ts` and `publisher.ts` call `createLogger` at module load; the mock
// hands back the SAME object every call so cases can count warn lines by
// message fragment (vi.hoisted — vi.mock factories hoist above top-level consts).
const mockLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));

import {
  buildClaudeLaneHarness,
  buildLaneBHarness,
  buildOpsFixture,
  makeHarnessAgentConfig,
  type OpsFixture,
} from "./testing/lane-harness.js";
import { OpsPublisher } from "./publisher.js";
import { observeToolFailure } from "./observe.js";
import { HIVE_RUNTIME_PRODUCER, REASON_TOOL_FAILED, REASON_TOOL_RECOVERED } from "./reasons.js";
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
import {
  AgentRunner,
  type AgentRunnerOptions,
  type WorkItemContext,
  type WorkItemContextRef,
} from "../agents/agent-runner.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import { IN_PROCESS_PORTED_SERVERS } from "../agents/in-process-servers.js";
import { TURN_CONTEXT_DEPENDENT_SERVERS } from "../agents/server-traits.js";
import { WORKER_SERVER_DENYLIST } from "../workers/meeting-worker-pool.js";
import type { ToolBridge } from "../agents/provider-adapters/tool-bridge.js";
import { partitionInventoryForProvider } from "../agents/provider-adapters/tool-transport.js";
import { createEventBusMcpServer } from "../events/event-bus-mcp-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

// ───────────────────────────────────────────────────────────────────────────
// Surface and containment (Task 6): REAL `AgentRunner`s holding the fixture's
// database, asserted on the BUILT server set (`buildInProcessServers`) and the
// `buildToolTransportInventory` output — never on a config array alone
// (CLAUDE.md, KPR-390). The Lane B case executes through a REAL `ToolBridge`
// on its in-process `connect()` path. Every connected case takes its own
// runner: `McpServer.connect` throws on a second connect of one instance.
// ───────────────────────────────────────────────────────────────────────────

/** A memory manager the built-set drive never reaches (no `memory` in any coreServers here). */
const UNUSED_MEMORY_MANAGER = {} as unknown as MemoryManager;

function runnerWithDb(
  db: Db,
  coreServers: string[],
  runnerOptions?: AgentRunnerOptions,
  identity: { id: string; name: string } = { id: AGENT, name: "Mokie" },
): AgentRunner {
  // Positional shape of `agent-runner.test.ts`'s `makeRunnerWithDb`, plus the
  // trailing runner options the worker pool's adapter factory passes.
  return new AgentRunner(
    makeHarnessAgentConfig({ ...identity, coreServers }),
    UNUSED_MEMORY_MANAGER,
    [],
    new Map(),
    "{}",
    undefined,
    undefined,
    db,
    undefined,
    undefined,
    runnerOptions,
  );
}

describe("KPR-501 block tools — surface, worker containment and Lane B execution (AC1, D2, Edges 11–12)", () => {
  let fixture: OpsFixture;
  const bridges: ToolBridge[] = [];

  beforeEach(async () => {
    mockLog.debug.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    __resetBlockProducerCountersForTests();
    fixture = await buildOpsFixture();
  });

  afterEach(async () => {
    for (const b of bridges.splice(0)) await b.close();
    await fixture.dispose();
    __resetOpsPublisherForTests();
  });

  it("AC1: the event-bus server a db-holding runner with coreServers [event-bus] builds lists report_block and clear_block", async () => {
    const context = turn(SLACK_TS_1, THREAD_1);
    const runner = runnerWithDb(fixture.fakeDb.db, ["event-bus"]);
    const built = runner.buildInProcessServers(context);
    // Containment of event-bus, never set equality — the auto-injected servers ride along.
    expect(Object.keys(built)).toContain("event-bus");

    // Listed through a connected client over the server's own request handler
    // (the `connectInProcess` shape). This runner's instance is connected once.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await built["event-bus"]!.instance.connect(serverTransport);
    const client = new Client({ name: "kpr-501-surface", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["emit_event", REPORT_BLOCK_TOOL, CLEAR_BLOCK_TOOL]));
    } finally {
      await client.close();
    }
  });

  it("AC1: a db-holding runner whose coreServers omit event-bus builds no event-bus server", () => {
    const runner = runnerWithDb(fixture.fakeDb.db, ["contacts"]);
    const built = Object.keys(runner.buildInProcessServers(turn(SLACK_TS_1, THREAD_1)));
    // The db gate is open (a sibling in-process server was built), so the absence is not vacuous.
    expect(built).toContain("contacts");
    expect(built).not.toContain("event-bus");
  });

  it("Edge 11: a worker-mode runner (suppressAutoInjectedServers, denylist-filtered coreServers from [event-bus]) has no event-bus in its built set or its inventory", () => {
    const context = turn(SLACK_TS_1, THREAD_1);
    // Mirrors `spawnFetchWorker`'s role construction: boss coreServers minus the denylist.
    const bossCoreServers = ["event-bus"];
    const workerCoreServers = bossCoreServers.filter((s) => !WORKER_SERVER_DENYLIST.has(s));
    const worker = runnerWithDb(fixture.fakeDb.db, workerCoreServers, { suppressAutoInjectedServers: true });

    expect(Object.keys(worker.buildInProcessServers(context))).not.toContain("event-bus");
    const inventory = worker.buildToolTransportInventory(context).map((e) => e.name);
    expect(inventory).not.toContain("event-bus");
    for (const name of [REPORT_BLOCK_TOOL, CLEAR_BLOCK_TOOL]) {
      expect(inventory.some((n) => n.includes(name))).toBe(false);
    }

    // Control: the same worker-mode construction WITHOUT the denylist filter
    // does build event-bus — so the denylist, not the db gate or the
    // suppression flag, is what keeps the block tools off a contained worker.
    const unfiltered = runnerWithDb(fixture.fakeDb.db, bossCoreServers, { suppressAutoInjectedServers: true });
    expect(Object.keys(unfiltered.buildInProcessServers(context))).toContain("event-bus");
  });

  it("AC1 / D14: IN_PROCESS_PORTED_SERVERS, WORKER_SERVER_DENYLIST and TURN_CONTEXT_DEPENDENT_SERVERS keep their current membership", () => {
    // Pinned literally. A future legitimate change to any of these sets updates
    // this pin TOGETHER WITH a KPR-501 containment re-check — the pin records
    // what the block tools' containment was verified against; it is not a
    // prohibition on changing the sets.
    expect([...IN_PROCESS_PORTED_SERVERS].sort()).toEqual(
      [
        "admin",
        "callback",
        "code-search",
        "contacts",
        "event-bus",
        "memory",
        "schedule",
        "structured-memory",
        "team",
        "worker-pool",
        "workflow",
      ].sort(),
    );
    expect([...WORKER_SERVER_DENYLIST].sort()).toEqual(
      [
        "admin",
        "background",
        "callback",
        "code-task",
        "event-bus",
        "keychain",
        "quo",
        "recall",
        "resend",
        "schedule",
        "slack",
        "team",
        "voice",
        "worker-pool",
      ].sort(),
    );
    expect([...TURN_CONTEXT_DEPENDENT_SERVERS].sort()).toEqual(
      ["background", "callback", "code-task", "recall", "structured-memory", "worker-pool"].sort(),
    );
  });

  it("Edge 12 / AC1: the Lane B partitioned inventory bridges event-bus in-process, and report_block executed through connect() stores the same document as the handler path", async () => {
    const context = turn(SLACK_TS_1, THREAD_1);
    const args = { kind: "coordination", blockedOn: "agent", blockedOnAgentId: "jasper" };

    // ── Handler-direct path, first fixture: a first report at generation 0.
    const direct = blockTools(fixture.fakeDb.db, AGENT, context);
    const { result: directResult, body: directBody } = await direct.report(args);
    expectNonError(directResult);
    expect(directBody).toEqual({ state: "queued", kind: "coordination" });
    await fixture.drain();
    const directDocs = fixture.events().filter((e) => e.producer === HIVE_AGENT_PRODUCER);
    expect(directDocs).toHaveLength(1);
    const directDoc = directDocs[0]!;

    // ── Lane B path, a separate fixture so its document is also a first report.
    await fixture.dispose();
    fixture = await buildOpsFixture();
    const runner = runnerWithDb(fixture.fakeDb.db, ["event-bus"]);
    const inventory = runner.buildToolTransportInventory(context);
    const { bridgeable } = partitionInventoryForProvider(inventory, "codex");
    const entry = bridgeable.find((e) => e.name === "event-bus");
    expect(entry).toMatchObject({
      name: "event-bus",
      transport: "sdk-in-process",
      inProcess: true,
      compatibility: { codex: "requires-hive-bridge", laneB: "requires-hive-bridge" },
    });
    expect(entry).not.toHaveProperty("serverConfig");

    const inProcessServers = runner.buildInProcessServers(context);
    const harness = buildLaneBHarness({
      bridge: {
        inventory: [entry!],
        inProcessServers: { "event-bus": inProcessServers["event-bus"]! },
        workItemContext: context,
      },
    });
    bridges.push(harness.bridge);
    const connected = await harness.bridge.connect();
    expect(harness.bridge.runtimeOmissions).toEqual([]);
    const names = connected.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([`mcp__event-bus__${REPORT_BLOCK_TOOL}`, `mcp__event-bus__${CLEAR_BLOCK_TOOL}`]),
    );
    const bridged = connected.find((t) => t.name === `mcp__event-bus__${REPORT_BLOCK_TOOL}`)!;

    const text = await bridged.execute(args);
    // The handler's JSON text, not a thrown error or the containment prefix.
    expect(JSON.parse(text)).toEqual({ state: "queued", kind: "coordination" });
    expect(harness.abortController.signal.aborted).toBe(false);
    await fixture.drain();

    const laneBDocs = fixture.events().filter((e) => e.producer === HIVE_AGENT_PRODUCER);
    expect(laneBDocs).toHaveLength(1);
    expect(fixture.events().filter((e) => e.producer === HIVE_RUNTIME_PRODUCER)).toHaveLength(0);
    const laneBDoc = laneBDocs[0]!;

    expect(Object.keys(laneBDoc).sort()).toEqual(D9_KEYS);
    expect(Object.keys(directDoc).sort()).toEqual(D9_KEYS);
    const strip = ({ _id: _ignoredId, publishedAt: _ignoredAt, ...rest }: OpsEvent) => rest;
    expect(strip(laneBDoc)).toEqual(strip(directDoc));
    expect(laneBDoc).toMatchObject({
      reasonId: REASON_COORDINATION_BLOCK,
      generation: 0,
      waiting: "human-now",
      subject: { kind: BLOCK_SUBJECT_KIND, id: `${AGENT}:${THREAD_1}` },
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The `isError` boundary (Task 7): every handler answer — the caught fault
// included — is a SUCCESS to KPR-454's capture points on both lanes and mints
// no `hive-runtime:tool-failed`; the only `isError` a caller sees is the MCP
// layer's own input-validation error, recorded as one `tool-failed` like any
// tool; and the three C15 limbs complete the calling turn unchanged.
//
// Fidelity (advisory A2). Claude lane: the harness has no SDK, so the TEST
// routes the handler's answer — `fireSuccess` when `isError` is absent,
// `fireFailure` when it is `true` — through the runner's REAL hook bodies; the
// routing itself is the SDK's, measured by probe class 2
// (`scripts/probe-posttooluse-failure.ts`). Lane B: a REAL `ToolBridge` over the
// runner-built, connected `event-bus` instance, where the SDK server and
// `discover()` decide the routing. "RunResult classification unchanged" =
// `wasAborted` false / the signal un-aborted, the hook resolving `{}`, and the
// bridged call resolving with the handler's JSON text — never a throw or the
// `Tool execution failed (…)` containment prefix.
//
// Every case owns a fresh fixture and fresh instances (advisory A1, one
// connect per instance). Assertions on the hive-runtime rows run AFTER the
// drain and BEFORE the answer-shape assertions, so a wrongly `isError` answer
// fails on the stored-fact limb rather than only on its flag.
// ───────────────────────────────────────────────────────────────────────────

const CLAUDE_LANE = "Claude lane (SDK routing per probe class 2)";
const LANE_B = "Lane B (connected bridge)";
type LaneName = typeof CLAUDE_LANE | typeof LANE_B;
const LANES: LaneName[] = [CLAUDE_LANE, LANE_B];

const CONTAINMENT_PREFIX = "Tool execution failed (";

/** `capture-points.integration.test.ts`'s payload shapes, copied (no cross-`.test.ts` imports). */
const failureHookInput = (toolName: string, error: string) => ({
  hook_event_name: "PostToolUseFailure",
  tool_name: toolName,
  tool_input: {},
  tool_use_id: "tu-1",
  error,
  duration_ms: 12,
  session_id: "s-1",
  transcript_path: "/dev/null",
  cwd: "/tmp",
});
const successHookInput = (toolName: string) => ({
  hook_event_name: "PostToolUse",
  tool_name: toolName,
  tool_input: {},
  tool_response: { secret: "never read" },
  tool_use_id: "tu-2",
  duration_ms: 12,
  session_id: "s-1",
  transcript_path: "/dev/null",
  cwd: "/tmp",
});

const canonical = (toolName: string) => `mcp__event-bus__${toolName}`;

interface LaneAnswer {
  /** The model-visible text. */
  text: string;
  /** The handler/SDK flag where the lane exposes it (Claude lane); Lane B cannot see it except as a throw. */
  isError: boolean | undefined;
  hasIsErrorKey: boolean;
}

interface LaneDriver {
  lane: LaneName;
  call(toolName: string, args: Record<string, unknown>): Promise<LaneAnswer>;
  /** The capture-point fidelity conditions: no own-abort, nothing escaped. */
  expectTurnUnchanged(): void;
  close(): Promise<void>;
}

async function buildLaneDriver(lane: LaneName, db: Db, context: WorkItemContext): Promise<LaneDriver> {
  if (lane === CLAUDE_LANE) {
    const direct = blockTools(db, AGENT, context);
    const harness = buildClaudeLaneHarness({
      config: { id: AGENT, name: "Mokie", coreServers: ["event-bus"] },
      workItemContext: context,
    });
    return {
      lane,
      call: async (toolName, args) => {
        const { result } = toolName === REPORT_BLOCK_TOOL ? await direct.report(args) : await direct.clear(args);
        const text = result.content[0]!.text;
        // The test routes; the SDK's routing is what probe class 2 measured.
        const hookResult =
          result.isError === true
            ? await harness.fireFailure(failureHookInput(canonical(toolName), text))
            : await harness.fireSuccess(successHookInput(canonical(toolName)));
        expect(hookResult).toEqual({});
        return { text, isError: result.isError, hasIsErrorKey: "isError" in result };
      },
      expectTurnUnchanged: () => expect(harness.runner.wasAborted).toBe(false),
      close: async () => {},
    };
  }

  const runner = runnerWithDb(db, ["event-bus"]);
  const entry = runner.buildToolTransportInventory(context).find((e) => e.name === "event-bus");
  expect(entry).toBeDefined();
  const inProcessServers = runner.buildInProcessServers(context);
  const harness = buildLaneBHarness({
    bridge: {
      inventory: [entry!],
      inProcessServers: { "event-bus": inProcessServers["event-bus"]! },
      workItemContext: context,
    },
  });
  const connected = await harness.bridge.connect();
  const byName = (toolName: string) => {
    const found = connected.find((t) => t.name === canonical(toolName));
    expect(found, canonical(toolName)).toBeDefined();
    return found!;
  };
  return {
    lane,
    call: async (toolName, args) => {
      // `execute` never throws (wrap's structural promise); an `isError` would
      // surface only as the containment prefix.
      const text = await byName(toolName).execute(args);
      return { text, isError: undefined, hasIsErrorKey: false };
    },
    expectTurnUnchanged: () => expect(harness.abortController.signal.aborted).toBe(false),
    close: () => harness.bridge.close(),
  };
}

/** The answer is a non-`isError` handler answer carrying `expected` as its JSON body. */
function expectHandlerAnswer(answer: LaneAnswer, expected: Body): void {
  expect(answer.hasIsErrorKey).toBe(false);
  expect(answer.isError).toBeUndefined();
  expect(answer.text.startsWith(CONTAINMENT_PREFIX)).toBe(false);
  expect(JSON.parse(answer.text)).toEqual(expected);
}

describe("KPR-501 block tools — the isError boundary through both capture points, the MCP-layer residual, and C15 on both lanes (D2, D6, D9, AC5, AC9, AC11)", () => {
  let fixture: OpsFixture;
  const drivers: LaneDriver[] = [];
  const clients: Client[] = [];

  const agentEvents = () => fixture.events().filter((e) => e.producer === HIVE_AGENT_PRODUCER);
  const runtimeEventsNamingBlockTools = () =>
    fixture
      .events()
      .filter(
        (e) =>
          e.producer === HIVE_RUNTIME_PRODUCER &&
          (e.subject.id === canonical(REPORT_BLOCK_TOOL) || e.subject.id === canonical(CLEAR_BLOCK_TOOL)),
      );
  const faultWarns = () =>
    mockLog.warn.mock.calls.filter(([msg]) => String(msg).includes("Ops block tool faulted")).length;
  const counters = () => getBlockProducerSnapshot();
  const pub = () => fixture.publisher.getSnapshot();

  const driver = async (lane: LaneName, context = turn(SLACK_TS_1, THREAD_1)) => {
    const d = await buildLaneDriver(lane, fixture.fakeDb.db, context);
    drivers.push(d);
    return d;
  };

  const disableReason = async (reasonId: string) => {
    fixture.fakeDb
      .collection(OPS_REASONS_COLLECTION)
      .rows.find((r) => r._id === `${HIVE_AGENT_PRODUCER}:${reasonId}`)!.enabled = false;
    await fixture.publisher.init();
  };

  beforeEach(async () => {
    mockLog.debug.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    __resetBlockProducerCountersForTests();
    fixture = await buildOpsFixture();
  });

  afterEach(async () => {
    // AC9: the coordination-bus and team collections take no write in this describe either.
    const writes = fixture.fakeDb.operations.filter(
      (o) => NEVER_WRITTEN.includes(o.collection) && /insert|update|replace|delete/i.test(o.operation),
    );
    expect(writes).toEqual([]);
    for (const c of clients.splice(0)) await c.close();
    for (const d of drivers.splice(0)) await d.close();
    await fixture.dispose();
    __resetOpsPublisherForTests();
  });

  // ── AC9 capture-point limbs: every handler answer is a success ────────────

  for (const lane of LANES) {
    describe(lane, () => {
      it(`AC9 refused: both tools answer refused non-isError and no hive-runtime document names either tool — ${lane}`, async () => {
        const d = await driver(lane);
        const r = await d.call(REPORT_BLOCK_TOOL, { kind: "nope" });
        const c = await d.call(CLEAR_BLOCK_TOOL, { kind: "coordination", outcome: "nope" });
        await fixture.drain();

        expect(runtimeEventsNamingBlockTools()).toEqual([]);
        expect(fixture.events()).toEqual([]);
        expectHandlerAnswer(r, { state: "refused", reason: REFUSAL_KIND, admitted: expect.anything() });
        expectHandlerAnswer(c, { state: "refused", reason: REFUSAL_OUTCOME, admitted: expect.anything() });
        expect(counters().refused).toBe(2);
        d.expectTurnUnchanged();
      });

      it(`AC9 disabled: both tools answer disabled non-isError and no hive-runtime document names either tool — ${lane}`, async () => {
        await disableReason(REASON_COORDINATION_BLOCK);
        await disableReason(REASON_BLOCK_CLEARED);
        const d = await driver(lane);
        const r = await d.call(REPORT_BLOCK_TOOL, { kind: "coordination", blockedOn: "human" });
        const c = await d.call(CLEAR_BLOCK_TOOL, { kind: "coordination", outcome: "resumed" });
        await fixture.drain();

        expect(runtimeEventsNamingBlockTools()).toEqual([]);
        expect(fixture.events()).toEqual([]);
        expectHandlerAnswer(r, { state: "disabled" });
        expectHandlerAnswer(c, { state: "disabled" });
        expect(counters().disabled).toBe(2);
        expect(pub().rejected).toBe(0);
        d.expectTurnUnchanged();
      });

      it(`AC9 no-open-block: clear_block with nothing open answers non-isError and no hive-runtime document names either tool — ${lane}`, async () => {
        const d = await driver(lane);
        const c = await d.call(CLEAR_BLOCK_TOOL, { kind: "coordination", outcome: "resumed" });
        await fixture.drain();

        expect(runtimeEventsNamingBlockTools()).toEqual([]);
        expect(fixture.events()).toEqual([]);
        expectHandlerAnswer(c, { state: "no-open-block", queueIdle: true });
        expect(counters().clearNoOpen).toBe(1);
        d.expectTurnUnchanged();
      });

      it(`AC9 queued: report then clear each answer queued non-isError, store their hive-agent documents and no hive-runtime document names either tool — ${lane}`, async () => {
        const d = await driver(lane);
        const r = await d.call(REPORT_BLOCK_TOOL, { kind: "coordination", blockedOn: "human" });
        await fixture.drain();
        const c = await d.call(CLEAR_BLOCK_TOOL, { kind: "coordination", outcome: "resumed" });
        await fixture.drain();

        expect(runtimeEventsNamingBlockTools()).toEqual([]);
        expect(fixture.events().filter((e) => e.producer === HIVE_RUNTIME_PRODUCER)).toEqual([]);
        expectHandlerAnswer(r, { state: "queued", kind: "coordination" });
        const key = agentEvents().find((e) => e.reasonId === REASON_COORDINATION_BLOCK)!.dedupeKey;
        expectHandlerAnswer(c, { state: "queued", clears: key, outcome: "resumed", queueIdle: true });
        expect(agentEvents().map((e) => e.reasonId)).toEqual([REASON_COORDINATION_BLOCK, REASON_BLOCK_CLEARED]);
        d.expectTurnUnchanged();
      });

      it(`AC9 / AC11 (ii): a findOne fault on clear_block answers unavailable/fault non-isError, faults +1, one warn, and no hive-runtime document names either tool — ${lane}`, async () => {
        const d = await driver(lane);
        await d.call(REPORT_BLOCK_TOOL, { kind: "coordination", blockedOn: "human" });
        await fixture.drain(); // drained BEFORE arming, so no queued resolve consumes the fault
        const stored = fixture.events().length;
        expect(stored).toBe(1);

        fixture.fakeDb.failNext(OPS_EVENTS_COLLECTION, "findOne");
        const c = await d.call(CLEAR_BLOCK_TOOL, { kind: "coordination", outcome: "resumed" });
        await fixture.drain();

        expect(runtimeEventsNamingBlockTools()).toEqual([]);
        expect(fixture.events()).toHaveLength(stored);
        expectHandlerAnswer(c, { state: "unavailable", cause: "fault" });
        expect(counters().faults).toBe(1);
        expect(faultWarns()).toBe(1);
        expect(agentEvents().filter((e) => e.reasonId === REASON_BLOCK_CLEARED)).toEqual([]);
        d.expectTurnUnchanged();
      });

      it(`AC9 / Edge 1: with the singleton unset both tools answer unavailable/publisher-unset and both producers are silent — ${lane}`, async () => {
        const d = await driver(lane);
        __resetOpsPublisherForTests();
        const r = await d.call(REPORT_BLOCK_TOOL, { kind: "coordination", blockedOn: "human" });
        const c = await d.call(CLEAR_BLOCK_TOOL, { kind: "coordination", outcome: "resumed" });
        await fixture.drain();

        expect(fixture.events()).toEqual([]);
        expectHandlerAnswer(r, { state: "unavailable", cause: "publisher-unset" });
        expectHandlerAnswer(c, { state: "unavailable", cause: "publisher-unset" });
        expect(counters().unavailable).toBe(2);
        d.expectTurnUnchanged();
      });

      // ── AC11 (C15) ────────────────────────────────────────────────────────

      it(`AC11 (i): a throwing enqueuePublish double makes each tool answer unavailable/fault non-isError, faults +1 each, one warn each, and nothing new is stored by either producer — ${lane}`, async () => {
        const d = await driver(lane);
        // A stored block for the clear to find (so its limb reaches enqueuePublish).
        await d.call(REPORT_BLOCK_TOOL, { kind: "coordination", blockedOn: "human" });
        await fixture.drain();
        const stored = fixture.events().length;
        expect(stored).toBe(1);

        const spy = vi.spyOn(fixture.publisher, "enqueuePublish").mockImplementation(() => {
          throw new Error("enqueue double");
        });
        let r: LaneAnswer;
        let c: LaneAnswer;
        try {
          r = await d.call(REPORT_BLOCK_TOOL, { kind: "semantic" });
          c = await d.call(CLEAR_BLOCK_TOOL, { kind: "coordination", outcome: "resumed" });
        } finally {
          spy.mockRestore();
        }
        await fixture.drain();

        expect(runtimeEventsNamingBlockTools()).toEqual([]);
        expect(fixture.events()).toHaveLength(stored);
        expectHandlerAnswer(r, { state: "unavailable", cause: "fault" });
        expectHandlerAnswer(c, { state: "unavailable", cause: "fault" });
        expect(counters().faults).toBe(2);
        expect(faultWarns()).toBe(2);
        d.expectTurnUnchanged();
      });

      it(`AC11 (iii): an insertOne rejecting once (failNext, armed before the call) under each tool — each answers queued, publishFaults +1 per call, nothing stored, no hive-runtime document — ${lane}`, async () => {
        const d = await driver(lane);
        fixture.fakeDb.failNext(OPS_EVENTS_COLLECTION, "insertOne");
        const r = await d.call(REPORT_BLOCK_TOOL, { kind: "coordination", blockedOn: "human" });
        await fixture.drain();
        expect(runtimeEventsNamingBlockTools()).toEqual([]);
        expect(fixture.events()).toEqual([]);
        expect(pub().publishFaults).toBe(1);
        expectHandlerAnswer(r, { state: "queued", kind: "coordination" });

        // A stored block for the clear to name.
        await d.call(REPORT_BLOCK_TOOL, { kind: "coordination", blockedOn: "human" });
        await fixture.drain();
        expect(fixture.events()).toHaveLength(1);

        fixture.fakeDb.failNext(OPS_EVENTS_COLLECTION, "insertOne");
        const c = await d.call(CLEAR_BLOCK_TOOL, { kind: "coordination", outcome: "resumed" });
        await fixture.drain();
        expect(runtimeEventsNamingBlockTools()).toEqual([]);
        expect(fixture.events()).toHaveLength(1);
        expect(pub().publishFaults).toBe(2);
        expect(c.text.startsWith(CONTAINMENT_PREFIX)).toBe(false);
        expect(JSON.parse(c.text)).toMatchObject({ state: "queued", outcome: "resumed" });
        expect(c.hasIsErrorKey).toBe(false);
        expect(counters().faults).toBe(0);
        d.expectTurnUnchanged();
      });

      it(`AC11: decided answers (refused, disabled, no-open-block) through the same two turns record nothing — ${lane}`, async () => {
        const d = await driver(lane);
        const answers = [
          await d.call(REPORT_BLOCK_TOOL, { kind: "coordination", blockedOn: "nope" }),
          await d.call(CLEAR_BLOCK_TOOL, { kind: "coordination", outcome: "resumed" }),
        ];
        await disableReason(REASON_SEMANTIC_BLOCK);
        answers.push(await d.call(REPORT_BLOCK_TOOL, { kind: "semantic" }));
        await fixture.drain();

        expect(fixture.events()).toEqual([]);
        expect(answers.map((a) => JSON.parse(a.text).state)).toEqual(["refused", "no-open-block", "disabled"]);
        for (const a of answers) expect(a.hasIsErrorKey).toBe(false);
        d.expectTurnUnchanged();
      });
    });
  }

  // ── AC9 residual limb: the SDK's own isError, through the Lane B bridge ───

  it("AC9 residual (Lane B, own fixture): report_block with kind 42 is the SDK's isError — exactly one hive-runtime tool-failed on the tool; a following valid report stores its block plus one tool-recovered", async () => {
    const d = await driver(LANE_B);
    const refusedBefore = counters().refused;

    const bad = await d.call(REPORT_BLOCK_TOOL, { kind: 42 });
    // discover() saw `isError: true` and threw, so wrap() contained it.
    expect(bad.text.startsWith(`${CONTAINMENT_PREFIX}${canonical(REPORT_BLOCK_TOOL)}): `)).toBe(true);
    expect(bad.text).toContain("Input validation error");
    await fixture.drain();

    const failed = fixture.events().filter((e) => e.producer === HIVE_RUNTIME_PRODUCER);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      producer: HIVE_RUNTIME_PRODUCER,
      reasonId: REASON_TOOL_FAILED,
      subject: { kind: "tool", id: canonical(REPORT_BLOCK_TOOL) },
    });
    expect(agentEvents()).toEqual([]);
    expect(counters().refused).toBe(refusedBefore);

    // Advisory A6: the true tool-recovered after a non-isError answer is expected, not suppressed.
    const good = await d.call(REPORT_BLOCK_TOOL, { kind: "coordination", blockedOn: "human" });
    expectHandlerAnswer(good, { state: "queued", kind: "coordination" });
    await fixture.drain();

    expect(agentEvents().map((e) => e.reasonId)).toEqual([REASON_COORDINATION_BLOCK]);
    const recovered = fixture.events().filter((e) => e.reasonId === REASON_TOOL_RECOVERED);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      producer: HIVE_RUNTIME_PRODUCER,
      subject: { kind: "tool", id: canonical(REPORT_BLOCK_TOOL) },
      clears: failed[0]!.dedupeKey,
    });
    expect(fixture.events().filter((e) => e.reasonId === REASON_TOOL_FAILED)).toHaveLength(1);
    d.expectTurnUnchanged();
  });

  // ── AC5 MCP-layer residual (Edge 20): a raw Client over a fresh instance ──

  it("AC5 / Edge 20 / NV9: through the SDK server's own request handler — an unknown key is stripped, kind 42 and a missing outcome are Input validation errors, and a wrong kind value is the handler's counted refusal", async () => {
    const ref: WorkItemContextRef = { current: turn(SLACK_TS_1, THREAD_1) };
    const server = createEventBusMcpServer({
      db: fixture.fakeDb.db,
      agentId: AGENT,
      workItemContext: ref,
      eventSubscribersJson: "{}",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    const client = new Client({ name: "kpr-501-residual", version: "1.0.0" });
    await client.connect(clientTransport);
    clients.push(client);

    type RawResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
    const callRaw = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as unknown as RawResult;

    // (1) An extra unknown key is stripped; the call proceeds on its declared keys.
    const STRAY_KEY = "strayUndeclaredKey";
    const STRAY_VALUE = "stray-value-7f3a";
    const stripped = await callRaw(REPORT_BLOCK_TOOL, {
      kind: "coordination",
      blockedOn: "human",
      [STRAY_KEY]: STRAY_VALUE,
    });
    expect(stripped.isError).not.toBe(true);
    expect(JSON.parse(stripped.content[0]!.text)).toEqual({ state: "queued", kind: "coordination" });
    await fixture.drain();
    expect(agentEvents()).toHaveLength(1);
    const storedText = JSON.stringify(agentEvents()[0]);
    expect(storedText).not.toContain(STRAY_KEY);
    expect(storedText).not.toContain(STRAY_VALUE);
    expect(counters().refused).toBe(0);

    // (2) A non-string kind and (3) a missing required outcome: the MCP layer's isError, no reason, no counter.
    const residuals: Array<[string, Record<string, unknown>]> = [
      [REPORT_BLOCK_TOOL, { kind: 42 }],
      [CLEAR_BLOCK_TOOL, { kind: "coordination" }],
    ];
    for (const [name, args] of residuals) {
      const result = await callRaw(name, args);
      expect(result.isError, name).toBe(true);
      const text = result.content[0]!.text;
      // Observed at SDK: the McpError carrying InvalidParams (-32602) prefixes
      // its code to the SDK's "Input validation error" text; the design's
      // "begins with Input validation error" names that SDK text.
      expect(text).toMatch(/^(?:MCP error -32602: )?Input validation error/);
      expect(text).not.toContain('"reason"');
      expect(counters().refused).toBe(0);
    }

    // (4) NV9's connected limb: a wrong kind VALUE reaches the handler and is refused and counted.
    const wrongValue = await callRaw(REPORT_BLOCK_TOOL, { kind: "waiting" });
    expect(wrongValue.isError).not.toBe(true);
    expect(JSON.parse(wrongValue.content[0]!.text)).toMatchObject({ state: "refused", reason: REFUSAL_KIND });
    expect(counters().refused).toBe(1);

    await fixture.drain();
    expect(agentEvents()).toHaveLength(1);
    expect(fixture.events().filter((e) => e.producer === HIVE_RUNTIME_PRODUCER)).toEqual([]);
    expect(pub().rejected).toBe(0);
  });
});
