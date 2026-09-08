import type { WorkItemContext, LANE_B_PROVIDER_ABI_VERSION } from "../../src/agents/provider-adapters/provider-abi.js";

export const currentAbi: typeof LANE_B_PROVIDER_ABI_VERSION = 1;
export const legacy: WorkItemContext = {
  adapterId: "slack-main",
  channelId: "C-identity",
  channelKind: "slack",
  channelLabel: "general",
  threadId: "thread-shared",
  slackTs: "100.2",
  slackThreadTs: "100.1",
};
export const enriched: WorkItemContext = { ...legacy, workItemId: " work:opaque/Ω#dl1 " };
export const unavailable: string | undefined = legacy.workItemId;
export const supplied: string | undefined = enriched.workItemId;
// @ts-expect-error Identity is an optional string, never a number.
export const invalid: WorkItemContext = { ...legacy, workItemId: 42 };
