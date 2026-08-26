# KPR-399 — Aborted-Turn Session Persistence Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** A deadline- or operator-aborted Claude-lane turn with observed progress (the exported KPR-398 D1 predicate: `toolCalls > 0 || streamed || text nonempty`) persists its `sessionId` to the `sessions` row inside `finalizeSpawnResult`, so every re-entry whose store read occurs after finalize — outage replay, next user message, reflection, the KPR-402 re-dispatch — resumes the partial turn instead of restarting from scratch; plus a narrow KPR-350-style one-shot fresh-retry self-heal for a resume the SDK rejects.

**Architecture:** Two files change. `src/agents/provider-adapters/error-classification.ts` exports the existing `hasObservedProgress` predicate (no body change — classifier and persist gate share one source of truth) and gains the new `isClaudeResumeLoadError` matcher (docs-sourced, refined against live capture at delivery — KPR-350 posture). `src/agents/agent-manager.ts` gains (a) an `abortPersist` arm in `finalizeSpawnResult` (five conjuncts: `aborted === true` ∧ nonempty `sessionId` ∧ `client-transcript` semantics ∧ `hasObservedProgress` ∧ mint-safety belt), issuing a no-tokenData `sessionStore.set` before the per-thread lock releases, and (b) a third `else if` arm in `spawnTurn`'s retry chain (after auth-rebuild and stale-server-handle) that retries once fresh on a Claude-lane resume rejection. **No runner changes, no dispatcher/outage changes, no session-store changes, no breaker/classification changes, no Lane B changes, no `docs/providers.md` edit (spec ⚠A5).** The replay and next-message paths need zero edits — resume preference is emergent from the existing `sessionStore.get` reads (spec §Design.4).

**Tech Stack:** TypeScript (strict), Vitest, pure dependency-free classifier module, mocked-store AgentManager suite.

> **Decision Register canon consumed (KPR-397 epic description):** D1 (binary-OR progress predicate, fail-closed — reused verbatim via export), D3 (dispatcher gate untouched), D5 (no classification changes), D6 (kpr-398-spec §Design.4 contract table is the binding classification baseline — this change adds no classification rows), D8. Cross-epic C3: Claude-lane-only; Lane B keeps `!result.aborted` byte-for-byte. The spec's ⚠A1–A5 are the delegated decisions this plan concretizes.

**Authoritative spec:** `docs/epics/kpr-397/kpr-399-spec.md` (survived two Frontier review rounds; its §Design.2/§Design.3 shapes and Testing Contract items are binding).

## Testing Contract

### Required Test Groups

- **Unit: required**
  - *Scope:* (1) Persist gate (`finalizeSpawnResult`, mocked `SessionStore`): new direction (aborted claude-lane with progress → 4-arg `set`, no tokenData), each D1 signal independently sufficient, fail-closed zero-progress skip (incl. the `synthesizeAbortedResult` shape), empty-sessionId skip, operator-abort uniformity (⚠A4), mint-safety belt both directions, C3 exclusion pins (openai/gemini/codex → never persisted) and Lane A inheritance pins (kimi/grok → persisted under their own tags), success path unperturbed. (2) Self-heal arm (`spawnTurn`, mocked runner): exactly one fresh retry per matcher alternate, retry result becomes the turn result, breaker record-once, single-retry semantics, gating (no sessionId / openai semantics / auth-arm mutual exclusion), warn redaction (no error string, no handle value). (3) Matcher + predicate export (`error-classification.test.ts`): both `isClaudeResumeLoadError` alternates positive-pinned, breaker-invisibility pins (both strings classify `non-provider` via `classifyTurnResult({ error })` — `classifyErrorString` is module-private), narrowness matrix (every `isAuthRebuildResumeError` alternate and the `isStaleServerHandleError` alternates negative-pinned against the new matcher; generic 400s / bare SDK subtypes negative-pinned), `hasObservedProgress` export pin. (4) Re-entry preference: two `runWorkItemTurn` calls on one thread — the second resumes the aborted turn's persisted id (pins "replay prefers resume" without touching dispatcher code).
  - *Reason:* the persist gate is the root-cause fix and the self-heal arm is the insurance that makes it safe to ship ahead of live SDK confirmation; the matcher matrix protects the auth-row superset rule and the arm's breaker invisibility.
  - *Minimum assertions:* the spec's §Testing Contract unit items 1–11, mapped: items 1–6 + 11 → `src/agents/agent-manager.test.ts` (new `persist-on-abort (KPR-399 §D2)` describe + one deliberately re-scoped legacy row, see Regression Surface); items 7–8 → `src/agents/agent-manager.test.ts` (new `resume-rejection self-heal (KPR-399 §D3)` describe); items 9–10 → `src/agents/provider-adapters/error-classification.test.ts` (new KPR-399 describe; KPR-398 classifier rows re-run unedited).
- **Integration: not-required** — Harness: not-applicable.
- **E2E: not-required** — Harness: not-applicable.

### Critical Flows

1. **Incident shape (new direction):** `{aborted: true, timedOut: true, sessionId: "s1", toolCalls: 46, streamed: true, text: ""}` on a claude route → `sessionStore.set(agentId, threadId, "s1", "claude")` called with exactly 4 args (no tokenData) — the "think / hit-wall / restart" loop breaks: replay and follow-up resume.
2. **Fail-closed (preserved direction):** aborted with zero progress (`toolCalls: 0, streamed: false, text: ""` — also the `synthesizeAbortedResult` shape) → `set` never called; pre-399 behavior byte-for-byte.
3. **C3:** the same aborted-with-progress shape on openai/gemini/codex routes → `set` never called; on kimi/grok (client-transcript Lane A) → called under their own provider tags.
4. **Self-heal:** a resume rejected with either matcher surface (unknown-session / dangling-`tool_use` 400) + stored sessionId + client-transcript route → exactly one fresh retry, retry's result is the turn result, breaker sees only the finalized attempt, never a dead thread.
5. **Re-entry preference:** after an aborted-turn persist, the next `runWorkItemTurn` on the thread passes the persisted id into the spawn (`options.resume`), with zero dispatcher/replay-path changes.

### Regression Surface

