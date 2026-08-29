# KPR-420 — Delivery-Mark Erasure Fix Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Close the delivery-mark erasure race by provenance-tagging the reaction tracker's per-trigger leaf (`Map<agentId, "claim" | "delivery-mark">`) so `triggerConferenceReactions`' release-on-non-selection loop spares entries promoted to delivery marks during its classifier await — plus two folded-in mechanical fixes (kpr-417-spec §13.5 addendum, ack-lever boot log relocation).

**Architecture:** The fix is spec option 1 ("tag, don't just add" — `kpr-420-spec.md` §4): one structure stays the single source of truth for exclusion (`.has()` remains the sole eligibility read), the value records write provenance, and the release loop consults the tag post-await — exactly where a mid-await promotion is observable. Three writer statements change plus one release-guard clause; keying, TTL sweep, and C1's write-time predicate are byte-identical. Docs ride along per the epic's append-only addendum convention and the C9 per-child `CLAUDE.md` docs-sync convention.

**Tech Stack:** TypeScript (strict), Vitest, in-memory dispatcher state only — no schema, no config, no Mongo, no adapter, no boot-order structure changes.

## Testing Contract

### Required Test Groups
- Unit: **required** / Scope: `src/channels/dispatcher-conference.test.ts` — new T1 (the real mid-await interleaving, the DoD test with a negative-verify obligation) and T2 (release still releases undelivered claims), plus the full existing suite green under the harness key-projection change; `src/boot-order.test.ts` green untouched. / Reason: the bug is a pure in-memory race inside the dispatcher; the conference suite's mocked-adapter harness is the exact surface it lives on. / Minimum assertions: T1 — no reaction-pass roster captured after B's delivery contains B; B's `runWorkItemTurn` count is exactly 1; B's leaf entry survives release as `"delivery-mark"`. T2 — an undelivered claim is absent after release and re-appears in a later pass's roster.
- Integration: **not-required** / Scope: n/a / Reason: no cross-process, cross-module, or persistence surface changes — the tracker is dispatcher-private in-memory state, and the conference suite (real `Dispatcher`, mocked registry/manager/adapter) already exercises the full dispatch→claim→release→re-claim flow end to end. / Harness: n/a / Minimum assertions: n/a
- E2E: **not-required** / Scope: n/a / Reason: the failure mode was verified empirically by the integrated-head reviewer's live 3-agent probe; the fix adds a `log.info` line ("Reaction release spared delivered peer") precisely so the next live probe is free. No new boot, config, or channel surface exists to exercise. / Harness: n/a / Minimum assertions: n/a

### Critical Flows
1. **The erasure race (closed):** peer A delivers → A's pass synchronously claims in-flight B, C → B delivers mid-await (promotion to `"delivery-mark"`) → A's classifier resolves selecting nobody → release spares B → later passes skip B at the `.has()` filter.
2. **Plain release (preserved):** unselected, undelivered peer stays `"claim"` → deleted → re-claimable by a later round-0 responder's pass.
3. **All three KPR-416 write sites promote identically** — fan-out delivery, single-dispatch delivery, `handleTurnFailure`'s `if (adapter)` arm all run the same unconditional `.set("delivery-mark")`.
4. **Boot-order guard unaffected** — `boot-order.test.ts` anchors on the `dispatcher.setMeetingAckEnabled(` call text (lines 47/55/69/95), which does not move.

### Regression Surface
- `dispatcher-conference.test.ts` entire suite — especially the `:517` exclusion guard (macrotask suppression **stays**), KPR-416 T1/T4/T4b/T6/T7/T8a/T8b, T9 (assertions unchanged — a T9 behavior change means scope creep into KPR-419), KPR-389 D5 kill-suppression, KPR-413 leg tests. The four value-level `toEqual(new Set([...]))` assertions (`:1576`, `:1673`, `:1696`, `:2012`) and every `toBeUndefined()` read (`:1659`, `:1737`, `:2035`, `:2060`) must pass **unmodified** — the `excludedFor` key projection is the whole harness delta.
- `dispatcher.test.ts`, `boot-order.test.ts` — untouched, must stay green.
- Non-conference hot path: `markReactionExclusion` stays a type-guarded no-op for plain turns (T4b pins the blast radius).

### Commands
```bash
npx vitest run src/channels/dispatcher-conference.test.ts   # conference suite
npx vitest run src/boot-order.test.ts                        # boot-order guard
npm run check                                                # full gate: typecheck + lint + format + test
```

