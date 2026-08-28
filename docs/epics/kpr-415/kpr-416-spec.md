# KPR-416 — Reaction-exclusion tracker: relocate eligibility write from selection time to delivery time

**Epic:** KPR-415 (Meeting mode hardening) · **Child:** A · **Kind:** child spec · **Status:** spec-ready (draft)
**Governing design:** `keepur/hive-docs` → `internal/specs/2026-08-28-meeting-mode-hardening-design.md`, §"Design — Child A" and §"Testing expectation (epic-level)" (approved, spec-review/8/frontier, clean)
**Repo baseline:** `hive-KPR-415` worktree, branch `KPR-415` at `0d0c493` (v0.14.0). All `dispatcher.ts` line citations below were re-verified against this tree; the epic design's citations were found accurate and are carried forward unchanged unless noted.
**Downstream:** KPR-417 (delay-then-ack) blocks on this ticket. See §11.

---

## TL;DR

`meetingReactionTracker` marks every classifier-selected round-0 agent as "has responded" at **selection time**, before any of them run — so fast decliners are permanently excluded from reacting to a slow peer's later, substantive reply, which is exactly what silenced dodi's meeting room in the live trial. This child moves that single eligibility-deciding write from selection time (`dispatcher.ts:1641-1650`) to **delivery time**, behind one uniform rule: *an agent is excluded from reacting on a trigger iff its own round-0 turn handed text to delivery on that trigger.* Net behavioral delta is deliberately one class of agent — the suppressed round-0 responder, which becomes round-1-eligible; delivered, errored, placeholder and thrown round-0 turns keep today's exclusion via three explicit write sites plus one new meta key that survives the KPR-402 continuation-leg strip.

---

## Key Points

