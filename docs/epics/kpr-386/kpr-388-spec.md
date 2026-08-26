# KPR-388 — Delta context injection keyed to meeting continuity

**Epic:** KPR-386 (meeting mode) — second child, follows merged KPR-387 (@ 3896a24).
**Status:** spec-ready (spec review clean r1, fable; advisory notes folded in).
**Decision-register canon:** C1–C6 (from KPR-387) bind this spec; interactions resolved in §Design/6 and §Canon.

## TL;DR

Every conference turn today injects the full thread transcript into the prompt even though every lane is stateful, so by turn N an agent's session holds N overlapping transcript copies. Fix: store a per-agent-per-thread high-water mark (`meetingLastSeenTs`, a Slack ts) on the existing `sessions` document; when the agent has a resumable same-provider session **and** a mark, inject only the messages newer than the mark; on every path where continuity is absent or breaks, inject the full transcript exactly as today and (re)establish the mark. A new `resumedSession` flag on `TurnResult` closes the one hole the ticket sketch missed: a turn that was delta-injected but actually ran fresh (stale-handle self-heal, auth-rebuild retry) clears the mark so the *next* turn heals with a full transcript.

## Key Points

- **Verified injection site:** `Dispatcher.dispatchToAgent` (dispatcher.ts:994–1014) prepends `meetingPreamble + threadContext + "---" + terminal slot` into `WorkItem.text` *before* `runWorkItemTurn` — so fresh-vs-resumed is **not definitively knowable at injection time**; it is *predictable* from `sessionStore.get()` + provider match, and *knowable* only post-turn. The design uses prediction on the read side and a new post-turn `resumedSession` signal on the write side.
- **Sketch verified with one correction:** mark lifecycle == session **document** lifecycle holds exactly (same `sessions` doc, same 7-day idle TTL, dies on delete/scrub/`clearAgent`), but NOT session **handle** lifecycle — `finalizeSpawnResult` rewrites handles in place (compaction rotation, self-heal) without deleting the doc. Hence the clear-mark-on-fresh-run rule.
- **Delta rule (read side):** inject delta iff the stored ref has a resumable `sessionId`, `provider` matches the agent's current provider (`agentManager.providerFor`), and `meetingLastSeenTs` is present. Anything else → full transcript, byte-identical to today (C6 pin untouched).
- **Mark rule (write side):** after a successful (`!error && !aborted`) conference turn — including suppressed non-response turns — set the mark to the max Slack ts actually injected; if the turn was delta-injected but `resumedSession === false`, **clear** the mark instead (next turn full). Error/aborted/queued-for-outage turns leave the mark untouched.
- **Covering invariant** (the correctness argument): the mark only ever advances to cover messages actually injected into a turn whose session absorbed them ⇒ session ∪ current injection always covers the thread. All identified races (pre-lock mark staleness, fire-and-forget row write) err toward **duplication, never gaps**.
- **C3 resolved explicitly:** a round-1 reactor is never a round-0 responder for the same trigger (C1/C2), so its mark predates the triggering human message ⇒ the human message is in its delta (or its session, by the invariant). C3's "reachable via the re-fetched transcript" rationale generalizes to "reachable via session ∪ injected delta" — the terminal-slot contract itself is untouched.
- **Out of scope:** codex (`stateless-replay` — no resumable-handle signal at injection time; keeps today's full-injection behavior, bloat bounded by `provider_turn_history` char-budget trimming), scribe/summary anchoring (KPR-390 — the full-injection branch is its future hook), preamble slimming on resumed turns (kept every turn — it carries the C4 escape hatch), KPR-389 items, staleness culling, working indicator.
- **⚠ Delegated refinements** (mechanical consequences of verified code, flagged per contract): (1) the self-heal/auth-rebuild retry reuses the already-shaped prompt (`runOneSpawnAttempt(…, shaping, …)`), so the ticket's "self-heal fresh retry → inject full transcript" is physically impossible same-turn; the spec substitutes one degraded turn + next-turn heal via mark clear. (2) `resumedSession` means "final attempt launched with a handle," an approximation for client-transcript lanes (a cold local cache is not detectable) — accepted, failure mode is bounded duplication or one system-notice'd fresh turn.
- **Risk:** low-medium — one optional field + two narrow methods on `SessionStore`, one optional field on `TurnResult`/`RunResult`, per-agent context computation in the two conference resolve paths, `ThreadMessage` gains raw `ts`. No new collections, no config, no provider-adapter changes.

## Problem

Verified in production dodi `#conf-tahoe` (2026-08-25) and in code:

- `resolveConferenceAgents` (dispatcher.ts:1144–1157) fetches the whole thread (`fetchThreadHistory`, limit 200) and formats **one shared** `threadContext` (first 5 + last 100 when >105) for every selected agent. `triggerConferenceReactions` (1302–1323) re-fetches and does the same for round-1.
- `dispatchToAgent` (994–1014) bakes that transcript into `WorkItem.text` for every conference turn.
- Meanwhile every lane is stateful: Claude/Lane A resume per-thread sessions (`sessions` doc, `options.resume`), openai chains `previous_response_id`, gemini chains `previous_interaction_id`. The injected transcript from turn k is *inside* the session context at turn k+1, which also injects a fresh, slightly longer copy.

Result at turn N: N overlapping transcript copies in effective context — token waste, prompt-cache defeat (the growing prefix never matches), and degraded "what have I already said" self-awareness (feeds both the double-response and suppressed-non-response symptoms KPR-387 partially addressed).

## Goals

1. A conference turn on an intact, same-provider session injects **only messages the session has not been shown** (the delta since this agent's last successful turn in this thread).
2. Every continuity-loss path (no session, TTL'd doc, provider handoff, stale-handle self-heal, restart-with-lost-state) converges — same turn or next turn — to full-transcript injection with no special-cased provider logic.
3. The full-injection prompt stays byte-identical to today (C6 pin untouched); the delta prompt shape gets its own byte pin.
4. Regression tests, negative-verified per repo convention.

## Non-goals

- **Codex delta.** `stateless-replay` semantics persist no resumable handle (`normalizeRef` → `sessionId: undefined`), so the read-side rule naturally routes codex to full injection every turn — today's behavior, no regression. Its real continuity source (`provider_turn_history`) has independent trimming/TTL invisible to the dispatcher; wiring a second continuity signal is not worth it for a lane with no conference deployment. Bloat there stays bounded by the history char budget.
- **Scribe / running-summary anchor (KPR-390).** Not designed here. Preserved hook: the fresh-session branch is a single site (`buildConferenceContext`'s `mode: "full"` arm) where a future summary+recent-delta assembly can replace the raw transcript without touching the delta arm or the mark mechanics.
- **Preamble deduplication.** `buildMeetingPreamble` is re-injected on every turn including delta turns — it is ~9 lines, carries the roster (which drifts) and the C4 "No response needed." escape wording, and must survive compaction. Not worth optimizing.
- **KPR-389 scope** (conferenceRound spawn shaping, preamble hardening beyond what delta requires, telemetry stamping), **KPR-390 scope** (worker pool), harder transcript caps (rejected in brainstorm: still duplicates, breaks the fresh-session depth need), working indicator, staleness culling, tool-inventory restriction.
- Classifier changes — `classifyMeetingMessage`'s `recentMessages` (last 5, resolve-time) is orthogonal and unchanged.

## Design

### 1. The mark: `meetingLastSeenTs` on the `sessions` document

`SessionDoc` (session-store.ts:12–28) gains one optional field:

```ts
/** KPR-388: Slack ts (raw string, e.g. "1724632800.123456") of the newest
 *  thread message this agent's session has been shown via conference
 *  injection. Absent ⇒ no delta basis ⇒ full-transcript injection. */
meetingLastSeenTs?: string;
```

Lifecycle — deliberately identical to the document, not the handle:
- Same `_id: "{agentId}:{threadId}"`, same 7-day idle TTL (`updatedAt` index), dies with `delete()`, `clearAgent()`, and the KPR-313 lazy scrub (row delete).
- Survives in-place handle rewrites (compaction rotation, self-heal success) — which is exactly why §4's clear-on-fresh rule exists.

`StoredSessionRef` gains `meetingLastSeenTs?: string`, populated in `normalizeRef` from the doc **except** on the scrub branch (which returns no mark — the row is being deleted). Legacy grandfathered rows have no field → `undefined` → full injection. The legacy `slack:`-key read fallback needs no mark handling: writes always target the new key, which `finalizeSpawnResult`'s upsert creates on the first post-upgrade turn.

Two narrow `SessionStore` methods (both `withRetry` fail-soft, both **`updateOne` without upsert** — a mark must never create a row; an upserted skeleton row would break `normalizeRef`'s assumptions and fabricate thread-affinity via `findAgentsByThread`):

```ts
async setMeetingMark(agentId: string, threadId: string, ts: string): Promise<void>
  // $set: { meetingLastSeenTs: ts } — does NOT touch updatedAt (TTL stays
  // owned by turn persistence; the same turn's finalizeSpawnResult set()
  // already refreshed it)
async clearMeetingMark(agentId: string, threadId: string): Promise<void>
  // $unset: { meetingLastSeenTs: "" }
```

### 2. Read side — per-agent delta decision at resolve time

`resolveConferenceAgents` and `triggerConferenceReactions` keep their single `fetchThreadHistory` call per trigger, but the shared `threadContext: string` on `ResolvedAgent` becomes per-agent. New private helper:

```ts
private async buildConferenceContext(
  agentId: string, threadId: string, history: ThreadMessage[],
  channelName: string, roster: RosterMember[],
): Promise<{ threadContext: string; injectionMode: "full" | "delta"; injectionHighWaterTs?: string }>
```

Decision (all three must hold for delta; else full):
1. `ref = agentManager.getSessionStore().get(agentId, threadId)` returns a ref with truthy `sessionId` (resumable handle — excludes no-row, TTL'd, scrubbed, empty-handle, and codex rows);
2. `ref.provider === agentManager.providerFor(agentId)` (else spawnTurn's KPR-313 guard will run the turn fresh with a handoff notice — full injection is the correct pairing);
3. `ref.meetingLastSeenTs` present.

- **Full mode:** `formatThreadContext(history, …)` unchanged, byte-for-byte (first-5 + last-100 pinning intact; C6 pin test green untouched). `injectionHighWaterTs` = max ts over the *included* (post-truncation) messages — additionally maxed with the trigger's `meta.slackTs` on round-0, same as delta mode (uniform rule, both modes: the terminal slot showed the trigger, so the session absorbed it; covers a fetch that raced the trigger message).
- **Delta mode:** `delta = history.filter(m => parseFloat(m.ts) > parseFloat(mark))`, capped at the last 100 (same cap constant as full; no first-5 pin — the session has the opening by the covering invariant). Formatted with the same `author (ago): text` body but a delta header, e.g.:

  ```
  [Meeting thread in #conf-tahoe — participants: Jasper, River]
  [New messages since your last turn:]
  ```

  Exact wording is the plan's to fix and byte-pin; it must not contain `[New message]:` (the terminal-slot marker) to keep the C3 framing test's negative assertions unambiguous. Empty delta ⇒ `threadContext = ""` ⇒ dropped by the existing `filter(Boolean)` join — the prompt degenerates to the already-pinned empty-history shape, and the terminal slot still carries the trigger (round-0) or peer reply (round-1), so an empty delta is always safe. `injectionHighWaterTs` = max injected ts, additionally maxed with the trigger's `meta.slackTs` on round-0 (covers a fetch that raced the trigger message: the terminal slot showed it, so the session absorbed it).

`ResolvedAgent` carries `injectionMode` and `injectionHighWaterTs` alongside the now-per-agent `threadContext`. `dispatchToAgent`'s prompt assembly (the `contextPrefix` join and both terminal-slot branches) is **unchanged**.

Slack ts comparison: raw `ts` strings compared via `parseFloat` (microsecond-precision decimal seconds, server-assigned, monotonic per channel), strictly-greater semantics. This requires `ThreadMessage` (slack-adapter.ts:19) to gain `ts: string` (from `msg.ts`), keeping the existing derived `timestamp: Date` for display — the Date's millisecond truncation is not collision-safe for the mark. Carry the existing `msg.ts ?? "0"` posture into the new field knowingly: a hypothetical ts-less message gets `ts: "0"` and sorts permanently below any mark (delta-excluded). Slack always assigns ts, so this is a typing artifact, accepted.

### 3. Fresh-vs-resumed signal — `TurnResult.resumedSession`

Verified reality: `TurnResult` carries no resume signal today, and `spawnTurn` can silently degrade a predicted resume to fresh on three paths after injection is already baked: the KPR-313 provider-handoff guard (`sessionId: undefined, sessionHandoff: true`), the auth-rebuild retry (sessionId stripped), and the KPR-350/351 stale-server-handle self-heal (fresh, or a contender's adopted handle). All retries reuse the already-shaped prompt — same-turn re-injection is impossible by construction.

Addition: `spawnTurn` tracks the sessionId actually passed to the **finalized** `runOneSpawnAttempt` (a local updated at each retry call; the KPR-351 contender-adoption arm counts as resumed when `adoptedSessionId` is set) and surfaces `resumedSession: boolean` (`!!finalAttemptSessionId`) on `TurnResult` via `finalizeSpawnResult`. `Dispatcher.convertTurnResult` passes it through (optional `resumedSession?: boolean` added to `RunResult` for the conversion type only; runner/adapters never set it). Known approximation (⚠ above): for client-transcript lanes, "launched with a handle" is not proof the vendor-side/local transcript was warm — undetectable, accepted; the KPR-313 handoff turn already prepends its own system notice.

### 4. Write side — mark bookkeeping in `dispatchToAgent`

After the existing KPR-307 outage gates (a queued/fast-failed turn must not touch the mark), gated on `resolved.conferenceMode && !runResult.error && !runResult.aborted`, and **outside** the `isNonResponse` branch (a suppressed turn consumed its injection — C2's "responded or selected" spirit):

```ts
if (resolved.injectionMode === "delta" && runResult.resumedSession === false) {
  // Delta went into a fresh session — continuity broke after injection.
  // Clear the mark: the NEXT turn injects the full transcript and heals.
  await store.clearMeetingMark(agentId, threadId);
} else if (resolved.injectionHighWaterTs) {
  await store.setMeetingMark(agentId, threadId, resolved.injectionHighWaterTs);
}
```

(`threadId = effectiveItem.threadId ?? effectiveItem.id` — same formula as `runWorkItemTurn`'s store key; round-1 dispatches `originalItem` unchanged per C3, so the key matches.)

Rationale per cell:

| injection | turn outcome | mark action | why |
|---|---|---|---|
| full | success, any freshness | set → maxInjectedTs | session now holds everything up to the mark (establishes or "resets" it upward — the ticket's reset semantics) |
| delta | success, resumed | set → maxInjectedTs | session extended by exactly the delta |
| delta | success, ran fresh | **clear** | session saw only the delta; next turn must go full (ticket's degradation intent, shifted one turn — see ⚠) |
| any | error / aborted / outage-queued | none | session absorption unknown or absent; a stale-low mark only over-includes next turn (duplication, never a gap) |

Ordering note: `finalizeSpawnResult`'s `sessionStore.set()` is fire-and-forget (agent-manager.ts:1895 — not awaited), so on a thread's *first* turn the mark write can race the row upsert. No-upsert semantics make both orders benign: mark-first matches nothing (next turn full again, converges after turn 2); set-first persists the mark. Documented, accepted.

### 5. The covering invariant (why this is correct)

**Invariant:** for every agent+thread, (messages in the agent's session) ∪ (messages injected this turn) ⊇ (all thread messages up to the current mark ∪ delta), because the mark only advances to the max ts of messages *actually injected into a successful turn*, and only when that turn's session absorbed them (resumed, or full-into-fresh).

Consequences checked against real timelines:
- **Round-1 reachability (C3):** a reactor was by C1/C2 not dispatched for the triggering human message, so its mark (if any) was set by a turn that preceded that message, or by a *later* trigger whose injection — by induction on the invariant — already covered it. Either way the human message is in session ∪ delta. When the reactor has no session/mark, full injection carries it directly. The dispatcher comment at 995–997 ("remains available via the re-fetched transcript") is updated to state the generalized guarantee.
- **Pre-lock staleness:** a second trigger reads the mark while the first turn is in flight; its delta over-includes the first turn's window. Duplication of one window, never a gap; the per-thread lock serializes the actual sessions.
- **Concurrent fetch races:** a message that slips into a fetch mid-flight is either injected (and covered by the mark advance) or not fetched (ts > everything injected ⇒ > mark ⇒ next delta). No gap.
- **Truncation gap:** a >100-message delta (or today's >105 full truncation) drops the middle; the mark still advances over the gap. This is exactly today's information loss, accepted identically.
- **Mark regression is benign, not prevented:** "only advances" is the invariant's argument, not a write-side enforcement — a plain `$set` permits a late-ordered write to regress the mark. Any written value was covered by its turn's session, so regression errs toward duplication, never gaps. The plan may substitute numeric `$max` enforcement if preferred (note: ts is a decimal *string*; `$max` needs numeric handling).
- **Compaction interaction (named deliberately):** today's full re-injection incidentally masks compaction's loss of old thread history; post-delta, a compacted session's older thread content survives only via the compaction summary. That is the design intent — trust session continuity — not an oversight.

### 6. Degradation paths — exhaustive

| path | what happens | outcome |
|---|---|---|
| no session doc / doc TTL'd (7d idle) | rule 1 fails → full injection; mark established on success | ticket's "identical lifecycles" — mark died with the doc |
| gemini free-tier 1d retention / openai 30d expiry / handle deleted | dispatcher predicted resume → delta; `isStaleServerHandleError` self-heal retries fresh with the same shaped prompt → `resumedSession: false` → mark cleared → **next** turn full | one degraded turn, then heal (⚠ refinement of the ticket sketch — same-turn full re-injection is impossible without re-shaping) |
| KPR-351 contender adoption inside self-heal | adopted handle ⇒ `resumedSession: true` ⇒ mark advances; the adopted session belongs to a queue-predecessor on the *same thread* whose own injections satisfied the invariant | correct, no special case |
| auth-rebuild resume retry | same as self-heal fresh: clear → next-turn full | |
| provider handoff (agent's `model` changed) | rule 2 fails at injection time → full injection pairs with the guard's fresh run + handoff notice | correct same-turn |
| handoff race (stored tag stale pre-lock, KPR-313 ⚠A9 adopt branch) | injection was full (rule 2 saw mismatch); turn adopts predecessor's switched session → full-into-resumed: one duplication, mark set correctly | benign |
| engine restart | in-memory rosters/trackers reset (existing behavior); `sessions` + mark persist in Mongo; Claude/Lane A resume across restarts | delta stays valid — **no restart special-casing needed**, verified against store schema |
| mark ahead of fetched history (deleted messages, 200-cap horizon) | delta empty → context segment dropped; terminal slot still carries the trigger/reply | safe |
| outage replay (KPR-307) | replay stamps `meta.targetAgentId`, so `resolveAgents` step 0 pins the agent and skips `resolveConferenceAgents` — no re-injection, no mark bookkeeping; the replayed turn resumes the session and absorbs the enqueue-time injected text; failed turns never advanced the mark, so the next live conference turn over-includes | over-inclusion only |
| reflection turns | never conference-injected; mark untouched | correct — reflection shows the session nothing new |
| codex | rule 1 always fails (empty handle) | today's behavior, by design (non-goal) |

### 7. Multi-provider summary

- **claude, kimi, deepseek, grok (client-transcript):** resumable handle persisted → delta eligible. Grok's cold-vendor-cache caveat is a latency/cost issue, not a context-loss issue (client replays the transcript, injected contexts included).
- **openai, gemini (server-resumable):** delta eligible; expiry handled by the self-heal → clear → heal-next-turn chain.
- **codex (stateless-replay):** full injection always (non-goal).
- No provider adapter, `SESSION_SEMANTICS`, or `docs/providers.md` parity-row change — the delta/full choice is a prompt-assembly concern keyed off already-exported surfaces (`getSessionStore`, `providerFor`, `persistsResumableHandle` via `normalizeRef`). *(Plan should double-check `docs/providers.md` needs no row edit since no provider behavior changes; if a reviewer disagrees, a one-line note in the matrix's session column is the fix.)*

### 8. Canon compliance (C1–C6)

- **C1/C2:** untouched — tracker writes/shape/TTL unchanged; delta injection reads nothing from the tracker.
- **C3:** terminal-slot contract byte-identical (both branches of `newMessageSegment` untouched; `originalItem` still dispatched; `meta.conferenceRound` untouched for KPR-389). The *rationale comment* about human-message reachability is updated per §5/§6 — an explicit generalization, not a contradiction: the guarantee strengthens from "in the re-fetched transcript" to "in session ∪ injected context" (§5 invariant).
- **C4:** preamble (with the exact "No response needed." wording) injected on every turn including delta turns — the escape and `NON_RESPONSE_PATTERNS` matching are untouched.
- **C5:** N/A (no selection-logic change).
- **C6:** the round-0 byte-exact pin covers the full/empty-history path and stays green with zero edits (empty history + no mark → full mode → identical join). The delta shape gets its own new pin; KPR-389 remains the only ticket that deliberately edits the existing one.

## Integration points

- `src/agents/session-store.ts` — `SessionDoc.meetingLastSeenTs`, `StoredSessionRef.meetingLastSeenTs`, `setMeetingMark`, `clearMeetingMark`.
- `src/agents/agent-manager.ts` — `TurnResult.resumedSession`; `spawnTurn` finalized-attempt tracking; `finalizeSpawnResult` passthrough. (`getSessionStore()` and `providerFor()` already public — no new surface.)
- `src/agents/agent-runner.ts` — `RunResult.resumedSession?: boolean` (type only, for `convertTurnResult`).
- `src/channels/slack-adapter.ts` — `ThreadMessage.ts: string`.
- `src/channels/dispatcher.ts` — `ResolvedAgent.{injectionMode, injectionHighWaterTs}`, per-agent `buildConferenceContext` used by `resolveConferenceAgents` + `triggerConferenceReactions`, delta formatter, post-turn mark bookkeeping in `dispatchToAgent`, C3 comment update.

## Test plan

Unit tests beside source (repo convention). New pins get the negative-verify treatment (revert the source hunk, confirm the test fails on pre-fix code).

**`src/channels/dispatcher-conference.test.ts`** (mock `agentManager` gains `getSessionStore().get`, `providerFor`; `fetchThreadHistory` mock gains `ts` values):
1. Delta injection: session ref with handle + matching provider + mark ⇒ prompt contains only `ts > mark` messages; **byte-exact delta-shape pin** (sibling of the C6 pin).
2. Full injection on each read-side miss: no doc; empty-handle (codex-shaped) ref; provider mismatch (`providerFor` ≠ `ref.provider`); missing mark. Existing round-0 byte pin passes **unmodified** (C6 regression guard).
3. Mark advance: `setMeetingMark` called with max injected ts (incl. trigger `slackTs` max-in on round-0 — both injection modes) on success; also on a suppressed non-response turn; **not** called on error, aborted, or outage-queued turns.
4. Mark clear: delta-injected turn with `resumedSession: false` ⇒ `clearMeetingMark`, no set.
5. C3 interaction: round-1 reactor with mark predating the human message ⇒ delta contains the human message; reactor with no session ⇒ full transcript. Existing round-1 framing test passes unmodified (delta header must not match `[New message]:\n`).
6. Empty delta ⇒ context segment dropped (join degenerates to the pinned empty-history shape).

**`src/agents/session-store.test.ts`:**
7. `setMeetingMark` on a missing row creates nothing (no-upsert pin); on an existing row sets the field without touching `updatedAt`.
8. `clearMeetingMark` unsets; `get()` surfaces the mark; scrub branch returns no mark.

**`src/agents/agent-manager.test.ts`:**
9. `resumedSession` truth table: true on happy-path resume; false on first turn; false after auth-rebuild retry; false after self-heal fresh retry; true after self-heal contender adoption.

## Open questions

None blocking — the Gate 1 delegation covers the design space; refinements are ⚠-flagged in Key Points and §6.
