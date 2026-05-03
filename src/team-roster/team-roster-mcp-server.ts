import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TeamRoster } from "./team-roster.js";

/**
 * Build the tool definitions for the team-roster MCP server.
 *
 * Exported separately so unit tests can drive the handlers directly without
 * going through the SDK's MCP transport.
 */
export function buildTeamRosterTools(roster: TeamRoster) {
  return [
    tool(
      "team_list",
      "List the team. Defaults: active humans + active agents, sorted by category then name. Set includeArchived=true to include archived members. Set includeAgents=false to filter to humans only.",
      {
        includeArchived: z.boolean().optional(),
        includeAgents: z.boolean().optional(),
      },
      async (args) => {
        const team = await roster.getTeam({
          includeArchived: args.includeArchived,
          includeAgents: args.includeAgents,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(team, null, 2) }],
        };
      },
    ),
    tool(
      "team_lookup_human",
      "Look up a team-human by name or email. USE THIS FOR ROUTINE TEAMMATE INFO — roles, email, pronouns. Provide exactly one of name|email. Returns full contact card or null if no match. Match is case-insensitive exact (no fuzzy/partial).",
      {
        name: z.string().optional(),
        email: z.string().optional(),
      },
      async (args) => {
        if ((args.name ? 1 : 0) + (args.email ? 1 : 0) !== 1) {
          return {
            isError: true,
            content: [{ type: "text", text: "team_lookup_human: provide exactly one of name|email" }],
          };
        }
        const result = await roster.lookupHuman(args);
        return {
          content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : "null" }],
        };
      },
    ),
    tool(
      "team_lookup_agent",
      "Look up a team-agent by agentId or name (aliases supported). USE THIS FOR ROUTINE TEAMMATE INFO — roles, channel, model. Reserve `agent_get` (admin) for editing or version history. Provide exactly one of agentId|name. agentId match is case-sensitive; name/alias match is case-insensitive. Returns full agent card or null if no match.",
      {
        agentId: z.string().optional(),
        name: z.string().optional(),
      },
      async (args) => {
        if ((args.agentId ? 1 : 0) + (args.name ? 1 : 0) !== 1) {
          return {
            isError: true,
            content: [{ type: "text", text: "team_lookup_agent: provide exactly one of agentId|name" }],
          };
        }
        const result = await roster.lookupAgent(args);
        return {
          content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : "null" }],
        };
      },
    ),
  ];
}

/**
 * In-process MCP server exposing the team roster as agent tools.
 *
 * Note: this is the codebase's first `createSdkMcpServer` server — every other
 * MCP today is a stdio subprocess. The in-process pattern is required here
 * because the cache singleton must be shared between engine internals and the
 * agent-facing tools.
 */
export function createTeamRosterMcpServer(roster: TeamRoster) {
  return createSdkMcpServer({
    name: "team-roster",
    version: "0.1.0",
    tools: buildTeamRosterTools(roster),
  });
}
