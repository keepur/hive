#!/usr/bin/env node

/**
 * Slack MCP Server — local stdio shim forwarding tool calls to the hive's
 * internal HTTP API (`/internal/slack/*`). The hive process owns the bot-token
 * WebClient, outbound-ts cache, and active-WorkItem tracking so posting,
 * cache-registration, and threading-fallback happen atomically in-process.
 *
 * Tool names mirror the hosted Slack MCP so agents see the same surface.
 *
 * Env vars (all required):
 *   HIVE_INTERNAL_URL   — base URL of the hive internal API (e.g. http://127.0.0.1:5207)
 *   HIVE_INTERNAL_TOKEN — bearer token for the internal API
 *   HIVE_AGENT_ID       — agent id, forwarded as `agent_id` on /send for threading fallback
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HIVE_INTERNAL_URL = process.env.HIVE_INTERNAL_URL;
const HIVE_INTERNAL_TOKEN = process.env.HIVE_INTERNAL_TOKEN;
const HIVE_AGENT_ID = process.env.HIVE_AGENT_ID;

if (!HIVE_INTERNAL_URL) throw new Error("HIVE_INTERNAL_URL env var is required");
if (!HIVE_INTERNAL_TOKEN) throw new Error("HIVE_INTERNAL_TOKEN env var is required");
if (!HIVE_AGENT_ID) throw new Error("HIVE_AGENT_ID env var is required");

const server = new McpServer({
  name: "hive-slack",
  version: "0.1.0",
});

async function callApi(path: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${HIVE_INTERNAL_URL!.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HIVE_INTERNAL_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response from ${path} (status ${res.status}): ${text}`);
  }
  if (!res.ok) {
    const err = (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(`${path} failed: ${err}`);
  }
  return parsed;
}

function toToolResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function toErrorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

server.registerTool(
  "slack_send_message",
  {
    title: "Send Slack Message",
    description:
      "Post a message to a Slack channel or DM using the hive bot identity. Pass `thread_ts` to reply in a thread; set `force_root: true` to force a top-level post (use only for unprompted broadcasts).",
    inputSchema: {
      channel: z.string().describe("Channel id (C…/D…/G…) or name (e.g. 'agent-river' or '#general')"),
      text: z.string().describe("Message text"),
      thread_ts: z.string().optional().describe("Slack ts of the parent message to reply under"),
      blocks: z.array(z.any()).optional().describe("Slack Block Kit blocks"),
      force_root: z.boolean().optional().describe("If true, post at channel root even if a thread context is active"),
    },
  },
  async ({ channel, text, thread_ts, blocks, force_root }) => {
    try {
      const result = await callApi("/internal/slack/send", {
        agent_id: HIVE_AGENT_ID,
        channel,
        text,
        thread_ts,
        blocks,
        force_root,
      });
      return toToolResult(result);
    } catch (err) {
      return toErrorResult(err);
    }
  },
);

server.registerTool(
  "slack_read_channel",
  {
    title: "Read Slack Channel",
    description: "Fetch recent messages from a Slack channel via conversations.history.",
    inputSchema: {
      channel: z.string().describe("Channel id or name"),
      limit: z.number().int().positive().optional().describe("Max messages to return"),
    },
  },
  async ({ channel, limit }) => {
    try {
      const result = await callApi("/internal/slack/read", { channel, limit });
      return toToolResult(result);
    } catch (err) {
      return toErrorResult(err);
    }
  },
);

server.registerTool(
  "slack_search_messages",
  {
    title: "Search Slack Messages",
    description:
      "Search across Slack messages. (Currently returns a 501 stub — search is deferred pending tool-parity audit.)",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z.number().int().positive().optional().describe("Max results to return"),
    },
  },
  async ({ query, limit }) => {
    try {
      const result = await callApi("/internal/slack/search", { query, limit });
      return toToolResult(result);
    } catch (err) {
      return toErrorResult(err);
    }
  },
);

server.registerTool(
  "slack_list_channels",
  {
    title: "List Slack Channels",
    description: "List workspace channels the bot can see, optionally filtered by name substring.",
    inputSchema: {
      query: z.string().optional().describe("Optional substring to filter channel names by"),
    },
  },
  async ({ query }) => {
    try {
      const result = await callApi("/internal/slack/channels", { query });
      return toToolResult(result);
    } catch (err) {
      return toErrorResult(err);
    }
  },
);

server.registerTool(
  "slack_read_user_profile",
  {
    title: "Read Slack User Profile",
    description: "Fetch a Slack user's profile via users.info.",
    inputSchema: {
      user: z.string().describe("Slack user id (U…)"),
    },
  },
  async ({ user }) => {
    try {
      const result = await callApi("/internal/slack/users", { user });
      return toToolResult(result);
    } catch (err) {
      return toErrorResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
