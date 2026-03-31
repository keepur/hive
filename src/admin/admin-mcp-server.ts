#!/usr/bin/env node

/**
 * Admin MCP Server — agent definition CRUD + version history.
 * Operates on `agent_definitions` and `agent_definition_versions` collections.
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
import type { AgentDefinition, AgentDefinitionVersion } from "../types/agent-definition.js";
import { AGENT_DEFINITION_DEFAULTS } from "../types/agent-definition.js";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const AGENT_ID = process.env.AGENT_ID ?? "admin";

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const agentDefs = db.collection<AgentDefinition>("agent_definitions");
const agentVersions = db.collection<AgentDefinitionVersion>("agent_definition_versions");

await agentVersions.createIndex({ agentId: 1, createdAt: -1 });

const server = new McpServer({ name: "hive-admin", version: "0.2.0" });

async function saveVersion(agentId: string, changedFields: string[]): Promise<void> {
  const current = await agentDefs.findOne({ _id: agentId as any });
  if (!current) return;
  await agentVersions.insertOne({
    agentId,
    snapshot: current as unknown as AgentDefinition,
    changedFields,
    createdAt: new Date(),
  });
}

function triggerReload(): void {
  try {
    process.kill(process.ppid, "SIGUSR1");
  } catch {}
}

// ---------------------------------------------------------------------------
// agent_list
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_list",
  {
    title: "List Agents",
    description: "List all agent definitions with summary info (id, name, model, channels, disabled status).",
    inputSchema: {},
  },
  async () => {
    const docs = await agentDefs.find().toArray();
    if (docs.length === 0) {
      return { content: [{ type: "text", text: "No agent definitions found." }] };
    }

    const lines = docs.map((d) => {
      const status = d.disabled ? " [DISABLED]" : "";
      const channels = (d.channels ?? []).join(", ") || "(none)";
      return `${d._id}: ${d.name} | model=${d.model} | channels=[${channels}]${status}`;
    });

    return { content: [{ type: "text", text: `Agents (${docs.length}):\n${lines.join("\n")}` }] };
  },
);

// ---------------------------------------------------------------------------
// agent_get
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_get",
  {
    title: "Get Agent Definition",
    description: "Get the full definition for an agent, formatted for readability.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID (e.g. 'rae', 'jasper')"),
    },
  },
  async ({ agent_id }) => {
    const doc = await agentDefs.findOne({ _id: agent_id as any });
    if (!doc) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    const lines: string[] = [`Agent: ${doc._id}`, `Name: ${doc.name}`, `Icon: ${doc.icon || "(none)"}`];
    lines.push(`Model: ${doc.model}`);
    if (doc.triageModel) lines.push(`Triage Model: ${doc.triageModel}`);
    lines.push(`Channels: [${(doc.channels ?? []).join(", ")}]`);
    lines.push(`Passive Channels: [${(doc.passiveChannels ?? []).join(", ")}]`);
    lines.push(`Keywords: [${(doc.keywords ?? []).join(", ")}]`);
    lines.push(`Is Default: ${doc.isDefault ?? false}`);
    lines.push(`Core Servers: [${(doc.coreServers ?? []).join(", ")}]`);
    lines.push(`Delegate Servers: [${(doc.delegateServers ?? []).join(", ")}]`);
    if (doc.plugins?.length) lines.push(`Plugins: [${doc.plugins.join(", ")}]`);
    if (doc.dodiOpsMode) lines.push(`Dodi Ops Mode: ${doc.dodiOpsMode}`);
    lines.push(`Schedule: ${JSON.stringify(doc.schedule ?? [])}`);
    if (doc.subscribe?.length) lines.push(`Subscribe: [${doc.subscribe.join(", ")}]`);
    lines.push(`Budget: $${doc.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd}`);
    lines.push(`Max Turns: ${doc.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns}`);
    lines.push(`Max Concurrent: ${doc.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent}`);
    lines.push(`Timeout: ${doc.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs}ms`);
    lines.push(`Disabled: ${doc.disabled ?? false}`);
    if (doc.slackBot) lines.push(`Slack Bot: ${doc.slackBot}`);
    lines.push(`\n--- Soul ---\n${doc.soul ?? "(not set)"}`);
    lines.push(`\n--- System Prompt ---\n${doc.systemPrompt ?? "(not set)"}`);
    const updatedAt = doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt ?? "");
    lines.push(`\nUpdated: ${updatedAt} by ${doc.updatedBy ?? "unknown"}`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ---------------------------------------------------------------------------
// agent_create
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_create",
  {
    title: "Create Agent",
    description:
      "Create a new agent definition. Required: _id, name, model. Optional fields get sensible defaults. Must also provide soul and systemPrompt (or they default to empty strings).",
    inputSchema: {
      _id: z.string().describe("Agent ID (lowercase with hyphens, e.g. 'my-agent')"),
      name: z.string().describe("Display name for the agent"),
      model: z.string().describe("Model to use (e.g. 'claude-sonnet-4-6', 'claude-haiku-4-5')"),
      fields: z
        .record(z.string(), z.any())
        .optional()
        .describe("Additional fields to set (channels, soul, systemPrompt, servers, etc.)"),
    },
  },
  async ({ _id, name, model, fields }) => {
    const existing = await agentDefs.findOne({ _id: _id as any });
    if (existing) {
      return {
        content: [{ type: "text", text: `Agent '${_id}' already exists. Use agent_update to modify it.` }],
        isError: true,
      };
    }

    const now = new Date();
    const doc: AgentDefinition = {
      _id,
      name,
      model,
      icon: AGENT_DEFINITION_DEFAULTS.icon,
      channels: [],
      passiveChannels: [...AGENT_DEFINITION_DEFAULTS.passiveChannels],
      keywords: [...AGENT_DEFINITION_DEFAULTS.keywords],
      isDefault: false,
      coreServers: [],
      delegateServers: [],
      delegatePrompts: { ...AGENT_DEFINITION_DEFAULTS.delegatePrompts },
      soul: "",
      systemPrompt: "",
      schedule: [...AGENT_DEFINITION_DEFAULTS.schedule],
      budgetUsd: AGENT_DEFINITION_DEFAULTS.budgetUsd,
      maxTurns: AGENT_DEFINITION_DEFAULTS.maxTurns,
      maxConcurrent: AGENT_DEFINITION_DEFAULTS.maxConcurrent,
      timeoutMs: AGENT_DEFINITION_DEFAULTS.timeoutMs,
      disabled: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: AGENT_ID,
      ...(fields ?? {}),
    };

    await agentDefs.insertOne(doc as any);
    triggerReload();

    return {
      content: [{ type: "text", text: `Agent '${_id}' (${name}) created with model ${model}. Reload triggered.` }],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_update
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_update",
  {
    title: "Update Agent",
    description:
      "Update fields on an existing agent definition. Saves a version snapshot before mutation. Cannot change _id.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to update"),
      fields: z.record(z.string(), z.any()).describe("Fields to update (e.g. { model: 'claude-sonnet-4-6', channels: ['general'] })"),
    },
  },
  async ({ agent_id, fields }) => {
    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    if ("_id" in fields) {
      return {
        content: [{ type: "text", text: "Cannot change _id. Create a new agent instead." }],
        isError: true,
      };
    }

    const changedFields = Object.keys(fields);
    await saveVersion(agent_id, changedFields);

    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { ...fields, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    triggerReload();

    return {
      content: [
        {
          type: "text",
          text: `Agent '${agent_id}' updated: ${changedFields.join(", ")}. Version saved. Reload triggered.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_delete
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_delete",
  {
    title: "Delete Agent",
    description: "Delete an agent definition. Saves a version snapshot before deletion. Requires confirm=true.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to delete"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
  },
  async ({ agent_id, confirm }) => {
    if (!confirm) {
      return {
        content: [{ type: "text", text: "Deletion not confirmed. Set confirm=true to proceed." }],
        isError: true,
      };
    }

    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    await saveVersion(agent_id, ["DELETED"]);
    await agentDefs.deleteOne({ _id: agent_id as any });
    triggerReload();

    return {
      content: [{ type: "text", text: `Agent '${agent_id}' deleted. Version snapshot saved. Reload triggered.` }],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_enable
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_enable",
  {
    title: "Enable Agent",
    description: "Bring a disabled agent back online (sets disabled=false).",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to enable"),
    },
  },
  async ({ agent_id }) => {
    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    await saveVersion(agent_id, ["disabled"]);
    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { disabled: false, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );
    triggerReload();

    return {
      content: [{ type: "text", text: `Agent '${agent_id}' enabled. Version saved. Reload triggered.` }],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_disable
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_disable",
  {
    title: "Disable Agent",
    description:
      "Take an agent offline (sets disabled=true). The agent stops receiving messages and active sessions are aborted.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to disable"),
    },
  },
  async ({ agent_id }) => {
    const existing = await agentDefs.findOne({ _id: agent_id as any });
    if (!existing) {
      return {
        content: [{ type: "text", text: `Agent '${agent_id}' not found.` }],
        isError: true,
      };
    }

    await saveVersion(agent_id, ["disabled"]);
    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { disabled: true, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );
    triggerReload();

    return {
      content: [{ type: "text", text: `Agent '${agent_id}' disabled. Version saved. Reload triggered.` }],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_history
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_history",
  {
    title: "Agent Version History",
    description: "List version history for an agent definition, sorted newest first.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID"),
      limit: z.number().optional().describe("Max entries to return (default 10)"),
    },
  },
  async ({ agent_id, limit }) => {
    const maxEntries = limit ?? 10;
    const versions = await agentVersions
      .find({ agentId: agent_id })
      .sort({ createdAt: -1 })
      .limit(maxEntries)
      .toArray();

    if (versions.length === 0) {
      return { content: [{ type: "text", text: `No version history for '${agent_id}'.` }] };
    }

    const lines = versions.map((v, i) => {
      const date = v.createdAt instanceof Date ? v.createdAt.toISOString() : String(v.createdAt);
      const fields = v.changedFields.join(", ");
      const by = v.snapshot?.updatedBy ? ` (by ${v.snapshot.updatedBy})` : "";
      return `[${i}] ${date} — changed: ${fields}${by}`;
    });

    return {
      content: [{ type: "text", text: `Version history for '${agent_id}' (${versions.length} entries):\n${lines.join("\n")}` }],
    };
  },
);

// ---------------------------------------------------------------------------
// agent_rollback
// ---------------------------------------------------------------------------

server.registerTool(
  "agent_rollback",
  {
    title: "Rollback Agent",
    description:
      "Rollback an agent definition to a previous version. Saves current state first, then replaces with the snapshot. Use agent_history to see available versions.",
    inputSchema: {
      agent_id: z.string().describe("The agent ID to rollback"),
      version_index: z.number().describe("Version index from agent_history (0 = most recent version)"),
    },
  },
  async ({ agent_id, version_index }) => {
    const versions = await agentVersions
      .find({ agentId: agent_id })
      .sort({ createdAt: -1 })
      .limit(version_index + 1)
      .toArray();

    if (versions.length <= version_index) {
      return {
        content: [
          {
            type: "text",
            text: `Version index ${version_index} not found for '${agent_id}'. Only ${versions.length} versions available.`,
          },
        ],
        isError: true,
      };
    }

    const target = versions[version_index];

    // Save current state before rollback
    await saveVersion(agent_id, ["ROLLBACK"]);

    // Replace with snapshot
    const { _id, ...snapshotFields } = target.snapshot;
    await agentDefs.updateOne(
      { _id: agent_id as any },
      { $set: { ...snapshotFields, updatedAt: new Date(), updatedBy: AGENT_ID } },
    );

    triggerReload();

    const date = target.createdAt instanceof Date ? target.createdAt.toISOString() : String(target.createdAt);
    return {
      content: [
        {
          type: "text",
          text: `Agent '${agent_id}' rolled back to version from ${date}. Current state saved first. Reload triggered.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Cleanup + transport
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => client.close());
process.on("SIGINT", () => client.close());

const transport = new StdioServerTransport();
await server.connect(transport);
