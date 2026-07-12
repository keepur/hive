import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { VoiceAdapter, isAuthError } from "./voice-adapter.js";
import type { OpenAIChatRequest } from "./openai-translator.js";
import type { TurnContext, TurnResult } from "../../agents/agent-manager.js";
import { ProviderCircuitOpenError } from "../../agents/provider-circuit-breaker.js";
import { VOICE_OUTAGE_SPOKEN_NOTICE } from "../../outage/outage-notices.js";

// ---------------------------------------------------------------------------
// Mocks shared across the file
// ---------------------------------------------------------------------------

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Stub out the SDK `query` so the legacy direct-query path in
// `handleChatCompletion` can be exercised without a real Anthropic call.
const sdkMessagesRef: { current: any[] } = { current: [] };
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    const messages = sdkMessagesRef.current;
    return (async function* () {
      for (const msg of messages) yield msg;
    })();
  }),
}));

// `buildVoiceSystemPrompt` runs `memoryManager.read` etc — keep it simple
// and deterministic so tests can assert on the override pass-through.
vi.mock("../../agents/prompt-builder.js", () => ({
  buildVoiceSystemPrompt: vi.fn(async (_agent: any, _mem: any, ctx: any) => {
    return `voice-prompt:${ctx?.goal ?? ""}:${ctx?.context ?? ""}`;
  }),
}));

// `config` is read for `voice.assistants` mapping. KPR-220 Phase 9 retired
// the `agentManager.perTurnSpawn.voice` flag; voice always routes through
// `AgentManager.spawnTurn`.
const configRef: { current: any } = {
  current: {
    anthropic: { apiKey: "test-key" },
    voice: { assistants: {} as Record<string, string> },
  },
};
vi.mock("../../config.js", () => ({
  get config() {
    return configRef.current;
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface AgentManagerStub {
  spawnTurn: ReturnType<typeof vi.fn>;
  sessionStoreGet: ReturnType<typeof vi.fn>;
  sessionStoreSet: ReturnType<typeof vi.fn>;
  providerFor: ReturnType<typeof vi.fn>;
  calls: Array<{ ctx: TurnContext; onStream?: (chunk: string) => void }>;
}

function makeAgentManager(turnResult: Partial<TurnResult> = {}, throwError?: string): AgentManagerStub {
  const calls: AgentManagerStub["calls"] = [];
  const sessionStoreGet = vi.fn().mockResolvedValue(undefined as string | undefined);
  const sessionStoreSet = vi.fn().mockResolvedValue(undefined);
  const providerFor = vi.fn().mockReturnValue("claude");

  const spawnTurn = vi.fn(async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
    calls.push({ ctx, onStream });
    if (throwError) throw new Error(throwError);
    return {
      finalMessage: "agent reply",
      newSessionId: "session-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 200000,
        costUsd: 0.001,
        durationMs: 200,
      },
      errors: [],
      ...turnResult,
    } satisfies TurnResult;
  });

  return { spawnTurn, sessionStoreGet, sessionStoreSet, providerFor, calls };
}

function makeVoiceAdapter(am?: AgentManagerStub, dispatcher?: { routeVoiceTurn: ReturnType<typeof vi.fn> }) {
  const registry: any = {
    get: vi.fn((id: string) =>
      id === "mokie" ? { id: "mokie", name: "Mokie", model: "claude-sonnet-4-6" } : undefined,
    ),
  };
  const memoryManager: any = {
    read: vi.fn().mockResolvedValue(""),
    getHotTierPrompt: vi.fn().mockResolvedValue(""),
  };
  const agentManager: any = am
    ? {
        spawnTurn: am.spawnTurn,
        getSessionStore: () => ({
          get: am.sessionStoreGet,
          set: am.sessionStoreSet,
        }),
        providerFor: am.providerFor,
      }
    : undefined;
  return new VoiceAdapter(0, "shared-secret", registry, memoryManager, agentManager, dispatcher as any);
}

class MockServerResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  statusCode = 0;
  headers: Record<string, string> = {};
  written: string[] = [];
  writeHead = vi.fn((status: number, headers?: Record<string, string>) => {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    this.headersSent = true;
  });
  write = vi.fn((chunk: string) => {
    this.written.push(chunk);
    return true;
  });
  end = vi.fn((chunk?: string) => {
    if (chunk) this.written.push(chunk);
    this.writableEnded = true;
  });
}

function makeRequest(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: "voice-mock",
    messages: [{ role: "user", content: "hello agent" }],
    stream: true,
    call: { id: "call-abc-123" },
    assistant: { metadata: { hive_agent_id: "mokie" } },
    ...overrides,
  };
}

