import { ApiError, GoogleGenAI } from "@google/genai";
import type { RunResult } from "../agent-runner.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest, ReasoningEffort } from "./types.js";
import { envValue } from "./oauth-credentials.js";
import { createLogger } from "../../logging/logger.js";
import { ToolBridge, type BridgedTool } from "./tool-bridge.js";

const log = createLogger("gemini-adapter");

/** KPR-352 plan-time pin: Interactions-supported default (verified against the
 *  live model list 2026-07-23, T0 spike). GEMINI_AGENT_MODEL / agent model
 *  override. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
/** §D1: mirrors the codex adapter's round bound when resourceLimits is absent. */
const DEFAULT_MAX_ROUNDS = 10;

/**
 * §D3: statuses that mark a ROUND-1 resume-carrying create failure as a stale
 * persisted handle. T0 spike leg (d) refined the docs+community-sourced
 * {400,403,404} down to the observed live set {400}: both fabricated and
 * malformed `previous_interaction_id` returned HTTP 400 "Request contains an
 * invalid argument." 429/5xx are deliberately excluded — rate limits and
 * server errors on a resume-carrying request are provider faults that must
 * keep breaker weight and must not cost thread context (KPR-350 narrowness).
 */
const STALE_HANDLE_STATUSES = new Set([400]);

/**
 * §D3 (T0 spike concern, folded verbatim): status 400 is generic — a genuinely
 * malformed request also returns 400. Tagging on status alone would over-match
 * real config faults into the self-heal path, silently resetting thread
 * continuity every turn. So the tag ALSO requires an invalid-argument /
 * interaction-not-found-shaped message discriminator. The observed live
 * message is "Request contains an invalid argument."; the interaction-not-found
 * and expired shapes are covered for robustness.
 */
const STALE_HANDLE_MESSAGE =
  /invalid argument|interaction[\s._-]*not[\s._-]*found|not found|no longer (?:exists|available)|previous_interaction_id/i;

/** §D3: hive sentinel — isStaleServerHandleError (agent-manager.ts) matches
 *  this prefix; the KPR-350 arm consumes it before it can reach the breaker
 *  (a raw stale-chain 400 would otherwise be an ordinary provider fault and
 *  cost thread context every turn). */
const STALE_HANDLE_SENTINEL = "gemini interaction resume rejected";

/** §D5: :effort → thinking_level. minimal/low/medium/high pass through;
 *  none→minimal, xhigh→high coerced (warn-once). Coercion, not vendor-400
 *  pass-through: a config-400 on a chained round-1 request would be
 *  tag-eligible and silently reset thread continuity EVERY turn. T0 spike
 *  leg (c) confirmed all four native levels accepted on gemini-3.6-flash. */
const THINKING_LEVELS: Record<ReasoningEffort, "minimal" | "low" | "medium" | "high"> = {
  minimal: "minimal",
  none: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};
const COERCED_EFFORTS: ReadonlySet<ReasoningEffort> = new Set(["none", "xhigh"]);
/** Warn-once per (agent, value) — module-level because adapters are per-spawn. */
const coercionWarned = new Set<string>();
/** Test-only: module-level warn-once state is order-fragile across tests (plan-review/1/fable advisory). */
export function __resetCoercionWarnedForTests(): void {
  coercionWarned.clear();
}

/**
 * Narrow injection seam over @google/genai `client.interactions.create`
 * (streaming form only). The SDK's overloads key on `stream: true` literal
 * types in richly-typed param unions the adapter assembles dynamically, so
 * the default impl centralizes one structured cast; tests inject a scripted
 * iterable and never touch the SDK.
 */
export interface GeminiInteractionsClient {
  create(
    params: Record<string, unknown>,
    options: { fetchOptions: { signal: AbortSignal }; maxRetries: number },
  ): Promise<AsyncIterable<Record<string, unknown>>>;
}

function buildDefaultClient(apiKey: string): GeminiInteractionsClient {
  // Property access through the same object preserves `this` binding for the
  // eventual method call.
  return new GoogleGenAI({ apiKey }).interactions as unknown as GeminiInteractionsClient;
}

export interface GeminiInteractionsAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  /** config.gemini.apiKey (env-first via config.ts); falls back to
   *  GOOGLE_GENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY (§D7). */
  apiKey?: string;
  reasoningEffort?: ReasoningEffort;
  /** Test seam — tests MUST always set this (harness guardrail: the dev
   *  machine holds live gemini credentials). */
  client?: GeminiInteractionsClient;
  /** Test seam for key resolution. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** One harvested function call, both stream sources normalized (§D1). */
