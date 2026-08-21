import { describe, expect, it } from "vitest";
import { buildDispatchArgs } from "./livekit-dispatch.js";

const ROOM_NAME = /^call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const baseInput = {
  to: "+14155551234",
  goal: "Confirm the appointment",
  context: "Order #42, prefers mornings",
  agentId: "chief-of-staff",
  agentName: "Milo",
};

describe("buildDispatchArgs", () => {
  it("roomName starts with call- and has a UUID suffix", () => {
    const args = buildDispatchArgs(baseInput);
    expect(args.roomName.startsWith("call-")).toBe(true);
    expect(args.roomName).toMatch(ROOM_NAME);
  });

  it('agentName is exactly "hive-voice"', () => {
    expect(buildDispatchArgs(baseInput).agentName).toBe("hive-voice");
  });

  it("metadata JSON round-trips hive_agent_id, agent_name, to, goal, context", () => {
    const meta = JSON.parse(buildDispatchArgs(baseInput).metadata) as Record<string, string>;
    expect(meta).toEqual({
      hive_agent_id: "chief-of-staff",
      agent_name: "Milo",
      to: "+14155551234",
      goal: "Confirm the appointment",
      context: "Order #42, prefers mornings",
    });
  });

  it("omitted context defaults to empty string", () => {
    const meta = JSON.parse(
      buildDispatchArgs({
        to: baseInput.to,
        goal: baseInput.goal,
        agentId: baseInput.agentId,
        agentName: baseInput.agentName,
      }).metadata,
    ) as Record<string, string>;
    expect(meta.context).toBe("");
  });

  it("two calls produce distinct roomNames", () => {
    const a = buildDispatchArgs(baseInput);
    const b = buildDispatchArgs(baseInput);
    expect(a.roomName).not.toBe(b.roomName);
  });
});
