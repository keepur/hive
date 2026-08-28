# KPR-402 — Deadline-Abort Continuation Chain Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** A turn that hits the wall-clock deadline while the provider circuit is closed no longer dies as a bare "_No response._" or an unmarked fragment. A new dispatcher arm (`maybeHandleDeadlineAbort`, called from BOTH dispatch bodies after the existing outage + replay-error gates) intercepts the `timedOut && aborted` Claude-lane/Lane-A shape (D6 rows 1-2): **with progress** (`classifyTurnResult` kind `turn-deadline`) it delivers one honest "picking up where I left off" notice on notify-policy channels, then re-dispatches **in-process** a synthetic continuation item — per-leg id `<originId>#dl<n>`, `outageReplay` stripped, thread-key pinned (`threadId: item.threadId ?? item.id`), `meta.deadlineRetry` strictly incremented, capped at `MAX_DEADLINE_CONTINUATIONS = 2` — whose KPR-399-persisted session resumes automatically through the unchanged `runWorkItemTurn → sessionStore.get` path with a full fresh deadline; cap exhaustion delivers a terminal notice naming the manual "continue" escape hatch. **Zero progress** (hard `timeout`): notice only on notify channels, warn-log only on silent one-shots, never a re-dispatch (D1 fail-closed — nothing persisted to resume; hangs are the breaker's territory). Cron (`sched:`) is fully inert (re-fires at next match). Replayed outage docs resolve their queue slot on every path: with-progress → released `done` + the chain owns the turn; zero-progress → the existing §5-2g `resolveReplayRealFailure` attempts machinery. Plus one static resume-aware sentence appended to `replayWrap` (⚠A7 — KPR-399 §Edge-12 closure). **No queue reuse, no schema change, no third `enqueueOrigin` class (D19 + watch-item), no manager/runner/breaker/classifier/store/processor edits, no config knob (⚠A6), no `docs/providers.md` edit (⚠A9).**

