# KPR-416 — Reaction-exclusion tracker: relocate the eligibility write to delivery time — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Spec:** `docs/epics/kpr-415/kpr-416-spec.md` (spec-ready, clean, spec-review r1). The spec is authoritative on every design question; this plan implements it and does not re-open it. Where the spec departs from the governing epic design (§6.1, write predicate), the spec wins.
**Epic:** KPR-415 (Meeting mode hardening) · Child A · **Downstream:** KPR-417 blocks on this; land A first (spec §11).
**Baseline:** worktree `hive-KPR-415`, branch `KPR-415` at `a5382c7` (this plan's own commit; the source tree is identical to `0ed653d`, which is what the line citations were taken against). All line citations below were re-verified against this tree on 2026-08-28 and match the spec's. **Re-check every number against the live tree before editing — anchor on quoted text, not on the number.**

**Goal:** Move the single eligibility-deciding `meetingReactionTracker` write from classifier-selection time to delivery time, so a round-0 primary whose turn was *suppressed* becomes eligible to react to a slower peer's later reply — while every other round-0 outcome keeps today's exclusion.

**Architecture:** One private synchronous helper (`markReactionExclusion`) keyed on a new, deliberately non-`conference*`-named `meta.meetingExclusionTs` (stamped round-0-only in `dispatchToAgent`'s conference meta block, so it survives KPR-413's four-key continuation-leg strip), called from exactly three physical delivery sites: the fan-out delivery branch, the single-dispatch delivery branch (which covers both KPR-307 outage replays and KPR-402 continuation legs), and `handleTurnFailure`'s `if (adapter)` arm. The selection-time write in `resolveConferenceAgents` is deleted; `triggerConferenceReactions` is untouched.

**Tech Stack:** TypeScript (strict), Vitest, no new dependencies, no config keys, no schema changes. Two files touched: `src/channels/dispatcher.ts` and `src/channels/dispatcher-conference.test.ts`.

---

## Explicitly OUT OF SCOPE — accepted residuals, do not "fix"

An implementer or reviewer must not treat any of these as an oversight. Each is a named, argued disposition in the spec.

| Residual | Spec § | Do not |
|---|---|---|
| Overlapping in-flight / outage-queued round-0 turns: a peer whose own round-0 turn has not landed can be invited as a round-1 reactor for the same trigger. | §6.4(d) | Do **not** add an in-flight/pending registry, do **not** add `await statusOf(...)` inside `triggerConferenceReactions`' claim loop (`:1887-1900`), do **not** add an `isThreadActive` accessor to `AgentManager`. That is the *follow-on child*, to be filed against KPR-415. This plan **pins** the residual with test T9. |
| KPR-388 session-write race: the mark advance (`dispatcher.ts:1462-1463`) and the fire-and-forget session persist (`agent-manager.ts:2369` / `:2392`) are independent fail-soft writes and can diverge, so a suppressed round-0 responder can in principle take the round-1 delta arm against a session that never absorbed the trigger. | §7.2 / §9 | Do **not** await or atomize the session persist. It is a cross-module restructure of the KPR-399/KPR-402 persist path. `agent-manager.ts` is **read-only for this ticket** — no edits. |
| KPR-402 `statusOf`-vs-`#dl<n>`-leg-id sub-residual (a leg re-queues under a derived id a status lookup keyed on the origin id cannot see). | §6.3 (last para) | Not inherited by this child — nothing here queries `statusOf`. Deferred alongside §6.4(d). Do not attempt to dissolve it. |
| Diversion micro-residual: `deliverAgentResult` begins with `tryOutageDiversion` (`:571`), which can divert a delivered result away from the meeting thread; the exclusion write still fires. | §4 | Accepted. Do not gate the write on diversion outcome. |
| `deliverAgentResult` returns early when `sourceAdapter` is `undefined` (`:572`); the write still fires. | §4 (same rule: "handed to delivery", not "was posted") | Accepted. Do not gate the write on adapter presence at write sites 1 and 2. (Write site **3** *is* inside `if (adapter)` — that is deliberate and specified, §6.2.) |
| An errored outage **replay** that delivers error text marks exclusion, then may replay again and deliver real content (idempotent second write). | §4 rule, uniform | Not a regression — it is excluded today too. Do not special-case it. |
| KPR-389 §C5's round-1 volume baseline shifts. | Key Points | Advisory only. Do not add instrumentation or a config lever. |
| No config lever; rollback is code revert. | §12 | Do **not** add an `enabled` flag. |
| `triggerConferenceReactions` is only ever called from the **fan-out leg** (`dispatcher.ts:1485`), so an outage-replayed round-0 delivery — or a KPR-402 continuation leg that finally answers — never fires a reaction pass at all. | §3 (named non-goal) | Do **not** add a `triggerConferenceReactions` call to the single-dispatch delivery branch (write site 2) while working Task 4. This is a **pre-existing scope bound the spec explicitly declines to close**, not an oversight in this plan and not a gap this ticket opened. Task 4 deliberately gives that leg an exclusion *write* and no reaction *trigger*: the write is what KPR-416 owes; the trigger is a separate, unfiled decision. Touching it would silently expand this child's blast radius into the replay and continuation paths. |

---

## Prerequisite (Task 0)

This worktree has **no `node_modules`** — verified at plan time (`ls node_modules` → No such file or directory). Install before anything else.

---

## Testing Contract

### Required Test Groups

- **Unit: required.**
  - *Scope:* `Dispatcher`'s reaction-exclusion write predicate and its three call sites, the `meetingExclusionTs` meta stamp and its survival of the KPR-413 continuation-leg strip, and the KPR-387/KPR-388 regression surfaces the relocation touches.
  - *Reason:* the entire change is dispatcher-internal control flow over an in-memory map; there is no I/O boundary to integrate against and no new schema, config, or cross-module surface (spec §8, "Files touched").
  - *Minimum assertions:* 11 test cases (T1, T2, T3, T4, T4b, T5, T6, T7, T8a, T8b, T9), of which T1 and T2 carry a mandatory negative-verify step. Several are written as more than one `it` — T6 as a 2-row `it.each`, T4b as a 3-row `it.each`, T7 as two siblings, T8b as a main test plus two companions — so the executed-test count is higher than 11.
- **Integration: not-required.** See Non-Required Rationale.
- **E2E: not-required.** See Non-Required Rationale.

### Critical Flows

1. **Suppressed round-0 primary → round-1 eligible** (the fix). T1.
2. **Delivered / placeholder / errored-with-text / thrown round-0 primary → stays excluded.** T3, T6, T7.
3. **Exclusion marks through every non-fan-out delivery path**: outage replay (T4) and KPR-402 continuation leg (T8a meta pin + T8b behavior).
4. **Engine chrome never marks**: outage fast-fail notice (T7 companion), cap-exhausted terminal notice and zero-progress deadline notice (T8b companions 1 and 2).
5. **KPR-388 delta injection under the new premise** (T2) and **hot-path no-op** on every ordinary single-dispatch turn (T4b).
6. **Ordering pin**: the write precedes both the delivery and the reaction trigger, structurally (T5).

### Regression Surface

Must stay **green with zero edits** (spec §10, "Suite-level"):

- `dispatcher-conference.test.ts:510` — KPR-387 byte-exact round-0 prompt pin.
- `dispatcher-conference.test.ts:849` — KPR-388 delta injection byte pin.
- `dispatcher-conference.test.ts:738` — KPR-413 T2, "continuation leg carries no conference meta" (T8a is a **new sibling**, not an edit to this test).
- `dispatcher-conference.test.ts:718 / :764 / :789` — KPR-413 T1 / T2b / T3.
- `dispatcher-conference.test.ts:1414-1830` — KPR-409 summary + cadence pins.
- `dispatcher-conference.test.ts:1141` and `:1185` — KPR-388 C3 reachability pins (both seed a reactor that was **not** a round-0 responder, so the relocation does not reach them).
- `src/channels/dispatcher.test.ts`, `src/channels/deadline-continuation.test.ts` — whole files.

**One test is edited deliberately:** `dispatcher-conference.test.ts:433` (T3) — its *assertions* are unchanged; only its harness gains a determinism gate (Task 6, Step 3). No prompt bytes change anywhere in this ticket.

### Commands

```bash
# once, in the worktree
npm ci

# fast loop (single file)
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/dispatcher-conference.test.ts

# the three dispatcher-adjacent suites
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/

# gate
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

All three Slack env stubs are required (`SLACK_BOT_TOKEN` is the one that actually trips config loading).

### Harness Requirements

All already exist in `src/channels/dispatcher-conference.test.ts`; nothing new needs standing up.

- `makeMockRegistry()` — roster agents `jasper` / `river` / `jessica` (+ `executive-assistant` default, `chief-of-staff` disabled). `findAllByName` drives conference roster construction, so the trigger text must name every intended roster member.
- `makeMockAgentManager()` — `runWorkItemTurn`, `_sessionRefs` / `_sessionStore` (`get` / `setMeetingMark` / `clearMeetingMark`), `circuitBreakers.stateFor`, `providerFor`.
- `makeMockAdapter()` / `makeMockSlackAdapter()`.
- The `turn(...)` factory, `settleReactions()` macrotask drain, `soloClassifier()`, `twoAgentClassifier()`, `PREAMBLE(...)`, `seedRef(...)`, `makeHistory(...)` — currently scoped inside nested `describe`s; **Task 3 hoists the small ones this plan needs** into the suite scope rather than duplicating them (DRY).
- Conference routing is triggered by a slack source whose `label` starts with `conf-` (`dispatcher.ts:1176`) — non-`conf-` labels take the ordinary single-dispatch path (used by T4b).
- Outage wiring pattern: `dispatcher.setOutageHandling({ store, episodes: new OutageEpisodeTracker(), config })` — see `dispatcher-conference.test.ts:1042-1064` for the in-file precedent, `dispatcher.test.ts:1151-1174` for `makeCircuitOpenError` / `makeOutageStore` / `OUTAGE_CONFIG`.

**New shared test utility (added in Task 3, used by T4/T4b/T6/T7/T8b):**

```ts
/**
 * KPR-416: the tracker is the eligibility STATE under test, so these cases
 * read it directly rather than inferring it from a downstream reaction pass.
 * Behavioral pins (T1, T3, T9) assert through triggerConferenceReactions.
 * Same `dispatcher as unknown as {...}` convention as the T6/C4 guard at :562.
 */
const excludedFor = (threadId: string, humanTs: string): Set<string> | undefined =>
  (
    dispatcher as unknown as {
      meetingReactionTracker: Map<string, Map<string, Set<string>>>;
    }
  ).meetingReactionTracker
    .get(threadId)
    ?.get(humanTs);
```

### Non-Required Rationale

- **Integration:** the change adds no I/O, no collection, no config key, no cross-module call. `agent-manager.ts` is read-only for this ticket. The one cross-boundary interaction — the `meetingExclusionTs` key riding the outage-queue document and the KPR-402 leg — is exercised end-to-end *within* the unit suite (T4 round-trips the real `outageStore.enqueue` payload back through `dispatch`; T8a/T8b drive the real `maybeHandleDeadlineAbort` arm). A Mongo-backed integration test would add nothing the unit suite does not already pin.
- **E2E:** the behavior is a multi-agent Slack meeting race. There is no E2E harness for conference threads in this repo, and the spec's own testing contract (§10) scopes all coverage to `dispatcher-conference.test.ts`. Building one is out of scope and would not be a faster or more trustworthy signal than T1/T3/T9.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Negative-verify obligation (mandatory, spec §10):** T1 and T2 must be demonstrated to **fail on pre-fix code**. Each of Task 6 and Task 7 carries an explicit revert → run → confirm-fail → re-apply → confirm-pass step. Both must also guard the vacuous-pass hazard (`kpr-387-spec.md:155`) by asserting a **non-empty** set of turns actually ran before asserting over their content.
- **Pre-fix pass/fail, precisely.** "Pre-fix" below means *pre-KPR-416 code* — the selection-time write present, no helper, no stamp, no call sites. Only T1 and T2 carry the mandatory demonstration; the rest of this table is a correctness statement about the suite, not extra work. Note the three categories are different in kind and must not be conflated: a **reachability** failure is real evidence of the behavior change; a **structurally-absent** failure is a compile/anchor failure that proves nothing about behavior.

  | Test | Pre-fix | Why |
  |---|---|---|
  | T1 | **fails — reachability** | Selection-time write excludes all three primaries ⇒ `peerMembers` empty ⇒ the reaction classifier is never called and the waitFor times out. The mandatory demo (Task 6 Step 7). |
  | T2 | **fails — reachability** | Jessica is excluded at selection time ⇒ no round-1 turn dispatches at all ⇒ `round1Call()` stays undefined. The mandatory demo (Task 7 Step 3). |
  | T4 (phase-1 assertion only) | **fails — reachability** | `excludedFor(...).toBeUndefined()` after queueing: pre-fix the selection-time write already recorded `jasper`. T4's phase-2 assertion passes on both. *This assertion is added in Task 6 Step 5, not Task 4 — it is unreachable before the selection-time write is deleted.* |
  | T7 fast-fail sibling (negative assertion only) | **fails — reachability** | Same shape: pre-fix `jasper` is recorded at selection time regardless of the later `ProviderCircuitOpenError`. *Also added in Task 6 Step 5.* |
  | T8b companion 1 (cap-exhausted) | **fails — reachability** | Pre-fix the never-answering chain's agent is nonetheless excluded at selection time. |
  | T8b companion 2 (zero-progress abort) | **fails — reachability** | Same. |
  | T9 | **fails — reachability** | Pre-fix `river` is excluded at selection time, so `peerIds` never contains it. |
  | T5 | **fails — structurally absent** | Not a behavior signal: `this.markReactionExclusion(` simply does not appear in the fan-out block, so the source-order scan's first anchor assertion fails. Proves the call site exists, nothing about the relocation. |
  | T8a | **fails — structurally absent** | Same category: `meta.meetingExclusionTs` is never stamped pre-fix, so the pin fails on an absent key rather than on divergent behavior. |
  | T3 | **passes on both** | A *delivered* round-0 responder is excluded under either placement — that is exactly the KPR-387 guarantee this ticket preserves. |
  | T4b | **passes on both** | Ordinary non-conference single-dispatch turn; neither placement touches the tracker. |
  | T6 (both cases) | **passes on both** | Placeholder and errored-with-text turns are excluded under either placement; T6 pins the *predicate*, not the placement. |
  | T7 thrown-turn half | **passes on both** | A thrown round-0 turn is excluded under either placement. |
  | T8b main test | **passes on both** | The leg's agent is already excluded from selection time pre-fix, so there is nothing new for it to fail on. It pins that the *delivery-time* placement still reaches the continuation leg — a claim only its two companions can falsify. |

---

## Task ordering rationale

Tasks 1-5 add machinery and call sites **while the selection-time write is still in place**. Every intermediate commit is therefore behaviorally identical to today: the selection-time write already covers a superset of what the new delivery-time writes mark, and the tracker is a `Set`, so the extra writes are idempotent no-ops. Task 6 is the single behavior-changing commit (deletion + comment rewrites), and it is where T1's negative-verify lands. Do not reorder Task 6 ahead of Tasks 1-5.

**The direct consequence — do not fight it (plan-review r1, blocking issues 1 and 2).** Any assertion of the form "this agent is **not** in the tracker" is *unreachable* before Task 6, because a non-empty classifier result records every selected agent at classification time no matter what the delivery-time sites do. Two such assertions belong to tests introduced earlier — T4's phase-1 "queued ⇒ not excluded" pin and T7's fast-fail-companion pin. Both are therefore **deliberately deferred to Task 6 Step 5**, with a `NOTE:` left at the exact spot they belong. Tasks 4 and 5 assert only what holds with the selection-time write still present. Writing either assertion early would make its own commit red and destroy the additive-then-single-behavior-change property this ordering exists to provide.

---

### Task 0: Environment

**Files:** none.

- [ ] **Step 1:** Install dependencies (this worktree has no `node_modules`).
```bash
cd /Users/mokie/github/hive-KPR-415 && npm ci
```
- [ ] **Step 2:** Verify the baseline suite is green before touching anything.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/
```
Expected: all files pass, `0 failed`. Record the passing test count — it is the baseline for "no regressions".
- [ ] **Step 3:** No commit (nothing changed).

---

### Task 1: The `markReactionExclusion` helper

**Files:**
- Modify: `src/channels/dispatcher.ts:129-133` (tracker field comment) and `:563-564` (insert the helper between `tryOutageDiversion` and `deliverAgentResult`)

> Line numbers throughout are as of `a5382c7` (source tree identical to `0ed653d`) and shift as earlier tasks land. **Anchor every edit on the quoted text, not the number.**

- [ ] **Step 1:** Update the tracker field's comment at `dispatcher.ts:130-133` so it no longer claims selection-time recording.

Replace:
```ts
  // Map<threadId, Map<humanMessageTs, Set<agentId>>> — agents that responded or were
  // selected to respond on this human message, either round (KPR-387): round-0
  // primaries recorded at selection time, round-1 reactors at claim time.
  private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();
```
with:
```ts
  // Map<threadId, Map<humanMessageTs, Set<agentId>>> — agents excluded from
  // reacting on this human message, either round (KPR-387). Round-0 primaries
  // are recorded at DELIVERY time (KPR-416 — markReactionExclusion, three call
  // sites; supersedes KPR-386 canon C1's selection-time recording, so a
  // SUPPRESSED primary is no longer excluded), round-1 reactors at claim time
  // (triggerConferenceReactions). Shape, keying and TTL are unchanged (C2).
  private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();
```

- [ ] **Step 2:** Insert the helper immediately **before** `deliverAgentResult` (i.e. after `tryOutageDiversion`'s closing brace at `:563`, before the block comment that begins — verified verbatim in this tree at `:566` — `/** KPR-308: shared agent-response delivery for the two dispatch paths.`). Note the anchor has **no** `§5.2`; the `§5.2`-bearing KPR-308 comment is a *different* one at `:508` (outage-mode delivery preference), so do not anchor on that.

```ts
  /**
   * KPR-416: mark reaction-exclusion at DELIVERY time. One rule —
   *
   *   an agent is excluded from reacting on a trigger iff its own round-0
   *   turn on that trigger handed text to delivery
   *
   * — implemented as one helper called from three sites (fan-out delivery,
   * single-dispatch delivery, handleTurnFailure's adapter arm) so the
   * invariant is auditable rather than emergent. "Handed to delivery", not
   * "was posted": the call sites sit immediately before the delivery call, so
   * a diverted (tryOutageDiversion) or adapter-less delivery still marks —
   * the turn ran and consumed the trigger (spec §4).
   *
   * Keyed on `meta.meetingExclusionTs`, stamped round-0-only in
   * dispatchToAgent's conference meta block. That key rides item.meta, so it
   * reaches every delivery path for free: the outage-queued document, every
   * KPR-402 continuation leg (whose construction strips the four `conference*`
   * keys but not this one — deliberately named outside that family), and both
   * handleTurnFailure legs. Engine-authored notices (KPR-307 outage, KPR-402
   * first-abort/terminal, replay-terminal) never reach a call site and so
   * never mark: they are engine chrome, not agent content.
   *
   * Synchronous and idempotent (Set add). Tracker shape, keying and TTL are
   * unchanged — KPR-386 canon C2 preserved, C1 superseded.
   * Spec: docs/epics/kpr-415/kpr-416-spec.md §5.3.
   */
  private markReactionExclusion(item: WorkItem, agentId: string): void {
    const ts = item.meta?.meetingExclusionTs;
    // Type-guarded, not cast: meta is Record<string, unknown> and this helper
    // sits on the hot path of every single-dispatch turn in the engine, where
    // the key is absent. Anything that is not a non-empty string is a no-op.
    if (typeof ts !== "string" || ts.length === 0) return;
    const threadId = item.threadId ?? item.id;
    if (!this.meetingReactionTracker.has(threadId)) {
      this.meetingReactionTracker.set(threadId, new Map());
    }
    const threadTracker = this.meetingReactionTracker.get(threadId)!;
    const responded = threadTracker.get(ts) ?? new Set<string>();
    responded.add(agentId);
    threadTracker.set(ts, responded);
  }
```

- [ ] **Step 3:** Verify it compiles and lints (the helper is intentionally unused at this point — confirm the linter does not reject a private unused member; if `@typescript-eslint/no-unused-vars` flags it, that is fine and resolves in Task 3, but note it and do **not** add a suppression).
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && npm run typecheck && npm run lint
```
Expected: `typecheck` exits 0 with no output; `lint` exits 0. (Private class members are not flagged by this repo's config.)

- [ ] **Step 4:** Commit.
```bash
git add src/channels/dispatcher.ts
git commit -m "feat(kpr-416): add markReactionExclusion delivery-time helper

One rule, three call sites (wired in the next commits): an agent is
excluded from reacting on a trigger iff its own round-0 turn handed text
to delivery. Keyed on meta.meetingExclusionTs. No behavior change yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Stamp `meta.meetingExclusionTs` (round-0 only)

**Files:**
- Modify: `src/channels/dispatcher.ts:1370-1383` (the conference `effectiveItem` meta block)
- Test: `src/channels/dispatcher-conference.test.ts` — new T8a, added as a sibling of the existing KPR-413 T2 at `:738`

- [ ] **Step 1:** Add the key to the meta object literal, after `deadlineOriginalText`.

Replace:
```ts
          conferenceInjectionMode: resolved.injectionMode,
          deadlineOriginalText: `${framePrefix}\n${newMessageSegment}`,
        },
      };
```
with:
```ts
          conferenceInjectionMode: resolved.injectionMode,
          deadlineOriginalText: `${framePrefix}\n${newMessageSegment}`,
          // KPR-416: the exclusion key rides the item so every delivery path
          // can mark reaction-exclusion uniformly — including the KPR-402
          // continuation chain, which deliberately strips the four conference
          // keys (see maybeHandleDeadlineAbort's leg construction). Named
          // OUTSIDE the `conference*` family on purpose: it must survive that
          // blocklist, and nothing telemetric reads it (verified: there is no
          // meta allowlist anywhere, and neither agent_turn_telemetry nor
          // activity_log spreads item.meta), so KPR-413's rationale — never
          // stamp a non-conference turn as a conference turn — is untouched.
          //
          // Round-0 only: a round-1 reactor's exclusion is claimed by
          // triggerConferenceReactions at dispatch, not by delivery. Guarded
          // on conferenceHumanTs because it is optional on ResolvedAgent (a
          // non-Slack conference surface has no ts to key on) — the same
          // guard the deleted selection-time write applied.
          ...(resolved.conferenceRound === 0 && resolved.conferenceHumanTs
            ? { meetingExclusionTs: resolved.conferenceHumanTs }
            : {}),
        },
      };
```

- [ ] **Step 2:** Add **T8a** to `dispatcher-conference.test.ts`, immediately after the existing `"T2: continuation leg carries no conference meta"` test (ends `:762`), inside the same `describe("deadline-continuation legs carry the turn's own frame, not the conference transcript (KPR-413)")`.

```ts
      it("T8a (KPR-416): the continuation leg carries meetingExclusionTs and still none of the four conference keys", async () => {
        // Sibling of T2 above, not a replacement — T2 stays byte-identical.
        // The key is deliberately named outside the `conference*` family so
        // it survives KPR-413's blocklist strip; that survival is exactly
        // what lets write site 2 mark exclusion on the leg's own delivery
        // (T8b). Spec §5.2 / §6.3.
        await soloClassifier();
        const threadId = "conf-thread-kpr416-t8a";
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

        // The ORIGIN turn carries it (stamped at assembly, like T2b's pin)...
        const originItem = agentManager.runWorkItemTurn.mock.calls[0][1];
        expect(originItem.meta.meetingExclusionTs).toBe("1000.0004");

        // ...and it survives the leg construction, while the four conference
        // keys still do not.
        const legItem = agentManager.runWorkItemTurn.mock.calls[1][1];
        expect(legItem.meta.meetingExclusionTs).toBe("1000.0004");
        expect(legItem.meta.conferenceMode).toBeUndefined();
        expect(legItem.meta.conferenceRound).toBeUndefined();
        expect(legItem.meta.conferenceHumanTs).toBeUndefined();
        expect(legItem.meta.conferenceInjectionMode).toBeUndefined();
      });
```

- [ ] **Step 3:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
```
Expected: all tests pass including the new `T8a (KPR-416)`; the existing `T2: continuation leg carries no conference meta` still passes unmodified.

- [ ] **Step 4:** Commit.
```bash
git add src/channels/dispatcher.ts src/channels/dispatcher-conference.test.ts
git commit -m "feat(kpr-416): stamp meta.meetingExclusionTs on round-0 conference turns

Deliberately named outside the conference* family so it survives KPR-413's
four-key continuation-leg strip. T8a pins both halves.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Write site 1 — fan-out delivery (+ shared test utilities, T5, T6)

**Files:**
- Modify: `src/channels/dispatcher.ts:1472-1481` (fan-out `else` branch)
- Test: `src/channels/dispatcher-conference.test.ts` — hoist shared helpers, add `excludedFor`, add T5 and T6

- [ ] **Step 1:** Insert the call immediately before the fan-out delivery.

Replace:
```ts
        await this.deliverAgentResult(workResult, adapter);

        // Conference mode: trigger depth-1 peer reactions
```
with:
```ts
        // KPR-416 write site 1 — ORDERING PIN. This is a synchronous
        // statement placed immediately before BOTH the delivery below and
        // the triggerConferenceReactions fire-and-forget that follows it, so
        // the window in which this agent could be re-invited as a reactor to
        // its own trigger is zero by construction — there is nothing here to
        // race. Do NOT move it below either call (pinned by T5).
        // The remaining window is cross-agent, not self: a PEER whose own
        // round-0 turn has not landed can still be invited. That is the
        // accepted, deferred residual — kpr-416-spec.md §6.4(d), pinned T9.
        this.markReactionExclusion(effectiveItem, agentId);
        await this.deliverAgentResult(workResult, adapter);

        // Conference mode: trigger depth-1 peer reactions
```

- [ ] **Step 2:** Hoist the test helpers this plan needs out of the nested `describe`s into the suite scope of `describe("Conference channel routing")`, alongside the existing `PREAMBLE` and `soloClassifier` (which already live there, `:235-255`). Move — do not copy — `turn(...)` / `zeroUsage` / `settleReactions` from `describe("round-1 kill suppression (KPR-389 D5)")` (`:575-623`) and `seedRef` / `makeHistory` from `describe("delta context injection (KPR-388)")` (`:822-840`) up to suite scope, leaving the nested describes referencing the hoisted versions. `confItem`, `THREE_MSG_HISTORY`, `ONE_MSG_HISTORY` and `ABORT_WITH_PROGRESS` stay where they are.

> **Do NOT hoist `twoAgentClassifier`.** It is used only inside its own KPR-389 describe block and nothing this plan adds calls it — hoisting it is churn in the regression surface for no benefit. Leave it where it is.
>
> **`turn` stays a `function` declaration — no need to churn it to a `const`.** `ABORT_WITH_PROGRESS` (`:710`, inside the KPR-413 describe) is initialized from a `turn({...})` call; leaving `turn` as `function turn(overrides: Record<string, unknown> = {}) { ... }` at suite scope is simplest and matches the file's existing convention. No functional reason to change its form.

Then add, immediately after `soloClassifier()` in the suite scope:

```ts
  /**
   * KPR-416: the tracker is the eligibility STATE under test, so the write-
   * site cases read it directly rather than inferring it from a downstream
   * reaction pass. The behavioral pins (T1, T3, T9) assert through
   * triggerConferenceReactions instead. Same `dispatcher as unknown as {...}`
   * convention as the T6/C4 guard below.
   */
  const excludedFor = (threadId: string, humanTs: string): Set<string> | undefined =>
    (
      dispatcher as unknown as {
        meetingReactionTracker: Map<string, Map<string, Set<string>>>;
      }
    ).meetingReactionTracker
      .get(threadId)
      ?.get(humanTs);
```

- [ ] **Step 3:** Add **T5** (source-order pin) as a new top-level `it` in the suite, after the T6/C4 guard at `:552-572`. Add `readFileSync` / `fileURLToPath` imports at the top of the file (same pattern as `src/boot-order.test.ts:2-3`).

```ts
  it("T5 (KPR-416): the exclusion write precedes BOTH the fan-out delivery and the reaction trigger", () => {
    // Structural, not a race test. Post-KPR-416 the window between the write
    // and the two call sites is zero BY CONSTRUCTION — the write is a
    // synchronous statement immediately preceding both — so a timing/
    // microtask test here would be theater. This is a drift catcher: a later
    // refactor that moves the write below either call fails it.
    // Text-scan (same technique as src/boot-order.test.ts), with `//` line
    // comments stripped so prose mentioning the call cannot false-positive.
    const source = readFileSync(fileURLToPath(new URL("./dispatcher.ts", import.meta.url)), "utf8");
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

    // Bound the scan to the fan-out `else` branch of dispatchToAgent, so the
    // single-dispatch call site (write site 2, earlier in the file) can never
    // stand in for a fan-out write that was moved or deleted.
    const blockStart = codeOnly.indexOf('log.info("Non-response suppressed (fan-out)"');
    const blockEnd = codeOnly.indexOf('log.info("Fan-out dispatch complete"');
    expect(blockStart, "fan-out branch anchor not found — update this test's anchors").toBeGreaterThan(-1);
    expect(blockEnd, "fan-out branch end anchor not found — update this test's anchors").toBeGreaterThan(blockStart);
    const block = codeOnly.slice(blockStart, blockEnd);

    const markIdx = block.indexOf("this.markReactionExclusion(");
    const deliverIdx = block.indexOf("await this.deliverAgentResult(workResult, adapter);");
    const triggerIdx = block.indexOf("this.triggerConferenceReactions(");
    expect(markIdx, "markReactionExclusion is not called in the fan-out delivery branch").toBeGreaterThan(-1);
    expect(deliverIdx).toBeGreaterThan(-1);
    expect(triggerIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeLessThan(deliverIdx);
    expect(deliverIdx).toBeLessThan(triggerIdx);
  });
```

- [ ] **Step 4:** Add **T6** (disposition (a): the predicate is branch position, not "real content") as a new top-level `it` after T5.

```ts
  it.each([
    ["empty text delivering the _No response._ placeholder", { finalMessage: "" }, "_No response._"],
    ["error WITH text (exit-code-1 convention)", { finalMessage: "Partial answer", errors: ["exit 1"] }, "Partial answer"],
  ])(
    "T6 (KPR-416): a round-0 turn that %s stays excluded (predicate is branch position, not 'real content')",
    async (_label, flags, expectedText) => {
      // Disposition (a), spec §6.1. Neither shape matches NON_RESPONSE_PATTERNS,
      // so both land in the delivering `else` — under branch position the write
      // FIRES for them, keeping them excluded. Passes pre- and post-fix (before
      // the relocation the selection-time write covered them); it is the pin
      // that stops a future "genuinely non-empty non-errored content" predicate
      // silently re-including them.
      await soloClassifier();
      const threadId = `conf-thread-kpr416-t6-${String(_label).replace(/\W+/g, "-")}`;
      // Spread form, consistent with the KPR-389 D5 it.each above (:625);
      // both `turn(flags)` and `turn({ ...flags })` typecheck here since
      // vitest infers `flags` per-position, not as a cross-row union.
      agentManager.runWorkItemTurn.mockResolvedValueOnce(turn({ ...flags }));

      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t6" },
          threadId,
          meta: { slackTs: "1700.0006" },
        }),
      );
      await settleReactions();

      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe(expectedText);
      expect(excludedFor(threadId, "1700.0006")).toEqual(new Set(["jasper"]));
    },
  );
