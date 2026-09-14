import { z } from "zod";
import { waitingFor } from "../outage/outage-notices.js";
import {
  BLOCK_EVIDENCE_KIND_RULING,
  BLOCK_EVIDENCE_KIND_WORK_ITEM,
  BLOCK_SUBJECT_KIND,
  HIVE_AGENT_PRODUCER,
  REASON_BLOCK_CLEARED,
  REASON_COORDINATION_BLOCK,
  REASON_SEMANTIC_BLOCK,
} from "./block-reasons.js";
import { ADMISSIBLE_ID_RE, OPS_ID_MAX_LENGTH, admissibleIdOrUndefined } from "./ids.js";
import type { OpsDetail, OpsEvidence, OpsPublishInput, OpsSubject } from "./types.js";

/**
 * KPR-501 — the agent-facing block producer (`hive-agent`).
 *
 * This half is PURE: declared parameter shapes, handler-side value rules,
 * subject / detail / evidence composition and the module-global counters. It
 * performs no I/O, holds no store handle, loads no subscription set and arms
 * no timer. The tool handlers that consume it are built separately and publish
 * only through the publisher's serial queue (D8).
 *
 * ⚠ This file is read AS TEXT by repository scans, comments included. Name the
 * turn path, the event bus's event collection, the event schema registry and
 * KPR-468's ledger in prose only; never spell a reserved WorkItem id prefix as
 * a prefix test. Classification of a work item's source goes through
 * `waitingFor` and nothing else.
 */

// ---------------------------------------------------------------------------
// D6: closed vocabularies
// ---------------------------------------------------------------------------

