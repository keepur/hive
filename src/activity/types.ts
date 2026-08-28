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
  /**
   * KPR-393 §D2: present-and-true iff the delivered text ends on an
   * unexecuted first-person commitment (detectIntentTrailer) on a
   * non-error turn. Absent otherwise — never false. Additive/optional:
   * schemaless Mongo, no migration. Detection is deliberately text-only —
   * slice against `toolCalls` in queries.
   */
  intentTrailer?: true;
  /** KPR-401: sparse — set only when true, so aborted turns stop
   * masquerading as free, instant, clean turns in the audit trail. */
  aborted?: boolean;
  timedOut?: boolean;
}
