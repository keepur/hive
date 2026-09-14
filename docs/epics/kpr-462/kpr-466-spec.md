# KPR-466 — Voice acceptance: verify deployed Mokie calls end to end

## TL;DR

On the KPR-463 packaged dodi release, after KPR-465 has either applied a configuration or left dodi cold, run a May-authorized Mokie phone session that proves a real conversation — not an HTTP 200. Repeat KPR-464's L1–L4 startup checks on that integrated deployment, fold in initiation, voicemail-versus-answer, exchange, barge-in, a read-only tool, and hangup cleanup, and capture warm/cold plus restart/rollback from the preceding children rather than re-running their experiments. Missing caller-audio proof is `unknown`; without May's live-call go the honest terminal state is `no-call preflight verified; live end-to-end acceptance pending` and the ticket is not complete.

## Key Points

- Consume KPR-463's packaged-release evidence (`docs/epics/kpr-462/kpr-463-deployment-evidence.md`, spec §6/§7/T9) and **rerun** its no-call preflight on the identity that will actually place the calls, including the §6 Dependencies check (loaded Hive / LiveKit job helpers / RTC-native / Silero realpaths inside the selected release — P7). Do not re-execute restart/rollback as a 466 experiment.
- Repeat KPR-464 L1–L4 on this deployment (canon R5). Frozen 464 live rows are `pending` and are not a 466 pass. KPR-465's offline snapshot is not L1–L4 (R12).
- Sequence after KPR-465's §6.4 register entry when one exists; otherwise run **keep-cold by absence**. Capture warm/cold as a consistency check on the setting that actually ran. I1 pause verdict and any 465-written p50/p95 are observations, not a 466 SLO or ticket-complete gate (465 §6.4 / E6: proceed on cold with a recorded gap). Do not duplicate 465's arms, sample plan, bootstrap, or blinded target selection. Split warm-opener `initToFirstTokenMs` at the KPR-465 boundary (R8 CORRECTION).
- Honest grammar: a scenario that needs a heard conversation is `unknown` without caller-audio proof. Dispatch created, bridge 200, `sip_answered`, playout-complete, and `engine_first_text` are not a successful phone conversation.
- Smallest live set: one initiation call that also covers quiet opening, exchange, barge-in, tool-ack, and hangup (I1), plus L2, L3, L4. Voicemail is classified when observed, not manufactured; a classified `answered_voicemail` / `no_sip_answer` on any required call is retried once under the same go so L2–L4 remain completable. No AMD, no vendor API probes, no numeric SLO, no CNAM, no inbound.
- ⚠ KPR-463's plan is blocked on `JOB_ACCOUNTING_UNAVAILABLE`. This spec consumes the **approved 463 spec's evidence fields**, not a census helper, native guardian, or `JobRequest.accept()` bookkeeping shape. Hangup cleanup is speech/lease/heartbeat evidence, never installer process accounting.
- Blocking for execution only: May's explicit live-call go, a 463 T9-passed dodi identity with P1–P7 green, and the 465 configuration input above. Drafting authorizes none of those.

## 1. Problem, authority, and dependencies

