import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  BLOCK_EVIDENCE_KIND_RULING,
  BLOCK_EVIDENCE_KIND_WORK_ITEM,
  BLOCK_SUBJECT_KIND,
  HIVE_AGENT_PRODUCER,
  REASON_BLOCK_CLEARED,
  REASON_COORDINATION_BLOCK,
  REASON_SEMANTIC_BLOCK,
} from "./block-reasons.js";
import {
  CLEAR_BLOCK_SHAPE,
  FLUSH_DEADLINE_MS,
  REFUSAL_BLOCKED_ON,
  REFUSAL_BLOCKED_ON_AGENT_ID,
  REFUSAL_KIND,
  REFUSAL_OUTCOME,
  REFUSAL_RULING_REF_SHAPE,
  REFUSAL_RULING_REQUIRED,
  REFUSAL_THREAD_ID_SHAPE,
  REPORT_BLOCK_SHAPE,
  RULING_REF_RE,
  __resetBlockProducerCountersForTests,
  composeClearInput,
  composeClearSubject,
  composeReportInput,
  composeSubject,
  countBlockProducer,
  getBlockProducerSnapshot,
  validateBlockKind,
  validateClearParams,
  validateReportParams,
  type BlockLiveContext,
  type BlockValidation,
  type ClearBlockParams,
  type ReportBlockParams,
} from "./block-producer.js";
import { ADMISSIBLE_ID_RE, OPS_ID_MAX_LENGTH, OPS_TOKEN_RE } from "./ids.js";

/**
 * KPR-501 — the block producer's pure layer (D4, D5, D6, D9). No I/O, no
 * FakeDb. Reserved-prefix work item ids appear below only as plain literals.
 */

const AGENT = "chief-of-staff";
const SLACK_TS = "1757900000.123456";

function ok<T>(v: BlockValidation<T>): T {
  if (!v.ok) throw new Error(`expected ok, got refusal ${v.reason}`);
  return v.params;
}

function refusalOf<T>(v: BlockValidation<T>): string {
  if (v.ok) throw new Error("expected a refusal");
  expect(v.admitted.length).toBeGreaterThan(0);
  return v.reason;
}

function ctx(workItemId: string | undefined, threadId: string | undefined): BlockLiveContext {
  return { ...(workItemId !== undefined ? { workItemId } : {}), ...(threadId !== undefined ? { threadId } : {}) };
}

const coordination: ReportBlockParams = { kind: "coordination", blockedOn: "human" };
const semantic: ReportBlockParams = { kind: "semantic" };

describe("D6 declared shapes — type and optionality only (AC5, NV9 shape half)", () => {
  type Def = { type: string; checks?: unknown[]; innerType?: z.ZodType };
  const defOf = (s: z.ZodType): Def => (s as unknown as { def: Def }).def;

  function expectBareString(s: z.ZodType): void {
    const def = defOf(s);
    expect(def.type).toBe("string");
    expect(def.checks ?? []).toHaveLength(0);
  }
  function expectOptionalBareString(s: z.ZodType): void {
    const def = defOf(s);
    expect(def.type).toBe("optional");
    expectBareString(def.innerType as z.ZodType);
  }

  it("report_block declares exactly {kind, blockedOn, blockedOnAgentId}", () => {
    expect(Object.keys(REPORT_BLOCK_SHAPE).sort()).toEqual(["blockedOn", "blockedOnAgentId", "kind"]);
    expectBareString(REPORT_BLOCK_SHAPE.kind);
    expectOptionalBareString(REPORT_BLOCK_SHAPE.blockedOn);
    expectOptionalBareString(REPORT_BLOCK_SHAPE.blockedOnAgentId);
  });

  it("clear_block declares exactly {kind, outcome, rulingRef, threadId}", () => {
    expect(Object.keys(CLEAR_BLOCK_SHAPE).sort()).toEqual(["kind", "outcome", "rulingRef", "threadId"]);
    expectBareString(CLEAR_BLOCK_SHAPE.kind);
    expectBareString(CLEAR_BLOCK_SHAPE.outcome);
    expectOptionalBareString(CLEAR_BLOCK_SHAPE.rulingRef);
    expectOptionalBareString(CLEAR_BLOCK_SHAPE.threadId);
  });

  it("every declared key carries a description", () => {
    for (const s of [...Object.values(REPORT_BLOCK_SHAPE), ...Object.values(CLEAR_BLOCK_SHAPE)]) {
      expect((s as z.ZodType).description ?? "").not.toBe("");
    }
  });

  it("the shapes admit values the handler refuses (no rule migrated into the shape)", () => {
    expect(REPORT_BLOCK_SHAPE.kind.safeParse("nonsense").success).toBe(true);
    expect(CLEAR_BLOCK_SHAPE.outcome.safeParse("").success).toBe(true);
    expect(CLEAR_BLOCK_SHAPE.rulingRef.safeParse("https://example.com/x").success).toBe(true);
  });

  it("subject and evidence kinds satisfy OPS_TOKEN_RE", () => {
    for (const k of [BLOCK_SUBJECT_KIND, BLOCK_EVIDENCE_KIND_WORK_ITEM, BLOCK_EVIDENCE_KIND_RULING]) {
      expect(OPS_TOKEN_RE.test(k)).toBe(true);
    }
    expect([BLOCK_SUBJECT_KIND, BLOCK_EVIDENCE_KIND_WORK_ITEM, BLOCK_EVIDENCE_KIND_RULING]).toEqual([
      "agent-work",
      "work-item",
      "ruling",
    ]);
  });

  it("FLUSH_DEADLINE_MS is 1000", () => {
    expect(FLUSH_DEADLINE_MS).toBe(1000);
  });
});

