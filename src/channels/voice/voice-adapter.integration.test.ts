/**
 * KPR-219 integration test: VoiceAdapter per-turn-via-AgentManager path.
 * Real HTTP server + real client POST + mock AgentManager. Asserts the
 * full first-turn / resume-turn round-trip with SSE byte-level checks.
 *
 * Lives in its own file (mirrors ws-adapter.integration.test.ts) so the
 * file-level vi.mock() calls for the SDK and config don't leak into the
 * black-box voice-adapter.test.ts.
 *
 * Uses port: 0 (OS-assigned ephemeral) so parallel test runs never collide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Stub the SDK — the per-turn-via-AgentManager path doesn't reach `query()`,
// but the import at the top of voice-adapter.ts does.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../agents/prompt-builder.js", () => ({
  buildVoiceSystemPrompt: vi.fn(async (_a: any, _m: any, ctx: any) => {
    return `voice-prompt:${ctx?.goal ?? ""}:${ctx?.context ?? ""}`;
  }),
}));

const configRef = {
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

import { VoiceAdapter } from "./voice-adapter.js";
import type { TurnContext, TurnResult } from "../../agents/agent-manager.js";
import type { Dispatcher } from "../dispatcher.js";

interface CapturedSpawn {
  ctx: TurnContext;
  onStream?: (chunk: string) => void;
}

function makeAdapter(opts: {
  /** Resolved by spawnTurn; behavior may include onStream chunks. */
  spawn: (ctx: TurnContext, onStream?: (chunk: string) => void) => Promise<TurnResult>;
  /** What the session-store returns on get(agentId, threadId). */
  storedSessionId?: string;
  /**
   * KPR-223: optional dispatcher mock. When provided, the adapter is
   * constructed with the 6-arg form so voice turns route through
   * `dispatcher.routeVoiceTurn` instead of directly through
   * `agentManager.spawnTurn`. Omit to keep the legacy fallback wiring.
   */
  dispatcher?: Dispatcher;
}) {
  const captured: CapturedSpawn[] = [];
  const sessionStoreGet = vi.fn().mockResolvedValue(opts.storedSessionId);
  const sessionStoreSet = vi.fn().mockResolvedValue(undefined);

  const spawnTurn = vi.fn(async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
    captured.push({ ctx, onStream });
    return await opts.spawn(ctx, onStream);
  });

  const registry: any = {
    get: vi.fn((id: string) =>
      id === "mokie" ? { id: "mokie", name: "Mokie", model: "claude-sonnet-4-5" } : undefined,
    ),
  };
  const memoryManager: any = {
    read: vi.fn().mockResolvedValue(""),
    getHotTierPrompt: vi.fn().mockResolvedValue(""),
  };
  const agentManager: any = {
    spawnTurn,
    getSessionStore: () => ({ get: sessionStoreGet, set: sessionStoreSet }),
  };

  const adapter = opts.dispatcher
    ? new VoiceAdapter(0, "shared-secret", registry, memoryManager, agentManager, opts.dispatcher)
    : new VoiceAdapter(0, "shared-secret", registry, memoryManager, agentManager);
  return { adapter, captured, sessionStoreGet, sessionStoreSet, spawnTurn };
}