[KPR-466](https://linear.app/keepur/issue/KPR-466) is workstream 4 of [KPR-462](https://linear.app/keepur/issue/KPR-462): repeatable end-to-end acceptance on the deployed system. The epic outcome is that Mokie can call May through dodi's LiveKit stack, speak an audible opening, handle interruptions and tools, and respond with acceptable pauses, from a reproducible deployment with rollback.

Gate 1 (2026-09-07) delegated specification and plan maturation, preserved Twilio → LiveKit → Deepgram/Cartesia and Mokie routing, and excluded vendor rollout, cloning, inbound rollout, vendor A/B, and ambience. Caller-ID/CNAM stays in KPR-321. No numeric latency target and no warm default are selected. Live calls require May's execution go.

Native blocks: KPR-463 and KPR-465. Maturing this spec now is legal; the dependency check is at plan review and the ticket stays `blocked-dependency` until both children are delivered. KPR-464 is Done at `165e434c` with live startup pending (R5). KPR-465 is merged at `28619e03` (R8 correction `38506f03`, docs-only) with status `bench/offline verified; live comparison and caller verdict pending` (R12).

Canon that binds this draft without re-justification: R1–R7 (startup ownership, schema-v2 JSONL, request-owned cancel, v2 denominators, 466 repeats L1–L4, startup precedence, fake-media harness); R8–R12 (additive keys, effort-on-voice, opener queue-end-at-open, completed-only compare pooling, 466 consumes the later 465 decision). R8 CORRECTION: warm-opener `initToFirstTokenMs` before and after KPR-465 must never be pooled.

This ticket's deliverable is an acceptance protocol plus a sanitized evidence record. It adds no conversation feature, no diagnostic schema, and no vendor integration.

## 2. Current behavior and bounded diagnosis

Read-only readback 2026-09-13 (no traffic, no content, no secrets). Dodi `hive.yaml`: `voice.livekit.enabled: true`, `sipTrunkId` nonempty, Mokie's Cartesia voice mapped, `telephony.twilio.number` and `trunkDomain` present, no `voice.warmPath` key (cold), no `voice.toolAck` key (ack on), no `modelRouter` key, no `defaultStt`/`defaultTts` keys (code defaults `deepgram/flux-general-en` / `cartesia/sonic-3`). LaunchAgents `com.hive.dodi.agent` and `com.hive.dodi.voice-worker` still execute `/Users/mokie/github/kpr-320-live-call/pkg/server.min.js` and `…/dist/voice-worker/main.js` — the pre-463 pilot. `hive.log` retains 82 "Voice turn complete" rows and **zero** `voice_diagnostic` lines; the worker log likewise has zero `voice_diagnostic` lines. `kpr-463-deployment-evidence.md` does not exist. This is not a supported KPR-463 identity and is not eligible for a 466 live run.

| Surface | Current behavior | Consequence for acceptance |
| --- | --- | --- |
| `src/voice/livekit-voice-mcp-server.ts` | `voice_call` builds a LiveKit agent dispatch (`hive-voice`, room `call-<uuid>`) with `to` / `goal` / `context` / `hive_agent_id`. There is no `voice_call_status` on this server (that tool is Vapi-only). | Initiation proof is: user request → Mokie → `voice_call` → dispatch id + call id → worker SIP. `lk dispatch create` and a Vapi `voice_call` are not this scenario. |
| `src/contacts/contacts-mcp-server.ts` | `contacts_search` / `contacts_get` print `p.formatted` (`(XXX) XXX-XXXX`) via `formatContact`; stored `p.number` is E.164 and is not in the tool text. `voice_call` still requires E.164. | Resolution is an agent behavior, not a new API: I1's "agent resolves" path is model conversion (or memory), not a copy of an E.164 field. The user request must not include digits. |
| `src/voice-worker/session.ts` | Outbound: `createSipParticipant(..., { waitUntilAnswered: true })` then `sip_answered` + `arbiter.answer()`. Hangup: intended SIP participant disconnect, room disconnect, or session close → `closeCall` (media off, abort, `call_closed`, bounded 2 s SDK close + mandatory post-start re-close). Input pinned to `sip-<callId>`. | SIP 200 is not a human answer. Voicemail typically answers SIP. There is no answering-machine detector in this stack; do not add one. |
| `src/voice-worker/startup-arbiter.ts` | Quiet answer requests one opening; nonempty final latches; accepted caller turn consumes and interrupts only the retained opening handle (R1, R6). | L1–L4 are still the live startup contract. Offline S1–S5 do not establish handset audio. |
| `src/channels/voice/voice-adapter.ts` | Bridge bearer + empty/malformed body: authenticated missing-agent **400** (`call.metadata.hive_agent_id required`); wrong/missing token **401** (or **403** when Vapi is unset). Disconnect aborts the in-flight spawn only. | The 463 no-turn probe is the preflight. A later 200 with SSE is still not a phone conversation. |
| `src/voice-worker/worker-config.ts` | Boot fails closed without LiveKit auth, Deepgram key, bridge token; Cartesia key required when default TTS is `cartesia/`. Heartbeat `cell-defaults` report stt/tts names. | Preflight for Deepgram/Cartesia is key-presence + cell-defaults + a later heard conversation. Do not call vendor HTTP from doctor or from this ticket (463: doctor must not do vendor API on every invocation). |
| `src/cli/doctor.ts` `renderVoiceWorkerSection` | Informational heartbeat; warns if `sipTrunkId` unset; never flips `allPassed`. | Not sufficient for the 463 packaged-release profile. Use the 463 helper/evidence table when it exists. |
| Diagnostics | Schema-v2 `voice_diagnostic` JSONL via `createLogger`; `scripts/read-voice-diagnostics.ts` (32 MiB); `scripts/voice-latency-compare.ts`. `callerConfirmation` is always `"unknown"` in machine records (R2). | 466 harvests existing JSONL. No new keys, no Mongo harvest of transcripts, no dashboard. |
| Warm / effort / endpointing | Warm default off. Static `effort` now delivers on voice when the definition carries it (R9); Mokie has no field at the 465 readback. `voice.livekit.endpointing` is **not built**. | 466 does not flip these. It reads back whatever 465 §6.4 applied. |

September 7 remains historical context (KPR-325 comment `3af09f64`): Call 1 voicemail-without-ring; Call 2 connected but May heard nothing before “May? It's Mokie. Can you hear me?”; all engine turns `warmPath: false`; no tool-ack coverage. That handset-silence root cause is still unexplained (R5). 466 may close live acceptance without proving that historical cause.

## 3. Honest outcomes and terminal states

### 3.1 Result vocabulary

| Result | Use when |
| --- | --- |
| `pass` | Required caller observation **and** required machine evidence both met. |
| `fail` | Caller reports a conversation defect, or machine evidence shows a defect on a call the caller also experienced (wrong destination, late speech after hangup, duplicate/stale opening, tool never ran when claimed, leftover warm session). I1 pause `acceptable` / `borderline` / `annoying` is not a defect under this row (see §4.3). |
| `unknown` | The scenario needs heard audio or a human classification, and that proof is missing — including “machine looks green.” |
| `unobserved` | Not attempted in this session (allowed only for voicemail). |
| `pending` | Not yet run. |
| `consumed` | Preceding child's evidence record supplies the row (restart/rollback only). |

`callerConfirmation` in JSONL stays `"unknown"`. Human verdicts live only in the evidence record, keyed by call id and observation time, never back-filled from timestamps. Pause quality is recorded, not classified as a conversation defect.

### 3.2 What is not proof of a phone conversation

None of these, alone or together, may be recorded as `pass` on I1, L1–L3, X, B, or T:

- LiveKit `createDispatch` / MCP `voice_call` returning a call id
- Worker job accepted / room joined
- `POST /v1/chat/completions` 200 or SSE `[DONE]`
- `sip_answered`, `participant_available`, `session_started`
- `engine_first_text`, TTS TTFB, `handle_playout_item`, `output_playback`
- A done speech handle with no exception
- `voice_call_stats` or a v2 estimate percentile

Those are supporting machine observations. The conversation pass is May's report of what she heard, correlated with call/speech/turn ids.

### 3.3 Ticket terminal states

| State | When | Ticket complete? |
| --- | --- | --- |
| `no-call preflight verified; live end-to-end acceptance pending` | 463 T9 passed, 466 preflight rerun green on that identity, no live go or live run yet | **No** |
| `live end-to-end acceptance passed` | Preflight green, every required scenario `pass`, voicemail `pass` or `unobserved`, consumed restart/rollback `consumed` or `pass`. I1 pause need not be `acceptable`; a 465-written p50/p95 is not an SLO for this state (Gate 1; §4.3) | **Yes** |
| `live end-to-end acceptance failed` | A required scenario `fail` after an authorized run | **No** — defect filed; not patched inside 466 unless a one-line evidence-backed correction reviewed in the plan |
| `live end-to-end acceptance incomplete` | Run started and stopped (drift, stop request, lost correlation) with required rows `unknown`/`pending` | **No** |

If May's go never arrives, the ticket stays at the first row. That is an honest stop, not a skip.

## 4. Relationship to preceding children

### 4.1 KPR-463 — consume evidence, rerun preflight, do not re-rotate

KPR-463 spec §7: 466 may consume 463 as passed only when **actual dodi migration, restart, rollback, and final read-back** have passed. A merged implementation or sandbox install is `implementation verified; migration pending` and is not a 466 input.

466:

1. Reads `docs/epics/kpr-462/kpr-463-deployment-evidence.md` (required fields in 463 spec §7).
2. Reruns the §6 packaged-release no-call profile on the **current** live PIDs/args/paths, **including the Dependencies check** (realpaths of loaded Hive, LiveKit job helpers, RTC/native, and Silero inside the selected release — 466 P7). An intervening update invalidates the earlier identity.
3. Records restart/rollback as `consumed` from that file's T9 rows. Does not issue `hive update` / `hive rollback` / launchctl rotation to prove 463 again.

⚠ **Non-blocking, architecture-open:** 463's plan is blocked on `JOB_ACCOUNTING_UNAVAILABLE` (a `ps`/PPID snapshot can miss detached npm descendants; census-to-settlement was withdrawn). The architecture decision may add a native guardian or another idle proof, or an unchanged-constraint mechanism. 466 does not assume any of those mechanisms. Preflight requires the **spec §6 checks as recorded** (manifest/lock/archive identity, live PIDs and args, fresh engine boot markers, no-turn bridge probe, worker registration/health socket owner, dependency realpaths inside the release, read-only LiveKit trunk lookup). If the decision changes the *names* of identity fields, 466 reads whatever the evidence record actually contains. 466 hangup cleanup never uses installer job accounting.

### 4.2 KPR-464 L1–L4 — repeat, do not reuse pending live rows

Canon R5: 466 repeats L1–L4 on the final integrated deployment. 464 live Task 9 was not executed; every live prerequisite is still unavailable. Offline S1–S5 stay prerequisite evidence (R7), not handset proof.

The four caller actions, machine expectations, and caller observations are those in `kpr-464-startup-evidence.md` §Live status (quiet answer; immediate hello; greeting as the opening starts; hangup during startup). 466 does not change them. It runs them on the 463 identity under the 465 setting, and combines them with I1's extra scenarios.

F2 (refresh 464 evidence-doc command rows at the merged head) is an epic-docs follow-up, not a 466 edit. 466 records its own running identity and does not treat the frozen `6027b2c` Vitest snapshot as that identity.

### 4.3 KPR-465 — consume the configuration decision; do not duplicate the experiment

Canon R12: 466 consumes the later decision, not the frozen offline snapshot's live rows. 465 spec §6.4 writes that decision to the register (chosen `hive.yaml` keys + optional Mokie `effort`, or explicit keep-cold) with rollback.

**Preferred sequence (waterfall):** 465 E6 exists. 466 live runs on that applied setting. Same-session batching under one May go is allowed: finish the 465 decision (or confirm keep-cold), then run 466 scenarios. 465's live calls are **not** 466 L1–L4 (R12: consume the later decision, not 465's live rows). 465 live §6.1 is an L1-shaped quiet answer on PSTN plus the rest of the 10-turn experiment script; it is not the 464 L2–L4 set. The bench's turn 1 is a scripted greeting rather than the SIP opening (465 plan, R6) — that reason applies to the bench, not to refusing 465 live reuse.

