# KPR-387 — Implementation Plan

**Goal:** In conference (`conf-*`) dispatch, (1) record round-0 primary responders into `meetingReactionTracker` at selection time so the reaction pass never re-selects a primary for the same triggering human message, and (2) reframe round-1 reaction turns so the terminal prompt slot carries the peer's reply (author + text) instead of the original human message.

**Tech stack:** TypeScript (strict), Node 22+, vitest 4. Single-file change surface: `src/channels/dispatcher.ts` + `src/channels/dispatcher-conference.test.ts`.

**Spec:** `docs/epics/kpr-386/kpr-387-spec.md` (spec-ready, review clean r1). Decision-register canon: none — KPR-386 is a pre-register epic; this is its first child.

**Line references** below verified against branch `KPR-386` at `5d6f0a3`. Re-verify with a quick read before editing; the anchor strings in each edit are the source of truth, not the line numbers.

---

## Testing Contract

### Required Test Groups

| Group | Status | Scope | Reason | Harness status | Minimum assertions |
|---|---|---|---|---|---|
| Unit | **required** | `src/channels/dispatcher-conference.test.ts` — two new regression tests exercising the full `dispatch()` → round-0 fan-out → fire-and-forget reaction pass with mocked seams (`classifyMeetingMessage`, `fetchThreadHistory`, `runWorkItemTurn`) | Both defects are dispatcher-internal behavior fully reachable through the existing mock harness | **Exists** — mock registry (jasper/river/jessica/disabled chief-of-staff), mocked meeting classifier, mock slack adapter, mock agent manager, all in the test file | (1) every reaction-pass classifier roster excludes all round-0 primaries; (2) the round-1 work item text contains the peer reply text + responder display name and does NOT contain the human message text or a `[New message]:` slot |
| Integration | **not-required** | — | see Non-Required Rationale | — | — |
| E2E | **not-required** | — | see Non-Required Rationale | — | — |

### Critical Flows

1. `dispatch(conf-* item)` → `resolveConferenceAgents` → tracker write (new) → round-0 fan-out → `dispatchToAgent` (round-0 prompt **byte-identical** to today) → delivery → fire-and-forget `triggerConferenceReactions` → peer roster build excludes recorded round-0 ids → round-1 `dispatchToAgent` with `reactionTo`-framed prompt.
2. Round-0-only threads (reaction classifier returns `[]`): no round-1 dispatch, no tracker leakage into later `humanTs` keys.

### Regression Surface

- The six existing tests in `dispatcher-conference.test.ts` (five conference-path + one negative-routing) must stay green. None asserts pre-fix defective behavior (fan-out test suppresses reactions via empty classifier results; framing tests cover round-0 only).
- Round-0 conference prompt assembly must remain **byte-identical** (Task 2 restructures the join — the round-0 output string must not change).
- All other dispatcher behavior (dedup, thread affinity, ledger, outage gates, sweep) untouched; full `npm run check` sweep at the end.

### Commands

All test/check commands need the Slack env stubs (config load trips on `SLACK_BOT_TOKEN` otherwise):

```bash
cd /Users/mokie/github/hive-KPR-386
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
# expected after Tasks 1–4: Test Files 1 passed, Tests 8 passed (6 existing + 2 new)

SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
# expected: typecheck + lint + format + full vitest suite all green
```

### Harness Requirements

- No new harness. Existing mocks suffice for both tests.
- **Async-drain hazard (binding, spec test-plan):** `triggerConferenceReactions` is fire-and-forget at its call site (`.catch`, not awaited — dispatcher.ts:1050), so `await dispatcher.dispatch(item)` returns before any reaction-pass classifier call or round-1 `runWorkItemTurn`. Both new tests MUST drain via `vi.waitFor` on the asserted mock call (plus a microtask/timer flush in test 1 before asserting over *all* reaction calls). The negative-verify task is the backstop that exposes a vacuous (undrained) test.
- Mock-leak convention: `vi.clearAllMocks()` in `beforeEach` clears calls, not implementations — each new test sets its own `mockResolvedValueOnce(...).mockResolvedValue(...)` chain, matching the existing tests' pattern. New tests are appended at the end of the describe block.

### Non-Required Rationale

