# KPR-398 — Claude-Lane Deadline-Abort Progress Split Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** A Claude-lane deadline abort with observed progress (`toolCalls > 0 || streamed || text.length > 0`) classifies as the breaker-inconclusive `turn-deadline` fault instead of the hard `timeout` fault, while a zero-progress deadline abort (the hang signature) keeps classifying hard `timeout` — plus the one dispatcher outage-gate call site is reconciled to the new semantics.

**Architecture:** The entire behavior change lives in `classifyTurnResult` rule 1 (`src/agents/provider-adapters/error-classification.ts`): `TurnFaultInput` gains three optional progress fields (names matching `RunResult` verbatim, so the breaker feed at `agent-manager.ts:1095` picks them up structurally with zero edits), a pure `hasObservedProgress` predicate gates the rule-1 split, and absent fields fail closed to pre-fix behavior. The dispatcher's post-turn outage gate (`src/channels/dispatcher.ts:566-573`) is the only call site edited: it passes the full `RunResult` and drops its redundant `hangTimeout` arm so a with-progress deadline turn is never queued into `outage_queue` for side-effect replay. **No breaker edits, no Lane B edits, no `docs/providers.md` edit (spec A4), no new `ProviderFaultKind`.**

**Tech Stack:** TypeScript (strict), Vitest, pure dependency-free classifier module.

> **Decision Register canon:** none exists yet — the KPR-397 epic predates its first merge; no `## Decision Register — Canon` section exists anywhere in the epic docs. The spec's ⚠-flagged assumptions (A1–A4) are the candidate entries.

**Authoritative spec:** `docs/epics/kpr-397/kpr-398-spec.md` (survived Frontier review verbatim; its §Design.3 code and §Tests rows are binding).

## Testing Contract

### Required Test Groups

- **Unit: required**
  - *Scope:* `classifyTurnResult` rule-1 split — new direction (with-progress → `turn-deadline`, each signal independently sufficient, message pin), preserved direction (explicit zeros → hard `timeout`; absent fields → fail-closed hard `timeout`), negative pins (progress fields must not perturb rules 2–5, Lane B sentinel unchanged, `HARD_FAULT_KINDS` membership unchanged); dispatcher post-turn outage gate — with-progress deadline + open breaker → legacy path unqueued; zero-progress rows preserved.
  - *Reason:* the classifier is the root-cause fix and the breaker's sole input for this fault class; the dispatcher gate is the only other call site and its failure mode is silent side-effect replay.
  - *Minimum assertions:* the 12 rows in spec §Tests — tests 1–10 in `src/agents/provider-adapters/error-classification.test.ts`, tests 11–12 in `src/channels/dispatcher.test.ts`. Existing pinned rows in both files are regression pins and must be preserved verbatim (re-annotation via comments only).
- **Integration: not-required** — Harness: not-applicable.
- **E2E: not-required** — Harness: not-applicable.

### Critical Flows