**Fallback:** 465 closed in the R5 style with no §6.4 entry → **keep-cold by absence**. 466 reads back current keys (warm absent, effort unset, no endpointing) and proceeds. 466 does not select an arm or write a warm default.

**Forbidden:** treating 465 bench/offline V-rows as 466 live pass; running 466 while a 465 arm switch is in flight; pooling warm-opener `initToFirstTokenMs` across the R8 CORRECTION boundary (`a0a026e0` and earlier vs `687235f7` / `28619e03` and after). `38506f03` is the docs-correction SHA (runtime unchanged) and is not that cut.

**Capture (not experiment):** on 466's calls, record `voice.warmPath.enabled`, Mokie's `effort`, endpointing presence, and JSONL `warm` / `selectedContinuity` / `warmTurnSeq`. A warm-labelled run whose steady turns are not `warm: true` fails capture. A keep-cold run containing any `warm: true` steady turn fails capture. Confirmatory stage tables for I1 use `scripts/voice-latency-compare.ts` on those call ids only. No A0/A1 pairs, no 36-turn sample plan, no bootstrap claim.

**Pause verdict and 465 target — observation, not a 466 completion gate.** Gate 1 selects no numeric latency target. 465 spec §3.4 / §6.4 and plan E6 Step 1: if no arm earns an acceptable verdict, the recorded decision is keep-cold with the measured gap and **KPR-466 proceeds on cold**. The epic's “acceptable pauses” outcome is owned by that 465 procedure (and the recorded gap when none is acceptable), not by 466 `fail` / ticket-complete. C's `pass`/`fail` is the machine consistency check above.

