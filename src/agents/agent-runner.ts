import { query, type Query, type SDKMessage, type SDKResultMessage, type McpServerConfig, type SdkPluginConfig, type AgentDefinition, type HookEvent, type HookCallbackMatcher, type HookInput } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import { config } from "../config.js";
import type { LoadedPlugin } from "../plugins/types.js";
import { type SkillIndex, getSkillsForAgent } from "./skill-loader.js";
import { SERVER_CATALOG, formatCatalogEntry, type ServerCatalogEntry } from "../tools/server-catalog.js";
import type { ResourceLimits } from "./model-router.js";
import type { CodeIndexPrefetcher } from "../code-index/prefetcher.js";

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
  llmMs: number;
  toolMs: number;
  toolCalls: number;
  toolSummary: string;
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number; // Model's max context size (e.g. 200000), NOT current utilization
  compactions: number;
  preCompactTokens?: number; // Token count before last compaction (from compact_metadata.pre_tokens)
  error?: string;
  aborted?: boolean;
}

export class AgentRunner {
  static registryRef?: import("./agent-registry.js").AgentRegistry;

  private agentConfig: AgentConfig;
  private memoryManager: MemoryManager;
  private plugins: LoadedPlugin[];
  private skillIndex: SkillIndex;
  private activeQuery: Query | null = null;
  private eventSubscribersJson: string;
  private prefetcher?: CodeIndexPrefetcher;

  constructor(agentConfig: AgentConfig, memoryManager: MemoryManager, plugins: LoadedPlugin[] = [], skillIndex: SkillIndex = new Map(), eventSubscribersJson = "{}", prefetcher?: CodeIndexPrefetcher) {
    this.agentConfig = agentConfig;
    this.memoryManager = memoryManager;
    this.plugins = plugins;
    this.skillIndex = skillIndex;
    this.eventSubscribersJson = eventSubscribersJson;
    this.prefetcher = prefetcher;
  }

  private async buildSystemPrompt(coreServerNames: string[], activeDelegates?: string[]): Promise<string> {
    // Prompt ordered for cache efficiency: static content first (cacheable prefix),
    // dynamic content last (only invalidates suffix). API caches identical prefixes.
    const parts: string[] = [];

    // --- Static prefix (stable across turns → cacheable) ---

    if (this.agentConfig.soul) {
      parts.push(this.agentConfig.soul);
    }

    parts.push(this.agentConfig.systemPrompt);

    // Constitution is always loaded — non-negotiable team rules
    const constitution = await this.memoryManager.read("shared/constitution.md");
    if (constitution) {
      parts.push(constitution);
    }

    // --- Semi-static (stable within a session, changes on restart) ---

    // Inject core server summaries so the agent knows what tools it has directly
    // Exclude infrastructure servers that are always present and self-explanatory
    const visibleCoreServers = coreServerNames.filter((s) => !AgentRunner.INFRASTRUCTURE_SERVERS.has(s));
    if (visibleCoreServers.length > 0) {
      const lines = visibleCoreServers.map((s) => formatCatalogEntry(s, this.getServerCatalogEntry(s)));
      parts.push(
        `## Your tools\n\nDirect tools available to you:\n${lines.join("\n")}`,
      );
    }

    // Inject delegate namespace summaries so the agent knows what subagents are available
    // Uses activeDelegates (actually constructed) rather than config (may include credential-gated servers)
    const delegates = activeDelegates ?? [];
    if (delegates.length > 0) {
      const lines = delegates.map((s) => formatCatalogEntry(s, this.getServerCatalogEntry(s)));
      parts.push(
        `## Available via subagents\n\nYou have additional capabilities through delegation. If a task involves any of these domains, use the Agent tool — do NOT say you lack access:\n${lines.join("\n")}`,
      );
    }

    // --- Dynamic suffix (changes per turn → not cached) ---

    // Memory injection — prefer structured records, fall back to legacy blob
    const hotTierPrompt = await this.memoryManager.getHotTierPrompt(
      this.agentConfig.id,
      config.memory.hotBudgetTokens,
    );
    if (hotTierPrompt) {
      parts.push(hotTierPrompt);
    } else {
      // Legacy path — inject memory.md blob if structured records don't exist yet
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
    }

    // Date/time last — changes every minute, so placing it at the end
    // preserves the static prefix for prompt caching
    const now = new Date();
    const pacific = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    parts.push(`**Current date/time**: ${pacific} (Pacific Time)`);

    return parts.join("\n\n---\n\n");
  }



