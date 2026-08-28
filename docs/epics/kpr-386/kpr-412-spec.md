# KPR-412 — `spawnTurn`'s KPR-399 resume-rejection arm must reset `finalAttemptSessionId`

**Epic:** KPR-386 (meeting mode) · **Kind:** corrective child, filed by the epic's integrated-head review r1 (severity: critical)
**Origin:** cross-epic collision — `main`'s KPR-397 hotfix epic (KPR-399) landed a fourth `runOneSpawnAttempt` retry arm *after* this epic's KPR-388 shipped the `finalAttemptSessionId` tracker; the two never met until the epic branch was synced with `origin/main`.
**Status:** DRAFT

## TL;DR

`spawnTurn` tracks which session handle the *finalized* attempt actually ran with in `finalAttemptSessionId`; its truthiness becomes `TurnResult.resumedSession` (canon C7). Three of the four retry arms maintain it; `main`'s KPR-399 claude-resume-rejection arm retries with `sessionId: undefined` but never touches the tracker, so a turn that provably ran **fresh** reports `resumedSession: true`. In meeting mode that inverts the dispatcher's delta-into-fresh heal — the mark is *advanced* instead of *cleared* — permanently orphaning the pre-mark meeting history for that agent, the exact gap direction C9 forbids. The fix is one assignment mirroring the auth-rebuild arm, one JSDoc line, and regression tests in the `resumedSession (KPR-388)` describe block.

## ⚠ Key Points

1. **Verified against live code, not transcribed.** `agent-manager.ts:1262` (init), `:1283` (auth-rebuild `= undefined`), `:1340` (KPR-350/351 `= adoptedSessionId`), and `:1347–1384` (KPR-399 arm — retries at `:1379` with `sessionId: undefined`, **no assignment anywhere in the block**). Consumed at `:1397`/`:1399` as `!!finalAttemptSessionId`.
2. **The bug is unconditional on this arm, not a race.** The arm's own gate requires `effectiveCtx.sessionId` truthy, and the tracker was initialized from exactly that value at `:1262` with no intervening write (the `else if` chain guarantees the other two arms did not run). So every turn that takes this arm reports `resumedSession: true` — 100% of them, never intermittently.
3. **Fix (confirmed, not assumed): `finalAttemptSessionId = undefined;` immediately after the arm's `log.warn`, before the retry call** — byte-for-byte the auth-rebuild arm's idiom at `:1283`. Sufficient because the arm is single-retry (`else if`), the retry's `sessionId` is a literal `undefined`, and nothing downstream re-derives the value.
4. **Blast radius is exactly two consumers, both confirmed by grep.** (a) `dispatcher.ts:1421` — the KPR-388 delta-into-fresh mark heal; (b) `recordSpawnObservability` → `agent_turn_telemetry.resumedSession` (`agent-manager.ts:2217`). It is **not** read by `finalizeSpawnResult`'s persistence gates (`:2315`/`:2327` key on `result.aborted`/`result.sessionId`, never on this flag), by the outage queue, by deadline continuation, or by any adapter — `agent-runner.ts:161` documents the field as dispatcher-populated passthrough only.
5. **The JSDoc contract at `:196–206` is part of the fix, not decoration.** It enumerates every fresh case (first turn, KPR-313 handoff, auth-rebuild, KPR-350 stale-handle) and was simply not updated when KPR-399 landed independently on `main`. Leaving it stale re-opens the same drift for the next arm author.
6. **In scope:** the one assignment, the JSDoc enumeration, and regression tests. **Out of scope:** any refactor that would make the tracker structurally un-forgettable (see Non-goals — a real observation, deliberately not built here).
7. **Regression coverage lands in `agent-manager.test.ts`'s `TurnResult.resumedSession (KPR-388)` describe (`:3257`), not in `dispatcher-conference.test.ts`.** Those dispatcher tests mock `agentManager.runWorkItemTurn` wholesale and *feed* `resumedSession` as a fixture — they cannot observe a manager-side derivation bug in either direction. The dispatcher's own branch is already pinned in both directions (`:968` clear-on-false, `:1159`/`:1435` set-on-false-but-not-delta, plus the reviewer-pin note at `:1109` covering the set-on-truthy delta case). The seam is contract-level: manager owns the *value*, dispatcher owns the *branch*, and only the manager side has a hole.
8. **Negative-verify is clean and cheap.** Reverting the single assignment flips the new `resumedSession` assertion from `false` to `true` while both attempts still run, so the test fails on the pre-fix source for the right reason with no `mockResolvedValueOnce` queue-bleed hazard.
9. **⚠ Non-blocking assumption:** production impact is currently unmeasurable-by-design — the arm's warn (`:1373`) deliberately logs no handle value and `agent_turn_telemetry` carries only the corrupted boolean, so already-corrupted marks cannot be enumerated retroactively. Self-healing is nonetheless automatic and needs no migration (see §Recovery).