```

- [ ] **Step 5:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
```
Expected: all pass, including `T5 (KPR-416)` and both `T6 (KPR-416)` cases. The hoisted helpers must not have broken any nested-describe test — the file's pass count should equal the Task 2 count plus 3.

- [ ] **Step 6:** Commit.
```bash
git add src/channels/dispatcher.ts src/channels/dispatcher-conference.test.ts
git commit -m "feat(kpr-416): write site 1 — mark exclusion before fan-out delivery

Ordering pin: the write precedes both deliverAgentResult and the
triggerConferenceReactions fire-and-forget (T5, source-order scan). T6
pins the branch-position predicate against a 'real content only' drift.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Write site 2 — single-dispatch delivery (outage replay + KPR-402 legs)

**Files:**
- Modify: `src/channels/dispatcher.ts:402-411` (single-dispatch `else` branch)
- Test: `src/channels/dispatcher-conference.test.ts` — add T4b then T4

- [ ] **Step 1:** Insert the call immediately before the single-dispatch delivery.

Replace (in the `dispatch` inner leg, the `else` at `:401`):
```ts
        await this.deliverAgentResult(workResult, adapter);

        if (tracked) {
```
with:
```ts
        // KPR-416 write site 2. Covers the two paths that never reach the
        // fan-out leg: a KPR-307 outage replay of a round-0 conference turn,
        // and every KPR-402 deadline-continuation leg — both re-enter here
        // via meta.targetAgentId (resolveAgents step 0), carrying
        // meetingExclusionTs in meta. This sits on the hot path of every
        // ordinary non-conference turn in the engine, where it is a `meta`
        // read plus a type check and nothing else (pinned by T4b).
        this.markReactionExclusion(item, agentId);
        await this.deliverAgentResult(workResult, adapter);

        if (tracked) {
```

- [ ] **Step 2:** Add **T4b** (hot-path no-op) as a new top-level `it` in the suite.

```ts
  it.each([
    ["no meetingExclusionTs at all", undefined],
    ["a malformed non-string meetingExclusionTs", 42],
    ["an empty-string meetingExclusionTs", ""],
  ])(
    "T4b (KPR-416): write site 2 no-ops cleanly for a plain single-dispatch turn with %s",
    async (_label, exclusionTs) => {
      // Write site 2 sits on the delivery branch of the ORDINARY single-
      // dispatch path — the hot path of every non-conference turn in the
      // engine. This is the only test guarding that blast radius: no tracker
      // mutation, no throw, delivery unaffected. Non-`conf-` label ⇒ ordinary
      // routing (dispatcher.ts:1176).
      const meta: Record<string, unknown> = { slackTs: "1700.0007" };
      if (exclusionTs !== undefined) meta.meetingExclusionTs = exclusionTs;

      await dispatcher.dispatch(
        makeWorkItem({
          text: "what is the deploy status?",
          source: { kind: "slack", id: "C999", label: "general" },
          threadId: `plain-thread-${String(_label).replace(/\W+/g, "-")}`,
          meta,
        }),
      );

      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe("Agent response");
      expect(
        (dispatcher as unknown as { meetingReactionTracker: Map<string, unknown> }).meetingReactionTracker.size,
      ).toBe(0);
    },
  );
```

- [ ] **Step 3:** Add **T4** (outage-replay leg marks exclusion) as a new top-level `it`. It round-trips the *real* enqueued workItem, so it pins that `meetingExclusionTs` actually survives the outage store.

> **Two hazards this test has to handle — both were caught in plan-review r1.**
>
> **(a) The phase-1 negative assertion is NOT written here.** `expect(excludedFor(threadId, "1700.0008")).toBeUndefined()` after queueing is *unreachable* at Task 4: the selection-time write in `resolveConferenceAgents` still exists until Task 6 and records `jasper` at classification time regardless of anything Task 4 adds, so the assertion would fail on the very commit that introduces it. Task 4 asserts only what is true with the selection-time write still in place; the negative assertion is added in **Task 6 Step 5**, immediately after the write is deleted, where it is both reachable and meaningful. This preserves the plan's shape: Tasks 1-5 stay additive and behavior-neutral, Task 6 remains the single behavior-changing commit.
>
> **(b) `adapter.deliver` is called TWICE across the two phases, and the outage notice comes FIRST.** Phase 1's item id is `msg-N-…`, so `policyFor(item)` returns `"notify"` (`src/outage/outage-notices.ts:18-26`) and `episodes.firstForThread(...)` is true on a freshly constructed `OutageEpisodeTracker` — so `maybeHandlePostTurnOutage` calls `deliverOutageNotice` → `adapter.deliver` **before** phase 2's real-content delivery. `calls[0]` is therefore the notice, not the content. The in-file precedent this test is modelled on (`"outage-queued turn never touches the mark"`, `:1042`) sidesteps this only because it never asserts on `deliver` contents or counts; this test does, so it must handle it explicitly. The test below asserts the notice deliberately (it is real behavior worth pinning) and then **clears `adapter.deliver`'s call record** before phase 2, so the phase-2 assertions read `calls[0]` of a clean record. `mockClear()` — not `mockReset()`/`clearAllMocks()` — so the harness's `deliver` implementation survives.

```ts
  it("T4 (KPR-416): an outage-queued round-0 turn that later replays and delivers excludes that agent", async () => {
    // Write site 2's replay half, end-to-end: phase 1 queues the real
    // effectiveItem via the outage path; phase 2 replays THAT item with the
    // breaker closed and asserts the delivery marked exclusion. §4's table
    // row: "post-turn outage queue" is no longer excluded at queue time — the
    // replay's own delivery is what excludes.
    await soloClassifier();
    const threadId = "conf-thread-kpr416-t4";
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

    // Phase 1 — breaker open + hard fault ⇒ the turn queues, nothing delivered.
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      turn({ finalMessage: "", errors: ["connect ECONNREFUSED api"] }),
    );
    await dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t4" },
        threadId,
        meta: { slackTs: "1700.0008" },
      }),
    );
    expect(outageStore.enqueue).toHaveBeenCalledTimes(1);
    // Phase 1 delivered the KPR-307 honest-outage NOTICE (policyFor ⇒ "notify",
    // first episode for this thread), so deliver has already fired once. That
    // notice is engine chrome, not agent content — pin it, then clear the call
    // record so phase 2's assertions read a clean `calls[0]`. mockClear only:
    // mockReset/clearAllMocks would drop the harness's deliver implementation.
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toContain("provider outage");
    adapter.deliver.mockClear();
    // NOTE: `expect(excludedFor(threadId, "1700.0008")).toBeUndefined()` — the
    // "queued ⇒ NOT excluded" pin — belongs here logically but is UNREACHABLE
    // until Task 6 deletes the selection-time write, which records jasper at
    // classification time regardless. Task 6 Step 5 adds it at this exact spot.

    // Phase 2 — replay the item the store actually holds, breaker closed.
    const queued = outageStore.enqueue.mock.calls[0][0].workItem as WorkItem;
    expect(queued.meta?.meetingExclusionTs).toBe("1700.0008"); // the key rode the doc
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "closed", enabled: true });
    agentManager.runWorkItemTurn.mockResolvedValueOnce(turn({ finalMessage: "The real answer, at last" }));
    await dispatcher.dispatch({
      ...queued,
      meta: { ...queued.meta, outageReplay: true, targetAgentId: "jasper" },
    });

    expect(adapter.deliver).toHaveBeenCalledTimes(1); // post-mockClear: the real content only
    expect(adapter.deliver.mock.calls[0][0].text).toBe("The real answer, at last");
    expect(excludedFor(threadId, "1700.0008")).toEqual(new Set(["jasper"]));
  });
