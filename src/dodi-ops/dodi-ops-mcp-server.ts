#!/usr/bin/env node
/**
 * Dodi Ops MCP Server
 *
 * Provides Hive agents with access to the dodi_v2 REST API:
 * - Jobs: CRUD + lifecycle (state transitions, link design/order, refresh)
 * - Comments: CRUD on any entity
 * - Attachments: list, detail, download URL (upload TBD)
 * - Cutlists: list, detail, parts
 *
 * Env vars:
 *   DODI_OPS_API_URL  — Base URL (e.g. https://app.dodihome.com)
 *   DODI_OPS_API_KEY  — Per-agent API key for auth
 *   DODI_OPS_MODE     — "full" (default) or "readonly"
 *   DODI_OPS_AGENT_ID — Agent identifier for logging
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = (process.env.DODI_OPS_API_URL ?? "").replace(/\/$/, "");
const API_KEY = process.env.DODI_OPS_API_KEY ?? "";
const MODE = (process.env.DODI_OPS_MODE ?? "full") as "full" | "readonly";
const AGENT_ID = process.env.DODI_OPS_AGENT_ID ?? "unknown";

if (!API_URL || !API_KEY) {
  process.stderr.write("dodi-ops: DODI_OPS_API_URL and DODI_OPS_API_KEY are required\n");
  process.exit(1);
}

const server = new McpServer({ name: "dodi-ops", version: "0.1.0" });

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const url = `${API_URL}/api/v1${path}`;
  const headers: Record<string, string> = {
    "x-api-key": API_KEY,
    "Accept": "application/json",
  };
  const opts: RequestInit = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  const text = await res.text();

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = data?.message ?? data?.error ?? `HTTP ${res.status}`;
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
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
// Jobs — Read
// ---------------------------------------------------------------------------

server.registerTool("dodi_jobs_list", {
  title: "List Jobs",
  description: "List jobs with optional filters. Returns summary fields. Use query params: state, customer, search, limit, skip.",
  inputSchema: {
    state: z.string().optional().describe("Filter by job state (e.g. 'planning', 'in-production', 'qa', 'delivery')"),
    search: z.string().optional().describe("Search jobs by name or number"),
    limit: z.number().optional().default(20).describe("Max results (default 20)"),
    skip: z.number().optional().default(0).describe("Offset for pagination"),
  },
}, async (input) => {
  try {
    const params = new URLSearchParams();
    if (input.state) params.set("state", input.state);
    if (input.search) params.set("search", input.search);
    if (input.limit) params.set("limit", String(input.limit));
    if (input.skip) params.set("skip", String(input.skip));
    const qs = params.toString();
    return ok(await api("GET", `/jobs${qs ? `?${qs}` : ""}`));
  } catch (e) { return err(e); }
});

server.registerTool("dodi_jobs_get", {
  title: "Get Job Detail",
  description: "Get full details for a specific job by ID.",
  inputSchema: {
    jobId: z.string().describe("The job ID"),
  },
}, async ({ jobId }) => {
  try { return ok(await api("GET", `/jobs/${jobId}`)); }
  catch (e) { return err(e); }
});

// ---------------------------------------------------------------------------
// Jobs — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool("dodi_jobs_create", {
    title: "Create Job",
    description: "Create a new job. Three modes: minimal (projectId + name), from design (projectId + designId), or from order (orderId).",
    inputSchema: {
      projectId: z.string().optional().describe("Project ID (required for minimal and from-design modes)"),
      name: z.string().optional().describe("Job name (for minimal creation)"),
      description: z.string().optional().describe("Job description"),
      designId: z.string().optional().describe("Design ID to create job from"),
      version: z.number().optional().describe("Design version number"),
      orderId: z.string().optional().describe("Order ID to create job from"),
    },
  }, async (input) => {
    try { return ok(await api("POST", "/jobs", input)); }
    catch (e) { return err(e); }
  });

  server.registerTool("dodi_jobs_update", {
    title: "Update Job",
    description: "Update job fields (name, description, dates, customer, owners).",
    inputSchema: {
      jobId: z.string().describe("The job ID to update"),
      name: z.string().optional().describe("New job name"),
      description: z.string().optional().describe("New description"),
      dueDate: z.string().optional().describe("ISO-8601 due date"),
      buildCompleteDate: z.string().optional().describe("ISO-8601 build complete date"),
      qaCompleteDate: z.string().optional().describe("ISO-8601 QA complete date"),
      deliveryDate: z.string().optional().describe("ISO-8601 delivery date"),
    },
  }, async ({ jobId, ...body }) => {
    try { return ok(await api("PUT", `/jobs/${jobId}`, body)); }
    catch (e) { return err(e); }
  });

  server.registerTool("dodi_jobs_transition", {
    title: "Transition Job State",
    description: "Advance a job to a new state (e.g. planning → in-production → qa → delivery → complete).",
    inputSchema: {
      jobId: z.string().describe("The job ID"),
      toState: z.string().describe("Target state to transition to"),
    },
  }, async ({ jobId, toState }) => {
    try { return ok(await api("POST", `/jobs/${jobId}/transition`, { toState })); }
    catch (e) { return err(e); }
  });

  server.registerTool("dodi_jobs_refresh_artifacts", {
    title: "Refresh Job Artifacts",
    description: "Regenerate cutlists and purchasing items for a job.",
    inputSchema: {
      jobId: z.string().describe("The job ID"),
      cutlistIdsToTrash: z.array(z.string()).optional().default([]).describe("Cutlist IDs to trash before regeneration"),
      purchasingItemIdsToCancel: z.array(z.string()).optional().default([]).describe("Purchasing item IDs to cancel"),
    },
  }, async ({ jobId, ...body }) => {
    try { return ok(await api("POST", `/jobs/${jobId}/refresh-artifacts`, body)); }
    catch (e) { return err(e); }
  });
}

// ---------------------------------------------------------------------------
// Comments — Read
// ---------------------------------------------------------------------------

server.registerTool("dodi_comments_list", {
  title: "List Comments",
  description: "List comments for an entity. Pass context IDs (e.g. job ID, project ID) to filter. Or use rootId for rollup across all descendants.",
  inputSchema: {
    context: z.array(z.string()).optional().describe("Context IDs to filter by (e.g. ['jobId123'])"),
    rootId: z.string().optional().describe("Root entity ID for context rollup (get all comments across related entities)"),
  },
}, async (input) => {
  try {
    const params = new URLSearchParams();
    if (input.context) input.context.forEach(c => params.append("context", c));
    if (input.rootId) params.set("rootId", input.rootId);
    return ok(await api("GET", `/comments?${params.toString()}`));
  } catch (e) { return err(e); }
});

// ---------------------------------------------------------------------------
// Comments — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool("dodi_comments_create", {
    title: "Add Comment",
    description: "Add a comment to any entity (job, project, quote, order, etc.). Context is an array of entity IDs this comment belongs to.",
    inputSchema: {
      context: z.array(z.string()).min(1).describe("Entity IDs this comment belongs to (e.g. ['jobId123'])"),
      content: z.string().describe("Comment text content"),
      contentFormat: z.enum(["text", "html"]).optional().default("text").describe("Content format"),
      parentId: z.string().optional().describe("Parent comment ID for threaded replies"),
      fileIds: z.array(z.string()).optional().describe("Attachment file IDs to link"),
    },
  }, async (input) => {
    try { return ok(await api("POST", "/comments", input)); }
    catch (e) { return err(e); }
  });

  server.registerTool("dodi_comments_update", {
    title: "Edit Comment",
    description: "Edit an existing comment.",
    inputSchema: {
      commentId: z.string().describe("Comment ID to edit"),
      content: z.string().describe("Updated comment content"),
      contentFormat: z.enum(["text", "html"]).optional().describe("Content format"),
    },
  }, async ({ commentId, ...body }) => {
    try { return ok(await api("PUT", `/comments/${commentId}`, body)); }
    catch (e) { return err(e); }
  });

  server.registerTool("dodi_comments_delete", {
    title: "Delete Comment",
    description: "Soft-delete a comment.",
    inputSchema: {
      commentId: z.string().describe("Comment ID to delete"),
    },
  }, async ({ commentId }) => {
    try { return ok(await api("DELETE", `/comments/${commentId}`)); }
    catch (e) { return err(e); }
  });
}

// ---------------------------------------------------------------------------
// Attachments — Read
// ---------------------------------------------------------------------------

server.registerTool("dodi_attachments_list", {
  title: "List Attachments",
  description: "List file attachments for an entity. Pass context IDs to filter.",
  inputSchema: {
    context: z.array(z.string()).min(1).describe("Context IDs to filter by (e.g. ['jobId123'])"),
  },
}, async (input) => {
  try {
    const params = new URLSearchParams();
    input.context.forEach(c => params.append("context", c));
    return ok(await api("GET", `/attachments?${params.toString()}`));
  } catch (e) { return err(e); }
});

server.registerTool("dodi_attachments_get", {
  title: "Get Attachment Detail",
  description: "Get metadata for a specific attachment.",
  inputSchema: {
    fileId: z.string().describe("Attachment file ID"),
  },
}, async ({ fileId }) => {
  try { return ok(await api("GET", `/attachments/${fileId}`)); }
  catch (e) { return err(e); }
});

server.registerTool("dodi_attachments_download_url", {
  title: "Get Attachment Download URL",
  description: "Get the download URL for an attachment file.",
  inputSchema: {
    fileId: z.string().describe("Attachment file ID"),
  },
}, async ({ fileId }) => {
  try { return ok(await api("GET", `/attachments/${fileId}/download`)); }
  catch (e) { return err(e); }
});

// ---------------------------------------------------------------------------
// Attachments — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool("dodi_attachments_delete", {
    title: "Delete Attachment",
    description: "Delete a file attachment.",
    inputSchema: {
      fileId: z.string().describe("Attachment file ID to delete"),
    },
  }, async ({ fileId }) => {
    try { return ok(await api("DELETE", `/attachments/${fileId}`)); }
    catch (e) { return err(e); }
  });
}

// ---------------------------------------------------------------------------
// Cutlists — Read
// ---------------------------------------------------------------------------

server.registerTool("dodi_cutlists_list", {
  title: "List Cutlists",
  description: "List cutlists with optional filters by state, job, material, or search term.",
  inputSchema: {
    state: z.string().optional().describe("Filter by cutlist state"),
    jobId: z.string().optional().describe("Filter by job ID"),
    material: z.string().optional().describe("Filter by material description"),
    search: z.string().optional().describe("Search by name or number"),
    limit: z.number().optional().default(20).describe("Max results"),
    skip: z.number().optional().default(0).describe("Offset for pagination"),
  },
}, async (input) => {
  try {
    const params = new URLSearchParams();
    if (input.state) params.set("state", input.state);
    if (input.jobId) params.set("jobId", input.jobId);
    if (input.material) params.set("material", input.material);
    if (input.search) params.set("search", input.search);
    if (input.limit) params.set("limit", String(input.limit));
    if (input.skip) params.set("skip", String(input.skip));
    const qs = params.toString();
    return ok(await api("GET", `/cutlists${qs ? `?${qs}` : ""}`));
  } catch (e) { return err(e); }
});

server.registerTool("dodi_cutlists_get", {
  title: "Get Cutlist Detail",
  description: "Get full details for a specific cutlist.",
  inputSchema: {
    cutlistId: z.string().describe("Cutlist ID"),
  },
}, async ({ cutlistId }) => {
  try { return ok(await api("GET", `/cutlists/${cutlistId}`)); }
  catch (e) { return err(e); }
});

server.registerTool("dodi_cutlists_parts", {
  title: "Get Cutlist Parts",
  description: "Get the BOM line items (parts) for a cutlist — dimensions, materials, quantities, etc.",
  inputSchema: {
    cutlistId: z.string().describe("Cutlist ID"),
  },
}, async ({ cutlistId }) => {
  try { return ok(await api("GET", `/cutlists/${cutlistId}/parts`)); }
  catch (e) { return err(e); }
});

// ---------------------------------------------------------------------------
// Cutlists — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool("dodi_cutlists_create", {
    title: "Create Cutlist",
    description: "Create a new cutlist from parts. Requires name, parts array, and optimization params.",
    inputSchema: {
      name: z.string().describe("Cutlist name"),
      parts: z.array(z.object({
        job: z.string().describe("Job ID"),
        lineNumber: z.string().describe("Line number"),
        name: z.string().describe("Part name"),
        qty: z.number().describe("Quantity"),
        width: z.number().describe("Width"),
        height: z.number().describe("Height"),
        depth: z.number().optional().default(0).describe("Depth"),
        material: z.string().optional().describe("Material"),
        sku: z.string().optional().describe("SKU"),
        doorStyle: z.string().optional().describe("Door style"),
        finishType: z.string().optional().describe("Finish type"),
        color: z.string().optional().describe("Color"),
      })).min(1).describe("Parts / BOM line items"),
      params: z.object({
        materialDesc: z.string().describe("Material description"),
        uniqueMaterials: z.array(z.string()).optional().describe("Unique material list"),
        grainDirection: z.string().optional().describe("Grain direction"),
        assumedThickness: z.number().optional().describe("Assumed material thickness"),
      }).describe("Optimization parameters"),
    },
  }, async (input) => {
    try { return ok(await api("POST", "/cutlists", input)); }
    catch (e) { return err(e); }
  });

  server.registerTool("dodi_cutlists_update", {
    title: "Update Cutlist",
    description: "Update a cutlist's name, description, or parts.",
    inputSchema: {
      cutlistId: z.string().describe("Cutlist ID to update"),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe("New description"),
    },
  }, async ({ cutlistId, ...body }) => {
    try { return ok(await api("PUT", `/cutlists/${cutlistId}`, body)); }
    catch (e) { return err(e); }
  });

  server.registerTool("dodi_cutlists_delete", {
    title: "Delete Cutlist",
    description: "Delete a cutlist.",
    inputSchema: {
      cutlistId: z.string().describe("Cutlist ID to delete"),
    },
  }, async ({ cutlistId }) => {
    try { return ok(await api("DELETE", `/cutlists/${cutlistId}`)); }
    catch (e) { return err(e); }
  });
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

process.stderr.write(`dodi-ops: starting (mode=${MODE}, agent=${AGENT_ID}, url=${API_URL})\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
