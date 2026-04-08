import type Anthropic from "@anthropic-ai/sdk";

// ── OpenAI types (inbound from Vapi) ───────────────────────────────────

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAIToolDef[];
  metadata?: Record<string, unknown>;
  // Vapi includes call/assistant metadata in the request body
  call?: { id?: string; metadata?: Record<string, unknown> };
  assistant?: { id?: string; metadata?: Record<string, unknown> };
}

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// ── Translation: OpenAI messages → Claude messages ─────────────────────

/**
 * Translate OpenAI-format messages to Claude API format.
 * Returns { system, messages } for the Claude API call.
 */
export function openaiToClaude(
  openaiMessages: OpenAIMessage[],
  systemPrompt: string,
): {
  system: string;
  messages: Anthropic.MessageCreateParams["messages"];
} {
  const messages: Anthropic.MessageCreateParams["messages"] = [];

  for (const msg of openaiMessages) {
    if (msg.role === "system") {
      // System messages are merged into the system prompt (Vapi may send them)
      continue;
    }

    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content ?? "" });
    } else if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant with tool calls → Claude tool_use blocks
        const content: Array<{ type: string; [key: string]: unknown }> = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || "{}"),
          });
        }
        messages.push({ role: "assistant", content } as unknown as Anthropic.MessageCreateParams["messages"][number]);
      } else {
        messages.push({ role: "assistant", content: msg.content ?? "" });
      }
    } else if (msg.role === "tool") {
      // Tool result → Claude tool_result block
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: msg.content ?? "",
          },
        ],
      } as unknown as Anthropic.MessageCreateParams["messages"][number]);
    }
  }

  // Claude requires alternating user/assistant. If first message isn't user, prepend one.
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: "[Call connected]" });
  }

  return { system: systemPrompt, messages };
}

// ── Translation: Claude tools → OpenAI tool definitions ────────────────

/**
 * Translate OpenAI tool definitions to Claude format.
 * Used when Vapi passes tool definitions in the request.
 */
export function openaiToolsToClaude(tools: OpenAIToolDef[] | undefined): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));
}

// ── SSE streaming: Claude response → OpenAI format ─────────────────────

/**
 * Format a text chunk as an OpenAI SSE data line.
 */
export function formatSSETextChunk(id: string, text: string, model: string): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Format a tool call chunk as an OpenAI SSE data line.
 */
export function formatSSEToolCallChunk(
  id: string,
  toolCallId: string,
  functionName: string,
  args: string,
  model: string,
): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: functionName, arguments: args },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Format the final SSE done chunk.
 */
export function formatSSEDone(id: string, model: string, finishReason: string = "stop"): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/**
 * Format a non-streaming response (fallback).
 */
export function formatNonStreamingResponse(id: string, text: string, model: string): Record<string, unknown> {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  };
}
