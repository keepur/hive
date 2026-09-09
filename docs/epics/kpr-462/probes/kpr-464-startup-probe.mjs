import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Defaults to this worktree after npm ci; no authoring scratch path is required.
const runtimeRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../../", import.meta.url)));
const {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  AudioInput,
  AudioOutput,
  DEFAULT_API_CONNECT_OPTIONS,
  LLM,
  LLMStream,
  VAD,
  VADEventType,
  VADStream,
  initializeLogger,
  stt,
  tts,
} = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@livekit/agents/dist/index.js")).href);
const { AudioFrame } = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@livekit/rtc-node/dist/index.js")).href);

initializeLogger({ pretty: false, level: "silent" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, label, timeout = 1500) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(2);
  }
  throw new Error(`timeout: ${label}`);
};
const assert = (condition, message) => { if (!condition) throw new Error(`assertion failed: ${message}`); };

class PushAudioInput extends AudioInput {
  constructor() {
    super();
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
  }
  get stream() { return this.readable; }
  push(frame) { this.controller.enqueue(frame); }
  finish() { this.controller.close(); }
}

class CapturingOutput extends AudioOutput {
  constructor() { super(24000, undefined, { pause: true }); this.frames = []; this.clears = 0; this.paused = false; }
  async captureFrame(frame) {
    await super.captureFrame(frame);
    this.frames.push(frame);
    this.onPlaybackStarted(Date.now());
  }
  clearBuffer() { this.clears += 1; }
  flush() {
    super.flush();
    if (!this.paused) this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
  }
  pause() { this.paused = true; }
  resume() {
    this.paused = false;
    if (this.frames.length) {
      this.onPlaybackStarted(Date.now());
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }
}

class ProbeLLMStream extends LLMStream {
  constructor(owner, args, text, fail = false, held = false, holdAfterText = false) { super(owner, args); this.text = text; this.fail = fail; this.entered = Promise.withResolvers(); this.release = Promise.withResolvers(); this.held = held; this.holdAfterText = holdAfterText; }
  async run() {
    this.entered.resolve();
    if (this.fail) throw new Error("bridge-error");
    if (this.held) await Promise.race([
      this.release.promise,
      new Promise((resolve) => this.abortController.signal.addEventListener("abort", resolve, { once: true })),
    ]);
    if (this.abortController.signal.aborted) return;
    this.queue.put({ id: `bridge-${this.text}`, delta: { role: "assistant", content: this.text } });
    if (this.holdAfterText) await Promise.race([
      this.release.promise,
      new Promise((resolve) => this.abortController.signal.addEventListener("abort", resolve, { once: true })),
    ]);
  }
}

class ProbeLLM extends LLM {
  constructor() { super(); this.streams = []; this.next = []; }
  label() { return "startup464-fake-llm"; }
  chat({ chatCtx, toolCtx, connOptions = DEFAULT_API_CONNECT_OPTIONS }) {
    const choice = this.next.shift() ?? { text: "reply" };
    const stream = new ProbeLLMStream(this, { chatCtx, toolCtx, connOptions: { ...connOptions, maxRetry: 0 } }, choice.text, choice.fail, choice.held, choice.holdAfterText);
    this.streams.push(stream);
    return stream;
  }
}

class ProbeSynthesizeStream extends tts.SynthesizeStream {
  constructor(owner, options = {}) { super(owner, options.connOptions); this.label = "startup464-fake-tts"; }
  async run() {
    for await (const value of this.input) {
      if (typeof value !== "string") { this.queue.put(tts.SynthesizeStream.END_OF_STREAM); return; }
      this.markStarted();
      this.queue.put({ frame: new AudioFrame(new Int16Array(480), 24000, 1, 480), requestId: `tts-${value}`, final: true });
    }
  }
}

class ProbeTTS extends tts.TTS {
  constructor() { super(24000, 1, { streaming: true }); this.label = "startup464-fake-tts"; }
  synthesize() { throw new Error("not used"); }
  stream(options) { return new ProbeSynthesizeStream(this, options); }
}

class ScriptedSTTStream extends stt.SpeechStream {
  constructor(owner) { super(owner); this.label = "startup464-scripted-stt"; }
  emit(event) { this.queue.put(event); }
  async run() {
    await new Promise((resolve) => this.abortSignal.addEventListener("abort", resolve, { once: true }));
  }
}

class ScriptedSTT extends stt.STT {
  constructor() { super({ streaming: true, interimResults: true }); this.label = "startup464-scripted-stt"; this.ready = Promise.withResolvers(); }
  stream() { const stream = new ScriptedSTTStream(this); this.ready.resolve(stream); return stream; }
}

class ScriptedVADStream extends VADStream {
  constructor(owner) { super(owner); this.label = "startup464-scripted-vad"; }
  emit(event) { this.sendVADEvent(event); }
}

class ScriptedVAD extends VAD {
  constructor() { super({ updateInterval: 1000 }); this.label = "startup464-scripted-vad"; this.ready = Promise.withResolvers(); }
  stream() { const stream = new ScriptedVADStream(this); this.ready.resolve(stream); return stream; }
}

const vadEvent = (type) => ({
  type,
  samplesIndex: 0,
  timestamp: Date.now(),
  speechDuration: 20,
  silenceDuration: 20,
  frames: [],
  probability: type === VADEventType.START_OF_SPEECH ? 1 : 0,
  inferenceDuration: 0,
  speaking: type !== VADEventType.END_OF_SPEECH,
  rawAccumulatedSilence: 0,
  rawAccumulatedSpeech: 0,
});

class HookAgent extends Agent {
  constructor(events) { super({ instructions: "offline probe" }); this.events = events; }
  async onUserTurnCompleted(_ctx, message) {
    this.events.push({ name: "accepted_turn", nonempty: Boolean(message.textContent), text: message.textContent ?? "" });
  }
}

const eventName = (event) => {
  if (event.type === "user_state_changed") return `user:${event.oldState}->${event.newState}`;
  if (event.type === "speech_created") return `speech:${event.speechHandle.id}`;
  if (event.type === "agent_false_interruption") return `false_interruption:${event.resumed}`;
  if (event.type === "metrics_collected") return `metric:${event.metrics.type}:${event.metrics.speechId ?? "none"}`;
  if (event.type === "error") return `error:${event.error?.type ?? event.error?.message ?? "unknown"}`;
  return event.type;
};

async function startupAndCallerCase() {
  const events = [];
  const llm = new ProbeLLM();
  llm.next.push({ text: "opening", held: true }, { text: "replacement" }, { text: "caller-response", held: true }, { text: "Resume candidate.", holdAfterText: true }, { text: "bridge-failure", fail: true });
  const input = new PushAudioInput();
  const output = new CapturingOutput();
  const fakeStt = new ScriptedSTT();
  const fakeVad = new ScriptedVAD();
  const session = new AgentSession({ stt: fakeStt, llm, tts: new ProbeTTS(), vad: fakeVad, aecWarmupDuration: null, turnHandling: { turnDetection: "vad", interruption: { mode: "vad", minDuration: 0, minWords: 0, falseInterruptionTimeout: 20, resumeFalseInterruption: true } } });
  session.input.audio = input;
  session.output.audio = output;
  const handles = [];
  const callbackOrder = [];
  const track = (label, handle) => {
    handle.addDoneCallback(() => {
      const done = { label, kind: "done", interrupted: handle.interrupted, items: handle.chatItems.length, exception: handle.exception()?.message ?? null };
      callbackOrder.push(done);
      events.push({ name: `handle_done:${label}:${done.exception ?? "none"}` });
    });
    handles.push({ label, handle });
    return handle;
  };
  for (const type of [AgentSessionEventTypes.UserStateChanged, AgentSessionEventTypes.SpeechCreated, AgentSessionEventTypes.AgentFalseInterruption, AgentSessionEventTypes.MetricsCollected, AgentSessionEventTypes.Error]) {
    session.on(type, (event) => events.push({ name: eventName(event), event }));
  }
  try {
    await session.start({ agent: new HookAgent(events) });
    const stream = await fakeStt.ready.promise;
    const vadStream = await fakeVad.ready.promise;

    // Mock SIP answer boundary: application creates the optional known opening.
    const opening = session.generateReply({ userInput: "known-opening" });
    track("opening", opening);
    await llm.streams[0].entered.promise;

    // The caller speaks before the planned opening could remain relevant. Cancel exactly that known handle.
    opening.interrupt();
    const replacement = session.generateReply({ userInput: "replacement" });
    track("replacement", replacement);
    await llm.streams[1].entered.promise;
    await waitFor(() => output.frames.length >= 1, "replacement reaches fake output");
    await Promise.all([opening.waitForPlayout(), replacement.waitForPlayout()]);

    // A provider-provided empty interim is a real SDK activity event; it must not become an accepted turn.
    input.push(new AudioFrame(new Int16Array(160), 16000, 1, 160));
    vadStream.emit(vadEvent(VADEventType.START_OF_SPEECH));
    stream.emit({ type: stt.SpeechEventType.INTERIM_TRANSCRIPT, alternatives: [{ text: "", language: "en", startTime: 0, endTime: 0, confidence: 1 }] });
    await waitFor(() => events.some(({ name }) => name === "user:listening->speaking"), "provisional speaking state");
    vadStream.emit(vadEvent(VADEventType.END_OF_SPEECH));
    await waitFor(() => events.some(({ name }) => name === "user:speaking->listening"), "provisional listening state");
    assert(!events.some(({ name }) => name === "accepted_turn"), "empty provisional speech was not accepted");

    // A final transcript plus EOU is the public accepted-turn seam and must precede its generated reply.
    vadStream.emit(vadEvent(VADEventType.START_OF_SPEECH));
    stream.emit({ type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [{ text: "hello", language: "en", startTime: 0, endTime: 0.02, confidence: 1 }] });
    vadStream.emit(vadEvent(VADEventType.END_OF_SPEECH));
    await waitFor(() => events.some(({ name }) => name === "accepted_turn"), "accepted caller turn");
    await waitFor(() => llm.streams.length === 3, "caller reply stream");
    llm.streams[2].release.resolve();
    await waitFor(() => output.frames.length >= 2, "caller reply reaches fake output");
    const acceptedIndex = events.findIndex(({ name }) => name === "accepted_turn");
    const callerMetricIndex = events.findIndex(({ name }, index) => index > acceptedIndex && name.startsWith("metric:llm_metrics:"));
    assert(acceptedIndex >= 0 && callerMetricIndex > acceptedIndex, `accepted hook precedes caller response content; sequence=${events.map(({ name }) => name).join(",")}`);

    // Drive a short empty activity while a speech exists; observe whether the SDK reports and resumes it.
    const resume = session.generateReply({ userInput: "resume-candidate" });
    track("resume-candidate", resume);
    await waitFor(() => llm.streams.length === 4, "resume candidate stream");
    await waitFor(() => output.frames.length >= 3, "resume candidate frames");
    vadStream.emit(vadEvent(VADEventType.START_OF_SPEECH));
    stream.emit({ type: stt.SpeechEventType.INTERIM_TRANSCRIPT, alternatives: [{ text: "", language: "en", startTime: 0, endTime: 0, confidence: 1 }] });
    vadStream.emit(vadEvent(VADEventType.INFERENCE_DONE));
    vadStream.emit(vadEvent(VADEventType.END_OF_SPEECH));
    await waitFor(() => events.some(({ name }) => name.startsWith("false_interruption:")), "false interruption event");
    llm.streams[3].release.resolve();

    const failed = session.generateReply({ userInput: "bridge-failure" });
    track("bridge-failure", failed);
    await waitFor(() => llm.streams.length === 5, "failing bridge stream");

    await Promise.all(handles.map(({ handle }) => handle.waitForPlayout()));
    await sleep(30);
    const outputFrames = output.frames.map((frame) => ({ sampleRate: frame.sampleRate, samplesPerChannel: frame.samplesPerChannel }));
    assert(opening.interrupted === true, "known opening handle was interrupted");
    assert(replacement.interrupted === false, "replacement handle was not interrupted");
    assert(outputFrames.length >= 3, "replacement and follow-on generated frames reached output");
    const failedErrorIndex = events.findIndex(({ name }) => name === "error:llm_error");
    const failedMetricIndex = events.findIndex(({ name }) => name === `metric:llm_metrics:${failed.id}`);
    const failedDoneIndex = events.findIndex(({ name }) => name === "handle_done:bridge-failure:none");
    assert(failedErrorIndex >= 0 && failedMetricIndex > failedErrorIndex && failedDoneIndex > failedMetricIndex, "session error, exact-speech metric, then done callback are observable");
    return {
      scenario: "fake-stt user-state, startup replacement, accepted hook, provisional speech, false interruption",
      events: events.map(({ name }) => name),
      handles: handles.map(({ label, handle }) => ({ label, id: handle.id, interrupted: handle.interrupted, done: handle.done(), exception: handle.exception()?.message ?? null, chatItems: handle.chatItems.length })),
      callbacks: callbackOrder,
      fakeOutput: { frameCount: outputFrames.length, frames: outputFrames, clearCount: output.clears },
      assertions: {
        openingCancelledAndReplacementGenerated: true,
        provisionalEmptyTranscriptNotAccepted: true,
        acceptedHookBeforeCallerResponse: true,
        falseInterruptionEvent: events.find(({ name }) => name.startsWith("false_interruption:"))?.name ?? null,
        failedHandleFinalization: {
          errorBeforeMetricBeforeDone: true,
          handleException: failed.exception()?.message ?? null,
          designGate: failed.exception() == null ? "public SpeechHandle exposes no thrown LLM error; the error event has no speech ID, so application-level causal attribution requires a design binding before readiness" : null,
        },
      },
    };
  } finally {
    input.finish();
    await session.close().catch(() => {});
  }
}

const result = await startupAndCallerCase();
console.log(JSON.stringify({ node: process.version, result }, null, 2));