| Recorded item | Effect on C | Effect on ticket-complete |
| --- | --- | --- |
| I1 pause `acceptable` | Recorded observation. Not a C `pass` input | Neither required nor sufficient |
| I1 pause `borderline` | Same | Same |
| I1 pause `annoying` | Same | Same. Keep-cold with a recorded gap is a valid 466 input; an annoying I1 on that setting does not fail 466 |
| 465-written steady p50/p95 “target for KPR-466” | I1 v2 estimate reported beside it | Observation only; not an SLO; cannot override `unknown` audibility; cannot fail C or the ticket |
| No 465 numbers (keep-cold / no §6.4 target) | No numeric comparison required | 466 proceeds |

A 465 config change **after** a 466 live run invalidates those live rows; a fresh go is required.

### 4.4 R8 CORRECTION — warm-opener split

Any before/after latency table in the 466 record that includes warm-opener `initToFirstTokenMs` must split at the KPR-465 boundary (`a0a026e0` and earlier: push → first text including boot; `687235f7` / `28619e03` and after: init → first text, boot in `bootToInitMs`). Parsing across the boundary is fine; pooling those values is not. September 7 rows are cold (`warmPath: false`) and must not be plotted as a 466 arm. Cold `initToFirstTokenMs` and warm turns ≥ 2 are unchanged.

