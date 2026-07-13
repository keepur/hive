/**
 * KPR-314: sidecar LLM registry types (spec §3.1). Salvaged from PR #194's
 * src/llm/types.ts, trimmed to the two shipped providers and extended with
 * pricing/capabilities (the PR typed costUsd? but never populated it — the
 * registry now computes it), parsed/jsonSchema (structured outputs), and
 * stopReason (needed so the router's KPR-312 refusal/max_tokens fallback
 * conditions survive the transport swap byte-for-byte).
 *
 * NON-AGENTIC ONLY: these types serve the four sidecar call sites (router
 * classifier, meeting classifier, memory lifecycle, image description).
 * Agent turns route through provider adapters — never through this module.
 */

export type LLMProviderId = "anthropic" | "gemini"; // union grows when a site needs it

export type LLMCapability = "json" | "structured-outputs" | "vision" | "effort";

/** USD per million tokens. */
export interface LLMPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface CatalogModel {
  id: string; // e.g. "claude-haiku-4-5-20251001", "gemini-2.5-flash"
  provider: LLMProviderId;
  capabilities: LLMCapability[];
  /** Absent ⇒ cost unknown (never blocks the call — costUsd stays undefined). */
  pricing?: LLMPricing;
}

export interface LLMImageInput {
  mimeType: string;
  dataBase64: string;
}

export interface LLMRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Structured output; the provider maps it to its native mechanism. */
  jsonSchema?: object;
  images?: LLMImageInput[];
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMResult {
  text: string;
  /** Set when jsonSchema was honored natively (anthropic parsed_output). */
  parsed?: unknown;
  model: string;
  provider: LLMProviderId;
  durationMs: number;
  /** Provider-reported stop/finish reason, normalized as an opaque string
   *  (anthropic stop_reason; gemini finishReason). Callers that need 312's
   *  refusal/max_tokens fallback semantics read it; others ignore it. */
  stopReason?: string;
  usage?: LLMUsage;
  /** Computed by the REGISTRY from usage × catalog pricing — never by the
   *  provider (PR #194's defect: typed but never populated). */
  costUsd?: number;
}

export interface LLMProvider {
  readonly id: LLMProviderId;
  /** Throws on transport/HTTP error — callers own fallback (spec §3.1). */
  generate(request: LLMRequest): Promise<LLMResult>;
}

/** The four audited call sites — task bindings are code constants (spec ⚠3). */
export type LLMTask = "routerClassifier" | "meetingClassifier" | "memory" | "vision";

/** What call sites pass to generateForTask — the registry fills the model. */
export type LLMTaskRequest = Omit<LLMRequest, "model">;
