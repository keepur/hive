#!/usr/bin/env node

/**
 * Voice MCP Server — lets agents make and monitor phone calls via Vapi.
 *
 * Env vars (set by agent-runner):
 *   VAPI_API_KEY       — Vapi API key for REST calls
 *   VAPI_PHONE_NUMBER_ID — default outbound phone number ID
 *   VAPI_ASSISTANT_ID  — Vapi assistant ID to use for calls
 *   AGENT_ID           — the calling agent's Hive ID
 *   AGENT_NAME         — the calling agent's display name
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VAPI_API_KEY = process.env.VAPI_API_KEY ?? "";
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID ?? "";
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "";
const AGENT_NAME = process.env.AGENT_NAME ?? "";

if (!VAPI_API_KEY) {
  process.stderr.write("voice-mcp-server: VAPI_API_KEY is required\n");
  process.exit(1);
}

const VAPI_BASE = "https://api.vapi.ai";

async function vapiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vapi API error ${res.status}: ${text}`);
  }

  return res.json();
}

const server = new McpServer({ name: "voice", version: "1.0.0" });

// ── Tool: voice_call ───────────────────────────────────────────────────

server.tool(
  "voice_call",
  "Initiate an outbound phone call via Vapi. You (the agent) will be the voice on the call — " +
    "Vapi handles speech-to-text and text-to-speech while you provide the conversation. " +
    "Provide a clear goal describing what you want to accomplish on the call.",
  {
    to: z.string().describe("Recipient phone number in E.164 format (e.g., +14155551234)"),
    goal: z
      .string()
      .describe("What you want to accomplish on this call — this is injected into your system prompt during the call"),
    context: z.string().optional().describe("Additional context for the call (order details, customer history, etc.)"),
  },
  async ({ to, goal, context }) => {
    if (!VAPI_ASSISTANT_ID) {
      return {
        content: [{ type: "text" as const, text: "Error: No Vapi assistant configured. Set VAPI_ASSISTANT_ID." }],
        isError: true,
      };
    }

    if (!VAPI_PHONE_NUMBER_ID) {
      return {
        content: [
          { type: "text" as const, text: "Error: No outbound phone number configured. Set VAPI_PHONE_NUMBER_ID." },
        ],
        isError: true,
      };
    }

    try {
      const result = (await vapiRequest("POST", "/call", {
        assistantId: VAPI_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: { number: to },
        metadata: {
          hive_agent_id: AGENT_ID,
          agent_name: AGENT_NAME,
          goal,
          context: context ?? "",
        },
      })) as any;

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Call initiated successfully.`,
              `Call ID: ${result.id}`,
              `Status: ${result.status}`,
              `To: ${to}`,
              ``,
              `The call is now in progress. Use voice_call_status to check on it later.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to initiate call: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: voice_call_status ────────────────────────────────────────────

server.tool(
  "voice_call_status",
  "Check the status of a voice call. Returns status, duration, and transcript (if the call has ended).",
  {
    call_id: z.string().describe("The call ID returned from voice_call"),
  },
  async ({ call_id }) => {
    try {
      const call = (await vapiRequest("GET", `/call/${call_id}`)) as any;

      const lines: string[] = [`Call ID: ${call.id}`, `Status: ${call.status}`, `Type: ${call.type}`];

      if (call.startedAt) lines.push(`Started: ${call.startedAt}`);
      if (call.endedAt) lines.push(`Ended: ${call.endedAt}`);
      if (call.cost) lines.push(`Cost: $${call.cost.toFixed(4)}`);

      if (call.transcript) {
        lines.push("", "--- Transcript ---", call.transcript);
      }

      if (call.summary) {
        lines.push("", "--- Summary ---", call.summary);
      }

      if (call.analysis) {
        lines.push("", "--- Analysis ---", JSON.stringify(call.analysis, null, 2));
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to get call status: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: voice_list_calls ─────────────────────────────────────────────

server.tool(
  "voice_list_calls",
  "List recent voice calls.",
  {
    limit: z.number().optional().describe("Number of calls to return (default 10)"),
  },
  async ({ limit }) => {
    try {
      const calls = (await vapiRequest("GET", `/call?limit=${limit ?? 10}`)) as any[];

      if (!calls || calls.length === 0) {
        return { content: [{ type: "text" as const, text: "No recent calls found." }] };
      }

      const lines = calls.map((c: any) => {
        const to = c.customer?.number ?? "unknown";
        const status = c.status ?? "unknown";
        const duration = c.duration ? `${Math.round(c.duration / 60)}m` : "n/a";
        return `${c.id} — ${to} — ${status} — ${duration}`;
      });

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to list calls: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Connect ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
