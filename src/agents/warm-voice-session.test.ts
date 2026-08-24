import { describe, it, expect, vi, afterEach } from "vitest";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AsyncPushQueue,
  WarmVoiceSession,
  WARM_IDLE_TIMEOUT_MS,
  WARM_LIFETIME_CAP_MS,
  WARM_INTERRUPT_GRACE_MS,
} from "./warm-voice-session.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/**
 * Scripted fake streaming Query: next() served from a push queue; return()
 * must never be needed (the lease's manual next() loop is what keeps the
 * long-lived generator open across turns — assertion 3).
 */
function makeFakeQuery(opts: { closeThrows?: boolean; interruptRejects?: Error } = {}) {
  const out = new AsyncPushQueue<SDKMessage>();
  const it = out[Symbol.asyncIterator]();
  const returnSpy = vi.fn();
  const interrupt = opts.interruptRejects
    ? vi.fn().mockRejectedValue(opts.interruptRejects)
    : vi.fn().mockResolvedValue(undefined);
  const close = opts.closeThrows
    ? vi.fn(() => {
        out.end();
        throw new Error("query.close boom");
      })
    : vi.fn(() => out.end());
  const q = {
    next: () => it.next(),
    return: (...args: unknown[]) => {
      returnSpy(...args);
      return it.return!();
    },
    interrupt,
    close,
    [Symbol.asyncIterator]() {
      return this;
    },
  } as unknown as Query;
  return {
    q,
    emit: (m: Record<string, unknown>) => out.push(m as unknown as SDKMessage),
    endOutput: () => out.end(),
    interrupt,
    close,
    returnSpy,
  };
}

const initMsg = (sid: string) => ({ type: "system", subtype: "init", session_id: sid });
const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const assistantMsg = (text: string, sessionId?: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
  ...(sessionId ? { session_id: sessionId } : {}),
});
const resultMsg = (o: { result: string; session_id: string; subtype?: string; errors?: string[] }) => ({
  type: "result",
  subtype: o.subtype ?? "success",
  result: o.result,
  session_id: o.session_id,
  total_cost_usd: 0.01,
  duration_ms: 100,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...(o.errors ? { errors: o.errors } : {}),
});

function makeLease(overrides: { onClosed?: (i: { reason: string; turns: number }) => void } = {}) {
  const onClosed = vi.fn(overrides.onClosed ?? (() => {}));
  const lease = new WarmVoiceSession({ agentId: "agent-a", threadKey: "agent-a:voice:call-1", onClosed });
  return { lease, onClosed };
}

/** Drain the lease's streaming-input queue the way the SDK would, recording turn texts. */
function drainInput(lease: WarmVoiceSession): string[] {
  const seen: string[] = [];
  const it = lease.inputQueue[Symbol.asyncIterator]();
  void (async () => {
    for (;;) {
      const { value, done } = await it.next();
      if (done) return;
      const content = (value as { message: { content: unknown } }).message.content;
      seen.push(typeof content === "string" ? content : JSON.stringify(content));
    }
  })();
  return seen;
}

/** Flush pending microtasks (works under both real and fake timers). */
async function microFlush(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * Advance fake timers, returning whatever escaped the timer callbacks (null if
 * nothing did). A synchronous throw out of a bare setTimeout callback rejects
 * the advance here; in production it is an uncaughtException — the engine
 * registers only an unhandledRejection handler (index.ts), so "nothing
 * escaped" is the throw-safety assertion.
 */
async function advanceCatching(ms: number): Promise<unknown> {
  try {
    await vi.advanceTimersByTimeAsync(ms);
    return null;
  } catch (err) {
    return err;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AsyncPushQueue", () => {
  // Assertion 11: queue contract.
  it("buffers pushes in order and serves them to a later consumer", async () => {
    const q = new AsyncPushQueue<number>();
    q.push(1);
    q.push(2);
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: 2, done: false });
  });

  it("hands a push directly to a waiting consumer", async () => {
    const q = new AsyncPushQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.push(7);
    expect(await pending).toEqual({ value: 7, done: false });
  });

  it("end() resolves pending waiters as done and makes push() a silent no-op", async () => {
    const q = new AsyncPushQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.end();
    expect(await pending).toEqual({ value: undefined, done: true });

    // push() after end(): silent no-op, never throws, never re-opens iteration.
    expect(() => q.push(99)).not.toThrow();
    expect(await it.next()).toEqual({ value: undefined, done: true });

    // end() is itself idempotent.
    expect(() => q.end()).not.toThrow();
  });

  it("iterator return() ends the queue", async () => {
    const q = new AsyncPushQueue<number>();
    const it = q[Symbol.asyncIterator]();
    expect(await it.return!()).toEqual({ value: undefined, done: true });
    q.push(1);
    expect(await it.next()).toEqual({ value: undefined, done: true });
    // A fresh iterator over an ended queue is also done.
    const it2 = q[Symbol.asyncIterator]();
    expect(await it2.next()).toEqual({ value: undefined, done: true });
  });
});