```

> **Implementation note:** confirm the shape of the object passed to `outageStore.enqueue` when writing this test (`dispatcher.test.ts` around `:1240` shows the assertion shape used elsewhere). If the enqueue payload nests the item under a different key than `workItem`, adjust the extraction — the assertion that matters is `queued.meta?.meetingExclusionTs === "1700.0008"` plus the post-replay tracker state.

- [ ] **Step 4:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/
```
Expected: every file green. `dispatcher.test.ts` in particular must be unchanged and passing — it exercises write site 2's hot path across dozens of ordinary turns and is the real blast-radius check.

- [ ] **Step 5:** Commit.
```bash
git add src/channels/dispatcher.ts src/channels/dispatcher-conference.test.ts
git commit -m "feat(kpr-416): write site 2 — mark exclusion before single-dispatch delivery

Covers the KPR-307 outage-replay leg and every KPR-402 continuation leg.
T4b pins the no-op on the ordinary non-conference hot path; T4 round-trips
the real enqueued workItem to prove meetingExclusionTs survives the store.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Write site 3 — `handleTurnFailure`'s adapter arm

**Files:**
- Modify: `src/channels/dispatcher.ts:623-625`
- Test: `src/channels/dispatcher-conference.test.ts` — add T7 and its fast-fail companion as **two sibling `it`s**

- [ ] **Step 1:** Insert the call inside `if (adapter)`, before `adapter.deliver(errorResult)`.

Replace:
```ts
    if (adapter) {
      try {
        await adapter.deliver(errorResult);
```
with:
```ts
    if (adapter) {
      // KPR-416 write site 3 (spec §6.2). A thrown round-0 turn posts
      // `Something went wrong: …` — the same user-visible artifact an
      // in-branch errored turn produces — so it stays excluded; letting the
      // two diverge would be an accident, not a design. Reachable on this
      // epic's own hot path: a grok TurnAssemblyError from an unreadable
      // ~/.grok/auth.json throws here rather than raising
      // ProviderCircuitOpenError. Inside `if (adapter)` so the rule ("handed
      // text to delivery") stays literally true, and correctly NOT reached
      // when handleOutageTurn already absorbed a fast-fail above (early
      // return) — that path delivers a notice, not agent text.
      this.markReactionExclusion(item, agentId);
      try {
        await adapter.deliver(errorResult);
```

- [ ] **Step 2:** Add **T7** as **two sibling top-level `it`s** in the suite. Import `ProviderCircuitOpenError` from `../agents/provider-circuit-breaker.js` at the top of the test file.

> **Two `it`s, not one with a mid-test reset.** An earlier draft packed both halves into a single test separated by `vi.clearAllMocks()`. Do not do that. Two independent tests get the suite's own `beforeEach` teardown between them for free, and they fail independently — the fast-fail exemption is a *separate* claim from the thrown-turn inclusion and deserves its own red line. (For the record, the abandoned draft's stated rationale was also wrong: `vi.clearAllMocks()` is `mockClear` across all mocks — it resets **call records**, not queued `mockResolvedValueOnce` implementations. It happened to be harmless there only because the once-value was already consumed before the reset. Don't reason from that premise anywhere else in this suite.)

```ts
  it("T7 (KPR-416): a THROWN round-0 turn stays excluded (write site 3)", async () => {
    // Disposition (b), spec §6.2. The thrown turn posts visible error text —
    // the same user-visible artifact an in-branch errored turn produces — so
    // it stays excluded. Passes pre- and post-fix: this half pins the
    // predicate, not the relocation.
    await soloClassifier();
    const thrownThread = "conf-thread-kpr416-t7-thrown";
    agentManager.runWorkItemTurn.mockRejectedValueOnce(new Error("boom"));

    await dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t7" },
        threadId: thrownThread,
        meta: { slackTs: "1700.0009" },
      }),
    );

    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toContain("Something went wrong");
    expect(excludedFor(thrownThread, "1700.0009")).toEqual(new Set(["jasper"]));
  });

  it("T7 companion (KPR-416): a ProviderCircuitOpenError fast-fail is NOT excluded", async () => {
    // The exemption half. A fast-fail posts an engine NOTICE, not agent
    // content, so it must never mark — handleOutageTurn's early return in
    // handleTurnFailure lands before write site 3, and this is its pin.
    await soloClassifier();
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
    const fastFailThread = "conf-thread-kpr416-t7-fastfail";
    // ProviderCircuitOpenError's `provider` param is typed `string` (see
    // provider-circuit-breaker.ts:94) — no cast needed.
    agentManager.runWorkItemTurn.mockRejectedValueOnce(
      new ProviderCircuitOpenError("claude", Date.now(), 15_000, "connect-fail", "fetch failed"),
    );

    await dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, next steps?",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t7" },
        threadId: fastFailThread,
        meta: { slackTs: "1700.0010" },
      }),
    );

    expect(outageStore.enqueue).toHaveBeenCalledTimes(1); // queued as a notice, not agent text
    // NOTE: `expect(excludedFor(fastFailThread, "1700.0010")).toBeUndefined()`
    // — the actual exemption pin — is UNREACHABLE here for the same reason as
    // T4's phase-1 assertion: the selection-time write in resolveConferenceAgents
    // already recorded jasper at classification time, regardless of the later
    // ProviderCircuitOpenError. Task 6 Step 5 adds it once that write is gone.
  });
