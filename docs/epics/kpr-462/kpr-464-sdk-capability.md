# KPR-464 offline capability evidence

This records capability observations and their limits. It is not implementation verification, caller acceptance, or approval to deploy/place calls. Specification revision after `caught-by: plan-review/1/fable` changes the required contract to preserve all attempts and explicitly unavailable associations; it does not turn missing public SDK capability into a proved binding. The [current plan's Task 0](./kpr-464-plan.md#task-0-finish-exact-artifact-offline-capability-proof-before-readiness) has not been revised in this pass and is not a readiness claim. The revised [specification §4.2](./kpr-464-spec.md#42-pinned-sdk-integration-proof) separates test-local prerequisite proof from post-implementation product regressions.

## Exact artifact and runtime

- Repository HEAD for the initial documentation/probe run: `8d0dcfeef8756305df0aefc25d8f019f2fa51587`.
- Repository HEAD during this revision's worktree re-executions: `5bf114e0855034fc3550303f9428a02284ee9c44` (uncommitted documentation/probe revisions only).
- Repository `package-lock.json` SHA-256: `197bbe521ff1ff5000d8ad0586dc0765e013d770e6588b909e4e7c3e9b3f1089`.
- `@livekit/agents`: `1.6.4`; npm tarball SHA-512 verified against that lock: `sha512-Q+qlXmR8wLB4aMm2K5bt1ijItuMcoyfHvAHp047ORf2+yhIwR6csKfo95ErPbszWzgnLf7nIGSvJjvNVSh9okA==`.
- `@livekit/rtc-node`: `0.13.33`.
- Re-executed documentation probes: Node `v24.16.0`, macOS `darwin`, `arm64`; the initial, full-session/default-node, startup, and revision-seams commands below each exited 0 in this revision.
- Artifact source: [pinned npm tarball](https://registry.npmjs.org/@livekit/agents/-/agents-1.6.4.tgz). The same-version GitHub tag is not used as artifact identity proof.

Initial durable source: [SDK probe](./probes/kpr-464-sdk-probe.mjs). Preserved initial stdout: [SDK results](./probes/kpr-464-sdk-results.json). The source contains assertions on the observations listed below; a mismatch exits nonzero. It uses no instance config/secrets, real room, SIP call, remote provider or Mongo. Fake STT/LLM/TTS use the installed SDK provider/session classes. The full and startup probes supplied to this revision are now durable, with only their import resolution changed to default to the worktree installation; their original stdout is preserved separately from this revision's fresh stdout.

Reproduction after `npm ci` with the repository lock and Node 24:

```bash
node docs/epics/kpr-462/probes/kpr-464-sdk-probe.mjs
node docs/epics/kpr-462/probes/kpr-464-sdk-full-probe.mjs
node docs/epics/kpr-462/probes/kpr-464-startup-probe.mjs
node docs/epics/kpr-462/probes/kpr-464-revision-seams-probe.mjs
```

An optional first argument selects an isolated npm runtime directory containing `node_modules`. The recorded authoring run used the verified scratch runtime:

```bash
/opt/homebrew/opt/node@24/bin/node docs/epics/kpr-462/probes/kpr-464-sdk-probe.mjs /Users/mokie/github/hive-epic-kpr-462/.dodi/sdk464-probe/runtime
```

That scratch path is not required to reproduce any checked-in source; use the normal worktree `npm ci` installation. This revision ran all four commands with `/opt/homebrew/opt/node@24/bin/node` and no runtime argument, using the existing worktree `node_modules`. Do not create runtime/deployment dependency links to the scratch directory.

## Executed observations

| Probe | Observation | Limit |
| --- | --- | --- |
| Direct LLM close before run, before modeled headers, after modeled headers/no text, during text | Six stream monitors retain their distinct app ALS turn IDs; first three canceled metrics have empty provider request ID and TTFT `-1`. | The phase barriers are fake-provider gates, not real HTTP; only the first three genuinely have no content. |
| Two direct streams overlap/reverse settlement | Each metric retains its own turn ID even though provider request ID is the same. | This is no proof that arbitrary SDK metrics carry app context outside this seam. |
| Full AgentSession no-content generation | Session metric's speech ID equals the actual SpeechHandle ID and coexists with app ALS turn ID. | The probe does not execute all direct cancellation phases inside a full audio session. |
| Handle-specific interrupt and replacement | First handle interrupted, replacement completes, both real session metrics retain correct distinct speech/turn IDs. | No real Hive HTTP adapter, synthesized audio or handset receipt in this case. |
| Initial fake STT accepted caller turn | Public `Agent.onUserTurnCompleted` observes nonempty input before `SpeechCreated` in the tested STT final-transcript/end-of-speech path, with no VAD or preflight transcript. | This is configuration/input-specific, not a universal hook-before-handle guarantee; see the reconciled preemptive-generation paths below. |
| TTS stream wrapper | First frame object identity and copied timed metadata remain intact; normal metric retains synthesis ALS ID. | The probe reconstructs the default-node body; it does not call actual `Agent.default.ttsNode` inside a real session. |
| TTS cancellation before first frame | No TTS metric is emitted. | There is no speech association supplied by such a metric. Explicit finalizer/unbound evidence is necessary; never synthesize metrics or infer a speech ID. |

The application must use the public accepted-turn hook, not a nonexistent accepted-turn session event or `ConversationItemAdded`. The hook is an accepted-input observation, not a caller-handle identity. Use public `addDoneCallback`/`chatItems` for settlement/item evidence; those surfaces alone do not prove provider success. The probe's SDK handle interruption result supports canceling the known stale opening's own handle, rather than interrupting the session's current replacement.

## Full-session and default-node follow-up

Sources: [full probe](./probes/kpr-464-sdk-full-probe.mjs), [startup probe](./probes/kpr-464-startup-probe.mjs). Preserved supplied results: [full original](./probes/kpr-464-sdk-full-original-results.json), [startup original](./probes/kpr-464-startup-original-results.json). Fresh worktree stdout: [full results](./probes/kpr-464-sdk-full-results.json), [startup results](./probes/kpr-464-startup-results.json). The copied source assertions and report fields retain their original semantics; the limits below control interpretation of those fields.

- The full-session LLM cases retain application turn context together with the actual handle ID in real SDK metrics for cancellation before modeled provider work, before modeled headers, after headers/before text, during text, and empty success. Its case named `before-run` actually enters `run()` and waits at an application provider-work gate; the initial direct-stream probe separately calls `close()` before `run()` executes. These are fake-provider phases, not a real HTTP matrix.
- The full overlap case uses two independent real sessions settling in reverse; it does not prove two concurrent turns in one session. The initial probe separately covers same-session interruption/replacement. Neither replaces the product's real adapter/manager cancellation regression.
- Actual `Agent.default.ttsNode` preserves the original frames and `USERDATA_TIMED_TRANSCRIPT` metadata, and a normal TTS metric retains the enclosing synthesis ALS context. Canceling its reader before a frame and after a frame closes the fake provider stream; both cases emit zero additional TTS metrics. The full probe's real-session `say()` delivers an original generated frame to fake output. Its node/output callbacks expose no public speech ID; holding the `say()` handle elsewhere does not create that missing association.
- The thrown LLM case settles its handle with no public exception and a non-cancelled LLM metric. Error reports normalize absent `exception()` to JSON `null` (the revision probe observed `undefined` from the method). TTS failures before/after a frame emit public provider error events, while default-node readers can complete normally. Neither metric presence nor normal reader/handle completion is sufficient evidence of successful generation.
- The startup probe observes provisional speaking/listening without accepted input, cancels a known opening handle, sends replacement frames to fake output, and observes a false-interruption event with `resumed: true`. It manually generates the opening/replacement and models the SIP boundary; it does not exercise a Hive startup arbiter or SIP answer callback. Its `acceptedHookBeforeCallerResponse` assertion compares the hook to a later LLM metric after explicitly holding the fake stream; it does not measure first bridge text or establish universal hook-before-content ordering.

## Reconciled caller ordering and causal error observations

Source: [revision-seams probe](./probes/kpr-464-revision-seams-probe.mjs). Fresh stdout: [revision-seams results](./probes/kpr-464-revision-seams-results.json). This independent test-local probe uses public provider/session APIs and the actual default TTS node. Its first run exposed an assertion bug (`exception()` was `undefined`, while prior JSON reports normalize it to `null`); the assertion now checks nullish absence, and the complete rerun exited 0. No production code or provider configuration changed.

| Scripted input/configuration | Observed causal order |
| --- | --- |
| STT detection, preemptive enabled, final transcript + end-of-speech only | Accepted hook enter/return → speech created → LLM text → fake output frames. |
| VAD detection, preemptive enabled, final transcript while speaking | Speech created → speculative LLM text → accepted hook enter/return → fake output frames. |
| VAD detection, preemptive disabled in this comparison fixture | Accepted hook enter/return → speech created → LLM text → fake output frames. |
| STT detection, preemptive enabled, preflight transcript before final/end-of-speech | Speech created → speculative LLM text → accepted hook enter/return → fake output frames. |

All four fixtures hold the accepted hook open and assert no output frames until it returns. They use `preemptiveTts: false`; they deliberately permit preemptive LLM text before accepting the turn. This reconciles the initial STT probe and the later VAD probe without changing either observation. Source inspection of the installed, lock-matching artifact explains the paths:

- `dist/voice/turn_config/preemptive_generation.js`: defaults are `enabled: true`, `preemptiveTts: false`. Hive `session.ts` sets STT detection for Flux and VAD detection otherwise, leaving these defaults in force.
- `dist/voice/audio_recognition.js`: a changed final transcript calls `onPreemptiveGeneration` for VAD-based detection/committed turns; a preflight transcript can call it in STT mode too.
- `dist/voice/agent_activity.js`: `onPreemptiveGeneration` creates a reply with `scheduleSpeech: false`, which emits `SpeechCreated` and can start LLM work. `userTurnCompleted` awaits `onUserTurnCompleted` before admitting/reusing that handle or creating a non-preemptive reply. The pipeline waits for scheduling before ordinary synthesis with `preemptiveTts: false`, and output waits for authorization.

Thus the supported hook guarantee is before admission of the accepted response to output, not before every handle or speculative bridge token. Startup state must consume the pending opening at that hook regardless of whether a caller handle already exists. No assignment to the next/latest handle follows from hook ordering.

The revision probe also records an application-owned LLM error under its immutable turn context before the SDK public error, metric, and handle-done callback. A synchronous public TTS error listener retains the application synthesis context created around the actual default node. For failures both before and after a frame, that error precedes the node observer's terminal, which is `failed` even though the reader completes normally. The failed synthesis remains explicitly unbound to speech. The small observer uses one upstream read per pull with no added utterance queue; this is evidence for that test-local observer, not a bound on the SDK's internal producer queues or verification of a future production wrapper.

## HTTP ownership reproduction

Durable source: [HTTP reproduction](./probes/kpr-464-http-reproduction.test.ts), [isolated Vitest config](./probes/vitest.config.ts). The independent HTTP probe's reported command exited 0, 1 file/1 test passed in 130 ms, against the same baseline adapter source. Its original command used the development Vitest executable and isolated scratch configuration; this writer copied the source with only repository-relative import adjustment and did not claim a second HTTP test execution.

After worktree `npm ci`, reproduce with:

```bash
npx vitest run --config docs/epics/kpr-462/probes/vitest.config.ts --reporter=verbose
```

The test starts the real VoiceAdapter with a stub coordinator on an authenticated loopback HTTP connection. It holds the predecessor's registered `ServerResponse.close` callback, destroys that client socket, admits a same-call replacement, then releases the held callback. The adapter calls `abortThread(agentId, threadId)` with no request identity; the stub coordinator necessarily selects the replacement as current work and cancels it.

This proves the unsafe adapter API/order. It does **not** prove the exact cold/warm manager implementations' scheduling. The required implementation regression composes the real adapter with real AgentManager/WarmVoiceSession and fake providers, asserting predecessor cancellation cannot cancel queued/active replacement work and the replacement progresses to normal text/frame completion. The selected plan correction is a request-owned AbortSignal carried through TurnContext; it expresses the same required ownership without adding a global ID lookup/cancel map. Existing abortThread semantics remain available to other callers.

## Revised contract and remaining gate evidence

The supplied full-probe JSON's `unproved` entries describe failures of the prior universal-correlation/backpressure/error-inference contract. The specification now records their resolution explicitly: every speech/bridge/synthesis attempt survives; public metrics enrich real bindings when available; missing synthesis associations remain unbound; application error observations precede terminal classification; and wrapper streaming/cancellation is preserved without claiming inaccessible queue bounds. The supplemental error probe proves the local causal observation seam, not universal speech attribution. No SDK upgrade, patch, private identity lookup, or inferred binding is selected.

Before plan readiness, reconcile the plan's retained findings and finish any required **test-local** capability gaps in the chosen wrapper/error/finalization design: normal TTS metric enrichment with both synthesis context and SDK speech ID, overlapping synthesis error isolation, the observer's own cancellation/cleanup behavior, and handling unavailable/late associations without premature success. Use the actual default node and fake providers; do not require a not-yet-implemented production collector or startup arbiter as a prerequisite for planning. A TTS stream without a metric is expected to remain unbound, and missing optional enrichment must not gate output or teardown.

After implementation, run the specification's product regressions against the real Hive startup and HTTP/manager boundaries, including request-owned predecessor cancellation, replacement progression, diagnostics aggregation, bounded retention, shutdown, and preserved compatibility. Existing probes do not establish those product requirements, the implemented fix, or plan readiness.

No SIP, live call, handset confirmation, deployment or historical root cause was established by these probes.
