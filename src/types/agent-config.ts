import type { ResourceTierOverrides } from "../agents/model-router.js";
import type { AutonomyFlags } from "../agents/autonomy.js";

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
  coreServers: string[];
  delegateServers: string[];
  plugins?: string[]; // Claude Code plugin allowlist. Omit = no plugins
  maxConcurrent?: number; // Max concurrent threads. Default 3
  timeoutMs?: number; // Response timeout in ms. Default 300000 (5 min)
  triageModel?: string; // Override triage model. Default: config.triage.model
  betas?: string[]; // SDK beta features. Note: "context-1m-2025-08-07" retires 2026-04-30
  dodiOpsMode?: "full" | "readonly"; // Dodi Ops access level. Default: "full"
  disabled?: boolean; // Agent is offline — won't receive messages or run schedules
  subscribe?: string[]; // Event bus domain subscriptions (e.g., ["deals", "jobs"])
  resourceTiers?: ResourceTierOverrides;
  delegatePrompts?: Record<string, string>;
  soul: string;
  systemPrompt: string;
  autonomy: AutonomyFlags; // resolved — always present
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
