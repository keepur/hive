#!/usr/bin/env node
/**
 * Conversation Search MCP Server — semantic search over agent conversation history.
 *
 * Agents search their own conversations by default. Chief-of-staff can search
 * any agent's conversations by passing a different agentId.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConversationIndex } from "./conversation-index.js";

const AGENT_ID = process.env.AGENT_ID;
if (!AGENT_ID) {
  process.stderr.write("conversation-search: AGENT_ID env var is required\n");
  process.exit(1);
}

const server = new McpServer({ name: "conversation-search", version: "1.0.0" });

// ── Lazy Init ────────────────────────────────────────────────────────────────

let conversationIndex: ConversationIndex;
function ensureReady() {
  if (!conversationIndex) conversationIndex = new ConversationIndex();
}

// ── Tool: conversation_search ────────────────────────────────────────────────

server.registerTool(
  "conversation_search",
  {
    title: "Conversation Search",
    description:
      "Semantic search over past conversations. Returns the most relevant exchanges for a natural language query. By default searches your own conversations; chief-of-staff can search other agents.",
    inputSchema: {
      query: z
        .string()
        .describe("Natural language search query, e.g. 'kitchen remodel discussion', 'pricing questions'"),
      agentId: z
        .string()
        .optional()
        .describe("Agent ID to search. Defaults to your own. Only chief-of-staff can search other agents."),
      limit: z.number().optional().default(10).describe("Maximum results to return"),
      since: z.string().optional().describe("Only return conversations after this ISO date, e.g. '2026-01-01'"),
    },
  },
  async ({ query, agentId, limit, since }) => {
    try {
      ensureReady();

      const effectiveAgentId = agentId ?? AGENT_ID;

      // Access control: only chief-of-staff can search other agents
      if (effectiveAgentId !== AGENT_ID && AGENT_ID !== "chief-of-staff") {
        return {
          content: [
            {
              type: "text",
              text: `Access denied: only chief-of-staff can search other agents' conversations.`,
            },
          ],
          isError: true,
        };
      }

      const sinceUnix = since ? Math.floor(new Date(since).getTime() / 1000) : undefined;

      const results = await conversationIndex.search(query, effectiveAgentId, limit, sinceUnix);

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching conversations found." }] };
      }

      const formatted = results
        .map((r, i) => {
          const inboundSnippet = r.inbound.length > 200 ? r.inbound.slice(0, 200) + "..." : r.inbound;
          const responseSnippet = r.response.length > 300 ? r.response.slice(0, 300) + "..." : r.response;
          return [
            `${i + 1}. [${r.timestamp}] #${r.channelId} — ${r.senderName}`,
            `   Inbound: ${inboundSnippet}`,
            `   Response: ${responseSnippet}`,
            `   Score: ${r.score.toFixed(4)}`,
          ].join("\n");
        })
        .join("\n\n");

      return {
        content: [{ type: "text", text: `Found ${results.length} conversations:\n\n${formatted}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Connect and run ─────────────────────────────────────────────────────────

process.stderr.write("conversation-search: starting\n");
const transport = new StdioServerTransport();
await server.connect(transport);
