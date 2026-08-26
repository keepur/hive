import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "./dispatcher.js";
import type { WorkItem } from "../types/work-item.js";
import { OutageEpisodeTracker } from "../outage/outage-notices.js";

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
  // KPR-388: minimal session-store surface for the read-side delta decision
  // and write-side mark bookkeeping. Tests seed _sessionRefs per
  // "{agentId}:{threadId}"; unseeded agents get undefined ⇒ full injection.
  const sessionRefs = new Map<string, { sessionId?: string; provider?: string; meetingLastSeenTs?: string }>();
  const sessionStore = {
    get: vi
      .fn()
      .mockImplementation(async (agentId: string, threadId: string) => sessionRefs.get(`${agentId}:${threadId}`)),
    setMeetingMark: vi.fn().mockResolvedValue(undefined),
    clearMeetingMark: vi.fn().mockResolvedValue(undefined),
  };
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
    getSessionStore: () => sessionStore,
    providerFor: vi.fn().mockReturnValue("claude"),
    // Dormant breaker surface — only the outage-placement test flips it open.
    circuitBreakers: { stateFor: vi.fn().mockReturnValue({ state: "closed", enabled: true }) },
    _sessionRefs: sessionRefs,
    _sessionStore: sessionStore,
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

  it("round-0 responders are excluded from the reaction-pass roster", async () => {
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    // Round-0: jasper + river respond. Reaction passes: capture roster, select nobody.
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({ respondAgentIds: ["jasper", "river"], costUsd: 0.001, durationMs: 100 })
      .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });

    const item = makeWorkItem({
      text: "Jasper, River, and Jessica, discuss the launch plan",
      source: { kind: "slack", id: "C-CONF", label: "conf-strategy" },
      threadId: "conf-thread-exclusion",
      meta: { slackTs: "1700.0001" },
    });

    await dispatcher.dispatch(item);

    // triggerConferenceReactions is fire-and-forget (dispatch() returns before the
    // reaction pass runs): drain until at least one reaction-pass classifier call
    // happened, then flush the event loop before asserting over ALL reaction calls.
    const reactionCalls = () =>
      (classifyMeetingMessage as any).mock.calls.filter((c: any[]) => c[0] === "Agent response");
    await vi.waitFor(() => {
      expect(reactionCalls().length).toBeGreaterThanOrEqual(1);
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Every reaction-pass roster contains only jessica — never a round-0 primary.
    for (const call of reactionCalls()) {
      const rosterIds = call[1].map((m: any) => m.agentId);
      expect(rosterIds).toEqual(["jessica"]);
    }

    // Each agent ran at most once for this trigger (round-0 only; reactions suppressed).
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    const calledAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]).sort();
    expect(calledAgents).toEqual(["jasper", "river"]);
  });

  it("round-1 reaction prompt frames the peer reply, not the human message", async () => {
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    // Round-0: jasper responds. Reaction pass: jessica reacts to jasper's reply.
    // The trigger must mention BOTH agents — with only jasper in the roster,
    // peerMembers is empty and the reaction pass returns before the classifier.
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
      .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

    const item = makeWorkItem({
      text: "Jasper, and Jessica, please weigh in on the Q3 roadmap",
      source: { kind: "slack", id: "C-CONF", label: "conf-strategy" },
      threadId: "conf-thread-framing",
      meta: { slackTs: "1700.0002" },
    });

    await dispatcher.dispatch(item);

    // Drain the fire-and-forget reaction pass until jessica's round-1 turn ran.
    const round1Call = () =>
      agentManager.runWorkItemTurn.mock.calls.find((c: any[]) => c[1]?.meta?.conferenceRound === 1);
    await vi.waitFor(() => {
      expect(round1Call()).toBeDefined();
    });

    const [reactorId, round1Item] = round1Call()!;
    expect(reactorId).toBe("jessica");
    // Peer reply framed in the terminal slot: responder display name + full reply text.
    // The reply label must carry reactionTo.authorName (display name, not the bare
    // agent id) — a plain toContain("Jasper") would also pass on the preamble alone.
    expect(round1Item.text).toContain("Agent response");
    expect(round1Item.text).toContain("[Jasper just replied]:");
    // Human message absent (fetchThreadHistory is mocked to [], so it cannot leak
    // in via the transcript either) and the [New message] human-slot is gone.
    expect(round1Item.text).not.toContain("please weigh in on the Q3 roadmap");
    expect(round1Item.text).not.toMatch(/\[New message\]:\n/);
  });

  it("round-0 conference prompt assembly is byte-exact (KPR-387 join restructuring pin)", async () => {
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    // Single-agent round-0; reaction pass (if it ever ran) selects nobody.
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
      .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });

    const item = makeWorkItem({
      text: "Jasper, what's the exact prompt shape?",
      source: { kind: "slack", id: "C-CONF", label: "conf-pin" },
      threadId: "conf-thread-pin",
      meta: { slackTs: "1700.0003" },
    });

    await dispatcher.dispatch(item);

    // Round-0 fan-out is awaited inside dispatch(), so by the time dispatch() resolves
    // the single round-0 turn has already run.
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    const [, round0Item] = agentManager.runWorkItemTurn.mock.calls[0];

    // Derived deterministically from Dispatcher.buildMeetingPreamble's literal template,
    // with threadContext empty (fetchThreadHistory is mocked to [], so formatThreadContext
    // returns "" and .filter(Boolean) drops that segment from the join entirely).
    // Pins the full preamble wording too, not just the join — KPR-389's preamble
    // hardening will need to update this expectation deliberately.
    const expectedPreamble = `You are in a meeting in #conf-pin with Jasper.

Meeting rules:
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- If you have nothing meaningful to add, respond with "No response needed."
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;

    expect(round0Item.text).toBe(`${expectedPreamble}\n---\n[New message]:\n${item.text}`);
  });

  describe("delta context injection (KPR-388)", () => {
    // NOTE: continuation lines are deliberately flush-left inside the
    // backticks — the preamble byte pin breaks on any leading whitespace.
    const PREAMBLE = (channel: string, names: string) => `You are in a meeting in #${channel} with ${names}.

