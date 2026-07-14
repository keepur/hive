# KPR-322 — W5.2: LiveKit Agents worker + hive-as-LLM-node bridge

**Epic:** KPR-320 (W5: Voice v2 — outbound vendor pilot). **Consumes:** KPR-321 §8 (SIP handoff artifacts: trunk termination URI, E.164 number, credential list by SID). **Blocks:** KPR-324 (mid-call tools + latency masking — needs the tool-invocation surface stated in §9.2), KPR-325 (pilot — consumes the whole stack). **Adjacent:** KPR-323 (warm path — owns spawn-side latency and the already-blessed read-only first-audio baseline of the current voice path; referenced here, never duplicated).

**Program mode + D3 (Gate 1, 2026-07-13):** maturity-first — this lane ships spec only, no code, no PoC runs. Per D3, the empirical protocols in §14 (vendor A/B matrix) and §15 (PoC verdict gates) are **designed-but-not-run**; every gate and measurement run in them **requires operator go at delivery/dispensation**.

**Anchor:** main @ W6 merge (base of epic branch kpr-320). Wave W3 (epic kpr-309 — KPR-311 router→adapter seam reshape, KPR-313 session-identity guards) is matured but **not on main**, and it moves the same spawn seam this bridge rides. Per the W2/W3 precedent (anchor to main + mandatory re-confirm, never design against unmerged branches), §18 lists the seam surfaces that Task-0 at delivery must re-confirm.

