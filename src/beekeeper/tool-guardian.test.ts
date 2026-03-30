import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ToolGuardian } from "./tool-guardian.js";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

// Helper to create a Bash PreToolUse hook input
function makeBashInput(command: string, toolUseId = "test-id-123"): HookInput {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: toolUseId,
    session_id: "sess-1",
    transcript_path: "/tmp/test",
    cwd: "/tmp",
  } as HookInput;
}

// Helper to create a non-Bash PreToolUse hook input
function makeNonBashInput(toolName: string, toolUseId = "test-id-456"): HookInput {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: toolName,
    tool_input: {},
    tool_use_id: toolUseId,
    session_id: "sess-1",
    transcript_path: "/tmp/test",
    cwd: "/tmp",
  } as HookInput;
}

// Helper to create a mock WebSocket
function makeMockWs(readyState = 1) {
  return {
    readyState,
    send: vi.fn(),
  };
}

const CONFIRM_PATTERNS = ["git push --force", "git branch -D", "rm -rf", "git reset --hard"];

const DUMMY_ABORT_SIGNAL = {} as AbortSignal;

describe("ToolGuardian", () => {
  let guardian: ToolGuardian;

  beforeEach(() => {
    guardian = new ToolGuardian(CONFIRM_PATTERNS);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createHookCallback()", () => {
    it("approves non-PreToolUse events", async () => {
      const callback = guardian.createHookCallback("test-session");
      const input = {
        hook_event_name: "PostToolUse" as const,
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        tool_use_id: "id-1",
        session_id: "sess-1",
        transcript_path: "/tmp/test",
        cwd: "/tmp",
      } as unknown as HookInput;

      const result = await callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      expect(result).toEqual({ decision: "approve" });
    });

    it("approves non-Bash tools", async () => {
      const callback = guardian.createHookCallback("test-session");
      const input = makeNonBashInput("Read");

      const result = await callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      expect(result).toEqual({ decision: "approve" });
    });

    it("approves Bash commands that do not match any confirm pattern", async () => {
      const callback = guardian.createHookCallback("test-session");
      const input = makeBashInput("git status");

      const result = await callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      expect(result).toEqual({ decision: "approve" });
    });

    it("approves safe git commands that partially look like patterns", async () => {
      const callback = guardian.createHookCallback("test-session");
      const input = makeBashInput("git push origin main");

      const result = await callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      expect(result).toEqual({ decision: "approve" });
    });

    it("blocks matching commands when no client is connected", async () => {
      const callback = guardian.createHookCallback("test-session");
      const input = makeBashInput("git push --force origin main");

      const result = await callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      expect(result).toEqual({ decision: "block", reason: "No client connected to approve" });
    });

    it("blocks matching commands when client WebSocket is not OPEN", async () => {
      const closedWs = makeMockWs(3); // CLOSED state
      guardian.setClient(closedWs as never);

      const callback = guardian.createHookCallback("test-session");
      const input = makeBashInput("rm -rf /tmp/old");

      const result = await callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      expect(result).toEqual({ decision: "block", reason: "No client connected to approve" });
    });

    it("sends approval request to connected client for matching commands", async () => {
      const mockWs = makeMockWs(1);
      guardian.setClient(mockWs as never);

      const callback = guardian.createHookCallback("test-session");
      const input = makeBashInput("git push --force origin main", "tool-use-xyz");

      // Don't await — let it pend
      const resultPromise = callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      expect(mockWs.send).toHaveBeenCalledOnce();
      const sentMsg = JSON.parse(mockWs.send.mock.calls[0][0] as string);
      expect(sentMsg).toEqual({
        type: "tool_approval",
        toolUseId: "tool-use-xyz",
        tool: "Bash",
        input: "git push --force origin main",
        sessionId: "test-session",
      });

      // Resolve the pending approval to avoid timer leaks
      guardian.handleApproval("tool-use-xyz", true);
      await resultPromise;
    });

    it("auto-denies after 60 second timeout", async () => {
      const mockWs = makeMockWs(1);
      guardian.setClient(mockWs as never);

      const callback = guardian.createHookCallback("test-session");
      const input = makeBashInput("git reset --hard HEAD~1", "timeout-id");

      const resultPromise = callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      // Advance time past the 60s timeout
      vi.advanceTimersByTime(60_001);

      const result = await resultPromise;

      expect(result).toEqual({ decision: "block", reason: "Approval timed out (60s)" });
    });
  });

  describe("handleApproval()", () => {
    it("resolves pending approval with approve when approved=true", async () => {
      const mockWs = makeMockWs(1);
      guardian.setClient(mockWs as never);

      const callback = guardian.createHookCallback("test-session");
      const input = makeBashInput("git push --force origin main", "approve-id");

      const resultPromise = callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      guardian.handleApproval("approve-id", true);
      const result = await resultPromise;

      expect(result).toEqual({ decision: "approve" });
    });

    it("resolves pending approval with block when approved=false", async () => {
      const mockWs = makeMockWs(1);
      guardian.setClient(mockWs as never);

      const callback = guardian.createHookCallback("test-session");
      const input = makeBashInput("rm -rf /important", "deny-id");

      const resultPromise = callback(input, undefined, { signal: DUMMY_ABORT_SIGNAL });

      guardian.handleApproval("deny-id", false);
      const result = await resultPromise;

      expect(result).toEqual({ decision: "block", reason: "User denied" });
    });

    it("does nothing if toolUseId is not found in pending approvals", () => {
      // Should not throw
      expect(() => guardian.handleApproval("nonexistent-id", true)).not.toThrow();
    });
  });

  describe("setClient(null)", () => {
    it("auto-denies all pending approvals when client disconnects", async () => {
      const mockWs = makeMockWs(1);
      guardian.setClient(mockWs as never);

      const callback = guardian.createHookCallback("test-session");

      const input1 = makeBashInput("git push --force", "id-1");
      const input2 = makeBashInput("rm -rf /tmp", "id-2");

      const result1Promise = callback(input1, undefined, { signal: DUMMY_ABORT_SIGNAL });
      const result2Promise = callback(input2, undefined, { signal: DUMMY_ABORT_SIGNAL });

      // Disconnect client — triggers denyAll
      guardian.setClient(null);

      const [result1, result2] = await Promise.all([result1Promise, result2Promise]);

      expect(result1).toEqual({ decision: "block", reason: "Client disconnected" });
      expect(result2).toEqual({ decision: "block", reason: "Client disconnected" });
    });
  });

  describe("denyAll()", () => {
    it("clears all pending approvals with the given reason", async () => {
      const mockWs = makeMockWs(1);
      guardian.setClient(mockWs as never);

      const callback = guardian.createHookCallback("test-session");

      const input1 = makeBashInput("git push --force", "bulk-id-1");
      const input2 = makeBashInput("git branch -D old-branch", "bulk-id-2");

      const result1Promise = callback(input1, undefined, { signal: DUMMY_ABORT_SIGNAL });
      const result2Promise = callback(input2, undefined, { signal: DUMMY_ABORT_SIGNAL });

      guardian.denyAll("Emergency shutdown");

      const [result1, result2] = await Promise.all([result1Promise, result2Promise]);

      expect(result1).toEqual({ decision: "block", reason: "Emergency shutdown" });
      expect(result2).toEqual({ decision: "block", reason: "Emergency shutdown" });
    });
  });
});
