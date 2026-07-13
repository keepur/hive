import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import { getLLMRegistry } from "../llm/registry.js";
import type { AgentProviderId, ReasoningEffort } from "./provider-adapters/types.js";

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

/** Ordered from least to most capable */
const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

/** Map tier names to actual model IDs */
const TIER_MODELS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

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

/** Infer tier from a model ID string */
function modelToTier(model: string): ModelTier {
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}

export interface ModelRouterResult {
  tier: ModelTier;
  model: string;
  costUsd: number;
  durationMs: number;
  resourceLimits: ResourceLimits;
  /** Absent ⇒ inherit the agent's static provider (resolveProviderModel(agent.model)).
   *  Dormant in W3: routeModel never sets it, AND even if set it is inert — a value
   *  matching the static provider is a no-op, a mismatch is clamped to static (spec §2/§5).
   *  Carriage-only until the spec §5 pilot-gate/clamp lift (the same lift that
   *  gates pilot effort delivery). */
  provider?: AgentProviderId;
  /** KPR-312: emitted by the model path only (method: "model"), ∈ {low, medium, high}
   *  (schema-constrained; the subset valid on both ReasoningEffort and the agent
   *  SDK's EffortLevel). Dropped inside routeModel when the post-cap tier is haiku
   *  (claude-haiku-4-5 rejects the effort param). Never merged into the route —
   *  delivered beside it via SpawnShaping.effortOverride → AgentProviderTurnRequest.effort
   *  → SDK Options.effort. Pilot delivery still gated on the 311 spec §5 lift. */
  effort?: ReasoningEffort;
  /** KPR-312: how the decision was made — heuristic short-circuit, model call,
   *  key-less mode, or failure fallback. Observability-only. "no-key"
   *  (unconfigured — steady state, surface once) is deliberately distinct from
   *  "fallback" (API failing — incident to alarm on). */
  method?: "heuristic" | "model" | "no-key" | "fallback";
}

/**
 * KPR-312: classifier v2 system prompt. Changes vs v1: adds the effort rubric,
 * drops the "Respond with ONLY a JSON object" plea (structured outputs enforce
 * the shape), drops the dead scheduled/cron rule (prepareSpawn gates the router
 * with sender !== "system"; every scheduler/cron/callback producer sets it).
 * No prompt-cache marker: ~300 tokens is far below haiku-4-5's 4096-token
 * cacheable minimum.
 */
const ROUTER_PROMPT_V2 = `You are a model router. Classify the complexity of a user message: decide which AI model tier should handle it, and how much reasoning effort the turn deserves.

Tiers:
- **haiku**: Greetings, simple factual questions, acknowledgments, status checks, yes/no answers, brief lookups, routine updates. Fast and cheap.
- **sonnet**: Multi-step tasks, drafting emails/messages, summarizing data, moderate analysis, tool-heavy workflows, most day-to-day business work. Balanced.
- **opus**: Complex reasoning, strategic planning, nuanced judgment calls, multi-faceted analysis, creative problem-solving, anything where getting it wrong has real consequences. Maximum intelligence.

Effort (how hard the chosen tier should work on this turn):
- **low**: Routine lookups, short answers, single simple actions within the chosen tier.
- **medium**: Typical multi-step work — most tasks land here.
- **high**: Consequential judgment, intricate multi-part work, high cost of getting it wrong.

Rules:
- When in doubt, pick sonnet — it handles most things well.
- Short messages are NOT automatically haiku — "fire the sales team" is short but definitely opus.
- Look at the TASK complexity, not the message length.`;

/** Strict output schema — KPR-314: passed raw to the registry's anthropic
 *  provider, which wraps it in the SDK's jsonSchemaOutputFormat (GA,
 *  server-compiled + cached — 312's exact mechanism, one layer down). */
const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: ["haiku", "sonnet", "opus"] },
    effort: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["tier", "effort"],
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

function heuristicHaiku(resourceTierOverrides?: ResourceTierOverrides): ModelRouterResult {
  return {
    tier: "haiku",
    model: TIER_MODELS.haiku,
    costUsd: 0,
    durationMs: 0,
    resourceLimits: resolveResourceLimits("haiku", resourceTierOverrides),
    method: "heuristic",
  };
}

/**
 * Failure fallback — same tier semantics as v1's error path (sonnet capped at
 * ceiling), minus up to 8 seconds of subprocess. Never emits effort (a $0
 * decision shouldn't tune a lever it didn't reason about).
 */
function sonnetFallback(
  ceilingTier: ModelTier,
  resourceTierOverrides?: ResourceTierOverrides,
): ModelRouterResult {
  const fallbackTier: ModelTier = TIER_RANK[ceilingTier] >= TIER_RANK.sonnet ? "sonnet" : ceilingTier;
  return {
    tier: fallbackTier,
    model: TIER_MODELS[fallbackTier],
    costUsd: 0,
    durationMs: 0,
    resourceLimits: resolveResourceLimits(fallbackTier, resourceTierOverrides),
    method: "fallback",
  };
}

