export type ChannelKind = "slack" | "sms" | "email" | "scheduler" | "internal";

export interface ChannelRef {
  kind: ChannelKind;
  id: string;
  label: string;
  adapterId?: string;
}

export interface WorkItem {
  id: string;
  text: string;
  source: ChannelRef;
  sender: string;
  senderName?: string;
  threadId?: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
}

export interface WorkResult {
  text: string;
  agentId: string;
  workItem: WorkItem;
  costUsd: number;
  durationMs: number;
  error?: string;
}