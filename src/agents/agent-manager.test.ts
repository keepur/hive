import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock logger
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock config
vi.mock("../config.js", () => ({
  config: {
    plugins: [],
    modelRouter: { enabled: false },
    memory: { reflectionMinTurns: 3 },
  },
}));

// Mock plugin loader
vi.mock("../plugins/plugin-loader.js", () => ({
  loadPlugins: vi.fn().mockReturnValue([]),
}));

// Mock model router
vi.mock("./model-router.js", () => ({
  routeModel: vi.fn(),
}));

// Mock file processor
vi.mock("../files/file-processor.js", () => ({
  formatFilesForPrompt: vi.fn().mockReturnValue(""),
}));

// Mock AgentRunner - need to capture instances
const mockRunnerSend = vi.fn();
const mockRunnerAbort = vi.fn();
vi.mock("./agent-runner.js", () => ({
  AgentRunner: vi.fn().mockImplementation(() => ({
    send: mockRunnerSend,
    abort: mockRunnerAbort,
    wasAborted: false,
  })),
  // Re-exported from agent-runner for plugin-loader path resolution; the test
  // manager doesn't use it, so a sentinel path is fine.
  DIST_DIR: "/mock/dist",
}));

// Mock conversation index (hoisted because ConversationIndex is instantiated at module level)
const { mockConversationIndex } = vi.hoisted(() => ({
  mockConversationIndex: vi.fn(),
}));
vi.mock("../search/conversation-index.js", () => ({
  ConversationIndex: vi.fn().mockImplementation(() => ({
    index: mockConversationIndex,
  })),
}));

import { AgentManager } from "./agent-manager.js";
import { config as appConfig } from "../config.js";
import type { RunResult } from "./agent-runner.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { WorkItem } from "../types/work-item.js";
import { routeModel } from "./model-router.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    name: "TestAgent",
    model: "claude-haiku-4-5",
    channels: [],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    coreServers: ["memory"],
    delegateServers: [],
    icon: "",
    soul: "",
    systemPrompt: "",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}

let workItemCounter = 0;

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  workItemCounter++;
  return {
    id: `msg-${workItemCounter}-${Date.now()}-${Math.random()}`,
    text: "test message",
    source: { kind: "slack", id: "C123", label: "general" },
    sender: "user1",
    timestamp: new Date(),
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}) {
  return {
    text: "response",
    sessionId: "session-1",
    costUsd: 0.01,
    durationMs: 1000,
    llmMs: 800,
    toolMs: 200,
    toolCalls: 1,
    toolSummary: "memory:1x/0.2s",
    streamed: false,
    aborted: false,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    contextWindow: 200000,
    compactions: 0,
    ...overrides,
  };
}

function makeMockRegistry() {
  const agents = new Map<string, AgentConfig>();
  agents.set("agent-a", makeAgentConfig({ id: "agent-a", name: "AgentA", maxConcurrent: 2 }));
  agents.set("agent-b", makeAgentConfig({ id: "agent-b", name: "AgentB" }));

  return {
    get: vi.fn().mockImplementation((id: string) => agents.get(id)),
    getAll: () => Array.from(agents.values()),
    listIds: () => Array.from(agents.keys()),
    getSubscriberMap: vi.fn().mockReturnValue({}),
    _agents: agents,
  };
}

