/**
 * KPR-219 integration test: VoiceAdapter per-turn-via-AgentManager path.
 * Real HTTP server + real client POST + mock AgentManager. Asserts the
 * full first-turn / resume-turn round-trip with SSE byte-level checks.
 *
 * Lives in its own file (mirrors ws-adapter.integration.test.ts) so the
 * file-level vi.mock() calls for the SDK and config don't leak into the
 * black-box voice-adapter.test.ts.
 *
 * Uses port: 0 (OS-assigned ephemeral) so parallel test runs never collide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { request as httpRequest, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  writeTracked: vi.fn(
    (_level: string, _msg: string, _data: Record<string, unknown> | undefined, callback: (result: string) => void) =>
      callback("acknowledged"),
  ),
  trackedSinkSnapshot: vi.fn(() => ({ sinkErrors: 0 })),
}));
vi.mock("../../logging/logger.js", () => ({ createLogger: () => mockLog }));

// Stub the SDK — the per-turn-via-AgentManager path doesn't reach `query()`,
// but the import at the top of voice-adapter.ts does.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../../agents/prompt-builder.js", () => ({
  buildVoiceSystemPrompt: vi.fn(async (_a: any, _m: any, ctx: any) => {
    return `voice-prompt:${ctx?.goal ?? ""}:${ctx?.context ?? ""}`;
  }),
}));

const configRef = {
  current: {
    anthropic: { apiKey: "test-key" },
    voice: { assistants: {} as Record<string, string> },
  },
};
vi.mock("../../config.js", () => ({
  get config() {
    return configRef.current;
  },
}));

import type { VoiceAdapter } from "./voice-adapter.js";
import type { TurnContext, TurnResult } from "../../agents/agent-manager.js";
import type { Dispatcher } from "../dispatcher.js";
import {
  BRIDGE_TOKEN as E2_BRIDGE_TOKEN,
  engineRows,
  makeAdapter,
  postChatCompletion,
  startAdapter as startFixtureAdapter,
} from "./testing/adapter-fixture.js";

function echoSpawn(): (ctx: TurnContext, onStream?: (chunk: string) => void) => Promise<TurnResult> {
  return async (_ctx, onStream) => {
    onStream?.("hi");
    return {
      finalMessage: "hi",
      newSessionId: "echo-session",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 200000,
        costUsd: 0,
        durationMs: 10,
      },
      errors: [],
    };
  };
}

function workerShapedBody(callId: string): Record<string, unknown> {
  return {
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    call: { id: callId, metadata: { hive_agent_id: "mokie" } },
  };
}

function echoTurnResult(text: string, aborted = false): TurnResult {
  return {
    finalMessage: text,
    newSessionId: "echo-session",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 200000,
      costUsd: 0,
      durationMs: 10,
    },
    errors: [],
    aborted,
  };
}

function beginStreamingChat(
  port: number,
  body: Record<string, unknown>,
): { firstChunk: () => Promise<string>; destroySocket: () => void } {
  const payload = JSON.stringify(body);
  let firstChunkResolve!: (s: string) => void;
  const firstChunkP = new Promise<string>((r) => {
    firstChunkResolve = r;
  });
  let firstSeen = false;

  const req: ClientRequest = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        authorization: `Bearer ${E2_BRIDGE_TOKEN}`,
      },
    },
    (res) => {
      res.on("data", (c) => {
        if (!firstSeen) {
          firstSeen = true;
          firstChunkResolve(c.toString("utf-8"));
        }
      });
      res.on("error", () => {
        /* destroySocket races the reader */
      });
    },
  );
  req.on("error", () => {
    /* expected once destroySocket() fires */
  });
  req.write(payload);
  req.end();

  return {
    firstChunk: () => firstChunkP,
    destroySocket: () => {
      req.destroy();
    },
  };
}

