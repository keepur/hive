import type { GenerateTextRequest, GenerateTextResult, LLMProvider, LLMProviderConfig } from "../types.js";
import { normalizeBaseUrl, parseJsonResponse, requireApiKey, withTimeout } from "../provider-utils.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export class GeminiProvider implements LLMProvider {
  readonly type = "gemini" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    readonly id: string,
    config: LLMProviderConfig,
  ) {
    this.apiKey = requireApiKey(id, config.apiKey);
    this.baseUrl = normalizeBaseUrl(config.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = Date.now();
    const parts: Array<Record<string, unknown>> = [{ text: request.prompt }];
    for (const image of request.images ?? []) {
      parts.unshift({
        inline_data: {
          mime_type: image.mimeType,
          data: image.dataBase64,
        },
      });
    }

    const response = await fetch(
      `${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: withTimeout(request.timeoutMs),
        body: JSON.stringify({
          ...(request.systemPrompt ? { system_instruction: { parts: [{ text: request.systemPrompt }] } } : {}),
          contents: [{ role: "user", parts }],
          generationConfig: {
            ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
    );

    const body = await parseJsonResponse<GeminiResponse>(response, this.id);
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";

    return {
      text,
      model: request.model,
      provider: this.id,
      durationMs: Date.now() - started,
      usage: body.usageMetadata
        ? {
            inputTokens: body.usageMetadata.promptTokenCount,
            outputTokens: body.usageMetadata.candidatesTokenCount,
            totalTokens: body.usageMetadata.totalTokenCount,
          }
        : undefined,
      raw: body,
    };
  }
}
