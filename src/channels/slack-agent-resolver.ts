import type { WorkItem } from "../types/work-item.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { AgentManager } from "../agents/agent-manager.js";

/**
 * KPR-217: focused agent-resolution helper for the Slack per-turn-spawn path.
 *
 * Mirrors the single-agent resolution branch of {@link Dispatcher.resolveAgents}
 * for Slack work items: thread continuity (persisted via SessionStore) wins,
 * then channel binding, then the adapter's default. This is intentionally
 * narrower than the dispatcher — multi-agent fan-out, conference mode,
 * meeting classifiers, name-mention routing, and origin routing remain on the
 * dispatcher path. The per-turn flag is OFF in production until
 * [KPR-223](https://linear.app/keepur/issue/KPR-223) decides whether per-turn
 * spawns route through the dispatcher (Option A) or whether dispatcher
 * concerns get re-implemented adapter-side (Option B).
 *
 * Returns `null` when no agent can be resolved — caller logs and drops.
 */
export async function resolveAgentForSlackWorkItem(
  workItem: WorkItem,
  registry: AgentRegistry,
  agentManager: AgentManager,
  defaultAgentId: string | undefined,
): Promise<string | null> {
  const threadId = workItem.threadId;

  // 1. Thread continuity — if a prior turn on this thread persisted a session
  //    for some agent, that agent owns the thread. Survives restart because
  //    findAgentForThread reads from the SessionStore (Mongo).
  if (threadId) {
    const continued = await agentManager.findAgentForThread(threadId);
    if (continued && registry.get(continued)) return continued;
  }

  // 2. Channel binding — agents declare `channels: [...]`; first match owns.
  const channelAgent = registry.findByChannel(workItem.source.label);
  if (channelAgent && !channelAgent.disabled) return channelAgent.id;

  // 3. Adapter default fallback (only if the agent exists and is enabled).
  if (defaultAgentId) {
    const def = registry.get(defaultAgentId);
    if (def && !def.disabled) return defaultAgentId;
  }

  return null;
}
