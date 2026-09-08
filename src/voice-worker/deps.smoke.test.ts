import { describe, expect, it } from "vitest";

describe("livekit deps load on this platform (KPR-322)", () => {
  it("imports @livekit/agents and livekit-server-sdk", async () => {
    const agents = await import("@livekit/agents");
    const sdk = await import("livekit-server-sdk");
    expect(agents.defineAgent).toBeTypeOf("function");
    expect(sdk.SipClient).toBeTypeOf("function");
  });
});
