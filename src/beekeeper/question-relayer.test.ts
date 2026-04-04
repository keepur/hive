import { describe, it, expect, beforeEach } from "vitest";
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
    relayer = new QuestionRelayer();
    sent = [];
    relayer.setSendDelegate((msg) => sent.push(msg));
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
  // Non-blocking relay
  // -----------------------------------------------------------

  it("sends question as message and returns immediately", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const result = await cb(
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

    // Should have sent one message to client
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Extract<ServerMessage, { type: "message" }>;
    expect(msg.type).toBe("message");
    expect(msg.sessionId).toBe("sess-1");
    expect(msg.final).toBe(true);
    expect(msg.text).toContain("Which feature?");
    expect(msg.text).toContain("1. Dark mode — Toggle theme");
    expect(msg.text).toContain("2. Notifications — Push alerts");

    // Should resolve immediately (non-blocking) with block + relay reason
    expect(result.decision).toBe("block");
    expect(result.reason).toContain("Question relayed");
  });

  it("formats multiSelect question with suffix", async () => {
    const cb = relayer.createHookCallback("sess-1");
    await cb(
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
  });

  it("formats options without descriptions", async () => {
    const cb = relayer.createHookCallback("sess-1");
    await cb(
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
  });

  it("tells model not to re-ask the question", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const result = await cb(makeAskInput("tu-1", [{ question: "Q?", options: [{ label: "A" }] }]), "tu-1", hookOpts);
    expect(result.reason).toContain("Do NOT re-ask");
  });

  it("handles question with no options (free-form)", async () => {
    const cb = relayer.createHookCallback("sess-1");
    const result = await cb(makeAskInput("tu-1", [{ question: "What is your name?" }]), "tu-1", hookOpts);

    const msg = sent[0] as Extract<ServerMessage, { type: "message" }>;
    expect(msg.text).toBe("What is your name?");
    expect(result.decision).toBe("block");
  });

  it("handles multiple questions in one call", async () => {
    const cb = relayer.createHookCallback("sess-1");
    await cb(
      makeAskInput("tu-1", [
        { question: "First question?", options: [{ label: "A" }, { label: "B" }] },
        { question: "Second question?", options: [{ label: "X" }, { label: "Y" }] },
      ]),
      "tu-1",
      hookOpts,
    );

    const msg = sent[0] as Extract<ServerMessage, { type: "message" }>;
    expect(msg.text).toContain("First question?");
    expect(msg.text).toContain("Second question?");
  });
});
