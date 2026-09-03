# KPR-417 — Delay-then-ack for long-running conference turns — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** `docs/epics/kpr-415/kpr-417-spec.md` (spec-ready, clean, spec-review r1, two rounds passed). The spec is authoritative on every design question; this plan implements it and does not re-open it.
**Epic:** KPR-415 (Meeting mode hardening) · Child B1 · **Blocked by:** KPR-416 (Child A) — A merges first (spec §11).
**Baseline:** worktree `/Users/mokie/github/hive-KPR-415`, branch `KPR-415` at `e0819fa`. Every line citation below was re-verified against this tree on 2026-08-28. **Re-check every number against the live tree before editing — anchor on quoted text, not on the number.**

**Goal:** A round-0 conference responder still unresolved ~15s after dispatch posts exactly one lightweight, agent-attributed acknowledgment into the meeting thread; fast responders never ack; and the ack is invisible to all five engine-internal consumers of meeting thread history.

**Architecture:** Three additive pieces in `src/channels/dispatcher.ts`. (1) A per-turn ack timer armed and cancelled by one helper (`runTurnWithMeetingAck`) that wraps the fan-out turn await — arm, run, cancel-in-`finally`. (2) A stable content-pattern recognizer (`MEETING_ACK_TEXT` / `MEETING_ACK_PATTERNS` / `isMeetingAck`, mirroring the `NON_RESPONSE_PATTERNS` precedent) plus one private `fetchMeetingHistory` wrapper that replaces both `ThreadMessage[]` production sites, making all five consumers ack-blind in one hunk. (3) A `meetingWorkers.ackEnabled` config lever wired through `worker-pool-config.ts` → `config.ts` → `index.ts`, above the spawn-capable boundary, fail-closed on the dispatcher.

**Tech Stack:** TypeScript (strict), Vitest (with a fake-timer describe-block scoped to the ack tests only), no new dependencies, no schema, no new Slack scope, no new collection.

---

## ⚠ Baseline note — this plan is written against the PRE-KPR-416 tree

Per the epic's waterfall mode, **KPR-416 implements and merges into the epic branch before KPR-417 starts.** This plan's line numbers are as of `e0819fa` (pre-KPR-416). KPR-416's own plan (`kpr-416-plan.md`) tells us exactly what shape it leaves behind. Where a step's anchor is affected, it is flagged inline with **`⚠ POST-416 SHIFT`**. Summary of what KPR-416 changes in `dispatcher.ts`, in file order:

> **⚠ NO LINE-SHIFT ARITHMETIC IS GIVEN, DELIBERATELY.** An earlier draft carried "~+N lines" estimates per row and cumulative "~+N above call site X" totals; they were measurably wrong and internally inconsistent, and they were **decorative** — every edit step in this plan already anchors on quoted verbatim text, not on a line number. The one rule that matters: **everything below the earliest KPR-416 edit shifts. Once KPR-416 has landed, always anchor on the quoted verbatim text, never on a line number.** The table below records *where each KPR-416 edit sits relative to this plan's anchors* — a structural fact — and nothing about how far anything moved.

| KPR-416 edit | Where (pre-416 line) | Relation to this plan's anchors |
|---|---|---|
| Tracker field comment rewritten | `:130-133` | Directly above my field insertion point. **My anchor (`private meetingReactionTracker = new Map<...>();` + the following `private static readonly DEDUP_TTL_MS`) is byte-identical pre and post.** |
| `markReactionExclusion` write site 2 inserted | `:411` (single-dispatch `else`) | Nothing of mine is in this block. |
| `markReactionExclusion` helper inserted | after `:563` | Everything below shifts. This is the earliest edit that moves my anchors' line numbers. |
| Write site 3 in `handleTurnFailure` | `:623` | Nothing of mine here. |
| KPR-388 premise comment rewritten | `:1344-1351` | *Inside* `dispatchToAgent`, **above** my turn-await wrap. My anchor is the await statement itself, untouched by 416. |
| `meetingExclusionTs` stamped in the conference meta block | `:1373-1382` | Still above my wrap. Untouched anchor. |
| `markReactionExclusion` write site 1 in the fan-out `else` | `:1481` (immediately before `deliverAgentResult`) | **Below** my wrap. Untouched anchor. |
| Selection-time tracker write **deleted**, comment rewritten | `:1635-1650` | Sits **between** my two `fetchMeetingHistory` call sites (site 1 at `:1576` is above it, site 2 at `:1932` below). Site 1's anchor is unaffected; site 2 shifts down. Both anchors are quoted text. |

**Nothing in KPR-416 and nothing in this plan edits the same statement.** The two children are genuinely disjoint inside `dispatchToAgent`: A adds a synchronous statement immediately before `deliverAgentResult` (`:1481`), B1 wraps the `runWorkItemTurn` await (`:1400`). The one shared *file* is `dispatcher-conference.test.ts`, where both append new tests — merge conflicts there are additive and mechanical.

**Test-harness inheritance from KPR-416.** KPR-416 Task 3 **hoists** `turn(...)`, `zeroUsage`, `settleReactions`, `seedRef` and `makeHistory` from their nested describes up to the suite scope of `describe("Conference channel routing")`, and adds `excludedFor`. This plan **assumes those hoists have landed** and uses `turn(...)`, `makeHistory(...)`, `seedRef(...)` and `settleReactions` directly from suite scope. **⚠ POST-416 SHIFT — if KPR-416 landed without the hoist** (e.g. it was descoped in review), Task 4 Step 1 must perform the same hoist first; the plan flags this as a precondition check in Task 0 Step 3.

---

## Explicitly OUT OF SCOPE — accepted residuals, do not "fix"

An implementer or reviewer must not treat any of these as an oversight. Each is a named, argued disposition in the spec.

| Residual | Spec § | Do not |
|---|---|---|
| **Outage-silence orphan**: agents 2..N of an outage episode queue silently (per-`(provider, adapterKey, threadKey)` notice dedup at `dispatcher.ts:1003`), so their acks are followed by silence until replay. | §6.2 | Do **not** add a breaker-state check in the ack timer handler. The spec considered and rejected exactly that (`circuitBreakers.stateFor(...)?.state === "open"`), on three named grounds. T9(c) **pins** this residual as accepted behavior. |
| **Suppression orphan**: an acked round-0 turn that returns `"No response needed."` leaves the ack with no companion post. Materially softened by KPR-416 (the agent stays round-1-eligible) but not eliminated. | §6.4 | Do **not** add a retraction: no `chat.delete`, no `chat.update`, no "…had nothing to add" follow-up, no ✅/💤 reaction. All four are argued down in §6.4 ground 3. T11 pins the no-retraction rule. |
| **Outage-diversion orphan (§6.6)**: a *successful* turn's answer diverted to the WS floor by KPR-308 `tryOutageDiversion`, leaving the ack alone in the thread. | §6.6 | Do **not** gate the ack on diversion state, and do **not** write a test for it — the spec explicitly declines it as a required case ("Not a required test case"). |
| **Content-pattern collision**: an agent whose *entire* reply is exactly the ack sentence has that message stripped from meeting history. | §5.4 | Accepted, same as the repo-wide `NON_RESPONSE_PATTERNS` hazard. Do **not** add a `meta` flag, Slack message metadata, or a ts-keyed registry — both alternatives are rejected on cost and on restart-fragility respectively. |
| **Cancel-vs-in-flight-post race**: `cancel()` cannot unpost a `deliver` already in flight. | §8 | Accepted. Do **not** add a post-cancel `chat.delete` or an in-flight latch beyond the `cancelled` boolean the fired handler re-checks. |
| **Agents reading the channel via their own `slack` MCP tools still see acks.** | §8 | Out of scope by construction. Do **not** filter at the vendor-API boundary. |
| **`assistant.threads.setStatus` render behavior on a `conf-*` channel thread is unverified.** | §4 fact 3 | Non-blocking; the prior-art determination rests on facts 1 and 2. Do **not** block implementation on confirming it, and do **not** adopt/extend `onProcessingStart`/`onProcessingEnd` (§3 non-goal). |
| **No configurable delay.** Only `ackEnabled` ships. | §5.6 | Do **not** add `ackDelayMs`. |
| **No round-1 acks.** | §5.2 / §3 | Do **not** widen the gate to round 1 under any framing. T3 is the guard, and it carries the KPR-389 §D5 goal-5 citation. |

---

## Prerequisite (Task 0)

This worktree has **no `node_modules`** — verified at plan time (`ls node_modules` → missing). Install before anything else.

---

## Testing Contract

### Required Test Groups

