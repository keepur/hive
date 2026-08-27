import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "./dispatcher.js";
import type { WorkItem } from "../types/work-item.js";
import { ProviderCircuitOpenError } from "../agents/provider-circuit-breaker.js";
import {
  OutageEpisodeTracker,
  OUTAGE_NOTICE_DEFAULT,
  OUTAGE_OVERFLOW_NOTICE_DEFAULT,
} from "../outage/outage-notices.js";
import {
  DEADLINE_NOTICE_DEFAULT,
  DEADLINE_TERMINAL_NOTICE_DEFAULT,
  DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT,
  deadlineContinuationWrap,
} from "./deadline-continuation.js";

// KPR-220 Phase 1: shared mock so tests can assert what dispatcher logs to
// `info` (e.g., per-turn telemetry breakdown — llmMs/toolMs/toolCalls/etc).
// vi.hoisted is required: vi.mock factories run before top-level statements.
// KPR-402: mockLogWarn added for the silent-cell warn-log pins (T5/T14). No
// pre-existing row asserts warn, so the shared mock is inert for them.
const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({ mockLogInfo: vi.fn(), mockLogWarn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// KPR-220 Phase 9: dispatcher no longer imports `config` — per-turn is
// unconditional. The mock is retained as a no-op so any test that still
// references it (or any indirect import path) gets a benign shape.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workItemCounter = 0;

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  workItemCounter++;
  return {
    id: `msg-${workItemCounter}-${Date.now()}`,
    text: "hello",
    source: { kind: "slack", id: "C999", label: "random" },
    sender: "user1",
    timestamp: new Date(),
    ...overrides,
  };
}

function makeMockRegistry() {
  const agents = new Map<string, any>();
  agents.set("executive-assistant", {
    id: "executive-assistant",
    name: "Rae",
    channels: ["general", "agent-rae"],
    passiveChannels: ["biz"],
    keywords: [],
    homeBase: "agent-rae",
    isDefault: true,
  });
  agents.set("chief-of-staff", {
    id: "chief-of-staff",
    name: "Mokie",
    channels: ["agent-mokie"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    disabled: true,
  });
  agents.set("jasper", {
    id: "jasper",
    name: "Jasper",
    channels: ["agent-jasper"],
    passiveChannels: [],
    keywords: ["engineering", "deploy"],
    isDefault: false,
  });
  agents.set("river", {
    id: "river",
    name: "River",
    channels: ["agent-river"],
    passiveChannels: [],
    keywords: ["marketing"],
    isDefault: false,
  });
  agents.set("production-support", {
    id: "production-support",
    name: "Sige",
    channels: ["agent-sige"],
    passiveChannels: [],
    keywords: [],
    catches: ["dodi-shop"],
    homeBase: "agent-sige",
    isDefault: false,
  });
  agents.set("floor-agent", {
    id: "floor-agent",
    name: "Floory",
    channels: ["agent-floor"],
    passiveChannels: [],
    keywords: [],
    homeBase: "agent-floor",
    isDefault: false,
    floorCritical: true,
  });

  return {
    get: (id: string) => agents.get(id),
    getAll: () => Array.from(agents.values()),
    findByChannel: (ch: string) => Array.from(agents.values()).find((a) => !a.disabled && a.channels.includes(ch)),
    findByOrigin: (slug: string) => {
      for (const a of Array.from(agents.values())) {
        if (a.disabled) continue;
        if ((a.catches ?? []).includes(slug)) return a;
      }
      return undefined;
    },
    findByKeyword: (text: string) => {
      const lower = text.toLowerCase();
      return Array.from(agents.values()).find(
        (a) => !a.disabled && a.keywords.some((kw: string) => new RegExp(`\\b${kw}\\b`).test(lower)),
      );
    },
    findByName: (text: string) => {
      const matchesName = (name: string, t: string) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`(?:^|hey\\s+|@)${escaped}\\b|\\b${escaped}[,:]`, "i");
        return pattern.test(t);
      };
      return Array.from(agents.values()).find((a) => {
        if (a.disabled) return false;
        if (matchesName(a.name, text)) return true;
        if (a.name.includes(" ")) {
          const firstName = a.name.split(" ")[0];
          if (matchesName(firstName, text)) return true;
        }
        for (const alias of a.aliases ?? []) {
          if (matchesName(alias, text)) return true;
        }
        return false;
      });
    },
    findAllByName: (text: string) => {
      const matchesName = (name: string, t: string) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`(?:^|hey\\s+|@)${escaped}\\b|\\b${escaped}[,:]`, "i");
        return pattern.test(t);
      };
      return Array.from(agents.values()).filter((a) => {
        if (a.disabled) return false;
        if (matchesName(a.name, text)) return true;
        if (a.name.includes(" ")) {
          const firstName = a.name.split(" ")[0];
          if (matchesName(firstName, text)) return true;
        }
        for (const alias of a.aliases ?? []) {
          if (matchesName(alias, text)) return true;
        }
        return false;
      });
    },
    isPassiveChannel: (ch: string) =>
      Array.from(agents.values()).some((a) => !a.disabled && a.passiveChannels.includes(ch)),
    getDefault: () => agents.get("executive-assistant"),
  };
}

function makeMockAgentManager() {
  return {
    findAgentForThread: vi.fn().mockResolvedValue(null),
    findAgentsForThread: vi.fn().mockResolvedValue([]),
    spawnTurn: vi.fn().mockResolvedValue({
      finalMessage: "turn response",
      newSessionId: "s2",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 0,
        costUsd: 0.01,
        durationMs: 800,
      },
      errors: [],
      llmMs: 0,
      toolMs: 0,
      toolCalls: 0,
      toolSummary: null,
      streamed: false,
      compactions: 0,
    }),
    runWorkItemTurn: vi.fn().mockResolvedValue({
      finalMessage: "turn response",
      newSessionId: "s2",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 0,
        costUsd: 0.01,
        durationMs: 800,
      },
      errors: [],
      llmMs: 0,
      toolMs: 0,
      toolCalls: 0,
      toolSummary: null,
      streamed: false,
      compactions: 0,
    }),
    getSessionStore: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue(undefined),
    }),
    providerFor: vi.fn().mockReturnValue("claude"),
    // KPR-403: distinctive non-default value so stamp assertions are unambiguous.
    turnDeadlineUpperBoundMs: vi.fn().mockReturnValue(900_000),
    circuitBreakers: { stateFor: vi.fn().mockReturnValue(null) },
  };
}

function makeMockHealthReporter() {
  return {
    formatForSlack: vi.fn().mockReturnValue("All systems operational"),
  };
}