**Architecture:** Three source files, three test files. `src/channels/deadline-continuation.ts` — **new** small pure-template module (cap constant, six notice constants + three channel selectors mirroring the KPR-307 `outage-notices` pattern, `deadlineContinuationWrap`, `deadlineBaseIdOf`); placed in `src/channels/` beside its sole consumer because the arm is deliberately NOT outage machinery (⚠A6 — active regardless of `outageQueue.enabled`). `src/channels/dispatcher.ts` — the arm as one new private method between `maybeHandlePostTurnOutage` and `handleOutageTurn`, plus two one-call insertions (after the replay-error gate in `dispatch()` L300-303 and in `dispatchToAgent()` L1056-1059 — the same both-bodies placement discipline as `maybeHandlePostTurnOutage`); **no dedup edit** (per-leg ids are first-seen; replayed continuation docs ride the existing `outageReplay` bypass), no other flow changes. `src/outage/outage-notices.ts` — one static sentence inside both `replayWrap` note variants (⚠A7); everything else byte-unchanged. Progress discrimination routes through `classifyTurnResult` with the full `RunResult` (the KPR-398 call-site convention) — the D1/D6 split has exactly one home. Session resume is **emergent, zero new code** (KPR-399 contract): it depends on the thread-key pin, which is why T15 exists. `agent-manager.ts`, `agent-runner.ts`, `provider-circuit-breaker.ts`, `error-classification.ts`, `outage-queue-store.ts`, `outage-replay-processor.ts`, `session-store.ts`, `src/index.ts`: **zero diffs** (spec Non-Goals; verified plan-time — the arm needs no manager surface: `runWorkItemTurn` already keys the session read on `item.threadId ?? item.id` at `agent-manager.ts:866`, and the breaker's record-once already happened in the manager before the dispatcher sees the result).

**Tech Stack:** TypeScript (strict), Vitest 4 (`vi.waitFor` for the fire-and-forget continuation), existing seams only — `dispatcher.test.ts`'s `makeTurn`/`makeMockAgentManager`/`makeOutageStore`/`makeMockAdapter` + the outage describe's `slackItem`/`replayItem` helper pattern (mirrored into the new describe), `outage-notices.test.ts`'s direct template pins. One harness extension: the hoisted logger mock gains `mockLogWarn` (T5/T14 warn-log pins).

> **Authoritative spec:** `docs/epics/kpr-397/kpr-402-spec.md` @ 92f8e71 (three Frontier rounds; the meta-strip, per-leg-id `#dl<n>`, thread-key pin, silent-cell, and A8 open-breaker extension are firm rulings; T1–T15 + the V1 live item binding; ⚠A1–A11 decided).
>
> **Decision Register canon consumed (KPR-397 epic):** D1 (binary-OR progress predicate consumed via `classifyTurnResult`'s D6 kinds — never re-implemented), D3 (the original partially-executed turn is never enqueued — preserved on every path incl. the ⚠A8 open-breaker migration; the retained never-queued assertion in the migrated 1304 row IS the pin), D6 (the arm's progress discrimination is the kpr-398 contract table's kind split, byte-identical rows), D8 (accepted residuals carried: ⚠A4 persist-vs-read race, ⚠A5 crash-mid-chain, ⚠A11 user-supplied `#dl` ids), D19 + coherence watch-item (no third `enqueueOrigin` class, no new sparse doc field — continuation legs enqueue as ordinary `"fast-fail"` docs under their own per-leg keys), D25 (the `isClaudeResumeLoadError` refinement duty lands in V1 live work iff a real rejection string surfaces), D26 (resume is clean and aggressive-safe — no transcript-repair precondition; the wrap's do-not-redo guard is the Finding-4 discharge), D28 (fixture-swap migrations with justification comments: rows 1292/1304 **plus** the KPR-401 log-fields row at dispatcher.test.ts:890 — a third collision the plan verified at source level, migrated to the skip-policy lane; the 1276 D6 hard-timeout routing pin passes **byte-unmodified**), D30–D32 (outage-doc `deadlineMs`, `turnDeadlineUpperBoundMs`, tick order — untouched), D33 (no CI on this child PR — deliver-lane note), D34 (no schema change ⇒ no byte-compat proof owed). Cross-epic C3 (Lane B `!result.aborted` byte-for-byte — the sentinel shape never enters the arm, T11).

## Testing Contract

### Required Test Groups

- **Unit: required**
  - *Scope:* (1) **Dispatcher arm** (`src/channels/dispatcher.test.ts`, new `deadline-abort continuation (KPR-402)` describe + three D28-migrated rows in existing describes): spec rows T1–T11, T13–T15. (2) **Templates module** (`src/channels/deadline-continuation.test.ts`, new file): spec row T12 (every exported string pinned, `MAX_DEADLINE_CONTINUATIONS === 2`, wrap determinism + Edge-12 clauses, `deadlineBaseIdOf` derivation, `policyFor` prefix-class preservation under the `#dl<n>` suffix). (3) **replayWrap ⚠A7** (`src/outage/outage-notices.test.ts`, one appended describe): the T12 tail — the static resume-aware sentence in both policy variants, with every existing shape pin holding byte-unmodified.
  - *Spec-row → file/task map:*

    | Row | What it pins | File | Task |
    |---|---|---|---|
    | T1 | With-progress/closed/slack: notice (exact text), no "_No response._", no queue write, continuation `x#dl1` with `deadlineRetry: 1`, `targetAgentId` pinned, `outageReplay` absent, channel meta carried, wrap text | dispatcher.test.ts (new describe) | 6 |
    | T2 | Cap: `deadlineRetry: 2` → terminal notice, no further dispatch | dispatcher.test.ts | 6 |
    | T3 | Zero-progress/closed/non-replay → zero-progress notice only, no re-dispatch, no queue write | dispatcher.test.ts | 6 |
    | T4 | Cron (`sched:`) → arm fully inert, legacy delivery unchanged | dispatcher.test.ts | 6 |
    | T5 | Silent (`callback:`) with-progress → chain without notices; cap → warn-logged | dispatcher.test.ts | 6 |
    | T6 | Replay + with-progress → `release(…,"done",…)`, notice, continuation with **meta hygiene pinned** (`outageReplay` stripped, `deadlineRetry: 1`, id `x#dl1`) | dispatcher.test.ts | 6 |
    | T7 | Replay + zero-progress → `recordFailedAttempt` path, no deadline notice, no re-dispatch | dispatcher.test.ts | 6 |
    | T8 | Per-leg id vs dedup: continuation first-seen (no bypass edit exists); replayed continuation doc uses the existing bypass | dispatcher.test.ts | 6 |
    | T9 | Wrap round-trip (leg 2 wraps the ORIGINAL), counter monotonic, flat ids, two-notice cadence | dispatcher.test.ts | 6 |
    | T10 | Migrations: 1292 → zero-progress-notice shape; 1304 → arm + **retained never-queued = the D3 pin**; 1276 unmodified (D6 routing pin); + the KPR-401 row → skip-lane shape (plan-discovered third migration, D28 comment) | dispatcher.test.ts (existing describes) | 5 |
    | T11 | Lane B sentinel (`aborted: false`) and operator abort (no `timedOut`) never enter the arm | dispatcher.test.ts | 6 |
    | T12 | Templates/constants: every exported string, cap === 2, wrap determinism, `deadlineBaseIdOf`, `policyFor` suffix preservation; `replayWrap` A7 sentence (both policies) | deadline-continuation.test.ts + outage-notices.test.ts | 2, 4 |
    | T13 | Collision (r1 B1(ii)): mid-chain breaker-open → `enqueue` with `itemId: "x#dl1"` (fresh key, counter serialized verbatim), origin's `done` release the ONLY release call — never resurrected | dispatcher.test.ts | 6 |
    | T14 | Silent × zero-progress × closed: zero delivers, zero re-dispatch, zero store writes, warn log fires, "_No response._" suppressed | dispatcher.test.ts | 6 |
    | T15 | Thread-key pin (r2 blocker): threadId-less `callback:` origin → continuation `threadId === "callback:x"` beside id `callback:x#dl1`; threaded origin → identity copy | dispatcher.test.ts | 6 |

  - *Reason:* the arm is the entire behavior change and the dispatcher suite drives the real gate-ordering/arm/failure-path chain over mocked seams; the templates module is a delivery contract (wording ships to humans); T6/T13/T15 pin the three review-ruled hazards (replay-marker resurrection, same-key `$setOnInsert` silent drop, session-read re-keying) that made rounds r1/r2 blockers.
  - *Minimum assertions:* the 15 spec rows as mapped above. Negative-verify anchors: Tasks 2 (module — degenerate, documented), 4 (replayWrap), 6 (dispatcher — commit-anchored + two sharper manual edits).
- **Integration: not-required** — Harness: not-applicable.
- **E2E: not-required** — Harness: not-applicable (the live item below is a deliver-lane gate, not a harness group).

### Live-instance verification (deliver-lane gate for ready-to-merge)

**NOT runnable at implement time** — this gates ready-to-merge in the deliver lane, not spec-ready or the implement lane. Recorded here verbatim from the spec so the deliver lane executes it without re-deriving:

- **V1 — end-to-end chain (required):** dev agent, `timeoutMs` 60s; send a thread task needing ~2-3 legs (multi-file summarize/build). Evidence: (1) first-abort notice in-thread; (2) continuation spawn log shows `resumeSession: <persisted id>` (not `"new"`); (3) the finished answer references a concrete pre-abort artifact (no restart, no redone side effects); (4) if any resume rejection fires, capture the string and discharge D25 (matcher refinement in-contract — the one case where `agent-manager.ts` may be edited, as KPR-399 live work, not this plan's scope). Cap exhaustion (**V1b, optional**): make the task unbounded, observe the terminal notice — unit T2 covers the logic; run live only if cheap.
- *Why live is required at all:* two things are structurally non-unit-verifiable — the model's *behavioral* response to the continuation wrap (continue-vs-restart, Edge-12's actual risk) and the production timing of the fire-and-forget session persist vs. the continuation's store read (⚠A4). The resume *mechanics* are D26-proven (KPR-399 V1/V2), and KPR-403 deliberately carried no live items on the note that end-to-end folds into this child.
- No other live items: cron/silent/replay branches are pure dispatch logic over seams the unit harness already fakes (KPR-400/401/403 unit-only precedent).

### Critical Flows

1. **Incident shape cured (G1/G2):** 46 tools, `text: ""`, closed circuit, Slack → notice "picking up where I left off" replaces "_No response._"; continuation `m1#dl1` resumes the persisted session with a full fresh deadline; a ≤3-deadline task completes without human nudging; longer exhausts into the terminal notice naming "continue" (T1, T2, T9).
2. **Provable termination (G3):** `deadlineRetry` strictly increments, nothing resets it, legs ≤ cap+1 = 3; every leg exits via exactly one of: normal delivery, normal error path, outage fast-fail under its own per-leg key, notice-only, or the next leg (T2, T5, T9, T13).
3. **Breaker/queue canon intact (G4):** the aborted leg's breaker record (inconclusive `turn-deadline`) happened manager-side before the dispatcher ran (record-once, `agent-manager.ts:1175` region) — the arm adds no record site; `outage_queue` gains no writes/classes/fields from the arm itself; D3's operative content preserved on both open-breaker seeding shapes (migrated 1304 + T13).
4. **Replay coherence (G6):** with-progress replay burn → doc `done` + chain (never stranded, never terminally half-answered — strictly better than today's `done`+"_No response._"); zero-progress burn → attempts+1 toward the existing 3-attempt terminal (T6, T7).
5. **Channel carve-outs (G5):** cron inert; silent one-shots continue silently / warn at cap; zero-progress silent = warn-log only with the "_No response._" delivery to a system surface suppressed too (T4, T5, T14).
6. **Resume emergence depends on the thread-key pin:** for threadId-less items the origin persists under key `x`; only the materialized `threadId: item.threadId ?? item.id` keeps the continuation's `sessionStore.get` read (and the per-thread lock, `threadAgentMap`, ledger keys) on `x` instead of `x#dl1` (T15).

### Regression Surface

- **KPR-398 ★ rows (`dispatcher.test.ts`):** `★ timeout gate: timedOut && aborted with breaker open → outage path even with empty errors` (L1276) — **byte-unmodified, passes unmodified: that is the D6 hard-timeout routing pin** (zero-progress+open is handled by `maybeHandlePostTurnOutage` BEFORE the arm). `★ timedOut with breaker closed → legacy path, unqueued` (L1292) and `★ KPR-398: with-progress deadline turn with breaker open → legacy path, never queued` (L1304) — **migrate under D28** with justification comments (Task 5); 1304's retained `enqueue` never-called assertion is the **D3 pin**.
- **KPR-400 F2 rows (`dispatcher.test.ts`):** all three (`fast-fail` origin, `post-turn-fault` origin, replay release-before-depth) — zero edits; the two enqueue-origin rows are open-breaker zero-progress/throw shapes the arm never reaches. `outage-queue-store.test.ts`'s F2 describe untouched (file not edited). Re-run by name in Task 7.
- **KPR-403 rows:** the three `KPR-403:` dispatcher rows (deadlineMs stamp threading) — zero edits, same reasoning; `outage-queue-store.test.ts` / `outage-replay-processor.test.ts` / `agent-manager.test.ts` KPR-403 suites untouched (files not edited, except the processor suite is re-run because it consumes the ⚠A7 `replayWrap` — its L86 `^\[Replayed after an AI service outage/` prefix pin holds since the sentence is appended inside the bracket note). Re-run by name in Task 7.
- **KPR-401 log-fields row (`dispatcher.test.ts:890`)** — **declared D28 migration (Task 5), plan-discovered:** the row dispatches a notify-channel item with a with-progress `timedOut && aborted` turn and asserts the "Work item dispatched" log; post-arm that turn never reaches normal delivery. It migrates to the `sched:` (skip-policy) shape — the one lane where legacy delivery of an aborted turn deliberately remains — preserving the KPR-401 pin (convertTurnResult field mapping + log fields) byte-for-byte in its assertions; the notify-lane interception is pinned by the new KPR-402 rows.
- **D13 pins (hard constraint, trivially intact):** `provider-circuit-breaker.test.ts` (`KPR-401 pins` describe included) and `error-classification.test.ts` — **no breaker or classifier file is edited**; Task 7 proves it with a zero-diff check over `src/agents/` and re-runs both suites.
- **KPR-399 surface:** `agent-manager.ts` / `session-store.ts` — zero diffs (resume is emergent); covered by the zero-diff check + full-suite gate.
- `src/outage/outage-notices.test.ts` — every pre-existing row preserved verbatim (the ⚠A7 sentence lands inside the bracket note, so the existing `replayWrap` row's `startsWith`/`contains`/`endsWith` pins all hold); the A7 pin is an appended describe.
- `src/channels/dispatcher.test.ts` — every other pre-existing row preserved verbatim; harness edits declared: hoisted `mockLogWarn` (Task 6) + the `DEADLINE_*` imports (Tasks 5/6). Existing rows never assert `warn`, so the shared warn mock is inert for them.
- `docs/providers.md`, `src/index.ts`, Lane B adapters, scheduler, task-ledger — deliberately untouched (spec §Integration, ⚠A9).

### Commands

All commands run from the child worktree root. **The delivery worktree ships without `node_modules` — Task 0 runs `npm ci` first.** Env stubs are required for anything importing config (all three; `SLACK_BOT_TOKEN` is the one that actually trips):

```bash
export SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test
```

- **Setup (Task 0):** `npm ci`
- **Unit (the touched suites):** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts src/channels/deadline-continuation.test.ts src/outage/outage-notices.test.ts src/outage/outage-replay-processor.test.ts`
- **Integration / E2E:** n/a (live V1 is deliver-lane, above)
- **Broader regression:** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (typecheck + lint + format + full test suite)

### Harness Requirements

Existing Vitest harness plus three contained extensions, each spelled out in its task:

1. **Hoisted warn mock (Task 6):** the module-scope logger mock currently exposes only `mockLogInfo`; T5/T14 assert warn lines, so the `vi.hoisted` block gains `mockLogWarn` and the factory's `warn: vi.fn()` becomes `warn: mockLogWarn`. No existing row asserts warn — inert for them. The new describe's `beforeEach` clears both shared mocks.
2. **Fire-and-forget observation (Task 6):** the continuation is `void this.dispatch(...)` by design; rows observe it with `vi.waitFor` (Vitest 4, default 1s timeout — also the failure mode under negative-verify: waitFor rows time out on pre-fix code) and a `flush()` (`setTimeout 0`) before *negative* count assertions ("no further dispatch").
3. **New describe setup (Task 6):** mirrors the KPR-307 outage describe (fresh dispatcher + `setOutageHandling` + local `slackItem`/`replayItem` helpers) with one addition: breaker `stateFor` defaults to `{ state: "closed", enabled: true }` — the arm is a closed-circuit surface and an explicit closed snapshot beats the mock's `null` for legibility.

### Non-Required Rationale (only for not-required groups)

- **Integration:** unit-only is the spec's explicit posture (§Tests: "cron/silent/replay branches are pure dispatch logic over seams the unit harness already fakes — KPR-400/401/403 unit-only precedent"). The dispatcher suite drives the real `dispatch → convertTurnResult → gates → arm → handleTurnFailure/handleOutageTurn` chain in-process; the only real-component seams the arm touches beyond that (store `$setOnInsert` insert semantics for per-leg keys, session-read keying) are already pinned in their own suites (`outage-queue-store.test.ts` D19 rows; `runWorkItemTurn`'s `threadId ?? item.id` read is existing, un-edited manager code).
- **E2E:** the two genuinely end-to-end questions (wrap behavior under real resume; ⚠A4 production timing) are exactly what the required live-instance V1 covers in the deliver lane — a CI-shaped E2E harness would add wall-clock minutes without reaching either.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Honest exit codes: never pipe a vitest run through another command without `set -o pipefail` in that shell; the commands below deliberately avoid piping vitest entirely.
- **Negative-verify (repo convention, `feedback_negative_verify_regression_tests`):** stash-free, commit-anchored reverse-apply — `git diff <anchor>^ <anchor> -- <source-file> | git apply -R`, run the suite, then `git checkout <anchor> -- <source-file>` to restore. **Never `git stash`.** Load-bearing anchors: Task 4 (replayWrap — the A7 pin row must fail), Task 6 (dispatcher — the enumerated rows must fail, plus two sharper manual edits: the meta-strip removal for T6/T13 and the thread-pin drop for T15). Task 2's anchor is degenerate (new pure-constants module — reverse-apply deletes the file and every row fails on import) and is documented as such.
- Per-commit-green discipline: every commit leaves the touched suites green; negative-verify steps run between a source commit and its test commit and always end with a restore + green re-run.

---

## Task 0: Worktree setup + baseline

**Files:** none (setup/verification only)

- [ ] **Step 1:** Install dependencies (the delivery worktree has no `node_modules`):

```bash
npm ci
```

- [ ] **Step 2:** Baseline the suites this plan touches or consumes — must be green before any edit:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts src/outage/outage-notices.test.ts src/outage/outage-replay-processor.test.ts
```

Expected: 0 failures. If not, stop — the branch base is broken; report a blocker.

- [ ] **Step 3:** Confirm the spec's dispatcher anchors have not drifted (they were verified at plan time @ 92f8e71, but the implement lane re-confirms by name, not line number):

```bash
grep -n "resolveReplayRealFailure(item, agentId, adapter, runResult.error)" src/channels/dispatcher.ts
grep -n "resolveReplayRealFailure(effectiveItem, agentId, adapter, runResult.error)" src/channels/dispatcher.ts
grep -n "★ timedOut with breaker closed" src/channels/dispatcher.test.ts
grep -n "★ KPR-398: with-progress deadline turn" src/channels/dispatcher.test.ts
grep -n "KPR-401: aborted/timedOut TurnResult surfaces" src/channels/dispatcher.test.ts
```

Expected: one hit each (≈ L301, L1057, L1292, L1304, L890). These five anchors are where Tasks 5's edits land.

- [ ] **Step 4:** No commit.

## Task 1: New module — `src/channels/deadline-continuation.ts`

**Files:**
- Create: `src/channels/deadline-continuation.ts`

- [ ] **Step 1:** Create the file with exactly this content:

```ts
/**
 * KPR-402: deadline-abort continuation — cap, notice templates, wrap, and
 * per-leg id derivation for the dispatcher's `maybeHandleDeadlineAbort` arm.
 *
 * Lives in src/channels/ beside its sole consumer, NOT in src/outage/: the
 * arm is deliberately not outage machinery (spec ⚠A6 — it needs no store,
 * and `outageQueue.enabled: false` does not disable it). Wording follows the
 * KPR-307 delegation style — exported constants so tests pin them; the
 * SMS/iMessage variants drop the emoji and stay short (⚠A2).
 */
import type { ChannelKind } from "../types/work-item.js";

/**
 * Chain cap (⚠A1): at most 2 in-process continuations per chain — ≤3
 * deadlines of wall clock — then the terminal notice names the manual
 * "continue" escape hatch (real: the KPR-399 session row persists either
 * way, so the user's next message resumes the partial work with zero engine
 * help). Exported constant, no config knob (simplicity posture — no
 * preemptive levers).
 */
export const MAX_DEADLINE_CONTINUATIONS = 2;

export const DEADLINE_NOTICE_DEFAULT =
  "⏳ That's taking longer than my per-turn time limit — I've saved my progress and I'm picking up where I left off.";
export const DEADLINE_NOTICE_SMS =
  "Still working on your request — it needs more time than one pass allows. I'm continuing now.";
export const DEADLINE_TERMINAL_NOTICE_DEFAULT =
  '⏳ I ran out of time on this several times over. I\'ve kept all my partial work — say "continue" and I\'ll pick it up again.';
export const DEADLINE_TERMINAL_NOTICE_SMS =
  'I couldn\'t finish your request in the time allowed. Reply "continue" to have me keep going.';
export const DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT =
  "⚠️ I couldn't get started on that within my time limit — please send it again.";
export const DEADLINE_ZERO_PROGRESS_NOTICE_SMS = "Your request timed out before I could start. Please re-send it.";

export function deadlineNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage" ? DEADLINE_NOTICE_SMS : DEADLINE_NOTICE_DEFAULT;
}

export function deadlineTerminalNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage" ? DEADLINE_TERMINAL_NOTICE_SMS : DEADLINE_TERMINAL_NOTICE_DEFAULT;
}

export function deadlineZeroProgressNoticeFor(kind: ChannelKind): string {
  return kind === "sms" || kind === "imessage"
    ? DEADLINE_ZERO_PROGRESS_NOTICE_SMS
    : DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT;
}

/**
 * The continuation wrap (spec §Design.4, Edge-12 resolution). Deterministic —
 * no timestamps. Safe under resume AND fresh: D26 makes resume the normal
 * case (the transcript holds the original prompt and all partial tool work;
 * the do-not-redo instruction is the guard Finding-4 needs, honorable
 * because side effects are visible IN the transcript); the embedded original
 * is the fresh-fallback belt for the two shapes where resume doesn't
 * materialize (⚠A4 persist-write race; KPR-399 §Edge-7 contender overwrite) —
 * without it a bare "continue" into a fresh session is a garbage turn. The
 * "No response needed." clause wires into the dispatcher's
 * NON_RESPONSE_PATTERNS suppression so a moved-on thread gets no zombie
 * answer.
 */
export function deadlineContinuationWrap(originalText: string, leg: number, totalLegs: number): string {
  const note =
    `[Continuation ${leg}/${totalLegs}: your previous turn on this request hit its wall-clock time limit ` +
    `and was cut off mid-work. Your session may already contain this request and your partial progress — ` +
    `continue from where you left off; do NOT redo completed work or re-run side-effectful actions that ` +
    `already ran. If the thread has moved on and no answer is needed, reply "No response needed." ` +
    `The original request follows for reference:]`;
  return `${note}\n\n${originalText}`;
}

/**
 * Strip one trailing `#dl<n>` so chain leg ids stay FLAT — leg 3 is `x#dl3`,
 * never `x#dl1#dl2#dl3` (⚠A11). Suffixing (not replacing) the origin id
 * keeps policyFor's prefix detection intact (`callback:x#dl1` is still
 * `callback:`-classed) and makes every leg's own outage enqueue a real
 * $setOnInsert insert under a fresh (itemId, agentId) key. Accepted residual
 * (⚠A11): a user/client-supplied id that genuinely ends in `#dl<k>` would be
 * mis-stripped — engine-synthesized ids never collide, and the misfire cost
 * is a wrong base-id string in a leg id, not a routing or policy change.
 */
export function deadlineBaseIdOf(id: string): string {
  return id.replace(/#dl\d+$/, "");
}
```

- [ ] **Step 2:** Verify — format, typecheck:

```bash
npx prettier --write src/channels/deadline-continuation.ts
npm run typecheck
```

Expected: typecheck clean (the module is pure and dependency-light — only the `ChannelKind` type import).

- [ ] **Step 3:** Commit:

```bash
git add src/channels/deadline-continuation.ts
git commit -m "feat(channels): deadline-continuation module — cap, notice templates, wrap, per-leg id derivation (KPR-402)

Pure-template module for the dispatcher's deadline-abort continuation arm:
MAX_DEADLINE_CONTINUATIONS (2 — ≤3 deadlines of wall clock per chain, ⚠A1),
first/terminal/zero-progress notices with SMS/iMessage variants (KPR-307
delegation style, ⚠A2), the deterministic Edge-12-safe continuation wrap
(do-not-redo guard + embedded original as the fresh-fallback belt +
NON_RESPONSE_PATTERNS no-op exit), and deadlineBaseIdOf (flat per-leg ids,
⚠A11). Lives in src/channels/, not src/outage/ — the arm is not outage
machinery (⚠A6).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 2: Module tests — T12 pins

**Files:**
- Create: `src/channels/deadline-continuation.test.ts`

- [ ] **Step 1:** Create the file with exactly this content:

```ts
import { describe, it, expect } from "vitest";
import {
  MAX_DEADLINE_CONTINUATIONS,
  DEADLINE_NOTICE_DEFAULT,
  DEADLINE_NOTICE_SMS,
  DEADLINE_TERMINAL_NOTICE_DEFAULT,
  DEADLINE_TERMINAL_NOTICE_SMS,
  DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT,
  DEADLINE_ZERO_PROGRESS_NOTICE_SMS,
  deadlineNoticeFor,
  deadlineTerminalNoticeFor,
  deadlineZeroProgressNoticeFor,
  deadlineContinuationWrap,
  deadlineBaseIdOf,
} from "./deadline-continuation.js";
import { policyFor } from "../outage/outage-notices.js";
import type { WorkItem } from "../types/work-item.js";

function item(id: string): WorkItem {
  return {
    id,
    text: "hello",
    source: { kind: "slack", id: "C1", label: "general" },
    sender: "user1",
    timestamp: new Date(),
  };
}

describe("deadline-continuation templates + constants (KPR-402, T12)", () => {
  it("cap is exactly 2 continuations (≤3 deadlines of wall clock) — exported constant, no config knob (⚠A1/⚠A6)", () => {
    expect(MAX_DEADLINE_CONTINUATIONS).toBe(2);
  });

  it("every exported notice string is pinned verbatim (⚠A2 — wording is a contract once shipped)", () => {
    expect(DEADLINE_NOTICE_DEFAULT).toBe(
      "⏳ That's taking longer than my per-turn time limit — I've saved my progress and I'm picking up where I left off.",
    );
    expect(DEADLINE_NOTICE_SMS).toBe(
      "Still working on your request — it needs more time than one pass allows. I'm continuing now.",
    );
    expect(DEADLINE_TERMINAL_NOTICE_DEFAULT).toBe(
      '⏳ I ran out of time on this several times over. I\'ve kept all my partial work — say "continue" and I\'ll pick it up again.',
    );
    expect(DEADLINE_TERMINAL_NOTICE_SMS).toBe(
      'I couldn\'t finish your request in the time allowed. Reply "continue" to have me keep going.',
    );
    expect(DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT).toBe(
      "⚠️ I couldn't get started on that within my time limit — please send it again.",
    );
    expect(DEADLINE_ZERO_PROGRESS_NOTICE_SMS).toBe("Your request timed out before I could start. Please re-send it.");
  });

  it("selectors: SMS/iMessage get the short no-emoji variants; everything else the default (KPR-307 pattern)", () => {
    expect(deadlineNoticeFor("sms")).toBe(DEADLINE_NOTICE_SMS);
    expect(deadlineNoticeFor("imessage")).toBe(DEADLINE_NOTICE_SMS);
    expect(deadlineNoticeFor("slack")).toBe(DEADLINE_NOTICE_DEFAULT);
    expect(deadlineNoticeFor("app")).toBe(DEADLINE_NOTICE_DEFAULT);
    expect(deadlineTerminalNoticeFor("sms")).toBe(DEADLINE_TERMINAL_NOTICE_SMS);
    expect(deadlineTerminalNoticeFor("slack")).toBe(DEADLINE_TERMINAL_NOTICE_DEFAULT);
    expect(deadlineZeroProgressNoticeFor("imessage")).toBe(DEADLINE_ZERO_PROGRESS_NOTICE_SMS);
    expect(deadlineZeroProgressNoticeFor("team")).toBe(DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT);
  });

  it("terminal notices name the manual escape hatch — the KPR-399 session row persists, 'continue' resumes it", () => {
    expect(DEADLINE_TERMINAL_NOTICE_DEFAULT).toContain('"continue"');
    expect(DEADLINE_TERMINAL_NOTICE_SMS).toContain('"continue"');
  });

  it("continuation wrap: deterministic, Edge-12-safe both ways (do-not-redo guard + embedded original + no-op exit)", () => {
    const wrap = deadlineContinuationWrap("summarize the repo", 1, 3);
    expect(wrap).toBe(deadlineContinuationWrap("summarize the repo", 1, 3)); // no timestamps — byte-deterministic
    expect(wrap.startsWith("[Continuation 1/3:")).toBe(true);
    expect(wrap).toContain("do NOT redo completed work");
    expect(wrap).toContain("re-run side-effectful actions");
    expect(wrap).toContain('reply "No response needed."'); // wires into NON_RESPONSE_PATTERNS suppression
    expect(wrap.endsWith("\n\nsummarize the repo")).toBe(true); // fresh-fallback belt: the original rides along
    expect(deadlineContinuationWrap("x", 2, 3).startsWith("[Continuation 2/3:")).toBe(true);
  });

  it("deadlineBaseIdOf strips exactly one trailing #dl<n> — leg ids stay flat (⚠A11)", () => {
    expect(deadlineBaseIdOf("x")).toBe("x");
    expect(deadlineBaseIdOf("x#dl1")).toBe("x");
    expect(deadlineBaseIdOf("x#dl12")).toBe("x");
    expect(deadlineBaseIdOf("callback:abc#dl2")).toBe("callback:abc");
    // Never produced by the chain (every leg re-derives from the base), but
    // the single-suffix strip is the documented contract:
    expect(deadlineBaseIdOf("x#dl1#dl2")).toBe("x#dl1");
  });

  it("per-leg suffix preserves policyFor's prefix classes — no policy plumbing (spec §Design.2)", () => {
    expect(policyFor(item("callback:x#dl1"))).toBe("silent");
    expect(policyFor(item("event:x#dl2"))).toBe("silent");
    expect(policyFor(item("team-x#dl1"))).toBe("silent");
    expect(policyFor(item("sched:x#dl1"))).toBe("skip");
    expect(policyFor(item("1699999999.000100#dl1"))).toBe("notify");
  });
});
```

- [ ] **Step 2:** Verify green, then run the degenerate negative-verify for the record (new pure-constants module — reverse-apply deletes the file and every row fails on import; documented, not load-bearing):

```bash
npx prettier --write src/channels/deadline-continuation.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/deadline-continuation.test.ts
git diff HEAD~1 HEAD -- src/channels/deadline-continuation.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/deadline-continuation.test.ts
git checkout HEAD -- src/channels/deadline-continuation.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/deadline-continuation.test.ts
```

Expected: green → whole-suite import failure (module deleted) → green post-restore. `git status --short` after restore shows only the untracked/added test file.

- [ ] **Step 3:** Commit:

```bash
git add src/channels/deadline-continuation.test.ts
git commit -m "test(channels): KPR-402 T12 pins — deadline-continuation templates, cap, wrap determinism, base-id derivation, policyFor suffix preservation

Every exported string pinned verbatim (⚠A2 delegation contract); cap === 2
(⚠A1); wrap pins the three Edge-12 clauses (do-not-redo, embedded original,
NON_RESPONSE_PATTERNS no-op exit); deadlineBaseIdOf single-suffix strip
(⚠A11); the #dl<n> suffix preserves policyFor's prefix classes. Negative-
verify is degenerate for a new pure-constants module (reverse-apply deletes
the file; all rows fail on import) — run for the record.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 3: replayWrap — the ⚠A7 resume-aware sentence

**Files:**
- Modify: `src/outage/outage-notices.ts` (one function body — `replayWrap` only)

- [ ] **Step 1:** Replace:

```ts
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
```

with:

```ts
/**
 * §5-2d replayed-turn presentation: prompt-note, not hard text prefix — the
 * model handles phrasing, staleness, and the re-ask-dedup case in its own voice.
 *
 * KPR-402 (⚠A7 — KPR-399 §Edge-12 closure): both variants carry one static
 * resume-aware sentence. Post-KPR-399 a post-turn-fault doc's replay resumes
 * the aborted session, whose transcript already contains this very message
 * and partial work on it — without the sentence the model would restart.
 * Safe when no session resumes (the normal fast-fail-class case — nothing to
 * falsely reference), materially better when one does. Static text only; no
 * processor logic, no store reads.
 */
export function replayWrap(originalText: string, receivedAt: Date, policy: "notify" | "silent"): string {
  const resumeNote =
    "If your session already contains this message and partial work on it, continue from where you left off instead of restarting.";
  const note =
    policy === "notify"
      ? `[This message was received at ${formatNoticeTime(receivedAt)} during an AI service outage and is being replayed now. Acknowledge the delay briefly if a human sent it. ${resumeNote}]`
      : `[Replayed after an AI service outage; originally received ${formatNoticeTime(receivedAt)}. ${resumeNote}]`;
  return `${note}\n\n${originalText}`;
}
```

- [ ] **Step 2:** Verify — format, typecheck, both consuming suites untouched-green (the sentence lands inside the bracket note, so `outage-notices.test.ts`'s existing `startsWith`/`contains`/`endsWith` pins and the processor suite's `^\[Replayed after an AI service outage/` prefix pin at L86 all hold):

```bash
npx prettier --write src/outage/outage-notices.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-notices.test.ts src/outage/outage-replay-processor.test.ts
```

Expected: typecheck clean; 0 failures with zero test edits.

- [ ] **Step 3:** Commit:

```bash
git add src/outage/outage-notices.ts
git commit -m "feat(outage): replayWrap gains the static resume-aware sentence (KPR-402 ⚠A7 — KPR-399 §Edge-12 closure)

Post-KPR-399 a post-turn-fault doc's replay resumes the aborted session,
whose transcript already contains the replayed message and partial work on
it — the wrap now tells the model to continue rather than restart. One
static sentence inside both policy variants' bracket notes: safe when no
session resumes (nothing to falsely reference), materially better when one
does. Clean-wrap-sized; no processor logic, no store reads; every existing
shape pin holds byte-unmodified.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 4: outage-notices tests — A7 pin + negative-verify

**Files:**
- Modify: `src/outage/outage-notices.test.ts` (one describe appended at end of file; **no pre-existing row edited**)

- [ ] **Step 1:** Append at end of file (after the closing `});` of the final existing describe):

```ts

describe("replayWrap resume-aware sentence (KPR-402 ⚠A7 — KPR-399 §Edge-12 closure)", () => {
  it("both policy variants carry the static sentence inside the note; the original still ends the wrap verbatim", () => {
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix replayWrap carries no
    // resume sentence — both toContain assertions fail.
    const notify = replayWrap("original question", new Date(), "notify");
    const silent = replayWrap("do the thing", new Date(), "silent");
    const sentence =
      "If your session already contains this message and partial work on it, continue from where you left off instead of restarting.";
    expect(notify).toContain(sentence);
    expect(silent).toContain(sentence);
    // The sentence lives INSIDE the bracketed note — shape pins hold.
    expect(notify.endsWith("original question")).toBe(true);
    expect(silent.endsWith("do the thing")).toBe(true);
  });
});
```

- [ ] **Step 2:** Verify green + insertion-only diff:

```bash
npx prettier --write src/outage/outage-notices.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-notices.test.ts
git diff -- src/outage/outage-notices.test.ts
```

Expected: all tests pass; the diff is one contiguous appended describe — no pre-existing row touched.

- [ ] **Step 3:** Negative-verify (NO `git stash`). Task 3's commit is `HEAD`; reverse-apply its source diff:

```bash
git diff HEAD~1 HEAD -- src/outage/outage-notices.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-notices.test.ts
```

Expected: **exactly the new A7 row fails** (sentence absent on pre-fix code); every pre-existing row — the original `replayWrap` shape row included — passes. If it does not fail, stop and fix the test.

Restore and confirm:

```bash
git checkout HEAD -- src/outage/outage-notices.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-notices.test.ts
```

Expected `git status --short`: exactly ` M src/outage/outage-notices.test.ts`. Suite green post-restore.

- [ ] **Step 4:** Commit:

```bash
git add src/outage/outage-notices.test.ts
git commit -m "test(outage-notices): KPR-402 pin — replayWrap carries the resume-aware sentence, both policies

Negative-verified: with Task 3's outage-notices.ts diff reverse-applied,
the new row fails (no resume sentence on pre-fix code); every pre-existing
row — the original replayWrap shape pins included — passes both ways with
zero edits.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 5: Dispatcher source — the arm, both call sites, three D28 row migrations

**Files:**
- Modify: `src/channels/dispatcher.ts` (one import block addition; the arm method between `maybeHandlePostTurnOutage` and `handleOutageTurn`; one call insertion in each dispatch body)
- Modify: `src/channels/dispatcher.test.ts` (**declared D28 migrations only** — three rows + one import line; the new describe is Task 6)

This is deliberately one commit: with the source arm in place, the notify-lane `timedOut && aborted` rows break — the migrated 1304 row's old shape becomes racy-red (the arm fires a continuation whose delivery races the old `toHaveBeenCalledTimes(1)` assertion) and the KPR-401 log-fields row deterministically loses its "Work item dispatched" line — so per-commit green forces the migrations to ride the source commit (KPR-403 Task 3 coupled-commit precedent). The 1292 row would pass structurally un-migrated (its old assertions never pinned the delivered text), but it migrates here too so all three D28 edits land in one reviewable hunk set.

- [ ] **Step 1 (imports):** In `src/channels/dispatcher.ts`, replace:

```ts
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

with:

```ts
import {
  OutageEpisodeTracker,
  adapterKeyFor,
  outageNoticeFor,
  overflowNoticeFor,
  policyFor,
  terminalFailureNotice,
  threadKeyFor,
} from "../outage/outage-notices.js";
import {
  MAX_DEADLINE_CONTINUATIONS,
  deadlineBaseIdOf,
  deadlineContinuationWrap,
  deadlineNoticeFor,
  deadlineTerminalNoticeFor,
  deadlineZeroProgressNoticeFor,
} from "./deadline-continuation.js";
```

- [ ] **Step 2 (call site 1 — `dispatch()`):** Replace:

```ts
      if (this.outage && item.meta?.outageReplay && runResult.error) {
        await this.resolveReplayRealFailure(item, agentId, adapter, runResult.error);
        return;
      }

      const trimmedText = runResult.text.trim();
```

with:

```ts
      if (this.outage && item.meta?.outageReplay && runResult.error) {
        await this.resolveReplayRealFailure(item, agentId, adapter, runResult.error);
        return;
      }

      // KPR-402: closed-circuit deadline-abort interception. Runs AFTER
      // maybeHandlePostTurnOutage (the zero-progress+open ★ row keeps the
      // outage path unchanged; the with-progress+open ★ row migrates from
      // bare legacy delivery to this arm — spec §Design.6 / ⚠A8) and after
      // the replay-error gate (disjoint: a Claude-lane deadline abort never
      // sets error — the runner's deadline CLOSES the iterator).
      if (await this.maybeHandleDeadlineAbort(item, agentId, adapter, runResult)) {
        return;
      }

      const trimmedText = runResult.text.trim();
```

- [ ] **Step 3 (call site 2 — `dispatchToAgent()`):** Replace:

```ts
      if (this.outage && effectiveItem.meta?.outageReplay && runResult.error) {
        await this.resolveReplayRealFailure(effectiveItem, agentId, adapter, runResult.error);
        return;
      }

      const trimmedText = runResult.text.trim();
```

with:

```ts
      if (this.outage && effectiveItem.meta?.outageReplay && runResult.error) {
        await this.resolveReplayRealFailure(effectiveItem, agentId, adapter, runResult.error);
        return;
      }

      // KPR-402: same deadline-abort arm as the single-dispatch path — the
      // fan-out body is a near-duplicate (same placement discipline as
      // maybeHandlePostTurnOutage above).
      if (await this.maybeHandleDeadlineAbort(effectiveItem, agentId, adapter, runResult)) {
        return;
      }

      const trimmedText = runResult.text.trim();
```

- [ ] **Step 4 (the arm):** Replace:

```ts
    // KPR-400 (F2): the turn RAN and hard-faulted with the breaker open —
    // post-turn-fault class (deadline burners live here; replays last).
    return this.handleOutageTurn(item, agentId, adapter, provider, "post-turn-fault");
  }
```

with:

```ts
    // KPR-400 (F2): the turn RAN and hard-faulted with the breaker open —
    // post-turn-fault class (deadline burners live here; replays last).
    return this.handleOutageTurn(item, agentId, adapter, provider, "post-turn-fault");
  }

  /**
   * KPR-402: deadline-abort continuation arm. Matches the D6 rows 1-2 shape
   * only (`timedOut && aborted` — the Claude-lane/Lane-A deadline abort):
   * Lane B's sentinel carries `aborted: false` and operator stops carry no
   * `timedOut`, so neither ever enters. NOT outage machinery (⚠A6): active
   * regardless of `outageQueue.enabled` — the replay-doc branches simply
   * never fire when `this.outage` is unset (no replays exist then).
   *
   * With progress (D6 kind `turn-deadline` — the KPR-399-persisted session
   * exists): honest first-abort notice on notify channels, then an
   * IN-PROCESS re-dispatch of a synthetic continuation item whose session
   * resumes through the unchanged runWorkItemTurn → sessionStore.get path
   * (emergent, zero new code — and dependent on the thread-key pin below).
   * Bounded chain: MAX_DEADLINE_CONTINUATIONS, then a terminal notice
   * naming the manual "continue" hatch. Zero progress (hard `timeout` — the
   * hang signature): notice only / warn-log only, never a re-dispatch.
   * Cron: fully inert. The breaker never sees this arm — the aborted leg's
   * record-once (inconclusive `turn-deadline`) already happened in the
   * manager, and the arm adds no record site.
   *
   * Returns true when the turn was fully handled (notice and/or re-dispatch
   * and/or replay-doc resolution); false = fall through to normal delivery.
   */
  private async maybeHandleDeadlineAbort(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    runResult: RunResult,
  ): Promise<boolean> {
    if (runResult.timedOut !== true || runResult.aborted !== true) return false;
    const policy = policyFor(item);
    if (policy === "skip") return false; // cron: re-fires at next match — arm fully inert (ticket ruling)

    // D6 single source of truth — full RunResult through classifyTurnResult
    // (the KPR-398 call-site convention), never a re-implemented predicate.
    const withProgress = classifyTurnResult(runResult).kind === "turn-deadline";

    if (!withProgress) {
      // Zero progress (hard `timeout`): NEVER a re-dispatch (⚠A3) — nothing
      // was persisted to resume (D1 fail-closed persist gate), a fresh
      // restart would re-run the full turn against a provider that just sat
      // silent for the entire deadline, and repeat hangs are the breaker's
      // designed territory (three consecutive open the circuit and the
      // KPR-307 queue+notice machinery takes over with its own honest story).
      if (this.outage && item.meta?.outageReplay) {
        // §5-2g "real failure while breaker closed": attempts+1, pending
        // again (silent — the enqueue-time outage notice's promise still
        // stands) or terminal `failed` with the existing terminal notice.
        // No separate deadline notice — never double-notice one thread.
        await this.resolveReplayRealFailure(item, agentId, adapter, "turn deadline exceeded (zero progress)");
        return true;
      }
      if (policy === "notify") {
        await this.deliverOutageNotice(item, agentId, adapter, deadlineZeroProgressNoticeFor(item.source.kind));
      } else {
        // Silent one-shot (callback:/event:/team-): warn log only — no
        // human is owed a notice (KPR-307 posture). The one-shot's trigger
        // is lost for this firing (accepted, spec §Design.3 r1 B2); the
        // warn keeps it conspicuous, and the bare "_No response._" delivery
        // to a system surface is suppressed too.
        log.warn("Deadline zero-progress abort on silent one-shot — dropped with log", {
          agentId,
          itemId: item.id,
        });
      }
      return true;
    }

    // ---- With progress: notice + in-process continuation ----

    // 1. Replay-doc resolution: the queue slot resolves; the chain owns the
    //    turn from here (⚠A5: a crash mid-chain loses only the continuation
    //    — the session row survives, so the thread's next message resumes
    //    the partial work; strictly better than today's done+"_No response._").
    if (this.outage && item.meta?.outageReplay) {
      await this.outage.store
        .release(item.id, agentId, "done", "deadline abort — continuation dispatched in-process (KPR-402)")
        .catch((err) => log.error("Deadline-abort replay done-release failed", { error: String(err) }));
    }

    const n = Number(item.meta?.deadlineRetry ?? 0);

    // 2. Notice cadence: two per chain, maximum — one first-abort notice
    //    (deadlineRetry absent), silence on intermediate legs, one terminal
    //    notice at the cap. No episode-tracker involvement (deadline aborts
    //    are discrete per-thread events, not provider episodes).
    if (policy === "notify" && item.meta?.deadlineRetry === undefined) {
      await this.deliverOutageNotice(item, agentId, adapter, deadlineNoticeFor(item.source.kind));
    }

    // 3. Cap check (G3): the counter strictly increments and nothing resets
    //    or strips it; the terminal notice's manual hatch is real — the
    //    KPR-399 session row persists either way.
    if (n >= MAX_DEADLINE_CONTINUATIONS) {
      if (policy === "notify") {
        await this.deliverOutageNotice(item, agentId, adapter, deadlineTerminalNoticeFor(item.source.kind));
      } else {
        log.warn("Deadline continuation cap exhausted on silent one-shot", { agentId, itemId: item.id });
      }
      return true;
    }

    // 4. Re-dispatch — AFTER the notice delivery completed (the adapter
    //    round-trip also puts real time between finalize's fire-and-forget
    //    session write and the continuation's store read — belt, ⚠A4).
    //
    // META HYGIENE (spec r1 B1): replay markers must NOT leak into the
    // chain. The processor stamps `outageReplay: true` on every replayItem,
    // and the dispatcher's three replay branches (resolveReplayRealFailure,
    // handleOutageTurn's release-before-depth, handleTurnFailure's
    // pending-release) key on that flag with store filters of {itemId,
    // agentId} and NO status guard — an inherited flag would let a
    // continuation leg's later failure resurrect the origin's resolved
    // `done` doc back to pending (duplicate replay of the ORIGINAL stored
    // workItem). Strip on EVERY leg construction: a fresh-seeded chain
    // acquires the flag after one queue round-trip. Everything else in meta
    // passes through unchanged (blocklist, not allowlist — channel keys
    // like slackThreadTs are load-bearing for routing and delivery).
    const { outageReplay: _replayMarker, ...carriedMeta } = item.meta ?? {};
    const baseId = deadlineBaseIdOf(item.id); // leg ids stay flat: x#dl3, never x#dl1#dl2#dl3 (⚠A11)
    const originalText =
      typeof item.meta?.deadlineOriginalText === "string" ? item.meta.deadlineOriginalText : item.text;
    const retryItem: WorkItem = {
      ...item,
      // Per-leg id (⚠A11): a chain leg's own outage enqueue (breaker opens
      // mid-chain) writes under a FRESH (itemId, agentId) key — a real
      // $setOnInsert insert beside the origin's terminal doc that serializes
      // the leg's workItem (counter included) verbatim, never a silent
      // same-key no-op. Suffixing keeps policyFor's prefix classes intact
      // (callback:x#dl1 is still callback:-classed), and dedup needs no
      // bypass edit: each leg's id is first-seen.
      id: `${baseId}#dl${n + 1}`,
      // THREAD-KEY PINNING (spec r2 blocker): every threadId consumer falls
      // back to item.id when threadId is absent — runWorkItemTurn's session
      // read (agent-manager.ts:866), the per-thread lock, threadAgentMap,
      // the task ledger. For threadId-less items (callback:/bg:/ct:/
      // meeting: completions) the origin leg persisted its session under
      // key `x` while an unpinned continuation would READ under `x#dl1`:
      // no resume, ever — the blind fresh re-run Finding-4 forbids.
      // Materialize the origin's EFFECTIVE thread key before the id changes;
      // threaded items are unaffected (identity copy).
      threadId: item.threadId ?? item.id,
      text: deadlineContinuationWrap(originalText, n + 1, MAX_DEADLINE_CONTINUATIONS + 1),
      meta: {
        ...carriedMeta,
        targetAgentId: agentId, // resolveAgents step 0 — routed exactly like a replay, no re-resolution drift
        deadlineRetry: n + 1,
        // Wrap round-trip (T9): a later leg wraps the ORIGINAL request, never
        // a previous leg's wrap nested.
        deadlineOriginalText: originalText,
      },
    };
    // Fire-and-forget: awaiting would hold the caller (an adapter handler or
    // the replay drain) for another full deadline. onProcessingEnd fires for
    // the aborted leg; the continuation's own dispatch restarts the typing
    // indicator. The replay drain's statusOf re-read sees `done` (step 1)
    // and keeps draining — never the "no outcome recorded" defensive revert.
    void this.dispatch(retryItem).catch((err) =>
      log.error("Deadline continuation dispatch failed", { agentId, error: String(err) }),
    );
    log.info("Deadline continuation dispatched in-process", {
      agentId,
      itemId: retryItem.id,
      deadlineRetry: n + 1,
    });
    return true;
  }
```

- [ ] **Step 5 (test import — for the migrated rows):** In `src/channels/dispatcher.test.ts`, replace:

```ts
import {
  OutageEpisodeTracker,
  OUTAGE_NOTICE_DEFAULT,
  OUTAGE_OVERFLOW_NOTICE_DEFAULT,
} from "../outage/outage-notices.js";
```

with:

```ts
import {
  OutageEpisodeTracker,
  OUTAGE_NOTICE_DEFAULT,
  OUTAGE_OVERFLOW_NOTICE_DEFAULT,
} from "../outage/outage-notices.js";
import { DEADLINE_NOTICE_DEFAULT, DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT } from "./deadline-continuation.js";
```

- [ ] **Step 6 (D28 migration 1 — the KPR-401 log-fields row, dispatcher.test.ts:890):** Replace the row's title comment and item construction. In the `it("KPR-401: aborted/timedOut TurnResult surfaces both flags + non-negative llmMs on the work-item-dispatched log", …)` block, replace:

```ts
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix the log-field object
    // simply lacks the two keys — fields.aborted is undefined; this fails.
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);
```

with:

```ts
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix the log-field object
    // simply lacks the two keys — fields.aborted is undefined; this fails.
    // D28 fixture migration (KPR-402): a timedOut && aborted turn on a
    // notify-policy channel is now intercepted by the deadline-continuation
    // arm and never reaches normal delivery — the log-field pin migrates to
    // the skip-policy (sched:) lane, the one lane where legacy delivery of
    // an aborted turn deliberately remains (arm fully inert on cron). The
    // assertions are byte-identical; only the item id changed. The
    // notify-lane behavior is pinned by the KPR-402 rows below.
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);
```

and, in the same block, replace:

```ts
    const item = makeWorkItem({
      source: { kind: "sms", id: "PN_LINE_M", label: "quo-may", adapterId: "sms" },
      threadId: "sms:PN_LINE_M:+15550101",
      text: "hey Jasper, kpr401 probe", // agent-name-bearing, mirroring the Phase-1 row's resolution path
    });
