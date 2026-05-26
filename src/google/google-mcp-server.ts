#!/usr/bin/env node

/**
 * Google MCP Server — Gmail + Calendar access via `gog` CLI.
 * Agents can search/read email, send email, and manage calendar events.
 *
 * Requires `gog` CLI to be installed and authenticated.
 *
 * Env vars:
 *   GOG_ACCOUNTS — CSV of Google account emails (KPR-242). First entry is the implicit default.
 *                  When more than one is listed, every tool surfaces an `account` enum parameter.
 *   GOG_CLIENT   — OAuth client name (optional, uses gog default if unset)
 *   GOG_PATH     — path to gog binary (optional, auto-detected if unset)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

const ACCOUNTS = (process.env.GOG_ACCOUNTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_ACCOUNT = ACCOUNTS[0] ?? "";
const MULTI = ACCOUNTS.length > 1;
const CLIENT = process.env.GOG_CLIENT ?? "";
const GOG =
  process.env.GOG_PATH ??
  (() => {
    try {
      return execFileSync("which", ["gog"], { encoding: "utf-8" }).trim();
    } catch {
      return "gog";
    }
  })();

/**
 * KPR-242: when MULTI is true, every tool's input schema gets this `account`
 * enum spread in. When false (the common single-account case), the spread is
 * `{}` and the registered tool schema is byte-identical to pre-KPR-242 —
 * critical for keeping the toolkit prefix prompt cache warm for Rae/Milo/Sige.
 *
 * The static type carries `account` as an optional Zod schema so spreading
 * `...accountField` into each tool's `inputSchema` propagates `account?:` into
 * the SDK's schema-derived handler argument type, letting handlers destructure
 * `{ ..., account }` whether MULTI is true or false. At runtime the key is
 * present only when MULTI is true, so the registered tool schema stays
 * byte-identical for single-account agents.
 */
type AccountField = { account?: z.ZodOptional<z.ZodEnum<Record<string, string>>> };
const accountField: AccountField = MULTI
  ? {
      account: z
        .enum(ACCOUNTS as [string, ...string[]])
        .optional()
        .describe(
          `Which Google account to use. Defaults to ${DEFAULT_ACCOUNT}. Available: ${ACCOUNTS.join(", ")}`,
        ) as z.ZodOptional<z.ZodEnum<Record<string, string>>>,
    }
  : {};

function gog(account: string, args: string[]): string {
  const fullArgs = [
    ...args,
    ...(account ? ["-a", account] : []),
    ...(CLIENT ? ["--client", CLIENT] : []),
    "--json",
    "--results-only",
    "--no-input",
  ];
  return execFileSync(GOG, fullArgs, { encoding: "utf-8", timeout: 30_000 }).trim();
}

