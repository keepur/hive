#!/usr/bin/env node
/**
 * Dodi Ops MCP Server
 *
 * Provides Hive agents with access to the dodi_v2 REST API:
 * - Persons: search, detail, CRUD
 * - Projects: list, detail, CRUD, person management
 * - Designs: list, detail, BOM, create
 * - Jobs: CRUD + lifecycle (state transitions, link design/order, refresh)
 * - Comments: CRUD on any entity
 * - Attachments: list, detail, download URL
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
    Accept: "application/json",
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
// Persons — Read
// ---------------------------------------------------------------------------

server.registerTool(
  "dodi_persons_search",
  {
    title: "Search Persons",
    description: "Search for persons (customers, contacts) by email, phone, or name.",
    inputSchema: {
      email: z.string().optional().describe("Search by email address"),
      phone: z.string().optional().describe("Search by phone number"),
      name: z.string().optional().describe("Search by name (partial match)"),
      limit: z.number().optional().default(20).describe("Max results"),
      skip: z.number().optional().default(0).describe("Offset for pagination"),
    },
  },
  async (input) => {
    try {
      const params = new URLSearchParams();
      if (input.email) params.set("email", input.email);
      if (input.phone) params.set("phone", input.phone);
      if (input.name) params.set("name", input.name);
      if (input.limit) params.set("limit", String(input.limit));
      if (input.skip) params.set("skip", String(input.skip));
      return ok(await api("GET", `/persons?${params.toString()}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_persons_get",
  {
    title: "Get Person Detail",
    description: "Get full details for a person by ID.",
    inputSchema: {
      personId: z.string().describe("Person ID"),
    },
  },
  async ({ personId }) => {
    try {
      return ok(await api("GET", `/persons/${personId}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_persons_projects",
  {
    title: "List Person's Projects",
    description: "Get all projects associated with a person.",
    inputSchema: {
      personId: z.string().describe("Person ID"),
    },
  },
  async ({ personId }) => {
    try {
      return ok(await api("GET", `/persons/${personId}/projects`));
    } catch (e) {
      return err(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Persons — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool(
    "dodi_persons_create",
    {
      title: "Find or Create Person",
      description: "Find an existing person by email/phone or create a new one. Returns the person record either way.",
      inputSchema: {
        firstName: z.string().describe("First name"),
        lastName: z.string().optional().describe("Last name"),
        email: z.string().optional().describe("Email address"),
        phone: z
          .object({
            number: z.string().describe("Phone number"),
          })
          .optional()
          .describe("Phone number"),
        company: z.string().optional().describe("Company name"),
      },
    },
    async (input) => {
      try {
        return ok(await api("POST", "/persons", input));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_persons_update",
    {
      title: "Update Person",
      description: "Update a person's details (name, email, phone).",
      inputSchema: {
        personId: z.string().describe("Person ID to update"),
        firstName: z.string().optional().describe("First name"),
        lastName: z.string().optional().describe("Last name"),
        email: z.string().optional().describe("Email address"),
        phone: z
          .object({
            number: z.string().describe("Phone number"),
          })
          .optional()
          .describe("Phone number"),
      },
    },
    async ({ personId, ...body }) => {
      try {
        return ok(await api("PUT", `/persons/${personId}`, body));
      } catch (e) {
        return err(e);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Projects — Read
// ---------------------------------------------------------------------------

server.registerTool(
  "dodi_projects_list",
  {
    title: "List Projects",
    description: "List projects with optional filters by state, search, or customer.",
    inputSchema: {
      state: z.string().optional().describe("Filter by project state"),
      search: z.string().optional().describe("Search by name"),
      limit: z.number().optional().default(20).describe("Max results"),
      skip: z.number().optional().default(0).describe("Offset for pagination"),
    },
  },
  async (input) => {
    try {
      const params = new URLSearchParams();
      if (input.state) params.set("state", input.state);
      if (input.search) params.set("search", input.search);
      if (input.limit) params.set("limit", String(input.limit));
      if (input.skip) params.set("skip", String(input.skip));
      const qs = params.toString();
      return ok(await api("GET", `/projects${qs ? `?${qs}` : ""}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_projects_get",
  {
    title: "Get Project Detail",
    description: "Get full project details including related data (designs, quotes, orders, jobs, cases).",
    inputSchema: {
      projectId: z.string().describe("Project ID"),
    },
  },
  async ({ projectId }) => {
    try {
      return ok(await api("GET", `/projects/${projectId}`));
    } catch (e) {
      return err(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Projects — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool(
    "dodi_projects_create",
    {
      title: "Create Project",
      description: "Create a new project.",
      inputSchema: {
        name: z.string().describe("Project name"),
        description: z.string().optional().describe("Project description"),
        address: z
          .object({
            street: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            zip: z.string().optional(),
            country: z.string().optional(),
          })
          .optional()
          .describe("Project address"),
        projectType: z.enum(["Remodel", "New Construction"]).optional().describe("Project type"),
      },
    },
    async (input) => {
      try {
        return ok(await api("POST", "/projects", input));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_projects_update",
    {
      title: "Update Project",
      description: "Update project fields (name, description, address, state).",
      inputSchema: {
        projectId: z.string().describe("Project ID to update"),
        name: z.string().optional().describe("New name"),
        description: z.string().optional().describe("New description"),
        state: z.string().optional().describe("New state"),
        address: z
          .object({
            street: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            zip: z.string().optional(),
            country: z.string().optional(),
          })
          .optional()
          .describe("Updated address"),
      },
    },
    async ({ projectId, ...body }) => {
      try {
        return ok(await api("PUT", `/projects/${projectId}`, body));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_projects_add_person",
    {
      title: "Add Person to Project",
      description: "Add a person to a project. Either provide an existing personId or a person object to find/create.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        personId: z.string().optional().describe("Existing person ID to add"),
        person: z
          .object({
            firstName: z.string().describe("First name"),
            lastName: z.string().optional().describe("Last name"),
            email: z.string().optional().describe("Email"),
            phone: z.object({ number: z.string() }).optional().describe("Phone"),
          })
          .optional()
          .describe("Person details (will find-or-create)"),
        role: z.string().optional().describe("Person's role on the project"),
      },
    },
    async ({ projectId, ...body }) => {
      try {
        return ok(await api("POST", `/projects/${projectId}/persons`, body));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_projects_remove_person",
    {
      title: "Remove Person from Project",
      description: "Remove a person from a project.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        personId: z.string().describe("Person ID to remove"),
      },
    },
    async ({ projectId, personId }) => {
      try {
        return ok(await api("DELETE", `/projects/${projectId}/persons/${personId}`));
      } catch (e) {
        return err(e);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Designs — Read
// ---------------------------------------------------------------------------

server.registerTool(
  "dodi_designs_list",
  {
    title: "List Designs",
    description: "List designs for a project.",
    inputSchema: {
      projectId: z.string().describe("Project ID to list designs for"),
    },
  },
  async ({ projectId }) => {
    try {
      return ok(await api("GET", `/designs?projectId=${projectId}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_designs_get",
  {
    title: "Get Design Detail",
    description: "Get full details for a design.",
    inputSchema: {
      designId: z.string().describe("Design ID"),
    },
  },
  async ({ designId }) => {
    try {
      return ok(await api("GET", `/designs/${designId}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_designs_bom",
  {
    title: "Get Design BOM",
    description: "Get the Bill of Materials summary for a design.",
    inputSchema: {
      designId: z.string().describe("Design ID"),
    },
  },
  async ({ designId }) => {
    try {
      return ok(await api("GET", `/designs/${designId}/bom`));
    } catch (e) {
      return err(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Designs — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool(
    "dodi_designs_create",
    {
      title: "Create Design",
      description: "Create a new design for a project.",
      inputSchema: {
        projectId: z.string().describe("Project ID"),
        spec: z
          .object({
            roomShape: z.string().optional().describe("Room shape"),
            dimension: z
              .object({
                x: z.number(),
                y: z.number(),
                z: z.number(),
              })
              .optional()
              .describe("Room dimensions"),
            spaceType: z
              .enum(["kitchen", "bath", "laundry", "mud_room", "closet", "other"])
              .optional()
              .describe("Space type"),
            style: z.string().optional().describe("Design style"),
          })
          .optional()
          .describe("Design specification"),
        generateLayout: z.boolean().optional().describe("Auto-generate layout from spec"),
      },
    },
    async (input) => {
      try {
        return ok(await api("POST", "/designs", input));
      } catch (e) {
        return err(e);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Jobs — Read
// ---------------------------------------------------------------------------

server.registerTool(
  "dodi_jobs_list",
  {
    title: "List Jobs",
    description:
      "List jobs with optional filters. Returns summary fields. Use query params: state, customer, search, limit, skip.",
    inputSchema: {
      state: z.string().optional().describe("Filter by job state (e.g. 'planning', 'in-production', 'qa', 'delivery')"),
      search: z.string().optional().describe("Search jobs by name or number"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
      skip: z.number().optional().default(0).describe("Offset for pagination"),
    },
  },
  async (input) => {
    try {
      const params = new URLSearchParams();
      if (input.state) params.set("state", input.state);
      if (input.search) params.set("search", input.search);
      if (input.limit) params.set("limit", String(input.limit));
      if (input.skip) params.set("skip", String(input.skip));
      const qs = params.toString();
      return ok(await api("GET", `/jobs${qs ? `?${qs}` : ""}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_jobs_get",
  {
    title: "Get Job Detail",
    description: "Get full details for a specific job by ID.",
    inputSchema: {
      jobId: z.string().describe("The job ID"),
    },
  },
  async ({ jobId }) => {
    try {
      return ok(await api("GET", `/jobs/${jobId}`));
    } catch (e) {
      return err(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Jobs — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool(
    "dodi_jobs_create",
    {
      title: "Create Job",
      description:
        "Create a new job. Three modes: minimal (projectId + name), from design (projectId + designId), or from order (orderId).",
      inputSchema: {
        projectId: z.string().optional().describe("Project ID (required for minimal and from-design modes)"),
        name: z.string().optional().describe("Job name (for minimal creation)"),
        description: z.string().optional().describe("Job description"),
        designId: z.string().optional().describe("Design ID to create job from"),
        version: z.number().optional().describe("Design version number"),
        orderId: z.string().optional().describe("Order ID to create job from"),
      },
    },
    async (input) => {
      try {
        return ok(await api("POST", "/jobs", input));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_jobs_update",
    {
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
    },
    async ({ jobId, ...body }) => {
      try {
        return ok(await api("PUT", `/jobs/${jobId}`, body));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_jobs_transition",
    {
      title: "Transition Job State",
      description: "Advance a job to a new state (e.g. planning → in-production → qa → delivery → complete).",
      inputSchema: {
        jobId: z.string().describe("The job ID"),
        toState: z.string().describe("Target state to transition to"),
      },
    },
    async ({ jobId, toState }) => {
      try {
        return ok(await api("POST", `/jobs/${jobId}/transition`, { toState }));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_jobs_refresh_artifacts",
    {
      title: "Refresh Job Artifacts",
      description: "Regenerate cutlists and purchasing items for a job.",
      inputSchema: {
        jobId: z.string().describe("The job ID"),
        cutlistIdsToTrash: z
          .array(z.string())
          .optional()
          .default([])
          .describe("Cutlist IDs to trash before regeneration"),
        purchasingItemIdsToCancel: z.array(z.string()).optional().default([]).describe("Purchasing item IDs to cancel"),
      },
    },
    async ({ jobId, ...body }) => {
      try {
        return ok(await api("POST", `/jobs/${jobId}/refresh-artifacts`, body));
      } catch (e) {
        return err(e);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Comments — Read
// ---------------------------------------------------------------------------

server.registerTool(
  "dodi_comments_list",
  {
    title: "List Comments",
    description:
      "List comments for an entity. Pass context IDs (e.g. job ID, project ID) to filter. Or use rootId for rollup across all descendants.",
    inputSchema: {
      context: z.array(z.string()).optional().describe("Context IDs to filter by (e.g. ['jobId123'])"),
      rootId: z
        .string()
        .optional()
        .describe("Root entity ID for context rollup (get all comments across related entities)"),
    },
  },
  async (input) => {
    try {
      const params = new URLSearchParams();
      if (input.context) input.context.forEach((c) => params.append("context", c));
      if (input.rootId) params.set("rootId", input.rootId);
      return ok(await api("GET", `/comments?${params.toString()}`));
    } catch (e) {
      return err(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Comments — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool(
    "dodi_comments_create",
    {
      title: "Add Comment",
      description:
        "Add a comment to any entity (job, project, quote, order, etc.). Context is an array of entity IDs this comment belongs to.",
      inputSchema: {
        context: z.array(z.string()).min(1).describe("Entity IDs this comment belongs to (e.g. ['jobId123'])"),
        content: z.string().describe("Comment text content"),
        contentFormat: z.enum(["text", "html"]).optional().default("text").describe("Content format"),
        parentId: z.string().optional().describe("Parent comment ID for threaded replies"),
        fileIds: z.array(z.string()).optional().describe("Attachment file IDs to link"),
      },
    },
    async (input) => {
      try {
        return ok(await api("POST", "/comments", input));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_comments_update",
    {
      title: "Edit Comment",
      description: "Edit an existing comment.",
      inputSchema: {
        commentId: z.string().describe("Comment ID to edit"),
        content: z.string().describe("Updated comment content"),
        contentFormat: z.enum(["text", "html"]).optional().describe("Content format"),
      },
    },
    async ({ commentId, ...body }) => {
      try {
        return ok(await api("PUT", `/comments/${commentId}`, body));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_comments_delete",
    {
      title: "Delete Comment",
      description: "Soft-delete a comment.",
      inputSchema: {
        commentId: z.string().describe("Comment ID to delete"),
      },
    },
    async ({ commentId }) => {
      try {
        return ok(await api("DELETE", `/comments/${commentId}`));
      } catch (e) {
        return err(e);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Attachments — Read
// ---------------------------------------------------------------------------

server.registerTool(
  "dodi_attachments_list",
  {
    title: "List Attachments",
    description: "List file attachments for an entity. Pass context IDs to filter.",
    inputSchema: {
      context: z.array(z.string()).min(1).describe("Context IDs to filter by (e.g. ['jobId123'])"),
    },
  },
  async (input) => {
    try {
      const params = new URLSearchParams();
      input.context.forEach((c) => params.append("context", c));
      return ok(await api("GET", `/attachments?${params.toString()}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_attachments_get",
  {
    title: "Get Attachment Detail",
    description: "Get metadata for a specific attachment.",
    inputSchema: {
      fileId: z.string().describe("Attachment file ID"),
    },
  },
  async ({ fileId }) => {
    try {
      return ok(await api("GET", `/attachments/${fileId}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_attachments_download_url",
  {
    title: "Get Attachment Download URL",
    description: "Get the download URL for an attachment file.",
    inputSchema: {
      fileId: z.string().describe("Attachment file ID"),
    },
  },
  async ({ fileId }) => {
    try {
      return ok(await api("GET", `/attachments/${fileId}/download`));
    } catch (e) {
      return err(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Attachments — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool(
    "dodi_attachments_delete",
    {
      title: "Delete Attachment",
      description: "Delete a file attachment.",
      inputSchema: {
        fileId: z.string().describe("Attachment file ID to delete"),
      },
    },
    async ({ fileId }) => {
      try {
        return ok(await api("DELETE", `/attachments/${fileId}`));
      } catch (e) {
        return err(e);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Cutlists — Read
// ---------------------------------------------------------------------------

server.registerTool(
  "dodi_cutlists_list",
  {
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
  },
  async (input) => {
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
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_cutlists_get",
  {
    title: "Get Cutlist Detail",
    description: "Get full details for a specific cutlist.",
    inputSchema: {
      cutlistId: z.string().describe("Cutlist ID"),
    },
  },
  async ({ cutlistId }) => {
    try {
      return ok(await api("GET", `/cutlists/${cutlistId}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.registerTool(
  "dodi_cutlists_parts",
  {
    title: "Get Cutlist Parts",
    description: "Get the BOM line items (parts) for a cutlist — dimensions, materials, quantities, etc.",
    inputSchema: {
      cutlistId: z.string().describe("Cutlist ID"),
    },
  },
  async ({ cutlistId }) => {
    try {
      return ok(await api("GET", `/cutlists/${cutlistId}/parts`));
    } catch (e) {
      return err(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Cutlists — Write (full mode only)
// ---------------------------------------------------------------------------

if (MODE === "full") {
  server.registerTool(
    "dodi_cutlists_create",
    {
      title: "Create Cutlist",
      description: "Create a new cutlist from parts. Requires name, parts array, and optimization params.",
      inputSchema: {
        name: z.string().describe("Cutlist name"),
        parts: z
          .array(
            z.object({
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
            }),
          )
          .min(1)
          .describe("Parts / BOM line items"),
        params: z
          .object({
            materialDesc: z.string().describe("Material description"),
            uniqueMaterials: z.array(z.string()).optional().describe("Unique material list"),
            grainDirection: z.string().optional().describe("Grain direction"),
            assumedThickness: z.number().optional().describe("Assumed material thickness"),
          })
          .describe("Optimization parameters"),
      },
    },
    async (input) => {
      try {
        return ok(await api("POST", "/cutlists", input));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_cutlists_update",
    {
      title: "Update Cutlist",
      description: "Update a cutlist's name, description, or parts.",
      inputSchema: {
        cutlistId: z.string().describe("Cutlist ID to update"),
        name: z.string().optional().describe("New name"),
        description: z.string().optional().describe("New description"),
      },
    },
    async ({ cutlistId, ...body }) => {
      try {
        return ok(await api("PUT", `/cutlists/${cutlistId}`, body));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "dodi_cutlists_delete",
    {
      title: "Delete Cutlist",
      description: "Delete a cutlist.",
      inputSchema: {
        cutlistId: z.string().describe("Cutlist ID to delete"),
      },
    },
    async ({ cutlistId }) => {
      try {
        return ok(await api("DELETE", `/cutlists/${cutlistId}`));
      } catch (e) {
        return err(e);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

process.stderr.write(`dodi-ops: starting (mode=${MODE}, agent=${AGENT_ID}, url=${API_URL})\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
