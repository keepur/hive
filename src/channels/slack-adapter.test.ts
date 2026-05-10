import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { SlackAdapter, type SlackAdapterPerTurnDeps } from "./slack-adapter.js";
import type { AgentManager, TurnContext, TurnResult } from "../agents/agent-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { SlackGateway } from "../slack/slack-gateway.js";
import type { IncomingMessage } from "../types/agent-config.js";
import type { WorkItem } from "../types/work-item.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

interface GatewayStub {
  gateway: SlackGateway;
  emit: (msg: IncomingMessage) => Promise<void>;
  setThreadStatus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  resolveUserName: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeGatewayStub(): GatewayStub {
  let messageHandler: MessageHandler | null = null;
  const setThreadStatus = vi.fn().mockResolvedValue(undefined);
  const postMessage = vi.fn().mockResolvedValue(undefined);
  const resolveUserName = vi.fn(async (u: string) => u);
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);

  const gateway = {
    onMessage: (h: MessageHandler) => {
      messageHandler = h;
    },
    onThreadStarted: () => {},
    onThreadContextChanged: () => {},
    addIntegrationChannels: () => {},
    setThreadStatus,
    postMessage,
    resolveUserName,
    setSuggestedPrompts: vi.fn().mockResolvedValue(undefined),
    start,
    stop,
    client: {} as unknown as SlackGateway["client"],
  };

  return {
    gateway: gateway as unknown as SlackGateway,
    setThreadStatus,
    postMessage,
    resolveUserName,
    start,
    stop,
    emit: async (msg) => {
      if (!messageHandler) throw new Error("onMessage handler not registered");
      await messageHandler(msg);
    },
  };
}

interface RegistryStubOpts {
  /** Map of channel-name → agent definition (channels[0] picks owner) */
  channelAgents?: Record<string, { id: string; name?: string; disabled?: boolean }>;
  /** Map of agent id → agent definition (looked up by `get(id)`) */
  agents?: Record<string, { id: string; name?: string; disabled?: boolean; icon?: string }>;
}

function makeRegistryStub(opts: RegistryStubOpts = {}): AgentRegistry {
  const byChannel = opts.channelAgents ?? {};
  const byId: Record<string, { id: string; name?: string; disabled?: boolean; icon?: string }> = {
    ...(opts.agents ?? {}),
  };
  // Hoist channel-defined agents into the id map so registry.get(id) works.
  for (const a of Object.values(byChannel)) byId[a.id] = byId[a.id] ?? a;

  const stub = {
    get: vi.fn((id: string) => byId[id]),
    getAll: vi.fn(() => Object.values(byId)),
    findByChannel: vi.fn((channel: string) => byChannel[channel]),
  };
  return stub as unknown as AgentRegistry;
}

function makeAgentManagerStub(turnResult: Partial<TurnResult> = {}) {
  const calls: Array<{ ctx: TurnContext }> = [];

  const sessionStore = {
    get: vi.fn().mockResolvedValue(undefined as string | undefined),
    set: vi.fn().mockResolvedValue(undefined),
  };

  const spawnTurn = vi.fn(async (ctx: TurnContext) => {
    calls.push({ ctx });
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

  const findAgentForThread = vi.fn().mockResolvedValue(undefined as string | undefined);

  const stub: Pick<AgentManager, "spawnTurn" | "findAgentForThread" | "getSessionStore"> = {
    spawnTurn: spawnTurn as unknown as AgentManager["spawnTurn"],
    findAgentForThread: findAgentForThread as unknown as AgentManager["findAgentForThread"],
    getSessionStore: () => sessionStore as unknown as ReturnType<AgentManager["getSessionStore"]>,
  };

  return { stub: stub as AgentManager, spawnTurn, findAgentForThread, sessionStore, calls };
}

function makeIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    text: "hello agents",
    channel: "C123",
    channelName: "general",
    user: "U123",
    ts: "100.001",
    ...overrides,
  };
}

