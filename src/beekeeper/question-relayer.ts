import type { HookInput, HookJSONOutput, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { ServerMessage } from "./types.js";

const log = createLogger("beekeeper-question-relayer");

interface PendingQuestion {
  resolve: (decision: HookJSONOutput) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  toolUseId: string;
}

export class QuestionRelayer {
  private pendingQuestions = new Map<string, PendingQuestion>();
  private sendDelegate: ((msg: ServerMessage) => void) | null = null;

  /**
   * Set the send delegate. Routes through SessionManager.send() which
   * broadcasts to all connected clients or buffers when none are connected.
   * Set once at startup — same pattern as ToolGuardian.
   */
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

      // Supersede any existing pending question for this session
      const existing = this.pendingQuestions.get(sessionId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.resolve({ decision: "block", reason: "Superseded by new question" });
        this.pendingQuestions.delete(sessionId);
        log.info("Superseded existing pending question", {
          sessionId,
          oldToolUseId: existing.toolUseId,
        });
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          log.warn("Question timed out", { toolUseId: input.tool_use_id, sessionId });
          this.pendingQuestions.delete(sessionId);
          resolve({ decision: "block", reason: "Question timed out (5m)" });
        }, 5 * 60_000);

        this.pendingQuestions.set(sessionId, {
          resolve,
          timer,
          sessionId,
          toolUseId: input.tool_use_id,
        });
      });
    };
  }

  /**
   * Resolve pending question with user's reply.
   */
  handleReply(sessionId: string, text: string): void {
    const pending = this.pendingQuestions.get(sessionId);
    if (!pending) {
      log.warn("No pending question for reply", { sessionId });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingQuestions.delete(sessionId);
    log.info("Question answered", { sessionId, toolUseId: pending.toolUseId });
    pending.resolve({ decision: "block", reason: `User answered: ${text}` });
  }

  /**
   * Check if a question is pending for this session.
   */
  hasPending(sessionId: string): boolean {
    return this.pendingQuestions.has(sessionId);
  }

  /**
   * Clear one session's pending question (cancel/clear flow).
   */
  denyPending(sessionId: string, reason: string): void {
    const pending = this.pendingQuestions.get(sessionId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingQuestions.delete(sessionId);
    log.info("Denying pending question", { sessionId, toolUseId: pending.toolUseId, reason });
    pending.resolve({ decision: "block", reason });
  }

  /**
   * Clear ALL pending questions (shutdown flow).
   */
  denyAll(reason: string): void {
    for (const [sessionId, pending] of this.pendingQuestions) {
      clearTimeout(pending.timer);
      log.info("Auto-denying pending question", { sessionId, toolUseId: pending.toolUseId, reason });
      pending.resolve({ decision: "block", reason });
    }
    this.pendingQuestions.clear();
  }
}
