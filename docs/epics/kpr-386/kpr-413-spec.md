# KPR-413 — Deadline-continuation legs must not re-wrap the assembled conference payload

**Epic:** KPR-386 (meeting mode) · **Kind:** corrective child, filed by the epic's integrated-head review r1 (finding 2, severity: important)
**Origin:** cross-epic collision — `main`'s KPR-397 hotfix epic (KPR-402, deadline-abort continuation chain) landed *after* this epic's KPR-388/KPR-389 shipped conference prompt assembly. The two code paths first met in the epic's `origin/main` sync (`705f9f9`); neither side's review gate could have seen the other.
**Status:** spec-ready (spec review round 1 — approved after fixes, caught-by: spec-review/1/opus)

## TL;DR

A round-0 conference turn that burns its wall-clock deadline hands `maybeHandleDeadlineAbort` the **assembled composite** prompt — meeting preamble + injected transcript + terminal slot — which KPR-402 freezes into `meta.deadlineOriginalText` and re-wraps verbatim into every continuation leg, up to `MAX_DEADLINE_CONTINUATIONS` (2) more times, into a session that KPR-399 resume already loaded with copy #1. That is the N-copies pathology named in this epic's own Gate 1 diagnosis, reproduced by the very mechanism meant to be a graceful degradation. The fix is a one-expression meta stamp at the conference-assembly site plus four blocklist entries in the continuation builder: **the continuation carries the turn's own frame (preamble + terminal slot), never the meeting's transcript, and carries no conference meta at all.**

## ⚠ Key Points

1. **Verified against live code at `4c17345`, not transcribed from the finding.** Assembly: `dispatcher.ts:1330-1334` (`newMessageSegment`), `:1335` (`contextPrefix`), `:1336-1348` (`effectiveItem`). Arm call site: `:1406` (fan-out), `:382` (single-dispatch). Continuation builder: `:831` (meta blocklist), `:833-834` (`deadlineOriginalText` read), `:857` (wrap), `:858-865` (leg meta).
2. **Both dispatch legs are reachable, for different reasons.** Fan-out reaches it on **round-0 only** — round-1 is intercepted first by the KPR-389 D5 kill gate (`:1388-1399`, returns on `aborted || timedOut`; a deadline abort is both). Single-dispatch reaches it via an **outage replay of a stored conference turn**: the queued doc serializes `effectiveItem` (composite text + conference meta), the replay processor pins `targetAgentId` (`outage-replay-processor.ts:127`), `resolveAgents` step 0 (`:1126-1129`) routes it single-dispatch, and `conferenceRoundOf(item) === 0` fails the `isRound1AbortedReplay` guard at `:370`. One fix must cover both.
3. **Fix D1 — stamp `deadlineOriginalText` at assembly time** with `preamble + "---" + terminal slot` (transcript arm empty). `maybeHandleDeadlineAbort:833-834` *already* prefers `item.meta.deadlineOriginalText` over `item.text`, so the arm needs **zero** text-handling changes, and the stamp rides into the outage store — closing the replay leg with the same edit.
4. **The preamble stays, the transcript goes.** The bloat named in the epic diagnosis is the transcript (105 messages); the preamble (returned string spans `:1818-1827`) is ~746 bytes for a two-name roster and carries the anti-tool-storm and `"No response needed."` instructions that diagnosis item 3 and C15 make load-bearing on *every* conference turn. The resulting string is byte-shaped exactly like an **empty-delta** turn — a shape C10 already sanctions and the suite already pins.
5. **Fix D2 — strip `conferenceMode`/`conferenceRound`/`conferenceHumanTs`/`conferenceInjectionMode` from the leg's meta** (extend the existing `outageReplay` blocklist at `:831`). Today the leg is stamped as a conference turn with an `injectionMode` it never computed, corrupting both C18 measurement surfaces (`agent-manager.ts:2226-2227` telemetry, `:2292` activity_log). Direct precedent: **C26** — engine-authored re-entry (`worker:`) into a meeting thread carries no conference meta and is structurally invisible to marks/shaping.
6. **Three adjacent behaviors are correct as-is and deliberately unchanged:** the `targetAgentId` pin (`:860` — re-resolution would re-run the classifier and could select *different* agents), the mark never advancing (C9 — a continuation injects nothing, so advancing would risk a gap; the leg-1 `!aborted` gate at `:1419` already declined), and round-1 reactions never firing off a continuation's answer (accepted residual, §Edge cases).
7. **Both review-suggested directions were evaluated and rejected** (§Alternatives): per-leg re-derivation of conference context needs a Slack re-fetch + roster + mark inside the abort arm and would *re-inject* into a session that just consumed the same content; opting conference turns out of the chain reverts round-0 meetings to a `"_No response._"` post — the exact thing KPR-402 shipped to remove, on the surface this epic exists to improve.
8. **In scope:** one meta stamp, four blocklist entries, comments, tests. **Out of scope:** any change to `deadline-continuation.ts`, the wrap text, the cap, notice cadence, `buildConferenceContext`, mark mechanics, the D5/D5b gates, or the reaction pass.
9. **⚠ Non-blocking (accepted degradation):** on KPR-402's rare fresh-fallback path (⚠A4 persist race / KPR-399 contender overwrite) a continuation now lands in an empty session with frame + slot and **no meeting transcript**. That is strictly the intended trade — resume is the normal case by construction — and is recorded with a re-open trigger rather than pre-solved.

