import type { Db } from "mongodb";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { TeamCache } from "./team-cache.js";
import { TeamApi } from "./team-api.js";
import { ContactsWatcher } from "./contacts-watcher.js";
import { buildTeamRosterMcpServer } from "./team-roster-mcp-server.js";

export type { TeamMember, ContactCategory } from "./types.js";
export { TeamCache } from "./team-cache.js";
export { TeamApi } from "./team-api.js";

export interface TeamRosterHandle {
  api: TeamApi;
  cache: TeamCache;
  mcpServer: McpSdkServerConfigWithInstance;
  /** Stop watchers — call on shutdown */
  shutdown: () => void;
}

/**
 * Initialize the team-roster module. Wires:
 *   - cache (humans + agents slices)
 *   - in-process MCP server (closure-shared with cache)
 *   - contacts change-stream watcher → invalidates humans slice
 *   - agent-registry onPostReload subscriber → invalidates agents slice
 */
export async function initTeamRoster(deps: { db: Db; registry: AgentRegistry }): Promise<TeamRosterHandle> {
  // Use the loosely-typed Collection here — TeamCache accepts the row shape via
  // a structural ContactRow interface (subset of full ContactDoc).
  const contactsCol = deps.db.collection("contacts") as any;
  const cache = new TeamCache(contactsCol, deps.registry);
  const api = new TeamApi(cache);
  const mcpServer = buildTeamRosterMcpServer(api);

  const watcher = new ContactsWatcher(contactsCol, cache);
  await watcher.start();

  deps.registry.onPostReload(() => cache.invalidateAgents());

  return {
    api,
    cache,
    mcpServer,
    shutdown: () => watcher.stop(),
  };
}
