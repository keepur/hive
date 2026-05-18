import { Agent, run } from "@openai/agents";
import type { RunResult } from "../agent-runner.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest } from "./types.js";
import type { HiveToolTransportDescriptor } from "./tool-transport.js";

export interface OpenAIAgentsAdapterOptions {
  name: string;
  instructions: string;
  model?: string;
  toolInventory?: HiveToolTransportDescriptor[];
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
    this.assertToolFreePilot();

    const startedAt = Date.now();
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.aborted = false;

    const streamed = !!request.onStream;
    const sessionId = request.sessionId ?? "";

    try {
      const agent = new Agent({
        name: this.options.name,
        instructions: request.systemPromptOverride ?? this.options.instructions,
        model: this.options.model,
      });

      const runOptions = {
        maxTurns: request.resourceLimits?.maxTurns,
        signal: abortController.signal,
        previousResponseId: request.sessionId,
      };

      if (streamed) {
        const result = await run(agent, request.prompt, {
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

      const result = await run(agent, request.prompt, {
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

  private assertToolFreePilot(): void {
    const unsupported = this.options.toolInventory?.find((entry) => entry.compatibility.openai !== "claude-only");
    if (unsupported) {
      throw new Error(`OpenAI tool bridge is not implemented in KPR-233: ${unsupported.name}`);
    }
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
