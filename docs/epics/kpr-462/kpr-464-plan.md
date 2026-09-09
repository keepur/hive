# KPR-464 — Audible startup and correlated speech evidence implementation plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan after the capability and plan gates pass.

**Goal:** Make one outbound startup decision, preserve the caller's early greeting and normal interruption, and account for every speech/bridge attempt without claiming server observations prove handset audibility.

**Architecture:** An application-owned startup arbiter observes the SDK's accepted-user-turn hook and only owns the optional explicit opening. A versioned event recorder joins independently allocated bridge/synthesis IDs to SDK speech IDs through proved context propagation, with one-shot attempt finalizers. The HTTP adapter carries a request-owned cancellation signal into cold admission and warm turn consumption so a predecessor's delayed disconnect cannot abort its replacement.

**Tech Stack:** TypeScript/ESM, Node 24, Vitest, `@livekit/agents` 1.6.4, `@livekit/rtc-node` 0.13.33, existing Deepgram/Cartesia pipeline, Node HTTP/SSE and AsyncLocalStorage, existing Mongo call summaries.

**Authority:** [Approved specification](./kpr-464-spec.md); Gate 1 delegates maturation; the user has authorized dodi-dev as the replacement for the unavailable `/spec-and-implement` entry point. There is no Decision Register — Canon section in this pre-register epic. KPR-320 is merged. KPR-463 owns deployment, KPR-465 owns comparisons/tuning, KPR-466 owns integrated acceptance. This plan authoring session changes documentation only.

**Readiness:** DRAFT — not implementation-ready until Task 0's executed capability matrix is complete and this plan passes independent review. A partial probe or inspection of SDK source is insufficient. Live execution has a separate explicit-go prerequisite. None of the checkboxes below claims work already executed.

## File map and execution order

This is one coupled startup/correlation change, divided into review chunks to keep each below 1,000 lines. Each chunk has its own focused verification; shared files are edited serially. All paths below are repository-relative to the delivery worktree, not deployment paths.

| Path | Responsibility |
| --- | --- |
| `src/voice/voice-trace.ts` | Shared trace schema, bounded metadata validation, safe event writer and monotonic measurements; no worker SDK imports. |
| `src/voice/voice-trace.test.ts` | Schema/privacy/metadata validation. |
| `src/voice-worker/speech-trace.ts` | Call-local speech/bridge/synthesis registry, binding, terminal evidence, bounded retention and aggregate counts. |
| `src/voice-worker/speech-trace.test.ts` | Reordering, duplicate/late observations, overflow, null semantics and cleanup. |
| `src/voice-worker/trace-context.ts` | Separate bridge and synthesis AsyncLocalStorage instances. |
| `src/voice-worker/traced-agent.ts` | Accepted caller-turn hook and narrow default TTS-node wrapper. |
| `src/voice-worker/startup-arbiter.ts` | Synchronous optional-opening state machine and action ownership. |
| `src/voice-worker/startup-arbiter.test.ts` | State permutations and stale recovery ownership. |
| `src/voice-worker/hive-llm.ts` | Allocate bridge ID before stream construction, send optional metadata, emit attempt observations, own fetch cancellation. |
| `src/voice-worker/hive-llm.test.ts` | Real HTTP lifecycle, early cancellation, transcript and interruption-marker compatibility. |
| `src/voice-worker/session.ts` | Install listeners before start/SIP, integrate arbiter/recorder, guard retries and cleanup. |
| `src/voice-worker/session.test.ts` | Injected SIP/room/setup/shutdown and provider configuration. |
| `src/voice-worker/telemetry.ts` | Replace lossy TurnMetrics join and extend bounded aggregate CallStats. |
| `src/voice-worker/telemetry.test.ts` | Summary denominators, persistence outcome, heartbeat compatibility. |
| `src/voice-worker/testing/startup-fixture.ts` | Offline real-SDK session with controlled STT/TTS/media and loopback bridge gates. |
| `src/voice-worker/sdk-capability.integration.test.ts` | Exact pinned SDK lifecycle/context/event-order proof, including missing-content cases. |
| `src/voice-worker/startup.integration.test.ts` | End-to-end offline worker pipeline S1–S7 with generated frames delivered to fake output. |
| `src/agents/voice-request-cancellation.ts` | Request cancellation error and disposable signal binding helpers. |
| `src/agents/agent-manager.ts` | Carry signal through request admission, sticky cold abort and warm opening handoff. |
| `src/agents/warm-voice-session.ts` | Bind cancellation only inside the owning warm turn's consumption slot. |
| `src/agents/voice-request-cancellation.test.ts` | Cold admission/assembly and warm queue ownership regressions using real manager/lease code. |
| `src/channels/voice/voice-adapter.ts` | Validate trace metadata, allocate legacy ID, complete terminal logging and request-scoped cancellation. |
| `src/channels/voice/voice-adapter.integration.test.ts` | HTTP/auth/SSE/legacy/errors and delayed predecessor disconnect. |
| `src/channels/voice/voice-startup.integration.test.ts` | Actual HTTP adapter → real manager/lease → fake provider replacement progression. |
| `src/voice/voice-diagnostic-reader.ts` | Read-only ID reducer, process-loss gaps and explicit denominators. |
| `src/voice/voice-diagnostic-reader.test.ts` | Privacy, truncated/reordered logs and completeness. |
| `scripts/read-voice-diagnostics.ts` | Small stdin/file CLI; no config, Mongo, instances, or production logs by default. |
| `docs/epics/kpr-462/kpr-464-sdk-capability.md` | Exact artifact identity, commands, complete matrix and limitations. |
| `docs/epics/kpr-462/kpr-464-startup-evidence.md` | Sanitized regression and later caller-confirmed evidence. |