---

## Problem

### The path

`dispatchToAgent` builds the conference prompt in `effectiveItem` (`dispatcher.ts:1321-1349`):

```ts
const newMessageSegment = resolved.reactionTo ? /* peer-reply framing */ : `[New message]:\n${item.text}`;
const contextPrefix = [resolved.meetingPreamble, resolved.threadContext, "---"].filter(Boolean).join("\n");
effectiveItem = { ...item, text: `${contextPrefix}\n${newMessageSegment}`, meta: { ...item.meta, conferenceMode: true, … } };
```

`resolved.threadContext` is whatever `buildConferenceContext` produced — full (first 5 + last 100 messages), delta, or summary + tail. `effectiveItem.text` is therefore the whole composite: **the payload KPR-388/KPR-409 exist to keep small.**

That same `effectiveItem` is handed to the KPR-402 arm at `:1406`. On a `timedOut && aborted` turn classified `turn-deadline` (progress observed), the continuation builder runs:

```ts
const originalText = typeof item.meta?.deadlineOriginalText === "string" ? item.meta.deadlineOriginalText : item.text;  // :833-834
…
text: deadlineContinuationWrap(originalText, n + 1, MAX_DEADLINE_CONTINUATIONS + 1),                                     // :857
meta: { ...carriedMeta, targetAgentId: agentId, deadlineRetry: n + 1, deadlineOriginalText: originalText },              // :858-865
```

On the **first** abort no `deadlineOriginalText` exists, so `originalText` falls back to `item.text` — the composite. It is then frozen into the leg's meta and re-wrapped **verbatim** on every subsequent leg (the T9 round-trip property at `dispatcher.test.ts:1917-1919`, working exactly as designed — on the wrong string).

### Why it is worse than a plain duplicate

KPR-402 legs are *resume-first* by design (KPR-399 persists the aborted session; the wrap tells the agent its session "may already contain this request and your partial progress"). So the composite is appended to a session that **already holds** the composite. A three-deadline chain on a 105-message meeting puts three verbatim transcript copies in one agent's context window: the Gate 1 diagnosis item 1 failure mode, at its worst, reached precisely when an agent is already struggling to finish a turn.

### Secondary effect — dishonest conference stamping

`carriedMeta` (`:831`) strips only `outageReplay`. The leg therefore inherits `conferenceMode: true`, `conferenceRound: 0`, `conferenceHumanTs`, `conferenceInjectionMode`. Consequences:

- `runWorkItemTurn` → `ctx.conferenceRound = 0` (`agent-manager.ts:1082`). Harmless for shaping (KPR-389's clamp is round-1-only) but not free downstream:
- `recordSpawnObservability` stamps `conferenceRound` **and** `injectionMode` on `agent_turn_telemetry` (`:2226-2227`) and `conferenceRound` on `activity_log` (`:2292`). A continuation leg computed no injection at all, so a `delta`/`summary`/`full` stamp on it inflates exactly the counters C18 designates as the epic's self-evaluation surface — and `activity_log` is C18's authoritative kill-count source.

The leg also routes via `targetAgentId` → `resolveAgents` step 0 (`:1126-1129`), which precedes conference resolution at step 0.7 (`:1153-1156`). So it never re-enters conference fan-out, never triggers the reaction pass, and never touches `meetingLastSeenTs` — while still *claiming*, in telemetry, to be a conference turn.

### Why nothing caught it

KPR-388/KPR-389 merged into this epic branch before KPR-402 existed on `main`; KPR-402's own suite has no conference fixture (`dispatcher.test.ts`'s deadline describe uses plain slack items, `dispatcher-conference.test.ts` wires no outage/deadline path). The ordering that makes round-1 safe — D5 before the arm — was itself established in the sync commit `705f9f9`, not by either parent.

