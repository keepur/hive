import type { AgentSchedule } from "./agent-config.js";
import type { AgentConfig } from "./agent-config.js";

export interface AgentDefinition {
  _id: string; // "rae", "jasper" — immutable after creation
  name: string;
  icon: string;

  // LLM
  model: string;
  triageModel?: string;

  // Routing
  channels: string[];
  passiveChannels: string[];
  keywords: string[];
  isDefault: boolean;

  // Capabilities
  coreServers: string[];
  delegateServers: string[];
  delegatePrompts: Record<string, string>;
  plugins?: string[];
  dodiOpsMode?: "full" | "readonly";

  // Identity
  soul: string;
  systemPrompt: string;

  // Scheduling
  schedule: AgentSchedule[];
  subscribe?: string[];

  // Limits
  budgetUsd: number;
  maxTurns: number;
  maxConcurrent: number;
  timeoutMs: number;

  // Lifecycle
  disabled: boolean;
  slackBot?: string;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
}

export interface AgentDefinitionVersion {
  agentId: string;
  snapshot: AgentDefinition;
  changedFields: string[];
  createdAt: Date;
}

/** Defaults applied by toAgentConfig when fields are absent */
export const AGENT_DEFINITION_DEFAULTS = {
  maxConcurrent: 3,
  timeoutMs: 300_000,
  budgetUsd: 10,
  maxTurns: 200,
  icon: "",
  keywords: [] as string[],
  passiveChannels: [] as string[],
  delegatePrompts: {} as Record<string, string>,
  schedule: [] as AgentSchedule[],
} as const;

export function toAgentConfig(doc: AgentDefinition): AgentConfig {
  return {
    id: doc._id,
    name: doc.name,
    model: doc.model,
    channels: doc.channels ?? [],
    passiveChannels: doc.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
    keywords: doc.keywords ?? AGENT_DEFINITION_DEFAULTS.keywords,
    isDefault: doc.isDefault ?? false,
    schedule: doc.schedule ?? AGENT_DEFINITION_DEFAULTS.schedule,
    budgetUsd: doc.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
    maxTurns: doc.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
    icon: doc.icon ?? AGENT_DEFINITION_DEFAULTS.icon,
    slackBot: doc.slackBot,
    coreServers: doc.coreServers ?? [],
    delegateServers: doc.delegateServers ?? [],
    plugins: doc.plugins,
    maxConcurrent: doc.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent,
    timeoutMs: doc.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
    triageModel: doc.triageModel,
    dodiOpsMode: doc.dodiOpsMode,
    disabled: doc.disabled ?? false,
    subscribe: doc.subscribe ?? [],
    delegatePrompts: doc.delegatePrompts ?? AGENT_DEFINITION_DEFAULTS.delegatePrompts,
    soul: doc.soul ?? "",
    systemPrompt: doc.systemPrompt ?? "",
  };
}
