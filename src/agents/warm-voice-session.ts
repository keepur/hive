import type { Query, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunResult, StreamCallback } from "./agent-runner.js";
// Type-only import — erased at compile time, so no runtime cycle with
// agent-manager.ts (which imports this module at runtime).
import type { TurnContext, TurnResult } from "./agent-manager.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("warm-voice-session");

/**
 * KPR-323 §4.2/§4.7: release constants. Deliberately NOT config — the
 * enabled flag is the rollback lever; these are pilot-tunable by code
 * change only (spec §11 ⚠). Lifetime cap aligns with the voice adapter's
 * CallSession TTL (`SESSION_TTL_MS` in voice-adapter.ts).
 */
export const WARM_IDLE_TIMEOUT_MS = 120_000;
export const WARM_LIFETIME_CAP_MS = 2 * 60 * 60 * 1000;
/**
 * Grace window after a RESOLVED interrupt() for the interrupted turn's
 * `result` to arrive before the silent-wedge backstop closes the lease
 * (plan review r1 adv. 5). Constant, not config — same ruling as above.
 */
export const WARM_INTERRUPT_GRACE_MS = 10_000;

/**
 * Logging is the one unguarded step inside the otherwise-guarded no-throw
 * paths: `createLogger` writes `JSON.stringify(entry)` to a raw stream
 * (logging/logger.ts), and a stream write can throw synchronously on a dead
 * fd. Every log emitted from a timer callback, a promise rejection handler,
 * or close() therefore goes through this wrapper — otherwise the throw-safety
 * contract holds only "in practice" (spec §4.2 is explicit that it must hold
 * unconditionally: a throwing close() skips the agent's remaining tickets in
 * stopAgent's un-try/caught ticket walk).
 */
function safeLog(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
  try {
    log[level](msg, data);
  } catch {
    // A logger that cannot log is not a reason to break the caller.
  }
}

/**
 * Push-based AsyncIterable used as the streaming-input `prompt` of the
 * lease's query(). push() enqueues (or hands directly to a waiting
 * consumer); end() terminates iteration. After end(), push() is a silent
 * no-op — close() may race a late turn, and the turn-level failure path
 * owns the fallout (spec §6). Exported for tests.
 */
export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export interface WarmTurnRequest {
  /** Turn text — the adapter-shaped prompt (prepareSpawn's voice carve-out is a passthrough). */
  text: string;
  onStream?: StreamCallback;
  /** Per-turn watchdog, mapping the cold path's deadline (agent timeoutMs, default 300s). */
  timeoutMs: number;
}

export interface WarmVoiceSessionDeps {
  agentId: string;
  threadKey: string;
  /**
   * Invoked exactly once, from close(). The manager wires: registry delete
   * (identity-checked), coordinator-lambda release (frees lock + budget +
   * ticket), and release-time reflection credit (spec §4.5). close() guards
   * the call — a throwing onClosed is logged and swallowed.
   */
  onClosed: (info: { reason: string; turns: number }) => void;
}

/**
 * KPR-323 C2: per-call warm session lease (spec §4.2). One instance per
 * active voice call; bound to one long-lived streaming-input Query.
 *
 * Throw-safety contract (spec §4.2, load-bearing):
 *  - Timer callbacks are try/catch-wrapped — they run on bare setTimeout,
 *    where a synchronous throw is an uncaughtException (the engine
 *    registers only an unhandledRejection handler — see index.ts's
 *    `process.on("unhandledRejection", ...)`).
 *  - close() is no-throw and idempotent. It is invoked from at least four
 *    contexts: the timers; ticket.abort() via stopAgent's ticket walk —
 *    which has NO per-ticket try/catch (see the `for (const ticket of
 *    tickets) ticket.abort()` loop in agent-manager.ts's `stopAgent`), so a
 *    throwing close() would skip the agent's remaining tickets; the
 *    turn-failure path; and engine shutdown.
 *  - interrupt()'s Promise is always given a .catch (requestInterrupt).
 */
export class WarmVoiceSession {
  readonly openedAt = Date.now();
  /** §4.5: final turn's ctx/result, set by the manager per turn for release-time reflection credit. */
  lastTurn: { ctx: TurnContext; result: TurnResult } | null = null;

