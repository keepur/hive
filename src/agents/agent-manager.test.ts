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
    gemini: { agentModel: "", apiKey: "test-gemini-key" },
    // KPR-346: Lane A passthrough model overrides + instance id consumed by
    // createProviderAdapter's resolvePassthroughSpawn call.
    kimi: { agentModel: "" },
    deepseek: { agentModel: "" },
    // KPR-371/KPR-410: grok's default-model override; the credential (an xAI
    // subscription OAuth access token) is resolved from ~/.grok/auth.json by
    // grok-oauth.ts, not from config/env.
    grok: { agentModel: "" },
    instance: { id: "test-instance" },
    modelRouter: { enabled: false },
    memory: { reflectionMinTurns: 3 },
    // KPR-390: agent-manager.ts never reads this, but the worker-mode
    // end-to-end pin constructs a REAL AgentRunner (vi.importActual) whose
    // buildInProcessServers reads config.workflow.enabled unconditionally.
    workflow: { enabled: false },
    // KPR-409 T7: the scribe containment pin also reaches
    // buildToolTransportInventory → buildAllServerConfigs, which reads every
    // stdio server's config block unconditionally. All falsy/empty so no
    // vendor server is enabled — the pin is about what suppression strips.
    slack: { localMcpServer: false, mcpToken: "" },
    mongo: { uri: "mongodb://localhost:27017", dbName: "hive-test" },
    google: { client: "", accounts: {} as Record<string, string[]>, sharedFolder: "" },
    quo: { apiKey: "", phoneNumberId: "", lines: [] },
    voice: { enabled: false, apiKey: "", phoneNumberId: "", assistants: {} },
    taskLedger: { apiUrl: "", apiKey: "", agentKeys: {} as Record<string, string> },
    brave: { apiKey: "" },
    resend: { apiKey: "", emailDomain: "", businessName: "", fromAddress: "", defaultCc: "", defaultBcc: "" },
    linear: { apiKey: "", teamId: "" },
    github: { repo: "", token: "" },
    clickup: { apiToken: "" },
    recall: { apiKey: "", region: "", monitorPort: 3100, monitorPublicUrl: "", webhookSecret: "" },
    browser: { cdpEndpoint: "" },
    background: { port: 3200, authToken: "" },
    codeTask: { port: 3202, authToken: "", pluginDir: "" },
    defaultAgent: "chief-of-staff",
  },
}));

// KPR-346: the Lane A credential chain is env → Keychain. Stub the Keychain
// leg so no real `security` subprocess ever runs; env (KIMI_API_KEY /
// DEEPSEEK_API_KEY, set per-test) is the only live source in the suite.
vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: vi.fn(() => "") }));

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
  AgentRunner: vi.fn().mockImplementation(function () {
    return {
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
  };
  }),
  // Re-exported from agent-runner for plugin-loader path resolution; the test
  // manager doesn't use it, so a sentinel path is fine.
  DIST_DIR: "/mock/dist",
}));

const {
  mockCodexConstructor, mockCodexRunTurn, mockCodexAbort,
  mockOpenAIConstructor, mockOpenAIRunTurn, mockOpenAIAbort,
  mockGeminiConstructor, mockGeminiRunTurn, mockGeminiAbort,
  mockGrokConstructor, mockGrokRunTurn, mockGrokAbort,
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
  mockGrokConstructor: vi.fn(),
  mockGrokRunTurn: vi.fn(),
  mockGrokAbort: vi.fn(),
}));

vi.mock("./provider-adapters/codex-subscription-adapter.js", () => ({
  CodexSubscriptionAdapter: vi.fn().mockImplementation(function (options) {
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
  OpenAIAgentsAdapter: vi.fn().mockImplementation(function (options) {
    mockOpenAIConstructor(options);
    return {
      provider: "openai",
      runTurn: mockOpenAIRunTurn,
      abort: mockOpenAIAbort,
      wasAborted: false,
    };
  }),
}));

vi.mock("./provider-adapters/gemini-interactions-adapter.js", () => ({
  GeminiInteractionsAdapter: vi.fn().mockImplementation(function (options) {
    mockGeminiConstructor(options);
    return {
      provider: "gemini",
      runTurn: mockGeminiRunTurn,
      abort: mockGeminiAbort,
      wasAborted: false,
    };
  }),
}));

// KPR-410: grok's credential is an xAI subscription OAuth access token read
// from ~/.grok/auth.json by grok-oauth.ts — resolved per spawn by the
// manager's own grok arm. Hoisted so the vi.mock factory below can reference it.
const mockResolveOAuthFileToken = vi.hoisted(() => vi.fn());
vi.mock("./provider-adapters/grok-oauth.js", () => ({
  resolveOAuthFileToken: mockResolveOAuthFileToken,
}));

// KPR-392: importOriginal preserves the module's real constant exports
// (DEFAULT_GROK_MODEL, __resetGrokCoercionWarnedForTests) —
// provider-modules.ts (fallback model) imports one of them at module load,
// so a bare mock factory would silently zero that default out.
vi.mock("./provider-adapters/grok-adapter.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  GrokAdapter: vi.fn().mockImplementation(function (options) {
    mockGrokConstructor(options);
    return {
      provider: "grok",
      runTurn: mockGrokRunTurn,
      abort: mockGrokAbort,
      wasAborted: false,
    };
  }),
}));

// Mock conversation index (hoisted because ConversationIndex is instantiated at module level)
const { mockConversationIndex } = vi.hoisted(() => ({
  mockConversationIndex: vi.fn(),
}));
vi.mock("../search/conversation-index.js", () => ({
  ConversationIndex: vi.fn().mockImplementation(function () {
    return {
    index: mockConversationIndex,
  };
  }),
}));

import { AgentManager, conferenceRoundOf, isStaleServerHandleError, type TurnContext } from "./agent-manager.js";
import { config as appConfig } from "../config.js";
import { AgentRunner, type RunResult } from "./agent-runner.js";
import type { AgentConfig } from "../types/agent-config.js";
import { ProviderCircuitBreakerRegistry, ProviderCircuitOpenError } from "./provider-circuit-breaker.js";
import type { WorkItem } from "../types/work-item.js";
import { routeModel, RESOURCE_TIER_DEFAULTS } from "./model-router.js";
import type { ModelRouterResult } from "./model-router.js";
import type { AgentProviderId } from "./provider-adapters/types.js";
import { buildGenericDelegatePrompt, type DelegateTurnRunner } from "./provider-adapters/turn-assembly.js";
import type { HiveToolInventoryEntry } from "./provider-adapters/tool-transport.js";
import { classifyTurnResult, TurnAssemblyError } from "./provider-adapters/error-classification.js";

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

