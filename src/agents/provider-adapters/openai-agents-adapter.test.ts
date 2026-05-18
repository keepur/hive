import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, run } from "@openai/agents";
import { OpenAIAgentsAdapter, coerceFinalOutput } from "./openai-agents-adapter.js";
import type { HiveToolTransportDescriptor } from "./tool-transport.js";

vi.mock("@openai/agents", () => ({
  Agent: vi.fn(function Agent(options: unknown) {
    return { options };
  }),
  run: vi.fn(),
}));

const AgentMock = vi.mocked(Agent);
const runMock = vi.mocked(run);

function makeAdapter(overrides: Partial<ConstructorParameters<typeof OpenAIAgentsAdapter>[0]> = {}) {
  return new OpenAIAgentsAdapter({
    name: "Pilot",
    instructions: "Be useful.",
    model: "gpt-5.4-mini",
    ...overrides,
  });
}

function makeDescriptor(
  openaiCompatibility: HiveToolTransportDescriptor["compatibility"]["openai"],
): HiveToolTransportDescriptor {
  return {
    name: `tool-${openaiCompatibility}`,
    transport: "stdio",
    source: "core",
    requiresTurnContext: false,
    requiresHiveRuntime: false,
    inProcess: false,
    compatibility: {
      claude: "direct",
      openai: openaiCompatibility,
      gemini: openaiCompatibility,
    },
  };
}

function makeSdkResult(overrides: Record<string, unknown> = {}) {
  return {
    finalOutput: "hello",
    lastResponseId: "resp-1",
    ...overrides,
  };
}

describe("OpenAIAgentsAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the OpenAI provider id", () => {
    expect(makeAdapter().provider).toBe("openai");
  });

  it("constructs an OpenAI agent and maps a non-streaming run result", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult({ finalOutput: "hi there", lastResponseId: "resp-next" }) as never);

    const adapter = makeAdapter();
    const result = await adapter.runTurn({
      prompt: "hello",
      sessionId: "resp-prev",
      resourceLimits: { timeoutMs: 60_000, maxTurns: 7, budgetUsd: 1 },
    });

    expect(AgentMock).toHaveBeenCalledWith({
      name: "Pilot",
      instructions: "Be useful.",
      model: "gpt-5.4-mini",
    });
    expect(runMock).toHaveBeenCalledWith(expect.anything(), "hello", {
      stream: false,
      maxTurns: 7,
      signal: expect.any(AbortSignal),
      previousResponseId: "resp-prev",
    });
    expect(result).toMatchObject({
      text: "hi there",
      sessionId: "resp-next",
      costUsd: 0,
      toolCalls: 0,
      toolSummary: "none",
      streamed: false,
      inputTokens: 0,
      outputTokens: 0,
      contextWindow: 0,
      compactions: 0,
      aborted: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.llmMs).toBe(result.durationMs);
  });

  it("uses systemPromptOverride and ignores modelOverride", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult() as never);

    await makeAdapter().runTurn({
      prompt: "hello",
      systemPromptOverride: "voice prompt",
      modelOverride: "claude-sonnet-4-6",
    });

    expect(AgentMock).toHaveBeenCalledWith({
      name: "Pilot",
      instructions: "voice prompt",
      model: "gpt-5.4-mini",
    });
  });

  it("streams text chunks to onStream and returns accumulated text", async () => {
    const textStream = {
      async *[Symbol.asyncIterator]() {
        yield "hel";
        yield "lo";
      },
    };
    const completed = Promise.resolve();
    runMock.mockResolvedValueOnce({
      finalOutput: "ignored",
      lastResponseId: "resp-stream",
      completed,
      toTextStream: vi.fn(() => textStream),
    } as never);

    const onStream = vi.fn();
    const result = await makeAdapter().runTurn({ prompt: "stream please", onStream });

    expect(runMock).toHaveBeenCalledWith(expect.anything(), "stream please", {
      stream: true,
      maxTurns: undefined,
      signal: expect.any(AbortSignal),
      previousResponseId: undefined,
    });
    expect(onStream).toHaveBeenNthCalledWith(1, "hel");
    expect(onStream).toHaveBeenNthCalledWith(2, "lo");
    expect(result).toMatchObject({
      text: "hello",
      sessionId: "resp-stream",
      streamed: true,
      aborted: false,
    });
  });

  it("maps abort rejection to an aborted RunResult", async () => {
    let capturedSignal: AbortSignal | undefined;
    runMock.mockImplementationOnce((_agent, _prompt, options) => {
      capturedSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 0);
      }) as never;
    });

    const adapter = makeAdapter();
    const promise = adapter.runTurn({ prompt: "stop", sessionId: "resp-prev" });
    adapter.abort();
    const result = await promise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(adapter.wasAborted).toBe(true);
    expect(result).toMatchObject({
      text: "",
      sessionId: "resp-prev",
      streamed: false,
      aborted: true,
    });
    expect(result.error).toBeUndefined();
  });

  it("maps normal SDK errors to a complete non-aborted RunResult", async () => {
    runMock.mockRejectedValueOnce(new Error("max turns exceeded"));

    const result = await makeAdapter().runTurn({ prompt: "fail", sessionId: "resp-prev" });

    expect(result).toMatchObject({
      text: "",
      sessionId: "resp-prev",
      costUsd: 0,
      toolCalls: 0,
      streamed: false,
      aborted: false,
      error: "max turns exceeded",
    });
  });

  it("coerces finalOutput values", async () => {
    runMock
      .mockResolvedValueOnce(makeSdkResult({ finalOutput: undefined, lastResponseId: undefined }) as never)
      .mockResolvedValueOnce(makeSdkResult({ finalOutput: { ok: true } }) as never);

    await expect(makeAdapter().runTurn({ prompt: "undefined", sessionId: "existing" })).resolves.toMatchObject({
      text: "",
      sessionId: "existing",
    });
    await expect(makeAdapter().runTurn({ prompt: "object" })).resolves.toMatchObject({
      text: "{\"ok\":true}",
    });
    expect(coerceFinalOutput("plain")).toBe("plain");
    expect(coerceFinalOutput(null)).toBe("");
  });

  it("rejects non-Claude tool inventory before calling the SDK", async () => {
    for (const compatibility of ["mcp-bridge-candidate", "requires-hive-bridge", "unsupported"] as const) {
      const adapter = makeAdapter({ toolInventory: [makeDescriptor(compatibility)] });
      await expect(adapter.runTurn({ prompt: "hello" })).rejects.toThrow(
        "OpenAI tool bridge is not implemented in KPR-233",
      );
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it("ignores Claude-only inventory for a tool-free run", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult() as never);

    await expect(
      makeAdapter({ toolInventory: [makeDescriptor("claude-only")] }).runTurn({ prompt: "hello" }),
    ).resolves.toMatchObject({
      text: "hello",
      aborted: false,
    });

    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
