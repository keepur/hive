# KPR-388 — Implementation Plan

**Goal:** Conference turns stop re-injecting the full thread transcript into stateful sessions. A per-agent-per-thread high-water mark (`meetingLastSeenTs`, raw Slack ts) lives on the existing `sessions` document; at resolve time each selected agent gets either a **delta** context (messages newer than its mark, only when it holds a resumable same-provider session AND a mark) or the **full** transcript (byte-identical to today, C6 pin untouched). After a successful turn the mark advances to the max ts actually injected (trigger `slackTs` maxed in on round-0, both modes; suppressed non-responses included); a delta turn that actually ran fresh (`TurnResult.resumedSession === false` — new signal) **clears** the mark so the next turn heals with a full transcript.

**Tech stack:** TypeScript (strict), Node 22+, vitest 4. Change surface: `src/agents/session-store.ts`, `src/channels/slack-adapter.ts`, `src/agents/agent-manager.ts`, `src/agents/agent-runner.ts` (type only), `src/channels/dispatcher.ts`, plus tests beside each source.

**Spec:** `docs/epics/kpr-386/kpr-388-spec.md` (spec-ready, review clean r1). Design §1–§8 are the contract; the ⚠ delegated refinements (one-degraded-turn heal, `resumedSession` approximation) are binding.

**Decision-register canon:** C1–C6 (KPR-387) bind. Spec §8 maps compliance — carried into tasks: C1/C2 tracker untouched; C3 terminal slot byte-identical (rationale comment updated, generalized not contradicted); C4 preamble every turn; C5 N/A; C6 existing round-0 byte pin passes **unmodified**, delta shape gets its own sibling pin.

**Line references** verified against branch `KPR-386` at `e19ea3a` (KPR-387 merged at `3896a24`). Anchor strings in each edit are the source of truth, not line numbers.

