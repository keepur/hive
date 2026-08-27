# KPR-402 — Deadline abort while circuit is closed silently drops the work item — no retry, no user notice

Child of hotfix epic **KPR-397** (last child). Status: **spec draft** (Gate 1 delegated).

> **Decision Register canon consumed:** D1 (binary-OR progress predicate,
> fail-closed — consumed via `classifyTurnResult`'s D6 kinds, never
> re-implemented), D3 (with-progress deadline + open breaker → never
> outage_queue for the ORIGINAL turn — preserved verbatim; see §Design.6 for
> the compatibility argument), D6 (kpr-398-spec §Design.4 contract table — the
> arm's progress discrimination IS the table's kind split), D8 (accepted
> residuals), **D19 + coherence watch-item** (no third `enqueueOrigin` class,
> no new sparse immutable outage-doc field — this design deliberately avoids
> triggering either; §Design.2), D25 (the `isClaudeResumeLoadError` refinement
> duty lands in this child's live work if a real rejection string surfaces),
> **D26** (KPR-399 live gate: deadline aborts leave zero dangling `tool_use`,
> mid-tool resume is clean — re-dispatch may be aggressive about resuming, no
> transcript-repair precondition), D30–D32 (outage-doc `deadlineMs`,
> `turnDeadlineUpperBoundMs` public, tick order sweep→expire→drain — all
> untouched), D33 (no CI on this child PR — deliver-lane note), D34 (no schema
> change here ⇒ no byte-compat proof owed). Cross-epic C3 (Lane B keeps
> `!result.aborted` byte-for-byte — re-dispatch is client-transcript-only by
> construction). KPR-399 §Edge-7 (contender pre-lock stale read — accepted,
> not strengthened) and §Edge-12 (replay-prompt duplication — **this spec's
> surface**, resolved in §Design.4).

## TL;DR

**What the user sees today (Q1 trace, verified on branch @ f26a2c5 and
test-pinned):** a user-initiated turn that hits the wall-clock deadline while
the provider circuit is CLOSED is *not* literally silent post-siblings — the
dispatcher falls through every outage gate (`maybeHandlePostTurnOutage`
requires an OPEN breaker, `dispatcher.ts:578`; the replay-real-failure gate
requires `runResult.error`, which a Claude-lane deadline abort never sets) and
delivers `finalMessage || "_No response._"` as if the turn completed
(`dispatcher.ts:318`; pinned at `dispatcher.test.ts:1292-1301` — *"'_No
response._' as today"*). The incident's tool-heavy shape (`text: ""`) yields a
bare **"_No response._"** with no hint of a timeout; a text-bearing abort
delivers an **unmarked mid-thought fragment** presented as the answer. Either
way the request is dead: no retry, no honest notice, and a replayed outage doc
in this shape is released **`done` — permanently half-answered** (the
`!runResult.error` success-bookkeeping arm). KPR-399 made the partial session
resumable; nothing *uses* that resumability automatically, and nothing tells
the user they could.

**The fix — a dispatcher deadline-continuation arm, no queue, no schema:**
after the existing outage gates, a turn with `timedOut && aborted` (the
Claude-lane/Lane-A deadline shape, D6 rows 1-2) is intercepted. **With
progress** (`classifyTurnResult` kind `turn-deadline`): deliver a brief honest
notice on notify-policy channels ("ran out of time — picking up where I left
off"), then **re-dispatch in-process** a synthetic continuation item (same
`id`, same thread, `meta.deadlineRetry: n`, `meta.targetAgentId` pinned,
dedup-bypassed) whose text is a continuation wrap — the KPR-399-persisted
session resumes automatically through the unchanged
`runWorkItemTurn → sessionStore.get` path, and the resumed turn gets a full
fresh deadline. Bounded chain: **`MAX_DEADLINE_CONTINUATIONS = 2`** (≤3
deadlines of wall clock), then an honest terminal notice that names the
manual escape hatch ("say 'continue'" — the session row persists either way).
**Zero progress** (kind `timeout`, hard): notice only, no re-dispatch —
nothing was persisted to resume (D1 fail-closed), and repeat hangs are the
breaker's territory by design. Cron keeps re-fire-at-next-match (policy
`skip` — arm fully inert). Outage-replay items route through the existing
§5-2g attempts machinery (zero-progress) or release `done` + join the chain
(with-progress). The outage queue is **not** reused for closed-circuit
re-dispatch — no third `enqueueOrigin` class, no D19 migration, no
schema-versioning trigger.

## Key Points

- **Q1 trace, post-sibling (the residual this spec fixes).** Path for a
  closed-circuit deadline abort of a Slack user turn: `runWorkItemTurn` →
  manager records `turn-deadline`/`timeout` on the breaker (inconclusive /
  streak+1) → KPR-399 persists the session (with-progress) →
  `convertTurnResult` (`error: undefined` — abort closes the iterator, never
  throws) → `maybeHandlePostTurnOutage` returns false (breaker not open) →
  replay-error gate inert (`error` unset) → **delivery of
  `text || "_No response._"`** → `recordTurnSuccess` (releases a replay doc
  `done`). KPR-401 added `aborted`/`timedOut` to the "Work item dispatched"
  log line — the *operator* can now see it; the *user* still cannot. The
  ticket's recorded literal silence (2026-08-26 02:28Z) is not reproducible
  from this branch's delivery path (the "_No response._" write is
  unconditional on Slack — `formatResponse("")` at
  `response-formatter.ts:24-25`); whether the incident's missing message was a
  delivery failure or observational, the post-sibling defect stands as: **a
  bare non-answer or an unmarked fragment, no timeout explanation, no
  continuation, replay docs terminally half-done.**
