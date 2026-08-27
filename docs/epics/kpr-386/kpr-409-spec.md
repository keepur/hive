# KPR-409 — Scribe role: running meeting summary as the fresh-session anchor

**Epic:** KPR-386 (meeting mode) · **Blocked by:** KPR-390 (merged, `b611348`) · **Last child of the epic**
**Lifted from:** Part B of `docs/epics/kpr-386/kpr-390-spec.md`, re-verified against merged `main`-line reality (§Code-verification deltas).

## TL;DR

A fresh session entering a 105-message meeting today gets the raw transcript injected (KPR-388's `full` arm). This ticket adds a **scribe**: a cheap (`haiku`), tool-less pool worker that maintains a per-thread **running summary** in a new `meeting_summaries` collection, and rewires `buildConferenceContext`'s full arm to inject **summary + messages-since-summary** instead of the raw transcript. The scribe is *not* a meeting participant, *not* a conference turn, and has *no* posting surface. Failure degrades silently to today's exact behavior.

## ⚠ Key Points

1. **⚠ The carried Part B claim "the scribe reuses `runWorkerTurn` verbatim" is FALSE against merged code.** `runWorkerTurn(claim, boss, role)` is claim-coupled end-to-end — it builds its prompt from `workerTaskPrompt(claim)`, its context from `workItemContextFromClaim(claim)`, and terminates through `finishClaim(claim, …)`, which writes the claim ledger **and fires `dispatchReentry` → a `worker:<claimId>` WorkItem that makes the boss post the result into the room.** A scribe on that path would post its summary to the meeting every 90 seconds. The scribe therefore gets a **new sibling** `MeetingWorkerPool.runRoleTurn()` — an *addition* to `meeting-worker-pool.ts`, with **zero diff hunks inside `runWorkerTurn`/`spawnFetchWorker`** (C24 satisfied literally). `WorkerRoleParams` *is* lifted verbatim as the role type.
2. **⚠ Do NOT refactor `runWorkerTurn` to delegate to `runRoleTurn`.** The ~25 lines of adapter-invocation skeleton are duplicated on purpose: C24 freezes Part A's spawn path, and C24 outranks DRY here. A reviewer's "extract the common core" is the one refactor this spec forbids.
3. **⚠ The C13/C26 conference-code touch is exactly one function: `buildConferenceContext`.** It carries *both* the anchor branch (full arm) and the cadence notification (arm-agnostic, fire-and-forget). This is **tighter than the carried design**, which put the cadence seam in `dispatchToAgent` — a second conference-path hunk this spec eliminates.
4. **⚠ Dispatch model decision: activity-triggered debounced re-dispatch, not a self-relaunching daemon and not a lazy pull.** The meeting's own message flow is the clock (§D1) — no new recurring-dispatch mechanism, no latency added to the turn being optimized.
5. **⚠ The high-water formula MUST change** — `injectionHighWaterTs` in summary mode maxes in `summary.coveredThroughTs` alongside the tail. The carried design said "unchanged formula"; verified reality shows an empty tail would yield `undefined` on round 1, `setMeetingMark` would be skipped (`dispatcher.ts:1106`), and the agent would never convert to delta. Correctness-relevant, not cosmetic (§D4).
6. **⚠ `injectionMode` widens to `"full" | "delta" | "summary"`** across four small sites so the epic can measure its own last child (C18: widening the existing KPR-389 field, not adding a parallel one). Load-bearing check: `dispatcher.ts:1100`'s self-heal leg is `=== "delta"`-exclusive and stays correct unmodified.
7. **⚠ No new tool surface ⇒ C23 is a structural no-op.** The scribe declares `coreServers: []` (C22) and adds no MCP server, no MCP tool, and no entry to `in-process-servers.ts` — so there is nothing for Lane B's `buildToolTransportInventory` to compensate for. Stated explicitly so the review can confirm rather than infer.
8. **⚠ `coreServers: []` removes MCP surfaces, not SDK builtins.** Under `bypassPermissions` the scribe still holds Read/Write/Bash. That is the identical posture as Part A's fetch-worker (E5's stated boundary) — `maxTurns: 4` is the bound, not a permission gate. C22 is the strongest *available* option, not an absolute sandbox.
9. **Never a correctness dependency.** No summary doc, a stale one, a failed scribe run, a saturated pool, `scribeEnabled: false` — every path falls through to today's byte-identical full transcript. C6's pin stays green unmodified.