- **Integration:** the change is confined to prompt-string assembly and one in-memory `Map` inside a single class. The unit tests already run the real `Dispatcher` end-to-end through `dispatch()` with only the process-boundary seams mocked — that *is* the integration surface. No cross-module contract changes (classifier signatures, WorkItem shape, adapter API all unchanged).
- **E2E:** no e2e harness exists in the repo; live `#conf-*` Slack validation is epic-level rollout verification for KPR-386, not a per-child gate.

### Verification Rules

- A missing harness is **not** a skip reason — build the harness or escalate; here the harness exists.
- A test failure that exposes an implementation issue → **fix the implementation**, never weaken the test.
- A spec/plan mismatch discovered during implementation → **demote the ticket to the spec lane**; do not improvise around the spec.
- No completion claims without command output (dodi-dev:verify). The negative-verify step (Task 5) is mandatory, with evidence recorded for the PR.

---

## Task 1 — Record round-0 responders in the reaction tracker

File: `src/channels/dispatcher.ts`

- [ ] **1a.** Update the tracker comment (currently lines 96–97). Replace:

  ```ts
    // Map<threadId, Map<humanMessageTs, Set<agentId>>> — tracks which agents reacted in round 1
    private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();
  ```

  with:

  ```ts
    // Map<threadId, Map<humanMessageTs, Set<agentId>>> — agents that responded or were
    // selected to respond on this human message, either round (KPR-387): round-0
    // primaries recorded at selection time, round-1 reactors at claim time.
    private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();
  ```

- [ ] **1b.** In `resolveConferenceAgents()` (~1097), insert the tracker write between the `log.info("Conference classifier result", …)` block (ends ~1158) and `const preamble = this.buildMeetingPreamble(…)` (~1160):

  ```ts
      // KPR-387: record round-0 responders so the reaction pass never re-selects a
      // primary for the same triggering human message. Recorded at selection time —
      // a primary whose turn errors or is suppressed stays excluded for this trigger
      // (deliberate: kills the suppressed-turn burn; Gate 1 delegated assumption).
      // Runs synchronously before any round-0 dispatch starts, so there is no race
      // with a fast round-0 completion triggering the reaction pass.
      const humanTs = item.meta?.slackTs as string | undefined;
      if (humanTs && classification.respondAgentIds.length > 0) {
        if (!this.meetingReactionTracker.has(threadId)) {
          this.meetingReactionTracker.set(threadId, new Map());
        }
        const threadTracker = this.meetingReactionTracker.get(threadId)!;
        const responded = threadTracker.get(humanTs) ?? new Set<string>();
        for (const id of classification.respondAgentIds) responded.add(id);
        threadTracker.set(humanTs, responded);
      }
  ```

- [ ] **1c.** In the same method's return value (~1162–1169), reuse the new local instead of re-reading meta. Replace:

  ```ts
        conferenceHumanTs: item.meta?.slackTs as string,
  ```

  with:

  ```ts
        conferenceHumanTs: humanTs,
  ```

  (`humanTs` is `string | undefined`; the field is `conferenceHumanTs?: string` — assignable, no cast needed.)

- [ ] **1d.** Do **not** touch `triggerConferenceReactions` exclusion logic: the existing `reacted.has(agentId)` skip (~1242) now excludes round-0 ids automatically; the release loop (~1259–1265) only iterates `peerMembers`, so round-0 entries are never un-claimed; the redundant `respondingAgentId` skip (~1241) stays (protects the `humanTs`-undefined path).

- [ ] **1e.** Verify:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  npm run typecheck   # expected: exit 0, no output errors
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
  # expected: Tests 6 passed (existing suite green)
  ```

- [ ] **1f.** Commit:

  ```bash
  git add src/channels/dispatcher.ts
  git commit -m "fix(dispatcher): record round-0 conference responders in reaction tracker (KPR-387)

  Round-0 primaries were never written to meetingReactionTracker, so the
  reaction pass could re-select a primary for the same triggering human
  message (double answers + suppressed-turn burn in conf-tahoe).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

## Task 2 — Frame round-1 dispatch against the peer reply

File: `src/channels/dispatcher.ts`

