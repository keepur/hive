# KPR-323 — Implementation Plan: Warm execution path for voice turns

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Ticket:** KPR-323 (W5.3), child of epic KPR-320 (W5 Voice v2). **Consumes:** KPR-322 bridge contract (thread keying `voice:<callId>`, full-transcript-every-turn, E2 abort-on-disconnect). **Feeds:** KPR-322 §15 P2 (its latency gate binds to this ticket's blessed baseline artifact), KPR-325 (pilot rides the warm path).
**Spec:** [`kpr-323-spec.md`](./kpr-323-spec.md) (clean through 2 Frontier review rounds; §n refs below are spec sections; C1–C6 are the spec §10 engine-change inventory; W0/W1/W2/W-leak are the spec §7 empiricism gates). The spec is binding — this plan renders it, it does not redesign it.
**Plan type:** CODE plan (engine diff, all behind `voice.warmPath.enabled`) + read-only baseline tooling (C6) + D3-gated empirical tasks (W0–W-leak — designed, NOT run).
**Anchors:** every code anchor below verified 2026-07-14 against lane worktree `/Users/mokie/github/lane-kpr-323` @ `aedef74` (epic branch kpr-320; code content = base main @ W6 — only docs commits differ from `d074d5c`). W3 (epic kpr-309) is matured but NOT merged and reshapes the same spawn seam; Task 0 re-confirms before any delivery work. KPR-322's engine tasks (T1–T3) land first on the epic branch; Task 6 (C3) layers inside 322's `abortThread` with zero 322-artifact delta.
**Status:** DRAFT — dispatcher runs the plan-review loop; not self-approved.

**Goal:** Remove the per-turn cold-spawn tax from voice turns via a per-call warm session lease behind `AgentManager.spawnTurn`, and deliver the blessed read-only first-audio baseline (`firstTokenMs` p50/p95 from production "Voice turn complete" logs) that every W5 latency gate compares against.

**Architecture:** Turn 1 of a call opens a long-lived streaming-input `query()` (one SDK session per call) under a real spawn ticket that holds the per-thread lock and one budget slot for the call's duration; turns 2..N push into the live session and demux on per-exchange `result` messages, skipping CLI boot, session reload, and MCP re-handshake. Everything hides behind `spawnTurn`, so the voice adapter, `dispatcher.routeVoiceTurn`, the outer full-transcript retry, the 322 bridge seam, and all error rows are unchanged. Cold path is always the fallback: session ids persist to Mongo per turn and any warm-session death degrades to today's behavior.

**Tech stack:** TypeScript strict / Node 22; `@anthropic-ai/claude-agent-sdk` streaming-input `query()` surface (`prompt: AsyncIterable<SDKUserMessage>`, `Query.interrupt()`, `Query.close()`); vitest (fake timers + scripted fake Query); MongoDB telemetry; `npx tsx` script for the baseline harvest.

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `src/agents/warm-voice-session.test.ts` (new — `AsyncPushQueue`, lease lifecycle, demux, watchdog, interrupt, close contract), `src/config.test.ts` (C4 resolver), `src/cli/doctor.test.ts` + `src/cli/doctor-checks.test.ts` (C5 row/render), `scripts/voice-latency-baseline.test.ts` (new — C6 pure functions), `src/agents/spawn-coordinator-heartbeat.test.ts` (C5 field passthrough), `src/agents/agent-runner.test.ts` (C1 timing fields + Task 3 envelope extraction regression).
  - Reason: the lease's throw-safety/idempotence contract (spec §4.2) and turn demux are the ticket's correctness core and are fully testable with a scripted fake `Query`; the baseline artifact math (nearest-rank percentiles, bucket split, exclusions) is the number every W5 gate binds to.
  - Minimum assertions (warm-voice-session module — all of these, exactly):
    1. **Demux:** two sequential `runTurn` calls against a fake Query that answers each pushed message with `deltas + result` → each turn returns its own text, in push order; zero cross-turn bleed.
    2. **Serialization gate:** a second `runTurn` issued while the first is in flight does not push until the first's `result` arrived (internal one-turn-at-a-time gate).
    3. **No-generator-close:** consuming a turn never calls the fake Query's `return()`; the session survives N turns (manual `next()` loop — a `for await` + `break` would close the generator; test pins this).
    4. **Idle timeout:** fake timers; 120s with no turn → `close("idle-timeout")` fires once, `onClosed` invoked once with the turn count; a throwing `onClosed` is swallowed (no uncaughtException).
    5. **Lifetime cap:** close fires at 2h even with turns still arriving.
    6. **close() contract:** idempotent (second call no-op); never throws even when `query.close()` and `input.end()` both throw; safe from four contexts (timer, abort, failure path, shutdown) — parameterized.
    7. **Watchdog:** a turn exceeding `timeoutMs` → `interrupt()` called, turn returns `timedOut: true, aborted: true`; a subsequent `runTurn` still works (session survives).
    8. **Barge-in:** `requestInterrupt` during an in-flight turn → turn returns `aborted: true` with the already-streamed text; next turn proceeds in-session.
    9. **Interrupt escalation:** fake `interrupt()` rejection → lease closes (`interrupt-failed:*` reason), no unhandled rejection (process-level listener assertion).
    10. **Stream death:** fake Query output ends (`done: true`) mid-turn → turn returns an error result (never hangs).
    11. **Queue contract:** `push()` after `end()` is a silent no-op; iterator `return()` ends the queue.
  - Minimum assertions (C4 config): `resolveVoiceWarmPathConfig` — literal `true` → enabled; `"true"`/`1`/absent/garbage/array → disabled.
  - Minimum assertions (C6 baseline script): nearest-rank percentile correctness on known vectors (incl. n=1, n=2, exact-boundary ranks); line parser accepts only `msg === "Voice turn complete"` + `component === "voice-adapter"` + matching agent + `mode === "streaming"`, tolerates non-JSON lines; window filtering; missing-`firstTokenMs` lines excluded from BOTH buckets and counted in `excludedMissingFirstToken`; resumed/nonResumed split on `sdkSessionResumeAttempted`; artifact matches the spec §3.3 schema exactly (`kind`, `version: 1`, empty `blessing`); shortfall recorded in `notes` when minimums (50/20) unmet; output contains no callIds, no text fields.
  - Minimum assertions (C1 runner): fake query emitting `init → delta → result` → `RunResult.bootToInitMs` and `initToFirstTokenMs` are non-negative numbers; a no-init no-delta run leaves both undefined.

- Integration: **required**
  - Scope: `src/agents/agent-manager.test.ts` — real `AgentManager` + the file's mocked `AgentRunner` extended with `openVoiceStreamingSession` returning a scripted fake streaming Query (echo pump over the lease's input iterable). This is where lock/budget/ticket/reflection invariants are proved against the real coordinator. **Additive cases only — zero edits to existing cases, zero edits to 322's committed E2 cases.**
  - Reason: the lease is a first-class citizen of `withSpawnTicket` machinery (spec §4.3 "preserved, not carved out") — only the real coordinator can prove lock-held-for-call-duration, budget accounting, stop semantics, and the abortThread dispatch.
  - Harness: **existing** (`agent-manager.test.ts` — real manager, `mockRunnerSend`/`mockRunnerAbort`, `makeWorkItem`/`makeRunResult`/`makeSmsCtx` helpers, hoisted config mock). Extension required: `makeVoiceCtx` helper, `mockRunnerOpenStream` on the AgentRunner mock, fake-Query factory, `voice: { warmPath: { enabled: false } }` added to the config mock (flipped per-describe).
  - Minimum assertions (all of these, exactly):
    1. **Flag off (regression):** voice ctx with `warmPath.enabled: false` → cold path exactly (runner `send` called, `openVoiceStreamingSession` never called, no lease in snapshot) — byte-identical today-path.
    2. **Lease open:** flag on, voice ctx, no lease → `openVoiceStreamingSession` called once with `sessionId` === the ctx's `sessionId` EXACTLY as passed (asserted for both `undefined` and a set id — the §4.2 resume-source rule); snapshot shows `activeSpawns: 1` and the thread key held AFTER turn 1's promise resolves (ticket outlives the turn).
    3. **Warm turn N:** second `spawnTurn` on the same thread → no new ticket (still `activeSpawns: 1`), runner constructed once, `send` never called, result text is turn 2's own reply, `warmPath: true` + `warmTurnSeq: 2` on the `TurnResult`.
    4. **Per-turn session persistence:** `sessionStore.set` called once per warm turn with that turn's `result.session_id` (rotation-safe cold fallback, spec §5 session-store row).
    5. **Reflection guard:** a `kind: "reflection"` ctx with `channel: "voice"` never opens or reuses a lease (cold path).
    6. **Provider guard:** agent with `model: "openai/gpt-5.4-mini"` → cold path.
    7. **Budget saturation at open:** agent at budget → `spawnTurn` rejects with the existing `"Spawn budget exceeded for ..."` message; no lease registered; no unhandled rejection.
    8. **Stopped agent at open:** `AgentStoppedError` propagates; no lease registered.
    9. **stopAgent mid-call:** ticket walk → lease closed → lock + budget released (snapshot returns to 0) → in-flight turn returns aborted/errored (stop means stop).
    10. **abortThread warm dispatch:** lease present → returns `true`, `interrupt()` dispatched on the live Query, lease still open, next turn runs warm; lease absent → 322 ticket-walk behavior (322's own committed cases prove it — untouched).
    11. **abortThread interrupt-rejection escalation:** rejected `interrupt()` → lease closes; no unhandled rejection.
    12. **Turn-level failure closes lease first:** fake Query emits an error-subtype result → `TurnResult.errors` non-empty AND the lease is already closed when `spawnTurn` resolves; the NEXT voice turn (retry-shaped: `sessionId: undefined`, full-transcript text) opens a FRESH lease with `resume: undefined` — never the escaped session.
    13. **Circuit-open on a warm turn:** breaker open → `ProviderCircuitOpenError` thrown, nothing pushed to the input queue, lease still open; after breaker close, next turn works warm (spec §6 precedence rule).
    14. **Timed-out turn keeps lease open:** `timedOut: true` + empty errors → lease open (spec §6 timeout clause).
    15. **Release-time reflection credit:** after idle-timeout close of a 3-turn call (fake timers), exactly one reflection is scheduled and `pendingReflectionTurns` was credited with 3 (observable: with `reflectionMinTurns: 3`, the reflection fires after ONE call, not after three calls).
    16. **No per-turn reflection on warm turns:** no reflection timer is scheduled between warm turns.
    17. **Snapshot/observability:** `warmVoiceSessions: 1` in `getSnapshot()` while open, `0` after close; heartbeat doc carries the field.
    18. **Zero-turn lease reclaim:** lease opened, no further turns, turn 1 completed → idle timer releases; budget freed.

- E2E: **not-required** (in CI) / **required as gated empiricism** (W0/W1/W2/W-leak — designed, NOT run; each run requires a recorded per-run operator go per D3)
  - Scope: production-log harvest (W0), live cold-turn decomposition (W1), warm A/B + SDK behavior verification on the live Vapi path (W2), leak/reclaim drills (W-leak).
  - Reason: the SDK streaming-input behaviors the design leans on (per-pushed-message `result`, interrupt-then-continue, idle-session interrupt) are runtime properties of the live CLI + a real call loop — not provable in CI; and the program ruling forbids unapproved runs.
  - Harness: setup-required at delivery (Tasks 10–13 ARE the protocol; `voice-pilot` test agent from 322 Task 14 prep, never production defs).
  - Minimum assertions: the spec §7 pass/decision rules verbatim (W0 sample minimums + blessing; W1 falsification rule; W2 thresholds + zero cross-turn bleed + fallback-drill recovery within one turn; W-leak 150s reclaim + no orphan processes).

### Critical Flows

- Cold voice turn with `warmPath.enabled: false` — byte-identical to today (the branch is never taken).
- Warm call lifecycle: open (ticket + streaming session) → N demuxed turns with per-turn session-id persistence → idle release (lock/budget freed, one credited reflection).
- Barge-in under lease: `abortThread` → in-session `interrupt()` → next turn warm and immediate; 322's cold-path E2 behavior untouched.
- Warm death → cold fallback: turn failure closes the lease → adapter outer retry lands cold with full transcript → next turns re-open a fresh lease.
- Baseline harvest: production logs → aggregate-only artifact → operator blessing → immutable; 322 P2 reads `metrics.resumed.firstTokenMs.p50`.

### Regression Surface

- `AgentManager` spawn coordinator: lock/budget/ticket cleanup (`withSpawnTicket`), `stopAgent`/`stopAll`/`restartAgent`/`sweep`, reflection scheduling, snapshot — the entire existing `agent-manager.test.ts` suite must stay green untouched.
- KPR-322 E2: `abortThread` cold ticket-walk semantics + the adapter close-listener wiring + 322's committed integration tests — all green with **zero edits** (C3's dispatch is inside the method).
- Voice adapter: `voice-adapter.test.ts` + `voice-adapter.integration.test.ts` — C1 adds log fields only; every existing case green untouched. Vapi coexistence rows (circuit-open spoken notice, auth-503, budget-503, outer retry) unchanged.
- `AgentRunner.send()` behavior across ALL channels after the Task 3 envelope extraction — `agent-runner.test.ts` + full agents suite green; `hive doctor` existing sections; `spawn_coordinator_stats` heartbeat consumers tolerate the additive field.
- Engine bundle gates: `npm run bundle` + `npm run check:bundle` (warm-voice-session bundles into the engine; the baseline script does NOT enter the bundle).

### Commands

- Unit + Integration (targeted): `npx vitest run src/agents src/channels/voice src/config.test.ts src/cli/doctor.test.ts src/cli/doctor-checks.test.ts scripts/voice-latency-baseline.test.ts`
- Full quality gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Bundle gates: `npm run check:bundle`
- E2E: gated-empiricism-only — protocols in Tasks 10–13; **never run without the recorded operator go**.

### Harness Requirements

