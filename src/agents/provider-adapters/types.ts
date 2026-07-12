import type { ResourceLimits } from "../model-router.js";
import type { RunResult, StreamCallback, WorkItemContext } from "../agent-runner.js";

export type AgentProviderId = "claude" | "openai" | "gemini" | "codex";

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
