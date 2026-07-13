import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import { LLM_CATALOG, catalogModel, estimateCostUsdFromPricing } from "./catalog.js";
import { LLMCapabilityError, LLMProviderUnavailableError } from "./errors.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { GeminiProvider } from "./providers/gemini-provider.js";
import type {
  CatalogModel,
  LLMCapability,
  LLMPricing,
  LLMProvider,
  LLMProviderId,
  LLMResult,
  LLMTask,
  LLMTaskRequest,
  LLMUsage,
} from "./types.js";

const log = createLogger("llm-registry");

/** The memory task is catalog-pinned — no env override exists today; none added (spec §3.1). */
const MEMORY_MODEL_ID = "claude-haiku-4-5-20251001";

interface TaskBinding {
  provider: LLMProviderId;
  /** Resolved per call so today's env overrides keep steering (spec §3.1). */
  modelId(): string;
  requiredCapability?: LLMCapability;
}

/**
 * Task bindings are code constants (spec ⚠3 — no yaml/env alias surface).
 * The classifier-grade entry honors config.modelRouter.model (MODEL_ROUTER_MODEL)
 * for BOTH classifiers — preserving today's coupling (the meeting classifier
 * borrows the router's model). The vision entry honors config.gemini.visionModel
 * (GEMINI_VISION_MODEL). The memory task is catalog-pinned haiku.
 */
const TASKS: Record<LLMTask, TaskBinding> = {
  routerClassifier: { provider: "anthropic", modelId: () => config.modelRouter.model },
  meetingClassifier: { provider: "anthropic", modelId: () => config.modelRouter.model },
  memory: { provider: "anthropic", modelId: () => MEMORY_MODEL_ID },
  vision: { provider: "gemini", modelId: () => config.gemini.visionModel, requiredCapability: "vision" },
};

export class LLMRegistry {
  private readonly providers = new Map<LLMProviderId, LLMProvider>();
  private readonly warnedOffCatalog = new Set<string>();
  private readonly erroredCapability = new Set<LLMTask>();

  /** Providers are constructed ONLY for keys that resolve (PR #194's gating rule, kept). */
  constructor(keys: { anthropicApiKey: string; geminiApiKey: string }) {
    if (keys.anthropicApiKey) this.providers.set("anthropic", new AnthropicProvider(keys.anthropicApiKey));
    if (keys.geminiApiKey) this.providers.set("gemini", new GeminiProvider(keys.geminiApiKey));
    // Boot visibility (spec §3.6): mirror of the hive doctor line. Steady
    // state, log once at construction — never per call.
    log.info("LLM registry constructed", {
      anthropic: this.providers.has("anthropic"),
      gemini: this.providers.has("gemini"),
      catalogModels: LLM_CATALOG.length,
    });
    if (!this.providers.has("anthropic")) {
      log.info(
        "LLM sidecar: anthropic unavailable (no ANTHROPIC_API_KEY) — meeting classifier degrades to all-roster, memory dream LLM phases skip (router: heuristics-only, no per-turn effort hints — KPR-338)",
      );
    }
    if (!this.providers.has("gemini")) {
      log.info("LLM sidecar: gemini unavailable (no GEMINI_API_KEY) — image description off");
    }
  }

  hasProvider(id: LLMProviderId): boolean {
    return this.providers.has(id);
  }

  /**
   * Resolve task → catalog model → provider, validate capabilities, fire the
   * call, and compute costUsd from usage × catalog pricing (spec §3.1).
   * Throws: LLMProviderUnavailableError (no key), LLMCapabilityError
   * (misbound task), or the provider's transport error — callers own fallback.
   */
  async generateForTask(task: LLMTask, request: LLMTaskRequest): Promise<LLMResult> {
    const binding = TASKS[task];
    const provider = this.providers.get(binding.provider);
    if (!provider) throw new LLMProviderUnavailableError(binding.provider, task);

    const modelId = binding.modelId();
    const model = catalogModel(modelId);
    if (!model) {
      // Off-catalog override (e.g. MODEL_ROUTER_MODEL set to an unknown id):
      // the call proceeds — observability degrades, behavior doesn't. One
      // warn per model id per process. Capability checks are skipped (we
      // can't know); an incapable model 400s → per-site fallback (spec §7).
      if (!this.warnedOffCatalog.has(modelId)) {
        this.warnedOffCatalog.add(modelId);
        log.warn("LLM model id not in catalog — costUsd will be undefined (cost telemetry degraded)", {
          task,
          model: modelId,
        });
      }
    } else {
      this.validateCapabilities(task, binding, model, request);
    }

    const result = await provider.generate({ ...request, model: modelId });
    const costUsd = this.computeCostUsd(modelId, result.usage);
    return costUsd !== undefined ? { ...result, costUsd } : result;
  }

  /**
   * Pre-call worst-case estimate for the task's bound model (spec §3.4's
   * memory gate). undefined when pricing is unknown — an undefined estimate
   * never gates (moot for the catalog-pinned memory task).
   */
  estimateCostUsd(task: LLMTask, request: LLMTaskRequest): number | undefined {
    const pricing = this.pricingFor(TASKS[task].modelId());
    return pricing ? estimateCostUsdFromPricing(pricing, request) : undefined;
  }

  /** Metadata accessor for KPR-312's hand-off (spec §3.2 item 1 / ⚠4). */
  pricingFor(modelId: string): LLMPricing | undefined {
    return catalogModel(modelId)?.pricing;
  }

  /** Catalog-driven effort capability (spec §3.2 item 2). Unknown id ⇒ false —
   *  never emit a param that might 400 (conservative). */
  supportsEffort(modelId: string): boolean {
    return catalogModel(modelId)?.capabilities.includes("effort") ?? false;
  }

  private validateCapabilities(
    task: LLMTask,
    binding: TaskBinding,
    model: CatalogModel,
    request: LLMTaskRequest,
  ): void {
    const missing =
      binding.requiredCapability && !model.capabilities.includes(binding.requiredCapability)
        ? binding.requiredCapability
        : request.jsonSchema && !model.capabilities.some((c) => c === "structured-outputs" || c === "json")
          ? ("structured-outputs" as const)
          : undefined;
    if (!missing) return;
    // Configuration error surfaced once per task in logs (spec §3.5: "a
    // boot-time configuration error surfaced in logs, not a per-image 400").
    if (!this.erroredCapability.has(task)) {
      this.erroredCapability.add(task);
      log.error("LLM task bound to a model lacking a required capability", {
        task,
        model: model.id,
        missing,
      });
    }
    throw new LLMCapabilityError(task, model.id, missing);
  }

  private computeCostUsd(modelId: string, usage: LLMUsage | undefined): number | undefined {
    const pricing = catalogModel(modelId)?.pricing;
    if (!pricing || usage?.inputTokens === undefined || usage.outputTokens === undefined) {
      return undefined;
    }
    return (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
  }
}

// ── Singleton (PR #194's accessor shape; reset seam per archetypes/registry.ts precedent) ──
let registry: LLMRegistry | null = null;

export function getLLMRegistry(): LLMRegistry {
  return (registry ??= new LLMRegistry({
    anthropicApiKey: config.anthropic.apiKey,
    geminiApiKey: config.gemini.apiKey,
  }));
}

/** Test-only seam. */
export function __resetLLMRegistryForTests(): void {
  registry = null;
}
