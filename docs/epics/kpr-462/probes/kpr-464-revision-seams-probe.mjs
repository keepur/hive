import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtimeRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../../", import.meta.url)));
const {
  Agent, AgentSession, AgentSessionEventTypes, AudioInput, AudioOutput,
  DEFAULT_API_CONNECT_OPTIONS, LLM, LLMStream, VAD, VADEventType, VADStream,
  initializeLogger, stt, tts, USERDATA_TIMED_TRANSCRIPT,
} = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@livekit/agents/dist/index.js")).href);
const { AudioFrame } = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@livekit/rtc-node/dist/index.js")).href);
initializeLogger({ pretty: false, level: "silent" });
const als = new AsyncLocalStorage();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, label) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await pause(2); }
  throw new Error(`timeout: ${label}`);
}
const frame = () => new AudioFrame(new Int16Array(480), 24000, 1, 480);

class Input extends AudioInput {
  constructor() { super(); this.readable = new ReadableStream({ start: (c) => { this.controller = c; } }); }
  get stream() { return this.readable; }
  finish() { this.controller.close(); }
}
class Output extends AudioOutput {
  constructor(events) { super(24000); this.events = events; this.frames = []; }
  async captureFrame(value) { await super.captureFrame(value); this.frames.push(value); this.events.push("output_frame"); this.onPlaybackStarted(Date.now()); }
  flush() { super.flush(); this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false }); }
  clearBuffer() { this.onPlaybackFinished({ playbackPosition: 0, interrupted: true }); }
}
class SttStream extends stt.SpeechStream {
  async run() { await new Promise((r) => this.abortSignal.addEventListener("abort", r, { once: true })); }
  emit(event) { this.queue.put(event); }
}
class Stt extends stt.STT {
  constructor() { super({ streaming: true, interimResults: true }); this.label = "revision-fake-stt"; this.ready = Promise.withResolvers(); }
  stream() { const s = new SttStream(this); this.ready.resolve(s); return s; }
}
class VadStream extends VADStream { emit(event) { this.sendVADEvent(event); } }
class Vad extends VAD {
  constructor() { super({ updateInterval: 1000 }); this.label = "revision-fake-vad"; this.ready = Promise.withResolvers(); }
  stream() { const s = new VadStream(this); this.ready.resolve(s); return s; }
}
function vadEvent(type) {
  return { type, samplesIndex: 0, timestamp: Date.now(), speechDuration: 20, silenceDuration: 20,
    frames: [], probability: type === VADEventType.START_OF_SPEECH ? 1 : 0, inferenceDuration: 0,
    speaking: type !== VADEventType.END_OF_SPEECH, rawAccumulatedSilence: 0, rawAccumulatedSpeech: 0 };
}
function transcript(type) { return { type, alternatives: [{ text: "hello", language: "en", startTime: 0, endTime: 0.02, confidence: 1 }] }; }

class TextStream extends LLMStream {
  constructor(owner, opts) { super(owner, opts); this.owner = owner; this.holdText = owner.holdText; }
  async run() {
    if (this.holdText) {
      this.owner.events.push("llm_waiting_for_test_release");
      await Promise.race([this.holdText.promise, new Promise((r) => {
        if (this.abortController.signal.aborted) r();
        else this.abortController.signal.addEventListener("abort", r, { once: true });
      })]);
      if (this.abortController.signal.aborted) return;
    }
    if (this.owner.fail) {
      // Application-owned run() sees the cause before handing it to SDK error handling.
      this.owner.observations.push({ event: "application_error", trace: als.getStore() ?? null });
      throw new Error("synthetic bridge failure");
    }
    this.owner.events.push("llm_text");
    this.queue.put({ id: "fake-request", delta: { role: "assistant", content: "Hello." } });
  }
}
class TextModel extends LLM {
  constructor(events, fail = false) { super(); this.events = events; this.fail = fail; this.observations = []; }
  label() { return "revision-fake-llm"; }
  chat({ chatCtx, toolCtx, connOptions = DEFAULT_API_CONNECT_OPTIONS }) {
    return als.run({ turnId: "revision-turn" }, () => new TextStream(this, { chatCtx, toolCtx, connOptions: { ...connOptions, maxRetry: 0 } }));
  }
}
class SynthStream extends tts.SynthesizeStream {
  constructor(owner) { super(owner); this.owner = owner; }
  async run() {
    for await (const value of this.input) {
      if (typeof value !== "string") return;
      this.markStarted();
      const behavior = this.owner.behavior?.(value) ?? { mode: this.owner.mode };
      behavior.entered?.resolve();
      if (behavior.release) await behavior.release.promise;
      if (behavior.mode === "error-before") throw new Error("synthetic TTS failure before frame");
      const original = frame(); this.owner.frames.push(original);
      this.queue.put({ frame: original, requestId: "fake-tts", final: true, timedTranscripts: [{ text: value, startTime: 0, endTime: 0.02 }] });
      if (behavior.mode === "error-after") throw new Error("synthetic TTS failure after frame");
    }
  }
}
class Synth extends tts.TTS {
  constructor(mode = "normal") { super(24000, 1, { streaming: true }); this.label = "revision-fake-tts"; this.mode = mode; this.frames = []; }
  synthesize() { throw new Error("streaming only"); }
  stream() { return new SynthStream(this); }
}