- `src/agents/provider-adapters/error-classification.test.ts` — **every pre-existing row preserved verbatim** (KPR-306/312/347/350/351/352 pins, auth-superset pins, Google-429 negative pins, `HARD_FAULT_KINDS` membership, the full KPR-398 progress-split describe). The KPR-399 additions are append-only.
- `src/agents/agent-manager.test.ts` — every pre-existing row preserved verbatim **except one deliberate re-scope**: the row at L2018 (`"does NOT update session-store when the result is aborted"`) pinned the pre-399 behavior using the fixture's default progress fields (`toolCalls: 1`, `text: "response"`) — a shape whose behavior this ticket deliberately changes. It is re-scoped in the **same commit as the source change** (Task 3) to the zero-progress shape, so it keeps pinning the direction that survives (fail-closed skip) and every commit stays green. This is the only pre-existing test whose text changes.
- Aborted fixtures at L539 (`restartAgent`), L1212/L1239 (`stopAgent` Phase 5/13) now trigger an extra fire-and-forget persist under the new arm — verified while drafting: none of those tests assert on `sessionStore.set`, all pass unchanged.
- KPR-313 persist-rule suite (L2571+), churn-mint rows (L2604–2679), KPR-350/351/352 self-heal suites, Lane A KPR-346/371 suites — untouched, must pass unedited (success path is byte-identical; the new arm is `else if`-dead on their shapes).
- `src/channels/dispatcher.test.ts`, `src/agents/session-store.test.ts` — untouched files, no source changes behind them.

### Commands

All commands run from the child worktree root. **The worktree ships without `node_modules` — Task 0 runs `npm ci` first.** Env stubs are required for anything importing config:

```bash
export SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test
```

- **Setup (Task 0):** `npm ci`
- **Unit:** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts src/agents/agent-manager.test.ts`
- **Integration / E2E:** n/a
- **Broader regression:** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (typecheck + lint + format + full test suite)

### Harness Requirements

Existing Vitest harness only. The agent-manager suite's mocks (`makeMockSessionStore`, `makeRunResult`, `smsCtx`, mocked `AgentRunner`/pilot adapters, Lane A env-key stubs) already cover every scenario; no new harness.

### Non-Required Rationale (only for not-required groups)

- **Integration:** the mocked-store `spawnTurn` suite drives the full manager path in-process (lock → breaker → retry chain → finalize → store write) — that *is* this repo's integration surface for the persist gate and retry chain. The one genuine cross-boundary unknown — whether the Claude CLI resumes a transcript killed mid-tool-call — is **not mockable at any tier** (unit mocks hide exactly this; the spec's ticket Caution), which is why it is a live-instance deliver-lane gate below, not an integration test.
- **E2E:** no channel, process, or vendor boundary changes; replay-path behavior is emergent from existing reads (pinned via unit item 11) and the dispatcher is untouched (D3).

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Negative-verify (repo convention, `feedback_negative_verify_regression_tests`):** the new agent-manager rows must be shown to FAIL against pre-fix source before their commit lands, via the **commit-anchored reverse-apply** mechanism written into Task 4 (`git diff <anchor>^ <anchor> -- <file> | git apply -R`, then `git checkout HEAD -- <file>` to restore) — **never `git stash`** (shared stash stack across worktrees is forbidden in this repo). Task 2's reverse-apply is a degenerate check (a brand-new export cannot pass pre-fix — the suite fails at import), documented as such; the load-bearing behavioral anchors are Task 4's.

### Live-instance verification (deliver-lane gate for ready-to-merge)

**Explicitly NOT runnable in the implement phase** (no live instance, no real SDK subprocess; unit mocks hide the mid-tool-resume behavior by construction). The deliver lane executes these on a real instance (dodi or keepur dev agent) **before ready-to-merge-child** and pastes evidence into the ticket. Procedures are the spec's, verbatim in substance:

- **V1 — abort persists:** set a test agent's `timeoutMs` low (e.g. 60s); send a thread message that forces a long multi-tool turn. Run the scenario **twice**: once with the deadline landing mid-**Bash** tool call (e.g. "clone and summarize a large repo"), and once with it landing mid-**MCP** tool call (e.g. a slow `conversation-search` or `code-task` invocation) — the dangling-`tool_use` repair path is the ticket Caution's real subject and MCP `tool_use` blocks are its primary shape. **Evidence (each run):** the KPR-399 "Persisting session from aborted turn" log line; the `sessions` doc for `{agentId}:{threadId}` carrying a sessionId with `updatedAt` at abort time (mongosh).
- **V2 — follow-up resumes with context (the headline scenario):** send a follow-up message in the same thread ("continue"). **Evidence — all four corroborators:** (1) the follow-up spawn log shows `resumeSession: <id>` (not `"new"`) with the id **equal to** the persisted `sessions` doc's sessionId; (2) the resumed session's JSONL on disk (`~/.claude/projects/…/<id>.jsonl`) contains the pre-abort tool calls; (3) the agent's reply references a **concrete artifact created before the abort** (a file it wrote, a command's output) rather than restarting; (4) no resume-rejection warn fired. This is the direct probe of SDK behavior (i) vs (ii).
- **V3 — outage-replay resumes:** replay requires an open breaker plus a queued turn, so force the breaker open per the KPR-307 test recipe against a thread that already carries a persisted aborted-turn handle, let the 15s poller replay it, and confirm the replayed dispatch's spawn log shows the persisted id. If forcing is impractical on the instance, V2 plus unit item 11 (the re-entry-preference row) is the accepted fallback — record in the ticket which of the two was done.
- **V4 — rejection self-heal (only if V2 exposes behavior (ii)):** capture the exact production error string — inspect `RunResult.error` itself, not just CLI stderr: the runner flattens non-success result subtypes into `error` (agent-runner.ts L2167-2171, raw text only when an `errors` array is present), so a mid-continuation API failure may surface as the bare subtype (e.g. `error_during_execution`), which the matcher will never see — refine `isClaudeResumeLoadError` to match it (matcher refinement is in-contract, KPR-350 posture, ⚠A3), and verify the "resume rejected — one fresh retry" warn fires and the retry completes. If V2 shows behavior (i), V4 is a no-op; the arm remains as insurance for the never-flushed-id case.
- **Record the observed SDK behavior in the ticket either way** — KPR-402's spec consumes it (whether a replayed resume continues mid-tool cleanly determines how aggressive its re-dispatch can be).

---

## Task 0: Worktree setup + baseline

**Files:** none (setup/verification only)

- [ ] **Step 1:** Install dependencies (the delivery worktree has no `node_modules`):

```bash
npm ci
```

- [ ] **Step 2:** Baseline the two suites this plan touches — must be green before any edit:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts src/agents/agent-manager.test.ts
```

