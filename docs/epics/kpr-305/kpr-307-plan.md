# KPR-307 — Honest Outage Behavior Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** While KPR-306's breaker is open, every affected human-facing thread gets one immediate honest plain-text notice per outage episode (on every channel, including SMS/iMessage which are silent today), fast-failed and probe-failure turns persist to a Mongo-backed `outage_queue` keyed `(itemId, agentId)`, and a 15s serial replay poller redispatches them oldest-first after recovery — with all replay outcomes authored by the dispatcher per the spec's normative §5-2g table.

**Architecture:** Three new files under `src/outage/` (`outage-queue-store.ts` — durable queue with composite key + TTL + depth cap; `outage-notices.ts` — templates, source-policy table, in-memory episode tracker with synchronous test-and-set; `outage-replay-processor.ts` — 15s poller with re-read-status drain control) plus surgical touches: `dispatcher.ts` (reactive interception at both catch sites via one extracted helper, post-turn open-state gate incl. the `timedOut && aborted` disjunct, dedup bypass for replays, pinned-agent-only replay resolution, dispatcher-written outcome releases on every path), `agent-manager.ts` (additive `providerFor()` + `TurnResult.timedOut?/aborted?` propagation), `voice-adapter.ts` (spoken outage completion instead of a generic 500), `config.ts` (liberal `outageQueue` section), `index.ts` (wiring), doctor (informational section, D4), and CLAUDE.md.

**Tech Stack:** TypeScript (strict), Node 22, vitest, mongodb driver — all existing; **no new dependencies**.

**Spec:** `docs/epics/kpr-305/kpr-307-spec.md` (r4-clean; all three §5 operator rulings AS RECOMMENDED — once-per-thread-per-episode notices incl. the SMS silence→one-text behavior change, the full recommended replay package, the recommended queueing-policy table). Written against branch `mature/KPR-307` @ `2afca8dc` (code baseline = `main` @ `08ca29e`).

**Binding upstream contract (KPR-306, frozen):** `ProviderCircuitOpenError { provider, openedAt, retryAfterMs, reason, lastFaultMessage }` thrown from the top of the `spawnTurn` ticket lambda before `prepareSpawn`; `agentManager.circuitBreakers.stateFor(provider)` / `.getSnapshot()` returning `CircuitBreakerSnapshot` (incl. `enabled` — false = shadow mode); `classifyTurnResult(input: TurnFaultInput)` + `HARD_FAULT_KINDS` exported from `src/agents/provider-adapters/error-classification.ts`; `RunResult.timedOut?: boolean` set by the runner deadline. This plan consumes all of these additively and changes none of them.

---

## ⚠ MANDATORY Task 0 — Re-confirm at execution HEAD (maturity-first discipline)

This plan is written ahead of implementation against `mature/KPR-307` @ `2afca8dc`, whose **code content predates KPR-306**. KPR-306 is a hard dependency (blocking edge 306→307) and **WILL be implemented and merged to the epic branch before this ticket** — therefore `src/agents/agent-manager.ts`, `src/agents/agent-runner.ts`, `src/channels/dispatcher.ts`, `src/config.ts`, `src/index.ts`, `src/cli/doctor.ts`, and `src/cli/doctor-checks.ts` **WILL have moved** relative to every line number cited below. Line numbers in this plan are baseline hints only. **Anchor semantically** — by function name, region description, and grep pattern — never by line number alone. If an anchor has drifted materially (function renamed, control flow restructured, a KPR-306 export shape differs from its Open-Circuit Contract), STOP and adjust the plan — or demote to the spec lane if the drift is architectural.

- [ ] **Step 0.1:** Verify the KPR-306 deliverables this ticket binds to exist at HEAD. **If any row fails, this ticket is BLOCKED on KPR-306 — do not improvise a stub.**

| # | KPR-306 deliverable (frozen contract) | Re-check command | Expect |
|---|---|---|---|
| D1 | `ProviderCircuitOpenError` exported with `provider/openedAt/retryAfterMs/reason/lastFaultMessage` | `grep -n "export class ProviderCircuitOpenError" src/agents/provider-circuit-breaker.ts` then read its constructor | class present, fields per contract; **also confirm the constructor arity/shape at HEAD** — KPR-306 freezes the FIELDS, not the constructor signature. Task 5/8 fixtures assume a positional 5-arg `new ProviderCircuitOpenError(provider, openedAt, retryAfterMs, reason, lastFaultMessage)`; adapt those fixtures if the ctor differs |
| D2 | `CircuitBreakerSnapshot` with `state` and `enabled` fields; `stateFor(provider)` on the registry | `grep -n "stateFor\|enabled" src/agents/provider-circuit-breaker.ts \| head` | both present |
| D3 | `AgentManager` exposes `readonly circuitBreakers` | `grep -n "circuitBreakers" src/agents/agent-manager.ts` | public readonly field |
| D4 | `classifyTurnResult` + `HARD_FAULT_KINDS` exported | `grep -n "export function classifyTurnResult\|export const HARD_FAULT_KINDS" src/agents/provider-adapters/error-classification.ts` | both exported |
| D5 | `RunResult.timedOut?: boolean` exists | `grep -n "timedOut" src/agents/agent-runner.ts \| head -3` | field on `RunResult` |
| D6 | Doctor has a circuit-breaker section whose rows carry `state` | `grep -n "renderCircuitBreakerSection\|circuitBreakerStatsForDoctor" src/cli/doctor.ts src/cli/doctor-checks.ts` | present (Task 9 reads its rows for the stuck-drain flag) |

- [ ] **Step 0.2:** Re-confirm every baseline citation this plan's edits anchor to. All anchors are given as grep patterns; the cited `:NNN` numbers are from `08ca29e` and will be stale — that is expected.

| # | Claim | Baseline anchor @ 08ca29e | Re-check command (semantic) |
|---|---|---|---|
| C1 | `dispatch()` step 0 dedup: `if (this.recentMessageIds.has(item.id))` → debug-log + return; `DEDUP_TTL_MS = 60_000` | `src/channels/dispatcher.ts:104-109` | `grep -n "recentMessageIds.has" src/channels/dispatcher.ts` |
| C2 | Single-dispatch catch builds `WorkResult{ text: "Something went wrong: ${err}", error }`, delivers, retry-queues on delivery failure, logs "Dispatch failed" | `dispatcher.ts:258-275` | `grep -n "Something went wrong" src/channels/dispatcher.ts` (expect exactly 2 sites pre-change) |
| C3 | Fan-out catch (`dispatchToAgent`) is a near-duplicate of C2 (logs "Fan-out dispatch failed", no warn on delivery failure) | `dispatcher.ts:646-663` | same grep as C2, second hit |
| C4 | No-agent early return: `resolvedList.length === 0` → warn + return | `dispatcher.ts:139-146` | `grep -n "No agent found for work item" src/channels/dispatcher.ts` |
| C5 | Disabled-agent early return: `activeList.length === 0` → return (after per-agent disabled filter) | `dispatcher.ts:149-157` | `grep -n "agent is disabled" src/channels/dispatcher.ts` |
| C6 | Success path: `convertTurnResult(await runWorkItemTurn(...))` → NON_RESPONSE check → `WorkResult` build with `error: runResult.error` → deliver → taskLedger/audit/log | `dispatcher.ts:205-257` | `grep -n "convertTurnResult(await" src/channels/dispatcher.ts` (2 sites: dispatch + dispatchToAgent) |
| C7 | `convertTurnResult` hardcodes `aborted: false` with a "never read downstream" comment | `dispatcher.ts:321-325` | `grep -n "aborted: false" src/channels/dispatcher.ts` |
| C8 | `resolveAgents` step 0: `meta.targetAgentId` + `registry.get` → single pinned agent; falls through to other strategies when the pinned agent is missing from the registry | `dispatcher.ts:382-385` | `grep -n "targetAgentId" src/channels/dispatcher.ts \| head -3` |
| C9 | Fan-out + conference dispatch under `Promise.all` (concurrent same-thread catches) | `dispatcher.ts:167`, `:182` | `grep -n "Promise.all(activeList" src/channels/dispatcher.ts` |
| C10 | `Dispatcher.sweep()` prunes thread maps (episode tracker deliberately NOT wired here — pruned on episode end instead) | `dispatcher.ts:666-680` | `grep -n "sweep(threadTtlMs" src/channels/dispatcher.ts` |
| C11 | `TurnResult` interface: `errors: string[]`, no `timedOut`/`aborted` yet at baseline (KPR-306 does not add them to TurnResult — only to RunResult) | `src/agents/agent-manager.ts:102-123` | `grep -n "export interface TurnResult" src/agents/agent-manager.ts` then read; confirm `timedOut`/`aborted` absent from TurnResult |
| C12 | `finalizeSpawnResult` builds the `TurnResult` return object (errors from `result.error`) | `agent-manager.ts:1154-1204` | `grep -n "private finalizeSpawnResult" src/agents/agent-manager.ts` |
| C13 | `resolveProviderModel(model)` module-level fn returning `{ provider }`; `AgentProviderId` from `provider-adapters/types.ts` | `agent-manager.ts:145-163`, `types.ts:4` | `grep -n "function resolveProviderModel" src/agents/agent-manager.ts` |
| C14 | SMS deliver skips when `result.error` set | `src/channels/sms-adapter.ts:62-65` | `grep -n "Skipping SMS delivery" src/channels/sms-adapter.ts` |
| C15 | iMessage deliver skips when `result.error` set | `src/channels/imessage-adapter.ts:113-115` | `grep -n "Skipping iMessage delivery" src/channels/imessage-adapter.ts` |
| C16 | WS deliver: `text = result.error ? "Error: ..." : result.text` (plain text passes clean) | `src/channels/ws/ws-adapter.ts:351` | `grep -n "Error: \${result.error}" src/channels/ws/ws-adapter.ts` |
| C17 | Voice `runOnce` catch flattens throws to `String(err)`; `!outcome.ok` block: auth→503, budget→503, generic→**500** | `src/channels/voice/voice-adapter.ts:299-370` | `grep -n "endWithError" src/channels/voice/voice-adapter.ts` |
| C18 | Voice outer retry fires when `!outcome.ok && effectiveResume && !outcome.bytesSent` | `voice-adapter.ts:327-341` | `grep -n "retrying as turn-1" src/channels/voice/voice-adapter.ts` |
| C19 | Scheduler id formats: `sched:` (`scheduler.ts:231`), `callback:<oid>` (`:289`), `event:<id>:<agentId>` (`:381`), `team-<oid>` (`:428`) — the §5-3a prefix table depends on these | `src/scheduler/scheduler.ts` | `grep -n '"sched:\|"callback:\|\`event:\|\`team-\|id: \`' src/scheduler/scheduler.ts \| head` |
| C20 | Callback-poller precedent: atomic mark-fired via `updateOne({_id, status:"pending"}, {$set:{status:"fired"}})` | `scheduler.ts:265-269` | `grep -n "already picked up" src/scheduler/scheduler.ts` |
| C21 | Delivery retry queue is in-memory, delivery-only — **untouched by this ticket** | `src/sweeper/retry-queue.ts` | `git diff --stat $(git merge-base HEAD kpr-305)..HEAD -- src/sweeper/retry-queue.ts` at the end must show no change (base is the child branch point, not `main` — see Task 10 Step 10.3) |
| C22 | `index.ts`: guarded `db` (`guardDb(rawDb, ...)`), dispatcher construction, `dispatcher.setRetryQueue(retryQueue)`, shutdown block with `scheduler.stop()` | `src/index.ts:148, 381, 735, 789-822` | `grep -n "setRetryQueue\|guardDb\|const shutdown" src/index.ts` |
| C23 | Doctor: `spawnCoordinatorStatsForDoctor` short-lived-client pattern (`serverSelectionTimeoutMS: 2000`, empty/null on error); `runDoctor` post-check section wiring + skipped-else block; only Datastore identity can flip exit code | `src/cli/doctor-checks.ts:331-375`, `src/cli/doctor.ts:600-640` | `grep -n "serverSelectionTimeoutMS: 2000" src/cli/doctor-checks.ts \| head -3`; `grep -n "skipped: config not loaded" src/cli/doctor.ts` |
| C24 | Config liberal-loader precedent (`imessage` block, all-optional `??`); KPR-306 adds `resolveCircuitBreakerConfig` — mirror its placement for `resolveOutageQueueConfig` | `src/config.ts:209-215` | `grep -n "resolveCircuitBreakerConfig\|imessage:" src/config.ts` |
| C25 | dispatcher.test.ts harness: `makeWorkItem`/`makeMockRegistry` (has disabled `chief-of-staff`)/`makeMockAgentManager` (must gain `providerFor` + `circuitBreakers`)/`makeMockAdapter` | `src/channels/dispatcher.test.ts:26-214` | read the helper block |
| C26 | voice-adapter.test.ts harness: `makeAgentManager(turnResult, throwError?)` stub + res/request fixtures | `src/channels/voice/voice-adapter.test.ts:1-160` | read the fixture block |
| C27 | Status interception (`dispatcher.ts:112-135`) precedes agent resolution — replayed items must not be re-intercepted (wrap text > 80 chars guarantees this) | `dispatcher.ts:112-135` | `grep -n "STATUS_MAX_LENGTH" src/channels/dispatcher.ts` |
| C28 | Team `request_response` calls `runWorkItemTurn` directly (bypasses dispatcher) and keeps failed-marking — non-goal, must remain untouched | `scheduler.ts:457-489` | `grep -n "request_response" src/scheduler/scheduler.ts` |

- [ ] **Step 0.3:** Grep for sibling-wave seams: `grep -rn "outage_queue\|outageReplay\|OutageQueueStore\|outagePolicy" src/`. Expect empty (KPR-308 has no shared code with this ticket by design). If KPR-308 landed something that collides, stop and reconcile with the epic driver.
- [ ] **Step 0.4:** Establish a green baseline on the untouched branch:

