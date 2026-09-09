# KPR-464 engine request ownership implementation chunk

> **For agentic workers:** Use dodi-dev:implement after the parent plan's gates pass.

**Goal:** A bridge request can cancel only its own queued/admitted engine turn and always leaves one diagnostic terminal record.

**Architecture:** The adapter creates a fresh AbortController per HTTP request. A typed, ephemeral `voiceRequestSignal` travels through TurnContext; cold admission consumes it around the existing ticket, while a warm lease attaches it only when that request reaches its own demux slot. IDs describe ownership but never confer cancellation authority.

**Tech Stack:** Node HTTP/AbortSignal, existing AgentManager/WarmVoiceSession, TypeScript/Vitest.

This chunk inherits the complete [Testing Contract](./kpr-464-plan.md#testing-contract), S8/S9 and the trace schema from [diagnostics](./kpr-464-plan-diagnostics.md). It changes neither provider routing nor KPR-399/KPR-434 session-persistence rules. `abortThread` remains available to its other existing callers; the HTTP close path stops using it.

### Task 4: Carry cancellation through the actual request owner

**Files:**
- Create: `src/agents/voice-request-cancellation.ts`
- Modify: `src/agents/agent-manager.ts` (`TurnContext`, `TurnResult`, `spawnTurn`, `withSpawnTicket`, `runOneSpawnAttempt`, `openWarmLease`, new `openWarmLeaseAttempt`, `runWarmTurn`)
- Modify: `src/agents/warm-voice-session.ts` (`WarmTurnRequest`, new `WarmRunResult`, `runTurn`, `consumeOneTurn`, `close`)
- Test: `src/agents/voice-request-cancellation.test.ts`
- Test: `src/agents/warm-voice-session.test.ts`

- [ ] **Step 1: Add the disposable request-signal helpers.**

```typescript
export class VoiceRequestCancelledError extends Error {
  constructor() {
    super("Voice request cancelled");
    this.name = "VoiceRequestCancelledError";
  }
}

export function checkVoiceRequest(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VoiceRequestCancelledError();
}

export function bindVoiceRequest(
  signal: AbortSignal | undefined,
  cancel: () => void,
): () => void {
  if (!signal) return () => {};
  let fired = false;
  const onAbort = () => {
    if (fired) return;
    fired = true;
    try { cancel(); } catch { /* AbortSignal listeners must never throw. */ }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => signal.removeEventListener("abort", onAbort);
}
```

The helper contains synchronous callback failures at the actual AbortSignal boundary; Node reports an uncaught listener exception separately from `AbortController.abort()`, so a catch around that caller is insufficient. Cold/warm callbacks also contain their own abort/replay calls. No logger or arbitrary hook may throw from these catches. Add `voiceRequestSignal?: AbortSignal` to `TurnContext`, documented as per-request, voice-only, never serialized into WorkItem/store/audit metadata. `Dispatcher.routeVoiceTurn` already passes the context intact, so no new dispatch path is needed. Add the same optional signal field to `WarmTurnRequest`.

- [ ] **Step 2: Make cold ticket abort sticky and request-specific.**

Extend `withSpawnTicket` with an optional third options argument:

```typescript
options: { requestSignalMode?: "turn" | "admission_only" } = {}
```

At pre-wait and each existing 25 ms lock-wait checkpoint call `checkVoiceRequest(ctx.voiceRequestSignal)` alongside the existing stopped-agent check. Check again immediately before `processing.add(threadKey)`; no `await` intervenes between final check and acquisition. Keep budget/read/add/ticket ordering unchanged.

Replace the local abort-handle implementation with sticky state:

```typescript
let abortHandle: (() => void) | undefined;
let abortRequested = false;
const invokeAbort = () => {
  try { abortHandle?.(); }
  catch { /* Abort stays sticky; provider/logger throws cannot escape cleanup. */ }
};
const ticket: SpawnTicket = {
  agentId: ctx.agentId,
  threadKey,
  workItem: ctx.workItem,
  attachAbort: (handle) => {
    abortHandle = handle;
    if (abortRequested) invokeAbort();
  },
  abort: () => {
    abortRequested = true;
    invokeAbort();
  },
};
```

Install the request listener only for normal `turn` mode, after ticket construction and before any `await`; callback invokes **this ticket**. Dispose it in the existing `finally` that removes this ticket/releases lock and budget. Put post-lock checks and `fn(ticket)` inside that same `try/finally` instead of duplicating cleanup. A signal abort before `fn` begins throws `VoiceRequestCancelledError` and releases resources. An abort during shaping latches until the owning adapter is attached; no thread-wide lookup occurs. Preserve the existing stopped-agent exception and all status/reflection/budget logic.

In `runOneSpawnAttempt`, retain its pre-assembly `abortedEarly` flag. After adapter construction, replace both the attached `() => adapter.abort()` and the direct early-abort call with this shared contained callback:

```typescript
const abortAdapter = () => {
  try { adapter.abort(); }
  catch { /* Actual ClaudeAgentAdapter -> AgentRunner.abort may throw in log/close. */ }
};
ticket.attachAbort(abortAdapter);
```

The bypass branch calls `abortAdapter()` and returns the existing aborted result even when it threw internally. A running adapter still owns its existing deadline/settlement; do not fabricate provider termination when abort failed. The request signal prevents retries and post-cancel output. Tests inject failure at the real adapter abort seam, not only a harmless fake cancel callback. The sticky ticket now replays an abort which arrived before that function installed its early flag. Change the bypass condition to `abortedEarly || ctx.voiceRequestSignal?.aborted`. Return the existing `synthesizeAbortedResult` with shaping cost, so an admitted cancellation remains breaker-neutral. Before any auth/stale-handle retry arm in `spawnTurn`, require `!ctx.voiceRequestSignal?.aborted`; an already-canceled request never starts another provider attempt. Do not discard observed spend or alter resume-on-abort persistence.

This fixes three distinct boundaries: canceled lock-waiter never acquires; canceled preparer never dispatches after its awaits; canceled running request aborts its own provider. Adding a request ID to `abortThread` alone would miss the first two.

- [ ] **Step 3: Keep the warm lifetime ticket separate from per-request interruption.**

**Coordinate before the first acquisition await, including concurrent entry with no published lease.** Add `pendingWarmOpenings: Map<string, Promise<void>>` beside `warmLeases`. Rename the existing opening body `openWarmLeaseAttempt(ctx, onStream, published: () => void)` and wrap it with this method. No ticket, Query or permit is allocated by a joining request:

```typescript
private async openWarmLease(ctx: TurnContext, onStream?: SpawnTurnStreamCallback): Promise<TurnResult> {
  const threadKey = `${ctx.agentId}:${ctx.threadId}`;
  let wake!: () => void;
  const pending = new Promise<void>((resolve) => { wake = resolve; });
  this.pendingWarmOpenings.set(threadKey, pending); // Before invoking the async body.
  const published = () => {
    if (this.pendingWarmOpenings.get(threadKey) === pending) this.pendingWarmOpenings.delete(threadKey);
    wake();
  };
  try { return await this.openWarmLeaseAttempt(ctx, onStream, published); }
  finally { published(); } // Rejection before publication wakes surviving waiters too.
}
```

At `spawnTurn` entry check the request signal, registry and stopped-agent state. In its warm voice branch, keep live `warmLeases` reuse first, then insert the following **before** `isWarmPathEligible`/`openWarmLease`. No await intervenes between this map read, eligibility and the opening wrapper's map insertion:

```typescript
const pending = this.pendingWarmOpenings.get(threadKey);
if (pending) {
  await waitForVoiceOpening(pending, ctx.voiceRequestSignal);
  return this.spawnTurn(ctx, onStream); // Recheck live lease, stop, definition and signal.
}
```

Add the disposable wait to `voice-request-cancellation.ts`:

```typescript
export async function waitForVoiceOpening(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  checkVoiceRequest(signal);
  let detach = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    detach = bindVoiceRequest(signal, () => reject(new VoiceRequestCancelledError()));
  });
  try { await Promise.race([pending, cancelled]); checkVoiceRequest(signal); }
  finally { detach(); }
}
```

The pending promise signals **publication or completed failed admission**, never lease lifetime. After reserving A, insert the fully pinned lease and call `published()` synchronously before awaiting Query initialization. Waiting B then re-enters and queues on that lease. If A fails/cancels before acquiring a ticket, close its unused lease, await `coordinator.catch(() => {})` to finish ticket cleanup, then propagate the original error; the wrapper's finally wakes B to try its own admission. Apply the same close/await/rethrow to failures in post-acquisition eligibility/policy/shaping before publication. In the `opening-ineligible` branch, close the unused lease, await the coordinator, call `published()`, then recurse into `spawnTurn`; otherwise A would wait on its own opening. Identity-checked deletion cannot erase a newer opening. Keep the detached coordinator rejection observer and contain its own rejection. There is only one lifetime admission per opening; published-lease queue readiness alone does not solve concurrent entry.

`openWarmLeaseAttempt` calls `withSpawnTicket(ctx, leaseLifetimeCallback, { requestSignalMode: "admission_only" })`. This checks request cancellation while waiting for acquisition, then leaves the lifetime ticket's abort governed by existing stop/shutdown ownership. The HTTP request's signal must never remain attached to that lifetime ticket after admission, or the first request's delayed close could destroy every later warm turn.

**Reject a closed lifetime before publication or provider initialization, retaining its stopped identity through initialization.** Declare `let lifetimeStopError: AgentStoppedError | undefined` beside `acquired`; install this lifetime callback before `markAcquired()`. The sticky ticket from Step 2 replays an abort that preceded attachment. Allocate one stopped error for this lifetime and pass that same object to the lease before resolving readiness:

```typescript
ticket.attachAbort(() => {
  lifetimeStopError ??= new AgentStoppedError(ctx.agentId);
  lease.close("ticket-abort", lifetimeStopError);
});
```

Define both closures in `openWarmLeaseAttempt`'s method scope so the initialization catch can call `getOpeningStopError`. Put the acquisition race and `checkOpeningLifetime()` invocation inside the pre-publication close/await/rethrow boundary above, with that invocation immediately after the await and before eligibility, policy pinning, shaping or reservation:

```typescript
const getOpeningStopError = (): AgentStoppedError | undefined => {
  if (lifetimeStopError || this.stoppedAgents.has(ctx.agentId)) {
    return lifetimeStopError ??= new AgentStoppedError(ctx.agentId);
  }
  return undefined;
};
const checkOpeningLifetime = () => {
  const stopped = getOpeningStopError();
  if (stopped) throw stopped;
  if (lease.isClosed) throw new Error("Warm voice lease closed before initialization");
};

await Promise.race([ready, coordinator]);
checkOpeningLifetime();
```

`spawnTurn(A); stopAgent(agentId)` in one synchronous stack can acquire and close the ticket before this continuation runs. The guard must inspect the lease as well as current stopped state; a same-stack `restartAgent` clears that state but cannot revive the closed lifetime. Every guard failure closes the lease idempotently with that error as the second argument, awaits `coordinator.catch(() => {})`, and propagates the error; the wrapper then deletes its own pending entry and wakes waiters. Do not publish a closed lease whose `onClosed` already ran, and do not delete/release ticket resources separately from the coordinator. Request cancellation after acquisition does **not** set `lifetimeStopError` or fail this guard: a healthy opening remains available to live B.

In `WarmVoiceSession`, add `private terminalError: Error | undefined` and extend `close(reason: string, terminalError?: Error)`. Immediately after its existing `if (this.closed) return` guard, assign `this.terminalError = terminalError` before marking closed/resolving readiness; retain all existing throw-safe cleanup. Repeated closes never replace the first close's error or cause. Replace `notRunnableError` with this body, preserving the runtime type supplied by the manager without adding a runtime import/cycle:

```typescript
private notRunnableError(): Error {
  return this.terminalError ?? new Error(
    this.closed
      ? `Warm voice lease closed (${this.closeReason ?? "unknown"})`
      : "Warm voice lease not started yet (session still opening)",
  );
}
```

All closed checks at `runTurn` entry, after readiness and at consumption throw `this.notRunnableError()`; none reconstruct a string-only closed-lease error. Thus every reserved request A/B/C that has not consumed input receives the same typed stopped error when this lifetime closes, even if `restartAgent` clears current manager state before queue continuations run. Ordinary initialization failures retain their provider error through the same optional close argument and remain retryable; unrelated closes retain the existing generic fallback. A separately canceled request may still settle as `VoiceRequestCancelledError`, which independently prohibits retry. Do not store either error in WorkItem/session metadata or diagnostic payloads.

**Carry the same lifetime cause across active returned results and later awaits.** Readiness errors alone do not cover an already-consuming request: `consumeOneTurn` deliberately converts `q.next()` EOF/rejection to a returned `RunResult.error` so observed usage survives. Keep that behavior and carry a stable lease-owned signal alongside it. Add these declarations in `warm-voice-session.ts` (the interface is module-level, the controller/signal are session members):

```typescript
export interface WarmRunResult extends RunResult {
  readonly voiceLifetimeSignal: AbortSignal;
}
// WarmVoiceSession members; only this lease can abort its controller.
private readonly lifetimeController = new AbortController();
readonly voiceLifetimeSignal = this.lifetimeController.signal;
```

In `close`, immediately after assigning the first `terminalError`, `closed` and `closeReason`, and **before** resolving readiness, ending input or calling `query.close`, call `this.lifetimeController.abort(this.notRunnableError())`. All consumers below only inspect `aborted/reason`; they install no abort listeners on this signal. First close owns the cause; repeated closes retain the identical reason object. The signal is an in-process lifetime identity, not the HTTP request's cancellation signal, a new admission authority, or serialized metadata. Ordinary failure/idle close aborts it with a non-stopped error; only the manager's existing lifetime ticket callback supplies `AgentStoppedError`. A restart creates a new lease and signal and cannot reset the old one.

Change `runTurn` and `consumeOneTurn` return types to `Promise<WarmRunResult>` and add `voiceLifetimeSignal: this.voiceLifetimeSignal` to the existing final result literal. Do not throw from the active demux on stopped EOF/rejection, return early before accounting, or replace its usage/error/aborted fields. The same reference remains valid if close happens after demux settlement but before the manager, dispatcher or adapter continuation; a boolean captured at demux return cannot provide that guarantee.

Add `voiceLifetimeSignal?: AbortSignal` to `TurnResult`, documented as voice-only and never serialized. In `runWarmTurn`, import/use `WarmRunResult` for its local `runResult`; immediately after the existing `finalizeSpawnResult` call assign `turnResult.voiceLifetimeSignal = runResult.voiceLifetimeSignal`. Retain breaker recording, `finalizeSpawnResult`, `recordSpawnObservability`, `lastTurn` and failure-close in their current order. The new field does not alter spend, KPR-399 abort persistence, churn-mint protection or KPR-434 memory marks. `Dispatcher.routeVoiceTurn` already returns the same `TurnResult` and builds ledger/audit objects field-by-field; keep that pass-through and do not add the signal to those objects.

For throws before a result exists, add `onVoiceLifetimeAdmission?: (signal: AbortSignal) => void` to `TurnContext`, with the same ephemeral restrictions as `voiceRequestSignal`. Deliver the lease signal in `runWarmTurn`'s existing try immediately before the launch-admission callback below. Task 5 retains this reference in that attempt and checks it for **both thrown and returned failures**, then checks the old attempt's reference again immediately before a retry. This closes the demux → manager → dispatcher → adapter asynchronous boundaries without a global stop generation or changes to cold retries.

After acquisition the opening initialization belongs to the lease. Reserve live opener A's demux slot **before publishing** the lease to successor B. In `openWarmLeaseAttempt`, after policy pinning/resume eligibility selection and immediately before `this.warmLeases.set(threadKey, pinnedLease)`, invoke the existing async `runWarmTurn` once; it synchronously checks/acquires its permit and calls `lease.runTurn` before its first await. `runTurn` must synchronously append its chain slot before waiting for start. Attach a rejection observer immediately so initialization cannot leave an unhandled rejection:

```typescript
const openingTurn = this.runWarmTurn(pinnedLease, ctx, onStream);
void openingTurn.catch(() => {}); // Original promise is still returned to A below.
checkOpeningLifetime(); // Reservation/launch-admission callbacks may synchronously stop/restart.
this.warmLeases.set(threadKey, pinnedLease);
published(); // Wakes requests that entered before this registry entry existed.
```

Retain the existing `openVoiceStreamingSession` try/catch and late-Query close guard. In that initialization try, call `checkOpeningLifetime()` before the fresh-spawn `recordSpawn`, again before `createRunner`, and immediately before `runner.openVoiceStreamingSession`; synchronous bookkeeping/construction callbacks cannot dispatch a lifetime they just stopped. No await intervenes between that final check and the provider call. After the awaited Query returns, call `start` **before** the post-await guard so its existing closed guard disposes a late Query exactly once; skipping `start` on a stopped lifetime would orphan that Query. Replace the end of the initialization try/catch with:

```typescript
  lease.start(q, { resumedSessionId: openingCtx.sessionId });
  checkOpeningLifetime(); // Stop/restart during await remains sticky after late-Query cleanup.
} catch (err) {
  // Both rejected initialization and a late successful Query preserve stop identity.
  const failure = getOpeningStopError() ?? err;
  lease.close("open-failed", failure instanceof Error ? failure : undefined);
  await coordinator.catch(() => {});
  throw failure;
}
return openingTurn; // Outside the initialization try/catch; never enqueue A a second time.
```

The opener A remains awaiting initialization while already-queued B can settle from closed readiness; both must propagate `AgentStoppedError`, never a provider rejection or generic closed-lease error that enables the adapter's fresh retry after restart. Pass the caught error into the pre-publication cleanup's `close` as well. The immediately observed reserved promise settles on close without an orphan rejection. Keep the initialization catch separate from the returned opening promise: canceled A's request rejection must not close the healthy lease. A canceled request or circuit-open permit rejection reserves no work; it cannot later push an obsolete full-transcript opening. Starting an otherwise healthy published lease continues for an independently admitted B. There is no await or publication between live A's reservation, the post-callback lifetime check and registry insertion. A's actual breaker acquisition now precedes initialization and is still recorded once; no extra probe permit is introduced.

Extend lease readiness with a promise resolved by either `start(query)` or `close(reason)`. Successors can queue against a published unstarted lease behind A's already-reserved slot; at consumption each awaits readiness then checks closed/canceled state. A readiness promise alone without that pre-publication reservation is insufficient. Closing before a late Query arrives still calls `query.close()` through the existing `start()` guard.

Use one ready signal (no timers):

```typescript
private markReady!: () => void;
private readonly ready = new Promise<void>((resolve) => { this.markReady = resolve; });
```

Call `this.markReady()` after `this.query = query` in successful `start`, and in `close` after marking closed. A canceled opener does not close an otherwise healthy published lease used by its successor. Idle/lifetime reclaim and stopAgent still own whole-lease cleanup.

**Retain launch admission independently of input selection.** Add `onVoiceLaunchAdmission?: (continuity: "resume" | "fresh") => void` to `TurnContext`. This reports the compatible Query launch candidate admitted for this request, including initialization failures before `start`; it does not assert that a Query started, an input was pushed, or a prompt form was consumed. Add `resumeSessionId?: string` to `WarmVoiceLease.opening` and set it from the exact `openingCtx.sessionId` selected below, before reserving A or publishing. Inside `runWarmTurn`'s existing try, after its request check/permit acquisition and before `lease.runTurn`, invoke:

```typescript
checkVoiceRequest(ctx.voiceRequestSignal);
ctx.onVoiceLifetimeAdmission?.(lease.voiceLifetimeSignal);
ctx.onVoiceLaunchAdmission?.(lease.opening.resumeSessionId ? "resume" : "fresh");
checkVoiceRequest(ctx.voiceRequestSignal); // A callback can synchronously disconnect this request.
```

Thus A and any live B admitted against this launch retain resume evidence when `openVoiceStreamingSession` throws before readiness/selection. A canceled before admission receives no launch callback; later cancellation still prohibits adapter retries. Cold admission keeps its existing callback. Task 5 latches positive continuity from either callback and separately records launch admission versus actual input selection. Never clear positive launch evidence merely because selection was never reached.

**Choose prompt continuity when the surviving request consumes the slot.** Remove `shapeVoicePrompt(ctx, true)` and the early `onVoiceAdmission("warm")` from `spawnTurn`'s reused-lease branch; pass the original `ctx` into `runWarmTurn`. In `openWarmLeaseAttempt`, preserve that original `ctx.voicePrompt` for the reserved request. Derive a separate `openingCtx = this.shapeVoicePrompt(ctx, !!ctx.sessionId)` after the existing provider compatibility check solely to select the Query's resume candidate, and use `openingCtx.sessionId` for `openVoiceStreamingSession` and the fresh-spawn guard (`if (!openingCtx.sessionId) this.recordSpawn(ctx.workItem.source.id)`). Replace the old early opening callback with the launch-admission channel above; it is separate from consumption-time `onVoiceAdmission`. The stream input is still provided by the per-request queue, never by `openingCtx.workItem.text` during initialization.

Replace the original policy pin/compatibility/shaping block with this order, inside the pre-publication cleanup boundary. Readonly launch metadata is complete when constructed:

```typescript
const definition = this.registry.get(ctx.agentId)!;
const openingRoute = resolveProviderModel(definition.model);
if (ctx.sessionProvider && ctx.sessionProvider !== openingRoute.provider) {
  ctx = { ...ctx, sessionId: undefined, sessionProvider: undefined };
}
const openingCtx = this.shapeVoicePrompt(ctx, !!ctx.sessionId);
const pinnedLease: WarmVoiceLease = Object.assign(lease, {
  opening: {
    model: definition.model,
    route: openingRoute,
    timeoutMs: definition.timeoutMs ?? 300_000,
    resumeSessionId: openingCtx.sessionId,
  },
});
```

Extend `start(query, options = {})` with `options: { resumedSessionId?: string }`; the manager passes the exact candidate used to construct that Query. Add `private resumedSessionId: string | undefined`; store the supplied ID only on successful start, before resolving readiness. Add `private inputPushed = false` to the lease. Neither registry publication, reservation, canceled skipped slots nor `turnCount` alone supplies prompt continuity. Add this optional selector while retaining `text` for existing direct lease callers:

```typescript
export interface WarmInputAdmission {
  continuity: "fresh" | "resume" | "warm";
  turnSeq: number;
  launchSessionId?: string;
}
// WarmTurnRequest:
selectText?: (admission: WarmInputAdmission) => string;
```

After readiness and final closed/canceled checks, but before any turn-state mutation in `consumeOneTurn`, choose the input synchronously:

```typescript
const admission: WarmInputAdmission = {
  continuity: this.inputPushed ? "warm" : this.resumedSessionId ? "resume" : "fresh",
  turnSeq: this.turnCount + 1,
  launchSessionId: this.resumedSessionId,
};
const requestText = req.selectText?.(admission) ?? req.text;
checkVoiceRequest(req.voiceRequestSignal); // Selector/admission callback may reenter abort.
```

Use `requestText` in the existing `composeTurnInput` push and set `inputPushed = true` immediately after that successful synchronous push. No await or foreign callback occurs between the final signal check and owner setup/push. Canceled A that never pushed leaves a fresh Query empty, so B selects its own full conversation, including A's earlier caller text, exactly once. A that did push supplies continuity even when later interrupted; B then selects only its latest message. A Query actually launched with the compatible resume candidate retains that continuity even if its reserved opener was canceled. Provider resume failures still use the existing failure/outer fresh retry path.

In `runWarmTurn`, capture the selected context/admission in this request's closure; use them for finalization, observability, `lastTurn`, `resumedSession` and `warmTurnSeq`, rather than a successor's mutable lease count:

```typescript
let admittedCtx = ctx;
let selected: WarmInputAdmission | undefined;
// Fields in the existing lease.runTurn call:
selectText: (admission) => {
  selected = admission;
  admittedCtx = this.shapeVoicePrompt({ ...ctx,
    ...(admission.continuity === "resume" ? { sessionId: admission.launchSessionId,
      sessionProvider: route.provider } : {}),
  }, admission.continuity !== "fresh");
  admittedCtx.onVoiceAdmission?.(admission.continuity);
  return admittedCtx.workItem.text;
},
```

After successful `lease.runTurn`, require `selected` to exist, assign `ctx = admittedCtx`, derive `resumedSession = selected.continuity === "resume"` and `warmTurnSeq = selected.turnSeq`. An absent selection on a successful result is an invariant failure and closes the lease through normal failure handling. No selection runs for a canceled queued request, and no request can replay an already-pushed full transcript.

In `runTurn`, retain `turnChain` serialization and rejection recovery. Add `private enqueueGeneration = 0`; check canceled/closed before queueing, then execute `this.enqueueGeneration += 1` synchronously immediately before appending the chain slot. This invalidates an idle interrupt owner as soon as a successor queues, including while its ready/chain callback has not run. In the chain callback, await `ready`, check cancellation again, then call `consumeOneTurn(req)`. If the signal is already canceled while the request waits, it must not push a message, increment `turnCount`, disarm the idle timer or call `query.interrupt()`. Do not add a global listener at `runTurn` entry: a queued request's signal would otherwise interrupt the current different turn.

In `consumeOneTurn`, after existing closed/query checks and before any state mutation call `checkVoiceRequest(req.voiceRequestSignal)`. After setting `turnInFlight`, resetting interruption state and assigning the turn number, attach:

```typescript
const ownedTurn = this.turnCount;
const detachRequest = bindVoiceRequest(req.voiceRequestSignal, () => {
  if (this.closed || !this.turnInFlight || this.turnCount !== ownedTurn) return;
  try {
    this.requestInterrupt("voice-request-disconnected");
  } catch {
    // Existing requestInterrupt promise rejection/grace paths own escalation.
    // Never throw through an HTTP abort event listener.
  }
});
```

No `await` may occur between the final pre-push signal check, installing this owner and pushing this request's user message. If cancellation raced before attachment, rechecking/binding handles it synchronously. Dispose `detachRequest()` first in the existing `finally`, before setting `turnInFlight=false` and rearming idle. Suppress `req.onStream` when `req.voiceRequestSignal?.aborted`, including tool-ack text; still consume the result boundary so the next turn cannot read the predecessor's output. Retain the grace window, but replace `requestInterrupt` escalation with ownership checks on **every asynchronous path**, including rejection. Capture Query identity, turn sequence, whether a turn was in flight, and queue generation for an idle interruption; a predecessor's late failure may close only that same still-active owner. Use this body (retain the existing safeLog implementation):

```typescript
requestInterrupt(reason: string): void {
  const query = this.query;
  if (this.closed || !query) return;
  const turn = this.turnCount;
  const inFlight = this.turnInFlight;
  const enqueued = this.enqueueGeneration;
  const stillOwns = () => !this.closed && this.query === query &&
    this.turnCount === turn && this.turnInFlight === inFlight &&
    (inFlight || this.enqueueGeneration === enqueued);
  this.interruptRequested = true;
  const failed = () => {
    if (!stillOwns()) return;
    safeLog("warn", "Warm voice interrupt failed", { ...this.logCtx(), reason });
    this.close(`interrupt-failed:${reason}`);
  };
  let interruption: Promise<void>;
  try { interruption = query.interrupt(); }
  catch { failed(); return; }
  void interruption.then(() => {
    if (!inFlight || !stillOwns()) return;
    const grace = setTimeout(() => {
      this.interruptGraceTimers.delete(grace);
      try { if (stillOwns()) this.close("interrupt-noop"); }
      catch { /* close is throw-safe; contain foreign implementations. */ }
    }, WARM_INTERRUPT_GRACE_MS);
    grace.unref?.();
    this.interruptGraceTimers.add(grace);
  }, failed).catch(() => {});
}
```

Add `private readonly interruptGraceTimers = new Set<NodeJS.Timeout>()`; delete each timer from the set when it fires, and clear/delete all timers on turn settlement and lease close. The timer's deletion must occur before its owner check. A stale success must not arm a timer; a stale rejection cannot close an idle lease or a running/queued successor. Preserve same-owner failure escalation and stopped-agent whole-lease cleanup. Queueing B does not invalidate an interrupt of still-active A: its escalation must still unblock A's stuck demux. The queue-generation check applies only to idle interrupts.

Pass `voiceRequestSignal: ctx.voiceRequestSignal` in `runWarmTurn`'s `lease.runTurn` call. Add `checkVoiceRequest(ctx.voiceRequestSignal)` before breaker acquisition. Replace its catch with the following request-cancellation branch ahead of existing provider failure handling; `TurnClassification` already defines `{ outcome: "aborted" }` as breaker-neutral:

```typescript
} catch (err) {
  if (err instanceof VoiceRequestCancelledError) {
    this.circuitBreakers.record(permit, { outcome: "aborted" }, 0);
    throw err;
  }
  this.circuitBreakers.record(permit, classifyThrown(err), 0);
  lease.close("turn-failure");
  throw err;
}
```

A queued canceled request therefore settles its permit without closing a healthy lease. Keep normal provider/session failures closing the lease as before. No caught request cancellation may initiate outer resume retry in the adapter.

- [ ] **Step 4: Prove owner isolation using real manager/lease code.**

Extend the manager fixture from `src/agents/agent-manager.test.ts`; mock only stores/provider adapters/config. Required barriers/assertions:

1. A owns cold ticket, B queues. Abort B: A is not aborted, B never calls provider after A finishes, lock/budget return to baseline.
2. A finishes, B becomes active, then A's original signal aborts: B's abort spy remains zero and B completes.
3. A is canceled during prompt/store preparation or async provider assembly: no later `adapter.runTurn`, no retry, sticky abort does not affect B. Inject a real cold adapter whose `abort()` throws from its runner/log/Query-close path, during running abort and sticky post-assembly replay: no uncaught AbortSignal listener exception, no canceled retry, early cancellation remains breaker-neutral, and eventual settlement releases lock/budget.
4. Warm A consumes, B queues. Abort B: A continues, B pushes no message; C subsequently completes on the same Query.
5. Warm A is interrupted, drains result, then B consumes. Abort A again/late: no new Query interrupt, B completes and lease remains open.
6. Publish live opener A while Query start is gated, then admit B before start: A consumes exactly once before B, and no full-transcript opener follows B. Repeat with A canceled before start: A pushes no message, B consumes exactly once and progresses with its full transcript. Put distinct earlier/current caller sentinels in B's full conversation; assert both reach the fresh provider input exactly once and C pushes only its latest message. Repeat with A having pushed before cancellation (B latest only), and with a genuinely resumed Query (B latest only and resume observability derives from lease launch). Close during initialization closes the late Query once and releases lock/budget.
7. A requests interruption, drains result, and B begins before the interrupt promise rejects: rejection neither closes Query/lease nor interrupts B; B completes. Repeat stale resolution (no grace timer), same-owner rejection (lease closes), and idle interrupt rejection after a successor starts (successor survives). Also reject an idle interruption then synchronously queue B before promise reactions execute: the rejection callback runs before B's consumption callback; B remains queued/alive and then completes. This test must assert `turnCount`/`turnInFlight` have not changed at rejection, so it cannot pass merely by testing an already-started B. Same idle owner with no successor still escalates.
8. stopAgent and shutdown still close the entire warm lease; request cancellation preserves its lease. With no test-only await inserted, execute `const a = manager.spawnTurn(A); manager.stopAgent(agentId);` synchronously while the real acquisition promise has resolved but its continuation has not run. A rejects with `AgentStoppedError`; no reservation, publication, runner construction or `openVoiceStreamingSession` occurs, and `warmLeases`, `pendingWarmOpenings`, tickets, processing and budget return to baseline after settlement. Repeat with `spawnTurn(B)` between A and stop: B waits on the pending opening, wakes after A's coordinator cleanup, rejects as stopped, and leaves no pending waiter or second ticket. Repeat same-stack stop followed immediately by `restartAgent` before A's continuation: the old A still rejects and initializes nothing even though current stopped state is clear. Assert empty registries/resources first, then let new C open/complete normally so old cleanup cannot erase its lease. Also trigger stop, and stop followed by restart, synchronously from A's `onVoiceLaunchAdmission` callback: the post-reservation guard prevents publication/provider initialization and closes readiness so A's observed reserved promise settles without orphan rejection or permit leak. Repeat shutdown at these boundaries. Keep request-abort controls at the same boundaries: canceled A reserves/pushes no obsolete input, while live B opens/continues on the same healthy acquired lifetime and sends its full conversation exactly once.
9. Thrown preparation/admission/provider error, canceled queued request and zero-progress abort retain existing breaker and persistence semantics.
10. Invoke `spawnTurn(A)` and `spawnTurn(B)` synchronously in the same stack with `warmLeases` initially absent; gate A's acquisition continuation **before registry publication**. Assert B sees `pendingWarmOpenings`, never enters a second `withSpawnTicket`, and does not finish merely from an idle/lifetime timeout. Release acquisition, keep Query start gated, assert one ticket/budget slot and B queued behind A; release start and drive A/B to normal completion on the same Query. Repeat canceling A after acquisition but before publication/start: B sends its full sentinel conversation once and completes on the surviving lease without advancing idle/lifetime clocks or releasing its lifetime ticket. Repeat A canceled while still waiting behind a cold ticket: B wakes after A's admission cleanup, obtains one new ticket and completes; A has no provider input. Cancel B while awaiting the opening notification: no B permit/ticket/input and A survives. Test pre-publication budget/pinning failures, post-publication init failure, stop/shutdown, and eligibility reroute; all settle pending entries and ticket resources without self-wait or an orphan promise.
11. Use real adapter/manager composition from Task 5: compatible stored resume → `openVoiceStreamingSession` throws before `start`/`selectText` → exactly one adapter retry with cleared resume and full conversation → fake provider output completes. Assert attempt 1 has launch admission `resume`, no selected prompt, and one failed terminal; attempt 2 has launch admission `fresh`, selected full prompt, and normal output. Repeat with disconnect before admission and while resumed initialization is gated: zero retry and no post-cancel output. Include a live joining B on the failed resumed opening; its own launch evidence is retained rather than borrowed from A's callback.
12. Gate `openVoiceStreamingSession` **after provider entry**, admit A with a compatible resume, and join live B (also C for queue-chain coverage) against the published unstarted lease. Confirm each request recorded its own `resume` launch admission and no input selection. Stop the manager, then settle the initialization gate with either a Query or a rejection. Repeat both cases with `restartAgent` immediately after stop and before gate settlement. B/C reject with the lease's exact `AgentStoppedError` while initialization is still held; A rejects with the same object when the gate settles. All requests have one adapter `runOnce`, zero outer retries and no selected/pushed input despite positive resume admission; no fresh provider initialization occurs for these old requests. Late success closes that Query exactly once; late rejection still surfaces the stopped cause. Assert readiness/reserved promises settle, permits/lock/budget/tickets and both opening registries return to baseline, with no orphan rejection. For restart, open independent new D while old A is still gated; let D initialize/complete, then settle old A and prove its cleanup cannot close/delete D's lease or ticket. Repeat shutdown, and retain the ordinary live resumed-init-failure control from case 11: the typed stop exclusion must not disable its one fresh/full retry.
13. Start a compatible resumed Query and let A **push/consume input before its first text**, holding the actual `q.next()` demux read. Queue B/C behind A, stop, immediately restart, then settle that pending read separately as EOF and rejection. Use the real `consumeOneTurn` loop (the plan prerequisite may execute an extraction; delivery tests import the production session), not a fake lease returning a stopped error: A returns its existing error result with the lease's signal, B/C throw the exact stopped reason without pushing, and real `runWarmTurn` finalizes A's observed usage once. Through Task 5's adapter each old request has one attempt and zero retries; independent new D after restart gets a different signal, completes normally, and survives old cleanup. Repeat without restart and with shutdown. Inject assistant usage/session ID before the gate and assert its nonzero token counters, duration fallback, spend observation and existing persistence decisions are retained; also settle with a provider error result carrying nonzero `total_cost_usd` and assert that exact cost survives; separately test same-ID persistence, failed-resume changed-ID rejection, and observed-progress versus zero-progress request-abort persistence without changing their predicates. Keep ordinary live pre-text resumed EOF/rejection controls: one fresh/full retry; partial-response EOF/rejection controls: zero retries because bytes were sent. Finally stop/restart after the demux result was built but before manager continuation, during the dispatcher continuation, and from retry logging before the final retry call: the same signal is still checked and no stopped old attempt retries. The last boundary uses a retained lifetime that is still active when stop occurs; an ordinary failed lifetime already closed and fully released before a later independent stop keeps its original non-stopped cause.

Run: `npx vitest run src/agents/voice-request-cancellation.test.ts src/agents/warm-voice-session.test.ts src/agents/agent-manager.test.ts`

Expected: all owner assertions pass, no rejected orphan promise, lock/budget leak, extra warm message, or successor interruption. Commit only after those checks pass:

```bash
git add src/agents/voice-request-cancellation.ts src/agents/voice-request-cancellation.test.ts src/agents/agent-manager.ts src/agents/warm-voice-session.ts src/agents/warm-voice-session.test.ts
git commit -m "fix(voice): scope disconnect cancellation to its request"
```

### Task 5: Add complete HTTP engine diagnostics without changing response behavior

**Files:**
- Modify: `src/channels/voice/voice-adapter.ts` (`handleRequest`, `handleChatCompletion`, `spawnTurnViaAgentManager`)
- Test: `src/channels/voice/voice-adapter.integration.test.ts`
- Create: `src/channels/voice/voice-startup.integration.test.ts`

- [ ] **Step 1: Initialize request trace after authentication/agent resolution and before async lookup.**

`OpenAIChatRequest.metadata` already exists as `Record<string, unknown>`; preserve it. Read only `metadata.voiceTrace` through the shared validator. Missing/malformed metadata gets a fresh engine UUID with `correlation: "legacy"` or `"invalid"`; emit a bounded invalid-trace observation without the input value. Valid metadata contributes worker boot ID/turn ID only. Keep `call.metadata` as the existing prompt-bearing goal/context/agent surface; never merge trace metadata there or into WorkItem/meta.

Construct a request scope before `handleChatCompletion` creates/looks up a session so exceptions in that path are included. Use a request-local abort controller, start time, outcome and finalizer; stable `completionId` may use the turn UUID but need not equal it. Attach `close` before the first await:

```typescript
const requestAbort = new AbortController();
let clientGone = res.destroyed === true;
const onClose = () => {
  if (res.writableEnded) return;
  clientGone = true;
  requestAbort.abort();
  trace.observe("engine_client_closed", {});
};
res.on("close", onClose);
if (clientGone) requestAbort.abort();
```

The callback does not call `agentManager.abortThread`. The final `finally` detaches this callback and emits exactly one request terminal including duration, status if actually sent, first-text measurement or null reason, `engineAttemptSeq`, `clientGone` and outcome. If the socket closes after `spawnTurn` settled but before response finalization, its signal still only references this ended request.

- [ ] **Step 2: Wrap every authenticated execution path in the scope.**

Move `buildVoiceSystemPrompt`, session store lookup and work-item assembly inside the existing request `try/catch/finally`. Preserve top-level auth/unknown-agent rejection semantics. Check `requestAbort.signal.aborted` after each preparation await and before admission/retry; no subsequent spawn or response write follows a disconnect. Add `voiceRequestSignal: requestAbort.signal` to TurnContext and retain it in all spread retry contexts. `runOnce` increments `engineAttemptSeq` before entering dispatcher/manager, emits attempt-start, then emits its own attempt-terminal in `finally`. The adapter's existing resume/full-transcript retry retains the bridge turn ID and increases the engine attempt number. At each `runOnce` entry reset the request-local latch and both nullable observations; install these callbacks on `spawnCtx` (fields are bounded continuity enums):

```typescript
onVoiceLaunchAdmission: (continuity) => {
  launchAdmission = continuity;
  hasAdmittedContinuity ||= continuity === "resume";
},
onVoiceAdmission: (continuity) => {
  selectedContinuity = continuity;
  hasAdmittedContinuity ||= continuity === "warm" || continuity === "resume";
},
```

Declare `launchAdmission: "fresh" | "resume" | null` and `selectedContinuity: "fresh" | "resume" | "warm" | null` in that attempt's scope, initialized to null. Include both in the attempt terminal; preserve null if initialization failed before selection. Use the latch only for retry eligibility and the existing `continuityAttempted` diagnostic; consumed prompt/`resumedSession` telemetry derives from the selected admission/result. Add `!requestAbort.signal.aborted` and request-cancel-error/`AgentStoppedError` exclusions to the existing pre-bytes outer-retry predicate (carry typed cancellation and stopped flags from both failure paths below). A compatible resumed initialization failure with a live request gets its one fresh/full retry even if no selection callback ran. A canceled request or stopped lifetime never retries, regardless of retained launch evidence or an immediate restart; keep the existing stopped-agent response classification.

**Observation scope:** `engineAttemptSeq` counts adapter `runOnce` entries, each of which calls the dispatcher/manager once. Existing manager-internal auth-rebuild, stale-handle and Claude-resume retries can call `runOneSpawnAttempt` more than once inside that single observed attempt; they neither increment this sequence nor emit additional schema-v2 attempt terminals. The recorded result/stages are the manager's returned aggregate/final result, and nullable launch/selection observations describe only their explicit callbacks. Do not label `engineAttempts` a count of provider launches or imply this schema separately observes every manager-internal retry. Preserve those existing retry and breaker/persistence semantics; no provider-attempt ID is added in this child.

Import `AgentStoppedError` from the manager, extend `runOnce`'s existing failure union with `cancelled?: boolean; stopped?: boolean; voiceLifetimeSignal?: AbortSignal`, and define this local reader beside `runOnce`:

```typescript
const getVoiceStopError = (signal?: AbortSignal): AgentStoppedError | undefined =>
  signal?.aborted && signal.reason instanceof AgentStoppedError ? signal.reason : undefined;
```

Inside each `runOnce`, declare its own `let voiceLifetimeSignal: AbortSignal | undefined`. Add `onVoiceLifetimeAdmission: (signal) => { voiceLifetimeSignal = signal; }` to its `spawnCtx` callbacks. After the awaited dispatcher/manager result and **before** testing `result.errors`, adopt `voiceLifetimeSignal = result.voiceLifetimeSignal ?? voiceLifetimeSignal`. Replace the returned-error branch with:

```typescript
if (result.errors.length > 0) {
  const stoppedError = getVoiceStopError(voiceLifetimeSignal);
  return {
    ok: false,
    reason: stoppedError ? String(stoppedError) : result.errors[0]!,
    bytesSent: headersSent,
    cancelled: requestAbort.signal.aborted || result.aborted === true,
    stopped: stoppedError !== undefined,
    voiceLifetimeSignal,
  };
}
```

Add these fields to the existing catch return, retaining `circuitOpen` and response behavior. Also prefer `String(getVoiceStopError(voiceLifetimeSignal) ?? err)` for its reason; a dispatcher throw after stop must not erase the underlying stopped cause:

```typescript
cancelled: err instanceof VoiceRequestCancelledError,
stopped: err instanceof AgentStoppedError || getVoiceStopError(voiceLifetimeSignal) !== undefined,
voiceLifetimeSignal,
```

Immediately after `let outcome = await runOnce(ctx)`, and again after the retry block before final failure/response classification, normalize any failure from its retained signal. This keeps the request's stopped classification current when a stop occurred after the attempt's `finally`; an already-emitted attempt terminal remains the truthful observation at its own settlement:

```typescript
if (!outcome.ok) {
  const stoppedError = getVoiceStopError(outcome.voiceLifetimeSignal);
  if (stoppedError) outcome = { ...outcome, stopped: true, reason: String(stoppedError) };
}
```

The existing outer retry `if` additionally requires `!outcome.cancelled && !outcome.stopped && !getVoiceStopError(outcome.voiceLifetimeSignal)`. Keep its continuity, circuit-open, byte-count, disconnect and request-signal guards. Preserve the existing retry context/logging, then replace only its final `outcome = await runOnce(retryCtx)` with this last synchronous guard (set `outerRetryFired` only in the `else`):

```typescript
const stoppedBeforeRetry = getVoiceStopError(outcome.voiceLifetimeSignal);
if (stoppedBeforeRetry) {
  outcome = { ...outcome, stopped: true, reason: String(stoppedBeforeRetry) };
} else if (!requestAbort.signal.aborted && !clientGone) {
  outerRetryFired = true;
  outcome = await runOnce(retryCtx);
}
```

No await or foreign callback may intervene between that final guard and `runOnce`. Each attempt retains its own signal; do not reset or replace the failed attempt's signal before the decision, reconstruct it from current manager state, or serialize it into trace/response/store payloads. Terminal diagnostics consume only the derived bounded stopped/error classification. Ordinary returned provider errors without cancellation/stopped cause remain eligible for the existing one retry, including when their lease signal is aborted for an ordinary failure. Successful result accounting and explicit abort classification remain unchanged.

Request outcome categories: `completed` for successful normal response including no-content; `cancelled` for local disconnect/request-canceled exception or explicit returned abort; `failed` for lookup/admission/provider/SSE failure; `incomplete` only when execution finalization itself cannot observe an end (reader reconstructs process loss). Keep classified `errorClass` separate. Do not classify disconnect as barge-in. No-content completion carries `firstText: { value: null, reason: "not_reached" }` and `generatedAudio: unknown`.

Keep 503 engine-auth/budget, 500 internal errors, circuit-open spoken notice, error-sentinel framing and nonstreaming body behavior unchanged. A response writer throw is caught and terminalized as `sse_write_failed`; safely end/destroy only this response. If headers were already sent, preserve the existing error close when writable; never write to destroyed/writable-ended response. Request catch/finally must run even when prompt building or session lookup throws before `runOnce` exists.

- [ ] **Step 3: Centralize actual text-write observations.**

Route model chunks, tool acknowledgements and existing circuit-outage spoken text through one request-local observer invoked immediately around the real `res.write`/`res.end` operation. Record first nonempty SSE text only if the write was attempted on a live writable socket; `write(false)` indicates accepted backpressure, not failure. A throw is a write failure and must latch the request outcome **inside the helper**, before propagation: `onStream` exceptions can be swallowed by provider/warm consumers. Install a request-local response `error` listener for asynchronous write failures too and detach it in the outer finally. Centralize all raw writes/end calls behind this closure (use a concrete typed request trace at implementation):

```typescript
let writeFailed = false;
const latchWriteFailure = () => {
  if (writeFailed) return;
  writeFailed = true;
  trace.fail("sse_write_failed");
  requestAbort.abort();
};
const writeChunk = (chunk: string, contentLength: number): boolean => {
  if (clientGone || res.destroyed || res.writableEnded || writeFailed) return false;
  try {
    const acceptedWithoutBackpressure = res.write(chunk, (error?: Error | null) => {
      if (error) latchWriteFailure();
    });
    if (contentLength > 0) trace.text(contentLength, performance.now());
    return acceptedWithoutBackpressure; // false is accepted backpressure, not failure.
  } catch (error) {
    latchWriteFailure();
    throw error;
  }
};
res.on("error", latchWriteFailure);
```

Terminal precedence reads the latched `writeFailed` flag even if spawn returns a nominal result; it cannot become completed or cancelled merely because failure-triggered cleanup aborts. On response finalization, observe `finish`/`close`/`error` and settle any still-pending writes before choosing the request terminal, with a bounded teardown timeout producing `incomplete` if necessary; text streaming never waits for diagnostics. Apply the same latch-before-propagation rule to `res.end`. Preserve stream chunk delivery; no buffering or waiting for diagnostics. Include text length, never content. For nonstreaming record response text length and separate response-complete timing; don't falsely label a nonstreaming response as first SSE text.

Retain legacy successful `Voice turn complete` fields for existing consumers but correct its comment: `firstTokenMs` measures engine text emission, including hold phrases, not first audio or caller receipt. Add trace version/turn ID to that line or emit a clearly separate schema-v2 event. Stage/tool fields use an allowlist of numeric durations/counts and boolean warm/ack state; do not spread arbitrary provider objects or log raw exception/request bodies in the new diagnostic rows.

- [ ] **Step 4: Cross real HTTP with real cancellation ownership.**

Keep existing HTTP tests for both auth schemes, assistant resolution, payload compatibility, response framing and interrupted-marker/full-transcript retries. Extend them for valid/missing/oversized/malformed metadata; metadata must not appear in `systemPromptOverride`, WorkItem text/meta or audit input. Capture new logs and assert no secret/transcript/phone sentinel.

Create `voice-startup.integration.test.ts` composing real `VoiceAdapter`, `Dispatcher.routeVoiceTurn` (when configured), `AgentManager` and `WarmVoiceSession` with fake provider/store dependencies. Use two real HTTP client requests and explicit server-side barriers. In cold and warm modes, settle predecessor engine work, admit/queue the replacement, and only then close the predecessor client socket. Assert replacement emits text, reaches a normal done frame, settles, and owns its own new trace/attempt IDs. Also close a queued successor before admission and prove it never invokes provider. At least one scenario must pipe the replacement's SSE through real HiveLLM and fake TTS/output fixture to prove forward progression across both boundaries.

Assert one request terminal and each adapter `runOnce` attempt terminal on: prompt failure, lookup failure, budget rejection, provider circuit-open, returned errors, resumed retry, no-content, midstream failure, throwing response write swallowed by warm/provider onStream, async response write callback/error failure, accepted write(false), disconnect before spawn and disconnect after text. Add a resumed launch-admission callback that stops/restarts the manager before publication: the stopped request has one attempt, no outer retry, no provider initialization and a request terminal despite its positive launch evidence. Also cover the post-publication gated-initialization matrix from Task 4 case 12 using real HTTP A/B: stop and immediate restart, each with late provider success/rejection; both requests retain typed stopped flags, one attempt/one request terminal each, no fresh retry and no input/output for the old lifetime. Let a new independent HTTP request succeed after restart to expose stale cleanup. Add case 13's active real-demux EOF/rejection matrix and later-continuation stop boundaries: the returned-error arm must retain the stopped classification, observed usage/persistence and one request/attempt terminal; queued B/C and independent D verify lifetime isolation. Include ordinary returned failure and partial-response controls, and assert lifecycle signals/error objects are absent from HTTP, ledger/audit, persistence and new diagnostic payloads. Include a cold manager-internal resume retry control: two `runOneSpawnAttempt` calls inside one `runOnce` yield one schema-v2 engine attempt; an adapter outer retry yields two. Error while a predecessor is winding down cannot trigger a successor abort or retry. Existing warm/tool-ack suites remain required.

Run: `npx vitest run src/channels/voice/voice-adapter.test.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts src/agents/voice-tool-ack.test.ts`

Expected: all pass with actual loopback HTTP connections, real cancellation coordinator, zero skipped ownership cases. Then:

```bash
git add src/channels/voice/voice-adapter.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts
git commit -m "feat(voice): trace every engine bridge request outcome"
```