- **Re-dispatch mechanism ruling: in-process, not queue, not a third path.**
  (a) The outage queue's whole vocabulary is outage replay — docs enter only
  under breaker-open, notices say "outage", `claimNext`'s class order exists
  to feed the half-open probe, +15s/leg tick latency buys nothing here. (b) A
  third `enqueueOrigin` class trips D19's lexicographic constraint AND the
  coherence watch-item (a third sparse immutable field ⇒ schema-versioning
  discussion) — a schema debate is disproportionate for a hotfix that needs
  **no durability**: the resumable state already lives durably in `sessions`
  (KPR-399); a process crash between abort and continuation loses only the
  in-flight continuation, the same accepted class as crash-loses-in-flight-
  turn, with a soft landing (the user's next message resumes the persisted
  partial work). (c) In-process is immediate — continuation starts as soon as
  the notice is delivered.
- **Loop safety is a counter, and every exit is honest.** `meta.deadlineRetry`
  strictly increments on each synthetic re-dispatch and is never reset; the
  arm refuses at the cap with a terminal notice. Every leg terminates in
  exactly one of: normal delivery (success), the normal error path
  (non-deadline fault — the arm only matches `timedOut && aborted`), the
  outage fast-fail path (breaker opened mid-chain: the *continuation* enqueues
  as an ordinary `"fast-fail"` doc — existing class, D19 untouched — and the
  chain position survives the queue round-trip because `meta` serializes
  verbatim into `workItem`), notice-only (zero progress / cap), or the next
  leg (counter+1). The breaker never sees the arm: `turn-deadline` is
  inconclusive (D6), the manager's record-once already happened before the
  dispatcher runs, and a continuation leg's faults classify like any other
  turn's.
- **Edge-12 ruling — the continuation wrap is safe under resume AND fresh.**
  The re-dispatched text is a deterministic note + the original request:
  *"your previous turn hit its time limit mid-work; your session may already
  contain this request and your partial progress — continue, do not redo
  completed work or re-run side-effectful actions; if the thread has moved on,
  reply 'No response needed.'"* followed by the original text for reference.
  D26 says the resume itself is clean and aggressive-safe; the embedded
  original is the belt for the two fresh-fallback shapes (fire-and-forget
  persist write racing the re-dispatch read; KPR-399 §Edge-7 contender
  overwrite) — without it, a fresh continuation would receive a bare
  "continue" pointing at nothing. The `NON_RESPONSE_PATTERNS` suppression
  path gives the model an honest no-op exit when the thread has moved on.
- **Channel policy mirrors KPR-307 exactly, via the same `policyFor`.**
  `notify` (slack/sms/imessage/app/ws/team-DM): notice + re-dispatch. `silent`
  (callback/event/team one-shots): re-dispatch without notices — work
  preserved, nobody spammed, cap exhaustion warn-logged (KPR-307 queued these
  silently; same posture). `skip` (cron `sched:`): arm fully inert — ticket
  ruling, re-fires at next match, existing delivery behavior unchanged.
  Because the synthetic item keeps the **original id**, `policyFor` classifies
  the continuation identically to its origin — no policy plumbing.
- **Notice cadence: two per chain, maximum.** First abort → one "picking up
  where I left off" notice; intermediate legs continue silently; cap → one
  terminal notice. No episode tracker involvement (deadline aborts are
  discrete per-thread events, not provider episodes). Notices are plain-text
  `WorkResult`s with `error` unset, delivered via the existing
  `deliverOutageNotice` (SMS/iMessage actually deliver; retry-queue on
  failure) — zero adapter changes.
- **Replay-item integration completes the §5-2g story.** A replayed doc that
  deadline-burns with progress, breaker closed: doc released `done` (its
  continuation is now in-process; `lastError` notes it) — strictly better
  than today's `done`-with-"_No response._". Zero-progress replay burn:
  routed through `resolveReplayRealFailure` — a real breaker-closed failed
  attempt (attempts+1, pending again or terminal `failed` with the existing
  terminal notice). No new store surface.