- [ ] **2a.** Extend `ResolvedAgent` (~46–54). Replace the interface with:

  ```ts
  /** Extended resolved-agent type carrying optional conference metadata */
  interface ResolvedAgent {
    agentId: string;
    conferenceMode?: boolean;
    conferenceHumanTs?: string;
    conferenceRound?: number; // 0 = human-triggered, 1 = peer reaction
    threadContext?: string;
    meetingPreamble?: string;
    /** Round-1 only: the peer reply this reaction turn should engage with (KPR-387). */
    reactionTo?: { authorName: string; text: string };
  }
  ```

- [ ] **2b.** In `dispatchToAgent` (~985), replace the conference prompt-assembly branch (~990–1004):

  ```ts
      if (resolved.conferenceMode) {
        const contextPrefix = [resolved.meetingPreamble, "", resolved.threadContext, "", "---", `[New message]:`]
          .filter(Boolean)
          .join("\n");
        effectiveItem = {
          ...item,
          text: `${contextPrefix}\n${item.text}`,
          meta: {
            ...item.meta,
            conferenceMode: true,
            conferenceHumanTs: resolved.conferenceHumanTs,
            conferenceRound: resolved.conferenceRound,
          },
        };
      }
  ```

  with:

  ```ts
      if (resolved.conferenceMode) {
        // KPR-387: round-1 reaction turns are framed against the peer reply — the
        // original human message is never re-presented in the terminal slot (it
        // remains available via the re-fetched transcript in threadContext).
        const newMessageSegment = resolved.reactionTo
          ? `[${resolved.reactionTo.authorName} just replied]:\n${resolved.reactionTo.text}\n\n` +
            `React to ${resolved.reactionTo.authorName}'s reply if you have something to add. ` +
            `Do not re-answer the original question. If you have nothing to add, respond with "No response needed."`
          : `[New message]:\n${item.text}`;
        const contextPrefix = [resolved.meetingPreamble, resolved.threadContext, "---"].filter(Boolean).join("\n");
        effectiveItem = {
          ...item,
          text: `${contextPrefix}\n${newMessageSegment}`,
          meta: {
            ...item.meta,
            conferenceMode: true,
            conferenceHumanTs: resolved.conferenceHumanTs,
            conferenceRound: resolved.conferenceRound,
          },
        };
      }
  ```

  **Byte-compat note (do not deviate):** the old code's `""` array entries were removed by `.filter(Boolean)`, so the old round-0 output was `preamble\nthreadContext\n---\n[New message]:\n<human text>`. The new round-0 path (`reactionTo` undefined) produces exactly the same string. WorkItem semantics unchanged — same `item` spread, same `meta` keys.

- [ ] **2c.** In `triggerConferenceReactions`, populate `reactionTo`. Replace the dispatch construction (~1298–1309):

  ```ts
      // Dispatch reactions concurrently (peers already claimed in reacted set above)
      const reactionDispatches = classification.respondAgentIds.map((agentId) => {
        const resolved: ResolvedAgent = {
          agentId,
          conferenceMode: true,
          conferenceHumanTs: humanTs,
          conferenceRound: 1,
          threadContext,
          meetingPreamble: preamble,
        };
        return this.dispatchToAgent(originalItem, resolved);
      });
  ```

  with:

  ```ts
      // Dispatch reactions concurrently (peers already claimed in reacted set above)
      const responderName = this.registry.get(respondingAgentId)?.name ?? respondingAgentId;
      const reactionDispatches = classification.respondAgentIds.map((agentId) => {
        const resolved: ResolvedAgent = {
          agentId,
          conferenceMode: true,
          conferenceHumanTs: humanTs,
          conferenceRound: 1,
          threadContext,
          meetingPreamble: preamble,
          reactionTo: { authorName: responderName, text: responseText },
        };
        return this.dispatchToAgent(originalItem, resolved);
      });
  ```

- [ ] **2d.** Verify (same commands as 1e; expected: typecheck clean, 6 existing tests green — in particular `routes conference channel message through classifier`, which asserts round-0 text content, proving byte-compat).

- [ ] **2e.** Commit:

  ```bash
  git add src/channels/dispatcher.ts
  git commit -m "fix(dispatcher): frame round-1 conference reactions against the peer reply (KPR-387)

  Reaction turns previously re-presented the original human message in the
  [New message] slot, re-asking reactors the question they were supposed to
  react to. The terminal slot now carries the peer's reply (author + text)
  with an explicit don't-re-answer instruction; the human message remains
  available via the re-fetched transcript.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

