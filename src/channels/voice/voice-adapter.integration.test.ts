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
    agentManager: { perTurnSpawn: { voice: true, sms: false, slack: false, ws: false } },
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

interface CapturedSpawn {
  ctx: TurnContext;
  onStream?: (chunk: string) => void;
}

function makeAdapter(opts: {
  /** Resolved by spawnTurn; behavior may include onStream chunks. */
  spawn: (ctx: TurnContext, onStream?: (chunk: string) => void) => Promise<TurnResult>;
  /** What the session-store returns on get(agentId, threadId). */
  storedSessionId?: string;
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

  const adapter = new VoiceAdapter(0, "shared-secret", registry, memoryManager, agentManager);
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
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, chunks }),
        );
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

  beforeEach(() => {
    configRef.current.agentManager.perTurnSpawn.voice = true;
  });

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
});