**Plan-fixed decisions** (mechanical sharpenings delegated by the spec):
- **Delta header wording (byte-pinned in Task 6):** line 1 = the same `[Meeting thread in #<channel> — participants: <names>]` header as full mode; line 2 = `[New messages since your last turn:]`; blank line; then the same `author (ago): text` body. Contains no `[New message]:` substring (C3 framing test's negative assertions stay unambiguous).
- **`buildConferenceContext` gains an optional 6th param `roundZeroTriggerTs?: string`** — the spec's signature omitted a carrier for the round-0 trigger max-in it mandates; the param is passed only from `resolveConferenceAgents`.
- **Plain `$set` for the mark (no `$max` enforcement)** — spec §5 argues regression is benign (duplication, never gaps) and offers `$max` as optional; declined for simplicity (ts is a decimal string; numeric `$max` would add conversion complexity for no correctness gain).
- **Truncation extracted to `truncateHistory()`** shared by `formatThreadContext` and the full-arm high-water calc — output byte-identical (same messages, same order), avoids duplicating the first-5+last-100 rule.

---

## Testing Contract

### Required Test Groups

| Group | Status | Scope | Reason | Harness status | Minimum assertions |
|---|---|---|---|---|---|
| Unit | **required** | `src/channels/dispatcher-conference.test.ts` (14 new), `src/agents/session-store.test.ts` (5 new), `src/agents/agent-manager.test.ts` (6 new) — real `Dispatcher`/`AgentManager`/`SessionStore` driven end-to-end with process-boundary seams mocked (classifier, slack fetch, runner/adapters, Mongo collection) | All behavior is dispatcher/manager/store-internal and fully reachable through the existing mock harnesses | **Exists** — conference harness (mock registry/classifier/slack adapter/agent manager) needs a mechanical extension: mock `agentManager` gains `getSessionStore()` (Map-backed refs + `setMeetingMark`/`clearMeetingMark` spies), `providerFor`, and a dormant `circuitBreakers.stateFor`; slack-history mocks gain `ts` values | Spec test-plan items 1–5 + C6: (1) **delta-shape byte pin**; (2) full injection on **every** read-side miss (no row / empty handle / provider mismatch / no mark) with the existing round-0 byte pin passing **unmodified**; (3) mark advance = max injected ts incl. round-0 trigger max-in in both modes, also on suppressed non-response, **not** on error/aborted/outage-queued; (4) delta-into-fresh (`resumedSession === false`) ⇒ `clearMeetingMark`, no set; (5) C3: round-1 reactor's delta contains the triggering human message; no-session reactor gets full transcript; plus empty-delta ⇒ pinned empty-history join, store no-upsert pin, `resumedSession` truth table |
| Integration | **not-required** | — | see Non-Required Rationale | — | — |
| E2E | **not-required** | — | see Non-Required Rationale | — | — |

### Critical Flows

1. **Round-0 delta:** `dispatch(conf-* item)` → `resolveConferenceAgents` → one `fetchThreadHistory` → classifier → per-selected-agent `buildConferenceContext` (store `get` + `providerFor`) → delta context → `dispatchToAgent` (join/terminal slot **unchanged**) → turn success → `setMeetingMark(maxInjectedTs ∪ triggerTs)`.
2. **Read-side miss → full:** any of {no row, TTL'd, scrubbed, empty handle (codex), provider mismatch, no mark} → `formatThreadContext` byte-identical to today → mark established on success.
3. **Continuity break after injection:** delta-injected turn runs fresh (self-heal/auth-rebuild) → `resumedSession: false` propagates `finalizeSpawnResult` → `TurnResult` → `convertTurnResult` → `RunResult` → dispatcher clears the mark → next turn full (heals).
4. **Round-1 (C3):** `triggerConferenceReactions` re-fetches once → per-reactor `buildConferenceContext` (no trigger max-in) → reactor's mark predates the trigger ⇒ human message in its delta; terminal slot still the peer reply.
5. **Outage interplay:** queued/fast-failed turns return before the bookkeeping site — mark untouched.

### Regression Surface

- The **9 existing tests** in `dispatcher-conference.test.ts` must stay green with **zero edits** — in particular the round-0 byte-exact pin (C6) and the round-1 framing test (its `/\[New message\]:\n/` negative must not match the new delta header).
- The **17 existing tests** in `session-store.test.ts` (14 plain `it` + one 3-case `it.each`) (normalization/scrub) — `normalizeRef` changes are additive; `toEqual` ignores `undefined`-valued keys, so existing shape assertions hold.
- The full `agent-manager.test.ts` suite (spawnTurn, KPR-313 guard, KPR-350/351 self-heal, breaker) — `finalizeSpawnResult` gains a parameter at its single call site; no behavior change.
- `dispatcher.test.ts` (outage/routing) — non-conference paths never reach the new code (gated on `conferenceMode`/`conf-` label).
- `slack-adapter.test.ts` — `ThreadMessage.ts` is additive.
- Full `npm run check` sweep at the end.

### Commands

All test/check commands need the Slack env stubs (config load trips on `SLACK_BOT_TOKEN` otherwise). Run `npm install` first if `node_modules` is missing in the worktree.

```bash
cd /Users/mokie/github/hive-KPR-386
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
# expected after Task 6: Test Files 1 passed, Tests 23 passed (9 existing + 14 new)

SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/session-store.test.ts
# expected after Task 1: Tests 22 passed (17 existing + 5 new)

SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
# expected after Task 3: all existing + 6 new pass

SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
# expected: typecheck + lint + format + full vitest suite all green
```

### Harness Requirements

- **Async-drain hazard (carried over from KPR-387, binding):** `triggerConferenceReactions` is fire-and-forget at its call site — round-1 assertions AND round-1 mark-bookkeeping assertions MUST drain via `vi.waitFor` on the asserted mock call (the mark write happens *after* the round-1 turn resolves, so wait on `setMeetingMark`/the round-1 `runWorkItemTurn` call itself, then flush with `await new Promise((r) => setTimeout(r, 0))` before asserting over all calls).
- **Faking session refs/marks:** the conference harness's mock `agentManager` gains a Map-backed store surface (`_sessionRefs` keyed `"{agentId}:{threadId}"`, `get` reads it, `setMeetingMark`/`clearMeetingMark` are plain spies). No real Mongo. The agent-manager suite keeps its existing `makeMockSessionStore` unchanged (the manager never calls the mark methods). The session-store suite keeps its mock-collection harness (`makeMockDb`).
- **`ago`-label determinism in byte pins:** no fake timers (they'd interact with `vi.waitFor` drains). Delta-pin history entries use minute-granularity offsets (`timestamp: new Date(Date.now() - 5 * 60_000)` ⇒ `"5 min ago"`), stable unless the test stalls ~60s.
- **Mark comparisons use `ThreadMessage.ts` (raw string), not `timestamp`** — mock history entries need both; they don't have to agree (ts drives filtering, timestamp drives the display label only).
- Mock-leak convention: `vi.clearAllMocks()` clears calls not implementations; per-test `mockResolvedValueOnce(...).mockResolvedValue(...)` chains, as in the existing suite.

### Non-Required Rationale

- **Integration:** no cross-process contract changes — Mongo writes are two narrow single-document `updateOne`s (pinned at the mock-collection level exactly like the KPR-313 suite), and the dispatcher↔manager seam is exercised with the real classes on both ends across the two suites. The unit tests run the real dispatch pipeline end-to-end.
- **E2E:** no e2e harness in the repo; live `#conf-tahoe` validation is epic-level rollout verification for KPR-386, not a per-child gate.

### Verification Rules

- A missing harness is **not** a skip reason — build the harness or escalate; here every harness exists or is a mechanical extension.
- A test failure that exposes an implementation issue → **fix the implementation**, never weaken the test.
- A spec/plan mismatch discovered during implementation → **demote to the spec lane**; do not improvise around the spec.
- No completion claims without command output (dodi-dev:verify). Negative verify (Task 7) is mandatory, with evidence recorded for the PR.

---

## Task 1 — Session store: `meetingLastSeenTs` field, ref surfacing, set/clear methods

File: `src/agents/session-store.ts`

- [ ] **1a.** In `SessionDoc` (after the `updatedAt: Date;` line, inside the interface), add:

  ```ts
    /** KPR-388: Slack ts (raw string, e.g. "1724632800.123456") of the newest
     *  thread message this agent's session has been shown via conference
     *  injection. Absent ⇒ no delta basis ⇒ full-transcript injection. */
    meetingLastSeenTs?: string;
  ```

- [ ] **1b.** In `StoredSessionRef`, after `provider: AgentProviderId | undefined;`, add:

  ```ts
    /** KPR-388: meeting-continuity mark; absent ⇒ full injection. */
    meetingLastSeenTs?: string;
  ```

- [ ] **1c.** In `normalizeRef`, surface the mark on the two non-scrub branches. In the tagged-row branch, replace:

  ```ts
        return {
          sessionId: persistsResumableHandle(semantics ?? "stateless-replay")
            ? doc.sessionId || undefined
            : undefined,
          provider: doc.provider,
        };
  ```

  with:

  ```ts
        return {
          sessionId: persistsResumableHandle(semantics ?? "stateless-replay")
            ? doc.sessionId || undefined
            : undefined,
          provider: doc.provider,
          meetingLastSeenTs: doc.meetingLastSeenTs,
        };
  ```

  And the final grandfathered-legacy return, replace:

  ```ts
      // Legacy untagged plain id: grandfathered as claude (pre-313 fleet rows).
      return { sessionId: doc.sessionId || undefined, provider: "claude" };
  ```

  with:

  ```ts
      // Legacy untagged plain id: grandfathered as claude (pre-313 fleet rows).
      return { sessionId: doc.sessionId || undefined, provider: "claude", meetingLastSeenTs: doc.meetingLastSeenTs };
  ```

  The scrub branch's `return { sessionId: undefined, provider: undefined };` stays **untouched** — the row is being deleted; no mark survives (spec §1).

- [ ] **1d.** After the `set(...)` method (and before `delete(...)`), add the two mark methods:

  ```ts
    /**
     * KPR-388: advance the meeting-continuity mark. `updateOne` WITHOUT upsert
     * — a mark must never create a row (an upserted skeleton would break
     * normalizeRef's assumptions and fabricate thread-affinity via
     * findAgentsByThread). Deliberately does NOT touch updatedAt: TTL stays
     * owned by turn persistence (the same turn's finalizeSpawnResult set()
     * already refreshed it).
     */
    async setMeetingMark(agentId: string, threadId: string, ts: string): Promise<void> {
      await this.withRetry(async () => {
        await this.collection.updateOne(
          { _id: `${agentId}:${threadId}` },
          { $set: { meetingLastSeenTs: ts } },
        );
      }, undefined, `setMeetingMark(${agentId}:${threadId})`);
    }

    /** KPR-388: clear the mark — the next conference turn injects the full transcript. */
    async clearMeetingMark(agentId: string, threadId: string): Promise<void> {
      await this.withRetry(async () => {
        await this.collection.updateOne(
          { _id: `${agentId}:${threadId}` },
          { $unset: { meetingLastSeenTs: "" } },
        );
      }, undefined, `clearMeetingMark(${agentId}:${threadId})`);
    }
  ```

- [ ] **1e.** File: `src/agents/session-store.test.ts` — append a new top-level describe (after the existing one), reusing the module-scope `makeMockDb`, `doc`, `KEY` helpers:

  ```ts
  describe("SessionStore — meeting-continuity mark (KPR-388)", () => {
    let store: SessionStore;
    let mocks: ReturnType<typeof makeMockDb>["mocks"];

    beforeEach(async () => {
      vi.clearAllMocks();
      const m = makeMockDb();
      store = new SessionStore(m.db);
      mocks = m.mocks;
      await store.init();
    });

    it("setMeetingMark: updateOne WITHOUT upsert, $set only the mark, updatedAt untouched (no-upsert pin)", async () => {
      await store.setMeetingMark("agent-a", "sms:line-1:t1", "1724632800.123456");
      const [filter, update, options] = mocks.updateOne.mock.calls[0]!;
      expect(filter).toEqual({ _id: KEY });
      expect(update).toEqual({ $set: { meetingLastSeenTs: "1724632800.123456" } });
      // A mark must never create a row — no upsert option at all.
      expect(options?.upsert).toBeFalsy();
    });

    it("clearMeetingMark: $unset the mark, no upsert", async () => {
      await store.clearMeetingMark("agent-a", "sms:line-1:t1");
      const [filter, update, options] = mocks.updateOne.mock.calls[0]!;
      expect(filter).toEqual({ _id: KEY });
      expect(update).toEqual({ $unset: { meetingLastSeenTs: "" } });
      expect(options?.upsert).toBeFalsy();
    });

    it("get() surfaces the mark on tagged rows", async () => {
      mocks.findOne.mockResolvedValueOnce({ ...doc("s-1", "claude"), meetingLastSeenTs: "1700.0001" });
      await expect(store.get("agent-a", "sms:line-1:t1")).resolves.toEqual({
        sessionId: "s-1",
        provider: "claude",
        meetingLastSeenTs: "1700.0001",
      });
    });

    it("get() surfaces the mark on grandfathered legacy rows; absent field ⇒ undefined", async () => {
      mocks.findOne.mockResolvedValueOnce({
        ...doc("3f2a77aa-1111-4222-8333-444455556666"),
        meetingLastSeenTs: "1700.0002",
      });
      const ref = await store.get("agent-a", "sms:line-1:t1");
      expect(ref?.meetingLastSeenTs).toBe("1700.0002");

      mocks.findOne.mockResolvedValueOnce(doc("s-2", "claude"));
      const ref2 = await store.get("agent-a", "sms:line-1:t1");
      expect(ref2?.meetingLastSeenTs).toBeUndefined();
    });

    it("scrub branch returns NO mark even when the poisoned row carries one", async () => {
      mocks.findOne.mockResolvedValue({ ...doc("codex-pilot-9d0e"), meetingLastSeenTs: "1700.0003" });
      const ref = await store.get("agent-a", "sms:line-1:t1");
      // toEqual is strict about DEFINED extra keys — a leaked mark would fail this.
      expect(ref).toEqual({ sessionId: undefined, provider: undefined });
    });
  });
  ```

- [ ] **1f.** Verify:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  npm run typecheck   # expected: exit 0
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/session-store.test.ts
  # expected: Tests 22 passed (17 existing + 5 new)
  ```

- [ ] **1g.** Commit:

  ```bash
  git add src/agents/session-store.ts src/agents/session-store.test.ts
  git commit -m "feat(session-store): meetingLastSeenTs meeting-continuity mark (KPR-388)

  One optional field on SessionDoc/StoredSessionRef plus two narrow
  no-upsert methods (setMeetingMark / clearMeetingMark). Mark lifecycle ==
  session DOCUMENT lifecycle (same row, same 7d TTL, dies with
  delete/clearAgent/scrub); updatedAt untouched — TTL stays owned by turn
  persistence.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

## Task 2 — `ThreadMessage` carries raw Slack ts

File: `src/channels/slack-adapter.ts`

- [ ] **2a.** Replace the interface:

  ```ts
  export interface ThreadMessage {
    author: string;
    text: string;
    timestamp: Date;
    isBot: boolean;
  }
  ```

  with:

  ```ts
  export interface ThreadMessage {
    author: string;
    text: string;
    timestamp: Date;
    isBot: boolean;
    /** KPR-388: raw Slack ts (e.g. "1724632800.123456") — microsecond-precision
     *  delta comparisons; `timestamp`'s millisecond Date is not collision-safe.
     *  Carries the existing `msg.ts ?? "0"` posture: a hypothetical ts-less
     *  message sorts permanently below any mark (typing artifact, accepted). */
    ts: string;
  }
  ```

- [ ] **2b.** In `fetchThreadHistory`, replace the push:

  ```ts
          messages.push({
            author,
            text: msg.text ?? "",
            timestamp: new Date(parseFloat(msg.ts ?? "0") * 1000),
            isBot,
          });
  ```

  with:

  ```ts
          messages.push({
            author,
            text: msg.text ?? "",
            timestamp: new Date(parseFloat(msg.ts ?? "0") * 1000),
            isBot,
            ts: msg.ts ?? "0",
          });
  ```

- [ ] **2c.** Verify: `npm run typecheck` (exit 0) and the slack-adapter suite:

  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/slack-adapter.test.ts
  # expected: existing tests green (field is additive)
  ```

- [ ] **2d.** Commit:

  ```bash
  git add src/channels/slack-adapter.ts
  git commit -m "feat(slack-adapter): carry raw Slack ts on ThreadMessage (KPR-388)

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

## Task 3 — `resumedSession` plumbing (manager → TurnResult → RunResult)

Files: `src/agents/agent-manager.ts`, `src/agents/agent-runner.ts`, `src/channels/dispatcher.ts`, `src/agents/agent-manager.test.ts`

- [ ] **3a.** `src/agents/agent-manager.ts` — in `TurnResult`, after the `aborted?: boolean;` line, add:

  ```ts
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

- [ ] **3b.** In `spawnTurn`'s lambda, immediately after `const shaping = await this.prepareSpawn(effectiveCtx);`, add:

  ```ts
        // KPR-388: sessionId actually passed to the FINALIZED runOneSpawnAttempt
        // call — reassigned at each retry arm below. !!finalAttemptSessionId
        // becomes TurnResult.resumedSession. Initialized AFTER the KPR-313
        // guard and prepareSpawn, so a handoff-stripped (or adopt-branch)
        // sessionId is what's captured.
        let finalAttemptSessionId = effectiveCtx.sessionId;
  ```

- [ ] **3c.** In the auth-rebuild retry arm, insert the tracking line before the retry call. Replace:

  ```ts
            finalResult = await this.runOneSpawnAttempt(
              { ...effectiveCtx, sessionId: undefined },
              shaping,
              ticket,
              onStream,
            );
  ```

  with:

  ```ts
            finalAttemptSessionId = undefined;
            finalResult = await this.runOneSpawnAttempt(
              { ...effectiveCtx, sessionId: undefined },
              shaping,
              ticket,
              onStream,
            );
  ```

- [ ] **3d.** In the stale-handle self-heal arm, insert the tracking line before its retry call. Replace:

  ```ts
            finalResult = await this.runOneSpawnAttempt(
              { ...effectiveCtx, sessionId: adoptedSessionId },
              shaping,
              ticket,
              onStream,
            );
  ```

  with:

  ```ts
            finalAttemptSessionId = adoptedSessionId;
            finalResult = await this.runOneSpawnAttempt(
              { ...effectiveCtx, sessionId: adoptedSessionId },
              shaping,
              ticket,
              onStream,
            );
  ```

- [ ] **3e.** Update the single `finalizeSpawnResult` call site. First confirm it IS single: `grep -n "finalizeSpawnResult(" src/agents/agent-manager.ts` — expected: one call (in `spawnTurn`) + the definition. Replace:

  ```ts
        const turnResult = this.finalizeSpawnResult(effectiveCtx, finalResult, shaping.route);
  ```

  with:

  ```ts
        const turnResult = this.finalizeSpawnResult(
          effectiveCtx,
          finalResult,
          shaping.route,
          finalAttemptSessionId !== undefined,
        );
  ```

- [ ] **3f.** Update `finalizeSpawnResult`. Replace the signature:

  ```ts
    private finalizeSpawnResult(ctx: TurnContext, result: RunResult, route: ProviderModelRoute): TurnResult {
  ```

  with:

  ```ts
    private finalizeSpawnResult(
      ctx: TurnContext,
      result: RunResult,
      route: ProviderModelRoute,
      resumedSession: boolean,
    ): TurnResult {
  ```

  and in its returned object, after `aborted: result.aborted,`, add:

  ```ts
        resumedSession,
  ```

- [ ] **3g.** `src/agents/agent-runner.ts` — in `RunResult`, after `timedOut?: boolean; // KPR-306: …`, add:

  ```ts
    /** KPR-388: populated ONLY by the dispatcher's convertTurnResult mapping (TurnResult passthrough); runner/adapters never set it. */
    resumedSession?: boolean;
  ```

- [ ] **3h.** `src/channels/dispatcher.ts` — in `convertTurnResult`'s returned object, after `timedOut: turn.timedOut,`, add:

  ```ts
        // KPR-388: fresh-vs-resumed signal consumed by the conference
        // meeting-mark bookkeeping in dispatchToAgent.
        resumedSession: turn.resumedSession,
  ```

- [ ] **3i.** `src/agents/agent-manager.test.ts` — inside the `describe("spawnTurn (KPR-216)", …)` block, after the `describe("stale-handle self-heal (KPR-350 §D3)", …)` block, add:

  ```ts
      describe("TurnResult.resumedSession (KPR-388)", () => {
        const STALE = "Previous response with id 'resp_stale' not found.";
        function openai388(id = "openai-pilot") {
          registry._agents.set(
            id,
            makeAgentConfig({ id, name: "OpenAI Pilot", model: "openai/gpt-5.4-mini", coreServers: [] }),
          );
          return id;
        }

        it("true on a happy-path resume", async () => {
          const result = await manager.spawnTurn(
            smsCtx({ sessionId: "s1", threadId: "sms:line-1:kpr388-r1" }),
          );
          expect(result.resumedSession).toBe(true);
        });

        it("false on a first turn (no stored session)", async () => {
          const result = await manager.spawnTurn(
            smsCtx({ sessionId: undefined, threadId: "sms:line-1:kpr388-r2" }),
          );
          expect(result.resumedSession).toBe(false);
        });

        it("false after the auth-rebuild retry (finalized attempt ran fresh)", async () => {
          mockRunnerSend
            .mockResolvedValueOnce(
              makeRunResult({ error: "Could not resolve authentication method", sessionId: "" }),
            )
            .mockResolvedValueOnce(makeRunResult({ text: "ok after retry", sessionId: "session-retry" }));
          const result = await manager.spawnTurn(
            smsCtx({ sessionId: "stale-session", threadId: "sms:line-1:kpr388-r3" }),
          );
          expect(mockRunnerSend).toHaveBeenCalledTimes(2);
          expect(result.resumedSession).toBe(false);
        });

        it("false after the stale-handle self-heal fresh retry", async () => {
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "healed", sessionId: "resp-fresh" }));
          const result = await manager.spawnTurn(
            smsCtx({ agentId: openai388(), sessionId: "resp_stale", sessionProvider: "openai", threadId: "sms:line-1:kpr388-r4" }),
          );
          expect(mockOpenAIRunTurn).toHaveBeenCalledTimes(2);
          expect(result.resumedSession).toBe(false);
        });

        it("true after self-heal contender adoption (adopted handle counts as resumed)", async () => {
          const threadId = "sms:line-1:kpr388-r5";
          sessionStore._sessions.set(`openai-pilot:${threadId}`, { sessionId: "resp-contender", provider: "openai" });
          mockOpenAIRunTurn
            .mockResolvedValueOnce(makeRunResult({ error: STALE, sessionId: "resp_stale" }))
            .mockResolvedValueOnce(makeRunResult({ text: "adopted", sessionId: "resp-contender-2" }));
          const result = await manager.spawnTurn(
            smsCtx({ agentId: openai388(), sessionId: "resp_stale", sessionProvider: "openai", threadId }),
          );
          expect(mockOpenAIRunTurn.mock.calls[1]![0].sessionId).toBe("resp-contender");
          expect(result.resumedSession).toBe(true);
        });

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

  Note: `smsCtx` is the describe-scoped helper (accepts `sessionProvider`); `makeRunResult`, `registry._agents`, `sessionStore._sessions`, and the adapter mocks are all existing harness surfaces — no harness changes needed in this file.

- [ ] **3j.** Verify:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  npm run typecheck   # expected: exit 0
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
  # expected: all existing tests + 6 new pass
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts src/channels/dispatcher-conference.test.ts
  # expected: all existing tests pass (convertTurnResult mapping is additive)
  ```

- [ ] **3k.** Commit:

  ```bash
  git add src/agents/agent-manager.ts src/agents/agent-runner.ts src/channels/dispatcher.ts src/agents/agent-manager.test.ts
  git commit -m "feat(agent-manager): TurnResult.resumedSession — finalized-attempt resume signal (KPR-388)

  spawnTurn tracks the sessionId actually passed to the finalized
  runOneSpawnAttempt (auth-rebuild retry -> undefined; KPR-350 self-heal ->
  the adopted handle or undefined) and finalizeSpawnResult surfaces
  resumedSession on TurnResult; convertTurnResult passes it through on
  RunResult (type-only there — runner/adapters never set it). Closes the
  delta-into-fresh detection hole for the conference mark bookkeeping.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

## Task 4 — Dispatcher read side: per-agent full/delta conference context

Files: `src/channels/dispatcher.ts`, `src/channels/dispatcher-conference.test.ts` (harness only)

- [ ] **4a.** Extend `ResolvedAgent`. Replace the interface with:

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
    /** KPR-388: how threadContext was assembled — full transcript or delta since the mark. */
    injectionMode?: "full" | "delta";
    /** KPR-388: max Slack ts (raw string) covered by this turn's injection; the mark advances to it on success. */
    injectionHighWaterTs?: string;
  }
  ```

- [ ] **4b.** Add a module-level helper (after the `NON_RESPONSE_PATTERNS` const, before `ResolvedAgent`):

  ```ts
  /** KPR-388: max of raw Slack ts strings by numeric value; undefined when none present. */
  function maxSlackTs(candidates: Array<string | undefined>): string | undefined {
    let best: string | undefined;
    for (const ts of candidates) {
      if (!ts) continue;
      if (best === undefined || parseFloat(ts) > parseFloat(best)) best = ts;
    }
    return best;
  }
  ```

- [ ] **4c.** In `resolveConferenceAgents`, keep the raw history instead of the shared context. Replace:

  ```ts
      // Fetch thread context for injection and classifier recency
      let threadContext = "";
      let recentMessages = "";
      if (this.slackAdapter) {
        const channelId = item.source.id;
        const threadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string) ?? threadId;
        const history = await this.slackAdapter.fetchThreadHistory(channelId, threadTs);
        threadContext = this.formatThreadContext(history, item.source.label, rosterMembers);
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

- [ ] **4d.** Replace the method's return block:

  ```ts
      return classification.respondAgentIds.map((agentId) => ({
        agentId,
        conferenceMode: true,
        conferenceHumanTs: humanTs,
        conferenceRound: 0,
        threadContext,
        meetingPreamble: preamble,
      }));
  ```

  with:

  ```ts
      // KPR-388: per-agent injection context — delta for agents with meeting
      // continuity, full transcript otherwise. Round-0 maxes the trigger's own
      // ts into the high-water mark (BOTH modes): the terminal slot presents
      // the trigger, so the session absorbs it even when the fetch raced it.
      return Promise.all(
        classification.respondAgentIds.map(async (agentId): Promise<ResolvedAgent> => {
          const injection = await this.buildConferenceContext(
            agentId,
            threadId,
            history,
            item.source.label,
            rosterMembers,
            humanTs,
          );
          return {
            agentId,
            conferenceMode: true,
            conferenceHumanTs: humanTs,
            conferenceRound: 0,
            threadContext: injection.threadContext,
            meetingPreamble: preamble,
            injectionMode: injection.injectionMode,
            injectionHighWaterTs: injection.injectionHighWaterTs,
          };
        }),
      );
  ```

- [ ] **4e.** Refactor `formatThreadContext`'s truncation into a shared helper (output byte-identical — same messages, same order). Replace:

  ```ts
    private formatThreadContext(history: ThreadMessage[], channelName: string, roster: RosterMember[]): string {
      if (history.length === 0) return "";

      const participantNames = roster.map((r) => r.name).join(", ");
      const header = `[Meeting thread in #${channelName} — participants: ${participantNames}]`;

      // If thread is very long, include first 5 + last 100 messages
      let messages = history;
      if (history.length > 105) {
        const first = history.slice(0, 5);
        const last = history.slice(-100);
        messages = [...first, ...last];
      }

      const formatted = messages
        .map((m) => {
          const ago = this.formatTimeAgo(m.timestamp);
          return `${m.author} (${ago}): ${m.text}`;
        })
        .join("\n");

      return `${header}\n\n${formatted}`;
    }
  ```

  with:

  ```ts
    private formatThreadContext(history: ThreadMessage[], channelName: string, roster: RosterMember[]): string {
      if (history.length === 0) return "";

      const participantNames = roster.map((r) => r.name).join(", ");
      const header = `[Meeting thread in #${channelName} — participants: ${participantNames}]`;

      const formatted = this.truncateHistory(history)
        .map((m) => {
          const ago = this.formatTimeAgo(m.timestamp);
          return `${m.author} (${ago}): ${m.text}`;
        })
        .join("\n");

      return `${header}\n\n${formatted}`;
    }

    /** If thread is very long, include first 5 + last 100 messages (KPR-388: shared with the high-water calc). */
    private truncateHistory(history: ThreadMessage[]): ThreadMessage[] {
      if (history.length <= 105) return history;
      return [...history.slice(0, 5), ...history.slice(-100)];
    }
  ```

- [ ] **4f.** Add `buildConferenceContext` and `formatDeltaContext` (after `formatThreadContext`/`truncateHistory`, before `formatTimeAgo`):

  ```ts
    /**
     * KPR-388: per-agent conference injection context. Delta iff ALL hold:
     * the stored ref has a resumable sessionId (excludes no-row, TTL'd,
     * scrubbed, empty-handle/codex rows), the stored provider matches the
     * agent's current provider (else spawnTurn's KPR-313 guard runs the turn
     * fresh with a handoff notice — full injection is the correct pairing),
     * and a meeting mark exists. Every miss ⇒ full transcript, byte-identical
     * to the pre-KPR-388 shared context (C6 pin).
     */
    private async buildConferenceContext(
      agentId: string,
      threadId: string,
      history: ThreadMessage[],
      channelName: string,
      roster: RosterMember[],
      roundZeroTriggerTs?: string,
    ): Promise<{ threadContext: string; injectionMode: "full" | "delta"; injectionHighWaterTs?: string }> {
      const ref = await this.agentManager.getSessionStore().get(agentId, threadId);
      const provider = this.agentManager.providerFor(agentId);
      if (!ref?.sessionId || !ref.meetingLastSeenTs || ref.provider !== provider) {
        return {
          threadContext: this.formatThreadContext(history, channelName, roster),
          injectionMode: "full",
          injectionHighWaterTs: maxSlackTs([
            ...this.truncateHistory(history).map((m) => m.ts),
            roundZeroTriggerTs,
          ]),
        };
      }

      const markNum = parseFloat(ref.meetingLastSeenTs);
      // Strictly greater than the mark; same 100-cap as truncateHistory's tail.
      // No first-5 pin — the session already holds the thread opening (covering
      // invariant, spec §5). An empty delta yields threadContext "" — dropped by
      // dispatchToAgent's filter(Boolean) join; the terminal slot still carries
      // the trigger (round-0) or peer reply (round-1), so it is always safe.
      const delta = history.filter((m) => parseFloat(m.ts) > markNum).slice(-100);
      return {
        threadContext: delta.length > 0 ? this.formatDeltaContext(delta, channelName, roster) : "",
        injectionMode: "delta",
        injectionHighWaterTs: maxSlackTs([...delta.map((m) => m.ts), roundZeroTriggerTs]),
      };
    }

    /**
     * KPR-388: delta-mode context — same header and body format as
     * formatThreadContext, headed as a delta. MUST NOT contain the
     * terminal-slot marker "[New message]:" (the C3 framing test's negative
     * assertions depend on its absence).
     */
    private formatDeltaContext(delta: ThreadMessage[], channelName: string, roster: RosterMember[]): string {
      const participantNames = roster.map((r) => r.name).join(", ");
      const header = `[Meeting thread in #${channelName} — participants: ${participantNames}]`;
      const formatted = delta
        .map((m) => {
          const ago = this.formatTimeAgo(m.timestamp);
          return `${m.author} (${ago}): ${m.text}`;
        })
        .join("\n");
      return `${header}\n[New messages since your last turn:]\n\n${formatted}`;
    }
  ```

- [ ] **4g.** Rewire `triggerConferenceReactions`. Replace the context re-fetch block:

  ```ts
      // Re-fetch thread context (now includes the round-0 response)
      let threadContext = "";
      let preamble = "";
      if (this.slackAdapter) {
        const channelId = originalItem.source.id;
        const threadTs =
          (originalItem.meta?.slackThreadTs as string) ?? (originalItem.meta?.slackTs as string) ?? threadId;
        const history = await this.slackAdapter.fetchThreadHistory(channelId, threadTs);
        const allRosterMembers: RosterMember[] = [];
        for (const agentId of roster) {
          const agent = this.registry.get(agentId);
          if (!agent || agent.disabled) continue;
          allRosterMembers.push({
            agentId: agent.id,
            name: agent.name,
            title: agent.title,
            role: agent.soul.split("\n")[0],
          });
        }
        threadContext = this.formatThreadContext(history, originalItem.source.label, allRosterMembers);
        preamble = this.buildMeetingPreamble(originalItem.source.label, allRosterMembers);
      }
  ```

  with:

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
          const agent = this.registry.get(agentId);
          if (!agent || agent.disabled) continue;
          allRosterMembers.push({
            agentId: agent.id,
            name: agent.name,
            title: agent.title,
            role: agent.soul.split("\n")[0],
          });
        }
        preamble = this.buildMeetingPreamble(originalItem.source.label, allRosterMembers);
      }
  ```

  and the dispatch construction:

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

  with:

  ```ts
      // Dispatch reactions concurrently (peers already claimed in reacted set above)
      const responderName = this.registry.get(respondingAgentId)?.name ?? respondingAgentId;
      const reactionDispatches = classification.respondAgentIds.map(async (agentId) => {
        // KPR-388: per-reactor full/delta decision. No trigger max-in on
        // round-1 — new content reaches the mark only via the re-fetched
        // transcript (the peer reply's ts is not knowable here).
        const injection = await this.buildConferenceContext(
          agentId,
          threadId,
          history,
          originalItem.source.label,
          allRosterMembers,
        );
        const resolved: ResolvedAgent = {
          agentId,
          conferenceMode: true,
          conferenceHumanTs: humanTs,
          conferenceRound: 1,
          threadContext: injection.threadContext,
          meetingPreamble: preamble,
          injectionMode: injection.injectionMode,
          injectionHighWaterTs: injection.injectionHighWaterTs,
          reactionTo: { authorName: responderName, text: responseText },
        };
        return this.dispatchToAgent(originalItem, resolved);
      });
  ```

  (`await Promise.all(reactionDispatches);` below stays as-is.)

- [ ] **4h.** Harness extension — `src/channels/dispatcher-conference.test.ts`: the dispatcher now calls `agentManager.getSessionStore().get(...)` and `providerFor(...)` on every conference resolve, so the mock must provide them **in this same commit** or all 9 existing tests crash. Replace `makeMockAgentManager`:

  ```ts
  function makeMockAgentManager() {
    // KPR-388: minimal session-store surface for the read-side delta decision
    // and write-side mark bookkeeping. Tests seed _sessionRefs per
    // "{agentId}:{threadId}"; unseeded agents get undefined ⇒ full injection.
    const sessionRefs = new Map<
      string,
      { sessionId?: string; provider?: string; meetingLastSeenTs?: string }
    >();
    const sessionStore = {
      get: vi.fn().mockImplementation(async (agentId: string, threadId: string) =>
        sessionRefs.get(`${agentId}:${threadId}`),
      ),
      setMeetingMark: vi.fn().mockResolvedValue(undefined),
      clearMeetingMark: vi.fn().mockResolvedValue(undefined),
    };
    return {
      runWorkItemTurn: vi.fn().mockResolvedValue({
        finalMessage: "Agent response",
        newSessionId: "s2",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindow: 0,
          costUsd: 0.01,
          durationMs: 1000,
        },
        errors: [],
        llmMs: 0,
        toolMs: 0,
        toolCalls: 0,
        toolSummary: null,
        streamed: false,
        compactions: 0,
      }),
      findAgentForThread: vi.fn().mockResolvedValue(null),
      findAgentsForThread: vi.fn().mockResolvedValue([]),
      getSessionStore: () => sessionStore,
      providerFor: vi.fn().mockReturnValue("claude"),
      // Dormant breaker surface — only the outage-placement test flips it open.
      circuitBreakers: { stateFor: vi.fn().mockReturnValue({ state: "closed", enabled: true }) },
      _sessionRefs: sessionRefs,
      _sessionStore: sessionStore,
    };
  }
  ```

  No other test edits in this task — the 9 existing tests must pass **unmodified** (all agents unseeded ⇒ full mode ⇒ byte-identical output). Note for Task 5: once the write side lands there, the default `runWorkItemTurn` success triggers `setMeetingMark` spy calls that nothing asserts on — expected.

- [ ] **4i.** Verify:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  npm run typecheck   # expected: exit 0
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts src/channels/dispatcher.test.ts
  # expected: all existing tests pass — 9 conference (incl. the C6 byte pin, UNMODIFIED) + full dispatcher suite
  ```

- [ ] **4j.** Commit:

  ```bash
  git add src/channels/dispatcher.ts src/channels/dispatcher-conference.test.ts
  git commit -m "feat(dispatcher): per-agent delta/full conference context (read side, KPR-388)

  resolveConferenceAgents and triggerConferenceReactions keep one
  fetchThreadHistory per trigger but derive a per-agent context via
  buildConferenceContext: delta (messages with ts strictly greater than the
  agent's meetingLastSeenTs, 100-cap) iff the agent holds a resumable
  same-provider session AND a mark; full transcript byte-identical to
  today on every miss. ResolvedAgent carries injectionMode +
  injectionHighWaterTs (round-0 maxes in the trigger ts, both modes).
  Prompt join and terminal slot untouched (C3/C6).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

## Task 5 — Dispatcher write side: mark bookkeeping + C3 comment update

File: `src/channels/dispatcher.ts`

- [ ] **5a.** Update the C3 rationale comment in `dispatchToAgent` (spec §5/§6/§8 — explicit generalization, not a contradiction). Replace:

  ```ts
        // KPR-387: round-1 reaction turns are framed against the peer reply — the
        // original human message is never re-presented in the terminal slot (it
        // remains available via the re-fetched transcript in threadContext).
  ```

  with:

  ```ts
        // KPR-387: round-1 reaction turns are framed against the peer reply — the
        // original human message is never re-presented in the terminal slot. It
        // remains reachable via session ∪ injected context (KPR-388 generalizes
        // the old re-fetched-transcript guarantee): a round-1 reactor was never a
        // round-0 responder for this trigger (C1/C2), so its mark predates the
        // triggering message — the message is in its delta, or already in its
        // session by the covering invariant. A reactor with no session/mark gets
        // the full transcript directly.
  ```

- [ ] **5b.** Insert the mark bookkeeping in `dispatchToAgent`, immediately after the replay-failure gate and before `const trimmedText = ...`. Replace:

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

        // KPR-388: meeting-continuity mark bookkeeping. Sits AFTER the outage
        // gates (a queued/fast-failed turn must not touch the mark) and OUTSIDE
        // the isNonResponse branch below — a suppressed turn consumed its
        // injection all the same (C2's "responded or selected" spirit).
        // Error/aborted turns leave the mark untouched: session absorption is
        // unknown, and a stale-low mark only over-includes next turn
        // (duplication, never a gap — covering invariant, spec §5). Both store
        // methods are withRetry fail-soft and never throw.
        if (resolved.conferenceMode && !runResult.error && !runResult.aborted) {
          const sessionStore = this.agentManager.getSessionStore();
          if (resolved.injectionMode === "delta" && runResult.resumedSession === false) {
            // Delta went into a fresh session — continuity broke after
            // injection was baked. Clear the mark: the NEXT turn injects the
            // full transcript and heals (same-turn re-injection is impossible
            // by construction — retries reuse the already-shaped prompt).
            await sessionStore.clearMeetingMark(agentId, threadId);
          } else if (resolved.injectionHighWaterTs) {
            await sessionStore.setMeetingMark(agentId, threadId, resolved.injectionHighWaterTs);
          }
        }

        const trimmedText = runResult.text.trim();
  ```

  (`threadId` is the existing local computed above as `effectiveItem.threadId ?? effectiveItem.id` — the same formula `runWorkItemTurn` uses for the store key; round-1 dispatches `originalItem` unchanged per C3, so the key matches. Do NOT recompute it.)

- [ ] **5c.** Verify:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  npm run typecheck   # expected: exit 0
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts src/channels/dispatcher.test.ts
  # expected: all existing tests still pass (mark spies absorb the new calls)
  ```

- [ ] **5d.** Commit:

  ```bash
  git add src/channels/dispatcher.ts
  git commit -m "feat(dispatcher): meeting-mark bookkeeping after conference turns (write side, KPR-388)

  After the KPR-307 outage gates, gated on conferenceMode && !error &&
  !aborted and including suppressed non-response turns: advance the mark to
  injectionHighWaterTs, or clear it when a delta injection landed in a
  fresh session (resumedSession === false) so the next turn heals with the
  full transcript. Error/aborted/queued turns leave the mark untouched.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

## Task 6 — Conference regression tests (delta pin, miss matrix, mark semantics, C3, empty delta)

File: `src/channels/dispatcher-conference.test.ts` — add a **nested** describe at the end of the existing `describe("Conference channel routing", …)` block (inherits the outer `beforeEach`), plus one import.

- [ ] **6a.** Add to the imports at the top of the file:

  ```ts
  import { OutageEpisodeTracker } from "../outage/outage-notices.js";
  ```

- [ ] **6b.** Append the nested describe (before the outer describe's closing `});`). COMPLETE code:

  ```ts
    describe("delta context injection (KPR-388)", () => {
      // NOTE: continuation lines are deliberately flush-left inside the
      // backticks — the preamble byte pin breaks on any leading whitespace.
      const PREAMBLE = (channel: string, names: string) => `You are in a meeting in #${channel} with ${names}.

Meeting rules:
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- If you have nothing meaningful to add, respond with "No response needed."
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;

      const seedRef = (
        agentId: string,
        threadId: string,
        ref: { sessionId?: string; provider?: string; meetingLastSeenTs?: string },
      ) => agentManager._sessionRefs.set(`${agentId}:${threadId}`, ref);

      // ts drives delta filtering (raw string); timestamp only drives the
      // "(N min ago)" display label — minute granularity keeps byte pins
      // deterministic without fake timers (stable unless the test stalls ~60s).
      const makeHistory = (
        entries: Array<{ author: string; text: string; ts: string; minAgo?: number; isBot?: boolean }>,
      ) =>
        entries.map((e) => ({
          author: e.author,
          text: e.text,
          ts: e.ts,
          timestamp: new Date(Date.now() - (e.minAgo ?? 5) * 60_000),
          isBot: e.isBot ?? false,
        }));

      function soloClassifier() {
        // Round-0 selects jasper; any reaction pass selects nobody.
        return import("../agents/meeting-classifier.js").then(({ classifyMeetingMessage }) => {
          (classifyMeetingMessage as any)
            .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
            .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });
        });
      }

      const THREE_MSG_HISTORY = () =>
        makeHistory([
          { author: "May", text: "old message", ts: "1000.0001", minAgo: 10 },
          { author: "Jasper", text: "old reply", ts: "1000.0002", minAgo: 8, isBot: true },
          { author: "May", text: "newer message", ts: "1000.0003", minAgo: 5 },
        ]);

      it("delta injection: resumable same-provider ref + mark ⇒ only ts>mark messages, byte-exact shape (KPR-388 delta pin)", async () => {
        await soloClassifier();
        const threadId = "conf-thread-delta-pin";
        seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0002" });
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

        const item = makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-delta" },
          threadId,
          meta: { slackTs: "1000.0004" },
        });
        await dispatcher.dispatch(item);

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1);
        const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];

        // Sibling of the C6 round-0 pin: the delta-mode prompt shape, byte-exact.
        // "old message"/"old reply" (ts <= mark, strictly-greater rule) are gone;
        // the join and terminal slot are identical to full mode.
        const expectedDelta =
          `[Meeting thread in #conf-delta — participants: Jasper]\n` +
          `[New messages since your last turn:]\n\n` +
          `May (5 min ago): newer message`;
        expect(turnItem.text).toBe(
          `${PREAMBLE("conf-delta", "Jasper")}\n${expectedDelta}\n---\n[New message]:\n${item.text}`,
        );
      });

      it.each([
        ["no session row", undefined],
        ["empty handle (codex-shaped row)", { sessionId: undefined, provider: "codex", meetingLastSeenTs: "1000.0002" }],
        ["provider mismatch", { sessionId: "resp_1", provider: "openai", meetingLastSeenTs: "1000.0002" }],
        ["missing mark", { sessionId: "sess-1", provider: "claude" }],
      ])("full injection on read-side miss: %s", async (_label, ref) => {
        await soloClassifier();
        const threadId = `conf-thread-miss-${_label.replace(/\W+/g, "-")}`;
        if (ref) seedRef("jasper", threadId, ref as any);
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

        const item = makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-miss" },
          threadId,
          meta: { slackTs: "1000.0004" },
        });
        await dispatcher.dispatch(item);

        const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
        // Full transcript: pre-mark content present, delta header absent.
        expect(turnItem.text).toContain("old message");
        expect(turnItem.text).toContain("newer message");
        expect(turnItem.text).not.toContain("[New messages since your last turn:]");
      });

      it("full-mode success advances the mark to max(injected ts, trigger ts)", async () => {
        await soloClassifier();
        const threadId = "conf-thread-mark-full";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, next steps?",
            source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
            threadId,
            meta: { slackTs: "1000.0009" }, // trigger ts > all fetched history — the max-in must win
          }),
        );

        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0009");
        expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
      });

      it("delta-mode success advances the mark to max(injected delta ts, trigger ts)", async () => {
        await soloClassifier();
        const threadId = "conf-thread-mark-delta";
        seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0002" });
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(
          makeHistory([
            { author: "May", text: "old message", ts: "1000.0001", minAgo: 10 },
            { author: "May", text: "newest message", ts: "1000.0010", minAgo: 2 },
          ]),
        );

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, next steps?",
            source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
            threadId,
            meta: { slackTs: "1000.0009" }, // delta max (1000.0010) > trigger — injected max must win
          }),
        );

        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0010");
        expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
      });

      it("suppressed non-response still advances the mark (injection was consumed)", async () => {
        await soloClassifier();
        const threadId = "conf-thread-mark-suppressed";
        agentManager.runWorkItemTurn.mockResolvedValueOnce({
          finalMessage: "No response needed.",
          newSessionId: "s2",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 0, costUsd: 0.01, durationMs: 100 },
          errors: [],
          llmMs: 0, toolMs: 0, toolCalls: 0, toolSummary: null, streamed: false, compactions: 0,
        });
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, next steps?",
            source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );

        expect(adapter.deliver).not.toHaveBeenCalled(); // suppression semantics intact
        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0004");
      });

      it("error and aborted turns leave the mark untouched", async () => {
        const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
        (classifyMeetingMessage as any).mockResolvedValue({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 });
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());
        const base = {
          finalMessage: "partial",
          newSessionId: "s2",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 0, costUsd: 0.01, durationMs: 100 },
          llmMs: 0, toolMs: 0, toolCalls: 0, toolSummary: null, streamed: false, compactions: 0,
        };

        agentManager.runWorkItemTurn.mockResolvedValueOnce({ ...base, errors: ["boom"] });
        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, next steps?",
            source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
            threadId: "conf-thread-mark-error",
            meta: { slackTs: "1000.0004" },
          }),
        );

        agentManager.runWorkItemTurn.mockResolvedValueOnce({ ...base, errors: [], aborted: true });
        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, next steps?",
            source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
            threadId: "conf-thread-mark-aborted",
            meta: { slackTs: "1000.0005" },
          }),
        );

        expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalled();
        expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
      });

      it("outage-queued turn never touches the mark (bookkeeping sits after the KPR-307 gates)", async () => {
        await soloClassifier();
        const threadId = "conf-thread-mark-outage";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());

        // Arm the outage seam: open enabled breaker + queue deps.
        agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
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

        agentManager.runWorkItemTurn.mockResolvedValueOnce({
          finalMessage: "",
          newSessionId: "s2",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 0, costUsd: 0, durationMs: 100 },
          errors: ["connect ECONNREFUSED api"], // hard fault ⇒ outage path handles the turn
          llmMs: 0, toolMs: 0, toolCalls: 0, toolSummary: null, streamed: false, compactions: 0,
        });

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, next steps?",
            source: { kind: "slack", id: "C-CONF", label: "conf-mark" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );

        expect(outageStore.enqueue).toHaveBeenCalledTimes(1); // the turn WAS queued...
        expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalled(); // ...and never reached the mark site
        expect(agentManager._sessionStore.clearMeetingMark).not.toHaveBeenCalled();
      });

      it("delta into a fresh session clears the mark (resumedSession === false), no set", async () => {
        await soloClassifier();
        const threadId = "conf-thread-clear";
        seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0002" });
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValueOnce({
          finalMessage: "Agent response",
          newSessionId: "s-fresh",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 0, costUsd: 0.01, durationMs: 100 },
          errors: [],
          llmMs: 0, toolMs: 0, toolCalls: 0, toolSummary: null, streamed: false, compactions: 0,
          resumedSession: false, // stale-handle self-heal / auth-rebuild ran the turn fresh
        });

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, next steps?",
            source: { kind: "slack", id: "C-CONF", label: "conf-clear" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );

        expect(agentManager._sessionStore.clearMeetingMark).toHaveBeenCalledWith("jasper", threadId);
        expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalled();
      });

      it("C3: round-1 reactor's delta contains the triggering human message (mark predates it)", async () => {
        const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
        (classifyMeetingMessage as any)
          .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
          .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

        const threadId = "conf-thread-c3-delta";
        // Jessica sat out this trigger (C1/C2) — her mark predates the human message.
        seedRef("jessica", threadId, { sessionId: "sess-j", provider: "claude", meetingLastSeenTs: "1000.0001" });
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(
          makeHistory([
            { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
            { author: "May", text: "please weigh in on the Q3 roadmap", ts: "1000.0005", minAgo: 5 },
            { author: "Jasper", text: "Agent response", ts: "1000.0006", minAgo: 4, isBot: true },
          ]),
        );

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, and Jessica, please weigh in on the Q3 roadmap",
            source: { kind: "slack", id: "C-CONF", label: "conf-c3" },
            threadId,
            meta: { slackTs: "1000.0005" },
          }),
        );

        const round1Call = () =>
          agentManager.runWorkItemTurn.mock.calls.find((c: any[]) => c[1]?.meta?.conferenceRound === 1);
        await vi.waitFor(() => {
          expect(round1Call()).toBeDefined();
        });
        // Drain the round-1 turn's post-turn bookkeeping too.
        await vi.waitFor(() => {
          expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jessica", threadId, "1000.0006");
        });

        const [reactorId, round1Item] = round1Call()!;
        expect(reactorId).toBe("jessica");
        expect(round1Item.text).toContain("[New messages since your last turn:]");
        expect(round1Item.text).toContain("please weigh in on the Q3 roadmap"); // C3 reachability via delta
        expect(round1Item.text).not.toContain("kickoff notes"); // ts == mark ⇒ excluded (strictly-greater pin)
        expect(round1Item.text).toContain("[Jasper just replied]:"); // terminal slot untouched (C3)
      });

      it("C3: round-1 reactor with no session gets the full transcript", async () => {
        const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
        (classifyMeetingMessage as any)
          .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
          .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

        const threadId = "conf-thread-c3-full";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(
          makeHistory([
            { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
            { author: "May", text: "please weigh in on the Q3 roadmap", ts: "1000.0005", minAgo: 5 },
          ]),
        );

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, and Jessica, please weigh in on the Q3 roadmap",
            source: { kind: "slack", id: "C-CONF", label: "conf-c3" },
            threadId,
            meta: { slackTs: "1000.0005" },
          }),
        );

        const round1Call = () =>
          agentManager.runWorkItemTurn.mock.calls.find((c: any[]) => c[1]?.meta?.conferenceRound === 1);
        await vi.waitFor(() => {
          expect(round1Call()).toBeDefined();
        });

        const [, round1Item] = round1Call()!;
        expect(round1Item.text).toContain("kickoff notes"); // full transcript carries the whole thread
        expect(round1Item.text).not.toContain("[New messages since your last turn:]");
      });

      it("empty delta drops the context segment — byte-equal to the pinned empty-history join; mark still advances to the trigger", async () => {
        await soloClassifier();
        const threadId = "conf-thread-empty-delta";
        seedRef("jasper", threadId, { sessionId: "sess-1", provider: "claude", meetingLastSeenTs: "1000.0009" });
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(THREE_MSG_HISTORY()); // all ts <= mark

        const item = makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-empty" },
          threadId,
          meta: { slackTs: "1000.0010" },
        });
        await dispatcher.dispatch(item);

        const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
        // Degenerates to exactly the C6-pinned empty-history shape.
        expect(turnItem.text).toBe(`${PREAMBLE("conf-empty", "Jasper")}\n---\n[New message]:\n${item.text}`);
        // The terminal slot showed the trigger, so the session absorbed it.
        expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jasper", threadId, "1000.0010");
      });
    });
  ```

  Implementation notes (verified against the harness):
  - The nested describe inherits the outer `beforeEach` (fresh dispatcher/mocks per test; `vi.clearAllMocks()` clears call history).
  - The trigger texts (`"Jasper, next steps?"`, `"Jasper, and Jessica, …"`) match the mock registry's name regex (name followed by a comma) so rosters resolve deterministically.
  - `PREAMBLE`'s continuation lines MUST stay flush-left inside the backticks (the source literal has no indentation) — transcribe exactly as shown above.
  - The `resumedSession: false` turn object is the only place a test sets the field; the default mock omits it (⇒ `undefined` ⇒ mark **advances**), pinning the undefined-tolerant write rule.

- [ ] **6c.** Run:

  ```bash
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
  # expected: Tests 23 passed (9 existing UNMODIFIED + 14 new)
  ```

- [ ] **6d.** Commit:

  ```bash
  git add src/channels/dispatcher-conference.test.ts
  git commit -m "test(dispatcher): delta context injection regression suite (KPR-388)

  Delta-shape byte pin (sibling of the C6 round-0 pin), full-injection miss
  matrix, mark advance/clear semantics incl. trigger max-in and suppressed
  non-response, outage-gate placement, C3 round-1 reachability via delta,
  empty-delta degeneration to the pinned empty-history join.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

