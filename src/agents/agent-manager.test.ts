import { vi } from "vitest";

const { TEST_HIVE_HOME } = vi.hoisted(() => {
  // KPR-225 F3: isolate HIVE_HOME so AgentManager's loadSkillIndex doesn't
  // rebuild `~/hive/.skill-projections/` on the operator's real default path.
  // vi.hoisted runs BEFORE imports — paths.ts then resolves hiveHome to this
  // temp dir at module-load. Top-of-file `process.env.HIVE_HOME = ...` does
  // NOT work because Vitest hoists ESM imports above top-level statements,
  // so paths.ts evaluates first (per documented failure mode at
  // skill-loader.test.ts:553-554). Use require inside the hoisted callback
  // because vi.hoisted is sync and runs before ESM imports settle.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = mkdtempSync(join(tmpdir(), "hive-agent-manager-test-"));
  process.env.HIVE_HOME = dir;
  return { TEST_HIVE_HOME: dir };
});

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { rmSync } from "node:fs";

afterAll(() => {
  rmSync(TEST_HIVE_HOME, { recursive: true, force: true });
});

// Mock logger — warn is a hoisted shared spy so KPR-311 clamp warnings are
// assertable (cleared by vi.clearAllMocks in beforeEach; nothing else
// asserts on logger calls).
const { mockLogWarn, mockSupportsEffort } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  // KPR-338: real-catalog shape — every haiku-family id is effort-incapable,
  // everything else is capable. Tests override per-case (e.g. off-catalog id).
  mockSupportsEffort: vi.fn((m: string) => !m.includes("haiku")),
}));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// KPR-338: prepareSpawn consults getLLMRegistry().supportsEffort to decide the
// haiku/effort-capability skip. Mock the registry surface only.
vi.mock("../llm/registry.js", () => ({
  getLLMRegistry: () => ({ supportsEffort: mockSupportsEffort }),
}));

// Mock config
vi.mock("../config.js", () => ({
  config: {
    plugins: [],
    openai: { agentModel: "" },
    codex: { agentModel: "gpt-5.4-mini" },
    gemini: { agentModel: "" },
    modelRouter: { enabled: false },
    memory: { reflectionMinTurns: 3 },
  },
}));

// Mock plugin loader
vi.mock("../plugins/plugin-loader.js", () => ({
  loadPlugins: vi.fn().mockReturnValue([]),
}));

// Mock model router. KPR-338: spread-original — agent-manager.ts now imports
// modelToTier + resolveResourceLimits as runtime values (the static-limits
// pins assert real resolution math), so only routeModel is stubbed.
vi.mock("./model-router.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  routeModel: vi.fn(),
}));

// Mock file processor
vi.mock("../files/file-processor.js", () => ({
  formatFilesForPrompt: vi.fn().mockReturnValue(""),
}));

// Mock AgentRunner - need to capture instances
const mockRunnerSend = vi.fn();
const mockRunnerAbort = vi.fn();
const mockRunnerToolInventory = vi.fn().mockReturnValue([]);
vi.mock("./agent-runner.js", () => ({
  AgentRunner: vi.fn().mockImplementation(() => ({
    send: mockRunnerSend,
    abort: mockRunnerAbort,
    wasAborted: false,
    buildToolTransportInventory: mockRunnerToolInventory,
    // KPR-348: assembleProviderTurn now carries in-process servers + session cwd.
    buildInProcessServers: vi.fn().mockReturnValue({}),
    resolveTurnCwd: vi.fn().mockReturnValue("/tmp/kpr348-test-cwd"),
    // KPR-349: the seam now delegates instruction assembly to the runner.
    // Content-agnostic stub — instruction CONTENT is pinned in
    // agent-runner.test.ts / turn-assembly.test.ts; these manager tests pin
    // ROUTING (adapter selection, inventory partition, memory/skillIndex shape).
    buildProviderPrompt: vi.fn(async () => ({
      instructions: "PILOT-ASSEMBLED-INSTRUCTIONS",
      skillEntries: [],
    })),
  })),
  // Re-exported from agent-runner for plugin-loader path resolution; the test
  // manager doesn't use it, so a sentinel path is fine.
  DIST_DIR: "/mock/dist",
}));

const {
  mockCodexConstructor, mockCodexRunTurn, mockCodexAbort,
  mockOpenAIConstructor, mockOpenAIRunTurn, mockOpenAIAbort,
  mockGeminiConstructor, mockGeminiRunTurn, mockGeminiAbort,
} = vi.hoisted(() => ({
  mockCodexConstructor: vi.fn(),
  mockCodexRunTurn: vi.fn(),
  mockCodexAbort: vi.fn(),
  mockOpenAIConstructor: vi.fn(),
  mockOpenAIRunTurn: vi.fn(),
  mockOpenAIAbort: vi.fn(),
  mockGeminiConstructor: vi.fn(),
  mockGeminiRunTurn: vi.fn(),
  mockGeminiAbort: vi.fn(),
}));

vi.mock("./provider-adapters/codex-subscription-adapter.js", () => ({
  CodexSubscriptionAdapter: vi.fn().mockImplementation((options) => {
    mockCodexConstructor(options);
    return {
      provider: "codex",
      runTurn: mockCodexRunTurn,
      abort: mockCodexAbort,
      wasAborted: false,
    };
  }),
}));

vi.mock("./provider-adapters/openai-agents-adapter.js", () => ({
  OpenAIAgentsAdapter: vi.fn().mockImplementation((options) => {
    mockOpenAIConstructor(options);
    return {
      provider: "openai",
      runTurn: mockOpenAIRunTurn,
      abort: mockOpenAIAbort,
      wasAborted: false,
    };
  }),
}));

