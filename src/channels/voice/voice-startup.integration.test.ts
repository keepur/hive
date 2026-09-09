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

import { AgentManager, AgentStoppedError, type TurnResult } from "../../agents/agent-manager.js";
import { AsyncPushQueue } from "../../agents/warm-voice-session.js";
import { Dispatcher } from "../dispatcher.js";
import { VoiceAdapter } from "./voice-adapter.js";
import { renderConversationPrompt } from "./conversation-prompt.js";
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

function agentConfig(timeoutMs?: number) {
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
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    coreServers: [],
    delegateServers: [],
    icon: "",
    soul: "",
    systemPrompt: "",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
  };
}

function makeFixture(options: { timeoutMs?: number; taskLedger?: object } = {}) {
  const config = agentConfig(options.timeoutMs);
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
  const turnTelemetryStore = { record: vi.fn(async () => undefined) };
  const activityLogger = { record: vi.fn() };
  const manager = new AgentManager(
    registry as never,
    memory as never,
    sessionStore as never,
    undefined as never,
    turnTelemetryStore as never,
    activityLogger as never,
  );
  const dispatcher = new Dispatcher(
    registry as never,
    manager,
    { formatForSlack: () => "ok" } as never,
    "mokie",
    options.taskLedger as never,
  );
  const adapter = new VoiceAdapter(0, "", "bridge-token", registry as never, memory as never, manager, dispatcher);
  return { adapter, manager, sessions, sessionStore, turnTelemetryStore, activityLogger, dispatcher };
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

function transcriptBody(callId: string) {
  const requestBody = body(callId);
  requestBody.messages = [
    { role: "user", content: "earlier caller sentinel" },
    { role: "assistant", content: "earlier agent sentinel" },
    { role: "user", content: "latest caller sentinel" },
  ];
  return requestBody;
}

function sdkUsage(id: string, sessionId: string) {
  return {
    type: "assistant",
    session_id: sessionId,
    message: {
      role: "assistant",
      id,
      content: [{ type: "text", text: "observed partial" }],
      usage: {
        input_tokens: 11,
        output_tokens: 4,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    },
  };
}

function successfulQuery(
  input: AsyncIterable<{ message?: { content?: string } }>,
  text: string,
  sessionId: string,
  pushed: string[],
) {
  const output = new AsyncPushQueue<unknown>();
  const iterator = output[Symbol.asyncIterator]();
  void (async () => {
    output.push({ type: "system", subtype: "init", session_id: sessionId });
    for await (const message of input) {
      pushed.push(String(message.message?.content ?? ""));
      output.push({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      });
      output.push({
        type: "result",
        subtype: "success",
        result: text,
        session_id: sessionId,
        total_cost_usd: 0.05,
        duration_ms: 17,
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
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
}

function resultQuery(
  input: AsyncIterable<{ message?: { content?: string } }>,
  result: Record<string, unknown>,
  pushed: string[] = [],
  textDelta?: string,
) {
  const output = new AsyncPushQueue<unknown>();
  const iterator = output[Symbol.asyncIterator]();
  void (async () => {
    output.push({ type: "system", subtype: "init", session_id: result.session_id });
    for await (const message of input) {
      pushed.push(String(message.message?.content ?? ""));
      if (textDelta) {
        output.push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: textDelta } },
        });
      }
      output.push(result);
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
}

function controlledPendingQuery(options: {
  input: AsyncIterable<{ message?: { content?: string } }>;
  sessionId: string;
  priorText?: string;
  includeUsage?: boolean;
}) {
  let resolveRead!: (value: IteratorResult<unknown>) => void;
  let rejectRead!: (error: Error) => void;
  const pendingRead = new Promise<IteratorResult<unknown>>((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
  let rejectInterrupt!: (error: Error) => void;
  let resolveInterrupt!: () => void;
  const interruptHeld = new Promise<void>((resolve, reject) => {
    resolveInterrupt = resolve;
    rejectInterrupt = reject;
  });
  let inputConsumedResolve!: (text: string) => void;
  const inputConsumed = new Promise<string>((resolve) => (inputConsumedResolve = resolve));
  void (async () => {
    const item = await options.input[Symbol.asyncIterator]().next();
    inputConsumedResolve(String(item.value?.message?.content ?? ""));
  })();
  let pendingReadResolve!: () => void;
  const pendingReadStarted = new Promise<void>((resolve) => (pendingReadResolve = resolve));
  let nextIndex = 0;
  const next = vi.fn(() => {
    nextIndex += 1;
    if (nextIndex === 1) {
      return Promise.resolve({
        value: { type: "system", subtype: "init", session_id: options.sessionId },
        done: false,
      });
    }
    if (options.includeUsage !== false && nextIndex === 2) {
      return Promise.resolve({ value: sdkUsage(`usage-${options.sessionId}`, options.sessionId), done: false });
    }
    const priorTextIndex = options.includeUsage === false ? 2 : 3;
    if (options.priorText && nextIndex === priorTextIndex) {
      return Promise.resolve({
        value: {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: options.priorText } },
        },
        done: false,
      });
    }
    pendingReadResolve();
    return pendingRead;
  });
  const interrupt = vi.fn(() => interruptHeld);
  const close = vi.fn();
  return {
    query: {
      next,
      interrupt,
      close,
      [Symbol.asyncIterator]() {
        return this;
      },
    },
    inputConsumed,
    pendingReadStarted,
    resolveInterrupt,
    rejectInterrupt,
    settleEof: () => resolveRead({ value: undefined, done: true }),
    settleValue: (value: unknown) => resolveRead({ value, done: false }),
    settleRejection: (message: string) => rejectRead(new Error(message)),
    interrupt,
    close,
  };
}

function captureManagerResults(manager: AgentManager): TurnResult[] {
  const results: TurnResult[] = [];
  const spawnTurn = manager.spawnTurn.bind(manager);
  vi.spyOn(manager, "spawnTurn").mockImplementation(async (...args) => {
    const result = await spawnTurn(...args);
    results.push(result);
    return result;
  });
  return results;
}

function expectNoLifecycleInternals(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain("voiceLifetimeSignal");
  expect(serialized).not.toContain("voiceRequestSignal");
  expect(serialized).not.toContain("AgentStoppedError");
  expect(serialized).not.toContain("AbortSignal");
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
    traceLog.warn.mockReset();
    runnerControl.send.mockReset();
    runnerControl.openStream.mockReset();
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

  it.each(["eof", "rejection"] as const)(
    "retries a live resumed watchdog failure with its original %s error, usage, and full transcript",
    async (settlement) => {
      configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
      const callId = `watchdog-${settlement}`;
      const fixture = makeFixture({ timeoutMs: 15 });
      fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "watchdog-resume", provider: "claude" });
      const managerResults = captureManagerResults(fixture.manager);
      const replacementInputs: string[] = [];
      let controlled!: ReturnType<typeof controlledPendingQuery>;
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
          controlled = controlledPendingQuery({ input, sessionId: "watchdog-resume" });
          return controlled.query;
        },
      );
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
          successfulQuery(input, `replacement-${settlement}`, `fresh-${settlement}`, replacementInputs),
      );

      const port = await start(fixture.adapter);
      const requestBody = transcriptBody(callId);
      const request = begin(port, requestBody);
      await vi.waitFor(() => expect(controlled).toBeDefined());
      expect(await controlled.inputConsumed).toMatch(/^latest caller sentinel\n\n\*\*Current date\/time\*\*: /);
      await controlled.pendingReadStarted;
      await vi.waitFor(() => expect(controlled.interrupt).toHaveBeenCalledTimes(1));
      controlled.rejectInterrupt(new Error("watchdog interrupt rejected"));
      await vi.waitFor(() => expect(controlled.close).toHaveBeenCalledTimes(1));
      if (settlement === "eof") controlled.settleEof();
      else controlled.settleRejection("watchdog read rejected");

      const response = await request.done;
      expect(response).toContain(`replacement-${settlement}`);
      expect(response).toContain("[DONE]");
      await vi.waitFor(() => expect(managerResults).toHaveLength(2));
      expect(managerResults[0]).toMatchObject({
        errors: [
          settlement === "eof"
            ? expect.stringContaining("output ended before turn result")
            : "Error: watchdog read rejected",
        ],
        aborted: true,
        timedOut: true,
        usage: {
          costUsd: 0,
          inputTokens: 11,
          outputTokens: 4,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
        },
      });
      expect(managerResults[0]!.usage.durationMs).toBeGreaterThan(0);
      expect(managerResults[0]!.voiceLifetimeSignal?.aborted).toBe(true);
      expect(managerResults[0]!.voiceLifetimeSignal?.reason).not.toBeInstanceOf(AgentStoppedError);
      expect(managerResults[1]).toMatchObject({ finalMessage: `replacement-${settlement}`, errors: [] });
      expect(replacementInputs).toHaveLength(1);
      expect(
        replacementInputs[0]!.startsWith(
          `${renderConversationPrompt(requestBody.messages)}\n\n**Current date/time**: `,
        ),
      ).toBe(true);
      expect(runnerControl.openStream.mock.calls.map((call) => call[0].sessionId)).toEqual([
        "watchdog-resume",
        undefined,
      ]);

      expect(fixture.sessionStore.set).toHaveBeenCalledWith(
        "mokie",
        `voice:${callId}`,
        "watchdog-resume",
        "claude",
        undefined,
        undefined,
      );
      expect(fixture.turnTelemetryStore.record).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "watchdog-resume",
          inputTokens: 11,
          outputTokens: 4,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
          aborted: true,
        }),
      );
      expect(fixture.activityLogger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          costUsd: 0,
          inputTokens: 11,
          outputTokens: 4,
          error: managerResults[0]!.errors[0],
          aborted: true,
          timedOut: true,
        }),
      );
      const attempts = rows(callId, "engine_attempt_terminal");
      expect(attempts).toHaveLength(2);
      expect(attempts).toEqual([
        expect.objectContaining({
          engineAttemptSeq: 1,
          continuity: "resume",
          launchAdmission: "resume",
          selectedContinuity: "resume",
          outcome: "failed",
          stopped: false,
        }),
        expect.objectContaining({
          engineAttemptSeq: 2,
          continuity: "full_transcript",
          launchAdmission: "fresh",
          selectedContinuity: "fresh",
          outcome: "completed",
          stopped: false,
        }),
      ]);
      expect(new Set(attempts.map((row) => row.turnId))).toEqual(new Set([requestBody.metadata.voiceTrace.turnId]));
      expect(rows(callId, "engine_terminal")).toEqual([
        expect.objectContaining({
          engineAttemptSeq: 2,
          outcome: "completed",
          clientGone: false,
          turnId: requestBody.metadata.voiceTrace.turnId,
        }),
      ]);
      fixture.manager.stopAgent("mokie");
    },
  );

  it.each(["eof", "rejection"] as const)(
    "does not retry a watchdog %s failure after response bytes were emitted",
    async (settlement) => {
      configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
      const callId = `watchdog-bytes-${settlement}`;
      const fixture = makeFixture({ timeoutMs: 15 });
      fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "bytes-resume", provider: "claude" });
      const managerResults = captureManagerResults(fixture.manager);
      let controlled!: ReturnType<typeof controlledPendingQuery>;
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
          controlled = controlledPendingQuery({ input, sessionId: "bytes-resume", priorText: "already-spoken" });
          return controlled.query;
        },
      );

      const port = await start(fixture.adapter);
      const request = begin(port, transcriptBody(callId));
      expect(await request.first).toContain("already-spoken");
      await controlled.pendingReadStarted;
      await vi.waitFor(() => expect(controlled.interrupt).toHaveBeenCalledTimes(1));
      controlled.rejectInterrupt(new Error("watchdog interrupt rejected after bytes"));
      await vi.waitFor(() => expect(controlled.close).toHaveBeenCalledTimes(1));
      if (settlement === "eof") controlled.settleEof();
      else controlled.settleRejection("watchdog read rejected after bytes");

      const response = await request.done;
      expect(response).toContain("already-spoken");
      expect(response).not.toContain("replacement");
      await vi.waitFor(() => expect(managerResults).toHaveLength(1));
      expect(managerResults[0]).toMatchObject({ errors: [expect.any(String)], aborted: true, timedOut: true });
      expect(managerResults[0]!.usage).toMatchObject({
        costUsd: 0,
        inputTokens: 11,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
      });
      expect(runnerControl.openStream).toHaveBeenCalledTimes(1);
      expect(rows(callId, "engine_attempt_terminal")).toEqual([
        expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed", stopped: false }),
      ]);
      expect(rows(callId, "engine_terminal")).toEqual([
        expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed", textLength: "already-spoken".length }),
      ]);
      fixture.manager.stopAgent("mokie");
    },
  );

  it.each([
    ["observed-progress", true],
    ["zero-progress", false],
  ] as const)(
    "keeps actual watchdog request cancellation terminal and preserves %s persistence",
    async (label, progress) => {
      configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
      const callId = `watchdog-cancel-${label}`;
      const fixture = makeFixture({ timeoutMs: 15 });
      fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "cancel-resume", provider: "claude" });
      const managerResults = captureManagerResults(fixture.manager);
      let controlled!: ReturnType<typeof controlledPendingQuery>;
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
          controlled = controlledPendingQuery({ input, sessionId: "cancel-resume", includeUsage: progress });
          return controlled.query;
        },
      );

      const port = await start(fixture.adapter);
      const request = begin(port, transcriptBody(callId));
      await vi.waitFor(() => expect(controlled).toBeDefined());
      await controlled.inputConsumed;
      await controlled.pendingReadStarted;
      await vi.waitFor(() => expect(controlled.interrupt).toHaveBeenCalledTimes(1));
      request.req.destroy();
      controlled.rejectInterrupt(new Error("cancel interrupt rejected"));
      await vi.waitFor(() => expect(controlled.close).toHaveBeenCalledTimes(1));
      controlled.settleRejection("cancelled request read rejected");
      await request.done;

      await vi.waitFor(() => expect(rows(callId, "engine_terminal")).toHaveLength(1));
      await vi.waitFor(() => expect(managerResults).toHaveLength(1));
      expect(managerResults[0]).toMatchObject({
        errors: ["Error: cancelled request read rejected"],
        aborted: true,
        timedOut: true,
      });
      expect(managerResults[0]!.voiceLifetimeSignal?.reason).not.toBeInstanceOf(AgentStoppedError);
      expect(runnerControl.openStream).toHaveBeenCalledTimes(1);
      expect(rows(callId, "engine_attempt_terminal")).toEqual([
        expect.objectContaining({ engineAttemptSeq: 1, outcome: "cancelled", stopped: false }),
      ]);
      expect(rows(callId, "engine_terminal")).toEqual([
        expect.objectContaining({ engineAttemptSeq: 1, outcome: "cancelled", clientGone: true }),
      ]);
      if (progress) {
        expect(managerResults[0]!.usage).toMatchObject({
          inputTokens: 11,
          outputTokens: 4,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
        });
        expect(fixture.sessionStore.set).toHaveBeenCalledWith(
          "mokie",
          `voice:${callId}`,
          "cancel-resume",
          "claude",
          undefined,
          undefined,
        );
      } else {
        expect(managerResults[0]!.usage).toMatchObject({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        });
        expect(fixture.sessionStore.set).not.toHaveBeenCalled();
      }
      fixture.manager.stopAgent("mokie");
    },
  );

  it("checks the retained lifetime when stop/restart fires after demux result construction inside manager continuation", async () => {
    configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
    const callId = "stop-in-manager-continuation";
    const fixture = makeFixture({ timeoutMs: 60_000 });
    fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "manager-boundary-resume", provider: "claude" });
    const managerResults = captureManagerResults(fixture.manager);
    fixture.activityLogger.record.mockImplementationOnce(() => {
      fixture.manager.stopAgent("mokie");
      fixture.manager.restartAgent("mokie");
    });
    runnerControl.openStream.mockImplementationOnce(
      async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
        resultQuery(input, {
          type: "result",
          subtype: "error_during_execution",
          errors: ["manager continuation failure"],
          session_id: "manager-boundary-resume",
          total_cost_usd: 0.21,
          duration_ms: 31,
          usage: {
            input_tokens: 9,
            output_tokens: 2,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 1,
          },
        }),
    );

    const port = await start(fixture.adapter);
    const response = await begin(port, transcriptBody(callId)).done;
    expect(response).toContain("Internal error");
    expect(response).not.toContain("replacement");
    await vi.waitFor(() => expect(managerResults).toHaveLength(1));
    expect(managerResults[0]).toMatchObject({ errors: ["manager continuation failure"] });
    expect(managerResults[0]!.voiceLifetimeSignal?.reason).toBeInstanceOf(AgentStoppedError);
    expect(runnerControl.openStream).toHaveBeenCalledTimes(1);
    expect(rows(callId, "engine_attempt_terminal")).toEqual([
      expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed", stopped: true }),
    ]);
    expect(rows(callId, "engine_terminal")).toHaveLength(1);
    expectNoLifecycleInternals({
      response,
      diagnostics: traceLog.writeTracked.mock.calls.map((call) => call[2]),
      persistence: fixture.sessionStore.set.mock.calls,
      telemetry: fixture.turnTelemetryStore.record.mock.calls,
      activity: fixture.activityLogger.record.mock.calls,
    });
    fixture.manager.stopAgent("mokie");
  });

  it("checks the retained lifetime when stop/restart fires during dispatcher continuation", async () => {
    configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
    const callId = "stop-in-dispatcher-continuation";
    const ledgerState: { manager?: AgentManager } = {};
    const taskLedger = {
      shouldTrack: vi.fn(() => true),
      onDispatch: vi.fn(async () => undefined),
      onComplete: vi.fn(async () => {
        ledgerState.manager!.stopAgent("mokie");
        ledgerState.manager!.restartAgent("mokie");
      }),
    };
    const fixture = makeFixture({ timeoutMs: 60_000, taskLedger });
    ledgerState.manager = fixture.manager;
    fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "dispatcher-boundary-resume", provider: "claude" });
    const managerResults = captureManagerResults(fixture.manager);
    const routeVoiceTurn = fixture.dispatcher.routeVoiceTurn.bind(fixture.dispatcher);
    vi.spyOn(fixture.dispatcher, "routeVoiceTurn").mockImplementation(async (...args) => {
      const result = await routeVoiceTurn(...args);
      return { ...result, errors: ["dispatcher continuation failure"] };
    });
    runnerControl.openStream.mockImplementationOnce(
      async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
        resultQuery(input, {
          type: "result",
          subtype: "success",
          result: "provider finished before dispatcher stop",
          session_id: "dispatcher-boundary-resume",
          total_cost_usd: 0.04,
          duration_ms: 12,
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }),
    );

    const port = await start(fixture.adapter);
    const response = await begin(port, transcriptBody(callId)).done;
    expect(response).toContain("Internal error");
    expect(taskLedger.onComplete).toHaveBeenCalledTimes(1);
    expect(managerResults).toHaveLength(1);
    expect(managerResults[0]!.voiceLifetimeSignal?.reason).toBeInstanceOf(AgentStoppedError);
    expect(runnerControl.openStream).toHaveBeenCalledTimes(1);
    expect(rows(callId, "engine_attempt_terminal")).toEqual([
      expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed", stopped: true }),
    ]);
    expect(rows(callId, "engine_terminal")).toHaveLength(1);
    expectNoLifecycleInternals({
      response,
      diagnostics: traceLog.writeTracked.mock.calls.map((call) => call[2]),
      taskLedger: [taskLedger.onDispatch.mock.calls, taskLedger.onComplete.mock.calls],
      persistence: fixture.sessionStore.set.mock.calls,
      telemetry: fixture.turnTelemetryStore.record.mock.calls,
      activity: fixture.activityLogger.record.mock.calls,
    });
    fixture.manager.stopAgent("mokie");
  });

  it("performs the final retained-lifetime guard when stop/restart fires from retry logging", async () => {
    configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
    const callId = "stop-from-retry-log";
    const fixture = makeFixture({ timeoutMs: 60_000 });
    fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "retry-log-resume", provider: "claude" });
    const managerResults = captureManagerResults(fixture.manager);
    const routeVoiceTurn = fixture.dispatcher.routeVoiceTurn.bind(fixture.dispatcher);
    vi.spyOn(fixture.dispatcher, "routeVoiceTurn").mockImplementation(async (...args) => {
      const result = await routeVoiceTurn(...args);
      return { ...result, errors: ["retry logging boundary failure"] };
    });
    traceLog.warn.mockImplementation((message: string) => {
      if (message === "Voice spawnTurn resume failed, retrying as turn-1") {
        fixture.manager.stopAgent("mokie");
        fixture.manager.restartAgent("mokie");
      }
    });
    runnerControl.openStream.mockImplementationOnce(
      async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
        resultQuery(input, {
          type: "result",
          subtype: "success",
          result: "provider finished before retry log",
          session_id: "retry-log-resume",
          total_cost_usd: 0.04,
          duration_ms: 12,
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }),
    );

    const port = await start(fixture.adapter);
    const response = await begin(port, transcriptBody(callId)).done;
    expect(response).toContain("Internal error");
    expect(response).not.toContain("replacement");
    expect(managerResults).toHaveLength(1);
    expect(managerResults[0]!.voiceLifetimeSignal?.reason).toBeInstanceOf(AgentStoppedError);
    expect(runnerControl.openStream).toHaveBeenCalledTimes(1);
    expect(rows(callId, "engine_attempt_terminal")).toEqual([
      expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed", stopped: false }),
    ]);
    expect(rows(callId, "engine_terminal")).toHaveLength(1);
    fixture.manager.stopAgent("mokie");
  });

  it("does not reclassify a released ordinary failure when a later independent stop fires", async () => {
    configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
    const callId = "ordinary-failure-late-stop";
    const fixture = makeFixture({ timeoutMs: 60_000 });
    fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "ordinary-late-resume", provider: "claude" });
    const managerResults = captureManagerResults(fixture.manager);
    const replacementInputs: string[] = [];
    traceLog.warn.mockImplementation((message: string) => {
      if (message === "Voice spawnTurn resume failed, retrying as turn-1") {
        fixture.manager.stopAgent("mokie");
        fixture.manager.restartAgent("mokie");
      }
    });
    runnerControl.openStream.mockImplementationOnce(
      async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
        resultQuery(input, {
          type: "result",
          subtype: "error_during_execution",
          errors: ["ordinary failure closed its lifetime"],
          session_id: "ordinary-late-resume",
          total_cost_usd: 0.12,
          duration_ms: 19,
          usage: {
            input_tokens: 6,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }),
    );
    runnerControl.openStream.mockImplementationOnce(
      async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
        successfulQuery(input, "ordinary-late-replacement", "ordinary-late-fresh", replacementInputs),
    );

    const port = await start(fixture.adapter);
    const response = await begin(port, transcriptBody(callId)).done;
    expect(response).toContain("ordinary-late-replacement");
    await vi.waitFor(() => expect(managerResults).toHaveLength(2));
    expect(managerResults[0]).toMatchObject({ errors: ["ordinary failure closed its lifetime"] });
    expect(managerResults[0]!.voiceLifetimeSignal?.aborted).toBe(true);
    expect(managerResults[0]!.voiceLifetimeSignal?.reason).not.toBeInstanceOf(AgentStoppedError);
    expect(runnerControl.openStream).toHaveBeenCalledTimes(2);
    expect(replacementInputs).toHaveLength(1);
    expect(rows(callId, "engine_attempt_terminal")).toEqual([
      expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed", stopped: false }),
      expect.objectContaining({ engineAttemptSeq: 2, outcome: "completed", stopped: false }),
    ]);
    expect(rows(callId, "engine_terminal")).toEqual([
      expect.objectContaining({ engineAttemptSeq: 2, outcome: "completed" }),
    ]);
    fixture.manager.stopAgent("mokie");
  });

  it.each([
    ["stop", false, "eof"],
    ["stop-restart", true, "rejection"],
  ] as const)(
    "prohibits retry when watchdog interrupt rejection races typed %s",
    async (label, restart, settlement) => {
      configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
      const callId = `watchdog-${label}`;
      const fixture = makeFixture({ timeoutMs: 15 });
      fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "stopped-watchdog", provider: "claude" });
      const managerResults = captureManagerResults(fixture.manager);
      const freshInputs: string[] = [];
      let controlled!: ReturnType<typeof controlledPendingQuery>;
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
          controlled = controlledPendingQuery({ input, sessionId: "stopped-watchdog" });
          return controlled.query;
        },
      );
      if (restart) {
        runnerControl.openStream.mockImplementationOnce(
          async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
            successfulQuery(input, "independent-after-restart", "independent-session", freshInputs),
        );
      }

      const port = await start(fixture.adapter);
      const request = begin(port, transcriptBody(callId));
      await vi.waitFor(() => expect(controlled).toBeDefined());
      await controlled.inputConsumed;
      await controlled.pendingReadStarted;
      await vi.waitFor(() => expect(controlled.interrupt).toHaveBeenCalledTimes(1));
      fixture.manager.stopAgent("mokie");
      if (restart) fixture.manager.restartAgent("mokie");
      expect(controlled.close).toHaveBeenCalledTimes(1);
      controlled.rejectInterrupt(new Error("held interrupt rejected after typed stop"));
      if (settlement === "eof") controlled.settleEof();
      else controlled.settleRejection("typed-stop read rejected");

      const response = await request.done;
      expect(response).not.toContain("replacement");
      await vi.waitFor(() => expect(managerResults).toHaveLength(1));
      expect(managerResults[0]).toMatchObject({ errors: [expect.any(String)], aborted: true, timedOut: true });
      expect(managerResults[0]!.voiceLifetimeSignal?.reason).toBeInstanceOf(AgentStoppedError);
      expect(rows(callId, "engine_attempt_terminal")).toEqual([
        expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed", stopped: true }),
      ]);
      expect(rows(callId, "engine_terminal")).toEqual([
        expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed" }),
      ]);
      expect(runnerControl.openStream).toHaveBeenCalledTimes(1);

      if (restart) {
        const independent = begin(port, body(`${callId}-independent`));
        expect(await independent.done).toContain("independent-after-restart");
        expect(freshInputs).toHaveLength(1);
        expect(runnerControl.openStream).toHaveBeenCalledTimes(2);
        fixture.manager.stopAgent("mokie");
      }
    },
  );

  it("keeps a watchdog result with no error in the aborted classification and does not retry", async () => {
    configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
    const callId = "watchdog-no-error-abort";
    const fixture = makeFixture({ timeoutMs: 15 });
    fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "no-error-resume", provider: "claude" });
    const managerResults = captureManagerResults(fixture.manager);
    let controlled!: ReturnType<typeof controlledPendingQuery>;
    runnerControl.openStream.mockImplementationOnce(
      async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
        controlled = controlledPendingQuery({ input, sessionId: "no-error-resume", includeUsage: false });
        return controlled.query;
      },
    );

    const port = await start(fixture.adapter);
    const request = begin(port, transcriptBody(callId));
    await vi.waitFor(() => expect(controlled).toBeDefined());
    await controlled.inputConsumed;
    await controlled.pendingReadStarted;
    await vi.waitFor(() => expect(controlled.interrupt).toHaveBeenCalledTimes(1));
    controlled.resolveInterrupt();
    controlled.settleValue({
      type: "result",
      subtype: "error_during_execution",
      errors: ["provider encoded interruption"],
      session_id: "no-error-resume",
      total_cost_usd: 0.09,
      duration_ms: 23,
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 0,
      },
    });

    const response = await request.done;
    expect(response).toContain("[DONE]");
    expect(response).not.toContain("provider encoded interruption");
    await vi.waitFor(() => expect(managerResults).toHaveLength(1));
    expect(managerResults[0]).toMatchObject({
      errors: [],
      aborted: true,
      timedOut: true,
      usage: {
        costUsd: 0.09,
        durationMs: 23,
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheCreationTokens: 0,
      },
    });
    expect(runnerControl.openStream).toHaveBeenCalledTimes(1);
    expect(rows(callId, "engine_attempt_terminal")).toEqual([
      expect.objectContaining({ engineAttemptSeq: 1, outcome: "cancelled", stopped: false }),
    ]);
    expect(rows(callId, "engine_terminal")).toEqual([
      expect.objectContaining({ engineAttemptSeq: 1, outcome: "cancelled" }),
    ]);
    fixture.manager.stopAgent("mokie");
  });

  it.each(["eof", "rejection"] as const)(
    "preserves ordinary live pre-text resumed %s failure and its one fresh retry",
    async (settlement) => {
      configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
      const callId = `ordinary-session-${settlement}`;
      const fixture = makeFixture({ timeoutMs: 60_000 });
      fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "ordinary-resume", provider: "claude" });
      const managerResults = captureManagerResults(fixture.manager);
      const replacementInputs: string[] = [];
      let controlled!: ReturnType<typeof controlledPendingQuery>;
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) => {
          controlled = controlledPendingQuery({ input, sessionId: "ordinary-resume" });
          return controlled.query;
        },
      );
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
          successfulQuery(
            input,
            `ordinary-replacement-${settlement}`,
            `ordinary-fresh-${settlement}`,
            replacementInputs,
          ),
      );

      const port = await start(fixture.adapter);
      const requestBody = transcriptBody(callId);
      const request = begin(port, requestBody);
      await vi.waitFor(() => expect(controlled).toBeDefined());
      await controlled.inputConsumed;
      await controlled.pendingReadStarted;
      if (settlement === "eof") controlled.settleEof();
      else controlled.settleRejection("ordinary provider session rejection");

      const response = await request.done;
      expect(response).toContain(`ordinary-replacement-${settlement}`);
      expect(response).toContain("[DONE]");
      await vi.waitFor(() => expect(managerResults).toHaveLength(2));
      expect(managerResults[0]).toMatchObject({
        errors: [
          settlement === "eof"
            ? expect.stringContaining("output ended before turn result")
            : "Error: ordinary provider session rejection",
        ],
      });
      expect(managerResults[0]!.aborted).toBeUndefined();
      expect(managerResults[0]!.timedOut).toBeUndefined();
      expect(managerResults[0]!.voiceLifetimeSignal?.reason).not.toBeInstanceOf(AgentStoppedError);
      expect(
        replacementInputs[0]!.startsWith(
          `${renderConversationPrompt(requestBody.messages)}\n\n**Current date/time**: `,
        ),
      ).toBe(true);
      expect(rows(callId, "engine_attempt_terminal")).toEqual([
        expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed", stopped: false }),
        expect.objectContaining({ engineAttemptSeq: 2, outcome: "completed", stopped: false }),
      ]);
      expect(rows(callId, "engine_terminal")).toHaveLength(1);
      fixture.manager.stopAgent("mokie");
    },
  );

  it.each([
    ["same-id", "cost-resume", true],
    ["changed-id", "cost-minted", false],
  ] as const)(
    "retains exact provider error cost and %s persistence predicate before retry",
    async (label, resultSessionId, persists) => {
      configRef.current.voice = { assistants: {}, warmPath: { enabled: true }, toolAck: { enabled: false } };
      const callId = `provider-cost-${label}`;
      const fixture = makeFixture({ timeoutMs: 60_000 });
      fixture.sessions.set(`mokie:voice:${callId}`, { sessionId: "cost-resume", provider: "claude" });
      const managerResults = captureManagerResults(fixture.manager);
      const replacementInputs: string[] = [];
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
          resultQuery(input, {
            type: "result",
            subtype: "error_during_execution",
            errors: ["provider failed before text"],
            session_id: resultSessionId,
            total_cost_usd: 0.37,
            duration_ms: 42,
            usage: {
              input_tokens: 19,
              output_tokens: 5,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 1,
            },
          }),
      );
      runnerControl.openStream.mockImplementationOnce(
        async ({ input }: { input: AsyncIterable<{ message?: { content?: string } }> }) =>
          successfulQuery(input, `cost-replacement-${label}`, `cost-fresh-${label}`, replacementInputs),
      );

      const port = await start(fixture.adapter);
      const response = await begin(port, transcriptBody(callId)).done;
      expect(response).toContain(`cost-replacement-${label}`);
      await vi.waitFor(() => expect(managerResults).toHaveLength(2));
      expect(managerResults[0]).toMatchObject({
        errors: ["provider failed before text"],
        resumedSession: true,
        usage: {
          costUsd: 0.37,
          durationMs: 42,
          inputTokens: 19,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheCreationTokens: 1,
        },
      });
      expect(managerResults[0]!.voiceLifetimeSignal?.aborted).toBe(true);
      expect(managerResults[0]!.voiceLifetimeSignal?.reason).not.toBeInstanceOf(AgentStoppedError);
      expect(fixture.activityLogger.record).toHaveBeenCalledWith(
        expect.objectContaining({
          costUsd: 0.37,
          durationMs: 42,
          inputTokens: 19,
          outputTokens: 5,
          error: "provider failed before text",
        }),
      );
      const resultPersist = fixture.sessionStore.set.mock.calls.find((call) => call[2] === resultSessionId);
      if (persists) {
        expect(resultPersist).toEqual([
          "mokie",
          `voice:${callId}`,
          "cost-resume",
          "claude",
          {
            inputTokens: 19,
            outputTokens: 5,
            cacheReadTokens: 2,
            cacheCreationTokens: 1,
            contextWindow: 0,
            compactions: 0,
            preCompactTokens: undefined,
          },
          undefined,
        ]);
      } else {
        expect(resultPersist).toBeUndefined();
      }
      expect(rows(callId, "engine_attempt_terminal")).toEqual([
        expect.objectContaining({ engineAttemptSeq: 1, outcome: "failed", stopped: false }),
        expect.objectContaining({ engineAttemptSeq: 2, outcome: "completed", stopped: false }),
      ]);
      expect(replacementInputs).toHaveLength(1);
      fixture.manager.stopAgent("mokie");
    },
  );

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