- ⚠ **Delegated:** the cap value (2), notice wording, zero-progress
  no-re-dispatch, partial-text withholding, module placement — decided here,
  flagged for the register. No open product questions; one live-verification
  item gates ready-to-merge (not spec-ready), §Tests.

## Problem (post-sibling residual)

The five siblings each fixed their lane: KPR-398 stopped deadline aborts from
tripping the breaker; KPR-401 made them visible in accounting; KPR-400/403
fixed the queue's probe ordering and recovery; KPR-399 made the aborted turn's
partial work *resumable*. None of them changed what the requesting human
receives, because the closed-circuit path never enters any of that machinery:

- `src/channels/dispatcher.ts:565-588` (`maybeHandlePostTurnOutage`) — exits
  at `snapshot.state !== "open"` (L578). Closed circuit ⇒ no queue, no notice.
- `dispatcher.ts:300` — the replay-failure gate needs `runResult.error`; a
  Claude-lane deadline abort carries `error: undefined`
  (`agent-runner.ts:2276-2283` — abort *closes* the iterator).
- `dispatcher.ts:316-326` — delivery: `runResult.text || "_No response._"`,
  `error` unset. The incident shape (`toolCalls=46, text=""`) delivers a bare
  "_No response._"; a streamed-prose abort delivers a mid-thought fragment
  with no marker. Pinned today at `dispatcher.test.ts:1292-1301` (zero-
  progress, closed) and `:1304-1316` (with-progress, open — D3 legacy path,
  same bare delivery).
- `dispatcher.ts:360-362` — `!runResult.error` ⇒ `recordTurnSuccess`: a
  replayed outage doc in this shape is released **`done`** — the queued
  promise ("I'll answer when service is back") resolves to "_No response._"
  forever (kpr-400-spec §Design "completes-with-delivery" documented this for
  the open-breaker probe; it is equally true for any closed-circuit replay
  burn).
- KPR-399's contract (its Key Points, "KPR-402's surface, stated"): any
  re-entry whose store read happens post-finalize resumes the aborted
  session. Today the only such re-entry is the *user manually sending another
  message* — the engine never initiates one, and never tells the user that
  "continue" would work.

Net: the agent burns its full deadline doing real work, saves that work
(KPR-399), then answers "_No response._" and forgets the task. A task needing
more than one `timeoutMs` of wall clock still **cannot complete** without a
human manually nudging every leg — and nothing tells the human to nudge.

## Goals

1. **G1 — never neither output nor notice:** every user-initiated
   (notify-policy) turn that deadline-aborts with the circuit closed delivers
   an honest, human-readable notice to the originating thread — never a bare
   "_No response._", never an unmarked fragment.
2. **G2 — automatic continuation:** a with-progress deadline abort re-
   dispatches in-process with session resume (KPR-399 handle, D26 semantics);
   the resumed leg gets a full fresh deadline; a multi-deadline task completes
   without human nudging, up to the chain cap.
3. **G3 — provable termination:** the chain is bounded by a strictly-
   increasing counter; the cap exhausts into an honest terminal notice that
   names the manual "continue" escape hatch; no path re-enters the arm without
   incrementing the counter.
4. **G4 — breaker/queue canon intact:** the breaker sees nothing new (D6
   rows byte-identical; record-once untouched); outage_queue gains no writes,
   no classes, no fields (D19 + watch-item untouched); D3's operative content
   (the original turn is never enqueued as an outage doc) preserved.
5. **G5 — channel carve-outs per KPR-307:** cron re-fires (skip), one-shots
   continue silently (silent), voice/reflection out of scope with rationale.
6. **G6 — replay coherence:** a replayed doc that deadline-burns resolves its
   queue slot on every path (done + chain, or attempts+1) — never stranded,
   never silently half-answered.

## Non-Goals

- **No outage-queue reuse for closed-circuit re-dispatch** — no third
  `enqueueOrigin` class, no new doc field, no schema versioning (D19 +
  watch-item; ruling in Key Points). The queue remains outage-replay-only.
- **No Lane B continuation (C3).** Lane B deadline expiries carry the
  `error_turn_deadline` sentinel with `aborted: false` — the arm's
  `timedOut && aborted` gate never matches them, and they already surface as
  a visible (if ugly) error via `formatError`. Lane B has no abort-persisted
  partial state to resume (KPR-399 non-goal); giving Lane B deadline UX
  parity goes through the KPR-385 scaffold, not here.
- **No voice changes.** Voice turns bypass `dispatch()` (`routeVoiceTurn`);
  a 300s deadline inside a live Vapi HTTP exchange is moot (the call transport
  gives up long before), and the KPR-307 spoken-outage precedent covers the
  fast-fail case. A voice deadline abort still returns an empty completion —
  pre-existing, follow-up if it ever surfaces in practice.
