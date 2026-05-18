import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, InMemoryRunner, LlmAgent, isFinalResponse, toStructuredEvents } from "@google/adk";
import { GeminiAdkAdapter, coerceGeminiOutput, extractTextChunks } from "./gemini-adk-adapter.js";
import type { HiveToolTransportDescriptor } from "./tool-transport.js";

const { runEphemeralMock } = vi.hoisted(() => ({
  runEphemeralMock: vi.fn(),
}));

vi.mock("@google/adk", async () => {
  const actual = await vi.importActual<typeof import("@google/adk")>("@google/adk");
  return {
    ...actual,
    LlmAgent: vi.fn(function LlmAgent(options: unknown) {
      return { options };
    }),
    InMemoryRunner: vi.fn(function InMemoryRunner(options: unknown) {
      return { options, runEphemeral: runEphemeralMock };
    }),
    isFinalResponse: vi.fn(),
    stringifyContent: vi.fn((event: { finalText?: string }) => event.finalText ?? ""),
    toStructuredEvents: vi.fn(),
  };
});

const LlmAgentMock = vi.mocked(LlmAgent);
const InMemoryRunnerMock = vi.mocked(InMemoryRunner);
const isFinalResponseMock = vi.mocked(isFinalResponse);
const toStructuredEventsMock = vi.mocked(toStructuredEvents);

function makeAdapter(overrides: Partial<ConstructorParameters<typeof GeminiAdkAdapter>[0]> = {}) {
  return new GeminiAdkAdapter({
    name: "Gemini Pilot",
    instructions: "Be useful.",
    model: "gemini-flash-latest",
    ...overrides,
  });
}

function makeDescriptor(
  geminiCompatibility: HiveToolTransportDescriptor["compatibility"]["gemini"],
): HiveToolTransportDescriptor {
  return {
    name: `tool-${geminiCompatibility}`,
    transport: "stdio",
    source: "core",
    requiresTurnContext: false,
    requiresHiveRuntime: false,
    inProcess: false,
    compatibility: {
      claude: "direct",
      openai: geminiCompatibility,
      gemini: geminiCompatibility,
    },
  };
}

async function* events(...items: unknown[]) {
  for (const item of items) {
    yield item;
  }
}