```

with:

```ts
    const item = makeWorkItem({
      id: "sched:jasper:kpr401-probe:1", // KPR-402 D28: skip policy — arm inert, legacy delivery + log preserved
      source: { kind: "sms", id: "PN_LINE_M", label: "quo-may", adapterId: "sms" },
      threadId: "sms:PN_LINE_M:+15550101",
      text: "hey Jasper, kpr401 probe", // agent-name-bearing, mirroring the Phase-1 row's resolution path
    });
```

- [ ] **Step 7 (D28 migration 2 — row 1292):** Replace:

```ts
  it("★ timedOut with breaker closed → legacy path, unqueued", async () => {
    // KPR-398 zero-progress pin (see the open-breaker row above).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });

    await dispatcher.dispatch(slackItem());
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // "_No response._" as today
  });
```

with:

```ts
  it("★ KPR-402 (D28 migration): zero-progress deadline abort with breaker closed → honest zero-progress notice, still unqueued", async () => {
    // KPR-398 zero-progress pin (see the open-breaker row above).
    // D28 fixture-migration justification: this row previously pinned the
    // pre-KPR-402 defect shape — bare "_No response._" delivery ("as
    // today"). The deadline arm now intercepts the closed-circuit
    // zero-progress abort with an honest notice, no re-dispatch (spec
    // §Design.3 / T10). The never-queued half of the old pin is retained
    // verbatim.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });

    await dispatcher.dispatch(slackItem());
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT); // was: "_No response._"
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
  });