function makeMockAdapter() {
  return {
    id: "slack",
    kind: "slack" as const,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue(undefined),
    onProcessingStart: vi.fn().mockResolvedValue(undefined),
    onProcessingEnd: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Status pattern tests
// ---------------------------------------------------------------------------

describe("status patterns", () => {
  const STATUS_PATTERNS = [
    /^status\??$/i,
    /^how.{0,20}(everyone|agents?|doing|running)/i,
    /^health\??$/i,
    /^system status/i,
  ];

  function isStatusQuery(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length <= 80 && STATUS_PATTERNS.some((p) => p.test(trimmed));
  }

  it("matches 'status'", () => expect(isStatusQuery("status")).toBe(true));
  it("matches 'status?'", () => expect(isStatusQuery("status?")).toBe(true));
  it("matches 'Status'", () => expect(isStatusQuery("Status")).toBe(true));
  it("matches 'health'", () => expect(isStatusQuery("health")).toBe(true));
  it("matches 'health?'", () => expect(isStatusQuery("health?")).toBe(true));
  it("matches 'how is everyone'", () => expect(isStatusQuery("how is everyone")).toBe(true));
  it("matches 'how are the agents doing'", () => expect(isStatusQuery("how are the agents doing")).toBe(true));
  it("matches 'how is everyone running'", () => expect(isStatusQuery("how is everyone running")).toBe(true));
  it("matches 'system status'", () => expect(isStatusQuery("system status")).toBe(true));
  it("does NOT match long messages", () => {
    expect(isStatusQuery("status " + "x".repeat(100))).toBe(false);
  });
  it("does NOT match regular messages containing 'status'", () => {
    expect(isStatusQuery("what is the status of the Johnson project")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-response pattern tests
// ---------------------------------------------------------------------------

describe("non-response patterns", () => {
  const NON_RESPONSE_PATTERNS = [
    /^no response (requested|needed|required|necessary)\.?$/i,
    /^\(no response\)$/i,
    /^n\/a\.?$/i,
  ];

  function isNonResponse(text: string): boolean {
    return NON_RESPONSE_PATTERNS.some((p) => p.test(text.trim()));
  }

  it("matches 'no response needed'", () => expect(isNonResponse("no response needed")).toBe(true));
  it("matches 'No response requested.'", () => expect(isNonResponse("No response requested.")).toBe(true));
  it("matches '(no response)'", () => expect(isNonResponse("(no response)")).toBe(true));
  it("matches 'N/A'", () => expect(isNonResponse("N/A")).toBe(true));
  it("matches 'n/a.'", () => expect(isNonResponse("n/a.")).toBe(true));
  it("does NOT match real responses", () => {
    expect(isNonResponse("No response is needed for the other ticket")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher routing tests
// ---------------------------------------------------------------------------

describe("Dispatcher routing", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    const healthReporter = makeMockHealthReporter();
    adapter = makeMockAdapter();

    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(adapter as any);
  });

  it("routes to Rae via general channel", async () => {
    const item = makeWorkItem({
      source: { kind: "slack", id: "C123", label: "general" },
      text: "need help with something",
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("executive-assistant", item);
  });

  it("routes to explicit targetAgentId", async () => {
    const item = makeWorkItem({
      meta: { targetAgentId: "jasper" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("jasper", item);
  });

  it("passes resolved agentId to onProcessingStart and onProcessingEnd hooks", async () => {
    // Contract lock: adapters receive the resolved handler id from the
    // dispatcher, so they never need to re-derive it from item.meta.
    // Pre-KPR-12 the adapter had to guess because triage resolved after
    // this call; post-KPR-12 routing is direct and the id is known.
    const item = makeWorkItem({
      meta: { targetAgentId: "jasper" },
    });
    await dispatcher.dispatch(item);
    expect(adapter.onProcessingStart).toHaveBeenCalledWith(item, "jasper");
    expect(adapter.onProcessingEnd).toHaveBeenCalledWith(item, "jasper");
  });

  it("routes by channel mapping", async () => {
    const item = makeWorkItem({
      source: { kind: "slack", id: "C456", label: "agent-jasper" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("jasper", item);
  });

  it("routes by name mention", async () => {
    const item = makeWorkItem({ text: "hey River, can you help?" });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("river", item);
  });

  it("drops messages with no explicit routing match", async () => {
    const item = makeWorkItem({ text: "need help with marketing" });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("drops unaddressed messages instead of falling back to default", async () => {
    const item = makeWorkItem({ text: "random question" });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("drops messages in passive channels without mention", async () => {
    const item = makeWorkItem({
      text: "random chat",
      source: { kind: "slack", id: "C789", label: "biz" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("deduplicates messages with same ID", async () => {
    const item = makeWorkItem({
      id: "dedup-same-id",
      text: "hey Jasper, help",
    });
    await dispatcher.dispatch(item);
    await dispatcher.dispatch(item); // duplicate
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
  });

  it("maintains thread continuity", async () => {
    // First message in thread routes to River
    const item1 = makeWorkItem({
      id: "thread-msg-1",
      threadId: "thread-1",
      text: "hey River, help me",
    });
    await dispatcher.dispatch(item1);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("river", item1);

    // Second message in same thread should stick with River
    const item2 = makeWorkItem({
      id: "thread-msg-2",
      threadId: "thread-1",
      text: "follow up question",
    });
    await dispatcher.dispatch(item2);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("river", item2);
  });

  it("intercepts status queries and does not call agent", async () => {
    const item = makeWorkItem({ text: "status" });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("suppresses non-response agent output", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce({
      finalMessage: "no response needed",
      newSessionId: "s-nr",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 0,
        costUsd: 0.01,
        durationMs: 500,
      },
      errors: [],
      llmMs: 0,
      toolMs: 0,
      toolCalls: 0,
      toolSummary: null,
      streamed: false,
      compactions: 0,
    });
    const item = makeWorkItem({ text: "hey Jasper, check this" });
    await dispatcher.dispatch(item);
    // runWorkItemTurn is called, but deliver should NOT be called (non-response suppressed)
    expect(agentManager.runWorkItemTurn).toHaveBeenCalled();
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it("routes to agent mentioned in passive channel", async () => {
    const item = makeWorkItem({
      text: "hey Jasper, deploy the thing",
      source: { kind: "slack", id: "C789", label: "biz" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("jasper", item);
  });

  it("fans out to multiple agents when several are named", async () => {
    const item = makeWorkItem({
      text: "Jasper, and River, coordinate on this",
    });
    await dispatcher.dispatch(item);
    // Both agents should be called
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]);
    expect(calledAgents).toContain("jasper");
    expect(calledAgents).toContain("river");
  });

  it("routes Slack DM with no channel match to default agent (KPR-35)", async () => {
    // DM channels in Slack start with "D" and are never in any agent's `channels` array.
    // Without the fallback these first-contact messages silently drop.
    const item = makeWorkItem({
      text: "hello, anyone home?",
      source: { kind: "slack", id: "D123ABC", label: "directmessage" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("executive-assistant", item);
  });

  it("does not fall back for non-DM channels with no match", async () => {
    const item = makeWorkItem({
      text: "random chatter",
      source: { kind: "slack", id: "C999", label: "random" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Multi-agent thread tests
// ---------------------------------------------------------------------------

describe("Multi-agent threads", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    const healthReporter = makeMockHealthReporter();
    adapter = makeMockAdapter();

    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(adapter as any);
  });

  it("creates participant set when multiple agents are mentioned in a thread", async () => {
    const item = makeWorkItem({
      id: "multi-1",
      threadId: "thread-multi",
      text: "Jasper, and River, let's discuss",
    });
    await dispatcher.dispatch(item);

    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]);
    expect(calledAgents).toContain("jasper");
    expect(calledAgents).toContain("river");

    // Follow-up in same thread (no mentions) should still fan out to both
    agentManager.runWorkItemTurn.mockClear();
    const item2 = makeWorkItem({
      id: "multi-2",
      threadId: "thread-multi",
      text: "any updates?",
    });
    await dispatcher.dispatch(item2);

    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    const followUpAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]);
    expect(followUpAgents).toContain("jasper");
    expect(followUpAgents).toContain("river");
  });

  it("transitions single-agent thread to multi-agent when new agent mentioned", async () => {
    // Start with single-agent thread
    const item1 = makeWorkItem({
      id: "trans-1",
      threadId: "thread-transition",
      text: "hey River, help me",
    });
    await dispatcher.dispatch(item1);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("river", item1);

    // Mention a second agent in the same thread
    agentManager.runWorkItemTurn.mockClear();
    const item2 = makeWorkItem({
      id: "trans-2",
      threadId: "thread-transition",
      text: "Jasper, can you weigh in?",
    });
    await dispatcher.dispatch(item2);

    // Both River (original) and Jasper (new) should be called
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]);
    expect(calledAgents).toContain("river");
    expect(calledAgents).toContain("jasper");

    // Follow-up should continue to fan out
    agentManager.runWorkItemTurn.mockClear();
    const item3 = makeWorkItem({
      id: "trans-3",
      threadId: "thread-transition",
      text: "thoughts?",
    });
    await dispatcher.dispatch(item3);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
  });

  it("does not transition when re-mentioning the same agent", async () => {
    const item1 = makeWorkItem({
      id: "same-1",
      threadId: "thread-same",
      text: "hey River, help me",
    });
    await dispatcher.dispatch(item1);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("river", item1);

    // Re-mention River — should stay single-agent
    agentManager.runWorkItemTurn.mockClear();
    const item2 = makeWorkItem({
      id: "same-2",
      threadId: "thread-same",
      text: "River, one more thing",
    });
    await dispatcher.dispatch(item2);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("river", item2);
  });

  it("adds new participants to existing multi-agent thread", async () => {
    // Start multi-agent with Jasper + River
    const item1 = makeWorkItem({
      id: "add-1",
      threadId: "thread-add",
      text: "Jasper, and River, discuss this",
    });
    await dispatcher.dispatch(item1);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);

    // Now mention Rae — should add to participant set
    agentManager.runWorkItemTurn.mockClear();
    const item2 = makeWorkItem({
      id: "add-2",
      threadId: "thread-add",
      text: "Rae, join us",
    });
    await dispatcher.dispatch(item2);

    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3);
    const calledAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]);
    expect(calledAgents).toContain("jasper");
    expect(calledAgents).toContain("river");
    expect(calledAgents).toContain("executive-assistant");
  });

  it("recovers multi-agent thread from persisted sessions after restart", async () => {
    // Simulate restart: no in-memory state, but session store has multiple agents
    agentManager.findAgentsForThread.mockResolvedValue(["jasper", "river"]);

    const item = makeWorkItem({
      id: "recover-1",
      threadId: "thread-recover",
      text: "any update?",
    });
    await dispatcher.dispatch(item);

    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]);
    expect(calledAgents).toContain("jasper");
    expect(calledAgents).toContain("river");
  });

  it("recovers single-agent thread from persisted sessions after restart", async () => {
    agentManager.findAgentsForThread.mockResolvedValue(["river"]);

    const item = makeWorkItem({
      id: "recover-single-1",
      threadId: "thread-recover-single",
      text: "follow up",
    });
    await dispatcher.dispatch(item);

    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("river", item);
  });

  it("sweep cleans up expired multi-agent threads", async () => {
    vi.useFakeTimers();
    try {
      // Create a multi-agent thread
      const item = makeWorkItem({
        id: "sweep-1",
        threadId: "thread-sweep",
        text: "Jasper, and River, discuss",
      });
      await dispatcher.dispatch(item);
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);

      // Advance time past the TTL, then sweep
      vi.advanceTimersByTime(1000);
      const result = dispatcher.sweep(500);
      expect(result.pruned).toBeGreaterThanOrEqual(1);

      // Next message in that thread should not fan out (affinity lost)
      agentManager.runWorkItemTurn.mockClear();
      agentManager.findAgentsForThread.mockResolvedValue([]);
      const item2 = makeWorkItem({
        id: "sweep-2",
        threadId: "thread-sweep",
        text: "hello?",
      });
      await dispatcher.dispatch(item2);
      // Falls through — no match, message dropped (no default fallback)
      expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedicated channel routing takes precedence over thread participants", async () => {
    // Even if threadId has multi-agent participants, dedicated channel routes to channel owner
    agentManager.findAgentsForThread.mockResolvedValue(["jasper", "river"]);

    const item = makeWorkItem({
      id: "channel-1",
      threadId: "thread-channel",
      text: "hey Jasper, help",
      source: { kind: "slack", id: "C456", label: "agent-jasper" },
    });
    await dispatcher.dispatch(item);

    // Should route to jasper only (channel owner), not fan out
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("jasper", item);
  });

  it("explicit targetAgentId overrides multi-agent thread", async () => {
    // Set up multi-agent thread first
    const item1 = makeWorkItem({
      id: "target-1",
      threadId: "thread-target",
      text: "Jasper, and River, discuss",
    });
    await dispatcher.dispatch(item1);

    // Callback with targetAgentId should only go to that agent
    agentManager.runWorkItemTurn.mockClear();
    const item2 = makeWorkItem({
      id: "target-2",
      threadId: "thread-target",
      text: "callback response",
      meta: { targetAgentId: "jasper" },
    });
    await dispatcher.dispatch(item2);

    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("jasper", item2);
  });
});

// ---------------------------------------------------------------------------
// KPR-223: per-turn-spawn routing tests (dispatcher branches into spawnTurn
// when the per-channel flag is on). Plus routeVoiceTurn behavior.
// ---------------------------------------------------------------------------

// KPR-220 Phase 9: per-channel per-turn-spawn flags retired. Dispatcher
// unconditionally routes through `runWorkItemTurn`. The voice path remains
// distinct (dispatcher.routeVoiceTurn → AgentManager.spawnTurn) so voice can
// pass its own systemPromptOverride.
describe("Per-turn dispatch (unconditional, KPR-220 Phase 9)", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    const healthReporter = makeMockHealthReporter();
    adapter = makeMockAdapter();

    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(adapter as any);
  });

  it("dispatch: always routes through runWorkItemTurn across channel kinds (sms, slack, app)", async () => {
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    const wsAdapter = { ...makeMockAdapter(), id: "ws", kind: "app" as const };
    dispatcher.registerAdapter(smsAdapter as any);
    dispatcher.registerAdapter(wsAdapter as any);

    const smsItem = makeWorkItem({
      source: { kind: "sms", id: "PN_X", label: "quo-may", adapterId: "sms" },
      threadId: "sms:PN_X:+15550001",
      text: "hey Jasper, ping",
    });
    const slackItem = makeWorkItem({
      source: { kind: "slack", id: "C123", label: "agent-jasper" },
      text: "ping",
    });
    const wsItem = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hey Jasper, ping",
      meta: { origin: "dodi-shop", deviceId: "dev1" },
    });

    await dispatcher.dispatch(smsItem);
    await dispatcher.dispatch(slackItem);
    await dispatcher.dispatch(wsItem);

    // All three channel kinds delegate to runWorkItemTurn unconditionally — no
    // flag check stays in the dispatcher.
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3);
  });

  it("dispatcher: fan-out always uses runWorkItemTurn", async () => {
    // Use "random" — not bound to any agent's channels so the dedicated-channel
    // shortcut doesn't fire and resolveAgents falls into the name-mention branch.
    const item = makeWorkItem({
      source: { kind: "slack", id: "C-FANOUT", label: "random" },
      text: "Jasper, and River, coordinate",
    });
    await dispatcher.dispatch(item);

    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]);
    expect(calledAgents).toContain("jasper");
    expect(calledAgents).toContain("river");
  });

  it("routeVoiceTurn calls spawnTurn (not runWorkItemTurn) — voice carve-out for systemPromptOverride", async () => {
    const ctx = {
      agentId: "mokie",
      sessionId: undefined,
      channelId: "call-abc",
      threadId: "voice:call-abc",
      workItem: makeWorkItem({
        id: "call-abc",
        source: { kind: "voice", id: "call-abc", label: "voice:call-abc" },
        threadId: "voice:call-abc",
      }),
      channel: "voice" as const,
    };
    const onStream = vi.fn();
    await dispatcher.routeVoiceTurn(ctx as any, onStream);

    expect(agentManager.spawnTurn).toHaveBeenCalledTimes(1);
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
    const [passedCtx, passedOnStream] = agentManager.spawnTurn.mock.calls[0]!;
    expect(passedCtx).toBe(ctx);
    expect(passedOnStream).toBe(onStream);
  });

  it("routes WS team WorkItem (kind=team, adapterId=ws) through runWorkItemTurn", async () => {
    const wsAdapter = { ...makeMockAdapter(), id: "ws", kind: "app" as const };
    dispatcher.registerAdapter(wsAdapter as any);

    const item = makeWorkItem({
      source: { kind: "team", id: "team:dm:user-1", label: "team:dm:user-1", adapterId: "ws" },
      threadId: "team:dm:user-1",
      text: "hey Jasper, ping",
      meta: { targetAgentId: "jasper" },
    });
    await dispatcher.dispatch(item);

    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
  });

  it("KPR-220 Phase 1: per-turn dispatch propagates non-zero llmMs/toolMs/toolCalls into the work-item-dispatched log", async () => {
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);

    // Override runWorkItemTurn (Phase 3 changed the dispatcher call site)
    // with a TurnResult carrying real execution metrics. Pre-Phase-1 the
    // dispatcher zeroed these on the way out because TurnResult had no shape
    // for them; post-Phase-1 they pass through into the RunResult that
    // drives the `Work item dispatched` log.
    agentManager.runWorkItemTurn.mockResolvedValueOnce({
      finalMessage: "ok",
      newSessionId: "s-metrics",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        contextWindow: 200000,
        costUsd: 0.05,
        durationMs: 1500,
      },
      errors: [],
      llmMs: 999,
      toolMs: 333,
      toolCalls: 7,
      toolSummary: "memory:1x",
      streamed: true,
      compactions: 1,
      preCompactTokens: 12345,
      ephemeral5mTokens: 42,
      ephemeral1hTokens: 13,
    });

    mockLogInfo.mockClear();

    const item = makeWorkItem({
      source: { kind: "sms", id: "PN_LINE_M", label: "quo-may", adapterId: "sms" },
      threadId: "sms:PN_LINE_M:+15550100",
      text: "hey Jasper, telemetry probe",
    });
    await dispatcher.dispatch(item);

    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);

    const logCall = mockLogInfo.mock.calls.find(([msg]) => msg === "Work item dispatched");
    expect(logCall).toBeDefined();
    const fields = logCall![1] as Record<string, unknown>;
    expect(fields.llmMs).toBe(999);
    expect(fields.toolMs).toBe(333);
    expect(fields.toolCalls).toBe(7);
    expect(fields.toolSummary).toBe("memory:1x");
  });

  it("KPR-401: aborted/timedOut TurnResult surfaces both flags + non-negative llmMs on the work-item-dispatched log", async () => {
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix the log-field object
    // simply lacks the two keys — fields.aborted is undefined; this fails.
    // D28 fixture migration (KPR-402): a timedOut && aborted turn on a
    // notify-policy channel is now intercepted by the deadline-continuation
    // arm and never reaches normal delivery — the log-field pin migrates to
    // the skip-policy (sched:) lane, the one lane where legacy delivery of
    // an aborted turn deliberately remains (arm fully inert on cron). The
    // assertions are byte-identical; only the item id changed. The
    // notify-lane behavior is pinned by the KPR-402 rows below.
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);

    // The incident shape post-KPR-401: honest zeros for cost, real wall
    // duration, clamped llmMs, real token counters, both flags. There is no
    // outage store configured (and breaker state is null) in this mock, so the
    // KPR-307 post-turn outage gate does not intercept — the turn reaches
    // normal delivery.
    agentManager.runWorkItemTurn.mockResolvedValueOnce({
      finalMessage: "",
      newSessionId: "s-kpr401",
      usage: {
        inputTokens: 2200,
        outputTokens: 120,
        cacheReadTokens: 18500,
        cacheCreationTokens: 250,
        contextWindow: 0,
        costUsd: 0,
        durationMs: 294_391,
      },
      errors: [],
      llmMs: 0,
      toolMs: 294_391,
      toolCalls: 46,
      toolSummary: "Bash:46x/294.4s",
      streamed: true,
      compactions: 0,
      timedOut: true,
      aborted: true,
    });

    mockLogInfo.mockClear();

    const item = makeWorkItem({
      id: "sched:jasper:kpr401-probe:1", // KPR-402 D28: skip policy — arm inert, legacy delivery + log preserved
      source: { kind: "sms", id: "PN_LINE_M", label: "quo-may", adapterId: "sms" },
      threadId: "sms:PN_LINE_M:+15550101",
      text: "hey Jasper, kpr401 probe", // agent-name-bearing, mirroring the Phase-1 row's resolution path
    });
    await dispatcher.dispatch(item);

    const logCall = mockLogInfo.mock.calls.find(([msg]) => msg === "Work item dispatched");
    expect(logCall).toBeDefined();
    const fields = logCall![1] as Record<string, unknown>;
    expect(fields.aborted).toBe(true);
    expect(fields.timedOut).toBe(true);
    expect(fields.llmMs).toBe(0);
    expect(fields.llmMs as number).toBeGreaterThanOrEqual(0);
    expect(fields.costUsd).toBe(0); // honest zero, now segmentable
  });

  it("routeVoiceTurn does NOT dedup on workItem.id", async () => {
    // Q4 invariant: voice WorkItem.id is the Vapi callId, reused across many
    // turns within a single call. Adding callId to the dispatcher dedup map
    // would silently drop turns 2+ in the 60s TTL.
    const ctx = {
      agentId: "mokie",
      sessionId: undefined,
      channelId: "call-dedup-1",
      threadId: "voice:call-dedup-1",
      workItem: makeWorkItem({
        id: "call-dedup-1",
        source: { kind: "voice", id: "call-dedup-1", label: "voice:call-dedup-1" },
        threadId: "voice:call-dedup-1",
      }),
      channel: "voice" as const,
    };

    await dispatcher.routeVoiceTurn(ctx as any);
    await dispatcher.routeVoiceTurn(ctx as any);

    // Both calls reach spawnTurn — no dedup-on-id swallows the second one.
    expect(agentManager.spawnTurn).toHaveBeenCalledTimes(2);
  });
});

describe("origin routing", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    const healthReporter = makeMockHealthReporter();
    adapter = makeMockAdapter();
    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(adapter as any);
  });

  it("routes app-source WorkItem to the catching agent", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hi from shop floor",
      meta: { origin: "dodi-shop", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("production-support", item);
  });

  it("drops when origin is unknown", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hi",
      meta: { origin: "nonexistent", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("origin wins over name addressing", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hey Jasper can you check this",
      meta: { origin: "dodi-shop", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("production-support", item);
  });

  it("team-source WorkItem with meta.origin is routed by team logic, not origin", async () => {
    // Stub team store: DM channel between user and production-support (not the origin target).
    // If origin routing were consulted, it would match production-support via the catches list —
    // so we pick a DIFFERENT agent (jasper) as the DM counterpart to prove origin is ignored.
    const teamStore = {
      getChannel: vi.fn().mockResolvedValue({
        _id: "dm-1",
        type: "dm",
        members: ["user-1", "jasper"],
      }),
    };
    dispatcher.setTeamStore(teamStore as any);

    // findByOrigin spy to assert it was NOT consulted
    const findByOriginSpy = vi.spyOn(registry, "findByOrigin");

    const item = makeWorkItem({
      source: { kind: "team", id: "dm-1", label: "dm", adapterId: "ws" },
      sender: "user-1",
      text: "hello",
      meta: { channelId: "dm-1", origin: "dodi-shop" },
    });
    await dispatcher.dispatch(item);

    expect(teamStore.getChannel).toHaveBeenCalledWith("dm-1");
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("jasper", item);
    expect(findByOriginSpy).not.toHaveBeenCalled();
  });

  it("explicit targetAgentId beats origin", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "please handle this",
      meta: { origin: "dodi-shop", targetAgentId: "executive-assistant", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("executive-assistant", item);
  });
});

describe("per-agent audit routing", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let slackAdapter: ReturnType<typeof makeMockAdapter>;
  let wsAdapter: ReturnType<typeof makeMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    const healthReporter = makeMockHealthReporter();
    slackAdapter = makeMockAdapter();
    wsAdapter = { ...makeMockAdapter(), id: "ws", kind: "app" as any };
    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(slackAdapter as any);
    dispatcher.registerAdapter(wsAdapter as any);
  });

  function auditCall() {
    return slackAdapter.deliver.mock.calls.find((c: any[]) => c[0]?.workItem?.source?.label === "audit");
  }

  it("posts audit to the handling agent's homeBase channel", async () => {
    dispatcher.setAuditChannel(
      slackAdapter as any,
      new Map([
        ["agent-sige", "C-SIGE"],
        ["agent-jessica", "C-JESSICA"],
      ]),
      "C-JESSICA",
    );
    await dispatcher.dispatch(
      makeWorkItem({
        source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
        text: "hi",
        meta: { origin: "dodi-shop", deviceId: "dev1" },
      }),
    );
    const call = auditCall();
    expect(call).toBeDefined();
    expect(call![0].workItem.source.id).toBe("C-SIGE");
  });

  it("falls back to the global channel when homeBase is not resolvable", async () => {
    dispatcher.setAuditChannel(
      slackAdapter as any,
      new Map([["agent-jessica", "C-JESSICA"]]), // no agent-sige
      "C-JESSICA",
    );
    await dispatcher.dispatch(
      makeWorkItem({
        source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
        text: "hi",
        meta: { origin: "dodi-shop", deviceId: "dev1" },
      }),
    );
    const call = auditCall();
    expect(call).toBeDefined();
    expect(call![0].workItem.source.id).toBe("C-JESSICA");
  });

  it("skips audit when neither homeBase nor fallback resolves", async () => {
    dispatcher.setAuditChannel(slackAdapter as any, new Map(), undefined);
    await dispatcher.dispatch(
      makeWorkItem({
        source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
        text: "hi",
        meta: { origin: "dodi-shop", deviceId: "dev1" },
      }),
    );
    expect(auditCall()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// KPR-307: honest outage behavior
// ---------------------------------------------------------------------------

function makeCircuitOpenError(provider = "claude") {
  return new ProviderCircuitOpenError(provider as never, Date.now(), 15_000, "connect-fail", "fetch failed");
}

function makeOutageStore() {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    recordFailedAttempt: vi.fn().mockResolvedValue({ terminal: false, doc: null }),
    markNoticeSent: vi.fn().mockResolvedValue(undefined),
    pendingCount: vi.fn().mockResolvedValue(0),
    statusOf: vi.fn().mockResolvedValue(null),
    expireOlderThan: vi.fn().mockResolvedValue([]),
    recoverStaleReplaying: vi.fn().mockResolvedValue(0),
    ensureIndexes: vi.fn().mockResolvedValue(undefined),
  };
}

const OUTAGE_CONFIG = {
  enabled: true,
  replayIntervalMs: 15_000,
  maxAgeHours: 4,
  maxDepth: 500,
  maxReplayAttempts: 3,
};

function makeTurn(overrides: Record<string, unknown> = {}) {
  return {
    finalMessage: "turn response",
    newSessionId: "s2",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 0,
      costUsd: 0.01,
      durationMs: 800,
    },
    errors: [] as string[],
    llmMs: 0,
    toolMs: 0,
    toolCalls: 0,
    toolSummary: null,
    streamed: false,
    compactions: 0,
    ...overrides,
  };
}

describe("outage interception (KPR-307)", () => {
  let dispatcher: Dispatcher;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;
  let store: ReturnType<typeof makeOutageStore>;
  let episodes: OutageEpisodeTracker;

  beforeEach(() => {
    agentManager = makeMockAgentManager();
    adapter = makeMockAdapter();
    store = makeOutageStore();
    episodes = new OutageEpisodeTracker();
    dispatcher = new Dispatcher(
      makeMockRegistry() as never,
      agentManager as never,
      makeMockHealthReporter() as never,
      "executive-assistant",
    );
    dispatcher.registerAdapter(adapter as never);
    dispatcher.setOutageHandling({ store: store as never, episodes, config: OUTAGE_CONFIG });
  });

  // Route to the dedicated channel of the default enabled agent so resolution
  // is deterministic (mock registry: executive-assistant owns "general").
  function slackItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return makeWorkItem({ source: { kind: "slack", id: "C999", label: "general" }, ...overrides });
  }

  function replayItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return slackItem({
      meta: { outageReplay: true, targetAgentId: "executive-assistant" },
      ...overrides,
    });
  }

  it("instanceof path: queues + delivers a plain-text notice with error UNSET (SMS-skip regression guard)", async () => {
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));

    expect(store.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "m1", agentId: "executive-assistant", provider: "claude", policy: "notify" }),
    );
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    const delivered = adapter.deliver.mock.calls[0][0];
    expect(delivered.text).toBe(OUTAGE_NOTICE_DEFAULT);
    expect(delivered.error).toBeUndefined();
  });

  it("once per thread per episode: follow-up turns queue silently, a second thread notices once", async () => {
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    await dispatcher.dispatch(slackItem({ id: "m2", threadId: "t1" }));
    await dispatcher.dispatch(slackItem({ id: "m3", threadId: "t2" }));

    expect(store.enqueue).toHaveBeenCalledTimes(3);
    expect(adapter.deliver).toHaveBeenCalledTimes(2); // t1 once, t2 once
  });

  it("post-turn open-state path: errored TurnResult + open enabled snapshot → outage path, no error delivery", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn({ errors: ["connect ECONNREFUSED api"] }));
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });

    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledTimes(1);
    // Only the notice was delivered — never the "Something went wrong"/error result.
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
  });

  it("non-provider classification while open → legacy error path, unqueued (Finding 4 r1)", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn({ errors: ["Something exploded in a tool handler"] }));
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });

    await dispatcher.dispatch(slackItem());
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].error).toBe("Something exploded in a tool handler");
  });

  it("closed snapshot → legacy error path; shadow (enabled:false) open snapshot → legacy path", async () => {
    agentManager.runWorkItemTurn.mockResolvedValue(makeTurn({ errors: ["connect ECONNREFUSED api"] }));

    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
    await dispatcher.dispatch(slackItem({ id: "m1" }));
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: false });
    await dispatcher.dispatch(slackItem({ id: "m2" }));

    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(2);
  });

  it("★ timeout gate: timedOut && aborted with breaker open → outage path even with empty errors", async () => {
    // KPR-398 zero-progress pin: fixture defaults toolCalls: 0 / streamed:
    // false plus finalMessage "" = the hang signature — classifies hard
    // timeout and still queues.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });

    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledTimes(1);
    // No bare "_No response._" delivery — only the honest notice.
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(OUTAGE_NOTICE_DEFAULT);
  });

  it("★ KPR-402 (D28 migration): zero-progress deadline abort with breaker closed → honest zero-progress notice, still unqueued", async () => {
    // KPR-398 zero-progress pin (see the open-breaker row above).
    // D28 fixture-migration justification: this row previously pinned the
    // pre-KPR-402 defect shape — bare "_No response._" delivery ("as
    // today"). The deadline arm now intercepts the closed-circuit
    // zero-progress abort with an honest notice, no re-dispatch (spec
    // §Design.3 / T10). The never-queued half of the old pin is retained
    // verbatim.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });

    await dispatcher.dispatch(slackItem());
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT); // was: "_No response._"
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
  });

  it("★ KPR-398/KPR-402 (D28 migration): with-progress deadline turn with breaker open → deadline arm, never queued by the gate (D3 pin)", async () => {
    // A turn-deadline-with-progress by definition executed tools or streamed;
    // queuing it into outage_queue would silently re-run those side effects
    // on replay (the gate's Finding 4 r1 rationale).
    // D28 fixture-migration justification (spec ⚠A8): the with-progress+open
    // row migrates from bare legacy "_No response._" delivery to the
    // deadline arm — notice + in-process continuation. THE RETAINED
    // never-queued ASSERTION IS THE D3 PIN: the original partially-executed
    // turn is never enqueued for blind replay (turn-deadline ∉
    // HARD_FAULT_KINDS keeps the outage gate declining); what may later
    // reach the queue is only a continuation leg under its own per-leg id
    // (the KPR-402 T13 row).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true, toolCalls: 46, streamed: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });

    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).not.toHaveBeenCalled(); // D3: never queued by the gate — retained verbatim
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_NOTICE_DEFAULT); // honest notice, not "_No response._"
    expect(adapter.deliver.mock.calls[0][0].text).not.toBe(OUTAGE_NOTICE_DEFAULT);
    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
    expect((agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem).id).toBe("m1#dl1"); // the continuation
  });

  it("KPR-400 F2: ProviderCircuitOpenError fast-fail enqueues enqueueOrigin 'fast-fail'", async () => {
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix handleOutageTurn has no
    // origin param and enqueue carries no enqueueOrigin — objectContaining
    // fails.
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledWith(expect.objectContaining({ itemId: "m1", enqueueOrigin: "fast-fail" }));
  });

  it("KPR-400 F2: post-turn zero-progress deadline gate enqueues enqueueOrigin 'post-turn-fault'", async () => {
    // Same fixture shape as the '★ timeout gate: timedOut && aborted with
    // breaker open' row above (cited by name — KPR-398 zero-progress hang
    // signature: empty finalMessage, toolCalls 0, streamed false).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "m1", enqueueOrigin: "post-turn-fault" }),
    );
  });

  it("KPR-400 F2: a replay fast-failing again releases pending and never re-enqueues (origin stays untouched)", async () => {
    // Pin, passes both ways by design: the release-before-depth branch
    // predates KPR-400; origin immutability itself is store-level
    // ($setOnInsert — pinned in outage-queue-store.test.ts). This row pins
    // that the dispatcher's replay path cannot even REACH enqueue.
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "pending");
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("KPR-403: fast-fail enqueue stamps deadlineMs from the manager wrapper", async () => {
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix the enqueue site never
    // calls the wrapper and carries no deadlineMs — objectContaining fails.
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(agentManager.turnDeadlineUpperBoundMs).toHaveBeenCalledWith("executive-assistant");
    expect(store.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "m1", enqueueOrigin: "fast-fail", deadlineMs: 900_000 }),
    );
  });

  it("KPR-403: post-turn-fault enqueue stamps deadlineMs from the manager wrapper", async () => {
    // Same fixture shape as the '★ timeout gate' row above (KPR-398
    // zero-progress hang signature) — both origin classes flow through the
    // single enqueue site, so one stamp covers both callers.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "m1", enqueueOrigin: "post-turn-fault", deadlineMs: 900_000 }),
    );
  });

  it("KPR-403: the replayed-fast-fail release branch never consults the wrapper and never reaches enqueue", async () => {
    // Pin, passes both ways by design: the release-before-depth branch
    // predates KPR-403 and release() has no deadline parameter — the stamp
    // stays $setOnInsert-immutable at the store (pinned there, T5).
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "pending");
    expect(agentManager.turnDeadlineUpperBoundMs).not.toHaveBeenCalled();
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("sched: turns skip with a log — never queued, never noticed", async () => {
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(
      slackItem({ id: "sched:executive-assistant:daily:1", meta: { targetAgentId: "executive-assistant" } }),
    );
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it("callback:/event:/team- turns queue silently (no notice, no error delivery)", async () => {
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());
    for (const id of ["callback:abc", "event:abc:executive-assistant", "team-abc"]) {
      await dispatcher.dispatch(slackItem({ id, meta: { targetAgentId: "executive-assistant" } }));
    }
    expect(store.enqueue).toHaveBeenCalledTimes(3);
    for (const call of store.enqueue.mock.calls) {
      expect(call[0].policy).toBe("silent");
    }
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it("overflow at maxDepth: NOT queued, one overflow notice per thread per episode (notify policy)", async () => {
    store.pendingCount.mockResolvedValue(500);
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());

    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(OUTAGE_OVERFLOW_NOTICE_DEFAULT);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();

    // Advisory 3: a second overflowed message on the SAME thread during the
    // same episode must NOT re-notice — dedup is per-thread, not per-message.
    await dispatcher.dispatch(slackItem({ id: "m2", threadId: "t1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("★ release-before-depth: replayed fast-fail at maxDepth resolves its doc, never the overflow branch", async () => {
    store.pendingCount.mockResolvedValue(500);
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());

    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "pending");
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).not.toHaveBeenCalled(); // no overflow notice, no second outage notice
  });

  it("replay re-entrancy + dedup bypass: same id redispatches; non-replay duplicate still drops", async () => {
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    await dispatcher.dispatch(replayItem({ id: "m1" })); // second replay tick, same id — must NOT be deduped
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    expect(store.release).toHaveBeenCalledTimes(2);
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).not.toHaveBeenCalled();

    // Non-replay duplicate id within the 60s window still drops.
    agentManager.runWorkItemTurn.mockResolvedValue(makeTurn());
    await dispatcher.dispatch(slackItem({ id: "dup-1" }));
    await dispatcher.dispatch(slackItem({ id: "dup-1" }));
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3); // only one of the two dup-1 dispatches ran
  });

  it("★ legacy thrown branch: replay + non-outage throw (breaker closed) → doc back to pending, attempts unchanged, then today's error delivery", async () => {
    agentManager.runWorkItemTurn.mockRejectedValueOnce(new Error("Spawn budget exceeded for executive-assistant"));
    await dispatcher.dispatch(replayItem({ id: "m1" }));

    expect(store.release).toHaveBeenCalledWith(
      "m1",
      "executive-assistant",
      "pending",
      expect.stringContaining("Spawn budget exceeded"),
    );
    expect(store.recordFailedAttempt).not.toHaveBeenCalled(); // attempts unchanged
    // Legacy delivery continues as today.
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].error).toContain("Spawn budget exceeded");
  });

  it("disabled pinned-agent replay → expired (chief-of-staff is disabled in the mock registry)", async () => {
    await dispatcher.dispatch(replayItem({ id: "m1", meta: { outageReplay: true, targetAgentId: "chief-of-staff" } }));
    expect(store.release).toHaveBeenCalledWith(
      "m1",
      "chief-of-staff",
      "expired",
      "agent disabled/deleted — will not be replayed",
    );
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("★ deleted/unresolvable pinned-agent replay → expired, NO fall-through resolution", async () => {
    // Item text names an existing agent ("hey Jasper") — a fall-through
    // resolution would match jasper; the pinned-agent rule forbids it.
    await dispatcher.dispatch(
      replayItem({
        id: "m1",
        text: "hey Jasper, are we live?",
        meta: { outageReplay: true, targetAgentId: "ghost-agent" },
      }),
    );
    expect(store.release).toHaveBeenCalledWith(
      "m1",
      "ghost-agent",
      "expired",
      "agent disabled/deleted — will not be replayed",
    );
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("episode cleared on success ONLY when stateFor is not open at completion (Finding 3 r1)", async () => {
    // Open the episode.
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // the notice

    // A pre-trip turn lands successfully while the breaker is STILL open → episode must survive.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn());
    await dispatcher.dispatch(slackItem({ id: "m2", threadId: "t1" }));
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m3", threadId: "t1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(2); // m2's answer only; m3 queued silently — NO second notice

    // Success while the breaker reads closed → episode ends → next outage re-notices.
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn());
    await dispatcher.dispatch(slackItem({ id: "m4", threadId: "t1" }));
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m5", threadId: "t1" }));
    const texts = adapter.deliver.mock.calls.map((c: any[]) => c[0].text);
    expect(texts.filter((t: string) => t === OUTAGE_NOTICE_DEFAULT)).toHaveLength(2); // m1 + m5
  });

  it("fan-out: two agents fast-fail on one thread → two enqueues (composite key), exactly one notice", async () => {
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());
    // "Jasper and River" name-resolves to two agents in the mock registry →
    // multi-agent fan-out under Promise.all (the Finding 8 race surface).
    await dispatcher.dispatch(
      makeWorkItem({
        id: "m1",
        threadId: "t1",
        text: "hey Jasper, and River: thoughts?",
        source: { kind: "slack", id: "C999", label: "random" },
      }),
    );
    expect(store.enqueue).toHaveBeenCalledTimes(2);
    const agentIds = store.enqueue.mock.calls.map((c: any[]) => c[0].agentId).sort();
    expect(new Set(agentIds).size).toBe(2);
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // one thread, one notice
  });

  it("terminal failed: notify-policy replay delivers a plain-text terminal notice; silent policy none", async () => {
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
    agentManager.runWorkItemTurn.mockResolvedValue(makeTurn({ errors: ["boom"] }));

    store.recordFailedAttempt.mockResolvedValueOnce({
      terminal: true,
      doc: { policy: "notify", enqueuedAt: new Date(), itemId: "m1", agentId: "executive-assistant" },
    });
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toContain("could not be answered");
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();

    store.recordFailedAttempt.mockResolvedValueOnce({
      terminal: true,
      doc: { policy: "silent", enqueuedAt: new Date(), itemId: "m2", agentId: "executive-assistant" },
    });
    await dispatcher.dispatch(replayItem({ id: "m2" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // unchanged — silent stays silent
  });

  it("replay success releases done", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn());
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "done");
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // the real answer, delivered normally
  });

  it("non-response-suppressed replay also releases done (§5-2g: nothing left to redeliver)", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn({ finalMessage: "No response needed." }));
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "done");
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it("outage wiring absent (setOutageHandling never called) → behavior identical to today", async () => {
    const bare = new Dispatcher(
      makeMockRegistry() as never,
      agentManager as never,
      makeMockHealthReporter() as never,
      "executive-assistant",
    );
    bare.registerAdapter(adapter as never);
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await bare.dispatch(slackItem({ id: "m1" }));
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toContain("Something went wrong");
  });
});

