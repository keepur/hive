import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentAdapter } from "./claude-agent-adapter.js";

describe("ClaudeAgentAdapter", () => {
  it("delegates runTurn to AgentRunner.send with the current Hive turn shape", async () => {
    const result = { text: "ok", sessionId: "s1" };
    const runner = {
      send: vi.fn().mockResolvedValue(result),
      abort: vi.fn(),
      wasAborted: false,
    };
    const adapter = new ClaudeAgentAdapter(runner as any);
    const onStream = vi.fn();
    const workItemContext = {
      adapterId: "slack",
      channelId: "C1",
      channelKind: "slack",
      channelLabel: "general",
      threadId: "t1",
      slackTs: "123",
      slackThreadTs: "123",
    };
    const resourceLimits = { timeoutMs: 60_000, maxTurns: 12, budgetUsd: 1 };

    await expect(
      adapter.runTurn({
        prompt: "hello",
        sessionId: "s0",
        onStream,
        workItemContext,
        modelOverride: "claude-haiku-4-5",
        resourceLimits,
        systemPromptOverride: "voice prompt",
        effort: "low",
      }),
    ).resolves.toBe(result);

    expect(runner.send).toHaveBeenCalledWith(
      "hello",
      "s0",
      onStream,
      workItemContext,
      "claude-haiku-4-5",
      resourceLimits,
      "voice prompt",
      "low",
    );
  });

  it("delegates abort and exposes aborted state", () => {
    const runner = {
      send: vi.fn(),
      abort: vi.fn(),
      wasAborted: true,
    };
    const adapter = new ClaudeAgentAdapter(runner as any);

    adapter.abort();

    expect(adapter.provider).toBe("claude");
    expect(runner.abort).toHaveBeenCalledTimes(1);
    expect(adapter.wasAborted).toBe(true);
  });
});
