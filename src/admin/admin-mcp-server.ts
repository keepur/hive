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

// Cleanup on exit
process.on("SIGTERM", () => client.close());
process.on("SIGINT", () => client.close());

const transport = new StdioServerTransport();
await server.connect(transport);
