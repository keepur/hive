# KPR-387 — Conference reaction dispatch: exclude round-0 responders; frame reactions against the peer reply

**Epic:** KPR-386 (meeting mode) — first child.
**Status:** spec-ready (spec review clean round 1, fable; advisory notes folded in).
**Decision-register canon:** none exists yet — KPR-386 is a pre-register epic and this is its first child. Noted per contract; not a blocker.

## TL;DR

Conference (`conf-*`) reaction dispatch has two verified defects in `src/channels/dispatcher.ts`: (1) round-0 (primary) responders are never recorded in `meetingReactionTracker`, so a primary that already answered the human message can be re-selected as a round-1 "reactor" on the same message and answer it twice; (2) reaction turns are dispatched with the *original human message* in the `[New message]:` slot, so reactors are re-asked the question instead of being asked to engage with the peer reply they are nominally reacting to. Fix: record round-0 selections into the existing per-`(threadId, humanTs)` tracker at classification time, and reframe round-1 dispatch so the `[New message]` slot carries the peer's reply and author.

## Key Points

- **Defect 1 confirmed** (`resolveConferenceAgents`, dispatcher.ts:1097–1170): round-0 `classification.respondAgentIds` are dispatched but never written to `meetingReactionTracker`; `triggerConferenceReactions` (1217–1312) excludes only `respondingAgentId` + already-claimed round-1 reactors, so any *other* round-0 primary is an eligible reaction peer for the same `humanTs`.
- **Defect 2 confirmed** (`dispatchToAgent`, dispatcher.ts:990–1004 + call at 1308): reactions dispatch `originalItem`, and the conference prefix ends `[New message]:\n${item.text}` — the human message. The peer reply exists only inside the re-fetched `threadContext` transcript.
- **Fix shape:** (a) record round-0 responder ids into the tracker synchronously inside `resolveConferenceAgents` (before any dispatch — no race window); the existing `reacted.has(agentId)` skip in `triggerConferenceReactions` then excludes them with no further changes. (b) Extend `ResolvedAgent` with `reactionTo?: { authorName, text }`; round-1 dispatch populates it and `dispatchToAgent` builds the final prompt segment from it instead of `item.text`.
- **Decision — record at selection time, not completion time:** a primary that was selected round-0 but suppressed ("(no response)") stays excluded from reacting to peers on the same trigger. This is the behavior that kills the observed suppressed-turn burn (9 wasted tool-laden turns in a 24-min window), and matches the Gate 1 ⚠ delegated assumption "round-0 responders are recorded so a primary can't re-answer its own trigger."
- **⚠ Delegated assumption (Gate 1, epic comment 1e61a7f0):** reaction turns are reframed against the peer reply and *never* re-presented the human message in the `[New message]` slot — the human message remains available to the reactor only via the transcript (`threadContext`), which round-1 already re-fetches.
- **WorkItem semantics preserved:** the reaction turn still dispatches `originalItem` (same `id`, `meta`, thread routing, ledger/audit behavior); only the prompt text assembled in `dispatchToAgent` changes. No new WorkItem is synthesized.
- **Out of scope (YAGNI hard):** KPR-388 delta/transcript-injection changes, KPR-389 `conferenceRound` spawn shaping + preamble hardening + telemetry, KPR-390 meeting worker pool, classifier prompt changes, reaction depth > 1, conference support outside Slack.
- **Test plan:** two new regression tests in `src/channels/dispatcher-conference.test.ts` plus the negative-verify convention (revert source, confirm both fail on pre-fix code).
- **Risk:** low — additive tracker write + prompt-assembly branch; no schema, config, or cross-module changes.

## Problem

`#conf-tahoe` (dodi, 2026-08-25) exhibited:

1. **Double answers**: an agent answers the human message as a round-0 primary, a peer's reply triggers the reaction pass, and the same agent is selected again as a round-1 reactor — receiving the *same human message* as its `[New message]` — producing a near-duplicate second answer seconds later (observed: gemini "understood, let's discuss" → "got it. let's discuss").
2. **Suppressed-turn burn**: agents re-asked a question they already answered (or declined) spend a full tool-laden turn (30–60s observed) before emitting "(no response)". 9 suppressed turns in a 24-min window; 347 in the log.

