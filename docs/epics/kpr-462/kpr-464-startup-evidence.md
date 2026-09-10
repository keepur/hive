# KPR-464 startup integration evidence

## Scope and runtime

This is deterministic offline evidence for the KPR-464 startup and cancellation contract. It uses Node 24.16.0, `@livekit/agents` 1.6.4 from the lockfile tarball, and `@livekit/rtc-node` 0.13.33. The progression fixture runs the real public `AgentSession`, production `StartupArbiter`, `StartupActionOwnership`, `SpeechTrace`, `HiveLLM` where HTTP is required, and `TracedAgent`. Synthesis passes through `Agent.default.ttsNode` into controlled TTS and fake audio output. Named barriers control request, synthesis, and playout boundaries; the test timeout only detects a stuck fixture and is not a product latency target.

No vendor API, SIP trunk, deployment, or live call was used. Fake output proves which frames crossed the worker output boundary. It does not establish handset audibility. `callerConfirmation` remains `unknown` in this evidence.

## Baseline ordering reproduction

The test-only baseline follows the removed ordering exactly at its application boundary:

1. `early_greeting_accepted_while_answer_pending`
2. first public `speech_<id>` created and controlled HTTP returns `BASELINE_EARLY`
3. `sip_answer_resolved`
4. unconditional post-answer `generateReply()` creates a second public `speech_<id>`
5. controlled HTTP returns `BASELINE_OPENING`

There are exactly two HTTP requests and two SDK handles. Both known frames reach fake output in this controlled schedule, and neither handle is reported interrupted. The baseline therefore proves duplicate scheduling in that ordering. It does not prove the cause of the September 7 handset behavior and does not invent an interrupted or no-content outcome.

The corrected cases route the same early-input precedence through the production arbiter. A nonempty final remains pending across listening and answer until the accepted hook consumes startup ownership. Only the caller response handle is created, the engine request retains `early hello sentinel`, and `S2_CALLER_REPLY` reaches fake output.

## Scenario coverage

| Case | Deterministic scenarios and assertions |
| --- | --- |
| S1 quiet | `s1-quiet`: answer requests one application opening; one LLM attempt, one default-node synthesis stream, one public handle, and `S1_OPENING` reaches fake output. |
| S2 early hello | `s2-before-answer`, `s2-during-answer`, and `s2-accepted-before-decision`: final-pending survives listening before the hook; no opening decision is requested; the caller transcript remains in the LLM chat context; `S2_CALLER_REPLY` reaches output. |
| S3 immediate | `s3-before-text`, `s3-before-frame`, and `s3-during-playout`: the exact opening handle is interrupted; exactly one replacement is created; `S3_REPLACEMENT` reaches output without another caller utterance. No old frame appears after cancellation. The during-playout row truthfully retains the one old frame that reached output before acceptance. |
| S4 provisional and false interruption | All 22 named production-arbiter rows `S4-01` through `S4-22` run without skips. Rows 01–10 hold observed final input through acceptance and create one caller response. Rows 11–18 release absent/interim/empty/preflight-only activity at listening and create one opening. Rows 19–22 cancel one held opening and deliver one caller replacement. Exact-EOU tests retain immutable creation epoch/serial, admit preemptive A even when a newer application opening exists, preserve `EOU(A) -> hook B -> EOU(B)`, and ignore duplicate/late EOU(A). The pinned SDK suite separately exercises STT/VAD/preflight event order and actual false-interruption resume on the original handle. |
| S5 hangup | Named barriers close during fetch, TTS before frame, TTS after frame, and replacement. No frame appears after close; recovery and application registries end empty. Supplemental production-session rows cover disconnect while start is pending, in-flight pre-start close, late start rejection, answer suppression, and bounded late close; no SIP work is created after terminal state. |
| S6 failures | Loopback Hive HTTP covers rejection, midstream body failure, and empty 200 success. Application error precedes public handle terminal even when the SDK handle has no exception. Empty success has one completed bridge attempt, zero text, zero synthesis, and zero output. `error-before-hook` and `accepted-before-binding` authorize exactly one recovery only after exact binding plus genuine EOU, with `S6_RECOVERY` reaching output without another utterance. Distinct admitted B never recovers speculative A. Accepted input interrupts already-queued retry and fallback handles and delivers `ACCEPTED_REPLACEMENT`. Retained post-routine and prior-abort cases cover binding conflict and actual 257-entry eviction; stale retry/fallback frames remain absent and unrelated successors reach output. The supplemental suites cover bounded retry/fallback policy, fourth-error routing, delayed binding, stale errors, and TTS failure before/after a frame. |
| S7 diagnostics | Opening-without-EOU cancellation records the explicit opening speech ID. Its metric-free synthesis terminal remains unbound with `speechId: null`, while local frame count and cancellation terminal remain accurate. The pinned SDK suite covers genuine normal metric enrichment, no-metric cancellation before/after frame, reverse overlapping failures, late/duplicate binding, and timed multi-segment frames. Supplemental trace tests cover overlapping bridge/synthesis contexts, reverse metrics, multi-segment ambiguity, and one-shot terminal totals. |
| S8 adapter | Loopback production `VoiceAdapter`/`AgentManager` cold and warm tests close a predecessor after a successor is active or queued. Each successor completes independently; the real `HiveLLM` + default-node fake-output row reaches an audio frame. Bridge auth behavior, SSE `[DONE]`, and missing trace metadata with `correlation: legacy` remain accepted and diagnosed. |
| S9 cleanup/privacy | The fixture records incomplete startup/process-loss state, filtered and failed asynchronous writes, registry cleanup, and writer settlement without throwing. Supplemental production-session tests retain shutdown ordering through trace/log and Mongo failures. Bounded 257-entry speech, bridge, synthesis, pending-error, recent-binding, and application-handle paths are covered. Diagnostic rows contain no transcript, phone, destination, token, tool, or audio payload fields. Controlled servers, SDK sessions, TTS readers, abort listeners, and gates are closed in finalizers. |