- Existing vitest harness; no new services for CI groups. Fake streaming Query = a plain object with `next()`/`interrupt()`/`close()` driven by an `AsyncPushQueue<SDKMessage>` (helper in each test file — no SDK import needed beyond types). `vi.useFakeTimers()` for idle/lifetime/watchdog cases; every fake-timer test must also advance the debounced reflection timer explicitly.
- Gated empiricism harness: dodi instance with live Vapi traffic (W0/W1); `voice-pilot` test agent + 322 §14.2 10-turn script (W2/W-leak); `voice.warmPath.enabled: true` in the instance hive.yaml + engine restart for warm-on windows (flag is instance-global — see Task 12 GO block).

### Non-Required Rationale

- E2E (CI): live-call SDK runtime behaviors and production-log reads cannot exist in CI, and D3 forbids unapproved runs. All other groups required.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Flag-off equivalence rule:** every task that touches `spawnTurn`/`agent-runner`/`voice-adapter` re-runs the pre-existing suites with the flag defaulted off before its commit — the cold path must be provably untouched at every step, not just at the end.
- **W2 demux/interrupt failures are material** (spec §7): a live demux or interrupt-then-continue failure demotes this ticket to the spec lane — it is not an implement-around.

---

## 0. How to run this plan

- **Program mode:** maturity-first (MODE=waterfall). This plan is written now, executed only after (a) the operator re-opens W5 delivery, (b) **W3 (epic kpr-309) has merged** and Task 0 has re-confirmed the spec §9 surfaces, and (c) **KPR-322's engine tasks (its T1–T3) have merged into the epic branch** — Task 6 here layers inside 322's `abortThread` and cannot exist before it. Task 0 is a hard gate: no other task starts before it passes or its demote-to-spec branch is taken.
- **D3 rule:** Tasks 10–13 (W0/W1/W2/W-leak) each begin with an operator-go block. Executing any of them without a recorded "go" (date + words, in Linear KPR-323 comments at execution time) is a scope breach. Approvals are per-gate — never generalized. **W0 is read-only but still gated** (it reads production logs — spec §3.4 step 1).
- **Rollback lever:** `voice.warmPath.enabled` defaults `false` on merge. Every engine commit in this plan must leave the flag-off path byte-identical to pre-323 behavior.
- **Secrets:** nothing in this ticket touches Keychain/Honeypot; no credential may enter logs, artifacts, or transcripts. The baseline artifact and all new log fields are durations/counters/booleans only — no message content, no phone numbers, no callId in the artifact.
- **Conventions:** `createLogger` for logging; strict TS, no `any` without justification; tests beside source (`src/**/*.test.ts`, plus the `scripts/*.test.ts` precedent); subprocesses via argv arrays only (`execFileSync(bin, [args])`); commit per task; `npm run check` before any PR.
- Tick each `- [ ]` as executed.

---

## 1. Execution order

```
Task 0 (anchor re-confirm gate — HARD; requires W3 merged + 322 T1–T3 merged)
   ├─ engine track: T1(C4 config) ── T2(C1 decomposition) ── T3(runner envelope + open) ── T4(C2 lease module)
   │                ── T5(C2 manager integration) ── T6(C3 abortThread dispatch) ── T7(C5 observability)
   └─ tooling:      T8(C6 baseline script)        (independent of T1–T7)
T9 (CI close-out: full gates)
gated:   T10[GO](W0 baseline harvest + bless — needs only T8; unblocks 322 P2)
         T11[GO](W1 decomposition — needs T2 deployed; FALSIFICATION GATE)
         T12[GO](W2 warm A/B + SDK behavior verify — needs T1–T7 deployed)
         T13[GO](W-leak soak/reclaim — needs T12 setup)
T14 (close-out)
```

| Task | What | Depends on | Parallel with |
|---|---|---|---|
| 0 | Anchor re-confirm gate | W5 re-open + W3 merged + 322 T1–T3 merged | — (blocks all) |
| 1 | C4 `voice.warmPath.enabled` config | 0 | 2, 8 |
| 2 | C1 cold-turn decomposition fields | 0 | 1, 8 |
| 3 | Runner: envelope extraction + `openVoiceStreamingSession` | 0 (2 recommended first — shared send() edits) | 8 |
| 4 | C2 `warm-voice-session.ts` module | 3 (types only) | 8 |
| 5 | C2 manager integration (gate/open/turn/release/reflection) | 1, 3, 4 | 8 |
| 6 | C3 `abortThread` warm dispatch | 5 + external: 322 T3 merged | 7, 8 |
| 7 | C5 snapshot + heartbeat + doctor | 5 | 6, 8 |
| 8 | C6 `scripts/voice-latency-baseline.ts` | 0 only | 1–7 |
| 9 | CI close-out (check + bundle gates) | 1–8 | — |
| 10 | **W0** baseline harvest + blessing [GO] | 8 (script) — no engine deps | may run before 9 completes |
| 11 | **W1** decomposition + falsification rule [GO] | 2 deployed on dodi | — |
| 12 | **W2** warm A/B + behavior verify [GO] | 1–7 deployed + 11 (threshold re-derivation) + 10 (baseline) | — |
| 13 | **W-leak** soak/reclaim [GO] | 12 setup (flag on, test agent) | — |
| 14 | Close-out | all | — |

**File map (created/modified):**

| File | Change | Task |
|---|---|---|
| `src/config.ts` | C4: `voice.warmPath` key + pure resolver | 1 |
| `src/config.test.ts` | resolver cases | 1 |
| `src/agents/agent-runner.ts` | C1 timing fields (T2); envelope extraction + `openVoiceStreamingSession` (T3) | 2, 3 |
| `src/agents/agent-runner.test.ts` | C1 field assertions; extraction regression | 2, 3 |
| `src/agents/agent-manager.ts` | C1 stage timings on `TurnResult` (T2); C2 lease registry/gate/open/turn (T5); C3 dispatch (T6); C5 snapshot (T7); reflection turns-credit (T5) | 2, 5, 6, 7 |
| `src/agents/warm-voice-session.ts` | **new** — C2 lease + input queue | 4 |
| `src/agents/warm-voice-session.test.ts` | **new** — lease unit suite | 4 |
| `src/agents/agent-manager.test.ts` | additive warm-lease describe blocks ONLY | 5, 6, 7 |
| `src/channels/voice/voice-adapter.ts` | C1: `promptBuildMs`/`sessionLookupMs` stamps + log fields (log line only — no behavior) | 2 |
| `src/channels/voice/voice-adapter.test.ts` | log-field assertions (additive) | 2 |
| `src/agents/spawn-coordinator-heartbeat.test.ts` | C5 field passthrough assertion | 7 |
| `src/cli/doctor-checks.ts` + `src/cli/doctor.ts` (+ tests) | C5 row + render | 7 |
| `scripts/voice-latency-baseline.ts` | **new** — C6 harvester | 8 |
| `scripts/voice-latency-baseline.test.ts` | **new** — C6 pure-function suite | 8 |
| `docs/epics/kpr-320/baselines/voice-baseline-<date>.json` | **new at W0** — blessed artifact | 10 |

No new processes, no new HTTP surfaces, no schema changes, no new secrets (spec §10).

---

## 2. Tasks

### Task 0 — Anchor re-confirmation gate (mandatory; demote-to-spec escape hatch)

**Files:** none modified. Output: a pass/fail table in the implement-lane notes.

Rule: for each anchor, re-locate it at delivery HEAD (grep by symbol, not line). **Cosmetic drift** (line shifts, renames with same semantics) → update the plan's refs inline and proceed. **Material drift** (signature/semantics/keying/error-shape changes) → STOP, demote the ticket to the spec lane; do not adapt on the fly.