## Task 3 — Regression test 1: round-0 responders excluded from reaction roster

File: `src/channels/dispatcher-conference.test.ts` — append inside the `describe("Conference channel routing", …)` block, after the last existing test:

- [ ] **3a.** Add:

  ```ts
    it("round-0 responders are excluded from the reaction-pass roster", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      // Round-0: jasper + river respond. Reaction passes: capture roster, select nobody.
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper", "river"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });

      const item = makeWorkItem({
        text: "Jasper, River, and Jessica, discuss the launch plan",
        source: { kind: "slack", id: "C-CONF", label: "conf-strategy" },
        threadId: "conf-thread-exclusion",
        meta: { slackTs: "1700.0001" },
      });

      await dispatcher.dispatch(item);

      // triggerConferenceReactions is fire-and-forget (dispatch() returns before the
      // reaction pass runs): drain until at least one reaction-pass classifier call
      // happened, then flush the event loop before asserting over ALL reaction calls.
      const reactionCalls = () =>
        (classifyMeetingMessage as any).mock.calls.filter((c: any[]) => c[0] === "Agent response");
      await vi.waitFor(() => {
        expect(reactionCalls().length).toBeGreaterThanOrEqual(1);
      });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      // Every reaction-pass roster contains only jessica — never a round-0 primary.
      for (const call of reactionCalls()) {
        const rosterIds = call[1].map((m: any) => m.agentId);
        expect(rosterIds).toEqual(["jessica"]);
      }

      // Each agent ran at most once for this trigger (round-0 only; reactions suppressed).
      expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
      const calledAgents = agentManager.runWorkItemTurn.mock.calls.map((c: any[]) => c[0]).sort();
      expect(calledAgents).toEqual(["jasper", "river"]);
    });
  ```

  Notes (constraints, verified against the harness):
  - The trigger text matches the mock registry's name regex for all three agents (each name followed by a comma), so the roster is jasper + river + jessica.
  - Reaction-pass calls are identified by `c[0] === "Agent response"` — the mocked `runWorkItemTurn.finalMessage`, which `dispatchToAgent` passes to `triggerConferenceReactions` as `responseText`. Round-0's call has the human text as `c[0]` and never matches.
  - Depending on microtask interleaving there may be one or two reaction-pass calls (the second pass may early-return on the claim set); the loop asserts over whichever happened — pre-fix, the pass triggered by Jasper's reply carries `["river", "jessica"]` and/or River's carries `["jasper"]`, failing `toEqual(["jessica"])`.

- [ ] **3b.** Run the file (command from Testing Contract). Expected: `Tests 7 passed`.

## Task 4 — Regression test 2: round-1 prompt frames the peer reply

File: `src/channels/dispatcher-conference.test.ts` — append after Task 3's test:

- [ ] **4a.** Add:

  ```ts
    it("round-1 reaction prompt frames the peer reply, not the human message", async () => {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      // Round-0: jasper responds. Reaction pass: jessica reacts to jasper's reply.
      // The trigger must mention BOTH agents — with only jasper in the roster,
      // peerMembers is empty and the reaction pass returns before the classifier.
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const item = makeWorkItem({
        text: "Jasper, and Jessica, please weigh in on the Q3 roadmap",
        source: { kind: "slack", id: "C-CONF", label: "conf-strategy" },
        threadId: "conf-thread-framing",
        meta: { slackTs: "1700.0002" },
      });

      await dispatcher.dispatch(item);

      // Drain the fire-and-forget reaction pass until jessica's round-1 turn ran.
      const round1Call = () =>
        agentManager.runWorkItemTurn.mock.calls.find((c: any[]) => c[1]?.meta?.conferenceRound === 1);
      await vi.waitFor(() => {
        expect(round1Call()).toBeDefined();
      });

      const [reactorId, round1Item] = round1Call()!;
      expect(reactorId).toBe("jessica");
      // Peer reply framed in the terminal slot: responder display name + full reply text.
      expect(round1Item.text).toContain("Agent response");
      expect(round1Item.text).toContain("Jasper");
      // Human message absent (fetchThreadHistory is mocked to [], so it cannot leak
      // in via the transcript either) and the [New message] human-slot is gone.
      expect(round1Item.text).not.toContain("please weigh in on the Q3 roadmap");
      expect(round1Item.text).not.toMatch(/\[New message\]:\n/);
    });
  ```

  Notes:
  - `vi.waitFor(round1Call defined)` succeeds on pre-fix code too (the round-1 dispatch itself is not new) — the discriminators are the text assertions: pre-fix the round-1 text ends with `[New message]:\n<human text>` and never contains `"Agent response"`.
  - `toContain("Jasper")` alone is non-discriminating (the preamble lists participant names); it documents the author-name contract and is kept per spec.

