import type { Db } from "mongodb";
import type { ContactRow } from "./team-cache.js";
import type { Collection } from "mongodb";
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
  // TeamCache accepts the row shape via a structural ContactRow interface
  // (subset of full ContactDoc). Cast at the boundary: ContactRow has a
  // duck-typed `_id: { toHexString(): string }` that doesn't satisfy Mongo's
  // ObjectId invariant, so we go through `unknown` rather than `any` —
  // explicit escape hatch instead of leaking `any` further into the module.
  const contactsCol = deps.db.collection("contacts") as unknown as Collection<ContactRow>;
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
