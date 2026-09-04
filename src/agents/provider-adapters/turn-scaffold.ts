/**
 * KPR-391 (§4.1): LaneBTurnScaffold — the shared per-turn lifecycle every
 * Lane B native adapter sits on. Owns everything an adapter does that is NOT
 * provider API shape: abort lifecycle, the wall-clock deadline (#407 — armed
 * inside the try, cleared in the finally, operator-abort-outranks-deadline
 * resolution), ToolBridge construct/close, the try/catch/finally containment
 * frame, the scaffold-owned turn accumulator (one-writer: provider round code
 * reports usage via harness.addUsage, nothing else mutates it), and RunResult
 * building (llmMs = max(0, durationMs − toolMs) — KPR-348 §D8 breaker rule).
 *
 * Provider subclasses implement executeTurn(harness) — auth resolution,
 * bridge.connect(), dispatch — and return a LaneBTurnOutcome. Nothing they
 * throw escapes runTurn. Divergence points are explicit hooks, never
 * unification targets (§7 three-way sessionId pin):
 *   - fallbackSessionId(): default `request.sessionId ?? ""` (gemini/openai
 *     no-fabrication pins); codex fabricates `codex-pilot-${uuid}`.
 *   - interruptionSessionId(): aborted/error_max_turns policy — default bare
 *     fallback; codex overrides to `lastProviderRoundId ?? fallback`.
 *     Deadline and catch-error paths always use the bare fallback (uniform
 *     across all three adapters today).
 *   - warnDeadlineExpired(): per-adapter so log module + message stay
 *     byte-identical.
 *   - errorText(): default codex/gemini shape; openai overrides
 *     (coerceFinalOutput — preserves its thrown-null edge).
 */
import type { RunResult } from "../agent-runner.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest } from "./types.js";
import { ToolBridge } from "./tool-bridge.js";
import { TURN_DEADLINE_SUBTYPE } from "./error-classification.js";
import { appendDateTimeTrailer } from "../prefix-builder.js";

/** Scaffold-owned turn accumulator (§4.1). */
export interface LaneBTurnTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface LaneBUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/**
 * What executeTurn (or the dispatch loop inside it) hands back.
 * error_max_turns and friends are OUTCOME errors, not throws — accumulated
 * totals and bridge stats survive into the result (§4.1).
 */
export type LaneBTurnOutcome =
  | { kind: "success"; text: string; sessionId: string }
  | { kind: "error"; error: string; sessionId: string }
  /** Resolved by the scaffold's #407 interruption resolver:
   *  deadlineFired && !aborted ⇒ deadline result, else aborted result. */
  | { kind: "interrupted" };

/** Session-policy hook input. */
export interface LaneBSessionPolicyState {
  fallbackSessionId: string;
  lastProviderRoundId: string | undefined;
}

export interface LaneBTurnHarness {
  request: AgentProviderTurnRequest;
  bridge: ToolBridge;
  signal: AbortSignal;
  streamed: boolean;
  fallbackSessionId: string;
  /** aborted || signal.aborted — subsumes #407's deadline-aware
   *  stream-consumer callbacks. */
  isAborted(): boolean;
  deadlineFired(): boolean;
  totals: Readonly<LaneBTurnTotals>;
  /** One-writer fold point (§4.1): provider round code reports usage here. */
  addUsage(delta: LaneBUsageDelta): void;
  setLastProviderRoundId(id: string): void;
  lastProviderRoundId(): string | undefined;
  /** Interruption/max-turns session policy (per-provider hook output). */
  interruptionSessionId(): string;
}

export abstract class LaneBTurnScaffold implements AgentProviderAdapter {
  abstract readonly provider: string;

  protected currentAbortController: AbortController | null = null;
  protected aborted = false;

  protected constructor(
    private readonly scaffoldInit: { name: string; assembly: ProviderTurnAssembly },
  ) {}

  abort(): void {
    this.aborted = true;
    this.currentAbortController?.abort();
  }

  get wasAborted(): boolean {
    return this.aborted;
  }

  /** Provider API surface. Runs inside the containment frame: return an
   *  outcome or throw — a throw becomes the catch-error result (or an
   *  interruption when isAbortError matches). */
  protected abstract executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome>;

  /** #407 deadline warn — per-adapter (message + logger module preserved). */
  protected abstract warnDeadlineExpired(timeoutMs: number): void;

  /** Fallback-session policy hook (§4.1). */
  protected fallbackSessionId(request: AgentProviderTurnRequest): string {
    return request.sessionId ?? "";
  }

  /** Aborted / error_max_turns session policy (§7 last bullet). */
  protected interruptionSessionId(state: LaneBSessionPolicyState): string {
    return state.fallbackSessionId;
  }

