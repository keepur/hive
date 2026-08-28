# KPR-412 — Reset `finalAttemptSessionId` on the KPR-399 resume-rejection arm — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Make `TurnResult.resumedSession` report `false` when `spawnTurn`'s KPR-399 claude-resume-rejection self-heal arm fires, matching the reality that the finalized attempt ran fresh — restoring the KPR-388 delta-into-fresh mark heal (C9) and the C18 telemetry measurement contract.

**Architecture:** One assignment (`finalAttemptSessionId = undefined;`) added to the existing KPR-399 arm in `AgentManager.spawnTurn`, mirroring the auth-rebuild arm's identical idiom three arms above it. One JSDoc clause added to `TurnResult.resumedSession`'s doc comment enumerating the now-correct fresh case. One new nested `describe` (3 `it` cases) inside the existing `TurnResult.resumedSession (KPR-388)` describe block, reusing the fixture strings and `it.each` matcher-surface pattern already established in the sibling `resume-rejection self-heal (KPR-399 §D3)` describe.

**Tech Stack:** TypeScript, Vitest.

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `AgentManager.spawnTurn`'s `finalAttemptSessionId` tracking across all four `runOneSpawnAttempt` retry arms, specifically the KPR-399 arm
  - Reason: this is a pure in-process state-tracking defect with no I/O — a unit test at the existing `agent-manager.test.ts` level is the correct and sufficient level; no dispatcher/DB/network involvement
  - Minimum assertions: (1) `TurnResult.resumedSession === false` after the KPR-399 arm's fresh retry, for both matcher-surface fixtures (unknown-session, dangling tool_use); (2) `agent_turn_telemetry.resumedSession === false` on the same path (C18 single-sourcing); (3) the adjacent happy-path-resume row (`:3267`) stays green (no over-broad fix)

- Integration: `not-required`
  - Scope: n/a
  - Reason: see Non-Required Rationale
  - Harness: not-applicable
  - Minimum assertions: n/a

- E2E: `not-required`
  - Scope: n/a
  - Reason: see Non-Required Rationale
  - Harness: not-applicable
  - Minimum assertions: n/a

### Critical Flows

- A conference delta turn (stored `sessionId`, `injectionMode: "delta"`) whose claude session resume is rejected (unknown-session or dangling-tool_use) self-heals fresh and correctly clears its `meetingLastSeenTs` mark on the next dispatcher pass, rather than wrongly advancing it — this is the real-world consequence the unit fix restores, verified structurally (the dispatcher's own branch is already pinned by existing `dispatcher-conference.test.ts` cases per the spec's Testing section; this plan does not add a new dispatcher-level case, since the manager-side bug is what was invisible there in both directions).

### Regression Surface

- `TurnResult.resumedSession (KPR-388)`'s six existing rows (happy-path resume, first-turn, auth-rebuild retry, stale-handle self-heal, contender adoption, KPR-313 handoff) must all stay green — the fix touches only the KPR-399 arm's branch, verified by keeping those rows unmodified.
- `resume-rejection self-heal (KPR-399 §D3)`'s four existing rows (both matcher-surface retries, breaker record-once, single-retry cap, gating) must all stay green — the fix adds one line inside the arm's already-passing control flow, touching no gate, matcher, or retry-count logic.

### Commands

