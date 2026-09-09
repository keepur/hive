import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Scratch-only, public-SDK capability probe. It deliberately never reads SDK
// internals; the source inspection recorded in findings.md is separate evidence.
const runtimeRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const sdk = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@livekit/agents/dist/index.js")).href);
const rtc = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@livekit/rtc-node/dist/index.js")).href);
const { Agent, AgentSession, AgentSessionEventTypes, AudioInput, DEFAULT_API_CONNECT_OPTIONS,
  LLM, LLMStream, VAD, VADStream, VADEventType, stt, tts, initializeLogger } = sdk;
const { AudioFrame } = rtc;
initializeLogger({ pretty: false, level: "silent" });
const als = new AsyncLocalStorage();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 1500; i += 1) { if (check()) return; await pause(2); }
  throw new Error(`timeout: ${label}`);
}
const audio = () => new AudioFrame(new Int16Array(160), 16000, 1, 160);
const finalTranscript = (text) => ({ type: stt.SpeechEventType.FINAL_TRANSCRIPT,
  alternatives: [{ text, language: "en", startTime: 0, endTime: 0.02, confidence: 1 }] });
const vadEvent = (type) => ({ type, samplesIndex: 0, timestamp: Date.now(), speechDuration: 20,
  silenceDuration: 20, frames: [], probability: type === VADEventType.START_OF_SPEECH ? 1 : 0,
  inferenceDuration: 0, speaking: type !== VADEventType.END_OF_SPEECH,
  rawAccumulatedSilence: 0, rawAccumulatedSpeech: 0 });

class Input extends AudioInput {
  constructor() { super(); this.readable = new ReadableStream({ start: (c) => { this.controller = c; } }); }
  get stream() { return this.readable; }
  close() { this.controller.close(); }
}
class SttStream extends stt.SpeechStream {
  async run() { await new Promise((resolve) => this.abortSignal.addEventListener("abort", resolve, { once: true })); }
  emit(event) { this.queue.put(event); }
}
class Stt extends stt.STT {
  constructor() { super({ streaming: true, interimResults: true }); this.label = "admission-probe-stt"; this.ready = Promise.withResolvers(); }
  stream() { const stream = new SttStream(this); this.ready.resolve(stream); return stream; }
}
class VadStream extends VADStream { emit(event) { this.sendVADEvent(event); } }
class Vad extends VAD {
  constructor() { super({ updateInterval: 1000 }); this.label = "admission-probe-vad"; this.ready = Promise.withResolvers(); }
  stream() { const stream = new VadStream(this); this.ready.resolve(stream); return stream; }
}
class SilentSynthStream extends tts.SynthesizeStream {
  async run() { for await (const _value of this.input) { this.markStarted(); } }
}
class SilentTts extends tts.TTS {
  constructor() { super(24000, 1, { streaming: true }); this.label = "admission-probe-tts"; }
  synthesize() { throw new Error("streaming only"); }
  stream() { return new SilentSynthStream(this); }
}

class FailingStream extends LLMStream {
  constructor(owner, args, spec) { super(owner, args); this.owner = owner; this.spec = spec; this.entered = Promise.withResolvers(); }
  async run() {
    this.owner.events.push({ event: "llm_run", turnId: this.spec.turnId });
    this.entered.resolve();
    if (this.spec.kind === "text") {
      this.queue.put({ id: `provider-${this.spec.turnId}`, delta: { role: "assistant", content: "okay" } });
      return;
    }
    await Promise.race([this.spec.failGate.promise, new Promise((resolve) => {
      if (this.abortController.signal.aborted) resolve();
      else this.abortController.signal.addEventListener("abort", resolve, { once: true });
    })]);
    if (this.abortController.signal.aborted) return;
    // This is the required application-owned capture point, before SDK error handling.
    this.owner.events.push({ event: "application_error", turnId: als.getStore()?.turnId ?? null });
    throw new Error(`synthetic bridge failure for ${this.spec.turnId}`);
  }
}
class ControlledLlm extends LLM {
  constructor(specs, events) { super(); this.specs = [...specs]; this.events = events; this.streams = []; }
  label() { return "admission-probe-llm"; }
  chat({ chatCtx, toolCtx, connOptions = DEFAULT_API_CONNECT_OPTIONS }) {
    const spec = this.specs.shift();
    assert.ok(spec, "test supplied a stream plan");
    this.events.push({ event: "llm_constructed", turnId: spec.turnId });
    return als.run({ turnId: spec.turnId }, () => {
      const stream = new FailingStream(this, { chatCtx, toolCtx, connOptions: { ...connOptions, maxRetry: 0 } }, spec);
      this.streams.push(stream);
      return stream;
    });
  }
}

