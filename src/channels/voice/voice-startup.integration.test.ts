import { vi } from "vitest";

const { TEST_HIVE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "hive-voice-startup-http-"));
  process.env.HIVE_HOME = dir;
  return { TEST_HIVE_HOME: dir };
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, AgentSession, initializeLogger } from "@livekit/agents";

const configRef = vi.hoisted(() => ({
  current: {
    plugins: [],
    anthropic: { apiKey: "test" },
    modelRouter: { enabled: false },
    memory: { reflectionMinTurns: 3 },
    voice: { assistants: {}, warmPath: { enabled: false }, toolAck: { enabled: false } },
    circuitBreaker: undefined,
  } as Record<string, unknown>,
}));
vi.mock("../../config.js", () => ({
  get config() {
    return configRef.current;
  },
}));

const traceLog = vi.hoisted(() => ({
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
vi.mock("../../logging/logger.js", () => ({ createLogger: () => traceLog }));

vi.mock("../../agents/prompt-builder.js", () => ({
  buildVoiceSystemPrompt: vi.fn(async () => "voice fixture prompt"),
  buildProviderInstructions: vi.fn(async () => "provider fixture prompt"),
}));
vi.mock("../../plugins/plugin-loader.js", () => ({ loadPlugins: vi.fn(() => []) }));
vi.mock("../../llm/registry.js", () => ({ getLLMRegistry: () => ({ supportsEffort: () => true }) }));
vi.mock("../../search/conversation-index.js", () => ({
  ConversationIndex: vi.fn().mockImplementation(function () {
    return { index: vi.fn(async () => undefined) };
  }),
}));
vi.mock("../../agents/model-router.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  routeModel: vi.fn(),
}));

const runnerControl = vi.hoisted(() => ({
  send: vi.fn(),
  aborters: [] as Array<() => void>,
  openStream: vi.fn(),
}));
vi.mock("../../agents/agent-runner.js", () => ({
  DIST_DIR: "/tmp/hive-voice-startup-dist",
  AgentRunner: vi.fn().mockImplementation(function () {
    let abort = () => {};
    runnerControl.aborters.push(() => abort());
    return {
      send: (...args: unknown[]) => runnerControl.send(...args),
      openVoiceStreamingSession: (...args: unknown[]) => runnerControl.openStream(...args),
      abort: () => abort(),
      setFixtureAbort: (fn: () => void) => {
        abort = fn;
      },
      wasAborted: false,
      buildToolTransportInventory: vi.fn(() => []),
      buildInProcessServers: vi.fn(() => ({})),
      resolveTurnCwd: vi.fn(() => "/tmp"),
      buildProviderPrompt: vi.fn(async () => ({ instructions: "provider fixture prompt", skillEntries: [] })),
    };
  }),
}));

import { AgentManager } from "../../agents/agent-manager.js";
import { AsyncPushQueue } from "../../agents/warm-voice-session.js";
import { Dispatcher } from "../dispatcher.js";
import { VoiceAdapter } from "./voice-adapter.js";
import { HiveLLM } from "../../voice-worker/hive-llm.js";
import { SpeechTrace } from "../../voice-worker/speech-trace.js";
import { CaptureAudioOutput, ControlledTTS } from "../../voice-worker/testing/startup-fixture.js";
import {
  VOICE_PROCESS_ID,
  type VoiceDiagnosticEvent,
  type VoiceTraceWriteCounts,
  type VoiceTraceWriter,
} from "../../voice/voice-trace.js";

beforeAll(() => initializeLogger({ pretty: false, level: "silent" }));

afterAll(() => rmSync(TEST_HIVE_HOME, { recursive: true, force: true }));

function agentConfig() {
  return {
    id: "mokie",
    name: "Mokie",
    model: "claude-sonnet-4-6",
    channels: [],
    passiveChannels: [],
    keywords: [],
    isDefault: true,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    maxConcurrent: 2,
    coreServers: [],
    delegateServers: [],
    icon: "",
    soul: "",
    systemPrompt: "",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
  };
}

function makeFixture() {
  const config = agentConfig();
  const registry = {
    get: vi.fn((id: string) => (id === "mokie" ? config : undefined)),
    getAll: vi.fn(() => [config]),
    listIds: vi.fn(() => ["mokie"]),
    getSubscriberMap: vi.fn(() => ({})),
  };
  const sessions = new Map<string, { sessionId: string; provider: string }>();
  const sessionStore = {
    get: vi.fn(async (agentId: string, threadId: string) => sessions.get(`${agentId}:${threadId}`)),
    set: vi.fn(async (agentId: string, threadId: string, sessionId: string, provider: string) => {
      sessions.set(`${agentId}:${threadId}`, { sessionId, provider });
    }),
    delete: vi.fn(async () => undefined),
    clearAgent: vi.fn(async () => undefined),
    findAgentByThread: vi.fn(async () => undefined),
  };
  const memory = { read: vi.fn(async () => null), write: vi.fn(), list: vi.fn(async () => []) };
  const manager = new AgentManager(registry as never, memory as never, sessionStore as never, undefined as never);
  const dispatcher = new Dispatcher(registry as never, manager, { formatForSlack: () => "ok" } as never, "mokie");
  const adapter = new VoiceAdapter(0, "", "bridge-token", registry as never, memory as never, manager, dispatcher);
  return { adapter, manager, sessions };
}

function runResult(text: string, overrides: Record<string, unknown> = {}) {
  return {
    text,
    sessionId: `session-${text}`,
    costUsd: 0.01,
    durationMs: 10,
    llmMs: 8,
    toolMs: 0,
    toolCalls: 0,
    toolSummary: "none",
    toolAckInjected: 0,
    streamed: text.length > 0,
    aborted: false,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextWindow: 200000,
    errors: [],
    ...overrides,
  };
}

function body(callId: string) {
  return {
    stream: true,
    messages: [{ role: "user", content: callId }],
    call: { id: callId, metadata: { hive_agent_id: "mokie" } },
    metadata: { voiceTrace: { schemaVersion: 2, workerBootId: randomUUID(), turnId: randomUUID() } },
  };
}

function begin(port: number, requestBody: Record<string, unknown>) {
  const payload = JSON.stringify(requestBody);
  let firstResolve!: (value: string) => void;
  let doneResolve!: (value: string) => void;
  const first = new Promise<string>((resolve) => (firstResolve = resolve));
  const done = new Promise<string>((resolve) => (doneResolve = resolve));
  let text = "";
  let firstSeen = false;
  const req: ClientRequest = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        authorization: "Bearer bridge-token",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    },
    (res: IncomingMessage) => {
      res.on("data", (chunk) => {
        text += chunk.toString();
        if (!firstSeen) {
          firstSeen = true;
          firstResolve(text);
        }
      });
      res.on("end", () => doneResolve(text));
    },
  );
  req.on("error", () => doneResolve(text));
  req.end(payload);
  return { req, first, done };
}

