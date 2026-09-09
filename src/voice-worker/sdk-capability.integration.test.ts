import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  USERDATA_TIMED_TRANSCRIPT,
  VADEventType,
  initializeLogger,
  stt,
  type ChatContext,
  type ChatMessage,
  type ModelSettings,
} from "@livekit/agents";
import { afterAll, describe, expect, it } from "vitest";
import { formatSSEDone, formatSSETextChunk } from "../channels/voice/openai-translator.js";
import {
  VOICE_PROCESS_ID,
  type VoiceDiagnosticEvent,
  type VoiceTraceWriteCounts,
  type VoiceTraceWriter,
} from "../voice/voice-trace.js";
import { HiveLLM } from "./hive-llm.js";
import { SpeechTrace } from "./speech-trace.js";
import { TracedAgent } from "./traced-agent.js";
import {
  CaptureAudioOutput,
  ControlledLLM,
  ControlledTTS,
  PushAudioInput,
  ScriptedSTT,
  ScriptedVAD,
  StartupObserver,
  capabilityContext,
  fixtureAudioFrame,
  gate,
  observeNodeForCancellation,
  transcript,
  until,
  vadEvent,
} from "./testing/startup-fixture.js";

initializeLogger({ pretty: false, level: "silent" });

const sessions = new Set<AgentSession>();

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

function traceHarness(callId: string) {
  const rows: VoiceDiagnosticEvent[] = [];
  const writer: VoiceTraceWriter = {
    write: (event) => rows.push(event),
    emit: (event) => rows.push(event),
    snapshot: () => ({ ...COMPLETE_WRITES, attempted: rows.length, acknowledged: rows.length }),
    settleWrites: async () => ({ ...COMPLETE_WRITES, attempted: rows.length, acknowledged: rows.length }),
  };
  return { rows, trace: new SpeechTrace({ callId, workerBootId: VOICE_PROCESS_ID, writer }) };
}

async function startSession(session: AgentSession, agent: Agent): Promise<void> {
  sessions.add(session);
  await session.start({ agent });
}

async function closeSession(session: AgentSession): Promise<void> {
  sessions.delete(session);
  await session.close().catch(() => {});
}

afterAll(async () => {
  await Promise.all([...sessions].map((session) => session.close().catch(() => {})));
});

describe("pinned SDK artifact", () => {
  it("executes the exact lockfile artifact used by the capability record", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const installed = JSON.parse(readFileSync("node_modules/@livekit/agents/package.json", "utf8"));
    const rtc = JSON.parse(readFileSync("node_modules/@livekit/rtc-node/package.json", "utf8"));
    const entry = lock.packages["node_modules/@livekit/agents"];

    expect(process.version).toBe("v24.16.0");
    expect(installed.version).toBe("1.6.4");
    expect(rtc.version).toBe("0.13.33");
    expect(entry).toMatchObject({
      version: "1.6.4",
      resolved: "https://registry.npmjs.org/@livekit/agents/-/agents-1.6.4.tgz",
      integrity: "sha512-Q+qlXmR8wLB4aMm2K5bt1ijItuMcoyfHvAHp047ORf2+yhIwR6csKfo95ErPbszWzgnLf7nIGSvJjvNVSh9okA==",
    });
  });
});

class TracedTtsAgent extends Agent {
  readonly invocations: Array<{ synthesisId: string; trace: unknown }> = [];

  constructor(
    tts: ControlledTTS,
    private readonly prefix = "synth",
  ) {
    super({ instructions: "offline capability fixture", tts });
  }

  override async ttsNode(text: ReadableStream<string> | AsyncIterable<string>, modelSettings: ModelSettings) {
    const synthesisId = `${this.prefix}-${this.invocations.length + 1}`;
    this.invocations.push({ synthesisId, trace: capabilityContext.getStore() ?? null });
    return capabilityContext.run(Object.freeze({ synthesisId }), () =>
      Agent.default.ttsNode(this, text, modelSettings),
    );
  }
}

