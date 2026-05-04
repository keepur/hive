/**
 * Memory MCP Server — exposes read/write/list/history/rollback over an agent's
 * own MongoDB-backed memory plus optional filesystem-backed scopes.
 *
 * KPR-122 port: in-process via `createSdkMcpServer`. Tool handlers close over
 * the shared engine `Db` instead of opening a per-subprocess MongoClient. The
 * stdio shim at the bottom of this file is preserved for the bundled-server
 * fallback path used by the publish-ready artifact.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Db } from "mongodb";
import { ScopeRouter, type ScopeList } from "./memory-scope.js";

export interface MemoryToolDeps {
  db: Db;
  agentId: string;
  /**
   * Filesystem-backed scopes (the engine's archetype layer adds these); the
   * always-present "self" Mongo scope is implicit and does not need to appear
   * in this list.
   */
  memoryScopes: ScopeList;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildMemoryTools(deps: MemoryToolDeps) {
  const { db, agentId } = deps;
  const collection = db.collection("memory");
  const versions = db.collection("memory_versions");

  const ALLOWED_PREFIXES = [`agents/${agentId}/`, "shared/"];
  function isAllowed(path: string): boolean {
    if (path.includes("..")) return false;
    return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
  }

  // Filesystem scopes only — "self" stays implicit and is not part of the router.
  const fsScopes = (deps.memoryScopes ?? []).filter((s) => s.id !== "self");
  const router = new ScopeRouter(fsScopes);
  const scopeListDescription = ["self", ...router.scopeIds().filter((s) => s !== "self")].join(", ");

  return [
    tool(
      "memory_read",
      `Read a file from your memory. Defaults to self (your Mongo memory under "agents/${agentId}/" and "shared/"). Filesystem scopes available: ${scopeListDescription}.`,
      {
        path: z
          .string()
          .describe(
            `Path. For scope=self: "agents/${agentId}/foo.md" or "shared/contacts.md". For filesystem scopes: filename relative to the scope dir.`,
          ),
        scope: z
          .string()
          .optional()
          .describe(`Scope id. Defaults to "self". Valid scopes on this agent: ${scopeListDescription}`),
      },
      async ({ path, scope }) => {
        try {
          if (!scope || scope === "self") {
            if (!isAllowed(path)) {
              return {
                isError: true,
                content: [{ type: "text", text: `Access denied: you can only access agents/${agentId}/ and shared/` }],
              };
            }
            const doc = await collection.findOne({ path });
            if (!doc) {
              return { isError: true, content: [{ type: "text", text: `File not found: ${path}` }] };
            }
            return { content: [{ type: "text", text: String(doc.content ?? "") }] };
          }
          const decl = router.get(scope);
          if (!decl) {
            return {
              isError: true,
              content: [{ type: "text", text: `Unknown scope: ${scope}. Valid: ${scopeListDescription}` }],
            };
          }
          if (decl.backing === "mongo") {
            return {
              isError: true,
              content: [{ type: "text", text: `Mongo scope ${scope} has no read mapping` }],
            };
          }
          const store = router.requireFs(scope);
          const body = store.read(path);
          if (body === null) {
            return { isError: true, content: [{ type: "text", text: `File not found: ${scope}:${path}` }] };
          }
          return { content: [{ type: "text", text: body }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_read error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_write",
      `Write content to a memory file. Defaults to self (Mongo, "agents/${agentId}/"). Filesystem scopes available: ${scopeListDescription}.`,
      {
        path: z
          .string()
          .describe(
            `Path. For scope=self: "agents/${agentId}/foo.md". For filesystem scopes: filename relative to the scope dir.`,
          ),
        content: z.string().describe("The full content to write to the file"),
        scope: z
          .string()
          .optional()
          .describe(`Scope id. Defaults to "self". Valid scopes on this agent: ${scopeListDescription}`),
      },
      async ({ path, content, scope }) => {
        try {
          if (!scope || scope === "self") {
            if (!isAllowed(path)) {
              return {
                isError: true,
                content: [
                  { type: "text", text: `Access denied: you can only write to agents/${agentId}/ and shared/` },
                ],
              };
            }

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
              { $set: { content, updatedAt: new Date(), updatedBy: agentId } },
              { upsert: true },
            );

            return { content: [{ type: "text", text: `Written: ${path}` }] };
          }

          const decl = router.get(scope);
          if (!decl) {
            return {
              isError: true,
              content: [{ type: "text", text: `Unknown scope: ${scope}. Valid: ${scopeListDescription}` }],
            };
          }
          if (decl.backing === "mongo") {
            return {
              isError: true,
              content: [{ type: "text", text: `Mongo scope ${scope} has no write mapping` }],
            };
          }
          const store = router.requireFs(scope);
          const indexLine = `- [${path.replace(/\.md$/, "")}](${path}) — (updated by ${agentId})`;
          store.write(path, content, indexLine);
          return { content: [{ type: "text", text: `Written: ${scope}:${path}` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_write error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_list",
      `List files in a memory directory. Defaults to self (your Mongo agent directory). Filesystem scopes available: ${scopeListDescription}.`,
      {
        path: z
          .string()
          .optional()
          .describe(
            `Directory to list (self scope only), defaults to "agents/${agentId}/". Ignored for filesystem scopes.`,
          ),
        scope: z
          .string()
          .optional()
          .describe(`Scope id. Defaults to "self". Valid scopes on this agent: ${scopeListDescription}`),
      },
      async ({ path, scope }) => {
        try {
          if (!scope || scope === "self") {
            const dir = path || `agents/${agentId}/`;
            const prefix = dir.endsWith("/") ? dir : dir + "/";

            if (!isAllowed(prefix)) {
              return {
                isError: true,
                content: [{ type: "text", text: `Access denied: you can only list agents/${agentId}/ and shared/` }],
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
              isError: true,
              content: [{ type: "text", text: `Unknown scope: ${scope}. Valid: ${scopeListDescription}` }],
            };
          }
          if (decl.backing === "mongo") {
            return {
              isError: true,
              content: [{ type: "text", text: `Mongo scope ${scope} has no list mapping` }],
            };
          }
          const store = router.requireFs(scope);
          const files = store.list();
          if (files.length === 0) {
            return { content: [{ type: "text", text: "(empty directory)" }] };
          }
          return { content: [{ type: "text", text: files.join("\n") }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_list error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_history",
      `View previous versions of a memory file. Self scope only.`,
      {
        path: z.string().describe("File path to view history for"),
        limit: z.number().optional().describe("Max versions to return (default 10)"),
        scope: z.string().optional().describe(`Scope id. Defaults to "self". Only "self" is supported for history.`),
      },
      async ({ path, limit, scope }) => {
        try {
          if (scope && scope !== "self") {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "history/rollback not supported for filesystem scopes — use git or equivalent",
                },
              ],
            };
          }
          if (!isAllowed(path)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Access denied: you can only access agents/${agentId}/ and shared/` }],
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
          return { isError: true, content: [{ type: "text", text: `memory_history error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "memory_rollback",
      `Restore a memory file to a previous version. Self scope only. Use memory_history first to find the version index.`,
      {
        path: z.string().describe("File path to rollback"),
        version_index: z.number().describe("Version index from memory_history (0 = most recent previous version)"),
        scope: z.string().optional().describe(`Scope id. Defaults to "self". Only "self" is supported for rollback.`),
      },
      async ({ path, version_index, scope }) => {
        try {
          if (scope && scope !== "self") {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "history/rollback not supported for filesystem scopes — use git or equivalent",
                },
              ],
            };
          }
          if (!isAllowed(path)) {
            return {
              isError: true,
              content: [{ type: "text", text: `Access denied: you can only access agents/${agentId}/ and shared/` }],
            };
          }

          const history = await versions.find({ path }).sort({ savedAt: -1 }).skip(version_index).limit(1).toArray();

          if (history.length === 0) {
            return {
              isError: true,
              content: [{ type: "text", text: `Version ${version_index} not found for: ${path}` }],
            };
          }

          const target = history[0];

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
            { $set: { content: target.content, updatedAt: new Date(), updatedBy: `${agentId}:rollback` } },
            { upsert: true },
          );

          const savedAt = target.savedAt as unknown;
          const date = savedAt instanceof Date ? savedAt.toISOString() : String(savedAt);
          return { content: [{ type: "text", text: `Rolled back ${path} to version from ${date}` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `memory_rollback error: ${String(err)}` }] };
        }
      },
    ),
  ];
}

export function createMemoryMcpServer(deps: MemoryToolDeps) {
  return createSdkMcpServer({
    name: "memory",
    version: "0.2.0",
    tools: buildMemoryTools(deps),
  });
}

// ── Stdio shim ────────────────────────────────────────────────────────────
// Preserved so the publish-ready bundle (`pkg/mcp/memory.min.js`) still emits
// a runnable Node entry-point. When in-process wiring is the only consumer,
// this branch is never entered.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await (async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { MongoClient } = await import("mongodb");
    const { parseScopesEnv } = await import("./memory-scope.js");

    const AGENT_ID = process.env.AGENT_ID ?? "";
    const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
    const MONGODB_DB = process.env.MONGODB_DB ?? "hive";

    if (!AGENT_ID) {
      process.stderr.write("memory-mcp-server: AGENT_ID is required\n");
      process.exit(1);
    }

    let memoryScopes: ScopeList = [];
    try {
      memoryScopes = parseScopesEnv(process.env.MEMORY_SCOPES_JSON);
    } catch (err) {
      process.stderr.write(
        `memory-mcp-server: invalid MEMORY_SCOPES_JSON, falling back to self-only: ${String(err)}\n`,
      );
    }

    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(MONGODB_DB);

    const tools = buildMemoryTools({ db, agentId: AGENT_ID, memoryScopes });

    // Bridge buildMemoryTools (SDK-shape) → McpServer.registerTool.
    const server = new McpServer({ name: "hive-memory", version: "0.2.0" });
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

    process.on("SIGTERM", () => {
      void client.close();
    });
    process.on("SIGINT", () => {
      void client.close();
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
