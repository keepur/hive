import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Defaults to this worktree after npm ci; no authoring scratch path is required.
const runtimeRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../../", import.meta.url)));
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
const {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  AudioOutput,
  ChatContext,
  DEFAULT_API_CONNECT_OPTIONS,
  LLM,
  LLMStream,
  USERDATA_TIMED_TRANSCRIPT,
  initializeLogger,
  tts,
} = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@livekit/agents/dist/index.js")).href);
const { AudioFrame } = await import(pathToFileURL(resolve(runtimeRoot, "node_modules/@livekit/rtc-node/dist/index.js")).href);

initializeLogger({ pretty: false, level: "silent" });

const als = new AsyncLocalStorage();
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  const result = Promise.withResolvers();
  return { ...result, settled: false, resolve(value) { this.settled = true; result.resolve(value); }, reject(reason) { this.settled = true; result.reject(reason); } };
}
async function eventually(predicate, label) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await pause(2);
  }
  throw new Error(`timed out: ${label}`);
}

class BridgeError extends Error {}

class GatedStream extends LLMStream {
  constructor(owner, args, assignment) {
    super(owner, args);
    this.assignment = assignment;
    this.entered = false;
    this.providerRun = gate();
    this.headers = gate();
    this.release = gate();
    this.headersAwaited = gate();
    this.afterHeaders = gate();
  }
  async run() {
    this.entered = true;
    this.assignment.stream = this;
    this.assignment.entered.resolve();
    await Promise.race([this.providerRun.promise, aborted(this.abortController.signal)]);
    if (this.abortController.signal.aborted) return;
    if (this.assignment.phase === "error") throw new BridgeError("synthetic bridge error");
    this.headersAwaited.resolve();
    await Promise.race([this.headers.promise, aborted(this.abortController.signal)]);
    if (this.abortController.signal.aborted) return;
    this.afterHeaders.resolve();
    if (this.assignment.phase === "after_headers") {
      await Promise.race([this.release.promise, aborted(this.abortController.signal)]);
      return;
    }
    if (this.assignment.phase === "empty") return;
    if (this.assignment.phase === "text") {
      this.queue.put({ id: this.assignment.requestId, delta: { role: "assistant", content: "first" } });
      this.assignment.firstText.resolve();
      await Promise.race([this.release.promise, aborted(this.abortController.signal)]);
      if (this.abortController.signal.aborted) return;
      this.queue.put({ id: this.assignment.requestId, delta: { role: "assistant", content: "second" } });
    }
  }
}

function aborted(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

class GatedLLM extends LLM {
  constructor() { super(); this.assignments = []; }
  label() { return "sdk464-full-fake-llm"; }
  enqueue(turnId, phase) {
    const assignment = { turnId, phase, requestId: `request-${turnId}`, entered: gate(), firstText: gate(), stream: null };
    this.assignments.push(assignment);
    return assignment;
  }
  chat({ chatCtx, toolCtx, connOptions = DEFAULT_API_CONNECT_OPTIONS }) {
    const assignment = this.assignments.shift();
    assert.ok(assignment, "each session LLM invocation has a configured assignment");
    return new GatedStream(this, { chatCtx, toolCtx, connOptions: { ...connOptions, maxRetry: 0 } }, assignment);
  }
}

class TracedAgent extends Agent {
  constructor({ llm, tts: ttsModel, assignments }) {
    super({ instructions: "SDK-only probe", llm, tts: ttsModel });
    this.assignments = assignments;
    this.ttsCalls = [];
  }
  async llmNode(chatCtx, toolCtx, modelSettings) {
    const assignment = this.assignments.shift();
    assert.ok(assignment, "agent has an LLM trace assignment");
    return als.run({ turnId: assignment.turnId }, () => Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings));
  }
  async ttsNode(text, modelSettings) {
    const attempt = { invocationTrace: als.getStore() ?? null, text, at: Date.now() };
    this.ttsCalls.push(attempt);
    return als.run({ synthesisId: `synth-${this.ttsCalls.length}` }, async () => {
      attempt.nodeTrace = als.getStore();
      return Agent.default.ttsNode(this, text, modelSettings);
    });
  }
}

class CaptureOutput extends AudioOutput {
  constructor() { super(24000); this.frames = []; this.events = []; }
  async captureFrame(frame) {
    await super.captureFrame(frame);
    this.frames.push(frame);
    if (this.frames.length === 1) this.onPlaybackStarted(Date.now());
  }
  flush() {
    super.flush();
    this.events.push("flush");
    this.onPlaybackFinished({ playbackPosition: 1, interrupted: false });
  }
  clearBuffer() {
    this.events.push("clear");
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }
}

