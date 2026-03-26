#!/usr/bin/env node

/**
 * Event Bus MCP Server — lets agents emit structured events for cross-agent coordination.
 *
 * An agent calls emit_event({ type: "deals:won", payload: { dealId: "D-123", ... } })
 * and subscribers receive it as a WorkItem via the scheduler.
 *
 * Env vars (set by agent-runner):
 *   AGENT_ID           — the calling agent's ID
 *   MONGODB_URI        — MongoDB connection string
 *   MONGODB_DB         — database name
 *   EVENT_SUBSCRIBERS  — JSON map of domain → subscriber agent IDs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";
import { EVENT_SCHEMAS, eventDomain } from "./event-types.js";

const AGENT_ID = process.env.AGENT_ID ?? "";
const MONGODB_URI = process.env.MONGODB_URI ?? "";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const EVENT_SUBSCRIBERS_RAW = process.env.EVENT_SUBSCRIBERS ?? "{}";

if (!AGENT_ID) {
  process.stderr.write("event-bus-mcp-server: AGENT_ID is required\n");
  process.exit(1);
}
if (!MONGODB_URI) {
  process.stderr.write("event-bus-mcp-server: MONGODB_URI is required\n");
  process.exit(1);
}

let subscriberMap: Record<string, string[]> = {};
try {
  subscriberMap = JSON.parse(EVENT_SUBSCRIBERS_RAW);
} catch {
  process.stderr.write("event-bus-mcp-server: invalid EVENT_SUBSCRIBERS JSON\n");
}

const client = new MongoClient(MONGODB_URI);
const db = client.db(MONGODB_DB);
const events = db.collection("agent_events");

const server = new McpServer({ name: "event-bus", version: "1.0.0" });

// ── Tool: emit_event ─────────────────────────────────────────────────────

server.registerTool(
  "emit_event",
  {
    title: "Emit Event",
    description:
      "Emit a structured event for cross-agent coordination. Use this when something noteworthy happens " +
      "that other agents may need to act on (deal won, case resolved, job complete, lead found). " +
      "Events are delivered to subscribing agents automatically.",
    inputSchema: {
      type: z
        .string()
        .describe('Event type in "domain:action" format. Available types: ' + Object.keys(EVENT_SCHEMAS).join(", ")),
      payload: z.record(z.string(), z.unknown()).describe("Event payload — must match the schema for the event type"),
    },
  },
  async ({ type, payload }) => {
    // Validate domain:action format
    const parts = type.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid event type format: "${type}". Must be "domain:action" (e.g., "deals:won").`,
          },
        ],
        isError: true,
      };
    }

    // Validate event type exists
    const schema = EVENT_SCHEMAS[type];
    if (!schema) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown event type: "${type}". Available types: ${Object.keys(EVENT_SCHEMAS).join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    // Validate payload against Zod schema
    const parseResult = schema.payload.safeParse(payload);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return {
        content: [
          {
            type: "text" as const,
            text: `Invalid payload for ${type}: ${errors}`,
          },
        ],
        isError: true,
      };
    }

    // Resolve subscribers (exclude self)
    const domain = eventDomain(type);
    const allSubscribers = subscriberMap[domain] ?? [];
    const subscribers = allSubscribers.filter((id) => id !== AGENT_ID);

    // Build deliveries array
    const deliveries = subscribers.map((agentId) => ({
      agentId,
      status: "pending" as const,
    }));

    const now = new Date();
    const doc = {
      type,
      domain,
      payload: parseResult.data as Record<string, unknown>,
      sourceAgentId: AGENT_ID,
      createdAt: now,
      hasPending: deliveries.length > 0,
      deliveries,
    };

    const result = await events.insertOne(doc);
    const eventId = result.insertedId.toHexString();
    const shortId = `evt_${eventId.slice(-8)}`;

    if (subscribers.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Event emitted: ${type} [${shortId}] \u2192 0 subscribers (no agents subscribe to "${domain}" events)`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Event emitted: ${type} [${shortId}] \u2192 ${subscribers.length} subscriber${subscribers.length === 1 ? "" : "s"} (${subscribers.join(", ")})`,
        },
      ],
    };
  },
);

// ── Connect ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
