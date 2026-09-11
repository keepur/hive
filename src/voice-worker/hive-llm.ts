/**
 * HiveLLM (KPR-322 §5) — custom llm.LLM that makes hive's spawn path the
 * pipeline's LLM node. POSTs each turn to the engine's OpenAI-compatible
 * voice endpoint (SSE) and yields ChatChunks per text delta. Never buffers
 * (§5.4 — buffering kills the stream). Aborts the HTTP request the moment
 * the framework cancels the stream (§7).
 *
 * NOTE (Task-0 pin): subclass surface follows the installed agents-js 1.6.4
 * (`llm.LLM` / `llm.LLMStream`): required `label()`, `chat()` accepts the
 * full 1.6.4 options object, `LLMStream` ctor requires `connOptions`
 * (default `DEFAULT_API_CONNECT_OPTIONS`), `protected run()` is started by
 * the base class via `startSoon` (do not self-call from the ctor), and the
 * base `finally` already `queue.close()`s (do not double-close). Fallback
 * shape if subclassing regresses: llmNode override returning
 * ReadableStream<ChatChunk>.
 */
import { llm, DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions } from "@livekit/agents";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createLogger } from "../logging/logger.js";
import { VOICE_PROCESS_ID, type VoiceTraceMetadata } from "../voice/voice-trace.js";
import { serializeTranscript, type BridgeMessage } from "./chat-ctx.js";
import { classifyHttpFailure, type BridgeFailureClass } from "./error-map.js";
import { applyInterruptionMarker } from "./interruption-marker.js";
import type { BridgeAttempt, SpeechTracePort } from "./speech-trace.js";
import { SSEParser } from "./sse.js";
import { bridgeTraceContext, type BridgeTraceContext } from "./trace-context.js";

const log = createLogger("hive-llm");
const MAX_FAILURE_BODY_BYTES = 800;
const MAX_FAILURE_SNIPPET_CHARS = 200;

async function readFailureSnippet(res: Response, observe: (snippet: string) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let snippet = "";
  const observeBounded = () => observe(snippet.slice(0, MAX_FAILURE_SNIPPET_CHARS));
  try {
    while (byteCount < MAX_FAILURE_BODY_BYTES && snippet.length < MAX_FAILURE_SNIPPET_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_FAILURE_BODY_BYTES - byteCount;
      const bounded = value.subarray(0, remaining);
      byteCount += bounded.byteLength;
      snippet += decoder.decode(bounded, { stream: byteCount < MAX_FAILURE_BODY_BYTES });
      // Refine before the next read can block. A call abort/trace close may
      // happen while that read is pending, and must see the same class as the
      // exact BridgeError that already owns this status failure.
      observeBounded();
    }
    snippet += decoder.decode();
    observeBounded();
  } catch {
    // Headers/status already own the failure; body diagnostics are optional.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The observed HTTP failure remains authoritative.
    }
    try {
      reader.releaseLock();
    } catch {
      // A failed release is cleanup-only.
    }
  }
}

const bridgeErrorFailureClasses = new WeakMap<BridgeError, BridgeFailureClass>();

export class BridgeError extends Error {
  constructor(
    failureClass: BridgeFailureClass,
    public readonly turnId: string,
    /** True when at least one content chunk was already yielded (mid-stream). */
    public readonly bytesReceived: boolean,
  ) {
    super("Hive voice bridge request failed");
    this.name = "BridgeError";
    bridgeErrorFailureClasses.set(this, failureClass);
  }

  get failureClass(): BridgeFailureClass {
    return bridgeErrorFailureClasses.get(this)!;
  }
}

function refineFailureClass(failure: BridgeError, failureClass: BridgeFailureClass): void {
  bridgeErrorFailureClasses.set(failure, failureClass);
}

export interface HiveLLMOptions {
  bridgeUrl: string;
  bridgeToken: string;
  hiveAgentId: string;
  callId: string; // = LiveKit room name, `call-<uuid>`
  goal: string;
  context: string;
  trace: SpeechTracePort;
  callSignal?: AbortSignal;
}

export class HiveLLM extends llm.LLM {
  /** Set by the session layer when the previous agent turn was interrupted. */
  interruptedSpokenText: string | null = null;
  readonly #ownedFailures = new Map<string, BridgeError>();
  readonly callSignal: AbortSignal;