---

## Problem

KPR-388 introduced `finalAttemptSessionId` (`agent-manager.ts:1257–1262`) as the single source of truth for "did the **finalized** attempt launch with a session handle?" — canon C7. Its comment states the contract explicitly: *"sessionId actually passed to the FINALIZED `runOneSpawnAttempt` call — reassigned at each retry arm below."*

Four arms call `runOneSpawnAttempt`. Three honor the contract:

| Arm | Line | Retry runs with | Tracker |
|---|---|---|---|
| Happy path (init) | `:1262` | `effectiveCtx.sessionId` | `= effectiveCtx.sessionId` ✅ |
| Auth-rebuild (KPR-224) | `:1277–1289` | `undefined` | `= undefined` ✅ (`:1283`) |
| Stale server handle (KPR-350/351) | `:1290–1346` | `adoptedSessionId` | `= adoptedSessionId` ✅ (`:1340`) |
| **Claude resume-rejection (KPR-399)** | `:1347–1384` | **`undefined`** (`:1379`) | **untouched** ❌ |

The fourth arm shipped on `main` under the KPR-397 hotfix epic, weeks after KPR-388 merged into the KPR-386 epic branch. Neither side's tests could see the other. The collision surfaced only when the epic branch absorbed `origin/main`.

Because the arm's gate (`finalResult.error && isClaudeResumeLoadError(...) && effectiveCtx.sessionId && sessionSemanticsForRoute(...) === "client-transcript"`) *requires* a truthy `effectiveCtx.sessionId`, the tracker is guaranteed to still hold the original, now-dead handle when the fresh retry finalizes. `!!finalAttemptSessionId` is therefore unconditionally `true` for a turn that ran with no session at all.

### Failure scenario (meeting mode)