```

- [ ] **Step 8 (D28 migration 3 — row 1304):** Replace:

```ts
  it("★ KPR-398: with-progress deadline turn with breaker open → legacy path, never queued", async () => {
    // A turn-deadline-with-progress by definition executed tools or streamed;
    // queuing it into outage_queue would silently re-run those side effects
    // on replay (the gate's Finding 4 r1 rationale). Mirror of the zero-
    // progress open-breaker row above, flipped by progress evidence alone.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true, toolCalls: 46, streamed: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });

    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // legacy "_No response._" delivery, not the notice
    expect(adapter.deliver.mock.calls[0][0].text).not.toBe(OUTAGE_NOTICE_DEFAULT);
  });
```

with:

```ts
  it("★ KPR-398/KPR-402 (D28 migration): with-progress deadline turn with breaker open → deadline arm, never queued by the gate (D3 pin)", async () => {
    // A turn-deadline-with-progress by definition executed tools or streamed;
    // queuing it into outage_queue would silently re-run those side effects
    // on replay (the gate's Finding 4 r1 rationale).
    // D28 fixture-migration justification (spec ⚠A8): the with-progress+open
    // row migrates from bare legacy "_No response._" delivery to the
    // deadline arm — notice + in-process continuation. THE RETAINED
    // never-queued ASSERTION IS THE D3 PIN: the original partially-executed
    // turn is never enqueued for blind replay (turn-deadline ∉
    // HARD_FAULT_KINDS keeps the outage gate declining); what may later
    // reach the queue is only a continuation leg under its own per-leg id
    // (the KPR-402 T13 row).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true, toolCalls: 46, streamed: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });

    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).not.toHaveBeenCalled(); // D3: never queued by the gate — retained verbatim
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_NOTICE_DEFAULT); // honest notice, not "_No response._"
    expect(adapter.deliver.mock.calls[0][0].text).not.toBe(OUTAGE_NOTICE_DEFAULT);
    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
    expect((agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem).id).toBe("m1#dl1"); // the continuation
  });