Execution order: Task 0 → [diagnostics chunk](./kpr-464-plan-diagnostics.md) Tasks 1–3 → [engine chunk](./kpr-464-plan-engine.md) Tasks 4–5 → [startup chunk](./kpr-464-plan-startup.md) Tasks 6–7 → Tasks 8–9 below. Diagnostics and engine implementation can proceed in independent lanes only after the shared schema is committed; integrate session/hive-llm/telemetry changes serially. Do not run a sibling KPR-463 edit of these files concurrently.

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: trace validation and reduction, bounded registries, startup arbiter, failure ownership, aggregate summaries and request cancellation helpers.
  - Reason: event reordering and cleanup must remain deterministic without vendor timing.
  - Minimum assertions: every start has one terminal or explicit process-loss gap; unknown measurements remain nullable; ID joins never use proximity/latest state; interrupted empty-item speech is counted; same request/speech cannot terminal twice; overflow is visible; stale errors cannot schedule recovery; provisional speech does not consume opening; invalid trace objects never enter prompts/log payloads.
- Integration: `required`
  - Scope: real pinned SDK session lifecycle; HiveLLM → loopback HTTP → real VoiceAdapter → real AgentManager cold/warm cancellation; Mongo summary uses injected fake client, not a real database.
  - Reason: ALS propagation, synchronous hook ordering, HTTP close timing and warm serialization are implementation facts that mocks of those boundaries cannot prove.
  - Harness: `setup-required`; existing `voice-adapter.integration.test.ts`, `agent-manager.test.ts`, `warm-voice-session.test.ts` provide HTTP/provider/config/memory fixtures; add offline media/provider fixture and actual manager adapter composition.
  - Minimum assertions: complete Task 0 matrix; S1–S9; canceled predecessor releases its own execution so replacement produces known frames and settles; old close cannot cancel active or queued successor; required IDs survive pre-content cancellation; timed frame metadata survives wrapper; missing metrics do not gate replacement; no live network dependency.
- E2E: `required`
  - Scope: deterministic complete worker/media/bridge/cancellation path plus separately authorized deployed phone startup scenarios.
  - Reason: invoking generation alone does not prove progression; fake output proves pipeline progress, and only caller evidence can prove phone audibility.
  - Harness: `setup-required` offline fixture; live requires KPR-463 supported running build/config proof and May's explicit go.
  - Minimum assertions: quiet answer, early hello, immediate barge-in/replacement, hangup; exactly one relevant opening or caller response; generated frames reach fake output; separately record actual first audible words, duplicate/stale speech verdict and missing observations during live run. Do not silently skip live acceptance when implementation merges.

### Critical Flows

