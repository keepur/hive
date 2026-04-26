import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TeamApi } from "./team-api.js";

/**
 * Build the in-process team-roster MCP server. Returns the server config
 * shape that drops directly into agent-runner's mcpServers map alongside
 * stdio-typed entries. Closes over the shared TeamApi (and thus TeamCache),
 * so internal callers and agent tool calls hit identical state.
 *
 * NOTE: this is the first in-process (createSdkMcpServer) server in the
 * codebase — every other MCP is a stdio subprocess. The cache invariants
 * require single-process state; roster data has no isolation argument for
 * separate-process execution.
 */
export function buildTeamRosterMcpServer(api: TeamApi): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "team-roster",
    version: "0.1.0",
    tools: [
      tool(
        "team_list",
        "List the team. Defaults: active humans + active agents, sorted humans-first then by name. " +
          "Set includeArchived=true to include archived humans and deactivated agents. " +
          "Set includeAgents=false to filter to humans only.",
        {
          includeArchived: z.boolean().optional(),
          includeAgents: z.boolean().optional(),
        },
        async (args) => {
          const members = await api.getTeam(args);
          return { content: [{ type: "text", text: JSON.stringify(members, null, 2) }] };
        },
      ),
      tool(
        "team_lookup_human",
        "Look up a team-human by name or email. Provide exactly one. " +
          "Match: case-insensitive exact for both. Returns null if not found.",
        {
          name: z.string().optional(),
          email: z.string().optional(),
        },
        async (args) => {
          try {
            const m = await api.lookupHuman(args);
            return { content: [{ type: "text", text: m ? JSON.stringify(m, null, 2) : "null" }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: err.message ?? String(err) }], isError: true };
          }
        },
      ),
      tool(
        "team_lookup_agent",
        "Look up a team-agent by agentId or name. Provide exactly one. " +
          "agentId is case-sensitive; name is case-insensitive and matches aliases. " +
          "Returns null if not found.",
        {
          agentId: z.string().optional(),
          name: z.string().optional(),
        },
        async (args) => {
          try {
            const m = await api.lookupAgent(args);
            return { content: [{ type: "text", text: m ? JSON.stringify(m, null, 2) : "null" }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: err.message ?? String(err) }], isError: true };
          }
        },
      ),
    ],
  });
}
