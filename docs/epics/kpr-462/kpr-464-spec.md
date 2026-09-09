# KPR-464 — Audible startup and correlated speech evidence

## TL;DR

Give outbound startup one decision owner: request an opening when the answered caller is quiet, or let the existing voice pipeline answer the caller's early greeting, without leaving a second opening queued behind that response. Record every speech attempt and bridge turn through completion, interruption, cancellation, or failure, including attempts that produce no audio. Deterministic regressions must pass before a separately authorized live test establishes what May actually heard; the September 7 handset failure remains unexplained until evidence supports a cause.

## Key Points

- Keep the existing Twilio → LiveKit → Deepgram/Cartesia path, Mokie's engine-authored prompt, voice selection, and `voice-livekit` tool routing.
- Replace the unconditional post-answer `generateReply()` with a small outbound startup arbiter that observes caller activity and accepted turns. Caller input remains interruptible and audible output remains streamed.
- A `speech_created` event starts an attempt record. End-of-utterance and TTS metrics enrich that record; neither is required for the attempt to exist or finish.
- Join worker speech IDs to independently allocated bridge turn IDs explicitly. Preserve canceled requests, retries, empty generations, and fallback `say()` handles; never join by timestamp proximity or a shared “last turn” value.
- Distinguish first bridge text, first synthesized frame, worker playout evidence, and caller confirmation. An empty logged transcript or missing event proves none of the later stages absent.
- ⚠ Delegated assumption: a state-driven startup correction and small, versioned JSONL diagnostics are appropriate within the approved child scope. No opening delay, audio pre-rendering, interruption lockout, or warm-path change is selected.
- ⚠ Delegated assumption: prove the pinned SDK correlation and event-order seams in an offline capability test before the implementation plan is declared ready. If the seams cannot satisfy this contract, revise the design rather than guessing IDs or silently dropping observations.
- KPR-465 owns comparative latency targets and tuning. KPR-463 owns deployment; KPR-466 owns the integrated acceptance run. This draft performs no deployment or live calls.

## 1. Problem, authority, and dependencies

