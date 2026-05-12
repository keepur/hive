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

vi.mock("../agents/meeting-classifier.js", () => ({
  classifyMeetingMessage: vi.fn().mockResolvedValue({
    respondAgentIds: ["jasper"],
    costUsd: 0.001,
    durationMs: 100,
  }),
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
    soul: "Receptionist and default router for DodiHome\nRoutes messages to specialists.",
    title: "Receptionist",
    channels: ["general", "agent-rae"],
    passiveChannels: [],
    keywords: [],
    homeBase: "agent-rae",
    isDefault: true,
  });
  agents.set("jasper", {
    id: "jasper",
    name: "Jasper",
    soul: "VP of Engineering at DodiHome\nManages engineering backlog and deploys.",
    title: "VP Engineering",
    channels: ["agent-jasper"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
  });
  agents.set("river", {
    id: "river",
    name: "River",
    soul: "Marketing Manager at DodiHome\nHandles lead gen and content.",
    title: "Marketing Manager",
    channels: ["agent-river"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
  });
  agents.set("jessica", {
    id: "jessica",
    name: "Jessica",
    soul: "Customer Success Manager at DodiHome\nManages CRM and follow-ups.",
    title: "Customer Success",
    channels: ["agent-jessica"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
  });
  agents.set("chief-of-staff", {
    id: "chief-of-staff",
    name: "Mokie",
    soul: "Chief of Staff\nCoordinates across teams.",
    title: "Chief of Staff",
    channels: ["agent-mokie"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    disabled: true,
  });

  return {
    get: (id: string) => agents.get(id),
    getAll: () => Array.from(agents.values()),
    findByChannel: (ch: string) => Array.from(agents.values()).find((a) => !a.disabled && a.channels.includes(ch)),
    findByOrigin: (_slug: string) => undefined,
    findByKeyword: (_text: string) => undefined,
    findByName: (text: string) => {
      const matchesName = (name: string, t: string) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`(?:^|hey\\s+|@)${escaped}\\b|\\b${escaped}[,:]`, "i");
        return pattern.test(t);
      };
      return Array.from(agents.values()).find((a) => {
        if (a.disabled) return false;
        return matchesName(a.name, text);
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
        return matchesName(a.name, text);
      });
    },
    isPassiveChannel: (_ch: string) => false,
    getDefault: () => agents.get("executive-assistant"),
  };
}

function makeMockAgentManager() {
  return {
    runWorkItemTurn: vi.fn().mockResolvedValue({
      finalMessage: "Agent response",
      newSessionId: "s2",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 0,
        costUsd: 0.01,
        durationMs: 1000,
      },
      errors: [],
      llmMs: 0,
      toolMs: 0,
      toolCalls: 0,
      toolSummary: null,
      streamed: false,
      compactions: 0,
    }),
    findAgentForThread: vi.fn().mockResolvedValue(null),
    findAgentsForThread: vi.fn().mockResolvedValue([]),
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

function makeMockSlackAdapter() {
  return {
    fetchThreadHistory: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Conference routing tests
// ---------------------------------------------------------------------------

describe("Conference channel routing", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;
  let mockSlackAdapter: ReturnType<typeof makeMockSlackAdapter>;

  beforeEach(async () => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    const healthReporter = makeMockHealthReporter();
    adapter = makeMockAdapter();
    mockSlackAdapter = makeMockSlackAdapter();

    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(adapter as any);
    dispatcher.setSlackAdapter(mockSlackAdapter as any);
  });

  it("routes conference channel message through classifier", async () => {
    const item = makeWorkItem({
      text: "Jasper, what's the engineering status?",
      source: { kind: "slack", id: "C-CONF", label: "conf-strategy" },
      meta: { slackTs: "1234.5678" },
    });
    await dispatcher.dispatch(item);

    // The classifier mock returns ["jasper"], so sendMessage should be called for jasper
    // with the conference-enriched item (context injected)
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith(
      "jasper",
      expect.objectContaining({
        source: item.source,
        sender: item.sender,
        meta: expect.objectContaining({
          conferenceMode: true,
          conferenceRound: 0,
          conferenceHumanTs: "1234.5678",
        }),
      }),
    );
    // Verify the original text is included in the enriched text
    const enrichedItem = agentManager.runWorkItemTurn.mock.calls[0][1];
    expect(enrichedItem.text).toContain("Jasper, what's the engineering status?");
    expect(enrichedItem.text).toContain("Meeting rules:");
  });

  it("non-conference channels skip conference routing", async () => {
    const item = makeWorkItem({
      text: "hey Jasper, help",
      source: { kind: "slack", id: "C123", label: "general" },
    });
    await dispatcher.dispatch(item);

    // Should route via normal channel mapping (general -> executive-assistant)
    // but text mentions Jasper so name routing wins
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledWith("executive-assistant", item);
  });

  it("empty roster returns no agents", async () => {
    // No agent names mentioned in the text
    const item = makeWorkItem({
      text: "hello everyone, how is it going?",
      source: { kind: "slack", id: "C-CONF", label: "conf-strategy" },
      meta: { slackTs: "1234.5678" },
    });
    await dispatcher.dispatch(item);

    // No names matched → empty roster → no agents dispatched
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("conference fan-out does not write to threadParticipants", async () => {
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");

    // First call: round-0 returns both agents
    // Subsequent calls (peer reactions): return empty to suppress depth-1
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({
        respondAgentIds: ["jasper", "river"],
        costUsd: 0.001,
        durationMs: 100,
      })
      // peer reaction classifiers return empty (no depth-1 reactions)
      .mockResolvedValue({
        respondAgentIds: [],
        costUsd: 0.001,
        durationMs: 100,
      });

    const item = makeWorkItem({
      text: "Jasper, and River, discuss the strategy",
      source: { kind: "slack", id: "C-CONF", label: "conf-strategy" },
      threadId: "conf-thread-1",
      meta: { slackTs: "1234.5678" },
    });

    await dispatcher.dispatch(item);

    // Round-0 dispatches to jasper and river
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]);
    expect(calledAgents).toContain("jasper");
    expect(calledAgents).toContain("river");

    // Verify it does NOT use threadParticipants by dispatching a follow-up
    // in the same thread without new names — conference routing should re-evaluate
    // through the classifier with the persisted roster, not threadParticipants
    agentManager.runWorkItemTurn.mockClear();
    (classifyMeetingMessage as any).mockResolvedValueOnce({
      respondAgentIds: ["jasper"],
      costUsd: 0.001,
      durationMs: 100,
    });

    const item2 = makeWorkItem({
      text: "any updates on that?",
      source: { kind: "slack", id: "C-CONF", label: "conf-strategy" },
      threadId: "conf-thread-1",
      meta: { slackTs: "1234.9999" },
    });
    await dispatcher.dispatch(item2);

    // Should go through conference path again (classifier decides), not threadParticipants
    // The roster was already built from the first message (jasper + river),
    // so the classifier is called with that roster, and returns just jasper
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    const enrichedItem2 = agentManager.runWorkItemTurn.mock.calls[0][1];
    expect(enrichedItem2.meta).toEqual(expect.objectContaining({ conferenceMode: true, conferenceRound: 0 }));
    expect(enrichedItem2.text).toContain("any updates on that?");
  });

  it("disabled agents are filtered from roster", async () => {
    // Mention Mokie (disabled) and Jasper in conference channel
    const item = makeWorkItem({
      text: "Mokie, and Jasper, what do you think?",
      source: { kind: "slack", id: "C-CONF", label: "conf-planning" },
      meta: { slackTs: "1234.5678" },
    });

    // The classifier should only receive Jasper in roster (Mokie is disabled)
    // Mock returns jasper
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    (classifyMeetingMessage as any).mockResolvedValueOnce({
      respondAgentIds: ["jasper"],
      costUsd: 0.001,
      durationMs: 100,
    });

    await dispatcher.dispatch(item);

    // Verify classifier was called with only jasper in roster (Mokie filtered)
    expect(classifyMeetingMessage).toHaveBeenCalledWith(
      item.text,
      expect.arrayContaining([expect.objectContaining({ agentId: "jasper" })]),
      expect.any(String),
    );

    // Verify Mokie is NOT in the roster passed to classifier
    const callArgs = (classifyMeetingMessage as any).mock.calls[0];
    const roster = callArgs[1];
    expect(roster.every((r: any) => r.agentId !== "chief-of-staff")).toBe(true);

    const enrichedItem = agentManager.runWorkItemTurn.mock.calls[0][1];
    expect(enrichedItem.meta).toEqual(expect.objectContaining({ conferenceMode: true, conferenceRound: 0 }));
    expect(enrichedItem.text).toContain("Mokie, and Jasper, what do you think?");
  });

  it("delivers agent response to the conference channel", async () => {
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    // Reset to known state: round-0 returns jasper, peer reactions return empty
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({
        respondAgentIds: ["jasper"],
        costUsd: 0.001,
        durationMs: 100,
      })
      .mockResolvedValue({
        respondAgentIds: [],
        costUsd: 0.001,
        durationMs: 100,
      });

    const item = makeWorkItem({
      text: "Jasper, what's the deploy schedule?",
      source: { kind: "slack", id: "C-CONF", label: "conf-engineering" },
      meta: { slackTs: "1234.5678" },
    });
    await dispatcher.dispatch(item);

    // Agent responds with text, should be delivered back
    expect(adapter.deliver).toHaveBeenCalled();
  });
});