```

- [ ] **Step 9:** Verify — format, typecheck, touched suites green (in particular: the `★ timeout gate` row at 1276 and all three `KPR-400 F2` + three `KPR-403` rows pass **byte-unmodified**):

```bash
npx prettier --write src/channels/dispatcher.ts src/channels/dispatcher.test.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts
git diff --stat
```

Expected: typecheck clean; 0 failures; the diff touches exactly `src/channels/dispatcher.ts` + `src/channels/dispatcher.test.ts`. (The conference suite is run once here as a canary for the `dispatchToAgent` call-site insertion — it has no `timedOut` fixtures, so it must pass untouched.)

- [ ] **Step 10:** Commit:

```bash
git add src/channels/dispatcher.ts src/channels/dispatcher.test.ts
git commit -m "fix(dispatcher): deadline-abort continuation arm — honest notice + in-process resume chain, capped (KPR-402)

A turn that burns its wall-clock deadline with the circuit closed used to
fall through every gate and deliver a bare '_No response._' (or an unmarked
fragment) — no retry, no honest notice, replayed docs released done and
permanently half-answered. The new maybeHandleDeadlineAbort arm (both
dispatch bodies, after the outage + replay-error gates) intercepts the
timedOut && aborted shape: with progress (classifyTurnResult kind
turn-deadline — D6, never re-implemented) it delivers one first-abort
notice on notify channels and re-dispatches in-process a continuation item
— per-leg id <originId>#dl<n> (real \$setOnInsert inserts if a leg later
enqueues; policyFor prefix classes preserved), outageReplay stripped (a
leaked marker would let a leg's failure resurrect the origin's resolved
done doc), threadId pinned to the origin's effective key (threadId-less
items would otherwise re-key the KPR-399 session read and never resume),
deadlineRetry strictly incremented, capped at MAX_DEADLINE_CONTINUATIONS=2
with a terminal notice naming the manual 'continue' hatch. Zero progress:
notice only (warn-log only on silent one-shots), never a re-dispatch —
nothing persisted to resume; hangs are the breaker's territory. Cron
inert. Replay docs: with-progress → released done + the chain owns the
turn; zero-progress → the existing §5-2g attempts machinery. Session
resume is emergent (KPR-399 contract) — zero manager/runner/store edits;
the breaker sees nothing new (record-once already ran manager-side).

