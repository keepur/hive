import type { AgentRunner } from "../agent-runner.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest } from "./types.js";

export class ClaudeAgentAdapter implements AgentProviderAdapter {
  readonly provider = "claude" as const;

  constructor(private readonly runner: AgentRunner) {}

  runTurn(request: AgentProviderTurnRequest) {
    return this.runner.send(
      request.prompt,
      request.sessionId,
      request.onStream,
      request.workItemContext,
      request.resourceLimits,
      request.systemPromptOverride,
      request.effort,
    );
  }

  abort(): void {
    this.runner.abort();
  }

  get wasAborted(): boolean {
    return this.runner.wasAborted;
  }
}
