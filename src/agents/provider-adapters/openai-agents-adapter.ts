import { Agent, OpenAIProvider, Runner, run } from "@openai/agents";
import OpenAI from "openai";
import type { RunResult } from "../agent-runner.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest } from "./types.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import { createCodexOpenAITokenProvider, envValue, isProviderAuthError } from "./oauth-credentials.js";

export interface OpenAIAgentsAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  apiKey?: string;
  preferOAuth?: boolean;
  codexAuthPath?: string;
  codexRefreshCommand?: string;
}

interface OpenAIResultLike {
  finalOutput?: unknown;
  lastResponseId?: string;
}

interface OpenAIStreamResultLike extends OpenAIResultLike {
  completed: Promise<void>;
  toTextStream(options: { compatibleWithNodeStreams: true }): AsyncIterable<unknown>;
}

interface OpenAIAuthAttempt {
  source: "codex-oauth" | "api-key";
  client: OpenAI;
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

    try {
      // KPR-347: assembly.toolInventory is carried but deliberately NOT
      // advertised — an Agent with a tools param but no executor invites
      // tool calls nothing handles. KPR-348 flips this (no `tools` key here
      // until then).
      const agent = new Agent({
        name: this.options.name,
        instructions: request.systemPromptOverride ?? this.options.assembly.instructions,
        model: this.options.model,
      });

      const runOptions = {
        maxTurns: request.resourceLimits?.maxTurns,
        signal: abortController.signal,
        previousResponseId: request.sessionId,
      };

      if (streamed) {
        const result = await this.runWithAuthFallback(agent, request.prompt, {
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
        });
      }

      const result = await this.runWithAuthFallback(agent, request.prompt, {
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
        });
      }

      return this.buildResult({
        text: "",
        sessionId,
        durationMs,
        streamed,
        aborted: false,
        error: errorMessage(error),
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

  private async runWithAuthFallback(
    agent: Agent,
    prompt: string,
    options: { stream: true; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIStreamResultLike>;
  private async runWithAuthFallback(
    agent: Agent,
    prompt: string,
    options: { stream: false; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIResultLike>;
  private async runWithAuthFallback(
    agent: Agent,
    prompt: string,
    options:
      | { stream: true; maxTurns?: number; signal: AbortSignal; previousResponseId?: string }
      | { stream: false; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIResultLike | OpenAIStreamResultLike> {
    const attempts = this.buildAuthAttempts();
    if (attempts.length === 0) {
      return run(agent, prompt, options as never) as Promise<OpenAIResultLike | OpenAIStreamResultLike>;
    }

    let lastError: unknown;
    for (const [index, attempt] of attempts.entries()) {
      try {
        const runner = new Runner({
          modelProvider: new OpenAIProvider({ openAIClient: attempt.client as never }),
        });
        return (await runner.run(agent, prompt, options as never)) as OpenAIResultLike | OpenAIStreamResultLike;
      } catch (error) {
        lastError = error;
        if (index === attempts.length - 1 || !isProviderAuthError(error)) throw error;
      }
    }

    throw lastError;
  }

  private buildAuthAttempts(): OpenAIAuthAttempt[] {
    const attempts: OpenAIAuthAttempt[] = [];

    if (this.options.preferOAuth !== false) {
      const tokenProvider = createCodexOpenAITokenProvider({
        authPath: this.options.codexAuthPath,
        refreshCommand: this.options.codexRefreshCommand,
      });
      if (tokenProvider) {
        attempts.push({
          source: "codex-oauth",
          client: new OpenAI({ apiKey: tokenProvider }),
        });
      }
    }

    const apiKey = this.options.apiKey ?? envValue("OPENAI_API_KEY");
    if (apiKey) {
      attempts.push({
        source: "api-key",
        client: new OpenAI({ apiKey }),
      });
    }

    return attempts;
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
  }: {
    text: string;
    sessionId: string;
    durationMs: number;
    streamed: boolean;
    aborted: boolean;
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