class TracedTtsAgent extends Agent {
  constructor(ttsModel, prefix = "session-synth") {
    super({ instructions: "offline probe", tts: ttsModel });
    this.prefix = prefix;
    this.invocations = [];
  }
  async ttsNode(text, modelSettings) {
    const synthesisId = `${this.prefix}-${this.invocations.length + 1}`;
    this.invocations.push({ synthesisId, invocationTrace: als.getStore() ?? null });
    return als.run({ synthesisId }, () => Agent.default.ttsNode(this, text, modelSettings));
  }
}

async function ttsSessionMetricCase() {
  const model = new Synth(), events = [];
  const session = new AgentSession({ tts: model, vad: null, turnHandling: { turnDetection: null } });
  const agent = new TracedTtsAgent(model, "normal-session-synth");
  const output = new Output(events);
  session.output.audio = output;
  session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
    if (metrics.type === "tts_metrics") events.push({
      event: "tts_metrics", speechId: metrics.speechId ?? null,
      synthesisId: als.getStore()?.synthesisId ?? null,
    });
  });
  try {
    await session.start({ agent });
    const handle = session.say("normal-session-metric");
    await handle.waitForPlayout();
    await until(() => events.some((event) => event.event === "tts_metrics"), "real-session normal TTS metric");
    const metric = events.find((event) => event.event === "tts_metrics");
    assert.equal(metric.speechId, handle.id, "real session TTS metric supplies its SDK SpeechHandle ID");
    assert.equal(metric.synthesisId, agent.invocations[0].synthesisId, "real session TTS metric retains the default-node ALS synthesis ID");
    return { handleId: handle.id, synthesisId: agent.invocations[0].synthesisId, metric, outputFrames: output.frames.length };
  } finally { await session.close(); }
}

// Test-local orchestration only. No clock/timeout decides whether an opening is
// needed, and no caller speech handle is inferred from ordering or transcript.
class StartupObserver {
  constructor(session, events) {
    this.session = session; this.events = events;
    this.answered = false; this.speaking = false; this.pendingFinal = false;
    this.accepted = false; this.openingRequested = false; this.terminal = false;
    session.on(AgentSessionEventTypes.UserStateChanged, ({ newState }) => {
      events.push(`user_state_${newState}`);
      this.speaking = newState === "speaking";
      this.evaluate();
    });
    session.on(AgentSessionEventTypes.UserInputTranscribed, ({ transcript, isFinal }) => {
      events.push(isFinal ? "final_transcript" : "provisional_transcript");
      if (isFinal && transcript.trim()) this.pendingFinal = true;
    });
  }
  answer() { this.answered = true; this.events.push("answer_observed"); this.evaluate(); }
  accept(message) {
    if (!message.textContent?.trim() || this.terminal) return;
    this.accepted = true; this.pendingFinal = false;
    this.events.push("startup_caller_accepted");
    if (this.opening?.interrupted) this.events.push("owned_opening_already_interrupted");
    else if (this.opening && !this.opening.done()) {
      this.events.push("cancel_owned_opening"); this.opening.interrupt();
    }
  }
  evaluate() {
    if (this.terminal || !this.answered || this.accepted || this.openingRequested || this.speaking) return;
    if (this.pendingFinal) { this.events.push("defer_pending_final"); return; }
    this.openingRequested = true; this.events.push("request_opening");
    this.opening = this.session.generateReply();
  }
  close() { this.terminal = true; }
}

