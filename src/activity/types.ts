export interface ActivityRecord {
  // Identity
  agentId: string;
  threadId: string;
  timestamp: Date;

  // Source
  sender: string;
  senderName?: string;
  channel: string;
  channelKind: string;

  // Model
  model: string;
  modelTier?: string;

  // Cost & performance
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;

  // Tools
  toolCalls: number;
  toolSummary: string;

  // Compaction
  compactions: number;

  // Outcome
  streamed: boolean;
  error?: string;
}
