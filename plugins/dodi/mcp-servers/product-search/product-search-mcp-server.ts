#!/usr/bin/env node
/**
 * Product Search MCP Server — semantic search over product/catalog data.
 *
 * Domain: parts, product families, designs, design iterations
 *
 * Qdrant only — no Atlas backend support.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createSearchBackend,
  embed,
  searchQdrant,
  formatResult,
  type SearchBackend,
  type FieldConfig,
} from "../search-shared.js";

const server = new McpServer({ name: "product-search", version: "1.0.0" });

// ── Lazy Backend Init ────────────────────────────────────────────────────────

let backend: SearchBackend;
async function ensureReady() {
  if (!backend) backend = await createSearchBackend();
}

// ── Field Configuration ──────────────────────────────────────────────────────

const PRODUCT_FIELDS: FieldConfig = {
  idFields: { dodiId: true },
  displayFields: [
    { key: "family", label: "Family" },
    { key: "familyType", label: "Type" },
    { key: "price", label: "Price", prefix: "$" },
    { key: "vendor", label: "Vendor" },
    { key: "status", label: "Status" },
    { key: "customerName", label: "Customer" },
    { key: "projectName", label: "Project" },
  ],
};

// ── Collection Mapping ───────────────────────────────────────────────────────

const PRODUCT_COLLECTIONS: { name: string; type: string }[] = [
  { name: "parts", type: "part" },
  { name: "product_families", type: "product_family" },
  { name: "designs", type: "design" },
  { name: "design_iterations", type: "design_iteration" },
];

function collectionsForType(objectType: string): { name: string; type: string }[] {
  switch (objectType) {
    case "part":
      return [{ name: "parts", type: "part" }];
    case "product_family":
      return [{ name: "product_families", type: "product_family" }];
    case "design":
      return [{ name: "designs", type: "design" }];
    case "design_iteration":
      return [{ name: "design_iterations", type: "design_iteration" }];
    case "all":
    default:
      return PRODUCT_COLLECTIONS;
  }
}

// ── Tool: product_search ─────────────────────────────────────────────────────

server.registerTool(
  "product_search",
  {
    title: "Product Search",
    description:
      "Semantic search across product data — parts, product families, designs, and design iterations. Returns the most relevant records for a natural language query.",
    inputSchema: {
      query: z
        .string()
        .describe(
          "Natural language query, e.g. 'shaker door styles', 'soft-close hinge options', 'pull-out trash cans'",
        ),
      objectType: z
        .enum(["part", "product_family", "design", "design_iteration", "all"])
        .optional()
        .default("all")
        .describe("Filter by record type. Default: search all types."),
      limit: z.number().optional().default(10).describe("Maximum results to return"),
    },
  },
  async ({ query, objectType, limit }) => {
    try {
      await ensureReady();
      const queryEmbedding = await embed(query);
      const collections = collectionsForType(objectType);

      // Parallel Qdrant searches across all target collections
      const searchPromises = collections.map((col) =>
        searchQdrant(backend.qdrant, col.name, queryEmbedding, limit).catch((e) => {
          process.stderr.write(`product-search: search failed on ${col.name}: ${e.message}\n`);
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

      const formatted = topResults.map((r, i) => formatResult(r, i + 1, PRODUCT_FIELDS)).join("\n\n");
      return { content: [{ type: "text", text: `Found ${topResults.length} results:\n\n${formatted}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: product_stats ──────────────────────────────────────────────────────

server.registerTool(
  "product_stats",
  {
    title: "Product Statistics",
    description:
      "Get collection counts overview for product data — parts, product families, designs, and design iterations.",
    inputSchema: {
      metric: z.enum(["overview"]).optional().default("overview").describe("Type of statistics to return"),
    },
  },
  async ({ metric }) => {
    try {
      await ensureReady();

      const counts: { label: string; count: number }[] = [];
      let total = 0;

      for (const col of PRODUCT_COLLECTIONS) {
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
        "Product Data Overview",
        "=====================",
        ...counts.map((c) => `${c.label}: ${c.count.toLocaleString()}`),
        "─────────────────────",
        `Total records: ${total.toLocaleString()}`,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Connect and run ─────────────────────────────────────────────────────────

process.stderr.write("product-search: starting\n");
const transport = new StdioServerTransport();
await server.connect(transport);
