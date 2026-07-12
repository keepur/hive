import type { ResourceTierOverrides } from "../agents/model-router.js";
import type { AutonomyFlags } from "../agents/autonomy.js";

export interface AgentSchedule {
  cron: string;
  task: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  aliases: string[];
  roles: string[];
  model: string;
  channels: string[];
  homeBase?: string;
  catches?: string[]; // origin slugs this agent owns (e.g. ["dodi-shop"])
  passiveChannels: string[];
  keywords: string[];
  isDefault: boolean;
  /**
   * KPR-308: outage-mode delivery preference (see AgentDefinition.floorCritical).
   * Always a strict boolean after toAgentConfig projection; optional on the
   * type so hand-built configs (tests, fixtures) don't churn.
   */
  floorCritical?: boolean;
  schedule: AgentSchedule[];
  budgetUsd: number;
  maxTurns: number;
  icon: string; // emoji like ":briefcase:" or URL
  slackBot?: string; // which Slack bot this agent uses (e.g. "jasper") — omit for primary bot
  coreServers: string[];
  delegateServers: string[];
  plugins?: string[]; // Claude Code plugin allowlist. Omit = no plugins
  /** @deprecated KPR-220: use spawnBudget. Retained as fallback for legacy agent docs. */
  maxConcurrent?: number; // Max concurrent threads. Default 3
  /**
   * KPR-220: per-agent in-flight spawn budget (number of concurrent
   * `query()` calls allowed across all threads of this agent). Falls back
   * to `maxConcurrent` then to engine default (5) if unset.
   */
  spawnBudget?: number;
  /**
   * KPR-329: per-agent tool-search override ("auto" | "on" | "off").
   * Absent ⇒ inherit hive.yaml toolSearch.mode. Guaranteed valid-or-undefined
   * post-registry-load (sanitized there); hand-built configs may carry
   * anything, which resolveToolSearchEnv treats as absent.
   */
  toolSearch?: "auto" | "on" | "off";
  timeoutMs?: number; // Response timeout in ms. Default 300000 (5 min)
  betas?: string[]; // SDK beta features. Note: "context-1m-2025-08-07" retires 2026-04-30
  metadata?: Record<string, unknown>; // plugin-managed bag — read via agent-env dotted paths
  disabled?: boolean; // Agent is offline — won't receive messages or run schedules
  subscribe?: string[]; // Event bus domain subscriptions (e.g., ["deals", "jobs"])
  resourceTiers?: ResourceTierOverrides;
  delegatePrompts?: Record<string, string>;
  soul: string;
  systemPrompt: string;
  archetype?: string; // discipline id
  title?: string; // customer-facing title
  archetypeConfig?: Record<string, unknown>; // opaque blob, validated by archetype on load
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
