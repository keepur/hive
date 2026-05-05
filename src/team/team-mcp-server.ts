/**
 * Team MCP Server — agent-to-agent direct messaging.
 *
 * KPR-122 port: in-process via createSdkMcpServer. Tool handlers close over
 * the shared engine Db. The list of valid agent ids is read live via the
 * `getAgentIds` callback (no JSON-serialized snapshot), so hot reloads land
 * without rebuilding the cached server.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ObjectId, type Db } from "mongodb";
import type { TeamMessage } from "./types.js";
import { internalChannelId } from "./types.js";

export interface TeamToolDeps {
  db: Db;
  agentId: string;
  /** Live agent-id lookup — invoked on every tool call so hot reloads apply. */
  getAgentIds: () => string[];
}

export function buildTeamTools(deps: TeamToolDeps) {
  const { db, agentId, getAgentIds } = deps;
  const messages = db.collection<TeamMessage>("team_messages");
  const pendingRequests = db.collection("team_pending_requests");

  return [
    tool(
      "send_message",
      "Send a direct message to another agent. Use this for coordination, handoffs, or requesting information from a specialist. Fire-and-forget by default (expectReply: false). Set expectReply: true to wait for a response (60s timeout). WARNING: expectReply blocks your session until the target responds — do NOT use expectReply:true if the target agent might also be waiting on you (deadlock). Prefer fire-and-forget for most coordination.",
      {
        targetAgentId: z.string().describe("Agent ID to send to (e.g., 'jessica', 'sige')"),
        text: z.string().describe("Message text"),
        expectReply: z.boolean().optional().describe("Wait for response? Default: false (fire-and-forget)"),
        context: z.string().optional().describe("Thread or reference context"),
      },
      async ({ targetAgentId, text, expectReply, context }) => {
        try {
          if (targetAgentId === agentId) {
            return {
              isError: true,
              content: [{ type: "text", text: "Cannot send a message to yourself." }],
            };
          }

          const agentIds = getAgentIds();
          if (!agentIds.includes(targetAgentId)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Unknown agent: "${targetAgentId}". Available agents: ${agentIds.join(", ")}`,
                },
              ],
            };
          }

          const channelId = internalChannelId(agentId, targetAgentId);
          const threadId = context ?? `${Date.now()}`;

          await messages.insertOne({
            channelId,
            threadId,
            senderId: agentId,
            senderType: "agent",
            senderName: agentId,
            text,
            createdAt: new Date(),
          } as TeamMessage);

          if (!expectReply) {
            await pendingRequests.insertOne({
              type: "fire_and_forget",
              fromAgentId: agentId,
              targetAgentId,
              text,
              channelId,
              threadId,
              createdAt: new Date(),
              status: "pending",
            });

            return { content: [{ type: "text", text: `Message sent to ${targetAgentId}.` }] };
          }

          const reverseRequest = await pendingRequests.findOne({
            fromAgentId: targetAgentId,
            targetAgentId: agentId,
            type: "request_response",
            status: { $in: ["pending", "fired"] },
          });
          if (reverseRequest) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Deadlock prevented: ${targetAgentId} is already waiting for a reply from you. Use expectReply: false instead, or respond to their request first.`,
                },
              ],
            };
          }

          const requestId = new ObjectId();
          await pendingRequests.insertOne({
            _id: requestId,
            type: "request_response",
            fromAgentId: agentId,
            targetAgentId,
            text,
            channelId,
            threadId,
            createdAt: new Date(),
            status: "pending",
            response: null,
          });

          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            const req = await pendingRequests.findOne({ _id: requestId });
            if (req?.status === "completed" && req.response) {
              return { content: [{ type: "text", text: req.response as string }] };
            }
          }

          return {
            isError: true,
            content: [{ type: "text", text: `No response from ${targetAgentId} within 60s.` }],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `send_message error: ${String(err)}` }] };
        }
      },
    ),
    tool("list_agents", "List all agents available for direct messaging.", {}, async () => {
      try {
        const agentIds = getAgentIds();
        const others = agentIds.filter((id) => id !== agentId);
        return {
          content: [
            {
              type: "text",
              text: `Available agents:\n${others.map((id) => `  - ${id}`).join("\n")}`,
            },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `list_agents error: ${String(err)}` }] };
      }
    }),
  ];
}

export function createTeamMcpServer(deps: TeamToolDeps) {
  return createSdkMcpServer({
    name: "team",
    version: "1.0.0",
    tools: buildTeamTools(deps),
  });
}