async function callHandle(adapter: VoiceAdapter, req: OpenAIChatRequest, res: MockServerResponse) {
  const agentConfig = (adapter as any).registry.get("mokie")!;
  return (adapter as any).handleChatCompletion(
    /* req */ {} as any,
    res as unknown as ServerResponse,
    req,
    "mokie",
    agentConfig,
  );
}

// ---------------------------------------------------------------------------
// isAuthError (unchanged from baseline) — keep guarding the regex.
// ---------------------------------------------------------------------------

describe("isAuthError", () => {
  it.each([
    "Could not resolve authentication method",
    "Expected ANTHROPIC_API_KEY or authToken",
    "Error reading credentials.json",
    "401 Unauthorized: token expired",
    "user not authenticated",
  ])("matches: %s", (msg) => {
    expect(isAuthError(new Error(msg))).toBe(true);
  });

  it.each(["ECONNREFUSED 127.0.0.1:6333", "Tool call failed", "Validation error: missing field"])(
    "does not match: %s",
    (msg) => {
      expect(isAuthError(new Error(msg))).toBe(false);
    },
  );

  it("handles non-Error throws via String() coercion", () => {
    expect(isAuthError("Could not resolve authentication method")).toBe(true);
    expect(isAuthError({ message: "Could not resolve authentication method" })).toBe(false); // String({...}) === "[object Object]"
  });
});

// ---------------------------------------------------------------------------
// KPR-219: per-turn-via-AgentManager path tests
// ---------------------------------------------------------------------------

