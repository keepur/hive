#!/usr/bin/env node

/**
 * Google MCP Server — Gmail + Calendar access via `gog` CLI.
 * Agents can search/read email, send email, and manage calendar events.
 *
 * Requires `gog` CLI to be installed and authenticated.
 *
 * Env vars:
 *   GOG_ACCOUNT — Google account email (optional, uses gog default if unset)
 *   GOG_PATH    — path to gog binary (optional, auto-detected if unset)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";

const ACCOUNT = process.env.GOG_ACCOUNT ?? "";
const GOG =
  process.env.GOG_PATH ??
  (() => {
    try {
      return execFileSync("which", ["gog"], { encoding: "utf-8" }).trim();
    } catch {
      return "gog";
    }
  })();

function gog(args: string[]): string {
  const fullArgs = [...args, ...(ACCOUNT ? ["-a", ACCOUNT] : []), "--json", "--results-only", "--no-input"];
  return execFileSync(GOG, fullArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
}

function gogPlain(args: string[]): string {
  const fullArgs = [...args, ...(ACCOUNT ? ["-a", ACCOUNT] : []), "--plain", "--no-input"];
  return execFileSync(GOG, fullArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
}

const server = new McpServer({
  name: "hive-google",
  version: "0.1.0",
});

// ── Gmail ───────────────────────────────────────────────────────────────

server.registerTool(
  "gmail_search",
  {
    title: "Search Email",
    description:
      "Search Gmail using Gmail query syntax (e.g. 'from:someone@example.com', 'is:unread newer_than:1d', 'subject:invoice'). Returns thread summaries.",
    inputSchema: {
      query: z.string().describe("Gmail search query"),
      max: z.number().optional().default(10).describe("Max results (default 10)"),
    },
  },
  async ({ query, max }) => {
    try {
      const result = gog(["gmail", "search", query, `--max=${max}`]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Search failed: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "gmail_get",
  {
    title: "Read Email",
    description: "Read a specific email message by its message ID. Returns full message content.",
    inputSchema: {
      messageId: z.string().describe("Gmail message ID"),
    },
  },
  async ({ messageId }) => {
    try {
      const result = gog(["gmail", "get", messageId]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to read message: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "gmail_thread",
  {
    title: "Read Email Thread",
    description: "Read an entire email thread by thread ID. Returns all messages in the conversation.",
    inputSchema: {
      threadId: z.string().describe("Gmail thread ID"),
    },
  },
  async ({ threadId }) => {
    try {
      const result = gog(["gmail", "thread", "get", threadId]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to read thread: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "gmail_send",
  {
    title: "Send Email",
    description: "Send an email. Can also reply to an existing thread.",
    inputSchema: {
      to: z.string().describe("Recipient email addresses (comma-separated)"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC recipients (comma-separated)"),
      threadId: z.string().optional().describe("Thread ID to reply within"),
    },
  },
  async ({ to, subject, body, cc, threadId }) => {
    try {
      const result = gogPlain(["send", "--to", to, "--subject", subject, "--body", body, "--force", ...(cc ? ["--cc", cc] : []), ...(threadId ? ["--thread-id", threadId] : [])]);
      return { content: [{ type: "text", text: result || "Email sent." }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to send: ${e.message}` }], isError: true };
    }
  },
);

// ── Calendar ────────────────────────────────────────────────────────────

server.registerTool(
  "calendar_list",
  {
    title: "List Calendars",
    description: "List all available Google calendars.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = gog(["cal", "calendars"]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to list calendars: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "calendar_events",
  {
    title: "List Calendar Events",
    description:
      "List upcoming calendar events. Supports relative dates: 'today', 'tomorrow', 'monday', or RFC3339 timestamps.",
    inputSchema: {
      from: z.string().optional().describe("Start time (e.g. 'today', 'tomorrow', '2026-03-01')"),
      to: z.string().optional().describe("End time"),
      today: z.boolean().optional().describe("Show today's events only"),
      days: z.number().optional().describe("Show events for next N days"),
      max: z.number().optional().default(20).describe("Max results (default 20)"),
      calendarId: z.string().optional().describe("Calendar ID (default: primary)"),
    },
  },
  async ({ from, to, today, days, max, calendarId }) => {
    try {
      const args: string[] = ["cal", "events"];
      if (calendarId) args.push(calendarId);
      args.push(...(today ? ["--today"] : days ? [`--days=${days}`] : [...(from ? ["--from", from] : []), ...(to ? ["--to", to] : [])]));
      args.push(`--max=${max}`);
      const result = gog(args);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to list events: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "calendar_search",
  {
    title: "Search Calendar",
    description: "Search calendar events by text query.",
    inputSchema: {
      query: z.string().describe("Search query"),
      from: z.string().optional().describe("Start time"),
      to: z.string().optional().describe("End time"),
    },
  },
  async ({ query, from, to }) => {
    try {
      const result = gog(["cal", "search", query, ...(from ? ["--from", from] : []), ...(to ? ["--to", to] : [])]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `No events found or search failed: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "calendar_create",
  {
    title: "Create Calendar Event",
    description: "Create a new calendar event.",
    inputSchema: {
      summary: z.string().describe("Event title"),
      from: z.string().describe("Start time (RFC3339 or relative like 'tomorrow 2pm')"),
      to: z.string().describe("End time (RFC3339 or relative)"),
      description: z.string().optional().describe("Event description"),
      location: z.string().optional().describe("Event location"),
      attendees: z.string().optional().describe("Attendee emails (comma-separated)"),
      calendarId: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
    },
  },
  async ({ summary, from, to, description, location, attendees, calendarId }) => {
    try {
      const result = gogPlain(["cal", "create", calendarId, "--summary", summary, "--from", from, "--to", to, "--force", ...(description ? ["--description", description] : []), ...(location ? ["--location", location] : []), ...(attendees ? ["--attendees", attendees] : [])]);
      return { content: [{ type: "text", text: result || "Event created." }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to create event: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "calendar_freebusy",
  {
    title: "Check Free/Busy",
    description: "Check free/busy status for a time range.",
    inputSchema: {
      from: z.string().describe("Start time"),
      to: z.string().describe("End time"),
      calendarIds: z.string().optional().default("primary").describe("Calendar IDs (comma-separated)"),
    },
  },
  async ({ from, to, calendarIds }) => {
    try {
      const result = gog(["cal", "freebusy", calendarIds, "--from", from, "--to", to]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to check free/busy: ${e.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