```

> **Sequencing note (plan-review r1, blocking issue 2).** As written above, this task's fast-fail sibling asserts only that the turn queued. That is deliberately weaker than the test's final form — its load-bearing negative assertion lands in **Task 6 Step 5**, alongside T4's. Do not "helpfully" write it here: it cannot pass until the selection-time write is deleted, and adding it now would break the invariant that every commit through Task 5 is behaviorally identical to today and green.

- [ ] **Step 3:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/
```
Expected: every file green, both `T7 (KPR-416)` and `T7 companion (KPR-416)` passing. Note the companion is deliberately weak at this task — its negative assertion lands in Task 6 Step 5.

- [ ] **Step 4:** Commit.
```bash
git add src/channels/dispatcher.ts src/channels/dispatcher-conference.test.ts
git commit -m "feat(kpr-416): write site 3 — mark exclusion before error delivery

A thrown turn posts the same visible artifact as an in-branch errored turn,
so it stays excluded. The handleOutageTurn fast-fail path is correctly
exempt (notice, not agent text) — both halves pinned by T7.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Delete the selection-time write, rewrite both comments (THE behavior change)

**Files:**
- Modify: `src/channels/dispatcher.ts:1635-1650` (delete the write, rewrite the comment)
- Modify: `src/channels/dispatcher.ts:1344-1351` (rewrite the KPR-388 invariant comment)
- Test: `src/channels/dispatcher-conference.test.ts:433` (T3 determinism gate), a new T1, and the two deferred `toBeUndefined()` assertions Tasks 4 and 5 left as `NOTE:` placeholders (Step 5)

This is the only commit that changes behavior. Everything before it was additive — which is precisely why the two negative assertions could not be written earlier: an assertion that the tracker is *empty* is only true once the selection-time write is gone, and that happens here.

- [ ] **Step 1:** In `resolveConferenceAgents`, delete the write and rewrite the comment. Keep `const humanTs = ...` — it is still consumed at `:1666` and `:1671`.

Replace:
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
with:
```ts
    // KPR-387/KPR-416: round-0 responders are still recorded so the reaction
    // pass never re-selects a primary for the same triggering human message —
    // but the write now lands at DELIVERY time (markReactionExclusion, three
    // call sites), not here at selection time. KPR-416 relocated it so a
    // primary whose turn was SUPPRESSED becomes eligible to react to a slower
    // peer's later, substantive reply — the exact shape that silenced the live
    // trial meeting. Delivered, `_No response._`-placeholder, errored-with-text
    // and thrown turns all keep today's exclusion. Supersedes KPR-386 canon C1
    // ("selection-time recording"); C2 (shape/keying/TTL) is unchanged.
    //
    // ⚠ THE RACE THIS MOVE RE-OPENS — read before "simplifying" anything here.
    // The old placement ran synchronously before any round-0 dispatch, so no
    // fast completion could trigger a reaction pass against an unrecorded
    // agent. That is gone. WITHIN one agent the window is still zero by
    // construction: the write is the statement immediately before both the
    // delivery and the reaction trigger (ordering pin, pinned by T5). ACROSS
    // agents a peer whose own round-0 turn has not landed CAN now be invited
    // as a round-1 reactor for the same trigger — deliberately deferred,
    // bounded by the per-thread lock in agent-manager.ts (its round-1 turn
    // serializes behind its own round-0 turn) plus round-1's "do not re-answer"
    // framing, and pinned as known behavior by T9. See
    // docs/epics/kpr-415/kpr-416-spec.md §6.4(d) and its follow-on child
    // before attempting a fix here.
    const humanTs = item.meta?.slackTs as string | undefined;
