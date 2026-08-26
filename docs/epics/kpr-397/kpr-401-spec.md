# KPR-401 — Aborted turns record costUsd=0 and negative llmMs: spend and latency accounting blind to timeouts

> Child of hotfix epic KPR-397. Canon consumed: Decision Register D1 (progress predicate binary OR, fail-closed), D3 (with-progress deadline never enters outage_queue), D6 (kpr-398-spec §Design.4 classification contract table), D8 (accepted residuals); KPR-399's abort-persist surface (sessions persist on aborted-with-progress — code on PR #414, not on this branch yet).

## TL;DR

When the wall-clock deadline (or an operator abort) closes the SDK iterator, no `result` message ever arrives, so `agent-runner.ts` finishes `send()` with `costUsd=0, durationMs=0` and all token counters at 0 — and then computes `llmMs = 0 − toolMs`, a large negative. Fix, Claude lane only: accumulate per-API-call usage from the assistant messages the SDK already streams (result message stays authoritative when it arrives), record wall-clock `durationMs` when the result message is absent, clamp `llmMs = max(0, durationMs − toolMs)` (Lane B parity), and surface `aborted`/`timedOut` on the three consumer records that lack them (dispatcher "Work item dispatched" log line, `agent_turn_telemetry` doc, `activity_log` doc) so dashboards can segment. `costUsd` stays 0 on result-less turns — the SDK never streams cost mid-turn, and we do not estimate. The breaker's p95 window is untouched and pinned: `pushSample` runs only on `outcome: "success"` and independently rejects negatives. Lane B adapters are verified clean (non-goal, evidence below).

## Key Points