Meeting rules:
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- If you have nothing meaningful to add, respond with "No response needed."
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;

    const seedRef = (
      agentId: string,
      threadId: string,
      ref: { sessionId?: string; provider?: string; meetingLastSeenTs?: string },
    ) => agentManager._sessionRefs.set(`${agentId}:${threadId}`, ref);

    // ts drives delta filtering (raw string); timestamp only drives the
    // "(N min ago)" display label — minute granularity keeps byte pins
    // deterministic without fake timers (stable unless the test stalls ~60s).
    const makeHistory = (
      entries: Array<{ author: string; text: string; ts: string; minAgo?: number; isBot?: boolean }>,
    ) =>
      entries.map((e) => ({
        author: e.author,
        text: e.text,
        ts: e.ts,
        timestamp: new Date(Date.now() - (e.minAgo ?? 5) * 60_000),
        isBot: e.isBot ?? false,
      }));

    function soloClassifier() {
      // Round-0 selects jasper; any reaction pass selects nobody.
      return import("../agents/meeting-classifier.js").then(({ classifyMeetingMessage }) => {
        (classifyMeetingMessage as any)
          .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
          .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });
      });
    }

    const THREE_MSG_HISTORY = () =>
      makeHistory([
        { author: "May", text: "old message", ts: "1000.0001", minAgo: 10 },
        { author: "Jasper", text: "old reply", ts: "1000.0002", minAgo: 8, isBot: true },
        { author: "May", text: "newer message", ts: "1000.0003", minAgo: 5 },
      ]);

    it("delta injection: resumable same-provider ref + mark ⇒ only ts>mark messages, byte-exact shape (KPR-388 delta pin)", async () => {
      await soloClassifier();
      const threadId = "conf-thread-delta-pin";
      seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0002" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-delta" },
        threadId,
        meta: { slackTs: "1000.0004" },
      });
      await dispatcher.dispatch(item);

      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];

      // Sibling of the C6 round-0 pin: the delta-mode prompt shape, byte-exact.
      // "old message"/"old reply" (ts <= mark, strictly-greater rule) are gone;
      // the join and terminal slot are identical to full mode.
      const expectedDelta =
        `[Meeting thread in #conf-delta — participants: Jasper]\n` +
        `[New messages since your last turn:]\n\n` +
        `May (5 min ago): newer message`;
      expect(turnItem.text).toBe(
        `${PREAMBLE("conf-delta", "Jasper")}\n${expectedDelta}\n---\n[New message]:\n${item.text}`,
      );
    });

    it.each([
      ["no session row", undefined],
      ["empty handle (codex-shaped row)", { sessionId: undefined, provider: "codex", meetingLastSeenTs: "1000.0002" }],
      ["provider mismatch", { sessionId: "resp_1", provider: "openai", meetingLastSeenTs: "1000.0002" }],
      ["missing mark", { sessionId: "sess-1", provider: "claude" }],
    ])("full injection on read-side miss: %s", async (_label, ref) => {
      await soloClassifier();
      const threadId = `conf-thread-miss-${_label.replace(/\W+/g, "-")}`;
      if (ref) seedRef("jasper", threadId, ref as any);
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-miss" },
        threadId,
        meta: { slackTs: "1000.0004" },
      });
      await dispatcher.dispatch(item);

      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
      // Full transcript: pre-mark content present, delta header absent.
      expect(turnItem.text).toContain("old message");
      expect(turnItem.text).toContain("newer message");
      expect(turnItem.text).not.toContain("[New messages since your last turn:]");
    });

    it("full-mode success advances the mark to max(injected ts, trigger ts)", async () => {
      await soloClassifier();
      const threadId = "conf-thread-mark-full";
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
          threadId,
          meta: { slackTs: "1000.0009" }, // trigger ts > all fetched history — the max-in must win
        }),
      );

      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0009");
      expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
    });

    it("delta-mode success advances the mark to max(injected delta ts, trigger ts)", async () => {
      await soloClassifier();
      const threadId = "conf-thread-mark-delta";
      seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0002" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(
        makeHistory([
          { author: "May", text: "old message", ts: "1000.0001", minAgo: 10 },
          { author: "May", text: "newest message", ts: "1000.0010", minAgo: 2 },
        ]),
      );

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
          threadId,
          meta: { slackTs: "1000.0009" }, // delta max (1000.0010) > trigger — injected max must win
        }),
      );

      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0010");
      expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
    });

    it("suppressed non-response still advances the mark (injection was consumed)", async () => {
      await soloClassifier();
      const threadId = "conf-thread-mark-suppressed";
      agentManager.runWorkItemTurn.mockResolvedValueOnce({
        finalMessage: "No response needed.",
        newSessionId: "s2",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0.01,
          durationMs: 100,
        },
        errors: [],
        llmMs: 0,
        toolMs: 0,
        toolCalls: 0,
        toolSummary: null,
        streamed: false,
        compactions: 0,
      });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
          threadId,
          meta: { slackTs: "1000.0004" },
        }),
      );

      expect(adapter.deliver).not.toHaveBeenCalled(); // suppression semantics intact
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0004");
    });

    it("error and aborted turns leave the mark untouched", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any).mockResolvedValue({
        respondAgentIds: ["jasper"],
        costUsd: 0.001,
        durationMs: 100,
      });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());
      const base = {
        finalMessage: "partial",
        newSessionId: "s2",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0.01,
          durationMs: 100,
        },
        llmMs: 0,
        toolMs: 0,
        toolCalls: 0,
        toolSummary: null,
        streamed: false,
        compactions: 0,
      };

      agentManager.runWorkItemTurn.mockResolvedValueOnce({ ...base, errors: ["boom"] });
      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
          threadId: "conf-thread-mark-error",
          meta: { slackTs: "1000.0004" },
        }),
      );

      agentManager.runWorkItemTurn.mockResolvedValueOnce({ ...base, errors: [], aborted: true });
      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
          threadId: "conf-thread-mark-aborted",
          meta: { slackTs: "1000.0005" },
        }),
      );

      expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalled();
      expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
    });

    it("outage-queued turn never touches the mark", async () => {
      await soloClassifier();
      const threadId = "conf-thread-mark-outage";
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      // Arm the outage seam: open enabled breaker + queue deps.
      agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
      const outageStore = {
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
      dispatcher.setOutageHandling({
        store: outageStore as never,
        episodes: new OutageEpisodeTracker(),
        config: { enabled: true, replayIntervalMs: 15_000, maxAgeHours: 4, maxDepth: 500, maxReplayAttempts: 3 },
      });

      agentManager.runWorkItemTurn.mockResolvedValueOnce({
        finalMessage: "",
        newSessionId: "s2",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0,
          durationMs: 100,
        },
        errors: ["connect ECONNREFUSED api"], // hard fault ⇒ outage path handles the turn
        llmMs: 0,
        toolMs: 0,
        toolCalls: 0,
        toolSummary: null,
        streamed: false,
        compactions: 0,
      });

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
          threadId,
          meta: { slackTs: "1000.0004" },
        }),
      );

      expect(outageStore.enqueue).toHaveBeenCalledTimes(1); // the turn WAS queued...
      expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalled(); // ...and never reached the mark site
      expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
    });

    it("delta into a fresh session clears the mark (resumedSession === false), no set", async () => {
      await soloClassifier();
      const threadId = "conf-thread-clear";
      seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0002" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());
      agentManager.runWorkItemTurn.mockResolvedValueOnce({
        finalMessage: "Agent response",
        newSessionId: "s-fresh",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0.01,
          durationMs: 100,
        },
        errors: [],
        llmMs: 0,
        toolMs: 0,
        toolCalls: 0,
        toolSummary: null,
        streamed: false,
        compactions: 0,
        resumedSession: false, // stale-handle self-heal / auth-rebuild ran the turn fresh
      });

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-clear" },
          threadId,
          meta: { slackTs: "1000.0004" },
        }),
      );

      expect(agentManager._sessionStore.clearMeetingMark).toHaveBeenCalledWith("jasper", threadId);
      expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalled();
    });

    it("C3: round-1 reactor's delta contains the triggering human message (mark predates it)", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-c3-delta";
      // Jessica sat out this trigger (C1/C2) — her mark predates the human message.
      seedRef("jessica", threadId, { sessionId: "sess-j", provider: "claude", meetingLastSeenTs: "1000.0001" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(
        makeHistory([
          { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
          { author: "May", text: "please weigh in on the Q3 roadmap", ts: "1000.0005", minAgo: 5 },
          { author: "Jasper", text: "Agent response", ts: "1000.0006", minAgo: 4, isBot: true },
        ]),
      );

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, please weigh in on the Q3 roadmap",
          source: { kind: "slack", id: "C-CONF", label: "conf-c3" },
          threadId,
          meta: { slackTs: "1000.0005" },
        }),
      );

      const round1Call = () =>
        agentManager.runWorkItemTurn.mock.calls.find((c: any[]) => c[1]?.meta?.conferenceRound === 1);
      await vi.waitFor(() => {
        expect(round1Call()).toBeDefined();
      });
      // Drain the round-1 turn's post-turn bookkeeping too.
      await vi.waitFor(() => {
        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jessica", threadId, "1000.0006");
      });

      const [reactorId, round1Item] = round1Call()!;
      expect(reactorId).toBe("jessica");
      expect(round1Item.text).toContain("[New messages since your last turn:]");
      expect(round1Item.text).toContain("please weigh in on the Q3 roadmap"); // C3 reachability via delta
      expect(round1Item.text).not.toContain("kickoff notes"); // ts == mark ⇒ excluded (strictly-greater pin)
      expect(round1Item.text).toContain("[Jasper just replied]:"); // terminal slot untouched (C3)
    });

    it("C3: round-1 reactor with no session gets the full transcript", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-c3-full";
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(
        makeHistory([
          { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
          { author: "May", text: "please weigh in on the Q3 roadmap", ts: "1000.0005", minAgo: 5 },
        ]),
      );

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, please weigh in on the Q3 roadmap",
          source: { kind: "slack", id: "C-CONF", label: "conf-c3" },
          threadId,
          meta: { slackTs: "1000.0005" },
        }),
      );

      const round1Call = () =>
        agentManager.runWorkItemTurn.mock.calls.find((c: any[]) => c[1]?.meta?.conferenceRound === 1);
      await vi.waitFor(() => {
        expect(round1Call()).toBeDefined();
      });

      const [, round1Item] = round1Call()!;
      expect(round1Item.text).toContain("kickoff notes"); // full transcript carries the whole thread
      expect(round1Item.text).not.toContain("[New messages since your last turn:]");
    });

    it("empty delta drops the context segment — byte-equal to the pinned empty-history join; mark still advances to the trigger", async () => {
      await soloClassifier();
      const threadId = "conf-thread-empty-delta";
      seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0009" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY()); // all ts <= mark

      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-empty" },
        threadId,
        meta: { slackTs: "1000.0010" },
      });
      await dispatcher.dispatch(item);

      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
      // Degenerates to exactly the C6-pinned empty-history shape.
      expect(turnItem.text).toBe(`${PREAMBLE("conf-empty", "Jasper")}\n---\n[New message]:\n${item.text}`);
      // The terminal slot showed the trigger, so the session absorbed it.
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0010");
    });

    // -------------------------------------------------------------------
    // Reviewer pins (pre-PR, fable) — small additions on the same harness.
    // Pins 3 ("resumedSession: undefined on a delta turn ⇒ setMeetingMark,
    // never clearMeetingMark") and 6 (threadId key equality guarding
    // item-vs-effectiveItem drift) are DUPLICATES of assertions already
    // made above and are intentionally skipped:
    //   - Pin 3 is exactly what "delta-mode success advances the mark to
    //     max(injected delta ts, trigger ts)" above asserts: it uses the
    //     default mock (no resumedSession override ⇒ undefined) on a
    //     seedRef'd (delta-mode) thread, and checks setMeetingMark WAS
    //     called while clearMeetingMark was NOT.
    //   - Pin 6 is implicitly covered by every mark test above: each one
    //     asserts `setMeetingMark`/`clearMeetingMark` was called with the
    //     literal `threadId` variable passed into `makeWorkItem`, which is
    //     always distinct from the auto-generated `item.id` (see
    //     `makeWorkItem`'s `msg-${workItemCounter}-${Date.now()}` id) — so
    //     a regression that swapped in `effectiveItem.id` would already
    //     fail e.g. "full-mode success advances the mark..." above.
    // -------------------------------------------------------------------

    it("round-1 has no trigger max-in: reactor's mark is the re-fetched history max, not humanTs (round-0-only max-in)", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-round1-no-maxin";
      // Jessica has no session ⇒ full mode; her high-water calc has no
      // roundZeroTriggerTs carrier at all (round-1 call site omits it).
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(
        makeHistory([
          { author: "May", text: "kickoff", ts: "1000.0001", minAgo: 30 },
          { author: "Jasper", text: "Agent response", ts: "1000.0006", minAgo: 4, isBot: true },
        ]),
      );

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, please weigh in",
          source: { kind: "slack", id: "C-CONF", label: "conf-round1-maxin" },
          threadId,
          meta: { slackTs: "2000.0005" }, // far beyond any ts in the re-fetched history
        }),
      );

      await vi.waitFor(() => {
        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jessica", threadId, "1000.0006");
      });
      // Contrast: round-0 (jasper) DOES max-in the trigger ts (it exceeds the history).
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "2000.0005");
    });

    it("full-mode injection with resumedSession:false still sets the mark — the clear branch is delta-exclusive", async () => {
      await soloClassifier();
      const threadId = "conf-thread-full-resumed-false";
      // No seedRef ⇒ full injection mode.
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());
      agentManager.runWorkItemTurn.mockResolvedValueOnce({
        finalMessage: "Agent response",
        newSessionId: "s-fresh",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0.01,
          durationMs: 100,
        },
        errors: [],
        llmMs: 0,
        toolMs: 0,
        toolCalls: 0,
        toolSummary: null,
        streamed: false,
        compactions: 0,
        resumedSession: false, // would clear on a DELTA turn — full mode must still set
      });

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-full-resumed-false" },
          threadId,
          meta: { slackTs: "1000.0004" },
        }),
      );

      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0004");
      expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
    });

    it("non-conference dispatch never touches the meeting mark", async () => {
      const item = makeWorkItem({
        text: "hey Jasper, help",
        source: { kind: "slack", id: "C123", label: "general" },
      });
      await dispatcher.dispatch(item);

      expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalled();
      expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
    });

    it("codex-shaped ref (sessionId undefined) with a matching provider and a mark still routes full — predicate rule 1 independent of rule 3", async () => {
      await soloClassifier();
      const threadId = "conf-thread-codex-shaped-provider-match";
      // Unlike the miss-matrix's "empty handle" case (provider: codex, which
      // also mismatches the default "claude" providerFor mock), this ref's
      // provider MATCHES — isolating the falsy-sessionId check alone.
      seedRef("jasper", threadId, { sessionId: undefined, provider: "claude", meetingLastSeenTs: "1000.0002" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-codex-shape" },
        threadId,
        meta: { slackTs: "1000.0004" },
      });
      await dispatcher.dispatch(item);

      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
      expect(turnItem.text).toContain("old message");
      expect(turnItem.text).not.toContain("[New messages since your last turn:]");
    });

    it("delta cap: a >100-message delta injects only the last 100; the mark still advances to the true max ts (past the dropped middle)", async () => {
      await soloClassifier();
      const threadId = "conf-thread-delta-cap";
      seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "2000" });

      const entries: Array<{ author: string; text: string; ts: string; minAgo: number }> = [];
      for (let i = 1; i <= 110; i++) {
        entries.push({
          author: "May",
          text: i === 1 ? "UNIQUE_EARLY_DROPPED_MSG" : i === 110 ? "UNIQUE_LATEST_MSG" : `filler message ${i}`,
          ts: String(2000 + i), // 2001..2110, all > mark(2000); integer part keeps ordering collision-free
          minAgo: 111 - i,
        });
      }
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(makeHistory(entries));

      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-delta-cap" },
        threadId,
        meta: { slackTs: "1000.0" }, // below the delta's own max — the delta's ts wins the max-in
      });
      await dispatcher.dispatch(item);

      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
      expect(turnItem.text).not.toContain("UNIQUE_EARLY_DROPPED_MSG"); // dropped by the 100-message cap
      expect(turnItem.text).toContain("UNIQUE_LATEST_MSG"); // retained (most recent)

      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "2110");
    });
  });
});