function makeMockSessionStore() {
  const sessions = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation(async (agentId: string, threadId: string) => {
      return sessions.get(`${agentId}:${threadId}`);
    }),
    set: vi.fn().mockImplementation(async (agentId: string, threadId: string, sessionId: string, _tokenData?: any) => {
      sessions.set(`${agentId}:${threadId}`, sessionId);
    }),
    delete: vi.fn(),
    clearAgent: vi.fn(),
    findAgentByThread: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockTurnTelemetryStore() {
  return {
    record: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockMemoryManager() {
  return {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
}

describe("AgentManager", () => {
  let manager: AgentManager;
  let registry: ReturnType<typeof makeMockRegistry>;
  let sessionStore: ReturnType<typeof makeMockSessionStore>;
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;
  let turnTelemetryStore: ReturnType<typeof makeMockTurnTelemetryStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    sessionStore = makeMockSessionStore();
    memoryManager = makeMockMemoryManager();
    turnTelemetryStore = makeMockTurnTelemetryStore();

    // Default mock: runner.send resolves with a result
    mockRunnerSend.mockResolvedValue(makeRunResult());

    manager = new AgentManager(
      registry as any,
      memoryManager as any,
      sessionStore as any,
      undefined as any,
      turnTelemetryStore as any,
    );
  });

  describe("sendMessage", () => {
    it("sends message to agent and returns result", async () => {
      const item = makeWorkItem();
      const result = await manager.sendMessage("agent-a", item);

      expect(result.text).toBe("response");
      expect(result.sessionId).toBe("session-1");
      expect(mockRunnerSend).toHaveBeenCalledTimes(1);
    });

    it("saves session after successful response", async () => {
      const threadId = `thread-${Date.now()}`;
      const item = makeWorkItem({ threadId });
      await manager.sendMessage("agent-a", item);

      expect(sessionStore.set).toHaveBeenCalledWith("agent-a", threadId, "session-1", {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        contextWindow: 200000,
        compactions: 0,
        preCompactTokens: undefined,
      });
    });

    it("does not save session when aborted", async () => {
      mockRunnerSend.mockResolvedValue(makeRunResult({ aborted: true }));

      const threadId = `thread-aborted-${Date.now()}`;
      const item = makeWorkItem({ threadId });
      await manager.sendMessage("agent-a", item);

      expect(sessionStore.set).not.toHaveBeenCalled();
    });

    it("updates agent state after processing", async () => {
      const item = makeWorkItem();
      await manager.sendMessage("agent-a", item);

      const state = manager.getState("agent-a");
      expect(state).toBeDefined();
      expect(state!.messagesProcessed).toBe(1);
      expect(state!.status).toBe("idle");
    });

    it("increments error count on runner error", async () => {
      mockRunnerSend.mockResolvedValue(makeRunResult({
        text: "",
        error: "something broke",
        costUsd: 0,
        durationMs: 100,
        llmMs: 100,
        toolMs: 0,
        toolCalls: 0,
        toolSummary: "none",
      }));

      const item = makeWorkItem();
      await manager.sendMessage("agent-a", item);

      const state = manager.getState("agent-a");
      expect(state!.errorCount).toBe(1);
    });

    it("uses message id as threadId when threadId is absent", async () => {
      const item = makeWorkItem({ threadId: undefined });
      await manager.sendMessage("agent-a", item);

      // Session should be saved with message id as thread key
      expect(sessionStore.set).toHaveBeenCalledWith("agent-a", item.id, "session-1", {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        contextWindow: 200000,
        compactions: 0,
        preCompactTokens: undefined,
      });
    });

    it("records per-turn cache telemetry after a successful turn", async () => {
      const item = makeWorkItem();
      await manager.sendMessage("agent-a", item);
      // The promise is fire-and-forget — give it a microtask to settle.
      await Promise.resolve();
      expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
      const arg = turnTelemetryStore.record.mock.calls[0][0];
      expect(arg.agentId).toBe("agent-a");
      expect(arg.cacheReadTokens).toBe(10);
      expect(arg.cacheCreationTokens).toBe(5);
      expect(arg.inputTokens).toBe(100);
    });

    it("does not record telemetry when the turn was aborted", async () => {
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ aborted: true }));
      const item = makeWorkItem();
      await manager.sendMessage("agent-a", item);
      await Promise.resolve();
      expect(turnTelemetryStore.record).not.toHaveBeenCalled();
    });

    it("increments error count on runner throw", async () => {
      mockRunnerSend.mockRejectedValue(new Error("runner crash"));

      const item = makeWorkItem();
      await expect(manager.sendMessage("agent-a", item)).rejects.toThrow("runner crash");

      const state = manager.getState("agent-a");
      expect(state!.errorCount).toBe(1);
    });
  });

  describe("concurrency limiting", () => {
    it("respects maxConcurrent limit", async () => {
      // agent-a has maxConcurrent: 2
      const resolvers: (() => void)[] = [];
      mockRunnerSend.mockImplementation(() => {
        return new Promise<any>((resolve) => {
          resolvers.push(() => resolve(makeRunResult()));
        });
      });

      // Send 3 messages on different threads
      const p1 = manager.sendMessage("agent-a", makeWorkItem({ threadId: "t1" }));
      const p2 = manager.sendMessage("agent-a", makeWorkItem({ threadId: "t2" }));
      const p3 = manager.sendMessage("agent-a", makeWorkItem({ threadId: "t3" }));

      // Wait a tick for queues to process
      await new Promise((r) => setTimeout(r, 10));

      // Only 2 should be processing (maxConcurrent: 2)
      expect(mockRunnerSend).toHaveBeenCalledTimes(2);

      // Resolve one
      resolvers[0]!();
      await new Promise((r) => setTimeout(r, 10));

      // Now the third should start
      expect(mockRunnerSend).toHaveBeenCalledTimes(3);

      // Resolve remaining
      resolvers[1]!();
      resolvers[2]!();

      await Promise.all([p1, p2, p3]);
    });

    it("processes messages on same thread serially", async () => {
      const resolvers: (() => void)[] = [];
      mockRunnerSend.mockImplementation(() => {
        return new Promise<any>((resolve) => {
          resolvers.push(() => resolve(makeRunResult()));
        });
      });

      const sharedThread = `serial-thread-${Date.now()}`;
      const p1 = manager.sendMessage("agent-a", makeWorkItem({ threadId: sharedThread }));
      const p2 = manager.sendMessage("agent-a", makeWorkItem({ threadId: sharedThread }));

      await new Promise((r) => setTimeout(r, 10));

      // Only one runner call — second message queued behind first on same thread
      expect(mockRunnerSend).toHaveBeenCalledTimes(1);

      // Resolve first — second should process within the same while loop
      resolvers[0]!();
      await new Promise((r) => setTimeout(r, 10));

      expect(mockRunnerSend).toHaveBeenCalledTimes(2);

      resolvers[1]!();
      await Promise.all([p1, p2]);
    });
  });

  describe("stopAgent", () => {
    it("aborts active runners and sets status to stopped", async () => {
      let resolver: () => void;
      mockRunnerSend.mockImplementation(() => new Promise<any>((r) => {
        resolver = () => r(makeRunResult({ text: "", aborted: true }));
      }));

      const p = manager.sendMessage("agent-a", makeWorkItem());
      await new Promise((r) => setTimeout(r, 10));

      manager.stopAgent("agent-a");
      expect(mockRunnerAbort).toHaveBeenCalled();

      const state = manager.getState("agent-a");
      expect(state!.status).toBe("stopped");

      // Resolve to clean up
      resolver!();
      await p.catch(() => {});
    });

    it("is safe to call on an agent with no active runners", () => {
      // Create state by sending a completed message first
      expect(() => manager.stopAgent("agent-a")).not.toThrow();
    });
  });

  describe("stopAll", () => {
    it("stops all agents that have state", async () => {
      await manager.sendMessage("agent-a", makeWorkItem());
      await manager.sendMessage("agent-b", makeWorkItem());

      manager.stopAll();

      const stateA = manager.getState("agent-a");
      const stateB = manager.getState("agent-b");
      expect(stateA!.status).toBe("stopped");
      expect(stateB!.status).toBe("stopped");
    });
  });

  describe("sweep", () => {
    it("removes zombie states for agents no longer in registry", async () => {
      // Process a message to create state, then let it go idle
      await manager.sendMessage("agent-a", makeWorkItem());
      expect(manager.getState("agent-a")).toBeDefined();

      // Remove agent-a from registry
      registry.get.mockImplementation((id: string) =>
        id === "agent-b" ? makeAgentConfig({ id: "agent-b" }) : undefined
      );

      const result = manager.sweep();
      expect(result.pruned).toBeGreaterThanOrEqual(1);
      expect(manager.getState("agent-a")).toBeUndefined();
    });

    it("does not remove zombie states for processing agents", async () => {
      let resolver: () => void;
      mockRunnerSend.mockImplementation(() => new Promise<any>((r) => {
        resolver = () => r(makeRunResult());
      }));

      const p = manager.sendMessage("agent-a", makeWorkItem());
      await new Promise((r) => setTimeout(r, 10));

      // Remove agent-a from registry while it's processing
      registry.get.mockImplementation((id: string) =>
        id === "agent-b" ? makeAgentConfig({ id: "agent-b" }) : undefined
      );

      const result = manager.sweep();
      // Should NOT prune processing agents
      expect(manager.getState("agent-a")).toBeDefined();
      expect(manager.getState("agent-a")!.status).toBe("processing");

      // Cleanup
      resolver!();
      await p;
    });

    it("returns zero pruned when no zombies", async () => {
      await manager.sendMessage("agent-a", makeWorkItem());
      const result = manager.sweep();
      expect(result.component).toBe("agent-manager");
      expect(result.pruned).toBe(0);
    });

    it("clears stuck processing flags with no active runners", async () => {
      // Send a message so state exists
      await manager.sendMessage("agent-a", makeWorkItem());

      // Manually inject a stuck processing flag
      const processing = (manager as any).processing as Set<string>;
      const stuckKey = "agent-a:stuck-thread";
      processing.add(stuckKey);

      // Add to activeThreads to simulate the stuck condition
      const activeThreads = (manager as any).activeThreads as Map<string, Set<string>>;
      const threadSet = activeThreads.get("agent-a") ?? new Set();
      threadSet.add(stuckKey);
      activeThreads.set("agent-a", threadSet);

      // No runners for agent-a (already cleaned up from the completed message)
      const result = manager.sweep();

      expect(result.pruned).toBeGreaterThanOrEqual(1);
      expect(processing.has(stuckKey)).toBe(false);
    });
  });

  describe("findAgentForThread", () => {
    it("delegates to session store", async () => {
      sessionStore.findAgentByThread.mockResolvedValue("agent-a");
      const result = await manager.findAgentForThread("thread-123");
      expect(result).toBe("agent-a");
      expect(sessionStore.findAgentByThread).toHaveBeenCalledWith("thread-123");
    });

    it("returns undefined when no agent found", async () => {
      const result = await manager.findAgentForThread("unknown-thread");
      expect(result).toBeUndefined();
    });
  });

  describe("restartAgent", () => {
    it("resets agent state and clears sessions", async () => {
      await manager.sendMessage("agent-a", makeWorkItem());
      const stateBefore = manager.getState("agent-a");
      expect(stateBefore!.messagesProcessed).toBe(1);

      manager.restartAgent("agent-a");

      const stateAfter = manager.getState("agent-a");
      expect(stateAfter!.status).toBe("idle");
      expect(stateAfter!.messagesProcessed).toBe(0);
      expect(stateAfter!.errorCount).toBe(0);
      expect(stateAfter!.activeThreadCount).toBe(0);
      expect(sessionStore.clearAgent).toHaveBeenCalledWith("agent-a");
    });

    it("aborts active runners before resetting", async () => {
      let resolver: () => void;
      mockRunnerSend.mockImplementation(() => new Promise<any>((r) => {
        resolver = () => r(makeRunResult({ aborted: true }));
      }));

      const p = manager.sendMessage("agent-a", makeWorkItem());
      await new Promise((r) => setTimeout(r, 10));

      manager.restartAgent("agent-a");
      expect(mockRunnerAbort).toHaveBeenCalled();

      const state = manager.getState("agent-a");
      expect(state!.status).toBe("idle");
      expect(state!.messagesProcessed).toBe(0);

      // Cleanup
      resolver!();
      await p.catch(() => {});
    });
  });

  describe("getAllStates", () => {
    it("returns all agent states", async () => {
      await manager.sendMessage("agent-a", makeWorkItem());
      await manager.sendMessage("agent-b", makeWorkItem());

      const states = manager.getAllStates();
      expect(states).toHaveLength(2);
      expect(states.map((s) => s.id).sort()).toEqual(["agent-a", "agent-b"]);
    });

    it("returns empty array when no agents have state", () => {
      const states = manager.getAllStates();
      expect(states).toEqual([]);
    });
  });

  describe("conversation indexing", () => {
    it("indexes conversation after successful response", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const item = makeWorkItem({
        threadId: "idx-thread",
        senderName: "Alice",
        source: { kind: "slack", id: "C999", label: "general" },
      });

      await manager.sendMessage("agent-a", item);

      // Fire-and-forget — flush microtasks
      await new Promise((r) => setTimeout(r, 10));

      expect(mockConversationIndex).toHaveBeenCalledTimes(1);
      const call = mockConversationIndex.mock.calls[0]![0];
      expect(call.agentId).toBe("agent-a");
      expect(call.threadId).toBe("idx-thread");
      expect(call.channelId).toBe("C999");
      expect(call.source).toBe("slack");
      expect(call.senderName).toBe("Alice");
      expect(call.response).toBe("response");
      expect(call.inbound).toContain("test message");
      expect(call.timestampUnix).toBeTypeOf("number");
      expect(call.timestamp).toBeTypeOf("string");
    });

    it("does NOT index when result has error", async () => {
      mockRunnerSend.mockResolvedValue(makeRunResult({
        text: "partial",
        error: "something broke",
      }));

      const item = makeWorkItem();
      await manager.sendMessage("agent-a", item);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockConversationIndex).not.toHaveBeenCalled();
    });

    it("does NOT index when result.text is empty", async () => {
      mockRunnerSend.mockResolvedValue(makeRunResult({ text: "" }));

      const item = makeWorkItem();
      await manager.sendMessage("agent-a", item);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockConversationIndex).not.toHaveBeenCalled();
    });

    it("indexing failure does not reject the work item", async () => {
      mockConversationIndex.mockRejectedValue(new Error("Qdrant down"));

      const item = makeWorkItem();
      const result = await manager.sendMessage("agent-a", item);

      // Wait for fire-and-forget to settle
      await new Promise((r) => setTimeout(r, 10));

      // The work item resolved successfully despite indexing failure
      expect(result.text).toBe("response");
      expect(mockConversationIndex).toHaveBeenCalledTimes(1);
    });
  });

  describe("end-of-conversation reflection", () => {
    it("sends reflection prompt after qualifying conversation (3+ turns)", async () => {
      const threadId = `thread-reflect-${Date.now()}`;

      // Send 3 messages in the same thread to meet the threshold
      const item1 = makeWorkItem({ threadId });
      const item2 = makeWorkItem({ threadId });
      const item3 = makeWorkItem({ threadId });

      // Queue all three before processing starts
      const p1 = manager.sendMessage("agent-a", item1);
      const p2 = manager.sendMessage("agent-a", item2);
      const p3 = manager.sendMessage("agent-a", item3);

      await Promise.all([p1, p2, p3]);

      // runner.send called 3 times for messages + 1 for reflection = 4
      expect(mockRunnerSend).toHaveBeenCalledTimes(4);

      // The 4th call should be the reflection prompt
      const reflectionCall = mockRunnerSend.mock.calls[3];
      expect(reflectionCall[0]).toContain("end of conversation reflection");
    });

    it("skips reflection for fewer than 3 turns", async () => {
      const threadId = `thread-short-${Date.now()}`;
      const item1 = makeWorkItem({ threadId });
      const item2 = makeWorkItem({ threadId });

      const p1 = manager.sendMessage("agent-a", item1);
      const p2 = manager.sendMessage("agent-a", item2);

      await Promise.all([p1, p2]);

      // Only 2 calls — no reflection
      expect(mockRunnerSend).toHaveBeenCalledTimes(2);
    });

    it("skips reflection for system sender", async () => {
      const threadId = `thread-system-${Date.now()}`;
      const item1 = makeWorkItem({ threadId, sender: "system" });
      const item2 = makeWorkItem({ threadId, sender: "system" });
      const item3 = makeWorkItem({ threadId, sender: "system" });

      const p1 = manager.sendMessage("agent-a", item1);
      const p2 = manager.sendMessage("agent-a", item2);
      const p3 = manager.sendMessage("agent-a", item3);

      await Promise.all([p1, p2, p3]);

      // Only 3 calls — no reflection for system messages
      expect(mockRunnerSend).toHaveBeenCalledTimes(3);
    });

    it("skips reflection when last result has error", async () => {
      const threadId = `thread-error-${Date.now()}`;

      // First two succeed, third errors
      mockRunnerSend
        .mockResolvedValueOnce(makeRunResult())
        .mockResolvedValueOnce(makeRunResult())
        .mockResolvedValueOnce(makeRunResult({ error: "something failed" }));

      const item1 = makeWorkItem({ threadId });
      const item2 = makeWorkItem({ threadId });
      const item3 = makeWorkItem({ threadId });

      const p1 = manager.sendMessage("agent-a", item1);
      const p2 = manager.sendMessage("agent-a", item2);
      const p3 = manager.sendMessage("agent-a", item3);

      await Promise.all([p1, p2, p3]);

      // Only 3 calls — no reflection after error
      expect(mockRunnerSend).toHaveBeenCalledTimes(3);
    });

    it("skips reflection when agent has no memory server", async () => {
      // Register an agent without memory in its servers list
      registry._agents.set(
        "agent-nomem",
        makeAgentConfig({ id: "agent-nomem", name: "NoMem", coreServers: ["slack", "brave-search"] }),
      );
      registry.get.mockImplementation((id: string) => registry._agents.get(id));

      const threadId = `thread-nomem-${Date.now()}`;
      const item1 = makeWorkItem({ threadId });
      const item2 = makeWorkItem({ threadId });
      const item3 = makeWorkItem({ threadId });

      const p1 = manager.sendMessage("agent-nomem", item1);
      const p2 = manager.sendMessage("agent-nomem", item2);
      const p3 = manager.sendMessage("agent-nomem", item3);

      await Promise.all([p1, p2, p3]);

      // Only 3 calls — no reflection for agents without memory server
      expect(mockRunnerSend).toHaveBeenCalledTimes(3);
    });

    it("persists session after reflection", async () => {
      const threadId = `thread-persist-${Date.now()}`;
      const reflectionSessionId = "reflection-session-123";

      // 3 normal results + 1 reflection result with new session
      mockRunnerSend
        .mockResolvedValueOnce(makeRunResult())
        .mockResolvedValueOnce(makeRunResult())
        .mockResolvedValueOnce(makeRunResult({ sessionId: "pre-reflection" }))
        .mockResolvedValueOnce(makeRunResult({ sessionId: reflectionSessionId }));

      const item1 = makeWorkItem({ threadId });
      const item2 = makeWorkItem({ threadId });
      const item3 = makeWorkItem({ threadId });

      const p1 = manager.sendMessage("agent-a", item1);
      const p2 = manager.sendMessage("agent-a", item2);
      const p3 = manager.sendMessage("agent-a", item3);

      await Promise.all([p1, p2, p3]);

      // Session store should have been called with the reflection session ID last
      const setCalls = sessionStore.set.mock.calls;
      const lastSetCall = setCalls[setCalls.length - 1];
      expect(lastSetCall[2]).toBe(reflectionSessionId);
    });
  });

  describe("prompt prefix (KPR-23)", () => {
    // NOTE: ws-adapter emits `source.label: "team:<channel>"` (and `"app:<device>"`
    // for the app path). That prefix is pre-existing and appears verbatim in the
    // prompt — slack-adapter emits a bare channel name, so the display shapes
    // differ across channels. Not KPR-23's job to normalize that.
    it("includes user:<id> in prompt prefix when meta.user is set", async () => {
      const item: WorkItem = {
        id: "m1",
        text: "hey",
        source: { kind: "team", id: "c1", label: "team:general", adapterId: "ws" } as any,
        sender: "dev1",
        senderName: "Shop",
        threadId: "team:c1",
        timestamp: new Date(),
        meta: { deviceId: "dev1", channelId: "c1", user: "may-keepur" },
      };

      await manager.sendMessage("agent-a", item);

      expect(mockRunnerSend).toHaveBeenCalledTimes(1);
      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[user:may-keepur via Shop in #team:general]: hey");
    });

    it("omits user: segment when meta.user is absent", async () => {
      const item: WorkItem = {
        id: "m2",
        text: "hey",
        source: { kind: "team", id: "c1", label: "team:general", adapterId: "ws" } as any,
        sender: "dev1",
        senderName: "Shop",
        threadId: "team:c1",
        timestamp: new Date(),
        meta: { deviceId: "dev1", channelId: "c1" },
      };

      await manager.sendMessage("agent-a", item);

      expect(mockRunnerSend).toHaveBeenCalledTimes(1);
      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[Shop in #team:general]: hey");
    });

    it("ignores meta.user on non-team sources (KPR-27)", async () => {
      const item: WorkItem = {
        id: "m3",
        text: "hey",
        source: { kind: "slack", id: "C123", label: "general" },
        sender: "U999",
        senderName: "Mallory",
        threadId: "t-slack",
        timestamp: new Date(),
        meta: { user: "spoofed-user" },
      };

      await manager.sendMessage("agent-a", item);

      expect(mockRunnerSend).toHaveBeenCalledTimes(1);
      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).not.toContain("user:spoofed-user");
      expect(capturedPrompt).toBe("[Mallory in #general]: hey");
    });
  });

  describe("model router resource limits", () => {
    beforeEach(() => {
      (appConfig as any).modelRouter.enabled = true;
    });

    afterEach(() => {
      (appConfig as any).modelRouter.enabled = false;
    });

    it("passes resource limits from router to runner.send()", async () => {
      const mockRoute = {
        tier: "opus" as const,
        model: "claude-opus-4-7",
        costUsd: 0.001,
        durationMs: 50,
        resourceLimits: { timeoutMs: 600_000, maxTurns: 200, budgetUsd: 50 },
      };
      vi.mocked(routeModel).mockResolvedValue(mockRoute);

      const item = makeWorkItem();
      await manager.sendMessage("agent-a", item);

      expect(mockRunnerSend).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        undefined,
        expect.any(Object),
        "claude-opus-4-7",
        mockRoute.resourceLimits,
      );
    });

    it("passes undefined resource limits when model router is disabled", async () => {
      (appConfig as any).modelRouter.enabled = false;

      const item = makeWorkItem();
      await manager.sendMessage("agent-a", item);

      expect(mockRunnerSend).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        undefined,
        expect.any(Object),
        undefined,
        undefined,
      );
    });
  });

  describe("preamble thread hint (KPR-48)", () => {
    it("includes thread=<ts> from meta.slackThreadTs in senderName branch", async () => {
      const item: WorkItem = {
        id: "kpr48-m1",
        text: "hello",
        source: { kind: "slack", id: "C123", label: "general" },
        sender: "U001",
        senderName: "Alice",
        threadId: "t1",
        timestamp: new Date(),
        meta: { slackThreadTs: "1700000001.000100", slackTs: "1700000002.000200" },
      };

      await manager.sendMessage("agent-a", item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      // slackThreadTs takes priority over slackTs
      expect(capturedPrompt).toBe("[Alice in #general, thread=1700000001.000100]: hello");
    });

    it("falls back to meta.slackTs when slackThreadTs is absent", async () => {
      const item: WorkItem = {
        id: "kpr48-m2",
        text: "hello",
        source: { kind: "slack", id: "C123", label: "general" },
        sender: "U001",
        senderName: "Alice",
        threadId: "t2",
        timestamp: new Date(),
        meta: { slackTs: "1700000003.000300" },
      };

      await manager.sendMessage("agent-a", item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[Alice in #general, thread=1700000003.000300]: hello");
    });

    it("omits thread hint when no slack meta is present", async () => {
      const item: WorkItem = {
        id: "kpr48-m3",
        text: "hello",
        source: { kind: "slack", id: "C123", label: "general" },
        sender: "U001",
        senderName: "Alice",
        threadId: "t3",
        timestamp: new Date(),
        meta: {},
      };

      await manager.sendMessage("agent-a", item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[Alice in #general]: hello");
      expect(capturedPrompt).not.toContain("thread=");
    });

    it("omits thread hint when meta is undefined", async () => {
      const item: WorkItem = {
        id: "kpr48-m4",
        text: "hello",
        source: { kind: "slack", id: "C123", label: "general" },
        sender: "U001",
        senderName: "Alice",
        threadId: "t4",
        timestamp: new Date(),
      };

      await manager.sendMessage("agent-a", item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[Alice in #general]: hello");
      expect(capturedPrompt).not.toContain("thread=");
    });

    it("does NOT add thread hint to team-channel userId branch", async () => {
      // userId branch is a different if-branch; thread hint should not appear there
      const item: WorkItem = {
        id: "kpr48-m5",
        text: "hey",
        source: { kind: "team", id: "c1", label: "team:general", adapterId: "ws" } as any,
        sender: "dev1",
        senderName: "Shop",
        threadId: "team:c1",
        timestamp: new Date(),
        meta: { deviceId: "dev1", channelId: "c1", user: "may-keepur", slackTs: "1700000004.000400" },
      };

      await manager.sendMessage("agent-a", item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      // The userId branch fires; thread hint is not added
      expect(capturedPrompt).toBe("[user:may-keepur via Shop in #team:general]: hey");
      expect(capturedPrompt).not.toContain("thread=");
    });
  });

  describe("getActiveWorkItems (KPR-48)", () => {
    it("returns empty array when agent has no active work", () => {
      expect(manager.getActiveWorkItems("agent-a")).toEqual([]);
    });

    it("tracks a WorkItem while its processing is in-flight", async () => {
      let capturedDuringProcessing: WorkItem[] = [];
      mockRunnerSend.mockImplementation(async () => {
        capturedDuringProcessing = manager.getActiveWorkItems("agent-a");
        return makeRunResult();
      });

      const item = makeWorkItem({ source: { kind: "slack", id: "C123", label: "general" } });
      await manager.sendMessage("agent-a", item);

      expect(capturedDuringProcessing).toHaveLength(1);
      expect(capturedDuringProcessing[0]!.id).toBe(item.id);
      // After completion, the list is cleared
      expect(manager.getActiveWorkItems("agent-a")).toEqual([]);
    });

    it("clears WorkItem from active list after the item throws", async () => {
      mockRunnerSend.mockRejectedValue(new Error("bang"));

      const item = makeWorkItem();
      await expect(manager.sendMessage("agent-a", item)).rejects.toThrow("bang");

      // finally block must have run
      expect(manager.getActiveWorkItems("agent-a")).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // KPR-216: spawnTurn (per-turn-spawn API for SMS — Phase A under KPR-210)
  // ---------------------------------------------------------------------------
  describe("spawnTurn (KPR-216)", () => {
    function smsCtx(overrides: Partial<{
      agentId: string;
      sessionId: string | undefined;
      threadId: string;
      channelId: string;
      text: string;
    }> = {}) {
      const agentId = overrides.agentId ?? "agent-a";
      const threadId = overrides.threadId ?? `sms:line-1:+15551234567`;
      const channelId = overrides.channelId ?? "line-1";
      const workItem = makeWorkItem({
        text: overrides.text ?? "hello over sms",
        threadId,
        source: { kind: "sms" as const, id: channelId, label: "May (CEO)" },
        sender: "+15551234567",
      });
      return {
        agentId,
        sessionId: overrides.sessionId,
        channelId,
        threadId,
        workItem,
        channel: "sms" as const,
      };
    }

    it("returns a TurnResult with finalMessage, newSessionId, and usage on the happy path", async () => {
      mockRunnerSend.mockResolvedValueOnce(
        makeRunResult({ text: "ack", sessionId: "session-sms-1", costUsd: 0.02, durationMs: 350 }),
      );

      const ctx = smsCtx();
      const result = await manager.spawnTurn(ctx);

      expect(result.finalMessage).toBe("ack");
      expect(result.newSessionId).toBe("session-sms-1");
      expect(result.errors).toEqual([]);
      expect(result.usage.costUsd).toBe(0.02);
      expect(result.usage.durationMs).toBe(350);
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);

      // Session-store updated under (agentId, threadId) — keyed on thread, NOT session.
      expect(sessionStore.set).toHaveBeenCalledWith(
        "agent-a",
        ctx.threadId,
        "session-sms-1",
        expect.objectContaining({ inputTokens: 100, outputTokens: 50 }),
      );

      // Underlying runner.send called with the resume id (undefined on first turn) and
      // the SMS WorkItem text + a per-spawn WorkItemContext.
      expect(mockRunnerSend).toHaveBeenCalledTimes(1);
      const [prompt, sessionArg, , bgContext] = mockRunnerSend.mock.calls[0]!;
      expect(prompt).toBe("hello over sms");
      expect(sessionArg).toBeUndefined();
      expect(bgContext).toMatchObject({
        channelKind: "sms",
        channelId: "line-1",
        threadId: ctx.threadId,
      });
    });

    it("forwards `resume` (sessionId) to runner.send when continuing a thread", async () => {
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "same-session" }));
      await manager.spawnTurn(smsCtx({ sessionId: "same-session" }));
      const [, sessionArg] = mockRunnerSend.mock.calls[0]!;
      expect(sessionArg).toBe("same-session");
    });

    it("rejects when the agent is not in the registry", async () => {
      await expect(manager.spawnTurn(smsCtx({ agentId: "no-such-agent" }))).rejects.toThrow(
        /Unknown agent: no-such-agent/,
      );
      expect(mockRunnerSend).not.toHaveBeenCalled();
    });

    it("serializes concurrent spawns on the same (agentId, threadId)", async () => {
      // Two spawns on the same thread should run strictly serially. Capture
      // the start order via a sequence-of-events recorder.
      const events: string[] = [];
      const releasers: Array<() => void> = [];

      mockRunnerSend.mockImplementation((prompt: string) => {
        events.push(`start:${prompt}`);
        return new Promise((resolve) => {
          releasers.push(() => {
            events.push(`finish:${prompt}`);
            resolve(makeRunResult({ text: prompt, sessionId: `s-${prompt}` }));
          });
        });
      });

      const sharedThread = "sms:line-1:+15550000001";
      const p1 = manager.spawnTurn(smsCtx({ threadId: sharedThread, text: "first" }));
      const p2 = manager.spawnTurn(smsCtx({ threadId: sharedThread, text: "second" }));

      // Yield to let p1 grab the lock and start. p2's busy-poll should keep it pending.
      await new Promise((r) => setTimeout(r, 30));
      expect(events).toEqual(["start:first"]);

      // Release p1; p2 must now be allowed to start.
      releasers[0]!();
      await new Promise((r) => setTimeout(r, 60));
      expect(events).toEqual(["start:first", "finish:first", "start:second"]);

      releasers[1]!();
      await Promise.all([p1, p2]);
      expect(events[events.length - 1]).toBe("finish:second");
    });

    it("allows concurrent spawns on different threads of the same agent", async () => {
      // Different threads on the same agent are NOT serialized by the per-thread lock.
      // They are bounded only by the per-agent spawn budget (5 by default).
      let inflight = 0;
      let maxInflight = 0;
      mockRunnerSend.mockImplementation(() => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        return new Promise((resolve) => {
          setTimeout(() => {
            inflight--;
            resolve(makeRunResult());
          }, 30);
        });
      });

      const spawns = [0, 1, 2].map((i) =>
        manager.spawnTurn(smsCtx({ threadId: `sms:line-1:thread-${i}` })),
      );
      await Promise.all(spawns);

      expect(maxInflight).toBeGreaterThanOrEqual(2);
      expect(mockRunnerSend).toHaveBeenCalledTimes(3);
    });

    it("rejects when per-agent spawn budget is exceeded (default 5)", async () => {
      // Park 5 spawns on five distinct threads, then attempt a 6th — it must reject.
      const releasers: Array<() => void> = [];
      mockRunnerSend.mockImplementation(() => {
        return new Promise((resolve) => {
          releasers.push(() => resolve(makeRunResult()));
        });
      });

      const inflight = [0, 1, 2, 3, 4].map((i) =>
        manager.spawnTurn(smsCtx({ threadId: `sms:line-1:budget-${i}` })),
      );
      // Yield enough for all 5 to enter and bump the active count.
      await new Promise((r) => setTimeout(r, 30));
      expect(mockRunnerSend).toHaveBeenCalledTimes(5);

      await expect(
        manager.spawnTurn(smsCtx({ threadId: "sms:line-1:budget-overflow" })),
      ).rejects.toThrow(/Spawn budget exceeded for agent-a/);

      // Drain so the test cleans up.
      releasers.forEach((r) => r());
      await Promise.all(inflight);
    });

    it("releases lock + budget slot on error path so subsequent spawns work", async () => {
      mockRunnerSend.mockRejectedValueOnce(new Error("synthetic SDK boom"));

      await expect(manager.spawnTurn(smsCtx())).rejects.toThrow("synthetic SDK boom");

      // The lock must be released — a second spawn on the same thread should proceed.
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "recovered" }));
      const result = await manager.spawnTurn(smsCtx());
      expect(result.finalMessage).toBe("recovered");
    });

    it("returns errors[] populated when the SDK reports an error result (no throw)", async () => {
      mockRunnerSend.mockResolvedValueOnce(
        makeRunResult({ text: "partial", error: "tool blew up", sessionId: "session-err-1" }),
      );

      const result = await manager.spawnTurn(smsCtx());

      expect(result.errors).toEqual(["tool blew up"]);
      expect(result.finalMessage).toBe("partial");

      const state = manager.getState("agent-a");
      expect(state!.errorCount).toBe(1);
    });

    it("retries once with sessionId stripped on auth-rebuild-resume sentinel", async () => {
      // Mirrors voice-adapter.ts auth-error retry path. First attempt errors with the
      // sentinel; second attempt (without resume) succeeds.
      mockRunnerSend
        .mockResolvedValueOnce(
          makeRunResult({ error: "Could not resolve authentication method", sessionId: "" }),
        )
        .mockResolvedValueOnce(makeRunResult({ text: "ok after retry", sessionId: "session-retry" }));

      const result = await manager.spawnTurn(smsCtx({ sessionId: "stale-session" }));

      expect(mockRunnerSend).toHaveBeenCalledTimes(2);
      const [, firstSession] = mockRunnerSend.mock.calls[0]!;
      const [, secondSession] = mockRunnerSend.mock.calls[1]!;
      expect(firstSession).toBe("stale-session"); // first attempt resumed
      expect(secondSession).toBeUndefined(); // retry stripped resume

      expect(result.finalMessage).toBe("ok after retry");
      expect(result.newSessionId).toBe("session-retry");
    });

    it("does NOT retry when the error is not an auth sentinel", async () => {
      mockRunnerSend.mockResolvedValueOnce(
        makeRunResult({ error: "unrelated tool failure", sessionId: "session-x" }),
      );

      const result = await manager.spawnTurn(smsCtx({ sessionId: "current" }));

      expect(mockRunnerSend).toHaveBeenCalledTimes(1);
      expect(result.errors).toEqual(["unrelated tool failure"]);
    });

    it("persists rotated sessionId across a 3-turn conversation (compaction sim — KPR-211/§R2)", async () => {
      // Turn 1: first turn, no resume — SDK emits session-A.
      // Turn 2: resumed against session-A but SDK rotates to session-B mid-turn (compaction).
      // Turn 3: must resume against session-B, the rotated id.
      mockRunnerSend
        .mockResolvedValueOnce(makeRunResult({ text: "t1", sessionId: "session-A" }))
        .mockResolvedValueOnce(makeRunResult({ text: "t2", sessionId: "session-B" })) // compaction rotated
        .mockResolvedValueOnce(makeRunResult({ text: "t3", sessionId: "session-B" }));

      const threadId = "sms:line-1:rotation";
      const channelId = "line-1";

      // Turn 1
      const sess0 = await sessionStore.get("agent-a", threadId);
      expect(sess0).toBeUndefined();
      const turn1 = await manager.spawnTurn(smsCtx({ threadId, channelId, sessionId: sess0 }));
      expect(turn1.newSessionId).toBe("session-A");
      expect(await sessionStore.get("agent-a", threadId)).toBe("session-A");

      // Turn 2 — adapter resumes against the stored id, SDK rotates inside.
      const sess1 = await sessionStore.get("agent-a", threadId);
      const turn2 = await manager.spawnTurn(smsCtx({ threadId, channelId, sessionId: sess1 }));
      expect(turn2.newSessionId).toBe("session-B");
      // Persistence side has rotated to the new id.
      expect(await sessionStore.get("agent-a", threadId)).toBe("session-B");

      // Turn 3 — adapter resumes against the rotated id.
      const sess2 = await sessionStore.get("agent-a", threadId);
      expect(sess2).toBe("session-B");
      await manager.spawnTurn(smsCtx({ threadId, channelId, sessionId: sess2 }));

      // The third runner.send call resumed against session-B, not the original session-A.
      const [, thirdResume] = mockRunnerSend.mock.calls[2]!;
      expect(thirdResume).toBe("session-B");

      // sessionStore.set was called for each successful turn.
      expect(sessionStore.set).toHaveBeenCalledTimes(3);
    });

    it("does NOT update session-store when the result is aborted", async () => {
      mockRunnerSend.mockResolvedValueOnce(
        makeRunResult({ aborted: true, sessionId: "session-aborted" }),
      );
      await manager.spawnTurn(smsCtx());
      expect(sessionStore.set).not.toHaveBeenCalled();
    });

    it("getSessionStore() exposes the underlying store for adapter use", () => {
      // SmsAdapter.spawnTurnForWorkItem reads via this accessor — must return the
      // same instance (read-only access; spawnTurn is the writer).
      expect(manager.getSessionStore()).toBe(sessionStore);
    });
  });
});
