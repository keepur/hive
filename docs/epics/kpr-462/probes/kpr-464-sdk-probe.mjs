import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const runtimeRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("../../../../", import.meta.url)));
const sdkPath = resolve(runtimeRoot, "node_modules/@livekit/agents/dist/index.js");
const rtcPath = resolve(runtimeRoot, "node_modules/@livekit/rtc-node/dist/index.js");
const {
  Agent,
  AgentSession,
  AgentSessionEventTypes,
  ChatContext,
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  LLM,
  LLMStream,
  AudioInput,
  stt,
  tts,
} = await import(pathToFileURL(sdkPath).href);
const { AudioFrame } = await import(pathToFileURL(rtcPath).href);

initializeLogger({ pretty: false, level: "silent" });

const traceStore = new AsyncLocalStorage();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

class ProbeStream extends LLMStream {
  constructor(owner, args, scenario) {
    super(owner, args);
    this.scenario = scenario;
    this.entered = false;
    this.headers = Promise.withResolvers();
    this.text = Promise.withResolvers();
  }

  async run() {
    this.entered = true;
    if (this.scenario === "before_run") return;
    await Promise.race([
      this.headers.promise,
      new Promise((resolve) => this.abortController.signal.addEventListener("abort", resolve, { once: true })),
    ]);
    if (this.abortController.signal.aborted) return;
    if (this.scenario === "after_headers_before_text") {
      await Promise.race([
        this.text.promise,
        new Promise((resolve) => this.abortController.signal.addEventListener("abort", resolve, { once: true })),
      ]);
    }
    if (this.abortController.signal.aborted) return;
    if (this.scenario === "during_text") {
      this.queue.put({ id: "provider-during", delta: { role: "assistant", content: "one" } });
      await Promise.race([
        this.text.promise,
        new Promise((resolve) => this.abortController.signal.addEventListener("abort", resolve, { once: true })),
      ]);
      if (this.abortController.signal.aborted) return;
      this.queue.put({ id: "provider-during", delta: { role: "assistant", content: "two" } });
    }
  }
}

class ProbeLLM extends LLM {
  constructor() {
    super();
    this.pending = [];
  }
  label() { return "sdk464-probe"; }
  chat({ chatCtx, toolCtx, connOptions = DEFAULT_API_CONNECT_OPTIONS, extraKwargs = {} }) {
    const turnId = extraKwargs.turnId ?? `turn-auto-${this.pending.length + 1}`;
    const scenario = extraKwargs.scenario;
    return traceStore.run({ turnId }, () => {
      const stream = new ProbeStream(this, { chatCtx, toolCtx, connOptions: { ...connOptions, maxRetry: 0 } }, scenario);
      this.pending.push(stream);
      return stream;
    });
  }
}

async function waitFor(check, label) {
  const stop = Date.now() + 1000;
  while (Date.now() < stop) {
    if (check()) return;
    await sleep(2);
  }
  throw new Error(`timeout: ${label}`);
}

async function directCases() {
  const llm = new ProbeLLM();
  const metrics = [];
  llm.on("metrics_collected", (metric) => metrics.push({ metric, trace: traceStore.getStore() }));
  const ctx = ChatContext.empty();
  const mk = (turnId, scenario) => llm.chat({ chatCtx: ctx, extraKwargs: { turnId, scenario } });

  const before = mk("turn-before-run", "before_run");
  before.close();
  const headers = mk("turn-before-headers", "after_headers_before_text");
  await waitFor(() => headers.entered, "headers entered");
  headers.close();
  headers.headers.resolve();
  const afterHeaders = mk("turn-after-headers", "after_headers_before_text");
  await waitFor(() => afterHeaders.entered, "after headers entered");
  afterHeaders.headers.resolve();
  await sleep(4);
  afterHeaders.close();
  afterHeaders.text.resolve();
  const during = mk("turn-during-text", "during_text");
  await waitFor(() => during.entered, "during text entered");
  during.headers.resolve();
  await sleep(4);
  during.close();
  during.text.resolve();
  const overlapA = mk("turn-overlap-a", "during_text");
  const overlapB = mk("turn-overlap-b", "during_text");
  await waitFor(() => overlapA.entered && overlapB.entered, "overlaps entered");
  overlapA.headers.resolve(); overlapB.headers.resolve();
  overlapA.text.resolve(); overlapB.text.resolve();
  await waitFor(() => metrics.length === 6, "six direct metrics");
  results.push({
    test: "direct_stream_context",
    metrics: metrics.map(({ metric, trace }) => ({
      cancelled: metric.cancelled,
      requestId: metric.requestId,
      ttftMs: metric.ttftMs,
      traceTurnId: trace?.turnId ?? null,
    })),
  });
}

