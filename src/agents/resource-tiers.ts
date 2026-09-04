/**
 * Resource tiers — the Claude-lane per-agent execution envelope
 * (tier → timeoutMs / maxTurns / budgetUsd).
 *
 * KPR-433 D0: lifted out of model-router.ts so the admin MCP and `hive
 * doctor` can import the tier math without dragging in config.ts (throws at
 * module load on a missing .env) or llm/registry.ts (→ @anthropic-ai/sdk).
 * Dependency policy: this module imports ONLY the logger and
 * AGENT_DEFINITION_DEFAULTS. model-router.ts re-exports everything here, so
 * every pre-KPR-433 import path keeps working.
 */
import { createLogger } from "../logging/logger.js";
import { AGENT_DEFINITION_DEFAULTS } from "../types/agent-definition.js";

const log = createLogger("resource-tiers");

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface ResourceLimits {
  timeoutMs: number;
  maxTurns: number;
  budgetUsd: number;
}

/** Per-agent override map — only specified fields override the tier default */
export type ResourceTierOverrides = Partial<Record<ModelTier, Partial<ResourceLimits>>>;

/** Global defaults per tier — these fire when no per-agent override exists */
export const RESOURCE_TIER_DEFAULTS: Record<ModelTier, ResourceLimits> = {
  haiku:  { timeoutMs: 120_000,  maxTurns: 20,  budgetUsd: 1  },
  sonnet: { timeoutMs: 300_000,  maxTurns: 50,  budgetUsd: 5  },
  opus:   { timeoutMs: 600_000,  maxTurns: 200, budgetUsd: 50 },
};

/**
 * Resolve resource limits for a tier, applying per-agent overrides on top of global defaults.
 *
 * KPR-422: `agentTimeoutMs` is the agent definition's top-level `timeoutMs`.
 * Before this fix it was silently dead config on the claude/router-on path —
 * the tier default always won, so a custom-tier model (modelToTier → "sonnet")
 * with `timeoutMs: 1_800_000` still got killed at 300s. Precedence now:
 * explicit `resourceTiers.<tier>.timeoutMs` > top-level `timeoutMs` > tier
 * default.
 *
 * The top-level value participates only when it differs from the materialized
 * default (300_000): `agent_create` and `toAgentConfig` both write
 * `timeoutMs: 300_000` into docs/configs that never set one, so the raw value
 * cannot distinguish operator intent — and folding the materialized default in
 * unconditionally would drop every opus agent from 600s to 300s and loosen
 * every haiku agent from 120s to 300s. Residual corner (accepted): explicitly
 * setting exactly 300_000 on a non-sonnet tier is indistinguishable from the
 * materialized default and keeps the tier default. `maxTurns`/`budgetUsd`
 * deliberately stay tier-defaulted — their materialized defaults (200/10) are
 * likewise indistinguishable from operator intent, and folding them in would
 * flip real bounds (e.g. every sonnet agent's maxTurns 50 → 200; note the
 * maxTurns default coincides with the opus tier value, so no sentinel trick
 * exists for it).
 *
 * Non-finite / non-positive values (a `timeoutMs: 0`, a string cast, NaN) are
 * ignored here rather than armed as a millisecond deadline — the admin write
 * path doesn't validate the field, and pre-KPR-422 such garbage was inert on
 * this path. (Other lanes read the raw field directly and always did.)
 */
export function resolveResourceLimits(
  tier: ModelTier,
  agentOverrides?: ResourceTierOverrides,
  agentTimeoutMs?: number,
): ResourceLimits {
  const defaults = RESOURCE_TIER_DEFAULTS[tier];
  const overrides = agentOverrides?.[tier];
  const explicitTimeoutMs =
    typeof agentTimeoutMs === "number" &&
    Number.isFinite(agentTimeoutMs) &&
    agentTimeoutMs > 0 &&
    agentTimeoutMs !== AGENT_DEFINITION_DEFAULTS.timeoutMs
      ? agentTimeoutMs
      : undefined;
  return {
    timeoutMs: overrides?.timeoutMs ?? explicitTimeoutMs ?? defaults.timeoutMs,
    maxTurns: overrides?.maxTurns ?? defaults.maxTurns,
    budgetUsd: overrides?.budgetUsd ?? defaults.budgetUsd,
  };
}

/** KPR-433 D2: where a delivered value came from. `top-level` can only ever appear on timeoutMs (KPR-422). */
export type ResourceLimitSource = "resourceTiers" | "top-level" | "tier-default";

export interface ExplainedResourceLimits extends ResourceLimits {
  tier: ModelTier;
  sources: Record<keyof ResourceLimits, ResourceLimitSource>;
}

