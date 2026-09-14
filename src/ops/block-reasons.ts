import type { OpsReason } from "./types.js";

/**
 * KPR-501 D3/D12: the agent-facing block producer's reason table and the
 * constants a reader imports rather than hand-copies (the `MEETING_ACK_TEXT`
 * precedent). Imports only `types.ts` — the `reasons.ts` layering — and never
 * `reasons.ts` itself, which imports this module to build its table list.
 *
 * The producer literal lives here (and in the producer module that publishes
 * under it), never in a validator: producer and reasonId are bounded by the
 * token pattern, not checked against a list.
 */

/** D1/D3: an agent, reporting a block on its own work. A bounded token, never an enum member. */
export const HIVE_AGENT_PRODUCER = "hive-agent";

export const REASON_BLOCK_CLEARED = "block-cleared";
export const REASON_COORDINATION_BLOCK = "coordination-block";
export const REASON_SEMANTIC_BLOCK = "semantic-block";

/** D4/D12: the subject kind. Not `workItem` — a capital letter fails the token pattern. */
export const BLOCK_SUBJECT_KIND = "agent-work";

/** D6/D12: the evidence kinds this producer attaches. */
export const BLOCK_EVIDENCE_KIND_WORK_ITEM = "work-item";
export const BLOCK_EVIDENCE_KIND_RULING = "ruling";

/**
 * D3: the three rows this producer ships, all enabled at deploy.
 *
 * ORDER IS LOAD-BEARING (D3, the same severity argument as the runtime
 * producer's table): `block-cleared` is upserted FIRST. Neither order leaves
 * every prefix of the write sequence legal, so the choice is between two
 * illegal middle states. Condition-first would leave a persisted, ENABLED,
 * class:resource `coordination-block` row that no registered reason clears —
 * the state the enable gate exists to refuse, live and consequential (a block
 * raised under it could never be cleared). Clearing-first leaves a dangling
 * forward reference that nothing dereferences: `block-cleared` is
 * informational so nothing selects it, its clearsReasonIds is read only by the
 * gate and the publish-time check, and with the condition rows unregistered
 * every condition publish fails closed. A bookkeeping defect beats a silence
 * generator, and the next boot repairs it.
 *
 * `agentId` is bounded at the 200 ceiling (not the runtime producer's optional
 * 64) because here it is REQUIRED and engine-held: agent ids are not
 * length-validated anywhere, and a required key composed from an engine value
 * must never trip the accept path's reject-and-count for every publish of one
 * agent. `blockedOnAgentId` stays at 64 — it is agent-authored, so a refusal
 * there is the agent's to fix.
 *
 * Templates interpolate always-present keys only.
 *
 * DO NOT reorder this array.
 */
export const HIVE_AGENT_REASONS: readonly OpsReason[] = [
  {
    producer: HIVE_AGENT_PRODUCER,
    reasonId: REASON_BLOCK_CLEARED,
    class: "informational",
    retry: "transient",
    clearsReasonIds: [REASON_COORDINATION_BLOCK, REASON_SEMANTIC_BLOCK],
    detailKeys: [
      { key: "agentId", type: "string", maxLength: 200 },
      { key: "outcome", type: "string", maxLength: 16 },
      { key: "workItemId", type: "string", maxLength: 200, optional: true },
      { key: "threadId", type: "string", maxLength: 200, optional: true },
    ],
    remediationTemplate:
      "none; recorded so {agentId}'s block closes ({outcome}) and reopens as a new epoch if it returns",
    enabled: true,
  },
  {
    producer: HIVE_AGENT_PRODUCER,
    reasonId: REASON_COORDINATION_BLOCK,
    // D3: cleared by the agent itself when the awaited act lands — the same
    // producer asserting the recorded predicate now holds.
    class: "resource",
    // D3: re-running the blocked agent does not unblock it; something must change first.
    retry: "deterministic",
    detailKeys: [
      { key: "agentId", type: "string", maxLength: 200 },
      { key: "blockedOn", type: "string", maxLength: 16 },
      { key: "blockedOnAgentId", type: "string", maxLength: 64, optional: true },
      { key: "workItemId", type: "string", maxLength: 200, optional: true },
      { key: "threadId", type: "string", maxLength: 200, optional: true },
    ],
    remediationTemplate:
      "{agentId} is blocked on {blockedOn}; supply what it is waiting for, and it clears the block itself (clear_block, resumed or cancelled)",
    enabled: true,
  },
  {
    producer: HIVE_AGENT_PRODUCER,
    reasonId: REASON_SEMANTIC_BLOCK,
    // D3: a decision above the producer's authority, closed only by a named human's ruling.
    class: "judgment",
    retry: "deterministic",
    detailKeys: [
      { key: "agentId", type: "string", maxLength: 200 },
      { key: "workItemId", type: "string", maxLength: 200, optional: true },
      { key: "threadId", type: "string", maxLength: 200, optional: true },
    ],
    remediationTemplate:
      "{agentId} needs a ruling above its authority; a named human rules, and the agent clears the block citing the ruling",
    enabled: true,
  },
];
