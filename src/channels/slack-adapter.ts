import { createLogger } from "../logging/logger.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { WorkItem, WorkResult, ChannelKind } from "../types/work-item.js";
import type { SlackGateway } from "../slack/slack-gateway.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import { formatError } from "../slack/response-formatter.js";
import type { WebClient } from "@slack/web-api";
import type { SweepResult } from "../sweeper/sweeper.js";

const log = createLogger("slack-adapter");

const DEFAULT_PROMPTS = [
  { title: "Daily briefing", message: "What's on my plate today?" },
  { title: "Open tasks", message: "Show me all open tasks from Linear" },
  { title: "System status", message: "How's everyone doing?" },
  { title: "Quick note", message: "I need to remember something..." },
];

export class SlackAdapter implements ChannelAdapter {
  readonly id: string;
  readonly kind: ChannelKind = "slack";

  private gateway: SlackGateway;
  private registry: AgentRegistry;
  private excludeChannels: Set<string>;
  private defaultAgentId?: string;
  private botLabel?: string;
  private threadContextMap = new Map<string, string>();
  private threadContextLastSeen = new Map<string, number>();

  constructor(gateway: SlackGateway, registry: AgentRegistry, excludeChannels: string[] = [], id: string = "slack", defaultAgentId?: string, botLabel?: string) {
    this.id = id;
    this.gateway = gateway;
    this.registry = registry;
    this.excludeChannels = new Set(excludeChannels);
    this.defaultAgentId = defaultAgentId;
    this.botLabel = botLabel;
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    // Register integration channels — only for agents assigned to this bot
    const allAgentChannels = this.registry.getAll()
      .filter((a) => (a.slackBot ?? undefined) === this.botLabel)
      .flatMap((a) => a.channels)
      .filter((ch) => !this.excludeChannels.has(ch));
    this.gateway.addIntegrationChannels(allAgentChannels);

    // Convert incoming Slack messages to WorkItems
    this.gateway.onMessage((msg) => {
      // Skip channels handled by other adapters (e.g. SMS channels)
      if (this.excludeChannels.has(msg.channelName)) {
        log.debug("Ignoring message from excluded channel", { channel: msg.channelName });
        return;
      }

      // Skip channels owned by another bot's agent
      const owningAgent = this.registry.findByChannel(msg.channelName);
      if (owningAgent && (owningAgent.slackBot ?? undefined) !== this.botLabel) {
        log.debug("Ignoring message from other bot's channel", { channel: msg.channelName, owner: owningAgent.id, botLabel: this.botLabel });
        return;
      }

      const workItem: WorkItem = {
        id: msg.ts,
        text: msg.text,
        source: { kind: "slack", id: msg.channel, label: msg.channelName, adapterId: this.id },
        sender: msg.user,
        // Always use consistent threadId: slack:channelId:threadTs|ts
        // For parent messages, ts becomes the thread_ts for future replies
        threadId: `slack:${msg.channel}:${msg.threadTs ?? msg.ts}`,
        timestamp: new Date(),
        meta: { slackTs: msg.ts, slackThreadTs: msg.threadTs, defaultAgentId: this.defaultAgentId },
      };

      onWorkItem(workItem);
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
    const threadTs = (result.workItem.meta?.slackThreadTs as string) ??
      (result.workItem.meta?.slackTs as string);

    // Look up agent config for bot identity
    const agentConfig = this.registry.get(result.agentId);
    const identity = agentConfig
      ? { name: agentConfig.name, icon: agentConfig.icon || undefined }
      : undefined;

    // For integration/bot messages, don't thread the reply
    const isIntegrationMsg =
      result.workItem.sender?.startsWith("B") ||
      result.workItem.sender === "integration";
    const replyThread = isIntegrationMsg ? undefined : threadTs;

    // Format text
    const text = result.error ? formatError(result.error) : result.text;

    await this.gateway.postMessage(channel, text, replyThread, identity);
  }

  async onProcessingStart(item: WorkItem): Promise<void> {
    const isIntegrationMsg =
      item.sender?.startsWith("B") || item.sender === "integration";
    const threadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string);

    if (!isIntegrationMsg && threadTs) {
      await this.gateway.setThreadStatus(item.source.id, threadTs, "Thinking...");
    }
  }

  async onProcessingEnd(item: WorkItem): Promise<void> {
    const isIntegrationMsg =
      item.sender?.startsWith("B") || item.sender === "integration";
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

  /** Expose the Slack WebClient for external use (e.g. audit channel resolution) */
  get client(): WebClient {
    return this.gateway.client;
  }
}