async function sessionSpeechIdCase() {
  const llm = new ProbeLLM();
  const events = [];
  const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
  session.on(AgentSessionEventTypes.MetricsCollected, (event) => {
    if (event.metrics.type === "llm_metrics") {
      events.push({
        cancelled: event.metrics.cancelled,
        speechId: event.metrics.speechId ?? null,
        traceTurnId: traceStore.getStore()?.turnId ?? null,
      });
    }
  });
  try {
    await session.start({ agent: new Agent({ instructions: "probe" }) });
    const handle = session.generateReply({ userInput: "hello" });
    await waitFor(() => llm.pending.length === 1 && llm.pending[0].entered, "session stream entered");
    const stream = llm.pending[0];
    stream.headers.resolve();
    await handle.waitForPlayout();
    await waitFor(() => events.length === 1, "session metric");
    results.push({ test: "session_speech_id", speechId: events[0].speechId, traceTurnId: events[0].traceTurnId, handleId: handle.id });
  } finally {
    await session.close().catch(() => {});
  }
}

async function handleCancellationCase() {
  const llm = new ProbeLLM();
  const created = [];
  const metrics = [];
  const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
  session.on(AgentSessionEventTypes.SpeechCreated, (event) => created.push(event.speechHandle.id));
  session.on(AgentSessionEventTypes.MetricsCollected, (event) => {
    if (event.metrics.type === "llm_metrics") metrics.push({
      speechId: event.metrics.speechId ?? null,
      cancelled: event.metrics.cancelled,
      traceTurnId: traceStore.getStore()?.turnId ?? null,
    });
  });
  try {
    await session.start({ agent: new Agent({ instructions: "probe" }) });
    const first = session.generateReply();
    await waitFor(() => llm.pending.length === 1 && llm.pending[0].entered, "first handle stream entered");
    first.interrupt();
    const second = session.generateReply({ userInput: "replacement" });
    await waitFor(() => llm.pending.length === 2 && llm.pending[1].entered, "replacement stream entered");
    llm.pending[1].headers.resolve();
    await Promise.all([first.waitForPlayout(), second.waitForPlayout()]);
    await waitFor(() => metrics.length === 2, "two handle metrics");
    results.push({
      test: "handle_specific_interrupt_and_replacement",
      created,
      first: { id: first.id, interrupted: first.interrupted },
      second: { id: second.id, interrupted: second.interrupted },
      metrics,
    });
  } finally {
    await session.close().catch(() => {});
  }
}

class PushAudioInput extends AudioInput {
  constructor() {
    super();
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
  }
  get stream() { return this.readable; }
  push(frame) { this.controller.enqueue(frame); }
  finish() { this.controller.close(); }
}

class HookRecordingAgent extends Agent {
  constructor(order) { super({ instructions: "probe" }); this.order = order; }
  async onUserTurnCompleted(_ctx, message) {
    this.order.push({ event: "onUserTurnCompleted", nonempty: Boolean(message.textContent) });
  }
}

async function callerTurnHookCase() {
  const order = [];
  const fakeStt = new stt.testing.FakeSTT();
  const llm = new ProbeLLM();
  const input = new PushAudioInput();
  const session = new AgentSession({
    stt: fakeStt,
    llm,
    vad: null,
    turnHandling: { turnDetection: "stt" },
  });
  session.input.audio = input;
  session.on(AgentSessionEventTypes.SpeechCreated, (event) => order.push({ event: "speech_created", speechId: event.speechHandle.id }));
  try {
    await session.start({ agent: new HookRecordingAgent(order) });
    const fakeStream = (await fakeStt.streamCh.next()).value;
    input.push(new AudioFrame(new Int16Array(160), 16000, 1, 160));
    fakeStream.sendFakeTranscript("hello", true);
    // Fake the provider's explicit end-of-speech after its final transcript.
    // This is the STT turn-detection boundary that commits the caller turn.
    fakeStream.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    await waitFor(() => order.some((x) => x.event === "onUserTurnCompleted"), "caller hook");
    await waitFor(() => order.some((x) => x.event === "speech_created") && llm.pending.length === 1, "caller reply handle");
    llm.pending[0].headers.resolve();
    await waitFor(() => llm.pending[0].entered, "caller llm stream");
    results.push({
      test: "fake_stt_accepted_caller_turn_order",
      order,
      hookBeforeSpeechCreated: order.findIndex((x) => x.event === "onUserTurnCompleted") < order.findIndex((x) => x.event === "speech_created"),
    });
  } finally {
    input.finish();
    await session.close().catch(() => {});
  }
}

class ProbeSynthesizeStream extends tts.SynthesizeStream {
  constructor(owner, options = {}) {
    super(owner, options.connOptions);
    this.label = "sdk464-fake-tts";
  }
  async run() {
    for await (const value of this.input) {
      if (typeof value !== "string") {
        this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
        return;
      }
      this.markStarted();
      if (value === "slow") await sleep(25);
      if (this.abortSignal.aborted) return;
      const frame = new AudioFrame(new Int16Array(480), 24000, 1, 480);
      this.queue.put({
        frame,
        requestId: `tts-${value}`,
        final: true,
        timedTranscripts: [{ text: value, startTime: 0, endTime: 0.02 }],
      });
    }
  }
}