- **No reflection changes.** Reflection turns are engine-internal and silent
  by nature; a timed-out reflection simply ends (and post-KPR-399 even
  captures partial state). No notice, no retry.
- **No operator-abort changes.** The arm gates on `timedOut === true`; an
  operator stop (`aborted` only) keeps today's behavior — the human who
  stopped it needs no notice that it stopped.
- **No manager/runner/store/breaker/classifier edits.** This is a
  dispatcher-layer change plus notice templates. `agent-manager.ts`,
  `agent-runner.ts`, `provider-circuit-breaker.ts`,
  `error-classification.ts`, `outage-queue-store.ts`,
  `outage-replay-processor.ts`, `session-store.ts`: zero diffs.
- **No config knob.** The cap is an exported constant (simplicity posture —
  no preemptive levers); `outageQueue.enabled: false` does NOT disable the
  arm (it is not outage machinery; it needs no store). ⚠A6.
- **No unconditional post-lock session re-resolve** (KPR-399 §Edge-7's
  offered follow-up) — the continuation wrap's embedded original text makes
  the stale-read worst case recoverable; the stronger guarantee stays YAGNI.

## Design

### 1. Detection — the arm's gate (dispatcher, after the outage gates)

A new private method, called from BOTH near-duplicate dispatch bodies
(`dispatch()` after L303, `dispatchToAgent()` after L1058 — same placement
discipline as `maybeHandlePostTurnOutage`):

```ts
// KPR-402: closed-circuit deadline-abort interception. Runs AFTER
// maybeHandlePostTurnOutage (breaker-open hard faults keep the outage path —
// ★ rows unchanged) and after the replay-error gate (disjoint: a Claude-lane
// deadline abort never sets error). Matches the D6 rows 1-2 shape only —
// Lane B's sentinel (aborted: false) and operator aborts (no timedOut) never
// enter. Returns true when the turn was fully handled (notice and/or
// re-dispatch and/or replay-doc resolution); false = fall through to normal
// delivery.
private async maybeHandleDeadlineAbort(
  item: WorkItem, agentId: string,
  adapter: ChannelAdapter | undefined, runResult: RunResult,
): Promise<boolean> {
  if (runResult.timedOut !== true || runResult.aborted !== true) return false;
  const policy = policyFor(item);
  if (policy === "skip") return false; // cron: re-fires at next match — fully inert (ticket ruling)
  const withProgress =
    classifyTurnResult(runResult).kind === "turn-deadline"; // D6 single source of truth
  ...
}
```

Progress discrimination deliberately routes through `classifyTurnResult`
(full `RunResult` — the KPR-398 call-site convention), never a re-implemented
predicate: the D1/D6 split has exactly one home.

### 2. With-progress: notice + in-process continuation

Ordered steps (notify policy; silent policy skips both notices):

1. **Replay-doc resolution** (if `item.meta?.outageReplay`): release the doc
   `done` with `lastError: "deadline abort — continuation dispatched
   in-process (KPR-402)"`. The queue slot resolves; the chain owns the turn
   from here. (Accepted residual ⚠A5: a crash mid-chain loses the
   continuation — but the session row survives, so the thread's next message
   resumes the partial work; strictly better than today's `done` +
   "_No response._".)
2. **Notice** — only when this is the chain's FIRST abort
   (`item.meta?.deadlineRetry` absent): `deliverOutageNotice(item, agentId,
   adapter, deadlineNoticeFor(item.source.kind))`. Draft wording (⚠A2,
   KPR-307 delegation style — exported constants, tests pin them):
   - default: `⏳ That's taking longer than my per-turn time limit — I've
     saved my progress and I'm picking up where I left off.`
   - SMS/iMessage: `Still working on your request — it needs more time than
     one pass allows. I'm continuing now.`
3. **Cap check**: `const n = Number(item.meta?.deadlineRetry ?? 0)`. If
   `n >= MAX_DEADLINE_CONTINUATIONS` (**= 2**, exported constant, ⚠A1):
   deliver the terminal notice (notify policy only) and stop —
   - default: `⏳ I ran out of time on this several times over. I've kept all
     my partial work — say "continue" and I'll pick it up again.`
   - SMS/iMessage: `I couldn't finish your request in the time allowed. Reply
     "continue" to have me keep going.`
   The manual escape hatch is real: the session row is persisted (KPR-399),
   so the user's next message resumes the partial work with zero engine help.
   Silent policy at cap: warn log only.
