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

    log.info("Routing message", { agentId, channel: msg.channel, user: msg.user });

    const threadKey = msg.threadTs ?? msg.ts;
    threadAgentMap.set(threadKey, agentId);

    // Show loading status in assistant thread
    await slack.setThreadStatus(msg.channel, threadKey, "Thinking...");

    // Try streaming first, fall back to standard postMessage
    const stream = await slack.startStream(msg.channel, threadKey);

    try {
      const result = await this.agentManager.sendMessage(agentId, msg, (chunk: string) => {
        if (stream) {
          slack.appendStream(stream.channel, stream.ts, chunk);
        }
      });

      if (stream) {
        if (result.text && !result.streamed) {
          await slack.appendStream(stream.channel, stream.ts, result.text);
        }
        await slack.stopStream(stream.channel, stream.ts);
      } else {
        // Fallback: non-streaming post
        if (result.error) {
          await slack.postMessage(msg.channel, formatError(result.error), threadKey);
        } else {
          await slack.postMessage(msg.channel, result.text || "_No response._", threadKey);
        }
      }

      // Clear status
      await slack.setThreadStatus(msg.channel, threadKey, "");

      if (result.error) {
        log.error("Agent returned error", { agentId, error: result.error });
      }
    } catch (err) {
      if (stream) {
        await slack.appendStream(stream.channel, stream.ts, formatError(String(err)));
        await slack.stopStream(stream.channel, stream.ts);
      } else {
        await slack.postMessage(msg.channel, formatError(String(err)), threadKey);
      }
      await slack.setThreadStatus(msg.channel, threadKey, "");
      log.error("Failed to process message", { agentId, error: String(err) });
    }
  }

  private resolveAgent(msg: IncomingMessage): string | null {
    // 1. Thread continuity
    if (msg.threadTs) {
      const threadAgent = threadAgentMap.get(msg.threadTs);
      if (threadAgent) return threadAgent;
    }

    // 2. Channel mapping
    const channelAgent = this.registry.findByChannel(msg.channel);
    if (channelAgent) return channelAgent.id;

    // 3. Keyword match
    const keywordAgent = this.registry.findByKeyword(msg.text);
    if (keywordAgent) return keywordAgent.id;

    // 4. Default agent
    return this.defaultAgentId;
  }
}