- Unit: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts`
- Integration: not-applicable
- E2E: not-applicable
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (typecheck + lint + format + full suite, before pre-PR review)

### Harness Requirements

- None beyond the existing `agent-manager.test.ts` suite's standard mock wiring (`mockRunnerSend`, `turnTelemetryStore`, `manager` — all already constructed in the file's outer `beforeEach`, lines 438-474). No new mocks, fixtures, or env vars.

### Non-Required Rationale

- Integration: the defect and its fix are fully contained inside one function's local variable tracking; no module boundary, API, DB, or job is involved. The real-world consequence (dispatcher mark heal) is already covered by existing `dispatcher-conference.test.ts` integration-level cases that consume `resumedSession` as an input — this plan does not touch or duplicate that coverage, per the spec's explicit Testing Contract decision (§Testing, "Deliberately not added").
- E2E: no user-facing flow changes; the fix corrects an internal telemetry/bookkeeping flag with no new surface.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

- `src/agents/agent-manager.ts` — the fix (one assignment + one comment) and the JSDoc update. Both edits are localized to the existing `spawnTurn` method and the existing `TurnResult` interface; no new file.
- `src/agents/agent-manager.test.ts` — one new nested `describe` (containing 3 `it` cases: T1's `it.each` ×2 + T2) appended inside the existing `TurnResult.resumedSession (KPR-388)` describe block (`:3257-3326`); no new top-level describe block, no new file.

## Task 1: Fix `finalAttemptSessionId` tracking on the KPR-399 arm

**Files:**
- Modify: `src/agents/agent-manager.ts:196-206` (JSDoc)
- Modify: `src/agents/agent-manager.ts:1347-1384` (the KPR-399 arm)

- [ ] **Step 1:** Update the `TurnResult.resumedSession` JSDoc to enumerate the KPR-399 fresh-retry case.

Current text (`agent-manager.ts:196-206`):

```typescript
  /**
   * KPR-388: true iff the FINALIZED attempt was launched with a session
   * handle (options.resume / previous_response_id / previous_interaction_id).
   * False when the finalized attempt ran fresh — first turn, KPR-313
   * provider handoff, auth-rebuild retry, KPR-350 stale-handle self-heal
   * fresh retry. KPR-351 contender adoption counts as resumed. Known
   * approximation (spec ⚠): for client-transcript lanes, "launched with a
   * handle" is not proof the transcript was warm — accepted, failure mode is
   * bounded duplication or one system-notice'd fresh turn.
   */
  resumedSession?: boolean;
```

Replace with:

```typescript
  /**
   * KPR-388: true iff the FINALIZED attempt was launched with a session
   * handle (options.resume / previous_response_id / previous_interaction_id).
   * False when the finalized attempt ran fresh — first turn, KPR-313
   * provider handoff, auth-rebuild retry, KPR-350 stale-handle self-heal
   * fresh retry, KPR-399 claude resume-rejection fresh retry. KPR-351
   * contender adoption counts as resumed. Known approximation (spec ⚠): for
   * client-transcript lanes, "launched with a handle" is not proof the
   * transcript was warm — accepted, failure mode is bounded duplication or
   * one system-notice'd fresh turn.
   */
  resumedSession?: boolean;
```

- [ ] **Step 2:** Add the tracker reset to the KPR-399 arm, mirroring the auth-rebuild arm's idiom.

Current text (`agent-manager.ts:1373-1384`, the tail of the KPR-399 `else if` block):

```typescript
          log.warn("spawnTurn claude resume rejected — one fresh retry (KPR-399)", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            timedOut: finalResult.timedOut === true,
          });
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: undefined },
            shaping,
            ticket,
            onStream,
          );
        }
```

Replace with:

```typescript
          log.warn("spawnTurn claude resume rejected — one fresh retry (KPR-399)", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            timedOut: finalResult.timedOut === true,
          });
          // KPR-412: the retry runs fresh — the finalized attempt carries no
          // handle. Mirrors the auth-rebuild arm above; without this,
          // !!finalAttemptSessionId reports a resume that never happened
          // (C7), and the dispatcher's delta-into-fresh mark heal inverts
          // into a mark ADVANCE instead of a clear (C9 gap).
          finalAttemptSessionId = undefined;
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: undefined },
            shaping,
            ticket,
            onStream,
          );
        }
```

- [ ] **Step 3:** Verify the file still typechecks.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4:** Commit.

```bash
git add src/agents/agent-manager.ts
git commit -m "fix(kpr-412): reset finalAttemptSessionId on the KPR-399 resume-rejection retry