describe("public TTS observer seams", () => {
  it("routes the real default provider through the production observer and public error listener", async () => {
    const model = new ControlledTTS();
    const session = new AgentSession({
      tts: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    const callId = "call-production-tts-observer";
    const { rows, trace } = traceHarness(callId);
    const call = new AbortController();
    const agent = new TracedAgent({
      instructions: "offline capability fixture",
      tts: model,
      callId,
      workerBootId: VOICE_PROCESS_ID,
      callSignal: call.signal,
      trace,
      onAcceptedUserTurn: () => {},
    });
    session.on(AgentSessionEventTypes.MetricsCollected, (event) => trace.metrics(event));
    await startSession(session, agent);
    try {
      const normalNode = await agent.ttsNode(
        new ReadableStream({
          start(controller) {
            controller.enqueue("production normal");
            controller.close();
          },
        }),
        {},
      );
      const normalFrames = [];
      const normalReader = normalNode!.getReader();
      for (;;) {
        const next = await normalReader.read();
        if (next.done) break;
        normalFrames.push(next.value);
      }
      expect(normalFrames[0]).toBe(model.frames[0]);
      expect(rows.find((row) => row.event === "synthesis_terminal")).toMatchObject({
        outcome: "completed",
        frameCount: 1,
      });

      for (const [mode, frameCount] of [
        ["error-before-frame", 0],
        ["error-after-frame", 1],
      ] as const) {
        model.plans.push({ mode });
        const node = await agent.ttsNode(
          new ReadableStream({
            start(controller) {
              controller.enqueue(`production ${mode}`);
              controller.close();
            },
          }),
          {},
        );
        const frames = [];
        const reader = node!.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          frames.push(next.value);
        }
        expect(frames).toHaveLength(frameCount);
        const failed = rows.filter((row) => row.event === "synthesis_terminal").at(-1);
        expect(failed).toMatchObject({ outcome: "failed", errorClass: "tts_provider_failed", frameCount });
      }
    } finally {
      call.abort();
      agent.dispose();
      trace.close("call_closed");
      await closeSession(session);
    }
  });

  it("preserves real default-node frames and timed transcript metadata", async () => {
    const model = new ControlledTTS();
    const session = new AgentSession({
      tts: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    const agent = new TracedTtsAgent(model);
    const metrics: Array<{ synthesisId: string | null }> = [];
    model.on("metrics_collected", (_metric) =>
      metrics.push({ synthesisId: capabilityContext.getStore()?.synthesisId ?? null }),
    );
    await startSession(session, agent);
    try {
      const source = new ReadableStream<string>({
        start(controller) {
          controller.enqueue("alpha");
          controller.enqueue("beta");
          controller.close();
        },
      });
      const stream = await agent.ttsNode(source, {});
      const reader = stream!.getReader();
      const frames = [];
      for (;;) {
        const row = await reader.read();
        if (row.done) break;
        frames.push(row.value);
      }
      await until(() => metrics.length === 1, "normal TTS metric");

      expect(frames).toHaveLength(2);
      expect(frames[0]).toBe(model.frames[0]);
      expect(frames[1]).toBe(model.frames[1]);
      expect(frames.map((frame) => frame.userdata[USERDATA_TIMED_TRANSCRIPT][0].text)).toEqual(["alpha", "beta"]);
      expect(metrics[0].synthesisId).toBe("synth-1");
    } finally {
      await closeSession(session);
    }
  });

  it("keeps before-frame and after-frame cancellation metric-free and unbound", async () => {
    const model = new ControlledTTS();
    const session = new AgentSession({
      tts: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    const agent = new TracedTtsAgent(model, "cancel-synth");
    const metrics: unknown[] = [];
    model.on("metrics_collected", (metric) => metrics.push(metric));
    await startSession(session, agent);
    try {
      const before = { mode: "hold-before-frame" as const, entered: gate(), release: gate() };
      model.plans.push(before);
      const beforeNode = await agent.ttsNode(
        new ReadableStream({
          start(controller) {
            controller.enqueue("before");
          },
        }),
        {},
      );
      const beforeReader = beforeNode!.getReader();
      const beforeRead = beforeReader.read();
      await before.entered.promise;
      await beforeReader.cancel("cancel before frame");
      await beforeRead.catch(() => {});
      await model.streams.at(-1)!.done.promise;
      expect(metrics).toHaveLength(0);

      const after = { mode: "hold-after-frame" as const, release: gate() };
      model.plans.push(after);
      const afterNode = await agent.ttsNode(
        new ReadableStream({
          start(controller) {
            controller.enqueue("after");
          },
        }),
        {},
      );
      const afterReader = afterNode!.getReader();
      const first = await afterReader.read();
      expect(first.value).toBe(model.frames.at(-1));
      await afterReader.cancel("cancel after frame");
      await model.streams.at(-1)!.done.promise;
      expect(metrics).toHaveLength(0);
    } finally {
      await closeSession(session);
    }
  });

  it("associates a genuine normal session TTS metric with its exact public handle", async () => {
    const model = new ControlledTTS();
    const output = new CaptureAudioOutput();
    const session = new AgentSession({
      tts: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    session.output.audio = output;
    const agent = new TracedTtsAgent(model, "normal-session-synth");
    const metrics: Array<{ speechId: string | null; synthesisId: string | null }> = [];
    session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics: metric }) => {
      if (metric.type === "tts_metrics") {
        metrics.push({
          speechId: metric.speechId ?? null,
          synthesisId: capabilityContext.getStore()?.synthesisId ?? null,
        });
      }
    });
    await startSession(session, agent);
    try {
      const handle = session.say("normal-session-metric");
      await handle.waitForPlayout();
      await until(() => metrics.length === 1, "real session TTS metric");
      expect(metrics[0]).toEqual({
        speechId: handle.id,
        synthesisId: "normal-session-synth-1",
      });
      expect(output.frames.length).toBeGreaterThan(0);
      expect(output.frames[0]).toBe(model.frames[0]);
    } finally {
      await closeSession(session);
    }
  });

  it("isolates two overlapping default-node errors that settle in reverse order", async () => {
    const model = new ControlledTTS();
    const left = { mode: "error-before-frame" as const, entered: gate(), release: gate() };
    const right = { mode: "error-before-frame" as const, entered: gate(), release: gate() };
    const observations: Array<{ event: string; synthesisId: string | null }> = [];
    model.on("error", () =>
      observations.push({
        event: "public_error",
        synthesisId: capabilityContext.getStore()?.synthesisId ?? null,
      }),
    );
    const session = new AgentSession({
      tts: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    const agent = new TracedTtsAgent(model, "overlap-synth");
    await startSession(session, agent);
    try {
      model.plans.push(
        { mode: "error-before-frame", entered: left.entered, release: left.release },
        { mode: "error-before-frame", entered: right.entered, release: right.release },
      );
      const start = async (text: string, synthesisId: string) => {
        const node = await agent.ttsNode(
          new ReadableStream({
            start(controller) {
              controller.enqueue(text);
              controller.close();
            },
          }),
          {},
        );
        const reader = node!.getReader();
        const terminal = (async () => {
          for (;;) {
            if ((await reader.read()).done) break;
          }
          observations.push({ event: "node_terminal", synthesisId });
        })();
        return { terminal };
      };
      const leftNode = await start("left", "overlap-synth-1");
      const rightNode = await start("right", "overlap-synth-2");
      await Promise.all([left.entered.promise, right.entered.promise]);
      right.release.resolve();
      await until(
        () => observations.some((event) => event.event === "public_error" && event.synthesisId === "overlap-synth-2"),
        "right synthesis error",
      );
      left.release.resolve();
      await Promise.all([leftNode.terminal, rightNode.terminal]);

      expect(observations.filter((event) => event.event === "public_error").map((event) => event.synthesisId)).toEqual([
        "overlap-synth-2",
        "overlap-synth-1",
      ]);
      for (const synthesisId of ["overlap-synth-1", "overlap-synth-2"]) {
        expect(
          observations.findIndex((event) => event.event === "public_error" && event.synthesisId === synthesisId),
        ).toBeLessThan(
          observations.findIndex((event) => event.event === "node_terminal" && event.synthesisId === synthesisId),
        );
      }
    } finally {
      await closeSession(session);
    }
  });

  it("latches a pending read cancellation before release and forwards no later frame", async () => {
    const events: string[] = [];
    const pullEntered = gate();
    const releasePull = gate();
    const upstream = new ReadableStream({
      async pull(controller) {
        pullEntered.resolve();
        await releasePull.promise;
        try {
          controller.enqueue(fixtureAudioFrame());
          controller.close();
        } catch {
          events.push("upstream_frame_rejected_after_cancel");
        }
      },
      cancel() {
        events.push("upstream_cancel");
      },
    });
    const reader = observeNodeForCancellation(upstream, events).getReader();
    const pendingRead = reader.read();
    await pullEntered.promise;
    const cancellation = reader.cancel("test cancellation race");
    await until(() => events.includes("cancel_latched"), "observer cancellation latch");
    releasePull.resolve();
    await cancellation;
    await pendingRead.catch(() => {});

    expect(events.indexOf("cancel_latched")).toBeLessThan(events.indexOf("reader_cancel"));
    expect(events.filter((event) => event === "forward_frame")).toHaveLength(0);
    expect(events.filter((event) => event === "cleanup")).toHaveLength(1);
    expect(events).toContain("upstream_cancel");
  });
});

describe("public speech and LLM lifecycle seams", () => {
  it("binds a real HiveLLM bridge turn to the exact handle from the genuine SDK metric", async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        formatSSETextChunk("chatcmpl-capability", "bound", "hive") + formatSSEDone("chatcmpl-capability", "hive"),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const callId = "call-capability-bridge";
    const { rows, trace } = traceHarness(callId);
    const model = new HiveLLM({
      bridgeUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      bridgeToken: "capability-token",
      hiveAgentId: "capability-agent",
      callId,
      goal: "offline capability",
      context: "test-only",
      trace,
    });
    const session = new AgentSession({ llm: model, vad: null, turnHandling: { turnDetection: null } });
    session.output.setAudioEnabled(false);
    session.on(AgentSessionEventTypes.MetricsCollected, (event) => trace.metrics(event));
    await startSession(session, new Agent({ instructions: "offline capability fixture" }));
    try {
      const handle = session.generateReply({ userInput: "bind this exact bridge" });
      await handle.waitForPlayout();
      await until(
        () => rows.some((row) => row.event === "bridge_bound" && row.speechId === handle.id),
        "HiveLLM bridge binding",
      );

      const created = rows.find((row) => row.event === "bridge_created")!;
      expect(created.turnId).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows.filter((row) => row.event === "bridge_bound")).toEqual([
        expect.objectContaining({ turnId: created.turnId, speechId: handle.id, source: "sdk_metrics_context" }),
      ]);
      expect(rows.filter((row) => row.event === "bridge_terminal")).toEqual([
        expect.objectContaining({ turnId: created.turnId, outcome: "completed", textLength: 5 }),
      ]);
      expect(rows.filter((row) => row.event === "sdk_metric" && row.turnId === created.turnId)).toEqual([
        expect.objectContaining({ speechId: handle.id, metric: "llm", source: "sdk_metrics_context" }),
      ]);
    } finally {
      await closeSession(session);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exposes handle-owned settlement and item evidence without awaiting the thenable directly", async () => {
    const llm = new ControlledLLM();
    llm.plans.push({ turnId: "public-handle", text: "handled" });
    const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
    session.output.setAudioEnabled(false);
    await startSession(session, new Agent({ instructions: "offline capability fixture" }));
    try {
      const { handle } = { handle: session.generateReply({ userInput: "handle surface" }) };
      let removedCalled = false;
      let doneCalled = false;
      const removed = () => {
        removedCalled = true;
      };
      handle.addDoneCallback(removed);
      handle.removeDoneCallback(removed);
      handle.addDoneCallback(() => {
        doneCalled = true;
      });
      await handle.waitForPlayout();

      expect(handle.id).toMatch(/^speech_/);
      expect(handle.done()).toBe(true);
      expect(handle.interrupted).toBe(false);
      expect(handle.exception() ?? null).toBeNull();
      expect(handle.chatItems.some((item) => item.type === "message")).toBe(true);
      expect(doneCalled).toBe(true);
      expect(removedCalled).toBe(false);
      expect(typeof handle.then).toBe("function");
    } finally {
      await closeSession(session);
    }
  });

  it("interrupts only a retained stale handle and lets its replacement settle", async () => {
    const llm = new ControlledLLM();
    const firstRelease = gate();
    llm.plans.push(
      { turnId: "replacement-old", text: "old", holdBeforeText: firstRelease },
      { turnId: "replacement-new", text: "new" },
    );
    const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
    session.output.setAudioEnabled(false);
    const metrics: Array<{ speechId: string | null; turnId: string | null }> = [];
    session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics: metric }) => {
      if (metric.type === "llm_metrics") {
        metrics.push({
          speechId: metric.speechId ?? null,
          turnId: capabilityContext.getStore()?.turnId ?? null,
        });
      }
    });
    await startSession(session, new Agent({ instructions: "offline capability fixture" }));
    try {
      const first = session.generateReply();
      await llm.streams[0].entered.promise;
      first.interrupt();
      const second = session.generateReply({ userInput: "replacement" });
      await llm.streams[1].entered.promise;
      await Promise.all([first.waitForPlayout(), second.waitForPlayout()]);
      await until(() => metrics.length === 2, "replacement metrics");

      expect(first.interrupted).toBe(true);
      expect(second.interrupted).toBe(false);
      expect(metrics).toEqual([
        { speechId: first.id, turnId: "replacement-old" },
        { speechId: second.id, turnId: "replacement-new" },
      ]);
    } finally {
      firstRelease.resolve();
      await closeSession(session);
    }
  });

  it("observes an application bridge error before public error, metric, and handle settlement", async () => {
    const llm = new ControlledLLM();
    const failure = gate();
    llm.plans.push({ turnId: "owned-error", fail: true, holdBeforeText: failure });
    const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
    session.output.setAudioEnabled(false);
    llm.on("error", () =>
      llm.events.push({
        event: "public_error",
        turnId: capabilityContext.getStore()?.turnId ?? null,
      }),
    );
    let metricSpeechId: string | null = null;
    session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics: metric }) => {
      if (metric.type === "llm_metrics") {
        metricSpeechId = metric.speechId ?? null;
        llm.events.push({
          event: "metric",
          turnId: capabilityContext.getStore()?.turnId ?? null,
        });
      }
    });
    await startSession(session, new Agent({ instructions: "offline capability fixture" }));
    try {
      const handle = session.generateReply();
      handle.addDoneCallback(() => llm.events.push({ event: "handle_done", turnId: "owned-error" }));
      await llm.streams[0].entered.promise;
      failure.resolve();
      await handle.waitForPlayout();
      await until(() => llm.events.some((event) => event.event === "handle_done"), "handle done");

      const order = ["application_error", "public_error", "metric", "handle_done"].map((event) =>
        llm.events.findIndex((row) => row.event === event),
      );
      expect(order).toEqual([...order].sort((left, right) => left - right));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(metricSpeechId).toBe(handle.id);
      expect(handle.exception() ?? null).toBeNull();
    } finally {
      await closeSession(session);
    }
  });

  it("reports public false-interruption recovery on the original handle", async () => {
    const llm = new ControlledLLM();
    const release = gate();
    llm.plans.push({
      turnId: "false-interruption",
      text: "Resume candidate.",
      holdAfterText: release,
    });
    const sttModel = new ScriptedSTT();
    const vadModel = new ScriptedVAD();
    const input = new PushAudioInput();
    const output = new CaptureAudioOutput();
    const session = new AgentSession({
      stt: sttModel,
      llm,
      tts: new ControlledTTS(),
      vad: vadModel,
      aecWarmupDuration: null,
      turnHandling: {
        turnDetection: "vad",
        interruption: {
          mode: "vad",
          minDuration: 0,
          minWords: 0,
          falseInterruptionTimeout: 20,
          resumeFalseInterruption: true,
        },
      },
    });
    session.input.audio = input;
    session.output.audio = output;
    const falseInterruptions: Array<{ resumed: boolean }> = [];
    session.on(AgentSessionEventTypes.AgentFalseInterruption, ({ resumed }) => falseInterruptions.push({ resumed }));
    await startSession(session, new Agent({ instructions: "offline capability fixture" }));
    try {
      const speech = await sttModel.ready.promise;
      const vad = await vadModel.ready.promise;
      const handle = session.generateReply({ userInput: "resume candidate" });
      await until(() => output.frames.length > 0, "resume candidate output");
      input.push();
      vad.emit(vadEvent(VADEventType.START_OF_SPEECH));
      speech.emit(transcript(stt.SpeechEventType.INTERIM_TRANSCRIPT, ""));
      vad.emit(vadEvent(VADEventType.INFERENCE_DONE));
      vad.emit(vadEvent(VADEventType.END_OF_SPEECH));
      await until(() => falseInterruptions.length === 1, "false interruption event");
      release.resolve();
      await handle.waitForPlayout();

      expect(falseInterruptions).toEqual([{ resumed: true }]);
      expect(handle.id).toMatch(/^speech_/);
      expect(handle.done()).toBe(true);
      expect(handle.interrupted).toBe(false);
    } finally {
      release.resolve();
      input.finish();
      await closeSession(session);
    }
  });
});