describe("GeminiAdkAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isFinalResponseMock.mockReturnValue(false);
    toStructuredEventsMock.mockReturnValue([]);
  });

  it("exposes the Gemini provider id", () => {
    expect(makeAdapter().provider).toBe("gemini");
  });

  it("constructs a Gemini ADK agent and maps a non-streaming run result", async () => {
    isFinalResponseMock.mockReturnValue(true);
    runEphemeralMock.mockReturnValueOnce(events({ finalText: "hello from gemini" }));

    const adapter = makeAdapter({ appName: "hive-test", userId: "pilot-user" });
    const result = await adapter.runTurn({
      prompt: "hello",
      sessionId: "pilot-session",
      resourceLimits: { timeoutMs: 60_000, maxTurns: 4, budgetUsd: 1 },
    });

    expect(LlmAgentMock).toHaveBeenCalledWith({
      name: "Gemini_Pilot",
      instruction: "Be useful.",
      model: "gemini-flash-latest",
      tools: [],
    });
    expect(InMemoryRunnerMock).toHaveBeenCalledWith({
      agent: expect.anything(),
      appName: "hive-test",
    });
    expect(runEphemeralMock).toHaveBeenCalledWith({
      userId: "pilot-user",
      newMessage: {
        role: "user",
        parts: [{ text: "hello" }],
      },
      runConfig: {
        maxLlmCalls: 4,
      },
    });
    expect(result).toMatchObject({
      text: "hello from gemini",
      sessionId: "pilot-session",
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
    runEphemeralMock.mockReturnValueOnce(events({ finalText: "ok" }));
    isFinalResponseMock.mockReturnValue(true);

    await makeAdapter().runTurn({
      prompt: "hello",
      systemPromptOverride: "voice prompt",
      modelOverride: "claude-sonnet-4-6",
    });

    expect(LlmAgentMock).toHaveBeenCalledWith({
      name: "Gemini_Pilot",
      instruction: "voice prompt",
      model: "gemini-flash-latest",
      tools: [],
    });
  });

  it("streams extracted content chunks to onStream and returns accumulated text", async () => {
    toStructuredEventsMock
      .mockReturnValueOnce([{ type: EventType.CONTENT, content: "hel" }])
      .mockReturnValueOnce([{ type: EventType.CONTENT, content: "lo" }])
      .mockReturnValueOnce([{ type: EventType.FINISHED, output: "hello" }]);
    runEphemeralMock.mockReturnValueOnce(events({}, {}, {}));

    const onStream = vi.fn();
    const result = await makeAdapter().runTurn({ prompt: "stream please", onStream });

    expect(onStream).toHaveBeenNthCalledWith(1, "hel");
    expect(onStream).toHaveBeenNthCalledWith(2, "lo");
    expect(onStream).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      text: "hello",
      streamed: true,
      aborted: false,
    });
  });

  it("maps abort to an aborted RunResult and stops consuming events", async () => {
    async function* abortingEvents() {
      yield {};
      yield {};
    }
    toStructuredEventsMock.mockReturnValue([{ type: EventType.CONTENT, content: "partial" }]);

    const adapter = makeAdapter();
    runEphemeralMock.mockReturnValueOnce(abortingEvents());
    const result = await adapter.runTurn({
      prompt: "stop",
      sessionId: "pilot-session",
      onStream: () => adapter.abort(),
    });

    expect(adapter.wasAborted).toBe(true);
    expect(result).toMatchObject({
      text: "",
      sessionId: "pilot-session",
      streamed: true,
      aborted: true,
    });
    expect(result.error).toBeUndefined();
  });

  it("maps normal ADK errors to a complete non-aborted RunResult", async () => {
    runEphemeralMock.mockImplementationOnce(() => {
      throw new Error("quota exceeded");
    });

    const result = await makeAdapter().runTurn({ prompt: "fail", sessionId: "pilot-session" });

    expect(result).toMatchObject({
      text: "",
      sessionId: "pilot-session",
      costUsd: 0,
      toolCalls: 0,
      streamed: false,
      aborted: false,
      error: "quota exceeded",
    });
  });

  it("extracts text from structured, final, and raw ADK events", () => {
    toStructuredEventsMock.mockReturnValueOnce([
      { type: EventType.CONTENT, content: "partial" },
      { type: EventType.FINISHED, output: { ok: true } },
    ]);
    isFinalResponseMock.mockReturnValueOnce(true);

    const extracted = extractTextChunks({
      finalText: "final",
      content: { parts: [{ text: "raw" }] },
    } as never);

    expect(extracted).toEqual({
      chunks: ["partial", "{\"ok\":true}", "final", "raw"],
    });
    expect(coerceGeminiOutput("plain")).toBe("plain");
    expect(coerceGeminiOutput(null)).toBe("");
  });

  it("records structured ADK error events", async () => {
    toStructuredEventsMock.mockReturnValueOnce([{ type: EventType.ERROR, error: new Error("model failed") }]);
    runEphemeralMock.mockReturnValueOnce(events({}));

    const result = await makeAdapter().runTurn({ prompt: "fail" });

    expect(result).toMatchObject({
      text: "",
      aborted: false,
      error: "model failed",
    });
  });

  it("rejects non-Claude tool inventory before constructing ADK objects", async () => {
    for (const compatibility of ["mcp-bridge-candidate", "requires-hive-bridge", "unsupported"] as const) {
      const adapter = makeAdapter({ toolInventory: [makeDescriptor(compatibility)] });
      await expect(adapter.runTurn({ prompt: "hello" })).rejects.toThrow(
        "Gemini ADK tool bridge is not implemented in KPR-234",
      );
    }
    expect(LlmAgentMock).not.toHaveBeenCalled();
    expect(runEphemeralMock).not.toHaveBeenCalled();
  });

  it("ignores Claude-only inventory for a tool-free run", async () => {
    isFinalResponseMock.mockReturnValue(true);
    runEphemeralMock.mockReturnValueOnce(events({ finalText: "hello" }));

    await expect(
      makeAdapter({ toolInventory: [makeDescriptor("claude-only")] }).runTurn({ prompt: "hello" }),
    ).resolves.toMatchObject({
      text: "hello",
      aborted: false,
    });

    expect(runEphemeralMock).toHaveBeenCalledTimes(1);
  });
});