## Retained recovery follow-through

The Task 6 schedules are repeated with real public SDK handles and fake output:

- Post-routine retry: admitted failed origin schedules an unfinished `generateReply()` behind a named text/frame gate; the recovery routine leaves `activeRecovery` while its handle remains retained. Binding conflict or true 257-entry recent eviction synchronously marks one `action_ownership_unproved` gap and interrupts the exact retry. Releasing the gate produces no `STALE_RETRY`; a separate `HEALTHY_SUCCESSOR` completes. Duplicate valid binding is the control and permits `VALID_RETRY` to reach output.
- Prior-abort fallback: admitted failed origin schedules a public `say()` behind a first-frame gate. A speculative SDK creation aborts the continuation, its routine exits, and the unfinished fallback remains retained. Later conflict or true eviction fires the separate invalidation latch once and interrupts that fallback. Releasing the gate produces no `STALE_FALLBACK`; the unrelated `SPECULATIVE` successor completes.
- Prior-abort valid control: duplicate unchanged binding does not fire the invalidation latch or restore chain authority. The retained fallback remains uninterrupted and both `VALID_FALLBACK` and its unrelated successor reach output.

Each invalidation row checks one gap for the original speech/turn IDs, no stale frame, no revival on repeated notification, empty retained-handle state after settlement, and continued unrelated output. Unit coverage supplies the same-map/multiple-reference union, overflow, recorder-close, call-cleanup, and late-original-metric permutations.

## Commands and results

Starting implementation head: `9c5f80e081da3843a1ab3cd4592fd3dc33dbaf51`.

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run src/voice-worker/startup.integration.test.ts src/voice-worker/sdk-capability.integration.test.ts src/channels/voice/voice-startup.integration.test.ts --reporter=verbose` — exit 0; 3 files, 112 tests passed, 0 skipped. Log: `.dodi/kpr464-task7-required.log`.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run src/voice-worker/startup-arbiter.test.ts src/voice-worker/session.test.ts src/voice-worker/hive-llm.test.ts src/voice-worker/speech-trace.test.ts src/voice-worker/error-map.test.ts src/voice-worker/tts-normalize.test.ts --reporter=dot` — exit 0; 6 files, 106 tests passed. Log: `.dodi/kpr464-task7-supplemental.log`.

## Offline reader evidence record

The reader uses only caller-selected schema-v2 JSONL and explicit IDs. `kpr-464-complete.jsonl` produces a complete report with 2 speech attempts, 1 bridge attempt, 2 synthesis attempts, 1 engine request, 1 engine attempt, no unbound or incomplete entities, and one `estimatedEouToFirstGeneratedAudioMs` stage-sum sample of 60 ms. `kpr-464-diagnostics.jsonl` intentionally produces an incomplete report with 4 speech attempts, 2 bridge attempts, 3 synthesis attempts, 7 engine requests, 5 engine attempts, 6 incomplete entities, and a two-row logging gap. Its successful replacement is excluded from the estimate as `ambiguous_components` because it has two distinct TTS segment metrics. Duplicate event IDs are idempotent; the late bridge and synthesis bindings fill identity without changing attempt or terminal counts.

