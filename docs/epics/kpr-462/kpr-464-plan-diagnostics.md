# KPR-464 correlated diagnostics implementation chunk

> **For agentic workers:** Use dodi-dev:implement after the parent plan's capability and review gates pass.

**Goal:** Account for every speech and bridge attempt, including those producing no content or audio, without misjoining overlapping attempts.

**Architecture:** Emit content-free schema-v2 events at creation, binding, observations and terminal state. App-owned ALS gives each bridge/synthesis immutable identity; the SDK's genuine metrics supply speech identity where available. Handle completion and bounded cleanup supply independent finalizers, so a missing provider metric does not erase an attempt.

**Tech Stack:** TypeScript, Node AsyncLocalStorage/performance, LiveKit agents 1.6.4, existing logger/Mongo summaries.

Inherits the full [Testing Contract](./kpr-464-plan.md#testing-contract), especially S6/S7/S9. The approved spec explicitly permits unbound synthesis when no genuine metric supplies speech identity. The executed test-local proof includes normal metric enrichment, no-metric cancellation, public provider-error context and the observer's pending-read race. Attempt outcome and binding completeness remain independent; no-metric synthesis can be cancelled/failed/completed with an unbound association. Never invent a speech ID.

### Task 1: Establish schema, immutable contexts and attempt lifecycle

**Files:**
- Modify: `src/logging/logger.ts`
- Create: `src/logging/logger.test.ts`
- Create: `src/voice/voice-trace.ts`
- Create: `src/voice/voice-trace.test.ts`
- Create: `src/voice-worker/trace-context.ts`
- Create: `src/voice-worker/speech-trace.ts`
- Create: `src/voice-worker/speech-trace.test.ts`

- [ ] **Step 1: Implement bounded optional metadata validation and shared values.**

```typescript
import { randomUUID } from "node:crypto";

export const VOICE_TRACE_VERSION = 2 as const;
export const VOICE_PROCESS_ID = randomUUID();
export type MissingReason =
  | "not_reached" | "not_applicable" | "not_observed" | "correlation_missing";
export type Measure =
  | { value: number; reason: null }
  | { value: null; reason: MissingReason };
export type AttemptOutcome =
  | "completed" | "interrupted" | "cancelled" | "failed" | "incomplete";
export type CancellationCause =
  | "framework_cancelled" | "call_closed" | "startup_superseded" | "unknown";
export type VoiceTraceMetadata = {
  schemaVersion: 2;
  workerBootId: string;
  turnId: string;
};
export type ParsedTrace = {
  turnId: string;
  workerBootId: string | null;
  correlation: "worker" | "legacy" | "invalid";
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseVoiceTrace(metadata: unknown): ParsedTrace {
  const fallback = (correlation: "legacy" | "invalid"): ParsedTrace => ({
    turnId: randomUUID(), workerBootId: null, correlation,
  });
  if (metadata === undefined) return fallback("legacy");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fallback("invalid");
  const value = (metadata as Record<string, unknown>).voiceTrace;
  if (value === undefined) return fallback("legacy");
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback("invalid");
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length !== 3 || !keys.every((key) => ["schemaVersion", "workerBootId", "turnId"].includes(key))) {
    return fallback("invalid");
  }
  if (v.schemaVersion !== 2 || typeof v.workerBootId !== "string" || typeof v.turnId !== "string") {
    return fallback("invalid");
  }
  if (!UUID.test(v.workerBootId) || !UUID.test(v.turnId)) return fallback("invalid");
  return { workerBootId: v.workerBootId, turnId: v.turnId, correlation: "worker" };
}

export function measure(value: number | undefined, reason: MissingReason): Measure {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? { value, reason: null }
    : { value: null, reason };
}
```

No raw metadata or error body is returned. Missing vs malformed remains observable without rejecting an otherwise compatible Vapi/legacy call. Do not require a worker speech ID in the HTTP request: the SDK may bind it later and one speech can have multiple turns.

Define the diagnostic event as a discriminated union with the following fixed common envelope and event-specific payload allowlist. Do not accept `Record<string, unknown>` from SDK/provider objects as a log payload.

```typescript
export interface TraceEnvelope {
  kind: "voice_diagnostic";
  schemaVersion: 2;
  eventId: string;
  event: string;
  ts: string;
  component: "voice-worker" | "voice-engine";
  clockId: string;
  monoMs: number;
  callId: string;
  workerBootId: string | null;
  speechId: string | null;
  turnId: string | null;
  synthesisId: string | null;
  engineAttemptSeq: number | null;
}
```

`event` is a literal union of the rows below. Payload strings are enums or IDs; no arbitrary exception message, transcript, text, phone, goal/context, tool arguments, audio bytes or provider object is allowed. Durations are monotonic from the owning process; SDK wall timestamps carry `source: "sdk_wall"` and unit labels. Do not subtract clocks across processes.

| Events | Payload fields |
| --- | --- |
| `call_started`, `session_started`, `sip_answered`, `participant_available`, `caller_state`, `caller_final_input`, `caller_turn_accepted`, `opening_decision`, `call_closed` | `direction`, `intendedParticipant` boolean, `state`, `decision`, bounded reason enum, `acceptedEpoch`, `hasFinalInput` boolean; no caller text |
| `speech_started`, `speech_terminal` | `origin`, `acceptedEpoch`, `source`, outcome/cause, generated/known-playout booleans, nullable measurements, bounded error-class enum |
| `bridge_created`, `bridge_started`, `bridge_response`, `bridge_first_text`, `bridge_terminal` | status, text length, first-text duration, maximum gap, outcome/cause/error class |
| `bridge_bound`, `synthesis_bound` | IDs in envelope, `source: "sdk_metrics_context"`; no inferred linkage |
| `synthesis_started`, `synthesis_first_frame`, `synthesis_terminal` | frame count, sample count/rate, duration, outcome/cause; original frame never serialized |
| `sdk_metric`, `handle_playout_item`, `output_playback`, `false_interruption` | numeric allowlist of EOU/TTFT/TTFB/startedSpeakingAt/interruption counts and observation source; call-level if no association |
| `engine_received`, `engine_attempt_started`, `engine_first_text`, `engine_client_closed`, `engine_attempt_terminal`, `engine_terminal` | status, attempt sequence, continuity, nullable `launchAdmission`/`selectedContinuity` enums, warm/tool numeric/boolean allowlist, outcome/error class and stage measures |
| `diagnostic_gap`, `teardown`, `summary_persistence` | gap/failure reason enum, count, persistence status, no raw failure text |

Add an explicit tracked-write method to `createLogger("voice-diagnostics")`; try/catch around existing `info` cannot detect filtering or asynchronous stream errors. Preserve existing `debug/info/warn/error` signatures and formatting. In `src/logging/logger.ts`, export `LogWriteResult = "acknowledged" | "filtered" | "failed" | "overflow"` and this bounded sink. It acknowledges the stream callback, not durable disk storage:

```typescript
import type { Writable } from "node:stream";
export type LogWriteResult = "acknowledged" | "filtered" | "failed" | "overflow";
export function createTrackedLogSink(out: Writable) {
  const pending = new Set<(result: LogWriteResult) => void>();
  let sinkErrors = 0;
  const onError = () => {
    sinkErrors += 1;
    for (const settle of [...pending]) settle("failed");
  };
  out.on("error", onError); // One retained listener per process output stream.
  return {
    write(line: string, callback: (result: LogWriteResult) => void): void {
      const notify = (result: LogWriteResult) => { try { callback(result); } catch {} };
      if (pending.size >= 256) { notify("overflow"); return; }
      if (out.destroyed || out.errored || !out.writable) { notify("failed"); return; }
      let settled = false;
      const settle = (result: LogWriteResult) => {
        if (settled) return;
        settled = true;
        pending.delete(settle);
        notify(result);
      };
      pending.add(settle);
      try { out.write(line, (error?: Error | null) => settle(error ? "failed" : "acknowledged")); }
      catch { settle("failed"); }
      // write(false) is accepted backpressure; wait for its callback.
    },
    snapshot: () => ({ pending: pending.size, sinkErrors }),
    dispose(): void {
      for (const settle of [...pending]) settle("failed");
      out.off("error", onError);
    },
  };
}
```

Cache the stdout/stderr sinks once per process. Add these module functions beside the existing `emit`:

```typescript
const trackedSinks = new WeakMap<Writable, ReturnType<typeof createTrackedLogSink>>();
function trackedSink(out: Writable) {
  let sink = trackedSinks.get(out);
  if (!sink) { sink = createTrackedLogSink(out); trackedSinks.set(out, sink); }
  return sink;
}
function emitTracked(level: Level, component: string, msg: string,
  data: Record<string, unknown> | undefined, callback: (result: LogWriteResult) => void): void {
  const notify = (result: LogWriteResult) => { try { callback(result); } catch {} };
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) { notify("filtered"); return; }
  try {
    const entry = { ts: new Date().toISOString(), level, component, msg, ...data };
    const out = level === "error" ? process.stderr : process.stdout;
    trackedSink(out).write(JSON.stringify(entry) + "\n", notify);
  } catch { notify("failed"); }
}
```

Add these two members to the existing object returned by `createLogger`:

```typescript
writeTracked: (level: Level, msg: string, data: Record<string, unknown> | undefined,
  callback: (result: LogWriteResult) => void) => emitTracked(level, component, msg, data, callback),
trackedSinkSnapshot: () => ({
  sinkErrors: trackedSink(process.stdout).snapshot().sinkErrors +
    trackedSink(process.stderr).snapshot().sinkErrors,
}),
```

Production process sinks keep their error listener for process lifetime, including after the last pending callback; test sinks call `dispose()` only after stream close/error settlement. No per-call process listener accumulation. The writer's start/end `sinkErrors` delta is a clock-level diagnostic gap, never assigned to a particular already-acknowledged row. Filtered levels perform no write. Serialization/sink errors and a throwing result observer never escape into media or recursively log. Existing logger methods retain their behavior and formatting.

`createVoiceTraceWriter` keeps attempted/acknowledged/filtered/failed/overflow/pending counters and a cumulative `sinkErrors` delta. A row is delivered only after `acknowledged`; filtering is counted as missing diagnostics. Pending writes are bounded by the sink's 256 cap; overflow is an explicit lost row and never an unbounded memory queue. After the next normal acknowledged row, submit at most one `diagnostic_gap` containing the unreported failure count; latch gap-in-flight before invoking `writeTracked`, clear only the reported count on its acknowledgment, and retry only after a later normal write. Failure of the gap writer does not recursively log. The cumulative failure count never resets: a later gap does not recover the lost rows.

Expose `settleWrites(timeoutMs = 250)` for finalization only: wait for the writer's pending acknowledgments with a cleared bounded timer, then freeze remaining unresolved count as `unacknowledged`. Late callbacks cannot turn a frozen incomplete snapshot into success. `complete` is false on any filtered/failed/overflow/unacknowledged row or sink error. Finalize attempt rows → bounded write settlement → summary snapshot/persistence; never await log delivery on media paths. Permanent log failure remains detectable in a successful Mongo summary; if both sinks fail there is no durable success claim. A timeout means unknown delivery, never acknowledged. Use `performance.now()` and one process UUID initialized at module load.

- [ ] **Step 2: Introduce separate immutable contexts.**

```typescript
import { AsyncLocalStorage } from "node:async_hooks";

export interface BridgeTraceContext {
  readonly workerBootId: string;
  readonly callId: string;
  readonly turnId: string;
}
export interface SynthesisTraceContext {
  readonly workerBootId: string;
  readonly callId: string;
  readonly synthesisId: string;
}
export const bridgeTraceContext = new AsyncLocalStorage<BridgeTraceContext>();
export const synthesisTraceContext = new AsyncLocalStorage<SynthesisTraceContext>();
```

Use `.run(Object.freeze(context), callback)`, never `.enterWith` in session event listeners or mutable shared `lastTurnTiming`. The base `LLMStream` metric monitor starts in its constructor, so its constructor must execute inside `bridgeTraceContext.run`. The default TTS node must be invoked inside `synthesisTraceContext.run`. The callback attached to session `MetricsCollected` reads these contexts synchronously while handling the SDK metric; don't put the read in a later unrelated timer.

- [ ] **Step 3: Implement one-shot attempt owners and bounded correlation state.**

Use a `SpeechTrace` per call. On `SpeechCreated`, synchronously create the attempt and emit `speech_started` before registering completion. Keep a small owner token per SDK handle in a WeakMap; the SDK-owned done callback closes over this token, never the whole historical event list. Token fields: `speechId`, creation epoch/origin, `terminalEmitted`, observed error class/cancellation cause, generated-audio flag and known-playout flag. Bridge/synthesis owners have independent one-shot terminal flags and monotonic stamps. Never equate bridge completion with speech completion.

Bound each strong active registry to 256 entities and the recent-terminal lookup cache to 256 per entity kind. Keep no per-call unbounded event arrays, metric histories or accumulated frames. Each speech stores at most 16 bridge IDs and 32 synthesis IDs; excess emits `diagnostic_gap: association_overflow` and preserves excess association events in JSONL without selecting an arbitrary last path. Pending unbound/error lookup uses the same 256 bound. Bound eviction is oldest insertion order; emit `diagnostic_gap: active_overflow`, terminalize the evicted active owner once as `incomplete` and continue media. Its SDK callback can emit supplemental known evidence using its token but cannot emit/count another terminal or reinsert the owner. Recent-terminal eviction emits `diagnostic_gap: recent_cache_evicted`; subsequent late observations retain supplied IDs with `correlation_missing` where needed and never attach to a different speech. The reader reconstructs full joins from event rows even after cache eviction.

Required public recorder interface:

```typescript
export type BridgeBinding =
  | { readonly state: "bound"; readonly speechId: string }
  | { readonly state: "unbound" }
  | { readonly state: "unavailable"; readonly reason: "evicted" | "conflict" | "closed" };
export type ActionGapReason = "cancel_failed" | "action_ownership_unproved" | "action_overflow";
export interface SpeechTracePort {
  speechCreated(handle: import("@livekit/agents").voice.SpeechHandle,
    origin: "opening" | "sdk_response" | "retry" | "fallback",
    acceptedEpoch: number): void;
  bridgeCreated(context: BridgeTraceContext): BridgeAttempt;
  synthesisCreated(context: SynthesisTraceContext): SynthesisAttempt;
  bindBridge(turnId: string, speechId: string): void;
  bridgeBinding(turnId: string): BridgeBinding;
  onBridgeBinding(listener: (turnId: string) => void): () => void;
  bindSynthesis(synthesisId: string, speechId: string): void;
  markCancellation(speechId: string, cause: CancellationCause): void;
  synthesisFailure(synthesisId: string, errorClass: "tts_provider_failed"): void;
  unboundProviderFailure(kind: "tts" | "llm", errorClass: "tts_provider_failed" | "llm_provider_failed"): void;
  metrics(event: import("@livekit/agents").MetricsCollectedEvent): void;
  actionGap(reason: ActionGapReason, speechId: string, turnId?: string): void;
  actionGap(reason: ActionGapReason, speechId: string | null, turnId: string): void;
  teardown(result: "closed" | "failed" | "timeout", reason: "call_close" | "late_start" | "late_start_failed"): void;
  close(cause: "call_closed" | "setup_failed"): void;
  snapshot(): CallDiagnosticCounts;
}
```

`bridgeBinding(turnId)` reads only the validated active/recent bridge owner: return `bound` for its one nonconflicting explicit association, `unbound` for an existing owner awaiting genuine binding, and `unavailable` for missing/evicted/conflicting/closed lookup. It never consults the latest speech or returns a stale first binding after conflict. `onBridgeBinding` installs one call-local synchronous listener used by startup recovery and returns an idempotent disposer. Notify with the original turn ID after the validated binding/state and associated failure evidence are installed, including late binding, conflict, lookup eviction and close. Duplicate unchanged binding is a no-op. Moving an owner from active to recent retains its binding atomically, with no transient unavailable notification; actual loss of the last retained owner makes lookup unavailable before notifying. On close invalidate lookup before notifying each retained turn. Conflict stays unavailable for that owner; later repetition of its first binding cannot restore authority. The subscriber rereads `bridgeBinding`; a listener exception is contained and recorded as a content-free gap, never thrown into SDK metrics. Register this single listener before session start; initial error capture also reads the binding, covering errors arriving after notification. It must revalidate **both** pending errors and already-registered recovery chains for that turn (Task 6), since removing a pending error must not detach its invalidation path. Do not install one listener per pending error or retain an event backlog. Remove the subscription on call cleanup. This adds no speech admission or recovery policy to diagnostics; startup alone consumes genuine EOU IDs as specified in Task 6. Add binding-before-subscribe/read, subscribe-before-binding, late binding, conflict, atomic active-to-recent movement, final lookup eviction, duplicate and disposer/throwing-subscriber assertions to the existing registry suite.

Implement both `actionGap` overloads through `actionGap(reason: ActionGapReason, speechId: string | null, turnId?: string)`, emitting the supplied IDs in the envelope and `null` for an absent ID. Reject a null speech without its original turn ID at the TypeScript call boundary; never substitute a current/last speech, placeholder ID or bridge ID as a speech ID. Existing exact-speech callers remain valid. An unbound pending BridgeError evicted at entry 257 uses `trace.actionGap("action_overflow", null, evictedTurnId)`. Add a fixture with 257 distinct unbound pending errors: the oldest error emits one overflow gap with its actual `turnId` and `speechId: null`, only 256 pending errors remain, no action is authorized, and the reader preserves the turn-only gap without creating a speech. Repeat with an exactly bound oldest error to preserve both real IDs. Gap emission is synchronous/throw-safe and cannot prevent eviction or become a media error.

`BridgeAttempt` methods are `started`, `response(status)`, `text(length, monoMs)`, `fail(errorClass)`, `finish(outcome,cause)`, `bind(speechId)`; synthesis equivalents are `frame(frameMetadata)`, `fail(errorClass)`, `finish` and `bind`. `frame` accumulates frame count, per-channel sample count and generated duration (`samplesPerChannel / sampleRate` summed per frame); emit the first-frame event once and include final totals in the terminal even for cancellation/error. Mixed sample rates retain summed duration with terminal `sampleRate: null`/`not_applicable`; never sum samples as a duration under a guessed constant rate. `fail` latches a directly observed error before cleanup; `finish(cancelled)` cannot erase it. Terminal event includes nullable observations plus reasons. Methods called after terminal emit only supplemental observations under original IDs and do not mutate another attempt or its counters. Run ID/conflicting-binding validation: a different second speech ID for one turn/synthesis emits a gap and marks correlation missing, rather than replacing the first association.

Implement owner finalization with this one-shot pattern, specialized to each entity's typed row:

```typescript
function terminalOnce<T>(emit: (value: T) => void, count: (value: T) => void) {
  let ended = false;
  return (value: T): boolean => {
    if (ended) return false;
    ended = true;
    count(value);
    emit(value);
    return true;
  };
}
```

Counts advance even when logging fails; the writer records failure separately. The recorder callback must be synchronous and throw-safe so logging cannot abort the SDK speech event or provider loop.

Register one synchronous public `ttsModel.on("error", onTtsError)` listener **before** session start/default-node invocation. It reads `synthesisTraceContext.getStore()` in that same callback, validates the call/boot and live owner, and invokes `synthesisFailure` to latch `tts_provider_failed` before the SDK can swallow the exception into normal reader EOF. Never look up current speech. The provider instance is the actual `buildTts` result passed to AgentSession. If context is absent/evicted/conflicting, retain a call-level unbound error and diagnostic gap. Remove this listener only after all owned nodes have settled or been synchronously finalized during bounded cleanup. The callback is throw-safe and does not await. `SynthesisAttempt.fail` propagates a known error to its explicitly bound speech token; if binding arrives later, propagate only to that original token as supplemental evidence, preserving any already-emitted incomplete terminal. Overlapping provider errors must remain isolated by ALS.

Handle completion: `addDoneCallback` records **SDK settlement** and reads that handle's own `chatItems` and nullish `exception()`; no exception is a weak observation, never success evidence. Record each assistant item's text **length**, interrupted boolean and numeric `startedSpeakingAt` (seconds, `sdk_wall`). Missing items remain `not_observed` even for interrupted empty handles. Application bridge/node owners latch error/cancel before their settlement; this causal ordering determines the one-shot terminal. Do not wait for optional metrics or media output to recover identity.

At SDK settlement, attempt finalization immediately with these precedence rules: known associated application error → `failed`; directly observed local cancellation → `cancelled`; SDK interruption → `interrupted`; otherwise `completed` only if required causal coverage is proved and every associated application owner settled without failure/cancel. For an application `say`, bridge work is `not_applicable`; for generated replies absence of an explicit bridge association is `correlation_missing`. Successful generated-audio coverage requires a genuinely bound settled synthesis; an unknown/unbound synthesis cannot supply a speech frame count or establish success. Any active/unbound synthesis coverage that cannot be excluded from that speech using explicit evidence makes its coverage unknown, not a time-based join. Missing causal coverage or linked work still pending at SDK settlement yields `incomplete` immediately with `sdkSettled: true` and reason `not_observed`/`correlation_missing`. Late binding/settlement supplements the original incomplete record without another terminal/count. This deliberately favors an honest incomplete record over a falsely successful one; no timer or pending diagnostic state gates replacement. `exception()` may add a known failure, but is never the primary error route. `waitForPlayout()` is not handset evidence.

EOU/LLM/TTS metrics use their explicit `speechId`. `llm_metrics` + matching bridge ALS turn emits `bridge_bound`, even when SDK `requestId === ""`; `tts_metrics` + synthesis ALS emits `synthesis_bound`. First frame may arrive before binding; keep its event keyed by synthesis ID and later enrich the correct speech. Metrics with missing context/IDs preserve an unbound observation; distinguish expected no-metric coverage from conflicting/lost identity gaps. Interruption aggregate metrics and false-interruption events are call-level unless an explicit associated speech is supplied by the SDK. Do not assign them to the most recent handle.

- [ ] **Step 4: Verify schema and registry semantics.**

Run: `npx vitest run src/logging/logger.test.ts src/voice/voice-trace.test.ts src/voice-worker/speech-trace.test.ts`

Assertions: invalid/missing metadata safe fallback; enum/field allowlist; canceled speech before any EOU/TTS; two overlapping requests with reversed metrics; metrics after terminal; duplicate terminal/binding; duplicate handle registration; no-content bridge; say with no bridge; missing TTS; negative SDK metrics map to null; 257 active/recent entities and association overflow produce gaps; summaries count each attempt once; call close twice finalizes once; real Writable sync throw, asynchronous callback/error event, write(false), filtered LOG_LEVEL, 257 pending writes and never-ack timeout cannot escape or claim delivery; provider error precedes normal node EOF and handle settlement before/after frame; all retained maps at/below bounds after stress; close detaches fixed listeners. Expected all pass, not an implementation-mirroring snapshot test.

```bash
git add src/logging/logger.ts src/logging/logger.test.ts src/voice/voice-trace.ts src/voice/voice-trace.test.ts src/voice-worker/trace-context.ts src/voice-worker/speech-trace.ts src/voice-worker/speech-trace.test.ts
git commit -m "feat(voice): record bounded correlated speech attempts"
```

### Task 2: Trace every HiveLLM request before headers or content exist

**Files:**
- Modify: `src/voice-worker/hive-llm.ts` (`BridgeError`, `HiveLLM.chat`, `HiveLLMStream`)
- Modify: `src/voice-worker/hive-llm.test.ts`

- [ ] **Step 1: Allocate identity before stream construction.**

Add a typed trace port to HiveLLM options. In `chat`, allocate `randomUUID()` for turn ID, create/emit bridge attempt, then construct `HiveLLMStream` under immutable ALS. Pass the attempt/context into its constructor rather than looking them up later in `run`:

```typescript
const traceContext = Object.freeze({
  workerBootId: VOICE_PROCESS_ID,
  callId: this.opts.callId,
  turnId: randomUUID(),
});
const attempt = this.opts.trace.bridgeCreated(traceContext);
try {
  return bridgeTraceContext.run(traceContext, () => new HiveLLMStream(
    this, this.opts,
    { chatCtx: chatOpts.chatCtx, toolCtx: chatOpts.toolCtx,
      connOptions: chatOpts.connOptions ?? DEFAULT_API_CONNECT_OPTIONS },
    traceContext, attempt,
  ));
} catch (error) {
  attempt.fail("stream_construction_failed");
  attempt.finish("failed", "unknown");
  throw error;
}
```

Remove `lastTurnTiming` and every identity-by-object-reference consumer. Use `hive-${turnId}` for ChatChunk ID from the start; never allocate a new ID only after response success. Add the validated trace object to top-level request `metadata.voiceTrace`:

```typescript
metadata: {
  voiceTrace: { schemaVersion: 2, workerBootId: this.traceContext.workerBootId,
    turnId: this.traceContext.turnId },
},
```

Retain `call.id` and existing `call.metadata` exactly for agent/goal/context. No speech ID is guessed. Extend BridgeError with readonly `turnId` and a bounded failureClass; do not use the error message as diagnostic data. HTTP body snippets may still classify existing errors in memory, but new logs must contain only the resulting class/status.

- [ ] **Step 2: Make cancellation and terminalization cover every stream lifecycle.**

The stream constructor installs its abort listener after `super` and closes over the passed attempt. SDK `close()` before scheduled `run()` must terminalize once and skip fetch; override public `close()` only if Task 0 proves necessary, call `super.close()` and own no SDK private queue operations. In `run`, first check the already-aborted signal, then create/attach fetch controller and run-local monotonic timing. Direct observed failure is latched before any teardown abort. Cause defaults to `framework_cancelled`; use `startup_superseded`/`call_closed` only via the recorder's known speech binding/local observation.

Use try/catch/finally for request construction, fetch, status parsing, reader consumption and decoder/parser errors. Emit response status immediately; first nonempty content updates first-text time; subsequent nonempty chunks update maximum inter-chunk gap. Skip empty content without minting a first token. Stream original text chunks immediately. Maintain existing interruption-marker snapshot and acceptance clearing behavior. Reader cancellation and release belong in `finally`; detach both fetch and lifecycle listeners. If there was no content, first-text is null/not_reached and max-gap is null/not_applicable unless at least two chunks were observed.

The abort callback must abort HTTP immediately; diagnostics cannot await metrics. `finally` calls attempt.finish once. A pre-run aborted attempt is already terminal but can still receive a late SDK binding/metric. A thrown error preserved in the attempt remains failed if base SDK cleanup subsequently aborts its controller. Missing metrics retain the bridge attempt with `correlation_missing`; when the pinned genuine LLM metric is present it must bind the correct handle. Tests fail on loss, guessed/wrong joins or false outcomes, not a truthfully unavailable association. Bridge failure is latched before the original BridgeError is rethrown; the narrow public provider event route in startup Task 6 makes application-managed bridge failures nonfatal to the SDK counter while preserving the event and existing bounded application recovery.

- [ ] **Step 3: Verify real HTTP boundaries.**

Extend existing HiveLLM tests to POST to controlled loopback server with barriers before headers, between headers/text, between two text chunks and at done. Include `.close()` immediately after construction, abort after body complete, empty success, HTTP error, broken body, overlapping reverse completions and interruption-marker retry. Assert turn ID exists before `run`, metadata separation, immediate server-observed request close, one terminal, retained first text on later failure, and correct late binding. Use genuine SDK metrics for identity assertions in the capability integration suite.

Run: `npx vitest run src/voice-worker/hive-llm.test.ts src/voice-worker/sse.test.ts src/voice-worker/chat-ctx.test.ts src/voice-worker/interruption-marker.test.ts src/voice-worker/sdk-capability.integration.test.ts`

Expected: passes; no non-loopback calls, dummy text, content buffering or SDK private imports.

```bash
git add src/voice-worker/hive-llm.ts src/voice-worker/hive-llm.test.ts
git commit -m "feat(voice): correlate bridge attempts before streaming starts"
```

### Task 3: Replace lossy turn summaries and wrap actual TTS output

**Files:**
- Create: `src/voice-worker/traced-agent.ts`
- Create: `src/voice-worker/traced-agent.test.ts`
- Modify: `src/voice-worker/telemetry.ts` (`TurnMetrics`, `CallStats`)
- Modify: `src/voice-worker/telemetry.test.ts`

- [ ] **Step 1: Implement the public Agent subclass.**

Override `onUserTurnCompleted` to call the injected startup callback synchronously for nonempty `newMessage.textContent?.trim()` before the method returns its resolved promise. Do not modify chat context, messages or worker placeholder instructions. Override `ttsNode` with exact signature derived from `voice.Agent["ttsNode"]`, assign synthesis UUID and invoke the real `voice.Agent.default.ttsNode(this, text, modelSettings)` under synthesis ALS.

Wrap the returned stream with one in-flight read, preserving original frame objects/metadata and incremental delivery. Synchronously latch cancellation **before** `reader.cancel()`; it can resolve an outstanding `read()` with `done: true`, or race a ready frame. A cancellation finalizer must win over that continuation. The listener described in Task 1 latches TTS failure even when the default reader completes normally. Add this reusable helper in `traced-agent.ts` and test its production implementation directly:

```typescript
export function observeTtsStream<T extends { sampleRate: number; samplesPerChannel: number }>(
  input: ReadableStream<T>,
  attempt: {
    frame(meta: { sampleRate: number; samplesPerChannel: number }): void;
    fail(errorClass: "tts_node_failed"): void;
    finish(outcome: AttemptOutcome, cause: CancellationCause): void;
  },
  signal: AbortSignal,
): ReadableStream<T> {
  const reader = input.getReader();
  let state: "open" | "cancelled" | "finished" = "open";
  let pending: Promise<ReadableStreamReadResult<T>> | null = null;
  let cancelPromise: Promise<void> | null = null;
  let released = false;
  let output: ReadableStreamDefaultController<T>;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  };
  const cancelOwned = (cause: CancellationCause, closeOutput: boolean): Promise<void> => {
    if (state !== "open") return cancelPromise ?? Promise.resolve();
    state = "cancelled"; // Before upstream cancel can resolve pending read.
    attempt.finish("cancelled", cause); // Prior fail latch still wins in recorder.
    if (closeOutput) { try { output.close(); } catch {} }
    const activeRead = pending;
    let cancellation: Promise<void>;
    try { cancellation = reader.cancel(); }
    catch { cancellation = Promise.resolve(); }
    cancelPromise = Promise.allSettled([cancellation, activeRead]).then(() => { release(); });
    return cancelPromise;
  };
  const onAbort = () => { void cancelOwned("call_closed", true); };
  return new ReadableStream<T>({
    start(controller) {
      output = controller;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      if (state !== "open") return;
      try {
        pending = reader.read();
        const next = await pending;
        if (state !== "open") return; // No completed terminal or late frame after cancel.
        if (next.done) {
          state = "finished";
          attempt.finish("completed", "unknown"); // Recorder's failure latch overrides EOF.
          release();
          controller.close();
          return;
        }
        attempt.frame({ sampleRate: next.value.sampleRate,
          samplesPerChannel: next.value.samplesPerChannel });
        controller.enqueue(next.value);
      } catch {
        if (state !== "open") return;
        state = "finished";
        attempt.fail("tts_node_failed");
        attempt.finish("failed", "unknown");
        release();
        controller.error(new Error("Voice synthesis failed"));
      } finally { pending = null; }
    },
    cancel() { return cancelOwned("framework_cancelled", false); },
  }, { highWaterMark: 0 });
}
```

`attempt` methods are the synchronous throw-safe recorder methods; state flags never depend on sink behavior. Reader release follows pending read/cancel settlement and happens once. If upstream ignores cancellation forever, call-level cleanup times out and reports the unreleased resource incomplete; attach rejection handlers and retain the final cleanup continuation. No extra output frames are permitted while waiting. The helper adds no utterance queue and makes no assertion about inaccessible SDK/provider queue sizes.

Allocate the synthesis UUID/owner, then invoke actual `voice.Agent.default.ttsNode(this, text, modelSettings)` inside immutable synthesis ALS. Catch rejection before reader creation as failed. A null node result finalizes its own synthesis with zero observed frames (or the prior failure latch), and stays unbound. Wrap a returned input even when the call signal is already aborted so the reader is canceled/released. Constructor/node rejection after close cannot emit another terminal. No first-frame or retained `say()` handle implies a speech association. Bind only from genuine TTS metric+context; retain expected unbound before/after-frame cancellation and failures.

Minimum production wrapper tests in `traced-agent.test.ts`: pending `read()` then `cancel` (terminal cancelled, zero frames, never completed), enqueue racing cancel (no forwarded frame after latch), upstream rejection racing cancel (one terminal/release), call abort before first pull/during read, reader normal EOF after provider failure before/after frame, original frames+timed metadata, incremental two-frame output, final frame/sample/duration totals and multi-rate totals. Real SDK provider cases in the capability/startup suites cross the public error listener; a throwing fake reader alone is insufficient.

- [ ] **Step 2: Replace `TurnMetrics`' single pending state with recorder delegation.**

Delete `pendingEou`, `llmTtftBySpeechId`, `pendingInterrupted`, `pendingFalseInterruption`, and `lastTurnTiming` reads. Either remove the TurnMetrics class and replace its session callsite with SpeechTrace, or retain a thin compatibility adapter with no independent mutable join state; choose removal to avoid parallel truth. SpeechTrace's fixed session listeners now receive EOU/LLM/TTS. Session error/interruption prefix bookkeeping remains separate from counting speech outcomes.

Extend CallStats with a schema-v2 aggregate snapshot received at flush. Store `speechAttempts`, outcome counts, `bridgeAttempts`, `synthesisAttempts`, `generatedAudioObserved`, `knownPlayoutObserved`, `incomplete`, `unbound`, `diagnosticGaps`, logging failures and `latencyEstimateSamples/excludedByReason`; no ID/event arrays. `interruptions` is count of SDK interrupted handles including those canceled before committed text; `cancelled` remains separate and a local startup cancellation can also carry `sdkInterrupted: true` for compatibility. Preserve `retries` and first-terminal-call-outcome rules.

Legacy `turns`/`latency` fields must be explicitly documented: keep `turns` equal to eligible stage-estimate sample count, with `latency.kind: "estimated_eou_to_first_generated_audio"` and `schemaVersion: 2`. Openings, failures/cancellations, multiple ambiguous paths or missing components cannot enter these distributions. Retain at most one candidate TTS TTFB plus a distinct-metric count per synthesis. Only exactly one distinct genuine metric is eligible; two or more segments are `ambiguous_components`, never last/first-by-arrival. Deduplicate repeated delivery by metric object identity (`WeakSet`) or application eventId in the offline reducer; requestId/timestamp alone is not unique. Do not reuse historical `totalToFirstAudioMs` name for a newly asserted measured latency. Replace unbounded `turnLatencies` with a fixed reservoir of at most 1,024 eligible estimates and report `latency.sampled`/`eligibleSampleCount`/`retainedSampleCount`; to avoid pretending exact distributions, use deterministic first-1,024 retention and mark `truncated: true` after overflow. KPR-465 uses JSONL full denominators for actual comparisons. Bound failure storage to counts/last class rather than an unbounded string array.

- [ ] **Step 3: Make summary persistence truthful and shutdown ordered.**

Replace the single `flushedOutcome` completion guard with `terminalOutcome` (first-wins) plus shared `flushPromise` and persistence result. Concurrent flushes share one attempt; call outcome is latched before writes, but only acknowledged Mongo insert is `persisted: true`. On connect/insert failure, log bounded `summary_persistence: failed` and return `{ persisted: false }`; no caller may log success. Avoid automatic retry without an idempotency key: a response-loss insert could otherwise duplicate. Keep Mongo client close in finally, and close failure separate from insert acknowledgement.

Session close first marks startup terminal/cancels owned activity, calls SpeechTrace.close to terminalize remaining owners synchronously, then performs bounded tracked-write settlement, snapshots counts, awaits CallStats.flush, and closes outer Mongo. Do not await optional metrics or SpeechHandle playout during diagnostic finalization. Late callback after close is ignored or emits a supplemental row with the original ID, never another terminal/counter. Listener disposal is idempotent.

Run: `npx vitest run src/voice-worker/traced-agent.test.ts src/voice-worker/speech-trace.test.ts src/voice-worker/telemetry.test.ts src/voice-worker/session.test.ts src/voice-worker/sdk-capability.integration.test.ts`

Expected: missing metrics remain unknown; first outcome retained across setup/error/shutdown; single concurrent insert; failed insert not marked persisted; close follows finalization/flush even if logging/persistence fails; no heartbeat behavior regression.

```bash
git add src/voice-worker/traced-agent.ts src/voice-worker/traced-agent.test.ts src/voice-worker/telemetry.ts src/voice-worker/telemetry.test.ts
git commit -m "feat(voice): preserve synthesis evidence and complete call denominators"
```
