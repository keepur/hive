import { randomUUID } from "node:crypto";
import type { RunResult } from "../agent-runner.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest, ReasoningEffort } from "./types.js";
import { createCodexOpenAITokenProvider } from "./oauth-credentials.js";
import { createLogger } from "../../logging/logger.js";
import { ToolBridge, type BridgedTool } from "./tool-bridge.js";
import type { TurnHistoryStore } from "../turn-history-store.js";

const DEFAULT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";

const log = createLogger("codex-adapter");
/** §D2: mirrors the openai adapter's SDK default when resourceLimits is absent. */
const DEFAULT_MAX_ROUNDS = 10;

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
  /** KPR-353 (§D3): hive-persisted stateless-replay history. Absent ⇒ every
   *  turn is stateless (the pre-353 floor — bare test constructions,
   *  hypothetical direct spawns). */
  historyStore?: TurnHistoryStore;
  /** KPR-353: agent id (config.id) keying history docs. The existing `name`
   *  is the display name and stays logging-only. */
  agentId?: string;
}

interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments?: string;
}

function isFunctionCallItem(item: unknown): item is FunctionCallItem {
  if (!item || typeof item !== "object") return false;
  const it = item as Record<string, unknown>;
  return it.type === "function_call" && typeof it.call_id === "string" && typeof it.name === "string";
}

/**
 * §D2 loop-local containment additions on top of the bridge's own (KPR-348
 * §D3 — BridgedTool.execute NEVER throws): a hallucinated tool name or
 * unparseable arguments become structured function_call_output text, never a
 * throw. Nothing in the dispatch loop can escape runTurn as a throw.
 */