/**
 * Classify a message and return the recommended model tier (+ per-turn effort).
 * The result is capped at `ceilingModel` — the agent's configured maximum.
 *
 * KPR-312: deterministic heuristics (H1–H3, first match wins) short-circuit
 * before any client/API work; the model path is one direct structured-outputs
 * call (client.messages.parse) — the per-turn Claude Code CLI subprocess is
 * gone. Key-less instances run heuristics-only (`method: "no-key"`).
 *
 * NOTE (spec §7): this call deliberately does NOT route through the provider
 * adapters — never breaker-recorded, never permit-gated. A classifier fault
 * must not count toward turn-provider health; its own timeout + fallback
 * bounds damage to one cheap fallback per turn.
 *
 * @param opts.hasFiles — file-bearing messages must not be mis-short-circuited
 *   by the empty-text rule (H3): the router only sees `item.text`, while file
 *   content is appended into the assembled prompt downstream.
 */
export async function routeModel(
  text: string,
  ceilingModel: string,
  resourceTierOverrides?: ResourceTierOverrides,
  opts?: { hasFiles?: boolean },
): Promise<ModelRouterResult> {
  const ceilingTier = modelToTier(ceilingModel);

  // H1 — ceiling is already the cheapest tier: skip everything (v1 behavior, kept verbatim).
  if (ceilingTier === "haiku") {
    return heuristicHaiku(resourceTierOverrides);
  }

  const trimmed = text.trim();

  // H2 — exact-match ack/greeting allowlist.
  if (ACK_ALLOWLIST.has(trimmed.toLowerCase())) {
    return heuristicHaiku(resourceTierOverrides);
  }

  // H3 — empty text and no files: nothing to classify. File-bearing items skip
  // this — files mean real work the classifier can't see.
  if (trimmed.length === 0 && !opts?.hasFiles) {
    return heuristicHaiku(resourceTierOverrides);
  }

  const registry = getLLMRegistry();
  if (!registry.hasProvider("anthropic")) {
    // No-key mode (spec §3.3): keep the agent's default model with its default
    // tier's resource limits — conservative, never a wrong upshift. Announce
    // once per boot; `hive doctor` carries the standing line.
    if (!noKeyModeAnnounced) {
      noKeyModeAnnounced = true;
      log.info(
        "Model router running heuristics-only (no ANTHROPIC_API_KEY) — non-obvious turns keep the agent default model",
      );
    }
    const tier = modelToTier(ceilingModel);
    return {
      tier,
      model: ceilingModel,
      costUsd: 0,
      durationMs: 0,
      resourceLimits: resolveResourceLimits(tier, resourceTierOverrides),
      method: "no-key",
    };
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
      systemPrompt: ROUTER_PROMPT_V2,
      maxOutputTokens: 100,
      jsonSchema: ROUTER_SCHEMA,
      timeoutMs: config.modelRouter.timeoutMs, // per-request wall clock (was 312's client-level timeout)
    });

    // KPR-312's fallback conditions, byte-preserved across the transport
    // swap (LLMResult.stopReason exists for exactly this).
    const parsed = result.parsed as { tier?: string; effort?: string } | undefined;
    if (
      result.stopReason === "refusal" ||
      result.stopReason === "max_tokens" ||
      !parsed ||
      TIER_RANK[parsed.tier as ModelTier] === undefined
    ) {
      log.warn("Model router returned unusable output, defaulting to sonnet", {
        stopReason: result.stopReason,
        hasParsedOutput: Boolean(parsed),
      });
      return sonnetFallback(ceilingTier, resourceTierOverrides);
    }

    const requested = parsed.tier as ModelTier;
    const effort: ReasoningEffort | undefined =
      parsed.effort === "low" || parsed.effort === "medium" || parsed.effort === "high"
        ? parsed.effort
        : undefined;
    // KPR-314: cost computed by the registry (usage × catalog pricing — the
    // 312 TODO hand-off). Off-catalog MODEL_ROUTER_MODEL override ⇒ undefined
    // ⇒ 0: cost telemetry degrades, routing doesn't (registry warns once).
    const costUsd = result.costUsd ?? 0;
    const durationMs = result.durationMs;

    // Cap at ceiling (kept from v1).
    let finalTier = requested;
    if (TIER_RANK[requested] > TIER_RANK[ceilingTier]) {
      finalTier = ceilingTier;
      log.debug("Model router capped by ceiling", { requested, ceiling: ceilingTier });
    }

    // Log-redaction convention: no message text / input previews.
    log.info("Model router decision", {
      tier: finalTier,
      requested,
      effort,
      ceiling: ceilingTier,
      costUsd,
      durationMs,
    });

    return {
      tier: finalTier,
      model: TIER_MODELS[finalTier],
      costUsd,
      durationMs,
      resourceLimits: resolveResourceLimits(finalTier, resourceTierOverrides),
      method: "model",
      // KPR-312 §3.2 rule 2, catalog-driven since KPR-314: drop effort when
      // the FINAL (post-cap) model doesn't support the param (haiku today —
      // same behavior, now data instead of a hardcoded tier check).
      ...(effort === undefined || !registry.supportsEffort(TIER_MODELS[finalTier])
        ? {}
        : { effort }),
    };
  } catch (err) {
    // maxRetries: 0 — any timeout / 429 / 5xx / 404 (misconfigured
    // MODEL_ROUTER_MODEL) lands here. Operator-visible noise by design.
    log.warn("Model router call failed, defaulting to sonnet", { error: String(err) });
    return sonnetFallback(ceilingTier, resourceTierOverrides);
  }
}
