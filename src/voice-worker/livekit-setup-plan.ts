/**
 * Idempotency planner for scripts/livekit-setup.ts (KPR-322 §10 SIP-1..3).
 * Pure: given current LiveKit state, decide create/skip per object. Matching
 * is by our fixed names — re-running the script never duplicates objects.
 */
export const OUTBOUND_TRUNK_NAME = "dodihome-ops-outbound (KPR-322)";
export const INBOUND_TRUNK_NAME = "dodihome-ops-inbound (KPR-322)";
export const DISPATCH_RULE_NAME = "hive-voice-individual (KPR-322)";
export const ROOM_PREFIX = "call-";
export const AGENT_NAME = "hive-voice";

export interface ExistingState {
  outboundTrunks: Array<{ sipTrunkId: string; name: string }>;
  inboundTrunks: Array<{ sipTrunkId: string; name: string }>;
  dispatchRules: Array<{ sipDispatchRuleId: string; name: string }>;
}

export interface SetupPlan {
  createOutbound: boolean;
  createInbound: boolean;
  createDispatchRule: boolean;
  existingOutboundId?: string;
  existingInboundId?: string;
  existingDispatchRuleId?: string;
}

export function planSetup(state: ExistingState): SetupPlan {
  const outbound = state.outboundTrunks.find((t) => t.name === OUTBOUND_TRUNK_NAME);
  const inbound = state.inboundTrunks.find((t) => t.name === INBOUND_TRUNK_NAME);
  const rule = state.dispatchRules.find((r) => r.name === DISPATCH_RULE_NAME);
  return {
    createOutbound: !outbound,
    createInbound: !inbound,
    createDispatchRule: !rule,
    existingOutboundId: outbound?.sipTrunkId,
    existingInboundId: inbound?.sipTrunkId,
    existingDispatchRuleId: rule?.sipDispatchRuleId,
  };
}