Expected: 0 failures. If not, stop — the branch base is broken; report a blocker.

- [ ] **Step 3:** No commit.

## Task 1: Classifier — export the D1 predicate + `isClaudeResumeLoadError` matcher

**Files:**
- Modify: `src/agents/provider-adapters/error-classification.ts` (predicate at L143-147; new matcher inserted between the predicate and `classifyTurnResult`'s doc comment)
- Test: none in this task (existing suite must stay green; new tests are Task 2)

- [ ] **Step 1:** Export `hasObservedProgress` — no body change (spec §Design.1, ⚠A1). Replace:

```ts
/** KPR-398: proof the provider responded THIS turn. Any one signal suffices;
 * all three absent is indistinguishable from a hung provider. */
function hasObservedProgress(input: TurnFaultInput): boolean {
  return (input.toolCalls ?? 0) > 0 || input.streamed === true || (input.text?.length ?? 0) > 0;
}
```

with:

```ts
/** KPR-398: proof the provider responded THIS turn. Any one signal suffices;
 * all three absent is indistinguishable from a hung provider.
 * KPR-399: exported — finalizeSpawnResult's persist-on-abort gate
 * (agent-manager.ts) reuses this exact predicate as its D1 progress check, so
 * the classifier and the persist gate can never silently diverge. A body
 * change here is a Decision-Register event: it moves both surfaces at once. */
export function hasObservedProgress(input: TurnFaultInput): boolean {
  return (input.toolCalls ?? 0) > 0 || input.streamed === true || (input.text?.length ?? 0) > 0;
}
```

- [ ] **Step 2:** Add the resume-rejection matcher immediately after the `hasObservedProgress` function (before the `classifyTurnResult` doc comment), verbatim:

```ts

/**
 * KPR-399: Claude-lane resume-rejection surfaces. (1) the CLI's
 * unknown-session error — the persisted id's transcript never flushed
 * (abort before first write) or was removed; (2) the Messages API 400 when a
 * resumed transcript ends with a dangling tool_use the CLI did not repair.
 * Docs/community-sourced — REFINE against the live capture at delivery
 * (KPR-350 posture; its matcher was refined in KPR-351 L2). Deliberately
 * narrow: a false positive costs one thread's context (fresh retry), a miss
 * costs a dead thread until the 7d TTL. Neither alternate may overlap the
 * auth row (superset rule) — both classify non-provider today, keeping the
 * arm breaker-invisible (pinned in error-classification.test.ts).
 */
export function isClaudeResumeLoadError(reason: string): boolean {
  return (
    /no conversation found with session/i.test(reason) ||
    /tool_use[\s\S]{0,120}?without[\s\S]{0,40}?tool_result/i.test(reason)
  );
}
```

- [ ] **Step 3:** Verify — format, typecheck, existing suite untouched-green:

```bash
npx prettier --write src/agents/provider-adapters/error-classification.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts
```

Expected: typecheck clean; all existing error-classification tests pass (0 failures).

- [ ] **Step 4:** Commit:

```bash
git add src/agents/provider-adapters/error-classification.ts
git commit -m "feat(classifier): export D1 progress predicate + claude resume-rejection matcher (KPR-399)

hasObservedProgress becomes the shared source of truth for the KPR-398
classifier rule AND the KPR-399 persist-on-abort gate (export, no body
change). isClaudeResumeLoadError pins the two docs-sourced Claude resume-
rejection surfaces (unknown-session, dangling tool_use 400) for the
manager's one-shot fresh-retry self-heal arm; both classify non-provider,
so the arm is breaker-invisible.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 2: Classifier tests — matcher pins, narrowness matrix, breaker-invisibility, export pin

**Files:**
- Modify: `src/agents/provider-adapters/error-classification.test.ts` (import block at top; new describe appended after the KPR-398 describe at end of file)

- [ ] **Step 1:** Extend the import block. Replace:

```ts
import {
  classifyTurnResult,
  classifyThrown,
  HARD_FAULT_KINDS,
  TURN_DEADLINE_SUBTYPE,
  TurnAssemblyError,
  type ProviderFaultKind,
} from "./error-classification.js";
```

with:

```ts
import {
  classifyTurnResult,
  classifyThrown,
  HARD_FAULT_KINDS,
  hasObservedProgress,
  isClaudeResumeLoadError,
  TURN_DEADLINE_SUBTYPE,
  TurnAssemblyError,
  type ProviderFaultKind,
} from "./error-classification.js";
```

- [ ] **Step 2:** Append the new describe block at the end of the file (after the closing `});` of the `KPR-398 — deadline abort with observed progress` describe):

```ts

