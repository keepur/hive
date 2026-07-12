import type { ResourceLimits } from "../model-router.js";
import type { RunResult, StreamCallback, WorkItemContext } from "../agent-runner.js";

export type AgentProviderId = "claude" | "openai" | "gemini" | "codex";

/**
 * KPR-313: providers whose adapters return a GENUINELY resumable session
 * handle. This is the per-adapter session contract — the write-side
 * never-persist rule (finalizeSpawnResult) and the read-side belt-and-braces
 * (SessionStore.get) both key on it. Resumability is a static per-provider
 * fact, not a per-result flag (spec §3.2 / §7):
 *  - claude: SDK resume via query({ resume }) — KPR-310-verified; ids are
 *    stable on 0.2.104 and an older persisted id resumes the LATEST state (M7b).
 *  - openai: previousResponseId chaining (openai-agents-adapter.ts returns
 *    lastResponseId; server retention 30d > store TTL 7d).
 *  - codex: posts store:false and sends no previous_response_id — stateless by
 *    construction; its codex-pilot-* / resp_* returns are not handles.
 *  - gemini: runEphemeral — stateless; gemini-pilot-* returns are not handles.
 * If a pilot ever implements real chaining, adding it here is that ticket's
 * one-line concern.
 */
export const RESUMABLE_SESSION_PROVIDERS: ReadonlySet<AgentProviderId> = new Set(["claude", "openai"]);

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
  modelOverride?: string;
  resourceLimits?: ResourceLimits;
  systemPromptOverride?: string;
  /**
   * KPR-312: per-turn reasoning effort from the model router's complexity
   * classifier — a parallel channel beside the route (the route carries no
   * effort). Claude adapter forwards it to runner.send → SDK Options.effort;
   * pilots ignore it (same tested precedent as modelOverride/resourceLimits),
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
