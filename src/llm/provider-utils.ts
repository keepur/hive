import type { GenerateTextRequest } from "./types.js";

export function requireApiKey(providerId: string, apiKey: string | undefined): string {
  if (!apiKey) {
    throw new Error(`LLM provider '${providerId}' is missing an API key`);
  }
  return apiKey;
}

export function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string {
  return (baseUrl || fallback).replace(/\/+$/, "");
}

export function withTimeout(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

export async function parseJsonResponse<T>(response: Response, providerId: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM provider '${providerId}' returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

export function textPromptParts(request: GenerateTextRequest): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }];
  for (const image of request.images ?? []) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
    });
  }
  return parts;
}

export function extractJsonObjectText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

export function extractJsonArrayText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;

  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return null;
}
