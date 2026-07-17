import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import { getLLMRegistry } from "../llm/registry.js";
import type { ReasoningEffort } from "./provider-adapters/types.js";

const log = createLogger("model-router");

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
 */
export function resolveResourceLimits(
  tier: ModelTier,
  agentOverrides?: ResourceTierOverrides,
): ResourceLimits {
  const defaults = RESOURCE_TIER_DEFAULTS[tier];
  const overrides = agentOverrides?.[tier];
  if (!overrides) return { ...defaults };
  return {
    timeoutMs: overrides.timeoutMs ?? defaults.timeoutMs,
    maxTurns: overrides.maxTurns ?? defaults.maxTurns,
    budgetUsd: overrides.budgetUsd ?? defaults.budgetUsd,
  };
}

/** KPR-312 §3.3: classifier input bound — bounds worst-case cost/latency. */
const MAX_CLASSIFIER_INPUT = 4000;

/**
 * KPR-312 H2: exact-match ack/greeting allowlist (case-insensitive, trimmed).
 * EXACT MATCH ONLY — no substring/length heuristics, so "fire the sales team"
 * can never short-circuit. Membership is a plan-level constant (spec ⚠8).
 */
const ACK_ALLOWLIST: ReadonlySet<string> = new Set([
  "hi", "hello", "hey",
  "thanks", "thank you", "thx",
  "ok", "okay",
  "yes", "no", "yep", "nope",
  "got it", "sounds good", "sure", "will do",
  "👍",
]);

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

/**
 * KPR-338: effort-only result. The router no longer names tiers, models,
 * providers, or resource limits — a turn's model is always agentConfig.model
 * (fixed-tier invariant, kpr-338-spec §1.3); execution bounds derive from the
 * agent's static tier in prepareSpawn. The tier-axis analog of KPR-311's
 * provider clamp (R-311.1): an agent's engine identity is static per turn,
 * changed only by operator action.
 */
export interface ModelRouterResult {
  costUsd: number;
  durationMs: number;
  /** KPR-312 semantics unchanged: emitted by the model path only
   *  (method: "model"), ∈ {low, medium, high} (schema-constrained; the subset
   *  valid on both ReasoningEffort and the SDK's EffortLevel). H2/H3
   *  heuristics emit "low". Delivered beside the route via
   *  SpawnShaping.effortOverride → AgentProviderTurnRequest.effort →
   *  Options.effort — prepareSpawn only routes here when the static model is
   *  effort-capable (KPR-338 skip), so no drop rule is needed in this file. */
  effort?: ReasoningEffort;
  /** KPR-312: how the decision was made — heuristic short-circuit, model
   *  call, key-less mode, or failure fallback. Observability-only. "no-key"
   *  (unconfigured — steady state, surface once) is deliberately distinct
   *  from "fallback" (API failing — incident to alarm on). */
  method?: "heuristic" | "model" | "no-key" | "fallback";
}

/**
 * KPR-338: classifier v3 prompt — the tier rubric is gone (tier is a
 * per-agent fact, not a per-turn decision); only the KPR-312 effort rubric
 * survives. No prompt-cache marker: far below the cacheable minimum.
 */
const ROUTER_PROMPT_V3 = `You are an effort classifier. Decide how much reasoning effort an AI agent should spend on a user message.

Effort levels:
- **low**: Greetings, acknowledgments, routine lookups, status checks, yes/no answers, short factual questions, single simple actions.
- **medium**: Typical multi-step work — drafting emails/messages, summarizing data, moderate analysis, tool-heavy workflows. Most tasks land here.
- **high**: Consequential judgment, strategic planning, intricate multi-part work, nuanced analysis — anything where getting it wrong has real consequences.

Rules:
- When in doubt, pick medium.
- Short messages do NOT automatically mean low effort — "fire the sales team" is short but demands high effort.
- Judge the TASK complexity, not the message length.`;

/** Strict output schema — KPR-314 mechanism unchanged (registry wraps it in
 *  the SDK's jsonSchemaOutputFormat); KPR-338: effort is the only field. */
const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    effort: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["effort"],
  additionalProperties: false,
} as const;

// ── Transport (KPR-314) ────────────────────────────────────────────────
// The classifier call rides the LLM registry's shared anthropic provider —
// one keep-alive client across router + meeting classifier + memory sites.
// No-key mode derives from hasProvider("anthropic") (identical truth
// condition to 312's getClient() null check: key presence).
let noKeyModeAnnounced = false;

/** Test-only seam (renamed from 312's __resetRouterClientForTests — the
 *  router no longer holds a client; the registry has its own reset). */
export function __resetRouterStateForTests(): void {
  noKeyModeAnnounced = false;
}

function heuristicLow(): ModelRouterResult {
  return { costUsd: 0, durationMs: 0, effort: "low", method: "heuristic" };
}

/**
 * Failure/no-reasoning fallback — NO effort key (a $0 decision doesn't tune a
 * lever it didn't reason about — unchanged KPR-312 principle). The pre-338
 * sonnet-fallback *tier* concept is gone: a fallback now simply means "no
 * effort hint this turn".
 */
