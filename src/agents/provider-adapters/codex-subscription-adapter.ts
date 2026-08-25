import { randomUUID } from "node:crypto";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { AgentProviderTurnRequest, ReasoningEffort } from "./types.js";
import { createCodexOpenAITokenProvider } from "./oauth-credentials.js";
import { createLogger } from "../../logging/logger.js";
import type { BridgedTool } from "./tool-bridge.js";
import type { TurnHistoryStore } from "../turn-history-store.js";
import {
  LaneBTurnScaffold,
  type LaneBTurnHarness,
  type LaneBTurnOutcome,
  type LaneBSessionPolicyState,
} from "./turn-scaffold.js";
import { runBoundedDispatchLoop } from "./dispatch-loop.js";
import { parseSseEvent, splitSseEvents, isSseDone, type SseEvent } from "./sse.js";

const DEFAULT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";

const log = createLogger("codex-adapter");

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

/** Carries a non-ok Response from executeRound to the loop's onRequestError
 *  hook (the §D7 heal decision needs the status; the decorated message is
 *  built lazily — responseErrorMessage awaits the body). */
class CodexResponseHttpError extends Error {
  constructor(readonly response: Response) {
    super(`Codex subscription request failed (${response.status})`);
  }
}

export class CodexSubscriptionAdapter extends LaneBTurnScaffold {
  readonly provider = "codex" as const;

  constructor(private readonly options: CodexSubscriptionAdapterOptions) {
    super({ name: options.name, assembly: options.assembly });
  }

  /** Pilot-era fabricated fallback (persisted-id behavior pin — the
   *  stateless-replay surface never persists it as a handle). */
  protected override fallbackSessionId(request: AgentProviderTurnRequest): string {
    return request.sessionId ?? `codex-pilot-${randomUUID()}`;
  }

  /** Codex aborted / error_max_turns results carry the last response id when
   *  one exists (§7 three-way pin); deadline/catch-error stay bare fallback
   *  via the scaffold. */
  protected override interruptionSessionId(state: LaneBSessionPolicyState): string {
    return state.lastProviderRoundId ?? state.fallbackSessionId;
  }

  protected override warnDeadlineExpired(timeoutMs: number): void {
    log.warn("Codex turn deadline exceeded — aborting turn", {
      agent: this.options.name,
      timeoutMs,
    });
  }

  protected async executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome> {
    const { request, bridge } = harness;

    // §D3 thread key: absent context ⇒ replay and persist both skip.
    const threadId = request.workItemContext?.threadId || undefined;
    const historyKey =
      this.options.historyStore && this.options.agentId && threadId
        ? { store: this.options.historyStore, agentId: this.options.agentId, threadId }
        : undefined;

    // §D3: load NEVER throws and NEVER returns Mongo error text (breaker
    // safety). Deliberately BEFORE the auth check: degradation ordering is
    // deterministic (T4-pinned) — the scaffold does not sequence this.
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
    // §D1: BridgedTool[] → Responses function tools. Name/cap edges are
    // bridge-owned (KPR-348/349).
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
    let replayedNonEmpty = replayed.length > 0;
    let selfHealed = false;

    const outcome = await runBoundedDispatchLoop<CodexStreamState, FunctionCallItem>({
      request,
      harness,
      executeRound: async () => {
        const response = await this.fetchImpl()(this.options.endpoint ?? DEFAULT_CODEX_RESPONSES_URL, {
          method: "POST",
          signal: harness.signal,
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
            // §D2/§D3: encrypted reasoning must round-trip for replay quality.
            include: ["reasoning.encrypted_content"],
            tools: toolPayloads,
          }),
        });
        if (!response.ok) throw new CodexResponseHttpError(response);

        // Deadline-aware consume: harness.isAborted subsumes the #407
        // signal-abort leg.
        const state = await consumeCodexSse(response.body, request.onStream, harness.isAborted);
        inputItems.push(...state.outputItems);
        thisTurnItems.push(...state.outputItems);
        return {
          state,
          usage: {
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cacheReadTokens: state.cacheReadTokens,
          },
          providerRoundId: state.responseId,
          text: state.text,
        };
      },
      harvest: (state) => state.outputItems.filter(isFunctionCallItem),
      // Dedupe by call_id: closes the degenerate double-`response.completed`
      // case that would otherwise double-execute the tool.
      callId: (call) => call.call_id,
      executeCall: async (call) => {
        const output = await executeFunctionCall(call, bridgedByName);
        const outputItem = { type: "function_call_output", call_id: call.call_id, output };
        inputItems.push(outputItem);
        thisTurnItems.push(outputItem);
      },
      onRequestError: async (error, round) => {
        if (!(error instanceof CodexResponseHttpError)) return undefined;
        const { response } = error;
        // §D7 poisoned-replay self-heal: first-round 4xx on a request that
        // replayed non-empty history ⇒ ONE retry with history dropped +
        // clear the doc. Breadth PINNED: ALL 4xx incl. 401/403/429 (T7).
        // 5xx/network keep full breaker weight — no retry, no clear.
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
          await historyKey.store.clear(historyKey.agentId, historyKey.threadId).catch(() => {});
          inputItems.length = 0;
          inputItems.push(userItem);
          replayedNonEmpty = false;
          selfHealed = true;
          return { action: "restart-fresh" };
        }
        return { action: "rethrow", error: new Error(await responseErrorMessage(response)) };
      },
    });

    if (outcome.kind !== "success") return outcome;

    // §D3 persist policy: success only — interrupted/max-turns/deadline
    // outcomes return above without persisting (deadline resolves to
    // "interrupted" at a loop checkpoint or in the scaffold catch).
    if (historyKey) {
      await historyKey.store
        .append(historyKey.agentId, historyKey.threadId, "codex", thisTurnItems)
        .catch(() => {});
    }
    return outcome;
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetch ?? fetch;
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
  const { events, remainder } = splitSseEvents(buffer);
  for (const raw of events) {
    const event = parseSseEvent(raw);
    if (!event) continue;
    applyCodexEvent(event, state, onStream);
  }
  return remainder;
}

function applyCodexEvent(event: SseEvent, state: CodexStreamState, onStream?: (chunk: string) => void): void {
  if (isSseDone(event)) return;

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