async function orderingCase(mode, preemptive, preflight = false, answerAt = "speaking") {
  const events = [], created = [];
  const input = new Input(), output = new Output(events), sttModel = new Stt(), vadModel = mode === "vad" ? new Vad() : null;
  const llm = new TextModel(events);
  const hookRelease = Promise.withResolvers();
  let startup;
  class Hook extends Agent {
    async onUserTurnCompleted(_ctx, message) {
      assert.ok(message.textContent);
      events.push("accepted_hook_enter");
      startup.accept(message);
      if (answerAt === "accepted") startup.answer();
      await hookRelease.promise;
      events.push("accepted_hook_return");
    }
  }
  const session = new AgentSession({ llm, stt: sttModel, tts: new Synth(), vad: vadModel, aecWarmupDuration: null,
    turnHandling: { turnDetection: mode, preemptiveGeneration: { enabled: preemptive, preemptiveTts: false } } });
  session.input.audio = input; session.output.audio = output;
  session.on(AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => { created.push(speechHandle); events.push("speech_created"); });
  session.on(AgentSessionEventTypes.UserInputTranscribed, () => events.push("transcript_observed"));
  startup = new StartupObserver(session, events);
  if (answerAt === "listening") session.on(AgentSessionEventTypes.UserStateChanged, ({ newState }) => {
    if (newState === "listening") startup.answer();
  });
  try {
    await session.start({ agent: new Hook({ instructions: "offline probe" }) });
    const speech = await sttModel.ready.promise;
    const vad = vadModel ? await vadModel.ready.promise : null;
    input.controller.enqueue(new AudioFrame(new Int16Array(160), 16000, 1, 160));
    if (vad) vad.emit(vadEvent(VADEventType.START_OF_SPEECH));
    else speech.emit({ type: stt.SpeechEventType.START_OF_SPEECH });
    await until(() => startup.speaking, "public speaking before modeled answer");
    if (answerAt === "speaking") startup.answer();
    if (preflight) { speech.emit(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT)); await until(() => events.includes("llm_text"), "preflight speculative text"); }
    speech.emit(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT));
    await until(() => events.includes("transcript_observed"), "final transcript observed");
    // In the preflight fixture the first transcript observation is provisional;
    // this check needs the public final event itself.
    await until(() => events.includes("final_transcript"), "public final transcript");
    if (answerAt === "final") startup.answer();
    if (mode === "vad" && preemptive) await until(() => events.includes("llm_text"), "VAD speculative text before EOU");
    if (vad) vad.emit(vadEvent(VADEventType.END_OF_SPEECH));
    else speech.emit({ type: stt.SpeechEventType.END_OF_SPEECH });
    await until(() => events.includes("accepted_hook_enter"), "accepted hook");
    assert.equal(output.frames.length, 0, "response output waits for accepted hook return");
    hookRelease.resolve();
    await until(() => output.frames.length > 0, "accepted response output");
    await Promise.all(created.map((h) => h.waitForPlayout()));
    const speculative = preemptive && (mode === "vad" || preflight);
    assert.equal(events.indexOf("speech_created") < events.indexOf("accepted_hook_enter"), speculative);
    assert.equal(events.indexOf("llm_text") < events.indexOf("accepted_hook_enter"), speculative);
    assert.ok(events.indexOf("output_frame") > events.indexOf("accepted_hook_return"));
    assert.ok(events.indexOf("user_state_listening") < events.indexOf("accepted_hook_enter"));
    if (answerAt !== "accepted") assert.ok(events.includes("defer_pending_final"), "listening preserves final input awaiting the accepted hook");
    assert.equal(startup.openingRequested, false, "pending final suppresses the optional opening through acceptance");
    return { mode, preemptive, preflight, answerAt, events, handleCount: created.length, outputFrames: output.frames.length, openingRequested: startup.openingRequested };
  } finally { startup.close(); hookRelease.resolve(); input.finish(); await session.close(); }
}