function classifierFallback(): ModelRouterResult {
  return { costUsd: 0, durationMs: 0, method: "fallback" };
}

/**
 * Classify a message's per-turn reasoning effort (KPR-338: the classifier's
 * only remaining output — tier selection was removed; the turn's model is
 * always the agent's static model, and haiku-static / effort-incapable agents
 * never reach this call at all — prepareSpawn skips them).
 *
 * KPR-312 heuristics H2–H3 (first match wins) short-circuit before any
 * registry work; the model path is one structured-outputs call through the
 * KPR-314 sidecar registry. Key-less instances run heuristics-only
 * (`method: "no-key"`).
 *
 * NOTE (KPR-312 §7): this call deliberately does NOT route through the
 * provider adapters — never breaker-recorded, never permit-gated. A
 * classifier fault must not count toward turn-provider health; its own
 * timeout + fallback bounds damage to one cheap fallback per turn.
 *
 * @param opts.hasFiles — file-bearing messages must not be mis-short-circuited
 *   by the empty-text rule (H3): the router only sees `item.text`, while file
 *   content is appended into the assembled prompt downstream.
 */
export async function routeModel(
  text: string,
  opts?: { hasFiles?: boolean },
): Promise<ModelRouterResult> {
  const trimmed = text.trim();

  // H2 — exact-match ack/greeting allowlist (membership unchanged; any-turn
  // scope decided in kpr-338-spec §1.2(3): a miss now costs an effort hint on
  // the agent's own model, not a model/budget downgrade).
  if (ACK_ALLOWLIST.has(trimmed.toLowerCase())) {
    return heuristicLow();
  }

  // H3 — empty text and no files: nothing to classify. File-bearing items
  // skip this — files mean real work the classifier can't see.
  if (trimmed.length === 0 && !opts?.hasFiles) {
    return heuristicLow();
  }

  const registry = getLLMRegistry();
  if (!registry.hasProvider("anthropic")) {
    // No-key mode (KPR-312 §3.3, truth condition unchanged): heuristics-only.
    // KPR-338: every turn keeps the agent's static model by construction —
    // what no-key mode actually loses now is per-turn effort hints.
    if (!noKeyModeAnnounced) {
      noKeyModeAnnounced = true;
      log.info(
        "Model router running heuristics-only (no ANTHROPIC_API_KEY) — no per-turn effort hints; every turn runs the agent's static model regardless",
      );
    }
    return { costUsd: 0, durationMs: 0, method: "no-key" };
  }

  // Model path — bound the classifier input (same pattern as knowledge-extractor).
  const truncated =
    trimmed.length > MAX_CLASSIFIER_INPUT
      ? trimmed.slice(0, MAX_CLASSIFIER_INPUT) + "\n[...truncated]"
      : trimmed;
  // Empty text + files reaches the model path (H3 skipped) — the API rejects
  // empty text blocks, so classify a placeholder instead.
  const classifierInput = truncated.length > 0 ? truncated : "(attachment-only message, no text)";

  try {
    const result = await registry.generateForTask("routerClassifier", {
      prompt: classifierInput,
      systemPrompt: ROUTER_PROMPT_V3,
      maxOutputTokens: 100,
      jsonSchema: ROUTER_SCHEMA,
      timeoutMs: config.modelRouter.timeoutMs, // per-request wall clock (KPR-314)
    });

    // KPR-312's fallback conditions, translated to the effort-only contract
    // (plan D5): unusable output = refusal/max_tokens stop, missing parsed
    // output, or an out-of-enum effort (near-dead under schema enforcement).
    const parsed = result.parsed as { effort?: string } | undefined;
    const effort: ReasoningEffort | undefined =
      parsed?.effort === "low" || parsed?.effort === "medium" || parsed?.effort === "high"
        ? parsed.effort
        : undefined;
    if (result.stopReason === "refusal" || result.stopReason === "max_tokens" || effort === undefined) {
      log.warn("Model router returned unusable output — no effort hint this turn", {
        stopReason: result.stopReason,
        hasParsedOutput: Boolean(parsed),
      });
      return classifierFallback();
    }

    // KPR-314: cost computed by the registry (usage × catalog pricing).
    // Off-catalog MODEL_ROUTER_MODEL override ⇒ undefined ⇒ 0: cost telemetry
    // degrades, routing doesn't (registry warns once).
    const costUsd = result.costUsd ?? 0;
    // Log-redaction convention: no message text / input previews.
    log.info("Model router decision", { effort, costUsd, durationMs: result.durationMs });
    return { costUsd, durationMs: result.durationMs, effort, method: "model" };
  } catch (err) {
    // maxRetries: 0 — any timeout / 429 / 5xx / 404 (misconfigured
    // MODEL_ROUTER_MODEL) lands here. Operator-visible noise by design.
    log.warn("Model router call failed — no effort hint this turn", { error: String(err) });
    return classifierFallback();
  }
}
