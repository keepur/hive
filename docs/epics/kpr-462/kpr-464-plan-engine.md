# KPR-464 engine request ownership implementation chunk

> **For agentic workers:** Use dodi-dev:implement after the parent plan's gates pass.

**Goal:** A bridge request can cancel only its own queued/admitted engine turn and always leaves one diagnostic terminal record.

**Architecture:** The adapter creates a fresh AbortController per HTTP request. A typed, ephemeral `voiceRequestSignal` travels through TurnContext; cold admission consumes it around the existing ticket, while a warm lease attaches it only when that request reaches its own demux slot. IDs describe ownership but never confer cancellation authority.

**Tech Stack:** Node HTTP/AbortSignal, existing AgentManager/WarmVoiceSession, TypeScript/Vitest.

This chunk inherits the complete [Testing Contract](./kpr-464-plan.md#testing-contract), S8/S9 and the trace schema from [diagnostics](./kpr-464-plan-diagnostics.md). It changes neither provider routing nor KPR-399/KPR-434 session-persistence rules. `abortThread` remains available to its other existing callers; the HTTP close path stops using it.

### Task 4: Carry cancellation through the actual request owner

**Files:**
- Create: `src/agents/voice-request-cancellation.ts`
- Modify: `src/agents/agent-manager.ts` (`TurnContext`, `withSpawnTicket`, `runOneSpawnAttempt`, `openWarmLease`, `runWarmTurn`)
- Modify: `src/agents/warm-voice-session.ts` (`WarmTurnRequest`, `runTurn`, `consumeOneTurn`)
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
    cancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => signal.removeEventListener("abort", onAbort);
}
```

The `cancel` callback supplied by cold/warm code must be throw-safe; these callbacks call existing safe cancellation, never a logger or arbitrary hook without a catch. Add `voiceRequestSignal?: AbortSignal` to `TurnContext`, documented as per-request, voice-only, never serialized into WorkItem/store/audit metadata. `Dispatcher.routeVoiceTurn` already passes the context intact, so no new dispatch path is needed. Add the same optional signal field to `WarmTurnRequest`.

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
const ticket: SpawnTicket = {
  agentId: ctx.agentId,
  threadKey,
  workItem: ctx.workItem,
  attachAbort: (handle) => {
    abortHandle = handle;
    if (abortRequested) handle();
  },
  abort: () => {
    abortRequested = true;
    abortHandle?.();
  },
};
```

Install the request listener only for normal `turn` mode, after ticket construction and before any `await`; callback invokes **this ticket**. Dispose it in the existing `finally` that removes this ticket/releases lock and budget. Put post-lock checks and `fn(ticket)` inside that same `try/finally` instead of duplicating cleanup. A signal abort before `fn` begins throws `VoiceRequestCancelledError` and releases resources. An abort during shaping latches until the owning adapter is attached; no thread-wide lookup occurs. Preserve the existing stopped-agent exception and all status/reflection/budget logic.

In `runOneSpawnAttempt`, retain its pre-assembly `abortedEarly` flag and adapter abort attachment. The sticky ticket now replays an abort which arrived before that function installed its early flag. Change the bypass condition to `abortedEarly || ctx.voiceRequestSignal?.aborted`. Return the existing `synthesizeAbortedResult` with shaping cost, so an admitted cancellation remains breaker-neutral. Before any auth/stale-handle retry arm in `spawnTurn`, require `!ctx.voiceRequestSignal?.aborted`; an already-canceled request never starts another provider attempt. Do not discard observed spend or alter resume-on-abort persistence.

This fixes three distinct boundaries: canceled lock-waiter never acquires; canceled preparer never dispatches after its awaits; canceled running request aborts its own provider. Adding a request ID to `abortThread` alone would miss the first two.

- [ ] **Step 3: Keep the warm lifetime ticket separate from per-request interruption.**

`openWarmLease` calls `withSpawnTicket(ctx, leaseLifetimeCallback, { requestSignalMode: "admission_only" })`. This checks request cancellation while waiting for acquisition, then leaves the lifetime ticket's `attachAbort(() => lease.close("ticket-abort"))` governed by existing stop/shutdown ownership. The HTTP request's signal must never remain attached to that lifetime ticket after admission, or the first request's delayed close could destroy every later warm turn.

After acquisition the opening initialization belongs to the lease. Reserve live opener A's demux slot **before publishing** the lease to successor B. In `openWarmLease`, after policy pinning/prompt shaping and immediately before `this.warmLeases.set(threadKey, pinnedLease)`, invoke the existing async `runWarmTurn` once; it synchronously checks/acquires its permit and calls `lease.runTurn` before its first await. `runTurn` must synchronously append its chain slot before waiting for start. Attach a rejection observer immediately so initialization cannot leave an unhandled rejection:

```typescript
const openingTurn = this.runWarmTurn(pinnedLease, ctx, onStream);
void openingTurn.catch(() => {}); // Original promise is still returned to A below.
this.warmLeases.set(threadKey, pinnedLease);
```

Retain the existing `openVoiceStreamingSession` try/catch and late-Query close guard. Replace the final second call to `runWarmTurn` with `return openingTurn`; the opener is never enqueued twice. If initialization fails, close the lease (which resolves readiness), retain the initialization error for A, and allow the observed opening promise to settle. A canceled request or circuit-open permit rejection reserves no work; it cannot later push an obsolete full-transcript opening. Starting an otherwise healthy published lease continues for an independently admitted B. There is no await or publication between live A's reservation and registry insertion. A's actual breaker acquisition now precedes initialization and is still recorded once; no extra probe permit is introduced.