describe("D6 report_block value rules (AC5)", () => {
  it("admits the legal combinations", () => {
    expect(ok(validateReportParams({ kind: "semantic" }))).toEqual({ kind: "semantic" });
    for (const blockedOn of ["agent", "human", "external"]) {
      expect(ok(validateReportParams({ kind: "coordination", blockedOn }))).toEqual({
        kind: "coordination",
        blockedOn,
      });
    }
    expect(ok(validateReportParams({ kind: "coordination", blockedOn: "agent", blockedOnAgentId: "river" }))).toEqual({
      kind: "coordination",
      blockedOn: "agent",
      blockedOnAgentId: "river",
    });
    const longest = `a${"b".repeat(63)}`;
    expect(ok(validateReportParams({ kind: "coordination", blockedOn: "agent", blockedOnAgentId: longest }))).toEqual({
      kind: "coordination",
      blockedOn: "agent",
      blockedOnAgentId: longest,
    });
  });

  it.each([
    ["wrong kind", { kind: "urgent" }, REFUSAL_KIND],
    ['kind ""', { kind: "" }, REFUSAL_KIND],
    ["kind wrong case", { kind: "Coordination", blockedOn: "human" }, REFUSAL_KIND],
    ["coordination without blockedOn", { kind: "coordination" }, REFUSAL_BLOCKED_ON],
    ["wrong blockedOn", { kind: "coordination", blockedOn: "vendor" }, REFUSAL_BLOCKED_ON],
    ['blockedOn ""', { kind: "coordination", blockedOn: "" }, REFUSAL_BLOCKED_ON],
    ["blockedOn on semantic", { kind: "semantic", blockedOn: "human" }, REFUSAL_BLOCKED_ON],
    ['blockedOn "" on semantic', { kind: "semantic", blockedOn: "" }, REFUSAL_BLOCKED_ON],
    [
      "blockedOnAgentId with blockedOn human",
      { kind: "coordination", blockedOn: "human", blockedOnAgentId: "river" },
      REFUSAL_BLOCKED_ON_AGENT_ID,
    ],
    ["blockedOnAgentId on semantic", { kind: "semantic", blockedOnAgentId: "river" }, REFUSAL_BLOCKED_ON_AGENT_ID],
    [
      "blockedOnAgentId with a space",
      { kind: "coordination", blockedOn: "agent", blockedOnAgentId: "chief of staff" },
      REFUSAL_BLOCKED_ON_AGENT_ID,
    ],
    [
      "blockedOnAgentId uppercase",
      { kind: "coordination", blockedOn: "agent", blockedOnAgentId: "River" },
      REFUSAL_BLOCKED_ON_AGENT_ID,
    ],
    [
      "blockedOnAgentId a path",
      { kind: "coordination", blockedOn: "agent", blockedOnAgentId: "../etc/passwd" },
      REFUSAL_BLOCKED_ON_AGENT_ID,
    ],
    [
      "blockedOnAgentId credential-shaped",
      { kind: "coordination", blockedOn: "agent", blockedOnAgentId: "sk-ant-api03-AbCdEf0123456789" },
      REFUSAL_BLOCKED_ON_AGENT_ID,
    ],
    [
      'blockedOnAgentId ""',
      { kind: "coordination", blockedOn: "agent", blockedOnAgentId: "" },
      REFUSAL_BLOCKED_ON_AGENT_ID,
    ],
    [
      "blockedOnAgentId over 64",
      { kind: "coordination", blockedOn: "agent", blockedOnAgentId: `a${"b".repeat(64)}` },
      REFUSAL_BLOCKED_ON_AGENT_ID,
    ],
  ])("%s ⇒ refused", (_label, raw, reason) => {
    expect(refusalOf(validateReportParams(raw))).toBe(reason);
  });

  it("validateBlockKind alone", () => {
    expect(ok(validateBlockKind("coordination"))).toBe("coordination");
    expect(refusalOf(validateBlockKind(""))).toBe(REFUSAL_KIND);
  });
});

