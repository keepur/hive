import type { CatalogModel, LLMPricing, LLMTaskRequest } from "./types.js";

/**
 * KPR-314: the single owner of sidecar-LLM model metadata (spec §3.1) —
 * the catalog KPR-312 punted (its model-router.ts TODO(KPR-314) pricing
 * constants land here). Constants ride engine releases — same maintenance
 * class as TIER_MODELS; no runtime pricing fetch (spec §7).
 *
 * Pricing is present only where a call site consumes computed cost:
 * haiku feeds router/meeting-classifier cost telemetry and the memory
 * AutoDreamBudget (the memory task is catalog-pinned to haiku, so budget
 * accounting can never silently zero out — spec §7 pricing-drift row).
 * Sonnet/opus/gemini entries exist for capability lookups (supportsEffort,
 * vision validation); their pricing is absent ⇒ costUsd undefined, which
 * never blocks a call.
 */
export const LLM_CATALOG: readonly CatalogModel[] = [
  {
    // Classifier-grade + memory-task model. Pricing moved verbatim from
    // KPR-312's interim ROUTER_INPUT_USD_PER_MTOK=1 / ROUTER_OUTPUT_USD_PER_MTOK=5.
    // No "effort": claude-haiku-4-5 rejects the param (312 §3.2 rule 2, now data).
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    capabilities: ["json", "structured-outputs"],
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    capabilities: ["json", "structured-outputs", "vision", "effort"],
  },
  {
    id: "claude-opus-4-7",
    provider: "anthropic",
    capabilities: ["json", "structured-outputs", "vision", "effort"],
  },
  {
    // Default vision-task model (config.gemini.visionModel default).
    id: "gemini-2.5-flash",
    provider: "gemini",
    capabilities: ["json", "vision"],
  },
];

export function catalogModel(id: string): CatalogModel | undefined {
  return LLM_CATALOG.find((m) => m.id === id);
}

/**
 * Pre-call worst-case cost estimate (spec §3.4): chars/4 input estimate on
 * the ACTUAL request as sent (prompt + systemPrompt) + full maxOutputTokens
 * allowance, × catalog pricing. Deliberately conservative in two known ways
 * (chars/4 over-counts English ~5-10%; real outputs run far under the
 * allowance) — the memory gate's GATE_TOLERANCE (×1.3) absorbs exactly
 * those biases. A heuristic bound, not a hard cap (spec ⚠5(c): chars/4
 * under-counts 2-4× on CJK/token-dense text).
 *
 * Pure function — exported so tests (and the memory suite's realistic mock)
 * pin gate clearance against the real math without importing config-bound
 * registry code.
 */
export function estimateCostUsdFromPricing(pricing: LLMPricing, request: LLMTaskRequest): number {
  const inputTokens = Math.ceil((request.prompt.length + (request.systemPrompt?.length ?? 0)) / 4);
  const outputTokens = request.maxOutputTokens ?? 0;
  return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
}