Extend lease readiness with a promise resolved by either `start(query)` or `close(reason)`. Successors can queue against a published unstarted lease behind A's already-reserved slot; at consumption each awaits readiness then checks closed/canceled state. A readiness promise alone without that pre-publication reservation is insufficient. Closing before a late Query arrives still calls `query.close()` through the existing `start()` guard.

Use one ready signal (no timers):

```typescript
private markReady!: () => void;
private readonly ready = new Promise<void>((resolve) => { this.markReady = resolve; });
```

Call `this.markReady()` after `this.query = query` in successful `start`, and in `close` after marking closed. A canceled opener does not close an otherwise healthy published lease used by its successor. Idle/lifetime reclaim and stopAgent still own whole-lease cleanup.

In `runTurn`, retain `turnChain` serialization and rejection recovery. Check canceled/closed before queueing. In the chain callback, await `ready`, check cancellation again, then call `consumeOneTurn(req)`. If the signal is already canceled while the request waits, it must not push a message, increment `turnCount`, disarm the idle timer or call `query.interrupt()`. Do not add a global listener at `runTurn` entry: a queued request's signal would otherwise interrupt the current different turn.

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

No `await` may occur between the final pre-push signal check, installing this owner and pushing this request's user message. If cancellation raced before attachment, rechecking/binding handles it synchronously. Dispose `detachRequest()` first in the existing `finally`, before setting `turnInFlight=false` and rearming idle. Suppress `req.onStream` when `req.voiceRequestSignal?.aborted`, including tool-ack text; still consume the result boundary so the next turn cannot read the predecessor's output. Retain the grace window, but replace `requestInterrupt` escalation with ownership checks on **every asynchronous path**, including rejection. Capture Query identity, turn sequence and whether a turn was in flight; a predecessor's late failure may close only that same still-active owner. Use this body (retain the existing safeLog implementation):

```typescript
requestInterrupt(reason: string): void {
  const query = this.query;
  if (this.closed || !query) return;
  const turn = this.turnCount;
  const inFlight = this.turnInFlight;
  const stillOwns = () => !this.closed && this.query === query &&
    this.turnCount === turn && this.turnInFlight === inFlight;
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

Add `private readonly interruptGraceTimers = new Set<NodeJS.Timeout>()`; delete each timer from the set when it fires, and clear/delete all timers on turn settlement and lease close. The timer's deletion must occur before its owner check. A stale success must not arm a timer; a stale rejection cannot close an idle lease or a running/queued successor. Preserve same-owner failure escalation and stopped-agent whole-lease cleanup.

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
3. A is canceled during prompt/store preparation or async provider assembly: no later `adapter.runTurn`, no retry, sticky abort does not affect B.
4. Warm A consumes, B queues. Abort B: A continues, B pushes no message; C subsequently completes on the same Query.
5. Warm A is interrupted, drains result, then B consumes. Abort A again/late: no new Query interrupt, B completes and lease remains open.
6. Publish live opener A while Query start is gated, then admit B before start: A consumes exactly once before B, and no full-transcript opener follows B. Repeat with A canceled before start: A pushes no message, B consumes exactly once and progresses. Close during initialization closes the late Query once and releases lock/budget.
7. A requests interruption, drains result, and B begins before the interrupt promise rejects: rejection neither closes Query/lease nor interrupts B; B completes. Repeat stale resolution (no grace timer), same-owner rejection (lease closes), and idle interrupt rejection after a successor starts (successor survives).
8. stopAgent and shutdown still close the entire warm lease; request cancellation preserves its lease.
9. Thrown preparation/admission/provider error, canceled queued request and zero-progress abort retain existing breaker and persistence semantics.

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

Move `buildVoiceSystemPrompt`, session store lookup and work-item assembly inside the existing request `try/catch/finally`. Preserve top-level auth/unknown-agent rejection semantics. Check `requestAbort.signal.aborted` after each preparation await and before admission/retry; no subsequent spawn or response write follows a disconnect. Add `voiceRequestSignal: requestAbort.signal` to TurnContext and retain it in all spread retry contexts. `runOnce` increments `engineAttemptSeq` before entering dispatcher/manager, emits attempt-start, then emits its own attempt-terminal in `finally`. The adapter's existing resume/full-transcript retry retains the bridge turn ID and increases the engine attempt number. Record admitted continuity from the existing callback, including thrown failures.

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

Assert one request terminal and each internal attempt terminal on: prompt failure, lookup failure, budget rejection, provider circuit-open, returned errors, resumed retry, no-content, midstream failure, throwing response write swallowed by warm/provider onStream, async response write callback/error failure, accepted write(false), disconnect before spawn and disconnect after text. Error while a predecessor is winding down cannot trigger a successor abort or retry. Existing warm/tool-ack suites remain required.

Run: `npx vitest run src/channels/voice/voice-adapter.test.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts src/agents/voice-tool-ack.test.ts`

Expected: all pass with actual loopback HTTP connections, real cancellation coordinator, zero skipped ownership cases. Then:

```bash
git add src/channels/voice/voice-adapter.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts
git commit -m "feat(voice): trace every engine bridge request outcome"
```