The arm retries with sessionId: undefined but never reset the tracker
whose truthiness becomes TurnResult.resumedSession — the finalized
attempt ran fresh but reported resumed: true, inverting the KPR-388
delta-into-fresh mark heal (dispatcher.ts:1421) into a mark ADVANCE
instead of a clear, permanently orphaning pre-mark meeting history for
the affected agent (C9 gap). Mirrors the auth-rebuild arm's existing
idiom three arms above.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Task 2: Regression tests

**Files:**
- Modify: `src/agents/agent-manager.test.ts:3257-3326` (append one new nested `describe` — 3 `it` cases total — to the existing describe block)

- [ ] **Step 1:** Append T1 (the direct regression, both matcher surfaces) and T2 (C18 telemetry single-sourcing) inside the `TurnResult.resumedSession (KPR-388)` describe block, immediately after the existing `"false on a KPR-313 provider-handoff turn..."` row (`:3318-3325`) and before the describe's closing `});` (`:3326`).

Current tail of the describe block (`agent-manager.test.ts:3318-3326`):

```typescript
      it("false on a KPR-313 provider-handoff turn (guard strips the session pre-attempt)", async () => {
        // Stored codex tag, claude turn: guard trips, turn runs fresh with the
        // handoff annotation — resumedSession must report the fresh reality.
        const result = await manager.spawnTurn(
          smsCtx({ sessionId: "s-codex-row", sessionProvider: "codex", threadId: "sms:line-1:kpr388-r6" }),
        );
        expect(result.resumedSession).toBe(false);
      });
    });
```

Replace with:

```typescript
      it("false on a KPR-313 provider-handoff turn (guard strips the session pre-attempt)", async () => {
        // Stored codex tag, claude turn: guard trips, turn runs fresh with the
        // handoff annotation — resumedSession must report the fresh reality.
        const result = await manager.spawnTurn(
          smsCtx({ sessionId: "s-codex-row", sessionProvider: "codex", threadId: "sms:line-1:kpr388-r6" }),
        );
        expect(result.resumedSession).toBe(false);
      });

      // --- KPR-412: the KPR-399 arm had no coverage in this block ----------
      describe("false after the KPR-399 claude resume-rejection fresh retry (KPR-412)", () => {
        const UNKNOWN_SESSION = "No conversation found with session ID: 0198c3f2-abcd-7890-b1c2-d3e4f5a6b7c8";
        const DANGLING_TOOL_USE =
          "400 invalid_request_error: messages.57: the following `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01AbCdEfGh";

        it.each([
          ["unknown-session", UNKNOWN_SESSION],
          ["dangling tool_use 400", DANGLING_TOOL_USE],
        ])("T1: resumedSession is false on %s (was true pre-fix — negative-verified)", async (_label, reason) => {
          mockRunnerSend
            .mockResolvedValueOnce(makeRunResult({ error: reason, sessionId: "" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "s-fresh" }));
          const result = await manager.spawnTurn(
            smsCtx({ threadId: "sms:line-1:kpr412-t1", sessionId: "s-dead", sessionProvider: "claude" }),
          );
          expect(mockRunnerSend).toHaveBeenCalledTimes(2);
          expect(mockRunnerSend.mock.calls[1]![1]).toBeUndefined(); // fresh retry — no sessionId (matches :3613's form)
          expect(result.resumedSession).toBe(false);
        });

        it("T2: agent_turn_telemetry.resumedSession is false on the same path (C18 single-sourcing)", async () => {
          mockRunnerSend
            .mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "s-fresh" }));
          await manager.spawnTurn(
            smsCtx({ threadId: "sms:line-1:kpr412-t2", sessionId: "s-dead", sessionProvider: "claude" }),
          );
          expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
          const doc = turnTelemetryStore.record.mock.calls[0]![0];
          expect(doc.resumedSession).toBe(false);
        });
      });
    });