describe("KPR-399 — claude resume-rejection matcher + persist-predicate export", () => {
  // Realistic surface strings (docs/community-sourced — matcher wording is
  // ⚠A3, REFINED against the live V4 capture at delivery, KPR-350 posture).
  const UNKNOWN_SESSION = "No conversation found with session ID: 0198c3f2-abcd-7890-b1c2-d3e4f5a6b7c8";
  const DANGLING_TOOL_USE =
    "400 invalid_request_error: messages.57: the following `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01AbCdEfGh";

  it.each([UNKNOWN_SESSION, DANGLING_TOOL_USE])("positive pin — matches: %s", (s) =>
    expect(isClaudeResumeLoadError(s)).toBe(true),
  );

  // Breaker-invisibility pin: both surfaces classify non-provider (no
  // FAULT_PATTERNS row matches), so the self-heal arm is breaker-invisible
  // whether or not it fires. classifyErrorString is module-private — route
  // the pin through classifyTurnResult({ error }) (spec Testing Contract 9).
  it.each([UNKNOWN_SESSION, DANGLING_TOOL_USE])("breaker-invisible — classifies non-provider: %s", (s) => {
    expect(classifyTurnResult({ error: s })).toEqual({
      outcome: "fault",
      kind: "non-provider",
      message: s,
    });
  });

  // Narrowness matrix, auth direction: every isAuthRebuildResumeError
  // alternate (agent-manager.ts — strings mirrored per the auth-superset-pin
  // precedent above) must NOT match the new matcher (no cross-arm capture;
  // the auth-row superset rule is untouched by this ticket).
  it.each([
    "could not resolve authentication",
    "missing credentials.json",
    "not authenticated",
    "401 Unauthorized",
    "ANTHROPIC_API_KEY is not set",
    "invalid authToken",
  ])("auth-rebuild alternate does NOT match isClaudeResumeLoadError: %s", (s) =>
    expect(isClaudeResumeLoadError(s)).toBe(false),
  );

  // Narrowness matrix, stale-server direction: the isStaleServerHandleError
  // alternates (agent-manager.ts — openai prose surfaces + the gemini
  // adapter sentinel) must not cross-match either.
  it.each([
    "Previous response with id 'resp_abc123' not found.",
    "400 invalid_request_error: previous_response_id 'resp_x' not found",
    "Previous response resp_9 has expired",
    "gemini interaction resume rejected (status 400): previous_interaction_id invalid",
  ])("stale-server alternate does NOT match isClaudeResumeLoadError: %s", (s) =>
    expect(isClaudeResumeLoadError(s)).toBe(false),
  );

  it("generic 400s / unrelated strings / bare SDK subtypes do not match (deliberate narrowness)", () => {
    expect(isClaudeResumeLoadError("400 Bad Request")).toBe(false);
    expect(isClaudeResumeLoadError("session not found")).toBe(false); // no "conversation" anchor
    expect(isClaudeResumeLoadError("tool_use block streamed mid-turn")).toBe(false); // no without…tool_result tail
    // The V4 watch item: the runner may flatten a mid-continuation API
    // failure to the bare subtype — the matcher deliberately does NOT match
    // it today (refinement is in-contract if V4 observes it).
    expect(isClaudeResumeLoadError("error_during_execution")).toBe(false);
  });

  // Spec Testing Contract 10: the exported symbol IS the D1 predicate both
  // sites consume (single source of truth). The KPR-398 classifier rows
  // above re-run unedited; the persist-gate tests (agent-manager.test.ts)
  // exercise the import at the second site.
  it("hasObservedProgress export: each signal independently sufficient; zero/absent shapes false", () => {
    expect(hasObservedProgress({ toolCalls: 1 })).toBe(true);
    expect(hasObservedProgress({ streamed: true })).toBe(true);
    expect(hasObservedProgress({ text: "x" })).toBe(true);
    expect(hasObservedProgress({ toolCalls: 0, streamed: false, text: "" })).toBe(false);
    expect(hasObservedProgress({})).toBe(false);
  });
});
```

- [ ] **Step 3:** Verify green on fixed code:

```bash
npx prettier --write src/agents/provider-adapters/error-classification.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts
```

Expected: all tests pass, including the new KPR-399 describe.

- [ ] **Step 4:** Negative-verify — degenerate by construction (a brand-new export cannot pass on pre-fix code), run anyway per convention, NO `git stash`. Task 1's commit is `HEAD`; reverse-apply its classifier diff:

```bash
git diff HEAD~1 HEAD -- src/agents/provider-adapters/error-classification.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts
```

Expected: the run FAILS — the test file cannot even import `hasObservedProgress`/`isClaudeResumeLoadError` from pre-fix source (missing-export error fails the whole file). This is the expected degenerate failure mode for new-symbol pins; the behavioral negative-verify anchors are Task 4's. Every consideration beyond "it fails" is out of scope here. Restore and confirm:

```bash
git checkout HEAD -- src/agents/provider-adapters/error-classification.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts
```

Expected `git status --short`: exactly ` M src/agents/provider-adapters/error-classification.test.ts`. Suite green post-restore.

- [ ] **Step 5:** Commit:

```bash
git add src/agents/provider-adapters/error-classification.test.ts
git commit -m "test(classifier): KPR-399 matcher pins — positive, narrowness matrix, breaker-invisibility, predicate export

Both isClaudeResumeLoadError alternates positive-pinned; every auth-rebuild
and stale-server-handle alternate negative-pinned against it (no cross-arm
capture); both surfaces pinned non-provider via classifyTurnResult (breaker-
invisible); hasObservedProgress export pinned as the shared D1 predicate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 3: Manager — persist-on-abort gate + resume-rejection self-heal arm (+ one legacy-pin re-scope)

**Files:**
- Modify: `src/agents/agent-manager.ts` (import at L49; retry chain — arm inserted after the KPR-350/351 stale-handle arm, currently ending L1088; `finalizeSpawnResult` persist block L1869-1905; `synthesizeAbortedResult` doc comment L1544-1552)
- Modify: `src/agents/agent-manager.test.ts` (ONE row re-scoped at L2018 — the deliberate semantics change, kept in this commit so every commit is green; all new tests are Task 4)

- [ ] **Step 1:** Extend the classifier import. Replace:

```ts
import { classifyThrown, classifyTurnResult, TURN_DEADLINE_SUBTYPE } from "./provider-adapters/error-classification.js";
```

with:

```ts
import {
  classifyThrown,
  classifyTurnResult,
  hasObservedProgress,
  isClaudeResumeLoadError,
  TURN_DEADLINE_SUBTYPE,
} from "./provider-adapters/error-classification.js";
```

- [ ] **Step 2:** Add the third retry-chain arm (spec §Design.3, ⚠A2). In `spawnTurn`'s try block, the KPR-350/351 stale-handle arm currently ends with this exact text (followed by `} catch (err) {`). Replace:

```ts
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: adoptedSessionId },
            shaping,
            ticket,
            onStream,
          );
        }
      } catch (err) {
```

with:

```ts
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: adoptedSessionId },
            shaping,
            ticket,
            onStream,
          );
        } else if (
          // KPR-399 (§D3): claude-lane resume-rejection self-heal. The
          // persist-on-abort arm (finalizeSpawnResult) creates a class of
          // persisted ids whose resumability is uncertain (mid-tool-call
          // kill, flush timing): the CLI may reject the resume
          // (unknown-session) or the first continuation may 400 on a
          // dangling tool_use. One fresh retry — bounded loss of one
          // thread's context instead of a thread erroring identically until
          // the 7-day row TTL. Semantics inherited from the arms above:
          // `else if` ⇒ at most one retry per turn; record-once untouched
          // (only the finalized attempt reaches the breaker); no pre-scrub —
          // a successful retry overwrites the row via finalize, a failed one
          // leaves it for the next turn's re-trip. SEMANTICS gate
          // (client-transcript = claude + Lane A passthrough) — the KPR-347
          // seam: dead for server-resumable (their resume errors have their
          // own arm) and stateless-replay (nothing to resume). Both matcher
          // surfaces classify non-provider (pinned), so the arm is
          // breaker-invisible either way.
          finalResult.error &&
          isClaudeResumeLoadError(finalResult.error) &&
          effectiveCtx.sessionId &&
          sessionSemanticsFor(shaping.route.provider) === "client-transcript"
        ) {
          // Deliberately NOT logging the error string: the CLI's
          // unknown-session surface embeds the session id (log-redaction
          // posture — the KPR-350 arm's "no handle value" rule).
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
      } catch (err) {
```