class ProbeSynthesizeStream extends tts.SynthesizeStream {
  constructor(owner, mode) { super(owner); this.mode = mode; }
  async run() {
    for await (const value of this.input) {
      if (typeof value !== "string") return;
      this.markStarted();
      if (this.mode === "error") throw new Error("synthetic TTS error");
      if (this.mode === "pre-frame") {
        await Promise.race([this.modeGate.promise, aborted(this.abortSignal)]);
        return;
      }
      const frame = new AudioFrame(new Int16Array(480), 24000, 1, 480);
      this.owner.frames.push(frame);
      this.queue.put({ frame, requestId: `tts-${value}`, final: true, timedTranscripts: [{ text: value, startTime: 0, endTime: 0.02 }] });
      if (this.mode === "error-after-frame") throw new Error("synthetic TTS error after frame");
      if (this.mode === "after-frame") await Promise.race([this.modeGate.promise, aborted(this.abortSignal)]);
    }
  }
  onStreamDone() { this.doneGate.resolve(); }
}

class ProbeTTS extends tts.TTS {
  constructor() { super(24000, 1, { streaming: true }); this.label = "sdk464-full-fake-tts"; this.mode = "normal"; this.frames = []; this.streams = []; }
  synthesize() { throw new Error("streaming only"); }
  stream() {
    const stream = new ProbeSynthesizeStream(this, this.mode);
    stream.owner = this;
    stream.modeGate = gate();
    stream.doneGate = gate();
    this.streams.push(stream);
    return stream;
  }
}

function snapshotMetric(metric) {
  return {
    type: metric.type,
    cancelled: metric.cancelled,
    requestId: metric.requestId,
    speechId: metric.speechId ?? null,
    trace: als.getStore() ?? null,
  };
}

async function runSessionCase(name, phase, action) {
  const llm = new GatedLLM();
  const assignment = llm.enqueue(`turn-${name}`, phase);
  const agentAssignments = [{ turnId: assignment.turnId }];
  const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
  const agent = new TracedAgent({ llm, assignments: agentAssignments });
  const metrics = [];
  const events = [];
  session.on(AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => events.push({ event: "SpeechCreated", speechId: speechHandle.id }));
  session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics: metric }) => {
    if (metric.type === "llm_metrics") { metrics.push(snapshotMetric(metric)); events.push({ event: "llm_metrics", ...metrics.at(-1) }); }
  });
  try {
    await session.start({ agent });
    const handle = session.generateReply({ userInput: name });
    await assignment.entered.promise;
    await action({ handle, stream: assignment.stream, assignment });
    await handle.waitForPlayout().catch(() => {});
    await eventually(() => metrics.length === 1, `${name} LLM metric`);
    assert.equal(metrics[0].speechId, handle.id, `${name}: SDK metric is bound to generated SpeechHandle`);
    assert.equal(metrics[0].trace?.turnId, assignment.turnId, `${name}: ALS turn survives metric monitor`);
    return { name, handleId: handle.id, interrupted: handle.interrupted, exception: handle.exception()?.name ?? null, metrics, events };
  } finally { await session.close().catch(() => {}); }
}

async function fullSessionLlmMatrix() {
  const cases = [];
  cases.push(await runSessionCase("before-run", "empty", async ({ handle, stream }) => {
    // Stream exists but its provider run gate is closed: cancel before provider work begins.
    handle.interrupt(); stream.providerRun.resolve();
  }));
  cases.push(await runSessionCase("before-headers", "empty", async ({ handle, stream }) => {
    stream.providerRun.resolve(); await stream.headersAwaited.promise; handle.interrupt(); stream.headers.resolve();
  }));
  cases.push(await runSessionCase("after-headers-before-text", "after_headers", async ({ handle, stream }) => {
    stream.providerRun.resolve(); await stream.headersAwaited.promise; stream.headers.resolve(); await stream.afterHeaders.promise; handle.interrupt(); stream.release.resolve();
  }));
  cases.push(await runSessionCase("during-text", "text", async ({ handle, stream, assignment }) => {
    stream.providerRun.resolve(); stream.headers.resolve(); await assignment.firstText.promise; handle.interrupt(); stream.release.resolve();
  }));
  cases.push(await runSessionCase("empty-success", "empty", async ({ stream }) => { stream.providerRun.resolve(); stream.headers.resolve(); }));
  // The thrown-stream terminal's public records are captured below for error attribution.
  const error = await runErrorCase();
  const overlap = await overlapCase();
  assert.equal(cases[3].metrics[0].cancelled, true);
  assert.equal(cases[3].metrics[0].requestId, "request-turn-during-text");
  assert.equal(cases[4].metrics[0].cancelled, false);
  return { cases, error, overlap };
}

