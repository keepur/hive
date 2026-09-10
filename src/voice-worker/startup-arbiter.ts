import { setTimeout as delay } from "node:timers/promises";

import type { SpeechOrigin } from "../voice/voice-trace.js";
import type { ActionGapReason, BridgeBinding } from "./speech-trace.js";

const REGISTRY_LIMIT = 256;

export interface OpeningHandle {
  readonly id: string;
  readonly interrupted: boolean;
  done(): boolean;
  interrupt(force?: boolean): unknown;
}

export interface OwnedSpeechHandle extends OpeningHandle {
  waitForPlayout(): Promise<void>;
  addDoneCallback(callback: (handle: OwnedSpeechHandle) => void): void;
  removeDoneCallback?(callback: (handle: OwnedSpeechHandle) => void): void;
}

export type StartupEvent =
  | {
      kind: "decision";
      decision: "request" | "defer" | "consumed";
      reason: "quiet_answer" | "caller_speaking" | "final_input_pending" | "accepted_caller_turn";
    }
  | { kind: "cancel"; speechId: string; reason: "startup_superseded" }
  | { kind: "closed" };

/** Synchronous one-shot outbound-opening policy. */
export class StartupArbiter {
  #answered = false;
  #speaking = false;
  #accepted = false;
  #finalPending = false;
  #requested = false;
  #terminal = false;
  #opening: OpeningHandle | null = null;
  #epoch = 0;

  constructor(
    private readonly deps: {
      requestOpening: () => OpeningHandle;
      observe: (event: StartupEvent) => void;
    },
  ) {}

  get epoch(): number {
    return this.#epoch;
  }

  get closed(): boolean {
    return this.#terminal;
  }

