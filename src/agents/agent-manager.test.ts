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

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    sessionStore = makeMockSessionStore();
    memoryManager = makeMockMemoryManager();

    // Default mock: runner.send resolves with a result
    mockRunnerSend.mockResolvedValue(makeRunResult());

    manager = new AgentManager(registry as any, memoryManager as any, sessionStore as any);
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
        model: "claude-opus-4-6",
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
        "claude-opus-4-6",
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
});
