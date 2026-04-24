import type { GenerateTextRequest, GenerateTextResult, LLMProvider, LLMProviderConfig } from "../types.js";
import { normalizeBaseUrl, parseJsonResponse, requireApiKey, textPromptParts, withTimeout } from "../provider-utils.js";

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAIProvider implements LLMProvider {
  readonly type: "openai" | "openai-compatible" = "openai";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    readonly id: string,
    config: LLMProviderConfig,
    requireKey = true,
  ) {
    this.apiKey = requireKey ? requireApiKey(id, config.apiKey) : (config.apiKey ?? "");
    this.baseUrl = normalizeBaseUrl(config.baseUrl, "https://api.openai.com/v1");
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = Date.now();
    const messages: Array<Record<string, unknown>> = [];
    if (request.systemPrompt) messages.push({ role: "system", content: request.systemPrompt });
    messages.push({
      role: "user",
      content: request.images?.length ? textPromptParts(request) : request.prompt,
    });

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      signal: withTimeout(request.timeoutMs),
      body: JSON.stringify({
        model: request.model,
        messages,
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    const body = await parseJsonResponse<OpenAIResponse>(response, this.id);
    const text = body.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model: request.model,
      provider: this.id,
      durationMs: Date.now() - started,
      usage: body.usage
        ? {
            inputTokens: body.usage.prompt_tokens,
            outputTokens: body.usage.completion_tokens,
            totalTokens: body.usage.total_tokens,
          }
        : undefined,
      raw: body,
    };
  }
}

export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly type = "openai-compatible" as const;

  constructor(id: string, config: LLMProviderConfig) {
    super(id, config, false);
  }
}