class AttemptRegistry {
  readonly attempts = new Map<
    string,
    {
      synthesisId: string;
      speechId: string | null;
      terminal: { outcome: string; reason: string } | null;
      supplements: Array<{ event: string; speechId: string }>;
    }
  >();

  start(synthesisId: string): void {
    this.attempts.set(synthesisId, {
      synthesisId,
      speechId: null,
      terminal: null,
      supplements: [],
    });
  }

  metric(synthesisId: string, speechId: string): void {
    const attempt = this.attempts.get(synthesisId)!;
    attempt.speechId = speechId;
    attempt.supplements.push({
      event: attempt.terminal ? "late_binding" : "binding",
      speechId,
    });
  }

  error(synthesisId: string): void {
    const attempt = this.attempts.get(synthesisId)!;
    attempt.terminal ??= { outcome: "failed", reason: "application_error" };
  }

  eof(synthesisId: string): void {
    const attempt = this.attempts.get(synthesisId)!;
    attempt.terminal ??= attempt.speechId
      ? { outcome: "completed", reason: "metric_before_eof" }
      : { outcome: "incomplete", reason: "reader_eof_without_metric" };
  }
}

describe("test-local attempt bookkeeping", () => {
  it("preserves four late, unavailable, failed, and bound attempts without rewriting terminals", () => {
    const registry = new AttemptRegistry();
    for (const id of ["late-bound", "unavailable", "error-then-late", "bound-before-eof"]) {
      registry.start(id);
    }
    registry.eof("late-bound");
    registry.metric("late-bound", "speech-late");
    registry.eof("unavailable");
    registry.error("error-then-late");
    registry.eof("error-then-late");
    registry.metric("error-then-late", "speech-error-late");
    registry.metric("bound-before-eof", "speech-bound");
    registry.eof("bound-before-eof");

    expect(
      [...registry.attempts.values()].map((attempt) => [
        attempt.synthesisId,
        attempt.speechId,
        attempt.terminal!.outcome,
      ]),
    ).toEqual([
      ["late-bound", "speech-late", "incomplete"],
      ["unavailable", null, "incomplete"],
      ["error-then-late", "speech-error-late", "failed"],
      ["bound-before-eof", "speech-bound", "completed"],
    ]);
    expect(registry.attempts.get("late-bound")!.supplements[0].event).toBe("late_binding");
    expect(registry.attempts.get("error-then-late")!.terminal!.outcome).toBe("failed");
  });
});

