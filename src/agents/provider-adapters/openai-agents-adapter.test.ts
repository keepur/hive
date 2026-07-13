import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, OpenAIProvider, Runner, run } from "@openai/agents";
import { OpenAIAgentsAdapter, coerceFinalOutput } from "./openai-agents-adapter.js";
import type { HiveToolTransportDescriptor } from "./tool-transport.js";

const { runnerRunMock } = vi.hoisted(() => ({
  runnerRunMock: vi.fn(),
}));

vi.mock("@openai/agents", () => ({
  Agent: vi.fn(function Agent(options: unknown) {
    return { options };
  }),
  OpenAIProvider: vi.fn(function OpenAIProvider(options: unknown) {
    return { options };
  }),
  Runner: vi.fn(function Runner(options: unknown) {
    return { options, run: runnerRunMock };
  }),
  run: vi.fn(),
}));

const AgentMock = vi.mocked(Agent);
const OpenAIProviderMock = vi.mocked(OpenAIProvider);
const RunnerMock = vi.mocked(Runner);
const runMock = vi.mocked(run);

function makeAdapter(overrides: Partial<ConstructorParameters<typeof OpenAIAgentsAdapter>[0]> = {}) {
  return new OpenAIAgentsAdapter({
    name: "Pilot",
    instructions: "Be useful.",
    model: "gpt-5.4-mini",
    preferOAuth: false,
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
    delete process.env.OPENAI_API_KEY;
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

  it("uses systemPromptOverride", async () => {
    runMock.mockResolvedValueOnce(makeSdkResult() as never);

    await makeAdapter().runTurn({
      prompt: "hello",
      systemPromptOverride: "voice prompt",
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

  it("prefers Codex OAuth and falls back to API-key auth on OpenAI auth failures", async () => {
    process.env.OPENAI_API_KEY = "sk-fallback";
    const dir = mkdtempSync(join(tmpdir(), "hive-codex-auth-"));
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: makeJwt({ exp: 60 * 60 }) } }));
    runnerRunMock
      .mockRejectedValueOnce(Object.assign(new Error("Missing scopes: api.responses.write"), { status: 401 }))
      .mockResolvedValueOnce(makeSdkResult({ finalOutput: "used fallback", lastResponseId: "resp-fallback" }));

    try {
      const result = await makeAdapter({ preferOAuth: true, codexAuthPath: authPath }).runTurn({ prompt: "hello" });

      expect(result).toMatchObject({
        text: "used fallback",
        sessionId: "resp-fallback",
        aborted: false,
      });
      expect(runMock).not.toHaveBeenCalled();
      expect(RunnerMock).toHaveBeenCalledTimes(2);
      expect(OpenAIProviderMock).toHaveBeenCalledTimes(2);

      const firstClient = (OpenAIProviderMock.mock.calls[0][0] as any).openAIClient;
      const secondClient = (OpenAIProviderMock.mock.calls[1][0] as any).openAIClient;
      expect(typeof firstClient._options.apiKey).toBe("function");
      expect(secondClient._options.apiKey).toBe("sk-fallback");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

function makeJwt(payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(
    JSON.stringify({
      aud: ["https://api.openai.com/v1"],
      ...payload,
      exp: now + Number(payload.exp ?? 60 * 60),
    }),
  ).toString("base64url");
  return `header.${encoded}.signature`;
}
