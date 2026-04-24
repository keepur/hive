import { config } from "../config.js";
import { LLMRegistry } from "./registry.js";

let registry: LLMRegistry | undefined;

export function getLLMRegistry(): LLMRegistry {
  registry ??= new LLMRegistry(config.llm);
  return registry;
}

export function resetLLMRegistryForTests(): void {
  registry = undefined;
}

export type {
  GenerateTextRequest,
  GenerateTextResult,
  LLMProvider,
  LLMProviderConfig,
  LLMRegistryConfig,
} from "./types.js";
export { LLMRegistry } from "./registry.js";
export { extractJsonArrayText, extractJsonObjectText } from "./provider-utils.js";