```

- [ ] **Step 2:** Rewrite the falsified KPR-388 premise in `dispatchToAgent`'s comment. Replace `dispatcher.ts:1344-1351` in full:
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
with:
```ts
      // KPR-387: round-1 reaction turns are framed against the peer reply — the
      // original human message is never re-presented in the terminal slot. It
      // remains reachable via session ∪ injected context (KPR-388 generalizes
      // the old re-fetched-transcript guarantee).
      //
      // KPR-416 falsified the premise this comment used to state (KPR-386 canon
      // C1, selection-time recording: "a round-1 reactor was never a round-0
      // responder for this trigger, so its mark predates the triggering
      // message"). A SUPPRESSED round-0 responder is now re-invitable, and the
      // mark bookkeeping below runs outside the suppression branch, so its own
      // round-0 turn already advanced the mark to >= the trigger's ts — its
      // round-1 delta therefore MAY OMIT the human trigger (the delta filter is
      // strictly greater than the mark). The replacement invariant:
      //
      //   A round-1 reactor's delta may omit the human trigger. That is safe
      //   because the delta arm is reachable only when the reactor holds a
      //   resumable session row whose meetingLastSeenTs was advanced by one of
      //   ITS OWN earlier turns on this thread; and the mark advances (below)
      //   only after a non-errored, non-aborted turn, and only to the maximum
      //   ts over what that turn actually absorbed — its injected context ∪ its
      //   terminal slot. A mark at or above the trigger's ts therefore implies
      //   some turn of this agent PRESENTED the trigger (round-0 terminal slot)
      //   or INJECTED it (a later trigger's context). Either the mark predates
      //   the trigger (trigger in the delta) or the agent's own turn presented
      //   it (trigger in the transcript that turn produced) — no gap.
      //
      // ⚠ That invariant carries one named, accepted caveat: the mark advance
      // and the session persist are independent fail-soft writes and can
      // diverge, so the "session absorbed it" step is asserted, not derived.
      // See docs/epics/kpr-415/kpr-416-spec.md §7.2 — do not assume airtight.
      // A reactor with no session/mark gets the full transcript directly.