## Goals

- **G1.** A conference turn's continuation leg carries the turn's own frame and terminal slot, never the injected transcript — on the fan-out leg **and** on the single-dispatch replay leg.
- **G2.** A continuation leg is not stamped as a conference turn in telemetry or the activity audit (C18 honesty; C26 shape).
- **G3.** Every KPR-402 property survives byte-intact for non-conference items: leg ids, cap, notice cadence, wrap text, `targetAgentId` pin, meta blocklist-not-allowlist posture, dedup bypass.
- **G4.** Regression tests that fail on pre-fix source for the right reason, in both dispatch legs, plus a pin that round-1 reactions stay unreachable from this arm.

## Non-goals

- **No per-leg re-derivation of conference context.** Rejected on the merits (§Alternatives), not merely deferred.
- **No opt-out of conference turns from the continuation chain.** Rejected (§Alternatives).
- **No change to `deadline-continuation.ts`** — wrap text, cap, notice strings, and `deadlineBaseIdOf` are untouched.
- **No change to `buildConferenceContext`, `formatThreadContext`/`formatDeltaContext`/`formatSummaryContext`, the preamble, mark mechanics, or the D5/D5b gates.** In particular the byte-exact round-0 prompt pin (C6) must stay green: the fix adds a *meta* key, never a prompt byte.
- **No round-1 reaction pass fired from a continuation's answer** (accepted residual, §Edge cases).
- **No new config knob, log line, telemetry field, or `hive doctor` surface.**
- **No migration.** Nothing durable is corrupted: the composite lives only in in-flight leg meta (and in `outage_queue` docs under a 4h TTL / `provider_turn_history` under 7d), and `agent_turn_telemetry`/`activity_log` rows are append-only measurement noise that stops accruing at deploy.

---

## Design

### D1. Stamp the turn's own frame as `deadlineOriginalText` at assembly time

In `dispatchToAgent`'s conference branch (`dispatcher.ts:1321-1349`):

```ts
      const contextPrefix = [resolved.meetingPreamble, resolved.threadContext, "---"].filter(Boolean).join("\n");
      // KPR-413: the transcript belongs to the MEETING, not to this turn. A
      // KPR-402 continuation leg re-wraps `deadlineOriginalText` verbatim on
      // every leg (up to MAX_DEADLINE_CONTINUATIONS), into a session that
      // KPR-399 resume already loaded with the original composite — so
      // letting the arm fall back to `item.text` (the assembled composite)
      // reproduces the N-copies bloat this epic exists to remove. Stamp the
      // turn's OWN frame instead: preamble + terminal slot, no injection.
      // Byte-shaped exactly like an empty-delta turn (C10), and it rides into
      // the outage store so a replayed conference turn's later abort is
      // honest too (single-dispatch leg, :382).
      const framePrefix = [resolved.meetingPreamble, "---"].filter(Boolean).join("\n");
      effectiveItem = {
        ...item,
        text: `${contextPrefix}\n${newMessageSegment}`,
        meta: {
          ...item.meta,
          conferenceMode: true,
          conferenceHumanTs: resolved.conferenceHumanTs,
          conferenceRound: resolved.conferenceRound,
          conferenceInjectionMode: resolved.injectionMode,
          deadlineOriginalText: `${framePrefix}\n${newMessageSegment}`,
        },
      };
```

**Why the stamp and not a call-site change.** The obvious one-token alternative — pass `item` instead of `effectiveItem` at `:1406` — fixes the fan-out leg but **not** the single-dispatch replay leg, where the item *is* the composite and no un-assembled original exists. It also silently drops the C3 terminal-slot framing. The stamp is the mechanism KPR-402 already built for exactly this question ("what text should a continuation carry?"), applied at the one site that knows the conference decomposition.

