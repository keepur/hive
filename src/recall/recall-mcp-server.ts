#!/usr/bin/env node

/**
 * Recall.ai MCP Server — runs as a stdio subprocess inside each agent's Claude Code session.
 * Gives agents the ability to create meeting bots, retrieve transcripts,
 * list bots, and manage meeting recordings via the Recall.ai API.
 *
 * Env vars:
 *   RECALL_API_KEY    — API key from Recall.ai dashboard (required)
 *   RECALL_API_REGION — AWS region (optional, default us-west-2)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.RECALL_API_KEY ?? "";
const REGION = process.env.RECALL_API_REGION ?? "us-west-2";
const BASE_URL = `https://${REGION}.recall.ai/api/v1`;

if (!API_KEY) {
  process.stderr.write("recall-mcp-server: RECALL_API_KEY is required\n");
  process.exit(1);
}

async function api(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Authorization": `Token ${API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Recall API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return {};
  return res.json();
}

const server = new McpServer({
  name: "hive-recall",
  version: "0.1.0",
});

// --- Tool: recall_create_bot ---
server.registerTool("recall_create_bot", {
  title: "Create Meeting Bot",
  description: "Send a Recall.ai notetaker bot to a meeting. Provide the meeting URL (e.g. Zoom, Google Meet) and optionally a bot name.",
  inputSchema: {
    meeting_url: z.string().describe("The meeting URL to join (e.g. Zoom, Google Meet link)"),
    bot_name: z.string().optional().default("Hive Notetaker").describe("Display name for the bot in the meeting"),
  },
}, async ({ meeting_url, bot_name }) => {
  try {
    const result = await api("POST", "/bot/", {
      meeting_url,
      bot_name,
      recording_config: {
        transcript: {
          provider: { recallai_streaming: {} },
        },
      },
    });
    const status = result.status_changes?.length
      ? result.status_changes[result.status_changes.length - 1].code
      : "unknown";
    const summary = [
      `Bot created successfully.`,
      `- **Bot ID**: ${result.id}`,
      `- **Status**: ${status}`,
      `- **Meeting URL**: ${result.meeting_url ?? meeting_url}`,
      `- **Bot Name**: ${result.bot_name ?? bot_name}`,
      ``,
      `Use \`recall_get_bot\` with bot_id "${result.id}" to check status and retrieve the transcript once the meeting ends.`,
    ].join("\n");
    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to create bot: ${String(err)}` }], isError: true };
  }
});

// --- Tool: recall_get_bot ---
server.registerTool("recall_get_bot", {
  title: "Get Bot Details",
  description: "Get the current status, meeting info, and transcript for a Recall.ai bot by its ID.",
  inputSchema: {
    bot_id: z.string().describe("The bot ID returned from recall_create_bot"),
  },
}, async ({ bot_id }) => {
  try {
    const result = await api("GET", `/bot/${bot_id}/`);
    const status = result.status_changes?.length
      ? result.status_changes[result.status_changes.length - 1].code
      : "unknown";

    const lines: string[] = [
      `**Bot ID**: ${result.id}`,
      `**Status**: ${status}`,
      `**Meeting URL**: ${result.meeting_url ?? "N/A"}`,
      `**Bot Name**: ${result.bot_name ?? "N/A"}`,
    ];

    // Inline transcript if available
    if (Array.isArray(result.transcript) && result.transcript.length > 0) {
      lines.push("", "**Transcript:**");
      for (const entry of result.transcript) {
        const words = Array.isArray(entry.words)
          ? entry.words.map((w: any) => w.text).join(" ")
          : "";
        lines.push(`[${entry.speaker}]: ${words}`);
      }
    }

    // Download URL if available
    const downloadUrl = result.media_shortcuts?.transcript?.data?.download_url;
    if (downloadUrl) {
      lines.push("", `**Transcript download URL**: ${downloadUrl}`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to get bot: ${String(err)}` }], isError: true };
  }
});

// --- Tool: recall_get_transcript ---
server.registerTool("recall_get_transcript", {
  title: "Get Transcript",
  description: "Get the full transcript for a bot's recorded meeting.",
  inputSchema: {
    bot_id: z.string().describe("The bot ID to retrieve the transcript for"),
  },
}, async ({ bot_id }) => {
  try {
    const result = await api("GET", `/bot/${bot_id}/transcript/`);
    const entries = Array.isArray(result) ? result : (Array.isArray(result.results) ? result.results : []);
    if (entries.length === 0) {
      return { content: [{ type: "text", text: "Transcript is not yet available or the meeting has no recorded speech." }] };
    }
    const lines: string[] = [];
    for (const entry of entries) {
      const words = Array.isArray(entry.words)
        ? entry.words.map((w: any) => w.text).join(" ")
        : "";
      lines.push(`[${entry.speaker}]: ${words}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to get transcript: ${String(err)}` }], isError: true };
  }
});

// --- Tool: recall_list_bots ---
server.registerTool("recall_list_bots", {
  title: "List Bots",
  description: "List recent Recall.ai bots with their status and meeting info.",
  inputSchema: {
    limit: z.number().optional().default(10).describe("Maximum number of bots to return"),
  },
}, async ({ limit }) => {
  try {
    const result = await api("GET", `/bot/?page_size=${limit}`);
    const bots = Array.isArray(result) ? result : (Array.isArray(result.results) ? result.results : []);
    if (bots.length === 0) {
      return { content: [{ type: "text", text: "No bots found." }] };
    }
    const lines: string[] = [];
    for (const bot of bots) {
      const status = bot.status_changes?.length
        ? bot.status_changes[bot.status_changes.length - 1].code
        : "unknown";
      lines.push(`${bot.id} | ${status} | ${bot.meeting_url ?? "N/A"} | ${bot.bot_name ?? "N/A"}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to list bots: ${String(err)}` }], isError: true };
  }
});

// --- Tool: recall_leave_call ---
server.registerTool("recall_leave_call", {
  title: "Leave Call",
  description: "Tell a Recall.ai bot to leave its current meeting call.",
  inputSchema: {
    bot_id: z.string().describe("The bot ID to remove from the call"),
  },
}, async ({ bot_id }) => {
  try {
    await api("POST", `/bot/${bot_id}/leave_call/`);
    return { content: [{ type: "text", text: `Bot ${bot_id} has been told to leave the call.` }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to leave call: ${String(err)}` }], isError: true };
  }
});

// Connect and run
const transport = new StdioServerTransport();
await server.connect(transport);