class ProbeTTS extends tts.TTS {
  constructor() { super(24000, 1, { streaming: true }); this.label = "sdk464-fake-tts"; }
  synthesize() { throw new Error("not used by streaming probe"); }
  stream(options) { return new ProbeSynthesizeStream(this, options); }
}

async function ttsWrapperCase() {
  const fake = new ProbeTTS();
  const metrics = [];
  fake.on("metrics_collected", (metric) => metrics.push({ metric, trace: traceStore.getStore() }));
  let observedFirst = null;
  const defaultNode = (input, trace) => traceStore.run(trace, () => {
    const synth = fake.stream({});
    synth.updateInputStream(input);
    let cleaned = false;
    const cleanup = () => { if (!cleaned) { cleaned = true; synth.close(); } };
    return new ReadableStream({
      async start(controller) {
        try {
          for await (const event of synth) {
            if (event === tts.SynthesizeStream.END_OF_STREAM) break;
            event.frame.userdata.__probeTimed = event.timedTranscripts;
            controller.enqueue(event.frame);
          }
          controller.close();
        } finally { cleanup(); }
      },
      cancel() { cleanup(); },
    });
  });
  const wrap = async (input, trace) => {
    const stream = defaultNode(input, trace);
    return stream.pipeThrough(new TransformStream({
      transform(frame, controller) {
        if (!observedFirst) observedFirst = frame;
        controller.enqueue(frame);
      },
    }));
  };
  const input = new ReadableStream({ start(c) { c.enqueue("hello"); c.close(); } });
  const output = await wrap(input, { synthesisId: "synth-normal" });
  const reader = output.getReader();
  const first = await reader.read();
  const end = await reader.read();
  await waitFor(() => metrics.length === 1, "normal tts metric");

  const slowInput = new ReadableStream({ start(c) { c.enqueue("slow"); c.close(); } });
  const slowOutput = await wrap(slowInput, { synthesisId: "synth-cancel" });
  const slowReader = slowOutput.getReader();
  await slowReader.cancel("cancel before frame");
  await sleep(40);
  results.push({
    test: "tts_wrapper_context_and_passthrough",
    firstFrameIsOriginal: first.value === observedFirst,
    timedMetadataPreserved: first.value?.userdata?.__probeTimed?.[0]?.text === "hello",
    ended: end.done,
    metricTraceSynthesisId: metrics[0]?.trace?.synthesisId ?? null,
    normalMetricCancelled: metrics[0]?.metric.cancelled ?? null,
    preFrameCancelMetricCount: metrics.length - 1,
  });
}

await directCases();
await sessionSpeechIdCase();
await handleCancellationCase();
await callerTurnHookCase();
await ttsWrapperCase();
const direct = results.find((r) => r.test === "direct_stream_context");
assert.deepEqual(direct.metrics.map((m) => m.traceTurnId), [
  "turn-before-run", "turn-before-headers", "turn-after-headers",
  "turn-during-text", "turn-overlap-a", "turn-overlap-b",
]);
assert.deepEqual(direct.metrics.map((m) => m.cancelled), [true, true, true, true, false, false]);
assert.ok(direct.metrics.slice(0, 3).every((m) => m.requestId === "" && m.ttftMs === -1));
const sessionProof = results.find((r) => r.test === "session_speech_id");
assert.equal(sessionProof.speechId, sessionProof.handleId);
assert.equal(sessionProof.traceTurnId, "turn-auto-1");
const replacement = results.find((r) => r.test === "handle_specific_interrupt_and_replacement");
assert.equal(replacement.first.interrupted, true);
assert.equal(replacement.second.interrupted, false);
assert.deepEqual(replacement.metrics.map((m) => [m.speechId, m.traceTurnId]), [
  [replacement.first.id, "turn-auto-1"], [replacement.second.id, "turn-auto-2"],
]);
assert.equal(results.find((r) => r.test === "fake_stt_accepted_caller_turn_order").hookBeforeSpeechCreated, true);
const synth = results.find((r) => r.test === "tts_wrapper_context_and_passthrough");
assert.equal(synth.firstFrameIsOriginal, true);
assert.equal(synth.timedMetadataPreserved, true);
assert.equal(synth.ended, true);
assert.equal(synth.metricTraceSynthesisId, "synth-normal");
assert.equal(synth.preFrameCancelMetricCount, 0);
const runtime = {
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  agents: JSON.parse(readFileSync(resolve(runtimeRoot, "node_modules/@livekit/agents/package.json"), "utf8")).version,
  rtcNode: JSON.parse(readFileSync(resolve(runtimeRoot, "node_modules/@livekit/rtc-node/package.json"), "utf8")).version,
};
assert.equal(runtime.agents, "1.6.4");
assert.equal(runtime.rtcNode, "0.13.33");
console.log(JSON.stringify({ runtime, results }, null, 2));
