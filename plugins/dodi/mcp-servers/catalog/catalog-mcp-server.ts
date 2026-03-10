#!/usr/bin/env node
/**
 * Catalog MCP Server — read-only access to the dodi_v2 product catalog.
 *
 * Exposes parts (Rev-a-Shelf inserts, hardware, panels, etc.), product families
 * (hierarchical groupings with inherited specs), and product types.
 *
 * Env vars:
 *   CATALOG_API_URL  — Base URL (e.g. https://app.dodihome.com)
 *   CATALOG_API_KEY  — Agent API key for auth
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = (process.env.CATALOG_API_URL ?? "").replace(/\/$/, "");
const API_KEY = process.env.CATALOG_API_KEY ?? "";

if (!API_URL || !API_KEY) {
  process.stderr.write("catalog: CATALOG_API_URL and CATALOG_API_KEY are required\n");
  process.exit(1);
}

const server = new McpServer({ name: "catalog", version: "0.1.0" });

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(path: string, params?: Record<string, string | number | undefined>): Promise<any> {
  const url = new URL(`${API_URL}/api/v1/catalog${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-api-key": API_KEY,
      "Accept": "application/json",
    },
  });

  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = data?.message ?? data?.error ?? `HTTP ${res.status}`;
    throw new Error(`GET ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

function ok(data: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function err(e: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Parts — search, get by ID, get by SKU
// ---------------------------------------------------------------------------

server.registerTool("catalog_search_parts", {
  title: "Search Parts Catalog",
  description:
    "Search the product catalog for parts (inserts, hardware, panels, doors, materials). " +
    "Use `q` for fuzzy text search across SKU, name, brand, and description. " +
    "Use filters to narrow by type, brand, tag, or state. " +
    "Returns pricing (list and cost), images, and sourcing info.",
  inputSchema: {
    q: z.string().optional().describe("Fuzzy text search (min 2 chars) — searches SKU, name, brand, description"),
    type: z.string().optional().describe("Filter by part type: hardware, material, panel, door, generic"),
    brand: z.string().optional().describe("Filter by brand: Rev-A-Shelf, Blum, Cleaf, Tafisa, Shinnoki, etc."),
    tag: z.string().optional().describe("Filter by tag: organizer, pullout, hinge, slide, etc."),
    state: z.string().optional().describe("Filter by state: ACTIVE, DISCONTINUED"),
    limit: z.number().optional().describe("Max results (default 50, max 250)"),
    offset: z.number().optional().describe("Pagination offset"),
  },
}, async ({ q, type, brand, tag, state, limit, offset }) => {
  try {
    const data = await api("/parts", { q, type, brand, tag, state, limit, offset });
    if (!data.parts?.length) return ok("No parts found matching your criteria.");

    const lines = data.parts.map((p: any) => {
      const price = p.list?.amount ? `$${p.list.amount.toFixed(2)}/${p.list.uom ?? "each"}` : "no price";
      const cost = p.cost?.amount ? ` (cost: $${p.cost.amount.toFixed(2)})` : "";
      const tags = p.tags?.length ? ` [${p.tags.join(", ")}]` : "";
      return `**${p.sku}** — ${p.name}\n  Brand: ${p.brand || "—"} | Type: ${p.type} | ${price}${cost}${tags}${p.state === "DISCONTINUED" ? " ⚠️ DISCONTINUED" : ""}`;
    });

    return ok(`Found ${data.total} parts (showing ${data.parts.length}):\n\n${lines.join("\n\n")}`);
  } catch (e) { return err(e); }
});

server.registerTool("catalog_get_part", {
  title: "Get Part Details",
  description:
    "Get full details for a specific part by its ID. " +
    "Returns complete specs, sourcing info, dimensions, pricing, and image URL.",
  inputSchema: {
    id: z.string().describe("Part ID"),
  },
}, async ({ id }) => {
  try {
    return ok(await api(`/parts/${id}`));
  } catch (e) { return err(e); }
});

server.registerTool("catalog_get_part_by_sku", {
  title: "Get Part by SKU",
  description:
    "Look up a specific part by its SKU code (e.g., '4WC-15-1', 'BHF-12CR-R-52'). " +
    "Returns the full part document with specs, pricing, and sourcing.",
  inputSchema: {
    sku: z.string().describe("Part SKU (e.g., 4WC-15-1)"),
  },
}, async ({ sku }) => {
  try {
    return ok(await api(`/parts/sku/${encodeURIComponent(sku)}`));
  } catch (e) { return err(e); }
});

// ---------------------------------------------------------------------------
// Product Families — search, get, children, resolved spec
// ---------------------------------------------------------------------------

server.registerTool("catalog_search_families", {
  title: "Search Product Families",
  description:
    "Search product family groupings. Families organize parts hierarchically " +
    "(e.g., Rev-A-Shelf → Pull-Outs → Wood Classics). " +
    "Use this to browse product categories, find product lines by vendor, or discover what's available.",
  inputSchema: {
    q: z.string().optional().describe("Fuzzy text search across code, name, vendor"),
    type: z.string().optional().describe("Filter by type: hardware, material, panel, door"),
    vendor: z.string().optional().describe("Filter by vendor name"),
    parentCode: z.string().optional().describe("Filter by parent family code"),
    tag: z.string().optional().describe("Filter by tag"),
    limit: z.number().optional().describe("Max results (default 50, max 250)"),
    offset: z.number().optional().describe("Pagination offset"),
  },
}, async ({ q, type, vendor, parentCode, tag, limit, offset }) => {
  try {
    const data = await api("/families", { q, type, vendor, parentCode, tag, limit, offset });
    if (!data.families?.length) return ok("No product families found matching your criteria.");

    const lines = data.families.map((f: any) => {
      const price = f.priceRange ? ` | $${f.priceRange.low?.toFixed(2)}–$${f.priceRange.high?.toFixed(2)}` : "";
      return `**${f.code}** — ${f.name}\n  Vendor: ${f.vendor || "—"} | Type: ${f.type}${price}`;
    });

    return ok(`Found ${data.total} families (showing ${data.families.length}):\n\n${lines.join("\n\n")}`);
  } catch (e) { return err(e); }
});

server.registerTool("catalog_get_family", {
  title: "Get Product Family Details",
  description: "Get full details for a product family by ID.",
  inputSchema: {
    id: z.string().describe("Family ID"),
  },
}, async ({ id }) => {
  try {
    return ok(await api(`/families/${id}`));
  } catch (e) { return err(e); }
});

server.registerTool("catalog_get_family_children", {
  title: "Get Product Family Children",
  description:
    "Get direct child families of a parent family. " +
    "Use this to drill down from a top-level category (e.g., Rev-A-Shelf) to sub-categories (Pull-Outs, Lazy Susans, etc.).",
  inputSchema: {
    id: z.string().describe("Parent family ID"),
  },
}, async ({ id }) => {
  try {
    const data = await api(`/families/${id}/children`);
    if (!data.children?.length) return ok("This family has no child families.");
    return ok(data);
  } catch (e) { return err(e); }
});

server.registerTool("catalog_get_family_spec", {
  title: "Get Resolved Family Spec",
  description:
    "Get the fully resolved specification for a product family, including inherited fields from ancestors. " +
    "Shows dimensions, materials, construction details, and which level each spec field was defined at.",
  inputSchema: {
    id: z.string().describe("Family ID"),
  },
}, async ({ id }) => {
  try {
    return ok(await api(`/families/${id}/spec`));
  } catch (e) { return err(e); }
});

// ---------------------------------------------------------------------------
// Product Types — list all
// ---------------------------------------------------------------------------

server.registerTool("catalog_list_types", {
  title: "List Product Types",
  description:
    "List all product type classifications (hardware, material, panel, door, etc.). " +
    "Use this to understand what categories of products exist in the catalog.",
  inputSchema: {},
}, async () => {
  try {
    const data = await api("/types");
    const lines = data.types.map((t: any) => `**${t.code}** — ${t.label}`);
    return ok(`Product types:\n\n${lines.join("\n")}`);
  } catch (e) { return err(e); }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
