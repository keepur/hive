export type ChannelKind = "slack" | "sms" | "imessage" | "email" | "scheduler" | "callback" | "internal" | "app";

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
  /** Processed file attachments from the message */
  files?: import("../files/file-processor.js").ProcessedFile[];
}

export interface WorkResult {
  text: string;
  agentId: string;
  workItem: WorkItem;
  costUsd: number;
  durationMs: number;
  error?: string;
}
