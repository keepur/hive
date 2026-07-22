import { randomUUID } from "node:crypto";
import type { RunResult } from "../agent-runner.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest, ReasoningEffort } from "./types.js";
import { createCodexOpenAITokenProvider } from "./oauth-credentials.js";

const DEFAULT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";

/** Back-compat alias — KPR-311 moved the canonical type to types.ts. */
export type CodexReasoningEffort = ReasoningEffort;

export interface CodexSubscriptionAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  endpoint?: string;
  codexAuthPath?: string;
  codexRefreshCommand?: string;
  fetch?: typeof fetch;
}

interface CodexResponsePayload {
  id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

interface CodexStreamState {
  text: string;
  responseId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** KPR-353 (§D2): the full response.output item array captured from the
   *  response.completed payload — messages, reasoning (with
   *  encrypted_content when include requests it), function_call items.
   *  Feeds the dispatch loop's next-round input and the §D3 turn record. */
  outputItems: unknown[];
}

interface SseEvent {
  event?: string;
  data: string;
}

export class CodexSubscriptionAdapter implements AgentProviderAdapter {
  readonly provider = "codex" as const;

  private currentAbortController: AbortController | null = null;
  private aborted = false;

  constructor(private readonly options: CodexSubscriptionAdapterOptions) {}

  async runTurn(request: AgentProviderTurnRequest): Promise<RunResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.aborted = false;

    const streamed = !!request.onStream;
    const sessionId = request.sessionId ?? `codex-pilot-${randomUUID()}`;