function rows(callId: string, event: string) {
  return traceLog.writeTracked.mock.calls
    .map((call) => call[2] as Record<string, unknown>)
    .filter((row) => row.callId === callId && row.event === event);
}

const COMPLETE_WRITES: VoiceTraceWriteCounts = {
  attempted: 0,
  acknowledged: 0,
  filtered: 0,
  failed: 0,
  overflow: 0,
  pending: 0,
  unacknowledged: 0,
  sinkErrors: 0,
  complete: true,
};

function speechTrace(callId: string) {
  const traceRows: VoiceDiagnosticEvent[] = [];
  const writer: VoiceTraceWriter = {
    write: (event) => traceRows.push(event),
    emit: (event) => traceRows.push(event),
    snapshot: () => ({ ...COMPLETE_WRITES, attempted: traceRows.length, acknowledged: traceRows.length }),
    settleWrites: async () => ({ ...COMPLETE_WRITES, attempted: traceRows.length, acknowledged: traceRows.length }),
  };
  return { traceRows, trace: new SpeechTrace({ callId, workerBootId: VOICE_PROCESS_ID, writer }) };
}

describe("VoiceAdapter real manager ownership", () => {
  const adapters: VoiceAdapter[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    runnerControl.aborters.length = 0;
    configRef.current.voice = { assistants: {}, warmPath: { enabled: false }, toolAck: { enabled: false } };
  });

  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.stop();
  });

  async function start(adapter: VoiceAdapter): Promise<number> {
    adapters.push(adapter);
    await adapter.start();
    return (adapter as unknown as { httpServer: { address(): AddressInfo } }).httpServer.address().port;
  }

  it("cold request cancellation releases only its real spawn ticket and a queued successor completes", async () => {
    const fixture = makeFixture();
    let releaseFirst!: (value: ReturnType<typeof runResult>) => void;
    let sendCount = 0;
    runnerControl.send.mockImplementation(
      async (_prompt: string, _session: string | undefined, onStream?: (chunk: string) => void) => {
        sendCount += 1;
        if (sendCount === 1) {
          onStream?.("predecessor");
          return await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        onStream?.("replacement");
        return runResult("replacement");
      },
    );
    const port = await start(fixture.adapter);
    const predecessor = begin(port, body("cold-shared"));
    await predecessor.first;
    const successor = begin(port, body("cold-shared"));
    await vi.waitFor(() => expect(rows("cold-shared", "engine_attempt_started")).toHaveLength(2));
    predecessor.req.destroy();
    await vi.waitFor(() => expect(runnerControl.aborters.length).toBeGreaterThan(0));
    releaseFirst(runResult("", { aborted: true, streamed: false }));
    const replacement = await successor.done;
    expect(replacement).toContain("replacement");
    expect(replacement).toContain("[DONE]");
    expect(runnerControl.send).toHaveBeenCalledTimes(2);
    expect(rows("cold-shared", "engine_terminal")).toHaveLength(2);
    const turnIds = rows("cold-shared", "engine_received").map((row) => row.turnId);
    expect(new Set(turnIds).size).toBe(2);
  });

  it("carries replacement text through real HiveLLM and the pinned fake TTS/output pipeline", async () => {
    const fixture = makeFixture();
    runnerControl.send.mockImplementation(
      async (_prompt: string, _session: string | undefined, onStream?: (chunk: string) => void) => {
        onStream?.("audible replacement");
        return runResult("audible replacement");
      },
    );
    const port = await start(fixture.adapter);
    const callId = "pipeline-call";
    const { traceRows, trace } = speechTrace(callId);
    const model = new HiveLLM({
      bridgeUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      bridgeToken: "bridge-token",
      hiveAgentId: "mokie",
      callId,
      goal: "offline fixture",
      context: "test only",
      trace,
    });
    const tts = new ControlledTTS();
    const output = new CaptureAudioOutput();
    const session = new AgentSession({ llm: model, tts, vad: null, turnHandling: { turnDetection: null } });
    session.output.audio = output;
    session.on("metrics_collected", (event) => trace.metrics(event as never));
    await session.start({ agent: new Agent({ instructions: "offline fixture" }) });
    try {
      const handle = session.generateReply({ userInput: "continue" });
      await handle.waitForPlayout();
      expect(output.frames.length).toBeGreaterThan(0);
      expect(tts.frames.length).toBeGreaterThan(0);
      expect(traceRows).toContainEqual(expect.objectContaining({ event: "bridge_terminal", outcome: "completed" }));
      expect(rows(callId, "engine_terminal")).toEqual([
        expect.objectContaining({ outcome: "completed", textLength: "audible replacement".length }),
      ]);
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it("warm demux drops a cancelled queued request before provider input and a later independent request progresses", async () => {
    configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
    const fixture = makeFixture();
    const pushed: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    runnerControl.openStream.mockImplementation(
      async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
        const output = new AsyncPushQueue<unknown>();
        const iterator = output[Symbol.asyncIterator]();
        void (async () => {
          output.push({ type: "system", subtype: "init", session_id: "warm-0" });
          let n = 0;
          for await (const message of input) {
            n += 1;
            pushed.push(String(message.message?.content ?? ""));
            output.push({
              type: "stream_event",
              event: { type: "content_block_delta", delta: { type: "text_delta", text: `warm-${n}` } },
            });
            if (n === 1) await firstGate;
            output.push({
              type: "result",
              subtype: "success",
              result: `warm-${n}`,
              session_id: `warm-${n}`,
              total_cost_usd: 0.01,
              duration_ms: 10,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            });
          }
          output.end();
        })();
        return {
          next: () => iterator.next(),
          interrupt: vi.fn(async () => undefined),
          close: vi.fn(() => output.end()),
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    );

    const port = await start(fixture.adapter);
    const a = begin(port, body("warm-shared"));
    await a.first;
    const cancelled = begin(port, body("warm-shared"));
    await vi.waitFor(() => expect(rows("warm-shared", "engine_attempt_started")).toHaveLength(2));
    cancelled.req.destroy();
    await vi.waitFor(() => expect(rows("warm-shared", "engine_client_closed")).toHaveLength(1));
    releaseFirst();
    await a.done;
    await vi.waitFor(() => expect(rows("warm-shared", "engine_terminal")).toHaveLength(2));
    expect(pushed).toHaveLength(1);

    const d = begin(port, body("warm-shared"));
    const done = await d.done;
    expect(done).toContain("warm-2");
    expect(done).toContain("[DONE]");
    expect(pushed).toHaveLength(2);
    expect(runnerControl.openStream).toHaveBeenCalledTimes(1);
  });

  it.each(["late-success", "late-rejection"] as const)(
    "retains a typed stopped lifetime across a gated resumed opening (%s) and isolates a new request",
    async (settlement) => {
      configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
      const fixture = makeFixture();
      fixture.sessions.set("mokie:voice:stopped-opening", { sessionId: "resume-old", provider: "claude" });
      let resolveOpen!: (value: unknown) => void;
      let rejectOpen!: (error: Error) => void;
      const opening = new Promise<unknown>((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      });
      const lateClose = vi.fn();
      runnerControl.openStream.mockImplementationOnce(async () => opening);
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
          const output = new AsyncPushQueue<unknown>();
          const iterator = output[Symbol.asyncIterator]();
          void (async () => {
            output.push({ type: "system", subtype: "init", session_id: "new-0" });
            for await (const _message of input) {
              void _message;
              output.push({
                type: "stream_event",
                event: { type: "content_block_delta", delta: { type: "text_delta", text: "new-lifetime" } },
              });
              output.push({
                type: "result",
                subtype: "success",
                result: "new-lifetime",
                session_id: "new-1",
                total_cost_usd: 0,
                duration_ms: 1,
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              });
            }
            output.end();
          })();
          return {
            next: () => iterator.next(),
            interrupt: vi.fn(async () => undefined),
            close: vi.fn(() => output.end()),
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        },
      );

      const port = await start(fixture.adapter);
      const old = begin(port, body("stopped-opening"));
      await vi.waitFor(() => expect(runnerControl.openStream).toHaveBeenCalledTimes(1));
      fixture.manager.stopAgent("mokie");
      fixture.manager.restartAgent("mokie");
      if (settlement === "late-success") {
        const empty = new AsyncPushQueue<unknown>();
        resolveOpen({
          next: () => empty[Symbol.asyncIterator]().next(),
          interrupt: vi.fn(async () => undefined),
          close: lateClose.mockImplementation(() => empty.end()),
          [Symbol.asyncIterator]() {
            return this;
          },
        });
      } else {
        rejectOpen(new Error("late provider rejection"));
      }
      await old.done;
      await vi.waitFor(() => expect(rows("stopped-opening", "engine_terminal")).toHaveLength(1));
      expect(rows("stopped-opening", "engine_attempt_terminal")).toHaveLength(1);
      expect(rows("stopped-opening", "engine_attempt_terminal")[0]).toMatchObject({
        launchAdmission: "resume",
        selectedContinuity: null,
        stopped: true,
        outcome: "failed",
      });
      if (settlement === "late-success") expect(lateClose).toHaveBeenCalledTimes(1);
      expect(runnerControl.openStream).toHaveBeenCalledTimes(1);

      const fresh = begin(port, body(`fresh-${settlement}`));
      const freshBody = await fresh.done;
      expect(freshBody).toContain("new-lifetime");
      expect(freshBody).toContain("[DONE]");
      expect(runnerControl.openStream).toHaveBeenCalledTimes(2);
      expect(rows(`fresh-${settlement}`, "engine_attempt_terminal")).toHaveLength(1);
      fixture.manager.stopAgent("mokie");
    },
  );

  it.each(["eof", "rejection"] as const)(
    "keeps active real-demux and queued requests on the stopped lifetime after restart (%s)",
    async (settlement) => {
      configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
      const fixture = makeFixture();
      fixture.sessions.set("mokie:voice:active-stop", { sessionId: "resume-active", provider: "claude" });
      let inputConsumedResolve!: () => void;
      const inputConsumed = new Promise<void>((resolve) => (inputConsumedResolve = resolve));
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
          const output = new AsyncPushQueue<unknown>();
          const iterator = output[Symbol.asyncIterator]();
          output.push({ type: "system", subtype: "init", session_id: "active-0" });
          void (async () => {
            for await (const _message of input) {
              void _message;
              inputConsumedResolve();
            }
          })();
          return {
            next: async () => {
              const item = await iterator.next();
              if (item.value instanceof Error) throw item.value;
              return item;
            },
            interrupt: vi.fn(async () => undefined),
            close: vi.fn(() => {
              if (settlement === "rejection") output.push(new Error("late demux rejection"));
              output.end();
            }),
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        },
      );
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
          const output = new AsyncPushQueue<unknown>();
          const iterator = output[Symbol.asyncIterator]();
          void (async () => {
            output.push({ type: "system", subtype: "init", session_id: "isolated-0" });
            for await (const _message of input) {
              void _message;
              output.push({
                type: "stream_event",
                event: { type: "content_block_delta", delta: { type: "text_delta", text: "isolated-D" } },
              });
              output.push({
                type: "result",
                subtype: "success",
                result: "isolated-D",
                session_id: "isolated-1",
                total_cost_usd: 0.02,
                duration_ms: 4,
                usage: {
                  input_tokens: 2,
                  output_tokens: 1,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              });
            }
            output.end();
          })();
          return {
            next: () => iterator.next(),
            interrupt: vi.fn(async () => undefined),
            close: vi.fn(() => output.end()),
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        },
      );

      const port = await start(fixture.adapter);
      const a = begin(port, body("active-stop"));
      await inputConsumed;
      const b = begin(port, body("active-stop"));
      const c = begin(port, body("active-stop"));
      await vi.waitFor(() => expect(rows("active-stop", "engine_attempt_started")).toHaveLength(3));
      fixture.manager.stopAgent("mokie");
      fixture.manager.restartAgent("mokie");
      await Promise.all([a.done, b.done, c.done]);
      await vi.waitFor(() => expect(rows("active-stop", "engine_terminal")).toHaveLength(3));
      const oldAttempts = rows("active-stop", "engine_attempt_terminal");
      expect(oldAttempts).toHaveLength(3);
      expect(oldAttempts.every((row) => row.outcome === "failed" && row.stopped === true)).toBe(true);
      expect(oldAttempts.every((row) => row.engineAttemptSeq === 1)).toBe(true);
      expect(runnerControl.openStream).toHaveBeenCalledTimes(1);

      const d = begin(port, body("active-stop-D"));
      const dBody = await d.done;
      expect(dBody).toContain("isolated-D");
      expect(dBody).toContain("[DONE]");
      expect(runnerControl.openStream).toHaveBeenCalledTimes(2);
      fixture.manager.stopAgent("mokie");
    },
  );
});