Three D28 fixture migrations ride this commit (per-commit green forces the
coupling): rows 1292/1304 (spec T10 — 1304 retains its never-queued
assertion as the D3 pin) and the KPR-401 log-fields row (plan-discovered:
migrated to the sched:/skip lane, assertions byte-identical). The 1276
zero-progress+open row passes byte-unmodified — the D6 routing pin.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 6: Dispatcher tests — the KPR-402 describe (T1–T9, T11, T13–T15) + negative-verify

**Files:**
- Modify: `src/channels/dispatcher.test.ts` (hoisted-mock harness edit; import extension; one new describe inserted between the `outage interception (KPR-307)` describe and the KPR-308 section header). **No other pre-existing row edited.**

- [ ] **Step 1 (harness — hoisted warn mock):** Replace:

```ts
const { mockLogInfo } = vi.hoisted(() => ({ mockLogInfo: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
```

with:

```ts
// KPR-402: mockLogWarn added for the silent-cell warn-log pins (T5/T14). No
// pre-existing row asserts warn, so the shared mock is inert for them.
const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({ mockLogInfo: vi.fn(), mockLogWarn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
```

- [ ] **Step 2 (import extension):** Replace:

```ts
import { DEADLINE_NOTICE_DEFAULT, DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT } from "./deadline-continuation.js";
```

with:

```ts
import {
  DEADLINE_NOTICE_DEFAULT,
  DEADLINE_TERMINAL_NOTICE_DEFAULT,
  DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT,
  deadlineContinuationWrap,
} from "./deadline-continuation.js";
```

- [ ] **Step 3 (the new describe):** Insert between the closing `});` of `describe("outage interception (KPR-307)", …)` and the `// ---------------------------------------------------------------------------` header of `// KPR-308 — outage-mode delivery preference`, verbatim:

