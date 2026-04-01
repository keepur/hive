import type { HookInput, HookJSONOutput, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";
import type { ServerMessage } from "./types.js";

const log = createLogger("beekeeper-guardian");

interface PendingApproval {
  resolve: (decision: HookJSONOutput) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
}

export class ToolGuardian {
  private pendingApprovals = new Map<string, PendingApproval>();
  private confirmPatterns: string[];
  private sendDelegate: ((msg: ServerMessage) => void) | null = null;

  constructor(confirmPatterns: string[]) {
    this.confirmPatterns = confirmPatterns;
  }

  /**
   * Set the send delegate. Routes through SessionManager.send() which
   * broadcasts to all connected clients or buffers when none are connected.
   * Set once at startup — no need to clear on individual client disconnect.
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
      if (input.tool_name !== "Bash") {
        return { decision: "approve" };
      }

      const command = (input.tool_input as { command?: string })?.command ?? "";

      const needsApproval = this.confirmPatterns.some((pattern) => command.includes(pattern));
      if (!needsApproval) {
        return { decision: "approve" };
      }

      log.info("Tool requires approval", { toolUseId: input.tool_use_id, sessionId, command });

      if (!this.sendDelegate) {
        log.warn("No send delegate, auto-denying", { toolUseId: input.tool_use_id });
        return { decision: "block", reason: "No client connected to approve" };
      }

      const approvalMsg: ServerMessage = {
        type: "tool_approval",
        toolUseId: input.tool_use_id,
        tool: "Bash",
        input: command,
        sessionId,
      };
      this.sendDelegate(approvalMsg);

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          log.warn("Approval timed out, auto-denying", { toolUseId: input.tool_use_id });
          this.pendingApprovals.delete(input.tool_use_id);
          resolve({ decision: "block", reason: "Approval timed out (60s)" });
        }, 60_000);

        this.pendingApprovals.set(input.tool_use_id, { resolve, timer, sessionId });
      });
    };
  }

  /**
   * Called when client sends approve/deny message.
   */
  handleApproval(toolUseId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(toolUseId);
    if (!pending) {
      log.warn("No pending approval found", { toolUseId });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingApprovals.delete(toolUseId);

    if (approved) {
      log.info("Tool approved by client", { toolUseId });
      pending.resolve({ decision: "approve" });
    } else {
      log.info("Tool denied by client", { toolUseId });
      pending.resolve({ decision: "block", reason: "User denied" });
    }
  }

  /**
   * Deny all pending approvals (called on client disconnect).
   */
  denyAll(reason: string): void {
    for (const [toolUseId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timer);
      log.info("Auto-denying pending approval", { toolUseId, reason });
      pending.resolve({ decision: "block", reason });
    }
    this.pendingApprovals.clear();
  }
}