export interface GeminiFunctionCall {
  id: string;
  name: string;
  arguments: unknown;
  /** Set when streamed arguments_delta text failed JSON.parse — containment. */
  argumentsError?: string;
}

export interface GeminiRoundState {
  text: string;
  interactionId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** interaction.completed's interaction.steps — DEAD on the live surface
   *  (T0 spike Delta 1: the completed envelope has no steps field). Kept as
   *  the dual-source harvest's authoritative-when-present leg; the streaming
   *  reconstruction below is the live source. */
  completedSteps: unknown[];
  /** step.start snapshots by step index (streaming reconstruction source —
   *  the live/authoritative one per T0 spike Delta 1). */
  startedSteps: Map<number, Record<string, unknown>>;
  /** Accumulated arguments_delta text by step index. */
  argumentsByIndex: Map<number, string>;
  sawCompleted: boolean;
}

export class GeminiInteractionsAdapter implements AgentProviderAdapter {
  readonly provider = "gemini" as const;

  private currentAbortController: AbortController | null = null;
  private aborted = false;

  constructor(private readonly options: GeminiInteractionsAdapterOptions) {}

  async runTurn(request: AgentProviderTurnRequest): Promise<RunResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.aborted = false;

    const streamed = !!request.onStream;
    /** §D1: error/abort fallback — NEVER a fabricated id. Under
     *  server-resumable semantics a fabricated id would be persisted and later
     *  resumed as garbage; the gemini-pilot- fabrication died with this
     *  rewrite. "" persists nothing (finalize's falsy guard); an unchanged
     *  resumed id is a harmless same-id TTL refresh, and the pre-error chain
     *  state resumes next turn (deliberately NOT the mid-turn minted id). */
    const fallbackSessionId = request.sessionId ?? "";

    // KPR-352 (§D1): per-spawn tool bridge — the codex adapter's exact
    // construction (codex-subscription-adapter.ts:126-136), including the
    // KPR-354 §D6 delegateRunner one-liner. connect() inside the try
    // (fail-soft per server); close() in the finally.
    const bridge = new ToolBridge({
      inventory: this.options.assembly.toolInventory,
      inProcessServers: this.options.assembly.inProcessServers,
      gate: this.options.assembly.guardrailGate,
      workItemContext: request.workItemContext,
      signal: abortController.signal,
      agentId: this.options.name,
      sessionCwd: this.options.assembly.sessionCwd,
      skillIndex: this.options.assembly.skillIndex,
      delegateRunner: this.options.assembly.delegateTurnRunner, // KPR-354 (§D6)
    });

    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    const abortedResult = (): RunResult =>
      this.buildResult({
        text: "",
        sessionId: fallbackSessionId,
        durationMs: Date.now() - startedAt,
        streamed,
        aborted: true,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });

