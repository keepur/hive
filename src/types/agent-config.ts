export interface AgentSchedule {
  cron: string;
  task: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  channels: string[];
  passiveChannels: string[];
  keywords: string[];
  isDefault: boolean;
  schedule: AgentSchedule[];
  budgetUsd: number;
  maxTurns: number;
  icon: string; // emoji like ":briefcase:" or URL
  slackBot?: string; // which Slack bot this agent uses (e.g. "jasper") — omit for primary bot
  servers?: string[]; // MCP server allowlist. Omit = all servers (backward compat)
  maxConcurrent?: number; // Max concurrent threads. Default 3
  timeoutMs?: number; // Response timeout in ms. Default 300000 (5 min)
  triageModel?: string; // Override triage model. Default: config.triage.model
  dodiOpsMode?: "full" | "readonly"; // Dodi Ops access level. Default: "full"
  soul: string;
  systemPrompt: string;
}

export interface ArrayOverride {
  replace?: string[];
  add?: string[];
  remove?: string[];
}

export interface ConfigOverride {
  agentId: string;
  channels?: ArrayOverride;
  passiveChannels?: ArrayOverride;
  keywords?: ArrayOverride;
  servers?: ArrayOverride;
  isDefault?: boolean;
  budgetUsd?: number;
  maxTurns?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
  updatedAt: Date;
  updatedBy: string;
}

export type AgentStatus = "idle" | "processing" | "error" | "stopped";

export interface AgentState {
  id: string;
  status: AgentStatus;
  lastActivity: Date;
  messagesProcessed: number;
  errorCount: number;
  currentSessionId?: string;
  activeThreadCount: number;
}

export interface IncomingMessage {
  text: string;
  channel: string;
  channelName: string;
  user: string;
  ts: string;
  threadTs?: string;
  /** Processed file attachments from the message */
  files?: import("../files/file-processor.js").ProcessedFile[];
}

// Channel-agnostic types (new architecture)
export type { WorkItem, WorkResult, ChannelRef, ChannelKind } from "./work-item.js";
