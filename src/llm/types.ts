export type LLMProviderType = "anthropic" | "openai" | "gemini" | "openai-compatible";

export type LLMCapability = "text" | "json" | "vision";

export interface LLMImageInput {
  mimeType: string;
  dataBase64: string;
}

export interface GenerateTextRequest {
  model: string;
  systemPrompt?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: "text" | "json";
  images?: LLMImageInput[];
  timeoutMs?: number;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface GenerateTextResult {
  text: string;
  model: string;
  provider: string;
  durationMs: number;
  usage?: LLMUsage;
  costUsd?: number;
  raw?: unknown;
}

export interface LLMProvider {
  readonly id: string;
  readonly type: LLMProviderType;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
}

export interface LLMProviderConfig {
  type: LLMProviderType;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}

export interface LLMModelConfig {
  provider: string;
  model: string;
  capabilities?: LLMCapability[];
  maxOutputTokens?: number;
}

export interface LLMRegistryConfig {
  providers: Record<string, LLMProviderConfig>;
  models: Record<string, LLMModelConfig>;
  tasks: Record<string, string>;
}

export interface ResolvedLLMModel {
  alias: string;
  provider: LLMProvider;
  model: LLMModelConfig;
}