  constructor(private readonly opts: HiveLLMOptions) {
    super();
    this.callSignal = opts.callSignal ?? new AbortController().signal;
    this.prependListener("error", (event) => {
      const failure = event.error;
      if (failure instanceof BridgeError && this.#ownedFailures.get(failure.turnId) === failure) {
        event.recoverable = true;
        this.#ownedFailures.delete(failure.turnId);
      }
    });
  }

  ownFailure(failure: BridgeError): void {
    const previous = this.#ownedFailures.get(failure.turnId);
    if (previous && previous !== failure) {
      this.opts.trace.actionGap("action_ownership_unproved", null, failure.turnId);
      return;
    }
    while (this.#ownedFailures.size >= 256) {
      const oldest = this.#ownedFailures.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#ownedFailures.delete(oldest);
      this.opts.trace.actionGap("action_overflow", null, oldest);
    }
    this.#ownedFailures.set(failure.turnId, failure);
  }

  label(): string {
    return "hive-llm";
  }

  chat(chatOpts: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): HiveLLMStream {
    const traceContext = Object.freeze({
      workerBootId: VOICE_PROCESS_ID,
      callId: this.opts.callId,
      turnId: randomUUID(),
    });
    const attempt = this.opts.trace.bridgeCreated(traceContext);
    try {
      return bridgeTraceContext.run(
        traceContext,
        () =>
          new HiveLLMStream(
            this,
            this.opts,
            {
              chatCtx: chatOpts.chatCtx,
              toolCtx: chatOpts.toolCtx,
              connOptions: chatOpts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
            },
            traceContext,
            attempt,
          ),
      );
    } catch (error) {
      attempt.fail("stream_construction_failed");
      attempt.finish("failed", "unknown");
      throw error;
    }
  }
}

export class HiveLLMStream extends llm.LLMStream {
  readonly traceContext: BridgeTraceContext;
  private readonly attempt: BridgeAttempt;
  private readonly onLifecycleAbort: () => void;
  private runEntered = false;

  constructor(
    private readonly parent: HiveLLM,
    private readonly opts: HiveLLMOptions,
    args: {
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContextLike;
      connOptions: APIConnectOptions;
    },
    traceContext: BridgeTraceContext,
    attempt: BridgeAttempt,
  ) {
    super(parent, args);
    this.traceContext = traceContext;
    this.attempt = attempt;
    this.onLifecycleAbort = () => {
      if (!this.runEntered) this.attempt.finish("cancelled", "framework_cancelled");
    };
    this.abortController.signal.addEventListener("abort", this.onLifecycleAbort, { once: true });
  }

  private toBridgeMessages(interruptedSpokenText: string | null): BridgeMessage[] {
    // ChatContext → full transcript (§5.2). Item/text accessors pinned at 1.6.4.
    const turns = this.chatCtx.items
      .filter(
        (i): i is llm.ChatMessage & { role: "user" | "assistant" } =>
          i.type === "message" && (i.role === "user" || i.role === "assistant"),
      )
      .map((i) => ({ role: i.role, text: i.textContent ?? "" }));
    const msgs = serializeTranscript(turns);
    // §7: interruption marker prefixes the LATEST user message only.
    // Apply from a local copy — do not mutate parent.interruptedSpokenText here
    // so a §8 retry stream (budget_saturated / spawn_failed) still prefixes,
    // and a second toBridgeMessages() in this run() cannot double-prefix via
    // a cleared-then-re-read flag.
    if (interruptedSpokenText && msgs.length > 0) {
      for (let k = msgs.length - 1; k >= 0; k--) {
        if (msgs[k]!.role === "user") {
          msgs[k]!.content = applyInterruptionMarker(msgs[k]!.content, interruptedSpokenText);
          break;
        }
      }
    }
    return msgs;
  }