- **Defect site is exactly one function**: `AgentRunner.send()` (`src/agents/agent-runner.ts` ~L2003–2283). A ticket-text correction: the abort doesn't "zero the total" — the total is *never set*, because `costUsd`/`durationMs`/tokens are assigned only inside the `msg.type === "result"` branch (L2120–2143) and `abort()` closes the iterator without emitting one. `llmMs = durationMs - totalToolMs` (L2222) then yields `0 − toolMs`. Matches the evidence line (`llmMs=-294391 toolMs=294391`).
- **Partial usage is genuinely available mid-turn**: each SDK `assistant` message is a full `BetaMessage` (`SDKAssistantMessage.message: BetaMessage`, sdk.d.ts:2461-2468) carrying `usage: BetaUsage` — per-API-call `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. The runner already iterates these messages (L2094); it just never reads `.usage`. Summing per-message usage is the same cumulative semantics the SDK's own result usage uses.
- **The SDK never streams cost**. `total_cost_usd` exists only on the result message. On a result-less turn `costUsd` stays 0 — honest, flagged via `aborted:true`, and tokens are the segmentable spend signal. No estimation from a pricing table (metering redesign, out of hotfix scope; fleet runs subscription auth where costUsd is nominal anyway).
- **The breaker is already double-guarded** against this defect's negative values: `record()` calls `pushSample(llmMs)` only in the `case "success"` arm (provider-circuit-breaker.ts:262-264) — aborted (`"aborted"`) and deadline (`"turn-deadline"`/`"timeout"`) outcomes never sample — and `pushSample` itself rejects `!Number.isFinite(llmMs) || llmMs < 0` (L455). Today's negative llmMs on aborted turns is harmless to the breaker. This ticket changes no breaker code; it **pins** both guards with tests (ticket constraint: "keep it that way").
- **Lane B is clean — non-goal with evidence**: all three adapters anchor `const startedAt = Date.now()` and stamp `durationMs: Date.now() - startedAt` on *every* exit path including `abortedResult()`/`deadlineResult()` (codex L168-206, gemini L190-232, openai L62-77/180-200), already clamp `llmMs: Math.max(0, durationMs - toolMs)` (codex L501, openai L340, gemini L570), and already flow partial token accumulators (`totals`) into their aborted/deadline results. Nothing to fix there.
- **KPR-399 interplay is a rationale supersession, not a contradiction**: KPR-399's spec left the `recordSpawnObservability` telemetry guard unchanged "deliberately (no usage data)" and persists aborted-turn sessions *without* `tokenData` for the same stated reason. This ticket removes that factual ground (aborted turns now carry real usage) and takes the telemetry surface — a different guard on a different line than KPR-399's session-persist gate, which this ticket does not touch (constraint 2).
- **D1 is not extended**: the progress predicate stays `toolCalls > 0 ∨ streamed ∨ text ≠ ""`. Token counters do NOT join it — usage>0 without those signals is not "progress" for classification. Classification inputs (`error`/`timedOut`/`aborted`/`toolCalls`/`streamed`/`text`) are untouched by this ticket, so every row of the D6 contract table holds byte-for-byte.

## Problem

Deadline-aborted turns (224 in the recent dodi window, incl. Milo's 52 cron turns) log and return:

```
costUsd=0 durationMs=0 llmMs=-294391 toolMs=294391 toolCalls=46 inputTokens=0 outputTokens=0
```

Real tokens were bought, 46 tools ran, subagents spawned — and every consumer sees zeros:

1. **Runner completion log** ("Agent response complete", L2266-2272) — carries `aborted`/`timedOut` (good) but zero usage and negative llmMs.
2. **Dispatcher "Work item dispatched"** (`src/channels/dispatcher.ts:338`) — the evidence line; logs `costUsd/durationMs/llmMs/toolMs/toolCalls` with **no aborted/timedOut fields**, so log-based dashboards can't even segment the zeros out.
3. **`agent_turn_telemetry`** (`recordSpawnObservability`, agent-manager.ts:1803) — gated `result.sessionId && !result.aborted`: aborted turns are wholly absent from the doctor's token/cache aggregation.
4. **`activity_log`** (agent-manager.ts:1842) — written unconditionally with `costUsd:0, durationMs:0` and no aborted flag: aborted turns masquerade as free, instant, clean turns in the audit trail.
5. **Breaker `record(permit, classification, llmMs)`** (agent-manager.ts:1095) — receives the negative llmMs but is immune (success-only sampling + negative guard). Not part of the defect; must stay immune.
6. **Session store metadata** (finalizeSpawnResult) — skipped on aborted turns today; KPR-399 (PR #414) will persist the *handle* without tokenData. Out of scope here (see Non-Goals).

## Goals

1. Aborted/timed-out Claude-lane turns record the tokens actually bought (cumulative across the turn's completed API calls, subagent calls included).
2. `durationMs` is real wall-clock on every outcome; `llmMs` is never negative.
3. Every consumer record that reports per-turn accounting can segment aborted turns: `aborted` (+`timedOut` where distinct) on the dispatcher log line, the telemetry doc, and the activity doc.
4. Success-path accounting is byte-identical (result message stays authoritative).
5. Breaker p95 sampling provably unpolluted — pinned by tests, zero breaker code change.

## Non-Goals

- **No Lane B changes** — verified clean (Key Points; adapter line refs).
- **No costUsd estimation / pricing-table lookup.** costUsd on result-less turns is 0 by design, segmented by the aborted flag.
- **No behavior changes to dispatch, classification, persistence, or the breaker** (constraint 3): `classifyTurnResult` inputs unchanged (D6 table intact), D3 outage gate untouched, KPR-398's D1 predicate untouched, KPR-399's session-persist gate and no-tokenData persist untouched.
- **No dashboard/doctor rendering changes.** The doctor's cache aggregation pipelines (turn-telemetry.ts `hitRatesByAgent`, doctor-checks.ts `cacheHitRatesForDoctor`) are unchanged — newly-recorded aborted docs join them (their completed API calls are real cache traffic; see Edge cases), and the sparse `aborted` field enables future segmentation without requiring any now.
- **No contextWindow/preCompactTokens recovery on aborted turns** — `contextWindow` comes only from result `modelUsage`; stays 0 on result-less turns (optional-shaped consumers tolerate it). Accepted residual.

## Design

### 1. Runner accounting (`src/agents/agent-runner.ts`, `send()`)

Four minimal edits, all inside `send()`:

**(a) Wall anchor.** `const turnStartedAt = Date.now();` immediately before the message loop (alongside the existing deadline arm at L2024).

**(b) Streamed-usage accumulation.** Add a `sawResult = false` flag. In the existing `msg.type === "assistant"` branch (L2094), read `(msg as any).message?.usage` and **add** its per-call counters into the existing `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheCreationTokens` variables (null-coalesced to 0 — `BetaUsage` fields are `number | null`). Accumulate for *every* assistant message, including subagent ones (`parent_tool_use_id != null`) — subagent spawns are paid spend and the ticket names them. In the `msg.type === "result"` branch, set `sawResult = true` and keep the existing **assignments** (not additions) — the result usage is the SDK's own cumulative total and authoritatively overwrites the accumulator, so the success path and the `error_during_execution` path are byte-identical to today.

**(c) Wall durationMs fallback.** After the loop/finally, before llmMs: `if (!sawResult) durationMs = Date.now() - turnStartedAt;`. This covers all three result-less exits: deadline abort, operator abort, and the mid-iteration throw (`catch` at L2175 — the crash path today also logs `durationMs: 0`; it now gets wall clock and whatever usage accumulated).

**(d) Clamp.** `const llmMs = Math.max(0, durationMs - totalToolMs);` — unconditional, mirroring the three Lane B adapters verbatim. On aborted turns (wall duration ≈ toolMs + llm time) this makes llmMs approximately meaningful; on success turns it only alters values that were negative from clock skew — which `pushSample` drops today and which will now enter the window as 0-samples, exactly as Lane B success turns already do (accepted, see Edge cases).

No changes to `abort()`, the deadline timer, `timedOut`/`aborted` stamping, tool timing, `resultText`, or the completion-log level policy. The completion log and returned `RunResult` pick up the corrected values through the existing fields; `RunResult`'s shape is unchanged (all needed fields exist).

### 2. Aborted-turn telemetry (`src/agents/agent-manager.ts`, `recordSpawnObservability`; `src/agents/turn-telemetry.ts`)

- Relax the turn-telemetry gate from `result.sessionId && !result.aborted` to:

  ```ts
  const hadUsage = result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheCreationTokens > 0;
  if (result.sessionId && (!result.aborted || hadUsage)) { ... }
  ```

  Aborted turns with real spend are recorded; zero-usage aborted turns (operator abort pre-first-API-call, and the manager's `synthesizeAbortedResult` early-abort shape, which carries a resumed sessionId but never spawned) stay out — nothing to account, no noise docs.
- `TurnTelemetryInput`/`TurnTelemetryDoc` gain optional `aborted?: true` (sparse: set only when true, matching the ephemeral-counter optional style). `recordSpawnObservability` passes `...(result.aborted ? { aborted: true } : {})`.
- Aggregation pipelines unchanged (Non-Goals).

### 3. Flag surfaces (dispatcher log, activity log)

- **`src/channels/dispatcher.ts:338`** — add `aborted: runResult.aborted, timedOut: runResult.timedOut` to the "Work item dispatched" log fields. `convertTurnResult` already maps both faithfully (dispatcher.ts ~L410, per its every-field-explicit contract) — no mapping change needed.
- **`src/activity/types.ts`** — `ActivityRecord` gains optional `aborted?: boolean; timedOut?: boolean;`; `recordSpawnObservability`'s `activityLogger.record({...})` passes them from the result. Mongo docs gain the fields sparsely; no reader changes (activity log has no aggregating consumer that breaks on extra optional fields).

### 4. Breaker — zero code change, two pins

No edit to `provider-circuit-breaker.ts`. Tests pin (in `provider-circuit-breaker.test.ts`):
1. `record()` with `{outcome:"fault", kind:"turn-deadline"}` / `{outcome:"aborted"}` and a large positive `llmMs` leaves the p95 window empty (success-only sampling — now load-bearing for this ticket, since aborted turns will start carrying large real llmMs values).
2. `record()` success with `llmMs: -1` leaves the window empty (the `pushSample` negative guard — belt for any future non-clamped caller).

## Integration points

| Ticket / surface | Relationship |
|---|---|
| KPR-398 (D1, D6) | Classification inputs untouched: progress predicate stays `toolCalls ∨ streamed ∨ text` — **not** extended with token counters. Every D6 table row unchanged. The manager's `record(permit, classifyTurnResult(finalResult), finalResult.llmMs)` (L1095) now receives a clamped non-negative llmMs; consumed identically (non-success outcomes never sample). |
| KPR-399 (PR #414, merges into this epic branch) | Its surface — the `finalizeSpawnResult` session-persist gate + no-tokenData aborted persist — is not touched. Textual merge overlap is nil (different functions); semantic note: KPR-399's "no usage data on aborted turns" rationale is superseded by this ticket, but back-filling `tokenData` on the aborted persist is deliberately left to a follow-up (session token metadata is a cache-stats nicety; stale-not-wrong). The one shared line-neighborhood is `recordSpawnObservability` L1803, which KPR-399's spec explicitly declares unchanged — this ticket owns that edit. |
| D3 / dispatcher outage gate | Untouched. The "Work item dispatched" edit is a log-fields-only change on a different call site (L338); the gate at ~L551 and its classification input are not modified. |
| Doctor / dashboards | `hive doctor` cache section now includes aborted-turn spend (correct: real API traffic). No renderer change in this ticket. |
| Lane A passthrough (kimi/deepseek/grok) | Rides the fix automatically — `ClaudeAgentAdapter` returns `runner.send()` verbatim (same mechanism as the D6 table's Lane A note). costUsd remains nominal there regardless. |
| Reflection turns | Same `spawnTurn` path; no special handling. A timed-out reflection turn becomes visible spend like any other. |

## Edge cases

- **Abort before `init` / before any assistant message** — zero usage legitimately; `durationMs` = small wall value; `llmMs ≥ 0`; telemetry doc skipped (`hadUsage` false); logs carry the flags with honest zeros.
- **Multiple assistant messages / subagents** — per-message `BetaUsage` is per-API-call; summing across messages (subagent messages included) matches the cumulative semantics of the SDK's own result usage. Divergence risk between "sum of completed calls" and what the SDK would have reported is confined to aborted turns (success overwrites), is a lower bound (the in-flight call's usage is lost with the stream), and is segmented by `aborted:true`. Accepted residual (D8 spirit).
- **In-flight API call at abort** — its partial usage is unrecoverable (no completed assistant message); tokens recorded are a lower bound. Accepted.
- **`synthesizeAbortedResult`** (manager early-abort, no `runTurn` call) — all-zero shape flows through unchanged; excluded from telemetry by `hadUsage`; activity/dispatcher records carry `aborted:true` with zeros, which is the truth (no spend).
- **Crash path (`catch`)** — result-less throws now get wall `durationMs` + accumulated usage; the existing `resultText && costUsd > 0` crashed-after-response heuristic is *unchanged* (a crash after a successful result still has `sawResult` usage/cost intact; a crash before one still has costUsd 0, so the heuristic's behavior is identical — verified: accumulator never writes `costUsd`).
- **Success turn with clock-skew-negative llmMs** — previously silently dropped by `pushSample`; now clamped to 0 and sampled, matching Lane B's established success-path behavior. Effect on p95 is downward-only, rare, bounded. Accepted.
- **`error_during_execution` / `error_max_turns` results** — result message present ⇒ authoritative overwrite; behavior identical to today.
- **Ephemeral cache TTL breakdown** (`ephemeral5mTokens`/`ephemeral1hTokens`) — not accumulated mid-turn (per-message `cache_creation` summing adds surface for near-zero value); stays `undefined` on result-less turns, which every consumer already tolerates. Accepted residual.

## Tests

Harness: `agent-runner.test.ts`'s existing `mockQueryOverride` seam (KPR-306) feeds synthetic SDK message sequences; `agent-manager.test.ts` for the observability gate; `dispatcher.test.ts:843` block already drives the "Work item dispatched" log; `provider-circuit-breaker.test.ts` for the pins.

1. **Partial-usage snapshot**: sequence `init → assistant(usage A, tool_use) → assistant(usage B) → close (no result)`, runner aborted via deadline → RunResult has `inputTokens = A.in + B.in` (etc. for all four counters), `durationMs > 0`, `llmMs ≥ 0`, `costUsd = 0`, `aborted: true, timedOut: true`.
2. **Result-authoritative overwrite**: same sequence + a `result` message with distinct usage totals → RunResult carries the result-message values exactly (success path byte-identical).
3. **Abort before any assistant message** → all counters 0, `durationMs > 0`, `llmMs ≥ 0`.
4. **Clamp row**: result-less turn with recorded tool time → `llmMs === Math.max(0, durationMs - toolMs)`, never negative.
5. **Telemetry gate rows** (agent-manager): aborted + usage>0 + sessionId → `turnTelemetryStore.record` called with `aborted: true`; aborted + zero usage → not called; success → called without the `aborted` field (unchanged shape).
6. **Dispatcher log row**: aborted TurnResult → "Work item dispatched" fields include `aborted: true, timedOut: true` and non-negative llmMs.
7. **Activity row**: `activityLogger.record` receives `aborted`/`timedOut` pass-through.
8. **Breaker pins** (no code change): non-success outcomes never `pushSample` regardless of llmMs magnitude; success with negative llmMs never samples.
9. **Negative-verify** (per repo feedback canon): with edit 1(b)+(c) reverted (result-less path), test 1 must fail on pre-fix code — zeros and negative llmMs reappear. State the expected pre-fix observation in the test comment.

## Open assumptions

- ⚠ **Sum-of-assistant-message usage as the aborted-turn total** (subagent messages included) — decided here; divergence from hypothetical SDK totals confined to aborted turns and flagged. Non-blocking.
- ⚠ **`costUsd = 0` on result-less turns, no estimation** — decided here per hotfix scope + subscription-auth fleet; dashboards segment on `aborted` and use tokens. Non-blocking.
- ⚠ **Zero-usage aborted turns excluded from `agent_turn_telemetry`** (the `hadUsage` arm) — decided here (no spend ⇒ nothing to account; keeps `synthesizeAbortedResult` noise out). Non-blocking.
- ⚠ **Unconditional llmMs clamp (success turns included)** — decided here for Lane B parity; changes only skew-negative success samples (drop → 0-sample). Non-blocking.
- ⚠ **KPR-399 no-tokenData aborted persist left as-is** — its rationale is superseded but back-fill is a follow-up, not this hotfix (constraint 2). Non-blocking; note for the epic.