Both trace to `src/channels/dispatcher.ts`:

- `resolveConferenceAgents()` selects round-0 responders via `classifyMeetingMessage` and returns them with `conferenceRound: 0` — **without recording them** in `meetingReactionTracker` (`Map<threadId, Map<humanTs, Set<agentId>>>`, line 97). The tracker is only written inside `triggerConferenceReactions`, and only for round-1 claims.
- `triggerConferenceReactions(responseText, originalItem, respondingAgentId, humanTs)` builds the peer roster excluding only `respondingAgentId` and already-claimed reactors (lines 1239–1252). Other round-0 primaries pass the filter. Worse, the reaction classifier is given `responseText` as the message — its "addressed by name MUST respond" rule means a primary that name-checks another primary ("Jasper: agreed…") force-selects them.
- Reaction dispatches call `this.dispatchToAgent(originalItem, resolved)` (line 1308). `dispatchToAgent` builds `[preamble, threadContext, "---", "[New message]:"].join("\n") + "\n" + item.text` (lines 991–996) — so the round-1 turn's prompt ends with the *human's* message. The peer reply being reacted to is only buried in the re-fetched transcript, with nothing marking it as the thing to engage with.

## Goals

1. A round-0 primary is never selected as a round-1 reactor for the same triggering human message (`humanTs`).
2. A round-1 reaction turn's `[New message]` slot presents the peer's reply (author + text) as the thing to engage with, not the human message.
3. Regression tests for both behaviors, negative-verified against pre-fix code.

## Non-goals

- Any change to what transcript/context is injected or how it is fetched (KPR-388).
- Threading `conferenceRound` into spawn shaping, preamble hardening beyond the reaction slot, or telemetry (KPR-389).
- Meeting worker pool / concurrency shaping (KPR-390).
- `classifyMeetingMessage` prompt or schema changes.
- Reaction depth > 1 (the `conferenceRound === 0` gate at line 1049 is untouched).
- Conference mode on non-Slack channels; tracker persistence across restarts.

## Design

### 1. Record round-0 responders in the tracker

In `resolveConferenceAgents()` (dispatcher.ts:1097), after `classifyMeetingMessage` returns and before constructing the `ResolvedAgent[]` return value, record the selected ids:

```ts
// Record round-0 responders so the reaction pass never re-selects a primary
// for the same triggering message (KPR-387).
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

(Extract the get-or-create into a small private helper if the plan prefers — e.g. `claimForHumanMessage(threadId, humanTs): Set<string>` — shared with the identical get-or-create block at lines 1229–1234. Not required.)

Why this is sufficient with **no change** to the exclusion logic:

- `triggerConferenceReactions` already skips `reacted.has(agentId)` when building `peerMembers` (line 1242). Round-0 ids recorded here are skipped automatically.
- The "release unselected peers" loop (lines 1259–1265) only iterates `peerMembers`; round-0 entries are never in `peerMembers`, so they are never released. No accidental un-claiming.
- The reaction classifier's output is filtered to the roster it was given (`parseClassifierOutput` validates against `validIds`), so an excluded primary cannot re-enter via classifier output.
- Recording is synchronous within `resolveConferenceAgents`, which completes before any round-0 dispatch starts (the fan-out at line 243 happens after `resolveAgents` returns) — no race with concurrent round-0 completions triggering reactions.

The existing `respondingAgentId` skip (line 1241) becomes redundant for the triggering agent but stays — harmless, and it protects the (theoretical) `humanTs`-undefined path where nothing was recorded.

Note the classifier's all-roster fallback paths (no API key, call failure, parse failure all return every roster member as round-0 responders): under this fix those paths record the whole roster and therefore suppress all reactions for that trigger. That is coherent — everyone already answered — but it is a deliberate consequence the tests should not trip over.

**Timing semantics (decision):** recording happens at *selection* time, not completion time. Consequence: a round-0 primary whose turn errors or is suppressed remains excluded from reacting on that `humanTs`. This is intentional — it is exactly the suppressed-burn case from the incident (the agent already had its shot at this trigger), and it matches the Gate 1 delegated assumption.

### 2. Reframe the round-1 dispatch against the peer reply

**Data path.** Extend `ResolvedAgent` (dispatcher.ts:46–54):

```ts
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

