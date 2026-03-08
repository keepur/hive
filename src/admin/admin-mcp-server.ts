#!/usr/bin/env node

/**
 * Admin MCP Server — management tools for authorized agents (e.g. chief-of-staff).
 * Provides model override management and other admin capabilities.
 *
 * Env vars:
 *   MONGODB_URI  — MongoDB connection string
 *   MONGODB_DB   — database name (default: "hive")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const overrides = db.collection("model_overrides");
const scheduleOverrides = db.collection("schedule_overrides");

const server = new McpServer({
  name: "hive-admin",
  version: "0.1.0",
});

server.registerTool("model_list", {
  title: "List Agent Models",
  description: "Show the current model assignment for all agents, including any overrides.",
  inputSchema: {},
}, async () => {
  const docs = await overrides.find().toArray();
  if (docs.length === 0) {
    return { content: [{ type: "text", text: "No model overrides active. All agents are using their YAML defaults." }] };
  }

  const lines = docs.map((d: any) => {
    const date = d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? "");
    const by = d.updatedBy ? ` (set by ${d.updatedBy})` : "";
    return `${d.agentId}: ${d.model}${by} — ${date}`;
  });

  return { content: [{ type: "text", text: `Active model overrides:\n${lines.join("\n")}` }] };
});

server.registerTool("model_set", {
  title: "Set Agent Model",
  description: "Override the model for an agent. Takes effect on next hot-reload (SIGUSR1) or restart. Valid models: claude-sonnet-4-6, claude-haiku-4-5, claude-opus-4-6.",
  inputSchema: {
    agent_id: z.string().describe("The agent ID (e.g. 'executive-assistant', 'customer-success')"),
    model: z.string().describe("The model to use (e.g. 'claude-sonnet-4-6', 'claude-haiku-4-5')"),
  },
}, async ({ agent_id, model }) => {
  const VALID_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"];
  if (!VALID_MODELS.includes(model)) {
    return { content: [{ type: "text", text: `Invalid model: ${model}. Valid options: ${VALID_MODELS.join(", ")}` }], isError: true };
  }

  await overrides.updateOne(
    { agentId: agent_id },
    { $set: { model, updatedAt: new Date(), updatedBy: "chief-of-staff" } },
    { upsert: true },
  );

  // Send SIGUSR1 to trigger hot-reload
  try {
    process.kill(process.ppid, "SIGUSR1");
  } catch {}

  return { content: [{ type: "text", text: `Model for ${agent_id} set to ${model}. Hot-reload triggered.` }] };
});

server.registerTool("model_reset", {
  title: "Reset Agent Model",
  description: "Remove the model override for an agent, reverting to the YAML default.",
  inputSchema: {
    agent_id: z.string().describe("The agent ID to reset"),
  },
}, async ({ agent_id }) => {
  const result = await overrides.deleteOne({ agentId: agent_id });
  if (result.deletedCount === 0) {
    return { content: [{ type: "text", text: `No override found for ${agent_id} — already using YAML default.` }] };
  }

  try {
    process.kill(process.ppid, "SIGUSR1");
  } catch {}

  return { content: [{ type: "text", text: `Model override removed for ${agent_id}. Reverted to YAML default. Hot-reload triggered.` }] };
});

// ---------------------------------------------------------------------------
// Schedule override tools
// ---------------------------------------------------------------------------

server.registerTool("schedule_list", {
  title: "List Agent Schedules",
  description: "Show scheduled tasks for all agents, including any overrides. Shows what's actually active.",
  inputSchema: {},
}, async () => {
  const docs = await scheduleOverrides.find().toArray();
  const overrideMap = new Map(docs.map((d: any) => [d.agentId, d]));

  // We don't have direct access to agent configs here, so just show overrides
  if (docs.length === 0) {
    return { content: [{ type: "text", text: "No schedule overrides active. All agents are using their YAML defaults.\n\nUse schedule_set to add/change schedules, or schedule_disable to turn off an agent's schedule." }] };
  }

  const lines = docs.map((d: any) => {
    const by = d.updatedBy ? ` (by ${d.updatedBy})` : "";
    const date = d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? "");
    if (d.schedule === null) {
      return `${d.agentId}: DISABLED${by} — ${date}`;
    }
    const tasks = d.schedule.map((s: any) => `  ${s.cron} → ${s.task}`).join("\n");
    return `${d.agentId}: OVERRIDE${by} — ${date}\n${tasks}`;
  });

  return { content: [{ type: "text", text: `Schedule overrides:\n${lines.join("\n\n")}` }] };
});

server.registerTool("schedule_disable", {
  title: "Disable Agent Schedule",
  description: "Disable all scheduled tasks for an agent. The agent still responds to messages, but won't run any cron jobs.",
  inputSchema: {
    agent_id: z.string().describe("The agent ID (e.g. 'executive-assistant')"),
  },
}, async ({ agent_id }) => {
  await scheduleOverrides.updateOne(
    { agentId: agent_id },
    { $set: { schedule: null, updatedAt: new Date(), updatedBy: "chief-of-staff" } },
    { upsert: true },
  );

  try { process.kill(process.ppid, "SIGUSR1"); } catch {}

  return { content: [{ type: "text", text: `All scheduled tasks disabled for ${agent_id}. Hot-reload triggered.` }] };
});

server.registerTool("schedule_set", {
  title: "Set Agent Schedule",
  description: "Override an agent's scheduled tasks. Replaces any YAML-defined schedule. Each entry needs a cron expression and task name.",
  inputSchema: {
    agent_id: z.string().describe("The agent ID"),
    schedule: z.array(z.object({
      cron: z.string().describe("Cron expression (e.g. '0 8 * * 1-5' for weekdays at 8am)"),
      task: z.string().describe("Task name (e.g. 'morning-briefing', 'check-gmail-inbox')"),
    })).min(1).describe("List of scheduled tasks"),
  },
}, async ({ agent_id, schedule }) => {
  await scheduleOverrides.updateOne(
    { agentId: agent_id },
    { $set: { schedule, updatedAt: new Date(), updatedBy: "chief-of-staff" } },
    { upsert: true },
  );

  try { process.kill(process.ppid, "SIGUSR1"); } catch {}

  const lines = schedule.map((s) => `  ${s.cron} → ${s.task}`).join("\n");
  return { content: [{ type: "text", text: `Schedule for ${agent_id} set to:\n${lines}\n\nHot-reload triggered.` }] };
});

server.registerTool("schedule_reset", {
  title: "Reset Agent Schedule",
  description: "Remove the schedule override for an agent, reverting to whatever is defined in their YAML config.",
  inputSchema: {
    agent_id: z.string().describe("The agent ID to reset"),
  },
}, async ({ agent_id }) => {
  const result = await scheduleOverrides.deleteOne({ agentId: agent_id });
  if (result.deletedCount === 0) {
    return { content: [{ type: "text", text: `No schedule override found for ${agent_id} — already using YAML default.` }] };
  }

  try { process.kill(process.ppid, "SIGUSR1"); } catch {}

  return { content: [{ type: "text", text: `Schedule override removed for ${agent_id}. Reverted to YAML default. Hot-reload triggered.` }] };
});

// Cleanup on exit
process.on("SIGTERM", () => client.close());
process.on("SIGINT", () => client.close());

const transport = new StdioServerTransport();
await server.connect(transport);
