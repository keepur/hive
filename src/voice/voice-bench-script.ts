/**
 * KPR-465 §6.1: the fixed 10-turn caller script and the pure pieces of the
 * engine bench (request shape = the worker's, SSE parse = the adapter's).
 * No personal data, no config import, no network. Content-free outputs.
 */
import type { VoiceTraceMetadata } from "./voice-trace.js";
import type { BenchResultRow } from "./voice-latency-compare.js";

export const BENCH_SCRIPT_VERSION = "kpr-465-v1";

export type BenchTurnKind = "greeting" | "factual" | "recall" | "lookup" | "long" | "goodbye";

export interface BenchTurn {
  index: number; // 1-based
  kind: BenchTurnKind;
  text: string;
  /** Expected answer: keyword set (case-insensitive substring, ANY match), recall source turn, tool requirement. */
  expect: { keywords?: string[]; recallOf?: number; tool?: true } | null;
  /** V4 barge-in point: close the response mid-sentence, or during the tool wait. */
  bargeIn?: "mid-sentence" | "during-tool-wait";
}

export const BENCH_SCRIPT: readonly BenchTurn[] = [
  { index: 1, kind: "greeting", text: "Hello?", expect: null },
  { index: 2, kind: "factual", text: "Quick one: how many days are in a leap year?", expect: { keywords: ["366"] } },
  { index: 3, kind: "factual", text: "And what is the capital city of Japan?", expect: { keywords: ["tokyo"] } },
  {
    index: 4,
    kind: "factual",
    text: "How many minutes are there in three hours?",
    expect: { keywords: ["180", "one hundred eighty", "one hundred and eighty"] },
  },
  {
    index: 5,
    kind: "long",
    text: "Tell me, in a few sentences, why a leap year exists at all — walk me through the calendar drift and how the extra day fixes it.",
    expect: { keywords: ["365", "orbit", "drift", "february", "four"] },
    bargeIn: "mid-sentence",
  },
  {
    index: 6,
    kind: "recall",
    text: "What was the number you gave me a moment ago for the leap year?",
    expect: { recallOf: 2, keywords: ["366"] },
  },
  {
    index: 7,
    kind: "lookup",
    text: "Please search our past conversations for the exact phrase bench marker and tell me how many results you find.",
    expect: { tool: true, keywords: ["result", "found", "none", "nothing", "zero", "0"] },
    bargeIn: "during-tool-wait",
  },
  {
    index: 8,
    kind: "lookup",
    text: "Try that search once more for the phrase bench marker and just give me the count.",
    expect: { tool: true, keywords: ["result", "found", "none", "nothing", "zero", "0"] },
  },
  {
    index: 9,
    kind: "factual",
    text: "Last one: how many sides does a hexagon have?",
    expect: { keywords: ["six", "6"] },
  },
  {
    index: 10,
    kind: "goodbye",
    text: "That's all I needed, thanks — goodbye.",
    expect: { keywords: ["bye", "goodbye", "take care", "talk", "later"] },
  },
];

export interface BridgeRequestInput {
  callId: string;
  agentId: string;
  goal: string;
  context: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  workerBootId: string;
  turnId: string;
}

/** Byte-for-byte the shape src/voice-worker/hive-llm.ts posts (KPR-464 trace metadata included). */
export function buildBridgeRequest(input: BridgeRequestInput): Record<string, unknown> {
  const voiceTrace: VoiceTraceMetadata = { schemaVersion: 2, workerBootId: input.workerBootId, turnId: input.turnId };
  return {
    stream: true,
    messages: input.messages,
    call: { id: input.callId, metadata: { hive_agent_id: input.agentId, goal: input.goal, context: input.context } },
    metadata: { voiceTrace },
  };
}

export type SseEvent = { type: "text"; text: string } | { type: "done"; finishReason: string | null } | { type: "end" };

/** Incremental parser over the adapter's `data: {...}\n\n` / `data: [DONE]\n\n` framing (openai-translator.ts). */
export class SseChunkParser {
  private buffer = "";
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") {
          events.push({ type: "end" });
          continue;
        }
        let parsed: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (typeof choice.delta?.content === "string" && choice.delta.content.length > 0) {
          events.push({ type: "text", text: choice.delta.content });
        }
        if (choice.finish_reason) events.push({ type: "done", finishReason: choice.finish_reason });
      }
    }
    return events;
  }
}

export interface TurnAssertion {
  expectsTool: boolean;
  keywordPass: boolean | null;
}

/** Keyword check on the (in-memory only) answer; never returns or stores the text. */
export function assertTurn(turn: BenchTurn, answerText: string): TurnAssertion {
  const expectsTool = turn.expect?.tool === true;
  const keywords = turn.expect?.keywords;
  if (!keywords || keywords.length === 0) return { expectsTool, keywordPass: null };
  const haystack = answerText.toLowerCase();
  return { expectsTool, keywordPass: keywords.some((k) => haystack.includes(k.toLowerCase())) };
}

export type { BenchResultRow };

export function benchResultRow(input: {
  callId: string;
  arm: string;
  turn: BenchTurn;
  turnId: string;
  assertion: TurnAssertion;
  clientFirstTextMs: number | null;
  clientTotalMs: number;
  textLength: number;
  status: number | null;
  finish: "stop" | "error" | "closed" | "none";
  drill?: string;
}): BenchResultRow & {
  kind: BenchTurnKind;
  clientTotalMs: number;
  finish: string;
  bargeIn: boolean;
  drill?: string;
  script: string;
} {
  return {
    callId: input.callId,
    arm: input.arm,
    turnIndex: input.turn.index,
    turnId: input.turnId,
    expectsTool: input.assertion.expectsTool,
    keywordPass: input.assertion.keywordPass,
    clientFirstTextMs: input.clientFirstTextMs,
    textLength: input.textLength,
    status: input.status,
    kind: input.turn.kind,
    clientTotalMs: input.clientTotalMs,
    finish: input.finish,
    bargeIn: input.turn.bargeIn !== undefined,
    ...(input.drill ? { drill: input.drill } : {}),
    script: BENCH_SCRIPT_VERSION,
  };
}