In `triggerConferenceReactions`, resolve the responder's display name once (`this.registry.get(respondingAgentId)?.name ?? respondingAgentId`) and populate each round-1 `ResolvedAgent` (lines 1299–1309) with `reactionTo: { authorName, text: responseText }`.

**Prompt assembly.** In `dispatchToAgent` (lines 990–1004), branch the final segment on `reactionTo`:

```ts
if (resolved.conferenceMode) {
  const newMessageSegment = resolved.reactionTo
    ? `[${resolved.reactionTo.authorName} just replied]:\n${resolved.reactionTo.text}\n\n` +
      `React to ${resolved.reactionTo.authorName}'s reply if you have something to add. ` +
      `Do not re-answer the original question. If you have nothing to add, respond with "No response needed."`
    : `[New message]:\n${item.text}`;
  const contextPrefix = [resolved.meetingPreamble, "", resolved.threadContext, "", "---"]
    .filter(Boolean)
    .join("\n");
  effectiveItem = { ...item, text: `${contextPrefix}\n${newMessageSegment}`, meta: { ...item.meta, conferenceMode: true, conferenceHumanTs: resolved.conferenceHumanTs, conferenceRound: resolved.conferenceRound } };
}
```

(Exact wording is a plan/implementation detail; the contract is: author name + full peer reply text in the terminal slot, an explicit "engage with this, don't re-answer" instruction, and the human message **absent** from the terminal slot.)

The human message is not lost: round-1 `threadContext` is re-fetched *after* the round-0 reply was delivered (lines 1276–1296), so the transcript contains both the human message and the peer reply, in order. The peer reply appearing twice (transcript + terminal slot) is acceptable and mirrors how round-0 already duplicates the human message (transcript + `[New message]`).

**No truncation** of `responseText` in the slot: it is a single Slack-delivered agent reply, already bounded by delivery norms, and it is the entire subject of the turn.

**WorkItem semantics unchanged.** The reaction still dispatches `originalItem` — same `id`, `threadId`, `source`, `sender`, `meta.slackTs`/`slackThreadTs` — so thread routing in `deliverAgentResult`, task-ledger tracking, audit logging, and the KPR-307 outage gates behave exactly as today. Only the assembled `effectiveItem.text` differs. `meta.conferenceRound: 1` is already set and is the discriminator KPR-389 will build on.

### Integration points

- `src/channels/dispatcher.ts` only. Touched members: `ResolvedAgent` (type), `resolveConferenceAgents` (tracker write), `triggerConferenceReactions` (populate `reactionTo`), `dispatchToAgent` (prompt branch).
- `meetingReactionTracker` shape (`Map<threadId, Map<humanTs, Set<agentId>>>`) is unchanged — the set's meaning widens from "reacted in round 1" to "responded or was selected to respond on this human message, either round"; update the line-96 comment accordingly.
- `classifyMeetingMessage` call signatures unchanged.
- Sweep/eviction (`sweep()`, line 1089) unchanged — tracker still pruned per-thread on `threadTtlMs`.
- No config, schema, or cross-module changes; no docs/providers.md impact.

### Edge cases

- **Multiple round-0 responders, concurrent completion:** all primaries are recorded synchronously before any dispatch; the existing claim-before-await pattern (line 1245) continues to serialize round-1 claims between concurrent reaction passes. No new races introduced.
- **Reaction classifier echoing a primary's id:** impossible to select — primaries are absent from `peerMembers`, and classifier output is filtered to the given roster.
- **`humanTs` undefined** (`item.meta.slackTs` missing): recording is guarded and skipped. This matches the existing code's posture (`resolved.conferenceHumanTs!` at line 1050 already assumes Slack-sourced conference items; `conf-*` detection at line 823 is Slack-only). Behavior degrades to today's, no worse.
- **Empty primary responder set:** classifier returns `[]` → nothing recorded, nothing dispatched, no reaction pass. Unchanged.
- **Same agent across different human messages:** tracker is keyed per `humanTs` — an agent that answered message A is fully eligible as primary or reactor for message B. Unchanged and correct.
- **Tracker growth within a live thread:** one `Set` (≤ roster size) per human message per thread, pruned with the thread by `sweep()`. Recording round-0 ids adds no new keys, only members to sets that round-1 would create anyway. Negligible.
- **60s ingress dedup window:** operates on message ids at `dispatch()` ingress; reaction dispatches enter via `dispatchToAgent` directly and were never deduped. Unchanged.
- **Round-1 replies triggering round-2:** still impossible (`conferenceRound === 0` gate at line 1049). Unchanged.
- **Responder disabled between rounds:** `registry.get` + `disabled` checks in the reaction roster build are unchanged.
- **Missing display name:** fall back to the agent id for `authorName`.

## Test plan

Extend `src/channels/dispatcher-conference.test.ts` (tests live beside source per repo convention). The existing harness (mock registry with jasper/river/jessica, mocked `classifyMeetingMessage`, mock slack adapter) already supports both tests.

**Async-drain hazard (both new tests):** `triggerConferenceReactions` is fire-and-forget at its call site (dispatcher.ts:1050 — `.catch`, not awaited), so `await dispatcher.dispatch(item)` returns before any reaction-pass classifier call or round-1 `runWorkItemTurn` happens. Both tests must drain the in-flight pass (e.g. `vi.waitFor` on the asserted mock call / microtask flush) or they pass vacuously; the negative-verify step is the backstop that would expose a vacuous test.

1. **Round-0 responders excluded from the reaction roster.** Mention Jasper, River, and Jessica in a `conf-*` item; round-0 classifier returns `["jasper", "river"]`; reaction-classifier calls return `[]` (or capture-only). Assert every reaction-pass `classifyMeetingMessage` call receives a roster containing **only** `jessica` — neither `jasper` nor `river` — and that `runWorkItemTurn` is invoked at most once per agent for the trigger. (Pre-fix: River appears in the roster of the reaction pass triggered by Jasper's reply, and vice versa.)
2. **Round-1 prompt frames the peer reply.** The trigger message must mention both Jasper and Jessica (if only Jasper is mentioned, `peerMembers` is empty and `triggerConferenceReactions` returns at line 1254 before the reaction classifier is ever called). Round-0 returns `["jasper"]`; the reaction classifier (second call) returns `["jessica"]`. With `fetchThreadHistory` mocked to `[]`, assert the round-1 `runWorkItemTurn` item (`meta.conferenceRound === 1`) has text that (a) contains the mocked round-0 response text (`"Agent response"`) and the responder's display name (`"Jasper"`), and (b) does **not** contain the original human message text and does not end with the `[New message]:\n<human text>` pattern. (Pre-fix: the text ends with the human message and never contains the peer reply.)
3. **Negative verify** (per `feedback_negative_verify_regression_tests`): with both fixes reverted (stash/`git checkout` of the dispatcher hunks), run the two new tests and confirm both fail; restore and confirm green. Record the evidence in the PR.
4. **Regression sweep:** full `npm run check` — in particular the six existing tests in the file (five conference-path + one negative-routing) must stay green (none asserts the pre-fix defective behavior: the fan-out test suppresses reactions via empty classifier results, and the round-0 `[New message]` framing tests only cover `conferenceRound: 0` items, which are untouched).

## Open questions

- **Non-blocking — suppressed-primary permanence:** recording at selection time means a suppressed round-0 primary can never be pulled back in as a reactor on that trigger. Chosen deliberately (kills the burn; matches Gate 1 assumption). If meeting dynamics later want "silent primaries may still react," that is a KPR-389-adjacent tuning, not this ticket.
- **Non-blocking — reaction instruction wording:** the exact reframed-slot sentence is an implementation-time choice; the spec fixes only its contract (author + reply text present, human message absent, explicit don't-re-answer + no-response escape hatch).