- [ ] **Step 3:** Add the persist-on-abort arm (spec §Design.2, ⚠A1/⚠A4). In `finalizeSpawnResult`, replace:

```ts
    const newSessionId = result.sessionId || ctx.sessionId || "";
    if (result.sessionId && !result.aborted) {
```

with:

```ts
    const newSessionId = result.sessionId || ctx.sessionId || "";
    // KPR-399 (§D2): an aborted claude-lane turn with observed progress
    // persists its session so replays/retries/follow-ups RESUME instead of
    // restarting from scratch. client-transcript ONLY (cross-epic canon C3 —
    // claude + Lane A kimi/deepseek/grok): the id is a local transcript
    // handle the CLI flushed incrementally, and observed progress (the
    // exported KPR-398 D1 predicate — one source of truth with the
    // classifier) is the proof it actually ran. Zero-progress aborts persist
    // nothing (fail-closed = pre-399 behavior): the id may point at a
    // never-flushed file, and a rotated id with zero progress is
    // indistinguishable from a failed-resume mint (churn-mint's own
    // rationale). Lane B (server-resumable / stateless-replay) keeps the
    // !aborted behavior byte-for-byte — resume-on-abort there goes through
    // the KPR-385 scaffold hooks, never a silent unification here.
    const abortPersist =
      result.aborted === true &&
      !!result.sessionId &&
      sessionSemanticsFor(route.provider) === "client-transcript" &&
      hasObservedProgress(result) &&
      // Mint-safety belt (the ⚠A4 churn-mint condition, applied verbatim):
      // an aborted turn that ALSO errored, resumed a session, and came back
      // with a DIFFERENT id never overwrites the row. Rare shape (deadline
      // aborts carry no error), but it makes this arm self-evidently
      // mint-safe.
      !(result.error && ctx.sessionId && result.sessionId !== ctx.sessionId);

    if (result.sessionId && !result.aborted) {
```

Then, at the END of the same `if` block — its closing brace currently reads (the `});` closes the `sessionStore.set` call, the final `}` lines close the churn-mint `else` and the outer `if`):

```ts
          preCompactTokens: result.preCompactTokens,
        });
      }
    }
```

replace with:

```ts
          preCompactTokens: result.preCompactTokens,
        });
      }
    } else if (abortPersist) {
      log.info("Persisting session from aborted turn — replay/follow-up will resume (KPR-399)", {
        agentId: ctx.agentId,
        threadId: ctx.threadId,
        timedOut: result.timedOut === true,
      });
      // NO tokenData: aborted turns carry all-zero usage (the SDK result
      // message never arrived) — set() without tokenData updates only
      // sessionId/provider/updatedAt, preserving the prior turn's stats
      // (session-store.ts set(): defaults land $setOnInsert-only).
      this.sessionStore.set(ctx.agentId, ctx.threadId, result.sessionId, route.provider);
    }
```

(The existing `if` body between those two anchors — churn-mint rider, `resumable ? result.sessionId : ""`, tokenData object — stays **byte-for-byte untouched**. The `preCompactTokens` anchor text appears once inside `finalizeSpawnResult`; if `git grep -n "preCompactTokens: result.preCompactTokens"` shows the other occurrence in the TurnResult return literal, anchor on the four-line block above, which is unique.)

- [ ] **Step 4:** Reconcile the now-stale `synthesizeAbortedResult` doc comment (comment-only). Replace:

```ts
   * `aborted: true` so classifyTurnResult resolves to "aborted" and the
   * downstream finalize path (session persist skipped on aborted, telemetry
   * skipped) behaves exactly as a real adapter-emitted abort. sessionId is the
```

with:

```ts
   * `aborted: true` so classifyTurnResult resolves to "aborted" and the
   * downstream finalize path (telemetry skipped; KPR-399's persist-on-abort
   * arm skips this zero-progress shape too — fail-closed) behaves exactly as
   * a real adapter-emitted abort. sessionId is the
```

- [ ] **Step 5:** Re-scope the ONE legacy pin whose behavior this ticket deliberately changes (same commit as the source change so every commit is green). In `src/agents/agent-manager.test.ts`, replace:

```ts
    it("does NOT update session-store when the result is aborted", async () => {
      mockRunnerSend.mockResolvedValueOnce(
        makeRunResult({ aborted: true, sessionId: "session-aborted" }),
      );
      await manager.spawnTurn(smsCtx());
      expect(sessionStore.set).not.toHaveBeenCalled();
    });
```

with:

```ts
    it("does NOT update session-store when the result is aborted with ZERO progress (KPR-399 re-scope)", async () => {
      // Pre-KPR-399 this row pinned "aborted never persists" using the
      // fixture's default progress fields (toolCalls: 1, text: "response") —
      // a shape that now DELIBERATELY persists (§D2 persist-on-abort). It is
      // re-scoped to the zero-progress shape (also synthesizeAbortedResult's
      // shape): the fail-closed direction, which survives unchanged. The
      // with-progress direction is pinned in the KPR-399 persist-on-abort
      // describe below.
      mockRunnerSend.mockResolvedValueOnce(
        makeRunResult({ aborted: true, sessionId: "session-aborted", toolCalls: 0, streamed: false, text: "" }),
      );
      await manager.spawnTurn(smsCtx());
      expect(sessionStore.set).not.toHaveBeenCalled();
    });
```

- [ ] **Step 6:** Verify — format, typecheck, both suites green (proves the re-scope was the only pre-existing row affected; drafting-time audit found the other aborted fixtures at L539/L1212/L1239 assert nothing on `sessionStore.set`):

```bash
npx prettier --write src/agents/agent-manager.ts src/agents/agent-manager.test.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts src/agents/provider-adapters/error-classification.test.ts
```

