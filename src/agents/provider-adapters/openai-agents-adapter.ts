import { Agent, OpenAIProvider, Runner, tool } from "@openai/agents";
import OpenAI from "openai";
import type { RunResult } from "../agent-runner.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest } from "./types.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import { ToolBridge, type BridgedTool } from "./tool-bridge.js";
import { envValue } from "./oauth-credentials.js";

export interface OpenAIAgentsAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  apiKey?: string;
}

interface OpenAIResultLike {
  finalOutput?: unknown;
  lastResponseId?: string;
}

interface OpenAIStreamResultLike extends OpenAIResultLike {
  completed: Promise<void>;
  toTextStream(options: { compatibleWithNodeStreams: true }): AsyncIterable<unknown>;
}

export class OpenAIAgentsAdapter implements AgentProviderAdapter {
  readonly provider = "openai" as const;

  private currentAbortController: AbortController | null = null;
  private aborted = false;

  constructor(private readonly options: OpenAIAgentsAdapterOptions) {}

  async runTurn(request: AgentProviderTurnRequest): Promise<RunResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.aborted = false;

    const streamed = !!request.onStream;
    const sessionId = request.sessionId ?? "";

    // KPR-348 (§D8): per-spawn tool bridge — construction-time ≡ turn-time
    // (per-spawn adapter). It gets the abort signal now (canon 5: mid-bridge
    // abort only); abort() and agent-manager are untouched.
    const bridge = new ToolBridge({
      inventory: this.options.assembly.toolInventory,
      inProcessServers: this.options.assembly.inProcessServers,
      gate: this.options.assembly.guardrailGate,
      workItemContext: request.workItemContext,
      signal: abortController.signal,
      agentId: this.options.name,
      sessionCwd: this.options.assembly.sessionCwd,
      skillIndex: this.options.assembly.skillIndex,
      delegateRunner: this.options.assembly.delegateTurnRunner, // KPR-354 (§D3)
    });