**Why the stamp is unconditional (overwrite, not `??=`).** A conference-assembled turn's correct continuation text is always its own slot. An inherited value cannot reach here anyway: any item carrying `deadlineOriginalText` is a continuation leg or a replay, both `targetAgentId`-pinned, both resolved at step 0 before conference resolution at step 0.7.

**Why preamble in, transcript out.** The epic's diagnosis item 1 names the transcript; the preamble is ~746 bytes (two-name roster) and carries the two instructions that make a meeting turn behave — "do NOT re-read the channel … re-orient with tools before speaking" (diagnosis item 3, the tool-storm) and the `"No response needed."` escape that C4/C15 make structural. A continuation is precisely the turn that most needs the anti-re-orientation nudge. Dropping the preamble too would save nothing measurable and would let a fresh-fallback continuation answer as if it were a DM.

**Round-1 robustness (defence in depth, not a live path).** For a round-1 reactor `newMessageSegment` is the peer-reply framing, so the stamp is C3-correct *by construction* even though the D5 gate at `:1388-1399` means the arm is unreachable at round 1 today. Had the fix instead used the raw `item.text`, a future reordering of that gate would silently resurrect the epic's original "a reaction is literally re-asked the original question" defect. Pinned by T4.

### D2. Strip conference meta from the continuation leg

In `maybeHandleDeadlineAbort` (`:831`):

```ts
    // KPR-413: conference keys are stripped alongside the replay marker. A
    // continuation leg computed no injection and never re-enters conference
    // resolution (targetAgentId → resolveAgents step 0, which precedes step
    // 0.7), so inheriting conferenceMode/Round/InjectionMode would stamp a
    // non-conference turn as a conference turn with an injection mode it
    // never used — corrupting both C18 measurement surfaces
    // (agent_turn_telemetry, activity_log). Same shape as C26's `worker:`
    // re-entry: an engine-authored re-dispatch into a meeting thread is an
    // ordinary turn. Still a blocklist, not an allowlist — channel keys stay.
    const {
      outageReplay: _replayMarker,
      conferenceMode: _confMode,
      conferenceRound: _confRound,
      conferenceHumanTs: _confHumanTs,
      conferenceInjectionMode: _confInjectionMode,
      ...carriedMeta
    } = item.meta ?? {};
```

`deadlineOriginalText` is read from `item.meta` directly at `:833-834` (not from `carriedMeta`) and re-stamped explicitly at `:864`, so the destructure order is immaterial and the chain round-trip (T9) is unaffected.

**This reverses an explicit KPR-402 ruling, and does so deliberately, not by omission.** `docs/epics/kpr-397/kpr-402-spec.md:359-362` states the blocklist rationale as: *"channel-specific keys (`slackThreadTs`/`slackTs` — thread delivery, `channelType`, `defaultAgentId`, `origin`, **conference keys**) are load-bearing for routing and delivery … What the chain strips: … `outageReplay`."* That claim — that conference keys are load-bearing for routing — was written by an epic (KPR-397) that never saw a real conference-assembled item, since KPR-388/389 hadn't merged into `main` yet. It is verifiably wrong for this codebase: routing is `targetAgentId` → `resolveAgents` step 0 (`:1126-1129`), which precedes the `conf-*` conference-resolution check at step 0.7 (`:1153-1156`) entirely — no conference meta key participates in routing or delivery on any path. KPR-413 strips exactly the keys KPR-402 named as load-bearing, having confirmed by inventory that none of them are. This is named here rather than left implicit, matching the epic's own discipline of flagging canon-adjacent reversals (KPR-409 R1/R2) rather than claiming silent authorization.

### D3. What is deliberately left alone, and why

