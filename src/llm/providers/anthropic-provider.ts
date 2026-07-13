import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import type { LLMProvider, LLMRequest, LLMResult } from "../types.js";
import { requireApiKey } from "../provider-utils.js";

/** Applied when a call site omits maxOutputTokens (the API requires max_tokens). */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * KPR-314: direct Messages API transport for the anthropic sidecar tasks —
 * one shared keep-alive client (the same motivation as KPR-122's in-process
 * MCPs and KPR-312's router client, which this replaces as the shared
 * instance). maxRetries: 0 — callers own retry/fallback semantics (312).
 * Structured output via messages.parse + jsonSchemaOutputFormat (GA — 312's
 * exact mechanism); plain generation via messages.create.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey: requireApiKey("anthropic", apiKey),
      maxRetries: 0,
    });
  }

  async generate(request: LLMRequest): Promise<LLMResult> {
    const started = Date.now();
    const content: Anthropic.ContentBlockParam[] = [
      ...(request.images ?? []).map(
        (img): Anthropic.ImageBlockParam => ({
          type: "image",
          source: {
            type: "base64",
            // Callers pass real image mimetypes; the API rejects others — a
            // caller error surfaced as a thrown 400, per the throw contract.
            media_type: img.mimeType as Anthropic.Base64ImageSource["media_type"],
            data: img.dataBase64,
          },
        }),
      ),
      { type: "text", text: request.prompt },
    ];
    const params = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: [{ role: "user" as const, content }],
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    // Per-request wall clock (TS SDK unit: ms) — replaces 312's client-level timeout.
    const requestOptions = request.timeoutMs ? { timeout: request.timeoutMs } : undefined;

    if (request.jsonSchema) {
      const response = await this.client.messages.parse(
        {
          ...params,
          output_config: {
            format: jsonSchemaOutputFormat(
              request.jsonSchema as Parameters<typeof jsonSchemaOutputFormat>[0],
            ),
          },
        },
        requestOptions,
      );
      return this.toResult(request.model, response, response.parsed_output ?? undefined, started);
    }

    const response = await this.client.messages.create(params, requestOptions);
    return this.toResult(request.model, response, undefined, started);
  }

  private toResult(
    model: string,
    response: Anthropic.Message,
    parsed: unknown,
    started: number,
  ): LLMResult {
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      ...(parsed !== undefined ? { parsed } : {}),
      model,
      provider: this.id,
      durationMs: Date.now() - started,
      stopReason: response.stop_reason ?? undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
