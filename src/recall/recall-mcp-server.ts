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
const MEETING_MONITOR_API = process.env.MEETING_MONITOR_API ?? "";
const MEETING_MONITOR_PUBLIC_URL = process.env.MEETING_MONITOR_PUBLIC_URL ?? "";
const WEBHOOK_SECRET = process.env.RECALL_WEBHOOK_SECRET ?? "";
const AGENT_ID = process.env.RECALL_AGENT_ID ?? "";

if (!API_KEY) {
  process.stderr.write("recall-mcp-server: RECALL_API_KEY is required\n");
  process.exit(1);
}

async function api(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Token ${API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Recall API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return {};
  return res.json();
}

async function monitorApi(method: string, path: string, body?: object): Promise<any> {
  if (!MEETING_MONITOR_API) throw new Error("Meeting monitor not configured");
  const res = await fetch(`${MEETING_MONITOR_API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Monitor API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return {};
  return res.json();
}

function buildContext() {
  return {
    agentId: AGENT_ID,
    adapterId: process.env.RECALL_ADAPTER_ID ?? "",
    channelId: process.env.RECALL_CHANNEL_ID ?? "",
    channelKind: process.env.RECALL_CHANNEL_KIND ?? "internal",
    channelLabel: process.env.RECALL_CHANNEL_LABEL ?? "",
    threadId: process.env.RECALL_THREAD_ID ?? "",
    slackTs: process.env.RECALL_SLACK_TS ?? "",
    slackThreadTs: process.env.RECALL_SLACK_THREAD_TS ?? "",
  };
}

const server = new McpServer({
  name: "hive-recall",
  version: "0.1.0",
});

// --- Tool: recall_create_bot ---
server.registerTool(
  "recall_create_bot",
  {
    title: "Create Meeting Bot",
    description:
      "Send a Recall.ai notetaker bot to a meeting. Provide the meeting URL (e.g. Zoom, Google Meet) and optionally a bot name.",
    inputSchema: {
      meeting_url: z.string().describe("The meeting URL to join (e.g. Zoom, Google Meet link)"),
      bot_name: z.string().optional().default("Hive Notetaker").describe("Display name for the bot in the meeting"),
    },
  },
  async ({ meeting_url, bot_name }) => {
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
  },
);

// --- Tool: recall_join_meeting ---
server.registerTool(
  "recall_join_meeting",
  {
    title: "Join Meeting (Active Participation)",
    description:
      "Join a meeting as an active participant. Creates a bot AND starts real-time transcript monitoring. " +
      "You will receive transcript updates in this thread. Use recall_send_chat to respond.",
    inputSchema: {
      meeting_url: z.string().describe("The meeting URL to join (Zoom, Google Meet, etc.)"),
      bot_name: z.string().optional().default("Hive Assistant").describe("Display name for the bot"),
    },
  },
  async ({ meeting_url, bot_name }) => {
    try {
      const botBody: Record<string, any> = {
        meeting_url,
        bot_name,
        recording_config: {
          transcript: {
            provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } },
          },
        },
      };

      // Enable real-time transcript webhooks if public URL and webhook secret are configured
      if (MEETING_MONITOR_PUBLIC_URL && WEBHOOK_SECRET) {
        botBody.recording_config.realtime_endpoints = [
          {
            type: "webhook",
            url: `${MEETING_MONITOR_PUBLIC_URL}/webhook/transcript/${WEBHOOK_SECRET}`,
            events: ["transcript.data", "transcript.partial_data"],
          },
        ];
      }

      const bot = await api("POST", "/bot/", botBody);

      let monitorSessionId = "not started";
      if (MEETING_MONITOR_API) {
        try {
          const monitorResult = await monitorApi("POST", "/meetings/start", {
            botId: bot.id,
            botName: bot_name,
            meetingUrl: meeting_url,
            apiKey: API_KEY,
            region: REGION,
            context: buildContext(),
          });
          monitorSessionId = monitorResult.sessionId ?? "started";
        } catch (err) {
          monitorSessionId = `failed: ${String(err)}`;
        }
      }

      const realtimeNote =
        MEETING_MONITOR_PUBLIC_URL && !WEBHOOK_SECRET
          ? `\n- **Note**: Real-time transcript delivery is disabled — RECALL_WEBHOOK_SECRET not configured. Transcript will be available after the meeting ends.`
          : "";

      const summary = [
        `Joined meeting as active participant.`,
        `- **Bot ID**: ${bot.id}`,
        `- **Bot Name**: ${bot_name}`,
        `- **Meeting URL**: ${bot.meeting_url?.meeting_id ? meeting_url : "N/A"}`,
        `- **Monitor**: ${monitorSessionId}${realtimeNote}`,
        ``,
        `You will receive periodic transcript updates in this thread.`,
        `Use \`recall_send_chat\` with bot_id "${bot.id}" to send chat messages into the meeting.`,
      ].join("\n");
      return { content: [{ type: "text", text: summary }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to join meeting: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: recall_send_chat ---
server.registerTool(
  "recall_send_chat",
  {
    title: "Send Meeting Chat",
    description:
      "Send a chat message into an active meeting. The message appears in the meeting chat for all participants to see.",
    inputSchema: {
      bot_id: z.string().describe("The bot ID in the meeting"),
      message: z.string().describe("The chat message to send"),
    },
  },
  async ({ bot_id, message }) => {
    try {
      await api("POST", `/bot/${bot_id}/send_chat_message/`, {
        to: "everyone",
        message,
      });
      return { content: [{ type: "text", text: `Chat sent to meeting: "${message}"` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to send chat: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: recall_get_bot ---
server.registerTool(
  "recall_get_bot",
  {
    title: "Get Bot Details",
    description: "Get the current status, meeting info, and transcript for a Recall.ai bot by its ID.",
    inputSchema: {
      bot_id: z.string().describe("The bot ID returned from recall_create_bot"),
    },
  },
  async ({ bot_id }) => {
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

      // Transcript info from recordings
      const recordings = Array.isArray(result.recordings) ? result.recordings : [];
      const recording = recordings[0];
      const transcript = recording?.media_shortcuts?.transcript;
      if (transcript) {
        lines.push(`**Transcript Status**: ${transcript.status?.code ?? "unknown"}`);
        if (transcript.data?.download_url) {
          lines.push(`**Transcript Download URL**: ${transcript.data.download_url}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to get bot: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: recall_get_transcript ---
server.registerTool(
  "recall_get_transcript",
  {
    title: "Get Transcript",
    description: "Get the full transcript for a bot's recorded meeting.",
    inputSchema: {
      bot_id: z.string().describe("The bot ID to retrieve the transcript for"),
    },
  },
  async ({ bot_id }) => {
    try {
      // Get bot to find transcript download URL from recordings
      const bot = await api("GET", `/bot/${bot_id}/`);
      const recordings = Array.isArray(bot.recordings) ? bot.recordings : [];
      const recording = recordings[0];
      const downloadUrl = recording?.media_shortcuts?.transcript?.data?.download_url;

      if (!downloadUrl) {
        const transcriptStatus = recording?.media_shortcuts?.transcript?.status?.code;
        if (transcriptStatus === "processing") {
          return {
            content: [{ type: "text", text: "Transcript is still processing. Try again after the meeting ends." }],
          };
        }
        return { content: [{ type: "text", text: "Transcript is not available for this bot." }] };
      }

      // Fetch the transcript from the download URL
      const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Transcript download failed: ${res.status}`);

      const data = await res.json();
      const entries = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : [];
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "Transcript is empty — no recorded speech." }] };
      }

      const lines: string[] = [];
      for (const entry of entries) {
        const speaker = entry.speaker ?? entry.participant?.name ?? "Unknown";
        const words = Array.isArray(entry.words)
          ? entry.words.map((w: any) => w.text).join(" ")
          : typeof entry.text === "string"
            ? entry.text
            : "";
        lines.push(`[${speaker}]: ${words}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to get transcript: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: recall_list_bots ---
server.registerTool(
  "recall_list_bots",
  {
    title: "List Bots",
    description: "List recent Recall.ai bots with their status and meeting info.",
    inputSchema: {
      limit: z.number().optional().default(10).describe("Maximum number of bots to return"),
    },
  },
  async ({ limit }) => {
    try {
      const result = await api("GET", `/bot/?page_size=${limit}`);
      const bots = Array.isArray(result) ? result : Array.isArray(result.results) ? result.results : [];
      if (bots.length === 0) {
        return { content: [{ type: "text", text: "No bots found." }] };
      }
      const lines: string[] = [];
      for (const bot of bots) {
        const status = bot.status_changes?.length ? bot.status_changes[bot.status_changes.length - 1].code : "unknown";
        lines.push(`${bot.id} | ${status} | ${bot.meeting_url ?? "N/A"} | ${bot.bot_name ?? "N/A"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to list bots: ${String(err)}` }], isError: true };
    }
  },
);

// --- Tool: recall_leave_call ---
server.registerTool(
  "recall_leave_call",
  {
    title: "Leave Call",
    description: "Tell a Recall.ai bot to leave its current meeting call.",
    inputSchema: {
      bot_id: z.string().describe("The bot ID to remove from the call"),
    },
  },
  async ({ bot_id }) => {
    try {
      await api("POST", `/bot/${bot_id}/leave_call/`);
      return { content: [{ type: "text", text: `Bot ${bot_id} has been told to leave the call.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to leave call: ${String(err)}` }], isError: true };
    }
  },
);

// Connect and run
const transport = new StdioServerTransport();
await server.connect(transport);