- SIP answer while quiet schedules one explicit opening, without adding greeting instructions to worker prompt.
- Accepted caller greeting before/at answer consumes optional opening; input immediately after scheduling interrupts only the stale handle and its HTTP work.
- Old socket close after successor admission leaves successor work and warm lease intact; close while queued prevents that request from later executing.
- A known failure retains its classification through cleanup; superseded failure cannot retry/say/end a healthy successor.
- Each speech is recorded before EOU/LLM/TTS; late metrics stay with their original identities; no generated frame is equivalent to neither confirmed zero playout nor caller silence.
- Finalize worker records before summary persistence and Mongo close; abrupt-loss starts reduce to incomplete evidence.

### Regression Surface

- Bridge bearer auth, Vapi shared-secret/assistant resolution, SSE content/done/error framing and nonstreaming response.
- Engine-authored greeting, full-transcript/resume prompt shaping, interruption-marker latest-user placement.
- Cold lock/budget release, stopping agents, adapter-construction cancellation, circuit breaker classification, KPR-399 abort persistence and KPR-434 memory mark semantics.
- Warm one-turn demux, lease identity, tool acknowledgement, interruption grace, idle/lifetime cleanup; warm flag remains off by default.
- Vendor cell/voice mapping and streaming text transforms.
- Heartbeat/call outcome first-wins behavior and existing historical measurement artifacts.

### Commands

All commands run from the isolated delivery worktree with Node 24 and lockfile installation. Use `npm ci` once; do not symlink dependencies from a deployed worktree. Tests mock configuration imports before any module can load instance secrets.

- Unit: `npx vitest run src/voice/voice-trace.test.ts src/voice/voice-diagnostic-reader.test.ts src/voice-worker/speech-trace.test.ts src/voice-worker/startup-arbiter.test.ts src/voice-worker/telemetry.test.ts src/voice-worker/session.test.ts src/agents/voice-request-cancellation.test.ts`
- Capability: `npx vitest run src/voice-worker/sdk-capability.integration.test.ts --reporter=verbose`
- Integration: `npx vitest run src/voice-worker/hive-llm.test.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts src/agents/warm-voice-session.test.ts`
- Offline E2E: `npx vitest run src/voice-worker/startup.integration.test.ts --reporter=verbose`
- Broader regression: `npm run check`
- Build: `npm run build`
- Reader fixture: `npx tsx scripts/read-voice-diagnostics.ts --input docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl --call-id call-fixture`
- Live E2E: no call command is authorized by this plan; execute Task 9's script only after a concrete reviewed running build/evidence record and May's explicit go. Missing authorization is recorded as live acceptance pending, never a passing test or a skipped deterministic suite.

Expected automated output: every named Vitest file passes with zero skipped required cases; `npm run check` and build exit 0. Capture actual test names/counts and failing-before/passing-after sequence during delivery, not invented expected counts. Reader returns the fixture's explicit totals and `callerConfirmation: "unknown"`.

### Harness Requirements

- Verify the exact npm tarball's SHA-512 against `package-lock.json`; execute its exported runtime. Never substitute the similarly named GitHub tag or a mutable pilot installation.
- Fake STT and TTS implement the pinned public provider base classes and emit genuine SDK metrics through those classes. Fake output subclasses `voice.AudioOutput` and reports playback completion/clear accurately. No hand-emitted metrics stand in for the required capability proof.
- Use `AgentSession.start({ agent })` with no room for SDK lifecycle tests; explicitly assign fake input/output. Session orchestration unit tests inject a fake room/SipClient and intended participant identity. Controlled fixture clocks/gates should wait for named phases rather than sleeps; SDK timers may use real time with bounded test timeouts.
- The bridge listens on `127.0.0.1`, port 0; all non-loopback fetches fail. Provider SDK/network clients are fakes. No Deepgram, Cartesia, LiveKit cloud, Twilio, Mongo or instance `.env` is loaded by offline tests.
- Existing manager test fixture mocks provider construction, configuration and stores while keeping real lock/budget/lease implementation. Add barriers before admission, during preparation, during async adapter assembly, after first text and during warm consumption. Queue successor before firing predecessor close.
- Tear down HTTP servers, readers, SDK session, provider streams, output gates and timers in `finally`; fixture timeout rejects unresolved gates and reports ownership IDs.

### Non-Required Rationale

- None of unit, integration or E2E is optional. Live execution can remain pending without blocking a truthful implementation-only handoff; it still blocks KPR-464 acceptance completion.
- No additional dashboard, tracing backend, audio recording, package migration, provider/model switch or performance-target suite is required.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Task 0's complete-correlation and event-order results must exist before ready-to-implement. If the specified public seams cannot meet the contract, record the failed case and return to design review; no guessed join, private import, dummy token, synthetic metric or silent SDK upgrade.
- Run the relevant focused command after each chunk; run broader checks once after integration. Repeat only after changes or a newly discovered concern.

