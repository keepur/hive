# KPR-413 — Deadline-continuation legs must not re-wrap the assembled conference payload — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** A conference turn's deadline-continuation leg carries the turn's own frame (preamble + terminal slot) and no conference meta, never the assembled transcript — on both reachable dispatch legs (fan-out round-0, single-dispatch outage replay) — eliminating the N-copies transcript duplication this epic exists to fix.

**Architecture:** Two changes in `src/channels/dispatcher.ts`. D1: at the one conference-assembly site (`dispatchToAgent`'s conference branch), stamp `meta.deadlineOriginalText` with the turn's own frame (preamble + terminal slot, transcript arm empty) — `maybeHandleDeadlineAbort` already prefers this meta key over `item.text` when present, so no change is needed at the arm's read site, and the stamp rides into the outage store so a replayed conference turn's later abort is honest too. D2: at the continuation-leg meta builder, strip the four conference meta keys (`conferenceMode`, `conferenceRound`, `conferenceHumanTs`, `conferenceInjectionMode`) alongside the existing `outageReplay` strip, since a continuation leg computes no injection and never re-enters conference resolution.

**Tech Stack:** TypeScript, Vitest.

**Plan-review r1 verification note:** every code block in this plan (D1, D2, and all six new/extended test cases) was applied directly to this worktree and run, not just reasoned about — `npx vitest run src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts` passed 174/174, `npm run check` passed clean (3282 tests, exit 0), and each negative-verify in Task 2 Step 7 (D1 alone reverted, D2 alone reverted, D5 reordered after the arm for T4, T5's fixture-level revert) was actually performed and failed for the stated reason. The exploratory changes were then discarded (`git checkout --`) so the deliver-ticket lane's implementer redoes the work fresh per the plan text below, per the mature/deliver lane separation — but every step below is now empirically de-risked, not merely plausible.

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `dispatchToAgent`'s conference-assembly branch and `maybeHandleDeadlineAbort`'s continuation-leg builder, in `src/channels/dispatcher.ts`
  - Reason: pure in-process prompt/meta assembly logic with mocked dependencies (classifier, Slack adapter, delivery adapter, agent manager) — no real I/O; the existing `dispatcher-conference.test.ts` and `dispatcher.test.ts` suites already exercise this exact shape
  - Minimum assertions: (1) a round-0 conference turn's continuation leg text is the turn's own frame, not the composite, and does not contain the transcript marker; (2) the leg's meta has no conference keys; (3) the chain does not nest (leg 2 wraps the same frame as leg 1, never leg 1's wrap); (4) round-1 reactors remain unreachable through this arm (ordering pin); (5) the single-dispatch outage-replay leg for a conference turn gets the same treatment

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

- A round-0 conference turn that burns its per-turn deadline continues with a leg that reads coherently to the receiving agent (it knows it's in a meeting, who's present, not to re-orient with tools, how to decline) but carries no duplicate transcript and no dishonest conference telemetry stamp.
- The same holds when that turn was itself an outage-queue replay (breaker was open, turn re-dispatched from the queue, then deadline-aborts).

### Regression Surface

- `dispatcher.test.ts`'s `deadline-abort continuation (KPR-402)` describe (non-conference rows, including the T1 fallback-to-`item.text` row at `:1742`, the chain-nesting row at `:1905-1920`, and the fan-out dedup/notice rows around `:2014`) must all stay green — the fix touches the arm's meta construction, not its non-conference-item behavior, and must not regress it.
- `dispatcher-conference.test.ts`'s `round-1 kill suppression (KPR-389 D5)` describe (the `it.each` this plan extends) and the byte-exact round-0 prompt pin (C6) must both stay green — the fix adds a meta key, never a prompt byte.
- `dispatcher-conference.test.ts`'s "outage-queued turn never touches the mark" test (`:911-935`, the one existing test in that file that arms `setOutageHandling`) must stay green and must not leak its outage wiring into the new describe — the outer `beforeEach` rebuilds `dispatcher`/`agentManager` per test, so this is structural, but worth confirming explicitly.

### Commands

- Unit: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts`
- Integration: not-applicable
- E2E: not-applicable
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (typecheck + lint + format + full suite, before pre-PR review)

### Harness Requirements

- None beyond the two target test files' existing mock wiring (classifier mock, Slack adapter mock, delivery adapter, agent manager mock). No new mocks, fixtures, or env vars — this plan lifts three existing block-scoped fixtures to a shared scope (see Task 2) rather than introducing new ones.

### Non-Required Rationale

- Integration: the fix is fully contained inside `dispatcher.ts`'s prompt/meta assembly, exercised end-to-end by the existing unit-level mocked suites (which already simulate the full `dispatch()` → `dispatchToAgent`/`maybeHandleDeadlineAbort` → `runWorkItemTurn` → deliver chain with mocked boundaries). No real Slack, DB, or provider call is needed to prove the fix.
- E2E: no user-facing flow changes beyond what a conference participant sees in Slack (a shorter, honest continuation instead of a duplicated one) — not independently testable at the E2E tier beyond what the unit suite already proves about the text/meta shape.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

- `src/channels/dispatcher.ts` — D1 (conference-assembly branch, ~line 1335-1349) and D2 (continuation-leg builder, ~line 831). Both edits are localized to `dispatchToAgent` and `maybeHandleDeadlineAbort`; no new file.
- `src/channels/dispatcher-conference.test.ts` — lift `PREAMBLE` to shared scope (Task 2 Step 1), then a new nested `describe` (T1, T2, T2b, T3) inside `round-1 kill suppression (KPR-389 D5)`, plus one new assertion + one new `it.each` case in the existing round-1 test (T4).
- `src/channels/dispatcher.test.ts` — one new row in the `deadline-abort continuation (KPR-402)` describe (T5).

## Task 1: D1 + D2 — the fix

**Files:**
- Modify: `src/channels/dispatcher.ts:1335-1349` (D1, conference assembly)
- Modify: `src/channels/dispatcher.ts:831` (D2, continuation-leg meta builder)

- [ ] **Step 1 (D1):** Stamp `deadlineOriginalText` with the turn's own frame at conference-assembly time.

Current text (`dispatcher.ts:1335-1349`):

```typescript
      const contextPrefix = [resolved.meetingPreamble, resolved.threadContext, "---"].filter(Boolean).join("\n");
      effectiveItem = {
        ...item,
        text: `${contextPrefix}\n${newMessageSegment}`,
        meta: {
          ...item.meta,
          conferenceMode: true,
          conferenceHumanTs: resolved.conferenceHumanTs,
          conferenceRound: resolved.conferenceRound,
          // KPR-389 D1: injection mode rides along so telemetry can segment
          // full vs delta turns (KPR-388 efficacy measurement).
          conferenceInjectionMode: resolved.injectionMode,
        },
      };
```

Replace with:

```typescript
      const contextPrefix = [resolved.meetingPreamble, resolved.threadContext, "---"].filter(Boolean).join("\n");
      // KPR-413: the transcript belongs to the MEETING, not to this turn. A
      // KPR-402 continuation leg re-wraps meta.deadlineOriginalText verbatim
      // on every leg (up to MAX_DEADLINE_CONTINUATIONS), into a session that
      // KPR-399 resume already loaded with the original composite — so
      // letting the arm fall back to item.text (the assembled composite,
      // preamble + full/delta/summary transcript + terminal slot) reproduces
      // the N-copies bloat this epic exists to remove. Stamp the turn's OWN
      // frame instead: preamble + terminal slot, no injection. Byte-shaped
      // exactly like an empty-delta turn (C10), and it rides into the
      // outage store so a replayed conference turn's later abort is honest
      // too (single-dispatch leg).
      const framePrefix = [resolved.meetingPreamble, "---"].filter(Boolean).join("\n");
      effectiveItem = {
        ...item,
        text: `${contextPrefix}\n${newMessageSegment}`,
        meta: {
          ...item.meta,
          conferenceMode: true,
          conferenceHumanTs: resolved.conferenceHumanTs,
          conferenceRound: resolved.conferenceRound,
          // KPR-389 D1: injection mode rides along so telemetry can segment
          // full vs delta turns (KPR-388 efficacy measurement).
          conferenceInjectionMode: resolved.injectionMode,
          deadlineOriginalText: `${framePrefix}\n${newMessageSegment}`,
        },
      };
```

- [ ] **Step 2 (D2):** Strip conference meta keys from the continuation-leg meta, alongside the existing `outageReplay` strip.

Current text (`dispatcher.ts:818-831`):

```typescript
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
```

Replace with:

```typescript
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
    //
    // KPR-413: conference keys are stripped alongside the replay marker. A
    // continuation leg computed no injection and never re-enters conference
    // resolution (targetAgentId routes it through resolveAgents step 0,
    // which precedes the conf-* check at step 0.7), so inheriting
    // conferenceMode/Round/HumanTs/InjectionMode would stamp a
    // non-conference turn as a conference turn with an injection mode it
    // never used — corrupting both C18 measurement surfaces
    // (agent_turn_telemetry, activity_log). Same shape as C26's `worker:`
    // re-entry: an engine-authored re-dispatch into a meeting thread is an
    // ordinary turn. This deliberately reverses KPR-402's own stated
    // rationale (kpr-402-spec.md:359-362) that conference keys are
    // load-bearing for routing — verified false for this codebase: routing
    // is targetAgentId, not any conference meta key. Still a blocklist, not
    // an allowlist — channel keys (slackThreadTs etc.) stay.
    const {
      outageReplay: _replayMarker,
      conferenceMode: _confMode,
      conferenceRound: _confRound,
      conferenceHumanTs: _confHumanTs,
      conferenceInjectionMode: _confInjectionMode,
      ...carriedMeta
    } = item.meta ?? {};
```

`deadlineOriginalText` is read from `item.meta` directly (not from `carriedMeta`) a few lines below and re-stamped explicitly into the leg's meta, so the destructure order above is immaterial and the chain round-trip (T9, `dispatcher.test.ts`) is unaffected by this change.

**Expected lint noise (harmless, do not "fix"):** the four new destructured-and-discarded bindings (`_confMode`, `_confRound`, `_confHumanTs`, `_confInjectionMode`) each produce an `@typescript-eslint/no-unused-vars` **warning**, matching the pre-existing `_replayMarker` warning immediately above them in the same destructure. `npm run check` stays green — ESLint warnings are not errors and don't fail the gate. Do not rename these to suppress the warning or restructure the destructure to avoid it; the underscore-prefix pattern is this file's established idiom for "strip and discard."

- [ ] **Step 3:** Verify the file still typechecks.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4:** Commit.

```bash
git add src/channels/dispatcher.ts
git commit -m "fix(kpr-413): deadline-continuation legs carry the turn's own frame, not the conference transcript

A KPR-402 continuation leg re-wraps meta.deadlineOriginalText
verbatim on every leg (up to MAX_DEADLINE_CONTINUATIONS), and on a
conference turn that value fell back to item.text — the full
assembled composite (preamble + injected transcript + terminal slot)
— reproducing the N-copies transcript-duplication pathology this
epic's own Gate 1 diagnosis names, into a session KPR-399 resume
already loaded with copy #1.

D1: stamp deadlineOriginalText with the turn's own frame (preamble +
terminal slot, no transcript) at the one conference-assembly site —
the arm already prefers this meta key over item.text, so no change
is needed at the read site, and the stamp rides into the outage store
so a replayed conference turn's later abort is honest too.

