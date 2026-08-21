#!/usr/bin/env node
/**
 * LiveKit Voice MCP Server (KPR-322 E4) — initiate outbound calls on the
 * LiveKit pipeline. Creates an agent dispatch consumed by the hive-voice
 * worker (src/voice-worker/), which places the SIP call and bridges the
 * conversation back to this hive's spawn path.
 *
 * Env (set by agent-runner):
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET — LiveKit Cloud project
 *   AGENT_ID, AGENT_NAME — calling agent identity
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentDispatchClient } from "livekit-server-sdk";
import { buildDispatchArgs } from "./livekit-dispatch.js";

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "";
const AGENT_NAME = process.env.AGENT_NAME ?? "";

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  process.stderr.write("livekit-voice-mcp-server: LIVEKIT_URL/API_KEY/API_SECRET are required\n");
  process.exit(1);
}

const server = new McpServer({ name: "voice-livekit", version: "1.0.0" });

server.tool(
  "voice_call",
  "Initiate an outbound phone call (LiveKit pipeline). You (the agent) will be the voice on the call — " +
    "speech-to-text and text-to-speech run in the call worker while you author every conversational turn. " +
    "Provide a clear goal describing what you want to accomplish on the call.",
  {
    to: z.string().describe("Recipient phone number in E.164 format (e.g., +14155551234)"),
    goal: z
      .string()
      .describe("What you want to accomplish on this call — this is injected into your system prompt during the call"),
    context: z.string().optional().describe("Additional context for the call (order details, vendor history, etc.)"),
  },
  async ({ to, goal, context }) => {
    try {
      const args = buildDispatchArgs({ to, goal, context, agentId: AGENT_ID, agentName: AGENT_NAME });
      const client = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      const dispatch = await client.createDispatch(args.roomName, args.agentName, { metadata: args.metadata });
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Call dispatch created.",
              `Call ID: ${args.roomName}`,
              `Dispatch: ${dispatch.id}`,
              `To: ${to}`,
              "",
              "The voice worker is placing the call now.",
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to dispatch call: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
