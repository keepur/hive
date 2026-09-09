/**
 * Offline KPR-464 probe.  This uses the real VoiceAdapter HTTP server but
 * holds the predecessor's `res.close` listener until its replacement is
 * admitted.  The controlled ordering represents a delayed predecessor close
 * observation; it never contacts a voice service.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { request as httpRequest, ServerResponse, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../../../src/logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("../../../../src/agents/prompt-builder.js", () => ({
  buildVoiceSystemPrompt: vi.fn(async () => "voice-prompt"),
}));
vi.mock("../../../../src/config.js", () => ({
  config: { anthropic: { apiKey: "test" }, voice: { assistants: {} } },
}));

import { VoiceAdapter } from "../../../../src/channels/voice/voice-adapter.js";
import type { TurnContext, TurnResult } from "../../../../src/agents/agent-manager.js";

const BRIDGE_TOKEN = "probe-token";
const CALL_ID = "same-call";
const THREAD_ID = `voice:${CALL_ID}`;

function requestTurn(port: number): { reached: Promise<void>; destroy: () => void } {
  const payload = JSON.stringify({
    stream: true,
    messages: [{ role: "user", content: "offline probe" }],
    call: { id: CALL_ID, metadata: { hive_agent_id: "mokie" } },
  });
  let reached!: () => void;
  const reachedP = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const req: ClientRequest = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        authorization: `Bearer ${BRIDGE_TOKEN}`,
      },
    },
    (res) => {
      res.on("data", () => reached());
      res.on("error", () => {});
    },
  );
  req.on("error", () => {});
  req.write(payload);
  req.end();
  return { reached: reachedP, destroy: () => req.destroy() };
}

const success = (aborted = false): TurnResult => ({
  finalMessage: "",
  newSessionId: "session",
  errors: [],
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindow: 1,
    costUsd: 0,
    durationMs: 0,
  },
  aborted,
});

describe("KPR-464 delayed predecessor close", () => {
  let adapter: VoiceAdapter | undefined;
  let restoreOn: (() => void) | undefined;

  afterEach(() => {
    restoreOn?.();
    adapter?.stop();
    adapter = undefined;
  });

  it("routes a held predecessor close to the replacement through thread-only abortThread", async () => {
    const heldCloseListeners: Array<() => void> = [];
    const originalOn = ServerResponse.prototype.on;
    // The real adapter registers this listener before its first await.  Hold
    // it so an actual client disconnect can be delivered after request 2.
    ServerResponse.prototype.on = function (event: string, listener: (...args: any[]) => void) {
      if (event === "close") {
        heldCloseListeners.push(listener);
        return this;
      }
      return originalOn.call(this, event, listener);
    } as typeof ServerResponse.prototype.on;
    restoreOn = () => {
      ServerResponse.prototype.on = originalOn;
    };

    const active: TurnContext[] = [];
    const pending = new Map<TurnContext, (aborted?: boolean) => void>();
    const cancelled: TurnContext[] = [];
    const aborts: Array<{ agentId: string; threadId: string; victim?: TurnContext }> = [];
    const agentManager: any = {
      getSessionStore: () => ({ get: async () => undefined, set: async () => {} }),
      providerFor: () => "claude",
      spawnTurn: (ctx: TurnContext, onStream?: (chunk: string) => void) =>
        new Promise<TurnResult>((resolve) => {
          active.push(ctx);
          // Headers/first SSE byte make the HTTP request observable while its
          // engine work stays pending.
          onStream?.("working");
          pending.set(ctx, (aborted = false) => resolve(success(aborted)));
        }),
      abortThread: (agentId: string, threadId: string) => {
        // Models existing `abortThread(agentId, threadId)`: choosing current
        // work by this key cannot distinguish the predecessor from a newer
        // request for the same call.
        const victim = active.at(-1);
        aborts.push({ agentId, threadId, victim });
        if (victim) {
          cancelled.push(victim);
          pending.get(victim)?.(true);
        }
        return Boolean(victim);
      },
    };
    const registry: any = { get: (id: string) => (id === "mokie" ? { id, model: "claude-sonnet-4-6" } : undefined) };
    const memoryManager: any = {};
    adapter = new VoiceAdapter(0, "shared-secret", BRIDGE_TOKEN, registry, memoryManager, agentManager);
    await adapter.start();
    const port = ((adapter as any).httpServer.address() as AddressInfo).port;

    const predecessor = requestTurn(port);
    await predecessor.reached;
    predecessor.destroy(); // actual socket disconnect; close callback is held above
    await new Promise((resolve) => setImmediate(resolve));
    expect(heldCloseListeners).toHaveLength(1);

    const replacement = requestTurn(port);
    await replacement.reached;
    expect(active).toHaveLength(2); // replacement is admitted before old close is delivered

    heldCloseListeners[0]!();
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatchObject({ agentId: "mokie", threadId: THREAD_ID, victim: active[1] });
    expect(cancelled).toEqual([active[1]]);

    // Settle the remaining pending handler so the probe does not leak work.
    for (const finish of pending.values()) finish();
    replacement.destroy();
  });
});
