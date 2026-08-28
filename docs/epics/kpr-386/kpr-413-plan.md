# KPR-413 — Deadline-continuation legs must not re-wrap the assembled conference payload — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** A conference turn's deadline-continuation leg carries the turn's own frame (preamble + terminal slot) and no conference meta, never the assembled transcript — on both reachable dispatch legs (fan-out round-0, single-dispatch outage replay) — eliminating the N-copies transcript duplication this epic exists to fix.

**Architecture:** Two changes in `src/channels/dispatcher.ts`. D1: at the one conference-assembly site (`dispatchToAgent`'s conference branch), stamp `meta.deadlineOriginalText` with the turn's own frame (preamble + terminal slot, transcript arm empty) — `maybeHandleDeadlineAbort` already prefers this meta key over `item.text` when present, so no change is needed at the arm's read site, and the stamp rides into the outage store so a replayed conference turn's later abort is honest too. D2: at the continuation-leg meta builder, strip the four conference meta keys (`conferenceMode`, `conferenceRound`, `conferenceHumanTs`, `conferenceInjectionMode`) alongside the existing `outageReplay` strip, since a continuation leg computes no injection and never re-enters conference resolution.

**Tech Stack:** TypeScript, Vitest.

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
- `src/channels/dispatcher-conference.test.ts` — lift three fixtures to shared scope (Task 2 Step 1), then a new nested `describe` (T1-T3) inside `round-1 kill suppression (KPR-389 D5)`, plus one new assertion in the existing round-1 `it.each` (T4).
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
- Modify: `src/channels/dispatcher-conference.test.ts` (fixture lift + new describe T1-T3 + T4 extension)
- Modify: `src/channels/dispatcher.test.ts` (T5)

- [ ] **Step 1: Lift three fixtures to shared scope.**

`turn()` (`:567-581`), `settleReactions()` (`:606`), and `PREAMBLE` (`:678`) are currently block-scoped where the new T1-T3 describe cannot reach them: `turn()` and `settleReactions()` live inside `describe("round-1 kill suppression (KPR-389 D5)", ...)` (`:557-672`), and `PREAMBLE` lives inside the separate sibling `describe("delta context injection (KPR-388)", ...)` (`:674+`). Move each definition to the outer `describe("Conference channel routing", ...)` scope (the block starting at `:208`, immediately after the `beforeEach` that ends around `:227`), following the existing hoist precedent already in the file for `soloClassifier()` at `:229-230` ("Hoisted out of the delta describe (KPR-389 T8 needs it too — it only touches the classifier mock)") — mirror that comment's shape, e.g. "Hoisted out of round-1 kill suppression / delta context injection (KPR-413 needs them too)". Do not duplicate the fixtures — move them once; every existing test that used to reach them via the narrower scope still compiles and passes (JS closures over an outer-scoped `const`/`function` work identically to an inner-scoped one for every existing caller).

**Do not lift `THREE_MSG_HISTORY`/`makeHistory`** (also scoped inside `delta context injection`, `:698-714`) — the new T1-T3 tests below deliberately construct their own minimal inline history rather than reusing that fixture, keeping the lift to exactly the three fixtures spec-review approved.

- [ ] **Step 2:** Run the two target files to confirm the lift alone breaks nothing.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts`
Expected: all existing tests still pass (same count as before the lift) — the lift is a pure scope move, zero behavior change.

- [ ] **Step 3: Add the new describe (T1-T3) inside `round-1 kill suppression (KPR-389 D5)`.**

Add a new nested describe as the last member of `describe("round-1 kill suppression (KPR-389 D5)", () => { ... })` (`:557-672`), immediately before that describe's closing `});` at `:672`. Uses `soloClassifier()` for the round-0-only classifier mock (already hoisted at `:229`), a minimal one-message inline history (the mock factory's `fetchThreadHistory` defaults to `mockResolvedValue([])`, `:200` — an explicit non-empty override is required here so the pre-fix composite actually contains a transcript, making the negative-verify meaningful), and `agentManager.runWorkItemTurn.mockResolvedValueOnce(turn())` chained with a second resolved value shaped `turn({ finalMessage: "", timedOut: true, aborted: true, toolCalls: 46, streamed: true })` for the deadline-abort-with-progress shape (mirrors `withProgressAbort()`'s field shape in `dispatcher.test.ts:1735-1736`, adapted to this file's `turn()` helper). `agentManager.runWorkItemTurn.mock.calls[N][1]` is the confirmed pattern for extracting the dispatched `WorkItem` in this file (e.g. `:264`, `:349`, `:512`, `:731`).

```typescript
      describe("deadline-continuation legs carry the turn's own frame, not the conference transcript (KPR-413)", () => {
        const ONE_MSG_HISTORY = () => [
          { author: "May", text: "earlier meeting context", timestamp: new Date(Date.now() - 5 * 60_000), isBot: false, ts: "1000.0001" },
        ];

        it("T1: continuation text is the turn's frame, not the composite", async () => {
          await soloClassifier();
          const threadId = "conf-thread-kpr413-t1";
          mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
          agentManager.runWorkItemTurn
            .mockResolvedValueOnce(turn())
            .mockResolvedValueOnce(turn({ finalMessage: "", timedOut: true, aborted: true, toolCalls: 46, streamed: true }));

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
          expect(secondCallItem.text).not.toContain("[Meeting thread in #"); // no transcript marker
          expect(secondCallItem.text).toContain("Meeting rules:"); // frame preserved
          expect(secondCallItem.text).toContain("Jasper, status update?"); // human text preserved
        });

        it("T2: continuation leg carries no conference meta", async () => {
          await soloClassifier();
          const threadId = "conf-thread-kpr413-t2";
          mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
          agentManager.runWorkItemTurn
            .mockResolvedValueOnce(turn())
            .mockResolvedValueOnce(turn({ finalMessage: "", timedOut: true, aborted: true, toolCalls: 46, streamed: true }));

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

        it("T3: chain does not nest — every leg wraps the same frame", async () => {
          await soloClassifier();
          const threadId = "conf-thread-kpr413-t3";
          mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
          agentManager.runWorkItemTurn
            .mockResolvedValueOnce(turn())
            .mockResolvedValueOnce(turn({ finalMessage: "", timedOut: true, aborted: true, toolCalls: 46, streamed: true }))
            .mockResolvedValueOnce(turn({ finalMessage: "", timedOut: true, aborted: true, toolCalls: 46, streamed: true }));

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
          // leg2's wrapped original text is byte-identical to leg1's — never a
          // wrap-of-a-wrap. Both derive from the SAME frame string.
          expect(leg2.meta.deadlineOriginalText).toBe(leg1.meta.deadlineOriginalText);
        });
      });
```

- [ ] **Step 4: Extend the existing round-1 `it.each` with T4 (the ordering pin).**

The existing `it.each` at `:608-626` has two cases (`["aborted", { aborted: true }]`, `["timedOut", { timedOut: true, aborted: true }]`); only the `timedOut` case can reach `maybeHandleDeadlineAbort`'s own gate (`timedOut !== true || aborted !== true` early-returns), but running the added assertion unconditionally for both cases is harmless — it holds trivially for the `aborted`-only case and carries the real signal for `timedOut`. After the existing `await settleReactions();` call (`:618`) and before the existing `expect(adapter.deliver)...` assertions, add:

```typescript
          // KPR-413 T4: pins the D5-before-deadline-abort-arm ordering
          // established at the epic's main-sync (705f9f9) — a killed round-1
          // reaction must never reach maybeHandleDeadlineAbort and produce a
          // continuation dispatch. Negative-verify: reorder D5 after the arm
          // in dispatchToAgent → the timedOut case fires a third dispatch and
          // this assertion fails.
          expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
```

- [ ] **Step 5: Add T5 in `dispatcher.test.ts`'s deadline-abort continuation describe.**

Add a new row inside `describe("deadline-abort continuation (KPR-402)", ...)` (`:1699+`), after the existing chain-nesting test around `:1905-1920`. Confirmed helper shapes from the file: `makeTurn(overrides)` is a module-level function (`:1177`, outside any describe) that mirrors this file's `TurnResult`-shaped mock return, used the same way `turn()` is used in `dispatcher-conference.test.ts`; `replayItem(overrides)` (defined at `:1730` inside this describe) is `slackItem({ meta: { outageReplay: true, targetAgentId: "executive-assistant" }, ...overrides })` — **a shallow spread, so `overrides.meta` fully replaces the default meta object**, meaning the test below must include `outageReplay: true` and `targetAgentId` explicitly inside its own `meta` override, not rely on the default surviving. There is no `replayWrap` helper anywhere in `dispatcher.test.ts` — the file's existing replay tests dispatch raw `WorkItem`s directly (bypassing the real `outage-replay-processor.ts`'s own wrapping entirely), so this test does the same; `item.text`'s exact content is irrelevant to this test since the fix makes `maybeHandleDeadlineAbort` prefer `item.meta.deadlineOriginalText` over `item.text` unconditionally once that key is present — the test proves exactly that preference.

```typescript
    it("T5 (KPR-413): a replayed conference turn's continuation leg carries the stamped frame from meta, not item.text, and no conference meta", async () => {
      const composite = "[Meeting thread in #conf-x — participants: Jasper]\n---\n[New message]:\ntrigger text";
      const frame = "You are in a meeting in #conf-x with Jasper.\n\nMeeting rules:\n---\n[New message]:\ntrigger text"; // the D1-stamped frame, distinct from the composite
      agentManager.runWorkItemTurn.mockResolvedValueOnce(withProgressAbort());
      await dispatcher.dispatch(
        replayItem({
          id: "m1",
          text: composite, // what a pre-fix stored queue doc's text would have been — must be IGNORED once deadlineOriginalText is present
          meta: {
            outageReplay: true,
            targetAgentId: "executive-assistant",
            conferenceMode: true,
            conferenceRound: 0,
            conferenceHumanTs: "1000.0004",
            conferenceInjectionMode: "full",
            deadlineOriginalText: frame, // the D1 stamp, as it would have been written at conference-assembly time and ridden into the outage store
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

- [ ] **Step 6:** Run both target files and confirm all new rows pass.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts`
Expected: all tests pass; both files' case counts increase by exactly 6 over their pre-edit baselines (dispatcher-conference.test.ts: T1+T2+T3+T4 = 4; dispatcher.test.ts: T5 = 1 — capture baselines by running each file once before Task 1's edit if precise counts are wanted, though the pass/fail signal matters more than the exact totals here).

- [ ] **Step 7:** Negative-verify each new test fails for the right reason on pre-fix source.

For T1/T2/T3 (dispatcher-conference.test.ts): temporarily revert Task 1 Step 1 (D1) only — remove the `framePrefix` line and the `deadlineOriginalText` key from the conference-assembly meta — and re-run:

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts -t "KPR-413"`
Expected: T1 fails (the transcript-marker negative assertion trips — `originalText` falls back to the composite `item.text`, which contains `"[Meeting thread in #"`), T3 fails or is unaffected depending on which half of D1 it exercises. T2's `conferenceMode`/etc. assertions depend on D2, not D1 — they will still pass here since D2 is untouched by this revert; verify each assertion's actual failure mode matches its stated purpose, don't just confirm "something failed."

For T2 and T4 specifically (the meta-stripping assertions): revert Task 1 Step 2 (D2) only instead — restore the four conference keys to the destructure's pass-through — and re-run the same `-t "KPR-413"` filter. Expected: T2's `conferenceMode`/`conferenceRound`/`conferenceHumanTs`/`conferenceInjectionMode` assertions fail (they're no longer `undefined`); T4's count assertion is unaffected by D2 alone (D5's ordering, not D2's meta strip, is what T4 pins) and should still pass.

For T5 (dispatcher.test.ts): revert both D1 and D2, re-run `-t "KPR-413"` in that file. Expected: T5's marker-absence and meta-undefined assertions fail — though note T5's fixture supplies `deadlineOriginalText` directly (simulating an already-D1-fixed stored doc), so reverting D1/D2 in the ARM's own code doesn't change T5's outcome by itself (the arm still prefers the supplied `deadlineOriginalText` over `item.text` regardless of D1/D2's presence, since that preference logic is pre-existing KPR-402 code, not part of this fix). T5's real negative-verify is therefore at the FIXTURE level, not the source level: change the fixture's `meta.deadlineOriginalText` to `composite` (simulating a pre-fix stored doc, i.e. what the queue would have held before D1 existed) and re-run — now the assertions fail, proving T5 actually distinguishes the two fixture shapes.

Restore `src/channels/dispatcher.ts` (`git restore src/channels/dispatcher.ts` — the fix is already committed from Task 1, so this returns the file to that committed state) after each negative-verify sub-step. Confirm `git status --short` shows only the two test files as modified before proceeding to commit.

- [ ] **Step 8:** Commit.

```bash
git add src/channels/dispatcher-conference.test.ts src/channels/dispatcher.test.ts
git commit -m "test(kpr-413): regression coverage for deadline-continuation legs under conference turns

Five new cases across both dispatcher test files: T1 (continuation
text is the turn's frame, not the composite), T2 (leg carries no
conference meta), T3 (chain does not nest across legs), T4 (round-1
reactors stay unreachable through the deadline-abort arm — an
ordering pin, not new behavior), T5 (the single-dispatch outage-replay
leg for a conference turn gets the same treatment as the live
fan-out leg). Each negative-verified against the pre-fix source.
Lifted turn()/settleReactions()/PREAMBLE to the outer describe scope
in dispatcher-conference.test.ts so the new describe can reach them,
following the file's existing soloClassifier() hoist precedent.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Task 3: Full regression + push

- [ ] **Step 1:** Run the full check suite.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 — typecheck, lint, format, and the full test suite all pass.

- [ ] **Step 2:** Confirm the commits are ready to push (pushing itself is the deliver-ticket lane's own submit-ticket-pr step — not part of this plan's scope).

Run: `git log --oneline -3`
Expected: the two commits from Task 1 and Task 2, on top of the epic branch head this lane branched from.
