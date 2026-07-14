# KPR-323 — W5.3: Warm execution path for voice turns

**Epic:** KPR-320 (W5: Voice v2 — outbound vendor pilot). **Consumes:** KPR-322 bridge contract (§5/§6/§7 there — `threadId = voice:<callId>`, full-transcript-every-turn, E2 abort-on-disconnect). **Feeds:** KPR-322 §15 P2 (latency gate binds to this spec's blessed baseline), KPR-325 (pilot rides the warm path). **Adjacent:** KPR-324 (mid-call tools — contracts referenced only, per D2).

**Program mode + D3 (Gate 1, 2026-07-13):** maturity-first — spec only, no code, no runs. This ticket **owns the blessed read-only first-audio latency baseline** (§3): the canonical measurement methodology and the read-only capture design live here; 322's P0–P4 gates reference it. All empirical work in §7 is designed-but-not-run; **every live run requires a recorded per-run operator go**.

**Anchor:** epic branch kpr-320 @ d074d5c (base = main @ W6 merge). Wave W3 (epic branch kpr-309 — KPR-311 seam reshape, KPR-313 session-identity guards, KPR-338 fixed-tier) is matured but **not merged**; it moves the same spawn seam this design branches. §9 lists mandatory Task-0 re-confirm surfaces, per the W2/W3 precedent (anchor to main, never design against unmerged branches).

**Ticket shape:** code-design spec (engine-internal — no new process, no new protocol; everything lands behind the existing voice HTTP seam, honoring 322 §9.1).

## TL;DR

Every voice turn today pays a 1.5–2s cold-spawn tax — a fresh `claude` CLI subprocess, session-transcript reload, and MCP re-handshake per conversational turn — which is why hive turns run 2.1–2.5s while native voice platforms deliver first audio in 500–900ms. This spec (a) defines the blessed read-only first-audio baseline that all W5 latency gates compare against — harvested from the live instance's existing "Voice turn complete" telemetry with zero behavior change — and (b) designs the warm path: a **per-call warm session lease** that opens one long-lived streaming-input `query()` when a call starts, holds the per-thread lock and exactly one spawn-budget slot for the call's duration, and feeds each subsequent caller utterance into the already-running session, so turns 2..N skip subprocess boot, session reload, and MCP init entirely — leaving model TTFT (plus a few ms of unchanged adapter-side pre-spawn Mongo reads) as the remaining cost. The lease hides behind `AgentManager.spawnTurn`, so the voice adapter, dispatcher routing, retry/outage/error rows, and the 322 bridge contract are all unchanged.

## Key Points

- **Chosen mechanism: per-call warm session lease** (long-lived streaming-input `query()` per active call, §4) — turns within a call are sequential by nature, so a call maps perfectly onto one SDK session. Rejected: generic pre-warmed subprocess pool (the KPR-208 idea — per-(agent, thread) session/prompt/MCP state can't be pre-staged into a generic process, and **nothing of KPR-208 ever shipped**: no commits reference it) and per-turn component shaving (kept as the documented fallback if W1's decomposition falsifies the warm hypothesis).
- **The lease is a real spawn ticket**: it acquires the `agentId:threadId` lock and one budget slot at call start and releases both at call end — KPR-220 lock/budget semantics are preserved *by construction*, not carved out. Trade-off stated plainly: one active call = one budget slot for the whole call (default budget 5 → 5 concurrent calls per agent); `getSnapshot()`/heartbeat make it visible, and pilot agents size `spawnBudget` accordingly.
- **Zero contract change at the 322 seam**: warm-vs-cold is invisible behind `POST /v1/chat/completions` (322 §9.1). The warm branch lives inside `AgentManager.spawnTurn`, so `dispatcher.routeVoiceTurn` (taskLedger/audit), the outer full-transcript retry, budget-503/auth-503/circuit-open rows, and telemetry log shapes are untouched.
- **Voice-channel-wide, not LiveKit-specific**: the warm path keys on `channel === "voice"`, so the incumbent Vapi line benefits identically — which also means the W2 A/B (§7) can run on today's Vapi path **before** 322 delivers.
- **E2 reconciliation (binds 322 §7):** under a warm lease, 322's socket-close → `abortThread` → `ticket.abort()` would kill the whole call on every barge-in. Fix: `abortThread` itself dispatches on lease presence — warm lease → turn-level `interrupt()` (session survives; next turn is instant); no lease → 322's ticket-walk abort, unchanged. The adapter-facing surface, 322's close-listener wiring, and 322's committed tests are all untouched; `ticket.abort()` keeps kill-the-session semantics for `stopAgent`. Barge-in vs hang-up is indistinguishable at the socket — interrupt-and-keep-warm is correct for both (hang-up reclaims via idle timeout).
- **Blessed baseline = engine-attributable term only** (§3): `firstTokenMs` p50/p95 from existing production "Voice turn complete" log lines, harvested read-only, aggregate-only artifact committed to this epic dir, blessed once by the operator, immutable thereafter. 322 P2's `[323-baseline + 300ms]` placeholder resolves to this artifact's `resumed.firstTokenMs.p50`.
- **Failure posture: cold path is always the fallback.** Session ids persist to Mongo per turn, and 322's full-transcript-every-turn request contract means any warm-session death (subprocess crash, engine restart, lease timeout) degrades to today's behavior — a slower turn, never a lost one.
- **Rollback lever:** single config boolean `voice.warmPath.enabled`; `false` = byte-identical to today's per-turn path (mirrors the KPR-329 `toolSearch.mode: off` pattern). No other knobs — idle timeout and hard cap are constants.
- ⚠-flagged delegated assumptions collected in §11 — the load-bearing two are SDK streaming-input behaviors (per-pushed-message `result` emission for turn demux; `interrupt()` leaving the session usable), both verified at W2 before anything ships.

## 1. Problem / context

Post-KPR-220, the only execution path is per-turn: WorkItem → `AgentManager.runWorkItemTurn`/`routeVoiceTurn` → `spawnTurn(ctx)` → fresh `AgentRunner` → SDK `query()` with `options.resume = sessionId` → **subprocess spawn of the claude CLI** → first token. For chat channels (Slack/SMS) the per-turn spawn cost is invisible against minutes-scale conversational cadence. For voice, every caller utterance is one WorkItem turn, so the spawn tax lands **on every conversational exchange**: hive's own turn runs 2.1–2.5s against the 500–900ms first-audio of every native voice platform. The epic calls this child the pilot's make-or-break, and 322 deliberately left the spawn term unoptimized behind its HTTP seam (322 §9.1, latency-budget row "dominant term").

Two deliverables: the canonical baseline every later measurement compares against (§3, D3 deliverable #1), and the warm-path design that removes the tax (§4–§6).

## 2. Where the time goes — cold-turn stage model

Stage decomposition of one voice turn on the current path, with code anchors (lane worktree @ d074d5c). Durations are **hypotheses to be measured at W1** (§7), not claims — the only measured number today is `firstTokenMs` (T0→T6).

| # | Stage | What happens | Anchor |
|---|---|---|---|
| T0→T1 | Adapter pre-spawn | `buildVoiceSystemPrompt` (Mongo reads: constitution + hot-tier memory) + `sessionStore.get` (Mongo findOne) | `voice-adapter.ts:243-249`, `prompt-builder.ts:12-60` |
| T1→T2 | Coordinator admission | lock wait (25ms poll cycles; 0 when thread quiescent), budget check, breaker `acquire` | `agent-manager.ts:681-701`, `:577-581` |
| T2→T3 | Spawn prep | `prepareSpawn` (voice carve-out — returns immediately, **no model-router call**: `agent-manager.ts:1092-1093`); fresh `AgentRunner` + in-process MCP server construction; `buildSystemPrompt` **skipped** (systemPromptOverride) | `agent-manager.ts:1041`, `agent-runner.ts:1537-1714` |
| T3→T4 | CLI boot | `query()` spawns the claude CLI subprocess: node boot + CLI init | `agent-runner.ts:1790` |
| T4→T5 | Session + MCP init | resume-transcript load (grows with call length), MCP handshake — each **stdio** server on the agent's list spawns its own node subprocess per turn; in-process SDK servers attach over the control channel | SDK-internal; `system/init` message marks completion (`agent-runner.ts:1885-1888`) |
| T5→T6 | Model TTFT | prompt upload + first `text_delta` | `agent-runner.ts:1912-1915` → SSE at `voice-adapter.ts:272-289` |

**Working hypothesis** (grounded in the KPR-122 rationale — per-turn stdio spawn/exit churn was measurable enough to motivate in-processing the Mongo MCPs): T3→T5 (CLI boot + session load + MCP init) is the dominant share of the 1.5–2s tax, with T5→T6 (genuine model TTFT, ~300–800ms Sonnet-class) second and irreducible. The warm path eliminates T1→T5 for turns 2..N. **T0→T1 persists on warm turns**: the adapter seam is untouched (§5/§10), so `buildVoiceSystemPrompt` + `sessionStore.get` still run per turn — small, ~ms-scale local-Mongo round-trips — and the lease simply ignores the rebuilt `systemPromptOverride` after turn 1. C1's `promptBuildMs`/`sessionLookupMs` therefore measure **nonzero on warm turns by design**, quantifying exactly what persists. If W1 shows T5→T6 dominates instead, the warm path cannot clear the bar and §7's falsification rule demotes this design — that check is deliberately front-loaded.

**Decomposition instrumentation (delivery-time, C1 in §10):** additive numeric fields on the existing "Voice turn complete" log line — `promptBuildMs`, `sessionLookupMs`, `lockWaitMs`, `spawnPrepMs`, `bootToInitMs`, `initToFirstTokenMs` — sourced from timestamps at the six anchors above. Log-only, no content, always-on (no config lever; it is a handful of subtractions on an existing line).

## 3. Blessed read-only first-audio baseline (D3 deliverable #1)

### 3.1 What is measured, and why this term

Full first-audio (`totalToFirstAudioMs`, end-of-caller-speech → first agent audio) decomposes as EOU-detection + bridge hop + **hive first-token** + TTS TTFB + media transit (322 §4). The vendor terms are 322's worker telemetry (§13 there) and cannot exist until the LiveKit pipeline runs; the **engine-attributable term is `firstTokenMs`** — adapter request-arrival → first SSE text byte — which is exactly the term this ticket moves and the only term measurable on the current live path with zero behavior change. The blessed baseline is therefore `firstTokenMs`, and every composed first-audio comparison (322 P2) uses it as the engine term.

- **Metric definitions:** `firstTokenMs` per `voice-adapter.ts:270-288` (headers + first non-empty delta); `totalMs` = full turn. Percentiles are nearest-rank over the sample set. Turns split by `sdkSessionResumeAttempted` (resumed = steady-state conversational turn; non-resumed = call-start turn). One honest wrinkle: turns whose resume failed and recovered via the outer full-transcript retry land in the **resumed** bucket with retry-inflated latency (`startedAt` spans both attempts, and `sdkSessionResumeAttempted` stays true) — this is deliberate: the bucket then measures "what a steady-state turn actually costs today, retries included," which is the correct comparand for warm turns 2..N.
- **Call shape:** live production traffic on the instance's existing Vapi line (Mokie) — real calls, real agent definition, real MCP inventory. No synthetic calls are placed for the baseline (that would not be read-only).

### 3.2 Read-only capture method

Source: the existing **"Voice turn complete"** log lines (`voice-adapter.ts:423-432`), which already carry `callId, agentId, firstTokenMs, totalMs, mode, sdkSessionResumeAttempted, sdkSessionResumed, routedVia` and are emitted only on successful turns. Capture = parse the instance's log files over a lookback window. No engine change, no traffic generation, no message content, no phone numbers touched.

Deliverable at delivery time: `scripts/voice-latency-baseline.ts` (C6) — reads the instance log dir, filters the window, computes the stats, emits the artifact JSON. The methodology (this section) is canon now; the script is a mechanical rendering of it, and an operator could equally produce the artifact with grep+jq.

**Sample requirements:** ≥50 resumed turns and ≥20 non-resumed turns within a ≤30-day window ending at capture time, all from the production agent's line, streaming mode only. Log lines **without a `firstTokenMs` value are excluded** from the metrics (degenerate zero-chunk streaming turns never set it — the adapter emits headers + `[DONE]` at completion, `voice-adapter.ts:397-407`) and the exclusion count is recorded in the artifact. If the window can't supply the minimums, the shortfall is recorded in the artifact and the operator decides whether to bless anyway (small-n flagged) or wait for traffic. Failed turns are structurally excluded (the log line fires only on success) — the baseline measures the latency of turns that worked, which is the correct comparand for P2.

### 3.3 Artifact format (what the PoC gates consume)

One JSON document, aggregate-only (no per-call rows, no callIds, no text):

```json
{
  "kind": "voice_latency_baseline",
  "version": 1,
  "capturedAt": "<ISO8601>",
  "engineVersion": "<package.json version>", "gitSha": "<engine sha>",
  "source": "vapi-production-logs",
  "window": { "from": "<ISO8601>", "to": "<ISO8601>" },
  "agentId": "<agent>", "mode": "streaming",
  "samples": { "resumed": 0, "nonResumed": 0, "excludedMissingFirstToken": 0 },
  "metrics": {
    "resumed":    { "firstTokenMs": { "p50": 0, "p95": 0 }, "totalMs": { "p50": 0, "p95": 0 } },
    "nonResumed": { "firstTokenMs": { "p50": 0, "p95": 0 }, "totalMs": { "p50": 0, "p95": 0 } }
  },
  "blessing": { "blessedBy": "<operator>", "blessedAt": "<ISO8601>", "linearRef": "KPR-323#comment" },
  "notes": ""
}
```

Stored at `docs/epics/kpr-320/baselines/voice-baseline-<capturedAt-date>.json` (committed to the epic branch) and mirrored into a Linear KPR-323 comment.

### 3.4 Blessing protocol

1. Operator gives a recorded **go** for the harvest run (read-only, but D3's per-run rule is honored — it reads production logs).
2. Harvest produces the artifact with `blessing` empty; operator reviews numbers + sample sizes.
3. Operator blesses (date + words in Linear); `blessing` is stamped; the artifact is committed and **immutable** — later runs never edit it.
4. Every subsequent measurement (W1/W2 here, 322 P2) compares against this one artifact. **P2's placeholder resolves to `metrics.resumed.firstTokenMs.p50`.** Re-baselining (e.g., after an engine upgrade moves the floor) is a new artifact + new blessing; the old one stays in the directory as history.

## 4. Warm-path design

### 4.1 Mechanism decision

| # | Mechanism | Verdict | Why |
|---|---|---|---|
| A | **Per-call warm session lease** — one long-lived streaming-input `query()` per active call; push each turn into it | **Chosen** | Eliminates T1→T5 for every turn after the first; a call is exactly a bounded sequence of same-thread turns, so it maps 1:1 onto one SDK session with zero lock-semantics violence; SDK-supported surface (`prompt: AsyncIterable<SDKUserMessage>`, `interrupt()`, `streamInput()` — sdk.d.ts, pinned at Task-0); architecturally identical to hive's own pre-KPR-220 long-lived loop, scoped per call instead of per agent |
| B | Pre-warmed generic subprocess pool (the KPR-208 idea) | Rejected | A resumed session is per-(agentId, threadId) with per-agent MCP env and per-call system prompt — none of it can be pre-staged into a generic idle process; the SDK exposes no boot-without-run mode; best case shaves only node boot (a fraction of T3→T5) while fighting the SDK. Verified: **no KPR-208 code exists** in the tree or git history (`git log --all --grep`) — it was an identified idea, never an implementation |
| C | Keep per-turn spawn, shave components (fewer stdio servers on voice turns, leaner CLI boot flags) | Rejected as primary | Cannot remove the floor — CLI boot + session reload are inherent to spawn-per-turn. Retained as the **documented fallback**: if W1's decomposition falsifies the warm hypothesis (§7 falsification rule), this spec demotes and mechanism C gets designed against the measured component list |
| D | SDK V2 `SDKSession` (`send()`/`stream()`) | Not designed on | Marked `@alpha`/UNSTABLE in the SDK typings; the streaming-input `query()` surface is the stable equivalent. Noted as a future simplification seam ⚠ |

### 4.2 The warm call session lease

**Placement:** inside `AgentManager` (new module `src/agents/warm-voice-session.ts` + a registry map on the manager). The coordinator owns spawn lifecycle, lock, budget, and tickets — the lease must be a first-class citizen of that machinery, not an adapter-side bypass.

**Lease lifecycle:**

1. **Open (turn 1 of a call).** `spawnTurn(ctx)` sees `ctx.channel === "voice"`, `ctx.kind !== "reflection"`, `config.voice.warmPath.enabled`, provider = claude (full gate in §4.7), and no existing lease for `threadKey` → opens a lease: acquires the spawn ticket via the existing `withSpawnTicket` HOF with a lambda that resolves only at lease release (the ticket therefore holds the per-thread lock and one budget slot for the call's duration — all three stop-checkpoints, saturation recording, and finally-cleanup fire exactly as today). Inside the lease: build the runner once (same constructor args as `createProviderAdapter`), open `query()` with `prompt` = an AsyncIterable input queue, `resume` = **`ctx.sessionId` exactly as passed — the adapter's resolved `effectiveResume` — never a fresh session-store re-read**, `systemPromptOverride` = the voice prompt built once at call start, `includePartialMessages: true`. The resume-source rule is load-bearing: after a warm-turn failure, the adapter's outer retry lands cold with `sessionId: undefined` + full transcript (§5); if a subsequent lease open re-read the store, it would resume the very session the retry just escaped and double-inject the transcript. Honoring `ctx.sessionId` keeps the adapter the single authority on resume-vs-full-prompt, exactly as on the cold path. Turn 1's text (full-transcript or greet-branch render, unchanged from `conversation-prompt.ts`) is the first queued message. `ticket.attachAbort(() => lease.close())` — **abort keeps kill semantics** (`stopAgent` walks tickets and must actually stop the call).
2. **Turn N.** `spawnTurn(ctx)` finds the lease for `threadKey` → delegates to `lease.runTurn(ctx, onStream)` **without** re-entering `withSpawnTicket` (the lease's ticket already covers the thread; re-entering would deadlock on the held lock). `runTurn`: breaker `acquire` for the claude provider (fast-fail → `ProviderCircuitOpenError` propagates to the adapter's existing spoken-notice row — the message is never queued); push the turn text into the input queue; consume the shared output stream until this turn's `result` message; relay `text_delta`s to `onStream`; breaker `record`; reuse `finalizeSpawnResult` + `recordSpawnObservability` verbatim (session-id rotation persisted to Mongo per turn — this is what keeps cold fallback correct); return a normal `TurnResult`.
3. **Release.** Triggered by: idle timeout (no turn for **120s**, constant, unref'd timer reset per turn), hard lifetime cap (**2h**, aligned with the adapter's `CallSession` TTL), `ticket.abort()` (stop/abort), engine shutdown, or unrecoverable session error. Release = `query().close()`, resolve the lease lambda (ticket finally releases lock + budget + ticket set), then run the reflection hook (§4.5).

**Turn demux** ⚠ (load-bearing, W2-verified): in streaming-input mode the SDK emits per-exchange `result` messages; `lease.runTurn` treats "next `result` after my pushed message" as the turn boundary, and `system/init` (first turn only) + `stream_event` deltas flow as today. Because the input queue is only ever fed by `runTurn` calls that are serialized by the per-thread lock's *external* callers (the 322 worker/Vapi POST one turn at a time) **and** by an internal one-turn-at-a-time gate in the lease, interleaving cannot occur. If the SDK's actual streaming semantics differ (e.g., no per-message `result`), that is a **material** Task-0/W2 finding → demote to spec lane.

**Per-turn watchdog:** the cold path's deadline (`timeoutMs`, default 300s) maps to a per-turn timer in `runTurn` → `query().interrupt()` + `timedOut: true` on the result. The session survives a timed-out turn.

**Throw-safety and promise ownership (load-bearing — the lease introduces lifecycle callbacks that run outside any request's try/catch):**

- **Timer callbacks are try/catch-wrapped.** The idle-timeout and lifetime-cap callbacks run on bare `setTimeout` — a synchronous throw there is an `uncaughtException`, and the engine registers only an `unhandledRejection` handler (`index.ts:878`). Both callbacks wrap their body (close + registry cleanup) in try/catch, log-and-swallow.
- **`lease.close()` is no-throw and idempotent.** It is invoked from at least four contexts: the timers, `ticket.abort()` via `stopAgent`'s ticket walk — which, unlike 322's `abortThread`, has **no per-ticket try/catch** (`agent-manager.ts:1318-1323`), so a throwing `close()` would skip the agent's remaining tickets — the turn-failure path, and shutdown. Contract: every internal step of `close()` is individually guarded, a second call is a no-op (closed flag), and it never rejects.
- **The detached coordinator promise has a declared owner.** Lease open runs `withSpawnTicket(ctx, lambda)` where the lambda resolves only at release — so turn 1's `spawnTurn` call returns a `TurnResult` while that promise stays pending for the call's duration. Sequencing: lease open **awaits ticket acquisition** (a "lease ready" gate) before running turn 1, so budget-exceeded / `AgentStoppedError` at acquisition propagate synchronously to turn 1's caller and the existing adapter error rows. After acquisition, the pending coordinator promise is owned by the lease object, with a `.catch()` attached at creation (before any await can float it) that logs and force-removes the registry entry — post-acquisition rejection is a should-never state (release resolves the lambda; `close()` never rejects), so the handler is belt-and-braces against the process-level `unhandledRejection` logger being the only backstop.
- **`interrupt()`'s Promise** is handled inside `abortThread`'s warm dispatch — fire-and-forget with `.catch()` → log + `lease.close()` (§4.4).

**What turns 2..N skip:** CLI boot, session-transcript reload, all MCP re-handshakes (stdio subprocesses live for the call), hooks/options assembly, coordinator lock/budget re-admission. **What remains:** the adapter's pre-spawn reads (T0→T1 — `buildVoiceSystemPrompt` + `sessionStore.get` run per turn as today, ~ms; the post-turn-1 prompt rebuild is computed and discarded — deliberately NOT optimized away, the adapter seam stays untouched), breaker check (µs), queue push, model TTFT. `WorkItemContext` is call-stable on voice (channelId = callId, threadId fixed), so constructor-time context capture — the KPR-122 pattern — is correct for the whole call; the `*ContextRef` per-turn update degenerates to a no-op.

### 4.3 KPR-220 invariants — preserved, not carved out

- **Per-thread lock:** held by the lease for the call. Same-thread serialization is *stronger* than today (in-session queue). Cross-thread behavior unchanged.
- **Budget:** one slot per active call, acquired/released through the unmodified `withSpawnTicket` accounting. Saturation at call-start throws the existing `"Spawn budget exceeded for …"` error → adapter's existing 503 row → worker fallback line (322 §8). Explicit consequence: an agent at `spawnBudget: 5` supports 5 concurrent calls and zero headroom for non-voice turns at voice saturation — surfaced in snapshot/doctor so operators size pilot agents deliberately. No auto-bump, no separate voice budget (simplicity; revisit only if the pilot hits it).
- **Tickets/stop:** the lease's ticket is in `activeTickets`; `stopAgent`/`stopAll`/`restartAgent` and `sweep` work unchanged. `AgentStoppedError` checkpoints fire at lease open exactly as for any spawn.
- **Reflection:** see §4.5.

### 4.4 E2 reconciliation (binds 322 §7 / plan Task 3)

322's E2 wires premature socket close → `AgentManager.abortThread` → `ticket.abort()`. Cold path: unchanged and correct. Warm path: `ticket.abort()` would kill the whole call session on every barge-in — the caller is still on the line. Reconciliation, layered so 322's delivery lands first and stays green:

- **The dispatch lives inside `abortThread`, not beside it.** `abortThread(agentId, threadId): boolean` (322's signature, unchanged) checks the warm-lease registry first: lease present → dispatch `query().interrupt()` on the in-flight generation (session stays open, input queue stays live) and return true; no lease → 322's existing ticket-walk abort, verbatim. The method's contract is "sever the in-flight turn for this thread" — under a warm lease the correct severing is a turn interrupt, under a cold spawn it is the spawn abort. Considered and rejected: a separate `interruptThread` method — it would force a rename in the adapter's close-listener and break 322 plan Task 3's committed tests (the integration mocks stub `abortThread: vi.fn()` and assert it is called with `("test-agent", "voice:call-e2")`; a renamed call would land on a missing mock method, be swallowed by the listener's try/catch, and time the test out). With internal dispatch, **zero 322 artifacts change**: adapter wiring, mock surfaces, and assertions all keep passing; 323 only *adds* warm-lease cases to `agent-manager.test.ts` (new-feature tests, not edits).
- `interrupt()` returns a Promise: `abortThread` stays synchronous-boolean — it dispatches the interrupt fire-and-forget with an attached `.catch()` that logs and escalates to `lease.close()` (an interrupt that fails means the session may be wedged; closing it converts the situation into the standard cold-fallback path, §6). The boolean reports "a matching in-flight turn was severed", same as 322.
- Barge-in vs hang-up is indistinguishable at the engine socket. Interrupt-and-keep-warm is correct for both: barge-in → next turn arrives in ms and hits a hot session; hang-up → no next turn → idle timeout reclaims the lease in ≤120s.
- Post-interrupt turn state: the interrupted turn returns `aborted: true` with whatever text already streamed (it was spoken — 322 §8 mid-stream row); the next `runTurn` proceeds in-session. If the session is wedged post-interrupt, `runTurn` errors → lease closes → cold fallback (§6). ⚠ `interrupt()`-then-continue is a W2-verified behavior.
- 322 §7's transcript-divergence marker (interruption-marker prefix on the next user message) flows through unchanged — it arrives inside the turn text.

### 4.5 Reflection, prefix cache, SIGUSR1

- **Reflection:** warm turns must not schedule per-turn debounce timers — a timer firing mid-call hits the `processing.has(threadKey)` quiescence check (`agent-manager.ts:944-947`), skips without rescheduling, and the reflection is lost. Design: the lease counts turns and calls `scheduleReflectionIfEligible` **once at release** with the final turn's ctx/result, crediting `pendingReflectionTurns` with the call's turn count. ⚠ Note for the plan: the method as written increments by exactly **1** per invocation (`agent-manager.ts:891` — `(prior ?? 0) + 1`), so crediting a call's N turns needs a small signature extension (e.g., an optional `turns: number = 1` increment parameter — additive, cold callers unchanged). Net behavior: one reflection ~30s after call end — strictly saner than today's per-turn schedule/cancel churn, and `reflectionMinTurns <= 0` still disables.
- **Prefix cache (KPR-213):** not in the voice path at all — voice uses `systemPromptOverride`, bypassing `buildSystemPrompt`/`buildPrefix` (`agent-runner.ts:1714`). Unchanged. Behavior delta worth stating: the adapter still rebuilds the voice prompt (incl. hot-tier memory) every turn — that cost persists (§2) — but the warm session only ever **uses** the turn-1 build; post-turn-1 rebuilds are computed and discarded. Net effect: mid-call memory writes by the agent itself are already in session context; external memory writes landing mid-call won't reach the session prompt until the next call. Accepted for minutes-scale calls.
- **SIGUSR1 / agent-def updates:** registry reload never touched in-flight spawns; a warm lease extends "in-flight" to the call duration. A def update lands on the next call. Accepted and documented; no invalidation machinery (simplicity — calls are short).
- **Anthropic-side prompt caching:** a warm session reuses one conversation thread, so per-turn prefix reuse improves vs. cold resume; no design action, telemetry (`cacheReadTokens`, already per-turn) will show it.

### 4.6 Observability

- **Snapshot/heartbeat:** the lease is a real ticket → `activeSpawns`/`activeThreadKeys` already show it. Additive field `warmVoiceSessions: number` on `CoordinatorSnapshotPerAgent` + the `spawn_coordinator_stats` heartbeat doc; `hive doctor`'s spawn-coordinator section renders it (informational, never flips exit code — KPR-296 rule).
- **Per-turn log:** "Voice turn complete" gains `warmPath: boolean` + `warmTurnSeq` alongside the §2 decomposition fields. `firstTokenMs` semantics unchanged (request-arrival → first SSE byte) so warm/cold/baseline numbers are directly comparable.
- **No content, no numbers-of-humans:** all additions are durations, counters, booleans — repo log-redaction posture holds.

### 4.7 Scope guards

- **Claude provider only:** `resolveProviderModel(...).provider !== "claude"` → always cold path (pilot adapters have no session/stream machinery; voice on non-Claude providers is out of pilot scope anyway).
- **Voice channel only, real turns only:** `ctx.channel === "voice" && ctx.kind !== "reflection"` gates the branch. Chat channels keep per-turn spawn (their cadence never pays for a held budget slot); the reflection guard matters because a post-call reflection turn on a voice thread carries `channel: "voice"` (captured `lastChannelKind`) and must never open a lease — reflection always runs cold. Explicit non-goal to generalize (§8).
- **Config:** `voice.warmPath.enabled: boolean`, default at delivery discretion (recommend `false` on merge, flipped after W2 passes). `false` = the branch is never taken — byte-identical today-path. Idle timeout (120s) and lifetime cap (2h) are named constants, not config (no preemptive levers; the enabled flag is the rollback).

## 5. Interaction contracts (composition summary)

| Surface | Contract |
|---|---|
| 322 bridge (`POST /v1/chat/completions`) | Unchanged — warm/cold invisible behind the seam (322 §9.1). `call.id`→`threadId = voice:<callId>` keys the lease registry. Full-transcript-every-turn is load-bearing: it makes cold fallback after any warm death lossless. E1 auth orthogonal (pre-turn). |
| `dispatcher.routeVoiceTurn` (KPR-223) | Unchanged — it calls `spawnTurn`, and the warm branch lives inside `spawnTurn`. taskLedger + audit fire per turn as today. |
| Outer retry (`voice-adapter.ts:337-351`) | Unchanged — a failed warm turn surfaces as `outcome.ok === false`; the retry's `sessionId: undefined` ctx hits `spawnTurn`, which must **not** route a full-transcript retry into a possibly-broken lease → rule: a turn-level failure closes the lease before the error propagates, so the retry always lands cold. |
| Circuit breaker (KPR-306/307) | Per-**turn** acquire/record inside `lease.runTurn` (the provider call is per turn even when the subprocess is warm). Circuit-open mid-call: turn fast-fails pre-push → adapter speaks the outage notice (322 §8 row); the lease stays open (half-open probes are real turns; recovery is seamless mid-call). |
| Model router | Voice bypasses it today (`prepareSpawn` carve-out) — unchanged; the warm session pins the agent-definition model for the call (`setModel` explicitly out of scope). |
| Session store | Written per turn from `result.sessionId` via `finalizeSpawnResult` (rotation-safe, KPR-211 semantics ⚠ streaming-mode verify); 7-day TTL and `(agentId, threadId)` keying untouched. |
| E2 (322) | `abortThread` name, signature, adapter close-listener wiring, and 322's tests all unchanged; the warm-lease dispatch lives inside the method (§4.4). `ticket.abort()` keeps kill semantics for stop. Delivery ordering: 322 T3 merges first; 323's dispatch layers inside without touching its artifacts. |
| Vapi coexistence | Warm path applies to Vapi calls identically (same adapter, same threads). Dual-writer risk unchanged from 322 (thread ids can't collide). |

**Call-end signal:** none exists today (Vapi sends no end-of-call to this endpoint; 322's worker contract has none either). Idle timeout is the designed primary release. Seam note for 322/325 delivery ⚠ (non-blocking): the worker knows the room closed and MAY send an explicit release (e.g., `DELETE /v1/calls/<id>` with the bridge bearer) as an additive optimization reclaiming the budget slot ~2 min sooner; designing that endpoint is deferred until someone needs it.

## 6. Failure / edge cases

**Failure-close precedence rule (the one place it is stated — do not generalize "failure closes the lease"):** a circuit-open fast-fail does **NOT** close the lease (§5 breaker row — the message is never pushed, the session is healthy, half-open probes recover mid-call); **every other turn-level failure closes the lease before the error propagates** (§5 outer-retry row — so the retry always lands cold). The two rules reconcile at the adapter's retry gate: its condition excludes circuit-open (`!outcome.circuitOpen`, `voice-adapter.ts:337`), so the one failure class that leaves the lease open is exactly the one that never triggers the cold retry that assumes a closed lease.

| Case | Behavior |
|---|---|
| Abnormal call end (worker crash, carrier drop — no more turns) | Idle timer fires at 120s → lease closes, lock + budget slot released, subprocess reaped. Worst cost: one budget slot held ≤120s past call end. |
| Warm subprocess crash mid-call | Output stream errors → in-flight turn returns error → **lease closes first**, error propagates → adapter outer retry runs cold with full transcript → caller hears one slower turn. Next turns re-open a lease (fresh turn-1 cost). |
| Engine restart mid-call | Leases are in-memory → gone. Next turn arrives on the restarted engine → cold path resumes from Mongo sessionId (persisted every turn) or full-transcript retry. Identical recovery to today. |
| Budget saturated at call start | Lease open throws the existing budget error → 503 → worker retry-once-then-apologize (322 §8). String `"Spawn budget exceeded"` preserved for the adapter's match ⚠ (W3 typed-error re-bind, §9). |
| Concurrent calls, same agent | N calls = N leases = N slots; per-thread isolation total. Snapshot shows each. Budget 5 default → 5 concurrent calls; pilot sizing note in §4.3. |
| `stopAgent` / operator abort mid-call | Ticket walk → `lease.close()` → in-flight turn errors → adapter 500 → worker apologize-and-end (322 §8). Stop means stop. |
| Barge-in (socket close mid-generation) | `abortThread` warm dispatch (§4.4) → generation cancelled in-session; next turn is warm and immediate — strictly better than cold E2 (which pays a fresh spawn post-abort). |
| Turn exceeds deadline | Per-turn watchdog → `interrupt()` → `timedOut: true`; session survives; breaker records the timeout per existing classification. |
| Session compaction mid-call | Handled inside the long-lived session by the SDK; rotated id captured from `result` and persisted per turn. |
| Zero-content turn | Empty stream → `[DONE]` with no chunks — worker's existing no-reply handling (322 §5.1). |
| Lease hits 2h lifetime cap | Closed as idle-timeout; an (implausible) still-live call degrades to cold turns — never an error. |
| Warm session leak (bug class) | Backstops: unref'd idle timer per lease, lifetime cap, `sweep()` unchanged (tickets are real), `warmVoiceSessions` heartbeat makes a stuck count operator-visible in `hive doctor`. W-leak drill (§7) exercises all of this. |

## 7. Empiricism plan — designed, NOT run (each run requires a recorded operator go, D3)

| Gate | What runs | Pass / decision rule |
|---|---|---|
| **W0 — baseline bless** | Read-only log harvest per §3 (production logs, zero behavior change) | Sample minimums met (or small-n accepted); operator blesses; artifact committed. Unblocks 322 P2's placeholder. |
| **W1 — decomposition** | After C1 instrumentation lands: ≥20 live turns of normal Vapi traffic read from the new log fields (no synthetic calls needed; one operator-placed scripted call permitted if traffic is thin) | Attribution of the tax across §2 stages. **Falsification rule:** if T3→T5 + T2→T3 < 40% of `firstTokenMs` p50, the warm path cannot clear the bar → this ticket demotes to spec lane and mechanism C is designed against the measured components. Otherwise proceed. |
| **W2 — warm A/B + behavior verify** | Scripted 10-turn call shape (reuse 322 §14.2 script + `voice-pilot` test agent — never production defs), on the **Vapi path** (pre-322-delivery capable): N=5 calls warm-on vs N=5 warm-off, same day, same agent/model/script. Plus in-run behavior checks: turn demux correctness (every turn answers its own utterance), interrupt-then-continue, one mid-call subprocess-kill fallback drill | Turns 2+: warm `firstTokenMs` p50 ≤ **[baseline − 800ms]**, and ≤ **900ms** absolute ⚠ placeholders — re-derived from W1's measured T5→T6 floor (target = TTFT floor + ≤150ms overhead). Zero cross-turn bleed; fallback drill recovers within one turn. Demux or interrupt failure = material → demote. |
| **W-leak — soak/reclaim** | 3 concurrent calls on the test agent; 1 abnormal end (kill worker/hang up mid-call); 1 engine restart mid-call | Within 150s of each event: snapshot `warmVoiceSessions` returns to expected, budget slots freed, no orphan `claude` processes (`ps` check), session store consistent (next call resumes clean). |
| *(322 P2/P3)* | Owned by 322 — but P2 binds to W0's artifact, and P3's post-interruption bound is expected to be **met by the warm path with margin**; record warm-vs-cold in the epic decision register when both exist. |

Approvals are per-gate, never generalized; results land in lane notes + the epic decision register.

## 8. Non-goals

- **Delivery** — W5 is maturity-only; nothing here runs until operator re-open.
- **KPR-324 mid-call tool contracts** — reference only (D2). The warm path changes nothing about the tool-latency gap (deltas pause during server-side tool runs exactly as on the cold path; 324's masking levers apply unchanged).
- **KPR-325 persona/rubric** — untouched (D4).
- **Warm path for non-voice channels** — chat cadence never amortizes a held budget slot; explicitly out.
- **Generic subprocess pre-warm pool** (mechanism B) and **per-turn component shaving** (mechanism C) — rejected/fallback per §4.1.
- **Mid-call model switching** (`setModel`), voice-prompt hot-rebuild mid-call, explicit end-of-call release endpoint (seam-noted only), SDK V2 `SDKSession` adoption, non-Claude-provider voice, Vapi migration, anything requiring W1B.

## 9. W3 anchor hazard — Task-0 re-confirm at delivery (mandatory)

Anchored to kpr-320 @ d074d5c (main @ W6). Epic kpr-309 (W3 — merged into that branch but **not** on main: KPR-311 router→adapter seam unification, KPR-312 classifier v2, KPR-313 session-identity guards, KPR-314 sidecar LLM registry, KPR-338 fixed-tier agents) reshapes `agent-manager.ts` and `model-router.ts` substantially (KPR-338 alone rewrites ~160 lines of agent-manager). Before any delivery work:

1. **`spawnTurn` / `withSpawnTicket` internals** (`agent-manager.ts:563-771`) — this spec adds a branch at the top of `spawnTurn` and a lease that occupies a ticket; any W3 reshaping of the HOF, ticket shape, or breaker-acquire placement is **material**.
2. **`TurnContext` / session keying / resume semantics** — KPR-313's session-identity guards may alter `(agentId, threadId)` keying or rotation handling the lease's per-turn persistence rides on.
3. **Adapter error taxonomy** — `"Spawn budget exceeded"` string-match and `isAuthError` regex (`voice-adapter.ts:24-29, 375`) → re-bind to typed errors if W3 landed them.
4. **`AgentRunner.send` / abort surfaces** (`agent-runner.ts:1525, 2090-2097`) — the lease needs a session-opening sibling to `send()` (reusing `buildAllServerConfigs`/hooks/options assembly); pin exact factoring against delivery-time code.
5. **SDK pin** — exact `@anthropic-ai/claude-agent-sdk` version (^0.2.63 at spec time); verify `prompt: AsyncIterable<SDKUserMessage>`, `Query.interrupt()`, `Query.streamInput()`, per-message `result` emission, and session-id fields in streaming-input mode against the installed typings. Note the typings already state control requests (`interrupt()` among them) are "only supported when streaming input/output is used" (`sdk.d.ts` Query interface comment) — positive evidence for §4.4's design: a cold turn (string prompt) has no interrupt surface, so `abortThread`'s no-lease fall-through to spawn-abort is not merely compatible but the only option. Extension-point disappearance = material → demote.
6. **322 E2 landing shape** — Task 3's `abortThread` + close-listener wiring as actually merged (including its mock surfaces and assertions); 323's warm-lease dispatch layers **inside** `abortThread` (§4.4) — confirm the merged method body still matches the plan's ticket-walk shape before inserting the branch.
7. Verified at spec time (2026-07-14): **no KPR-208 artifacts** in tree or history; no W3 warm-path rails exist on kpr-309 (its tickets are provider-seam/classifier/identity work, not spawn-latency work).

## 10. Engine-change inventory (the entire delivery-time diff)

| # | Change | Where | Size |
|---|---|---|---|
| C1 | Cold-turn decomposition fields on "Voice turn complete" (§2) — timestamps at six anchors, log-only | `voice-adapter.ts`, `agent-manager.ts`, `agent-runner.ts` | small |
| C2 | Warm call session lease: `src/agents/warm-voice-session.ts` + registry/branch in `spawnTurn`, per-turn breaker + finalize/observability reuse, idle/lifetime timers, release-time reflection hook | `src/agents/` | the ticket's core; medium |
| C3 | Warm-lease dispatch inside `abortThread` (§4.4): lease present → turn `interrupt()` (fire-and-forget + `.catch` → `lease.close()`); else 322's ticket-walk verbatim. **Zero adapter diff, zero 322-test edits** — 322 plan Task 3's integration tests (mock `abortThread: vi.fn()`, assertion on `("test-agent", "voice:call-e2")`) keep passing unchanged; C3 adds new warm-lease cases to `agent-manager.test.ts` only | `src/agents/agent-manager.ts` | small |
| C4 | `voice.warmPath.enabled` config key (liberal-loader style) | `src/config.ts` | trivial |
| C5 | `warmVoiceSessions` on snapshot + heartbeat + doctor section (informational) | `agent-manager.ts`, `spawn-coordinator-heartbeat.ts`, doctor | small |
| C6 | `scripts/voice-latency-baseline.ts` — read-only harvester + artifact emitter (§3) | `scripts/` | small |

No new processes, no new HTTP surfaces, no schema changes, no new secrets (nothing here touches Keychain/Honeypot; no credential ever enters logs, artifacts, or transcripts).

## 11. Risks & delegated-assumption registry (⚠ verify-at-execution)

- ⚠ **SDK streaming-input turn demux** — per-pushed-message `result` emission is the lease's turn boundary (§4.2). Verified at Task-0 (typings + pinned version) and W2 (live). Failure = material demote. *The single biggest assumption in this spec.*
- ⚠ **`interrupt()` leaves the session usable** for the next queued turn (§4.4). W2-verified; fallback if false: interrupt degrades to lease-close + cold next turn (still correct, loses the barge-in win).
- ⚠ **Session-id rotation visibility in streaming mode** — per-turn `result.session_id` capture (KPR-211 semantics) assumed to hold under streaming input; affects crash recovery precision (full-transcript retry covers the gap regardless).
- ⚠ **Per-turn usage/cost attribution in streaming mode** — `result` usage assumed per-exchange, not cumulative; affects telemetry/activity-log accuracy only.
- ⚠ **W2 pass thresholds are placeholders** until W1 measures the TTFT floor; W0's artifact numbers bind 322 P2 regardless.
- ⚠ **Idle timeout 120s / lifetime cap 2h constants** — pilot-tunable by code change; deliberately not config.
- ⚠ **Baseline sample minimums** (50/20 in ≤30 days) — operator may bless small-n with the shortfall recorded.
- ⚠ **`"Spawn budget exceeded"` string contract** with the adapter survives until W3's typed errors re-bind it (§9.3).
- ⚠ **Explicit end-of-call release** — seam note only (§5); idle timeout is the designed mechanism.
- ⚠ **`scheduleReflectionIfEligible` turn-credit extension** (§4.5) — optional increment parameter, additive; plan pins the exact shape.
- **Risk — budget slot occupancy:** a call holds a slot for its duration + ≤120s; voice-heavy agents need `spawnBudget` sized for peak concurrent calls. Mitigation: snapshot/doctor visibility (C5) + pilot-scale (1–2 concurrent calls) is far below the default 5.
- **Risk — long-lived subprocess memory/stability:** one CLI process per active call, minutes-lived — strictly fewer process-hours than today's per-turn spawns for the same call; W-leak drill covers reclaim paths.
- **Risk — behavior deltas** (session uses only the turn-1 prompt build — per-turn rebuilds persist but are discarded; def updates land next call; one reflection per call): each is stated in §4.5 and accepted; none affects correctness.

## 12. Sources (checked 2026-07-14)

Hive code (lane worktree @ d074d5c): `src/agents/agent-manager.ts` (spawnTurn `:563-655`, withSpawnTicket `:673-771`, reflection `:881-1008`, prepareSpawn voice carve-out `:1092-1093`, finalize/observability `:1146-1270`), `src/agents/agent-runner.ts` (send `:1525`, in-process MCP wiring `:1537-1706`, systemPromptOverride consumption `:1714`, query options `:1790-1834`, init/delta/result loop `:1881-1999`, abort `:2090-2097`), `src/agents/session-store.ts` (`_id` keying `:61`, 7-day TTL `:32`), `src/channels/voice/voice-adapter.ts` (pre-spawn `:243-256`, onStream/SSE `:270-289`, outer retry `:337-351`, error rows `:353-392`, "Voice turn complete" `:423-432`), `src/channels/voice/conversation-prompt.ts`, `src/channels/dispatcher.ts` (routeVoiceTurn `:752`), `src/agents/prompt-builder.ts` (buildVoiceSystemPrompt `:12+`), `src/config.ts`. SDK: `@anthropic-ai/claude-agent-sdk` ^0.2.63 typings (`sdk.d.ts` — `Query.interrupt()`/`streamInput()`/`close()`, `query({prompt: string | AsyncIterable<SDKUserMessage>})`, `SDKSession` @alpha). History: pre-KPR-220 long-lived per-agent `query()` loop (CLAUDE.md §Spawn coordinator; KPR-210 eb064c6, KPR-220 4b62b89-era) — precedent for streaming-input sessions in this engine; `git log --all --grep=KPR-208` → empty (subprocess pool never shipped). Siblings: `docs/epics/kpr-320/kpr-322-spec.md` (§4–§9, §13–§15, §18), `kpr-322-plan.md` (Task 3 E2 wiring, Testing Contract).
