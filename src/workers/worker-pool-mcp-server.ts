/**
 * KPR-390: worker-pool MCP server — in-process via createSdkMcpServer
 * (callback-server template). 3 tools; per-turn channel/thread metadata
 * flows through a mutable context ref the runner refreshes each turn.
 * All handlers try/caught returning structured errors (in-process
 * convention — a handler exception must never crash the hive).
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { MeetingWorkerPool, WorkerPoolTurnContext } from "./meeting-worker-pool.js";

export interface WorkerPoolToolDeps {
  pool: MeetingWorkerPool;
  agentId: string;
  context: { current: WorkerPoolTurnContext };
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fail(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

export function buildWorkerPoolTools(deps: WorkerPoolToolDeps) {
  const { pool, agentId, context } = deps;
  return [
    tool(
      "worker_dispatch",
      "Dispatch a background worker to fetch data or do legwork for this meeting. Returns immediately — end your turn after telling the room you've sent someone; you will be re-triggered in this thread with the worker's report. Meeting-only. Checks the claim ledger first: if an equivalent task is already in progress you get the claimant's name instead of a new worker.",
      {
        task: z
          .string()
          .min(10)
          .describe(
            "What to fetch/do AND what to return; self-contained (the worker has your tools but not this conversation).",
          ),
      },
      async ({ task }) => {
        try {
          return ok(await pool.dispatch({ bossAgentId: agentId, task, context: context.current }));
        } catch (err) {
          return fail(`worker_dispatch error: ${String(err)}`);
        }
      },
    ),
    tool("worker_status", "List this meeting's worker claims (running and recently finished).", {}, async () => {
      try {
        const threadId = context.current.threadId;
        if (!threadId) return fail("worker_status: no thread context on this turn.");
        return ok(await pool.status(threadId));
      } catch (err) {
        return fail(`worker_status error: ${String(err)}`);
      }
    }),
    tool(
      "worker_cancel",
      "Cancel a running worker claim you dispatched.",
      { claimId: z.string().describe("The claim id from worker_dispatch or worker_status.") },
      async ({ claimId }) => {
        try {
          return ok(await pool.cancel(claimId, agentId));
        } catch (err) {
          return fail(`worker_cancel error: ${String(err)}`);
        }
      },
    ),
  ];
}

export function createWorkerPoolMcpServer(deps: WorkerPoolToolDeps) {
  return createSdkMcpServer({
    name: "worker-pool",
    version: "1.0.0",
    tools: buildWorkerPoolTools(deps),
  });
}
