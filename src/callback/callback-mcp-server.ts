#!/usr/bin/env node

/**
 * Callback MCP Server — lets agents schedule future self-invocations.
 *
 * An agent calls schedule_callback("10m", "Check CI run 12345 status")
 * and gets re-invoked with that context after the delay.
 *
 * Env vars (set by agent-runner, same pattern as background MCP):
 *   CB_AGENT_ID        — the calling agent's ID
 *   CB_ADAPTER_ID      — adapter to route response through
 *   CB_CHANNEL_ID      — Slack channel ID to post response in
 *   CB_CHANNEL_KIND    — "slack", "sms", etc.
 *   CB_CHANNEL_LABEL   — human-readable channel name
 *   CB_THREAD_ID       — thread to continue in (optional)
 *   CB_SLACK_TS        — Slack message timestamp
 *   CB_SLACK_THREAD_TS — Slack thread timestamp
 *   MONGODB_URI        — MongoDB connection string
 *   MONGODB_DB         — database name
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient, ObjectId } from "mongodb";

const AGENT_ID = process.env.CB_AGENT_ID ?? "";
const ADAPTER_ID = process.env.CB_ADAPTER_ID ?? "";
const CHANNEL_ID = process.env.CB_CHANNEL_ID ?? "";
const CHANNEL_KIND = process.env.CB_CHANNEL_KIND ?? "internal";
const CHANNEL_LABEL = process.env.CB_CHANNEL_LABEL ?? "";
const THREAD_ID = process.env.CB_THREAD_ID ?? "";
const SLACK_TS = process.env.CB_SLACK_TS ?? "";
const SLACK_THREAD_TS = process.env.CB_SLACK_THREAD_TS ?? "";
const MONGODB_URI = process.env.MONGODB_URI ?? "";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";

if (!AGENT_ID) {
  process.stderr.write("callback-mcp-server: CB_AGENT_ID is required\n");
  process.exit(1);
}
if (!MONGODB_URI) {
  process.stderr.write("callback-mcp-server: MONGODB_URI is required\n");
  process.exit(1);
}

const client = new MongoClient(MONGODB_URI);
const db = client.db(MONGODB_DB);
const callbacks = db.collection("agent_callbacks");

const server = new McpServer({ name: "callback", version: "1.0.0" });

/**
 * Parse a human-friendly delay string into milliseconds.
 * Supports: "30s", "5m", "1h", "2h30m", "90m", etc.
 */
function parseDelay(delay: string): number | null {
  let totalMs = 0;
  const pattern = /(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(delay)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    if (unit.startsWith("s")) totalMs += value * 1000;
    else if (unit.startsWith("m")) totalMs += value * 60_000;
    else if (unit.startsWith("h")) totalMs += value * 3_600_000;
  }

  return totalMs > 0 ? totalMs : null;
}

// ── Tool: schedule_callback ─────────────────────────────────────────────

server.registerTool(
  "schedule_callback",
  {
    title: "Schedule Callback",
    description:
      "Schedule a future self-invocation. You'll be re-invoked with the context you provide after the specified delay. " +
      "Use this for async follow-ups: checking CI status, waiting for a deploy, polling for a response, etc. " +
      "The callback will arrive as a message in the same channel where you're currently working.",
    inputSchema: {
      delay: z.string().describe('How long to wait before the callback. Examples: "5m", "30s", "1h", "10m", "2h30m"'),
      context: z
        .string()
        .describe(
          "The prompt/context you'll receive when the callback fires. Be specific — include what to check and what to do with the result.",
        ),
    },
  },
  async ({ delay, context }) => {
    const delayMs = parseDelay(delay);
    if (!delayMs) {
      return {
        content: [
          { type: "text", text: `Invalid delay format: "${delay}". Use formats like "5m", "30s", "1h", "2h30m".` },
        ],
        isError: true,
      };
    }

    const dueAt = new Date(Date.now() + delayMs);

    const doc = {
      agentId: AGENT_ID,
      dueAt,
      context,
      createdAt: new Date(),
      status: "pending" as const,
      source: {
        adapterId: ADAPTER_ID,
        channelId: CHANNEL_ID,
        channelKind: CHANNEL_KIND,
        channelLabel: CHANNEL_LABEL,
        threadId: THREAD_ID,
        slackTs: SLACK_TS,
        slackThreadTs: SLACK_THREAD_TS,
      },
    };

    const result = await callbacks.insertOne(doc);

    const friendlyTime = dueAt.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Los_Angeles",
    });

    return {
      content: [
        {
          type: "text",
          text: `Callback scheduled for ${friendlyTime} (in ${delay}). ID: ${result.insertedId.toString()}`,
        },
      ],
    };
  },
);

// ── Tool: list_callbacks ────────────────────────────────────────────────

server.registerTool(
  "list_callbacks",
  {
    title: "List Callbacks",
    description: "List your pending scheduled callbacks.",
    inputSchema: {},
  },
  async () => {
    const pending = await callbacks.find({ agentId: AGENT_ID, status: "pending" }).sort({ dueAt: 1 }).toArray();

    if (pending.length === 0) {
      return { content: [{ type: "text", text: "No pending callbacks." }] };
    }

    const lines = pending.map((cb) => {
      const due = new Date(cb.dueAt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      });
      const preview = cb.context.length > 80 ? cb.context.slice(0, 80) + "..." : cb.context;
      return `${cb._id.toString()} — due ${due} — ${preview}`;
    });

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ── Tool: cancel_callback ───────────────────────────────────────────────

server.registerTool(
  "cancel_callback",
  {
    title: "Cancel Callback",
    description: "Cancel a pending callback by its ID.",
    inputSchema: {
      callbackId: z.string().describe("The callback ID to cancel"),
    },
  },
  async ({ callbackId }) => {
    let oid: ObjectId;
    try {
      oid = new ObjectId(callbackId);
    } catch {
      return { content: [{ type: "text", text: "Invalid callback ID." }], isError: true };
    }

    const result = await callbacks.updateOne(
      { _id: oid, agentId: AGENT_ID, status: "pending" },
      { $set: { status: "cancelled", cancelledAt: new Date() } },
    );

    if (result.modifiedCount === 0) {
      return { content: [{ type: "text", text: "Callback not found or already fired/cancelled." }] };
    }

    return { content: [{ type: "text", text: "Callback cancelled." }] };
  },
);

// ── Connect ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