Expected: typecheck clean; 0 failures across both suites. If any OTHER pre-existing row fails, stop and investigate — that is an unplanned behavior change, not a test to edit.

- [ ] **Step 7:** Commit:

```bash
git add src/agents/agent-manager.ts src/agents/agent-manager.test.ts
git commit -m "fix(agent-manager): persist aborted claude-lane turns with observed progress; resume-rejection self-heal (KPR-399)

finalizeSpawnResult gains the abortPersist arm: aborted === true + nonempty
sessionId + client-transcript semantics (C3: claude + Lane A only) + the
exported D1 progress predicate + a churn-mint safety belt ⇒ persist the
transcript handle with NO tokenData (prior turn's stats preserved). Every
re-entry whose store read follows finalize — outage replay, next user
message, reflection — now resumes the partial turn; zero replay-path edits.
Success path byte-identical; Lane B unchanged.

spawnTurn's retry chain gains a third else-if arm: a resume the SDK rejects
(isClaudeResumeLoadError — unknown-session / dangling tool_use 400) retries
once fresh (semantics-gated client-transcript, record-once intact,
breaker-invisible, no error string logged) — the insurance that makes
persist-on-abort safe ahead of live confirmation of mid-tool resume.

One legacy pin re-scoped in-commit to the zero-progress shape (the old
aborted-never-persists row pinned behavior this ticket deliberately changes).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 4: Manager tests — persist gate both directions, C3/Lane A pins, self-heal arm, re-entry preference + negative-verify

**Files:**
- Modify: `src/agents/agent-manager.test.ts` (two new describes inserted inside `describe("spawnTurn (KPR-216)")`, between the closing `});` of the `stale-handle self-heal — gemini (KPR-352 §D3)` describe and the `describe("Lane A passthrough (KPR-346)", ...)` line)

- [ ] **Step 1:** Insert both describes at the location above, verbatim:

```ts
    describe("persist-on-abort (KPR-399 §D2)", () => {
      beforeEach(() => {
        mockConversationIndex.mockResolvedValue(undefined);
      });

      // Incident shape (KPR-397 epic, 2026-08-26): deadline abort mid-tool
      // turn with a valid transcript id — must persist so replay/follow-up
      // resumes instead of restarting ("think / hit-wall / restart" loop).
      it("aborted claude turn WITH progress persists sessionId — no tokenData (new direction)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "s1", toolCalls: 46, streamed: true, text: "" }),
        );
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-p1" });
        await manager.spawnTurn(ctx);
        expect(sessionStore.set).toHaveBeenCalledTimes(1);
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s1", "claude");
        // No 5th arg: tokenData omitted — aborted turns carry all-zero usage;
        // set() without tokenData preserves the prior turn's stats.
        expect(sessionStore.set.mock.calls[0]!.length).toBe(4);
      });

      it.each([
        ["toolCalls alone", { toolCalls: 1, streamed: false, text: "" }],
        ["streamed alone", { toolCalls: 0, streamed: true, text: "" }],
        ["text alone", { toolCalls: 0, streamed: false, text: "partial reply" }],
      ] as const)("each D1 signal independently sufficient: %s", async (_label, progress) => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "s1", ...progress }),
        );
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-sig" });
        await manager.spawnTurn(ctx);
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s1", "claude");
      });

      it("fail-closed: aborted with ZERO progress persists nothing (also synthesizeAbortedResult's shape)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "s1", toolCalls: 0, streamed: false, text: "" }),
        );
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr399-zero" }));
        expect(sessionStore.set).not.toHaveBeenCalled();
      });

      it("empty sessionId on an aborted result persists nothing (abort before system/init)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, timedOut: true, sessionId: "", toolCalls: 3, streamed: true, text: "" }),
        );
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr399-noid" }));
        expect(sessionStore.set).not.toHaveBeenCalled();
      });

      it("operator abort (aborted without timedOut) with progress persists too — uniform handling (⚠A4)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, sessionId: "s-stop", toolCalls: 3, streamed: true, text: "" }),
        );
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-stop" });
        await manager.spawnTurn(ctx);
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s-stop", "claude");
      });

      it("mint-safety belt: aborted + errored + resumed + DIFFERENT id never overwrites the row", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, error: "boom", sessionId: "s-minted", toolCalls: 3, streamed: true, text: "" }),
        );
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr399-mint", sessionId: "s-old", sessionProvider: "claude" }),
        );
        expect(sessionStore.set).not.toHaveBeenCalled();
      });

      it("mint-safety belt scope: aborted + errored turn re-persisting the SAME id it resumed is allowed (TTL refresh)", async () => {
        mockRunnerSend.mockResolvedValueOnce(
          makeRunResult({ aborted: true, error: "boom", sessionId: "s-same", toolCalls: 3, streamed: true, text: "" }),
        );
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-same", sessionId: "s-same", sessionProvider: "claude" });
        await manager.spawnTurn(ctx);
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s-same", "claude");
      });

      it("C3 pins: aborted-with-progress on openai / gemini / codex routes persists NOTHING (Lane B byte-for-byte)", async () => {
        registry._agents.set(
          "openai-pilot",
          makeAgentConfig({ id: "openai-pilot", name: "OP", model: "openai/gpt-5.4-mini", coreServers: [] }),
        );
        registry._agents.set(
          "gemini-pilot",
          makeAgentConfig({ id: "gemini-pilot", name: "GP", model: "gemini/gemini-2.5-pro", coreServers: [] }),
        );
        registry._agents.set(
          "codex-pilot",
          makeAgentConfig({ id: "codex-pilot", name: "CP", model: "codex/gpt-5.5:medium", coreServers: [] }),
        );
        const shape = { aborted: true, timedOut: true, toolCalls: 5, streamed: true, text: "" };
        mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ ...shape, sessionId: "resp-abort" }));
        await manager.spawnTurn(smsCtx({ agentId: "openai-pilot", threadId: "sms:line-1:kpr399-c3-o" }));
        mockGeminiRunTurn.mockResolvedValueOnce(makeRunResult({ ...shape, sessionId: "int-abort" }));
        await manager.spawnTurn(smsCtx({ agentId: "gemini-pilot", threadId: "sms:line-1:kpr399-c3-g" }));
        mockCodexRunTurn.mockResolvedValueOnce(makeRunResult({ ...shape, sessionId: "codex-abort" }));
        await manager.spawnTurn(smsCtx({ agentId: "codex-pilot", threadId: "sms:line-1:kpr399-c3-c" }));
        expect(sessionStore.set).not.toHaveBeenCalled();
      });

      it("Lane A inheritance pin: kimi and grok aborted-with-progress turns persist under their own tags (client-transcript)", async () => {
        process.env.KIMI_API_KEY = "test-kimi-key";
        process.env.GROK_GATEWAY_KEY = "test-grok-gateway-key";
        try {
          registry._agents.set(
            "agent-kimi",
            makeAgentConfig({ id: "agent-kimi", name: "AgentKimi", model: "kimi/kimi-k3", coreServers: [] }),
          );
          registry._agents.set(
            "agent-grok",
            makeAgentConfig({ id: "agent-grok", name: "AgentGrok", model: "grok/grok-4.6", coreServers: [] }),
          );
          mockRunnerSend.mockResolvedValueOnce(
            makeRunResult({ aborted: true, timedOut: true, sessionId: "kimi-s1", toolCalls: 2, streamed: true, text: "" }),
          );
          const kctx = smsCtx({ agentId: "agent-kimi", threadId: "sms:line-1:kpr399-kimi" });
          await manager.spawnTurn(kctx);
          expect(sessionStore.set).toHaveBeenCalledWith("agent-kimi", kctx.threadId, "kimi-s1", "kimi");
          mockRunnerSend.mockResolvedValueOnce(
            makeRunResult({ aborted: true, timedOut: true, sessionId: "grok-s1", toolCalls: 2, streamed: true, text: "" }),
          );
          const gctx = smsCtx({ agentId: "agent-grok", threadId: "sms:line-1:kpr399-grok" });
          await manager.spawnTurn(gctx);
          expect(sessionStore.set).toHaveBeenCalledWith("agent-grok", gctx.threadId, "grok-s1", "grok");
        } finally {
          delete process.env.KIMI_API_KEY;
          delete process.env.GROK_GATEWAY_KEY;
        }
      });

      it("re-entry prefers resume: after an aborted-turn persist, the next runWorkItemTurn on the thread resumes the persisted id", async () => {
        // Pins spec Testing Contract 11 — "replay prefers resume" — via the
        // real store-backed path (runWorkItemTurn → sessionStore.get →
        // ctx.sessionId → runner resume), without touching dispatcher code.
        mockRunnerSend
          .mockResolvedValueOnce(
            makeRunResult({ aborted: true, timedOut: true, sessionId: "s-abort", toolCalls: 7, streamed: true, text: "" }),
          )
          .mockResolvedValueOnce(makeRunResult({ text: "resumed", sessionId: "s-abort" }));
        const threadId = "sms:line-1:kpr399-replay";
        const src = { kind: "sms" as const, id: "line-1", label: "May (CEO)" };
        await manager.runWorkItemTurn("agent-a", makeWorkItem({ threadId, source: src, sender: "+15551234567" }));
        const second = await manager.runWorkItemTurn(
          "agent-a",
          makeWorkItem({ threadId, source: src, sender: "+15551234567" }),
        );
        expect(mockRunnerSend.mock.calls[1]![1]).toBe("s-abort"); // resumed, not "new"
        expect(second.newSessionId).toBe("s-abort");
      });
    });

    describe("resume-rejection self-heal (KPR-399 §D3)", () => {
      const UNKNOWN_SESSION = "No conversation found with session ID: 0198c3f2-abcd-7890-b1c2-d3e4f5a6b7c8";
      const DANGLING_TOOL_USE =
        "400 invalid_request_error: messages.57: the following `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01AbCdEfGh";

      beforeEach(() => {
        mockConversationIndex.mockResolvedValue(undefined);
      });

      it.each([
        ["unknown-session", UNKNOWN_SESSION],
        ["dangling tool_use 400", DANGLING_TOOL_USE],
      ])("retries exactly once with sessionId stripped on %s; retry result is the turn result", async (_label, reason) => {
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ error: reason, sessionId: "" }))
          .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "s-fresh" }));
        const ctx = smsCtx({ threadId: "sms:line-1:kpr399-heal", sessionId: "s-dead", sessionProvider: "claude" });
        const result = await manager.spawnTurn(ctx);
        expect(mockRunnerSend).toHaveBeenCalledTimes(2);
        expect(mockRunnerSend.mock.calls[0]![1]).toBe("s-dead"); // first attempt resumed
        expect(mockRunnerSend.mock.calls[1]![1]).toBeUndefined(); // fresh retry
        expect(result.finalMessage).toBe("healed");
        expect(result.newSessionId).toBe("s-fresh");
        // Write path self-corrects: fresh handle persisted normally (no scrub).
        expect(sessionStore.set).toHaveBeenCalledWith("agent-a", ctx.threadId, "s-fresh", "claude", expect.anything());
        // Redaction posture: the warn carries no error string / handle value.
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining("resume rejected"),
          expect.not.objectContaining({ reason: expect.anything() }),
        );
        const leaked = mockLogWarn.mock.calls.some(([, meta]) => JSON.stringify(meta ?? "").includes("s-dead"));
        expect(leaked).toBe(false);
      });

      it("breaker record-once: only the finalized attempt is recorded; streak stays 0 (breaker-invisible)", async () => {
        const recordSpy = vi.spyOn(manager.circuitBreakers, "record");
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }))
          .mockResolvedValueOnce(makeRunResult({ text: "ok", sessionId: "s-2" }));
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr399-brk", sessionId: "s-dead", sessionProvider: "claude" }),
        );
        expect(recordSpy).toHaveBeenCalledTimes(1); // first attempt's rejection never recorded
        expect(recordSpy.mock.calls[0]![1]).toEqual({ outcome: "success" });
        const snap = manager.circuitBreakers.stateFor("claude")!;
        expect(snap.state).toBe("closed");
        expect(snap.consecutiveHardFaults).toBe(0);
      });

      it("single retry: a retry that fails with the matcher string again is NOT retried a second time", async () => {
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }))
          .mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }));
        const result = await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr399-once", sessionId: "s-dead", sessionProvider: "claude" }),
        );
        expect(mockRunnerSend).toHaveBeenCalledTimes(2);
        expect(result.errors).toEqual([UNKNOWN_SESSION]);
      });

      it("gating: dead without a stored sessionId; dead on openai (semantics gate); auth sentinel routes to the auth arm", async () => {
        // No sessionId → no retry (arm requires effectiveCtx.sessionId).
        mockRunnerSend.mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "" }));
        await manager.spawnTurn(smsCtx({ threadId: "sms:line-1:kpr399-g1", sessionId: undefined }));
        expect(mockRunnerSend).toHaveBeenCalledTimes(1);
        // openai route + same string + sessionId → no retry: server-resumable
        // is not this arm's semantics, and the string does not match the
        // KPR-350 arm's matcher either (mutual exclusivity, both directions).
        registry._agents.set(
          "openai-pilot",
          makeAgentConfig({ id: "openai-pilot", name: "OP", model: "openai/gpt-5.4-mini", coreServers: [] }),
        );
        mockOpenAIRunTurn.mockResolvedValueOnce(makeRunResult({ error: UNKNOWN_SESSION, sessionId: "resp-x" }));
        await manager.spawnTurn(
          smsCtx({ agentId: "openai-pilot", threadId: "sms:line-1:kpr399-g2", sessionId: "resp-old", sessionProvider: "openai" }),
        );
        expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(1);
        // Auth sentinel on claude + sessionId → the FIRST arm fires (else-if
        // chain order), never this one: its warn appears, ours does not.
        mockRunnerSend
          .mockResolvedValueOnce(makeRunResult({ error: "Could not resolve authentication method", sessionId: "" }))
          .mockResolvedValueOnce(makeRunResult({ text: "ok", sessionId: "s-a" }));
        await manager.spawnTurn(
          smsCtx({ threadId: "sms:line-1:kpr399-g3", sessionId: "s-x", sessionProvider: "claude" }),
        );
        expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("auth-rebuild"), expect.anything());
        const resumeWarn = mockLogWarn.mock.calls.some(([msg]) => String(msg).includes("resume rejected"));
        expect(resumeWarn).toBe(false);
      });
    });