    try {
      // §D7: API-key single path (Vertex OAuth deleted — Interactions is not
      // served on Vertex). Pre-request throw → classifyThrown "auth" (row
      // alternate pinned) → breaker → honest outage; `hive credentials add
      // GEMINI_API_KEY` recovers next spawn. The finally below still runs
      // bridge.close() on this path (T9).
      const env = this.options.env ?? process.env;
      const apiKey =
        this.options.apiKey ||
        envValue("GOOGLE_GENAI_API_KEY", env) ||
        envValue("GEMINI_API_KEY", env) ||
        envValue("GOOGLE_API_KEY", env);
      if (!apiKey) {
        throw new Error(
          "Gemini API key is not available; set GEMINI_API_KEY (hive credentials add GEMINI_API_KEY) or GOOGLE_API_KEY",
        );
      }
      const client = this.options.client ?? buildDefaultClient(apiKey);

      const bridged = await bridge.connect();
      const bridgedByName = new Map(bridged.map((bt) => [bt.name, bt]));
      // §D1: BridgedTool[] → Interactions function tools (T0 spike leg (b):
      // {type:"function", name, description, parameters} accepted). Name/cap
      // edges are bridge-owned (KPR-348/349).
      const toolPayloads = bridged.map((bt) => ({
        type: "function" as const,
        name: bt.name,
        description: bt.description,
        parameters: bt.inputSchema,
      }));

      const thinkingLevel = this.resolveThinkingLevel();

      /** §D1: previous_interaction_id does double duty — round 1 resumes the
       *  persisted handle (undefined ⇒ fresh thread); rounds N+1 chain the
       *  prior round's just-minted id and send ONLY the function_result
       *  items (the server holds the rest — T0 spike: no client replay). */
      let chainHead: string | undefined = request.sessionId || undefined;
      let input: unknown = request.prompt;
      let finalText = "";
      let lastInteractionId: string | undefined;

      // maxTurns 0 ⇒ zero create calls ⇒ error_max_turns (codex-identical
      // divergence pin: a zero budget honestly means "no model rounds").
      const maxRounds = request.resourceLimits?.maxTurns ?? DEFAULT_MAX_ROUNDS;
      let round = 0;
      for (;;) {
        round += 1;
        if (round > maxRounds) {
          return this.buildResult({
            text: "",
            sessionId: fallbackSessionId,
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

        let stream: AsyncIterable<Record<string, unknown>>;
        try {
          stream = await client.create(
            {
              model: this.options.model || DEFAULT_GEMINI_MODEL,
              // Documented: system_instruction does NOT persist across chained
              // interactions — re-sent every round (§D2).
              system_instruction: request.systemPromptOverride ?? this.options.assembly.instructions,
              input,
              stream: true,
              // §D2 posture pin: chaining prerequisite — pinned, not
              // defaulted. T0 spike ran store:true + previous_interaction_id
              // as the working durable-resume shape.
              store: true,
              ...(chainHead ? { previous_interaction_id: chainHead } : {}),
              ...(thinkingLevel ? { generation_config: { thinking_level: thinkingLevel } } : {}),
              tools: toolPayloads,
            },
            // maxRetries 0: single-attempt by design — retry policy belongs
            // to the breaker/outage layer; SDK-internal retries would mask
            // rate-limit/5xx faults from classification.
            { fetchOptions: { signal: abortController.signal }, maxRetries: 0 },
          );
        } catch (error) {
          throw this.describeCreateError(error, round, request.sessionId || undefined);
        }

        // Text deltas from EVERY round reach onStream (intermediate
        // think-aloud); RunResult.text is the final round's text only (§D1
        // final-reply semantics, 353 parity).
        const state = await consumeInteractionStream(stream, request.onStream, () => this.aborted);
        totals.inputTokens += state.inputTokens;
        totals.outputTokens += state.outputTokens;
        totals.cacheReadTokens += state.cacheReadTokens;
        if (state.interactionId) lastInteractionId = state.interactionId;
        finalText = state.text;

        if (this.aborted || abortController.signal.aborted) return abortedResult();

        // T0 spike Delta 2: interaction.completed.status === "requires_action"
        // signals pending function_calls; harvestFunctionCalls returns them
        // (from the step.start events that carry that same pending call), so
        // the harvest-driven loop control IS the requires_action drive — a
        // non-empty harvest ⟺ a requires_action turn.
        const calls = harvestFunctionCalls(state);
        if (calls.length === 0) break;
        if (!state.interactionId) {
          // Can't chain the function_result round without the parent id.
          throw new Error("Gemini interaction stream ended without an interaction id");
        }

        // Sequential by design (KPR-353 pin: in-process handlers are not
        // concurrency-audited under one turn). All results ship in ONE
        // follow-up round.
        const resultItems: unknown[] = [];
        for (const call of calls) {
          if (this.aborted || abortController.signal.aborted) return abortedResult();
          const output = await executeFunctionCall(call, bridgedByName);
          // T0 spike leg (b2): function_result input shape accepted verbatim.
          resultItems.push({
            type: "function_result",
            name: call.name,
            call_id: call.id,
            result: [{ type: "text", text: output }],
          });
        }
        chainHead = state.interactionId;
        input = resultItems;
      }

      const durationMs = Date.now() - startedAt;
      if (this.aborted || abortController.signal.aborted) return abortedResult();

      return this.buildResult({
        // §D1: the FINAL round's interaction id — it transitively contains
        // the whole turn. A success without an id persists nothing (the
        // finalize path's falsy guard) rather than persisting a lie.
        text: finalText,
        sessionId: lastInteractionId ?? fallbackSessionId,
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
          sessionId: fallbackSessionId,
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
        sessionId: fallbackSessionId,
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

  /**
   * §D3: deterministic stale-handle detection — the adapter KNOWS whether the
   * failing create carried the persisted handle: round 1 is the only round
   * that chains request.sessionId; intra-turn rounds chain the prior round's
   * just-minted id, which cannot be a stale PERSISTED handle — tagging those
   * would let the manager's fresh-retry arm re-run the whole turn and
   * re-execute already-executed tool calls (duplicate sends/writes). The
   * status set is {400} (T0 spike leg d) AND a message discriminator is
   * required (400 is generic — a genuinely malformed request also 400s;
   * without the message gate real config faults would over-match into
   * self-heal). Tagged strings are the KPR-350 arm's food; everything else
   * keeps its status text for FAULT_PATTERNS. Network-level throws pass
   * through VERBATIM so ECONNREFUSED et al. reach the connect-fail row.
   */
  private describeCreateError(error: unknown, round: number, persistedHandle: string | undefined): Error {
    const status = extractStatus(error);
    const message = errorMessage(error);
    if (
      round === 1 &&
      persistedHandle &&
      status !== undefined &&
      STALE_HANDLE_STATUSES.has(status) &&
      STALE_HANDLE_MESSAGE.test(message)
    ) {
      return new Error(`${STALE_HANDLE_SENTINEL} (status ${status}): ${message}`);
    }
    if (status !== undefined) {
      return new Error(`Gemini interaction request failed (${status}): ${message}`);
    }
    return error instanceof Error ? error : new Error(message);
  }

  /** §D5: no suffix ⇒ no generation_config sent (model-default thinking —
   *  the effort-less-codex parallel). */
  private resolveThinkingLevel(): string | undefined {
    const effort = this.options.reasoningEffort;
    if (!effort) return undefined;
    const level = THINKING_LEVELS[effort];
    if (COERCED_EFFORTS.has(effort)) {
      const key = `${this.options.name}:${effort}`;
      if (!coercionWarned.has(key)) {
        coercionWarned.add(key);
        log.warn("Gemini :effort suffix coerced to nearest thinking_level (KPR-352 §D5)", {
          agent: this.options.name,
          effort,
          thinkingLevel: level,
        });
      }
    }
    return level;
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
      costUsd: 0, // no per-token billing wired — KPR-355 matrix caveat (Lane A precedent)
      durationMs,
      // §D8 (KPR-348 §D8 rule): the breaker's p95 window samples llmMs —
      // folding tool time in would let slow-but-healthy tools trip a healthy
      // gemini endpoint. Clamped for degenerate/mocked timing.
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

/**
 * Consume one round's Interactions SSE stream. Usage accumulates ONCE per
 * round from interaction.completed only — step.stop step_usage and event
 * metadata never accumulate (353's multi-count lesson, T8-pinned). Thought
 * summary/signature deltas are ignored: signatures are server-managed under
 * store:true chaining and never touch hive (§D1; T0 spike Delta 6).
 */
export async function consumeInteractionStream(
  stream: AsyncIterable<Record<string, unknown>>,
  onStream: ((chunk: string) => void) | undefined,
  isAborted: () => boolean = () => false,
): Promise<GeminiRoundState> {
  const state: GeminiRoundState = {
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    completedSteps: [],
    startedSteps: new Map(),
    argumentsByIndex: new Map(),
    sawCompleted: false,
  };
  for await (const event of stream) {
    if (isAborted()) break;
    applyInteractionEvent(event, state, onStream);
  }
  return state;
}

export function applyInteractionEvent(
  event: Record<string, unknown>,
  state: GeminiRoundState,
  onStream?: (chunk: string) => void,
): void {
  const type = stringField(event, "event_type");

  if (type === "step.delta") {
    const delta = objectField(event, "delta");
    const deltaType = stringField(delta, "type");
    if (deltaType === "text") {
      const text = stringField(delta, "text") ?? "";
      if (!text) return;
      state.text += text;
      onStream?.(text);
      return;
    }
    if (deltaType === "arguments_delta") {
      // T0 spike Delta 1: args stream as a JSON string on delta.arguments,
      // correlated to the step by the event-level index.
      const index = numberField(event, "index");
      if (index === undefined) return;
      state.argumentsByIndex.set(
        index,
        (state.argumentsByIndex.get(index) ?? "") + (stringField(delta, "arguments") ?? ""),
      );
    }
    return; // thought_summary / thought_signature / media deltas: ignored
  }

  if (type === "step.start") {
    const step = objectField(event, "step");
    const index = numberField(event, "index");
    if (step && index !== undefined) state.startedSteps.set(index, step);
    return;
  }

  if (type === "interaction.created" || type === "interaction.completed") {
    const interaction = objectField(event, "interaction");
    const id = stringField(interaction, "id");
    if (id) state.interactionId = id;
    if (type !== "interaction.completed") return;
    state.sawCompleted = true;
    // T0 spike Delta 5: usage keys verbatim — total_input_tokens /
    // total_output_tokens / total_cached_tokens (the other keys
    // total_tokens / input_tokens_by_modality / total_tool_use_tokens /
    // total_thought_tokens are not mapped into RunResult's fields).
    const usage = objectField(interaction, "usage");
    if (usage) {
      state.inputTokens += numberField(usage, "total_input_tokens") ?? 0;
      state.outputTokens += numberField(usage, "total_output_tokens") ?? 0;
      state.cacheReadTokens += numberField(usage, "total_cached_tokens") ?? 0;
    }
    // T0 spike Delta 1: the live completed envelope carries NO steps field —
    // this stays [] and the streaming reconstruction (startedSteps) is the
    // live harvest source. Kept for the dual-source contract.
    const steps = interaction?.["steps"];
    if (Array.isArray(steps)) state.completedSteps = steps;
    return;
  }

  if (type === "error") {
    const error = objectField(event, "error");
    throw new Error(
      stringField(error, "message") ?? stringField(error, "code") ?? "Gemini interaction stream reported an error",
    );
  }
  // interaction.status_update / step.stop: no adapter-visible state.
}

/**
 * §D1 dual-source harvest (KPR-353 spike-Delta-1 precedent): completed
 * interaction.steps are authoritative WHEN PRESENT (arguments arrive parsed) —
 * but T0 spike Delta 1 showed the live completed envelope has no steps field,
 * so on the real surface the step.start + accumulated arguments_delta
 * reconstruction is the live/authoritative source. Deduped by call id — the
 * two sources never double-execute.
 */
export function harvestFunctionCalls(state: GeminiRoundState): GeminiFunctionCall[] {
  const calls: GeminiFunctionCall[] = [];
  const seen = new Set<string>();

  const push = (id: string | undefined, name: string | undefined, args: unknown, argumentsError?: string): void => {
    if (!id || !name || seen.has(id)) return;
    seen.add(id);
    calls.push({ id, name, arguments: args, ...(argumentsError ? { argumentsError } : {}) });
  };

  for (const step of state.completedSteps) {
    if (!step || typeof step !== "object") continue;
    const record = step as Record<string, unknown>;
    if (record.type !== "function_call") continue;
    push(stringField(record, "id"), stringField(record, "name"), record.arguments ?? {});
  }

  for (const [index, step] of state.startedSteps) {
    if (step.type !== "function_call") continue;
    // T0 spike Delta 1: empty-param tools emit no arguments_delta — treat the
    // absent accumulation as {} (step.start's arguments is {} at start).
    const streamedArgs = state.argumentsByIndex.get(index);
    let args: unknown = step.arguments ?? {};
    let argumentsError: string | undefined;
    if (streamedArgs !== undefined && streamedArgs !== "") {
      try {
        args = JSON.parse(streamedArgs);
      } catch {
        argumentsError = "arguments were not valid JSON";
      }
    }
    push(stringField(step, "id"), stringField(step, "name"), args, argumentsError);
  }

  return calls;
}

/** §D1 loop-local containment (codex parity): unknown tool / bad streamed
 *  arguments become structured function_result text, never a throw. The
 *  bridge's own contract (KPR-348 §D3: execute NEVER throws) covers the rest —
 *  nothing in the dispatch loop escapes runTurn as a throw. */
async function executeFunctionCall(
  call: GeminiFunctionCall,
  bridgedByName: Map<string, BridgedTool>,
): Promise<string> {
  const bt = bridgedByName.get(call.name);
  if (!bt) return `Tool execution failed (${call.name}): unknown tool`;
  if (call.argumentsError) return `Tool execution failed (${call.name}): ${call.argumentsError}`;
  return bt.execute(call.arguments ?? {});
}

function extractStatus(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  return undefined;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