// KPR-220 Phase 8/9: legacy direct-`query()` path and the per-channel flag
// both retired. Voice now ALWAYS routes through spawnTurnViaAgentManager.
describe("VoiceAdapter — KPR-220 Phase 8 retirement", () => {
  beforeEach(() => {
    sdkMessagesRef.current = [
      { type: "system", subtype: "init", session_id: "sdk-sid-1" },
      { type: "result", subtype: "success", result: "any-text" },
    ];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("constructor throws when agentManager is not provided", () => {
    expect(
      () =>
        // Test wiring: pass undefined (typed-undefined coercion mirrors prod misconfig).
        new VoiceAdapter(0, "shared-secret", {} as any, {} as any, undefined as unknown as any),
    ).toThrow(/AgentManager/);
  });

  it("handleChatCompletion always routes through spawnTurnViaAgentManager (no flag check)", async () => {
    const am = makeAgentManager();
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: false });
    await callHandle(adapter, req, res);
    // spawnTurn fires — the direct-query fallback no longer exists.
    expect(am.spawnTurn).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceAdapter — spawnTurnViaAgentManager", () => {
  beforeEach(() => {});

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invokes spawnTurn with TurnContext shape: agentId, channelId=callId, threadId=voice:callId, channel=voice", async () => {
    const am = makeAgentManager({ finalMessage: "spawned reply" });
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: false });

    await callHandle(adapter, req, res);

    expect(am.spawnTurn).toHaveBeenCalledTimes(1);
    const ctx = am.calls[0]!.ctx;
    expect(ctx.agentId).toBe("mokie");
    expect(ctx.channel).toBe("voice");
    expect(ctx.channelId).toBe("call-abc-123");
    expect(ctx.threadId).toBe("voice:call-abc-123");
    expect(ctx.sessionId).toBeUndefined();
    expect(am.sessionStoreGet).toHaveBeenCalledWith("mokie", "voice:call-abc-123");
  });

  it("populates systemPromptOverride from buildVoiceSystemPrompt output", async () => {
    const am = makeAgentManager();
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({
      stream: false,
      call: { id: "call-x", metadata: { goal: "qualify lead", context: "warm inbound" } },
    });

    await callHandle(adapter, req, res);

    const ctx = am.calls[0]!.ctx;
    expect(ctx.systemPromptOverride).toBe("voice-prompt:qualify lead:warm inbound");
  });

  it("populates the in-adapter callId→agentId map on first turn (used as fast in-flight cache)", async () => {
    const am = makeAgentManager();
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: false });
    await callHandle(adapter, req, res);

    const sessions = (adapter as any).sessions as Map<string, { agentId: string }>;
    expect(sessions.get("call-abc-123")?.agentId).toBe("mokie");

    // Subsequent turn for the same callId reuses the existing session entry —
    // we don't double-log "session started".
    const res2 = new MockServerResponse();
    await callHandle(adapter, req, res2);
    expect(sessions.size).toBe(1); // still just the one
  });

  it("uses extractLatestUserMessage prompt + resume id when session-store has a sessionId", async () => {
    const am = makeAgentManager();
    am.sessionStoreGet.mockResolvedValueOnce({ sessionId: "resume-sid-xyz", provider: "claude" });
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({
      stream: false,
      messages: [
        { role: "user", content: "first user line" },
        { role: "assistant", content: "first agent line" },
        { role: "user", content: "latest user line" },
      ],
    });

    await callHandle(adapter, req, res);

    const ctx = am.calls[0]!.ctx;
    expect(ctx.sessionId).toBe("resume-sid-xyz");
    expect(ctx.workItem.text).toBe("latest user line");
  });

  it("uses renderConversationPrompt (full transcript) on first turn (no sessionId)", async () => {
    const am = makeAgentManager();
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({
      stream: false,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "what's the deal?" },
      ],
    });

    await callHandle(adapter, req, res);

    const ctx = am.calls[0]!.ctx;
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.workItem.text).toContain("Caller: hi");
    expect(ctx.workItem.text).toContain("You: hello");
    expect(ctx.workItem.text).toContain("Caller: what's the deal?");
  });

  it("streaming path: onStream chunks become SSE text-delta writes; headers lazy on first chunk", async () => {
    const am = makeAgentManager();
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: true });

    // Simulate text-delta chunks while spawnTurn is awaited.
    am.spawnTurn.mockImplementationOnce(async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
      am.calls.push({ ctx, onStream });
      // No headers yet (no chunks emitted).
      expect(res.headersSent).toBe(false);
      onStream!("Hel");
      // First chunk → headers should now have flushed.
      expect(res.headersSent).toBe(true);
      expect(res.headers["Content-Type"]).toBe("text/event-stream");
      onStream!("lo");
      // Empty chunk should be dropped defensively.
      onStream!("");
      onStream!(", world");
      return {
        finalMessage: "Hello, world",
        newSessionId: "s1",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0,
          durationMs: 0,
        },
        errors: [],
      };
    });

    await callHandle(adapter, req, res);

    const sseDataLines = res.written.filter((c) => c.startsWith("data: "));
    // 3 non-empty deltas + 1 [DONE] composite chunk
    const textChunks = sseDataLines.filter((c) => c.includes('"content":'));
    expect(textChunks).toHaveLength(3);
    const last = res.written.at(-1)!;
    expect(last).toContain("[DONE]");
    expect(res.writableEnded).toBe(true);
  });

  it("non-streaming path: TurnResult.finalMessage rendered via formatNonStreamingResponse", async () => {
    const am = makeAgentManager({ finalMessage: "the final answer" });
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: false });

    await callHandle(adapter, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(res.written.join(""));
    expect(body.choices[0].message.content).toBe("the final answer");
    expect(body.choices[0].message.role).toBe("assistant");
  });

  it("outer retry: when first spawnTurn errors with sessionId set and no bytes sent, retries with full transcript and stripped sessionId", async () => {
    const am = makeAgentManager();
    am.sessionStoreGet.mockResolvedValueOnce({ sessionId: "stale-sid", provider: "claude" });
    // First call errors (in errors[]), second succeeds.
    am.spawnTurn.mockImplementationOnce(async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
      am.calls.push({ ctx, onStream });
      return {
        finalMessage: "",
        newSessionId: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0,
          durationMs: 0,
        },
        errors: ["resume failed: bad session id"],
      };
    });

    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({
      stream: false,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "now retry me" },
      ],
    });

    await callHandle(adapter, req, res);

    expect(am.spawnTurn).toHaveBeenCalledTimes(2);
    // Retry context: no sessionId, full-transcript prompt.
    const retryCtx = am.calls[1]!.ctx;
    expect(retryCtx.sessionId).toBeUndefined();
    expect(retryCtx.workItem.text).toContain("Caller: first");
    expect(retryCtx.workItem.text).toContain("Caller: now retry me");
  });

  it("outer retry double-failure: stale sessionId is not pre-emptively cleared; next call resumes against it cleanly", async () => {
    const am = makeAgentManager();
    am.sessionStoreGet.mockResolvedValue({ sessionId: "persistent-stale-sid", provider: "claude" });

    const failingTurn = async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
      am.calls.push({ ctx, onStream });
      return {
        finalMessage: "",
        newSessionId: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0,
          durationMs: 0,
        },
        errors: ["resume failed twice"],
      } satisfies TurnResult;
    };
    am.spawnTurn.mockImplementation(failingTurn);

    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: false });

    await callHandle(adapter, req, res);

    // Adapter does not call sessionStore.set or any clear; the stale id stays
    // until spawnTurn's `finalizeSpawnResult` overwrites it on a successful turn.
    expect(am.sessionStoreSet).not.toHaveBeenCalled();

    // Next turn: sessionStoreGet still returns the stale id; spawnTurn's inner
    // auth-retry handles cleanup. Adapter behavior here is to attempt resume
    // with the stale id and let the manager handle it.
    const res2 = new MockServerResponse();
    am.calls.length = 0;
    am.spawnTurn.mockReset();
    am.spawnTurn.mockImplementation(async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
      am.calls.push({ ctx, onStream });
      return {
        finalMessage: "fresh",
        newSessionId: "new-sid",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0,
          durationMs: 0,
        },
        errors: [],
      } satisfies TurnResult;
    });
    await callHandle(adapter, req, res2);
    expect(am.calls[0]!.ctx.sessionId).toBe("persistent-stale-sid");
  });

  it("spawn budget exceeded: returns 503 with no SSE bytes", async () => {
    const am = makeAgentManager({}, "Spawn budget exceeded for mokie (5/5)");
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: true });

    await callHandle(adapter, req, res);

    expect(res.statusCode).toBe(503);
    expect(res.headers["Content-Type"]).toBe("application/json");
    expect(res.written.some((c) => c.includes("data:"))).toBe(false);
  });

  it("auth error: returns 503 with friendly error body", async () => {
    const am = makeAgentManager({}, "Could not resolve authentication method");
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: false });

    await callHandle(adapter, req, res);

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.written.join(""));
    expect(body.error).toBe("Voice unavailable");
  });
});

