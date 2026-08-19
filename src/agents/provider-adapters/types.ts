import type { ResourceLimits } from "../model-router.js";
import type { RunResult, StreamCallback, WorkItemContext } from "../agent-runner.js";

export type AgentProviderId = "claude" | "openai" | "gemini" | "codex" | "kimi" | "deepseek";

/**
 * KPR-347: the native-lane (Lane B) adapter providers — the set whose
 * adapters run a provider SDK/API directly and need the hive bridge.
 * DELIBERATELY a literal union, NOT Exclude<AgentProviderId, "claude">:
 * Lane A providers (kimi/deepseek — child 1) join AgentProviderId but run
 * the Claude-lane runtime and must NEVER gain a compatibility column or a
 * bridge path. Growing this union is a Lane B replication child's explicit
 * one-line concern.
 */
export type LaneBProviderId = "openai" | "gemini" | "codex";

/**
 * KPR-347 (epic §D3): per-provider session continuity semantics. Drives
 * AgentManager persistence (write side) and SessionStore normalization
 * (read side). Supersedes RESUMABLE_SESSION_PROVIDERS (deleted) while
 * preserving the KPR-313 principle it encoded: resumability is a static
 * per-provider fact, not a per-result flag.
 *
 *  - "server-resumable":   provider holds session state; the returned
 *                          sessionId is a real server handle (openai
 *                          previous_response_id chaining — KPR-350 §D1 ruling;
 *                          server retention 30d > store TTL 7d; stale handles
 *                          self-heal, §D3); gemini previous_interaction_id
 *                          chaining — KPR-352: server retention 55d paid / 1d
 *                          free vs 7d store TTL, stale handles self-heal
 *                          through the same §D3 arm.
 *  - "conversation-store": provider-side durable conversation object; the
 *                          persisted ref would be a conversation id.
 *                          UNOCCUPIED BY RULING (KPR-350 §D1): chaining won
 *                          for openai — hive's 7d sessions TTL makes >30d
 *                          durability unreachable, and Conversations adds a
 *                          create-lifecycle + org-affinity hazard + indefinite
 *                          vendor-side residue. Category retained for a
 *                          hypothetical future provider whose only durable
 *                          layer is a conversation object.
 *  - "client-transcript":  session id is persisted and resume works via
 *                          client-side transcript replay (Claude CLI today —
 *                          KPR-310-verified stable ids; Lane A passthrough
 *                          providers — child 1).
 *  - "stateless-replay":   NO provider-side resumable handle exists;
 *                          continuity, if any, is hive-persisted history
 *                          replayed client-side. Codex posts store:false and
 *                          sends no previous_response_id — its pilot-fabricated
 *                          ids are not handles. Replay shipped in KPR-353
 *                          (TurnHistoryStore / provider_turn_history, replayed
 *                          client-side by the adapter); the persistence
 *                          behavior (never persist a handle) is what this
 *                          descriptor keys. (gemini exited this category in
 *                          KPR-352 — see server-resumable.)
 */
export type SessionSemantics =
  | "server-resumable"
  | "conversation-store"
  | "client-transcript"
  | "stateless-replay";

/**
 * Exhaustive by construction: adding a provider id without declaring its
 * semantics is a compile error (the property the old Set silently lacked —
 * an undeclared provider was implicitly non-resumable). Child 1 adds Lane A
 * ids here as "client-transcript"; KPR-350 and the replication children
 * change values, one line each, in the same PR as the mechanism.
 */
export const SESSION_SEMANTICS: Readonly<Record<AgentProviderId, SessionSemantics>> = {
  claude: "client-transcript",
  openai: "server-resumable",
  // KPR-352 (§D3): gemini exits stateless-replay — the Interactions adapter
  // chains previous_interaction_id, a real server handle persisted and resumed
  // through the same paths as openai (stale handles self-heal via the §D3 arm).
  gemini: "server-resumable",
  codex: "stateless-replay",
  // KPR-346 (§D2): Lane A passthrough — the Claude CLI's session ids are
  // local transcript handles independent of the completions endpoint; resume
  // replays the transcript client-side (cold vendor cache, re-billed tokens —
  // documented parity-matrix caveat).
  kimi: "client-transcript",
  deepseek: "client-transcript",
};

export function sessionSemanticsFor(provider: AgentProviderId): SessionSemantics {
  return SESSION_SEMANTICS[provider];
}

/** True ⇔ the persisted sessionId is a real handle worth storing/resuming. */
export function persistsResumableHandle(semantics: SessionSemantics): boolean {
  return semantics !== "stateless-replay";
}

/**
 * Neutral reasoning-effort scale (KPR-311). Canonical home — pilot adapter
 * options and ModelRouterResult carriage both reference this. Values mirror
 * the codex effort suffix scale parsed by splitProviderModel.
 */
export type ReasoningEffort = "minimal" | "none" | "low" | "medium" | "high" | "xhigh";

export interface AgentProviderTurnRequest {
  prompt: string;
  sessionId?: string;
  onStream?: StreamCallback;
  workItemContext?: WorkItemContext;
  resourceLimits?: ResourceLimits;
  systemPromptOverride?: string;
  /**
   * KPR-312: per-turn reasoning effort from the model router's complexity
   * classifier — a parallel channel beside the route (the route carries no
   * effort). Claude adapter forwards it to runner.send → SDK Options.effort;
   * pilots ignore it (same tested precedent as resourceLimits),
   * and under the KPR-311 pilot gate they never receive one.
   */
  effort?: ReasoningEffort;
}

export interface AgentProviderAdapter {
  readonly provider: AgentProviderId;
  runTurn(request: AgentProviderTurnRequest): Promise<RunResult>;
  abort(): void;
  readonly wasAborted: boolean;
}

/** KPR-347 (§D1.3): one tool call presented to the guardrail gate. */
export interface GuardrailToolCall {
  toolName: string;
  input: unknown;
  workItemContext?: WorkItemContext;
}

export type GuardrailDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason: string };

/**
 * KPR-347 (consumed by KPR-348's dispatch loop): fail-closed pre-execution
 * gate — the Lane B analog of the archetype PreToolUse hooks. The bridge
 * MUST call it before every tool execution and MUST treat a gate throw as
 * deny (contained per the epic §D4 exception-containment invariant: a gate
 * throw becomes a structured error result, classifies non-provider, and
 * never escapes runTurn).
 */
export type GuardrailGate = (call: GuardrailToolCall) => Promise<GuardrailDecision>;
