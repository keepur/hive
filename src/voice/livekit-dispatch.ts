/**
 * Pure dispatch-payload builder for the LiveKit voice_call tool (KPR-322 E4).
 * Kept import-light (node:crypto only) and free of env reads / side effects
 * so unit tests can import it without tripping the stdio server's env gate.
 */
import { randomUUID } from "node:crypto";

export interface DispatchArgs {
  roomName: string;
  agentName: string;
  metadata: string;
}

export function buildDispatchArgs(input: {
  to: string;
  goal: string;
  context?: string;
  agentId: string;
  agentName: string;
}): DispatchArgs {
  return {
    roomName: `call-${randomUUID()}`,
    agentName: "hive-voice",
    metadata: JSON.stringify({
      hive_agent_id: input.agentId,
      agent_name: input.agentName,
      to: input.to,
      goal: input.goal,
      context: input.context ?? "",
    }),
  };
}