vi.mock("./provider-adapters/gemini-adk-adapter.js", () => ({
  GeminiAdkAdapter: vi.fn().mockImplementation((options) => {
    mockGeminiConstructor(options);
    return {
      provider: "gemini",
      runTurn: mockGeminiRunTurn,
      abort: mockGeminiAbort,
      wasAborted: false,
    };
  }),
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

import { AgentManager, type TurnContext } from "./agent-manager.js";
import { config as appConfig } from "../config.js";
import type { RunResult } from "./agent-runner.js";
import type { AgentConfig } from "../types/agent-config.js";
import { ProviderCircuitBreakerRegistry, ProviderCircuitOpenError } from "./provider-circuit-breaker.js";
import type { WorkItem } from "../types/work-item.js";
import { routeModel, RESOURCE_TIER_DEFAULTS } from "./model-router.js";
import type { ModelRouterResult } from "./model-router.js";
import type { AgentProviderId } from "./provider-adapters/types.js";

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

function makeRouterResult(overrides: Partial<ModelRouterResult> = {}): ModelRouterResult {
  return { costUsd: 0.001, durationMs: 50, method: "model", ...overrides };
}

/**
 * KPR-220 Phase 10: shared spawnTurn ctx helper (replaces sendMessage in tests
 * that need to drive a turn through the manager without caring about
 * channel-specific shaping). Defaults to SMS so the channel carve-outs in
 * `prepareSpawn` stay consistent — voice's systemPromptOverride is its own
 * separate path.
 */
function makeSmsCtx(
  overrides: Partial<{
    agentId: string;
    sessionId: string | undefined;
    threadId: string;
    channelId: string;
    text: string;
    workItem: WorkItem;
  }> = {},
): TurnContext {
  const agentId = overrides.agentId ?? "agent-a";
  const threadId = overrides.threadId ?? `sms:line-1:+15551234567:${Math.random()}`;
  const channelId = overrides.channelId ?? "line-1";
  const workItem =
    overrides.workItem ??
    makeWorkItem({
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

function makeMockRegistry() {
  const agents = new Map<string, AgentConfig>();
  agents.set("agent-a", makeAgentConfig({ id: "agent-a", name: "AgentA", maxConcurrent: 2 }));
  agents.set("agent-b", makeAgentConfig({ id: "agent-b", name: "AgentB" }));
  // KPR-338: sonnet-static fixture — the haiku default (agent-a) now SKIPS the
  // classifier, so every router-on/model-path test must run on agent-s.
  agents.set("agent-s", makeAgentConfig({ id: "agent-s", name: "AgentS", model: "claude-sonnet-4-6" }));

  return {
    get: vi.fn().mockImplementation((id: string) => agents.get(id)),
    getAll: () => Array.from(agents.values()),
    listIds: () => Array.from(agents.keys()),
    getSubscriberMap: vi.fn().mockReturnValue({}),
    _agents: agents,
  };
}

function makeMockSessionStore() {
  // KPR-313: records mirror the real store's rows; get() applies the same
  // ""-⇒-undefined normalization the real choke point does.
  const sessions = new Map<string, { sessionId: string; provider: string }>();
  return {
    get: vi.fn().mockImplementation(async (agentId: string, threadId: string) => {
      const rec = sessions.get(`${agentId}:${threadId}`);
      if (!rec) return undefined;
      return { sessionId: rec.sessionId || undefined, provider: rec.provider };
    }),
    set: vi.fn().mockImplementation(
      async (agentId: string, threadId: string, sessionId: string, provider: string, _tokenData?: any) => {
        sessions.set(`${agentId}:${threadId}`, { sessionId, provider });
      },
    ),
    delete: vi.fn(),
    clearAgent: vi.fn(),
    findAgentByThread: vi.fn().mockImplementation(async (threadId: string) => {
      for (const key of sessions.keys()) {
        if (key.endsWith(`:${threadId}`)) return key.slice(0, key.length - threadId.length - 1);
      }
      return undefined;
    }),
    _sessions: sessions,
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
    // KPR-338: clearAllMocks resets call history but not implementations —
    // re-establish the real-catalog default so a per-test override (D1) can't
    // leak into the next test.
    mockSupportsEffort.mockImplementation((m: string) => !m.includes("haiku"));
    workItemCounter = 0;
    registry = makeMockRegistry();
    sessionStore = makeMockSessionStore();
    memoryManager = makeMockMemoryManager();
    turnTelemetryStore = makeMockTurnTelemetryStore();

    // Default mock: runner.send resolves with a result
    mockRunnerSend.mockResolvedValue(makeRunResult());
    mockRunnerToolInventory.mockReturnValue([]);
    mockCodexRunTurn.mockResolvedValue(makeRunResult({ text: "codex response", sessionId: "codex-session" }));
    mockOpenAIRunTurn.mockResolvedValue(makeRunResult({ text: "openai response", sessionId: "openai-session" }));
    mockGeminiRunTurn.mockResolvedValue(makeRunResult({ text: "gemini response", sessionId: "gemini-session" }));

    manager = new AgentManager(
      registry as any,
      memoryManager as any,
      sessionStore as any,
      undefined as any,
      turnTelemetryStore as any,
    );
  });

  // KPR-220 Phase 10: `sendMessage` + `processThreadQueue` + `concurrency
  // limiting (maxConcurrent)` + `end-of-conversation reflection` describe
  // blocks deleted. Coverage is now in the `spawnTurn (KPR-216)` describe
  // (happy path, session save, aborted, telemetry) and the per-agent budget
  // tests further down (replaces concurrency-limiting). Phase 6 reflection
  // tests in the spawnTurn block replace the legacy reflection block.

  describe("stopAll (Phase 10)", () => {
    it("stops all agents that have state", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-b" }));

      manager.stopAll();

      const stateA = manager.getState("agent-a");
      const stateB = manager.getState("agent-b");
      expect(stateA!.status).toBe("stopped");
      expect(stateB!.status).toBe("stopped");
    });
  });

  describe("sweep (Phase 10)", () => {
    it("removes zombie states for agents no longer in registry", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Spawn to create state, then let it go idle
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
      expect(manager.getState("agent-a")).toBeDefined();

      // Remove agent-a from registry
      registry.get.mockImplementation((id: string) =>
        id === "agent-b" ? makeAgentConfig({ id: "agent-b" }) : undefined,
      );

      const result = manager.sweep();
      expect(result.pruned).toBeGreaterThanOrEqual(1);
      expect(manager.getState("agent-a")).toBeUndefined();
    });

    it("does not remove zombie states for processing agents", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      let resolver: () => void;
      mockRunnerSend.mockImplementation(
        () =>
          new Promise<any>((r) => {
            resolver = () => r(makeRunResult());
          }),
      );

      const p = manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
      await new Promise((r) => setTimeout(r, 10));

      // Remove agent-a from registry while it's processing
      registry.get.mockImplementation((id: string) =>
        id === "agent-b" ? makeAgentConfig({ id: "agent-b" }) : undefined,
      );

      const result = manager.sweep();
      // Should NOT prune processing agents (status === "processing", not idle/stopped)
      expect(manager.getState("agent-a")).toBeDefined();
      expect(manager.getState("agent-a")!.status).toBe("processing");

      // Cleanup
      resolver!();
      await p;
    });

    it("returns zero pruned when no zombies", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
      const result = manager.sweep();
      expect(result.component).toBe("agent-manager");
      expect(result.pruned).toBe(0);
    });

    it("KPR-220 Phase 10: zombie removal uses activeTickets (not legacy activeRunners)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Inject a state and an entry in activeTickets to simulate registry-removed
      // agent that still has a stale ticket set (defensive cleanup path).
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
      const activeTickets = (manager as any).activeTickets as Map<string, Set<unknown>>;
      activeTickets.set("agent-a", new Set([{ workItem: makeWorkItem() } as any]));

      // Drop agent-a from registry; its state status is "idle" so sweep prunes it.
      registry.get.mockImplementation((id: string) =>
        id === "agent-b" ? makeAgentConfig({ id: "agent-b" }) : undefined,
      );
      const result = manager.sweep();
      expect(result.pruned).toBeGreaterThanOrEqual(1);
      expect(activeTickets.has("agent-a")).toBe(false);
    });

    it("KPR-220 Phase 10: simplified stuck-flag detection clears processing without activeSpawnKeys match", async () => {
      // Manually inject a `processing` entry without any matching activeSpawnKeys
      // — this simulates the (post-HOF) impossible case where withSpawnTicket
      // crashes between adding to `processing` and `activeSpawnKeys`. Sweep is
      // the safety net.
      const processing = (manager as any).processing as Set<string>;
      const stuckKey = "agent-a:stuck-thread";
      processing.add(stuckKey);

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
      mockConversationIndex.mockResolvedValue(undefined);
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
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
      mockRunnerSend.mockImplementation(
        () =>
          new Promise<any>((r) => {
            resolver = () => r(makeRunResult({ aborted: true }));
          }),
      );

      const p = manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
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
      mockConversationIndex.mockResolvedValue(undefined);
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-b" }));

      const states = manager.getAllStates();
      expect(states).toHaveLength(2);
      expect(states.map((s) => s.id).sort()).toEqual(["agent-a", "agent-b"]);
    });

    it("returns empty array when no agents have state", () => {
      const states = manager.getAllStates();
      expect(states).toEqual([]);
    });
  });

  // KPR-220 Phase 10: legacy `conversation indexing` and `end-of-conversation
  // reflection` describe blocks deleted. Phase 6 reflection tests in the
  // spawnTurn (KPR-216) describe cover the post-quiescence reflection
  // semantics. Conversation indexing call shape is implicitly exercised by
  // the spawnTurn happy-path tests (recordSpawnObservability fires when the
  // mock resolves; absence of explicit assertions there is acceptable
  // because the indexer is fire-and-forget and tested at the lower layer
  // in conversation-index.test.ts).

  describe("prompt prefix (KPR-23)", () => {
    // NOTE: ws-adapter emits `source.label: "team:<channel>"` (and `"app:<device>"`
    // for the app path). That prefix is pre-existing and appears verbatim in the
    // prompt — slack-adapter emits a bare channel name, so the display shapes
    // differ across channels. Not KPR-23's job to normalize that.
    it("includes user:<id> in prompt prefix when meta.user is set", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
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

      await manager.spawnTurn({
        agentId: "agent-a",
        sessionId: undefined,
        channelId: "c1",
        threadId: "team:c1",
        workItem: item,
        channel: "team",
      });

      expect(mockRunnerSend).toHaveBeenCalledTimes(1);
      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[user:may-keepur via Shop in #team:general]: hey");
    });

    it("omits user: segment when meta.user is absent", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
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

      await manager.spawnTurn({
        agentId: "agent-a",
        sessionId: undefined,
        channelId: "c1",
        threadId: "team:c1",
        workItem: item,
        channel: "team",
      });

      expect(mockRunnerSend).toHaveBeenCalledTimes(1);
      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[Shop in #team:general]: hey");
    });

    it("ignores meta.user on non-team sources (KPR-27)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
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

      await manager.spawnTurn({
        agentId: "agent-a",
        sessionId: undefined,
        channelId: "C123",
        threadId: "t-slack",
        workItem: item,
        channel: "slack",
      });

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

    it("delivers STATIC-tier limits on the router-on path (KPR-338)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Effort-only result (KPR-338) — the router no longer names tier/model/
      // limits: the turn's model is the agent's static model, limits are
      // static-tier, resolved in prepareSpawn regardless of the router output.
      vi.mocked(routeModel).mockResolvedValue(makeRouterResult());

      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-s" }));

      const [, , , , resourceLimits] = mockRunnerSend.mock.calls[0]!;
      // Position 4 (limits) = agent-s's STATIC sonnet tier, not the routed junk.
      expect(resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
    });

    it("merges per-agent resourceTiers overrides into the static limits (KPR-338)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      registry._agents.set(
        "agent-s-override",
        makeAgentConfig({
          id: "agent-s-override",
          name: "AgentSOverride",
          model: "claude-sonnet-4-6",
          resourceTiers: { sonnet: { budgetUsd: 2 } },
        }),
      );
      vi.mocked(routeModel).mockResolvedValue(makeRouterResult());

      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-s-override" }));

      const [, , , , resourceLimits] = mockRunnerSend.mock.calls[0]!;
      expect(resourceLimits).toEqual({ timeoutMs: 300_000, maxTurns: 50, budgetUsd: 2 });
    });

    it("haiku-static agent skips the classifier — haiku-tier limits, no effort (KPR-338, replaces H1)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // agent-a's default model is claude-haiku-4-5 → staticTier haiku → skip.
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));

      expect(routeModel).not.toHaveBeenCalled();
      const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
      expect(resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.haiku);
      expect(effort).toBeUndefined();
    });

    it("off-catalog effort-incapable model: skip + warn-once across turns (KPR-338 D1/D2)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Non-haiku-named id (staticTier resolves to the sonnet default) that the
      // catalog reports effort-incapable — the D1 warn-once path.
      mockSupportsEffort.mockReturnValue(false);
      registry._agents.set(
        "agent-nova",
        makeAgentConfig({ id: "agent-nova", name: "AgentNova", model: "claude-nova-9" }),
      );

      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-nova", threadId: "sms:line-1:nova-1" }));
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-nova", threadId: "sms:line-1:nova-2" }));

      expect(routeModel).not.toHaveBeenCalled();
      // Static limits still enforced (substring default tier = sonnet).
      const [, , , , resourceLimits] = mockRunnerSend.mock.calls[0]!;
      expect(resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
      // Warn fired exactly once across two turns (warn-once per model id).
      const effortWarns = mockLogWarn.mock.calls.filter((c) => String(c[0]).includes("effort hints disabled"));
      expect(effortWarns).toHaveLength(1);
    });

    it("passes undefined resource limits when model router is disabled", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      (appConfig as any).modelRouter.enabled = false;

      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));

      expect(mockRunnerSend).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        undefined,
        expect.any(Object),
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe("preamble thread hint (KPR-48)", () => {
    function spawnSlack(item: WorkItem) {
      return manager.spawnTurn({
        agentId: "agent-a",
        sessionId: undefined,
        channelId: item.source.id,
        threadId: item.threadId ?? item.id,
        workItem: item,
        channel: item.source.kind,
      });
    }

    it("includes thread=<ts> from meta.slackThreadTs in senderName branch", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
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

      await spawnSlack(item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      // slackThreadTs takes priority over slackTs
      expect(capturedPrompt).toBe("[Alice in #general, thread=1700000001.000100]: hello");
    });

    it("falls back to meta.slackTs when slackThreadTs is absent", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
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

      await spawnSlack(item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[Alice in #general, thread=1700000003.000300]: hello");
    });

    it("omits thread hint when no slack meta is present", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
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

      await spawnSlack(item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[Alice in #general]: hello");
      expect(capturedPrompt).not.toContain("thread=");
    });

    it("omits thread hint when meta is undefined", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const item: WorkItem = {
        id: "kpr48-m4",
        text: "hello",
        source: { kind: "slack", id: "C123", label: "general" },
        sender: "U001",
        senderName: "Alice",
        threadId: "t4",
        timestamp: new Date(),
      };

      await spawnSlack(item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      expect(capturedPrompt).toBe("[Alice in #general]: hello");
      expect(capturedPrompt).not.toContain("thread=");
    });

    it("does NOT add thread hint to team-channel userId branch", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
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

      await spawnSlack(item);

      const capturedPrompt = mockRunnerSend.mock.calls[0]![0];
      // The userId branch fires; thread hint is not added
      expect(capturedPrompt).toBe("[user:may-keepur via Shop in #team:general]: hey");
      expect(capturedPrompt).not.toContain("thread=");
    });
  });

  describe("getActiveWorkItems (Phase 10 — backed by activeTickets)", () => {
    it("returns empty array when agent has no active work", () => {
      expect(manager.getActiveWorkItems("agent-a")).toEqual([]);
    });

    it("tracks a WorkItem while its spawn is in-flight (derived from activeTickets)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      let capturedDuringSpawn: WorkItem[] = [];
      mockRunnerSend.mockImplementation(async () => {
        capturedDuringSpawn = manager.getActiveWorkItems("agent-a");
        return makeRunResult();
      });

      const ctx = makeSmsCtx({ agentId: "agent-a" });
      await manager.spawnTurn(ctx);

      expect(capturedDuringSpawn).toHaveLength(1);
      expect(capturedDuringSpawn[0]!.id).toBe(ctx.workItem.id);
      // After completion, the ticket set is cleared.
      expect(manager.getActiveWorkItems("agent-a")).toEqual([]);
    });

    it("clears WorkItem from active list after the spawn throws", async () => {
      mockRunnerSend.mockRejectedValue(new Error("bang"));

      await expect(manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }))).rejects.toThrow("bang");

      // withSpawnTicket finally block must have removed the ticket.
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
      sessionProvider: AgentProviderId | undefined;
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
        sessionProvider: overrides.sessionProvider,
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
        "claude",
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

    it("KPR-220 Phase 1: TurnResult carries all 9 execution-metric fields from RunResult", async () => {
      // Pre-Phase-1: dispatcher.runPerTurnDispatch had to zero llmMs/toolMs/
      // toolCalls/toolSummary/streamed/compactions because TurnResult did not
      // surface them. ephemeral{5m,1h}Tokens + preCompactTokens were also
      // dropped. Phase 1 expands TurnResult so finalizeSpawnResult can copy
      // them straight from RunResult.
      mockConversationIndex.mockResolvedValue(undefined);
      mockRunnerSend.mockResolvedValueOnce(
        makeRunResult({
          text: "ack",
          sessionId: "session-metrics",
          llmMs: 1234,
          toolMs: 567,
          toolCalls: 4,
          toolSummary: "memory:2x/0.3s,task:1x/0.4s",
          streamed: true,
          compactions: 2,
          preCompactTokens: 18000,
          ephemeral5mTokens: 9001,
          ephemeral1hTokens: 7777,
        }),
      );

      const result = await manager.spawnTurn(smsCtx());

      expect(result.llmMs).toBe(1234);
      expect(result.toolMs).toBe(567);
      expect(result.toolCalls).toBe(4);
      expect(result.toolSummary).toBe("memory:2x/0.3s,task:1x/0.4s");
      expect(result.streamed).toBe(true);
      expect(result.compactions).toBe(2);
      expect(result.preCompactTokens).toBe(18000);
      expect(result.ephemeral5mTokens).toBe(9001);
      expect(result.ephemeral1hTokens).toBe(7777);
    });

    it("KPR-220 Phase 1: toolSummary defaults to null when RunResult.toolSummary is empty", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ toolSummary: "" }));
      const result = await manager.spawnTurn(smsCtx());
      expect(result.toolSummary).toBeNull();
    });

    it("KPR-220 Phase 2: withSpawnTicket registers the ticket in activeTickets during fn, removes after", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      let snapshotDuringSend: number | undefined;
      mockRunnerSend.mockImplementationOnce(async () => {
        snapshotDuringSend = (manager as unknown as { activeTickets: Map<string, Set<unknown>> })
          .activeTickets.get("agent-a")?.size;
        return makeRunResult();
      });

      await manager.spawnTurn(smsCtx());

      expect(snapshotDuringSend).toBe(1);
      // After resolution, the ticket set is cleaned up (deleted when empty).
      expect((manager as unknown as { activeTickets: Map<string, Set<unknown>> })
        .activeTickets.get("agent-a")).toBeUndefined();
    });

    it("KPR-220 Phase 2: withSpawnTicket pre-wait stop check rejects with AgentStoppedError", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      (manager as unknown as { stoppedAgents: Set<string> }).stoppedAgents.add("agent-a");

      await expect(manager.spawnTurn(smsCtx())).rejects.toThrow(/Agent agent-a is stopped/);
      // Runner was never invoked — pre-wait check fired before any state mutation.
      expect(mockRunnerSend).not.toHaveBeenCalled();
    });

    it("KPR-220 Phase 2: withSpawnTicket mid-wait stop check rejects an in-flight waiter", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Park spawn 1 holding the lock so spawn 2 enters the busy-poll loop.
      let release: (() => void) | undefined;
      mockRunnerSend.mockImplementationOnce(
        () => new Promise((resolve) => {
          release = () => resolve(makeRunResult());
        }),
      );

      const sharedThread = "sms:line-1:midwait";
      const p1 = manager.spawnTurn(smsCtx({ threadId: sharedThread }));
      // Yield so spawn 1 grabs the lock.
      await new Promise((r) => setTimeout(r, 30));

      const p2 = manager.spawnTurn(smsCtx({ threadId: sharedThread }));
      // Yield once into spawn 2's wait loop, then mark agent stopped.
      await new Promise((r) => setTimeout(r, 30));
      (manager as unknown as { stoppedAgents: Set<string> }).stoppedAgents.add("agent-a");

      await expect(p2).rejects.toThrow(/Agent agent-a is stopped/);

      // Drain spawn 1 so the test cleans up (still holding the lock).
      release!();
      await p1.catch(() => undefined);
    });

    it("KPR-220 Phase 3: runWorkItemTurn resolves session via store and delegates to spawnTurn", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Pre-seed a session so the wrapper's lookup hits.
      sessionStore.set("agent-a", "sms:line-1:wrap", "stored-session", "claude", undefined as any);
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "stored-session" }));

      const item = makeWorkItem({
        text: "wrapped",
        threadId: "sms:line-1:wrap",
        source: { kind: "sms" as const, id: "line-1", label: "May (CEO)" },
        sender: "+15551112222",
      });

      const result = await manager.runWorkItemTurn("agent-a", item);

      expect(result.finalMessage).toBe("response");
      expect(sessionStore.get).toHaveBeenCalledWith("agent-a", "sms:line-1:wrap");
      // Underlying runner.send was resumed against the stored sessionId.
      const [, sessionArg] = mockRunnerSend.mock.calls[0]!;
      expect(sessionArg).toBe("stored-session");
    });

    it("KPR-220 Phase 4: spawnBudgetFor uses agent.spawnBudget when set", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Override agent-a with spawnBudget=7. Park 7 spawns; 8th must reject.
      const cfg = registry._agents.get("agent-a")!;
      cfg.spawnBudget = 7;

      const releasers: Array<() => void> = [];
      mockRunnerSend.mockImplementation(
        () => new Promise((resolve) => {
          releasers.push(() => resolve(makeRunResult()));
        }),
      );

      const inflight = [0, 1, 2, 3, 4, 5, 6].map((i) =>
        manager.spawnTurn(smsCtx({ threadId: `sms:line-1:phase4-budget-${i}` })),
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(mockRunnerSend).toHaveBeenCalledTimes(7);

      await expect(
        manager.spawnTurn(smsCtx({ threadId: "sms:line-1:phase4-overflow" })),
      ).rejects.toThrow(/Spawn budget exceeded for agent-a \(7\/7\)/);

      releasers.forEach((r) => r());
      await Promise.all(inflight);
    });

    it("KPR-220 Phase 4: spawnBudgetFor falls back to maxConcurrent when spawnBudget unset", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const cfg = registry._agents.get("agent-a")!;
      cfg.spawnBudget = undefined;
      cfg.maxConcurrent = 2;

      const releasers: Array<() => void> = [];
      mockRunnerSend.mockImplementation(
        () => new Promise((resolve) => {
          releasers.push(() => resolve(makeRunResult()));
        }),
      );

      const inflight = [0, 1].map((i) =>
        manager.spawnTurn(smsCtx({ threadId: `sms:line-1:phase4-fallback-${i}` })),
      );
      await new Promise((r) => setTimeout(r, 30));

      await expect(
        manager.spawnTurn(smsCtx({ threadId: "sms:line-1:phase4-fallback-overflow" })),
      ).rejects.toThrow(/Spawn budget exceeded for agent-a \(2\/2\)/);

      releasers.forEach((r) => r());
      await Promise.all(inflight);
    });

    it("KPR-220 Phase 4: spawnBudgetFor falls back to engine default (5) when both unset", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const cfg = registry._agents.get("agent-a")!;
      cfg.spawnBudget = undefined;
      // KPR-220 Phase 17: `maxConcurrent` is optional on `AgentConfig`; under
      // the fixed `toAgentConfig`, it's no longer materialized to a default
      // when absent in the underlying doc. The cast hack from pre-Phase-17
      // is no longer needed.
      cfg.maxConcurrent = undefined;

      const releasers: Array<() => void> = [];
      mockRunnerSend.mockImplementation(
        () => new Promise((resolve) => {
          releasers.push(() => resolve(makeRunResult()));
        }),
      );

      const inflight = [0, 1, 2, 3, 4].map((i) =>
        manager.spawnTurn(smsCtx({ threadId: `sms:line-1:phase4-default-${i}` })),
      );
      await new Promise((r) => setTimeout(r, 30));

      await expect(
        manager.spawnTurn(smsCtx({ threadId: "sms:line-1:phase4-default-overflow" })),
      ).rejects.toThrow(/Spawn budget exceeded for agent-a \(5\/5\)/);

      releasers.forEach((r) => r());
      await Promise.all(inflight);
    });

    it("KPR-220 Phase 3: runWorkItemTurn falls back to item.id as threadKey when threadId absent", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      mockRunnerSend.mockResolvedValueOnce(makeRunResult());

      const item = makeWorkItem({
        text: "no thread id",
        // No threadId — wrapper must use item.id as the lookup key.
        source: { kind: "sms" as const, id: "line-1", label: "May (CEO)" },
        sender: "+15553334444",
      });
      delete (item as { threadId?: string }).threadId;

      await manager.runWorkItemTurn("agent-a", item);

      expect(sessionStore.get).toHaveBeenCalledWith("agent-a", item.id);
    });

    it("KPR-220 Phase 5: stopAgent aborts in-flight tickets and prevents new spawns", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Park a spawn so there is an in-flight ticket to abort.
      let release: (() => void) | undefined;
      mockRunnerSend.mockImplementationOnce(
        () => new Promise((resolve) => {
          release = () => resolve(makeRunResult({ aborted: true, text: "" }));
        }),
      );

      const inflight = manager.spawnTurn(smsCtx({ threadId: "sms:line-1:stop-target" }));
      await new Promise((r) => setTimeout(r, 30));

      manager.stopAgent("agent-a");

      // The runner attached its abort handle via ticket.attachAbort and was
      // walked by stopAgent.
      expect(mockRunnerAbort).toHaveBeenCalled();
      // stoppedAgents now blocks further spawns on agent-a.
      await expect(
        manager.spawnTurn(smsCtx({ threadId: "sms:line-1:stop-blocked" })),
      ).rejects.toThrow(/Agent agent-a is stopped/);

      release!();
      await inflight.catch(() => undefined);
    });

    it("KPR-220 Phase 13: stopAgent + restartAgent + new spawn — old turn's finally does not wipe new ticket set", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Park the FIRST spawn so we control when its finally runs.
      let releaseFirst: (() => void) | undefined;
      mockRunnerSend.mockImplementationOnce(
        () => new Promise((resolve) => {
          releaseFirst = () => resolve(makeRunResult({ aborted: true, text: "" }));
        }),
      );

      // SECOND spawn (post-restart) returns immediately when the runner is
      // invoked — we want the ticket to remain in activeTickets until we
      // explicitly release it, so we park this one too.
      let releaseSecond: (() => void) | undefined;
      mockRunnerSend.mockImplementationOnce(
        () => new Promise((resolve) => {
          releaseSecond = () => resolve(makeRunResult({ text: "ack-2", sessionId: "s-2" }));
        }),
      );

      const turnA = manager.spawnTurn(smsCtx({ threadId: "sms:line-1:turnA" }));
      await new Promise((r) => setTimeout(r, 30));

      // Stop the agent — aborts turn A but turn A's finally has not yet run
      // (the parked promise is still pending).
      manager.stopAgent("agent-a");
      manager.restartAgent("agent-a");

      // Start turn B AFTER restart. Different thread so no per-thread lock
      // contention with turn A's still-resolving lifecycle.
      const turnB = manager.spawnTurn(smsCtx({ threadId: "sms:line-1:turnB" }));
      await new Promise((r) => setTimeout(r, 30));

      // Sanity: both turn A (aborting, finally not yet fired) and turn B
      // (just started) are active. Under the Phase 13 fix, turn B joins
      // turn A's still-registered set rather than creating a fresh one.
      const activeBefore = manager.getActiveWorkItems("agent-a");
      expect(activeBefore.length).toBe(2);

      // Now release turn A — its finally runs and cleans up its own
      // entry. WITHOUT the identity check + stopAgent-doesn't-delete fix,
      // turn A's finally would wipe activeTickets["agent-a"] entirely,
      // erasing turn B too (activeAfter.length === 0). Negative-verify:
      // revert agent-manager.ts:572 to the unconditional
      // `if (ticketSet.size === 0) this.activeTickets.delete(...)` AND
      // restore `this.activeTickets.delete(agentId)` in stopAgent →
      // this test fails (activeAfter.length === 0).
      releaseFirst!();
      await turnA.catch(() => undefined);

      const activeAfter = manager.getActiveWorkItems("agent-a");
      expect(activeAfter.length).toBe(1);

      releaseSecond!();
      await turnB.catch(() => undefined);
    });

    it("KPR-220 Phase 6: reflection fires after debounce when thread quiescent + memory eligible", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Inject a tiny debounce so we don't have to wait 30s.
      const fastManager = new AgentManager(
        registry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        undefined,
        undefined,
        undefined,
        undefined,
        { reflectionDebounceMs: 25 },
      );

      mockRunnerSend.mockResolvedValue(makeRunResult({ text: "ack", sessionId: "s-A" }));
      const sharedThread = "sms:line-1:reflect-eligible";

      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));

      const calledBefore = mockRunnerSend.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));

      expect(mockRunnerSend.mock.calls.length).toBeGreaterThan(calledBefore);
      // The reflection turn was sent with the canonical reflection prompt.
      const reflectionCall = mockRunnerSend.mock.calls
        .slice(calledBefore)
        .find(([prompt]) => typeof prompt === "string" && prompt.startsWith("[System — end of conversation reflection]"));
      expect(reflectionCall).toBeDefined();
    });

    it("KPR-220 Phase 6: reflection skipped when no memory server in coreServers OR delegateServers", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const localRegistry = makeMockRegistry();
      const cfg = localRegistry._agents.get("agent-a")!;
      cfg.coreServers = ["keychain"]; // no memory / structured-memory anywhere
      cfg.delegateServers = [];

      const fastManager = new AgentManager(
        localRegistry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        undefined,
        undefined,
        undefined,
        undefined,
        { reflectionDebounceMs: 25 },
      );

      mockRunnerSend.mockResolvedValue(makeRunResult());
      const sharedThread = "sms:line-1:no-memory";
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));

      const calledBefore = mockRunnerSend.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));
      // No reflection fired — no extra runner.send.
      expect(mockRunnerSend.mock.calls.length).toBe(calledBefore);
    });

    it("KPR-220 Phase 6: hasMemoryServer accepts memory in delegateServers (legacy doc shape)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const localRegistry = makeMockRegistry();
      const cfg = localRegistry._agents.get("agent-a")!;
      cfg.coreServers = ["keychain"];
      cfg.delegateServers = ["memory"]; // legacy placement — KPR-184 forbids
                                          // for new agents, runtime stays liberal

      const fastManager = new AgentManager(
        localRegistry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        undefined,
        undefined,
        undefined,
        undefined,
        { reflectionDebounceMs: 25 },
      );

      mockRunnerSend.mockResolvedValue(makeRunResult());
      const sharedThread = "sms:line-1:legacy-memory";
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));

      const calledBefore = mockRunnerSend.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));
      expect(mockRunnerSend.mock.calls.length).toBeGreaterThan(calledBefore);
    });

    it("KPR-220 Phase 6: reflection skipped for system sender", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const fastManager = new AgentManager(
        registry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        undefined,
        undefined,
        undefined,
        undefined,
        { reflectionDebounceMs: 25 },
      );

      mockRunnerSend.mockResolvedValue(makeRunResult());
      const sharedThread = "sms:line-1:system-sender";

      // Build three system-sender WorkItems on the same thread.
      for (let i = 0; i < 3; i++) {
        const item = makeWorkItem({
          text: "system note",
          threadId: sharedThread,
          source: { kind: "sms" as const, id: "line-1", label: "May (CEO)" },
          sender: "system",
        });
        await fastManager.spawnTurn({
          agentId: "agent-a",
          sessionId: undefined,
          channelId: "line-1",
          threadId: sharedThread,
          workItem: item,
          channel: "sms",
        });
      }

      const calledBefore = mockRunnerSend.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));
      expect(mockRunnerSend.mock.calls.length).toBe(calledBefore);
    });

    it("KPR-220 Phase 6: reflectionMinTurns <= 0 disables reflection scheduling", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const orig = (appConfig as any).memory.reflectionMinTurns;
      (appConfig as any).memory.reflectionMinTurns = 0;
      try {
        const fastManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          undefined,
          undefined,
          undefined,
          undefined,
          { reflectionDebounceMs: 25 },
        );
        mockRunnerSend.mockResolvedValue(makeRunResult());
        const sharedThread = "sms:line-1:disabled";

        await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
        await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
        await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));

        const calledBefore = mockRunnerSend.mock.calls.length;
        await new Promise((r) => setTimeout(r, 80));
        expect(mockRunnerSend.mock.calls.length).toBe(calledBefore);
        // No state was even tracked — disable path is short-circuited.
        const states = (fastManager as unknown as { reflectionStates: Map<string, unknown> })
          .reflectionStates;
        expect(states.size).toBe(0);
      } finally {
        (appConfig as any).memory.reflectionMinTurns = orig;
      }
    });

    it("KPR-220 Phase 6: stopAgent cancels pending reflection timer", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const fastManager = new AgentManager(
        registry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        undefined,
        undefined,
        undefined,
        undefined,
        { reflectionDebounceMs: 50 },
      );

      mockRunnerSend.mockResolvedValue(makeRunResult());
      const sharedThread = "sms:line-1:cancel-stop";
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));

      const calledBefore = mockRunnerSend.mock.calls.length;
      fastManager.stopAgent("agent-a");
      await new Promise((r) => setTimeout(r, 100));

      // No reflection turn fired AND state map is empty after cancellation.
      expect(mockRunnerSend.mock.calls.length).toBe(calledBefore);
      const states = (fastManager as unknown as { reflectionStates: Map<string, unknown> })
        .reflectionStates;
      expect(states.size).toBe(0);
    });

    it("KPR-220 Phase 15: new turn START cancels pending reflection timer (not just turn completion)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const fastManager = new AgentManager(
        registry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        undefined,
        undefined,
        undefined,
        undefined,
        { reflectionDebounceMs: 200 },
      );

      mockRunnerSend.mockResolvedValue(makeRunResult({ text: "ack" }));
      const sharedThread = "sms:line-1:p15-cancel-on-start";
      // 3 turns to satisfy reflectionMinTurns; debounce timer is scheduled.
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));

      const key = `agent-a:${sharedThread}`;
      const stateBefore = (fastManager as unknown as { reflectionStates: Map<string, { timer: unknown }> })
        .reflectionStates.get(key);
      expect(stateBefore?.timer).not.toBeNull(); // timer scheduled

      // Park a NEW spawn — its withSpawnTicket should cancel the reflection
      // timer when the lock is acquired, BEFORE the debounce window expires.
      let release: (() => void) | undefined;
      mockRunnerSend.mockImplementationOnce(
        () => new Promise((resolve) => { release = () => resolve(makeRunResult({ text: "user" })); }),
      );
      const inflight = fastManager.spawnTurn(smsCtx({ threadId: sharedThread, text: "new user turn" }));
      // Give withSpawnTicket time to acquire the lock + cancel the timer.
      await new Promise((r) => setTimeout(r, 30));

      const stateMid = (fastManager as unknown as { reflectionStates: Map<string, { timer: unknown }> })
        .reflectionStates.get(key);
      expect(stateMid?.timer).toBeNull(); // canceled by the new turn START

      // Wait past the original debounce window — reflection MUST NOT fire,
      // even though the timer was originally scheduled to fire in 200ms.
      await new Promise((r) => setTimeout(r, 250));
      const reflectionFired = mockRunnerSend.mock.calls.some(
        ([prompt]) => typeof prompt === "string" && prompt.startsWith("[System — end of conversation reflection]"),
      );
      expect(reflectionFired).toBe(false);

      release!();
      await inflight;
      // Clean up any leftover reflection timers so subsequent tests aren't
      // polluted by mockRunnerSend calls from this manager's pending timers.
      fastManager.stopAgent("agent-a");
    });

    it("KPR-220 Phase 15: runReflectionTurn skips when thread is non-quiescent (mid-spawn race)", async () => {
      // Simulates the microsecond TOCTOU window between processing.has check
      // in withSpawnTicket and the reflection timer firing: a user turn has
      // acquired the per-thread lock right before the timer dispatches.
      //
      // Under the fix: runReflectionTurn returns early at the quiescence
      // check; reflection NEVER fires even after the lock releases (the
      // state.timer was cleared at entry, and the state.pendingReflectionTurns
      // counter still satisfies eligibility — but the timer has to be
      // rescheduled by the next user-turn completion, not by the aborted run).
      //
      // Under the bug (no quiescence check): runReflectionTurn proceeds to
      // call spawnTurn → withSpawnTicket waits in the lock loop → as soon as
      // processing.delete fires, the spawn acquires the lock and runs the
      // reflection prompt. Detectable by sampling mockRunnerSend AFTER lock
      // release.
      mockConversationIndex.mockResolvedValue(undefined);
      const fastManager = new AgentManager(
        registry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        undefined,
        undefined,
        undefined,
        undefined,
        { reflectionDebounceMs: 50 },
      );

      mockRunnerSend.mockResolvedValue(makeRunResult({ text: "ack" }));
      const sharedThread = "sms:line-1:p15-quiescence";
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));

      const threadKey = `agent-a:${sharedThread}`;
      const processing = (fastManager as unknown as { processing: Set<string> }).processing;
      processing.add(threadKey);

      const callsBefore = mockRunnerSend.mock.calls.length;
      // Wait for debounce to fire — under fix, runReflectionTurn returns
      // early; under bug, it queues behind the lock.
      await new Promise((r) => setTimeout(r, 100));

      // Release the lock — under bug, the queued reflection now acquires it
      // and runs; under fix, nothing happens because runReflectionTurn
      // already returned.
      processing.delete(threadKey);
      await new Promise((r) => setTimeout(r, 100));

      const reflectionFired = mockRunnerSend.mock.calls
        .slice(callsBefore)
        .some(([prompt]) => typeof prompt === "string" && prompt.startsWith("[System — end of conversation reflection]"));
      expect(reflectionFired).toBe(false);

      fastManager.stopAgent("agent-a");
    });

    it("KPR-220 Phase 15: reflection turn re-resolves sessionId AFTER lock acquired", async () => {
      // The race the fix closes: timer fires while a user turn is in flight
      // on the same thread. The user turn's spawnTurn rotates sessionStore
      // post-compaction. Pre-fix: reflection's sessionId is captured at
      // timer fire (before lock wait) → stale. Post-fix: spawnTurn
      // re-resolves sessionId from sessionStore inside withSpawnTicket
      // when ctx.kind === "reflection".
      mockConversationIndex.mockResolvedValue(undefined);
      const fastManager = new AgentManager(
        registry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        undefined,
        undefined,
        undefined,
        undefined,
        { reflectionDebounceMs: 30 },
      );

      // First few calls: regular turns with sessionId rotation simulating
      // post-compaction. sessionStore tracks the latest.
      mockRunnerSend.mockResolvedValue(makeRunResult({ text: "ack", sessionId: "s-original" }));
      const sharedThread = "sms:line-1:p15-session-rotate";
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));
      await fastManager.spawnTurn(smsCtx({ threadId: sharedThread }));

      // sessionStore.get is invoked by spawnTurn before lock acquire for
      // non-reflection turns. We tracked it via the mock; assert at least
      // one reflection-flavor lookup happens AT reflection-fire-time and
      // gets the up-to-date sessionId. The mock's sessionStore.get tracks
      // calls — the reflection turn's sessionStore.get call (re-resolution
      // inside the HOF) is the new behavior under Phase 15.
      const sessionStoreGetCalls = (sessionStore.get as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;

      // Wait for reflection timer to fire.
      await new Promise((r) => setTimeout(r, 90));

      // After reflection, sessionStore.get was invoked at least twice more:
      // once by runReflectionTurn (pre-lock best-effort, line 755), once by
      // spawnTurn's re-resolve (post-lock, ctx.kind === "reflection"). The
      // re-resolve happens INSIDE withSpawnTicket, post-Phase-15. Without
      // the fix, only the pre-lock read happens.
      const sessionStoreGetCallsAfter = (sessionStore.get as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
      expect(sessionStoreGetCallsAfter - sessionStoreGetCalls).toBeGreaterThanOrEqual(2);

      fastManager.stopAgent("agent-a");
    });

    it("KPR-220 Phase 6: reflection turn (kind=reflection) does not reschedule reflection", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      mockRunnerSend.mockResolvedValue(makeRunResult({ text: "reflected", sessionId: "s-r" }));

      const reflectionCtx: TurnContext = {
        agentId: "agent-a",
        sessionId: undefined,
        channelId: "line-1",
        threadId: "sms:line-1:reflect-noop",
        workItem: makeWorkItem({
          text: "[System — end of conversation reflection]",
          threadId: "sms:line-1:reflect-noop",
          source: { kind: "sms" as const, id: "line-1", label: "line-1" },
          sender: "system",
        }),
        channel: "sms",
        kind: "reflection",
      };

      await manager.spawnTurn(reflectionCtx);

      // Reflection turn ran, but no state was tracked (would-recurse guard).
      const states = (manager as unknown as { reflectionStates: Map<string, unknown> })
        .reflectionStates;
      expect(states.size).toBe(0);
    });

    it("KPR-220 Phase 5: restartAgent re-enables spawns after stop", async () => {
      mockConversationIndex.mockResolvedValue(undefined);

      manager.stopAgent("agent-a");
      await expect(manager.spawnTurn(smsCtx())).rejects.toThrow(/Agent agent-a is stopped/);
      // Pre-wait stop check fired before any runner.send call.
      expect(mockRunnerSend).not.toHaveBeenCalled();

      manager.restartAgent("agent-a");
      // Restart wipes session state — the next spawn fires fresh.
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "post-restart" }));
      const result = await manager.spawnTurn(smsCtx());
      expect(result.finalMessage).toBe("post-restart");
    });

    it("KPR-220 Phase 2: withSpawnTicket post-lock stop check cleans up + throws AgentStoppedError", async () => {
      // The race we close: stopAgent flips `stoppedAgents` AFTER the wait loop
      // exits AND ticket.set runs but BEFORE fn(ticket) is called. Without the
      // post-lock check, the turn would slip through stop. Simulate the race
      // by toggling `stoppedAgents` synchronously — wait loop is empty (no
      // contention), so we land at the post-lock check immediately.
      mockConversationIndex.mockResolvedValue(undefined);
      const stoppedSet = (manager as unknown as { stoppedAgents: Set<string> }).stoppedAgents;
      const processing = (manager as unknown as { processing: Set<string> }).processing;
      const activeSpawnCount = (manager as unknown as { activeSpawnCount: Map<string, number> })
        .activeSpawnCount;
      const activeTickets = (manager as unknown as { activeTickets: Map<string, Set<unknown>> })
        .activeTickets;

      // Hook the processing.add so we can flip stoppedAgents AFTER it runs but
      // BEFORE the post-lock check sees it. We flip via the next-tick from the
      // wait loop's setTimeout(25ms) — but for an empty wait loop we need a
      // different trick: use a Map.set spy on activeTickets to flip during
      // ticket registration, which runs between processing.add and the
      // post-lock check.
      const origActiveTicketsSet = activeTickets.set.bind(activeTickets);
      const setSpy = vi.spyOn(activeTickets, "set").mockImplementationOnce((key, value) => {
        const out = origActiveTicketsSet(key, value);
        stoppedSet.add("agent-a");
        return out;
      });

      await expect(manager.spawnTurn(smsCtx())).rejects.toThrow(/Agent agent-a is stopped/);

      // All state cleaned up — processing released, budget back to zero,
      // ticket removed.
      expect(processing.size).toBe(0);
      expect(activeSpawnCount.get("agent-a")).toBeUndefined();
      expect(activeTickets.get("agent-a")).toBeUndefined();
      // Runner was never spawned — fn(ticket) was skipped.
      expect(mockRunnerSend).not.toHaveBeenCalled();

      setSpy.mockRestore();
      stoppedSet.delete("agent-a");
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
      // Use agent-b — agent-a's maxConcurrent=2 now caps the spawn budget at 2.
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
        manager.spawnTurn(smsCtx({ agentId: "agent-b", threadId: `sms:line-1:thread-${i}` })),
      );
      await Promise.all(spawns);

      expect(maxInflight).toBeGreaterThanOrEqual(2);
      expect(mockRunnerSend).toHaveBeenCalledTimes(3);
    });

    it("rejects when per-agent spawn budget is exceeded (default 5)", async () => {
      // KPR-220 Phase 4: agent-a has maxConcurrent=2 in the registry which
      // resolves to spawnBudget=2 via the fallback chain. Use agent-b which
      // has no override and therefore lands on the engine default of 5.
      const releasers: Array<() => void> = [];
      mockRunnerSend.mockImplementation(() => {
        return new Promise((resolve) => {
          releasers.push(() => resolve(makeRunResult()));
        });
      });

      const inflight = [0, 1, 2, 3, 4].map((i) =>
        manager.spawnTurn(smsCtx({ agentId: "agent-b", threadId: `sms:line-1:budget-${i}` })),
      );
      // Yield enough for all 5 to enter and bump the active count.
      await new Promise((r) => setTimeout(r, 30));
      expect(mockRunnerSend).toHaveBeenCalledTimes(5);

      await expect(
        manager.spawnTurn(smsCtx({ agentId: "agent-b", threadId: "sms:line-1:budget-overflow" })),
      ).rejects.toThrow(/Spawn budget exceeded for agent-b \(5\/5\)/);

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

    it("F1 (KPR-225): budget tracking is atomic with per-thread lock — no leak on contention", async () => {
      // Pre-fix bug: spawnTurn read activeSpawnCount BEFORE the per-thread lock,
      // then wrote `active + 1` AFTER acquiring it. Two concurrent same-thread
      // spawns both captured stale `active`, both passed the budget check, both
      // queued on the lock, then both wrote `active + 1` based on stale state —
      // leaking +1 per contention event.
      //
      // Post-fix: budget read+set is inside the critical section. After both
      // spawns drain, activeSpawnCount must return to zero (entry deleted).
      mockRunnerSend.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(makeRunResult()), 50)),
      );

      const sharedThread = "sms:line-1:f1-contention";
      const ctx1 = smsCtx({ threadId: sharedThread, text: "first" });
      const ctx2 = smsCtx({ threadId: sharedThread, text: "second" });

      const [r1, r2] = await Promise.all([
        manager.spawnTurn(ctx1),
        manager.spawnTurn(ctx2),
      ]);

      // Both succeed (no spurious budget-exceeded thrown).
      expect(r1.errors).toEqual([]);
      expect(r2.errors).toEqual([]);

      // Budget counter returns to zero (entry deleted in finally block).
      // Pre-fix: would be 1 (or higher) due to the leak.
      expect((manager as unknown as { activeSpawnCount: Map<string, number> })
        .activeSpawnCount.get(ctx1.agentId)).toBeUndefined();

      // Per-thread lock released.
      expect((manager as unknown as { processing: Set<string> })
        .processing.has(`${ctx1.agentId}:${sharedThread}`)).toBe(false);
      expect((manager as unknown as { activeSpawnKeys: Set<string> })
        .activeSpawnKeys.has(`${ctx1.agentId}:${sharedThread}`)).toBe(false);
    });

    it("KPR-226: shaping throw does not leak per-thread lock or budget slot", async () => {
      // Pre-fix bug: spawnTurn called prepareSpawn AFTER acquiring the lock + budget
      // slot but BEFORE the try/finally that releases them. Any throw in shaping
      // (e.g., formatFilesForPrompt on malformed file metadata) left `processing`,
      // `activeSpawnKeys`, and `activeSpawnCount` stuck — next turn busy-waits
      // forever; enough such failures permanently consume the per-agent budget.
      //
      // Post-fix: prepareSpawn is inside the try block, so the finally runs even
      // on a shaping throw and the lock + budget slot are released.
      const prepareSpawnSpy = vi
        .spyOn(manager as unknown as { prepareSpawn: (ctx: unknown) => Promise<unknown> }, "prepareSpawn")
        .mockRejectedValueOnce(new Error("synthetic shaping failure"));

      const ctx = smsCtx();

      // First spawn — shaping throws; the rejection propagates.
      await expect(manager.spawnTurn(ctx)).rejects.toThrow("synthetic shaping failure");

      // Lock + budget slot must be released after the throw.
      const threadKey = `${ctx.agentId}:${ctx.threadId}`;
      expect((manager as unknown as { processing: Set<string> })
        .processing.has(threadKey)).toBe(false);
      expect((manager as unknown as { activeSpawnKeys: Set<string> })
        .activeSpawnKeys.has(threadKey)).toBe(false);
      expect((manager as unknown as { activeSpawnCount: Map<string, number> })
        .activeSpawnCount.get(ctx.agentId)).toBeUndefined();

      // Restore the spy so the next spawn proceeds normally.
      prepareSpawnSpy.mockRestore();

      // Second spawn on same thread proceeds (no busy-wait, no lingering budget).
      mockConversationIndex.mockResolvedValue(undefined);
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "recovered after shaping throw" }));
      const result = await manager.spawnTurn(ctx);
      expect(result.finalMessage).toBe("recovered after shaping throw");
      expect(result.errors).toEqual([]);
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
      const turn1 = await manager.spawnTurn(
        smsCtx({ threadId, channelId, sessionId: sess0?.sessionId, sessionProvider: sess0?.provider }),
      );
      expect(turn1.newSessionId).toBe("session-A");
      expect((await sessionStore.get("agent-a", threadId))?.sessionId).toBe("session-A");

      // Turn 2 — adapter resumes against the stored id, SDK rotates inside.
      const sess1 = await sessionStore.get("agent-a", threadId);
      const turn2 = await manager.spawnTurn(
        smsCtx({ threadId, channelId, sessionId: sess1?.sessionId, sessionProvider: sess1?.provider }),
      );
      expect(turn2.newSessionId).toBe("session-B");
      // Persistence side has rotated to the new id.
      expect((await sessionStore.get("agent-a", threadId))?.sessionId).toBe("session-B");

      // Turn 3 — adapter resumes against the rotated id.
      const sess2 = await sessionStore.get("agent-a", threadId);
      expect(sess2?.sessionId).toBe("session-B");
      await manager.spawnTurn(
        smsCtx({ threadId, channelId, sessionId: sess2?.sessionId, sessionProvider: sess2?.provider }),
      );

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

    it("sweep does not clear an in-flight per-turn spawn lock (regression)", async () => {
      // Bug: sweep's stuck-flag detector keys on `activeRunners` being empty,
      // which is the by-design state for per-turn spawns. Without the
      // activeSpawnKeys guard, sweep would clear the legitimate lock and let
      // a second concurrent spawnTurn race the first.
      const events: string[] = [];
      let release: (() => void) | undefined;
      mockRunnerSend.mockImplementation((prompt: string) => {
        events.push(`start:${prompt}`);
        return new Promise((resolve) => {
          release = () => {
            events.push(`finish:${prompt}`);
            resolve(makeRunResult({ text: prompt, sessionId: `s-${prompt}` }));
          };
        });
      });

      const sharedThread = "sms:line-1:+15559999999";
      const p1 = manager.spawnTurn(smsCtx({ threadId: sharedThread, text: "first" }));

      // Yield so the first spawn grabs the lock and starts.
      await new Promise((r) => setTimeout(r, 30));
      expect(events).toEqual(["start:first"]);

      const processing = (manager as any).processing as Set<string>;
      const threadKey = `agent-a:${sharedThread}`;
      expect(processing.has(threadKey)).toBe(true);

      // Sweep while the spawn is in-flight. Pre-fix this would delete the lock
      // and log "Stuck processing flag cleared".
      const result = manager.sweep();
      expect(result.pruned).toBe(0);
      expect(processing.has(threadKey)).toBe(true);

      // A second concurrent spawn on the same thread must queue behind, not
      // race the first.
      const p2 = manager.spawnTurn(smsCtx({ threadId: sharedThread, text: "second" }));
      await new Promise((r) => setTimeout(r, 30));
      // Still only the first spawn has started — the second is busy-polling.
      expect(events).toEqual(["start:first"]);

      // Release the first; the second should now proceed.
      release!();
      await new Promise((r) => setTimeout(r, 60));
      expect(events).toEqual(["start:first", "finish:first", "start:second"]);

      // Drain.
      release!();
      await Promise.all([p1, p2]);
    });

    // Nested inside `spawnTurn (KPR-216)` (not a sibling) so `smsCtx` stays in
    // scope — it's a local `function` declared at the top of that describe,
    // not module-level. `routeModel` is already imported/mocked module-wide
    // (see the existing `import { routeModel } from "./model-router.js"`).
    describe("provider circuit breaker at the wrap point (KPR-306)", () => {
      // agent-a's model is a bare id in these fixtures → provider "claude".
      const CONNECT_FAIL = "TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:443";

      async function tripBreaker(threadPrefix = "trip") {
        for (let i = 0; i < 3; i++) {
          mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: CONNECT_FAIL }));
          await manager.spawnTurn(smsCtx({ threadId: `sms:line-1:${threadPrefix}-${i}` }));
        }
      }

      it("three consecutive hard faults open the breaker; the next spawnTurn fast-fails before the adapter", async () => {
        // Router must be enabled for this assertion to mean anything, AND the
        // fast-failed turn must run on a router-ELIGIBLE agent. Post-KPR-338
        // haiku-static agents skip the classifier entirely (agent-a is
        // haiku), so a fast-fail on agent-a would leave routeModel uncalled
        // for a reason unrelated to the breaker — the delta pin below would
        // pass vacuously. agent-s is sonnet-static (still router-eligible): an
        // ADMITTED turn WOULD spend a router call, so a zero delta across the
        // fast-failed agent-s turn genuinely pins "breaker permit before any
        // model-router spend" (CLAUDE.md). tripBreaker stays on agent-a — the
        // breaker is per-provider and both resolve to claude.
        (appConfig as any).modelRouter.enabled = true;
        try {
          // Effort-only stub (T2d reshape — the KPR-338 ModelRouterResult no
          // longer carries tier/model/limits). Only an admitted agent-s turn
          // would consume it — tripBreaker's agent-a turns skip the router
          // (haiku, KPR-338).
          vi.mocked(routeModel).mockResolvedValue(makeRouterResult());

          await tripBreaker();
          expect(manager.circuitBreakers.stateFor("claude")!.state).toBe("open");

          const callsBefore = mockRunnerSend.mock.calls.length;
          const routerCallsBefore = vi.mocked(routeModel).mock.calls.length;
          await expect(
            manager.spawnTurn(smsCtx({ agentId: "agent-s", threadId: "sms:line-1:fast-fail" })),
          ).rejects.toBeInstanceOf(ProviderCircuitOpenError);
          // Adapter never invoked for the fast-failed turn (pre-prepareSpawn throw).
          expect(mockRunnerSend.mock.calls.length).toBe(callsBefore);
          // Router also never invoked for the fast-failed turn specifically:
          // pin the *call-count delta* across just this turn. tripBreaker's
          // agent-a turns skip the router (haiku, KPR-338), so routerCallsBefore
          // is 0; the point is that the admitted-but-for-the-breaker agent-s
          // turn spends nothing — the permit gates before any router call.
          expect(vi.mocked(routeModel).mock.calls.length).toBe(routerCallsBefore);
        } finally {
          (appConfig as any).modelRouter.enabled = false;
        }
      });

      it("fast-fail releases the ticket cleanly: no active spawns, no lock leak, repeatable", async () => {
        await tripBreaker();
        const threadId = "sms:line-1:cleanliness";
        await expect(manager.spawnTurn(smsCtx({ threadId }))).rejects.toBeInstanceOf(ProviderCircuitOpenError);

        const perAgent = manager.getSnapshot().perAgent["agent-a"];
        expect(perAgent?.activeSpawns ?? 0).toBe(0);
        expect(perAgent?.activeThreadKeys ?? []).toEqual([]);

        // Same thread again: rejects with the breaker error — NOT a budget or
        // lock error — proving the finally released everything.
        await expect(manager.spawnTurn(smsCtx({ threadId }))).rejects.toBeInstanceOf(ProviderCircuitOpenError);
      });

      it("record-once under auth-rebuild retry: only the retry's outcome feeds the breaker", async () => {
        // First attempt: auth sentinel (with a resumable session) → retried.
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "401 Unauthorized" }));
        // Retry: success.
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "recovered", sessionId: "s2" }));
        await manager.spawnTurn(smsCtx({ sessionId: "s1", threadId: "sms:line-1:auth-retry" }));

        const snap = manager.circuitBreakers.stateFor("claude")!;
        expect(snap.state).toBe("closed");
        expect(snap.consecutiveHardFaults).toBe(0); // retry success recorded, first attempt never counted
      });

      it("auth-rebuild retry that also fails records exactly one auth fault", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "401 Unauthorized" }));
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "401 Unauthorized" }));
        await manager.spawnTurn(smsCtx({ sessionId: "s1", threadId: "sms:line-1:auth-fail" }));
        expect(manager.circuitBreakers.stateFor("claude")!.consecutiveHardFaults).toBe(1);
      });

      it("a thrown adapter error is classified and rethrown", async () => {
        mockRunnerSend.mockRejectedValueOnce(new Error("fetch failed"));
        await expect(manager.spawnTurn(smsCtx({ threadId: "sms:line-1:thrown" }))).rejects.toThrow("fetch failed");
        expect(manager.circuitBreakers.stateFor("claude")!.consecutiveHardFaults).toBe(1);
      });

      it("non-provider errors (tool failures) never trip", async () => {
        for (let i = 0; i < 5; i++) {
          mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "tool handler exploded: boom" }));
          await manager.spawnTurn(smsCtx({ threadId: `sms:line-1:np-${i}` }));
        }
        expect(manager.circuitBreakers.stateFor("claude")!.state).toBe("closed");
      });

      it("probe recovery end-to-end: post-cooldown turn is admitted and closes the breaker", async () => {
        // Swap in a registry with an injected clock (readonly is compile-time only).
        let t = 0;
        (manager as unknown as { circuitBreakers: ProviderCircuitBreakerRegistry }).circuitBreakers =
          new ProviderCircuitBreakerRegistry(undefined, () => t);
        await tripBreaker("probe");
        expect(manager.circuitBreakers.stateFor("claude")!.state).toBe("open");

        t += 15_000; // past cooldown — next real turn becomes the probe
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "back", sessionId: "s-probe" }));
        const result = await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:probe-turn" }));
        expect(result.finalMessage).toBe("back");
        expect(manager.circuitBreakers.stateFor("claude")!.state).toBe("closed");
      });

      it("KPR-347 T5: assembly throws with a provider-fault-shaped message — classifies non-provider, breaker closed after 3 repeats", async () => {
        registry._agents.set(
          "oai-pilot",
          makeAgentConfig({ id: "oai-pilot", name: "OAI", model: "openai/gpt-5.4-mini", coreServers: [] }),
        );
        mockRunnerToolInventory.mockImplementation(() => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:27017");
        });
        // try/finally: restore the mock even if an assertion below throws, so a
        // failed run doesn't leak the throwing implementation into later tests
        // (belt-and-braces — beforeEach already re-primes mockRunnerToolInventory).
        try {
          for (let i = 0; i < 3; i++) {
            await expect(
              manager.spawnTurn(smsCtx({ agentId: "oai-pilot", threadId: `sms:line-1:kpr347-asm-${i}` })),
            ).rejects.toThrow(/Lane B turn assembly failed/);
          }
          // The killer assertion: three ECONNREFUSED-worded failures did NOT open
          // the openai circuit — TurnAssemblyError short-circuited the pattern
          // tables (§D6). A raw Error with this message would have tripped it.
          const snap = manager.circuitBreakers.stateFor("openai");
          expect(snap?.state).toBe("closed");
          expect(snap?.consecutiveHardFaults).toBe(0);
        } finally {
          mockRunnerToolInventory.mockReturnValue([]);
        }
      });

      it("KPR-347 T6: abort landing DURING async assembly skips runTurn — synthesized aborted result, breaker-neutral", async () => {
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5", coreServers: [] }),
        );
        mockRunnerToolInventory.mockImplementationOnce(() => {
          // Fires ticket.abort() while assembly is in flight — after the
          // early-flag attach, before the adapter exists. §D5: the manager-owned
          // skip must bypass runTurn() entirely (the pilot adapter would reset
          // its aborted flag at runTurn entry, so a flag-only re-check is inert).
          manager.stopAgent("codex-pilot");
          return [];
        });
        // No runTurn stub: the real mechanism must NOT call it. If the skip
        // regressed, mockCodexRunTurn would resolve undefined and the turn
        // would blow up — a stronger signal than a fabricated aborted result.
        const result = await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr347-abortwin" }));
        expect(mockCodexRunTurn).not.toHaveBeenCalled(); // §D5 skip — no provider call
        expect(mockCodexAbort).toHaveBeenCalled(); // the re-check still fired adapter.abort()
        expect(result.finalMessage).toBe("");
        expect(result.aborted).toBe(true); // synthesized aborted completion, not a throw
        // Aborted turns are breaker-neutral (classifyTurnResult → aborted).
        expect(manager.circuitBreakers.stateFor("codex")?.consecutiveHardFaults ?? 0).toBe(0);
        manager.restartAgent("codex-pilot"); // don't leak stopped state into later tests
      });

      it("KPR-347: abort BEFORE runTurn yields an aborted result with zero provider calls (per-mechanism pin)", async () => {
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5", coreServers: [] }),
        );
        // Abort mid-assembly. The synthesized aborted RunResult is the ONLY path
        // that closes the §D5 window — the pilot adapters reset `aborted` at
        // runTurn() entry, so any turn that reached runTurn would run to
        // completion. Assert both halves of the mechanism explicitly.
        mockRunnerToolInventory.mockImplementationOnce(() => {
          manager.stopAgent("codex-pilot");
          return [];
        });
        const result = await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr347-premech" }));
        expect(result.aborted).toBe(true);
        expect(result.finalMessage).toBe("");
        expect(mockCodexRunTurn).not.toHaveBeenCalled();
        expect(mockCodexConstructor).toHaveBeenCalledTimes(1); // adapter WAS constructed (abort races construction)
        manager.restartAgent("codex-pilot");
      });
    });

    describe("providerFor + TurnResult timedOut/aborted propagation (KPR-307)", () => {
      it("providerFor maps bare model → claude, prefixed → provider, unknown agent → null", () => {
        // agent-a's fixture model is a bare id (claude-haiku-4-5) → claude.
        expect(manager.providerFor("agent-a")).toBe("claude");
        expect(manager.providerFor("no-such-agent")).toBeNull();
        // Add a gemini-routed agent to the same registry map the manager reads
        // live (makeMockRegistry.get resolves from _agents on every call).
        registry._agents.set(
          "agent-gemini",
          makeAgentConfig({ id: "agent-gemini", name: "AgentGemini", model: "gemini/gemini-2.5-pro" }),
        );
        expect(manager.providerFor("agent-gemini")).toBe("gemini");
      });

      it("spawnTurn's TurnResult carries timedOut/aborted from RunResult", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ timedOut: true, aborted: true }));
        const result = await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr307-timeout" }));
        expect(result.timedOut).toBe(true);
        expect(result.aborted).toBe(true);
      });

      it("healthy turns leave timedOut/aborted falsy", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({}));
        const result = await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr307-clean" }));
        expect(result.timedOut ?? false).toBe(false);
        expect(result.aborted ?? false).toBe(false);
      });
    });

    describe("router→adapter seam invariants (KPR-311)", () => {
      it("breaker permit provider === effective route provider for claude and pilot agents (stable registry state)", async () => {
        // R7: acquire() keys on the static provider before the router runs;
        // the W3 clamp makes shaping.route.provider agree whenever both
        // registry reads observe the same state. NOT asserted across a
        // mid-turn registry mutation (see the SIGUSR1 race test below).
        const acquireSpy = vi.spyOn(manager.circuitBreakers, "acquire");

        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:seam-claude" }));
        expect(acquireSpy).toHaveBeenLastCalledWith("claude", expect.objectContaining({ agentId: "agent-a" }));
        expect(mockRunnerSend).toHaveBeenCalledTimes(1); // Claude adapter ran — same provider as the permit

        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:seam-codex" }));
        expect(acquireSpy).toHaveBeenLastCalledWith("codex", expect.objectContaining({ agentId: "codex-pilot" }));
        expect(mockCodexConstructor).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.5" }));
      });

      it("SIGUSR1 removal race: prepareSpawn never throws on a vanished agent — failure lands inside the recorded try, record() once, no wedged permit", async () => {
        const recordSpy = vi.spyOn(manager.circuitBreakers, "record");
        // Flip the registry to "agent removed" the instant the breaker
        // permit is issued: the acquire-site read (argument evaluation)
        // still sees the agent; every later read — prepareSpawn's guarded
        // read and createProviderAdapter's — sees undefined. This is the
        // hot-reload race the `?.model ?? ""` guard exists for.
        let vanished = false;
        const realAcquire = manager.circuitBreakers.acquire.bind(manager.circuitBreakers);
        vi.spyOn(manager.circuitBreakers, "acquire").mockImplementation((provider, meta) => {
          const permit = realAcquire(provider, meta);
          vanished = true;
          return permit;
        });
        registry.get.mockImplementation((id: string) =>
          vanished && id === "agent-a" ? undefined : registry._agents.get(id),
        );

        // Rejects with the createProviderAdapter throw — NOT a TypeError
        // from an unguarded agentConfig.model dereference in prepareSpawn.
        await expect(manager.spawnTurn(smsCtx({ threadId: "sms:line-1:hot-reload" }))).rejects.toThrow(
          /Unknown agent: agent-a/,
        );

        // Exactly one record(), on the permit acquired pre-removal,
        // classified non-provider (never trips) from the thrown error.
        expect(recordSpy).toHaveBeenCalledTimes(1);
        const [permit, classification] = recordSpy.mock.calls[0]!;
        expect(permit.provider).toBe("claude");
        expect(classification).toEqual({
          outcome: "fault",
          kind: "non-provider",
          message: expect.stringContaining("Unknown agent"),
        });
        const snap = manager.circuitBreakers.stateFor("claude")!;
        expect(snap.state).toBe("closed");
        expect(snap.consecutiveHardFaults).toBe(0);

        // No wedge, no lock leak: restore the registry, same thread runs clean.
        registry.get.mockImplementation((id: string) => registry._agents.get(id));
        const result = await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:hot-reload" }));
        expect(result.finalMessage).toBe("response");
      });
    });

    describe("session-identity guard + persist rule (KPR-313)", () => {
      function seed(threadId: string, sessionId: string, provider: string, agentId = "agent-a") {
        sessionStore._sessions.set(`${agentId}:${threadId}`, { sessionId, provider });
      }

      it("trips on stored tag ≠ turn provider: fresh session, claude annotation, new-session metric, exactly ONE trip-path store read", async () => {
        const recordSpawnSpy = vi.spyOn(manager as any, "recordSpawn");
        const threadId = "sms:line-1:kpr313-trip";
        seed(threadId, "resp_stale", "openai");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "fresh", sessionId: "s-new" }));

        await manager.spawnTurn(smsCtx({ threadId, sessionId: "resp_stale", sessionProvider: "openai" }));

        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBeUndefined(); // resume stripped
        expect(prompt.startsWith("[System notice:")).toBe(true); // annotation prepended before sender prefix
        expect(prompt).toContain("session continuity was reset");
        expect(prompt).toContain("conversation_search"); // claude-target variant
        expect(prompt).toContain("hello over sms"); // original text intact
        expect(recordSpawnSpy).toHaveBeenCalledTimes(1); // counted as a new session
        expect(sessionStore.get).toHaveBeenCalledTimes(1); // the authoritative re-read — trip path only
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("provider mismatch"),
          expect.objectContaining({ stored: "openai", turn: "claude", hadSessionId: true }),
        );
      });

      it("same-provider tag resumes with ZERO store reads on the hot path (also the untagged-legacy fleet-upgrade pin — grandfathered rows arrive as claude)", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-1" }));
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr313-match", sessionId: "s-1", sessionProvider: "claude" }),
        );
        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBe("s-1");
        expect(prompt).not.toContain("session continuity was reset");
        expect(sessionStore.get).not.toHaveBeenCalled(); // zero-I/O hot path
      });

      it("codex-tagged empty row + claude turn: nothing to resume AND the annotation still fires (round-trip return leg)", async () => {
        const threadId = "sms:line-1:kpr313-return";
        seed(threadId, "", "codex"); // re-read stays codex ⇒ handoff, not adopt
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "back", sessionId: "s-back" }));

        await manager.spawnTurn(smsCtx({ threadId, sessionId: undefined, sessionProvider: "codex" }));

        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBeUndefined();
        expect(prompt).toContain("session continuity was reset"); // keyed on the TAG, not the id
      });

      it("claude→pilot handoff uses the pilot annotation variant (no conversation_search — pilots are tool-free)", async () => {
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        const threadId = "sms:line-1:kpr313-topilot";
        seed(threadId, "claude-uuid-1", "claude", "codex-pilot");

        await manager.spawnTurn(
          smsCtx({ agentId: "codex-pilot", threadId, sessionId: "claude-uuid-1", sessionProvider: "claude" }),
        );

        const req = mockCodexRunTurn.mock.calls[0]![0];
        expect(req.sessionId).toBeUndefined();
        expect(req.prompt).toContain("session continuity was reset");
        expect(req.prompt).not.toContain("conversation_search");
      });

      it("⚠A9 re-resolve-on-trip: queued same-thread turn ADOPTS the predecessor's switched session instead of double-dropping", async () => {
        const threadId = "sms:line-1:kpr313-race";
        seed(threadId, "resp_stale", "openai");
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ text: "A", sessionId: "s-A" }))
          .mockResolvedValueOnce(makeRunResult({ text: "B", sessionId: "s-A" }));

        // Both turns read the store PRE-lock (runWorkItemTurn) and capture the
        // stale openai tag; the per-thread lock then serializes the spawns.
        // Determinism note: both pre-lock reads resolve before A persists only
        // under the all-mocked microtask scheduling — if the harness gains real
        // async, add an explicit ordering assertion (A's set before B's send).
        const mk = (text: string) =>
          makeWorkItem({ text, threadId, source: { kind: "sms" as const, id: "line-1", label: "May" }, sender: "+1" });
        const p1 = manager.runWorkItemTurn("agent-a", mk("turn A"));
        const p2 = manager.runWorkItemTurn("agent-a", mk("turn B"));
        await Promise.all([p1, p2]);

        // Turn A tripped: fresh + handoff, persisted (s-A, claude).
        const [promptA, resumeA] = mockRunnerSend.mock.calls[0]!;
        expect(resumeA).toBeUndefined();
        expect(promptA).toContain("session continuity was reset");
        // Turn B's captured tag was a full turn stale — the post-lock re-read
        // returned A's claude row and B adopted it: resumed s-A, NO second
        // handoff, A's exchange preserved.
        const [promptB, resumeB] = mockRunnerSend.mock.calls[1]!;
        expect(resumeB).toBe("s-A");
        expect(promptB).not.toContain("session continuity was reset");
      });

      it("persist rule: claude id+tag; codex ''+tag with findAgentByThread intact; gemini ''+tag", async () => {
        // Claude
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-c" }));
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr313-p-claude" }));
        expect(sessionStore.set).toHaveBeenCalledWith(
          "agent-a", "sms:line-1:kpr313-p-claude", "s-c", "claude", expect.anything(),
        );

        // Codex — adapter returns a fabricated id ("codex-session" fixture); store must get "".
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr313-p-codex" }));
        expect(sessionStore.set).toHaveBeenLastCalledWith(
          "codex-pilot", "sms:line-1:kpr313-p-codex", "", "codex", expect.anything(),
        );
        // The ROW survives — thread→agent mapping intact (the ticket's rule, literally).
        await expect(sessionStore.findAgentByThread("sms:line-1:kpr313-p-codex")).resolves.toBe("codex-pilot");

        // Gemini
        registry._agents.set(
          "gemini-pilot",
          makeAgentConfig({ id: "gemini-pilot", name: "Gemini Pilot", model: "gemini/gemini-3-pro", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "gemini-pilot", threadId: "sms:line-1:kpr313-p-gem" }));
        expect(sessionStore.set).toHaveBeenLastCalledWith(
          "gemini-pilot", "sms:line-1:kpr313-p-gem", "", "gemini", expect.anything(),
        );
      });

      it("persist rule: openai persists its resp id with the openai tag (genuinely resumable)", async () => {
        registry._agents.set(
          "openai-pilot",
          makeAgentConfig({ id: "openai-pilot", name: "OpenAI Pilot", model: "openai/gpt-5.5:medium", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "openai-pilot", threadId: "sms:line-1:kpr313-p-oai" }));
        expect(sessionStore.set).toHaveBeenLastCalledWith(
          "openai-pilot", "sms:line-1:kpr313-p-oai", "openai-session", "openai", expect.anything(),
        );
      });

      it("⚠A4 churn-mint rider: errored turn that resumed and returned a DIFFERENT id never overwrites the row", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ error: "No conversation found with session ID: s-old", sessionId: "s-minted" }),
        );
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr313-mint", sessionId: "s-old", sessionProvider: "claude" }),
        );
        expect(sessionStore.set).not.toHaveBeenCalled();
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("different id"),
          expect.objectContaining({ agentId: "agent-a" }),
        );
      });

      it("errored turn that returned the SAME id it resumed re-persists (TTL refresh — M7b fault non-poisoning)", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "tool blew up", sessionId: "s-same" }));
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr313-same", sessionId: "s-same", sessionProvider: "claude" }),
        );
        expect(sessionStore.set).toHaveBeenCalledWith(
          "agent-a", "sms:line-1:kpr313-same", "s-same", "claude", expect.anything(),
        );
      });

      it("first-turn error with a fresh id persists (rider scoped to attempted resumes)", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "tool blew up", sessionId: "s-first" }));
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr313-first" }));
        expect(sessionStore.set).toHaveBeenCalledWith(
          "agent-a", "sms:line-1:kpr313-first", "s-first", "claude", expect.anything(),
        );
      });

      it("end-to-end claude→codex→claude round trip via runWorkItemTurn: both directions trip, both variants, row state correct after each turn", async () => {
        registry._agents.set("flip", makeAgentConfig({ id: "flip", name: "Flip", model: "claude-sonnet-4-6" }));
        const threadId = "sms:line-1:kpr313-flip";
        const mk = (text: string) =>
          makeWorkItem({ text, threadId, source: { kind: "sms" as const, id: "line-1", label: "May" }, sender: "+1" });

        // Turn 1 — claude: persists (s-1, claude).
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-1" }));
        await manager.runWorkItemTurn("flip", mk("t1"));
        expect(sessionStore._sessions.get(`flip:${threadId}`)).toEqual({ sessionId: "s-1", provider: "claude" });

        // Operator flips to codex (SIGUSR1 analog) — claude→pilot direction.
        registry._agents.set(
          "flip",
          makeAgentConfig({ id: "flip", name: "Flip", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        await manager.runWorkItemTurn("flip", mk("t2"));
        const codexReq = mockCodexRunTurn.mock.calls.at(-1)![0];
        expect(codexReq.sessionId).toBeUndefined();
        expect(codexReq.prompt).toContain("session continuity was reset");
        expect(codexReq.prompt).not.toContain("conversation_search"); // pilot variant
        expect(sessionStore._sessions.get(`flip:${threadId}`)).toEqual({ sessionId: "", provider: "codex" });

        // Flip back — pilot→claude direction.
        registry._agents.set("flip", makeAgentConfig({ id: "flip", name: "Flip", model: "claude-sonnet-4-6" }));
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-3" }));
        await manager.runWorkItemTurn("flip", mk("t3"));
        const [prompt3, resume3] = mockRunnerSend.mock.calls.at(-1)!;
        expect(resume3).toBeUndefined(); // codex row had nothing to resume
        expect(prompt3).toContain("conversation_search"); // claude variant fired off the TAG alone
        expect(sessionStore._sessions.get(`flip:${threadId}`)).toEqual({ sessionId: "s-3", provider: "claude" });
      });

      it("reflection re-resolve is FIELD-wise: same stored id/provider still hands runner.send the STRING id (ref-vs-string regression pin), one get only", async () => {
        const threadId = "sms:line-1:kpr313-reflect";
        seed(threadId, "s-r", "claude");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-r" }));

        await manager.spawnTurn({
          ...smsCtx({ threadId, sessionId: "s-r", sessionProvider: "claude" }),
          kind: "reflection" as const,
        });

        const [, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBe("s-r"); // a string — a ref-vs-string compare would have rebuilt ctx with a ref here
        expect(sessionStore.get).toHaveBeenCalledTimes(1); // re-resolve only; guard added no trip read
      });

      it("reflection after a provider edit runs fresh without throwing (re-resolve surfaces the tag, guard handles it)", async () => {
        const threadId = "sms:line-1:kpr313-reflect-flip";
        seed(threadId, "resp_x", "openai"); // stale reflection capture: agent now claude-static
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "reflected fresh", sessionId: "s-fresh" }));

        const result = await manager.spawnTurn({
          ...smsCtx({ threadId, sessionId: undefined, sessionProvider: undefined }),
          kind: "reflection" as const,
        });

        expect(result.errors).toEqual([]);
        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBeUndefined();
        expect(prompt).toContain("session continuity was reset"); // no special-casing for reflection (⚠A7)
        expect(sessionStore.get).toHaveBeenCalledTimes(2); // re-resolve + trip re-read (redundant-but-idempotent)
      });
    });
  });

  // ---------------------------------------------------------------------------
  // KPR-224: spawnTurn shaping (prepareSpawn + recordSpawnObservability)
  // ---------------------------------------------------------------------------
  describe("spawnTurn shaping (KPR-224)", () => {
    beforeEach(() => {
      // ConversationIndex.index is fire-and-forget; helper calls .catch() so
      // the mock must return a Promise (default vi.fn() returns undefined).
      mockConversationIndex.mockResolvedValue(undefined);
    });

    function makeCtx(workItem: WorkItem, channel: any = "slack", sessionId?: string) {
      const threadId = workItem.threadId ?? workItem.id;
      return {
        agentId: "agent-a",
        sessionId,
        channelId: workItem.source.id,
        threadId,
        workItem,
        channel: channel as any,
      };
    }

    it("prepends sender identity for slack WorkItem", async () => {
      const item = makeWorkItem({
        text: "hello team",
        source: { kind: "slack", id: "C-GEN", label: "general" },
        sender: "U001",
        senderName: "May",
        meta: { slackTs: "1234" },
      });

      await manager.spawnTurn(makeCtx(item, "slack"));

      const [prompt] = mockRunnerSend.mock.calls[0]!;
      expect(prompt).toBe("[May in #general, thread=1234]: hello team");
    });

    it("prepends user identity for team channel WorkItem", async () => {
      const item = makeWorkItem({
        text: "ping",
        source: { kind: "team", id: "team:foo", label: "team:foo", adapterId: "ws" },
        sender: "device-1",
        senderName: "device-1",
        meta: { user: "may-keepur" },
      });

      await manager.spawnTurn(makeCtx(item, "team"));

      const [prompt] = mockRunnerSend.mock.calls[0]!;
      expect(prompt).toBe("[user:may-keepur via device-1 in #team:foo]: ping");
    });

    it("appends file attachments to prompt", async () => {
      const { formatFilesForPrompt } = await import("../files/file-processor.js");
      vi.mocked(formatFilesForPrompt).mockReturnValueOnce("\n\n[attachment summary]");

      const item = makeWorkItem({
        text: "look at this",
        source: { kind: "slack", id: "C1", label: "general" },
        files: [{ name: "doc.txt", url: "https://example.com/doc.txt" } as any],
      });

      await manager.spawnTurn(makeCtx(item, "slack"));

      const [prompt] = mockRunnerSend.mock.calls[0]!;
      expect(prompt.endsWith("[attachment summary]")).toBe(true);
    });

    it("calls model router and delivers no override + static limits in runner.send (KPR-338 §3.2)", async () => {
      (appConfig as any).modelRouter.enabled = true;
      try {
        // Effort-only result (KPR-338) — no routed model/limits: model stays
        // static, limits are the agent's STATIC tier (agent-s → sonnet).
        vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult());

        const item = makeWorkItem({
          text: "shape me",
          source: { kind: "sms", id: "line-1", label: "May" },
        });
        await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "agent-s" });

        expect(routeModel).toHaveBeenCalledTimes(1);
        const [, , , , resourceLimits] = mockRunnerSend.mock.calls[0]!;
        expect(resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    it("adds router cost to TurnResult.usage.costUsd", async () => {
      (appConfig as any).modelRouter.enabled = true;
      try {
        vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult({ costUsd: 0.0042 }));
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ costUsd: 0.05, sessionId: "s-cost" }));

        const item = makeWorkItem({ text: "cost test", source: { kind: "sms", id: "line-1", label: "May" } });
        const result = await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "agent-s" });

        // 0.05 (runner) + 0.0042 (router) = 0.0542
        expect(result.usage.costUsd).toBeCloseTo(0.0542, 5);
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    it("routes codex-prefixed agents to the Codex subscription adapter", async () => {
      registry._agents.set(
        "codex-pilot",
        makeAgentConfig({
          id: "codex-pilot",
          name: "Codex Pilot",
          model: "codex/gpt-5.5:medium",
          coreServers: [],
          soul: "pilot soul",
          systemPrompt: "pilot system",
        }),
      );

      const item = makeWorkItem({ text: "hello codex", source: { kind: "sms", id: "line-1", label: "May" } });
      const result = await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });

      expect(mockRunnerSend).not.toHaveBeenCalled();
      expect(mockCodexConstructor).toHaveBeenCalledWith({
        name: "Codex Pilot",
        model: "gpt-5.5",
        reasoningEffort: "medium",
        assembly: expect.objectContaining({
          // KPR-349: instructions now come from the runner's buildProviderPrompt
          // (mocked here); content is pinned in agent-runner/turn-assembly tests.
          instructions: "PILOT-ASSEMBLED-INSTRUCTIONS",
          toolInventory: [],
          omittedTools: [],
          memory: {},
          skillIndex: [],
        }),
      });
      expect(mockCodexRunTurn).toHaveBeenCalledWith(expect.objectContaining({
        prompt: "hello codex",
        sessionId: undefined,
      }));
      // KPR-338: the manager no longer sets modelOverride on the turn request.
      expect("modelOverride" in mockCodexRunTurn.mock.calls[0]![0]).toBe(false);
      expect(result.finalMessage).toBe("codex response");
      expect(result.newSessionId).toBe("codex-session");
    });

    it.each([
      ["openai/gpt-5.4-mini", mockOpenAIConstructor, mockOpenAIRunTurn, "openai response", "openai-session"],
      ["gemini/gemini-2.5-flash", mockGeminiConstructor, mockGeminiRunTurn, "gemini response", "gemini-session"],
      ["openai-codex/gpt-5.4", mockCodexConstructor, mockCodexRunTurn, "codex response", "codex-session"],
    ] as const)("routes %s through the matching pilot adapter", async (model, constructorMock, runTurnMock, text, sessionId) => {
      const agentId = `pilot-${model.replace(/[^a-z0-9]+/gi, "-")}`;
      registry._agents.set(
        agentId,
        makeAgentConfig({
          id: agentId,
          name: "Pilot",
          model,
          coreServers: [],
          soul: "",
          systemPrompt: "pilot system",
        }),
      );

      const item = makeWorkItem({ text: "ping", source: { kind: "sms", id: "line-1", label: "May" } });
      const result = await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId });

      expect(mockRunnerSend).not.toHaveBeenCalled();
      expect(constructorMock).toHaveBeenCalledWith(expect.objectContaining({
        name: "Pilot",
        assembly: expect.objectContaining({ instructions: "PILOT-ASSEMBLED-INSTRUCTIONS" }),
      }));
      expect(runTurnMock).toHaveBeenCalledWith(expect.objectContaining({ prompt: "ping" }));
      expect(result.finalMessage).toBe(text);
      expect(result.newSessionId).toBe(sessionId);
    });

    it("KPR-347: pilots construct and run with a REAL non-empty inventory — guards are gone, partition feeds the assembly", async () => {
      registry._agents.set(
        "codex-pilot",
        makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5:medium", coreServers: [] }),
      );
      mockRunnerToolInventory.mockReturnValueOnce([
        {
          name: "memory", transport: "sdk-in-process", source: "core",
          requiresTurnContext: false, requiresHiveRuntime: true, inProcess: true,
          compatibility: { claude: "direct", openai: "requires-hive-bridge", gemini: "requires-hive-bridge", codex: "requires-hive-bridge" },
          schemas: { kind: "connect-time" },
        },
        {
          name: "Bash", transport: "claude-builtin", source: "sdk-builtin",
          requiresTurnContext: false, requiresHiveRuntime: false, inProcess: false,
          compatibility: { claude: "direct", openai: "claude-only", gemini: "claude-only", codex: "claude-only" },
          schemas: { kind: "unavailable" },
        },
      ]);
      const item = makeWorkItem({
        text: "hello codex",
        source: { kind: "sms", id: "line-1-seam", label: "May" },
        threadId: "sms:line-1:seam-inv-ctx",
      });
      const result = await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });
      expect(result.finalMessage).toBe("codex response");
      const options = mockCodexConstructor.mock.calls.at(-1)![0];
      expect(options.assembly.toolInventory.map((e: { name: string }) => e.name)).toEqual(["memory"]);
      expect(options.assembly.omittedTools).toEqual([
        { name: "Bash", transport: "claude-builtin", compatibility: "claude-only" },
      ]);
      // KPR-347 NIT: the inventory is built with the turn's WorkItemContext
      // (bgContext hoisted BEFORE createProviderAdapter). Pin the seam so
      // reverting the hoist — passing undefined / stale ctx to Lane B
      // assembly — fails here rather than silently degrading context-sensitive
      // server configs.
      expect(mockRunnerToolInventory).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "line-1-seam", threadId: "sms:line-1:seam-inv-ctx" }),
      );
    });

    it("records telemetry, conversation index, and activity audit on success", async () => {
      const activityLogger = { record: vi.fn() };
      const localManager = new AgentManager(
        registry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        activityLogger as any,
      );
      mockRunnerSend.mockResolvedValueOnce(
        makeRunResult({ text: "ack", sessionId: "session-obs", costUsd: 0.02, durationMs: 250 }),
      );

      const item = makeWorkItem({
        text: "obs check",
        source: { kind: "sms", id: "line-1", label: "May (CEO)" },
        senderName: "May",
      });
      await localManager.spawnTurn(makeCtx(item, "sms"));
      // Fire-and-forget telemetry/index — give a microtask to settle.
      await Promise.resolve();
      await Promise.resolve();

      // Telemetry — fired with the shaped prompt and the runner's
      // session/token counts.
      expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
      const telArg = turnTelemetryStore.record.mock.calls[0][0];
      expect(telArg.agentId).toBe("agent-a");
      expect(telArg.sessionId).toBe("session-obs");
      expect(telArg.inputTokens).toBe(100);

      // Conversation index — inbound is the shaped prompt, response is runner text.
      expect(mockConversationIndex).toHaveBeenCalledTimes(1);
      const idxArg = mockConversationIndex.mock.calls[0]![0];
      expect(idxArg.agentId).toBe("agent-a");
      expect(idxArg.inbound).toContain("obs check");
      expect(idxArg.response).toBe("ack");

      // Activity audit — full payload with cost/duration from RunResult.
      expect(activityLogger.record).toHaveBeenCalledTimes(1);
      const auditArg = activityLogger.record.mock.calls[0]![0];
      expect(auditArg.agentId).toBe("agent-a");
      expect(auditArg.costUsd).toBe(0.02);
      expect(auditArg.durationMs).toBe(250);
      expect(auditArg.channelKind).toBe("sms");
    });

    it("voice carve-out: passes raw text to runner.send and skips model router", async () => {
      // KPR-219 design: voice has its own systemPromptOverride and explicitly
      // bypasses sender prepending + model router. KPR-224's prepareSpawn must
      // preserve this carve-out so future shaping edits cannot regress voice.
      (appConfig as any).modelRouter.enabled = true;
      try {
        const item = makeWorkItem({
          id: "call-1",
          text: "raw voice text",
          source: { kind: "voice", id: "call-1", label: "voice:call-1" },
          threadId: "voice:call-1",
          senderName: "Caller",
        });
        await manager.spawnTurn(makeCtx(item, "voice"));

        // Raw text passed through — no `[Caller in #voice:call-1]:` prefix.
        const [prompt] = mockRunnerSend.mock.calls[0]!;
        expect(prompt).toBe("raw voice text");

        // routeModel NOT invoked despite modelRouter.enabled=true.
        expect(routeModel).not.toHaveBeenCalled();
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    describe("router→adapter seam (KPR-311)", () => {
      afterEach(() => {
        (appConfig as any).modelRouter.enabled = false;
      });

      it("delivers effort beside the static route (KPR-312 channel; KPR-338: no model merge)", async () => {
        (appConfig as any).modelRouter.enabled = true;
        // KPR-338: the router no longer names a model — the turn runs the
        // agent's static model. Effort still travels BESIDE the route via
        // SpawnShaping.effortOverride → runner.send position 6 (KPR-312).
        vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult({ effort: "high" }));

        const item = makeWorkItem({ text: "route me", source: { kind: "sms", id: "line-1", label: "May" } });
        await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "agent-s" });

        expect(routeModel).toHaveBeenCalledTimes(1);
        expect(mockRunnerSend).toHaveBeenCalledTimes(1);
        const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
        expect(resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
        expect(effort).toBe("high");
      });

      it("skips the router for sender === 'system' (scheduler/cron)", async () => {
        (appConfig as any).modelRouter.enabled = true;
        const item = makeWorkItem({
          text: "execute your scheduled digest task",
          sender: "system",
          source: { kind: "sms", id: "line-1", label: "May" },
        });
        await manager.spawnTurn(makeCtx(item, "sms"));

        expect(routeModel).not.toHaveBeenCalled();
        const [, , , , resourceLimits] = mockRunnerSend.mock.calls[0]!;
        expect(resourceLimits).toBeUndefined();
      });

      it("pilot gate: routeModel is never called for a non-Claude-static agent, even with the router enabled", async () => {
        (appConfig as any).modelRouter.enabled = true;
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult()); // defined pre-fix behavior for negative-verify
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({
            id: "codex-pilot",
            name: "Codex Pilot",
            model: "codex/gpt-5.5:medium",
            coreServers: [],
            soul: "pilot soul",
            systemPrompt: "pilot system",
          }),
        );

        const item = makeWorkItem({ text: "hello codex", source: { kind: "sms", id: "line-1", label: "May" } });
        const result = await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });

        // No router call → no cost, no misattributed override.
        expect(routeModel).not.toHaveBeenCalled();
        // Pilot constructed from the static route, exactly as with the router disabled.
        expect(mockCodexConstructor).toHaveBeenCalledWith(
          expect.objectContaining({ model: "gpt-5.5", reasoningEffort: "medium" }),
        );
        // KPR-338: the manager no longer sets modelOverride on the turn request.
        expect("modelOverride" in mockCodexRunTurn.mock.calls[0]![0]).toBe(false);
        expect(result.finalMessage).toBe("codex response");
      });

      // KPR-338 §3.2: clamp branch deleted with ModelRouterResult.provider;
      // invariant re-pinned below.
      it("shaped route ≡ static route on every path (KPR-338 invariant re-pin)", async () => {
        (appConfig as any).modelRouter.enabled = true;
        // An effort-only router result — nothing in it moves the turn off the
        // agent's static route (KPR-338: no tier/model to name).
        vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult({ effort: "high" }));
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ costUsd: 0.05, sessionId: "s-static" }));

        const activityLogger = { record: vi.fn() };
        const localManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          activityLogger as any,
        );

        const item = makeWorkItem({ text: "static me", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "agent-s" });

        // Claude adapter ran — no pilot constructor for any provider.
        expect(mockOpenAIConstructor).not.toHaveBeenCalled();
        expect(mockCodexConstructor).not.toHaveBeenCalled();
        expect(mockGeminiConstructor).not.toHaveBeenCalled();
        // KPR-338: send carries no per-turn model — arity pin proves no extra
        // positional survives (the type system enforces the rest).
        expect(mockRunnerSend.mock.calls[0]!.length).toBe(7);
        // Telemetry + audit both read the agent's STATIC model, not the route junk.
        expect(turnTelemetryStore.record).toHaveBeenCalledWith(
          expect.objectContaining({ model: "claude-sonnet-4-6" }),
        );
        expect(activityLogger.record).toHaveBeenCalledWith(
          expect.objectContaining({ model: "claude-sonnet-4-6" }),
        );
      });

      it("createProviderAdapter consumes the shaping route, not a re-resolve of the live registry model", async () => {
        const { formatFilesForPrompt } = await import("../files/file-processor.js");
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({
            id: "codex-pilot",
            name: "Codex Pilot",
            model: "codex/gpt-5.5:medium",
            coreServers: [],
            soul: "",
            systemPrompt: "pilot system",
          }),
        );
        // Mutate the registry model AFTER prepareSpawn resolves the static
        // route (formatFilesForPrompt runs inside prepareSpawn, after the
        // route read) but BEFORE adapter construction. A re-resolve inside
        // createProviderAdapter would see gpt-9:low; the passed route must
        // carry gpt-5.5:medium. (Fails against pre-KPR-311 code.)
        vi.mocked(formatFilesForPrompt).mockImplementationOnce(() => {
          registry._agents.set(
            "codex-pilot",
            makeAgentConfig({
              id: "codex-pilot",
              name: "Codex Pilot",
              model: "codex/gpt-9:low",
              coreServers: [],
              soul: "",
              systemPrompt: "pilot system",
            }),
          );
          return "";
        });

        const item = makeWorkItem({
          text: "seam check",
          source: { kind: "sms", id: "line-1", label: "May" },
          files: [{ name: "doc.txt", url: "https://example.com/doc.txt" } as any],
        });
        await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });

        expect(mockCodexConstructor).toHaveBeenCalledWith(
          expect.objectContaining({ model: "gpt-5.5", reasoningEffort: "medium" }),
        );
      });

      it("auth-rebuild retry reuses the first routing decision — routeModel once, same limits/effort, no override on both attempts", async () => {
        (appConfig as any).modelRouter.enabled = true;
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult({ effort: "medium" }));
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "401 Unauthorized" }));
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "recovered", sessionId: "s2" }));

        const item = makeWorkItem({ text: "retry me", source: { kind: "sms", id: "line-1", label: "May" } });
        // sessionId present — the auth-rebuild retry only fires on resumable turns.
        await manager.spawnTurn({ ...makeCtx(item, "sms", "s1"), agentId: "agent-s" });

        expect(routeModel).toHaveBeenCalledTimes(1); // no re-route, no double routerCostUsd
        expect(mockRunnerSend).toHaveBeenCalledTimes(2);
        // KPR-338: no per-turn model override on either attempt; identical
        // static limits + effort reused (shaping resolved once).
        expect(mockRunnerSend.mock.calls[0]![4]).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
        expect(mockRunnerSend.mock.calls[1]![4]).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
        expect(mockRunnerSend.mock.calls[0]![6]).toBe("medium");
        expect(mockRunnerSend.mock.calls[1]![6]).toBe("medium");
      });

      it("activity audit modelTier: STATIC tier on both router-on and router-off claude turns (KPR-338 D4)", async () => {
        const activityLogger = { record: vi.fn() };
        const localManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          activityLogger as any,
        );

        // Router on → static tier reaches the audit (router output is effort-only).
        (appConfig as any).modelRouter.enabled = true;
        vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult());
        const item1 = makeWorkItem({ text: "tier check", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn({ ...makeCtx(item1, "sms"), agentId: "agent-s" });
        expect(activityLogger.record).toHaveBeenLastCalledWith(
          expect.objectContaining({ modelTier: "sonnet", model: "claude-sonnet-4-6" }),
        );

        // Router off → STILL the static tier (KPR-338 D4: tier is a per-agent
        // fact, was undefined pre-338). Property present AND "sonnet".
        (appConfig as any).modelRouter.enabled = false;
        const item2 = makeWorkItem({ text: "no tier", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn({ ...makeCtx(item2, "sms"), agentId: "agent-s" });
        const offArg = activityLogger.record.mock.calls.at(-1)![0];
        expect("modelTier" in offArg).toBe(true);
        expect(offArg.modelTier).toBe("sonnet");
      });

      it("misattribution fix: a router-enabled pilot agent audits its static model, no tier, no router call", async () => {
        (appConfig as any).modelRouter.enabled = true;
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult()); // would misattribute pre-fix
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({
            id: "codex-pilot",
            name: "Codex Pilot",
            model: "codex/gpt-5.5:medium",
            coreServers: [],
            soul: "",
            systemPrompt: "pilot system",
          }),
        );
        const activityLogger = { record: vi.fn() };
        const localManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          activityLogger as any,
        );

        const item = makeWorkItem({ text: "audit me", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });

        expect(routeModel).not.toHaveBeenCalled();
        // Static pilot model in the audit — NOT a Claude router output.
        expect(activityLogger.record).toHaveBeenCalledWith(
          expect.objectContaining({ model: "codex/gpt-5.5:medium" }),
        );
        // modelTier: property present AND undefined (see comment above).
        const pilotArg = activityLogger.record.mock.calls.at(-1)![0];
        expect("modelTier" in pilotArg).toBe(true);
        expect(pilotArg.modelTier).toBeUndefined();
      });

      describe("effort delivery channel (KPR-312)", () => {
        it("threads hasFiles into routeModel's 2nd arg", async () => {
          (appConfig as any).modelRouter.enabled = true;
          vi.mocked(routeModel).mockResolvedValue(makeRouterResult());

          // agent-s (sonnet) — the haiku default skips the router entirely.
          const noFiles = makeWorkItem({ text: "no files", source: { kind: "sms", id: "line-1", label: "May" } });
          await manager.spawnTurn({ ...makeCtx(noFiles, "sms"), agentId: "agent-s" });
          expect(vi.mocked(routeModel).mock.calls[0]![1]).toEqual({ hasFiles: false });
          // Exact-args pin (KPR-338 2-arg contract): text + opts only — no
          // ceiling, no resourceTiers overrides.
          expect(vi.mocked(routeModel)).toHaveBeenCalledWith("no files", { hasFiles: false });

          const withFiles = makeWorkItem({
            text: "",
            source: { kind: "sms", id: "line-1", label: "May" },
            files: [{ name: "doc.txt", url: "https://example.com/doc.txt" } as any],
          });
          await manager.spawnTurn({ ...makeCtx(withFiles, "sms"), agentId: "agent-s", threadId: "sms:line-1:files" });
          expect(vi.mocked(routeModel).mock.calls[1]![1]).toEqual({ hasFiles: true });
        });

        it("router-off and system-sender paths deliver no effort", async () => {
          (appConfig as any).modelRouter.enabled = false;
          const off = makeWorkItem({ text: "plain", source: { kind: "sms", id: "line-1", label: "May" } });
          await manager.spawnTurn(makeCtx(off, "sms"));
          expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();

          (appConfig as any).modelRouter.enabled = true;
          const sys = makeWorkItem({
            text: "execute your scheduled digest task",
            sender: "system",
            source: { kind: "sms", id: "line-1", label: "May" },
          });
          await manager.spawnTurn({ ...makeCtx(sys, "sms"), threadId: "sms:line-1:sys" });
          expect(routeModel).not.toHaveBeenCalled();
          expect(mockRunnerSend.mock.calls[1]![6]).toBeUndefined();
        });

        it("voice path delivers no effort (carve-out — router never runs)", async () => {
          (appConfig as any).modelRouter.enabled = true;
          vi.mocked(routeModel).mockResolvedValue(makeRouterResult({ effort: "high" }));
          // Mirror the existing voice carve-out test's ctx/item construction (rule 1).
          const item = makeWorkItem({ text: "voice turn", source: { kind: "ws", id: "voice-1", label: "voice" } });
          await manager.spawnTurn({ ...makeCtx(item, "voice"), threadId: "voice:1" });
          expect(routeModel).not.toHaveBeenCalled();
          expect(mockRunnerSend.mock.calls[0]![4]).toBeUndefined(); // resourceLimits pinned undefined
          expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();
        });

        it("delivers effort with no model override anywhere (KPR-338)", async () => {
          (appConfig as any).modelRouter.enabled = true;
          // KPR-338: the router names no model; the turn runs the agent's
          // static model, effort still rides beside the route.
          vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult({ effort: "low" }));

          const item = makeWorkItem({ text: "same model", source: { kind: "sms", id: "line-1", label: "May" } });
          await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "agent-s" });

          const [, , , , , , effort] = mockRunnerSend.mock.calls[0]!;
          expect(effort).toBe("low"); // effort still delivered beside the static route
        });

        it("pilot runTurn request carries effort: undefined (gate: router never ran)", async () => {
          (appConfig as any).modelRouter.enabled = true;
          vi.mocked(routeModel).mockResolvedValue(makeRouterResult({ effort: "high" }));
          registry._agents.set(
            "codex-pilot",
            makeAgentConfig({
              id: "codex-pilot",
              name: "Codex Pilot",
              model: "codex/gpt-5.5:medium",
              coreServers: [],
              soul: "",
              systemPrompt: "pilot system",
            }),
          );

          const item = makeWorkItem({ text: "hello codex", source: { kind: "sms", id: "line-1", label: "May" } });
          await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "codex-pilot" });

          expect(routeModel).not.toHaveBeenCalled();
          const req = mockCodexRunTurn.mock.calls[0]![0];
          expect(req.effort).toBeUndefined();
          expect(req.resourceLimits).toBeUndefined();
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // KPR-220 Phase 11: getSnapshot + saturation tracking
  // ---------------------------------------------------------------------------
  describe("getSnapshot (KPR-220 Phase 11)", () => {
    it("KPR-220 Phase 16: includes every registered agent on a fresh engine (no traffic yet)", () => {
      // Phase 16: snapshot includes registry.listIds() so the heartbeat
      // writes meaningful rows on first poll even without traffic. Mock
      // registry has agent-a, agent-b, and agent-s (KPR-338 sonnet fixture);
      // all should appear with zero-valued fields.
      const snapshot = manager.getSnapshot();
      expect(Object.keys(snapshot.perAgent).sort()).toEqual(["agent-a", "agent-b", "agent-s"]);
      const a = snapshot.perAgent["agent-a"]!;
      expect(a.activeSpawns).toBe(0);
      expect(a.activeThreadKeys).toEqual([]);
      expect(a.saturationCount).toBe(0);
      expect(a.lastSaturationAt).toBeNull();
      expect(a.lastSpawnAt).toBeNull();
      expect(a.lastError).toBeNull();
      expect(a.stopped).toBe(false);
    });

    it("returns activeSpawns, budget, budgetSource, lastSpawnAt for an agent after spawnTurn", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      const before = Date.now();
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
      const after = Date.now();

      const snapshot = manager.getSnapshot();
      const perAgent = snapshot.perAgent["agent-a"];
      expect(perAgent).toBeDefined();
      expect(perAgent!.activeSpawns).toBe(0); // ticket released after spawn completes
      expect(perAgent!.budget).toBe(2); // agent-a has maxConcurrent: 2 → fallback chain → 2
      expect(perAgent!.budgetSource).toBe("maxConcurrent");
      expect(perAgent!.saturationCount).toBe(0);
      expect(perAgent!.lastSaturationAt).toBeNull();
      expect(perAgent!.lastError).toBeNull();
      expect(perAgent!.stopped).toBe(false);
      expect(perAgent!.lastSpawnAt).toBeGreaterThanOrEqual(before);
      expect(perAgent!.lastSpawnAt).toBeLessThanOrEqual(after);
    });

    it("reports activeSpawns > 0 mid-flight (snapshot taken inside spawn)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      let capturedActiveSpawns = -1;
      mockRunnerSend.mockImplementation(async () => {
        capturedActiveSpawns = manager.getSnapshot().perAgent["agent-a"]!.activeSpawns;
        return makeRunResult();
      });
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
      expect(capturedActiveSpawns).toBe(1);
    });

    it("KPR-220 Phase 11: recordSaturation increments saturationCount and lastSaturationAt on budget reject", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // Park 2 spawns to fill the agent-a maxConcurrent=2 budget. Each parked
      // spawn gets its own resolver so the cleanup can drain them both.
      const resolvers: Array<() => void> = [];
      mockRunnerSend.mockImplementation(
        () =>
          new Promise<any>((resolve) => {
            resolvers.push(() => resolve(makeRunResult()));
          }),
      );

      const p1 = manager.spawnTurn(makeSmsCtx({ agentId: "agent-a", threadId: "t-sat-1" }));
      const p2 = manager.spawnTurn(makeSmsCtx({ agentId: "agent-a", threadId: "t-sat-2" }));
      await new Promise((r) => setTimeout(r, 20));

      // Third spawn must hit the budget-exceeded path and increment saturation.
      const before = Date.now();
      await expect(
        manager.spawnTurn(makeSmsCtx({ agentId: "agent-a", threadId: "t-sat-3" })),
      ).rejects.toThrow(/Spawn budget exceeded/);
      const after = Date.now();

      const snapshot = manager.getSnapshot();
      const perAgent = snapshot.perAgent["agent-a"]!;
      expect(perAgent.saturationCount).toBe(1);
      expect(perAgent.lastSaturationAt).toBeGreaterThanOrEqual(before);
      expect(perAgent.lastSaturationAt).toBeLessThanOrEqual(after);

      // Cleanup — release parked spawns.
      for (const r of resolvers) r();
      await Promise.all([p1, p2]).catch(() => {});
    });

    it("KPR-220 Phase 11 / spec S8: snapshot.stopped reflects stoppedAgents", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));
      manager.stopAgent("agent-a");

      const snapshot = manager.getSnapshot();
      expect(snapshot.perAgent["agent-a"]!.stopped).toBe(true);

      // restart clears the flag in the snapshot
      manager.restartAgent("agent-a");
      const after = manager.getSnapshot();
      expect(after.perAgent["agent-a"]!.stopped).toBe(false);
    });

    it("KPR-220 Phase 11: snapshot.lastError carries truncated runner error string", async () => {
      const longError = "a".repeat(300);
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "partial", error: longError }));
      mockConversationIndex.mockResolvedValue(undefined);

      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-a" }));

      const perAgent = manager.getSnapshot().perAgent["agent-a"]!;
      expect(perAgent.lastError).not.toBeNull();
      expect(perAgent.lastError!.length).toBe(240);
      expect(perAgent.lastError!).toBe(longError.slice(0, 240));
    });

    it("budgetSource defaults to 'default' when neither spawnBudget nor maxConcurrent is set", async () => {
      // agent-b has no maxConcurrent + no spawnBudget → falls through to engine default.
      // Post-Phase-16, agent-b is already present in the snapshot from the registry
      // (zero-valued fields); the budget + source still resolve via spawnBudgetFor.
      const preSnap = manager.getSnapshot();
      expect(preSnap.perAgent["agent-b"]).toBeDefined();
      expect(preSnap.perAgent["agent-b"]!.budgetSource).toBe("default");
      expect(preSnap.perAgent["agent-b"]!.budget).toBe(5);

      mockConversationIndex.mockResolvedValue(undefined);
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-b" }));
      const snap = manager.getSnapshot();
      expect(snap.perAgent["agent-b"]!.budgetSource).toBe("default");
      expect(snap.perAgent["agent-b"]!.budget).toBe(5);
    });
  });
});