---

### Task 0: Finish exact-artifact offline capability proof before readiness

**Files:**
- Create: `src/voice-worker/testing/startup-fixture.ts`
- Create: `src/voice-worker/sdk-capability.integration.test.ts`
- Create: `docs/epics/kpr-462/kpr-464-sdk-capability.md`

- [ ] **Step 1: Pin artifact identity and separate evidence from design.**

The repository pins `@livekit/agents` 1.6.4 with:

```text
https://registry.npmjs.org/@livekit/agents/-/agents-1.6.4.tgz
sha512-Q+qlXmR8wLB4aMm2K5bt1ijItuMcoyfHvAHp047ORf2+yhIwR6csKfo95ErPbszWzgnLf7nIGSvJjvNVSh9okA==
```

Record Node/runtime/OS, lockfile SHA, tarball integrity, commands and results in the capability artifact. [Durable executed evidence](./kpr-464-sdk-capability.md) and [asserting probe](./probes/kpr-464-sdk-probe.mjs) now preserve the dispatcher's scratch work; this writer re-executed that subset on Node 24.16.0 with exit 0. It demonstrated six direct LLM context cases, a session speech/turn join, handle-specific interruption/replacement, and a real fake-STT accepted hook before SpeechCreated. Its TTS check used a reconstructed default-node body and observed **zero** metrics for cancellation before frame. This is partial evidence, not completion of this gate. Replace this paragraph's status only with a reviewed complete matrix. The actual `Agent.default.ttsNode` inside a real session, full caller-state/false-interruption ordering, all session-bound LLM cancellation cases and handle/error finalization ordering still require proof. The durable HTTP reproduction separately establishes unsafe adapter cancellation with a stub coordinator; the plan's signal ownership correction still requires real cold/warm integration verification during delivery.

- [ ] **Step 2: Implement the fixture against exported SDK APIs.**

Public methods verified in the pinned npm source: `voice.Agent.onUserTurnCompleted(chatCtx, newMessage): Promise<void>`, `voice.Agent.default.ttsNode(agent, text, modelSettings)`, `voice.AgentSession.generateReply(): SpeechHandle`, `say(): SpeechHandle`, `SpeechHandle.id/interrupted/done()/exception()/chatItems`, `addDoneCallback/removeDoneCallback` and `waitForPlayout()`. `SpeechCreated` contains `speechHandle/source/userInitiated`; `UserStateChanged` contains `oldState/newState`; `MetricsCollected` wraps a discriminated `metrics` union. `userInitiated` is not a human-origin bit. Output playback events lack speech IDs.

Use public `chatItems` in the handle's done callback for final item evidence. Do not use `_addItemAddedCallback`, `_cancel`, internal ALS stores or `getActivityOrThrow().currentSpeech`. A known queued stale opening is canceled through its own public `interrupt()` handle; validate this releases SDK scheduling under the intended event orders.

Expose named gates from the fixture, with no promises returned directly as thenable SpeechHandles:

```typescript
export function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export type BridgePhase =
  | "created" | "run_entered" | "request_received"
  | "headers_sent" | "first_text" | "ended" | "aborted";
```

The fixture must expose accepted-turn and caller-state signals produced by real SDK fake-STT/VAD input, named bridge gates, the original generated `AudioFrame` objects, fake output capture/clear/finish observations, session speech handles and collected application/SDK events. Create snapshots as `{ handle }`, not `Promise.resolve(handle)`, because this pinned handle is thenable. Use test-only fake SDK providers and local HTTP; do not reproduce SDK orchestration in a fake reducer.

- [ ] **Step 3: Execute the complete matrix.**