// ---------------------------------------------------------------------------
// KPR-402: deadline-abort continuation chain
// ---------------------------------------------------------------------------

describe("deadline-abort continuation (KPR-402)", () => {
  let dispatcher: Dispatcher;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;
  let store: ReturnType<typeof makeOutageStore>;
  let episodes: OutageEpisodeTracker;

  beforeEach(() => {
    mockLogInfo.mockClear();
    mockLogWarn.mockClear();
    agentManager = makeMockAgentManager();
    adapter = makeMockAdapter();
    store = makeOutageStore();
    episodes = new OutageEpisodeTracker();
    dispatcher = new Dispatcher(
      makeMockRegistry() as never,
      agentManager as never,
      makeMockHealthReporter() as never,
      "executive-assistant",
    );
    dispatcher.registerAdapter(adapter as never);
    dispatcher.setOutageHandling({ store: store as never, episodes, config: OUTAGE_CONFIG });
    // The arm is a closed-circuit surface — default to an explicit closed
    // snapshot (rows that need open override per-row).
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
  });

  function slackItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return makeWorkItem({ source: { kind: "slack", id: "C999", label: "general" }, ...overrides });
  }

  function replayItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return slackItem({ meta: { outageReplay: true, targetAgentId: "executive-assistant" }, ...overrides });
  }

  /** D6 rows 1-2 fixture shapes (KPR-398): observed progress vs the hang signature. */
  const withProgressAbort = () =>
    makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true, toolCalls: 46, streamed: true });
  const zeroProgressAbort = () => makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true });

  /** Drain the fire-and-forget continuation's microtask/timer chain before NEGATIVE count assertions. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("T1: with-progress abort, closed, slack → notice + in-process continuation; never '_No response._', never queued", async () => {
    // NEGATIVE-VERIFY prediction (Step 4 NV-A): pre-fix the arm does not
    // exist — bare "_No response._" delivery (the old 1292 shape) reappears
    // and no second dispatch ever fires; this row fails on the notice text
    // and the waitFor times out.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({ id: "m1", threadId: "t1", text: "summarize the big repo", meta: { slackThreadTs: "171.001" } }),
    );

    // Notice first — exact text, error UNSET (SMS-skip class regression guard).
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_NOTICE_DEFAULT);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
    expect(store.enqueue).not.toHaveBeenCalled(); // closed circuit — the queue is never touched

    // The continuation (default mock: success) runs as a second dispatch.
    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
    const cont = agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem;
    expect(cont.id).toBe("m1#dl1"); // per-leg id (⚠A11)
    expect(cont.threadId).toBe("t1"); // threaded origin: identity copy (T15 pins the threadId-less case)
    expect(cont.meta).toMatchObject({
      deadlineRetry: 1,
      targetAgentId: "executive-assistant",
      slackThreadTs: "171.001", // channel meta carried through (blocklist, not allowlist)
      deadlineOriginalText: "summarize the big repo",
    });
    expect(cont.meta?.outageReplay).toBeUndefined(); // meta hygiene (r1 B1)
    expect(cont.text).toBe(deadlineContinuationWrap("summarize the big repo", 1, 3));

    await vi.waitFor(() => expect(adapter.deliver).toHaveBeenCalledTimes(2));
    const texts = adapter.deliver.mock.calls.map((c: any[]) => c[0].text);
    expect(texts).not.toContain("_No response._");
    expect(texts[1]).toBe("turn response"); // the continuation's real answer, delivered normally
  });

  it("T2: chain cap — an item arriving with deadlineRetry 2 aborts with progress → terminal notice, no further dispatch", async () => {
    // NEGATIVE-VERIFY (documented, covered by NV-A): dropping the cap check
    // would fire a third dispatch — the flush + count assertion fails.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({
        id: "m1#dl2",
        threadId: "t1",
        meta: { deadlineRetry: 2, targetAgentId: "executive-assistant", deadlineOriginalText: "orig" },
      }),
    );

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_TERMINAL_NOTICE_DEFAULT);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1); // the chain is over
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("T3: zero-progress, closed, non-replay → zero-progress notice only; no re-dispatch; no queue write", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(zeroProgressAbort());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1); // never a re-dispatch on zero progress (⚠A3)
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("T4: cron (sched:) deadline abort → arm fully inert — existing delivery unchanged, no notice, no re-dispatch", async () => {
    // Pin, passes both ways by design (ticket ruling: cron re-fires at the
    // next match; queueing or retrying would double-run).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({ id: "sched:executive-assistant:daily:1", meta: { targetAgentId: "executive-assistant" } }),
    );

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe("_No response._"); // legacy delivery, exactly as today
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("T5: silent policy (callback:), with-progress → full chain without ANY notices; cap exhaustion warn-logged", async () => {
    // Every leg aborts with progress: leg 1 → #dl1 → #dl2 hits the cap.
    agentManager.runWorkItemTurn.mockResolvedValue(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({ id: "callback:x", threadId: "cb-t1", meta: { targetAgentId: "executive-assistant" } }),
    );

    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3));
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3); // cap: never a 4th leg
    expect(adapter.deliver).not.toHaveBeenCalled(); // zero notices, zero deliveries — silent stays silent
    expect((agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem).id).toBe("callback:x#dl1");
    expect((agentManager.runWorkItemTurn.mock.calls[2][1] as WorkItem).id).toBe("callback:x#dl2"); // flat (⚠A11)
    expect(
      mockLogWarn.mock.calls.some(([msg]) => msg === "Deadline continuation cap exhausted on silent one-shot"),
    ).toBe(true);
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("T6: replay item, with-progress, closed → doc released done + notice + continuation with outageReplay STRIPPED", async () => {
    // NEGATIVE-VERIFY (Step 4 NV-B, manual meta-strip edit): a naive
    // `...item.meta` spread carries outageReplay: true into the chain — the
    // hygiene assertion fails on that construction (r1 B1/ADV3).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(replayItem({ id: "x", threadId: "t1" }));

    expect(store.release).toHaveBeenCalledWith(
      "x",
      "executive-assistant",
      "done",
      "deadline abort — continuation dispatched in-process (KPR-402)",
    );
    // deadlineRetry absent on the doc's serialized meta → first-notice fires.
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_NOTICE_DEFAULT);
    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
    const cont = agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem;
    expect(cont.id).toBe("x#dl1");
    expect(cont.meta?.outageReplay).toBeUndefined(); // meta hygiene pinned
    expect(cont.meta?.deadlineRetry).toBe(1);
  });

  it("T7: replay item, zero-progress, closed → §5-2g real-failure path (attempts+1), no deadline notice, no re-dispatch", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(zeroProgressAbort());
    await dispatcher.dispatch(replayItem({ id: "x" }));

    expect(store.recordFailedAttempt).toHaveBeenCalledWith(
      "x",
      "executive-assistant",
      "turn deadline exceeded (zero progress)",
      OUTAGE_CONFIG.maxReplayAttempts,
    );
    expect(store.release).not.toHaveBeenCalled(); // neither done nor pending — the attempts machinery owns the doc
    expect(adapter.deliver).not.toHaveBeenCalled(); // non-terminal: silent (the enqueue-time notice's promise stands)
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
  });

  it("T8: per-leg id vs dedup — a single-agent continuation is first-seen; fan-out legs ride the deadlineRetry bypass (D39/T16); a replayed continuation doc uses the existing outageReplay bypass", async () => {
    // Half 1: after origin id m1 is dedup-seen, the continuation m1#dl1
    // dispatches through step 0 untouched — proven by the second turn running.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));

    // Half 2: a replayed continuation doc re-enters under the LEG's id with
    // the processor-stamped outageReplay flag — the existing bypass admits
    // it even though m1#dl1 is now dedup-seen from half 1, and its store
    // writes address the LEG's own doc, never the origin's.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn());
    await dispatcher.dispatch(
      replayItem({
        id: "m1#dl1",
        threadId: "t1",
        meta: { outageReplay: true, targetAgentId: "executive-assistant", deadlineRetry: 1 },
      }),
    );
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3);
    expect(store.release).toHaveBeenCalledWith("m1#dl1", "executive-assistant", "done");
  });

  it("T9: wrap round-trip + flat ids + two-notice cadence — a later leg wraps the ORIGINAL text, counter monotonic", async () => {
    agentManager.runWorkItemTurn.mockResolvedValue(withProgressAbort()); // every leg deadline-aborts with progress
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1", text: "the original ask" }));

    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(adapter.deliver).toHaveBeenCalledTimes(2));
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3); // cap: never a 4th leg

    const [leg1, leg2, leg3] = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[1] as WorkItem);
    expect(leg1.id).toBe("m1");
    expect(leg2.id).toBe("m1#dl1");
    expect(leg3.id).toBe("m1#dl2"); // flat — never m1#dl1#dl2 (deadlineBaseIdOf)
    // Leg 3 wraps the ORIGINAL request (deadlineOriginalText carriage), never leg 2's wrap nested.
    expect(leg2.text).toBe(deadlineContinuationWrap("the original ask", 1, 3));
    expect(leg3.text).toBe(deadlineContinuationWrap("the original ask", 2, 3));
    expect(leg3.meta?.deadlineRetry).toBe(2); // strictly monotonic
    // Cadence: exactly two notices per chain — first + terminal; the middle leg is silent.
    const texts = adapter.deliver.mock.calls.map((c: any[]) => c[0].text);
    expect(texts).toEqual([DEADLINE_NOTICE_DEFAULT, DEADLINE_TERMINAL_NOTICE_DEFAULT]);
  });

  it("T11: Lane B sentinel (aborted: false) and operator abort (no timedOut) never enter the arm", async () => {
    // Pin, passes both ways by design (Non-Goals / C3: Lane B keeps
    // !result.aborted byte-for-byte; an operator who stopped a turn needs no
    // notice that it stopped).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: ["error_turn_deadline"], timedOut: true, aborted: false }),
    );
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].error).toBe("error_turn_deadline"); // existing visible error surfacing

    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn({ finalMessage: "stopped mid-answer", aborted: true }));
    await dispatcher.dispatch(slackItem({ id: "m2", threadId: "t2" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(2);
    expect(adapter.deliver.mock.calls[1][0].text).toBe("stopped mid-answer"); // operator abort: today's behavior byte-identical
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2); // no continuations fired
  });

  it("T13: breaker opens mid-chain — the leg enqueues under its OWN (x#dl1) key; the origin's done doc is never resurrected", async () => {
    // r1 B1(ii) collision pin. NEGATIVE-VERIFY (Step 4 NV-B): with the
    // outageReplay strip removed, the leg inherits the flag, its fast-fail
    // takes handleOutageTurn's release-before-depth branch instead of the
    // enqueue branch, enqueue is never called, and release is called a
    // second time with "pending" — both assertion groups fail (the pre-B1
    // silent-drop/resurrection shape).
    agentManager.runWorkItemTurn
      .mockResolvedValueOnce(withProgressAbort()) // the origin replay burns its deadline with progress
      .mockRejectedValueOnce(makeCircuitOpenError()); // the continuation fast-fails — breaker re-opened mid-chain
    await dispatcher.dispatch(replayItem({ id: "x", threadId: "t1" }));

    await vi.waitFor(() =>
      expect(store.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: "x#dl1", agentId: "executive-assistant", enqueueOrigin: "fast-fail" }),
      ),
    );
    // The leg's workItem serializes VERBATIM — counter included, marker
    // stripped — so the cap survives the queue round-trip (r1 B1).
    const enqueued = store.enqueue.mock.calls[0][0];
    expect(enqueued.workItem.meta.deadlineRetry).toBe(1);
    expect(enqueued.workItem.meta.outageReplay).toBeUndefined();
    // Exactly one release ever: the origin → done. No pending flip on either key.
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledWith("x", "executive-assistant", "done", expect.stringContaining("KPR-402"));
  });

  it("T14: silent × zero-progress × closed — warn log only: no notice, no re-dispatch, no store writes, '_No response._' suppressed", async () => {
    // r1 B2 cell (spec §Design.3): nobody human is owed a notice on a
    // system one-shot; the trigger is lost for this firing (accepted — the
    // same acceptance KPR-307 made for a silent one-shot expiring in the
    // queue); the warn keeps it conspicuous.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(zeroProgressAbort());
    await dispatcher.dispatch(slackItem({ id: "callback:zp", meta: { targetAgentId: "executive-assistant" } }));

    await flush();
    expect(adapter.deliver).not.toHaveBeenCalled(); // the bare "_No response._" delivery to a system surface is suppressed too
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
    expect(store.recordFailedAttempt).not.toHaveBeenCalled();
    expect(
      mockLogWarn.mock.calls.some(
        ([msg]) => msg === "Deadline zero-progress abort on silent one-shot — dropped with log",
      ),
    ).toBe(true);
  });

  it("T15: thread-key pinning — a threadId-less callback: origin's continuation carries the origin's EFFECTIVE thread key", async () => {
    // r2 blocker pin. NEGATIVE-VERIFY (Step 4 NV-C, manual pin-drop edit):
    // without the `threadId: item.threadId ?? item.id` pin the continuation's
    // threadId is undefined — runWorkItemTurn's session read
    // (agent-manager.ts:866, `item.threadId ?? item.id`) would key on
    // "callback:x#dl1" while the origin persisted under "callback:x": no
    // leg could ever resume its predecessor (the blind fresh re-run
    // Finding-4 forbids). The mocked runWorkItemTurn receives the item this
    // row asserts on — the real manager's read key IS threadId ?? id, so
    // pinning the item shape pins the read key.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({ id: "callback:x", threadId: undefined, meta: { targetAgentId: "executive-assistant" } }),
    );

    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
    const cont = agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem;
    expect(cont.id).toBe("callback:x#dl1");
    expect(cont.threadId).toBe("callback:x"); // the origin's effective key, materialized before the id changed
  });

  it("T16 (r1 SF-1): multi-agent fan-out — both agents' legs dispatch; neither is swallowed by the id-only dedup", async () => {
    // The leg id is derived from the ORIGIN item (`m1#dl1`), and the counter
    // is per-chain rather than per-agent, so under fan-out both agents mint
    // the SAME leg id. Before the dedup bypass was extended to engine-authored
    // legs, whichever leg lost the race was dropped at debug level — after its
    // agent had already delivered a notice promising a continuation.
    //
    // NEGATIVE-VERIFY (Step: revert the `deadlineRetry === undefined` clause
    // at dispatcher.ts step 0): the fourth runWorkItemTurn never fires, the
    // waitFor times out, and the pair assertion below is one leg short.
    agentManager.runWorkItemTurn
      .mockResolvedValueOnce(withProgressAbort()) // agent 1's origin turn
      .mockResolvedValueOnce(withProgressAbort()); // agent 2's origin turn (Promise.all sibling)
    // "Jasper, and River" name-resolves to two agents in the mock registry;
    // label "random" is nobody's dedicated channel, so step 1 doesn't capture it.
    await dispatcher.dispatch(
      makeWorkItem({
        id: "m1",
        threadId: "t1",
        text: "hey Jasper, and River: thoughts?",
        source: { kind: "slack", id: "C999", label: "random" },
      }),
    );

    // Four turns total: two origin legs + BOTH continuation legs.
    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(adapter.deliver).toHaveBeenCalledTimes(4));
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(4); // no third leg — the continuations succeeded

    // Both agents delivered their own first-abort notice (the arm notices per
    // agent — a deadline abort is a per-turn event, not a provider episode),
    // and both continuations delivered a real answer. Counted, not ordered:
    // the two origin turns interleave under Promise.all.
    const texts = adapter.deliver.mock.calls.map((c: any[]) => c[0].text);
    expect(texts.filter((t: string) => t === DEADLINE_NOTICE_DEFAULT)).toHaveLength(2);
    expect(texts.filter((t: string) => t === "turn response")).toHaveLength(2);
    expect(texts).not.toContain("_No response._");

    // Assert by (agentId, itemId) pair — the composite is what's unique.
    const pairs = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => `${c[0]}:${(c[1] as WorkItem).id}`).sort();
    expect(pairs).toEqual(["jasper:m1", "jasper:m1#dl1", "river:m1", "river:m1#dl1"]);
    // Each leg is pinned to its OWN agent (resolveAgents step 0), so a leg can
    // never re-resolve onto its sibling.
    for (const call of agentManager.runWorkItemTurn.mock.calls) {
      const [agentId, wi] = call as [string, WorkItem];
      if (wi.id === "m1#dl1") expect(wi.meta?.targetAgentId).toBe(agentId);
    }
    expect(store.enqueue).not.toHaveBeenCalled(); // closed circuit throughout
  });

  it("T17 (r1 NIT-2): a non-finite deadlineRetry fails CLOSED — treated at-cap, terminal notice, no leg", async () => {
    // NEGATIVE-VERIFY: without the Number.isFinite guard, n is NaN — every
    // comparison against the cap is false, so the arm dispatches an unbounded
    // `m1#dlNaN` chain instead of terminating. The count assertion fails.
    agentManager.runWorkItemTurn.mockResolvedValue(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({
        id: "m1",
        threadId: "t1",
        meta: { deadlineRetry: "garbage", targetAgentId: "executive-assistant" },
      }),
    );

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_TERMINAL_NOTICE_DEFAULT);
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1); // no continuation leg was ever dispatched
    expect(store.enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// KPR-308 — outage-mode delivery preference
// ---------------------------------------------------------------------------

describe("outage-mode delivery preference (KPR-308)", () => {
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let healthReporter: ReturnType<typeof makeMockHealthReporter>;
  let slackAdapter: ReturnType<typeof makeMockAdapter>;
  let wsAdapter: ReturnType<typeof makeMockAdapter> & { deliverBroadcast: ReturnType<typeof vi.fn> };
  let dispatcher: Dispatcher;

  function makeSchedulerSynthItem(agentId = "floor-agent"): WorkItem {
    // Mirrors scheduler.ts synthesis: slack-kind source, meta.targetAgentId.
    return makeWorkItem({
      source: { kind: "slack", id: "agent-floor", label: "agent-floor" },
      sender: "system",
      threadId: `scheduler:${agentId}:task:${Date.now()}-${workItemCounter}`,
      meta: { targetAgentId: agentId },
    });
  }

  beforeEach(() => {
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    healthReporter = makeMockHealthReporter();
    slackAdapter = makeMockAdapter();
    wsAdapter = {
      ...makeMockAdapter(),
      id: "ws",
      kind: "app" as const,
      deliverBroadcast: vi.fn().mockResolvedValue(1),
    };
    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(slackAdapter as any);
    dispatcher.registerAdapter(wsAdapter as any);
  });

  it("does not divert when the provider reports no outage (dormant default)", async () => {
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("diverts a floor-critical agent's slack-sourced item to the broadcast during an outage", async () => {
    dispatcher.setOutageStateProvider(() => true);
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(wsAdapter.deliverBroadcast).toHaveBeenCalledTimes(1);
    expect(wsAdapter.deliverBroadcast.mock.calls[0][0].agentId).toBe("floor-agent");
    expect(slackAdapter.deliver).not.toHaveBeenCalled();
  });

  it("diverts the defensive scheduler source kind (type-union branch; no live producer today)", async () => {
    dispatcher.setOutageStateProvider(() => true);
    const item = makeWorkItem({
      source: { kind: "scheduler", id: "agent-floor", label: "agent-floor" },
      meta: { targetAgentId: "floor-agent" },
    });
    await dispatcher.dispatch(item);
    expect(wsAdapter.deliverBroadcast).toHaveBeenCalledTimes(1);
  });

  it("does not divert non-floor-critical agents during an outage", async () => {
    dispatcher.setOutageStateProvider(() => true);
    await dispatcher.dispatch(makeSchedulerSynthItem("jasper"));
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("never diverts app-sourced replies (source-keyed round-trip untouched)", async () => {
    dispatcher.setOutageStateProvider(() => true);
    const item = makeWorkItem({
      source: { kind: "app", id: "dev-1", label: "app:Shop", adapterId: "ws" },
      meta: { targetAgentId: "floor-agent", deviceId: "dev-1" },
    });
    await dispatcher.dispatch(item);
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(wsAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("never diverts sms-sourced items (an SMS user is not on the shop floor)", async () => {
    dispatcher.setOutageStateProvider(() => true);
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);
    const item = makeWorkItem({
      source: { kind: "sms", id: "+15550001111", label: "sms" },
      meta: { targetAgentId: "floor-agent" },
    });
    await dispatcher.dispatch(item);
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(smsAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("falls through to the source adapter when the broadcast reaches zero devices", async () => {
    dispatcher.setOutageStateProvider(() => true);
    wsAdapter.deliverBroadcast.mockResolvedValue(0);
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(wsAdapter.deliverBroadcast).toHaveBeenCalledTimes(1);
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("falls through to the source adapter when the broadcast throws", async () => {
    dispatcher.setOutageStateProvider(() => true);
    wsAdapter.deliverBroadcast.mockRejectedValue(new Error("boom"));
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("falls through to the source adapter when the outage-state provider itself throws (review r2)", async () => {
    // Guards the KPR-306 hand-off: once a real breaker-state probe is wired into
    // the provider, a throw from it must fall through to normal delivery, not
    // propagate out of deliverAgentResult and turn a good turn into an error.
    dispatcher.setOutageStateProvider(() => {
      throw new Error("breaker probe exploded");
    });
    await expect(dispatcher.dispatch(makeSchedulerSynthItem())).resolves.not.toThrow();
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
    // The successful agent turn is delivered verbatim — NOT converted into a
    // "Something went wrong" error frame by handleTurnFailure. Pre-fix, the
    // throw escaped tryOutageDiversion and did exactly that.
    const delivered = slackAdapter.deliver.mock.calls[0][0];
    expect(delivered.agentId).toBe("floor-agent");
    expect(delivered.error).toBeUndefined();
    expect(delivered.text).toBe("turn response");
  });

  it("falls through when no ws adapter is registered", async () => {
    const bare = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    bare.registerAdapter(slackAdapter as any);
    bare.setOutageStateProvider(() => true);
    await bare.dispatch(makeSchedulerSynthItem());
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("existing retry-queue semantics survive the fall-through path", async () => {
    dispatcher.setOutageStateProvider(() => true);
    wsAdapter.deliverBroadcast.mockResolvedValue(0);
    slackAdapter.deliver.mockRejectedValue(new Error("slack down"));
    const retryQueue = { enqueue: vi.fn() };
    dispatcher.setRetryQueue(retryQueue as any);
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(retryQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("never diverts a result carrying an error, even when every other condition holds (review advisory)", async () => {
    dispatcher.setOutageStateProvider(() => true);
    agentManager.runWorkItemTurn.mockResolvedValueOnce({
      finalMessage: "partial output before the failure",
      newSessionId: "s2",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 0,
        costUsd: 0.01,
        durationMs: 800,
      },
      errors: ["tool call failed"],
      llmMs: 0,
      toolMs: 0,
      toolCalls: 0,
      toolSummary: null,
      streamed: false,
      compactions: 0,
    });
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
    expect(slackAdapter.deliver.mock.calls[0][0].error).toBe("tool call failed");
  });

  it("fan-out path (dispatchToAgent, site 2): floor-critical agent's reply diverts to broadcast, the other delivers normally", async () => {
    dispatcher.setOutageStateProvider(() => true);
    const item = makeWorkItem({ text: "Floory, and Jasper, coordinate on this" });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    expect(wsAdapter.deliverBroadcast).toHaveBeenCalledTimes(1);
    expect(wsAdapter.deliverBroadcast.mock.calls[0][0].agentId).toBe("floor-agent");
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
    expect(slackAdapter.deliver.mock.calls[0][0].agentId).toBe("jasper");
  });
});

describe("BroadcastCapableAdapter seam contract (KPR-308)", () => {
  it("a real WsAdapter instance satisfies isBroadcastCapable; a bare mock does not", async () => {
    const { isBroadcastCapable } = await import("./channel-adapter.js");
    const { WsAdapter } = await import("./ws/ws-adapter.js");
    const real = new WsAdapter(0, {
      teamStore: {} as any,
      commandRegistry: {} as any,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]), get: vi.fn() } as any,
      agentManager: { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) } as any,
    });
    expect(isBroadcastCapable(real)).toBe(true);
    expect(isBroadcastCapable(makeMockAdapter() as any)).toBe(false);
  });
});
