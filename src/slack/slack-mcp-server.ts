#!/usr/bin/env node

/**
 * Slack MCP Server (local stdio shim) — forwards tool calls to the hive process
 * internal HTTP API via fetch. Replaces the hosted Slack MCP (`mcp.slack.com/mcp`)
 * when `slack.localMcpServer: true` is set in hive.yaml.
 *
 * Using the bot token held by the hive process means every outbound post is
 * registered in the echo cache before the Slack event arrives — eliminating
 * the self-echo cascade that the user-token hosted MCP causes.
 *
 * Tool names are kept identical to the hosted MCP so agent system prompts need
 * no changes when the flag is toggled.
 *
 * Env vars (set by agent-runner):
 *   HIVE_INTERNAL_URL   — base URL of the hive internal API (e.g. http://127.0.0.1:3106)
 *   HIVE_INTERNAL_TOKEN — bearer token for the internal API
 *   HIVE_AGENT_ID       — this agent's ID, injected as `agent_id` in /send calls
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const INTERNAL_URL = process.env.HIVE_INTERNAL_URL ?? "";
const INTERNAL_TOKEN = process.env.HIVE_INTERNAL_TOKEN ?? "";
const AGENT_ID = process.env.HIVE_AGENT_ID ?? "";

if (!INTERNAL_URL) {
  process.stderr.write("slack-mcp-server: HIVE_INTERNAL_URL is required\n");
  process.exit(1);
}
if (!INTERNAL_TOKEN) {
  process.stderr.write("slack-mcp-server: HIVE_INTERNAL_TOKEN is required\n");
  process.exit(1);
}

const server = new McpServer({
  name: "hive-slack",
  version: "1.0.0",
});

/**
 * POST JSON to an internal API endpoint with bearer auth.
 * Returns parsed JSON or throws on network/parse error.
 */
async function apiPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${INTERNAL_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INTERNAL_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text}`);
  }

  if (!res.ok) {
    const errMsg = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }

  return parsed;
}

// ── Tool: slack_send_message ────────────────────────────────────────────────

server.registerTool(
  "slack_send_message",
  {
    title: "Send Slack Message",
    description:
      "Send a message to a Slack channel or DM. " +
      "When replying to a user message, pass the `thread_ts` value from the inbound preamble " +
      "(shown as `thread=<ts>`) so your reply lands in the same conversation thread. " +
      "Use `force_root: true` only for unprompted broadcasts (scheduled digests, cross-channel notifications) — " +
      "never when replying to a user. " +
      "Omitting both `thread_ts` and `force_root` is fine; the server falls back to the active WorkItem thread " +
      "if one is in flight on that channel.",
    inputSchema: {
      channel: z
        .string()
        .describe(
          "Channel ID (C…/D…/G…) or bare channel name (e.g. agent-river). The server resolves names to IDs.",
        ),
      text: z.string().describe("Message text (Slack mrkdwn supported)."),
      thread_ts: z
        .string()
        .optional()
        .describe("Reply in this thread. Pass the `thread=<ts>` value from the inbound preamble."),
      blocks: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Block Kit blocks (accepted, reserved for future use — v1 posts text only)."),
      force_root: z
        .boolean()
        .optional()
        .describe(
          "Post at channel root even when a thread is active. Use only for unprompted broadcasts.",
        ),
    },
  },
  async ({ channel, text, thread_ts, blocks, force_root }) => {
    try {
      const result = await apiPost("/internal/slack/send", {
        agent_id: AGENT_ID,
        channel,
        text,
        ...(thread_ts !== undefined && { thread_ts }),
        ...(blocks !== undefined && { blocks }),
        ...(force_root !== undefined && { force_root }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: slack_read_channel ────────────────────────────────────────────────

server.registerTool(
  "slack_read_channel",
  {
    title: "Read Slack Channel",
    description: "Fetch recent messages from a Slack channel. Returns message history in reverse-chronological order.",
    inputSchema: {
      channel: z
        .string()
        .describe("Channel ID (C…/D…/G…) or bare name (e.g. agent-river)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Number of messages to return (default: 10, max: 1000)."),
    },
  },
  async ({ channel, limit }) => {
    try {
      const result = await apiPost("/internal/slack/read", {
        channel,
        ...(limit !== undefined && { limit }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: slack_search_messages ─────────────────────────────────────────────

server.registerTool(
  "slack_search_messages",
  {
    title: "Search Slack Messages",
    description:
      "Search Slack messages by query. Note: search is currently deferred pending tool-parity audit — " +
      "calls will return a not-implemented response.",
    inputSchema: {
      query: z.string().describe("Search query string."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of results to return."),
    },
  },
  async ({ query, limit }) => {
    try {
      const result = await apiPost("/internal/slack/search", {
        query,
        ...(limit !== undefined && { limit }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: slack_list_channels ───────────────────────────────────────────────

server.registerTool(
  "slack_list_channels",
  {
    title: "List Slack Channels",
    description: "List available Slack channels, optionally filtered by name prefix or substring.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Optional name filter — returns channels whose name contains this string."),
    },
  },
  async ({ query }) => {
    try {
      const result = await apiPost("/internal/slack/channels", {
        ...(query !== undefined && { query }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: slack_read_user_profile ───────────────────────────────────────────

server.registerTool(
  "slack_read_user_profile",
  {
    title: "Read Slack User Profile",
    description: "Look up a Slack user's profile by user ID (U…) or display name.",
    inputSchema: {
      user: z
        .string()
        .describe("Slack user ID (U…) or display name to look up."),
    },
  },
  async ({ user }) => {
    try {
      const result = await apiPost("/internal/slack/users", { user });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ── Bootstrap ───────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