## 5. No-call preflight

Run immediately before the live session, after identity readback, with no SIP participant and no agent dispatch. Record pass/fail per row. A failed required row stops the session (no dialing).

| ID | Check | Required evidence | Does not establish |
| --- | --- | --- | --- |
| P1 | Artifact and process identity | 463 evidence digest + live launchd PIDs, ProgramArguments, working directory, config selector; engine and worker boot identities match that activation; `@livekit/agents` 1.6.4; Node version; UTC clock basis | Package files on disk without live PIDs |
| P2 | Engine boot | Fresh `Hive starting up` then `Hive is running` scoped to the current PID, still alive at the final check | A stale prior-boot line |
| P3 | Bridge authentication | From the packaged worker environment: valid bridge token + `POST /v1/chat/completions` body `{}` → missing-agent 400; wrong/missing token → 401 (or 403 if Vapi unset). No model spawn. Token resolved in-process; log status/classification only | Conversation, provider auth, audio |
| P4 | Worker registration | Current supervisor PID, fresh identity heartbeat, SDK `/` 200, `/worker` reports `hive-voice`, health socket owned by that supervisor — **as the 463 evidence table defines these fields** | Heartbeat written before registration; `/worker` alone |
| P5 | Twilio / LiveKit outbound setup | Read-only LiveKit auth + lookup of the configured outbound trunk id; config relationship to the existing Twilio trunk/number (names/ids only); Mokie's `voice-livekit` routing preserved. **Do not run `scripts/livekit-setup.ts`** (it can create SIP objects). **Do not create a dispatch or SIP participant** | PSTN delivery, CNAM, audible speech |
| P6 | Deepgram / Cartesia | Worker actually running (P1/P4) implies boot-time key presence; heartbeat `cell-defaults` name Flux + Sonic 3 (or the explicit hive.yaml overrides); Mokie has a Cartesia voice mapping (boolean). No vendor HTTP | That STT/TTS will be heard — that is I1/L1 |
| P7 | Loaded-artifact containment (463 §6 Dependencies) | Realpaths of loaded Hive, LiveKit job helpers, RTC/native libraries, and Silero model asset remain inside the selected instance release — **as the 463 evidence table defines these fields**. Node is a documented installed host prerequisite. A directory name, or success via a parent/global `node_modules` tree or the current pilot layout, is insufficient. This is the check that distinguishes a packaged identity from the live pilot/`node_modules` layout; a P1 PID/args/`@livekit/agents` 1.6.4 pin without these realpaths does not green-light dialing | Package files on disk; P1 without containment |

Keepur must remain untouched (463). Pilot worktrees must not be the live ProgramArguments (463 §7: a runtime path still pointing at either pilot marks 463 incomplete; 466 must not dial on that identity).

## 6. Live scenarios and smallest call set

### 6.1 Required scenarios