async function runErrorCase() {
  const llm = new GatedLLM();
  const assignment = llm.enqueue("turn-error", "error");
  const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
  const agent = new TracedAgent({ llm, assignments: [{ turnId: assignment.turnId }] });
  const metrics = [];
  session.on(AgentSessionEventTypes.MetricsCollected, ({ metrics: metric }) => { if (metric.type === "llm_metrics") metrics.push(snapshotMetric(metric)); });
  try {
    await session.start({ agent });
    const handle = session.generateReply({ userInput: "error" });
    await assignment.entered.promise; assignment.stream.providerRun.resolve();
    await handle.waitForPlayout().catch(() => {});
    await eventually(() => metrics.length === 1, "error LLM metric");
    assert.equal(handle.done(), true, "error stream reaches public handle terminal");
    return { handleId: handle.id, exception: handle.exception()?.name ?? null, llmMetric: metrics[0] ?? null };
  } finally { await session.close().catch(() => {}); }
}

async function overlapCase() {
  // Two independent real sessions demonstrate no shared last-turn join while they settle in reverse.
  const make = async (turnId) => {
    const llm = new GatedLLM(); const a = llm.enqueue(turnId, "text");
    const s = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
    const agent = new TracedAgent({ llm, assignments: [{ turnId }] }); const metrics = [];
    s.on(AgentSessionEventTypes.MetricsCollected, ({ metrics: m }) => { if (m.type === "llm_metrics") metrics.push(snapshotMetric(m)); });
    await s.start({ agent }); const handle = s.generateReply({ userInput: turnId }); await a.entered.promise;
    return { s, a, handle, metrics };
  };
  const left = await make("turn-overlap-left"), right = await make("turn-overlap-right");
  for (const x of [left, right]) { x.a.stream.providerRun.resolve(); x.a.stream.headers.resolve(); await x.a.firstText.promise; }
  right.a.stream.release.resolve(); await right.handle.waitForPlayout();
  left.a.stream.release.resolve(); await left.handle.waitForPlayout();
  await eventually(() => left.metrics.length === 1 && right.metrics.length === 1, "overlap metrics");
  assert.equal(left.metrics[0].trace.turnId, "turn-overlap-left");
  assert.equal(right.metrics[0].trace.turnId, "turn-overlap-right");
  assert.notEqual(left.metrics[0].speechId, right.metrics[0].speechId);
  await Promise.all([left.s.close(), right.s.close()]);
  return { left: left.metrics[0], right: right.metrics[0], reverseCompletion: true };
}