type OrderingMode = "stt" | "vad";
type AnswerAt = "speaking" | "final" | "listening" | "accepted";

async function runOrderingCase(
  mode: OrderingMode,
  preemptive: boolean,
  preflight = false,
  answerAt: AnswerAt = "speaking",
) {
  const events: string[] = [];
  const created: Array<ReturnType<AgentSession["generateReply"]>> = [];
  const input = new PushAudioInput();
  const output = new CaptureAudioOutput(events);
  const sttModel = new ScriptedSTT();
  const vadModel = mode === "vad" ? new ScriptedVAD() : null;
  const llm = new ControlledLLM();
  llm.plans.push({ turnId: `ordering-${mode}-${answerAt}`, text: "Hello." });
  const hookRelease = gate();
  const session = new AgentSession({
    llm,
    stt: sttModel,
    tts: new ControlledTTS(),
    vad: vadModel,
    aecWarmupDuration: null,
    turnHandling: {
      turnDetection: mode,
      preemptiveGeneration: { enabled: preemptive, preemptiveTts: false },
    },
  });
  session.input.audio = input;
  session.output.audio = output;
  const startup = new StartupObserver(session, events);
  class Hook extends Agent {
    override async onUserTurnCompleted(_ctx: ChatContext, message: ChatMessage): Promise<void> {
      events.push("accepted_hook_enter");
      startup.accept(message.textContent ?? "");
      if (answerAt === "accepted") startup.answer();
      await hookRelease.promise;
      events.push("accepted_hook_return");
    }
  }
  session.on(AgentSessionEventTypes.UserStateChanged, ({ newState }) => {
    startup.onUserState(newState);
    if (answerAt === "listening" && newState === "listening") startup.answer();
  });
  session.on(AgentSessionEventTypes.UserInputTranscribed, ({ transcript: text, isFinal }) => {
    startup.onTranscript(text, isFinal);
    events.push("transcript_observed");
  });
  session.on(AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => {
    created.push(speechHandle);
    events.push("speech_created");
  });
  await startSession(session, new Hook({ instructions: "offline capability fixture" }));
  try {
    const speech = await sttModel.ready.promise;
    const vad = vadModel ? await vadModel.ready.promise : null;
    input.push();
    if (vad) vad.emit(vadEvent(VADEventType.START_OF_SPEECH));
    else speech.emit({ type: stt.SpeechEventType.START_OF_SPEECH });
    await until(() => startup.speaking, "public speaking state");
    if (answerAt === "speaking") startup.answer();
    if (preflight) {
      speech.emit(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT));
      await until(() => llm.streams.length === 1, "preflight speculative stream");
    }
    speech.emit(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT));
    await until(() => events.includes("final_transcript"), "public final transcript");
    if (answerAt === "final") startup.answer();
    if (vad) vad.emit(vadEvent(VADEventType.END_OF_SPEECH));
    else speech.emit({ type: stt.SpeechEventType.END_OF_SPEECH });
    await until(() => events.includes("accepted_hook_enter"), "accepted hook");
    expect(output.frames).toHaveLength(0);
    hookRelease.resolve();
    await until(() => output.frames.length > 0, "accepted response output");
    await Promise.all(created.map((handle) => handle.waitForPlayout()));
    return { events, created, startup, output };
  } finally {
    startup.close();
    hookRelease.resolve();
    input.finish();
    await closeSession(session);
  }
}

