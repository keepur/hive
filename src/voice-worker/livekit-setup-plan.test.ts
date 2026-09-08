import { describe, expect, it } from "vitest";
import {
  AGENT_NAME,
  DISPATCH_RULE_NAME,
  INBOUND_TRUNK_NAME,
  OUTBOUND_TRUNK_NAME,
  ROOM_PREFIX,
  planSetup,
  type ExistingState,
} from "./livekit-setup-plan.js";

const empty: ExistingState = {
  outboundTrunks: [],
  inboundTrunks: [],
  dispatchRules: [],
};

describe("planSetup (KPR-322 SIP-1..3)", () => {
  it("empty state → create outbound, inbound, and dispatch rule", () => {
    const plan = planSetup(empty);
    expect(plan.createOutbound).toBe(true);
    expect(plan.createInbound).toBe(true);
    expect(plan.createDispatchRule).toBe(true);
    expect(plan.existingOutboundId).toBeUndefined();
    expect(plan.existingInboundId).toBeUndefined();
    expect(plan.existingDispatchRuleId).toBeUndefined();
  });

  it("full state → create none and surface existing IDs", () => {
    const plan = planSetup({
      outboundTrunks: [{ sipTrunkId: "ST_out", name: OUTBOUND_TRUNK_NAME }],
      inboundTrunks: [{ sipTrunkId: "ST_in", name: INBOUND_TRUNK_NAME }],
      dispatchRules: [{ sipDispatchRuleId: "SDR_1", name: DISPATCH_RULE_NAME }],
    });
    expect(plan).toEqual({
      createOutbound: false,
      createInbound: false,
      createDispatchRule: false,
      existingOutboundId: "ST_out",
      existingInboundId: "ST_in",
      existingDispatchRuleId: "SDR_1",
    });
  });

  it("partial state → only missing objects are created", () => {
    const outboundOnly = planSetup({
      ...empty,
      outboundTrunks: [{ sipTrunkId: "ST_out", name: OUTBOUND_TRUNK_NAME }],
    });
    expect(outboundOnly.createOutbound).toBe(false);
    expect(outboundOnly.createInbound).toBe(true);
    expect(outboundOnly.createDispatchRule).toBe(true);
    expect(outboundOnly.existingOutboundId).toBe("ST_out");
    expect(outboundOnly.existingInboundId).toBeUndefined();
    expect(outboundOnly.existingDispatchRuleId).toBeUndefined();

    const missingDispatch = planSetup({
      outboundTrunks: [{ sipTrunkId: "ST_out", name: OUTBOUND_TRUNK_NAME }],
      inboundTrunks: [{ sipTrunkId: "ST_in", name: INBOUND_TRUNK_NAME }],
      dispatchRules: [],
    });
    expect(missingDispatch.createOutbound).toBe(false);
    expect(missingDispatch.createInbound).toBe(false);
    expect(missingDispatch.createDispatchRule).toBe(true);
    expect(missingDispatch.existingOutboundId).toBe("ST_out");
    expect(missingDispatch.existingInboundId).toBe("ST_in");
    expect(missingDispatch.existingDispatchRuleId).toBeUndefined();
  });

  it("name constants are distinct and stable", () => {
    expect(OUTBOUND_TRUNK_NAME).toBe("hive-voice-outbound (KPR-322)");
    expect(INBOUND_TRUNK_NAME).toBe("hive-voice-inbound (KPR-322)");
    expect(DISPATCH_RULE_NAME).toBe("hive-voice-individual (KPR-322)");
    expect(ROOM_PREFIX).toBe("call-");
    expect(AGENT_NAME).toBe("hive-voice");
    expect(new Set([OUTBOUND_TRUNK_NAME, INBOUND_TRUNK_NAME, DISPATCH_RULE_NAME]).size).toBe(3);
  });

  it("name match is exact — similarly named objects do not count", () => {
    const plan = planSetup({
      outboundTrunks: [
        { sipTrunkId: "ST_near", name: "hive-voice-outbound" },
        { sipTrunkId: "ST_suffix", name: `${OUTBOUND_TRUNK_NAME} v2` },
      ],
      inboundTrunks: [{ sipTrunkId: "ST_in_near", name: `${INBOUND_TRUNK_NAME} ` }],
      dispatchRules: [{ sipDispatchRuleId: "SDR_near", name: "hive-voice-individual" }],
    });
    expect(plan.createOutbound).toBe(true);
    expect(plan.createInbound).toBe(true);
    expect(plan.createDispatchRule).toBe(true);
    expect(plan.existingOutboundId).toBeUndefined();
    expect(plan.existingInboundId).toBeUndefined();
    expect(plan.existingDispatchRuleId).toBeUndefined();
  });
});