4. **Re-dispatch** (below cap): build the continuation item and fire it
   **after** the notice delivery completed (ordering: the notice's adapter
   round-trip also puts real time between finalize's fire-and-forget session
   write and the continuation's store read — belt, ⚠A4):

```ts
const retryItem: WorkItem = {
  ...item,
  text: deadlineContinuationWrap(originalTextOf(item), n + 1, MAX_DEADLINE_CONTINUATIONS + 1),
  meta: { ...item.meta, targetAgentId: agentId, deadlineRetry: n + 1 },
};
void this.dispatch(retryItem).catch((err) =>
  log.error("Deadline continuation dispatch failed", { agentId, error: String(err) }));
```

- **Same `id`** — dedup gains a bypass mirroring `outageReplay`
  (`dispatch()` step 0: `&& !item.meta?.deadlineRetry`), and `policyFor`
  keeps classifying by the original id's prefix (a `callback:` one-shot's
  continuation stays `silent` — no policy plumbing).
- **`targetAgentId` pinned** — `resolveAgents` step 0 routes it exactly like
  a replay; no re-resolution drift.
- **Fire-and-forget** — awaiting would hold the caller (an adapter handler or
  the replay drain) for another full deadline. `onProcessingEnd` fires for
  the aborted leg; the continuation's own dispatch restarts the typing
  indicator. The replay drain's `statusOf` re-read sees `done` (step 1) and
  continues draining — never the "no outcome recorded" defensive revert.
- **`originalTextOf(item)`**: for a first abort, `item.text`; for a
  continuation leg aborting again, the original is recovered from the wrap
  deterministically (the wrap ends with a fixed delimiter line followed by
  the original — or, simpler and preferred at implement time: carry
  `meta.deadlineOriginalText` on the first synthetic item and reuse it;
  ⚠ implementation detail delegated to the plan, behavior pinned by T9).

**Resume is emergent, zero new code** (KPR-399 §Design.4): the continuation
re-enters `dispatch()` → `runWorkItemTurn` → `sessionStore.get` — a
post-finalize read on a with-progress client-transcript abort returns the
aborted handle (the KPR-399 contract this ticket was told to rely on), and the
resumed leg's runner arms a **fresh full deadline**. If the resume is rejected
(never-flushed id), the manager's KPR-399 self-heal arm retries fresh — and
D25 assigns any newly-observed rejection string's matcher refinement to this
child's live work.

### 3. Zero-progress: notice only (⚠A3)

`withProgress === false` (D6 row 2 — hard `timeout`, the hang signature):

- **Non-replay:** deliver `deadlineZeroProgressNoticeFor(kind)` (notify
  policy) and return true. Draft: `⚠️ I couldn't get started on that within
  my time limit — please send it again.` / SMS: `Your request timed out
  before I could start. Please re-send it.` No re-dispatch: there is no
  persisted session (D1 fail-closed persist gate), a fresh restart re-runs
  the full turn against a provider that just sat silent for the entire
  deadline, and the hang class is the breaker's designed territory — three
  consecutive opens the circuit and the KPR-307 queue+notice machinery takes
  over with its own honest story. Two overlapping retry mechanisms for the
  same hang would fight (double turns during a developing outage).
- **Replay:** route through the existing
  `resolveReplayRealFailure(item, agentId, adapter, "turn deadline exceeded
  (zero progress)")` — this IS §5-2g's "real failure while breaker closed":
  attempts+1, back to pending (silent — the enqueue-time outage notice's
  promise still stands) or terminal `failed` with the existing terminal
  notice. No separate deadline notice (no double-noticing one thread).

### 4. The continuation wrap (Edge-12 resolution)

`deadlineContinuationWrap(originalText, leg, totalLegs)` — deterministic, no
timestamps, exported beside the KPR-307 templates:

```
[Continuation ${leg}/${totalLegs}: your previous turn on this request hit its
wall-clock time limit and was cut off mid-work. Your session may already
contain this request and your partial progress — continue from where you left
off; do NOT redo completed work or re-run side-effectful actions that already
ran. If the thread has moved on and no answer is needed, reply "No response
needed." The original request follows for reference:]

${originalText}
```

Why this shape (vs "continue" alone, vs re-wrapped original alone):

- **D26 makes resume the normal case** — the transcript holds the original
  prompt and all partial tool work; the note's do-not-redo instruction is the
  guard KPR-398's Finding-4 hazard actually needs (side effects are visible
  *in the transcript*, so the model can honor it — unlike a blind replay).
- **The embedded original is the fresh-fallback belt** for the two shapes
  where resume doesn't materialize: (a) the fire-and-forget persist write
  losing the race to the continuation's store read (⚠A4 — narrowed but not
  closed by the notice round-trip ordering), (b) a KPR-399 §Edge-7 contender
  having overwritten the handle with a fresh session. A bare "continue" into
  a fresh session is a garbage turn; note+original degrades to roughly a
  first attempt. Safe under both — the same both-ways trick as `replayWrap`.
