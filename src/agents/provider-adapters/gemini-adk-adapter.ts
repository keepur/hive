import {
  EventType,
  InMemoryRunner,
  LlmAgent,
  isFinalResponse,
  stringifyContent,
  toStructuredEvents,
} from "@google/adk";
import type { Event, StructuredEvent } from "@google/adk";
import { randomUUID } from "node:crypto";
import type { RunResult } from "../agent-runner.js";
import type { AgentProviderAdapter, AgentProviderTurnRequest } from "./types.js";
import type { HiveToolTransportDescriptor } from "./tool-transport.js";

export interface GeminiAdkAdapterOptions {
  name: string;
  instructions: string;
  model?: string;
  toolInventory?: HiveToolTransportDescriptor[];
  appName?: string;
  userId?: string;
}

interface GeminiRunAccumulator {
  text: string;
  error?: string;
}

export class GeminiAdkAdapter implements AgentProviderAdapter {
  readonly provider = "gemini" as const;

  private aborted = false;

  constructor(private readonly options: GeminiAdkAdapterOptions) {}

  async runTurn(request: AgentProviderTurnRequest): Promise<RunResult> {
    this.assertToolFreePilot();

    const startedAt = Date.now();
    this.aborted = false;

    const streamed = !!request.onStream;
    const sessionId = request.sessionId ?? `gemini-pilot-${randomUUID()}`;

    try {
      const agent = new LlmAgent({
        name: sanitizeAgentName(this.options.name),
        instruction: request.systemPromptOverride ?? this.options.instructions,
        model: this.options.model,
        tools: [],
      });
      const runner = new InMemoryRunner({
        agent,
        appName: this.options.appName ?? "hive-gemini-pilot",
      });

      const events = runner.runEphemeral({
        userId: this.options.userId ?? "hive-gemini-pilot-user",
        newMessage: {
          role: "user",
          parts: [{ text: request.prompt }],
        },
        runConfig: {
          maxLlmCalls: request.resourceLimits?.maxTurns,
        },
      });

      const accumulated = await this.consumeEvents(events, request.onStream);
      const durationMs = Date.now() - startedAt;

      if (this.aborted) {
        return this.buildResult({
          text: "",
          sessionId,
          durationMs,
          streamed,
          aborted: true,
        });
      }

      if (accumulated.error) {
        return this.buildResult({
          text: accumulated.text,
          sessionId,
          durationMs,
          streamed,
          aborted: false,
          error: accumulated.error,
        });
      }

      return this.buildResult({
        text: accumulated.text,
        sessionId,
        durationMs,
        streamed,
        aborted: false,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (this.aborted) {
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
    }
  }

  abort(): void {
    this.aborted = true;
  }

  get wasAborted(): boolean {
    return this.aborted;
  }

  private assertToolFreePilot(): void {
    const unsupported = this.options.toolInventory?.find((entry) => entry.compatibility.gemini !== "claude-only");
    if (unsupported) {
      throw new Error(`Gemini ADK tool bridge is not implemented in KPR-234: ${unsupported.name}`);
    }
  }

  private async consumeEvents(
    events: AsyncIterable<Event>,
    onStream?: (chunk: string) => void,
  ): Promise<GeminiRunAccumulator> {
    const accumulator: GeminiRunAccumulator = { text: "" };

    for await (const event of events) {
      if (this.aborted) break;

      const extracted = extractTextChunks(event);
      if (extracted.error) {
        accumulator.error = extracted.error;
      }

      for (const chunk of extracted.chunks) {
        const delta = appendText(accumulator.text, chunk);
        if (!delta) continue;
        accumulator.text += delta;
        onStream?.(delta);
      }
    }

    return accumulator;
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

export function extractTextChunks(event: Event): { chunks: string[]; error?: string } {
  const chunks: string[] = [];
  let error: string | undefined;

  if (event.errorMessage) {
    error = event.errorMessage;
  }

  for (const structured of toStructuredEvents(event)) {
    const fromStructured = textFromStructuredEvent(structured);
    if (fromStructured) chunks.push(fromStructured);
    if (structured.type === EventType.ERROR) {
      error = errorMessage(structured.error);
    }
  }

  if (isFinalResponse(event)) {
    const finalText = stringifyContent(event);
    if (finalText) chunks.push(finalText);
  }

  const rawText = textFromContent(event.content);
  if (rawText) chunks.push(rawText);

  return { chunks: uniqueNonEmpty(chunks), ...(error ? { error } : {}) };
}

export function coerceGeminiOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function textFromStructuredEvent(event: StructuredEvent): string {
  switch (event.type) {
    case EventType.CONTENT:
    case EventType.THOUGHT:
      return event.content;
    case EventType.FINISHED:
      return coerceGeminiOutput(event.output);
    default:
      return "";
  }
}

function textFromContent(content: Event["content"]): string {
  return (
    content?.parts
      ?.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("") ?? ""
  );
}

function appendText(existing: string, next: string): string {
  if (!next) return "";
  if (existing === next || existing.endsWith(next)) return "";
  if (next.startsWith(existing)) return next.slice(existing.length);
  return next;
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function sanitizeAgentName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^[^A-Za-z_$]+/, "");
  return sanitized || "gemini_pilot";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return coerceGeminiOutput(error);
}