Run (in the repo root at HEAD — the implement lane runs in a fresh child worktree, not the spec-lane path above): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 (typecheck + lint + format + tests all green) before any edit.

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `src/outage/outage-queue-store.ts` (store semantics against an in-memory fake collection), `src/outage/outage-notices.ts` (policy table, episode tracker, templates, wrap), `src/outage/outage-replay-processor.ts` (drain control, expiry batching, re-entrancy), `src/channels/dispatcher.ts` (both interception legs, every §5-2g outcome path, dedup bypass, pinned-agent replay resolution, episode gating, fan-out race), `src/agents/agent-manager.ts` (`providerFor`, `TurnResult.timedOut/aborted` propagation), `src/channels/voice/voice-adapter.ts` (spoken outage completion), `src/config.ts` (resolver), doctor loader + renderer.
  - Reason: every new behavior is in-process logic over injectable collaborators — the breaker via a stubbed `circuitBreakers.stateFor` fixture and thrown `ProviderCircuitOpenError` literals, Mongo via the repo's established mock-collection patterns, time via injected `now`. No live providers anywhere (spec §11).
  - Minimum assertions (one per spec §11 row — the five r2/r3-added rows are marked ★):
    - **Store:** enqueue idempotency pinned to the composite `(itemId, agentId)` unique key — double-enqueue same agent is a no-op; a fan-out produces N independent docs for one `itemId`, not collapsed to one; claim ordering oldest-`enqueuedAt`-first; atomic claim (two sequential claims never return the same doc); `release` semantics (`pending` non-terminal, `done`/`expired` terminal with `doneAt`); `recordFailedAttempt` attempts+1 → `pending` below cap, terminal `failed` at cap; `expireOlderThan` marks + returns only over-age pending docs; boot-recovery of stale `replaying` reverts only over-age docs.
    - **Notices/tracker:** `policyFor` covers every §5-3a row (`sched:`→skip, `callback:`/`event:`/`team-`→silent, slack/sms/imessage/app/team-DM→notify); episode lifecycle: first fast-fail notices once → repeat turns silent → clear → next outage notices again; repeated fast-fails during one episode never re-notice (the probe-cycle `openedAt`-churn guarantee — the tracker never reads `openedAt` at all); per-sender key for SMS (`threadId ?? sender`); `firstForThread` is a synchronous test-and-set (two immediate calls, no await between: exactly one `true`); template constants + `replayWrap` notify/silent variants pinned.
    - **Dispatcher:** instanceof path queues + delivers plain-text notice with `error` UNSET on the delivered `WorkResult` (the SMS-skip regression guard); post-turn open-state path (errored TurnResult + open snapshot + `HARD_FAULT_KINDS` classification → outage path; `non-provider` classification while open → legacy error path; closed snapshot → legacy; shadow `enabled:false` open snapshot → legacy); ★ **timeout gate** — `timedOut === true && aborted === true` with the breaker open → outage path even when `errors` is empty; `timedOut === true` with the breaker closed → legacy path, unqueued; skip for `sched:`; silent-queue for `callback:`/`event:`/`team-` (no notice delivered); overflow variant at `maxDepth` (not queued; one overflow notice per thread per episode, not per overflowed message); ★ **release-before-depth** — a replayed fast-fail while the queue is at `maxDepth` resolves its existing doc via `store.release(..., "pending")` and does NOT take the overflow branch; `outageReplay` re-entrancy (no dup enqueue, no second notice) + dedup bypass lets the same id redispatch while a non-replay duplicate id is still dropped; ★ **legacy thrown branch** — a replay item that throws a non-outage error (e.g. "Spawn budget exceeded") with the breaker closed releases the doc back to `pending`, attempts unchanged, then continues today's error delivery; disabled pinned-agent replay resolves to `expired`; ★ **deleted/unresolvable pinned-agent replay** resolves to `expired` with NO fall-through resolution (`runWorkItemTurn` never called); episode cleared on success only when `stateFor(provider)?.state !== "open"` at that moment; fan-out double fast-fail on one thread → two enqueues (one per agentId — composite-key evidence), exactly one notice; `failed` terminal transition delivers a plain-text terminal notice on notify policy, none on silent.
    - **Processor:** drain continues through `done`/`expired`/`failed` and ★ **stops on re-read `status === "pending"`** (dispatcher-authored outcomes; `dispatch()` returns void — the poller re-reads, never infers); redispatch keeps the **original** item id (no synthetic per-attempt id) with `meta.outageReplay` + pinned `targetAgentId` and the §5-2d wrapped text; expiry → one batched per-thread notice with the correct count, silent docs excluded; a `dispatch()` throw releases the doc back to `pending` and stops the drain; a doc left in `replaying` after dispatch (no release path fired) is defensively reverted; tick re-entrancy guard.
    - **Agent-manager:** `providerFor` maps bare model → `"claude"`, `gemini/...` → `"gemini"`, unknown agent → `null`; `spawnTurn`'s `TurnResult` carries `timedOut`/`aborted` propagated from `RunResult`.
    - **Voice:** `ProviderCircuitOpenError` from `spawnTurn`/`routeVoiceTurn` → HTTP 200 completion carrying the spoken outage sentence (non-streaming JSON body; streaming SSE text chunk + done), NOT a generic 500; the outer resume-retry does not fire for circuit-open fast-fails.
    - **Doctor:** section renders counts; empty-queue and mongo-unavailable messages; stuck-drain ⚠ appears iff `pending > 0` and no breaker row is open; renderer emits only (returns void — D4 exit-code neutrality); loader returns null on connection error.
    - **Config:** absent section → defaults; partial → per-key `??`; garbage types → defaults.