## Task 7 — Negative verify (mandatory; evidence for PR)

Per `feedback_negative_verify_regression_tests`: prove the new regression tests fail against pre-KPR-388 product code. Product baseline is `e19ea3a` (the spec-signoff commit — no KPR-388 product code).

- [ ] **7a.** Revert the five product files only (tests stay at HEAD), single bash call:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  git checkout e19ea3a -- src/channels/dispatcher.ts src/agents/agent-manager.ts src/agents/session-store.ts src/channels/slack-adapter.ts src/agents/agent-runner.ts
  git status --short   # expected: exactly the 5 files listed as modified
  ```

- [ ] **7b.** Run the three suites against pre-fix code — **expected: exit non-zero** with the behavior-bearing new tests failing:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts src/agents/session-store.test.ts src/agents/agent-manager.test.ts
  ```

  Expected FAILURES (record the list):
  - dispatcher: the delta byte pin; both mark-advance tests; the suppressed-non-response advance; the clear test; the C3-delta test; the empty-delta pin (old code injects the full transcript and never calls the mark spies).
  - session-store: 4 of the 5 new tests (`setMeetingMark`/`clearMeetingMark` don't exist ⇒ TypeError; the two mark-surfacing `toEqual`s miss the key). The scrub test is NOT among them — see expected passes.
  - agent-manager: all 6 `resumedSession` tests (`undefined` is neither `true` nor `false`).

  Expected PASSES among the new tests (behavior-preserving pins — not vacuous; their bite pairs with the delta pin and the C6 sibling): the 4 miss-matrix cases, error/aborted-untouched, outage-untouched, round-1 no-session full, and the session-store scrub test (pre-fix `normalizeRef`'s scrub branch already returns `{ sessionId: undefined, provider: undefined }`, satisfying its `toEqual` — it is a guard pin, not a regression test). All 9+17 pre-existing tests must also pass. If any test expected to fail PASSES, it is vacuous — fix the test, do not proceed.

- [ ] **7c.** Restore and confirm green:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  git checkout HEAD -- src/channels/dispatcher.ts src/agents/agent-manager.ts src/agents/session-store.ts src/channels/slack-adapter.ts src/agents/agent-runner.ts
  git status --short   # expected: clean
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts src/agents/session-store.test.ts src/agents/agent-manager.test.ts
  # expected: all tests pass
  ```

- [ ] **7d.** Record the evidence: save the 7b failure output (test names + failing assertions) and the 7c pass output for the PR body. No commit for this task.

## Task 8 — `docs/providers.md` check + full sweep

- [ ] **8a.** Verify the parity matrix needs no row edit (spec §7): read `docs/providers.md` session-related rows. No provider behavior changes in this ticket (the delta/full choice is prompt assembly keyed off existing surfaces; codex keeps full injection by the natural read-side miss). Expected outcome: **no edit**; record a one-line note for the PR body ("providers.md checked — no behavior rows affected; if review disagrees, the fix is a one-line note in the session column").

- [ ] **8b.** Full gate:

  ```bash
  cd /Users/mokie/github/hive-KPR-386
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
  # expected: typecheck 0 errors, eslint clean, prettier clean, all vitest suites pass
  ```

  If prettier flags touched files, run `npm run format`, re-run check, and commit as `style: prettier (KPR-388)`. (The husky pre-commit hook runs lint-staged — if a commit already reformatted staged files, this step may be a no-op.)

- [ ] **8c.** Confirm working tree clean and all 6 task commits reference KPR-388 (`git log --oneline e19ea3a..HEAD`).

---

## Out of scope (guard rails — from spec Non-goals; do not touch)

- **Codex delta** — no second continuity signal, no `provider_turn_history` wiring; codex hits full injection via the natural `sessionId: undefined` miss. Do not special-case it anywhere.
- **Scribe/summary anchoring (KPR-390)** — the full-mode arm of `buildConferenceContext` is its future hook; leave no scaffolding.
- **Preamble deduplication/slimming** — `buildMeetingPreamble` output and its every-turn injection (incl. delta turns) are untouched (C4).
- **KPR-389 scope** — `conferenceRound` spawn shaping, preamble hardening, telemetry stamping; the existing round-0 byte pin remains KPR-389's to edit, not ours.
- **Classifier** — `classifyMeetingMessage` prompt/signature/`recentMessages` (resolve-time last-5) unchanged.
- **No** transcript-cap changes beyond reusing the existing 100/105 constants, no staleness culling, no working indicator, no tool-inventory restriction.
- **No** provider-adapter, `SESSION_SEMANTICS`, breaker, or outage-queue changes; no new collections, config keys, or indexes; no `$max` mark enforcement (plan-fixed: plain `$set`, regression benign per spec §5).
- **No** changes to `sessions` TTL/`updatedAt` handling — the mark methods deliberately do not touch `updatedAt`.
- Session-store `set()`/`delete()`/`clearAgent()`/scrub logic unchanged beyond the additive mark surfacing.
