import { describe, expect, it, vi, beforeEach } from "vitest";
import type { VendorCell } from "./cells.js";
import { resolveFailureAction, type BridgeFailureClass } from "./error-map.js";
import type { WorkerConfig } from "./worker-config.js";

const { sdkState, sipState } = vi.hoisted(() => ({
  sdkState: {
    sessions: [] as Array<Record<string, unknown>>,
    startImpl: async () => {},
    closeImpl: async () => {},
    createdAtStart: [] as string[],
    startOptions: [] as unknown[],
  },
  sipState: {
    calls: [] as unknown[][],
    createImpl: async () => ({}),
  },
}));

vi.mock("@livekit/agents", () => {
  class Emitter {
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    prependListener(event: string, listener: (...args: unknown[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.unshift(listener);
      this.listeners.set(event, list);
      return this;
    }
    off(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
      return true;
    }
  }
  class FakeHandle {
    interrupted = false;
    settled = false;
    callbacks = new Set<(handle: FakeHandle) => void>();
    constructor(readonly id: string) {}
    done() {
      return this.settled;
    }
    interrupt() {
      this.interrupted = true;
      return this;
    }
    waitForPlayout() {
      return Promise.resolve();
    }
    addDoneCallback(callback: (handle: FakeHandle) => void) {
      this.callbacks.add(callback);
    }
    removeDoneCallback(callback: (handle: FakeHandle) => void) {
      this.callbacks.delete(callback);
    }
  }
  class Agent extends Emitter {
    static default = { ttsNode: async () => null };
    tts: unknown;
    constructor(options: { tts?: unknown } = {}) {
      super();
      this.tts = options.tts;
    }
  }
  class AgentSession extends Emitter {
    input = { audioEnabled: true, setAudioEnabled: vi.fn((enabled: boolean) => (this.input.audioEnabled = enabled)) };
    output = {
      audioEnabled: true,
      audio: { clearBuffer: vi.fn() },
      setAudioEnabled: vi.fn((enabled: boolean) => (this.output.audioEnabled = enabled)),
    };
    start = vi.fn(async (options: unknown) => {
      sdkState.createdAtStart = [...this.listeners.keys()];
      sdkState.startOptions.push(options);
      return sdkState.startImpl.call(this, options);
    });
    close = vi.fn(async () => sdkState.closeImpl());
    generateReply = vi.fn(() => {
      const handle = new FakeHandle(`speech-${this.generateReply.mock.calls.length}`);
      this.emit("speech_created", {
        type: "speech_created",
        speechHandle: handle,
        source: "generate_reply",
        userInitiated: true,
        createdAt: Date.now(),
      });
      return handle;
    });
    say = vi.fn(() => {
      const handle = new FakeHandle(`say-${this.say.mock.calls.length}`);
      this.emit("speech_created", {
        type: "speech_created",
        speechHandle: handle,
        source: "say",
        userInitiated: true,
        createdAt: Date.now(),
      });
      return handle;
    });
    constructor() {
      super();
      sdkState.sessions.push(this as unknown as Record<string, unknown>);
    }
  }
  class LLM extends Emitter {}
  class LLMStream {}
  return {
    voice: {
      Agent,
      AgentSession,
      AgentSessionEventTypes: {
        SpeechCreated: "speech_created",
        MetricsCollected: "metrics_collected",
        UserInputTranscribed: "user_input_transcribed",
        UserStateChanged: "user_state_changed",
        ConversationItemAdded: "conversation_item_added",
        Error: "error",
        Close: "close",
      },
    },
    llm: { LLM, LLMStream },
  };
});

vi.mock("@livekit/agents-plugin-deepgram", () => ({ STT: vi.fn(), STTv2: vi.fn() }));
vi.mock("@livekit/agents-plugin-silero", () => ({ VAD: { load: vi.fn(async () => ({})) } }));
vi.mock("livekit-server-sdk", () => ({
  SipClient: vi.fn().mockImplementation(function SipClient() {
    return {
      createSipParticipant: vi.fn(async (...args: unknown[]) => {
        sipState.calls.push(args);
        return sipState.createImpl();
      }),
    };
  }),
}));

const { mongoMocks } = vi.hoisted(() => ({
  mongoMocks: {
    insertOne: vi.fn(),
    connect: vi.fn(),
    close: vi.fn(),
    db: vi.fn(),
    collection: vi.fn(),
    MongoClient: vi.fn(),
  },
}));

vi.mock("mongodb", () => {
  mongoMocks.collection.mockImplementation(() => ({ insertOne: mongoMocks.insertOne }));
  mongoMocks.db.mockImplementation(() => ({ collection: mongoMocks.collection }));
  mongoMocks.MongoClient.mockImplementation(function MongoClient() {
    return {
      connect: mongoMocks.connect,
      db: mongoMocks.db,
      close: mongoMocks.close,
    };
  });
  return { MongoClient: mongoMocks.MongoClient };
});

const { cartesiaCtorCalls, elevenlabsCtorCalls } = vi.hoisted(() => ({
  cartesiaCtorCalls: [] as Array<Record<string, unknown>>,
  elevenlabsCtorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@livekit/agents-plugin-cartesia", () => ({
  TTS: vi.fn().mockImplementation(function (this: unknown, opts: Record<string, unknown>) {
    cartesiaCtorCalls.push(opts);
    return { label: "cartesia-tts-mock", on: vi.fn(), off: vi.fn() };
  }),
}));

vi.mock("@livekit/agents-plugin-elevenlabs", () => ({
  TTS: vi.fn().mockImplementation(function (this: unknown, opts: Record<string, unknown>) {
    elevenlabsCtorCalls.push(opts);
    return { label: "elevenlabs-tts-mock", on: vi.fn(), off: vi.fn() };
  }),
}));

import { buildTts, recordSetupFailure, resolveInboundAgent, runCallSession, runJobShutdown } from "./session.js";
import { CallStats, VoiceWorkerHeartbeat } from "./telemetry.js";

const INBOUND_COPY = {
  goal: "Answer this inbound vendor callback professionally and help the caller.",
  context: "Inbound call to the hive ops line (vendor callback).",
} as const;

describe("resolveInboundAgent (KPR-322)", () => {
  const inboundAgents = { "+15551234567": "nora", "+15557654321": "luna" };

  it("maps a known called-number to agentId plus generic vendor-callback goal/context", () => {
    expect(resolveInboundAgent("+15551234567", inboundAgents)).toEqual({
      agentId: "nora",
      ...INBOUND_COPY,
    });
    expect(resolveInboundAgent("+15557654321", inboundAgents)).toEqual({
      agentId: "luna",
      ...INBOUND_COPY,
    });
  });

  it("returns null for an unmapped number", () => {
    expect(resolveInboundAgent("+19990000000", inboundAgents)).toBeNull();
  });

  it("returns null when the called-number is undefined or empty", () => {
    expect(resolveInboundAgent(undefined, inboundAgents)).toBeNull();
    expect(resolveInboundAgent("", inboundAgents)).toBeNull();
  });

  it("returns null for a prototype-chain called-number, not Object's constructor", () => {
    // Epic-integration review round 1 (mechanical): telephony-supplied
    // "constructor" would otherwise resolve Object.prototype.constructor
    // (truthy, typeof "function") off the prototype chain instead of
    // hitting the own-property guard and returning null.
    expect(resolveInboundAgent("constructor", inboundAgents)).toBeNull();
    expect(resolveInboundAgent("toString", inboundAgents)).toBeNull();
  });
});

describe("resolveFailureAction session-layer truth table (KPR-322 §8)", () => {
  const cases: Array<{
    cls: BridgeFailureClass;
    consumed: boolean;
    expected: ReturnType<typeof resolveFailureAction>;
  }> = [
    {
      cls: "budget_saturated",
      consumed: false,
      expected: { kind: "retry", sayFirst: "hold_on", delayMs: 2000 },
    },
    { cls: "budget_saturated", consumed: true, expected: { kind: "end", say: "apologize_end" } },
    { cls: "spawn_failed", consumed: false, expected: { kind: "retry", sayFirst: null, delayMs: 0 } },
    { cls: "spawn_failed", consumed: true, expected: { kind: "end", say: "apologize_end" } },
    { cls: "engine_auth", consumed: false, expected: { kind: "end", say: "apologize_end" } },
    { cls: "engine_auth", consumed: true, expected: { kind: "end", say: "apologize_end" } },
    { cls: "bridge_auth", consumed: false, expected: { kind: "end", say: "apologize_end" } },
    { cls: "bridge_auth", consumed: true, expected: { kind: "end", say: "apologize_end" } },
    { cls: "engine_unreachable", consumed: false, expected: { kind: "end", say: "canned_engine_down" } },
    { cls: "engine_unreachable", consumed: true, expected: { kind: "end", say: "canned_engine_down" } },
    { cls: "midstream_error", consumed: false, expected: { kind: "continue" } },
    { cls: "midstream_error", consumed: true, expected: { kind: "continue" } },
  ];

  it("covers every BridgeFailureClass × {retry-available, retry-consumed}", () => {
    for (const { cls, consumed, expected } of cases) {
      expect(resolveFailureAction(cls, consumed), `${cls} consumed=${consumed}`).toEqual(expected);
    }
  });

  it("yields at most one spoken line per terminal outcome", () => {
    for (const { cls, consumed } of cases) {
      const action = resolveFailureAction(cls, consumed);
      if (action.kind === "end") {
        expect(["apologize_end", "canned_engine_down"]).toContain(action.say);
      }
      if (action.kind === "retry") {
        expect(action.sayFirst === "hold_on" || action.sayFirst === null).toBe(true);
      }
    }
  });
});

describe("CallStats.retryConsumed (KPR-322 Task 7 stand-in)", () => {
  const cell: VendorCell = { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" };
  const wc = {
    livekitUrl: "wss://example.livekit.cloud",
    livekitApiKey: "k",
    livekitApiSecret: "s",
    sipTrunkId: "ST_x",
    inboundAgents: {},
    agentVoices: {},
    defaultStt: "deepgram/flux-general-en",
    defaultTts: "cartesia/sonic-3",
    deepgramApiKey: "dg",
    cartesiaApiKey: "c",
    elevenlabsApiKey: "e",
    bridgeToken: "t",
    bridgeUrl: "http://127.0.0.1:9/v1/chat/completions",
    mongoUri: "mongodb://localhost",
    mongoDbName: "hive",
  } satisfies WorkerConfig;

  it("returns false on the first call per class and true on the second", () => {
    const stats = new CallStats(wc, { callId: "call-1", agentId: "luna", cell, direction: "outbound" });
    expect(stats.retryConsumed("budget_saturated")).toBe(false);
    expect(stats.retryConsumed("budget_saturated")).toBe(true);
    expect(stats.retryConsumed("spawn_failed")).toBe(false);
    expect(stats.retryConsumed("spawn_failed")).toBe(true);
  });
});

describe("recordSetupFailure (KPR-322 setup telemetry)", () => {
  const cell: VendorCell = { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" };
  const wc = {
    livekitUrl: "wss://example.livekit.cloud",
    livekitApiKey: "k",
    livekitApiSecret: "s",
    sipTrunkId: "ST_x",
    inboundAgents: {},
    agentVoices: {},
    defaultStt: "deepgram/flux-general-en",
    defaultTts: "cartesia/sonic-3",
    deepgramApiKey: "dg",
    cartesiaApiKey: "c",
    elevenlabsApiKey: "e",
    bridgeToken: "t",
    bridgeUrl: "http://127.0.0.1:9/v1/chat/completions",
    mongoUri: "mongodb://localhost",
    mongoDbName: "hive",
  } satisfies WorkerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mongoMocks.insertOne.mockResolvedValue({ acknowledged: true });
    mongoMocks.connect.mockResolvedValue(undefined);
    mongoMocks.close.mockResolvedValue(undefined);
  });

  it("first-wins: subsequent flush(completed) keeps outcome setup_failed", async () => {
    const stats = new CallStats(wc, { callId: "call-1", agentId: "luna", cell, direction: "outbound" });
    const coll = { updateOne: vi.fn().mockResolvedValue({ acknowledged: true }) };
    const heartbeat = new VoiceWorkerHeartbeat(coll as never, {
      defaultStt: wc.defaultStt,
      defaultTts: wc.defaultTts,
    });

    await recordSetupFailure(stats, heartbeat);
    await stats.flush("completed");

    expect(mongoMocks.insertOne).toHaveBeenCalledTimes(1);
    const doc = mongoMocks.insertOne.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc.outcome).toBe("setup_failed");
    expect(doc).not.toHaveProperty("to");
    expect(doc).not.toHaveProperty("phone");

    expect(coll.updateOne).toHaveBeenCalledTimes(1);
    const update = coll.updateOne.mock.calls[0]![1] as { $set: Record<string, unknown> };
    expect(update.$set.lastError).toBe("setup_failed");
  });
});

describe("runJobShutdown (KPR-322 call-end heartbeat)", () => {
  it("closes trace, settles writes, snapshots, releases heartbeat, flushes, then closes Mongo", async () => {
    const order: string[] = [];
    let finishRelease!: () => void;
    const releaseCall = () =>
      new Promise<void>((resolve) => {
        order.push("release-started");
        finishRelease = () => {
          order.push("release-finished");
          resolve();
        };
      });
    const flush = async () => {
      order.push("flush");
    };
    const closeMongo = () => {
      order.push("close");
      return Promise.resolve();
    };

    const running = runJobShutdown({
      closeTrace: () => order.push("trace-close"),
      settleTrace: async () => {
        order.push("settle");
      },
      snapshotTrace: () => {
        order.push("snapshot");
        return undefined as never;
      },
      releaseCall,
      flush,
      closeMongo,
    });
    await Promise.resolve();
    expect(order).toEqual(["trace-close", "settle"]);
    await Promise.resolve();
    expect(order).toEqual(["trace-close", "settle", "snapshot", "release-started"]);
    finishRelease();
    await running;
    expect(order).toEqual([
      "trace-close",
      "settle",
      "snapshot",
      "release-started",
      "release-finished",
      "flush",
      "close",
    ]);
  });

  it("continues ordered persistence and close when bounded log settlement fails", async () => {
    const order: string[] = [];
    await runJobShutdown({
      closeTrace: () => {
        order.push("trace-close");
        throw new Error("finalization failed");
      },
      settleTrace: async () => {
        order.push("settle");
        throw new Error("logging timeout");
      },
      snapshotTrace: () => {
        order.push("snapshot");
        throw new Error("snapshot failed");
      },
      releaseCall: async () => {
        order.push("release");
      },
      flush: async () => {
        order.push("flush");
        throw new Error("persistence failed");
      },
      closeMongo: async () => {
        order.push("close");
      },
    });
    expect(order).toEqual(["trace-close", "settle", "snapshot", "release", "flush", "close"]);
  });

  it("continues release, flush, and Mongo close when synchronous finalization and snapshot fail", async () => {
    const order: string[] = [];
    await runJobShutdown({
      closeTrace: () => {
        order.push("trace-close");
        throw new Error("finalization failed");
      },
      snapshotTrace: () => {
        order.push("snapshot");
        throw new Error("snapshot failed");
      },
      releaseCall: async () => {
        order.push("release");
      },
      flush: async () => {
        order.push("flush");
      },
      closeMongo: async () => {
        order.push("close");
      },
    });
    expect(order).toEqual(["trace-close", "snapshot", "release", "flush", "close"]);
  });
});

describe("buildTts (KPR-325 per-agent voice)", () => {
  const baseWc = {
    cartesiaApiKey: "ck_test",
    elevenlabsApiKey: "el_test",
    agentVoices: {},
  } as WorkerConfig;
  const cartesiaCell = { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" } as VendorCell;
  const elevenlabsCell = { stt: "deepgram/flux-general-en", tts: "elevenlabs/eleven_flash_v2_5" } as VendorCell;

  beforeEach(() => {
    cartesiaCtorCalls.length = 0;
    elevenlabsCtorCalls.length = 0;
  });

  it("passes the agent's configured voice id to Cartesia", () => {
    const wc = { ...baseWc, agentVoices: { mokie: "00000000-0000-4000-8000-000000000001" } };
    buildTts(cartesiaCell, wc, "mokie");
    expect(cartesiaCtorCalls[0]).toMatchObject({
      model: "sonic-3",
      apiKey: "ck_test",
      voice: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("omits the voice option when the agent has no configured voice", () => {
    buildTts(cartesiaCell, baseWc, "sige");
    expect(cartesiaCtorCalls[0]).toEqual({ model: "sonic-3", apiKey: "ck_test" });
    expect(cartesiaCtorCalls[0]).not.toHaveProperty("voice");
  });

  it("omits the voice option when agentId is unset entirely", () => {
    buildTts(cartesiaCell, baseWc, "");
    expect(cartesiaCtorCalls[0]).not.toHaveProperty("voice");
  });

  it("omits the voice option for a prototype-chain agentId (no accidental Function value)", () => {
    buildTts(cartesiaCell, baseWc, "constructor");
    expect(cartesiaCtorCalls[0]).toEqual({ model: "sonic-3", apiKey: "ck_test" });
    expect(cartesiaCtorCalls[0]).not.toHaveProperty("voice");
  });

  it("ElevenLabs branch is unaffected by agentVoices — no voice option threaded", () => {
    const wc = { ...baseWc, agentVoices: { mokie: "00000000-0000-4000-8000-000000000001" } };
    buildTts(elevenlabsCell, wc, "mokie");
    expect(elevenlabsCtorCalls[0]).toEqual({ model: "eleven_flash_v2_5", apiKey: "el_test" });
    expect(cartesiaCtorCalls).toHaveLength(0);
  });
});

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeRoom {
  name = "call-startup-test";
  remoteParticipants = new Map<string, { identity: string; attributes?: Record<string, string> }>();
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

const SESSION_WC = {
  livekitUrl: "wss://example.livekit.cloud",
  livekitApiKey: "k",
  livekitApiSecret: "s",
  sipTrunkId: "ST_x",
  inboundAgents: {},
  agentVoices: {},
  defaultStt: "deepgram/flux-general-en",
  defaultTts: "cartesia/sonic-3",
  deepgramApiKey: "dg",
  cartesiaApiKey: "c",
  elevenlabsApiKey: "e",
  bridgeToken: "t",
  bridgeUrl: "http://127.0.0.1:9/v1/chat/completions",
  mongoUri: "mongodb://localhost",
  mongoDbName: "hive",
} satisfies WorkerConfig;

function sessionFixture() {
  const room = new FakeRoom();
  let shutdownCallback: (() => Promise<void>) | undefined;
  const ctx = {
    room,
    connect: vi.fn(async () => {}),
    shutdown: vi.fn(),
    addShutdownCallback: vi.fn((callback: () => Promise<void>) => {
      shutdownCallback = callback;
    }),
  };
  return { room, ctx, shutdown: () => shutdownCallback?.() };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
}

describe("runCallSession startup ownership and teardown", () => {
  beforeEach(() => {
    sdkState.sessions.length = 0;
    sdkState.createdAtStart = [];
    sdkState.startOptions.length = 0;
    sdkState.startImpl = async () => {};
    sdkState.closeImpl = async () => {};
    sipState.calls.length = 0;
    sipState.createImpl = async () => ({});
  });

  it("installs every observation seam before start, pins input to SIP identity, and opens once after answer", async () => {
    const fixture = sessionFixture();
    await runCallSession(
      fixture.ctx as never,
      SESSION_WC,
      { to: "+15551234567", hive_agent_id: "nora", goal: "call", context: "test" },
      { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" },
    );
    const session = sdkState.sessions[0] as {
      generateReply: ReturnType<typeof vi.fn>;
      emit(event: string, value?: unknown): void;
    };
    expect(sdkState.createdAtStart).toEqual(
      expect.arrayContaining([
        "speech_created",
        "metrics_collected",
        "user_input_transcribed",
        "user_state_changed",
        "conversation_item_added",
        "error",
        "close",
      ]),
    );
    expect(sdkState.startOptions[0]).toMatchObject({
      inputOptions: { participantIdentity: "sip-call-startup-test", audioEnabled: true },
    });
    expect(sipState.calls[0]![3]).toMatchObject({
      participantIdentity: "sip-call-startup-test",
      waitUntilAnswered: true,
    });
    expect(session.generateReply).toHaveBeenCalledOnce();
    session.emit("close");
    await fixture.shutdown();
  });

  it("does not treat an unrelated participant as answer or caller input", async () => {
    const answered = gate<void>();
    sipState.createImpl = async () => answered.promise;
    const fixture = sessionFixture();
    const running = runCallSession(
      fixture.ctx as never,
      SESSION_WC,
      { to: "+15551234567", hive_agent_id: "nora", goal: "call", context: "test" },
      { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" },
    );
    await until(() => sipState.calls.length === 1);
    const session = sdkState.sessions[0] as { generateReply: ReturnType<typeof vi.fn>; emit(event: string): void };
    fixture.room.emit("participantConnected", { identity: "somebody-else" });
    expect(session.generateReply).not.toHaveBeenCalled();
    answered.resolve();
    await running;
    expect(session.generateReply).toHaveBeenCalledOnce();
    session.emit("close");
    await fixture.shutdown();
  });

  it("suppresses the opening when a nonempty final arrives before SIP answer and acceptance follows", async () => {
    const answered = gate<void>();
    sipState.createImpl = async () => answered.promise;
    const fixture = sessionFixture();
    const running = runCallSession(
      fixture.ctx as never,
      SESSION_WC,
      { to: "+15551234567", hive_agent_id: "nora", goal: "call", context: "test" },
      { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" },
    );
    await until(() => sipState.calls.length === 1);
    const session = sdkState.sessions[0] as {
      generateReply: ReturnType<typeof vi.fn>;
      emit(event: string, value?: unknown): void;
    };
    session.emit("user_input_transcribed", { isFinal: true, transcript: "hello" });
    session.emit("user_state_changed", { newState: "listening" });
    answered.resolve();
    await running;
    const started = sdkState.startOptions[0] as { agent: { onUserTurnCompleted(...args: unknown[]): Promise<void> } };
    await started.agent.onUserTurnCompleted({}, { textContent: "hello" });
    expect(session.generateReply).not.toHaveBeenCalled();
    session.emit("close");
    await fixture.shutdown();
  });

  it("terminalizes synchronously while start is gated and performs a fresh close after late start", async () => {
    const start = gate<void>();
    sdkState.startImpl = async () => start.promise;
    const fixture = sessionFixture();
    const running = runCallSession(
      fixture.ctx as never,
      SESSION_WC,
      { to: "+15551234567", hive_agent_id: "nora", goal: "call", context: "test" },
      { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" },
    );
    await until(() => sdkState.sessions.length === 1);
    const session = sdkState.sessions[0] as {
      close: ReturnType<typeof vi.fn>;
      input: { audioEnabled: boolean };
      output: { audioEnabled: boolean; audio: { clearBuffer: ReturnType<typeof vi.fn> } };
    };
    fixture.room.emit("disconnected");
    await running;
    expect(session.input.audioEnabled).toBe(false);
    expect(session.output.audioEnabled).toBe(false);
    expect(session.output.audio.clearBuffer).toHaveBeenCalledOnce();
    expect(sipState.calls).toHaveLength(0);
    await until(() => session.close.mock.calls.length === 1);
    start.resolve();
    await until(() => session.close.mock.calls.length === 2);
    expect(sipState.calls).toHaveLength(0);
    await fixture.shutdown();
  });

  it("waits for an in-flight pre-start close before issuing the mandatory post-start close", async () => {
    const start = gate<void>();
    const firstClose = gate<void>();
    let closeCount = 0;
    sdkState.startImpl = async () => start.promise;
    sdkState.closeImpl = async () => {
      closeCount += 1;
      if (closeCount === 1) await firstClose.promise;
    };
    const fixture = sessionFixture();
    const running = runCallSession(
      fixture.ctx as never,
      SESSION_WC,
      { to: "+15551234567", hive_agent_id: "nora", goal: "call", context: "test" },
      { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" },
    );
    await until(() => sdkState.sessions.length === 1);
    fixture.room.emit("disconnected");
    await until(() => closeCount === 1);
    start.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeCount).toBe(1);
    firstClose.resolve();
    await running;
    await until(() => closeCount === 2);
    expect(sipState.calls).toHaveLength(0);
    await fixture.shutdown();
  });

  it("contains a late start rejection and never creates SIP work", async () => {
    const start = gate<void>();
    sdkState.startImpl = async () => start.promise;
    const fixture = sessionFixture();
    const running = runCallSession(
      fixture.ctx as never,
      SESSION_WC,
      { to: "+15551234567", hive_agent_id: "nora", goal: "call", context: "test" },
      { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" },
    );
    await until(() => sdkState.sessions.length === 1);
    fixture.room.emit("disconnected");
    await running;
    start.reject(new Error("late partial start failure"));
    const session = sdkState.sessions[0] as { close: ReturnType<typeof vi.fn> };
    await until(() => session.close.mock.calls.length === 2);
    expect(sipState.calls).toHaveLength(0);
    await fixture.shutdown();
  });

  it("bounds a post-start close that never settles and still suppresses SIP", async () => {
    const start = gate<void>();
    let closeCount = 0;
    sdkState.startImpl = async () => start.promise;
    sdkState.closeImpl = async () => {
      closeCount += 1;
      if (closeCount > 1) await new Promise<void>(() => {});
    };
    const fixture = sessionFixture();
    const running = runCallSession(
      fixture.ctx as never,
      SESSION_WC,
      { to: "+15551234567", hive_agent_id: "nora", goal: "call", context: "test" },
      { stt: "deepgram/flux-general-en", tts: "cartesia/sonic-3" },
    );
    await until(() => sdkState.sessions.length === 1);
    fixture.room.emit("disconnected");
    await running;
    start.resolve();
    await until(() => closeCount === 2);
    await new Promise((resolve) => setTimeout(resolve, 2_050));
    expect(closeCount).toBe(2);
    expect(sipState.calls).toHaveLength(0);
  }, 4_000);
});
