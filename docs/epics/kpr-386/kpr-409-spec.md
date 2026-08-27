# KPR-409 — Scribe role: running meeting summary as the fresh-session anchor

**Epic:** KPR-386 (meeting mode) · **Blocked by:** KPR-390 (merged, `b611348`) · **Last child of the epic**
**Lifted from:** Part B of `docs/epics/kpr-386/kpr-390-spec.md`, re-verified against merged `main`-line reality (§Code-verification deltas).
**Status:** spec-ready (spec review clean r3, opus; r1 6 issues + r2 4 issues + r3 1 issue, all resolved).

## TL;DR

A fresh session entering a 105-message meeting today gets the raw transcript injected (KPR-388's `full` arm). This ticket adds a **scribe**: a cheap (`haiku`), tool-less pool worker that maintains a per-thread **running summary** in a new `meeting_summaries` collection, and rewires `buildConferenceContext`'s full arm to inject **summary + messages-since-summary** instead of the raw transcript. The scribe is *not* a meeting participant, *not* a conference turn, and has *no* posting surface. Failure degrades silently to today's exact behavior.

⚠ **This spec requests two canon relaxations** (R1 against C26, R2 against C9) rather than claiming authorization for either. Both are stated with rationale, precedent, and a fallback, and are submitted for the coherence reviewer's ruling at the merge seam — see Key Points 3 and 5, §D1, §D4, and §Open questions.

## ⚠ Key Points

1. **⚠ The carried Part B claim "the scribe reuses `runWorkerTurn` verbatim" is FALSE against merged code.** `runWorkerTurn(claim, boss, role)` is claim-coupled end-to-end — it builds its prompt from `workerTaskPrompt(claim)`, its context from `workItemContextFromClaim(claim)`, and terminates through `finishClaim(claim, …)`, which writes the claim ledger **and fires `dispatchReentry` → a `worker:<claimId>` WorkItem that makes the boss post the result into the room.** A scribe on that path would post its summary to the meeting every 90 seconds. The scribe therefore gets a **new sibling** `MeetingWorkerPool.runRoleTurn()` — an *addition* to `meeting-worker-pool.ts`, with **zero diff hunks inside `runWorkerTurn`/`spawnFetchWorker`** (C24 satisfied literally). `WorkerRoleParams` *is* lifted verbatim as the role type.
2. **⚠ Do NOT refactor `runWorkerTurn` to delegate to `runRoleTurn`.** The ~25 lines of adapter-invocation skeleton are duplicated on purpose: C24 freezes Part A's spawn path, and C24 outranks DRY here. A reviewer's "extract the common core" is the one refactor this spec forbids.
3. **⚠ This spec REQUESTS one canon relaxation. It does not claim authorization.** C26 sanctions exactly one conference-code touch — the C13 full-arm anchor. This design needs **two additional conference-code hunks**: a cadence notification in `resolveConferenceAgents` and one in `triggerConferenceReactions` (§D1). C13 does **not** grant this; the delta arm and round-level conference code are named off-limits to KPR-409. The need is real (a full-arm-only trigger freezes the summary the moment every participant converts to delta — §D1), the hunks are additive and fire-and-forget, and **the relaxation is submitted for the coherence reviewer to affirm or reject at the merge seam** — the same mechanism this epic used for KPR-390's containment relaxations. If rejected, the fallback is the full-arm-only trigger with the freeze accepted and measured.
4. **⚠ Dispatch model decision: activity-triggered debounced re-dispatch, not a self-relaunching daemon and not a lazy pull.** The meeting's own message flow is the clock (§D1) — no new recurring-dispatch mechanism, and no scribe turn on the critical path of the turn being optimized.
5. **⚠ The high-water formula MUST change, and this is the spec's second requested relaxation — a constitutive one.** In summary mode `injectionHighWaterTs` maxes in `summary.coveredThroughTs` alongside the tail; the carried design's "unchanged formula" yields `undefined` on an empty tail at round 1, `setMeetingMark` is skipped (`dispatcher.ts:1106`), and the agent never converts to delta. This advances the mark over messages that were *summarized* rather than *literally injected* — a relaxation of C9's literal-coverage invariant, **submitted for the same merge-seam ruling** (§D4). It is not a new exception in kind: `truncateHistory` (`dispatcher.ts:1323`) already does exactly this today — a >105-message thread injects first-5+last-100 while `maxSlackTs` advances the mark to the last message's ts, leaving the dropped middle mark-covered but never injected. ⚠ **There is no partially-compliant variant**: the tail begins above `coveredThroughTs` by construction, so any mark derived from it jumps the summarized span whether or not `coveredThroughTs` is maxed in. The only compliant way to ship the feature is F1 (the summary arm sets no mark, trading KPR-388's warm-path delta) — full menu at §D4.
6. **⚠ `injectionMode` widens to `"full" | "delta" | "summary"`** across four small sites so the epic can measure its own last child (C18: widening the existing KPR-389 field, not adding a parallel one). Load-bearing check: `dispatcher.ts:1100`'s self-heal leg is `=== "delta"`-exclusive and stays correct unmodified.
7. **⚠ Containment surface, stated at its true boundary.** `coreServers: []` (C22) is the strongest available posture, but it removes **MCP** surfaces, not SDK builtins — under `bypassPermissions` the scribe still holds Read/Write/Bash, identical to Part A's fetch-worker (E5's stated boundary). `maxTurns: 4` is the bound, not a permission gate. And because the scribe adds no MCP server and no tool, **C23's Lane B `buildToolTransportInventory` compensation is a structural no-op** — nothing exists to compensate for.
8. **⚠ The scribe must not steal fetch-worker capacity.** It gets its own `scribeMaxConcurrent` counter and its own abort registry inside `MeetingScribe` — it does **not** register in the pool's `liveWorkers`, so it never consumes a `maxConcurrent` slot a boss's `worker_dispatch` needs (§D3). This also keeps `stop()`/`abortForBoss`/`dispatch()` free of edits.
9. **Never a correctness dependency, and never boot-fatal.** No summary doc, a stale one, a failed scribe run, a saturated pool, a Mongo read failure, `scribeEnabled: false` — every path falls through to today's byte-identical full transcript. C6's pin stays green unmodified, and `ensureIndexes` is `.catch`-logged rather than boot-fatal (§Integration points, issue-5 divergence from C27).

---

## Problem

KPR-388 gave meeting agents delta injection: an agent with a live session and a `meetingLastSeenTs` mark receives only new messages. But the **`full` arm** — every agent's first turn in a thread, plus every session-TTL/provider-handoff miss — still injects the raw transcript through `formatThreadContext`, capped at first-5 + last-100 (`truncateHistory`). In a long conference that is ~105 messages of prompt on the exact turn a late entrant is trying to answer quickly. KPR-388 named this explicitly as out of scope and left the hook:

> "Preserved hook: the fresh-session branch is a single site (`buildConferenceContext`'s `mode: "full"` arm) where a future summary+recent-delta assembly can replace the raw transcript without touching the delta arm or the mark mechanics." — `kpr-388-spec.md:43`

⚠ That hook's own final clause — "without touching … the mark mechanics" — is precisely where this spec has to ask for something. The mechanics stay untouched; the mark's *value semantics* cannot, because a summary is by definition content the agent absorbs without literal injection. R2 (§D4) is that request, made explicitly rather than read into the hook.

KPR-390 delivered the machinery that makes a cheap background summarizer possible (detached, sessionless, breaker-invisible, budget-exempt worker spawns with structural containment). This ticket joins the two.

## Goals

- G1. A per-thread **running summary** is maintained during an active meeting by a cheap, tool-less worker.
- G2. `buildConferenceContext`'s full arm injects **summary + messages-since-summary** when a summary exists.
- G3. Every failure mode degrades to today's exact behavior, silently.
- G4. The scribe is measurable through the existing KPR-389 telemetry surface (C18).

## Non-goals

- **Not** a conference participant. No roster membership, no classifier candidacy, no reaction-pass exposure, no posting surface (§D2).
- **Not** a change to the delta arm, the `meetingLastSeenTs` mark **mechanics** (`setMeetingMark`/`clearMeetingMark`, their call sites, their placement), the reaction tracker, the preamble, or spawn shaping. ⚠ The mark's **value semantics** *are* relaxed on the summary arm — that is R2, requested explicitly, not smuggled in under this non-goal (§D4).
- **Not** a change to Part A's claim ledger, `worker_dispatch`/`worker_status`/`worker_cancel`, the re-entry path, the watchdog, or the restart sweep.
- **No** new MCP tool, no `hive doctor` section, no new telemetry collection, no cross-meeting/global summary, no summary versioning UI, no operator command to force a scribe run.

---

## Design

### D1. Dispatch / lifecycle model — the fork, decided

Three candidates were weighed against C24's frozen-surface constraint and the epic's responsiveness goal:

| | Model | Verdict |
|---|---|---|
| (a) | **Standing daemon** — scribe self-relaunches on a wall-clock cadence | **Rejected.** Requires a new recurring-dispatch mechanism the pool does not have (fetch-workers are one-shot; the 60s watchdog is a sweeper, not a scheduler). Burns haiku turns on idle threads. Pure YAGNI cost. |
| (b) | **Lazy pull, blocking** — run the scribe inside the full arm when a summary is needed | **Rejected.** Puts a haiku turn on the critical path of the exact turn we are optimizing. Strictly worse than doing nothing. |
| (c) | **Activity-triggered debounced re-dispatch** — each conference round notifies the scribe once, fire-and-forget (seam placement below); the scribe debounces and runs at most one turn per thread at a time | **CHOSEN.** |

**Rationale for (c).** It satisfies the ticket's "standing worker maintaining a running summary" behaviorally — the summary *is* continuously maintained during an active meeting — without inventing a scheduler: **the meeting's own message flow is the clock.**

**Seam placement — round-level, not per-agent.** The trigger fires **once per conference round**, from the two functions that already fetch the thread history:

| Site | Call |
|---|---|
| `resolveConferenceAgents` (`dispatcher.ts` ~:1240, after `fetchThreadHistory`, **before** the `Promise.all` over responders) | `this.meetingScribe?.noteActivity({ threadId, history, channelName: item.source.label, roster: rosterMembers, baseAgentId })` |
| `triggerConferenceReactions` (~:1481, after the re-fetch, before the reaction map) | same shape |

`baseAgentId` = the first entry of the round's roster/responder list (any roster member serves — §D3 explains why the choice is near-arbitrary).

⚠ **The two sites have deliberately different coverage, and the round-0 one carries the cadence.** `resolveConferenceAgents` fires on **every** conference round-0 pass, including when the classifier selects nobody — the seam sits after `fetchThreadHistory` and before the responder fan-out. `triggerConferenceReactions` fires **only when reactors are actually selected**: it has three early returns (`!roster`, empty `peerMembers`, empty `respondAgentIds`) *before* its re-fetch, so there is no history to hand the scribe on those paths. That asymmetry is fine — round 0 already guarantees at least one trigger per human message, which is the cadence that matters — but it must not be papered over in the tests (§T6).

⚠ **This is the requested C26 relaxation** (Key Point 3): two round-level conference hunks beyond the sanctioned full-arm anchor. Rationale, stated plainly rather than dressed as authorization:

- **Freeze prevention.** The obvious C26-clean alternative — trigger only from `buildConferenceContext`'s full arm — stops firing the moment every participant has converted to delta. The summary would freeze at ~message 5, and a late joiner at message 105 would get `summary(first 5) + 100-message tail`: no better than today, i.e. the ticket's goal unmet in exactly the case it exists for.
- **The next-cleanest alternative — notify from `buildConferenceContext` in *both* arms — is a delta-arm touch**, which C13 names off-limits just as squarely, *and* it fires N times per round (once per responder), *and* it never fires when the classifier selects nobody. Strictly worse on all three counts than the round-level seam.
- Both hunks are **additive, fire-and-forget, and behavior-neutral** to the conference path: `noteActivity` returns `void` synchronously, throws nothing, and its removal restores byte-identical behavior.

If the coherence reviewer rejects the relaxation, the fallback is the full-arm-only trigger with the freeze accepted, measured via the `injectionMode: "summary"` telemetry, and filed as a follow-up.

**Gating inside the scribe.** ⚠ Gate 0 is the race fix (issue 3): a round dispatches responders through `Promise.all`, and rounds for successive triggers can overlap in one thread, so **the in-flight claim is taken synchronously, before the first `await`.**

```ts
noteActivity(args): void {                       // returns void; never throws
  if (!enabled || !scribeEnabled) return;                        // 1
  if (Date.now() - (this.lastRunAt.get(threadId) ?? 0) < scribeDebounceMs) return;  // 3
  if (this.inFlight.has(threadId)) return;                       // 2a — SYNCHRONOUS
  if (this.inFlight.size >= scribeMaxConcurrent) return;         // 5a — SYNCHRONOUS
  this.inFlight.add(threadId);                                   // claimed BEFORE any await
  void this.run(args)
    .catch(logAndSwallow)
    .finally(() => {
      this.inFlight.delete(threadId);
      this.abortHandles.delete(threadId);   // ⚠ BOTH lifecycles release here — see below
    });
}
```

⚠ **`abortHandles` is released in the same `finally` as `inFlight`, never separately.** The two maps are keyed identically (`threadId`) and must have identical lifetimes: an entry is added by `runRoleTurn`'s `onAbortHandle` callback during the run and removed the moment the run settles, on every path including throw and abort. Omitting this — the shape the r2 review caught — leaks one entry per distinct thread ever summarized in the process's lifetime (bounded in practice only by same-thread reruns overwriting the key, which is luck rather than design) and, worse, leaves `scribe.stop()` calling `abort()` on adapters that completed long ago.

Gates 1, 3, 2a and 5a are all synchronous reads above the claim; nothing between the `has` check and the `add` can yield. The remaining gates run inside `run()`, after the claim:

2b. `meeting_summaries.updating.startedAt` newer than `2 × scribeTimeoutMs` ⇒ abandon (crash-leftover guard across restarts, where the in-memory set is empty).
4. Novelty: fewer than `scribeMinNewMessages` (default 6) messages with `ts > coveredThroughTs` ⇒ abandon. (First run: `coveredThroughTs` absent ⇒ every message counts, so a meeting summarizes once it is 6 messages deep.)
5b. `pool.hasCapacity()` false ⇒ abandon. Fetch-workers are on someone's critical path; the scribe yields to them even though it no longer competes for their slots (§D3) — a saturated pool means the engine is busy.

Then: set `updating`, run the turn, write the summary, clear `updating`, stamp `lastRunAt`. Every abandon path is a silent no-op re-evaluated on the next round's trigger; the `finally` clears the in-memory claim, the `updating` field, and the corresponding `abortHandles` entry on every path including throw — one shared lifecycle (see the gate-0 sketch above).

**"Standing" is behavioral, not process-level** — there is no long-lived scribe process, no timer, and nothing to leak across a restart beyond a possibly-stale `updating` field, which gate 2b clears.

### D2. Turn kind — C14/C15 resolved structurally

**The scribe is a pool worker, never a meeting participant.** It is never added to `meetingRosters`, never appears in a classifier candidate list (round 0 or the reaction pass), and never receives a conference dispatch. It therefore never enters conference round classification at all: the 6-turn/120s round-1 reaction clamp, the decline-immediately preamble, the reaction tracker, and the kill-suppression leg are all structurally unreachable, not merely avoided. C14/C15's "forced decision" is answered by the architecture rather than by a new turn kind — **no roster, classifier, preamble, or shaping code is touched.**

Its turn runs on `MeetingScribe` → `pool.runRoleTurn()` → `manager.buildWorkerAdapter()` → `adapter.runTurn()`: sessionless, lock-exempt, breaker-invisible, not `spawnBudget`-accounted — every property inherited from Part A's `buildWorkerAdapter` hook, unchanged.

### D3. The scribe turn — role params, base config, storage

**`runRoleTurn` (new public method on `MeetingWorkerPool`, sibling to `runWorkerTurn`; ~25 lines).**

```ts
runRoleTurn(args: {
  base: AgentConfig;                 // config to clone
  role: WorkerRoleParams;            // lifted type, unchanged
  prompt: string;
  workItemContext: { adapterId; channelId; channelKind; channelLabel; threadId; slackTs; slackThreadTs };
  onAbortHandle?: (abort: () => void) => void;   // invoked synchronously after adapter construction
}): Promise<{ text?: string; error?: string; timedOut?: boolean; aborted?: boolean;
              costUsd?: number; toolCalls?: number; durationMs: number } | null>   // null = manager hooks not bound
```

Body mirrors `runWorkerTurn`'s clone-and-run core — `{ ...base, model: role.model, coreServers: role.coreServers, delegateServers: [], schedule: [] }`, `buildWorkerAdapter`, `onAbortHandle?.(() => adapter.abort())`, `runTurn({ prompt, sessionId: undefined, workItemContext, resourceLimits: { maxTurns, timeoutMs, budgetUsd: base.budgetUsd }, systemPromptOverride: role.charter })` — and **returns the raw outcome**. It touches no collection and dispatches nothing.

⚠ **Capacity disposition (issue 4): `runRoleTurn` does NOT register in `liveWorkers`.** Registering there would have made every live scribe consume one of the four engine-wide `maxConcurrent` slots that `dispatch()`'s saturation check guards — three meetings summarizing concurrently would leave a boss's `worker_dispatch` one slot from an honest-but-avoidable "pool saturated" refusal, a regression *caused by* an optional optimization. Instead:

- **The scribe owns its own bound and its own abort registry.** `MeetingScribe` holds `inFlight: Set<threadId>` (bounded by `scribeMaxConcurrent`, default 2) and `abortHandles: Map<threadId, () => void>` populated via `onAbortHandle`. `scribe.stop()` (already wired in `index.ts`) aborts them all on shutdown. ⚠ Both maps are keyed on `threadId` and **released together in one `finally`** (§D1) — they are two views of one lifecycle, and any code path that clears one without the other is a bug.
- **`pool.liveWorkers`, `dispatch()`'s cap check, `stop()`, and `abortForBoss` are all left unedited** — a bonus for C24's spirit: the capacity fix costs zero Part A behavioral edits.
- **The check remains one-directional by design, in the safe direction:** gate 5b makes the scribe yield when the pool is busy, and a scribe can never make the pool busy. That is the correct asymmetry — it was the *other* direction that was the hazard.
- Consequence: `abortForBoss(agentId)` no longer reaches a scribe run. This is an improvement — killing a summarizer because its *incidental* base-config donor was stopped was never desirable. A scribe run is instead bounded by `scribeTimeoutMs` (120s) and by `scribe.stop()`.
- ⚠ `LiveWorker.bossAgentId` (advisory b) is therefore **not** derived at all for scribe runs — the field belongs to `liveWorkers`, which scribes never enter. Should a later change reintroduce registration, `base.id` is the value it must carry.

**Role params.**

| Field | Value | Rationale |
|---|---|---|
| `model` | `config.meetingWorkers.scribeModel`, default `"haiku"` | Summarization is the cheapest useful task in the engine. |
| `coreServers` | `[]` | **C22.** Not "boss minus denylist" — the transcript is in the prompt; the scribe needs nothing. See ⚠ Key Point 7 for the boundary. |
| `delegateServers` | `[]` | Set by `runRoleTurn`'s clone (C19 — no nesting). |
| `maxTurns` | `scribeMaxTurns`, default **4** | ⚠ **Deviation from the carried design's 8.** With `coreServers: []` there is no MCP tool loop to iterate; 8 was sized before C22 pinned the empty set. 4 is a runaway bound, not a working budget. |
| `timeoutMs` | `scribeTimeoutMs`, default `120_000` | Carried unchanged. |
| `charter` | §D3a | Total `systemPromptOverride` replacement (voice/fetch-worker precedent — no soul, no constitution). |

**Base config.** `runRoleTurn` needs an `AgentConfig` to clone. The scribe uses the **triggering agent's** config — `baseAgentId` captured at the seam, re-resolved live from the registry at run time (mirroring `spawnFetchWorker`'s `registry.get` re-check; missing or disabled ⇒ silent skip, retried on the next trigger). With `coreServers: []`, `delegateServers: []`, model and system prompt all overridden, the only fields that survive the clone are `budgetUsd` (the operator's per-turn cost cap — correctly still binding) and the id/name, used for logging only (scribes never enter `liveWorkers` — see the capacity disposition below). ⚠ Consequence to note at review: `budgetUsd` therefore varies with whichever participant happened to trigger the run. Accepted — a tool-less haiku turn under a 4-turn cap is far below any realistic per-turn cap.

**Storage — a new `meeting_summaries` collection, not the claim ledger.** Verified against `WorkerClaimDoc`: the ledger is `_id: ObjectId`-keyed with a partial-unique `(threadId, taskKey)` index scoped to `status: "running"`, and *every* terminal transition routes through `finishClaim` → `dispatchReentry`. A summary is one-per-thread, has no claim-atomicity story, and must produce no re-entry. Wrong shape; separate collection confirmed.

```ts
interface MeetingSummaryDoc {
  _id: string;                 // threadId
  summaryText: string;         // ≤ SUMMARY_TEXT_CAP (2500) chars, truncated on write
  coveredThroughTs: string;    // max Slack ts of the messages the summary covers
  version: number;             // monotonic; observability only
  updatedAt: Date;             // 7d TTL index (housekeeping; a meeting never outlives it)
  updating?: { startedAt: Date };   // single-flight guard, staleness-overridden
}
```

Indexes: `{ updatedAt: 1 }, { expireAfterSeconds: 7 * 86_400 }`. `_id` is the thread key, so no other index is needed. Written with a single `updateOne(… , { upsert: true })` — last write wins, which is correct: concurrent runs are prevented by the single-flight guard, and if one ever slipped through, the later `coveredThroughTs` is strictly better.

**Prompt.** `runRoleTurn` is handed a prompt built from the prior summary (if any) plus the messages with `ts > coveredThroughTs`, formatted with the existing `Author (n min ago): text` body shape. The scribe receives the transcript the **dispatcher already fetched** and passed through `noteActivity` — the pool gains **no** Slack-adapter dependency and performs **no** second `fetchThreadHistory`. (The carried design required threading a fetch callback into the pool; verified reality makes that unnecessary.)

#### D3a. Charter (exported for a byte pin)

```
You are the scribe for a meeting in #<channelLabel>. You maintain one running
summary of the meeting for colleagues who join late.

Rewrite the summary below to incorporate the new messages. Return the COMPLETE
replacement summary — not a diff, not a preface, not a commentary.

Cover: decisions made, open questions, and each participant's current position.
Drop resolved chatter. Stay under 2000 characters.

You have no tools and no messaging surface. Your final message IS the summary.
```

⚠ The charter says 2000 while `SUMMARY_TEXT_CAP` is 2500 (advisory c). **The 500-char headroom is deliberate**: the charter is a soft instruction to a small model, the cap is a hard truncation on write. Sizing them equal would make every mild overrun a mid-sentence truncation; the gap absorbs normal overshoot so the cap only ever fires on a genuinely runaway summary. Do not "fix" the mismatch by aligning the numbers.

### D4. C13 anchor integration — the sanctioned conference-code edit (one of three total)

`buildConferenceContext` (`src/channels/dispatcher.ts:1337`), **full arm only**. This is the one edit C26 sanctions; the two round-level `noteActivity` hunks in §D1 are the separately-requested R1 relaxation. The delta arm and the delta-eligibility predicate are untouched, and the mark **mechanics** (`setMeetingMark`/`clearMeetingMark`, their call sites, their placement relative to the outage gates) are untouched — but the mark's **value semantics** are relaxed on this arm, which is R2 below.

**Before** (current merged code, `:1348-1353`):

```ts
if (!ref?.sessionId || !ref.meetingLastSeenTs || ref.provider !== provider) {
  return {
    threadContext: this.formatThreadContext(history, channelName, roster),
    injectionMode: "full",
    injectionHighWaterTs: maxSlackTs([...this.truncateHistory(history).map((m) => m.ts), roundZeroTriggerTs]),
  };
}
```

**After:**

```ts
if (!ref?.sessionId || !ref.meetingLastSeenTs || ref.provider !== provider) {
  const summary = await this.meetingScribe?.getSummary(threadId);   // fail-soft, never throws, undefined when absent
  if (summary) {
    const coveredNum = parseFloat(summary.coveredThroughTs);
    const tail = history.filter((m) => parseFloat(m.ts) > coveredNum).slice(-100);
    return {
      threadContext: this.formatSummaryContext(summary.summaryText, tail, channelName, roster),
      injectionMode: "summary",
      injectionHighWaterTs: maxSlackTs([
        ...tail.map((m) => m.ts),
        summary.coveredThroughTs,          // ⚠ REQUIRED — see below
        roundZeroTriggerTs,
      ]),
    };
  }
  return { /* …today's three lines, byte-identical… */ };
}
```

**⚠ The `coveredThroughTs` max-in is required, not cosmetic — and it is the spec's second requested relaxation.** The carried design asserted "unchanged formula". Verified: when the tail is empty (the summary already covers the whole thread), round 1 passes no `roundZeroTriggerTs`, so the old formula yields `undefined`; `dispatchToAgent:1106`'s `else if (resolved.injectionHighWaterTs)` then skips `setMeetingMark`, and the agent never converts to delta — it re-enters the summary arm on every subsequent turn forever.

The mark this sets covers messages the session absorbed **as summary**, not as literal injected text. That is a relaxation of C9's literal-coverage invariant. C13 does **not** authorize it — C13 names the mark mechanics off-limits — so it is stated here as a request and **submitted for the coherence reviewer's ruling at the merge seam**, alongside the C26 relaxation in §D1.

Two things make it a modest ask rather than a novel exception:

- **The precedent already exists in the same file.** `truncateHistory` (`dispatcher.ts:1323`) drops the middle of any thread longer than 105 messages, injecting first-5 + last-100 — while the full arm's `maxSlackTs([...this.truncateHistory(history).map(m => m.ts), …])` advances the mark to the *last* message's ts. Every dropped middle message is therefore already mark-covered but never injected, today, in production. The summary case is the same shape: content the agent is trusted to have absorbed by other means, sitting below an advancing mark.
- **The failure mode is duplication, never a gap** — the same argument KPR-388 relies on. A mark that is too *high* can only under-include on a later delta; here the under-included messages are exactly the ones the summary describes.

**⚠ There is no degraded-but-compliant variant of summary mode. The relaxation is constitutive, not incidental.** The tail is *by construction* the messages with `ts > coveredThroughTs`, so whenever it is non-empty, `max(tail) > coveredThroughTs` and the mark jumps the summarized span **regardless of whether `coveredThroughTs` is maxed in**. The `coveredThroughTs` max-in only decides the *empty-tail* case, where the alternative is `undefined` (no mark at all) rather than a compliant mark. Any mark derived from a tail that starts above `coveredThroughTs` relaxes C9. The real menu for the coherence reviewer is therefore three options, not a slider:

| | Option | Effect |
|---|---|---|
| **R2 affirmed** | Mark = `max(tail ∪ coveredThroughTs ∪ trigger)` | **Recommended.** Feature ships whole; C9 relaxed with the `truncateHistory` precedent. |
| **F1** | **The summary arm sets no mark at all** (`injectionHighWaterTs: undefined`) | The only genuinely C9-compliant way to ship this feature. See below. |
| **F2** | Do not ship summary mode | KPR-409 delivers nothing. |

**F1 spelled out precisely, because it is the only compliant option and it does *not* silently disable the feature.** With `injectionHighWaterTs: undefined`, `dispatchToAgent:1106`'s `else if` skips `setMeetingMark`, so no mark is ever written from a summary turn. Consequences, traced:

- **The ticket's goal is still met.** A fresh entrant gets `summary + tail` instead of the 105-message transcript. That is the entire point of KPR-409 and it survives intact.
- **But a fresh-entrant participant never converts to delta.** F1 writes no mark and clears none — so this cost applies only to an agent entering summary mode *without a prior mark* (the fresh-entrant case, which is the dominant and target one: every new joiner, and every agent whose session/mark was never established). An agent that already held a mark and hit a handle miss (session document survives its handle — C8) or a KPR-313 provider mismatch keeps that mark untouched and returns to the **delta** arm on its next turn once the condition clears — F1 does not touch that path. For the fresh-entrant case, with no mark, KPR-388's eligibility predicate fails forever, so *every* turn re-enters the summary arm. Per-turn cost becomes `~2500 chars of summary + messages since the last scribe run` (small — the scribe runs every ~90s) in place of KPR-388's pure delta. **This trades a shipped sibling ticket's warm-path savings, for fresh entrants specifically, for this ticket's cold-path savings** — bounded and arguably still net-positive, but a real regression against KPR-388 that the reviewer must price deliberately, not discover later.
- **It is not permanently absorbing.** If `scribeEnabled` is turned off or the summary doc ages out on its TTL, the plain full arm runs and sets a mark normally; delta resumes.
- Cost to implement: deleting one line. F1 is a genuine fallback, not a euphemism for F2.

**The r1 draft of this spec offered a fourth option — "max in `coveredThroughTs` only when the tail is non-empty" — which does not exist.** It relaxes C9 in the common case and declines only where the effect would have been `undefined` anyway. It is withdrawn.

**Format (`formatSummaryContext`, new private method beside `formatDeltaContext`).**

```
[Meeting thread in #<channel> — participants: A, B, C]
[Running summary of the meeting so far:]

<summaryText>

[Messages since the summary:]

Author (4 min ago): text
Author (2 min ago): text
```

The tail block (header + body) is **omitted entirely** when `tail` is empty. Marker-collision check (C3/C10 pin unambiguity): neither new marker is `[New message]:` (the terminal slot) nor `[New messages since your last turn:]` (the delta header), and neither starts with `[New` — the C3 framing test's negative assertions hold unmodified.

**Size invariant worth stating:** the tail reuses the same `slice(-100)` cap as `truncateHistory`'s tail, so summary mode is **never larger** than today's full injection and is typically far smaller. There is no first-5 pin on the tail — the summary holds the thread opening, exactly the reasoning the delta arm already uses.

**`injectionMode: "summary"`** — widening the existing KPR-389 field (C18: reuse, not a parallel surface). Four sites:

| File | Change |
|---|---|
| `src/channels/dispatcher.ts:73` | `injectionMode?: "full" \| "delta" \| "summary"` on `ResolvedAgent` |
| `src/agents/agent-manager.ts:199` | `conferenceInjectionModeOf` narrows to the three values |
| `src/agents/turn-telemetry.ts:19,42` | both field types widen |
| — | `dispatcher.ts:1100`'s self-heal leg is `=== "delta"`-exclusive and **stays unmodified** — correct: a summary turn is already a fresh session, so there is no continuity to heal. |

Without this, summary turns are indistinguishable from full turns in `agent_turn_telemetry` and the epic cannot measure its own last child.

**⚠ Latency caveat (advisory d).** `getSummary` adds one Mongo round-trip **per responding agent per round** to the conference critical path — it sits inside `buildConferenceContext`, which runs per agent. It is an `_id` point lookup on a small collection against the engine's pooled client (sub-millisecond in practice), and it is skipped entirely for delta-eligible agents and when `scribeEnabled: false`. So the spec's "no scribe turn on the critical path" claim holds — the *summarizing turn* is fully off-path — but "no latency added" would be too strong: one indexed point read per full-arm agent is added, against a saving of ~100 messages of prompt. Net strongly positive, but stated rather than glossed.

### D5. Scribe non-interactions (explicit)

Scribe runs are invisible to: the reaction tracker (C1/C2 — no reads, no writes); `meetingLastSeenTs` marks (C12 — a scribe turn is not a conference turn and never reaches `dispatchToAgent`); KPR-389 shaping and the kill-suppression leg (no conference meta on the turn); the claim ledger (separate collection, no `finishClaim`, no `dispatchReentry`); the outage queue and `policyFor` (the scribe mints no WorkItem — nothing to classify); the provider circuit breaker (inherited from `buildWorkerAdapter`); and `spawnBudget`. `hive doctor` gains nothing.

### D6. Config — new `meetingWorkers` keys

Appended to `MeetingWorkersConfig` / `DEFAULT_MEETING_WORKERS_CONFIG` (`src/workers/worker-pool-config.ts`) and resolved by the existing liberal loader `resolveMeetingWorkersConfig` (`src/config.ts:103`) with the same `posNum` / string-trim / boolean idioms:

| Key | Default | Notes |
|---|---|---|
| `scribeEnabled` | `true` | **The rollback lever for the prompt-shape change.** `false` ⇒ no scribe runs and no anchor branch (`getSummary` returns undefined by construction) ⇒ byte-identical to pre-KPR-409. Deliberately separate from `enabled` so an operator can keep fetch-workers while reverting the injection change. |
| `scribeModel` | `"haiku"` | Claude-lane pin, same posture as `workerModel`. |
| `scribeDebounceMs` | `90_000` | |
| `scribeMinNewMessages` | `6` | |
| `scribeMaxConcurrent` | `2` | ⚠ Engine-wide, **separate from `maxConcurrent`** — scribes never consume fetch-worker slots (§D3, issue 4). |
| `scribeMaxTurns` | `4` | ⚠ deviation from the carried 8 — §D3. |
| `scribeTimeoutMs` | `120_000` | No TTL-clamp interaction: the scribe creates no claim, so `claimTtlMinutes`'s invariant is untouched. |

## Integration points

**New files**
- `src/workers/meeting-scribe.ts` — `MeetingScribe`: `noteActivity()`, `getSummary()`, gating, single-flight, `meeting_summaries` access, prompt + charter builders (exported for byte pins), `ensureIndexes()`, `stop()`.
- `src/workers/meeting-scribe.test.ts`.

**Modified**
- `src/workers/meeting-worker-pool.ts` — **additive only**: public `runRoleTurn()` and `hasCapacity()`. ⚠ Zero diff hunks inside `runWorkerTurn` / `spawnFetchWorker` / `dispatch` / `finishClaim` / `dispatchReentry` / the sweeps (C24 review gate). **Exception, explicitly sanctioned (issue 6):** three comment blocks in this file describe KPR-409's integration and become false the moment this merges — the file header (~:12-13, "it will reuse runWorkerTurn"), `WorkerRoleParams`'s doc comment (~:117-119), and ⚠ **`runWorkerTurn`'s own doc comment (~:442-443, "KPR-409's scribe reuses this with its own role object")**, which is now flatly wrong since the scribe uses a sibling. **Correcting these three comments to describe the sibling arrangement is required and does NOT count as a "hunk inside `runWorkerTurn`" under the C24 gate** — the gate is about the function's *behavior*, and leaving a doc comment that misdescribes the very contract the gate protects is worse than the diff. No executable line inside those functions may change.
- `src/workers/worker-pool-config.ts` — seven scribe keys + defaults.
- `src/config.ts` — seven resolver lines in `resolveMeetingWorkersConfig`.
- `src/channels/dispatcher.ts` — `setMeetingScribe()` (setter-injection precedent: `setSlackAdapter`/`setTeamStore`); the `buildConferenceContext` full-arm anchor branch; `formatSummaryContext`; the `ResolvedAgent.injectionMode` widening; **and the two round-level `noteActivity` calls in `resolveConferenceAgents` / `triggerConferenceReactions`**. ⚠ The anchor branch is C26-sanctioned; the two `noteActivity` hunks are the **requested relaxation** (§D1, Key Point 3) awaiting the merge-seam ruling.
- `src/agents/agent-manager.ts` — `conferenceInjectionModeOf` narrowing widened; `MeetingScribe` bound to the same `WorkerPoolManagerHooks` (see below). ⚠ `setWorkerPool`'s hook literal is **not** restructured — the scribe is constructed with the pool as a dep and calls `pool.runRoleTurn()`, so the existing single `bindManager` site remains the only manager binding.
- `src/index.ts` — construct `MeetingScribe({ db, registry, pool: workerPool, config: config.meetingWorkers })` after the pool, `dispatcher.setMeetingScribe(scribe)`, `scribe.stop()` in the shutdown block beside `workerPool.stop()`. ⚠ **`ensureIndexes` is `.catch`-logged, not awaited-fatal (issue 5):**
  ```ts
  scribe.ensureIndexes().catch((err) => log.error("Scribe index setup failed", { error: String(err) }));
  ```
  This **diverges from C27's boot-fatal `ensureIndexes` posture** for the claim ledger, deliberately. C27's ruling is justified by *atomicity*: a missing `(threadId, taskKey)` partial-unique index would silently permit duplicate claims — a correctness invariant. The scribe's only index is a **7-day TTL housekeeping index with no correctness role**; without it, summary docs accumulate and nothing else changes. Making an explicitly-optional, always-degradable feature boot-fatal would contradict this spec's own §G3 rule and hand the engine a new refuse-to-start mode in exchange for nothing.
- `CLAUDE.md` — `meeting_summaries` in the collections list.
- `docs/epics/kpr-386/kpr-390-spec.md` — Part B annotated as superseded by this spec (pointer only).

**Explicitly untouched:** `in-process-servers.ts`, `worker-pool-mcp-server.ts`, `agent-runner.ts`, `session-store.ts`, `outage-notices.ts`, `docs/providers.md`, every provider adapter, `buildToolTransportInventory`, the roster/classifier/preamble/reaction-tracker code, and the claim ledger.

**C23:** the scribe introduces no MCP server and no tool. `buildToolTransportInventory` needs no compensation because there is nothing to compensate — Lane B agents are affected by this ticket only as *readers* of a shorter injected prompt, which is provider-agnostic by construction.

## Edge cases

- **E1 Meeting ends before the first summary.** No doc ⇒ full arm returns today's exact three lines. Nobody notices.
- **E2 Scribe turn fails / times out / errors.** No write; `updating` cleared in `finally`; the prior summary (if any) stands and the tail lengthens toward today's behavior at the 100-cap. **Never blocks a meeting turn** — `noteActivity` is fire-and-forget and `getSummary` is fail-soft (`.catch(() => undefined)`), so a Mongo hiccup at read time degrades to full injection rather than failing the dispatch.
- **E3 Stale summary.** Bounded degradation only: the tail grows, and at the 100-cap the injection is exactly today's size. C7's one-degraded-turn allowance covers the window; the next scribe run heals it.
- **E4 Concurrent summary writes.** ⚠ The primary case is a **single round fanning out** (`Promise.all` over responders) and overlapping rounds in one thread — which is why the in-memory claim is taken **synchronously before the first await** (§D1 gate 0). The `updating` doc guard with a `2 × scribeTimeoutMs` staleness override covers only what the in-memory set cannot: crash leftovers across a restart. If both were somehow defeated, the upsert is last-write-wins and the later `coveredThroughTs` is strictly better — no corruption path exists.
- **E5 Engine restart / shutdown mid-scribe.** `scribe.stop()` aborts the live handles from its own `abortHandles` map (scribes are not in `liveWorkers` — §D3); no ledger doc exists to sweep; a leftover `updating` is cleared by gate 2b on the next trigger. `abortForBoss` deliberately does not reach scribe runs.
- **E6 Pool saturated by fetch-workers.** Scribe skips (gate 5b) — good citizenship, since a saturated pool means the engine is busy. The reverse hazard (a scribe starving a boss's `worker_dispatch`) is structurally impossible: scribes hold no `maxConcurrent` slot (§D3).
- **E7 Very long meeting.** The summary is capped at 2500 chars on write and the tail at 100 messages, so summary-mode injection has a hard ceiling *below* today's. The failure mode is summary *quality* drift over hundreds of messages, not size — accepted for this ticket (the alternative, hierarchical summarization, is explicitly out of scope).
- **E8 Base agent deleted/disabled between trigger and run.** Live registry re-check ⇒ silent skip, retried on the next trigger. (Mirrors Part A's E6 guard, minus the re-entry hazard — the scribe dispatches nothing, so a step-0 miss is structurally impossible.)
- **E9 Non-meeting thread.** `noteActivity` is only ever called from `resolveConferenceAgents` / `triggerConferenceReactions`, both conference-only by construction. No gate needed; stated so the review can confirm it.
- **E12 Classifier selects nobody.** The round-level seam still fires (it sits before the responder fan-out), so a meeting where agents mostly stay quiet is still summarized — coverage the per-agent seam would have missed entirely.
- **E13 Mongo unavailable at index setup.** `ensureIndexes` failure is logged, not fatal (issue 5). The scribe runs without the TTL index: summaries still work, docs simply do not age out until an operator restores it.
- **E10 `scribeEnabled: false` mid-meeting with a live summary doc.** `getSummary` short-circuits on the flag before reading, so the anchor reverts immediately; the stale doc ages out on its TTL.
- **E11 Provider handoff (KPR-313) or session TTL on a summarized thread.** The agent re-enters the full/summary arm and gets the summary — which is the whole point. Mark bookkeeping is unchanged.

## Test plan

Negative-verify per repo convention (revert the source hunk, confirm the new test fails) for T1, T2, T4, T6.

**`src/channels/dispatcher-conference.test.ts`** (additions; the existing 28 cases must pass **unedited** — a review gate)

- **T1 (summary-mode byte pin).** Summary doc present + fresh-session ref ⇒ `threadContext` byte-exact against the pinned `formatSummaryContext` shape (both markers present, neither `[New message]:` nor `[New messages since your last turn:]` present), `injectionMode: "summary"`. Table row: empty tail ⇒ no dangling `[Messages since the summary:]` header. *Negative-verify: revert the anchor branch ⇒ the pin fails with the raw-transcript shape.*
- **T2 (high-water formula).** ⚠ The correction pin, written against R2 (the default recommendation). (a) Non-empty tail ⇒ `injectionHighWaterTs === max(tail ts)`. (b) **Empty tail, round 1 (no trigger ts) ⇒ `injectionHighWaterTs === coveredThroughTs`, and the subsequent `setMeetingMark` is called** — the case the carried formula got wrong. (c) Round 0 ⇒ maxed against `roundZeroTriggerTs`. *Negative-verify: drop `coveredThroughTs` from the max ⇒ (b) fails with `undefined` and no mark write.* **If the ruling goes F1 instead of R2, T2(b) and T5 invert**: `injectionHighWaterTs` is always `undefined` in summary mode and `setMeetingMark` is never called — rewrite both to pin the absence.
- **T3 (C6 pin unchanged).** No summary doc ⇒ the existing full-mode pin at `:770` and the byte-exact assembly pin at `:492` pass **without modification**. Asserted by construction (unedited suite) and called out as a plan review gate.
- **T4 (delta arm never reads summaries).** Delta-eligible agent with a summary doc present ⇒ `getSummary` not called, `injectionMode: "delta"`, delta pin at `:715` byte-unchanged. *Negative-verify: hoist the summary lookup above the eligibility predicate ⇒ fails.*
- **T5 (self-heal leg untouched).** Summary-mode turn with `resumedSession: false` ⇒ `setMeetingMark` (not `clearMeetingMark`) — the `=== "delta"`-exclusive clear branch, mirroring the existing `:1158` full-mode case.
- **T6 (cadence seam, round-level).** A round-0 pass with N responders produces **exactly one** `noteActivity` call, from `resolveConferenceAgents`, carrying the full history; a round-0 pass where the classifier selects **nobody** still produces one (E12 — the seam sits before the responder fan-out). ⚠ A round-1 pass produces one **only when reactors are selected**: `triggerConferenceReactions` returns early on an empty selection, *before* the re-fetch, so the round-1 seam is genuinely selection-gated and the test must not assert otherwise. `getSummary` throwing ⇒ full-arm fallback and the dispatch still completes. *Negative-verify: move the notify into `buildConferenceContext` ⇒ the round-0 call-count assertion fails at N.*

**`src/workers/meeting-scribe.test.ts`** (new)

- **T7 (role-params + containment pin).** Captured `runRoleTurn` args: `model` from `scribeModel` (haiku default), **`coreServers: []`**, `maxTurns: 4`, `timeoutMs: 120_000`, `charter` byte-pinned, and the built config carries `delegateServers: []`. Mirroring Part A's T3 posture, the containment assertion targets the **built server set** on the worker-flagged runner, not the config array alone.
- **T8 (gating table).** Disabled (`enabled` or `scribeEnabled`) ⇒ no run; in-flight ⇒ no run; `scribeMaxConcurrent` reached ⇒ no run; within debounce ⇒ no run; `< scribeMinNewMessages` new ⇒ no run; `pool.hasCapacity()` false ⇒ no run; base agent gone/disabled ⇒ no run. All silent, all retried on the next trigger.
- **T9 (write + single-flight).** Success ⇒ upsert with truncated `summaryText`, `coveredThroughTs` = max ts of the messages fed in, `version` incremented, `updating` cleared. Failure/timeout/abort ⇒ no write, `updating` cleared. A stale `updating` older than `2 × scribeTimeoutMs` ⇒ overridden and the run proceeds.
- **T11 (⚠ synchronous-claim race — issue 3).** Five `noteActivity` calls issued back-to-back in one tick (the `Promise.all` fan-out shape) against a thread with no prior summary ⇒ **exactly one** `runRoleTurn` invocation. *Negative-verify: move the `inFlight.add` below the first `await` in `run()` ⇒ the test observes five invocations.* This is the test that would have caught the reviewed defect, so it must fail on the pre-fix ordering, not merely pass on the fixed one.
- **T12 (⚠ capacity isolation — issue 4).** A live scribe run leaves `pool.hasCapacity()` true and `dispatch()`'s saturation check unaffected: with `maxConcurrent: 4` and one scribe running, four fetch-worker dispatches still succeed. Asserts scribes never appear in `liveWorkers`. *Negative-verify: register the scribe in `liveWorkers` ⇒ the fourth dispatch is refused as saturated.*
- **T10 (no side effects — structural).** A scribe run performs zero writes to `meeting_worker_claims`, zero `onDispatch` calls, and zero `sessions` writes; the scribe id appears in no roster or classifier input.

**`src/config.test.ts`** — `resolveMeetingWorkersConfig` table extended with the seven scribe keys: absent ⇒ defaults; garbage types ⇒ defaults; valid ⇒ passed through.

## Canon compliance

- **C1/C2** — no reaction-tracker reads or writes; the scribe cannot perturb selection or claim recording.
- **C3/C4** — terminal-slot contract and `NON_RESPONSE_PATTERNS` untouched; the two new markers are collision-checked against both (§D4) and the scribe mints no WorkItem, so it has no escape-phrase surface.
- **C6/C10** — the no-summary path stays byte-identical; the summary shape is a **new** pin beside C6, not a modification of it.
- **C7** — a stale summary is at worst the allowed degraded window; every failure heals on the next trigger without operator action (§E2/E3).
- **C9 — ⚠ RELAXATION REQUESTED, not claimed.** `setMeetingMark`/`clearMeetingMark` and their placement are untouched, but the summary arm advances the mark over messages absorbed as *summary* rather than as literal injected text (§D4). C13 grants no such license; this is submitted for the coherence reviewer's ruling. Mitigating: `truncateHistory` (`dispatcher.ts:1323`) already advances the mark past a dropped middle today, so the relaxation is precedented in kind, and the failure direction is duplication, never a gap. Fallback if rejected: §D4.
- **C10** — the delta arm's own shape and predicate are untouched; delta-eligible agents never read a summary.
- **C12** — mark bookkeeping *placement* untouched (the value semantics relaxation is R2, scoped to the summary arm); scribe turns never reach `dispatchToAgent` at all.
- **C13/C26 — ⚠ RELAXATION REQUESTED, not claimed.** The anchor sits at exactly the sanctioned site (`buildConferenceContext`'s full arm). Beyond it, this design adds **two round-level conference hunks** — fire-and-forget `noteActivity` calls in `resolveConferenceAgents` and `triggerConferenceReactions` — which C26 does not sanction. Rationale (freeze prevention), why the C26-clean and delta-arm alternatives are both worse, and the fallback if rejected: §D1. Submitted for the merge-seam ruling, same mechanism as KPR-390's containment relaxations.
- **C14/C15** — resolved structurally (§D2): the scribe is an out-of-band pool worker, never a roster member, so no turn kind, reaction cap, or preamble applies. No new turn kind invented.
- **C18** — the existing `injectionMode` field is **widened**, not paralleled; no new telemetry collection, no `hive doctor` section, no scribe-specific counters.
- **C19** — `delegateServers: []` on the clone; nested delegates structurally unreachable.
- **C21** — auto-injection suppression comes free via `buildWorkerAdapter`; **no second flag-setting site is added** (`runRoleTurn` calls the same hook).
- **C22** — `coreServers: []`, the strongest available posture. Its boundary (SDK builtins survive) is stated at ⚠ Key Point 7 rather than overclaimed.
- **C23** — no new tool surface ⇒ no Lane B inventory compensation needed (§Integration points).
- **C24** — `WorkerRoleParams` lifted verbatim; `runWorkerTurn`/`spawnFetchWorker` receive **zero executable diff hunks**; the new `runRoleTurn`/`hasCapacity` are pure additions, and the capacity fix (§D3) deliberately avoids editing `liveWorkers`/`stop()`/`abortForBoss`/`dispatch()` as well. The forbidden "extract the common core" refactor is called out at ⚠ Key Point 2 as a review gate. **Sanctioned exception:** three now-false doc comments in the file, including `runWorkerTurn`'s own, must be corrected (§Integration points, issue 6).
- **C27** — ⚠ deliberate divergence: the scribe's `ensureIndexes` is **not** boot-fatal, because its only index is TTL housekeeping with no correctness role, unlike the claim ledger's atomicity index (§Integration points, issue 5).

## Open questions / delegated assumptions

**Two canon relaxations are REQUESTED and require a merge-seam ruling** — neither is self-authorized, and each has a stated fallback if rejected:

- **R1 (C26)** — two round-level conference hunks beyond the sanctioned full-arm anchor, for cadence. Fallback: full-arm-only trigger, freeze accepted and measured (§D1).
- **R2 (C9)** — the mark advances over summarized-but-not-literally-injected messages. Precedented in kind by `truncateHistory`'s existing behavior. ⚠ **The relaxation is constitutive of summary mode, not a tunable degree of it** — there is no partially-compliant variant. The only C9-compliant way to ship the feature is **F1: the summary arm sets no mark**, which keeps the cold-path win but costs KPR-388's warm-path delta on any summarized thread. Full three-option menu, traced: §D4.

**Nothing else blocking.** ⚠-flagged spec-chosen calibrations for reviewer attention:

- **Dispatch model (c)** over a self-relaunching daemon or a lazy pull (§D1) — the ticket's largest fork, decided with rationale.
- **`runRoleTurn` as a sibling rather than a `runWorkerTurn` refactor** — C24 over DRY, with ~25 lines of accepted duplication (⚠ Key Point 2).
- **`scribeMaxTurns: 4`** rather than the carried 8 (§D3).
- **`injectionMode` widened to `"summary"`** — four sites in three files outside `dispatcher.ts`, justified by C18 measurability (§D4).
- **`scribeEnabled` as a second kill switch** beside `enabled` — the rollback lever for the prompt-shape change (§D6).
- **Base-config choice = a roster member of the triggering round** ⇒ `budgetUsd` varies by trigger (§D3).
- **Separate `scribeMaxConcurrent` instead of sharing `maxConcurrent`** — the issue-4 capacity disposition; costs one config key and buys zero Part A behavioral edits (§D3).
- **`SUMMARY_TEXT_CAP` 2500 vs the charter's 2000** — deliberate headroom, not a mismatch to align (§D3a).
- **Debounce/novelty pair (90s / 6 messages)** — calibrations, tunable via config.