| Capability | Required observation |
| --- | --- |
| LLM close before `run()` | App turn ID already exists; no fetch; SDK metric carries correct speech ID and app ALS turn ID even with empty `requestId`. |
| Close before HTTP headers | Request canceled; one terminal; real session metrics bind exact handle. |
| Close after headers before text | No dummy text; correct handle/turn binding. |
| Close during text | Original text was streamed; cancellation cannot erase its first-text evidence. |
| Two overlapping streams, reverse completion | Distinct turn IDs, correct respective speech IDs; no last-turn/queue-order join. |
| Empty success and thrown BridgeError | One bridge terminal; correct binding/error attribution before recovery ownership is evaluated. |
| Actual default TTS wrapper, normal and multi-segment | Same AudioFrame object and `userdata` metadata reach output; first-frame and metrics contexts identify original synthesis. |
| TTS cancel/error before first frame, after first frame, with no metrics | Every created synthesis finishes; explicit speech association for generated frames is proved; missing-before-frame association is recorded and design-reviewed, never guessed. Required complete-correlation regression must pass before readiness. |
| Caller speaking/listening versus accepted hook | Exact order recorded for real fake-STT/VAD input, including provisional speech with empty transcript; opening cannot run before accepted-turn precedence is settled. |
| Early greeting before answer and immediately after opening | Known generated replacement frames reach output; old handle settles with no stale replay. |
| False interruption | Same handle resumes; caller activity alone does not create or consume a new opening. |
| Handle done versus error/metrics ordering | Terminal classification can be accurate without waiting indefinitely for optional metrics. Record actual order; unresolved error attribution requires a design change before readiness. |

App `AsyncLocalStorage.run` must enclose construction of `HiveLLMStream`, because the base constructor starts its metric monitor. TTS context must enclose the actual default-node invocation, not merely the wrapper's read loop. The partial probe's zero pre-frame TTS metrics is a material open seam: absence of those metrics cannot be papered over with a synthetic provider metric. Either prove an existing explicit public association that covers the required cases, or return to the spec lane and revise this chunk.

- [ ] **Step 4: Persist evidence and verify.**

Run the capability command from the Testing Contract. Expected: all matrix rows have actual assertions and pass; no missing-context row, skipped lifecycle case, private API import or non-loopback I/O. Write the observed event sequences and explicitly separate pre-fix reproduction from corrected arbiter behavior. Only then can the dispatcher review this plan for readiness.

Delivery commit, after verification:

```bash
git add src/voice-worker/testing/startup-fixture.ts src/voice-worker/sdk-capability.integration.test.ts docs/epics/kpr-462/kpr-464-sdk-capability.md
git commit -m "test(voice): pin offline startup lifecycle capabilities"
```

### Task 8: Integrate the reader, summaries and complete regression record

**Files:**
- Create: `src/voice/voice-diagnostic-reader.ts`
- Create: `src/voice/voice-diagnostic-reader.test.ts`
- Create: `scripts/read-voice-diagnostics.ts`
- Create: `docs/epics/kpr-462/fixtures/kpr-464-diagnostics.jsonl`
- Create: `docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl`
- Create: `docs/epics/kpr-462/kpr-464-startup-evidence.md`

- [ ] **Step 1: Implement an ID-based read-only reduction.**

Accept only schema-v2 `voice_diagnostic` events selected by `callId`, preserving process/clock IDs. Key speech by worker boot ID + speech ID; bridge by worker boot ID + turn ID; engine attempts by engine boot ID + turn ID + `engineAttemptSeq`. Join worker and engine turn IDs only through valid trace metadata and explicit binding rows. Ignore unrelated legacy log rows. Parse failures increment `malformedRows`; a truncated final line increments `truncatedRows`; neither is interpreted as a completed attempt.

For each started entity, collect explicit binding IDs, first-observation timestamps, terminal row and late supplemental observations. A duplicate terminal with the same terminal event ID is idempotent; a different terminal for the same entity increments `conflictingTerminals` and marks its outcome unknown rather than picking the last row. A start with no terminal at EOF is `incomplete/process_loss_or_missing_terminal`. Missing start with later evidence is `incomplete/missing_start`. Late binding can fill identity without changing terminal counts. Any cache/logging gap makes the report `complete: false`.

Produce `speechAttempts`, `bridgeAttempts`, `engineAttempts`, `byOutcome`, `generatedAudioObserved`, `playoutObserved`, `unbound`, `incomplete`, `gaps`, `malformedRows`, `conflictingTerminals`, `callerConfirmation: "unknown"`; detailed IDs are available in this offline report only, never appended as unbounded arrays to Mongo call summary. The reader does not load config or infer caller confirmation. It can reduce a bounded caller-selected log file in memory; reject files >32 MiB with a clear error and instruct the caller to supply a call-filtered file, instead of silently truncating.

