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

  /** KPR-389: conference turn kind — 0 primary, 1 peer reaction; absent on
   *  non-conference turns. Kills/errors DO reach this log (unlike turn
   *  telemetry), keeping reaction kill counts measurable. */
  conferenceRound?: number;
}
