// src/channels/voice/conversation-prompt.ts
import type { OpenAIChatRequest } from "./openai-translator.js";

/**
 * Render Vapi's OpenAI-format messages array into a single user prompt
 * suitable for `query()`. The system message is dropped (delivered via
 * the `systemPrompt` option). Tool messages are skipped (Phase-2 concern).
 *
 * Format chosen for readability by the Claude side: a transcript with
 * speaker labels, ending with an explicit instruction to respond to the
 * latest caller turn. Vapi sends the full history on every turn, so we
 * render it all every time and skip SDK session resume — keeps state
 * machine simple at the cost of a few extra cache-creation tokens per
 * turn (negligible for short voice calls).
 */
export function renderConversationPrompt(messages: OpenAIChatRequest["messages"]): string {
  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const speaker = m.role === "user" ? "Caller" : "You";
      const content = typeof m.content === "string" ? m.content : "";
      return `${speaker}: ${content}`;
    });

  if (turns.length === 0) {
    // Edge case: Vapi calls /v1/chat/completions with only the system message
    // (e.g., at call start when "Assistant speaks first"). Just prompt the
    // agent to begin.
    return "The caller has just connected. Greet them as the agent.";
  }

  return [
    "The phone call so far (transcribed live):",
    "",
    ...turns,
    "",
    "Respond to the caller's most recent message above. Keep it conversational and short — you are speaking, not writing.",
  ].join("\n");
}

/**
 * Pull the latest user message off Vapi's history. Used on turn-2+ when the
 * SDK session is being resumed — the prior turns are already in the SDK's
 * session memory, so we only send the new user input.
 *
 * Returns empty string if no user message is present (caller decides what to
 * do; in practice voice-adapter falls back to turn-1 framing in that case).
 */
export function extractLatestUserMessage(messages: OpenAIChatRequest["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      return typeof m.content === "string" ? m.content : "";
    }
  }
  return "";
}
