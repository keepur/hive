/**
 * KPR-392: GrokGatewayAdapter — grok's Lane B native adapter, the fourth
 * consumer of the KPR-391 implementation layer (LaneBTurnScaffold +
 * runBoundedDispatchLoop + module registry).
 *
 * Wire surface (spec §4.1): the operator-hosted CLIProxyAPI gateway's
 * OpenAI chat-completions endpoint — POST {baseUrl}/v1/chat/completions,
 * stream: true, stream_options.include_usage — the thinnest translation to
 * xAI's OpenAI-format backend (the KPR-384 lesson: cross-shape translation
 * layers breed quirks). The gateway keeps the `grok login` subscription
 * OAuth; hive holds only a gateway allowlist key (GROK_GATEWAY_KEY),
 * CALLER-resolved (env→Honeypot per spawn in agent-manager's grok arm) and
 * constructor-injected — never resolved in-adapter (DOD-212 / C7).
 *
 * Session semantics (spec §4.2): stateless-replay — the codex model minus
 * codex's quirks. Hive-persisted chat messages replay via TurnHistoryStore
 * (provider "grok"; system prompt NEVER stored — it assembles fresh each
 * turn); success-only whole-turn append; NO in-adapter 4xx self-heal (the
 * loop's onRequestError hook stays unused — grok replay items are plain
 * messages hive composed, so a 4xx on them is a real request-shape bug that
 * heal-by-clear would mask); no encrypted-reasoning replay. Session hooks
 * are scaffold defaults (no fabrication); the success sessionId is the loop
 * formula lastProviderRoundId ?? fallback, fed the LAST round's
 * chat-completion id — cosmetic under stateless-replay, never persisted.
 *
 * C5 from birth (spec §4.4): every request/stream error decoration carries
 * the status when one exists — never codex's response.failed message-only
 * drop (KPR-395).
 */
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { ReasoningEffort } from "./types.js";
import { createLogger } from "../../logging/logger.js";
import type { BridgedTool } from "./tool-bridge.js";
import type { TurnHistoryStore } from "../turn-history-store.js";
import {
  LaneBTurnScaffold,
  type LaneBTurnHarness,
  type LaneBTurnOutcome,
} from "./turn-scaffold.js";
import { runBoundedDispatchLoop } from "./dispatch-loop.js";
import { parseSseEvent, splitSseEvents, isSseDone, type SseEvent } from "./sse.js";

/** KPR-384 posture, unchanged by the promotion: loopback default; the
 *  GROK_GATEWAY_URL override is validated at the manager
 *  (assertSafeBaseUrlOverride — https, or http to loopback only). */
export const DEFAULT_GROK_GATEWAY_URL = "http://127.0.0.1:8317";
/** KPR-371 §3.5: the subscription session exposes only grok-4.6/grok-4.5. */
export const DEFAULT_GROK_MODEL = "grok-4.6";

const log = createLogger("grok-adapter");

/** §4.5: :effort → chat-completions reasoning_effort. low/medium/high/xhigh
 *  deliver VERBATIM (xhigh becomes expressible — the Lane A clamp retires);
 *  minimal/none coerce to low (chat completions has no "off" lever, and
 *  Lane A's silent drop is exactly what this ticket retires). */
const GROK_REASONING_EFFORTS: Record<ReasoningEffort, "low" | "medium" | "high" | "xhigh"> = {
  minimal: "low",
  none: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};
const COERCED_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(["minimal", "none"]);
/** Warn-once per (agent, effort) — module-level (process-wide) because
 *  adapters are per-spawn (gemini precedent, spec-review advisory 3). */
const coercionWarned = new Set<string>();
/** Test-only: module-level warn-once state is order-fragile across tests. */
export function __resetGrokCoercionWarnedForTests(): void {
  coercionWarned.clear();
}

export interface GrokGatewayAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  /** GROK_GATEWAY_KEY — caller-resolved per spawn; never resolved here. */
  apiKey?: string;
  /** Validated gateway base URL — caller-resolved; defaults to loopback. */
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  fetch?: typeof fetch;
  /** Stateless-replay history (primary context only — the module omits both
   *  keys for nested delegate turns, C8 analog). */
  historyStore?: TurnHistoryStore;
  agentId?: string;
}

/** One fully assembled streamed tool call (edge 3: fragments assemble before
 *  harvest; partial calls are never emitted). */
