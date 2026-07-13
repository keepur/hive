import type { LLMProvider, LLMRequest, LLMResult } from "../types.js";
import { parseJsonResponse, requireApiKey, withTimeout } from "../provider-utils.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * KPR-314: Gemini REST transport (generateContent + inline base64) —
 * salvaged from PR #194 / the previous file-processor.ts inline fetch.
 * Pilot-grade (spec D3): enough for the vision task, no more. jsonSchema
 * requests degrade to responseMimeType json (no schema enforcement) — no
 * shipped call site sends a schema to gemini.
 */
export class GeminiProvider implements LLMProvider {
  readonly id = "gemini" as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = requireApiKey("gemini", apiKey);
  }

  async generate(request: LLMRequest): Promise<LLMResult> {
    const started = Date.now();
    const parts: Array<Record<string, unknown>> = [{ text: request.prompt }];
    for (const image of request.images ?? []) {
      parts.unshift({
        inline_data: { mime_type: image.mimeType, data: image.dataBase64 },
      });
    }

    const response = await fetch(
      `${BASE_URL}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: withTimeout(request.timeoutMs),
        body: JSON.stringify({
          ...(request.systemPrompt
            ? { system_instruction: { parts: [{ text: request.systemPrompt }] } }
            : {}),
          contents: [{ role: "user", parts }],
          generationConfig: {
            ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.jsonSchema ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
    );

    const body = await parseJsonResponse<GeminiResponse>(response, this.id);
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";

    return {
      text,
      model: request.model,
      provider: this.id,
      durationMs: Date.now() - started,
      stopReason: candidate?.finishReason,
      usage: body.usageMetadata
        ? {
            inputTokens: body.usageMetadata.promptTokenCount,
            outputTokens: body.usageMetadata.candidatesTokenCount,
          }
        : undefined,
    };
  }
}
