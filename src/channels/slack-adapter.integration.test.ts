/**
 * KPR-217 integration test: SlackAdapter per-turn path → real AgentManager
 * → (stubbed) AgentRunner → AgentManager finalization (session-store
 * update) → SlackAdapter delivery (gateway.postMessage).
 *
 * Per the plan: the Slack per-turn path bypasses the dispatcher. So this
 * round-trip exercises everything *except* the dispatcher, end-to-end:
 *
 *   inbound message event → spawnTurnForWorkItem → AgentManager.spawnTurn
 *   → AgentRunner.send (stub) → finalizeSpawnResult (session rotation
 *   persistence) → adapter.deliver → gateway.postMessage
 *
 * Lives in its own file so the file-level vi.mock() calls for
 * AgentManager's collaborators don't leak into the black-box
 * `slack-adapter.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../config.js", () => ({
  config: {
    plugins: [],
    modelRouter: { enabled: false },
    memory: { reflectionMinTurns: 3 },
  },
}));

vi.mock("../plugins/plugin-loader.js", () => ({
  loadPlugins: vi.fn().mockReturnValue([]),
}));

vi.mock("./model-router.js" as never, () => ({
  routeModel: vi.fn(),
}));

vi.mock("../files/file-processor.js", () => ({
  formatFilesForPrompt: vi.fn().mockReturnValue(""),
}));

const mockRunnerSend = vi.fn();
vi.mock("../agents/agent-runner.js", () => ({
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
vi.mock("../search/conversation-index.js", () => ({
  ConversationIndex: vi.fn().mockImplementation(() => ({ index: mockConversationIndex })),
}));

import { AgentManager } from "../agents/agent-manager.js";
import { SlackAdapter } from "./slack-adapter.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { IncomingMessage } from "../types/agent-config.js";
import type { SlackGateway } from "../slack/slack-gateway.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeAgentConfig(): AgentConfig {
  return {
    id: "rae",
    name: "Rae",
    model: "claude-haiku-4-5",
    channels: ["general"],
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
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
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

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

function makeGatewayStub() {
  let messageHandler: MessageHandler | null = null;
  const setThreadStatus = vi.fn().mockResolvedValue(undefined);
  const postMessage = vi.fn().mockResolvedValue(undefined);

  const gateway = {
    onMessage: (h: MessageHandler) => {
      messageHandler = h;
    },
    onThreadStarted: () => {},
    onThreadContextChanged: () => {},
    addIntegrationChannels: () => {},
    setThreadStatus,
    postMessage,
    resolveUserName: vi.fn(async (u: string) => u),
    setSuggestedPrompts: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    client: {} as unknown as SlackGateway["client"],
  };

  return {
    gateway: gateway as unknown as SlackGateway,
    setThreadStatus,
    postMessage,
    emit: async (msg: IncomingMessage) => {
      if (!messageHandler) throw new Error("onMessage handler not registered");
      await messageHandler(msg);
    },
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
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

describe("SlackAdapter per-turn round-trip integration (KPR-217)", () => {
  let agentManager: AgentManager;
  let sessionMap: Map<string, string>;
  let sessionStore: any;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionMap = new Map();
    sessionStore = {
      get: vi.fn(async (a: string, t: string) => sessionMap.get(`${a}:${t}`)),
      set: vi.fn(async (a: string, t: string, s: string) => {
        sessionMap.set(`${a}:${t}`, s);
      }),
      delete: vi.fn(),
      clearAgent: vi.fn(),
      findAgentByThread: vi.fn(async () => undefined),
    };

    const registry = {
      get: vi.fn((id: string) => (id === "rae" ? makeAgentConfig() : undefined)),
      getAll: () => [makeAgentConfig()],
      listIds: () => ["rae"],
      findByChannel: vi.fn((ch: string) => (ch === "general" ? makeAgentConfig() : undefined)),
      getSubscriberMap: vi.fn().mockReturnValue({}),
    };

    const memoryManager = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    agentManager = new AgentManager(registry as any, memoryManager as any, sessionStore, undefined as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips an inbound Slack message: emit → spawnTurn → AgentRunner → deliver → gateway.postMessage", async () => {
    mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "ack-1", sessionId: "session-A" }));

    const gw = makeGatewayStub();
    const adapter = new SlackAdapter(gw.gateway, agentManager["registry"], [], "slack", "rae", undefined, {
      agentManager,
      perTurnSpawnEnabled: true,
    });
    await adapter.start(vi.fn());

    await gw.emit({
      text: "first turn",
      channel: "C100",
      channelName: "general",
      user: "U999",
      ts: "1000.001",
    });
    await waitFor(() => gw.postMessage.mock.calls.length === 1);

    // AgentRunner was invoked once; the work item text was passed as the prompt.
    expect(mockRunnerSend).toHaveBeenCalledTimes(1);
    const [prompt, sessionArg, , bgContext] = mockRunnerSend.mock.calls[0]!;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("first turn");
    expect(sessionArg).toBeUndefined(); // first turn — no resume
    expect(bgContext).toMatchObject({
      channelKind: "slack",
      channelId: "C100",
      threadId: "slack:C100:1000.001",
      slackTs: "1000.001",
    });

    // SessionStore.set persisted the new id under the Slack thread key.
    const threadKey = `rae:slack:C100:1000.001`;
    expect(sessionMap.get(threadKey)).toBe("session-A");

    // gateway.postMessage went out with the agent's reply text.
    expect(gw.postMessage).toHaveBeenCalledTimes(1);
    const [postChannel, postText, postThread] = gw.postMessage.mock.calls[0]!;
    expect(postChannel).toBe("C100");
    expect(postText).toContain("ack-1");
    expect(postThread).toBe("1000.001");
  });

  it("two consecutive turns persist a rotated session id (compaction sim)", async () => {
    mockRunnerSend
      .mockResolvedValueOnce(makeRunResult({ text: "ack-1", sessionId: "session-A" }))
      .mockResolvedValueOnce(makeRunResult({ text: "ack-2", sessionId: "session-B", compactions: 1 }));

    const gw = makeGatewayStub();
    const adapter = new SlackAdapter(gw.gateway, agentManager["registry"], [], "slack", "rae", undefined, {
      agentManager,
      perTurnSpawnEnabled: true,
    });
    await adapter.start(vi.fn());

    // Turn 1
    await gw.emit({
      text: "first",
      channel: "C200",
      channelName: "general",
      user: "U999",
      ts: "2000.001",
    });
    await waitFor(() => gw.postMessage.mock.calls.length === 1);

    const threadKey = `rae:slack:C200:2000.001`;
    expect(sessionMap.get(threadKey)).toBe("session-A");

    // Turn 2 — same thread (threadTs pinned to first message ts)
    await gw.emit({
      text: "second",
      channel: "C200",
      channelName: "general",
      user: "U999",
      ts: "2000.002",
      threadTs: "2000.001",
    });
    await waitFor(() => gw.postMessage.mock.calls.length === 2);

    expect(mockRunnerSend).toHaveBeenCalledTimes(2);
    // Turn 2 resumed against session-A...
    const [, secondResume] = mockRunnerSend.mock.calls[1]!;
    expect(secondResume).toBe("session-A");
    // ...and the rotation to session-B was persisted.
    expect(sessionMap.get(threadKey)).toBe("session-B");
    const turn2Text = gw.postMessage.mock.calls[1]![1] as string;
    expect(turn2Text).toContain("ack-2");
  });
});