interface GrokToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface GrokStreamState {
  text: string;
  /** chat.completion.chunk `id` — the per-round provider id (advisory 2:
   *  the loop keeps the LAST round's as the success sessionId). */
  completionId?: string;
  finishReason?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** index-keyed incremental tool_call fragments (id/name arrive once,
   *  arguments concatenate). */
  fragments: Map<number, { id?: string; name?: string; arguments: string }>;
  /** Assembled by executeRound after the stream closes; harvested by the loop. */
  assembled: GrokToolCall[];
}

export class GrokGatewayAdapter extends LaneBTurnScaffold {
  readonly provider = "grok" as const;

  constructor(private readonly options: GrokGatewayAdapterOptions) {
    super({ name: options.name, assembly: options.assembly });
  }

  // Session hooks: scaffold defaults ARE grok's policy (spec §4.2/C3) —
  // fallback `request.sessionId ?? ""` (no fabrication; codex's uuid is
  // pilot legacy, deliberately not copied), bare-fallback interruption id.

  protected override warnDeadlineExpired(timeoutMs: number): void {
    log.warn("Grok turn deadline exceeded — aborting turn", {
      agent: this.options.name,
      timeoutMs,
    });
  }

  protected async executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome> {
    const { request, bridge } = harness;

    // History key + replay — codex §D3 template verbatim (absent context ⇒
    // replay and persist both skip; load never throws, never leaks Mongo
    // error text; deliberately BEFORE the key guard — deterministic
    // degradation ordering, the scaffold does not sequence this).
    const threadId = request.workItemContext?.threadId || undefined;
    const historyKey =
      this.options.historyStore && this.options.agentId && threadId
        ? { store: this.options.historyStore, agentId: this.options.agentId, threadId }
        : undefined;
    const replayed = historyKey
      ? await historyKey.store
          .load(historyKey.agentId, historyKey.threadId, "grok")
          .catch((): unknown[] => [])
      : [];

    // Bare-construction guard only: the manager's grok arm resolves
    // GROK_GATEWAY_KEY (env→Honeypot) and throws TurnAssemblyError BEFORE
    // construction (breaker-invisible config fault). Phrased to hit the
    // FAULT_PATTERNS auth row if it ever surfaces from a bare construction.
    const apiKey = this.options.apiKey;
    if (!apiKey) {
      throw new Error(
        "Grok gateway API key is not available; seed GROK_GATEWAY_KEY via `hive credentials add GROK_GATEWAY_KEY`",
      );
    }

    const bridged = await bridge.connect();
    const bridgedByName = new Map(bridged.map((bt) => [bt.name, bt]));
    // Chat-completions function tools. Edge 2 (§6.2): NO schema
    // normalization pre-built here — the `required`-array quirk is believed
    // Anthropic-validator-specific; `parameters.required ??= []` is the
    // one-line mitigation IF live validation bites, not before. (In
    // practice ToolBridge's normalizeSchema at tool-bridge.ts:538 already
    // fills `required: []` on every bridged schema, so the quirk is
    // structurally impossible on this path today.)
    const toolPayloads = bridged.map((bt) => ({
      type: "function" as const,
      function: { name: bt.name, description: bt.description, parameters: bt.inputSchema },
    }));

    const systemMessage = {
      role: "system",
      content: request.systemPromptOverride ?? this.options.assembly.instructions,
    };
    const userMessage = { role: "user", content: request.prompt };
    // Wire messages: system (assembled fresh each turn, NEVER stored) +
    // replayed prior turns + this turn's user message.
    const messages: unknown[] = [systemMessage, ...replayed, userMessage];
    /** §4.2 turn record: user message + every round's assistant message +
     *  hive's tool results. Persisted only on success. */
    const thisTurnItems: unknown[] = [userMessage];

    const endpoint = `${(this.options.baseUrl ?? DEFAULT_GROK_GATEWAY_URL).replace(/\/+$/, "")}/v1/chat/completions`;
    const reasoningEffort = this.resolveReasoningEffort();

    const outcome = await runBoundedDispatchLoop<GrokStreamState, GrokToolCall>({
      request,
      harness,
      executeRound: async () => {
        const response = await this.fetchImpl()(endpoint, {
          method: "POST",
          signal: harness.signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: this.options.model ?? DEFAULT_GROK_MODEL,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            ...(toolPayloads.length > 0 ? { tools: toolPayloads } : {}),
          }),
        });
        // C5: status-prefixed decoration, thrown directly — no onRequestError
        // hook (no self-heal, §4.2), so the throw routes through the loop to
        // the scaffold containment frame and classifies on the status.
        if (!response.ok) throw new Error(await gatewayErrorMessage(response));

        const state = await consumeGrokSse(response.body, request.onStream, harness.isAborted);
        // Edge 3: assemble fragments BEFORE harvest — partial calls are
        // never emitted; anomalies throw (decorated) instead of silently
        // harvesting empty. Skipped when the turn aborted mid-stream (the
        // loop's post-stream checkpoint resolves the interruption).
        if (!harness.isAborted()) {
          state.assembled = assembleToolCalls(state);
          // Edge 3 spirit guard: finish_reason=tool_calls with zero
          // assembled calls is a gateway stream-shape fault, never a
          // silent empty harvest.
          if (state.finishReason === "tool_calls" && state.assembled.length === 0) {
            throw new Error(
              "Grok gateway stream signaled tool_calls with no tool calls assembled — malformed stream",
            );
          }
        }
        const assistantMessage = {
          role: "assistant",
          content: state.text || null,
          ...(state.assembled.length > 0
            ? {
                tool_calls: state.assembled.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        };
        messages.push(assistantMessage);
        thisTurnItems.push(assistantMessage);
        return {
          state,
          usage: {
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cacheReadTokens: state.cacheReadTokens,
          },
          providerRoundId: state.completionId,
          text: state.text,
        };
      },
      harvest: (state) => state.assembled,
      // Dedup belt (spec §4.4): the gateway should never repeat a call id,
      // but the loop-level guard closes the double-emission case for free.
      callId: (call) => call.id,
      executeCall: async (call) => {
        const output = await executeGrokToolCall(call, bridgedByName);
        const toolMessage = { role: "tool", tool_call_id: call.id, content: output };
        messages.push(toolMessage);
        thisTurnItems.push(toolMessage);
      },
    });

    if (outcome.kind !== "success") return outcome;

    // Success-only whole-turn append (fail-soft — a Mongo blip never fails
    // the turn); interrupted/max-turns/deadline outcomes returned above
    // without persisting.
    if (historyKey) {
      await historyKey.store
        .append(historyKey.agentId, historyKey.threadId, "grok", thisTurnItems)
        .catch(() => {});
    }
    return outcome;
  }