- Integration: **not-required**
  - Scope: n/a
  - Reason: every cross-module boundary (dispatcher↔store, dispatcher↔breaker snapshot, processor↔dispatcher, store↔Mongo, doctor↔collection) is exercised from both sides in the unit groups using the repo's established harnesses; the store's Mongo surface is pinned by a faithful in-memory fake of the exact driver calls used (same approach as the repo's scheduler/doctor mocks). No new process, network, or DB boundary is introduced; spec §11 bans live-provider tests.
  - Harness: not-applicable
  - Minimum assertions: n/a
- E2E: **not-required**
  - Scope: n/a
  - Reason: a true end-to-end exercise requires a real provider outage. The operator rollout path is the independent kill-switch (`outageQueue.enabled: false` → behavior identical to post-KPR-306) plus the doctor section and logs, giving observable burn-in on a live instance. Voice's spoken-completion rendering against real Vapi is explicitly a rollout-time confirmation (spec §5-1b ⚠), not a CI artifact.
  - Harness: not-applicable
  - Minimum assertions: n/a

### Critical Flows

- Outage begins: a turn fast-fails with `ProviderCircuitOpenError` → the thread gets one honest plain-text notice (delivered on SMS/iMessage too — `error` unset) and the WorkItem persists to `outage_queue`; follow-up turns in the same thread queue silently.
- Probe failure honesty: a completed turn with a hard provider fault — or a hang-type timeout (`timedOut && aborted`, `errors` empty) — while the breaker is open queues + notices instead of delivering `"Something went wrong"` / `"_No response._"`.
- Recovery + drain: the 15s poller's post-cooldown attempt is the half-open probe; on success the drain delivers every queued answer oldest-first into the original threads with the replay context note; drain halts on the first fast-fail-again.
- Outcome integrity: every replay dispatch resolves its queue doc — `done`, `pending` (fast-fail/transient throw), `expired` (age-out, deleted/disabled pinned agent), or attempts+1→`failed` with a terminal plain-text notice — written by the dispatcher, never inferred by the poller.

### Regression Surface

- Healthy-turn delivery contract on every channel (Slack format, SMS/iMessage skip-on-error, WS error frame, voice streaming) — unchanged when the breaker is closed or `outageQueue.enabled: false`; existing dispatcher routing/conference/fan-out suites must stay green.
- Delivery retry queue (`src/sweeper/retry-queue.ts`) — zero diff (ticket text).
- Scheduler (`scheduler.ts`) — zero diff: cron/callback/event/team synthesis and `request_response` failed-marking untouched (prefix-based policy detection chosen per §5-3a recommendation).
- KPR-306 breaker files and `error-classification.ts` — imported only, zero diff.
- Dedup behavior for non-replay items (60s window) unchanged; status-query interception unchanged.
- `convertTurnResult` field mapping stays exhaustive (the `aborted` hardcode is replaced with real propagation, all other fields unchanged).
- Voice auth-503 / budget-503 paths and outer resume-retry semantics for non-circuit errors unchanged.
- Doctor: Datastore identity remains the only exit-code-capable post-check section.

### Commands

- Unit (targeted): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts src/outage/outage-notices.test.ts src/outage/outage-replay-processor.test.ts src/channels/dispatcher.test.ts src/agents/agent-manager.test.ts src/channels/voice/voice-adapter.test.ts src/cli/doctor.test.ts src/cli/doctor-checks.test.ts src/config.test.ts`
- Integration: not-applicable
- E2E: not-applicable
- Broader regression (repo check gate): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- None new. The store test ships its own in-memory `FakeOutageCollection` (implements exactly the driver calls the store makes — the same mock-the-driver-surface approach as `scheduler.test.ts` / `doctor-checks.test.ts`); dispatcher tests mock the store as a plain `vi.fn()` object (the store interface is the seam) and use a real `OutageEpisodeTracker` (pure, synchronous); the processor test mocks both store and dispatcher; voice tests reuse the existing `makeAgentManager`/res fixtures.
- Env stubs `SLACK_APP_TOKEN`/`SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` on the command line (repo check-gate convention).
- Time: injected `now: () => Date` on store/processor; no fake timers needed except the processor interval test (`vi.useFakeTimers`).

### Non-Required Rationale

- Integration: all boundaries are in-process seams already modeled by existing unit harnesses; no new process/network/DB boundary; spec bans live-provider tests.
- E2E: requires a real provider outage; rollout path is the `outageQueue.enabled` kill-switch + doctor/logs observability, per spec.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/outage/outage-queue-store.ts` | **create** | `OutageQueueDoc` schema, `OutageQueueConfig` + defaults, store API (enqueue/claim/release/recordFailedAttempt/expire/recover) over one Mongo collection; composite `(itemId, agentId)` unique key |
| `src/outage/outage-queue-store.test.ts` | **create** | Store semantics against `FakeOutageCollection` |
| `src/outage/outage-notices.ts` | **create** | Notice templates (exported constants), `policyFor` (§5-3a), adapter/thread keys, `replayWrap` (§5-2d), `OutageEpisodeTracker` (synchronous test-and-set) |
| `src/outage/outage-notices.test.ts` | **create** | Policy table, episode lifecycle, wrap/templates pins |
| `src/outage/outage-replay-processor.ts` | **create** | 15s serial poller: expiry + batched notices, claim→redispatch→re-read-status drain |
| `src/outage/outage-replay-processor.test.ts` | **create** | Drain control, expiry batching, throw-safety, re-entrancy |
| `src/config.ts` | modify | `resolveOutageQueueConfig` (exported pure resolver) + `outageQueue` key |
| `src/config.test.ts` | modify | Resolver default/partial/garbage tests |
| `src/agents/agent-manager.ts` | modify | Additive `providerFor(agentId)`; `TurnResult.timedOut?/aborted?` propagated in `finalizeSpawnResult` |
| `src/agents/agent-manager.test.ts` | modify | `providerFor` + propagation tests |
| `src/channels/dispatcher.ts` | modify | Dedup bypass; pinned-agent-only replay resolution; extracted `handleTurnFailure`; outage path + post-turn gate; success/real-failure replay releases; `deliverOutageNotice`; `convertTurnResult` aborted/timedOut mapping |
| `src/channels/dispatcher.test.ts` | modify | Full §5-2g/§7.2 matrix (new describe) |
| `src/channels/voice/voice-adapter.ts` | modify | Circuit-open → spoken outage completion (200, not 500); skip outer retry on circuit-open |
| `src/channels/voice/voice-adapter.test.ts` | modify | Spoken-completion tests |
| `src/index.ts` | modify | Store + tracker + processor wiring behind `config.outageQueue.enabled`; `stop()` in shutdown |
| `src/cli/doctor-checks.ts` | modify | `OutageQueueStats` + `outageQueueStatsForDoctor` (direct collection read) |
| `src/cli/doctor-checks.test.ts` | modify | Loader tests |
| `src/cli/doctor.ts` | modify | `renderOutageQueueSection` (informational, D4) + wiring + skipped-else line |
| `src/cli/doctor.test.ts` | modify | Renderer variant tests |
| `CLAUDE.md` | modify | `outage_queue` collection + Common Gotchas entry |

Untouched by design: `src/sweeper/retry-queue.ts`, `src/sweeper/sweeper.ts`, `src/scheduler/scheduler.ts`, all adapter `deliver()` implementations, all KPR-306 breaker files (`provider-circuit-breaker.ts`, `error-classification.ts`, `circuit-breaker-heartbeat.ts`).

---

### Task 1: Config surface (`outageQueue` hive.yaml section)

**Files:**
- Create: `src/outage/outage-queue-store.ts` (config types only in this task — the store class lands in Task 2)
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1.1:** Create `src/outage/outage-queue-store.ts` with the config contract (Task 2 appends the store to this same file):

```typescript
/**
 * KPR-307: Mongo-backed outage queue — turns fast-failed by KPR-306's
 * provider circuit breaker persist here for automatic replay after recovery.
 * Distinct from the delivery retry queue (src/sweeper/retry-queue.ts), which
 * handles "turn succeeded, channel delivery failed" and is untouched.
 */
import type { Collection, ObjectId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { WorkItem } from "../types/work-item.js";

const log = createLogger("outage-queue");

export interface OutageQueueConfig {
  /** false = interception fully off; fast-fails fall back to today's raw error path. */
  enabled: boolean;
  /** Replay poller tick interval (own timer — NOT a sweeper step; must track the breaker's ≤60s probe cadence). */
  replayIntervalMs: number;
  /** Items older than this at replay time are marked expired, not run (§5-2c). */
  maxAgeHours: number;
  /** Global pending-depth cap; at cap new turns are NOT queued and get the overflow notice (§5-2f). */
  maxDepth: number;
  /** Real (non-fast-fail) replay attempts before terminal `failed` (§5-2g). */
  maxReplayAttempts: number;
}

/** ⚠ spec §10 delegated defaults, chosen for the 30-minute-outage profile. */
export const DEFAULT_OUTAGE_QUEUE_CONFIG: OutageQueueConfig = {
  enabled: true,
  replayIntervalMs: 15_000,
  maxAgeHours: 4,
  maxDepth: 500,
  maxReplayAttempts: 3,
};
```

- [ ] **Step 1.2:** In `src/config.ts`, add the resolver next to `resolveCircuitBreakerConfig` (KPR-306 — anchor: `grep -n "resolveCircuitBreakerConfig" src/config.ts`; if 306 placed its resolver elsewhere, co-locate with it):

```typescript
import { DEFAULT_OUTAGE_QUEUE_CONFIG, type OutageQueueConfig } from "./outage/outage-queue-store.js";

/**
 * KPR-307: liberal-loader resolver for the `outageQueue` hive.yaml section
 * (KPR-225 F3 — all keys optional, unknown keys ignored, absent section =
 * all defaults). Exported pure for unit tests.
 */
export function resolveOutageQueueConfig(raw: unknown): OutageQueueConfig {
  const d = DEFAULT_OUTAGE_QUEUE_CONFIG;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const r = raw as Record<string, unknown>;
  const posNum = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    replayIntervalMs: posNum(r.replayIntervalMs, d.replayIntervalMs),
    maxAgeHours: posNum(r.maxAgeHours, d.maxAgeHours),
    maxDepth: posNum(r.maxDepth, d.maxDepth),
    maxReplayAttempts: posNum(r.maxReplayAttempts, d.maxReplayAttempts),
  };
}
```

and add the key to the `config` object (next to the `circuitBreaker` key KPR-306 added):

```typescript
  outageQueue: resolveOutageQueueConfig(hive.outageQueue),
```

Note: `outage-queue-store.ts` imports only `mongodb` types, the dependency-free logger, and work-item types — no import cycle back into `config.ts`.

- [ ] **Step 1.3:** Extend `src/config.test.ts` (mirror the `resolveCircuitBreakerConfig` describe KPR-306 added):

```typescript
import { resolveOutageQueueConfig } from "./config.js";
import { DEFAULT_OUTAGE_QUEUE_CONFIG } from "./outage/outage-queue-store.js";

describe("resolveOutageQueueConfig (KPR-307)", () => {
  it("returns all defaults for absent/garbage sections", () => {
    expect(resolveOutageQueueConfig(undefined)).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
    expect(resolveOutageQueueConfig(null)).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
    expect(resolveOutageQueueConfig("nope")).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
    expect(resolveOutageQueueConfig([])).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
  });

  it("applies per-key ?? on partial sections", () => {
    const resolved = resolveOutageQueueConfig({ enabled: false, maxDepth: 100 });
    expect(resolved.enabled).toBe(false);
    expect(resolved.maxDepth).toBe(100);
    expect(resolved.replayIntervalMs).toBe(15_000);
    expect(resolved.maxAgeHours).toBe(4);
    expect(resolved.maxReplayAttempts).toBe(3);
  });

  it("rejects garbage-typed and non-positive values per key", () => {
    const resolved = resolveOutageQueueConfig({
      enabled: "yes",
      replayIntervalMs: "fast",
      maxAgeHours: -4,
      maxDepth: NaN,
      maxReplayAttempts: 0,
    });
    expect(resolved).toEqual(DEFAULT_OUTAGE_QUEUE_CONFIG);
  });
});
```

- [ ] **Step 1.4:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/config.test.ts && npm run typecheck`
Expected: config tests pass (3 new), typecheck clean.

- [ ] **Step 1.5:** Commit

```bash
git add src/outage/outage-queue-store.ts src/config.ts src/config.test.ts
git commit -m "KPR-307: outageQueue config section (liberal loader, all-optional defaults)"
```

### Task 2: Outage queue store (`outage_queue` collection)

**Files:**
- Modify: `src/outage/outage-queue-store.ts` (append the store below the Task-1 config block)
- Test: `src/outage/outage-queue-store.test.ts`

- [ ] **Step 2.1:** Append to `src/outage/outage-queue-store.ts`:

```typescript
export type OutagePolicy = "notify" | "silent";
export type OutageQueueStatus = "pending" | "replaying" | "done" | "expired" | "failed";

export interface OutageQueueDoc {
  _id?: ObjectId;
  /** Original WorkItem.id — composite-unique with agentId: a fan-out dispatch
   *  produces one doc per fanned agent (Finding 4, spec review round 2). */
  itemId: string;
  /** Resolved agent, pinned for replay (meta.targetAgentId at redispatch). */
  agentId: string;
  /** Provider whose breaker was open at enqueue time (AgentProviderId value). */
  provider: string;
  /** Serialized verbatim — Date + meta survive the BSON round-trip. */
  workItem: WorkItem;
  policy: OutagePolicy;
  status: OutageQueueStatus;
  /** Real (non-fast-fail) replay attempts. Breaker-open retries are free and never counted. */
  attempts: number;
  enqueuedAt: Date;
  lastAttemptAt: Date | null;
  /** Truncated to 240 chars (mirrors the KPR-306 convention). */
  lastError: string | null;
  noticeSent: boolean;
  /** Set on terminal transitions (done/expired/failed); TTL hygiene target. */
  doneAt: Date | null;
}

export interface OutageEnqueueInput {
  itemId: string;
  agentId: string;
  provider: string;
  workItem: WorkItem;
  policy: OutagePolicy;
}

/** Terminal-doc hygiene TTL (⚠ spec §10): 7 days. */
const TERMINAL_TTL_SECONDS = 7 * 24 * 3600;

/** `replaying` docs older than one turn deadline (300s) + slack revert to
 *  pending at boot — crash between claim and release (spec §7.1). */
export const STALE_REPLAYING_MS = 300_000 + 60_000;

export class OutageQueueStore {
  constructor(
    private collection: Collection<OutageQueueDoc>,
    private now: () => Date = () => new Date(),
  ) {}

  async ensureIndexes(): Promise<void> {
    // Composite unique key: a unique index on itemId ALONE would collapse a
    // fan-out dispatch's N agents to one queued doc, silently dropping N−1
    // of the fanned agents' replies (spec §7.1).
    await this.collection.createIndex({ itemId: 1, agentId: 1 }, { unique: true });
    await this.collection.createIndex({ status: 1, enqueuedAt: 1 });
    // TTL applies only to docs where doneAt is a Date (terminal states);
    // pending/replaying docs carry doneAt: null and Mongo TTL skips non-Date values.
    await this.collection.createIndex({ doneAt: 1 }, { expireAfterSeconds: TERMINAL_TTL_SECONDS });
  }

  /** Upsert on (itemId, agentId): double-enqueue for the same agent is a
   *  no-op; a fan-out enqueues one independent doc per fanned agent. */
  async enqueue(input: OutageEnqueueInput): Promise<void> {
    await this.collection.updateOne(
      { itemId: input.itemId, agentId: input.agentId },
      {
        $setOnInsert: {
          provider: input.provider,
          workItem: input.workItem,
          policy: input.policy,
          status: "pending",
          attempts: 0,
          enqueuedAt: this.now(),
          lastAttemptAt: null,
          lastError: null,
          noticeSent: false,
          doneAt: null,
        },
      },
      { upsert: true },
    );
  }

  /** Atomic pending→replaying claim, oldest enqueuedAt first — copies the
   *  callback poller's mark-before-dispatch pattern (scheduler.ts). */
  async claimNext(): Promise<OutageQueueDoc | null> {
    return this.collection.findOneAndUpdate(
      { status: "pending" },
      { $set: { status: "replaying", lastAttemptAt: this.now() } },
      { sort: { enqueuedAt: 1 }, returnDocument: "after" },
    );
  }

  /**
   * Dispatcher-authored outcome write (§5-2g — the dispatcher decides, the
   * poller only re-reads). `pending` = fast-fail-again or transient thrown
   * error (attempts unchanged); `done`/`expired` are terminal. Real failures
   * go through recordFailedAttempt instead.
   */
  async release(
    itemId: string,
    agentId: string,
    outcome: "pending" | "done" | "expired",
    lastError?: string,
  ): Promise<void> {
    const terminal = outcome !== "pending";
    await this.collection.updateOne(
      { itemId, agentId },
      {
        $set: {
          status: outcome,
          doneAt: terminal ? this.now() : null,
          ...(lastError !== undefined ? { lastError: lastError.slice(0, 240) } : {}),
        },
      },
    );
  }

  /** Real (breaker-closed) replay failure: attempts+1; terminal `failed` at the cap. */
  async recordFailedAttempt(
    itemId: string,
    agentId: string,
    lastError: string,
    maxAttempts: number,
  ): Promise<{ terminal: boolean; doc: OutageQueueDoc | null }> {
    const doc = await this.collection.findOneAndUpdate(
      { itemId, agentId },
      { $inc: { attempts: 1 }, $set: { lastError: lastError.slice(0, 240) } },
      { returnDocument: "after" },
    );
    if (!doc) return { terminal: false, doc: null };
    const terminal = doc.attempts >= maxAttempts;
    await this.collection.updateOne(
      { itemId, agentId },
      { $set: terminal ? { status: "failed", doneAt: this.now() } : { status: "pending", doneAt: null } },
    );
    return { terminal, doc };
  }

  async markNoticeSent(itemId: string, agentId: string): Promise<void> {
    await this.collection.updateOne({ itemId, agentId }, { $set: { noticeSent: true } });
  }

  async pendingCount(): Promise<number> {
    return this.collection.countDocuments({ status: "pending" });
  }

  /** Drain-control re-read (§7.4 step 5 — Finding 7, review round 2). */
  async statusOf(itemId: string, agentId: string): Promise<OutageQueueStatus | null> {
    const doc = await this.collection.findOne({ itemId, agentId });
    return doc?.status ?? null;
  }

  /** §5-2c: mark over-age pending docs expired; returns them so the caller
   *  can group notify-policy docs by thread for the batched notice. */
  async expireOlderThan(cutoff: Date): Promise<OutageQueueDoc[]> {
    const docs = await this.collection.find({ status: "pending", enqueuedAt: { $lt: cutoff } }).toArray();
    if (docs.length === 0) return [];
    await this.collection.updateMany(
      { _id: { $in: docs.map((d) => d._id!) }, status: "pending" },
      { $set: { status: "expired", doneAt: this.now(), lastError: "expired before replay (maxAgeHours)" } },
    );
    return docs;
  }

  /** Boot recovery: crash between claim and release leaves `replaying` orphans. */
  async recoverStaleReplaying(staleMs: number = STALE_REPLAYING_MS): Promise<number> {
    const cutoff = new Date(this.now().getTime() - staleMs);
    const result = await this.collection.updateMany(
      { status: "replaying", lastAttemptAt: { $lt: cutoff } },
      { $set: { status: "pending" } },
    );
    if (result.modifiedCount > 0) {
      log.warn("Recovered stale replaying outage docs to pending", { count: result.modifiedCount });
    }
    return result.modifiedCount;
  }
}
```

- [ ] **Step 2.2:** Create `src/outage/outage-queue-store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { OutageQueueStore, type OutageQueueDoc, type OutageEnqueueInput } from "./outage-queue-store.js";
import type { Collection } from "mongodb";
import type { WorkItem } from "../types/work-item.js";

// ---------------------------------------------------------------------------
// In-memory fake of the exact driver surface OutageQueueStore uses.
// Same mock-the-driver approach as scheduler.test.ts / doctor-checks.test.ts.
// ---------------------------------------------------------------------------

function matches(doc: Record<string, any>, filter: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    const val = doc[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$lt" in cond && !(val !== null && val < cond.$lt)) return false;
      if ("$gte" in cond && !(val !== null && val >= cond.$gte)) return false;
      if ("$in" in cond && !(cond.$in as unknown[]).includes(val)) return false;
    } else if (val instanceof Date && cond instanceof Date) {
      if (val.getTime() !== cond.getTime()) return false;
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc: Record<string, any>, update: Record<string, any>): void {
  for (const [k, v] of Object.entries(update.$set ?? {})) doc[k] = v;
  for (const [k, v] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + (v as number);
}

class FakeOutageCollection {
  docs: Record<string, any>[] = [];
  private nextId = 1;

  async createIndex(): Promise<string> {
    return "ok";
  }

  async updateOne(filter: any, update: any, options?: { upsert?: boolean }) {
    const doc = this.docs.find((d) => matches(d, filter));
    if (doc) {
      applyUpdate(doc, update);
      return { matchedCount: 1, modifiedCount: 1 };
    }
    if (options?.upsert) {
      const fresh: Record<string, any> = { _id: `oid-${this.nextId++}` };
      // Equality filter fields become part of the inserted doc (Mongo upsert semantics).
      for (const [k, v] of Object.entries(filter)) {
        if (v === null || typeof v !== "object" || v instanceof Date) fresh[k] = v;
      }
      for (const [k, v] of Object.entries(update.$setOnInsert ?? {})) fresh[k] = v;
      for (const [k, v] of Object.entries(update.$set ?? {})) fresh[k] = v;
      this.docs.push(fresh);
      return { matchedCount: 0, modifiedCount: 0 };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async updateMany(filter: any, update: any) {
    let modifiedCount = 0;
    for (const doc of this.docs) {
      if (matches(doc, filter)) {
        applyUpdate(doc, update);
        modifiedCount++;
      }
    }
    return { modifiedCount };
  }

  async findOneAndUpdate(filter: any, update: any, options?: { sort?: Record<string, 1 | -1> }) {
    let candidates = this.docs.filter((d) => matches(d, filter));
    if (options?.sort) {
      const [[key, dir]] = Object.entries(options.sort);
      candidates = [...candidates].sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : 0));
    }
    const doc = candidates[0];
    if (!doc) return null;
    applyUpdate(doc, update);
    return { ...doc };
  }

  async findOne(filter: any) {
    const doc = this.docs.find((d) => matches(d, filter));
    return doc ? { ...doc } : null;
  }

  async countDocuments(filter: any) {
    return this.docs.filter((d) => matches(d, filter)).length;
  }

  find(filter: any) {
    const results = this.docs.filter((d) => matches(d, filter)).map((d) => ({ ...d }));
    return { toArray: async () => results };
  }
}

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "msg-1",
    text: "hello",
    source: { kind: "slack", id: "C1", label: "general" },
    sender: "user1",
    threadId: "t1",
    timestamp: new Date("2026-07-07T10:00:00Z"),
    ...overrides,
  };
}

function makeInput(overrides: Partial<OutageEnqueueInput> = {}): OutageEnqueueInput {
  return {
    itemId: "msg-1",
    agentId: "agent-a",
    provider: "claude",
    workItem: makeWorkItem(),
    policy: "notify",
    ...overrides,
  };
}

function makeStore(nowMs = Date.parse("2026-07-07T12:00:00Z")) {
  const fake = new FakeOutageCollection();
  let clock = nowMs;
  const store = new OutageQueueStore(fake as unknown as Collection<OutageQueueDoc>, () => new Date(clock));
  return { store, fake, advance: (ms: number) => (clock += ms) };
}

describe("OutageQueueStore (KPR-307)", () => {
  it("enqueue is idempotent on the composite (itemId, agentId) key", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput());
    await store.enqueue(makeInput()); // double-enqueue same agent → no-op
    expect(fake.docs).toHaveLength(1);
    expect(fake.docs[0]).toMatchObject({ itemId: "msg-1", agentId: "agent-a", status: "pending", attempts: 0 });
  });

  it("fan-out produces one independent doc per fanned agent for the same itemId", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput({ agentId: "agent-a" }));
    await store.enqueue(makeInput({ agentId: "agent-b" }));
    expect(fake.docs).toHaveLength(2);
    expect(fake.docs.map((d) => d.agentId).sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("claimNext returns oldest-enqueuedAt pending doc and marks it replaying (atomic — no double claim)", async () => {
    const { store, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "older" }));
    advance(60_000);
    await store.enqueue(makeInput({ itemId: "newer" }));

    const first = await store.claimNext();
    expect(first?.itemId).toBe("older");
    expect(first?.status).toBe("replaying");
    const second = await store.claimNext();
    expect(second?.itemId).toBe("newer"); // never the already-claimed doc
    expect(await store.claimNext()).toBeNull();
  });

  it("release: pending is non-terminal (attempts + doneAt untouched); done/expired are terminal with doneAt", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput());
    await store.claimNext();

    await store.release("msg-1", "agent-a", "pending", "circuit still open");
    expect(fake.docs[0]).toMatchObject({ status: "pending", attempts: 0, doneAt: null, lastError: "circuit still open" });

    await store.claimNext();
    await store.release("msg-1", "agent-a", "done");
    expect(fake.docs[0].status).toBe("done");
    expect(fake.docs[0].doneAt).toBeInstanceOf(Date);

    await store.enqueue(makeInput({ itemId: "msg-2" }));
    await store.release("msg-2", "agent-a", "expired", "agent disabled/deleted — will not be replayed");
    expect(fake.docs[1]).toMatchObject({ status: "expired", lastError: "agent disabled/deleted — will not be replayed" });
    expect(fake.docs[1].doneAt).toBeInstanceOf(Date);
  });

  it("recordFailedAttempt increments attempts → pending below cap, terminal failed at cap", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput());

    const a1 = await store.recordFailedAttempt("msg-1", "agent-a", "boom", 3);
    expect(a1).toMatchObject({ terminal: false });
    expect(fake.docs[0]).toMatchObject({ status: "pending", attempts: 1, lastError: "boom" });

    await store.recordFailedAttempt("msg-1", "agent-a", "boom", 3);
    const a3 = await store.recordFailedAttempt("msg-1", "agent-a", "boom again", 3);
    expect(a3.terminal).toBe(true);
    expect(a3.doc?.attempts).toBe(3);
    expect(fake.docs[0].status).toBe("failed");
    expect(fake.docs[0].doneAt).toBeInstanceOf(Date);
  });

  it("recordFailedAttempt truncates lastError to 240 chars", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput());
    await store.recordFailedAttempt("msg-1", "agent-a", "x".repeat(500), 3);
    expect(fake.docs[0].lastError).toHaveLength(240);
  });

  it("expireOlderThan marks and returns only over-age pending docs", async () => {
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "old-1" }));
    await store.enqueue(makeInput({ itemId: "old-2", agentId: "agent-b" }));
    advance(5 * 3600_000); // 5h later
    await store.enqueue(makeInput({ itemId: "fresh" }));

    const cutoff = new Date(Date.parse("2026-07-07T12:00:00Z") + 4 * 3600_000);
    const expired = await store.expireOlderThan(cutoff);
    expect(expired.map((d) => d.itemId).sort()).toEqual(["old-1", "old-2"]);
    expect(fake.docs.filter((d) => d.status === "expired")).toHaveLength(2);
    expect(fake.docs.find((d) => d.itemId === "fresh")?.status).toBe("pending");
    // Second pass: nothing left to expire.
    expect(await store.expireOlderThan(cutoff)).toEqual([]);
  });

  it("recoverStaleReplaying reverts only over-age replaying docs", async () => {
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "stale" }));
    await store.claimNext(); // replaying at T0
    advance(400_000); // > 360s stale threshold
    await store.enqueue(makeInput({ itemId: "fresh-claim" }));
    await store.claimNext(); // replaying at T0+400s (fresh)

    const recovered = await store.recoverStaleReplaying();
    expect(recovered).toBe(1);
    expect(fake.docs.find((d) => d.itemId === "stale")?.status).toBe("pending");
    expect(fake.docs.find((d) => d.itemId === "fresh-claim")?.status).toBe("replaying");
  });

  it("statusOf reads the composite-keyed doc", async () => {
    const { store } = makeStore();
    await store.enqueue(makeInput({ agentId: "agent-a" }));
    await store.enqueue(makeInput({ agentId: "agent-b" }));
    await store.release("msg-1", "agent-b", "done");
    expect(await store.statusOf("msg-1", "agent-a")).toBe("pending");
    expect(await store.statusOf("msg-1", "agent-b")).toBe("done");
    expect(await store.statusOf("nope", "agent-a")).toBeNull();
  });
});
```

- [ ] **Step 2.3:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts && npm run typecheck`
Expected: 9 tests pass, typecheck clean.

