#!/usr/bin/env node

/**
 * Team MCP Server — lets agents send direct messages to other agents.
 *
 * Env vars (set by agent-runner):
 *   AGENT_ID      — the calling agent's ID
 *   MONGODB_URI   — MongoDB connection string
 *   MONGODB_DB    — database name
 *   AGENT_IDS     — JSON array of all agent IDs (for list_agents)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient, ObjectId } from "mongodb";
import type { TeamMessage } from "./types.js";
import { internalChannelId } from "./types.js";

const AGENT_ID = process.env.AGENT_ID ?? "";
const MONGODB_URI = process.env.MONGODB_URI ?? "";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const AGENT_IDS_RAW = process.env.AGENT_IDS ?? "[]";

if (!AGENT_ID) {
  process.stderr.write("team-mcp-server: AGENT_ID is required\n");
  process.exit(1);
}
if (!MONGODB_URI) {
  process.stderr.write("team-mcp-server: MONGODB_URI is required\n");
  process.exit(1);
}

let agentIds: string[] = [];
try {
  agentIds = JSON.parse(AGENT_IDS_RAW);
} catch {
  process.stderr.write("team-mcp-server: invalid AGENT_IDS JSON\n");
}

const client = new MongoClient(MONGODB_URI);
const db = client.db(MONGODB_DB);
const messages = db.collection<TeamMessage>("team_messages");

// Shared collection for signaling — agent-to-agent request/response
const pendingRequests = db.collection("team_pending_requests");

const server = new McpServer({ name: "team", version: "1.0.0" });

// ── Tool: send_message ─────────────────────────────────────────────────

server.registerTool(
  "send_message",
  {
    title: "Send Message to Agent",
    description:
      "Send a direct message to another agent. Use this for coordination, " +
      "handoffs, or requesting information from a specialist. " +
      "Fire-and-forget by default (expectReply: false). " +
      "Set expectReply: true to wait for a response (60s timeout). " +
      "WARNING: expectReply blocks your session until the target responds — " +
      "do NOT use expectReply:true if the target agent might also be waiting on you " +
      "(deadlock). Prefer fire-and-forget for most coordination.",
    inputSchema: {
      targetAgentId: z.string().describe("Agent ID to send to (e.g., 'jessica', 'sige')"),
      text: z.string().describe("Message text"),
      expectReply: z
        .boolean()
        .optional()
        .default(false)
        .describe("Wait for response? Default: false (fire-and-forget)"),
      context: z.string().optional().describe("Thread or reference context"),
    },
  },
  async ({ targetAgentId, text, expectReply, context }) => {
    if (targetAgentId === AGENT_ID) {
      return {
        content: [{ type: "text" as const, text: "Cannot send a message to yourself." }],
        isError: true,
      };
    }

    if (!agentIds.includes(targetAgentId)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown agent: "${targetAgentId}". Available agents: ${agentIds.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    const channelId = internalChannelId(AGENT_ID, targetAgentId);
    const threadId = context ?? `${Date.now()}`;

    // Save the outbound message
    await messages.insertOne({
      channelId,
      threadId,
      senderId: AGENT_ID,
      senderType: "agent",
      senderName: AGENT_ID,
      text,
      createdAt: new Date(),
    } as TeamMessage);

    if (!expectReply) {
      // Fire-and-forget: signal dispatcher to deliver, don't wait
      await pendingRequests.insertOne({
        type: "fire_and_forget",
        fromAgentId: AGENT_ID,
        targetAgentId,
        text,
        channelId,
        threadId,
        createdAt: new Date(),
        status: "pending",
      });

      return {
        content: [{ type: "text" as const, text: `Message sent to ${targetAgentId}.` }],
      };
    }

    // Deadlock guard: if the target already has a pending request_response targeting us, refuse
    const reverseRequest = await pendingRequests.findOne({
      fromAgentId: targetAgentId,
      targetAgentId: AGENT_ID,
      type: "request_response",
      status: { $in: ["pending", "fired"] },
    });
    if (reverseRequest) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Deadlock prevented: ${targetAgentId} is already waiting for a reply from you. ` +
              `Use expectReply: false instead, or respond to their request first.`,
          },
        ],
        isError: true,
      };
    }

    // Request/response: create a pending request and poll for reply
    const requestId = new ObjectId();
    await pendingRequests.insertOne({
      _id: requestId,
      type: "request_response",
      fromAgentId: AGENT_ID,
      targetAgentId,
      text,
      channelId,
      threadId,
      createdAt: new Date(),
      status: "pending",
      response: null,
    });

    // Poll for response (60s timeout, 2s intervals)
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const req = await pendingRequests.findOne({ _id: requestId });
      if (req?.status === "completed" && req.response) {
        return {
          content: [{ type: "text" as const, text: req.response as string }],
        };
      }
    }

    return {
      content: [{ type: "text" as const, text: `No response from ${targetAgentId} within 60s.` }],
      isError: true,
    };
  },
);

// ── Tool: list_agents ──────────────────────────────────────────────────

server.registerTool(
  "list_agents",
  {
    title: "List Available Agents",
    description: "List all agents available for direct messaging.",
    inputSchema: {},
  },
  async () => {
    const others = agentIds.filter((id) => id !== AGENT_ID);
    return {
      content: [
        {
          type: "text" as const,
          text: `Available agents:\n${others.map((id) => `  - ${id}`).join("\n")}`,
        },
      ],
    };
  },
);

// ── Start ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