async function actualDefaultTtsCases() {
  const llm = new GatedLLM();
  const model = new ProbeTTS();
  const session = new AgentSession({ llm, tts: model, vad: null, turnHandling: { turnDetection: null } });
  const agent = new TracedAgent({ llm, tts: model, assignments: [] });
  const metrics = [];
  const errors = [];
  model.on("metrics_collected", (metric) => metrics.push(snapshotMetric(metric)));
  model.on("error", (event) => errors.push({ type: event.type, name: event.error?.name ?? null, message: event.error?.message ?? null }));
  try {
    await session.start({ agent });
    const source = new ReadableStream({ start(c) { c.enqueue("alpha"); c.enqueue("beta"); c.close(); } });
    const output = await agent.ttsNode(source, {});
    const reader = output.getReader();
    const frames = [];
    for (;;) { const row = await reader.read(); if (row.done) break; frames.push(row.value); }
    await eventually(() => metrics.length === 1, "actual default-node TTS metric");
    assert.equal(frames.length, 2);
    assert.equal(frames[0], model.frames[0], "default tts node preserves original first AudioFrame");
    assert.equal(frames[1], model.frames[1], "default tts node preserves original second AudioFrame");
    assert.equal(frames[0].userdata[USERDATA_TIMED_TRANSCRIPT][0].text, "alpha");
    assert.equal(frames[1].userdata[USERDATA_TIMED_TRANSCRIPT][0].text, "beta");
    assert.equal(metrics[0].trace?.synthesisId, "synth-1", "ALS encloses default-node stream creation");

    model.mode = "pre-frame";
    const pre = await agent.ttsNode("pre", {}); const preReader = pre.getReader();
    await eventually(() => model.streams.length >= 2, "pre-frame synth created");
    await preReader.cancel("cancel before frame");
    await model.streams.at(-1).doneGate.promise;
    const preMetricCount = metrics.length;

    model.mode = "after-frame";
    const after = await agent.ttsNode(new ReadableStream({ start(c) { c.enqueue("after"); } }), {});
    const afterReader = after.getReader();
    const first = await afterReader.read(); assert.equal(first.value, model.frames.at(-1));
    await afterReader.cancel("cancel after frame");
    await model.streams.at(-1).doneGate.promise;
    const afterMetricCount = metrics.length;

    model.mode = "error";
    const errorBefore = await agent.ttsNode(new ReadableStream({ start(c) { c.enqueue("error-before"); } }), {}); const errorBeforeReader = errorBefore.getReader();
    await errorBeforeReader.read();
    await model.streams.at(-1).doneGate.promise;
    const errorBeforeCount = errors.length;
    assert.equal(errorBeforeCount, 1, "before-frame TTS provider error reaches its public TTS error event");

    model.mode = "error-after-frame";
    const errorAfter = await agent.ttsNode(new ReadableStream({ start(c) { c.enqueue("error-after"); } }), {});
    const errorAfterReader = errorAfter.getReader();
    const errorAfterFirst = await errorAfterReader.read(); assert.equal(errorAfterFirst.value, model.frames.at(-1));
    await model.streams.at(-1).doneGate.promise;
    const errorAfterCount = errors.length;
    assert.equal(errorAfterCount, 2, "after-frame TTS provider error reaches its public TTS error event");

    const capture = new CaptureOutput(); session.output.audio = capture;
    model.mode = "normal";
    const handle = session.say("output");
    await handle.waitForPlayout();
    assert.ok(capture.frames.length > 0, "real session output receives default-node-generated frame");
    assert.equal(capture.frames.at(-1), model.frames.at(-1), "output receives original generated frame");
    // Public AudioOutput callbacks provide no SpeechHandle or synthesis ID.
    return {
      directDefaultNode: { frames: frames.length, originalFrames: frames.every((f, i) => f === model.frames[i]), timedMetadata: frames.map((f) => f.userdata[USERDATA_TIMED_TRANSCRIPT][0].text), metricTraceIds: [metrics[0]?.trace?.synthesisId ?? null] },
      cancellation: { preFrameMetricDelta: preMetricCount - 1, afterFrameMetricDelta: afterMetricCount - preMetricCount },
      errors: { beforeFrameErrorCount: errorBeforeCount, afterFrameErrorCount: errorAfterCount, publicErrors: errors },
      sessionOutput: { handleId: handle.id, receivedFrames: capture.frames.length, outputEventHasSpeechId: false, wrapperInvocationHasSpeechId: Boolean(agent.ttsCalls.at(-1)?.nodeTrace?.speechId) },
    };
  } finally { await session.close().catch(() => {}); }
}

const llm = await fullSessionLlmMatrix();
const ttsResult = await actualDefaultTtsCases();
const unproved = {
  completeCorrelation: {
    proved: false,
    failedContract: "The requested public-seam contract cannot bind a canceled/no-metric TTS attempt or an AudioOutput frame to an SDK SpeechHandle. Agent.default.ttsNode receives only agent, text, and modelSettings; AudioOutput capture callbacks expose only AudioFrame; MetricsCollected is absent before first frame. No public callback exposes the active SpeechHandle at those seams.",
    leastInvasiveDesignAdjustment: "Revise the contract to record an explicit application-owned synthesisAttemptId at wrapper entry, classify pre-frame cancellation as unbound, and require handle association only where the application initiated the speech and retains its public SpeechHandle. If per-generated-frame SpeechHandle correlation is mandatory, the SDK needs a public speechHandle/speechId parameter or output event field; do not infer it from timing or queue order.",
  },
  ttsBackpressure: {
    proved: false,
    failedContract: "The public default-node stream supports reader cancellation, which this probe asserts, but it exposes no public producer-demand or queue-depth signal. A bounded backpressure proof cannot be made without timing-based inference or private queues.",
    leastInvasiveDesignAdjustment: "Treat cancellation/terminal cleanup as the public SDK contract. If bounded producer backpressure is a required product invariant, enforce it in the Hive wrapper with an application-owned bounded queue and test that queue directly.",
  },
  errorAttribution: {
    proved: false,
    failedContract: "The thrown LLM case reaches a public SpeechHandle terminal and an LLM metric, but SpeechHandle.exception() is null and the public LLM metric contains no error. The BridgeError cannot be attributed from those public terminal records.",
    leastInvasiveDesignAdjustment: "Capture BridgeError in the application-owned llmNode/stream wrapper while its explicit turn/attempt context exists, emit one application terminal there, and use the public handle done callback only for settlement. Keep SDK metrics as optional enrichment and never wait for them to invent the error.",
  },
};
const report = { runtime: { node: process.version, platform: process.platform, arch: process.arch }, llm, tts: ttsResult, unproved };
console.log(JSON.stringify(report, null, 2));
