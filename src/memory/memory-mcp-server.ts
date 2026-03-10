#!/usr/bin/env node

/**
 * Memory MCP Server — runs as a stdio subprocess inside each agent's Claude Code session.
 * Gives agents the ability to read, write, and list their own memory files in MongoDB.
 *
 * Env vars:
 *   AGENT_ID     — the agent's ID (e.g. "chief-of-staff")
 *   MONGODB_URI  — MongoDB connection string
 *   MONGODB_DB   — database name (default: "hive")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";

const AGENT_ID = process.env.AGENT_ID ?? "";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";

if (!AGENT_ID) {
  process.stderr.write("memory-mcp-server: AGENT_ID is required\n");
  process.exit(1);
}

// Agents can access their own directory and shared/
const ALLOWED_PREFIXES = [`agents/${AGENT_ID}/`, "shared/"];

function isAllowed(path: string): boolean {
  if (path.includes("..")) return false;
  return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const collection = db.collection("memory");
const versions = db.collection("memory_versions");

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const server = new McpServer({
  name: "hive-memory",
  version: "0.2.0",
});

server.registerTool(
  "memory_read",
  {
    title: "Read Memory",
    description: `Read a file from your memory. Your files are under "agents/${AGENT_ID}/". Shared files are under "shared/".`,
    inputSchema: {
      path: z.string().describe('Relative path, e.g. "agents/' + AGENT_ID + '/memory.md" or "shared/contacts.md"'),
    },
  },
  async ({ path }) => {
    if (!isAllowed(path)) {
      return {
        content: [{ type: "text", text: `Access denied: you can only access agents/${AGENT_ID}/ and shared/` }],
        isError: true,
      };
    }

    const doc = await collection.findOne({ path });
    if (!doc) {
      return { content: [{ type: "text", text: `File not found: ${path}` }], isError: true };
    }
    return { content: [{ type: "text", text: doc.content }] };
  },
);

server.registerTool(
  "memory_write",
  {
    title: "Write Memory",
    description: `Write content to a memory file. Your files are under "agents/${AGENT_ID}/".`,
    inputSchema: {
      path: z.string().describe('Relative path, e.g. "agents/' + AGENT_ID + '/memory.md"'),
      content: z.string().describe("The full content to write to the file"),
    },
  },
  async ({ path, content }) => {
    if (!isAllowed(path)) {
      return {
        content: [{ type: "text", text: `Access denied: you can only write to agents/${AGENT_ID}/ and shared/` }],
        isError: true,
      };
    }

    // Save previous version before overwriting
    const existing = await collection.findOne({ path });
    if (existing) {
      await versions.insertOne({
        path,
        content: existing.content,
        savedAt: existing.updatedAt,
        savedBy: existing.updatedBy,
      });
    }

    await collection.updateOne(
      { path },
      { $set: { content, updatedAt: new Date(), updatedBy: AGENT_ID } },
      { upsert: true },
    );

    return { content: [{ type: "text", text: `Written: ${path}` }] };
  },
);

server.registerTool(
  "memory_list",
  {
    title: "List Memory Files",
    description: `List files in a memory directory. Defaults to your own agent directory.`,
    inputSchema: {
      path: z.string().optional().describe(`Directory to list, defaults to "agents/${AGENT_ID}/"`),
    },
  },
  async ({ path }) => {
    const dir = path || `agents/${AGENT_ID}/`;
    const prefix = dir.endsWith("/") ? dir : dir + "/";

    if (!isAllowed(prefix)) {
      return {
        content: [{ type: "text", text: `Access denied: you can only list agents/${AGENT_ID}/ and shared/` }],
        isError: true,
      };
    }

    const docs = await collection
      .find({ path: { $regex: `^${escapeRegex(prefix)}` } })
      .project({ path: 1 })
      .toArray();

    if (docs.length === 0) {
      return { content: [{ type: "text", text: "(empty directory)" }] };
    }

    const names = docs.map((d: any) => d.path.slice(prefix.length));
    return { content: [{ type: "text", text: names.join("\n") }] };
  },
);

server.registerTool(
  "memory_history",
  {
    title: "View Memory History",
    description: `View previous versions of a memory file. Shows timestamps and who made each change.`,
    inputSchema: {
      path: z.string().describe("File path to view history for"),
      limit: z.number().optional().describe("Max versions to return (default 10)"),
    },
  },
  async ({ path, limit }) => {
    if (!isAllowed(path)) {
      return {
        content: [{ type: "text", text: `Access denied: you can only access agents/${AGENT_ID}/ and shared/` }],
        isError: true,
      };
    }

    const history = await versions
      .find({ path })
      .sort({ savedAt: -1 })
      .limit(limit ?? 10)
      .toArray();

    if (history.length === 0) {
      return { content: [{ type: "text", text: `No version history for: ${path}` }] };
    }

    const lines = history.map((v: any, i: number) => {
      const date = v.savedAt instanceof Date ? v.savedAt.toISOString() : String(v.savedAt);
      const by = v.savedBy ? ` by ${v.savedBy}` : "";
      const preview = v.content.slice(0, 100).replace(/\n/g, " ");
      return `[${i}] ${date}${by} (${v.content.length} chars)\n    ${preview}...`;
    });

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  },
);

server.registerTool(
  "memory_rollback",
  {
    title: "Rollback Memory File",
    description: `Restore a memory file to a previous version. Use memory_history first to find the version index.`,
    inputSchema: {
      path: z.string().describe("File path to rollback"),
      version_index: z.number().describe("Version index from memory_history (0 = most recent previous version)"),
    },
  },
  async ({ path, version_index }) => {
    if (!isAllowed(path)) {
      return {
        content: [{ type: "text", text: `Access denied: you can only access agents/${AGENT_ID}/ and shared/` }],
        isError: true,
      };
    }

    const history = await versions.find({ path }).sort({ savedAt: -1 }).skip(version_index).limit(1).toArray();

    if (history.length === 0) {
      return { content: [{ type: "text", text: `Version ${version_index} not found for: ${path}` }], isError: true };
    }

    const target = history[0];

    // Save current version to history before rolling back
    const current = await collection.findOne({ path });
    if (current) {
      await versions.insertOne({
        path,
        content: current.content,
        savedAt: current.updatedAt,
        savedBy: current.updatedBy,
      });
    }

    await collection.updateOne(
      { path },
      { $set: { content: target.content, updatedAt: new Date(), updatedBy: `${AGENT_ID}:rollback` } },
      { upsert: true },
    );

    const date = target.savedAt instanceof Date ? target.savedAt.toISOString() : String(target.savedAt);
    return { content: [{ type: "text", text: `Rolled back ${path} to version from ${date}` }] };
  },
);

// Cleanup on exit
process.on("SIGTERM", () => client.close());
process.on("SIGINT", () => client.close());

// Connect and run
const transport = new StdioServerTransport();
await server.connect(transport);
