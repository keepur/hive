import { createLogger } from "../logging/logger.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { WorkItem, WorkResult, ChannelKind } from "../types/work-item.js";
import type { SlackGateway } from "../slack/slack-gateway.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { AgentManager, TurnContext } from "../agents/agent-manager.js";
import { resolveAgentForSlackWorkItem } from "./slack-agent-resolver.js";
import { formatError, formatResponse } from "../slack/response-formatter.js";
import type { WebClient } from "@slack/web-api";
import type { SweepResult } from "../sweeper/sweeper.js";

const log = createLogger("slack-adapter");

/**
 * KPR-217: optional per-turn-spawn wiring. When `perTurn` is provided AND
 * `perTurnSpawnEnabled` is true, inbound Slack messages skip the dispatcher
 * and route directly through `agentManager.spawnTurn(...)`. Otherwise the
 * adapter falls back to the legacy `onWorkItem` → dispatcher path.
 *
 * Bypasses dispatcher dedup/audit/retry/model-router/taskLedger and
 * dispatcher's full multi-agent + conference resolution. Agent routing under
 * the per-turn path uses {@link resolveAgentForSlackWorkItem} (single-agent
 * only). Flag stays OFF in production until KPR-223 decides whether
 * per-turn paths route through the dispatcher.
 */
export interface SlackAdapterPerTurnDeps {
  agentManager: AgentManager;
  perTurnSpawnEnabled: boolean;
}

const DEFAULT_PROMPTS = [
  { title: "Daily briefing", message: "What's on my plate today?" },
  { title: "Open tasks", message: "Show me all open tasks from Linear" },
  { title: "System status", message: "How's everyone doing?" },
  { title: "Quick note", message: "I need to remember something..." },
];

export interface ThreadMessage {
  author: string;
  text: string;
  timestamp: Date;
  isBot: boolean;
}

export class SlackAdapter implements ChannelAdapter {
  readonly id: string;
  readonly kind: ChannelKind = "slack";

  private gateway: SlackGateway;
  private registry: AgentRegistry;
  private excludeChannels: Set<string>;
  private defaultAgentId?: string;
  private botLabel?: string;
  private perTurn?: SlackAdapterPerTurnDeps;
  private threadContextMap = new Map<string, string>();
  private threadContextLastSeen = new Map<string, number>();

  constructor(
    gateway: SlackGateway,
    registry: AgentRegistry,
    excludeChannels: string[] = [],
    id: string = "slack",
    defaultAgentId?: string,
    botLabel?: string,
    perTurn?: SlackAdapterPerTurnDeps,
  ) {
    this.id = id;
    this.gateway = gateway;
    this.registry = registry;
    this.excludeChannels = new Set(excludeChannels);
    this.defaultAgentId = defaultAgentId;
    this.botLabel = botLabel;
    this.perTurn = perTurn;
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    // Register integration channels — agents assigned to this bot, or any bot (no slackBot set)
    const allAgentChannels = this.registry
      .getAll()
      .filter((a) => !a.slackBot || a.slackBot === this.botLabel)
      .flatMap((a) => a.channels)
      .filter((ch) => !this.excludeChannels.has(ch));
    this.gateway.addIntegrationChannels(allAgentChannels);

    // Convert incoming Slack messages to WorkItems
    this.gateway.onMessage(async (msg) => {
      // Skip channels handled by other adapters (e.g. SMS channels)
      if (this.excludeChannels.has(msg.channelName)) {
        log.debug("Ignoring message from excluded channel", { channel: msg.channelName });
        return;
      }

      // Skip channels owned by an agent explicitly bound to a different bot
      // Agents with no slackBot are accessible from any adapter
      const owningAgent = this.registry.findByChannel(msg.channelName);
      if (owningAgent && owningAgent.slackBot && owningAgent.slackBot !== this.botLabel) {
        log.debug("Ignoring message from other bot's channel", {
          channel: msg.channelName,
          owner: owningAgent.id,
          botLabel: this.botLabel,
        });
        return;
      }

      // Resolve sender display name for human users
      const senderName = msg.user.startsWith("U") ? await this.gateway.resolveUserName(msg.user) : undefined;

      const workItem: WorkItem = {
        id: msg.ts,
        text: msg.text,
        source: { kind: "slack", id: msg.channel, label: msg.channelName, adapterId: this.id },
        sender: msg.user,
        senderName,
        // Always use consistent threadId: slack:channelId:threadTs|ts
        // For parent messages, ts becomes the thread_ts for future replies
        threadId: `slack:${msg.channel}:${msg.threadTs ?? msg.ts}`,
        timestamp: new Date(),
        meta: { slackTs: msg.ts, slackThreadTs: msg.threadTs, defaultAgentId: this.defaultAgentId },
        files: msg.files,
      };

      // KPR-217: per-turn-spawn branch. When the operator flag is on, route
      // directly through AgentManager.spawnTurn (bypassing the dispatcher).
      // Fire-and-forget — the gateway's onMessage handler doesn't await.
      if (this.perTurn?.perTurnSpawnEnabled) {
        this.spawnTurnForWorkItem(workItem).catch((err) => {
          log.error("Slack per-turn spawn failed", {
            error: String(err),
            channel: workItem.source.label,
            threadId: workItem.threadId,
          });
        });
      } else {
        onWorkItem(workItem);
      }
    });

    // Handle assistant thread started (AI Apps split view)
    this.gateway.onThreadStarted(async (event) => {
      log.info("Setting up new assistant thread", { channel: event.channel });

      await this.gateway.setThreadStatus(event.channel, event.threadTs, "Getting ready...");
      await this.gateway.setSuggestedPrompts(event.channel, event.threadTs, DEFAULT_PROMPTS);
      await this.gateway.setThreadStatus(event.channel, event.threadTs, "");

      if (event.context.channelId) {
        this.threadContextMap.set(event.threadTs, event.context.channelId);
        this.threadContextLastSeen.set(event.threadTs, Date.now());
      }
    });

    // Handle assistant thread context changed
    this.gateway.onThreadContextChanged(async (event) => {
      if (event.context.channelId) {
        this.threadContextMap.set(event.threadTs, event.context.channelId);
        this.threadContextLastSeen.set(event.threadTs, Date.now());
        log.info("Thread context updated", { threadTs: event.threadTs, channelId: event.context.channelId });
      }
    });

    await this.gateway.start();
    log.info("Slack adapter started");
  }