/** KPR-389: conference-shaped TurnContext + item, meta stamped like the dispatcher does. */
function makeConfCtx(
  round: 0 | 1,
  agentId = "agent-s",
  extraMeta: Record<string, unknown> = {},
): TurnContext & { workItem: WorkItem } {
  const threadId = `conf:${agentId}:${Math.random()}`;
  const workItem = makeWorkItem({
    text: "shaped preamble + transcript + peer reply",
    threadId,
    source: { kind: "slack", id: "C-CONF", label: "conf-tahoe" },
    sender: "U-MAY",
    senderName: "May",
    meta: { conferenceMode: true, conferenceRound: round, ...extraMeta },
  });
  return {
    agentId,
    sessionId: undefined,
    channelId: "C-CONF",
    threadId,
    workItem,
    channel: "slack" as const,
    conferenceRound: round,
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
    // Default mock: conversation indexing resolves. recordSpawnObservability
    // chains `.catch` on `index()`'s return value, so an unprimed vi.fn()
    // (returns undefined) throws. Priming here — not per-test — keeps every
    // row hermetic under `-t` filter isolation (KPR-400/KPR-403 review debt:
    // rows used to depend on an earlier sibling's inline prime surviving
    // clearAllMocks).
    mockConversationIndex.mockResolvedValue(undefined);
    mockRunnerToolInventory.mockReturnValue([]);
    mockCodexRunTurn.mockResolvedValue(makeRunResult({ text: "codex response", sessionId: "codex-session" }));
    mockOpenAIRunTurn.mockResolvedValue(makeRunResult({ text: "openai response", sessionId: "openai-session" }));
    mockGeminiRunTurn.mockResolvedValue(makeRunResult({ text: "gemini response", sessionId: "gemini-session" }));
    mockGrokRunTurn.mockResolvedValue(makeRunResult({ text: "grok response", sessionId: "grok-session" }));

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

    it("KPR-422: a custom top-level timeoutMs survives to the runner on the router-on path (the fable shape)", async () => {
      mockConversationIndex.mockResolvedValue(undefined);
      // claude-fable-5: no opus/haiku substring → static tier "sonnet". Pre-fix
      // the hardcoded sonnet default (300s) silently overrode the agent's own
      // 30-minute timeoutMs; turns died at exactly 5:00 into the KPR-402 chain.
      registry._agents.set(
        "agent-fable",
        makeAgentConfig({
          id: "agent-fable",
          name: "AgentFable",
          model: "claude-fable-5",
          timeoutMs: 1_800_000,
        }),
      );
      vi.mocked(routeModel).mockResolvedValue(makeRouterResult());

      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-fable" }));

      const [, , , , resourceLimits] = mockRunnerSend.mock.calls[0]!;
      expect(resourceLimits).toEqual({
        timeoutMs: 1_800_000,
        maxTurns: RESOURCE_TIER_DEFAULTS.sonnet.maxTurns,
        budgetUsd: RESOURCE_TIER_DEFAULTS.sonnet.budgetUsd,
      });
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

    it("does NOT update session-store when the result is aborted with ZERO progress (KPR-399 re-scope)", async () => {
      // Pre-KPR-399 this row pinned "aborted never persists" using the
      // fixture's default progress fields (toolCalls: 1, text: "response") —
      // a shape that now DELIBERATELY persists (§D2 persist-on-abort). It is
      // re-scoped to the zero-progress shape (also synthesizeAbortedResult's
      // shape): the fail-closed direction, which survives unchanged. The
      // with-progress direction is pinned in the KPR-399 persist-on-abort
      // describe below.
      mockRunnerSend.mockResolvedValueOnce(
        makeRunResult({ aborted: true, sessionId: "session-aborted", toolCalls: 0, streamed: false, text: "" }),
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

      it("KPR-400 F1: acquire meta deadlineMs ≥ the agent's own timeoutMs (900s architect shape)", async () => {
        // NEGATIVE-VERIFY prediction (Task 4 Step 3): pre-fix the acquire
        // meta carries agentId/threadId only — objectContaining fails.
        registry._agents.set(
          "agent-arch",
          makeAgentConfig({ id: "agent-arch", name: "Architect", model: "claude-sonnet-4-6", timeoutMs: 900_000 }),
        );
        const acquireSpy = vi.spyOn(manager.circuitBreakers, "acquire");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult());
        await manager.spawnTurn(smsCtx({ agentId: "agent-arch", threadId: "sms:line-1:kpr400-arch" }));
        // sonnet tier limit (300s) < explicit timeoutMs → max picks 900s.
        expect(acquireSpy).toHaveBeenCalledWith(
          "claude",
          expect.objectContaining({ agentId: "agent-arch", deadlineMs: 900_000 }),
        );
      });

      it("KPR-400 F1: acquire meta deadlineMs ≥ the opus tier limit when the agent has no explicit timeoutMs", async () => {
        registry._agents.set(
          "agent-opus",
          makeAgentConfig({ id: "agent-opus", name: "OpusAgent", model: "claude-opus-4-7" }),
        );
        const acquireSpy = vi.spyOn(manager.circuitBreakers, "acquire");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult());
        await manager.spawnTurn(smsCtx({ agentId: "agent-opus", threadId: "sms:line-1:kpr400-opus" }));
        // No explicit timeoutMs (default 300s) < opus tier limit → max picks 600s.
        expect(acquireSpy).toHaveBeenCalledWith(
          "claude",
          expect.objectContaining({ agentId: "agent-opus", deadlineMs: RESOURCE_TIER_DEFAULTS.opus.timeoutMs }),
        );
      });

      it("KPR-403: turnDeadlineUpperBoundMs — per-agent timeoutMs override wins (900s architect shape)", () => {
        // NEGATIVE-VERIFY prediction (Step 3): pre-fix the wrapper does not
        // exist — all three KPR-403 rows fail with a TypeError.
        registry._agents.set(
          "agent-arch-403",
          makeAgentConfig({ id: "agent-arch-403", name: "Architect", model: "claude-sonnet-4-6", timeoutMs: 900_000 }),
        );
        // sonnet tier limit (300s) < explicit timeoutMs → max picks 900s.
        expect(manager.turnDeadlineUpperBoundMs("agent-arch-403")).toBe(900_000);
      });

      it("KPR-403: turnDeadlineUpperBoundMs — router-path agent with no override gets the long tier limit", () => {
        registry._agents.set(
          "agent-opus-403",
          makeAgentConfig({ id: "agent-opus-403", name: "OpusAgent", model: "claude-opus-4-7" }),
        );
        // No explicit timeoutMs (default 300s) < opus tier limit → max picks the tier.
        expect(manager.turnDeadlineUpperBoundMs("agent-opus-403")).toBe(RESOURCE_TIER_DEFAULTS.opus.timeoutMs);
      });

      it("KPR-403: turnDeadlineUpperBoundMs — unknown agentId falls back to the 300s default", () => {
        expect(manager.turnDeadlineUpperBoundMs("no-such-agent")).toBe(300_000);
      });

      it("KPR-422: a tight custom timeoutMs does NOT lower the acquire bound below the tier limit (over-estimation posture)", () => {
        // Post-KPR-422 this agent's effective turn deadline is 120s (top-level
        // timeoutMs wins the resolution), but acquireDeadlineMs deliberately
        // does not pass the third argument — the bound stays max(120s, opus
        // 600s) = 600s. Over-estimating only delays reconciliation;
        // under-estimating stale-kills a legitimate self-heal retry mid-flight.
        registry._agents.set(
          "agent-opus-422",
          makeAgentConfig({ id: "agent-opus-422", name: "OpusTight", model: "claude-opus-4-7", timeoutMs: 120_000 }),
        );
        expect(manager.turnDeadlineUpperBoundMs("agent-opus-422")).toBe(RESOURCE_TIER_DEFAULTS.opus.timeoutMs);
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

      it("claude→pilot handoff uses the pilot annotation variant (no conversation_search — Lane B keeps the conservative pilot-era default)", async () => {
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

      it("KPR-350 §D4: claude→openai handoff — fresh session, annotation, first turn persists the openai handle", async () => {
        // openai→claude direction (:2371-2388) and the openai write-side persist
        // pin (:2492-2500) already exist; this pins the missing claude→openai
        // direction: guard strips the claude id, the annotation fires, and the
        // first openai turn persists its lastResponseId under the openai tag.
        registry._agents.set(
          "openai-pilot",
          makeAgentConfig({ id: "openai-pilot", name: "OpenAI Pilot", model: "openai/gpt-5.4-mini", coreServers: [] }),
        );
        const threadId = "sms:line-1:kpr350-c2o";
        seed(threadId, "claude-uuid-1", "claude", "openai-pilot");
        await manager.spawnTurn(
          smsCtx({ agentId: "openai-pilot", threadId, sessionId: "claude-uuid-1", sessionProvider: "claude" }),
        );
        const req = mockOpenAIRunTurn.mock.calls[0]![0];
        expect(req.sessionId).toBeUndefined(); // guard stripped the claude id
        expect(req.prompt).toContain("session continuity was reset"); // §3.4 annotation
        expect(sessionStore.set).toHaveBeenCalledWith(
          "openai-pilot", threadId, "openai-session", "openai", expect.anything(),
        ); // first openai turn persists the first lastResponseId
      });

      // KPR-352 §D5/T4: gemini joins server-resumable, so provider transitions
      // into and out of gemini exercise the same KPR-313 guard. The KPR-350
      // obligation: pin every direction a gemini handle could wrongly cross.
      describe("KPR-352 §D5/T4: gemini provider transitions", () => {
        function geminiAgent(id = "gem") {
          registry._agents.set(
            id,
            makeAgentConfig({ id, name: "Gem", model: "gemini/gemini-3.6-flash", coreServers: [] }),
          );
          return id;
        }

        it("claude→gemini: guard trips, fresh gemini turn, PILOT notice (conservative default), row rewritten with the interaction handle", async () => {
          const id = geminiAgent();
          const threadId = "sms:line-1:kpr352-c2g";
          seed(threadId, "claude-uuid-1", "claude", id);
          mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ text: "g", sessionId: "interactions/new" }));
          await manager.spawnTurn(
            smsCtx({ agentId: id, threadId, sessionId: "claude-uuid-1", sessionProvider: "claude" }),
          );
          const req = mockGeminiRunTurn.mock.calls[0]![0];
          expect(req.sessionId).toBeUndefined(); // guard stripped the claude id
          expect(req.prompt).toContain("session continuity was reset");
          expect(req.prompt).not.toContain("conversation_search"); // gemini gets the pilot variant
          expect(sessionStore.set).toHaveBeenCalledWith(id, threadId, "interactions/new", "gemini", expect.anything());
        });

        it("gemini→claude: guard trips, fresh claude turn, CLAUDE notice variant (conversation_search)", async () => {
          registry._agents.set("flipper", makeAgentConfig({ id: "flipper", name: "Flipper", model: "claude-sonnet-4-6" }));
          const threadId = "sms:line-1:kpr352-g2c";
          seed(threadId, "interactions/old", "gemini", "flipper");
          mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "c", sessionId: "s-new" }));
          await manager.spawnTurn(
            smsCtx({ agentId: "flipper", threadId, sessionId: "interactions/old", sessionProvider: "gemini" }),
          );
          const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
          expect(sessionArg).toBeUndefined(); // gemini handle never adopted by claude
          expect(prompt).toContain("session continuity was reset");
          expect(prompt).toContain("conversation_search"); // claude-target variant
        });

        it("openai→gemini: server-resumable→server-resumable STILL trips on provider mismatch — the openai handle never crosses", async () => {
          const id = geminiAgent();
          const threadId = "sms:line-1:kpr352-o2g";
          seed(threadId, "resp_openai", "openai", id);
          mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ text: "g", sessionId: "interactions/new" }));
          await manager.spawnTurn(
            smsCtx({ agentId: id, threadId, sessionId: "resp_openai", sessionProvider: "openai" }),
          );
          expect(mockGeminiRunTurn.mock.calls[0]![0].sessionId).toBeUndefined();
          expect(sessionStore.set).toHaveBeenCalledWith(id, threadId, "interactions/new", "gemini", expect.anything());
        });

        it("gemini→openai: the interaction handle never crosses into an openai turn", async () => {
          registry._agents.set(
            "oai",
            makeAgentConfig({ id: "oai", name: "Oai", model: "openai/gpt-5.4-mini", coreServers: [] }),
          );
          const threadId = "sms:line-1:kpr352-g2o";
          seed(threadId, "interactions/old", "gemini", "oai");
          await manager.spawnTurn(
            smsCtx({ agentId: "oai", threadId, sessionId: "interactions/old", sessionProvider: "gemini" }),
          );
          expect(mockOpenAIRunTurn.mock.calls[0]![0].sessionId).toBeUndefined();
          expect(sessionStore.set).toHaveBeenCalledWith("oai", threadId, "openai-session", "openai", expect.anything());
        });

        it("adopt: a seeded gemini row matching a gemini turn resumes the handle with NO handoff notice", async () => {
          const id = geminiAgent();
          const threadId = "sms:line-1:kpr352-gem-adopt";
          seed(threadId, "interactions/keep", "gemini", id);
          await manager.spawnTurn(
            smsCtx({ agentId: id, threadId, sessionId: "interactions/keep", sessionProvider: "gemini" }),
          );
          const req = mockGeminiRunTurn.mock.calls[0]![0];
          expect(req.sessionId).toBe("interactions/keep"); // same-provider hot path resumes
          expect(req.prompt).not.toContain("session continuity was reset");
        });
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

      it("persist rule: claude id+tag; codex ''+tag with findAgentByThread intact; gemini id+tag (server-resumable)", async () => {
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

        // Gemini — KPR-352: server-resumable now, so the real Interactions
        // handle is persisted under the gemini tag (was ""+tag pre-flip).
        registry._agents.set(
          "gemini-pilot",
          makeAgentConfig({ id: "gemini-pilot", name: "Gemini Pilot", model: "gemini/gemini-3-pro", coreServers: [] }),
        );
        mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ text: "g", sessionId: "interactions/xyz" }));
        await manager.spawnTurn(smsCtx({ agentId: "gemini-pilot", threadId: "sms:line-1:kpr313-p-gem" }));
        expect(sessionStore.set).toHaveBeenLastCalledWith(
          "gemini-pilot", "sms:line-1:kpr313-p-gem", "interactions/xyz", "gemini", expect.anything(),
        );
      });

      it("KPR-352 churn-mint: errored gemini turn that resumed and minted a DIFFERENT interaction id never overwrites the row", async () => {
        registry._agents.set(
          "gemini-pilot",
          makeAgentConfig({ id: "gemini-pilot", name: "Gemini Pilot", model: "gemini/gemini-3-pro", coreServers: [] }),
        );
        mockGeminiRunTurn.mockResolvedValueOnce(
          makeRunResult({ error: "some tool blew up mid-turn", sessionId: "interactions/new" }),
        );
        await manager.spawnTurn(
          smsCtx({
            agentId: "gemini-pilot",
            threadId: "sms:line-1:kpr352-gem-mint",
            sessionId: "interactions/old",
            sessionProvider: "gemini",
          }),
        );
        expect(sessionStore.set).not.toHaveBeenCalled();
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("different id"),
          expect.objectContaining({ agentId: "gemini-pilot" }),
        );
      });

      it("KPR-352: errored FRESH gemini turn returning sessionId:'' does not persist (falsy guard)", async () => {
        registry._agents.set(
          "gemini-pilot",
          makeAgentConfig({ id: "gemini-pilot", name: "Gemini Pilot", model: "gemini/gemini-3-pro", coreServers: [] }),
        );
        mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ error: "boom", sessionId: "" }));
        await manager.spawnTurn(smsCtx({ agentId: "gemini-pilot", threadId: "sms:line-1:kpr352-gem-fresh-err" }));
        expect(sessionStore.set).not.toHaveBeenCalled();
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
        // KPR-399 fixture re-scope (error string only — the pinned direction
        // is unchanged): this row previously used the CLI's unknown-session
        // text ("No conversation found with session ID: s-old"), which is now
        // an `isClaudeResumeLoadError` alternate — the §D3 self-heal arm
        // intercepts it BEFORE finalize, retries fresh, and the healed retry
        // legitimately persists (the arm's headline purpose: no more dead
        // thread until the 7d TTL). `error_during_execution` is the other
        // real failed-resume-mint surface (the source comment's own example:
        // the CLI's error_during_execution result carries a freshly minted
        // session_id) and matches no self-heal alternate, so the churn-mint
        // rider is exercised exactly as before.
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ error: "error_during_execution", sessionId: "s-minted" }),
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

      // KPR-353 (T4): TurnHistoryStore wiring — codex-branch options, the
      // §D4 handoff-clear, and its AWAITED ordering guarantee.
      describe("TurnHistoryStore wiring (KPR-353 §D3/§D4)", () => {
        function makeFakeTurnHistoryStore() {
          return {
            load: vi.fn(async () => [] as unknown[]),
            append: vi.fn(async () => {}),
            clear: vi.fn(async () => {}),
            init: vi.fn(async () => {}),
          };
        }

        // Local manager with the store wired as the 12th ctor arg (positions
        // 6–11 undefined, mirroring the 5-arg construction in beforeEach).
        function makeManagerWithStore(fakeStore: ReturnType<typeof makeFakeTurnHistoryStore>) {
          return new AgentManager(
            registry as any,
            memoryManager as any,
            sessionStore as any,
            undefined as any,
            turnTelemetryStore as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            fakeStore as any,
          );
        }

        function registerCodexPilot() {
          registry._agents.set(
            "codex-pilot",
            makeAgentConfig({ id: "codex-pilot", name: "Codex Pilot", model: "codex/gpt-5.5:medium", coreServers: [] }),
          );
        }

        it("codex-branch options: adapter constructed with historyStore + agentId (store key = config.id), name stays the display label", async () => {
          const fakeStore = makeFakeTurnHistoryStore();
          const mgr = makeManagerWithStore(fakeStore);
          registerCodexPilot();

          await mgr.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr353-opts" }));

          expect(mockCodexConstructor).toHaveBeenCalledWith(
            expect.objectContaining({ historyStore: fakeStore, agentId: "codex-pilot", name: "Codex Pilot" }),
          );
        });

        it("handoff (claude→codex) clears exactly once with (agentId, threadId)", async () => {
          const fakeStore = makeFakeTurnHistoryStore();
          const mgr = makeManagerWithStore(fakeStore);
          registerCodexPilot();
          const threadId = "sms:line-1:kpr353-handoff";
          seed(threadId, "claude-uuid-1", "claude", "codex-pilot");

          await mgr.spawnTurn(
            smsCtx({ agentId: "codex-pilot", threadId, sessionId: "claude-uuid-1", sessionProvider: "claude" }),
          );

          expect(fakeStore.clear).toHaveBeenCalledTimes(1);
          expect(fakeStore.clear).toHaveBeenCalledWith("codex-pilot", threadId);
        });

        it("KPR-352: gemini→codex handoff clears the codex history exactly once (provider-agnostic — the KPR-350 obligation)", async () => {
          const fakeStore = makeFakeTurnHistoryStore();
          const mgr = makeManagerWithStore(fakeStore);
          registerCodexPilot();
          const threadId = "sms:line-1:kpr352-g2codex";
          seed(threadId, "interactions/old", "gemini", "codex-pilot");

          await mgr.spawnTurn(
            smsCtx({ agentId: "codex-pilot", threadId, sessionId: "interactions/old", sessionProvider: "gemini" }),
          );

          expect(fakeStore.clear).toHaveBeenCalledTimes(1);
          expect(fakeStore.clear).toHaveBeenCalledWith("codex-pilot", threadId);
        });

        it("KPR-352: codex→gemini handoff — guard trips, the gemini turn starts a fresh chain, no history flows in", async () => {
          const fakeStore = makeFakeTurnHistoryStore();
          const mgr = makeManagerWithStore(fakeStore);
          registry._agents.set(
            "gem",
            makeAgentConfig({ id: "gem", name: "Gem", model: "gemini/gemini-3.6-flash", coreServers: [] }),
          );
          const threadId = "sms:line-1:kpr352-codex2g";
          seed(threadId, "", "codex", "gem");
          mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ text: "g", sessionId: "interactions/fresh" }));

          await mgr.spawnTurn(
            smsCtx({ agentId: "gem", threadId, sessionId: undefined, sessionProvider: "codex" }),
          );

          const req = mockGeminiRunTurn.mock.calls[0]![0];
          expect(req.sessionId).toBeUndefined(); // fresh gemini chain
          expect(req.prompt).toContain("session continuity was reset");
          expect(sessionStore.set).toHaveBeenCalledWith("gem", threadId, "interactions/fresh", "gemini", expect.anything());
        });

        it("ORDERING pin: the clear is AWAITED — the codex adapter (and its load) is unreachable until clear resolves", async () => {
          const fakeStore = makeFakeTurnHistoryStore();
          const mgr = makeManagerWithStore(fakeStore);
          registerCodexPilot();
          const threadId = "sms:line-1:kpr353-order";
          seed(threadId, "claude-uuid-1", "claude", "codex-pilot");

          // Manually-deferred clear: the guard's `await …clear()` parks here.
          let resolveClear!: () => void;
          const deferred = new Promise<void>((res) => {
            resolveClear = res;
          });
          fakeStore.clear.mockReturnValueOnce(deferred as any);

          // Start WITHOUT awaiting.
          const spawnP = mgr.spawnTurn(
            smsCtx({ agentId: "codex-pilot", threadId, sessionId: "claude-uuid-1", sessionProvider: "claude" }),
          );

          // Settle: wait until the guard has actually called clear, THEN flush a
          // generous run of microtasks. A vacuous "clear was called" assertion
          // passes under BOTH the awaited and the fire-and-forget variants — the
          // microtask flush is what lets the mutant race past the parked clear
          // and reach the adapter, so the pin below can catch it.
          await vi.waitFor(() => expect(fakeStore.clear.mock.calls.length).toBeGreaterThan(0));
          for (let i = 0; i < 10; i++) await Promise.resolve();

          // The adapter — and therefore its load() — is unreachable while clear
          // is pending. An awaited clear orders the Mongo delete ahead of the
          // read; fire-and-forget would let this turn replay the stale doc.
          expect(mockCodexConstructor).not.toHaveBeenCalled();
          expect(mockCodexRunTurn).not.toHaveBeenCalled();

          // Release the clear → the turn proceeds to the adapter and completes.
          resolveClear();
          await spawnP;
          expect(mockCodexRunTurn).toHaveBeenCalled();
        });

        it("rejected clear is swallowed: the turn proceeds and completes normally", async () => {
          const fakeStore = makeFakeTurnHistoryStore();
          const mgr = makeManagerWithStore(fakeStore);
          registerCodexPilot();
          const threadId = "sms:line-1:kpr353-reject";
          seed(threadId, "claude-uuid-1", "claude", "codex-pilot");
          fakeStore.clear.mockRejectedValueOnce(new Error("mongo down"));

          const result = await mgr.spawnTurn(
            smsCtx({ agentId: "codex-pilot", threadId, sessionId: "claude-uuid-1", sessionProvider: "claude" }),
          );

          expect(result.errors).toEqual([]);
          expect(mockCodexRunTurn).toHaveBeenCalled();
        });

        it("adopt branch does NOT clear (predecessor's own guard trip already cleared)", async () => {
          const fakeStore = makeFakeTurnHistoryStore();
          const mgr = makeManagerWithStore(fakeStore);
          registerCodexPilot();
          const threadId = "sms:line-1:kpr353-adopt";
          // Post-lock re-read returns the TURN's provider (codex) — the ⚠A9
          // adopt path — while the captured tag is a stale "claude".
          seed(threadId, "", "codex", "codex-pilot");

          await mgr.spawnTurn(
            smsCtx({ agentId: "codex-pilot", threadId, sessionId: undefined, sessionProvider: "claude" }),
          );

          expect(fakeStore.clear).not.toHaveBeenCalled();
        });

        it("no store ⇒ handoff hook no-ops: the turn completes exactly as before, nothing throws", async () => {
          // `manager` (beforeEach) is constructed WITHOUT the 12th arg.
          registerCodexPilot();
          const threadId = "sms:line-1:kpr353-nostore";
          seed(threadId, "claude-uuid-1", "claude", "codex-pilot");

          const result = await manager.spawnTurn(
            smsCtx({ agentId: "codex-pilot", threadId, sessionId: "claude-uuid-1", sessionProvider: "claude" }),
          );

          expect(result.errors).toEqual([]);
          expect(mockCodexRunTurn).toHaveBeenCalled();
        });
      });
    });

    describe("stale-handle self-heal (KPR-350 §D3)", () => {
      const STALE = "Previous response with id 'resp_stale' not found.";
      function openaiAgent(id = "openai-pilot") {
        registry._agents.set(
          id,
          makeAgentConfig({ id, name: "OpenAI Pilot", model: "openai/gpt-5.4-mini", coreServers: [] }),
        );
        return id;
      }
      const octx = (threadId: string, sessionId = "resp_stale") =>
        smsCtx({ agentId: openaiAgent(), threadId, sessionId, sessionProvider: "openai" });

      it("retries exactly once with sessionId stripped; success persists the fresh handle", async () => {
        mockOpenAIRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
          .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-fresh" }));
        const ctx = octx("sms:line-1:kpr350-heal");
        const result = await manager.spawnTurn(ctx);
        expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
        expect(mockOpenAIRunTurn.mock.calls[0]![0].sessionId).toBe("resp_stale");
        expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBeUndefined(); // fresh retry
        expect(result.finalMessage).toBe("healed");
        expect(result.newSessionId).toBe("resp-fresh");
        expect(sessionStore.set).toHaveBeenCalledWith(
          "openai-pilot", ctx.threadId, "resp-fresh", "openai", expect.anything(),
        ); // write path self-corrects — no explicit scrub
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("stale-server-handle"),
          expect.not.objectContaining({ reason: expect.anything() }), // no handle value logged
        );
      });

      it("failed retry: churn-mint blocks the minted id, error surfaces, stale handle survives for next-turn re-trip", async () => {
        mockOpenAIRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
          .mockResolvedValueOnce(makeRunResult({ error: "boom", sessionId: "resp-minted" }));
        const result = await manager.spawnTurn(octx("sms:line-1:kpr350-heal-fail"));
        expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
        expect(result.errors).toEqual(["boom"]);
        expect(sessionStore.set).not.toHaveBeenCalled(); // ⚠A4 rider: error + different id than resumed
      });

      it("breaker record-once: exactly one record per spawnTurn, classification = finalized attempt's; streak 0 both ways", async () => {
        // KPR-351 (R3): the streak-0 assertions alone were vacuous — stale
        // AND "boom" both classify non-provider, so streak 0 held even if
        // the first attempt were recorded. The spy makes the pin bite.
        const recordSpy = vi.spyOn(manager.circuitBreakers, "record");
        mockOpenAIRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
          .mockResolvedValueOnce(makeRunResult({ text: "ok", sessionId: "resp-f2" }));
        await manager.spawnTurn(octx("sms:line-1:kpr350-brk-1"));
        expect(recordSpy).toHaveBeenCalledTimes(1); // first attempt's stale fault never recorded
        expect(recordSpy.mock.calls[0]![1]).toEqual({ outcome: "success" });

        mockOpenAIRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
          .mockResolvedValueOnce(makeRunResult({ error: "boom", sessionId: "resp_stale" }));
        await manager.spawnTurn(octx("sms:line-1:kpr350-brk-2"));
        expect(recordSpy).toHaveBeenCalledTimes(2);
        expect(recordSpy.mock.calls[1]![1]).toEqual({ outcome: "fault", kind: "non-provider", message: "boom" });

        const snap = manager.circuitBreakers.stateFor("openai")!; // non-null-assertion per stateFor("claude")! precedent
        expect(snap.state).toBe("closed");
        expect(snap.consecutiveHardFaults).toBe(0);
      });

      it("gating: dead on client-transcript (claude), stateless-replay (codex), missing sessionId, non-matching 404", async () => {
        // claude route, same string, sessionId present → no retry
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "s1" }));
        await manager.spawnTurn(smsCtx({ sessionId: "s1", sessionProvider: "claude", threadId: "sms:line-1:kpr350-g1" }));
        expect(mockRunnerSend).toHaveBeenCalledTimes(1);
        // codex route → no retry (stateless-replay; semantics conjunct is the discriminating gate).
        // Pass a sessionId so the sessionId conjunct is satisfied and the leg is non-vacuous —
        // production codex rows never carry handles (belt-and-braces), but this makes the
        // semantics gate itself bite (plan-review/1/fable advisory).
        registry._agents.set("codex-pilot", makeAgentConfig({ id: "codex-pilot", name: "CP", model: "codex/gpt-5.5:medium", coreServers: [] }));
        mockCodexRunTurn.mockResolvedValueOnce(makeRunResult({ error: STALE }));
        await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr350-g2", sessionId: "resp_x", sessionProvider: "codex" }));
        expect(mockCodexRunTurn).toHaveBeenCalledTimes(1);
        // openai route, NO sessionId → no retry
        mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ error: STALE }));
        await manager.spawnTurn(smsCtx({ agentId: openaiAgent(), threadId: "sms:line-1:kpr350-g3", sessionId: undefined }));
        expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(1);
        // openai route, generic 404 → no retry (matcher narrowness at the arm)
        mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ error: "404 Not Found", sessionId: "resp_x" }));
        await manager.spawnTurn(octx("sms:line-1:kpr350-g4", "resp_x"));
        expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2); // 1 (g3) + 1 (g4), no retries
      });

      describe("chain-orphan re-read (KPR-351 R2)", () => {
        function seedRow(threadId: string, sessionId: string, provider = "openai") {
          sessionStore._sessions.set(`openai-pilot:${threadId}`, { sessionId, provider });
        }

        it("contender-healed row is adopted: retry carries the contender's handle, success persists normally", async () => {
          const ctx = octx("sms:line-1:kpr351-adopt");
          seedRow(ctx.threadId, "resp-contender");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "adopted", sessionId: "resp-contender-2" }));
          const result = await manager.spawnTurn(ctx);
          expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
          expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBe("resp-contender"); // adopt, NOT fresh
          expect(result.finalMessage).toBe("adopted");
          expect(sessionStore.set).toHaveBeenCalledWith(
            "openai-pilot", ctx.threadId, "resp-contender-2", "openai", expect.anything(),
          );
          // Redaction: adoption is a boolean; no handle value in any warn meta.
          expect(mockLogWarn).toHaveBeenCalledWith(
            expect.stringContaining("stale-server-handle"),
            expect.objectContaining({ adoptedContenderHandle: true }),
          );
          const leaked = mockLogWarn.mock.calls.some(([, meta]) =>
            JSON.stringify(meta ?? "").includes("resp-contender"),
          );
          expect(leaked).toBe(false);
        });

        it("row holds the SAME stale handle (no contender heal) ⇒ fresh retry, as KPR-350 shipped", async () => {
          const ctx = octx("sms:line-1:kpr351-same");
          seedRow(ctx.threadId, "resp_stale");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-fresh" }));
          await manager.spawnTurn(ctx);
          expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBeUndefined();
          expect(mockLogWarn).toHaveBeenCalledWith(
            expect.stringContaining("stale-server-handle"),
            expect.objectContaining({ adoptedContenderHandle: false }),
          );
        });

        it("row absent, empty-handle row, or foreign-provider row ⇒ fresh retry (no cross-provider adoption)", async () => {
          // absent
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-a" }));
          await manager.spawnTurn(octx("sms:line-1:kpr351-absent"));
          expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBeUndefined();
          // empty handle ("" normalizes to undefined in the store's get())
          const ctx2 = octx("sms:line-1:kpr351-empty");
          seedRow(ctx2.threadId, "");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-b" }));
          await manager.spawnTurn(ctx2);
          expect(mockOpenAIRunTurn.mock.calls[3]![0].sessionId).toBeUndefined();
          // foreign provider tag
          const ctx3 = octx("sms:line-1:kpr351-xprov");
          seedRow(ctx3.threadId, "claude-uuid-9", "claude");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-c" }));
          await manager.spawnTurn(ctx3);
          expect(mockOpenAIRunTurn.mock.calls[5]![0].sessionId).toBeUndefined();
        });

        it("adopted retry that errors stale AGAIN ⇒ no second retry (single-retry semantics intact)", async () => {
          const ctx = octx("sms:line-1:kpr351-twice");
          seedRow(ctx.threadId, "resp-contender");
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp-contender" }));
          const result = await manager.spawnTurn(ctx);
          expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
          expect(result.errors).toEqual([STALE]);
        });
      });
    });

    describe("TurnResult.resumedSession (KPR-388)", () => {
      const STALE = "Previous response with id 'resp_stale' not found.";
      function openai388(id = "openai-pilot") {
        registry._agents.set(
          id,
          makeAgentConfig({ id, name: "OpenAI Pilot", model: "openai/gpt-5.4-mini", coreServers: [] }),
        );
        return id;
      }

      it("true on a happy-path resume", async () => {
        const result = await manager.spawnTurn(
          smsCtx({ sessionId: "s1", threadId: "sms:line-1:kpr388-r1" }),
        );
        expect(result.resumedSession).toBe(true);
      });

      it("false on a first turn (no stored session)", async () => {
        const result = await manager.spawnTurn(
          smsCtx({ sessionId: undefined, threadId: "sms:line-1:kpr388-r2" }),
        );
        expect(result.resumedSession).toBe(false);
      });

      it("false after the auth-rebuild retry (finalized attempt ran fresh)", async () => {
        mockRunnerSend
          .mockResolvedValueOnce(
            makeRunResult({ error: "Could not resolve authentication method", sessionId: "" }),
          )
          .mockResolvedValueOnce(makeRunResult({ text: "ok after retry", sessionId: "session-retry" }));
        const result = await manager.spawnTurn(
          smsCtx({ sessionId: "stale-session", threadId: "sms:line-1:kpr388-r3" }),
        );
        expect(mockRunnerSend).toHaveBeenCalledTimes(2);
        expect(result.resumedSession).toBe(false);
      });

      it("false after the stale-handle self-heal fresh retry", async () => {
        mockOpenAIRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
          .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-fresh" }));
        const result = await manager.spawnTurn(
          smsCtx({ agentId: openai388(), sessionId: "resp_stale", sessionProvider: "openai", threadId: "sms:line-1:kpr388-r4" }),
        );
        expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
        expect(result.resumedSession).toBe(false);
      });

      it("true after self-heal contender adoption (adopted handle counts as resumed)", async () => {
        const threadId = "sms:line-1:kpr388-r5";
        sessionStore._sessions.set(`openai-pilot:${threadId}`, { sessionId: "resp-contender", provider: "openai" });
        mockOpenAIRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
          .mockResolvedValueOnce(makeRunResult({ text: "adopted", sessionId: "resp-contender-2" }));
        const result = await manager.spawnTurn(
          smsCtx({ agentId: openai388(), sessionId: "resp_stale", sessionProvider: "openai", threadId }),
        );
        expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBe("resp-contender");
        expect(result.resumedSession).toBe(true);
      });

      it("false on a KPR-313 provider-handoff turn (guard strips the session pre-attempt)", async () => {
        // Stored codex tag, claude turn: guard trips, turn runs fresh with the
        // handoff annotation — resumedSession must report the fresh reality.
        const result = await manager.spawnTurn(
          smsCtx({ sessionId: "s-codex-row", sessionProvider: "codex", threadId: "sms:line-1:kpr388-r6" }),
        );
        expect(result.resumedSession).toBe(false);
      });

      // --- KPR-412: the KPR-399 arm had no coverage in this block ----------
      describe("false after the KPR-399 claude resume-rejection fresh retry (KPR-412)", () => {
        const UNKNOWN_SESSION = "No conversation found with session ID: 0198c3f2-abcd-7890-b1c2-d3e4f5a6b7c8";
        const DANGLING_TOOL_USE =
          "400 invalid_request_error: messages.57: the following `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01AbCdEfGh";

        it.each([
          ["unknown-session", UNKNOWN_SESSION],
          ["dangling tool_use 400", DANGLING_TOOL_USE],
        ])("T1: resumedSession is false on %s (was true pre-fix — negative-verified)", async (_label, reason) => {
          mockRunnerSend
            .mockResolvedValueOnce(makeRunResult({ error: reason, sessionId: "" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "s-fresh" }));
          const result = await manager.spawnTurn(
            smsCtx({ threadId: "sms:line-1:kpr412-t1", sessionId: "s-dead", sessionProvider: "claude" }),
          );
          expect(mockRunnerSend).toHaveBeenCalledTimes(2);
          expect(mockRunnerSend.mock.calls[1]![1]).toBeUndefined(); // fresh retry — no sessionId (matches the sibling "resume-rejection self-heal (KPR-399 §D3)" describe's assertion form)
          expect(result.resumedSession).toBe(false);
        });

        it("T2: agent_turn_telemetry.resumedSession is false on the same path (C18 single-sourcing)", async () => {
          mockRunnerSend
            .mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "s-fresh" }));
          await manager.spawnTurn(
            smsCtx({ threadId: "sms:line-1:kpr412-t2", sessionId: "s-dead", sessionProvider: "claude" }),
          );
          expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
          const doc = turnTelemetryStore.record.mock.calls[0]![0];
          expect(doc.resumedSession).toBe(false);
        });
      });
    });

    describe("stale-handle self-heal — gemini (KPR-352 §D3)", () => {
      // Binding delta (Task-0/1 spike): the live Interactions API returns 400
      // for fabricated AND malformed ids; the adapter tags only round-1
      // status-400 failures (STALE_HANDLE_STATUSES = {400}) whose carried
      // previous_interaction_id was the persisted handle with the
      // "gemini interaction resume rejected" sentinel — 403/404 stay untagged
      // (this file's own status-breadth test pins it).
      const TAGGED =
        "gemini interaction resume rejected (status 400): the referenced previous_interaction_id is invalid";
      function geminiAgent(id = "gem") {
        registry._agents.set(
          id,
          makeAgentConfig({ id, name: "Gem", model: "gemini/gemini-3.6-flash", coreServers: [] }),
        );
        return id;
      }
      function seed(threadId: string, sessionId: string, provider: string, agentId: string) {
        sessionStore._sessions.set(`${agentId}:${threadId}`, { sessionId, provider });
      }
      const gctx = (threadId: string, sessionId = "interactions/stale") =>
        smsCtx({ agentId: geminiAgent(), threadId, sessionId, sessionProvider: "gemini" });

      it("tagged stale-resume error retries exactly once with sessionId stripped; success persists the fresh handle", async () => {
        mockGeminiRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: TAGGED, sessionId: "interactions/stale" }))
          .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "interactions/new" }));
        const ctx = gctx("sms:line-1:kpr352-heal");
        const result = await manager.spawnTurn(ctx);
        expect(mockGeminiRunTurn).toHaveBeenCalledTimes(2);
        expect(mockGeminiRunTurn.mock.calls[0]![0].sessionId).toBe("interactions/stale");
        expect(mockGeminiRunTurn.mock.calls[1]![0].sessionId).toBeUndefined(); // fresh retry
        expect(result.finalMessage).toBe("healed");
        expect(result.newSessionId).toBe("interactions/new");
        expect(sessionStore.set).toHaveBeenCalledWith(
          ctx.agentId, ctx.threadId, "interactions/new", "gemini", expect.anything(),
        ); // write path self-corrects — the row is overwritten
        // Redaction pin: the self-heal warn carries {agentId, threadId, provider}
        // only — the provider message (which embeds the handle) is never logged.
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("stale-server-handle"),
          expect.not.objectContaining({ reason: expect.anything() }),
        );
        const leaked = mockLogWarn.mock.calls.some(([, meta]) =>
          JSON.stringify(meta ?? "").includes("resume rejected"),
        );
        expect(leaked).toBe(false);
      });

      it("failed retry: fresh attempt errors with '', error surfaces, no persist, seeded stale handle survives for next-turn re-trip", async () => {
        const id = geminiAgent();
        const threadId = "sms:line-1:kpr352-heal-fail";
        seed(threadId, "interactions/stale", "gemini", id);
        mockGeminiRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: TAGGED, sessionId: "interactions/stale" }))
          .mockResolvedValueOnce(makeRunResult({ error: "still broken", sessionId: "" }));
        const result = await manager.spawnTurn(
          smsCtx({ agentId: id, threadId, sessionId: "interactions/stale", sessionProvider: "gemini" }),
        );
        expect(mockGeminiRunTurn).toHaveBeenCalledTimes(2);
        expect(result.errors).toEqual(["still broken"]);
        expect(sessionStore.set).not.toHaveBeenCalled(); // falsy sessionId guard on the errored fresh retry
        expect(sessionStore._sessions.get(`${id}:${threadId}`)).toEqual({
          sessionId: "interactions/stale",
          provider: "gemini",
        }); // stale handle survives
      });

      it("breaker record-once: tagged→success and tagged→'boom' both leave the gemini streak at 0 (first attempts never reach the breaker)", async () => {
        mockGeminiRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: TAGGED, sessionId: "interactions/stale" }))
          .mockResolvedValueOnce(makeRunResult({ text: "ok", sessionId: "interactions/f2" }));
        await manager.spawnTurn(gctx("sms:line-1:kpr352-brk-1"));
        mockGeminiRunTurn
          .mockResolvedValueOnce(makeRunResult({ error: TAGGED, sessionId: "interactions/stale" }))
          .mockResolvedValueOnce(makeRunResult({ error: "boom", sessionId: "interactions/stale" }));
        await manager.spawnTurn(gctx("sms:line-1:kpr352-brk-2"));
        const snap = manager.circuitBreakers.stateFor("gemini")!;
        expect(snap.state).toBe("closed");
        expect(snap.consecutiveHardFaults).toBe(0); // tagged first attempts + non-provider "boom" never trip
      });

      it("narrowness: the tagged string on a CLAUDE-routed agent → no retry (client-transcript gate)", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: TAGGED, sessionId: "s1" }));
        await manager.spawnTurn(
          smsCtx({ sessionId: "s1", sessionProvider: "claude", threadId: "sms:line-1:kpr352-narrow-c" }),
        );
        expect(mockRunnerSend).toHaveBeenCalledTimes(1);
      });

      it("narrowness: the tagged string on a CODEX-routed agent → no retry (stateless-replay gate)", async () => {
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "CP", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        mockCodexRunTurn.mockResolvedValueOnce(makeRunResult({ error: TAGGED, sessionId: "interactions/x" }));
        await manager.spawnTurn(
          smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr352-narrow-x", sessionId: "interactions/x", sessionProvider: "codex" }),
        );
        expect(mockCodexRunTurn).toHaveBeenCalledTimes(1);
      });

      it("no-sessionId guard: the tagged string on a thread with no stored handle → no retry (arm requires effectiveCtx.sessionId)", async () => {
        const id = geminiAgent();
        mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ error: TAGGED, sessionId: "" }));
        await manager.spawnTurn(smsCtx({ agentId: id, threadId: "sms:line-1:kpr352-nosess", sessionId: undefined }));
        expect(mockGeminiRunTurn).toHaveBeenCalledTimes(1);
      });
    });

    describe("persist-on-abort (KPR-399 §D2)", () => {
      beforeEach(() => {
        mockConversationIndex.mockResolvedValue(undefined);
      });

      // Incident shape (KPR-397 epic, 2026-08-26): deadline abort mid-tool
      // turn with a valid transcript id — must persist so replay/follow-up
      // resumes instead of restarting ("think / hit-wall / restart" loop).
      it("aborted claude turn WITH progress persists sessionId — no tokenData (new direction)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "s1", toolCalls: 46, streamed: true, text: "" }),
        );
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-p1" });
        await manager.spawnTurn(ctx);
        expect(sessionStore.set).toHaveBeenCalledTimes(1);
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s1", "claude");
        // No 5th arg: tokenData omitted — aborted turns carry all-zero usage;
        // set() without tokenData preserves the prior turn's stats.
        expect(sessionStore.set.mock.calls[0]!.length).toBe(4);
      });

      it.each([
        ["toolCalls alone", { toolCalls: 1, streamed: false, text: "" }],
        ["streamed alone", { toolCalls: 0, streamed: true, text: "" }],
        ["text alone", { toolCalls: 0, streamed: false, text: "partial reply" }],
      ] as const)("each D1 signal independently sufficient: %s", async (_label, progress) => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "s1", ...progress }),
        );
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-sig" });
        await manager.spawnTurn(ctx);
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s1", "claude");
      });

      it("fail-closed: aborted with ZERO progress persists nothing (also synthesizeAbortedResult's shape)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "s1", toolCalls: 0, streamed: false, text: "" }),
        );
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr399-zero" }));
        expect(sessionStore.set).not.toHaveBeenCalled();
      });

      it("empty sessionId on an aborted result persists nothing (abort before system/init)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "", toolCalls: 3, streamed: true, text: "" }),
        );
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr399-noid" }));
        expect(sessionStore.set).not.toHaveBeenCalled();
      });

      it("operator abort (aborted without timedOut) with progress persists too — uniform handling (⚠A4)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, sessionId: "s-stop", toolCalls: 3, streamed: true, text: "" }),
        );
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-stop" });
        await manager.spawnTurn(ctx);
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s-stop", "claude");
      });

      it("mint-safety belt: aborted + errored + resumed + DIFFERENT id never overwrites the row", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, error: "boom", sessionId: "s-minted", toolCalls: 3, streamed: true, text: "" }),
        );
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr399-mint", sessionId: "s-old", sessionProvider: "claude" }),
        );
        expect(sessionStore.set).not.toHaveBeenCalled();
      });

      it("mint-safety belt scope: aborted + errored turn re-persisting the SAME id it resumed is allowed (TTL refresh)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, error: "boom", sessionId: "s-same", toolCalls: 3, streamed: true, text: "" }),
        );
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-same", sessionId: "s-same", sessionProvider: "claude" });
        await manager.spawnTurn(ctx);
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s-same", "claude");
      });

      it("C3 pins: aborted-with-progress on openai / gemini / codex routes persists NOTHING (Lane B byte-for-byte)", async () => {
        registry._agents.set(
          "openai-pilot",
          makeAgentConfig({ id: "openai-pilot", name: "OP", model: "openai/gpt-5.4-mini", coreServers: [] }),
        );
        registry._agents.set(
          "gemini-pilot",
          makeAgentConfig({ id: "gemini-pilot", name: "GP", model: "gemini/gemini-2.5-pro", coreServers: [] }),
        );
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "CP", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        const shape = { aborted: true, timedOut: true, toolCalls: 5, streamed: true, text: "" };
        mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ ...shape, sessionId: "resp-abort" }));
        await manager.spawnTurn(smsCtx({ agentId: "openai-pilot", threadId: "sms:line-1:kpr399-c3-o" }));
        mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ ...shape, sessionId: "int-abort" }));
        await manager.spawnTurn(smsCtx({ agentId: "gemini-pilot", threadId: "sms:line-1:kpr399-c3-g" }));
        mockCodexRunTurn.mockResolvedValueOnce(makeRunResult({ ...shape, sessionId: "codex-abort" }));
        await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr399-c3-c" }));
        expect(sessionStore.set).not.toHaveBeenCalled();
      });

      // Both client-transcript Lane A columns, one row each — the arm gates
      // on SEMANTICS, so every Lane A column must inherit it. Grok is
      // deliberately absent: KPR-392 promoted it to a native Lane B
      // stateless-replay adapter (merged into this epic branch after this
      // test's original authoring), so it now belongs with the
      // "aborted-with-progress ... persists NOTHING" C3 pins above, not here.
      it.each([
        ["kimi", "KIMI_API_KEY", "agent-kimi", "kimi/kimi-k3", "kimi-s1"],
        ["deepseek", "DEEPSEEK_API_KEY", "agent-dseek", "deepseek/deepseek-v4-pro", "dseek-s1"],
      ] as const)(
        "Lane A inheritance pin: an aborted-with-progress %s turn persists under its own tag (client-transcript)",
        async (provider, envKey, agentId, model, sessionId) => {
          process.env[envKey] = `test-${provider}-key`;
          try {
            registry._agents.set(agentId, makeAgentConfig({ id: agentId, name: agentId, model, coreServers: [] }));
            mockRunnerSend.mockResolvedValueOnce(
              makeRunResult({ aborted: true, timedOut: true, sessionId, toolCalls: 2, streamed: true, text: "" }),
            );
            const ctx = smsCtx({ agentId, threadId: `sms:line-1:kpr399-${provider}` });
            await manager.spawnTurn(ctx);
            expect(sessionStore.set).toHaveBeenCalledWith(agentId, ctx.threadId, sessionId, provider);
          } finally {
            delete process.env[envKey];
          }
        },
      );

      it("re-entry prefers resume: after an aborted-turn persist, the next runWorkItemTurn on the thread resumes the persisted id", async () => {
        // Pins spec Testing Contract 11 — "replay prefers resume" — via the
        // real store-backed path (runWorkItemTurn → sessionStore.get →
        // ctx.sessionId → runner resume), without touching dispatcher code.
        mockRunnerSend
          .mockResolvedValueOnce(
            makeRunResult({ aborted: true, timedOut: true, sessionId: "s-abort", toolCalls: 7, streamed: true, text: "" }),
          )
          .mockResolvedValueOnce(makeRunResult({ text: "resumed", sessionId: "s-abort" }));
        const threadId = "sms:line-1:kpr399-replay";
        const src = { kind: "sms" as const, id: "line-1", label: "May (CEO)" };
        await manager.runWorkItemTurn("agent-a", makeWorkItem({ threadId, source: src, sender: "+15551234567" }));
        const second = await manager.runWorkItemTurn(
          "agent-a",
          makeWorkItem({ threadId, source: src, sender: "+15551234567" }),
        );
        expect(mockRunnerSend.mock.calls[1]![1]).toBe("s-abort"); // resumed, not "new"
        expect(second.newSessionId).toBe("s-abort");
      });
    });

    describe("resume-rejection self-heal (KPR-399 §D3)", () => {
      const UNKNOWN_SESSION = "No conversation found with session ID: 0198c3f2-abcd-7890-b1c2-d3e4f5a6b7c8";
      const DANGLING_TOOL_USE =
        "400 invalid_request_error: messages.57: the following `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01AbCdEfGh";

      beforeEach(() => {
        mockConversationIndex.mockResolvedValue(undefined);
        // Hermetic queue: the outer beforeEach's clearAllMocks() clears call
        // history but NOT the mockResolvedValueOnce queue. Rows here queue two
        // responses expecting a retry; if the retry does not fire (pre-fix
        // source under negative-verify) the second value would bleed into the
        // next row. Reset the queue, then restore the suite-wide default.
        mockRunnerSend.mockReset();
        mockRunnerSend.mockResolvedValue(makeRunResult());
      });

      it.each([
        ["unknown-session", UNKNOWN_SESSION],
        ["dangling tool_use 400", DANGLING_TOOL_USE],
      ])("retries exactly once with sessionId stripped on %s; retry result is the turn result", async (_label, reason) => {
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ error: reason, sessionId: "" }))
          .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "s-fresh" }));
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-heal", sessionId: "s-dead", sessionProvider: "claude" });
        const result = await manager.spawnTurn(ctx);
        expect(mockRunnerSend).toHaveBeenCalledTimes(2);
        expect(mockRunnerSend.mock.calls[0]![1]).toBe("s-dead"); // first attempt resumed
        expect(mockRunnerSend.mock.calls[1]![1]).toBeUndefined(); // fresh retry
        expect(result.finalMessage).toBe("healed");
        expect(result.newSessionId).toBe("s-fresh");
        // Write path self-corrects: fresh handle persisted normally (no scrub).
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s-fresh", "claude", expect.anything());
        // Redaction posture: the warn carries no error string / handle value.
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("resume rejected"),
          expect.not.objectContaining({ reason: expect.anything() }),
        );
        const leaked = mockLogWarn.mock.calls.some(([, meta]) => JSON.stringify(meta ?? "").includes("s-dead"));
        expect(leaked).toBe(false);
      });

      it("breaker record-once: only the finalized attempt is recorded; streak stays 0 (breaker-invisible)", async () => {
        const recordSpy = vi.spyOn(manager.circuitBreakers, "record");
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }))
          .mockResolvedValueOnce(makeRunResult({ text: "ok", sessionId: "s-2" }));
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr399-brk", sessionId: "s-dead", sessionProvider: "claude" }),
        );
        expect(recordSpy).toHaveBeenCalledTimes(1); // first attempt's rejection never recorded
        expect(recordSpy.mock.calls[0]![1]).toEqual({ outcome: "success" });
        const snap = manager.circuitBreakers.stateFor("claude")!;
        expect(snap.state).toBe("closed");
        expect(snap.consecutiveHardFaults).toBe(0);
      });

      it("single retry: a retry that fails with the matcher string again is NOT retried a second time", async () => {
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }))
          .mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }));
        const result = await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr399-once", sessionId: "s-dead", sessionProvider: "claude" }),
        );
        expect(mockRunnerSend).toHaveBeenCalledTimes(2);
        expect(result.errors).toEqual([UNKNOWN_SESSION]);
      });

      it("gating: dead without a stored sessionId; dead on openai (semantics gate); auth sentinel routes to the auth arm", async () => {
        // No sessionId → no retry (arm requires effectiveCtx.sessionId).
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }));
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr399-g1", sessionId: undefined }));
        expect(mockRunnerSend).toHaveBeenCalledTimes(1);
        // openai route + same string + sessionId → no retry: server-resumable
        // is not this arm's semantics, and the string does not match the
        // KPR-350 arm's matcher either (mutual exclusivity, both directions).
        // NOTE: the pre-existing KPR-313 churn-mint warn ("Skipping session
        // persist — errored turn returned a different id…") also fires here
        // (errored result id "resp-x" ≠ resumed "resp-old") — expected and
        // harmless to these assertions.
        registry._agents.set(
          "openai-pilot",
          makeAgentConfig({ id: "openai-pilot", name: "OP", model: "openai/gpt-5.4-mini", coreServers: [] }),
        );
        mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "resp-x" }));
        await manager.spawnTurn(
          smsCtx({ agentId: "openai-pilot", threadId: "sms:line-1:kpr399-g2", sessionId: "resp-old", sessionProvider: "openai" }),
        );
        expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(1);
        // Auth sentinel on claude + sessionId → the FIRST arm fires (else-if
        // chain order), never this one: its warn appears, ours does not.
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ error: "Could not resolve authentication method", sessionId: "" }))
          .mockResolvedValueOnce(makeRunResult({ text: "ok", sessionId: "s-a" }));
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr399-g3", sessionId: "s-x", sessionProvider: "claude" }),
        );
        expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("auth-rebuild"), expect.anything());
        const resumeWarn = mockLogWarn.mock.calls.some(([msg]) => String(msg).includes("resume rejected"));
        expect(resumeWarn).toBe(false);
      });
    });

    describe("Lane A passthrough (KPR-346)", () => {
      function seed(threadId: string, sessionId: string, provider: string, agentId: string) {
        sessionStore._sessions.set(`${agentId}:${threadId}`, { sessionId, provider });
      }

      // The last AgentRunner construction's options bag (11th ctor arg).
      function lastRunnerOptions() {
        const call = vi.mocked(AgentRunner).mock.calls.at(-1)!;
        return call[10];
      }

      beforeEach(() => {
        mockConversationIndex.mockResolvedValue(undefined);
        // Env is the only live credential source (Keychain leg stubbed to "").
        process.env.KIMI_API_KEY = "test-kimi-key";
        process.env.DEEPSEEK_API_KEY = "test-dseek-key";
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/kimi-k3", coreServers: [] }),
        );
        registry._agents.set(
          "agent-dseek",
          makeAgentConfig({ id: "agent-dseek", name: "AgentDseek", model: "deepseek/deepseek-v4-pro", coreServers: [] }),
        );
      });

      afterEach(() => {
        delete process.env.KIMI_API_KEY;
        delete process.env.DEEPSEEK_API_KEY;
      });

      // --- T1: routing ------------------------------------------------------
      it("T1: providerFor maps kimi/deepseek prefixes; unknown prefix and slashless fall to claude", () => {
        expect(manager.providerFor("agent-kimi")).toBe("kimi");
        expect(manager.providerFor("agent-dseek")).toBe("deepseek");

        registry._agents.set(
          "agent-mystery",
          makeAgentConfig({ id: "agent-mystery", name: "AgentMystery", model: "mystery/m" }),
        );
        expect(manager.providerFor("agent-mystery")).toBe("claude"); // unknown prefix → claude (KPR-231)

        registry._agents.set(
          "agent-slashless",
          makeAgentConfig({ id: "agent-slashless", name: "AgentSlashless", model: "kimi" }),
        );
        expect(manager.providerFor("agent-slashless")).toBe("claude"); // no slash → claude (documented)
      });

      // --- T3: adapter selection -------------------------------------------
      it("T3: kimi turn constructs AgentRunner with the laneAPassthrough bag and runs the Claude adapter — no Lane B", async () => {
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-adapter" }));

        expect(lastRunnerOptions()).toEqual({
          laneAPassthrough: expect.objectContaining({
            provider: "kimi",
            model: "kimi-k3",
            baseUrl: "https://api.moonshot.ai/anthropic",
            authToken: "test-kimi-key",
          }),
        });
        expect(mockRunnerSend).toHaveBeenCalled();
        // Lane B adapters + assembly never entered.
        expect(mockCodexConstructor).not.toHaveBeenCalled();
        expect(mockOpenAIConstructor).not.toHaveBeenCalled();
        expect(mockGeminiConstructor).not.toHaveBeenCalled();
        const kimiRunner = vi.mocked(AgentRunner).mock.results.at(-1)!.value as { buildProviderPrompt: ReturnType<typeof vi.fn> };
        expect(kimiRunner.buildProviderPrompt).not.toHaveBeenCalled();
      });

      // --- T3: model chain -------------------------------------------------
      it("T3: model chain — empty route model falls to the table default", async () => {
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-default" }));
        expect((lastRunnerOptions() as any).laneAPassthrough.model).toBe("kimi-k3");
      });

      // --- T1: routing — `:effort`-only suffix passes through as a bad model id
      // `splitProviderModel(":high")` hits the `colon <= 0` guard: model stays
      // `":high"` (NON-empty, so no default-chain fallback) and no effort is
      // extracted. The foreign endpoint receives `":high"` as a model id → 4xx
      // bad-model config fault (breaker-safe), identical to `codex/:high`.
      it("T1: `:effort`-only suffix (kimi/:high) → model ':high', no effort", async () => {
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/:high", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-effort-only" }));
        expect((lastRunnerOptions() as any).laneAPassthrough.model).toBe(":high");
        const [, , , , , , effort] = mockRunnerSend.mock.calls[0]!;
        expect(effort).toBeUndefined();
      });

      it("T3: model chain — configured agentModel wins over the table default", async () => {
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/", coreServers: [] }),
        );
        (appConfig as any).kimi.agentModel = "kimi-k2.6";
        try {
          await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-configmodel" }));
          expect((lastRunnerOptions() as any).laneAPassthrough.model).toBe("kimi-k2.6");
        } finally {
          (appConfig as any).kimi.agentModel = "";
        }
      });

      // --- T3: credential fault, breaker-invisible -------------------------
      it("T3: missing credential throws a config fault that never trips the kimi breaker", async () => {
        delete process.env.KIMI_API_KEY;
        for (let i = 0; i < 3; i++) {
          await expect(
            manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: `sms:line-1:kpr346-cred-${i}` })),
          ).rejects.toThrow(/Passthrough credential missing \(authentication\): KIMI_API_KEY/);
        }
        // Breaker never tripped — restore the key and the 4th spawn RUNS.
        process.env.KIMI_API_KEY = "test-kimi-key";
        const result = await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-cred-ok" }));
        expect(result.errors).toEqual([]);
        expect(mockRunnerSend).toHaveBeenCalled();
        expect(manager.circuitBreakers.stateFor("kimi")?.state ?? "closed").toBe("closed");
      });

      // --- T6: breaker attribution -----------------------------------------
      it("T6: three hard faults open the kimi breaker; a claude agent on the same manager is unaffected", async () => {
        for (let i = 0; i < 3; i++) {
          mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: "connect ECONNREFUSED 1.2.3.4:443" }));
          await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: `sms:line-1:kpr346-trip-${i}` }));
        }
        expect(manager.circuitBreakers.stateFor("kimi")!.state).toBe("open");

        await expect(
          manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-fastfail" })),
        ).rejects.toBeInstanceOf(ProviderCircuitOpenError);

        // A claude-model agent (agent-a) still completes — per-provider breaker.
        const result = await manager.spawnTurn(smsCtx({ agentId: "agent-a", threadId: "sms:line-1:kpr346-claude-ok" }));
        expect(result.finalMessage).toBe("response");
      });

      // --- T7: KPR-313 session-identity guard ------------------------------
      it("T7: claude-tagged row + kimi turn trips handoff with the CLAUDE variant (conversation_search)", async () => {
        const threadId = "sms:line-1:kpr346-t7-trip";
        seed(threadId, "s-old", "claude", "agent-kimi");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "fresh", sessionId: "s-new" }));

        await manager.spawnTurn(
          smsCtx({ agentId: "agent-kimi", threadId, sessionId: "s-old", sessionProvider: "claude" }),
        );

        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBeUndefined(); // resume stripped
        expect(prompt.startsWith("[System notice:")).toBe(true);
        expect(prompt).toContain("conversation_search"); // §D7 claude-variant pin
      });

      it("T7: same kimi tag resumes with no handoff", async () => {
        const threadId = "sms:line-1:kpr346-t7-match";
        seed(threadId, "s-1", "kimi", "agent-kimi");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-1" }));

        await manager.spawnTurn(
          smsCtx({ agentId: "agent-kimi", threadId, sessionId: "s-1", sessionProvider: "kimi" }),
        );

        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBe("s-1");
        expect(prompt).not.toContain("session continuity was reset");
      });

      it("T7: kimi tag + deepseek turn trips handoff (cross-Lane-A provider transition)", async () => {
        const threadId = "sms:line-1:kpr346-t7-cross";
        seed(threadId, "s-1", "kimi", "agent-dseek");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ text: "fresh", sessionId: "s-d" }));

        await manager.spawnTurn(
          smsCtx({ agentId: "agent-dseek", threadId, sessionId: "s-1", sessionProvider: "kimi" }),
        );

        const [prompt, sessionArg] = mockRunnerSend.mock.calls[0]!;
        expect(sessionArg).toBeUndefined();
        expect(prompt).toContain("session continuity was reset");
      });

      // --- T2: persist ------------------------------------------------------
      it("T2: kimi turn persists the real handle under the kimi tag (client-transcript)", async () => {
        const threadId = "sms:line-1:kpr346-persist";
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-kimi-new" }));
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId }));
        expect(sessionStore.set).toHaveBeenCalledWith(
          "agent-kimi", threadId, "s-kimi-new", "kimi", expect.anything(),
        );
      });

      // --- T5: effort + limits ---------------------------------------------
      it("T5: deliverable :effort suffix flows to the runner; the router is never called", async () => {
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/kimi-k3:high", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-effort-high" }));
        const [, , , , , , effort] = mockRunnerSend.mock.calls[0]!;
        expect(effort).toBe("high");
        expect(vi.mocked(routeModel)).not.toHaveBeenCalled();
      });

      it("T5: out-of-set :effort suffix is clamped to undefined with exactly one warn per (agent,model)", async () => {
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/kimi-k3:xhigh", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-effort-x1" }));
        const [, , , , , , effort] = mockRunnerSend.mock.calls[0]!;
        expect(effort).toBeUndefined();

        // A second xhigh turn: still exactly one clamp warn (once-per key).
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-effort-x2" }));
        const clampWarns = mockLogWarn.mock.calls.filter((c) => String(c[0]).includes("outside the deliverable"));
        expect(clampWarns).toHaveLength(1);
      });

      it("KPR-430 T7a: static effort field wins over the :effort suffix on Lane A (clamped set)", async () => {
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/kimi-k3:high", effort: "low", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr430-a" }));
        const [, , , , , , effort] = mockRunnerSend.mock.calls[0]!;
        expect(effort).toBe("low");
        expect(vi.mocked(routeModel)).not.toHaveBeenCalled();
        expect(turnTelemetryStore.record.mock.calls[0]![0]).toMatchObject({ effort: "low", effortSource: "static" });
      });

      it("KPR-430 T7b: static field max on Lane A clamps to nothing (no suffix fallback), one static-flavoured clamp warn", async () => {
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/kimi-k3:high", effort: "max", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr430-b1" }));
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr430-b2" }));
        expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();
        const clampWarns = mockLogWarn.mock.calls.filter((c) => String(c[0]).includes("outside the deliverable"));
        expect(clampWarns).toHaveLength(1);
        expect(String(clampWarns[0]![0])).toContain("Static effort field");
        expect(turnTelemetryStore.record.mock.calls[0]![0]).not.toHaveProperty("effortSource");
      });

      it("KPR-430 T7c: field absent — suffix path unchanged, source suffix", async () => {
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/kimi-k3:medium", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr430-c" }));
        expect(mockRunnerSend.mock.calls[0]![6]).toBe("medium");
        expect(turnTelemetryStore.record.mock.calls[0]![0]).toMatchObject({ effort: "medium", effortSource: "suffix" });
      });

      it("T5: Lane A resourceLimits stays undefined (runner legacy fallback)", async () => {
        await manager.spawnTurn(smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr346-limits" }));
        const [, , , , resourceLimits] = mockRunnerSend.mock.calls[0]!;
        expect(resourceLimits).toBeUndefined();
      });
    });

    describe("Lane B grok (KPR-392)", () => {
      function seed(threadId: string, sessionId: string, provider: string, agentId: string) {
        sessionStore._sessions.set(`${agentId}:${threadId}`, { sessionId, provider });
      }

      // The last AgentRunner construction's options bag (11th ctor arg).
      function lastRunnerOptions() {
        const call = vi.mocked(AgentRunner).mock.calls.at(-1)!;
        return call[10];
      }

      beforeEach(() => {
        mockConversationIndex.mockResolvedValue(undefined);
        mockResolveOAuthFileToken.mockReset().mockResolvedValue("test-grok-oauth-token");
        process.env.KIMI_API_KEY = "test-kimi-key";
        registry._agents.set(
          "agent-grok",
          makeAgentConfig({ id: "agent-grok", name: "AgentGrok", model: "grok/grok-4.6", coreServers: [] }),
        );
        registry._agents.set(
          "agent-kimi",
          makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/kimi-k3", coreServers: [] }),
        );
        mockGrokRunTurn.mockResolvedValue(makeRunResult({ text: "grok response", sessionId: "chatcmpl-default" }));
      });

      afterEach(() => {
        delete process.env.KIMI_API_KEY;
      });

      // --- routing ----------------------------------------------------------
      it("providerFor maps the grok/ prefix; a typo'd prefix still falls back to claude", () => {
        expect(manager.providerFor("agent-grok")).toBe("grok");

        // Pre-existing behaviour, pinned as the baseline for the fail-closed
        // follow-up: an unknown prefix becomes a Claude call with a garbage
        // model id rather than an error.
        registry._agents.set(
          "agent-typo",
          makeAgentConfig({ id: "agent-typo", name: "AgentTypo", model: "grock/grok-5" }),
        );
        expect(manager.providerFor("agent-typo")).toBe("claude");
      });

      // --- 1. construction: module-table lookup, no Lane A residue ----------
      it("grok turn constructs GrokAdapter through the module table — no laneAPassthrough bag, no Claude adapter", async () => {
        await manager.spawnTurn(smsCtx({ agentId: "agent-grok", threadId: "sms:line-1:kpr392-adapter" }));

        expect(mockGrokConstructor).toHaveBeenCalledWith(
          expect.objectContaining({
            apiKey: "test-grok-oauth-token",
            model: "grok-4.6",
          }),
        );
        // Pin the literal credential-file path passed to resolveOAuthFileToken —
        // this is fully mocked elsewhere in the suite, so nothing else catches
        // a typo in the path string that agent-manager.ts hands off.
        expect(mockResolveOAuthFileToken).toHaveBeenCalledWith("~/.grok/auth.json");
        // KPR-410: no baseUrl in the constructor options at all — GrokAdapter
        // hardcodes GROK_API_BASE_URL, there is nothing left to thread.
        expect(mockGrokConstructor).not.toHaveBeenCalledWith(
          expect.objectContaining({ baseUrl: expect.anything() }),
        );
        // Lane A retired for grok: AgentRunner gets no laneAPassthrough bag,
        // and the Claude adapter (mockRunnerSend) never runs.
        expect(lastRunnerOptions()).toBeUndefined();
        expect(mockRunnerSend).not.toHaveBeenCalled();
        expect(mockGrokRunTurn).toHaveBeenCalled();
        expect(mockCodexConstructor).not.toHaveBeenCalled();
        expect(mockOpenAIConstructor).not.toHaveBeenCalled();
        expect(mockGeminiConstructor).not.toHaveBeenCalled();
      });

      // --- 2. model chain -----------------------------------------------------
      // Non-discriminating for precedence (route model == module default here);
      // the discriminating precedence pin lives in provider-modules.test.ts
      // (route-grok vs cfg-grok). This pin covers routing + model delivery only.
      it("model chain: route model is delivered to the adapter", async () => {
        await manager.spawnTurn(smsCtx({ agentId: "agent-grok", threadId: "sms:line-1:kpr392-modelchain-route" }));
        expect(mockGrokConstructor).toHaveBeenLastCalledWith(expect.objectContaining({ model: "grok-4.6" }));
      });

      it("model chain: empty route model falls to appConfig.grok.agentModel", async () => {
        registry._agents.set(
          "agent-grok",
          makeAgentConfig({ id: "agent-grok", name: "AgentGrok", model: "grok/", coreServers: [] }),
        );
        (appConfig as any).grok.agentModel = "grok-4.5";
        try {
          await manager.spawnTurn(smsCtx({ agentId: "agent-grok", threadId: "sms:line-1:kpr392-modelchain-cfg" }));
          expect(mockGrokConstructor).toHaveBeenLastCalledWith(expect.objectContaining({ model: "grok-4.5" }));
        } finally {
          (appConfig as any).grok.agentModel = "";
        }
      });

      it("model chain: empty route + empty config falls to the module's grok-4.6 constructor default", async () => {
        registry._agents.set(
          "agent-grok",
          makeAgentConfig({ id: "agent-grok", name: "AgentGrok", model: "grok/", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "agent-grok", threadId: "sms:line-1:kpr392-modelchain-default" }));
        expect(mockGrokConstructor).toHaveBeenLastCalledWith(expect.objectContaining({ model: "grok-4.6" }));
      });

      // --- 3. effort — the Lane A clamp retires for grok ----------------------
      it(":xhigh flows to the constructor's reasoningEffort unchanged — no Lane A clamp warn (grok's native xhigh is now expressible)", async () => {
        registry._agents.set(
          "agent-grok",
          makeAgentConfig({ id: "agent-grok", name: "AgentGrok", model: "grok/grok-4.6:xhigh", coreServers: [] }),
        );
        await manager.spawnTurn(smsCtx({ agentId: "agent-grok", threadId: "sms:line-1:kpr392-effort-xhigh" }));
        expect(mockGrokConstructor).toHaveBeenLastCalledWith(expect.objectContaining({ reasoningEffort: "xhigh" }));
        // kimi's clamp pin lives in the Lane A describe above; grok must NOT
        // exercise it any more (isLaneAProvider("grok") is false).
        const clampWarns = mockLogWarn.mock.calls.filter((c) => String(c[0]).includes("outside the deliverable"));
        expect(clampWarns).toHaveLength(0);
      });

      // --- 3b. KPR-389 D2 round-1 reaction shaping, post-KPR-392 migration ---
      // grok is Lane B now (isLaneAProvider("grok") === false), so
      // shapeReactionTurn's effort pin — Lane-A/claude-only by contract — no
      // longer reaches it: request.effort stays undefined in both rounds, and
      // the :high suffix keeps flowing to the adapter CONSTRUCTOR (see the
      // :xhigh test above), unaffected by conferenceRound. resourceLimits
      // clamping is provider-lane-agnostic (same legacy-triple-then-min()
      // formula for Lane A and Lane B), so that half of the original T4 pin
      // still holds; round-0 now MATERIALIZES limits too (the Lane B
      // no-runner-fallback branch), where the retired Lane A path used to
      // leave them undefined.
      it("T4 (KPR-389, revised): grok round-1 clamps resourceLimits but does not pin effort (Lane B ignores request.effort); round-0 materializes the agent-def triple unclamped, also without effort", async () => {
        registry._agents.set(
          "agent-grok-high",
          makeAgentConfig({ id: "agent-grok-high", name: "GrokHigh", model: "grok/grok-4.6:high", coreServers: [] }),
        );
        await manager.spawnTurn(makeConfCtx(1, "agent-grok-high"));
        const req1 = mockGrokRunTurn.mock.calls.at(-1)![0];
        expect(req1.resourceLimits).toEqual({ maxTurns: 6, timeoutMs: 120_000, budgetUsd: 10 });
        expect(req1.effort).toBeUndefined();
        expect(mockGrokConstructor).toHaveBeenLastCalledWith(expect.objectContaining({ reasoningEffort: "high" }));

        await manager.spawnTurn(makeConfCtx(0, "agent-grok-high"));
        const req0 = mockGrokRunTurn.mock.calls.at(-1)![0];
        expect(req0.resourceLimits).toEqual({ maxTurns: 25, timeoutMs: 300_000, budgetUsd: 10 });
        expect(req0.effort).toBeUndefined();
        expect(mockGrokConstructor).toHaveBeenLastCalledWith(expect.objectContaining({ reasoningEffort: "high" }));
      });

      // --- 4. missing credential, breaker-invisible ---------------------------
      it("a missing/unreadable OAuth credential file is a config fault that never trips the grok breaker", async () => {
        mockResolveOAuthFileToken.mockReset().mockRejectedValue(
          new TurnAssemblyError(
            "Grok OAuth credential unavailable (authentication) at ~/.grok/auth.json — the file is absent or unreadable; run `grok login` to sign in",
          ),
        );
        for (let i = 0; i < 3; i++) {
          await expect(
            manager.spawnTurn(smsCtx({ agentId: "agent-grok", threadId: `sms:line-1:kpr392-cred-${i}` })),
          ).rejects.toThrow(/Grok OAuth credential unavailable \(authentication\)/);
        }
        // Breaker never tripped — restore the credential and the 4th spawn RUNS.
        mockResolveOAuthFileToken.mockReset().mockResolvedValue("test-grok-oauth-token");
        const result = await manager.spawnTurn(
          smsCtx({ agentId: "agent-grok", threadId: "sms:line-1:kpr392-cred-ok" }),
        );
        expect(result.errors).toEqual([]);
        expect(manager.circuitBreakers.stateFor("grok")?.state ?? "closed").toBe("closed");
      });

      // --- 6. breaker attribution ---------------------------------------------
      it("three hard faults open the grok breaker only — claude and kimi stay closed", async () => {
        for (let i = 0; i < 3; i++) {
          mockGrokRunTurn.mockResolvedValueOnce(makeRunResult({ error: "Grok request failed (503): boom" }));
          await manager.spawnTurn(smsCtx({ agentId: "agent-grok", threadId: `sms:line-1:kpr392-trip-${i}` }));
        }
        expect(manager.circuitBreakers.stateFor("grok")!.state).toBe("open");

        await expect(
          manager.spawnTurn(smsCtx({ agentId: "agent-grok", threadId: "sms:line-1:kpr392-fastfail" })),
        ).rejects.toBeInstanceOf(ProviderCircuitOpenError);

        // Sibling providers are untouched — the breaker keys on the route.
        expect(manager.circuitBreakers.stateFor("kimi")?.state ?? "closed").toBe("closed");
        const kimiResult = await manager.spawnTurn(
          smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr392-kimi-ok" }),
        );
        expect(kimiResult.finalMessage).toBe("response");
        const claudeResult = await manager.spawnTurn(
          smsCtx({ agentId: "agent-a", threadId: "sms:line-1:kpr392-claude-ok" }),
        );
        expect(claudeResult.finalMessage).toBe("response");
      });

      // --- 7. stateless-replay session persistence (KPR-313 write side) ------
      it("a success turn persists the session row with an empty sessionId under the grok tag", async () => {
        const threadId = "sms:line-1:kpr392-persist";
        mockGrokRunTurn.mockResolvedValueOnce(makeRunResult({ text: "ok", sessionId: "chatcmpl-abc123" }));
        await manager.spawnTurn(smsCtx({ agentId: "agent-grok", threadId }));
        expect(sessionStore.set).toHaveBeenCalledWith(
          "agent-grok", threadId, "", "grok", expect.anything(),
        );
      });

      // --- 8. KPR-313 session-identity guard ----------------------------------
      it("claude-tagged row + grok turn resets continuity with the pilot (Lane B) notice variant", async () => {
        const threadId = "sms:line-1:kpr392-handoff-toGrok";
        seed(threadId, "s-old", "claude", "agent-grok");
        mockGrokRunTurn.mockResolvedValueOnce(makeRunResult({ text: "fresh", sessionId: "chatcmpl-new" }));

        await manager.spawnTurn(
          smsCtx({ agentId: "agent-grok", threadId, sessionId: "s-old", sessionProvider: "claude" }),
        );

        const req = mockGrokRunTurn.mock.calls[0]![0];
        expect(req.sessionId).toBeUndefined();
        expect(req.prompt.startsWith("[System notice:")).toBe(true);
        expect(req.prompt).toContain("session continuity was reset");
        // Lane B keeps the conservative pilot-era variant — no conversation_search.
        expect(req.prompt).not.toContain("conversation_search");
      });

      it("grok-tagged stale row + grok turn resumes with zero store reads and no handoff notice (same provider id — stateless semantics)", async () => {
        const threadId = "sms:line-1:kpr392-samegrok";
        seed(threadId, "chatcmpl-old", "grok", "agent-grok");
        mockGrokRunTurn.mockResolvedValueOnce(makeRunResult({ text: "back", sessionId: "chatcmpl-new" }));

        await manager.spawnTurn(
          smsCtx({ agentId: "agent-grok", threadId, sessionId: "chatcmpl-old", sessionProvider: "grok" }),
        );

        expect(sessionStore.get).not.toHaveBeenCalled(); // same-provider tag: zero-I/O hot path
        const req = mockGrokRunTurn.mock.calls[0]![0];
        expect(req.prompt).not.toContain("session continuity was reset");
      });

      // --- 9. provider handoff away from grok still clears provider_turn_history ---
      // Reuse of the existing codex-handoff test pattern (TurnHistoryStore
      // wiring describe, KPR-353 §D3/§D4) — the clear is already
      // provider-agnostic (agent-manager.ts:979), so this is correct by
      // construction; pinned directly here for the grok-specific direction.
      describe("provider_turn_history handoff away from grok", () => {
        function makeFakeTurnHistoryStore() {
          return {
            load: vi.fn(async () => [] as unknown[]),
            append: vi.fn(async () => {}),
            clear: vi.fn(async () => {}),
            init: vi.fn(async () => {}),
          };
        }

        function makeManagerWithStore(fakeStore: ReturnType<typeof makeFakeTurnHistoryStore>) {
          return new AgentManager(
            registry as any,
            memoryManager as any,
            sessionStore as any,
            undefined as any,
            turnTelemetryStore as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            fakeStore as any,
          );
        }

        it("grok-tagged row + claude turn clears provider_turn_history via the provider-agnostic clear", async () => {
          const fakeStore = makeFakeTurnHistoryStore();
          const mgr = makeManagerWithStore(fakeStore);
          const threadId = "sms:line-1:kpr392-handoff-fromGrok";
          seed(threadId, "", "grok", "agent-a");

          await mgr.spawnTurn(
            smsCtx({ agentId: "agent-a", threadId, sessionId: undefined, sessionProvider: "grok" }),
          );

          expect(fakeStore.clear).toHaveBeenCalledTimes(1);
          expect(fakeStore.clear).toHaveBeenCalledWith("agent-a", threadId);
        });
      });
    });

    describe("provider plugins (KPR-394)", () => {
      let fixture: ReturnType<typeof makeFixtureProviderModule>;

      function makeFixtureProviderModule(id = "sol") {
        const constructions: any[] = [];
        const runTurn = vi.fn(async () => makeRunResult({ text: `${id} says hi` }));
        const abort = vi.fn();
        const module = {
          provider: id,
          createAdapter: vi.fn((args: any) => {
            constructions.push(args);
            return { provider: id, runTurn, abort, wasAborted: false };
          }),
        };
        return { module, constructions, runTurn, abort };
      }

      // Replicated from the KPR-354 describe's makeSubagentEntry (scoped
      // there, deliberately not hoisted). `laneB` is the R3 generic column a
      // PLUGIN provider id reads through partitionInventoryForProvider's
      // fallback — the KPR-354 literal only carries built-in columns, so a
      // verbatim copy would be honestly `unsupported` for "sol".
      function makeSolSubagentEntry(): any {
        return {
          name: "google",
          transport: "claude-subagent",
          source: "core",
          requiresTurnContext: false,
          requiresHiveRuntime: false,
          inProcess: false,
          compatibility: {
            claude: "direct",
            openai: "requires-hive-bridge",
            gemini: "requires-hive-bridge",
            codex: "requires-hive-bridge",
            grok: "requires-hive-bridge",
            laneB: "requires-hive-bridge",
          },
          schemas: { kind: "unavailable" },
          description: "Gmail + Calendar",
          serverConfig: { type: "stdio", command: "gog-mcp" },
        };
      }

      async function registerSol(slice: Record<string, unknown> | undefined = {
        defaultModel: "sol-large-2",
        apiKeyEnv: "SOL_API_KEY",
        baseUrlEnv: "SOL_BASE_URL",
      }) {
        const reg = await import("./provider-adapters/provider-registry.js");
        fixture = makeFixtureProviderModule();
        reg.__registerActivePluginProviderForTests({
          id: "sol",
          module: fixture.module as any,
          semantics: "stateless-replay",
          source: { plugin: "hive-plugin-sol" },
          slice: slice as any,
        });
        registry._agents.set(
          "agent-sol",
          makeAgentConfig({ id: "agent-sol", name: "AgentSol", model: "sol/sol-large-2:high", coreServers: [] }),
        );
      }

      beforeEach(() => {
        mockConversationIndex.mockResolvedValue(undefined);
        process.env.SOL_API_KEY = "test-sol-key";
      });

      afterEach(async () => {
        delete process.env.SOL_API_KEY;
        delete process.env.SOL_BASE_URL;
        const reg = await import("./provider-adapters/provider-registry.js");
        reg.__resetPluginProvidersForTests();
      });

      it("routing: registered plugin id maps via providerFor; declared-broken routes to itself; undeclared falls back to claude", async () => {
        await registerSol();
        const reg = await import("./provider-adapters/provider-registry.js");
        reg.__markBrokenPluginProviderForTests("bad", { plugin: "hive-plugin-bad", reason: "abi mismatch" });
        registry._agents.set(
          "agent-bad",
          makeAgentConfig({ id: "agent-bad", name: "AgentBad", model: "bad/bad-1", coreServers: [] }),
        );
        expect(manager.providerFor("agent-sol")).toBe("sol");
        expect(manager.providerFor("agent-bad")).toBe("bad"); // declared-broken: routes, then fails honestly
        registry._agents.set(
          "agent-typo2",
          makeAgentConfig({ id: "agent-typo2", name: "AgentTypo2", model: "zeta/z-1" }),
        );
        expect(manager.providerFor("agent-typo2")).toBe("claude"); // never-declared canon unchanged
      });

      it("primary construction: fixture module builds the adapter with context primary, route model+effort, agentId deps", async () => {
        await registerSol();
        const result = await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-primary" }));
        expect(result.errors).toEqual([]);
        expect(fixture.runTurn).toHaveBeenCalled();
        const args = fixture.constructions[0]!;
        expect(args.context).toBe("primary");
        expect(args.name).toBe("AgentSol");
        expect(args.route).toEqual({ model: "sol-large-2", reasoningEffort: "high" });
        expect(args.deps.agentId).toBe("agent-sol");
        // No builtin adapter and no Claude runner ran.
        expect(mockRunnerSend).not.toHaveBeenCalled();
        expect(mockCodexConstructor).not.toHaveBeenCalled();
      });

      it("slice resolution: agentModel default + env-resolved apiKey; baseUrl undefined when override unset", async () => {
        await registerSol();
        await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-slice" }));
        expect(fixture.constructions[0]!.deps.providerConfig).toEqual({
          agentModel: "sol-large-2",
          apiKey: "test-sol-key",
          baseUrl: undefined,
        });
      });

      it("missing SOL_API_KEY is a config fault that never trips the sol breaker (byte-identical grok contract)", async () => {
        await registerSol();
        delete process.env.SOL_API_KEY;
        for (let i = 0; i < 3; i++) {
          await expect(
            manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: `sms:line-1:kpr394-cred-${i}` })),
          ).rejects.toThrow(/Passthrough credential missing \(authentication\): SOL_API_KEY/);
        }
        process.env.SOL_API_KEY = "test-sol-key";
        const result = await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-cred-ok" }));
        expect(result.errors).toEqual([]);
        expect(manager.circuitBreakers.stateFor("sol")?.state ?? "closed").toBe("closed");
      });

      it("a loopback SOL_BASE_URL override flows to the slice", async () => {
        await registerSol();
        process.env.SOL_BASE_URL = "http://127.0.0.1:4141";
        await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-baseurl-ok" }));
        expect(fixture.constructions[0]!.deps.providerConfig.baseUrl).toBe("http://127.0.0.1:4141");
      });

      it("a cleartext off-box SOL_BASE_URL override is a breaker-invisible config fault", async () => {
        await registerSol();
        process.env.SOL_BASE_URL = "http://evil.example:8317";
        await expect(
          manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-baseurl-bad" })),
        ).rejects.toThrow(/cleartext to a non-loopback host/);
        expect(manager.circuitBreakers.stateFor("sol")?.state ?? "closed").toBe("closed");
      });

      it("declared-broken provider: honest TurnAssemblyError naming plugin + reason; breaker closed; never Claude", async () => {
        const reg = await import("./provider-adapters/provider-registry.js");
        reg.__markBrokenPluginProviderForTests("bad", { plugin: "hive-plugin-bad", reason: "plugin requires provider ABI 2; engine provides 1" });
        registry._agents.set(
          "agent-bad",
          makeAgentConfig({ id: "agent-bad", name: "AgentBad", model: "bad/bad-1", coreServers: [] }),
        );
        await expect(
          manager.spawnTurn(smsCtx({ agentId: "agent-bad", threadId: "sms:line-1:kpr394-broken" })),
        ).rejects.toThrow(/provider 'bad' from plugin 'hive-plugin-bad' failed to load: plugin requires provider ABI 2/);
        expect(manager.circuitBreakers.stateFor("bad")?.state ?? "closed").toBe("closed");
        expect(mockRunnerSend).not.toHaveBeenCalled(); // no silent Claude fallback
      });

      it("nested delegate turn constructs the SAME plugin module with context nested (KPR-354 parity)", async () => {
        await registerSol();
        registry._agents.set(
          "agent-sol",
          makeAgentConfig({
            id: "agent-sol",
            name: "AgentSol",
            model: "sol/sol-large-2",
            delegateServers: ["google"],
            coreServers: [],
          }),
        );
        mockRunnerToolInventory.mockReturnValue([makeSolSubagentEntry()]);
        await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: "sms:line-1:kpr394-nested" }));
        const delegateRunner = fixture.constructions[0]!.assembly.delegateTurnRunner;
        const text = await delegateRunner({
          delegate: "google",
          entry: makeSolSubagentEntry(),
          prompt: "do the thing",
          workItemContext: undefined,
          signal: new AbortController().signal,
        });
        expect(text).toBe("sol says hi");
        const nested = fixture.constructions.find((c) => c.context === "nested")!;
        expect(nested.name).toBe("AgentSol:google");
        expect(nested.deps).toBe(fixture.constructions[0]!.deps); // one shared deps object, both sites
      });

      it("three hard faults trip ONLY the sol breaker — sibling breakers untouched", async () => {
        await registerSol();
        fixture.runTurn.mockResolvedValue(
          makeRunResult({ error: "connect ECONNREFUSED 127.0.0.1:4141", text: "" }),
        );
        for (let i = 0; i < 3; i++) {
          await manager.spawnTurn(smsCtx({ agentId: "agent-sol", threadId: `sms:line-1:kpr394-fault-${i}` }));
        }
        expect(manager.circuitBreakers.stateFor("sol")?.state).toBe("open");
        expect(manager.circuitBreakers.stateFor("codex")).toBeNull(); // never used this process
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
        // KPR-353 (§D3): store wiring. This `manager` (beforeEach) carries no
        // TurnHistoryStore ⇒ historyStore is undefined; agentId is the store key.
        historyStore: undefined,
        agentId: "codex-pilot",
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

    it("KPR-352 §D5/T7: gemini-branch options — :effort carried, apiKey from config, Interactions model", async () => {
      registry._agents.set(
        "gemini-effort-pilot",
        makeAgentConfig({
          id: "gemini-effort-pilot",
          name: "Gemini Effort Pilot",
          model: "gemini/gemini-3.6-flash:high",
          coreServers: [],
        }),
      );

      const item = makeWorkItem({ text: "ping", source: { kind: "sms", id: "line-1", label: "May" } });
      await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "gemini-effort-pilot" });

      expect(mockGeminiConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Gemini Effort Pilot",
          model: "gemini-3.6-flash",
          reasoningEffort: "high",
          apiKey: "test-gemini-key",
          assembly: expect.objectContaining({ instructions: "PILOT-ASSEMBLED-INSTRUCTIONS" }),
        }),
      );
    });

    it("KPR-352: bare gemini/ (empty agentModel config) falls back to the Interactions default model", async () => {
      registry._agents.set(
        "gemini-default-pilot",
        makeAgentConfig({ id: "gemini-default-pilot", name: "Gemini Default Pilot", model: "gemini/", coreServers: [] }),
      );

      const item = makeWorkItem({ text: "ping", source: { kind: "sms", id: "line-1", label: "May" } });
      await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "gemini-default-pilot" });

      expect(mockGeminiConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gemini-3.6-flash" }),
      );
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


    describe("intent-trailer telemetry (KPR-393 §D2)", () => {
      function makeAuditManager() {
        const activityLogger = { record: vi.fn() };
        const localManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          activityLogger as any,
        );
        return { activityLogger, localManager };
      }

      it("sets intentTrailer: true when the delivered text ends on an unexecuted commitment", async () => {
        const { activityLogger, localManager } = makeAuditManager();
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ text: "Understood — I'll check the deploy logs and report back." }),
        );
        const item = makeWorkItem({ text: "check the logs", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn(makeCtx(item, "sms"));
        expect(activityLogger.record).toHaveBeenCalledTimes(1);
        expect(activityLogger.record.mock.calls[0]![0].intentTrailer).toBe(true);
      });

      it("omits the field entirely on a non-promise turn (absent, not false)", async () => {
        const { activityLogger, localManager } = makeAuditManager();
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ text: "Done — the fix is deployed and the check passed." }),
        );
        const item = makeWorkItem({ text: "status?", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn(makeCtx(item, "sms"));
        const arg = activityLogger.record.mock.calls[0]![0];
        expect("intentTrailer" in arg).toBe(false);
      });

      it("error turn with promise-shaped text stays unflagged (a delivered error is not a promise)", async () => {
        const { activityLogger, localManager } = makeAuditManager();
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ text: "I'll retry the deploy right away.", error: "exit code 1" }),
        );
        const item = makeWorkItem({ text: "deploy", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn(makeCtx(item, "sms"));
        const arg = activityLogger.record.mock.calls[0]![0];
        expect(arg.error).toBe("exit code 1");
        expect("intentTrailer" in arg).toBe(false);
      });
    });

    describe("aborted-turn observability (KPR-401)", () => {
      function makeObsManager() {
        const activityLogger = { record: vi.fn() };
        const localManager = new AgentManager(
          registry as any,
          memoryManager as any,
          sessionStore as any,
          undefined as any,
          turnTelemetryStore as any,
          activityLogger as any,
        );
        return { localManager, activityLogger };
      }

      it("aborted turn WITH usage + sessionId records telemetry with aborted: true (relaxed gate)", async () => {
        // NEGATIVE-VERIFY prediction (Step 3): pre-fix the gate is
        // `sessionId && !aborted` — record() is never called; this row fails.
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "s-kpr401-tel", text: "" }),
        );
        const item = makeWorkItem({ text: "tel aborted", source: { kind: "sms", id: "line-1", label: "May" } });
        await manager.spawnTurn(makeCtx(item, "sms"));
        await Promise.resolve();
        await Promise.resolve();
        expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
        const telArg = turnTelemetryStore.record.mock.calls[0]![0];
        expect(telArg.aborted).toBe(true);
        expect(telArg.sessionId).toBe("s-kpr401-tel");
        expect(telArg.inputTokens).toBe(100); // real spend from the runner accumulator, not zeros
        expect("timedOut" in telArg).toBe(false); // telemetry doc carries aborted only (spec §Design 2)
      });

      it("aborted turn with ZERO usage stays out of telemetry (synthesizeAbortedResult noise guard)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({
            aborted: true,
            timedOut: true,
            sessionId: "s-kpr401-zero",
            text: "",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          }),
        );
        const item = makeWorkItem({ text: "tel zero", source: { kind: "sms", id: "line-1", label: "May" } });
        await manager.spawnTurn(makeCtx(item, "sms"));
        await Promise.resolve();
        await Promise.resolve();
        expect(turnTelemetryStore.record).not.toHaveBeenCalled();
      });

      it("success turns record WITHOUT the aborted field — doc shape unchanged", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-kpr401-ok" }));
        const item = makeWorkItem({ text: "tel clean", source: { kind: "sms", id: "line-1", label: "May" } });
        await manager.spawnTurn(makeCtx(item, "sms"));
        await Promise.resolve();
        await Promise.resolve();
        expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
        const telArg = turnTelemetryStore.record.mock.calls[0]![0];
        expect("aborted" in telArg).toBe(false);
      });

      it("activity audit passes aborted/timedOut through sparsely — set on aborted turns, absent on success", async () => {
        // NEGATIVE-VERIFY prediction (Step 3): pre-fix the audit payload has
        // neither key — the aborted-turn assertions fail.
        const { localManager, activityLogger } = makeObsManager();
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({
            aborted: true,
            timedOut: true,
            sessionId: "s-kpr401-act",
            text: "",
            costUsd: 0,
            durationMs: 294_391,
          }),
        );
        const item1 = makeWorkItem({ text: "audit aborted", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn(makeCtx(item1, "sms"));
        expect(activityLogger.record).toHaveBeenCalledTimes(1);
        const abortedArg = activityLogger.record.mock.calls[0]![0];
        expect(abortedArg.aborted).toBe(true);
        expect(abortedArg.timedOut).toBe(true);
        expect(abortedArg.costUsd).toBe(0); // honest zero, now flagged
        expect(abortedArg.durationMs).toBe(294_391); // real wall clock from the runner

        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ sessionId: "s-kpr401-ok2" }));
        const item2 = makeWorkItem({ text: "audit clean", source: { kind: "sms", id: "line-1", label: "May" } });
        await localManager.spawnTurn(makeCtx(item2, "sms"));
        const successArg = activityLogger.record.mock.calls.at(-1)![0];
        expect("aborted" in successArg).toBe(false); // sparse: absent, not false
        expect("timedOut" in successArg).toBe(false);
      });
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
          // Lane B limits come from the agent definition (fixture defaults),
          // not the adapters' DEFAULT_MAX_ROUNDS — see the dedicated tests.
          expect(req.resourceLimits).toEqual({ maxTurns: 25, timeoutMs: 300_000, budgetUsd: 10 });
        });

        it("KPR-430 T8: static effort field on a Lane B (codex) agent — request.effort undefined, one warn, no telemetry effort", async () => {
          (appConfig as any).modelRouter.enabled = true;
          registry._agents.set(
            "codex-fx",
            makeAgentConfig({
              id: "codex-fx",
              name: "Codex Fx",
              model: "codex/gpt-5.5:medium",
              effort: "max",
              coreServers: [],
            }),
          );
          await manager.spawnTurn({
            ...makeCtx(makeWorkItem({ text: "lane b", source: { kind: "sms", id: "line-1", label: "May" } }), "sms"),
            agentId: "codex-fx",
            threadId: "sms:line-1:t8a",
          });
          await manager.spawnTurn({
            ...makeCtx(makeWorkItem({ text: "lane b", source: { kind: "sms", id: "line-1", label: "May" } }), "sms"),
            agentId: "codex-fx",
            threadId: "sms:line-1:t8b",
          });
          expect(routeModel).not.toHaveBeenCalled();
          expect(mockCodexRunTurn.mock.calls[0]![0].effort).toBeUndefined();
          const laneBWarns = mockLogWarn.mock.calls.filter((c) => String(c[0]).includes("not delivered on this provider"));
          expect(laneBWarns).toHaveLength(1);
          const doc = turnTelemetryStore.record.mock.calls[0]![0];
          expect(doc).not.toHaveProperty("effort");
          expect(doc).not.toHaveProperty("effortSource");
        });

        it("Lane B resourceLimits mirror the agent definition (maxTurns is not dead config)", async () => {
          registry._agents.set(
            "gemini-b",
            makeAgentConfig({
              id: "gemini-b",
              name: "GeminiB",
              model: "gemini/gemini-3.1-pro-preview",
              maxTurns: 40,
              budgetUsd: 7,
              timeoutMs: 120_000,
              coreServers: [],
              soul: "",
              systemPrompt: "gemini system",
            }),
          );

          const item = makeWorkItem({ text: "hello gemini", source: { kind: "sms", id: "line-1", label: "May" } });
          await manager.spawnTurn({ ...makeCtx(item, "sms"), agentId: "gemini-b" });

          const req = mockGeminiRunTurn.mock.calls[0]![0];
          expect(req.resourceLimits).toEqual({ maxTurns: 40, timeoutMs: 120_000, budgetUsd: 7 });
        });

        it("Lane B system-sender turns carry agent-def limits too (router still skipped)", async () => {
          (appConfig as any).modelRouter.enabled = true;
          registry._agents.set(
            "gemini-b",
            makeAgentConfig({
              id: "gemini-b",
              name: "GeminiB",
              model: "gemini/gemini-3.1-pro-preview",
              maxTurns: 40,
              coreServers: [],
              soul: "",
              systemPrompt: "gemini system",
            }),
          );

          const sys = makeWorkItem({
            text: "execute your scheduled digest task",
            sender: "system",
            source: { kind: "sms", id: "line-1", label: "May" },
          });
          await manager.spawnTurn({ ...makeCtx(sys, "sms"), agentId: "gemini-b", threadId: "sms:line-1:gsys" });

          expect(routeModel).not.toHaveBeenCalled();
          const req = mockGeminiRunTurn.mock.calls[0]![0];
          expect(req.resourceLimits?.maxTurns).toBe(40);
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

  // ---------------------------------------------------------------------------
  // KPR-354 §D5: the nested-turn runner (THE LIGHT-UP). Exercises the
  // manager-built delegateTurnRunner carried on the Lane B assembly — captured
  // off the real assembleProviderTurn output and invoked directly.
  // ---------------------------------------------------------------------------
  describe("KPR-354 nested delegate turns", () => {
    const NESTED_NAME = "TestAgent:google";

    function makeSubagentEntry(overrides: Partial<HiveToolInventoryEntry> = {}): HiveToolInventoryEntry {
      return {
        name: "google",
        transport: "claude-subagent",
        source: "core",
        requiresTurnContext: false,
        requiresHiveRuntime: false,
        inProcess: false,
        compatibility: {
          claude: "direct",
          openai: "requires-hive-bridge",
          gemini: "requires-hive-bridge",
          codex: "requires-hive-bridge",
        },
        schemas: { kind: "unavailable" },
        description: "Gmail + Calendar",
        serverConfig: { type: "stdio", command: "gog-mcp" } as never,
        ...overrides,
      };
    }

    const call = (
      runner: DelegateTurnRunner,
      signal: AbortSignal = new AbortController().signal,
    ): Promise<string> => runner({ delegate: "google", prompt: "p", entry: makeSubagentEntry(), signal });

    // Run one parent openai spawn (resolves immediately) and hand back the
    // delegateTurnRunner off the FIRST openai construction's assembly.
    async function setupOpenAIParent(cfg: Partial<AgentConfig> = {}): Promise<DelegateTurnRunner> {
      registry._agents.set(
        "np",
        makeAgentConfig({
          id: "np",
          name: "TestAgent",
          model: "openai/gpt-5.4-mini",
          delegateServers: ["google"],
          coreServers: [],
          ...cfg,
        }),
      );
      mockRunnerToolInventory.mockReturnValue([makeSubagentEntry()]);
      mockConversationIndex.mockResolvedValue(undefined);
      await manager.spawnTurn(makeSmsCtx({ agentId: "np" }));
      return mockOpenAIConstructor.mock.calls[0]![0].assembly.delegateTurnRunner as DelegateTurnRunner;
    }

    const nestedOpenAIConstructions = () =>
      mockOpenAIConstructor.mock.calls.filter((c) => c[0].name === NESTED_NAME);

    // The budget slot the nested runner holds is `activeSpawnCount` (the same
    // map withSpawnTicket uses) — NOT `activeTickets`, which drives
    // getSnapshot().activeSpawns and which the nested runner deliberately never
    // touches (no ticket, no updateStatus, no lock). Observe the real slot.
    const activeSlots = (id: string): number =>
      ((manager as unknown as { activeSpawnCount: Map<string, number> }).activeSpawnCount.get(id) ?? 0);

    it("(1) happy path: resolves delegate text; nested built with parent route + generic prompt + no runner", async () => {
      const runner = await setupOpenAIParent();
      mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ text: "delegate output" }));

      expect(await call(runner)).toBe("delegate output");

      const nested = nestedOpenAIConstructions();
      expect(nested.length).toBe(1);
      const opts = nested[0]![0];
      expect(opts.name).toBe(NESTED_NAME);
      expect(opts.model).toBe("gpt-5.4-mini"); // parent route's model
      expect(opts.assembly.instructions).toBe(buildGenericDelegatePrompt("google"));
      // Structural depth-1: nested assembly carries no delegate runner.
      expect(opts.assembly.delegateTurnRunner).toBeUndefined();
      // Directive 2 pin: nested assembly omitted nothing (all-bridgeable).
      expect(opts.assembly.omittedTools).toEqual([]);
    });

    it("(2) empty text / error / aborted results shape to the D5.7 strings", async () => {
      const runner = await setupOpenAIParent();

      mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ text: "" }));
      expect(await call(runner)).toBe("Delegate 'google' returned no output.");

      mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ error: "boom" }));
      expect(await call(runner)).toBe("Delegate turn failed (google): boom");

      mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ aborted: true }));
      expect(await call(runner)).toBe("Delegate turn aborted (google).");
    });

    it("(3) nested runTurn REJECTS → never-rejects string AND slot released", async () => {
      const runner = await setupOpenAIParent();
      mockOpenAIRunTurn.mockRejectedValueOnce(new Error("kaboom"));

      expect(await call(runner)).toBe("Delegate turn failed (google): kaboom");
      // Negative-verify leg 3: removing the finally decrement leaves this at 1.
      expect(activeSlots("np")).toBe(0);
    });

    it("(4) directive 3 pin — synchronous stop+budget: 3 sync calls at budget 2 → exactly 2 nested, third denied", async () => {
      const runner = await setupOpenAIParent({ spawnBudget: 2 });
      let resolve1!: (v: unknown) => void;
      let resolve2!: (v: unknown) => void;
      mockOpenAIRunTurn
        .mockImplementationOnce(() => new Promise((r) => { resolve1 = r; }))
        .mockImplementationOnce(() => new Promise((r) => { resolve2 = r; }));

      // No await between the three invocations — the sync stop/budget prefix of
      // each runs to its first internal await before the next begins.
      const p1 = call(runner);
      const p2 = call(runner);
      const p3 = call(runner);

      expect(await p3).toBe(
        "Task denied: spawn budget exhausted (2/2). Retry later or proceed without the delegate.",
      );
      expect(nestedOpenAIConstructions().length).toBe(2);
      expect(manager.getSnapshot().perAgent["np"]!.saturationCount).toBe(1);

      resolve1(makeRunResult({ text: "d1" }));
      resolve2(makeRunResult({ text: "d2" }));
      expect(await p1).toBe("d1");
      expect(await p2).toBe("d2");
      expect(activeSlots("np")).toBe(0);
    });

    it("(5) saturation denial does not leak a slot", async () => {
      const runner = await setupOpenAIParent({ spawnBudget: 2 });
      let resolve1!: (v: unknown) => void;
      let resolve2!: (v: unknown) => void;
      mockOpenAIRunTurn
        .mockImplementationOnce(() => new Promise((r) => { resolve1 = r; }))
        .mockImplementationOnce(() => new Promise((r) => { resolve2 = r; }));

      const p1 = call(runner);
      const p2 = call(runner);
      const slotsBeforeDenial = activeSlots("np");
      expect(slotsBeforeDenial).toBe(2);
      await call(runner); // denial
      expect(activeSlots("np")).toBe(slotsBeforeDenial);

      resolve1(makeRunResult({ text: "d1" }));
      resolve2(makeRunResult({ text: "d2" }));
      await Promise.all([p1, p2]);
    });

    it("(6) stopped agent → denied, no nested construction", async () => {
      const runner = await setupOpenAIParent();
      manager.stopAgent("np");
      const before = mockOpenAIConstructor.mock.calls.length;

      expect(await call(runner)).toBe("Task denied: agent is stopped.");
      expect(mockOpenAIConstructor.mock.calls.length).toBe(before);
    });

    it("(7) abort chain: mid-flight abort calls nested.abort() then resolves aborted; pre-aborted short-circuits the turn", async () => {
      const runner = await setupOpenAIParent();

      // Mid-flight: hang the nested turn, fire the parent signal.
      let resolveNested!: (v: unknown) => void;
      mockOpenAIRunTurn.mockImplementationOnce(() => new Promise((r) => { resolveNested = r; }));
      const ac = new AbortController();
      const p = call(runner, ac.signal);
      await Promise.resolve();
      ac.abort();
      expect(mockOpenAIAbort).toHaveBeenCalled();
      resolveNested(makeRunResult({ aborted: true }));
      expect(await p).toBe("Delegate turn aborted (google).");

      // Pre-aborted: §D5 constructs the adapter before the aborted short-circuit
      // (verbatim order), but the nested TURN never runs — runTurn is not
      // invoked for the delegate.
      const preAbort = new AbortController();
      preAbort.abort();
      const runTurnCallsBefore = mockOpenAIRunTurn.mock.calls.length;
      expect(await call(runner, preAbort.signal)).toBe("Delegate turn aborted (google).");
      expect(mockOpenAIRunTurn.mock.calls.length).toBe(runTurnCallsBefore);
    });

    it("(8) directive 1 pin — abort() throw inside the listener is contained (never escapes)", async () => {
      const runner = await setupOpenAIParent();
      mockOpenAIAbort.mockImplementation(() => {
        throw new Error("abort boom");
      });
      let resolveNested!: (v: unknown) => void;
      mockOpenAIRunTurn.mockImplementationOnce(() => new Promise((r) => { resolveNested = r; }));

      const ac = new AbortController();
      const p = call(runner, ac.signal);
      await Promise.resolve();
      // Negative-verify leg 4: without the listener try/catch this throw escapes
      // as a worker-level uncaught error and fails the test.
      ac.abort();
      resolveNested(makeRunResult({ aborted: true }));
      await expect(p).resolves.toBe("Delegate turn aborted (google).");
    });

    it("(9) directive 2 pin — nested run leaves lastSpawnAt untouched and status idle", async () => {
      const runner = await setupOpenAIParent();
      const before = manager.getSnapshot().perAgent["np"]!.lastSpawnAt;
      await call(runner); // full nested run (default openai resolve)
      expect(manager.getSnapshot().perAgent["np"]!.lastSpawnAt).toBe(before);

      // Mid-flight: no parent in flight → status stays idle through the nested turn.
      let resolveNested!: (v: unknown) => void;
      mockOpenAIRunTurn.mockImplementationOnce(() => new Promise((r) => { resolveNested = r; }));
      const p = call(runner);
      await Promise.resolve();
      expect(manager.getState("np")!.status).toBe("idle");
      resolveNested(makeRunResult({ text: "x" }));
      await p;
    });

    it("(10) slot visibility — the budget slot is held (1) during a hanging nested turn", async () => {
      const runner = await setupOpenAIParent();
      let resolveNested!: (v: unknown) => void;
      mockOpenAIRunTurn.mockImplementationOnce(() => new Promise((r) => { resolveNested = r; }));

      const p = call(runner);
      await Promise.resolve();
      expect(activeSlots("np")).toBe(1);
      // getSnapshot().activeSpawns stays 0 — nested turns hold a budget slot but
      // register no activeTicket (no lock/status), by construction (§D5.2).
      expect(manager.getSnapshot().perAgent["np"]!.activeSpawns).toBe(0);
      resolveNested(makeRunResult({ text: "x" }));
      await p;
      expect(activeSlots("np")).toBe(0);
    });

    it("(11) codex parent — nested gets NO historyStore/agentId, route effort, and touches no session/history store", async () => {
      const historyStore = {
        load: vi.fn().mockResolvedValue([]),
        append: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      };
      const localManager = new AgentManager(
        registry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        historyStore as any,
      );
      registry._agents.set(
        "cp",
        makeAgentConfig({
          id: "cp",
          name: "TestAgent",
          model: "codex/gpt-5.5:medium",
          delegateServers: ["google"],
          coreServers: [],
        }),
      );
      mockRunnerToolInventory.mockReturnValue([makeSubagentEntry()]);
      mockConversationIndex.mockResolvedValue(undefined);
      await localManager.spawnTurn(makeSmsCtx({ agentId: "cp" }));
      const runner = mockCodexConstructor.mock.calls[0]![0].assembly.delegateTurnRunner as DelegateTurnRunner;

      // Baselines captured AFTER the parent spawn — the nested invocation must
      // add nothing.
      const loadBefore = historyStore.load.mock.calls.length;
      const appendBefore = historyStore.append.mock.calls.length;
      const clearBefore = historyStore.clear.mock.calls.length;
      const setBefore = sessionStore.set.mock.calls.length;

      await call(runner);

      const nested = mockCodexConstructor.mock.calls.find((c) => c[0].name === NESTED_NAME)![0];
      expect(nested.historyStore).toBeUndefined();
      expect(nested.agentId).toBeUndefined();
      expect(nested.reasoningEffort).toBe("medium"); // route's effort
      expect(nested.model).toBe("gpt-5.5");
      expect(historyStore.load.mock.calls.length).toBe(loadBefore);
      expect(historyStore.append.mock.calls.length).toBe(appendBefore);
      expect(historyStore.clear.mock.calls.length).toBe(clearBefore);
      expect(sessionStore.set.mock.calls.length).toBe(setBefore);
    });

    it("(12) T8 breaker neutrality — a 5xx tool fault stays in tool text; no breaker record; classifies success", async () => {
      const runner = await setupOpenAIParent();
      const recordSpy = vi.spyOn(manager.circuitBreakers, "record");
      mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ error: "500 Internal Server Error", text: "" }));

      expect(await call(runner)).toBe("Delegate turn failed (google): 500 Internal Server Error");
      expect(recordSpy).not.toHaveBeenCalled();
      // The fault lives only in tool text — the parent turn's own result (a
      // successful string return) classifies success.
      expect(
        classifyTurnResult(
          makeRunResult({ text: "Delegate turn failed (google): 500 Internal Server Error" }),
        ),
      ).toEqual({ outcome: "success" });
    });

    it("KPR-350 §D5: nested delegate turn is session-less — no sessionId in, no persist out", async () => {
      const runner = await setupOpenAIParent();
      const setsBefore = sessionStore.set.mock.calls.length;
      mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ text: "out", sessionId: "resp-nested-discard" }));
      await call(runner);
      const nestedReq = mockOpenAIRunTurn.mock.calls.at(-1)![0];
      expect(nestedReq.sessionId).toBeUndefined(); // ⇒ previousResponseId undefined on the nested run
      expect(sessionStore.set.mock.calls.length).toBe(setsBefore); // result id discarded, store untouched
    });

    // -------------------------------------------------------------------------
    // KPR-352 §D6: nested delegate turns on a gemini-routed parent. The
    // partition routes claude-subagent ⇒ requires-hive-bridge for gemini
    // (Task 1), so the parent's bridge synthesizes Task and the manager's
    // nested branch now constructs a session-less GeminiInteractionsAdapter —
    // the pre-352 "provider does not execute tools" return is inverted.
    // -------------------------------------------------------------------------
    async function setupGeminiParent(cfg: Partial<AgentConfig> = {}): Promise<DelegateTurnRunner> {
      registry._agents.set(
        "gp",
        makeAgentConfig({
          id: "gp",
          name: "TestAgent",
          model: "gemini/gemini-3.6-flash:high",
          delegateServers: ["google"],
          coreServers: [],
          ...cfg,
        }),
      );
      mockRunnerToolInventory.mockReturnValue([makeSubagentEntry()]);
      mockConversationIndex.mockResolvedValue(undefined);
      await manager.spawnTurn(makeSmsCtx({ agentId: "gp" }));
      return mockGeminiConstructor.mock.calls[0]![0].assembly.delegateTurnRunner as DelegateTurnRunner;
    }

    const nestedGeminiConstructions = () =>
      mockGeminiConstructor.mock.calls.filter((c) => c[0].name === NESTED_NAME);

    it("(KPR-352 nested-1) gemini parent: bridge invocation constructs a nested gemini adapter (inverts the pre-352 not-called path)", async () => {
      const runner = await setupGeminiParent();
      const constructionsBefore = mockGeminiConstructor.mock.calls.length;
      mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ text: "delegate output" }));

      expect(await call(runner)).toBe("delegate output");

      // Inversion pin: the gemini constructor fired a SECOND time (pre-352 this
      // path returned "provider does not execute tools" without constructing).
      expect(mockGeminiConstructor.mock.calls.length).toBe(constructionsBefore + 1);
      const nested = nestedGeminiConstructions();
      expect(nested.length).toBe(1);
      const opts = nested[0]![0];
      expect(opts.name).toBe(NESTED_NAME);
      expect(opts.model).toBe("gemini-3.6-flash"); // parent route's model
      expect(opts.apiKey).toBe("test-gemini-key"); // config apiKey threaded
      expect(opts.reasoningEffort).toBe("high"); // parent route's effort
      expect(opts.assembly.instructions).toBe(buildGenericDelegatePrompt("google"));
      // Structural depth-1: nested assembly carries no delegate runner.
      expect(opts.assembly.delegateTurnRunner).toBeUndefined();
      expect(opts.assembly.omittedTools).toEqual([]);
    });

    it("(KPR-352 nested-2) gemini nested turn is session-less — no sessionId in, discarded out", async () => {
      const runner = await setupGeminiParent();
      const setsBefore = sessionStore.set.mock.calls.length;
      mockGeminiRunTurn.mockResolvedValueOnce(
        makeRunResult({ text: "out", sessionId: "interactions/discard-me" }),
      );
      await call(runner);
      const nestedReq = mockGeminiRunTurn.mock.calls.at(-1)![0];
      expect(nestedReq.sessionId).toBeUndefined(); // fresh chain — no previous_interaction_id
      expect(sessionStore.set.mock.calls.length).toBe(setsBefore); // result id discarded, store untouched
    });

    it("(KPR-352 nested-3) gemini nested fault stays in tool text; breaker-invisible (parent records once)", async () => {
      const runner = await setupGeminiParent();
      // The parent turn recorded on the breaker before this spy is installed;
      // the nested fault must add no record → breaker sees exactly the parent.
      const recordSpy = vi.spyOn(manager.circuitBreakers, "record");
      mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ error: "500 Internal Server Error", text: "" }));

      expect(await call(runner)).toBe("Delegate turn failed (google): 500 Internal Server Error");
      expect(recordSpy).not.toHaveBeenCalled();
    });

    it("(KPR-352 nested-4) gemini nested spawn holds a budget slot then releases in finally", async () => {
      const runner = await setupGeminiParent();
      let resolveNested!: (v: unknown) => void;
      mockGeminiRunTurn.mockImplementationOnce(() => new Promise((r) => { resolveNested = r; }));

      const p = call(runner);
      await Promise.resolve();
      expect(activeSlots("gp")).toBe(1); // slot held during the hanging nested turn
      resolveNested(makeRunResult({ text: "x" }));
      await p;
      expect(activeSlots("gp")).toBe(0); // released in finally
    });
  });

  describe("round-1 reaction shaping (KPR-389 D2/D3)", () => {
    beforeEach(() => {
      mockConversationIndex.mockResolvedValue(undefined);
    });

    it("T1: round-1 claude effort-capable — classifier skipped, effort low, static-tier base clamped (router on)", async () => {
      (appConfig as any).modelRouter.enabled = true;
      try {
        await manager.spawnTurn(makeConfCtx(1));
        expect(routeModel).not.toHaveBeenCalled();
        const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
        // sonnet base {300s, 50, 5} → min() clamp
        expect(resourceLimits).toEqual({ maxTurns: 6, timeoutMs: 120_000, budgetUsd: 5 });
        expect(effort).toBe("low");
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    it("T1b: round-1 claude router OFF — legacy triple is the base; tighter operator maxTurns wins the min()", async () => {
      registry._agents.set(
        "agent-tight",
        makeAgentConfig({ id: "agent-tight", name: "Tight", model: "claude-sonnet-4-6", maxTurns: 3 }),
      );
      await manager.spawnTurn(makeConfCtx(1, "agent-tight"));
      expect(routeModel).not.toHaveBeenCalled();
      const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
      // base = { maxTurns: 3, timeoutMs: 300_000 (undefined ?? default), budgetUsd: 10 }
      expect(resourceLimits).toEqual({ maxTurns: 3, timeoutMs: 120_000, budgetUsd: 10 });
      expect(effort).toBe("low");
    });

    it("E7: round-1 haiku agent — caps clamp, no effort pin (undeliverable, same as today)", async () => {
      await manager.spawnTurn(makeConfCtx(1, "agent-a")); // agent-a = haiku default fixture
      expect(routeModel).not.toHaveBeenCalled();
      const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
      expect(resourceLimits).toEqual({ maxTurns: 6, timeoutMs: 120_000, budgetUsd: 10 });
      expect(effort).toBeUndefined();
    });

    it("KPR-422: round-1 claude router ON — a top-level timeoutMs tighter than the reaction cap wins the min()", async () => {
      (appConfig as any).modelRouter.enabled = true;
      try {
        registry._agents.set(
          "agent-tight-t",
          makeAgentConfig({ id: "agent-tight-t", name: "TightT", model: "claude-sonnet-4-6", timeoutMs: 60_000 }),
        );
        await manager.spawnTurn(makeConfCtx(1, "agent-tight-t"));
        const [, , , , resourceLimits] = mockRunnerSend.mock.calls[0]!;
        // base = resolveResourceLimits(sonnet, undefined, 60_000) → timeoutMs
        // 60_000 (pre-KPR-422 the base was the 300s tier default and the clamp
        // landed on 120s) → min(60_000, REACTION_TIMEOUT_MS) = 60_000.
        expect(resourceLimits).toEqual({ maxTurns: 6, timeoutMs: 60_000, budgetUsd: 5 });
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    it("T2: round-0 conference turn untouched — classifier runs, static-tier limits, classifier effort (negative pin, D3)", async () => {
      (appConfig as any).modelRouter.enabled = true;
      try {
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult({ effort: "high" }));
        await manager.spawnTurn(makeConfCtx(0));
        expect(routeModel).toHaveBeenCalledTimes(1);
        const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
        expect(resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
        expect(effort).toBe("high");
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    it("T2b: non-conference control — no meta key ⇒ branch not taken ⇒ today's path byte-unchanged", async () => {
      (appConfig as any).modelRouter.enabled = true;
      try {
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult({ effort: "medium" }));
        await manager.spawnTurn(makeSmsCtx({ agentId: "agent-s" }));
        expect(routeModel).toHaveBeenCalledTimes(1);
        const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
        expect(resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
        expect(effort).toBe("medium");
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    it("T3: Lane B (codex) round-1 — clamped agent-def limits, request.effort undefined; round-0 byte-identical to the Lane B branch", async () => {
      registry._agents.set(
        "codex-conf",
        makeAgentConfig({ id: "codex-conf", name: "CodexConf", model: "codex/gpt-5.5:medium", coreServers: [] }),
      );
      await manager.spawnTurn(makeConfCtx(1, "codex-conf"));
      const req1 = mockCodexRunTurn.mock.calls[0]![0];
      expect(req1.resourceLimits).toEqual({ maxTurns: 6, timeoutMs: 120_000, budgetUsd: 10 });
      expect(req1.effort).toBeUndefined();

      await manager.spawnTurn(makeConfCtx(0, "codex-conf"));
      const req0 = mockCodexRunTurn.mock.calls[1]![0];
      expect(req0.resourceLimits).toEqual({ maxTurns: 25, timeoutMs: 300_000, budgetUsd: 10 });
    });
  });

  describe("static per-agent effort field (KPR-430)", () => {
    const FABLE_TIER_LIMITS = { maxTurns: 50, timeoutMs: 300_000, budgetUsd: 5 }; // modelToTier(fable) → sonnet

    function setFable(effort?: "low" | "medium" | "high" | "xhigh" | "max", id = "agent-fx") {
      registry._agents.set(id, makeAgentConfig({ id, name: "Fx", model: "claude-fable-5-1", ...(effort ? { effort } : {}) }));
      return id;
    }
    const staticWarns = () =>
      mockLogWarn.mock.calls.filter((c) => String(c[0]).includes("Static effort field set but the agent model cannot receive"));

    beforeEach(() => {
      mockConversationIndex.mockResolvedValue(undefined);
      // clearAllMocks does not drain a queued mockResolvedValueOnce; reset so a
      // deliberately-unconsumed queue entry cannot leak into the next row.
      vi.mocked(routeModel).mockReset();
    });
    afterEach(() => {
      (appConfig as any).modelRouter.enabled = false;
    });

    it("T1: static set, router on — classifier skipped, static delivered, static-tier limits, cost 0, source static", async () => {
      (appConfig as any).modelRouter.enabled = true;
      vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult({ effort: "low" })); // would be consumed only if the classifier ran
      const id = setFable("max");
      await manager.spawnTurn(makeSmsCtx({ agentId: id }));
      expect(routeModel).not.toHaveBeenCalled();
      const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
      expect(effort).toBe("max");
      expect(resourceLimits).toEqual(FABLE_TIER_LIMITS);
      const doc = turnTelemetryStore.record.mock.calls[0]![0];
      expect(doc.effort).toBe("max");
      expect(doc.effortSource).toBe("static");
    });

    it("T2: static absent, router on — five shaping fields unchanged; source router only when the classifier returned an effort", async () => {
      (appConfig as any).modelRouter.enabled = true;
      const id = setFable(undefined);

      vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult({ effort: "high" }));
      await manager.spawnTurn(makeSmsCtx({ agentId: id, threadId: "sms:line-1:t2a" }));
      expect(routeModel).toHaveBeenCalledTimes(1);
      const [, , , , limitsA, , effortA] = mockRunnerSend.mock.calls[0]!;
      expect(effortA).toBe("high");
      expect(limitsA).toEqual(FABLE_TIER_LIMITS);
      expect(turnTelemetryStore.record.mock.calls[0]![0]).toMatchObject({ effort: "high", effortSource: "router" });

      // no-key / fallback shape: routeModel returns no effort ⇒ no effort, no source
      vi.mocked(routeModel).mockResolvedValueOnce({ costUsd: 0, durationMs: 0, method: "no-key" });
      await manager.spawnTurn(makeSmsCtx({ agentId: id, threadId: "sms:line-1:t2b" }));
      const [, , , , limitsB, , effortB] = mockRunnerSend.mock.calls[1]!;
      expect(effortB).toBeUndefined();
      expect(limitsB).toEqual(FABLE_TIER_LIMITS);
      const docB = turnTelemetryStore.record.mock.calls[1]![0];
      expect(docB).not.toHaveProperty("effort");
      expect(docB).not.toHaveProperty("effortSource");
    });

    it("T3: router-off and system-sender paths deliver the static value with resourceLimits undefined", async () => {
      const id = setFable("xhigh");
      (appConfig as any).modelRouter.enabled = false;
      await manager.spawnTurn(makeSmsCtx({ agentId: id, threadId: "sms:line-1:t3a" }));
      expect(mockRunnerSend.mock.calls[0]![4]).toBeUndefined();
      expect(mockRunnerSend.mock.calls[0]![6]).toBe("xhigh");

      (appConfig as any).modelRouter.enabled = true;
      const sys = makeWorkItem({
        text: "execute your scheduled digest task",
        sender: "system",
        threadId: "sms:line-1:t3b",
        source: { kind: "sms", id: "line-1", label: "May" },
      });
      await manager.spawnTurn(makeSmsCtx({ agentId: id, threadId: "sms:line-1:t3b", workItem: sys }));
      expect(routeModel).not.toHaveBeenCalled();
      expect(mockRunnerSend.mock.calls[1]![4]).toBeUndefined();
      expect(mockRunnerSend.mock.calls[1]![6]).toBe("xhigh");
      expect(turnTelemetryStore.record.mock.calls[1]![0]).toMatchObject({ effort: "xhigh", effortSource: "static" });
    });

    it("T4: voice path delivers nothing even with the field set (carve-out)", async () => {
      (appConfig as any).modelRouter.enabled = true;
      const id = setFable("max");
      const item = makeWorkItem({ text: "voice turn", source: { kind: "ws", id: "voice-1", label: "voice" } });
      await manager.spawnTurn({ ...makeSmsCtx({ agentId: id, threadId: "voice:1", workItem: item }), channel: "voice" as const });
      expect(routeModel).not.toHaveBeenCalled();
      expect(mockRunnerSend.mock.calls[0]![4]).toBeUndefined();
      expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();
      expect(staticWarns()).toHaveLength(0);
    });

    it("T5a: haiku agent with the field — nothing delivered, exactly one warn across two turns, envelope unchanged", async () => {
      (appConfig as any).modelRouter.enabled = true;
      registry._agents.set("agent-hx", makeAgentConfig({ id: "agent-hx", name: "Hx", model: "claude-haiku-4-5", effort: "max" }));
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-hx", threadId: "sms:line-1:t5a1" }));
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-hx", threadId: "sms:line-1:t5a2" }));
      expect(routeModel).not.toHaveBeenCalled();
      expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();
      expect(mockRunnerSend.mock.calls[1]![6]).toBeUndefined();
      expect(mockRunnerSend.mock.calls[0]![4]).toEqual({ maxTurns: 20, timeoutMs: 120_000, budgetUsd: 1 });
      expect(staticWarns()).toHaveLength(1);
      expect(turnTelemetryStore.record.mock.calls[0]![0]).not.toHaveProperty("effortSource");
    });

    it("T5b: off-catalog claude id with the field — nothing delivered, one static warn (plus the KPR-338 off-catalog warn)", async () => {
      (appConfig as any).modelRouter.enabled = true;
      mockSupportsEffort.mockReturnValue(false);
      registry._agents.set("agent-ox", makeAgentConfig({ id: "agent-ox", name: "Ox", model: "claude-mythos-9", effort: "high" }));
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-ox", threadId: "sms:line-1:t5b1" }));
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-ox", threadId: "sms:line-1:t5b2" }));
      expect(routeModel).not.toHaveBeenCalled();
      expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();
      expect(staticWarns()).toHaveLength(1);
    });

    it("T5c: non-adopter makes no supportsEffort call on the router-off path (inverse lens)", async () => {
      (appConfig as any).modelRouter.enabled = false;
      const id = setFable(undefined);
      mockSupportsEffort.mockClear();
      await manager.spawnTurn(makeSmsCtx({ agentId: id }));
      expect(mockSupportsEffort).not.toHaveBeenCalled();
      expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();
    });

    it("T6: round-1 reaction with the field max — pin wins (low), source pin, classifier not called", async () => {
      (appConfig as any).modelRouter.enabled = true;
      const id = setFable("max");
      await manager.spawnTurn(makeConfCtx(1, id));
      expect(routeModel).not.toHaveBeenCalled();
      const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
      expect(effort).toBe("low");
      expect(resourceLimits).toEqual({ maxTurns: 6, timeoutMs: 120_000, budgetUsd: 5 });
      expect(turnTelemetryStore.record.mock.calls[0]![0]).toMatchObject({ effort: "low", effortSource: "pin" });
    });

    it("T6b: round-0 conference turn with the field — static wins, classifier skipped", async () => {
      (appConfig as any).modelRouter.enabled = true;
      vi.mocked(routeModel).mockResolvedValueOnce(makeRouterResult({ effort: "low" }));
      const id = setFable("max");
      await manager.spawnTurn(makeConfCtx(0, id));
      expect(routeModel).not.toHaveBeenCalled();
      expect(mockRunnerSend.mock.calls[0]![6]).toBe("max");
    });

    it("D6: effortSource can never land without effort — the stamp nests the source inside the effort spread", async () => {
      const id = setFable(undefined);
      const prepareSpawnSpy = vi
        .spyOn(manager as unknown as { prepareSpawn: (ctx: unknown) => Promise<unknown> }, "prepareSpawn")
        .mockResolvedValueOnce({
          prompt: "hand-built",
          route: { provider: "claude", model: "claude-fable-5-1" },
          resourceLimits: undefined,
          routerCostUsd: 0,
          effortOverride: undefined,
          effortSource: "static", // deliberately inconsistent — a future shaping-site bug
        });
      try {
        await manager.spawnTurn(makeSmsCtx({ agentId: id }));
      } finally {
        prepareSpawnSpy.mockRestore();
      }
      expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();
      const doc = turnTelemetryStore.record.mock.calls[0]![0];
      expect(doc).not.toHaveProperty("effort");
      expect(doc).not.toHaveProperty("effortSource");
    });
  });

  describe("turn-kind telemetry (KPR-389 D6)", () => {
    function makeActivityLogger() {
      return { record: vi.fn() };
    }
    function buildManager(activityLogger: { record: ReturnType<typeof vi.fn> }) {
      return new AgentManager(
        registry as any,
        memoryManager as any,
        sessionStore as any,
        undefined as any,
        turnTelemetryStore as any,
        activityLogger as any,
      );
    }

    beforeEach(() => {
      mockConversationIndex.mockResolvedValue(undefined);
    });

    it("T7: round-1 conference turn stamps round, injectionMode, resumedSession, perf split, effort — telemetry AND activity", async () => {
      const activityLogger = makeActivityLogger();
      const mgr = buildManager(activityLogger);
      const { workItem, threadId } = makeConfCtx(1, "agent-s", { conferenceInjectionMode: "delta" });
      // Seed a resumable same-provider session so runWorkItemTurn resolves it
      // (C7: resumedSession = the finalized attempt launched with a handle).
      sessionStore._sessions.set(`agent-s:${threadId}`, { sessionId: "sess-live", provider: "claude" });

      await mgr.runWorkItemTurn("agent-s", workItem);

      expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
      const doc = turnTelemetryStore.record.mock.calls[0]![0];
      expect(doc).toMatchObject({
        conferenceRound: 1,
        injectionMode: "delta",
        resumedSession: true,
        durationMs: 1000, // makeRunResult defaults
        llmMs: 800,
        toolMs: 200,
        toolCalls: 1,
        effort: "low", // the D2 pin, visible in telemetry
      });
      expect(activityLogger.record.mock.calls[0]![0].conferenceRound).toBe(1);
    });

    it("T7b: plain DM turn — perf fields present, conference keys ABSENT", async () => {
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-s" }));
      const doc = turnTelemetryStore.record.mock.calls[0]![0];
      expect(doc.durationMs).toBe(1000);
      expect(doc.resumedSession).toBe(false);
      expect(doc).not.toHaveProperty("conferenceRound");
      expect(doc).not.toHaveProperty("injectionMode");
      expect(doc).not.toHaveProperty("effort"); // router off ⇒ no override on a DM turn
    });

    it("T7c: an aborted (clamp-killed) reaction WITH real spend records round-tagged telemetry (KPR-401 relaxed gate) and lands round-tagged in the activity log", async () => {
      // KPR-401 refined the D6 gate from `!aborted` to `!aborted || hadUsage`
      // (see the dedicated "aborted-turn observability (KPR-401)" describe
      // below for the provider-agnostic coverage) — a clamp-killed round-1
      // reaction realistically made SOME progress before hitting the tight
      // maxTurns:6/timeoutMs:120s ceiling, so makeRunResult's default nonzero
      // usage is the representative case: telemetry now records it, sparse
      // aborted:true, still round-tagged.
      const activityLogger = makeActivityLogger();
      const mgr = buildManager(activityLogger);
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ aborted: true, text: "", timedOut: true }));

      await mgr.runWorkItemTurn("agent-s", makeConfCtx(1, "agent-s").workItem);

      expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
      const doc = turnTelemetryStore.record.mock.calls[0]![0];
      expect(doc.aborted).toBe(true);
      expect(doc.conferenceRound).toBe(1);
      expect(activityLogger.record.mock.calls[0]![0].conferenceRound).toBe(1); // kills stay measurable (C5 volume counter)
    });
  });

  describe("conferenceRoundOf (KPR-389 D1)", () => {
    it.each([
      ["round 0", { conferenceRound: 0 }, 0],
      ["round 1", { conferenceRound: 1 }, 1],
      ['malformed string "1"', { conferenceRound: "1" }, undefined],
      ["out-of-range 2", { conferenceRound: 2 }, undefined],
      ["explicit undefined", { conferenceRound: undefined }, undefined],
    ])("%s ⇒ %s", (_label, meta, expected) => {
      expect(conferenceRoundOf(makeWorkItem({ meta: meta as Record<string, unknown> }))).toBe(expected);
    });

    it("missing meta ⇒ undefined (fail-open to full-resource turn, E10)", () => {
      expect(conferenceRoundOf(makeWorkItem())).toBeUndefined();
    });
  });
});

describe("isStaleServerHandleError (KPR-350 §D3) — narrowness matrix", () => {
  const MUST_MATCH = [
    "Previous response with id 'resp_abc123' not found.",
    "previous response not found",
    "Previous response resp_9 has expired",
    "400 invalid_request_error: previous_response_id 'resp_x' not found",
    "previous_response_id is invalid",
    "Previous response with id 'resp_x' no longer exists",
    // KPR-352: the gemini adapter's hive-owned stale-resume sentinel (matched
    // regardless of the embedded 400/403/404 status the live API returns).
    "gemini interaction resume rejected (status 400): the referenced previous_interaction_id is invalid",
    "gemini interaction resume rejected (status 403): You do not have permission to access the content",
  ];
  const MUST_NOT_MATCH = [
    "404 Not Found",
    "getaddrinfo ENOTFOUND api.openai.com",
    "model not found",
    "tool not found",
    "conversation not found",
    "error_during_execution",
    "401 Unauthorized",
    "No response received from previous request",
    "",
    // KPR-352: a genuine gemini fault WITHOUT the resume-rejected sentinel is an
    // ordinary provider fault — never tagged (adapter's generic-400 guard).
    "Gemini interaction request failed (403): You do not have permission to access the content",
    "Gemini interaction request failed (400): invalid request payload",
  ];
  it.each(MUST_MATCH)("matches: %s", (s) => expect(isStaleServerHandleError(s)).toBe(true));
  it.each(MUST_NOT_MATCH)("does NOT match: %s", (s) => expect(isStaleServerHandleError(s)).toBe(false));
  it("is disjoint from the auth-rebuild sentinel on every stale string (arm independence)", () => {
    // isAuthRebuildResumeError is module-private; assert via its published
    // alternates: none of the stale strings contain an auth sentinel.
    const AUTH = /resolve authentication|credentials\.json|not authenticated|401 Unauthorized|ANTHROPIC_API_KEY|authToken/i;
    for (const s of MUST_MATCH) expect(AUTH.test(s)).toBe(false);
  });
});

// ── KPR-390: meeting worker pool handshake ───────────────────────────────────
describe("AgentManager — KPR-390 worker pool handshake", () => {
  let registry: ReturnType<typeof makeMockRegistry>;
  let sessionStore: ReturnType<typeof makeMockSessionStore>;
  let memoryManager: ReturnType<typeof makeMockMemoryManager>;
  let manager: AgentManager;

  /** In-process MCP factories only close over these — no-op stubs suffice. */
  function makeFakeDb(): any {
    const col = {
      findOne: vi.fn(async () => null),
      find: vi.fn(() => ({
        project: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
        toArray: vi.fn(async () => []),
        sort: vi.fn(() => ({ limit: vi.fn(() => ({ toArray: vi.fn(async () => []) })) })),
      })),
      insertOne: vi.fn(async () => ({})),
      updateOne: vi.fn(async () => ({})),
      deleteOne: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
      createIndex: vi.fn(async () => "idx"),
      countDocuments: vi.fn(async () => 0),
    };
    return { collection: vi.fn(() => col) };
  }

  function makeFakePool() {
    return {
      bindManager: vi.fn(),
      abortForBoss: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSupportsEffort.mockImplementation((m: string) => !m.includes("haiku"));
    registry = makeMockRegistry();
    sessionStore = makeMockSessionStore();
    memoryManager = makeMockMemoryManager();
    // Fixture requirement (plan G5 r2): a real fake `db` — every in-process
    // block in buildInProcessServers gates on `this.db`, so a db-less manager
    // makes the worker-mode pin below vacuously green.
    manager = new AgentManager(
      registry as any,
      memoryManager as any,
      sessionStore as any,
      makeFakeDb(),
      makeMockTurnTelemetryStore() as any,
    );
  });

  it("setWorkerPool binds hooks whose breakerStateFor proxies the breaker registry", () => {
    const pool = makeFakePool();
    manager.setWorkerPool(pool as any);
    expect(pool.bindManager).toHaveBeenCalledTimes(1);
    const hooks = pool.bindManager.mock.calls[0][0];
    const spy = vi.spyOn(manager.circuitBreakers, "stateFor").mockReturnValue(null);
    expect(hooks.breakerStateFor("claude")).toBeNull();
    expect(spy).toHaveBeenCalledWith("claude");
    spy.mockRestore();
  });

  it("buildWorkerAdapter builds a worker-mode runner: no team/schedule/team-roster, no worker-pool (end-to-end)", async () => {
    // The suite mocks AgentRunner globally; this pin needs the REAL runner so
    // the suppression flag is observed on the actual built server set (a
    // mock-shaped assertion would only test the mock).
    const actual = await vi.importActual<typeof import("./agent-runner.js")>("./agent-runner.js");
    vi.mocked(AgentRunner).mockImplementationOnce(function (...args: any[]) {
      return new (actual.AgentRunner as any)(...args);
    } as any);
    const pool = makeFakePool();
    manager.setWorkerPool(pool as any);
    const hooks = pool.bindManager.mock.calls[0][0];

    const workerConfig: AgentConfig = {
      id: "worker",
      name: "Worker",
      model: "sonnet",
      channels: [],
      passiveChannels: [],
      keywords: [],
      isDefault: false,
      schedule: [],
      budgetUsd: 1,
      maxTurns: 25,
      icon: "",
      coreServers: ["memory"],
      delegateServers: [],
      soul: "",
      systemPrompt: "worker",
      autonomy: { externalComms: false, codeTask: false, codeAccess: false },
    } as unknown as AgentConfig;

    const adapter = hooks.buildWorkerAdapter(workerConfig);
    expect(adapter.provider).toBe("claude");
    const runner = (adapter as unknown as { runner: AgentRunner }).runner;
    const keys = Object.keys(runner.buildInProcessServers());
    expect(keys).toContain("memory");
    for (const name of ["team", "schedule", "team-roster", "worker-pool"]) {
      expect(keys).not.toContain(name);
    }
  });

  it("KPR-409 T7: the scribe's coreServers:[] builds an EMPTY server set and a clean inventory (end-to-end)", async () => {
    // Mirrors Part A's T3 posture on the scribe's ACTUAL role-params value:
    // `coreServers: []` (meeting-scribe.ts C22), not a non-empty array. The
    // scribe/pool suites assert the config array against a MOCKED
    // buildWorkerAdapter — nothing there observes what [] actually BUILDS. If
    // suppressAutoInjectedServers were ever dropped, [] silently re-gains
    // team/schedule/team-roster (+ the LIVE skill-author stdio server on the
    // inventory surface) and containment evaporates with those tests green.
    const actual = await vi.importActual<typeof import("./agent-runner.js")>("./agent-runner.js");
    vi.mocked(AgentRunner).mockImplementationOnce(function (...args: any[]) {
      return new (actual.AgentRunner as any)(...args);
    } as any);
    const pool = makeFakePool();
    manager.setWorkerPool(pool as any);
    const hooks = pool.bindManager.mock.calls[0][0];

    const scribeConfig: AgentConfig = {
      id: "boss",
      name: "Boss",
      model: "sonnet",
      channels: [],
      passiveChannels: [],
      keywords: [],
      isDefault: false,
      schedule: [],
      budgetUsd: 1,
      maxTurns: 4,
      icon: "",
      coreServers: [], // the scribe's real role-params value
      delegateServers: [],
      soul: "",
      systemPrompt: "scribe",
      autonomy: { externalComms: false, codeTask: false, codeAccess: false },
    } as unknown as AgentConfig;

    const runner = (
      hooks.buildWorkerAdapter(scribeConfig) as unknown as { runner: AgentRunner }
    ).runner;
    expect(Object.keys(runner.buildInProcessServers())).toEqual([]);
    const inventory = runner.buildToolTransportInventory().map((e) => e.name);
    for (const name of ["team", "schedule", "team-roster", "skill-author"]) {
      expect(inventory).not.toContain(name);
    }
  });

  it("stopAgent aborts that boss's live workers", () => {
    const pool = makeFakePool();
    manager.setWorkerPool(pool as any);
    manager.stopAgent("agent-a");
    expect(pool.abortForBoss).toHaveBeenCalledWith("agent-a");
  });
});