1. A conference **delta** turn — delta mode requires a stored `sessionId` by construction (`dispatcher.ts:1688`) — hits a claude-resume rejection: unknown-session, or a dangling `tool_use` in the replayed transcript (`isClaudeResumeLoadError`). Post-KPR-399 this is a *designed-for* class of turn: `finalizeSpawnResult`'s persist-on-abort arm (`:2315`) deliberately mints handles whose resumability is uncertain, and meeting turns are exactly the turns that get deadline-killed mid-tool-call.
2. The arm retries fresh and succeeds. The retry reuses `shaping.prompt` — already assembled as **delta-only** (new messages since the mark, no transcript; re-shaping is impossible by construction, C7's own note) — so delta content lands in a brand-new, empty session.
3. `dispatcher.ts:1419–1429` exists for precisely this: `injectionMode === "delta" && resumedSession === false ⇒ clearMeetingMark`. It sees `true`, falls to the `else if`, and calls `setMeetingMark(injectionHighWaterTs)`.
4. The agent's session is empty but its mark asserts full coverage through T. Every later turn injects only `> T`. The meeting before T is unreachable for that agent for the life of the thread — a **gap**, which C9 (*"all races err to duplication, never gaps"*) exists to forbid.
5. Independently, `agent_turn_telemetry.resumedSession` records a false value, corrupting the C18 measurement surface the epic uses to evaluate itself.

Severity is amplified by the interaction being *silent*: no error, no warn naming it, and the agent behaves fluently on a truncated context.

## Goals

- G1. `TurnResult.resumedSession` reports the finalized attempt's reality on the KPR-399 arm, as it already does on the other three.
- G2. The dispatcher's delta-into-fresh heal fires on this path, restoring the C9 covering invariant.
- G3. `agent_turn_telemetry.resumedSession` is truthful on this path (C18).
- G4. A regression test would have caught this specific defect, and the arm-coverage gap in the `resumedSession` describe block is closed.

## Non-goals

- **No refactor of the retry-arm pattern.** A structurally un-forgettable design exists (e.g. funnel every attempt through a local `attempt(sessionId)` helper that assigns the tracker and calls `runOneSpawnAttempt` in one place, so a new arm cannot omit it). That is a legitimate observation and a reasonable future ticket; it touches all four arms plus the record-once breaker seam and is **not** worth the regression surface for a one-line correctness fix on a corrective child. Recorded, not built.
- **No change to the KPR-399 arm's behavior** — gate, matcher, single-retry semantics, breaker-invisibility, redaction posture, and no-pre-scrub all stay byte-identical. Only the tracker assignment is added.
- **No change to the dispatcher**, to `clearMeetingMark`/`setMeetingMark`, to injection shaping, or to any adapter.
- **No migration / backfill** of already-corrupted `meetingLastSeenTs` marks or telemetry docs (see §Recovery).
- **No new telemetry field, log line, or `hive doctor` surface.**

---

## Design

### D1. The fix

In the KPR-399 arm (`agent-manager.ts:1347–1384`), between the existing `log.warn` and the retry call:

```ts
        log.warn("spawnTurn claude resume rejected — one fresh retry (KPR-399)", { … });
        // KPR-412: the retry runs fresh — the finalized attempt carries no
        // handle. Mirrors the auth-rebuild arm; without it !!finalAttemptSessionId
        // reports a resume that never happened (C7), and the dispatcher's
        // delta-into-fresh mark heal inverts into a mark ADVANCE (C9 gap).
        finalAttemptSessionId = undefined;
        finalResult = await this.runOneSpawnAttempt(
          { ...effectiveCtx, sessionId: undefined },
          shaping, ticket, onStream,
        );
```

**Why this is sufficient, checked rather than assumed:**

- The arm is the terminal `else if` of a mutually-exclusive chain — at most one retry per turn, so no later arm can re-clobber the value.
- The retry's `sessionId` is a literal `undefined`, not a computed value, so `undefined` is the *provably* correct tracker value (unlike the KPR-350 arm, which must mirror `adoptedSessionId`).
- Both read sites (`:1397`, `:1399`) execute after the whole `try` block; nothing reads the tracker mid-arm.
- If the retry *throws*, control leaves via the `catch` at `:1385` and neither read site runs — the assignment is inert on that path.
- If the retry *fails with an error*, the tracker is still correct: the finalized (failed) attempt genuinely ran fresh, and the dispatcher's mark bookkeeping is gated on `!runResult.error` anyway (`dispatcher.ts:1419`), so the value is only consumed by telemetry there.

**Placement (after the warn, before the call)** matches both prior arms exactly, so the four arms read as one pattern.

### D2. JSDoc contract update

`TurnResult.resumedSession`'s doc comment (`agent-manager.ts:196–206`) enumerates the fresh cases. Add the missing one:

> *"False when the finalized attempt ran fresh — first turn, KPR-313 provider handoff, auth-rebuild retry, KPR-350 stale-handle self-heal fresh retry, **KPR-399 claude resume-rejection fresh retry**."*

This is the artifact whose staleness let the drift ship silently; updating it is the cheapest available guard for arm #5.

### D3. Recovery of already-corrupted state (no migration)

A thread whose mark was wrongly advanced heals on its own, without operator action, as soon as any of the ordinary continuity-miss conditions occur — the session row TTLs out, a provider handoff trips the KPR-313 guard, or a later turn takes the (now-fixed) heal path — at which point `buildConferenceContext` falls to the full/summary arm and re-anchors the agent (`dispatcher.ts:1688`). Meetings are short-lived relative to the 7-day row TTL, so the corrupted-mark population drains naturally. A backfill would require enumerating which marks were advanced by *this* path, which is not recoverable from stored state (the arm logs no handle, by redaction posture) — so no migration is proposed, and none is needed.

## Integration points

| File | Change |
|---|---|
| `src/agents/agent-manager.ts` | One assignment + comment in the KPR-399 arm (`~:1377`); one clause in the `resumedSession` JSDoc (`~:201`). |
| `src/agents/agent-manager.test.ts` | New rows in the `TurnResult.resumedSession (KPR-388)` describe (`:3257`). |

Nothing else. No dispatcher, session-store, telemetry-schema, config, or docs-surface change; no bundle/guard implications.

## Testing

All new rows go in the `TurnResult.resumedSession (KPR-388)` describe (`agent-manager.test.ts:3257`), whose existing rows already pin the other three arms. Fixtures come from the `resume-rejection self-heal (KPR-399 §D3)` describe (`:3586`) — `UNKNOWN_SESSION` and `DANGLING_TOOL_USE` — so both matcher surfaces are covered.

- **T1 (the direct regression, ×2 via `it.each` over both matcher surfaces).** Queue a first attempt erroring with the matcher string on a claude route with a stored `sessionId`, then a healed second attempt. Assert: `mockRunnerSend` called twice; `mock.calls[1]![1]` (the sessionId arg) is `undefined`; **`result.resumedSession === false`**. Pre-fix this yields `true` — the negative-verify. Asserting the call count inside the test also makes any `mockResolvedValueOnce` queue bleed self-evident rather than silent.
- **T2 (C18 single-sourcing).** Same path, assert the `turnTelemetryStore.record` doc carries `resumedSession: false` — the suite-level `manager` is wired with the telemetry mock (`:472`), and the healed retry returns a truthy `sessionId`, so the `:2198` record gate is satisfied. This pins that the telemetry field and the `TurnResult` field cannot diverge for this arm.
- **T3 (adjacent-arm non-regression, guard against an over-broad fix).** Re-assert that a *first* attempt succeeding on a resumed claude session still reports `resumedSession: true` — i.e. the new assignment is reachable only from inside the arm. The existing `"true on a happy-path resume"` row (`:3267`) already covers this; no new row needed, but the plan should keep it green rather than treat it as unrelated.

**Deliberately not added:** a `dispatcher-conference.test.ts` case. Those tests inject `resumedSession` as a literal into a mocked `runWorkItemTurn` result, so a manager-derivation bug is invisible there in both directions; adding one would pin the fixture, not the fix. The dispatcher's clear/set branch is already covered at `:968`, `:1159`, `:1435`, and by the `:1109` pin note.

## Edge cases

- **Retry also fails with the matcher string** — no second retry (`else if`), tracker stays `undefined`, `resumedSession: false`. Correct: the finalized attempt ran fresh. Existing single-retry row (`:3642`) stays green.
- **Retry throws** — `catch` at `:1385` rethrows before either read site. Assignment inert.
- **Non-conference turn on this arm** — `resumedSession` reaches telemetry only; `conferenceMode` gates the dispatcher's mark block entirely (`:1419`).
- **Delta turn on this arm that then errors or aborts** — dispatcher's `!runResult.error && !runResult.aborted` gate skips the mark block; the mark stays stale-low, which over-includes next turn (duplication, C9-compliant).
- **Non-claude routes** — the arm's `client-transcript` semantics gate means Lane A passthrough (kimi/deepseek) is in scope and Lane B is not; the fix is provider-agnostic within that gate and needs no per-provider handling.
- **Interaction with the KPR-350 arm's contender adoption** — mutually exclusive by `else if`; the two matchers are pinned non-overlapping in `error-classification.test.ts` (`:331–350`).

## Canon compliance

- **C7** — restores the stated contract (`!!` of the finalized-attempt handle) on the one arm that violated it; the JSDoc enumeration is brought back into agreement with the code.
- **C9** — restores the delta-into-fresh clear, so the mark again advances only over messages injected into an absorbed turn; the failure mode returns to duplication (one full re-injection next turn), never a gap.
- **C18** — `resumedSession` stays single-sourced with `finalizeSpawnResult`; T2 pins that the telemetry copy cannot diverge.

## Open questions / assumptions

- **⚠ Non-blocking (assumption):** no backfill of already-corrupted marks or telemetry docs — the corrupted population is not enumerable from stored state (redaction posture leaves no handle in the warn) and drains on its own via session TTL / handoff / the fixed heal path. If the epic's reviewer wants a bounded blast-radius estimate instead, the only honest source is a forward-looking count of the arm's warn line, which requires no code change to start collecting.
- **⚠ Non-blocking (recorded observation, deliberately unbuilt):** the retry-arm pattern lets a new arm forget the tracker with no compile-time or test-time signal. A funnel helper would make it structurally impossible. Out of scope here (Non-goals); worth a follow-up ticket if a fifth arm is ever contemplated.
- **⚠ Non-blocking (deliberate):** no new log line distinguishing "healed fresh, mark cleared" — the arm's existing warn plus the telemetry boolean are sufficient, and the epic's posture is code-enforce over prose/log-enforce.
