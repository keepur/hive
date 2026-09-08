# KPR-324 — W5.4: Mid-call tools + latency masking + PO/order grounding contracts

**Epic:** KPR-320 (W5: Voice v2 — outbound vendor pilot). **Consumes:** KPR-322 §9.2 (stated-not-designed surface) and the **shipped** worker/bridge (`bbd9581`, PR #391); KPR-323 warm lease (`f0f4abd`, PR #395) as the in-call spawn path tools must be correct under. **Blocks:** KPR-325 (pilot — live vendor calls that look up order state). **Adjacent:** KPR-321 (ops telephony — not a code dep); W1B / KPR-300 (parked — implements the PO/order tools this spec defines). **Does not design:** KPR-325 personas/rubric.

**Program mode + D3 (Gate 1, 2026-07-13):** maturity-first — this lane ships spec only. Empirical protocols in §12 are **designed-but-not-run**; every live run **requires a recorded per-run operator go**.

**Gate 1 D2 (contract-first inversion):** this spec defines the PO/order grounding tool contracts during maturity. Parked W1B implements to those contracts whenever it unparks. **W1B's park does not block W5 maturity or this ticket's delivery of masking.**

**Anchor:** epic branch `kpr-320` @ `f0f4abd` (KPR-323 squash #395). Design against the shipped 322 worker/bridge and 323 warm lease, not against unmerged wishes. Decision-register canon that binds this ticket: E4 (`voice_call` initiation already shipped with 322 — not a mid-call tool); agents-js **1.6.4** lockstep; E2 `AgentManager.abortThread`; E1 bridge bearer; D3 empiricism still designed-not-run; TTS whitelist reconcile is 322 §14.1.1 / P4, not this ticket.

**Ticket shape:** code-design spec. The delivery-lane deliverable: (1) hive-side tool-start acknowledgment speech that fills the silent gap while a server-side tool runs on a live call, (2) the MCP tool contracts W1B later implements so a vendor call can be grounded in purchase-order state, (3) a test-only fixture so T-gates can run without W1B.

## TL;DR

Hive already runs MCP tools **inside** the voice spawn turn — the old Phase-2 `POST /v1/tools` endpoint was never built and is not needed. The 322 bridge is text-only; `tool_use` must not cross it. The remaining product gap is silence while a tool runs (TTS drains, the line goes quiet) plus the absence of a PO/order lookup the vendor-call agents can actually invoke. This spec fills the silence with a **hive-side, code-shaped acknowledgment** injected as ordinary SSE text at `tool_use` on **voice** turns when the model did not already speak, defines the **read-only `orders` MCP contract** for W1B, and ships a **voice-pilot-only fixture** so the masking can be verified without unparking W1B.

## Key Points

- **Tools stay server-side, text-only bridge unchanged (S1).** Verified against HEAD `f0f4abd`: no `/v1/tools` route exists; `formatSSEToolCallChunk` / `openaiToolsToClaude` are unused on the LiveKit path; `HiveLLM` ignores `toolCtx`; the LiveKit `Agent` is constructed with no function tools. Do not resurrect a second HTTP surface.
- **Primary masking = hive-side code-shaped tool-start ack (S2), not worker `session.say` and not prompt-only.** Inject a short canned phrase through the existing `onStream` → SSE `delta.content` path at `tool_use` iff this segment has no streamed assistant text **and** `channel === "voice"`. `onStream` alone is not the gate — chat that later streams must not speak `"One moment."` into Slack/SMS. Phrase rotation is a **caller-owned per-turn index** (local to each `send` / `consumeOneTurn`; not a process-global or per-lease counter) so concurrent calls do not skip/collide phrases. One helper, two call sites: `AgentRunner.send` (cold) and `WarmVoiceSession.consumeOneTurn` (warm). Vapi and LiveKit both speak it because both consume the same SSE.
- **Worker-side gap filler (322 lever b) waits (S3).** LiveKit-only, overlaps TTS with an in-flight LLM stream, and 322 already records `maxInterChunkGapMs` so we can reopen it with evidence. Prompt-only acknowledgment (lever a as prompt) is a complement in Voice Call Mode, never the load-bearing mechanism — models skip it.
- **Telemetry (322 lever c) is supporting, not masking (S4).** `TurnResult` already carries `toolCalls` / `toolMs` / `toolSummary`; the voice adapter's "Voice turn complete" line does not yet log them. `toolAckInjected` is **new** — it does not exist on `RunResult` or `TurnResult` today. Spawn loops write it on `RunResult`; `finalizeSpawnResult` copies it onto `TurnResult`; C5d then logs `TurnResult.toolAckInjected`. Chat `convertTurnResult` (`src/channels/dispatcher.ts`) must map `TurnResult.toolAckInjected` → `RunResult.toolAckInjected` (C5e) or `tsc` fails — C5a makes the field a required number and that helper's contract is every `RunResult` field mapped explicitly. Voice does **not** go through it (`routeVoiceTurn` returns `TurnResult` from `spawnTurn`). A spawn-loop-only counter would drop at the copy and C5d would log 0/undefined. No new protocol.
- **PO/order tools are a 324-defined contract, ⚠ W1B implements (S5 / D2).** Two read-only tools (`orders_lookup`, `orders_get`), spoken-prose results, voice-sized limits. Backing store / ERP identity is W1B's, not guessed here. Until W1B unparks, the `voice-pilot` test agent gets a fixture that returns the same result shape after a bounded delay.
- **Warm-lease correctness is a constraint, not a redesign (S6).** Tools already run inside the leased `query()`; barge-in stays 323's interrupt-and-keep-warm; hang-up still reclaims via idle timeout. Do not `ticket.abort()` a warm call because a tool is in flight.
- **In scope:** ack helper + both spawn loops, `RunResult`/`TurnResult.toolAckInjected` + `finalizeSpawnResult` copy + `convertTurnResult` mapping, voice-prompt supplement, adapter telemetry, `orders` contract, voice-pilot fixture + Mongo `coreServers` entitlement (runner wiring + `IN_PROCESS_PORTED_SERVERS`; **no** `SERVER_CATALOG.voice-fixture` key), T-gates (designed-not-run). **Out of scope:** 325 personas/rubric, 321 Twilio ops, redoing 322/323, `/v1/tools`, LiveKit function tools, worker `session.say` filler, mid-tool "still looking" loops, Lane B voice ack, production `orders` implementation, a live `SERVER_CATALOG.orders` or `SERVER_CATALOG.voice-fixture` key.
- **Risk — firstTokenMs shifts on silent-to-tool turns:** today those turns' first SSE byte is often *post-tool* text, so `firstTokenMs` includes `toolMs`. After S2 the ack is first audio and `firstTokenMs` drops to time-to-`tool_use`. Documented; 323's blessed baseline stays the no-tool comparand. T-gates split tool-turns vs text-only.
- ⚠ **W1B backing store is unknown** (no KPR-300 spec in this repo; OSS hive has contacts + conversation-search, not POs). Contract is the MCP surface; storage/API is W1B. Does not block masking delivery.

## 1. Problem / context

W5's vendor-call agents (Nora — purchasing/ops; Sige — production support) must look things up *during* a live PSTN call: "what's the status of PO 45021?" Today's stack can already *execute* that lookup if the agent has an MCP tool — `AgentRunner.send` / `WarmVoiceSession.consumeOneTurn` observe `assistant` / `tool_use`, time it, and keep streaming only `text_delta` to the voice adapter. The 322 worker measures the resulting pause as `maxInterChunkGapMs` and does nothing about it (322 §5.1, §9.2). The caller hears the pre-tool sentence if the model happened to produce one, then dead air while the tool runs, then the answer.

Two stacked gaps:

1. **Latency masking is uncontracted.** 322 listed three levers and left the choice to this ticket. Silence on a vendor line is a pickup-quality problem for 325.
2. **There is no PO/order tool.** CLAUDE.md still names `crm-search` / `product-search` / `ops-search`; those servers are not in this engine (test fixtures aside). Contacts can identify a vendor; they cannot ground a purchase order. W1B (KPR-300) was supposed to grow those endpoints and is parked. D2 inverted the dependency: 324 writes the contract, 300 implements later.

A third historical confusion is in the ticket text: "the Phase-2 `/v1/tools` endpoint doesn't exist." That was a Vapi-shaped design where the *client* would execute tools over a second HTTP route. The shipped architecture made it obsolete — hive is the LLM node and runs tools itself. `conversation-prompt.ts` still skips `role: "tool"` messages as a "Phase-2 concern"; `openai-translator.ts` still has unused tool-call SSE helpers. Leave both inert.

## 2. Decisions

| # | Decision | Rationale | Rejected alternatives |
|---|---|---|---|
| **S1** | **No `tool_use` on the bridge; no `/v1/tools`.** Tools execute inside the hive spawn. Worker sends no `tools` array; engine streams only `choices[0].delta.content`. | Honors 322 §5.1 / §9.2; verified absent at `f0f4abd`. A second endpoint would duplicate spawn/auth/abort and leak tool names/args onto a voice HTTP surface. | (a) Resurrect `/v1/tools` for Vapi/LiveKit to execute client-side — fights hive-authors-every-turn; (b) LiveKit function tools on the worker `Agent` — splits authorship, needs a round-trip back into hive, breaks the text-only contract |
| **S2** | **Primary mask = code-shaped hive-side ack** injected via `onStream` at `tool_use` when the current segment has no streamed text. Shared pure helper; cold + warm call sites. Phrase rotation is a **caller-owned per-turn index**, not a process-global counter. | One place covers Vapi + LiveKit + warm + cold. Uses the stream the worker already speaks. Does not require agents-js thinking-audio or `session.say` overlapping an in-flight `HiveLLMStream`. Concurrent calls each own their rotation index. | (a) Prompt-only "always say wait" — unreliable, already the natural hook 322 noted, not load-bearing; (b) worker gap-timer + `session.say` — LiveKit-only, duplex-with-LLM-stream, 322 lever reserved as fallback; (c) telemetry-only — cannot speak |
| **S3** | **Defer worker-side filler** until T-gates show the ack does not cover long lookups. | YAGNI. `maxInterChunkGapMs` is already on the worker JSONL line (`hive-llm.ts` / `telemetry.ts`). Reopen with numbers, not speculation. | Ship both mechanisms in one ticket — doubles surface for a pilot |
| **S4** | **Log `toolCalls` / `toolMs` / `toolSummary` / `toolAckInjected` on "Voice turn complete".** No new collection. | Lever (c) as observability so T-gates and 325 can attribute pauses. `toolCalls` / `toolMs` / `toolSummary` already exist on `TurnResult` (`agent-manager.ts:146-148`); **`toolAckInjected` does not** — add it on `RunResult` (required number, default 0), copy it in `finalizeSpawnResult`, then log `TurnResult.toolAckInjected`. Chat `convertTurnResult` must map the field back onto `RunResult` (C5e) or `tsc` fails; voice logs `TurnResult` directly. The adapter omits the existing three today (`voice-adapter.ts:532-550`). | New `kind=voice_tool_stats` heartbeat — premature; per-turn line is enough |
| **S5** | **`orders` MCP contract in this spec; W1B implements; 324 ships a `voice-fixture` test double only.** | D2. A stub that always errors on production agents would train Nora to apologize. A fixture on `voice-pilot` only lets T-gates run. | Implement a fake production `orders` server in the OSS engine; guess HubSpot/QuickBooks/Mongo as the source of truth |
| **S6** | **Warm path: tools stay inside the leased `query()`; barge-in during a tool is 323 `abortThread` → `interrupt()`, lease stays warm.** | 323 already: deltas pause during tools exactly as on cold; interrupt-and-keep-warm is the barge-in/hang-up contract. 324 must not invent a tool-abort protocol or close the lease because a tool is running. | `ticket.abort()` on tool-in-flight (kills the call); worker-side cancel of hive tools |
| **S7** | **Ack phrases are constants; `voice.toolAck.enabled` is the rollback lever** (literal `false` disables; absent/garbage → **on**). | Inverse of 323's warm-path default-off: masking *is* the ticket. One boolean, no phrase config, no gap-threshold knobs. | Per-agent phrase lists (325 persona work); gap-ms config (that's lever b) |
| **S8** | **Voice prompt omits the full toolkit dump; adds a short Voice-tools paragraph.** | `buildVoiceSystemPrompt` correctly skips KPR-87 toolkit (spoken-style, prefix-cache). SDK still attaches MCP schemas, so the model can call tools. A 6-line guardrail is enough: acknowledge, speak results, don't start browser/code-task/background on a live call. | Restore full toolkit + delegate catalog into the voice prefix (tokens + not spoken-style) |

## 3. What already ships (do not rebuild)

End-to-end at `f0f4abd`:

```
Caller utterance
  → worker STT / Vapi STT
  → POST /v1/chat/completions  (text-only; E1 bearer; E2 close → abortThread)
  → spawnTurn  (warm lease if eligible, else cold AgentRunner.send)
  → SDK query() with the agent's coreServers MCP attached
  → text_delta  → onStream → SSE → worker ChatChunk → TTS
  → [tool_use: deltas pause; TTS drains; LINE GOES QUIET]   ← this ticket
  → tool result → more text_delta → TTS
```

| Surface | Behavior today | 324 implication |
|---|---|---|
| `HiveLLM.chat()` | Accepts 1.6.4 `toolCtx` / `toolChoice` (`hive-llm.ts:62-75`); `toolCtx` is unused | Keep ignoring `toolCtx`. Never add LiveKit function tools to `new voice.Agent({ instructions })` (`session.ts:201-206`) |
| `HiveLLMStream.run()` | POST body has **no `tools` key** (`hive-llm.ts:136-154`). Yields content SSE only; records `maxInterChunkGapMs` between chunks | Unchanged. An injected ack is just another content chunk — the gap metric should fall on tool-turns if S2 works |
| Voice adapter `onStream` | Relays pre-extracted text strings as `formatSSETextChunk`; skips empty; suppresses after E2 close | Unchanged shape. Ack is an ordinary chunk. **Do not** start writing `formatSSEToolCallChunk` |
| `conversation-prompt.ts` | Drops `role: "tool"` / `system`; resume uses latest user text | Unchanged. Bridge never carries tool messages, so the skip stays dead code, not a bug |
| `AgentRunner.send` | `includePartialMessages`; forwards only `text_delta`; times `tool_use` / `tool_progress` | **Call site 1** for the ack helper, next to the existing `tool_use` timing block (`agent-runner.ts:2186-2204`) |
| `WarmVoiceSession.consumeOneTurn` | Same `text_delta` / `tool_use` observation (`warm-voice-session.ts:485-515`) | **Call site 2**. Do not duplicate 323 lease lifecycle |
| `abortThread` | Warm → `requestInterrupt`; cold → ticket-walk | Unchanged. A tool-in-flight barge-in is an interrupt, not a lease close |
| `TurnResult.toolMs` / `toolCalls` / `toolSummary` | Computed on `RunResult`; `finalizeSpawnResult` copies those three onto `TurnResult`; chat dispatcher maps them back via `convertTurnResult` (`dispatcher.ts:384-411` — every `RunResult` field mapped explicitly); **voice adapter does not** (`routeVoiceTurn` returns `TurnResult` from `spawnTurn`). `toolAckInjected` does **not** exist on either type today — a spawn-loop counter not on `RunResult` would drop at the copy; omitting it from `convertTurnResult` fails `tsc` once C5a makes it required | S4 — add the field on both types, copy it, map it in `convertTurnResult` (C5e), then log |
| `voice_call` MCP (E4) | Initiation only (`voice-mcp-server.ts`, `livekit-voice-mcp-server.ts`) | Not a mid-call tool. 325 consumes it. Do not fold lookup into `voice_call` |
| Contacts MCP | Name/phone/email/company lookup, in-process | Composed with `orders` (vendor identity vs PO state). Do not overload contacts with order fields |

## 4. Masking design

### 4.1 Segment rule (load-bearing)

A **segment** is the span from turn-start (or the previous `tool_use` boundary) until the next `tool_use`.

```
streamedThisSegment = false
on text_delta forwarded to onStream:
    streamedThisSegment = true
    (existing forward)
on assistant message:
    if any text block is non-empty: streamedThisSegment = true
    for each tool_use block:
        if config.voice.toolAck.enabled && !streamedThisSegment && onStream && channel === "voice":
            onStream(nextAckPhrase())   // SSE text; not written into SDK history
            toolAckInjected += 1
        streamedThisSegment = false     // the tool-run gap starts now
```

Consequences:

- Model said "let me check that" then called a tool → **no inject** (natural mask, 322's already-working hook).
- Model went straight to `tool_use` → **one canned line**, then silence only for the remaining tool runtime after TTS of that line.
- Two silent tools back-to-back (separate assistant messages **or** N `tool_use` blocks in **one** assistant message) → ack at **each** `tool_use` boundary (second phrase may differ). Two canned lines for one silent gap is **acceptable** on a phone; better than a second dead gap. Not collapsed to one-ack-per-gap — the loop is per-boundary by construction.
- Text + `tool_use` in the **same** assistant message → treat as streamed (process text blocks before tool blocks) so we do not double-speak.
- Chat / SMS / Slack / WS with `onStream` set → **no inject**. The voice-channel gate is load-bearing; streaming chat must not speak `"One moment."` into a text channel.

**Do not** insert the ack into the SDK session transcript. The model already decided to tool-call; echoing a canned line back into history on resume would teach it to skip speaking. LiveKit `ChatContext` will contain whatever TTS actually played (including the ack) — same as any other spoken text. Resume uses `extractLatestUserMessage` (user text only); full-transcript retry may include the ack as a `You:` line, which is harmless.

**Do not** inject before the first `tool_use` of a turn as a general "thinking" filler. Pre-first-token silence is 323's TTFT term. Injecting there would lie to `firstTokenMs` on every turn, tool or not.

### 4.2 Phrase set (constants, not config)

Phone-native, no "as an AI", no markdown. Rotate in order, wrap, using a **per-turn** local index (starts at 0 each `send` / `consumeOneTurn`; two silent tools in one turn take phrases 1 then 2). Do **not** share a mutable per-process (or per-lease) index across concurrent calls — overlapping voice turns would skip/collide phrases. Delivery may retune wording without a spec amendment; 325 may later persona-split (⚠ non-blocking).

1. `"One moment."`
2. `"Let me check that."`
3. `"Hang on, I'll look that up."`

Same set on Vapi and LiveKit. Worker TTS normalization (`normalizeForTTS`, markdown/emoji filters) already handles this prose.

### 4.3 Shared helper + call sites

New module `src/agents/voice-tool-ack.ts` (engine-side, next to the spawn loops — not in `src/voice-worker/`):

- `shouldInjectToolAck(args: { enabled: boolean; streamedThisSegment: boolean; hasOnStream: boolean; channel: string }): boolean` — true only when `channel === "voice"` (cold: `WorkItemContext.channelKind`; warm: `TurnContext.channel` / equivalent spawn context). `hasOnStream` is necessary but **not sufficient**.
- `nextAckPhrase(state: { index: number }): { phrase: string; index: number }` — **per-turn** index, local to the spawn-loop iteration. Do not keep a module-level or per-process counter.
- No I/O, no logging of the phrase (content). Callers increment a local `toolAckInjected` and put it on the returned `RunResult` (count only)

Wire:

1. `AgentRunner.send` — in the `assistant` / `tool_use` branch. Gate on `context.channelKind === "voice"` **and** `onStream`. Write `RunResult.toolAckInjected` (default 0).
2. `WarmVoiceSession.consumeOneTurn` — identical observation; write `RunResult.toolAckInjected`. Warm eligibility is already voice-only (323 §4.7); still pass `channel === "voice"` into the helper so C2 and C3 share one gate. `runWarmTurn` returns that `RunResult` into `finalizeSpawnResult` unchanged.

Do **not** wire Lane B adapters (openai/codex/gemini). W5 pilot voice is Claude; 323 already gates the warm lease closed for Lane A/B. A Lane B voice path that later needs masking reopens this helper at that adapter's tool-round boundary — out of scope.

### 4.4 Barge-in / abort during a tool

Unchanged 322/323:

| Event | Cold | Warm |
|---|---|---|
| Caller speaks during ack TTS or tool runtime | Worker cancels LLM stream; adapter `close` → `abortThread` → ticket abort (spawn dies) | Same `close` → `abortThread` → `interrupt()`; lease stays warm |
| Hang-up mid-tool | Same abort; thread lock released | Interrupt; idle timer (120s) reclaims |
| `stopAgent` | `ticket.abort()` kills the spawn | `ticket.attachAbort` closes the lease (323 kill semantics) |

In-flight MCP handlers are **not** given a new cancel token in this ticket. ⚠ SDK `interrupt()` may let a tool finish after the generation is severed; the result is dropped with the aborted turn. T2 verifies the *call* recovers, not that the tool process is SIGKILL'd. Do not add a hive-wide tool-abort bus.

### 4.5 Why not `session.say` (lever b) in v1

`session.say` is already used for 322 §8 failure fallbacks (`session.ts:272-277`) — terminal/retry lines with `waitForPlayout()`. Using it as a *gap filler while `HiveLLMStream.run()` is still reading SSE* means two concurrent speech sources on one `AgentSession` (LLM-driven TTS + an out-of-band `say`). agents-js 1.6.4 SpeechHandle semantics make that a barge-in / overlap footgun the 322 Task-0 pin never blessed for this purpose. The SSE ack uses the one speech path the session already has: chunks from the LLM node.

Reopen lever b if T1 shows `maxInterChunkGapMs` on tool-turns still ≥ ~800ms after ack (ack spoken, then a long leftover gap). That is an evidence trigger, not a delivery task.

### 4.6 Telemetry (S4)

**Engine "Voice turn complete"** (`voice-adapter.ts:532-550`) — additive, no content, no PO numbers:

| Field | Source |
|---|---|
| `toolCalls` | `TurnResult.toolCalls` (already computed) |
| `toolMs` | `TurnResult.toolMs` |
| `toolSummary` | `TurnResult.toolSummary` (server:count/duration; existing redaction posture — tool **names**, not args) |
| `toolAckInjected` | `TurnResult.toolAckInjected` (**new field**, number, default 0 — 0 if disabled, unused, or non-voice) |

**Copy path (load-bearing — without it C5d logs 0/undefined; without step 6 `tsc` fails):**

1. `RunResult.toolAckInjected: number` (default 0, **required**) on `AgentRunner`'s `RunResult` (`agent-runner.ts:134-168` today has `toolCalls` / `toolMs` / `toolSummary` only).
2. Both spawn-loop writers set it: C2 `AgentRunner.send` and C3 `WarmVoiceSession.consumeOneTurn` (returned through `runWarmTurn`).
3. `finalizeSpawnResult` (`agent-manager.ts:2287-2311`) copies `result.toolAckInjected` onto `TurnResult` the same way it copies the other three. Cold `send` and warm `runWarmTurn` both go through this copy. `synthesizeAbortedResult` (and Lane B `buildResult` zero-shapes) default the field to 0 so it is a required number, not optional-undefined.
4. `TurnResult.toolAckInjected: number` (`agent-manager.ts:133-148` today has the same three only).
5. C5d then logs `TurnResult.toolAckInjected`. Voice does **not** go through `convertTurnResult` (`routeVoiceTurn` returns `TurnResult` from `spawnTurn`). A spawn-loop counter that is not on `RunResult` / not copied here is dropped.
6. Chat path (typecheck-load-bearing): `dispatcher.convertTurnResult` (`src/channels/dispatcher.ts:384-411`) maps `TurnResult.toolAckInjected` → `RunResult.toolAckInjected` (default 0 if absent during rollout). Helper contract: every field of `RunResult` MUST be mapped explicitly. `npm run typecheck` is `tsc --noEmit` over `src/**/*`; C5a–d without this mapping fail on the object literal.

**Worker JSONL** — unchanged schema. T-gates correlate `maxInterChunkGapMs` with engine `toolMs` / `toolAckInjected` by `callId` after the fact. Do not add tool names to worker logs (worker never sees them under S1).

`firstTokenMs` on silent-to-tool turns **will drop** (ack becomes first SSE byte). 323 baseline harvest already drops `warmPath: true` and is the no-tool-or-mixed production mix; T-gates must not treat a drop in tool-turn `firstTokenMs` as a 323 regression. Optional later split (`firstTokenMs` vs `timeToToolUseMs`) is YAGNI — `toolAckInjected > 0` is the discriminator.

## 5. Voice-prompt supplement

`buildVoiceSystemPrompt` (`prompt-builder.ts:34-38`) keeps omitting toolkit/delegates. Append to the existing Voice Call Mode block (not a new cached-prefix-breaking section in the middle of soul):

- You have your normal tools on this call; the caller cannot see tool names.
- If you need to look something up, a brief spoken acknowledgment is good; the engine may also speak a short hold line if you go straight to a tool — do not apologize for it.
- Speak results the way a person would on the phone. No markdown, no bullet dumps, no raw JSON. Confirm a PO number back only when the caller cares about the digits.
- Do not start long-running work while the caller is waiting (`browser`, `code-task`, `background`, `skill-author`). Prefer a single lookup; if you cannot find it, say so and offer to follow up after the call.
- Do not initiate another `voice_call` from a live call.

This is complementary to S2, not a substitute. Prefix-cache: the paragraph is static (no per-call data), so it sits with the other static Voice Call Mode text, before goal/context/memory/datetime.

## 6. PO / order grounding contracts (D2 — W1B implements)

No purchase-order surface exists in this repo. Contacts (`src/contacts/contacts-mcp-server.ts`) are the closest: in-process `createSdkMcpServer`, voice-sized text results, search-then-get. `orders` follows that shape.

⚠ **Assumption (non-blocking):** W1B chooses the backing system (Mongo collection, plugin MCP, ERP HTTP, spreadsheet ingest — unknown). This spec defines the **agent-visible MCP contract** and the **spoken result template**. If W1B needs a credentialed HTTP API, it lists the key under `secret-env` (Honeypot); cloud-model agents never see it.

### 6.1 Server

| | |
|---|---|
| Catalog name | `orders` |
| Transport when W1B lands | in-process SDK server (Mongo-backed or wrapping a vendor client in-process). Add to `IN_PROCESS_PORTED_SERVERS` at implementation time so it cannot appear in `delegateServers` (KPR-184). |
| Entitlement | agent `coreServers` includes `"orders"`. Not auto-injected. Pilot agents (Nora / Sige) opt in when W1B ships; `voice-pilot` does **not** get production `orders`. |
| `SERVER_CATALOG` blurb | "Purchase-order lookup — status, dates, line remainders, by PO number or vendor" / Use for: grounding a live vendor or ops call / Not for: creating or changing orders (read-only); contact identity (use `contacts`). **W1B inserts this key with the live server.** 324 delivery does **not** register `SERVER_CATALOG.orders` — see C8. |
| Latency contract | p95 handler time **≤ 1500ms** excluding model. Masking is a one-line ack, not hold music. If W1B cannot meet this, reopen 322 lever b rather than lengthen the phrase set. |
| Authz | same as contacts: the agent that has the server may read. No per-vendor ACL in v1 (pilot scale). |
| Writes | **none.** No create / receive / cancel / comment tools on a live call. Follow-up writes stay on chat/MCP after hangup. |

### 6.2 Tools

#### `orders_lookup`

Find candidate POs. Voice-sized.

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `poNumber` | string | no | Caller-stated number, digits-and-dashes preserved; matcher must be punctuation-tolerant |
| `vendorQuery` | string | no | Vendor name or contacts-linked company string |
| `status` | string enum | no | `open` \| `partial` \| `received` \| `closed` \| `cancelled` — W1B maps native statuses onto this closed set |
| `since` | string | no | ISO date; default unbounded |
| `limit` | number | no | Default **3**, max **5** |

At least one of `poNumber` or `vendorQuery` required. Empty both → error `invalid_input`.

**Output (tool result text, not JSON for the model to re-parse as speech):** labeled prose, one PO per block, blank line between:

```
PO 45021 · Acme Hardware · Open
Promised: Fri Aug 28, 2026
Open lines: 4 maple doors; 6 drawer boxes
```

Zero hits → `No matching purchase orders.` (not an `isError`). Multiple hits → list, do not pick a winner. The model asks the caller to confirm.

#### `orders_get`

Single PO, after lookup or when the caller gave an unambiguous number that lookup already unique-matched (the model may skip lookup; the handler still id-or-number resolves).

**Input**

| Field | Type | Required | Notes |
|---|---|---|---|
| `poId` | string | no* | Opaque id from lookup |
| `poNumber` | string | no* | Same matcher as lookup |
| `includeLines` | boolean | no | Default **true** |

\* Exactly one of `poId` / `poNumber`. Both or neither → `invalid_input`.

**Output template**

```
PO 45021 · Acme Hardware · Open
Ordered: Aug 1, 2026 · Promised: Aug 28, 2026 · Last receipt: Aug 12, 2026
Ship to: shop
Lines:
- 12 maple doors — 8 received, 4 open
- 6 drawer boxes — 0 received, 6 open
Notes: vendor quoted late Friday
```

Omit empty optional rows rather than printing `Notes: —`. Line cap: **12 lines** then `…and N more; ask for a specific item`. Keep the whole payload speakable in under ~20 seconds.

### 6.3 Error shapes

MCP `isError: true` only for handler/backend failure, not for zero hits.

| Code (first line of result text) | When | Spoken recovery the prompt already covers |
|---|---|---|
| `invalid_input: …` | schema | Model asks the caller to repeat the PO / vendor |
| `not_found` | id/number unknown | "I'm not seeing that PO" |
| `ambiguous: N matches` | get() with a number that isn't unique | Fall back to lookup list |
| `backend_unavailable` | W1B store/API down | "I can't reach order status right now; I can follow up after this call" |

No stack traces, no connection strings, no raw vendor payloads in the result. Try/catch → structured error (KPR-122 in-process contract).

### 6.4 Composition with existing hive surfaces

- **Vendor who is this?** `contacts` (category `vendor`) — do not duplicate vendor master data on `orders`.
- **What did we discuss last time?** `conversation-search` / memory — out of this contract.
- **Call goal/context** (`voice_call` / dispatch metadata) may already contain a PO number; the model should still *confirm with a tool* rather than trust a stale prompt blob as live status. 325 playbooks can require that; this spec only makes the tool exist.

### 6.5 What 324 delivery does *not* implement

No `src/orders/` production server. No Mongo collection. No `hive.yaml` ERP URL. No Honeypot key. **No `SERVER_CATALOG.orders` key** (C8). Those land with W1B against **this section as the freeze**. A W1B spec that changes tool names or adds write tools is a D2 break and needs an epic-register amendment.

## 7. Test fixture (324 delivery — `voice-pilot` only)

So T-gates and 322 §14.2's "one lookup pause" can run while W1B is parked.

| | |
|---|---|
| Server name | `voice-fixture` |
| Tool | `voice_fixture_lookup` |
| Entitlement | `coreServers` includes `"voice-fixture"` on the **`voice-pilot` test agent only** (322 §14.2 ⚠ — never Nora/Sige). C7 registers the in-process server (runner wiring + `IN_PROCESS_PORTED_SERVERS`; **not** a `SERVER_CATALOG` key); **C9 writes the Mongo agent def** — `voice-pilot` is not a repo seed; 322 Task 14 creates it via MCP `agent_create`. 324 updates that document via MCP `agent_update` (`src/admin/admin-mcp-server.ts`; live tools `agent_create` / `agent_update`) so `coreServers` includes `voice-fixture`, then SIGUSR1. CLAUDE.md's `admin_agent_update` is a docs alias only. C7 code alone does not attach the tool. |
| Transport | in-process `createSdkMcpServer`; add to `IN_PROCESS_PORTED_SERVERS` |
| Input | `delayMs?: number` (default 1500, **hard cap 5000**); `poNumber?: string` (ignored for data, echoed in the canned result so the model can confirm digits) |
| Output | **byte-stable canned prose** matching §6.2 `orders_get` template (fixed Acme / 45021 fixture). Sleep then return. |
| Logging | duration + `delayMs` only; no spoken content |

Guard: if any non-`voice-pilot` agent definition includes `voice-fixture`, registry load **strips it and logs an error** (same posture as KPR-184 delegate sanitization). The fixture is a loaded gun on a production call.

## 8. Engine-change inventory (delivery-time diff)

| # | Change | Where | Size |
|---|---|---|---|
| C1 | `voice-tool-ack.ts` helper + unit tests (voice-channel gate; per-turn rotation index) | `src/agents/` | small |
| C2 | Inject at `tool_use` in `AgentRunner.send`; set `RunResult.toolAckInjected` | `agent-runner.ts` | small |
| C3 | Same inject in `WarmVoiceSession.consumeOneTurn` (`runWarmTurn` returns that `RunResult`); set `RunResult.toolAckInjected` | `warm-voice-session.ts` | small |
| C4 | Voice Call Mode paragraph | `prompt-builder.ts` | trivial |
| C5a | `RunResult.toolAckInjected: number` (default 0) | `agent-runner.ts` `RunResult` | trivial |
| C5b | `TurnResult.toolAckInjected: number` (default 0) | `agent-manager.ts` `TurnResult` | trivial |
| C5c | `finalizeSpawnResult` copies `result.toolAckInjected` onto `TurnResult`; `synthesizeAbortedResult` / Lane B zero-shapes default 0 | `agent-manager.ts` | trivial |
| C5d | "Voice turn complete" logs `TurnResult.toolCalls` / `toolMs` / `toolSummary` / `toolAckInjected` (S4) | `voice-adapter.ts` | trivial |
| C5e | `convertTurnResult` maps `TurnResult.toolAckInjected` → `RunResult.toolAckInjected` (chat `TurnResult` → `RunResult`; default 0 if absent during rollout). Required: C5a makes the field a required `number`; this helper's contract is every `RunResult` field mapped explicitly (`dispatcher.ts:379-382`). Voice does not go through it (`routeVoiceTurn` returns `TurnResult` from `spawnTurn`); omitting it still fails `npm run typecheck` (`tsc --noEmit` over `src/**/*`). | `src/channels/dispatcher.ts` | trivial |
| C6 | `voice.toolAck.enabled` liberal loader (absent → on; literal `false` → off) | `src/config.ts` | trivial |
| C7 | `voice-fixture` in-process MCP + strip-if-not-pilot. Wire in `AgentRunner.buildInProcessServers` (`shouldEnableInProcessServer`, same pattern as contacts) and add `"voice-fixture"` to `IN_PROCESS_PORTED_SERVERS` only. **Do not** add `SERVER_CATALOG["voice-fixture"]` — same fake-configured trap C8 exists to prevent (`buildInstanceCapabilities` treats a catalog key with no `SERVER_CREDENTIAL_CHECKS` entry as `configured`). | `src/voice/` or `src/agents/` + `agent-runner.ts` + `in-process-servers.ts` | small |
| C8 | **No `SERVER_CATALOG.orders` key.** Comment + spec pointer at `server-catalog.ts` (and optionally `IN_PROCESS_PORTED_SERVERS`) pointing at this spec §6. `buildInstanceCapabilities` treats catalog keys with no `SERVER_CREDENTIAL_CHECKS` entry as **configured** — a blurb-only `orders` key would show as live. Do not ship a fake-live catalog key. If a key is added anyway, it MUST classify `unconfigured` or `broken` until W1B ships the server; preferred is comment-only. | `src/tools/server-catalog.ts` | trivial |
| C9 | Ops: add `voice-fixture` to the `voice-pilot` **Mongo** agent def `coreServers` via MCP `agent_update` (`src/admin/admin-mcp-server.ts`; live tools `agent_create` / `agent_update` — same surface 322 Task 14 used `agent_create`). CLAUDE.md's `admin_agent_update` is a docs alias only. Then SIGUSR1. Not a repo seed file. Never Nora/Sige. | instance `agent_definitions` | ops, not a code diff |

**No worker diff. No new HTTP route. No LiveKit Agent tools. No schema/migration. No new secrets.**

Rollback: `voice.toolAck.enabled: false` (silence during tools, pre-324) + remove `voice-fixture` from `voice-pilot` (C9 reverse). Leave C4/C5a–e in place (prompt + telemetry + chat mapping are harmless).

## 9. Config + secrets

```yaml
voice:
  toolAck:
    enabled: true    # absent/garbage → true; literal false disables injection
```

Phrases, rotation, delay cap, segment rule: **constants** in `voice-tool-ack.ts` / fixture module (323 timeout pattern). Rotation index is **per-turn** (local to `send` / `consumeOneTurn`), not a module-level or per-process counter.

Secrets: none for this ticket. ⚠ W1B, if it talks to an external order API, adds a Honeypot key named in *that* spec; never in model context, never in voice logs.

## 10. Integration points (seams)

| Seam | Contract |
|---|---|
| 322 bridge | Unchanged: POST messages + SSE text. Ack is text. `maxInterChunkGapMs` is the worker-side scoreboard for T1 |
| 323 warm lease | Unchanged lifecycle. C3 is an observation-site add inside `consumeOneTurn`. Interrupt-and-keep-warm still applies mid-tool |
| 322 §14.2 script | Already "order status + one lookup pause + two barge-in points". T-gates reuse that script on `voice-pilot` with `voice-fixture` as the pause. C9 must have landed (`voice-pilot` Mongo `coreServers` includes `voice-fixture`) or the lookup tool is absent |
| 325 | Consumes masking + (once W1B unparks) `orders` on Nora/Sige. Personas/rubric still 325. May retune ack phrases |
| W1B / KPR-300 | Implements §6 exactly, including inserting `SERVER_CATALOG.orders` with the live server. Park does not block 324 delivery or 325's non-order pilot turns. 324 C8 is comment-only so capabilities do not list a fake-live `orders`. C7 likewise does **not** add `SERVER_CATALOG.voice-fixture` |
| Prefix cache (KPR-213) | C4 is a static prompt add — invalidates voice prefixes once per deploy, same as any `prompt-builder` edit |

## 11. Edge cases

| Case | Behavior |
|---|---|
| `toolAck.enabled: false` | Zero injects; tools still run; telemetry `toolAckInjected: 0` |
| Non-voice channel with `onStream` (Slack/SMS/WS chat that later streams) | No inject — `channel !== "voice"`. Must not speak `"One moment."` into text |
| Non-streaming voice request | No `onStream` → no inject (degenerate; LiveKit/Vapi stream). Channel gate still required |
| Client gone (E2) before inject | `onStream` already no-ops on `clientGone`; helper still "succeeds" |
| Zero-content turn + no tools | No inject (no `tool_use`) |
| Tool error / `isError` result | Ack already spoken (if injected); model speaks the recovery; no second automatic phrase |
| Compaction mid-call | Unrelated; 323 handles session id rotation |
| Lane A cold voice (kimi/…) | C2 runs (same `AgentRunner.send`, `channel === "voice"`). Warm lease stays Claude-only (323) |
| Lane B voice | No C2/C3. Out of scope |
| Concurrent voice calls | Each spawn loop owns its own per-turn rotation index; no shared process counter |
| N `tool_use` blocks in one assistant message | One ack per `tool_use` block (same per-boundary rule as sequential silent tools, §4.1). Two canned lines for one silent gap is acceptable. Not collapsed to a single ack. |
| Fixture `delayMs` > cap | Clamp; do not error |
| Production agent with `voice-fixture` | Stripped at load |
| `voice-pilot` Mongo def missing `voice-fixture` (C7 without C9) | Tool schema absent on the test agent; T-gates cannot force the lookup. C9 is required |
| Model calls `orders_*` before W1B | Tool absent unless W1B shipped; model should not see the schema. Do not register a failing stub on Nora; do not add a check-less `SERVER_CATALOG.orders` key |
| Markdown in canned ack | None, by construction; worker filters still apply |

## 12. Testing + empiricism

### 12.1 Delivery tests (automated, no operator go)

Minimum assertions:

1. `shouldInjectToolAck` true only when enabled + not streamed + has onStream + `channel === "voice"`. False when channel is slack/sms/ws even if `onStream` is set; false when voice but `onStream` is missing.
2. Text-then-tool: no inject; silent-tool: inject once; two silent tools (sequential messages **or** two `tool_use` in one assistant message): inject twice; text+tool same assistant message: no inject.
3. Injected string is exactly a phrase from the constant set; `onStream` called with it **before** the test's fake tool delay resolves.
4. Cold and warm loops both honor (3) — mock `onStream`, emit a `tool_use` assistant message with no prior deltas, fixture `channel` / `channelKind` is `"voice"`. Each loop's returned `RunResult.toolAckInjected` matches the inject count.
5. Voice adapter "Voice turn complete" includes `toolCalls` / `toolMs` / `toolAckInjected` from `TurnResult` (no phrase text). Assert the copy path: a spawn-loop count on `RunResult` survives `finalizeSpawnResult` onto `TurnResult.toolAckInjected` (a counter that is not copied logs as 0/undefined). Assert `convertTurnResult` (`src/channels/dispatcher.ts`) maps `TurnResult.toolAckInjected` → `RunResult.toolAckInjected` (default 0 if absent).
6. Fixture delay is clamped; canned body matches §6.2 shape; registry strips `voice-fixture` from a non-pilot agent id.
7. `voice.toolAck.enabled` liberal loader: absent → on; `"false"` / `0` / `"no"` → on (garbage); `false` → off.
8. Prompt builder output contains the Voice-tools paragraph and still omits the toolkit dump.
9. `HiveLLM` POST body snapshot: still no `tools` key (regression lock on S1).
10. Worker unchanged: existing `hive-llm.test.ts` gap test still passes without session.say.
11. `SERVER_CATALOG` has no `orders` key (C8 comment-only until W1B) and no `voice-fixture` key (C7 must not register a catalog entry).
12. `nextAckPhrase` rotation is a caller-owned index: two concurrent helpers advancing independent `{ index }` states do not share a module counter.

### 12.2 T-gates — designed, NOT run (per-run operator go, D3)

Reuse 322 `voice-pilot` + 10-turn vendor-style script (C9 must have added `voice-fixture` to that Mongo def). Prefer the **Vapi path or LiveKit path, whichever is live** — masking is behind the HTTP seam so either is valid. Warm-on for T2.

| Gate | What runs | Pass / decision rule |
|---|---|---|
| **T1 — ack audible** | Scripted turn that forces `voice_fixture_lookup` (delay 1500ms). Operator listens. | Hear a §4.2 phrase **before** the canned PO status; no double-speak with a model-generated "let me check" on that same turn if the script's model already said one. Engine log: `toolAckInjected ≥ 1`, `toolMs` ≈ delay. Worker: `maxInterChunkGapMs` **lower** than a control turn with `toolAck.enabled: false` on the same fixture delay (same call shape, N=3 each). |
| **T2 — barge-in mid-tool** | Caller interrupts during the fixture delay (warm path on). | Agent audio stops; next turn answers the interrupting utterance; lease stays up (`warmPath: true` on the next "Voice turn complete"). Matches 323 interrupt-and-keep-warm; does not require the fixture handler to abort. |
| **T3 — natural mask still wins** | Scripted turn where the model is prompted to say a wait line *then* look up. | `toolAckInjected = 0` on that turn; operator hears one wait line, not two. |

If T1's control-vs-ack `maxInterChunkGapMs` delta is < 200ms (ack didn't fill the gap — e.g. `tool_use` observed too late), **do not silently ship lever b in this ticket**. Record the finding, file a follow-up, keep S2 as "best effort" or demote to prompt-only pending the observation. That demote is an operator call at T1, not a spec fork now.

322 P0–P4 and 323 W0–W2 remain those tickets' gates. T1 may run on the same day as 322 P1 but is not a P-gate substitute.

## 13. Non-goals

- **KPR-325** call personas, rubric, pickup-rate thresholds, AMD policy, vendor playbooks.
- **KPR-321** Twilio/CNAM/ops (operator go still required there; not a 324 code dep).
- **Redoing 322/323** (bridge, SIP, warm lease, E1/E2/E4, baseline harvest).
- **`POST /v1/tools`** or any second voice HTTP surface.
- **LiveKit function tools / worker `session.say` filler / thinking audio.**
- **Mid-tool "still looking" loop** or hold-music / background audio.
- **Production `orders` implementation**, ERP selection, migrations, Honeypot keys for an order API, a live `SERVER_CATALOG.orders` or `SERVER_CATALOG.voice-fixture` key in this ticket.
- **Write-path PO tools** (receive, cancel, comment).
- **Lane B voice masking**; **auto-inject `orders` for every agent.**
- **Restoring toolkit/delegate dumps** in the voice system prompt.
- **TTS cell upgrades** (Sonic-3.6 / Eleven v3) — 322 §14.1.1 at P4.
- **FABLE_MAKEUP** obligations.

## 14. Risks & delegated-assumption registry (⚠)

- ⚠ **W1B backing store / ERP identity unknown** — contract is MCP-only (§6). Non-blocking for 324 delivery (D2). Blocking for 325 turns that *require* live PO truth.
- ⚠ **`tool_use` is observed before the tool handler runs** — true of the current runner timing (`startMs = Date.now()` at `tool_use`). Task-0 reconfirms. If a future SDK yields `tool_use` only after the handler, inject at `tool_progress` instead (same helper, different event). Fallback, not a blocker.
- ⚠ **Ack phrases / persona split** — shared set in v1; 325 may specialize. Non-blocking.
- ⚠ **In-flight tool after `interrupt()`** — may complete and be discarded. T2 cares about call recovery. Non-blocking.
- ⚠ **`firstTokenMs` definition shift** on silent-to-tool turns (§4.6). Non-blocking; do not rebase 323's blessed artifact.
- ⚠ **Test agent `voice-pilot` still exists** as 322's dedicated def — 324 must not point the fixture at Nora/Sige. Confirm at delivery Task-0 **and** that C9 landed (`coreServers` includes `voice-fixture` on that Mongo def).
- ⚠ **322 P0–P4 / SIP-5 / 323 W-gates still designed-not-run** (canon D3). T-gates do not replace them and also need operator go.
- **Risk — double-speak if text_delta and helper race:** mitigated by the same-message text-block-first rule + `streamedThisSegment`. T3 is the live check.
- **Risk — fixture left on a production agent:** load-time strip + log (§7).
- **Risk — long W1B lookups:** §6.1 p95 bound; miss → reopen lever b, don't stretch canned speech.

## 15. Sources (checked 2026-08-23)

Hive code (lane worktree `/Users/mokie/github/lane-kpr-324-mature` @ `f0f4abd`): `src/voice-worker/hive-llm.ts` (`HiveLLM.chat()` unused `toolCtx` at `:62-75`; POST with no `tools` key is `HiveLLMStream.run()` at `:136-154`; `maxInterChunkGapMs`), `src/voice-worker/session.ts` (`session.say` fallback-only; `Agent` without tools), `src/voice-worker/telemetry.ts`, `src/channels/voice/voice-adapter.ts` (SSE text, E2, "Voice turn complete" without tool fields), `src/channels/voice/conversation-prompt.ts` (Phase-2 skip), `src/channels/voice/openai-translator.ts` (`formatSSEToolCallChunk` unused), `src/channels/dispatcher.ts` (`convertTurnResult` `:384-411` — every `RunResult` field mapped explicitly; `routeVoiceTurn` returns `TurnResult` from `spawnTurn`), `src/agents/warm-voice-session.ts` (`tool_use` timing + interrupt; returns `RunResult` into `runWarmTurn`), `src/agents/agent-manager.ts` (`TurnResult.toolCalls`/`toolMs`/`toolSummary` — no `toolAckInjected`; `finalizeSpawnResult` copies those three; `synthesizeAbortedResult`; `abortThread`), `src/agents/agent-runner.ts` (`RunResult` same three only; `text_delta` filter, `tool_use` start; `WorkItemContext.channelKind`; `buildInProcessServers`), `src/agents/prompt-builder.ts` (`buildVoiceSystemPrompt`), `src/agents/in-process-servers.ts`, `src/admin/admin-mcp-server.ts` (`agent_create` / `agent_update`), `src/contacts/contacts-mcp-server.ts`, `src/tools/server-catalog.ts`, `src/tools/instance-capabilities.ts` (`buildInstanceCapabilities`: catalog key with no credential check → `configured`), `src/voice/voice-mcp-server.ts` + `src/voice/livekit-voice-mcp-server.ts` (E4 initiation). Grep: no `/v1/tools` route; no purchase-order/ERP modules.

Siblings: `docs/epics/kpr-320/kpr-322-spec.md` §5.1, §9.2, §13, §14.2; `kpr-323-spec.md` §4.4, §6, §8 (mid-call tools referenced, not designed). Gate 1 D2 (2026-07-13). Decision-register canon from epic dispatch (E1/E2/E4, agents-js 1.6.4, D3, TTS P4 bind).