async function pendingInputCase(mode, transcriptKind, delayedFinal = false) {
  const events = [], created = [];
  const input = new Input(), output = new Output(events), sttModel = new Stt(), vadModel = mode === "vad" ? new Vad() : null;
  const llm = new TextModel(events), openingTextRelease = Promise.withResolvers();
  const providerErrors = [];
  llm.on("error", (error) => providerErrors.push(error));
  if (delayedFinal) llm.holdText = openingTextRelease;
  let startup;
  class Hook extends Agent {
    async onUserTurnCompleted(_ctx, message) { events.push("accepted_hook_enter"); startup.accept(message); }
  }
  const session = new AgentSession({ llm, stt: sttModel, tts: new Synth(), vad: vadModel, aecWarmupDuration: null,
    turnHandling: { turnDetection: mode, preemptiveGeneration: { enabled: true, preemptiveTts: false } } });
  session.input.audio = input; session.output.audio = output;
  startup = new StartupObserver(session, events);
  session.on(AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => { created.push(speechHandle); events.push("speech_created"); });
  try {
    await session.start({ agent: new Hook({ instructions: "offline probe" }) });
    const speech = await sttModel.ready.promise, vad = vadModel ? await vadModel.ready.promise : null;
    input.controller.enqueue(new AudioFrame(new Int16Array(160), 16000, 1, 160));
    if (vad) vad.emit(vadEvent(VADEventType.START_OF_SPEECH));
    else speech.emit({ type: stt.SpeechEventType.START_OF_SPEECH });
    await until(() => startup.speaking, "startup speaking");
    startup.answer();
    if (transcriptKind === "interim" || transcriptKind === "preflight") {
      speech.emit(transcript(transcriptKind === "interim" ? stt.SpeechEventType.INTERIM_TRANSCRIPT : stt.SpeechEventType.PREFLIGHT_TRANSCRIPT));
      await until(() => events.includes("provisional_transcript"), "provisional transcript");
    } else if (transcriptKind === "empty-final") {
      const empty = transcript(stt.SpeechEventType.FINAL_TRANSCRIPT); empty.alternatives[0].text = ""; speech.emit(empty);
    }
    if (vad) vad.emit(vadEvent(VADEventType.END_OF_SPEECH));
    else speech.emit({ type: stt.SpeechEventType.END_OF_SPEECH });
    await until(() => startup.openingRequested, "no-final listening releases provisional hold");
    assert.equal(startup.pendingFinal, false);
    assert.equal(startup.accepted, false);
    assert.ok(events.indexOf("request_opening") > events.indexOf("user_state_listening"));
    if (delayedFinal) {
      await until(() => events.includes("llm_waiting_for_test_release"), "opening generation held before text");
      assert.equal(output.frames.length, 0, "test gate holds opening text and audio before delayed input");
      llm.holdText = null;
      speech.emit(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT));
      await until(() => startup.accepted, "late final reaches accepted hook");
      assert.ok(events.includes("cancel_owned_opening") || events.includes("owned_opening_already_interrupted"));
      assert.equal(startup.opening.interrupted, true);
    }
    await until(() => output.frames.length > 0, "startup output progresses");
    if (delayedFinal) assert.ok(events.indexOf("output_frame") > events.indexOf("startup_caller_accepted"), "replacement output follows accepted startup ownership");
    // Only scheduled handles are awaited: a preflight-only handle has no final
    // turn to admit it; session.close() below cancels that speculative work.
    if (!delayedFinal) await startup.opening.waitForPlayout();
    else await Promise.all(created.map((handle) => handle.waitForPlayout()));
    assert.equal(events.filter((event) => event === "request_opening").length, 1);
    assert.equal(events.filter((event) => event === "final_transcript").length, delayedFinal ? 1 : 0);
    assert.deepEqual(providerErrors, [], "startup progression must not rely on a swallowed provider failure");
    return { mode, transcriptKind, delayedFinal, events, openingRequested: startup.openingRequested,
      callerAccepted: startup.accepted, openingInterrupted: startup.opening.interrupted,
      outputFrames: output.frames.length, handleCount: created.length,
      configuredTranscriptionTimeout: session.sessionOptions.transcriptionTimeout };
  } finally { startup.close(); openingTextRelease.resolve(); input.finish(); await session.close(); }
}

