/**
 * Schedule MCP Server — self-service schedule management for agents.
 *
 * KPR-122 port: in-process via createSdkMcpServer. Tool handlers close over
 * the shared engine Db. No per-turn context.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Db } from "mongodb";

const MAX_SCHEDULES = 10;
const MIN_INTERVAL_MINUTES = 15;

interface AgentDefDoc {
  _id: string;
  schedule?: Array<{ cron: string; task: string }>;
  scheduleLocked?: boolean;
  scheduleLastReason?: string;
}

export interface ScheduleToolDeps {
  db: Db;
  agentId: string;
}

/**
 * Validate that a cron expression doesn't resolve to faster than every N minutes.
 * Simple heuristic: check the minute field for intervals < MIN_INTERVAL_MINUTES.
 */
export function validateMinInterval(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return "Invalid cron expression — need 5 fields (minute hour dom month dow)";

  const minuteField = parts[0]!;

  const stepMatch = minuteField.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1]!, 10);
    if (step < MIN_INTERVAL_MINUTES) {
      return `Interval too frequent: every ${step} minutes. Minimum is every ${MIN_INTERVAL_MINUTES} minutes.`;
    }
  }

  if (minuteField.includes(",")) {
    const vals = minuteField
      .split(",")
      .map((v) => parseInt(v, 10))
      .filter((v) => !isNaN(v))
      .sort((a, b) => a - b);
    for (let i = 1; i < vals.length; i++) {
      if (vals[i]! - vals[i - 1]! < MIN_INTERVAL_MINUTES) {
        return `Minutes too close together: ${vals[i - 1]} and ${vals[i]}. Minimum gap is ${MIN_INTERVAL_MINUTES} minutes.`;
      }
    }
  }

  if (minuteField === "*") {
    const allWild = parts.slice(1).every((p) => p === "*");
    if (allWild) return "This would run every minute. Minimum interval is every 15 minutes.";
  }

  return null;
}

