import type { AgentSchedule } from "./agent-config.js";
import type { AgentConfig } from "./agent-config.js";
import type { ResourceTierOverrides } from "../agents/model-router.js";
import { resolveAutonomy, type AutonomyFlags } from "../agents/autonomy.js";

export interface AgentDefinition {
  _id: string; // "rae", "jasper" — immutable after creation
  name: string;
  icon: string;

  // LLM
  model: string;
  betas?: string[];

  // Routing
  channels: string[];
  homeBase?: string; // Primary channel for scheduler delivery; required at agent_create boundary
  catches?: string[]; // Origin slugs this agent owns — routes `?origin=<slug>` app traffic
  passiveChannels: string[];
  keywords: string[];
  isDefault: boolean;

  // Capabilities
  coreServers: string[];
  delegateServers: string[];
  delegatePrompts: Record<string, string>;
  plugins?: string[];
  /**
   * Plugin-managed per-agent settings. Core never reads this field — plugins
   * pull values via `agent-env` manifest mappings (e.g. `metadata.dodiOpsMode`).
   * Free-form to avoid coupling core to plugin schemas.
   */
  metadata?: Record<string, unknown>;

  // Identity
  soul: string;
  systemPrompt: string;

  // Archetype (optional — unset = unstructured agent, current behavior)
  archetype?: string; // discipline id, e.g. "software-engineer"
  title?: string; // customer-facing title, e.g. "VP Engineering"
  archetypeConfig?: Record<string, unknown>; // opaque blob, validated by the archetype

  // Scheduling
  schedule: AgentSchedule[];
  subscribe?: string[];

  // Limits
  budgetUsd: number;
  maxTurns: number;
  maxConcurrent: number;
  timeoutMs: number;
  resourceTiers?: ResourceTierOverrides;

  // Autonomy — per-agent capability gates (can only restrict, never escalate beyond instance ceiling)
  autonomy?: Partial<AutonomyFlags>;

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
  coreServers: ["memory", "structured-memory", "keychain", "event-bus", "contacts"] satisfies readonly string[],
  delegateServers: [] satisfies readonly string[],
} as const;

export function toAgentConfig(doc: AgentDefinition, instanceAutonomy?: Partial<AutonomyFlags>): AgentConfig {
  return {
    id: doc._id,
    name: doc.name,
    model: doc.model,
    channels: doc.channels ?? [],
    homeBase: doc.homeBase,
    catches: doc.catches,
    passiveChannels: doc.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
    keywords: doc.keywords ?? AGENT_DEFINITION_DEFAULTS.keywords,
    isDefault: doc.isDefault ?? false,
    schedule: doc.schedule ?? AGENT_DEFINITION_DEFAULTS.schedule,
    budgetUsd: doc.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
    maxTurns: doc.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
    icon: doc.icon ?? AGENT_DEFINITION_DEFAULTS.icon,
    slackBot: doc.slackBot,
    coreServers: doc.coreServers ?? [...AGENT_DEFINITION_DEFAULTS.coreServers],
    delegateServers: doc.delegateServers ?? [...AGENT_DEFINITION_DEFAULTS.delegateServers],
    plugins: doc.plugins,
    maxConcurrent: doc.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent,
    timeoutMs: doc.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
    betas: doc.betas,
    metadata: doc.metadata,
    disabled: doc.disabled ?? false,
    subscribe: doc.subscribe ?? [],
    resourceTiers: doc.resourceTiers,
    delegatePrompts: doc.delegatePrompts ?? AGENT_DEFINITION_DEFAULTS.delegatePrompts,
    soul: doc.soul ?? "",
    systemPrompt: doc.systemPrompt ?? "",
    archetype: doc.archetype,
    title: doc.title,
    archetypeConfig: doc.archetypeConfig,
    autonomy: resolveAutonomy(instanceAutonomy, doc.autonomy),
  };
}
