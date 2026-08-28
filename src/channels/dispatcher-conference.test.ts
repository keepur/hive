import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Dispatcher } from "./dispatcher.js";
import type { WorkItem } from "../types/work-item.js";
import { OutageEpisodeTracker } from "../outage/outage-notices.js";
import { deadlineContinuationWrap, MAX_DEADLINE_CONTINUATIONS } from "./deadline-continuation.js";

// KPR-389 C5: the suppression log lines carry the `conferenceRound` tag that is
// the measurement numerator, so tests must be able to read what dispatcher logs
// to `info`. vi.hoisted is required: vi.mock factories run before top-level
// statements. (Same shape as dispatcher.test.ts.) `vi.clearAllMocks()` in the
// suite beforeEach resets it between tests.
const { mockLogInfo } = vi.hoisted(() => ({ mockLogInfo: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: mockLogInfo,
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
    turnDeadlineUpperBoundMs: vi.fn().mockReturnValue(900_000),
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

  // Hoisted out of the delta describe (KPR-413 T1 needs it too — it pins the
  // continuation leg's frame byte-exactly).
  // NOTE: continuation lines are deliberately flush-left inside the
  // backticks — the preamble byte pin breaks on any leading whitespace.
  // KPR-389 D4: deliberate C10 pin update (see C6 note above).
  const PREAMBLE = (channel: string, names: string) => `You are in a meeting in #${channel} with ${names}.

Meeting rules:
- The discussion so far is already in this prompt and your session context — do NOT re-read the channel, search the workspace, or re-orient with tools before speaking.
- If you have nothing meaningful to add, reply "No response needed." immediately — as your first output, with no tool calls first.
- Only use a tool if your reply genuinely needs information that is not already in this thread — never to re-read the meeting itself.
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;

  // Hoisted out of the delta describe (KPR-389 T8 needs it too — it only
  // touches the classifier mock).
  function soloClassifier() {
    // Round-0 selects jasper; any reaction pass selects nobody.
    return import("../agents/meeting-classifier.js").then(({ classifyMeetingMessage }) => {
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });
    });
  }

  /**
   * KPR-416: the tracker is the eligibility STATE under test, so the write-
   * site cases read it directly rather than inferring it from a downstream
   * reaction pass. The behavioral pins (T1, T3, T9) assert through
   * triggerConferenceReactions instead. Same `dispatcher as unknown as {...}`
   * convention as the T6/C4 guard below.
   */
  const excludedFor = (threadId: string, humanTs: string): Set<string> | undefined =>
    (
      dispatcher as unknown as {
        meetingReactionTracker: Map<string, Map<string, Set<string>>>;
      }
    ).meetingReactionTracker
      .get(threadId)
      ?.get(humanTs);

  const zeroUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindow: 0,
    costUsd: 0,
    durationMs: 100,
  };
  function turn(overrides: Record<string, unknown> = {}) {
    return {
      finalMessage: "Agent response",
      newSessionId: "s2",
      usage: zeroUsage,
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

  /**
   * Deterministic barrier for the fire-and-forget reaction pass (plan-review
   * r1 note). `waitFor(runWorkItemTurn × 2)` alone is NOT enough: everything
   * downstream of the reactor's turn resolution — the D5 guard and the
   * delivery it suppresses — is a pure microtask chain (all harness mocks
   * resolve immediately, no timers), so the deliver-count assert can run
   * before it. One macrotask boundary drains the whole chain, because the
   * microtask queue is fully emptied before the next macrotask. Negative-
   * verified: with the D5 guard disabled these tests fail in ~3ms.
   */
  const settleReactions = () => new Promise((r) => setTimeout(r, 0));

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
    // KPR-389 D4: deliberate C6 pin update — this is the only ticket licensed
    // to edit this literal (epic canon C6). Full-join byte identity retained.
    const expectedPreamble = `You are in a meeting in #conf-pin with Jasper.

Meeting rules:
- The discussion so far is already in this prompt and your session context — do NOT re-read the channel, search the workspace, or re-orient with tools before speaking.
- If you have nothing meaningful to add, reply "No response needed." immediately — as your first output, with no tool calls first.
- Only use a tool if your reply genuinely needs information that is not already in this thread — never to re-read the meeting itself.
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;

    expect(round0Item.text).toBe(`${expectedPreamble}\n---\n[New message]:\n${item.text}`);
  });

  it("T6 (C4 guard): a double-quoted escape phrase in the preamble matches NON_RESPONSE_PATTERNS", () => {
    // Local mirror of dispatcher.ts NON_RESPONSE_PATTERNS — same deliberate-copy
    // convention as dispatcher.test.ts:273 (the pin IS the point: widen-or-match
    // is enforced by this test failing on any preamble rewording).
    const NON_RESPONSE_PATTERNS = [
      /^no response (requested|needed|required|necessary)\.?$/i,
      /^\(no response\)$/i,
      /^n\/a\.?$/i,
    ];
    const preamble = (
      dispatcher as unknown as {
        buildMeetingPreamble(
          c: string,
          r: Array<{ agentId: string; name: string; title?: string; role: string }>,
        ): string;
      }
    ).buildMeetingPreamble("x", [{ agentId: "jasper", name: "Jasper", role: "VP Engineering" }]);
    const quoted = [...preamble.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.some((p) => NON_RESPONSE_PATTERNS.some((rx) => rx.test(p!.trim())))).toBe(true);
  });

  it("T5 (KPR-416): the exclusion write precedes BOTH the fan-out delivery and the reaction trigger", () => {
    // Structural, not a race test. Post-KPR-416 the window between the write
    // and the two call sites is zero BY CONSTRUCTION — the write is a
    // synchronous statement immediately preceding both — so a timing/
    // microtask test here would be theater. This is a drift catcher: a later
    // refactor that moves the write below either call fails it.
    // Text-scan (same technique as src/boot-order.test.ts), with `//` line
    // comments stripped so prose mentioning the call cannot false-positive.
    const source = readFileSync(fileURLToPath(new URL("./dispatcher.ts", import.meta.url)), "utf8");
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

    // Bound the scan to the fan-out `else` branch of dispatchToAgent, so the
    // single-dispatch call site (write site 2, earlier in the file) can never
    // stand in for a fan-out write that was moved or deleted.
    const blockStart = codeOnly.indexOf('log.info("Non-response suppressed (fan-out)"');
    const blockEnd = codeOnly.indexOf('log.info("Fan-out dispatch complete"');
    expect(blockStart, "fan-out branch anchor not found — update this test's anchors").toBeGreaterThan(-1);
    expect(blockEnd, "fan-out branch end anchor not found — update this test's anchors").toBeGreaterThan(blockStart);
    const block = codeOnly.slice(blockStart, blockEnd);

    const markIdx = block.indexOf("this.markReactionExclusion(");
    const deliverIdx = block.indexOf("await this.deliverAgentResult(workResult, adapter);");
    const triggerIdx = block.indexOf("this.triggerConferenceReactions(");
    expect(markIdx, "markReactionExclusion is not called in the fan-out delivery branch").toBeGreaterThan(-1);
    expect(deliverIdx).toBeGreaterThan(-1);
    expect(triggerIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeLessThan(deliverIdx);
    expect(deliverIdx).toBeLessThan(triggerIdx);
  });

  it.each([
    ["empty text delivering the _No response._ placeholder", { finalMessage: "" }, "_No response._"],
    [
      "error WITH text (exit-code-1 convention)",
      { finalMessage: "Partial answer", errors: ["exit 1"] },
      "Partial answer",
    ],
  ])(
    "T6 (KPR-416): a round-0 turn that %s stays excluded (predicate is branch position, not 'real content')",
    async (_label, flags, expectedText) => {
      // Disposition (a), spec §6.1. Neither shape matches NON_RESPONSE_PATTERNS,
      // so both land in the delivering `else` — under branch position the write
      // FIRES for them, keeping them excluded. Passes pre- and post-fix (before
      // the relocation the selection-time write covered them); it is the pin
      // that stops a future "genuinely non-empty non-errored content" predicate
      // silently re-including them.
      await soloClassifier();
      const threadId = `conf-thread-kpr416-t6-${String(_label).replace(/\W+/g, "-")}`;
      // Spread form, consistent with the KPR-389 D5 it.each above (:625);
      // both `turn(flags)` and `turn({ ...flags })` typecheck here since
      // vitest infers `flags` per-position, not as a cross-row union.
      agentManager.runWorkItemTurn.mockResolvedValueOnce(turn({ ...flags }));

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t6" },
          threadId,
          meta: { slackTs: "1700.0006" },
        }),
      );
      await settleReactions();

      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe(expectedText);
      expect(excludedFor(threadId, "1700.0006")).toEqual(new Set(["jasper"]));
    },
  );

  describe("round-1 kill suppression (KPR-389 D5)", () => {
    async function twoAgentClassifier() {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });
    }
    function confItem(threadId: string) {
      return makeWorkItem({
        text: "Jasper, and Jessica, please weigh in",
        source: { kind: "slack", id: "C-CONF", label: "conf-kill" },
        threadId,
        meta: { slackTs: "1700.0001" },
      });
    }
    it.each([
      ["aborted", { aborted: true }],
      ["timedOut", { timedOut: true, aborted: true }],
      ["timedOut with progress", { timedOut: true, aborted: true, toolCalls: 46, streamed: true }],
    ])("killed round-1 reaction (%s) never delivers; mark untouched for the reactor", async (_label, flags) => {
      await twoAgentClassifier();
      agentManager.runWorkItemTurn
        .mockResolvedValueOnce(turn()) // jasper round-0: real reply
        .mockResolvedValueOnce(turn({ finalMessage: "", ...flags })); // jessica round-1: killed
      await dispatcher.dispatch(confItem(`conf-kill-${_label}`));
      await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
      await settleReactions();
      // KPR-413 T4: pins the D5-before-deadline-abort-arm ordering
      // established at the epic's main-sync (705f9f9) — a killed round-1
      // reaction must never reach maybeHandleDeadlineAbort and produce a
      // continuation dispatch, even when it has observed progress (the
      // one case that could otherwise redispatch). Only the third
      // ("timedOut with progress") case exercises this meaningfully; the
      // other two never reach the arm's own gate regardless of D5's
      // position, so the assertion is trivially true for them.
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
      expect(adapter.deliver).toHaveBeenCalledTimes(1); // only jasper's round-0 reply
      expect(adapter.deliver.mock.calls[0][0].agentId).toBe("jasper");
      expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalledWith(
        "jessica",
        expect.anything(),
        expect.anything(),
      );
    });

    // KPR-389 C5 numerator pin (round-1 arm). The kill tests above take the D5
    // early return, which logs a different line — no existing test drove the
    // tagged fan-out suppression log at round 1, so this one does: a reactor
    // that answers with a non-response phrase.
    it("C5 pin: a round-1 non-response suppression logs conferenceRound: 1", async () => {
      await twoAgentClassifier();
      agentManager.runWorkItemTurn
        .mockResolvedValueOnce(turn()) // jasper round-0: real reply
        .mockResolvedValueOnce(turn({ finalMessage: "No response needed." })); // jessica round-1
      await dispatcher.dispatch(confItem("conf-kill-nonresponse"));
      await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
      await settleReactions();
      expect(adapter.deliver).toHaveBeenCalledTimes(1); // only jasper's round-0 reply
      expect(mockLogInfo).toHaveBeenCalledWith(
        "Non-response suppressed (fan-out)",
        expect.objectContaining({ agentId: "jessica", conferenceRound: 1 }),
      );
    });

    it("errored round-1 reaction WITH text still delivers (exit-code-1 convention)", async () => {
      await twoAgentClassifier();
      agentManager.runWorkItemTurn
        .mockResolvedValueOnce(turn())
        .mockResolvedValueOnce(turn({ finalMessage: "Real answer with a warning", errors: ["exit 1"] }));
      await dispatcher.dispatch(confItem("conf-kill-errtext"));
      await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(adapter.deliver).toHaveBeenCalledTimes(2));
      expect(adapter.deliver.mock.calls[1][0].text).toBe("Real answer with a warning");
    });

    it("control: a killed ROUND-0 turn keeps today's delivery behavior (filler delivered)", async () => {
      await soloClassifier(); // round-0 jasper only, reaction pass selects nobody
      agentManager.runWorkItemTurn.mockResolvedValueOnce(turn({ finalMessage: "", aborted: true }));
      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-kill-r0" },
          threadId: "conf-kill-r0",
          meta: { slackTs: "1700.0002" },
        }),
      );
      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe("_No response._");
    });

    describe("deadline-continuation legs carry the turn's own frame, not the conference transcript (KPR-413)", () => {
      const ONE_MSG_HISTORY = () => [
        {
          author: "May",
          text: "earlier meeting context",
          timestamp: new Date(Date.now() - 5 * 60_000),
          isBot: false,
          ts: "1000.0001",
        },
      ];
      const ABORT_WITH_PROGRESS = turn({
        finalMessage: "",
        timedOut: true,
        aborted: true,
        toolCalls: 46,
        streamed: true,
      });

      it("T1: continuation text is the turn's frame, not the composite (byte-exact)", async () => {
        await soloClassifier();
        const threadId = "conf-thread-kpr413-t1";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValueOnce(ABORT_WITH_PROGRESS);

        const item = makeWorkItem({
          text: "Jasper, status update?",
          source: { kind: "slack", id: "C-CONF", label: "conf-kpr413" },
          threadId,
          meta: { slackTs: "1000.0004" },
        });
        await dispatcher.dispatch(item);
        await settleReactions();

        const expectedFrame = `${PREAMBLE("conf-kpr413", "Jasper")}\n---\n[New message]:\n${item.text}`;
        const secondCallItem = agentManager.runWorkItemTurn.mock.calls[1][1];
        expect(secondCallItem.text).toBe(deadlineContinuationWrap(expectedFrame, 1, MAX_DEADLINE_CONTINUATIONS + 1));
      });

      it("T2: continuation leg carries no conference meta", async () => {
        await soloClassifier();
        const threadId = "conf-thread-kpr413-t2";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValueOnce(ABORT_WITH_PROGRESS);

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr413" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );
        await settleReactions();

        const secondCallItem = agentManager.runWorkItemTurn.mock.calls[1][1];
        expect(secondCallItem.meta.deadlineRetry).toBe(1);
        expect(secondCallItem.meta.targetAgentId).toBeDefined();
        expect(secondCallItem.meta.deadlineOriginalText).not.toContain("[Meeting thread in #");
        expect(secondCallItem.meta.conferenceMode).toBeUndefined();
        expect(secondCallItem.meta.conferenceRound).toBeUndefined();
        expect(secondCallItem.meta.conferenceHumanTs).toBeUndefined();
        expect(secondCallItem.meta.conferenceInjectionMode).toBeUndefined();
      });

      it("T8a (KPR-416): the continuation leg carries meetingExclusionTs and still none of the four conference keys", async () => {
        // Sibling of T2 above, not a replacement — T2 stays byte-identical.
        // The key is deliberately named outside the `conference*` family so
        // it survives KPR-413's blocklist strip; that survival is exactly
        // what lets write site 2 mark exclusion on the leg's own delivery
        // (T8b). Spec §5.2 / §6.3.
        await soloClassifier();
        const threadId = "conf-thread-kpr416-t8a";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValueOnce(ABORT_WITH_PROGRESS);

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr413" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );
        await settleReactions();

        // The ORIGIN turn carries it (stamped at assembly, like T2b's pin)...
        const originItem = agentManager.runWorkItemTurn.mock.calls[0][1];
        expect(originItem.meta.meetingExclusionTs).toBe("1000.0004");

        // ...and it survives the leg construction, while the four conference
        // keys still do not.
        const legItem = agentManager.runWorkItemTurn.mock.calls[1][1];
        expect(legItem.meta.meetingExclusionTs).toBe("1000.0004");
        expect(legItem.meta.conferenceMode).toBeUndefined();
        expect(legItem.meta.conferenceRound).toBeUndefined();
        expect(legItem.meta.conferenceHumanTs).toBeUndefined();
        expect(legItem.meta.conferenceInjectionMode).toBeUndefined();
      });

      it("T2b: the stamp is written at assembly time, on the ORIGIN turn's own dispatch — independent of whether an abort ever happens", async () => {
        // Direct pin for D1 itself (plan-review r1 finding): T1/T2 only
        // prove the ARM's output; this proves the stamp exists on every
        // conference turn's dispatch args unconditionally, which is also
        // what makes the outage-store replay case (T5) sound — the store
        // serializes this same effectiveItem.
        await soloClassifier();
        const threadId = "conf-thread-kpr413-t2b";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValueOnce(turn()); // healthy — no abort at all

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr413" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );

        const originCallItem = agentManager.runWorkItemTurn.mock.calls[0][1];
        expect(originCallItem.meta.deadlineOriginalText).toContain("Meeting rules:");
        expect(originCallItem.meta.deadlineOriginalText).not.toContain("[Meeting thread in #");
      });

      it("T3: chain does not nest — every leg wraps the same frame, never a wrap-of-a-wrap", async () => {
        await soloClassifier();
        const threadId = "conf-thread-kpr413-t3";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValue(ABORT_WITH_PROGRESS); // persistent: origin AND leg 1 both abort

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr413" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );
        await settleReactions();
        await settleReactions();

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3); // origin + 2 legs (cap)
        const leg1 = agentManager.runWorkItemTurn.mock.calls[1][1];
        const leg2 = agentManager.runWorkItemTurn.mock.calls[2][1];
        expect(leg1.id).toMatch(/#dl1$/);
        expect(leg2.id).toMatch(/#dl2$/);
        expect(leg2.meta.deadlineOriginalText).toBe(leg1.meta.deadlineOriginalText); // same frame, not leg1's wrap
        // Strengthened per plan-review r1 (this property alone holds
        // pre-fix too, by coincidence, since both legs would carry the
        // same composite either way — the marker check is what actually
        // distinguishes fixed from unfixed):
        expect(leg2.text).not.toContain("[Meeting thread in #");
      });
    });
  });

  describe("delta context injection (KPR-388)", () => {
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
      // KPR-389 C5 numerator pin (round-0 arm): the fan-out suppression log must
      // carry the conferenceRound tag — dropping it silently breaks C5.
      expect(mockLogInfo).toHaveBeenCalledWith(
        "Non-response suppressed (fan-out)",
        expect.objectContaining({ agentId: "jasper", conferenceRound: 0 }),
      );
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

    // -------------------------------------------------------------------
    // KPR-409: summary-mode anchor + round-level cadence seams.
    // ADDITIONS ONLY — every case above is untouched (T3 gate). Cases that
    // do not call seedScribe() exercise the absent-scribe path, which is
    // byte-identical to pre-KPR-409 (C6 pin).
    // -------------------------------------------------------------------

    /** Installs a fake scribe. `summary` undefined ⇒ getSummary resolves
     *  undefined (the "nothing yet / disabled / absent" production shape). */
    const seedScribe = (summary?: { summaryText: string; coveredThroughTs: string }) => {
      const scribe = {
        getSummary: vi.fn().mockResolvedValue(summary),
        noteActivity: vi.fn(),
      };
      dispatcher.setMeetingScribe(scribe as any);
      return scribe;
    };

    it("T1: summary mode replaces the raw transcript — byte-exact shape (KPR-409 summary pin)", async () => {
      await soloClassifier();
      const threadId = "conf-thread-summary-pin";
      // No seedRef ⇒ full arm ⇒ the summary anchor fires.
      seedScribe({ summaryText: "S", coveredThroughTs: "1000.0002" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-summary" },
        threadId,
        meta: { slackTs: "1000.0004" },
      });
      await dispatcher.dispatch(item);

      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];

      const expectedSummary =
        `[Meeting thread in #conf-summary — participants: Jasper]\n` +
        `[Running summary of the meeting so far:]\n\n` +
        `S\n\n` +
        `[Messages since the summary:]\n\n` +
        `May (5 min ago): newer message`;
      expect(turnItem.text).toBe(
        `${PREAMBLE("conf-summary", "Jasper")}\n${expectedSummary}\n---\n[New message]:\n${item.text}`,
      );
      expect(turnItem.meta.conferenceInjectionMode).toBe("summary");
      expect(turnItem.text).not.toContain("[New messages since your last turn:]");
      expect(turnItem.text).not.toContain("old message"); // pre-summary content is gone
    });

    it("T1: an empty tail ends the context at the summary — no dangling tail header", async () => {
      await soloClassifier();
      const threadId = "conf-thread-summary-empty-tail";
      seedScribe({ summaryText: "S", coveredThroughTs: "1000.0003" }); // covers the whole history
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-summary" },
        threadId,
        meta: { slackTs: "1000.0004" },
      });
      await dispatcher.dispatch(item);

      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
      const expectedSummary =
        `[Meeting thread in #conf-summary — participants: Jasper]\n` +
        `[Running summary of the meeting so far:]\n\n` +
        `S`;
      expect(turnItem.text).toBe(
        `${PREAMBLE("conf-summary", "Jasper")}\n${expectedSummary}\n---\n[New message]:\n${item.text}`,
      );
      expect(turnItem.text).not.toContain("[Messages since the summary:]");
    });

    // ⚠ Written against R2 (spec §D4, plan header decision). If the coherence
    // reviewer rules F1 instead, ALL FIVE of the tests below INVERT — both
    // T2(a) cases, T2(b), T2(c) and T5 — because true F1 deletes the whole
    // injectionHighWaterTs property from buildConferenceContext's summary arm
    // (NOT merely the summary.coveredThroughTs term, which would leave a
    // defined mark on every round-0 and non-empty-tail turn). With the property
    // gone the mark is undefined and setMeetingMark is never called on any
    // summary turn — rewrite all five to pin the absence.
    it("T2(a): summary mode, non-empty tail, round 0 — the trigger ts maxes in", async () => {
      await soloClassifier();
      const threadId = "conf-thread-summary-mark-trigger";
      seedScribe({ summaryText: "S", coveredThroughTs: "1000.0002" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-summary-mark" },
          threadId,
          meta: { slackTs: "1000.0004" }, // above the tail max (1000.0003) — the trigger wins
        }),
      );

      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0004");
    });

    it("T2(a): summary mode — a trigger ts below the tail max loses to the tail max", async () => {
      await soloClassifier();
      const threadId = "conf-thread-summary-mark-tail";
      seedScribe({ summaryText: "S", coveredThroughTs: "1000.0002" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-summary-mark" },
          threadId,
          meta: { slackTs: "1000.0000" }, // below the tail max (1000.0003)
        }),
      );

      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0003");
    });

    it("T2(c): summary mode, round 0, empty tail — coveredThroughTs maxes in (R2)", async () => {
      await soloClassifier();
      const threadId = "conf-thread-summary-mark-covered-r0";
      seedScribe({ summaryText: "S", coveredThroughTs: "1000.0009" }); // covers the whole history
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-summary-mark" },
          threadId,
          meta: { slackTs: "1000.0005" }, // below coveredThroughTs — only R2 can carry the mark this high
        }),
      );

      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0009");
    });

    it("T2(b): summary mode, round 1, empty tail — the mark still advances, to coveredThroughTs (R2 correction pin)", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-summary-mark-covered-r1";
      // Neither agent has a session ⇒ both take the full arm ⇒ summary anchor.
      seedScribe({ summaryText: "S", coveredThroughTs: "1000.0009" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(
        makeHistory([
          { author: "May", text: "kickoff", ts: "1000.0001", minAgo: 30 },
          { author: "Jasper", text: "Agent response", ts: "1000.0006", minAgo: 4, isBot: true },
        ]),
      );

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, please weigh in",
          source: { kind: "slack", id: "C-CONF", label: "conf-summary-r1" },
          threadId,
          meta: { slackTs: "2000.0005" },
        }),
      );

      // Round 1 has no trigger max-in and the tail is empty — without R2's
      // coveredThroughTs term this call never happens and jessica never
      // converts to delta.
      await vi.waitFor(() => {
        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jessica", threadId, "1000.0009");
      });
      // Contrast: round 0 still maxes in its own trigger ts.
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "2000.0005");
    });

    it("T5: summary-mode turn with resumedSession:false still sets the mark — the clear branch stays delta-exclusive", async () => {
      await soloClassifier();
      const threadId = "conf-thread-summary-resumed-false";
      seedScribe({ summaryText: "S", coveredThroughTs: "1000.0002" });
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
        resumedSession: false, // would clear on a DELTA turn — summary mode must still set
      });

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-summary-resumed" },
          threadId,
          meta: { slackTs: "1000.0004" },
        }),
      );

      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0004");
      expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
    });

    it("T3 control: a scribe with no summary yet ⇒ the pre-KPR-409 full-mode shape, unchanged", async () => {
      await soloClassifier();
      const threadId = "conf-thread-summary-absent";
      const scribe = seedScribe(undefined); // getSummary resolves undefined
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-summary-absent" },
        threadId,
        meta: { slackTs: "1000.0004" },
      });
      await dispatcher.dispatch(item);

      expect(scribe.getSummary).toHaveBeenCalledWith(threadId);
      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
      expect(turnItem.text).toContain("old message"); // raw transcript
      expect(turnItem.text).toContain("newer message");
      expect(turnItem.text).not.toContain("[Running summary of the meeting so far:]");
      expect(turnItem.text).not.toContain("[Messages since the summary:]");
      expect(turnItem.meta.conferenceInjectionMode).toBe("full");
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0004");
    });

    it("T4: the delta arm never reads a summary — a delta-eligible agent stays byte-identical", async () => {
      await soloClassifier();
      const threadId = "conf-thread-summary-delta-untouched";
      seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0002" });
      const scribe = seedScribe({ summaryText: "S", coveredThroughTs: "1000.0002" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-delta" },
        threadId,
        meta: { slackTs: "1000.0004" },
      });
      await dispatcher.dispatch(item);

      expect(scribe.getSummary).not.toHaveBeenCalled();
      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
      expect(turnItem.meta.conferenceInjectionMode).toBe("delta");
      const expectedDelta =
        `[Meeting thread in #conf-delta — participants: Jasper]\n` +
        `[New messages since your last turn:]\n\n` +
        `May (5 min ago): newer message`;
      expect(turnItem.text).toBe(
        `${PREAMBLE("conf-delta", "Jasper")}\n${expectedDelta}\n---\n[New message]:\n${item.text}`,
      );
    });

    it("T6: round 0 fires the cadence seam exactly once regardless of how many responders are selected", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper", "jessica"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-cadence-round0";
      const scribe = seedScribe(undefined);
      const history = THREE_MSG_HISTORY();
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(history);

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, please weigh in",
          source: { kind: "slack", id: "C-CONF", label: "conf-cadence" },
          threadId,
          meta: { slackTs: "1000.0004", slackThreadTs: "1000.0001" },
        }),
      );

      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2); // N = 2 responders
      expect(scribe.noteActivity).toHaveBeenCalledTimes(1); // round-level, not per-agent
      const [args] = scribe.noteActivity.mock.calls[0];
      expect(args.threadId).toBe(threadId);
      expect(args.history).toEqual(history);
      expect(args.channelLabel).toBe("conf-cadence");
      expect(args.roster.map((r: any) => r.agentId)).toEqual(["jasper", "jessica"]);
      expect(args.baseAgentId).toBe("jasper");
      expect(args.source).toEqual({
        adapterId: "slack",
        channelId: "C-CONF",
        channelKind: "slack",
        slackTs: "1000.0004",
        slackThreadTs: "1000.0001",
      });
    });

    it("T6: round 0 fires the cadence seam even when the classifier selects nobody", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any).mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-cadence-nobody";
      const scribe = seedScribe(undefined);
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, thoughts?",
          source: { kind: "slack", id: "C-CONF", label: "conf-cadence" },
          threadId,
          meta: { slackTs: "1000.0004" },
        }),
      );

      expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled(); // nobody selected
      expect(scribe.noteActivity).toHaveBeenCalledTimes(1); // the seam precedes the classifier
    });

    it("T6: a round-1 pass WITH selected reactors adds one more cadence call", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-cadence-round1";
      const scribe = seedScribe(undefined);
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, please weigh in",
          source: { kind: "slack", id: "C-CONF", label: "conf-cadence" },
          threadId,
          meta: { slackTs: "1000.0004" },
        }),
      );

      await vi.waitFor(() => {
        expect(scribe.noteActivity).toHaveBeenCalledTimes(2); // round 0 + round 1
      });
      const [round1Args] = scribe.noteActivity.mock.calls[1];
      expect(round1Args.threadId).toBe(threadId);
      expect(round1Args.source.slackTs).toBe("1000.0004"); // the human ts, not a peer ts
      expect(round1Args.roster.map((r: any) => r.agentId)).toEqual(["jasper", "jessica"]);
    });

    it("T6: a round-1 pass that selects NOBODY adds no cadence call — the early return precedes the re-fetch (deliberate asymmetry)", async () => {
      await soloClassifier(); // round 0 = jasper; the reaction pass selects nobody
      const threadId = "conf-thread-cadence-round1-nobody";
      const scribe = seedScribe(undefined);
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, please weigh in",
          source: { kind: "slack", id: "C-CONF", label: "conf-cadence" },
          threadId,
          meta: { slackTs: "1000.0004" },
        }),
      );

      await vi.waitFor(() => {
        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0004");
      });
      // Round 0 already guaranteed one trigger per human message — the round-1
      // seam is selection-gated by construction and this is not a bug.
      expect(scribe.noteActivity).toHaveBeenCalledTimes(1);
    });

    it("T6: a scribe whose getSummary REJECTS degrades to the full arm — it never blocks the turn", async () => {
      await soloClassifier();
      const threadId = "conf-thread-summary-throws";
      const scribe = {
        getSummary: vi.fn().mockRejectedValue(new Error("scribe exploded")),
        noteActivity: vi.fn(),
      };
      dispatcher.setMeetingScribe(scribe as any);
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      // Call-site fail-safety (KPR-390 canon C27): MeetingScribe.getSummary is
      // documented total, but buildConferenceContext does not depend on that
      // contract holding — a rejection is caught at the boundary and treated
      // exactly like `summary === undefined`, i.e. the untouched pre-KPR-409
      // full arm. Assertions below mirror the T3 control.
      const item = makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-summary-throws" },
        threadId,
        meta: { slackTs: "1000.0004" },
      });
      await dispatcher.dispatch(item);

      expect(scribe.getSummary).toHaveBeenCalledWith(threadId);
      expect(scribe.noteActivity).toHaveBeenCalledTimes(1); // the cadence seam still fires
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
      const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
      expect(turnItem.text).toContain("old message"); // raw transcript
      expect(turnItem.text).toContain("newer message");
      expect(turnItem.text).not.toContain("[Running summary of the meeting so far:]");
      expect(turnItem.text).not.toContain("[Messages since the summary:]");
      expect(turnItem.meta.conferenceInjectionMode).toBe("full");
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0004");
    });

    it("T6: a scribe whose noteActivity THROWS at both cadence seams never blocks the turn", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-cadence-throws";
      // Call-site fail-safety (KPR-390 canon C27), the noteActivity twin of the
      // getSummary case above. noteActivity's ASYNC portion is self-contained
      // (`void this.run().catch()`), but its SYNCHRONOUS gate checks run on the
      // dispatch stack — an unguarded throw there would propagate through
      // resolveConferenceAgents (round 0) / triggerConferenceReactions (round 1)
      // and kill the conference turn. Both seams are wrapped, so a scribe that
      // explodes synchronously is inert: every turn still runs.
      const scribe = {
        getSummary: vi.fn().mockResolvedValue(undefined),
        noteActivity: vi.fn(() => {
          throw new Error("scribe gate exploded");
        }),
      };
      dispatcher.setMeetingScribe(scribe as any);
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, please weigh in",
          source: { kind: "slack", id: "C-CONF", label: "conf-cadence-throws" },
          threadId,
          meta: { slackTs: "1000.0004" },
        }),
      );

      // Both seams were reached and both threw — round 0 (resolveConferenceAgents)
      // and round 1 (triggerConferenceReactions).
      await vi.waitFor(() => {
        expect(scribe.noteActivity).toHaveBeenCalledTimes(2);
      });
      // ...and neither throw stopped dispatch: the round-0 responder AND the
      // round-1 reactor both ran their turns.
      await vi.waitFor(() => {
        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
      });
      const dispatched = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]);
      expect(dispatched).toEqual(["jasper", "jessica"]);
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0004");
    });
  });
});
