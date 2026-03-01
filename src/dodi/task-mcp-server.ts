#!/usr/bin/env node

/**
 * DodiHome Task MCP Server — runs as a stdio subprocess inside each agent's Claude Code session.
 * Gives agents the ability to create, read, update, query, and comment on tasks in dodi_v2.
 *
 * Env vars:
 *   DODI_API_URL — base URL for dodi_v2 API (e.g. https://app.dodihome.com)
 *   DODI_API_KEY — API key for X-API-Key header
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.DODI_API_URL ?? "http://localhost:3002";
const API_KEY = process.env.DODI_API_KEY ?? "";

if (!API_KEY) {
  process.stderr.write("task-mcp-server: DODI_API_KEY is required\n");
  process.exit(1);
}

async function api(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: {
      "X-API-Key": API_KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`DodiHome API ${res.status}: ${await res.text()}`);
  return res.json();
}

const server = new McpServer({
  name: "dodi-tasks",
  version: "0.1.0",
});

// --- Tool: task_create ---
server.registerTool("task_create", {
  title: "Create Task",
  description: "Create a new task in DodiHome.",
  inputSchema: {
    name: z.string().describe("Task title"),
    description: z.string().optional().describe("Task description (markdown)"),
    type: z.enum(["FOLLOW_UP", "ACTION_ITEM", "QA", "FABRICATION", "ASSEMBLY", "PURCHASING", "LOGISTICS"])
      .optional().default("ACTION_ITEM").describe("Task type"),
    priority: z.number().optional().describe("Priority: 1=Back Burner, 2=Low, 3=Normal, 4=High, 5=Urgent"),
    jobIds: z.array(z.string()).optional().describe("Related job IDs"),
    assignedTo: z.string().optional().describe("User ID to assign to"),
    dueDate: z.string().optional().describe("Due date (ISO 8601)"),
  },
}, async (input) => {
  try {
    const result = await api("POST", "/tasks", input);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to create task: ${String(err)}` }], isError: true };
  }
});

// --- Tool: task_get ---
server.registerTool("task_get", {
  title: "Get Task",
  description: "Get full details of a task by ID.",
  inputSchema: {
    taskId: z.string().describe("Task ID"),
  },
}, async ({ taskId }) => {
  try {
    const result = await api("GET", `/tasks/${taskId}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to get task: ${String(err)}` }], isError: true };
  }
});

// --- Tool: task_update ---
server.registerTool("task_update", {
  title: "Update Task",
  description: "Update a task's state, priority, assignee, description, or due date.",
  inputSchema: {
    taskId: z.string().describe("Task ID"),
    state: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "PAUSED", "DONE"]).optional().describe("Task state"),
    priority: z.number().optional().describe("Priority: 1=Back Burner, 2=Low, 3=Normal, 4=High, 5=Urgent"),
    assignedTo: z.string().optional().describe("User ID to assign to"),
    description: z.string().optional().describe("Updated description (markdown)"),
    dueDate: z.string().optional().describe("Due date (ISO 8601)"),
  },
}, async ({ taskId, ...updates }) => {
  try {
    const result = await api("PUT", `/tasks/${taskId}`, updates);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to update task: ${String(err)}` }], isError: true };
  }
});

// --- Tool: task_list ---
server.registerTool("task_list", {
  title: "List Tasks",
  description: "List tasks with optional filters.",
  inputSchema: {
    state: z.string().optional().describe("Filter by state: TODO, IN_PROGRESS, BLOCKED, PAUSED, DONE"),
    type: z.string().optional().describe("Filter by type: FOLLOW_UP, ACTION_ITEM, QA, FABRICATION, ASSEMBLY, PURCHASING, LOGISTICS"),
    assignedTo: z.string().optional().describe("Filter by assignee user ID"),
    limit: z.number().optional().default(20).describe("Max results to return"),
  },
}, async (input) => {
  try {
    const params = new URLSearchParams();
    if (input.state) params.set("state", input.state);
    if (input.type) params.set("type", input.type);
    if (input.assignedTo) params.set("assignedTo", input.assignedTo);
    if (input.limit) params.set("limit", String(input.limit));
    const qs = params.toString();
    const result = await api("GET", `/tasks${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to list tasks: ${String(err)}` }], isError: true };
  }
});

// --- Tool: task_add_comment ---
server.registerTool("task_add_comment", {
  title: "Add Comment",
  description: "Add a comment to an existing task.",
  inputSchema: {
    taskId: z.string().describe("Task ID"),
    body: z.string().describe("Comment text (markdown)"),
  },
}, async ({ taskId, body }) => {
  try {
    const result = await api("POST", `/tasks/${taskId}/comments`, { body });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to add comment: ${String(err)}` }], isError: true };
  }
});

// --- Tool: task_search ---
server.registerTool("task_search", {
  title: "Search Tasks",
  description: "Search tasks by text query.",
  inputSchema: {
    query: z.string().describe("Search query"),
    limit: z.number().optional().default(20).describe("Max results to return"),
  },
}, async (input) => {
  try {
    const params = new URLSearchParams({ q: input.query });
    if (input.limit) params.set("limit", String(input.limit));
    const result = await api("GET", `/tasks?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to search tasks: ${String(err)}` }], isError: true };
  }
});

// Connect and run
const transport = new StdioServerTransport();
await server.connect(transport);
