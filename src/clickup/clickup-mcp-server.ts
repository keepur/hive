#!/usr/bin/env node

/**
 * ClickUp MCP Server — Task management across multiple workspaces.
 *
 * Provides agents with full CRUD access to ClickUp tasks, lists, and comments.
 * Supports multiple workspaces for users wearing many hats.
 *
 * Env vars:
 *   CLICKUP_API_TOKEN — required, personal API token from ClickUp settings
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_TOKEN = process.env.CLICKUP_API_TOKEN ?? "";
const BASE_URL = "https://api.clickup.com/api/v2";

const server = new McpServer({
  name: "hive-clickup",
  version: "0.1.0",
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function clickup(path: string, method = "GET", body?: unknown): Promise<any> {
  if (!API_TOKEN) throw new Error("CLICKUP_API_TOKEN not configured");

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: API_TOKEN,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ClickUp API ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function formatTask(t: any): string {
  const assignees = t.assignees?.map((a: any) => a.username || a.email).join(", ") || "unassigned";
  const due = t.due_date ? new Date(Number(t.due_date)).toISOString().split("T")[0] : "no due date";
  const priority = t.priority?.priority || "none";
  return [
    `**${t.name}** (${t.id})`,
    `  Status: ${t.status?.status ?? "unknown"} | Priority: ${priority} | Due: ${due}`,
    `  Assignees: ${assignees}`,
    ...(t.description
      ? [`  Description: ${t.description.slice(0, 200)}${t.description.length > 200 ? "..." : ""}`]
      : []),
    `  URL: ${t.url ?? ""}`,
  ].join("\n");
}

// ── Navigation Tools ─────────────────────────────────────────────────────

server.registerTool(
  "clickup_list_workspaces",
  {
    title: "List ClickUp Workspaces",
    description: "List all workspaces (teams) accessible with the configured API token.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await clickup("/team");
      const teams = data.teams ?? [];
      if (teams.length === 0) {
        return { content: [{ type: "text", text: "No workspaces found." }] };
      }
      const lines = teams.map((t: any) => `- **${t.name}** (ID: ${t.id}) — ${t.members?.length ?? 0} members`);
      return { content: [{ type: "text", text: `Workspaces:\n${lines.join("\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

server.registerTool(
  "clickup_list_spaces",
  {
    title: "List Spaces",
    description: "List all spaces in a workspace.",
    inputSchema: {
      workspace_id: z.string().describe("Workspace (team) ID"),
    },
  },
  async ({ workspace_id }) => {
    try {
      const data = await clickup(`/team/${workspace_id}/space?archived=false`);
      const spaces = data.spaces ?? [];
      if (spaces.length === 0) {
        return { content: [{ type: "text", text: "No spaces found." }] };
      }
      const lines = spaces.map((s: any) => `- **${s.name}** (ID: ${s.id})`);
      return { content: [{ type: "text", text: `Spaces:\n${lines.join("\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

server.registerTool(
  "clickup_list_folders",
  {
    title: "List Folders",
    description: "List all folders in a space.",
    inputSchema: {
      space_id: z.string().describe("Space ID"),
    },
  },
  async ({ space_id }) => {
    try {
      const data = await clickup(`/space/${space_id}/folder?archived=false`);
      const folders = data.folders ?? [];
      if (folders.length === 0) {
        return { content: [{ type: "text", text: "No folders found in this space." }] };
      }
      const lines = folders.map((f: any) => {
        const lists = f.lists?.map((l: any) => `${l.name} (${l.id})`).join(", ") || "no lists";
        return `- **${f.name}** (ID: ${f.id}) — Lists: ${lists}`;
      });
      return { content: [{ type: "text", text: `Folders:\n${lines.join("\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

server.registerTool(
  "clickup_list_lists",
  {
    title: "List Lists",
    description: "List all lists in a folder. For folderless lists, use clickup_list_folderless_lists.",
    inputSchema: {
      folder_id: z.string().describe("Folder ID"),
    },
  },
  async ({ folder_id }) => {
    try {
      const data = await clickup(`/folder/${folder_id}/list?archived=false`);
      const lists = data.lists ?? [];
      if (lists.length === 0) {
        return { content: [{ type: "text", text: "No lists found in this folder." }] };
      }
      const lines = lists.map((l: any) => {
        const count = l.task_count ?? "?";
        return `- **${l.name}** (ID: ${l.id}) — ${count} tasks`;
      });
      return { content: [{ type: "text", text: `Lists:\n${lines.join("\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

server.registerTool(
  "clickup_list_folderless_lists",
  {
    title: "List Folderless Lists",
    description: "List all lists in a space that are not inside a folder.",
    inputSchema: {
      space_id: z.string().describe("Space ID"),
    },
  },
  async ({ space_id }) => {
    try {
      const data = await clickup(`/space/${space_id}/list?archived=false`);
      const lists = data.lists ?? [];
      if (lists.length === 0) {
        return { content: [{ type: "text", text: "No folderless lists found." }] };
      }
      const lines = lists.map((l: any) => `- **${l.name}** (ID: ${l.id}) — ${l.task_count ?? "?"} tasks`);
      return { content: [{ type: "text", text: `Folderless lists:\n${lines.join("\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Task Tools ───────────────────────────────────────────────────────────

server.registerTool(
  "clickup_get_tasks",
  {
    title: "Get Tasks",
    description: "Get tasks from a list. Supports filtering by status, assignee, and due date.",
    inputSchema: {
      list_id: z.string().describe("List ID"),
      statuses: z.array(z.string()).optional().describe("Filter by statuses (e.g. ['open', 'in progress'])"),
      assignees: z.array(z.string()).optional().describe("Filter by assignee user IDs"),
      include_closed: z.boolean().optional().describe("Include closed/done tasks (default false)"),
      page: z.number().optional().describe("Page number (0-indexed, default 0)"),
    },
  },
  async ({ list_id, statuses, assignees, include_closed, page }) => {
    try {
      const params = new URLSearchParams();
      if (statuses) statuses.forEach((s) => params.append("statuses[]", s));
      if (assignees) assignees.forEach((a) => params.append("assignees[]", a));
      if (include_closed) params.set("include_closed", "true");
      params.set("page", String(page ?? 0));
      params.set("subtasks", "true");

      const data = await clickup(`/list/${list_id}/task?${params}`);
      const tasks = data.tasks ?? [];
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks found." }] };
      }
      const lines = tasks.map(formatTask);
      return { content: [{ type: "text", text: `Tasks (${tasks.length}):\n\n${lines.join("\n\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

server.registerTool(
  "clickup_search_tasks",
  {
    title: "Search Tasks",
    description: "Search for tasks across an entire workspace by name or custom field values.",
    inputSchema: {
      workspace_id: z.string().describe("Workspace (team) ID to search in"),
      query: z.string().describe("Search query — matches task names"),
      include_closed: z.boolean().optional().describe("Include closed/done tasks (default false)"),
    },
  },
  async ({ workspace_id, query, include_closed }) => {
    try {
      const params = new URLSearchParams();
      params.set("name", query);
      if (include_closed) params.set("include_closed", "true");
      params.set("subtasks", "true");

      const data = await clickup(`/team/${workspace_id}/task?${params}`);
      const tasks = data.tasks ?? [];
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: `No tasks found matching "${query}".` }] };
      }
      const lines = tasks.map(formatTask);
      return {
        content: [{ type: "text", text: `Search results for "${query}" (${tasks.length}):\n\n${lines.join("\n\n")}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

server.registerTool(
  "clickup_get_task",
  {
    title: "Get Task",
    description: "Get full details for a single task by ID.",
    inputSchema: {
      task_id: z.string().describe("Task ID"),
    },
  },
  async ({ task_id }) => {
    try {
      const t = await clickup(`/task/${task_id}?include_subtasks=true`);
      const subtasks = t.subtasks?.length
        ? `\n  Subtasks:\n${t.subtasks.map((s: any) => `    - ${s.name} (${s.id}) [${s.status?.status}]`).join("\n")}`
        : "";
      const checklists = t.checklists?.length
        ? `\n  Checklists:\n${t.checklists.map((c: any) => `    ${c.name}: ${c.items?.map((i: any) => `${i.resolved ? "✓" : "○"} ${i.name}`).join(", ")}`).join("\n")}`
        : "";
      const customFields = t.custom_fields?.filter((f: any) => f.value != null).length
        ? `\n  Custom fields:\n${t.custom_fields
            .filter((f: any) => f.value != null)
            .map((f: any) => `    ${f.name}: ${JSON.stringify(f.value)}`)
            .join("\n")}`
        : "";

      return { content: [{ type: "text", text: `${formatTask(t)}${subtasks}${checklists}${customFields}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

server.registerTool(
  "clickup_create_task",
  {
    title: "Create Task",
    description: "Create a new task in a list.",
    inputSchema: {
      list_id: z.string().describe("List ID to create the task in"),
      name: z.string().describe("Task name"),
      description: z.string().optional().describe("Task description (markdown supported)"),
      status: z.string().optional().describe("Task status (must match list's statuses)"),
      priority: z.number().optional().describe("Priority: 1=urgent, 2=high, 3=normal, 4=low"),
      due_date: z.string().optional().describe("Due date as ISO string (e.g. 2026-03-15)"),
      assignees: z.array(z.number()).optional().describe("User IDs to assign"),
      tags: z.array(z.string()).optional().describe("Tag names to apply"),
    },
  },
  async ({ list_id, name, description, status, priority, due_date, assignees, tags }) => {
    try {
      const body: Record<string, unknown> = { name };
      if (description) body.description = description;
      if (status) body.status = status;
      if (priority) body.priority = priority;
      if (due_date) body.due_date = new Date(due_date).getTime();
      if (assignees) body.assignees = assignees;
      if (tags) body.tags = tags;

      const t = await clickup(`/list/${list_id}/task`, "POST", body);
      return { content: [{ type: "text", text: `Task created:\n${formatTask(t)}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

server.registerTool(
  "clickup_update_task",
  {
    title: "Update Task",
    description: "Update an existing task's name, status, priority, due date, or assignees.",
    inputSchema: {
      task_id: z.string().describe("Task ID"),
      name: z.string().optional().describe("New task name"),
      description: z.string().optional().describe("New description"),
      status: z.string().optional().describe("New status"),
      priority: z.number().optional().describe("Priority: 1=urgent, 2=high, 3=normal, 4=low"),
      due_date: z.string().optional().describe("New due date as ISO string"),
      add_assignees: z.array(z.number()).optional().describe("User IDs to add as assignees"),
      remove_assignees: z.array(z.number()).optional().describe("User IDs to remove from assignees"),
    },
  },
  async ({ task_id, name, description, status, priority, due_date, add_assignees, remove_assignees }) => {
    try {
      const body: Record<string, unknown> = {};
      if (name) body.name = name;
      if (description) body.description = description;
      if (status) body.status = status;
      if (priority) body.priority = priority;
      if (due_date) body.due_date = new Date(due_date).getTime();
      if (add_assignees || remove_assignees) {
        body.assignees = {
          add: add_assignees ?? [],
          rem: remove_assignees ?? [],
        };
      }

      const t = await clickup(`/task/${task_id}`, "PUT", body);
      return { content: [{ type: "text", text: `Task updated:\n${formatTask(t)}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Comment Tools ────────────────────────────────────────────────────────

server.registerTool(
  "clickup_get_comments",
  {
    title: "Get Task Comments",
    description: "Get all comments on a task.",
    inputSchema: {
      task_id: z.string().describe("Task ID"),
    },
  },
  async ({ task_id }) => {
    try {
      const data = await clickup(`/task/${task_id}/comment`);
      const comments = data.comments ?? [];
      if (comments.length === 0) {
        return { content: [{ type: "text", text: "No comments on this task." }] };
      }
      const lines = comments.map((c: any) => {
        const author = c.user?.username || c.user?.email || "unknown";
        const date = new Date(Number(c.date)).toISOString().split("T")[0];
        const text = c.comment_text || c.comment?.map((seg: any) => seg.text).join("") || "";
        return `- **${author}** (${date}): ${text}`;
      });
      return { content: [{ type: "text", text: `Comments (${comments.length}):\n${lines.join("\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

server.registerTool(
  "clickup_create_comment",
  {
    title: "Create Task Comment",
    description: "Add a comment to a task.",
    inputSchema: {
      task_id: z.string().describe("Task ID"),
      text: z.string().describe("Comment text"),
    },
  },
  async ({ task_id, text }) => {
    try {
      await clickup(`/task/${task_id}/comment`, "POST", { comment_text: text });
      return { content: [{ type: "text", text: `Comment added to task ${task_id}.` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Connect ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
