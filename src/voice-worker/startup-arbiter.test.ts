import { describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { VOICE_PROCESS_ID } from "../voice/voice-trace.js";
import { SpeechTrace, type BridgeBinding } from "./speech-trace.js";
import {
  StartupActionOwnership,
  StartupArbiter,
  type ActionTrace,
  type OwnedBridgeError,
  type OwnedSpeechHandle,
  type RecoveryChain,
  type StartupEvent,
} from "./startup-arbiter.js";

class Handle implements OwnedSpeechHandle {
  interrupted = false;
  settled = false;
  interrupts = 0;
  readonly callbacks = new Set<(handle: OwnedSpeechHandle) => void>();
  readonly playout: Promise<void>;
  #finishPlayout!: () => void;
  #failPlayout!: (error: Error) => void;

  constructor(readonly id: string) {
    this.playout = new Promise((resolve, reject) => {
      this.#finishPlayout = resolve;
      this.#failPlayout = reject;
    });
  }

  done(): boolean {
    return this.settled;
  }

  interrupt(): this {
    this.interrupts += 1;
    this.interrupted = true;
    return this;
  }

  waitForPlayout(): Promise<void> {
    return this.playout;
  }

  addDoneCallback(callback: (handle: OwnedSpeechHandle) => void): void {
    this.callbacks.add(callback);
  }

  removeDoneCallback(callback: (handle: OwnedSpeechHandle) => void): void {
    this.callbacks.delete(callback);
  }

  finish(): void {
    this.settled = true;
    this.#finishPlayout();
    for (const callback of [...this.callbacks]) callback(this);
  }

  failPlayout(): void {
    this.#failPlayout(new Error("controlled late playout rejection"));
  }
}

class Failure extends Error implements OwnedBridgeError {
  constructor(readonly turnId: string) {
    super("controlled bridge failure");
  }
}

class Trace implements ActionTrace {
  readonly bindings = new Map<string, BridgeBinding>();
  readonly gaps: Array<{ reason: string; speechId: string | null; turnId?: string }> = [];
  readonly cancellations: Array<{ speechId: string; cause: string }> = [];
  listener: ((turnId: string) => void) | null = null;

  bridgeBinding(turnId: string): BridgeBinding {
    return this.bindings.get(turnId) ?? { state: "unbound" };
  }

  onBridgeBinding(listener: (turnId: string) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  markCancellation(speechId: string, cause: "startup_superseded" | "call_closed" | "unknown"): void {
    this.cancellations.push({ speechId, cause });
  }

  actionGap(reason: string, speechId: string | null, turnId?: string): void {
    this.gaps.push({ reason, speechId, ...(turnId ? { turnId } : {}) });
  }

  bind(turnId: string, speechId: string): void {
    this.bindings.set(turnId, { state: "bound", speechId });
    this.listener?.(turnId);
  }

  unavailable(turnId: string, reason: "conflict" | "evicted" | "closed"): void {
    this.bindings.set(turnId, { state: "unavailable", reason });
    this.listener?.(turnId);
  }
}

function openingFixture(reentrant?: (arbiter: StartupArbiter, handle: Handle) => void) {
  const events: StartupEvent[] = [];
  const handles: Handle[] = [];
  const arbiter = new StartupArbiter({
    requestOpening: () => {
      const handle = new Handle(`opening-${handles.length + 1}`);
      handles.push(handle);
      reentrant?.(arbiter, handle);
      return handle;
    },
    observe: (event) => events.push(event),
  });
  return { arbiter, events, handles };
}

describe("StartupArbiter", () => {
  it("requests exactly one opening after a quiet answer", () => {
    const fixture = openingFixture();
    fixture.arbiter.answer();
    fixture.arbiter.answer();
    fixture.arbiter.callerState("listening");
    expect(fixture.handles).toHaveLength(1);
    expect(fixture.events).toContainEqual({ kind: "decision", decision: "request", reason: "quiet_answer" });
  });

  it("retains a nonempty final latch across answer and listening until acceptance", () => {
    const fixture = openingFixture();
    fixture.arbiter.finalInput(true);
    fixture.arbiter.answer();
    fixture.arbiter.callerState("listening");
    expect(fixture.handles).toHaveLength(0);
    fixture.arbiter.acceptedCallerTurn();
    fixture.arbiter.answer();
    expect(fixture.handles).toHaveLength(0);
    expect(fixture.arbiter.epoch).toBe(1);
  });

  it.each(["absent", "interim", "empty", "preflight"])(
    "releases a provisional speaking hold for %s input on listening",
    () => {
      const fixture = openingFixture();
      fixture.arbiter.callerState("speaking");
      fixture.arbiter.finalInput(false);
      fixture.arbiter.answer();
      expect(fixture.handles).toHaveLength(0);
      fixture.arbiter.callerState("listening");
      expect(fixture.handles).toHaveLength(1);
    },
  );

  it("cancels the exact outstanding opening when a delayed final is accepted", () => {
    const fixture = openingFixture();
    fixture.arbiter.answer();
    fixture.arbiter.finalInput(true);
    fixture.arbiter.acceptedCallerTurn();
    expect(fixture.handles[0]!.interrupts).toBe(1);
    expect(fixture.events).toContainEqual({
      kind: "cancel",
      speechId: "opening-1",
      reason: "startup_superseded",
    });
  });

  it("does not request after an accepted turn arrives before answer", () => {
    const fixture = openingFixture();
    fixture.arbiter.acceptedCallerTurn();
    fixture.arbiter.answer();
    expect(fixture.handles).toHaveLength(0);
  });

  it("defers while speaking and remains one-shot when acceptance follows", () => {
    const fixture = openingFixture();
    fixture.arbiter.callerState("speaking");
    fixture.arbiter.answer();
    fixture.arbiter.acceptedCallerTurn();
    fixture.arbiter.callerState("listening");
    expect(fixture.handles).toHaveLength(0);
    expect(fixture.events).toContainEqual({
      kind: "decision",
      decision: "defer",
      reason: "caller_speaking",
    });
  });

  it("interrupts only the returned handle after reentrant acceptance", () => {
    const fixture = openingFixture((arbiter) => arbiter.acceptedCallerTurn());
    fixture.arbiter.answer();
    expect(fixture.handles[0]!.interrupts).toBe(1);
    expect(fixture.arbiter.epoch).toBe(1);
  });

  it("makes close terminal before or after answer", () => {
    const before = openingFixture();
    before.arbiter.close();
    before.arbiter.answer();
    expect(before.handles).toHaveLength(0);

    const after = openingFixture();
    after.arbiter.answer();
    after.arbiter.close();
    after.arbiter.callerState("listening");
    expect(after.handles).toHaveLength(1);
    expect(after.arbiter.closed).toBe(true);
  });

  it("contains observation failures without changing the decision", () => {
    const requestOpening = vi.fn(() => new Handle("opening"));
    const arbiter = new StartupArbiter({
      requestOpening,
      observe: () => {
        throw new Error("sink failed");
      },
    });
    arbiter.answer();
    expect(requestOpening).toHaveBeenCalledOnce();
  });
});

function ownershipFixture(
  recover: (
    chain: RecoveryChain<Failure>,
    error: Failure,
    actions: StartupActionOwnership<Failure>,
  ) => Promise<void> = async () => {},
) {
  const trace = new Trace();
  const arbiter = new StartupArbiter({
    requestOpening: () => new Handle("unused-opening"),
    observe: () => {},
  });
  const ownership = new StartupActionOwnership<Failure>({ arbiter, trace, recover });
  return { trace, arbiter, ownership };
}

function admitSdk(fixture: ReturnType<typeof ownershipFixture>, speechId = "speech-1"): Handle {
  const handle = new Handle(speechId);
  fixture.ownership.registerSpeech(handle);
  fixture.ownership.acceptCallerTurn();
  fixture.ownership.admitEou(speechId);
  return handle;
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function gate<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("StartupActionOwnership", () => {
  it("waits for exact creation, EOU admission, and bridge binding in either order", async () => {
    const recovered: string[] = [];
    const fixture = ownershipFixture(async (chain) => {
      recovered.push(chain.origin.turnId);
    });
    admitSdk(fixture);
    fixture.ownership.captureError(new Failure("turn-1"));
    expect(fixture.ownership.pendingErrorCount).toBe(1);
    fixture.trace.bind("turn-1", "speech-1");
    await drain();
    expect(recovered).toEqual(["turn-1"]);
    expect(fixture.ownership.pendingErrorCount).toBe(0);
  });

  it("does not adopt the next or latest speculative speech without EOU identity", async () => {
    const recover = vi.fn(async () => {});
    const fixture = ownershipFixture(recover);
    const first = new Handle("first");
    fixture.ownership.registerSpeech(first);
    fixture.ownership.acceptCallerTurn();
    const speculative = new Handle("speculative");
    fixture.ownership.registerSpeech(speculative);
    fixture.trace.bind("turn-1", "speculative");
    fixture.ownership.captureError(new Failure("turn-1"));
    await drain();
    expect(recover).not.toHaveBeenCalled();
    expect(fixture.ownership.pendingErrorCount).toBe(1);
  });

  it("drops an old admitted error after a healthy successor owns a newer epoch", async () => {
    const recover = vi.fn(async () => {});
    const fixture = ownershipFixture(recover);
    admitSdk(fixture, "speech-old");
    fixture.trace.bind("turn-old", "speech-old");

    const successor = new Handle("speech-new");
    fixture.ownership.registerSpeech(successor);
    fixture.ownership.acceptCallerTurn();
    fixture.ownership.admitEou(successor.id);
    fixture.ownership.captureError(new Failure("turn-old"));
    await drain();

    expect(recover).not.toHaveBeenCalled();
    expect(fixture.ownership.pendingErrorCount).toBe(0);
  });

  it("invalidates a registered chain synchronously before its queued microtask", async () => {
    const recover = vi.fn(async () => {});
    const fixture = ownershipFixture(recover);
    admitSdk(fixture);
    fixture.trace.bind("turn-1", "speech-1");
    fixture.ownership.captureError(new Failure("turn-1"));
    expect(fixture.ownership.activeRecoveryCount).toBe(1);
    fixture.trace.unavailable("turn-1", "conflict");
    await drain();
    expect(recover).not.toHaveBeenCalled();
    expect(fixture.trace.gaps).toContainEqual({
      reason: "action_ownership_unproved",
      speechId: "speech-1",
      turnId: "turn-1",
    });
  });

  it("retains a queued retry's chain after the routine and interrupts it on later binding loss", async () => {
    let retry!: Handle;
    const fixture = ownershipFixture(async (chain, _error, actions) => {
      retry = new Handle("retry-1");
      actions.scheduleOwned(
        "retry",
        () => {
          actions.registerSpeech(retry);
          return retry;
        },
        chain,
      );
    });
    admitSdk(fixture);
    fixture.trace.bind("turn-1", "speech-1");
    fixture.ownership.captureError(new Failure("turn-1"));
    await drain();
    expect(fixture.ownership.activeRecoveryCount).toBe(0);
    expect(fixture.ownership.applicationHandleCount).toBe(1);
    fixture.trace.unavailable("turn-1", "evicted");
    expect(retry.interrupts).toBe(1);
    fixture.trace.unavailable("turn-1", "conflict");
    expect(retry.interrupts).toBe(1);
    expect(
      fixture.trace.gaps.filter((gap) => gap.reason === "action_ownership_unproved" && gap.turnId === "turn-1"),
    ).toHaveLength(1);
    retry.finish();
    expect(fixture.ownership.applicationHandleCount).toBe(0);
  });

  it("retains a prior-aborted fallback for later binding invalidation", async () => {
    let fallback!: Handle;
    let chainRef!: RecoveryChain<Failure>;
    const fixture = ownershipFixture(async (chain, _error, actions) => {
      chainRef = chain;
      fallback = new Handle("fallback-1");
      actions.scheduleOwned(
        "fallback",
        () => {
          actions.registerSpeech(fallback);
          return fallback;
        },
        chain,
      );
      await actions.waitOwned(chain, () => fallback.waitForPlayout());
    });
    admitSdk(fixture);
    fixture.trace.bind("turn-1", "speech-1");
    fixture.ownership.captureError(new Failure("turn-1"));
    await drain();
    fixture.ownership.registerSpeech(new Handle("speculative"));
    await drain();
    expect(chainRef.abort.signal.aborted).toBe(true);
    expect(chainRef.bindingInvalidationHandled).toBe(false);
    expect(fallback.interrupts).toBe(0);
    expect(fixture.ownership.activeRecoveryCount).toBe(0);
    fixture.trace.unavailable("turn-1", "conflict");
    expect(chainRef.bindingInvalidationHandled).toBe(true);
    expect(fallback.interrupts).toBe(1);
    fallback.failPlayout();
    await drain();
  });

  it("aborts an independent delay immediately on call close", async () => {
    let passedDelay = false;
    const entered = gate<void>();
    const fixture = ownershipFixture(async (chain, _error, actions) => {
      entered.resolve();
      passedDelay = await actions.delayOwned(chain, 60_000);
    });
    admitSdk(fixture);
    fixture.trace.bind("turn-1", "speech-1");
    fixture.ownership.captureError(new Failure("turn-1"));
    await entered.promise;
    fixture.ownership.close();
    await drain();
    expect(passedDelay).toBe(false);
    expect(fixture.ownership.activeRecoveryCount).toBe(0);
  });

  it("preserves a retained handle across duplicate valid binding notifications", async () => {
    let retry!: Handle;
    const fixture = ownershipFixture(async (chain, _error, actions) => {
      retry = new Handle("retry-control");
      actions.scheduleOwned(
        "retry",
        () => {
          actions.registerSpeech(retry);
          return retry;
        },
        chain,
      );
    });
    admitSdk(fixture);
    fixture.trace.bind("turn-1", "speech-1");
    fixture.ownership.captureError(new Failure("turn-1"));
    await drain();
    fixture.trace.bind("turn-1", "speech-1");
    expect(retry.interrupts).toBe(0);
  });

  it("evicts only the oldest of 257 unbound errors with its real turn id", () => {
    const fixture = ownershipFixture();
    for (let index = 0; index < 257; index += 1) {
      fixture.ownership.captureError(new Failure(`turn-${index}`));
    }
    expect(fixture.ownership.pendingErrorCount).toBe(256);
    expect(fixture.trace.gaps).toContainEqual({
      reason: "action_overflow",
      speechId: null,
      turnId: "turn-0",
    });
  });

  it("bounds application handles and cancels the oldest exact handle on overflow", () => {
    const fixture = ownershipFixture();
    const handles: Handle[] = [];
    for (let index = 0; index < 257; index += 1) {
      const handle = new Handle(`application-${index}`);
      handles.push(handle);
      fixture.ownership.scheduleOwned("opening", () => {
        fixture.ownership.registerSpeech(handle);
        return handle;
      });
    }
    expect(fixture.ownership.applicationHandleCount).toBe(256);
    expect(handles[0]!.interrupts).toBe(1);
    expect(handles[1]!.interrupts).toBe(0);
    expect(fixture.trace.gaps).toContainEqual({
      reason: "action_overflow",
      speechId: "application-0",
    });
  });

  it("cancels application handles and independent recovery chains on acceptance and close", async () => {
    let chainRef!: RecoveryChain<Failure>;
    let retry!: Handle;
    const fixture = ownershipFixture(async (chain, _error, actions) => {
      chainRef = chain;
      retry = new Handle("retry-1");
      actions.scheduleOwned(
        "retry",
        () => {
          actions.registerSpeech(retry);
          return retry;
        },
        chain,
      );
    });
    admitSdk(fixture);
    fixture.trace.bind("turn-1", "speech-1");
    fixture.ownership.captureError(new Failure("turn-1"));
    await drain();
    fixture.ownership.acceptCallerTurn();
    expect(chainRef.abort.signal.aborted).toBe(true);
    expect(retry.interrupts).toBe(1);
    fixture.ownership.close();
    expect(fixture.trace.listener).toBeNull();
    expect(fixture.ownership.applicationHandleCount).toBe(0);
  });

  it("fails closed on a real SpeechTrace binding conflict after admission", async () => {
    const rows: unknown[] = [];
    const trace = new SpeechTrace({
      callId: "call-real-trace",
      workerBootId: VOICE_PROCESS_ID,
      writer: {
        write: (row: unknown) => rows.push(row),
        emit: (row: unknown) => rows.push(row),
        snapshot: () => ({
          attempted: rows.length,
          acknowledged: rows.length,
          filtered: 0,
          failed: 0,
          overflow: 0,
          pending: 0,
          unacknowledged: 0,
          sinkErrors: 0,
          complete: true,
        }),
        settleWrites: async () => ({
          attempted: rows.length,
          acknowledged: rows.length,
          filtered: 0,
          failed: 0,
          overflow: 0,
          pending: 0,
          unacknowledged: 0,
          sinkErrors: 0,
          complete: true,
        }),
      },
    });
    const arbiter = new StartupArbiter({ requestOpening: () => new Handle("unused"), observe: () => {} });
    const recover = vi.fn(async () => {});
    const ownership = new StartupActionOwnership<Failure>({ arbiter, trace, recover });
    const speech = new Handle("speech-real");
    trace.speechCreated(speech as never, "sdk_response", 0);
    ownership.registerSpeech(speech);
    ownership.acceptCallerTurn();
    ownership.admitEou(speech.id);
    const turnId = randomUUID();
    trace.bridgeCreated({ workerBootId: VOICE_PROCESS_ID, callId: "call-real-trace", turnId });
    trace.bindBridge(turnId, speech.id);
    ownership.captureError(new Failure(turnId));
    expect(ownership.activeRecoveryCount).toBe(1);

    trace.bindBridge(turnId, "conflicting-speech");
    await drain();

    expect(recover).not.toHaveBeenCalled();
    expect(
      rows.filter(
        (row) =>
          (row as { event?: string; reason?: string; speechId?: string }).event === "diagnostic_gap" &&
          (row as { reason?: string }).reason === "action_ownership_unproved" &&
          (row as { speechId?: string }).speechId === speech.id,
      ),
    ).toHaveLength(1);
  });
});
