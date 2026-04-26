#!/usr/bin/env node

/**
 * Memory MCP Server — runs as a stdio subprocess inside each agent's Claude Code session.
 * Gives agents the ability to read, write, and list their own memory files in MongoDB.
 *
 * Env vars:
 *   AGENT_ID     — the agent's ID (e.g. "mokie")
 *   MONGODB_URI  — MongoDB connection string
 *   MONGODB_DB   — database name (default: "hive")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";
import { parseScopesEnv, ScopeRouter } from "./memory-scope.js";

const AGENT_ID = process.env.AGENT_ID ?? "";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";

if (!AGENT_ID) {
  process.stderr.write("memory-mcp-server: AGENT_ID is required\n");
  process.exit(1);
}

// Agents can access their own directory and shared/ (self / Mongo scope only)
const ALLOWED_PREFIXES = [`agents/${AGENT_ID}/`, "shared/"];

function isAllowed(path: string): boolean {
  if (path.includes("..")) return false;
  return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

// Parse MEMORY_SCOPES_JSON — never crash the subprocess if it's malformed;
// fall back to legacy self-only behavior instead.
let router: ScopeRouter;
try {
  router = new ScopeRouter(parseScopesEnv(process.env.MEMORY_SCOPES_JSON));
} catch (err) {
  process.stderr.write(`memory-mcp-server: invalid MEMORY_SCOPES_JSON, falling back to self-only: ${String(err)}\n`);
  router = new ScopeRouter([]);
}

const scopeListDescription = ["self", ...router.scopeIds().filter((s) => s !== "self")].join(", ");

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
    description: `Read a file from your memory. Defaults to self (your Mongo memory under "agents/${AGENT_ID}/" and "shared/"). Filesystem scopes available: ${scopeListDescription}.`,
    inputSchema: {
      path: z
        .string()
        .describe(
          `Path. For scope=self: "agents/${AGENT_ID}/foo.md" or "shared/contacts.md". For filesystem scopes: filename relative to the scope dir.`,
        ),
      scope: z
        .string()
        .optional()
        .describe(`Scope id. Defaults to "self". Valid scopes on this agent: ${scopeListDescription}`),
    },
  },
  async ({ path, scope }) => {
    try {
      if (!scope || scope === "self") {
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
      }
      const decl = router.get(scope);
      if (!decl) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown scope: ${scope}. Valid: ${scopeListDescription}`,
            },
          ],
          isError: true,
        };
      }
      if (decl.backing === "mongo") {
        return {
          content: [{ type: "text", text: `Mongo scope ${scope} has no read mapping` }],
          isError: true,
        };
      }
      const store = router.requireFs(scope);
      const body = store.read(path);
      if (body === null) {
        return { content: [{ type: "text", text: `File not found: ${scope}:${path}` }], isError: true };
      }
      return { content: [{ type: "text", text: body }] };
    } catch (err) {
      return { content: [{ type: "text", text: `memory_read error: ${String(err)}` }], isError: true };
    }
  },
);

server.registerTool(
  "memory_write",
  {
    title: "Write Memory",
    description: `Write content to a memory file. Defaults to self (Mongo, "agents/${AGENT_ID}/"). Filesystem scopes available: ${scopeListDescription}.`,
    inputSchema: {
      path: z
        .string()
        .describe(
          `Path. For scope=self: "agents/${AGENT_ID}/foo.md". For filesystem scopes: filename relative to the scope dir.`,
        ),
      content: z.string().describe("The full content to write to the file"),
      scope: z
        .string()
        .optional()
        .describe(`Scope id. Defaults to "self". Valid scopes on this agent: ${scopeListDescription}`),
    },
  },
  async ({ path, content, scope }) => {
    try {
      if (!scope || scope === "self") {
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
      }

      const decl = router.get(scope);
      if (!decl) {
        return {
          content: [{ type: "text", text: `Unknown scope: ${scope}. Valid: ${scopeListDescription}` }],
          isError: true,
        };
      }
      if (decl.backing === "mongo") {
        return {
          content: [{ type: "text", text: `Mongo scope ${scope} has no write mapping` }],
          isError: true,
        };
      }
      const store = router.requireFs(scope);
      const indexLine = `- [${path.replace(/\.md$/, "")}](${path}) — (updated by ${AGENT_ID})`;
      store.write(path, content, indexLine);
      return { content: [{ type: "text", text: `Written: ${scope}:${path}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `memory_write error: ${String(err)}` }], isError: true };
    }
  },
);

server.registerTool(
  "memory_list",
  {
    title: "List Memory Files",
    description: `List files in a memory directory. Defaults to self (your Mongo agent directory). Filesystem scopes available: ${scopeListDescription}.`,
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe(
          `Directory to list (self scope only), defaults to "agents/${AGENT_ID}/". Ignored for filesystem scopes.`,
        ),
      scope: z
        .string()
        .optional()
        .describe(`Scope id. Defaults to "self". Valid scopes on this agent: ${scopeListDescription}`),
    },
  },
  async ({ path, scope }) => {
    try {
      if (!scope || scope === "self") {
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

        const names = docs.map((d) => String(d.path).slice(prefix.length));
        return { content: [{ type: "text", text: names.join("\n") }] };
      }

      const decl = router.get(scope);
      if (!decl) {
        return {
          content: [{ type: "text", text: `Unknown scope: ${scope}. Valid: ${scopeListDescription}` }],
          isError: true,
        };
      }
      if (decl.backing === "mongo") {
        return {
          content: [{ type: "text", text: `Mongo scope ${scope} has no list mapping` }],
          isError: true,
        };
      }
      const store = router.requireFs(scope);
      const files = store.list();
      if (files.length === 0) {
        return { content: [{ type: "text", text: "(empty directory)" }] };
      }
      return { content: [{ type: "text", text: files.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `memory_list error: ${String(err)}` }], isError: true };
    }
  },
);

server.registerTool(
  "memory_history",
  {
    title: "View Memory History",
    description: `View previous versions of a memory file. Self scope only.`,
    inputSchema: {
      path: z.string().describe("File path to view history for"),
      limit: z.number().optional().describe("Max versions to return (default 10)"),
      scope: z.string().optional().describe(`Scope id. Defaults to "self". Only "self" is supported for history.`),
    },
  },
  async ({ path, limit, scope }) => {
    try {
      if (scope && scope !== "self") {
        return {
          content: [
            {
              type: "text",
              text: "history/rollback not supported for filesystem scopes — use git or equivalent",
            },
          ],
          isError: true,
        };
      }
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

      const lines = history.map((v, i) => {
        const savedAt = v.savedAt as unknown;
        const date = savedAt instanceof Date ? savedAt.toISOString() : String(savedAt);
        const by = v.savedBy ? ` by ${String(v.savedBy)}` : "";
        const body = typeof v.content === "string" ? v.content : String(v.content ?? "");
        const preview = body.slice(0, 100).replace(/\n/g, " ");
        return `[${i}] ${date}${by} (${body.length} chars)\n    ${preview}...`;
      });

      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `memory_history error: ${String(err)}` }], isError: true };
    }
  },
);

server.registerTool(
  "memory_rollback",
  {
    title: "Rollback Memory File",
    description: `Restore a memory file to a previous version. Self scope only. Use memory_history first to find the version index.`,
    inputSchema: {
      path: z.string().describe("File path to rollback"),
      version_index: z.number().describe("Version index from memory_history (0 = most recent previous version)"),
      scope: z.string().optional().describe(`Scope id. Defaults to "self". Only "self" is supported for rollback.`),
    },
  },
  async ({ path, version_index, scope }) => {
    try {
      if (scope && scope !== "self") {
        return {
          content: [
            {
              type: "text",
              text: "history/rollback not supported for filesystem scopes — use git or equivalent",
            },
          ],
          isError: true,
        };
      }
      if (!isAllowed(path)) {
        return {
          content: [{ type: "text", text: `Access denied: you can only access agents/${AGENT_ID}/ and shared/` }],
          isError: true,
        };
      }

      const history = await versions.find({ path }).sort({ savedAt: -1 }).skip(version_index).limit(1).toArray();

      if (history.length === 0) {
        return {
          content: [{ type: "text", text: `Version ${version_index} not found for: ${path}` }],
          isError: true,
        };
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

      const savedAt = target.savedAt as unknown;
      const date = savedAt instanceof Date ? savedAt.toISOString() : String(savedAt);
      return { content: [{ type: "text", text: `Rolled back ${path} to version from ${date}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `memory_rollback error: ${String(err)}` }], isError: true };
    }
  },
);

// Cleanup on exit
process.on("SIGTERM", () => client.close());
process.on("SIGINT", () => client.close());

// Connect and run
const transport = new StdioServerTransport();
await server.connect(transport);