```ts

// ---------------------------------------------------------------------------
// KPR-402: deadline-abort continuation chain
// ---------------------------------------------------------------------------

describe("deadline-abort continuation (KPR-402)", () => {
  let dispatcher: Dispatcher;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;
  let store: ReturnType<typeof makeOutageStore>;
  let episodes: OutageEpisodeTracker;

  beforeEach(() => {
    mockLogInfo.mockClear();
    mockLogWarn.mockClear();
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
    // The arm is a closed-circuit surface — default to an explicit closed
    // snapshot (rows that need open override per-row).
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
  });

  function slackItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return makeWorkItem({ source: { kind: "slack", id: "C999", label: "general" }, ...overrides });
  }

  function replayItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return slackItem({ meta: { outageReplay: true, targetAgentId: "executive-assistant" }, ...overrides });
  }

  /** D6 rows 1-2 fixture shapes (KPR-398): observed progress vs the hang signature. */
  const withProgressAbort = () =>
    makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true, toolCalls: 46, streamed: true });
  const zeroProgressAbort = () => makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true });

  /** Drain the fire-and-forget continuation's microtask/timer chain before NEGATIVE count assertions. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("T1: with-progress abort, closed, slack → notice + in-process continuation; never '_No response._', never queued", async () => {
    // NEGATIVE-VERIFY prediction (Step 4 NV-A): pre-fix the arm does not
    // exist — bare "_No response._" delivery (the old 1292 shape) reappears
    // and no second dispatch ever fires; this row fails on the notice text
    // and the waitFor times out.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({ id: "m1", threadId: "t1", text: "summarize the big repo", meta: { slackThreadTs: "171.001" } }),
    );

    // Notice first — exact text, error UNSET (SMS-skip class regression guard).
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_NOTICE_DEFAULT);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
    expect(store.enqueue).not.toHaveBeenCalled(); // closed circuit — the queue is never touched

    // The continuation (default mock: success) runs as a second dispatch.
    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
    const cont = agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem;
    expect(cont.id).toBe("m1#dl1"); // per-leg id (⚠A11)
    expect(cont.threadId).toBe("t1"); // threaded origin: identity copy (T15 pins the threadId-less case)
    expect(cont.meta).toMatchObject({
      deadlineRetry: 1,
      targetAgentId: "executive-assistant",
      slackThreadTs: "171.001", // channel meta carried through (blocklist, not allowlist)
      deadlineOriginalText: "summarize the big repo",
    });
    expect(cont.meta?.outageReplay).toBeUndefined(); // meta hygiene (r1 B1)
    expect(cont.text).toBe(deadlineContinuationWrap("summarize the big repo", 1, 3));

    await vi.waitFor(() => expect(adapter.deliver).toHaveBeenCalledTimes(2));
    const texts = adapter.deliver.mock.calls.map((c: any[]) => c[0].text);
    expect(texts).not.toContain("_No response._");
    expect(texts[1]).toBe("turn response"); // the continuation's real answer, delivered normally
  });

  it("T2: chain cap — an item arriving with deadlineRetry 2 aborts with progress → terminal notice, no further dispatch", async () => {
    // NEGATIVE-VERIFY (documented, covered by NV-A): dropping the cap check
    // would fire a third dispatch — the flush + count assertion fails.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({
        id: "m1#dl2",
        threadId: "t1",
        meta: { deadlineRetry: 2, targetAgentId: "executive-assistant", deadlineOriginalText: "orig" },
      }),
    );

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_TERMINAL_NOTICE_DEFAULT);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1); // the chain is over
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("T3: zero-progress, closed, non-replay → zero-progress notice only; no re-dispatch; no queue write", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(zeroProgressAbort());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_ZERO_PROGRESS_NOTICE_DEFAULT);
    expect(adapter.deliver.mock.calls[0][0].error).toBeUndefined();
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1); // never a re-dispatch on zero progress (⚠A3)
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("T4: cron (sched:) deadline abort → arm fully inert — existing delivery unchanged, no notice, no re-dispatch", async () => {
    // Pin, passes both ways by design (ticket ruling: cron re-fires at the
    // next match; queueing or retrying would double-run).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({ id: "sched:executive-assistant:daily:1", meta: { targetAgentId: "executive-assistant" } }),
    );

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe("_No response._"); // legacy delivery, exactly as today
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("T5: silent policy (callback:), with-progress → full chain without ANY notices; cap exhaustion warn-logged", async () => {
    // Every leg aborts with progress: leg 1 → #dl1 → #dl2 hits the cap.
    agentManager.runWorkItemTurn.mockResolvedValue(withProgressAbort());
    await dispatcher.dispatch(slackItem({ id: "callback:x", threadId: "cb-t1", meta: { targetAgentId: "executive-assistant" } }));

    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3));
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3); // cap: never a 4th leg
    expect(adapter.deliver).not.toHaveBeenCalled(); // zero notices, zero deliveries — silent stays silent
    expect((agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem).id).toBe("callback:x#dl1");
    expect((agentManager.runWorkItemTurn.mock.calls[2][1] as WorkItem).id).toBe("callback:x#dl2"); // flat (⚠A11)
    expect(
      mockLogWarn.mock.calls.some(([msg]) => msg === "Deadline continuation cap exhausted on silent one-shot"),
    ).toBe(true);
    expect(store.enqueue).not.toHaveBeenCalled();
  });

  it("T6: replay item, with-progress, closed → doc released done + notice + continuation with outageReplay STRIPPED", async () => {
    // NEGATIVE-VERIFY (Step 4 NV-B, manual meta-strip edit): a naive
    // `...item.meta` spread carries outageReplay: true into the chain — the
    // hygiene assertion fails on that construction (r1 B1/ADV3).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(replayItem({ id: "x", threadId: "t1" }));

    expect(store.release).toHaveBeenCalledWith(
      "x",
      "executive-assistant",
      "done",
      "deadline abort — continuation dispatched in-process (KPR-402)",
    );
    // deadlineRetry absent on the doc's serialized meta → first-notice fires.
    expect(adapter.deliver.mock.calls[0][0].text).toBe(DEADLINE_NOTICE_DEFAULT);
    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
    const cont = agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem;
    expect(cont.id).toBe("x#dl1");
    expect(cont.meta?.outageReplay).toBeUndefined(); // meta hygiene pinned
    expect(cont.meta?.deadlineRetry).toBe(1);
  });

  it("T7: replay item, zero-progress, closed → §5-2g real-failure path (attempts+1), no deadline notice, no re-dispatch", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(zeroProgressAbort());
    await dispatcher.dispatch(replayItem({ id: "x" }));

    expect(store.recordFailedAttempt).toHaveBeenCalledWith(
      "x",
      "executive-assistant",
      "turn deadline exceeded (zero progress)",
      OUTAGE_CONFIG.maxReplayAttempts,
    );
    expect(store.release).not.toHaveBeenCalled(); // neither done nor pending — the attempts machinery owns the doc
    expect(adapter.deliver).not.toHaveBeenCalled(); // non-terminal: silent (the enqueue-time notice's promise stands)
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
  });

  it("T8: per-leg id vs dedup — the continuation is first-seen (no bypass edit exists); a replayed continuation doc uses the existing outageReplay bypass", async () => {
    // Half 1: after origin id m1 is dedup-seen, the continuation m1#dl1
    // dispatches through step 0 untouched — proven by the second turn running.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));

    // Half 2: a replayed continuation doc re-enters under the LEG's id with
    // the processor-stamped outageReplay flag — the existing bypass admits
    // it even though m1#dl1 is now dedup-seen from half 1, and its store
    // writes address the LEG's own doc, never the origin's.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn());
    await dispatcher.dispatch(
      replayItem({
        id: "m1#dl1",
        threadId: "t1",
        meta: { outageReplay: true, targetAgentId: "executive-assistant", deadlineRetry: 1 },
      }),
    );
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3);
    expect(store.release).toHaveBeenCalledWith("m1#dl1", "executive-assistant", "done");
  });

  it("T9: wrap round-trip + flat ids + two-notice cadence — a later leg wraps the ORIGINAL text, counter monotonic", async () => {
    agentManager.runWorkItemTurn.mockResolvedValue(withProgressAbort()); // every leg deadline-aborts with progress
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1", text: "the original ask" }));

    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(adapter.deliver).toHaveBeenCalledTimes(2));
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3); // cap: never a 4th leg

    const [leg1, leg2, leg3] = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[1] as WorkItem);
    expect(leg1.id).toBe("m1");
    expect(leg2.id).toBe("m1#dl1");
    expect(leg3.id).toBe("m1#dl2"); // flat — never m1#dl1#dl2 (deadlineBaseIdOf)
    // Leg 3 wraps the ORIGINAL request (deadlineOriginalText carriage), never leg 2's wrap nested.
    expect(leg2.text).toBe(deadlineContinuationWrap("the original ask", 1, 3));
    expect(leg3.text).toBe(deadlineContinuationWrap("the original ask", 2, 3));
    expect(leg3.meta?.deadlineRetry).toBe(2); // strictly monotonic
    // Cadence: exactly two notices per chain — first + terminal; the middle leg is silent.
    const texts = adapter.deliver.mock.calls.map((c: any[]) => c[0].text);
    expect(texts).toEqual([DEADLINE_NOTICE_DEFAULT, DEADLINE_TERMINAL_NOTICE_DEFAULT]);
  });

  it("T11: Lane B sentinel (aborted: false) and operator abort (no timedOut) never enter the arm", async () => {
    // Pin, passes both ways by design (Non-Goals / C3: Lane B keeps
    // !result.aborted byte-for-byte; an operator who stopped a turn needs no
    // notice that it stopped).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: ["error_turn_deadline"], timedOut: true, aborted: false }),
    );
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].error).toBe("error_turn_deadline"); // existing visible error surfacing

    agentManager.runWorkItemTurn.mockResolvedValueOnce(makeTurn({ finalMessage: "stopped mid-answer", aborted: true }));
    await dispatcher.dispatch(slackItem({ id: "m2", threadId: "t2" }));
    expect(adapter.deliver).toHaveBeenCalledTimes(2);
    expect(adapter.deliver.mock.calls[1][0].text).toBe("stopped mid-answer"); // operator abort: today's behavior byte-identical
    await flush();
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2); // no continuations fired
  });

  it("T13: breaker opens mid-chain — the leg enqueues under its OWN (x#dl1) key; the origin's done doc is never resurrected", async () => {
    // r1 B1(ii) collision pin. NEGATIVE-VERIFY (Step 4 NV-B): with the
    // outageReplay strip removed, the leg inherits the flag, its fast-fail
    // takes handleOutageTurn's release-before-depth branch instead of the
    // enqueue branch, enqueue is never called, and release is called a
    // second time with "pending" — both assertion groups fail (the pre-B1
    // silent-drop/resurrection shape).
    agentManager.runWorkItemTurn
      .mockResolvedValueOnce(withProgressAbort()) // the origin replay burns its deadline with progress
      .mockRejectedValueOnce(makeCircuitOpenError()); // the continuation fast-fails — breaker re-opened mid-chain
    await dispatcher.dispatch(replayItem({ id: "x", threadId: "t1" }));

    await vi.waitFor(() =>
      expect(store.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: "x#dl1", agentId: "executive-assistant", enqueueOrigin: "fast-fail" }),
      ),
    );
    // The leg's workItem serializes VERBATIM — counter included, marker
    // stripped — so the cap survives the queue round-trip (r1 B1).
    const enqueued = store.enqueue.mock.calls[0][0];
    expect(enqueued.workItem.meta.deadlineRetry).toBe(1);
    expect(enqueued.workItem.meta.outageReplay).toBeUndefined();
    // Exactly one release ever: the origin → done. No pending flip on either key.
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledWith("x", "executive-assistant", "done", expect.stringContaining("KPR-402"));
  });

  it("T14: silent × zero-progress × closed — warn log only: no notice, no re-dispatch, no store writes, '_No response._' suppressed", async () => {
    // r1 B2 cell (spec §Design.3): nobody human is owed a notice on a
    // system one-shot; the trigger is lost for this firing (accepted — the
    // same acceptance KPR-307 made for a silent one-shot expiring in the
    // queue); the warn keeps it conspicuous.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(zeroProgressAbort());
    await dispatcher.dispatch(slackItem({ id: "callback:zp", meta: { targetAgentId: "executive-assistant" } }));

    await flush();
    expect(adapter.deliver).not.toHaveBeenCalled(); // the bare "_No response._" delivery to a system surface is suppressed too
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
    expect(store.recordFailedAttempt).not.toHaveBeenCalled();
    expect(
      mockLogWarn.mock.calls.some(
        ([msg]) => msg === "Deadline zero-progress abort on silent one-shot — dropped with log",
      ),
    ).toBe(true);
  });

  it("T15: thread-key pinning — a threadId-less callback: origin's continuation carries the origin's EFFECTIVE thread key", async () => {
    // r2 blocker pin. NEGATIVE-VERIFY (Step 4 NV-C, manual pin-drop edit):
    // without the `threadId: item.threadId ?? item.id` pin the continuation's
    // threadId is undefined — runWorkItemTurn's session read
    // (agent-manager.ts:866, `item.threadId ?? item.id`) would key on
    // "callback:x#dl1" while the origin persisted under "callback:x": no
    // leg could ever resume its predecessor (the blind fresh re-run
    // Finding-4 forbids). The mocked runWorkItemTurn receives the item this
    // row asserts on — the real manager's read key IS threadId ?? id, so
    // pinning the item shape pins the read key.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
    await dispatcher.dispatch(
      slackItem({ id: "callback:x", threadId: undefined, meta: { targetAgentId: "executive-assistant" } }),
    );

    await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
    const cont = agentManager.runWorkItemTurn.mock.calls[1][1] as WorkItem;
    expect(cont.id).toBe("callback:x#dl1");
    expect(cont.threadId).toBe("callback:x"); // the origin's effective key, materialized before the id changed
  });
});
```

