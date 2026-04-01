import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { QuestionRelayer } from "./question-relayer.js";
import type { ServerMessage } from "./types.js";

/** Build a minimal HookInput for AskUserQuestion */
function makeAskInput(
  toolUseId: string,
  questions: Array<{
    question: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>,
): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: toolUseId,
    tool_input: { questions },
  } as HookInput;
}

function makeBashInput(toolUseId: string): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "echo hello" },
  } as HookInput;
}

const hookOpts = { signal: new AbortController().signal };

describe("QuestionRelayer", () => {
  let relayer: QuestionRelayer;
  let sent: ServerMessage[];

  beforeEach(() => {
    vi.useFakeTimers();
    relayer = new QuestionRelayer();
    sent = [];
    relayer.setSendDelegate((msg) => sent.push(msg));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------
  // Hook passthrough
  // -----------------------------------------------------------

  it("approves non-AskUserQuestion tools", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const result = await cb(makeBashInput("tu-1"), "tu-1", hookOpts);
    expect(result).toEqual({ decision: "approve" });
  });

  it("approves non-PreToolUse events", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const input = {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "tu-1",
      tool_input: {},
    } as unknown as HookInput;
    const result = await cb(input, "tu-1", hookOpts);
    expect(result).toEqual({ decision: "approve" });
  });

  // -----------------------------------------------------------
  // No delegate → block
  // -----------------------------------------------------------

  it("blocks AskUserQuestion when no send delegate is set", async () => {
    const bare = new QuestionRelayer(); // no setSendDelegate
    const cb = bare.createHookCallback("sess-1");
    const result = await cb(
      makeAskInput("tu-1", [{ question: "Pick one", options: [{ label: "A", description: "first" }] }]),
      "tu-1",
      hookOpts,
    );
    expect(result).toEqual({ decision: "block", reason: "No client connected to relay question" });
  });

  // -----------------------------------------------------------
  // Question formatting
  // -----------------------------------------------------------

  it("formats a single question with numbered options", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const hookPromise = cb(
      makeAskInput("tu-1", [
        {
          question: "Which feature?",
          options: [
            { label: "Dark mode", description: "Toggle theme" },
            { label: "Notifications", description: "Push alerts" },
          ],
        },
      ]),
      "tu-1",
      hookOpts,
    );

    // Should have sent one message
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Extract<ServerMessage, { type: "message" }>;
    expect(msg.type).toBe("message");
    expect(msg.sessionId).toBe("sess-1");
    expect(msg.final).toBe(true);
    expect(msg.text).toContain("Which feature?");
    expect(msg.text).toContain("1. Dark mode — Toggle theme");
    expect(msg.text).toContain("2. Notifications — Push alerts");

    // Clean up pending
    relayer.denyPending("sess-1", "cleanup");
    await hookPromise;
  });

  it("formats multiSelect question with suffix", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const hookPromise = cb(
      makeAskInput("tu-1", [
        {
          question: "Which features?",
          multiSelect: true,
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
      "tu-1",
      hookOpts,
    );

    const msg = sent[0] as Extract<ServerMessage, { type: "message" }>;
    expect(msg.text).toContain("Which features? (select multiple)");
    expect(msg.text).toContain("1. A");
    expect(msg.text).toContain("2. B");

    relayer.denyPending("sess-1", "cleanup");
    await hookPromise;
  });

  it("formats options without descriptions", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const hookPromise = cb(
      makeAskInput("tu-1", [
        {
          question: "Pick",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ]),
      "tu-1",
      hookOpts,
    );

    const msg = sent[0] as Extract<ServerMessage, { type: "message" }>;
    expect(msg.text).toContain("1. Yes");
    expect(msg.text).toContain("2. No");
    expect(msg.text).not.toContain("—");

    relayer.denyPending("sess-1", "cleanup");
    await hookPromise;
  });

  // -----------------------------------------------------------
  // Pending state & reply
  // -----------------------------------------------------------

  it("hasPending returns true while question is pending", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const hookPromise = cb(makeAskInput("tu-1", [{ question: "Q?", options: [{ label: "A" }] }]), "tu-1", hookOpts);

    expect(relayer.hasPending("sess-1")).toBe(true);
    expect(relayer.hasPending("sess-other")).toBe(false);

    relayer.denyPending("sess-1", "cleanup");
    await hookPromise;
  });

  it("handleReply resolves with user answer", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const hookPromise = cb(makeAskInput("tu-1", [{ question: "Q?", options: [{ label: "A" }] }]), "tu-1", hookOpts);

    relayer.handleReply("sess-1", "Full control panel");
    const result = await hookPromise;

    expect(result).toEqual({ decision: "block", reason: "User answered: Full control panel" });
    expect(relayer.hasPending("sess-1")).toBe(false);
  });

  it("handleReply is no-op when no pending question", () => {
    // Should not throw
    relayer.handleReply("nonexistent", "some text");
    expect(relayer.hasPending("nonexistent")).toBe(false);
  });

  // -----------------------------------------------------------
  // denyPending
  // -----------------------------------------------------------

  it("denyPending resolves with given reason", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const hookPromise = cb(makeAskInput("tu-1", [{ question: "Q?", options: [{ label: "A" }] }]), "tu-1", hookOpts);

    relayer.denyPending("sess-1", "Operation cancelled");
    const result = await hookPromise;

    expect(result).toEqual({ decision: "block", reason: "Operation cancelled" });
    expect(relayer.hasPending("sess-1")).toBe(false);
  });

  it("denyPending is no-op for unknown session", () => {
    relayer.denyPending("nonexistent", "reason");
    // Should not throw
  });

  // -----------------------------------------------------------
  // denyAll
  // -----------------------------------------------------------

  it("denyAll resolves all pending questions", async () => {
    const cb1 = relayer.createHookCallback("sess-1");
    const cb2 = relayer.createHookCallback("sess-2");

    const p1 = cb1(makeAskInput("tu-1", [{ question: "Q1?", options: [{ label: "A" }] }]), "tu-1", hookOpts);
    const p2 = cb2(makeAskInput("tu-2", [{ question: "Q2?", options: [{ label: "B" }] }]), "tu-2", hookOpts);

    relayer.denyAll("All clients disconnected");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ decision: "block", reason: "All clients disconnected" });
    expect(r2).toEqual({ decision: "block", reason: "All clients disconnected" });
    expect(relayer.hasPending("sess-1")).toBe(false);
    expect(relayer.hasPending("sess-2")).toBe(false);
  });

  // -----------------------------------------------------------
  // Supersede
  // -----------------------------------------------------------

  it("supersedes existing pending question for same session", async () => {
    const cb = relayer.createHookCallback("sess-1");

    const first = cb(makeAskInput("tu-1", [{ question: "First?", options: [{ label: "A" }] }]), "tu-1", hookOpts);

    // Fire a second question on the same session
    const second = cb(makeAskInput("tu-2", [{ question: "Second?", options: [{ label: "B" }] }]), "tu-2", hookOpts);

    // First should have been superseded
    const firstResult = await first;
    expect(firstResult).toEqual({ decision: "block", reason: "Superseded by new question" });

    // Second is still pending
    expect(relayer.hasPending("sess-1")).toBe(true);

    relayer.handleReply("sess-1", "B");
    const secondResult = await second;
    expect(secondResult).toEqual({ decision: "block", reason: "User answered: B" });
  });

  // -----------------------------------------------------------
  // Timeout
  // -----------------------------------------------------------

  it("times out after 5 minutes", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const hookPromise = cb(makeAskInput("tu-1", [{ question: "Q?", options: [{ label: "A" }] }]), "tu-1", hookOpts);

    expect(relayer.hasPending("sess-1")).toBe(true);

    // Advance past the 5-minute timeout
    vi.advanceTimersByTime(5 * 60_000 + 1);

    const result = await hookPromise;
    expect(result).toEqual({ decision: "block", reason: "Question timed out (5m)" });
    expect(relayer.hasPending("sess-1")).toBe(false);
  });

  it("handleReply before timeout clears the timer", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const hookPromise = cb(makeAskInput("tu-1", [{ question: "Q?", options: [{ label: "A" }] }]), "tu-1", hookOpts);

    // Reply quickly
    relayer.handleReply("sess-1", "answer");
    const result = await hookPromise;
    expect(result.reason).toBe("User answered: answer");

    // Advancing timers should NOT cause any issues (timer was cleared)
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(relayer.hasPending("sess-1")).toBe(false);
  });

  // -----------------------------------------------------------
  // Multiple sessions independent
  // -----------------------------------------------------------

  it("handles questions on different sessions independently", async () => {
    const cb1 = relayer.createHookCallback("sess-1");
    const cb2 = relayer.createHookCallback("sess-2");

    const p1 = cb1(makeAskInput("tu-1", [{ question: "Q1?", options: [{ label: "A" }] }]), "tu-1", hookOpts);
    const p2 = cb2(makeAskInput("tu-2", [{ question: "Q2?", options: [{ label: "B" }] }]), "tu-2", hookOpts);

    // Reply to sess-2 only
    relayer.handleReply("sess-2", "B answer");
    const r2 = await p2;
    expect(r2.reason).toBe("User answered: B answer");

    // sess-1 still pending
    expect(relayer.hasPending("sess-1")).toBe(true);
    expect(relayer.hasPending("sess-2")).toBe(false);

    relayer.handleReply("sess-1", "A answer");
    const r1 = await p1;
    expect(r1.reason).toBe("User answered: A answer");
  });
});