async function llmErrorCase() {
  const llm = new TextModel([], true), observations = llm.observations;
  const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
  llm.on("error", () => observations.push({ event: "public_error", trace: als.getStore() ?? null }));
  session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
    if (metrics.type === "llm_metrics") observations.push({ event: "metric", speechId: metrics.speechId, trace: als.getStore() ?? null });
  });
  try {
    await session.start({ agent: new Agent({ instructions: "offline probe" }) });
    const handle = session.generateReply();
    handle.addDoneCallback(() => observations.push({ event: "handle_done" }));
    await handle.waitForPlayout();
    assert.equal(handle.exception() ?? null, null);
    assert.equal(observations[0].event, "application_error");
    assert.equal(observations[0].trace.turnId, "revision-turn");
    assert.equal(observations.find((o) => o.event === "public_error").trace.turnId, "revision-turn");
    assert.ok(observations.findIndex((o) => o.event === "handle_done") > observations.findIndex((o) => o.event === "application_error"));
    assert.equal(observations.find((o) => o.event === "metric").speechId, handle.id);
    return { observations, exception: handle.exception() ?? null, applicationOutcome: "failed" };
  } finally { await session.close(); }
}

async function ttsErrorCase(mode) {
  const model = new Synth(mode), observations = [], synthesisId = `revision-synth-${mode}`;
  let observedFailure = false;
  model.on("error", () => {
    const trace = als.getStore() ?? null;
    observations.push({ event: "public_error", trace });
    if (trace?.synthesisId === synthesisId) observedFailure = true;
  });
  const session = new AgentSession({ tts: model, vad: null, turnHandling: { turnDetection: null } });
  const agent = new Agent({ instructions: "offline probe" });
  try {
    await session.start({ agent });
    const source = new ReadableStream({ start(c) { c.enqueue("Hello."); c.close(); } });
    const stream = await als.run({ synthesisId }, () => Agent.default.ttsNode(agent, source, {}));
    // Test-local transparent observer: one read per pull, no extra utterance queue.
    const upstream = stream.getReader(), frames = [];
    const observed = new ReadableStream({
      async pull(controller) {
        const next = await upstream.read();
        if (next.done) { observations.push({ event: "node_terminal", outcome: observedFailure ? "failed" : "completed" }); controller.close(); upstream.releaseLock(); }
        else { frames.push(next.value); controller.enqueue(next.value); }
      },
      async cancel(reason) { try { await upstream.cancel(reason); } finally { upstream.releaseLock(); } },
    }, { highWaterMark: 0 });
    const reader = observed.getReader();
    while (!(await reader.read()).done) {}
    assert.equal(observations[0].event, "public_error");
    assert.equal(observations[0].trace.synthesisId, synthesisId);
    assert.equal(observations.at(-1).outcome, "failed", "normal reader completion cannot erase the observed TTS error");
    if (mode === "error-after") {
      assert.equal(frames[0], model.frames[0]);
      assert.equal(frames[0].userdata[USERDATA_TIMED_TRANSCRIPT][0].text, "Hello.");
    } else assert.equal(frames.length, 0);
    return { mode, observations, frames: frames.length, speechId: null, association: "unbound", readerCompletedNormally: true };
  } finally { await session.close(); }
}