  /** Catch-error stringification. Default = the codex/gemini errorMessage
   *  shape; openai overrides. */
  protected errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  }

  async runTurn(incoming: AgentProviderTurnRequest): Promise<RunResult> {
    // KPR-432: FIRST statement — before the ToolBridge is constructed (closed
    // only in the finally below), so nothing is armed if this ever threw.
    // Primary assemblies carry the datetime as the last line of the turn
    // input; nested delegate assemblies (Claude parity) and flag-less
    // plugin-built assemblies pass the prompt through byte-identical.
    const request: AgentProviderTurnRequest = this.scaffoldInit.assembly.datetimeInTurnInput
      ? { ...incoming, prompt: appendDateTimeTrailer(incoming.prompt) }
      : incoming;
    const startedAt = Date.now();
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.aborted = false;

    const streamed = !!request.onStream;
    const fallbackSessionId = this.fallbackSessionId(request);

    // Wall-clock turn deadline (#407, scaffold-owned): armed inside the try
    // (throw-safety pin), cleared in the finally (no-late-warn pin).
    // undefined ⇒ no deadline (bare/test constructions — prepareSpawn always
    // supplies one on Lane B); 0 fires immediately but may still dispatch one
    // round before aborting (timer = macrotask — distinct from maxTurns 0's
    // zero-call short-circuit).
    const timeoutMs = request.resourceLimits?.timeoutMs;
    let deadlineFired = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    // Per-spawn tool bridge — the pre-extraction 11-line identical block,
    // including the KPR-354 delegateRunner line. connect() is provider code
    // (inside executeTurn); close() in the finally, always, including
    // pre-request throw paths (gemini T10 pin).
    const bridge = new ToolBridge({
      inventory: this.scaffoldInit.assembly.toolInventory,
      inProcessServers: this.scaffoldInit.assembly.inProcessServers,
      gate: this.scaffoldInit.assembly.guardrailGate,
      workItemContext: request.workItemContext,
      signal: abortController.signal,
      agentId: this.scaffoldInit.name,
      sessionCwd: this.scaffoldInit.assembly.sessionCwd,
      skillIndex: this.scaffoldInit.assembly.skillIndex,
      delegateRunner: this.scaffoldInit.assembly.delegateTurnRunner, // KPR-354
    });

    const totals: LaneBTurnTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let lastProviderRoundId: string | undefined;

    const policyState = (): LaneBSessionPolicyState => ({ fallbackSessionId, lastProviderRoundId });

    const finish = (fields: {
      text: string;
      sessionId: string;
      aborted: boolean;
      timedOut?: boolean;
      error?: string;
    }): RunResult =>
      this.buildResult({
        ...fields,
        durationMs: Date.now() - startedAt,
        streamed,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        toolStats: bridge.stats,
      });

    const abortedResult = (): RunResult =>
      finish({ text: "", sessionId: this.interruptionSessionId(policyState()), aborted: true });

    /** Deadline expiry is a turn-shape ERROR, not an abort (#407): `aborted`
     *  stays false so classifyTurnResult's `timedOut && aborted` hang rule
     *  can never match, and TURN_DEADLINE_SUBTYPE classifies as the
     *  breaker-INCONCLUSIVE turn-deadline kind. sessionId mirrors each
     *  adapter's catch-error shape — bare fallback, never a mid-turn mint. */
    const deadlineResult = (): RunResult =>
      finish({
        text: "",
        sessionId: fallbackSessionId,
        aborted: false,
        timedOut: true,
        error: TURN_DEADLINE_SUBTYPE,
      });

    /** #407 interruption resolver — single resolution point for every abort
     *  checkpoint: an operator abort() outranks a deadline that also fired
     *  (breaker-neutral silence, not an error surface). */
    const interruptedResult = (): RunResult =>
      deadlineFired && !this.aborted ? deadlineResult() : abortedResult();

    const harness: LaneBTurnHarness = {
      request,
      bridge,
      signal: abortController.signal,
      streamed,
      fallbackSessionId,
      isAborted: () => this.aborted || abortController.signal.aborted,
      deadlineFired: () => deadlineFired,
      totals,
      addUsage: (delta) => {
        totals.inputTokens += delta.inputTokens ?? 0;
        totals.outputTokens += delta.outputTokens ?? 0;
        totals.cacheReadTokens += delta.cacheReadTokens ?? 0;
      },
      setLastProviderRoundId: (id) => {
        lastProviderRoundId = id;
      },
      lastProviderRoundId: () => lastProviderRoundId,
      interruptionSessionId: () => this.interruptionSessionId(policyState()),
    };

    try {
      if (timeoutMs !== undefined) {
        deadline = setTimeout(() => {
          deadlineFired = true;
          this.warnDeadlineExpired(timeoutMs);
          abortController.abort();
        }, timeoutMs);
      }

      const outcome = await this.executeTurn(harness);
      if (outcome.kind === "interrupted") return interruptedResult();
      if (outcome.kind === "error") {
        return finish({
          text: "",
          sessionId: outcome.sessionId,
          aborted: false,
          error: outcome.error,
        });
      }
      return finish({ text: outcome.text, sessionId: outcome.sessionId, aborted: false });
    } catch (error) {
      // A deadline abort usually surfaces here as the aborted fetch/SDK/
      // stream throw — interruptedResult resolves it to the deadline error,
      // not an operator abort.
      if (this.isAbortError(error, abortController)) return interruptedResult();
      return finish({
        text: "",
        sessionId: fallbackSessionId,
        aborted: false,
        error: this.errorText(error),
      });
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      await bridge.close(); // never throws/rejects (KPR-348 advisory 1)
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
    }
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
    timedOut,
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
    timedOut?: boolean;
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
      // KPR-348 §D8 rule: the breaker's p95 window samples llmMs — folding
      // tool time in would let slow-but-healthy tools trip a healthy
      // provider. Clamped: degenerate/mocked timing can't go negative.
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
      ...(timedOut ? { timedOut: true } : {}),
      ...(error ? { error } : {}),
    };
  }
}
