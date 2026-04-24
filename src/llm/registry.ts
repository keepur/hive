import type {
  GenerateTextRequest,
  GenerateTextResult,
  LLMModelConfig,
  LLMProvider,
  LLMProviderConfig,
  LLMRegistryConfig,
  ResolvedLLMModel,
} from "./types.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { GeminiProvider } from "./providers/gemini-provider.js";
import { OpenAICompatibleProvider, OpenAIProvider } from "./providers/openai-provider.js";

export class LLMRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  constructor(private readonly registryConfig: LLMRegistryConfig) {
    for (const [id, providerConfig] of Object.entries(registryConfig.providers)) {
      if (providerConfig.type === "openai-compatible") {
        if (!providerConfig.baseUrl) continue;
      } else if (!providerConfig.apiKey) {
        continue;
      }
      this.providers.set(id, createProvider(id, providerConfig));
    }
  }

  resolveModel(alias: string): ResolvedLLMModel {
    const model = this.registryConfig.models[alias];
    if (!model) {
      throw new Error(`Unknown LLM model alias: ${alias}`);
    }
    const provider = this.providers.get(model.provider);
    if (!provider) {
      throw new Error(`LLM provider '${model.provider}' is not configured for model alias '${alias}'`);
    }
    return { alias, provider, model };
  }

  resolveTask(task: string): ResolvedLLMModel {
    const alias = this.registryConfig.tasks[task];
    if (!alias) {
      throw new Error(`Unknown LLM task alias: ${task}`);
    }
    return this.resolveModel(alias);
  }

  async generateForTask(task: string, request: Omit<GenerateTextRequest, "model">): Promise<GenerateTextResult> {
    const resolved = this.resolveTask(task);
    return resolved.provider.generateText({
      ...request,
      model: resolved.model.model,
      maxOutputTokens: request.maxOutputTokens ?? resolved.model.maxOutputTokens,
    });
  }

  async generateWithModel(alias: string, request: Omit<GenerateTextRequest, "model">): Promise<GenerateTextResult> {
    const resolved = this.resolveModel(alias);
    return resolved.provider.generateText({
      ...request,
      model: resolved.model.model,
      maxOutputTokens: request.maxOutputTokens ?? resolved.model.maxOutputTokens,
    });
  }

  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  getModelConfig(alias: string): LLMModelConfig | undefined {
    return this.registryConfig.models[alias];
  }
}

function createProvider(id: string, config: LLMProviderConfig): LLMProvider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(id, config);
    case "openai":
      return new OpenAIProvider(id, config);
    case "gemini":
      return new GeminiProvider(id, config);
    case "openai-compatible":
      return new OpenAICompatibleProvider(id, config);
  }
}
