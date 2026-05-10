import type { WorkItem } from "../../types/work-item.js";
import type { AgentRegistry } from "../../agents/agent-registry.js";
import type { AgentManager } from "../../agents/agent-manager.js";

/**
 * KPR-218: focused agent-resolution helper for the WebSocket per-turn-spawn
 * path.
 *
 * Mirrors the single-agent resolution branch of {@link Dispatcher.resolveAgents}
 * for WS work items. WS resolution diverges from Slack: `meta.origin`
 * (per-device routing tag for single-purpose shop-floor apps),
 * `meta.targetAgentId` (DM peer), and `meta.defaultAgentId` (per-device default)
 * are pre-baked into the WorkItem at construction time by the WS adapter; the
 * resolver consumes them rather than deriving them from the channel label.
 *
 * Precedence:
 *   1. Thread continuity — SessionStore-persisted (agentId, threadId) mapping
 *   2. `meta.origin` → `registry.findByOrigin()` — present for app-kind only;
 *      mirrors `dispatcher.ts:305-315` origin-routing branch. If origin is set
 *      but no agent matches, the dispatcher drops the message; the resolver
 *      mirrors that by returning `null` (caller drops).
 *   3. `meta.targetAgentId` — present only for team DMs
 *   4. `meta.defaultAgentId` — present for app-kind (non-empty when device sets
 *      one) and non-DM team channels
 *   5. Adapter-level `defaultAgentId` fallback (constructor arg)
 *
 * Returns `null` when no agent can be resolved — caller logs and drops.
 *
 * Intentionally narrower than the dispatcher: multi-agent fan-out, conference
 * mode, meeting classifiers, and name-mention routing remain on the dispatcher
 * path. Per-turn flag is OFF in production until
 * [KPR-223](https://linear.app/keepur/issue/KPR-223) decides whether per-turn
 * paths route through the dispatcher.
 */
export async function resolveAgentForWsWorkItem(
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

  // 2. Origin routing (app-kind only — team paths do not carry origin).
  //    Mirrors dispatcher.ts:305-315: if origin is set, route exclusively via
  //    findByOrigin and drop on miss. Do not fall through to default-agent
  //    rules — that would silently re-route shop-floor messages to an agent
  //    whose only qualifier is being the device default.
  const origin = workItem.meta?.origin as string | undefined;
  if (origin) {
    const originAgent = registry.findByOrigin(origin);
    if (originAgent && !originAgent.disabled) return originAgent.id;
    return null;
  }

  // 3. DM peer (team kind only).
  const targetAgentId = workItem.meta?.targetAgentId as string | undefined;
  if (targetAgentId) {
    const def = registry.get(targetAgentId);
    if (def && !def.disabled) return targetAgentId;
  }

  // 4. Meta-default (app kind or non-DM team).
  const metaDefault = workItem.meta?.defaultAgentId as string | undefined;
  if (metaDefault) {
    const def = registry.get(metaDefault);
    if (def && !def.disabled) return metaDefault;
  }

  // 5. Adapter constructor default fallback.
  if (defaultAgentId) {
    const def = registry.get(defaultAgentId);
    if (def && !def.disabled) return defaultAgentId;
  }

  return null;
}