export const BLOCK_KINDS = ["coordination", "semantic"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const BLOCKED_ON_VALUES = ["agent", "human", "external"] as const;
export type BlockedOn = (typeof BLOCKED_ON_VALUES)[number];

export const CLEAR_OUTCOMES = ["resumed", "cancelled"] as const;
export type ClearOutcome = (typeof CLEAR_OUTCOMES)[number];

/** D6: the agent-id slug convention, bounded at the row's 64. Agent-authored. */
export const BLOCKED_ON_AGENT_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * D6: a ruling reference — exactly one of three closed shapes, anchored as a
 * whole:
 *   1. a Slack message / thread ts            `1757900000.123456`
 *   2. a conversation-qualified ts            `C0AB12CD3EF:1757900000.123456`
 *   3. an issue key, optionally comment-anchored `KPR-451#comment-60079ae4`
 * Every admitted value is at most 35 characters and `ADMISSIBLE_ID_RE`-
 * admissible, so the accept path's evidence id bound never fires on one. The
 * engine verifies SHAPE, never truth. Widening is a one-line change plus its
 * unit limb; it must never widen to the admissible-id charset, which admits
 * credential-shaped strings.
 */
export const RULING_REF_RE =
  /^(?:\d{10}\.\d{6}|[CDG][A-Z0-9]{8,12}:\d{10}\.\d{6}|[A-Z][A-Z0-9]{1,9}-\d{1,7}(?:#comment-[0-9a-f]{8})?)$/;

/** D7 step 4: the bounded wait for the queue before the clear's log read. Not configuration. */
export const FLUSH_DEADLINE_MS = 1000;

// ---------------------------------------------------------------------------
// D6: the seven refusal reason codes
// ---------------------------------------------------------------------------

export const REFUSAL_KIND = "kind";
export const REFUSAL_BLOCKED_ON = "blocked-on";
export const REFUSAL_BLOCKED_ON_AGENT_ID = "blocked-on-agent-id";
export const REFUSAL_OUTCOME = "outcome";
export const REFUSAL_RULING_REF_SHAPE = "ruling-ref-shape";
export const REFUSAL_RULING_REQUIRED = "ruling-required";
export const REFUSAL_THREAD_ID_SHAPE = "thread-id-shape";

export type BlockRefusalReason =
  | typeof REFUSAL_KIND
  | typeof REFUSAL_BLOCKED_ON
  | typeof REFUSAL_BLOCKED_ON_AGENT_ID
  | typeof REFUSAL_OUTCOME
  | typeof REFUSAL_RULING_REF_SHAPE
  | typeof REFUSAL_RULING_REQUIRED
  | typeof REFUSAL_THREAD_ID_SHAPE;

/** A refusal: the code, and text naming the admitted values so the agent can fix the call. */
export interface BlockRefusal {
  ok: false;
  reason: BlockRefusalReason;
  admitted: string;
}

export type BlockValidation<T> = { ok: true; params: T } | BlockRefusal;

const ADMITTED: Record<BlockRefusalReason, string> = {
  [REFUSAL_KIND]: `kind must be one of: ${BLOCK_KINDS.join(", ")}`,
  [REFUSAL_BLOCKED_ON]: `blockedOn must be one of: ${BLOCKED_ON_VALUES.join(", ")}; it is required with kind "coordination" and not accepted with kind "semantic"`,
  [REFUSAL_BLOCKED_ON_AGENT_ID]:
    'blockedOnAgentId must be a lowercase agent id slug (a letter, then up to 63 of a-z, 0-9, "-"), and is accepted only with blockedOn "agent"',
  [REFUSAL_OUTCOME]: `outcome must be one of: ${CLEAR_OUTCOMES.join(", ")}`,
  [REFUSAL_RULING_REF_SHAPE]:
    "rulingRef must be one of: a Slack message ts (1757900000.123456), a conversation-qualified ts (C0AB12CD3EF:1757900000.123456), or an issue key optionally anchored to a comment (KPR-451 or KPR-451#comment-60079ae4)",
  [REFUSAL_RULING_REQUIRED]:
    "a semantic block is cleared only by citing the ruling that resolved it: rulingRef is required (a Slack message ts, a conversation-qualified ts, or an issue key optionally anchored to a comment)",
  [REFUSAL_THREAD_ID_SHAPE]:
    "threadId must be 1 to 200 characters of letters, digits and _ . : # + @ - (a thread id as the engine composes it)",
};

function refuse(reason: BlockRefusalReason): BlockRefusal {
  return { ok: false, reason, admitted: ADMITTED[reason] };
}

function isMember<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// D6: declared raw shapes — type and optionality ONLY
// ---------------------------------------------------------------------------

/**
 * D6: the raw shape handed to `tool()`. Each key is a bare `z.string()` or
 * `z.string().optional()` with a description — NO enum, regex, refinement or
 * strictness. Anything declared here is enforced by the MCP layer before the
 * handler runs, which answers an input-validation error the handler never sees
 * (no reason code, no counter, and a tool fault in KPR-454's record). Every
 * value rule therefore lives in the validators below. A unit test pins the key
 * set and per-key type/optionality literally.
 */
export const REPORT_BLOCK_SHAPE = {
  kind: z
    .string()
    .describe(
      'The kind of block: "coordination" (waiting on an act) or "semantic" (needs a ruling above your authority).',
    ),
  blockedOn: z
    .string()
    .optional()
    .describe(
      'Who the outstanding act belongs to: "agent", "human" or "external". Required with kind "coordination"; not accepted with "semantic".',
    ),
  blockedOnAgentId: z
    .string()
    .optional()
    .describe(
      'The id slug of the agent you are waiting on (lowercase, e.g. "chief-of-staff"). Only with blockedOn "agent".',
    ),
};

export const CLEAR_BLOCK_SHAPE = {
  kind: z.string().describe('The kind of block being cleared: "coordination" or "semantic".'),
  outcome: z.string().describe('How the block ended: "resumed" or "cancelled".'),
  rulingRef: z
    .string()
    .optional()
    .describe(
      "Required for a semantic block: the ruling cited as a Slack message ts (1757900000.123456), a conversation-qualified ts (C0AB12CD3EF:1757900000.123456), or an issue key optionally anchored to a comment (KPR-451#comment-60079ae4).",
    ),
  threadId: z
    .string()
    .optional()
    .describe(
      "Only when the block was raised in another thread of yours: that thread's id. Defaults to the current thread.",
    ),
};

export interface ReportBlockRaw {
  kind: string;
  blockedOn?: string;
  blockedOnAgentId?: string;
}

export interface ClearBlockRaw {
  kind: string;
  outcome: string;
  rulingRef?: string;
  threadId?: string;
}

export type ReportBlockParams =
  { kind: "coordination"; blockedOn: BlockedOn; blockedOnAgentId?: string } | { kind: "semantic" };

export interface ClearBlockParams {
  kind: BlockKind;
  outcome: ClearOutcome;
  rulingRef?: string;
  threadId?: string;
}

// ---------------------------------------------------------------------------
// D6: handler-side value rules
// ---------------------------------------------------------------------------

/**
 * `kind` alone — the report handler needs a valid kind to pick the row whose
 * enabled flag it reads, before the remaining rules run.
 */
export function validateBlockKind(kind: string): BlockValidation<BlockKind> {
  return isMember(BLOCK_KINDS, kind) ? { ok: true, params: kind } : refuse(REFUSAL_KIND);
}

/** The condition reason a block kind publishes under (D3). */
export function conditionReasonIdFor(kind: BlockKind): string {
  return kind === "coordination" ? REASON_COORDINATION_BLOCK : REASON_SEMANTIC_BLOCK;
}

/**
 * D6 `report_block` table. `""` is an ordinary value everywhere here: no
 * vocabulary has an empty member and the slug pattern needs one character.
 */
export function validateReportParams(raw: ReportBlockRaw): BlockValidation<ReportBlockParams> {
  const kind = validateBlockKind(raw.kind);
  if (!kind.ok) return kind;

  if (kind.params === "semantic") {
    if (raw.blockedOn !== undefined) return refuse(REFUSAL_BLOCKED_ON);
    // Without blockedOn there is no "agent" to qualify.
    if (raw.blockedOnAgentId !== undefined) return refuse(REFUSAL_BLOCKED_ON_AGENT_ID);
    return { ok: true, params: { kind: "semantic" } };
  }

  if (raw.blockedOn === undefined || !isMember(BLOCKED_ON_VALUES, raw.blockedOn)) {
    return refuse(REFUSAL_BLOCKED_ON);
  }
  const blockedOn = raw.blockedOn;
  if (raw.blockedOnAgentId !== undefined) {
    if (blockedOn !== "agent" || !BLOCKED_ON_AGENT_ID_RE.test(raw.blockedOnAgentId)) {
      return refuse(REFUSAL_BLOCKED_ON_AGENT_ID);
    }
    return { ok: true, params: { kind: "coordination", blockedOn, blockedOnAgentId: raw.blockedOnAgentId } };
  }
  return { ok: true, params: { kind: "coordination", blockedOn } };
}

/**
 * D6 `clear_block` table plus D7 step 2's class rule. `""` is treated as
 * ABSENT for `rulingRef` only (a semantic clear with it is `ruling-required`;
 * a coordination clear with it carries no ruling evidence); everywhere else it
 * is an ordinary value refusal. No I/O: this runs before the flush and the
 * log read, so a malformed call never pays for either.
 */
export function validateClearParams(raw: ClearBlockRaw): BlockValidation<ClearBlockParams> {
  const kind = validateBlockKind(raw.kind);
  if (!kind.ok) return kind;
  if (!isMember(CLEAR_OUTCOMES, raw.outcome)) return refuse(REFUSAL_OUTCOME);

  const rulingRef = raw.rulingRef === "" ? undefined : raw.rulingRef;
  if (rulingRef !== undefined && !RULING_REF_RE.test(rulingRef)) return refuse(REFUSAL_RULING_REF_SHAPE);
  if (raw.threadId !== undefined && !ADMISSIBLE_ID_RE.test(raw.threadId)) return refuse(REFUSAL_THREAD_ID_SHAPE);
  if (kind.params === "semantic" && rulingRef === undefined) return refuse(REFUSAL_RULING_REQUIRED);

  return {
    ok: true,
    params: {
      kind: kind.params,
      outcome: raw.outcome,
      ...(rulingRef !== undefined ? { rulingRef } : {}),
      ...(raw.threadId !== undefined ? { threadId: raw.threadId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// D4: subject composition
// ---------------------------------------------------------------------------

/**
 * The slice of the live work-item context this module reads. Structural, so
 * this module imports nothing from the runner; the handler passes the live
 * ref's `current` read at execution (`undefined` when no context is held).
 */
export interface BlockLiveContext {
  workItemId?: string;
  threadId?: string;
}

export interface ComposedSubject {
  subject: OpsSubject;
  /** True when the subject fell back to the bare agent id; the handler counts `subjectFallback`. */
  fallback: boolean;
}

/**
 * D4: `"<agentId>:<threadId>"` when a thread id is present, passes
 * `ADMISSIBLE_ID_RE`, and the composed id fits `OPS_ID_MAX_LENGTH`; otherwise
 * `"<agentId>"` with the fallback signal. `agentId` is the constructor slug —
 * never a display name, never a parameter.
 */
export function composeSubject(agentId: string, threadId: string | undefined): ComposedSubject {
  if (threadId !== undefined && ADMISSIBLE_ID_RE.test(threadId)) {
    const id = `${agentId}:${threadId}`;
    if (id.length <= OPS_ID_MAX_LENGTH) return { subject: { kind: BLOCK_SUBJECT_KIND, id }, fallback: false };
  }
  return { subject: { kind: BLOCK_SUBJECT_KIND, id: agentId }, fallback: true };
}

/**
 * The family a clear looks up: the validated `threadId` override when given
 * (it only selects a family — it never reaches `detail`), else the live thread.
 */
export function composeClearSubject(
  agentId: string,
  current: BlockLiveContext | undefined,
  params: Pick<ClearBlockParams, "threadId">,
): ComposedSubject {
  return composeSubject(agentId, params.threadId ?? current?.threadId);
}

// ---------------------------------------------------------------------------
// D5/D6: publish-input composition
// ---------------------------------------------------------------------------

export interface ComposedInput {
  input: OpsPublishInput;
  /** True when the subject fell back (count `subjectFallback`). */
  subjectFallback: boolean;
  /** How many live ids failed the admissibility bound and were omitted (call `countIdOmitted()` per id). */
  idsOmitted: number;
}

/** The live ids through the capture-point bound, with the omission count. */
function liveIds(current: BlockLiveContext | undefined): {
  workItemId?: string;
  threadId?: string;
  idsOmitted: number;
} {
  const workItemId = admissibleIdOrUndefined(current?.workItemId);
  const threadId = admissibleIdOrUndefined(current?.threadId);
  const idsOmitted =
    (current?.workItemId !== undefined && workItemId === undefined ? 1 : 0) +
    (current?.threadId !== undefined && threadId === undefined ? 1 : 0);
  return { workItemId, threadId, idsOmitted };
}

function idDetail(ids: { workItemId?: string; threadId?: string }): OpsDetail {
  return {
    ...(ids.workItemId !== undefined ? { workItemId: ids.workItemId } : {}),
    ...(ids.threadId !== undefined ? { threadId: ids.threadId } : {}),
  };
}

/**
 * A condition report (`coordination-block` / `semantic-block`). `waiting` is
 * derived from the UNFILTERED live work item id (D5) — storage uses the
 * filtered one. `evidence` is the turn's `work-item` when admissible, else `[]`.
 */
export function composeReportInput(args: {
  agentId: string;
  current: BlockLiveContext | undefined;
  params: ReportBlockParams;
}): ComposedInput {
  const { agentId, current, params } = args;
  const { subject, fallback } = composeSubject(agentId, current?.threadId);
  const ids = liveIds(current);

  const detail: OpsDetail = { agentId };
  if (params.kind === "coordination") {
    detail.blockedOn = params.blockedOn;
    if (params.blockedOnAgentId !== undefined) detail.blockedOnAgentId = params.blockedOnAgentId;
  }
  Object.assign(detail, idDetail(ids));

  const evidence: OpsEvidence[] =
    ids.workItemId !== undefined ? [{ kind: BLOCK_EVIDENCE_KIND_WORK_ITEM, id: ids.workItemId }] : [];

  return {
    input: {
      producer: HIVE_AGENT_PRODUCER,
      reasonId: conditionReasonIdFor(params.kind),
      waiting: waitingFor(current?.workItemId),
      subject,
      detail,
      evidence,
    },
    subjectFallback: fallback,
    idsOmitted: ids.idsOmitted,
  };
}

/**
 * A clearing fact (`block-cleared`). `subject` is the family the handler looked
 * up (from `composeClearSubject`) and `clears` the key the log read returned.
 * `waiting` is FIXED `"nobody"` — a clear blocks no one. `detail` ids are
 * always the clearing turn's own, from the live context, never the override.
 * `evidence` is `[ruling?, work-item?]`, at most two entries.
 */
export function composeClearInput(args: {
  agentId: string;
  current: BlockLiveContext | undefined;
  params: ClearBlockParams;
  subject: OpsSubject;
  clears: string;
}): Omit<ComposedInput, "subjectFallback"> {
  const { agentId, current, params, subject, clears } = args;
  const ids = liveIds(current);

  const detail: OpsDetail = { agentId, outcome: params.outcome, ...idDetail(ids) };

  const evidence: OpsEvidence[] = [];
  if (params.rulingRef !== undefined) evidence.push({ kind: BLOCK_EVIDENCE_KIND_RULING, id: params.rulingRef });
  if (ids.workItemId !== undefined) evidence.push({ kind: BLOCK_EVIDENCE_KIND_WORK_ITEM, id: ids.workItemId });

  return {
    input: {
      producer: HIVE_AGENT_PRODUCER,
      reasonId: REASON_BLOCK_CLEARED,
      waiting: "nobody",
      subject,
      detail,
      evidence,
      clears,
    },
    idsOmitted: ids.idsOmitted,
  };
}

// ---------------------------------------------------------------------------
// D9: module-global counters
// ---------------------------------------------------------------------------

export interface BlockProducerCounters {
  reported: number;
  cleared: number;
  clearNoOpen: number;
  refused: number;
  unavailable: number;
  disabled: number;
  faults: number;
  subjectFallback: number;
}

function zeroCounters(): BlockProducerCounters {
  return {
    reported: 0,
    cleared: 0,
    clearNoOpen: 0,
    refused: 0,
    unavailable: 0,
    disabled: 0,
    faults: 0,
    subjectFallback: 0,
  };
}

/**
 * One set per process, not per runner: the tools are built per runner, and a
 * per-runner counter would die with the spawn. Nothing here is published —
 * a fault of the ops path is logged and counted, never published.
 */
let counters: BlockProducerCounters = zeroCounters();

export function countBlockProducer(name: keyof BlockProducerCounters): void {
  counters[name] += 1;
}

/** D9: the snapshot surface. No production reader exists; a copy, so callers cannot mutate the set. */
export function getBlockProducerSnapshot(): BlockProducerCounters {
  return { ...counters };
}

/** Test seam only. */
export function __resetBlockProducerCountersForTests(): void {
  counters = zeroCounters();
}