async function runPendingInputCase(
  mode: OrderingMode,
  kind: "absent" | "interim" | "empty-final" | "preflight",
  delayedFinal = false,
) {
  const events: string[] = [];
  const created: Array<ReturnType<AgentSession["generateReply"]>> = [];
  const input = new PushAudioInput();
  const output = new CaptureAudioOutput(events);
  const sttModel = new ScriptedSTT();
  const vadModel = mode === "vad" ? new ScriptedVAD() : null;
  const llm = new ControlledLLM();
  const openingRelease = gate();
  if (kind === "preflight") {
    llm.plans.push({ turnId: `${mode}-${kind}-speculative`, text: "speculative" });
  }
  llm.plans.push({
    turnId: `${mode}-${kind}-opening`,
    text: "opening",
    holdBeforeText: delayedFinal ? openingRelease : undefined,
  });
  if (delayedFinal) {
    llm.plans.push({ turnId: `${mode}-${kind}-replacement`, text: "replacement" });
  }
  const session = new AgentSession({
    llm,
    stt: sttModel,
    tts: new ControlledTTS(),
    vad: vadModel,
    aecWarmupDuration: null,
    turnHandling: {
      turnDetection: mode,
      preemptiveGeneration: { enabled: true, preemptiveTts: false },
    },
  });
  session.input.audio = input;
  session.output.audio = output;
  const startup = new StartupObserver(session, events);
  class Hook extends Agent {
    override async onUserTurnCompleted(_ctx: ChatContext, message: ChatMessage): Promise<void> {
      events.push("accepted_hook_enter");
      startup.accept(message.textContent ?? "");
    }
  }
  session.on(AgentSessionEventTypes.UserStateChanged, ({ newState }) => startup.onUserState(newState));
  session.on(AgentSessionEventTypes.UserInputTranscribed, ({ transcript: text, isFinal }) =>
    startup.onTranscript(text, isFinal),
  );
  session.on(AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => {
    created.push(speechHandle);
    events.push("speech_created");
  });
  await startSession(session, new Hook({ instructions: "offline capability fixture" }));
  try {
    const speech = await sttModel.ready.promise;
    const vad = vadModel ? await vadModel.ready.promise : null;
    input.push();
    if (vad) vad.emit(vadEvent(VADEventType.START_OF_SPEECH));
    else speech.emit({ type: stt.SpeechEventType.START_OF_SPEECH });
    await until(() => startup.speaking, "startup speaking state");
    startup.answer();
    if (kind === "interim" || kind === "preflight") {
      speech.emit(
        transcript(
          kind === "interim" ? stt.SpeechEventType.INTERIM_TRANSCRIPT : stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
        ),
      );
      await until(() => events.includes("provisional_transcript"), "provisional transcript");
    } else if (kind === "empty-final") {
      speech.emit(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT, ""));
    }
    if (vad) vad.emit(vadEvent(VADEventType.END_OF_SPEECH));
    else speech.emit({ type: stt.SpeechEventType.END_OF_SPEECH });
    await until(() => startup.openingRequested, "listening releases provisional hold");
    if (delayedFinal) {
      await until(
        () => llm.streams.some((stream) => stream.plan.holdBeforeText === openingRelease),
        "held opening stream",
      );
      speech.emit(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT));
      await until(() => startup.accepted, "delayed final accepted");
      expect(startup.opening!.interrupted).toBe(true);
    }
    await until(() => output.frames.length > 0, "startup output progresses");
    if (!delayedFinal) await startup.opening!.waitForPlayout();
    else await Promise.all(created.map((handle) => handle.waitForPlayout()));
    return { events, created, startup, output };
  } finally {
    startup.close();
    openingRelease.resolve();
    input.finish();
    await closeSession(session);
  }
}