  /**
   * Build config for a single named MCP server.
   * Without a WorkItemContext, context-dependent servers (callback, background, recall, etc.)
   * will have empty channel/thread env vars — only use without context for non-context servers.
   */
  buildServerConfig(name: string, context?: WorkItemContext): McpServerConfig | undefined {
    const all = this.buildAllServerConfigs(context);
    return all[name];
  }

  /**
   * Build ALL server configs (core + plugin), no filtering.
   * This is the source of truth for server configs — buildMcpServers and buildServerConfig call this.
   */
  private buildAllServerConfigs(context?: WorkItemContext): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {};

    // Slack MCP
    const slackMcpToken = config.slack.mcpToken;
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
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
      },
    };

    // Structured Memory MCP server — semantic + temporal memory with vector search
    servers["structured-memory"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/memory/structured-memory-mcp-server.js")],
      env: {
        AGENT_ID: this.agentConfig.id,
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
        CHANNEL_ID: context?.channelId ?? "",
        THREAD_ID: context?.threadId ?? "",
        QDRANT_URL: process.env.QDRANT_URL ?? "http://localhost:6333",
        OLLAMA_URL: process.env.OLLAMA_URL ?? "http://localhost:11434",
      },
    };

    // Keychain MCP server — read-only access to macOS Keychain secrets
    servers["keychain"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/keychain/keychain-mcp-server.js")],
    };

    // Google MCP server — Gmail + Calendar via gog CLI
    // Per-agent account from google.accounts map, falls back to global google.account
    const gogAccount = config.google.accounts[this.agentConfig.id] || config.google.account;
    const gogClient = config.google.client;
    servers["google"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/google/google-mcp-server.js")],
      env: {
        ...(gogAccount ? { GOG_ACCOUNT: gogAccount } : {}),
        ...(gogClient ? { GOG_CLIENT: gogClient } : {}),
        DRIVE_SHARED_FOLDER: config.google.sharedFolder,
        INSTANCE_ID: config.instance.id,
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

    // Voice MCP server — outbound phone calls via Vapi
    if (config.voice.enabled && config.voice.apiKey) {
      // Resolve the Vapi assistant ID for this agent (reverse lookup from config.voice.assistants)
      const vapiAssistantId = Object.entries(config.voice.assistants)
        .find(([_, hiveId]) => hiveId === this.agentConfig.id)?.[0] ?? "";

      servers["voice"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/voice/voice-mcp-server.js")],
        env: {
          VAPI_API_KEY: config.voice.apiKey,
          VAPI_PHONE_NUMBER_ID: config.voice.phoneNumberId,
          VAPI_ASSISTANT_ID: vapiAssistantId,
          AGENT_ID: this.agentConfig.id,
          AGENT_NAME: this.agentConfig.name,
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

    // External task ledger — per-agent API key for attribution
    const taskKey = config.taskLedger.agentKeys[this.agentConfig.id] ?? config.taskLedger.apiKey;
    if (taskKey) {
      servers["tasks"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/tasks/task-mcp-server.js")],
        env: {
          TASK_LEDGER_API_URL: config.taskLedger.apiUrl,
          TASK_LEDGER_API_KEY: taskKey,
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
    // Each agent sends from their own address: Name <name@domain.com>
    if (config.resend.apiKey) {
      const agentName = this.agentConfig.name.toLowerCase();
      const emailDomain = config.resend.emailDomain;
      const businessLabel = config.resend.businessName ? ` (${config.resend.businessName})` : "";
      const agentFromAddress = emailDomain
        ? `${this.agentConfig.name}${businessLabel} <${agentName}@${emailDomain}>`
        : config.resend.fromAddress;
      servers["resend"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/resend/resend-mcp-server.js")],
        env: {
          RESEND_API_KEY: config.resend.apiKey,
          RESEND_FROM_ADDRESS: agentFromAddress,
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

    // GitHub Issues — issue tracking via gh CLI
    if (config.github.repo) {
      const ghEnv: Record<string, string> = {
        GITHUB_REPO: config.github.repo,
        PATH: process.env.PATH ?? "",
      };
      if (config.github.token) {
        ghEnv.GH_TOKEN = config.github.token;
      }
      servers["github-issues"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/github/github-issues-mcp-server.js")],
        env: ghEnv,
      };
    }

    // ClickUp — task management across workspaces
    if (config.clickup.apiToken) {
      servers["clickup"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/clickup/clickup-mcp-server.js")],
        env: {
          CLICKUP_API_TOKEN: config.clickup.apiToken,
        },
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
          RECALL_WEBHOOK_SECRET: config.recall.webhookSecret,
          MEETING_MONITOR_API: `http://127.0.0.1:${config.recall.monitorPort}`,
          MEETING_MONITOR_PUBLIC_URL: config.recall.monitorPublicUrl,
          RECALL_AGENT_ID: this.agentConfig.id,
          RECALL_ADAPTER_ID: context?.adapterId ?? "",
          RECALL_CHANNEL_ID: context?.channelId ?? "",
          RECALL_CHANNEL_KIND: context?.channelKind ?? "internal",
          RECALL_CHANNEL_LABEL: context?.channelLabel ?? "",
          RECALL_THREAD_ID: context?.threadId ?? "",
          RECALL_SLACK_TS: context?.slackTs ?? "",
          RECALL_SLACK_THREAD_TS: context?.slackThreadTs ?? "",
        },
      };
    }

    // Browser — Playwright MCP connected to user's Chrome via CDP
    if (config.browser.cdpEndpoint) {
      servers["browser"] = {
        type: "stdio",
        command: "npx",
        args: ["@playwright/mcp@latest", "--cdp-endpoint", config.browser.cdpEndpoint],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
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
        BG_AUTH_TOKEN: config.background.authToken,
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

    // Callback server — agents can schedule future self-invocations
    servers["callback"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/callback/callback-mcp-server.js")],
      env: {
        CB_AGENT_ID: this.agentConfig.id,
        CB_ADAPTER_ID: context?.adapterId ?? "",
        CB_CHANNEL_ID: context?.channelId ?? "",
        CB_CHANNEL_KIND: context?.channelKind ?? "internal",
        CB_CHANNEL_LABEL: context?.channelLabel ?? "",
        CB_THREAD_ID: context?.threadId ?? "",
        CB_SLACK_TS: context?.slackTs ?? "",
        CB_SLACK_THREAD_TS: context?.slackThreadTs ?? "",
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
      },
    };

    // Code task server — agents can spawn Claude Code CLI sessions
    servers["code-task"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/code-task/code-task-mcp-server.js")],
      env: {
        CT_TASK_API: `http://127.0.0.1:${config.codeTask.port}`,
        CT_AUTH_TOKEN: config.codeTask.authToken,
        CT_AGENT_ID: this.agentConfig.id,
        CT_ADAPTER_ID: context?.adapterId ?? "",
        CT_CHANNEL_ID: context?.channelId ?? "",
        CT_CHANNEL_KIND: context?.channelKind ?? "internal",
        CT_CHANNEL_LABEL: context?.channelLabel ?? "",
        CT_THREAD_ID: context?.threadId ?? "",
        CT_SLACK_TS: context?.slackTs ?? "",
        CT_SLACK_THREAD_TS: context?.slackThreadTs ?? "",
      },
    };

    // ── Conversation Search ──────────────────────────────────────
    // Core search server — semantic search over past agent conversations (Qdrant only)
    const searchEnv: Record<string, string> = {
      OLLAMA_URL: process.env.OLLAMA_URL ?? "http://localhost:11434",
      QDRANT_URL: process.env.QDRANT_URL ?? "http://localhost:6333",
    };
    if (process.env.KB_EMBED_MODEL) searchEnv.KB_EMBED_MODEL = process.env.KB_EMBED_MODEL;

    servers["conversation-search"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/search/conversation-search-mcp-server.js")],
      env: {
        ...searchEnv,
        AGENT_ID: this.agentConfig.id,
        DEFAULT_AGENT: config.defaultAgent,
      },
    };

    // ── Code Search ──────────────────────────────────────────────
    // Semantic search over codebase file index (Qdrant + MongoDB)
    servers["code-search"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/code-index/code-search-mcp-server.js")],
      env: {
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
        QDRANT_URL: process.env.QDRANT_URL ?? "http://localhost:6333",
        OLLAMA_URL: process.env.OLLAMA_URL ?? "http://localhost:11434",
      },
    };

    // ── Plugin MCP Servers ──────────────────────────────────────────
    for (const plugin of this.plugins) {
      for (const [name, serverDef] of Object.entries(plugin.manifest.mcpServers)) {
        if (servers[name]) {
          log.warn("Plugin server name conflicts with core server, skipping", {
            plugin: plugin.name, server: name,
          });
          continue;
        }
        const compiledPath = resolve(
          `dist/plugins/${plugin.name}/${serverDef.entry.replace(/\.ts$/, ".js")}`,
        );

        // Base env available to all plugin servers
        const pluginTaskKey = config.taskLedger.agentKeys[this.agentConfig.id] ?? config.taskLedger.apiKey;
        const env: Record<string, string> = {
          AGENT_ID: this.agentConfig.id,
          AGENT_NAME: this.agentConfig.name,
          MONGODB_URI: config.mongo.uri,
          MONGODB_DB: config.mongo.dbName,
          TASK_LEDGER_API_URL: config.taskLedger.apiUrl,
          ...(pluginTaskKey ? { TASK_LEDGER_API_KEY: pluginTaskKey } : {}),
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        };

        for (const envVar of serverDef.env ?? []) {
          if (process.env[envVar]) env[envVar] = process.env[envVar]!;
        }

        // env-map: rename base env vars (e.g. DODI_OPS_API_URL -> TASK_LEDGER_API_URL)
        for (const [targetVar, sourceVar] of Object.entries(serverDef.envMap ?? {})) {
          if (env[sourceVar]) env[targetVar] = env[sourceVar];
        }

        for (const [envVar, fieldName] of Object.entries(serverDef.agentEnv ?? {})) {
          env[envVar] = String((this.agentConfig as any)[fieldName] ?? "");
        }

        servers[name] = {
          type: "stdio",
          command: "node",
          args: [compiledPath],
          env,
        };
      }
    }

    // Event Bus MCP server — emit structured events for cross-agent coordination
    servers["event-bus"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/events/event-bus-mcp-server.js")],
      env: {
        AGENT_ID: this.agentConfig.id,
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
        EVENT_SUBSCRIBERS: this.eventSubscribersJson,
      },
    };

    // Team MCP server — agent-to-agent direct messaging
    if (config.team.enabled) {
      if (!AgentRunner.registryRef) {
        log.warn("Team enabled but registryRef not set — agents will get empty AGENT_IDS");
      }
      servers["team"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/team/team-mcp-server.js")],
        env: {
          AGENT_ID: this.agentConfig.id,
          MONGODB_URI: config.mongo.uri,
          MONGODB_DB: config.mongo.dbName,
          AGENT_IDS: JSON.stringify(
            AgentRunner.registryRef?.getAll().map((a) => a.id) ?? [],
          ),
        },
      };
    }

    // Workflow MCP server — plan/task management
    if (config.workflow.enabled) {
      servers["workflow"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/workflow/workflow-mcp-server.js")],
        env: {
          AGENT_ID: this.agentConfig.id,
          MONGODB_URI: config.mongo.uri,
          MONGODB_DB: config.mongo.dbName,
          EVENT_SUBSCRIBERS: this.eventSubscribersJson,
        },
      };
    }

    // Schedule MCP server — self-service schedule management for each agent
    servers["schedule"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/schedule/schedule-mcp-server.js")],
      env: {
        AGENT_ID: this.agentConfig.id,
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
      },
    };

    // Admin MCP server — model management, system controls
    servers["admin"] = {
      type: "stdio",
      command: "node",
      args: [resolve("dist/admin/admin-mcp-server.js")],
      env: {
        MONGODB_URI: config.mongo.uri,
        MONGODB_DB: config.mongo.dbName,
        AGENT_ID: this.agentConfig.id,
      },
    };

    return servers;
  }

  /**
   * Build MCP servers for the parent agent session — core servers only, with filtering.
   */
  private filterCoreServers(allConfigs: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
    const servers = { ...allConfigs };

    // Guardrail: filter to agent's allowed core servers for the parent session
    // Always filter — empty coreServers means zero servers, not all servers
    const coreSet = new Set(this.agentConfig.coreServers);
    // structured-memory is always paired with memory — if agent has memory, it gets both
    if (coreSet.has("memory")) {
      coreSet.add("structured-memory");
    }
    // schedule is an implicit core server — available to all agents unconditionally
    coreSet.add("schedule");
    // team is an implicit core server when team layer is enabled
    if (config.team.enabled) {
      coreSet.add("team");
    }
    // workflow is an implicit core server when workflow layer is enabled
    if (config.workflow.enabled) {
      coreSet.add("workflow");
    }
    for (const key of Object.keys(servers)) {
      if (!coreSet.has(key)) {
        delete servers[key];
      }
    }

    // Autonomy gates — strip servers based on per-agent resolved flags
    if (!this.agentConfig.autonomy.externalComms) {
      for (const key of ["resend", "quo"]) {
        if (servers[key]) {
          log.debug("Autonomy: externalComms disabled — removing server", { server: key, agent: this.agentConfig.id });
          delete servers[key];
        }
      }
    }
    if (!this.agentConfig.autonomy.codeTask) {
      if (servers["code-task"]) {
        log.debug("Autonomy: codeTask disabled — removing server", { server: "code-task", agent: this.agentConfig.id });
        delete servers["code-task"];
      }
    }
    if (!this.agentConfig.autonomy.codeAccess) {
      if (servers["code-search"]) {
        log.debug("Autonomy: codeAccess disabled — removing server", { server: "code-search", agent: this.agentConfig.id });
        delete servers["code-search"];
      }
    }

    return servers;
  }

  // Infrastructure servers excluded from "Your tools" prompt section — always present, self-explanatory
  private static readonly INFRASTRUCTURE_SERVERS = new Set([
    "schedule", "structured-memory", "team",
  ]);

  // Context-dependent servers that must NOT be delegated (they embed channel/thread env vars)
  private static CONTEXT_DEPENDENT_SERVERS = new Set([
    "callback", "background", "code-task", "recall", "structured-memory", "memory",
  ]);

  /**
   * Build AgentDefinition objects for delegate servers.
   * Each delegate server becomes a named subagent with its own MCP connection.
   */
  private buildDelegateAgents(allConfigs: Record<string, McpServerConfig>): Record<string, AgentDefinition> {
    const delegates = this.agentConfig.delegateServers;
    if (delegates.length === 0) return {};

    const agents: Record<string, AgentDefinition> = {};

    // Autonomy gates for delegate servers — same rules as core servers
    const blockedDelegates = new Set<string>();
    if (!this.agentConfig.autonomy.externalComms) {
      blockedDelegates.add("resend");
      blockedDelegates.add("quo");
    }
    if (!this.agentConfig.autonomy.codeTask) {
      blockedDelegates.add("code-task");
    }
    if (!this.agentConfig.autonomy.codeAccess) {
      blockedDelegates.add("code-search");
    }

    for (const serverName of delegates) {
      if (blockedDelegates.has(serverName)) {
        log.debug("Autonomy gate — skipping delegate server", { server: serverName, agent: this.agentConfig.id });
        continue;
      }

      // Warn if a context-dependent server is being delegated
      if (AgentRunner.CONTEXT_DEPENDENT_SERVERS.has(serverName)) {
        log.warn("Context-dependent server in delegateServers — subagent won't have channel context", {
          agent: this.agentConfig.id,
          server: serverName,
        });
      }

      const serverConfig = allConfigs[serverName];
      if (!serverConfig) {
        log.warn("Delegate server not found in configs, skipping", {
          agent: this.agentConfig.id,
          server: serverName,
        });
        continue;
      }

      // Get description from server catalog or plugin manifest
      const description = this.getServerCatalogEntry(serverName).description;

      // Use custom delegate prompt if available, otherwise generic
      const customPrompt = this.agentConfig.delegatePrompts?.[serverName];
      const prompt = customPrompt
        || `You are a tool specialist for ${serverName}. Execute the requested task using your available tools. Return results concisely. Do not add commentary or explanation beyond what was asked.`;

      agents[serverName] = {
        description,
        prompt,
        mcpServers: [{ [serverName]: serverConfig }], // Record form — NOT string reference
        model: "inherit",
        maxTurns: customPrompt ? 7 : 10, // Intent-aware delegates need fewer turns
        disallowedTools: ["Agent"], // subagents cannot spawn sub-subagents
      };

      if (customPrompt) {
        log.info("Intent-aware delegate prompt loaded", {
          agent: this.agentConfig.id,
          server: serverName,
          promptLength: customPrompt.length,
        });
      }
    }

    return agents;
  }

  /**
   * Get catalog metadata for a server name.
   * Checks core server catalog first, then plugin manifests.
   */
  private getServerCatalogEntry(serverName: string): ServerCatalogEntry {
    // Check core server catalog
    if (SERVER_CATALOG[serverName]) {
      return SERVER_CATALOG[serverName];
    }
    // Check plugin manifests
    for (const plugin of this.plugins) {
      const serverDef = plugin.manifest.mcpServers[serverName];
      if (serverDef?.description) {
        return {
          description: serverDef.description,
          usage: serverDef.usage,
          notFor: serverDef.notFor,
        };
      }
    }
    return { description: serverName };
  }

  private buildSdkPlugins(): SdkPluginConfig[] {
    const pluginNames = this.agentConfig.plugins;
    if (!pluginNames?.length) return [];

    const sdkPlugins: SdkPluginConfig[] = [];
    const pluginsDir = resolve("plugins/claude-code");

    for (const name of pluginNames) {
      if (name.includes("/") || name.includes("\\") || name === ".." || name.startsWith(".")) {
        log.warn("Invalid plugin name, skipping", { plugin: name, agent: this.agentConfig.id });
        continue;
      }
      const pluginPath = resolve(pluginsDir, name);
      if (!existsSync(pluginPath)) {
        log.warn("Plugin not found, skipping", { plugin: name, expected: pluginPath, agent: this.agentConfig.id });
        continue;
      }
      sdkPlugins.push({ type: "local", path: pluginPath });
    }

    if (sdkPlugins.length > 0) {
      log.debug("Loaded plugins for agent", {
        agent: this.agentConfig.id,
        plugins: sdkPlugins.map((p) => p.path),
      });
    }

    return sdkPlugins;
  }

  private buildNativeSkills(): SdkPluginConfig[] {
    return getSkillsForAgent(this.skillIndex, this.agentConfig.id);
  }

  private buildPreCompactHook(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const agentName = this.agentConfig.name;
    const agentId = this.agentConfig.id;
    const prefetcher = this.prefetcher;

    return {
      PreCompact: [{
        hooks: [async (input: HookInput, _toolUseId, _opts) => {
          log.info("PreCompact hook fired", { agent: agentId });

          const baseInstructions = [
            `You are ${agentName} (agent ID: ${agentId}). When summarizing this conversation for compaction:`,
            "- Preserve your identity, role, and any behavioral instructions from your system prompt",
            "- Keep all customer/contact names, deal details, and reference numbers",
            "- Retain every decision made and commitment given — who decided what, and why",
            "- Preserve active workflows: what's in progress, what's pending, next steps",
            "- Keep tool call results that informed decisions (not raw API responses)",
            "- Discard pleasantries, thinking-out-loud, and intermediate failed attempts",
          ].join("\n");

          // Attempt to inject code context (graceful — never blocks compaction)
          let codeContext = "";
          if (prefetcher && input?.transcript_path) {
            try {
              const raw = await readFile(input.transcript_path, "utf-8");
              if (raw.length > 0) {
                // Cap input — this hook fires on large sessions; Layer 1 regex scans the full string
                const MAX_TRANSCRIPT_BYTES = 200_000;
                const transcript = raw.length > MAX_TRANSCRIPT_BYTES ? raw.slice(-MAX_TRANSCRIPT_BYTES) : raw;
                codeContext = await prefetcher.getCompactionContext(transcript, agentId);
              }
            } catch (err) {
              log.warn("Code context extraction failed during compaction — proceeding without", {
                agent: agentId,
                error: String(err),
              });
            }
          }

          const systemMessage = codeContext
            ? `${baseInstructions}\n\n${codeContext}`
            : baseInstructions;

          return { continue: true, systemMessage };
        }],
      }],
    };
  }

  async send(prompt: string, sessionId?: string, onStream?: StreamCallback, context?: WorkItemContext, modelOverride?: string, resourceLimits?: ResourceLimits): Promise<RunResult> {
    const effectiveModel = modelOverride ?? this.agentConfig.model;

    log.info("Sending prompt to agent", {
      agent: this.agentConfig.id,
      model: effectiveModel,
      modelOverride: modelOverride ? true : false,
      resumeSession: sessionId ?? "new",
      promptLength: prompt.length,
      streaming: !!onStream,
    });

    const allServerConfigs = this.buildAllServerConfigs(context);
    const mcpServers = this.filterCoreServers(allServerConfigs);
    const delegateAgents = this.buildDelegateAgents(allServerConfigs);
    const systemPrompt = await this.buildSystemPrompt(Object.keys(mcpServers), Object.keys(delegateAgents));
    const sdkPlugins = [...this.buildSdkPlugins(), ...this.buildNativeSkills()];

    if (Object.keys(delegateAgents).length > 0) {
      log.info("Delegate subagents configured", {
        agent: this.agentConfig.id,
        delegates: Object.keys(delegateAgents),
      });
    }

    const q = query({
      prompt,
      options: {
        model: effectiveModel,
        systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,

        maxTurns: resourceLimits?.maxTurns ?? this.agentConfig.maxTurns,
        maxBudgetUsd: resourceLimits?.budgetUsd ?? this.agentConfig.budgetUsd,
        thinking: { type: "disabled" },
        includePartialMessages: !!onStream,
        ...(sessionId ? { resume: sessionId } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(Object.keys(delegateAgents).length > 0 ? { agents: delegateAgents } : {}),
        ...(sdkPlugins.length > 0 ? { plugins: sdkPlugins } : {}),
        hooks: this.buildPreCompactHook(),
        // Cast: AgentConfig stores string[] but SDK expects SdkBeta[] — intentional for forward compat
        ...(this.agentConfig.betas?.length ? { betas: this.agentConfig.betas as any } : {}),
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
    this._aborted = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let contextWindow = 0;
    let compactions = 0;
    let preCompactTokens: number | undefined;

    // Instrumentation
    const toolCalls: { tool: string; startMs: number; endMs?: number }[] = [];
    let activeToolStart: number | null = null;
    let activeToolName: string | null = null;

    const timeoutMs = resourceLimits?.timeoutMs ?? this.agentConfig.timeoutMs ?? 300_000; // 5 min default
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

        // Track compaction events
        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          const meta = (msg as any).compact_metadata;
          compactions++;
          preCompactTokens = meta?.pre_tokens;
          log.info("Context compacted", {
            agent: this.agentConfig.id,
            trigger: meta?.trigger,
            preTokens: meta?.pre_tokens,
            compactionNumber: compactions,
          });
        }

        // Log compaction status changes
        if (msg.type === "system" && msg.subtype === "status") {
          const status = (msg as any).status;
          if (status === "compacting") {
            log.info("Compaction in progress", { agent: this.agentConfig.id });
          }
        }

        // Stream text chunks in real-time
        if (msg.type === "stream_event" && onStream) {
          const event = (msg as any).event;
          if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
            onStream(event.delta.text);
            streamed = true;
          }
        }

        // Log tool call timing
        if (msg.type === "tool_progress") {
          const tp = msg as any;
          log.info("Tool in progress", {
            agent: this.agentConfig.id,
            tool: tp.tool_name,
            elapsed: tp.elapsed_time_seconds,
          });
        }

        if (msg.type === "assistant") {
          const content = (msg as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                resultText = block.text;
              } else if (block.type === "tool_use") {
                // Close previous tool timing if any
                if (activeToolName && toolCalls.length > 0) {
                  toolCalls[toolCalls.length - 1]!.endMs = Date.now();
                }
                activeToolName = block.name;
                activeToolStart = Date.now();
                toolCalls.push({ tool: block.name, startMs: activeToolStart });
                log.info("Tool call started", {
                  agent: this.agentConfig.id,
                  tool: block.name,
                });
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

          // Extract token usage from SDK result
          const usage = (result as any).usage;
          if (usage) {
            inputTokens = usage.input_tokens ?? 0;
            outputTokens = usage.output_tokens ?? 0;
            cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
          }

          // Extract context window from model usage
          const modelUsage = (result as any).modelUsage as Record<string, { contextWindow?: number }> | undefined;
          if (modelUsage) {
            for (const mu of Object.values(modelUsage)) {
              if (mu.contextWindow && mu.contextWindow > contextWindow) {
                contextWindow = mu.contextWindow;
              }
            }
          }

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
      const errStr = String(err);
      // If the agent produced a valid response but crashed during cleanup (e.g. MCP server exit),
      // treat it as a warning — don't discard the response
      if (resultText && costUsd > 0) {
        log.warn("Agent process crashed after producing response — using response anyway", {
          agent: this.agentConfig.id,
          error: errStr,
          resultPreview: resultText.slice(0, 200),
          costUsd,
          durationMs,
        });
      } else {
        error = errStr;
        log.error("Agent query failed", {
          agent: this.agentConfig.id,
          error: errStr,
          costUsd,
          durationMs,
        });
      }
    } finally {
      clearTimeout(deadline);
      this.activeQuery = null;
    }

    // Close last tool timing
    if (activeToolName && toolCalls.length > 0) {
      toolCalls[toolCalls.length - 1]!.endMs = Date.now();
    }

    // Build tool stats
    const toolStats: Record<string, { count: number; totalMs: number }> = {};
    for (const tc of toolCalls) {
      const dur = (tc.endMs ?? Date.now()) - tc.startMs;
      const serverName = tc.tool.includes("__") ? tc.tool.split("__")[1]! : tc.tool;
      if (!toolStats[serverName]) toolStats[serverName] = { count: 0, totalMs: 0 };
      toolStats[serverName]!.count++;
      toolStats[serverName]!.totalMs += dur;
    }

    const toolSummary = Object.entries(toolStats)
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .map(([name, s]) => `${name}:${s.count}x/${(s.totalMs / 1000).toFixed(1)}s`)
      .join(", ");

    const totalToolMs = toolCalls.reduce((sum, tc) => sum + ((tc.endMs ?? Date.now()) - tc.startMs), 0);
    const llmMs = durationMs - totalToolMs;

    log.info("Agent response complete", {
      agent: this.agentConfig.id,
      sessionId: resultSessionId,
      costUsd,
      durationMs,
      llmMs,
      toolMs: totalToolMs,
      toolCalls: toolCalls.length,
      toolSummary: toolSummary || "none",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      contextWindow,
      compactions,
      preCompactTokens,
      streamed,
      hasError: !!error,
    });

    return {
      text: resultText, sessionId: resultSessionId, costUsd, durationMs,
      llmMs, toolMs: totalToolMs, toolCalls: toolCalls.length,
      toolSummary: toolSummary || "none", streamed,
      inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
      contextWindow, compactions, preCompactTokens,
      error, aborted: this._aborted,
    };
  }

  private _aborted = false;

  get wasAborted(): boolean {
    return this._aborted;
  }

  abort(): void {
    if (this.activeQuery) {
      log.info("Aborting active query", { agent: this.agentConfig.id });
      this._aborted = true;
      this.activeQuery.close();
      this.activeQuery = null;
    }
  }
}