---

## Problem

KPR-388 gave meeting agents delta injection: an agent with a live session and a `meetingLastSeenTs` mark receives only new messages. But the **`full` arm** — every agent's first turn in a thread, plus every session-TTL/provider-handoff miss — still injects the raw transcript through `formatThreadContext`, capped at first-5 + last-100 (`truncateHistory`). In a long conference that is ~105 messages of prompt on the exact turn a late entrant is trying to answer quickly. KPR-388 named this explicitly as out of scope and left the hook:

> "Preserved hook: the fresh-session branch is a single site (`buildConferenceContext`'s `mode: "full"` arm) where a future summary+recent-delta assembly can replace the raw transcript without touching the delta arm or the mark mechanics." — `kpr-388-spec.md:43`

KPR-390 delivered the machinery that makes a cheap background summarizer possible (detached, sessionless, breaker-invisible, budget-exempt worker spawns with structural containment). This ticket joins the two.

## Goals

- G1. A per-thread **running summary** is maintained during an active meeting by a cheap, tool-less worker.
- G2. `buildConferenceContext`'s full arm injects **summary + messages-since-summary** when a summary exists.
- G3. Every failure mode degrades to today's exact behavior, silently.
- G4. The scribe is measurable through the existing KPR-389 telemetry surface (C18).

## Non-goals

- **Not** a conference participant. No roster membership, no classifier candidacy, no reaction-pass exposure, no posting surface (§D2).
- **Not** a change to the delta arm, `meetingLastSeenTs` mark mechanics, `setMeetingMark`/`clearMeetingMark`, the reaction tracker, the preamble, or spawn shaping.
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
| (c) | **Activity-triggered debounced re-dispatch** — every `buildConferenceContext` call notifies the scribe fire-and-forget; the scribe debounces and runs at most one turn per thread at a time | **CHOSEN.** |

