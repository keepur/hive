import { createLogger } from "../logging/logger.js";
import type { IncomingMessage } from "../types/agent-config.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { SlackGateway } from "./slack-gateway.js";
import { formatResponse, formatError } from "./response-formatter.js";

const log = createLogger("message-router");

// Track which threads belong to which agents
const threadAgentMap = new Map<string, string>();

export class MessageRouter {
  private registry: AgentRegistry;
  private agentManager: AgentManager;
  private defaultAgentId: string;

  constructor(registry: AgentRegistry, agentManager: AgentManager, defaultAgentId: string) {
    this.registry = registry;
    this.agentManager = agentManager;
    this.defaultAgentId = defaultAgentId;
  }

  async route(msg: IncomingMessage, slack: SlackGateway): Promise<void> {
    const agentId = this.resolveAgent(msg);

    if (!agentId) {
      log.warn("No agent found for message", { channel: msg.channel, text: msg.text.slice(0, 50) });
      return;
    }

    log.info("Routing message", { agentId, channel: msg.channel, user: msg.user });

    // Add hourglass reaction to indicate processing
    await slack.addReaction(msg.channel, msg.ts, "hourglass_flowing_sand");

    // Track thread ownership
    const threadKey = msg.threadTs ?? msg.ts;
    threadAgentMap.set(threadKey, agentId);

    try {
      const result = await this.agentManager.sendMessage(agentId, msg);

      // Remove hourglass, add checkmark
      await slack.removeReaction(msg.channel, msg.ts, "hourglass_flowing_sand");

      if (result.error) {
        await slack.addReaction(msg.channel, msg.ts, "x");
        await slack.postMessage(msg.channel, formatError(result.error), threadKey);
      } else {
        await slack.addReaction(msg.channel, msg.ts, "white_check_mark");
        const responseText = formatResponse(result.text);
        await slack.postMessage(msg.channel, responseText, threadKey);
      }
    } catch (err) {
      await slack.removeReaction(msg.channel, msg.ts, "hourglass_flowing_sand");
      await slack.addReaction(msg.channel, msg.ts, "x");
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("Failed to process message", { agentId, error: errorMsg });
      await slack.postMessage(msg.channel, formatError(errorMsg), threadKey);
    }
  }

  private resolveAgent(msg: IncomingMessage): string | null {
    // 1. Thread continuity — if this thread already has an agent, keep using it
    if (msg.threadTs) {
      const threadAgent = threadAgentMap.get(msg.threadTs);
      if (threadAgent) return threadAgent;
    }

    // 2. Channel mapping — check if a specific agent owns this channel
    const channelAgent = this.registry.findByChannel(msg.channel);
    if (channelAgent) return channelAgent.id;

    // 3. Keyword match
    const keywordAgent = this.registry.findByKeyword(msg.text);
    if (keywordAgent) return keywordAgent.id;

    // 4. Default agent
    return this.defaultAgentId;
  }
}