- [ ] **Step 2.4:** Commit

```bash
git add src/outage/outage-queue-store.ts src/outage/outage-queue-store.test.ts
git commit -m "KPR-307: outage_queue store — composite (itemId,agentId) key, claim/release/expire/recover"
```

### Task 3: Notices, source policy, episode tracker

**Files:**
- Create: `src/outage/outage-notices.ts`
- Test: `src/outage/outage-notices.test.ts`

- [ ] **Step 3.1:** Create `src/outage/outage-notices.ts`:

```typescript
/**
 * KPR-307: honest-outage notice templates (§5-1b — ⚠ wording delegated,
 * structure decided; exported constants so tests pin them), the §5-3a source
 * policy table, and the outage-episode tracker (§7.3).
 */
import type { WorkItem, ChannelKind } from "../types/work-item.js";

// ---------------------------------------------------------------------------
// Source policy (§5-3a). Prefix-detected on engine-synthesized ids — formats
// are fixed in scheduler.ts (sched:/callback:/event:/team-). Known caveat
// (spec Finding 7 r1, ⚠ §10): ws/app ids are client-supplied; a client id
// that collides with a reserved prefix would misclassify. Accepted at spec
// time; the meta.outagePolicy variant remains the documented alternative.
// ---------------------------------------------------------------------------

export type OutageSourcePolicy = "notify" | "silent" | "skip";

export function policyFor(item: WorkItem): OutageSourcePolicy {
  const id = item.id;
  if (id.startsWith("sched:")) return "skip"; // cron re-fires at the next match — queueing would double-run
  if (id.startsWith("callback:")) return "silent"; // one-shot, marked fired pre-dispatch — queue preserves it
  if (id.startsWith("event:")) return "silent";
  if (id.startsWith("team-")) return "silent";
  return "notify"; // human channels: slack, sms, imessage, app/ws, team DM
}

export function adapterKeyFor(item: WorkItem): string {
  return item.source.adapterId ?? item.source.kind;
}

/** SMS has no threads — notice dedup keys on `threadId ?? sender` (§5-1b). */
export function threadKeyFor(item: WorkItem): string {
  return item.threadId ?? item.sender;
}

// ---------------------------------------------------------------------------
// Notice templates. Plain-text WorkResults with `error` UNSET — result.error
// triggers formatError on Slack, a delivery SKIP on SMS/iMessage, and a raw
// Error frame on WS. No retry-time promises (retryAfterMs is probe cadence,
// not a recovery ETA).
// ---------------------------------------------------------------------------

export const OUTAGE_NOTICE_DEFAULT =
  "⚠️ I can't reach my AI service right now (provider outage). Your message is saved — I'll answer it automatically as soon as service is back.";
export const OUTAGE_NOTICE_SMS =
  "Our AI assistant is temporarily down. Your message is saved and you'll get a reply when service returns.";
export const OUTAGE_OVERFLOW_NOTICE_DEFAULT =
  "⚠️ I can't reach my AI service right now — and I can't even save your message right now. Please re-send it later.";
export const OUTAGE_OVERFLOW_NOTICE_SMS =
  "Our AI assistant is temporarily down and your message could not be saved. Please re-send it later.";
/** §5-1b voice: spoken as a normal completion — never a bare 500/503 (dead air to Vapi). */
export const VOICE_OUTAGE_SPOKEN_NOTICE =
  "I'm having trouble reaching my AI service right now — please try again in a few minutes.";

export function outageNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage" ? OUTAGE_NOTICE_SMS : OUTAGE_NOTICE_DEFAULT;
}

export function overflowNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage" ? OUTAGE_OVERFLOW_NOTICE_SMS : OUTAGE_OVERFLOW_NOTICE_DEFAULT;
}

/** §5-2g terminal failure — plain text (the normal error path is swallowed by SMS/iMessage). */
export function terminalFailureNotice(enqueuedAt: Date): string {
  return `I still can't reach my AI service after several tries — your message from ${formatNoticeTime(enqueuedAt)} could not be answered. Please re-send it.`;
}

/** §5-2c-ii batched per-thread expiry notice, delivered at drain time. */
export function expiryNotice(count: number): string {
  return `Service is back — I couldn't get to ${count} earlier message${count === 1 ? "" : "s"} from during the outage. Please re-send anything still needed.`;
}

/**
 * §5-2d replayed-turn presentation: prompt-note, not hard text prefix — the
 * model handles phrasing, staleness, and the re-ask-dedup case in its own voice.
 */
export function replayWrap(originalText: string, receivedAt: Date, policy: "notify" | "silent"): string {
  const note =
    policy === "notify"
      ? `[This message was received at ${formatNoticeTime(receivedAt)} during an AI service outage and is being replayed now. Acknowledge the delay briefly if a human sent it.]`
      : `[Replayed after an AI service outage; originally received ${formatNoticeTime(receivedAt)}.]`;
  return `${note}\n\n${originalText}`;
}

function formatNoticeTime(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// Episode tracker (§7.3). Outage episode ≠ breaker openedAt — openedAt
// advances on every failed probe (~every 15-60s), so keying notice dedup on
// it would re-notify every probe cycle. In-memory; restart worst case = one
// repeated notice per thread.
// ---------------------------------------------------------------------------

export class OutageEpisodeTracker {
  private episodes = new Map<string, number>(); // provider → episodeId
  private noticed = new Set<string>(); // `${provider}:${episodeId}:${adapterKey}:${threadKey}`
  private nextEpisodeId = 1;

  /** Begin (or join) the provider's episode. Returns true when this call began it. */
  begin(provider: string): boolean {
    if (this.episodes.has(provider)) return false;
    this.episodes.set(provider, this.nextEpisodeId++);
    return true;
  }

  /**
   * True exactly once per (provider-episode, adapter, thread). SYNCHRONOUS
   * test-and-set — a single has+add with no await between check and mark:
   * fanned-out agents fast-fail concurrently under Promise.all, and two
   * "first" observations would double-notify one thread (Finding 8 r1;
   * normative constraint, spec §7.3).
   */
  firstForThread(provider: string, adapterKey: string, threadKey: string): boolean {
    let episode = this.episodes.get(provider);
    if (episode === undefined) {
      episode = this.nextEpisodeId++;
      this.episodes.set(provider, episode);
    }
    const key = `${provider}:${episode}:${adapterKey}:${threadKey}`;
    if (this.noticed.has(key)) return false;
    this.noticed.add(key);
    return true;
  }

  hasActiveEpisode(provider: string): boolean {
    return this.episodes.has(provider);
  }

  /**
   * Episode end (caller gates on `stateFor(provider)?.state !== "open"` at
   * the moment the successful turn completes — Finding 3 r1). Prunes the
   * ended episode's notice keys, so growth is bounded by threads-per-episode.
   */
  clear(provider: string): void {
    const episode = this.episodes.get(provider);
    if (episode === undefined) return;
    this.episodes.delete(provider);
    const prefix = `${provider}:${episode}:`;
    for (const key of this.noticed) {
      if (key.startsWith(prefix)) this.noticed.delete(key);
    }
  }
}
```

- [ ] **Step 3.2:** Create `src/outage/outage-notices.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  OutageEpisodeTracker,
  policyFor,
  adapterKeyFor,
  threadKeyFor,
  outageNoticeFor,
  overflowNoticeFor,
  terminalFailureNotice,
  expiryNotice,
  replayWrap,
  OUTAGE_NOTICE_DEFAULT,
  OUTAGE_NOTICE_SMS,
} from "./outage-notices.js";
import type { WorkItem } from "../types/work-item.js";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "msg-1",
    text: "hello",
    source: { kind: "slack", id: "C1", label: "general" },
    sender: "user1",
    threadId: "t1",
    timestamp: new Date(),
    ...overrides,
  };
}

describe("policyFor (§5-3a source policy table)", () => {
  it("skips cron turns (sched: prefix — re-fires by design)", () => {
    expect(policyFor(item({ id: "sched:agent-a:daily:123" }))).toBe("skip");
  });
  it("queues system one-shots silently (callback:/event:/team- prefixes)", () => {
    expect(policyFor(item({ id: "callback:65a1b2" }))).toBe("silent");
    expect(policyFor(item({ id: "event:65a1b2:agent-a" }))).toBe("silent");
    expect(policyFor(item({ id: "team-65a1b2" }))).toBe("silent");
  });
  it("notifies human channels: slack, sms, imessage, app/ws, team DM", () => {
    expect(policyFor(item({ source: { kind: "slack", id: "C1", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "sms", id: "+1555", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "imessage", id: "+1555", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "app", id: "dev-1", label: "x" } }))).toBe("notify");
    expect(policyFor(item({ source: { kind: "team", id: "dm:agent-a", label: "x" } }))).toBe("notify");
  });
});

describe("keys", () => {
  it("adapterKeyFor prefers adapterId over kind", () => {
    expect(adapterKeyFor(item({ source: { kind: "sms", id: "x", label: "x", adapterId: "sms-line-2" } }))).toBe("sms-line-2");
    expect(adapterKeyFor(item())).toBe("slack");
  });
  it("threadKeyFor falls back to sender (SMS has no threads — per-sender key)", () => {
    expect(threadKeyFor(item({ threadId: undefined, sender: "+15551234" }))).toBe("+15551234");
    expect(threadKeyFor(item())).toBe("t1");
  });
});

