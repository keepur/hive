/**
 * Event Bus MCP Server — emit structured events for cross-agent coordination.
 *
 * KPR-122 port: in-process via `createSdkMcpServer`. The handler closes over
 * the shared engine `Db` plus the runner-supplied subscriber map; no per-turn
 * context is needed (subscribers and AGENT_ID are constructor-stable).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Db } from "mongodb";
import { EVENT_SCHEMAS, eventDomain } from "./event-types.js";

export interface EventBusToolDeps {
  db: Db;
  agentId: string;
  /**
   * JSON-encoded `Record<string, string[]>` mapping event domain → subscriber
   * agent ids. Constructor-stable on AgentRunner — reused across turns.
   */
  eventSubscribersJson: string;
}

export function buildEventBusTools(deps: EventBusToolDeps) {
  const { db, agentId, eventSubscribersJson } = deps;
  const events = db.collection("agent_events");

  let subscriberMap: Record<string, string[]> = {};
  try {
    subscriberMap = JSON.parse(eventSubscribersJson);
  } catch {
    process.stderr.write("event-bus: invalid eventSubscribersJson — falling back to empty map\n");
  }

  return [
    tool(
      "emit_event",
      "Emit a structured event for cross-agent coordination. Use this when something noteworthy happens that other agents may need to act on (deal won, case resolved, job complete, lead found). Events are delivered to subscribing agents automatically.",
      {
        type: z
          .string()
          .describe('Event type in "domain:action" format. Available types: ' + Object.keys(EVENT_SCHEMAS).join(", ")),
        payload: z.record(z.string(), z.unknown()).describe("Event payload — must match the schema for the event type"),
      },
      async ({ type, payload }) => {
        try {
          const parts = type.split(":");
          if (parts.length !== 2 || !parts[0] || !parts[1]) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Invalid event type format: "${type}". Must be "domain:action" (e.g., "deals:won").`,
                },
              ],
            };
          }

          const schema = EVENT_SCHEMAS[type];
          if (!schema) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Unknown event type: "${type}". Available types: ${Object.keys(EVENT_SCHEMAS).join(", ")}`,
                },
              ],
            };
          }

          const parseResult = schema.payload.safeParse(payload);
          if (!parseResult.success) {
            const errors = parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
            return {
              isError: true,
              content: [{ type: "text", text: `Invalid payload for ${type}: ${errors}` }],
            };
          }

          const domain = eventDomain(type);
          const allSubscribers = subscriberMap[domain] ?? [];
          const subscribers = allSubscribers.filter((id) => id !== agentId);

          const deliveries = subscribers.map((id) => ({ agentId: id, status: "pending" as const }));

          const now = new Date();
          const doc = {
            type,
            domain,
            payload: parseResult.data as Record<string, unknown>,
            sourceAgentId: agentId,
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
                  type: "text",
                  text: `Event emitted: ${type} [${shortId}] → 0 subscribers (no agents subscribe to "${domain}" events)`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Event emitted: ${type} [${shortId}] → ${subscribers.length} subscriber${subscribers.length === 1 ? "" : "s"} (${subscribers.join(", ")})`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `emit_event error: ${String(err)}` }] };
        }
      },
    ),
  ];
}

export function createEventBusMcpServer(deps: EventBusToolDeps) {
  return createSdkMcpServer({
    name: "event-bus",
    version: "1.0.0",
    tools: buildEventBusTools(deps),
  });
}

// ── Stdio shim ────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await (async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { MongoClient } = await import("mongodb");

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

    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(MONGODB_DB);

    const tools = buildEventBusTools({ db, agentId: AGENT_ID, eventSubscribersJson: EVENT_SUBSCRIBERS_RAW });

    const server = new McpServer({ name: "event-bus", version: "1.0.0" });
    for (const t of tools) {
      const def = t as unknown as {
        name: string;
        description: string;
        inputSchema: Record<string, z.ZodTypeAny>;
        handler: (args: Record<string, unknown>) => Promise<unknown>;
      };
      server.registerTool(
        def.name,
        { title: def.name, description: def.description, inputSchema: def.inputSchema },
        def.handler as never,
      );
    }

    const cleanup = (): void => {
      void client.close();
    };
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