describe("22 public startup observer cases", () => {
  it.each([
    ["stt", true, false],
    ["vad", true, false],
    ["vad", false, false],
    ["stt", true, true],
  ] as const)(
    "orders final input, accepted admission, and output for %s/preemptive=%s/preflight=%s",
    async (mode, preemptive, preflight) => {
      const { events, created, startup, output } = await runOrderingCase(mode, preemptive, preflight);
      const speculative = preemptive && (mode === "vad" || preflight);
      expect(events.indexOf("speech_created") < events.indexOf("accepted_hook_enter")).toBe(speculative);
      expect(events.indexOf("output_frame")).toBeGreaterThan(events.indexOf("accepted_hook_return"));
      expect(events.indexOf("user_state_listening")).toBeLessThan(events.indexOf("accepted_hook_enter"));
      expect(startup.openingRequested).toBe(false);
      expect(created).toHaveLength(1);
      expect(output.frames.length).toBeGreaterThan(0);
    },
  );

  it.each([
    ["stt", "final"],
    ["stt", "listening"],
    ["stt", "accepted"],
    ["vad", "final"],
    ["vad", "listening"],
    ["vad", "accepted"],
  ] as const)("suppresses an opening for %s when answer is observed at %s", async (mode, answerAt) => {
    const { startup, output } = await runOrderingCase(mode, true, false, answerAt);
    expect(startup.openingRequested).toBe(false);
    expect(startup.accepted).toBe(true);
    expect(output.frames.length).toBeGreaterThan(0);
  });

  it.each([
    ["stt", "absent"],
    ["stt", "interim"],
    ["stt", "empty-final"],
    ["stt", "preflight"],
    ["vad", "absent"],
    ["vad", "interim"],
    ["vad", "empty-final"],
    ["vad", "preflight"],
  ] as const)("releases %s %s input at listening", async (mode, kind) => {
    const { events, startup, output } = await runPendingInputCase(mode, kind);
    expect(events.filter((event) => event === "request_opening")).toHaveLength(1);
    expect(events.indexOf("request_opening")).toBeGreaterThan(events.indexOf("user_state_listening"));
    expect(startup.pendingFinal).toBe(false);
    expect(startup.accepted).toBe(false);
    expect(output.frames.length).toBeGreaterThan(0);
  });

  it.each([
    ["stt", "absent"],
    ["stt", "interim"],
    ["vad", "absent"],
    ["vad", "interim"],
  ] as const)("interrupts the owned %s %s opening when final input arrives later", async (mode, kind) => {
    const { events, startup, output } = await runPendingInputCase(mode, kind, true);
    expect(events.filter((event) => event === "request_opening")).toHaveLength(1);
    expect(events).toContain("accepted_hook_enter");
    expect(events.includes("cancel_owned_opening") || events.includes("owned_opening_already_interrupted")).toBe(true);
    expect(startup.opening!.interrupted).toBe(true);
    expect(startup.accepted).toBe(true);
    expect(output.frames.length).toBeGreaterThan(0);
  });
});