- [ ] **4b.** Run the file. Expected: `Tests 8 passed`.

- [ ] **4c.** Commit both tests:

  ```bash
  git add src/channels/dispatcher-conference.test.ts
  git commit -m "test(dispatcher): round-0 reactor exclusion + round-1 peer-reply framing (KPR-387)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

## Task 5 — Negative verify (mandatory; evidence for PR)

Per `feedback_negative_verify_regression_tests` and spec test-plan item 3: prove both new tests fail against pre-fix dispatcher code. The fixes are committed by now, so revert via the first KPR-387 fix commit's parent (branch `KPR-386` contains no earlier KPR-387 commits).

- [ ] **5a.** Revert the dispatcher hunks only (single bash call — env/cwd don't persist between calls):

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  FIRST=$(git log --format=%H --grep="KPR-387" -- src/channels/dispatcher.ts | tail -1)
  git checkout "$FIRST^" -- src/channels/dispatcher.ts
  git status --short   # expected: " M src/channels/dispatcher.ts" only
  ```

- [ ] **5b.** Run the two new tests against pre-fix code — **expected: both FAIL** (exit non-zero):

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts -t "round-"
  # expected: Tests 2 failed —
  #   "round-0 responders are excluded…" fails on rosterIds toEqual(["jessica"])
  #   "round-1 reaction prompt frames…" fails on toContain("Agent response")
  ```

  If either test PASSES here, it is vacuous (likely an undrained async path) — fix the test, do not proceed.

- [ ] **5c.** Restore and confirm green:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  git checkout HEAD -- src/channels/dispatcher.ts
  git status --short   # expected: clean
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
  # expected: Tests 8 passed
  ```

- [ ] **5d.** Record the evidence: save the 5b failure output (test names + failing assertions) and the 5c pass output for inclusion in the PR body. No commit for this task.

## Task 6 — Full regression sweep

- [ ] **6a.** Run the full gate:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
  # expected: typecheck 0 errors, eslint clean, prettier clean, all vitest suites pass
  ```

  If prettier flags the touched files, run `npm run format`, re-run check, and amend/commit the formatting with the message `style(dispatcher): prettier (KPR-387)`.

- [ ] **6b.** Confirm working tree clean and all commits reference KPR-387 (`git log --oneline main..HEAD` shows the 3 task commits on top of the epic branch history).

---

## Out of scope (guard rails)

- No changes to `classifyMeetingMessage` (prompt, schema, signatures), transcript fetching/injection (KPR-388), `conferenceRound` spawn shaping/telemetry (KPR-389), worker pool (KPR-390), reaction depth (`conferenceRound === 0` gate at ~1049 untouched), sweep/eviction, tracker persistence, or non-Slack conference support.
- No config, schema, cross-module, or `docs/providers.md` changes.
- Do not "clean up" the redundant `respondingAgentId` skip in `triggerConferenceReactions` — it guards the `humanTs`-undefined path.

---

## Reviewer notes (plan-review r1, fable — advisory)

- Task 5a: `--grep="KPR-387"` must stay case-sensitive (lowercase `docs(kpr-387)` commits exist; they're also path-filtered out). Don't switch to `-i`.
- Task 5b: vitest will render the 2 expected failures alongside ~6 filtered/skipped tests ("2 failed | 6 skipped") — the skipped count is not anomalous.
- Environment: `node_modules` is not installed in this worktree — run `npm install` before the first verify step.