**Ticket shape:** code-design spec (unlike sibling 321's ops runbook). The deliverable of the eventual delivery lane: a LiveKit Agents worker process + the bridge that makes hive's own agent spawn path serve as the pipeline's LLM node, so the hive agent — soul, memory, MCP tools intact — authors every conversational turn on a live phone call.

## TL;DR

A LiveKit Agents worker (Node, `@livekit/agents`) runs as its own launchd service on the instance and owns the media pipeline for calls over the KPR-321 Twilio SIP trunk: SIP audio → Deepgram STT (Flux or Nova-3) → **hive-as-LLM-node bridge** → streaming TTS (Cartesia Sonic or ElevenLabs) → SIP audio. The bridge is a custom `llm.LLM` implementation inside the worker that POSTs each turn to hive's **existing** OpenAI-compatible voice endpoint (`POST /v1/chat/completions`, SSE) — the same hardened spawn path Vapi uses today (per-thread lock, spawn budget, SDK session resume + outer retry, provider circuit breaker with spoken outage notice) — and converts hive's SSE text deltas into LiveKit `ChatChunk`s. Token-level delta streaming already exists end to end in the engine (`includePartialMessages` → `stream_event/content_block_delta/text_delta` → SSE, `agent-runner.ts:1808, 1912-1915`), so the streaming contract is honest token-level streaming, not sentence batching. The engine diff is small and enumerated (§12): bridge bearer-token auth, turn-abort on downstream disconnect (barge-in lock release — without it the per-thread lock queues the post-interruption turn behind a zombie turn), and `voice.livekit.*` config. This ticket also owns the two SIP steps 321 deferred: LiveKit outbound-trunk creation and Twilio origination URI + number→trunk assignment (which retires 321's interim TwiML forward — so inbound answering moves onto the same pipeline, and the cutover is sequenced last with a rollback). Vendor A/B (Flux/Nova-3 × Sonic/ElevenLabs) and PoC verdict gates are fully specified with measurable thresholds but **not run** — operator go required per D3.

## Key Points

- **Worker SDK = agents-js (Node/TypeScript), not Python** (§2 S1): matches the repo's language and conventions; plugin coverage for the entire A/B matrix is confirmed in agents-js (Deepgram `STTv2`/Flux with `turnDetection: "stt"`, Cartesia TTS, ElevenLabs TTS, Silero VAD). Python (1.6.x) remains the reference implementation and the documented fallback — the bridge is plain HTTP/SSE, so a worker-language swap never touches the engine. ⚠ Task-0 verifies agents-js parity for the four features we lean on (§5.4).
- **Bridge transport = the existing voice-adapter endpoint, not a new protocol** (§2 S2): inherits KPR-207/219/220/223/306/307 hardening for free — session resume + outer full-transcript retry, budget-saturation 503, circuit-open spoken outage notice — and keeps the worker thin. The worker sends `call.metadata.hive_agent_id`, which the adapter's existing resolution path (`voice-adapter.ts:501-517`) already handles.
- **Honest streaming statement:** token-level text deltas from the spawn path are live today, including pre-tool-call text mid-agentic-loop (a natural latency-masking hook 324 can use). The known gap is silence while a server-side tool runs — stated as a seam (§9.2), not solved here. No interim sentence-chunking contract is needed.
- **Media plane = LiveKit Cloud for the pilot** (§2 S3), self-hosted `livekit-server`+SIP documented as a later seam ⚠. The worker always runs on our Mac Mini regardless — W5's "self-hosted control" is the worker + hive authorship of every turn, not the SFU's physical location.
- **Barge-in has an engine-side correctness requirement** (§7): LiveKit truncates TTS locally and cancels the LLM stream; the bridge aborts the HTTP request; the engine must abort the in-flight spawn on socket close (E2), otherwise the `agentId:threadId` lock serializes the next turn behind the abandoned one. Transcript divergence (hive session text vs. actually-spoken prefix) is handled with a next-turn interruption marker ⚠.
- **SIP cutover is sequenced, reversible, and last** (§10): number→trunk assignment is mutually exclusive with 321's interim TwiML callback forward, so it flips only after P0/P1 pass; rollback = reassign the number back to the TwiML forward.
- **A/B matrix + PoC gates are designed, not run** (§14, §15): 2 STT × 2 TTS cells, N=5 scripted calls per cell on a dedicated test agent, metrics from LiveKit metrics events (EOU delay, LLM TTFT, TTS TTFB, total perceived latency) plus WER-proxy, false-interrupt rate, and cost/min; verdict rule = quality floor, then latency, cost as tie-break. Latency thresholds are placeholders ⚠ pending KPR-323's blessed baseline.
- **Ops preconditions mirror 321's Track-A pattern** (§16): May creates the LiveKit Cloud, Deepgram, Cartesia, and ElevenLabs accounts and seeds API keys into Honeypot; agents never create accounts or see raw secrets.
- ⚠-flagged delegated assumptions collected in §19 (inbound default agent, interruption-marker format, test-agent identity, stock voices, threshold placeholders, PoC-only transcript artifact for WER scoring).

## 1. Problem / context

Today's voice path is Vapi-hosted: Vapi owns telephony + STT + TTS + turn-taking, and calls back into hive's voice adapter (`src/channels/voice/voice-adapter.ts`) as an OpenAI-compatible "custom LLM," so the hive agent already authors every turn on Mokie's line. W5 pilots the LiveKit cascaded stack as the self-hosted-control alternative for **outbound vendor calls** (Nora — purchasing/ops; Sige — production support): we compose the pipeline ourselves (LiveKit room + SIP, Deepgram STT, Cartesia/ElevenLabs TTS), keep the hive agent as the author of every turn, and gain component-level control (vendor A/B, latency attribution, barge-in tuning) that Vapi abstracts away. KPR-321 delivers the Twilio line + Elastic SIP trunk shell; this ticket designs the worker that turns that trunk into live calls and the bridge that makes hive's spawn path the pipeline's LLM node. The incumbent Vapi path is untouched and coexists (non-goal: migration — the KPR-325 pilot verdict decides that later).

## 2. Decisions

| # | Decision | Rationale | Rejected alternatives |
|---|---|---|---|
| S1 | Worker in **agents-js** (Node/TS), version 1.5.x line | Repo is TS; `createLogger`-style conventions and config loader reusable; full plugin coverage for the matrix confirmed (deepgram `STTv2` Flux ✓, cartesia ✓, elevenlabs TTS ✓, silero VAD ✓); one runtime on the appliance | Python (1.6.x): reference impl, richest plugin set — kept as documented fallback since the bridge contract is language-agnostic HTTP/SSE; rejected as primary for runtime sprawl (pip/uv + Python launchd service on a TS appliance) |
| S2 | Bridge = worker-side custom `llm.LLM` → hive's existing `POST /v1/chat/completions` SSE endpoint on `127.0.0.1:<voice.port>` | Endpoint is battle-tested via Vapi; resume/retry/budget/breaker semantics inherited; engine diff minimal; A/B and 323/324 seams unaffected | (a) New WebSocket protocol into AgentManager — duplicate hardening, new surface to secure; (b) in-process worker inside the engine (tempting since agents-js is Node) — couples real-time media to engine lifecycle (restart = dropped calls), violates process-isolation conventions; the S1 language pick keeps this door open later |
| S3 | Media plane = **LiveKit Cloud** for the pilot (managed SIP endpoint + SFU) | Zero SFU/SIP-server ops for a pilot; SIP endpoint (`sip:<subdomain>.sip.livekit.cloud`) exists day one | Self-hosted livekit-server + livekit-sip on the Mini — real end-state candidate for the appliance vision; deferred: two more services + TURN/certs before a single pilot call. Documented seam: trunk/dispatch config is API-identical; revisit after the 325 verdict ⚠ |
| S4 | Worker = separate launchd service `com.hive.<instance>.voice-worker`, source in-repo at `src/voice-worker/`, runs **unbundled** (`node dist/voice-worker/main.js` from tsc output + node_modules) | Crash isolation from engine; independently restartable (`launchctl kickstart`); native deps (`@livekit/rtc-node`, Silero ONNX runtime) make esbuild single-file bundling hostile — the KPR-183 shim-guard/native-binary lesson says don't fight it | Bundling into `pkg/` like the engine (native-addon extraction pain); separate npm package (premature — pilot-stage code rides the engine repo) |
| S5 | Post-cutover, **inbound** calls to the 321 number are answered by the same pipeline (LiveKit inbound trunk + dispatch rule → worker → hive agent) | Number→trunk assignment removes Twilio Programmable Voice routing, so 321's interim TwiML forward dies at cutover; an answering agent is strictly better than dead air and reuses 100% of the outbound pipeline | Keeping the TwiML forward (impossible post-assignment — mutually exclusive, per 321 §8); voicemail-only (worse than an agent; more Twilio-side config) |
| S6 | Barge-in: worker-side stream cancellation + **engine-side turn abort on socket close** (E2) + next-turn interruption marker | See §7 — without E2 the per-thread lock is a latency landmine; the marker closes the spoken-vs-generated transcript divergence cheaply | Engine ignores disconnects (status quo): zombie turns burn tokens and block the lock; full server-side truncation reconciliation (rewriting SDK session history): disproportionate for a pilot |
| S7 | A/B cell selection = per-dispatch metadata override with config defaults (`voice.livekit.defaultStt` / `defaultTts`) | Whole matrix runnable without redeploys or config flips; the cell is pinned per call and recorded in telemetry | Config-only (4 restarts per matrix run); per-agent fields (wrong axis — the cell is an experiment variable, not agent identity) |

## 3. Architecture

```
                        ┌─ Mac Mini (dodi instance) ──────────────────────────────┐
 PSTN ── Twilio Elastic │  ┌────────────────────────────┐   ┌────────────────────┐ │
 (vendor │ SIP trunk    │  │ voice worker (launchd)     │   │ hive engine        │ │
  phone) │ (KPR-321)    │  │  @livekit/agents worker    │   │ (launchd)          │ │
         ▼              │  │  ┌──────────────────────┐  │   │                    │ │
   LiveKit Cloud ◄──────┼──┼─►│ AgentSession per call│  │   │ voice adapter      │ │
   (SFU + SIP           │  │  │  STT: deepgram       │  │   │ :<voice.port>      │ │
    endpoint)           │  │  │  turn detection      │  │   │  /v1/chat/         │ │
                        │  │  │  LLM: HiveLLM ───────┼──┼──►│  completions (SSE) │ │
                        │  │  │  TTS: cartesia/11labs│  │   │   │ dispatcher     │ │
                        │  │  └──────────────────────┘  │   │   ▼ .routeVoiceTurn│ │
                        │  └────────────────────────────┘   │ AgentManager       │ │
                        │                                   │  .spawnTurn        │ │
                        │                                   │   → AgentRunner    │ │
                        │                                   │     query() +MCPs  │ │
                        └───────────────────────────────────┴────────────────────┘
```

**Components (all net-new code under `src/voice-worker/` unless marked engine):**

- `src/voice-worker/main.ts` — worker entry: `defineAgent` + `cli.runApp` with `agentName: "hive-voice"` (explicit dispatch — no auto-dispatch). Parses job metadata, builds the `AgentSession` with the vendor cell (S7), creates the SIP participant for outbound jobs, runs the call.
- `src/voice-worker/hive-llm.ts` — the bridge: `HiveLLM extends llm.LLM`, whose `chat()` returns a `HiveLLMStream` that POSTs to the engine and yields `ChatChunk`s from SSE deltas (§5).
- `src/voice-worker/config.ts` — reuses the engine's config loader (`hive.yaml` + `.env` + Honeypot `secret-env` resolution at boot). The worker resolves `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY`, `LIVEKIT_API_KEY/SECRET`, `HIVE_VOICE_BRIDGE_TOKEN` from Keychain exactly the way the engine does; cloud-model agents never see them.
- `scripts/livekit-setup.ts` — one-shot idempotent setup (operator-run): creates the LiveKit outbound trunk, inbound trunk, and dispatch rule from 321 §8 artifacts (§10). Trunk credential values are resolved from Honeypot inside the invocation per the 321 §9 pattern — never echoed.
- **Engine (small diff, §12):** bridge auth (E1), abort-on-disconnect (E2), config keys (E3), optional initiation MCP tool (E4).

**Deployment:** launchd label `com.hive.<instance>.voice-worker`, `KeepAlive`, logs to the instance log dir; restart primitive is `launchctl kickstart -k` per repo convention. Dev mode: `npx tsx src/voice-worker/main.ts dev`. The worker heartbeats `kind=voice_worker_stats` to `db.telemetry` every 30s (matches the KPR-213/220/294 heartbeat convention) so `hive doctor` can surface it.

**Call initiation (outbound):** pilot-baseline is operator CLI — `lk dispatch create --agent-name hive-voice --metadata '{"hive_agent_id":"...","to":"+1...","goal":"...","context":"...","stt":"...","tts":"..."}'`. The worker's entrypoint reads the metadata, creates the room's SIP participant via `CreateSIPParticipant` (`sipTrunkId` from config, `sipCallTo` = `to`, `waitUntilAnswered: true`), and starts the session when answered. E4 (optional) wraps the same dispatch call as a `voice_call` MCP tool with the exact schema of the Vapi tool (`src/voice/voice-mcp-server.ts:53-64` — `to`/`goal`/`context`) so agent-initiated calls work identically; it may land here or with 325 at delivery discretion.

## 4. Turn lifecycle — where text enters and leaves hive

Numbered end to end for one conversational turn on a live call:

1. **SIP audio in.** Caller audio flows PSTN → Twilio trunk → LiveKit SIP endpoint → room; the worker's `AgentSession` receives the audio track.
2. **STT + turn detection.** Cell-dependent: Flux (`deepgram.STTv2`, `turnDetection: "stt"`) emits turn-complete transcripts with model-integrated end-of-turn detection; Nova-3 emits streaming transcripts with Silero VAD + turn-detection logic deciding end-of-turn. Either way, the session commits the user's utterance to its `ChatContext` and fires the LLM node.
3. **Bridge request (text enters hive).** `HiveLLM.chat()` serializes the session `ChatContext` to the OpenAI messages array (full transcript every turn — a hard contract requirement, see §5.2) and POSTs to `http://127.0.0.1:<voice.port>/v1/chat/completions` with `stream: true`, `Authorization: Bearer <HIVE_VOICE_BRIDGE_TOKEN>`, and `call: { id: <callId>, metadata: { hive_agent_id, goal, context } }`. This HTTP body is the exact seam where conversational text enters the engine.
4. **Engine spawn path (unchanged).** The voice adapter resolves the agent (existing `call.metadata.hive_agent_id` path), builds the voice system prompt (`buildVoiceSystemPrompt` — soul + role + memory + call goal/context; the worker's local Agent instructions are deliberately unused, see §5.3), resolves the stored SDK session for `threadId = voice:<callId>`, picks resume-vs-full-transcript prompt (`conversation-prompt.ts`), and routes `dispatcher.routeVoiceTurn(ctx, onStream)` → `AgentManager.spawnTurn` (per-thread lock `agentId:threadId`, per-agent budget, circuit breaker) → `AgentRunner.send` → SDK `query()` with `resume` + `includePartialMessages: true`. The agent runs with its full MCP toolkit server-side.
5. **Streaming out (text leaves hive).** Each `stream_event/content_block_delta/text_delta` invokes `onStream(text)` (`agent-runner.ts:1912-1915`), which the adapter writes as an OpenAI SSE chunk (`choices[0].delta.content`). The SSE stream is the exact seam where text leaves the engine.
6. **ChatChunk conversion.** `HiveLLMStream` parses SSE lines and yields `ChatChunk { id, delta: { role: "assistant", content } }` per delta; `data: [DONE]` ends the stream.
7. **TTS + audio out.** The session's TTS node (Cartesia or ElevenLabs, streaming) synthesizes from the chunk stream; audio flows room → LiveKit SIP → Twilio → PSTN. The session appends the assistant message (as actually spoken, truncated on interruption) to `ChatContext`.
8. **Turn close.** Engine logs "Voice turn complete" (existing telemetry: `firstTokenMs`, `totalMs`, resume flags); worker logs its per-turn metrics line (§13); session store holds the (possibly rotated) SDK session id for the next resume.

**First turn (outbound special case):** on `waitUntilAnswered` success the worker triggers an initial generation with an empty user transcript. The messages array then has no user/assistant turns, which lands in `renderConversationPrompt`'s empty branch — "The caller has just connected. Greet them as the agent." — so the hive agent authors the opening line under its call goal. This matches the existing Vapi behavior exactly; no new engine code.

**Latency budget (design estimates ⚠ — PoC measures, §15 P2):**

| Segment | Estimate | Owner |
|---|---|---|
| End-of-utterance detection | ~260ms p50 (Flux, vendor-claimed) / higher for Nova-3+VAD | §14 A/B |
| Bridge hop (localhost HTTP + serialize) | ~1–5ms | this ticket |
| Hive spawn → first token (`firstTokenMs`) | **dominant term, deliberately unoptimized here**; baseline = KPR-323's blessed read-only audit | KPR-323 |
| TTS TTFB | ~40–90ms (Sonic, vendor-claimed) / ~75–150ms (ElevenLabs Flash) | §14 A/B |
| Media transit (LiveKit Cloud ↔ Twilio ↔ carrier) | ~50–150ms | infrastructure |

## 5. Bridge contract — ChatChunk / delta streaming

### 5.1 Streaming granularity (honest statement)

True token-level streaming from the spawn path **is surfaced today**: `AgentRunner.send` sets `includePartialMessages: !!onStream` (`agent-runner.ts:1808`) and forwards every `text_delta` to the stream callback (`agent-runner.ts:1912-1915`); the voice adapter relays each delta as an SSE chunk (`voice-adapter.ts:272-289`). No interim sentence/message-level chunking contract is required. Granularity properties the worker must handle:

- **Deltas span the whole agentic loop.** Text the model emits *before or between* server-side tool calls streams out and gets spoken as it arrives ("let me check that for you…"). This is a feature — it is the natural masking hook KPR-324 will build on — but it means the worker must not assume one contiguous burst per turn.
- **Inter-chunk gaps during tool runs.** While a tool runs server-side, no deltas flow; TTS drains its buffer and the line goes quiet. v1 does nothing active here (KPR-324's lane, §9.2); the worker measures `maxInterChunkGapMs` per turn so 324 has data.
- **Text-only, v1.** No `tool_calls` ever cross the bridge in either direction: hive runs tools inside the spawn; the worker sends no `tools` array; `formatSSEToolCallChunk` exists in the translator but is unused on this path. LiveKit-side function tools are out of scope.
- **Thinking is never streamed** — only `text_delta` passes the filter; no chain-of-thought leaks to TTS.
- **Degenerate turn:** SSE `[DONE]` with zero content chunks (e.g. zero-content resume turn) → the stream ends empty; the worker treats it as no-reply and does not synthesize.
- **Markdown residue:** the voice system prompt already instructs spoken-style output; the worker applies a light TTS text normalization (strip markdown emphasis/links) as a defensive filter ⚠ verify plugin-native handling at PoC.

### 5.2 Request contract (worker → engine)

- `POST /v1/chat/completions`, `stream: true` always.
- `Authorization: Bearer <HIVE_VOICE_BRIDGE_TOKEN>` (E1).
- `messages`: the **complete** session transcript every turn, OpenAI-shape (system message optional and ignored by the engine). Full-transcript-always is load-bearing: the engine's resume path only extracts the latest user message, but the outer retry (`voice-adapter.ts:337-351`) re-renders the *entire* array when a stale SDK session fails — a delta-only sender would break crash recovery.
- `call.id`: stable per call — the LiveKit room name (`call-<uuid>`). Drives `threadId = voice:<callId>` and session continuity (§6).
- `call.metadata`: `{ hive_agent_id, goal, context }` — same fields the Vapi flow threads today (`voice-mcp-server.ts:87-92` → `voice-adapter.ts:243-246`); `goal`/`context` come from the dispatch metadata and are injected into the voice system prompt engine-side.
- No `tools`, no `model` (the agent definition's model governs; the engine ignores the field for routing).

### 5.3 Prompt authority

The **engine owns the prompt**. `buildVoiceSystemPrompt` (soul + role + memory + call goal/context, minus tool summaries) is assembled per turn engine-side and injected via `TurnContext.systemPromptOverride` (`agent-manager.ts:79-86`); system messages arriving in the request body are dropped (`conversation-prompt.ts:6-7`). The worker's LiveKit `Agent` instructions are set to a one-line placeholder and documented as intentionally unused — nobody should "fix" agent behavior by editing worker code.

### 5.4 Response contract (engine → worker) + Task-0 verify list

- SSE chunks: `choices[0].delta.content` strings → `ChatChunk.delta.content`, yielded immediately (never buffered — buffering kills the stream, the canonical custom-LLM mistake).
- `data: [DONE]` → close stream, turn complete.
- Non-200 / spoken-notice / mid-stream error semantics: §8.
- Implementation surface: subclass `llm.LLM` (preferred — composes with session-level features like preemptive generation) with `llmNode`-override (`ReadableStream<llm.ChatChunk>`) as the fallback shape. ⚠ **Task-0 (delivery) pins exact agents-js class shapes and verifies parity for:** (1) `deepgram.STTv2` Flux + `turnDetection: "stt"`; (2) turn-detector model plugin for the Nova-3 cell (fallback: VAD/endpointing-only turn detection — an accepted A/B validity caveat); (3) false-interruption resume options; (4) preemptive generation availability in agents-js 1.5.x (nice-to-have; not load-bearing for any gate).

## 6. Session / thread mapping and resume

| Layer | Identity | Lifetime |
|---|---|---|
| LiveKit room | `call-<uuid>` (created at dispatch) | one call |
| Bridge `call.id` | = room name | one call |
| Hive thread | `threadId = voice:<callId>` (existing scheme, `voice-adapter.ts:236`) | one call |
| SDK session | session store keyed `(agentId, threadId)`; resume per turn; id may rotate post-compaction | call + 2h TTL sweep (`voice-adapter.ts:38`) |

Consequences, all inherited from the existing path: turns within one call serialize on the per-thread lock (correct — turns are sequential by nature); concurrent calls for the same agent occupy distinct threads and are bounded by the spawn budget (default 5 → max 5 simultaneous calls per agent; ample for the pilot); resume failure triggers the outer full-transcript retry, and the `sdkSessionResumed` telemetry flag keeps its KPR-207-era semantics. A new call is always a new thread — no cross-call session bleed. Post-call, the SDK session ages out via the 2h sweep; call summaries/memory writes are the agent's own affair (its structured-memory reflection runs post-quiescence as with any channel).

## 7. Barge-in semantics at the bridge

**Worker side (LiveKit-native):** VAD detects caller speech during agent audio (explicit Silero VAD stays configured even in the Flux cell — Flux's turn detection does not replace interruption detection); the session interrupts playback, truncates the assistant message in `ChatContext` to what was actually spoken, and cancels the LLM node's stream. False-interruption handling (VAD fires, no transcript materializes) uses the framework's pause-and-resume behavior where available (§5.4 Task-0 item 3).

**Bridge behavior on cancellation:** `HiveLLMStream` aborts the in-flight HTTP request (undici `AbortController`) the moment the framework cancels the stream.

**Engine side (E2 — required change):** today, nothing in the adapter observes a client disconnect; the spawn runs to completion into a dead socket. Two concrete harms found in the code path: (a) wasted generation/tool tokens, and (b) **the per-thread lock stays held** — `withSpawnTicket` serializes on `agentId:threadId` (`agent-manager.ts:681-688`), so the caller's *post-interruption* utterance spawns a turn that spins in the 25ms lock-wait loop until the zombie turn finishes. Barge-in responsiveness would be bounded by the remaining runtime of the very turn the caller cut off. E2 wires `res.on("close")` (pre-completion) → abort the in-flight turn via the AgentManager/AgentRunner abort surface (ticket-lifecycle abort exists for stop/abort; exact call pinned at Task-0), scoped to the voice channel. Post-abort session state is recoverable by construction: the next turn's resume either works or trips the existing outer full-transcript retry. P3 (§15) verifies both the release latency and the resume behavior empirically.

**Transcript divergence (⚠ delegated design default):** after an interruption, hive's SDK session believes it said the full generated text; the caller heard a prefix. LiveKit's truncated `ChatContext` knows the spoken prefix. Because the resume path only reads the latest user message, the divergence would silently persist. v1 mitigation: when the previous agent turn was interrupted, the worker prefixes the next user message with a compact marker — `[caller interrupted you mid-sentence; they heard your reply only up to: "…<last ~15 words spoken>"]` — inside the user text, so it flows through `extractLatestUserMessage` unchanged, costs no engine work, and E2's abort means the un-spoken tail was mostly never generated anyway. Format/wording is a delivery-tunable ⚠.

## 8. Error / fallback behavior

| Failure | Engine behavior (existing) | Worker/bridge behavior (designed) |
|---|---|---|
| Provider circuit **open** (W2 breaker, live-by-default on main, KPR-306/307) | Fast-fail → **200 with spoken outage notice** as a normal completion (`VOICE_OUTAGE_SPOKEN_NOTICE`, `voice-adapter.ts:354-364`) | Flows through TTS like any turn — the caller hears the honest outage line. The bridge inherits W2 outage behavior with zero new code. Note: the voice channel speaks the notice; it does not enqueue to the outage queue (real-time channel semantics, unchanged) |
| Spawn budget exceeded | 503 "Voice temporarily unavailable" (`voice-adapter.ts:375-383`) | Speak configured fallback line ("Sorry — give me one second." class); retry the turn once after 2s; on second failure, speak an apology-and-callback line and end the call gracefully |
| Auth/OAuth failure engine-side | 503 "Voice unavailable" (`voice-adapter.ts:366-374`) | Same as budget handling, but no retry (auth won't heal in-call); apologize + end call |
| Other spawn failure | 500 after internal resume-retry | Retry once (the engine's own outer retry already ran); then apologize + end call |
| Engine down (connection refused) | — | Speak fallback from a canned local line (TTS is still up), end call, mark telemetry `outcome=engine_unreachable` |
| Mid-stream socket error after first byte | SSE error close (`formatSSEDone(..., "error")`) | Treat delivered text as the turn (it was spoken); log `errors[]`; continue call |
| LiveKit Cloud / SIP failure | — | Call setup fails or drops; dispatch caller (CLI/E4 tool) surfaces the error; no engine involvement |
| Worker crash | — | launchd KeepAlive restarts it; in-flight calls drop (accepted pilot posture); heartbeat gap makes it visible in `hive doctor` |

Fallback spoken lines are static worker config — never LLM-generated (they exist precisely for when the LLM path is broken) and never logged with call content.

## 9. Seams for the adjacent lanes (stated, not designed)

### 9.1 KPR-323 — warm path (spawn-side latency)
The bridge treats hive TTFT as an opaque term behind the HTTP surface. Contract: 323 may change *anything* behind `POST /v1/chat/completions` (subprocess pooling, session pre-warm, prompt-prefix reuse) without the bridge noticing — the seam is the HTTP boundary plus the decomposed per-turn telemetry (§13: `eouDelayMs` / `llmTtftMs` / `ttsTtfbMs` / `totalToFirstAudioMs`), which attributes latency to the spawn term so 323's improvements are measurable through the same pipeline. This spec deliberately does not optimize spawn latency; §15 P2's threshold references 323's blessed baseline rather than re-measuring the current path.

### 9.2 KPR-324 — mid-call tools + latency masking
Statement of the surface only (324 designs the contracts):
- **Where a tool call happens:** inside the hive spawn turn, server-side, between streamed text segments. The bridge contract is text-only; `tool_use` never crosses it in v1.
- **What the bridge does during tool latency:** nothing active — the delta stream pauses, buffered TTS drains, the line goes quiet. The worker measures `maxInterChunkGapMs` per turn.
- **Levers available to 324 without breaking the bridge contract:** (a) hive-side pre-tool acknowledgment text (already streams and is spoken — prompt- or code-shaped); (b) worker-side gap-triggered filler (`session.say` / background "thinking" audio where the SDK provides it); (c) engine-side per-turn `toolCalls`/`toolMs` telemetry already carried in `TurnResult` (`agent-manager.ts:116-119`). Choosing and contracting the mechanism is 324's scope.

## 10. SIP wiring owned by this ticket (consumes KPR-321 §8)

321 delivers: Twilio account + API key pair (Honeypot), E.164 number, Elastic SIP trunk shell + termination URI (`dodihome-ops.pstn.twilio.com` class), credential list attached by SID (values Honeypot-only), interim TwiML callback forward. 321 explicitly deferred **to this ticket**: the origination URI and the number→trunk assignment. Both are owned here, plus the LiveKit-side objects:

| # | Step | Side | Detail |
|---|---|---|---|
| SIP-1 | Create **outbound trunk** | LiveKit | `SIPOutboundTrunk`: `address` = 321's termination URI, `numbers` = [E.164], `authUsername`/`authPassword` = credential-list values resolved from Honeypot **inside** the `scripts/livekit-setup.ts` invocation (321 §9 pattern — piped into the API call, never echoed/logged). Record `sipTrunkId` → `voice.livekit.sipTrunkId` |
| SIP-2 | Create **inbound trunk** | LiveKit | `SIPInboundTrunk` restricted to our E.164 (and optionally Twilio source IPs); krisp-class noise cancellation enabled if available on the plan ⚠ verify |
| SIP-3 | Create **dispatch rule** | LiveKit | Individual-room rule (`call-` prefix) with room config dispatching `agentName: "hive-voice"` — inbound calls spawn a worker job; worker resolves the hive agent from `voice.livekit.inboundAgents` (E.164 → agentId map; ⚠ delegated default: `nora`) with a generic "vendor callback" goal/context |
| SIP-4 | **Origination URI** on the Twilio trunk | Twilio | `sip:<project-subdomain>.sip.livekit.cloud;transport=tcp` (value from the LiveKit project settings); TLS (`;transport=tls`) + SRTP documented as the secure-trunking upgrade, not required for the pilot ⚠ |
| SIP-5 | **Number→trunk assignment** (cutover) | Twilio | Assign the E.164 to the Elastic SIP trunk. **Mutually exclusive with 321's interim TwiML forward — this retires vendor-callback forwarding to Quo**, replaced by S5 inbound answering. Sequenced LAST: only after §15 P0+P1 pass. Rollback: reassign the number to the TwiML app (single console/API step); the trunk and LiveKit objects can stay in place, inert |

Sequencing: SIP-1 through SIP-4 are safe any time (they route nothing until SIP-5). All Twilio-side API steps use the 321-seeded API key pair under the same never-in-transcript invocation pattern; no step here requires May at the console (identity/spend gates all lived in 321), but SIP-5 is an operator-go moment because it changes live inbound behavior — bundled into the P-gate approvals (§15).

## 11. Config + secrets (reserved names)

`hive.yaml` (instance-level; loader stays liberal per KPR-225 F3):

```yaml
telephony:
  twilio:
    number: "+1..."                       # reserved by 321 §9, wired by E3
    trunkDomain: dodihome-ops.pstn.twilio.com  # reserved by 321 §9, wired by E3
voice:
  provider: vapi                          # UNCHANGED — Vapi coexists during the pilot
  livekit:
    enabled: true
    url: wss://<project>.livekit.cloud    # non-secret
    sipTrunkId: ST_...                    # from SIP-1
    inboundAgents:                        # E.164 → hive agent id (S5/W3)
      "+1...": nora
    defaultStt: deepgram/flux-general-en  # A/B cell defaults (S7)
    defaultTts: cartesia/sonic-3
```

Honeypot (`hive/dodi/<KEY>`, resolved env-first/Keychain-second at worker boot; never in cloud-model-facing context):

| Key | What | Created/seeded by |
|---|---|---|
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit Cloud project API pair (worker auth + setup script) | May (§16) |
| `DEEPGRAM_API_KEY` | STT (both cells) | May (§16) |
| `CARTESIA_API_KEY` | TTS cell A | May (§16) |
| `ELEVENLABS_API_KEY` | TTS cell B | May (§16) |
| `HIVE_VOICE_BRIDGE_TOKEN` | Shared secret, worker → voice adapter (E1); generated by May (`openssl rand -hex 32` class), seeded on both sides | May (§16) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID/SECRET`, `TWILIO_SIP_TRUNK_USERNAME/PASSWORD` | Already seeded by 321 A7; consumed by `scripts/livekit-setup.ts` (SIP-1, SIP-4, SIP-5) | 321 |

## 12. Engine-change inventory (the entire delivery-time engine diff)

| # | Change | Where | Size |
|---|---|---|---|
| E1 | Accept `Authorization: Bearer <HIVE_VOICE_BRIDGE_TOKEN>` as valid auth on `POST /v1/chat/completions` (alongside the existing assistant-mapping path; Vapi behavior untouched). Token via `secret-env` | `src/channels/voice/voice-adapter.ts`, `src/config.ts` | small |
| E2 | Abort the in-flight spawn when the response socket closes pre-completion (barge-in lock release, §7); suppress writes after close | `src/channels/voice/voice-adapter.ts` (+ verified abort surface on AgentManager/AgentRunner) | small, subtle — P3 verifies |
| E3 | `voice.livekit.*` + `telephony.twilio.*` config keys (§11) | `src/config.ts` | trivial |
| E4 (optional) | `voice_call` LiveKit-variant MCP initiation tool (same `to`/`goal`/`context` schema; creates a LiveKit agent dispatch instead of a Vapi call). May land with 325 | `src/voice/` | small |

Everything else is net-new worker code (`src/voice-worker/`, `scripts/livekit-setup.ts`) with no engine imports of LiveKit SDKs.

## 13. Observability (no message content, per repo posture)

- **Engine:** unchanged — "Voice turn complete" (`firstTokenMs`, `totalMs`, resume flags, `routedVia`) per turn; breaker/outage telemetry as on main.
- **Worker per-turn JSONL log line:** `{ ts, callId, turnSeq, direction: outbound|inbound, cell: {stt, tts}, eouDelayMs, llmTtftMs, maxInterChunkGapMs, ttsTtfbMs, totalToFirstAudioMs, interrupted, falseInterruption, errors[] }` — sourced from LiveKit metrics events (EOU/LLM/TTS metrics) plus bridge-measured timings. **No transcript text, no phone numbers** (callId only; the dialed number lives with the initiator, not in worker logs).
- **Worker heartbeat:** `kind=voice_worker_stats` upsert to `db.telemetry` every 30s `{ activeCalls, callsStarted, callsCompleted, lastError, cellDefaults }` — `hive doctor` surfaces it alongside the existing spawn-coordinator/prefix-cache sections.
- **Per-call summary:** one `kind=voice_call_stats` doc at call end `{ callId, agentId, cell, turns, interruptions, retries, outcome, durationMs, latency percentiles }` — the substrate for §14/§15 scoring and the 325 rubric.

## 14. Vendor A/B protocol — designed, NOT run (requires operator go at delivery/dispensation, D3)

### 14.1 Matrix

| | TTS-A: Cartesia Sonic (sonic-3) | TTS-B: ElevenLabs (eleven_flash_v2_5) |
|---|---|---|
| **STT-1: Deepgram Flux** (`flux-general-en`, `STTv2`, turn detection `stt`) | cell F×S | cell F×E |
| **STT-2: Deepgram Nova-3** (streaming + Silero VAD + turn-detector; §5.4 caveat) | cell N×S | cell N×E |

Vendor state as researched 2026-07-14 (⚠ all vendor-claimed until measured): Flux is the purpose-built conversational STT — model-integrated end-of-turn detection (~260ms p50 EOU at defaults), turn-complete transcripts, materially fewer false interruptions than VAD-pipeline approaches; Nova-3 is the transcript-accuracy control cell requiring external turn logic. Sonic-3 (SSM architecture) claims ~40ms model TTFA / ~90ms p90 delivered, ~$0.02–0.03/min-class pricing; ElevenLabs Flash v2.5 claims ~75ms model inference / ~150ms observed TTFA, ~$0.04–0.06/min-class, with the stronger voice-cloning ecosystem (relevant to future agent voice identity — pilot uses stock catalog voices ⚠; cloning is out of scope until the 325 verdict).

### 14.2 Method

- **Fixed scenario:** a scripted 10-turn vendor-style dialogue (order status + one lookup pause + two marked barge-in points), operator reads the caller side against the same dedicated test agent every run.
- **Test agent:** `voice-pilot` (Sonnet) — a purpose-made agent definition, NOT Nora's/Sige's live defs, so memory writes and post-quiescence reflection from ~200 test turns never pollute production agents ⚠.
- **Runs:** N=5 calls per cell × 4 cells (≈200 turns, ~40 min talk time), same day/window, engine warm, cell order randomized; cell pinned per call via dispatch metadata (S7) and recorded in telemetry. Estimated total vendor cost <$20 ⚠ verify at run time.
- **Everything pinned except the cell:** same agent def, model, goal/context, script, phone/handset, network.

### 14.3 Metrics per cell (from §13 telemetry + scoring artifacts)

| Metric | Measures | Source |
|---|---|---|
| EOU delay p50/p95 (`eouDelayMs`) | endpointing lag (STT axis) | LiveKit EOU metrics |
| False-interrupt rate; premature-cutoff count | turn-detection quality (STT axis) | per-turn flags + operator tally against script marks |
| WER-proxy | transcription accuracy (STT axis) | operator reads a fixed 200-word passage per STT cell in a transcribe-only worker mode; recognized text written to a **PoC-only local artifact, deleted after scoring** — an explicit, operator-approved exception to no-transcript logging ⚠ |
| TTS TTFB p50/p95 (`ttsTtfbMs`) | synthesis latency (TTS axis) | LiveKit TTS metrics |
| Perceived quality | naturalness (TTS axis) | operator MOS-style 1–5 rating on 10 fixed sentences per TTS cell |
| Total perceived latency p50/p95 (`totalToFirstAudioMs`) | end-of-user-speech → first agent audio | computed per turn |
| Cost/min | unit economics | vendor dashboards post-run + measured character/minute counts |

### 14.4 Decision rule (feeds §15 P4)

1. **Quality floors:** TTS cell mean MOS ≥ 3.5/5; STT cell false-interrupt + premature-cutoff ≤ 2 combined per 50 scripted turns and WER-proxy within 2 points of the better cell. Cells failing a floor are out.
2. **Latency:** among surviving cells, lowest `totalToFirstAudioMs` p50 wins each axis.
3. **Cost tie-break:** if two surviving cells are within 100ms p50, the cheaper one (>25% cost delta) wins.
4. Winner cell is recorded in the epic Decision Register and becomes 325's default stack; the loser stays wired (S7 metadata override) for pilot-time spot checks.

## 15. PoC verdict gates — designed, NOT run (each requires operator go at delivery/dispensation, D3)

| Gate | What runs | Pass criteria | Notes |
|---|---|---|---|
| **P0 — SIP smoke** | One outbound call to the operator's phone, best-guess cell (F×S) | Call connects; hive-authored greeting heard; two-way audio; clean hangup | First live use of SIP-1 through SIP-4; SIP-5 cutover NOT yet flipped |
| **P1 — conversation feasibility** | One full 10-turn scripted call | ≥90% of turns produce a spoken response; no worker crash; `sdkSessionResumed` true on ≥8 of 9 resume turns | Validates §4–§6 end to end |
| **P2 — latency** | 3 calls, best-guess cell, latency telemetry | `totalToFirstAudioMs` p50 ≤ **[323-baseline + 300ms]**, hard ceiling 2.0s p50 / 3.5s p95 ⚠ placeholders — bound to KPR-323's blessed baseline at delivery, not re-measured here | If P2 fails on the spawn term, that is 323's lane by design — record and proceed to P3/P4 only with operator dispensation |
| **P3 — barge-in** | Scripted interrupts (2 per call × 3 calls) | Agent audio stops ≤500ms after caller onset; post-interruption turn meets P2 bounds (proves E2 released the thread lock); next-turn resume survives the abort | The E2 correctness gate |
| **P4 — A/B verdict** | Full §14 matrix | §14.4 decision rule yields an STT and TTS winner; result recorded in epic Decision Register | Gates 325's stack choice |
| **SIP-5 cutover** | Number→trunk assignment (§10 SIP-5) | Inbound test call answered by the pipeline agent; rollback rehearsed once | Operator-go moment of its own — changes live inbound behavior for the vendor-announced number |

## 16. Ops preconditions (May — mirrors 321's Track-A pattern)

Agent guardrails prohibit account creation and secret handling in-session, so before delivery can run gates:

1. May creates a **LiveKit Cloud** account/project (pilot tier), generates the API key pair, and seeds `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` into Honeypot; the project SIP subdomain (non-secret) goes to `voice.livekit.url` + SIP-4.
2. May creates **Deepgram**, **Cartesia**, and **ElevenLabs** accounts (pilot/pay-as-you-go tiers), generates API keys, seeds them into Honeypot. Spend is pilot-scale (<$20 for §14; per-minute thereafter) — flag at creation, no standing budget needed.
3. May generates and seeds `HIVE_VOICE_BRIDGE_TOKEN`.
4. 321's Twilio artifacts (§8 there) must be **complete through B7** (trunk shell + credential list) before SIP-1 here.

No May console time is needed for SIP-1 through SIP-4 or the setup script; her go/no-go moments are the P-gates and the SIP-5 cutover (§15).

## 17. Non-goals

- **Warm-path/spawn-latency optimization** — KPR-323 (the seam is stated in §9.1; the dominant latency term is deliberately left alone).
- **Mid-call tool contracts and the masking mechanism choice** — KPR-324 (§9.2 states the surface only).
- **Call personas, pilot rubric, pickup-rate thresholds, vendor-call playbooks** — KPR-325.
- **Vapi migration or retirement** — the incumbent keeps running untouched; the 325 verdict decides.
- **Porting the Quo number** — explicitly customer-phase (321 canon).
- **Engine-wide provider-seam changes** — W3's lane (KPR-311/313); this spec touches the voice adapter only (E1–E3).
- **Voice cloning** for agent identity — noted as an ElevenLabs/Cartesia capability; pilot uses stock voices.
- **Answering-machine detection policy** — LiveKit offers AMD; whether/how to use it on vendor calls is 325's rubric.
- **Self-hosted LiveKit server/SIP** — documented seam (S3), not built.
- **SMS anything** — the line is voice-first (321).

## 18. W3 anchor hazard — Task-0 re-confirm at delivery (mandatory)

This design anchors to main @ W6. Wave W3 (epic branch kpr-309; matured, awaiting delivery re-open, NOT merged) reshapes the exact seam the bridge rides. Before any delivery work, Task-0 re-confirms these five surfaces against whatever has merged by then:

1. **`Dispatcher.routeVoiceTurn`** (`dispatcher.ts:752`) — KPR-311's router→adapter reshape may move or re-sign this; the bridge's engine entry depends on its taskLedger/audit semantics and dedup-skip.
2. **`TurnContext` / `spawnTurn` / session-store keying** — KPR-313's session-identity guards may alter resume semantics or the `(agentId, threadId)` keying that `threadId = voice:<callId>` and §6 depend on, including the outer-retry contract.
3. **Error taxonomy at the adapter** — the voice adapter currently string-matches `"Spawn budget exceeded"` and regex-matches auth failures (`voice-adapter.ts:24-29, 366-383`); if W3 lands typed errors via the provider-adapter classification layer, §8's rows re-bind to the typed forms.
4. **`TurnContext.systemPromptOverride` consumption** in `AgentRunner` — §5.3's prompt-authority claim rides on it surviving any W3 prompt-assembly moves.
5. **Circuit-breaker record/fast-fail placement** (KPR-306/307, on main) — §8's circuit-open row assumes fast-fail surfaces as `ProviderCircuitOpenError` catchable at the adapter; re-confirm if W3 relocates classification.

Plus the non-W3 pin: exact agents-js versions/class shapes (§5.4 Task-0 list).

## 19. Risks & delegated assumptions

- ⚠ **agents-js feature lag vs Python** — the four §5.4 items; mitigations pre-declared (Nova-3 cell falls back to VAD-only turn detection; Python worker is a drop-in behind the same bridge contract).
- ⚠ **LiveKit Cloud for the pilot** (S3) — new third-party dependency in the call path; self-host is the documented later seam. May confirms the account tier at §16.
- ⚠ **Inbound default agent = `nora`** (S5 / §10 SIP-3 map) — May confirms before the SIP-5 cutover; until cutover, 321's TwiML forward keeps handling callbacks.
- ⚠ **Latency thresholds in P2 are placeholders** pending KPR-323's blessed baseline (reference-only here by ruling).
- ⚠ **Interruption-marker format** (§7) — delivery-tunable wording.
- ⚠ **Test agent `voice-pilot`** for all A/B/PoC runs — never Nora's/Sige's live definitions.
- ⚠ **Stock TTS voices** chosen per persona at PoC; cloning deferred.
- ⚠ **WER-proxy artifact** — a PoC-only, operator-approved, deleted-after-scoring local transcript file; the sole exception to the no-transcript posture.
- ⚠ **Vendor numbers (latency, pricing) are vendor-claimed/secondary-sourced** as of 2026-07-14; the PoC measures, the console prices at run time.
- **Risk — E2 abort semantics:** aborting a `query()` mid-turn and resuming the session next turn is exercised by P3 before anything ships; the outer full-transcript retry is the designed safety net.
- **Risk — dual writers on the voice adapter:** Vapi and the worker share the endpoint during the pilot; E1 adds auth without touching Vapi's path, and thread ids can't collide (Vapi call ids vs `call-<uuid>` rooms). Re-verified in delivery tests.
- **Risk — real-time media on a busy Mini:** the worker shares the box with the engine, Mongo, and CI runner; process isolation (S4) contains crashes but not CPU contention. Pilot-scale (1–2 concurrent calls) is far below saturation; telemetry (§13) would show jitter.

## 20. Sources (checked 2026-07-14)

Hive code (lane worktree @ base): `src/channels/voice/voice-adapter.ts`, `src/channels/voice/conversation-prompt.ts`, `src/channels/voice/openai-translator.ts`, `src/agents/agent-manager.ts` (TurnContext/spawnTurn/lock/budget), `src/agents/agent-runner.ts:1780-1960` (includePartialMessages + text_delta streaming), `src/config.ts:408-433`, `src/voice/voice-mcp-server.ts`. Sibling contract: `docs/epics/kpr-320/kpr-321-spec.md` §8–§9.

External (docs-only, no installs/accounts/API calls): LiveKit — LLM node & custom LLM ([docs.livekit.io/agents/models/llm](https://docs.livekit.io/agents/models/llm/), [python llm.llm reference](https://docs.livekit.io/python/livekit/agents/llm/llm.html), [agents-js reference](https://docs.livekit.io/reference/agents-js/)), Twilio trunk setup ([docs.livekit.io/telephony/start/providers/twilio](https://docs.livekit.io/telephony/start/providers/twilio/)), outbound calls ([docs.livekit.io/sip/making-calls](https://docs.livekit.io/sip/making-calls/)), turn handling ([docs.livekit.io/reference/agents/turn-handling-options](https://docs.livekit.io/reference/agents/turn-handling-options/)), adaptive interruption blog; Deepgram — [Flux↔Nova-3 comparison](https://developers.deepgram.com/docs/flux/flux-nova-3-comparison), [Nova-3→Flux migration](https://developers.deepgram.com/docs/flux/nova-3-migration), [LiveKit integration (STTv2/Flux in both SDKs)](https://developers.deepgram.com/docs/livekit-integration); TTS comparisons — Cartesia vs ElevenLabs 2026 roundups (codesota.com, futureagi.com, cekura.ai, cartesia.ai/vs). Version state: agents-js 1.5.x / livekit-agents (Python) 1.6.x as of research date ⚠ exact pins at Task-0.
