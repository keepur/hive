# KPR-465 — Voice latency: validate warm execution and reduce response pauses

## TL;DR

Turn the September 7 cold-path numbers into a controlled, same-build comparison: measure every stage of a Mokie voice turn on the KPR-464 schema-v2 diagnostics, run the existing post-464 warm lease and at most one further engine-side variable at a time against a cold arm on the same agent/model/voice/script, verify the lease's identity, context, tool, cancellation, cleanup and fallback behavior before it is allowed near a normal call, and let May's blinded per-call verdict on pauses pick the dodi setting. No numeric target and no warm default are chosen here; the specification defines the metrics, the sample plan, the decision procedure, and the rollback, and it states plainly that the acceptance cannot complete without May's live-call go on a deployment that carries the KPR-464 instrumentation.

## Key Points

- The comparand is the **in-experiment cold arm on the same build**, measured on schema-v2 denominators (`estimated_eou_to_first_generated_audio`, eligible-only). The September 7 rows and any `scripts/voice-latency-baseline.ts` harvest are historical context only; no blessed W0 artifact exists and none is required.
- Readback of the twelve retained cold "Voice turn complete" rows already answers KPR-323's W1 question: CLI boot-to-init is ~650 ms per turn (≈26 % of first-token p50), model init-to-first-text is the largest term (p50 ≈ 1.3–1.7 s, ≈51–70 %), and queued turns paid 0.8–1.4 s of per-thread lock wait. By KPR-323's own falsification rule the warm lease alone cannot clear the bar; it is still evaluated first because it removes the boot and queue terms and is the only shipped mechanism.
- Voice turns deliver **no `effort`** to the SDK today (the KPR-219 carve-out returns `effortOverride: undefined`; the SDK default is `high` with adaptive thinking), and the worker runs the SDK's fixed **500 ms minimum endpointing delay** (observed EOU 500–649 ms). These are the two evidence-backed candidate variables after warm; each is a config-gated lever whose absence is byte-identical to today, built only when the measured decomposition names its stage.
- One variable per arm: cold → warm → warm + voice effort → (conditional) endpointing. Engine-side terms are measured cheaply on a loopback engine bench against a cloned `mokie-bench` definition; worker-side terms (EOU, bridge hop, TTS TTFB) are pooled from live calls because the engine-side treatments do not touch them. Live calls are reserved for the caller verdict and confirmation.
- Sample plan: a minimum of 36 eligible steady turns per arm, derived from the observed ~720 ms standard deviation for a 500 ms minimum detectable median shift, re-derived after the first cold block; live verdict needs at least two blinded calls per configuration May judges. Numbers here size the experiment; they are not a latency target.
- Warm-path admission to normal calls requires the behavior contract (§5): identity, context, tool ack, barge-in on a live and on an idle lease, idle reclaim, subprocess-kill fallback, per-exchange duration sanity, and no duplicate or stale speech, proved offline where the SDK is fakeable and on the bench where the real CLI is required.
- ⚠ Delegated assumptions: a cloned bench agent is an acceptable stand-in for engine-side measurement (Mokie's memory bytes differ; live calls reconcile); the additive diagnostic fields stay within schema v2 with the reader's allowlist extended; the voice-scoped effort lever is the "one-line change if wanted" KPR-430 left open, not a change to the static field's semantics.
- Blocking for execution only: May's explicit live-call go, and a deployed engine + worker that contain KPR-464's instrumentation (the running pilot worker `ab0d2d68` does not — the instance logs hold zero `voice_diagnostic` rows). KPR-466 repeats the chosen configuration end to end.

## 1. Problem, authority, and dependencies

[KPR-465](https://linear.app/keepur/issue/KPR-465) asks for a measured answer to the annoying response pauses May reported on the September 7 call, using the [verified KPR-325 timeline](https://linear.app/keepur/issue/KPR-325/w55-call-personas-vendor-pilot#comment-3af09f64) as the baseline. Gate 1 delegates specification and plan maturation; the Gate 1 record and the epic's canon (R3–R5) bind this draft: evaluate the post-KPR-464 lease shape, compare on schema-v2 denominators, and select no numeric target or warm default here. KPR-464 (`165e434c`) is the merged measurement substrate and is Done with live acceptance pending; this worktree sits on it. KPR-463 owns deployment and is not a maturation blocker for this spec, but its supported deployment is a precondition for every live run below. KPR-466 consumes the chosen configuration.

Read-only readback performed for this draft (no traffic generated, no content read): dodi `hive.yaml` has `voice.livekit.enabled: true`, no `voice.warmPath` key (warm off), no `voice.toolAck` key (ack on), no `modelRouter` key; Mokie is `claude-opus-5`, `timeoutMs: 300000`, `maxTurns: 20`, `budgetUsd: 50`, `spawnBudget: 5`, no `effort`, `coreServers` includes `voice-livekit`. `db.telemetry` holds three `voice_call_stats` docs for Mokie, all v1 (two on September 7, one aborted-after-one-turn call on September 11 03:39 UTC); `hive.log` retains 82 "Voice turn complete" rows, 12 of them for these calls, all `warmPath: false`; `voice_diagnostic` rows: 0 in both engine and worker logs. `com.hive.dodi.voice-worker` runs `/Users/mokie/github/kpr-320-live-call/dist/voice-worker/main.js` at `ab0d2d68`, which predates KPR-464. No `voice-pilot` test agent exists on dodi. No `docs/epics/kpr-320/baselines/` artifact exists.

## 2. Current behavior and bounded diagnosis

| Surface | Current behavior | Consequence for latency work |
| --- | --- | --- |
| `src/agents/agent-manager.ts` `prepareSpawn` voice carve-out | Returns raw text, static route, `resourceLimits: undefined`, `effortOverride: undefined`; the model router never runs. Cold deadline is `agentConfig.timeoutMs ?? 300000`; `maxTurns`/`budgetUsd` come from the top-level definition. | Every voice turn runs at the SDK's default effort (`high`, adaptive thinking). The KPR-430 static `effort` field is deliberately not delivered on voice ([KPR-430 spec ⚠ 1](https://github.com/keepur/hive-docs/blob/main/internal/specs/2026-09-04-kpr-430-static-agent-effort-design.md): "one-line change if wanted"). |
| `AgentRunner.send` / `buildQueryEnvelope` | Cold: one `query()` per turn; `bootToInitMs` spans envelope assembly + CLI boot + session/MCP init; `initToFirstTokenMs` spans init → first `text_delta`. | The twelve cold rows: `bootToInitMs` 611–726 (nearest-rank p50 646), `initToFirstTokenMs` 949–3248 (p50 1260 over ten turns; ticket-quoted steady-turn figure ≈1719), `lockWaitMs` 0 on ten turns and 831/1375 ms on two queued turns, `promptBuildMs` 7–12, `sessionLookupMs` 1–2, `spawnPrepMs` 1–3. |
| `src/agents/warm-voice-session.ts`, `openWarmLease` / `runWarmTurn` | Post-464 lease: opener reserves its ticket before publication, `selectText` picks continuity at consumption, `voiceLifetimeSignal` carries typed stop; turns 2+ push into one streaming `query()`. `stageTimings` on warm turns are `lockWaitMs: 0`, `spawnPrepMs: 0`, `initToFirstTokenMs` = push → first delta; `bootToInitMs` is absent, and the lease's internal `turnChain` wait is not measured. | Warm turn 1 folds CLI boot into `initToFirstTokenMs`; a request queued behind an in-flight warm turn has no recorded queue wait. Both are additive log-only gaps this ticket closes (§3.2). |
| `src/channels/voice/voice-adapter.ts` | Emits `engine_received` / `engine_attempt_started` / `engine_first_text` / `engine_attempt_terminal` / `engine_terminal` with `warm`, `selectedContinuity`, `launchAdmission`, stage measures, `toolCount`/`toolMs`/`toolAckInjected`; retains the "Voice turn complete" row (schemaVersion 2). Per-turn `buildVoiceSystemPrompt` includes a minute-granular datetime line and the hot-tier memory. | Warm/cold state is already stamped per attempt. The system prompt changes bytes across minutes on cold turns; whether that costs cache misses is measurable from `agent_turn_telemetry.cacheReadTokens`/`cacheCreationTokens` and is a measure-first item, not a lever. |
| `src/voice-worker/session.ts` | `AgentSession` built with `turnHandling: { turnDetection: "stt" }` for Flux and no endpointing, interruption or preemptive overrides. Pinned `@livekit/agents` 1.6.4 defaults resolve to fixed endpointing `minDelay: 500`, `maxDelay: 3000` (the string detector does not select the 300/2500 streaming set), `preemptiveGeneration.enabled: true`, `preemptiveTts: false`, `falseInterruptionTimeout: 2000`, `resumeFalseInterruption: true`. | The observed `eou_metrics.endOfUtteranceDelay` of 500–649 ms is the configured floor plus jitter, not STT slowness. Lowering it trades against cutting the caller off; it is a worker-side variable with its own arm. |
| `src/voice-worker/speech-trace.ts`, `telemetry.ts`, `src/voice/voice-diagnostic-reader.ts` | Per speech: EOU, bridge first text, TTS TTFB, first generated frame, playout evidence, terminal outcome; v2 `estimated_eou_to_first_generated_audio` on completed non-interrupted `sdk_response` speech only; reader reports one per-call distribution and rejects rows with unknown keys. | The reader has no arm grouping, no per-stage distributions, no multi-call input, and no engine-stage joins; §3.3 adds a comparison mode. Any new diagnostic key must be added to the reader's allowlist in the same change. |
| `scripts/voice-latency-baseline.ts` | Untouched historical cold harvester over "Voice turn complete" rows; drops `warmPath: true`. | May be run read-only for a historical record under a recorded operator go; it is not the comparand (R4). |

Bridge hop cost, from the September 7 rows: worker `llmTtftMs` exceeds the matching engine `firstTokenMs` by roughly 10–60 ms (e.g. 2469 vs 2457, 1667 vs 1651); TTS TTFB was 207–266 ms. Neither is an engine lever in this ticket, and vendor switching is excluded by the epic.

Diagnosis, bounded: on the one measured call, the caller-perceived pause decomposes as endpointing floor (~0.5 s) + CLI boot (~0.65 s) + model first text (~1.3–1.7 s median, up to 3.2 s) + TTS TTFB (~0.23 s) + unmeasured media transit, plus lock wait on turns that queued behind an interrupted predecessor. The warm lease targets boot and queueing; the model term needs its own variable; endpointing is a separate worker-side variable. Every figure above is n ≤ 12 from a single build and is re-measured in §4 before it drives a decision.

## 3. Measurement model

### 3.1 Metrics and denominators

Primary comparison metric: the v2 `estimated_eou_to_first_generated_audio` per eligible speech (EOU delay + bound bridge first text + one genuine TTS TTFB, completed non-interrupted `sdk_response` only), read from `voice_diagnostic` JSONL, never from `voice_call_stats` percentiles. It is an estimate, not a handset time; the specification never calls it caller-perceived latency. Openings are excluded (`not_applicable`) and belong to KPR-464/466.

Stage breakdown recorded per turn, each nullable with reason, each attributed to its identity chain (`speechId` ↔ `turnId` ↔ `engineAttemptSeq` through the recorded bindings, never by proximity):

| Acceptance stage | Source field(s) | Owner |
| --- | --- | --- |
| Turn-end detection | `sdk_metric.eou` `eouMs`, `transcriptionMs`, `onUserTurnCompletedMs`; call-level `session_started.endpointingMinDelayMs`/`endpointingMaxDelayMs` (new, §3.2) | worker |
| Lock/queue | cold `lockWaitMs`; warm `queueWaitMs` (new, §3.2) | engine |
| Session initialization | cold `bootToInitMs`; warm turn-1 `bootToInitMs` (new, §3.2); warm turns 2+ `not_applicable` | engine |
| First model text | engine `initToFirstTokenMs`, `engine_first_text.firstTextMs`; worker `bridge_first_text.firstTextMs`; delivered `effort` (new, §3.2) | engine / worker |
| First generated audio | `sdk_metric.tts` `ttfbMs`; `synthesis_first_frame` | worker |
| Available playout | `handle_playout_item.startedSpeakingAt`, `output_playback` (call-level, unbound by SDK design) | worker |
| Warm/cold state | `engine_attempt_terminal.warm`, `selectedContinuity`, `launchAdmission`, "Voice turn complete" `warmPath`/`warmTurnSeq` | engine |
| Caller | separately recorded verdict (§6.3); `callerConfirmation` stays `"unknown"` in machine records | human |

Steady turn: an `sdk_response` speech whose engine attempt is not the call's first (`warmTurnSeq ≥ 2` on warm; `selectedContinuity: "resume"` on cold). First turns are reported separately and never mixed into the steady distribution. Turns with `toolCount ≥ 1` are reported as their own stratum because the ack changes what "first text" means (KPR-324).

Percentiles are nearest-rank (`ceil(p·n/100)−1`), reported with n, min, max, and the excluded-by-reason table per arm. A bootstrap 95 % interval for the difference of medians (fixed seed, 2 000 resamples) accompanies every warm-versus-cold claim; a claim of improvement requires the interval to exclude zero **and** the caller verdict of §6.3.

### 3.2 Instrumentation gaps closed (additive, log-only)

- `queueWaitMs` on warm turns: `WarmVoiceSession.runTurn` enqueue → `consumeOneTurn` start; carried on `WarmRunResult`, `stageTimings`, `engine_attempt_terminal`/`engine_terminal`, and the "Voice turn complete" row. Cold turns report `lockWaitMs` unchanged; the comparison reader treats the pair as one "lock/queue" stage.
- Warm turn-1 `bootToInitMs`: `openVoiceStreamingSession` call → the `system/init` message observed by `consumeOneTurn`; turns 2+ report `not_applicable`.
- Delivered `effort` (`low`…`max` or `null`) on `engine_attempt_terminal`, and the effective endpointing (`endpointingMinDelayMs`, `endpointingMaxDelayMs`, `turnDetection`) on `session_started`. Numbers and enum strings only.
- These are optional keys under `schemaVersion: 2`; `parseVoiceDiagnosticEvent`'s allowlist is extended in the same change, KPR-464-era rows without the keys still parse, and the checked-in fixtures cover both shapes. ⚠ If review prefers a version bump, the reader must accept v2 and v3 and the comparison mode must refuse to pool arms across versions.
- Privacy posture unchanged: no transcript, phone number, tool argument, ack text, or prompt bytes in any new field.

### 3.3 Comparison reader

Extend `scripts/read-voice-diagnostics.ts` (or add `scripts/voice-latency-compare.ts` sharing `voice-diagnostic-reader.ts`) with a multi-call comparison mode: input one or more bounded JSONL files (reuse `MAX_VOICE_DIAGNOSTIC_BYTES`), a call-id allowlist with an explicit arm label per call, and an optional engine-log path for the retained "Voice turn complete" rows. Output per arm and per stratum (steady/first/tool): the primary estimate distribution, each stage distribution from §3.1, excluded-by-reason counts, incomplete/unbound counts, warm-state consistency checks (an arm labelled warm whose steady turns are not `warm: true` fails the run), and the median-difference intervals. Engine-only inputs (bench calls, §4.2) produce engine-stage distributions and an explicitly labelled "bench-composed estimate" = pooled live EOU p50 + engine first text + pooled live TTS TTFB p50, which is never presented as the v2 in-call estimate. No Mongo, no config, no network, deterministic output for the fixtures.

### 3.4 Sample plan and target-selection procedure

Sample size before claiming improvement: the ten September 7 cold first-token values have standard deviation ≈ 720 ms. For a minimum detectable median shift of 500 ms at α = 0.05 (two-sided) and 80 % power, a two-arm comparison needs ≈ 33 turns per arm by the t approximation, ≈ 34 with the Mann-Whitney efficiency correction; the plan uses **36 eligible steady turns per arm** as the default, spread over at least four scripted calls per arm. After the first cold block the standard deviation is re-estimated from that block and the per-arm minimum is re-derived and recorded before any treatment arm is analysed; a shortfall is reported as a shortfall, never rounded up to a claim. The 500 ms figure sizes detectability; it is not a target.

Target selection (procedure only; no number chosen by this specification): (1) collect the arm distributions per §3.1; (2) collect May's blinded per-call verdicts per §6.3; (3) the configuration with the best pause verdict among those passing the §5 behavior contract is the candidate; if May judges none acceptable, the current cold configuration stays and the gap is recorded; (4) the recorded target for KPR-466 is the candidate arm's measured steady p50 and p95 of the primary estimate, or an explicit number May states after hearing the calls — whichever she chooses — written to the epic decision register with its provenance. A machine improvement that May does not hear as an improvement does not become the target.

## 4. Treatments — one variable per arm

| Arm | Variable changed | Everything else | Hypothesis tested | Lever and rollback |
| --- | --- | --- | --- | --- |
| A0 cold | none (dodi today: `warmPath` absent, ack on, no effort, SDK endpointing) | — | Re-establish the decomposition on the same build the treatments run on. | — |
| A1 warm | `voice.warmPath.enabled: true` | A0 | Removes `bootToInitMs` and queue wait on turns 2+; leaves first model text unchanged. | Remove the key + engine kickstart (in-flight leases are killed; run between calls). |
| A2 warm + voice effort | `voice.effort: <level>` (new hive.yaml key, §4.1) | A1 | Lowers first model text without harming answer quality on the script. Levels are compared one at a time (each level is its own arm; start with the level adjacent to the default). | Remove the key + kickstart; the static agent `effort` field is untouched. |
| A3 endpointing (conditional) | `voice.livekit.endpointing.minDelayMs` (new, §4.1) | best of A1/A2 | Lowers the EOU floor without increasing caller cut-offs or false interruptions. Built only if the A0 decomposition shows the EOU stage is the largest or second-largest remaining term after A2. | Remove the key + worker restart. |
| measure-only | prompt-cache behavior of the cold voice system prompt (`cacheReadTokens`/`cacheCreationTokens` per voice turn from `agent_turn_telemetry`), response length (`textLength`, TTS `durationMs`, playout duration per speech) | — | Whether cache misses correlate with first-text latency; whether long replies drive the perceived pause through barge-in rather than first audio. | No lever in this ticket; a finding files a follow-up with the numbers. |

Excluded variables: model or provider change (ticket), vendor STT/TTS change or A/B (epic), SDK upgrade, prompt rewrites beyond what a lever needs, background ambience, pre-rendered audio, opening delay. Warm-lease lifetime constants stay constants.

### 4.1 Levers

`voice.effort` (engine): liberal-loader key, absent or invalid → `undefined` (today). Delivered only on voice-channel Claude-lane turns: the prepareSpawn carve-out returns it as `effortOverride` with a new `effortSource: "voice"`, and `openWarmLease` passes it into `openVoiceStreamingSession` so the lease pins it for the call. Delivery reuses KPR-430's gate (`supportsEffort(model)` and tier ≠ haiku, warn-once otherwise). It never reads or changes the agent definition's static `effort`, never applies to Lane A/B, reflection, or worker turns, and is stamped on telemetry. ⚠ This is the change KPR-430 §Key Points ⚠ 1 explicitly left open; canon R3's "tool-ack, KPR-399/434 predicates unchanged" is preserved.

`voice.livekit.endpointing.{minDelayMs,maxDelayMs}` (worker): optional integers validated (`0 ≤ min ≤ max ≤ 10000`), passed as `turnHandling.endpointing` in `session.ts`; absent → SDK defaults, byte-identical session options. Stamped on `session_started`. Interruption, preemptive and false-interruption options are not exposed.

Neither lever changes a default. Both are experiment instruments whose selected value, if any, is written to dodi's `hive.yaml` only through §6.4.

### 4.2 Evidence tiers

- **Tier E — engine bench (no PSTN, no vendors, no May).** `scripts/voice-engine-bench.ts`, operator-run on the instance host: resolves the bridge token the way the worker does (`resolveSecretEnv`, never logged), posts the fixed script (§6.1) turn by turn to the loopback `/v1/chat/completions` with the worker's exact request shape (`call.metadata.hive_agent_id`, `goal`, `context`, `metadata.voiceTrace` with a bench `workerBootId`), streams SSE, and writes a small result file (call id, arm, turn, client-observed first-text ms, text length). Engine stages come from the engine's own `voice_diagnostic` rows for those call ids. Supports: sequential calls, a barge-in step (close the response mid-stream), a rapid double-request at call start, three concurrent bench calls, and a mid-call CLI-subprocess kill drill. Runs against a cloned `mokie-bench` definition (same model, soul, systemPrompt, coreServers, no `effort`) created with `admin_agent_create`, so post-quiescence reflection and session rows never touch Mokie's memory; ⚠ delegated: the clone's hot-tier bytes differ from Mokie's, which is why engine numbers are confirmed on live calls. Bench `sessions` rows expire under the 7-day TTL.
- **Tier L — live PSTN calls with May.** Real Mokie, real handset, the same script. Provides the worker-side stages, the v2 in-call estimate, and the caller verdict. Minimum two calls per configuration presented for verdict, blinded (§6.3). Each call needs May's go under §6.2; the plan may batch calls within one authorized session.
- Worker-side terms (EOU, bridge hop, TTS TTFB) are pooled across A0–A2 live calls because those arms change nothing in the worker; A3 needs its own live samples.

## 5. Warm-path behavior contract (W0–W2 re-mapped to the post-464 lease)

KPR-323's W0 is discharged by §3 (the same-build cold arm replaces a blessed artifact); W1 is answered in §2 and re-confirmed by A0; W2's A/B is §4 and its behavior checks become the following contract, which must pass before `voice.warmPath.enabled: true` is proposed for normal dodi calls. Offline rows use the real adapter + manager + lease with the mocked runner (`voice-startup.integration.test.ts`, `agent-manager.test.ts` warm block, `warm-voice-session.test.ts`); rows marked bench need the real CLI and run on Tier E; rows marked live are confirmed on Tier L.

| ID | Check | Evidence of pass |
| --- | --- | --- |
| V1 identity | One lease per call; turn 1 `selectedContinuity` `fresh`/`resume`, turns 2+ `warm`; `warmTurnSeq` strictly increasing; `sessions` row keeps one SDK session id across the call (rotation only on compaction); `getSnapshot().warmVoiceSessions` is 1 during the call and 0 within `WARM_IDLE_TIMEOUT_MS` after hangup. | offline + bench + live |
| V2 context | Turn N's engine text belongs to turn N: `engine_received(turnId)` precedes its `engine_first_text`, no text after `engine_terminal`, bridge binding per speech is unique; a scripted recall turn is answered from earlier call context (ear check, not logs). | offline (ordering) + live (ear) |
| V3 tools | The scripted lookup turn executes a tool on a warm turn: `toolCount ≥ 1`, `toolAckInjected` true when the model was silent, the ack precedes the result; `maxInterChunkGapMs` reported. Same on cold. | bench + live |
| V4 cancellation | Barge-in during warm generation: `engine_client_closed` → lease `interrupt()`; the interrupted speech terminal is `interrupted`; the next turn runs on the same lease. Disconnect while the lease is idle (during pre-spawn awaits) leaves the lease usable or closes it cleanly with the next turn cold; the post-464 request-owned signal never cancels a queued successor. | offline + bench + live |
| V5 cleanup | Hangup → `Warm voice lease closed` with `idle-timeout` ≤ 120 s; budget slot released; no orphan CLI child processes (process count before/after); reflection credited once at release, subject to `memory.reflectionMinTurns`. | bench + live |
| V6 fallback | Killing the lease's CLI subprocess mid-call closes the lease; the adapter's outer retry lands cold with `continuity: full_transcript`; the call continues; speech outcomes show no duplicate. | bench |
| V7 accounting | Warm `durationMs`/`llmMs` are per exchange, not cumulative across the call (no monotone growth over the 10-turn script); breaker records stay per turn. | bench |
| V8 no duplicate/stale speech | Non-interrupted turns have exactly one speech attempt; no `speech_started` after the call's `call_closed`; caller confirms nothing replayed. | offline + live |
| V9 opening reservation | Two rapid requests at call start: the second waits on the pending opening and runs on the published lease; one lease, one ticket. | offline + bench |
| V10 concurrency | Three concurrent bench calls hold three slots under `spawnBudget: 5`; all reclaim within 150 s of hangup. | bench |

A V-row failure on the warm arm demotes A1 (and A2, which sits on it): the finding is recorded, the dodi setting stays cold, and the defect is filed against the lease rather than patched inside this ticket unless it is a one-line evidence-backed correction reviewed in the plan.

## 6. Live execution protocol

### 6.1 Script

One fixed 10-turn caller script per call, identical across arms: quiet answer (KPR-464 L1 shape), three short factual exchanges, one turn that references an earlier answer (V2), one turn that forces a lookup through an existing Mokie tool (V3), two marked barge-in points (V4 — one mid-sentence, one during a tool wait), one deliberately long question, and a normal goodbye with hangup. The caller lines are fixed strings checked into the bench script; they contain no personal data. Repeats and failed calls are recorded, never excluded.

### 6.2 Preconditions and stop rule

Every live call requires: May's explicit go for that session; a KPR-463-supported deployment whose running engine and worker identities are read back and recorded together with `@livekit/agents` 1.6.4, the flag values of the arm, Mokie's model and voice id, and the UTC clock basis; and the §5 offline rows green on that build. On identity or config drift, an unexpected destination, lost correlation, or May's stop request: stop dialing, hang up, keep the attempt in the denominator as failed/incomplete, and do not retry under the same go. Arms are switched only between calls (engine kickstart for A1/A2, worker restart for A3), the order is randomized per session and recorded, and the first bench turn after every restart is a discarded warm-up.

### 6.3 Caller verdict

After each call, before being told the arm, May records: pauses (acceptable / borderline / annoying), whether any response felt cut off or Mokie talked over her, whether interruptions behaved naturally, whether anything replayed or sounded stale, and free text. The record stores the verdict against the call id with the time of the observation; it is human evidence and never populated from machine timestamps. Machine measures and the verdict are presented side by side in the evidence record; disagreement is reported, not reconciled away.

### 6.4 Choosing the dodi setting and rollback

The candidate configuration from §3.4 is applied to dodi only as `hive.yaml` keys (`voice.warmPath.enabled`, optionally `voice.effort`, optionally `voice.livekit.endpointing.*`) through the supported deployment path, with the decision, the numbers, the verdict, and the rollback written to the epic decision register. Rollback for every lever is key removal plus the corresponding service restart; the engine default remains off for all three, so a fresh install or a lost `hive.yaml` edit is cold by construction. If no arm passes §5 or earns an acceptable verdict, the recorded decision is "keep cold" with the measured gap, and KPR-466 proceeds on cold.

## 7. Evidence record

`docs/epics/kpr-462/kpr-465-latency-evidence.md` records, sanitized: build/pins and running identities; arm order; per-arm distributions and stage tables from the comparison reader; the sample-plan derivation and any shortfall; the §5 contract results with call/speech/turn ids; the caller verdicts; the decision and rollback; and an explicit hypothesis-versus-observation table for the §2 diagnosis. Historical September 7/11 rows appear only as context with their v1 provenance. If live execution is pending the status is `bench/offline verified; live comparison and caller verdict pending`, and the ticket is not complete.

## 8. Regression and acceptance contract

Deterministic tests, no instance secrets, no live rooms or calls:

| ID | Required case | Passing evidence |
| --- | --- | --- |
| R1 reader | Multi-call comparison over fixtures with warm and cold arms, tool and first-turn strata, exclusions, an engine-only bench call, a mislabelled arm, and KPR-464-era rows lacking the new keys | Per-arm/per-stage tables, nearest-rank percentiles, deterministic bootstrap intervals, mislabel failure, old rows parse, unknown keys still rejected. |
| R2 warm instrumentation | Queued warm turn, warm turn 1, warm turns 2+ | `queueWaitMs` reflects the enqueue-to-consume wait; turn-1 `bootToInitMs` spans open → init; turns 2+ report `not_applicable`; cold rows unchanged byte-for-byte. |
| R3 effort lever | Key absent/invalid/valid; voice cold and warm; non-voice; Lane A/B; haiku/off-catalog; static field set | Absent → no `effort` in the envelope (today); valid → delivered on voice cold and pinned on the lease with `effortSource: "voice"`; never delivered elsewhere; static field precedence unchanged on non-voice; warn-once on undeliverable. |
| R4 endpointing lever | Key absent/invalid/valid | Absent → session options byte-identical to today; valid → `turnHandling.endpointing` set and stamped on `session_started`; invalid → rejected at load with a clear error. |
| R5 behavior contract | §5 offline rows V1, V2 (ordering), V4, V8, V9 on the existing real adapter + manager + lease harness | Pass before and after the instrumentation change; the pre-464 aliasing regressions stay green. |
| R6 bench script | Request shape, trace metadata, SSE parsing, barge-in close, concurrency, result file | Loopback test against the real adapter with the mocked runner; no secret in output; content never written. |
| R7 privacy | New fields and bench output | No transcript, phone, destination, token, tool argument, ack text or audio bytes. |

`npm run check` and the relevant voice suites run during delivery. No test asserts that this Markdown file exists.

## 9. Scope, non-goals, and delegated assumptions

Expected surfaces: `warm-voice-session.ts`, `agent-manager.ts` (carve-out, warm open, stage timings), `agent-runner.ts` (`openVoiceStreamingSession` effort), `config.ts` (two liberal-loader keys), `voice-adapter.ts` (payload fields), `voice-trace.ts` + `voice-diagnostic-reader.ts` (+ compare mode), `speech-trace.ts`/`session.ts` (endpointing stamp and option), `scripts/voice-engine-bench.ts`, `scripts/read-voice-diagnostics.ts`, fixtures, and the evidence record. Non-goals: any default flip, vendor or model change, SDK upgrade, ambience, pre-rendered audio, opening delay, worker-side filler, dashboards, Vapi-path changes beyond the shared adapter fields, and KPR-321 telephony operations.

- **Non-blocking, delegated:** the sample-plan derivation (36 per arm from a 720 ms SD and a 500 ms detectability floor) is re-derived from the first cold block; the numbers size the experiment and select no target.
- **Non-blocking, delegated:** `mokie-bench` clone for Tier E; engine-side numbers are confirmed live before they drive the decision.
- **Non-blocking, delegated:** additive keys under schema v2 with the reader allowlist extended (⚠ review may prefer a version bump; both readers must then coexist).
- **Non-blocking, delegated:** `voice.effort` is the KPR-430-sanctioned voice carve-out change; `voice.livekit.endpointing` is conditional on the A0 decomposition.
- **Non-blocking, evidence-dependent:** the §2 diagnosis (boot ≈ 26 %, first model text ≈ 51–70 %, EOU floor 500 ms) is from one call and one aborted call; A0 re-measures it.
- **Blocking for execution only:** May's live-call go; a KPR-463-supported deployment carrying KPR-464's instrumentation (the running pilot worker does not). Without both, this ticket's acceptance — controlled comparison, caller verdict, dodi setting — cannot honestly be met; the deliverable then stops at `bench/offline verified; live comparison and caller verdict pending`.

There are no blocking human product questions for drafting. This document is a draft specification, not signoff, implementation, deployment, or acceptance evidence.