### Harness Requirements
Existing mocked harness in `dispatcher-conference.test.ts` (real `Dispatcher`, mock registry/agentManager/adapter, mocked `meeting-classifier`). New tests add deferred-promise gates on `classifyMeetingMessage` and `runWorkItemTurn` — no new harness machinery, no fake timers (the suite's own warning at `:877-904`: `useFakeTimers` + `settleReactions` deadlocks; use real-timer drains only).

### Non-Required Rationale
Integration/E2E: see the group rows above — dispatcher-private in-memory state, no external surface, live-probe evidence already on record, and the spared-peer log line makes future production verification observable.

### Verification Rules
- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- **Negative-verify obligation (spec §9 T1):** T1 must demonstrably FAIL against the pre-fix `dispatcher.ts` (Task 2 Step 3 does this via `git checkout af45459 -- src/channels/dispatcher.ts`). Skipping that step is not acceptable.
---

### Task 1: Provenance-tagged tracker leaf + harness key projection

The code fix (spec §5.1–§5.3, §6) and the test-harness accessor change land together so the suite is green at the commit boundary: the leaf type change makes four existing value-level assertions (`toEqual(new Set([...]))`) fail without the `excludedFor` key projection.

**Files:**
- Modify: `src/channels/dispatcher.ts:163-177` (module-scope type), `:200-206` (tracker decl + comment), `:685-702` (`markReactionExclusion` doc + writer), `:1848-1850` (site-1 comment), `:2293` (claim get-or-create), `:2305` (claim write), `:2319-2325` (release loop)
- Modify: `src/channels/dispatcher-conference.test.ts:260-274` (`excludedFor` accessor + new `rawTrackerLeaf` sibling)

- [ ] **Step 1:** Add the module-scope provenance type. In `src/channels/dispatcher.ts`, immediately after the `OutageHandlingDeps` interface closes (line 175, before `export class Dispatcher {` at line 177), insert:
```typescript
/** KPR-420: provenance tag for a reaction-tracker entry. "claim" = written by
 *  triggerConferenceReactions' claim-before-await loop, releasable on
 *  non-selection; "delivery-mark" = written by markReactionExclusion at a
 *  KPR-416 delivery site (or promoted from a claim mid-await), never released. */
type ReactionTrackerEntry = "claim" | "delivery-mark";
```
- [ ] **Step 2:** Amend the tracker declaration and its doc comment (lines 200-206). The closing sentence "Shape, keying and TTL are unchanged (C2)." is falsified by the leaf change and must be rewritten (spec §6 row 1). Replace:
```typescript
  // Map<threadId, Map<humanMessageTs, Set<agentId>>> — agents excluded from
  // reacting on this human message, either round (KPR-387). Round-0 primaries
  // are recorded at DELIVERY time (KPR-416 — markReactionExclusion, three call
  // sites; supersedes KPR-386 canon C1's selection-time recording, so a
  // SUPPRESSED primary is no longer excluded), round-1 reactors at claim time
  // (triggerConferenceReactions). Shape, keying and TTL are unchanged (C2).
  private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();
```
with:
```typescript
  // Map<threadId, Map<humanMessageTs, Map<agentId, ReactionTrackerEntry>>> —
  // agents excluded from reacting on this human message, either round
  // (KPR-387). Round-0 primaries are recorded at DELIVERY time (KPR-416 —
  // markReactionExclusion, three call sites; supersedes KPR-386 canon C1's
  // selection-time recording, so a SUPPRESSED primary is no longer excluded),
  // round-1 reactors at claim time (triggerConferenceReactions). Keying and
  // TTL are unchanged; the leaf was amended by KPR-420 to carry PROVENANCE
  // (ReactionTrackerEntry) so release-on-non-selection can tell an erasable
  // claim from a delivery mark. Membership (.has) still means "excluded" and
  // stays the SINGLE exclusion read — never introduce a second exclusion
  // structure (KPR-415 canon C19).
  private meetingReactionTracker = new Map<string, Map<string, Map<string, ReactionTrackerEntry>>>();
```
- [ ] **Step 3:** Amend `markReactionExclusion`'s doc + writer. The doc sentence at lines 685-686 is falsified on both halves ("Set add" and "shape … unchanged" — spec §6 row 2). Replace:
```typescript
   * Synchronous and idempotent (Set add). Tracker shape, keying and TTL are
   * unchanged — KPR-386 canon C2 preserved, C1 superseded.
```
with:
```typescript
   * Synchronous and idempotent (unconditional Map set). Tracker keying and
   * TTL are unchanged — KPR-386 canon C1 superseded; the leaf carries a
   * KPR-420 provenance tag ("delivery-mark" here), so a write landing on an
   * existing "claim" is a PROMOTION the release loop must spare.
```
Then replace the writer body (lines 700-702):
```typescript
    const responded = threadTracker.get(ts) ?? new Set<string>();
    responded.add(agentId);
    threadTracker.set(ts, responded);
```
with:
```typescript
    const responded = threadTracker.get(ts) ?? new Map<string, ReactionTrackerEntry>();
    responded.set(agentId, "delivery-mark");
    threadTracker.set(ts, responded);
```
(Unconditional set — a fresh write, an idempotent re-write, and a promotion of an existing `"claim"` are the same statement. The `meetingExclusionTs` type guard above it is untouched.)
- [ ] **Step 4:** Amend the claim path in `triggerConferenceReactions`. Replace line 2293:
```typescript
    const reacted = threadTracker.get(humanTs) ?? new Set<string>();
```
with:
```typescript
    const reacted = threadTracker.get(humanTs) ?? new Map<string, ReactionTrackerEntry>();
```
and replace line 2305:
```typescript
      reacted.add(agentId); // claim before await — prevents race with concurrent calls
```
with:
```typescript
      // Claim before await — prevents race with concurrent calls. The
      // reacted.has() skip above guarantees this never overwrites an
      // existing "delivery-mark" (an agent already present never enters
      // peerMembers).
      reacted.set(agentId, "claim");
```
- [ ] **Step 5:** Provenance-guard the release loop (lines 2319-2325). Replace:
```typescript
    // Release peers that weren't selected — they can still be triggered by other round-0 responders
    const selectedSet = new Set(classification.respondAgentIds);
    for (const member of peerMembers) {
      if (!selectedSet.has(member.agentId)) {
        reacted.delete(member.agentId);
      }
    }
```
with:
```typescript
    // Release peers that weren't selected — they can still be triggered by
    // other round-0 responders. KPR-420: delete only entries still tagged
    // "claim" — this read runs AFTER the classifier await above, exactly
    // where a mid-await promotion is observable, so a peer whose round-0
    // turn DELIVERED during the await keeps its "delivery-mark" instead of
    // being erased and re-invited to a trigger it already answered (the
    // delivery-mark erasure found at integrated-head review round 1).
    const selectedSet = new Set(classification.respondAgentIds);
    for (const member of peerMembers) {
      if (!selectedSet.has(member.agentId)) {
        if (reacted.get(member.agentId) === "claim") {
          reacted.delete(member.agentId);
        } else {
          // Diagnostically motivated (this race was found by a live probe —
          // this line makes the next probe free); redaction-compliant: ids
          // and ts only, never message text.
          log.info("Reaction release spared delivered peer", {
            threadId,
            humanTs,
            agentId: member.agentId,
          });
        }
      }
    }
```
- [ ] **Step 6:** Split the site-1 residual comment per the §5.4/§8 non-conflation boundary. Replace lines 1848-1850:
```typescript
        // The remaining window is cross-agent, not self: a PEER whose own
        // round-0 turn has not landed can still be invited. That is the
        // accepted, deferred residual — kpr-416-spec.md §6.4(d), pinned T9.
```
with:
```typescript
        // The remaining window is cross-agent, not self — and it is ONLY the
        // claim-time half: a PEER whose round-0 turn has not landed can be
        // claimed and invited. That is the accepted, deferred residual —
        // kpr-416-spec.md §6.4(d), owned by KPR-419, pinned T9. Release-time
        // erasure of a LANDED peer's delivery mark is FIXED (KPR-420, the
        // provenance-guarded release) — do not conflate the two.
```
- [ ] **Step 7:** Update the test-harness accessor in `src/channels/dispatcher-conference.test.ts`. Replace lines 260-274 (the doc comment + `excludedFor`) with the Map-leaf harness type, a `rawTrackerLeaf` sibling (T1/T2 in Task 2 assert the tag directly), and the key projection — `undefined` preserved when the leaf is absent, so all four `toEqual(new Set([...]))` assertions and every `toBeUndefined()` read pass byte-identical:
```typescript
  /**
   * KPR-416: the tracker is the eligibility STATE under test, so the write-
   * site cases read it directly rather than inferring it from a downstream
   * reaction pass. The behavioral pins (T1, T3, T9) assert through
   * triggerConferenceReactions instead. Same `dispatcher as unknown as {...}`
   * convention as the T6/C4 guard below.
   *
   * KPR-420: the leaf is now Map<agentId, "claim" | "delivery-mark">.
   * excludedFor projects KEYS to a value-level Set — membership still means
   * "excluded", so the existing value assertions stand unmodified. The
   * projection is deliberately shape-agnostic (Set.prototype.keys() yields
   * values), which keeps it working against pre-fix code for the T1
   * negative-verify pass. rawTrackerLeaf exposes the tag itself for the
   * KPR-420 provenance assertions.
   */
  const rawTrackerLeaf = (threadId: string, humanTs: string): Map<string, "claim" | "delivery-mark"> | undefined =>
    (
      dispatcher as unknown as {
        meetingReactionTracker: Map<string, Map<string, Map<string, "claim" | "delivery-mark">>>;
      }
    ).meetingReactionTracker
      .get(threadId)
      ?.get(humanTs);
  const excludedFor = (threadId: string, humanTs: string): Set<string> | undefined => {
    const leaf = rawTrackerLeaf(threadId, humanTs);
    return leaf === undefined ? undefined : new Set(leaf.keys());
  };
```
- [ ] **Step 8:** Verify
Run: `npm run typecheck && npx vitest run src/channels/dispatcher-conference.test.ts`
Expected: typecheck clean; all existing conference tests pass with **zero assertion edits** (the projection is the whole harness delta). If any `toEqual(new Set(...))` or `toBeUndefined()` assertion needed touching, that is an implementation error in Step 7 — fix the accessor, not the test.
- [ ] **Step 9:** Commit
```bash
git add src/channels/dispatcher.ts src/channels/dispatcher-conference.test.ts
git commit -m "KPR-420: provenance-tag the reaction tracker leaf — release spares delivery marks"
```

### Task 2: Regression tests — T1 (real interleaving, negative-verified), T2 (release still releases), comment amendments

**Files:**
- Modify: `src/channels/dispatcher-conference.test.ts:524-533` (macrotask-suppression comment gains the T1 pointer), `:1754-1756` (T9 comment non-conflation note), new tests inserted after the T9 test body (after line `1796`, before the `round-1 kill suppression (KPR-389 D5)` describe)

- [ ] **Step 1:** Add the T1 pointer to the `:517` test's macrotask-boundary comment. The suppression **stays** (it is what makes the KPR-387 duplicate-answer guard deterministic — spec §9 T3). After the existing comment line `// of every reaction pass, ... A flaky T3 is not acceptable as the KPR-387 guard.` (line 530), append one comment line before `adapter.deliver.mockImplementation`:
```typescript
    // "T1 (KPR-420)" below is the UNSUPPRESSED sibling: it engineers the
    // real mid-await interleaving this boundary deliberately orders away.
```
- [ ] **Step 2:** Insert the two new tests after the T9 test's closing `});` (line 1796). Complete code:
```typescript
  it("T1 (KPR-420): a round-0 primary that delivers DURING a sibling's classifier await stays excluded after release", async () => {
    // The delivery-mark erasure race (kpr-420-spec.md §1), engineered for
    // real — the unsuppressed sibling of the macrotask-ordered KPR-387 guard
    // above (:517). Sequence: jasper delivers fast and his reaction pass
    // synchronously claims river + jessica, then parks on a HELD classifier
    // call; river's round-0 turn delivers mid-await (promoting his claim to
    // a delivery mark); the classifier resolves selecting nobody, so the
    // release loop runs; jessica then delivers round-0 and fires her own
    // pass. Pre-fix the release erased river's mark (claim and delivery mark
    // were the same aliased Set entry), so jessica's pass re-claimed river
    // and selected him for a round-1 reaction to a trigger he had already
    // answered. Post-fix the release spares the promoted entry and river
    // never reappears in any roster.
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    const threadId = "conf-thread-kpr420-t1";
    const humanText = "Jasper, River, and Jessica, discuss the launch plan";

    let resolveJasperPass!: (v: unknown) => void;
    const jasperPassHeld = new Promise((r) => {
      resolveJasperPass = r;
    });
    (classifyMeetingMessage as any).mockImplementation(async (text: string) => {
      if (text === humanText) {
        // Round-0: all three named agents are primaries.
        return { respondAgentIds: ["jasper", "river", "jessica"], costUsd: 0.001, durationMs: 100 };
      }
      if (text === "Jasper's answer") return jasperPassHeld; // held mid-await
      if (text === "Jessica's answer") {
        // Reachable PRE-FIX ONLY (post-fix jessica's peerMembers is empty and
        // no call happens): select river — the erased-mark re-invitation.
        return { respondAgentIds: ["river"], costUsd: 0.001, durationMs: 100 };
      }
      return { respondAgentIds: [], costUsd: 0.001, durationMs: 100 };
    });

    let releaseRiver!: () => void;
    const riverGate = new Promise<void>((r) => (releaseRiver = r));
    let releaseJessica!: () => void;
    const jessicaGate = new Promise<void>((r) => (releaseJessica = r));
    agentManager.runWorkItemTurn.mockImplementation(async (agentId: string, dispatchedItem: any) => {
      if (agentId === "river" && dispatchedItem?.meta?.conferenceRound === 0) {
        await riverGate;
        return turn({ finalMessage: "River's answer" });
      }
      if (agentId === "jessica") {
        await jessicaGate;
        return turn({ finalMessage: "Jessica's answer" });
      }
      return turn({ finalMessage: "Jasper's answer" });
    });

    const dispatched = dispatcher.dispatch(
      makeWorkItem({
        text: humanText,
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr420-t1" },
        threadId,
        meta: { slackTs: "1700.0420" },
      }),
    );

    // Step 1 — jasper delivered; his pass has synchronously claimed river +
    // jessica and is now parked on the held classifier call.
    const jasperPassCalls = () =>
      (classifyMeetingMessage as any).mock.calls.filter((c: any[]) => c[0] === "Jasper's answer");
    await vi.waitFor(() => expect(jasperPassCalls().length).toBe(1));

    // Step 2 — river's round-0 turn delivers MID-AWAIT (write site 1 fires;
    // river's own pass finds nothing unclaimed and returns without a
    // classifier call).
    releaseRiver();
    await vi.waitFor(() =>
      expect(adapter.deliver.mock.calls.some((c: any[]) => c[0].text === "River's answer")).toBe(true),
    );

    // Step 3 — jasper's classifier resolves selecting nobody; the release
    // loop runs over his pass's peerMembers (river + jessica).
    resolveJasperPass({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });
    await settleReactions();

    // Step 4 — jessica delivers round-0 and fires her own pass.
    releaseJessica();
    await dispatched;
    await settleReactions();
    await settleReactions();

    // No reaction-pass roster captured after river's delivery contains river.
    const jessicaPassRosters = (classifyMeetingMessage as any).mock.calls
      .filter((c: any[]) => c[0] === "Jessica's answer")
      .map((c: any[]) => c[1].map((m: any) => m.agentId));
    for (const rosterIds of jessicaPassRosters) {
      expect(rosterIds).not.toContain("river"); // pre-fix: FAILS — river re-claimed
    }

    // River ran exactly once (round-0) — never a round-1 turn on this trigger.
    const riverTurns = agentManager.runWorkItemTurn.mock.calls.filter((c: any[]) => c[0] === "river");
    expect(riverTurns.length).toBe(1); // pre-fix: FAILS at 2

    // The promoted entry survived release as a delivery mark.
    expect(excludedFor(threadId, "1700.0420")?.has("river")).toBe(true);
    expect(rawTrackerLeaf(threadId, "1700.0420")?.get("river")).toBe("delivery-mark");
  });

  it("T2 (KPR-420): an unselected, UNDELIVERED claim is still released and re-claimable by a later pass", async () => {
    // Pins that the provenance guard does not over-retain (spec goal 2, the
    // KPR-387→KPR-416 release semantics unchanged): jessica is a roster
    // member who is NOT a round-0 primary — claimed by jasper's pass, held
    // as a plain "claim" through the classifier await, released on
    // non-selection, then re-claimed by river's later pass. Also pins the §7
    // convergence edge: river's claim is released while he is undelivered,
    // and his subsequent delivery writes a FRESH "delivery-mark".
    const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
    const threadId = "conf-thread-kpr420-t2";
    const humanText = "Jasper, River, and Jessica, discuss the launch plan";

    let resolveJasperPass!: (v: unknown) => void;
    const jasperPassHeld = new Promise((r) => {
      resolveJasperPass = r;
    });
    (classifyMeetingMessage as any).mockImplementation(async (text: string) => {
      if (text === humanText) {
        // Round-0: jasper + river only — jessica never runs a round-0 turn.
        return { respondAgentIds: ["jasper", "river"], costUsd: 0.001, durationMs: 100 };
      }
      if (text === "Jasper's answer") return jasperPassHeld;
      return { respondAgentIds: [], costUsd: 0.001, durationMs: 100 };
    });

    let releaseRiver!: () => void;
    const riverGate = new Promise<void>((r) => (releaseRiver = r));
    agentManager.runWorkItemTurn.mockImplementation(async (agentId: string) => {
      if (agentId === "river") {
        await riverGate;
        return turn({ finalMessage: "River's answer" });
      }
      return turn({ finalMessage: "Jasper's answer" });
    });

    const dispatched = dispatcher.dispatch(
      makeWorkItem({
        text: humanText,
        source: { kind: "slack", id: "C-CONF", label: "conf-kpr420-t2" },
        threadId,
        meta: { slackTs: "1700.0421" },
      }),
    );

    // Jasper's pass has claimed river (in-flight) and jessica (never runs).
    const jasperPassCalls = () =>
      (classifyMeetingMessage as any).mock.calls.filter((c: any[]) => c[0] === "Jasper's answer");
    await vi.waitFor(() => expect(jasperPassCalls().length).toBe(1));
    expect(rawTrackerLeaf(threadId, "1700.0421")?.get("jessica")).toBe("claim");

    // Classifier selects nobody → both UNDELIVERED claims are released.
    resolveJasperPass({ respondAgentIds: [], costUsd: 0.001, durationMs: 100 });
    await settleReactions();
    expect(excludedFor(threadId, "1700.0421")?.has("jessica")).toBe(false);
    expect(excludedFor(threadId, "1700.0421")?.has("river")).toBe(false);

    // River then delivers round-0: fresh "delivery-mark", and his own pass
    // re-claims jessica — release did not over-retain.
    releaseRiver();
    await dispatched;
    await settleReactions();
    const riverPassCalls = (classifyMeetingMessage as any).mock.calls.filter(
      (c: any[]) => c[0] === "River's answer",
    );
    expect(riverPassCalls.length).toBe(1);
    expect(riverPassCalls[0][1].map((m: any) => m.agentId)).toContain("jessica");
    expect(rawTrackerLeaf(threadId, "1700.0421")?.get("river")).toBe("delivery-mark");
  });
```
- [ ] **Step 3:** Negative verification (the DoD obligation, spec §9 T1). Restore the pre-fix dispatcher, run T1, confirm it FAILS, restore the fix:
```bash
git checkout af45459 -- src/channels/dispatcher.ts
npx vitest run src/channels/dispatcher-conference.test.ts -t "T1 (KPR-420)"
```
Expected: **FAIL** — either `rosterIds` contains `"river"` or `riverTurns.length` is 2 (the erased mark re-invites river). T2 may also fail here (`rawTrackerLeaf(...)?.get` is not a function on a Set leaf) — incidental, only T1's failure is the obligation. Then:
```bash
git checkout HEAD -- src/channels/dispatcher.ts
npx vitest run src/channels/dispatcher-conference.test.ts -t "KPR-420"
```
Expected: T1 and T2 both PASS.
- [ ] **Step 4:** Amend the T9 comment (no assertion change — T9 must stay green as-is; a T9 behavior change means scope creep into KPR-419). After the existing lines 1754-1756:
```typescript
    // Spec: docs/epics/kpr-415/kpr-416-spec.md §6.4(d). The follow-on child
    // filed against KPR-415 INVERTS this assertion — when it lands, this test
    // is expected to change, and that is the signal, not a regression.
```
append:
```typescript
    //
    // KPR-420 non-conflation note: this residual is CLAIM-TIME invitation of
    // an in-flight peer (KPR-419's scope). It is distinct from RELEASE-TIME
    // erasure of a landed peer's delivery mark, which KPR-420 fixed (see
    // "T1 (KPR-420)" below) — the two must not be conflated.
```
- [ ] **Step 5:** Verify
Run: `npx vitest run src/channels/dispatcher-conference.test.ts && npx vitest run src/boot-order.test.ts`
Expected: full conference suite green (existing tests untouched in behavior), boot-order guard green.
- [ ] **Step 6:** Commit
```bash
git add src/channels/dispatcher-conference.test.ts
git commit -m "KPR-420: regression tests — mid-await delivery survives release (T1/T2)"
```

### Task 3: Ack-lever boot log relocation (mechanical fix 2)

**Files:**
- Modify: `src/index.ts:460-471`

- [ ] **Step 1:** Give the ack lever its own log line and remove `ackEnabled` from the scribe payload — leaving it in both places invites drift and re-creates the wrong-subsystem grep hit (spec §5.6). Replace lines 460-471:
```typescript
  // KPR-417: the delay-then-ack lever is a SPAWN-READ fact (dispatchToAgent
  // reads it per turn), so it is wired here, above the spawn-capable boundary
  // below — same rule as the pool and the scribe. Guarded by
  // src/boot-order.test.ts, which carries this call as an anchor in all three
  // of its lists.
  dispatcher.setMeetingAckEnabled(config.meetingWorkers.ackEnabled);
  log.info("Meeting scribe wired", {
    scribeEnabled: config.meetingWorkers.scribeEnabled,
    scribeModel: config.meetingWorkers.scribeModel,
    scribeMaxConcurrent: config.meetingWorkers.scribeMaxConcurrent,
    ackEnabled: config.meetingWorkers.ackEnabled,
  });
```
with:
```typescript
  // KPR-417: the delay-then-ack lever is a SPAWN-READ fact (dispatchToAgent
  // reads it per turn), so it is wired here, above the spawn-capable boundary
  // below — same rule as the pool and the scribe. Guarded by
  // src/boot-order.test.ts, which carries this call as an anchor in all three
  // of its lists. KPR-420: it logs on its own line — the lever is
  // scribe/pool-INDEPENDENT (canon C15), so its boot state must not be filed
  // under the scribe's log line where an operator diagnosing "why no acks"
  // would grep the wrong subsystem.
  dispatcher.setMeetingAckEnabled(config.meetingWorkers.ackEnabled);
  log.info("Meeting ack lever wired (KPR-417)", { ackEnabled: config.meetingWorkers.ackEnabled });
  log.info("Meeting scribe wired", {
    scribeEnabled: config.meetingWorkers.scribeEnabled,
    scribeModel: config.meetingWorkers.scribeModel,
    scribeMaxConcurrent: config.meetingWorkers.scribeMaxConcurrent,
  });
```
- [ ] **Step 2:** Verify
Run: `npm run typecheck && npx vitest run src/boot-order.test.ts`
Expected: clean typecheck; boot-order guard green — its anchors (lines 47/55/69/95) are on the `dispatcher.setMeetingAckEnabled(` **call** text, which does not move.
- [ ] **Step 3:** Commit
```bash
git add src/index.ts
git commit -m "KPR-420: give the ack lever its own boot log line (mechanical fix 2)"
```

### Task 4: Spec addenda — kpr-417-spec §13.5 (C18 ruling) + kpr-416-spec §15 (release-loop correction)

Append-only, per the sibling-spec convention (kpr-416 §14, kpr-417 §13) — the superseded historical lines are **never edited in place**. Wording is ⚠ delegated (spec §13); the text below implements spec §5.5 and the §6 kpr-416 row, grounded in canon C18's register text.

**Files:**
- Modify: `docs/epics/kpr-415/kpr-417-spec.md` (append after §13.4, end of file at line 473)
- Modify: `docs/epics/kpr-415/kpr-416-spec.md` (append after §14.3, end of file at line 357)

- [ ] **Step 1:** Append to `docs/epics/kpr-415/kpr-417-spec.md` (after the final line "Full reasoning: the `# Decision Register Entry` comment keyed to `2499a57` …"):
```markdown

### 13.5 C18 ruling — the substitution is ratified (2026-08-29)

*Appended by KPR-420 (folded-in mechanical fix, `kpr-420-spec.md` §5.5). Added rather than edited in place — the same append-only convention as §13 itself; the superseded lines below stay as written.*

§13.3's pending `GATE1_AMENDMENT` is **resolved**: May Huang ratified the delay-then-ack substitution at the 15s threshold **directly**, via `rule-coherence` on `2499a57` (2026-08-29, ruling session `rule-kpr415-20260829T045458Z`) — now canon **KPR-415/C18**. Consequences for this document:

- The Key Points bullet at `:26` and its §8 assumption-ledger restatement at `:342`, which present the substitution as *delegated under the Gate 1 signoff*, are **superseded wherever that framing appears** — C18's register text names both lines. The circular delegated-from-the-signoff reasoning §13.3 dissected is retired as precedent and must not be cited by future children.
- §13.3's park condition is lifted; Gate 1 item 3's confirmation requirement is satisfied retroactively.
- `MEETING_ACK_DELAY_MS` stays a non-configurable module constant; `0` remains the recorded one-line path to the literal immediate ack if ever revisited (in which case T2 is retired, not repaired — §13.3's instruction stands).
```
- [ ] **Step 2:** Append to `docs/epics/kpr-415/kpr-416-spec.md` (after the final line "Full reasoning: the `# Decision Register Entry` comment keyed to `fa48196` …"):
```markdown

## 15. Post-KPR-420 addendum — the release loop is no longer "unchanged" (2026-08-29)

*Appended by KPR-420 (`kpr-420-spec.md`, blocking corrective from integrated-head review round 1). Append-only, per the §14 precedent — the superseded rows and sentences below stay as written.*

KPR-420 found (verified by live probe) that this spec's delivery-time write and `triggerConferenceReactions`' claim-before-await release loop mutate the **same aliased leaf** per `(threadId, humanTs)`: a round-0 primary delivering *during* a sibling pass's classifier await had its delivery mark silently erased by the release-on-non-selection that followed — reopening C1's "delivered stays excluded" guarantee through a timing window. Corrections to this document:

- **§8's integration-points row "`triggerConferenceReactions` unchanged" (`:253`, including the release at `:1911`) is falsified**, as are its echoes — the §3 non-goal at `:59` and §5.4's untouched list at `:129`. The release loop is now **provenance-guarded**: the tracker leaf is `Map<agentId, "claim" | "delivery-mark">` (KPR-415/C19), `markReactionExclusion` writes/promotes to `"delivery-mark"`, and release deletes only entries still tagged `"claim"`. Membership semantics (`.has()` = excluded), keying, and TTL are unchanged; the "shape … unchanged (C2)" phrasing this spec carried forward from KPR-386 is amended — the amendment is leaf type only.
- **§6.4(d)'s residual framing is narrowed.** The accepted residual is the *claim-time* half only — a peer claimed while its round-0 turn is in flight can still be selected (owned by KPR-419). Release-time erasure of a landed peer's mark was never part of that residual's bounding argument and is fixed by KPR-420 — the two must not be conflated.
- **§14.1's boundedness re-derivation cited the release (`:2059`) without analyzing the aliasing.** Its ≤ 2N−1 conclusion survives; its argument now runs through the provenance guard (a selected reactor is still never released; a spared delivery mark only ever shrinks eligibility).
```
- [ ] **Step 3:** Verify
Run: `npm run format`
Expected: no diffs introduced by the formatter on the two spec files (prettier covers markdown in this repo; if it rewrites anything, take the formatter's output).
- [ ] **Step 4:** Commit
```bash
git add docs/epics/kpr-415/kpr-417-spec.md docs/epics/kpr-415/kpr-416-spec.md
git commit -m "docs(kpr-415): KPR-420 — kpr-417-spec §13.5 + kpr-416-spec §15 addenda"
```

### Task 5: CLAUDE.md docs-sync (C9) + full gate

Per canon C9, per-child docs-sync into root `CLAUDE.md` on the child branch. Both edits land inside the single **Meeting mode (KPR-386)** bullet (one long line, currently line 283). The spec names the two falsified clauses (§6, last table row).

**Files:**
- Modify: `CLAUDE.md:283` (Meeting mode bullet — two in-line clause replacements)

- [ ] **Step 1:** Correct the falsified C2 clause. In the Meeting mode bullet, replace the substring:
```
supersedes KPR-386 canon C1's selection-time write, preserves C2's tracker shape/keying/TTL)
```
with:
```
supersedes KPR-386 canon C1's selection-time write; keying/TTL preserved, leaf shape amended by KPR-420 to a provenance Map — see below)
```
- [ ] **Step 2:** Amend the accepted-residual sentence — the release loop no longer erases delivered marks; the residual narrows to claim-time only. Replace the substring:
```
Accepted residual (deliberately deferred by KPR-416): there is no in-flight/pending set, so a peer whose own round-0 turn has not yet delivered can still be claimed as a round-1 reactor — bounded by the per-thread lock (its reaction turn serializes behind its own round-0 turn, same lock key) plus round-1's do-not-re-answer framing, at the named cost that on a slow provider the pair can burn two turn deadlines back to back.
```
with:
```
**Provenance-tagged tracker leaf (KPR-420):** the per-trigger leaf is `Map<agentId, "claim" | "delivery-mark">` — `markReactionExclusion` writes/promotes to `"delivery-mark"`, `triggerConferenceReactions`' claim-before-await loop writes `"claim"`, and the release-on-non-selection loop deletes **only** entries still tagged `"claim"`, so a delivery mark landing during a concurrent pass's classifier await survives release (pre-KPR-420 the aliased leaf made the two indistinguishable and release could erase a delivered primary's mark, re-inviting an agent that had already answered — found empirically at integrated-head review). Membership (`.has()`) remains the single exclusion read — **never introduce a second exclusion structure (C19)**. Accepted residual (deliberately deferred by KPR-416, narrowed by KPR-420 to claim-time only, owned by KPR-419): a peer whose own round-0 turn has not yet delivered can still be **claimed and selected** as a round-1 reactor — bounded by the per-thread lock (its reaction turn serializes behind its own round-0 turn, same lock key) plus round-1's do-not-re-answer framing, at the named cost that on a slow provider the pair can burn two turn deadlines back to back; release-time erasure of a landed peer's mark is no longer part of this residual.
```
- [ ] **Step 3:** Verify — full quality gate for the whole ticket.
Run: `npm run check`
Expected: typecheck + lint + format + full test suite all green.
- [ ] **Step 4:** Commit
```bash
git add CLAUDE.md
git commit -m "docs-sync: KPR-420 — CLAUDE.md meeting-mode provenance-leaf amendment (C9)"
```

---

## Out of scope (do not touch)

- The claim-time residual (C6 / KPR-419) — no pre-dispatch `"delivery-mark"` recheck before `dispatchToAgent` (rejected, spec §5.3/§5.4); T9's assertions unchanged.
- C1's write-time predicate — the three call sites, positional framing, round-0-only `meetingExclusionTs` stamp (C4) stay byte-identical.
- `sweep()` (`dispatcher.ts:1887-1901`) — whole-thread delete, untouched (verify only).
- The `:531` macrotask suppression — stays, with the Task 2 Step 1 pointer only.
- Any config lever — rollback = code revert of this ticket's commits (C8/C15 discriminant: internal eligibility state).
- Editing historical spec text in place — addenda are append-only.
- Canon register lifts (§12 C19/C20) — happen at merge, upstream of this plan.