  async deliver(result: WorkResult): Promise<void> {
    const channel = result.workItem.source.id;
    const threadTs = (result.workItem.meta?.slackThreadTs as string) ?? (result.workItem.meta?.slackTs as string);

    // Look up agent config for signature
    const agentConfig = this.registry.get(result.agentId);

    // For integration/bot messages, don't thread the reply
    const isIntegrationMsg = result.workItem.sender?.startsWith("B") || result.workItem.sender === "integration";
    const replyThread = isIntegrationMsg ? undefined : threadTs;

    // Format text with agent signature
    let text = result.error ? formatError(result.error) : formatResponse(result.text);
    if (agentConfig) {
      const avatar = agentConfig.icon ? `${agentConfig.icon} ` : "";
      text = `${avatar}*${agentConfig.name}*: ${text}`;
    }

    const identity = agentConfig ? { name: agentConfig.name, icon: agentConfig.icon } : undefined;
    await this.gateway.postMessage(channel, text, replyThread, identity);
  }

  async onProcessingStart(item: WorkItem, _agentId: string): Promise<void> {
    const isIntegrationMsg = item.sender?.startsWith("B") || item.sender === "integration";
    const threadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string);

    if (!isIntegrationMsg && threadTs) {
      await this.gateway.setThreadStatus(item.source.id, threadTs, "Thinking...");
    }
  }

  async onProcessingEnd(item: WorkItem, _agentId: string): Promise<void> {
    const isIntegrationMsg = item.sender?.startsWith("B") || item.sender === "integration";
    const threadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string);

    if (!isIntegrationMsg && threadTs) {
      await this.gateway.setThreadStatus(item.source.id, threadTs, "");
    }
  }

  sweep(threadTtlMs: number): SweepResult {
    const cutoff = Date.now() - threadTtlMs;
    let pruned = 0;
    for (const [id, ts] of this.threadContextLastSeen) {
      if (ts < cutoff) {
        this.threadContextMap.delete(id);
        this.threadContextLastSeen.delete(id);
        pruned++;
      }
    }
    return { component: `slack-adapter:${this.id}`, pruned, retried: 0, bytesFreed: 0, errors: [] };
  }

  async stop(): Promise<void> {
    await this.gateway.stop();
    log.info("Slack adapter stopped");
  }

  /**
   * KPR-217: per-turn-spawn path. Resolves agent (thread continuity →
   * channel binding → defaultAgentId), pulls existing session id, sets the
   * "Thinking..." status, spawns one turn, clears the status in finally,
   * delivers via gateway.postMessage.
   *
   * Bypasses dispatcher dedup/audit/retry/model-router/taskLedger and
   * dispatcher's full multi-agent + conference resolution by design for
   * Phase A — same caveat as SMS (KPR-216). Flag stays OFF in production
   * until KPR-223 decides whether per-turn paths should route through the
   * dispatcher.
   *
   * Note: `gateway.setThreadStatus` swallows its own errors (see
   * SlackGateway), so the status calls are not wrapped here. If status
   * setting fails the spawn still proceeds and a stale "Thinking..."
   * indicator is the only user-visible degradation.
   */
  private async spawnTurnForWorkItem(workItem: WorkItem): Promise<void> {
    if (!this.perTurn) return;
    const { agentManager } = this.perTurn;

    const agentId = await resolveAgentForSlackWorkItem(workItem, this.registry, agentManager, this.defaultAgentId);
    if (!agentId) {
      log.info("Slack per-turn: no agent resolved — dropping", {
        channel: workItem.source.label,
        threadId: workItem.threadId,
      });
      return;
    }

    const threadId = workItem.threadId ?? workItem.id;
    const sessionId = await agentManager.getSessionStore().get(agentId, threadId);

    const ctx: TurnContext = {
      agentId,
      sessionId,
      channelId: workItem.source.id,
      threadId,
      workItem,
      channel: "slack",
    };

    const slackTs = (workItem.meta?.slackThreadTs as string) ?? (workItem.meta?.slackTs as string);
    const isIntegrationMsg = workItem.sender?.startsWith("B") || workItem.sender === "integration";
    const showStatus = !isIntegrationMsg && !!slackTs;

    if (showStatus) {
      await this.gateway.setThreadStatus(workItem.source.id, slackTs, "Thinking...");
    }

    try {
      const turn = await agentManager.spawnTurn(ctx);

      if (turn.errors.length > 0) {
        log.warn("Slack per-turn spawn returned errors", {
          agentId,
          threadId,
          errors: turn.errors,
        });
      }

      const text = turn.finalMessage?.trim();
      if (!text) {
        log.info("Slack per-turn spawn produced no text — skipping delivery", {
          agentId,
          threadId,
        });
        return;
      }

      const workResult: WorkResult = {
        text,
        agentId,
        workItem,
        costUsd: turn.usage.costUsd,
        durationMs: turn.usage.durationMs,
        error: turn.errors[0],
      };
      await this.deliver(workResult);
    } finally {
      if (showStatus) {
        await this.gateway.setThreadStatus(workItem.source.id, slackTs, "");
      }
    }
  }

  /** Expose the Slack WebClient for external use (e.g. audit channel resolution) */
  get client(): WebClient {
    return this.gateway.client;
  }

  /**
   * Fetch thread replies for context injection into conference channel agents.
   * Returns messages formatted with author names and timestamps.
   */
  async fetchThreadHistory(channelId: string, threadTs: string): Promise<ThreadMessage[]> {
    try {
      const result = await this.gateway.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
      });

      const messages: ThreadMessage[] = [];
      const userNameCache = new Map<string, string>(); // userId → display name
      for (const msg of result.messages ?? []) {
        if (!msg.text && !msg.blocks) continue;

        let author = "Unknown";
        let isBot = false;

        const raw = msg as unknown as Record<string, unknown>;
        if (msg.bot_id || raw["subtype"] === "bot_message") {
          // Bot message — try to extract agent name from formatted response
          // Agent responses are formatted as "icon *Name*: text"
          const nameMatch = msg.text?.match(/^\S+\s\*([^*]+)\*:/);
          author = nameMatch ? nameMatch[1] : ((raw["username"] as string | undefined) ?? "Agent");
          isBot = true;
        } else if (msg.user) {
          // Human message — resolve display name (cached per invocation)
          const cached = userNameCache.get(msg.user);
          if (cached) {
            author = cached;
          } else {
            try {
              const userInfo = await this.gateway.client.users.info({
                user: msg.user,
              });
              author = userInfo.user?.real_name ?? userInfo.user?.name ?? msg.user;
            } catch {
              author = msg.user;
            }
            userNameCache.set(msg.user, author);
          }
        }

        messages.push({
          author,
          text: msg.text ?? "",
          timestamp: new Date(parseFloat(msg.ts ?? "0") * 1000),
          isBot,
        });
      }

      return messages;
    } catch (err) {
      log.warn("Failed to fetch thread history", {
        channelId,
        threadTs,
        error: String(err),
      });
      return [];
    }
  }
}
