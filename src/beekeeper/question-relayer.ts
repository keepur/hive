import type { HookInput, HookJSONOutput, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { ServerMessage } from "./types.js";

const log = createLogger("beekeeper-question-relayer");

/**
 * Non-blocking question relay for beekeeper sessions.
 *
 * When the SDK calls AskUserQuestion, this hook:
 * 1. Formats the question as plain text
 * 2. Sends it to the client as a regular chat message
 * 3. Immediately blocks the tool with a reason explaining the question was relayed
 *
 * The model sees the block reason, the turn completes normally (status → idle),
 * and the user's reply arrives as the next message in the conversation.
 * No blocking, no pending state, no timeouts.
 */
export class QuestionRelayer {
  private sendDelegate: ((msg: ServerMessage) => void) | null = null;

  setSendDelegate(send: (msg: ServerMessage) => void): void {
    this.sendDelegate = send;
  }

  /**
   * Returns the hook callback for SDK PreToolUse registration.
   * Each callback is scoped to a specific session.
   */
  createHookCallback(sessionId: string): HookCallback {
    return async (
      input: HookInput,
      _toolUseId: string | undefined,
      _options: { signal: AbortSignal },
    ): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== "PreToolUse") {
        return { decision: "approve" };
      }
      if (input.tool_name !== "AskUserQuestion") {
        return { decision: "approve" };
      }

      log.info("Intercepting AskUserQuestion", { toolUseId: input.tool_use_id, sessionId });

      if (!this.sendDelegate) {
        log.warn("No send delegate, blocking AskUserQuestion", { toolUseId: input.tool_use_id });
        return { decision: "block", reason: "No client connected to relay question" };
      }

      // Format questions as plain text
      const toolInput = input.tool_input as {
        questions?: Array<{
          question: string;
          multiSelect?: boolean;
          options?: Array<{ label: string; description?: string }>;
        }>;
      };
      const questions = toolInput?.questions ?? [];

      const lines: string[] = [];
      for (const q of questions) {
        lines.push(q.multiSelect ? `${q.question} (select multiple)` : q.question);
        if (q.options) {
          lines.push("");
          q.options.forEach((opt, i) => {
            const desc = opt.description ? ` — ${opt.description}` : "";
            lines.push(`${i + 1}. ${opt.label}${desc}`);
          });
        }
      }

      const text = lines.join("\n");
      this.sendDelegate({
        type: "message",
        text,
        sessionId,
        final: true,
      });

      log.info("Question relayed to client", { toolUseId: input.tool_use_id, sessionId });
      return {
        decision: "block",
        reason:
          "Question relayed to user as a chat message. Their answer will arrive as the next message in this conversation. Do NOT re-ask the question — just wait for the user's reply.",
      };
    };
  }
}