  answer(): void {
    if (this.#terminal) return;
    this.#answered = true;
    this.#decide();
  }

  callerState(state: "speaking" | "listening" | "away"): void {
    if (this.#terminal) return;
    this.#speaking = state === "speaking";
    if (state === "listening") this.#decide();
  }

  finalInput(hasNonemptyFinal: boolean): void {
    if (this.#terminal || !hasNonemptyFinal) return;
    this.#finalPending = true;
  }

  acceptedCallerTurn(): void {
    if (this.#terminal) return;
    this.#epoch += 1;
    this.#accepted = true;
    this.#finalPending = false;
    this.#observe({ kind: "decision", decision: "consumed", reason: "accepted_caller_turn" });
    const opening = this.#opening;
    if (opening && !opening.done() && !opening.interrupted) {
      this.#observe({ kind: "cancel", speechId: opening.id, reason: "startup_superseded" });
      try {
        opening.interrupt();
      } catch {
        // The action owner records cancellation failures for production handles.
      }
    }
  }

  close(): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#finalPending = false;
    this.#epoch += 1;
    this.#observe({ kind: "closed" });
  }

  #observe(event: StartupEvent): void {
    try {
      this.deps.observe(event);
    } catch {
      // Observation cannot alter the synchronous startup decision.
    }
  }

  #decide(): void {
    if (this.#terminal || !this.#answered || this.#accepted || this.#requested) return;
    if (this.#finalPending) {
      this.#observe({ kind: "decision", decision: "defer", reason: "final_input_pending" });
      return;
    }
    if (this.#speaking) {
      this.#observe({ kind: "decision", decision: "defer", reason: "caller_speaking" });
      return;
    }
    this.#requested = true;
    this.#observe({ kind: "decision", decision: "request", reason: "quiet_answer" });
    const opening = this.deps.requestOpening();
    this.#opening = opening;
    if ((this.#accepted || this.#terminal) && !opening.done() && !opening.interrupted) {
      if (!this.#terminal) {
        this.#observe({ kind: "cancel", speechId: opening.id, reason: "startup_superseded" });
      }
      try {
        opening.interrupt();
      } catch {
        // The action owner records cancellation failures for production handles.
      }
    }
  }
}

export interface CreationToken {
  readonly speechId: string;
  readonly createdEpoch: number;
  readonly serial: number;
  readonly origin: SpeechOrigin;
}

export interface ActionOwner {
  readonly creation: CreationToken;
  readonly acceptedEpoch: number;
  readonly source: "application" | "eou";
}

export interface OwnedBridgeError extends Error {
  readonly turnId: string;
}

export interface RecoveryChain<E extends OwnedBridgeError = OwnedBridgeError> {
  readonly id: string;
  readonly abort: AbortController;
  readonly origin: Readonly<{ turnId: string; speechId: string }>;
  readonly error: E;
  bindingInvalidationHandled: boolean;
  owner: ActionOwner;
}

type GenerationScope<E extends OwnedBridgeError> = {
  origin: Exclude<SpeechOrigin, "sdk_response">;
  epoch: number;
  chain: RecoveryChain<E> | null;
  transferFrom: ActionOwner | null;
};

export interface ActionTrace {
  bridgeBinding(turnId: string): BridgeBinding;
  onBridgeBinding(listener: (turnId: string) => void): () => void;
  markCancellation(speechId: string, cause: "startup_superseded" | "call_closed" | "unknown"): void;
  actionGap(reason: ActionGapReason, speechId: string, turnId?: string): void;
  actionGap(reason: ActionGapReason, speechId: string | null, turnId: string): void;
}

export interface StartupActionOwnershipDeps<E extends OwnedBridgeError> {
  arbiter: StartupArbiter;
  trace: ActionTrace;
  recover(chain: RecoveryChain<E>, error: E, actions: StartupActionOwnership<E>): Promise<void>;
}

type ApplicationHandle<E extends OwnedBridgeError> = {
  handle: OwnedSpeechHandle;
  owner: ActionOwner;
  chain: RecoveryChain<E> | null;
  done: (handle: OwnedSpeechHandle) => void;
};

type CreationEntry = {
  token: CreationToken;
  handle: OwnedSpeechHandle;
  done: (handle: OwnedSpeechHandle) => void;
};

/**
 * Call-local identity/admission registry. Creation identifies a speech; only an
 * application scope or a genuine EOU grants action authority.
 */
export class StartupActionOwnership<E extends OwnedBridgeError = OwnedBridgeError> {
  readonly #activeCreations = new Map<string, CreationEntry>();
  readonly #recentCreations = new Map<string, CreationEntry>();
  readonly #handles = new WeakMap<OwnedSpeechHandle, CreationToken>();
  readonly #admissions = new Map<string, ActionOwner>();
  readonly #everAdmitted = new WeakSet<CreationToken>();
  readonly #pendingErrors = new Map<string, E>();
  readonly #seenErrors = new WeakSet<E>();
  readonly #processedTurns = new Map<string, true>();
  readonly #activeRecovery = new Map<string, RecoveryChain<E>>();
  readonly #applicationHandles = new Map<string, ApplicationHandle<E>>();
  readonly #detachBinding: () => void;
  #scope: GenerationScope<E> | null = null;
  #awaitingAdmission: number | null = null;
  #currentOwner: ActionOwner | null = null;
  #serial = 0;
  #chainSerial = 0;
  #closed = false;
  #decisionOverflowed = false;

  constructor(private readonly deps: StartupActionOwnershipDeps<E>) {
    this.#detachBinding = deps.trace.onBridgeBinding((turnId) => {
      this.recheckRecoveryForTurn(turnId);
      this.recheckPending(turnId);
    });
  }

  get currentOwner(): ActionOwner | null {
    return this.#currentOwner;
  }

  get activeRecoveryCount(): number {
    return this.#activeRecovery.size;
  }

  get applicationHandleCount(): number {
    return this.#applicationHandles.size;
  }

  get pendingErrorCount(): number {
    return this.#pendingErrors.size;
  }

  get generationScope(): Readonly<GenerationScope<E>> | null {
    return this.#scope;
  }

  registerSpeech(handle: OwnedSpeechHandle): CreationToken | null {
    const known = this.#handles.get(handle);
    if (known) return known;
    const conflicting = this.#activeCreations.get(handle.id) ?? this.#recentCreations.get(handle.id);
    if (conflicting) {
      this.#gap("action_ownership_unproved", handle.id);
      return null;
    }
    this.#evictActiveCreation();
    const scope = this.#scope;
    const token = Object.freeze({
      speechId: handle.id,
      createdEpoch: scope?.epoch ?? this.deps.arbiter.epoch,
      serial: ++this.#serial,
      origin: scope?.origin ?? "sdk_response",
    }) satisfies CreationToken;
    const done = (settled: OwnedSpeechHandle) => {
      const active = this.#activeCreations.get(token.speechId);
      if (active?.handle !== settled) return;
      settled.removeDoneCallback?.(done);
      this.#activeCreations.delete(token.speechId);
      while (this.#recentCreations.size >= REGISTRY_LIMIT) {
        const oldest = this.#recentCreations.keys().next().value as string | undefined;
        if (!oldest) break;
        const evicted = this.#recentCreations.get(oldest);
        evicted?.handle.removeDoneCallback?.(evicted.done);
        this.#recentCreations.delete(oldest);
        this.#gap("action_overflow", oldest);
      }
      this.#recentCreations.set(token.speechId, active);
    };
    this.#handles.set(handle, token);
    this.#activeCreations.set(handle.id, { token, handle, done });
    handle.addDoneCallback(done);

    if (scope?.chain && scope.transferFrom === scope.chain.owner && this.chainOwns(scope.chain)) {
      const owner = Object.freeze({
        creation: token,
        acceptedEpoch: scope.chain.owner.acceptedEpoch,
        source: "application" as const,
      });
      scope.chain.owner = owner;
      this.#currentOwner = owner;
      this.#admitApplication(owner, handle, scope.chain);
      this.cancelAllRecovery("startup_superseded", scope.chain);
      this.cancelApplicationHandles("startup_superseded", handle.id);
      return token;
    }

    if (scope && !scope.chain && !this.#closed && scope.epoch === this.deps.arbiter.epoch) {
      const owner = Object.freeze({ creation: token, acceptedEpoch: scope.epoch, source: "application" as const });
      this.#currentOwner = owner;
      this.#admitApplication(owner, handle, null);
      return token;
    }

    // A speculative SDK creation fences recovery continuations but does not
    // interrupt the independently-owned optional opening.
    this.#currentOwner = null;
    this.cancelAllRecovery("startup_superseded");
    return token;
  }

  scheduleOwned(
    origin: Exclude<SpeechOrigin, "sdk_response">,
    make: () => OwnedSpeechHandle,
    chain: RecoveryChain<E> | null = null,
  ): OwnedSpeechHandle {
    if (chain && !this.chainOwns(chain)) throw new Error("Recovery authority is no longer current");
    if (this.#closed || this.deps.arbiter.closed) throw new Error("Call is closed");
    const previous = this.#scope;
    const transferFrom = chain?.owner ?? null;
    this.#scope = { origin, epoch: this.deps.arbiter.epoch, chain, transferFrom };
    let handle: OwnedSpeechHandle;
    try {
      handle = make();
    } finally {
      this.#scope = previous;
    }
    const registered = this.#applicationHandles.get(handle.id);
    if (
      !registered ||
      registered.handle !== handle ||
      (chain && (!this.chainOwns(chain) || registered.chain !== chain))
    ) {
      this.#interruptUnowned(handle, chain?.origin.turnId);
      if (chain) this.cancelChain(chain);
    }
    return handle;
  }

  acceptCallerTurn(): number {
    if (this.#closed || this.deps.arbiter.closed) return this.deps.arbiter.epoch;
    this.#currentOwner = null;
    this.cancelAllRecovery("startup_superseded");
    this.cancelApplicationHandles("startup_superseded");
    this.deps.arbiter.acceptedCallerTurn();
    this.#awaitingAdmission = this.deps.arbiter.epoch;
    this.#dropStalePending();
    return this.deps.arbiter.epoch;
  }

  admitEou(speechId: string): void {
    if (this.#closed || this.deps.arbiter.closed) return;
    if (this.#admissions.has(speechId)) return;
    const creation = (this.#activeCreations.get(speechId) ?? this.#recentCreations.get(speechId))?.token;
    if (creation && this.#everAdmitted.has(creation)) return;
    if (this.#awaitingAdmission === null || !creation || creation.origin !== "sdk_response") {
      this.#gap("action_ownership_unproved", speechId);
      return;
    }
    const acceptedEpoch = this.#awaitingAdmission;
    this.#awaitingAdmission = null;
    if (acceptedEpoch !== this.deps.arbiter.epoch) return;
    const owner = Object.freeze({ creation, acceptedEpoch, source: "eou" as const });
    this.#everAdmitted.add(creation);
    this.#rememberAdmission(owner);
    this.#currentOwner = owner;
    this.#recheckPendingForSpeech(speechId);
  }

  captureError(error: E): boolean {
    if (this.#closed || this.#seenErrors.has(error)) return false;
    this.#seenErrors.add(error);
    if (this.#decisionOverflowed) {
      this.#gap("action_overflow", null, error.turnId);
      return false;
    }
    if (this.#processedTurns.has(error.turnId) || this.#pendingErrors.has(error.turnId)) return false;
    if (this.#pendingErrors.size >= REGISTRY_LIMIT) {
      const oldest = this.#pendingErrors.keys().next().value as string | undefined;
      if (oldest) {
        const binding = this.deps.trace.bridgeBinding(oldest);
        this.#pendingErrors.delete(oldest);
        this.#rememberProcessed(oldest);
        this.#gap("action_overflow", binding.state === "bound" ? binding.speechId : null, oldest);
      }
    }
    this.#pendingErrors.set(error.turnId, error);
    this.recheckPending(error.turnId);
    return true;
  }

  recheckPending(turnId: string): void {
    const error = this.#pendingErrors.get(turnId);
    if (!error || this.#processedTurns.has(turnId)) return;
    const binding = this.deps.trace.bridgeBinding(turnId);
    if (binding.state === "unbound") return;
    if (binding.state === "unavailable") {
      this.#pendingErrors.delete(turnId);
      this.#rememberProcessed(turnId);
      this.#gap("action_ownership_unproved", null, turnId);
      return;
    }
    const owner = this.#admissions.get(binding.speechId);
    if (!owner) return;
    if (!this.owns(owner)) {
      this.#pendingErrors.delete(turnId);
      this.#rememberProcessed(turnId);
      this.#gap("action_ownership_unproved", binding.speechId, turnId);
      return;
    }
    this.#pendingErrors.delete(turnId);
    this.#rememberProcessed(turnId);
    const chain: RecoveryChain<E> = {
      id: `recovery-${++this.#chainSerial}`,
      abort: new AbortController(),
      origin: Object.freeze({ turnId, speechId: binding.speechId }),
      error,
      bindingInvalidationHandled: false,
      owner,
    };
    this.#registerChain(chain);
    const failedApplication = this.#applicationHandles.get(binding.speechId);
    if (failedApplication) failedApplication.chain = chain;
    const run = Promise.resolve().then(() => {
      if (this.chainOwns(chain)) return this.deps.recover(chain, error, this);
    });
    void run
      .catch(() => this.#gap("action_ownership_unproved", chain.owner.creation.speechId, chain.origin.turnId))
      .finally(() => {
        if (this.#activeRecovery.get(chain.id) === chain) this.#activeRecovery.delete(chain.id);
      })
      .catch(() => {});
  }

  owns(owner: ActionOwner): boolean {
    return (
      !this.#closed &&
      !this.deps.arbiter.closed &&
      owner.acceptedEpoch === this.deps.arbiter.epoch &&
      this.#currentOwner === owner
    );
  }

  chainOwns(chain: RecoveryChain<E>): boolean {
    return (
      this.#activeRecovery.get(chain.id) === chain &&
      !chain.abort.signal.aborted &&
      this.owns(chain.owner) &&
      this.#originStillBound(chain)
    );
  }

  async waitOwned<T>(chain: RecoveryChain<E>, make: () => Promise<T>): Promise<T | undefined> {
    if (!this.chainOwns(chain)) return undefined;
    const signal = chain.abort.signal;
    let onAbort = () => {};
    const stopped = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      return await Promise.race([make(), stopped]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async delayOwned(chain: RecoveryChain<E>, delayMs: number): Promise<boolean> {
    if (!this.chainOwns(chain)) return false;
    try {
      await delay(delayMs, undefined, { signal: chain.abort.signal });
    } catch {
      return false;
    }
    return this.chainOwns(chain);
  }

  cancelChain(chain: RecoveryChain<E>): void {
    try {
      chain.abort.abort();
    } catch {
      // Abort listeners are foreign; cancellation is best-effort and sticky.
    }
  }

  cancelAllRecovery(_cause: "startup_superseded" | "call_closed", keep?: RecoveryChain<E>): void {
    const retained = new Set(this.#activeRecovery.values());
    for (const entry of this.#applicationHandles.values()) if (entry.chain) retained.add(entry.chain);
    for (const chain of retained) if (chain !== keep) this.cancelChain(chain);
  }

  cancelApplicationHandles(cause: "startup_superseded" | "call_closed", keep?: string): void {
    for (const [id, entry] of this.#applicationHandles) {
      if (id === keep) continue;
      this.#cancelApplicationEntry(id, entry, cause);
    }
  }

  recheckRecoveryForTurn(turnId: string): void {
    const retained = new Set(this.#activeRecovery.values());
    for (const entry of this.#applicationHandles.values()) if (entry.chain) retained.add(entry.chain);
    for (const chain of retained) {
      if (chain.origin.turnId !== turnId || chain.bindingInvalidationHandled || this.#originStillBound(chain)) {
        continue;
      }
      chain.bindingInvalidationHandled = true;
      this.cancelChain(chain);
      this.#gap("action_ownership_unproved", chain.origin.speechId, turnId);
      for (const [speechId, entry] of this.#applicationHandles) {
        if (entry.chain !== chain) continue;
        this.deps.trace.markCancellation(speechId, "unknown");
        this.#interrupt(entry.handle, speechId, turnId);
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#currentOwner = null;
    this.#awaitingAdmission = null;
    this.cancelAllRecovery("call_closed");
    this.cancelApplicationHandles("call_closed");
    this.#detachBinding();
    for (const entry of this.#applicationHandles.values()) {
      entry.handle.removeDoneCallback?.(entry.done);
    }
    for (const entry of [...this.#activeCreations.values(), ...this.#recentCreations.values()]) {
      entry.handle.removeDoneCallback?.(entry.done);
    }
    this.#activeRecovery.clear();
    this.#applicationHandles.clear();
    this.#pendingErrors.clear();
    this.#admissions.clear();
    this.#activeCreations.clear();
    this.#recentCreations.clear();
  }

  #admitApplication(owner: ActionOwner, handle: OwnedSpeechHandle, chain: RecoveryChain<E> | null): void {
    this.#everAdmitted.add(owner.creation);
    this.#rememberAdmission(owner);
    this.#rememberApplicationHandle(handle, owner, chain);
    this.#recheckPendingForSpeech(handle.id);
  }

  #rememberAdmission(owner: ActionOwner): void {
    while (this.#admissions.size >= REGISTRY_LIMIT) {
      const oldest = this.#admissions.keys().next().value as string | undefined;
      if (!oldest) break;
      const evicted = this.#admissions.get(oldest);
      if (evicted) {
        const retained = new Set(this.#activeRecovery.values());
        for (const entry of this.#applicationHandles.values()) if (entry.chain) retained.add(entry.chain);
        for (const chain of retained) if (chain.owner === evicted) this.cancelChain(chain);
      }
      this.#admissions.delete(oldest);
    }
    this.#admissions.set(owner.creation.speechId, owner);
  }

  #rememberApplicationHandle(handle: OwnedSpeechHandle, owner: ActionOwner, chain: RecoveryChain<E> | null): void {
    while (this.#applicationHandles.size >= REGISTRY_LIMIT) {
      const oldest = this.#applicationHandles.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = this.#applicationHandles.get(oldest);
      if (entry) {
        this.#cancelApplicationEntry(oldest, entry, "startup_superseded");
        if (entry.chain) this.cancelChain(entry.chain);
        entry.handle.removeDoneCallback?.(entry.done);
      }
      this.#applicationHandles.delete(oldest);
      this.#gap("action_overflow", oldest);
    }
    const done = (settled: OwnedSpeechHandle) => {
      const current = this.#applicationHandles.get(handle.id);
      if (current?.handle === settled) this.#applicationHandles.delete(handle.id);
      settled.removeDoneCallback?.(done);
    };
    this.#applicationHandles.set(handle.id, { handle, owner, chain, done });
    handle.addDoneCallback(done);
  }

  #registerChain(chain: RecoveryChain<E>): void {
    while (this.#activeRecovery.size >= REGISTRY_LIMIT) {
      const oldest = this.#activeRecovery.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = this.#activeRecovery.get(oldest);
      if (entry) {
        this.cancelChain(entry);
        this.#gap("action_overflow", entry.origin.speechId, entry.origin.turnId);
      }
      this.#activeRecovery.delete(oldest);
    }
    this.#activeRecovery.set(chain.id, chain);
  }

  #originStillBound(chain: RecoveryChain<E>): boolean {
    const binding = this.deps.trace.bridgeBinding(chain.origin.turnId);
    return binding.state === "bound" && binding.speechId === chain.origin.speechId;
  }

  #recheckPendingForSpeech(speechId: string): void {
    for (const turnId of [...this.#pendingErrors.keys()]) {
      const binding = this.deps.trace.bridgeBinding(turnId);
      if (binding.state === "bound" && binding.speechId === speechId) this.recheckPending(turnId);
    }
  }

  #dropStalePending(): void {
    for (const [turnId] of this.#pendingErrors) {
      const binding = this.deps.trace.bridgeBinding(turnId);
      if (binding.state !== "bound") continue;
      const admission = this.#admissions.get(binding.speechId);
      if (admission && admission.acceptedEpoch !== this.deps.arbiter.epoch) this.recheckPending(turnId);
    }
  }

  #rememberProcessed(turnId: string): void {
    while (this.#processedTurns.size >= REGISTRY_LIMIT) {
      const oldest = this.#processedTurns.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#processedTurns.delete(oldest);
      this.#decisionOverflowed = true;
    }
    this.#processedTurns.set(turnId, true);
  }

  #evictActiveCreation(): void {
    while (this.#activeCreations.size >= REGISTRY_LIMIT) {
      const oldest = this.#activeCreations.keys().next().value as string | undefined;
      if (!oldest) break;
      const evicted = this.#activeCreations.get(oldest);
      evicted?.handle.removeDoneCallback?.(evicted.done);
      this.#activeCreations.delete(oldest);
      this.#gap("action_overflow", oldest);
    }
  }

  #cancelApplicationEntry(id: string, entry: ApplicationHandle<E>, cause: "startup_superseded" | "call_closed"): void {
    this.deps.trace.markCancellation(id, cause);
    this.#interrupt(entry.handle, id);
  }

  #interrupt(handle: OwnedSpeechHandle, speechId: string, turnId?: string): void {
    try {
      if (handle.done() || handle.interrupted) return;
      handle.interrupt();
    } catch {
      this.#gap("cancel_failed", speechId, turnId);
    }
  }

  #interruptUnowned(handle: OwnedSpeechHandle, turnId?: string): void {
    this.#interrupt(handle, handle.id, turnId);
  }

  #gap(reason: ActionGapReason, speechId: string, turnId?: string): void;
  #gap(reason: ActionGapReason, speechId: string | null, turnId: string): void;
  #gap(reason: ActionGapReason, speechId: string | null, turnId?: string): void {
    try {
      if (speechId === null && turnId !== undefined) this.deps.trace.actionGap(reason, null, turnId);
      else if (speechId !== null) this.deps.trace.actionGap(reason, speechId, turnId);
    } catch {
      // Diagnostic failure never grants or revokes action authority.
    }
  }
}
