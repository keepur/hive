#!/usr/bin/env node

/**
 * Linear MCP Server — runs as a stdio subprocess inside each agent's Claude Code session.
 * Gives agents the ability to list teams, create/read/update/search issues, manage workflow states,
 * and manage labels (list/create labels, add/remove labels on issues).
 *
 * Env vars:
 *   LINEAR_API_KEY  — Linear API key (required)
 *   LINEAR_TEAM_ID  — Default team ID (optional — agents discover their own team via linear_list_teams)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LinearClient } from "./linear-client.js";

const API_KEY = process.env.LINEAR_API_KEY ?? "";
const DEFAULT_TEAM_ID = process.env.LINEAR_TEAM_ID || undefined;

if (!API_KEY) {
  process.stderr.write("linear-mcp-server: LINEAR_API_KEY is required\n");
  process.exit(1);
}

const linearClient = new LinearClient(API_KEY, DEFAULT_TEAM_ID);
const server = new McpServer({ name: "linear", version: "1.0.0" });

// ── State Name Resolution ──────────────────────────────────────────────────

const stateCaches = new Map<string, Map<string, string>>();

async function resolveStateName(name: string, teamId?: string): Promise<string | undefined> {
  const tid = teamId ?? DEFAULT_TEAM_ID;
  if (!tid) return undefined;
  if (!stateCaches.has(tid)) {
    const states = await linearClient.getWorkflowStates(tid);
    stateCaches.set(tid, new Map(states.map((s) => [s.name.toLowerCase(), s.id])));
  }
  return stateCaches.get(tid)!.get(name.toLowerCase());
}

// ── Label Name Resolution ──────────────────────────────────────────────────

const labelCaches = new Map<string, Map<string, string>>();

function labelCacheKey(teamId?: string): string {
  return teamId ?? DEFAULT_TEAM_ID ?? "*";
}

async function loadLabelCache(teamId?: string): Promise<Map<string, string>> {
  const key = labelCacheKey(teamId);
  if (!labelCaches.has(key)) {
    const labels = await linearClient.listLabels(teamId);
    // Group labels can't be applied to issues — keep them out of the resolvable set
    labelCaches.set(key, new Map(labels.filter((l) => !l.isGroup).map((l) => [l.name.toLowerCase(), l.id])));
  }
  return labelCaches.get(key)!;
}

/** Resolve label names to IDs. Refreshes the cache once on a miss (labels may be newly created). */
async function resolveLabelNames(names: string[], teamId?: string): Promise<{ ids: string[]; unknown: string[] }> {
  let cache = await loadLabelCache(teamId);
  if (names.some((n) => !cache.has(n.toLowerCase()))) {
    labelCaches.delete(labelCacheKey(teamId));
    cache = await loadLabelCache(teamId);
  }
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const id = cache.get(name.toLowerCase());
    if (id) ids.push(id);
    else unknown.push(name);
  }
  return { ids, unknown };
}

function unknownLabelsMessage(unknown: string[]): string {
  return `Unknown label(s): ${unknown.join(", ")}. Use linear_list_labels to see available labels (group labels cannot be applied to issues), or linear_create_label to create one.`;
}

// ── Issue ID Resolution ────────────────────────────────────────────────────

async function resolveIssueId(issueId: string): Promise<string | null> {
  // If it looks like a UUID, return as-is
  if (issueId.match(/^[0-9a-f]{8}-/i)) return issueId;
  // Otherwise, try to find by identifier (e.g. "HIVE-42")
  const issue = await linearClient.findIssueByIdentifier(issueId);
  return issue?.id ?? null;
}

// ── Tool: linear_list_teams ────────────────────────────────────────────────