// This is deliberately stricter than a creation-epoch scheme. It accepts an
// SDK-origin error only when (1) an application error is captured, (2) the same
// app turn is genuinely bound by public llm_metrics.speechId, and (3) that exact
// speech ID appears in public eou_metrics after an accepted hook. No event picks
// a latest SpeechCreated handle or maps a hook to a handle.
class AdmissionRegistry {
  constructor(events) { this.events = events; this.turns = new Map(); this.admitted = new Map(); this.acceptedSerial = 0; this.appOwned = new Set(); }
  turn(turnId) { if (!this.turns.has(turnId)) this.turns.set(turnId, { turnId, error: false, speechId: null, queued: false }); return this.turns.get(turnId); }
  acceptedHook() { this.acceptedSerial += 1; this.events.push({ event: "accepted_hook", serial: this.acceptedSerial }); }
  error(turnId) { this.turn(turnId).error = true; this.events.push({ event: "registry_error", turnId }); this.queueIfEligible(turnId); }
  llmBinding(turnId, speechId) {
    assert.ok(turnId && speechId, "only an explicit app turn plus SDK metric speechId can bind");
    const record = this.turn(turnId);
    assert.equal(record.speechId, null, "one test stream has one genuine binding");
    record.speechId = speechId; this.events.push({ event: "llm_binding", turnId, speechId }); this.queueIfEligible(turnId);
  }
  eou(speechId) {
    assert.ok(speechId, "pinned SDK emits an EOU speechId in this caller path");
    this.admitted.set(speechId, this.acceptedSerial);
    this.events.push({ event: "eou_admission", speechId, serial: this.acceptedSerial });
    for (const turnId of this.turns.keys()) this.queueIfEligible(turnId);
  }
  ownAppHandle(speechId) { this.appOwned.add(speechId); this.events.push({ event: "app_owned_handle", speechId }); }
  queueIfEligible(turnId) {
    const record = this.turn(turnId);
    if (!record.error || !record.speechId || record.queued) return;
    const origin = this.admitted.get(record.speechId);
    if (origin !== undefined || this.appOwned.has(record.speechId)) {
      record.queued = true;
      this.events.push({ event: "recovery_pending", turnId, speechId: record.speechId, origin: origin ?? "app-owned" });
    }
  }
  drain() {
    const outcomes = [];
    for (const record of this.turns.values()) if (record.queued) {
      const origin = this.admitted.get(record.speechId);
      // Separate app-owned opening/recovery handle: it has its retained public
      // handle, so it deliberately does not require caller EOU admission.
      const current = origin === undefined ? this.appOwned.has(record.speechId) : origin === this.acceptedSerial;
      const outcome = current ? "recover" : "superseded";
      outcomes.push({ turnId: record.turnId, speechId: record.speechId, outcome });
      this.events.push({ event: `recovery_${outcome}`, turnId: record.turnId, speechId: record.speechId });
    }
    return outcomes;
  }
}

