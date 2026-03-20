#!/usr/bin/env node

/**
 * Admin MCP Server — management tools for authorized agents.
 * Provides model override management and other admin capabilities.
 *
 * Env vars:
 *   MONGODB_URI  — MongoDB connection string
 *   MONGODB_DB   — database name (default: "hive")
 *   AGENT_ID     — the calling agent's ID (used for audit trails)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const AGENT_ID = process.env.AGENT_ID ?? "admin";

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const overrides = db.collection("model_overrides");
const scheduleOverrides = db.collection("schedule_overrides");
const configOverrides = db.collection("agent_config_overrides");

const promptOverrides = db.collection("prompt_overrides");

const server = new McpServer({
  name: "hive-admin",
  version: "0.1.0",
});

server.registerTool(
  "model_list",
  {
    title: "List Agent Models",
    description: "Show the current model assignment for all agents, including any overrides.",
    inputSchema: {},
  },
  async () => {
    const docs = await overrides.find().toArray();
    if (docs.length === 0) {
      return {
        content: [{ type: "text", text: "No model overrides active. All agents are using their YAML defaults." }],
      };
    }

    const lines = docs.map((d: any) => {
      const date = d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? "");
      const by = d.updatedBy ? ` (set by ${d.updatedBy})` : "";
      return `${d.agentId}: ${d.model}${by} — ${date}`;
    });

    return { content: [{ type: "text", text: `Active model overrides:\n${lines.join("\n")}` }] };
  },
);

server.registerTool(
  "model_set",
  {
    title: "Set Agent Model",
    description:
      "Override the model for an agent. Takes effect on next hot-reload (SIGUSR1) or restart. Valid models: claude-sonnet-4-6, claude-haiku-4-5, claude-opus-4-6.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID (e.g. 'executive-assistant', 'customer-success')"),
      model: z.string().describe("The model to use (e.g. 'claude-sonnet-4-6', 'claude-haiku-4-5')"),
    },
  },
  async ({ agent_id, model }) => {
    const VALID_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"];
    if (!VALID_MODELS.includes(model)) {
      return {
        content: [{ type: "text", text: `Invalid model: ${model}. Valid options: ${VALID_MODELS.join(", ")}` }],
        isError: true,
      };
    }

    await overrides.updateOne(
      { agentId: agent_id },
      { $set: { model, updatedAt: new Date(), updatedBy: AGENT_ID } },
      { upsert: true },
    );

    // Send SIGUSR1 to trigger hot-reload
    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return { content: [{ type: "text", text: `Model for ${agent_id} set to ${model}. Hot-reload triggered.` }] };
  },
);

server.registerTool(
  "model_reset",
  {
    title: "Reset Agent Model",
    description: "Remove the model override for an agent, reverting to the YAML default.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to reset"),
    },
  },
  async ({ agent_id }) => {
    const result = await overrides.deleteOne({ agentId: agent_id });
    if (result.deletedCount === 0) {
      return { content: [{ type: "text", text: `No override found for ${agent_id} — already using YAML default.` }] };
    }

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: `Model override removed for ${agent_id}. Reverted to YAML default. Hot-reload triggered.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Schedule override tools
// ---------------------------------------------------------------------------

server.registerTool(
  "schedule_list",
  {
    title: "List Agent Schedules",
    description: "Show scheduled tasks for all agents, including any overrides. Shows what's actually active.",
    inputSchema: {},
  },
  async () => {
    const docs = await scheduleOverrides.find().toArray();
    const overrideMap = new Map(docs.map((d: any) => [d.agentId, d]));

    // We don't have direct access to agent configs here, so just show overrides
    if (docs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No schedule overrides active. All agents are using their YAML defaults.\n\nUse schedule_set to add/change schedules, or schedule_disable to turn off an agent's schedule.",
          },
        ],
      };
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
  },
);

server.registerTool(
  "schedule_disable",
  {
    title: "Disable Agent Schedule",
    description:
      "Disable all scheduled tasks for an agent. The agent still responds to messages, but won't run any cron jobs.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID (e.g. 'executive-assistant')"),
    },
  },
  async ({ agent_id }) => {
    await scheduleOverrides.updateOne(
      { agentId: agent_id },
      { $set: { schedule: null, updatedAt: new Date(), updatedBy: AGENT_ID } },
      { upsert: true },
    );

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return { content: [{ type: "text", text: `All scheduled tasks disabled for ${agent_id}. Hot-reload triggered.` }] };
  },
);

server.registerTool(
  "schedule_set",
  {
    title: "Set Agent Schedule",
    description:
      "Override an agent's scheduled tasks. Replaces any YAML-defined schedule. Each entry needs a cron expression and task name.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID"),
      schedule: z
        .array(
          z.object({
            cron: z.string().describe("Cron expression (e.g. '0 8 * * 1-5' for weekdays at 8am)"),
            task: z.string().describe("Task name (e.g. 'morning-briefing', 'check-gmail-inbox')"),
          }),
        )
        .min(1)
        .describe("List of scheduled tasks"),
    },
  },
  async ({ agent_id, schedule }) => {
    await scheduleOverrides.updateOne(
      { agentId: agent_id },
      { $set: { schedule, updatedAt: new Date(), updatedBy: AGENT_ID } },
      { upsert: true },
    );

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    const lines = schedule.map((s) => `  ${s.cron} → ${s.task}`).join("\n");
    return { content: [{ type: "text", text: `Schedule for ${agent_id} set to:\n${lines}\n\nHot-reload triggered.` }] };
  },
);

server.registerTool(
  "schedule_reset",
  {
    title: "Reset Agent Schedule",
    description: "Remove the schedule override for an agent, reverting to whatever is defined in their YAML config.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to reset"),
    },
  },
  async ({ agent_id }) => {
    const result = await scheduleOverrides.deleteOne({ agentId: agent_id });
    if (result.deletedCount === 0) {
      return {
        content: [{ type: "text", text: `No schedule override found for ${agent_id} — already using YAML default.` }],
      };
    }

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: `Schedule override removed for ${agent_id}. Reverted to YAML default. Hot-reload triggered.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Agent enable/disable tools
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_disable",
  {
    title: "Disable Agent",
    description:
      "Take an agent offline. The agent stops receiving messages, won't match by name/channel/keyword, and active sessions are aborted. Survives restarts. Use agent_enable to bring them back.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to disable (e.g. 'sdr', 'marketing-manager')"),
    },
  },
  async ({ agent_id }) => {
    await configOverrides.updateOne(
      { agentId: agent_id },
      { $set: { disabled: true, updatedAt: new Date(), updatedBy: AGENT_ID } },
      { upsert: true },
    );

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: `${agent_id} is now offline. Active sessions aborted, no new messages will be routed. Use agent_enable to bring them back.`,
        },
      ],
    };
  },
);

server.registerTool(
  "agent_enable",
  {
    title: "Enable Agent",
    description: "Bring a disabled agent back online. They'll start receiving messages again on the next message.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to enable"),
    },
  },
  async ({ agent_id }) => {
    await configOverrides.updateOne(
      { agentId: agent_id },
      { $unset: { disabled: "" }, $set: { updatedAt: new Date() } },
    );

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: `${agent_id} is back online. Will receive messages on next routing.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Config override tools
// ---------------------------------------------------------------------------

const ARRAY_FIELDS = ["channels", "passiveChannels", "keywords", "servers"];
const SCALAR_FIELDS = ["isDefault", "budgetUsd", "maxTurns", "maxConcurrent", "timeoutMs"];
const ALL_CONFIG_FIELDS = [...ARRAY_FIELDS, ...SCALAR_FIELDS];

server.registerTool(
  "config_list",
  {
    title: "List Config Overrides",
    description: "Show all active runtime config overrides for agents (channels, keywords, budgets, etc.).",
    inputSchema: {},
  },
  async () => {
    const docs = await configOverrides.find().toArray();
    if (docs.length === 0) {
      return {
        content: [{ type: "text", text: "No config overrides active. All agents are using their template defaults." }],
      };
    }

    const lines = docs.map((d: any) => {
      const fields = ALL_CONFIG_FIELDS.filter((f) => d[f] !== undefined);
      const date = d.updatedAt instanceof Date ? d.updatedAt.toISOString() : String(d.updatedAt ?? "");
      const by = d.updatedBy ? ` (by ${d.updatedBy})` : "";
      return `${d.agentId}: ${fields.join(", ")}${by} — ${date}`;
    });

    return { content: [{ type: "text", text: `Active config overrides:\n${lines.join("\n")}` }] };
  },
);

server.registerTool(
  "config_get",
  {
    title: "Get Config Override",
    description: "Show the config override details for a specific agent.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID (e.g. 'executive-assistant')"),
    },
  },
  async ({ agent_id }) => {
    const doc = (await configOverrides.findOne({ agentId: agent_id })) as any;
    if (!doc) {
      return {
        content: [{ type: "text", text: `No config override found for ${agent_id} — using template defaults.` }],
      };
    }

    const lines: string[] = [];
    for (const field of ALL_CONFIG_FIELDS) {
      if (doc[field] === undefined) continue;
      const val = doc[field];
      if (ARRAY_FIELDS.includes(field)) {
        const parts: string[] = [];
        if (val.replace) parts.push(`replace: [${val.replace.join(", ")}]`);
        if (val.add?.length) parts.push(`add: [${val.add.join(", ")}]`);
        if (val.remove?.length) parts.push(`remove: [${val.remove.join(", ")}]`);
        lines.push(`${field}: ${parts.join(", ") || "(empty override)"}`);
      } else {
        lines.push(`${field}: ${val}`);
      }
    }

    const date = doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt ?? "");
    const by = doc.updatedBy ? ` (by ${doc.updatedBy})` : "";
    return {
      content: [{ type: "text", text: `Config override for ${agent_id}${by} — ${date}:\n${lines.join("\n")}` }],
    };
  },
);

server.registerTool(
  "config_set",
  {
    title: "Set Config Override",
    description:
      "Override a config field for an agent. For array fields (channels, passiveChannels, keywords, servers), value should be { replace?: string[], add?: string[], remove?: string[] }. For scalar fields (isDefault, budgetUsd, maxTurns, maxConcurrent, timeoutMs), value is the scalar.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID"),
      field: z.string().describe("The config field to override"),
      value: z.any().describe("The override value"),
    },
  },
  async ({ agent_id, field, value }) => {
    if (!ALL_CONFIG_FIELDS.includes(field)) {
      return {
        content: [{ type: "text", text: `Invalid field: ${field}. Valid fields: ${ALL_CONFIG_FIELDS.join(", ")}` }],
        isError: true,
      };
    }

    await configOverrides.updateOne(
      { agentId: agent_id },
      { $set: { [field]: value, updatedAt: new Date(), updatedBy: AGENT_ID } },
      { upsert: true },
    );

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: `Config override for ${agent_id}.${field} set to ${JSON.stringify(value)}. Hot-reload triggered.`,
        },
      ],
    };
  },
);

server.registerTool(
  "config_reset",
  {
    title: "Reset Config Override",
    description:
      "Remove a config override for an agent. If field is provided, only that field is removed. If no field, the entire override is deleted.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to reset"),
      field: z.string().optional().describe("Specific field to reset (omit to reset all)"),
    },
  },
  async ({ agent_id, field }) => {
    if (field) {
      if (!ALL_CONFIG_FIELDS.includes(field)) {
        return {
          content: [{ type: "text", text: `Invalid field: ${field}. Valid fields: ${ALL_CONFIG_FIELDS.join(", ")}` }],
          isError: true,
        };
      }
      await configOverrides.updateOne(
        { agentId: agent_id },
        { $unset: { [field]: "" }, $set: { updatedAt: new Date() } },
      );

      try {
        process.kill(process.ppid, "SIGUSR1");
      } catch {}

      return {
        content: [
          {
            type: "text",
            text: `Config override for ${agent_id}.${field} removed. Reverted to template default. Hot-reload triggered.`,
          },
        ],
      };
    }

    const result = await configOverrides.deleteOne({ agentId: agent_id });
    if (result.deletedCount === 0) {
      return {
        content: [
          { type: "text", text: `No config override found for ${agent_id} — already using template defaults.` },
        ],
      };
    }

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: `All config overrides removed for ${agent_id}. Reverted to template defaults. Hot-reload triggered.`,
        },
      ],
    };
  },
);

server.registerTool(
  "config_add",
  {
    title: "Add to Array Config",
    description:
      "Add values to an array config field (channels, passiveChannels, keywords, servers). Convenience tool that handles merge logic automatically.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID"),
      field: z.string().describe("The array field (channels, passiveChannels, keywords, servers)"),
      values: z.array(z.string()).describe("Values to add"),
    },
  },
  async ({ agent_id, field, values }) => {
    if (!ARRAY_FIELDS.includes(field)) {
      return {
        content: [
          { type: "text", text: `Invalid array field: ${field}. Valid array fields: ${ARRAY_FIELDS.join(", ")}` },
        ],
        isError: true,
      };
    }

    const doc = (await configOverrides.findOne({ agentId: agent_id })) as any;
    const existing = doc?.[field] ?? {};

    if (existing.replace) {
      // Replace mode: add values to the replace array (deduped)
      const merged = [...new Set([...(existing.replace as string[]), ...values])];
      existing.replace = merged;
    } else {
      // Add/remove mode: merge into add, remove from remove
      const addSet = new Set([...(existing.add ?? []), ...values]);
      existing.add = [...addSet];
      if (existing.remove?.length) {
        existing.remove = existing.remove.filter((v: string) => !values.includes(v));
        if (existing.remove.length === 0) delete existing.remove;
      }
    }

    await configOverrides.updateOne(
      { agentId: agent_id },
      { $set: { [field]: existing, updatedAt: new Date(), updatedBy: AGENT_ID } },
      { upsert: true },
    );

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: `Added [${values.join(", ")}] to ${agent_id}.${field}. Override is now: ${JSON.stringify(existing)}. Hot-reload triggered.`,
        },
      ],
    };
  },
);

server.registerTool(
  "config_remove",
  {
    title: "Remove from Array Config",
    description:
      "Remove values from an array config field (channels, passiveChannels, keywords, servers). Convenience tool that handles merge logic automatically.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID"),
      field: z.string().describe("The array field (channels, passiveChannels, keywords, servers)"),
      values: z.array(z.string()).describe("Values to remove"),
    },
  },
  async ({ agent_id, field, values }) => {
    if (!ARRAY_FIELDS.includes(field)) {
      return {
        content: [
          { type: "text", text: `Invalid array field: ${field}. Valid array fields: ${ARRAY_FIELDS.join(", ")}` },
        ],
        isError: true,
      };
    }

    const doc = (await configOverrides.findOne({ agentId: agent_id })) as any;
    const existing = doc?.[field] ?? {};

    if (existing.replace) {
      // Replace mode: filter values out of the replace array
      existing.replace = (existing.replace as string[]).filter((v: string) => !values.includes(v));
    } else {
      // Add/remove mode: merge into remove, remove from add
      const removeSet = new Set([...(existing.remove ?? []), ...values]);
      existing.remove = [...removeSet];
      if (existing.add?.length) {
        existing.add = existing.add.filter((v: string) => !values.includes(v));
        if (existing.add.length === 0) delete existing.add;
      }
    }

    await configOverrides.updateOne(
      { agentId: agent_id },
      { $set: { [field]: existing, updatedAt: new Date(), updatedBy: AGENT_ID } },
      { upsert: true },
    );

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: `Removed [${values.join(", ")}] from ${agent_id}.${field}. Override is now: ${JSON.stringify(existing)}. Hot-reload triggered.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Prompt override tools (soul + system prompt)
// ---------------------------------------------------------------------------

server.registerTool(
  "prompt_get",
  {
    title: "Get Agent Prompt",
    description:
      "Show the current soul and/or system prompt override for an agent. If no override exists, the agent is using the file-based default.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID (e.g. 'vp-engineering')"),
    },
  },
  async ({ agent_id }) => {
    const doc = (await promptOverrides.findOne({ agentId: agent_id })) as any;
    if (!doc) {
      return {
        content: [
          {
            type: "text",
            text: `No prompt override for ${agent_id} — using file defaults from agents/${agent_id}/soul.md and system-prompt.md.`,
          },
        ],
      };
    }

    const date = doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt ?? "");
    const by = doc.updatedBy ? ` (by ${doc.updatedBy})` : "";
    const parts: string[] = [`Prompt override for ${agent_id}${by} — ${date}:\n`];

    if (doc.soul !== undefined) {
      parts.push(`=== SOUL ===\n${doc.soul}\n`);
    }
    if (doc.systemPrompt !== undefined) {
      parts.push(`=== SYSTEM PROMPT ===\n${doc.systemPrompt}\n`);
    }

    return { content: [{ type: "text", text: parts.join("\n") }] };
  },
);

server.registerTool(
  "prompt_set",
  {
    title: "Set Agent Prompt",
    description:
      "Override an agent's soul and/or system prompt. These take effect on next hot-reload (immediate — no rebuild/redeploy needed). Pass only the fields you want to override; omitted fields keep using the file default.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID (e.g. 'vp-engineering')"),
      soul: z
        .string()
        .optional()
        .describe("New soul.md content (personality, voice, values). Omit to leave unchanged."),
      system_prompt: z
        .string()
        .optional()
        .describe("New system-prompt.md content (role, tools, guardrails). Omit to leave unchanged."),
    },
  },
  async ({ agent_id, soul, system_prompt }) => {
    if (soul === undefined && system_prompt === undefined) {
      return {
        content: [{ type: "text", text: "Nothing to set — provide at least one of soul or system_prompt." }],
        isError: true,
      };
    }

    const update: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedBy: AGENT_ID,
    };
    if (soul !== undefined) update.soul = soul;
    if (system_prompt !== undefined) update.systemPrompt = system_prompt;

    await promptOverrides.updateOne({ agentId: agent_id }, { $set: update }, { upsert: true });

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    const fields = [...(soul !== undefined ? ["soul"] : []), ...(system_prompt !== undefined ? ["systemPrompt"] : [])];

    return {
      content: [
        {
          type: "text",
          text: `Prompt override for ${agent_id} set: ${fields.join(", ")}. Hot-reload triggered — takes effect on next message.`,
        },
      ],
    };
  },
);

server.registerTool(
  "prompt_reset",
  {
    title: "Reset Agent Prompt",
    description:
      "Remove prompt overrides for an agent, reverting to the file-based defaults. If field is provided ('soul' or 'systemPrompt'), only that field is reset. If no field, both are reset.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to reset"),
      field: z.enum(["soul", "systemPrompt"]).optional().describe("Specific field to reset (omit to reset both)"),
    },
  },
  async ({ agent_id, field }) => {
    if (field) {
      await promptOverrides.updateOne(
        { agentId: agent_id },
        { $unset: { [field]: "" }, $set: { updatedAt: new Date() } },
      );

      try {
        process.kill(process.ppid, "SIGUSR1");
      } catch {}

      return {
        content: [
          {
            type: "text",
            text: `Prompt override for ${agent_id}.${field} removed. Reverted to file default. Hot-reload triggered.`,
          },
        ],
      };
    }

    const result = await promptOverrides.deleteOne({ agentId: agent_id });
    if (result.deletedCount === 0) {
      return {
        content: [{ type: "text", text: `No prompt override found for ${agent_id} — already using file defaults.` }],
      };
    }

    try {
      process.kill(process.ppid, "SIGUSR1");
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: `All prompt overrides removed for ${agent_id}. Reverted to file defaults. Hot-reload triggered.`,
        },
      ],
    };
  },
);

// Cleanup on exit
process.on("SIGTERM", () => client.close());
process.on("SIGINT", () => client.close());

const transport = new StdioServerTransport();
await server.connect(transport);