| Behavior | Verdict |
|---|---|
| `targetAgentId: agentId` pin (`:860`) | **Correct.** Re-resolution would re-run `classifyMeetingMessage` and could select a *different* agent set for a continuation of one agent's turn. KPR-402's own "routed exactly like a replay, no re-resolution drift" rationale holds verbatim under conference. |
| Mark (`meetingLastSeenTs`) never advanced by a leg | **Correct, required by C9.** A leg injects nothing, so there is nothing to have been absorbed. For the *origin* turn (leg 0), the arm's early return at `:1406` preempts the mark-bookkeeping block at `:1419` entirely — it never runs, rather than declining a live check. Not advancing over-includes next turn — duplication, never a gap. |
| Leg never triggers the round-1 reaction pass | **Accepted residual.** A continuation answer can land two-plus deadlines after the trigger, into a thread that has moved on; firing a depth-1 reaction pass then is low value and re-entering conference resolution is exactly what the `targetAgentId` pin forbids. §Edge cases records the re-open trigger. |
| One honest notice per aborting agent under conference fan-out | **Already contemplated by KPR-402.** `dispatcher.test.ts:2014` (T16) pins it directly: *"the arm notices per agent — a deadline abort is a per-turn event, not a provider episode"* — two `DEADLINE_NOTICE_DEFAULT` deliveries asserted under fan-out. Unchanged by this fix. |
| Round-1 legs excluded from the arm entirely | **Correct, C16.** A killed reactor owes the room nothing; a killed round-0 primary was addressed by a human and is owed the notice. |

### Alternatives considered and rejected

**A. Re-derive fresh conference context per leg.** The arm has only `(item, agentId, adapter, runResult)` — no `ResolvedAgent`, no roster, no history. Re-deriving means re-fetching Slack thread history, rebuilding the roster and preamble, and calling `buildConferenceContext` from inside an abort handler. Three problems, any one disqualifying: (i) it *re-injects* into a session that just consumed the same content, so it does not solve the duplication it exists to solve — it only re-shapes it; (ii) the leg-1 abort deliberately left the mark un-advanced (C9), so a re-derived injection would be full-or-near-full, i.e. the biggest possible payload; (iii) it puts a network fetch and a scribe read on a failure path that KPR-402 keeps deliberately cheap and store-free (⚠A6). Rejected.

**B. Opt conference turns out of the continuation chain.** Two sub-shapes, both worse. Fall through to normal delivery: an empty aborted turn posts `"_No response._"` into the meeting — the precise regression KPR-402's spec cites as what it improved on, reintroduced on the surface this epic exists to improve. Suppress silently like C16: a human who addressed the agent by name gets nothing, ever, with no notice — which C16 justifies for a *reactor* (owes nothing) and cannot justify for a *primary*. Rejected.

**C. Pass `item` instead of `effectiveItem` at `:1406`.** One token, and it fixes the fan-out leg's text and meta at once — but leaves the single-dispatch replay leg (Key Point 2) untouched, and loses the C3 terminal-slot framing on the fallback path. Rejected as incomplete; its meta half is preserved as D2, which covers both legs.

## Integration points

| File | Change |
|---|---|
| `src/channels/dispatcher.ts` | D1: `framePrefix` + one `deadlineOriginalText` meta key in the conference branch (~`:1335-1348`), with comment. D2: four blocklist entries in the continuation builder (~`:831`), with comment. |
| `src/channels/dispatcher-conference.test.ts` | New describe (T1–T3); one added assertion inside the existing round-1 kill `it.each` (T4). |
| `src/channels/dispatcher.test.ts` | One row in the `deadline-abort continuation (KPR-402)` describe (T5). |

Nothing else. No `deadline-continuation.ts` change, no session-store/telemetry-schema/config/docs change, no bundle or guard implications. `docs/providers.md` is untouched (no provider-observable behavior).

## Testing

`dispatcher-conference.test.ts` already has everything needed: the classifier mock, the Slack adapter mock, and a delivery adapter. The shared outer `beforeEach` (`:214-227`) wires no outage deps and calls `vi.clearAllMocks()` per test — the one existing test that arms the outage seam (`"outage-queued turn never touches the mark"`, `:911-935`, which calls `dispatcher.setOutageHandling(...)` at `:927`) is per-test and cannot leak into a new describe. `maybeHandleDeadlineAbort` needs no outage wiring regardless (`deliverOutageNotice:1053-1071` falls back to the registered adapter, and `maybeHandlePostTurnOutage` short-circuits at `if (!outage) return false`). The `turn()` fixture at `:567-581` plus `{ timedOut: true, aborted: true, toolCalls: 46, streamed: true }` produces the D6 `turn-deadline`-with-progress shape (mirroring `withProgressAbort()` at `dispatcher.test.ts:1735-1736`). The `settleReactions()` macrotask barrier idiom (`:596-606`) is the right drain for the fire-and-forget leg dispatch.