async function callerCase({ name, errorTiming, twoTurns = false }) {
  const events = [], registry = new AdmissionRegistry(events);
  const firstGate = Promise.withResolvers();
  const specs = [{ turnId: `${name}-one`, kind: "error", failGate: firstGate }];
  if (twoTurns) specs.push({ turnId: `${name}-two`, kind: "text" });
  const llm = new ControlledLlm(specs, events), input = new Input(), sttModel = new Stt(), vad = new Vad();
  const session = new AgentSession({ llm, stt: sttModel, tts: new SilentTts(), vad, aecWarmupDuration: null,
    turnHandling: { turnDetection: "vad", preemptiveGeneration: { enabled: true, preemptiveTts: false } } });
  session.input.audio = input;
  const created = [];
  class Hook extends Agent { async onUserTurnCompleted(_ctx, message) {
    assert.ok(message.textContent?.trim()); registry.acceptedHook();
  } }
  session.on(AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => {
    created.push(speechHandle.id); events.push({ event: "speech_created", speechId: speechHandle.id });
  });
  session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
    if (metrics.type === "eou_metrics") registry.eou(metrics.speechId ?? null);
    if (metrics.type === "llm_metrics") {
      const turnId = als.getStore()?.turnId ?? null;
      events.push({ event: "llm_metrics", turnId, speechId: metrics.speechId ?? null, cancelled: metrics.cancelled });
      registry.llmBinding(turnId, metrics.speechId ?? null);
    }
  });
  llm.on("error", () => {
    const turnId = als.getStore()?.turnId ?? null;
    events.push({ event: "public_llm_error", turnId }); registry.error(turnId);
  });
  const emitTurn = async (text) => {
    input.controller.enqueue(audio());
    const speech = await sttModel.ready.promise, vstream = await vad.ready.promise;
    vstream.emit(vadEvent(VADEventType.START_OF_SPEECH));
    speech.emit(finalTranscript(text));
    await until(() => created.length >= registry.acceptedSerial + 1, `${name}: preemptive speech created`);
    await until(() => llm.streams.length >= registry.acceptedSerial + 1, `${name}: preemptive LLM started`);
    return { speech, vstream };
  };
  try {
    await session.start({ agent: new Hook({ instructions: "offline admission probe" }) });
    const first = await emitTurn("first caller turn");
    const firstSpeechId = created[0];
    assert.equal(registry.acceptedSerial, 0, "VAD preemptive handle exists before accepted hook");
    if (errorTiming === "before-hook") {
      firstGate.resolve();
      await until(() => events.some((e) => e.event === "registry_error"), `${name}: error before hook`);
      assert.equal(registry.drain().length, 0, "speculative error cannot recover before acceptance");
    }
    first.vstream.emit(vadEvent(VADEventType.END_OF_SPEECH));
    await until(() => registry.acceptedSerial >= 1, `${name}: accepted hook one`);
    await until(() => events.some((e) => e.event === "eou_admission"), `${name}: EOU one`);
    if (errorTiming === "after-hook") {
      firstGate.resolve();
      await until(() => events.some((e) => e.event === "registry_error"), `${name}: error after hook`);
    }
    await until(() => events.some((e) => e.event === "llm_binding" && e.turnId === `${name}-one`), `${name}: delayed SDK LLM binding`);
    const eou = events.find((e) => e.event === "eou_admission");
    const binding = events.find((e) => e.event === "llm_binding" && e.turnId === `${name}-one`);
    assert.equal(eou.speechId, firstSpeechId, "public EOU speechId identifies the admitted preemptive caller response");
    assert.equal(binding.speechId, firstSpeechId, "public LLM metric binds error turn to that same response");
    assert.equal(registry.turn(`${name}-one`).queued, true, "recovery becomes eligible only after EOU admission plus genuine binding");
    let recovery;
    if (twoTurns) {
      const second = await emitTurn("newer caller turn");
      second.vstream.emit(vadEvent(VADEventType.END_OF_SPEECH));
      await until(() => registry.acceptedSerial === 2, `${name}: second accepted hook`);
      await until(() => events.filter((e) => e.event === "eou_admission").length === 2, `${name}: second EOU`);
      const eous = events.filter((e) => e.event === "eou_admission");
      assert.notEqual(eous[0].speechId, eous[1].speechId, "two accepted caller responses have distinct EOU identities");
      const hook2 = events.findIndex((e) => e.event === "accepted_hook" && e.serial === 2);
      const eou1 = events.findIndex((e) => e.event === "eou_admission" && e.speechId === firstSpeechId);
      const eou2 = events.findIndex((e) => e.event === "eou_admission" && e.speechId === eous[1].speechId);
      assert.ok(eou1 < hook2 && hook2 < eou2, "accepted calls serialize: EOU one does not interleave after hook two");
      recovery = registry.drain();
      assert.deepEqual(recovery, [{ turnId: `${name}-one`, speechId: firstSpeechId, outcome: "superseded" }], "newer accepted input suppresses stale owned recovery");
    } else {
      recovery = registry.drain();
      assert.deepEqual(recovery, [{ turnId: `${name}-one`, speechId: firstSpeechId, outcome: "recover" }]);
    }
    const order = Object.fromEntries(["application_error", "accepted_hook", "eou_admission", "llm_binding"].map((kind) => [kind, events.findIndex((e) => e.event === kind)]));
    if (errorTiming === "before-hook") assert.ok(order.application_error < order.accepted_hook && order.accepted_hook < order.eou_admission, "before-hook error remains pending until later admission");
    else assert.ok(order.accepted_hook < order.eou_admission && order.eou_admission < order.application_error && order.application_error < order.llm_binding, "after-hook error waits for its delayed LLM binding");
    return { name, errorTiming, twoTurns, firstSpeechId, events, recovery };
  } finally { input.close(); await session.close().catch(() => {}); }
}

async function noEouCase(appOwned) {
  const name = appOwned ? "app-owned-no-eou" : "unowned-no-eou";
  const events = [], registry = new AdmissionRegistry(events), gate = Promise.withResolvers();
  const llm = new ControlledLlm([{ turnId: name, kind: "error", failGate: gate }], events);
  const session = new AgentSession({ llm, tts: new SilentTts(), vad: null, turnHandling: { turnDetection: null } });
  session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
    if (metrics.type === "eou_metrics") registry.eou(metrics.speechId ?? null);
    if (metrics.type === "llm_metrics") registry.llmBinding(als.getStore()?.turnId ?? null, metrics.speechId ?? null);
  });
  llm.on("error", () => registry.error(als.getStore()?.turnId ?? null));
  try {
    await session.start({ agent: new Agent({ instructions: "offline admission probe" }) });
    const handle = session.generateReply({ userInput: name });
    if (appOwned) registry.ownAppHandle(handle.id); // Retained direct application handle, never inferred from SpeechCreated.
    await until(() => llm.streams.length === 1, `${name}: stream`);
    gate.resolve();
    await until(() => registry.turn(name).speechId !== null, `${name}: genuine LLM binding`);
    assert.equal(events.filter((e) => e.event === "eou_admission").length, 0, "direct generateReply emits no caller EOU admission");
    const recovery = registry.drain();
    assert.deepEqual(recovery, appOwned
      ? [{ turnId: name, speechId: handle.id, outcome: "recover" }]
      : [], appOwned ? "explicit application-owned opening can recover without EOU" : "unowned no-EOU response cannot speculatively fall back");
    return { name, appOwned, handleId: handle.id, events, recovery };
  } finally { await session.close().catch(() => {}); }
}