- [ ] **Step 4:** Verify green on fixed code, then the three negative-verify passes.

Green + insertion-only check:

```bash
npx prettier --write src/channels/dispatcher.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
git diff -- src/channels/dispatcher.test.ts
```

Expected: all tests pass; the diff shows the hoisted-mock edit, the import extension, and one contiguous inserted describe — no other pre-existing row touched.

**NV-A (commit-anchored, NO `git stash`).** At this point `HEAD` is Task 5's commit (this task has not committed yet — confirm with the `git log` line below). Reverse-apply its dispatcher **source** diff only (path-scoped — the migrated test rows stay in place):

```bash
git log --oneline -2
git diff HEAD~1 HEAD -- src/channels/dispatcher.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected on pre-fix dispatcher code: **T1, T2, T3, T5, T6, T7, T8, T9, T13, T14, T15 fail**, plus the two migrated rows (`★ KPR-402 (D28 migration)` fails on the notice-text assertion — "_No response._" reappears; `★ KPR-398/KPR-402 (D28 migration)` fails on the notice text and its waitFor times out). Pass-both-ways by design (documented pins): **T4** (cron inert = legacy behavior), **T11** (shapes that never enter the arm), and the migrated **KPR-401 sched: row** (skip lane = legacy behavior). Every other pre-existing row — 1276 ★, all KPR-400 F2, all KPR-403 — passes. waitFor-based failures take ~1s each (Vitest default timeout); that is the expected failure mode, not a hang. If the enumerated rows do not fail, stop and fix the tests.

Restore and confirm:

```bash
git checkout HEAD -- src/channels/dispatcher.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected `git status --short`: exactly ` M src/channels/dispatcher.test.ts`. Suite green post-restore.

**NV-B (manual meta-strip edit — the sharper T6/T13 anchor).** In `src/channels/dispatcher.ts`, temporarily change:

```ts
    const { outageReplay: _replayMarker, ...carriedMeta } = item.meta ?? {};
```

to:

```ts
    const carriedMeta = item.meta ?? {};
```

then:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts -t "T6:"
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts -t "T13:"
git checkout HEAD -- src/channels/dispatcher.ts
```

Expected: **T6 fails** (the continuation carries `outageReplay: true` — the hygiene assertion gets `true`, not `undefined`) and **T13 fails** (the inherited flag routes the leg's fast-fail into the release-before-depth branch: `enqueue` never called, `release` called twice with a `pending` flip). This proves the rows pin the strip specifically, not just the arm's existence.

**NV-C (manual thread-pin drop — the sharper T15 anchor).** In `src/channels/dispatcher.ts`, temporarily delete the single line:

```ts
      threadId: item.threadId ?? item.id,
```

then:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts -t "T15:"
git checkout HEAD -- src/channels/dispatcher.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected: **T15 fails** (the continuation's `threadId` is `undefined` — the unpinned shape whose session read would re-key to the leg id); full suite green again after the restore.

- [ ] **Step 5:** Commit:

```bash
git add src/channels/dispatcher.test.ts
git commit -m "test(dispatcher): KPR-402 rows — continuation chain, meta hygiene, per-leg ids, thread-key pin, silent cells, Lane-B/operator exclusions

New 'deadline-abort continuation (KPR-402)' describe: T1-T9, T11, T13-T15
per the spec's test table (T10's migrations landed with the source commit;
T12 lives in the module suites). Harness: the hoisted logger mock gains
mockLogWarn (silent-cell warn pins — no pre-existing row asserts warn);
fire-and-forget continuations observed via vi.waitFor + a setTimeout(0)
flush before negative count assertions.

Negative-verified three ways: (A) with Task 5's dispatcher.ts diff
reverse-applied, T1/T2/T3/T5/T6/T7/T8/T9/T13/T14/T15 and both migrated ★
rows fail on pre-fix code ('_No response._' reappears, no continuation
ever fires) while T4/T11/the sched:-migrated KPR-401 row pass both ways by
design; (B) removing the outageReplay strip fails exactly T6+T13 (marker
leak → release-before-depth resurrection instead of a fresh per-leg
enqueue); (C) dropping the threadId pin fails exactly T15 (unpinned leg
re-keys the session read). All pre-existing rows — 1276 ★, KPR-400 F2,
KPR-403 — pass both ways with zero edits.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 7: Final gate — full check, scope containment, named sibling re-runs, D13 zero-diff

**Files:** none (verification only; no commit)

- [ ] **Step 1:** Full repo gate:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: typecheck + lint + format + full test suite all green.

- [ ] **Step 2:** Scope containment — the child branch's diff against the epic base (92f8e71) touches EXACTLY six files (plus this plan doc, which the orchestrator handles — **do not commit the plan from this lane**):

```bash
git diff --stat 92f8e71..HEAD
```

Expected file list (nothing else):

```
src/channels/deadline-continuation.ts
src/channels/deadline-continuation.test.ts
src/channels/dispatcher.ts
src/channels/dispatcher.test.ts
src/outage/outage-notices.ts
src/outage/outage-notices.test.ts
```

- [ ] **Step 3:** D13 + Non-Goals zero-diff proof — no manager/runner/breaker/classifier/store/processor/session/docs edits:

```bash
git diff --stat 92f8e71..HEAD -- src/agents/ src/outage/outage-queue-store.ts src/outage/outage-replay-processor.ts src/index.ts docs/providers.md src/scheduler/
```

Expected: empty output (⚠A9 included: `docs/providers.md` untouched — engine-internal dispatch behavior, KPR-398 A4 precedent).

- [ ] **Step 4:** Named sibling-row re-runs (the Regression Surface's explicit pins, by name):

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts -t "★ timeout gate"
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts -t "KPR-400 F2"
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts -t "KPR-403"
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts -t "KPR-401"
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts src/agents/provider-adapters/error-classification.test.ts
```

Expected: every filtered row green (the `★ timeout gate` run confirms 1276 passes **unmodified** — the D6 routing pin; the breaker/classifier suites confirm the D13 pins over untouched files); the KPR-401 filter picks up the migrated sched:-lane row green.

- [ ] **Step 5:** Confirm the working tree is clean apart from the uncommitted plan document, and report done. The live-instance V1 item (Testing Contract, above) remains open for the deliver lane — it gates ready-to-merge, not this implement pass.

```bash
git status --short
git log --oneline 92f8e71..HEAD
```

Expected: six commits (Tasks 1–6), untracked/modified plan doc only.

---

## Plan-review advisories (r1, verbatim — implementer notes, not deviations)

1. [Task 7, Steps 2/5]: the plan doc is already committed at f01a84b (tip), so the final gate sees SEVEN commits (plan doc + Tasks 1-6) and a CLEAN tree — read the expectations that way; don't report a spurious blocker.
2. [Task 5, coupling rationale]: the "racy-red" claim about un-migrated 1304 is likely wrong-direction (would pass racily green); the coupling stands regardless (the KPR-401 row's break is deterministic; spec T10 mandates the migration) — don't treat "racy-red" as observed fact.
3. [Task 1/5, `_replayMarker`]: the rest-sibling destructure emits one no-unused-vars WARNING (no varsIgnorePattern configured); `npm run check` passes (no --max-warnings); tolerate it — adding ignoreRestSiblings is out of scope.

---

## Post-review amendment (child-PR r1)

⚠A9's "no docs/providers.md edit" assumption was OVERRIDDEN at pre-PR review r1 (the spec's own escape hatch: "one-row caveat if review wants it") — the shipped change edits providers.md footnote 10 + adds a dated changelog entry, consistent with canon D29 and the KPR-398/KPR-399 precedent. The §Verification step expecting an empty providers.md diff is superseded accordingly; the epic-level integrated-head review should expect that diff.