describe("templates", () => {
  it("selects SMS/iMessage vs default variants", () => {
    expect(outageNoticeFor("sms")).toBe(OUTAGE_NOTICE_SMS);
    expect(outageNoticeFor("imessage")).toBe(OUTAGE_NOTICE_SMS);
    expect(outageNoticeFor("slack")).toBe(OUTAGE_NOTICE_DEFAULT);
    expect(outageNoticeFor("app")).toBe(OUTAGE_NOTICE_DEFAULT);
    expect(overflowNoticeFor("sms")).toContain("could not be saved");
    expect(overflowNoticeFor("slack")).toContain("can't even save");
  });
  it("terminal + expiry notices carry the operative facts", () => {
    expect(terminalFailureNotice(new Date())).toContain("could not be answered");
    expect(expiryNotice(1)).toContain("1 earlier message from");
    expect(expiryNotice(3)).toContain("3 earlier messages from");
  });
  it("replayWrap: notify variant asks for a delay acknowledgment; silent variant is minimal", () => {
    const notify = replayWrap("original question", new Date(), "notify");
    expect(notify).toMatch(/^\[This message was received at .* during an AI service outage/);
    expect(notify).toContain("Acknowledge the delay briefly");
    expect(notify.endsWith("original question")).toBe(true);
    const silent = replayWrap("do the thing", new Date(), "silent");
    expect(silent).toMatch(/^\[Replayed after an AI service outage/);
    expect(silent).not.toContain("Acknowledge");
  });
});

describe("OutageEpisodeTracker (§7.3)", () => {
  it("episode lifecycle: notice once per thread → silent repeats → clear → next outage notices again", () => {
    const tracker = new OutageEpisodeTracker();
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(true);
    // Repeat turns during the same episode — including across breaker probe
    // cycles (the tracker never reads openedAt, so probe churn can't re-notice).
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(false);
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(false);
    // A different thread in the same episode gets its own single notice.
    expect(tracker.firstForThread("claude", "slack", "t2")).toBe(true);

    tracker.clear("claude");
    expect(tracker.hasActiveEpisode("claude")).toBe(false);
    // Next outage = new episode → notices again.
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(true);
  });

  it("synchronous test-and-set: two immediate calls yield exactly one true (fan-out race)", () => {
    const tracker = new OutageEpisodeTracker();
    const results = [
      tracker.firstForThread("claude", "slack", "t1"),
      tracker.firstForThread("claude", "slack", "t1"),
    ];
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("episodes are per-provider; clear only prunes the cleared provider's keys", () => {
    const tracker = new OutageEpisodeTracker();
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(true);
    expect(tracker.firstForThread("gemini", "slack", "t1")).toBe(true);
    tracker.clear("claude");
    expect(tracker.firstForThread("gemini", "slack", "t1")).toBe(false); // gemini episode intact
    expect(tracker.firstForThread("claude", "slack", "t1")).toBe(true); // fresh claude episode
  });

  it("begin() reports episode start exactly once", () => {
    const tracker = new OutageEpisodeTracker();
    expect(tracker.begin("claude")).toBe(true);
    expect(tracker.begin("claude")).toBe(false);
    tracker.clear("claude");
    expect(tracker.begin("claude")).toBe(true);
  });
});
```

- [ ] **Step 3.3:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-notices.test.ts && npm run typecheck`
Expected: all tests pass, typecheck clean.

- [ ] **Step 3.4:** Commit

```bash
git add src/outage/outage-notices.ts src/outage/outage-notices.test.ts
git commit -m "KPR-307: outage notices, source-policy table, episode tracker (sync test-and-set)"
```

### Task 4: Agent-manager additive surface (`providerFor`, TurnResult propagation)

**Files:**
- Modify: `src/agents/agent-manager.ts`
- Test: `src/agents/agent-manager.test.ts` (extend)

- [ ] **Step 4.1:** Add two optional fields to the `TurnResult` interface (anchor: `grep -n "export interface TurnResult" src/agents/agent-manager.ts`), after the existing telemetry-shape fields:

```typescript
  /**
   * KPR-307: propagated from RunResult.timedOut (KPR-306 — runner deadline
   * fired). Consumed by the dispatcher's post-turn outage gate: a hang-type
   * timeout leaves `errors` empty (the abort path returns before a provider
   * error string is captured), so the flag is the only signal.
   */
  timedOut?: boolean;
  /** KPR-307: propagated from RunResult.aborted (operator abort or deadline abort). */
  aborted?: boolean;
```

- [ ] **Step 4.2:** In `finalizeSpawnResult` (anchor: `grep -n "private finalizeSpawnResult" src/agents/agent-manager.ts`), add both fields to the returned object (next to `ephemeral1hTokens`):

```typescript
      ephemeral5mTokens: result.ephemeral5mTokens,
      ephemeral1hTokens: result.ephemeral1hTokens,
      timedOut: result.timedOut,
      aborted: result.aborted,
```

- [ ] **Step 4.3:** Add the `providerFor` helper to `AgentManager` (place next to the KPR-306 `circuitBreakers` field's consumers — e.g. immediately after `runWorkItemTurn`). Import `AgentProviderId` if not already imported: `import type { AgentProviderId } from "./provider-adapters/types.js";`

```typescript
  /**
   * KPR-307: the provider an agent's turns route to — additive read-only
   * surface for the dispatcher's post-turn outage gate. One-liner over the
   * same resolveProviderModel the KPR-306 wrap point uses, so dispatcher and
   * breaker always agree on the provider key.
   */
  providerFor(agentId: string): AgentProviderId | null {
    const agentConfig = this.registry.get(agentId);
    if (!agentConfig) return null;
    return resolveProviderModel(agentConfig.model).provider;
  }
```

- [ ] **Step 4.4:** Extend `src/agents/agent-manager.test.ts`. Place a new describe nested inside the existing `spawnTurn (KPR-216)` describe (same placement constraint as KPR-306's wrap-point suite: `smsCtx` is a local function of that describe; `makeRunResult`/`mockRunnerSend`/`manager` are available there):

```typescript
    describe("providerFor + TurnResult timedOut/aborted propagation (KPR-307)", () => {
      it("providerFor maps bare model → claude, prefixed → provider, unknown agent → null", () => {
        // agent-a's fixture model is a bare id → claude (re-confirm fixture name at HEAD).
        expect(manager.providerFor("agent-a")).toBe("claude");
        expect(manager.providerFor("no-such-agent")).toBeNull();
      });

      it("spawnTurn's TurnResult carries timedOut/aborted from RunResult", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ timedOut: true, aborted: true }));
        const result = await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr307-timeout" }));
        expect(result.timedOut).toBe(true);
        expect(result.aborted).toBe(true);
      });

      it("healthy turns leave timedOut/aborted falsy", async () => {
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({}));
        const result = await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr307-clean" }));
        expect(result.timedOut ?? false).toBe(false);
        expect(result.aborted ?? false).toBe(false);
      });
    });
```

For the prefixed-provider assertion, if the existing registry mock makes per-agent model overrides awkward, add one fixture agent with `model: "gemini/gemini-2.5-pro"` to the test registry and assert `manager.providerFor(<that id>)` is `"gemini"`; otherwise assert via a registry-stubbed `get` — follow the file's existing fixture pattern at HEAD.

- [ ] **Step 4.5:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts && npm run typecheck`
Expected: existing suites green + 3 new tests pass.

- [ ] **Step 4.6:** Commit

```bash
git add src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "KPR-307: additive providerFor() + TurnResult.timedOut/aborted propagation"
```

### Task 5: Dispatcher interception (the core)

**Files:**
- Modify: `src/channels/dispatcher.ts`
- Test: `src/channels/dispatcher.test.ts` (extend)

All anchors below are semantic — the KPR-306 merge will have shifted line numbers. Re-locate each region by the grep patterns in Task 0 (C1–C10) before editing.

- [ ] **Step 5.1:** Add imports at the top of `dispatcher.ts`:

```typescript
import { ProviderCircuitOpenError } from "../agents/provider-circuit-breaker.js";
import { classifyTurnResult, HARD_FAULT_KINDS } from "../agents/provider-adapters/error-classification.js";
import type { OutageQueueStore, OutageQueueConfig } from "../outage/outage-queue-store.js";
import {
  OutageEpisodeTracker,
  adapterKeyFor,
  outageNoticeFor,
  overflowNoticeFor,
  policyFor,
  terminalFailureNotice,
  threadKeyFor,
} from "../outage/outage-notices.js";
```

- [ ] **Step 5.2:** Add the outage seam (field + setter) next to `setRetryQueue`:

```typescript
export interface OutageHandlingDeps {
  store: OutageQueueStore;
  episodes: OutageEpisodeTracker;
  config: OutageQueueConfig;
}
```

(exported from `dispatcher.ts`, above the `Dispatcher` class) and inside the class:

```typescript
  private outage?: OutageHandlingDeps;
```

```typescript
  /**
   * KPR-307: wire honest-outage handling. Never called when
   * `config.outageQueue.enabled` is false — in that case every path below is
   * dormant and behavior is identical to post-KPR-306 raw error surfacing.
   */
  setOutageHandling(deps: OutageHandlingDeps): void {
    this.outage = deps;
  }
```

- [ ] **Step 5.3:** Dedup bypass (C1). Change the step-0 condition in `dispatch()`:

```typescript
    // 0. Deduplicate — if two adapters see the same Slack message, only process it once.
    //    KPR-307: outage replays are engine-authored redispatches of the ORIGINAL
    //    item id (no synthetic per-attempt id — Finding 1 r1: §5-2g doesn't count
    //    fast-fails, so a synthetic id would repeat and dedup would silently drop
    //    every replay after the first). Dedup exists for externally-duplicated
    //    deliveries; a replay has nothing to dedup against — bypass it.
    if (this.recentMessageIds.has(item.id) && !item.meta?.outageReplay) {
      log.debug("Duplicate message skipped", { id: item.id, source: item.source.adapterId });
      return;
    }
```

- [ ] **Step 5.4:** Pinned-agent-only replay resolution (covers BOTH early-return shapes — C4/C5 — with no fall-through). Insert immediately after the status-interception block and before the `resolveAgents` call:

```typescript
    // KPR-307 (§7.2, Finding 6 r2): a replay resolves ONLY via its pinned
    // agent. If the pinned agent was deleted (resolveAgents step 0 would fall
    // through to name/channel matching — a substitute must NOT answer) or
    // disabled (the disabled filter would return empty), the queued doc
    // terminates as `expired`. This single pre-check subsumes both
    // early-return paths for replay items; non-replay items are untouched.
    if (this.outage && item.meta?.outageReplay) {
      const pinnedId = item.meta.targetAgentId as string | undefined;
      const pinned = pinnedId ? this.registry.get(pinnedId) : undefined;
      if (!pinned || pinned.disabled) {
        log.warn("Outage replay expired — pinned agent deleted or disabled", {
          itemId: item.id,
          agentId: pinnedId,
        });
        if (pinnedId) {
          await this.outage.store
            .release(item.id, pinnedId, "expired", "agent disabled/deleted — will not be replayed")
            .catch((err) => log.error("Outage replay expire-release failed", { error: String(err) }));
        }
        return;
      }
    }
```

- [ ] **Step 5.5:** Rework the main dispatch body (C6/C2). In `dispatch()`'s step-4 `try` block, insert the two guards after `convertTurnResult`, add success bookkeeping after the deliver/suppress branch, and replace the catch body with the extracted helper:

```typescript
    await adapter?.onProcessingStart?.(item, agentId);
    try {
      const runResult = this.convertTurnResult(await this.agentManager.runWorkItemTurn(agentId, item));

      // KPR-307 (§7.2 second leg): a COMPLETED turn with a hard provider fault
      // — or a hang-type timeout — while this provider's breaker is open is a
      // probe-failure / trip-crossing turn: queue + notice instead of
      // delivering "Something went wrong: …" or a bare "_No response._".
      if (await this.maybeHandlePostTurnOutage(item, agentId, adapter, runResult)) {
        return;
      }

      // KPR-307 (§5-2g): a replay attempt that errored with the breaker
      // CLOSED is a real failure — attempts+1, terminal `failed` at the cap
      // (with a plain-text notice on notify policy). The raw error result is
      // never delivered for a replay item: SMS/iMessage would swallow it and
      // Slack would spam one per attempt.
      // Deliberate: this also fires with the breaker still OPEN when the
      // result classifies as `non-provider` (maybeHandlePostTurnOutage above
      // only handles HARD_FAULT_KINDS) — a tool error is outage-independent,
      // so it counts as a real attempt regardless of breaker state.
      if (this.outage && item.meta?.outageReplay && runResult.error) {
        await this.resolveReplayRealFailure(item, agentId, adapter, runResult.error);
        return;
      }

      const trimmedText = runResult.text.trim();
      // ... existing isNonResponse check + deliver/taskLedger/audit/log block — UNCHANGED ...

      // KPR-307: success bookkeeping — replay doc → done (delivered OR
      // non-response-suppressed: the model chose not to answer, nothing left
      // to redeliver); episode ends only while this provider's breaker is
      // observed not-open at this moment (Finding 3 r1 — a pre-trip turn
      // landing after the trip must not clear the episode mid-outage).
      if (!runResult.error) {
        await this.recordTurnSuccess(item, agentId);
      }
    } catch (err) {
      await this.handleTurnFailure(err, item, agentId, adapter);
    } finally {
      await adapter?.onProcessingEnd?.(item, agentId);
    }
```

The existing `isNonResponse`/deliver block between the guards and the success hook is carried verbatim; only the catch body is deleted (moved into `handleTurnFailure`).

- [ ] **Step 5.6:** Apply the identical rework to `dispatchToAgent` (fan-out body, C3): same two guards after its `convertTurnResult`, same `recordTurnSuccess` call after its deliver/suppress branch (use `effectiveItem`), and its catch body replaced with `await this.handleTurnFailure(err, effectiveItem, agentId, adapter);`. The fan-out catch previously lacked the delivery-failure warn log — the shared helper adds it (strictly more logging, no behavior change).

- [ ] **Step 5.7:** Update `convertTurnResult` (C7) — replace the hardcoded `aborted: false` and its stale comment:

```typescript
      error: turn.errors[0],
      // KPR-307: aborted/timedOut ARE now read downstream — the post-turn
      // outage gate classifies `timedOut && aborted` as a hang-type provider
      // fault (the pre-KPR-307 hardcoded `aborted: false` claimed "never read
      // downstream"; that stopped being true here).
      aborted: turn.aborted ?? false,
      timedOut: turn.timedOut,
```

(`RunResult.timedOut` exists post-KPR-306; it is optional, so this mapping is additive.)

- [ ] **Step 5.8:** Add the KPR-307 helper block to the `Dispatcher` class (place after `convertTurnResult`):

```typescript
  // -------------------------------------------------------------------------
  // KPR-307: honest outage behavior — interception, notices, replay outcomes.
  // Every branch below is a no-op when setOutageHandling was never called.
  // -------------------------------------------------------------------------

  /**
   * Shared failure handler — extracted from the two near-duplicate catch
   * bodies (pre-existing debt this change would otherwise triple). §7.2
   * classification:
   *   - ProviderCircuitOpenError            → outage path (provider from err)
   *   - thrown legacy error on a replay     → release doc → pending, attempts
   *     unchanged (transient resource contention — e.g. "Spawn budget
   *     exceeded" — is not a provider verdict; Finding 2 r2: without this the
   *     doc strands in `replaying` forever), then today's error delivery
   *   - everything else                     → today's error path, unchanged.
   */
  private async handleTurnFailure(
    err: unknown,
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
  ): Promise<void> {
    if (this.outage) {
      if (err instanceof ProviderCircuitOpenError) {
        const handled = await this.handleOutageTurn(item, agentId, adapter, err.provider);
        if (handled) return;
      } else if (item.meta?.outageReplay) {
        await this.outage.store
          .release(item.id, agentId, "pending", String(err))
          .catch((releaseErr) => log.error("Outage replay release failed", { error: String(releaseErr) }));
      }
    }

    const errorResult: WorkResult = {
      text: `Something went wrong: ${String(err)}`,
      agentId,
      workItem: item,
      costUsd: 0,
      durationMs: 0,
      error: String(err),
    };
    if (adapter) {
      try {
        await adapter.deliver(errorResult);
      } catch (deliverErr) {
        log.warn("Error delivery failed, queuing for retry", { error: String(deliverErr) });
        this.retryQueue?.enqueue(errorResult, adapter);
      }
    }
    log.error("Dispatch failed", { agentId, error: String(err) });
  }

  /**
   * §7.2 second classification leg (post-turn gate): the turn COMPLETED but
   * the provider's breaker is open. Fires when the result classifies into
   * HARD_FAULT_KINDS OR `timedOut && aborted` (Finding 3 r2 — a runner-
   * deadline timeout typically leaves `error` unset, so `errors` alone never
   * fires for hang-type outages). Gated on snapshot.enabled so shadow mode
   * stays fully observational. A `non-provider` classification with the
   * breaker coincidentally open follows the LEGACY path — a partially-
   * executed tool turn's side effects must not be silently re-run
   * (Finding 4 r1).
   */
  private async maybeHandlePostTurnOutage(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    runResult: RunResult,
  ): Promise<boolean> {
    const outage = this.outage;
    if (!outage) return false;
    if (!runResult.error && runResult.timedOut !== true) return false; // healthy turn — cheap exit

    const provider = this.agentManager.providerFor(agentId);
    if (!provider) return false;
    const snapshot = this.agentManager.circuitBreakers.stateFor(provider);
    if (!snapshot || snapshot.state !== "open" || snapshot.enabled !== true) return false;

    const classification = classifyTurnResult({
      error: runResult.error,
      timedOut: runResult.timedOut,
      aborted: runResult.aborted,
    });
    const hardFault = classification.outcome === "fault" && HARD_FAULT_KINDS.has(classification.kind);
    const hangTimeout = runResult.timedOut === true && runResult.aborted === true;
    if (!hardFault && !hangTimeout) return false;

    return this.handleOutageTurn(item, agentId, adapter, provider);
  }

  /**
   * §7.2 outage path. Returns true when the turn was fully handled (queued /
   * released / skipped / overflow-noticed); false only on a store failure —
   * the caller then falls back to the legacy error path rather than dropping
   * the turn with no user-visible signal at all.
   */
  private async handleOutageTurn(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    provider: string,
  ): Promise<boolean> {
    const outage = this.outage;
    if (!outage) return false;

    const policy = policyFor(item);
    if (policy === "skip") {
      log.info("Outage fast-fail skipped — cron turn re-fires at next match", { agentId, provider });
      return true;
    }

    if (outage.episodes.begin(provider)) {
      // Sustained-condition discipline (§7.6): one warn per episode start.
      log.warn("Outage episode began — provider circuit open, queueing turns for replay", { provider, agentId });
    }

    // Release-before-depth ordering (Finding 1 r2): a replayed fast-fail
    // already holds a queue slot — depth is irrelevant to it. It must resolve
    // the existing doc, never take the overflow branch and strand `replaying`.
    if (item.meta?.outageReplay) {
      await outage.store
        .release(item.id, agentId, "pending")
        .catch((err) => log.error("Outage replay pending-release failed", { error: String(err) }));
      log.info("Outage replay fast-failed again — back to pending, attempts unchanged", {
        provider,
        agentId,
      });
      return true;
    }

    try {
      const depth = await outage.store.pendingCount();
      if (depth >= outage.config.maxDepth) {
        // §5-2f: honest about the drop — drop-oldest would silently break
        // promises already made to other threads.
        log.warn("Outage queue at max depth — turn NOT queued", {
          depth,
          maxDepth: outage.config.maxDepth,
          agentId,
          provider,
        });
        // Advisory 3 (plan review round 1): one overflow notice per thread
        // per episode, not one per overflowed message — a chatty outage with
        // a full queue would otherwise cost one SMS per dropped message.
        // Reuses the episode tracker's synchronous test-and-set with a
        // suffixed adapter key so this dedup key never collides with the
        // queued-turn notice's own key on the same thread/episode.
        if (
          policy === "notify" &&
          outage.episodes.firstForThread(provider, `${adapterKeyFor(item)}:overflow`, threadKeyFor(item))
        ) {
          await this.deliverOutageNotice(item, agentId, adapter, overflowNoticeFor(item.source.kind));
        }
        return true;
      }

      await outage.store.enqueue({ itemId: item.id, agentId, provider, workItem: item, policy });
    } catch (storeErr) {
      log.error("Outage enqueue failed — falling back to legacy error path", { error: String(storeErr) });
      return false;
    }

    if (policy === "notify" && outage.episodes.firstForThread(provider, adapterKeyFor(item), threadKeyFor(item))) {
      await this.deliverOutageNotice(item, agentId, adapter, outageNoticeFor(item.source.kind));
      outage.store.markNoticeSent(item.id, agentId).catch(() => {});
    } else if (policy === "silent") {
      log.info("Outage turn queued silently (system one-shot)", { agentId, provider });
    }
    return true;
  }

  /**
   * §5-2g "real failure" row: replay errored while the breaker is closed —
   * attempts+1; terminal `failed` at maxReplayAttempts delivers a plain-text
   * notice on notify policy (Finding 6 r1: the normal error path sets
   * `result.error`, which SMS/iMessage silently skip). Silent-policy items
   * fail without a notice, consistent with their enqueue-time silence.
   */
  private async resolveReplayRealFailure(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    error: string,
  ): Promise<void> {
    const outage = this.outage;
    if (!outage) return;
    const { terminal, doc } = await outage.store.recordFailedAttempt(
      item.id,
      agentId,
      error,
      outage.config.maxReplayAttempts,
    );
    log.error("Outage replay attempt failed (breaker closed)", {
      agentId,
      attempts: doc?.attempts,
      terminal,
    });
    if (terminal && doc?.policy === "notify") {
      await this.deliverOutageNotice(item, agentId, adapter, terminalFailureNotice(doc.enqueuedAt));
    }
  }

  /** Success bookkeeping: replay → done; episode-end gate (Finding 3 r1). */
  private async recordTurnSuccess(item: WorkItem, agentId: string): Promise<void> {
    const outage = this.outage;
    if (!outage) return;
    if (item.meta?.outageReplay) {
      await outage.store
        .release(item.id, agentId, "done")
        .catch((err) => log.error("Outage replay done-release failed", { error: String(err) }));
    }
    const provider = this.agentManager.providerFor(agentId);
    if (provider && outage.episodes.hasActiveEpisode(provider)) {
      const snapshot = this.agentManager.circuitBreakers.stateFor(provider);
      if (snapshot?.state !== "open") {
        outage.episodes.clear(provider);
        log.info("Outage episode ended — provider recovered", { provider });
      }
    }
  }

  /**
   * Plain-text outage notice: `error` deliberately UNSET so every adapter
   * actually delivers it (`result.error` → formatError on Slack, delivery
   * SKIP on SMS/iMessage, raw Error frame on WS — zero adapter changes).
   * Delivery failure → existing retry queue, like any message. Public: the
   * replay processor uses it for batched expiry notices.
   */
  async deliverOutageNotice(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    text: string,
  ): Promise<void> {
    const target = adapter ?? this.adapters.get(item.source.adapterId ?? item.source.kind);
    if (!target) {
      log.warn("Outage notice has no adapter — dropped", { agentId, source: item.source.kind });
      return;
    }
    const notice: WorkResult = { text, agentId, workItem: item, costUsd: 0, durationMs: 0 };
    try {
      await target.deliver(notice);
    } catch (err) {
      log.warn("Outage notice delivery failed, queuing for retry", { error: String(err) });
      this.retryQueue?.enqueue(notice, target);
    }
  }
```

Log-redaction note (§7.6): none of the new log lines carry message text or previews — notice templates are static exported constants, referenced by content only in tests.

- [ ] **Step 5.9:** Extend `src/channels/dispatcher.test.ts`. Extend `makeMockAgentManager` with the two new surfaces:

```typescript
    providerFor: vi.fn().mockReturnValue("claude"),
    circuitBreakers: { stateFor: vi.fn().mockReturnValue(null) },
```

and append a new top-level describe:

```typescript
// ---------------------------------------------------------------------------
// KPR-307: honest outage behavior
// ---------------------------------------------------------------------------

import { ProviderCircuitOpenError } from "../agents/provider-circuit-breaker.js";
import {
  OutageEpisodeTracker,
  OUTAGE_NOTICE_DEFAULT,
  OUTAGE_OVERFLOW_NOTICE_DEFAULT,
} from "../outage/outage-notices.js";

function makeCircuitOpenError(provider = "claude") {
  return new ProviderCircuitOpenError(provider as never, Date.now(), 15_000, "connect-fail", "fetch failed");
}

function makeOutageStore() {
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    recordFailedAttempt: vi.fn().mockResolvedValue({ terminal: false, doc: null }),
    markNoticeSent: vi.fn().mockResolvedValue(undefined),
    pendingCount: vi.fn().mockResolvedValue(0),
    statusOf: vi.fn().mockResolvedValue(null),
    expireOlderThan: vi.fn().mockResolvedValue([]),
    recoverStaleReplaying: vi.fn().mockResolvedValue(0),
    ensureIndexes: vi.fn().mockResolvedValue(undefined),
  };
}

const OUTAGE_CONFIG = {
  enabled: true,
  replayIntervalMs: 15_000,
  maxAgeHours: 4,
  maxDepth: 500,
  maxReplayAttempts: 3,
};

function makeTurn(overrides: Record<string, unknown> = {}) {
  return {
    finalMessage: "turn response",
    newSessionId: "s2",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 0,
      costUsd: 0.01,
      durationMs: 800,
    },
    errors: [] as string[],
    llmMs: 0,
    toolMs: 0,
    toolCalls: 0,
    toolSummary: null,
    streamed: false,
    compactions: 0,
    ...overrides,
  };
}

describe("outage interception (KPR-307)", () => {
  let dispatcher: Dispatcher;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;
  let store: ReturnType<typeof makeOutageStore>;
  let episodes: OutageEpisodeTracker;

  beforeEach(() => {
    agentManager = makeMockAgentManager();
    adapter = makeMockAdapter();
    store = makeOutageStore();
    episodes = new OutageEpisodeTracker();
    dispatcher = new Dispatcher(
      makeMockRegistry() as never,
      agentManager as never,
      makeMockHealthReporter() as never,
      "executive-assistant",
    );
    dispatcher.registerAdapter(adapter as never);
    dispatcher.setOutageHandling({ store: store as never, episodes, config: OUTAGE_CONFIG });
  });

  // Route to the dedicated channel of the default enabled agent so resolution
  // is deterministic (mock registry: executive-assistant owns "general").
  function slackItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return makeWorkItem({ source: { kind: "slack", id: "C999", label: "general" }, ...overrides });
  }

  function replayItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return slackItem({
      meta: { outageReplay: true, targetAgentId: "executive-assistant" },
      ...overrides,
    });
  }

  it("instanceof path: queues + delivers a plain-text notice with error UNSET (SMS-skip regression guard)", async () => {
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));

    expect(store.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "m1", agentId: "executive-assistant", provider: "claude", policy: "notify" }),
    );
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    const delivered = adapter.deliver.mock.calls[0][0];
    expect(delivered.text).toBe(OUTAGE_NOTICE_DEFAULT);
    expect(delivered.error).toBeUndefined();
  });

  it("once per thread per episode: follow-up turns queue silently, a second thread notices once", async () => {
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    await dispatcher.dispatch(slackItem({ id: "m2", threadId: "t1" }));
    await dispatcher.dispatch(slackItem({ id: "m3", threadId: "t2" }));

    expect(store.enqueue).toHaveBeenCalledTimes(3);
    expect(adapter.deliver).toHaveBeenCalledTimes(2); // t1 once, t2 once
  });

  it("post-turn open-state path: errored TurnResult + open enabled snapshot → outage path, no error delivery", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn({ errors: ["connect ECONNREFUSED api"] }));
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });

    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledTimes(1);
    // Only the notice was delivered — never the "Something went wrong"/error result.
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
  });

  it("non-provider classification while open → legacy error path, unqueued (Finding 4 r1)", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn({ errors: ["Something exploded in a tool handler"] }));
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });

    await dispatcher.dispatch(slackItem());
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].error).toBe("Something exploded in a tool handler");
  });

  it("closed snapshot → legacy error path; shadow (enabled:false) open snapshot → legacy path", async () => {
    agentManager.runWorkItemTurn.mockResolvedValue(makeTurn({ errors: ["connect ECONNREFUSED api"] }));

    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
    await dispatcher.dispatch(slackItem({ id: "m1" }));
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: false });
    await dispatcher.dispatch(slackItem({ id: "m2" }));

    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(2);
  });

  it("★ timeout gate: timedOut && aborted with breaker open → outage path even with empty errors", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });

    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledTimes(1);
    // No bare "_No response._" delivery — only the honest notice.
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(OUTAGE_NOTICE_DEFAULT);
  });

  it("★ timedOut with breaker closed → legacy path, unqueued", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });

    await dispatcher.dispatch(slackItem());
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // "_No response._" as today
  });

  it("sched: turns skip with a log — never queued, never noticed", async () => {
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(
      slackItem({ id: "sched:executive-assistant:daily:1", meta: { targetAgentId: "executive-assistant" } }),
    );
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it("callback:/event:/team- turns queue silently (no notice, no error delivery)", async () => {
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());
    for (const id of ["callback:abc", "event:abc:executive-assistant", "team-abc"]) {
      await dispatcher.dispatch(slackItem({ id, meta: { targetAgentId: "executive-assistant" } }));
    }
    expect(store.enqueue).toHaveBeenCalledTimes(3);
    for (const call of store.enqueue.mock.calls) {
      expect(call[0].policy).toBe("silent");
    }
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it("overflow at maxDepth: NOT queued, one overflow notice per thread per episode (notify policy)", async () => {
    store.pendingCount.mockResolvedValue(500);
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());

    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(OUTAGE_OVERFLOW_NOTICE_DEFAULT);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();

    // Advisory 3: a second overflowed message on the SAME thread during the
    // same episode must NOT re-notice — dedup is per-thread, not per-message.
    await dispatcher.dispatch(slackItem({ id: "m2", threadId: "t1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("★ release-before-depth: replayed fast-fail at maxDepth resolves its doc, never the overflow branch", async () => {
    store.pendingCount.mockResolvedValue(500);
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());

    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "pending");
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).not.toHaveBeenCalled(); // no overflow notice, no second outage notice
  });

  it("replay re-entrancy + dedup bypass: same id redispatches; non-replay duplicate still drops", async () => {
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    await dispatcher.dispatch(replayItem({ id: "m1" })); // second replay tick, same id — must NOT be deduped
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    expect(store.release).toHaveBeenCalledTimes(2);
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).not.toHaveBeenCalled();

    // Non-replay duplicate id within the 60s window still drops.
    agentManager.runWorkItemTurn.mockResolvedValue(makeTurn());
    await dispatcher.dispatch(slackItem({ id: "dup-1" }));
    await dispatcher.dispatch(slackItem({ id: "dup-1" }));
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3); // only one of the two dup-1 dispatches ran
  });

  it("★ legacy thrown branch: replay + non-outage throw (breaker closed) → doc back to pending, attempts unchanged, then today's error delivery", async () => {
    agentManager.runWorkItemTurn.mockRejectedValueOnce(new Error("Spawn budget exceeded for executive-assistant"));
    await dispatcher.dispatch(replayItem({ id: "m1" }));

    expect(store.release).toHaveBeenCalledWith(
      "m1",
      "executive-assistant",
      "pending",
      expect.stringContaining("Spawn budget exceeded"),
    );
    expect(store.recordFailedAttempt).not.toHaveBeenCalled(); // attempts unchanged
    // Legacy delivery continues as today.
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].error).toContain("Spawn budget exceeded");
  });

  it("disabled pinned-agent replay → expired (chief-of-staff is disabled in the mock registry)", async () => {
    await dispatcher.dispatch(replayItem({ id: "m1", meta: { outageReplay: true, targetAgentId: "chief-of-staff" } }));
    expect(store.release).toHaveBeenCalledWith(
      "m1",
      "chief-of-staff",
      "expired",
      "agent disabled/deleted — will not be replayed",
    );
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("★ deleted/unresolvable pinned-agent replay → expired, NO fall-through resolution", async () => {
    // Item text names an existing agent ("hey Jasper") — a fall-through
    // resolution would match jasper; the pinned-agent rule forbids it.
    await dispatcher.dispatch(
      replayItem({ id: "m1", text: "hey Jasper, are we live?", meta: { outageReplay: true, targetAgentId: "ghost-agent" } }),
    );
    expect(store.release).toHaveBeenCalledWith(
      "m1",
      "ghost-agent",
      "expired",
      "agent disabled/deleted — will not be replayed",
    );
    expect(agentManager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("episode cleared on success ONLY when stateFor is not open at completion (Finding 3 r1)", async () => {
    // Open the episode.
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // the notice

    // A pre-trip turn lands successfully while the breaker is STILL open → episode must survive.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn());
    await dispatcher.dispatch(slackItem({ id: "m2", threadId: "t1" }));
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m3", threadId: "t1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(2); // m2's answer only; m3 queued silently — NO second notice

    // Success while the breaker reads closed → episode ends → next outage re-notices.
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn());
    await dispatcher.dispatch(slackItem({ id: "m4", threadId: "t1" }));
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m5", threadId: "t1" }));
    const texts = adapter.deliver.mock.calls.map((c: any[]) => c[0].text);
    expect(texts.filter((t: string) => t === OUTAGE_NOTICE_DEFAULT)).toHaveLength(2); // m1 + m5
  });

  it("fan-out: two agents fast-fail on one thread → two enqueues (composite key), exactly one notice", async () => {
    agentManager.runWorkItemTurn.mockRejectedValue(makeCircuitOpenError());
    // "Jasper and River" name-resolves to two agents in the mock registry →
    // multi-agent fan-out under Promise.all (the Finding 8 race surface).
    await dispatcher.dispatch(
      makeWorkItem({ id: "m1", threadId: "t1", text: "hey Jasper, and River: thoughts?", source: { kind: "slack", id: "C999", label: "random" } }),
    );
    expect(store.enqueue).toHaveBeenCalledTimes(2);
    const agentIds = store.enqueue.mock.calls.map((c: any[]) => c[0].agentId).sort();
    expect(new Set(agentIds).size).toBe(2);
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // one thread, one notice
  });

  it("terminal failed: notify-policy replay delivers a plain-text terminal notice; silent policy none", async () => {
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
    agentManager.runWorkItemTurn.mockResolvedValue(makeTurn({ errors: ["boom"] }));

    store.recordFailedAttempt.mockResolvedValueOnce({
      terminal: true,
      doc: { policy: "notify", enqueuedAt: new Date(), itemId: "m1", agentId: "executive-assistant" },
    });
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toContain("could not be answered");
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();

    store.recordFailedAttempt.mockResolvedValueOnce({
      terminal: true,
      doc: { policy: "silent", enqueuedAt: new Date(), itemId: "m2", agentId: "executive-assistant" },
    });
    await dispatcher.dispatch(replayItem({ id: "m2" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // unchanged — silent stays silent
  });

  it("replay success releases done", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn());
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "done");
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // the real answer, delivered normally
  });

  it("non-response-suppressed replay also releases done (§5-2g: nothing left to redeliver)", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn({ finalMessage: "No response needed." }));
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "done");
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it("outage wiring absent (setOutageHandling never called) → behavior identical to today", async () => {
    const bare = new Dispatcher(
      makeMockRegistry() as never,
      agentManager as never,
      makeMockHealthReporter() as never,
      "executive-assistant",
    );
    bare.registerAdapter(adapter as never);
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await bare.dispatch(slackItem({ id: "m1" }));
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toContain("Something went wrong");
  });
});
```

Adapt fixture names (`executive-assistant`, `jasper`, `river`, disabled `chief-of-staff`, channel `general`) to the mock registry as it stands at HEAD; the behaviors asserted are what is normative, not the fixture ids.

- [ ] **Step 5.10:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts && npm run typecheck`
Expected: all existing routing/conference suites green + ~20 new tests pass, typecheck clean.

- [ ] **Step 5.11:** Commit

```bash
git add src/channels/dispatcher.ts src/channels/dispatcher.test.ts
git commit -m "KPR-307: dispatcher outage interception — both catch sites, post-turn gate, dispatcher-authored replay outcomes"
```

### Task 6: Replay processor

**Files:**
- Create: `src/outage/outage-replay-processor.ts`
- Test: `src/outage/outage-replay-processor.test.ts`

- [ ] **Step 6.1:** Create `src/outage/outage-replay-processor.ts`:

```typescript
/**
 * KPR-307 §7.4: 15s serial replay poller. Own timer beside the scheduler —
 * NOT a sweeper step (sweeper cadence is 5-min-class; recovery-to-replay
 * latency should track the breaker's ≤60s probe cadence).
 *
 * No breaker-state pre-check by design (§4): while the breaker is open the
 * head attempt fast-fails pre-router for free, and the first post-cooldown
 * attempt IS KPR-306's half-open probe — starving dispatch of traffic would
 * starve recovery.
 */
import { createLogger } from "../logging/logger.js";
import type { Dispatcher } from "../channels/dispatcher.js";
import type { WorkItem } from "../types/work-item.js";
import type { OutageQueueConfig, OutageQueueDoc, OutageQueueStore } from "./outage-queue-store.js";
import { expiryNotice, replayWrap } from "./outage-notices.js";

const log = createLogger("outage-replay");

export class OutageReplayProcessor {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private store: OutageQueueStore,
    private dispatcher: Dispatcher,
    private config: OutageQueueConfig,
    private now: () => Date = () => new Date(),
  ) {}

  start(): void {
    // Boot recovery: crash between claim and release leaves `replaying` orphans (§7.1).
    void this.store
      .recoverStaleReplaying()
      .catch((err) => log.warn("Stale-replaying recovery failed", { error: String(err) }));
    this.timer = setInterval(() => {
      void this.tick().catch((err) => log.error("Outage replay tick failed", { error: String(err) }));
    }, this.config.replayIntervalMs);
    this.timer.unref();
    log.info("Outage replay processor started", { intervalMs: this.config.replayIntervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle. Public for tests. Re-entrancy-guarded — a slow drain can outlive the interval. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.expireStale();
      await this.drain();
    } finally {
      this.ticking = false;
    }
  }

  /** §5-2c: age out over-TTL items; one batched per-thread notice for notify-policy docs (§5-2c-ii). */
  private async expireStale(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.config.maxAgeHours * 3600_000);
    const expired = await this.store.expireOlderThan(cutoff);
    if (expired.length === 0) return;
    log.warn("Expired queued outage turns past maxAgeHours", { count: expired.length });

    const groups = new Map<string, OutageQueueDoc[]>();
    for (const doc of expired) {
      if (doc.policy !== "notify") continue;
      const key = `${doc.workItem.source.adapterId ?? doc.workItem.source.kind}:${doc.workItem.threadId ?? doc.workItem.sender}`;
      const list = groups.get(key) ?? [];
      list.push(doc);
      groups.set(key, list);
    }
    for (const docs of groups.values()) {
      const sample = docs[0];
      await this.dispatcher.deliverOutageNotice(sample.workItem, sample.agentId, undefined, expiryNotice(docs.length));
    }
  }

  /**
   * Serial oldest-first drain (§5-2b). Outcomes are DISPATCHER-authored
   * (§5-2g) — dispatch() returns void and never rethrows from turn failures,
   * so drain control re-reads the claimed doc's status (Finding 7 r2):
   * `pending` (fast-fail-again) stops the drain; done/expired/failed continue.
   */
  private async drain(): Promise<void> {
    let attempted = 0;
    for (;;) {
      const doc = await this.store.claimNext();
      if (!doc) break;
      if (attempted === 0) log.info("Outage replay drain start", { firstItemAgent: doc.agentId });
      attempted++;

      const replayItem: WorkItem = {
        ...doc.workItem,
        // §5-2d prompt-note wrap; the stored workItem keeps the original text.
        text: replayWrap(doc.workItem.text, doc.enqueuedAt, doc.policy),
        // Original id kept — dispatch()'s dedup bypasses outageReplay items
        // (Finding 1 r1: a synthetic per-attempt id would repeat while
        // attempts stays 0 and dedup would drop every replay after the first).
        meta: { ...doc.workItem.meta, targetAgentId: doc.agentId, outageReplay: true },
      };

      try {
        await this.dispatcher.dispatch(replayItem);
      } catch (err) {
        // dispatch() never rethrows turn failures; this guards pre-try throws
        // (e.g. session-store reads) from stranding the doc in `replaying`.
        log.error("Replay dispatch threw — doc back to pending, drain stopped", { error: String(err) });
        await this.store.release(doc.itemId, doc.agentId, "pending", String(err));
        break;
      }

      const status = await this.store.statusOf(doc.itemId, doc.agentId);
      if (status === "replaying") {
        // Defensive: no release path fired (should be unreachable — every
        // dispatch path writes an outcome). Revert rather than strand.
        log.warn("Replay dispatch recorded no outcome — doc reverted to pending", {
          agentId: doc.agentId,
        });
        await this.store.release(doc.itemId, doc.agentId, "pending", "no outcome recorded at dispatch");
        break;
      }
      if (status === "pending") break; // fast-failed again — breaker still open, stop draining
      // done / expired / failed → continue to the next item.
    }
    if (attempted > 0) log.info("Outage replay drain end", { attempted });
  }
}
```

- [ ] **Step 6.2:** Create `src/outage/outage-replay-processor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutageReplayProcessor } from "./outage-replay-processor.js";
import type { OutageQueueDoc } from "./outage-queue-store.js";
import type { WorkItem } from "../types/work-item.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const CONFIG = { enabled: true, replayIntervalMs: 15_000, maxAgeHours: 4, maxDepth: 500, maxReplayAttempts: 3 };

function makeDoc(overrides: Partial<OutageQueueDoc> = {}): OutageQueueDoc {
  const workItem: WorkItem = {
    id: overrides.itemId ?? "m1",
    text: "original question",
    source: { kind: "slack", id: "C1", label: "general" },
    sender: "user1",
    threadId: "t1",
    timestamp: new Date("2026-07-07T10:00:00Z"),
  };
  return {
    itemId: "m1",
    agentId: "agent-a",
    provider: "claude",
    workItem,
    policy: "notify",
    status: "replaying",
    attempts: 0,
    enqueuedAt: new Date("2026-07-07T10:00:00Z"),
    lastAttemptAt: null,
    lastError: null,
    noticeSent: true,
    doneAt: null,
    ...overrides,
  };
}

function makeStore() {
  return {
    claimNext: vi.fn().mockResolvedValue(null),
    release: vi.fn().mockResolvedValue(undefined),
    statusOf: vi.fn().mockResolvedValue("done"),
    expireOlderThan: vi.fn().mockResolvedValue([]),
    recoverStaleReplaying: vi.fn().mockResolvedValue(0),
  };
}

function makeDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue(undefined),
    deliverOutageNotice: vi.fn().mockResolvedValue(undefined),
  };
}

describe("OutageReplayProcessor (KPR-307 §7.4)", () => {
  let store: ReturnType<typeof makeStore>;
  let dispatcher: ReturnType<typeof makeDispatcher>;
  let processor: OutageReplayProcessor;

  beforeEach(() => {
    store = makeStore();
    dispatcher = makeDispatcher();
    processor = new OutageReplayProcessor(store as never, dispatcher as never, CONFIG);
  });

  afterEach(() => {
    processor.stop();
    vi.useRealTimers();
  });

  it("redispatches with the ORIGINAL id, wrapped text, pinned targetAgentId, and outageReplay meta", async () => {
    store.claimNext.mockResolvedValueOnce(makeDoc()).mockResolvedValueOnce(null);
    await processor.tick();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const item = dispatcher.dispatch.mock.calls[0][0] as WorkItem;
    expect(item.id).toBe("m1"); // no synthetic replay:<attempt>: id
    expect(item.text).toMatch(/^\[This message was received at .* during an AI service outage/);
    expect(item.text).toContain("original question");
    expect(item.meta).toMatchObject({ targetAgentId: "agent-a", outageReplay: true });
  });

  it("silent-policy docs get the minimal wrap variant", async () => {
    store.claimNext.mockResolvedValueOnce(makeDoc({ policy: "silent" })).mockResolvedValueOnce(null);
    await processor.tick();
    expect((dispatcher.dispatch.mock.calls[0][0] as WorkItem).text).toMatch(/^\[Replayed after an AI service outage/);
  });

  it("★ drain control re-reads status: continues through done/expired/failed, stops on pending", async () => {
    store.claimNext
      .mockResolvedValueOnce(makeDoc({ itemId: "a" }))
      .mockResolvedValueOnce(makeDoc({ itemId: "b" }))
      .mockResolvedValueOnce(makeDoc({ itemId: "c" }))
      .mockResolvedValueOnce(makeDoc({ itemId: "d" }))
      .mockResolvedValue(null);
    store.statusOf
      .mockResolvedValueOnce("done") // a → continue
      .mockResolvedValueOnce("expired") // b → continue
      .mockResolvedValueOnce("failed") // c → continue
      .mockResolvedValueOnce("pending"); // d fast-failed again → STOP

    await processor.tick();
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(4);
    expect(store.claimNext).toHaveBeenCalledTimes(4); // never claimed a 5th while pending signaled stop
  });

  it("a dispatch() throw releases the doc back to pending and stops the drain", async () => {
    store.claimNext.mockResolvedValueOnce(makeDoc()).mockResolvedValue(null);
    dispatcher.dispatch.mockRejectedValueOnce(new Error("mongo hiccup"));

    await processor.tick();
    expect(store.release).toHaveBeenCalledWith("m1", "agent-a", "pending", expect.stringContaining("mongo hiccup"));
    expect(store.claimNext).toHaveBeenCalledTimes(1);
  });

  it("a doc left in replaying (no outcome written) is defensively reverted and stops the drain", async () => {
    store.claimNext.mockResolvedValueOnce(makeDoc()).mockResolvedValue(null);
    store.statusOf.mockResolvedValueOnce("replaying");

    await processor.tick();
    expect(store.release).toHaveBeenCalledWith("m1", "agent-a", "pending", "no outcome recorded at dispatch");
  });

  it("expiry: one batched per-thread notice with the correct count; silent docs excluded", async () => {
    store.expireOlderThan.mockResolvedValueOnce([
      makeDoc({ itemId: "e1" }),
      makeDoc({ itemId: "e2" }), // same thread t1
      makeDoc({ itemId: "e3", policy: "silent" }), // silent — no notice
      makeDoc({
        itemId: "e4",
        workItem: {
          id: "e4",
          text: "x",
          source: { kind: "sms", id: "+1555", label: "line" },
          sender: "+1555",
          timestamp: new Date(),
        },
      }), // different (adapter, sender) group
    ]);

    await processor.tick();
    expect(dispatcher.deliverOutageNotice).toHaveBeenCalledTimes(2);
    const texts = dispatcher.deliverOutageNotice.mock.calls.map((c: any[]) => c[3]);
    expect(texts).toContain("Service is back — I couldn't get to 2 earlier messages from during the outage. Please re-send anything still needed.");
    expect(texts).toContain("Service is back — I couldn't get to 1 earlier message from during the outage. Please re-send anything still needed.");
  });

  it("tick is re-entrancy guarded", async () => {
    let resolveClaim!: (v: null) => void;
    store.claimNext.mockReturnValueOnce(new Promise((r) => (resolveClaim = r)));
    const first = processor.tick();
    await processor.tick(); // second tick while first in flight → no-op
    resolveClaim(null);
    await first;
    expect(store.claimNext).toHaveBeenCalledTimes(1);
  });

  it("start() recovers stale replaying docs and ticks on the configured interval; stop() halts it", async () => {
    vi.useFakeTimers();
    processor.start();
    expect(store.recoverStaleReplaying).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1);
    processor.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1); // no further ticks
  });
});
```

- [ ] **Step 6.3:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-replay-processor.test.ts && npm run typecheck`
Expected: 8 tests pass, typecheck clean.

- [ ] **Step 6.4:** Commit

```bash
git add src/outage/outage-replay-processor.ts src/outage/outage-replay-processor.test.ts
git commit -m "KPR-307: 15s serial replay poller — re-read-status drain control, batched expiry notices"
```

### Task 7: Engine wiring (`index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 7.1:** Add imports (top of `index.ts`):

```typescript
import { OutageQueueStore, type OutageQueueDoc } from "./outage/outage-queue-store.js";
import { OutageEpisodeTracker } from "./outage/outage-notices.js";
import { OutageReplayProcessor } from "./outage/outage-replay-processor.js";
```

- [ ] **Step 7.2:** Wire the outage subsystem immediately after `dispatcher.setRetryQueue(retryQueue);` (anchor: `grep -n "setRetryQueue" src/index.ts` — baseline `:735`; retry queue must be set first so notice-delivery failures retry like any message):

```typescript
  // KPR-307: honest outage behavior — durable outage queue + episode tracker
  // + 15s replay poller. enabled:false = interception fully off (independent
  // kill-switch from the breaker's; behavior identical to post-KPR-306 raw
  // error surfacing).
  let outageReplayProcessor: OutageReplayProcessor | undefined;
  if (config.outageQueue.enabled) {
    const outageStore = new OutageQueueStore(db.collection<OutageQueueDoc>("outage_queue"));
    await outageStore.ensureIndexes();
    dispatcher.setOutageHandling({
      store: outageStore,
      episodes: new OutageEpisodeTracker(),
      config: config.outageQueue,
    });
    outageReplayProcessor = new OutageReplayProcessor(outageStore, dispatcher, config.outageQueue);
    outageReplayProcessor.start();
    log.info("Outage queue enabled", {
      replayIntervalMs: config.outageQueue.replayIntervalMs,
      maxDepth: config.outageQueue.maxDepth,
    });
  }
```

`db` is the write-guarded handle (`guardDb(rawDb, ...)` — `outage_queue` is engine-written state and belongs behind the guard like `sessions`). If the guarded `db.collection<T>()` generic doesn't flow cleanly at HEAD, follow the repo's existing cast precedent (`admin-api` wiring uses `as any` on typed collections).

- [ ] **Step 7.3:** Add to the shutdown block (anchor: `grep -n "scheduler.stop()" src/index.ts`), next to `scheduler.stop();`:

```typescript
    outageReplayProcessor?.stop();
```

- [ ] **Step 7.4:** Verify

Run: `npm run typecheck && npm run build`
Expected: clean compile.

- [ ] **Step 7.5:** Commit

```bash
git add src/index.ts
git commit -m "KPR-307: wire outage store, episode tracker, replay poller behind outageQueue.enabled"
```

### Task 8: Voice — honest spoken failure

**Files:**
- Modify: `src/channels/voice/voice-adapter.ts`
- Test: `src/channels/voice/voice-adapter.test.ts` (extend)

- [ ] **Step 8.1:** Add imports:

```typescript
import { ProviderCircuitOpenError } from "../../agents/provider-circuit-breaker.js";
import { VOICE_OUTAGE_SPOKEN_NOTICE } from "../../outage/outage-notices.js";
```

- [ ] **Step 8.2:** In `spawnTurnViaAgentManager`, extend `runOnce`'s failure shape and catch (anchor: `grep -n "const runOnce" src/channels/voice/voice-adapter.ts`):

```typescript
    ): Promise<
      | { ok: true; result: TurnResult; bytesSent: boolean }
      | { ok: false; reason: string; circuitOpen?: boolean; bytesSent: boolean }
    > => {
```

and in its `catch`:

```typescript
      } catch (err) {
        return {
          ok: false,
          reason: String(err),
          // KPR-307: detected here (instanceof survives — same process) so the
          // failure block below can speak an honest completion, not a 500.
          circuitOpen: err instanceof ProviderCircuitOpenError,
          bytesSent: headersSent,
        };
      }
```

- [ ] **Step 8.3:** Skip the outer resume-retry for circuit-open fast-fails (a retry would just fast-fail again — pointless second spawn attempt). Change the outer-retry condition (anchor: `grep -n "retrying as turn-1" ...`):

```typescript
    if (!outcome.ok && !outcome.circuitOpen && effectiveResume && !outcome.bytesSent) {
```

- [ ] **Step 8.4:** At the TOP of the `if (!outcome.ok)` block (before the `isAuthError` check):

```typescript
      if (outcome.circuitOpen) {
        // KPR-307 §5-1b: honest SPOKEN completion — today's baseline is a
        // generic 500 "Internal error" (only auth/budget get 503s), and both
        // a bare 500 and a 503 render as dead air to Vapi. ⚠ Confirm Vapi
        // renders a normal completion better than a 500/503 during rollout.
        log.warn("Voice turn fast-failed — provider circuit open, speaking outage notice", {
          callId,
          agentId,
        });
        this.endWithSpokenText(res, VOICE_OUTAGE_SPOKEN_NOTICE, isStreaming, outcome.bytesSent, completionId, model);
        return;
      }
```

- [ ] **Step 8.5:** Add the helper next to `endWithError`:

```typescript
  /**
   * KPR-307: end the turn with a normal 200 completion carrying spoken text.
   * Streaming: emit one SSE text chunk + the standard done frame (headers
   * lazily if no bytes were sent yet). Non-streaming: standard JSON body.
   */
  private endWithSpokenText(
    res: ServerResponse,
    text: string,
    isStreaming: boolean,
    bytesSent: boolean,
    completionId: string,
    model: string,
  ): void {
    if (isStreaming) {
      if (!bytesSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
      }
      if (!res.writableEnded) {
        res.write(formatSSETextChunk(completionId, text, model));
        res.write(formatSSEDone(completionId, model));
        res.end();
      }
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(formatNonStreamingResponse(completionId, text, model)));
  }
```

- [ ] **Step 8.6:** Extend `src/channels/voice/voice-adapter.test.ts` (reuse the file's existing `makeAgentManager`/request/res fixtures; override `spawnTurn` per test to throw a real `ProviderCircuitOpenError`):

```typescript
import { ProviderCircuitOpenError } from "../../agents/provider-circuit-breaker.js";
import { VOICE_OUTAGE_SPOKEN_NOTICE } from "../../outage/outage-notices.js";

describe("VoiceAdapter — provider circuit open (KPR-307)", () => {
  function circuitOpenError() {
    return new ProviderCircuitOpenError("claude" as never, Date.now(), 15_000, "connect-fail", "fetch failed");
  }

  it("non-streaming: speaks the outage notice as a 200 completion, not a generic 500", async () => {
    const agentManager = makeAgentManager();
    agentManager.spawnTurn.mockRejectedValue(circuitOpenError());
    // Build adapter + non-streaming request + res recorder per the file's
    // existing fixture pattern, then invoke the chat-completion path.
    const { res, body, statusCode } = await runChatCompletion(agentManager, { stream: false });
    expect(statusCode()).toBe(200);
    expect(body()).toContain(VOICE_OUTAGE_SPOKEN_NOTICE);
    expect(body()).not.toContain("Internal error");
  });

  it("streaming: emits one SSE text chunk with the notice plus a done frame", async () => {
    const agentManager = makeAgentManager();
    agentManager.spawnTurn.mockRejectedValue(circuitOpenError());
    const { written, statusCode } = await runChatCompletion(agentManager, { stream: true });
    expect(statusCode()).toBe(200);
    expect(written()).toContain(VOICE_OUTAGE_SPOKEN_NOTICE);
    expect(written()).toContain("[DONE]");
  });

  it("does NOT fire the outer resume-retry for circuit-open fast-fails", async () => {
    const agentManager = makeAgentManager();
    agentManager.sessionStoreGet.mockResolvedValue("session-abc"); // resume present
    agentManager.spawnTurn.mockRejectedValue(circuitOpenError());
    await runChatCompletion(agentManager, { stream: false });
    expect(agentManager.spawnTurn).toHaveBeenCalledTimes(1);
  });
});
```

Write `runChatCompletion` as a thin wrapper over the file's existing request/response fixtures (the suite already builds `OpenAIChatRequest` objects and a recording `ServerResponse` stub for the 503/500 tests at baseline `:489-514` — mirror that construction; exact helper names re-confirmed at HEAD). Also verify the existing "spawn budget exceeded → 503" and "auth error → 503" tests still pass unchanged.

- [ ] **Step 8.7:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/voice/voice-adapter.test.ts && npm run typecheck`
Expected: existing voice suites green + 3 new tests pass.

- [ ] **Step 8.8:** Commit

```bash
git add src/channels/voice/voice-adapter.ts src/channels/voice/voice-adapter.test.ts
git commit -m "KPR-307: voice speaks an honest outage completion instead of a generic 500"
```

### Task 9: Doctor section (informational — D4)

**Files:**
- Modify: `src/cli/doctor-checks.ts`, `src/cli/doctor.ts`
- Test: `src/cli/doctor-checks.test.ts`, `src/cli/doctor.test.ts` (extend)

- [ ] **Step 9.1:** Add to `src/cli/doctor-checks.ts` (after the KPR-306 circuit-breaker loader):

```typescript
/**
 * KPR-307: outage-queue snapshot. Direct collection read — the queue is
 * durable, so unlike the breaker no heartbeat proxy is needed. Returns null
 * when Mongo is unreachable.
 */
export interface OutageQueueStats {
  pending: number;
  replaying: number;
  oldestPendingAgeSeconds: number | null;
  expired24h: number;
  failed24h: number;
}

export async function outageQueueStatsForDoctor(uri: string, dbName: string): Promise<OutageQueueStats | null> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const collection = client.db(dbName).collection("outage_queue");
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const [pending, replaying, expired24h, failed24h, oldest] = await Promise.all([
      collection.countDocuments({ status: "pending" }),
      collection.countDocuments({ status: "replaying" }),
      collection.countDocuments({ status: "expired", doneAt: { $gte: dayAgo } }),
      collection.countDocuments({ status: "failed", doneAt: { $gte: dayAgo } }),
      collection.find<{ enqueuedAt?: Date }>({ status: "pending" }).sort({ enqueuedAt: 1 }).limit(1).toArray(),
    ]);
    const oldestDoc = oldest[0];
    const oldestPendingAgeSeconds =
      oldestDoc?.enqueuedAt instanceof Date ? Math.round((Date.now() - oldestDoc.enqueuedAt.getTime()) / 1000) : null;
    return { pending, replaying, oldestPendingAgeSeconds, expired24h, failed24h };
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
```

- [ ] **Step 9.2:** Add to `src/cli/doctor.ts` (after the KPR-306 circuit-breaker renderer):

```typescript
/**
 * KPR-307: informational outage-queue section (D4 — NEVER affects the exit
 * code; identity-class incidents alone may fail the doctor). `anyBreakerOpen`
 * comes from the circuit-breaker rows: pending items while every breaker is
 * closed is the stuck-drain signal (§7.6).
 */
export function renderOutageQueueSection(
  stats: OutageQueueStats | null,
  anyBreakerOpen: boolean,
  emit: (line: string) => void = console.log,
): void {
  emit("\nOutage queue (honest outage behavior)");
  if (stats === null) {
    emit("  ○ unavailable — mongo unreachable");
    return;
  }
  if (stats.pending === 0 && stats.replaying === 0 && stats.expired24h === 0 && stats.failed24h === 0) {
    emit("  ○ empty — no queued outage turns");
    return;
  }
  const oldest = stats.oldestPendingAgeSeconds === null ? "n/a" : `${stats.oldestPendingAgeSeconds}s`;
  emit(
    `  pending=${stats.pending} (oldest ${oldest}) replaying=${stats.replaying} expired(24h)=${stats.expired24h} failed(24h)=${stats.failed24h}`,
  );
  if (stats.pending > 0 && !anyBreakerOpen) {
    emit("  ⚠ pending items while no breaker is open — replay drain may be stuck; check engine logs (outage-replay)");
  }
}
```

Wire into `runDoctor` immediately after the circuit-breaker section (anchor: `grep -n "renderCircuitBreakerSection" src/cli/doctor.ts`), reusing its already-fetched rows:

```typescript
    // KPR-307: outage queue (informational — D4).
    const outageStats = await outageQueueStatsForDoctor(config.mongo.uri, config.mongo.dbName);
    renderOutageQueueSection(outageStats, circuitRows.some((r) => r.state === "open"));
```

(`circuitRows` = whatever KPR-306 named its fetched rows at HEAD; adapt.) Add the matching line to the `else` (config-not-loaded) block:

```typescript
    console.log("\nOutage queue (honest outage behavior)");
    console.log("  ○ skipped: config not loaded");
```

- [ ] **Step 9.3:** Tests. In `src/cli/doctor.test.ts`:

```typescript
describe("renderOutageQueueSection (KPR-307, informational — D4)", () => {
  function capture() {
    const lines: string[] = [];
    return { lines, emit: (l: string) => lines.push(l) };
  }

  it("renders null stats as unavailable", () => {
    const { lines, emit } = capture();
    renderOutageQueueSection(null, false, emit);
    expect(lines.join("\n")).toContain("unavailable");
  });

  it("renders an all-zero queue as empty", () => {
    const { lines, emit } = capture();
    renderOutageQueueSection(
      { pending: 0, replaying: 0, oldestPendingAgeSeconds: null, expired24h: 0, failed24h: 0 },
      false,
      emit,
    );
    expect(lines.join("\n")).toContain("empty — no queued outage turns");
  });

  it("renders counts and flags stuck drain only when pending > 0 with no breaker open", () => {
    const stats = { pending: 3, replaying: 1, oldestPendingAgeSeconds: 124, expired24h: 0, failed24h: 1 };
    const stuck = capture();
    renderOutageQueueSection(stats, false, stuck.emit);
    expect(stuck.lines.join("\n")).toContain("pending=3 (oldest 124s) replaying=1 expired(24h)=0 failed(24h)=1");
    expect(stuck.lines.join("\n")).toContain("⚠ pending items while no breaker is open");

    const draining = capture();
    renderOutageQueueSection(stats, true, draining.emit);
    expect(draining.lines.join("\n")).not.toContain("⚠");
  });

  it("emits only — returns void (cannot alter the exit code, D4)", () => {
    const { emit } = capture();
    expect(
      renderOutageQueueSection(
        { pending: 9, replaying: 0, oldestPendingAgeSeconds: 1, expired24h: 0, failed24h: 9 },
        false,
        emit,
      ),
    ).toBeUndefined();
  });
});
```

In `src/cli/doctor-checks.test.ts`, extend the existing mongodb module-mock factory so `collection()` also supports the calls `outageQueueStatsForDoctor` makes (`countDocuments`, `find().sort().limit().toArray()` — KPR-306's Task already added `find`; add `countDocuments` and the sort/limit chain if missing), then:

```typescript
describe("outageQueueStatsForDoctor (KPR-307)", () => {
  it("returns counts and oldest-pending age from the collection", async () => {
    // Configure the shared mongodb mock: countDocuments returns 3/1/0/1 in
    // call order; find().sort().limit().toArray() returns one doc with
    // enqueuedAt 2 minutes ago.
    const stats = await outageQueueStatsForDoctor("mongodb://localhost", "hive_test");
    expect(stats).toMatchObject({ pending: 3, replaying: 1, expired24h: 0, failed24h: 1 });
    expect(stats!.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(119);
  });

  it("returns null when the connection fails", async () => {
    // Configure the mock client's connect() to reject for this test.
    const stats = await outageQueueStatsForDoctor("mongodb://down", "hive_test");
    expect(stats).toBeNull();
  });
});
```

(Follow the file's established pattern for per-test mock configuration — the KPR-306 loader tests adjacent at HEAD show the exact shape.)

- [ ] **Step 9.4:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/cli/doctor.test.ts src/cli/doctor-checks.test.ts && npm run typecheck`
Expected: existing doctor suites green + 6 new tests pass.

- [ ] **Step 9.5:** Commit

```bash
git add src/cli/doctor-checks.ts src/cli/doctor.ts src/cli/doctor.test.ts src/cli/doctor-checks.test.ts
git commit -m "KPR-307: informational outage-queue doctor section (direct collection read, D4)"
```

### Task 10: CLAUDE.md + full gate

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 10.1:** In the CLAUDE.md "MongoDB collections (engine-written)" gotcha list, add `outage_queue` with a parenthetical: `outage_queue` (honest-outage replay queue KPR-307 — fast-failed turns queued while a provider breaker is open; composite `(itemId, agentId)` key; replayed by a 15s poller).

- [ ] **Step 10.2:** Add a Common Gotchas entry (place near the KPR-306 breaker entry):

```markdown
- **Honest outage behavior (KPR-307):** while a provider circuit (KPR-306) is open, the dispatcher intercepts fast-fails and probe-failure turns: one plain-text notice per thread per outage episode (SMS/iMessage now send one honest text per episode **instead of silently skipping** — deliberate behavior change), and the turn persists to `outage_queue` for automatic replay (15s poller, oldest-first, 4h TTL, depth 500, 3 real attempts). Cron turns skip (they re-fire); callback/event/team one-shots queue silently. Voice speaks an honest outage sentence as a normal completion. Config: `outageQueue` section in hive.yaml (`enabled`, `replayIntervalMs`, `maxAgeHours`, `maxDepth`, `maxReplayAttempts`) — `enabled: false` reverts to raw error surfacing. The delivery retry queue (`src/sweeper/retry-queue.ts`) is a different mechanism (turn succeeded, delivery failed) and is unchanged. `hive doctor` shows an informational "Outage queue" section; status queries still work mid-outage (no model call).
```

- [ ] **Step 10.3:** Full gate + zero-diff assertions

Run: `git diff --stat $(git merge-base HEAD kpr-305)..HEAD -- src/sweeper/retry-queue.ts src/scheduler/scheduler.ts src/agents/provider-circuit-breaker.ts src/agents/provider-adapters/error-classification.ts`
(Base is the child branch point, not `main` — KPR-306 lands on the epic branch `kpr-305` before this ticket, and the epic only merges to `main` at the end, so `main...HEAD` would falsely show the breaker/error-classification files as wholly added.)
Expected: empty (untouched-by-design files).

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 — typecheck + lint + format + full test suite green.

- [ ] **Step 10.4:** Commit

```bash
git add CLAUDE.md
git commit -m "KPR-307: CLAUDE.md — outage_queue collection + honest-outage gotcha"
```

---

## Execution Handoff

Plan saved to `docs/epics/kpr-305/kpr-307-plan.md`. Ready to execute? When ready, invoke `dodi-dev:implement`.
