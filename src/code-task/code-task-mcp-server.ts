#!/usr/bin/env node

/**
 * Code Task MCP Server — agent-facing interface for Claude Code sessions.
 * Runs as a stdio subprocess inside agent sessions and communicates with
 * the CodeTaskManager via HTTP.
 *
 * Env vars:
 *   CT_TASK_API      — Base URL of the code-task manager (default: http://127.0.0.1:3102)
 *   CT_AUTH_TOKEN    — Bearer token for auth
 *   CT_AGENT_ID      — The agent's identifier
 *   CT_ADAPTER_ID    — Adapter identifier for context
 *   CT_CHANNEL_ID    — Channel identifier for context
 *   CT_CHANNEL_KIND  — Channel kind (default: "internal")
 *   CT_CHANNEL_LABEL — Channel label for context
 *   CT_THREAD_ID     — Thread identifier for context
 *   CT_SLACK_TS      — Slack timestamp for context
 *   CT_SLACK_THREAD_TS — Slack thread timestamp for context
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.CT_TASK_API ?? "http://127.0.0.1:3102";
const AGENT_ID = process.env.CT_AGENT_ID ?? "";
const AUTH_TOKEN = process.env.CT_AUTH_TOKEN ?? "";

interface CodeTaskContext {
  agentId: string;
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
}

function buildContext(): CodeTaskContext {
  return {
    agentId: AGENT_ID,
    adapterId: process.env.CT_ADAPTER_ID ?? "",
    channelId: process.env.CT_CHANNEL_ID ?? "",
    channelKind: process.env.CT_CHANNEL_KIND ?? "internal",
    channelLabel: process.env.CT_CHANNEL_LABEL ?? "",
    threadId: process.env.CT_THREAD_ID ?? "",
    slackTs: process.env.CT_SLACK_TS ?? "",
    slackThreadTs: process.env.CT_SLACK_THREAD_TS ?? "",
  };
}

async function ctApi(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Code Task API ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new McpServer({ name: "hive-code-task", version: "0.1.0" });

// ── code_task — Start a Claude Code session ────────────────────────

server.registerTool(
  "code_task",
  {
    title: "Start Code Task",
    description:
      "Spawn a Claude Code CLI session as a background task. Returns immediately with a task ID. " +
      "The session runs in the given working directory with full access to CLAUDE.md, project skills, " +
      "and dodi-dev plugin skills. You will be notified in this thread when the session completes or needs input. " +
      "Use for any coding work: implementing features, fixing bugs, running tests, creating PRs.",
    inputSchema: {
      prompt: z.string().describe("What to do — task description, plan reference, ticket context"),
      cwd: z.string().describe("Working directory (absolute path to worktree)"),
      maxTurns: z.number().optional().describe("Max agentic turns (default: 100)"),
      maxBudget: z.number().optional().describe("Max spend in USD (default: 5.00)"),
      model: z.string().optional().describe("Model override (e.g. 'claude-sonnet-4-6')"),
    },
  },
  async ({ prompt, cwd, maxTurns, maxBudget, model }) => {
    try {
      const result = await ctApi("POST", "/tasks", {
        prompt,
        cwd,
        maxTurns,
        maxBudget,
        model,
        context: buildContext(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Code task started.`,
              `ID: ${result.id}`,
              `Working directory: ${cwd}`,
              `You will be notified in this thread when it completes or needs input.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to start code task: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── code_status — Check session progress ───────────────────────────

server.registerTool(
  "code_status",
  {
    title: "Check Code Task",
    description: "Get the current status of a code task — running, completed, failed, or needs_input.",
    inputSchema: {
      id: z.string().describe("Task ID returned by code_task"),
    },
  },
  async ({ id }) => {
    try {
      const r = await ctApi("GET", `/tasks/${id}`);
      const lines = [
        `Task ${id}: **${r.status}**`,
        r.exitCode !== null && r.exitCode !== undefined ? `Exit code: ${r.exitCode}` : "",
        `Started: ${r.startedAt}`,
        r.completedAt ? `Completed: ${r.completedAt}` : "",
        r.costUsd ? `Cost: $${Number(r.costUsd).toFixed(2)}` : "",
        r.numTurns ? `Turns: ${r.numTurns}` : "",
        r.sessionId ? `Session: ${r.sessionId}` : "",
      ].filter(Boolean);

      if (r.escalation) {
        lines.push("", `**Escalation (${r.escalation.status})**`);
        if (r.escalation.question) lines.push(`Question: ${r.escalation.question}`);
        if (r.escalation.context) lines.push(`Context: ${r.escalation.context}`);
      }

      if (r.stderrTail) {
        lines.push("", "Recent output:", "```", r.stderrTail, "```");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to get task status: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── code_respond — Resume a session waiting for input ──────────────

server.registerTool(
  "code_respond",
  {
    title: "Respond to Code Task",
    description:
      "Resume a code task that is waiting for input (status: needs_input). " +
      "Spawns a new Claude Code session that resumes the previous one with your response.",
    inputSchema: {
      id: z.string().describe("Task ID of the waiting task"),
      response: z.string().describe("Your answer to the session's question"),
    },
  },
  async ({ id, response }) => {
    try {
      const result = await ctApi("POST", `/tasks/${id}/respond`, {
        response,
        context: buildContext(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Code task resumed.`,
              `New task ID: ${result.id}`,
              `Resumed from: ${id}`,
              `You will be notified when it completes or needs more input.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to resume code task: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