- **The "No response needed" clause** wires the continuation into the
  existing `NON_RESPONSE_PATTERNS` suppression: if a contender's interleaved
  user message said "never mind", the model has a clean no-op exit and the
  thread gets no zombie answer.

**Outage-replay's own Edge-12 residual** (replay re-sends the `replayWrap`-ed
original into a resumed transcript that already contains it — KPR-399
§Edge-12): resolved with one static sentence appended to `replayWrap`'s note
(both policies): `If your session already contains this message and partial
work on it, continue from where you left off instead of restarting.` Safe when
no session resumes (the normal fast-fail-class case — nothing to falsely
reference), materially better when one does (post-turn-fault docs post-399).
Clean-wrap-sized; no processor logic, no store reads. ⚠A7.

### 5. Loop-safety invariants (G3/Q6, stated for the record)

1. **Termination:** each re-dispatch carries `deadlineRetry = n+1`; nothing
   decrements or strips it (the meta spread preserves it through the outage
   queue's `workItem` serialization if a continuation gets enqueued
   mid-outage, so the cap survives the round-trip). Legs per chain ≤
   `MAX_DEADLINE_CONTINUATIONS + 1`. Wall clock per chain ≤ (cap+1) ×
   `turnDeadlineUpperBoundMs` + notice latencies.
2. **Breaker invisibility of the arm itself:** the aborted leg's breaker
   record (inconclusive `turn-deadline`) happened in the manager before the
   dispatcher saw the result (record-once, `agent-manager.ts:1175`); the arm
   adds no record site.
3. **Faulting legs classify normally:** a continuation that hard-faults
   (auth/5xx/rate-limit) doesn't match the arm (`error` set, no
   `timedOut && aborted`) → normal error delivery, chain ends. A continuation
   that zero-progress-hangs → hard `timeout`, streak+1, notice-only exit —
   repeated hangs open the circuit and hand over to the outage machinery.
4. **Breaker-open at re-dispatch:** the continuation fast-fails
   (`ProviderCircuitOpenError`) → `handleTurnFailure` → existing outage path
   enqueues it `"fast-fail"` (existing class — D19 untouched) with the
   standard outage notice; replay-after-recovery resumes the persisted
   session and keeps the chain counter. No special casing.
5. **Concurrency:** the aborted leg's lock is released before the arm runs
   (dispatch has returned from `runWorkItemTurn`); the continuation and any
   contender serialize on the per-thread lock; the budget cost is one spawn
   at a time (chain legs are sequential). Contender-wins ordering is
   accepted: the continuation runs after, sees the full transcript (or, in
   the §Edge-7 stale case, runs effectively fresh with the embedded
   original), and can self-suppress.

### 6. D3 compatibility (with-progress + breaker OPEN)

The arm sits after `maybeHandlePostTurnOutage`, so the ★-pinned open-breaker
rows keep their routing: zero-progress+open → outage queue (unchanged);
with-progress+open → the gate declines (`turn-deadline` ∉ HARD_FAULT_KINDS)
and the turn now falls into this arm instead of the bare legacy delivery.
D3's operative ruling — *the original partially-executed turn must never be
enqueued for blind replay* — is preserved: the original is still never
enqueued; what may reach the queue is the **continuation**, a new
resume-based turn whose wrap explicitly forbids redoing performed work, i.e.
the precise mechanism that discharges Finding-4's hazard rather than
violating it. Existing row `dispatcher.test.ts:1304` migrates (D28
fixture-swap precedent): still asserts "never queued directly by the gate",
now asserts notice + continuation instead of bare "_No response._". ⚠A8
flags this as the one behavior change outside the ticket's literal
closed-circuit wording — taken because leaving a known bare-non-answer path
in the ticket that exists to abolish bare non-answers would be perverse.

## Integration points

