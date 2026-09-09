# KPR-464 startup arbitration implementation chunk

> **For agentic workers:** Use dodi-dev:implement after the parent plan's capability and review gates pass.

**Goal:** Request one opening only while still needed; preserve early caller input and let its response replace any stale opening.

**Architecture:** A synchronous arbiter owns the optional explicit opening. The public Agent accepted-turn hook updates precedence before the SDK creates the caller response. Speech-scoped recovery ownership is invalidated by newer accepted input, newer speech or call closure; the SDK keeps normal interruption and false-interruption recovery.

**Tech Stack:** TypeScript, pinned LiveKit Agent/AgentSession/SpeechHandle APIs, existing error-map and offline fixture.

Inherits the complete [Testing Contract](./kpr-464-plan.md#testing-contract). Depends on the diagnostics and engine chunks; its integration suite must cross their actual implementations.

### Task 6: Implement the opening state machine and action ownership

**Files:**
- Create: `src/voice-worker/startup-arbiter.ts`
- Create: `src/voice-worker/startup-arbiter.test.ts`
- Modify: `src/voice-worker/session.ts`
- Modify: `src/voice-worker/traced-agent.ts`
- Modify: `src/voice-worker/session.test.ts`

- [ ] **Step 1: Add the synchronous arbiter.**

Use a structural handle interface for pure tests; real session integration passes actual public handles. The hook receives only a boolean/nonempty observation; caller text stays in the SDK/engine conversation path.

```typescript
export interface OpeningHandle {
  readonly id: string;
  done(): boolean;
  interrupt(force?: boolean): unknown;
}
export type StartupEvent =
  | { kind: "decision"; decision: "request" | "defer" | "consumed"; reason:
      "quiet_answer" | "caller_speaking" | "accepted_caller_turn" }
  | { kind: "cancel"; speechId: string; reason: "startup_superseded" }
  | { kind: "closed" };

export class StartupArbiter {
  private answered = false;
  private speaking = false;
  private accepted = false;
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

  acceptedCallerTurn(): void {
    if (this.terminal) return;
    this.epochValue += 1;
    this.accepted = true;
    this.deps.observe({ kind: "decision", decision: "consumed", reason: "accepted_caller_turn" });
    const opening = this.opening;
    if (opening && !opening.done()) {
      this.deps.observe({ kind: "cancel", speechId: opening.id, reason: "startup_superseded" });
      opening.interrupt();
    }
  }

  close(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.epochValue += 1;
    this.deps.observe({ kind: "closed" });
  }

  private decide(): void {
    if (this.terminal || !this.answered || this.accepted || this.requested) return;
    if (this.speaking) {
      this.deps.observe({ kind: "decision", decision: "defer", reason: "caller_speaking" });
      return;
    }
    this.requested = true;
    this.deps.observe({ kind: "decision", decision: "request", reason: "quiet_answer" });
    this.opening = this.deps.requestOpening();
    if ((this.accepted || this.terminal) && !this.opening.done()) {
      if (!this.terminal) this.deps.observe({
        kind: "cancel", speechId: this.opening.id, reason: "startup_superseded",
      });
      this.opening.interrupt();
    }
  }
}
```

No await between `requested=true` and `generateReply()`. The injected observe function is throw-safe; the production request wrapper catches setup/scheduling errors and invokes the existing failure/cleanup path without resetting `requested` for an accidental second opening. The post-return guard handles acceptance/closure during a synchronous reentrant callback and interrupts only the returned opening. In production SpeechCreated observers must only record, not recursively drive caller input. The call-close recorder supplies `call_closed` cause for the terminal reentrancy case.

Do not use a blanket `session.interrupt()` to cancel the stale opening. Do not pass `allowInterruptions:false`, a fixed start delay, prerecorded greeting, worker greeting instruction or extra input message. `callerState("away")` alone does not trigger a deferred opening; later listening/answer re-evaluates.

- [ ] **Step 2: Install observation before session/SIP work.**

Construct call scope after room/agent resolution and before `session.start`. Instantiate trace recorder first, HiveLLM with trace/call-close signal, and TracedAgent with the exact placeholder instructions plus accepted-turn callback. Keep selected STT/TTS/VAD and `ttsTextTransforms` unchanged. For outbound use intended participant identity `sip-${callId}` both in SIP options and participant observation. The exact pinned npm `RoomInputOptions` exposes `participantIdentity?: string`; pass `inputOptions: { participantIdentity: intendedIdentity }` to `session.start` so unrelated room participants cannot become caller input. Leave inbound selection unchanged. Do not infer answer from unrelated participant/audio events. The successful `createSipParticipant(...waitUntilAnswered:true)` result is the answer condition; participant presence is a distinct observation, not a new subscription guard.

Wire in this order before `start`:

1. `SpeechCreated`: read synchronous generation scope (`opening/retry/fallback` or default `sdk_response`), create speech trace and action owner, attach public done callback.
2. `MetricsCollected`: recorder metrics binding/enrichment; process any bounded pending BridgeError for the now explicitly bound turn.
3. `UserStateChanged`: record caller state and forward speaking/listening to outbound arbiter. These events belong to the selected intended participant's input.
4. `ConversationItemAdded`: keep the existing interrupted assistant text → `hiveLLM.interruptedSpokenText` logic; remove interruption **counting** here because handle outcomes own it. Never use this late event as accepted-user-turn precedence.
5. `Error`: record call-level provider error or bridge error by its own `turnId`; guard recovery as Step 3 specifies.
6. `Close` and room disconnect/intended participant disconnect: synchronously terminalize startup/abort call scope before scheduling asynchronous cleanup.

TracedAgent's public `onUserTurnCompleted` calls `arbiter.acceptedCallerTurn()` synchronously for nonempty text and records `caller_turn_accepted`; it returns immediately without awaiting diagnostics. For inbound, retain normal SDK response scheduling and record the accepted epoch without scheduling any optional opening. Before the SIP await, no explicit opening is requested; caller activity/accepted input is already retained. After await, record SIP answer and call `arbiter.answer()` only if live. An answer callback arriving after hangup does nothing.

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

Maintain a request/speech action token `{ speechId, acceptedEpoch, serial }` established at SpeechCreated. A fresh non-stale speech advances serial and becomes the current action owner. Caller acceptance invalidates earlier epoch immediately, before the replacement handle exists. A BridgeError carries `turnId`; only explicit recorder binding resolves its failed speech/token. Errors arriving before metrics enter a bounded pending map keyed by turn ID; on binding, process that exact error, never the current speech. If binding never arrives, emit a call-level/unbound failure, do not speak/retry/shutdown a potentially unrelated current response, and mark diagnostic/acceptance incomplete. Task 0 must prove required cases have complete correlation before readiness.

```typescript
interface ActionOwner {
  speechId: string;
  acceptedEpoch: number;
  serial: number;
}
const owns = (owner: ActionOwner) =>
  !arbiter.closed && owner.acceptedEpoch === arbiter.epoch &&
  currentOwner?.speechId === owner.speechId && currentOwner.serial === owner.serial;
```

Preserve FAILURE_BEHAVIOR and resolveFailureAction bounds. Deduplicate error processing per bridge turn ID; metrics retry/error duplicates cannot consume multiple retries. Record the error diagnostically even when it is stale, but call `stats.retryConsumed` and schedule any action only after `owns(owner)` succeeds. A recovery chain which intentionally schedules `sayFirst` transfers its owner to that fallback handle, then rechecks that transferred owner after `waitForPlayout`, after the existing classified delay, and immediately before retry generation. Caller input/new unrelated speech invalidates it. Do not keep using the predecessor owner after creating fallback or its own recovery would self-cancel incorrectly.

Replace unabortable `setTimeout` sleep with `node:timers/promises.setTimeout(action.delayMs, undefined, { signal: callAbort.signal })`; catching its AbortError means stop recovery. Existing error-class backoff is retained; this is not an opening delay. Also stop on invalidated ownership after the wait. Handle wait errors are best-effort fallback evidence; do not turn them into a fresh unbounded retry. Before terminal fallback flush/release/shutdown, recheck ownership again. A delayed error from the old speech may neither schedule a new opening nor close a healthy replacement.

An empty HTTP success is recorded as completed bridge generation with no first text/no generated audio. It is excluded from audible-success denominators and does not automatically mint an extra opening or loop. The controlled fixture must distinguish this case from ordinary successful output. If the empty-generation scenario reveals an independent startup-liveness defect requiring a new retry/fallback policy, return to spec/plan review with an explicit bounded `empty_generation` path; do not silently classify it as spawn failure or infer an unapproved policy from this plan.

- [ ] **Step 4: Make shutdown idempotent and bounded.**

Create one `closeCall(cause)` promise. At invocation, synchronously close arbiter, invalidate action owner, abort call controller (HiveLLM fetches/TTS wrapper readers), emit call close and finalize open trace owners. Then close the SDK session through its public close API; bound waiting for a dead SDK/output to 2 seconds for teardown only and record `incomplete/teardown_timeout` if necessary. Attach a catch to any late SDK-close promise and never wait indefinitely for optional metrics or fallback playout. Detach all fixed listeners/room listeners and remove public done callbacks where still registered.

Adapt `runJobShutdown` so all cleanup stages run even if one fails: finalize/cancel session work → release call heartbeat → flush summary using finalized counts → close Mongo. Use try/finally nesting or `Promise.allSettled` only where independent; flush must precede Mongo close. Setup failure latches failed call outcome before this shared cleanup and the later shutdown callback cannot overwrite it with completed. Summary persistence result is logged as failed/acknowledged, not guessed from an idempotency flag. No new opening/retry/fallback/frame forwarding can begin once call scope is terminal.

- [ ] **Step 5: Verify focused state/setup tests and commit.**

Unit permutations: quiet answer twice; accepted before answer; speaking at answer then accepted; provisional speaking/listening without accepted input; same-turn hook/answer ordering; immediate accepted input after explicit handle returns; reentrant acceptance during scheduling; false interruption no new request; close before/after answer; unrelated participant does not satisfy startup/input; old error after successor; close during retry delay/fallback wait; terminal fallback loses ownership before shutdown. Verify each initial observation listener is installed before `start` and SIP request. Tests of pure reducer alone do not satisfy integration acceptance.

Run: `npx vitest run src/voice-worker/startup-arbiter.test.ts src/voice-worker/session.test.ts src/voice-worker/error-map.test.ts src/voice-worker/tts-normalize.test.ts`

Expected: every state row passes; no duplicate opening; current response unchanged by stale callback; shutdown order/counts exact.

```bash
git add src/voice-worker/startup-arbiter.ts src/voice-worker/startup-arbiter.test.ts src/voice-worker/session.ts src/voice-worker/traced-agent.ts src/voice-worker/session.test.ts
git commit -m "fix(voice): let accepted caller input own outbound startup"
```

### Task 7: Prove the full startup pipeline progresses under cancellation

**Files:**
- Create: `src/voice-worker/startup.integration.test.ts`
- Modify: `src/voice-worker/testing/startup-fixture.ts`
- Modify: `src/channels/voice/voice-startup.integration.test.ts`
- Modify: `docs/epics/kpr-462/kpr-464-startup-evidence.md`

- [ ] **Step 1: Reproduce the old ordering with real SDK, fake media and controlled HTTP.**

Keep a test-only baseline mode that executes the old unconditional post-answer `generateReply()` sequence; do not reintroduce a production flag. Record early greeting accepted/speech created while SIP answer is pending, then answer callback queues another opening. Demonstrate exactly what the baseline fixture does: duplicate scheduling, an interrupted/no-content handle, and whichever generated frames actually reached fake output. A fixture reproduction is evidence of this ordering, not proof of September 7 handset causality. The corrected session path must show the observed ordering resolved and retained diagnostics for canceled speech.

- [ ] **Step 2: Implement S1–S9 with progression assertions.**

Use table-driven named barriers, not elapsed-time sleeps. Each required scenario asserts known replacement frames captured by fake output and the replacement handle done, plus exact ID/outcome counts and absence of stale frames after its cancellation. Test timeout catches a stuck pipeline; it does not define a product latency target.

| Spec case | Fixture scheduling |
| --- | --- |
| S1 quiet answer | Resolve SIP, deliver bridge text, synthesize known frame, finish output; exactly one opening handle. |
| S2 early hello | Fake STT before answer, acceptance in same turn as answer resolution, and acceptance before opening decision; actual hook wins; transcript preserved in engine request. |
| S3 immediate input | Gate old request before text, before first generated frame, during playout; inject input; replacement text/frame/output finish without another caller utterance. |
| S4 provisional/false interruption | Fake VAD speech with empty transcript then listening; pending opening proceeds. Actual SDK false-interruption recovery resumes original handle and doesn't create another opening. |
| S5 hangup | Before answer, fetch, TTS and replacement; no late request/frame/retry/fallback; finalized records/counts and closed resources. |
| S6 failures | Bridge HTTP rejection; old delayed BridgeError after replacement; midstream body error; TTS error before/after frame; empty success; verify classification and bounded existing recovery. |
| S7 diagnostics | No EOU opening, no TTS cancellation, overlapping streams, reverse/late/duplicate metrics, multi-segment synthesis; bind only explicit IDs. |
| S8 actual adapter | Loopback real adapter/manager cold and warm; old HTTP close after successor is active/queued; successor frames/output done; auth/SSE and legacy no-trace unchanged. |
| S9 cleanup/privacy | Bounded overflow/log failure/Mongo failure/process-loss fixture; no content/phone/token/tool/audio fields; no orphan timers or stream readers. |

The real SDK fixture must cover lifecycle cases, including actual `Agent.default.ttsNode`; pure spies on `generateReply`/`say` are insufficient. Missing-before-frame TTS metrics remain a known capability limitation until reviewed: the test may assert unbound/incomplete truth, but must not mark the required complete-correlation contract passed merely by weakening its assertions. If Task 0 cannot resolve the seam, implementation readiness remains blocked.

- [ ] **Step 3: Integrate verification and durable evidence.**

Run: `npx vitest run src/voice-worker/startup.integration.test.ts src/voice-worker/sdk-capability.integration.test.ts src/channels/voice/voice-startup.integration.test.ts --reporter=verbose`

Expected: real generated frames reach fake output in all progression cases, all required assertions pass, no skipped matrix row. Write actual scenario IDs/sequence, pins, command output and limitations to evidence. Keep caller confirmation `unknown`; do not populate it from fake output or server metrics. Then run Task 8's full repository check/build and proceed to reviewed implementation handoff.

```bash
git add src/voice-worker/startup.integration.test.ts src/voice-worker/testing/startup-fixture.ts src/channels/voice/voice-startup.integration.test.ts docs/epics/kpr-462/kpr-464-startup-evidence.md
git commit -m "test(voice): cover early greeting replacement and startup teardown"
```
