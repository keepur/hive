import type { AgentSchedule } from "./agent-config.js";
import type { AgentConfig } from "./agent-config.js";
import type { ResourceTierOverrides } from "../agents/model-router.js";
import { resolveAutonomy, type AutonomyFlags } from "../agents/autonomy.js";

export interface AgentDefinition {
  _id: string; // "rae", "jasper" — immutable after creation
  name: string;
  aliases?: string[]; // Short names / nicknames for name-based routing (e.g. ["Sam"] for "Samantha")
  /**
   * What this agent does — one or more concise role labels surfaced via
   * team_lookup_agent and the team summary in system prompts. Required from
   * KPR-141 onwards; legacy docs may have an empty array (engine soft-warns
   * at load time). Examples: ["VP Engineering"], ["Production Support",
   * "Bilingual liaison (Mandarin/English)"].
   */
  roles: string[];
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
  /**
   * KPR-308: outage-mode delivery preference. When true and the dispatcher's
   * outage-state provider reports an active outage, this agent's slack/
   * scheduler-sourced output is diverted to the app (WS) channel via
   * broadcast so the shop floor keeps receiving it while the WAN is down.
   * Optional on the doc; projected to a strict boolean (default false) by
   * toAgentConfig — liberal-loader pattern, garbage coerces to false.
   */
  floorCritical?: boolean;

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
  /** @deprecated KPR-220: use spawnBudget. Retained as fallback for legacy agent docs.
   * Optional post-Phase-13 — new creates write `spawnBudget` only. */
  maxConcurrent?: number;
  /**
   * KPR-220: per-agent in-flight spawn budget. Falls back to maxConcurrent,
   * then to the engine default (5). Admin tools should write here; reads
   * may consult both fields.
   */
  spawnBudget?: number;
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
  /** @deprecated KPR-220: use spawnBudget. Retained for `toAgentConfig` runtime fallback. */
  maxConcurrent: 3,
  /** KPR-220 Phase 13: canonical default for new agents. New creates write this; reads
   * accept legacy `maxConcurrent` via the spawnBudgetFor fallback chain. */
  spawnBudget: 5,
  timeoutMs: 300_000,
  budgetUsd: 10,
  maxTurns: 200,
  icon: "",
  roles: [] as string[],
  keywords: [] as string[],
  passiveChannels: [] as string[],
  delegatePrompts: {} as Record<string, string>,
  schedule: [] as AgentSchedule[],
  coreServers: [
    "memory",
    "structured-memory",
    "keychain",
    "contacts",
    "event-bus",
    "conversation-search",
    "callback",
    "schedule",
    "slack",
  ] satisfies readonly string[],
  delegateServers: [] satisfies readonly string[],
} as const;

export function toAgentConfig(doc: AgentDefinition, instanceAutonomy?: Partial<AutonomyFlags>): AgentConfig {
  return {
    id: doc._id,
    name: doc.name,
    aliases: doc.aliases ?? [],
    roles: doc.roles ?? AGENT_DEFINITION_DEFAULTS.roles,
    model: doc.model,
    channels: doc.channels ?? [],
    homeBase: doc.homeBase,
    catches: doc.catches,
    passiveChannels: doc.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
    keywords: doc.keywords ?? AGENT_DEFINITION_DEFAULTS.keywords,
    isDefault: doc.isDefault ?? false,
    // KPR-308: strict-boolean coercion — absent/garbage → false (spec §5.7).
    floorCritical: doc.floorCritical === true,
    schedule: doc.schedule ?? AGENT_DEFINITION_DEFAULTS.schedule,
    budgetUsd: doc.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
    maxTurns: doc.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
    icon: doc.icon ?? AGENT_DEFINITION_DEFAULTS.icon,
    slackBot: doc.slackBot,
    coreServers: doc.coreServers ?? [...AGENT_DEFINITION_DEFAULTS.coreServers],
    delegateServers: doc.delegateServers ?? [...AGENT_DEFINITION_DEFAULTS.delegateServers],
    plugins: doc.plugins,
    // KPR-220 Phase 17: pass `maxConcurrent` through as-is (no default
    // materialization). Materializing it here populated the field with
    // AGENT_DEFINITION_DEFAULTS.maxConcurrent = 3 for legacy docs missing
    // both fields, which made the `spawnBudgetFor` fallback's final branch
    // (`?? DEFAULT_PER_AGENT_SPAWN_BUDGET` = 5) unreachable — legacy agents
    // silently ran at budget=3 instead of the spec'd engine default of 5.
    // `AgentConfig.maxConcurrent` is already optional; nothing reads it
    // at runtime (the field is @deprecated; spawnBudgetFor consults it
    // via the def via registry.get, not via cfg).
    maxConcurrent: doc.maxConcurrent,
    spawnBudget: doc.spawnBudget,
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
