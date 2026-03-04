import { query, type Query, type SDKMessage, type SDKResultMessage, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import { config } from "../config.js";

const log = createLogger("agent-runner");

export type StreamCallback = (chunk: string) => void;

export interface WorkItemContext {
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
}

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
  private activeQuery: Query | null = null;

  constructor(agentConfig: AgentConfig, memoryManager: MemoryManager) {
    this.agentConfig = agentConfig;
    this.memoryManager = memoryManager;
  }

  private async buildSystemPrompt(): Promise<string> {
    const parts: string[] = [];

    if (this.agentConfig.soul) {
      parts.push(this.agentConfig.soul);
    }

    parts.push(this.agentConfig.systemPrompt);

    // Constitution is always loaded — non-negotiable team rules
    const constitution = await this.memoryManager.read("shared/constitution.md");
    if (constitution) {
      parts.push(constitution);
    }

    const memoryDir = `agents/${this.agentConfig.id}`;
    const memory = await this.memoryManager.read(`${memoryDir}/memory.md`);
    if (memory) {
      parts.push(`## Your Memory\n${memory}`);
    }

    // List available memory files so the agent knows what references it has
    const memoryFiles = await this.memoryManager.list(memoryDir);
    const mdFiles = memoryFiles.filter((f) => f.endsWith(".md") && f !== "memory.md");
    if (mdFiles.length > 0) {
      parts.push(
        `## Available Memory Files\nYou have ${mdFiles.length} reference file(s) in your memory directory:\n` +
        mdFiles.map((f) => `- ${memoryDir}/${f}`).join("\n") +
        `\n\nRead relevant files via the memory MCP server (\`memory_read\`) before starting tasks that may relate to them.`,
      );
    }

    return parts.join("\n\n---\n\n");
  }

  private buildMcpServers(context?: WorkItemContext): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {};

    // Slack MCP — use agent-specific bot token if configured, otherwise primary
    const slackMcpToken = this.agentConfig.slackBot === "jasper"
      ? config.slackJasper.mcpToken
      : config.slack.mcpToken;
    if (slackMcpToken) {
      servers["slack"] = {
        type: "http",
        url: "https://mcp.slack.com/mcp",
        headers: { Authorization: `Bearer ${slackMcpToken}` },
      };
    }

    // Memory MCP server — gives the agent read/write access to its own memory
    servers["memory"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/memory/memory-mcp-server.js")],
      env: {
        AGENT_ID: this.agentConfig.id,
        MEMORY_REPO_PATH: config.memory.localPath,
      },
    };

    // Keychain MCP server — read-only access to macOS Keychain secrets
    servers["keychain"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/keychain/keychain-mcp-server.js")],
    };

    // Google MCP server — Gmail + Calendar via gog CLI
    servers["google"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/google/google-mcp-server.js")],
      env: {
        ...(config.google?.account ? { GOG_ACCOUNT: config.google.account } : {}),
        PATH: process.env.PATH ?? "",
      },
    };

    // Quo MCP server — SMS, calls, contacts via Quo (OpenPhone) API
    if (config.quo.apiKey) {
      servers["quo"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/quo/quo-mcp-server.js")],
        env: {
          QUO_API_KEY: config.quo.apiKey,
          ...(config.quo.phoneNumberId ? { QUO_PHONE_NUMBER_ID: config.quo.phoneNumberId } : {}),
          QUO_LINES_JSON: JSON.stringify(config.quo.lines),
        },
      };
    }

    // Contacts MCP server — centralized contact lookup (MongoDB)
    servers["contacts"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/contacts/contacts-mcp-server.js")],
      env: {
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
      },
    };

    // External task ledger
    if (config.taskLedger.apiKey) {
      servers["tasks"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/tasks/task-mcp-server.js")],
        env: {
          TASK_LEDGER_API_URL: config.taskLedger.apiUrl,
          TASK_LEDGER_API_KEY: config.taskLedger.apiKey,
        },
      };
    }

    // Brave Search — web search and research
    if (config.brave.apiKey) {
      servers["brave-search"] = {
        type: "stdio",
        command: "node",
        args: [resolve("node_modules/brave-search-mcp/dist/index.js")],
        env: {
          BRAVE_API_KEY: config.brave.apiKey,
        },
      };
    }

    // Resend — email sending with HubSpot BCC logging
    if (config.resend.apiKey) {
      servers["resend"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/resend/resend-mcp-server.js")],
        env: {
          RESEND_API_KEY: config.resend.apiKey,
          RESEND_FROM_ADDRESS: config.resend.fromAddress,
          RESEND_DEFAULT_CC: config.resend.defaultCc,
          HUBSPOT_BCC: config.resend.hubspotBcc,
        },
      };
    }

    // Linear — issue tracking (per-agent team via memory, LINEAR_TEAM_ID is optional default)
    if (config.linear.apiKey) {
      const env: Record<string, string> = {
        LINEAR_API_KEY: config.linear.apiKey,
      };
      if (config.linear.teamId) {
        env.LINEAR_TEAM_ID = config.linear.teamId;
      }
      servers["linear"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/linear/linear-mcp-server.js")],
        env,
      };
    }

    // Recall.ai — meeting bots and transcription
    if (config.recall.apiKey) {
      servers["recall"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/recall/recall-mcp-server.js")],
        env: {
          RECALL_API_KEY: config.recall.apiKey,
          RECALL_API_REGION: config.recall.region,
        },
      };
    }

    // Background task server — agents can spawn detached background processes
    servers["background"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/background/background-task-mcp-server.js")],
      env: {
        BG_TASK_API: `http://127.0.0.1:${config.background.port}`,
        BG_AGENT_ID: this.agentConfig.id,
        BG_ADAPTER_ID: context?.adapterId ?? "",
        BG_CHANNEL_ID: context?.channelId ?? "",
        BG_CHANNEL_KIND: context?.channelKind ?? "internal",
        BG_CHANNEL_LABEL: context?.channelLabel ?? "",
        BG_THREAD_ID: context?.threadId ?? "",
        BG_SLACK_TS: context?.slackTs ?? "",
        BG_SLACK_THREAD_TS: context?.slackThreadTs ?? "",
      },
    };

    // Guardrail: filter to agent's allowed MCP servers
    if (this.agentConfig.servers?.length) {
      const allowed = new Set(this.agentConfig.servers);
      for (const key of Object.keys(servers)) {
        if (!allowed.has(key)) {
          delete servers[key];
        }
      }
    }

    return servers;
  }

  async send(prompt: string, sessionId?: string, onStream?: StreamCallback, context?: WorkItemContext): Promise<RunResult> {
    log.info("Sending prompt to agent", {
      agent: this.agentConfig.id,
      resumeSession: sessionId ?? "new",
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 200),
      streaming: !!onStream,
    });

    const systemPrompt = await this.buildSystemPrompt();
    const mcpServers = this.buildMcpServers(context);

    const q = query({
      prompt,
      options: {
        model: this.agentConfig.model,
        systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: this.agentConfig.maxTurns,
        maxBudgetUsd: this.agentConfig.budgetUsd,
        includePartialMessages: !!onStream,
        ...(sessionId ? { resume: sessionId } : {}),
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
    let resultSessionId = sessionId ?? "";
    let costUsd = 0;
    let durationMs = 0;
    let streamed = false;
    let error: string | undefined;

    const timeoutMs = this.agentConfig.timeoutMs ?? 300_000; // 5 min default
    const deadline = setTimeout(() => {
      log.warn("Agent query timed out, aborting", {
        agent: this.agentConfig.id,
        timeoutMs,
      });
      this.abort();
    }, timeoutMs);

    try {
      for await (const message of q) {
        const msg = message as SDKMessage;

        if (msg.type === "system" && msg.subtype === "init") {
          resultSessionId = msg.session_id;
          log.debug("Session initialized", { sessionId: resultSessionId });
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
          }
        }

        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          costUsd = result.total_cost_usd;
          durationMs = result.duration_ms;
          resultSessionId = result.session_id;

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
      clearTimeout(deadline);
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
}