    try {
      // KPR-351 (R1): API-key single path — resolve the client BEFORE
      // connecting tool servers, so persistent misconfig fails in
      // microseconds. The throw is caught by this method's own catch and
      // lands in RunResult.error, where the auth row's existing
      // `api.?key is not available` alternate classifies it `auth` →
      // breaker → honest outage (gemini-identical posture, KPR-352 §D7).
      // The finally below still runs bridge.close() on this path.
      const client = this.buildClient();

      // KPR-348: connect() is fail-soft per server and never throws (§D7);
      // a fully-failed bridge yields [] and the turn runs tool-less.
      const bridged = await bridge.connect();
      const tools = bridged.map((bt) => bindTool(bt));
      const agent = new Agent({
        name: this.options.name,
        instructions: request.systemPromptOverride ?? this.options.assembly.instructions,
        model: this.options.model,
        // KPR-350 (§D2): chaining posture pinned, not defaulted. store:true is
        // the previous_response_id prerequisite (the codex surface hard-
        // enforces the opposite — the default-flip precedent is live);
        // truncation:"auto" is the Lane B compaction analog (server-side
        // context reconstruction on a long thread degrades by truncation
        // instead of 400). Nested KPR-354 delegate constructions share this
        // path deliberately (unreferenced 30d-self-expiring residue only).
        modelSettings: { store: true, truncation: "auto" },
        ...(tools.length > 0 ? { tools } : {}),
      });

      const runOptions = {
        maxTurns: request.resourceLimits?.maxTurns,
        signal: abortController.signal,
        previousResponseId: request.sessionId,
      };

      if (streamed) {
        const result = await this.runWithClient(client, agent, request.prompt, {
          ...runOptions,
          stream: true,
        });
        const text = await this.consumeTextStream(result, request.onStream);
        const durationMs = Date.now() - startedAt;
        return this.buildResult({
          text,
          sessionId: this.extractSessionId(result, sessionId),
          durationMs,
          streamed,
          aborted: false,
          toolStats: bridge.stats,
        });
      }

      const result = await this.runWithClient(client, agent, request.prompt, {
        ...runOptions,
        stream: false,
      });
      const durationMs = Date.now() - startedAt;
      return this.buildResult({
        text: coerceFinalOutput(result.finalOutput),
        sessionId: this.extractSessionId(result, sessionId),
        durationMs,
        streamed,
        aborted: false,
        toolStats: bridge.stats,
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
        toolStats: bridge.stats,
      });
    } finally {
      await bridge.close(); // never throws/rejects (advisory 1)
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

  private async runWithClient(
    client: OpenAI,
    agent: Agent,
    prompt: string,
    options: { stream: true; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIStreamResultLike>;
  private async runWithClient(
    client: OpenAI,
    agent: Agent,
    prompt: string,
    options: { stream: false; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIResultLike>;
  private async runWithClient(
    client: OpenAI,
    agent: Agent,
    prompt: string,
    options:
      | { stream: true; maxTurns?: number; signal: AbortSignal; previousResponseId?: string }
      | { stream: false; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIResultLike | OpenAIStreamResultLike> {
    const runner = new Runner({
      modelProvider: new OpenAIProvider({ openAIClient: client as never }),
    });
    return (await runner.run(agent, prompt, options as never)) as OpenAIResultLike | OpenAIStreamResultLike;
  }

  /**
   * KPR-351 (R1): API-key single path. The codex-oauth attempt is DELETED —
   * the KPR-348 spike proved the codex subscription token authenticates the
   * chatgpt.com backend only and 401s against api.openai.com Responses, so
   * the attempt could only burn one doomed network round-trip per turn and
   * kept a dead org-affinity hazard alive (KPR-350 §Edge). Mirrors the
   * KPR-352 §D7 Vertex deletion: surface-driven single-path auth.
   * `createCodexOpenAITokenProvider` survives in oauth-credentials.ts — the
   * codex adapter is its consumer. Revisit trigger: OpenAI ever serving
   * Responses under subscription auth is a NEW ticket, not a re-add here.
   */
  private buildClient(): OpenAI {
    const apiKey = this.options.apiKey ?? envValue("OPENAI_API_KEY");
    if (!apiKey) {
      // Message prefix shaped to the auth row's existing `api.?key is not
      // available` alternate (error-classification.ts FAULT_PATTERNS) — keep
      // "OpenAI API key is not available" verbatim so it classifies auth.
      // Remediation: the only working path today is seeding OPENAI_API_KEY in
      // the instance .env + a service restart (.env loads into process.env at
      // boot via dotenv; no Keychain leg exists for this key). `hive credentials add OPENAI_API_KEY`
      // hard-rejects — there is no CREDENTIAL_REGISTRY entry for this key and
      // no config.openai.apiKey resolution yet; registry/Keychain wiring is
      // future work (KPR-350 L0 leg seeds via .env).
      throw new Error(
        "OpenAI API key is not available; set OPENAI_API_KEY in the instance .env and restart — hive credentials add does not carry this key yet",
      );
    }
    return new OpenAI({ apiKey });
  }

  private async consumeTextStream(result: OpenAIStreamResultLike, onStream?: (chunk: string) => void): Promise<string> {
    let text = "";
    const stream = result.toTextStream({ compatibleWithNodeStreams: true });
    for await (const chunk of stream) {
      const coercedChunk = typeof chunk === "string" ? chunk : String(chunk);
      text += coercedChunk;
      onStream?.(coercedChunk);
    }
    await result.completed;
    return text;
  }

  private extractSessionId(result: OpenAIResultLike, fallback: string): string {
    return result.lastResponseId ?? fallback;
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
    error,
    toolStats,
  }: {
    text: string;
    sessionId: string;
    durationMs: number;
    streamed: boolean;
    aborted: boolean;
    error?: string;
    toolStats?: { toolCalls: number; toolMs: number; perTool: Map<string, number> };
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
      // §D8 + final-review advisory 2: llmMs excludes tool time (mirrors
      // agent-runner.ts:2089) — the breaker's p95 latency window samples
      // llmMs; folding tool time in would let slow-but-healthy tools trip a
      // healthy endpoint. Clamped: mocked/degenerate timing can't go negative.
      llmMs: Math.max(0, durationMs - toolMs),
      toolMs,
      toolCalls,
      toolSummary,
      streamed,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 0,
      compactions: 0,
      aborted,
      ...(error ? { error } : {}),
    };
  }
}

/**
 * Bind a provider-neutral BridgedTool to the Agents SDK tool() shape
 * (SPIKE S4/S5): JSON schema passed as parameters with strict:false — the
 * bridge already normalized the schema. errorFunction is belt-and-suspenders
 * (§D3): even an SDK-internal invocation fault becomes model-visible text,
 * not a run-loop rejection.
 */
function bindTool(bt: BridgedTool) {
  return tool({
    name: bt.name,
    description: bt.description,
    parameters: bt.inputSchema as never, // normalized JSON schema, non-strict (spike S4)
    strict: false,
    execute: (input: unknown) => bt.execute(input),
    errorFunction: (_ctx: unknown, err: unknown) =>
      `Tool execution failed (${bt.name}): ${err instanceof Error ? err.message : String(err)}`,
  } as never);
}

export function coerceFinalOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return coerceFinalOutput(error);
}