```

**Note on hermetic queueing:** this describe block (unlike the sibling `resume-rejection self-heal (KPR-399 §D3)` describe) has no local `mockRunnerSend.mockReset()` `beforeEach` — the outer suite-level `beforeEach` (`agent-manager.test.ts:~455`, `clearAllMocks()`) clears call history but not the `mockResolvedValueOnce` queue. T1 and T2 each queue exactly two values and each spawnTurn call drains exactly two (first attempt errors, retry succeeds) — no bleed risk, because pre-fix the KPR-399 retry still fires regardless of the tracker bug, so both queued values drain in either source state (fixed or unfixed) — this is what makes the Step 3 negative-verify below meaningful rather than a false-fail. Do not add a `mockReset()` `beforeEach` to this describe — that would be an unrequested scope change (YAGNI) affecting the block's six pre-existing rows for no reason tied to this fix.

- [ ] **Step 2:** Run the target test file and confirm all rows pass, including the three new ones.

First, capture the pre-edit baseline case count for a relative comparison (absolute counts drift as the epic branch evolves):

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts 2>&1 | tail -5`
Expected: note the "Tests N passed" total — call it `N_before`.

Then, after Step 1's edit:

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts`
Expected: all tests pass; total case count is exactly `N_before + 3` (T1's `it.each` contributes 2, T2 contributes 1).

- [ ] **Step 3:** Negative-verify — confirm the tests fail for the right reason on pre-fix source.

At this point Task 1's fix is already committed and Task 2's new tests are uncommitted in the working tree. The mechanism is `git restore`, not `git stash` — there is nothing to stash, since restoring a single tracked file from its last commit is exactly "undo the fix, keep the tests":

1. Manually edit `src/agents/agent-manager.ts`: delete the `// KPR-412: ...` comment block and the `finalAttemptSessionId = undefined;` line added in Task 1 Step 2 (the four-line insertion between the `log.warn(...)` call and the `finalResult = await this.runOneSpawnAttempt(...)` call). Leave everything else — including the JSDoc update — untouched.
2. Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts -t "KPR-412"`
   Expected: exactly 3 FAILING (T1's 2 `it.each` cases + T2) — `result.resumedSession` / `doc.resumedSession` is `true` instead of `false` — confirming the tests catch the actual defect, not a tautology. `mockRunnerSend` is still called twice in each failing case (the retry still fires; only the tracker is wrong), matching the spec's stated negative-verify (§Key Points 8).
3. Restore the fix: `git restore src/agents/agent-manager.ts` (this file has no uncommitted changes other than the manual revert just made in step 1, so `restore` cleanly returns it to Task 1's committed state — the uncommitted test file is untouched by this command).
4. Run: `git status --short`
   Expected: exactly one line, `M src/agents/agent-manager.test.ts` — confirming `agent-manager.ts` is back to the committed fix and only the new tests remain uncommitted.

- [ ] **Step 4:** Commit.

```bash
git add src/agents/agent-manager.test.ts
git commit -m "test(kpr-412): regression coverage for the KPR-399 arm's resumedSession tracking

Two rows in the existing TurnResult.resumedSession (KPR-388) describe:
T1 (both matcher surfaces, via it.each) pins resumedSession === false
after the arm's fresh retry — negative-verified to fail on pre-fix
source with resumedSession === true while the retry still fires
(confirming the test catches the tracker bug, not the retry logic).
T2 pins the C18 single-sourcing invariant against
agent_turn_telemetry.resumedSession.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Task 3: Full regression + push

- [ ] **Step 1:** Run the full check suite.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 — typecheck, lint, format, and the full test suite all pass.

- [ ] **Step 2:** Confirm the commits are ready to push (pushing itself is the deliver-ticket lane's own submit-ticket-pr step — not part of this plan's scope).

Run: `git log --oneline -3`
Expected: the two commits from Task 1 and Task 2, on top of the epic branch head this lane branched from.
