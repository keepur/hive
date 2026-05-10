import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { SmsAdapter, type SmsAdapterPerTurnDeps } from "./sms-adapter.js";
import type { AgentManager, TurnContext, TurnResult } from "../agents/agent-manager.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";

// --- Test fixtures -----------------------------------------------------------

function makeQuoConvResponse(participant: string) {
  return {
    data: [{ participants: [participant] }],
  };
}

function makeQuoMsgResponse(opts: {
  msgId: string;
  from: string;
  to: string;
  text: string;
  direction?: "incoming" | "outgoing";
}) {
  return {
    data: [
      {
        id: opts.msgId,
        from: opts.from,
        to: [opts.to],
        text: opts.text,
        direction: opts.direction ?? "incoming",
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Wires a fetch stub that recognizes:
 *   GET  /conversations           → conversations list
 *   GET  /messages                → message list (filtered to incoming by adapter)
 *   POST /messages                → outbound delivery (returns 200)
 *
 * Returns a `outboundCalls` array so tests can assert on Quo delivery payloads.
 */
function wireQuoFetch(opts: {
  participant: string;
  msgId: string;
  text: string;
  lineNumber: string;
}) {
  const outboundCalls: Array<{ url: string; body: any }> = [];

  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";

    if (method === "POST" && u.includes("/messages")) {
      outboundCalls.push({ url: u, body: JSON.parse(String(init!.body)) });
      return makeJsonResponse({ ok: true });
    }
    if (u.includes("/conversations")) {
      return makeJsonResponse(makeQuoConvResponse(opts.participant));
    }
    if (u.includes("/messages")) {
      return makeJsonResponse(
        makeQuoMsgResponse({
          msgId: opts.msgId,
          from: opts.participant,
          to: opts.lineNumber,
          text: opts.text,
        }),
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${u}`);
  });

  vi.stubGlobal("fetch", fetchStub);
  return { fetchStub, outboundCalls };
}

function makeAgentManagerStub(turnResult: Partial<TurnResult> = {}) {
  const calls: Array<{ ctx: TurnContext }> = [];

  const sessionStore = {
    get: vi.fn().mockResolvedValue(undefined as string | undefined),
    set: vi.fn().mockResolvedValue(undefined),
  };

  const spawnTurn = vi.fn(async (ctx: TurnContext) => {
    calls.push({ ctx });
    return {
      finalMessage: "agent reply",
      newSessionId: "session-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 200000,
        costUsd: 0.001,
        durationMs: 200,
      },
      errors: [],
      ...turnResult,
    } satisfies TurnResult;
  });

  const findAgentForThread = vi.fn().mockResolvedValue(undefined as string | undefined);

  const stub: Pick<AgentManager, "spawnTurn" | "findAgentForThread" | "getSessionStore"> = {
    spawnTurn: spawnTurn as unknown as AgentManager["spawnTurn"],
    findAgentForThread: findAgentForThread as unknown as AgentManager["findAgentForThread"],
    getSessionStore: () => sessionStore as any,
  };

  return { stub: stub as AgentManager, spawnTurn, findAgentForThread, sessionStore, calls };
}

const lineFixture = {
  id: "PN_LINE_1",
  label: "May (CEO)",
  number: "+15550000001",
  slackChannel: "quo-may",
};

// Helper: wait until a predicate is true, polling at short intervals.
// Used because the per-turn-spawn path is fire-and-forget inside poll().
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SmsAdapter (KPR-216)", () => {
  let stoppers: Array<() => Promise<void>> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    stoppers = [];
  });

  afterEach(async () => {
    for (const stop of stoppers) await stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("legacy path (perTurn deps absent or perTurnSpawnEnabled=false)", () => {
    it("falls back to onWorkItem callback when perTurn deps are not provided", async () => {
      const { fetchStub } = wireQuoFetch({
        participant: "+15551112222",
        msgId: "MSG_LEGACY_1",
        text: "hi from legacy",
        lineNumber: lineFixture.number,
      });

      const adapter = new SmsAdapter("quo-key-x", [lineFixture]);
      stoppers.push(() => adapter.stop());

      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      // poll() runs immediately on start.
      await waitFor(() => onWorkItem.mock.calls.length > 0);

      expect(onWorkItem).toHaveBeenCalledTimes(1);
      const item = onWorkItem.mock.calls[0]![0] as WorkItem;
      expect(item.source.kind).toBe("sms");
      expect(item.source.id).toBe(lineFixture.id);
      expect(item.text).toContain("hi from legacy");
      expect(item.threadId).toBe(`sms:${lineFixture.id}:+15551112222`);

      // Conversations + messages both fetched; no POST yet (delivery is the dispatcher's job).
      const calls = fetchStub.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/conversations"))).toBe(true);
      expect(calls.some((u) => u.includes("/messages") && !u.includes("?"))).toBe(false);
    });

    it("falls back to onWorkItem callback when perTurnSpawnEnabled is false", async () => {
      wireQuoFetch({
        participant: "+15551112223",
        msgId: "MSG_LEGACY_2",
        text: "still legacy",
        lineNumber: lineFixture.number,
      });

      const { stub: agentManager, spawnTurn } = makeAgentManagerStub();
      const perTurn: SmsAdapterPerTurnDeps = {
        agentManager,
        defaultAgentId: "default-agent",
        perTurnSpawnEnabled: false,
      };

      const adapter = new SmsAdapter("quo-key-x", [lineFixture], perTurn);
      stoppers.push(() => adapter.stop());

      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      await waitFor(() => onWorkItem.mock.calls.length > 0);

      expect(onWorkItem).toHaveBeenCalledTimes(1);
      // spawnTurn must NOT be invoked when the flag is false.
      expect(spawnTurn).not.toHaveBeenCalled();
    });
  });

  describe("per-turn path (perTurnSpawnEnabled=true)", () => {
    it("calls agentManager.spawnTurn and delivers the resulting text via Quo POST /messages", async () => {
      const { outboundCalls } = wireQuoFetch({
        participant: "+15553334444",
        msgId: "MSG_PT_1",
        text: "what's the status",
        lineNumber: lineFixture.number,
      });

      const { stub: agentManager, spawnTurn, sessionStore, calls } = makeAgentManagerStub({
        finalMessage: "All systems nominal.",
      });

      const adapter = new SmsAdapter("quo-key-y", [lineFixture], {
        agentManager,
        defaultAgentId: "default-agent",
        perTurnSpawnEnabled: true,
      });
      stoppers.push(() => adapter.stop());

      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      // Wait for the fire-and-forget per-turn spawn → Quo POST round trip.
      await waitFor(() => outboundCalls.length > 0);

      // Legacy callback must NOT fire when per-turn is on.
      expect(onWorkItem).not.toHaveBeenCalled();

      // spawnTurn invoked exactly once with the correct TurnContext.
      expect(spawnTurn).toHaveBeenCalledTimes(1);
      const ctx = calls[0]!.ctx;
      expect(ctx.agentId).toBe("default-agent");
      expect(ctx.channel).toBe("sms");
      expect(ctx.channelId).toBe(lineFixture.id);
      expect(ctx.threadId).toBe(`sms:${lineFixture.id}:+15553334444`);
      expect(ctx.workItem.text).toContain("what's the status");
      expect(ctx.sessionId).toBeUndefined();

      // Delivery posted the agent's reply back to the original sender.
      expect(outboundCalls).toHaveLength(1);
      expect(outboundCalls[0]!.body).toMatchObject({
        from: lineFixture.id,
        to: ["+15553334444"],
        content: "All systems nominal.",
      });

      expect(sessionStore.get).toHaveBeenCalledWith("default-agent", `sms:${lineFixture.id}:+15553334444`);
    });

    it("resolves a continued agent via findAgentForThread and prefers it over the default", async () => {
      wireQuoFetch({
        participant: "+15555556666",
        msgId: "MSG_PT_2",
        text: "follow up",
        lineNumber: lineFixture.number,
      });

      const { stub: agentManager, spawnTurn, findAgentForThread, calls } = makeAgentManagerStub();
      // Pretend this thread is already attached to a non-default agent.
      findAgentForThread.mockResolvedValueOnce("rae");

      const adapter = new SmsAdapter("quo-key-z", [lineFixture], {
        agentManager,
        defaultAgentId: "default-agent",
        perTurnSpawnEnabled: true,
      });
      stoppers.push(() => adapter.stop());

      await adapter.start(vi.fn());
      await waitFor(() => spawnTurn.mock.calls.length > 0);

      expect(findAgentForThread).toHaveBeenCalledWith(`sms:${lineFixture.id}:+15555556666`);
      expect(calls[0]!.ctx.agentId).toBe("rae");
    });

    it("forwards stored sessionId so the SDK can resume on subsequent turns", async () => {
      wireQuoFetch({
        participant: "+15557778888",
        msgId: "MSG_PT_3",
        text: "still here",
        lineNumber: lineFixture.number,
      });

      const { stub: agentManager, spawnTurn, sessionStore, calls } = makeAgentManagerStub();
      sessionStore.get.mockResolvedValueOnce("session-resume-xyz");

      const adapter = new SmsAdapter("quo-key-r", [lineFixture], {
        agentManager,
        defaultAgentId: "default-agent",
        perTurnSpawnEnabled: true,
      });
      stoppers.push(() => adapter.stop());

      await adapter.start(vi.fn());
      await waitFor(() => spawnTurn.mock.calls.length > 0);

      expect(calls[0]!.ctx.sessionId).toBe("session-resume-xyz");
    });

    it("skips delivery when spawnTurn returns an empty finalMessage (no Quo POST)", async () => {
      const { outboundCalls } = wireQuoFetch({
        participant: "+15559990000",
        msgId: "MSG_PT_4",
        text: "ping",
        lineNumber: lineFixture.number,
      });

      const { stub: agentManager } = makeAgentManagerStub({ finalMessage: "" });

      const adapter = new SmsAdapter("quo-key-e", [lineFixture], {
        agentManager,
        defaultAgentId: "default-agent",
        perTurnSpawnEnabled: true,
      });
      stoppers.push(() => adapter.stop());

      await adapter.start(vi.fn());
      // Give the fire-and-forget enough time to settle.
      await new Promise((r) => setTimeout(r, 80));

      expect(outboundCalls).toHaveLength(0);
    });
  });

  describe("flag toggling between adapter instances", () => {
    it("two adapters with opposite flag settings route the same input to different paths", async () => {
      // Adapter A: perTurnSpawnEnabled=false → onWorkItem path
      // Adapter B: perTurnSpawnEnabled=true  → spawnTurn path
      const { stub: amA, spawnTurn: spawnA } = makeAgentManagerStub();
      const { stub: amB, spawnTurn: spawnB } = makeAgentManagerStub();

      // First adapter
      const fetchA = wireQuoFetch({
        participant: "+15551110001",
        msgId: "MSG_TOG_A",
        text: "to legacy",
        lineNumber: lineFixture.number,
      });
      const adapterA = new SmsAdapter("k1", [lineFixture], {
        agentManager: amA,
        defaultAgentId: "default-agent",
        perTurnSpawnEnabled: false,
      });
      stoppers.push(() => adapterA.stop());
      const cbA = vi.fn();
      await adapterA.start(cbA);
      await waitFor(() => cbA.mock.calls.length > 0);
      expect(spawnA).not.toHaveBeenCalled();
      expect(cbA).toHaveBeenCalledTimes(1);

      // Reset fetch for adapter B
      vi.unstubAllGlobals();
      const fetchB = wireQuoFetch({
        participant: "+15551110002",
        msgId: "MSG_TOG_B",
        text: "to per-turn",
        lineNumber: lineFixture.number,
      });
      const adapterB = new SmsAdapter("k2", [lineFixture], {
        agentManager: amB,
        defaultAgentId: "default-agent",
        perTurnSpawnEnabled: true,
      });
      stoppers.push(() => adapterB.stop());
      const cbB = vi.fn();
      await adapterB.start(cbB);
      await waitFor(() => spawnB.mock.calls.length > 0 || fetchB.outboundCalls.length > 0);

      expect(cbB).not.toHaveBeenCalled();
      expect(spawnB).toHaveBeenCalledTimes(1);

      // Sanity: each fetch stub only saw its own call set.
      expect(fetchA.fetchStub).toHaveBeenCalled();
    });
  });

  describe("deliver() (Quo POST shape — independent of per-turn flag)", () => {
    it("posts to /messages with from=phoneNumberId, to=[sender], content=text", async () => {
      const { outboundCalls } = wireQuoFetch({
        participant: "x",
        msgId: "x",
        text: "x",
        lineNumber: lineFixture.number,
      });
      const adapter = new SmsAdapter("qk", [lineFixture]);
      const result: WorkResult = {
        text: "hi back",
        agentId: "agent-a",
        workItem: {
          id: "MSG_DELIVER_1",
          text: "ignored",
          source: { kind: "sms", id: lineFixture.id, label: lineFixture.label },
          sender: "+15554443333",
          threadId: `sms:${lineFixture.id}:+15554443333`,
          timestamp: new Date(),
        },
        costUsd: 0,
        durationMs: 0,
      };
      await adapter.deliver(result);

      expect(outboundCalls).toHaveLength(1);
      expect(outboundCalls[0]!.body).toEqual({
        from: lineFixture.id,
        to: ["+15554443333"],
        content: "hi back",
      });
    });

    it("skips delivery when result.error is set", async () => {
      const { outboundCalls } = wireQuoFetch({
        participant: "x",
        msgId: "x",
        text: "x",
        lineNumber: lineFixture.number,
      });
      const adapter = new SmsAdapter("qk", [lineFixture]);
      await adapter.deliver({
        text: "should not send",
        agentId: "agent-a",
        workItem: {
          id: "ERR1",
          text: "x",
          source: { kind: "sms", id: lineFixture.id, label: lineFixture.label },
          sender: "+15550000099",
          threadId: "t",
          timestamp: new Date(),
        },
        costUsd: 0,
        durationMs: 0,
        error: "agent crashed",
      });
      expect(outboundCalls).toHaveLength(0);
    });
  });
});

// Note: integration test (round-trip Sms → real-ish AgentManager → stubbed
// AgentRunner → Quo POST) lives in `sms-adapter.integration.test.ts` so its
// module-level mocks for AgentManager's deps don't affect this file's
// black-box adapter tests above.