describe("D6 clear_block value rules (AC5, AC6 refusal limb)", () => {
  const CREDENTIAL_SHAPED = [
    ["an sk-ant token", "sk-ant-api03-AbCdEf0123456789_xyz"],
    ["a 40-hex secret", "0123456789abcdef0123456789abcdef01234567"],
    ["a three-segment JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
  ] as const;

  it.each([SLACK_TS, `C0AB12CD3EF:${SLACK_TS}`, "KPR-451", "KPR-451#comment-60079ae4"])(
    "RULING_REF_RE admits %s (≤ 40 and admissible)",
    (ref) => {
      expect(RULING_REF_RE.test(ref)).toBe(true);
      expect(ref.length).toBeLessThanOrEqual(40);
      expect(ADMISSIBLE_ID_RE.test(ref)).toBe(true);
      expect(ok(validateClearParams({ kind: "semantic", outcome: "resumed", rulingRef: ref }))).toEqual({
        kind: "semantic",
        outcome: "resumed",
        rulingRef: ref,
      });
    },
  );

  it.each([
    ["a path", "docs/rulings/451"],
    ["a URL", "https://keepur.slack.com/archives/C0AB12CD3EF/p1757900000123456"],
    ["a sentence", "May said go ahead"],
    ...CREDENTIAL_SHAPED,
  ])("RULING_REF_RE refuses %s ⇒ ruling-ref-shape", (_label, ref) => {
    expect(RULING_REF_RE.test(ref)).toBe(false);
    expect(refusalOf(validateClearParams({ kind: "coordination", outcome: "resumed", rulingRef: ref }))).toBe(
      REFUSAL_RULING_REF_SHAPE,
    );
    expect(refusalOf(validateClearParams({ kind: "semantic", outcome: "resumed", rulingRef: ref }))).toBe(
      REFUSAL_RULING_REF_SHAPE,
    );
  });

  it.each([
    ["wrong kind", { kind: "urgent", outcome: "resumed" }, REFUSAL_KIND],
    ['kind ""', { kind: "", outcome: "resumed" }, REFUSAL_KIND],
    ["wrong outcome", { kind: "coordination", outcome: "escalated" }, REFUSAL_OUTCOME],
    ['outcome ""', { kind: "coordination", outcome: "" }, REFUSAL_OUTCOME],
    ["semantic without rulingRef", { kind: "semantic", outcome: "resumed" }, REFUSAL_RULING_REQUIRED],
    ['semantic with rulingRef ""', { kind: "semantic", outcome: "cancelled", rulingRef: "" }, REFUSAL_RULING_REQUIRED],
    [
      "threadId with a space",
      { kind: "coordination", outcome: "resumed", threadId: "my thread" },
      REFUSAL_THREAD_ID_SHAPE,
    ],
    ["threadId with /", { kind: "coordination", outcome: "resumed", threadId: "a/b" }, REFUSAL_THREAD_ID_SHAPE],
    ['threadId ""', { kind: "coordination", outcome: "resumed", threadId: "" }, REFUSAL_THREAD_ID_SHAPE],
  ])("%s ⇒ refused", (_label, raw, reason) => {
    expect(refusalOf(validateClearParams(raw))).toBe(reason);
  });

  it('a coordination clear with rulingRef "" is admitted and carries no ruling', () => {
    const params = ok(validateClearParams({ kind: "coordination", outcome: "resumed", rulingRef: "" }));
    expect(params).toEqual({ kind: "coordination", outcome: "resumed" });
    const { input } = composeClearInput({
      agentId: AGENT,
      current: ctx(SLACK_TS, SLACK_TS),
      params,
      subject: composeClearSubject(AGENT, ctx(SLACK_TS, SLACK_TS), params).subject,
      clears: "k",
    });
    expect(input.evidence.map((e) => e.kind)).not.toContain(BLOCK_EVIDENCE_KIND_RULING);
  });

  it("a credential-shaped threadId passes the shape rule (the no-novel-string property keeps it out, not the shape)", () => {
    const params = ok(
      validateClearParams({ kind: "coordination", outcome: "resumed", threadId: "sk-ant-api03-AbCdEf0123456789" }),
    );
    expect(params.threadId).toBe("sk-ant-api03-AbCdEf0123456789");
  });
});

describe("D4 subject composition (AC3)", () => {
  it('composes "<slug>:<thread>" with the constructor slug', () => {
    expect(composeSubject(AGENT, SLACK_TS)).toEqual({
      subject: { kind: "agent-work", id: `${AGENT}:${SLACK_TS}` },
      fallback: false,
    });
    const { input } = composeReportInput({ agentId: AGENT, current: ctx(SLACK_TS, SLACK_TS), params: semantic });
    expect(input.subject.id).toBe(`${AGENT}:${SLACK_TS}`);
    expect(input.detail.agentId).toBe(AGENT);
    expect(JSON.stringify(input)).not.toContain("Chief of Staff");
  });

  it("falls back on a multi-word scheduler thread", () => {
    const thread = `scheduler:${AGENT}:weekly report run:1757900000`;
    expect(composeSubject(AGENT, thread)).toEqual({ subject: { kind: "agent-work", id: AGENT }, fallback: true });
  });

  it("falls back when the composed id exceeds OPS_ID_MAX_LENGTH, and not at exactly the bound", () => {
    const over = "t".repeat(OPS_ID_MAX_LENGTH - AGENT.length); // composed = 201
    expect(ADMISSIBLE_ID_RE.test(over)).toBe(true);
    expect(composeSubject(AGENT, over).fallback).toBe(true);
    const at = "t".repeat(OPS_ID_MAX_LENGTH - AGENT.length - 1); // composed = 200
    expect(composeSubject(AGENT, at)).toEqual({
      subject: { kind: "agent-work", id: `${AGENT}:${at}` },
      fallback: false,
    });
  });

  it("falls back when there is no thread", () => {
    expect(composeSubject(AGENT, undefined).fallback).toBe(true);
  });

  it("two agent ids on one thread ⇒ two families", () => {
    const a = composeSubject("river", SLACK_TS).subject.id;
    const b = composeSubject("jasper", SLACK_TS).subject.id;
    expect(a).not.toBe(b);
  });

  it("clear subject uses the override thread, else the live thread", () => {
    const live = ctx(SLACK_TS, "1757900001.000001");
    expect(composeClearSubject(AGENT, live, {}).subject.id).toBe(`${AGENT}:1757900001.000001`);
    expect(composeClearSubject(AGENT, live, { threadId: SLACK_TS }).subject.id).toBe(`${AGENT}:${SLACK_TS}`);
    expect(composeClearSubject(AGENT, undefined, {}).fallback).toBe(true);
  });
});

describe("D5 waiting (AC4)", () => {
  it.each([
    [SLACK_TS, "human-now"],
    ["team-river-chief-of-staff-1", "agent"],
    ["sched:chief-of-staff:daily:1757900000", "nobody"],
    ["callback:abc123", "nobody"],
    ["event:abc123", "nobody"],
    ["worker:claim-1", "nobody"],
    [undefined, "nobody"],
  ])("report with workItemId %s ⇒ %s", (workItemId, waiting) => {
    for (const params of [coordination, semantic]) {
      const { input } = composeReportInput({ agentId: AGENT, current: ctx(workItemId, SLACK_TS), params });
      expect(input.waiting).toBe(waiting);
    }
  });

  it("a clear is nobody regardless of the live work item", () => {
    const params: ClearBlockParams = { kind: "coordination", outcome: "resumed" };
    for (const workItemId of [SLACK_TS, "team-x-1", undefined]) {
      const current = ctx(workItemId, SLACK_TS);
      const { input } = composeClearInput({
        agentId: AGENT,
        current,
        params,
        subject: composeClearSubject(AGENT, current, params).subject,
        clears: "k",
      });
      expect(input.waiting).toBe("nobody");
    }
  });
});

describe("D6 report input composition", () => {
  it("coordination: producer, reason, detail, evidence", () => {
    const out = composeReportInput({
      agentId: AGENT,
      current: ctx(SLACK_TS, SLACK_TS),
      params: { kind: "coordination", blockedOn: "agent", blockedOnAgentId: "river" },
    });
    expect(out).toEqual({
      input: {
        producer: HIVE_AGENT_PRODUCER,
        reasonId: REASON_COORDINATION_BLOCK,
        waiting: "human-now",
        subject: { kind: BLOCK_SUBJECT_KIND, id: `${AGENT}:${SLACK_TS}` },
        detail: {
          agentId: AGENT,
          blockedOn: "agent",
          blockedOnAgentId: "river",
          workItemId: SLACK_TS,
          threadId: SLACK_TS,
        },
        evidence: [{ kind: BLOCK_EVIDENCE_KIND_WORK_ITEM, id: SLACK_TS }],
      },
      subjectFallback: false,
      idsOmitted: 0,
    });
    expect(out.input.clears).toBeUndefined();
  });

  it("semantic: no blockedOn keys", () => {
    const { input } = composeReportInput({ agentId: AGENT, current: ctx(SLACK_TS, SLACK_TS), params: semantic });
    expect(input.reasonId).toBe(REASON_SEMANTIC_BLOCK);
    expect(input.detail).toEqual({ agentId: AGENT, workItemId: SLACK_TS, threadId: SLACK_TS });
  });

  it("edge 3: inadmissible thread ⇒ fallback, threadId omitted, omission signalled", () => {
    const thread = `scheduler:${AGENT}:weekly report run:1757900000`;
    const out = composeReportInput({ agentId: AGENT, current: ctx(SLACK_TS, thread), params: semantic });
    expect(out.subjectFallback).toBe(true);
    expect(out.input.subject.id).toBe(AGENT);
    expect(out.input.detail).not.toHaveProperty("threadId");
    expect(out.idsOmitted).toBe(1);
    expect(JSON.stringify(out.input)).not.toContain("weekly report");
  });

  it("composed id > 200 with an admissible thread ⇒ fallback but the thread is still stored", () => {
    const thread = "t".repeat(OPS_ID_MAX_LENGTH - AGENT.length);
    const out = composeReportInput({ agentId: AGENT, current: ctx(SLACK_TS, thread), params: semantic });
    expect(out.subjectFallback).toBe(true);
    expect(out.input.detail.threadId).toBe(thread);
    expect(out.idsOmitted).toBe(0);
  });

  it("edge 4: prose work item ⇒ workItemId omitted, no work-item evidence, waiting from the unfiltered id", () => {
    const prose = "team-river asked about the quarterly numbers";
    const out = composeReportInput({ agentId: AGENT, current: ctx(prose, SLACK_TS), params: coordination });
    expect(out.input.detail).not.toHaveProperty("workItemId");
    expect(out.input.evidence).toEqual([]);
    expect(out.input.waiting).toBe("agent");
    expect(out.idsOmitted).toBe(1);
    expect(JSON.stringify(out.input)).not.toContain("quarterly");
  });

  it("edge 21: current undefined ⇒ fallback subject, no ids, evidence [], waiting nobody", () => {
    const out = composeReportInput({ agentId: AGENT, current: undefined, params: coordination });
    expect(out).toEqual({
      input: {
        producer: HIVE_AGENT_PRODUCER,
        reasonId: REASON_COORDINATION_BLOCK,
        waiting: "nobody",
        subject: { kind: BLOCK_SUBJECT_KIND, id: AGENT },
        detail: { agentId: AGENT, blockedOn: "human" },
        evidence: [],
      },
      subjectFallback: true,
      idsOmitted: 0,
    });
  });
});

describe("D6 clear input composition", () => {
  it("ruling then work-item evidence, clearing turn's ids, clears passed through", () => {
    const live = ctx("1757900009.000009", "1757900008.000008");
    const params = ok(
      validateClearParams({
        kind: "semantic",
        outcome: "resumed",
        rulingRef: "KPR-451#comment-60079ae4",
        threadId: SLACK_TS,
      }),
    );
    const { subject, fallback } = composeClearSubject(AGENT, live, params);
    expect(fallback).toBe(false);
    const clears = `hive-agent:agent-work:${AGENT}:${SLACK_TS}:semantic-block:0`;
    const out = composeClearInput({ agentId: AGENT, current: live, params, subject, clears });
    expect(out).toEqual({
      input: {
        producer: HIVE_AGENT_PRODUCER,
        reasonId: REASON_BLOCK_CLEARED,
        waiting: "nobody",
        subject: { kind: BLOCK_SUBJECT_KIND, id: `${AGENT}:${SLACK_TS}` },
        detail: { agentId: AGENT, outcome: "resumed", workItemId: "1757900009.000009", threadId: "1757900008.000008" },
        evidence: [
          { kind: BLOCK_EVIDENCE_KIND_RULING, id: "KPR-451#comment-60079ae4" },
          { kind: BLOCK_EVIDENCE_KIND_WORK_ITEM, id: "1757900009.000009" },
        ],
        clears,
      },
      idsOmitted: 0,
    });
  });

  it("no context and a coordination clear ⇒ evidence [], no ids", () => {
    const params: ClearBlockParams = { kind: "coordination", outcome: "cancelled" };
    const out = composeClearInput({
      agentId: AGENT,
      current: undefined,
      params,
      subject: composeClearSubject(AGENT, undefined, params).subject,
      clears: "k",
    });
    expect(out.input.detail).toEqual({ agentId: AGENT, outcome: "cancelled" });
    expect(out.input.evidence).toEqual([]);
    expect(out.idsOmitted).toBe(0);
  });

  it("inadmissible live ids are omitted and counted", () => {
    const params: ClearBlockParams = { kind: "coordination", outcome: "resumed" };
    const live = ctx("a prose id", "another prose thread");
    const out = composeClearInput({
      agentId: AGENT,
      current: live,
      params,
      subject: composeClearSubject(AGENT, live, params).subject,
      clears: "k",
    });
    expect(out.idsOmitted).toBe(2);
    expect(out.input.detail).toEqual({ agentId: AGENT, outcome: "resumed" });
    expect(out.input.evidence).toEqual([]);
  });
});

describe("D9 counters", () => {
  beforeEach(() => __resetBlockProducerCountersForTests());

  it("starts at zero with the full counter set", () => {
    expect(getBlockProducerSnapshot()).toEqual({
      reported: 0,
      cleared: 0,
      clearNoOpen: 0,
      refused: 0,
      unavailable: 0,
      disabled: 0,
      faults: 0,
      subjectFallback: 0,
    });
  });

  it("counts, snapshots by copy, and resets", () => {
    countBlockProducer("refused");
    countBlockProducer("refused");
    countBlockProducer("subjectFallback");
    const snap = getBlockProducerSnapshot();
    expect(snap.refused).toBe(2);
    expect(snap.subjectFallback).toBe(1);
    snap.refused = 99;
    expect(getBlockProducerSnapshot().refused).toBe(2);
    __resetBlockProducerCountersForTests();
    expect(getBlockProducerSnapshot().refused).toBe(0);
  });
});