  protected async run(): Promise<void> {
    this.runEntered = true;
    if (this.abortController.signal.aborted || this.parent.callSignal.aborted) {
      this.abortController.signal.removeEventListener("abort", this.onLifecycleAbort);
      this.attempt.finish("cancelled", this.parent.callSignal.aborted ? "call_closed" : "framework_cancelled");
      return;
    }

    const controller = new AbortController();
    const onFetchAbort = () => controller.abort();
    const onCallAbort = () => controller.abort();
    this.abortController.signal.addEventListener("abort", onFetchAbort, { once: true });
    this.parent.callSignal.addEventListener("abort", onCallAbort, { once: true });
    if (this.abortController.signal.aborted) onFetchAbort();
    if (this.parent.callSignal.aborted) onCallAbort();

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let yielded = false;
    let responseStatus: number | undefined;
    let observedFailure: BridgeError | null = null;
    let outcome: "completed" | "cancelled" | "failed" = "completed";
    let cause: "framework_cancelled" | "call_closed" | "unknown" = "unknown";
    this.attempt.started();
    try {
      // Snapshot once so a second toBridgeMessages() in this run cannot
      // re-read a mutated flag; clear the parent field only after POST ok.
      const spokenText = this.parent.interruptedSpokenText;
      const messages = this.toBridgeMessages(spokenText);
      const res = await fetch(this.opts.bridgeUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.bridgeToken}`,
        },
        body: JSON.stringify({
          stream: true,
          messages,
          call: {
            id: this.opts.callId,
            metadata: {
              hive_agent_id: this.opts.hiveAgentId,
              goal: this.opts.goal,
              context: this.opts.context,
            },
          },
          metadata: {
            voiceTrace: {
              schemaVersion: 2,
              workerBootId: this.traceContext.workerBootId,
              turnId: this.traceContext.turnId,
            } satisfies VoiceTraceMetadata,
          },
        }),
      });
      responseStatus = res.status;
      this.attempt.response(res.status);
      if (!res.ok || !res.body) {
        observedFailure = new BridgeError(
          res.ok ? "engine_unreachable" : classifyHttpFailure(res.status, ""),
          this.traceContext.turnId,
          false,
        );
        // Status headers are already a direct application failure. Own that
        // exact error before reading the optional body so a later teardown
        // abort cannot erase it while classification is pending.
        this.attempt.fail(observedFailure.failureClass);
        this.parent.ownFailure(observedFailure);
        if (!res.ok) {
          const failure = observedFailure;
          await readFailureSnippet(res, (snippet) => {
            const refinedClass = classifyHttpFailure(res.status, snippet);
            if (refinedClass === failure.failureClass) return;
            refineFailureClass(failure, refinedClass);
            this.attempt.refineFailure(refinedClass);
          });
        }
        throw observedFailure;
      }
      // Engine accepted the marked user message. Leave the flag cleared on a
      // later barge-in abort — do not restore. BridgeError (503/500) above
      // leaves the flag set so §8's generateReply() retry still prefixes.
      this.parent.interruptedSpokenText = null;
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SSEParser();
      const requestId = `hive-${this.traceContext.turnId}`;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          if (ev.kind === "content") {
            if (this.abortController.signal.aborted) {
              outcome = "cancelled";
              cause = "framework_cancelled";
              return;
            }
            if (ev.text.length === 0) continue;
            yielded = true;
            this.attempt.text(ev.text.length, performance.now());
            // Yield immediately — NEVER buffer (§5.4).
            this.queue.put({ id: requestId, delta: { role: "assistant", content: ev.text } });
          } else {
            // done frame: [DONE] follows; loop ends when the body closes.
          }
        }
      }
      // Degenerate zero-content turn (§5.1): stream ends empty — no-reply,
      // the session synthesizes nothing.
    } catch (err) {
      if (
        observedFailure === null &&
        (controller.signal.aborted || this.abortController.signal.aborted || this.parent.callSignal.aborted)
      ) {
        outcome = "cancelled";
        cause = this.parent.callSignal.aborted ? "call_closed" : "framework_cancelled";
        log.info("Bridge request aborted", {
          callId: this.opts.callId,
          turnId: this.traceContext.turnId,
          cause,
        });
        return; // cancelled turn — not an error
      }
      const failure =
        observedFailure ??
        (err instanceof BridgeError
          ? err
          : new BridgeError(yielded ? "midstream_error" : "engine_unreachable", this.traceContext.turnId, yielded));
      outcome = "failed";
      if (observedFailure === null) this.attempt.fail(failure.failureClass);
      log.warn("Bridge request failed", {
        callId: this.opts.callId,
        turnId: this.traceContext.turnId,
        failureClass: failure.failureClass,
        status: responseStatus,
      });
      if (observedFailure === null) this.parent.ownFailure(failure);
      throw failure;
    } finally {
      this.abortController.signal.removeEventListener("abort", onFetchAbort);
      this.parent.callSignal.removeEventListener("abort", onCallAbort);
      this.abortController.signal.removeEventListener("abort", this.onLifecycleAbort);
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // The original bridge outcome remains authoritative.
        }
        try {
          reader.releaseLock();
        } catch {
          // A failed release is cleanup-only and does not replace the request outcome.
        }
      }
      this.attempt.finish(outcome, cause);
      // Do not queue.close() — 1.6.4 LLMStream already closes in startSoon's finally.
    }
  }
}
