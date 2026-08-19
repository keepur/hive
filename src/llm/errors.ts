import type { LLMCapability, LLMProviderId, LLMTask } from "./types.js";

/** Typed "provider unavailable" error — call sites catch into their per-site fallbacks. */
export class LLMProviderUnavailableError extends Error {
  constructor(
    readonly providerId: LLMProviderId,
    readonly task: LLMTask,
  ) {
    super(`LLM provider '${providerId}' unavailable (no API key resolved) — task '${task}' cannot run`);
    this.name = "LLMProviderUnavailableError";
  }
}

/** Typed capability-mismatch error — a boot-time configuration fault, not a per-call 400. */
export class LLMCapabilityError extends Error {
  constructor(task: LLMTask, modelId: string, capability: LLMCapability) {
    super(`LLM task '${task}' is bound to model '${modelId}' which lacks required capability '${capability}'`);
    this.name = "LLMCapabilityError";
  }
}
