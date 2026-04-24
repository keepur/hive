import type { GenerateTextRequest, GenerateTextResult, LLMProvider, LLMProviderConfig } from "../types.js";
import { normalizeBaseUrl, parseJsonResponse, requireApiKey, withTimeout } from "../provider-utils.js";

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export class AnthropicProvider implements LLMProvider {
  readonly type = "anthropic" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    readonly id: string,
    config: LLMProviderConfig,
  ) {
    this.apiKey = requireApiKey(id, config.apiKey);
    this.baseUrl = normalizeBaseUrl(config.baseUrl, "https://api.anthropic.com/v1");
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = Date.now();
    const content: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }];
    for (const image of request.images ?? []) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: image.mimeType,
          data: image.dataBase64,
        },
      });
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: withTimeout(request.timeoutMs),
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens ?? 1024,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        messages: [{ role: "user", content }],
      }),
    });

    const body = await parseJsonResponse<AnthropicResponse>(response, this.id);
    const text = (body.content ?? [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("");

    return {
      text,
      model: request.model,
      provider: this.id,
      durationMs: Date.now() - started,
      usage: body.usage
        ? {
            inputTokens: body.usage.input_tokens,
            outputTokens: body.usage.output_tokens,
            cacheReadTokens: body.usage.cache_read_input_tokens,
            cacheWriteTokens: body.usage.cache_creation_input_tokens,
          }
        : undefined,
      raw: body,
    };
  }
}
