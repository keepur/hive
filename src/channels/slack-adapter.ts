import { createLogger } from "../logging/logger.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { WorkItem, WorkResult, ChannelKind } from "../types/work-item.js";
import type { SlackGateway } from "../slack/slack-gateway.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import { formatError } from "../slack/response-formatter.js";
import type { WebClient } from "@slack/web-api";

const log = createLogger("slack-adapter");

// Track channel context per thread (from assistant_thread_context_changed)
const threadContextMap = new Map<string, string>();

const DEFAULT_PROMPTS = [
  { title: "Daily briefing", message: "What's on my plate today?" },
  { title: "Open tasks", message: "Show me all open tasks from Linear" },
  { title: "System status", message: "How's everyone doing?" },
  { title: "Quick note", message: "I need to remember something..." },
];

export class SlackAdapter implements ChannelAdapter {
  readonly kind: ChannelKind = "slack";

  private gateway: SlackGateway;
  private registry: AgentRegistry;

  constructor(gateway: SlackGateway, registry: AgentRegistry) {
    this.gateway = gateway;
    this.registry = registry;
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    // Register integration channels from registry
    const allAgentChannels = this.registry.getAll().flatMap((a) => a.channels);
    this.gateway.addIntegrationChannels(allAgentChannels);

    // Convert incoming Slack messages to WorkItems
    this.gateway.onMessage((msg) => {
      const workItem: WorkItem = {
        id: msg.ts,
        text: msg.text,
        source: { kind: "slack", id: msg.channel, label: msg.channelName },
        sender: msg.user,
        threadId: msg.threadTs ? `slack:${msg.channel}:${msg.threadTs}` : undefined,
        timestamp: new Date(),
        meta: { slackTs: msg.ts, slackThreadTs: msg.threadTs },
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
        threadContextMap.set(event.threadTs, event.context.channelId);
      }
    });

    // Handle assistant thread context changed
    this.gateway.onThreadContextChanged(async (event) => {
      if (event.context.channelId) {
        threadContextMap.set(event.threadTs, event.context.channelId);
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

  async stop(): Promise<void> {
    await this.gateway.stop();
    log.info("Slack adapter stopped");
  }

  /** Expose the Slack WebClient for external use (e.g. audit channel resolution) */
  get client(): WebClient {
    return this.gateway.client;
  }
}