function postChatCompletion(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; headers: IncomingMessage["headers"]; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req: ClientRequest = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          // Vapi default — auth comes from assistant.metadata.hive_agent_id.
          authorization: "Bearer no-credentials-provided",
        },
      },
      (res) => {
        const chunks: string[] = [];
        res.on("data", (c) => chunks.push(c.toString("utf-8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, chunks }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("VoiceAdapter integration (KPR-219)", () => {
  let adapter: VoiceAdapter | undefined;
  let port: number = 0;

  afterEach(async () => {
    if (adapter) {
      adapter.stop();
      adapter = undefined;
    }
    vi.clearAllMocks();
  });

  async function startAdapter(setup: ReturnType<typeof makeAdapter>): Promise<number> {
    adapter = setup.adapter;
    await adapter.start();
    const httpServer = (adapter as any).httpServer as { address: () => AddressInfo };
    const addr = httpServer.address();
    port = addr.port;
    return port;
  }

  it("first turn (no stored sessionId) — full transcript prompt + streaming SSE chunks", async () => {
    const setup = makeAdapter({
      spawn: async (_ctx, onStream) => {
        // Emit a couple of chunks before resolving.
        onStream?.("Hi ");
        onStream?.("there!");
        return {
          finalMessage: "Hi there!",
          newSessionId: "first-session-id",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: 200000,
            costUsd: 0,
            durationMs: 50,
          },
          errors: [],
        };
      },
    });

    const p = await startAdapter(setup);

    const res = await postChatCompletion(p, {
      model: "voice-mock",
      stream: true,
      messages: [
        { role: "system", content: "you are mokie" },
        { role: "user", content: "Hello?" },
      ],
      assistant: { metadata: { hive_agent_id: "mokie" } },
      call: { id: "call-int-1", metadata: { goal: "say hi" } },
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const joined = res.chunks.join("");
    expect(joined).toContain('"content":"Hi "');
    expect(joined).toContain('"content":"there!"');
    expect(joined).toContain("[DONE]");

    // First turn: no stored sessionId, full transcript prompt path.
    expect(setup.captured).toHaveLength(1);
    const ctx = setup.captured[0]!.ctx;
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.workItem.text).toContain("Caller: Hello?");
    expect(ctx.systemPromptOverride).toBe("voice-prompt:say hi:");
    expect(ctx.threadId).toBe("voice:call-int-1");
    expect(ctx.channel).toBe("voice");
  });

  it("second turn (resume from session-store) — latest-user-message prompt", async () => {
    const setup = makeAdapter({
      storedSessionId: "stored-from-first-turn",
      spawn: async (_ctx, onStream) => {
        onStream?.("Sure thing.");
        return {
          finalMessage: "Sure thing.",
          newSessionId: "stored-from-first-turn", // session id can rotate; here unchanged
          usage: {
            inputTokens: 10,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: 200000,
            costUsd: 0,
            durationMs: 50,
          },
          errors: [],
        };
      },
    });

    const p = await startAdapter(setup);

    const res = await postChatCompletion(p, {
      model: "voice-mock",
      stream: true,
      messages: [
        { role: "user", content: "first turn user message" },
        { role: "assistant", content: "first turn agent reply" },
        { role: "user", content: "follow-up question" },
      ],
      assistant: { metadata: { hive_agent_id: "mokie" } },
      call: { id: "call-int-2" },
    });

    expect(res.status).toBe(200);
    expect(setup.captured).toHaveLength(1);
    const ctx = setup.captured[0]!.ctx;
    expect(ctx.sessionId).toBe("stored-from-first-turn");
    // Resume path uses ONLY the latest user message — earlier turns are in
    // the SDK's session memory.
    expect(ctx.workItem.text).toBe("follow-up question");

    // SSE byte assertions.
    const joined = res.chunks.join("");
    expect(joined).toContain('"content":"Sure thing."');
    expect(joined).toContain("[DONE]");
  });

  it("routes through dispatcher.routeVoiceTurn end-to-end (KPR-223)", async () => {
    // KPR-223: when the adapter is wired with a Dispatcher, voice turns must
    // hit `dispatcher.routeVoiceTurn` (which threads taskLedger + audit log)
    // instead of falling back to `agentManager.spawnTurn` directly. The mock
    // dispatcher delegates to the same spawnTurn so the SSE byte round-trip
    // still completes — proving the dispatcher path is fully wired without
    // altering observable streaming behavior.

    // Forward-ref box so the dispatcher closure can reach setup.spawnTurn —
    // dispatcher is invoked only after the HTTP POST hits, well after
    // makeAdapter returns and we populate the box.
    const setupBox: { current: ReturnType<typeof makeAdapter> | undefined } = { current: undefined };
    const routeVoiceTurn = vi.fn(async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
      return await setupBox.current!.spawnTurn(ctx, onStream);
    });
    const dispatcher = { routeVoiceTurn } as unknown as Dispatcher;

    const setup = makeAdapter({
      spawn: async (_ctx, onStream) => {
        onStream?.("via ");
        onStream?.("dispatcher");
        return {
          finalMessage: "via dispatcher",
          newSessionId: "dispatcher-session-id",
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: 200000,
            costUsd: 0,
            durationMs: 25,
          },
          errors: [],
        };
      },
      dispatcher,
    });
    setupBox.current = setup;

    const p = await startAdapter(setup);

    const res = await postChatCompletion(p, {
      model: "voice-mock",
      stream: true,
      messages: [
        { role: "system", content: "you are mokie" },
        { role: "user", content: "Test dispatcher routing" },
      ],
      assistant: { metadata: { hive_agent_id: "mokie" } },
      call: { id: "call-int-3", metadata: { goal: "verify dispatcher" } },
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    // Dispatcher.routeVoiceTurn was called exactly once with the same
    // TurnContext shape the agentManager.spawnTurn fallback would have seen.
    expect(routeVoiceTurn).toHaveBeenCalledTimes(1);
    const dispatchCtx = routeVoiceTurn.mock.calls[0]![0] as TurnContext;
    expect(dispatchCtx.agentId).toBe("mokie");
    expect(dispatchCtx.channel).toBe("voice");
    expect(dispatchCtx.threadId).toBe("voice:call-int-3");

    // SSE round-trip still completes through the dispatcher path.
    const joined = res.chunks.join("");
    expect(joined).toContain('"content":"via "');
    expect(joined).toContain('"content":"dispatcher"');
    expect(joined).toContain("[DONE]");

    // Inner spawnTurn was reached via the dispatcher delegation.
    expect(setup.spawnTurn).toHaveBeenCalledTimes(1);
  });
});