- [ ] **W3 surface 1 — `spawnTurn` / `withSpawnTicket` internals** (today `agent-manager.ts:563-655` / `:673-771`): the plan adds a branch at the top of `spawnTurn` (after the registry check, before `withSpawnTicket`) and a lease that occupies a ticket via a lambda resolving at release. Confirm: HOF signature `withSpawnTicket<T>(ctx, fn: (ticket) => Promise<T>)`; `SpawnTicket` shape (`agentId`/`threadKey`/`workItem`/`attachAbort`/`abort`, `:223-229`); three stop-checkpoints; budget accounting inside the critical section; breaker-acquire placement as the lambda's first act (`:577-581`); saturation recording + `"Spawn budget exceeded for ..."` throw (`:693-700`). **Material if:** the HOF, ticket shape, or breaker placement was reshaped by W3 (KPR-338 alone rewrites ~160 lines of this file).
- [ ] **W3 surface 2 — `TurnContext` / session keying / resume semantics**: `TurnContext` fields incl. `systemPromptOverride` + `kind` (`agent-manager.ts:71-92`); Mongo `sessions` `_id "{agentId}:{threadId}"` + 7-day TTL (`session-store.ts:6-40`); `finalizeSpawnResult`'s rotation-persist gate `if (result.sessionId && !result.aborted)` (`:1218-1232`); KPR-313's session-identity guards may alter keying or rotation handling the lease's per-turn persistence rides on. **Material if** resume semantics or thread keying changed.
- [ ] **W3 surface 3 — adapter error taxonomy**: `"Spawn budget exceeded"` string-match (`voice-adapter.ts:375`), `isAuthError` (`:24-29`), `instanceof ProviderCircuitOpenError` (`:324`), outer-retry condition (`:337`). If W3 landed typed errors, re-bind the lease-open saturation row and the §6 precedence-rule tests to the typed forms (cosmetic if 1:1; material otherwise).
- [ ] **W3 surface 4 — `AgentRunner.send` / abort surfaces + factoring pin**: `send()` signature (`agent-runner.ts:1525`), in-process MCP wiring block (`:1537-1706`), `systemPromptOverride` consumption (`:1714`), options literal (`:1790-1834`), message loop anchors (init `:1885-1888`, text_delta `:1912-1917`, result `:1956-1999`), `abort()` (`:2090-2097`), `activeQuery` (`:301`). Task 3's `buildQueryEnvelope` boundaries are pinned against THESE lines — re-derive the exact cut points at delivery HEAD before cutting. **Material if** prompt assembly moved out of `send()` or a provider-adapter layer now owns `query()` construction.
- [ ] **SDK pin (the load-bearing one)** — record the exact installed `@anthropic-ai/claude-agent-sdk` version (package.json pins `^0.2.63`; the main checkout resolved `0.2.104` at plan time, where all five claims below verify against `sdk.d.ts`). Verify against the installed typings at delivery:
  1. `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` (`sdk.d.ts` — the union is the streaming-input mode).
  2. `Query.interrupt(): Promise<void>` with the interface comment stating control requests are "only supported when streaming input/output is used" — positive evidence for §4.4: a cold string-prompt turn has no interrupt surface, so `abortThread`'s no-lease fall-through to spawn-abort is the only option there.
  3. `Query.close(): void` ("forcefully ends the query ... cleaning up ... the CLI subprocess").
  4. `SDKUserMessage` shape: `{ type: "user", message: MessageParam, parent_tool_use_id: string | null, ... }` (all other fields optional).
  5. `Query.streamInput(stream)` exists (not used by this design — the input iterable is passed as `prompt` — but its presence pins the streaming-input mode's stability; `SDKSession` remains `@alpha`, not designed on).
  Also pin at Task 0 (typings-level; W2 verifies live): per-exchange `result` emission in streaming-input mode (⚠ registry #1 — typings show `SDKResultMessage` in the `SDKMessage` union with per-result `session_id`/`usage`; the per-exchange cadence itself is a runtime property), and the scope of `maxTurns`/`maxBudgetUsd` under streaming input (⚠ #5 — if cumulative across the session, decide and record: warm envelope omits `maxTurns` or scales it; a one-line change in `buildQueryEnvelope`'s warm branch).
  **Extension-point disappearance = material → demote.**
- [ ] **322 E2 landing shape** — read the MERGED `abortThread` body + the adapter close-listener wiring + the mock surfaces (`abortThread: vi.fn()` and the `("test-agent", "voice:call-e2")` assertion) as actually landed. Task 6 inserts the warm dispatch as the method's FIRST act — confirm the merged body still matches 322 plan Task 3 Step 1's ticket-walk shape before inserting. **Material if** the method was renamed/resignatured.
- [ ] **Reflection method shape**: `scheduleReflectionIfEligible` increments by exactly 1 (`agent-manager.ts:891` — `(prior ?? 0) + 1`) and `runReflectionTurn`'s quiescence check reads `processing` (`:944-947`). Task 5's `turns` parameter extension is pinned against this exact shape.
- [ ] **Observability surfaces**: `getSnapshot()` (`:815-851`), `CoordinatorSnapshotPerAgent` (`:239-258`), heartbeat spread-write (`spawn-coordinator-heartbeat.ts:46-67`), doctor reader/renderer (`doctor-checks.ts:311-377`, `doctor.ts:124-148`), `config.voice` block shape post-322-T1 (`config.ts:408-417` pre-322).
- [ ] **Adapter C1 anchors**: `buildVoiceSystemPrompt` call (`voice-adapter.ts:243-246`), `sessionStore.get` (`:249`), "Voice turn complete" log (`:423-432`), zero-chunk close (`:397-409`).
- [ ] Re-confirm **no KPR-208 artifacts** (`git log --all --grep=KPR-208` → empty) and no W3 warm-path rails on the merged kpr-309 content (spec §9.7).
- [ ] Record the full table (anchor → found-at → cosmetic/material/UNCHANGED) in lane notes. Any material row → demote-to-spec, stop.

### Task 1 — C4: `voice.warmPath.enabled` config key

**Files:**
- Modify: `src/config.ts` (voice block — post-322-T1 it also carries `bridgeToken`/`bindHost`/`livekit`; C4 adds one key beside them)
- Test: `src/config.test.ts` (add cases)

- [ ] **Step 1:** Add the pure resolver above the `config` export (mirrors 322's `resolveVoiceLivekitConfig` pattern):

```typescript
/**
 * KPR-323 C4: resolve the optional hive.yaml `voice.warmPath` section.
 * Liberal-loader style (KPR-225 F3): literal `true` only; absent/garbage →
 * disabled. `false` = the warm branch is never taken — byte-identical
 * today-path (the rollback lever, spec §4.7). Idle timeout (120s) and
 * lifetime cap (2h) are named constants in warm-voice-session.ts —
 * deliberately NOT config. Exported pure for unit tests.
 */
export interface VoiceWarmPathConfig {
  enabled: boolean;
}

export function resolveVoiceWarmPathConfig(raw: unknown): VoiceWarmPathConfig {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return { enabled: src.enabled === true };
}
```

- [ ] **Step 2:** Add one line inside the `voice` block (`config.ts:408-417` pre-322; place after `port`, beside 322's additions if already landed):

```typescript
    // KPR-323 C4: per-call warm session lease master switch. Default false
    // on merge; flipped per-instance after W2 passes.
    warmPath: resolveVoiceWarmPathConfig((hive.voice as Record<string, unknown> | undefined)?.warmPath),
```

- [ ] **Step 3:** Tests in `src/config.test.ts`:

```typescript
import { resolveVoiceWarmPathConfig } from "./config.js";

describe("resolveVoiceWarmPathConfig (KPR-323 C4)", () => {
  it("defaults to disabled on absent/garbage input", () => {
    for (const input of [undefined, null, 42, "x", [], { enabled: "true" }, { enabled: 1 }]) {
      expect(resolveVoiceWarmPathConfig(input).enabled).toBe(false);
    }
  });
  it("enables on literal true only", () => {
    expect(resolveVoiceWarmPathConfig({ enabled: true }).enabled).toBe(true);
  });
  it("ignores unknown keys", () => {
    expect(resolveVoiceWarmPathConfig({ enabled: true, idleMs: 5 }).enabled).toBe(true);
  });
});
```

- [ ] **Step 4:** Verify — `npx vitest run src/config.test.ts` green; `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run typecheck` green.
- [ ] **Step 5:** Commit — `git add src/config.ts src/config.test.ts && git commit -m "feat(kpr-323): C4 voice.warmPath.enabled config key (default off)"`

### Task 2 — C1: cold-turn stage decomposition on "Voice turn complete" (log-only, always-on)

Spec §2: six additive numeric fields — `promptBuildMs`, `sessionLookupMs` (adapter-side; **nonzero on warm turns by design** — they quantify the T0→T1 cost that persists), `lockWaitMs`, `spawnPrepMs` (coordinator-side), `bootToInitMs`, `initToFirstTokenMs` (runner-side). No config lever — a handful of subtractions on an existing line. W1's falsification rule reads these fields.

**Files:**
- Modify: `src/agents/agent-runner.ts` (RunResult + send() stamps)
- Modify: `src/agents/agent-manager.ts` (TurnResult.stageTimings + spawnTurn stamps + runOneSpawnAttempt onDispatch hook)
- Modify: `src/channels/voice/voice-adapter.ts` (two stamps + log fields)
- Test: `src/agents/agent-runner.test.ts`, `src/agents/agent-manager.test.ts`, `src/channels/voice/voice-adapter.test.ts` (all additive)

- [ ] **Step 1:** `agent-runner.ts` — extend `RunResult` (`:120-142`), after `timedOut`:

```typescript
  /** KPR-323 C1: query()-call → system/init (CLI boot + session load + MCP handshake). Voice decomposition; log-only. */
  bootToInitMs?: number;
  /** KPR-323 C1: system/init → first streamed text_delta (≈ model TTFT). On warm turns (KPR-323 C2): push → first delta. */
  initToFirstTokenMs?: number;
```

- [ ] **Step 2:** `agent-runner.ts` `send()` — immediately before `const q = query({` (`:1790`):

```typescript
    // KPR-323 C1: cold-turn stage anchors (spec §2 T3→T5, T5→T6). Log-only.
    const queryStartedAt = Date.now();
    let initAt: number | undefined;
    let bootToInitMs: number | undefined;
    let initToFirstTokenMs: number | undefined;
```

In the message loop, extend the init branch (`:1885-1888`):

```typescript
        if (msg.type === "system" && msg.subtype === "init") {
          resultSessionId = msg.session_id;
          initAt = Date.now();
          bootToInitMs = initAt - queryStartedAt; // KPR-323 C1
          log.debug("Session initialized", { sessionId: resultSessionId });
        }
```

and the text_delta branch (`:1912-1918`):

```typescript
        if (msg.type === "stream_event" && onStream) {
          const event = (msg as any).event;
          if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
            if (initToFirstTokenMs === undefined) {
              initToFirstTokenMs = Date.now() - (initAt ?? queryStartedAt); // KPR-323 C1
            }
            onStream(event.delta.text);
            streamed = true;
          }
        }
```

Add `bootToInitMs, initToFirstTokenMs,` to the returned object (`:2072-2081`).

- [ ] **Step 3:** `agent-manager.ts` — extend `TurnResult` (`:104-134`), after `aborted`:

```typescript
  /**
   * KPR-323 C1: cold-turn stage decomposition, populated only for
   * ctx.channel === "voice" (always-on, log-only — the adapter merges these
   * into the "Voice turn complete" line). Durations in ms.
   */
  stageTimings?: {
    lockWaitMs: number;
    spawnPrepMs: number;
    bootToInitMs?: number;
    initToFirstTokenMs?: number;
  };
  /** KPR-323 C2: true when the turn ran on a warm voice lease. */
  warmPath?: boolean;
  /** KPR-323 C2: 1-based turn sequence within the warm lease. */
  warmTurnSeq?: number;
```

- [ ] **Step 4:** `agent-manager.ts` `spawnTurn` (`:563`) — stamp `enteredAt` before the HOF, `lambdaStartedAt` + `dispatchAt` inside:

```typescript
  async spawnTurn(ctx: TurnContext, onStream?: SpawnTurnStreamCallback): Promise<TurnResult> {
    this.ensureState(ctx.agentId);

    if (!this.registry.get(ctx.agentId)) {
      throw new Error(`Unknown agent: ${ctx.agentId}`);
    }

    const enteredAt = Date.now(); // KPR-323 C1: T1 anchor (admission start)

    return this.withSpawnTicket(ctx, async (ticket) => {
      const lambdaStartedAt = Date.now(); // KPR-323 C1: T2 anchor (lock+budget held)
```

then thread the dispatch stamp through the existing attempt calls (both the happy path and the auth-rebuild retry at `:623-635` — the `??` keeps the FIRST dispatch stamp, so a retried turn's `spawnPrepMs` spans to the first dispatch, matching §3.1's retry-inflated-latency honesty):

```typescript
      let dispatchAt: number | undefined; // KPR-323 C1: T3 anchor (adapter.runTurn)
      const markDispatch = () => {
        dispatchAt = dispatchAt ?? Date.now();
      };
      let finalResult: RunResult;
      try {
        finalResult = await this.runOneSpawnAttempt(effectiveCtx, shaping, ticket, onStream, markDispatch);
        if (finalResult.error && isAuthRebuildResumeError(finalResult.error) && effectiveCtx.sessionId) {
          log.warn("spawnTurn auth-rebuild-resume — retrying without resume", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            reason: finalResult.error,
          });
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: undefined },
            shaping,
            ticket,
            onStream,
            markDispatch,
          );
        }
      } catch (err) {
```

and after `const turnResult = this.finalizeSpawnResult(effectiveCtx, finalResult);` (`:645`):

```typescript
      // KPR-323 C1: voice-only stage decomposition for the adapter's log line.
      if (effectiveCtx.channel === "voice") {
        turnResult.stageTimings = {
          lockWaitMs: lambdaStartedAt - enteredAt,
          spawnPrepMs: (dispatchAt ?? lambdaStartedAt) - lambdaStartedAt,
          bootToInitMs: finalResult.bootToInitMs,
          initToFirstTokenMs: finalResult.initToFirstTokenMs,
        };
      }
```

- [ ] **Step 5:** `runOneSpawnAttempt` (`:1027`) — additive trailing parameter, invoked immediately before the adapter dispatch:

```typescript
  private async runOneSpawnAttempt(
    ctx: TurnContext,
    shaping: { ... unchanged ... },
    ticket: SpawnTicket,
    onStream?: SpawnTurnStreamCallback,
    onDispatch?: () => void, // KPR-323 C1: T3 anchor callback
  ): Promise<RunResult> {
    ...
    onDispatch?.(); // KPR-323 C1 — immediately before adapter.runTurn
    const result = await adapter.runTurn({ ... unchanged ... });
```

- [ ] **Step 6:** `voice-adapter.ts` — stamp the two pre-spawn reads (`:243-249`):

```typescript
    const promptBuildStartedAt = Date.now(); // KPR-323 C1: T0→T1
    const systemPrompt = await buildVoiceSystemPrompt(agentConfig, this.memoryManager, {
      goal: callMeta?.goal,
      context: callMeta?.context,
    });
    const promptBuildMs = Date.now() - promptBuildStartedAt;

    const sessionStore = agentManager.getSessionStore();
    const sessionLookupStartedAt = Date.now(); // KPR-323 C1: T0→T1
    const storedSessionId = await sessionStore.get(agentId, threadId);
    const sessionLookupMs = Date.now() - sessionLookupStartedAt;
```

and extend the "Voice turn complete" log (`:423-432`) — full replacement of the call:

```typescript
    log.info("Voice turn complete", {
      callId,
      agentId,
      firstTokenMs,
      totalMs: Date.now() - startedAt,
      mode: isStreaming ? "streaming" : "non-streaming",
      sdkSessionResumeAttempted: !!effectiveResume,
      sdkSessionResumed: !!effectiveResume && outcome.ok && !outerRetryFired,
      routedVia: "agentManager",
      // KPR-323 C1: stage decomposition (adapter-side stamps + coordinator/
      // runner stamps carried on TurnResult). Log-only; all durations —
      // no content, no numbers-of-humans (repo redaction posture).
      promptBuildMs,
      sessionLookupMs,
      ...(result.stageTimings ?? {}),
      // KPR-323 C2: warm-lease markers (false/absent until Task 5 lands).
      warmPath: result.warmPath ?? false,
      ...(result.warmTurnSeq !== undefined ? { warmTurnSeq: result.warmTurnSeq } : {}),
    });
```

`firstTokenMs` semantics unchanged (request-arrival → first SSE byte) so warm/cold/baseline numbers stay directly comparable (spec §4.6).

- [ ] **Step 7:** Tests (additive):
  - `agent-manager.test.ts`: add `makeVoiceCtx` (mirrors `makeSmsCtx`: `channel: "voice"`, `threadId: "voice:call-1"`, workItem `text: "hello"`, `source: { kind: "voice", id: "call-1", label: "voice:call-1" }`, `systemPromptOverride: "voice prompt"`). Cases: voice ctx → `result.stageTimings` defined, `lockWaitMs >= 0`, `spawnPrepMs >= 0`; SMS ctx → `stageTimings` undefined.
  - `agent-runner.test.ts`: using the file's existing query-mock idiom, emit `system/init` then a `stream_event` text_delta then `result` → returned `RunResult.bootToInitMs` and `initToFirstTokenMs` are numbers ≥ 0; a run with neither → both undefined.
  - `voice-adapter.test.ts`: capture the mocked logger (extend the file's logger mock to spies via `vi.hoisted`, matching the `agent-manager.test.ts` idiom, if it does not already expose them) and assert the "Voice turn complete" entry carries numeric `promptBuildMs`/`sessionLookupMs` and `warmPath: false`. All pre-existing cases untouched and green.
- [ ] **Step 8:** Verify — `npx vitest run src/agents src/channels/voice` green; typecheck green.
- [ ] **Step 9:** Commit — `git commit -m "feat(kpr-323): C1 cold-turn stage decomposition on Voice turn complete (log-only)"`

### Task 3 — Runner: `buildQueryEnvelope` extraction + `openVoiceStreamingSession`

Spec §9.4: the lease needs a session-opening sibling to `send()` reusing the same server-config/hooks/options assembly. This task is a **mechanical extraction** — behavior of `send()` must be provably unchanged (full agents suite green, flag-off equivalence rule).

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Test: `src/agents/agent-runner.test.ts` (existing suite is the regression harness; one additive case)

- [ ] **Step 1:** Extend the SDK type import (`agent-runner.ts:1`) with `type SDKUserMessage`:

```typescript
import { query, type Query, type SDKMessage, type SDKResultMessage, type SDKUserMessage, type McpServerConfig, ... } from "@anthropic-ai/claude-agent-sdk";
```

- [ ] **Step 2:** Extract `send()`'s pre-query assembly into a private method. **Cut boundaries (re-pin at Task 0):** everything from `const allServerConfigs = this.buildAllServerConfigs(context);` (`:1537`) through the end of the `options` literal (`:1833`) moves verbatim into the new method, with exactly four parameter substitutions — `onStream`→`params.streaming`, `sessionId`→`params.sessionId`, `systemPromptOverride`→`params.systemPromptOverride`, `context`/`modelOverride`/`resourceLimits`→`params.*` — and the options literal assigned to a local instead of inlined into `query()`:

```typescript
  /**
   * KPR-323: shared `query()` options assembly for the per-turn send() path
   * and the warm voice streaming session (openVoiceStreamingSession).
   * Mechanical extraction of send()'s pre-query body — server configs,
   * in-process MCP wiring, system prompt, archetype/cwd/toolSearch/env,
   * options literal. Identical behavior for send() callers; `streaming`
   * replaces the `!!onStream` test for includePartialMessages.
   */
  private async buildQueryEnvelope(params: {
    sessionId?: string;
    context?: WorkItemContext;
    modelOverride?: string;
    resourceLimits?: ResourceLimits;
    systemPromptOverride?: string;
    streaming: boolean;
  }): Promise<SdkQueryOptions> {
    const effectiveModel = params.modelOverride ?? this.agentConfig.model;
    // ... [moved body: agent-runner.ts:1537-1788 verbatim, with the four
    //      substitutions above; no logic edits] ...
    const options: SdkQueryOptions = {
      model: effectiveModel,
      systemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: params.resourceLimits?.maxTurns ?? this.agentConfig.maxTurns,
      maxBudgetUsd: params.resourceLimits?.budgetUsd ?? this.agentConfig.budgetUsd,
      cwd: effectiveCwd,
      settingSources: archetypeExtra.settingSources ?? [],
      includePartialMessages: params.streaming,
      ...(params.sessionId ? { resume: params.sessionId } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      ...(Object.keys(serverSubAgents).length > 0 ? { agents: serverSubAgents } : {}),
      ...(sdkPlugins.length > 0 ? { plugins: sdkPlugins } : {}),
      hooks: this.buildHooks(params.context),
      ...(this.agentConfig.betas?.length ? { betas: this.agentConfig.betas as any } : {}),
      env: { /* moved verbatim, incl. ENABLE_TOOL_SEARCH pin */ },
      extraArgs: { "strict-mcp-config": null },
    };
    return options;
  }
```

`send()` then opens with (the "Sending prompt to agent" log stays in `send()`; the C1 `queryStartedAt` stamp from Task 2 stays adjacent to `query()`):

```typescript
    const options = await this.buildQueryEnvelope({
      sessionId,
      context,
      modelOverride,
      resourceLimits,
      systemPromptOverride,
      streaming: !!onStream,
    });
    const queryStartedAt = Date.now(); // KPR-323 C1 (Task 2)
    // ... C1 locals ...
    const q = query({ prompt, options });
```

- [ ] **Step 3:** Add the streaming-session opener below `send()`:

```typescript
  /**
   * KPR-323 C2: open a long-lived streaming-input query for a warm voice
   * call session (spec §4.2). Reuses the exact options assembly as send()
   * via buildQueryEnvelope — same MCP wiring, hooks, cwd, env — with
   * includePartialMessages always true (voice streams) and `resume` = the
   * sessionId the adapter resolved for turn 1, EXACTLY as passed (spec §4.2
   * resume-source rule: never re-read the session store here — after a
   * warm-turn failure the adapter's outer retry lands cold with
   * sessionId undefined + full transcript; a store re-read would resume the
   * very session the retry just escaped and double-inject the transcript).
   *
   * WorkItemContext is call-stable on voice (channelId = callId, threadId
   * fixed), so constructor-time context capture — the KPR-122 pattern — is
   * correct for the whole call; the per-turn contextRef update degenerates
   * to a no-op.
   *
   * Returns the raw Query. The caller (WarmVoiceSession) owns the input
   * queue, per-turn output consumption, watchdog, interrupt, and close.
   * This method does NOT consume the output stream and does NOT arm the
   * per-turn deadline (the lease's watchdog owns turn deadlines).
   */
  async openVoiceStreamingSession(params: {
    input: AsyncIterable<SDKUserMessage>;
    sessionId: string | undefined;
    context: WorkItemContext;
    systemPromptOverride: string;
  }): Promise<Query> {
    log.info("Opening warm voice streaming session", {
      agent: this.agentConfig.id,
      resumeSession: params.sessionId ?? "new",
    });
    const options = await this.buildQueryEnvelope({
      sessionId: params.sessionId,
      context: params.context,
      systemPromptOverride: params.systemPromptOverride,
      streaming: true,
    });
    const q = query({ prompt: params.input, options });
    // Belt-and-braces: runner.abort() (and wasAborted) keep working for a
    // lease-held runner; the lease's close() calls Query.close() directly.
    this.activeQuery = q;
    return q;
  }
```

- [ ] **Step 4:** Additive test in `agent-runner.test.ts`: with the file's query mock capturing its arguments, `openVoiceStreamingSession({ input: (async function* () {})(), sessionId: "s-1", context: fakeCtx, systemPromptOverride: "vp" })` → the mock received a non-string `prompt` (the iterable), `options.resume === "s-1"`, `options.includePartialMessages === true`, `options.systemPrompt === "vp"`; with `sessionId: undefined` → no `resume` key.
- [ ] **Step 5:** Verify — `npx vitest run src/agents` green (the FULL existing runner + manager suites are the extraction's regression proof); `npx vitest run src/channels` green; typecheck green.
- [ ] **Step 6:** Commit — `git commit -m "refactor(kpr-323): extract buildQueryEnvelope; add openVoiceStreamingSession (streaming-input sibling of send)"`

### Task 4 — C2: `src/agents/warm-voice-session.ts` (the lease module)

The ticket's core. One class per active call: owns the input queue, per-turn output demux, watchdog, idle/lifetime timers, and the no-throw/idempotent `close()` contract (spec §4.2 throw-safety block). The module holds NO coordinator state — the manager (Task 5) owns the registry, the ticket, the breaker, and finalize/observability.

**Files:**
- Create: `src/agents/warm-voice-session.ts`
- Create: `src/agents/warm-voice-session.test.ts`

- [ ] **Step 1:** Create `src/agents/warm-voice-session.ts` (complete file):

```typescript
import type { Query, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunResult, StreamCallback } from "./agent-runner.js";
// Type-only import — erased at compile time, so no runtime cycle with
// agent-manager.ts (which imports this module at runtime).
import type { TurnContext, TurnResult } from "./agent-manager.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("warm-voice-session");

/**
 * KPR-323 §4.2/§4.7: release constants. Deliberately NOT config — the
 * enabled flag is the rollback lever; these are pilot-tunable by code
 * change only (spec §11 ⚠). Lifetime cap aligns with the voice adapter's
 * CallSession TTL (voice-adapter.ts:38).
 */
export const WARM_IDLE_TIMEOUT_MS = 120_000;
export const WARM_LIFETIME_CAP_MS = 2 * 60 * 60 * 1000;

/**
 * Push-based AsyncIterable used as the streaming-input `prompt` of the
 * lease's query(). push() enqueues (or hands directly to a waiting
 * consumer); end() terminates iteration. After end(), push() is a silent
 * no-op — close() may race a late turn, and the turn-level failure path
 * owns the fallout (spec §6). Exported for tests.
 */
export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export interface WarmTurnRequest {
  /** Turn text — the adapter-shaped prompt (prepareSpawn's voice carve-out is a passthrough). */
  text: string;
  onStream?: StreamCallback;
  /** Per-turn watchdog, mapping the cold path's deadline (agent timeoutMs, default 300s). */
  timeoutMs: number;
}

export interface WarmVoiceSessionDeps {
  agentId: string;
  threadKey: string;
  /**
   * Invoked exactly once, from close(). The manager wires: registry delete
   * (identity-checked), coordinator-lambda release (frees lock + budget +
   * ticket), and release-time reflection credit (spec §4.5). close() guards
   * the call — a throwing onClosed is logged and swallowed.
   */
  onClosed: (info: { reason: string; turns: number }) => void;
}

/**
 * KPR-323 C2: per-call warm session lease (spec §4.2). One instance per
 * active voice call; bound to one long-lived streaming-input Query.
 *
 * Throw-safety contract (spec §4.2, load-bearing):
 *  - Timer callbacks are try/catch-wrapped — they run on bare setTimeout,
 *    where a synchronous throw is an uncaughtException (the engine
 *    registers only an unhandledRejection handler, index.ts:878).
 *  - close() is no-throw and idempotent. It is invoked from at least four
 *    contexts: the timers; ticket.abort() via stopAgent's ticket walk —
 *    which has NO per-ticket try/catch (agent-manager.ts:1318-1323), so a
 *    throwing close() would skip the agent's remaining tickets; the
 *    turn-failure path; and engine shutdown.
 *  - interrupt()'s Promise is always given a .catch (requestInterrupt).
 */
export class WarmVoiceSession {
  readonly openedAt = Date.now();
  /** §4.5: final turn's ctx/result, set by the manager per turn for release-time reflection credit. */
  lastTurn: { ctx: TurnContext; result: TurnResult } | null = null;

  private query: Query | null = null;
  private readonly input = new AsyncPushQueue<SDKUserMessage>();
  private closed = false;
  private closeReason: string | null = null;
  private turnCount = 0;
  private turnInFlight = false;
  private interruptRequested = false;
  // Internal one-turn-at-a-time gate (spec §4.2 demux invariant).
  private turnChain: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private lifetimeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: WarmVoiceSessionDeps) {}

  get inputQueue(): AsyncPushQueue<SDKUserMessage> {
    return this.input;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get turns(): number {
    return this.turnCount;
  }

  get hasTurnInFlight(): boolean {
    return this.turnInFlight;
  }

  /** Bind the opened SDK query; arm lifetime + idle timers. */
  start(query: Query): void {
    this.query = query;
    this.lifetimeTimer = setTimeout(() => {
      // Bare-timer throw-safety (spec §4.2).
      try {
        log.info("Warm voice lease lifetime cap reached — releasing", this.logCtx());
        this.close("lifetime-cap");
      } catch (err) {
        log.error("lifetime-cap close threw — swallowed", { ...this.logCtx(), error: String(err) });
      }
    }, WARM_LIFETIME_CAP_MS);
    this.lifetimeTimer.unref?.();
    this.armIdleTimer();
  }

  /**
   * Run one turn: push the utterance, consume the shared output stream
   * until THIS turn's `result` message, relay text deltas. Serialized by
   * turnChain — external callers are already one-turn-at-a-time (the
   * worker/Vapi POST serially per call), the gate makes interleaving
   * structurally impossible.
   */
  async runTurn(req: WarmTurnRequest): Promise<RunResult> {
    if (this.closed || !this.query) {
      throw new Error(`Warm voice lease closed (${this.closeReason ?? "unknown"})`);
    }
    const run = this.turnChain.then(() => this.consumeOneTurn(req));
    // Keep the chain alive across a failed turn; the failure itself
    // propagates to THIS caller via `run`.
    this.turnChain = run.catch(() => {});
    return run;
  }

  /**
   * §4.4 barge-in / watchdog entry: interrupt the in-flight generation,
   * keep the session open. Fire-and-forget with .catch escalation — a
   * failed interrupt means the session may be wedged; closing it converts
   * the situation into the standard cold-fallback path (§6).
   * Idle-lease edge (no generation in flight): interrupt-on-idle is
   * SDK-unspecified — if it rejects, the same escalation applies (safe but
   * avoidable; W2 in-run behavior check, spec §4.4/§7).
   */
  requestInterrupt(reason: string): void {
    if (this.closed || !this.query) return;
    this.interruptRequested = true;
    this.query.interrupt().catch((err) => {
      log.warn("Warm voice interrupt failed — closing lease (cold fallback)", {
        ...this.logCtx(),
        reason,
        error: String(err),
      });
      try {
        this.close(`interrupt-failed:${reason}`);
      } catch {
        // close() never throws; belt-and-braces.
      }
    });
  }

  /**
   * Release the lease. NO-THROW + IDEMPOTENT (spec §4.2 contract) — every
   * internal step individually guarded; a second call is a no-op.
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    try {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
    } catch {
      // clearTimeout cannot throw; belt-and-braces.
    }
    try {
      this.input.end();
    } catch (err) {
      log.warn("input queue end threw during lease close", { ...this.logCtx(), error: String(err) });
    }
    try {
      this.query?.close();
    } catch (err) {
      log.warn("query close threw during lease close", { ...this.logCtx(), error: String(err) });
    }
    this.query = null;
    try {
      this.deps.onClosed({ reason, turns: this.turnCount });
    } catch (err) {
      log.error("warm lease onClosed callback threw — swallowed", { ...this.logCtx(), error: String(err) });
    }
    log.info("Warm voice lease closed", {
      ...this.logCtx(),
      reason,
      turns: this.turnCount,
      ageMs: Date.now() - this.openedAt,
    });
  }

  private logCtx(): Record<string, unknown> {
    return { agentId: this.deps.agentId, threadKey: this.deps.threadKey };
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      // Bare-timer throw-safety (spec §4.2).
      try {
        log.info("Warm voice lease idle timeout — releasing", this.logCtx());
        this.close("idle-timeout");
      } catch (err) {
        log.error("idle-timeout close threw — swallowed", { ...this.logCtx(), error: String(err) });
      }
    }, WARM_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * One turn's push + demux. Mirrors AgentRunner.send()'s message loop
   * per-turn: init (first turn only) captures session id; compact_boundary
   * counts; stream_event text_deltas relay; assistant blocks track text +
   * tool timings; `result` closes the turn (spec §4.2 turn-demux ⚠ —
   * per-pushed-message result emission is W2-verified; Task 0 pins the
   * typings).
   */
  private async consumeOneTurn(req: WarmTurnRequest): Promise<RunResult> {
    if (this.closed || !this.query) {
      throw new Error(`Warm voice lease closed (${this.closeReason ?? "unknown"})`);
    }
    const q = this.query;
    this.clearIdleTimer(); // no idle reclaim while a turn runs
    this.turnInFlight = true;
    this.interruptRequested = false;
    this.turnCount += 1;
    const pushedAt = Date.now();

    let text = "";
    let sessionId = "";
    let costUsd = 0;
    let durationMs = 0;
    let streamed = false;
    let error: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let ephemeral5mTokens: number | undefined;
    let ephemeral1hTokens: number | undefined;
    let contextWindow = 0;
    let compactions = 0;
    let preCompactTokens: number | undefined;
    let initToFirstTokenMs: number | undefined;
    let timedOut = false;
    const toolCalls: { tool: string; startMs: number; endMs?: number }[] = [];
    let activeToolName: string | null = null;

    // Per-turn watchdog (spec §4.2): maps the cold path's deadline to an
    // in-session interrupt. The session survives a timed-out turn.
    const watchdog = setTimeout(() => {
      try {
        if (this.turnInFlight && !this.closed) {
          timedOut = true;
          log.warn("Warm voice turn deadline fired — interrupting turn", {
            ...this.logCtx(),
            timeoutMs: req.timeoutMs,
            turnSeq: this.turnCount,
          });
          this.requestInterrupt("turn-timeout");
        }
      } catch (err) {
        log.error("turn watchdog threw — swallowed", { ...this.logCtx(), error: String(err) });
      }
    }, req.timeoutMs);
    watchdog.unref?.();

    try {
      this.input.push({
        type: "user",
        message: { role: "user", content: req.text },
        parent_tool_use_id: null,
      });

      // MANUAL next() loop — never `for await` here: `break` inside a
      // for-await invokes the generator's return(), which would close the
      // whole streaming session on the first turn boundary.
      turnLoop: while (true) {
        const { value, done } = await q.next();
        if (done) {
          error = error ?? `warm session output ended before turn result (${this.closeReason ?? "stream-ended"})`;
          break;
        }
        const msg = value as SDKMessage;
        switch (msg.type) {
          case "system": {
            const sub = (msg as { subtype?: string }).subtype;
            if (sub === "init") {
              sessionId = (msg as unknown as { session_id: string }).session_id;
            } else if (sub === "compact_boundary") {
              compactions++;
              preCompactTokens = (msg as any).compact_metadata?.pre_tokens;
              log.info("Context compacted mid-call", { ...this.logCtx(), preTokens: preCompactTokens });
            }
            break;
          }
          case "stream_event": {
            const event = (msg as any).event;
            if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
              if (initToFirstTokenMs === undefined) initToFirstTokenMs = Date.now() - pushedAt;
              streamed = true;
              try {
                req.onStream?.(event.delta.text);
              } catch (err) {
                log.warn("onStream callback threw during warm turn", { ...this.logCtx(), error: String(err) });
              }
            }
            break;
          }
          case "assistant": {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text") {
                  text = block.text;
                } else if (block.type === "tool_use") {
                  if (activeToolName && toolCalls.length > 0) {
                    toolCalls[toolCalls.length - 1]!.endMs = Date.now();
                  }
                  activeToolName = block.name;
                  toolCalls.push({ tool: block.name, startMs: Date.now() });
                }
              }
            }
            if ((msg as any).session_id) sessionId = (msg as any).session_id;
            break;
          }
          case "result": {
            const result = msg as SDKResultMessage;
            costUsd = result.total_cost_usd;
            durationMs = result.duration_ms;
            sessionId = result.session_id;
            const usage = (result as any).usage;
            if (usage) {
              inputTokens = usage.input_tokens ?? 0;
              outputTokens = usage.output_tokens ?? 0;
              cacheReadTokens = usage.cache_read_input_tokens ?? 0;
              cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
              const cc = (usage as any).cache_creation;
              if (cc && typeof cc === "object") {
                ephemeral5mTokens =
                  typeof cc.ephemeral_5m_input_tokens === "number" ? cc.ephemeral_5m_input_tokens : undefined;
                ephemeral1hTokens =
                  typeof cc.ephemeral_1h_input_tokens === "number" ? cc.ephemeral_1h_input_tokens : undefined;
              }
            }
            const modelUsage = (result as any).modelUsage as Record<string, { contextWindow?: number }> | undefined;
            if (modelUsage) {
              for (const mu of Object.values(modelUsage)) {
                if (mu.contextWindow && mu.contextWindow > contextWindow) contextWindow = mu.contextWindow;
              }
            }
            if (result.subtype === "success") {
              text = (result as { result?: string }).result || text;
            } else {
              error =
                "errors" in result && Array.isArray((result as any).errors)
                  ? (result as any).errors.join("; ")
                  : result.subtype;
            }
            break turnLoop;
          }
          default:
            break;
        }
      }
    } catch (err) {
      error = error ?? String(err);
    } finally {
      clearTimeout(watchdog);
      this.turnInFlight = false;
      if (!this.closed) this.armIdleTimer();
    }

    if (activeToolName && toolCalls.length > 0) {
      toolCalls[toolCalls.length - 1]!.endMs = Date.now();
    }
    const toolStats: Record<string, { count: number; totalMs: number }> = {};
    for (const tc of toolCalls) {
      const dur = (tc.endMs ?? Date.now()) - tc.startMs;
      const serverName = tc.tool.includes("__") ? tc.tool.split("__")[1]! : tc.tool;
      if (!toolStats[serverName]) toolStats[serverName] = { count: 0, totalMs: 0 };
      toolStats[serverName]!.count++;
      toolStats[serverName]!.totalMs += dur;
    }
    const toolSummary = Object.entries(toolStats)
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .map(([name, s]) => `${name}:${s.count}x/${(s.totalMs / 1000).toFixed(1)}s`)
      .join(", ");
    const totalToolMs = toolCalls.reduce((sum, tc) => sum + ((tc.endMs ?? Date.now()) - tc.startMs), 0);

    return {
      text,
      sessionId,
      costUsd,
      durationMs,
      llmMs: durationMs - totalToolMs,
      toolMs: totalToolMs,
      toolCalls: toolCalls.length,
      toolSummary: toolSummary || "none",
      streamed,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      ephemeral5mTokens,
      ephemeral1hTokens,
      contextWindow,
      compactions,
      preCompactTokens,
      error,
      // Interrupted (barge-in) and timed-out turns are aborted-but-spoken:
      // KPR-307 semantics — no error string, so no outcome-failure fires and
      // the lease stays open (spec §6 precedence rule, timeout clause).
      aborted: this.interruptRequested || timedOut ? true : undefined,
      ...(timedOut ? { timedOut: true } : {}),
      initToFirstTokenMs, // KPR-323 C1 field reuse: warm turns measure push → first delta
    };
  }
}
```

- [ ] **Step 2:** Create `src/agents/warm-voice-session.test.ts` implementing Testing-Contract warm-voice-session assertions 1–11 exactly. Harness core (no SDK runtime import — types only):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AsyncPushQueue,
  WarmVoiceSession,
  WARM_IDLE_TIMEOUT_MS,
  WARM_LIFETIME_CAP_MS,
} from "./warm-voice-session.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Scripted fake streaming Query: next() served from a push queue; return() must never be needed. */
function makeFakeQuery() {
  const out = new AsyncPushQueue<SDKMessage>();
  const it = out[Symbol.asyncIterator]();
  const returnSpy = vi.fn();
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn(() => out.end());
  const q = {
    next: () => it.next(),
    return: (...args: unknown[]) => {
      returnSpy(...args);
      return it.return!();
    },
    interrupt,
    close,
    [Symbol.asyncIterator]() {
      return this;
    },
  } as any;
  return { q, emit: (m: Partial<SDKMessage>) => out.push(m as SDKMessage), endOutput: () => out.end(), interrupt, close, returnSpy };
}

const initMsg = (sid: string) => ({ type: "system", subtype: "init", session_id: sid });
const delta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const resultMsg = (o: { result: string; session_id: string; subtype?: string; errors?: string[] }) => ({
  type: "result",
  subtype: o.subtype ?? "success",
  result: o.result,
  session_id: o.session_id,
  total_cost_usd: 0.01,
  duration_ms: 100,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...(o.errors ? { errors: o.errors } : {}),
});

function makeLease(overrides: { onClosed?: (i: { reason: string; turns: number }) => void } = {}) {
  const onClosed = overrides.onClosed ?? vi.fn();
  const lease = new WarmVoiceSession({ agentId: "agent-a", threadKey: "agent-a:voice:call-1", onClosed });
  return { lease, onClosed };
}
```

Representative cases (write all 11 from the contract; demux + no-generator-close shown):

```typescript
  it("demuxes sequential turns on per-pushed-message result boundaries with zero bleed", async () => {
    const { q, emit, returnSpy } = makeFakeQuery();
    const { lease } = makeLease();
    lease.start(q);

    emit(initMsg("sess-1"));
    emit(delta("one "));
    emit(resultMsg({ result: "one", session_id: "sess-1" }));
    const chunks1: string[] = [];
    const r1 = await lease.runTurn({ text: "utterance 1", onStream: (c) => chunks1.push(c), timeoutMs: 5000 });
    expect(r1.text).toBe("one");
    expect(r1.sessionId).toBe("sess-1");
    expect(chunks1).toEqual(["one "]);

    emit(delta("two "));
    emit(resultMsg({ result: "two", session_id: "sess-2" }));
    const r2 = await lease.runTurn({ text: "utterance 2", timeoutMs: 5000 });
    expect(r2.text).toBe("two");
    expect(r2.sessionId).toBe("sess-2"); // per-turn rotation capture (⚠ KPR-211-streaming)
    expect(lease.turns).toBe(2);
    expect(returnSpy).not.toHaveBeenCalled(); // manual next() loop never closes the generator
  });
```

Timer cases use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(WARM_IDLE_TIMEOUT_MS)`; the interrupt-escalation case asserts via a scoped `process.on("unhandledRejection")` listener that no rejection floats.

- [ ] **Step 3:** Verify — `npx vitest run src/agents/warm-voice-session.test.ts` green (all 11 contract assertions present and passing); typecheck green.
- [ ] **Step 4:** Commit — `git commit -m "feat(kpr-323): C2 warm voice session lease module (input queue, demux, watchdog, no-throw close)"`

### Task 5 — C2: manager integration (registry, gate, open, warm turn, release-time reflection)

**Files:**
- Modify: `src/agents/agent-manager.ts`
- Test: `src/agents/agent-manager.test.ts` (ADDITIVE describe blocks only)

- [ ] **Step 1:** Imports + registry field:

```typescript
import { WarmVoiceSession } from "./warm-voice-session.js";
```

```typescript
  // KPR-323 C2: per-call warm voice leases, keyed by threadKey
  // (`agentId:threadId`, threadId = voice:<callId>). Registered only after
  // ticket acquisition; removed by lease.close() via onClosed (identity-
  // checked). The lease's ticket lives in activeTickets like any spawn, so
  // stopAgent/stopAll/sweep and the snapshot see it without special-casing.
  private warmLeases = new Map<string, WarmVoiceSession>();
```

- [ ] **Step 2:** Extract runner construction (used by both `createProviderAdapter` and the lease — spec §4.2 "same constructor args"):

```typescript
  private createRunner(agentId: string): AgentRunner {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
    return new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher, this.teamRoster, this.db, this.prefixCache, this.memoryLifecycle);
  }

  private createProviderAdapter(agentId: string): AgentProviderAdapter {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const runner = this.createRunner(agentId);
    const route = resolveProviderModel(config.model);
    if (route.provider === "claude") {
      return new ClaudeAgentAdapter(runner);
    }
    // ... remainder of the method unchanged (pilot adapters) ...
```

- [ ] **Step 3:** Scope-guard gate (spec §4.7):

```typescript
  /**
   * KPR-323 §4.7 scope guards: voice channel, real turns only (a post-call
   * reflection turn on a voice thread carries channel "voice" via the
   * captured lastChannelKind and must NEVER open a lease — reflection always
   * runs cold), claude provider only (pilot adapters have no session/stream
   * machinery), config-gated (false = branch never taken).
   */
  private isWarmPathEligible(ctx: TurnContext): boolean {
    if (ctx.channel !== "voice" || ctx.kind === "reflection") return false;
    if (appConfig.voice?.warmPath?.enabled !== true) return false;
    const def = this.registry.get(ctx.agentId);
    if (!def) return false;
    return resolveProviderModel(def.model).provider === "claude";
  }
```

(Optional chaining keeps test config mocks without a `voice` key working — the gate simply stays cold.)

- [ ] **Step 4:** The branch in `spawnTurn`, inserted after the registry check + `enteredAt` stamp, BEFORE `withSpawnTicket`:

```typescript
    // KPR-323 C2: warm voice path. The branch lives HERE — behind
    // dispatcher.routeVoiceTurn and the adapter seam — so taskLedger/audit,
    // the outer retry, all error rows, and the 322 bridge contract are
    // untouched (spec §5). Flag off / non-eligible → the code below this
    // block is byte-identical to pre-323.
    if (this.isWarmPathEligible(ctx)) {
      const threadKey = `${ctx.agentId}:${ctx.threadId}`;
      const lease = this.warmLeases.get(threadKey);
      if (lease && !lease.isClosed) {
        return this.runWarmTurn(lease, ctx, onStream);
      }
      return this.openWarmLease(ctx, onStream);
    }
```

- [ ] **Step 5:** `openWarmLease` (place after `spawnTurn`; complete code — the promise-ownership block implements spec §4.2 verbatim):

```typescript
  /**
   * KPR-323 §4.2 lease open (turn 1 of a call). The lease is a REAL spawn
   * ticket: withSpawnTicket runs with a lambda that resolves only at lease
   * release, so the per-thread lock and one budget slot are held for the
   * call's duration — all three stop-checkpoints, saturation recording, and
   * the finally-cleanup fire exactly as for any spawn (§4.3: preserved, not
   * carved out).
   *
   * Promise ownership (§4.2): open AWAITS ticket acquisition (the "lease
   * ready" gate) so budget-exceeded / AgentStoppedError propagate
   * synchronously to turn 1's caller and the adapter's existing 503 rows.
   * Post-acquisition, the pending coordinator promise is owned by the
   * lease: a .catch() attached at creation (before any await can float it)
   * logs and force-removes the registry entry — post-acquisition rejection
   * is a should-never state (release resolves the lambda; close() never
   * rejects); the handler is belt-and-braces above the process-level
   * unhandledRejection logger.
   */
  private async openWarmLease(ctx: TurnContext, onStream?: SpawnTurnStreamCallback): Promise<TurnResult> {
    const threadKey = `${ctx.agentId}:${ctx.threadId}`;

    let releaseLease!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    let markAcquired!: () => void;
    let acquired = false;
    const ready = new Promise<void>((resolve) => {
      markAcquired = () => {
        acquired = true;
        resolve();
      };
    });

    const lease = new WarmVoiceSession({
      agentId: ctx.agentId,
      threadKey,
      onClosed: ({ reason, turns }) => {
        // Registry cleanup — identity-checked (a re-open may have replaced
        // the entry; mirrors the activeTickets identity-check rationale).
        if (this.warmLeases.get(threadKey) === lease) {
          this.warmLeases.delete(threadKey);
        }
        // Resolve the coordinator lambda → withSpawnTicket's finally frees
        // lock + budget + ticket set on the way out (no new cleanup path).
        releaseLease();
        // §4.5: one reflection per call, credited with the call's turn
        // count, scheduled at release with the final turn's ctx/result.
        // reflectionMinTurns <= 0 still disables (inside the method).
        try {
          if (lease.lastTurn && turns > 0) {
            this.scheduleReflectionIfEligible(lease.lastTurn.ctx, lease.lastTurn.result, turns);
          }
        } catch (err) {
          log.warn("Release-time reflection scheduling failed", {
            agentId: ctx.agentId,
            threadKey,
            reason,
            error: String(err),
          });
        }
      },
    });

    const coordinator = this.withSpawnTicket(ctx, async (ticket) => {
      // Abort keeps KILL semantics — stopAgent's ticket walk must actually
      // stop the call (§4.2); barge-in severing goes through abortThread's
      // warm dispatch (Task 6), never through ticket.abort().
      ticket.attachAbort(() => lease.close("ticket-abort"));
      markAcquired();
      await released;
    });
    // Declared owner of the detached promise — attached synchronously, so
    // it can never float. Pre-acquisition rejections (budget/stopped) are
    // surfaced to the caller by the ready-race below; this handler only
    // acts on the post-acquisition should-never case.
    coordinator.catch((err) => {
      if (acquired) {
        log.error("Warm lease coordinator promise rejected post-acquisition — force-releasing", {
          agentId: ctx.agentId,
          threadKey,
          error: String(err),
        });
        lease.close("coordinator-rejected");
      }
    });

    // "Lease ready" gate: acquisition errors propagate synchronously.
    await Promise.race([ready, coordinator]);

    this.warmLeases.set(threadKey, lease);

    try {
      if (!ctx.sessionId) this.recordSpawn(ctx.workItem.source.id);

      // Build the runner once; open the streaming session with resume =
      // ctx.sessionId EXACTLY as passed (§4.2 resume-source rule — the
      // adapter stays the single authority on resume-vs-full-prompt; the
      // retry-shaped ctx {sessionId: undefined, full transcript} therefore
      // opens a FRESH session and never resumes the one a retry escaped).
      const runner = this.createRunner(ctx.agentId);
      const q = await runner.openVoiceStreamingSession({
        input: lease.inputQueue,
        sessionId: ctx.sessionId,
        context: {
          adapterId: ctx.workItem.source.adapterId ?? ctx.workItem.source.kind,
          channelId: ctx.channelId,
          channelKind: ctx.workItem.source.kind,
          channelLabel: ctx.workItem.source.label,
          threadId: ctx.threadId,
          slackTs: "",
          slackThreadTs: "",
        },
        systemPromptOverride: ctx.systemPromptOverride ?? "",
      });
      lease.start(q);
    } catch (err) {
      // Session open failed — release lock/budget/registry before
      // propagating; the adapter's outer retry lands cold (§5).
      lease.close("open-failed");
      throw err;
    }

    // Turn 1 runs through the same per-turn path as turns 2..N. Turn 1's
    // text is the adapter's full-transcript or greet-branch render,
    // unchanged from conversation-prompt.ts (§4.2).
    return this.runWarmTurn(lease, ctx, onStream);
  }
```

- [ ] **Step 6:** `runWarmTurn` (complete code):

```typescript
  /**
   * KPR-323 §4.2 turn N: per-turn breaker acquire → push + demux via the
   * lease → per-turn finalize/observability reused VERBATIM (this is what
   * keeps session-id rotation persisted to Mongo per turn and cold fallback
   * lossless). Never re-enters withSpawnTicket — the lease's ticket already
   * covers the thread; re-entering would deadlock on the held lock.
   *
   * Failure-close precedence (spec §6 — the one place it is stated; do not
   * generalize): a circuit-open fast-fail does NOT close the lease (the
   * message is never pushed; the session is healthy; half-open probes are
   * real turns and recovery is seamless mid-call). EVERY OTHER turn-level
   * failure closes the lease BEFORE the error propagates, so the adapter's
   * outer full-transcript retry always lands cold. Timed-out turns return
   * ok under KPR-307 semantics (empty errors) — not a turn-level failure —
   * so the lease stays open.
   *
   * No per-turn reflection scheduling here (§4.5): a timer firing mid-call
   * would hit the quiescence check, skip without rescheduling, and lose the
   * reflection. One reflection per call is credited at release.
   */
  private async runWarmTurn(
    lease: WarmVoiceSession,
    ctx: TurnContext,
    onStream?: SpawnTurnStreamCallback,
  ): Promise<TurnResult> {
    const route = resolveProviderModel(this.registry.get(ctx.agentId)?.model ?? "");
    const permit = this.circuitBreakers.acquire(route.provider, {
      agentId: ctx.agentId,
      threadId: ctx.threadId,
    });

    const timeoutMs = this.registry.get(ctx.agentId)?.timeoutMs ?? 300_000;

    let runResult: RunResult;
    try {
      runResult = await lease.runTurn({ text: ctx.workItem.text, onStream, timeoutMs });
    } catch (err) {
      this.circuitBreakers.record(permit, classifyThrown(err), 0);
      lease.close("turn-failure");
      throw err;
    }
    this.circuitBreakers.record(permit, classifyTurnResult(runResult), runResult.llmMs);

    const turnResult = this.finalizeSpawnResult(ctx, runResult);
    turnResult.warmPath = true;
    turnResult.warmTurnSeq = lease.turns;
    this.recordSpawnObservability(ctx, ctx.workItem.text, undefined, runResult);
    lease.lastTurn = { ctx, result: turnResult };

    if (runResult.error) {
      // Turn-level failure: close BEFORE returning (spec §5 outer-retry
      // row). The adapter's retry ctx {sessionId: undefined, full
      // transcript} then opens a FRESH lease — cold-equivalent turn 1,
      // warm for subsequent turns (spec §6 crash row).
      lease.close("turn-failure");
    }

    return turnResult;
  }
```

- [ ] **Step 7:** Reflection turns-credit extension (spec §4.5 / §11 — additive; cold callers unchanged). Change the signature and one line:

```typescript
  private scheduleReflectionIfEligible(ctx: TurnContext, turnResult: TurnResult, turns: number = 1): void {
```

```typescript
      pendingReflectionTurns: (prior?.pendingReflectionTurns ?? 0) + turns,
```

- [ ] **Step 8:** Tests — new `describe("warm voice lease (KPR-323)")` blocks in `agent-manager.test.ts`, ADDITIVE only, implementing Testing-Contract integration assertions 1–9, 12–16, and 18 (10–11 land with Task 6; 17 with Task 7). Harness extensions (top of file, beside the existing mocks):

```typescript
// KPR-323: streaming-session mock on the AgentRunner mock object.
const mockRunnerOpenStream = vi.fn();
// (add `openVoiceStreamingSession: mockRunnerOpenStream` to the existing
//  vi.mock("./agent-runner.js") implementation object)
```

Config mock: add `voice: { warmPath: { enabled: false } }` to the hoisted config object; the warm describe flips it in `beforeEach` and restores it in `afterEach`:

```typescript
import { config as appConfig } from "../config.js";
beforeEach(() => { (appConfig as any).voice = { warmPath: { enabled: true } }; });
afterEach(() => { (appConfig as any).voice = { warmPath: { enabled: false } }; });
```

Fake-Query echo pump (answers each pushed message; init emitted once):

```typescript
function installEchoStreamingRunner(opts: { failOnTurn?: number } = {}) {
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  const pushed: string[] = [];
  mockRunnerOpenStream.mockImplementation(async ({ input }: { input: AsyncIterable<any> }) => {
    const out = new AsyncPushQueue<any>();
    const it = out[Symbol.asyncIterator]();
    void (async () => {
      out.push({ type: "system", subtype: "init", session_id: "sess-warm-0" });
      let n = 0;
      for await (const m of input) {
        n++;
        pushed.push(String(m.message?.content ?? ""));
        if (opts.failOnTurn === n) {
          out.push({ type: "result", subtype: "error_during_execution", errors: ["boom"], session_id: `sess-warm-${n}`, total_cost_usd: 0, duration_ms: 1 });
          continue;
        }
        out.push({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `reply-${n} ` } } });
        out.push({ type: "result", subtype: "success", result: `reply-${n}`, session_id: `sess-warm-${n}`, total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      }
      out.end();
    })();
    return {
      next: () => it.next(),
      interrupt,
      close: close.mockImplementation(() => out.end()),
      [Symbol.asyncIterator]() { return this; },
    };
  });
  return { interrupt, close, pushed };
}
```

(`AsyncPushQueue` imported from `./warm-voice-session.js`.) Representative case — resume-source rule + held ticket (contract assertions 2–4):

```typescript
  it("opens a lease on turn 1, holds the ticket across turns, resumes exactly ctx.sessionId, persists per turn", async () => {
    mockConversationIndex.mockResolvedValue(undefined);
    const { pushed } = installEchoStreamingRunner();

    const r1 = await manager.spawnTurn(makeVoiceCtx({ sessionId: "stored-abc" }));
    expect(mockRunnerOpenStream).toHaveBeenCalledTimes(1);
    expect(mockRunnerOpenStream.mock.calls[0]![0].sessionId).toBe("stored-abc"); // §4.2: exactly as passed
    expect(r1.finalMessage).toBe("reply-1");
    expect(r1.warmPath).toBe(true);
    expect(r1.warmTurnSeq).toBe(1);
    // Ticket outlives the turn — the lease holds lock + one budget slot.
    expect(manager.getSnapshot().perAgent["agent-a"]!.activeSpawns).toBe(1);

    const r2 = await manager.spawnTurn(makeVoiceCtx({ sessionId: "sess-warm-1" }));
    expect(mockRunnerOpenStream).toHaveBeenCalledTimes(1); // no re-open
    expect(mockRunnerSend).not.toHaveBeenCalled(); // never the cold path
    expect(r2.finalMessage).toBe("reply-2");
    expect(r2.warmTurnSeq).toBe(2);
    expect(pushed).toEqual(["hello", "hello"]); // one push per turn, in order
    expect(mockSessionStoreSet).toHaveBeenCalledWith("agent-a", "voice:call-1", "sess-warm-1", expect.anything());
    expect(mockSessionStoreSet).toHaveBeenCalledWith("agent-a", "voice:call-1", "sess-warm-2", expect.anything());
  });
```

(Adapt `mockSessionStoreSet` to the file's existing SessionStore mock idiom; if the suite passes a real in-memory store stub, assert on it instead — cosmetic.) The remaining cases follow the contract list mechanically: budget saturation (fill the budget with hanging SMS spawns on OTHER threads, then expect the voice open to reject with `"Spawn budget exceeded"`); stop-mid-call (stopAgent → close spy called → snapshot 0); failure-closes-lease-first + fresh-lease-on-retry-ctx (`failOnTurn: 1`, then a second spawnTurn with `sessionId: undefined` → `mockRunnerOpenStream` called a second time with `sessionId: undefined`); circuit-open (force the breaker open via its test surface or a registry stub → nothing pushed, lease open); timeout-keeps-open; reflection credit (fake timers: 3 turns → idle-close → advance debounce → exactly one reflection spawn with `kind: "reflection"`, and with `reflectionMinTurns: 3` it fires after ONE 3-turn call); no per-turn reflection timers between warm turns.

- [ ] **Step 9:** Verify — `npx vitest run src/agents/agent-manager.test.ts` green INCLUDING every pre-existing case untouched; full `npx vitest run src/agents src/channels/voice` green; flag-off equivalence spot-check (assertion 1) present.
- [ ] **Step 10:** Commit — `git commit -m "feat(kpr-323): C2 warm lease coordinator integration (gate, open, warm turns, release-time reflection credit)"`

### Task 6 — C3: warm-lease dispatch inside `abortThread` (zero 322-artifact delta)

> **External precondition:** 322 Task 3 merged. Task 0 confirmed the landed method body. This task touches `agent-manager.ts` ONLY; the adapter, 322's close-listener wiring, its mock surfaces, and its committed tests are all untouched — C3 adds NEW warm-lease cases to `agent-manager.test.ts` only (spec §4.4 / C3).

**Files:**
- Modify: `src/agents/agent-manager.ts` (`abortThread`, as landed by 322)
- Test: `src/agents/agent-manager.test.ts` (additive cases)

- [ ] **Step 1:** Insert the dispatch as the method's first act (322's ticket-walk body stays verbatim below it):

```typescript
  abortThread(agentId: string, threadId: string): boolean {
    const threadKey = `${agentId}:${threadId}`;
    // KPR-323 C3 (spec §4.4): the method's contract is "sever the in-flight
    // turn for this thread". Under a warm lease the correct severing is a
    // turn-level interrupt — the caller is still on the line; killing the
    // session on every barge-in would end the call. Barge-in vs hang-up is
    // indistinguishable at the socket and interrupt-and-keep-warm is
    // correct for both: barge-in → next turn hits a hot session; hang-up →
    // idle timeout reclaims in ≤120s. No lease → 322's ticket-walk abort,
    // verbatim (a cold string-prompt query has no interrupt surface —
    // control requests exist only in streaming mode — so spawn-abort is the
    // only option there). ticket.abort() keeps KILL semantics for stopAgent.
    //
    // interrupt() returns a Promise; this method stays synchronous-boolean —
    // requestInterrupt dispatches fire-and-forget with a .catch that logs
    // and escalates to lease.close() (a failed interrupt means the session
    // may be wedged; closing converts to standard cold fallback, §6).
    // Idle-lease edge (disconnect during the adapter's pre-spawn awaits):
    // interrupt-on-idle is SDK-unspecified — W2 in-run check (§7).
    const lease = this.warmLeases.get(threadKey);
    if (lease && !lease.isClosed) {
      lease.requestInterrupt("abort-thread");
      log.info("Warm voice lease interrupted for thread", { agentId, threadId });
      return true;
    }
    // --- 322 Task 3 body from here, unchanged ---
    const tickets = this.activeTickets.get(agentId);
    ...
```

- [ ] **Step 2:** Additive tests (Testing-Contract integration assertions 10–11):

```typescript
describe("abortThread warm dispatch (KPR-323 C3)", () => {
  it("interrupts the in-flight generation and keeps the lease open (barge-in)", async () => {
    mockConversationIndex.mockResolvedValue(undefined);
    const { interrupt } = installEchoStreamingRunner();
    await manager.spawnTurn(makeVoiceCtx());
    expect(manager.abortThread("agent-a", "voice:call-1")).toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);
    // Session survives: the next turn runs warm on the same lease.
    const r = await manager.spawnTurn(makeVoiceCtx({ sessionId: "sess-warm-1" }));
    expect(r.warmPath).toBe(true);
    expect(mockRunnerOpenStream).toHaveBeenCalledTimes(1);
  });

  it("escalates a rejected interrupt to lease close (cold fallback), with no unhandled rejection", async () => {
    mockConversationIndex.mockResolvedValue(undefined);
    const { interrupt, close } = installEchoStreamingRunner();
    interrupt.mockRejectedValueOnce(new Error("wedged"));
    await manager.spawnTurn(makeVoiceCtx());
    const floated: unknown[] = [];
    const onRej = (r: unknown) => floated.push(r);
    process.on("unhandledRejection", onRej);
    try {
      expect(manager.abortThread("agent-a", "voice:call-1")).toBe(true);
      await vi.waitFor(() => expect(close).toHaveBeenCalled());
      expect(manager.getSnapshot().perAgent["agent-a"]!.activeSpawns).toBe(0); // lock+budget freed
    } finally {
      process.off("unhandledRejection", onRej);
    }
    expect(floated).toEqual([]);
  });

  it("falls through to the 322 ticket-walk when no lease exists (cold voice spawn)", async () => {
    // Flag OFF for this case — cold spawn holds the ticket.
    (appConfig as any).voice = { warmPath: { enabled: false } };
    // ... re-use 322's zombie-spawn pattern (mockRunnerSend hanging promise,
    // mockRunnerAbort releasing it) and assert abortThread → true + runner
    // abort called — proving the dispatch did not shadow the cold path.
  });
});
```

- [ ] **Step 3:** Verify — `npx vitest run src/agents/agent-manager.test.ts` green, and **explicitly confirm 322's E2 describe blocks pass with zero diff** (`git diff <322-merge-sha> -- src/agents/agent-manager.test.ts` shows only additions; `git diff <322-merge-sha> -- src/channels/voice/` shows only Task 2's C1 additions).
- [ ] **Step 4:** Commit — `git commit -m "feat(kpr-323): C3 abortThread warm-lease dispatch (turn interrupt under lease; 322 ticket-walk otherwise)"`

### Task 7 — C5: `warmVoiceSessions` on snapshot + heartbeat + doctor (informational)

**Files:**
- Modify: `src/agents/agent-manager.ts` (`CoordinatorSnapshotPerAgent` + `getSnapshot`)
- Modify: `src/cli/doctor-checks.ts` (`SpawnCoordinatorRow` + reader), `src/cli/doctor.ts` (render)
- Test: `src/agents/agent-manager.test.ts`, `src/agents/spawn-coordinator-heartbeat.test.ts`, `src/cli/doctor-checks.test.ts`, `src/cli/doctor.test.ts` (all additive)

- [ ] **Step 1:** `CoordinatorSnapshotPerAgent` (`agent-manager.ts:239-258`) — add after `stopped`:

```typescript
  /** KPR-323 C5: live warm voice leases for this agent (each holds one budget slot for its call's duration). */
  warmVoiceSessions: number;
```

`getSnapshot()` (`:828-848`) — compute beside `activeThreadKeys`:

```typescript
      let warmVoiceSessions = 0;
      for (const key of this.warmLeases.keys()) {
        if (key.startsWith(prefix)) warmVoiceSessions++;
      }
```

and add `warmVoiceSessions,` to the per-agent literal. The heartbeat (`spawn-coordinator-heartbeat.ts:50-56`) spreads `perAgent` into the telemetry doc — the field flows through with **zero heartbeat code change**.

- [ ] **Step 2:** Doctor reader (`doctor-checks.ts:311-377`): add `warmVoiceSessions: number;` to `SpawnCoordinatorRow`, `warmVoiceSessions?: number;` to the find projection type, and `warmVoiceSessions: d.warmVoiceSessions ?? 0,` to the mapper (defaults keep pre-323 heartbeat docs readable).
- [ ] **Step 3:** Doctor render (`doctor.ts:133-144`) — extend the per-agent row (informational; **never flips the exit code** — KPR-296 rule; the section already never contributes to `allPassed`):

```typescript
    emit(
      `  ${r.agentId}: active=${r.activeSpawns} warm-voice=${r.warmVoiceSessions} budget=${r.budget} (source=${r.budgetSource}) saturations=${r.saturationCount} (last ${lastSat})${flagStr} (heartbeat ${stale})`,
    );
```

- [ ] **Step 4:** Tests (additive): snapshot case (contract assertion 17) — lease open → `warmVoiceSessions: 1`, after close → `0`; agents with no leases → `0`. Heartbeat: extend the existing `writeOnce` case to assert the upserted doc `$set` carries `warmVoiceSessions`. Doctor: reader defaults missing field to 0; render line contains `warm-voice=1` for a row with one lease.
- [ ] **Step 5:** Verify — `npx vitest run src/agents src/cli/doctor.test.ts src/cli/doctor-checks.test.ts` green.
- [ ] **Step 6:** Commit — `git commit -m "feat(kpr-323): C5 warmVoiceSessions on snapshot/heartbeat/doctor (informational)"`

### Task 8 — C6: `scripts/voice-latency-baseline.ts` (read-only harvester + artifact emitter)

Spec §3 is canon for methodology; this script is its mechanical rendering (an operator could equally produce the artifact with grep+jq). It reads engine log files (JSON lines from `createLogger`), filters "Voice turn complete" rows, and emits the §3.3 aggregate-only artifact. **Read-only by construction: no engine import, no Mongo, no network, no message content — numeric fields only.** No dependency on Tasks 1–7 (it reads TODAY's log shape), so W0 can run ahead of engine delivery.

**Files:**
- Create: `scripts/voice-latency-baseline.ts`
- Create: `scripts/voice-latency-baseline.test.ts` (the `scripts/flatten-skills.test.ts` precedent)

- [ ] **Step 1:** Create the script (complete file):

```typescript
#!/usr/bin/env npx tsx
/**
 * KPR-323 C6 / spec §3: blessed read-only first-audio baseline harvester.
 *
 * Reads the instance's engine log files (JSON lines), filters successful
 * "Voice turn complete" rows for one agent within a ≤30-day window, splits
 * by sdkSessionResumeAttempted, and emits the aggregate-only artifact JSON
 * (spec §3.3). Zero behavior change to the engine; no traffic generated;
 * no message content or phone numbers read or written — only numeric
 * latency fields, counts, and ISO timestamps.
 *
 * D3: although read-only, a run against production logs requires a
 * recorded per-run operator go (spec §3.4 step 1).
 *
 * Usage:
 *   npx tsx scripts/voice-latency-baseline.ts \
 *     --log-dir ~/services/hive/<instance>/logs \
 *     --agent <agentId> \
 *     [--to <ISO8601>] [--days 30 | --from <ISO8601>] \
 *     [--git-sha <engine sha>] \
 *     --out docs/epics/kpr-320/baselines/voice-baseline-<YYYY-MM-DD>.json
 *
 * The artifact is emitted with `blessing` EMPTY; the operator reviews the
 * numbers + sample sizes, blesses in Linear (date + words), the blessing is
 * stamped, and the file is committed — immutable thereafter (spec §3.4).
 */
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";

export interface VoiceTurnSample {
  tsMs: number;
  firstTokenMs: number | undefined;
  totalMs: number;
  resumed: boolean;
}

/**
 * Parse one log line. Returns a sample for matching "Voice turn complete"
 * rows (streaming mode, given agent), null otherwise. Tolerates non-JSON
 * lines (multi-writer logs). Success-only by construction: the engine emits
 * this line only on successful turns (voice-adapter.ts:423-432).
 */
export function parseVoiceTurnLine(line: string, agentId: string): VoiceTurnSample | null {
  if (!line.includes("Voice turn complete")) return null; // cheap pre-filter
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.msg !== "Voice turn complete" || entry.component !== "voice-adapter") return null;
  if (entry.agentId !== agentId) return null;
  if (entry.mode !== "streaming") return null;
  const tsMs = Date.parse(String(entry.ts ?? ""));
  if (!Number.isFinite(tsMs)) return null;
  return {
    tsMs,
    firstTokenMs: typeof entry.firstTokenMs === "number" ? entry.firstTokenMs : undefined,
    totalMs: typeof entry.totalMs === "number" ? entry.totalMs : 0,
    resumed: entry.sdkSessionResumeAttempted === true,
  };
}

/** Nearest-rank percentile over an ascending-sorted array (spec §3.1). */
export function nearestRank(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAscending.length));
  return sortedAscending[rank - 1]!;
}

interface PercentilePair {
  p50: number;
  p95: number;
}

export interface BaselineArtifact {
  kind: "voice_latency_baseline";
  version: 1;
  capturedAt: string;
  engineVersion: string;
  gitSha: string;
  source: "vapi-production-logs";
  window: { from: string; to: string };
  agentId: string;
  mode: "streaming";
  samples: { resumed: number; nonResumed: number; excludedMissingFirstToken: number };
  metrics: {
    resumed: { firstTokenMs: PercentilePair; totalMs: PercentilePair };
    nonResumed: { firstTokenMs: PercentilePair; totalMs: PercentilePair };
  };
  blessing: { blessedBy: string; blessedAt: string; linearRef: string };
  notes: string;
}

export function buildArtifact(
  windowSamples: VoiceTurnSample[],
  opts: { capturedAt: string; engineVersion: string; gitSha: string; agentId: string; from: string; to: string },
): { artifact: BaselineArtifact; shortfall: string | null } {
  // Spec §3.2: rows without firstTokenMs (degenerate zero-chunk streaming
  // turns — the adapter emits headers + [DONE] only) are excluded from ALL
  // metrics and counted.
  const excludedMissingFirstToken = windowSamples.filter((s) => s.firstTokenMs === undefined).length;
  const usable = windowSamples.filter((s) => s.firstTokenMs !== undefined);
  const resumed = usable.filter((s) => s.resumed);
  const nonResumed = usable.filter((s) => !s.resumed);

  const pair = (xs: number[]): PercentilePair => {
    const sorted = [...xs].sort((a, b) => a - b);
    return { p50: nearestRank(sorted, 50), p95: nearestRank(sorted, 95) };
  };
  const bucket = (xs: VoiceTurnSample[]) => ({
    firstTokenMs: pair(xs.map((s) => s.firstTokenMs!)),
    totalMs: pair(xs.map((s) => s.totalMs)),
  });

  const shortfallParts: string[] = [];
  if (resumed.length < 50) shortfallParts.push(`resumed=${resumed.length}<50`);
  if (nonResumed.length < 20) shortfallParts.push(`nonResumed=${nonResumed.length}<20`);
  const shortfall =
    shortfallParts.length > 0
      ? `SAMPLE SHORTFALL: ${shortfallParts.join(", ")} — operator decides: bless small-n (recorded) or wait for traffic (spec §3.2)`
      : null;

  return {
    artifact: {
      kind: "voice_latency_baseline",
      version: 1,
      capturedAt: opts.capturedAt,
      engineVersion: opts.engineVersion,
      gitSha: opts.gitSha,
      source: "vapi-production-logs",
      window: { from: opts.from, to: opts.to },
      agentId: opts.agentId,
      mode: "streaming",
      samples: {
        resumed: resumed.length,
        nonResumed: nonResumed.length,
        excludedMissingFirstToken,
      },
      metrics: { resumed: bucket(resumed), nonResumed: bucket(nonResumed) },
      blessing: { blessedBy: "", blessedAt: "", linearRef: "" },
      notes: shortfall ?? "",
    },
    shortfall,
  };
}

async function harvestDir(logDir: string, agentId: string, fromMs: number, toMs: number): Promise<VoiceTurnSample[]> {
  const samples: VoiceTurnSample[] = [];
  const names = readdirSync(logDir).filter((n) => {
    try {
      return statSync(join(logDir, n)).isFile();
    } catch {
      return false;
    }
  });
  for (const name of names) {
    const rl = createInterface({ input: createReadStream(join(logDir, name)), crlfDelay: Infinity });
    for await (const line of rl) {
      const s = parseVoiceTurnLine(line, agentId);
      if (s && s.tsMs >= fromMs && s.tsMs <= toMs) samples.push(s);
    }
  }
  return samples;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "log-dir": { type: "string" },
      agent: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      days: { type: "string" },
      "git-sha": { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values["log-dir"] || !values.agent || !values.out) {
    process.stderr.write("required: --log-dir <dir> --agent <agentId> --out <file>\n");
    process.exit(1);
  }
  const to = values.to ? new Date(values.to) : new Date();
  const days = values.days ? parseInt(values.days, 10) : 30;
  const from = values.from ? new Date(values.from) : new Date(to.getTime() - days * 86_400_000);
  if (to.getTime() - from.getTime() > 30 * 86_400_000) {
    process.stderr.write("window exceeds the spec §3.2 maximum of 30 days\n");
    process.exit(1);
  }

  const engineVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string }).version;
  let gitSha = values["git-sha"] ?? "";
  if (!gitSha) {
    try {
      gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    } catch {
      gitSha = "unknown";
    }
  }

  const samples = await harvestDir(values["log-dir"], values.agent, from.getTime(), to.getTime());
  const { artifact, shortfall } = buildArtifact(samples, {
    capturedAt: new Date().toISOString(),
    engineVersion,
    gitSha,
    agentId: values.agent,
    from: from.toISOString(),
    to: to.toISOString(),
  });

  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(artifact, null, 2) + "\n");
  // Summary is aggregate-only — mirrors the artifact, nothing more.
  process.stdout.write(JSON.stringify({ out: values.out, samples: artifact.samples, metrics: artifact.metrics }, null, 2) + "\n");
  if (shortfall) process.stderr.write(shortfall + "\n");
}

// Main-guard (mirrors scripts/flatten-skills.ts) so the vitest import of the
// pure functions never runs the harvest.
if (process.argv[1]?.endsWith("voice-latency-baseline.ts")) {
  await main();
}
```

(Adjust the main-guard idiom to match `scripts/flatten-skills.ts`'s exact pattern at delivery — cosmetic. The esbuild shim-guard hazard does not apply: `scripts/` is not bundled.)

- [ ] **Step 2:** `scripts/voice-latency-baseline.test.ts` — implement the Testing-Contract C6 assertion list exactly: `nearestRank` on known vectors (`[1..10]` → p50=5, p95=10; `[7]` → p50=p95=7; empty → 0); parser accept/reject matrix (wrong msg, wrong component, wrong agent, non-streaming, non-JSON, bad ts); window filtering at the harvest boundary (test via `buildArtifact` input pre-filtering — pass samples straight in); exclusion counting + bucket split; schema-shape assertion (`Object.keys` exact match against the §3.3 schema, `blessing` empty); shortfall note for small-n; a full artifact stringified contains no `callId` key and no `text` key.
- [ ] **Step 3:** Verify — `npx vitest run scripts/voice-latency-baseline.test.ts` green; typecheck green; `npm run check:bundle` green (script not pulled into any bundle entry).
- [ ] **Step 4:** Commit — `git commit -m "feat(kpr-323): C6 read-only voice latency baseline harvester + artifact schema"`

### Task 9 — CI close-out (full gates before any deploy/gated work)

- [ ] `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` green at delivery HEAD.
- [ ] `npm run check:bundle` green (warm-voice-session enters the engine bundle via agent-manager import; baseline script stays out).
- [ ] Flag-off equivalence audit: `git diff <pre-323-sha> -- src/channels/voice/voice-adapter.ts` shows ONLY C1 stamps + log fields; grep confirms the warm branch is reachable only through `isWarmPathEligible` and that `voice.warmPath.enabled` defaults `false` (config resolver test is the proof).
- [ ] Zero-322-delta audit: `git diff <322-merge-sha> -- src/agents/agent-manager.test.ts src/channels/voice/` shows additions only, no modified/deleted lines in 322's committed cases.
- [ ] Commit any stragglers; this is the last ungated task.

### Task 10 — [GATE: operator go, D3] W0: baseline harvest + blessing (unblocks 322 P2)

> **GO block to present (verbatim, fill values):**
> **W0 — blessed first-audio baseline.** Read-only harvest of the dodi instance's existing engine logs (the "Voice turn complete" lines from the production Vapi line): no engine change, no calls placed, no message content or phone numbers touched — the artifact is aggregate-only (counts + percentiles). Output: one JSON committed to `docs/epics/kpr-320/baselines/` + mirrored into a Linear KPR-323 comment, then blessed by you and immutable. This number becomes the comparand for every W5 latency gate, including 322's P2. Window: last ≤30 days, agent `<agentId>`. Go?

- [ ] Record the go (date/words) in Linear KPR-323 comments; without it, stop. **No engine deploy required** — the script runs from the lane checkout against the instance log dir.
- [ ] Run (values filled at execution; log dir = the launchd stdout/stderr destination for the instance — confirm from the instance plist):

```bash
npx tsx scripts/voice-latency-baseline.ts \
  --log-dir ~/services/hive/dodi/logs \
  --agent mokie \
  --days 30 \
  --out docs/epics/kpr-320/baselines/voice-baseline-$(date +%Y-%m-%d).json
```

- [ ] **Sample minimums (spec §3.2):** ≥50 resumed + ≥20 non-resumed. If short, the shortfall is already recorded in the artifact `notes` — present it to the operator, who decides: bless small-n (flagged) or wait for traffic (re-run later; each re-run is a new go).
- [ ] Operator reviews numbers + sample sizes → blesses in Linear (date + words). Stamp `blessing` (`blessedBy`, `blessedAt`, `linearRef`) into the artifact.
- [ ] Commit the artifact to the epic branch + mirror the JSON into a Linear KPR-323 comment. **Immutable thereafter** — later runs never edit it; re-baselining is a NEW artifact + new blessing, the old file stays as history (spec §3.4).
- [ ] Notify the 322 lane / epic driver: **P2's placeholder resolves to this artifact's `metrics.resumed.firstTokenMs.p50`** (spec §3.4 step 4). Record in the epic decision register.

### Task 11 — [GATE: operator go, D3] W1: cold-turn decomposition — THE FALSIFICATION GATE

> **GO block:** W1 — passive read of the new C1 log fields from ≥20 live turns of normal Vapi traffic on the deployed engine (no synthetic calls; if traffic is thin, ONE operator-placed scripted call is permitted — that call is part of this go). Requires the Task 2 build deployed + engine restart (`launchctl kickstart -k gui/$(id -u)/com.hive.dodi.agent`). Cost: none beyond normal traffic. Go?

- [ ] Record the go. Deploy prerequisite: C1 on the instance, restart, confirm a "Voice turn complete" line carries the six new fields.
- [ ] Collect ≥20 turns; tabulate per-stage attribution: `promptBuildMs + sessionLookupMs` (T0→T1), `lockWaitMs` (T1→T2), `spawnPrepMs` (T2→T3), `bootToInitMs` (T3→T5), `initToFirstTokenMs` (T5→T6) vs `firstTokenMs` p50.
- [ ] **Falsification rule (spec §7, verbatim):** if `T3→T5 + T2→T3 < 40%` of `firstTokenMs` p50, the warm path cannot clear the bar → **this ticket demotes to the spec lane** and mechanism C (per-turn component shaving) is designed against the measured component list. Otherwise proceed.
- [ ] **Re-derive the W2 thresholds** from the measured T5→T6 floor: warm target = TTFT floor + ≤150ms overhead; record the bound values (replacing the spec's ⚠ placeholders `[baseline − 800ms]` and `900ms` absolute) in lane notes + the epic decision register BEFORE the W2 go is requested.
- [ ] Record the attribution table in lane notes + decision register.

### Task 12 — [GATE: operator go, D3] W2: warm A/B + SDK behavior verification (on the Vapi path)

> **GO block:** W2 — scripted 10-turn call shape (reuse 322 §14.2's script; `voice-pilot` test agent — never production defs): N=5 calls warm-on vs N=5 warm-off, same day, same agent/model/script, on the incumbent Vapi line (322 delivery not required). Plus in-run behavior checks: turn demux, interrupt-then-continue, interrupt-on-idle-session, one mid-call subprocess-kill fallback drill. **Heads-up:** `voice.warmPath.enabled` is instance-global — during the warm-on window, any concurrent production voice call also rides the warm path; I'll keep the window short and announce start/stop. Vendor cost: Vapi minutes for ~10 short calls (dollars). Thresholds: warm turns 2+ `firstTokenMs` p50 ≤ **[W1-bound value]** and ≤ **[W1-bound absolute]**. Go?

- [ ] Record the go. Preconditions: Tasks 1–7 deployed; `voice-pilot` agent exists (322 Task 14 prep — if 322's gated work hasn't run yet, create it the same way: Sonnet, minimal coreServers, test-call guardrails, `spawnBudget: 5`); W1 thresholds bound; W0 artifact blessed.
- [ ] Warm-off cell first (5 calls), then flip `voice.warmPath.enabled: true` in the instance hive.yaml + kickstart, warm-on cell (5 calls), flip back off + kickstart at the end of the window (default stays off until pilot rollout).
- [ ] **Latency pass rule:** turns 2..N warm `firstTokenMs` p50 ≤ the W1-bound values. Compare via the C1/C2 log fields (`warmPath`, `warmTurnSeq`, `firstTokenMs` — semantics identical across cells).
- [ ] **Behavior checks (each recorded pass/fail):**
  - Demux: every turn's spoken reply answers its own utterance across all 10 turns × 5 warm calls — zero cross-turn bleed. **Failure = material → demote to spec lane** (spec §7).
  - Interrupt-then-continue: barge-in mid-answer → generation stops, next turn answers in-session (`warmTurnSeq` increments, no lease re-open in logs). **Failure = material → demote.**
  - Interrupt-on-idle: hang up / disconnect during the adapter's pre-spawn awaits on turn N → verify the session either survives or degrades cleanly to a closed lease + cold next turn (spec §4.4 edge; either outcome passes, a wedged call fails).
  - Fallback drill: `kill` the lease's claude subprocess mid-call (identify via `ps` + the call's start time) → the in-flight turn errors, lease closes, next utterance recovers via the cold outer retry within ONE turn (caller hears one slower turn, none lost).
  - Session-id rotation + per-turn usage attribution (⚠ registry #3/#4): confirm per-turn `sessionStore` writes and sane per-turn (non-cumulative) usage numbers in the logs; anomalies are recorded (telemetry-accuracy impact only) — not gate failures unless rotation loss breaks the fallback drill.
- [ ] Record per-cell tables + verdicts in lane notes + epic decision register. All pass → recommend flipping the default for the pilot cohort in KPR-325's lane (not here; default stays `false` on this ticket).

### Task 13 — [GATE: operator go, D3] W-leak: soak / reclaim drills

> **GO block:** W-leak — 3 concurrent scripted calls on `voice-pilot` (warm-on window), then: 1 abnormal end (kill the worker/hang up mid-call), 1 engine restart mid-call. Verifies lease reclaim, budget release, and orphan-process hygiene. Cost: Vapi minutes (cents–dollars). Go?

- [ ] Record the go. Flag on for the window (same instance-global caveat as W2).
- [ ] 3 concurrent calls → `hive doctor` / snapshot shows `warm-voice=3` on the agent and 3 held budget slots.
- [ ] Abnormal end (hang up mid-call, no further turns): within **150s** (idle 120s + margin) — `warmVoiceSessions` back down, budget slot freed, no orphan `claude` process for the call (`ps ax -o pid,etime,command | grep "[c]laude"` count returns to baseline).
- [ ] Engine restart mid-call (`launchctl kickstart -k ...`): leases are in-memory → gone; the next turn on the surviving call resumes cold from the per-turn-persisted Mongo sessionId (or one clean outer retry) — session store consistent, next call opens a fresh lease clean.
- [ ] Record all three drill outcomes in lane notes. Any stuck slot / orphan process / unreclaimed lease = implementation bug → fix re-enters Task 4/5, re-drill under the same go only if no new vendor spend; otherwise re-request.

### Task 14 — Close-out

- [ ] Confirm merged default: `voice.warmPath.enabled` resolves `false` absent config (resolver test is the proof); instance hive.yamls left OFF (pilot flip belongs to KPR-325's rollout).
- [ ] Epic decision register rows: W0 artifact + blessing link; W1 attribution + threshold derivation; W2 verdicts (incl. the demux/interrupt SDK-behavior confirmations that retire ⚠ #1/#2); W-leak outcomes; warm-vs-cold comparison noted for 322 P3's post-interruption bound (spec §7 last row) once both datasets exist.
- [ ] Seams honored (verify nothing leaked in): zero adapter behavior change (C1 log fields only); zero 322-test edits; no KPR-324 tool-latency mechanism; no KPR-325 personas/rollout; no non-voice warm path; no `setModel`/mid-call prompt rebuild/end-of-call endpoint (seam-noted only); no SDK V2 `SDKSession` usage.
- [ ] `npm run check` + `npm run check:bundle` green at final HEAD; lane notes complete (Task 0 table, gate records, GO transcripts referenced by Linear comment link).

---

## 3. Scope guards (restated non-goals — spec §8)

- **No delivery now** — W5 is maturity-only; this plan runs only after operator re-open (+ W3 merge + 322 T1–T3).
- **No KPR-324 content** — the warm path changes nothing about tool-latency masking; deltas pause during server-side tool runs exactly as on the cold path.
- **No KPR-325 content** — personas/rubric/rollout; the pilot default-flip decision is 325's.
- **No warm path for non-voice channels** — chat cadence never amortizes a held budget slot.
- **No mechanism B (generic pre-warm pool) or C (component shaving)** — C is the documented fallback that only activates via W1's falsification rule, as a NEW spec-lane pass.
- **No mid-call model switching, no voice-prompt hot-rebuild mid-call, no explicit end-of-call release endpoint** (seam note stays a note), **no `SDKSession` (@alpha) adoption, no non-Claude-provider voice, no Vapi migration.**
- **No new config knobs beyond the one boolean** — idle timeout and lifetime cap stay constants (simplicity ruling).

## 4. ⚠ verify-at-execution registry (consolidated)

| # | Claim to re-verify | Where |
|---|---|---|
| 1 | **SDK streaming-input per-pushed-message `result` emission** — the lease's turn boundary (§4.2; the spec's single biggest assumption). Typings pinned at Task 0; live at W2. Failure = **material demote** | Task 0 → Task 4 → Task 12 |
| 2 | **`interrupt()` leaves the session usable** for the next queued turn (§4.4). Live at W2; fallback if false: interrupt degrades to lease-close + cold next turn (correct, loses the barge-in win) | Task 12 |
| 3 | Session-id rotation visibility per turn in streaming mode (KPR-211 semantics under streaming input) — full-transcript retry covers the gap regardless | Task 0 → Task 12 |
| 4 | Per-turn usage/cost attribution in streaming mode (per-exchange, not cumulative) — telemetry/activity-log accuracy only | Task 12 |
| 5 | `maxTurns` / `maxBudgetUsd` scope under streaming input (per-exchange vs whole-session). If cumulative: warm envelope omits/raises them — one-line decision recorded at Task 0 | Task 0 → Task 3 |
| 6 | `system/init` emission timing in streaming-input mode (first turn only; `bootToInitMs` anchor validity on the cold path is unaffected) | Task 12 |
| 7 | W2 pass thresholds are placeholders until W1 measures the TTFT floor; W0's artifact binds 322 P2 regardless | Task 11 → Task 12 |
| 8 | Idle 120s / lifetime 2h constants — pilot-tunable by code change only, deliberately not config | Tasks 4, 12, 13 |
| 9 | Baseline sample minimums (50/20 in ≤30 days) — operator may bless small-n with the shortfall recorded | Task 10 |
| 10 | `"Spawn budget exceeded"` string contract with the adapter survives until W3's typed errors re-bind it (§9.3) | Task 0 → Task 5 tests |
| 11 | Explicit end-of-call release (worker `DELETE /v1/calls/<id>`) — seam note only; idle timeout is the designed mechanism | — (recorded for 322/325 delivery) |
| 12 | `scheduleReflectionIfEligible` turns-credit extension — shape pinned in Task 5 against the `(prior ?? 0) + 1` body; re-check for W3 drift | Task 0 → Task 5 |
| 13 | Interrupt-on-idle-session behavior (disconnect during pre-spawn awaits; §4.4 edge) | Task 12 |
| 14 | Manual `q.next()` consumption keeps the generator open across turns (a for-await `break` would `return()` it) — pinned by unit assertion 3; live at W2 | Task 4 → Task 12 |
| 15 | Installed SDK version at delivery (package pins `^0.2.63`; main resolved `0.2.104` at plan time, where all Task-0 typing claims verify) — pin the exact delivery version + re-check the five claims | Task 0 |
| 16 | `voice.warmPath.enabled` is instance-global — production calls ride warm during any warm-on test window (disclosed in the W2/W-leak GO blocks) | Tasks 12, 13 |
| 17 | Instance log-dir location + rotation shape for the harvest (launchd stdout destination; plain JSON-lines assumed) | Task 10 |

---

**Execution handoff:** plan saved at `docs/epics/kpr-320/kpr-323-plan.md`. Dispatcher runs the plan-review loop; on approval + W5 re-open + W3 merge + 322 T1–T3 merge, execute via `dodi-dev:implement` starting at Task 0. W0 (Tasks 8+10) may be sequenced first on its own recorded go — it has no engine dependencies and unblocks 322 P2.