```

- [ ] **Step 3:** Make **T3** (`dispatcher-conference.test.ts:433`) deterministic **by construction**. Post-relocation it depends on peer B's delivery-time write landing before peer A's reaction pass reads the tracker — today that holds only by microtask-lockstep coincidence between two identical await chains. Insert one macrotask gate into `adapter.deliver` for this test only; because the write is the synchronous statement immediately *preceding* delivery, and every other harness mock resolves on microtasks, a single macrotask boundary in delivery guarantees **both** round-0 writes have landed before **either** reaction pass runs. Assertions are unchanged.

Insert immediately after the classifier mock setup, before `const item = makeWorkItem({...})`:
```ts
    // KPR-416 determinism gate (spec §10, T3). Post-relocation each responder's
    // exclusion write is the synchronous statement immediately BEFORE its own
    // delivery, and the reaction pass fires immediately AFTER it. Putting one
    // macrotask boundary inside delivery orders every round-0 write (reachable
    // on microtasks alone — all other harness mocks resolve immediately) ahead
    // of every reaction pass, by construction rather than by await-depth
    // coincidence. A flaky T3 is not acceptable as the KPR-387 guard.
    adapter.deliver.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
```

Add a header comment above the `it(...)` naming what it now guards:
```ts
  // KPR-387 duplicate-answer regression guard, re-derived for KPR-416 (§7.1):
  // half (a) of the fix — tracker recording — is RELOCATED, not removed, so a
  // round-0 primary that DELIVERED must still be skipped by the reaction pass.
  // Half (b) (the reactionTo terminal-slot reframing) is untouched by KPR-416.
```

- [ ] **Step 4:** Add **T1** — the primary fix, negative-verify — as a new top-level `it` in the suite, immediately after the T3 test.

```ts
  it("T1 (KPR-416): a SUPPRESSED round-0 primary becomes eligible to react to a slower peer's later reply", async () => {
    // Trial observation 1, reproduced (spec §1): the classifier selects three
    // primaries; two finish fast with "No response needed." (formed before the
    // slow peer's findings existed); the slow one later delivers real content.
    // Pre-KPR-416 the selection-time write had already excluded all three, so
    // peerMembers was empty and NOBODY reacted. Post-fix the two suppressed
    // agents are eligible and actually run round-1 turns.
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({ respondAgentIds: ["jasper", "river", "jessica"], costUsd: 0.001, durationMs: 100 })
      .mockResolvedValue({ respondAgentIds: ["river", "jessica"], costUsd: 0.001, durationMs: 100 });

    const threadId = "conf-thread-kpr416-t1";
    // Keyed by agentId, not call order: the slow primary resolves on a real
    // timer so the two suppressions are guaranteed to have completed first —
    // the trial's actual shape, and deterministic without leaning on
    // Promise.all ordering.
    agentManager.runWorkItemTurn.mockImplementation(async (agentId: string) => {
      if (agentId === "jasper") {
        await new Promise((r) => setTimeout(r, 10));
        return turn({ finalMessage: "Here is what I found after a long dig." });
      }
      return turn({ finalMessage: "No response needed." });
    });

    await dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, River, and Jessica, discuss the launch plan",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t1" },
        threadId,
        meta: { slackTs: "1700.0011" },
      }),
    );

    // Vacuous-pass guard (kpr-387-spec.md:155): assert a NON-EMPTY set of
    // round-0 turns actually ran before asserting anything about round 1.
    const round0Agents = agentManager.runWorkItemTurn.mock.calls
      .filter((c: any[]) => c[1]?.meta?.conferenceRound === 0)
      .map((c: any[]) => c[0])
      .sort();
    expect(round0Agents).toEqual(["jasper", "jessica", "river"]);

    // The reaction pass ran with BOTH suppressed peers on the roster...
    const reactionCalls = () =>
      (classifyMeetingMessage as any).mock.calls.filter(
        (c: any[]) => c[0] === "Here is what I found after a long dig.",
      );
    await vi.waitFor(() => expect(reactionCalls().length).toBeGreaterThanOrEqual(1));
    const peerIds = reactionCalls()[0][1].map((m: any) => m.agentId).sort();
    expect(peerIds).toEqual(["jessica", "river"]);

    // ...and both actually ran a round-1 turn.
    await vi.waitFor(() => {
      const round1Agents = agentManager.runWorkItemTurn.mock.calls
        .filter((c: any[]) => c[1]?.meta?.conferenceRound === 1)
        .map((c: any[]) => c[0])
        .sort();
      expect(round1Agents).toEqual(["jessica", "river"]);
    });
  });
```

- [ ] **Step 5:** **Land the two deferred negative assertions** (plan-review r1, blocking issues 1 and 2). Tasks 4 and 5 left placeholder `NOTE:` comments where these belong, because until Step 1 above deleted the selection-time write they were unreachable — a non-empty classifier result recorded the agent in the tracker at classification time no matter what the delivery-time sites did. With the write gone they are now both reachable **and** load-bearing: each is the assertion that actually distinguishes post-KPR-416 behavior from pre.

  1. In **T4**, replace the `NOTE:` placed after `adapter.deliver.mockClear()` with the real pin:
```ts
    expect(excludedFor(threadId, "1700.0008")).toBeUndefined(); // queued ⇒ NOT excluded
```
  2. In **T7 companion**, replace the trailing `NOTE:` with the real pin:
```ts
    expect(excludedFor(fastFailThread, "1700.0010")).toBeUndefined(); // notice, not agent text
```

  Both must now pass. If either still fails, the Step 1 deletion is incomplete — fix the source, not the assertion.

- [ ] **Step 6:** Verify the suite.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/
```
Expected: every file green, `T1 (KPR-416)`, the two newly-tightened assertions in `T4`/`T7 companion`, and the (now determinism-gated) `round-0 responders are excluded from the reaction-pass roster` all passing.

- [ ] **Step 7:** **NEGATIVE-VERIFY T1 (mandatory).** Restore the selection-time write only, run T1, confirm it fails, restore the fix.
```bash
cd /Users/mokie/github/hive-KPR-415
git stash push -- src/channels/dispatcher.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/dispatcher-conference.test.ts -t "T1 (KPR-416)"
```
Expected: **FAIL** — pre-fix the selection-time write records all three primaries, so `peerMembers` is empty, the reaction classifier is never called with the slow peer's text, and the `reactionCalls().length >= 1` waitFor times out.

> **What this stash actually reverts — read before doubting it.** `git stash push` stashes only **uncommitted** changes, and the `-- src/channels/dispatcher.ts` pathspec narrows it further to that one file. By the time you reach this step, Tasks 1-5 are already **committed**, so `markReactionExclusion`, the `meetingExclusionTs` stamp, and all three delivery-time call sites survive the stash untouched. The only thing removed is Task 6's own uncommitted source edit: the selection-time deletion and the two comment rewrites. The test file is not in the pathspec at all, so the T3 gate, T1 and the Step 5 assertions all stay in the working tree — which is exactly what makes the run meaningful.
>
> That makes the coarse `git stash` **exactly the precise pre-fix delta for this purpose** — equivalent to, not inferior to, a narrower per-hunk revert, and there is no reason to reach for one. T5, T8a, T4's phase-2 half and both T7 halves stay **green** during the stash: their source is committed and present. Only the Task-6-dependent assertions flip — T1 fails (the demonstration), and Step 5's two `toBeUndefined()` pins in T4/T7-companion fail, which is the same behavior change seen from the other side and is corroborating, not noise. T1's failure must be the `peerMembers`/round-1 assertion, not a compile error; a compile error means something committed got caught in the stash and the tree is dirtier than this step assumes — check `git status` before proceeding.

