# KPR-420 — Fix delivery-mark erasure: concurrent reaction-pass release un-excludes a delivered round-0 responder

**Epic:** KPR-415 (Meeting mode hardening — trial-gap follow-ups to KPR-386)
**Kind:** blocking corrective, filed at the integrated-head review of `submit-epic-pr` attempt 1 round 1 (register entry on KPR-415, session `drive-kpr415-20260829T053343Z`). Not a pre-planned child.
**Repo baseline:** `lane-kpr-420-mature` worktree, branch cut from the epic branch at `6c1ed68` (post docs-sync sweep, KPR-416 `fa48196` + KPR-417 `2499a57` merged). All line citations below were verified against this tree.

---

## TL;DR

`markReactionExclusion`'s delivery-time exclusion write (KPR-416) and `triggerConferenceReactions`' claim-before-await release loop mutate the **same aliased `Set`** per `(threadId, humanTs)`, so a round-0 primary that delivers *during* a sibling's `await classifyMeetingMessage(...)` has its delivery mark silently erased by the release-on-non-selection that follows — reopening canon C1's "delivered stays excluded" guarantee through a timing window (verified empirically by the round-1 reviewer with a live 3-agent probe). The fix is the reviewer's **option 1 — tag, don't just add**: the tracker's per-trigger leaf becomes `Map<agentId, "claim" | "delivery-mark">` (membership semantics unchanged), `markReactionExclusion` writes/promotes to `"delivery-mark"`, and the release loop deletes only entries still tagged `"claim"`. Two folded-in mechanical fixes ride along: a §13.5 addendum to `kpr-417-spec.md` recording canon C18's ratification, and the ack lever's boot log moved out of the "Meeting scribe wired" line in `src/index.ts`.

## Key Points

