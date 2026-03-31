#!/usr/bin/env node

/**
 * Schedule MCP Server — self-service schedule management for agents.
 * Each agent can only manage their own schedules.
 * Reads/writes agent_definitions.schedule directly (DB-native).
 *
 * Env vars:
 *   AGENT_ID                  — the calling agent's ID (scope lock)
 *   MONGODB_URI               — MongoDB connection string
 *   MONGODB_DB                — database name
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";

const AGENT_ID = process.env.AGENT_ID ?? "unknown";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const MAX_SCHEDULES = 10;
const MIN_INTERVAL_MINUTES = 15;

interface AgentDefDoc {
  _id: string;
  schedule?: Array<{ cron: string; task: string }>;
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const agentDefs = db.collection<AgentDefDoc>("agent_definitions");

const server = new McpServer({
  name: "hive-schedule",
  version: "0.1.0",
});

/**
 * Validate that a cron expression doesn't resolve to faster than every N minutes.
 * Simple heuristic: check the minute field for intervals < MIN_INTERVAL_MINUTES.
 */
export function validateMinInterval(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return "Invalid cron expression — need 5 fields (minute hour dom month dow)";

  const minuteField = parts[0]!;

  // Step values: */5 means every 5 minutes
  const stepMatch = minuteField.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1]!, 10);
    if (step < MIN_INTERVAL_MINUTES) {
      return `Interval too frequent: every ${step} minutes. Minimum is every ${MIN_INTERVAL_MINUTES} minutes.`;
    }
  }

  // Comma-separated values: check if any two are closer than MIN_INTERVAL_MINUTES
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

  // Range: * with all wildcards means every minute
  if (minuteField === "*") {
    const allWild = parts.slice(1).every((p) => p === "*");
    if (allWild) return "This would run every minute. Minimum interval is every 15 minutes.";
  }

  return null; // valid
}

// ── my_schedules ──────────────────────────────────────────────────────

server.registerTool(
  "my_schedules",
  {
    title: "My Schedules",
    description: "List your active schedules.",
    inputSchema: {},
  },
  async () => {
    const doc = await agentDefs.findOne({ _id: AGENT_ID });
    const schedule: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

    const lines: string[] = [];
    lines.push(`## Schedules for ${AGENT_ID}\n`);

    if (schedule.length === 0) {
      lines.push("No scheduled tasks configured.");
    } else {
      lines.push("### Active Schedules:");
      for (const s of schedule) {
        lines.push(`  ${s.cron} → ${s.task}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ── my_schedule_add ───────────────────────────────────────────────────

server.registerTool(
  "my_schedule_add",
  {
    title: "Add Schedule",
    description:
      "Add a new scheduled task. Must provide a cron expression and task name. Minimum interval: 15 minutes. Maximum: 10 schedules. Note: range patterns like 0-14 bypass the interval guard — use step syntax (*/15) for intervals.",
    inputSchema: {
      cron: z.string().describe("Cron expression (e.g. '0 9 * * 1-5' for weekdays at 9am)"),
      task: z.string().describe("Task name (e.g. 'check-inbox', 'weekly-report')"),
      reason: z.string().describe("Why you're adding this schedule (for audit trail)"),
    },
  },
  async ({ cron, task, reason }) => {
    const intervalError = validateMinInterval(cron);
    if (intervalError) {
      return { content: [{ type: "text", text: intervalError }], isError: true };
    }

    const doc = await agentDefs.findOne({ _id: AGENT_ID });
    const current: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

    if (current.length >= MAX_SCHEDULES) {
      return {
        content: [{ type: "text", text: `Maximum ${MAX_SCHEDULES} schedules reached. Remove one first.` }],
        isError: true,
      };
    }

    if (current.some((s) => s.task === task)) {
      return {
        content: [
          { type: "text", text: `Schedule for task '${task}' already exists. Use my_schedule_update to change it.` },
        ],
        isError: true,
      };
    }

    const newSchedule = [...current, { cron, task }];

    await agentDefs.updateOne(
      { _id: AGENT_ID },
      { $set: { schedule: newSchedule, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    // Change stream / polling picks up the write within 30s

    return {
      content: [{ type: "text", text: `Added schedule: ${cron} → ${task}\nReason: ${reason}\nChange will take effect within 30 seconds.` }],
    };
  },
);

// ── my_schedule_remove ────────────────────────────────────────────────

server.registerTool(
  "my_schedule_remove",
  {
    title: "Remove Schedule",
    description: "Remove a scheduled task by task name.",
    inputSchema: {
      task: z.string().describe("The task name to remove"),
      reason: z.string().describe("Why you're removing this schedule (for audit trail)"),
    },
  },
  async ({ task, reason }) => {
    const doc = await agentDefs.findOne({ _id: AGENT_ID });
    const current: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

    const idx = current.findIndex((s) => s.task === task);
    if (idx === -1) {
      return {
        content: [{ type: "text", text: `No schedule found for task '${task}'.` }],
        isError: true,
      };
    }

    const newSchedule = current.filter((_, i) => i !== idx);

    await agentDefs.updateOne(
      { _id: AGENT_ID },
      { $set: { schedule: newSchedule, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    // Change stream / polling picks up the write within 30s

    return {
      content: [
        { type: "text", text: `Removed schedule for task '${task}'.\nReason: ${reason}\nChange will take effect within 30 seconds.` },
      ],
    };
  },
);

// ── my_schedule_update ────────────────────────────────────────────────

server.registerTool(
  "my_schedule_update",
  {
    title: "Update Schedule",
    description:
      "Update the cron expression for an existing scheduled task. Minimum interval: 15 minutes. Note: range patterns like 0-14 bypass the interval guard — use step syntax (*/15) for intervals.",
    inputSchema: {
      task: z.string().describe("The task name to update"),
      cron: z.string().describe("New cron expression"),
      reason: z.string().describe("Why you're changing this schedule (for audit trail)"),
    },
  },
  async ({ task, cron, reason }) => {
    const intervalError = validateMinInterval(cron);
    if (intervalError) {
      return { content: [{ type: "text", text: intervalError }], isError: true };
    }

    const doc = await agentDefs.findOne({ _id: AGENT_ID });
    const current: Array<{ cron: string; task: string }> = doc?.schedule ?? [];

    const idx = current.findIndex((s) => s.task === task);
    if (idx === -1) {
      return {
        content: [{ type: "text", text: `No schedule found for task '${task}'.` }],
        isError: true,
      };
    }

    current[idx] = { cron, task };

    await agentDefs.updateOne(
      { _id: AGENT_ID },
      { $set: { schedule: current, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    // Change stream / polling picks up the write within 30s

    return {
      content: [
        { type: "text", text: `Updated schedule: ${cron} → ${task}\nReason: ${reason}\nChange will take effect within 30 seconds.` },
      ],
    };
  },
);

// Cleanup on exit
process.on("SIGTERM", () => client.close());
process.on("SIGINT", () => client.close());

const transport = new StdioServerTransport();
await server.connect(transport);