- **Unit: required.**
  - *Scope:* `Dispatcher`'s ack arm/fire/cancel lifecycle and its round-0 gate; the ack recognition pattern and the single strip point across all five history consumers; the `ackEnabled` config resolver; the `index.ts` boot-order anchor.
  - *Reason:* the entire change is dispatcher-internal control flow plus one liberal-loader config key and one boot-wiring line. There is no I/O boundary to integrate against, no new schema, no new collection, no new Slack scope (spec §7, "Files touched").
  - *Minimum assertions:* 15 test cases — T1, T2, T3, T4(a), T4(b), T5 (5 sub-assertions × 2 lever rows, folding T6 in as a parameterized row per spec §9's sanction), T7(a), T7(b) (4 resolver cases), T8 (2 arms), T9 (3 arms), T10 (2 arms), T11 (+ 1 KPR-416-dependent companion), T12, T13 (2 structural pins), T14. Executed `it` count is higher than 15 (several are `it.each` or sibling `it`s).
- **Integration: not-required.** See Non-Required Rationale.
- **E2E: not-required.** See Non-Required Rationale.

### Critical Flows

1. **A slow round-0 responder acks exactly once, then delivers its answer.** T1 (negative-verify), T2 (the fast-turn negative).
2. **The ack is invisible to all five engine history consumers**, and stays invisible with the lever off. T5 (negative-verify) × 2 lever rows.
3. **Gate integrity**: round-1 never acks (KPR-389 §D5 preserved), non-conference fan-out never acks, replays/legs are structurally ack-free. T3, T4(a), T4(b), T10's leg arm.
4. **Every acked-turn failure path ends in a visible resolution, and the ack is never retracted.** T8 (error/throw), T9 (circuit-open), T10 (deadline abort), T11 (suppression).
5. **The ack's own failure is contained** — warn only, no retry-queue enqueue, turn unaffected. T12.
6. **Config + boot wiring**: lever resolves liberally and independently of `enabled`; wiring sits above the spawn-capable boundary. T7, T14.

### Regression Surface

Must stay **green with zero edits** (spec §9, "Suite-level"):

- `dispatcher-conference.test.ts:510` — KPR-387 byte-exact round-0 prompt pin.
- `dispatcher-conference.test.ts:849` — KPR-388 delta injection byte pin.
- `dispatcher-conference.test.ts:552` — KPR-389 D4/C4 escape-phrase guard.
- `dispatcher-conference.test.ts:718 / :738 / :764 / :789` — KPR-413 T1 / T2 / T2b / T3 continuation-leg pins.
- `dispatcher-conference.test.ts:1414-1850` — KPR-409 summary + cadence pins.
- `dispatcher-conference.test.ts:433` — KPR-387 exclusion guard (KPR-416 edits its *harness*; this ticket does not touch it at all).
- `src/channels/dispatcher.test.ts`, `src/channels/deadline-continuation.test.ts`, `src/config.test.ts` (existing cases), `src/boot-order.test.ts` (existing cases) — whole files.
- Every KPR-416 test added by Child A.

**This change touches no prompt bytes.** No preamble, no context-format, no terminal-slot edit anywhere. Any test that currently seeds `fetchThreadHistory` keeps passing unchanged, since non-ack messages are untouched by the filter.

**One test file is edited additively only** (`dispatcher-conference.test.ts` gains a new `describe` plus a handful of top-level `it`s). **No existing test's assertions or harness are modified by this ticket.**

### Commands

```bash
# once, in the worktree
npm ci

# fast loop (single file)
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/dispatcher-conference.test.ts

# the dispatcher-adjacent suites
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/

# config + boot order
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/config.test.ts src/boot-order.test.ts

# gate
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

All three Slack env stubs are required (`SLACK_BOT_TOKEN` is the one that actually trips config loading).

### Harness Requirements

Everything needed already exists in `src/channels/dispatcher-conference.test.ts`; nothing new needs standing up beyond the fake-timer block below.

- `makeMockRegistry()` — roster `jasper` / `river` / `jessica` (+ `executive-assistant` default which **owns the `general` channel**, `chief-of-staff` disabled). `findAllByName` drives roster construction, so the trigger text must name every intended member. **For a non-conference fan-out case (T4a) use label `"random"`, not `"general"`** — `general` is owned by `executive-assistant` and would take the dedicated-channel single-dispatch path.
- `makeMockAgentManager()` — `runWorkItemTurn`, `_sessionRefs` / `_sessionStore` (`get` / `setMeetingMark` / `clearMeetingMark`), `circuitBreakers.stateFor`, `providerFor`, `turnDeadlineUpperBoundMs`.
- `makeMockAdapter()` — `deliver` is a `vi.fn()` recording every post. `makeMockSlackAdapter()` — seedable `fetchThreadHistory`.
- Suite-scoped after KPR-416's hoist: `turn(...)`, `zeroUsage`, `settleReactions`, `seedRef(...)`, `makeHistory(...)`, `PREAMBLE(...)`, `soloClassifier()`, `excludedFor(...)`.
- Conference routing needs a slack source whose `label` starts with `conf-` (`dispatcher.ts:1176`).
- Outage wiring pattern: `dispatcher.setOutageHandling({ store, episodes: new OutageEpisodeTracker(), config })` — in-file precedent at `dispatcher-conference.test.ts:1042-1064`.
- Scribe stub pattern: in-file precedent at `dispatcher-conference.test.ts:1403-1410` (`{ getSummary: vi.fn(), noteActivity: vi.fn() }` → `dispatcher.setMeetingScribe(scribe as any)`).

**Two harness preconditions (spec §9), stated once so they are not rediscovered case by case:**

**(1) The lever must be armed.** `meetingAckEnabled` defaults to **`false`** on the dispatcher (fail-closed, §5.6) and the conference harness never wires `index.ts`. So **every** case expecting an ack to post — T1, T8, T9(b)(c), T10, T11 — must have `dispatcher.setMeetingAckEnabled(true)` in setup. It goes in the ack describe-block's `beforeEach`; the negative-lever cases (T5's `false` row, T7a) override in-test. T5 seeds an ack-*shaped* fixture rather than posting one, so it is lever-independent by design — which is exactly what its `false` row pins. **A missing call makes every positive case pass vacuously as "no ack posted" — precisely the failure mode T1's negative-verify exists to catch.**

**(2) Fake timers, scoped, async-only.** Install `vi.useFakeTimers()` in the ack describe-block's `beforeEach` and `vi.useRealTimers()` in its `afterEach`, so the rest of the file keeps its real-timer `settleReactions` untouched and **no existing test changes.** Inside that block:

- Use **only** `await vi.advanceTimersByTimeAsync(...)`, **never** the synchronous `vi.advanceTimersByTime`. `advanceTimersByTimeAsync` yields a real macrotask boundary between ticks (`@sinonjs/fake-timers`' `tickAsync` schedules its own continuation on the *original* `setTimeout`), which is exactly the drain semantics `settleReactions` provides per its own comment at `dispatcher-conference.test.ts:613-622`.
- Define the alias, commented with a pointer to `:623`:
  ```ts
  /** KPR-417: the fake-timer equivalent of the suite's real-timer
   *  `settleReactions` (:623) — NOT a second mechanism. Under
   *  vi.useFakeTimers() the suite's `new Promise(r => setTimeout(r, 0))`
   *  drain is itself captured by the fake clock and never resolves, so a
   *  naive useFakeTimers() + settleReactions() combination deadlocks.
   *  advanceTimersByTimeAsync(0) provides the same macrotask boundary. */
  const settleAcked = () => vi.advanceTimersByTimeAsync(0);
  ```
- **Do not use `vi.waitFor` inside the ack block** — **not because it deadlocks (it does not).** Verified against the installed vitest 4.1.11 source (`node_modules/vitest/dist/chunks/test.DNmyFkvJ.js:3359-3400`): `waitFor` destructures its timers from `getSafeTimers()` — the *native, unfaked* timers stashed before `useFakeTimers()` installs — so its own polling is never captured by the fake clock, and it additionally calls `if (vi.isFakeTimers()) vi.advanceTimersByTime(interval)` inside its `checkCallback`. It **explicitly supports fake timers by design.** The reason to avoid it here is the opposite problem: it *fights these tests for control of the clock.* Each poll cycle auto-advances the fake clock by the polling `interval` (50ms), **synchronously**, through the exact bare `vi.advanceTimersByTime` API this block otherwise forbids — perturbing the very clock T1/T3/T8-T12 are stepping deliberately across a 15s threshold. Drive every drain with `settleAcked()` / `advanceTimersByTimeAsync(n)` instead. (Outside the block, existing tests keep `vi.waitFor` unchanged.)
- Canonical timing sequence: arm (dispatch **without awaiting**, with a manually-settled `runWorkItemTurn` promise) → `await settleAcked()` (let dispatch reach the turn await) → `await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS)` → assert the ack → settle the turn → `await dispatched` → `await settleAcked()` → assert the downstream (answer, notice, leg, or reaction).
- **Sanctioned fallback if a single case is still stubborn:** `vi.useFakeTimers({ shouldAdvanceTime: true })` for that case alone. Do **not** fall back to real timers with a literal 15s wait, and do **not** lower `MEETING_ACK_DELAY_MS` for tests.

### Non-Required Rationale

- **Integration:** the change adds no I/O, no collection, no cross-module call. The one new config key is a pure liberal-loader function exercised directly in `config.test.ts`; the one new boot line is text-scanned by `boot-order.test.ts`. The ack's delivery path is `adapter.deliver` — the same seam every existing dispatcher test already mocks. A Mongo- or Slack-backed integration test would add nothing the unit suite does not pin.
- **E2E:** the behavior is a multi-agent Slack meeting race with a 15s threshold. There is no E2E harness for conference threads in this repo; the spec's own testing contract (§9) scopes all coverage to `dispatcher-conference.test.ts` / `config.test.ts` / `boot-order.test.ts`. Building one would be slower and less trustworthy than T1/T5.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Negative-verify obligation (mandatory, spec §9) — scoped to T1 and T5 ONLY.** Each of Task 4 and Task 3 carries an explicit revert → run → confirm-fail → re-apply → confirm-pass step. Every other case is coverage that passes on both old and new code, most of them **vacuously** pre-fix (no ack exists, so "no ack was posted" is trivially true). The table below labels each so a reviewer never mistakes a vacuous pass for a guarantee.
- **T5 must additionally guard against a vacuous pass** (`kpr-387-spec.md:155` hazard): its fixture must contain at least one **non-ack** message, and each sub-assertion must assert that message **is** present in the consumer's payload — so "everything got filtered" cannot pass as "acks got filtered."

  | Test | Pre-fix | Why |
  |---|---|---|
  | **T1** | **fails — reachability** | Nothing is ever posted at t=15s; `adapter.deliver` has zero calls when the ack assertion runs. Mandatory demo (Task 4 Step 6). |
  | **T5** (all 5 sub-assertions) | **fails — reachability** | Nothing strips the ack-shaped fixture: it appears in the full arm's `threadContext`, in the delta, in the classifier's `recentMessages`, in `noteActivity`'s history, and its ts becomes the mark. Mandatory demo (Task 3 Step 6). |
  | T2 | passes on both — **vacuous pre-fix** | "no ack posted" is trivially true with no ack mechanism. |
  | T3 | passes on both — **vacuous pre-fix** | Same. But it is the load-bearing guard for the one contract this feature could break (KPR-389 §D5 goal 5). |
  | T4(a) | passes on both — **vacuous pre-fix** | Post-fix it is the case that actually exercises the `resolved`-based gate; pre-fix there is no gate. |
  | T4(b) | passes on both — **vacuous by construction, even post-fix** | The replay takes the single-dispatch leg, which has no ack wrapper at all. It pins *leg-level* absence (§5.2), **not** the meta-vs-`resolved` gate. Must be commented as such. |
  | T7(a) | passes on both — **vacuous pre-fix** | |
  | T7(b) | **fails — structurally absent** | `ackEnabled` is not a key; the resolver returns an object without it. Compile/shape failure, not a behavior signal. |
  | T8 / T9 / T10 / T11 / T12 | pass on both — **vacuous pre-fix** for every "ack present" half; the "no retraction / no second post" halves are trivially true. | These are failure-path coverage, per spec §6. |
  | T13 | **fails — structurally absent** | The scanned symbols do not exist pre-fix. Drift catcher only. |
  | T14 | **fails — structurally absent** | The anchor string is not in `index.ts` pre-fix. |

---

## Task ordering rationale

Tasks 1-2 are pure plumbing (config key + a fail-closed field, setter and boot wiring) with **no reader of the flag yet** — every intermediate commit is behaviorally identical to today. Task 3 lands the recognition + strip half, which is independently meaningful and independently negative-verifiable (T5) **without any ack ever being posted**. Task 4 lands the ack mechanism itself and its negative-verify (T1). Tasks 5-8 are test-only. Task 9 is docs + gate.

Do **not** reorder Task 4 ahead of Task 3: T5's fixture-seeded approach means the strip does not depend on the ack existing, but the reverse is not true — an ack posted before the strip exists would immediately pollute the classifier window and the mark in any test that re-fetches history.

---

### Task 0: Environment and KPR-416 baseline check

**Files:** none.

- [ ] **Step 1:** Install dependencies (this worktree has no `node_modules`).
```bash
cd /Users/mokie/github/hive-KPR-415 && npm ci
```

- [ ] **Step 2:** Verify the baseline suite is green before touching anything.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/ src/config.test.ts src/boot-order.test.ts
```
Expected: all files pass, `0 failed`. **Record the passing test count** — it is the baseline for "no regressions".

- [ ] **Step 3:** **Confirm the KPR-416 baseline this plan assumes.** Run:
```bash
cd /Users/mokie/github/hive-KPR-415
grep -c "markReactionExclusion" src/channels/dispatcher.ts
grep -n "meetingExclusionTs" src/channels/dispatcher.ts | head -3
grep -n "const excludedFor\|function turn(\|const settleReactions\|const makeHistory\|const seedRef" src/channels/dispatcher-conference.test.ts
```
Expected: `markReactionExclusion` appears **4** times (1 definition + 3 call sites); `meetingExclusionTs` is present in the conference meta block; and `turn` / `settleReactions` / `makeHistory` / `seedRef` / `excludedFor` all resolve at the **suite scope** of `describe("Conference channel routing")` (i.e. their definitions precede the first nested `describe` at what was `:574`).

