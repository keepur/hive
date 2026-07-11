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
}

export interface AgentProviderAdapter {
  readonly provider: AgentProviderId;
  runTurn(request: AgentProviderTurnRequest): Promise<RunResult>;
  abort(): void;
  readonly wasAborted: boolean;
}