const isSet = (v: unknown): boolean => v !== undefined && v !== null;

/**
 * KPR-433 D2: resolveResourceLimits with a source label per field. Same
 * inputs, same precedence, pure, no logging — pinned value-equal to
 * resolveResourceLimits by test (it is NOT re-implemented on top of it: the
 * resolver stays byte-identical). An explicit top-level 300_000 is
 * indistinguishable from the materialized default by design (KPR-422) and
 * reports `tier-default` (spec §7.8); garbage timeoutMs reports `tier-default`
 * because the resolver ignores it (§7.7).
 */
export function explainResourceLimits(
  tier: ModelTier,
  agentOverrides?: ResourceTierOverrides,
  agentTimeoutMs?: number,
): ExplainedResourceLimits {
  const defaults = RESOURCE_TIER_DEFAULTS[tier];
  const overrides = agentOverrides?.[tier];
  const explicitTimeoutMs =
    typeof agentTimeoutMs === "number" &&
    Number.isFinite(agentTimeoutMs) &&
    agentTimeoutMs > 0 &&
    agentTimeoutMs !== AGENT_DEFINITION_DEFAULTS.timeoutMs
      ? agentTimeoutMs
      : undefined;
  const timeoutSource: ResourceLimitSource = isSet(overrides?.timeoutMs)
    ? "resourceTiers"
    : explicitTimeoutMs !== undefined
      ? "top-level"
      : "tier-default";
  return {
    tier,
    timeoutMs: overrides?.timeoutMs ?? explicitTimeoutMs ?? defaults.timeoutMs,
    maxTurns: overrides?.maxTurns ?? defaults.maxTurns,
    budgetUsd: overrides?.budgetUsd ?? defaults.budgetUsd,
    sources: {
      timeoutMs: timeoutSource,
      maxTurns: isSet(overrides?.maxTurns) ? "resourceTiers" : "tier-default",
      budgetUsd: isSet(overrides?.budgetUsd) ? "resourceTiers" : "tier-default",
    },
  };
}

/** KPR-433: human label for a source — `resourceTiers.opus` | `top-level` | `tier default`. Shared by agent_get and the doctor. */
export function describeLimitSource(source: ResourceLimitSource, tier: ModelTier): string {
  return source === "resourceTiers" ? `resourceTiers.${tier}` : source === "top-level" ? "top-level" : "tier default";
}

export interface InertTopLevelField {
  field: keyof ResourceLimits;
  value: number;
  /** Rendered form, e.g. `budgetUsd=$40`, `maxTurns=80`, `timeoutMs=90000`. */
  label: string;
}

/**
 * KPR-433 D3/D5: the agent-definition top-level fields the Claude/router-on
 * path does NOT deliver. budgetUsd/maxTurns are inert whenever they differ
 * from the effective value (materialized 10 / 200 included — KPR-422 ruled
 * them indistinguishable from intent; deliberately not special-cased).
 * timeoutMs is listed only when it is neither the 300_000 sentinel nor the
 * effective value (an override or garbage displaced it). Order:
 * budgetUsd, maxTurns, timeoutMs. Non-numbers (null unset, strings) are never listed.
 */
export function inertTopLevelFields(
  topLevel: { timeoutMs?: unknown; maxTurns?: unknown; budgetUsd?: unknown },
  effective: ResourceLimits,
): InertTopLevelField[] {
  const out: InertTopLevelField[] = [];
  if (typeof topLevel.budgetUsd === "number" && topLevel.budgetUsd !== effective.budgetUsd) {
    out.push({ field: "budgetUsd", value: topLevel.budgetUsd, label: `budgetUsd=$${topLevel.budgetUsd}` });
  }
  if (typeof topLevel.maxTurns === "number" && topLevel.maxTurns !== effective.maxTurns) {
    out.push({ field: "maxTurns", value: topLevel.maxTurns, label: `maxTurns=${topLevel.maxTurns}` });
  }
  if (
    typeof topLevel.timeoutMs === "number" &&
    topLevel.timeoutMs !== AGENT_DEFINITION_DEFAULTS.timeoutMs &&
    topLevel.timeoutMs !== effective.timeoutMs
  ) {
    out.push({ field: "timeoutMs", value: topLevel.timeoutMs, label: `timeoutMs=${topLevel.timeoutMs}` });
  }
  return out;
}

/**
 * Infer tier from a model ID string. KPR-338: exported — prepareSpawn derives
 * the agent's STATIC tier for resource limits and audit (tier is a per-agent
 * fact now, never a per-turn decision). Claude-id substring heuristic —
 * meaningless on provider-prefixed pilot ids; callers gate on the
 * claude-static route.
 */
export function modelToTier(model: string): ModelTier {
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}