D2: strip conferenceMode/Round/HumanTs/InjectionMode from the
continuation leg's meta alongside the existing outageReplay strip — a
leg computes no injection and never re-enters conference resolution,
so inheriting those keys corrupted both C18 measurement surfaces
(agent_turn_telemetry, activity_log) with a claim the leg never
earned. This deliberately reverses KPR-402's own stated rationale
that conference keys are load-bearing for routing (kpr-402-spec.md:
359-362) — verified false: routing is targetAgentId alone.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Task 2: Regression tests

**Files:**
- Modify: `src/channels/dispatcher-conference.test.ts` (`PREAMBLE` lift + import + new describe T1-T2b-T3 + T4 extension)
- Modify: `src/channels/dispatcher.test.ts` (T5)

**Revision note (plan-review r1):** round 1 applied this plan's original test code to the live worktree and ran it. Two mock-wiring bugs surfaced: T1/T2/T3's leading `.mockResolvedValueOnce(turn())` assumed a separate "origin succeeds, then a later call aborts" shape that doesn't exist for `soloClassifier()` (only one turn is ever dispatched per abort event — the ORIGIN call itself is what aborts), and T4 extended an `it.each` row that has zero tool calls, so it never reaches the "with progress" branch that redispatches at all, making the added assertion pass regardless of ordering. Both are fixed below (verified empirically by the reviewer, including the negative-verify reorder). The `turn()`/`settleReactions()` lift from round 1's Step 1 was also dead work — both are already in closure scope where the new describe nests — and is removed; only `PREAMBLE` (now load-bearing for T1's restored byte-exact assertion) plus the `deadlineContinuationWrap`/`MAX_DEADLINE_CONTINUATIONS` import are lifted/added.

- [ ] **Step 1: Lift `PREAMBLE` to shared scope; import `deadlineContinuationWrap` and `MAX_DEADLINE_CONTINUATIONS`.**

`PREAMBLE` (`:678`) is block-scoped inside the sibling `describe("delta context injection (KPR-388)", ...)` (`:674+`), where the new T1/T2b describe (nested inside `round-1 kill suppression (KPR-389 D5)`, `:557-672`) cannot reach it. Move its definition to the outer `describe("Conference channel routing", ...)` scope (starting `:208`, after the `beforeEach` ending `:227`), following the existing hoist precedent for `soloClassifier()` at `:229-230` ("Hoisted out of the delta describe (KPR-389 T8 needs it too — it only touches the classifier mock)") — mirror that comment's shape. `turn()` and `settleReactions()` need **no lift** — both are already defined inside `round-1 kill suppression`, the same describe the new tests nest inside.

Add to this file's imports (find the existing `import` block at the top and add a new one, or extend an existing import from `./deadline-continuation.js` if one already exists — check first; this file lives in `src/channels/`, so the relative path is `./deadline-continuation.js`, not `../channels/...`):

```typescript
import { deadlineContinuationWrap, MAX_DEADLINE_CONTINUATIONS } from "./deadline-continuation.js";
```

- [ ] **Step 2:** Run the file to confirm the lift and import alone break nothing.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts`
Expected: all existing tests still pass (same count as before) — the lift is a pure scope move, zero behavior change; the import is unused until Step 3 adds its consumer (an unused-import lint warning at this intermediate point is expected and self-resolves once Step 3 lands — do not treat it as a blocker mid-step).

- [ ] **Step 3: Add the new describe (T1, T2, T2b, T3) inside `round-1 kill suppression (KPR-389 D5)`.**

Add a new nested describe as the last member of `describe("round-1 kill suppression (KPR-389 D5)", () => { ... })` (`:557-672`), immediately before that describe's closing `});` at `:672`. Uses `soloClassifier()` (already in scope, hoisted at `:229`), a minimal one-message inline history (the mock factory's `fetchThreadHistory` defaults to `mockResolvedValue([])`, `:200` — a non-empty override is required so the pre-fix composite actually contains a transcript). **Mock wiring, corrected:** the ORIGIN turn itself is what deadline-aborts — there is no separate prior "succeeds" call for `soloClassifier()`'s single-agent round-0 path — so T1/T2/T2b use exactly ONE `.mockResolvedValueOnce(...)` shaped as the abort-with-progress `turn()`, and the continuation leg's own `runWorkItemTurn` call falls through to the mock factory's default (a healthy `turn()`-shaped success, ending the chain at one leg). T3 (which needs two legs) uses `.mockResolvedValue(...)` (persistent, not `Once`) so origin AND leg 1 both abort with progress, and leg 2 hits the `MAX_DEADLINE_CONTINUATIONS` cap. `agentManager.runWorkItemTurn.mock.calls[N][1]` is the confirmed pattern for extracting the dispatched `WorkItem` (e.g. `:264`, `:349`, `:512`, `:731`).

```typescript
      describe("deadline-continuation legs carry the turn's own frame, not the conference transcript (KPR-413)", () => {
        const ONE_MSG_HISTORY = () => [
          {
            author: "May",
            text: "earlier meeting context",
            timestamp: new Date(Date.now() - 5 * 60_000),
            isBot: false,
            ts: "1000.0001",
          },
        ];
        const ABORT_WITH_PROGRESS = turn({
          finalMessage: "",
          timedOut: true,
          aborted: true,
          toolCalls: 46,
          streamed: true,
        });

        it("T1: continuation text is the turn's frame, not the composite (byte-exact)", async () => {
          await soloClassifier();
          const threadId = "conf-thread-kpr413-t1";
          mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
          agentManager.runWorkItemTurn.mockResolvedValueOnce(ABORT_WITH_PROGRESS);

          const item = makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr413" },
            threadId,
            meta: { slackTs: "1000.0004" },
          });
          await dispatcher.dispatch(item);
          await settleReactions();

          const expectedFrame = `${PREAMBLE("conf-kpr413", "Jasper")}\n---\n[New message]:\n${item.text}`;
          const secondCallItem = agentManager.runWorkItemTurn.mock.calls[1][1];
          expect(secondCallItem.text).toBe(deadlineContinuationWrap(expectedFrame, 1, MAX_DEADLINE_CONTINUATIONS + 1));
        });

        it("T2: continuation leg carries no conference meta", async () => {
          await soloClassifier();
          const threadId = "conf-thread-kpr413-t2";
          mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
          agentManager.runWorkItemTurn.mockResolvedValueOnce(ABORT_WITH_PROGRESS);

          await dispatcher.dispatch(
            makeWorkItem({
              text: "Jasper, status update?",
              source: { kind: "slack", id: "C-CONF", label: "conf-kpr413" },
              threadId,
              meta: { slackTs: "1000.0004" },
            }),
          );
          await settleReactions();

          const secondCallItem = agentManager.runWorkItemTurn.mock.calls[1][1];
          expect(secondCallItem.meta.deadlineRetry).toBe(1);
          expect(secondCallItem.meta.targetAgentId).toBeDefined();
          expect(secondCallItem.meta.deadlineOriginalText).not.toContain("[Meeting thread in #");
          expect(secondCallItem.meta.conferenceMode).toBeUndefined();
          expect(secondCallItem.meta.conferenceRound).toBeUndefined();
          expect(secondCallItem.meta.conferenceHumanTs).toBeUndefined();
          expect(secondCallItem.meta.conferenceInjectionMode).toBeUndefined();
        });

        it("T2b: the stamp is written at assembly time, on the ORIGIN turn's own dispatch — independent of whether an abort ever happens", async () => {
          // Direct pin for D1 itself (plan-review r1 finding): T1/T2 only
          // prove the ARM's output; this proves the stamp exists on every
          // conference turn's dispatch args unconditionally, which is also
          // what makes the outage-store replay case (T5) sound — the store
          // serializes this same effectiveItem.
          await soloClassifier();
          const threadId = "conf-thread-kpr413-t2b";
          mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
          agentManager.runWorkItemTurn.mockResolvedValueOnce(turn()); // healthy — no abort at all

          await dispatcher.dispatch(
            makeWorkItem({
              text: "Jasper, status update?",
              source: { kind: "slack", id: "C-CONF", label: "conf-kpr413" },
              threadId,
              meta: { slackTs: "1000.0004" },
            }),
          );

          const originCallItem = agentManager.runWorkItemTurn.mock.calls[0][1];
          expect(originCallItem.meta.deadlineOriginalText).toContain("Meeting rules:");
          expect(originCallItem.meta.deadlineOriginalText).not.toContain("[Meeting thread in #");
        });

        it("T3: chain does not nest — every leg wraps the same frame, never a wrap-of-a-wrap", async () => {
          await soloClassifier();
          const threadId = "conf-thread-kpr413-t3";
          mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
          agentManager.runWorkItemTurn.mockResolvedValue(ABORT_WITH_PROGRESS); // persistent: origin AND leg 1 both abort

          await dispatcher.dispatch(
            makeWorkItem({
              text: "Jasper, status update?",
              source: { kind: "slack", id: "C-CONF", label: "conf-kpr413" },
              threadId,
              meta: { slackTs: "1000.0004" },
            }),
          );
          await settleReactions();
          await settleReactions();

          expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(3); // origin + 2 legs (cap)
          const leg1 = agentManager.runWorkItemTurn.mock.calls[1][1];
          const leg2 = agentManager.runWorkItemTurn.mock.calls[2][1];
          expect(leg1.id).toMatch(/#dl1$/);
          expect(leg2.id).toMatch(/#dl2$/);
          expect(leg2.meta.deadlineOriginalText).toBe(leg1.meta.deadlineOriginalText); // same frame, not leg1's wrap
          // Strengthened per plan-review r1 (this property alone holds
          // pre-fix too, by coincidence, since both legs would carry the
          // same composite either way — the marker check is what actually
          // distinguishes fixed from unfixed):
          expect(leg2.text).not.toContain("[Meeting thread in #");
        });
      });