**If `markReactionExclusion` is absent**, KPR-416 has not landed — **stop and report a blocker**; this plan's ⚠ POST-416 SHIFT notes assume it has.
**If the helpers are still inside nested describes** (the hoist was descoped), note it here and perform the hoist as Task 4 Step 0 exactly as KPR-416 Task 3 Step 2 specifies (move, don't copy). Do not duplicate them.

- [ ] **Step 4:** No commit (nothing changed).

---

### Task 1: The `ackEnabled` config lever

**Files:**
- Modify: `src/workers/worker-pool-config.ts:19-44` (interface) and `:46-61` (defaults)
- Modify: `src/config.ts:118-135` (the `resolveMeetingWorkersConfig` return object)
- Test: `src/config.test.ts` — new `it` alongside the KPR-409 scribe cases (`:228-277`)

Untouched by KPR-416 (which adds no config key at all — its own out-of-scope table forbids one). No shift risk.

- [ ] **Step 1:** Add the field to `MeetingWorkersConfig`. Insert **after** the `enabled` member (`worker-pool-config.ts:19-23`), before the `// --- KPR-409 scribe (Part B) ---` divider.

Replace:
```ts
  enabled: boolean;

  // --- KPR-409 scribe (Part B) ---
```
with:
```ts
  enabled: boolean;

  // --- KPR-417 delay-then-ack (Child B1) ---
  /** false ⇒ a slow round-0 conference turn posts no acknowledgment. The
   *  rollback lever for KPR-417 — it changes VISIBLE meeting output (up to N
   *  messages per human trigger), so an operator must be able to silence it
   *  without a deploy (spec §10).
   *
   *  ⚠ DELIBERATELY INDEPENDENT OF `enabled`, unlike `scribeEnabled`. The
   *  scribe genuinely consumes pool machinery (runRoleTurn / hasCapacity), so
   *  the worker master switch must kill it. The ack consumes NO pool machinery
   *  at all — it lives in this section for config locality only. Gating it
   *  under `enabled` would mean an operator disabling fetch-workers silently
   *  loses an unrelated UX feature. Spec §5.6; pinned by config.test.ts.
   *
   *  Note the RECOGNITION FILTER is not gated on this flag at all (see
   *  Dispatcher.fetchMeetingHistory): flipping the lever off must not un-hide
   *  acks that are already sitting in a live thread. */
  ackEnabled: boolean;

  // --- KPR-409 scribe (Part B) ---
```

- [ ] **Step 2:** Add the default. In `DEFAULT_MEETING_WORKERS_CONFIG`, insert after `enabled: true,`:
```ts
  enabled: true,
  ackEnabled: true,
```

- [ ] **Step 3:** Add the resolver line in `src/config.ts`. Insert immediately after the `enabled:` line in the return object of `resolveMeetingWorkersConfig` (`:125`), before the `// KPR-409 scribe keys` comment.

Replace:
```ts
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    // KPR-409 scribe keys — same liberal-loader idioms; no TTL clamp (the
```
with:
```ts
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    // KPR-417: same liberal-loader idiom as `enabled`/`scribeEnabled`, and no
    // clamp interaction. Resolved INDEPENDENTLY of `enabled` — this key is in
    // the meetingWorkers section for locality, not because it is a worker
    // feature (spec §5.6). Do not nest it under `enabled`.
    ackEnabled: typeof r.ackEnabled === "boolean" ? r.ackEnabled : d.ackEnabled,
    // KPR-409 scribe keys — same liberal-loader idioms; no TTL clamp (the
```

- [ ] **Step 4:** Add **T7(b)** to `src/config.test.ts`, immediately after the last KPR-409 scribe case (ends `:277`, before the closing `});` of `describe("resolveMeetingWorkersConfig (KPR-390)")`).

```ts
  it("KPR-417: ackEnabled defaults on, resolves liberally, and is INDEPENDENT of `enabled`", () => {
    // Absent section / absent key ⇒ default true.
    expect(resolveMeetingWorkersConfig(undefined).ackEnabled).toBe(true);
    expect(resolveMeetingWorkersConfig({}).ackEnabled).toBe(true);
    expect(resolveMeetingWorkersConfig({ workerModel: "opus" }).ackEnabled).toBe(true);

    // Explicit false honored.
    expect(resolveMeetingWorkersConfig({ ackEnabled: false }).ackEnabled).toBe(false);

    // Non-boolean garbage falls back to the default (liberal loader, KPR-225 F3).
    expect(resolveMeetingWorkersConfig({ ackEnabled: "no" }).ackEnabled).toBe(true);
    expect(resolveMeetingWorkersConfig({ ackEnabled: 0 }).ackEnabled).toBe(true);
    expect(resolveMeetingWorkersConfig({ ackEnabled: null }).ackEnabled).toBe(true);

    // ⚠ THE INDEPENDENCE PIN (spec §5.6). `scribeEnabled` is nested under
    // `enabled` because the scribe consumes pool machinery; the ack consumes
    // none. Disabling fetch-workers must NOT silently kill the ack. If a
    // future edit nests ackEnabled under `enabled`, this line fails.
    expect(resolveMeetingWorkersConfig({ enabled: false }).ackEnabled).toBe(true);
    expect(resolveMeetingWorkersConfig({ enabled: false }).enabled).toBe(false);
  });
```

- [ ] **Step 5:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && npm run typecheck && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/config.test.ts
```
Expected: typecheck exits 0 — **but note `tsconfig.json:18` excludes `src/**/*.test.ts` entirely, so `npm run typecheck` gives no type-safety signal for the new test case itself; eslint is the only static gate on test files in this repo.** The real signal here is `config.test.ts` all green including the new `KPR-417` case.

The existing `toEqual(DEFAULT_MEETING_WORKERS_CONFIG)` assertions still pass with **zero edits** — there are **six** of them (`:167-170` — four in one `it`, `:204`, `:221`) plus two spread forms (`:191`, `:223`) and one field read (`:276`). All of them compare against (or spread) the constant, which now carries `ackEnabled: true`, so none needs touching. Confirm all six/two/one are green rather than only spot-checking two.

- [ ] **Step 6:** Commit.
```bash
git add src/workers/worker-pool-config.ts src/config.ts src/config.test.ts
git commit -m "feat(kpr-417): add meetingWorkers.ackEnabled config lever

Defaults on. Deliberately independent of meetingWorkers.enabled (the ack
consumes no pool machinery, unlike the scribe) — pinned by config.test.ts.
No reader yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Dispatcher flag, setter, boot wiring, and the boot-order anchor (T14)

**Files:**
- Modify: `src/channels/dispatcher.ts:133-135` (field) and `:186-188` (setter)
- Modify: `src/index.ts:459-464` (wiring + log)
- Test: `src/boot-order.test.ts:43-53`, `:56-60`, `:81-85` (all three anchor lists)

> **⚠ POST-416 SHIFT:** KPR-416 rewrites the *comment* above `meetingReactionTracker` (`:130-133`) but leaves the declaration line byte-identical. Anchor on the declaration + the blank line + `private static readonly DEDUP_TTL_MS`, which is stable across 416.

- [ ] **Step 1:** Add the fail-closed field. Insert between the `meetingReactionTracker` declaration and the `DEDUP_TTL_MS` static.

Replace:
```ts
  private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();

  private static readonly DEDUP_TTL_MS = 60_000; // 1 minute TTL for dedup entries
```
with:
```ts
  private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();
  /** KPR-417: delay-then-ack master switch, mirrored from
   *  config.meetingWorkers.ackEnabled by index.ts. FAIL-CLOSED default: an
   *  unwired dispatcher (a test harness, or a mis-ordered boot) posts no acks
   *  rather than misbehaving. Read per turn inside dispatchToAgent, which is
   *  why its wiring belongs above index.ts's spawn-capable boundary (KPR-414).
   *  Note the recognition filter in fetchMeetingHistory is deliberately NOT
   *  gated on this flag — spec §5.5. */
  private meetingAckEnabled = false;

  private static readonly DEDUP_TTL_MS = 60_000; // 1 minute TTL for dedup entries
```

- [ ] **Step 2:** Add the setter immediately after `setMeetingScribe` (`:186-188`).

Replace:
```ts
  setMeetingScribe(scribe: MeetingScribe): void {
    this.meetingScribe = scribe;
  }
```
with:
```ts
  setMeetingScribe(scribe: MeetingScribe): void {
    this.meetingScribe = scribe;
  }

  /** KPR-417: mirror config.meetingWorkers.ackEnabled. Wired in index.ts
   *  ABOVE the spawn-capable boundary (KPR-414) — the flag is a spawn-read
   *  fact. Belt-and-braces rather than load-bearing: conference dispatch is
   *  unreachable until setSlackAdapter runs, well below the boundary, and the
   *  fail-closed default degrades a mis-wire to "no acks", never to a fault. */
  setMeetingAckEnabled(enabled: boolean): void {
    this.meetingAckEnabled = enabled;
  }
```

- [ ] **Step 3:** Wire it in `src/index.ts`, immediately after `dispatcher.setMeetingScribe(meetingScribe);` (`:459`) and **above** the `── Spawn-capable boundary ──` marker (`:466`). Also add the flag to the adjacent `log.info`.

Replace:
```ts
  dispatcher.setMeetingScribe(meetingScribe);
  log.info("Meeting scribe wired", {
    scribeEnabled: config.meetingWorkers.scribeEnabled,
    scribeModel: config.meetingWorkers.scribeModel,
    scribeMaxConcurrent: config.meetingWorkers.scribeMaxConcurrent,
  });
```
with:
```ts
  dispatcher.setMeetingScribe(meetingScribe);
  // KPR-417: the delay-then-ack lever is a SPAWN-READ fact (dispatchToAgent
  // reads it per turn), so it is wired here, above the spawn-capable boundary
  // below — same rule as the pool and the scribe. Guarded by
  // src/boot-order.test.ts, which carries this call as an anchor in all three
  // of its lists.
  dispatcher.setMeetingAckEnabled(config.meetingWorkers.ackEnabled);
  log.info("Meeting scribe wired", {
    scribeEnabled: config.meetingWorkers.scribeEnabled,
    scribeModel: config.meetingWorkers.scribeModel,
    scribeMaxConcurrent: config.meetingWorkers.scribeMaxConcurrent,
    ackEnabled: config.meetingWorkers.ackEnabled,
  });
```

- [ ] **Step 4:** Add **T14** — the anchor in **all three** lists of `src/boot-order.test.ts`, per that file's own "bound on the **latest** anchor" rule.

> **⚠ Read `boot-order.test.ts`'s own header warning before editing: "Any edit to this test's regex/allowlist logic deserves an adversarial pass, not a skim" (it was independently broken and fixed four times during KPR-414 review). This edit adds anchors only — it must NOT touch the regex at `:107`, the allowlist at `:89`, or the `offsetOf` helper.**

  1. In `it("(a) named wiring and surface anchors are all present")`, add after the `setMeetingScribe` line:
```ts
    offsetOf("dispatcher.setMeetingScribe(");
    offsetOf("dispatcher.setMeetingAckEnabled(");
```
  2. In `it("(b) wiring precedes every named spawn-capable surface")`, add to `wiringOffsets`:
```ts
    const wiringOffsets = [
      offsetOf("agentManager.setWorkerPool("),
      offsetOf("await workerPool.ensureIndexes()"),
      offsetOf("dispatcher.setMeetingScribe("),
      offsetOf("dispatcher.setMeetingAckEnabled("),
    ];
```
  3. In `it("(c) no unallowlisted spawn-capable start precedes the wiring (superset sweep)")`, add to the `wiringStart` `Math.max`:
```ts
    const wiringStart = Math.max(
      offsetOf("agentManager.setWorkerPool("),
      offsetOf("await workerPool.ensureIndexes()"),
      offsetOf("dispatcher.setMeetingScribe("),
      offsetOf("dispatcher.setMeetingAckEnabled("),
    );
```

  **Why all three, and why (c) matters most:** (a) is presence-only. (b) bounds every named surface on the **latest** wiring anchor, so adding mine to `wiringOffsets` (not `surfaceOffsets`) is what makes the ordering claim real. (c)'s `wiringStart` must also take the new anchor, because it is now the **last** wiring call in the file — leaving it out would let a `.start()` inserted between `setMeetingScribe` and `setMeetingAckEnabled` pass green, which is the exact hole KPR-414's round-1 review found empirically.

- [ ] **Step 5:** Verify — and **adversarially verify (c)**, per the file's warning.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/boot-order.test.ts && npm run typecheck
```
Expected: all 3 boot-order tests green; typecheck exits 0.

Then the adversarial pass — temporarily insert a fake spawn-capable surface **between** `dispatcher.setMeetingScribe(...)` and `dispatcher.setMeetingAckEnabled(...)` in `index.ts`:
```ts
  await bogusSurface.start();
```
Re-run `boot-order.test.ts`. Expected: **(c) FAILS** with `offenders: ["bogusSurface.start("]`. (It will also fail typecheck — that is fine and expected; read the vitest output, which runs independently of `tsc`.) **Remove the line and re-run — all three green.** Record the observed failure message. If (c) passes with the bogus line present, the `wiringStart` edit is wrong — fix it before proceeding.

- [ ] **Step 6:** Commit.
```bash
git add src/channels/dispatcher.ts src/index.ts src/boot-order.test.ts
git commit -m "feat(kpr-417): wire ackEnabled into the dispatcher above the spawn boundary

Fail-closed default on the dispatcher (an unwired harness posts no acks).
The wiring is a spawn-read fact, so it sits above index.ts's spawn-capable
boundary; boot-order.test.ts gains the anchor in all three of its lists,
including (c)'s wiringStart Math.max — adversarially verified with an
inserted surface between the two adjacent wiring calls.

No reader of the flag yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Recognition + the single strip point (T5 — NEGATIVE-VERIFY, folding T6)

**Files:**
- Modify: `src/channels/dispatcher.ts:54-59` (module scope, beside `NON_RESPONSE_PATTERNS`)
- Modify: `src/channels/dispatcher.ts:1569-1582` (`resolveConferenceAgents` fetch) — ⚠ POST-416 SHIFT: this line number is pre-416 and will be wrong; **anchor on the quoted verbatim text in Step 3**
- Modify: `src/channels/dispatcher.ts:1923-1944` (`triggerConferenceReactions` fetch) — ⚠ POST-416 SHIFT: same; **anchor on the quoted verbatim text in Step 4**
- Modify: `src/channels/dispatcher.ts` — new `fetchMeetingHistory` private method
- Modify: `src/channels/slack-adapter.ts:198-202` (pointer comment only)
- Test: `src/channels/dispatcher-conference.test.ts` — new `describe` with T5's five sub-assertions × 2 lever rows

- [ ] **Step 1:** Add the constants and the recognizer at module scope, immediately after `NON_RESPONSE_PATTERNS` (`:55-59`).

Replace:
```ts
/** Patterns that indicate the agent chose not to respond — suppress delivery */
const NON_RESPONSE_PATTERNS = [
  /^no response (requested|needed|required|necessary)\.?$/i,
  /^\(no response\)$/i,
  /^n\/a\.?$/i,
];
```
with:
```ts
/** Patterns that indicate the agent chose not to respond — suppress delivery */
const NON_RESPONSE_PATTERNS = [
  /^no response (requested|needed|required|necessary)\.?$/i,
  /^\(no response\)$/i,
  /^n\/a\.?$/i,
];

/**
 * KPR-417: the exact sentence the delay-then-ack posts (spec §5.3), and the
 * pattern that recognizes it back off the thread transcript.
 *
 * ⚠ THE TWO MUST CHANGE IN LOCKSTEP, exactly as NON_RESPONSE_PATTERNS pins
 * "No response needed." Exported (unlike NON_RESPONSE_PATTERNS, which is
 * module-private and which the suite deliberately mirrors by hand at
 * dispatcher-conference.test.ts:556 / dispatcher.test.ts:283) because this
 * constant sits on BOTH sides of a two-sided contract: T1 asserts these bytes
 * were posted and T5 seeds a fixture message that these bytes must strip. A
 * hand-mirrored copy would let T5 keep passing while the real posted text
 * drifted away from it — the exact drift the strip exists to prevent.
 *
 * ⚠ WORDING IS LOAD-BEARING, NOT COSMETIC (spec §5.3). The ack must be true at
 * every instant it can fire, including one that is easy to miss: the
 * per-thread lock spin-waits BEFORE the breaker permit is acquired
 * (agent-manager.ts), so an acked turn may be queued behind a sibling on the
 * same `agentId:threadId` rather than generating anything. Any wording
 * asserting work is happening RIGHT NOW ("looking into this", "working on
 * it") is false in that window. "Picked this up" claims only assignment,
 * which is true from selection through the lock wait, the breaker acquire and
 * the model call alike. It is a statement of STATE, not a promise of a reply
 * — which is what makes the "an ack is never retracted" rule (§6.4) liveable.
 * A bare "On it." is equally honest but was rejected on collision surface: a
 * whole agent reply of exactly "On it." is plausible in a conference thread,
 * while the two-clause sentence is not.
 *
 * Verified byte-identical round-trip through markdownToMrkdwn
 * (response-formatter.ts:5-22 — no header, bold, link, strikethrough or rule
 * construct present), which the recognition pattern depends on.
 */
export const MEETING_ACK_TEXT = "On it — picked this up.";

/** KPR-417: ~3x the observed fast band (2-5s), far below the ~130s case, and
 *  far below both the round-1 clamp (REACTION_TIMEOUT_MS = 120_000) and any
 *  turn deadline. Exported so tests advance the fake clock by exactly this
 *  value rather than a hand-mirrored literal (spec §9). NOT configurable —
 *  only `ackEnabled` ships (spec §5.6). Setting it to 0 behaves as an
 *  immediate ack, which is the one-line rollback if the operator prefers the
 *  literal "got it" she originally asked for. */
export const MEETING_ACK_DELAY_MS = 15_000;

/** SlackAdapter.deliver prefixes agent posts with `${icon} *${Name}*: `
 *  (icon optional when the agent has none, absent entirely when the agent was
 *  deleted mid-turn). Mirrors the author-extraction regex at
 *  slack-adapter.ts:222, widened to make the icon optional. */
const AGENT_PREFIX_RE = /^(?:\S+\s+)?\*[^*]+\*:\s*/;
const MEETING_ACK_PATTERNS = [/^on it\s*—\s*picked this up\.?$/i];

/**
 * KPR-417: is this thread message an engine-authored ack? Anchored `^…$` on
 * the whole body, so a real reply that merely BEGINS with the sentence is not
 * stripped; `isBot` gates out any human typing it. Exported alongside
 * MEETING_ACK_TEXT so the anchored-regex bound is unit-assertable without
 * routing through a full dispatch.
 *
 * ⚠ Accepted residual (spec §5.4): an agent whose ENTIRE reply is exactly the
 * ack sentence has that message stripped from meeting history. Bounded to one
 * near-contentless message; the identical hazard already exists and is
 * accepted repo-wide for NON_RESPONSE_PATTERNS; and the meeting preamble
 * steers agents toward "No response needed.", not toward this sentence.
 */
export function isMeetingAck(m: ThreadMessage): boolean {
  if (!m.isBot) return false;
  return MEETING_ACK_PATTERNS.some((p) => p.test(m.text.replace(AGENT_PREFIX_RE, "").trim()));
}
```

> **Import note:** `ThreadMessage` is already type-imported at `dispatcher.ts:17`. No import change is needed. `isMeetingAck` is a module-scope function placed **after** the interface import — hoisting is irrelevant since it is only called from instance methods.

- [ ] **Step 2:** Add the `fetchMeetingHistory` wrapper. Place it immediately **before** `resolveConferenceAgents` (find `private async resolveConferenceAgents(` and insert above its doc comment / declaration).

```ts
  /**
   * KPR-417: the ONLY meeting history fetch in this class. Acks are
   * operational chrome, not meeting content — stripping here makes all five
   * consumers ack-blind with NO per-consumer edits:
   *   1. the full arm (formatThreadContext),
   *   2. the delta arm (formatDeltaContext),
   *   3. the meetingLastSeenTs high-water calc  — all three via buildConferenceContext,
   *   4. the round-0 classifier's `history.slice(-5)` recency window,
   *   5. the meeting scribe's noteActivity (novelty count + summary prompt).
   *
   * ⚠ DELIBERATELY NOT GATED ON `meetingAckEnabled`: flipping the lever off
   * must not un-hide acks that are already sitting in a live thread (spec
   * §5.5 / §10 — the rollback is clean at both ends). Pinned by the
   * `ackEnabled: false` row of T5.
   *
   * ⚠ ANY NEW MEETING-HISTORY READ MUST COME THROUGH HERE. A direct
   * slackAdapter call would silently re-expose acks to that consumer. Pinned
   * structurally by T13(a).
   *
   * The strip lives here rather than in SlackAdapter because "is this an ack"
   * is a MEETING-domain fact; the channel-domain adapter should keep returning
   * what Slack actually has (an agent reading the channel with its own `slack`
   * MCP tools sees the acks verbatim, and that is expected — spec §8).
   *
   * Exact factoring, not a behavior change for non-ack messages: both former
   * call sites computed this identical channelId/threadTs pair, and the
   * no-slackAdapter branch returns [] exactly as the old `let history = []`
   * initialization did.
   */
  private async fetchMeetingHistory(item: WorkItem, threadId: string): Promise<ThreadMessage[]> {
    if (!this.slackAdapter) return [];
    const threadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string) ?? threadId;
    const history = await this.slackAdapter.fetchThreadHistory(item.source.id, threadTs);
    return history.filter((m) => !isMeetingAck(m));
  }
```

- [ ] **Step 3:** Replace call site 1 in `resolveConferenceAgents` (`:1569-1582`).

Replace:
```ts
    // Fetch thread history once per trigger — per-agent injection contexts
    // (full vs delta, KPR-388) are derived from it after classification.
    let history: ThreadMessage[] = [];
    let recentMessages = "";
    if (this.slackAdapter) {
      const channelId = item.source.id;
      const threadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string) ?? threadId;
      history = await this.slackAdapter.fetchThreadHistory(channelId, threadTs);
      // Last 5 messages for classifier recency context
      recentMessages = history
        .slice(-5)
        .map((m) => `${m.author}: ${m.text.slice(0, 200)}`)
        .join("\n");
    }
```
with:
```ts
    // Fetch thread history once per trigger — per-agent injection contexts
    // (full vs delta, KPR-388) are derived from it after classification.
    // KPR-417: via fetchMeetingHistory, which strips engine-authored acks.
    // Behaviorally identical for non-ack messages, including the
    // no-slackAdapter case ([] history ⇒ "" recentMessages, as before).
    const history = await this.fetchMeetingHistory(item, threadId);
    // Last 5 messages for classifier recency context
    const recentMessages = history
      .slice(-5)
      .map((m) => `${m.author}: ${m.text.slice(0, 200)}`)
      .join("\n");
```

> `history` and `recentMessages` are never reassigned later in this method — verified — so `let` → `const` is safe.

- [ ] **Step 4:** Replace call site 2 in `triggerConferenceReactions` (`:1923-1944`). Note the `if (this.slackAdapter)` block here also gates `allRosterMembers` and `preamble`, so the guard **stays** — only the history fetch is lifted out.

Replace:
```ts
    // Re-fetch thread history (now includes the round-0 response); per-reactor
    // injection contexts (full vs delta, KPR-388) are derived from it below.
    let history: ThreadMessage[] = [];
    const allRosterMembers: RosterMember[] = [];
    let preamble = "";
    if (this.slackAdapter) {
      const channelId = originalItem.source.id;
      const threadTs =
        (originalItem.meta?.slackThreadTs as string) ?? (originalItem.meta?.slackTs as string) ?? threadId;
      history = await this.slackAdapter.fetchThreadHistory(channelId, threadTs);
      for (const agentId of roster) {
```
with:
```ts
    // Re-fetch thread history (now includes the round-0 response); per-reactor
    // injection contexts (full vs delta, KPR-388) are derived from it below.
    // KPR-417: via fetchMeetingHistory, which strips engine-authored acks —
    // including any ack this very trigger's round-0 responders posted.
    const history = await this.fetchMeetingHistory(originalItem, threadId);
    const allRosterMembers: RosterMember[] = [];
    let preamble = "";
    // The guard stays: it also gates allRosterMembers and the preamble, whose
    // "no slack adapter ⇒ empty roster, empty preamble" behavior is unchanged.
    if (this.slackAdapter) {
      for (const agentId of roster) {
```

> The former `channelId` / `threadTs` locals are dropped. Verified they are not referenced later in the method — the `noteActivity` seam below recomputes `originalItem.source.id` and the `slackThreadTs` fallback inline.

- [ ] **Step 5:** Add the pointer comment in `src/channels/slack-adapter.ts`, on `fetchThreadHistory`'s doc comment (`:198-202`).

Replace:
```ts
  /**
   * Fetch thread replies for context injection into conference channel agents.
   * Returns messages formatted with author names and timestamps.
   */
  async fetchThreadHistory(channelId: string, threadTs: string): Promise<ThreadMessage[]> {
```
with:
```ts
  /**
   * Fetch thread replies for context injection into conference channel agents.
   * Returns messages formatted with author names and timestamps.
   *
   * KPR-417: this is the CHANNEL-domain read and deliberately returns what
   * Slack actually has, acks included. The MEETING-domain filter that hides
   * engine-authored acknowledgments from the five history consumers lives in
   * `Dispatcher.fetchMeetingHistory` — every meeting-side read must go through
   * that wrapper, never straight to this method.
   */
  async fetchThreadHistory(channelId: string, threadTs: string): Promise<ThreadMessage[]> {
```

- [ ] **Step 6:** Add **T5** (with **T6** folded in as the `ackEnabled: false` row, per spec §9's explicit sanction). Add as a new top-level `describe` inside `describe("Conference channel routing")`, placed after the `T6 (C4 guard)` test (`:552-572`).

```ts
  // -------------------------------------------------------------------------
  // KPR-417 — the ack is invisible to every engine-internal history consumer
  // -------------------------------------------------------------------------
  describe("meeting-ack recognition and the single strip point (KPR-417)", () => {
    // The fixture. THREE messages, of which exactly ONE is ack-shaped and TWO
    // are not — the vacuous-pass guard (kpr-387-spec.md:155): every
    // sub-assertion below asserts the PEER REPLY *is* present as well as that
    // the ack is absent, so "everything got filtered" cannot masquerade as
    // "acks got filtered".
    //
    // The ack's ts is the STRICTLY HIGHEST in the fixture and strictly above
    // the trigger ts — that is what makes the mark sub-assertion (3) real: if
    // the ack survived, it would win maxSlackTs and the mark would be
    // "1000.0009". The prefix on the ack text is the real
    // SlackAdapter.deliver shape (`${icon} *${Name}*: `), which also exercises
    // AGENT_PREFIX_RE.
    const ACK_TS = "1000.0009";
    const TRIGGER_TS = "1000.0003";
    const PEER_TEXT = "The migration is blocked on the schema review.";
    const ackFixture = () =>
      makeHistory([
        { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
        { author: "River", text: `🤖 *River*: ${PEER_TEXT}`, ts: "1000.0002", minAgo: 10, isBot: true },
        { author: "Jasper", text: `🤖 *Jasper*: ${MEETING_ACK_TEXT}`, ts: ACK_TS, minAgo: 1, isBot: true },
      ]);

    /** Fake scribe whose getSummary resolves undefined, so the FULL arm is
     *  preserved (a summary would flip injectionMode to "summary"). Mirrors
     *  the in-file seedScribe precedent at :1403. */
    const seedAckScribe = () => {
      const scribe = { getSummary: vi.fn().mockResolvedValue(undefined), noteActivity: vi.fn() };
      dispatcher.setMeetingScribe(scribe as any);
      return scribe;
    };

    it.each([
      ["with the lever ON", true],
      ["with the lever OFF (T6: the strip is NOT gated on ackEnabled)", false],
    ])(
      "T5 (KPR-417): an ack-shaped message is stripped from the full arm, the mark, the classifier window and the scribe — %s",
      async (_label, lever) => {
        // T6 is folded in as the second row rather than duplicated (spec §9
        // sanctions this). The `false` row is the load-bearing one for §5.5's
        // ruling: flipping the lever off must NOT un-hide acks already in a
        // live thread. If a future edit gates fetchMeetingHistory's filter on
        // meetingAckEnabled, this row fails and the ON row still passes.
        dispatcher.setMeetingAckEnabled(lever);
        await soloClassifier();
        const scribe = seedAckScribe();
        const threadId = `conf-thread-kpr417-t5-${lever}`;
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ackFixture());

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, where are we?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr417-t5" },
            threadId,
            meta: { slackTs: TRIGGER_TS },
          }),
        );

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
        const round0Item = agentManager.runWorkItemTurn.mock.calls[0][1];

        // (1) FULL ARM — the injected threadContext carries the peer reply and
        //     not the ack.
        expect(round0Item.meta.conferenceInjectionMode).toBe("full");
        expect(round0Item.text).toContain(PEER_TEXT); // vacuous-pass guard
        expect(round0Item.text).not.toContain(MEETING_ACK_TEXT);

        // (3) MARK — the high-water calc never saw the ack, so it lands on the
        //     trigger ts, NOT the ack's (which is numerically higher).
        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, TRIGGER_TS);
        expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalledWith(
          "jasper",
          threadId,
          ACK_TS,
        );

        // (4) CLASSIFIER RECENCY WINDOW — third arg to classifyMeetingMessage.
        const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
        const recent = (classifyMeetingMessage as any).mock.calls[0][2] as string;
        expect(recent).toContain(PEER_TEXT); // vacuous-pass guard
        expect(recent).not.toContain(MEETING_ACK_TEXT);

        // (5) SCRIBE — noteActivity's history carries no ack-shaped entry.
        expect(scribe.noteActivity).toHaveBeenCalledTimes(1);
        const scribeHistory = scribe.noteActivity.mock.calls[0][0].history as Array<{ text: string; ts: string }>;
        expect(scribeHistory.map((m) => m.ts)).toEqual(["1000.0001", "1000.0002"]); // vacuous-pass guard
        expect(scribeHistory.some((m) => m.text.includes(MEETING_ACK_TEXT))).toBe(false);
      },
    );

    it("T5 (KPR-417) — sub-assertion (2): the DELTA arm also omits the ack", async () => {
      // Separate `it` because seeding a resumable ref flips injectionMode to
      // "delta", which is mutually exclusive with the full arm above. Mark is
      // seeded BELOW the peer reply's ts so both the peer and the ack are
      // inside the strictly-greater delta window pre-fix.
      dispatcher.setMeetingAckEnabled(true);
      await soloClassifier();
      seedAckScribe();
      const threadId = "conf-thread-kpr417-t5-delta";
      seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0001" });
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ackFixture());

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, where are we?",
          source: { kind: "slack", id: "C-CONF", label: "conf-kpr417-t5" },
          threadId,
          meta: { slackTs: TRIGGER_TS },
        }),
      );

      const round0Item = agentManager.runWorkItemTurn.mock.calls[0][1];
      expect(round0Item.meta.conferenceInjectionMode).toBe("delta");
      expect(round0Item.text).toContain("[New messages since your last turn:]");
      expect(round0Item.text).toContain(PEER_TEXT); // vacuous-pass guard
      expect(round0Item.text).not.toContain(MEETING_ACK_TEXT);
      // The delta's own high-water never saw the ack either.
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, TRIGGER_TS);
    });

    it("T5 (KPR-417) — isMeetingAck is anchored: a reply that merely BEGINS with the sentence is NOT an ack", () => {
      // Unit-level bound on the collision residual (spec §5.4). Exported
      // alongside MEETING_ACK_TEXT precisely so this is assertable without
      // routing through a dispatch.
      const msg = (text: string, isBot = true) => ({ author: "Jasper", text, timestamp: new Date(), isBot, ts: "1" });
      expect(isMeetingAck(msg(MEETING_ACK_TEXT))).toBe(true);
      expect(isMeetingAck(msg(`🤖 *Jasper*: ${MEETING_ACK_TEXT}`))).toBe(true);
      expect(isMeetingAck(msg(`*Jasper*: ${MEETING_ACK_TEXT}`))).toBe(true); // agent with no icon
      expect(isMeetingAck(msg(`  ${MEETING_ACK_TEXT}  `))).toBe(true); // trimmed
      // Anchored: a real reply that starts with the sentence is real content.
      expect(isMeetingAck(msg(`${MEETING_ACK_TEXT} Here is what I found.`))).toBe(false);
      // isBot gates a human typing it.
      expect(isMeetingAck(msg(MEETING_ACK_TEXT, false))).toBe(false);
    });
  });
```

> **Import additions for this task's tests:** add `MEETING_ACK_TEXT` and `isMeetingAck` to the existing `import { Dispatcher } from "./dispatcher.js";` line — i.e. `import { Dispatcher, MEETING_ACK_TEXT, isMeetingAck } from "./dispatcher.js";`. (`MEETING_ACK_DELAY_MS` is added in Task 4.)

- [ ] **Step 7:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && npm run typecheck && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/
```
Expected: typecheck exits 0; every file in `src/channels/` green, including the three new KPR-417 tests (T5's `it.each` runs as 2 cases). **All KPR-387 / KPR-388 / KPR-389 / KPR-409 / KPR-413 / KPR-416 pins pass with zero edits** — the file's total count should be the Task 0 baseline + 4.

> **⚠ Typecheck caveat — do not read false confidence into "typecheck exits 0".** `tsconfig.json:18` excludes `src/**/*.test.ts`, so `npm run typecheck` **never type-checks the new test code at all.** It is a real signal for this task's *source* edits (`dispatcher.ts`, `slack-adapter.ts`) and no signal whatsoever for Step 6's test block. **eslint is the only static gate on test files in this repo** — the `npm run check` in Task 9 is where a test-file type/shape problem would actually surface, via lint and via the tests running.

- [ ] **Step 8:** **NEGATIVE-VERIFY T5 (mandatory).** Revert only the strip — leave the constants, the wrapper and both call sites in place — by neutering the filter, then confirm T5 fails, then restore.

```bash
cd /Users/mokie/github/hive-KPR-415
# Edit dispatcher.ts: in fetchMeetingHistory, change
#     return history.filter((m) => !isMeetingAck(m));
# to
#     return history;
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/dispatcher-conference.test.ts -t "T5 (KPR-417)"
```
Expected: **FAIL**, and the failure must be a **behavior** failure, not a compile error. Specifically:
- both `it.each` rows fail at sub-assertion (1) — `round0Item.text` contains `MEETING_ACK_TEXT`;
- the delta test fails at the same assertion;
- (the anchored-regex unit test still **passes** — it never touches the filter, and that is correct).

Record the exact failing assertion. Then restore the filter line and re-run:
```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/dispatcher-conference.test.ts -t "T5 (KPR-417)"
```
Expected: **PASS**.

> **Why this is the right delta, not a coarser revert.** The claim T5 makes is exactly "the filter runs at the one fetch point." Neutering the filter body isolates that claim while keeping the refactor (the wrapper, the two call sites) intact — a whole-file stash would also remove the wrapper and produce a *compile* failure, which proves nothing about behavior. If you see a compile error, you reverted too much.

- [ ] **Step 9:** Commit.
```bash
git add src/channels/dispatcher.ts src/channels/slack-adapter.ts src/channels/dispatcher-conference.test.ts
git commit -m "feat(kpr-417): recognize meeting acks and strip them at one history-fetch point

MEETING_ACK_TEXT + MEETING_ACK_PATTERNS + isMeetingAck mirror the
NON_RESPONSE_PATTERNS precedent (exported: both sides of a two-sided
contract). fetchMeetingHistory replaces both ThreadMessage[] production
sites, making all five consumers ack-blind in one hunk — full arm, delta
arm, meetingLastSeenTs mark, classifier recency window, scribe.

The strip is deliberately NOT gated on ackEnabled: flipping the lever off
must not un-hide acks already in a live thread (T5's false row).

Negative-verified: T5 fails when the filter is neutered.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: The ack mechanism — arm, fire, cancel (T1 — NEGATIVE-VERIFY; plus T2, T7a)

**Files:**
- Modify: `src/channels/dispatcher.ts` — new `scheduleMeetingAck` / `deliverMeetingAck` / `runTurnWithMeetingAck` private methods, placed immediately before `dispatchToAgent`
- Modify: `src/channels/dispatcher.ts:1399-1400` (the fan-out turn await) — ⚠ POST-416 SHIFT: this line number is pre-416 and will be wrong; **the anchor is the await statement itself**, which KPR-416 does not touch
- Test: `src/channels/dispatcher-conference.test.ts` — new fake-timer `describe` with T1, T2, T7a

- [ ] **Step 0 (conditional):** If Task 0 Step 3 found the KPR-416 hoist missing, perform it now exactly as KPR-416 Task 3 Step 2 specifies (move `turn` / `zeroUsage` / `settleReactions` out of the KPR-389 describe and `seedRef` / `makeHistory` out of the KPR-388 describe, up to suite scope — move, do not copy; do **not** hoist `twoAgentClassifier`). Otherwise skip.

- [ ] **Step 1:** Add the three private methods immediately **before** `dispatchToAgent` (anchor on the line `  /** Dispatch a single work item to a single agent (used for fan-out) */`).

```ts
  /**
   * KPR-417: arm the delayed ack for a slow round-0 conference turn.
   *
   * Returns `undefined` — no timer at all — unless ALL hold:
   *   - the operator lever is on (`meetingAckEnabled`, fail-closed default),
   *   - `resolved.conferenceMode === true`,
   *   - `resolved.conferenceRound === 0`,
   *   - an adapter exists to deliver through.
   *
   * ⚠ THE ROUND-0 GATE IS A CONTRACT, NOT A DEFAULT (spec §5.2). KPR-389 §D5
   * goal 5 — "a clamp-killed reaction never posts noise into the meeting
   * channel" — is violated the INSTANT a round-1 turn acks and is then
   * silently killed by the guard in dispatchToAgent: the ack IS the filler D5
   * forbids, already in the channel before the kill. Honoring round-1 would
   * require an explicit retraction (delete or edit), which spec §6.4 rejects.
   * Do not widen this gate. Pinned by T3.
   *
   * ⚠ THE GATE READS `resolved`, NEVER `item.meta`. That is what makes the
   * other two legs that can carry a round-0 conference turn structurally
   * ack-free, for two DIFFERENT reasons which must not be conflated:
   *   - a KPR-307 outage REPLAY keeps its conference meta (conferenceRound is
   *     load-bearing elsewhere) but runs dispatch()'s single-dispatch leg with
   *     a bare ResolvedAgent and no ack wrapper on it at all;
   *   - a KPR-402 continuation LEG has had the four conference keys stripped
   *     by KPR-413, so it is not a conference turn on either surface.
   * Result: ≤ 1 ack per (agent, human trigger), with no chain and no duplicate
   * across legs.
   */
  private scheduleMeetingAck(
    item: WorkItem,
    resolved: ResolvedAgent,
    agentId: string,
    adapter: ChannelAdapter | undefined,
  ): { cancel: () => void } | undefined {
    if (!this.meetingAckEnabled) return undefined;
    if (resolved.conferenceMode !== true || resolved.conferenceRound !== 0) return undefined;
    if (!adapter) return undefined;

    let cancelled = false;
    const handle = setTimeout(() => {
      // Re-check the latch: cancel() may have run between the clock firing
      // this callback and the callback actually executing.
      if (cancelled) return;
      // Fire-and-forget by construction — never awaited by the turn, never
      // able to reject into it (deliverMeetingAck is a total function).
      void this.deliverMeetingAck(item, agentId, adapter);
    }, MEETING_ACK_DELAY_MS);
    // A pending ack must never hold the process open at shutdown. Existing
    // precedent: index.ts prefixCacheHeartbeat, outage-replay-processor.ts:44.
    handle.unref();

    return {
      cancel: () => {
        cancelled = true;
        clearTimeout(handle);
      },
    };
  }

  /**
   * KPR-417: post one acknowledgment into the meeting thread. Four deliberate
   * properties (spec §5.3):
   *   - `error` UNSET, so SlackAdapter.deliver renders it through
   *     formatResponse, not formatError — same rationale as
   *     deliverOutageNotice's own comment.
   *   - `agentId` SET, so deliver picks up agentConfig and posts with the
   *     agent's username/icon identity and the `${icon} *${Name}*: ` prefix.
   *     Per-agent attribution costs nothing new — and AGENT_PREFIX_RE is built
   *     to strip exactly that prefix back off.
   *   - NOT deliverAgentResult — that begins with tryOutageDiversion, and an
   *     ack diverted to a WS floor broadcast is meaningless. (The symmetric
   *     case, where the ANSWER is diverted away from a thread that already has
   *     the ack, is a named accepted residual — spec §6.6. Do not fix it here.)
   *   - NEVER enqueued to the retry queue on failure. A retried ack lands
   *     minutes later, potentially AFTER the answer. A dropped ack is strictly
   *     better than a late one. Pinned by T12.
   *
   * ⚠ Must go through `adapter.deliver`, never a direct web.chat.postMessage:
   * that path registers the outbound ts (slack-gateway.ts postSingle) and the
   * inbound handler skips on it. Load-bearing, not a nicety — the ack text
   * embeds the agent's own name in its `*Name*:` prefix, and
   * resolveConferenceAgents builds the roster with findAllByName(item.text),
   * so an ack that leaked back through the inbound path would both add its own
   * author to the roster and mint a fresh conference turn.
   */
  private async deliverMeetingAck(item: WorkItem, agentId: string, adapter: ChannelAdapter): Promise<void> {
    const ack: WorkResult = { text: MEETING_ACK_TEXT, agentId, workItem: item, costUsd: 0, durationMs: 0 };
    try {
      await adapter.deliver(ack);
    } catch (err) {
      log.warn("Meeting ack delivery failed — dropped", { agentId, error: String(err) });
    }
  }

  /**
   * KPR-417: arm the delayed ack, run the turn, cancel on ANY settle.
   *
   * ⚠ THE CANCEL LIVES IN THIS HELPER'S `finally` — adjacent to the await — so
   * the ack can never outlive the turn it describes. DO NOT relocate it to a
   * finally around the whole dispatchToAgent body: delivery, the KPR-388 mark
   * write and the outage/deadline gates all run AFTER the turn settles, and a
   * timer still armed across them can post "On it" AFTER the answer. Pinned
   * structurally by T13(b).
   *
   * The one race this cannot close is named and accepted (spec §8): cancel()
   * cannot unpost a deliver already in flight. Worst case is an ack
   * immediately followed by its answer — mildly redundant, never
   * contradictory, since the answer's own delivery begins strictly after the
   * turn settles, i.e. after the ack post already started.
   */
  private async runTurnWithMeetingAck(
    agentId: string,
    item: WorkItem,
    resolved: ResolvedAgent,
    adapter: ChannelAdapter | undefined,
  ): Promise<TurnResult> {
    const ack = this.scheduleMeetingAck(item, resolved, agentId, adapter);
    try {
      return await this.agentManager.runWorkItemTurn(agentId, item);
    } finally {
      ack?.cancel();
    }
  }

  /** Dispatch a single work item to a single agent (used for fan-out) */
```

- [ ] **Step 2:** Wrap the fan-out turn await. **This is the only line of `dispatchToAgent` that changes.**

> **⚠ POST-416 SHIFT:** this statement is at `:1400` pre-416 and **somewhere below that post-416 — do not go looking for a predicted line number.** It is unique in the file, which is what makes a text anchor sufficient: the single-dispatch leg's twin (pre-416 `:329`) uses `item`, not `effectiveItem`. **Anchor on the quoted text.**

Replace:
```ts
      const runResult = this.convertTurnResult(await this.agentManager.runWorkItemTurn(agentId, effectiveItem));
```
with:
```ts
      // KPR-417: the ack wrapper lives HERE and only here — the fan-out leg is
      // the only leg a live conference turn takes. See runTurnWithMeetingAck
      // for why the cancel must stay inside that helper's finally rather than
      // around this whole try block.
      const runResult = this.convertTurnResult(
        await this.runTurnWithMeetingAck(agentId, effectiveItem, resolved, adapter),
      );
```

- [ ] **Step 3:** Add the ack describe-block harness plus **T1**, **T2** and **T7a**. Append as a new top-level `describe` inside `describe("Conference channel routing")`, after the Task 3 `describe`.

```ts
  // -------------------------------------------------------------------------
  // KPR-417 — delay-then-ack: arm, fire, cancel
  //
  // ⚠ FAKE TIMERS ARE SCOPED TO THIS BLOCK ONLY. The rest of the file keeps
  // its real-timer `settleReactions` (:623) untouched and no existing test
  // changes. Inside this block use ONLY the async advancement API — under
  // vi.useFakeTimers() the suite's `new Promise(r => setTimeout(r, 0))` drain
  // is itself captured by the fake clock and never resolves, so a naive
  // useFakeTimers() + settleReactions() combination DEADLOCKS. Also avoid
  // `vi.waitFor` here — NOT because it deadlocks (it does not: it polls on
  // getSafeTimers()' native timers and explicitly supports fake clocks), but
  // because each poll cycle auto-advances the fake clock by its 50ms interval
  // via a bare synchronous vi.advanceTimersByTime — fighting these tests for
  // control of the very clock they step across the 15s threshold. Drive every
  // drain with settleAcked()/advanceTimersByTimeAsync instead.
  // -------------------------------------------------------------------------
  describe("delay-then-ack for slow round-0 conference turns (KPR-417)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Precondition (spec §9): meetingAckEnabled is FAIL-CLOSED false and the
      // conference harness never wires index.ts. Without this line every
      // positive case below passes VACUOUSLY as "no ack posted".
      dispatcher.setMeetingAckEnabled(true);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** KPR-417: the fake-timer equivalent of the suite's real-timer
     *  `settleReactions` (:623) — NOT a second mechanism.
     *  advanceTimersByTimeAsync yields a real macrotask boundary between
     *  ticks, which is precisely the drain semantics settleReactions provides
     *  per its own comment at :613-622. */
    const settleAcked = () => vi.advanceTimersByTimeAsync(0);

    /** A turn that never settles until the test releases it. */
    const hangingTurn = () => {
      let release!: (v: unknown) => void;
      const promise = new Promise((r) => {
        release = r;
      });
      return { promise, release };
    };

    const ackCalls = () =>
      adapter.deliver.mock.calls.filter((c: any[]) => c[0].text === MEETING_ACK_TEXT);

    const confAckItem = (threadId: string, text = "Jasper, where are we?") =>
      makeWorkItem({
        text,
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr417" },
        threadId,
        meta: { slackTs: "1700.0100" },
      });

    it("T1 (KPR-417): a round-0 conference turn unresolved at t=15s posts exactly one attributed ack, then its answer", async () => {
      // THE primary mechanism. Trial observation 2 reproduced: grok's ~130s
      // chairing turn left no signal in Slack that anything was happening.
      await soloClassifier();
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t1"));
      await settleAcked(); // let dispatch reach the turn await (timer armed)

      // Nothing yet — a fast turn must never ack (this is also T2's premise).
      expect(adapter.deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);

      expect(ackCalls()).toHaveLength(1);
      const ack = ackCalls()[0][0];
      expect(ack.text).toBe(MEETING_ACK_TEXT);
      expect(ack.agentId).toBe("jasper"); // attributed — deliver picks up identity
      expect(ack.error).toBeUndefined(); // formatResponse, not formatError
      expect(ack.costUsd).toBe(0);

      // Settle the turn: the answer delivers, and no SECOND ack fires.
      slow.release(turn({ finalMessage: "Here is the long-awaited answer." }));
      await dispatched;
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS); // the timer is dead

      expect(ackCalls()).toHaveLength(1);
      const answers = adapter.deliver.mock.calls.filter((c: any[]) => c[0].text !== MEETING_ACK_TEXT);
      expect(answers).toHaveLength(1);
      expect(answers[0][0].text).toBe("Here is the long-awaited answer.");
      // Ordering is correct BY CONSTRUCTION, not by luck (spec §8): the ack
      // fires at 15s, the answer strictly after, since a faster turn cancels.
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);
    });

    it("T2 (KPR-417): a fast round-0 turn never acks, even after the clock passes the threshold", async () => {
      // No new noise for the 2-5s population — the whole point of
      // delay-then-ack over the operator's literal immediate 'got it'.
      await soloClassifier();
      agentManager.runWorkItemTurn.mockResolvedValueOnce(turn({ finalMessage: "Quick answer." }));

      await dispatcher.dispatch(confAckItem("conf-thread-kpr417-t2"));
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 3);
      await settleAcked();

      expect(ackCalls()).toHaveLength(0);
      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe("Quick answer.");
    });

    it("T7a (KPR-417): with the dispatcher lever OFF, a slow round-0 turn posts no ack", async () => {
      // The operator rollback path (spec §10): ackEnabled: false + restart ⇒
      // no NEW acks. (The strip keeps running regardless — pinned by T5's
      // false row, not here.)
      dispatcher.setMeetingAckEnabled(false);
      await soloClassifier();
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t7a"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 3);

      expect(ackCalls()).toHaveLength(0);
      expect(adapter.deliver).not.toHaveBeenCalled();

      slow.release(turn({ finalMessage: "Eventually." }));
      await dispatched;
      await settleAcked();
      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe("Eventually.");
    });
  });
```

> **Import additions:** add `MEETING_ACK_DELAY_MS` to the `./dispatcher.js` import, and `afterEach` to the `vitest` import at `:1`.

- [ ] **Step 4:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && npm run typecheck && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/
```
Expected: typecheck exits 0; every file in `src/channels/` green including `T1`, `T2`, `T7a`. **No existing test may become slow or flaky** — if any pre-existing test in this file now takes >1s, the fake timers have leaked out of the describe block; fix the `afterEach`, not the test.

> **⚠ Same typecheck caveat as Task 3 Step 7:** `tsconfig.json:18` excludes `src/**/*.test.ts`, so "typecheck exits 0" covers only this task's `dispatcher.ts` edits (Steps 1-2) and says **nothing** about the Step 3 test block. eslint plus the tests actually running are the only gates on the test file.

- [ ] **Step 5:** **Confirm the `.unref()` / fake-timer interaction empirically.** `@sinonjs/fake-timers` (which vitest uses) returns a timer *object* with `ref`/`unref`/`hasRef` when the host `setTimeout` does — which Node's does — so `handle.unref()` is expected to work under both real and fake clocks. T1 passing is the proof. **If T1 instead throws `handle.unref is not a function`,** the minimal fix is a guarded call (`handle.unref?.();`) with a comment naming the fake-timer reason — do **not** delete the `unref`, which is what keeps a pending ack from holding the process open at shutdown (spec §5.1, §8 test-harness safety).

- [ ] **Step 6:** **NEGATIVE-VERIFY T1 (mandatory).** Revert only the wrapper call — the mechanism stays compiled and present — then confirm T1 fails, then restore.

```bash
cd /Users/mokie/github/hive-KPR-415
# Edit dispatcher.ts, in dispatchToAgent, change
#     await this.runTurnWithMeetingAck(agentId, effectiveItem, resolved, adapter),
# back to the pre-KPR-417 form
#     await this.agentManager.runWorkItemTurn(agentId, effectiveItem),
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/dispatcher-conference.test.ts -t "T1 (KPR-417)"
```
Expected: **FAIL** at `expect(ackCalls()).toHaveLength(1)` — receiving `0`. That is the right reason: nothing arms the timer, so nothing is posted at t=15s. It must **not** be a compile error (`runTurnWithMeetingAck` becomes an unused private method, which neither `tsc --noEmit` under this tsconfig nor this repo's eslint config flags — confirm with `npm run typecheck && npm run lint` if in doubt).

Also confirm the corroborating signal: T2 and T7a still **pass** during the revert (they assert absence, which is vacuously true pre-fix). If T2 or T7a fails, the revert removed too much.

Then restore and re-run:
```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/dispatcher-conference.test.ts -t "KPR-417"
```
Expected: **PASS**, all KPR-417 cases.

- [ ] **Step 7:** Commit.
```bash
git add src/channels/dispatcher.ts src/channels/dispatcher-conference.test.ts
git commit -m "feat(kpr-417): delay-then-ack for slow round-0 conference turns

runTurnWithMeetingAck wraps the fan-out turn await: arm a 15s unref'd
timer, run the turn, cancel in the adjacent finally so an ack can never
outlive the turn it describes. Gated on resolved.conferenceMode &&
conferenceRound === 0 — never on item.meta, which is what makes outage
replays and KPR-402 continuation legs structurally ack-free.

The ack posts through adapter.deliver (identity + echo suppression), with
error unset and never enqueued for retry.

Negative-verified: T1 fails when the wrapper call is reverted.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Gate coverage — T3 (round-1 / KPR-389 §D5) and T4 (non-conference legs)

**Files:**
- Test only: `src/channels/dispatcher-conference.test.ts` — inside the KPR-417 ack describe

- [ ] **Step 1:** Add **T3** — the load-bearing guard for the one contract this feature could break.

```ts
    it("T3 (KPR-417): a round-1 reaction turn NEVER acks, and a killed one leaves the channel silent (KPR-389 §D5)", async () => {
      // ⚠ THIS IS THE GUARD FOR KPR-389 §D5 GOAL 5, quoted verbatim from
      // kpr-389-spec.md:39: "A clamp-killed reaction never posts noise into
      // the meeting channel." A round-1 reaction clamp-killed at 120s would,
      // under an unguarded ack, have posted "On it" at 15s — the ack IS the
      // filler D5 forbids, already in the channel before the kill. There is no
      // round-1 retraction path in this design (spec §5.2, §6.4), so round-1
      // acking is simply out of scope. If a future edit "just acks round-1
      // too", this test must fail loudly.
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const slowReaction = hangingTurn();
      agentManager.runWorkItemTurn
        .mockResolvedValueOnce(turn({ finalMessage: "Jasper's round-0 answer" })) // fast round-0
        .mockReturnValueOnce(slowReaction.promise); // jessica's round-1: hangs

      await dispatcher.dispatch(
        confAckItem("conf-thread-kpr417-t3", "Jasper, and Jessica, please weigh in"),
      );
      // Drain the fire-and-forget reaction pass under the fake clock, then let
      // the round-1 turn sit past the ack threshold.
      await settleAcked();
      await settleAcked();
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
      expect(agentManager.runWorkItemTurn.mock.calls[1][1].meta.conferenceRound).toBe(1);

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      expect(ackCalls()).toHaveLength(0); // ← the gate

      // Companion: the round-1 turn is then clamp-killed. D5's existing
      // silence holds and the channel saw ZERO posts for that agent.
      slowReaction.release(turn({ finalMessage: "", aborted: true, timedOut: true }));
      await settleAcked();
      await settleAcked();

      expect(ackCalls()).toHaveLength(0);
      expect(adapter.deliver).toHaveBeenCalledTimes(1); // only jasper's round-0 reply
      expect(adapter.deliver.mock.calls[0][0].agentId).toBe("jasper");
    });
```

- [ ] **Step 2:** Add **T4(a)** — the case that actually exercises the gate.

```ts
    it("T4a (KPR-417): a plain multi-agent fan-out turn never acks — THIS is the gate's real exercise", async () => {
      // Goes through dispatchToAgent (so the ack wrapper IS on the code path)
      // with a bare `resolved` carrying no conferenceMode. This is the case
      // that would fail if someone widened the gate to read item.meta.
      //
      // Label "random", NOT "general": executive-assistant OWNS the general
      // channel in the mock registry, which would take the dedicated-channel
      // single-dispatch path instead of fan-out.
      const slowA = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slowA.promise);

      const dispatched = dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, and Jessica, what's the deploy status?",
          source: { kind: "slack", id: "C999", label: "random" },
          threadId: "plain-fanout-kpr417-t4a",
          meta: { slackTs: "1700.0101" },
        }),
      );
      await settleAcked();
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2); // real fan-out
      expect(agentManager.runWorkItemTurn.mock.calls[0][1].meta.conferenceMode).toBeUndefined();

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      expect(ackCalls()).toHaveLength(0);

      slowA.release(turn({ finalMessage: "Deployed." }));
      await dispatched;
      await settleAcked();
      expect(ackCalls()).toHaveLength(0);
    });
```

- [ ] **Step 3:** Add **T4(b)** — the leg-level pin, commented as vacuous-by-construction.

```ts
    it("T4b (KPR-417): an outage-replay item carrying meta.conferenceRound: 0 never acks", async () => {
      // ⚠ STRUCTURALLY VACUOUS BY CONSTRUCTION, even post-fix — read the
      // comment before treating this as gate coverage. A replay takes
      // dispatch()'s SINGLE-DISPATCH leg, which has no runTurnWithMeetingAck
      // wrapper on it at all, so there is no gate there to evaluate. What it
      // pins is the LEG-LEVEL absence (spec §5.2): a regression where the ack
      // wrapper is later added to the single-dispatch leg. The meta-vs-
      // `resolved` gate is exercised by T4a, not here.
      //
      // Note the replay DOES retain its conference meta (KPR-389 §E4) — that
      // is the point: meta says round 0 and it still must not ack.
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(
        makeWorkItem({
          text: "some replayed conference turn text",
          source: { kind: "slack", id: "C-CONF", label: "conf-kpr417" },
          threadId: "conf-thread-kpr417-t4b",
          meta: {
            slackTs: "1700.0102",
            outageReplay: true,
            targetAgentId: "jasper", // resolveAgents step 0 — the single-dispatch leg
            conferenceMode: true,
            conferenceRound: 0,
            conferenceHumanTs: "1700.0102",
          },
        }),
      );
      await settleAcked();
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      expect(ackCalls()).toHaveLength(0);

      slow.release(turn({ finalMessage: "The replayed answer." }));
      await dispatched;
      await settleAcked();
      expect(ackCalls()).toHaveLength(0);
    });
```

- [ ] **Step 4:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
```
Expected: all green, `T3`, `T4a`, `T4b` passing.

> **No typecheck step here, deliberately:** this task is test-file-only, and `tsconfig.json:18` excludes `src/**/*.test.ts` — running `npm run typecheck` after a test-only edit would exit 0 unconditionally and prove nothing. eslint (in Task 9's `npm run check`) is the only static gate on these files; the tests running green is the real signal.

- [ ] **Step 5:** Commit.
```bash
git add src/channels/dispatcher-conference.test.ts
git commit -m "test(kpr-417): T3/T4 — round-0 gate coverage

T3 is the KPR-389 D5 goal-5 guard (a clamp-killed reaction must never have
posted filler at 15s), carrying the citation so a 'just ack round-1 too'
edit fails loudly. T4a exercises the resolved-vs-meta gate on a real
non-conference fan-out; T4b pins leg-level absence on the replay path and
is commented as vacuous-by-construction, not gate coverage.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Failure-path coverage — T8, T9, T10, T12 (spec §6)

**Files:**
- Test only: `src/channels/dispatcher-conference.test.ts` — inside the KPR-417 ack describe

The uniform rule under test throughout: **an ack is a true statement about dispatch state at the time it was posted, and is never retracted.** Every assertion below therefore checks two things — that the failure path's own visible resolution still happens, and that nothing retracts, edits or apologizes for the ack.

- [ ] **Step 1:** Add **T8** (§6.1 — the turn errors or throws), as an `it.each` over the two arms.

```ts
    it.each([
      [
        "resolves with error + text (exit-code-1 convention)",
        (release: (v: unknown) => void) =>
          release(turn({ finalMessage: "Partial answer", errors: ["exit 1"] })),
        "Partial answer",
      ],
      [
        "rejects (thrown — e.g. a grok TurnAssemblyError from an unreadable ~/.grok/auth.json)",
        (_release: (v: unknown) => void, reject: (e: unknown) => void) => reject(new Error("boom")),
        "Something went wrong",
      ],
    ])(
      "T8 (KPR-417, §6.1): an acked turn that %s delivers the ack first and the error second — never a retraction",
      async (_label, settle, expectedFragment) => {
        await soloClassifier();
        let release!: (v: unknown) => void;
        let reject!: (e: unknown) => void;
        agentManager.runWorkItemTurn.mockReturnValue(
          new Promise((res, rej) => {
            release = res;
            reject = rej;
          }),
        );

        const dispatched = dispatcher.dispatch(confAckItem(`conf-thread-kpr417-t8-${String(_label).slice(0, 12)}`));
        await settleAcked();
        await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
        expect(ackCalls()).toHaveLength(1);

        settle(release, reject);
        await dispatched;
        await settleAcked();

        // Exactly two posts, ack first, error second. NO third post, no edit,
        // no delete — the ack is never retracted (spec §6.4 ruling, applied
        // uniformly across every failure path).
        expect(adapter.deliver).toHaveBeenCalledTimes(2);
        expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);
        expect(adapter.deliver.mock.calls[1][0].text).toContain(expectedFragment);
      },
    );
```

- [ ] **Step 2:** Add **T9** (§6.2 — circuit-open fast-fail), three arms. Requires outage wiring; reuse the in-file store-mock shape from `:1049-1064`.

```ts
    /** Outage wiring, same shape as the in-file precedent at :1049-1064. */
    const armOutage = () => {
      const outageStore = {
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
      dispatcher.setOutageHandling({
        store: outageStore as never,
        episodes: new OutageEpisodeTracker(),
        config: { enabled: true, replayIntervalMs: 15_000, maxAgeHours: 4, maxDepth: 500, maxReplayAttempts: 3 },
      });
      return outageStore;
    };
    const noticeCalls = () =>
      adapter.deliver.mock.calls.filter((c: any[]) => String(c[0].text).includes("provider outage"));

    it("T9a (KPR-417, §6.2): an IMMEDIATE circuit-open fast-fail beats the threshold — no ack", async () => {
      // The common case is structurally clean: the breaker permit is acquired
      // at the top of the spawn, so a fast-fail returns well under 15s.
      await soloClassifier();
      const outageStore = armOutage();
      agentManager.runWorkItemTurn.mockRejectedValueOnce(
        new ProviderCircuitOpenError("claude", Date.now(), 15_000, "connect-fail", "fetch failed"),
      );

      await dispatcher.dispatch(confAckItem("conf-thread-kpr417-t9a"));
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      await settleAcked();

      expect(outageStore.enqueue).toHaveBeenCalledTimes(1);
      expect(ackCalls()).toHaveLength(0);
    });

    it("T9b (KPR-417, §6.2): a fast-fail DELAYED past 15s (lock contention) acks, then the honest notice — one each", async () => {
      // NOT hypothetical: withSpawnTicket's per-thread lock spin-waits BEFORE
      // the breaker acquire, so a turn queued behind a sibling on the same
      // agentId:threadId can ack at 15s and only then fast-fail. The resulting
      // "ack, then honest outage notice" is a coherent sequence.
      await soloClassifier();
      const outageStore = armOutage();
      let reject!: (e: unknown) => void;
      agentManager.runWorkItemTurn.mockReturnValue(
        new Promise((_res, rej) => {
          reject = rej;
        }),
      );

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t9b"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(1);

      reject(new ProviderCircuitOpenError("claude", Date.now(), 15_000, "connect-fail", "fetch failed"));
      await dispatched;
      await settleAcked();

      expect(outageStore.enqueue).toHaveBeenCalledTimes(1);
      expect(ackCalls()).toHaveLength(1); // not repeated
      expect(noticeCalls()).toHaveLength(1);
      expect(adapter.deliver).toHaveBeenCalledTimes(2);
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT); // ack first
    });

    it("T9c (KPR-417, §6.2): ⚠ ACCEPTED RESIDUAL — two agents in one episode produce TWO acks and ONE notice", async () => {
      // This pins KNOWN, ACCEPTED behavior, not desired behavior. The outage
      // notice is deduped once per (provider, adapterKey, threadKey) per
      // episode (dispatcher.ts:1003, firstForThread), so in an N-agent meeting
      // on one provider only the first agent's turn produces a notice; the
      // rest queue silently. If those agents acked, their acks are followed by
      // silence until replay — possibly hours later, and via the
      // single-dispatch leg, which fires no reaction pass.
      //
      // Spec §6.2 CONSIDERED and REJECTED gating the ack at fire time on
      // breaker state, on three grounds: it covers only the lock-contended
      // sub-shape; it does nothing for the post-turn shape; and it makes the
      // ack rule conditional on cross-module state for partial coverage. Do
      // NOT "fix" this test. Revisit trigger: trial logs showing acks
      // correlated with outage episodes at a rate the operator notices.
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper", "river"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });
      const outageStore = armOutage();

      const rejects: Array<(e: unknown) => void> = [];
      agentManager.runWorkItemTurn.mockImplementation(
        () => new Promise((_res, rej) => { rejects.push(rej); }),
      );

      const dispatched = dispatcher.dispatch(
        confAckItem("conf-thread-kpr417-t9c", "Jasper, and River, status please"),
      );
      await settleAcked();
      expect(rejects).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(2); // ⚠ both slow agents acked

      for (const rej of rejects) {
        rej(new ProviderCircuitOpenError("claude", Date.now(), 15_000, "connect-fail", "fetch failed"));
      }
      await dispatched;
      await settleAcked();

      expect(outageStore.enqueue).toHaveBeenCalledTimes(2); // both queued
      expect(noticeCalls()).toHaveLength(1); // ⚠ but only ONE notice — the residual
    });
```

> **Import addition:** `import { ProviderCircuitOpenError } from "../agents/provider-circuit-breaker.js";` at the top of the test file (KPR-416 may have already added it for its own T7 companion — check before duplicating). `OutageEpisodeTracker` is already imported at `:4`.

- [ ] **Step 3:** Add **T10** (§6.3 — deadline abort), two arms.

```ts
    it("T10 (KPR-417, §6.3): a deadline abort WITH progress acks, notices, dispatches a leg — and the leg itself never acks", async () => {
      // Sequence: ack at 15s → "taking longer than expected, continuing" at
      // the deadline → the leg's answer. A coherent progression, not a
      // redundant double-post. The leg carries no conference meta (KPR-413) and
      // re-enters the single-dispatch leg, so it CANNOT ack — asserted by
      // hanging the leg's own turn past the threshold too.
      await soloClassifier();
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue([]);
      const origin = hangingTurn();
      const leg = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValueOnce(origin.promise).mockReturnValueOnce(leg.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t10"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(1);

      origin.release(turn({ finalMessage: "", timedOut: true, aborted: true, toolCalls: 46, streamed: true }));
      await dispatched;
      await settleAcked();
      await settleAcked();

      // First-abort notice delivered, and a continuation leg dispatched.
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
      const legItem = agentManager.runWorkItemTurn.mock.calls[1][1];
      expect(legItem.meta.deadlineRetry).toBe(1);
      // Reuses the KPR-413 pin: the leg carries none of the four conference keys.
      expect(legItem.meta.conferenceMode).toBeUndefined();
      expect(legItem.meta.conferenceRound).toBeUndefined();
      expect(legItem.meta.conferenceHumanTs).toBeUndefined();
      expect(legItem.meta.conferenceInjectionMode).toBeUndefined();
      expect(adapter.deliver).toHaveBeenCalledTimes(2); // ack + first-abort notice
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);

      // ← the load-bearing half: the leg hangs well past the threshold and
      //   STILL posts no ack (there is no wrapper on that leg at all).
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);
      expect(ackCalls()).toHaveLength(1);

      leg.release(turn({ finalMessage: "Finished on the second pass." }));
      await settleAcked();
      await settleAcked();
      expect(ackCalls()).toHaveLength(1);
    });

    it("T10 companion (KPR-417, §6.3): a ZERO-progress deadline abort acks, then a notice only — no leg, no second ack", async () => {
      await soloClassifier();
      mockSlackAdapter.fetchThreadHistory.mockResolvedValue([]);
      const origin = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValueOnce(origin.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t10b"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(1);

      // No toolCalls, not streamed, empty text ⇒ zero progress.
      origin.release(turn({ finalMessage: "", timedOut: true, aborted: true }));
      await dispatched;
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);

      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1); // no leg
      expect(ackCalls()).toHaveLength(1);
      expect(adapter.deliver).toHaveBeenCalledTimes(2); // ack + zero-progress notice
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);
    });
```

- [ ] **Step 4:** Add **T12** (§6.5 — the ack's own delivery fails).

```ts
    it("T12 (KPR-417, §6.5): a failed ack delivery is warned and dropped — never retried, and the turn is unaffected", async () => {
      // A retried ack lands minutes later, potentially AFTER the answer. A
      // dropped ack is strictly better than a late one, so it must never reach
      // the retry queue (unlike deliverOutageNotice, which does enqueue).
      const retryQueue = { enqueue: vi.fn(), sweep: vi.fn() };
      dispatcher.setRetryQueue(retryQueue as any);
      await soloClassifier();
      adapter.deliver.mockImplementation(async (result: any) => {
        if (result.text === MEETING_ACK_TEXT) throw new Error("slack 503");
      });
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t12"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      await settleAcked();

      expect(ackCalls()).toHaveLength(1); // attempted...
      expect(retryQueue.enqueue).not.toHaveBeenCalled(); // ...and NOT queued

      // The turn's own delivery still happens normally.
      slow.release(turn({ finalMessage: "The answer regardless." }));
      await dispatched;
      await settleAcked();
      const answers = adapter.deliver.mock.calls.filter((c: any[]) => c[0].text !== MEETING_ACK_TEXT);
      expect(answers).toHaveLength(1);
      expect(answers[0][0].text).toBe("The answer regardless.");
      expect(retryQueue.enqueue).not.toHaveBeenCalled();
    });
```

- [ ] **Step 5:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/
```
Expected: every file green. `T8` (2 cases), `T9a/b/c`, `T10` + companion, `T12` all passing.

> **Implementation note on T9's notice matching:** `noticeCalls()` matches on the substring `"provider outage"`. **Confirmed, not assumed:** `outageNoticeFor("slack")` returns `OUTAGE_NOTICE_DEFAULT`, defined at `src/outage/outage-notices.ts:45` as `"⚠️ I can't reach my AI service right now (provider outage). Your message is saved — I'll answer it automatically as soon as service is back."` — the substring is present verbatim. KPR-416's own T4 matches the same helper the same way. (The SMS variant at `:47` does *not* contain it, but no KPR-417 case exercises an SMS adapter.)

- [ ] **Step 6:** Commit.
```bash
git add src/channels/dispatcher-conference.test.ts
git commit -m "test(kpr-417): T8/T9/T10/T12 — failure-path coverage

Every path an acked turn can take, with the uniform rule asserted on each:
the failure's own visible resolution still happens, and the ack is never
retracted. T9c pins the outage-silence residual (two acks, one notice) as
ACCEPTED behavior with a pointer to spec §6.2's rejected fix. T10's leg arm
hangs past the threshold to prove the continuation leg cannot ack. T12
pins that a failed ack never reaches the retry queue.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: T11 — the suppression orphan and its KPR-416-dependent companion

**Files:**
- Test only: `src/channels/dispatcher-conference.test.ts` — inside the KPR-417 ack describe

- [ ] **Step 1:** Add T11 and its companion.

```ts
    it("T11 (KPR-417, §6.4): an acked turn that SUPPRESSES leaves the ack as its only post — no retraction, no follow-up", async () => {
      // The fourth failure case. Under delay-then-ack this requires the
      // suppressor to ALSO be slow, narrowing it to the grok-shaped
      // population — but it is not exotic: the meeting preamble actively
      // instructs the decline, and three of four round-0 responders suppressed
      // in the live trial.
      //
      // ⚠ RULING: ACCEPT THE ORPHANED ACK (spec §6.4). "On it — picked this
      // up." followed by nothing reads as *took the item, had nothing to add*
      // — exactly what happened. Nothing was promised and no active work was
      // claimed; that is what makes the no-retraction rule liveable. Do NOT
      // add a chat.delete, a chat.update, a "…had nothing to add" follow-up,
      // or a ✅/💤 reaction. All four are argued down in §6.4 ground 3.
      await soloClassifier();
      const slow = hangingTurn();
      agentManager.runWorkItemTurn.mockReturnValue(slow.promise);

      const dispatched = dispatcher.dispatch(confAckItem("conf-thread-kpr417-t11"));
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(1);

      slow.release(turn({ finalMessage: "No response needed." }));
      await dispatched;
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS * 2);

      // The ack is the ONLY post from that agent for that turn.
      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe(MEETING_ACK_TEXT);
      // Explicitly: no retraction, no follow-up, no "_No response._" placeholder.
      expect(adapter.deliver.mock.calls.some((c: any[]) => c[0].text === "_No response._")).toBe(false);
      expect(mockLogInfo).toHaveBeenCalledWith(
        "Non-response suppressed (fan-out)",
        expect.objectContaining({ agentId: "jasper", conferenceRound: 0 }),
      );
    });

    it("T11 companion (KPR-417/KPR-416): the acked-then-suppressed agent is STILL round-1-eligible, so the orphan CAN resolve", async () => {
      // ⚠ ITS PURPOSE IS PRECISE (spec §11): this is a tripwire for a REVERT
      // OF KPR-416's RELOCATION of the reaction-exclusion write from selection
      // time to delivery time — NOT for a change to A's write PREDICATE.
      // Under either predicate A considered, a suppressed turn writes nothing
      // (it sits in the isNonResponse branch with no real content either way),
      // so this test is predicate-INSENSITIVE. It fails only if the write
      // moves back to selection time, where every selected round-0 agent is
      // excluded regardless of outcome and the orphan becomes permanent by
      // construction — which is exactly what evaporates §6.4 ground 2.
      //
      // Ground 2 is deliberately the WEAKEST of §6.4's four grounds: the
      // acked-and-suppressed population is by construction made of SLOW
      // suppressors, and for one of them to earn a round-1 reaction an even
      // SLOWER peer must deliver real content on the same trigger. The ruling
      // stands on grounds 1, 3 and 4 regardless of how often this fires.
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper", "jessica"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const jasperSlow = hangingTurn();
      const jessicaSlow = hangingTurn();
      agentManager.runWorkItemTurn.mockImplementation((agentId: string, item: any) => {
        if (item?.meta?.conferenceRound === 1) return Promise.resolve(turn({ finalMessage: "Jessica reacts." }));
        return agentId === "jasper" ? jasperSlow.promise : jessicaSlow.promise;
      });

      const dispatched = dispatcher.dispatch(
        confAckItem("conf-thread-kpr417-t11b", "Jasper, and Jessica, discuss the launch plan"),
      );
      await settleAcked();
      await vi.advanceTimersByTimeAsync(MEETING_ACK_DELAY_MS);
      expect(ackCalls()).toHaveLength(2); // both slow agents acked

      // Jessica suppresses; Jasper then delivers real content.
      jessicaSlow.release(turn({ finalMessage: "No response needed." }));
      await settleAcked();
      jasperSlow.release(turn({ finalMessage: "Here is what I found after a long dig." }));
      await dispatched;
      await settleAcked();
      await settleAcked();

      // ← THE PIN: the acked-then-suppressed agent still runs a round-1 turn
      //   and its reaction posts. The orphan resolved.
      const round1 = agentManager.runWorkItemTurn.mock.calls.filter(
        (c: any[]) => c[1]?.meta?.conferenceRound === 1,
      );
      expect(round1.map((c: any[]) => c[0])).toEqual(["jessica"]);
      expect(adapter.deliver.mock.calls.some((c: any[]) => c[0].text === "Jessica reacts.")).toBe(true);
      // Still exactly two acks — round-1 never acks (T3's contract, re-checked here).
      expect(ackCalls()).toHaveLength(2);
    });
```

> **⚠ POST-416 DEPENDENCY:** the companion **requires KPR-416 to have landed**. If Task 0 Step 3 found `markReactionExclusion` absent, this test cannot pass and the ticket is blocked — report it, do not weaken the assertion.
>
> **If the reaction pass proves hard to drain deterministically under the fake clock** (it is a fire-and-forget chain of microtask-only mocks, so `settleAcked()` twice should suffice), add a third `await settleAcked()` before asserting. Do **not** reach for `vi.waitFor` — not because it deadlocks (it does not; it polls on `getSafeTimers()`' native timers and supports fake clocks by design), but because it auto-advances the fake clock 50ms per poll via a bare synchronous `vi.advanceTimersByTime`, which would silently move this test across the 15s ack threshold it is metering. Do **not** move this test out of the ack block to use real timers: it needs the 15s advance to produce the acks it asserts on.

- [ ] **Step 2:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts -t "T11"
```
Expected: **PASS**, 2 tests.

- [ ] **Step 3:** Commit.
```bash
git add src/channels/dispatcher-conference.test.ts
git commit -m "test(kpr-417): T11 — the suppression orphan and its resolution path

The ack is the only post from a suppressed agent, with no retraction and no
_No response._ placeholder. The companion is a tripwire for a REVERT of
KPR-416's relocation (not for a change to its write predicate, which this
test is insensitive to) — under selection-time recording the orphan would
be permanent by construction and spec 6.4 ground 2 would evaporate.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: T13 — structural drift pins

**Files:**
- Test only: `src/channels/dispatcher-conference.test.ts` — two top-level `it`s (outside the fake-timer block; these are synchronous source scans)

- [ ] **Step 1:** Add T13(a) and T13(b) as top-level `it`s in the suite, after the KPR-417 ack describe. Same text-scan technique as `src/boot-order.test.ts` and KPR-416's own T5.

```ts
  it("T13a (KPR-417): dispatcher.ts has exactly ONE fetchThreadHistory call site", () => {
    // Drift catcher for spec §5.5's central claim. A third meeting-history
    // read added later WITHOUT going through fetchMeetingHistory would
    // silently re-expose acks to that consumer — the one failure mode the
    // one-strip-point design exists to prevent. `//` line comments are
    // stripped so prose mentioning the method cannot false-positive.
    const source = readFileSync(fileURLToPath(new URL("./dispatcher.ts", import.meta.url)), "utf8");
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    const hits = codeOnly.match(/\.fetchThreadHistory\s*\(/g) ?? [];
    expect(
      hits.length,
      "dispatcher.ts must read meeting history through exactly one fetchThreadHistory call, inside fetchMeetingHistory (KPR-417 §5.5)",
    ).toBe(1);
    // ...and that one call must be inside fetchMeetingHistory.
    const fnStart = codeOnly.indexOf("private async fetchMeetingHistory(");
    const fnEnd = codeOnly.indexOf("private async resolveConferenceAgents(", fnStart);
    expect(fnStart, "fetchMeetingHistory not found — update this test's anchors").toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    expect(codeOnly.slice(fnStart, fnEnd)).toContain(".fetchThreadHistory(");
  });

  it("T13b (KPR-417): the ack cancel lives inside runTurnWithMeetingAck, not around the dispatchToAgent body", () => {
    // Drift catcher for spec §5.1's ordering guarantee. Relocating the cancel
    // to a finally around the whole dispatchToAgent body would let a still-
    // armed timer post "On it" AFTER the answer: delivery, the KPR-388 mark
    // write and the outage/deadline gates all run after the turn settles.
    const source = readFileSync(fileURLToPath(new URL("./dispatcher.ts", import.meta.url)), "utf8");
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    const helperStart = codeOnly.indexOf("private async runTurnWithMeetingAck(");
    const dispatchStart = codeOnly.indexOf("private async dispatchToAgent(");
    expect(helperStart, "runTurnWithMeetingAck not found — update this test's anchors").toBeGreaterThan(-1);
    expect(dispatchStart, "dispatchToAgent not found — update this test's anchors").toBeGreaterThan(helperStart);
    const helperBody = codeOnly.slice(helperStart, dispatchStart);
    expect(helperBody).toContain("ack?.cancel();");
    // And nowhere else in the file.
    expect((codeOnly.match(/ack\?\.cancel\(\);/g) ?? []).length).toBe(1);
  });
```

> **Import addition:** `import { readFileSync } from "node:fs";` and `import { fileURLToPath } from "node:url";` at the top of the test file (KPR-416 Task 3 Step 3 adds these for its own T5 — **check before duplicating**).
>
> **Escape hatch, same posture and same wording as KPR-416's T5 (spec §9):** if a source-scan assertion is judged too brittle for this suite in review, the accepted substitute is a structural comment at each site naming the requirement and pointing at §5.1 / §5.5, and T13 is dropped. Do **not** substitute a timing-based test.

- [ ] **Step 2:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts -t "T13"
```
Expected: **PASS**, 2 tests.

Then adversarially confirm T13a bites: temporarily add a second `await this.slackAdapter.fetchThreadHistory(item.source.id, "x");` line inside `resolveConferenceAgents`, re-run, expect **FAIL** with `2` received. Remove it and re-run green.

- [ ] **Step 3:** Commit.
```bash
git add src/channels/dispatcher-conference.test.ts
git commit -m "test(kpr-417): T13 — structural pins for the strip point and the cancel site

T13a: dispatcher.ts has exactly one fetchThreadHistory call, inside
fetchMeetingHistory — a later meeting-history read added outside the
wrapper fails here. T13b: ack?.cancel() lives inside
runTurnWithMeetingAck, so a still-armed timer can never post after the
answer. Adversarially verified.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: CLAUDE.md and the full gate

**Files:**
- Modify: `CLAUDE.md:283` (the Meeting mode bullet)

- [ ] **Step 1:** Name `ackEnabled` and its independence in the Meeting-mode bullet's Config sentence. Anchor on the `claimTtlMinutes` clause, which KPR-416 does not touch.

Replace (within the `**Meeting mode (KPR-386):**` bullet):
```
Config: hive.yaml `meetingWorkers` (liberal loader, all keys optional) — `enabled: false` turns off both worker dispatch and the scribe/summary anchor, `scribeEnabled: false` is the scribe-only lever, and `claimTtlMinutes` is clamped up with a warning if it does not exceed `workerTimeoutMs`.
```
with:
```
Config: hive.yaml `meetingWorkers` (liberal loader, all keys optional) — `enabled: false` turns off both worker dispatch and the scribe/summary anchor, `scribeEnabled: false` is the scribe-only lever, and `claimTtlMinutes` is clamped up with a warning if it does not exceed `workerTimeoutMs`. **`ackEnabled` (KPR-417, default on) is the delay-then-ack lever and is deliberately INDEPENDENT of `enabled`** — unlike `scribeEnabled`, which nests under it because the scribe consumes pool machinery (`runRoleTurn`/`hasCapacity`); the ack consumes none and lives in this section for config locality only, so disabling fetch-workers must never silently kill it. **Delay-then-ack (KPR-417):** a round-0 conference turn still unresolved at `MEETING_ACK_DELAY_MS` (15s) posts one agent-attributed `"On it — picked this up."` into the thread; fast turns never reach the threshold. The gate reads `resolved.conferenceMode && resolved.conferenceRound === 0` and **never `item.meta`** — which is what makes outage replays (single-dispatch leg, no wrapper) and KPR-402 continuation legs (conference-stripped) structurally ack-free, and what preserves KPR-389 §D5 goal 5 (a round-1 ack would be exactly the filler a clamp-kill forbids). The ack is **operational chrome, never meeting content**: it is recognized by a stable content pattern (`MEETING_ACK_TEXT`/`isMeetingAck`, the `NON_RESPONSE_PATTERNS` precedent — the two must change in lockstep) and stripped at a **single** history-fetch point, `Dispatcher.fetchMeetingHistory`, which is what makes all five consumers — full injection, delta injection, the `meetingLastSeenTs` mark, the round-0 classifier's recency window, and the scribe — ack-blind in one hunk. **Any new meeting-history read must go through that wrapper**, and the strip is deliberately **not** gated on `ackEnabled` (flipping the lever off must not un-hide acks already in a thread). An ack is **never retracted** — no delete, no edit, no follow-up, no reaction marker; the wording is a statement of state, not a promise of a reply, which is what makes that rule liveable. Agents reading a `conf-*` thread through their own `slack` MCP tools see acks verbatim — expected, not a strip-point leak.
```

- [ ] **Step 2:** Run the full gate.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: typecheck clean, lint clean, `format:check` clean (run `npm run format` first if it complains, then re-run `check`), full vitest suite green with zero failures. Every test in the Regression Surface list must be green **with zero edits**.

- [ ] **Step 3:** Confirm the diff is confined to the intended files.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && git diff --stat KPR-416-merge-base..HEAD -- src/ CLAUDE.md
```
(substitute the actual merge base — the commit at which KPR-416 landed on the epic branch).
Expected: exactly **nine** entries — eight under `src/` (`src/channels/dispatcher.ts`, `src/channels/slack-adapter.ts`, `src/channels/dispatcher-conference.test.ts`, `src/workers/worker-pool-config.ts`, `src/config.ts`, `src/config.test.ts`, `src/index.ts`, `src/boot-order.test.ts`) plus `CLAUDE.md`. **`src/agents/*`, `src/slack/*` and `src/workers/meeting-scribe.ts` must not appear** — this ticket touches none of them.

- [ ] **Step 4:** Commit.
```bash
git add CLAUDE.md
git commit -m "docs(kpr-417): document delay-then-ack and ackEnabled in the meeting-mode bullet

Names the lever and its independence from meetingWorkers.enabled, the
round-0-only gate reading resolved (never item.meta), the single strip
point and its any-new-read obligation, the never-retracted rule, and the
deliberate out-of-scope case where an agent's own slack MCP tools see acks.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Canon note — procedural, no files change

**This task edits nothing.** It is a hand-off item for the driver, kept in the task list so it is not dropped between implementation and PR. There is no code change and no commit; `git status` must be clean when this task is done.

KPR-415 is a **pre-register epic** — as of plan time its ticket carries no `## Decision Register — Canon` section. The three entries below live in `kpr-417-spec.md` §12 until the register opens.

**What the driver does:**

1. Check the KPR-415 epic **ticket** (the tracker, not the repo) for a `## Decision Register — Canon` section — it may have opened since plan time, and KPR-416's own Task 10 may already have opened it.
2. **If it has opened:** lift all three entries verbatim. **If not:** leave them in the spec and state in the PR body that they are pending lift.
3. The three entries:
   - **New:** *acks are operational chrome, never meeting content* — recognized by a stable content pattern, stripped at exactly one history-fetch point, and that strip is never gated on the feature's own lever.
   - **New:** *≤ 1 ack per (agent, human trigger)* — replays, KPR-402 continuation legs and worker re-entry are structurally ack-free because the gate reads `resolved`, never `meta`.
   - **New:** *an ack is never retracted* — no delete, no edit, no follow-up, no reaction marker. The wording is a statement of state, not a promise of a reply, and that is what makes the rule liveable.
   - Plus the two preservation/dependency notes: **preserves KPR-389 §D5 goal 5** in full (the round-0 gate is the mechanism, T3 is its guard); **preserves KPR-413**; and **depends on KPR-416's *relocation*** of the reaction-exclusion write to delivery time — not on which write predicate A chose — for §6.4's reasoning.

- [ ] Register state checked, entries either lifted or flagged as pending-lift in the PR body. No files changed, nothing committed.

---

## Post-implementation checklist

- [ ] `npm run check` green with the three Slack env stubs.
- [ ] All 15 test cases present: T1, T2, T3, T4a, T4b, T5 (`it.each` ×2 + delta sibling + anchored-regex unit), T7a, T7b, T8 (×2), T9a/b/c, T10 (+companion), T11 (+companion), T12, T13a/b, T14.
- [ ] **T1 and T5 negative-verify performed, and the failure REASON recorded** (not just "it failed") — T1 fails at `ackCalls()).toHaveLength(1)` receiving 0; T5 fails at sub-assertion (1) with the ack text present in `threadContext`.
- [ ] `boot-order.test.ts` (c)'s `wiringStart` adversarially verified with an inserted surface between the two adjacent wiring calls.
- [ ] T13a adversarially verified with a second `fetchThreadHistory` call.
- [ ] Fake timers are scoped to the KPR-417 ack `describe` only — `vi.useRealTimers()` in its `afterEach`, and no existing test in the file changed or slowed.
- [ ] No `vi.waitFor` inside the ack describe-block — **not because it deadlocks (it does not)**, but because it auto-advances the fake clock 50ms per poll cycle through a bare synchronous `vi.advanceTimersByTime`, contesting control of the clock these tests step deliberately; no bare `vi.advanceTimersByTime` anywhere.
- [ ] No prompt bytes changed anywhere. KPR-387 `:510`, KPR-388 `:849`, KPR-389 `:552`, KPR-409 and KPR-413 pins all green with zero edits, as are every test KPR-416 added.
- [ ] `src/agents/*` untouched. `src/slack/slack-gateway.ts` untouched. `src/workers/meeting-scribe.ts` untouched.
- [ ] All **nine** residuals in the out-of-scope table are still unfixed and still named in code comments or tests (T9c and T11 carry theirs inline).
- [ ] PR body notes: `ackEnabled` is the rollback lever (config, not code revert — spec §10); the delegated Gate 1 assumptions (delay-then-ack substituting for the operator's literal immediate "got it"; `ackEnabled`'s independence from `enabled`) are named for the operator; the three canon entries are lifted or pending-lift; §6.6's outage-diversion orphan is a named residual with no test, deliberately.
