import { AsyncLocalStorage } from "node:async_hooks";
import { ReadableStream, type ReadableStreamDefaultController } from "node:stream/web";
import {
  AgentSession,
  AudioInput,
  AudioOutput,
  DEFAULT_API_CONNECT_OPTIONS,
  LLM,
  LLMStream,
  USERDATA_TIMED_TRANSCRIPT,
  VAD,
  VADEventType,
  VADStream,
  createTimedString,
  stt,
  tts,
  type APIConnectOptions,
  type ChatContext,
  type ToolContextLike,
  type VADEvent,
} from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";

export type NamedBarrier<T = void> = ReturnType<typeof gate<T>> & { readonly name: string };

export function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A gate whose name is preserved in scenario evidence and assertion failures. */
export function namedBarrier<T = void>(name: string): NamedBarrier<T> {
  return { name, ...gate<T>() };
}

export type BridgePhase =
  "created" | "run_entered" | "request_received" | "headers_sent" | "first_text" | "ended" | "aborted";

export type CapabilityContext = {
  turnId?: string;
  synthesisId?: string;
};

export type SpeechHandle = ReturnType<AgentSession["generateReply"]>;

export const capabilityContext = new AsyncLocalStorage<Readonly<CapabilityContext>>();

export async function until(check: () => boolean, label: string, timeoutMs = 2_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timeout: ${label}`);
}

export function fixtureAudioFrame(sampleRate = 24_000, samples = 480): AudioFrame {
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

export class PushAudioInput extends AudioInput {
  readonly readable: ReadableStream<AudioFrame>;
  private controller!: ReadableStreamDefaultController<AudioFrame>;

  constructor() {
    super();
    this.readable = new ReadableStream<AudioFrame>({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  override get stream(): ReadableStream<AudioFrame> {
    return this.readable;
  }

  push(frame = fixtureAudioFrame(16_000, 160)): void {
    this.controller.enqueue(frame);
  }

  finish(): void {
    this.controller.close();
  }
}

export class CaptureAudioOutput extends AudioOutput {
  readonly frames: AudioFrame[] = [];
  readonly events: string[] = [];
  clears = 0;
  private paused = false;

  constructor(events?: string[]) {
    super(24_000, undefined, { pause: true });
    if (events) this.events = events;
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.frames.push(frame);
    this.events.push("output_frame");
    this.onPlaybackStarted(Date.now());
  }

  override flush(): void {
    super.flush();
    this.events.push("output_flush");
    if (!this.paused) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }

  override clearBuffer(): void {
    this.clears += 1;
    this.events.push("output_clear");
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }

  override pause(): void {
    this.paused = true;
  }

  override resume(): void {
    this.paused = false;
    if (this.frames.length > 0) {
      this.onPlaybackStarted(Date.now());
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }

  /** Text attached by Agent.default.ttsNode to frames that reached fake playout. */
  transcriptTexts(): string[] {
    return this.frames.flatMap((frame) => {
      const timed = frame.userdata?.[USERDATA_TIMED_TRANSCRIPT] as Array<{ text?: string }> | undefined;
      return timed?.map((entry) => entry.text ?? "") ?? [];
    });
  }
}

export class ScriptedSpeechStream extends stt.SpeechStream {
  override label = "kpr464-scripted-stt";

  protected override async run(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.abortSignal.aborted) resolve();
      else this.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  emit(event: stt.SpeechEvent): void {
    this.queue.put(event);
  }
}

export class ScriptedSTT extends stt.STT {
  override label = "kpr464-scripted-stt";
  readonly ready = gate<ScriptedSpeechStream>();

  constructor() {
    super({ streaming: true, interimResults: true });
  }

  protected override async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error("streaming only");
  }

  override stream(options?: { connOptions?: APIConnectOptions }): ScriptedSpeechStream {
    const stream = new ScriptedSpeechStream(this, undefined, options?.connOptions);
    this.ready.resolve(stream);
    return stream;
  }
}

export class ScriptedVADStream extends VADStream {
  emit(event: VADEvent): void {
    this.sendVADEvent(event);
  }
}

export class ScriptedVAD extends VAD {
  override label = "kpr464-scripted-vad";
  readonly ready = gate<ScriptedVADStream>();

  constructor() {
    super({ updateInterval: 1_000 });
  }

  override stream(): ScriptedVADStream {
    const stream = new ScriptedVADStream(this);
    this.ready.resolve(stream);
    return stream;
  }
}

export function vadEvent(type: VADEventType): VADEvent {
  return {
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
  };
}

export function transcript(type: stt.SpeechEventType, text = "hello"): stt.SpeechEvent {
  return {
    type,
    alternatives: [
      {
        text,
        language: "en" as never,
        startTime: 0,
        endTime: 0.02,
        confidence: 1,
      },
    ],
  };
}

export type TtsMode = "normal" | "hold-before-frame" | "hold-after-frame" | "error-before-frame" | "error-after-frame";

export type TtsPlan = {
  mode: TtsMode;
  entered?: ReturnType<typeof gate<void>>;
  release?: ReturnType<typeof gate<void>>;
};

export class ControlledSynthesizeStream extends tts.SynthesizeStream {
  override label = "kpr464-controlled-tts";
  readonly done = gate<void>();

  constructor(
    private readonly owner: ControlledTTS,
    private readonly plan: TtsPlan,
    connOptions?: APIConnectOptions,
  ) {
    super(owner, connOptions);
  }

  protected override async run(): Promise<void> {
    try {
      for await (const value of this.input) {
        if (typeof value !== "string") return;
        this.markStarted();
        this.plan.entered?.resolve();
        if (this.plan.release && this.plan.mode !== "hold-after-frame") {
          await Promise.race([this.plan.release?.promise, aborted(this.abortSignal)]);
          if (this.abortSignal.aborted) return;
        }
        if (this.plan.mode === "error-before-frame") {
          throw new Error("synthetic TTS failure before frame");
        }
        const frame = fixtureAudioFrame();
        this.owner.frames.push(frame);
        this.queue.put({
          frame,
          requestId: `tts-${value}`,
          final: true,
          segmentId: `segment-${value}`,
          timedTranscripts: [createTimedString({ text: value, startTime: 0, endTime: 0.02 })],
        });
        if (this.plan.mode === "error-after-frame") {
          throw new Error("synthetic TTS failure after frame");
        }
        if (this.plan.mode === "hold-after-frame") {
          await Promise.race([this.plan.release?.promise, aborted(this.abortSignal)]);
        }
      }
    } finally {
      this.done.resolve();
    }
  }
}

export class ControlledTTS extends tts.TTS {
  override label = "kpr464-controlled-tts";
  readonly frames: AudioFrame[] = [];
  readonly streams: ControlledSynthesizeStream[] = [];
  readonly plans: TtsPlan[] = [];
  defaultMode: TtsMode = "normal";

  constructor() {
    super(24_000, 1, { streaming: true });
  }

  override synthesize(): tts.ChunkedStream {
    throw new Error("streaming only");
  }

  override stream(options?: { connOptions?: APIConnectOptions }): ControlledSynthesizeStream {
    const plan = this.plans.shift() ?? { mode: this.defaultMode };
    const stream = new ControlledSynthesizeStream(this, plan, options?.connOptions);
    this.streams.push(stream);
    return stream;
  }
}

export type LlmPlan = {
  turnId: string;
  text?: string;
  fail?: boolean;
  holdBeforeText?: ReturnType<typeof gate<void>>;
  holdAfterText?: ReturnType<typeof gate<void>>;
};

export class ControlledLLMStream extends LLMStream {
  readonly entered = gate<void>();

  constructor(
    private readonly owner: ControlledLLM,
    args: {
      chatCtx: ChatContext;
      toolCtx?: ToolContextLike;
      connOptions: APIConnectOptions;
    },
    readonly plan: LlmPlan,
  ) {
    super(owner, args);
  }

  protected override async run(): Promise<void> {
    this.owner.events.push({ event: "llm_run", turnId: this.plan.turnId });
    this.entered.resolve();
    if (this.plan.holdBeforeText) {
      await Promise.race([this.plan.holdBeforeText.promise, aborted(this.abortController.signal)]);
    }
    if (this.abortController.signal.aborted) return;
    if (this.plan.fail) {
      this.owner.events.push({
        event: "application_error",
        turnId: capabilityContext.getStore()?.turnId ?? null,
      });
      throw new Error(`synthetic bridge failure for ${this.plan.turnId}`);
    }
    this.queue.put({
      id: `provider-${this.plan.turnId}`,
      delta: { role: "assistant", content: this.plan.text ?? "Hello." },
    });
    if (this.plan.holdAfterText) {
      await Promise.race([this.plan.holdAfterText.promise, aborted(this.abortController.signal)]);
    }
  }
}

export class ControlledLLM extends LLM {
  readonly plans: LlmPlan[] = [];
  readonly streams: ControlledLLMStream[] = [];
  readonly events: Array<{ event: string; turnId: string | null }> = [];
  readonly requests: Array<Array<{ role: string; text: string }>> = [];

  override label(): string {
    return "kpr464-controlled-llm";
  }

  override chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
  }): ControlledLLMStream {
    const plan = this.plans.shift();
    if (!plan) throw new Error("test did not supply an LLM plan");
    this.requests.push(
      chatCtx.items
        .filter((item) => item.type === "message")
        .map((item) => ({ role: item.role, text: item.textContent ?? "" })),
    );
    return capabilityContext.run(Object.freeze({ turnId: plan.turnId }), () => {
      this.events.push({ event: "llm_constructed", turnId: plan.turnId });
      const stream = new ControlledLLMStream(
        this,
        { chatCtx, toolCtx, connOptions: { ...connOptions, maxRetry: 0 } },
        plan,
      );
      this.streams.push(stream);
      return stream;
    });
  }
}

export type StartupSession = {
  generateReply(): SpeechHandle;
};

export class StartupObserver {
  answered = false;
  speaking = false;
  pendingFinal = false;
  accepted = false;
  openingRequested = false;
  terminal = false;
  opening?: SpeechHandle;

  constructor(
    private readonly session: StartupSession,
    readonly events: string[],
  ) {}

  onUserState(newState: string): void {
    this.events.push(`user_state_${newState}`);
    this.speaking = newState === "speaking";
    this.evaluate();
  }

  onTranscript(text: string, isFinal: boolean): void {
    this.events.push(isFinal ? "final_transcript" : "provisional_transcript");
    if (isFinal && text.trim()) this.pendingFinal = true;
  }

  answer(): void {
    this.answered = true;
    this.events.push("answer_observed");
    this.evaluate();
  }

  accept(text: string): void {
    if (!text.trim() || this.terminal) return;
    this.accepted = true;
    this.pendingFinal = false;
    this.events.push("startup_caller_accepted");
    if (this.opening?.interrupted) this.events.push("owned_opening_already_interrupted");
    else if (this.opening && !this.opening.done()) {
      this.events.push("cancel_owned_opening");
      this.opening.interrupt();
    }
  }

  evaluate(): void {
    if (this.terminal || !this.answered || this.accepted || this.openingRequested || this.speaking) {
      return;
    }
    if (this.pendingFinal) {
      this.events.push("defer_pending_final");
      return;
    }
    this.openingRequested = true;
    this.events.push("request_opening");
    this.opening = this.session.generateReply();
  }

  close(): void {
    this.terminal = true;
  }
}

export function observeNodeForCancellation(
  upstreamStream: ReadableStream<AudioFrame>,
  events: string[],
): ReadableStream<AudioFrame> {
  const upstream = upstreamStream.getReader();
  let cancelled = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    events.push("cleanup");
    try {
      upstream.releaseLock();
    } catch {}
  };
  return new ReadableStream<AudioFrame>(
    {
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
        } finally {
          cleanup();
        }
      },
    },
    { highWaterMark: 0 },
  );
}

export function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
