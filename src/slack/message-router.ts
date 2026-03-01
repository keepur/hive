import { createLogger } from "../logging/logger.js";
import type { IncomingMessage } from "../types/agent-config.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { SlackGateway, ThreadStartedEvent, ThreadContextChangedEvent } from "./slack-gateway.js";
import { formatError } from "./response-formatter.js";

const log = createLogger("message-router");

// Track which threads belong to which agents
const threadAgentMap = new Map<string, string>();
// Track channel context per thread (from assistant_thread_context_changed)
const threadContextMap = new Map<string, string>();

const DEFAULT_PROMPTS = [
  { title: "Daily briefing", message: "What's on my plate today?" },
  { title: "Open tasks", message: "Show me all open tasks from Linear" },
  { title: "System status", message: "How's everyone doing?" },
  { title: "Quick note", message: "I need to remember something..." },
];

export class MessageRouter {
  private registry: AgentRegistry;
  private agentManager: AgentManager;
  private defaultAgentId: string;

  constructor(registry: AgentRegistry, agentManager: AgentManager, defaultAgentId: string) {
    this.registry = registry;
    this.agentManager = agentManager;
    this.defaultAgentId = defaultAgentId;
  }

  async handleThreadStarted(event: ThreadStartedEvent, slack: SlackGateway): Promise<void> {
    log.info("Setting up new assistant thread", { channel: event.channel });

    // Set loading state while we prepare
    await slack.setThreadStatus(event.channel, event.threadTs, "Getting ready...");

    // Show suggested prompts
    await slack.setSuggestedPrompts(event.channel, event.threadTs, DEFAULT_PROMPTS);

    // Clear loading state
    await slack.setThreadStatus(event.channel, event.threadTs, "");

    // Track thread → default agent
    threadAgentMap.set(event.threadTs, this.defaultAgentId);

    if (event.context.channelId) {
      threadContextMap.set(event.threadTs, event.context.channelId);
    }
  }

  async handleContextChanged(event: ThreadContextChangedEvent, _slack: SlackGateway): Promise<void> {
    if (event.context.channelId) {
      threadContextMap.set(event.threadTs, event.context.channelId);
      log.info("Thread context updated", { threadTs: event.threadTs, channelId: event.context.channelId });
    }
  }

  async route(msg: IncomingMessage, slack: SlackGateway): Promise<void> {
    const agentId = this.resolveAgent(msg);

    if (!agentId) {
      log.warn("No agent found for message", { channel: msg.channel, text: msg.text.slice(0, 50) });
      return;
    }

    const agentConfig = this.registry.get(agentId);
    const identity = agentConfig ? { name: agentConfig.name, icon: agentConfig.icon || undefined } : undefined;

    log.info("Routing message", { agentId, channel: msg.channel, user: msg.user });

    const threadKey = msg.threadTs ?? msg.ts;
    threadAgentMap.set(threadKey, agentId);

    // For integration messages (from bots), don't thread — post as new message
    // Slack won't let us reply to another bot's messages
    const isIntegrationMsg = msg.user?.startsWith("B") || msg.user === "integration";
    const replyThread = isIntegrationMsg ? undefined : threadKey;

    // Show thinking indicator (only for user threads)
    if (replyThread) {
      await slack.setThreadStatus(msg.channel, replyThread, "Thinking...");
    }

    try {
      const result = await this.agentManager.sendMessage(agentId, msg);

      if (result.error) {
        await slack.postMessage(msg.channel, formatError(result.error), replyThread, identity);
        log.error("Agent returned error", { agentId, error: result.error });
      } else {
        await slack.postMessage(msg.channel, result.text || "_No response._", replyThread, identity);
      }

      if (replyThread) {
        await slack.setThreadStatus(msg.channel, replyThread, "");
      }
    } catch (err) {
      await slack.postMessage(msg.channel, formatError(String(err)), replyThread, identity);
      if (replyThread) {
        await slack.setThreadStatus(msg.channel, replyThread, "");
      }
      log.error("Failed to process message", { agentId, error: String(err) });
    }
  }

  private resolveAgent(msg: IncomingMessage): string | null {
    // 1. Thread continuity
    if (msg.threadTs) {
      const threadAgent = threadAgentMap.get(msg.threadTs);
      if (threadAgent) return threadAgent;
    }

    // 2. Name addressing ("hey River", "@River", "River, ...")
    const namedAgent = this.registry.findByName(msg.text);
    if (namedAgent) return namedAgent.id;

    // 3. Channel mapping (by name, not ID)
    const channelAgent = this.registry.findByChannel(msg.channelName);
    if (channelAgent) return channelAgent.id;

    // 4. Keyword match
    const keywordAgent = this.registry.findByKeyword(msg.text);
    if (keywordAgent) return keywordAgent.id;

    // 5. Default agent
    return this.defaultAgentId;
  }
}