Then restore and re-confirm:
```bash
git stash pop
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/dispatcher-conference.test.ts -t "T1 (KPR-416)"
```
Expected: **PASS**.

> The path-limited stash above is already the precise delta, so no narrower revert is needed. Only if the stash/pop cycle is impractical for some local reason, the equivalent by-hand form is: re-insert the deleted `if (humanTs && classification.respondAgentIds.length > 0) { ... }` block from Step 1 (leaving the three call sites and both rewritten comments in place), run T1, confirm it fails, then delete it again. Same delta, more keystrokes.

- [ ] **Step 8:** Commit.
```bash
git add src/channels/dispatcher.ts src/channels/dispatcher-conference.test.ts
git commit -m "fix(kpr-416): relocate reaction-exclusion write from selection to delivery time

Deletes the selection-time meetingReactionTracker write in
resolveConferenceAgents; the three delivery-time call sites now carry it.
A suppressed round-0 primary becomes eligible to react to a slower peer's
later reply — the shape that silenced the live trial meeting. Every other
round-0 outcome keeps today's exclusion.

Rewrites the two comments the move falsifies: the selection-time rationale
(now naming the re-opened cross-agent race and its deferral) and KPR-388's
delta-injection premise (now stating the re-based covering invariant and
its accepted session-write caveat).

Also tightens T4 and T7's companion with the two 'not excluded' assertions
that only become reachable once the selection-time write is deleted.

Supersedes KPR-386 canon C1; preserves C2, KPR-387 half (b), KPR-413.
Negative-verified: T1 fails on pre-fix code.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: T2 — KPR-388 delta injection as new behavior (negative-verify)

**Files:**
- Test only: `src/channels/dispatcher-conference.test.ts` — new T2 inside `describe("delta context injection (KPR-388)")`

No source change. This test pins the §7.2 re-based invariant on the newly-reachable path.

- [ ] **Step 1:** Add T2 immediately after the existing `"C3: round-1 reactor's delta contains the triggering human message (mark predates it)"` test (`:1141-1183`).

```ts
    it("T2 (KPR-416): a suppressed round-0 responder re-invited as a reactor takes the DELTA arm, which omits the trigger", async () => {
      // The §7.2 re-based invariant, on the path KPR-416 newly exposes. The
      // asserted property is mark-advance-implies-own-turn-presented-it — NOT
      // "the delta covers the trigger", which is precisely what stops being
      // true here. Preconditions pinned explicitly: jessica's round-0 turn was
      // SUPPRESSED, her injection mode was `delta`, and resumedSession is true
      // so the clearMeetingMark branch does not apply.
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper", "jessica"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });

      const threadId = "conf-thread-kpr416-t2";
      const TRIGGER = "settle the pricing question before Friday";
      seedRef("jessica", threadId, { sessionId: "sess-j", provider: "claude", meetingLastSeenTs: "1000.0001" });

      // The mark write must actually feed the round-1 read for this invariant
      // to mean anything, so make setMeetingMark mutate the seeded ref.
      agentManager._sessionStore.setMeetingMark.mockImplementation(
        async (agentId: string, thread: string, ts: string) => {
          const key = `${agentId}:${thread}`;
          const ref = agentManager._sessionRefs.get(key);
          if (ref) agentManager._sessionRefs.set(key, { ...ref, meetingLastSeenTs: ts });
        },
      );

      mockSlackAdapter.fetchThreadHistory
        .mockResolvedValueOnce(
          makeHistory([
            { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
            { author: "May", text: TRIGGER, ts: "1000.0005", minAgo: 5 },
          ]),
        )
        .mockResolvedValue(
          makeHistory([
            { author: "May", text: "kickoff notes", ts: "1000.0001", minAgo: 30 },
            { author: "May", text: TRIGGER, ts: "1000.0005", minAgo: 5 },
            { author: "Jasper", text: "Slow findings on pricing", ts: "1000.0006", minAgo: 4, isBot: true },
          ]),
        );

      agentManager.runWorkItemTurn.mockImplementation(async (agentId: string) => {
        if (agentId === "jasper") {
          await new Promise((r) => setTimeout(r, 10)); // slow peer: jessica's mark lands first
          return turn({ finalMessage: "Slow findings on pricing", resumedSession: true });
        }
        return turn({ finalMessage: "No response needed.", resumedSession: true });
      });

      await dispatcher.dispatch(
        makeWorkItem({
          text: `Jasper, and Jessica, ${TRIGGER}`,
          source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t2" },
          threadId,
          meta: { slackTs: "1000.0005" },
        }),
      );

      // Precondition: jessica's round-0 turn was delta-mode and suppressed.
      const jessicaRound0 = agentManager.runWorkItemTurn.mock.calls.find(
        (c: any[]) => c[0] === "jessica" && c[1]?.meta?.conferenceRound === 0,
      );
      expect(jessicaRound0).toBeDefined();
      expect(jessicaRound0![1].meta.conferenceInjectionMode).toBe("delta");
      expect(mockLogInfo).toHaveBeenCalledWith(
        "Non-response suppressed (fan-out)",
        expect.objectContaining({ agentId: "jessica", conferenceRound: 0 }),
      );

      // (i) The mark advanced to >= the trigger ts on that suppressed turn.
      expect(agentManager._sessionStore.setMeetingMark).toHaveBeenCalledWith("jessica", threadId, "1000.0005");

      // Vacuous-pass guard: a round-1 turn must actually have happened before
      // asserting over its text (pre-fix it never dispatches at all).
      const round1Call = () =>
        agentManager.runWorkItemTurn.mock.calls.find(
          (c: any[]) => c[0] === "jessica" && c[1]?.meta?.conferenceRound === 1,
        );
      await vi.waitFor(() => expect(round1Call()).toBeDefined());

      // (ii) It took the delta arm, and the delta OMITS the trigger — safe only
      // by the §7.2 invariant (jessica's own round-0 terminal slot presented it).
      const round1Item = round1Call()![1];
      expect(round1Item.meta.conferenceInjectionMode).toBe("delta");
      // The two load-bearing assertions: the delta header is present, and the
      // human trigger is ABSENT from a re-invited suppressed agent's context.
      expect(round1Item.text).toContain("[New messages since your last turn:]");
      expect(round1Item.text).not.toContain(TRIGGER);
      // The delta BODY, pinned against the line shape formatDeltaContext
      // actually emits (`${author} (${ago}): ${text}`, dispatcher.ts:1808)
      // and anchored to the header so it cannot be satisfied from elsewhere.
      // A bare `toContain("Slow findings on pricing")` would be near-vacuous:
      // that string is also in reactionTo.text in the terminal slot, so it
      // passes even when the delta is empty or wrong.
      expect(round1Item.text).toMatch(
        /\[New messages since your last turn:\]\n\nJasper \([^)]+\): Slow findings on pricing/,
      );
    });
```

- [ ] **Step 2:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts -t "T2 (KPR-416)"
```
Expected: **PASS**, 1 test.

- [ ] **Step 3:** **NEGATIVE-VERIFY T2 (mandatory).** Re-insert only the deleted selection-time write block into `resolveConferenceAgents` (the exact block removed in Task 6 Step 1), run T2, confirm it fails, then remove it again.
```bash
cd /Users/mokie/github/hive-KPR-415
# (edit dispatcher.ts: restore the `if (humanTs && classification.respondAgentIds.length > 0) { ... }` block)
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test \
  npx vitest run src/channels/dispatcher-conference.test.ts -t "T2 (KPR-416)"
```
Expected: **FAIL** at the `expect(round1Call()).toBeDefined()` waitFor — pre-fix jessica is excluded at selection time and never dispatches a round-1 turn, which is the right reason. Then remove the block again and re-run:
Expected: **PASS**.