**Fixture scoping (spec-review r1 finding):** `turn()`, `settleReactions()`, `twoAgentClassifier()`, and `confItem()` are block-scoped inside `describe("round-1 kill suppression (KPR-389 D5)")` (`:557-672`); `PREAMBLE` is scoped to `describe("delta context injection (KPR-388)")` (`:674`+). Only `soloClassifier()` (`:231`) is hoisted to the outer describe. T1's new describe needs `turn`, `settleReactions`, and `PREAMBLE` — lift these three to the outer describe scope (the file already has precedent for this exact move: the `soloClassifier` hoist comment at `:229-230`) rather than duplicating them. T4 needs no lift — it extends the existing `it.each` in place, where `settleReactions` is already in scope.

- **T1 — the direct regression (new describe, `dispatcher-conference.test.ts`).** Round-0 conference turn (`soloClassifier`) with real thread history, deadline-aborts with progress. Assert on the second `runWorkItemTurn` call's item: `.text` **is** `deadlineContinuationWrap(<preamble + "\n---\n" + "[New message]:\n" + humanText>, 1, 3)`; `.text` does **not** contain `"[Meeting thread in #"`; `.text` **does** contain `"Meeting rules:"` and the human text. **Negative-verify:** delete the `deadlineOriginalText` stamp → `originalText` falls back to the composite → the transcript-marker negative assertion fails. (Assert the marker negatively *and* the equality positively: the equality alone would also fail for cosmetic reasons, the marker assertion names the actual defect.)
- **T2 — meta honesty (same describe).** Same setup; assert the leg's meta has `deadlineRetry: 1`, `targetAgentId`, `slackThreadTs`, and a `deadlineOriginalText` with no transcript marker, and that `conferenceMode`, `conferenceRound`, `conferenceHumanTs`, `conferenceInjectionMode` are all `undefined`. **Negative-verify:** drop the blocklist entries → `conferenceRound` is `0`, assertion fails. (`dispatcher.test.ts:1762` asserts the non-conference leg's meta with `toMatchObject`, a subset match — D2's four new strips cannot break that row; T2 is the twin that asserts those same keys are absent.)
- **T3 — chain non-nesting under conference (same describe).** Every leg aborts with progress: assert leg ids `#dl1`, `#dl2` (flat), that leg 2 wraps the **same** frame string (never leg 1's wrap), and that the cap stops at two legs. Mirrors `dispatcher.test.ts:1905-1920` on a conference fixture.
- **T4 — round-1 unreachability pin (extend the existing `it.each` at `:608-626`).** Add, after `settleReactions()`, `expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2)` — i.e. the `timedOut + aborted` reactor produced no third dispatch. This pins the D5-before-arm ordering that `705f9f9` established and that D1's round-1 correctness would otherwise only latently depend on. Cheap, and it fails loudly if the gates are ever reordered again. **Negative-verify:** reorder D5 after the arm at `:1406` → the `timedOut + aborted` reactor fires a third dispatch and the count assertion fails.
- **T5 — single-dispatch replay leg (`dispatcher.test.ts`, deadline describe).** Hand-build a replay item in the shape the outage store would actually hold for a conference turn — per `outage-replay-processor.ts:123`, the stored `text` is `replayWrap(composite)`, not the bare composite, so a faithful pre-fix fixture wraps a *nested* wrap of the composite (the defect is slightly worse than "one copy," reinforcing the fix's motivation) — plus conference meta, `outageReplay: true`, `targetAgentId`, and the D1 stamp — and abort it with progress. Assert the leg wraps the **stamped** frame, not the composite `text`, and that the leg carries no conference meta. This is the row that proves the stamp (not a call-site swap) was the right mechanism. **Negative-verify:** remove the stamp from the fixture *and* the code → the leg wraps the composite.
- **Non-regression, no new rows.** `dispatcher.test.ts:1742` (T1) already pins `deadlineOriginalText: "summarize the big repo"` derived from `item.text` for a non-conference slack item — it must stay green, proving the fallback at `:833-834` is untouched. `dispatcher-conference.test.ts:658` ("a killed ROUND-0 turn keeps today's delivery behavior") uses `aborted: true` **without** `timedOut`, so it never enters the arm and must also stay green. The C6 byte-exact round-0 prompt pin must stay green — the fix adds no prompt byte.

## Edge cases

- **Empty delta (`threadContext === ""`).** The composite is already `preamble + "\n---\n" + slot` — identical to the stamped value. The fix is a no-op for that turn and the leg is correct either way. This is the shape the stamp deliberately reuses.
- **Summary-mode turn (KPR-409).** `threadContext` is summary + tail; dropped from the stamp like any other injection. The summary is regenerated for the *meeting* by the scribe, never owned by a turn — consistent with C13's single-integration-site clause.
- **Fresh-fallback continuation (⚠A4 persist race, KPR-399 §Edge-7 contender overwrite).** The leg lands in an empty session with frame + slot and no transcript. Degraded but coherent: the agent knows it is in a meeting, who is present, not to re-orient with tools, and how to decline. Accepted — resume is the normal case by construction (the arm only continues on observed progress, and KPR-399 persists exactly those sessions). Re-open trigger: fresh-fallback continuations in `conf-*` channels observed producing DM-shaped or contextless answers.
- **Round-1 reactor.** Unreachable through the arm today (D5, `:1388-1399`). D1 is nonetheless C3-correct for it; T4 pins the ordering.
- **A continuation leg that itself gets outage-queued** (breaker opens mid-chain, `dispatcher.test.ts:1945`). Its stored meta now carries the frame-valued `deadlineOriginalText` and no conference keys, so the replayed leg and any further abort stay honest. Strictly better than today.
- **Multi-agent conference fan-out, several agents abort.** Each gets its own notice and its own leg; all legs share id `<origin>#dl1` and are separated by `targetAgentId`. Already designed for (KPR-402 D39/T16, dedup bypass at `:205`). Unchanged.
- **Zero-progress conference abort.** Takes the `!withProgress` branch (`:718-762`): notice only, no leg, no text carriage. Unaffected by this fix.
- **Cap exhaustion / terminal notice.** No text carriage on that path either (`:795-813`). Unaffected.
- **Non-conference fan-out and every single-dispatch non-conference item.** `resolved.conferenceMode` is false, so no stamp is written and `:833-834` falls back to `item.text` exactly as today. Byte-identical.

## Canon compliance

- **C3** — the continuation carries the turn's *terminal slot*, which is the C3 contract's own artifact; the human message is never re-presented in a round-1 leg's slot even hypothetically. Round-0 prompt bytes unchanged (C6 pin green — the change is meta-only).
- **C9** — the mark is still advanced only over messages injected into an absorbed turn; a leg injects nothing and advances nothing. Failure mode stays duplication, never a gap.
- **C10** — the stamped string is byte-shaped like an empty-delta turn, a sanctioned existing shape; `"[New message]:"` remains the terminal-slot marker and appears nowhere else.
- **C12** — a replay still pins `targetAgentId`, skips conference resolve, and never re-injects or touches the mark; the fix makes the *text* a replayed conference turn continues with honest, without changing replay routing.
- **C18** — `conferenceRound` / `injectionMode` are restored to meaning "this turn actually was a conference turn with that injection", on both the telemetry and activity_log surfaces.
- **C26** — generalized rather than extended: an engine-authored re-entry into a meeting thread (`worker:` there, `#dl<n>` here) is an ordinary non-conference turn, structurally invisible to marks and shaping. Candidate register entry.
- **Epic diagnosis item 1** — the last remaining site where a conference transcript is duplicated per-turn is closed.

## Open questions / assumptions

- **⚠ Non-blocking (assumption, resolved by precedent):** a deadline-killed **round-0** conference turn *should* continue with the honest-notice UX, rather than dying silently like a killed reactor. C16 grounds the asymmetry — a reactor owes the room nothing, a primary was addressed by a human — and KPR-402's notify-lane policy already covers slack. Recorded as an assumption because it is the one place a human could reasonably rule the other way; no code branches on it beyond what already exists.
- **⚠ Non-blocking (judgment call, re-open trigger recorded):** the preamble is included in the stamped frame and the transcript is not. If the preamble ever grows materially (KPR-389 C15 hardening is explicitly an ongoing surface), revisit whether a continuation should carry an abbreviated frame instead.
- **⚠ Non-blocking (accepted residual):** a continuation's eventual answer fires no round-1 reaction pass. Re-open trigger: observed meetings where a continued answer visibly needed peer follow-up and got none.
- **⚠ Non-blocking (deliberate):** no new log line distinguishing "conference continuation" from any other leg. The existing "Deadline continuation dispatched in-process" log plus the (now honest) absence of conference stamps is sufficient; the epic's posture is code-enforce over log-enforce.
