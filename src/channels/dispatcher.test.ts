import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "./dispatcher.js";
import type { WorkItem } from "../types/work-item.js";

// KPR-220 Phase 1: shared mock so tests can assert what dispatcher logs to
// `info` (e.g., per-turn telemetry breakdown — llmMs/toolMs/toolCalls/etc).
// vi.hoisted is required: vi.mock factories run before top-level statements.
const { mockLogInfo } = vi.hoisted(() => ({ mockLogInfo: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Per-turn-spawn flags are read from this object inside dispatcher.getPerTurnFlag.
// Tests can mutate `mockConfig.agentManager.perTurnSpawn.<channel>` between
// dispatches to flip the flag.
const mockConfig: { agentManager: { perTurnSpawn: { sms: boolean; slack: boolean; ws: boolean; voice: boolean } } } = {
  agentManager: { perTurnSpawn: { sms: false, slack: false, ws: false, voice: false } },
};
vi.mock("../config.js", () => ({
  get config() {
    return mockConfig;
  },
}));

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
    sendMessage: vi.fn().mockResolvedValue({
      text: "Agent response",
      costUsd: 0.01,
      durationMs: 1000,
    }),
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
    getSessionStore: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue(undefined),
    }),
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
    expect(agentManager.sendMessage).toHaveBeenCalledWith("executive-assistant", item);
  });

  it("routes to explicit targetAgentId", async () => {
    const item = makeWorkItem({
      meta: { targetAgentId: "jasper" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("jasper", item);
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
    expect(agentManager.sendMessage).toHaveBeenCalledWith("jasper", item);
  });

  it("routes by name mention", async () => {
    const item = makeWorkItem({ text: "hey River, can you help?" });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("river", item);
  });

  it("drops messages with no explicit routing match", async () => {
    const item = makeWorkItem({ text: "need help with marketing" });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });

  it("drops unaddressed messages instead of falling back to default", async () => {
    const item = makeWorkItem({ text: "random question" });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });

  it("drops messages in passive channels without mention", async () => {
    const item = makeWorkItem({
      text: "random chat",
      source: { kind: "slack", id: "C789", label: "biz" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });

  it("deduplicates messages with same ID", async () => {
    const item = makeWorkItem({
      id: "dedup-same-id",
      text: "hey Jasper, help",
    });
    await dispatcher.dispatch(item);
    await dispatcher.dispatch(item); // duplicate
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("maintains thread continuity", async () => {
    // First message in thread routes to River
    const item1 = makeWorkItem({
      id: "thread-msg-1",
      threadId: "thread-1",
      text: "hey River, help me",
    });
    await dispatcher.dispatch(item1);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("river", item1);

    // Second message in same thread should stick with River
    const item2 = makeWorkItem({
      id: "thread-msg-2",
      threadId: "thread-1",
      text: "follow up question",
    });
    await dispatcher.dispatch(item2);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("river", item2);
  });

  it("intercepts status queries and does not call agent", async () => {
    const item = makeWorkItem({ text: "status" });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("suppresses non-response agent output", async () => {
    agentManager.sendMessage.mockResolvedValueOnce({
      text: "no response needed",
      costUsd: 0.01,
      durationMs: 500,
    });
    const item = makeWorkItem({ text: "hey Jasper, check this" });
    await dispatcher.dispatch(item);
    // sendMessage is called, but deliver should NOT be called (non-response suppressed)
    expect(agentManager.sendMessage).toHaveBeenCalled();
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it("routes to agent mentioned in passive channel", async () => {
    const item = makeWorkItem({
      text: "hey Jasper, deploy the thing",
      source: { kind: "slack", id: "C789", label: "biz" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("jasper", item);
  });

  it("fans out to multiple agents when several are named", async () => {
    const item = makeWorkItem({
      text: "Jasper, and River, coordinate on this",
    });
    await dispatcher.dispatch(item);
    // Both agents should be called
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.sendMessage.mock.calls.map((c: any[]) => c[0]);
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
    expect(agentManager.sendMessage).toHaveBeenCalledWith("executive-assistant", item);
  });

  it("does not fall back for non-DM channels with no match", async () => {
    const item = makeWorkItem({
      text: "random chatter",
      source: { kind: "slack", id: "C999", label: "random" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
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

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.sendMessage.mock.calls.map((c: any[]) => c[0]);
    expect(calledAgents).toContain("jasper");
    expect(calledAgents).toContain("river");

    // Follow-up in same thread (no mentions) should still fan out to both
    agentManager.sendMessage.mockClear();
    const item2 = makeWorkItem({
      id: "multi-2",
      threadId: "thread-multi",
      text: "any updates?",
    });
    await dispatcher.dispatch(item2);

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(2);
    const followUpAgents = agentManager.sendMessage.mock.calls.map((c: any[]) => c[0]);
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
    expect(agentManager.sendMessage).toHaveBeenCalledWith("river", item1);

    // Mention a second agent in the same thread
    agentManager.sendMessage.mockClear();
    const item2 = makeWorkItem({
      id: "trans-2",
      threadId: "thread-transition",
      text: "Jasper, can you weigh in?",
    });
    await dispatcher.dispatch(item2);

    // Both River (original) and Jasper (new) should be called
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.sendMessage.mock.calls.map((c: any[]) => c[0]);
    expect(calledAgents).toContain("river");
    expect(calledAgents).toContain("jasper");

    // Follow-up should continue to fan out
    agentManager.sendMessage.mockClear();
    const item3 = makeWorkItem({
      id: "trans-3",
      threadId: "thread-transition",
      text: "thoughts?",
    });
    await dispatcher.dispatch(item3);
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not transition when re-mentioning the same agent", async () => {
    const item1 = makeWorkItem({
      id: "same-1",
      threadId: "thread-same",
      text: "hey River, help me",
    });
    await dispatcher.dispatch(item1);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("river", item1);

    // Re-mention River — should stay single-agent
    agentManager.sendMessage.mockClear();
    const item2 = makeWorkItem({
      id: "same-2",
      threadId: "thread-same",
      text: "River, one more thing",
    });
    await dispatcher.dispatch(item2);
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("river", item2);
  });

  it("adds new participants to existing multi-agent thread", async () => {
    // Start multi-agent with Jasper + River
    const item1 = makeWorkItem({
      id: "add-1",
      threadId: "thread-add",
      text: "Jasper, and River, discuss this",
    });
    await dispatcher.dispatch(item1);
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(2);

    // Now mention Rae — should add to participant set
    agentManager.sendMessage.mockClear();
    const item2 = makeWorkItem({
      id: "add-2",
      threadId: "thread-add",
      text: "Rae, join us",
    });
    await dispatcher.dispatch(item2);

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(3);
    const calledAgents = agentManager.sendMessage.mock.calls.map((c: any[]) => c[0]);
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

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.sendMessage.mock.calls.map((c: any[]) => c[0]);
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

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("river", item);
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
      expect(agentManager.sendMessage).toHaveBeenCalledTimes(2);

      // Advance time past the TTL, then sweep
      vi.advanceTimersByTime(1000);
      const result = dispatcher.sweep(500);
      expect(result.pruned).toBeGreaterThanOrEqual(1);

      // Next message in that thread should not fan out (affinity lost)
      agentManager.sendMessage.mockClear();
      agentManager.findAgentsForThread.mockResolvedValue([]);
      const item2 = makeWorkItem({
        id: "sweep-2",
        threadId: "thread-sweep",
        text: "hello?",
      });
      await dispatcher.dispatch(item2);
      // Falls through — no match, message dropped (no default fallback)
      expect(agentManager.sendMessage).not.toHaveBeenCalled();
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
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("jasper", item);
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
    agentManager.sendMessage.mockClear();
    const item2 = makeWorkItem({
      id: "target-2",
      threadId: "thread-target",
      text: "callback response",
      meta: { targetAgentId: "jasper" },
    });
    await dispatcher.dispatch(item2);

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("jasper", item2);
  });
});

// ---------------------------------------------------------------------------
// KPR-223: per-turn-spawn routing tests (dispatcher branches into spawnTurn
// when the per-channel flag is on). Plus routeVoiceTurn behavior.
// ---------------------------------------------------------------------------

describe("Per-turn-spawn routing (KPR-223)", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    // Reset all per-channel flags between tests.
    mockConfig.agentManager.perTurnSpawn.sms = false;
    mockConfig.agentManager.perTurnSpawn.slack = false;
    mockConfig.agentManager.perTurnSpawn.ws = false;
    mockConfig.agentManager.perTurnSpawn.voice = false;

    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    const healthReporter = makeMockHealthReporter();
    adapter = makeMockAdapter();

    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(adapter as any);
  });

  it("routes to spawnTurn when per-turn flag is on (sms)", async () => {
    mockConfig.agentManager.perTurnSpawn.sms = true;
    // SMS adapter mock — id="sms", kind="sms"
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);

    const item = makeWorkItem({
      source: { kind: "sms", id: "PN_LINE_X", label: "quo-may", adapterId: "sms" },
      threadId: "sms:PN_LINE_X:+15550001",
      text: "hey Jasper, ping",
    });
    await dispatcher.dispatch(item);

    expect(agentManager.spawnTurn).toHaveBeenCalledTimes(1);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    const ctx = agentManager.spawnTurn.mock.calls[0]![0];
    expect(ctx.agentId).toBe("jasper");
    expect(ctx.channel).toBe("sms");
    expect(ctx.channelId).toBe("PN_LINE_X");
    expect(ctx.threadId).toBe("sms:PN_LINE_X:+15550001");
  });

  it("uses sendMessage when per-turn flag is off (sms)", async () => {
    mockConfig.agentManager.perTurnSpawn.sms = false;
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);

    const item = makeWorkItem({
      source: { kind: "sms", id: "PN_LINE_Y", label: "quo-may", adapterId: "sms" },
      text: "hey Jasper, ping",
    });
    await dispatcher.dispatch(item);

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(agentManager.spawnTurn).not.toHaveBeenCalled();
  });

  it("fan-out path uses spawnTurn when flag on", async () => {
    mockConfig.agentManager.perTurnSpawn.slack = true;

    // Use "random" — not bound to any agent's channels so the dedicated-channel
    // shortcut doesn't fire and resolveAgents falls into the name-mention branch.
    const item = makeWorkItem({
      source: { kind: "slack", id: "C-FANOUT", label: "random" },
      text: "Jasper, and River, coordinate",
    });
    await dispatcher.dispatch(item);

    // Fan-out path — both Jasper and River are spawned via spawnTurn.
    expect(agentManager.spawnTurn).toHaveBeenCalledTimes(2);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    const calledAgents = agentManager.spawnTurn.mock.calls.map((c: any[]) => c[0].agentId);
    expect(calledAgents).toContain("jasper");
    expect(calledAgents).toContain("river");
  });

  it("routeVoiceTurn calls spawnTurn with correct ctx", async () => {
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
    const [passedCtx, passedOnStream] = agentManager.spawnTurn.mock.calls[0]!;
    expect(passedCtx).toBe(ctx);
    expect(passedOnStream).toBe(onStream);
  });

  it("routes WS team WorkItem (kind=team, adapterId=ws) through spawnTurn when perTurnSpawn.ws=true (KPR-224 F1)", async () => {
    mockConfig.agentManager.perTurnSpawn.ws = true;
    // WS adapter mock — id="ws", kind="app". Same physical adapter handles
    // both kind:"app" device WorkItems and kind:"team" channel WorkItems
    // (DMs / channels). Dispatcher resolves the adapter via adapterId.
    const wsAdapter = { ...makeMockAdapter(), id: "ws", kind: "app" as const };
    dispatcher.registerAdapter(wsAdapter as any);

    const item = makeWorkItem({
      // kind:"team" with adapterId:"ws" → same WS adapter, must follow ws flag.
      source: { kind: "team", id: "team:dm:user-1", label: "team:dm:user-1", adapterId: "ws" },
      threadId: "team:dm:user-1",
      text: "hey Jasper, ping",
      // targetAgentId short-circuits resolveAgents (the team-routing path
      // requires a teamStore mock; for this F1 regression test we only care
      // about the per-turn flag check, not team-channel resolution).
      meta: { targetAgentId: "jasper" },
    });
    await dispatcher.dispatch(item);

    expect(agentManager.spawnTurn).toHaveBeenCalledTimes(1);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });

  it("KPR-220 Phase 1: per-turn dispatch propagates non-zero llmMs/toolMs/toolCalls into the work-item-dispatched log", async () => {
    mockConfig.agentManager.perTurnSpawn.sms = true;
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);

    // Override the default spawnTurn mock with a TurnResult carrying real
    // execution metrics. Pre-Phase-1 the dispatcher zeroed these on the way
    // out because TurnResult had no shape for them; post-Phase-1 they pass
    // through into the RunResult that drives the `Work item dispatched` log.
    agentManager.spawnTurn.mockResolvedValueOnce({
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

    expect(agentManager.spawnTurn).toHaveBeenCalledTimes(1);

    const logCall = mockLogInfo.mock.calls.find(
      ([msg]) => msg === "Work item dispatched",
    );
    expect(logCall).toBeDefined();
    const fields = logCall![1] as Record<string, unknown>;
    expect(fields.llmMs).toBe(999);
    expect(fields.toolMs).toBe(333);
    expect(fields.toolCalls).toBe(7);
    expect(fields.toolSummary).toBe("memory:1x");
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
    expect(agentManager.sendMessage).toHaveBeenCalledWith("production-support", item);
  });

  it("drops when origin is unknown", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hi",
      meta: { origin: "nonexistent", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });

  it("origin wins over name addressing", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hey Jasper can you check this",
      meta: { origin: "dodi-shop", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("production-support", item);
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
    expect(agentManager.sendMessage).toHaveBeenCalledWith("jasper", item);
    expect(findByOriginSpy).not.toHaveBeenCalled();
  });

  it("explicit targetAgentId beats origin", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "please handle this",
      meta: { origin: "dodi-shop", targetAgentId: "executive-assistant", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("executive-assistant", item);
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
