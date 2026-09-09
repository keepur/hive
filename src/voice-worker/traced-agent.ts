import { randomUUID } from "node:crypto";
import { ReadableStream, type ReadableStreamDefaultController, type ReadableStreamReadResult } from "node:stream/web";

import { tts, voice } from "@livekit/agents";

import type { AttemptOutcome, CancellationCause } from "../voice/voice-trace.js";
import type { SpeechTracePort, SynthesisAttempt } from "./speech-trace.js";
import { synthesisTraceContext, type SynthesisTraceContext } from "./trace-context.js";

type AgentOptions = ConstructorParameters<typeof voice.Agent>[0];

export interface TracedAgentOptions extends AgentOptions {
  callId: string;
  workerBootId: string;
  callSignal: AbortSignal;
  trace: SpeechTracePort;
  onAcceptedUserTurn: () => void;
}

/**
 * Observe the actual default TTS stream without buffering or replacing frames.
 * Cancellation is latched before the upstream reader is touched, so a pending
 * read that settles during cancellation cannot publish a frame or completion.
 */
export function observeTtsStream<T extends { sampleRate: number; samplesPerChannel: number }>(
  input: ReadableStream<T>,
  attempt: {
    frame(meta: { sampleRate: number; samplesPerChannel: number }): void;
    fail(errorClass: "tts_node_failed"): void;
    finish(outcome: AttemptOutcome, cause: CancellationCause): void;
  },
  signal: AbortSignal,
): ReadableStream<T> {
  const reader = input.getReader();
  let state: "open" | "cancelled" | "finished" = "open";
  let pending: Promise<ReadableStreamReadResult<T>> | null = null;
  let cancelPromise: Promise<void> | null = null;
  let released = false;
  let output: ReadableStreamDefaultController<T>;

  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  };

  const cancelOwned = (cause: CancellationCause, closeOutput: boolean): Promise<void> => {
    if (state !== "open") return cancelPromise ?? Promise.resolve();
    state = "cancelled";
    attempt.finish("cancelled", cause);
    if (closeOutput) {
      try {
        output.close();
      } catch {
        // Output may already have been closed by the consumer.
      }
    }
    const activeRead = pending;
    let cancellation: Promise<void>;
    try {
      cancellation = reader.cancel();
    } catch {
      cancellation = Promise.resolve();
    }
    cancelPromise = Promise.allSettled([cancellation, activeRead]).then(() => {
      release();
    });
    return cancelPromise;
  };

  const onAbort = () => {
    void cancelOwned("call_closed", true);
  };

  return new ReadableStream<T>(
    {
      start(controller) {
        output = controller;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      },
      async pull(controller) {
        if (state !== "open") return;
        try {
          pending = reader.read();
          const next = await pending;
          if (state !== "open") return;
          if (next.done) {
            state = "finished";
            attempt.finish("completed", "unknown");
            release();
            controller.close();
            return;
          }
          attempt.frame({
            sampleRate: next.value.sampleRate,
            samplesPerChannel: next.value.samplesPerChannel,
          });
          controller.enqueue(next.value);
        } catch {
          if (state !== "open") return;
          state = "finished";
          attempt.fail("tts_node_failed");
          attempt.finish("failed", "unknown");
          release();
          controller.error(new Error("Voice synthesis failed"));
        } finally {
          pending = null;
        }
      },
      cancel() {
        return cancelOwned("framework_cancelled", false);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Agent hook adapter that preserves the SDK default behavior and records it. */
export class TracedAgent extends voice.Agent {
  readonly #callId: string;
  readonly #workerBootId: string;
  readonly #callSignal: AbortSignal;
  readonly #trace: SpeechTracePort;
  readonly #onAcceptedUserTurn: () => void;
  readonly #ttsProvider: tts.TTS | undefined;
  #disposed = false;

  readonly #onTtsError = () => {
    const context = synthesisTraceContext.getStore();
    if (
      context &&
      context.callId === this.#callId &&
      context.workerBootId === this.#workerBootId &&
      context.synthesisId.length > 0
    ) {
      this.#trace.synthesisFailure(context.synthesisId, "tts_provider_failed");
      return;
    }
    this.#trace.unboundProviderFailure("tts", "tts_provider_failed");
  };

  constructor(options: TracedAgentOptions) {
    const { callId, workerBootId, callSignal, trace, onAcceptedUserTurn, ...agentOptions } = options;
    super(agentOptions);
    this.#callId = callId;
    this.#workerBootId = workerBootId;
    this.#callSignal = callSignal;
    this.#trace = trace;
    this.#onAcceptedUserTurn = onAcceptedUserTurn;
    this.#ttsProvider = this.tts;
    this.#ttsProvider?.on("error", this.#onTtsError);
  }

  override onUserTurnCompleted(
    ...args: Parameters<voice.Agent["onUserTurnCompleted"]>
  ): ReturnType<voice.Agent["onUserTurnCompleted"]> {
    const [, newMessage] = args;
    if (newMessage.textContent?.trim()) this.#onAcceptedUserTurn();
    return Promise.resolve();
  }

  override async ttsNode(...args: Parameters<voice.Agent["ttsNode"]>): ReturnType<voice.Agent["ttsNode"]> {
    const context: SynthesisTraceContext = Object.freeze({
      workerBootId: this.#workerBootId,
      callId: this.#callId,
      synthesisId: randomUUID(),
    });
    const attempt: SynthesisAttempt = this.#trace.synthesisCreated(context);
    try {
      const input = await synthesisTraceContext.run(context, () => voice.Agent.default.ttsNode(this, ...args));
      if (input === null) {
        attempt.finish("completed", "unknown");
        return null;
      }
      return observeTtsStream(input, attempt, this.#callSignal);
    } catch (error) {
      attempt.fail("tts_node_failed");
      attempt.finish("failed", "unknown");
      throw error;
    }
  }

  /** Remove the exact provider listener installed by this call-local agent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ttsProvider?.off("error", this.#onTtsError);
  }
}
