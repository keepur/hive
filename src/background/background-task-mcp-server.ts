#!/usr/bin/env node

/**
 * Background Task MCP Server — agent-facing interface for background tasks.
 * Runs as a stdio subprocess inside agent sessions and communicates with
 * the BackgroundTaskManager via HTTP.
 *
 * Env vars:
 *   BG_TASK_API      — Base URL of the background-task manager (default: http://127.0.0.1:3100)
 *   BG_AGENT_ID      — The agent's identifier
 *   BG_ADAPTER_ID    — Adapter identifier for context
 *   BG_CHANNEL_ID    — Channel identifier for context
 *   BG_CHANNEL_KIND  — Channel kind (default: "internal")
 *   BG_CHANNEL_LABEL — Channel label for context
 *   BG_THREAD_ID     — Thread identifier for context
 *   BG_SLACK_TS      — Slack timestamp for context
 *   BG_SLACK_THREAD_TS — Slack thread timestamp for context
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.BG_TASK_API ?? "http://127.0.0.1:3100";
const AGENT_ID = process.env.BG_AGENT_ID ?? "";

interface BackgroundTaskContext {
  agentId: string;
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
}

function buildContext(): BackgroundTaskContext {
  return {
    agentId: AGENT_ID,
    adapterId: process.env.BG_ADAPTER_ID ?? "",
    channelId: process.env.BG_CHANNEL_ID ?? "",
    channelKind: process.env.BG_CHANNEL_KIND ?? "internal",
    channelLabel: process.env.BG_CHANNEL_LABEL ?? "",
    threadId: process.env.BG_THREAD_ID ?? "",
    slackTs: process.env.BG_SLACK_TS ?? "",
    slackThreadTs: process.env.BG_SLACK_THREAD_TS ?? "",
  };
}

async function bgApi(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BG API ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new McpServer({ name: "hive-background", version: "0.1.0" });

server.registerTool(
  "bg_execute",
  {
    title: "Execute in Background",
    description:
      "Spawn a shell command as a detached background process. Returns immediately with a task ID. " +
      "You will be notified in this thread when the command completes. " +
      "Use for any operation that might take more than 30 seconds: npm test, npm run build, git push, deploy scripts, etc.",
    inputSchema: {
      command: z.string().describe("The shell command to run (e.g. 'npm test', 'npm run build')"),
      cwd: z.string().optional().describe("Working directory (absolute path). Defaults to $HOME."),
    },
  },
  async ({ command, cwd }) => {
    try {
      const result = await bgApi("POST", "/tasks", {
        command,
        cwd,
        context: buildContext(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Background task started.\nID: ${result.id}\nCommand: ${command}\nYou will be notified in this thread when it completes.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to start background task: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "bg_status",
  {
    title: "Check Background Task",
    description: "Get the current status and output of a background task by ID.",
    inputSchema: {
      id: z.string().describe("Task ID returned by bg_execute"),
    },
  },
  async ({ id }) => {
    try {
      const result = await bgApi("GET", `/tasks/${id}`);
      const lines = [
        `Task ${id}: ${result.status}`,
        result.exitCode !== null ? `Exit code: ${result.exitCode}` : "",
        `Started: ${result.startedAt}`,
        result.completedAt ? `Completed: ${result.completedAt}` : "",
        "",
        `Output:`,
        result.output || "(no output yet)",
      ].filter(Boolean);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to get task status: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "bg_list",
  {
    title: "List Background Tasks",
    description: "List all background tasks for this agent.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bgApi("GET", `/tasks?agentId=${encodeURIComponent(AGENT_ID)}`);
      if (!result.tasks || result.tasks.length === 0) {
        return { content: [{ type: "text" as const, text: "No background tasks found." }] };
      }
      const lines = result.tasks.map(
        (t: any) => `${t.id} | ${t.status} | exit: ${t.exitCode ?? "\u2014"} | ${t.command}`,
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to list tasks: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