| scenario | build/pins | call/speech/turn IDs | observed causal sequence | generated audio | worker playout source | caller confirmation | missing observations | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| quiet opening without EOU | Task 8 tree based on `f218175`; Node 24.16.0; LiveKit 1.6.4 | `call-fixture` / `speech-opening` / no bridge | speech start → synthesis start/bind/metric/frame/terminal → speech terminal | yes, one bound synthesis frame | speech terminal `knownPlayout` | `unknown` | EOU is not applicable to an opening | pass; excluded `not_applicable` |
| successful caller replacement | same | `call-fixture` / `speech-replacement` / `turn-replacement` | explicit bridge and synthesis bindings → EOU 10 ms → bridge first text 20 ms → TTS TTFB 30 ms → frame/playout → terminals | yes | `media_output` plus speech terminal | `unknown` | none | pass; 60 ms stage sum |
| canceled empty opening and pre-header bridge | same | `call-diagnostics` / `speech-cancelled-empty` / `turn-preheader` | bridge created → canceled before header/text → opening terminal canceled with zero text/audio | no | none | `unknown` | bridge-to-speech binding absent | pass; retained in canceled/unbound denominators |
| fallback `say()` without bridge | same | `call-diagnostics` / `speech-fallback` / no bridge | speech start → synthesis start/bind/frame terminal → speech terminal | yes | no separate output row | `unknown` | bridge and EOU are not applicable to fallback | pass; excluded `not_applicable` |
| two TTS segments with late bindings | same | `call-diagnostics` / `speech-replacement` / `turn-replacement` | bridge/synthesis terminals precede explicit late bindings; two distinct TTS metric event IDs share timestamp/value | yes | speech terminal `knownPlayout` | `unknown` | unique TTS segment cannot be selected | pass; excluded `ambiguous_components` |
| unbound synthesis | same | `call-diagnostics` / no speech / no turn | synthesis start → canceled terminal, with no binding | no | none | `unknown` | speech association | pass; retained as unbound synthesis |
| abrupt process loss | same | `call-diagnostics` / `speech-abrupt-loss` / no turn | speech start → logging gap → EOF | unknown | none | `unknown` | speech terminal | expected incomplete: `process_loss_or_missing_terminal` |
| engine success | same | `call-diagnostics` / no joined speech / `engine-success` | request received → attempt 1 start/terminal → request terminal carrying sequence 1 | unknown | not applicable | `unknown` | explicit worker bridge binding | pass; one request and one attempt, no double terminal |
| engine preparation failure | same | `call-diagnostics` / no joined speech / `engine-prep-failure` | request received → failed request terminal | unknown | not applicable | `unknown` | no adapter attempt was reached | pass; one request, zero attempts |
| engine outer retry | same | `call-diagnostics` / no joined speech / `engine-retry` | request received → failed attempt 1 → completed attempt 2 → completed request | unknown | not applicable | `unknown` | explicit worker bridge binding | pass; one request and two independently terminal attempts |
| engine missing lifecycle observations | same | `call-diagnostics` / no joined speech / `engine-request-loss`, `engine-request-missing-start`, `engine-attempt-loss`, `engine-attempt-missing-start` | starts or terminals occur independently before EOF | unknown | not applicable | `unknown` | request/attempt start or terminal according to row | expected incomplete with distinct entity/reason counts |
| authorized live quiet/early-greeting/replacement checks | pending Task 9 deployment identity and explicit go | pending | pending | pending | pending | pending | all handset observations | pending |

Task 8 verification on the final pre-commit tree:

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run src/voice/voice-diagnostic-reader.test.ts --reporter=verbose` — exit 0; 1 file, 13 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/read-voice-diagnostics.ts --input docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl --call-id call-fixture` — exit 0; complete report and one 60 ms eligible stage-sum sample.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/read-voice-diagnostics.ts --input docs/epics/kpr-462/fixtures/kpr-464-diagnostics.jsonl --call-id call-diagnostics` — exit 1 as designed; 6 incomplete entities and 2 diagnostic gaps.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run src/voice-worker/startup.integration.test.ts src/voice-worker/sdk-capability.integration.test.ts src/channels/voice/voice-startup.integration.test.ts --reporter=verbose` — exit 0; 3 files, 112 tests passed, 0 skipped.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH SLACK_APP_TOKEN=xapp-test SLACK_BOT_TOKEN=xoxb-test npm run check` — exit 0; typecheck, lint, formatting, and 198 test files with 4,178 tests passed. Existing repository lint warnings remain non-fatal.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build` — exit 0.

## Limits

The controlled fixture establishes application scheduling, request cancellation, generated-frame forwarding, public-handle settlement, exact correlation, and bounded teardown. It does not measure PSTN/SIP timing, provider latency, speaker playback, human perception, or caller confirmation. The process-loss row models a missing terminal as incomplete; it is not an operating-system crash test. These constraints preserve the separation between Task 7 offline regression evidence and later authorized deployment/live acceptance work.