1. **Incident shape** (`timedOut: true, aborted: true, toolCalls: 46, streamed: true, text: ""`) → `{ outcome: "fault", kind: "turn-deadline" }`, not in `HARD_FAULT_KINDS` — the 2026-08-25 fleet-wide claude circuit-open can no longer happen from tool-heavy turns.
2. **Zero-progress hang** (`timedOut: true, aborted: true, toolCalls: 0, streamed: false, text: ""`) → hard `timeout` — three consecutive still open the circuit. Preserved.
3. **Fail-closed narrowed caller** (`{ timedOut: true, aborted: true }`, progress fields absent) → hard `timeout` — pre-KPR-398 behavior.
4. **Dispatcher gate:** with-progress deadline turn + breaker open+enabled → legacy path, `outage_queue` never touched (no silent replay of a partially-executed tool turn's side effects); zero-progress hang + breaker open → outage path unchanged.

### Regression Surface

- Every pre-existing row in `src/agents/provider-adapters/error-classification.test.ts` (KPR-306/312/347/350/351/352 pins, Google-429 negative pins, auth-superset pins, `HARD_FAULT_KINDS` membership) — **all preserved verbatim**; the `{ timedOut: true, aborted: true }` row at L18-29 changes *meaning* (it is now the fail-closed pin) but not text or expected values.
- Dispatcher outage-interception suite (`src/channels/dispatcher.test.ts:1130-1300`) — rows at L1221 and L1234 use fixture defaults `toolCalls: 0, streamed: false` with `finalMessage: ""` (zero-progress shapes) and must pass unchanged.
- `provider-circuit-breaker` suite — untouched (its `turn-deadline` consumption arms are the semantics this change relies on; out of scope per spec Non-Goals).
- Cross-epic: KPR-385's `classification-crosscheck.test.ts` is **not on this branch** — no action; its rows never set both `timedOut` and `aborted`, so whichever epic lands second re-runs it unedited.

### Commands

All commands run from `/Users/mokie/github/lane-kpr-398-mature`. Env stubs are required for anything importing config:

```bash
export SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test
```

- **Unit:** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts src/channels/dispatcher.test.ts`
- **Integration:** n/a
- **E2E:** n/a
- **Broader regression:** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (typecheck + lint + format + full test suite)

### Harness Requirements

Existing Vitest harness only; no setup required. The dispatcher suite's mocks (`makeTurn`, `makeMockAgentManager`, breaker `stateFor` stubs) already cover the gate.

### Non-Required Rationale (only for not-required groups)

- **Integration:** the dispatcher outage suite already exercises the full dispatch→convert→gate→queue path in-process with mocked stores/adapters — that *is* this repo's integration surface for the gate, and it lives in the unit group above. Breaker consumption of `turn-deadline` (no trip, no streak reset, no probe close) is pre-existing behavior already covered by `provider-circuit-breaker`'s own suite and is explicitly out of scope (spec Non-Goals: zero breaker edits).
- **E2E:** the change is a pure classification function plus one boolean gate; no channel, process, or vendor boundary changes. Reproducing a real 300s deadline abort end-to-end would add wall-clock minutes for no discrimination beyond the unit rows.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Negative-verify (repo convention, `feedback_negative_verify_regression_tests`):** the new classifier rows and the new dispatcher row must each be shown to FAIL against pre-fix source before their commit lands. Exact stash-free mechanisms are written into Tasks 2 and 3 — **never use `git stash`** (shared stash stack across worktrees is forbidden in this repo).

---

## Task 1: Classifier — `TurnFaultInput` extension, progress predicate, rule-1 split

**Files:**
- Modify: `src/agents/provider-adapters/error-classification.ts` (kind comments L20+L25; `TurnFaultInput` L28-32; rule-list doc comment + `classifyTurnResult` L135-153)
- Test: none in this task (existing suite must stay green; new tests are Task 2)

- [ ] **Step 1:** Extend `TurnFaultInput` with the three optional progress fields. Edit `src/agents/provider-adapters/error-classification.ts` — replace:

```ts
export interface TurnFaultInput {
  error?: string; // RunResult.error
  timedOut?: boolean; // RunResult.timedOut (KPR-306)
  aborted?: boolean; // RunResult.aborted
}
```

with:

```ts
export interface TurnFaultInput {
  error?: string; // RunResult.error
  timedOut?: boolean; // RunResult.timedOut (KPR-306)
  aborted?: boolean; // RunResult.aborted
  // KPR-398: per-turn progress evidence (RunResult field names, verbatim, so
  // full-RunResult callers are structurally assignable with no call-site
  // edits). Consulted ONLY inside the timedOut && aborted rule; absent fields
  // are fail-closed (no progress ⇒ hard timeout — a narrowed caller keeps
  // pre-KPR-398 behavior).
  toolCalls?: number;
  streamed?: boolean;
  text?: string;
}
```

- [ ] **Step 2:** Update the two affected `ProviderFaultKind` member comments. In the same file, replace:

```ts
  | "timeout" // runner deadline fired (RunResult.timedOut)
```

with:

```ts
  | "timeout" // runner deadline fired with ZERO observed progress — the hang signature (KPR-398)
```

and replace:

```ts
  | "turn-deadline" // Lane B wall-clock deadline expiry — breaker-INCONCLUSIVE (see TURN_DEADLINE_SUBTYPE)
```

with:

```ts
  | "turn-deadline" // deadline expiry with proof the provider responded — breaker-INCONCLUSIVE. Lane B sentinel (see TURN_DEADLINE_SUBTYPE, progress-blind) + Claude-lane deadline abort with observed progress (KPR-398)
```

- [ ] **Step 3:** Add `hasObservedProgress` and split rule 1. In the same file, replace the entire doc comment + function (currently L135-153):

```ts
/**
 * Classify a finished turn's RunResult. Order (first match wins):
 *  1. timedOut && aborted  → timeout fault (the deadline path sets both;
 *     requiring both is belt-and-suspenders on top of the runner-side
 *     activeQuery guard, which is the primary fix).
 *  2. aborted (alone)      → aborted (neutral — never reached a
 *     provider-attributable outcome).
 *  3. no error             → success.
 *  4. pattern tables       → fault kind.
 *  5. default              → non-provider (fail-safe).
 */
export function classifyTurnResult(input: TurnFaultInput): TurnClassification {
  if (input.timedOut === true && input.aborted === true) {
    return { outcome: "fault", kind: "timeout", message: input.error ?? "turn deadline exceeded" };
  }
  if (input.aborted === true) return { outcome: "aborted" };
  if (!input.error) return { outcome: "success" };
  return classifyErrorString(input.error);
}
```

with:

```ts
/** KPR-398: proof the provider responded THIS turn. Any one signal suffices;
 * all three absent is indistinguishable from a hung provider. */
function hasObservedProgress(input: TurnFaultInput): boolean {
  return (input.toolCalls ?? 0) > 0 || input.streamed === true || (input.text?.length ?? 0) > 0;
}

/**
 * Classify a finished turn's RunResult. Order (first match wins):
 *  1. timedOut && aborted  → deadline abort (the deadline path sets both;
 *     requiring both is belt-and-suspenders on top of the runner-side
 *     activeQuery guard, which is the primary fix). KPR-398 splits this rule
 *     on observed progress: with progress (toolCalls > 0 | streamed | text
 *     nonempty) → the breaker-INCONCLUSIVE turn-deadline kind; zero or
 *     absent progress → the hard timeout kind (the hang signature —
 *     fail-closed, so a caller passing a narrowed input keeps pre-KPR-398
 *     behavior).
 *  2. aborted (alone)      → aborted (neutral — never reached a
 *     provider-attributable outcome; progress fields are never consulted).
 *  3. no error             → success.
 *  4. pattern tables       → fault kind.
 *  5. default              → non-provider (fail-safe).
 */
export function classifyTurnResult(input: TurnFaultInput): TurnClassification {
  if (input.timedOut === true && input.aborted === true) {
    // KPR-398: the Claude runner's own deadline sets BOTH flags
    // (agent-runner.ts deadline timer → abort()), so this shape covers two
    // very different turns. Observed progress = the provider responded this
    // turn ⇒ the same breaker-INCONCLUSIVE turn-deadline kind Lane B's
    // sentinel gets (never trips, never resets a streak, never closes a
    // probe). Zero progress = the hang signature ⇒ hard timeout, so a
    // genuinely hung provider still trips the breaker. Fail-closed on
    // absent fields.
    if (hasObservedProgress(input)) {
      return {
        outcome: "fault",
        kind: "turn-deadline",
        message:
          input.error ??
          `turn deadline exceeded with progress (toolCalls=${input.toolCalls ?? 0}, streamed=${input.streamed === true}, textLen=${input.text?.length ?? 0})`,
      };
    }
    return { outcome: "fault", kind: "timeout", message: input.error ?? "turn deadline exceeded" };
  }
  if (input.aborted === true) return { outcome: "aborted" };
  if (!input.error) return { outcome: "success" };
  return classifyErrorString(input.error);
}
```

- [ ] **Step 4:** Verify — format, typecheck, and confirm the *existing* suite is untouched-green (the L18-29 rows pass because absent progress fields fail closed to `timeout`):

```bash
cd /Users/mokie/github/lane-kpr-398-mature
npx prettier --write src/agents/provider-adapters/error-classification.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts
```

Expected: typecheck clean; all existing error-classification tests pass (0 failures).

- [ ] **Step 5:** Commit:

```bash
cd /Users/mokie/github/lane-kpr-398-mature
git add src/agents/provider-adapters/error-classification.ts
git commit -m "fix(classifier): deadline abort with observed progress classifies breaker-inconclusive turn-deadline (KPR-398)

Rule-1 split: timedOut && aborted with toolCalls>0 | streamed | text nonempty
is proof the provider responded — reuse the existing turn-deadline kind (Lane
B precedent). Zero/absent progress keeps hard timeout (hang signature,
fail-closed). TurnFaultInput gains three optional RunResult-named fields;
agent-manager's full-RunResult breaker feed picks them up structurally.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 2: Classifier tests — both directions, fail-closed pin, negative pins, negative-verify

**Files:**
- Modify: `src/agents/provider-adapters/error-classification.test.ts` (annotate L18-29 row; append new describe block after the KPR-350 describe at end of file)

- [ ] **Step 1:** Re-annotate the existing precedence row as the KPR-398 fail-closed pin — assertions stay byte-identical (spec §Tests row 5: "kept verbatim ... do not weaken"). Replace:

```ts
  it("classifies timedOut + aborted as a timeout fault (precedence over aborted)", () => {
    expect(classifyTurnResult({ timedOut: true, aborted: true })).toEqual({
```

with:

```ts
  it("classifies timedOut + aborted as a timeout fault (precedence over aborted)", () => {
    // KPR-398 fail-closed pin: progress fields ABSENT ⇒ no progress ⇒ hard
    // timeout. A caller passing a narrowed input keeps pre-KPR-398 behavior.
    // Do not weaken this row.
    expect(classifyTurnResult({ timedOut: true, aborted: true })).toEqual({
```

- [ ] **Step 2:** Append the new describe block at the end of `src/agents/provider-adapters/error-classification.test.ts` (after the closing `});` of the `KPR-350 §D3` describe):

```ts

describe("KPR-398 — deadline abort with observed progress", () => {
  // New direction: a deadline abort with proof the provider responded this
  // turn classifies the breaker-INCONCLUSIVE turn-deadline kind, never the
  // streak-counting hard timeout.
  it("incident shape (toolCalls=46, streamed, empty text) classifies turn-deadline — never hard", () => {
    const c = classifyTurnResult({ timedOut: true, aborted: true, toolCalls: 46, streamed: true, text: "" });
    expect(c).toMatchObject({ outcome: "fault", kind: "turn-deadline" });
    expect(c.outcome === "fault" && HARD_FAULT_KINDS.has(c.kind)).toBe(false);
  });

  it.each([
    ["toolCalls alone", { toolCalls: 1, streamed: false, text: "" }],
    ["streamed alone", { toolCalls: 0, streamed: true, text: "" }],
    ["text alone", { toolCalls: 0, streamed: false, text: "partial reply" }],
  ] as const)("each signal is independently sufficient: %s", (_label, progress) => {
    expect(classifyTurnResult({ timedOut: true, aborted: true, ...progress })).toMatchObject({
      outcome: "fault",
      kind: "turn-deadline",
    });
  });

  it("with-progress message embeds deterministic evidence (telemetry-distinguishability pin)", () => {
    // Distinguishes a claude with-progress deadline from both the old hard
    // "turn deadline exceeded" and Lane B's bare error_turn_deadline sentinel
    // in lastFaultMessage / hive doctor.
    expect(
      classifyTurnResult({ timedOut: true, aborted: true, toolCalls: 46, streamed: true, text: "" }),
    ).toEqual({
      outcome: "fault",
      kind: "turn-deadline",
      message: "turn deadline exceeded with progress (toolCalls=46, streamed=true, textLen=0)",
    });
  });

  // Preserved direction: zero progress is the hang signature.
  it("explicit zero-progress deadline abort keeps classifying hard timeout", () => {
    expect(
      classifyTurnResult({ timedOut: true, aborted: true, toolCalls: 0, streamed: false, text: "" }),
    ).toEqual({ outcome: "fault", kind: "timeout", message: "turn deadline exceeded" });
  });

  // Negative pins: progress fields are consulted ONLY inside rule 1 and must
  // not create new outcomes anywhere else.
  it("aborted-only input stays neutral aborted regardless of progress", () => {
    expect(classifyTurnResult({ aborted: true, toolCalls: 46, streamed: true })).toEqual({
      outcome: "aborted",
    });
  });

  it("plain error-string input ignores progress fields (pattern tables unchanged)", () => {
    expect(classifyTurnResult({ error: "429 Too Many Requests", toolCalls: 46 })).toMatchObject({
      outcome: "fault",
      kind: "rate-limit",
    });
  });

  it("no flags, no error, with progress → success", () => {
    expect(classifyTurnResult({ toolCalls: 46, streamed: true })).toEqual({ outcome: "success" });
  });

  it("Lane B sentinel shape stays progress-blind turn-deadline (short-circuit unchanged)", () => {
    expect(
      classifyTurnResult({ error: TURN_DEADLINE_SUBTYPE, timedOut: true, aborted: false, toolCalls: 0 }),
    ).toEqual({ outcome: "fault", kind: "turn-deadline", message: TURN_DEADLINE_SUBTYPE });
  });
});
```

(Spec §Tests row 10 — the `HARD_FAULT_KINDS` membership pin — already exists at L147-154 and needs no edit; it must continue asserting exactly `{auth, connect-fail, rate-limit, server-error, timeout}` with `turn-deadline` out.)

- [ ] **Step 3:** Verify green on fixed code:

```bash
cd /Users/mokie/github/lane-kpr-398-mature
npx prettier --write src/agents/provider-adapters/error-classification.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts
```

Expected: all tests pass, including the new `KPR-398 — deadline abort with observed progress` block.

- [ ] **Step 4:** Negative-verify (repo convention — NO `git stash`). Task 1's commit is `HEAD`; revert only the classifier source in the working tree by reverse-applying that commit's diff for the one file, run the suite (Vitest strips types via esbuild, so the reverted narrower `TurnFaultInput` does not block execution), then restore:

```bash
cd /Users/mokie/github/lane-kpr-398-mature
git diff HEAD~1 HEAD -- src/agents/provider-adapters/error-classification.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts
```

Expected: **failures confined to the new KPR-398 describe block** — at minimum the incident-shape test, the three per-signal rows, and the message pin fail on pre-fix code (each classifies hard `timeout` instead of `turn-deadline`). Every pre-existing test still passes. If the new rows do NOT fail here, stop — the tests are not pinning the behavior change; fix the tests.

Restore the fixed source and confirm only the test file remains modified:

```bash
git checkout HEAD -- src/agents/provider-adapters/error-classification.ts
git status --short
```

Expected `git status --short` output: exactly ` M src/agents/provider-adapters/error-classification.test.ts`.

Re-run the suite once more to confirm green post-restore:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts
```

- [ ] **Step 5:** Commit:

```bash
cd /Users/mokie/github/lane-kpr-398-mature
git add src/agents/provider-adapters/error-classification.test.ts
git commit -m "test(classifier): KPR-398 progress-split pins — both directions, fail-closed, negative pins

Negative-verified: with the rule-1 split reverse-applied, the incident-shape,
per-signal, and message-pin rows fail (classify hard timeout on pre-fix code);
all pre-existing rows pass either way.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 3: Dispatcher outage-gate reconciliation + dispatcher tests

**Files:**
- Modify: `src/channels/dispatcher.ts` (doc comment L540-550; gate body L566-573)
- Test: `src/channels/dispatcher.test.ts` (outage-interception describe — annotate rows at L1221/L1234, insert one new row after L1243)

- [ ] **Step 1:** Replace the `maybeHandlePostTurnOutage` doc comment. In `src/channels/dispatcher.ts`, replace:

```ts
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
```

with:

```ts
  /**
   * §7.2 second classification leg (post-turn gate): the turn COMPLETED but
   * the provider's breaker is open. Fires only when the FULL RunResult
   * classifies into HARD_FAULT_KINDS (KPR-398: the classifier consults
   * toolCalls/streamed/text inside its timedOut && aborted rule — a
   * zero-progress hang classifies hard `timeout` and queues here; a
   * with-progress deadline abort classifies breaker-inconclusive
   * `turn-deadline` and follows the LEGACY path, because it by definition
   * executed tools or streamed and a partially-executed tool turn's side
   * effects must not be silently re-run — the same Finding 4 r1 rationale
   * that keeps `non-provider` classifications out of the queue). The former
   * redundant `timedOut && aborted` hangTimeout arm is deleted: rule 1
   * classifies that shape as a fault irrespective of `error`, so hardFault
   * alone covers exactly what it caught; the Finding 3 r2 concern (runner-
   * deadline timeouts leave `error` unset, so `errors` alone never fires)
   * lives in the cheap-exit condition below, which still admits error-less
   * timedOut turns. Gated on snapshot.enabled so shadow mode stays fully
   * observational.
   */
```

- [ ] **Step 2:** Reconcile the gate body. In the same file, replace:

```ts
    const classification = classifyTurnResult({
      error: runResult.error,
      timedOut: runResult.timedOut,
      aborted: runResult.aborted,
    });
    const hardFault = classification.outcome === "fault" && HARD_FAULT_KINDS.has(classification.kind);
    const hangTimeout = runResult.timedOut === true && runResult.aborted === true;
    if (!hardFault && !hangTimeout) return false;
```

with:

```ts
    // KPR-398: full RunResult — structurally carries toolCalls/streamed/text.
    const classification = classifyTurnResult(runResult);
    const hardFault = classification.outcome === "fault" && HARD_FAULT_KINDS.has(classification.kind);
    if (!hardFault) return false;
```

(`convertTurnResult` at `dispatcher.ts:384-412` already maps `toolCalls`/`streamed`/`text: turn.finalMessage` faithfully — verified in the spec; no conversion edits.)

- [ ] **Step 3:** Annotate the two preserved zero-progress rows and add the new with-progress row in `src/channels/dispatcher.test.ts`. Replace:

```ts
  it("★ timeout gate: timedOut && aborted with breaker open → outage path even with empty errors", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
```

with:

```ts
  it("★ timeout gate: timedOut && aborted with breaker open → outage path even with empty errors", async () => {
    // KPR-398 zero-progress pin: fixture defaults toolCalls: 0 / streamed:
    // false plus finalMessage "" = the hang signature — classifies hard
    // timeout and still queues.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
```

and replace:

```ts
  it("★ timedOut with breaker closed → legacy path, unqueued", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
```

with:

```ts
  it("★ timedOut with breaker closed → legacy path, unqueued", async () => {
    // KPR-398 zero-progress pin (see the open-breaker row above).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
```

Then insert the new row immediately after the closing `});` of the `"★ timedOut with breaker closed → legacy path, unqueued"` test (before `it("sched: turns skip with a log — never queued, never noticed", ...)`):

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

- [ ] **Step 4:** Verify green on fixed code:

```bash
cd /Users/mokie/github/lane-kpr-398-mature
npx prettier --write src/channels/dispatcher.ts src/channels/dispatcher.test.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected: typecheck clean; all dispatcher tests pass, including the new KPR-398 row and the two preserved ★ rows.

- [ ] **Step 5:** Negative-verify the new dispatcher row (NO `git stash` — the dispatcher source change is still uncommitted, so save its diff to a temp patch, reverse-apply, test, re-apply):

```bash
cd /Users/mokie/github/lane-kpr-398-mature
PATCH_DIR="$(mktemp -d)"
git diff -- src/channels/dispatcher.ts > "$PATCH_DIR/kpr398-dispatcher.patch"
git apply -R "$PATCH_DIR/kpr398-dispatcher.patch"
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected: exactly one failure — `★ KPR-398: with-progress deadline turn with breaker open → legacy path, never queued` (on pre-fix gate code the narrowed input classifies hard `timeout`, so the turn is queued and the notice delivered). The two ★ zero-progress rows and all other rows still pass. If the new row does not fail, stop and fix the test.

Restore and confirm green:

```bash
git apply "$PATCH_DIR/kpr398-dispatcher.patch"
rm -rf "$PATCH_DIR"
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
git status --short
```

Expected: all dispatcher tests pass; `git status --short` shows exactly ` M src/channels/dispatcher.ts` and ` M src/channels/dispatcher.test.ts`.

- [ ] **Step 6:** Commit:

```bash
cd /Users/mokie/github/lane-kpr-398-mature
git add src/channels/dispatcher.ts src/channels/dispatcher.test.ts
git commit -m "fix(dispatcher): post-turn outage gate classifies the full RunResult; drop redundant hangTimeout arm (KPR-398)

The narrowed {error, timedOut, aborted} literal stripped the progress fields
and the hangTimeout bypass would queue a with-progress deadline turn into
outage_queue — silently re-running a partially-executed tool turn's side
effects (the gate's own Finding 4 r1 hazard). hardFault alone now covers the
zero-progress hang shape (rule 1 classifies it hard timeout regardless of
error). Negative-verified: with the gate change reverse-applied, the new
with-progress row fails (turn queued); zero-progress ★ pins pass either way.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 4: Final verification — full quality gate

**Files:** none (verification only)

- [ ] **Step 1:** Run the complete repo gate with the required env stubs:

```bash
cd /Users/mokie/github/lane-kpr-398-mature
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: all four gates green — typecheck (tsc, no errors), lint (eslint, no errors), format (prettier --check, no diffs), test (vitest, 0 failures — including the untouched `provider-circuit-breaker` suite, whose `turn-deadline` consumption arms this change relies on but never edits).

- [ ] **Step 2:** Confirm scope containment — the branch diff touches exactly four files, none of them the breaker, Lane B adapters, agent-manager, agent-runner, or `docs/providers.md` (spec Non-Goals + A4):

```bash
cd /Users/mokie/github/lane-kpr-398-mature
git diff --stat HEAD~3 HEAD -- ':!docs'
```

Expected: exactly `src/agents/provider-adapters/error-classification.ts`, `src/agents/provider-adapters/error-classification.test.ts`, `src/channels/dispatcher.ts`, `src/channels/dispatcher.test.ts`.

- [ ] **Step 3:** No commit (verification-only task). Do not push, do not open a PR — that is the submit lane's job.

---

## Plan-review advisories (r1, verbatim — implementer notes, not deviations)

- [Task 2, Step 2]: the `it.each` destructures `_label` unused — if the repo's ESLint config lacks `argsIgnorePattern: "^_"`, `npm run check` (Task 4) flags it; trivially fixable at that gate.
- [Task 3, Step 3]: the new row's `makeTurn({...})` line exceeds typical print width; the Step 4 `prettier --write` will rewrap it before commit — implementer should not treat the reflow as a deviation.
