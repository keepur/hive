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
  constructor(owner, opts) { super(owner, opts); this.owner = owner; }
  async run() {
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
      if (this.owner.mode === "error-before") throw new Error("synthetic TTS failure before frame");
      const original = frame(); this.owner.frames.push(original);
      this.queue.put({ frame: original, requestId: "fake-tts", final: true, timedTranscripts: [{ text: value, startTime: 0, endTime: 0.02 }] });
      if (this.owner.mode === "error-after") throw new Error("synthetic TTS failure after frame");
    }
  }
}
class Synth extends tts.TTS {
  constructor(mode = "normal") { super(24000, 1, { streaming: true }); this.label = "revision-fake-tts"; this.mode = mode; this.frames = []; }
  synthesize() { throw new Error("streaming only"); }
  stream() { return new SynthStream(this); }
}

async function orderingCase(mode, preemptive, preflight = false) {
  const events = [], created = [];
  const input = new Input(), output = new Output(events), sttModel = new Stt(), vadModel = mode === "vad" ? new Vad() : null;
  const llm = new TextModel(events);
  const hookRelease = Promise.withResolvers();
  class Hook extends Agent {
    async onUserTurnCompleted(_ctx, message) {
      assert.ok(message.textContent);
      events.push("accepted_hook_enter");
      await hookRelease.promise;
      events.push("accepted_hook_return");
    }
  }
  const session = new AgentSession({ llm, stt: sttModel, tts: new Synth(), vad: vadModel, aecWarmupDuration: null,
    turnHandling: { turnDetection: mode, preemptiveGeneration: { enabled: preemptive, preemptiveTts: false } } });
  session.input.audio = input; session.output.audio = output;
  session.on(AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => { created.push(speechHandle); events.push("speech_created"); });
  session.on(AgentSessionEventTypes.UserInputTranscribed, () => events.push("transcript_observed"));
  try {
    await session.start({ agent: new Hook({ instructions: "offline probe" }) });
    const speech = await sttModel.ready.promise;
    const vad = vadModel ? await vadModel.ready.promise : null;
    input.controller.enqueue(new AudioFrame(new Int16Array(160), 16000, 1, 160));
    if (vad) vad.emit(vadEvent(VADEventType.START_OF_SPEECH));
    else speech.emit({ type: stt.SpeechEventType.START_OF_SPEECH });
    if (preflight) { speech.emit(transcript(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT)); await until(() => events.includes("llm_text"), "preflight speculative text"); }
    speech.emit(transcript(stt.SpeechEventType.FINAL_TRANSCRIPT));
    await until(() => events.includes("transcript_observed"), "final transcript observed");
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
    return { mode, preemptive, preflight, events, handleCount: created.length, outputFrames: output.frames.length };
  } finally { hookRelease.resolve(); input.finish(); await session.close(); }
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

const orderings = [];
for (const args of [["stt", true], ["vad", true], ["vad", false], ["stt", true, true]]) orderings.push(await orderingCase(...args));
const llmError = await llmErrorCase();
const ttsErrors = [await ttsErrorCase("error-before"), await ttsErrorCase("error-after")];
const runtime = { node: process.version, platform: process.platform, arch: process.arch,
  agents: JSON.parse(readFileSync(resolve(runtimeRoot, "node_modules/@livekit/agents/package.json"))).version,
  rtcNode: JSON.parse(readFileSync(resolve(runtimeRoot, "node_modules/@livekit/rtc-node/package.json"))).version };
assert.equal(runtime.agents, "1.6.4"); assert.equal(runtime.rtcNode, "0.13.33");
console.log(JSON.stringify({ runtime, orderings, llmError, ttsErrors }, null, 2));