describe("VoiceAdapter integration (KPR-219)", () => {
  let adapter: VoiceAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      adapter.stop();
      adapter = undefined;
    }
    vi.clearAllMocks();
  });

  /** Records the adapter for afterEach teardown, then starts it on its ephemeral port. */
  function startAdapter(setup: ReturnType<typeof makeAdapter>): ReturnType<typeof startFixtureAdapter> {
    adapter = setup.adapter;
    return startFixtureAdapter(setup);
  }

  async function startAdapterWithHangingSpawn(opts: {
    abortThread: (agentId: string, threadId: string) => unknown;
    resolveSpawnOnDestroy?: boolean;
  }): Promise<{ port: number; spawnFinished: Promise<void>; requestAborted: Promise<void> }> {
    let releaseHang!: () => void;
    const hang = new Promise<void>((r) => {
      releaseHang = r;
    });
    let spawnFinishedResolve!: () => void;
    const spawnFinished = new Promise<void>((r) => {
      spawnFinishedResolve = r;
    });
    let requestAbortedResolve!: () => void;
    const requestAborted = new Promise<void>((r) => {
      requestAbortedResolve = r;
    });

    const setup = makeAdapter({
      spawn: async (ctx, onStream) => {
        onStream?.("first ");
        const cancelled = () => {
          requestAbortedResolve();
          releaseHang();
        };
        ctx.voiceRequestSignal?.addEventListener("abort", cancelled, { once: true });
        if (ctx.voiceRequestSignal?.aborted) cancelled();
        try {
          await hang;
          return echoTurnResult("first ", true);
        } finally {
          setImmediate(spawnFinishedResolve);
        }
      },
      abortThread: opts.abortThread,
      bridgeToken: E2_BRIDGE_TOKEN,
    });

    const { server, port: p } = await startAdapter(setup);
    if (opts.resolveSpawnOnDestroy) {
      (
        server as { on: (event: string, listener: (sock: { on: (e: string, fn: () => void) => void }) => void) => void }
      ).on("connection", (sock) => {
        sock.on("close", () => releaseHang());
      });
    }
    return { port: p, spawnFinished, requestAborted };
  }

  async function startAdapterWithHangingSessionStore(opts: {
    spawn: (ctx: TurnContext, onStream?: (chunk: string) => void) => unknown;
  }): Promise<{
    port: number;
    sessionGate: { reached: Promise<void>; release: () => void; settled: Promise<void> };
  }> {
    let markReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => {
      markReached = r;
    });
    const hang = new Promise<void>((r) => {
      release = r;
    });
    const settled = hang.then(() => new Promise<void>((r) => setImmediate(r)));
    const sessionStoreGet = vi.fn(async () => {
      markReached();
      await hang;
      return undefined;
    });

    const setup = makeAdapter({
      spawn: opts.spawn as (ctx: TurnContext, onStream?: (chunk: string) => void) => Promise<TurnResult>,
      sessionStoreGet,
      abortThread: vi.fn().mockReturnValue(false),
      bridgeToken: E2_BRIDGE_TOKEN,
    });
    const { port: p } = await startAdapter(setup);
    return { port: p, sessionGate: { reached, release, settled } };
  }

  it("first turn (no stored sessionId) — full transcript prompt + streaming SSE chunks", async () => {
    const setup = makeAdapter({
      spawn: async (_ctx, onStream) => {
        // Emit a couple of chunks before resolving.
        onStream?.("Hi ");
        onStream?.("there!");
        return {
          finalMessage: "Hi there!",
          newSessionId: "first-session-id",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: 200000,
            costUsd: 0,
            durationMs: 50,
          },
          errors: [],
        };
      },
    });

    const { port: p } = await startAdapter(setup);

    const res = await postChatCompletion(p, {
      body: {
        model: "voice-mock",
        stream: true,
        messages: [
          { role: "system", content: "you are mokie" },
          { role: "user", content: "Hello?" },
        ],
        assistant: { metadata: { hive_agent_id: "mokie" } },
        call: { id: "call-int-1", metadata: { goal: "say hi" } },
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const joined = res.chunks.join("");
    expect(joined).toContain('"content":"Hi "');
    expect(joined).toContain('"content":"there!"');
    expect(joined).toContain("[DONE]");

    // First turn: no stored sessionId, full transcript prompt path.
    expect(setup.captured).toHaveLength(1);
    const ctx = setup.captured[0]!.ctx;
    expect(ctx.sessionId).toBeUndefined();
    expect(ctx.workItem.text).toContain("Caller: Hello?");
    expect(ctx.systemPromptOverride).toBe("voice-prompt:say hi:");
    expect(ctx.threadId).toBe("voice:call-int-1");
    expect(ctx.channel).toBe("voice");
  });

  it("validates trace metadata, preserves the worker turn id, and never copies metadata into prompts or work items", async () => {
    const workerBootId = randomUUID();
    const turnId = randomUUID();
    const secretSentinel = "TRACE-SECRET-MUST-NOT-LEAK";
    const setup = makeAdapter({ spawn: echoSpawn(), bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p } = await startAdapter(setup);

    const res = await postChatCompletion(p, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: {
        ...workerShapedBody("call-trace-valid"),
        metadata: { voiceTrace: { schemaVersion: 2, workerBootId, turnId } },
        ignoredTraceField: secretSentinel,
      },
    });

    expect(res.status).toBe(200);
    expect(res.chunks.join("")).toContain(`chatcmpl-${turnId}`);
    const ctx = setup.captured[0]!.ctx;
    expect(JSON.stringify({ prompt: ctx.systemPromptOverride, item: ctx.workItem })).not.toContain(secretSentinel);
    const received = engineRows("engine_received");
    const terminal = engineRows("engine_terminal");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ workerBootId, turnId, correlation: "worker" });
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ workerBootId, turnId, outcome: "completed", engineAttemptSeq: 1 });
  });

  it.each([
    ["missing", undefined, "legacy"],
    ["malformed", { voiceTrace: { schemaVersion: 2, workerBootId: "bad", turnId: "also-bad" } }, "invalid"],
    [
      "oversized",
      { voiceTrace: { schemaVersion: 2, workerBootId: randomUUID(), turnId: randomUUID(), raw: "x".repeat(10_000) } },
      "invalid",
    ],
  ])("uses a fresh bounded trace for %s metadata", async (_label, metadata, correlation) => {
    const setup = makeAdapter({ spawn: echoSpawn(), bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p } = await startAdapter(setup);
    const res = await postChatCompletion(p, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: { ...workerShapedBody(`call-trace-${correlation}`), ...(metadata ? { metadata } : {}) },
    });
    expect(res.status).toBe(200);
    expect(engineRows("engine_received")).toHaveLength(1);
    expect(engineRows("engine_received")[0]).toMatchObject({ correlation, workerBootId: null });
    expect(String(engineRows())).not.toContain("x".repeat(100));
    expect(engineRows("engine_terminal")).toHaveLength(1);
    if (correlation === "invalid") expect(engineRows("diagnostic_gap")).toHaveLength(1);
  });

  it("emits two attempt terminals and one request terminal for the real adapter outer retry", async () => {
    let calls = 0;
    const setup = makeAdapter({
      storedSessionId: "resume-me",
      bridgeToken: E2_BRIDGE_TOKEN,
      spawn: async (ctx, onStream) => {
        calls += 1;
        ctx.onVoiceLaunchAdmission?.(calls === 1 ? "resume" : "fresh");
        if (calls === 1) return { ...echoTurnResult(""), errors: ["resumed initialization failed"] };
        ctx.onVoiceAdmission?.("fresh");
        onStream?.("replacement");
        return echoTurnResult("replacement");
      },
    });
    const { port: p } = await startAdapter(setup);
    const res = await postChatCompletion(p, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: workerShapedBody("call-outer-retry"),
    });
    expect(res.status).toBe(200);
    expect(res.chunks.join("")).toContain("replacement");
    expect(setup.captured).toHaveLength(2);
    expect(setup.captured[1]!.ctx.sessionId).toBeUndefined();
    const attempts = engineRows("engine_attempt_terminal");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((row) => row.engineAttemptSeq)).toEqual([1, 2]);
    expect(attempts[0]).toMatchObject({ launchAdmission: "resume", selectedContinuity: null, outcome: "failed" });
    expect(attempts[1]).toMatchObject({ launchAdmission: "fresh", selectedContinuity: "fresh", outcome: "completed" });
    expect(new Set(attempts.map((row) => row.turnId)).size).toBe(1);
    expect(engineRows("engine_terminal")).toHaveLength(1);
  });

  it("KPR-465: cold attempt terminal carries bootToInitMs equal to the log row's and queueWaitMs not_applicable", async () => {
    const spawn = async (_ctx: TurnContext, onStream?: (c: string) => void): Promise<TurnResult> => {
      onStream?.("hi");
      return {
        ...echoTurnResult("hi"),
        stageTimings: { lockWaitMs: 1, spawnPrepMs: 2, bootToInitMs: 741, initToFirstTokenMs: 1263 },
      };
    };
    const setup = makeAdapter({ spawn, bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p } = await startAdapter(setup);
    const res = await postChatCompletion(p, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: workerShapedBody("cold-465"),
    });
    expect(res.status).toBe(200);
    const terminal = engineRows("engine_attempt_terminal").find((r) => r.callId === "cold-465")!;
    expect(terminal.outcome).toBe("completed");
    expect(terminal.bootToInitMs).toEqual({ value: 741, reason: null });
    expect(terminal.queueWaitMs).toEqual({ value: null, reason: "not_applicable" });
    const requestTerminal = engineRows("engine_terminal").find((r) => r.callId === "cold-465")!;
    expect(requestTerminal.bootToInitMs).toEqual({ value: 741, reason: null });
    expect(requestTerminal.queueWaitMs).toEqual({ value: null, reason: "not_applicable" });
    const logRow = mockLog.info.mock.calls.find((c) => c[0] === "Voice turn complete")![1] as Record<string, unknown>;
    expect(logRow.bootToInitMs).toBe(741);
    expect(logRow).not.toHaveProperty("queueWaitMs");
  });

  it("KPR-465: a failed attempt reports not_observed for both new stages", async () => {
    const spawn = async (): Promise<TurnResult> => ({
      ...echoTurnResult(""),
      errors: ["boom"],
      stageTimings: { lockWaitMs: 0, spawnPrepMs: 0, bootToInitMs: 500 },
    });
    const setup = makeAdapter({ spawn, bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p } = await startAdapter(setup);
    await postChatCompletion(p, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: workerShapedBody("failed-465"),
    });
    const terminal = engineRows("engine_attempt_terminal").find((r) => r.callId === "failed-465")!;
    expect(terminal.outcome).toBe("failed");
    expect(terminal.bootToInitMs).toEqual({ value: null, reason: "not_observed" });
    expect(terminal.queueWaitMs).toEqual({ value: null, reason: "not_observed" });
  });

  // The adapter encodes barge-in/disconnect as `cancelled` (aborted result →
  // "cancelled"), never "interrupted"; spec §3.2 bullet 2 wants not_observed
  // for it too — a cancelled warm turn 1 must not contribute a boot sample.
  it("KPR-465: a cancelled (aborted-result) attempt reports not_observed for both new stages even when the stages were measured", async () => {
    const spawn = async (_ctx: TurnContext, onStream?: (c: string) => void): Promise<TurnResult> => {
      onStream?.("partial");
      return {
        ...echoTurnResult("partial", true),
        warmPath: true,
        warmTurnSeq: 1,
        stageTimings: { lockWaitMs: 0, spawnPrepMs: 0, queueWaitMs: 12, bootToInitMs: 500, initToFirstTokenMs: 40 },
      };
    };
    const setup = makeAdapter({ spawn, bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p } = await startAdapter(setup);
    await postChatCompletion(p, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: workerShapedBody("cancelled-465"),
    });
    const terminal = engineRows("engine_attempt_terminal").find((r) => r.callId === "cancelled-465")!;
    expect(terminal.outcome).toBe("cancelled");
    expect(terminal.bootToInitMs).toEqual({ value: null, reason: "not_observed" });
    expect(terminal.queueWaitMs).toEqual({ value: null, reason: "not_observed" });
    // Pre-existing stages stay outcome-blind (unchanged behavior, pinned so a "harmonizing" edit is caught).
    expect(terminal.initToFirstTokenMs).toEqual({ value: 40, reason: null });
  });

  it("KPR-465: attempt and request terminals carry the delivered effort from TurnResult, null when absent", async () => {
    const withEffort = async (_ctx: TurnContext, onStream?: (c: string) => void): Promise<TurnResult> => {
      onStream?.("hi");
      return { ...echoTurnResult("hi"), effort: "medium" };
    };
    const effortSetup = makeAdapter({ spawn: withEffort, bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p1 } = await startAdapter(effortSetup);
    await postChatCompletion(p1, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: workerShapedBody("effort-465"),
    });
    expect(engineRows("engine_attempt_terminal").find((r) => r.callId === "effort-465")!.effort).toBe("medium");
    expect(engineRows("engine_terminal").find((r) => r.callId === "effort-465")!.effort).toBe("medium");
    // Hand teardown back to afterEach for the second adapter.
    effortSetup.adapter.stop();
    adapter = undefined;

    const noEffortSetup = makeAdapter({ spawn: echoSpawn(), bridgeToken: E2_BRIDGE_TOKEN });
    const { port: p2 } = await startAdapter(noEffortSetup);
    await postChatCompletion(p2, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: workerShapedBody("noeffort-465"),
    });
    expect(engineRows("engine_attempt_terminal").find((r) => r.callId === "noeffort-465")!.effort).toBeNull();
    expect(engineRows("engine_terminal").find((r) => r.callId === "noeffort-465")!.effort).toBeNull();
  });

  it("second turn (resume from session-store) — latest-user-message prompt", async () => {
    const setup = makeAdapter({
      storedSessionId: "stored-from-first-turn",
      spawn: async (_ctx, onStream) => {
        onStream?.("Sure thing.");
        return {
          finalMessage: "Sure thing.",
          newSessionId: "stored-from-first-turn", // session id can rotate; here unchanged
          usage: {
            inputTokens: 10,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: 200000,
            costUsd: 0,
            durationMs: 50,
          },
          errors: [],
        };
      },
    });

    const { port: p } = await startAdapter(setup);

    const res = await postChatCompletion(p, {
      body: {
        model: "voice-mock",
        stream: true,
        messages: [
          { role: "user", content: "first turn user message" },
          { role: "assistant", content: "first turn agent reply" },
          { role: "user", content: "follow-up question" },
        ],
        assistant: { metadata: { hive_agent_id: "mokie" } },
        call: { id: "call-int-2" },
      },
    });

    expect(res.status).toBe(200);
    expect(setup.captured).toHaveLength(1);
    const ctx = setup.captured[0]!.ctx;
    expect(ctx.sessionId).toBe("stored-from-first-turn");
    // Resume path uses ONLY the latest user message — earlier turns are in
    // the SDK's session memory.
    expect(ctx.workItem.text).toBe("follow-up question");

    // SSE byte assertions.
    const joined = res.chunks.join("");
    expect(joined).toContain('"content":"Sure thing."');
    expect(joined).toContain("[DONE]");
  });

  it("routes through dispatcher.routeVoiceTurn end-to-end (KPR-223)", async () => {
    // KPR-223: when the adapter is wired with a Dispatcher, voice turns must
    // hit `dispatcher.routeVoiceTurn` (which threads taskLedger + audit log)
    // instead of falling back to `agentManager.spawnTurn` directly. The mock
    // dispatcher delegates to the same spawnTurn so the SSE byte round-trip
    // still completes — proving the dispatcher path is fully wired without
    // altering observable streaming behavior.

    // Forward-ref box so the dispatcher closure can reach setup.spawnTurn —
    // dispatcher is invoked only after the HTTP POST hits, well after
    // makeAdapter returns and we populate the box.
    const setupBox: { current: ReturnType<typeof makeAdapter> | undefined } = { current: undefined };
    const routeVoiceTurn = vi.fn(async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
      return await setupBox.current!.spawnTurn(ctx, onStream);
    });
    const dispatcher = { routeVoiceTurn } as unknown as Dispatcher;

    const setup = makeAdapter({
      spawn: async (_ctx, onStream) => {
        onStream?.("via ");
        onStream?.("dispatcher");
        return {
          finalMessage: "via dispatcher",
          newSessionId: "dispatcher-session-id",
          usage: {
            inputTokens: 5,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: 200000,
            costUsd: 0,
            durationMs: 25,
          },
          errors: [],
        };
      },
      dispatcher,
    });
    setupBox.current = setup;

    const { port: p } = await startAdapter(setup);

    const res = await postChatCompletion(p, {
      body: {
        model: "voice-mock",
        stream: true,
        messages: [
          { role: "system", content: "you are mokie" },
          { role: "user", content: "Test dispatcher routing" },
        ],
        assistant: { metadata: { hive_agent_id: "mokie" } },
        call: { id: "call-int-3", metadata: { goal: "verify dispatcher" } },
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    // Dispatcher.routeVoiceTurn was called exactly once with the same
    // TurnContext shape the agentManager.spawnTurn fallback would have seen.
    expect(routeVoiceTurn).toHaveBeenCalledTimes(1);
    const dispatchCtx = routeVoiceTurn.mock.calls[0]![0] as TurnContext;
    expect(dispatchCtx.agentId).toBe("mokie");
    expect(dispatchCtx.channel).toBe("voice");
    expect(dispatchCtx.threadId).toBe("voice:call-int-3");

    // SSE round-trip still completes through the dispatcher path.
    const joined = res.chunks.join("");
    expect(joined).toContain('"content":"via "');
    expect(joined).toContain('"content":"dispatcher"');
    expect(joined).toContain("[DONE]");

    // Inner spawnTurn was reached via the dispatcher delegation.
    expect(setup.spawnTurn).toHaveBeenCalledTimes(1);
  });

  it("binds loopback by default and accepts bridge-token requests without VAPI secret (KPR-322 E1)", async () => {
    const setup = makeAdapter({ spawn: echoSpawn(), serverSecret: "", bridgeToken: "tok-1" });
    const { server, port: p } = await startAdapter(setup);
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
    const res = await postChatCompletion(p, {
      headers: { authorization: "Bearer tok-1" },
      body: {
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        call: { id: "call-abc", metadata: { hive_agent_id: "mokie" } },
      },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a non-matching bearer on the worker-shaped path (KPR-322 E1)", async () => {
    const setup = makeAdapter({ spawn: echoSpawn(), serverSecret: "", bridgeToken: "tok-1" });
    const { port: p } = await startAdapter(setup);
    const res = await postChatCompletion(p, {
      headers: { authorization: "Bearer wrong" },
      body: {
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        call: { id: "call-abc", metadata: { hive_agent_id: "mokie" } },
      },
    });
    // No VAPI secret and not bridge-authed: the pre-E1 dead-endpoint 403-gate
    // fires before the worker-shape 401 (Testing-Contract assertion 4).
    expect(res.status).toBe(403);
  });

  it("rejects a non-matching bearer with 401 when VAPI secret is configured (KPR-322 E1)", async () => {
    const setup = makeAdapter({ spawn: echoSpawn(), serverSecret: "vapi-secret", bridgeToken: "tok-1" });
    const { port: p } = await startAdapter(setup);
    const res = await postChatCompletion(p, {
      headers: { authorization: "Bearer wrong" },
      body: {
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        call: { id: "call-abc", metadata: { hive_agent_id: "mokie" } },
      },
    });
    expect(res.status).toBe(401);
  });

  it("preserves Vapi fall-through with Bearer no-credentials-provided (KPR-322 E1)", async () => {
    const setup = makeAdapter({ spawn: echoSpawn(), serverSecret: "vapi-secret" });
    const { port: p } = await startAdapter(setup);
    const res = await postChatCompletion(p, {
      body: {
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        assistant: { metadata: { hive_agent_id: "mokie" } },
        call: { id: "call-vapi" },
      },
    });
    expect(res.status).toBe(200);
  });

  it("aborts the in-flight spawn and suppresses writes when the client disconnects mid-stream (KPR-322 E2)", async () => {
    const abortThread = vi.fn();
    const { port: p, spawnFinished, requestAborted } = await startAdapterWithHangingSpawn({ abortThread });

    const req = beginStreamingChat(p, workerShapedBody("call-e2"));
    await req.firstChunk();
    const disconnectAt = Date.now();
    req.destroySocket();

    await requestAborted;
    expect(Date.now() - disconnectAt).toBeLessThanOrEqual(100);
    expect(abortThread).not.toHaveBeenCalled();
    await spawnFinished;
  });

  it("does not call abortThread on normal completion", async () => {
    const abortThread = vi.fn();
    const { port: p } = await startAdapter(
      makeAdapter({ spawn: echoSpawn(), abortThread, bridgeToken: E2_BRIDGE_TOKEN }),
    );
    const res = await postChatCompletion(p, {
      headers: { authorization: `Bearer ${E2_BRIDGE_TOKEN}` },
      body: workerShapedBody("call-ok"),
    });
    expect(res.status).toBe(200);
    expect(abortThread).not.toHaveBeenCalled();
  });

  it("never dispatches the spawn when the client disconnects during the pre-spawn awaits (KPR-322 review B1)", async () => {
    const spawn = vi.fn();
    const { port: p, sessionGate } = await startAdapterWithHangingSessionStore({ spawn });
    const req = beginStreamingChat(p, workerShapedBody("call-pre"));
    await sessionGate.reached;
    req.destroySocket();
    await new Promise((r) => setTimeout(r, 25));
    sessionGate.release();
    await sessionGate.settled;
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not reach the legacy thread-wide abort callback when a request closes", async () => {
    const abortThread = vi.fn(() => {
      throw new Error("boom");
    });
    const { port: p, spawnFinished } = await startAdapterWithHangingSpawn({
      abortThread,
      resolveSpawnOnDestroy: true,
    });
    const req = beginStreamingChat(p, workerShapedBody("call-throw"));
    await req.firstChunk();
    req.destroySocket();
    await spawnFinished;
    expect(abortThread).not.toHaveBeenCalled();
  });
});