Define distributions from individually eligible completed, non-interrupted, non-failed attempts with all components from the same speech and exactly one selected bridge/synthesis path. Estimate name: `estimatedEouToFirstGeneratedAudioMs`; sum EOU + matching bridge-first-text + matching TTS TTFB only when all are observed. Label it explicitly as a stage sum, not a measured end-to-end duration. Multiple paths without an explicit unique selection are excluded as `ambiguous_components`; opening lacks EOU and is excluded as `not_applicable`; unknown/canceled/failed/incomplete rows remain in attempt denominators with exclusion counts. No rewrite of historical `totalToFirstAudioMs` artifacts or old success-only harvester.

- [ ] **Step 2: Build the CLI with exact inputs.**

Use `node:util.parseArgs` for required `--input` and `--call-id`; `--input -` means stdin, bounded to 32 MiB. Read UTF-8, split lines, validate only known event fields with the shared schema parser, call the reducer, print formatted JSON. Invalid arguments/file/schema-version selection exit 2; log truncation/gaps remain a report with `complete: false` and exit 1; complete fixture exits 0. Never connect to Mongo or select a production log path automatically.

- [ ] **Step 3: Add evidence fixtures and assertions.**

Fixture includes quiet opening without EOU, canceled empty-text opening, successful replacement, fallback say without bridge, a pre-header cancellation, two TTS segments, an unbound attempt, an abrupt-loss start and duplicate/late rows. Assert exact distinct counts, no double terminal, no zero-for-null, estimate eligibility/exclusion counts and `callerConfirmation: "unknown"`. Include a secret/transcript/phone sentinel in rejected optional metadata and assert it is absent from new diagnostic records and reader output. Keep fixture data synthetic and content-free.

Write the evidence document with columns `scenario`, `build/pins`, `call/speech/turn IDs`, `observed causal sequence`, `generated audio`, `worker playout source`, `caller confirmation`, `missing observations`, `result`. Populate deterministic rows with actual test output. Live rows remain `pending` until Task 9 runs.

- [ ] **Step 4: Verify complete integration and commit.**

Run reader/unit, integration, offline E2E, `npm run check`, `npm run build`, and `git diff --check`. Expected: exit 0 for checks; the deliberately incomplete reader fixture exits 1 with the documented gap counts (provide a second complete fixture for CLI exit-0 assertion). Record any repository baseline failure separately and resolve relevant failures before delivery. No test should exist solely for this Markdown file.

```bash
git add src/voice/voice-diagnostic-reader.ts src/voice/voice-diagnostic-reader.test.ts scripts/read-voice-diagnostics.ts docs/epics/kpr-462/fixtures/kpr-464-diagnostics.jsonl docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl docs/epics/kpr-462/kpr-464-startup-evidence.md
git commit -m "feat(voice): reduce correlated startup evidence"
```

### Task 9: Prepare and execute separately authorized caller validation

**Files:**
- Modify: `docs/epics/kpr-462/kpr-464-startup-evidence.md`

- [ ] **Step 1: Make the live proposal concrete before requesting the go.**

Read back KPR-463's supported deployment identity and dependency pins; record engine and worker revisions, instance, flag values, model and configured voice, UTC clock basis and uncertainty. Keepur remains outside this operation. Prepare the smallest set of calls covering quiet answer, immediate hello, greeting while opening starts, replacement and hangup during startup, with explicit expected observations and cancellation procedure. This child does not repoint services or adopt a development worktree.

- [ ] **Step 2: With May's explicit go, execute and record all attempts.**

Retain failed/repeated attempts in the denominator. Ask for first audible words, whether relevant response arrived without prolonged unexplained silence, whether old speech replayed, and whether interruption behaved normally. Record caller feedback separately from machine observations; approximate recollection is not a precise handset timestamp. Use the reader on sanitized call-specific logs. No logs or responses contain destination, credentials, transcript or audio bytes; caller's confirmation may summarize first words only in the authorized human evidence document, not the diagnostic schema.

- [ ] **Step 3: Close evidence honestly.**

Passing caller confirmation plus complete attempt accounting meets startup acceptance; KPR-466 repeats on the final integrated deployment. If authorization or verified running build is unavailable, report exactly `implementation/regressions verified; live startup acceptance pending`. Do not mark KPR-464 acceptance complete or claim the September 7 root cause was proved from server metrics alone.