| Surface | File | Change |
|---|---|---|
| Deadline arm | `src/channels/dispatcher.ts` | new `maybeHandleDeadlineAbort` called from both dispatch bodies (after outage + replay-error gates); dedup bypass extended to `meta.deadlineRetry`; no other flow changes |
| Templates + wrap + cap | `src/channels/deadline-continuation.ts` (new, small — placement ⚠ plan may fold into `outage-notices.ts` neighbors) | `MAX_DEADLINE_CONTINUATIONS`, `deadlineNoticeFor` / `deadlineZeroProgressNoticeFor` / terminal variants, `deadlineContinuationWrap` |
| replayWrap sentence | `src/outage/outage-notices.ts` | one static resume-aware sentence (§Design.4, ⚠A7); constants re-pinned |
| Manager / runner / breaker / classifier / stores / processor | — | **zero diffs** (Non-Goals; classifier consumed read-only) |
| Session resume | — | emergent via existing `runWorkItemTurn → sessionStore.get` (KPR-399 contract) |
| KPR-399 D25 | live work | refine `isClaudeResumeLoadError` iff a real rejection string surfaces during V1 |
| Docs | `docs/providers.md` | ⚠A9 optional one-row caveat (continuation is client-transcript-lane only; Lane B deadline expiries surface as errors) — engine-internal per the KPR-398 A4 precedent, flagged for review |
| Tests | `dispatcher.test.ts` (+ new module's test) | §Tests; rows 1292/1304 migrate with D28 justification comments |

## Edge cases

1. **Incident shape** (46 tools, `text:""`, closed circuit, Slack): notice
   "picking up where I left off" replaces "_No response._"; continuation
   resumes the persisted session; a ≤3-deadline task completes; a longer one
   exhausts into the terminal notice naming "continue".
2. **Text-bearing with-progress abort:** the fragment is withheld (⚠A10 —
   it lives in the transcript; the continuation delivers the finished
   answer); the notice is the only delivery for that leg.
3. **Zero-progress, closed, user turn:** honest "couldn't get started"
   notice, no retry; a developing hang episode escalates through the breaker
   to the outage machinery (designed hand-off, §Design.3).
4. **Cron deadline burn:** arm inert (`skip`); existing delivery to the
   agent channel and next-match re-fire unchanged (ticket ruling).
5. **Callback/event/team one-shot:** continuation without notices; cap
   exhaustion warn-logged; partial work persists in the session for any later
   human interaction on the thread.
6. **Contender message lands between abort and continuation:** contender
   wins the lock ordering it won; continuation runs after with full
   transcript context and may self-suppress ("No response needed"). §Edge-7
   stale-read worst case: continuation runs effectively fresh but carries the
   original request — degraded to a first attempt, never garbage. Accepted
   (⚠A4).
7. **Replayed outage doc deadline-burns with progress (closed):** doc
   `done` + noted; notice + chain (its `deadlineRetry` starts at the
   original's serialized value, usually absent → first-notice fires). Drain
   continues (status re-read sees `done`).
8. **Replayed doc, zero progress:** `resolveReplayRealFailure` — attempts+1
   toward the existing 3-attempt terminal `failed` + terminal notice. No
   deadline notice.
9. **Breaker opens mid-chain:** continuation fast-fails into the outage
   queue as `"fast-fail"` with the standard outage notice; the thread gets
   the deadline notice + the outage notice (two honest messages, distinct
   facts — accepted); replay-after-recovery resumes with counter intact. A
   twice-wrapped text (replayWrap ∘ continuationWrap) is verbose but
   coherent — the model sees both notes in order.
10. **Continuation hard-faults (non-deadline):** normal "Something went
    wrong" error path; chain ends; breaker records the real fault normally.
11. **Spawn budget saturated at re-dispatch:** `withSpawnTicket` throws →
    `handleTurnFailure` → honest error delivery; chain ends. (Chain legs are
    serial — steady-state budget cost is 1.)
12. **Operator abort** (`aborted` without `timedOut`): arm never matches;
    today's behavior byte-identical.
13. **Lane B deadline expiry:** `aborted: false` sentinel shape — arm never
    matches; the existing visible error surfacing stands (Non-Goals, C3).
14. **Lane A passthrough (kimi/deepseek/grok):** rides the arm identically —
    same `timedOut && aborted` runner shape, client-transcript persist,
    resume replays against a cold vendor cache (documented parity caveat,
    unchanged).
15. **`outageQueue.enabled: false`:** `this.outage` unset — replay-item
    branches unreachable (no replays exist); notice + continuation still work
    (`deliverOutageNotice` only needs an adapter). The arm is not outage
    machinery (⚠A6).

## Open assumptions (⚠ = delegated, decided here)

- ⚠ **A1 — cap = 2 continuations** (≤3 deadlines/chain), exported constant,
  no config knob. Terminal notice names the manual "continue" hatch, so the
  cap bounds *automation*, not *completability*. Non-blocking.
- ⚠ **A2 — notice/wrap wording** — structure decided, exact prose delegated
  (KPR-307 precedent); deterministic, pinned by tests. Non-blocking.
- ⚠ **A3 — zero-progress aborts get notice-only** (no fresh re-dispatch);
  rationale §Design.3 (hang class belongs to the breaker; no session to
  resume). Non-blocking.
- ⚠ **A4 — fire-and-forget persist vs continuation read race** accepted:
  narrowed by notice-first ordering, belted by the embedded original text;
  same residual class as every post-finalize reader since KPR-399.
  Non-blocking.
- ⚠ **A5 — replay docs release `done` before the in-process chain**; crash
  mid-chain loses only the continuation (session row survives — soft
  landing). Strictly better than today's `done`+"_No response._".
  Non-blocking.
- ⚠ **A6 — arm active regardless of `outageQueue.enabled`** (it is not
  outage machinery). Non-blocking.
- ⚠ **A7 — one resume-aware sentence added to `replayWrap`** (KPR-399
  §Edge-12 closure); static, safe both ways. If review rules it
  scope-creep, it detaches cleanly with the residual re-accepted as D8.
  Non-blocking.
- ⚠ **A8 — with-progress + OPEN breaker also takes the arm** (D3-compatible
  per §Design.6; row 1304 migrates under D28). The one deliberate step past
  the ticket's literal "while circuit is closed". Non-blocking, but the
  register should record it.
- ⚠ **A9 — `docs/providers.md` untouched** (engine-internal dispatch
  behavior; KPR-398 A4 precedent). One-row caveat if review wants it.
- ⚠ **A10 — partial fragments withheld on with-progress aborts** (the
  continuation delivers the finished answer; fragments are mid-thought
  noise). Non-blocking.

## Tests

### Unit (`src/channels/dispatcher.test.ts`, outage-interception + new
describe; `src/channels/deadline-continuation.test.ts` for templates)

| # | Row | Negative-verify |
|---|---|---|
| T1 | With-progress deadline abort, breaker closed, slack (notify): notice delivered (exact-text pin), **no** "_No response._", **no** queue write, second `dispatch` fired with same `id`, `meta.deadlineRetry: 1`, `meta.targetAgentId` pinned, text = wrap(note + original). | Revert the arm → bare "_No response._" delivery reappears (the exact 1292-shape) → T1 fails on pre-fix code. |
| T2 | Chain cap: item arriving with `deadlineRetry: 2` aborts with progress → terminal notice (exact-text pin), **no** further dispatch. | Drop the cap check → a third dispatch fires → row fails. |
| T3 | Zero-progress, closed, non-replay → zero-progress notice only; no re-dispatch; no queue write. | — (paired with T1's direction) |
| T4 | Cron (`sched:` id) deadline abort → arm inert: existing delivery unchanged, no notice, no re-dispatch. | — |
| T5 | Silent policy (`callback:` id), with-progress → re-dispatch fired, **zero** `deliver` calls; at cap → zero delivers, warn logged. | — |
| T6 | Replay item (`meta.outageReplay`), with-progress, closed → store `release(_, _, "done", …)` called, notice, re-dispatch; drain-visible status is terminal. | — |
| T7 | Replay item, zero-progress, closed → `recordFailedAttempt` path (attempts+1); no deadline notice; terminal at cap behaves per existing §5-2g pins. | — |
| T8 | Dedup bypass: a `deadlineRetry` item with an already-seen id is not dropped (mirror of the outageReplay bypass row). | Remove the bypass → continuation silently dropped → row fails. |
| T9 | Wrap determinism + original-text round-trip: leg-2 re-dispatch carries the ORIGINAL request text (not the leg-1 wrap nested); counter monotonic (`n+1`). | — |
| T10 | Migrated rows: 1292 → zero-progress-notice shape; 1304 → with-progress+open takes the arm (notice + re-dispatch), still never queued by the gate; 1276 (zero-progress+open → outage path) passes **unmodified**. D28 justification comments on both migrations. | 1276 unmodified IS the D3 pin. |
| T11 | Lane B sentinel shape (`error: error_turn_deadline, timedOut: true, aborted: false`) → arm never fires; existing error delivery. Operator abort (`aborted` only) → arm never fires. | — |
| T12 | Templates/constants module: every exported string pinned; `MAX_DEADLINE_CONTINUATIONS === 2`; `replayWrap` carries the A7 sentence (both policies). | — |

### Live-instance (deliver lane — gates ready-to-merge, not spec-ready)

The resume *mechanics* are D26-proven (KPR-399 V1/V2 ran them live), and
KPR-403 deliberately carried no live items on the note that end-to-end folds
into this child. Honest judgment: **one live scenario, required** — it is the
epic's headline user-visible behavior, and two things are structurally
non-unit-verifiable: the model's *behavioral* response to the continuation
wrap (continue-vs-restart — Edge-12's actual risk), and the production timing
of the fire-and-forget persist vs. the continuation's read (⚠A4).

- **V1 — end-to-end chain (required):** dev agent, `timeoutMs` 60s; send a
  thread task needing ~2-3 legs (multi-file summarize/build). Evidence: (1)
  first-abort notice in-thread; (2) continuation spawn log shows
  `resumeSession: <persisted id>` (not `"new"`); (3) the finished answer
  references a concrete pre-abort artifact (no restart, no redone side
  effects); (4) if any resume rejection fires, capture the string and
  discharge D25 (matcher refinement in-contract). Cap exhaustion (V1b,
  optional): make the task unbounded, observe the terminal notice — unit T2
  covers the logic; run live only if cheap.

No other live items: cron/silent/replay branches are pure dispatch logic over
seams the unit harness already fakes (KPR-400/401/403 unit-only precedent).