function gogPlain(account: string, args: string[]): string {
  const fullArgs = [
    ...args,
    ...(account ? ["-a", account] : []),
    ...(CLIENT ? ["--client", CLIENT] : []),
    "--plain",
    "--no-input",
  ];
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
      ...accountField,
    },
  },
  async ({ query, max, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["gmail", "search", query, `--max=${max}`]);
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
      ...accountField,
    },
  },
  async ({ messageId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["gmail", "get", messageId]);
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
      ...accountField,
    },
  },
  async ({ threadId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["gmail", "thread", "get", threadId]);
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
      ...accountField,
    },
  },
  async ({ to, subject, body, cc, threadId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gogPlain(acc, [
        "send",
        "--to",
        to,
        "--subject",
        subject,
        "--body",
        body,
        "--force",
        ...(cc ? ["--cc", cc] : []),
        ...(threadId ? ["--thread-id", threadId] : []),
      ]);
      // KPR-174 + KPR-242: surface the sending identity so the agent (and the
      // operator) can confirm which mailbox actually sent the message — now
      // reflecting the per-call account choice instead of a spawn-time const.
      const sentFrom = acc ? `Sent from ${acc}.` : "Email sent.";
      const text = result ? `${sentFrom}\n\n${result}` : sentFrom;
      return { content: [{ type: "text", text }] };
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
    inputSchema: {
      ...accountField,
    },
  },
  async (args: { account?: string } = {}) => {
    const { account } = args;
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["cal", "calendars"]);
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
      ...accountField,
    },
  },
  async ({ from, to, today, days, max, calendarId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const args: string[] = ["cal", "events"];
      if (calendarId) args.push(calendarId);
      args.push(
        ...(today
          ? ["--today"]
          : days
            ? [`--days=${days}`]
            : [...(from ? ["--from", from] : []), ...(to ? ["--to", to] : [])]),
      );
      args.push(`--max=${max}`);
      const result = gog(acc, args);
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
      ...accountField,
    },
  },
  async ({ query, from, to, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["cal", "search", query, ...(from ? ["--from", from] : []), ...(to ? ["--to", to] : [])]);
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
      ...accountField,
    },
  },
  async ({ summary, from, to, description, location, attendees, calendarId, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gogPlain(acc, [
        "cal",
        "create",
        calendarId,
        "--summary",
        summary,
        "--from",
        from,
        "--to",
        to,
        "--force",
        ...(description ? ["--description", description] : []),
        ...(location ? ["--location", location] : []),
        ...(attendees ? ["--attendees", attendees] : []),
      ]);
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
      ...accountField,
    },
  },
  async ({ from, to, calendarIds, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    try {
      const result = gog(acc, ["cal", "freebusy", calendarIds, "--from", from, "--to", to]);
      return { content: [{ type: "text", text: result }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to check free/busy: ${e.message}` }], isError: true };
    }
  },
);

// ── Drive ─────────────────────────────────────────────────────────────

const SHARED_FOLDER = process.env.DRIVE_SHARED_FOLDER ?? "";
const INSTANCE_ID = process.env.INSTANCE_ID ?? "hive";
const DOWNLOAD_DIR = join("/tmp", `${INSTANCE_ID}-drive-downloads`);
mkdirSync(DOWNLOAD_DIR, { recursive: true });

server.registerTool(
  "drive_upload",
  {
    title: "Upload File to Google Drive",
    description:
      "Upload a local file to the company shared Google Drive folder. " +
      "Returns a shareable link. Use this to share CSVs, reports, documents with the team. " +
      "The file must exist on the local filesystem (e.g. from permit_export_csv or other export tools).",
    inputSchema: {
      file_path: z.string().describe("Absolute path to the local file to upload"),
      name: z.string().optional().describe("Override the filename in Drive (defaults to local filename)"),
      ...accountField,
    },
  },
  async ({ file_path, name, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    if (!SHARED_FOLDER) {
      return {
        content: [{ type: "text", text: "Drive shared folder not configured (DRIVE_SHARED_FOLDER)." }],
        isError: true,
      };
    }

    if (!existsSync(file_path)) {
      return { content: [{ type: "text", text: `File not found: ${file_path}` }], isError: true };
    }

    const fileName = name || basename(file_path);

    try {
      const result = gog(acc, ["drive", "upload", file_path, "--parent", SHARED_FOLDER, "--name", fileName]);
      const data = JSON.parse(result);

      const summary = [
        `Uploaded to Google Drive`,
        `  Name: ${data.name || fileName}`,
        ...(data.webViewLink ? [`  View: ${data.webViewLink}`] : []),
        ...(data.id ? [`  File ID: ${data.id}`] : []),
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Upload failed: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "drive_download",
  {
    title: "Download File from Google Drive",
    description:
      "Download a file from Google Drive to the local filesystem for processing. " +
      "Provide either a file ID or a Drive URL. For Google Docs/Sheets/Slides, exports as text/CSV.",
    inputSchema: {
      file_id: z.string().optional().describe("Google Drive file ID"),
      url: z.string().optional().describe("Google Drive URL (file ID will be extracted)"),
      format: z.string().optional().describe("Export format (e.g. txt, csv, pdf). Only for Google-native files."),
      ...accountField,
    },
  },
  async ({ file_id, url, format, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    let id = file_id;

    if (!id && url) {
      const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) ?? url.match(/id=([a-zA-Z0-9_-]+)/);
      if (match) id = match[1];
    }

    if (!id) {
      return { content: [{ type: "text", text: "Provide either file_id or a Google Drive URL." }], isError: true };
    }

    try {
      const outPath = join(DOWNLOAD_DIR, id + (format ? `.${format}` : ""));
      const args = ["drive", "download", id, "--out", outPath];
      if (format) args.push("--format", format);
      gogPlain(acc, args);

      // Return inline content for text-readable files
      const textExtensions = new Set([".txt", ".csv", ".md", ".json", ".xml", ".html", ".tsv"]);
      const ext = outPath.includes(".") ? outPath.slice(outPath.lastIndexOf(".")) : "";
      if (existsSync(outPath) && textExtensions.has(ext)) {
        const content = readFileSync(outPath, "utf-8");
        const summary = [
          `Downloaded${format ? ` and exported as ${format}` : ""}`,
          `  Local path: ${outPath}`,
          ``,
          `--- Content ---`,
          content,
        ].join("\n");
        return { content: [{ type: "text", text: summary }] };
      }

      return { content: [{ type: "text", text: `Downloaded to ${outPath}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Download failed: ${e.message}` }], isError: true };
    }
  },
);

server.registerTool(
  "drive_list",
  {
    title: "List Files in Shared Drive Folder",
    description:
      "List files in the company shared Drive folder. Useful to see what reports and documents have been shared.",
    inputSchema: {
      query: z.string().optional().describe("Search query to filter files (e.g. 'permits' or 'name contains report')"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
      ...accountField,
    },
  },
  async ({ query, limit, account }) => {
    const acc = account ?? DEFAULT_ACCOUNT;
    if (!SHARED_FOLDER) {
      return { content: [{ type: "text", text: "Drive shared folder not configured." }], isError: true };
    }

    try {
      const args = ["drive", "ls", "--parent", SHARED_FOLDER];
      if (query) args.push("--query", query);
      args.push(`--max=${limit ?? 20}`);
      const result = gog(acc, args);

      // Format as human-readable text
      try {
        const files = JSON.parse(result);
        if (!Array.isArray(files) || files.length === 0) {
          return { content: [{ type: "text", text: "No files found." }] };
        }
        const lines = files.map((f: Record<string, unknown>) => {
          const name = (f.name as string) || "Untitled";
          const size = (f.size as string) || "—";
          const modified = (f.modifiedTime as string) ? new Date(f.modifiedTime as string).toLocaleDateString() : "—";
          const link = (f.webViewLink as string) || "";
          return `📄 ${name} — ${size} — ${modified}${link ? ` — ${link}` : ""}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch {
        // Parse failed — return raw output
        return { content: [{ type: "text", text: result || "No files found." }] };
      }
    } catch (e: any) {
      return { content: [{ type: "text", text: `List failed: ${e.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