describe("VoiceAdapter — provider circuit open (KPR-307)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function circuitOpenError() {
    return new ProviderCircuitOpenError("claude" as never, Date.now(), 15_000, "connect-fail", "fetch failed");
  }

  it("non-streaming: speaks the outage notice as a 200 completion, not a generic 500", async () => {
    const am = makeAgentManager();
    am.spawnTurn.mockRejectedValue(circuitOpenError());
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: false });

    await callHandle(adapter, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json");
    const body = res.written.join("");
    expect(body).toContain(VOICE_OUTAGE_SPOKEN_NOTICE);
    expect(body).not.toContain("Internal error");
  });

  it("streaming: emits one SSE text chunk with the notice plus a done frame", async () => {
    const am = makeAgentManager();
    am.spawnTurn.mockRejectedValue(circuitOpenError());
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: true });

    await callHandle(adapter, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    const written = res.written.join("");
    expect(written).toContain(VOICE_OUTAGE_SPOKEN_NOTICE);
    expect(written).toContain("[DONE]");
  });

  it("does NOT fire the outer resume-retry for circuit-open fast-fails", async () => {
    const am = makeAgentManager();
    am.sessionStoreGet.mockResolvedValue({ sessionId: "session-abc", provider: "claude" }); // resume present
    am.spawnTurn.mockRejectedValue(circuitOpenError());
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: false });

    await callHandle(adapter, req, res);

    expect(am.spawnTurn).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceAdapter — dispatcher.routeVoiceTurn wiring (KPR-223)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes through dispatcher.routeVoiceTurn when dispatcher is wired", async () => {
    const am = makeAgentManager({ finalMessage: "via dispatcher" });
    const routeVoiceTurn = vi.fn(async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
      // Mirror the AgentManager mock so the runOnce path produces a TurnResult.
      return am.spawnTurn(ctx, onStream);
    });
    const dispatcher = { routeVoiceTurn };
    const adapter = makeVoiceAdapter(am, dispatcher);
    const res = new MockServerResponse();
    const req = makeRequest({ stream: false });

    await callHandle(adapter, req, res);

    expect(routeVoiceTurn).toHaveBeenCalledTimes(1);
    // Inner spawnTurn still ran (because the test's routeVoiceTurn delegates to it).
    expect(am.spawnTurn).toHaveBeenCalledTimes(1);
    // Voice-specific TurnContext shape preserved.
    const ctx = routeVoiceTurn.mock.calls[0]![0]!;
    expect(ctx.agentId).toBe("mokie");
    expect(ctx.channel).toBe("voice");
    expect(ctx.threadId).toBe("voice:call-abc-123");
  });
});

describe("VoiceAdapter.handleRequest agent resolution", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when no agent resolves and never invokes spawnTurn", async () => {
    // Use the public handleRequest entry: synthesize a POST to /v1/chat/completions
    // with no resolvable agent metadata.
    const am = makeAgentManager();
    const adapter = makeVoiceAdapter(am);
    const res = new MockServerResponse();
    const req: any = new EventEmitter();
    req.method = "POST";
    req.url = "/v1/chat/completions";
    req.headers = { authorization: "Bearer no-credentials-provided" };

    const handlePromise = (adapter as any).handleRequest(req, res);
    // Push body chunks
    const body = JSON.stringify({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      // No assistant.metadata, no assistant.id mapping, no call.metadata.
      assistant: {},
      call: {},
    });
    req.emit("data", Buffer.from(body));
    req.emit("end");
    await handlePromise;

    expect(res.statusCode).toBe(401);
    expect(am.spawnTurn).not.toHaveBeenCalled();
  });
});