- **Write predicate (open disposition a) — RESOLVED: branch position (`!isNonResponse`), not "genuinely non-empty non-errored content."** The rule is *"handed text to delivery"*, which is precisely what the non-suppressed branch means. Rationale is scope discipline: the trial gap is about **suppressed** primaries; re-including **errored** primaries is an unrequested second behavior change, it re-opens the burn `:1636-1638` deliberately closed, and re-inviting a broken agent just posts a second `Something went wrong:` into the meeting. Minimal delta beats maximal principle here. ⚠ **This choice overrides the epic design's leaning recommendation** — the departure is named and justified in §6.1. **KPR-417 depends on this choice** (see §11).
- **Thrown-turn catch arm (open disposition b) — RESOLVED: leave excluded, via an explicit write in `handleTurnFailure` (`:597-632`).** A thrown turn posts visible text (`Something went wrong: …`, `:616` → `:625`) exactly like an in-branch errored turn; the two are the same user-visible outcome and must not diverge. This is the "accept as intended widening" option **rejected**: widening would be silent and unrequested. Reachable on this epic's own hot path (a grok `TurnAssemblyError` from an unreadable `~/.grok/auth.json` throws here).
- **KPR-402 continuation legs (open disposition c) — RESOLVED: restore a keyable field, as a NEW `meta.meetingExclusionTs` key, not by un-stripping KPR-413's four conference keys.** KPR-413's strip exists because conference meta corrupts telemetry on a turn that was never a conference turn (`:832-845`); a dedicated, telemetry-invisible key survives the blocklist with zero KPR-413 regression. The same key then serves all three write sites uniformly — including the outage-replay leg the epic design already required — so the relocated write reads **one** meta field rather than `conferenceHumanTs` + `conferenceRoundOf(item)`. Alternatives rejected: "accept residual gap" (leaves the double-answer shape reachable on precisely this epic's slow-responder population), "write at the deadline-abort arm" (marks exclusion before any content exists, breaking the delivery-time rule the ticket is named for, and mis-marks the cap-exhausted leg that never answers).
- **Overlapping in-flight / outage-queued turns (open disposition d) — RESOLVED: DEFERRED, with a named residual and a follow-on child.** Two structural mitigations verified in code materially shrink the harm the epic design assumed: (1) the per-thread lock `agentId:threadId` (`agent-manager.ts:1452-1459`, spin-wait) **serializes** a double-invited agent's round-1 reaction behind its own in-flight round-0 turn — so it answers, then reacts, in that order, with round-1's `reactionTo` framing forbidding a re-answer; (2) the inverted-ordering outage case additionally requires the provider breaker to *close* between the round-0 fast-fail and the round-1 dispatch, since otherwise the reaction fast-fails into the same queue. Against that, the in-scope pending set would require restructuring `triggerConferenceReactions`' claim-before-await loop (`:1887-1900`) to accommodate an `await statusOf(...)` — the single most race-sensitive function in the file, and the one holding KPR-387's actual guarantee — and carries its own non-zero residual (a pending-skipped peer whose own turn then suppresses loses its reaction chance anyway). ⚠ Residual accepted and pinned by test (§10, T9).
- **Scope statement (the whole change in one sentence):** exactly one class of round-0 outcome changes state — the **suppressed** turn, which becomes round-1-eligible. Delivered / delivered-with-error / empty-`_No response._`-placeholder / thrown turns all stay excluded; engine-authored notices (KPR-307 outage, KPR-402 deadline/terminal, replay-terminal) never mark exclusion, because they are engine chrome, not agent content.
- **Regression risk 1 — KPR-387 duplicate-answer:** re-derived in §7.1. The actual duplicate-answer fix is the `reactionTo` terminal-slot reframing (`:1352-1356`), untouched here; the tracker's role is only to stop a *delivered* primary being re-selected, which the relocated write preserves. Existing test `dispatcher-conference.test.ts:433` stays green but becomes **microtask-order-sensitive** post-fix and must be made deterministic by construction (§10, T3).
- **Regression risk 2 — KPR-388 delta injection:** re-derived in §7.2 with a **re-based invariant** replacing the one the in-code comment at `dispatcher.ts:1344-1351` asserts (load-bearing sentence at `:1347-1349`) — carrying one ⚠ **accepted residual** (mark advance and session persist are independent fail-soft writes) and falsifying one derived bullet of the original KPR-388 spec (`:145`). That comment must be rewritten, not deleted; replacement text is given in §7.2. Note grok — this epic's poster child — never reaches the affected path at all (stateless-replay providers have no `sessionId`, so they always take the full/summary arm, `:1723`).
- **Rollback:** code revert, no config lever — inherited verbatim from the epic design (§Rollback) and from KPR-402's precedent. The round-1 volume increase this change causes is bounded by the round-0 deliverer count and observable on KPR-389 §C5's existing metrics.
- ⚠ **Delegated assumption (non-blocking):** KPR-386 canon **C1 ("selection-time recording")** is *superseded* by this child; **C2 (tracker shape/TTL)** is preserved unchanged. KPR-415 is a pre-register epic with no `## Decision Register — Canon` section yet, so this supersession is recorded here and should be lifted into the epic's register when it opens.
- ⚠ **Delegated assumption (non-blocking):** the epic design's advisory note that Child A moves KPR-389 §C5's baseline (more round-1 classifier calls per trigger) is accepted as-is and not re-litigated. Whoever revisits C5 inherits a new baseline.

---

## 1. Problem

`resolveConferenceAgents` writes every classifier-selected round-0 agent into `meetingReactionTracker` synchronously, immediately after classification and **before any round-0 turn is dispatched**:

```
dispatcher.ts:1641-1650   // the write
dispatcher.ts:1635-1640   // the comment justifying selection-time placement
```

`triggerConferenceReactions` then skips anyone already in that set when building `peerMembers` (`:1890`). In the live dodi trial (epic design, "Trial observation 1"):

1. Classifier selected `[gpt, fable, gemini, grok]` for a human trigger.
2. All four were written into the tracker before running.
3. `gpt`/`fable`/`gemini` finished in 2-5s and each judged "nothing to add" — suppressed per `NON_RESPONSE_PATTERNS` (`:55-59`), never posted.
4. `grok` finished at ~130s with real content, so `triggerConferenceReactions` fired (`:1484-1485`).
5. `peerMembers` was empty — all three peers were already in `reacted` from step 2. **Nobody reacted.**

The three agents' "nothing to add" judgment was formed *before grok's findings existed*. This is not a new discovery: `docs/epics/kpr-386/kpr-387-spec.md:164` named it as "suppressed-primary permanence" and deliberately deferred it; a documented 25x+ latency spread across a **mixed** provider cohort (not one lane) is the scenario that deferral anticipated.

## 2. Goals

- A round-0 agent whose turn was **suppressed** becomes eligible to react when a slower peer later delivers real content on the same trigger.
- Every other round-0 outcome retains today's exclusion behavior, through **all** paths by which an agent's own text reaches the meeting thread — including the outage-replay leg and the KPR-402 deadline-continuation chain.
- The relocation is expressible as one rule and implemented as one helper called from three sites, so the invariant is auditable rather than emergent.

## 3. Non-goals

- Not reintroducing a second eligibility set. The epic design verified there is exactly **one** eligibility-deciding read (`:1890`); round-0 primary re-selection is already enforced structurally by "one classifier call per human trigger", not by this tracker.
- Not touching the round-1 claim-before-await at `:1893`, the release-on-non-selection at `:1911`, or the TTL sweep at `:1524`.
- Not fixing the pre-existing scope bound that `triggerConferenceReactions` is only ever called from the fan-out leg (`:1485`), so an outage-replayed round-0 delivery never fires a reaction pass. Named so the child is not scoped to it by surprise.
- Not addressing KPR-389's "lone-peer force-select" over-triggering (§C5-adjacent, its own open tuning trigger).
- Not adding a config lever (see Rollback).

## 4. The rule

> **An agent is excluded from reacting on a trigger iff its own round-0 turn on that trigger handed text to delivery.**

"Handed to delivery" — not "was posted" — because that is literally where the write lands (immediately before the `deliver`/`deliverAgentResult` call). Two consequences worth stating:

- Engine-authored notices never mark exclusion. A KPR-307 outage notice, a KPR-402 first-abort or terminal notice, and a `resolveReplayRealFailure` terminal notice are all engine chrome; the agent contributed nothing.
- ⚠ Micro-residual: `deliverAgentResult` begins with `tryOutageDiversion` (`:571`), which can divert a delivered result away from the meeting thread. The write still fires. Accepted — the agent's turn ran and consumed the trigger, and diversion is an outage-era path already outside normal meeting semantics.

Applying the rule to every round-0 outcome in `dispatchToAgent`:

| Round-0 outcome | Site | Today | After KPR-416 |
|---|---|---|---|
| Post-turn outage queue (breaker open) | `:1404` early return | excluded | **not excluded** (queued; the replay's own delivery marks it — §5.3 write site 2, test T4) |
| Replay real failure | `:1407-1409` early return | excluded | **not excluded** (never posted agent text) |
| Deadline abort, with progress | `:1441` → continuation chain | excluded | excluded, via the continuation leg's delivery (§6.3) |
| Deadline abort, cap exhausted | terminal notice, no leg | excluded | **not excluded** (never answered — correct) |
| Deadline abort, **zero progress** | `maybeHandleDeadlineAbort`'s `!withProgress` arm (`:718-761`), returns `true`; notice-only (notify) or warn-only (silent), **no continuation leg** | excluded | **not excluded** (never answered — correct, same shape as the cap-exhausted row) |
| Suppressed (`isNonResponse`) | `:1470-1471` | excluded | **not excluded — THE FIX** |
| Delivered (content, or `_No response._` placeholder, or error-with-text) | `:1472-1481` | excluded | excluded (write site 1) |
| Thrown | `:1511-1512` → `handleTurnFailure` | excluded | excluded (write site 3) |

## 5. Design

### 5.1 Remove the selection-time write

Delete the write at `dispatcher.ts:1641-1650`. **Rewrite** — do not delete — the comment at `:1635-1640`. Its third sentence ("Runs synchronously before any round-0 dispatch starts, so there is no race with a fast round-0 completion triggering the reaction pass") documents precisely the race this move re-opens; the replacement must point at §6.4's ordering pin and at the deferred residual in §6.4(d), so the next reader sees the race rather than rediscovering it.

`humanTs` (`:1641`) is still needed downstream (it is passed into `buildConferenceContext` at `:1666` and stamped onto `ResolvedAgent.conferenceHumanTs` at `:1671`); only the tracker mutation goes.

### 5.2 One new meta key: `meetingExclusionTs`

Stamped in `dispatchToAgent`'s conference meta block (`:1373-1382`), **round-0 only**, and only when `conferenceHumanTs` is present (inheriting today's `:1642` guard — `conferenceHumanTs` is optional on `ResolvedAgent`, `:75`):

```ts
// KPR-416: the exclusion key rides the item so every delivery path can mark
// reaction-exclusion uniformly — including the KPR-402 continuation chain,
// which deliberately strips the four conference keys (:846-853). Named OUTSIDE
// the `conference*` family on purpose: it must survive that blocklist, and it
// is invisible to telemetry, so KPR-413's rationale (never stamp a
// non-conference turn as a conference turn) is untouched.
...(resolved.conferenceRound === 0 && resolved.conferenceHumanTs
  ? { meetingExclusionTs: resolved.conferenceHumanTs }
  : {}),
```

Because the key rides `item.meta`, it flows for free into: the outage-queued document (`effectiveItem` reaches both `maybeHandlePostTurnOutage` and `handleTurnFailure`), every KPR-402 leg (`...carriedMeta`, `:881`), and `handleTurnFailure`'s `item` on both legs.

### 5.3 One helper, three call sites

```ts
/** KPR-416: mark reaction-exclusion at delivery time. Synchronous, idempotent. */
private markReactionExclusion(item: WorkItem, agentId: string): void
```

Reads `item.meta?.meetingExclusionTs` (string or nothing → no-op), derives `threadId = item.threadId ?? item.id`, and adds `agentId` to `meetingReactionTracker[threadId][ts]`, creating the maps exactly as `:1643-1649` does today. Shape and TTL of the tracker are unchanged (C2 preserved).

Call sites — all three immediately **before** the corresponding delivery call:

1. **Fan-out delivery** (`dispatchToAgent`) — before `await this.deliverAgentResult(...)` at `:1481`, i.e. inside the `else` of `:1470`. Must be before **both** `:1481` and `:1485` (§6.4).
2. **Single-dispatch delivery** (`dispatch`'s inner leg) — before `await this.deliverAgentResult(...)` at `:411`, inside the same `else` branch. Covers outage replays **and** KPR-402 continuation legs, both of which re-enter here.
3. **Failure delivery** (`handleTurnFailure`) — inside the `if (adapter)` block at `:623`, before `adapter.deliver(errorResult)`. Not reached when `handleOutageTurn` already handled the fast-fail (`:606-607` early return), which is the correct exemption.

### 5.4 What stays untouched

`triggerConferenceReactions`' peer filter (`:1890`), its claim-before-await (`:1893`), its release-on-non-selection (`:1911`), and the TTL sweep (`:1524`). The epic design's rule holds verbatim: **round-0 delivery marks on delivery; round-1 invitation always claims on dispatch, same as today.**

## 6. Open dispositions — resolved

### 6.1 (a) Write predicate → **branch position (`!isNonResponse`)**

The two candidates diverge on in-branch errored round-0 turns and on empty-text turns delivering the `_No response._` placeholder (which does **not** match `NON_RESPONSE_PATTERNS`, `:55-59` — verified).

**Chosen: branch position.** Rationale, in priority order:

1. **Scope discipline.** The trial gap is the *suppressed* primary. Making errored primaries re-eligible is a second, unrequested behavior change riding along under cover of the first.
2. **The `:1636-1638` intent survives where it should.** That comment's *suppression* half is what this epic deliberately reverses; its *error* half was never implicated and stays.
3. **Operational kindness.** A re-invited broken agent spawns again and posts a second `Something went wrong:` into the meeting — noise, not contribution.
4. **Cost bound.** The §C5 tension note already establishes this change raises round-1 volume; the narrower predicate would raise it further, for the population least likely to contribute.

The "genuinely non-empty non-errored content" alternative is rejected on all four counts. It also would have made the predicate diverge from `:1484`'s reaction-trigger condition, giving the file two subtly different notions of "responded".

⚠ **Named departure from the governing epic design.** The epic design (`2026-08-28-meeting-mode-hardening-design.md`, §"Design — Child A") leans the other way: it says to key the write on "genuinely non-empty, non-errored text," and its parenthetical characterizes **branch position** as the option that "re-includes errored turns." **That parenthetical is inverted against the actual code**, verified in this tree: an errored-but-with-text round-0 turn does not match `NON_RESPONSE_PATTERNS`, so it lands in the `else` at `:1472` and **delivers**. Under branch position the write therefore *fires* for it — keeping it excluded, which is exactly what `:1636-1638` intends. Under the "real content only" predicate the write would be *skipped* for it, leaving it **re-eligible** as a round-1 reactor — i.e. the epic design's recommended predicate is the one that re-includes errored turns, and its parenthetical has the two options' consequences swapped. This spec therefore adopts branch position **in explicit departure from the epic design's leaning recommendation**, on the grounds that the recommendation rests on a mischaracterized consequence. Everything else in §"Design — Child A" is adopted as written. A planner reading both documents should treat this section as authoritative on the predicate.

### 6.2 (b) Thrown-turn catch arm → **leave excluded, write in `handleTurnFailure`**

A thrown round-0 turn reaches neither branch: `:1511-1512` → `handleTurnFailure` → `Something went wrong: …` (`:616`) delivered via `adapter.deliver` (`:625`). Post-relocation, with no write here, it would become round-1-eligible **for having posted an error message** — a widening nobody asked for.

**Chosen: write it.** A thrown turn and an in-branch errored turn produce the same user-visible artifact; letting them diverge would be an accident, not a design. The write goes inside `if (adapter)` so the rule ("handed text to delivery") stays literally true, and the `handleOutageTurn`-handled fast-fail path is correctly exempt because it delivers a notice, not agent text.

Reachability check (not hypothetical): a grok `TurnAssemblyError` from a missing/unreadable `~/.grok/auth.json` **throws** rather than raising `ProviderCircuitOpenError` (breaker-invisible by KPR-410 design), landing exactly here — on this epic's own slow-provider hot path.

### 6.3 (c) KPR-402 deadline-continuation legs → **restore a keyable field (`meetingExclusionTs`)**

The gap: a round-0 conference turn that burns its wall-clock deadline with progress re-dispatches through `maybeHandleDeadlineAbort` (`:701`), whose leg construction strips `conferenceMode`/`conferenceRound`/`conferenceHumanTs`/`conferenceInjectionMode` (`:846-853`) before the leg re-enters via `targetAgentId` → `resolveAgents` step 0 → the single-dispatch leg → delivery at `:411`. With nothing to key on, the continued turn's real answer would land without ever marking the agent excluded — leaving it eligible as a round-1 reactor **for its own trigger**, the KPR-387 cross-boundary double-answer shape, arriving on exactly the slow-responder population this epic exists to serve (`kpr-413-spec.md` Key Point 2 names fan-out round-0 as the reachable case).

**Chosen: a new, non-`conference*`-named meta key that survives the blocklist (§5.2).**

- **vs. "accept residual gap":** rejected. The gap sits on the epic's own hot path, not a corner, and it re-opens a bug a prior child already fixed.
- **vs. "restore `conferenceHumanTs` on the leg":** rejected. It would partially undo KPR-413, whose whole point is that a continuation leg is not a conference turn and must not be stamped as one on `agent_turn_telemetry` / `activity_log`. The KPR-413 T2 test (`dispatcher-conference.test.ts:738`, "continuation leg carries no conference meta") must stay green — and does, since `meetingExclusionTs` is not a conference key and is read by nothing telemetric.
- **vs. "write at the deadline-abort arm itself":** rejected. It marks exclusion when no content exists yet, breaking the delivery-time rule the ticket is named for; and it would wrongly mark the cap-exhausted case, where the agent posts a terminal notice and never answers at all.

Chain behavior with the chosen fix: the key survives every leg (`...carriedMeta`); the first leg that delivers text writes the exclusion; a chain that exhausts its cap writes nothing (correct — nothing was answered); a leg that itself throws writes via `handleTurnFailure` (correct — it posted an error).

The epic design's noted sub-residual — a KPR-402 leg re-queues under `x#dl<n>`, so a `statusOf` lookup keyed on the origin id can't see it — is **not inherited by this child**, because nothing here queries `statusOf`. It is **not dissolved**, only **deferred alongside disposition (d)** (§6.4): it resurfaces intact if the follow-on child takes the outage-queue/`statusOf` route the epic design costed out. §6.4's recommended `isThreadActive` shape sidesteps it (it reads the in-memory `processing` set, not queue state) but also covers neither the outage half nor the leg-id problem — so a follow-on that needs the outage half inherits this sub-residual as live design work, not as settled ground.

### 6.4 (d) Overlapping in-flight / outage-queued round-0 turns → **DEFERRED**

The window: peer A delivers real content and fires a reaction pass while peer B's own round-0 turn has not landed (still running, or sitting in `outage_queue` up to its 4h TTL). Post-relocation B has no tracker entry, so B is invited as a round-1 reactor to A while also owing a round-0 answer. Neither an in-flight nor a queued turn is a reaction-trigger call, so `:1893`'s claim-before-await does not cover it. There is no in-flight round-0 registry today (the fan-out is a bare `Promise.all`, `:291`, recording nothing); the selection-time write being removed was incidentally serving as one.

**Chosen: deferred.** Grounds, with the two structural mitigations verified in this tree (neither is asserted by the epic design):

1. **The per-thread lock serializes the in-flight half.** `withSpawnTicket` keys on `` `${ctx.agentId}:${ctx.threadId}` `` and spin-waits while held (`agent-manager.ts:1452-1459`). B's round-1 reaction turn therefore cannot run concurrently with B's own round-0 turn; it queues behind it. (Verified sufficient for the key match: round-1 re-dispatches with the **same** `originalItem` — `dispatcher.ts:2002` — so the reaction turn's lock key `agentId:threadId` is byte-identical to its own round-0 turn's.) Outcome: B answers round-0, then reacts to A — in that order, with round-1's `reactionTo` framing explicitly forbidding a re-answer (`:1352-1356`) and B's own answer already in its session. That is an extra turn and extra cost, not a duplicate answer.

⚠ **Unstated cost of relying on this mitigation, named here:** the serialization is a spin-wait, so B's round-1 reaction does not merely queue — it **holds that same thread lock for up to another full turn deadline** once it acquires. On a slow provider, B's round-0 turn can burn its whole deadline and B's round-1 reaction can then burn another, back to back, with the thread lock held throughout and any further work on `agentId:threadId` blocked behind both. That is precisely the slow-provider population this epic exists to serve — so the mitigation that makes the residual tolerable is also, on the worst-case cohort, a latency doubler. The follow-on child (below) should weigh this: skipping a double-invited peer is cheaper than serializing it, not just safer.
2. **The outage half additionally requires a breaker close.** B's round-0 turn only lands in `outage_queue` because B's provider breaker is open; a round-1 reaction dispatched to B in that window fast-fails into the same queue rather than delivering ahead of it. The genuinely inverted ordering (reaction delivers, stale round-0 replays hours later) needs the breaker to close in between — real, but narrow.
3. **The in-scope option's cost is concentrated in the riskiest place.** Its `statusOf` check would have to run inside `triggerConferenceReactions`' claim loop (`:1887-1900`), which is documented as claiming synchronously **before** the `await classifyMeetingMessage` at `:1905` precisely to stop concurrent passes double-inviting. Adding an await there forfeits that property; keeping it requires a status pre-pass and a restructure of the one function holding KPR-387's actual guarantee. A pending-set leak at any of the ≥5 early-return sites (`:1404`, `:1441`, suppression, delivery, error, throw) means **permanent** exclusion — the original bug back, worse.
4. **The in-scope option has its own residual anyway** (epic design, §Edge case): a pending-skipped peer whose own turn then suppresses still permanently loses its chance to react to A.

⚠ **Residual accepted:** within the overlap window, a peer with an unlanded round-0 turn can be invited as a round-1 reactor for the same trigger. Pinned by T9 (§10) so it reads as known behavior, not a bug.

**Follow-on child (to file against KPR-415, not this ticket).** Recommended cheapest shape, researched here so the follow-on does not restart cold: a public `isThreadActive(agentId, threadId)` accessor on `AgentManager` reading the existing `processing` set (`agent-manager.ts:1714-1715` shows the identical private check already in use for reflection quiescence), consulted by `triggerConferenceReactions`. It is synchronous (no claim-loop restructure), and **leak-proof by construction** — the lock is released in `withSpawnTicket`'s `finally`, so it can never strand a permanent exclusion. It covers only the in-flight half and only from lock acquisition onward (not the resolve→dispatch window), and not the outage-queued half at all; the follow-on must decide whether that partial coverage is worth the cross-module surface, or whether the full pending set is warranted by then-current trial data.

## 7. Regression risks — re-derived

### 7.1 KPR-387's duplicate-answer fix stays intact

**What KPR-387 actually fixed** (`docs/epics/kpr-386/kpr-387-spec.md:27`): an agent answers as a round-0 primary, a peer's reply triggers the reaction pass, the same agent is re-selected as a round-1 reactor and receives *the same human message* in its `[New message]` slot, producing a near-duplicate answer seconds later (observed: gemini "understood, let's discuss" → "got it. let's discuss").

**Fix shape** (`:15`, two independent halves):
- (a) tracker recording, so a round-0 primary is skipped by `triggerConferenceReactions`' `reacted.has` filter;
- (b) `ResolvedAgent.reactionTo` + the reframed terminal slot (`:1352-1356`), so a round-1 turn is framed against the **peer reply** and the human message is never re-presented, with an explicit "Do not re-answer the original question."

**Derivation for this child.** Half (b) is untouched — no line of it is edited, and it is the half that actually prevents a duplicate *answer* (KPR-387's own spec, `:122`, states the contract as "human message **absent** from the terminal slot"). Half (a) is relocated, not removed: for the population it was protecting — a primary that **delivered** — the write still lands, just later, and before both the delivery and the reaction trigger (§6.4 ordering pin). The only agents that lose half-(a) protection are those that never delivered, for whom half (b) alone is the operative guard and for whom "re-answering" is not even a coherent failure mode (they produced no first answer to duplicate).

**Residual honestly stated:** the double-invite window of §6.4(d) is the one place where half (a) no longer covers a delivering agent, and there the per-thread lock + half (b) hold the line.

**Test:** T3 (§10) — a **non-suppressed** round-0 responder must still be excluded from reacting to a later peer on the same trigger.

### 7.2 KPR-388's delta-injection invariant — updated, not merely re-tested

**The current in-code assertion**, `dispatcher.ts:1344-1351`, load-bearing sentence at `:1347-1349` (verified present at these lines in this tree):

> "…a round-1 reactor was never a round-0 responder for this trigger (C1/C2), so its mark predates the triggering message — the message is in its delta, or already in its session by the covering invariant."

Child A makes the antecedent false by design.

**What actually happens to a suppressed round-0 responder that is later re-invited as a round-1 reactor** (traced in this tree):

1. Its round-0 turn was suppressed. The mark bookkeeping at `:1454` runs **before** and **outside** the `isNonResponse` branch (`:1468-1471`), gated only on `conferenceMode && !error && !aborted` — a suppressed turn passes. So the mark advances.
2. Sub-branch `:1456-1461` (delta into a fresh session): `clearMeetingMark` → the later round-1 read takes the summary/full arm (`:1723`) → the trigger **is** injected. Safe.
3. Sub-branch `:1462-1463`: `setMeetingMark(injectionHighWaterTs)`. For round-0 that value is `maxSlackTs([...injected ts, roundZeroTriggerTs])` (`:1778`/`:1792`) — so the mark lands at ≥ the trigger's own ts.
4. The later round-1 read passes no `roundZeroTriggerTs` (`:1984-1990`). If the agent has a resumable `sessionId`, a matching provider and that mark, it takes the delta arm; `history.filter(ts > markNum)` is **strictly** greater (`:1788`), so **the human trigger is excluded from the injected delta.** The peer reply (later ts) is included.

So the code's stated reason for safety no longer applies, and the epic design's warning is confirmed.

**Updated invariant (this is the sentence the comment must now assert):**

> A round-1 reactor's delta may omit the human trigger. That is safe because the delta arm is reachable only when the reactor holds a resumable session row whose `meetingLastSeenTs` was advanced by one of **its own** earlier turns on this thread; and the mark advances (`:1454`) only after a non-errored, non-aborted turn, and only to the maximum ts over what that turn actually absorbed — its injected context **∪** its terminal slot. A mark at or above the trigger's ts therefore implies some turn of this agent **presented** the trigger (round-0 terminal slot) or **injected** it (a later trigger's context). Either the mark predates the trigger (trigger in the delta) or the agent's own turn presented it (trigger in the transcript that turn produced) — no gap, **subject to the session-write residual below.**

⚠ **Accepted residual — the mark advance and the session persist are independent, independently fail-soft writes.** The invariant's "…and the session now being resumed therefore contains it" step is **asserted, not derived**, and the two writes can diverge:

- The mark advance is `dispatcher.ts:1462-1463` (`setMeetingMark`, mark-only, no upsert).
- The session persist is `agent-manager.ts:2369` (normal path) and `:2392` (KPR-399 abort-persist path) — **both unawaited fire-and-forget**, a property KPR-402's own comment at `dispatcher.ts:815-817` already calls out ("finalize's fire-and-forget session write").

Concrete failure mode: a **suppressed** round-0 turn on a thread that already has a session row can have its session write silently lost while the mark still advances. `ref.sessionId` stays truthy (inherited from the pre-existing row), so the resume-eligibility check passes and the round-1 read takes the **delta** arm — but the resumed session never actually absorbed the trigger. The strictly-greater filter (`:1788`) then omits the trigger from the delta, and the reactor reacts to a peer's reply having never seen the human question.

This was **unreachable pre-Child-A** — the reactor was never a round-0 responder for the trigger, so no turn of its own had presented it. Child A newly exposes it, for exactly the suppressed-responder class this ticket makes eligible. Note also that `docs/epics/kpr-386/kpr-388-spec.md:17` classifies the fire-and-forget race as "duplication, never gaps"; **that classification no longer holds for this specific case** — here the divergence produces a gap, not a duplication.

**Accepted, not fixed.** Making the session write awaited (or making mark-advance and session-persist a single atomic write) is a cross-module restructure of the KPR-399/KPR-402 persist path and is **out of scope for this child**. The residual is cross-referenced from §9 (Open assumptions) so a plan-writer or follow-on does not have to rediscover it. Probability is low (it needs a dropped Mongo write on precisely a suppressed round-0 turn), impact is bounded (one reactor reacts with peer context but no trigger context — degraded, not corrupting), and the KPR-388 heal path still applies on the agent's next turn.

Modulo that residual, this is the KPR-388 "covering invariant" (`kpr-388-spec.md:17`, `:141-146`) restated with the **terminal-slot half of the union promoted from incidental to load-bearing** for the trigger message specifically. Pre-Child-A the round-1 delta path never leaned on it; post-Child-A it does. The invariant *statement* is unchanged — only which half of it carries the round-1 case, plus the newly named residual above.

⚠ **One derived bullet of the original KPR-388 spec is falsified, not merely re-derived.** `docs/epics/kpr-386/kpr-388-spec.md:145`'s "Round-1 reachability (C3)" consequence bullet is derived from the same premise Child A overturns (a round-1 reactor was never a round-0 responder for this trigger). That bullet does not survive this child; the invariant it was derived from does. Recorded here and in §13 so the paper trail is complete — §13's "preserves KPR-388's covering invariant" claim is true of the invariant *statement*, and deliberately not of this bullet.

**Two supporting facts, both verified:**
- `setMeetingMark` is a mark-only write with no upsert (per CLAUDE.md; the session row is written by turn persistence), so "mark without session row **at all**" is not a reachable state — the delta arm's `ref.sessionId` precondition cannot be satisfied by a mark alone. (This does **not** dispose of the residual above, which is the narrower case of a mark advancing over a **pre-existing but not-updated** row: the row exists, `ref.sessionId` is truthy, and only its *contents* are behind. Absence is excluded; staleness is not.)
- Stateless-replay providers (codex, grok) store no `sessionId`, so `:1723`'s rule-1 miss routes them to the full/summary arm unconditionally — pinned today by `dispatcher-conference.test.ts:1343`. **grok, this epic's poster child, never reaches the affected path.**

**Comment rewrite required.** Replace `dispatcher.ts:1344-1351`'s third-and-fourth sentence (the C1/C2 claim) with the **blockquoted invariant above** (the invariant only — the residual discussion stays in this spec, not in the source comment), citing KPR-416 and noting that C1 (selection-time recording) is superseded. Add one trailing clause pointing at this section for the accepted session-write residual, so the next reader of that comment knows the invariant carries a named caveat rather than being airtight. Do not delete the surrounding KPR-387/KPR-388 framing — only the falsified premise.

## 8. Integration points

| Surface | Interaction |
|---|---|
| `dispatcher.ts` `resolveConferenceAgents` | selection-time write deleted; comment rewritten |
| `dispatcher.ts` `dispatchToAgent` | `meetingExclusionTs` stamped (round-0); write site 1 before `:1481` |
| `dispatcher.ts` single-dispatch leg | write site 2 before `:411` — covers outage replay **and** KPR-402 legs |
| `dispatcher.ts` `handleTurnFailure` | write site 3 before `:625` |
| `dispatcher.ts` `triggerConferenceReactions` | **unchanged** (`:1890` read, `:1893` claim, `:1911` release) |
| KPR-402 `maybeHandleDeadlineAbort` / leg construction (`:846-888`) | unchanged code; the new key rides `carriedMeta` by not being in the blocklist. KPR-413's four-key strip stays exactly as-is |
| KPR-307 outage queue | unchanged; the new meta key rides the queued workItem for free |
| KPR-388 mark bookkeeping (`:1454-1465`) | unchanged code, updated reasoning + comment (§7.2) |
| KPR-409 meeting scribe | untouched — the scribe reads no tracker state |
| KPR-390 worker pool | untouched — `worker:` re-entry items are non-conference turns |
| KPR-389 §C5 metrics | baseline shifts (more round-1 classifier calls per trigger); advisory only |

**Files touched:** `src/channels/dispatcher.ts` and `src/channels/dispatcher-conference.test.ts` only. No config, no schema, no cross-module surface (the `isThreadActive` accessor idea belongs to the deferred follow-on, §6.4).

## 9. Edge cases and assumptions

- **`conferenceHumanTs` absent** (non-Slack conference surface): no `meetingExclusionTs` stamped, no write anywhere — same guard today's `:1642` applies. Reaction eligibility is unaffected because `triggerConferenceReactions` is itself keyed on `humanTs`.
- **Idempotence:** all three write sites add to a `Set`; a turn that somehow reaches two of them (it cannot — they are mutually exclusive branches) is harmless.
- **TTL sweep interplay:** `:1524` deletes the whole thread entry. A delivery landing after a sweep re-creates the map for that `(threadId, humanTs)`, exactly as `triggerConferenceReactions` already does at `:1877-1882`. No change in kind.
- **Round-1 turns never write.** The helper is a no-op for them because `meetingExclusionTs` is stamped round-0-only; their claim remains `:1893`'s.
- **Diversion micro-residual:** §4.
- ⚠ **Assumption:** engine-authored notices are not agent content and must not mark exclusion. Stated as the rule in §4; if a future reviewer disagrees, the affected rows are the outage-queue, replay-failure, cap-exhausted and zero-progress-deadline rows of §4's table.
- ✅ **`meetingExclusionTs` is a safe new key name — VERIFIED (spec-review r1), no implementation-time re-check needed.** A sweep of the tree found the only `meta` enumerations to be: (i) the KPR-413 blocklist at `dispatcher.ts:846-853`, which names its keys explicitly and is a blocklist (a new key passes by default); and (ii) typed **single-key** reads — `conferenceRoundOf` / `conferenceInjectionModeOf`, `agent-manager.ts:217-224`. There is **no allowlist anywhere**, and neither `agent_turn_telemetry` nor `activity_log` spreads `item.meta`, so the new key cannot leak into a telemetry document. The plan-writer can take this as settled.
- ⚠ **Accepted residual (see §7.2, "the mark advance and the session persist are independent writes"):** the KPR-388 delta invariant's session-absorption step is asserted, not derived — the mark advance (`dispatcher.ts:1462-1463`) and the fire-and-forget session persist (`agent-manager.ts:2369` / `:2392`) can diverge, so a suppressed round-0 responder can in principle take the round-1 delta arm against a session that never absorbed the trigger. Unreachable pre-Child-A, newly exposed by this child, **accepted** — awaiting/atomizing the session write is out of scope. Full derivation and impact bound in §7.2.

## 10. Testing contract

Home: `src/channels/dispatcher-conference.test.ts` (all existing conference coverage lives there).

**Negative-verify obligation** (per `feedback_negative_verify_regression_tests` and `kpr-387-spec.md:159`): applies to T1 and T2 only — revert the source hunks and confirm both fail on pre-fix code. Both must guard against the vacuous pass hazard (`kpr-387-spec.md:155`) by asserting over a non-empty set of turns.

**Negative-verify (must fail on pre-fix code):**

- **T1 — the primary fix.** Trial observation 1, reproduced: round-0 selects `[slow, fastA, fastB]`; `fastA`/`fastB` return `"No response needed."`; `slow` later returns real content. Assert the reaction pass's `peerMembers` contains `fastA` and `fastB`, and that both actually run a round-1 turn. Fails pre-fix (selection-time write ⇒ empty `peerMembers`).
- **T2 — KPR-388 delta injection, as new behavior.** Precondition pinned explicitly: the re-invited agent's round-0 turn was **suppressed**, its injection mode was `delta`, and `resumedSession` was `true` (so the `:1461` `clearMeetingMark` branch does **not** apply). Assert (i) the agent's mark advanced to ≥ the trigger's ts on its suppressed round-0 turn, and (ii) its round-1 injected context does **not** contain the original trigger text. The asserted invariant is the mark-advance-implies-session-absorption argument of §7.2 — **not** "the delta covers the trigger." Fails pre-fix for the right reason (round-1 never dispatches to it), so the test must assert a round-1 turn actually happened before asserting over its text.

**Coverage (passes on both old and new code):**

- **T3 — KPR-387 duplicate-answer regression.** A **non-suppressed** round-0 responder stays excluded from reacting to a later peer on the same trigger. This is the existing test at `dispatcher-conference.test.ts:433`, which post-fix becomes **microtask-order-sensitive**: it now depends on peer B's delivery-time write landing before peer A's reaction pass reads the tracker. It must be made deterministic *by construction* — stagger the two round-0 turns' resolution so the second responder's write is ordered before the first's reaction pass — rather than relying on await-depth coincidence. A flaky T3 is not acceptable as the KPR-387 guard.
- **T4 — single-dispatch replay leg.** An outage-queued round-0 turn that later replays and delivers real content excludes that agent from reaction eligibility. New call site, no existing coverage.
- **T4b — write-site-2 hot-path no-op.** Write site 2 sits on the delivery branch of the **ordinary single-dispatch path**, i.e. on the hot path of every non-conference turn in the engine. Assert the helper no-ops cleanly for a plain single-dispatch turn with no `meetingExclusionTs` in `meta` (and for one with a malformed non-string value): no tracker mutation, no thrown error, delivery unaffected. Cheap, and it is the only test guarding the blast radius of putting a new call on that path.
- **T5 — ordering pin (structural, not a race test).** Post-fix the window between the exclusion write and the two call sites is **zero by construction** — the write is a synchronous statement immediately preceding both `await this.deliverAgentResult(...)` (`:1481`) and the `triggerConferenceReactions` fire-and-forget (`:1485`) — so there is nothing to actually race, and a concurrency-shaped test here would be theater. Write it as a **source-order assertion** instead: read `dispatcher.ts` and assert the `markReactionExclusion` call statement appears **before** both call sites within the same `else` block. Purpose is drift-catching — a later refactor that moves the write below either site fails the test. If a source-scan assertion is judged too brittle for this suite, the accepted substitute is a structural comment at the call site naming the ordering requirement plus §6.4, and T5 is dropped; do **not** substitute a timing/microtask-based test.
- **T6 — disposition (a).** Two cases, both still excluded: (i) a round-0 turn returning empty text (delivers the `_No response._` placeholder), (ii) a round-0 turn returning error-with-text. Pins that the predicate is branch position, not "real content."
- **T7 — disposition (b).** A round-0 turn whose `runWorkItemTurn` **throws** delivers `Something went wrong: …` and is excluded. Companion assertion: a round-0 turn that fast-fails with `ProviderCircuitOpenError` and is handled by `handleOutageTurn` is **not** excluded (notice, not content).
- **T8 — disposition (c), two parts.**
  - **T8a (meta pin):** a round-0 conference turn that deadline-aborts with progress produces a continuation leg carrying `meetingExclusionTs` and **none** of the four conference keys. The existing KPR-413 test at `:738` ("continuation leg carries no conference meta") must remain green unmodified.
  - **T8b (behavior):** that continuation leg's delivery on the single-dispatch leg excludes the agent from reaction eligibility. Companion 1: a chain that exhausts `MAX_DEADLINE_CONTINUATIONS` (terminal notice, no answer) does **not** exclude. Companion 2 (covers §4's zero-progress row): a round-0 conference turn that deadline-aborts with **zero** progress — `maybeHandleDeadlineAbort`'s `!withProgress` arm, `:718-761`, notice-only, no leg — likewise does **not** exclude. Both companions assert the same shape (no leg ⇒ no delivery ⇒ no write) via different arms, so a regression that starts marking exclusion at the abort site rather than at delivery fails on both.
- **T9 — disposition (d), residual pin.** Documents the deferred gap so it reads as known behavior: peer A delivers and fires a reaction pass while peer B's round-0 turn has not landed ⇒ B **is** invited as a round-1 reactor. Comment the test as the accepted residual with a pointer to §6.4 and its follow-on child; the follow-on inverts this assertion.

**Suite-level:** `npm run check` green (`SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test`). The KPR-387 byte-exact prompt pin (`:510`), the KPR-388 delta pin (`:849`), the KPR-409 summary pins and the KPR-413 T1/T2/T2b/T3 legs must all stay green with zero edits — this change touches no prompt bytes.

## 11. Downstream: KPR-417 (delay-then-ack)

KPR-417 blocks on this ticket, and its failure-path design depends on the predicate chosen here.

**What KPR-417 inherits:** the write predicate is **branch position** (§6.1). Concretely, for KPR-417's "turn succeeds but suppresses" case — the round-0 responder that acked at ~15s and then returns `"No response needed."` — the agent is now **round-1-eligible**, because a suppressed turn writes nothing. So the orphaned "On it" is not necessarily orphaned forever: that agent may still post a round-1 reaction to a slower peer on the same trigger. KPR-417's design for that case should account for the ack potentially being followed by a *reaction* rather than by silence or a retraction, and should not assume a suppressed acker is done with the trigger.

**Sequencing (epic design, Key Point on `dispatchToAgent`):** Child A lands first. Its write sits beside `:1481`/`:1485`; KPR-417's delay timer wraps the same dispatch. Merging A first avoids rebase conflict in one hunk.

## 12. Rollback

Code revert. No config lever — inherited from the epic design's §Rollback and matching KPR-402's posture: the round-1 volume increase is bounded by the round-0 deliverer count (no unbounded growth), it is directly observable on KPR-389 §C5's existing metrics without new instrumentation, and the change is a small set of relocated write sites plus one meta key — a revert is exactly as fast as flipping a lever. If trial data later shows the volume increase is operationally unwelcome, add a lever then.

**Boundedness — independently verified (spec-review r1), not merely asserted.** Two facts in this tree carry it: (i) `:1484` gates the reaction pass to round-0 turns only, so a round-1 reaction can never itself fire another reaction pass (no recursion, depth stays 1); and (ii) selected round-1 reactors are **never released** at `:1911` — the release is on non-selection only — so an agent claimed as a reactor for a given `(threadId, humanTs)` cannot be claimed again for it. Together: reaction passes per trigger ≤ the round-0 deliverer count, and each agent reacts **at most once** per trigger. The worst case this child unlocks is therefore a bounded fan-out, not a cascade.

## 13. Canon

- **Supersedes KPR-386 canon C1** ("selection-time recording"). Recorded here; to be lifted into KPR-415's Decision Register when that section opens (KPR-415 is a pre-register epic with no children merged).
- **Preserves C2** (tracker shape, keying, TTL) unchanged.
- **Preserves KPR-388's covering invariant** — the invariant **statement** verbatim; only which half of it carries the round-1 case changes (§7.2). Two precisions on this claim, both required for an honest paper trail:
  - It does **not** extend to `kpr-388-spec.md:145`'s "Round-1 reachability (C3)" consequence bullet, which is **falsified** by this child: that bullet is derived from the premise that a round-1 reactor was never a round-0 responder for the trigger, which Child A overturns by design. The invariant survives; that derived bullet does not.
  - The invariant's session-absorption step carries a **newly exposed accepted residual** (§7.2, cross-referenced from §9) — the mark advance and the fire-and-forget session persist are independent writes, so `kpr-388-spec.md:17`'s "duplication, never gaps" classification of that race no longer holds for the suppressed-round-0-responder case specifically.
- **Preserves KPR-413** in full — the four-key conference strip is untouched; the new key is deliberately outside that family.

---

## 14. Post-merge addendum — coherence review of `fa48196` (2026-08-28)

*Appended by the KPR-415 coherence seam after this child merged (`fa48196`, PR #436). Verdict: **LEGITIMATE_DIVERGENCE**, no Gate-1 amendment, no corrective. Added rather than edited in place, so the pre-merge artifact stays legible.*

The coherence review upheld §6.1's departure from the epic design (re-deriving independently that `isNonResponse` never reads `runResult.error`, so the design's parenthetical had the two predicates' consequences swapped, and that Gate 1 had delegated the choice) — and found **two scope defects in this spec** that the delivery gates did not catch, because both are questions of *what the change decided*, not of whether it works.

### 14.1 The all-roster-fallback consequence is missing from §4, §12 and §13

**§13's supersession of KPR-386 canon C1 quotes only C1's first clause.** C1 has two:

> *C1: Round-0 conference responders recorded in meetingReactionTracker at SELECTION time — suppressed/errored primaries stay excluded per trigger; **classifier all-roster fallbacks suppress all reactions for that trigger** (KPR-387, 3896a24).*

The second clause is falsified too, and materially. `classifyMeetingMessage` has three all-roster fallback arms (`src/agents/meeting-classifier.ts:126` no-key pre-check, `:160` call-failure catch, `:175` parse-failure). Pre-KPR-416, an all-roster selection pre-recorded the whole roster, so `peerMembers` was empty and **no reaction pass fired at all**. Post-KPR-416 nothing is pre-recorded, so under a classifier outage every roster member is a round-0 primary **and** every not-yet-landed peer is reaction-eligible — turns per trigger roughly **double**.

**This is bounded, not a cascade**, and both legs are verifiable in source: `dispatcher.ts:1629` gates the reaction pass on `conferenceRound === 0`, so a round-1 turn never fires its own pass (depth stays 1); and the release at `:2059` fires on **non**-selection only, so a selected reactor is never released and each agent reacts at most once per trigger. For roster N the ceiling is **≤ 2N−1 turns**, which is inside §12's stated boundedness argument — §12's *conclusion* holds, but its argument never considered this path.

**Consequently the Key Points scope statement (§ Key Points, the "Scope statement" bullet) is over-tight.** "Exactly one class of round-0 outcome changes state — the suppressed turn" is true on the ordinary path. On the all-roster path the **delivering** class also changes observable state: deliverers are no longer pre-excluded, so they are invitable during the §6.4(d) overlap window.

The consequence was caught in pre-PR review round 1, written correctly into `CLAUDE.md`'s meeting-mode bullet and the PR body, but never propagated back here. It is now canon as **KPR-415/C2**.

### 14.2 The KPR-388 canon entry is keyed to the wrong artifact

§13's third bullet cites `kpr-388-spec.md:145` and `:17` — repo line references. Both falsified phrases are *also* **KPR-386 canon C9** text (*"all races err to duplication, never gaps; C3 reachability generalized to 'session ∪ injected delta'"*). The entry is re-keyed in the register to **amend C9** — whose invariant statement survives, whose "C3 reachability generalized" clause acquires §7.2's new derivation, and whose "never gaps" clause no longer holds for the suppressed-round-0-responder case. It is now canon as **KPR-415/C7**.

**Root cause worth recording for sibling children:** this spec cites C1/C2 by identifier but did not re-read the KPR-386 register in full — otherwise C1's second clause and C9's ownership of both falsified phrases would have been named at spec time. **A child that supersedes a canon entry should quote that entry in full before superseding it.**

### 14.3 What the review did *not* find

No Gate-1 amendment, no corrective ticket, and **no affected children** — KPR-417's dependency is on the *relocation*, not the predicate, and its acks are round-0-gated, so §14.1's round-1 volume increase does not propagate to ack volume. §6.4(d)'s deferral was ruled fully satisfied against the epic design (which offered deferral as a sanctioned option and asked only that the child pick one and record which); its follow-on child is an ordinary follow-up that need not precede KPR-417.

The review also named one cost §6.4(d) did not: `agent-manager`'s per-thread lock is a **spin-wait**, so the serialized round-0-then-round-1 pair can burn two full turn deadlines back to back with the thread lock held.

Full reasoning: the `# Decision Register Entry` comment keyed to `fa48196` on KPR-415, and the `## Decision Register — Canon` section of that epic's description.
