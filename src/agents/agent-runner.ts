import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import { config } from "../config.js";

const log = createLogger("agent-runner");

export type StreamCallback = (chunk: string) => void;

export interface RunResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  streamed: boolean;
  error?: string;
}

export class AgentRunner {
  private agentConfig: AgentConfig;
  private memoryManager: MemoryManager;
  private sessionId: string | undefined;
  private activeQuery: Query | null = null;

  constructor(agentConfig: AgentConfig, memoryManager: MemoryManager) {
    this.agentConfig = agentConfig;
    this.memoryManager = memoryManager;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  private async buildSystemPrompt(): Promise<string> {
    const parts: string[] = [];

    if (this.agentConfig.soul) {
      parts.push(this.agentConfig.soul);
    }

    parts.push(this.agentConfig.systemPrompt);

    const memory = await this.memoryManager.read(`agents/${this.agentConfig.id}/memory.md`);
    if (memory) {
      parts.push(`## Your Memory\n${memory}`);
    }

    return parts.join("\n\n---\n\n");
  }

  private buildMcpServers(): Record<string, { type: "http"; url: string; headers?: Record<string, string> }> {
    const servers: Record<string, { type: "http"; url: string; headers?: Record<string, string> }> = {};

    if (config.slack.mcpToken) {
      servers["slack"] = {
        type: "http",
        url: "https://mcp.slack.com/mcp",
        headers: { Authorization: `Bearer ${config.slack.mcpToken}` },
      };
    }

    return servers;
  }

  async send(prompt: string, onStream?: StreamCallback): Promise<RunResult> {
    log.info("Sending prompt to agent", {
      agent: this.agentConfig.id,
      resumeSession: this.sessionId ?? "new",
      promptLength: prompt.length,
      streaming: !!onStream,
    });

    const systemPrompt = await this.buildSystemPrompt();
    const mcpServers = this.buildMcpServers();

    const q = query({
      prompt,
      options: {
        model: this.agentConfig.model,
        systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 10,
        maxBudgetUsd: this.agentConfig.budgetUsd,
        includePartialMessages: !!onStream,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        env: {
          ...process.env,
          ...(config.anthropic.apiKey ? { ANTHROPIC_API_KEY: config.anthropic.apiKey } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/0.1.0",
          CLAUDECODE: undefined,
        },
      },
    });

    this.activeQuery = q;

    let resultText = "";
    let resultSessionId = this.sessionId ?? "";
    let costUsd = 0;
    let durationMs = 0;
    let streamed = false;
    let error: string | undefined;

    try {
      for await (const message of q) {
        const msg = message as SDKMessage;

        if (msg.type === "system" && msg.subtype === "init") {
          resultSessionId = msg.session_id;
          this.sessionId = msg.session_id;
          log.debug("Session initialized", { sessionId: this.sessionId });
        }

        // Stream text chunks in real-time
        if (msg.type === "stream_event" && onStream) {
          const event = (msg as any).event;
          if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
            onStream(event.delta.text);
            streamed = true;
          }
        }

        if (msg.type === "assistant") {
          const content = (msg as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                resultText = block.text;
              }
            }
          }
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
      streamed,
      hasError: !!error,
    });

    return { text: resultText, sessionId: resultSessionId, costUsd, durationMs, streamed, error };
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