async function queuedAcceptedCallsCase() {
  const events = [], input = new Input(), sttModel = new Stt(), vad = new Vad();
  const llm = new ControlledLlm([
    { turnId: "queued-one", kind: "text" },
    { turnId: "queued-two", kind: "text" },
  ], events);
  const session = new AgentSession({ llm, stt: sttModel, tts: new SilentTts(), vad, aecWarmupDuration: null,
    turnHandling: { turnDetection: "vad", preemptiveGeneration: { enabled: true, preemptiveTts: false } } });
  session.input.audio = input;
  const hookOneRelease = Promise.withResolvers();
  let hooks = 0;
  class Hook extends Agent {
    async onUserTurnCompleted(_ctx, message) {
      assert.ok(message.textContent?.trim()); hooks += 1; events.push({ event: "hook_enter", hook: hooks });
      if (hooks === 1) await hookOneRelease.promise;
      events.push({ event: "hook_return", hook: hooks });
    }
  }
  session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
    if (metrics.type === "eou_metrics") events.push({ event: "eou", speechId: metrics.speechId ?? null });
  });
  try {
    await session.start({ agent: new Hook({ instructions: "offline admission probe" }) });
    const speech = await sttModel.ready.promise, vstream = await vad.ready.promise;
    const submit = (text) => { input.controller.enqueue(audio()); vstream.emit(vadEvent(VADEventType.START_OF_SPEECH)); speech.emit(finalTranscript(text)); vstream.emit(vadEvent(VADEventType.END_OF_SPEECH)); };
    submit("first queued caller turn");
    await until(() => events.some((e) => e.event === "hook_enter" && e.hook === 1), "first hook enters");
    submit("second queued caller turn");
    await until(() => llm.streams.length === 2, "second can preemptively construct while first hook is held");
    assert.ok(events.some((e) => e.event === "llm_constructed" && e.turnId === "queued-two"), "second speculative stream is constructed while hook one is held");
    assert.equal(events.filter((e) => e.event === "eou").length, 0, "no EOU is emitted while the first accepted hook is still held");
    hookOneRelease.resolve();
    await until(() => events.filter((e) => e.event === "eou").length === 2, "both queued EOU metrics");
    const oneReturn = events.findIndex((e) => e.event === "hook_return" && e.hook === 1);
    const oneEou = events.findIndex((e) => e.event === "eou");
    const twoEnter = events.findIndex((e) => e.event === "hook_enter" && e.hook === 2);
    const twoReturn = events.findIndex((e) => e.event === "hook_return" && e.hook === 2);
    const twoEou = events.findIndex((e, index) => index > oneEou && e.event === "eou");
    assert.ok(oneReturn < oneEou && oneEou < twoEnter && twoEnter < twoReturn && twoReturn < twoEou,
      "SDK serializes accepted calls: hook one return → EOU one → hook two → EOU two");
    return { events };
  } finally { hookOneRelease.resolve(); input.close(); await session.close().catch(() => {}); }
}

const before = await callerCase({ name: "before-hook", errorTiming: "before-hook" });
const after = await callerCase({ name: "after-hook", errorTiming: "after-hook" });
const superseded = await callerCase({ name: "superseded", errorTiming: "after-hook", twoTurns: true });
const queuedAcceptedCalls = await queuedAcceptedCallsCase();
const unownedNoEou = await noEouCase(false);
const appOwnedNoEou = await noEouCase(true);
const runtime = { node: process.version, platform: process.platform, arch: process.arch,
  agents: JSON.parse(readFileSync(resolve(runtimeRoot, "node_modules/@livekit/agents/package.json"))).version,
  rtcNode: JSON.parse(readFileSync(resolve(runtimeRoot, "node_modules/@livekit/rtc-node/package.json"))).version };
assert.equal(runtime.agents, "1.6.4"); assert.equal(runtime.node, "v24.16.0");
console.log(JSON.stringify({ runtime, before, after, superseded, queuedAcceptedCalls, unownedNoEou, appOwnedNoEou }, null, 2));