[KPR-464](https://linear.app/keepur/issue/KPR-464/voice-startup-make-the-opening-audible-and-trace-canceled-speech) reports that May heard nothing before “May? It's Mokie. Can you hear me?” on the September 7 call. The ticket and epic summarize two interrupted startup attempts with empty logged playout text and incomplete metric coverage. The [verified KPR-325 timeline and sanitized attachment](https://linear.app/keepur/issue/KPR-325/w55-call-personas-vendor-pilot#comment-3af09f64) remain the baseline evidence source. This draft uses the supplied ticket snapshot; it does not independently claim to have remeasured that attachment or handset behavior.

Gate 1 delegated specification and plan maturation. The epic has no `Decision Register — Canon` section: this is a pre-register epic, not a missing approval. KPR-320 has merged through PR #471. The reviewed [KPR-463 specification](./kpr-463-spec.md) and [plan](./kpr-463-plan.md) establish the adjacent deployment contract but contain no implemented startup fix and do not establish call acceptance.

KPR-464 blocks KPR-465. Its measurement contract must be available before latency comparisons, and its required live startup acceptance remains explicit if implementation merges first. Coordinate shared worker files through serialized epic delivery; do not take over KPR-463 service admission, package, or migration work.

## 2. Current behavior and bounded diagnosis

Source inspection found these concrete gaps:

| Surface | Current behavior | Consequence |
| --- | --- | --- |
| `src/voice-worker/session.ts` | Starts the listening session, waits for `createSipParticipant(..., { waitUntilAnswered: true })`, then always calls `generateReply()`. | An early caller turn can also schedule a response. The application has no single decision about whether an opening is still needed. |
| `src/voice-worker/telemetry.ts` | Holds one pending EOU, replaces it on the next EOU, emits only on matching TTS, omits `speechId`, and uses shared `lastTurnTiming`. | Explicit openings without EOU, early cancellations, overlapping attempts, and missing TTS can disappear or lack reliable bridge timing. |
| `src/voice-worker/hive-llm.ts` | Allocates a chunk ID after a successful HTTP response, stores one mutable timing object, and labels every abort “barge-in.” | A pre-content cancellation lacks a useful cross-process identity, and disconnect cause is overstated. |
| `session.ts` interruption listener | Counts only interrupted assistant conversation items. | A canceled handle with no committed assistant text can be invisible to interruption counts. |
| `src/channels/voice/voice-adapter.ts` | Logs rich timing on the successful completion path, but has no worker turn ID and returns early after disconnect or several failures. | There is no complete denominator of attempted requests and no deterministic worker/engine join. |

The pinned `@livekit/agents` 1.6.4 source supports separate speech handles for explicit generation and caller turns; accepted caller turns can interrupt an active handle. This supports a reproducible scheduling-race hypothesis, **not** a claim that it caused the historical handset silence. [Pinned scheduling implementation](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/voice/agent_activity.ts).

The implementation must first reproduce the relevant ordering with controlled input and record which attempt generated frames, which was canceled, and which replaced it. If that reproduction reveals a different in-scope defect, make the smallest evidence-backed correction and update the design/review record. Do not implement a SIP subscription guard merely because SIP answer and caller audio are different observations.

## 3. Required startup behavior

Introduce a per-call outbound startup arbiter in the session orchestration layer. It owns only the optional explicit opening; the SDK continues to own normal transcription, end-of-turn detection, response scheduling, interruption, and false-interruption recovery.

Track answer state, current caller-speaking state, whether a nonempty caller turn has been accepted, whether the application has requested its opening, the opening handle if present, and terminal call state. Install observations before session start and before the SIP request so events received while awaiting answer are retained. Identify the intended SIP participant; unrelated room participants must not satisfy answer/startup conditions.

| Observed condition | Required action |
| --- | --- |
| SIP answer succeeds, caller is quiet, no accepted caller turn or opening request exists | Request exactly one engine-authored opening and retain its handle. |
| Caller is speaking when answer completes | Defer the explicit opening while speech is active; continue receiving caller audio and transcripts. |
| A nonempty caller turn is accepted before the opening decision | Let the SDK generate the response from that greeting. Consume the pending opening decision so no extra opening is queued. |
| Provisional speech activity ends without an accepted caller turn | Re-evaluate the pending opening when the user returns to listening. Provisional VAD activity alone must not permanently consume the opening. |
| Caller input arrives after the explicit opening was scheduled or while it plays | Preserve normal SDK interruption. A queued stale opening must be canceled by its own handle when a caller response supersedes it; never use a blanket interrupt that also cancels the new response. |
| Existing false-interruption recovery resumes a handle | Observe the same handle; do not create another opening. |
| Hangup, room/session close, or setup failure | Mark startup terminal, abort pending work through existing cleanup, and suppress all delayed opening/retry/fallback scheduling. |

The check and scheduling decision must be synchronous with respect to the observed state: an `await` between “opening still needed” and requesting it requires another check. A caller's accepted turn wins over a later answer callback. Prove both event orders and the boundary where input arrives immediately after the decision. Do not interpret `SpeechCreated.userInitiated` as “human initiated”: the SDK describes public method usage, and caller-generated replies also travel through generation code. Use the application's explicit-opening wrapper and the accepted-turn hook to establish origin. [Pinned speech event definitions](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/voice/events.ts).

Keep listening during startup. Do not mute/discard the early greeting, disable interruption, add a fixed sleep, repeat canned openings, or inject greeting instructions into the worker's placeholder agent prompt. The existing engine empty-conversation greeting and latest-user/full-transcript composition remain authoritative.

Existing classified error retries and fallback lines remain bounded by `error-map.ts`. Their scheduling must also check that the failed turn still owns the action and the call is live. A late error from superseded speech cannot restart an opening, speak over a replacement, or end a healthy replacement turn. An empty successful generation is recorded as no generated audio; it is not silently represented as a successful audible opening. Do not add an unlimited “retry until heard” loop. If offline evidence reveals an empty-generation liveness defect beyond startup arbitration, resolve it through an explicit bounded failure path reviewed in the implementation plan.

The replacement regression must cross the real HTTP adapter cancellation boundary as well as the SDK boundary. The current adapter calls `abortThread(agentId, threadId)` on premature response close; prove that a delayed close from the predecessor cannot kill a newer admitted/queued request for the same call. If it can, the smallest correction must scope that cancellation to the owning request while retaining immediate cancellation of its own engine work. Stable diagnostic IDs alone do not fix cancellation ownership, and serialization must not wait on audio or optional metric completion.

## 4. Correlation and diagnostic model

### 4.1 Identities

Use these distinct identifiers:

- `callId`: existing room/call identity, scoped with worker process/boot identity where available.
- `speechId`: the SDK `SpeechHandle.id`, allocated and observed at `SpeechCreated`; one record for every opening, caller response, retry, or fallback handle.
- `turnId`: opaque UUID allocated before constructing each `HiveLLMStream`; identifies one bridge request attempt, including cancellation before response headers or text. A fallback `say()` has no bridge turn.
- `engineAttemptSeq`: attempt number inside that bridge request if the adapter executes its existing resume/full-transcript retry. That retry retains `turnId`; another worker request receives a new one.
- `synthesisId`: local opaque identity for an individual TTS stream/segment when needed to associate first generated frames with speech. Several segments may belong to one speech.

Log explicit binding events. One speech may have multiple associated bridge or synthesis attempts; do not flatten retries into the last measurement. An attempt that never entered the LLM node has no `turnId`, which is different from a request whose correlation was lost.

Pass a versioned, optional worker trace object in the request's existing top-level `metadata`, separate from prompt-bearing call metadata. Validate its bounded UUID/schema fields at the authenticated adapter boundary. Missing metadata uses an engine-generated ID and `correlation: legacy`; malformed optional metadata cannot become prompt content or an unbounded log payload. Preserve bridge auth, agent resolution, Vapi request compatibility, SSE text/done framing, and normal error status behavior. No credentials, transcript, destination, or tool arguments enter trace metadata.

### 4.2 Pinned SDK integration proof

The plan's first capability test must execute the real pinned SDK with fake media/providers and establish a reliable join **even when no content chunk is produced**. A viable seam to test is application-owned `AsyncLocalStorage`: allocate the bridge identity in `HiveLLM.chat()` and construct the stream inside that context, so both the base stream's metrics monitor and its request task inherit it. At `MetricsCollected`, combine that immutable context with the SDK's `llm_metrics.speechId`; the SDK attaches speech IDs using its own task context. This avoids requiring a successful chunk's `requestId`, and does not import private SDK internals or alter generation content. [Pinned LLM stream lifecycle](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/llm/llm.ts).

Prove cancellation before `run()`, before HTTP headers, after headers before text, during text, and two overlapping streams. A finalizer still records each bridge attempt if metrics never arrive; record an unbound correlation explicitly and fail the required complete-correlation regression. Source inspection is not the proof. Do not substitute the newest speech, queue order, timestamp proximity, dummy spoken tokens, synthetic provider metrics, or `getActivityOrThrow().currentSpeech` for the actual task identity.

For generated-audio observations, wrap the existing TTS node narrowly: assign a synthesis context before delegating to the default node, observe its first returned frame, and bind its SDK TTS metric to `speechId`. Preserve streaming backpressure, cancellation, timed-transcript metadata, normal text transforms, and the original audio frames. If the pinned SDK does not preserve the proposed context across its event boundary, the plan must provide and prove another explicit association before readiness; a dependency upgrade or SDK patch is a reviewed scope decision, not an assumed workaround.

Use `SpeechHandle` completion and item callbacks for terminal and per-handle conversation observations. `waitForPlayout()` is handle completion, not proof of received handset audio. [Pinned handle lifecycle](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/voice/speech_handle.ts).

### 4.3 Events and outcomes

Emit structured, content-free JSONL through `createLogger`. Introduce a diagnostic schema version so historical rows retain their historical meaning. Register a speech before waiting for EOU, LLM, or TTS. Emit its start immediately, enrich through events, and emit one terminal outcome during orderly operation. Terminal categories are `completed`, `interrupted`, `cancelled`, `failed`, or `incomplete`; generated-audio presence is a separate observation, so completion does not assert audibility.

Keep cancellation cause separate from outcome. Use `framework_cancelled` or `unknown` when that is all the bridge knows. Use `call_closed`, `startup_superseded`, or a classified error only when a direct local observation supports it. Do not relabel all aborts as barge-in, and do not let a cleanup abort erase a preceding observed provider/bridge error. Session-level errors with no speech association remain call-level errors. False interruptions belong to a known speech only when the SDK supplies an explicit association; otherwise preserve them at call level.

Required observations, when available:

| Layer | Events/fields | Meaning |
| --- | --- | --- |
| Call/startup | Session start, SIP answer result, intended participant availability, caller speaking/listening changes, accepted caller-turn event, opening decision and reason, session close | Ordering evidence; not handset audio delivery. |
| Bridge | Request created/started, response status, first nonempty text received, end/error/cancellation, maximum inter-chunk gap, explicit speech binding | Text crossing the bridge, including hold-phrase text. |
| Engine | Request received, first SSE text, all request terminal paths, stage timings and warm/tool fields where returned, each internal retry attempt | Engine work and emitted text; a disconnected request must still end diagnostically. |
| Synthesis | First generated frame, SDK TTFB, stream completion/cancellation/error, synthesis-to-speech binding | Audio was synthesized; it may never have entered playout. |
| Worker playout | Handle-associated assistant item metrics such as `startedSpeakingAt`, interrupted flag, handle completion; output playback events when supported | Server-side output evidence with its exact source recorded. |
| Caller | Separately recorded caller confirmation and its observation time, or `unknown` | Human evidence about what was heard. Never populated from server metrics. |

Output playback events in this SDK do not carry speech IDs. Record them as call-level observations unless an explicit association is proved; do not assign them to whichever speech is currently active. Assistant items obtained through a handle's own item callback can provide associated playout metrics. An interrupted handle can commit no item at all, so absent item/text is `unknown` playout, not zero playout. The standard room output emits playback start around pushing the first frame into its local audio source; this still cannot establish PSTN receipt. [Pinned output implementation](https://github.com/livekit/agents-js/blob/%40livekit%2Fagents%401.6.4/agents/src/voice/room_io/_output.ts).

Each event includes UTC wall time, component/clock origin, and stable IDs. Use monotonic durations within a process. Cross-process UTC ordering must preserve observation uncertainty; do not subtract unrelated monotonic clocks. Use nullable measurements plus a reason (`not_reached`, `not_applicable`, `not_observed`, or `correlation_missing`). Never coerce an unknown to zero. Optional text-length/frame-count fields are sufficient; do not log transcript text or audio payloads.

### 4.4 Finalization, aggregation, and compatibility

Replace the single pending EOU and shared `lastTurnTiming` join with records keyed by identity. Bind any order of EOU/LLM/TTS/terminal events, including late metrics for a canceled prior speech. Emit late supplemental observations under their original ID without producing another terminal attempt or modifying another speech's timing. Capture bridge/engine terminal records in `finally` or equivalent one-shot finalization covering prompt/session lookup failure, admission failure, no-content completion, SSE failure, and client disconnect.

Finalize open worker attempts before `CallStats.flush()` and Mongo shutdown. Repeated close/error/shutdown callbacks must be idempotent. Teardown cannot wait indefinitely for missing metrics or dead output; unfinished observations remain incomplete. Starts without terminals after abrupt process loss are reconstructed as incomplete by the diagnostic reader, not as completed calls. Logging/storage errors must not crash media handling, and summary failure must not be reported as successful persistence.

Keep memory bounded: stream diagnostic events to logs, retain only active correlation state and a bounded recent-terminal cache, and release listeners/context/records on teardown. The implementation plan must name the cache bound and behavior for overflow; eviction emits an explicit diagnostic gap and never silently changes correlation. Call summaries store aggregate counts rather than unbounded event arrays.

Extend `voice_call_stats` with schema version, speech-attempt counts by terminal outcome, bridge-attempt counts, generated-audio/known-playout counts, and incomplete/unbound counts. Interruption counts come from handle outcomes, including empty-text cancellations, rather than solely committed assistant messages. Preserve the existing summary's first-terminal-call-outcome rule and clarify any legacy fields retained for compatibility.

Define measurement denominators explicitly. The historical `totalToFirstAudioMs` is an EOU + bridge/LLM TTFT + TTS TTFB estimate, not a measured handset time; a new version must label it as an estimate and compute it only from components belonging to the same attempt. Openings have no EOU and therefore no such value. Canceled/failed/missing attempts remain counted and are excluded with reasons from successful-response distributions. Do not change a historical baseline artifact or silently feed incomplete rows into its success-only harvester. KPR-465 consumes the versioned events and denominators for its comparisons.

## 5. Regression and acceptance contract

Use injected SIP/room boundaries, deterministic caller input, fake STT/TTS, a controlled bridge server, fake clocks where appropriate, and the real pinned SDK for the lifecycle integration seam. These tests must not load instance secrets, dispatch a real room, place calls, or contact production services. No production log harvest is performed during drafting.

| ID | Required case | Passing evidence |
| --- | --- | --- |
| S1 | Quiet answer | Exactly one explicit opening; bridge text → generated frames → observed fake output; one terminal handle. |
| S2 | Early greeting before answer resolves, greeting during answer completion, and accepted greeting before the opening decision | Greeting is preserved, the SDK produces its response, and the explicit opening is suppressed. No queued stale speech remains. |
| S3 | Input immediately after opening scheduling, before first bridge text, before first frame, and during playout | Normal interruption cancels/supersedes only the old attempt; the replacement progresses without waiting for another caller utterance or a new fixed guard. Each attempt has its own terminal evidence. |
| S4 | Provisional speaking state with no accepted transcript; false interruption | Pending opening is not permanently lost; resumption does not duplicate an opening. Test actual SDK event ordering rather than only a hand-written state reducer. |
| S5 | Hangup before answer, while awaiting bridge response, while synthesizing, and during replacement | No late opening, retry, fallback, engine write, or frame delivery after closure; open records become accurately canceled/incomplete and cleanup finishes. |
| S6 | Startup bridge rejection, delayed error from superseded speech, midstream error, TTS failure, empty generation | Correct failure/cancellation classification; bounded existing fallback behavior; old failures cannot cancel or replay over the replacement; no-content is visible. |
| S7 | Missing EOU/TTS, no first token, overlapping streams, reordered/late/duplicate events, multiple TTS segments | No dropped attempts or cross-turn timing; explicit IDs across worker/engine; null measurements and incomplete counts remain honest; terminal records/counts are one-shot. |
| S8 | Adapter legacy/Vapi and interrupted cold/warm requests, including an old response closing after its replacement arrives | Optional trace metadata preserves compatibility, auth and response framing; complete terminal diagnostics on failures and disconnects; predecessor cancellation cannot abort the replacement; existing warm-lease and tool-ack behavior is unchanged. |
| S9 | Diagnostics/privacy and cleanup | No transcript, phone, destination, token, tool arguments, or audio bytes in new records; bounded retention; deterministic counts; process-loss gaps and write failures are visible. |

The fixtures must demonstrate progression, not merely that `generateReply()` was invoked: deliver known generated frames to the fake output and settle the replacement handle. With controlled providers, no unresolved startup flag, canceled predecessor, or missing optional metric may gate that progression. Runtime test timeouts detect hangs; they do not establish a product latency target. Record the observed causal sequence that fails before the fix and passes afterward. Run relevant worker/adapter integration suites and `npm run check` during delivery; no new test is needed merely to assert this Markdown file exists.

## 6. Controlled live startup validation and handoff

After regressions and reviewed implementation pass, prepare a sanitized startup evidence record at `docs/epics/kpr-462/kpr-464-startup-evidence.md`. Record the actual engine/worker revisions and dependency pins, configuration flags, agent/model/voice, UTC clock basis, fixture results, and an explicit hypothesis-versus-observation table. Use KPR-463's supported deployment and running-identity evidence when available; do not repoint services from this child to a development worktree or infer deployment success from source changes.

May's explicit go is required to execute a controlled call. The live script must include a quiet answer, an immediate “hello,” a greeting while the opening begins, replacement speech, and hangup during startup. It may use the smallest set of authorized calls that exercises those scenarios, recording repeats and failures rather than excluding them. The record must identify call/speech/turn IDs, worker observations and missing stages, and May's confirmation of the first audible words, duplicate/stale speech, and any prolonged unexplained silence. Caller feedback is recorded separately from machine timestamps; an approximate recollection is not an exact handset timestamp.

A pass requires an audible opening **or** appropriate audible response to the early greeting, preserved interruption, no duplicate stale speech, and complete accounting for observed canceled attempts. Without caller confirmation, audibility is unknown. Without a supported causal reproduction, do not declare a SIP race or any other handset root cause proven. No arbitrary numeric latency target is approved here; KPR-465 defines its metrics, sample sizes, targets, and treatment comparisons.

If live execution is pending, report `implementation/regressions verified; live startup acceptance pending`. This ticket's acceptance is not complete until the controlled caller-confirmed validation passes. KPR-466 repeats the scenarios on the final integrated deployment and combines them with tool, hangup, latency, and restart/rollback evidence. A KPR-464 test does not close KPR-321 telephony operations or the reserved vendor Phase 1.

## 7. Scope and delegated assumptions

Expected implementation surfaces are `session.ts`, `hive-llm.ts`, `telemetry.ts`, focused worker helpers/tests, the voice adapter and optional request trace typing, and a small read-only diagnostic reducer/evidence format. Keep the reducer narrowly focused on IDs, event ordering, completeness, and measurement definitions; no dashboard, tracing service, raw-call recording platform, or broad telemetry migration is required.

- **Non-blocking, delegated:** caller-turn precedence with one optional explicit opening is the intended product behavior; a relevant early-greeting response satisfies opening acceptance.
- **Non-blocking, delegated:** versioned content-free logs plus aggregate call summaries are sufficient persistence for this child; abrupt-loss gaps remain explicit.
- **Non-blocking, plan prerequisite:** the pinned-SDK context propagation, TTS wrapper metadata/cancellation, and startup event-order capabilities require offline proof before implementation readiness. Failure requires a reviewed design adjustment, not a guessed join.
- **Non-blocking, evidence-dependent:** startup scheduling contention and telemetry loss are concrete test targets; their relationship to September 7 handset silence remains uncertain.
- **Blocking for live execution only:** May's call go and a verified running build/configuration. No live authorization is inferred from Gate 1 delegation or this specification.

There are no blocking human product questions. This document is a draft specification, not signoff, implementation, or acceptance evidence.
