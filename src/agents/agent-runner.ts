import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import { config } from "../config.js";

const log = createLogger("agent-runner");

export interface RunResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export class AgentRunner {
  private agentConfig: AgentConfig;
  private sessionId: string | undefined;
  private activeQuery: Query | null = null;

  constructor(agentConfig: AgentConfig) {
    this.agentConfig = agentConfig;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  async send(prompt: string): Promise<RunResult> {
    log.info("Sending prompt to agent", {
      agent: this.agentConfig.id,
      resumeSession: this.sessionId ?? "new",
      promptLength: prompt.length,
    });

    const q = query({
      prompt,
      options: {
        model: this.agentConfig.model,
        systemPrompt: this.agentConfig.systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 10,
        maxBudgetUsd: this.agentConfig.budgetUsd,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: config.anthropic.apiKey,
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/0.1.0",
        },
      },
    });

    this.activeQuery = q;

    let resultText = "";
    let resultSessionId = this.sessionId ?? "";
    let costUsd = 0;
    let durationMs = 0;
    let error: string | undefined;

    try {
      for await (const message of q) {
        const msg = message as SDKMessage;

        if (msg.type === "system" && msg.subtype === "init") {
          resultSessionId = msg.session_id;
          this.sessionId = msg.session_id;
          log.debug("Session initialized", { sessionId: this.sessionId });
        }

        if (msg.type === "assistant") {
          // Extract text from the assistant message content blocks
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                resultText = block.text;
              }
            }
          }
          // Track session ID from each message
          if (msg.session_id) {
            resultSessionId = msg.session_id;
            this.sessionId = msg.session_id;
          }
        }

        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          costUsd = result.total_cost_usd;
          durationMs = result.duration_ms;
          resultSessionId = result.session_id;
          this.sessionId = result.session_id;

          if (result.subtype === "success") {
            resultText = result.result || resultText;
          } else {
            error = result.subtype;
            if ("errors" in result && Array.isArray(result.errors)) {
              error = result.errors.join("; ");
            }
          }
        }
      }
    } catch (err) {
      error = String(err);
      log.error("Agent query failed", { agent: this.agentConfig.id, error });
    } finally {
      this.activeQuery = null;
    }

    log.info("Agent response complete", {
      agent: this.agentConfig.id,
      sessionId: resultSessionId,
      costUsd,
      durationMs,
      hasError: !!error,
    });

    return {
      text: resultText,
      sessionId: resultSessionId,
      costUsd,
      durationMs,
      error,
    };
  }

  abort(): void {
    if (this.activeQuery) {
      log.info("Aborting active query", { agent: this.agentConfig.id });
      this.activeQuery.close();
      this.activeQuery = null;
    }
  }

  resetSession(): void {
    this.sessionId = undefined;
  }
}