server.registerTool(
  "linear_list_teams",
  {
    title: "List Teams",
    description:
      "List all Linear teams accessible to Hive. Use this to find your team ID when first setting up Linear access.",
    inputSchema: {},
  },
  async () => {
    try {
      const teams = await linearClient.listTeams();
      if (teams.length === 0) {
        return { content: [{ type: "text", text: "No teams found." }] };
      }
      const lines = teams.map((t) => `${t.key}: ${t.name} (${t.id})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to list teams: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_list_issues ───────────────────────────────────────────────

server.registerTool(
  "linear_list_issues",
  {
    title: "List Issues",
    description: "List issues filtered by team and workflow state type.",
    inputSchema: {
      teamId: z.string().optional().describe("Team ID (defaults to LINEAR_TEAM_ID env var)"),
      statusType: z
        .enum(["backlog", "unstarted", "started", "completed", "canceled"])
        .optional()
        .describe("Filter by workflow state type"),
      assigneeEmail: z.string().optional().describe("Filter by assignee email address (e.g. user@example.com)"),
      limit: z.number().optional().default(25).describe("Max results to return"),
    },
  },
  async ({ teamId, statusType, assigneeEmail, limit }) => {
    try {
      const issues = await linearClient.listIssues({
        teamId,
        stateType: statusType,
        assigneeEmail,
        limit,
      });
      if (issues.length === 0) {
        return { content: [{ type: "text", text: "No issues found." }] };
      }
      const lines = issues.map(
        (i) => `${i.identifier}: ${i.title} [${i.state}]${i.assignee ? ` (${i.assignee.name})` : ""}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to list issues: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_get_issue ─────────────────────────────────────────────────

server.registerTool(
  "linear_get_issue",
  {
    title: "Get Issue",
    description: "Get full details of a Linear issue by identifier or UUID.",
    inputSchema: {
      issueId: z.string().describe("Issue identifier (e.g. HIVE-123) or UUID"),
    },
  },
  async ({ issueId }) => {
    try {
      const issue = await linearClient.findIssueByIdentifier(issueId);
      if (!issue) {
        return { content: [{ type: "text", text: "Issue not found." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(issue, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to get issue: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_create_issue ──────────────────────────────────────────────

server.registerTool(
  "linear_create_issue",
  {
    title: "Create Issue",
    description: "Create a new issue in the specified or default Linear team.",
    inputSchema: {
      title: z.string().describe("Issue title"),
      teamId: z.string().optional().describe("Team ID (defaults to LINEAR_TEAM_ID env var)"),
      description: z.string().optional().describe("Issue description (markdown)"),
      priority: z.number().optional().describe("Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low"),
      stateName: z.string().optional().describe("Workflow state name (e.g. 'In Progress', 'Todo')"),
      labels: z.array(z.string()).optional().describe("Label names to apply (see linear_list_labels)"),
    },
  },
  async ({ title, teamId, description, priority, stateName, labels }) => {
    try {
      let stateId: string | undefined;
      if (stateName) {
        stateId = await resolveStateName(stateName, teamId);
      }
      let labelIds: string[] | undefined;
      if (labels && labels.length > 0) {
        const resolved = await resolveLabelNames(labels, teamId);
        if (resolved.unknown.length > 0) {
          return { content: [{ type: "text", text: unknownLabelsMessage(resolved.unknown) }], isError: true };
        }
        labelIds = resolved.ids;
      }
      const result = await linearClient.createIssue(title, {
        teamId,
        description,
        priority,
        stateId,
        labelIds,
      });
      if (!result) {
        return { content: [{ type: "text", text: "Failed to create issue." }], isError: true };
      }
      return { content: [{ type: "text", text: `Created ${result.identifier}: ${result.url}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to create issue: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_update_issue ──────────────────────────────────────────────

server.registerTool(
  "linear_update_issue",
  {
    title: "Update Issue",
    description: "Update fields on an existing Linear issue.",
    inputSchema: {
      issueId: z.string().describe("Issue identifier (e.g. HIVE-123) or UUID"),
      title: z.string().optional().describe("New issue title"),
      description: z.string().optional().describe("New description (markdown)"),
      priority: z.number().optional().describe("Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low"),
      stateName: z.string().optional().describe("Workflow state name (e.g. 'In Progress', 'Done')"),
      addLabels: z.array(z.string()).optional().describe("Label names to add (see linear_list_labels)"),
      removeLabels: z.array(z.string()).optional().describe("Label names to remove"),
    },
  },
  async ({ issueId, title, description, priority, stateName, addLabels, removeLabels }) => {
    try {
      const resolvedId = await resolveIssueId(issueId);
      if (!resolvedId) {
        return { content: [{ type: "text", text: "Issue not found." }] };
      }

      let stateId: string | undefined;
      if (stateName) {
        stateId = await resolveStateName(stateName);
      }

      const labelNames = [...(addLabels ?? []), ...(removeLabels ?? [])];
      const labelIdByName = new Map<string, string>();
      if (labelNames.length > 0) {
        // Resolve against the issue's own team — it may not be the default team
        const issueTeamId = await linearClient.getIssueTeamId(resolvedId);
        const resolved = await resolveLabelNames(labelNames, issueTeamId);
        if (resolved.unknown.length > 0) {
          return { content: [{ type: "text", text: unknownLabelsMessage(resolved.unknown) }], isError: true };
        }
        labelNames.forEach((name, i) => labelIdByName.set(name, resolved.ids[i]));
      }

      const fields: Record<string, unknown> = {};
      if (title !== undefined) fields.title = title;
      if (description !== undefined) fields.description = description;
      if (priority !== undefined) fields.priority = priority;
      if (stateId !== undefined) fields.stateId = stateId;

      if (Object.keys(fields).length > 0) {
        const ok = await linearClient.updateIssue(
          resolvedId,
          fields as {
            title?: string;
            description?: string;
            priority?: number;
            stateId?: string;
          },
        );
        if (!ok) {
          return { content: [{ type: "text", text: "Failed to update issue." }], isError: true };
        }
      }

      const labelFailures: string[] = [];
      for (const name of addLabels ?? []) {
        const ok = await linearClient.addLabelToIssue(resolvedId, labelIdByName.get(name)!);
        if (!ok) labelFailures.push(`add ${name}`);
      }
      for (const name of removeLabels ?? []) {
        const ok = await linearClient.removeLabelFromIssue(resolvedId, labelIdByName.get(name)!);
        if (!ok) labelFailures.push(`remove ${name}`);
      }
      if (labelFailures.length > 0) {
        return {
          content: [{ type: "text", text: `Issue updated, but label changes failed: ${labelFailures.join(", ")}.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: "Issue updated." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to update issue: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_add_comment ───────────────────────────────────────────────

server.registerTool(
  "linear_add_comment",
  {
    title: "Add Comment",
    description: "Add a comment to an existing Linear issue.",
    inputSchema: {
      issueId: z.string().describe("Issue identifier (e.g. HIVE-123) or UUID"),
      body: z.string().describe("Comment text (markdown)"),
    },
  },
  async ({ issueId, body }) => {
    try {
      const resolvedId = await resolveIssueId(issueId);
      if (!resolvedId) {
        return { content: [{ type: "text", text: "Issue not found." }] };
      }
      const commentId = await linearClient.addComment(resolvedId, body);
      if (!commentId) {
        return { content: [{ type: "text", text: "Failed to add comment." }] };
      }
      return { content: [{ type: "text", text: "Comment added." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to add comment: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_search ────────────────────────────────────────────────────

server.registerTool(
  "linear_search",
  {
    title: "Search Issues",
    description: "Full-text search for Linear issues, optionally scoped to a team.",
    inputSchema: {
      query: z.string().describe("Search query"),
      teamId: z.string().optional().describe("Team ID to scope search to"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
  },
  async ({ query, teamId, limit }) => {
    try {
      const issues = await linearClient.searchIssues(query, limit, teamId);
      if (issues.length === 0) {
        return { content: [{ type: "text", text: "No results." }] };
      }
      const lines = issues.map(
        (i) => `${i.identifier}: ${i.title} [${i.state}]${i.assignee ? ` (${i.assignee.name})` : ""}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to search issues: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_search_users ──────────────────────────────────────────────

server.registerTool(
  "linear_search_users",
  {
    title: "Search Users",
    description: "Search for Linear workspace members by name, display name, or email address.",
    inputSchema: {
      query: z.string().describe("Name, display name, or email to search for"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
  },
  async ({ query, limit }) => {
    try {
      const users = await linearClient.searchUsers(query, limit);
      if (users.length === 0) {
        return { content: [{ type: "text", text: "No users found." }] };
      }
      const lines = users.map(
        (u) => `${u.name} (${u.displayName}) — ${u.email} [id: ${u.id}]${u.active ? "" : " [inactive]"}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to search users: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_list_states ───────────────────────────────────────────────

server.registerTool(
  "linear_list_states",
  {
    title: "List Workflow States",
    description:
      "List workflow states for a team. Use this to see available states before creating or updating issues.",
    inputSchema: {
      teamId: z.string().optional().describe("Team ID (defaults to LINEAR_TEAM_ID env var)"),
    },
  },
  async ({ teamId }) => {
    try {
      const states = await linearClient.getWorkflowStates(teamId);
      if (states.length === 0) {
        return { content: [{ type: "text", text: "No workflow states found." }] };
      }
      const lines = states.map((s) => `${s.name} (${s.type})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to list workflow states: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_list_labels ───────────────────────────────────────────────

server.registerTool(
  "linear_list_labels",
  {
    title: "List Labels",
    description:
      "List issue labels available to a team (team labels plus workspace-level labels). Use this to see label names before applying them to issues.",
    inputSchema: {
      teamId: z.string().optional().describe("Team ID (defaults to LINEAR_TEAM_ID env var)"),
    },
  },
  async ({ teamId }) => {
    try {
      const labels = await linearClient.listLabels(teamId);
      if (labels.length === 0) {
        return { content: [{ type: "text", text: "No labels found." }] };
      }
      const lines = labels.map(
        (l) =>
          `${l.name} (${l.color})${l.isGroup ? " [group — not directly assignable]" : ""}${l.description ? ` — ${l.description}` : ""}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to list labels: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: linear_create_label ──────────────────────────────────────────────

server.registerTool(
  "linear_create_label",
  {
    title: "Create Label",
    description: "Create a new issue label in the specified or default Linear team.",
    inputSchema: {
      name: z.string().describe("Label name"),
      teamId: z.string().optional().describe("Team ID (defaults to LINEAR_TEAM_ID env var)"),
      color: z.string().optional().describe("Hex color (e.g. '#5e6ad2'); Linear assigns one if omitted"),
      description: z.string().optional().describe("Label description"),
    },
  },
  async ({ name, teamId, color, description }) => {
    try {
      const label = await linearClient.createLabel(name, { teamId, color, description });
      if (!label) {
        return { content: [{ type: "text", text: "Failed to create label." }], isError: true };
      }
      labelCaches.clear();
      return { content: [{ type: "text", text: `Created label "${label.name}" (${label.color}).` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to create label: ${String(err)}` }], isError: true };
    }
  },
);

// ── Connect and run ────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
