/**
 * Callback MCP Server — schedule future self-invocations of an agent.
 *
 * KPR-122 port: in-process via createSdkMcpServer. Per-turn channel/thread
 * metadata flows through a mutable context ref the runner updates each turn
 * before invoking query(). The cached SDK server is reused across turns; the
 * handler always reads .current so newly-scheduled callbacks get the active
 * source.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ObjectId, type Db } from "mongodb";

export interface CallbackTurnContext {
  adapterId?: string;
  channelId?: string;
  channelKind?: string;
  channelLabel?: string;
  threadId?: string;
  slackTs?: string;
  slackThreadTs?: string;
}

export interface CallbackToolDeps {
  db: Db;
  agentId: string;
  context: { current: CallbackTurnContext };
}

/**
 * Parse a human-friendly delay string into milliseconds.
 * Supports: "30s", "5m", "1h", "2h30m", "90m", etc.
 */
function parseDelay(delay: string): number | null {
  let totalMs = 0;
  const pattern = /(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(delay)) !== null) {
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!.toLowerCase();

    if (unit.startsWith("s")) totalMs += value * 1000;
    else if (unit.startsWith("m")) totalMs += value * 60_000;
    else if (unit.startsWith("h")) totalMs += value * 3_600_000;
  }

  return totalMs > 0 ? totalMs : null;
}

export function buildCallbackTools(deps: CallbackToolDeps) {
  const { db, agentId, context } = deps;
  const callbacks = db.collection("agent_callbacks");

  return [
    tool(
      "schedule_callback",
      "Schedule a future self-invocation. You'll be re-invoked with the context you provide after the specified delay. Use this for async follow-ups: checking CI status, waiting for a deploy, polling for a response, etc. The callback will arrive as a message in the same channel where you're currently working.",
      {
        delay: z.string().describe('How long to wait before the callback. Examples: "5m", "30s", "1h", "10m", "2h30m"'),
        context: z
          .string()
          .describe(
            "The prompt/context you'll receive when the callback fires. Be specific — include what to check and what to do with the result.",
          ),
      },
      async ({ delay, context: cbContext }) => {
        try {
          const delayMs = parseDelay(delay);
          if (!delayMs) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Invalid delay format: "${delay}". Use formats like "5m", "30s", "1h", "2h30m".`,
                },
              ],
            };
          }

          const dueAt = new Date(Date.now() + delayMs);
          const turn = context.current;

          const doc = {
            agentId,
            dueAt,
            context: cbContext,
            createdAt: new Date(),
            status: "pending" as const,
            source: {
              adapterId: turn.adapterId ?? "",
              channelId: turn.channelId ?? "",
              channelKind: turn.channelKind ?? "internal",
              channelLabel: turn.channelLabel ?? "",
              threadId: turn.threadId ?? "",
              slackTs: turn.slackTs ?? "",
              slackThreadTs: turn.slackThreadTs ?? "",
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
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `schedule_callback error: ${String(err)}` }] };
        }
      },
    ),
    tool("list_callbacks", "List your pending scheduled callbacks.", {}, async () => {
      try {
        const pending = await callbacks.find({ agentId, status: "pending" }).sort({ dueAt: 1 }).toArray();

        if (pending.length === 0) {
          return { content: [{ type: "text", text: "No pending callbacks." }] };
        }

        const lines = pending.map((cb) => {
          const due = new Date(cb.dueAt).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Los_Angeles",
          });
          const ctx = String(cb.context ?? "");
          const preview = ctx.length > 80 ? ctx.slice(0, 80) + "..." : ctx;
          return `${cb._id.toString()} — due ${due} — ${preview}`;
        });

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `list_callbacks error: ${String(err)}` }] };
      }
    }),
    tool(
      "cancel_callback",
      "Cancel a pending callback by its ID.",
      {
        callbackId: z.string().describe("The callback ID to cancel"),
      },
      async ({ callbackId }) => {
        try {
          let oid: ObjectId;
          try {
            oid = new ObjectId(callbackId);
          } catch {
            return { isError: true, content: [{ type: "text", text: "Invalid callback ID." }] };
          }

          const result = await callbacks.updateOne(
            { _id: oid, agentId, status: "pending" },
            { $set: { status: "cancelled", cancelledAt: new Date() } },
          );

          if (result.modifiedCount === 0) {
            return { content: [{ type: "text", text: "Callback not found or already fired/cancelled." }] };
          }

          return { content: [{ type: "text", text: "Callback cancelled." }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `cancel_callback error: ${String(err)}` }] };
        }
      },
    ),
  ];
}

export function createCallbackMcpServer(deps: CallbackToolDeps) {
  return createSdkMcpServer({
    name: "callback",
    version: "1.0.0",
    tools: buildCallbackTools(deps),
  });
}

// Stdio shim for the publish-ready bundle path.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await (async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { MongoClient } = await import("mongodb");

    const AGENT_ID = process.env.CB_AGENT_ID ?? "";
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
    await client.connect();
    const db = client.db(MONGODB_DB);

    const context = {
      current: {
        adapterId: process.env.CB_ADAPTER_ID,
        channelId: process.env.CB_CHANNEL_ID,
        channelKind: process.env.CB_CHANNEL_KIND,
        channelLabel: process.env.CB_CHANNEL_LABEL,
        threadId: process.env.CB_THREAD_ID,
        slackTs: process.env.CB_SLACK_TS,
        slackThreadTs: process.env.CB_SLACK_THREAD_TS,
      },
    };

    const tools = buildCallbackTools({ db, agentId: AGENT_ID, context });

    const server = new McpServer({ name: "callback", version: "1.0.0" });
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
