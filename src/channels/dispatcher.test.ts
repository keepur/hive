import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "./dispatcher.js";
import type { WorkItem } from "../types/work-item.js";

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
    triage: { enabled: false },
  },
}));

vi.mock("../agents/triage.js", () => ({
  triage: vi.fn(),
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
    source: { kind: "slack", id: "C123", label: "general" },
    sender: "user1",
    timestamp: new Date(),
    ...overrides,
  };
}

function makeMockRegistry() {
  const agents = new Map<string, any>();
  agents.set("mokie", {
    id: "mokie",
    name: "Mokie",
    channels: ["agent-mokie"],
    passiveChannels: ["biz"],
    keywords: [],
    isDefault: true,
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

  return {
    get: (id: string) => agents.get(id),
    getAll: () => Array.from(agents.values()),
    findByChannel: (ch: string) => Array.from(agents.values()).find((a) => a.channels.includes(ch)),
    findByKeyword: (text: string) => {
      const lower = text.toLowerCase();
      return Array.from(agents.values()).find((a) =>
        a.keywords.some((kw: string) => new RegExp(`\\b${kw}\\b`).test(lower)),
      );
    },
    findByName: (text: string) => {
      return Array.from(agents.values()).find((a) => {
        const name = a.name.toLowerCase();
        const pattern = new RegExp(`(?:^|hey\\s+|@)${name}\\b|\\b${name}[,:]`, "i");
        return pattern.test(text);
      });
    },
    findAllByName: (text: string) => {
      return Array.from(agents.values()).filter((a) => {
        const name = a.name.toLowerCase();
        const pattern = new RegExp(`(?:^|hey\\s+|@)${name}\\b|\\b${name}[,:]`, "i");
        return pattern.test(text);
      });
    },
    isPassiveChannel: (ch: string) => Array.from(agents.values()).some((a) => a.passiveChannels.includes(ch)),
    getDefault: () => agents.get("mokie"),
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

    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "mokie");
    dispatcher.registerAdapter(adapter as any);
  });

  it("routes to explicit targetAgentId", async () => {
    const item = makeWorkItem({
      meta: { targetAgentId: "jasper" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("jasper", item);
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

  it("routes by keyword", async () => {
    const item = makeWorkItem({ text: "need help with marketing" });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("river", item);
  });

  it("falls back to default agent", async () => {
    const item = makeWorkItem({ text: "random question" });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("mokie", item);
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
    const item = makeWorkItem({ id: "dedup-same-id" });
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
    const item = makeWorkItem({ text: "random question" });
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
});
