#!/usr/bin/env node

/**
 * Task Ledger MCP Server — runs as a stdio subprocess inside each agent's Claude Code session.
 * Gives agents the ability to create, read, update, query, and comment on tasks
 * in dodi_v2's task system.
 *
 * Env vars:
 *   TASK_LEDGER_API_URL — base URL for the task API (default: http://localhost:3002)
 *   TASK_LEDGER_API_KEY — per-agent API key for X-API-Key header
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.TASK_LEDGER_API_URL ?? "http://localhost:3002";
const API_KEY = process.env.TASK_LEDGER_API_KEY ?? "";

if (!API_KEY) {
  process.stderr.write("task-mcp-server: TASK_LEDGER_API_KEY is required\n");
  process.exit(1);
}

async function api(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      "x-api-key": API_KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Task API ${res.status}: ${await res.text()}`);
  return res.json();
}

const server = new McpServer({
  name: "task-ledger",
  version: "0.2.0",
});

// --- Tool: task_create ---
server.registerTool("task_create", {
  title: "Create Task",
  description: "Create a new task in the task ledger.",
  inputSchema: {
    name: z.string().describe("Task title"),
    description: z.string().optional().describe("Task description"),
    type: z.enum([
      "FOLLOW_UP", "ACTION_ITEM", "AGENT", "OPS", "MILESTONE",
      "QA", "FABRICATION", "ASSEMBLY", "PURCHASING", "LOGISTICS",
      "FINISHING", "CUSTOM_BUILD", "PLANNING", "RECEIVING", "PURCHASE_ORDER",
    ]).optional().default("AGENT").describe("Task type (defaults to AGENT)"),
    assignedTo: z.object({
      personId: z.string(),
      name: z.string(),
    }).optional().describe("Person to assign to ({ personId, name })"),
    dueDate: z.string().optional().describe("Due date (ISO 8601)"),
    caseId: z.string().optional().describe("Link to a case"),
    issueId: z.string().optional().describe("Link to a Linear issue"),
    jobId: z.string().optional().describe("Link to a production job"),
    data: z.record(z.string(), z.unknown()).optional().describe("Custom type-specific data"),
  },
}, async (input) => {
  try {
    const result = await api("POST", "/tasks", input);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Failed to create task: ${String(err)}` }], isError: true };
  }
});

// --- Tool: task_get ---
server.registerTool("task_get", {
  title: "Get Task",
  description: "Get full details of a task by ID, including dependencies.",
  inputSchema: {
    taskId: z.string().describe("Task ID"),
  },
}, async ({ taskId }) => {
  try {
    const result = await api("GET", `/tasks/${taskId}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Failed to get task: ${String(err)}` }], isError: true };
  }
});

// --- Tool: task_update ---
server.registerTool("task_update", {
  title: "Update Task",
  description: "Update a task's state, priority, assignee, description, name, or due date.",
  inputSchema: {
    taskId: z.string().describe("Task ID"),
    name: z.string().optional().describe("Updated task title"),
    state: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED", "ARCHIVED"])
      .optional().describe("Task state transition"),
    description: z.string().optional().describe("Updated description"),
    priority: z.number().min(0).max(10).optional()
      .describe("Priority (0-10)"),
    assignedTo: z.object({
      personId: z.string(),
      name: z.string(),
    }).nullable().optional().describe("Person to assign to, or null to unassign"),
    dueDate: z.string().nullable().optional().describe("Due date (ISO 8601), or null to clear"),
    data: z.record(z.string(), z.unknown()).optional().describe("Custom type-specific data (merged with existing)"),
  },
}, async ({ taskId, ...updates }) => {
  try {
    const result = await api("PUT", `/tasks/${taskId}`, updates);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Failed to update task: ${String(err)}` }], isError: true };
  }
});

// --- Tool: task_list ---
server.registerTool("task_list", {
  title: "List Tasks",
  description: "List tasks with optional filters. Returns paginated results sorted by last modified.",
  inputSchema: {
    state: z.string().optional().describe("Filter by state: TODO, IN_PROGRESS, BLOCKED, DONE, CANCELLED, ARCHIVED"),
    type: z.string().optional().describe("Filter by type: FOLLOW_UP, ACTION_ITEM, AGENT, OPS, etc."),
    assignee: z.string().optional().describe("Filter by assignee userId"),
    jobId: z.string().optional().describe("Filter by job ID"),
    caseId: z.string().optional().describe("Filter by case ID"),
    limit: z.number().min(1).max(250).optional().default(50).describe("Max results (1-250, default 50)"),
    offset: z.number().optional().default(0).describe("Pagination offset"),
  },
}, async (input) => {
  try {
    const params = new URLSearchParams();
    if (input.state) params.set("state", input.state);
    if (input.type) params.set("type", input.type);
    if (input.assignee) params.set("assignee", input.assignee);
    if (input.jobId) params.set("jobId", input.jobId);
    if (input.caseId) params.set("caseId", input.caseId);
    if (input.limit) params.set("limit", String(input.limit));
    if (input.offset) params.set("offset", String(input.offset));
    const qs = params.toString();
    const result = await api("GET", `/tasks${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Failed to list tasks: ${String(err)}` }], isError: true };
  }
});

// --- Tool: task_add_comment ---
server.registerTool("task_add_comment", {
  title: "Add Comment",
  description: "Add a comment to an existing task.",
  inputSchema: {
    taskId: z.string().describe("Task ID"),
    content: z.string().describe("Comment text"),
    contentFormat: z.enum(["text", "html"]).optional().default("text").describe("Comment format"),
  },
}, async ({ taskId, content, contentFormat }) => {
  try {
    const result = await api("POST", `/tasks/${taskId}/comments`, { content, contentFormat });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Failed to add comment: ${String(err)}` }], isError: true };
  }
});

// Connect and run
const transport = new StdioServerTransport();
await server.connect(transport);
