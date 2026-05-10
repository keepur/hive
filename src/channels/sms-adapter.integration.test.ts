/**
 * KPR-216 integration test: SmsAdapter per-turn path → real AgentManager →
 * (stubbed) AgentRunner → AgentManager finalization (session-store update) →
 * SmsAdapter delivery (Quo POST).
 *
 * Per the plan §4: the SMS per-turn path bypasses the dispatcher (deviation
 * #4 in the implementation report, flagged for review). So this round-trip
 * exercises everything *except* the dispatcher, end-to-end:
 *
 *   inbound poll → spawnTurnForWorkItem → AgentManager.spawnTurn →
 *   AgentRunner.send (stub) → finalizeSpawnResult (session rotation
 *   persistence) → adapter.deliver → fetch POST /messages
 *
 * Lives in its own file so the file-level vi.mock() calls for AgentManager's
 * collaborators don't affect the black-box `sms-adapter.test.ts`.
 *
 * Why no real Mongo: spawnTurn never touches Mongo directly — it threads
 * through SessionStore.set/get, which we stub with an in-memory Map. That's
 * the boundary the plan calls "in-memory MongoClient + stubbed query()".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    plugins: [],
    modelRouter: { enabled: false },
    memory: { reflectionMinTurns: 3 },
  },
}));

vi.mock("../plugins/plugin-loader.js", () => ({
  loadPlugins: vi.fn().mockReturnValue([]),
}));

vi.mock("./model-router.js" as never, () => ({
  routeModel: vi.fn(),
}));

vi.mock("../files/file-processor.js", () => ({
  formatFilesForPrompt: vi.fn().mockReturnValue(""),
}));

const mockRunnerSend = vi.fn();
vi.mock("../agents/agent-runner.js", () => ({
  AgentRunner: vi.fn().mockImplementation(() => ({
    send: mockRunnerSend,
    abort: vi.fn(),
    wasAborted: false,
  })),
  DIST_DIR: "/mock/dist",
}));

const { mockConversationIndex } = vi.hoisted(() => ({
  mockConversationIndex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../search/conversation-index.js", () => ({
  ConversationIndex: vi.fn().mockImplementation(() => ({ index: mockConversationIndex })),
}));

import { AgentManager } from "../agents/agent-manager.js";
import { SmsAdapter } from "./sms-adapter.js";
import type { AgentConfig } from "../types/agent-config.js";

// ---------------------------------------------------------------------------
// Test fixtures (mirror sms-adapter.test.ts so behavior is comparable)
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeAgentConfig(): AgentConfig {
  return {
    id: "default-agent",
    name: "Default",
    model: "claude-haiku-4-5",
    channels: [],
    passiveChannels: [],
    keywords: [],
    isDefault: true,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    coreServers: ["memory"],
    delegateServers: [],
    icon: "",
    soul: "",
    systemPrompt: "",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
  };
}

function makeRunResultWith(overrides: { text?: string; sessionId: string; compactions?: number }) {
  return {
    text: overrides.text ?? "ack",
    sessionId: overrides.sessionId,
    costUsd: 0.01,
    durationMs: 100,
    llmMs: 80,
    toolMs: 20,
    toolCalls: 0,
    toolSummary: "none",
    streamed: false,
    aborted: false,
    inputTokens: 50,
    outputTokens: 25,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindow: 200000,
    compactions: overrides.compactions ?? 0,
  };
}

const lineFixture = {
  id: "PN_LINE_INTEG",
  label: "Integration Line",
  number: "+15550009999",
  slackChannel: "quo-integ",
};

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Wires fetch with a single inbound message. The first call to /messages with
 * `createdAfter` returns the message; outbound POSTs are recorded.
 */