  /** §4.5 effort mapping (advisory 3: process-wide warn-once, module-level). */
  private resolveReasoningEffort(): string | undefined {
    const effort = this.options.reasoningEffort;
    if (!effort) return undefined; // no suffix ⇒ field omitted (vendor default)
    const mapped = GROK_REASONING_EFFORTS[effort];
    if (COERCED_EFFORTS.has(effort)) {
      const key = `${this.options.name}:${effort}`;
      if (!coercionWarned.has(key)) {
        coercionWarned.add(key);
        log.warn("Grok :effort suffix coerced to low (KPR-392 §4.5)", {
          agent: this.options.name,
          effort,
          reasoningEffort: mapped,
        });
      }
    }
    return mapped;
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetch ?? fetch;
  }
}

/** Bridge-level containment mirror of codex's executeFunctionCall: a
 *  hallucinated tool name or unparseable arguments become structured tool
 *  output text, never a throw. */
async function executeGrokToolCall(
  call: GrokToolCall,
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

/** Edge 3: fragment assembly — index order, id/name required. A fragment
 *  set missing either is a mid-stream drop, decorated as such ("terminated"
 *  lands on the connect-fail row — the gateway is grok route
 *  infrastructure; its death is a grok outage). */
function assembleToolCalls(state: GrokStreamState): GrokToolCall[] {
  const calls: GrokToolCall[] = [];
  for (const index of [...state.fragments.keys()].sort((a, b) => a - b)) {
    const frag = state.fragments.get(index)!;
    if (!frag.id || !frag.name) {
      throw new Error(
        `Grok gateway stream delivered an incomplete tool_call at index ${index} (missing id or name) — connection terminated mid-stream`,
      );
    }
    calls.push({ id: frag.id, name: frag.name, arguments: frag.arguments });
  }
  return calls;
}

export async function consumeGrokSse(
  body: ReadableStream<Uint8Array> | null,
  onStream: ((chunk: string) => void) | undefined,
  isAborted: () => boolean = () => false,
): Promise<GrokStreamState> {
  if (!body) throw new Error("Grok gateway response did not include a stream body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: GrokStreamState = {
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    fragments: new Map(),
    assembled: [],
  };
  let buffer = "";

  try {
    while (!isAborted()) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = consumeBufferedGrokEvents(buffer, state, onStream);
    }
    buffer += decoder.decode();
    consumeBufferedGrokEvents(`${buffer}\n\n`, state, onStream);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some Web Stream implementations throw if the stream is already closed.
    }
  }

  // Edge 3: a stream that ended without any finish_reason (and was not
  // aborted by hive) is a gateway drop — surface it, never a silent empty
  // harvest. "terminated" lands on the connect-fail FAULT_PATTERNS row.
  if (!isAborted() && state.finishReason === undefined) {
    throw new Error("Grok gateway stream ended without finish_reason — connection terminated mid-stream");
  }
  return state;
}