**Rationale for (c).** It satisfies the ticket's "standing worker maintaining a running summary" behaviorally — the summary *is* continuously maintained during an active meeting — without inventing a scheduler: **the meeting's own message flow is the clock.** `buildConferenceContext` is invoked once per dispatched conference agent per round, in *both* arms, so an active meeting produces a steady trigger stream even after every participant has converted to delta. Compare (b'), a fire-and-forget pull fired *only* from the full arm: in a stable-roster meeting the full arm stops firing after each participant's first turn, so the summary would freeze at ~message 5 and a late joiner at message 105 would get `summary(first 5) + 100-message tail` — no better than today. Notifying from both arms is the same one-site edit with correct coverage.

Concretely: `buildConferenceContext` ends (both arms, after the return value is computed) with a synchronous-return, never-throwing

```ts
this.meetingScribe?.noteActivity({ threadId, history, channelName, roster, baseAgentId: agentId });
```

`noteActivity` returns `void` immediately; all async work is internal and `.catch`-terminated. Gating inside the scribe, in order — every miss is a silent no-op that will be re-evaluated on the next trigger:

1. `config.meetingWorkers.enabled && scribeEnabled` — else skip.
2. Thread already has a run in flight (in-memory `Set<threadId>`, or a `meeting_summaries.updating.startedAt` newer than `2 × scribeTimeoutMs`) — else skip.
3. Debounce: `now - lastRunAt(threadId) < scribeDebounceMs` (default 90s) — else skip.
4. Novelty: fewer than `scribeMinNewMessages` (default 6) messages with `ts > coveredThroughTs` — else skip. (First run on a thread: `coveredThroughTs` absent ⇒ every message counts, so a meeting summarizes as soon as it is 6 messages deep.)
5. Pool capacity: `pool.hasCapacity()` (`liveWorkers.size < maxConcurrent`) — else skip. Fetch-workers, which are on someone's critical path, win contention; the scribe is an optimization and yields.

Then: set `updating`, run the turn, write the summary, clear `updating`, stamp `lastRunAt`. The `finally` clears the in-memory flag and `updating` on every path including throw.

**"Standing" is behavioral, not process-level** — there is no long-lived scribe process, no timer, and nothing to leak across a restart beyond a possibly-stale `updating` field, which the staleness override clears.

### D2. Turn kind — C14/C15 resolved structurally

**The scribe is a pool worker, never a meeting participant.** It is never added to `meetingRosters`, never appears in a classifier candidate list (round 0 or the reaction pass), and never receives a conference dispatch. It therefore never enters conference round classification at all: the 6-turn/120s round-1 reaction clamp, the decline-immediately preamble, the reaction tracker, and the kill-suppression leg are all structurally unreachable, not merely avoided. C14/C15's "forced decision" is answered by the architecture rather than by a new turn kind — **no roster, classifier, preamble, or shaping code is touched.**

Its turn runs on `MeetingScribe` → `pool.runRoleTurn()` → `manager.buildWorkerAdapter()` → `adapter.runTurn()`: sessionless, lock-exempt, breaker-invisible, not `spawnBudget`-accounted — every property inherited from Part A's `buildWorkerAdapter` hook, unchanged.

### D3. The scribe turn — role params, base config, storage

**`runRoleTurn` (new public method on `MeetingWorkerPool`, sibling to `runWorkerTurn`; ~25 lines).**

```ts
runRoleTurn(args: {
  key: string;                       // live-worker key, e.g. `scribe:<threadId>`
  base: AgentConfig;                 // config to clone
  role: WorkerRoleParams;            // lifted type, unchanged
  prompt: string;
  workItemContext: { adapterId; channelId; channelKind; channelLabel; threadId; slackTs; slackThreadTs };
}): Promise<{ text?: string; error?: string; timedOut?: boolean; aborted?: boolean;
              costUsd?: number; toolCalls?: number; durationMs: number } | null>   // null = no capacity / not bound
```

Body mirrors `runWorkerTurn`'s clone-and-run core — `{ ...base, model: role.model, coreServers: role.coreServers, delegateServers: [], schedule: [] }`, `buildWorkerAdapter`, register in `liveWorkers` under `key`, `runTurn({ prompt, sessionId: undefined, workItemContext, resourceLimits: { maxTurns, timeoutMs, budgetUsd: base.budgetUsd }, systemPromptOverride: role.charter })`, `finally { liveWorkers.delete(key) }` — and **returns the raw outcome**. It touches no collection and dispatches nothing. Registering in `liveWorkers` is deliberate: it makes scribe runs visible to `pool.stop()` (shutdown aborts them) and to `abortForBoss` (§E5), and makes them count against `maxConcurrent`.

**Role params.**

| Field | Value | Rationale |
|---|---|---|
| `model` | `config.meetingWorkers.scribeModel`, default `"haiku"` | Summarization is the cheapest useful task in the engine. |
| `coreServers` | `[]` | **C22.** Not "boss minus denylist" — the transcript is in the prompt; the scribe needs nothing. See ⚠ Key Point 8 for the boundary. |
| `delegateServers` | `[]` | Set by `runRoleTurn`'s clone (C19 — no nesting). |
| `maxTurns` | `scribeMaxTurns`, default **4** | ⚠ **Deviation from the carried design's 8.** With `coreServers: []` there is no MCP tool loop to iterate; 8 was sized before C22 pinned the empty set. 4 is a runaway bound, not a working budget. |
| `timeoutMs` | `scribeTimeoutMs`, default `120_000` | Carried unchanged. |
| `charter` | §D3a | Total `systemPromptOverride` replacement (voice/fetch-worker precedent — no soul, no constitution). |

**Base config.** `runRoleTurn` needs an `AgentConfig` to clone. The scribe uses the **triggering agent's** config — `baseAgentId` captured at the seam, re-resolved live from the registry at run time (mirroring `spawnFetchWorker`'s `registry.get` re-check; missing or disabled ⇒ silent skip, retried on the next trigger). With `coreServers: []`, `delegateServers: []`, model and system prompt all overridden, the only fields that survive the clone are `budgetUsd` (the operator's per-turn cost cap — correctly still binding) and the id/name used for logging and `liveWorkers` bookkeeping. ⚠ Consequence to note at review: `budgetUsd` therefore varies with whichever participant happened to trigger the run. Accepted — a tool-less haiku turn under a 4-turn cap is far below any realistic per-turn cap.

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

### D4. C13 anchor integration — the only conference-code edit

`buildConferenceContext` (`src/channels/dispatcher.ts:1337`), **full arm only**. The delta arm, the delta-eligibility predicate, and every mark mechanic are untouched.

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

**⚠ The `coveredThroughTs` max-in is required, not cosmetic.** The carried design asserted "unchanged formula". Verified: when the tail is empty (the summary already covers the whole thread), round 1 passes no `roundZeroTriggerTs`, so the old formula yields `undefined`; `dispatchToAgent:1106`'s `else if (resolved.injectionHighWaterTs)` then skips `setMeetingMark`, and the agent never converts to delta — it re-enters the summary arm on every subsequent turn forever. Maxing in `coveredThroughTs` is also the semantically correct mark: the session absorbed a summary that *covers* those messages. This is precisely the C13-authorized relaxation of C9/C10's literal-message coverage to **semantic** coverage, confined to this arm and named here.

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
| `scribeMaxTurns` | `4` | ⚠ deviation from the carried 8 — §D3. |
| `scribeTimeoutMs` | `120_000` | No TTL-clamp interaction: the scribe creates no claim, so `claimTtlMinutes`'s invariant is untouched. |

## Integration points

**New files**
- `src/workers/meeting-scribe.ts` — `MeetingScribe`: `noteActivity()`, `getSummary()`, gating, single-flight, `meeting_summaries` access, prompt + charter builders (exported for byte pins), `ensureIndexes()`, `stop()`.
- `src/workers/meeting-scribe.test.ts`.

**Modified**
- `src/workers/meeting-worker-pool.ts` — **additive only**: public `runRoleTurn()` and `hasCapacity()`. ⚠ Zero diff hunks inside `runWorkerTurn` / `spawnFetchWorker` / `dispatch` / `finishClaim` / `dispatchReentry` / the sweeps (C24 review gate).
- `src/workers/worker-pool-config.ts` — six scribe keys + defaults.
- `src/config.ts` — six resolver lines in `resolveMeetingWorkersConfig`.
- `src/channels/dispatcher.ts` — `setMeetingScribe()` (setter-injection precedent: `setSlackAdapter`/`setTeamStore`); the `buildConferenceContext` full-arm branch + `noteActivity` call; `formatSummaryContext`; the `ResolvedAgent.injectionMode` widening. **These are the pair's only conference-code edits (C13/C26).**
- `src/agents/agent-manager.ts` — `conferenceInjectionModeOf` narrowing widened; `MeetingScribe` bound to the same `WorkerPoolManagerHooks` (see below). ⚠ `setWorkerPool`'s hook literal is **not** restructured — the scribe is constructed with the pool as a dep and calls `pool.runRoleTurn()`, so the existing single `bindManager` site remains the only manager binding.
- `src/index.ts` — construct `MeetingScribe({ db, registry, pool: workerPool, config: config.meetingWorkers })` after the pool, `await scribe.ensureIndexes()`, `dispatcher.setMeetingScribe(scribe)`, `scribe.stop()` in the shutdown block beside `workerPool.stop()`.
- `CLAUDE.md` — `meeting_summaries` in the collections list.
- `docs/epics/kpr-386/kpr-390-spec.md` — Part B annotated as superseded by this spec (pointer only).

**Explicitly untouched:** `in-process-servers.ts`, `worker-pool-mcp-server.ts`, `agent-runner.ts`, `session-store.ts`, `outage-notices.ts`, `docs/providers.md`, every provider adapter, `buildToolTransportInventory`, the roster/classifier/preamble/reaction-tracker code, and the claim ledger.

**C23:** the scribe introduces no MCP server and no tool. `buildToolTransportInventory` needs no compensation because there is nothing to compensate — Lane B agents are affected by this ticket only as *readers* of a shorter injected prompt, which is provider-agnostic by construction.

## Edge cases

- **E1 Meeting ends before the first summary.** No doc ⇒ full arm returns today's exact three lines. Nobody notices.
- **E2 Scribe turn fails / times out / errors.** No write; `updating` cleared in `finally`; the prior summary (if any) stands and the tail lengthens toward today's behavior at the 100-cap. **Never blocks a meeting turn** — `noteActivity` is fire-and-forget and `getSummary` is fail-soft (`.catch(() => undefined)`), so a Mongo hiccup at read time degrades to full injection rather than failing the dispatch.
- **E3 Stale summary.** Bounded degradation only: the tail grows, and at the 100-cap the injection is exactly today's size. C7's one-degraded-turn allowance covers the window; the next scribe run heals it.
- **E4 Concurrent summary writes.** Prevented by the in-memory single-flight set (single-process engine) and the `updating` doc guard with a `2 × scribeTimeoutMs` staleness override (crash-leftover recovery). If both were somehow defeated, the upsert is last-write-wins and the later `coveredThroughTs` is strictly better — no corruption path exists.
- **E5 Engine restart / shutdown mid-scribe.** `pool.stop()` aborts the live handle (the scribe registers in `liveWorkers`); no ledger doc exists to sweep; a leftover `updating` is cleared by the staleness override on the next trigger. `abortForBoss(agentId)` will also abort a scribe run whose incidental base config came from that agent — accepted and correct (fail-soft, retried on the next trigger).
- **E6 Pool saturated by fetch-workers.** Scribe skips (gate 5). Fetch-workers are on someone's critical path; the scribe is an optimization.
- **E7 Very long meeting.** The summary is capped at 2500 chars on write and the tail at 100 messages, so summary-mode injection has a hard ceiling *below* today's. The failure mode is summary *quality* drift over hundreds of messages, not size — accepted for this ticket (the alternative, hierarchical summarization, is explicitly out of scope).
- **E8 Base agent deleted/disabled between trigger and run.** Live registry re-check ⇒ silent skip, retried on the next trigger. (Mirrors Part A's E6 guard, minus the re-entry hazard — the scribe dispatches nothing, so a step-0 miss is structurally impossible.)
- **E9 Non-meeting thread.** `noteActivity` is only ever called from `buildConferenceContext`, which is conference-only by construction. No gate needed; stated so the review can confirm it.
- **E10 `scribeEnabled: false` mid-meeting with a live summary doc.** `getSummary` short-circuits on the flag before reading, so the anchor reverts immediately; the stale doc ages out on its TTL.
- **E11 Provider handoff (KPR-313) or session TTL on a summarized thread.** The agent re-enters the full/summary arm and gets the summary — which is the whole point. Mark bookkeeping is unchanged.

## Test plan

Negative-verify per repo convention (revert the source hunk, confirm the new test fails) for T1, T2, T4, T6.

**`src/channels/dispatcher-conference.test.ts`** (additions; the existing 28 cases must pass **unedited** — a review gate)

- **T1 (summary-mode byte pin).** Summary doc present + fresh-session ref ⇒ `threadContext` byte-exact against the pinned `formatSummaryContext` shape (both markers present, neither `[New message]:` nor `[New messages since your last turn:]` present), `injectionMode: "summary"`. Table row: empty tail ⇒ no dangling `[Messages since the summary:]` header. *Negative-verify: revert the anchor branch ⇒ the pin fails with the raw-transcript shape.*
- **T2 (high-water formula).** ⚠ The correction pin. (a) Non-empty tail ⇒ `injectionHighWaterTs === max(tail ts)`. (b) **Empty tail, round 1 (no trigger ts) ⇒ `injectionHighWaterTs === coveredThroughTs`, and the subsequent `setMeetingMark` is called** — the case the carried formula got wrong. (c) Round 0 ⇒ maxed against `roundZeroTriggerTs`. *Negative-verify: drop `coveredThroughTs` from the max ⇒ (b) fails with `undefined` and no mark write.*
- **T3 (C6 pin unchanged).** No summary doc ⇒ the existing full-mode pin at `:770` and the byte-exact assembly pin at `:492` pass **without modification**. Asserted by construction (unedited suite) and called out as a plan review gate.
- **T4 (delta arm never reads summaries).** Delta-eligible agent with a summary doc present ⇒ `getSummary` not called, `injectionMode: "delta"`, delta pin at `:715` byte-unchanged. *Negative-verify: hoist the summary lookup above the eligibility predicate ⇒ fails.*
- **T5 (self-heal leg untouched).** Summary-mode turn with `resumedSession: false` ⇒ `setMeetingMark` (not `clearMeetingMark`) — the `=== "delta"`-exclusive clear branch, mirroring the existing `:1158` full-mode case.
- **T6 (cadence seam).** `buildConferenceContext` calls `noteActivity` in **both** arms with the thread's full history; `getSummary` throwing ⇒ full-arm fallback and the dispatch still completes. *Negative-verify: restrict the notify to the full arm ⇒ the delta-arm assertion fails.*

**`src/workers/meeting-scribe.test.ts`** (new)

- **T7 (role-params + containment pin).** Captured `runRoleTurn` args: `model` from `scribeModel` (haiku default), **`coreServers: []`**, `maxTurns: 4`, `timeoutMs: 120_000`, `charter` byte-pinned, and the built config carries `delegateServers: []`. Mirroring Part A's T3 posture, the containment assertion targets the **built server set** on the worker-flagged runner, not the config array alone.
- **T8 (gating table).** Disabled (`enabled` or `scribeEnabled`) ⇒ no run; in-flight ⇒ no run; within debounce ⇒ no run; `< scribeMinNewMessages` new ⇒ no run; `pool.hasCapacity()` false ⇒ no run; base agent gone/disabled ⇒ no run. All silent, all retried on the next trigger.
- **T9 (write + single-flight).** Success ⇒ upsert with truncated `summaryText`, `coveredThroughTs` = max ts of the messages fed in, `version` incremented, `updating` cleared. Failure/timeout/abort ⇒ no write, `updating` cleared. A stale `updating` older than `2 × scribeTimeoutMs` ⇒ overridden and the run proceeds.
- **T10 (no side effects — structural).** A scribe run performs zero writes to `meeting_worker_claims`, zero `onDispatch` calls, and zero `sessions` writes; the scribe id appears in no roster or classifier input.

**`src/config.test.ts`** — `resolveMeetingWorkersConfig` table extended with the six scribe keys: absent ⇒ defaults; garbage types ⇒ defaults; valid ⇒ passed through.

## Canon compliance

- **C1/C2** — no reaction-tracker reads or writes; the scribe cannot perturb selection or claim recording.
- **C3/C4** — terminal-slot contract and `NON_RESPONSE_PATTERNS` untouched; the two new markers are collision-checked against both (§D4) and the scribe mints no WorkItem, so it has no escape-phrase surface.
- **C6/C10** — the no-summary path stays byte-identical; the summary shape is a **new** pin beside C6, not a modification of it.
- **C7** — a stale summary is at worst the allowed degraded window; every failure heals on the next trigger without operator action (§E2/E3).
- **C9/C10** — mark mechanics untouched. The literal-message covering invariant is relaxed to **semantic** coverage on exactly the C13-authorized arm, named explicitly at §D4, and paired with the `coveredThroughTs` max-in that makes the relaxed mark truthful.
- **C12** — mark bookkeeping placement untouched; scribe turns never reach `dispatchToAgent`.
- **C13/C26** — the anchor integrates at exactly `buildConferenceContext`, which is also the *only* function carrying the cadence seam. One function, one file, both hunks. Tighter than the carried design.
- **C14/C15** — resolved structurally (§D2): the scribe is an out-of-band pool worker, never a roster member, so no turn kind, reaction cap, or preamble applies. No new turn kind invented.
- **C18** — the existing `injectionMode` field is **widened**, not paralleled; no new telemetry collection, no `hive doctor` section, no scribe-specific counters.
- **C19** — `delegateServers: []` on the clone; nested delegates structurally unreachable.
- **C21** — auto-injection suppression comes free via `buildWorkerAdapter`; **no second flag-setting site is added** (`runRoleTurn` calls the same hook).
- **C22** — `coreServers: []`, the strongest available posture. Its boundary (SDK builtins survive) is stated at ⚠ Key Point 8 rather than overclaimed.
- **C23** — no new tool surface ⇒ no Lane B inventory compensation needed (§Integration points).
- **C24** — `WorkerRoleParams` lifted verbatim; `runWorkerTurn`/`spawnFetchWorker` receive **zero diff hunks**; the new `runRoleTurn`/`hasCapacity` are pure additions. The forbidden "extract the common core" refactor is called out at ⚠ Key Point 2 as a review gate.

## Open questions / delegated assumptions

**None blocking.** ⚠-flagged spec-chosen calibrations for reviewer attention:

- **Dispatch model (c)** over a self-relaunching daemon or a lazy pull (§D1) — the ticket's largest fork, decided with rationale.
- **`runRoleTurn` as a sibling rather than a `runWorkerTurn` refactor** — C24 over DRY, with ~25 lines of accepted duplication (⚠ Key Point 2).
- **`scribeMaxTurns: 4`** rather than the carried 8 (§D3).
- **`injectionMode` widened to `"summary"`** — four sites in three files outside `dispatcher.ts`, justified by C18 measurability (§D4).
- **`scribeEnabled` as a second kill switch** beside `enabled` — the rollback lever for the prompt-shape change (§D6).
- **Base-config choice = triggering agent** ⇒ `budgetUsd` varies by trigger (§D3).
- **`SUMMARY_TEXT_CAP` 2500 chars** and the debounce/novelty pair (90s / 6 messages) — calibrations, tunable via config.
