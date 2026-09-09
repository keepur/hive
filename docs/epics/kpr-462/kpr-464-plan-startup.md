# KPR-464 startup arbitration implementation chunk

> **For agentic workers:** Use dodi-dev:implement after the parent plan's capability and review gates pass.

**Goal:** Request one opening only while still needed; preserve early caller input and let its response replace any stale opening.

**Architecture:** A synchronous arbiter owns the optional explicit opening. Public nonempty-final input holds startup across listening; the accepted-turn hook consumes the opening before response output admission. A preemptive caller handle/text may already exist before that hook. Speech-scoped recovery ownership is invalidated by newer accepted input, newer speech or call closure; the SDK keeps normal interruption and false-interruption recovery.

**Tech Stack:** TypeScript, pinned LiveKit Agent/AgentSession/SpeechHandle APIs, existing error-map and offline fixture.

Inherits the complete [Testing Contract](./kpr-464-plan.md#testing-contract). Depends on the diagnostics and engine chunks; its integration suite must cross their actual implementations.

### Task 6: Implement the opening state machine and action ownership

**Files:**
- Create: `src/voice-worker/startup-arbiter.ts`
- Create: `src/voice-worker/startup-arbiter.test.ts`
- Modify: `src/voice-worker/session.ts`
- Modify: `src/voice-worker/traced-agent.ts`
- Modify: `src/voice-worker/hive-llm.ts` (early exact-owner provider error routing)
- Modify: `src/voice-worker/session.test.ts`

- [ ] **Step 1: Add the synchronous arbiter.**

Use a structural handle interface for pure tests; real session integration passes actual public handles. The hook receives only a boolean/nonempty observation; caller text stays in the SDK/engine conversation path.

```typescript
export interface OpeningHandle {
  readonly id: string;
  readonly interrupted: boolean;
  done(): boolean;
  interrupt(force?: boolean): unknown;
}
export type StartupEvent =
  | { kind: "decision"; decision: "request" | "defer" | "consumed"; reason:
      "quiet_answer" | "caller_speaking" | "final_input_pending" | "accepted_caller_turn" }
  | { kind: "cancel"; speechId: string; reason: "startup_superseded" }
  | { kind: "closed" };

export class StartupArbiter {
  private answered = false;
  private speaking = false;
  private accepted = false;
  private finalPending = false;
  private requested = false;
  private terminal = false;
  private opening: OpeningHandle | null = null;
  private epochValue = 0;

  constructor(private readonly deps: {
    requestOpening: () => OpeningHandle;
    observe: (event: StartupEvent) => void;
  }) {}

  get epoch(): number { return this.epochValue; }
  get closed(): boolean { return this.terminal; }

  answer(): void {
    if (this.terminal) return;
    this.answered = true;
    this.decide();
  }

  callerState(state: "speaking" | "listening" | "away"): void {
    if (this.terminal) return;
    this.speaking = state === "speaking";
    if (state === "listening") this.decide();
  }

  finalInput(hasNonemptyFinal: boolean): void {
    if (this.terminal || !hasNonemptyFinal) return;
    this.finalPending = true;
  }

  acceptedCallerTurn(): void {
    if (this.terminal) return;
    this.epochValue += 1;
    this.accepted = true;
    this.finalPending = false;
    this.deps.observe({ kind: "decision", decision: "consumed", reason: "accepted_caller_turn" });
    const opening = this.opening;
    if (opening && !opening.done() && !opening.interrupted) {
      this.deps.observe({ kind: "cancel", speechId: opening.id, reason: "startup_superseded" });
      opening.interrupt();
    }
  }

  close(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.finalPending = false;
    this.epochValue += 1;
    this.deps.observe({ kind: "closed" });
  }

  private decide(): void {
    if (this.terminal || !this.answered || this.accepted || this.requested) return;
    if (this.finalPending) {
      this.deps.observe({ kind: "decision", decision: "defer", reason: "final_input_pending" });
      return;
    }
    if (this.speaking) {
      this.deps.observe({ kind: "decision", decision: "defer", reason: "caller_speaking" });
      return;
    }
    this.requested = true;
    this.deps.observe({ kind: "decision", decision: "request", reason: "quiet_answer" });
    this.opening = this.deps.requestOpening();
    if ((this.accepted || this.terminal) && !this.opening.done() && !this.opening.interrupted) {
      if (!this.terminal) this.deps.observe({
        kind: "cancel", speechId: this.opening.id, reason: "startup_superseded",
      });
      this.opening.interrupt();
    }
  }
}
```

Only public nonempty final text (`isFinal && !!transcript.trim()`) sets `finalPending`. Interim/preflight/empty input does not. Listening releases a provisional speaking hold immediately when final-pending is false; it never asserts final text cannot arrive later. A later accepted turn cancels the still-outstanding opening by its own handle. No rejection/transcription timeout or extra opening delay is added. Repeated finals cannot clear the latch; acceptance/closure does.

No await between `requested=true` and `generateReply()`. The injected observe function is throw-safe; the production request wrapper catches setup/scheduling errors and invokes the existing failure/cleanup path without resetting `requested` for an accidental second opening. The post-return guard handles acceptance/closure during a synchronous reentrant callback and interrupts only the returned opening. In production SpeechCreated observers must only record, not recursively drive caller input. The call-close recorder supplies `call_closed` cause for the terminal reentrancy case.

Do not use a blanket `session.interrupt()` to cancel the stale opening. Do not pass `allowInterruptions:false`, a fixed start delay, prerecorded greeting, worker greeting instruction or extra input message. `callerState("away")` alone does not trigger a deferred opening; later listening/answer re-evaluates.

- [ ] **Step 2: Install observation before session/SIP work.**

Construct call scope after room/agent resolution and before `session.start`. Instantiate trace recorder first, HiveLLM with trace/call-close signal, and TracedAgent with the exact placeholder instructions plus accepted-turn callback. Keep selected STT/TTS/VAD and `ttsTextTransforms` unchanged. For outbound use intended participant identity `sip-${callId}` both in SIP options and participant observation. The exact pinned npm `RoomInputOptions` exposes `participantIdentity?: string`; pass `inputOptions: { participantIdentity: intendedIdentity }` to `session.start` so unrelated room participants cannot become caller input. Leave inbound selection unchanged. Do not infer answer from unrelated participant/audio events. The successful `createSipParticipant(...waitUntilAnswered:true)` result is the answer condition; participant presence is a distinct observation, not a new subscription guard.

Wire in this order before `start`:

1. `SpeechCreated`: read synchronous application generation scope (`opening/retry/fallback` or default `sdk_response`), create speech trace and a creation-fenced action token, attach public done callback. Do not interpret a speculative SDK handle as accepted caller input or consume the opening.
2. `MetricsCollected`: recorder metrics binding/enrichment; process any bounded pending BridgeError for the now explicitly bound turn.
3. `UserInputTranscribed`: synchronously derive `hasNonemptyFinal = ev.isFinal && !!ev.transcript.trim()`, emit content-free `caller_final_input` with `hasFinalInput: true` only on that observation, and call `arbiter.finalInput(hasNonemptyFinal)`. Never log the event/transcript itself.
4. `UserStateChanged`: record caller state and forward speaking/listening to outbound arbiter. These events belong to the selected intended participant's input.
5. `ConversationItemAdded`: keep the existing interrupted assistant text → `hiveLLM.interruptedSpokenText` logic; remove interruption **counting** here because handle outcomes own it. Never use this late event as accepted-user-turn precedence.
6. `Error`: record call-level provider error or bridge error by its own `turnId`; guard recovery as Step 3 specifies.
7. `Close` and room disconnect/intended participant disconnect: synchronously terminalize startup/abort call scope before scheduling asynchronous cleanup.

TracedAgent's public `onUserTurnCompleted` synchronously invalidates all obsolete application opening/recovery handles, calls `arbiter.acceptedCallerTurn()` for nonempty text and records `caller_turn_accepted`; it returns immediately without awaiting diagnostics. For inbound, retain normal SDK response scheduling and record the accepted epoch without scheduling any optional opening. The hook is before output admission with the existing `preemptiveTts: false`; it is not universally before SpeechCreated or speculative LLM text. Final input and the hook expose no speech identity, so neither labels/adopts the next/latest SDK handle. Before the SIP await, no explicit opening is requested; caller activity/accepted input is already retained. After await, record SIP answer and call `arbiter.answer()` only if live. An answer callback arriving after hangup does nothing.

Use synchronous generation scope wrapping to label only application-issued handles:

```typescript
type GenerationOrigin = "opening" | "retry" | "fallback";
let generationScope: { origin: GenerationOrigin; epoch: number } | null = null;
function scheduleOwned(origin: GenerationOrigin, make: () => voice.SpeechHandle) {
  const previous = generationScope;
  generationScope = { origin, epoch: arbiter.epoch };
  try { return make(); }
  finally { generationScope = previous; }
}
```

The public SDK `SpeechCreated` must be synchronous within `generateReply`/`say`; Task 0 verifies this. Use a scope stack as above so nested callbacks restore their predecessor. Never infer caller origin from `userInitiated`. Retain actual handles in the opening/recovery owner, not only IDs.

- [ ] **Step 3: Guard all recovery work with the failed speech's owner.**

Maintain an immutable creation token `{ speechId, acceptedEpoch, serial }` plus its actual handle. New creation advances the serial used to reject stale asynchronous continuations; accepted input invalidates earlier epochs synchronously. Creation is not proof of caller origin. A preemptive SDK response created before acceptance retains its creation epoch and may lack proved application action ownership afterward; do not relabel it at the hook. Record unproved recovery ownership and skip app recovery in that case, while SDK response admission/output proceeds normally. This conservative guard cannot suppress an unrelated provider's standard SDK error behavior.

A BridgeError carries `turnId`; only genuine recorder binding resolves its failed token. Before binding, keep the error in the bounded 256-entry pending map. Binding triggers processing for that exact error; absence/eviction remains unbound and cannot authorize retry/fallback/shutdown. Deduplicate by turn ID/object identity so one SDK/app observation does not consume several retries. Owner failure is recorded even when stale.

```typescript
interface ActionOwner {
  readonly speechId: string;
  readonly acceptedEpoch: number;
  readonly serial: number;
}
const owns = (owner: ActionOwner) =>
  !arbiter.closed && owner.acceptedEpoch === arbiter.epoch &&
  currentOwner?.speechId === owner.speechId && currentOwner.serial === owner.serial;
```

**Own the SDK failure route as well as app recovery.** The pinned `LLMStream` catches ordinary BridgeError and emits an unrecoverable provider error; after session listeners run, the SDK closes at its fourth error (default maximum is 3) even if the application's stale-owner check returned. Install a synchronous `hiveLLM.prependListener("error", routeOwnedBridgeError)` in HiveLLM construction before AgentSession subscribes. For only an exact BridgeError already recorded by this HiveLLM stream under its own turn ID, set that public event's `recoverable` field to true **before** SDK listeners see it. Keep the original error/event, and rethrow the original error from `run`: the base ordinary-Error branch does not add automatic retries. The field delegates those known bridge failures to existing bounded application recovery; it does not mark the attempt successful. Unrelated LLM/STT/TTS errors are untouched. Do not remove SDK listeners, change global thresholds, override a private emit method, or mutate all errors in a late session callback.

```typescript
// HiveLLM constructor, immediately after super(); map is bounded/recent like trace state.
this.prependListener("error", (event) => {
  const failure = event.error;
  if (failure instanceof BridgeError && this.ownedFailures.get(failure.turnId) === failure) {
    event.recoverable = true;
    this.ownedFailures.delete(failure.turnId);
  }
});
```

Add `ownedFailures: Map<string, BridgeError>` to HiveLLM, capped at 256. In the stream catch, call `attempt.fail(failure.failureClass)` and register the exact failure immediately before `throw failure`, with no await; constructor's early listener deletes the matching entry after marking the event. Keep pending recovery details separately in the recorder, so removing this routing entry loses no action. If a routing entry is unavailable/conflicting, leave the event untouched and record a gap. All already-known errors still precede one-shot terminalization in `finally`.

**Executed proof of this newly selected public seam:** [test-local source](./probes/kpr-464-owned-error-probe.mjs), [actual results](./probes/kpr-464-owned-error-results.json). `node docs/epics/kpr-462/probes/kpr-464-owned-error-probe.mjs` executed on Node 24.16.0 with exit 0 during this revision: baseline closes on error 4; early exact-error routing preserves all four original events as recoverable, genuine ALS/speech metric bindings, and a pending replacement's text completion; four unrelated provider failures still close at the original threshold. The replacement is deliberately text-only in this seam proof. Task 7 must test the actual Hive failure route with TTS/fake output and production owner guards. No private SDK fields or emitted fake metrics are used.

**Invalidate actual queued application handles, not only future continuations.** Keep a bounded `Map<speechId, { handle, owner, chainAbort }>` for every unfinished application-created opening/retry/fallback. Add at synchronous SpeechCreated within generation scope, remove on its done callback. This is distinct from SDK speculative handles. On nonempty acceptance, intentional application supersession, and call close, synchronously interrupt every obsolete retained handle, including queued fallback/retry handles that the SDK's current-speech interruption can miss:

```typescript
function cancelApplicationHandles(cause: "startup_superseded" | "call_closed", keep?: string) {
  const retainedChain = keep ? applicationHandles.get(keep)?.chainAbort : undefined;
  for (const [id, entry] of applicationHandles) {
    if (id === keep) continue;
    if (entry.chainAbort !== retainedChain) entry.chainAbort.abort();
    trace.markCancellation(id, cause);
    if (!entry.handle.done() && !entry.handle.interrupted) {
      try { entry.handle.interrupt(); } catch { trace.actionGap("cancel_failed", id); }
    }
  }
}
```

Define `trace.actionGap` as a typed content-free gap event (reason enum and supplied speech ID), not arbitrary error text. On active-map overflow cancel the oldest owned handle and emit an overflow gap before evicting. An already-interrupted handle is idempotent. Provisional speaking or speculative `SpeechCreated` alone must not cancel/consume the one opening; only known acceptance, call closure or an explicit app-owned supersession does. New speculative creation can revoke an old recovery continuation's serial permission, but cannot authorize new speech or be adopted as accepted input.

For intentional recovery transfer, pass the expected owner into `scheduleOwned`; check `owns` immediately before `say/generateReply`. Its synchronous generation scope carries the chain controller and `transferFrom` token. On the new SpeechCreated callback, first validate the expected token, create/register the new owner, then cancel obsolete app handles while keeping the newly created one and **without aborting its shared chain controller**. Revoking the old owner invalidates old waits; updating the local chain owner to the returned handle permits only the planned next action. If acceptance occurs reentrantly before return, the post-return owner check interrupts the returned handle and ends the chain. No await intervenes in transfer. At most 256 active handles/256 pending errors are retained; overflow cannot silently abandon a queued handle.

Preserve `FAILURE_BEHAVIOR`/`resolveFailureAction` and existing retry budgets. Call `stats.retryConsumed` only after ownership succeeds. Use the recovery chain's AbortController for `node:timers/promises.setTimeout(action.delayMs, undefined, { signal: chainAbort.signal })`; acceptance/closure/supersession aborts it immediately. After fallback `waitForPlayout`, after the classified delay, before retry and before terminal flush/release/shutdown, recheck the transferred owner. A wait failure is best-effort fallback evidence, not another retry. Do not wait for a canceled predecessor to produce another caller utterance.

An empty HTTP success is recorded as completed bridge generation with no first text/no generated audio. It is excluded from audible-success denominators and does not automatically mint an extra opening or loop. The controlled fixture must distinguish this case from ordinary successful output. If the empty-generation scenario reveals an independent startup-liveness defect requiring a new retry/fallback policy, return to spec/plan review with an explicit bounded `empty_generation` path; do not silently classify it as spawn failure or infer an unapproved policy from this plan.

- [ ] **Step 4: Make shutdown idempotent and bounded.**

Create one `closeCall(cause)` promise for call cleanup, but **do not memoize a no-op SDK close across a pending start**. The pinned SDK's `close()` returns while `started` is still false; `start()` can create live resources afterward. Track start's settlement separately and always retain a terminal-scope cleanup continuation:

```typescript
let startSettled = false;
let sdkCloseInFlight: Promise<void> | null = null;
let sdkCloseEpoch = -1;
function closeSdkAgain(): Promise<void> {
  const epoch = startSettled ? 1 : 0;
  const previous = sdkCloseInFlight;
  if (previous && sdkCloseEpoch < epoch) {
    // Mandatory fresh attempt after any pre-start close actually settles.
    return previous.catch(() => {}).then(() => closeSdkAgain());
  }
  if (previous) return previous;
  const task = Promise.resolve().then(() => session.close());
  sdkCloseEpoch = epoch;
  sdkCloseInFlight = task;
  void task.finally(() => {
    if (sdkCloseInFlight === task) sdkCloseInFlight = null;
  }).catch(() => {});
  return task;
}
async function closeSdkBounded(reason: "call_close" | "late_start" | "late_start_failed") {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      closeSdkAgain().then(() => "closed" as const, () => "failed" as const),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), 2_000); }),
    ]);
    trace.teardown(result, reason); // Typed content-free row; failed/timeout are incomplete.
  } finally { if (timer) clearTimeout(timer); }
}
const startTask = session.start({ agent, room: ctx.room, inputOptions, outputOptions });
const observedStart = startTask.then(async () => {
  startSettled = true;
  if (arbiter.closed) await closeSdkBounded("late_start");
}, async (error) => {
  startSettled = true;
  if (arbiter.closed) await closeSdkBounded("late_start_failed");
  throw error;
});
void observedStart.catch(() => {}); // Original outcome still handled by setup.
await Promise.race([observedStart, callClosed.promise]);
if (arbiter.closed) return; // Before SipClient creation or any SIP side effect.
// Only here construct SipClient and await createSipParticipant.
```

`callClosed` is a gate resolved synchronously at terminal transition. `trace.teardown` emits a typed content-free observation for closed/failed/timeout; failure or timeout emits the corresponding diagnostic gap and preserves incomplete status. An initial close that returns while `startSettled` is false also records `start_pending` coverage as incomplete, even though that close call itself resolved. The original promise retains a catch/cleanup continuation and its identity is cleared only on its actual settlement. If an earlier close is still in flight when start settles, await its bounded settlement then make a **fresh** close invocation; an earlier pre-start attempt cannot satisfy the mandatory post-start close. Test that specifically. The timeout bounds call cleanup, not startup behavior or audio latency. A start that never settles is recorded as `start_pending/teardown_timeout`; no polling/retry/start-again loop is introduced.

At `closeCall` invocation synchronously mark the arbiter terminal, cancel every app handle/action controller, abort the call controller (owned HTTP/TTS observers), resolve `callClosed`, emit call close, and finalize trace owners. Also disable `session.input.setAudioEnabled(false)` and `session.output.setAudioEnabled(false)`, clear any current output buffer, and set the retained `inputOptions.audioEnabled`/`outputOptions.audioEnabled` to false so late start cannot re-enable room media. Every TracedAgent/HiveLLM entry checks the call abort signal before opening provider/HTTP work; hooks may still record late observations but cannot schedule. Keep the post-start continuation even after ordinary cleanup returned. On successful late start it closes the resulting public session/RoomIO resources; if start rejects with partial inaccessible SDK resources, record incomplete and invoke existing job shutdown/room cleanup rather than claiming all resources closed.

Detach application/room listeners and remove own handle callbacks during final cleanup; preserve only the start-settlement continuation needed to close late resources. That continuation repeats idempotent application disposal after SDK close, without another summary/heartbeat terminal. `closeCall` and late-start cleanup must each be rejection-contained. Initial listeners/startTask are installed before awaiting start, and a final live check runs immediately before SIP creation and immediately after answer settlement.

Adapt `runJobShutdown` so all cleanup stages run even if one fails: finalize/cancel session work → release call heartbeat → flush summary using finalized counts → close Mongo. Use try/finally nesting or `Promise.allSettled` only where independent; flush must precede Mongo close. Setup failure latches failed call outcome before this shared cleanup and the later shutdown callback cannot overwrite it with completed. Summary persistence result is logged as failed/acknowledged, not guessed from an idempotency flag. No new opening/retry/fallback/frame forwarding can begin once call scope is terminal.

- [ ] **Step 5: Verify focused state/setup tests and commit.**

Unit permutations: quiet answer twice; final before answer/listening/acceptance (STT/VAD); no-final absent/interim/empty/preflight returns to listening; delayed final after an opening; accepted before answer; speaking at answer then accepted; provisional speaking/listening without accepted input; same-turn hook/answer ordering; immediate accepted input after explicit handle returns; reentrant acceptance during scheduling; false interruption no new request; close before/after answer; unrelated participant does not satisfy startup/input; old error after successor; close during retry delay/fallback wait; terminal fallback loses ownership before shutdown. Add startup-pending teardown tests: disconnect/shutdown while `session.start` is gated, let initial close resolve, then release start; no SIP call, no later media/request, and post-start close removes late resources/listeners. Repeat late start rejection, post-start close timeout, and close still pending when start settles. Add already-queued fallback/retry invalidation and intentional-transfer cases. Verify each initial observation listener is installed before `start` and SIP request. Tests of pure reducer alone do not satisfy integration acceptance.

Run: `npx vitest run src/voice-worker/startup-arbiter.test.ts src/voice-worker/session.test.ts src/voice-worker/error-map.test.ts src/voice-worker/tts-normalize.test.ts`

Expected: every state row passes; no duplicate opening; current response unchanged by stale callback; shutdown order/counts exact.

```bash
git add src/voice-worker/startup-arbiter.ts src/voice-worker/startup-arbiter.test.ts src/voice-worker/hive-llm.ts src/voice-worker/session.ts src/voice-worker/traced-agent.ts src/voice-worker/session.test.ts
git commit -m "fix(voice): let accepted caller input own outbound startup"
```

### Task 7: Prove the full startup pipeline progresses under cancellation

**Files:**
- Create: `src/voice-worker/startup.integration.test.ts`
- Modify: `src/voice-worker/testing/startup-fixture.ts`
- Modify: `src/channels/voice/voice-startup.integration.test.ts`
- Modify: `docs/epics/kpr-462/kpr-464-startup-evidence.md`

- [ ] **Step 1: Reproduce the old ordering with real SDK, fake media and controlled HTTP.**

Keep a test-only baseline mode that executes the old unconditional post-answer `generateReply()` sequence; do not reintroduce a production flag. Record early greeting accepted/speech created while SIP answer is pending, then answer callback queues another opening. Demonstrate exactly what the baseline fixture does: duplicate scheduling and whichever generated frames actually reached fake output. Do not require an interrupted/no-content handle unless the fixture explicitly injects cancellation and observes that outcome; unconditional extra generation alone proves no cancellation. A fixture reproduction is evidence of this ordering, not proof of September 7 handset causality. The corrected session path must show the observed ordering resolved and retained diagnostics for canceled speech.

- [ ] **Step 2: Implement S1–S9 with progression assertions.**

Use table-driven named barriers, not elapsed-time sleeps. Each progression scenario asserts its expected known opening/caller/replacement frames and handle settlement. Hangup, empty-generation and abrupt-process-loss scenarios use the absence/terminal/gap assertions below, rather than requiring nonexistent replacement frames. Every scenario checks its own exact attempt counts and absence of stale delivery after cancellation. Test timeout catches a stuck pipeline; it does not define a product latency target.

| Spec case | Fixture scheduling |
| --- | --- |
| S1 quiet answer | Resolve SIP, deliver bridge text, synthesize known frame, finish output; exactly one opening handle. |
| S2 early hello | STT/VAD nonempty final before answer, final during answer completion, or accepted before decision; final-pending survives listening before hook, explicit opening suppressed; transcript preserved in engine request. |
| S3 immediate input | Gate old request before text, before first generated frame, during playout; inject input; replacement text/frame/output finish without another caller utterance. |
| S4 provisional/false interruption | Run all 22 proved startup permutations against Hive: absent/interim/empty/preflight-only listening permits one opening; final already observed holds across listening; delayed final after opening gives normal replacement; preemptive handle/text may precede hook but no output precedes accepted admission. Then Actual SDK false-interruption recovery resumes original handle and doesn't create another opening. |
| S5 hangup | Before/during session start, answer, fetch, TTS and replacement; no late request/frame/retry/fallback; finalized records/counts and closed resources. |
| S6 failures | Bridge HTTP rejection; old delayed BridgeError after replacement; midstream body error; TTS error before/after frame; empty success; verify application failure precedes terminal even with no handle exception/normal EOF and bounded owned recovery. Gate predecessor cleanup with fallback/retry already queued, accept caller input, verify those owned handles interrupt and replacement progresses. Exercise stale bridge errors at the SDK fourth-error threshold while successor is pending and before speaking resets the counter; unrelated provider threshold remains active. Empty success expects no generated frames and explicit no-content counts, not a replacement. |
| S7 diagnostics | No EOU opening, no TTS cancellation, overlapping streams, reverse/late/duplicate metrics, multi-segment synthesis; bind only explicit IDs. |
| S8 actual adapter | Loopback real adapter/manager cold and warm; old HTTP close after successor is active/queued; successor frames/output done; auth/SSE and legacy no-trace unchanged. |
| S9 cleanup/privacy | Bounded overflow/filtered+async log failure/Mongo failure/process-loss fixture (missing terminal reduces to incomplete; no replacement expected); no content/phone/token/tool/audio fields; no orphan timers or stream readers. |

The real SDK fixture must cover lifecycle cases, including actual `Agent.default.ttsNode`; pure spies on `generateReply`/`say` are insufficient. No-metric synthesis cancellation before/after a frame is the approved unbound outcome, independent of that synthesis's accurate local terminal. Tests assert no dropped attempts, no falsely successful speech with unknown causal coverage, no guessed joins, genuine normal metric enrichment, one-shot terminal totals and no optional-metric wait on replacement. Product regressions are required after implementation and do not replace or retroactively redefine the already-executed test-local capability evidence.

- [ ] **Step 3: Integrate verification and durable evidence.**

Run: `npx vitest run src/voice-worker/startup.integration.test.ts src/voice-worker/sdk-capability.integration.test.ts src/channels/voice/voice-startup.integration.test.ts --reporter=verbose`

Expected: real generated frames reach fake output in all progression cases, all required assertions pass, no skipped matrix row. Write actual scenario IDs/sequence, pins, command output and limitations to evidence. Keep caller confirmation `unknown`; do not populate it from fake output or server metrics. Then run Task 8's full repository check/build and proceed to reviewed implementation handoff.

```bash
git add src/voice-worker/startup.integration.test.ts src/voice-worker/testing/startup-fixture.ts src/channels/voice/voice-startup.integration.test.ts docs/epics/kpr-462/kpr-464-startup-evidence.md
git commit -m "test(voice): cover early greeting replacement and startup teardown"
```