| ID | Ticket bullet | Caller / operator action | Machine evidence | Required caller observation | Result if audio missing |
| --- | --- | --- | --- | --- | --- |
| I1 | Mokie initiates from a user request and resolves the known contact | May messages Mokie (Slack) to call her **without digits**. Mokie resolves via contacts or memory and invokes LiveKit `voice_call` | `voice_call` dispatch id + room/call id; agent is Mokie; destination **not** copied into the record; tool-name counts only (no args). Not `lk dispatch create`, not Vapi `voice` | The handset that rang is May's known line. Mokie did not ask for the number | `unknown` (initiation without a heard ring/answer cannot pass) |
| V | Ring/answer vs voicemail distinguished | Natural outcome of any authorized call, or one optional “let it go to voicemail” attempt under the same go | Classification table §6.2. `sip_answered` ≠ human | May states: no ring, voicemail, or human answer | `unknown` if unclassified; `unobserved` if no voicemail attempt and none occurred |
| L1 | Audible opening (quiet answer) | Answer and remain quiet through startup | Exactly one relevant opening; complete attempt accounting; generated-audio and worker-playout kept distinct from handset receipt (464 L1) | First audible words; no prolonged unexplained silence; no duplicate/stale speech | `unknown` |
| L2 | Early “hello” | Say hello immediately before or at answer | Caller input owns startup; exactly one caller response; no optional opening (464 L2) | First audible words; no opening or stale replay | `unknown` |
| L3 | Opening-start replacement | Begin a greeting as the opening starts | Obsolete opening interrupted; one replacement proceeds; no later stale opening (464 L3) | Interruption felt normal; response arrived; old speech did not replay | `unknown` |
| X | Normal exchange | Two short factual turns after a human answer (on I1) | ≥ 2 completed non-interrupted `sdk_response` speeches bound to turn ids; `warm` flag matches the chosen setting | Answers were audible and on-topic (May's per-turn mark: correct / wrong / missing) | `unknown` |
| B | Barge-in | One mid-sentence interruption on I1 | Interrupted speech terminal `interrupted`; replacement progresses; no duplicate | Interruption behaved naturally; nothing replayed | `unknown` |
| T | Harmless read-only tool + ack | One I1 turn that forces a read-only lookup Mokie actually carries (prefer `conversation_search` if present; `contacts_search` is acceptable). Not `voice_call`, not a write (`contacts_create`/`contacts_update`, browser, code-task, …) | `toolCount ≥ 1`; `toolAckInjected` true **or** caller heard an acknowledgement when the model was silent; conversation resumes (`bridge_terminal.maximumGapMs` recorded if present) | Heard an acknowledgement (or a brief spoken hold) and a spoken result, then normal talk | `unknown` |
| H | Hangup cleanup (mid-call) | Normal goodbye then hangup on I1 | `call_closed`; every started attempt terminal or explicit incomplete; **no** `speech_started` / engine write / generated frame after close; worker `activeCalls` on `voice_worker_stats` returns to the pre-call value on a document with `updatedAt` after hangup — this is a 30 s Mongo heartbeat (`VoiceWorkerHeartbeat.INTERVAL_MS`, `src/voice-worker/telemetry.ts`), not an instantaneous gauge, so wait for that post-hangup write rather than sampling immediately; if warm, observe until `warmVoiceSessions == 0` or `WARM_IDLE_TIMEOUT_MS` (120 s from last turn result, `src/agents/warm-voice-session.ts`; V5: idle timer arms at last result, not at hangup) | No late speech after hangup | Machine-only rows may `pass` without audio; “no late speech” without a caller is `unknown` |
| L4 | Hangup during startup | Hang up while startup is pending or beginning | 464 L4: disconnect terminalizes or leaves incomplete; no post-disconnect successor audio attributed as successful | What, if anything, was audible; recollection is qualitative | `unknown` for audibility; machine cleanup may still `pass` |
| C | Warm/cold capture | None beyond running on the 465 setting | §4.3 consistency check + confirmatory compare CLI on I1 call ids, R8 split honored | Record the I1 pause verdict (acceptable / borderline / annoying). The three-way verdict is **not** a C `pass`/`fail` input (§4.3 mapping); C `pass`/`fail` is machine consistency only | Pause row `unknown`; machine consistency may still `pass`/`fail` |
| R | Restart/rollback | None in 466 | `consumed` from 463 T9 | — | If 463 T9 pending, 466 cannot complete |

### 6.2 Voicemail / answer classification

| Class | Machine | Caller | Scores L1–L4 / X / B / T / H? |
| --- | --- | --- | --- |
| `no_sip_answer` | No `sip_answered`; setup failed or createSipParticipant never completed | No ring, busy, or gave up | No — not a conversation call. V `pass` if classified. Do not fail L1–L4 / X / B / T / H on this attempt |
| `answered_voicemail` | `sip_answered` (SIP 200) | Heard voicemail / greeting-machine, no human | No — V `pass` if classified. Do not fail L1–L4 / X / B / T / H on this attempt |
| `answered_human` | `sip_answered` | May answered and could speak | Yes |
| `unclassified` | Anything else, or disagreement | Missing or contradictory | V `unknown` |

September 7 Call 1 is the historical example of voicemail-without-ring; 466 does not need to reproduce that exact pathology. V is `unobserved` if no authorized call landed in `no_sip_answer` or `answered_voicemail` and May did not request an extra attempt. `unobserved` does not fail the ticket. A dedicated voicemail number or AMD feature is out of scope.

If **any required call** (Call 1 / I1, or Call 2–4 / L2–L4) lands voicemail or no SIP answer, keep it in the denominator as V, do not score L1–L4 / X / B / T / H on that attempt, and a retry of **that scenario** under the **same** go is allowed (intended destination, classified outcome) so the four-call set remains completable. V applies to any authorized call; a missed pickup on L2–L4 is not a hard fail with no retry. An **unexpected** destination (wrong person) trips the stop rule and is not retried under that go.

### 6.3 Smallest authorized call set

Four required calls, one optional:

| Call | Covers | Initiation |
| --- | --- | --- |
| 1 — I1 | I1, L1, X, B, T, H, C, and V if that is the outcome | Slack → Mokie → `voice_call` **required** |
| 2 — L2 | L2 (V if that is the outcome) | Mokie `voice_call` preferred; CLI dispatch is not a substitute for Call 1 |
| 3 — L3 | L3 (V if that is the outcome) | same |
| 4 — L4 | L4 (V if that is the outcome) | same |
| 5 — optional V | only if May wants a voicemail observation and none occurred | same |

Repeats and failed attempts stay in the denominator; they are not dropped. If Call 2, 3, or 4 classifies as `no_sip_answer` or `answered_voicemail`, do not fail L2/L3/L4 on that attempt; retry that scenario once under the same go (§6.2). Call 1 already has that retry for I1. Do not import the KPR-465 10-turn bench script onto the handset — it is an experiment instrument (powered n, `mokie-bench` clone, “bench marker”). I1 is short on purpose.

I1 caller lines (fixed, no personal data), checked into the evidence record at execution, not into product code:

1. Quiet through the opening (L1).
2. One short factual question with a go-time expected keyword (X).
3. One second short factual question (X).
4. One longer prompt, interrupted mid-sentence (B).
5. One lookup prompt that names the chosen read-only tool’s job without personal data (T). If `conversation_search`, a go-time non-personal marker phrase; if `contacts_search`, a name already on the request path (May), never a number.
6. Goodbye and hangup (H).

L2–L4 follow the 464 live table verbatim.

## 7. Live execution protocol

### 7.1 Preconditions

Every live call requires all of:

1. May's explicit go for **this** session (Gate 1 is not that go).
2. KPR-463 T9 passed and P1–P7 green on the identity that will dial, recorded in the 466 evidence file.
3. KPR-465 configuration input (§4.3) read back: warm flag, Mokie `effort`, endpointing key presence/absence, model, Cartesia voice mapping (boolean), `@livekit/agents` 1.6.4.
4. Quiet window: freshest `spawn_coordinator_stats` (≤ 30 s) shows `activeSpawns == 0` and `warmVoiceSessions == 0` for every agent; no `meeting_worker_claims` with `status: "running"`; no live call up. Accepted residuals are the same as 465 §6.2 (heartbeat staleness window; claim-free scribe turns).
5. Stop procedure in hand: identity/config drift, unexpected destination, lost correlation, or May's stop → hang up, keep the attempt in the denominator as failed/incomplete, do not retry under that go (except the classified voicemail retry in §6.2).

466 does not kickstart the engine or worker to switch arms. If the 465 setting is not the live setting, stop and return to 465; do not rotate services as a 466 proof.

### 7.2 Privacy and harvest

Reuse 464/465 posture. The evidence record and any harvested JSONL slice must not contain transcript text, phone numbers, destination, tokens, tool arguments, ack phrase text, prompt bytes, or audio. Call id, dispatch id, speech id, turn id, workerBootId, outcomes, measures, tool **counts**, and boolean flags are allowed. Public-safe path patterns replace account-specific absolute paths; exact local read-back stays in the operator record outside git if needed.

Harvest commands (operator, after the call, bounded 32 MiB):

```text
npx tsx scripts/read-voice-diagnostics.ts --input <call-filtered jsonl> --call-id <id>
npx tsx scripts/voice-latency-compare.ts --input <jsonl> --call <id>=<config-label> --engine-log <hive.log slice> --seed 20260913
```

No Mongo content dump. No `voice-latency-baseline.ts` as a comparand (R4). Doctor remains informational.

### 7.3 Caller verdict (not blinded)

466 is not an A/B. After each human-answered call, May records: first audible words; pauses (acceptable / borderline / annoying) on I1 — recorded, not a 466 fail (§4.3); cut-off or talked-over; barge-in quality; duplicate/stale speech; tool acknowledgement heard; late speech after hangup; per-turn correctness for X and T; free text (verbatim only with her ok). Observation time is stored with the call id. Disagreement between machine rows and the verdict is reported, not reconciled away.

## 8. Evidence record

Save `docs/epics/kpr-462/kpr-466-acceptance-evidence.md` during delivery (skeleton may land with the plan; live rows stay `pending` until the go). Required sections:

1. Status line (exactly one of §3.3).
2. Build/pins and running identities (engine, worker, package version, archive/lock digests from 463, P7 loaded-artifact realpaths, `@livekit/agents` 1.6.4, Node, UTC clock).
3. 465 configuration input and readback (warm / effort / endpointing / keep-cold-by-absence).
4. P1–P7 preflight table.
5. 463 T9 consumption (link + digest; `consumed` or blocked).
6. Session log: go, quiet-window check, call list with ids, classified V outcomes, stop events.
7. Per-scenario table (§6.1) with result, call/speech/turn ids, timings, caller observation, links to sanitized JSONL slices.
8. Confirmatory compare CLI output for I1 (seed echoed); R8 split statement; September 7/11 rows only as v1 provenance, not an arm.
9. Hypothesis-versus-observation for September 7 handset silence: still unexplained unless new evidence supports a cause — do not declare a SIP race proved (464 spec §6).

No test asserts that this Markdown file exists.

## 9. Regression and testing contract

This ticket is not expected to change `src/`. Deterministic tests already owned by 463/464/465 stay green; `npm run check` runs if any docs-adjacent script is touched. No live room, no instance secrets, no vendor, no new fixture suite, no assertion that the spec file exists.

If plan review discovers a one-line evidence-backed harvest helper is truly required (for example a call-id filter that refuses to copy destination/transcript fields), it is content-free, offline, and covered by a privacy test mirroring 464 S9 / 465 R7. That helper is not assumed here.

## 10. Scope, non-goals, and delegated assumptions

**In scope:** the protocol in §3–§8; the evidence record; rerunning 463 no-call preflight; repeating L1–L4; I1 initiation/contact/exchange/barge-in/tool/hangup; voicemail classification; warm/cold capture; consuming 463 restart/rollback.

**Non-goals:** any default flip; KPR-465 arm selection or endpointing lever; KPR-463 installer/guardian design; AMD; `scripts/livekit-setup.ts` mutation; doctor vendor API; CNAM/KPR-321; inbound; vendor A/B or cloning; ambience; pre-rendered audio; opening delay; dashboards; Vapi-path changes; new `voice_diagnostic` keys; `mokie-bench` clone; numeric latency target.

- **Non-blocking, delegated:** keep-cold by absence when 465 has no §6.4 entry; 466 does not itself choose warm or effort. I1 pause verdict and any 465-written p50/p95 are observations, not a 466 completion gate (Gate 1; 465 §6.4 / E6).
- **Non-blocking, delegated:** voicemail `unobserved` is allowed; distinguishing when it occurs is required.
- **Non-blocking, delegated:** Slack is the user-request channel; contacts or memory may resolve the number (contacts tools print formatted numbers; `voice_call` still needs E.164); the request must not contain digits.
- **Non-blocking, delegated:** I1's short script (not the 465 10-turn bench) is enough for X/B/T/H. The T tool is whichever read-only lookup Mokie actually carries at go-time; this draft did not re-read her `coreServers`.
- **Non-blocking, ⚠ architecture-open:** 463 job-accounting mechanism (§4.1). Consume spec evidence fields, not the blocked plan.
- **Non-blocking, evidence-dependent:** September 7 silence remains unexplained unless the live run produces a supported cause.
- **Blocking for execution only:** May's live-call go; 463 T9-passed identity; P1–P7 green. Without those, stop at `no-call preflight verified; live end-to-end acceptance pending` (or earlier, if 463 T9 itself is pending).

There are no blocking human product questions for drafting. This document is a draft specification, not signoff, implementation, deployment, or acceptance evidence.
