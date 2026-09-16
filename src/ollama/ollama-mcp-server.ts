/**
 * Ollama MCP Server — local-model inference for privacy-sensitive work.
 *
 * In-process via `createSdkMcpServer`, wired in `agent-runner.ts:send()`.
 * Follows the KPR-122 port pattern (see `code-index/code-search-mcp-server.ts`).
 *
 * WHY IN-REPO: the August 2026 version of this server lived as a hand-edited
 * minified bundle in `.hive/pkg/mcp/ollama.min.js`. It was untracked, so a
 * routine `deploy.sh` overwrote `.hive/pkg` and the capability vanished — with
 * ZERO log output, because an unknown *core* server name is dropped silently
 * (the "Delegate server not found" warning only fires for delegate servers).
 * Seven agents were configured for Ollama and had none of it for weeks.
 * This server ships through the normal engine release path. Do not re-bundle.
 *
 * v1 SCOPE (approved by Tony 2026-09-16): `ollama_query` + `ollama_list_models`
 * only. The four RAG tools from the legacy 772-line server (`rag_ingest`,
 * `rag_query`, `rag_list_sources`, `rag_delete_source`) are a separate product
 * surface with their own storage story and are deliberately deferred.
 *
 * No credentials — Ollama is a local daemon on OLLAMA_URL. It is therefore
 * classified in INFRASTRUCTURE_SERVERS (instance-capabilities.ts) rather than
 * carrying a SERVER_CREDENTIAL_CHECKS entry.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createLogger } from "../logging/logger.js";

const log = createLogger("ollama-mcp");

/** Default text model. Pulled locally; see `ollama_list_models` for what's live. */
export const OLLAMA_DEFAULT_MODEL = "qwen2.5:14b";

/**
 * Hard ceiling on a single generation. A wedged local model must not hang the
 * agent turn — the SDK has no per-tool timeout, so we own it here.
 */
export const OLLAMA_REQUEST_TIMEOUT_MS = 120_000;
/** List/tags is metadata only — short leash. */
export const OLLAMA_LIST_TIMEOUT_MS = 10_000;

export interface OllamaToolDeps {
  ollamaUrl?: string;
}

export interface OllamaModelSummary {
  name: string;
  size_gb: string;
  family: string;
  parameters: string;
  quantization: string;
}

/** Strip a `data:image/png;base64,` prefix if the caller pasted a data URL. */
export function stripDataUrlPrefix(image: string): string {
  return image.replace(/^data:image\/\w+;base64,/, "");
}

/** Shape `/api/tags` output into a compact, token-cheap summary. */
export function summarizeModels(data: unknown): OllamaModelSummary[] {
  const models = (data as { models?: unknown[] })?.models ?? [];
  if (!Array.isArray(models)) return [];
  return models.map((raw) => {
    const m = raw as {
      name?: string;
      size?: number;
      details?: { family?: string; parameter_size?: string; quantization_level?: string };
    };
    return {
      name: m.name ?? "unknown",
      size_gb: typeof m.size === "number" ? (m.size / 1e9).toFixed(1) : "unknown",
      family: m.details?.family ?? "unknown",
      parameters: m.details?.parameter_size ?? "unknown",
      quantization: m.details?.quantization_level ?? "unknown",
    };
  });
}

async function ollamaFetch(
  baseUrl: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function ollamaGet(baseUrl: string, path: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`Ollama ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export function buildOllamaTools(deps: OllamaToolDeps = {}) {
  const baseUrl = (deps.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/+$/, "");

  return [
    tool(
      "ollama_query",
      "Run a prompt against a local Ollama model. The prompt and response never leave this machine — use for privacy-sensitive work (personnel, medical, financial, client-identifiable material) that must not be sent to a cloud model.",
      {
        prompt: z.string().min(1).describe("The prompt to send to the model."),
        model: z
          .string()
          .optional()
          .describe(`Model to use. Default: ${OLLAMA_DEFAULT_MODEL}. Call ollama_list_models to see what is pulled.`),
        system_prompt: z.string().optional().describe("Optional system prompt to set context or role."),
        image: z
          .string()
          .optional()
          .describe(
            "Base64-encoded image for vision models (e.g. llama3.2-vision:11b). Ignored by text-only models — pick a vision model if you pass this.",
          ),
      },
      async ({ prompt, model, system_prompt, image }) => {
        const chosenModel = model || OLLAMA_DEFAULT_MODEL;
        const started = Date.now();
        try {
          // /api/chat carries system + images; /api/generate is the cheaper
          // path when neither is present. Same contract either way.
          let text: string;
          if (image || system_prompt) {
            const messages: { role: string; content: string; images?: string[] }[] = [];
            if (system_prompt) messages.push({ role: "system", content: system_prompt });
            const userMsg: { role: string; content: string; images?: string[] } = { role: "user", content: prompt };
            if (image) userMsg.images = [stripDataUrlPrefix(image)];
            messages.push(userMsg);

            const data = await ollamaFetch(
              baseUrl,
              "/api/chat",
              { model: chosenModel, messages, stream: false },
              OLLAMA_REQUEST_TIMEOUT_MS,
            );
            text = ((data.message as { content?: string } | undefined)?.content ?? "").trim();
          } else {
            const data = await ollamaFetch(
              baseUrl,
              "/api/generate",
              { model: chosenModel, prompt, stream: false },
              OLLAMA_REQUEST_TIMEOUT_MS,
            );
            text = String(data.response ?? "").trim();
          }

          // Never log prompt or response — the entire point of this server is
          // that the content stays local and unrecorded. Metadata only.
          log.debug("ollama_query complete", {
            model: chosenModel,
            durationMs: Date.now() - started,
            chars: text.length,
            vision: !!image,
          });

          return { content: [{ type: "text" as const, text: text || "(empty response)" }] };
        } catch (err) {
          const msg = String(err instanceof Error ? err.message : err);
          log.warn("ollama_query failed", { model: chosenModel, durationMs: Date.now() - started, error: msg });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `ollama_query error (model: ${chosenModel}, url: ${baseUrl}): ${msg}. Check that the Ollama daemon is running and that this model is pulled (ollama_list_models).`,
              },
            ],
          };
        }
      },
    ),
    tool(
      "ollama_list_models",
      "List models pulled on the local Ollama instance, with size and quantization. Call this before ollama_query if you are unsure a model is available.",
      {},
      async () => {
        try {
          const data = await ollamaGet(baseUrl, "/api/tags", OLLAMA_LIST_TIMEOUT_MS);
          const models = summarizeModels(data);
          if (models.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No models are pulled on the local Ollama instance at ${baseUrl}.`,
                },
              ],
            };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(models, null, 2) }] };
        } catch (err) {
          const msg = String(err instanceof Error ? err.message : err);
          log.warn("ollama_list_models failed", { error: msg });
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `ollama_list_models error (url: ${baseUrl}): ${msg}. The Ollama daemon may not be running.`,
              },
            ],
          };
        }
      },
    ),
  ];
}

export function createOllamaMcpServer(deps: OllamaToolDeps = {}) {
  return createSdkMcpServer({
    name: "ollama",
    version: "1.0.0",
    tools: buildOllamaTools(deps),
  });
}