  private query: Query | null = null;
  private readonly input = new AsyncPushQueue<SDKUserMessage>();
  private closed = false;
  private closeReason: string | null = null;
  private turnCount = 0;
  private turnInFlight = false;
  private interruptRequested = false;
  // Internal one-turn-at-a-time gate (spec §4.2 demux invariant).
  private turnChain: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private lifetimeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WarmVoiceSessionDeps) {}

  get inputQueue(): AsyncPushQueue<SDKUserMessage> {
    return this.input;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get turns(): number {
    return this.turnCount;
  }

  get hasTurnInFlight(): boolean {
    return this.turnInFlight;
  }

  /**
   * Bind the opened SDK query; arm lifetime + idle timers.
   *
   * Closed-guard (review round 2, issue 1): the manager publishes the lease
   * into `warmLeases` BEFORE awaiting the session open (CLI boot + MCP
   * handshake, ~1.5-2s), so anything that closes the lease during that
   * window — ticket.abort() via stopAgent/stopAll/restartAgent, engine
   * shutdown, or a second turn hitting notRunnableError() → runWarmTurn's
   * `lease.close("turn-failure")` — lands while `this.query` is still null.
   * Without this guard, start() would bind the late-arriving Query to an
   * already-closed lease: close() early-returns on the idempotency guard,
   * armIdleTimer() early-returns on `closed`, the registry entry is already
   * deleted and the ticket already released — the CLI subprocess would run
   * forever with no reachable close path (W-leak drill: orphan `claude`
   * processes). Instead, close the Query immediately and leave the lease's
   * state — including closeReason — exactly as the real close left it.
   */
  start(query: Query): void {
    if (this.closed) {
      safeLog("warn", "Warm voice lease closed during session open — closing the late Query", {
        ...this.logCtx(),
        reason: this.closeReason ?? "unknown",
      });
      try {
        query.close();
      } catch (err) {
        safeLog("warn", "late query close threw during start() on a closed lease", {
          ...this.logCtx(),
          error: String(err),
        });
      }
      return;
    }
    this.query = query;
    this.lifetimeTimer = setTimeout(() => {
      // Bare-timer throw-safety (spec §4.2).
      try {
        safeLog("info", "Warm voice lease lifetime cap reached — releasing", this.logCtx());
        this.close("lifetime-cap");
      } catch (err) {
        safeLog("error", "lifetime-cap close threw — swallowed", { ...this.logCtx(), error: String(err) });
      }
    }, WARM_LIFETIME_CAP_MS);
    this.lifetimeTimer.unref?.();
    this.armIdleTimer();
  }

  /**
   * Run one turn: push the utterance, consume the shared output stream
   * until THIS turn's `result` message, relay text deltas. Serialized by
   * turnChain — external callers are already one-turn-at-a-time (the
   * worker/Vapi POST serially per call), the gate makes interleaving
   * structurally impossible.
   */
  async runTurn(req: WarmTurnRequest): Promise<RunResult> {
    if (this.closed || !this.query) {
      throw this.notRunnableError();
    }
    const run = this.turnChain.then(() => this.consumeOneTurn(req));
    // Keep the chain alive across a failed turn; the failure itself
    // propagates to THIS caller via `run`.
    this.turnChain = run.catch(() => {});
    return run;
  }

  /**
   * §4.4 barge-in / watchdog entry: interrupt the in-flight generation,
   * keep the session open. Fire-and-forget with .catch escalation — a
   * failed interrupt means the session may be wedged; closing it converts
   * the situation into the standard cold-fallback path (§6).
   * Idle-lease edge (no generation in flight): interrupt-on-idle is
   * SDK-unspecified — if it rejects, the same escalation applies (safe but
   * avoidable; W2 in-run behavior check, spec §4.4/§7).
   */
  requestInterrupt(reason: string): void {
    if (this.closed || !this.query) return;
    this.interruptRequested = true;
    const interruptedTurn = this.turnCount;
    const hadTurnInFlight = this.turnInFlight;
    this.query
      .interrupt()
      .then(
        () => {
          // Silent-wedge backstop (plan review r1 adv. 5 — distinct from the
          // rejection path below): interrupt() resolved but the SDK never
          // emits the interrupted turn's `result`. The turn chain would block
          // with the idle timer disarmed, leaving reclaim to the 2h cap. If
          // THAT turn (identity-checked — a barge-in successor turn must not
          // trip this) is still in flight after the grace window, close:
          // close() terminates the output stream, unblocking consumeOneTurn
          // into the standard turn-failure → cold-fallback path (§6).
          if (!hadTurnInFlight) return;
          const grace = setTimeout(() => {
            try {
              if (!this.closed && this.turnInFlight && this.turnCount === interruptedTurn) {
                safeLog("warn", "Interrupted turn yielded no result within grace — closing lease (cold fallback)", {
                  ...this.logCtx(),
                  reason,
                  graceMs: WARM_INTERRUPT_GRACE_MS,
                });
                this.close("interrupt-noop");
              }
            } catch (err) {
              safeLog("error", "interrupt-noop close threw — swallowed", { ...this.logCtx(), error: String(err) });
            }
          }, WARM_INTERRUPT_GRACE_MS);
          grace.unref?.();
        },
        (err) => {
          safeLog("warn", "Warm voice interrupt failed — closing lease (cold fallback)", {
            ...this.logCtx(),
            reason,
            error: String(err),
          });
          try {
            this.close(`interrupt-failed:${reason}`);
          } catch {
            // close() never throws; belt-and-braces.
          }
        },
      )
      // Terminal guard: neither handler above should throw (both are
      // internally guarded), but a floating rejection here would hit the
      // engine's process-level unhandledRejection handler. One .catch makes
      // the "always given a .catch" clause of the contract unconditional.
      .catch((err) => {
        safeLog("error", "warm interrupt handler threw — swallowed", { ...this.logCtx(), error: String(err) });
      });
  }

  /**
   * Release the lease. NO-THROW + IDEMPOTENT (spec §4.2 contract) — every
   * internal step individually guarded; a second call is a no-op.
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    // Outer guard: the per-step guards below cover every step that can
    // realistically throw, but the contract is "close() never throws",
    // not "close() throws only if something unexpected happens".
    try {
      try {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
      } catch {
        // clearTimeout cannot throw; belt-and-braces.
      }
      this.idleTimer = null;
      this.lifetimeTimer = null;
      try {
        this.input.end();
      } catch (err) {
        safeLog("warn", "input queue end threw during lease close", { ...this.logCtx(), error: String(err) });
      }
      try {
        this.query?.close();
      } catch (err) {
        safeLog("warn", "query close threw during lease close", { ...this.logCtx(), error: String(err) });
      }
      this.query = null;
      try {
        this.deps.onClosed({ reason, turns: this.turnCount });
      } catch (err) {
        safeLog("error", "warm lease onClosed callback threw — swallowed", {
          ...this.logCtx(),
          error: String(err),
        });
      }
      safeLog("info", "Warm voice lease closed", {
        ...this.logCtx(),
        reason,
        turns: this.turnCount,
        ageMs: Date.now() - this.openedAt,
      });
    } catch {
      // Unreachable by construction; present so close() is provably no-throw.
    }
  }

  /**
   * Why a lease cannot run a turn right now. Two distinct states share the
   * `!this.query` test (review round 1, issue 4):
   *  - CLOSED — released for a named reason.
   *  - NOT YET STARTED — the manager publishes the lease into `warmLeases`
   *    BEFORE `start(q)` (it must: the registry entry is what makes the
   *    second turn of a call reuse this lease instead of queueing forever
   *    behind the lease's own per-thread lock). A second turn arriving in
   *    the narrow async window between publish and start therefore lands
   *    here. It degrades safely — the throw is the adapter's cold-fallback
   *    trigger — but reporting it as "closed" mis-describes a session that
   *    is merely still opening.
   */
  private notRunnableError(): Error {
    return new Error(
      this.closed
        ? `Warm voice lease closed (${this.closeReason ?? "unknown"})`
        : "Warm voice lease not started yet (session still opening)",
    );
  }

  private logCtx(): Record<string, unknown> {
    return { agentId: this.deps.agentId, threadKey: this.deps.threadKey };
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      // Bare-timer throw-safety (spec §4.2).
      try {
        safeLog("info", "Warm voice lease idle timeout — releasing", this.logCtx());
        this.close("idle-timeout");
      } catch (err) {
        safeLog("error", "idle-timeout close threw — swallowed", { ...this.logCtx(), error: String(err) });
      }
    }, WARM_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * One turn's push + demux. Mirrors AgentRunner.send()'s message loop
   * per-turn: init (first turn only) captures session id; compact_boundary
   * counts; stream_event text_deltas relay; assistant blocks track text +
   * tool timings; `result` closes the turn (spec §4.2 turn-demux ⚠ —
   * per-pushed-message result emission is W2-verified; Task 0 pins the
   * typings).
   */
  private async consumeOneTurn(req: WarmTurnRequest): Promise<RunResult> {
    if (this.closed || !this.query) {
      throw this.notRunnableError();
    }
    const q = this.query;
    this.clearIdleTimer(); // no idle reclaim while a turn runs
    this.turnInFlight = true;
    this.interruptRequested = false;
    this.turnCount += 1;
    const pushedAt = Date.now();

    let text = "";
    let sessionId = "";
    let costUsd = 0;
    let durationMs = 0;
    let streamed = false;
    let error: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let ephemeral5mTokens: number | undefined;
    let ephemeral1hTokens: number | undefined;
    let contextWindow = 0;
    let compactions = 0;
    let preCompactTokens: number | undefined;
    let initToFirstTokenMs: number | undefined;
    let timedOut = false;
    const toolCalls: { tool: string; startMs: number; endMs?: number }[] = [];
    let activeToolName: string | null = null;

    // Per-turn watchdog (spec §4.2): maps the cold path's deadline to an
    // in-session interrupt. The session survives a timed-out turn.
    const watchdog = setTimeout(() => {
      try {
        if (this.turnInFlight && !this.closed) {
          timedOut = true;
          safeLog("warn", "Warm voice turn deadline fired — interrupting turn", {
            ...this.logCtx(),
            timeoutMs: req.timeoutMs,
            turnSeq: this.turnCount,
          });
          this.requestInterrupt("turn-timeout");
        }
      } catch (err) {
        safeLog("error", "turn watchdog threw — swallowed", { ...this.logCtx(), error: String(err) });
      }
    }, req.timeoutMs);
    watchdog.unref?.();

    try {
      this.input.push({
        type: "user",
        message: { role: "user", content: req.text },
        parent_tool_use_id: null,
      });

      // MANUAL next() loop — never `for await` here: `break` inside a
      // for-await invokes the generator's return(), which would close the
      // whole streaming session on the first turn boundary.
      turnLoop: while (true) {
        const { value, done } = await q.next();
        if (done) {
          error = error ?? `warm session output ended before turn result (${this.closeReason ?? "stream-ended"})`;
          break;
        }
        const msg = value as SDKMessage;
        switch (msg.type) {
          case "system": {
            const sub = (msg as { subtype?: string }).subtype;
            if (sub === "init") {
              sessionId = (msg as unknown as { session_id: string }).session_id;
            } else if (sub === "compact_boundary") {
              compactions++;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              preCompactTokens = (msg as any).compact_metadata?.pre_tokens;
              safeLog("info", "Context compacted mid-call", { ...this.logCtx(), preTokens: preCompactTokens });
            }
            break;
          }
          case "stream_event": {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const event = (msg as any).event;
            if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
              if (initToFirstTokenMs === undefined) initToFirstTokenMs = Date.now() - pushedAt;
              streamed = true;
              try {
                req.onStream?.(event.delta.text);
              } catch (err) {
                safeLog("warn", "onStream callback threw during warm turn", {
                  ...this.logCtx(),
                  error: String(err),
                });
              }
            }
            break;
          }
          case "assistant": {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text") {
                  text = block.text;
                } else if (block.type === "tool_use") {
                  if (activeToolName && toolCalls.length > 0) {
                    toolCalls[toolCalls.length - 1]!.endMs = Date.now();
                  }
                  activeToolName = block.name;
                  toolCalls.push({ tool: block.name, startMs: Date.now() });
                }
              }
            }
            if (msg.session_id) sessionId = msg.session_id;
            break;
          }
          case "result": {
            const result = msg as SDKResultMessage;
            costUsd = result.total_cost_usd;
            durationMs = result.duration_ms;
            sessionId = result.session_id;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const usage = (result as any).usage;
            if (usage) {
              inputTokens = usage.input_tokens ?? 0;
              outputTokens = usage.output_tokens ?? 0;
              cacheReadTokens = usage.cache_read_input_tokens ?? 0;
              cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
              const cc = usage.cache_creation;
              if (cc && typeof cc === "object") {
                ephemeral5mTokens =
                  typeof cc.ephemeral_5m_input_tokens === "number" ? cc.ephemeral_5m_input_tokens : undefined;
                ephemeral1hTokens =
                  typeof cc.ephemeral_1h_input_tokens === "number" ? cc.ephemeral_1h_input_tokens : undefined;
              }
            }
            const modelUsage = (result as unknown as { modelUsage?: Record<string, { contextWindow?: number }> })
              .modelUsage;
            if (modelUsage) {
              for (const mu of Object.values(modelUsage)) {
                if (mu.contextWindow && mu.contextWindow > contextWindow) contextWindow = mu.contextWindow;
              }
            }
            if (result.subtype === "success") {
              text = (result as { result?: string }).result || text;
            } else if (this.interruptRequested || timedOut) {
              // Spec §6 failure-close precedence: a barge-in-interrupted or
              // timed-out turn is ABORTED-BUT-SPOKEN (KPR-307 semantics), not
              // a turn-level failure — the lease must stay open. The SDK is
              // free to encode a severed generation as a non-success subtype
              // (e.g. error_during_execution); adopting that as `error` would
              // classify the turn as a failure, fire an outcome-failure, feed
              // the provider breaker, and close the lease — defeating the two
              // behaviors §6 singles out as lease-stays-open. The turn is
              // already marked via `aborted`/`timedOut` below; log only.
              // (The stream-ended branch above is NOT exempted: an output
              // stream that died before the result is a genuine session
              // failure and must still fall back cold.)
              safeLog("info", "Non-success result subtype on an interrupted/timed-out warm turn — not a turn failure", {
                ...this.logCtx(),
                subtype: result.subtype,
                turnSeq: this.turnCount,
                timedOut,
              });
            } else {
              error =
                "errors" in result && Array.isArray(result.errors) ? result.errors.join("; ") : result.subtype;
            }
            break turnLoop;
          }
          default:
            break;
        }
      }
    } catch (err) {
      error = error ?? String(err);
    } finally {
      clearTimeout(watchdog);
      this.turnInFlight = false;
      if (!this.closed) this.armIdleTimer();
    }

    if (activeToolName && toolCalls.length > 0) {
      toolCalls[toolCalls.length - 1]!.endMs = Date.now();
    }
    const toolStats: Record<string, { count: number; totalMs: number }> = {};
    for (const tc of toolCalls) {
      const dur = (tc.endMs ?? Date.now()) - tc.startMs;
      const serverName = tc.tool.includes("__") ? tc.tool.split("__")[1]! : tc.tool;
      if (!toolStats[serverName]) toolStats[serverName] = { count: 0, totalMs: 0 };
      toolStats[serverName]!.count++;
      toolStats[serverName]!.totalMs += dur;
    }
    const toolSummary = Object.entries(toolStats)
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .map(([name, s]) => `${name}:${s.count}x/${(s.totalMs / 1000).toFixed(1)}s`)
      .join(", ");
    const totalToolMs = toolCalls.reduce((sum, tc) => sum + ((tc.endMs ?? Date.now()) - tc.startMs), 0);

    return {
      text,
      sessionId,
      costUsd,
      durationMs,
      llmMs: durationMs - totalToolMs,
      toolMs: totalToolMs,
      toolCalls: toolCalls.length,
      toolSummary: toolSummary || "none",
      streamed,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      ephemeral5mTokens,
      ephemeral1hTokens,
      contextWindow,
      compactions,
      preCompactTokens,
      error,
      // Interrupted (barge-in) and timed-out turns are aborted-but-spoken:
      // KPR-307 semantics — no error string, so no outcome-failure fires and
      // the lease stays open (spec §6 precedence rule, timeout clause).
      aborted: this.interruptRequested || timedOut ? true : undefined,
      ...(timedOut ? { timedOut: true } : {}),
      initToFirstTokenMs, // KPR-323 C1 field reuse: warm turns measure push → first delta
    };
  }
}