function wirePollFetch(opts: { participant: string; msgId: string; text: string }) {
  const outbound: Array<{ body: any }> = [];
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (method === "POST" && u.includes("/messages")) {
      outbound.push({ body: JSON.parse(String(init!.body)) });
      return makeJsonResponse({ ok: true });
    }
    if (u.includes("/conversations")) {
      return makeJsonResponse({ data: [{ participants: [opts.participant] }] });
    }
    if (u.includes("/messages")) {
      return makeJsonResponse({
        data: [
          {
            id: opts.msgId,
            from: opts.participant,
            to: [lineFixture.number],
            text: opts.text,
            direction: "incoming",
            createdAt: new Date().toISOString(),
          },
        ],
      });
    }
    throw new Error(`Unexpected fetch: ${method} ${u}`);
  });
  vi.stubGlobal("fetch", fetchStub);
  return { outbound, fetchStub };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SmsAdapter per-turn round-trip integration (KPR-216)", () => {
  let agentManager: AgentManager;
  let sessionMap: Map<string, string>;
  let sessionStore: any;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionMap = new Map();
    sessionStore = {
      get: vi.fn(async (a: string, t: string) => sessionMap.get(`${a}:${t}`)),
      set: vi.fn(async (a: string, t: string, s: string) => {
        sessionMap.set(`${a}:${t}`, s);
      }),
      delete: vi.fn(),
      clearAgent: vi.fn(),
      findAgentByThread: vi.fn(async () => undefined),
    };

    const registry = {
      get: vi.fn((id: string) => (id === "default-agent" ? makeAgentConfig() : undefined)),
      getAll: () => [],
      listIds: () => ["default-agent"],
      getSubscriberMap: vi.fn().mockReturnValue({}),
    };

    const memoryManager = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    agentManager = new AgentManager(registry as any, memoryManager as any, sessionStore, undefined as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips an inbound SMS: poll → spawnTurn → AgentRunner → deliver → Quo POST", async () => {
    const { outbound } = wirePollFetch({
      participant: "+15551112222",
      msgId: "MSG_INTEG_1",
      text: "first turn",
    });

    mockRunnerSend.mockResolvedValueOnce(makeRunResultWith({ text: "ack-1", sessionId: "session-A" }));

    const adapter = new SmsAdapter("integ-key", [lineFixture], {
      agentManager,
      defaultAgentId: "default-agent",
      perTurnSpawnEnabled: true,
    });

    await adapter.start(vi.fn());
    await waitFor(() => outbound.length === 1);
    await adapter.stop();

    // AgentRunner was invoked once; the SMS WorkItem text was passed as the prompt.
    expect(mockRunnerSend).toHaveBeenCalledTimes(1);
    const [prompt, sessionArg, , bgContext] = mockRunnerSend.mock.calls[0]!;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("first turn");
    expect(sessionArg).toBeUndefined(); // first turn — no resume
    // WorkItemContext has the SMS channel/thread plumbed through.
    expect(bgContext).toMatchObject({
      channelKind: "sms",
      channelId: lineFixture.id,
      threadId: `sms:${lineFixture.id}:+15551112222`,
    });

    // SessionStore.set persisted the new id under the SMS thread key.
    const threadKey = `default-agent:sms:${lineFixture.id}:+15551112222`;
    expect(sessionMap.get(threadKey)).toBe("session-A");

    // Quo POST went out with the agent's reply.
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.body).toMatchObject({
      from: lineFixture.id,
      to: ["+15551112222"],
      content: "ack-1",
    });
  });

  it("two consecutive turns persist a rotated session id (compaction sim)", async () => {
    // Turn 1 emits session-A; turn 2 (resumed from A) rotates to session-B.
    mockRunnerSend
      .mockResolvedValueOnce(makeRunResultWith({ text: "ack-1", sessionId: "session-A" }))
      .mockResolvedValueOnce(makeRunResultWith({ text: "ack-2", sessionId: "session-B", compactions: 1 }));

    const adapter = new SmsAdapter("integ-key", [lineFixture], {
      agentManager,
      defaultAgentId: "default-agent",
      perTurnSpawnEnabled: true,
    });

    // ----- Turn 1 -----
    const wired1 = wirePollFetch({
      participant: "+15553334444",
      msgId: "MSG_INTEG_T1",
      text: "first",
    });
    await adapter.start(vi.fn());
    await waitFor(() => wired1.outbound.length === 1);
    await adapter.stop();

    const threadKey = `default-agent:sms:${lineFixture.id}:+15553334444`;
    expect(sessionMap.get(threadKey)).toBe("session-A");

    // ----- Turn 2 -----
    vi.unstubAllGlobals();
    const wired2 = wirePollFetch({
      participant: "+15553334444",
      msgId: "MSG_INTEG_T2",
      text: "second",
    });
    const adapter2 = new SmsAdapter("integ-key", [lineFixture], {
      agentManager,
      defaultAgentId: "default-agent",
      perTurnSpawnEnabled: true,
    });
    await adapter2.start(vi.fn());
    await waitFor(() => wired2.outbound.length === 1);
    await adapter2.stop();

    expect(mockRunnerSend).toHaveBeenCalledTimes(2);
    // Turn 2 resumed against session-A...
    const [, secondResume] = mockRunnerSend.mock.calls[1]!;
    expect(secondResume).toBe("session-A");
    // ...and the rotation to session-B was persisted.
    expect(sessionMap.get(threadKey)).toBe("session-B");
    expect(wired2.outbound[0]!.body.content).toBe("ack-2");
  });
});
