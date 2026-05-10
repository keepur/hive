/**
 * KPR-218 integration test: WsAdapter per-turn path → real AgentManager
 * → (stubbed) AgentRunner → AgentManager finalization (session-store
 * update) → WsAdapter delivery (real WebSocketServer → real ws client).
 *
 * Per the plan: the WS per-turn path bypasses the dispatcher. So this
 * round-trip exercises everything *except* the dispatcher, end-to-end:
 *
 *   real ws client → upgrade → message handler → spawnTurnForWorkItem →
 *   AgentManager.spawnTurn → AgentRunner.send (stub) → finalizeSpawnResult
 *   (session rotation persistence) → adapter.deliver → real ws client receive
 *
 * Lives in its own file so the file-level vi.mock() calls for AgentManager's
 * collaborators don't leak into the black-box ws-adapter.test.ts.
 *
 * Uses port: 0 (OS-assigned ephemeral) so parallel test runs never collide;
 * the assigned port is read off `adapter.listeningPort` post-start.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../config.js", () => ({
  config: {
    plugins: [],
    modelRouter: { enabled: false },
    memory: { reflectionMinTurns: 3 },
  },
}));

vi.mock("../../plugins/plugin-loader.js", () => ({
  loadPlugins: vi.fn().mockReturnValue([]),
}));

vi.mock("../model-router.js" as never, () => ({
  routeModel: vi.fn(),
}));

vi.mock("../../files/file-processor.js", () => ({
  formatFilesForPrompt: vi.fn().mockReturnValue(""),
  processImageBuffer: vi.fn(),
  processFileBuffer: vi.fn(),
}));

const mockRunnerSend = vi.fn();
vi.mock("../../agents/agent-runner.js", () => ({
  AgentRunner: vi.fn().mockImplementation(() => ({
    send: mockRunnerSend,
    abort: vi.fn(),
    wasAborted: false,
  })),
  DIST_DIR: "/mock/dist",
}));

const { mockConversationIndex } = vi.hoisted(() => ({
  mockConversationIndex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../search/conversation-index.js", () => ({
  ConversationIndex: vi.fn().mockImplementation(() => ({ index: mockConversationIndex })),
}));

import { AgentManager } from "../../agents/agent-manager.js";
import { WsAdapter } from "./ws-adapter.js";
import type { AgentConfig } from "../../types/agent-config.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeAgentConfig(): AgentConfig {
  return {
    id: "rae",
    name: "Rae",
    aliases: [],
    roles: [],
    model: "claude-haiku-4-5",
    channels: [],
    passiveChannels: [],
    keywords: [],
    isDefault: true,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    coreServers: ["memory"],
    delegateServers: [],
    icon: "",
    soul: "",
    systemPrompt: "",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false } as any,
  };
}

function makeRunResult(overrides: { text?: string; sessionId: string; compactions?: number }) {
  return {
    text: overrides.text ?? "ack",
    sessionId: overrides.sessionId,
    costUsd: 0.01,
    durationMs: 100,
    llmMs: 80,
    toolMs: 20,
    toolCalls: 0,
    toolSummary: "none",
    streamed: false,
    aborted: false,
    inputTokens: 50,
    outputTokens: 25,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindow: 200000,
    compactions: overrides.compactions ?? 0,
  };
}

interface ClientHelper {
  ws: WebSocket;
  received: any[];
  waitForMessage: (pred: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
  send: (msg: any) => void;
  close: () => Promise<void>;
}

async function connectClient(port: number, deviceId: string, label = "Shop"): Promise<ClientHelper> {
  const url = `ws://127.0.0.1:${port}/?internal=1&deviceId=${encodeURIComponent(deviceId)}&label=${encodeURIComponent(label)}`;
  const ws = new WebSocket(url);
  const received: any[] = [];
  // Attach the message listener immediately so any frames that arrive
  // during the upgrade (e.g. server-side drain on reconnect) are captured.
  ws.on("message", (data) => {
    try {
      received.push(JSON.parse(data.toString()));
    } catch {
      // ignore
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    received,
    async waitForMessage(pred, timeoutMs = 1500) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = received.find(pred);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`waitForMessage timed out after ${timeoutMs}ms`);
    },
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          ws.once("close", () => resolve());
          ws.close();
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WsAdapter per-turn round-trip integration (KPR-218)", () => {
  let adapter: WsAdapter;
  let agentManager: AgentManager;
  let sessionMap: Map<string, string>;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    sessionMap = new Map();
    const sessionStore: any = {
      get: vi.fn(async (a: string, t: string) => sessionMap.get(`${a}:${t}`)),
      set: vi.fn(async (a: string, t: string, s: string) => {
        sessionMap.set(`${a}:${t}`, s);
      }),
      delete: vi.fn(),
      clearAgent: vi.fn(),
      findAgentByThread: vi.fn(async () => undefined),
    };

    const registry: any = {
      get: vi.fn((id: string) => (id === "rae" ? makeAgentConfig() : undefined)),
      getAll: () => [makeAgentConfig()],
      listIds: () => ["rae"],
      findByOrigin: vi.fn(() => undefined),
      findByChannel: vi.fn(() => undefined),
      getSubscriberMap: vi.fn().mockReturnValue({}),
    };

    const memoryManager: any = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    agentManager = new AgentManager(registry, memoryManager, sessionStore, undefined as any);

    const teamStore: any = {
      getChannel: vi.fn().mockResolvedValue(null),
      listChannels: vi.fn().mockResolvedValue([]),
      getHistory: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
      saveMessage: vi.fn().mockResolvedValue(undefined),
      getOrCreateDm: vi.fn(),
      renameChannel: vi.fn(),
      joinChannel: vi.fn(),
      leaveChannel: vi.fn(),
    };
    const commandRegistry: any = {
      has: vi.fn().mockReturnValue(false),
      list: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockResolvedValue({ found: false }),
    };

    adapter = new WsAdapter(0, {
      teamStore,
      commandRegistry,
      agentRegistry: registry,
      agentManager,
      defaultAgentId: "rae",
      perTurn: { perTurnSpawnEnabled: true },
    });
    await adapter.start(() => {});
    port = adapter.listeningPort;
  });

  afterEach(async () => {
    if (adapter) await adapter.stop();
    vi.unstubAllGlobals();
  });

  it("round-trips an inbound message: client → spawnTurn → AgentRunner → deliver → client receives typing + message", async () => {
    mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "ack-1", sessionId: "session-A" }));

    const client = await connectClient(port, "dev1");
    client.send({ type: "message", id: "m1", text: "first turn" });

    const typing = await client.waitForMessage((m) => m.type === "typing");
    expect(typing.agentId).toBe("rae");

    const reply = await client.waitForMessage((m) => m.type === "message" && m.replyTo === "m1");
    expect(reply.text).toBe("ack-1");
    expect(reply.agentId).toBe("rae");

    // SessionStore.set persisted the new id under the WS thread key.
    expect(sessionMap.get("rae:app:dev1")).toBe("session-A");

    // AgentRunner was invoked once with the work item text.
    expect(mockRunnerSend).toHaveBeenCalledTimes(1);
    const [prompt, sessionArg, , bgContext] = mockRunnerSend.mock.calls[0]!;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("first turn");
    expect(sessionArg).toBeUndefined(); // first turn — no resume
    expect(bgContext).toMatchObject({
      channelKind: "app",
      channelId: "dev1",
      threadId: "app:dev1",
    });

    await client.close();
  });

  it("two consecutive turns persist a rotated session id (compaction sim)", async () => {
    mockRunnerSend
      .mockResolvedValueOnce(makeRunResult({ text: "ack-1", sessionId: "session-A" }))
      .mockResolvedValueOnce(makeRunResult({ text: "ack-2", sessionId: "session-B", compactions: 1 }));

    const client = await connectClient(port, "dev2");

    client.send({ type: "message", id: "m1", text: "first" });
    await client.waitForMessage((m) => m.type === "message" && m.replyTo === "m1");

    expect(sessionMap.get("rae:app:dev2")).toBe("session-A");

    client.send({ type: "message", id: "m2", text: "second" });
    await client.waitForMessage((m) => m.type === "message" && m.replyTo === "m2");

    expect(mockRunnerSend).toHaveBeenCalledTimes(2);
    // Turn 2 resumed against session-A...
    const [, secondResume] = mockRunnerSend.mock.calls[1]!;
    expect(secondResume).toBe("session-A");
    // ...and the rotation to session-B was persisted.
    expect(sessionMap.get("rae:app:dev2")).toBe("session-B");

    await client.close();
  });

  it("disconnect mid-spawn buffers the response; reconnect drains pending", async () => {
    // Slow spawn so we can disconnect before delivery.
    let resolveSpawn: ((v: any) => void) | undefined;
    mockRunnerSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    const client = await connectClient(port, "dev3");
    client.send({ type: "message", id: "m1", text: "queued" });

    // Wait until the spawn is in flight, then disconnect the client.
    await new Promise((r) => setTimeout(r, 50));
    await client.close();

    // Now resolve the spawn — adapter should buffer because the connection
    // was removed on close.
    resolveSpawn!(makeRunResult({ text: "ack-buffered", sessionId: "session-C" }));

    // Wait for the buffer to populate.
    await (async () => {
      const start = Date.now();
      while (Date.now() - start < 1500) {
        const pending = (adapter as any).pendingMessages as Map<string, any[]>;
        if ((pending.get("dev3") ?? []).some((m: any) => m.type === "message")) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("buffered message never arrived");
    })();

    const pending = (adapter as any).pendingMessages as Map<string, any[]>;
    const queued = pending.get("dev3") ?? [];
    const buffered = queued.find((m) => m.type === "message");
    expect(buffered).toBeDefined();
    expect(buffered.text).toBe("ack-buffered");

    // Reconnect — the drain should ship the buffered message immediately.
    const client2 = await connectClient(port, "dev3");
    const drained = await client2.waitForMessage((m) => m.type === "message" && m.text === "ack-buffered");
    expect(drained.agentId).toBe("rae");
    expect(pending.get("dev3")).toBeUndefined();

    await client2.close();
  });
});