```

- [ ] **Step 2:** Verify green on fixed code:

```bash
npx prettier --write src/agents/agent-manager.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected: all tests pass, including both new KPR-399 describes.

- [ ] **Step 3:** Negative-verify (repo convention — NO `git stash`). Task 3's commit is `HEAD`; reverse-apply **only its `agent-manager.ts` source diff** (the test-file half of that commit — the re-scoped row — stays in place; the uncommitted Task 4 test additions stay in the working tree; Vitest strips types via esbuild so the reverted import list does not block execution):

```bash
git diff HEAD~1 HEAD -- src/agents/agent-manager.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected: **failures confined to the two new KPR-399 describes** — at minimum: the new-direction persist row, all three D1-signal rows, the operator-abort row, the same-id TTL-refresh row, the Lane A inheritance row, the re-entry-preference row (all persist nothing on pre-fix code), and every self-heal row (no retry fires: single runner call / errors surface / no "resume rejected" warn). Rows that pass both ways — deliberately: the fail-closed row, the empty-sessionId row, the mint-belt different-id row, the C3 pins, the re-scoped zero-progress legacy row (Task 3's test-file change, not reverted). Every pre-existing test still passes. If the new-direction rows do NOT fail here, stop — the tests are not pinning the behavior change; fix the tests.

Restore and confirm:

```bash
git checkout HEAD -- src/agents/agent-manager.ts
git status --short
```

Expected `git status --short` output: exactly ` M src/agents/agent-manager.test.ts`.

Re-run the suite once more to confirm green post-restore:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

- [ ] **Step 4:** Commit:

```bash
git add src/agents/agent-manager.test.ts
git commit -m "test(agent-manager): KPR-399 pins — persist-on-abort both directions, C3/Lane A, self-heal arm, re-entry preference

