#!/usr/bin/env node

/**
 * GitHub Issues MCP Server — runs as a stdio subprocess inside each agent's Claude Code session.
 * Gives agents the ability to list/create/update/search/close issues and manage labels.
 *
 * Env vars:
 *   GITHUB_REPO  — owner/repo (required, e.g. "dodihome/hive")
 *   GH_TOKEN     — GitHub personal access token (optional if gh CLI is already authed)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFileSync } from "node:child_process";
import { z } from "zod";

const REPO = process.env.GITHUB_REPO ?? "";
const TOKEN = process.env.GH_TOKEN ?? "";

if (!REPO) {
  process.stderr.write("github-issues-mcp-server: GITHUB_REPO is required\n");
  process.exit(1);
}

function gh(args: string[]): string {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (TOKEN) env.GH_TOKEN = TOKEN;
  return execFileSync("gh", args, { encoding: "utf-8", env, maxBuffer: 10 * 1024 * 1024 });
}

function ghJson(args: string[], jsonFields: string[]): unknown {
  const raw = gh([...args, "--repo", REPO, "--json", jsonFields.join(",")]);
  return JSON.parse(raw);
}

const server = new McpServer({ name: "github-issues", version: "1.0.0" });

// ── Tool: github_list_issues ─────────────────────────────────────────────────

server.registerTool(
  "github_list_issues",
  {
    title: "List Issues",
    description: "List GitHub issues filtered by state, labels, assignee, or search query.",
    inputSchema: {
      state: z.enum(["open", "closed", "all"]).optional().default("open").describe("Issue state filter"),
      labels: z.string().optional().describe("Comma-separated label names to filter by"),
      assignee: z.string().optional().describe("GitHub username to filter by assignee"),
      search: z.string().optional().describe("Search query to filter issues"),
      limit: z.number().optional().default(25).describe("Max results to return"),
    },
  },
  async ({ state, labels, assignee, search, limit }) => {
    try {
      const args = ["issue", "list", "--repo", REPO, "--state", state ?? "open", "--limit", String(limit ?? 25)];
      if (labels) args.push("--label", labels);
      if (assignee) args.push("--assignee", assignee);
      if (search) args.push("--search", search);
      args.push("--json", "number,title,state,labels,assignees,url");
      const raw = gh(args);
      const issues = JSON.parse(raw) as Array<{
        number: number;
        title: string;
        state: string;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
        url: string;
      }>;
      if (issues.length === 0) {
        return { content: [{ type: "text" as const, text: "No issues found." }] };
      }
      const lines = issues.map(
        (i) =>
          `#${i.number}: ${i.title} [${i.state}] ${i.labels.map((l) => l.name).join(", ")} ${i.assignees.map((a) => `@${a.login}`).join(", ")} ${i.url}`,
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to list issues: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: github_get_issue ───────────────────────────────────────────────────

server.registerTool(
  "github_get_issue",
  {
    title: "Get Issue",
    description: "Get full details of a GitHub issue by number.",
    inputSchema: {
      number: z.number().describe("Issue number"),
    },
  },
  async ({ number }) => {
    try {
      const raw = gh([
        "issue",
        "view",
        String(number),
        "--repo",
        REPO,
        "--json",
        "number,title,state,body,labels,assignees,comments,url,createdAt,updatedAt",
      ]);
      const issue = JSON.parse(raw);
      return { content: [{ type: "text" as const, text: JSON.stringify(issue, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to get issue: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: github_create_issue ────────────────────────────────────────────────

server.registerTool(
  "github_create_issue",
  {
    title: "Create Issue",
    description: "Create a new GitHub issue.",
    inputSchema: {
      title: z.string().describe("Issue title"),
      body: z.string().optional().describe("Issue body (markdown)"),
      labels: z.array(z.string()).optional().describe("Labels to apply"),
      assignee: z.string().optional().describe("GitHub username to assign"),
    },
  },
  async ({ title, body, labels, assignee }) => {
    try {
      const args = ["issue", "create", "--repo", REPO, "--title", title];
      if (body) args.push("--body", body);
      if (labels && labels.length > 0) {
        for (const label of labels) args.push("--label", label);
      }
      if (assignee) args.push("--assignee", assignee);
      const raw = gh(args);
      // gh issue create outputs the URL of the new issue
      const url = raw.trim();
      const num = url.split("/").pop();
      return { content: [{ type: "text" as const, text: `Created issue #${num}: ${url}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to create issue: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: github_update_issue ────────────────────────────────────────────────

server.registerTool(
  "github_update_issue",
  {
    title: "Update Issue",
    description: "Update fields on an existing GitHub issue.",
    inputSchema: {
      number: z.number().describe("Issue number"),
      title: z.string().optional().describe("New title"),
      body: z.string().optional().describe("New body (markdown)"),
      addLabels: z.array(z.string()).optional().describe("Labels to add"),
      removeLabels: z.array(z.string()).optional().describe("Labels to remove"),
      assignee: z.string().optional().describe("GitHub username to assign"),
      state: z.enum(["open", "closed"]).optional().describe("Set issue state"),
    },
  },
  async ({ number, title, body, addLabels, removeLabels, assignee, state }) => {
    try {
      const args = ["issue", "edit", String(number), "--repo", REPO];
      if (title) args.push("--title", title);
      if (body) args.push("--body", body);
      if (addLabels && addLabels.length > 0) {
        for (const label of addLabels) args.push("--add-label", label);
      }
      if (removeLabels && removeLabels.length > 0) {
        for (const label of removeLabels) args.push("--remove-label", label);
      }
      if (assignee) args.push("--add-assignee", assignee);
      gh(args);

      // Handle state change separately — gh issue edit doesn't support --state
      if (state === "closed") {
        gh(["issue", "close", String(number), "--repo", REPO]);
      } else if (state === "open") {
        gh(["issue", "reopen", String(number), "--repo", REPO]);
      }

      return { content: [{ type: "text" as const, text: `Issue #${number} updated.` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to update issue: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: github_add_comment ─────────────────────────────────────────────────

server.registerTool(
  "github_add_comment",
  {
    title: "Add Comment",
    description: "Add a comment to an existing GitHub issue.",
    inputSchema: {
      number: z.number().describe("Issue number"),
      body: z.string().describe("Comment text (markdown)"),
    },
  },
  async ({ number, body }) => {
    try {
      gh(["issue", "comment", String(number), "--repo", REPO, "--body", body]);
      return { content: [{ type: "text" as const, text: `Comment added to issue #${number}.` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to add comment: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: github_search_issues ───────────────────────────────────────────────

server.registerTool(
  "github_search_issues",
  {
    title: "Search Issues",
    description:
      "Search GitHub issues by text query. Uses the repo-scoped REST Issues API for real-time, consistent results.",
    inputSchema: {
      query: z.string().describe("Search query"),
      state: z.enum(["open", "closed", "all"]).optional().default("open").describe("Issue state filter"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
  },
  async ({ query, state, limit }) => {
    try {
      const args = [
        "issue",
        "list",
        "--repo",
        REPO,
        "--search",
        query,
        "--state",
        state ?? "open",
        "--limit",
        String(limit ?? 10),
        "--json",
        "number,title,state,labels,url",
      ];
      const raw = gh(args);
      const issues = JSON.parse(raw) as Array<{
        number: number;
        title: string;
        state: string;
        labels: Array<{ name: string }>;
        url: string;
      }>;
      if (issues.length === 0) {
        return { content: [{ type: "text" as const, text: "No results." }] };
      }
      const lines = issues.map(
        (i) => `#${i.number}: ${i.title} [${i.state}] ${i.labels.map((l) => l.name).join(", ")}`,
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to search issues: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: github_close_issue ─────────────────────────────────────────────────

server.registerTool(
  "github_close_issue",
  {
    title: "Close Issue",
    description: "Close a GitHub issue with an optional comment.",
    inputSchema: {
      number: z.number().describe("Issue number"),
      comment: z.string().optional().describe("Optional closing comment"),
    },
  },
  async ({ number, comment }) => {
    try {
      if (comment) {
        gh(["issue", "comment", String(number), "--repo", REPO, "--body", comment]);
      }
      gh(["issue", "close", String(number), "--repo", REPO]);
      return { content: [{ type: "text" as const, text: `Issue #${number} closed.` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to close issue: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: github_list_labels ─────────────────────────────────────────────────

server.registerTool(
  "github_list_labels",
  {
    title: "List Labels",
    description: "List all available labels on the repository.",
    inputSchema: {},
  },
  async () => {
    try {
      const raw = gh(["label", "list", "--repo", REPO, "--json", "name,description,color", "--limit", "100"]);
      const labels = JSON.parse(raw) as Array<{ name: string; description: string; color: string }>;
      if (labels.length === 0) {
        return { content: [{ type: "text" as const, text: "No labels found." }] };
      }
      const lines = labels.map((l) => `${l.name}${l.description ? ` — ${l.description}` : ""}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Failed to list labels: ${String(err)}` }], isError: true };
    }
  },
);

// ── Tool: github_list_collaborators ──────────────────────────────────────────

server.registerTool(
  "github_list_collaborators",
  {
    title: "List Collaborators",
    description: "List repository collaborators. Use this to find GitHub usernames for issue assignment.",
    inputSchema: {
      limit: z.number().optional().default(30).describe("Max results to return"),
    },
  },
  async ({ limit }) => {
    try {
      const raw = gh([
        "api",
        `repos/${REPO}/collaborators`,
        "--jq",
        `.[:${limit ?? 30}] | .[] | "\\(.login) (\\(.role_name))"`,
      ]);
      if (!raw.trim()) {
        return { content: [{ type: "text" as const, text: "No collaborators found." }] };
      }
      return { content: [{ type: "text" as const, text: raw.trim() }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to list collaborators: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Connect and run ──────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