```

- [ ] **Step 4: Extend the existing round-1 `it.each` with a third row, then add T4 (the ordering pin).**

The existing `it.each` at `:608-626` has two cases — `["aborted", { aborted: true }]` and `["timedOut", { timedOut: true, aborted: true }]` (`toolCalls: 0`, `streamed: false` by the `turn()` default) — neither reaches `maybeHandleDeadlineAbort`'s "with progress" re-dispatch branch: the `aborted`-only case fails the arm's own `timedOut !== true` gate, and the existing `timedOut` case has zero observed progress, so it takes the **zero-progress** notice-only branch, never a re-dispatch. **A third case with observed progress is required** for T4 to test anything real. Add it to the `it.each` array:

```typescript
    it.each([
      ["aborted", { aborted: true }],
      ["timedOut", { timedOut: true, aborted: true }],
      ["timedOut with progress", { timedOut: true, aborted: true, toolCalls: 46, streamed: true }],
    ])("killed round-1 reaction (%s) never delivers; mark untouched for the reactor", async (_label, flags) => {
```

(This replaces only the `it.each` array literal and the `it.each(...)(` call's first line — the test body and its existing assertions below are unchanged and must still pass for all three cases, including the new one: D5's gate checks only `resolved.conferenceRound === 1 && (aborted || timedOut || ...)`, with no dependency on `toolCalls`/`streamed`, so the existing `adapter.deliver`/`setMeetingMark` assertions hold identically for the new row.)

Then, after the existing `await settleReactions();` call (`:618`) and before the existing `expect(adapter.deliver)...` assertions, add:

```typescript
          // KPR-413 T4: pins the D5-before-deadline-abort-arm ordering
          // established at the epic's main-sync (705f9f9) — a killed round-1
          // reaction must never reach maybeHandleDeadlineAbort and produce a
          // continuation dispatch, even when it has observed progress (the
          // one case that could otherwise redispatch). Only the third
          // ("timedOut with progress") case exercises this meaningfully; the
          // other two never reach the arm's own gate regardless of D5's
          // position, so the assertion is trivially true for them.
          expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
```

- [ ] **Step 5: Add T5 in `dispatcher.test.ts`'s deadline-abort continuation describe.**

Add a new row inside `describe("deadline-abort continuation (KPR-402)", ...)` (`:1699+`), after the existing chain-nesting test around `:1905-1920`. Confirmed helper shapes: `makeTurn(overrides)` is module-level (`:1177`, outside any describe); `replayItem(overrides)` (`:1730`, inside this describe) is `slackItem({ meta: { outageReplay: true, targetAgentId: "executive-assistant" }, ...overrides })` — **a shallow spread, so `overrides.meta` fully replaces the default meta object** — the test below includes `outageReplay`/`targetAgentId` explicitly. There is no `replayWrap` helper in `dispatcher.test.ts` (a same-named function exists in `src/outage/outage-notices.ts`, applied by the real `outage-replay-processor.ts:123`, but this file's existing replay tests dispatch raw `WorkItem`s directly, bypassing that layer entirely — this test matches that established idiom rather than introducing a new one).

**What this test actually proves (plan-review r1 correction):** T5 proves **D2** on the single-dispatch leg — that conference meta is stripped from a replay-originated continuation the same way it is from a fan-out one. It does **not** independently prove D1 (that's T2b's job) — the fixture directly supplies `deadlineOriginalText` because that is what a real D1-fixed conference-assembly call would already have written into the item *before* it was ever queued (T2b proves that write happens); T5's own negative-verify is therefore at the fixture level (see Step 7), not by reverting the arm's source.

```typescript
    it("T5 (KPR-413): a replayed conference turn's continuation leg carries the stamped frame from meta, not item.text, and no conference meta", async () => {
      const composite = "[Meeting thread in #conf-x — participants: Jasper]\n---\n[New message]:\ntrigger text";
      const frame = "You are in a meeting in #conf-x with Jasper.\n\nMeeting rules:\n---\n[New message]:\ntrigger text";
      agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
      await dispatcher.dispatch(
        replayItem({
          id: "m1",
          text: composite, // must be IGNORED once meta.deadlineOriginalText is present
          meta: {
            outageReplay: true,
            targetAgentId: "executive-assistant",
            conferenceMode: true,
            conferenceRound: 0,
            conferenceHumanTs: "1000.0004",
            conferenceInjectionMode: "full",
            deadlineOriginalText: frame, // simulates the D1 stamp a real conference-assembly call already wrote
          },
        }),
      );
      const [, legItem] = agentManager.runWorkItemTurn.mock.calls[1];
      expect(legItem.text).toContain(frame);
      expect(legItem.text).not.toContain(composite);
      expect(legItem.meta.conferenceMode).toBeUndefined();
      expect(legItem.meta.conferenceRound).toBeUndefined();
      expect(legItem.meta.conferenceHumanTs).toBeUndefined();
      expect(legItem.meta.conferenceInjectionMode).toBeUndefined();
    });
```

- [ ] **Step 6:** Format, then run both target files and confirm all new rows pass.

The new code's line lengths are already `printWidth: 120`-clean at their target nesting depth (`describe(` at 6 spaces, `it(` at 8, one level deeper than the outer `describe("round-1 kill suppression (KPR-389 D5)", ...)` body's 4 spaces). Pasting the plan's code blocks in verbatim does produce a real (indentation-only) diff once run through Prettier — run `npm run format` as a mandatory step, not an optional safety net: `npm run check` runs `format:check`, which fails on any unformatted line, so format before the final check rather than after:

Run: `npm run format`
Expected: exit 0; `git diff` shows only indentation changes in the two edited test files (a genuine re-indent to match nesting depth, not a logic change) — review the diff to confirm this before proceeding.

Then:

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts`
Expected: all tests pass; `dispatcher-conference.test.ts`'s case count increases by exactly 5 over its pre-edit baseline (T1, T2, T2b, T3, plus the `it.each` gaining one case = T4's row) and `dispatcher.test.ts`'s by exactly 1 (T5) — capture baselines by running each file once before Task 1's edit if precise counts are wanted.

- [ ] **Step 7:** Negative-verify each new test fails for the right reason on pre-fix source.

**Revision note (plan-review r2):** round 2 actually performed every leg of this negative-verify by execution, not just prediction, and found the D1-revert predictions below were written from reasoning rather than observation — two were wrong. Corrected below; the D2-revert, T4-reorder, and T5-fixture legs were confirmed exactly as originally written.

For T1/T2/T2b/T3 (dispatcher-conference.test.ts): temporarily revert Task 1 Step 1 (D1) only — remove the `framePrefix` line and the `deadlineOriginalText` key from the conference-assembly meta — and re-run:

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts -t "KPR-413"`
Expected (verified by execution): **all four fail.** T1 fails on the byte-exact equality (`originalText` falls back to the composite `item.text`, which contains the transcript header the expected frame does not). T3's `not.toContain` assertion fails (both legs now carry the composite). **T2 also fails** — its own `expect(secondCallItem.meta.deadlineOriginalText).not.toContain("[Meeting thread in #")` line is D1-dependent (not D2-dependent as an earlier draft of this plan mis-stated), and correctly trips under this revert. **T2b fails differently than "the composite leaks through"**: with D1 reverted the ORIGIN item carries no `deadlineOriginalText` key at all (the arm only ever writes that key onto continuation legs, never onto the origin dispatch) — T2b's first assertion (`expect(originCallItem.meta.deadlineOriginalText).toContain(...)`) throws vitest's harness-level `the given combination of arguments (undefined and string) is invalid for this assertion` rather than a clean pass/fail diff. That throw *is* T2b correctly detecting the missing stamp — do not read it as a broken test; it is the expected failure mode for this specific revert.

For T2/T5 specifically (the meta-stripping assertions): revert Task 1 Step 2 (D2) only instead — restore the four conference keys to the destructure's pass-through — and re-run the same `-t "KPR-413"` filter. Expected (verified by execution): T2's `conferenceMode`/`conferenceRound`/`conferenceHumanTs`/`conferenceInjectionMode` assertions fail (they're no longer `undefined`) — and **T5** (in `dispatcher.test.ts`, run separately per below) fails on the same four assertions too, since D2 governs both dispatch legs identically; T5 is therefore a genuine source-level pin for D2, not merely the fixture-level check its own negative-verify (below) demonstrates for D1. T4's count assertion is unaffected by D2 alone and should still pass (T4 is a dispatch-count pin, not a meta-stripping assertion — its own negative-verify is separate, below).

Then perform T4's OWN negative-verify separately. **`-t "KPR-413"` does NOT match T4** — T4's assertion lives inside the pre-existing `it.each("killed round-1 reaction (%s) never delivers; mark untouched for the reactor")`, whose name (and every ancestor describe) carries no "KPR-413" tag, so that filter silently selects zero rows and reports a false-green "4 passed" that observes nothing. In `dispatchToAgent`, temporarily move the D5 round-1 kill-suppression block (the `if (resolved.conferenceRound === 1 && (...))` block) to AFTER the `maybeHandleDeadlineAbort` call instead of before it, then re-run the file **unfiltered** (or with `-t "killed round-1 reaction"`, which selects all three `it.each` rows):

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts -t "killed round-1 reaction"`
Expected (verified by execution): **two failures**. The `"timedOut with progress"` row fails T4's own assertion, `expected 2 times, but got 3 times` (a third dispatch — the continuation — fires). The pre-existing zero-progress `"timedOut"` row ALSO flips, on `adapter.deliver` `expected 1 times, but got 2 times` (the zero-progress notice now fires under the reorder) — harmless and expected, not a second defect to chase, but do not be surprised when the failure count is 2, not 1.

**`git restore src/channels/dispatcher.ts` correctly undoes this reorder** (Task 1's commit already contains the file in its fixed, ordered state — a plain restore-from-HEAD reverts any in-place edit including a control-flow move, the same as the D1-only and D2-only reverts above; there is no special case here).

For T5 (dispatcher.test.ts): T5's negative-verify is meaningful at BOTH levels — the D2-only revert above already fails it at the source level. Its fixture-level check (below) additionally proves T5 distinguishes the two possible *stored* text shapes, which is the property specific to the replay leg: change the fixture's `meta.deadlineOriginalText` from `frame` to `composite` (simulating what a pre-D1 stored queue doc would have held) and re-run `-t "KPR-413"` in this file. Expected: the assertions fail, proving T5 actually reads the supplied meta value rather than passing vacuously regardless of which text arrives.

Restore `src/channels/dispatcher.ts` (`git restore src/channels/dispatcher.ts` — Task 1's commit is the restore target for every source-level sub-step above, D1, D2, and the D5 reorder alike) after each source-level negative-verify sub-step, and restore T5's fixture back to `frame` before committing. Confirm `git status --short` shows only the two test files as modified before proceeding to commit.

- [ ] **Step 8:** Commit.

```bash
git add src/channels/dispatcher-conference.test.ts src/channels/dispatcher.test.ts
git commit -m "test(kpr-413): regression coverage for deadline-continuation legs under conference turns

Six new cases across both dispatcher test files: T1 (continuation
text is the turn's frame, byte-exact), T2 (leg carries no conference
meta), T2b (the stamp is written at assembly time, on the origin
turn's own dispatch, independent of whether an abort ever happens),
T3 (chain does not nest across legs), T4 (round-1 reactors with
observed progress stay unreachable through the deadline-abort arm —
an ordering pin on the epic's main-sync D5-before-arm placement, not
new behavior), T5 (the single-dispatch outage-replay leg for a
conference turn gets the same meta-stripping treatment as the live
fan-out leg). Each negative-verified against the pre-fix source or,
for T5, against the pre-D1 fixture shape. Lifted PREAMBLE to the
outer describe scope in dispatcher-conference.test.ts (turn()/
settleReactions() needed no lift — already in scope where the new
describe nests), following the file's existing soloClassifier() hoist
precedent.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Task 3: Full regression + push

- [ ] **Step 1:** Run the full check suite.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 — typecheck, lint, format, and the full test suite all pass.

- [ ] **Step 2:** Confirm the commits are ready to push (pushing itself is the deliver-ticket lane's own submit-ticket-pr step — not part of this plan's scope).

Run: `git log --oneline -3`
Expected: the two commits from Task 1 and Task 2, on top of the epic branch head this lane branched from.