    try {
      const tokenProvider = createCodexOpenAITokenProvider({
        authPath: this.options.codexAuthPath,
        refreshCommand: this.options.codexRefreshCommand,
      });
      if (!tokenProvider) {
        throw new Error("Codex OAuth session is not available; run `codex login` first");
      }

      const response = await this.fetchImpl()(this.options.endpoint ?? DEFAULT_CODEX_RESPONSES_URL, {
        method: "POST",
        signal: abortController.signal,
        headers: {
          authorization: `Bearer ${await tokenProvider()}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          "openai-beta": "responses=v1",
        },
        body: JSON.stringify({
          model: this.options.model ?? DEFAULT_CODEX_MODEL,
          instructions: request.systemPromptOverride ?? this.options.assembly.instructions,
          reasoning: this.options.reasoningEffort ? { effort: this.options.reasoningEffort } : undefined,
          input: [{ role: "user", content: [{ type: "input_text", text: request.prompt }] }],
          stream: true,
          store: false,
          // KPR-347: assembly.toolInventory is carried but deliberately NOT
          // advertised — posting tools with no executor invites tool calls
          // nothing handles. KPR-348 flips this (tools stays [] until then).
          tools: [],
        }),
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response));
      }

      const state = await consumeCodexSse(response.body, request.onStream, () => this.aborted);
      const durationMs = Date.now() - startedAt;

      if (this.aborted || abortController.signal.aborted) {
        return this.buildResult({
          text: "",
          sessionId,
          durationMs,
          streamed,
          aborted: true,
          inputTokens: state.inputTokens,
          outputTokens: state.outputTokens,
          cacheReadTokens: state.cacheReadTokens,
        });
      }

      return this.buildResult({
        text: state.text,
        sessionId: state.responseId ?? sessionId,
        durationMs,
        streamed,
        aborted: false,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        cacheReadTokens: state.cacheReadTokens,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (this.isAbortError(error, abortController)) {
        return this.buildResult({
          text: "",
          sessionId,
          durationMs,
          streamed,
          aborted: true,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
        });
      }

      return this.buildResult({
        text: "",
        sessionId,
        durationMs,
        streamed,
        aborted: false,
        error: errorMessage(error),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      });
    } finally {
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
  }

  abort(): void {
    this.aborted = true;
    this.currentAbortController?.abort();
  }

  get wasAborted(): boolean {
    return this.aborted;
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  private isAbortError(error: unknown, abortController: AbortController): boolean {
    if (this.aborted || abortController.signal.aborted) return true;
    if (!error || typeof error !== "object") return false;
    const maybeAbort = error as { name?: unknown; code?: unknown };
    return maybeAbort.name === "AbortError" || maybeAbort.code === "ABORT_ERR";
  }

  private buildResult({
    text,
    sessionId,
    durationMs,
    streamed,
    aborted,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    error,
  }: {
    text: string;
    sessionId: string;
    durationMs: number;
    streamed: boolean;
    aborted: boolean;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    error?: string;
  }): RunResult {
    return {
      text,
      sessionId,
      costUsd: 0,
      durationMs,
      llmMs: durationMs,
      toolMs: 0,
      toolCalls: 0,
      toolSummary: "none",
      streamed,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      contextWindow: 0,
      compactions: 0,
      aborted,
      ...(error ? { error } : {}),
    };
  }
}

export async function consumeCodexSse(
  body: ReadableStream<Uint8Array> | null,
  onStream: ((chunk: string) => void) | undefined,
  isAborted: () => boolean = () => false,
): Promise<CodexStreamState> {
  if (!body) throw new Error("Codex subscription response did not include a stream body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: CodexStreamState = {
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    outputItems: [],
  };
  let buffer = "";

  try {
    while (!isAborted()) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeBufferedSseEvents(buffer, state, onStream);
    }
    buffer += decoder.decode();
    consumeBufferedSseEvents(`${buffer}\n\n`, state, onStream);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some Web Stream implementations throw if the stream is already closed.
    }
  }

  return state;
}

export function consumeBufferedSseEvents(
  buffer: string,
  state: CodexStreamState,
  onStream?: (chunk: string) => void,
): string {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? "";

  for (const part of parts) {
    const event = parseSseEvent(part);
    if (!event) continue;
    applyCodexEvent(event, state, onStream);
  }

  return remainder;
}

function parseSseEvent(raw: string): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

function applyCodexEvent(event: SseEvent, state: CodexStreamState, onStream?: (chunk: string) => void): void {
  if (event.data === "[DONE]") return;

  const payload = parseJson(event.data);
  if (!payload) return;

  const type = stringField(payload, "type") ?? event.event ?? "";
  if (type === "response.output_text.delta") {
    const delta = stringField(payload, "delta") ?? "";
    if (!delta) return;
    state.text += delta;
    onStream?.(delta);
    return;
  }

  if (type === "response.output_text.done") {
    const text = stringField(payload, "text") ?? "";
    if (text && state.text !== text) {
      const delta = text.startsWith(state.text) ? text.slice(state.text.length) : "";
      state.text = text;
      if (delta) onStream?.(delta);
    }
    return;
  }

  if (type === "response.created" || type === "response.in_progress") {
    applyInterimResponsePayload(objectField(payload, "response"), state);
    return;
  }

  if (type === "response.completed") {
    applyCompletedResponsePayload(objectField(payload, "response"), state);
    return;
  }

  if (type === "response.failed") {
    const response = objectField(payload, "response");
    const error = objectField(response, "error") ?? objectField(payload, "error");
    throw new Error(stringField(error, "message") ?? stringField(error, "code") ?? "Codex subscription response failed");
  }
}

/**
 * Interim events (response.created / response.in_progress): id overwrite
 * ONLY. KPR-353 (§D2): usage is deliberately NOT read here — interim payloads
 * can carry (partial) usage, and accumulating it would multi-count within a
 * round. Usage keys on response.completed exclusively (pinned, T6).
 */
function applyInterimResponsePayload(
  response: Record<string, unknown> | undefined,
  state: CodexStreamState,
): void {
  if (!response) return;
  const payload = response as CodexResponsePayload;
  if (payload.id) state.responseId = payload.id;
}

/**
 * response.completed: id + usage accumulation + output-item capture.
 * Accumulation (+=) is per completed response — the KPR-353 dispatch loop
 * sums per-round states into turn totals, one completed event per round.
 */
function applyCompletedResponsePayload(
  response: Record<string, unknown> | undefined,
  state: CodexStreamState,
): void {
  if (!response) return;
  const payload = response as CodexResponsePayload;
  if (payload.id) state.responseId = payload.id;
  if (payload.usage?.input_tokens) state.inputTokens += payload.usage.input_tokens;
  if (payload.usage?.output_tokens) state.outputTokens += payload.usage.output_tokens;
  if (payload.usage?.input_tokens_details?.cached_tokens) {
    state.cacheReadTokens += payload.usage.input_tokens_details.cached_tokens;
  }
  const output = response["output"];
  if (Array.isArray(output)) state.outputItems.push(...output);
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  const payload = parseJson(text);
  const message =
    stringField(objectField(payload, "error"), "message") ??
    stringField(payload, "detail") ??
    stringField(payload, "message") ??
    text;
  return `Codex subscription request failed (${response.status}): ${message}`;
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function objectField(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key];
  return field && typeof field === "object" ? (field as Record<string, unknown>) : undefined;
}

function stringField(value: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
