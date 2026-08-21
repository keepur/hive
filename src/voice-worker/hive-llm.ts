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
import { createLogger } from "../logging/logger.js";
import { serializeTranscript, type BridgeMessage } from "./chat-ctx.js";
import { classifyHttpFailure, type BridgeFailureClass } from "./error-map.js";
import { applyInterruptionMarker } from "./interruption-marker.js";
import { SSEParser } from "./sse.js";

const log = createLogger("hive-llm");

export class BridgeError extends Error {
  constructor(
    public readonly failureClass: BridgeFailureClass,
    message: string,
    /** True when at least one content chunk was already yielded (mid-stream). */
    public readonly bytesReceived: boolean,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface HiveLLMOptions {
  bridgeUrl: string;
  bridgeToken: string;
  hiveAgentId: string;
  callId: string; // = LiveKit room name, `call-<uuid>`
  goal: string;
  context: string;
}

export class HiveLLM extends llm.LLM {
  /** Set by the session layer when the previous agent turn was interrupted. */
  interruptedSpokenText: string | null = null;
  /** Per-turn bridge timing for §13 telemetry (read by the session layer). */
  lastTurnTiming: { llmTtftMs: number; maxInterChunkGapMs: number } | null = null;

  constructor(private readonly opts: HiveLLMOptions) {
    super();
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
    return new HiveLLMStream(this, this.opts, {
      chatCtx: chatOpts.chatCtx,
      toolCtx: chatOpts.toolCtx,
      connOptions: chatOpts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}

export class HiveLLMStream extends llm.LLMStream {
  constructor(
    private readonly parent: HiveLLM,
    private readonly opts: HiveLLMOptions,
    args: {
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContextLike;
      connOptions: APIConnectOptions;
    },
  ) {
    super(parent, args);
  }

  private toBridgeMessages(): BridgeMessage[] {
    // ChatContext → full transcript (§5.2). Item/text accessors pinned at 1.6.4.
    const turns = this.chatCtx.items
      .filter(
        (i): i is llm.ChatMessage & { role: "user" | "assistant" } =>
          i.type === "message" && (i.role === "user" || i.role === "assistant"),
      )
      .map((i) => ({ role: i.role, text: i.textContent ?? "" }));
    const msgs = serializeTranscript(turns);
    // §7: interruption marker prefixes the LATEST user message only.
    if (this.parent.interruptedSpokenText && msgs.length > 0) {
      for (let k = msgs.length - 1; k >= 0; k--) {
        if (msgs[k]!.role === "user") {
          msgs[k]!.content = applyInterruptionMarker(msgs[k]!.content, this.parent.interruptedSpokenText);
          break;
        }
      }
      this.parent.interruptedSpokenText = null; // consumed
    }
    return msgs;
  }

  protected async run(): Promise<void> {
    // Abort-before-first-token must not leak the previous turn's object into
    // TurnMetrics (EOU can join cancelled TTS before this turn's finally).
    this.parent.lastTurnTiming = null;
    const controller = new AbortController();
    // §7: framework cancels the stream (barge-in) → abort the HTTP request.
    const onAbort = () => controller.abort();
    this.abortController.signal.addEventListener("abort", onAbort);
    if (this.abortController.signal.aborted) controller.abort();

    const startedAt = Date.now();
    let firstTokenAt = 0;
    let lastChunkAt = 0;
    let maxGapMs = 0;
    let yielded = false;
    try {
      const res = await fetch(this.opts.bridgeUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.bridgeToken}`,
        },
        body: JSON.stringify({
          stream: true,
          messages: this.toBridgeMessages(),
          call: {
            id: this.opts.callId,
            metadata: {
              hive_agent_id: this.opts.hiveAgentId,
              goal: this.opts.goal,
              context: this.opts.context,
            },
          },
        }),
      });
      if (!res.ok || !res.body) {
        const snippet = (await res.text().catch(() => "")).slice(0, 200);
        throw new BridgeError(classifyHttpFailure(res.status, snippet), `bridge HTTP ${res.status}: ${snippet}`, false);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SSEParser();
      const requestId = `hive-${randomUUID()}`;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          if (ev.kind === "content") {
            if (this.abortController.signal.aborted) return;
            const now = Date.now();
            if (!firstTokenAt) {
              firstTokenAt = now;
              // New object so TurnMetrics can tell this-turn TTFT from a
              // leftover prior-turn lastTurnTiming snapshotted at EOU.
              this.parent.lastTurnTiming = {
                llmTtftMs: firstTokenAt - startedAt,
                maxInterChunkGapMs: maxGapMs,
              };
            }
            if (lastChunkAt) maxGapMs = Math.max(maxGapMs, now - lastChunkAt);
            lastChunkAt = now;
            yielded = true;
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
      if (controller.signal.aborted || this.abortController.signal.aborted) {
        log.info("Bridge request aborted (barge-in)", { callId: this.opts.callId });
        return; // cancelled turn — not an error
      }
      if (err instanceof BridgeError) throw err;
      const failureClass: BridgeFailureClass = yielded ? "midstream_error" : "engine_unreachable";
      throw new BridgeError(failureClass, String(err), yielded);
    } finally {
      this.abortController.signal.removeEventListener("abort", onAbort);
      this.parent.lastTurnTiming = {
        llmTtftMs: firstTokenAt ? firstTokenAt - startedAt : -1,
        maxInterChunkGapMs: maxGapMs,
      };
      // Do not queue.close() — 1.6.4 LLMStream already closes in startSoon's finally.
    }
  }
}