export function consumeBufferedGrokEvents(
  buffer: string,
  state: GrokStreamState,
  onStream?: (chunk: string) => void,
): string {
  const { events, remainder } = splitSseEvents(buffer);
  for (const raw of events) {
    const event = parseSseEvent(raw);
    if (!event) continue;
    applyGrokChunk(event, state, onStream);
  }
  return remainder;
}

function applyGrokChunk(event: SseEvent, state: GrokStreamState, onStream?: (chunk: string) => void): void {
  if (isSseDone(event)) return;

  const payload = parseJson(event.data);
  if (!payload) return;

  // C5: an in-stream error payload keeps its status/code — never message-only.
  const errorObj = objectField(payload, "error");
  if (errorObj) {
    const status = errorObj["status"] ?? errorObj["code"];
    const message = stringField(errorObj, "message") ?? JSON.stringify(errorObj);
    throw new Error(
      status !== undefined && status !== null
        ? `Grok gateway stream failed (${String(status)}): ${message}`
        : `Grok gateway stream failed: ${message}`,
    );
  }

  const id = stringField(payload, "id");
  if (id) state.completionId = id;

  // include_usage delivers one final usage-bearing chunk (empty choices) —
  // assignment, not accumulation: last-wins can never multi-count within a
  // round (codex's interim-usage lesson, adapted to the chat shape).
  const usage = objectField(payload, "usage");
  if (usage) {
    state.inputTokens = numberField(usage, "prompt_tokens") ?? state.inputTokens;
    state.outputTokens = numberField(usage, "completion_tokens") ?? state.outputTokens;
    const details = objectField(usage, "prompt_tokens_details");
    const cached = details ? numberField(details, "cached_tokens") : undefined;
    if (cached !== undefined) state.cacheReadTokens = cached;
  }

  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return;
  const choice = choices[0] as Record<string, unknown>;

  const finish = stringField(choice, "finish_reason");
  if (finish) state.finishReason = finish;

  const delta = objectField(choice, "delta");
  if (!delta) return;

  const content = stringField(delta, "content");
  if (content) {
    state.text += content;
    onStream?.(content);
  }

  const toolCalls = delta["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const raw of toolCalls) {
      if (!raw || typeof raw !== "object") continue;
      const frag = raw as Record<string, unknown>;
      const index = numberField(frag, "index");
      if (index === undefined) continue;
      const entry = state.fragments.get(index) ?? { arguments: "" };
      const fragId = stringField(frag, "id");
      if (fragId) entry.id = fragId;
      const fn = objectField(frag, "function");
      const name = fn ? stringField(fn, "name") : undefined;
      if (name) entry.name = name;
      const args = fn ? stringField(fn, "arguments") : undefined;
      if (args) entry.arguments += args;
      state.fragments.set(index, entry);
    }
  }
}

/** C5 decoration — mirrors codex's responseErrorMessage shape exactly
 *  (`(<status>):` is what the FAULT_PATTERNS rows key on). */
async function gatewayErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  const payload = parseJson(text);
  const message =
    stringField(objectField(payload, "error"), "message") ??
    stringField(payload, "detail") ??
    stringField(payload, "message") ??
    text;
  return `Grok gateway request failed (${response.status}): ${message}`;
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

function numberField(value: Record<string, unknown> | null | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" ? field : undefined;
}