async function overlappingSynthesisErrorsCase() {
  const model = new Synth(), observations = [];
  const left = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  const right = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  model.behavior = (text) => text === "left" ? { mode: "error-before", ...left } : { mode: "error-before", ...right };
  model.on("error", () => observations.push({ event: "public_error", synthesisId: als.getStore()?.synthesisId ?? null }));
  const session = new AgentSession({ tts: model, vad: null, turnHandling: { turnDetection: null } });
  const agent = new TracedTtsAgent(model, "overlap-synth");
  try {
    await session.start({ agent });
    const start = async (text) => {
      const source = new ReadableStream({ start(controller) { controller.enqueue(text); controller.close(); } });
      const node = await agent.ttsNode(source, {});
      const reader = node.getReader();
      const terminal = (async () => {
        while (!(await reader.read()).done) {}
        observations.push({ event: "node_terminal", text, synthesisId: agent.invocations.find((entry) => entry.synthesisId.endsWith(text === "left" ? "1" : "2"))?.synthesisId ?? null });
      })();
      return { terminal };
    };
    const leftNode = await start("left");
    const rightNode = await start("right");
    await Promise.all([left.entered.promise, right.entered.promise]);
    right.release.resolve();
    await until(() => observations.some((event) => event.event === "public_error" && event.synthesisId === "overlap-synth-2"), "right overlapping synthesis error");
    left.release.resolve();
    await Promise.all([leftNode.terminal, rightNode.terminal]);
    assert.deepEqual(observations.filter((event) => event.event === "public_error").map((event) => event.synthesisId), ["overlap-synth-2", "overlap-synth-1"], "overlapping errors retain the owning ALS synthesis IDs in reverse settlement order");
    for (const synthesisId of ["overlap-synth-1", "overlap-synth-2"]) {
      assert.ok(observations.findIndex((event) => event.event === "public_error" && event.synthesisId === synthesisId) < observations.findIndex((event) => event.event === "node_terminal" && event.synthesisId === synthesisId), `${synthesisId}: public error arrives before normal reader EOF`);
    }
    return { observations };
  } finally { await session.close(); }
}

function observeNodeForCancellation(upstreamStream, events) {
  const upstream = upstreamStream.getReader();
  let cancelled = false, cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    events.push("cleanup");
    try { upstream.releaseLock(); } catch {}
  };
  return new ReadableStream({
    async pull(controller) {
      const row = await upstream.read();
      if (cancelled) {
        events.push("pull_saw_cancel_latch");
        cleanup();
        controller.close();
        return;
      }
      if (row.done) {
        events.push("upstream_eof");
        cleanup();
        controller.close();
        return;
      }
      events.push("forward_frame");
      controller.enqueue(row.value);
    },
    async cancel(reason) {
      cancelled = true;
      events.push("cancel_latched");
      try {
        events.push("reader_cancel");
        await upstream.cancel(reason);
      } finally { cleanup(); }
    },
  }, { highWaterMark: 0 });
}

async function observerCancellationRaceCase() {
  const events = [], pullEntered = Promise.withResolvers(), releasePull = Promise.withResolvers();
  const upstream = new ReadableStream({
    async pull(controller) {
      pullEntered.resolve();
      await releasePull.promise;
      try { controller.enqueue(frame()); controller.close(); } catch { events.push("upstream_frame_rejected_after_cancel"); }
    },
    cancel() { events.push("upstream_cancel"); },
  });
  const observed = observeNodeForCancellation(upstream, events);
  const reader = observed.getReader();
  const pendingRead = reader.read();
  await pullEntered.promise;
  const cancellation = reader.cancel("test-local cancellation race");
  await until(() => events.includes("cancel_latched"), "observer cancellation latch");
  assert.ok(events.indexOf("cancel_latched") < events.indexOf("reader_cancel"), "observer latches cancellation before propagating reader.cancel");
  releasePull.resolve();
  await cancellation;
  await pendingRead.catch(() => {});
  assert.equal(events.filter((event) => event === "forward_frame").length, 0, "no frame is forwarded after observer cancellation");
  assert.equal(events.filter((event) => event === "cleanup").length, 1, "observer cleanup is one-shot");
  assert.ok(events.includes("upstream_cancel"), "observer propagates cancellation to the default-node reader");
  return { events };
}

