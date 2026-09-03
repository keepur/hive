import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Dispatcher, MEETING_ACK_TEXT, MEETING_ACK_DELAY_MS, isMeetingAck } from "./dispatcher.js";
import type { WorkItem } from "../types/work-item.js";
import { OutageEpisodeTracker } from "../outage/outage-notices.js";
import { ProviderCircuitOpenError } from "../agents/provider-circuit-breaker.js";
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
      toolAckInjected: 0,
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
   *
   * KPR-420: the leaf is now Map<agentId, "claim" | "delivery-mark">.
   * excludedFor projects KEYS to a value-level Set — membership still means
   * "excluded", so the existing value assertions stand unmodified. The
   * projection is deliberately shape-agnostic (Set.prototype.keys() yields
   * values), which keeps it working against pre-fix code for the T1
   * negative-verify pass. rawTrackerLeaf exposes the tag itself for the
   * KPR-420 provenance assertions.
   */
  const rawTrackerLeaf = (threadId: string, humanTs: string): Map<string, "claim" | "delivery-mark"> | undefined =>
    (
      dispatcher as unknown as {
        meetingReactionTracker: Map<string, Map<string, Map<string, "claim" | "delivery-mark">>>;
      }
    ).meetingReactionTracker
      .get(threadId)
      ?.get(humanTs);
  const excludedFor = (threadId: string, humanTs: string): Set<string> | undefined => {
    const leaf = rawTrackerLeaf(threadId, humanTs);
    return leaf === undefined ? undefined : new Set(leaf.keys());
  };

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
      toolAckInjected: 0,
      streamed: false,
      compactions: 0,
      ...overrides,
    };
  }

  /**
   * Suite-wide settle barrier for anything downstream of a turn's resolution
   * (plan-review r1 note). `waitFor(runWorkItemTurn × N)` alone is NOT enough:
   * everything the dispatcher does after a turn resolves — delivery-time
   * writes (the KPR-416 exclusion mark), the guards that suppress a delivery,
   * and every fire-and-forget follow-on the dispatch spawns (the reaction
   * pass, continuation legs) — is a pure microtask chain (all harness mocks
   * resolve immediately, no timers), so an assert can run before it. One
   * macrotask boundary drains the whole chain, because the microtask queue is
   * fully emptied before the next macrotask. Used by T6/T8a/T8b/T9 and the
   * KPR-389 D5 tests alike; where a test awaits it twice, that is one boundary
   * per nested fire-and-forget generation. Negative-verified on one instance:
   * with the D5 guard disabled those tests fail in ~3ms.
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

  // KPR-387 duplicate-answer regression guard, re-derived for KPR-416 (§7.1):
  // half (a) of the fix — tracker recording — is RELOCATED, not removed, so a
  // round-0 primary that DELIVERED must still be skipped by the reaction pass.
  // Half (b) (the reactionTo terminal-slot reframing) is untouched by KPR-416.
  it("round-0 responders are excluded from the reaction-pass roster", async () => {
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    // Round-0: jasper + river respond. Reaction passes: capture roster, select nobody.
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({ respondAgentIds: ["jasper", "river"], costUsd: 0.001, durationMs: 100 })
      .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });

    // KPR-416 determinism gate (spec §10, T3). Post-relocation each responder's
    // exclusion write is the synchronous statement immediately BEFORE its own
    // delivery, and the reaction pass fires immediately AFTER it. Putting one
    // macrotask boundary inside delivery orders every round-0 write (reachable
    // on microtasks alone — all other harness mocks resolve immediately) ahead
    // of every reaction pass, by construction rather than by await-depth
    // coincidence. A flaky T3 is not acceptable as the KPR-387 guard.
    // "T1 (KPR-420)" below is the UNSUPPRESSED sibling: it engineers the
    // real mid-await interleaving this boundary deliberately orders away.
    adapter.deliver.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

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

  it("T1 (KPR-416): a SUPPRESSED round-0 primary becomes eligible to react to a slower peer's later reply", async () => {
    // Trial observation 1, reproduced (spec §1): the classifier selects three
    // primaries; two finish fast with "No response needed." (formed before the
    // slow peer's findings existed); the slow one later delivers real content.
    // Pre-KPR-416 the selection-time write had already excluded all three, so
    // peerMembers was empty and NOBODY reacted. Post-fix the two suppressed
    // agents are eligible and actually run round-1 turns.
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({ respondAgentIds: ["jasper", "river", "jessica"], costUsd: 0.001, durationMs: 100 })
      .mockResolvedValue({ respondAgentIds: ["river", "jessica"], costUsd: 0.001, durationMs: 100 });

    const threadId = "conf-thread-kpr416-t1";
    // Keyed by agentId, not call order: the slow primary resolves on a real
    // timer so the two suppressions are guaranteed to have completed first —
    // the trial's actual shape, and deterministic without leaning on
    // Promise.all ordering.
    agentManager.runWorkItemTurn.mockImplementation(async (agentId: string) => {
      if (agentId === "jasper") {
        await new Promise((r) => setTimeout(r, 10));
        return turn({ finalMessage: "Here is what I found after a long dig." });
      }
      return turn({ finalMessage: "No response needed." });
    });

    await dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, River, and Jessica, discuss the launch plan",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t1" },
        threadId,
        meta: { slackTs: "1700.0011" },
      }),
    );

    // Vacuous-pass guard (kpr-387-spec.md:155): assert a NON-EMPTY set of
    // round-0 turns actually ran before asserting anything about round 1.
    const round0Agents = agentManager.runWorkItemTurn.mock.calls
      .filter((c: any[]) => c[1]?.meta?.conferenceRound === 0)
      .map((c: any[]) => c[0])
      .sort();
    expect(round0Agents).toEqual(["jasper", "jessica", "river"]);

    // The reaction pass ran with BOTH suppressed peers on the roster...
    const reactionCalls = () =>
      (classifyMeetingMessage as any).mock.calls.filter(
        (c: any[]) => c[0] === "Here is what I found after a long dig.",
      );
    await vi.waitFor(() => expect(reactionCalls().length).toBeGreaterThanOrEqual(1));
    const peerIds = reactionCalls()[0][1]
      .map((m: any) => m.agentId)
      .sort();
    expect(peerIds).toEqual(["jessica", "river"]);

    // ...and both actually ran a round-1 turn.
    await vi.waitFor(() => {
      const round1Agents = agentManager.runWorkItemTurn.mock.calls
        .filter((c: any[]) => c[1]?.meta?.conferenceRound === 1)
        .map((c: any[]) => c[0])
        .sort();
      expect(round1Agents).toEqual(["jessica", "river"]);
    });
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
    // convention as dispatcher.test.ts:283 (the pin IS the point: widen-or-match
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

  // -------------------------------------------------------------------------
  // KPR-417 — the ack is invisible to every engine-internal history consumer
  // -------------------------------------------------------------------------
  describe("meeting-ack recognition and the single strip point (KPR-417)", () => {
    // The fixture. THREE messages, of which exactly ONE is ack-shaped and TWO
    // are not — the vacuous-pass guard (kpr-387-spec.md:155): every
    // sub-assertion below asserts the PEER REPLY *is* present as well as that
    // the ack is absent, so "everything got filtered" cannot masquerade as
    // "acks got filtered".
    //
    // The ack's ts is the STRICTLY HIGHEST in the fixture and strictly above
    // the trigger ts — that is what makes the mark sub-assertion (3) real: if
    // the ack survived, it would win maxSlackTs and the mark would be
    // "1000.0009". The prefix on the ack text is the real
    // SlackAdapter.deliver shape (`${icon} *${Name}*: `), which also exercises
    // AGENT_PREFIX_RE.
    const ACK_TS = "1000.0009";
    const TRIGGER_TS = "1000.0003";
    const PEER_TEXT = "The migration is blocked on the schema review.";
    const ackFixture = () =>
      makeHistory([
        { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
        { author: "River", text: `🤖 *River*: ${PEER_TEXT}`, ts: "1000.0002", minAgo: 10, isBot: true },
        { author: "Jasper", text: `🤖 *Jasper*: ${MEETING_ACK_TEXT}`, ts: ACK_TS, minAgo: 1, isBot: true },
      ]);

    /** Fake scribe whose getSummary resolves undefined, so the FULL arm is
     *  preserved (a summary would flip injectionMode to "summary"). Mirrors
     *  the in-file seedScribe precedent at :2783. */
    const seedAckScribe = () => {
      const scribe = { getSummary: vi.fn().mockResolvedValue(undefined), noteActivity: vi.fn() };
      dispatcher.setMeetingScribe(scribe as any);
      return scribe;
    };

    it.each([
      ["with the lever ON", true],
      ["with the lever OFF (T6: the strip is NOT gated on ackEnabled)", false],
    ])(
      "T5 (KPR-417): an ack-shaped message is stripped from the full arm, the mark, the classifier window and the scribe — %s",
      async (_label, lever) => {
        // T6 is folded in as the second row rather than duplicated (spec §9
        // sanctions this). The `false` row is the load-bearing one for §5.5's
        // ruling: flipping the lever off must NOT un-hide acks already in a
        // live thread. If a future edit gates fetchMeetingHistory's filter on
        // meetingAckEnabled, this row fails and the ON row still passes.
        dispatcher.setMeetingAckEnabled(lever);
        await soloClassifier();
        const scribe = seedAckScribe();
        const threadId = `conf-thread-kpr417-t5-${lever}`;
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ackFixture());

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, where are we?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr417-t5" },
            threadId,
            meta: { slackTs: TRIGGER_TS },
          }),
        );

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
        const round0Item = agentManager.runWorkItemTurn.mock.calls[0][1];

        // (1) FULL ARM — the injected threadContext carries the peer reply and
        //     not the ack.
        expect(round0Item.meta.conferenceInjectionMode).toBe("full");
        expect(round0Item.text).toContain(PEER_TEXT); // vacuous-pass guard
        expect(round0Item.text).not.toContain(MEETING_ACK_TEXT);

        // (3) MARK — the high-water calc never saw the ack, so it lands on the
        //     trigger ts, NOT the ack's (which is numerically higher).
        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, TRIGGER_TS);
        expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalledWith("jasper", threadId, ACK_TS);

        // (4) CLASSIFIER RECENCY WINDOW — third arg to classifyMeetingMessage.
        const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
        const recent = (classifyMeetingMessage as any).mock.calls[0][2] as string;
        expect(recent).toContain(PEER_TEXT); // vacuous-pass guard
        expect(recent).not.toContain(MEETING_ACK_TEXT);

        // (5) SCRIBE — noteActivity's history carries no ack-shaped entry.
        expect(scribe.noteActivity).toHaveBeenCalledTimes(1);
        const scribeHistory = scribe.noteActivity.mock.calls[0][0].history as Array<{ text: string; ts: string }>;
        expect(scribeHistory.map((m) => m.ts)).toEqual(["1000.0001", "1000.0002"]); // vacuous-pass guard
        expect(scribeHistory.some((m) => m.text.includes(MEETING_ACK_TEXT))).toBe(false);
      },
    );

    it("T5 (KPR-417) — sub-assertion (2): the DELTA arm also omits the ack", async () => {
      // Separate `it` because seeding a resumable ref flips injectionMode to
      // "delta", which is mutually exclusive with the full arm above. Mark is
      // seeded BELOW the peer reply's ts so both the peer and the ack are
      // inside the strictly-greater delta window pre-fix.
      dispatcher.setMeetingAckEnabled(true);
      await soloClassifier();
      seedAckScribe();
      const threadId = "conf-thread-kpr417-t5-delta";
      seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0001" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ackFixture());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, where are we?",
          source: { kind: "slack", id: "C-CONF", label: "conf-kpr417-t5" },
          threadId,
          meta: { slackTs: TRIGGER_TS },
        }),
      );

      const round0Item = agentManager.runWorkItemTurn.mock.calls[0][1];
      expect(round0Item.meta.conferenceInjectionMode).toBe("delta");
      expect(round0Item.text).toContain("[New messages since your last turn:]");
      expect(round0Item.text).toContain(PEER_TEXT); // vacuous-pass guard
      expect(round0Item.text).not.toContain(MEETING_ACK_TEXT);
      // The delta's own high-water never saw the ack either.
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, TRIGGER_TS);
    });

    it("T5 (KPR-417) — isMeetingAck is anchored: a reply that merely BEGINS with the sentence is NOT an ack", () => {
      // Unit-level bound on the collision residual (spec §5.4). Exported
      // alongside MEETING_ACK_TEXT precisely so this is assertable without
      // routing through a dispatch.
      const msg = (text: string, isBot = true) => ({
        author: "Jasper",
        text,
        timestamp: new Date(),
        isBot,
        ts: "1",
      });
      expect(isMeetingAck(msg(MEETING_ACK_TEXT))).toBe(true);
      expect(isMeetingAck(msg(`🤖 *Jasper*: ${MEETING_ACK_TEXT}`))).toBe(true);
      expect(isMeetingAck(msg(`*Jasper*: ${MEETING_ACK_TEXT}`))).toBe(true); // agent with no icon
      expect(isMeetingAck(msg(`  ${MEETING_ACK_TEXT}  `))).toBe(true); // trimmed
      // Anchored: a real reply that starts with the sentence is real content.
      expect(isMeetingAck(msg(`${MEETING_ACK_TEXT} Here is what I found.`))).toBe(false);
      // isBot gates a human typing it.
      expect(isMeetingAck(msg(MEETING_ACK_TEXT, false))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // KPR-417 — delay-then-ack: arm, fire, cancel
  //
  // ⚠ FAKE TIMERS ARE SCOPED TO THIS BLOCK ONLY. The rest of the file keeps
  // its real-timer `settleReactions` (:315) untouched and no existing test
  // changes. Inside this block use ONLY the async advancement API — under
  // vi.useFakeTimers() the suite's `new Promise(r => setTimeout(r, 0))` drain
  // is itself captured by the fake clock and never resolves, so a naive
  // useFakeTimers() + settleReactions() combination DEADLOCKS. Also avoid
  // `vi.waitFor` here — NOT because it deadlocks (it does not: it polls on
  // getSafeTimers()' native timers and explicitly supports fake clocks), but
  // because each poll cycle auto-advances the fake clock by its 50ms interval
  // via a bare synchronous vi.advanceTimersByTime — fighting these tests for
  // control of the very clock they step across the 15s threshold. Drive every
  // drain with settleAcked()/advanceTimersByTimeAsync instead.
  // -------------------------------------------------------------------------
  describe("delay-then-ack for slow round-0 conference turns (KPR-417)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Precondition (spec §9): meetingAckEnabled is FAIL-CLOSED false and the
      // conference harness never wires index.ts. Without this line every
      // positive case below passes VACUOUSLY as "no ack posted".
      dispatcher.setMeetingAckEnabled(true);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** KPR-417: the fake-timer equivalent of the suite's real-timer
     *  `settleReactions` (:315) — NOT a second mechanism.
     *  advanceTimersByTimeAsync yields a real macrotask boundary between
     *  ticks, which is precisely the drain semantics settleReactions provides
     *  per its own JSDoc at :301-314. */
    const settleAcked = () => vi.advanceTimersByTimeAsync(0);

    /** A turn that never settles until the test releases it. */
    const hangingTurn = () => {
      let release!: (v: unknown) => void;
      const promise = new Promise((r) => {
        release = r;
      });
      return { promise, release };
    };

    const ackCalls = () => adapter.deliver.mock.calls.filter((c: any[]) => c[0].text === MEETING_ACK_TEXT);

    const confAckItem = (threadId: string, text = "Jasper, where are we?") =>
      makeWorkItem({
        text,
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr417" },
        threadId,
        meta: { slackTs: "1700.0100" },
      });

    it("T1 (KPR-417): a round-0 conference turn unresolved at t=15s posts exactly one attributed ack, then its answer", async () => {
      // THE primary mechanism. Trial observation 2 reproduced: grok's ~130s
      // chairing turn left no signal in Slack that anything was happening.
      await soloClassifier();
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t1"));
      await settleAcked(); // let dispatch reach the turn await (timer armed)

      // Nothing yet — a fast turn must never ack (this is also T2's premise).
      expect(adapter.deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);

      expect(ackCalls()).toHaveLength(1);
      const ack = ackCalls()[0][0];
      expect(ack.text).toBe(MEETING_ACK_TEXT);
      expect(ack.agentId).toBe("jasper"); // attributed — deliver picks up identity
      expect(ack.error).toBeUndefined(); // formatResponse, not formatError
      expect(ack.costUsd).toBe(0);

      // Settle the turn: the answer delivers, and no SECOND ack fires.
      slow.release(turn({ finalMessage: "Here is the long-awaited answer." }));
      await dispatched;
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS); // the timer is dead

      expect(ackCalls()).toHaveLength(1);
      const answers = adapter.deliver.mock.calls.filter((c: any[]) => c[0].text !== MEETING_ACK_TEXT);
      expect(answers).toHaveLength(1);
      expect(answers[0][0].text).toBe("Here is the long-awaited answer.");
      // Ordering is correct BY CONSTRUCTION, not by luck (spec §8): the ack
      // fires at 15s, the answer strictly after, since a faster turn cancels.
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);
    });

    it("T2 (KPR-417): a fast round-0 turn never acks, even after the clock passes the threshold", async () => {
      // No new noise for the 2-5s population — the whole point of
      // delay-then-ack over the operator's literal immediate 'got it'.
      await soloClassifier();
      agentManager.runWorkItemTurn.mockResolvedValueOnce(turn({ finalMessage: "Quick answer." }));

      await dispatcher.dispatch(confAckItem("conf-thread-kpr417-t2"));
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 3);
      await settleAcked();

      expect(ackCalls()).toHaveLength(0);
      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe("Quick answer.");
    });

    it("T7a (KPR-417): with the dispatcher lever OFF, a slow round-0 turn posts no ack", async () => {
      // The operator rollback path (spec §10): ackEnabled: false + restart ⇒
      // no NEW acks. (The strip keeps running regardless — pinned by T5's
      // false row, not here.)
      dispatcher.setMeetingAckEnabled(false);
      await soloClassifier();
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t7a"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 3);

      expect(ackCalls()).toHaveLength(0);
      expect(adapter.deliver).not.toHaveBeenCalled();

      slow.release(turn({ finalMessage: "Eventually." }));
      await dispatched;
      await settleAcked();
      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe("Eventually.");
    });

    it("T3 (KPR-417): a round-1 reaction turn NEVER acks, and a killed one leaves the channel silent (KPR-389 §D5)", async () => {
      // ⚠ THIS IS THE GUARD FOR KPR-389 §D5 GOAL 5, quoted verbatim from
      // kpr-389-spec.md:39: "A clamp-killed reaction never posts noise into
      // the meeting channel." A round-1 reaction clamp-killed at 120s would,
      // under an unguarded ack, have posted "On it" at 15s — the ack IS the
      // filler D5 forbids, already in the channel before the kill. There is no
      // round-1 retraction path in this design (spec §5.2, §6.4), so round-1
      // acking is simply out of scope. If a future edit "just acks round-1
      // too", this test must fail loudly.
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const slowReaction = hangingTurn();
      agentManager.runWorkItemTurn
        .mockResolvedValueOnce(turn({ finalMessage: "Jasper's round-0 answer" })) // fast round-0
        .mockReturnValueOnce(slowReaction.promise); // jessica's round-1: hangs

      await dispatcher.dispatch(confAckItem("conf-thread-kpr417-t3", "Jasper, and Jessica, please weigh in"));
      // Drain the fire-and-forget reaction pass under the fake clock, then let
      // the round-1 turn sit past the ack threshold.
      await settleAcked();
      await settleAcked();
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
      expect(agentManager.runWorkItemTurn.mock.calls[1][1].meta.conferenceRound).toBe(1);

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      expect(ackCalls()).toHaveLength(0); // ← the gate

      // Companion: the round-1 turn is then clamp-killed. D5's existing
      // silence holds and the channel saw ZERO posts for that agent.
      slowReaction.release(turn({ finalMessage: "", aborted: true, timedOut: true }));
      await settleAcked();
      await settleAcked();

      expect(ackCalls()).toHaveLength(0);
      expect(adapter.deliver).toHaveBeenCalledTimes(1); // only jasper's round-0 reply
      expect(adapter.deliver.mock.calls[0][0].agentId).toBe("jasper");
    });

    it("T4a (KPR-417): a plain multi-agent fan-out turn never acks — THIS is the gate's real exercise", async () => {
      // Goes through dispatchToAgent (so the ack wrapper IS on the code path)
      // with a bare `resolved` carrying no conferenceMode. This is the case
      // that would fail if someone widened the gate to read item.meta.
      //
      // Label "random", NOT "general": executive-assistant OWNS the general
      // channel in the mock registry, which would take the dedicated-channel
      // single-dispatch path instead of fan-out.
      const slowA = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slowA.promise);

      const dispatched = dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, what's the deploy status?",
          source: { kind: "slack", id: "C999", label: "random" },
          threadId: "plain-fanout-kpr417-t4a",
          meta: { slackTs: "1700.0101" },
        }),
      );
      await settleAcked();
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2); // real fan-out
      expect(agentManager.runWorkItemTurn.mock.calls[0][1].meta.conferenceMode).toBeUndefined();

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      expect(ackCalls()).toHaveLength(0);

      slowA.release(turn({ finalMessage: "Deployed." }));
      await dispatched;
      await settleAcked();
      expect(ackCalls()).toHaveLength(0);
    });

    it("T4b (KPR-417): an outage-replay item carrying meta.conferenceRound: 0 never acks", async () => {
      // ⚠ STRUCTURALLY VACUOUS BY CONSTRUCTION, even post-fix — read the
      // comment before treating this as gate coverage. A replay takes
      // dispatch()'s SINGLE-DISPATCH leg, which has no runTurnWithMeetingAck
      // wrapper on it at all, so there is no gate there to evaluate. What it
      // pins is the LEG-LEVEL absence (spec §5.2): a regression where the ack
      // wrapper is later added to the single-dispatch leg. The meta-vs-
      // `resolved` gate is exercised by T4a, not here.
      //
      // Note the replay DOES retain its conference meta (KPR-389 §E4) — that
      // is the point: meta says round 0 and it still must not ack.
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(
        makeWorkItem({
          text: "some replayed conference turn text",
          source: { kind: "slack", id: "C-CONF", label: "conf-kpr417" },
          threadId: "conf-thread-kpr417-t4b",
          meta: {
            slackTs: "1700.0102",
            outageReplay: true,
            targetAgentId: "jasper", // resolveAgents step 0 — the single-dispatch leg
            conferenceMode: true,
            conferenceRound: 0,
            conferenceHumanTs: "1700.0102",
          },
        }),
      );
      await settleAcked();
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      expect(ackCalls()).toHaveLength(0);

      slow.release(turn({ finalMessage: "The replayed answer." }));
      await dispatched;
      await settleAcked();
      expect(ackCalls()).toHaveLength(0);
    });

    it.each([
      [
        "resolves with error + text (exit-code-1 convention)",
        (release: (v: unknown) => void) => release(turn({ finalMessage: "Partial answer", errors: ["exit 1"] })),
        "Partial answer",
      ],
      [
        "rejects (thrown — e.g. a grok TurnAssemblyError from an unreadable ~/.grok/auth.json)",
        (_release: (v: unknown) => void, reject: (e: unknown) => void) => reject(new Error("boom")),
        "Something went wrong",
      ],
    ])(
      "T8 (KPR-417, §6.1): an acked turn that %s delivers the ack first and the error second — never a retraction",
      async (_label, settle, expectedFragment) => {
        await soloClassifier();
        let release!: (v: unknown) => void;
        let reject!: (e: unknown) => void;
        agentManager.runWorkItemTurn.mockReturnValue(
          new Promise((res, rej) => {
            release = res;
            reject = rej;
          }),
        );

        const dispatched = dispatcher.dispatch(confAckItem(`conf-thread-kpr417-t8-${String(_label).slice(0, 12)}`));
        await settleAcked();
        await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
        expect(ackCalls()).toHaveLength(1);

        settle(release, reject);
        await dispatched;
        await settleAcked();

        // Exactly two posts, ack first, error second. NO third post, no edit,
        // no delete — the ack is never retracted (spec §6.4 ruling, applied
        // uniformly across every failure path).
        expect(adapter.deliver).toHaveBeenCalledTimes(2);
        expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);
        expect(adapter.deliver.mock.calls[1][0].text).toContain(expectedFragment);
      },
    );

    /** Outage wiring, same shape as T4's in-file precedent at :1620-1635. */
    const armOutage = () => {
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
      return outageStore;
    };
    const noticeCalls = () =>
      adapter.deliver.mock.calls.filter((c: any[]) => String(c[0].text).includes("provider outage"));

    it("T9a (KPR-417, §6.2): an IMMEDIATE circuit-open fast-fail beats the threshold — no ack", async () => {
      // The common case is structurally clean: the breaker permit is acquired
      // at the top of the spawn, so a fast-fail returns well under 15s.
      await soloClassifier();
      const outageStore = armOutage();
      agentManager.runWorkItemTurn.mockRejectedValueOnce(
        new ProviderCircuitOpenError("claude", Date.now(), 15_000, "connect-fail", "fetch failed"),
      );

      await dispatcher.dispatch(confAckItem("conf-thread-kpr417-t9a"));
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      await settleAcked();

      expect(outageStore.enqueue).toHaveBeenCalledTimes(1);
      expect(ackCalls()).toHaveLength(0);
    });

    it("T9b (KPR-417, §6.2): a fast-fail DELAYED past 15s (lock contention) acks, then the honest notice — one each", async () => {
      // NOT hypothetical: withSpawnTicket's per-thread lock spin-waits BEFORE
      // the breaker acquire, so a turn queued behind a sibling on the same
      // agentId:threadId can ack at 15s and only then fast-fail. The resulting
      // "ack, then honest outage notice" is a coherent sequence.
      await soloClassifier();
      const outageStore = armOutage();
      let reject!: (e: unknown) => void;
      agentManager.runWorkItemTurn.mockReturnValue(
        new Promise((_res, rej) => {
          reject = rej;
        }),
      );

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t9b"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(1);

      reject(new ProviderCircuitOpenError("claude", Date.now(), 15_000, "connect-fail", "fetch failed"));
      await dispatched;
      await settleAcked();

      expect(outageStore.enqueue).toHaveBeenCalledTimes(1);
      expect(ackCalls()).toHaveLength(1); // not repeated
      expect(noticeCalls()).toHaveLength(1);
      expect(adapter.deliver).toHaveBeenCalledTimes(2);
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT); // ack first
    });

    it("T9c (KPR-417, §6.2): ⚠ ACCEPTED RESIDUAL — two agents in one episode produce TWO acks and ONE notice", async () => {
      // This pins KNOWN, ACCEPTED behavior, not desired behavior. The outage
      // notice is deduped once per (provider, adapterKey, threadKey) per
      // episode (dispatcher.ts:1160, firstForThread), so in an N-agent meeting
      // on one provider only the first agent's turn produces a notice; the
      // rest queue silently. If those agents acked, their acks are followed by
      // silence until replay — possibly hours later, and via the
      // single-dispatch leg, which fires no reaction pass.
      //
      // Spec §6.2 CONSIDERED and REJECTED gating the ack at fire time on
      // breaker state, on three grounds: it covers only the lock-contended
      // sub-shape; it does nothing for the post-turn shape; and it makes the
      // ack rule conditional on cross-module state for partial coverage. Do
      // NOT "fix" this test. Revisit trigger: trial logs showing acks
      // correlated with outage episodes at a rate the operator notices.
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper", "river"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });
      const outageStore = armOutage();

      const rejects: Array<(e: unknown) => void> = [];
      agentManager.runWorkItemTurn.mockImplementation(
        () =>
          new Promise((_res, rej) => {
            rejects.push(rej);
          }),
      );

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t9c", "Jasper, and River, status please"));
      await settleAcked();
      expect(rejects).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(2); // ⚠ both slow agents acked

      for (const rej of rejects) {
        rej(new ProviderCircuitOpenError("claude", Date.now(), 15_000, "connect-fail", "fetch failed"));
      }
      await dispatched;
      await settleAcked();

      expect(outageStore.enqueue).toHaveBeenCalledTimes(2); // both queued
      expect(noticeCalls()).toHaveLength(1); // ⚠ but only ONE notice — the residual
    });

    it("T10 (KPR-417, §6.3): a deadline abort WITH progress acks, notices, dispatches a leg — and the leg itself never acks", async () => {
      // Sequence: ack at 15s → "taking longer than expected, continuing" at
      // the deadline → the leg's answer. A coherent progression, not a
      // redundant double-post. The leg carries no conference meta (KPR-413) and
      // re-enters the single-dispatch leg, so it CANNOT ack — asserted by
      // hanging the leg's own turn past the threshold too.
      await soloClassifier();
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue([]);
      const origin = hangingTurn();
      const leg = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValueOnce(origin.promise).mockReturnValueOnce(leg.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t10"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(1);

      origin.release(turn({ finalMessage: "", timedOut: true, aborted: true, toolCalls: 46, streamed: true }));
      await dispatched;
      await settleAcked();
      await settleAcked();

      // First-abort notice delivered, and a continuation leg dispatched.
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
      const legItem = agentManager.runWorkItemTurn.mock.calls[1][1];
      expect(legItem.meta.deadlineRetry).toBe(1);
      // Reuses the KPR-413 pin: the leg carries none of the four conference keys.
      expect(legItem.meta.conferenceMode).toBeUndefined();
      expect(legItem.meta.conferenceRound).toBeUndefined();
      expect(legItem.meta.conferenceHumanTs).toBeUndefined();
      expect(legItem.meta.conferenceInjectionMode).toBeUndefined();
      expect(adapter.deliver).toHaveBeenCalledTimes(2); // ack + first-abort notice
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);

      // ← the load-bearing half: the leg hangs well past the threshold and
      //   STILL posts no ack (there is no wrapper on that leg at all).
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      expect(ackCalls()).toHaveLength(1);

      leg.release(turn({ finalMessage: "Finished on the second pass." }));
      await settleAcked();
      await settleAcked();
      expect(ackCalls()).toHaveLength(1);
    });

    it("T10 companion (KPR-417, §6.3): a ZERO-progress deadline abort acks, then a notice only — no leg, no second ack", async () => {
      await soloClassifier();
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue([]);
      const origin = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValueOnce(origin.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t10b"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(1);

      // No toolCalls, not streamed, empty text ⇒ zero progress.
      origin.release(turn({ finalMessage: "", timedOut: true, aborted: true }));
      await dispatched;
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);

      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1); // no leg
      expect(ackCalls()).toHaveLength(1);
      expect(adapter.deliver).toHaveBeenCalledTimes(2); // ack + zero-progress notice
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);
    });

    it("T12 (KPR-417, §6.5): a failed ack delivery is warned and dropped — never retried, and the turn is unaffected", async () => {
      // A retried ack lands minutes later, potentially AFTER the answer. A
      // dropped ack is strictly better than a late one, so it must never reach
      // the retry queue (unlike deliverOutageNotice, which does enqueue).
      const retryQueue = { enqueue: vi.fn(), sweep: vi.fn() };
      dispatcher.setRetryQueue(retryQueue as any);
      await soloClassifier();
      adapter.deliver.mockImplementation(async (result: any) => {
        if (result.text === MEETING_ACK_TEXT) throw new Error("slack 503");
      });
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t12"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      await settleAcked();

      expect(ackCalls()).toHaveLength(1); // attempted...
      expect(retryQueue.enqueue).not.toHaveBeenCalled(); // ...and NOT queued

      // The turn's own delivery still happens normally.
      slow.release(turn({ finalMessage: "The answer regardless." }));
      await dispatched;
      await settleAcked();
      const answers = adapter.deliver.mock.calls.filter((c: any[]) => c[0].text !== MEETING_ACK_TEXT);
      expect(answers).toHaveLength(1);
      expect(answers[0][0].text).toBe("The answer regardless.");
      expect(retryQueue.enqueue).not.toHaveBeenCalled();
    });

    it("T11 (KPR-417, §6.4): an acked turn that SUPPRESSES leaves the ack as its only post — no retraction, no follow-up", async () => {
      // The fourth failure case. Under delay-then-ack this requires the
      // suppressor to ALSO be slow, narrowing it to the grok-shaped
      // population — but it is not exotic: the meeting preamble actively
      // instructs the decline, and three of four round-0 responders suppressed
      // in the live trial.
      //
      // ⚠ RULING: ACCEPT THE ORPHANED ACK (spec §6.4). "On it — picked this
      // up." followed by nothing reads as *took the item, had nothing to add*
      // — exactly what happened. Nothing was promised and no active work was
      // claimed; that is what makes the no-retraction rule liveable. Do NOT
      // add a chat.delete, a chat.update, a "…had nothing to add" follow-up,
      // or a ✅/💤 reaction. All four are argued down in §6.4 ground 3.
      await soloClassifier();
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t11"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(1);

      slow.release(turn({ finalMessage: "No response needed." }));
      await dispatched;
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);

      // The ack is the ONLY post from that agent for that turn.
      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);
      // Explicitly: no retraction, no follow-up, no "_No response._" placeholder.
      expect(adapter.deliver.mock.calls.some((c: any[]) => c[0].text === "_No response._")).toBe(false);
      expect(mockLogInfo).toHaveBeenCalledWith(
        "Non-response suppressed (fan-out)",
        expect.objectContaining({ agentId: "jasper", conferenceRound: 0 }),
      );
    });

    it("T11 companion (KPR-417/KPR-416): the acked-then-suppressed agent is STILL round-1-eligible, so the orphan CAN resolve", async () => {
      // ⚠ ITS PURPOSE IS PRECISE (spec §11): this is a tripwire for a REVERT
      // OF KPR-416's RELOCATION of the reaction-exclusion write from selection
      // time to delivery time — NOT for a change to A's write PREDICATE.
      // Under either predicate A considered, a suppressed turn writes nothing
      // (it sits in the isNonResponse branch with no real content either way),
      // so this test is predicate-INSENSITIVE. It fails only if the write
      // moves back to selection time, where every selected round-0 agent is
      // excluded regardless of outcome and the orphan becomes permanent by
      // construction — which is exactly what evaporates §6.4 ground 2.
      //
      // Ground 2 is deliberately the WEAKEST of §6.4's four grounds: the
      // acked-and-suppressed population is by construction made of SLOW
      // suppressors, and for one of them to earn a round-1 reaction an even
      // SLOWER peer must deliver real content on the same trigger. The ruling
      // stands on grounds 1, 3 and 4 regardless of how often this fires.
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper", "jessica"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const jasperSlow = hangingTurn();
      const jessicaSlow = hangingTurn();
      agentManager.runWorkItemTurn.mockImplementation((agentId: string, item: any) => {
        if (item?.meta?.conferenceRound === 1) return Promise.resolve(turn({ finalMessage: "Jessica reacts." }));
        return agentId === "jasper" ? jasperSlow.promise : jessicaSlow.promise;
      });

      const dispatched = dispatcher.dispatch(
        confAckItem("conf-thread-kpr417-t11b", "Jasper, and Jessica, discuss the launch plan"),
      );
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(2); // both slow agents acked

      // Jessica suppresses; Jasper then delivers real content.
      jessicaSlow.release(turn({ finalMessage: "No response needed." }));
      await settleAcked();
      jasperSlow.release(turn({ finalMessage: "Here is what I found after a long dig." }));
      await dispatched;
      await settleAcked();
      await settleAcked();

      // ← THE PIN: the acked-then-suppressed agent still runs a round-1 turn
      //   and its reaction posts. The orphan resolved.
      const round1 = agentManager.runWorkItemTurn.mock.calls.filter((c: any[]) => c[1]?.meta?.conferenceRound === 1);
      expect(round1.map((c: any[]) => c[0])).toEqual(["jessica"]);
      expect(adapter.deliver.mock.calls.some((c: any[]) => c[0].text === "Jessica reacts.")).toBe(true);
      // Still exactly two acks — round-1 never acks (T3's contract, re-checked here).
      expect(ackCalls()).toHaveLength(2);
    });
  });

  it("T13a (KPR-417): dispatcher.ts has exactly ONE fetchThreadHistory call site", () => {
    // Drift catcher for spec §5.5's central claim. A third meeting-history
    // read added later WITHOUT going through fetchMeetingHistory would
    // silently re-expose acks to that consumer — the one failure mode the
    // one-strip-point design exists to prevent. `//` line comments are
    // stripped so prose mentioning the method cannot false-positive.
    const source = readFileSync(fileURLToPath(new URL("./dispatcher.ts", import.meta.url)), "utf8");
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    const hits = codeOnly.match(/\.fetchThreadHistory\s*\(/g) ?? [];
    expect(
      hits.length,
      "dispatcher.ts must read meeting history through exactly one fetchThreadHistory call, inside fetchMeetingHistory (KPR-417 §5.5)",
    ).toBe(1);
    // ...and that one call must be inside fetchMeetingHistory.
    const fnStart = codeOnly.indexOf("private async fetchMeetingHistory(");
    const fnEnd = codeOnly.indexOf("private async resolveConferenceAgents(", fnStart);
    expect(fnStart, "fetchMeetingHistory not found — update this test's anchors").toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    expect(codeOnly.slice(fnStart, fnEnd)).toContain(".fetchThreadHistory(");
  });

  it("T13b (KPR-417): the ack cancel lives inside runTurnWithMeetingAck, not around the dispatchToAgent body", () => {
    // Drift catcher for spec §5.1's ordering guarantee. Relocating the cancel
    // to a finally around the whole dispatchToAgent body would let a still-
    // armed timer post "On it" AFTER the answer: delivery, the KPR-388 mark
    // write and the outage/deadline gates all run after the turn settles.
    const source = readFileSync(fileURLToPath(new URL("./dispatcher.ts", import.meta.url)), "utf8");
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    const helperStart = codeOnly.indexOf("private async runTurnWithMeetingAck(");
    const dispatchStart = codeOnly.indexOf("private async dispatchToAgent(");
    expect(helperStart, "runTurnWithMeetingAck not found — update this test's anchors").toBeGreaterThan(-1);
    expect(dispatchStart, "dispatchToAgent not found — update this test's anchors").toBeGreaterThan(helperStart);
    const helperBody = codeOnly.slice(helperStart, dispatchStart);
    expect(helperBody).toContain("ack?.cancel();");
    // And nowhere else in the file.
    expect((codeOnly.match(/ack\?\.cancel\(\);/g) ?? []).length).toBe(1);
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

  it.each([
    ["no meetingExclusionTs at all", undefined],
    ["a malformed non-string meetingExclusionTs", 42],
    ["an empty-string meetingExclusionTs", ""],
  ])(
    "T4b (KPR-416): write site 2 no-ops cleanly for a plain single-dispatch turn with %s",
    async (_label, exclusionTs) => {
      // Write site 2 sits on the delivery branch of the ORDINARY single-
      // dispatch path — the hot path of every non-conference turn in the
      // engine. This is the only test guarding that blast radius: no tracker
      // mutation, no throw, delivery unaffected. Non-`conf-` label ⇒ ordinary
      // routing (dispatcher.ts:1176).
      const meta: Record<string, unknown> = { slackTs: "1700.0007" };
      if (exclusionTs !== undefined) meta.meetingExclusionTs = exclusionTs;

      await dispatcher.dispatch(
        makeWorkItem({
          text: "what is the deploy status?",
          source: { kind: "slack", id: "C999", label: "general" },
          threadId: `plain-thread-${String(_label).replace(/\W+/g, "-")}`,
          meta,
        }),
      );

      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe("Agent response");
      expect(
        (dispatcher as unknown as { meetingReactionTracker: Map<string, unknown> }).meetingReactionTracker.size,
      ).toBe(0);
    },
  );

  it("T4 (KPR-416): an outage-queued round-0 turn that later replays and delivers excludes that agent", async () => {
    // Write site 2's replay half, end-to-end: phase 1 queues the real
    // effectiveItem via the outage path; phase 2 replays THAT item with the
    // breaker closed and asserts the delivery marked exclusion. §4's table
    // row: "post-turn outage queue" is no longer excluded at queue time — the
    // replay's own delivery is what excludes.
    await soloClassifier();
    const threadId = "conf-thread-kpr416-t4";
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

    // Phase 1 — breaker open + hard fault ⇒ the turn queues, nothing delivered.
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      turn({ finalMessage: "", errors: ["connect ECONNREFUSED api"] }),
    );
    await dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t4" },
        threadId,
        meta: { slackTs: "1700.0008" },
      }),
    );
    expect(outageStore.enqueue).toHaveBeenCalledTimes(1);
    // Phase 1 delivered the KPR-307 honest-outage NOTICE (policyFor ⇒ "notify",
    // first episode for this thread), so deliver has already fired once. That
    // notice is engine chrome, not agent content — pin it, then clear the call
    // record so phase 2's assertions read a clean `calls[0]`. mockClear only:
    // mockReset/clearAllMocks would drop the harness's deliver implementation.
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toContain("provider outage");
    adapter.deliver.mockClear();
    expect(excludedFor(threadId, "1700.0008")).toBeUndefined(); // queued ⇒ NOT excluded

    // Phase 2 — replay the item the store actually holds, breaker closed.
    const queued = outageStore.enqueue.mock.calls[0][0].workItem as WorkItem;
    expect(queued.meta?.meetingExclusionTs).toBe("1700.0008"); // the key rode the doc
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
    agentManager.runWorkItemTurn.mockResolvedValueOnce(turn({ finalMessage: "The real answer, at last" }));
    await dispatcher.dispatch({
      ...queued,
      meta: { ...queued.meta, outageReplay: true, targetAgentId: "jasper" },
    });

    expect(adapter.deliver).toHaveBeenCalledTimes(1); // post-mockClear: the real content only
    expect(adapter.deliver.mock.calls[0][0].text).toBe("The real answer, at last");
    expect(excludedFor(threadId, "1700.0008")).toEqual(new Set(["jasper"]));
  });

  it("T7 (KPR-416): a THROWN round-0 turn stays excluded (write site 3)", async () => {
    // Disposition (b), spec §6.2. The thrown turn posts visible error text —
    // the same user-visible artifact an in-branch errored turn produces — so
    // it stays excluded. Passes pre- and post-fix: this half pins the
    // predicate, not the relocation.
    await soloClassifier();
    const thrownThread = "conf-thread-kpr416-t7-thrown";
    agentManager.runWorkItemTurn.mockRejectedValueOnce(new Error("boom"));

    await dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t7" },
        threadId: thrownThread,
        meta: { slackTs: "1700.0009" },
      }),
    );

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toContain("Something went wrong");
    expect(excludedFor(thrownThread, "1700.0009")).toEqual(new Set(["jasper"]));
  });

  it("T7 companion (KPR-416): a ProviderCircuitOpenError fast-fail is NOT excluded", async () => {
    // The exemption half. A fast-fail posts an engine NOTICE, not agent
    // content, so it must never mark — handleOutageTurn's early return in
    // handleTurnFailure lands before write site 3, and this is its pin.
    await soloClassifier();
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
    const fastFailThread = "conf-thread-kpr416-t7-fastfail";
    // ProviderCircuitOpenError's `provider` param is typed `string` (see
    // provider-circuit-breaker.ts:94) — no cast needed.
    agentManager.runWorkItemTurn.mockRejectedValueOnce(
      new ProviderCircuitOpenError("claude", Date.now(), 15_000, "connect-fail", "fetch failed"),
    );

    await dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t7" },
        threadId: fastFailThread,
        meta: { slackTs: "1700.0010" },
      }),
    );

    expect(outageStore.enqueue).toHaveBeenCalledTimes(1); // queued as a notice, not agent text
    expect(excludedFor(fastFailThread, "1700.0010")).toBeUndefined(); // notice, not agent text
  });

  it("T9 (KPR-416): ⚠ ACCEPTED RESIDUAL — a peer whose round-0 turn has not landed IS invited as a round-1 reactor", async () => {
    // This pins a KNOWN, DELIBERATELY DEFERRED gap, not desired behavior.
    // Post-relocation there is no in-flight round-0 registry (the removed
    // selection-time write was incidentally serving as one), so within the
    // overlap window a peer that still owes a round-0 answer can also be
    // invited to react. Deferred because: (1) agent-manager's per-thread lock
    // `agentId:threadId` serializes the peer's round-1 turn behind its own
    // round-0 turn, so it answers first and then reacts — an extra turn, not a
    // duplicate answer, with round-1's "do not re-answer" framing holding the
    // line; (2) the in-scope fix would need an await inside
    // triggerConferenceReactions' claim-before-await loop, forfeiting KPR-387's
    // actual guarantee, and a pending-set leak at any early return means
    // PERMANENT exclusion — the original bug, worse.
    //
    // Spec: docs/epics/kpr-415/kpr-416-spec.md §6.4(d). The follow-on child
    // filed against KPR-415 INVERTS this assertion — when it lands, this test
    // is expected to change, and that is the signal, not a regression.
    //
    // KPR-420 non-conflation note: this residual is CLAIM-TIME invitation of
    // an in-flight peer (KPR-419's scope). It is distinct from RELEASE-TIME
    // erasure of a landed peer's delivery mark, which KPR-420 fixed (see
    // "T1 (KPR-420)" below) — the two must not be conflated.
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({ respondAgentIds: ["jasper", "river"], costUsd: 0.001, durationMs: 100 })
      .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });

    const threadId = "conf-thread-kpr416-t9";
    let releaseRiver!: () => void;
    const riverLanded = new Promise<void>((resolve) => {
      releaseRiver = resolve;
    });
    agentManager.runWorkItemTurn.mockImplementation(async (agentId: string) => {
      if (agentId === "river") {
        await riverLanded; // river's round-0 turn has NOT landed when jasper reacts
        return turn({ finalMessage: "River, eventually" });
      }
      return turn({ finalMessage: "Jasper answers immediately" });
    });

    const dispatched = dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, River, and Jessica, discuss the launch plan",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t9" },
        threadId,
        meta: { slackTs: "1700.0012" },
      }),
    );

    // Jasper's reaction pass fires while river is still in flight.
    const reactionCalls = () =>
      (classifyMeetingMessage as any).mock.calls.filter((c: any[]) => c[0] === "Jasper answers immediately");
    await vi.waitFor(() => expect(reactionCalls().length).toBeGreaterThanOrEqual(1));

    const peerIds = reactionCalls()[0][1].map((m: any) => m.agentId);
    expect(peerIds).toContain("river"); // ⚠ the residual: river owes an answer AND is invited
    expect(peerIds).toContain("jessica"); // jessica never ran at all — expected

    releaseRiver();
    await dispatched;
    await settleReactions();
  });

  it("T1 (KPR-420): a round-0 primary that delivers DURING a sibling's classifier await stays excluded after release", async () => {
    // The delivery-mark erasure race (kpr-420-spec.md §1), engineered for
    // real — the unsuppressed sibling of the macrotask-ordered KPR-387 guard
    // above (:517). Sequence: jasper delivers fast and his reaction pass
    // synchronously claims river + jessica, then parks on a HELD classifier
    // call; river's round-0 turn delivers mid-await (promoting his claim to
    // a delivery mark); the classifier resolves selecting nobody, so the
    // release loop runs; jessica then delivers round-0 and fires her own
    // pass. Pre-fix the release erased river's mark (claim and delivery mark
    // were the same aliased Set entry), so jessica's pass re-claimed river
    // and selected him for a round-1 reaction to a trigger he had already
    // answered. Post-fix the release spares the promoted entry and river
    // never reappears in any roster.
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    const threadId = "conf-thread-kpr420-t1";
    const humanText = "Jasper, River, and Jessica, discuss the launch plan";

    let resolveJasperPass!: (v: unknown) => void;
    const jasperPassHeld = new Promise((r) => {
      resolveJasperPass = r;
    });
    (classifyMeetingMessage as any).mockImplementation(async (text: string) => {
      if (text === humanText) {
        // Round-0: all three named agents are primaries.
        return { respondAgentIds: ["jasper", "river", "jessica"], costUsd: 0.001, durationMs: 100 };
      }
      if (text === "Jasper's answer") return jasperPassHeld; // held mid-await
      if (text === "Jessica's answer") {
        // Reachable PRE-FIX ONLY (post-fix jessica's peerMembers is empty and
        // no call happens): select river — the erased-mark re-invitation.
        return { respondAgentIds: ["river"], costUsd: 0.001, durationMs: 100 };
      }
      return { respondAgentIds: [], costUsd: 0.001, durationMs: 100 };
    });

    let releaseRiver!: () => void;
    const riverGate = new Promise<void>((r) => (releaseRiver = r));
    let releaseJessica!: () => void;
    const jessicaGate = new Promise<void>((r) => (releaseJessica = r));
    agentManager.runWorkItemTurn.mockImplementation(async (agentId: string, dispatchedItem: any) => {
      if (agentId === "river" && dispatchedItem?.meta?.conferenceRound === 0) {
        await riverGate;
        return turn({ finalMessage: "River's answer" });
      }
      if (agentId === "jessica") {
        await jessicaGate;
        return turn({ finalMessage: "Jessica's answer" });
      }
      return turn({ finalMessage: "Jasper's answer" });
    });

    const dispatched = dispatcher.dispatch(
      makeWorkItem({
        text: humanText,
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr420-t1" },
        threadId,
        meta: { slackTs: "1700.0420" },
      }),
    );

    // Step 1 — jasper delivered; his pass has synchronously claimed river +
    // jessica and is now parked on the held classifier call.
    const jasperPassCalls = () =>
      (classifyMeetingMessage as any).mock.calls.filter((c: any[]) => c[0] === "Jasper's answer");
    await vi.waitFor(() => expect(jasperPassCalls().length).toBe(1));

    // Step 2 — river's round-0 turn delivers MID-AWAIT (write site 1 fires;
    // river's own pass finds nothing unclaimed and returns without a
    // classifier call).
    releaseRiver();
    await vi.waitFor(() =>
      expect(adapter.deliver.mock.calls.some((c: any[]) => c[0].text === "River's answer")).toBe(true),
    );

    // Step 3 — jasper's classifier resolves selecting nobody; the release
    // loop runs over his pass's peerMembers (river + jessica).
    resolveJasperPass({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });
    await settleReactions();

    // Step 4 — jessica delivers round-0 and fires her own pass.
    releaseJessica();
    await dispatched;
    await settleReactions();
    await settleReactions();

    // No reaction-pass roster captured after river's delivery contains river.
    const jessicaPassRosters = (classifyMeetingMessage as any).mock.calls
      .filter((c: any[]) => c[0] === "Jessica's answer")
      .map((c: any[]) => c[1].map((m: any) => m.agentId));
    for (const rosterIds of jessicaPassRosters) {
      expect(rosterIds).not.toContain("river"); // pre-fix: FAILS — river re-claimed
    }

    // River ran exactly once (round-0) — never a round-1 turn on this trigger.
    const riverTurns = agentManager.runWorkItemTurn.mock.calls.filter((c: any[]) => c[0] === "river");
    expect(riverTurns.length).toBe(1); // pre-fix: FAILS at 2

    // The promoted entry survived release as a delivery mark.
    expect(excludedFor(threadId, "1700.0420")?.has("river")).toBe(true);
    expect(rawTrackerLeaf(threadId, "1700.0420")?.get("river")).toBe("delivery-mark");
  });

  it("T2 (KPR-420): an unselected, UNDELIVERED claim is still released and re-claimable by a later pass", async () => {
    // Pins that the provenance guard does not over-retain (spec goal 2, the
    // KPR-387→KPR-416 release semantics unchanged): jessica is a roster
    // member who is NOT a round-0 primary — claimed by jasper's pass, held
    // as a plain "claim" through the classifier await, released on
    // non-selection, then re-claimed by river's later pass. Also pins the §7
    // convergence edge: river's claim is released while he is undelivered,
    // and his subsequent delivery writes a FRESH "delivery-mark".
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    const threadId = "conf-thread-kpr420-t2";
    const humanText = "Jasper, River, and Jessica, discuss the launch plan";

    let resolveJasperPass!: (v: unknown) => void;
    const jasperPassHeld = new Promise((r) => {
      resolveJasperPass = r;
    });
    (classifyMeetingMessage as any).mockImplementation(async (text: string) => {
      if (text === humanText) {
        // Round-0: jasper + river only — jessica never runs a round-0 turn.
        return { respondAgentIds: ["jasper", "river"], costUsd: 0.001, durationMs: 100 };
      }
      if (text === "Jasper's answer") return jasperPassHeld;
      return { respondAgentIds: [], costUsd: 0.001, durationMs: 100 };
    });

    let releaseRiver!: () => void;
    const riverGate = new Promise<void>((r) => (releaseRiver = r));
    agentManager.runWorkItemTurn.mockImplementation(async (agentId: string) => {
      if (agentId === "river") {
        await riverGate;
        return turn({ finalMessage: "River's answer" });
      }
      return turn({ finalMessage: "Jasper's answer" });
    });

    const dispatched = dispatcher.dispatch(
      makeWorkItem({
        text: humanText,
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr420-t2" },
        threadId,
        meta: { slackTs: "1700.0421" },
      }),
    );

    // Jasper's pass has claimed river (in-flight) and jessica (never runs).
    const jasperPassCalls = () =>
      (classifyMeetingMessage as any).mock.calls.filter((c: any[]) => c[0] === "Jasper's answer");
    await vi.waitFor(() => expect(jasperPassCalls().length).toBe(1));
    expect(rawTrackerLeaf(threadId, "1700.0421")?.get("jessica")).toBe("claim");

    // Classifier selects nobody → both UNDELIVERED claims are released.
    resolveJasperPass({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });
    await settleReactions();
    expect(excludedFor(threadId, "1700.0421")?.has("jessica")).toBe(false);
    expect(excludedFor(threadId, "1700.0421")?.has("river")).toBe(false);

    // River then delivers round-0: fresh "delivery-mark", and his own pass
    // re-claims jessica — release did not over-retain.
    releaseRiver();
    await dispatched;
    await settleReactions();
    const riverPassCalls = (classifyMeetingMessage as any).mock.calls.filter((c: any[]) => c[0] === "River's answer");
    expect(riverPassCalls.length).toBe(1);
    expect(riverPassCalls[0][1].map((m: any) => m.agentId)).toContain("jessica");
    expect(rawTrackerLeaf(threadId, "1700.0421")?.get("river")).toBe("delivery-mark");
  });

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

      it("T8b (KPR-416): a continuation leg's delivery excludes; a cap-exhausted chain and a zero-progress abort do NOT", async () => {
        // Disposition (c), spec §6.3. The exclusion is written at DELIVERY, so
        // the leg that finally answers is what marks — and a chain that never
        // answers marks nothing. The two companions assert the same shape
        // through different arms, so a regression that starts marking at the
        // ABORT site rather than at delivery fails on both.
        await soloClassifier();
        const threadId = "conf-thread-kpr416-t8b";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn
          .mockResolvedValueOnce(ABORT_WITH_PROGRESS) // origin: deadline abort with progress
          .mockResolvedValueOnce(turn({ finalMessage: "Finished it on the second pass" })); // leg 1: answers

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t8b" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );
        await settleReactions();
        await settleReactions();

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
        expect(excludedFor(threadId, "1000.0004")).toEqual(new Set(["jasper"]));
      });

      it("T8b companion 1 (KPR-416): a chain that exhausts MAX_DEADLINE_CONTINUATIONS never excludes", async () => {
        await soloClassifier();
        const threadId = "conf-thread-kpr416-t8b-cap";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValue(ABORT_WITH_PROGRESS); // every leg aborts

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t8b" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );
        await settleReactions();
        await settleReactions();

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(MAX_DEADLINE_CONTINUATIONS + 1);
        // Terminal notice only — the agent never answered, so it is correctly
        // still eligible to react to a peer on this trigger.
        expect(excludedFor(threadId, "1000.0004")).toBeUndefined();
      });

      it("T8b companion 2 (KPR-416): a ZERO-progress deadline abort (notice only, no leg) never excludes", async () => {
        // §4's zero-progress row: maybeHandleDeadlineAbort's !withProgress arm
        // returns true after a notice, with no continuation leg and no
        // deliverAgentResult call — so no write site is ever reached.
        await soloClassifier();
        const threadId = "conf-thread-kpr416-t8b-zero";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValueOnce(
          turn({ finalMessage: "", timedOut: true, aborted: true }), // no toolCalls, not streamed
        );

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t8b" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );
        await settleReactions();

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1); // no leg
        expect(excludedFor(threadId, "1000.0004")).toBeUndefined();
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
        toolAckInjected: 0,
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
        toolAckInjected: 0,
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
        toolAckInjected: 0,
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
        toolAckInjected: 0,
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

    it("T2 (KPR-416): a suppressed round-0 responder re-invited as a reactor takes the DELTA arm, which omits the trigger", async () => {
      // The §7.2 re-based invariant, on the path KPR-416 newly exposes. The
      // asserted property is mark-advance-implies-own-turn-presented-it — NOT
      // "the delta covers the trigger", which is precisely what stops being
      // true here. Preconditions pinned explicitly: jessica's round-0 turn was
      // SUPPRESSED, her injection mode was `delta`, and resumedSession is true
      // so the clearMeetingMark branch does not apply.
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper", "jessica"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-kpr416-t2";
      const TRIGGER = "settle the pricing question before Friday";
      seedRef("jessica", threadId, { sessionId: "sess-j", provider: "claude", meetingLastSeenTs: "1000.0001" });

      // The mark write must actually feed the round-1 read for this invariant
      // to mean anything, so make setMeetingMark mutate the seeded ref.
      agentManager._sessionStore.setMeetingMark.mockImplementation(
        async (agentId: string, thread: string, ts: string) => {
          const key = `${agentId}:${thread}`;
          const ref = agentManager._sessionRefs.get(key);
          if (ref) agentManager._sessionRefs.set(key, { ...ref, meetingLastSeenTs: ts });
        },
      );

      mockSlackAdapter.fetchThreadHistory
        .mockResolvedValueOnce(
          makeHistory([
            { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
            { author: "May", text: TRIGGER, ts: "1000.0005", minAgo: 5 },
          ]),
        )
        .mockResolvedValue(
          makeHistory([
            { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
            { author: "May", text: TRIGGER, ts: "1000.0005", minAgo: 5 },
            { author: "Jasper", text: "Slow findings on pricing", ts: "1000.0006", minAgo: 4, isBot: true },
          ]),
        );

      agentManager.runWorkItemTurn.mockImplementation(async (agentId: string) => {
        if (agentId === "jasper") {
          await new Promise((r) => setTimeout(r, 10)); // slow peer: jessica's mark lands first
          return turn({ finalMessage: "Slow findings on pricing", resumedSession: true });
        }
        return turn({ finalMessage: "No response needed.", resumedSession: true });
      });

      await dispatcher.dispatch(
        makeWorkItem({
          text: `Jasper, and Jessica, ${TRIGGER}`,
          source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t2" },
          threadId,
          meta: { slackTs: "1000.0005" },
        }),
      );

      // Precondition: jessica's round-0 turn was delta-mode and suppressed.
      const jessicaRound0 = agentManager.runWorkItemTurn.mock.calls.find(
        (c: any[]) => c[0] === "jessica" && c[1]?.meta?.conferenceRound === 0,
      );
      expect(jessicaRound0).toBeDefined();
      expect(jessicaRound0![1].meta.conferenceInjectionMode).toBe("delta");
      expect(mockLogInfo).toHaveBeenCalledWith(
        "Non-response suppressed (fan-out)",
        expect.objectContaining({ agentId: "jessica", conferenceRound: 0 }),
      );

      // (i) The mark advanced to >= the trigger ts on that suppressed turn.
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jessica", threadId, "1000.0005");

      // Vacuous-pass guard: a round-1 turn must actually have happened before
      // asserting over its text (pre-fix it never dispatches at all).
      const round1Call = () =>
        agentManager.runWorkItemTurn.mock.calls.find(
          (c: any[]) => c[0] === "jessica" && c[1]?.meta?.conferenceRound === 1,
        );
      await vi.waitFor(() => expect(round1Call()).toBeDefined());

      // (ii) It took the delta arm, and the delta OMITS the trigger — safe only
      // by the §7.2 invariant (jessica's own round-0 terminal slot presented it).
      const round1Item = round1Call()![1];
      expect(round1Item.meta.conferenceInjectionMode).toBe("delta");
      // The two load-bearing assertions: the delta header is present, and the
      // human trigger is ABSENT from a re-invited suppressed agent's context.
      expect(round1Item.text).toContain("[New messages since your last turn:]");
      expect(round1Item.text).not.toContain(TRIGGER);
      // The delta BODY, pinned against the line shape formatDeltaContext
      // actually emits (`${author} (${ago}): ${text}`, dispatcher.ts:1808)
      // and anchored to the header so it cannot be satisfied from elsewhere.
      // A bare `toContain("Slow findings on pricing")` would be near-vacuous:
      // that string is also in reactionTo.text in the terminal slot, so it
      // passes even when the delta is empty or wrong.
      expect(round1Item.text).toMatch(
        /\[New messages since your last turn:\]\n\nJasper \([^)]+\): Slow findings on pricing/,
      );
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
        toolAckInjected: 0,
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
        toolAckInjected: 0,
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