- [ ] **Step 4:** Commit.
```bash
git add src/channels/dispatcher-conference.test.ts
git commit -m "test(kpr-416): T2 — KPR-388 delta injection on the newly-exposed path

A suppressed round-0 responder re-invited as a round-1 reactor takes the
delta arm, whose strictly-greater filter omits the human trigger. Pins the
re-based §7.2 invariant (mark advance implies the agent's own turn
presented it), not 'the delta covers the trigger'. Negative-verified.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: T8b — continuation-leg behavior and its two no-exclusion companions

**Files:**
- Test only: `src/channels/dispatcher-conference.test.ts` — inside the KPR-413 continuation `describe`, after T8a

- [ ] **Step 1:** Add T8b with both companions.

```ts
      it("T8b (KPR-416): a continuation leg's delivery excludes; a cap-exhausted chain and a zero-progress abort do NOT", async () => {
        // Disposition (c), spec §6.3. The exclusion is written at DELIVERY, so
        // the leg that finally answers is what marks — and a chain that never
        // answers marks nothing. The two companions assert the same shape
        // through different arms, so a regression that starts marking at the
        // ABORT site rather than at delivery fails on both.
        await soloClassifier();
        const threadId = "conf-thread-kpr416-t8b";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn
          .mockResolvedValueOnce(ABORT_WITH_PROGRESS) // origin: deadline abort with progress
          .mockResolvedValueOnce(turn({ finalMessage: "Finished it on the second pass" })); // leg 1: answers

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t8b" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );
        await settleReactions();
        await settleReactions();

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
        expect(excludedFor(threadId, "1000.0004")).toEqual(new Set(["jasper"]));
      });

      it("T8b companion 1 (KPR-416): a chain that exhausts MAX_DEADLINE_CONTINUATIONS never excludes", async () => {
        await soloClassifier();
        const threadId = "conf-thread-kpr416-t8b-cap";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValue(ABORT_WITH_PROGRESS); // every leg aborts

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t8b" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );
        await settleReactions();
        await settleReactions();

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(MAX_DEADLINE_CONTINUATIONS + 1);
        // Terminal notice only — the agent never answered, so it is correctly
        // still eligible to react to a peer on this trigger.
        expect(excludedFor(threadId, "1000.0004")).toBeUndefined();
      });

      it("T8b companion 2 (KPR-416): a ZERO-progress deadline abort (notice only, no leg) never excludes", async () => {
        // §4's zero-progress row: maybeHandleDeadlineAbort's !withProgress arm
        // returns true after a notice, with no continuation leg and no
        // deliverAgentResult call — so no write site is ever reached.
        await soloClassifier();
        const threadId = "conf-thread-kpr416-t8b-zero";
        mockSlackAdapter.fetchThreadHistory.mockResolvedValue(ONE_MSG_HISTORY());
        agentManager.runWorkItemTurn.mockResolvedValueOnce(
          turn({ finalMessage: "", timedOut: true, aborted: true }), // no toolCalls, not streamed
        );

        await dispatcher.dispatch(
          makeWorkItem({
            text: "Jasper, status update?",
            source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t8b" },
            threadId,
            meta: { slackTs: "1000.0004" },
          }),
        );
        await settleReactions();

        expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(1); // no leg
        expect(excludedFor(threadId, "1000.0004")).toBeUndefined();
      });
```

> **Implementation note:** `excludedFor` and `turn` are suite-scoped after Task 3's hoist, so they are visible here. `MAX_DEADLINE_CONTINUATIONS` is already imported at the top of the file (`:5`).

- [ ] **Step 2:** Verify.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts -t "T8b"
```
Expected: **PASS**, 3 tests.

- [ ] **Step 3:** Commit.
```bash
git add src/channels/dispatcher-conference.test.ts
git commit -m "test(kpr-416): T8b — continuation-leg exclusion and its two no-answer companions

The leg that delivers is what marks; a cap-exhausted chain and a
zero-progress abort answer nothing and mark nothing. Both companions fail
if a regression starts marking at the abort site instead of at delivery.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: T9 — pin the deferred §6.4(d) residual, then the full gate

**Files:**
- Test only: `src/channels/dispatcher-conference.test.ts` — new top-level `it`

- [ ] **Step 1:** Add T9. This test **documents accepted behavior**, not desired behavior. Its comment must say so and must name the follow-on child, so a future reader does not "fix" the test.

```ts
  it("T9 (KPR-416): ⚠ ACCEPTED RESIDUAL — a peer whose round-0 turn has not landed IS invited as a round-1 reactor", async () => {
    // This pins a KNOWN, DELIBERATELY DEFERRED gap, not desired behavior.
    // Post-relocation there is no in-flight round-0 registry (the removed
    // selection-time write was incidentally serving as one), so within the
    // overlap window a peer that still owes a round-0 answer can also be
    // invited to react. Deferred because: (1) agent-manager's per-thread lock
    // `agentId:threadId` serializes the peer's round-1 turn behind its own
    // round-0 turn, so it answers first and then reacts — an extra turn, not a
    // duplicate answer, with round-1's "do not re-answer" framing holding the
    // line; (2) the in-scope fix would need an await inside
    // triggerConferenceReactions' claim-before-await loop, forfeiting KPR-387's
    // actual guarantee, and a pending-set leak at any early return means
    // PERMANENT exclusion — the original bug, worse.
    //
    // Spec: docs/epics/kpr-415/kpr-416-spec.md §6.4(d). The follow-on child
    // filed against KPR-415 INVERTS this assertion — when it lands, this test
    // is expected to change, and that is the signal, not a regression.
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    (classifyMeetingMessage as any)
      .mockResolvedValueOnce({ respondAgentIds: ["jasper", "river"], costUsd: 0.001, durationMs: 100 })
      .mockResolvedValue({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });

    const threadId = "conf-thread-kpr416-t9";
    let releaseRiver!: () => void;
    const riverLanded = new Promise<void>((resolve) => {
      releaseRiver = resolve;
    });
    agentManager.runWorkItemTurn.mockImplementation(async (agentId: string) => {
      if (agentId === "river") {
        await riverLanded; // river's round-0 turn has NOT landed when jasper reacts
        return turn({ finalMessage: "River, eventually" });
      }
      return turn({ finalMessage: "Jasper answers immediately" });
    });

    const dispatched = dispatcher.dispatch(
      makeWorkItem({
        text: "Jasper, River, and Jessica, discuss the launch plan",
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr416-t9" },
        threadId,
        meta: { slackTs: "1700.0012" },
      }),
    );

    // Jasper's reaction pass fires while river is still in flight.
    const reactionCalls = () =>
      (classifyMeetingMessage as any).mock.calls.filter((c: any[]) => c[0] === "Jasper answers immediately");
    await vi.waitFor(() => expect(reactionCalls().length).toBeGreaterThanOrEqual(1));

    const peerIds = reactionCalls()[0][1].map((m: any) => m.agentId);
    expect(peerIds).toContain("river"); // ⚠ the residual: river owes an answer AND is invited
    expect(peerIds).toContain("jessica"); // jessica never ran at all — expected

    releaseRiver();
    await dispatched;
    await settleReactions();
  });
```

> **Implementation note:** `dispatcher.dispatch` awaits the round-0 `Promise.all`, so the deferred must be released before awaiting `dispatched` or the test hangs. Keep the release before the await, as written.

- [ ] **Step 2:** Run the full gate.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```
Expected: typecheck clean, lint clean, `format:check` clean (run `npm run format` first if it complains), full vitest suite green with zero failures. The regression-surface tests listed above must be green **with zero edits** except the single deliberate T3 harness gate.

- [ ] **Step 3:** Confirm the diff is confined to the two intended files.
Run:
```bash
cd /Users/mokie/github/hive-KPR-415 && git diff --stat 0d0c493..HEAD -- src/
```
Expected: exactly two entries — `src/channels/dispatcher.ts` and `src/channels/dispatcher-conference.test.ts`. **`src/agents/agent-manager.ts` must not appear.**

- [ ] **Step 4:** Commit.
```bash
git add src/channels/dispatcher-conference.test.ts
git commit -m "test(kpr-416): T9 — pin the deferred overlapping-round-0 residual

Documents accepted behavior (spec §6.4(d)): a peer whose round-0 turn has
not landed is invited as a round-1 reactor. The follow-on child filed
against KPR-415 inverts this assertion.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Canon note — procedural, no files change

**This task edits nothing.** It is a hand-off item for the driver, kept in the task list so it is not dropped between implementation and PR. There is no code change, no spec edit, and no commit; `git status` must be clean when this task is done.

KPR-415 is a **pre-register epic** — as of plan time its ticket carries no `## Decision Register — Canon` section and no children have merged, so there is nowhere in-repo to write canon to. The two entries below therefore live in `kpr-416-spec.md` §13 (where they already are) until the register opens.

**What the driver does:**

1. Check the KPR-415 epic **ticket** (the tracker, not the repo) for a `## Decision Register — Canon` section — it may have opened since plan time.
2. **If it has opened:** lift both entries below into it verbatim.
   **If it has not:** leave them in the spec and state in the PR body that they are pending lift, so the orchestrator picks them up when the register opens. Either way they must be named in the PR body.
3. The two entries:
   - **Supersedes KPR-386 canon C1** ("selection-time recording"). C2 (tracker shape / keying / TTL) is preserved.
   - **KPR-388's covering invariant statement is preserved**, but `kpr-388-spec.md:145`'s "Round-1 reachability (C3)" *consequence bullet* is **falsified** by this child, and `kpr-388-spec.md:17`'s "duplication, never gaps" classification no longer holds for the suppressed-round-0-responder case (spec §7.2, accepted residual).

- [ ] Register state checked, both canon entries either lifted into the epic's Decision Register or flagged as pending-lift in the PR body. No files changed, nothing committed.

---

## Post-implementation checklist

- [ ] `npm run check` green with the three Slack env stubs.
- [ ] All 11 new/edited test cases present: T1, T2, T3 (edited harness), T4, T4b (×3 cases), T5, T6 (×2 cases), T7 (×2 sibling `it`s), T8a, T8b (+2 companions), T9.
- [ ] The two deferred assertions landed in Task 6 Step 5 — no `NOTE:` placeholder is left behind in T4 or T7's companion.
- [ ] T1 and T2 negative-verify performed and the failure reason recorded (not just "it failed").
- [ ] `src/agents/agent-manager.ts` untouched.
- [ ] No new config key, no schema change, no cross-module surface.
- [ ] KPR-413 T1/T2/T2b/T3, KPR-387 `:510` byte pin, KPR-388 `:849` delta pin, KPR-409 summary/cadence pins all green with zero edits.
- [ ] The four residuals in the out-of-scope table are still unfixed and still named in code comments or tests.
- [ ] PR body notes: supersedes KPR-386 C1; KPR-417 is unblocked and inherits the branch-position predicate (spec §11); the §6.4(d) follow-on child needs filing against KPR-415.