export function buildScheduleTools(deps: ScheduleToolDeps) {
  const { db, agentId } = deps;
  const agentDefs = db.collection<AgentDefDoc>("agent_definitions");

  return [
    tool("my_schedules", "List your active schedules.", {}, async () => {
      try {
        const doc = await agentDefs.findOne({ _id: agentId });
        const schedule: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

        const lines: string[] = [];
        lines.push(`## Schedules for ${agentId}\n`);

        if (schedule.length === 0) {
          lines.push("No scheduled tasks configured.");
        } else {
          lines.push("### Active Schedules:");
          for (const s of schedule) {
            lines.push(`  ${s.cron} → ${s.task}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `my_schedules error: ${String(err)}` }] };
      }
    }),
    tool(
      "my_schedule_add",
      "Add a new scheduled task. Must provide a cron expression and task name. Minimum interval: 15 minutes. Maximum: 10 schedules. Note: range patterns like 0-14 bypass the interval guard — use step syntax (*/15) for intervals.",
      {
        cron: z.string().describe("Cron expression (e.g. '0 9 * * 1-5' for weekdays at 9am)"),
        task: z.string().describe("Task name (e.g. 'check-inbox', 'weekly-report')"),
        reason: z.string().describe("Why you're adding this schedule (for audit trail)"),
      },
      async ({ cron, task, reason }) => {
        try {
          const intervalError = validateMinInterval(cron);
          if (intervalError) {
            return { isError: true, content: [{ type: "text", text: intervalError }] };
          }

          const doc = await agentDefs.findOne({ _id: agentId });

          if (doc?.scheduleLocked) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Your schedule is locked by an admin. Contact the platform admin to unlock it.",
                },
              ],
            };
          }

          const current: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

          if (current.length >= MAX_SCHEDULES) {
            return {
              isError: true,
              content: [{ type: "text", text: `Maximum ${MAX_SCHEDULES} schedules reached. Remove one first.` }],
            };
          }

          if (current.some((s) => s.task === task)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Schedule for task '${task}' already exists. Use my_schedule_update to change it.`,
                },
              ],
            };
          }

          const newSchedule = [...current, { cron, task }];

          await agentDefs.updateOne(
            { _id: agentId },
            { $set: { schedule: newSchedule, scheduleLastReason: reason, updatedAt: new Date(), updatedBy: agentId } },
          );

          return {
            content: [
              {
                type: "text",
                text: `Added schedule: ${cron} → ${task}\nReason: ${reason}\nChange will take effect within 30 seconds.`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `my_schedule_add error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "my_schedule_remove",
      "Remove a scheduled task by task name.",
      {
        task: z.string().describe("The task name to remove"),
        reason: z.string().describe("Why you're removing this schedule (for audit trail)"),
      },
      async ({ task, reason }) => {
        try {
          const doc = await agentDefs.findOne({ _id: agentId });

          if (doc?.scheduleLocked) {
            return {
              isError: true,
              content: [{ type: "text", text: "Your schedule is locked by an admin." }],
            };
          }

          const current: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

          const idx = current.findIndex((s) => s.task === task);
          if (idx === -1) {
            return {
              isError: true,
              content: [{ type: "text", text: `No schedule found for task '${task}'.` }],
            };
          }

          const newSchedule = current.filter((_, i) => i !== idx);

          await agentDefs.updateOne(
            { _id: agentId },
            { $set: { schedule: newSchedule, scheduleLastReason: reason, updatedAt: new Date(), updatedBy: agentId } },
          );

          return {
            content: [
              {
                type: "text",
                text: `Removed schedule for task '${task}'.\nReason: ${reason}\nChange will take effect within 30 seconds.`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `my_schedule_remove error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "my_schedule_update",
      "Update the cron expression for an existing scheduled task. Minimum interval: 15 minutes. Note: range patterns like 0-14 bypass the interval guard — use step syntax (*/15) for intervals.",
      {
        task: z.string().describe("The task name to update"),
        cron: z.string().describe("New cron expression"),
        reason: z.string().describe("Why you're changing this schedule (for audit trail)"),
      },
      async ({ task, cron, reason }) => {
        try {
          const intervalError = validateMinInterval(cron);
          if (intervalError) {
            return { isError: true, content: [{ type: "text", text: intervalError }] };
          }

          const doc = await agentDefs.findOne({ _id: agentId });

          if (doc?.scheduleLocked) {
            return {
              isError: true,
              content: [{ type: "text", text: "Your schedule is locked by an admin." }],
            };
          }

          const current: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

          const idx = current.findIndex((s) => s.task === task);
          if (idx === -1) {
            return {
              isError: true,
              content: [{ type: "text", text: `No schedule found for task '${task}'.` }],
            };
          }

          current[idx] = { cron, task };

          await agentDefs.updateOne(
            { _id: agentId },
            { $set: { schedule: current, scheduleLastReason: reason, updatedAt: new Date(), updatedBy: agentId } },
          );

          return {
            content: [
              {
                type: "text",
                text: `Updated schedule: ${cron} → ${task}\nReason: ${reason}\nChange will take effect within 30 seconds.`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `my_schedule_update error: ${String(err)}` }] };
        }
      },
    ),
  ];
}

export function createScheduleMcpServer(deps: ScheduleToolDeps) {
  return createSdkMcpServer({
    name: "schedule",
    version: "0.1.0",
    tools: buildScheduleTools(deps),
  });
}

// Stdio shim for the publish-ready bundle path.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await (async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { MongoClient } = await import("mongodb");

    const AGENT_ID = process.env.AGENT_ID ?? "unknown";
    const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
    const MONGODB_DB = process.env.MONGODB_DB ?? "hive";

    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(MONGODB_DB);

    const tools = buildScheduleTools({ db, agentId: AGENT_ID });

    const server = new McpServer({ name: "hive-schedule", version: "0.1.0" });
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