// The per-turn branch in onMessage is fire-and-forget (spawnTurnForWorkItem
// is called without await + a trailing .catch). After emitting we need to
// wait for the spawn microtask chain to drain. waitFor polls a predicate.
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SlackAdapter (KPR-217)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("legacy path (perTurn deps absent or perTurnSpawnEnabled=false)", () => {
    it("falls back to onWorkItem when perTurn deps are not provided", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({
        channelAgents: { general: { id: "rae" } },
      });
      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack");
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      await gw.emit(makeIncomingMessage());

      expect(onWorkItem).toHaveBeenCalledTimes(1);
      const item = onWorkItem.mock.calls[0]![0] as WorkItem;
      expect(item.text).toBe("hello agents");
      expect(item.threadId).toBe("slack:C123:100.001");
    });

    it("falls back to onWorkItem when perTurnSpawnEnabled=false", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({ channelAgents: { general: { id: "rae" } } });
      const { stub: agentManager, spawnTurn } = makeAgentManagerStub();

      const perTurn: SlackAdapterPerTurnDeps = { agentManager, perTurnSpawnEnabled: false };
      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "rae", undefined, perTurn);
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      await gw.emit(makeIncomingMessage());

      expect(onWorkItem).toHaveBeenCalledTimes(1);
      expect(spawnTurn).not.toHaveBeenCalled();
    });
  });

  describe("per-turn path (perTurnSpawnEnabled=true)", () => {
    it("invokes agentManager.spawnTurn with correct TurnContext and skips onWorkItem", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({
        channelAgents: { general: { id: "rae", name: "Rae" } },
      });
      const {
        stub: agentManager,
        spawnTurn,
        calls,
        sessionStore,
      } = makeAgentManagerStub({
        finalMessage: "All systems nominal.",
      });
      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "rae", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      await gw.emit(makeIncomingMessage());
      await waitFor(() => gw.postMessage.mock.calls.length > 0);

      expect(onWorkItem).not.toHaveBeenCalled();
      expect(spawnTurn).toHaveBeenCalledTimes(1);

      const ctx = calls[0]!.ctx;
      expect(ctx.agentId).toBe("rae");
      expect(ctx.channel).toBe("slack");
      expect(ctx.channelId).toBe("C123");
      expect(ctx.threadId).toBe("slack:C123:100.001");
      expect(ctx.sessionId).toBeUndefined();
      expect(ctx.workItem.text).toBe("hello agents");

      // Session store consulted with the resolved (agentId, threadId).
      expect(sessionStore.get).toHaveBeenCalledWith("rae", "slack:C123:100.001");

      // Delivery posted via gateway.postMessage with the agent's reply text.
      expect(gw.postMessage).toHaveBeenCalledTimes(1);
      const [postChannel, postText, postThread] = gw.postMessage.mock.calls[0]!;
      expect(postChannel).toBe("C123");
      expect(postText).toContain("All systems nominal.");
      expect(postText).toContain("Rae");
      expect(postThread).toBe("100.001");
    });

    it("prefers thread-continuity agent over channel binding and default", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({
        channelAgents: { general: { id: "channel-owner" } },
        agents: { rae: { id: "rae" } },
      });
      const { stub: agentManager, findAgentForThread, calls } = makeAgentManagerStub();
      findAgentForThread.mockResolvedValueOnce("rae");

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "fallback-default", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage());
      await waitFor(() => calls.length > 0);

      expect(findAgentForThread).toHaveBeenCalledWith("slack:C123:100.001");
      expect(calls[0]!.ctx.agentId).toBe("rae");
    });

    it("falls through to channel binding when no thread continuity exists", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({
        channelAgents: { general: { id: "channel-owner" } },
      });
      const { stub: agentManager, calls } = makeAgentManagerStub();

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "fallback-default", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage());
      await waitFor(() => calls.length > 0);

      expect(calls[0]!.ctx.agentId).toBe("channel-owner");
    });

    it("falls back to defaultAgentId when no thread continuity and no channel binding", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({
        agents: { "default-agent": { id: "default-agent" } },
      });
      const { stub: agentManager, calls } = makeAgentManagerStub();

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "default-agent", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage({ channelName: "untracked-channel" }));
      await waitFor(() => calls.length > 0);

      expect(calls[0]!.ctx.agentId).toBe("default-agent");
    });

    it("drops cleanly with no spawn when no agent resolves", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub();
      const { stub: agentManager, spawnTurn } = makeAgentManagerStub();

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", undefined, undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage({ channelName: "no-owner" }));
      // Give the fire-and-forget chain a moment to settle.
      await new Promise((r) => setImmediate(r));

      expect(spawnTurn).not.toHaveBeenCalled();
      expect(gw.postMessage).not.toHaveBeenCalled();
      expect(gw.setThreadStatus).not.toHaveBeenCalled();
    });

    it("forwards stored sessionId so the SDK can resume on subsequent turns", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({ channelAgents: { general: { id: "rae" } } });
      const { stub: agentManager, calls, sessionStore } = makeAgentManagerStub();
      sessionStore.get.mockResolvedValueOnce("session-resume-xyz");

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "rae", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage());
      await waitFor(() => calls.length > 0);

      expect(calls[0]!.ctx.sessionId).toBe("session-resume-xyz");
    });

    it("sets Thinking… before spawn and clears it in finally on success", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({ channelAgents: { general: { id: "rae" } } });
      const { stub: agentManager } = makeAgentManagerStub();

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "rae", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage({ ts: "777.001" }));
      await waitFor(() => gw.setThreadStatus.mock.calls.length >= 2);

      // Two calls: set "Thinking..." then clear.
      const calls = gw.setThreadStatus.mock.calls.map((c) => c[2]);
      expect(calls).toEqual(["Thinking...", ""]);
    });

    it("clears Thinking… status even when spawnTurn throws", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({ channelAgents: { general: { id: "rae" } } });
      const { stub: agentManager, spawnTurn } = makeAgentManagerStub();
      spawnTurn.mockRejectedValueOnce(new Error("boom"));

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "rae", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      // emit catches the rejected promise via the .catch in the onMessage branch.
      await gw.emit(makeIncomingMessage({ ts: "999.001" }));
      await waitFor(() => gw.setThreadStatus.mock.calls.length >= 2);

      const calls = gw.setThreadStatus.mock.calls.map((c) => c[2]);
      expect(calls).toContain("Thinking...");
      expect(calls).toContain("");
    });

    it("suppresses status interception for integration messages (sender starts with B)", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({ channelAgents: { general: { id: "rae" } } });
      const { stub: agentManager } = makeAgentManagerStub();

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "rae", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage({ user: "B007BOT" }));
      await waitFor(() => gw.postMessage.mock.calls.length > 0);

      expect(gw.setThreadStatus).not.toHaveBeenCalled();
    });

    it("skips delivery when finalMessage is empty (no postMessage, status still cleared)", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({ channelAgents: { general: { id: "rae" } } });
      const { stub: agentManager } = makeAgentManagerStub({ finalMessage: "" });

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "rae", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage());
      await waitFor(() => gw.setThreadStatus.mock.calls.length >= 2);

      expect(gw.postMessage).not.toHaveBeenCalled();
      expect(gw.setThreadStatus).toHaveBeenCalledTimes(2);
    });

    it("delivers with WorkResult.error populated when spawnTurn returns errors[]", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({ channelAgents: { general: { id: "rae" } } });
      const { stub: agentManager } = makeAgentManagerStub({
        finalMessage: "partial response",
        errors: ["something went wrong"],
      });

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "rae", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage());
      await waitFor(() => gw.postMessage.mock.calls.length > 0);

      // postMessage was called — error path uses formatError, not partial response text.
      expect(gw.postMessage).toHaveBeenCalledTimes(1);
      const postedText = gw.postMessage.mock.calls[0]![1] as string;
      // formatError produces a Slack-formatted error string; just sanity-check it
      // contains the underlying message.
      expect(postedText).toContain("something went wrong");
    });

    it("does not thread the reply for integration messages", async () => {
      const gw = makeGatewayStub();
      const registry = makeRegistryStub({ channelAgents: { general: { id: "rae" } } });
      const { stub: agentManager } = makeAgentManagerStub({ finalMessage: "ack" });

      const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "rae", undefined, {
        agentManager,
        perTurnSpawnEnabled: true,
      });
      await adapter.start(vi.fn());

      await gw.emit(makeIncomingMessage({ user: "integration", ts: "300.001" }));
      await waitFor(() => gw.postMessage.mock.calls.length > 0);

      // No status calls (integration), and reply not threaded.
      expect(gw.setThreadStatus).not.toHaveBeenCalled();
      expect(gw.postMessage).toHaveBeenCalledTimes(1);
      const replyThread = gw.postMessage.mock.calls[0]![2];
      expect(replyThread).toBeUndefined();
    });
  });
});
