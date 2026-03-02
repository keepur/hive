export interface AgentSchedule {
  cron: string;
  task: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  channels: string[];
  keywords: string[];
  isDefault: boolean;
  schedule: AgentSchedule[];
  budgetUsd: number;
  maxTurns: number;
  icon: string; // emoji like ":briefcase:" or URL
  slackBot?: string; // which Slack bot this agent uses (e.g. "jasper") — omit for primary bot
  soul: string;
  systemPrompt: string;
}

export type AgentStatus = "idle" | "processing" | "error" | "stopped";

export interface AgentState {
  id: string;
  status: AgentStatus;
  lastActivity: Date;
  messagesProcessed: number;
  errorCount: number;
  currentSessionId?: string;
}

export interface IncomingMessage {
  text: string;
  channel: string;
  channelName: string;
  user: string;
  ts: string;
  threadTs?: string;
}

// Channel-agnostic types (new architecture)
export type { WorkItem, WorkResult, ChannelRef, ChannelKind } from "./work-item.js";