describe("WarmVoiceSession", () => {
  // ---------------------------------------------------------------- 1: demux
  it("demuxes sequential turns on per-pushed-message result boundaries with zero bleed", async () => {
    const { q, emit, returnSpy } = makeFakeQuery();
    const { lease } = makeLease();
    lease.start(q);

    emit(initMsg("sess-1"));
    emit(delta("one "));
    emit(resultMsg({ result: "one", session_id: "sess-1" }));
    const chunks1: string[] = [];
    const r1 = await lease.runTurn({ text: "utterance 1", onStream: (c) => chunks1.push(c), timeoutMs: 5000 });
    expect(r1.text).toBe("one");
    expect(r1.sessionId).toBe("sess-1");
    expect(chunks1).toEqual(["one "]);
    expect(r1.streamed).toBe(true);
    expect(r1.error).toBeUndefined();
    expect(r1.aborted).toBeUndefined();
    expect(r1.initToFirstTokenMs).toBeGreaterThanOrEqual(0);

    const chunks2: string[] = [];
    emit(delta("two "));
    emit(resultMsg({ result: "two", session_id: "sess-2" }));
    const r2 = await lease.runTurn({ text: "utterance 2", onStream: (c) => chunks2.push(c), timeoutMs: 5000 });
    expect(r2.text).toBe("two");
    expect(r2.sessionId).toBe("sess-2"); // per-turn rotation capture (KPR-211-streaming)
    expect(chunks2).toEqual(["two "]); // zero cross-turn bleed: turn 1's callback saw nothing new
    expect(chunks1).toEqual(["one "]);
    expect(lease.turns).toBe(2);
    expect(returnSpy).not.toHaveBeenCalled(); // manual next() loop never closes the generator

    lease.close("test-cleanup");
  });

  // -------------------------------------------------- 2: serialization gate
  it("does not push a second turn until the first turn's result has arrived", async () => {
    const { q, emit } = makeFakeQuery();
    const { lease } = makeLease();
    lease.start(q);
    const pushed = drainInput(lease);

    const p1 = lease.runTurn({ text: "u1", timeoutMs: 5000 });
    await microFlush();
    expect(pushed).toEqual(["u1"]);

    const p2 = lease.runTurn({ text: "u2", timeoutMs: 5000 });
    await microFlush();
    // Gate holds: turn 2's utterance is NOT in the stream yet.
    expect(pushed).toEqual(["u1"]);
    expect(lease.turns).toBe(1);
    expect(lease.hasTurnInFlight).toBe(true);

    emit(resultMsg({ result: "one", session_id: "s1" }));
    const r1 = await p1;
    expect(r1.text).toBe("one");

    await microFlush();
    expect(pushed).toEqual(["u1", "u2"]); // released only after turn 1's result
    expect(lease.turns).toBe(2);

    emit(resultMsg({ result: "two", session_id: "s2" }));
    const r2 = await p2;
    expect(r2.text).toBe("two");

    lease.close("test-cleanup");
  });

  // ------------------------------------------------- 3: no-generator-close
  it("never calls the query's return() — the session survives N turns", async () => {
    const { q, emit, returnSpy, close } = makeFakeQuery();
    const { lease } = makeLease();
    lease.start(q);

    for (let i = 1; i <= 5; i++) {
      emit(delta(`chunk-${i} `));
      emit(resultMsg({ result: `reply-${i}`, session_id: `s-${i}` }));
      const r = await lease.runTurn({ text: `u${i}`, timeoutMs: 5000 });
      expect(r.text).toBe(`reply-${i}`);
      expect(r.error).toBeUndefined();
      expect(returnSpy).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(lease.isClosed).toBe(false);
    }
    expect(lease.turns).toBe(5);
    expect(returnSpy).not.toHaveBeenCalled();

    lease.close("test-cleanup");
  });

  // ------------------------------------------------------- 4: idle timeout
  it("closes with idle-timeout after WARM_IDLE_TIMEOUT_MS with no turn, exactly once", async () => {
    vi.useFakeTimers();
    const { q, emit } = makeFakeQuery();
    const closes: { reason: string; turns: number }[] = [];
    const { lease, onClosed } = makeLease({ onClosed: (i) => closes.push(i) });
    lease.start(q);

    emit(resultMsg({ result: "hi", session_id: "s1" }));
    const r1 = await lease.runTurn({ text: "u1", timeoutMs: 5_000 });
    expect(r1.text).toBe("hi");

    await vi.advanceTimersByTimeAsync(WARM_IDLE_TIMEOUT_MS - 1);
    expect(lease.isClosed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(lease.isClosed).toBe(true);
    expect(closes).toEqual([{ reason: "idle-timeout", turns: 1 }]);
    expect(onClosed).toHaveBeenCalledTimes(1);

    // Further time passes: no second close, no second callback.
    await vi.advanceTimersByTimeAsync(WARM_IDLE_TIMEOUT_MS * 3);
    expect(onClosed).toHaveBeenCalledTimes(1);

    // A turn after close is rejected, not silently queued.
    await expect(lease.runTurn({ text: "late", timeoutMs: 5_000 })).rejects.toThrow(/idle-timeout/);
  });

  it("swallows a throwing onClosed inside the idle timer (no uncaught exception)", async () => {
    vi.useFakeTimers();
    const { q } = makeFakeQuery();
    const throwing = vi.fn(() => {
      throw new Error("onClosed boom");
    });
    const lease = new WarmVoiceSession({ agentId: "agent-a", threadKey: "t", onClosed: throwing });
    lease.start(q);

    expect(await advanceCatching(WARM_IDLE_TIMEOUT_MS)).toBeNull();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(lease.isClosed).toBe(true);
  });

  // ------------------------------------------------------ 5: lifetime cap
  it("closes with lifetime-cap at WARM_LIFETIME_CAP_MS even while turns keep arriving", async () => {
    vi.useFakeTimers();
    const { q, emit } = makeFakeQuery();
    const closes: { reason: string; turns: number }[] = [];
    const { lease } = makeLease({ onClosed: (i) => closes.push(i) });
    lease.start(q);

    // Turn every 100s — always inside the 120s idle window, so idle never fires.
    const step = 100_000;
    let elapsed = 0;
    const budget = WARM_LIFETIME_CAP_MS + step * 2;
    while (!lease.isClosed && elapsed < budget) {
      emit(resultMsg({ result: `reply-${lease.turns + 1}`, session_id: "s1" }));
      await lease.runTurn({ text: "u", timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(step);
      elapsed += step;
      if (!lease.isClosed) expect(elapsed).toBeLessThan(WARM_LIFETIME_CAP_MS + step);
    }

    expect(lease.isClosed).toBe(true);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.reason).toBe("lifetime-cap"); // not idle-timeout
    expect(closes[0]!.turns).toBeGreaterThan(60);
    expect(elapsed).toBeGreaterThanOrEqual(WARM_LIFETIME_CAP_MS);
  });

  // ---------------------------------------------------- 6: close() contract
  it.each([
    ["timer", "idle-timeout"],
    ["ticket-abort", "abort"],
    ["turn-failure", "warm-turn-failed"],
    ["shutdown", "shutdown"],
  ])(
    "close() is no-throw and idempotent from the %s context even when query.close() and input.end() throw",
    async (context, reason) => {
      vi.useFakeTimers();
      const { q, close } = makeFakeQuery({ closeThrows: true });
      const { lease, onClosed } = makeLease();
      lease.start(q);
      // Force the other guarded step to throw too.
      lease.inputQueue.end = () => {
        throw new Error("input.end boom");
      };

      if (context === "timer") {
        expect(await advanceCatching(WARM_IDLE_TIMEOUT_MS)).toBeNull();
      } else {
        expect(() => lease.close(reason)).not.toThrow();
      }

      expect(lease.isClosed).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(onClosed).toHaveBeenCalledWith({ reason, turns: 0 });

      // Idempotent: a second call (any context) is a total no-op.
      expect(() => lease.close("second-call")).not.toThrow();
      expect(() => lease.close(reason)).not.toThrow();
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("close() swallows a throwing onClosed and still marks the lease closed", () => {
    const { q } = makeFakeQuery({ closeThrows: true });
    const lease = new WarmVoiceSession({
      agentId: "agent-a",
      threadKey: "t",
      onClosed: () => {
        throw new Error("onClosed boom");
      },
    });
    lease.start(q);
    expect(() => lease.close("shutdown")).not.toThrow();
    expect(lease.isClosed).toBe(true);
  });

  // --------------------------------------------------------- 7: watchdog
  it("interrupts a turn that exceeds timeoutMs and keeps the session usable", async () => {
    vi.useFakeTimers();
    const { q, emit, interrupt } = makeFakeQuery();
    const { lease } = makeLease();
    lease.start(q);

    const p = lease.runTurn({ text: "u1", timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    emit(delta("partial "));
    await vi.advanceTimersByTimeAsync(0);
    expect(interrupt).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000); // watchdog fires
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(lease.isClosed).toBe(false);

    // SDK emits the interrupted turn's result.
    emit(resultMsg({ result: "", session_id: "s1" }));
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBe(true);
    expect(r.error).toBeUndefined(); // aborted-but-spoken: no outcome-failure
    expect(lease.isClosed).toBe(false);

    // Session survives a timed-out turn.
    emit(resultMsg({ result: "next", session_id: "s2" }));
    const r2 = await lease.runTurn({ text: "u2", timeoutMs: 5_000 });
    expect(r2.text).toBe("next");
    expect(r2.timedOut).toBeUndefined();
    expect(r2.aborted).toBeUndefined();
    expect(lease.turns).toBe(2);

    lease.close("test-cleanup");
  });

  // ---------------------------------------------------------- 8: barge-in
  it("barge-in returns the already-streamed text as aborted and keeps the lease open", async () => {
    vi.useFakeTimers();
    const { q, emit, interrupt } = makeFakeQuery();
    const { lease } = makeLease();
    lease.start(q);

    const chunks: string[] = [];
    const p = lease.runTurn({ text: "u1", onStream: (c) => chunks.push(c), timeoutMs: 60_000 });
    emit(delta("hello "));
    emit(assistantMsg("hello there"));
    await vi.advanceTimersByTimeAsync(0);
    expect(lease.hasTurnInFlight).toBe(true);

    lease.requestInterrupt("barge-in");
    expect(interrupt).toHaveBeenCalledTimes(1);

    emit(resultMsg({ result: "", session_id: "s1" }));
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBeUndefined(); // barge-in is not a timeout
    expect(r.text).toBe("hello there"); // already-streamed text preserved
    expect(chunks).toEqual(["hello "]);
    expect(r.error).toBeUndefined();
    expect(lease.isClosed).toBe(false);

    // Next turn proceeds in-session, unmarked.
    emit(delta("second "));
    emit(resultMsg({ result: "second", session_id: "s2" }));
    const r2 = await lease.runTurn({ text: "u2", timeoutMs: 60_000 });
    expect(r2.text).toBe("second");
    expect(r2.aborted).toBeUndefined();
    expect(lease.turns).toBe(2);
    expect(lease.isClosed).toBe(false);

    lease.close("test-cleanup");
  });

  // ---------------------------------------------- 9: interrupt escalation
  it("closes the lease when interrupt() rejects, with no unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { q, emit } = makeFakeQuery({ interruptRejects: new Error("interrupt boom") });
      const { lease, onClosed } = makeLease();
      lease.start(q);

      const p = lease.runTurn({ text: "u1", timeoutMs: 60_000 });
      emit(delta("partial "));
      await microFlush();

      lease.requestInterrupt("watchdog");
      // Real timers here: unhandled rejections are only reported after the
      // microtask queue drains and the loop turns.
      await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setImmediate(r));

      expect(lease.isClosed).toBe(true);
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(onClosed).toHaveBeenCalledWith({ reason: "interrupt-failed:watchdog", turns: 1 });

      // close() ends the output stream, so the blocked turn settles (cold fallback).
      const r = await p;
      expect(r.error).toBeDefined();

      await new Promise((r2) => setImmediate(r2));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  // ------------------------------------------------------ 10: stream death
  it("returns an error result (never hangs) when the output stream ends mid-turn", async () => {
    const { q, endOutput } = makeFakeQuery();
    const { lease } = makeLease();
    lease.start(q);

    const p = lease.runTurn({ text: "u1", timeoutMs: 60_000 });
    await microFlush();
    endOutput();

    const r = await p;
    expect(r.error).toContain("output ended before turn result");
    expect(r.text).toBe("");
    expect(r.sessionId).toBe("");
    expect(lease.turns).toBe(1);
    expect(lease.hasTurnInFlight).toBe(false);

    lease.close("test-cleanup");
  });

  // ------------------------------------------- 12: silent-wedge backstop
  it("closes with interrupt-noop when a resolved interrupt yields no result within grace", async () => {
    vi.useFakeTimers();
    const { q, emit, interrupt } = makeFakeQuery();
    const closes: { reason: string; turns: number }[] = [];
    const { lease } = makeLease({ onClosed: (i) => closes.push(i) });
    lease.start(q);

    const p = lease.runTurn({ text: "u1", timeoutMs: 600_000 });
    emit(delta("partial "));
    await vi.advanceTimersByTimeAsync(0);

    lease.requestInterrupt("barge-in");
    await vi.advanceTimersByTimeAsync(0); // interrupt() resolves; grace armed
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(lease.isClosed).toBe(false);

    await vi.advanceTimersByTimeAsync(WARM_INTERRUPT_GRACE_MS - 1);
    expect(lease.isClosed).toBe(false); // still inside grace

    await vi.advanceTimersByTimeAsync(1);
    expect(lease.isClosed).toBe(true);
    expect(closes).toEqual([{ reason: "interrupt-noop", turns: 1 }]);

    // The blocked turn settles with an error result rather than wedging.
    const r = await p;
    expect(r.error).toBeDefined();
    expect(r.error).toContain("interrupt-noop");
  });

  it("does not trip the backstop when the interrupted turn's result arrives within grace", async () => {
    vi.useFakeTimers();
    const { q, emit } = makeFakeQuery();
    const { lease, onClosed } = makeLease();
    lease.start(q);

    const p = lease.runTurn({ text: "u1", timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(0);
    lease.requestInterrupt("barge-in");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(WARM_INTERRUPT_GRACE_MS / 2);
    emit(resultMsg({ result: "cut short", session_id: "s1" }));
    const r = await p;
    expect(r.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(WARM_INTERRUPT_GRACE_MS);
    expect(lease.isClosed).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();

    lease.close("test-cleanup");
  });

  it("does not trip the backstop on a successor turn started after a clean interrupt (turn identity)", async () => {
    vi.useFakeTimers();
    const { q, emit } = makeFakeQuery();
    const { lease, onClosed } = makeLease();
    lease.start(q);

    // Turn 1: interrupted, result arrives promptly.
    const p1 = lease.runTurn({ text: "u1", timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(0);
    lease.requestInterrupt("barge-in");
    await vi.advanceTimersByTimeAsync(0); // grace armed against turn 1
    emit(resultMsg({ result: "cut short", session_id: "s1" }));
    const r1 = await p1;
    expect(r1.aborted).toBe(true);
    expect(lease.turns).toBe(1);

    // Turn 2 (the barge-in successor) starts and is still in flight when
    // turn 1's grace window elapses. The identity check must spare it.
    const p2 = lease.runTurn({ text: "u2", timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(lease.turns).toBe(2);
    expect(lease.hasTurnInFlight).toBe(true);

    await vi.advanceTimersByTimeAsync(WARM_INTERRUPT_GRACE_MS + 1_000);
    expect(lease.isClosed).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();

    emit(resultMsg({ result: "second", session_id: "s2" }));
    const r2 = await p2;
    expect(r2.text).toBe("second");
    expect(r2.aborted).toBeUndefined();

    lease.close("test-cleanup");
  });

  it("does not arm the backstop when interrupt is requested with no turn in flight", async () => {
    vi.useFakeTimers();
    const { q, interrupt } = makeFakeQuery();
    const { lease, onClosed } = makeLease();
    lease.start(q);

    lease.requestInterrupt("idle-lease");
    await vi.advanceTimersByTimeAsync(0);
    expect(interrupt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WARM_INTERRUPT_GRACE_MS + 1_000);
    expect(lease.isClosed).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();

    lease.close("test-cleanup");
  });
});
