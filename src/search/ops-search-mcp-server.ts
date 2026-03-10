#!/usr/bin/env node
/**
 * Ops Search MCP Server — semantic search over operations/production data.
 *
 * Domain: persons, projects, quotes, orders, jobs, tasks, cases, comments
 *
 * Qdrant only — no Atlas backend support.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createSearchBackend, embed, searchQdrant, formatResult,
  type SearchBackend, type FieldConfig,
} from "./search-shared.js";

const server = new McpServer({ name: "ops-search", version: "1.0.0" });

// ── Lazy Backend Init ────────────────────────────────────────────────────────

let backend: SearchBackend;
async function ensureReady() {
  if (!backend) backend = await createSearchBackend();
}

// ── Field Configuration ──────────────────────────────────────────────────────

const OPS_FIELDS: FieldConfig = {
  idFields: { dodiId: true },
  displayFields: [
    { key: "status", label: "Status" },
    { key: "total", label: "Total", prefix: "$" },
    { key: "customerName", label: "Customer" },
    { key: "projectName", label: "Project" },
    { key: "author", label: "Author" },
    { key: "targetId", label: "Target" },
  ],
};

// ── Collection Mapping ───────────────────────────────────────────────────────

const OPS_COLLECTIONS: { name: string; type: string }[] = [
  { name: "persons", type: "person" },
  { name: "projects", type: "project" },
  { name: "quotes", type: "quote" },
  { name: "orders", type: "order" },
  { name: "jobs", type: "job" },
  { name: "operational_tasks", type: "task" },
  { name: "cases", type: "case" },
  { name: "comments", type: "comment" },
];

function collectionsForType(objectType: string): { name: string; type: string }[] {
  switch (objectType) {
    case "person":
      return [{ name: "persons", type: "person" }];
    case "project":
      return [{ name: "projects", type: "project" }];
    case "quote":
      return [{ name: "quotes", type: "quote" }];
    case "order":
      return [{ name: "orders", type: "order" }];
    case "job":
      return [{ name: "jobs", type: "job" }];
    case "task":
      return [{ name: "operational_tasks", type: "task" }];
    case "case":
      return [{ name: "cases", type: "case" }];
    case "comment":
      return [{ name: "comments", type: "comment" }];
    case "all":
    default:
      return OPS_COLLECTIONS;
  }
}

// ── Tool: ops_search ─────────────────────────────────────────────────────────

server.registerTool("ops_search", {
  title: "Ops Search",
  description:
    "Semantic search across operational data — persons, projects, quotes, orders, jobs, tasks, cases, and comments. Returns the most relevant records for a natural language query.",
  inputSchema: {
    query: z
      .string()
      .describe(
        "Natural language query, e.g. 'kitchen remodel in progress', 'delayed orders', 'assembly issues'",
      ),
    objectType: z
      .enum(["person", "project", "quote", "order", "job", "task", "case", "comment", "all"])
      .optional()
      .default("all")
      .describe("Filter by record type. Default: search all types."),
    limit: z.number().optional().default(10).describe("Maximum results to return"),
  },
}, async ({ query, objectType, limit }) => {
  try {
    await ensureReady();
    const queryEmbedding = await embed(query);
    const collections = collectionsForType(objectType);

    // Parallel Qdrant searches across all target collections
    const searchPromises = collections.map((col) =>
      searchQdrant(backend.qdrant, col.name, queryEmbedding, limit).catch((e) => {
        process.stderr.write(`ops-search: search failed on ${col.name}: ${e.message}\n`);
        return [] as any[];
      }),
    );
    const resultArrays = await Promise.all(searchPromises);
    const allResults = resultArrays.flat();

    // Sort by score descending, take top N
    allResults.sort((a, b) => b.score - a.score);
    const topResults = allResults.slice(0, limit);

    if (topResults.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }

    const formatted = topResults.map((r, i) => formatResult(r, i + 1, OPS_FIELDS)).join("\n\n");
    return { content: [{ type: "text", text: `Found ${topResults.length} results:\n\n${formatted}` }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Tool: ops_stats ──────────────────────────────────────────────────────────

server.registerTool("ops_stats", {
  title: "Ops Statistics",
  description:
    "Get collection counts overview for operational data — persons, projects, quotes, orders, jobs, tasks, cases, and comments.",
  inputSchema: {
    metric: z
      .enum(["overview"])
      .optional()
      .default("overview")
      .describe("Type of statistics to return"),
  },
}, async ({ metric }) => {
  try {
    await ensureReady();

    const counts: { label: string; count: number }[] = [];
    let total = 0;

    for (const col of OPS_COLLECTIONS) {
      try {
        const info = await backend.qdrant.getCollection(col.name);
        const count = info.points_count ?? 0;
        counts.push({ label: col.type, count });
        total += count;
      } catch {
        counts.push({ label: col.type, count: 0 });
      }
    }

    const lines = [
      "Ops Data Overview",
      "=================",
      ...counts.map((c) => `${c.label}: ${c.count.toLocaleString()}`),
      "─────────────────────",
      `Total records: ${total.toLocaleString()}`,
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Connect and run ─────────────────────────────────────────────────────────

process.stderr.write("ops-search: starting\n");
const transport = new StdioServerTransport();
await server.connect(transport);
