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
  user: string;
  ts: string;
  threadTs?: string;
}
