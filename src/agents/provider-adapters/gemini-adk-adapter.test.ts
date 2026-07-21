import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType, Gemini, InMemoryRunner, LlmAgent, isFinalResponse, toStructuredEvents } from "@google/adk";
import { GeminiAdkAdapter, coerceGeminiOutput, extractTextChunks } from "./gemini-adk-adapter.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import { buildPilotInstructions } from "./turn-assembly.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";

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
    Gemini: vi.fn(function Gemini(options: unknown) {
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

const GeminiMock = vi.mocked(Gemini);
const LlmAgentMock = vi.mocked(LlmAgent);
const InMemoryRunnerMock = vi.mocked(InMemoryRunner);
const isFinalResponseMock = vi.mocked(isFinalResponse);
const toStructuredEventsMock = vi.mocked(toStructuredEvents);

function makeAdapter(overrides: Partial<ConstructorParameters<typeof GeminiAdkAdapter>[0]> = {}) {
  return new GeminiAdkAdapter({
    name: "Gemini Pilot",
    assembly: makeAssembly(),
    model: "gemini-flash-latest",
    ...overrides,
  });
}

function makeAssembly(overrides: Partial<ProviderTurnAssembly> = {}): ProviderTurnAssembly {
  return {
    instructions: "Be useful.",
    toolInventory: [],
    omittedTools: [],
    guardrailGate: async () => ({ behavior: "allow" }),
    memory: {},
    skillIndex: [],
    inProcessServers: {},
    sessionCwd: tmpdir(),
    ...overrides,
  };
}

function makeInventoryEntry(name = "memory"): HiveToolInventoryEntry {
  return {
    name,
    transport: "sdk-in-process",
    source: "core",
    requiresTurnContext: false,
    requiresHiveRuntime: true,
    inProcess: true,
    compatibility: {
      claude: "direct",
      openai: "requires-hive-bridge",
      gemini: "requires-hive-bridge",
      codex: "requires-hive-bridge",
    },
    schemas: { kind: "connect-time" },
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

  it("uses systemPromptOverride", async () => {
    runEphemeralMock.mockReturnValueOnce(events({ finalText: "ok" }));
    isFinalResponseMock.mockReturnValue(true);

    await makeAdapter().runTurn({
      prompt: "hello",
      systemPromptOverride: "voice prompt",
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

  it("prefers Google OAuth via Vertex and falls back to Gemini API-key auth on auth failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-google-adc-"));
    const credentialsPath = join(dir, "application_default_credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({ type: "authorized_user", quota_project_id: "pilot-project" }));
    runEphemeralMock
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("Unauthorized"), { status: 401 });
      })
      .mockReturnValueOnce(events({ finalText: "used gemini key" }));
    isFinalResponseMock.mockReturnValue(true);

    try {
      const result = await makeAdapter({
        googleApplicationCredentialsPath: credentialsPath,
        vertexLocation: "us-central1",
        apiKey: "gemini-fallback",
      }).runTurn({ prompt: "hello" });

      expect(result).toMatchObject({
        text: "used gemini key",
        aborted: false,
      });
      expect(GeminiMock).toHaveBeenNthCalledWith(1, {
        model: "gemini-flash-latest",
        vertexai: true,
        project: "pilot-project",
        location: "us-central1",
      });
      expect(GeminiMock).toHaveBeenNthCalledWith(2, {
        model: "gemini-flash-latest",
        apiKey: "gemini-fallback",
      });
      expect(LlmAgentMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("KPR-347 T1: construction + runTurn with a non-empty bridgeable inventory resolves and advertises zero tools", async () => {
    isFinalResponseMock.mockReturnValue(true);
    runEphemeralMock.mockReturnValueOnce(events({ finalText: "hello" }));

    const adapter = makeAdapter({ assembly: makeAssembly({ toolInventory: [makeInventoryEntry()] }) });
    await expect(adapter.runTurn({ prompt: "hello" })).resolves.toMatchObject({
      text: "hello",
      aborted: false,
    });

    const agentOptions = LlmAgentMock.mock.calls[0]![0] as { tools: unknown };
    expect(agentOptions.tools).toEqual([]);
  });

  it("KPR-347 T1: instruction is byte-identical to buildPilotInstructions output", async () => {
    isFinalResponseMock.mockReturnValue(true);
    runEphemeralMock.mockReturnValueOnce(events({ finalText: "hello" }));

    await makeAdapter({
      assembly: makeAssembly({ instructions: buildPilotInstructions("Pilot", "soul", "system") }),
    }).runTurn({ prompt: "hello" });

    expect(LlmAgentMock).toHaveBeenCalledWith({
      name: "Gemini_Pilot",
      instruction: "soul\n\nsystem",
      model: "gemini-flash-latest",
      tools: [],
    });
  });
});