- **Fix shape: option 1 (tag in place), not option 2 (two sets) or option 3 (canonize as residual).** One structure keeps one source of truth for "excluded" — `.has()` stays the sole eligibility read (`dispatcher.ts:2302`) — where a second parallel set would reintroduce the aliasing-class hazard this ticket exists to fix (a future eligibility or sweep site reading one structure but not the other). Option 3 is rejected outright: this is a verified regression of the epic's own founding fix, the code fix is ~6 lines, and canonizing it away after an empirical repro would trade a cheap fix for a permanent C1 asterisk.
- **Membership semantics are untouched; only release provenance changes.** Every existing read (`reacted.has()` at `:2302`, `responded`-presence in tests) keeps its meaning. The only behavioral delta: an unselected peer whose entry was promoted to `"delivery-mark"` during the classifier await is **spared** by the release loop instead of erased. C1's write-time predicate (positional, delivery-time, three call sites) is byte-for-byte preserved.
- **The claim-time residual (canon C6 / KPR-419) is deliberately NOT touched.** A peer claimed while its round-0 turn is in flight can still be *selected* as a reactor even if it delivers mid-await — that is C6's accepted residual, bounded by the per-thread lock, and KPR-419's structural fix (`isThreadActive`) closes it. A pre-dispatch `"delivery-mark"` check was considered and rejected as a race-dependent partial duplicate of KPR-419 (§5.4). This spec's fix closes only the **release-erasure** path, which C6 never covered because the peer there has already delivered.
- **Tracker shape amendment, keying/TTL preserved:** the leaf collection changes `Set<string>` → `Map<string, ReactionTrackerEntry>`; the two outer Map levels, the `(threadId, humanTs)` keying, and the `sweep()` TTL path (`:1895`, whole-thread delete) are unchanged. This amends the "shape/keying/TTL unchanged (C2)" framing KPR-416 carried forward from KPR-386 C2 — which lives in the code comments (`dispatcher.ts:205`, `:685-686`) and CLAUDE.md's meeting-mode bullet, not in the register's C1 entry itself — recorded in §12 canon for the register.
- **Testing: the deliberately-suppressed interleaving gets a live sibling, not a replacement.** The macrotask boundary at `dispatcher-conference.test.ts:531` stays (it is what makes the KPR-387 duplicate-answer guard deterministic); a **new** test engineers the exact race with a gated classifier — delivery lands during a pending reaction-pass await, release runs, and the delivered agent must stay excluded from every subsequent roster. The T9 residual comment (`:1740`) gains a non-conflation note separating claim-time (KPR-419's scope) from the erasure fixed here.
- **No config lever; rollback = code revert** — per the C8/C15 discriminant (*internal eligibility state ⇒ code revert; visible meeting output ⇒ operator lever*). This is pure internal eligibility state, same posture as KPR-416.
- **Folded-in mechanical fix 1 (docs):** `kpr-417-spec.md:26` (restated at `:342`) and §13.3 (`:461`) still describe the delay-then-ack substitution as delegated/parked; canon C18 (May Huang, 2026-08-29) ratified it directly and retired that framing. A **§13.5 appended addendum** records the ruling — append, never edit the historical record (the sibling-spec convention).
- **Folded-in mechanical fix 2 (boot log):** `src/index.ts:465-471` logs `ackEnabled` inside the `"Meeting scribe wired"` line, though C15 establishes the ack lever is scribe/pool-independent. It gets its own log line adjacent to the `setMeetingAckEnabled` call; the boot-order guard's anchors are on the *call*, not the log, so the guard is unaffected (verified against `src/boot-order.test.ts:47/:55/:69/:95`).
- ⚠ **Delegated assumptions** (Gate 1 delegation; recorded, not blocking): tag-value naming and exact log-line wording (§5.6, §7); keeping T3's suppression rather than inverting it, satisfied instead by the new race test (§9); appending a short correction addendum to `kpr-416-spec.md` (§15) since its §8 "`triggerConferenceReactions` **unchanged**" row (`:253`) is falsified by this fix.

---

## 1. Problem

KPR-416 (`fa48196`) moved reaction-exclusion recording from selection time to delivery time so a suppressed round-0 primary stays round-1-eligible (canon C1). The write lands via `markReactionExclusion` (`src/channels/dispatcher.ts:689`) at three delivery call sites (`:1851` fan-out, `:508` single-dispatch, `:774` failure arm). Round-1 machinery in `triggerConferenceReactions` claims not-yet-reacted peers **synchronously before** its `await classifyMeetingMessage(...)` (`:2305`, the KPR-387 double-trigger guard) and, after the await, **releases** any claimed peer the classifier did not select (`:2320-2325`) so another round-0 responder can still trigger them.

Both writers operate on the **same aliased `Set`** retrieved from `meetingReactionTracker` (`:206`) for the `(threadId, humanTs)` pair. The interleaving that breaks C1 (all four steps ordinary):

1. Peer **A** delivers → `markReactionExclusion(A)` → its reaction pass claims in-flight peers **B**, **C** before its own classifier await (this claim-before-await is C6's accepted residual).
2. During that ~1-3s await, **B's own round-0 turn delivers** → `markReactionExclusion(B)` is a **no-op `Set.add`** — B is already present from step 1's claim. The delivery mark and the claim are indistinguishable.
3. A's classifier returns without selecting B → `reacted.delete(B)` (`:2323`). **B's delivery mark is gone.**
4. Any later round-0 deliverer's pass re-claims B — `reacted.has(agentId)` (`:2302`) is the only eligibility filter — and can select B for a round-1 reaction to a trigger it already answered.

Verified empirically by the integrated-head reviewer (live probe, 3-agent roster, integrated head `6c1ed68`): a genuinely-delivered agent (confirmed via `adapter.deliver` assertion) ended up absent from the exclusion set and present in a subsequent reaction-pass roster. Pre-KPR-416 this was structurally impossible — the selection-time write put every primary in the tracker before any dispatch, so a primary never entered `peerMembers` and could never be released.

**Un-canonized:** C6 covers only the *claim-time* residual (peer's round-0 **not landed** at claim), bounded by the per-thread lock serializing the pair. Here the peer has **delivered** before re-invitation — C6's bounding argument does not apply and its stated cost is reached via a path C6 never described. `kpr-416-spec.md` §8's integration-points table lists `triggerConferenceReactions` as **unchanged** (`:253` — including the release at `:1911`; the same not-touching claim rides §3's non-goals at `:59` and §5.4's untouched list at `:129`), and §14.1's boundedness re-derivation cites the release (`:2059`) without ever analyzing the aliasing. The register (C1–C18) has no entry for a delivered primary losing its mark.

**Bounded, not a cascade** (why "important," not "critical"): the ≤2N−1 turns-per-trigger ceiling and "reacts at most once, once selected" both survive — only an *unselected, released* peer is affected. Blast radius is one extra round-1 turn by an agent that already answered, with round-1's "do not re-answer" framing holding the content line. It still violates C1's stated guarantee, on the exact starvation axis this epic was founded to fix.

The existing regression guard (`dispatcher-conference.test.ts:531-533`) deliberately engineers this interleaving away — a macrotask boundary inside the test `deliver` stub orders every round-0 write ahead of every reaction pass — so no test currently exercises the real race.

### Folded-in mechanical findings (same review round)

1. `docs/epics/kpr-415/kpr-417-spec.md:26` (Key Points delegated-assumption bullet), its §8 assumption-ledger restatement (`:342`), and §13.3 (`:461-465`) still present the delay-then-ack substitution as *delegated under the Gate 1 signoff* / *parked pending the operator's ruling*. Canon **C18** ratified the substitution directly (`rule-coherence` on `2499a57`, 2026-08-29), resolved the pending `GATE1_AMENDMENT`, and explicitly retired the circular delegated-from-the-signoff framing as precedent.
2. `src/index.ts:465-471`: `dispatcher.setMeetingAckEnabled(...)` is immediately followed by `log.info("Meeting scribe wired", { ..., ackEnabled })` — the ack lever's boot-time state is filed under the scribe subsystem, though canon **C15** establishes `ackEnabled` is independent of the scribe/worker-pool machinery. An operator diagnosing "why no acks" greps the wrong subsystem.

## 2. Goals

1. A round-0 primary whose turn **handed text to delivery** stays excluded from reacting on that trigger for the trigger's full tracker lifetime — including when its delivery lands during a concurrent reaction pass's classifier await. (Restores C1's "delivered stays excluded" half, closed against the timing window.)
2. Release-on-non-selection keeps working for peers that have **not** delivered: an unselected, undelivered claim is still released and re-claimable by a later round-0 responder (the KPR-387→KPR-416 semantics, unchanged).
3. A real regression test exercises the actual interleaving — delivery landing during a sibling's classifier await — not a suppressed rendering of it.
4. The C6/T9 residual documentation no longer conflates the claim-time residual (KPR-419's scope) with this erasure.
5. Both folded-in mechanical fixes land: the `kpr-417-spec.md` §13.5 addendum recording C18, and a dedicated boot log line for the ack lever.

## 3. Non-goals

- **Closing the claim-time residual (C6 / `kpr-416-spec.md` §6.4(d))** — a peer claimed while its round-0 turn is in flight can still be selected and run an extra round-1 turn. That is KPR-419's scope (recommended shape: synchronous `AgentManager.isThreadActive`); T9 continues to pin it.
- **Progress hints / any KPR-418 territory.**
- **Any change to C1's write-time predicate** — the three call sites, the positional framing, the round-0-only `meetingExclusionTs` stamp (C4) all stay byte-identical.
- **Any config lever** — see §10.
- **Editing historical spec text in place** — corrections to `kpr-417-spec.md` / `kpr-416-spec.md` are appended addenda only.
- **Awaiting or reordering anything inside the claim-before-await loop** — C6 already rejected an `await` there (pending-set leak ⇒ permanent exclusion, the original bug, worse).

## 4. Fix-shape decision — why option 1

The reviewer left three shapes unpicked; this spec's call:

**Option 1 — tag, don't just add (CHOSEN).** The per-trigger leaf becomes `Map<agentId, "claim" | "delivery-mark">`. Membership (`.has()`) keeps meaning "excluded"; the value records *provenance*; the release loop deletes only entries still `"claim"`.
- One structure ⇒ one source of truth. Every existing consumer — the eligibility filter (`:2302`), the test harness's tracker reads, `sweep()` — needs at most a type-level change, and no future site can read "excluded" from the wrong structure.
- The bug is precisely a *provenance* bug (release cannot tell a claim from a delivery mark); a value tag expresses the distinction at the exact point it is consulted, post-await, where promotion is observable.
- Smallest diff: three writer statements plus one release-guard clause.

**Option 2 — split into two sets (REJECTED).** Matches C1's iff wording most directly on paper, but doubles the bookkeeping surface: eligibility must read `delivered.has(x) || claims.has(x)`, both structures must be created and swept together, and a future writer touching one but not the other is exactly the aliasing-class drift this ticket exists to close. The "iff" C1 states is about *when marks are written* — option 1 preserves that identically.

**Option 3 — canonize as a fourth accepted residual (REJECTED).** The epic's founding bug (trial observation 1: a delivered/settled roster state mishandled around a slow peer) reopening through a new door, empirically reproduced, at a ~6-line fix cost. C6-style acceptance is for fixes whose in-scope shape is *worse than the disease* (the pending-set-leak argument); no such argument exists here — the fix is synchronous, leak-free, and touches no await structure.

## 5. Design

### 5.1 Tracker leaf type

```ts
/** KPR-420: provenance tag for a reaction-tracker entry. "claim" = written by
 *  triggerConferenceReactions' claim-before-await loop, releasable on
 *  non-selection; "delivery-mark" = written by markReactionExclusion at a
 *  KPR-416 delivery site (or promoted from a claim mid-await), never released. */
type ReactionTrackerEntry = "claim" | "delivery-mark";

private meetingReactionTracker = new Map<string, Map<string, Map<string, ReactionTrackerEntry>>>();
```

Outer keying (`threadId → humanTs → agentId`) and TTL sweep (`sweep()` at `:1895` deletes whole thread entries) are unchanged.

### 5.2 Writer changes (three statements)

- `markReactionExclusion` (`:701`): `responded.add(agentId)` → `responded.set(agentId, "delivery-mark")`. Unconditional set — a fresh write, an idempotent re-write, and a promotion of an existing `"claim"` are the same statement. Still synchronous, still idempotent, still a no-op off the meeting path (the `meetingExclusionTs` type guard is untouched).
- Claim loop (`:2305`): `reacted.add(agentId)` → `reacted.set(agentId, "claim")`. The preceding `reacted.has(agentId)` skip (`:2302`) guarantees this never overwrites an existing `"delivery-mark"` — an agent already present never enters `peerMembers`.
- Release loop (`:2320-2325`):

```ts
const selectedSet = new Set(classification.respondAgentIds);
for (const member of peerMembers) {
  if (!selectedSet.has(member.agentId) && reacted.get(member.agentId) === "claim") {
    reacted.delete(member.agentId);
  }
}
```

The `=== "claim"` read happens **after** the await — exactly where a mid-await promotion is observable. A spared promotion should log (`log.info`, agentId/threadId/humanTs only — no message text, per log-redaction rules), because this race was found by a live probe and a log line makes the next probe free:

```ts
log.info("Reaction release spared delivered peer", { threadId, humanTs, agentId: member.agentId });
```

### 5.3 Interleaving analysis (why this closes the race and nothing else moves)

- **The bug's sequence:** P_A claims B (`"claim"`) → B delivers mid-await → promotion to `"delivery-mark"` → P_A's release reads `"delivery-mark"`, spares B → later passes skip B at `:2302`. Closed.
- **Plain release still works (goal 2):** unselected, undelivered B stays `"claim"` → deleted → re-claimable by a later responder's pass. Unchanged.
- **No cross-pass interference:** two passes can never hold the same agent in `peerMembers` simultaneously — the claim loop is synchronous and skips present entries, and releases only run over the releasing pass's own `peerMembers`. Selected reactors are never in any release loop (their own pass skips them via `selectedSet`; other passes never claimed them), so they persist as `"claim"` until sweep — value never consulted again, behavior identical to today.
- **Selected-while-delivering (the C6 sub-case, untouched):** P_A's classifier *selects* B while B delivers mid-await → B runs a round-1 turn despite having delivered. This is within C6's accepted residual — under the per-thread lock a claimed in-flight peer always delivers round-0 before its round-1 turn runs anyway, so "delivered agent runs a reaction turn" is the residual's normal outcome, reached slightly earlier. A pre-dispatch `"delivery-mark"` recheck before `dispatchToAgent` (`:2414`) was considered and **rejected**: it is a race-dependent partial of KPR-419's structural fix (whether it fires depends on where in the classifier/history-fetch/context-build await chain the delivery lands), it would blur this corrective's scope into a deferred sibling's, and KPR-419's `isThreadActive` shape closes the whole window deterministically.
- **Round-1 deliveries never promote:** round-1 items carry no `meetingExclusionTs` (stamped round-0-only, C4; the additive-only spread at `:1734-1736`), so `markReactionExclusion` no-ops for them. Unchanged.
- **All three write sites promote identically:** an errored-with-text, `_No response._`-placeholder, or thrown (site 3, `:774`) round-0 turn landing mid-await is spared exactly like a clean delivery — C1's positional predicate decides what marks; this fix only decides what *survives release*.
- **Suppressed primaries:** never marked (write sites sit in the `!isNonResponse` branch), so a suppressed primary claimed by a sibling pass stays `"claim"` and is released normally — C1's "SUPPRESSED is re-eligible" half is untouched.
- **Outage replays / continuation legs:** re-enter via the single-dispatch leg (site 2, `:508`) carrying `meetingExclusionTs` → promote/set `"delivery-mark"` on delivery. Same semantics as today's add, now erase-proof.

### 5.4 What this deliberately leaves open

After this fix the *only* remaining path for a round-1 invitation to an agent that answers round-0 on the same trigger is the claim-time window (claimed before landing, then selected) — C6's residual, exactly KPR-419's scope. This is the non-conflation boundary §8's doc updates must state: **KPR-419 = claim-time invitation of an in-flight peer; KPR-420 = release-time erasure of a landed peer's mark. Fixed here: the latter only.**

### 5.5 Mechanical fix 1 — `kpr-417-spec.md` §13.5 addendum

Append a new `### 13.5 C18 ruling — the substitution is ratified (2026-08-29)` after §13.4, recording: May Huang ratified delay-then-ack at the 15s threshold directly via `rule-coherence` on `2499a57` (canon C18, session `rule-kpr415-20260829T045458Z`); the pending `GATE1_AMENDMENT` of §13.3 is resolved; the `:26` "delegated under the Gate 1 signoff" framing is superseded **wherever it appears** (C18's register text names both `:26` and the §8 assumption-ledger restatement at `:342`) and its circular reasoning retired as precedent; `MEETING_ACK_DELAY_MS` stays a non-configurable constant with `0` as the recorded one-line path to the literal immediate ack. Lines `:26` and `:461-465` themselves are **not edited** — the addendum convention both sibling specs already follow (kpr-416 §14, kpr-417 §13).

### 5.6 Mechanical fix 2 — ack lever boot log

In `src/index.ts`, immediately after `dispatcher.setMeetingAckEnabled(config.meetingWorkers.ackEnabled)` (`:465`): add its own line, e.g.

```ts
log.info("Meeting ack lever wired (KPR-417)", { ackEnabled: config.meetingWorkers.ackEnabled });
```

and **remove** `ackEnabled` from the `"Meeting scribe wired"` payload (`:470`) — leaving it in both places invites drift and re-creates the wrong-subsystem grep hit. The boot-order guard (`src/boot-order.test.ts`) anchors on the `dispatcher.setMeetingAckEnabled(` **call** text, not the log line; the call itself does not move, so all three lists stay green. ⚠ Delegated: exact log message wording.

## 6. Integration points

| Surface | Change |
|---|---|
| `dispatcher.ts:206` tracker decl + `:200-205` doc comment | leaf `Set<string>` → `Map<string, ReactionTrackerEntry>`; comment gains the provenance-tag sentence and drops "Set" phrasing |
| `dispatcher.ts:689-703` `markReactionExclusion` + doc (`:685` "Set add") | `.add` → `.set("delivery-mark")` (`:701`); doc updated |
| `dispatcher.ts:700` `markReactionExclusion` get-or-create | `?? new Set<string>()` → `?? new Map<string, ReactionTrackerEntry>()` — the symmetric twin of the claim-path get-or-create below |
| `dispatcher.ts:2293-2294, :2305` claim path | `Set` get-or-create → `Map` get-or-create; `.add` → `.set("claim")` |
| `dispatcher.ts:2320-2325` release loop | provenance guard + spared-peer log line (§5.2) |
| `dispatcher.ts:1848-1850` site-1 comment, `:1895` sweep | comment: split the residual sentence per §5.4; sweep untouched (verify only) |
| `dispatcher-conference.test.ts:270` (+ any leaf reads) | test-harness type updated to the Map leaf |
| `dispatcher-conference.test.ts` new test | the real-interleaving regression guard (§9 T1) |
| `dispatcher-conference.test.ts:1740` T9 comment | non-conflation note (§5.4 boundary; KPR-419 vs KPR-420) |
| `docs/epics/kpr-415/kpr-417-spec.md` | appended §13.5 (§5.5) |
| `docs/epics/kpr-415/kpr-416-spec.md` | appended short §15 addendum: §8's "`triggerConferenceReactions` **unchanged** (release `:1911`)" row (`:253` — echoed by the §3 non-goal at `:59` and §5.4's list at `:129`) and §6.4's residual framing are amended by KPR-420 — the release loop is now provenance-guarded; the claim-time residual alone remains, owned by KPR-419. §14.1's boundedness derivation likewise never analyzed the aliasing. ⚠ Delegated: exact addendum wording |
| `src/index.ts:465-471` | dedicated ack-lever log line; `ackEnabled` removed from scribe line (§5.6) |
| root `CLAUDE.md` (Meeting mode section) | per C9, docs-sync on this child branch: amend the "Accepted residual (deliberately deferred by KPR-416)" sentence — the release loop no longer erases delivered marks (KPR-420); residual narrows to claim-time only |
| Canon register | §12 entries proposed for lift at merge |

Nothing outside `dispatcher.ts`, its conference test file, `index.ts`, and docs. No schema, no config, no Mongo, no adapter, no boot-order structure changes.

## 7. Edge cases

- **Double delivery marks** (e.g. errored turn then retry-queue delivery): `.set("delivery-mark")` twice — idempotent.
- **Promotion after release already ran** (B delivers after P_A's release erased… cannot happen post-fix: release spares promoted entries; if B delivers *after* release ran on a still-`"claim"` entry, the entry was deleted while B was undelivered — B's delivery then writes a fresh `"delivery-mark"`. Every ordering converges to B excluded once delivered.)
- **Classifier throws mid-pass:** `triggerConferenceReactions` rejects; the `.catch` at `:1856` logs. Claims from the failed pass are never released — same leak-toward-exclusion behavior as today (a subsequent trigger has a fresh `humanTs` key; within this trigger those peers stay claimed). Pre-existing, out of scope, unchanged by the tag.
- **Sweep during a pending pass:** `sweep()` deletes the thread's tracker; the pass's `reacted` alias keeps the detached Map — writes land on garbage, reads are consistent. Pre-existing behavior, unchanged (the sweeper's thread TTL is orders of magnitude above a pass's seconds-scale lifetime).
- **Memory:** tag value adds a constant string ref per entry; entries per thread bounded by roster × triggers, swept with the thread. Negligible.
- **Non-Slack conference surfaces** (no `humanTs`): `meetingExclusionTs` never stamped, tracker untouched — unchanged.

## 8. Documentation contract (residual non-conflation)

Three places must state the §5.4 boundary in one sentence each: the site-1 comment (`:1848-1850`), the T9 test comment (`:1740`), and the `CLAUDE.md` meeting-mode paragraph. Formula: *claim-time invitation of an in-flight peer = accepted residual, KPR-419; release-time erasure of a landed peer's delivery mark = fixed, KPR-420.*

## 9. Testing contract

- **T1 (the race, real interleaving — the DoD test).** Gated classifier: round-0 selects A and B; A delivers fast; A's reaction pass's classifier call is held on a deferred promise; **while it is pending**, B's (timer-held) round-0 turn delivers; the classifier then resolves selecting nobody (release runs); a third roster member C then delivers round-0, firing its own pass. Assert: no reaction-pass roster captured **after B's delivery** contains B; B's `runWorkItemTurn` count is exactly 1; (optionally, via the existing harness tracker accessor) B's entry survives release as `"delivery-mark"`. This test must **fail on the pre-fix code** (release erases B; C's pass re-claims and can select B) — negative-verify obligation, same discipline as KPR-416's T-suite.
- **T2 (release still releases).** An unselected, **undelivered** peer is released and successfully re-claimed by a later round-0 responder's pass (pins that the fix does not over-retain). If an existing case already covers re-claim, extend it with an explicit assertion rather than duplicating.
- **T3 (existing suite).** `dispatcher-conference.test.ts` passes with only type-level harness changes — in particular the `:517` exclusion guard, T1/T6/T8a/T8b (KPR-416), and T9 unchanged in behavior. The `:531` macrotask suppression **stays** with a one-line comment pointing at T1 as the unsuppressed sibling.
- **T9 comment amendment** (no assertion change — the claim-time residual is untouched, T9 must stay green as-is; a T9 behavior change here would mean scope creep into KPR-419).
- **Mechanical fixes:** `boot-order.test.ts` stays green untouched (anchors are on the call). Docs changes carry no tests.
- Full `npm run check` green.

## 10. Rollback

Code revert of this ticket's commits. No lever, per the C8/C15 discriminant — internal eligibility state, invisible in meeting output except as the absence of a duplicate-ish reaction turn. The docs addenda are append-only and need no rollback pairing.

## 11. Relationship to siblings

- **KPR-416:** this is a corrective *to* its release-loop blind spot; its predicate, call sites, meta key, and all other canon (C1, C3, C4, C5, C7) are preserved verbatim. Its spec's §8 "`triggerConferenceReactions` unchanged" row (`:253`) is amended by appended addendum.
- **KPR-417:** untouched at runtime (acks never enter the tracker — `deliverMeetingAck` is not a write site); receives the §13.5 docs addendum and the boot-log relocation.
- **KPR-419:** owns the claim-time residual this fix deliberately leaves; T9 remains its inversion target. Nothing here pre-empts or partially implements it (§5.3's rejected pre-dispatch check).
- **KPR-418:** untouched.

## 12. Canon (to lift into KPR-415's Decision Register at merge)

- **C19 (proposed):** The reaction tracker's per-trigger leaf carries **provenance** — `Map<agentId, "claim" | "delivery-mark">` — and the release-on-non-selection loop deletes **only `"claim"` entries**, so a delivery mark written (or promoted) during a concurrent pass's classifier await survives release. Restores C1's "delivered stays excluded" against the timing window found at integrated-head review round 1. Membership semantics (`.has()` = excluded), keying, and TTL unchanged; **amends the "tracker shape/keying/TTL unchanged (C2)" framing** KPR-416 carried forward from KPR-386 C2 — its actual carriers are the code comments at `dispatcher.ts:205` and `:685-686` plus CLAUDE.md's "preserves C2's tracker shape/keying/TTL" language, not the register's C1 entry (which states no shape clause); the amendment is leaf type only. Eligibility remains the single `.has()` read — **standing invariant: never introduce a second exclusion structure** (option 2 rejected for aliasing-class drift risk). Claim-time invitation of an in-flight peer remains C6's residual, owned by KPR-419 — the two must not be conflated. (KPR-420)
- **C20 (proposed, mechanical):** C18's ratification is recorded in `kpr-417-spec.md` §13.5 by appended addendum; the ack lever logs its boot state on its own line, not under the scribe's — C15's independence holds down to the boot log. (KPR-420)

## 13. Open assumptions (⚠ delegated under Gate 1)

- ⚠ Tag literals `"claim"` / `"delivery-mark"` (naming only; any two-value discriminant satisfies the design).
- ⚠ The spared-peer `log.info` line (§5.2) — diagnostically motivated, redaction-compliant; drop to `log.debug`-equivalent or omit if review prefers silence.
- ⚠ Exact wording of the ack-lever log line and of the two appended spec addenda (§5.5, §6 kpr-416 row).
- ⚠ T3's suppression is kept (not inverted) with the new T1 as the live-race guard — reading the ticket's "replace (or invert)… with a real regression guard" as satisfied by the suite now exercising the real interleaving, while preserving the deterministic KPR-387 guard T3 exists to be.