class AttemptRegistry {
  constructor() { this.attempts = new Map(); this.events = []; }
  start(synthesisId) {
    assert.ok(!this.attempts.has(synthesisId), `attempt ${synthesisId} is registered once`);
    this.attempts.set(synthesisId, { synthesisId, speechId: null, terminal: null, supplements: [] });
    this.events.push({ event: "start", synthesisId });
  }
  metric(synthesisId, speechId) {
    const attempt = this.attempts.get(synthesisId); assert.ok(attempt, `metric for registered ${synthesisId}`);
    attempt.speechId = speechId;
    const event = { event: attempt.terminal ? "late_binding" : "binding", synthesisId, speechId };
    attempt.supplements.push(event); this.events.push(event);
  }
  error(synthesisId) {
    const attempt = this.attempts.get(synthesisId); assert.ok(attempt, `error for registered ${synthesisId}`);
    if (!attempt.terminal) attempt.terminal = { outcome: "failed", reason: "application_error" };
    this.events.push({ event: "error", synthesisId });
  }
  eof(synthesisId) {
    const attempt = this.attempts.get(synthesisId); assert.ok(attempt, `EOF for registered ${synthesisId}`);
    // A reader EOF alone has no causal provider-success signal. It cannot mint a success before a late metric/error.
    if (!attempt.terminal) attempt.terminal = attempt.speechId
      ? { outcome: "completed", reason: "metric_before_eof" }
      : { outcome: "incomplete", reason: "reader_eof_without_metric" };
    this.events.push({ event: "eof", synthesisId });
  }
  snapshot() { return [...this.attempts.values()].map(({ synthesisId, speechId, terminal, supplements }) => ({ synthesisId, speechId, terminal, supplements })); }
}

function registryPermutationCase() {
  const registry = new AttemptRegistry();
  for (const synthesisId of ["late-bound", "unavailable", "error-then-late", "bound-before-eof"]) registry.start(synthesisId);
  registry.eof("late-bound"); registry.metric("late-bound", "speech-late");
  registry.eof("unavailable");
  registry.error("error-then-late"); registry.eof("error-then-late"); registry.metric("error-then-late", "speech-error-late");
  registry.metric("bound-before-eof", "speech-bound"); registry.eof("bound-before-eof");
  const attempts = registry.snapshot();
  assert.equal(attempts.length, 4, "all test-local starts survive late and unavailable bindings");
  assert.deepEqual(attempts.map((attempt) => [attempt.synthesisId, attempt.speechId, attempt.terminal.outcome]), [
    ["late-bound", "speech-late", "incomplete"],
    ["unavailable", null, "incomplete"],
    ["error-then-late", "speech-error-late", "failed"],
    ["bound-before-eof", "speech-bound", "completed"],
  ]);
  assert.equal(attempts.find((attempt) => attempt.synthesisId === "late-bound").supplements[0].event, "late_binding", "late association enriches but never rewrites an early terminal");
  assert.equal(attempts.find((attempt) => attempt.synthesisId === "error-then-late").terminal.outcome, "failed", "a later binding cannot erase a causal application error");
  assert.equal(attempts.filter((attempt) => attempt.terminal.outcome === "completed").length, 1, "only a metric available before EOF establishes test-local completed evidence");
  return { attempts, events: registry.events };
}

const orderings = [];
for (const args of [["stt", true], ["vad", true], ["vad", false], ["stt", true, true]]) orderings.push(await orderingCase(...args));
const answerOrderings = [];
for (const mode of ["stt", "vad"]) for (const answerAt of ["final", "listening", "accepted"]) {
  answerOrderings.push(await orderingCase(mode, true, false, answerAt));
}
const pendingInputs = [];
for (const mode of ["stt", "vad"]) {
  for (const kind of ["absent", "interim", "empty-final", "preflight"]) pendingInputs.push(await pendingInputCase(mode, kind));
  for (const kind of ["absent", "interim"]) pendingInputs.push(await pendingInputCase(mode, kind, true));
}
const llmError = await llmErrorCase();
const ttsErrors = [await ttsErrorCase("error-before"), await ttsErrorCase("error-after")];
const ttsSessionMetric = await ttsSessionMetricCase();
const overlappingSynthesisErrors = await overlappingSynthesisErrorsCase();
const observerCancellationRace = await observerCancellationRaceCase();
const registryPermutations = registryPermutationCase();
const runtime = { node: process.version, platform: process.platform, arch: process.arch,
  agents: JSON.parse(readFileSync(resolve(runtimeRoot, "node_modules/@livekit/agents/package.json"))).version,
  rtcNode: JSON.parse(readFileSync(resolve(runtimeRoot, "node_modules/@livekit/rtc-node/package.json"))).version };
assert.equal(runtime.agents, "1.6.4"); assert.equal(runtime.rtcNode, "0.13.33");
console.log(JSON.stringify({ runtime, orderings, answerOrderings, pendingInputs, llmError, ttsErrors, ttsSessionMetric, overlappingSynthesisErrors, observerCancellationRace, registryPermutations }, null, 2));