Negative-verified: with Task 3's agent-manager.ts diff reverse-applied, the
new-direction persist rows, D1-signal rows, operator-abort row, Lane A
inheritance row, re-entry-preference row, and every self-heal row fail on
pre-fix code; fail-closed / C3 / mint-belt rows pass either way, and every
pre-existing row passes both ways.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 5: Final verification — full quality gate + scope containment

**Files:** none (verification only)

- [ ] **Step 1:** Run the complete repo gate with the required env stubs:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: all four gates green — typecheck (tsc, no errors), lint (eslint, no errors), format (prettier --check, no diffs), test (vitest, 0 failures — including the untouched `dispatcher`, `session-store`, and `provider-circuit-breaker` suites).

- [ ] **Step 2:** Confirm scope containment — the four KPR-399 commits touch exactly four files, none of them the runner, dispatcher, outage processor, session store, provider adapters, breaker, or `docs/providers.md` (spec Non-Goals + ⚠A5):

```bash
git diff --stat HEAD~4 HEAD -- ':!docs'
```

Expected: exactly `src/agents/provider-adapters/error-classification.ts`, `src/agents/provider-adapters/error-classification.test.ts`, `src/agents/agent-manager.ts`, `src/agents/agent-manager.test.ts`.

- [ ] **Step 3:** No commit (verification-only task). Do not push, do not open a PR — that is the deliver lane's job. Remember: the **Live-instance verification** section above (V1–V4) is a deliver-lane gate for ready-to-merge-child, not an implement-phase step.

---

## Plan-drafting advisories (implementer notes, not deviations)

- **[Task 3, Step 3]:** the second Edit anchor (`preCompactTokens: result.preCompactTokens,` + `});` + two closing braces) is unique as a four-line block — the other `preCompactTokens: result.preCompactTokens,` occurrence in the file (the TurnResult return literal, ~L1937) has different surrounding lines. If an exact-match edit tool complains, widen the anchor upward to include `contextWindow: result.contextWindow,`.
- **[Task 4, Step 1]:** several new `it(...)` lines and `makeRunResult({...})` literals exceed typical print width; the Step 2 `prettier --write` will rewrap them before commit — do not treat the reflow as a deviation.
- **[Task 4]:** the `it.each` callbacks destructure `_label` unused — the repo's existing suites use the same pattern (KPR-398 block in `error-classification.test.ts`), so ESLint accepts it; if `npm run check` flags it anyway, fix at Task 5.
- **[Matcher strings]:** `UNKNOWN_SESSION` / `DANGLING_TOOL_USE` are docs-sourced stand-ins (⚠A3). If the deliver lane's V4 captures a different production string, refine `isClaudeResumeLoadError` + its pins in the same change — that refinement is in-contract (KPR-350 precedent), not scope creep.