async function executeFunctionCall(
  call: FunctionCallItem,
  bridgedByName: Map<string, BridgedTool>,
): Promise<string> {
  const bt = bridgedByName.get(call.name);
  if (!bt) return `Tool execution failed (${call.name}): unknown tool`;
  let args: unknown;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return `Tool execution failed (${call.name}): arguments were not valid JSON`;
  }
  return bt.execute(args);
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
  /** KPR-353 (§D2): the full response.output item array — messages, reasoning
   *  (with encrypted_content when include requests it), function_call items.
   *  Captured from BOTH sources (Task 0 spike Delta 1): the streaming
   *  `response.output_item.done` events (the ONLY populated source under
   *  store:false in production) AND the `response.completed.output` payload
   *  (the source the unit fixtures feed), deduped by item id so the two never
   *  double-add the same item. Feeds the dispatch loop's next-round input and
   *  the §D3 turn record. */
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

    // KPR-353 (§D1): per-spawn tool bridge — the openai adapter's exact
    // construction (openai-agents-adapter.ts:54-63). connect() inside the
    // try (fail-soft per server; an all-failed bridge yields [] and the turn
    // runs tool-less); close() in the finally.
    const bridge = new ToolBridge({
      inventory: this.options.assembly.toolInventory,
      inProcessServers: this.options.assembly.inProcessServers,
      gate: this.options.assembly.guardrailGate,
      workItemContext: request.workItemContext,
      signal: abortController.signal,
      agentId: this.options.name,
      sessionCwd: this.options.assembly.sessionCwd,
      skillIndex: this.options.assembly.skillIndex,
    });

    // §D3 thread key: absent context ⇒ replay and persist both skip.
    const threadId = request.workItemContext?.threadId || undefined;
    const historyKey =
      this.options.historyStore && this.options.agentId && threadId
        ? { store: this.options.historyStore, agentId: this.options.agentId, threadId }
        : undefined;

    // Turn accumulators (visible to the abort helper below).
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let lastResponseId: string | undefined;

    const abortedResult = (): RunResult =>
      this.buildResult({
        text: "",
        sessionId: lastResponseId ?? sessionId,
        durationMs: Date.now() - startedAt,
        streamed,
        aborted: true,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });

    try {
      // §D3: load NEVER throws and NEVER returns Mongo error text (breaker
      // safety — store-owned contract; the .catch is belt-and-braces against
      // a future non-conforming store impl leaking Mongo text into
      // RunResult.error). Deliberately BEFORE the auth check: degradation
      // ordering is deterministic and manager-level ordering tests (T4)
      // observe load via runTurn without a credential.
      const replayed = historyKey
        ? await historyKey.store
            .load(historyKey.agentId, historyKey.threadId, "codex")
            .catch((): unknown[] => [])
        : [];

      const tokenProvider = createCodexOpenAITokenProvider({
        authPath: this.options.codexAuthPath,
        refreshCommand: this.options.codexRefreshCommand,
      });
      if (!tokenProvider) {
        throw new Error("Codex OAuth session is not available; run `codex login` first");
      }

      const bridged = await bridge.connect();
      const bridgedByName = new Map(bridged.map((bt) => [bt.name, bt]));
      // §D1: BridgedTool[] → Responses function tools. Name/cap edges
      // (sanitization, 128-cap with the KPR-349 pinned tier) are bridge-owned.
      const toolPayloads = bridged.map((bt) => ({
        type: "function" as const,
        name: bt.name,
        description: bt.description,
        parameters: bt.inputSchema,
        strict: false as const,
      }));

      const userItem = { role: "user", content: [{ type: "input_text", text: request.prompt }] };
      const inputItems: unknown[] = [...replayed, userItem];
      /** §D3 turn record: user item + every round's output items + hive's
       *  function_call_output items. Persisted only on success. */
      const thisTurnItems: unknown[] = [userItem];
      let finalText = "";
      let replayedNonEmpty = replayed.length > 0;
      let selfHealed = false;

      // Note `maxTurns: 0` ⇒ maxRounds 0 (`??` passes 0 through) ⇒ immediate
      // error_max_turns without a POST. Deliberate divergence from the openai
      // lane, which hands 0 to the SDK — a zero budget honestly means "no
      // model rounds" here; not normalized.
      const maxRounds = request.resourceLimits?.maxTurns ?? DEFAULT_MAX_ROUNDS;
      let round = 0;
      for (;;) {
        round += 1;
        if (round > maxRounds) {
          // §D2: the SDK sentinel string, already pinned non-provider
          // (error-classification.ts:57). No history persist.
          return this.buildResult({
            text: "",
            sessionId: lastResponseId ?? sessionId,
            durationMs: Date.now() - startedAt,
            streamed,
            aborted: false,
            error: "error_max_turns",
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            toolStats: bridge.stats,
          });
        }
        if (this.aborted || abortController.signal.aborted) return abortedResult();

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
            input: inputItems,
            stream: true,
            store: false,
            // §D2/§D3: encrypted reasoning must round-trip for replay quality
            // on this store:false surface (spike leg (c)).
            include: ["reasoning.encrypted_content"],
            tools: toolPayloads,
          }),
        });

        if (!response.ok) {
          // §D7 poisoned-replay self-heal: first-round 4xx on a request that
          // replayed non-empty history ⇒ ONE retry with history dropped +
          // clear the doc. 5xx/network keep full breaker weight — no retry,
          // no clear. A non-replay 4xx never retries.
          // Breadth PINNED (deliberate): ALL 4xx incl. 401/403/429 heal-and-
          // clear per §D7 — a transient-fault over-clear (expired token, rate
          // limit) costs one bounded reset + one retry; accepted as the §D7
          // backstop rather than status-sniffing. T7 pins the 429 case.
          if (
            round === 1 &&
            !selfHealed &&
            replayedNonEmpty &&
            response.status >= 400 &&
            response.status < 500 &&
            historyKey
          ) {
            log.warn("Codex replay rejected (4xx) — one fresh retry + history clear (KPR-353 §D7)", {
              agentId: historyKey.agentId,
              status: response.status,
            });
            // never throws (§D3); .catch = belt-and-braces store-impl guard
            await historyKey.store.clear(historyKey.agentId, historyKey.threadId).catch(() => {});
            inputItems.length = 0;
            inputItems.push(userItem);
            replayedNonEmpty = false;
            selfHealed = true;
            round = 0; // healed turn gets its full round budget
            continue;
          }
          throw new Error(await responseErrorMessage(response));
        }

        // Fresh per-round state; text deltas stream to onStream across ALL
        // rounds (intermediate think-aloud), but RunResult.text is the FINAL
        // round's assistant text only (§D2 final-reply semantics).
        const state = await consumeCodexSse(response.body, request.onStream, () => this.aborted);
        totals.inputTokens += state.inputTokens;
        totals.outputTokens += state.outputTokens;
        totals.cacheReadTokens += state.cacheReadTokens;
        if (state.responseId) lastResponseId = state.responseId;
        finalText = state.text;

        inputItems.push(...state.outputItems);
        thisTurnItems.push(...state.outputItems);

        if (this.aborted || abortController.signal.aborted) return abortedResult();

        // Dedupe by call_id: closes the degenerate double-`response.completed`
        // case (both payloads captured into outputItems) that would otherwise
        // double-execute the tool and double-append its output item.
        const seenCallIds = new Set<string>();
        const calls = state.outputItems.filter(
          (item): item is FunctionCallItem =>
            isFunctionCallItem(item) && !seenCallIds.has(item.call_id) && !!seenCallIds.add(item.call_id),
        );
        if (calls.length === 0) break;

        // Sequential by design (spec ⚠: hive's in-process handlers are not
        // concurrency-audited under one turn; parallelizing is a follow-up
        // lever, deliberately not pre-built).
        for (const call of calls) {
          if (this.aborted || abortController.signal.aborted) return abortedResult();
          const output = await executeFunctionCall(call, bridgedByName);
          const outputItem = { type: "function_call_output", call_id: call.call_id, output };
          inputItems.push(outputItem);
          thisTurnItems.push(outputItem);
        }
      }

      const durationMs = Date.now() - startedAt;
      if (this.aborted || abortController.signal.aborted) return abortedResult();

      // §D3 persist policy: success only — error/aborted turns never persist
      // (an errored turn's item may be re-delivered by the retry/outage path;
      // persisting would duplicate the user message on replay). Fail-soft
      // void; .catch = belt-and-braces store-impl guard.
      if (historyKey) {
        await historyKey.store
          .append(historyKey.agentId, historyKey.threadId, "codex", thisTurnItems)
          .catch(() => {});
      }

      return this.buildResult({
        text: finalText,
        sessionId: lastResponseId ?? sessionId,
        durationMs,
        streamed,
        aborted: false,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (this.isAbortError(error, abortController)) {
        return this.buildResult({
          text: "",
          sessionId: lastResponseId ?? sessionId,
          durationMs,
          streamed,
          aborted: true,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          toolStats: bridge.stats,
        });
      }

      return this.buildResult({
        text: "",
        sessionId,
        durationMs,
        streamed,
        aborted: false,
        error: errorMessage(error),
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });
    } finally {
      await bridge.close(); // never throws/rejects (KPR-348 advisory 1)
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
    toolStats,
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
    toolStats?: Readonly<{ toolCalls: number; toolMs: number; perTool: Map<string, number> }>;
  }): RunResult {
    const toolMs = toolStats?.toolMs ?? 0;
    const toolCalls = toolStats?.toolCalls ?? 0;
    const toolSummary =
      toolStats && toolStats.perTool.size > 0
        ? [...toolStats.perTool.entries()].map(([n, c]) => `${n}×${c}`).join(", ")
        : "none";
    return {
      text,
      sessionId,
      costUsd: 0,
      durationMs,
      // §D6 (KPR-348 §D8 rule): the breaker's p95 window samples llmMs —
      // folding tool time in would let slow-but-healthy tools trip a healthy
      // codex endpoint. Clamped: degenerate/mocked timing can't go negative.
      llmMs: Math.max(0, durationMs - toolMs),
      toolMs,
      toolCalls,
      toolSummary,
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

  if (type === "response.output_item.done") {
    // KPR-353 spike Delta 1: under store:false the real backend delivers each
    // output item (reasoning / function_call / message) incrementally here —
    // response.completed.output is EMPTY. `payload.item` carries the item.
    // Deduped by id against the completed-payload capture (only one source
    // fires per environment, but the dedup keeps both correct if they ever do).
    const item = objectField(payload, "item");
    if (item) pushOutputItem(state, item);
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
  if (Array.isArray(output)) {
    for (const item of output) pushOutputItem(state, item);
  }
}

/**
 * KPR-353 spike Delta 1: single sink for output items from BOTH capture
 * sources (streaming response.output_item.done + response.completed.output),
 * deduped by item `id`. An item without an id (or a non-object) is always
 * pushed — it can't collide. Verbatim behavior for the unit fixtures (whose
 * items carry distinct ids) is preserved.
 */
function pushOutputItem(state: CodexStreamState, item: unknown): void {
  const id = itemId(item);
  if (id !== undefined && state.outputItems.some((existing) => itemId(existing) === id)) return;
  state.outputItems.push(item);
}

function itemId(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const id = (item as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
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
