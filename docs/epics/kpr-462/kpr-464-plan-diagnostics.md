# KPR-464 correlated diagnostics implementation chunk

> **For agentic workers:** Use dodi-dev:implement after the parent plan's capability and review gates pass.

**Goal:** Account for every speech and bridge attempt, including those producing no content or audio, without misjoining overlapping attempts.

**Architecture:** Emit content-free schema-v2 events at creation, binding, observations and terminal state. App-owned ALS gives each bridge/synthesis immutable identity; the SDK's genuine metrics supply speech identity where available. Handle completion and bounded cleanup supply independent finalizers, so a missing provider metric does not erase an attempt.

**Tech Stack:** TypeScript, Node AsyncLocalStorage/performance, LiveKit agents 1.6.4, existing logger/Mongo summaries.

Inherits the full [Testing Contract](./kpr-464-plan.md#testing-contract), especially S6/S7/S9. This chunk's TTS association remains conditional on Task 0: the existing probe observes no TTS metric before first-frame cancellation. Record that as unbound/incomplete until a reviewed explicit association meets the required contract; never invent a speech ID.

### Task 1: Establish schema, immutable contexts and attempt lifecycle

**Files:**
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
| `call_started`, `session_started`, `sip_answered`, `participant_available`, `caller_state`, `caller_turn_accepted`, `opening_decision`, `call_closed` | `direction`, `intendedParticipant` boolean, `state`, `decision`, bounded reason enum, `acceptedEpoch`; no caller text |
| `speech_started`, `speech_terminal` | `origin`, `acceptedEpoch`, `source`, outcome/cause, generated/known-playout booleans, nullable measurements, bounded error-class enum |
| `bridge_created`, `bridge_started`, `bridge_response`, `bridge_first_text`, `bridge_terminal` | status, text length, first-text duration, maximum gap, outcome/cause/error class |
| `bridge_bound`, `synthesis_bound` | IDs in envelope, `source: "sdk_metrics_context"`; no inferred linkage |
| `synthesis_started`, `synthesis_first_frame`, `synthesis_terminal` | frame count, sample count/rate, duration, outcome/cause; original frame never serialized |
| `sdk_metric`, `handle_playout_item`, `output_playback`, `false_interruption` | numeric allowlist of EOU/TTFT/TTFB/startedSpeakingAt/interruption counts and observation source; call-level if no association |
| `engine_received`, `engine_attempt_started`, `engine_first_text`, `engine_client_closed`, `engine_attempt_terminal`, `engine_terminal` | status, attempt sequence, continuity, warm/tool numeric/boolean allowlist, outcome/error class and stage measures |
| `diagnostic_gap`, `summary_persistence` | gap/failure reason enum, count, persistence status, no raw failure text |

Implement `createVoiceTraceWriter` using `createLogger("voice-diagnostics")`; wrap logger calls in try/catch and keep `writeFailures` count. The next successful write emits one `diagnostic_gap` for the accumulated count, then resets it. Do not recursively log from the catch. Expose `writeFailures`/`complete` in the call summary so a permanent log failure remains detectable by summary when persistence succeeds. If both sinks fail, the result must be reported as failed persistence, never successful diagnostics. Use `performance.now()` and one process UUID initialized at module load.

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
export interface SpeechTracePort {
  speechCreated(handle: import("@livekit/agents").voice.SpeechHandle,
    origin: "opening" | "sdk_response" | "retry" | "fallback",
    acceptedEpoch: number): void;
  bridgeCreated(context: BridgeTraceContext): BridgeAttempt;
  synthesisCreated(context: SynthesisTraceContext): SynthesisAttempt;
  bindBridge(turnId: string, speechId: string): void;
  bindSynthesis(synthesisId: string, speechId: string): void;
  markCancellation(speechId: string, cause: CancellationCause): void;
  metrics(event: import("@livekit/agents").MetricsCollectedEvent): void;
  close(cause: "call_closed" | "setup_failed"): void;
  snapshot(): CallDiagnosticCounts;
}
```

`BridgeAttempt` methods are `started`, `response(status)`, `text(length, monoMs)`, `fail(errorClass)`, `finish(outcome,cause)`, `bind(speechId)`; synthesis equivalents are `firstFrame(frameMetadata)`, `finish` and `bind`. `fail` latches a directly observed error before cleanup; `finish(cancelled)` cannot erase it. Terminal event includes nullable observations plus reasons. Methods called after terminal emit only supplemental observations under original IDs and do not mutate another attempt or its counters. Run ID/conflicting-binding validation: a different second speech ID for one turn/synthesis emits a gap and marks correlation missing, rather than replacing the first association.

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

Handle completion: use `addDoneCallback`, read its **own** `chatItems` and `exception()` only after `done()`. For each assistant message record text **length**/interrupted boolean and `metrics.startedSpeakingAt` if numeric (seconds since epoch; store source/unit). Keep absence `not_observed`, including an interrupted handle with zero items. Terminal precedence: known provider/bridge error → failed; explicit call/startup cancellation → cancelled; SDK `interrupted` → interrupted; otherwise finished handle → completed. If completion/error ordering cannot establish final classification at the callback (Task 0), use a short diagnostic-pending record finalized by owned error/binding or call close, without gating replacement scheduling; the capability gate must determine a correct bounded policy before implementation readiness. `waitForPlayout()` alone is no proof of audio receipt.

EOU/LLM/TTS metrics use their explicit `speechId`. `llm_metrics` + matching bridge ALS turn emits `bridge_bound`, even when SDK `requestId === ""`; `tts_metrics` + synthesis ALS emits `synthesis_bound`. First frame may arrive before binding; keep its event keyed by synthesis ID and later enrich the correct speech. Metrics with missing context/IDs emit an explicit gap. Interruption aggregate metrics and false-interruption events are call-level unless an explicit associated speech is supplied by the SDK. Do not assign them to the most recent handle.

- [ ] **Step 4: Verify schema and registry semantics.**

Run: `npx vitest run src/voice/voice-trace.test.ts src/voice-worker/speech-trace.test.ts`

Assertions: invalid/missing metadata safe fallback; enum/field allowlist; canceled speech before any EOU/TTS; two overlapping requests with reversed metrics; metrics after terminal; duplicate terminal/binding; duplicate handle registration; no-content bridge; say with no bridge; missing TTS; negative SDK metrics map to null; 257 active/recent entities and association overflow produce gaps; summaries count each attempt once; call close twice finalizes once; thrown logger does not escape; all retained maps at/below bounds after stress; close detaches fixed listeners. Expected all pass, not an implementation-mirroring snapshot test.

```bash
git add src/voice/voice-trace.ts src/voice/voice-trace.test.ts src/voice-worker/trace-context.ts src/voice-worker/speech-trace.ts src/voice-worker/speech-trace.test.ts
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

The abort callback must abort HTTP immediately; diagnostics cannot await metrics. `finally` calls attempt.finish once. A pre-run aborted attempt is already terminal but can still receive a late SDK binding/metric. A thrown error preserved in the attempt remains failed if base SDK cleanup subsequently aborts its controller. Missing metrics leave `correlation_missing` and fail the required complete-correlation regression instead of disappearing.

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
- Modify: `src/voice-worker/telemetry.ts` (`TurnMetrics`, `CallStats`)
- Modify: `src/voice-worker/telemetry.test.ts`

- [ ] **Step 1: Implement the public Agent subclass.**

Override `onUserTurnCompleted` to call the injected startup callback synchronously for nonempty `newMessage.textContent?.trim()` before the method returns its resolved promise. Do not modify chat context, messages or worker placeholder instructions. Override `ttsNode` with exact signature derived from `voice.Agent["ttsNode"]`, assign synthesis UUID and invoke the real `voice.Agent.default.ttsNode(this, text, modelSettings)` under synthesis ALS.

Wrap the returned stream using a pull-through reader, preserving original frames and backpressure. No frame cloning/resampling, buffering, new transform text or `userdata` changes:

```typescript
const input = await synthesisTraceContext.run(context,
  () => voice.Agent.default.ttsNode(this, text, modelSettings));
if (input === null) {
  attempt.finish("completed", "unknown");
  return null;
}
const reader = input.getReader();
let finished = false;
let frameCount = 0;
const finish = (outcome: AttemptOutcome, cause: CancellationCause) => {
  if (finished) return;
  finished = true;
  attempt.finish(outcome, cause);
  reader.releaseLock();
};
return new ReadableStream({
  async pull(controller) {
    try {
      const next = await reader.read();
      if (finished) return;
      if (next.done) {
        finish("completed", "unknown");
        controller.close();
        return;
      }
      frameCount += 1;
      if (frameCount === 1) attempt.firstFrame({
        sampleRate: next.value.sampleRate,
        samplesPerChannel: next.value.samplesPerChannel,
      });
      controller.enqueue(next.value);
    } catch {
      if (finished) return;
      attempt.fail("tts_node_failed");
      finish("failed", "unknown");
      controller.error(new Error("Voice synthesis failed"));
    }
  },
  async cancel() {
    if (finished) return;
    try { await reader.cancel(); }
    finally { finish("cancelled", "framework_cancelled"); }
  },
}, { highWaterMark: 0 });
```

Also catch default-node construction rejection before reader creation and terminalize failed. In implementation ensure pending-read cancellation releases the lock only after read/cancel settlement; protect late read rejection from double terminal/error. Keep detailed provider exception only in original SDK error path, not new diagnostic output. A node canceled without any TTS metric is still a visible synthesis attempt, with an explicit unbound/incomplete association; the required capability gate must resolve what can be joined before readiness. Do not assign it to the current/last speech. The real default node preserves timed transcripts; Task 0 and integration tests must prove this exact wrapper does too.

- [ ] **Step 2: Replace `TurnMetrics`' single pending state with recorder delegation.**

Delete `pendingEou`, `llmTtftBySpeechId`, `pendingInterrupted`, `pendingFalseInterruption`, and `lastTurnTiming` reads. Either remove the TurnMetrics class and replace its session callsite with SpeechTrace, or retain a thin compatibility adapter with no independent mutable join state; choose removal to avoid parallel truth. SpeechTrace's fixed session listeners now receive EOU/LLM/TTS. Session error/interruption prefix bookkeeping remains separate from counting speech outcomes.

Extend CallStats with a schema-v2 aggregate snapshot received at flush. Store `speechAttempts`, outcome counts, `bridgeAttempts`, `synthesisAttempts`, `generatedAudioObserved`, `knownPlayoutObserved`, `incomplete`, `unbound`, `diagnosticGaps`, logging failures and `latencyEstimateSamples/excludedByReason`; no ID/event arrays. `interruptions` is count of SDK interrupted handles including those canceled before committed text; `cancelled` remains separate and a local startup cancellation can also carry `sdkInterrupted: true` for compatibility. Preserve `retries` and first-terminal-call-outcome rules.

Legacy `turns`/`latency` fields must be explicitly documented: keep `turns` equal to eligible stage-estimate sample count, with `latency.kind: "estimated_eou_to_first_generated_audio"` and `schemaVersion: 2`. Openings, failures/cancellations, multiple ambiguous paths or missing components cannot enter these distributions. Do not reuse historical `totalToFirstAudioMs` name for a newly asserted measured latency. Replace unbounded `turnLatencies` with a fixed reservoir of at most 1,024 eligible estimates and report `latency.sampled`/`eligibleSampleCount`/`retainedSampleCount`; to avoid pretending exact distributions, use deterministic first-1,024 retention and mark `truncated: true` after overflow. KPR-465 uses JSONL full denominators for actual comparisons. Bound failure storage to counts/last class rather than an unbounded string array.

- [ ] **Step 3: Make summary persistence truthful and shutdown ordered.**

Replace the single `flushedOutcome` completion guard with `terminalOutcome` (first-wins) plus shared `flushPromise` and persistence result. Concurrent flushes share one attempt; call outcome is latched before writes, but only acknowledged Mongo insert is `persisted: true`. On connect/insert failure, log bounded `summary_persistence: failed` and return `{ persisted: false }`; no caller may log success. Avoid automatic retry without an idempotency key: a response-loss insert could otherwise duplicate. Keep Mongo client close in finally, and close failure separate from insert acknowledgement.

Session close first marks startup terminal/cancels owned activity, calls SpeechTrace.close to terminalize remaining owners synchronously, then snapshots counts, then awaits CallStats.flush, then closes outer Mongo. Do not await optional metrics or SpeechHandle playout during diagnostic finalization. Late callback after close is ignored or emits a supplemental row with the original ID, never another terminal/counter. Listener disposal is idempotent.

Run: `npx vitest run src/voice-worker/telemetry.test.ts src/voice-worker/session.test.ts src/voice-worker/sdk-capability.integration.test.ts`

Expected: missing metrics remain unknown; first outcome retained across setup/error/shutdown; single concurrent insert; failed insert not marked persisted; close follows finalization/flush even if logging/persistence fails; no heartbeat behavior regression.

```bash
git add src/voice-worker/traced-agent.ts src/voice-worker/telemetry.ts src/voice-worker/telemetry.test.ts
git commit -m "feat(voice): preserve synthesis evidence and complete call denominators"
```
