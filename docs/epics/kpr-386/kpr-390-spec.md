# KPR-390 — Meeting worker pool: async workers with claim ledger and scribe

**Epic:** KPR-386 (meeting mode) — capstone, follows merged KPR-387 + KPR-388 + KPR-389 (epic branch @ 6e87bbb).
**Status:** draft, pending review.
**Scope ruling (operator-approved split):** **Part A of this spec is KPR-390's deliverable.** Part B (scribe) is **KPR-409**'s design (child of the epic, blocked by KPR-390; the epic PR waits for both) — kept in this document deliberately so KPR-409's maturation lifts it verbatim. KPR-390's plan derives from Part A alone.
**Decision-register canon:** C1–C20 bind this spec; the KPR-389 coherence review pre-posted four bindings on this ticket (scribe turn-kind forced; C13 single anchor site; C18 existing-instrumentation preference; C19/E2 delegate-budget hazard) — all four are dispositioned explicitly in §Design and §Canon (the scribe-side bindings 1 and 2 now bind KPR-409 via Part B).

## TL;DR

Conference agents currently do data legwork inside their own frontier-model turns — 70–150s observed, lock-holding, repeated by every participant. Fix: a **meeting worker pool** — a new in-process MCP server (`worker-pool`) that lets a boss agent atomically claim a task in a per-meeting Mongo **claim ledger** (`meeting_worker_claims`, exact-key unique-index atomicity + best-effort semantic dedup via a `workerClaimDedup` sidecar-classifier call), dispatch a **detached claude-lane worker** (sonnet-pinned via a cloned agent config, boss's toolkit minus an outbound-communication denylist, `systemPromptOverride` charter, sessionless, breaker-invisible, NOT budget-accounted), and end his turn immediately. Worker completion re-enters through the **existing callback re-entry shape**: a `worker:<claimId>` WorkItem with `meta.targetAgentId` dispatched through the scheduler-style `onDispatch` seam — resolveAgents step 0 pins the boss, the per-thread session carries the meeting context, and the boss interprets and posts the finding to the room himself (through-the-boss, operator decision); thread-as-blackboard + KPR-388 delta injection distribute it to every other participant exactly once. The **scribe** (running-summary worker + C13 full-injection anchor) is designed here as a cleanly severable Part B — **split approved by the operator: Part B is ticket KPR-409** (blocked by KPR-390; §Scope ruling). **KPR-390 delivers Part A only** — a complete, shippable, testable slice that touches zero conference-injection code.

## Key Points

- **⚠ Scope ruling (operator-approved): the scribe is split out — Part B is ticket KPR-409; KPR-390 delivers Part A only.** Part A (fetch-workers + claim ledger + re-entry) is complete and shippable alone and **touches `dispatcher.ts` not at all** — its only engine-plumbing edits outside the new module are a one-line `policyFor` addition (`src/outage/outage-notices.ts`) and `index.ts` wiring; Part B is the only half that edits `buildConferenceContext`'s full arm (C13) and carries its own storage, cadence, and pins. The ticket coupled them as "two roles of one pool" — the pool abstraction survives the split (the scribe reuses `runWorkerTurn` verbatim). Part B stays in this document deliberately so KPR-409's maturation lifts it verbatim; nothing in Part A's contract depends on Part B landing.
- **Re-entry mechanics verified — nothing new needs inventing.** The callback path already does agent re-entry into a live thread: `agent_callbacks` doc → scheduler poller → WorkItem `{id: "callback:<id>", meta.targetAgentId, source/threadId from stored context}` → `onDispatch` → `resolveAgents` step 0 pin → single-dispatch leg → reply delivered into the Slack thread via `meta.slackThreadTs`. The pool reuses that WorkItem shape byte-for-byte but dispatches **directly through the same `onDispatch` seam the scheduler holds** (no poller, no 30s latency, no `agent_callbacks` write) — durability lives in the claim ledger instead, which the completion path transitions atomically before dispatching.
- **⚠ The re-entry boss turn is deliberately NOT a conference turn.** targetAgentId-pinned items skip `resolveConferenceAgents` (verified: dispatcher step 0 precedes step 0.7), so the re-entry turn gets no preamble/injection/round meta and no reaction caps — correct: the boss's meeting-thread session already holds the meeting (KPR-388 covering invariant), the report prompt is self-contained, and a full-resource turn is right for report-writing. Consequence (also deliberate, YAGNI): **the boss's posted finding triggers no round-1 reaction pass** — participants receive it as delta on their next natural trigger. Follow-up trigger: if post-deploy meetings show findings consistently landing dead (no engagement on the next human turn), file a reaction-pass follow-up rather than pre-building it.
- **⚠ Workers are NOT `spawnBudget`-accounted — a deliberate divergence from KPR-354.** Nested delegates run *inside* a turn and correctly count against the boss's budget; pool workers are detached, run for minutes, and the boss's **re-entry turn needs a free budget slot when the worker completes** — a worker holding a boss slot could deadlock its own report. Bounds instead: engine-wide `meetingWorkers.maxConcurrent` (default 4) + per-meeting cap (default 3), enforced at claim time.
- **⚠ C19/E2 dispositioned: worker lifecycle is owned by the pool service, never by the dispatching turn's abort chain.** `worker_dispatch` from a 120s-capped round-1 reaction turn returns instantly and the worker survives the parent turn's kill — the KPR-389 clamp cannot orphan a dispatched worker. Workers are also structurally barred from nesting delegates (`delegateServers: []` in the cloned config; workers are claude-lane, so the Lane B nested-runner is unreachable anyway).
- **⚠ Claim atomicity is exact-key; semantic dedup is best-effort — per ticket.** A partial unique index on `(threadId, taskKey)` where `status: "running"` makes "I got this" atomic under round-0 fan-out races (loser's insert throws duplicate-key → "already claimed by <agent>, in progress"). The `workerClaimDedup` sidecar call (new `LLMTask`, classifier-grade model, meeting-classifier precedent) runs *before* insert against open claims and catches near-equivalents; its failure/no-key path degrades to exact-key only — a rare duplicate fetch is minor waste, not a correctness failure (ticket-explicit).
- **Through-the-boss is enforced by tool gating, not prose.** The worker's cloned config strips `WORKER_SERVER_DENYLIST` (slack, quo, resend, team, event-bus, callback, schedule, recall, voice, admin, worker-pool) from `coreServers` — a worker has no outbound-message surface, no self-scheduling, no recursive dispatch; its only output channel is its return value, which reaches the room exclusively through the boss's re-entry turn (code-enforce-don't-prose-enforce).
- **⚠ Scribe turn-kind decision (binding 1, forced — recorded here, binds KPR-409): the scribe is a pool worker, not a roster member — a third, out-of-band path.** It never enters `meetingRosters` or the classifier's candidate lists, therefore never inherits round-1 caps (C14/C15) or the decline-immediately preamble, and never posts to the thread. Its cadence trigger and summary write live entirely in the pool service; its output integrates at exactly the C13 anchor site (`buildConferenceContext` full-injection arm) and nowhere else.
- **Risk (KPR-390 = Part A): medium.** One new in-process MCP server + pool service module, one new collection (+ 7d cleanup TTL), one new `LLMTask`, one `policyFor` line, one config section, index wiring, a `stopAgent` hook. Zero changes to conference resolution, injection, marks, preamble, tracker, or spawn shaping in Part A — the KPR-387/388/389 pins all stay byte-green untouched.

## Problem

Verified against merged code (epic branch @ 6e87bbb) and production `#conf-tahoe` observations (2026-08-25):

1. **Legwork runs inside frontier turns.** A conference agent that needs data (a doc, numbers, state) does the fetch inside its own turn — the KPR-389 telemetry shows round-0 primaries at 70–150s dominated by tool time. The per-thread lock (`agentId:threadId`) is held the whole time, serializing that agent's other meeting turns behind the fetch.
2. **Every participant repeats the work.** Nothing coordinates acquisition: two agents asked "what were Q2 numbers?" both go fetch. Round-0 fan-out is concurrent, so even an agent that *says* "I'll pull that" loses the race — prose is not a lock.
3. **The reaction caps make it worse, not better, for real fetches.** KPR-389 correctly clamps reaction turns to 6 turns/120s — a reaction that genuinely needs a multi-minute fetch now gets killed (E2, accepted there). The missing piece is the sanctioned alternative: dispatch the fetch *out* of the capped turn.
4. **Fresh-session meeting entry re-reads raw transcript.** `buildConferenceContext`'s full arm injects up to 105 raw messages; KPR-388 named the summary-anchor replacement as KPR-390's hook (C13). Nothing maintains such a summary today.

What exists to build on (verified): callback-style re-entry (scheduler → `onDispatch` → step-0 pin → threaded delivery); the KPR-354 nested-runner template (per-spawn runner construction, abort containment, never-throws result shaping); `systemPromptOverride` as a total prompt-replacement channel (voice precedent, threaded through `ClaudeAgentAdapter.runTurn`); the in-process MCP + `*ContextRef` per-turn threading convention (callback server); the sidecar-classifier call shape (`generateForTask` + jsonSchema, meeting-classifier precedent); `policyFor`'s id-prefix outage policy.

## Goals

1. A boss agent in a meeting can dispatch a data-acquisition task to a cheap detached claude-lane worker with one tool call and end his turn immediately.
2. "I got this" is atomic per meeting: concurrent bosses dispatching the same (or near-equivalent) task converge to one worker; the loser learns who holds the claim and can say so in-thread.
3. Worker completion re-triggers the claiming boss in the meeting thread; the boss interprets and posts the finding himself. Workers have no path to post anywhere.
4. Orphaned claims (worker died, engine restarted, boss deleted) recover via TTL/watchdog with an honest notice to the boss — never a silently stuck "in progress".
5. (Part B — **KPR-409's goal**, designed here, not part of KPR-390's deliverable) A standing scribe maintains a running meeting summary that replaces the raw transcript in the full-injection arm for fresh-session entrants.
6. Regression tests, negative-verified per repo convention; all existing KPR-387/388/389 pins stay green **unmodified** in Part A. (KPR-390's acceptance = goals 1–4 + 6.)

## Non-goals

- **(KPR-390) Everything in Part B** — scribe worker, `meeting_summaries`, cadence seam, C13 anchor edit: split to **KPR-409** per the scope ruling. KPR-390 ships no scribe code, no scribe config keys, and no `buildConferenceContext` change.
- **Non-claude workers.** Ticket-explicit: claude-only workers accepted for now. The pool records `workerModel` per claim so a future lane widening is additive.
- **A reaction pass on the boss's posted finding** (deliberate, trigger-gated — Key Points).
- **Worker use outside meetings.** Tools refuse when the current turn's channel label is not `conf-*` — `bg_execute` (shell) and the SDK Task tool (in-turn) remain the general-purpose paths. Widening is a separate product decision.
- **Worker turns in `agent_turn_telemetry` / `activity_log`.** C18 prefers existing surfaces; the claim ledger *is* the worker measurement surface (status, durations, cost) plus log lines. No new telemetry kinds.
- **Per-worker streaming/progress into the thread** (a "working…" indicator) — rejected in brainstorm lineage; the boss's "let me have someone pull that" is the room-visible signal.
- **KPR-389 items** (spawn shaping, preamble — untouched), **KPR-388 items** (marks, delta rule — untouched), staleness culling, C5 disposition (owned by KPR-389's measure-first trigger).
- **Multi-engine coordination.** Single-process pool; the ledger is Mongo but workers are in-process (restart sweep handles the gap).

## Scope ruling (operator-approved split)

**Ruling: Part B (scribe) is split out as ticket KPR-409 (child of the epic, blocked by KPR-390; the epic PR waits for both). KPR-390 keeps Part A (fetch-worker core + claim ledger + re-entry) as its sole deliverable. KPR-390's implementation plan must be derivable from Part A alone.**

- Part A is a complete, independently shippable, independently testable slice: it adds capability without touching any conference-injection code path — C6/C10/C3 pins stay byte-identical, so its review surface is almost disjoint from the KPR-387–389 stack.
- Part B is the only half that edits `buildConferenceContext` (C13 anchor), needs its own storage (`meeting_summaries`), its own cadence trigger (a dispatcher seam), its own byte pins, and the forced turn-kind ruling — roughly half the total scope with a different risk profile (prompt-shape regression vs. new-subsystem risk).
- The coupling the ticket named ("two roles of one pool") is preserved across the split: the scribe consumes `runWorkerTurn` (§A3) unchanged; Part B's design below is written against Part A's surface — it is kept in this document deliberately so KPR-409's maturation lifts it verbatim.
- Directionality of the dependency: KPR-409 consumes Part A's surfaces (`runWorkerTurn`, the pool service, `WORKER_SERVER_DENYLIST`, the `meetingWorkers` config section). Nothing in Part A reads, stores, or configures anything scribe-shaped — no scribe config keys, no `meeting_summaries` access, no dispatcher seam.

## Design — Part A: worker pool, claim ledger, re-entry

### A1. New module + in-process MCP server

New files:
- `src/workers/meeting-worker-pool.ts` — `MeetingWorkerPool` service: claim CRUD, dedup, worker spawn/abort tracking, completion→re-entry, watchdog, restart sweep.
- `src/workers/worker-pool-mcp-server.ts` — `createWorkerPoolMcpServer(deps)` via `createSdkMcpServer`, callback-server template: constructor-stable `agentId`, mutable `{ current: WorkerPoolTurnContext }` ref refreshed each turn in `buildInProcessServers` (fields = the `WorkItemContext` seven, same as `callbackContextRef`).

Wiring (all existing conventions):
- `AgentRunner.buildInProcessServers` gains a `worker-pool` block gated on `this.workerPool && this.shouldEnableInProcessServer("worker-pool")` — the pool service is a new optional constructor dep on `AgentRunner` (teamRoster/memoryLifecycle precedent), passed by `AgentManager.createProviderAdapter` from a manager field set via `agentManager.setWorkerPool(pool)`.
- `index.ts`: construct the pool after the dispatcher — `new MeetingWorkerPool({ db, registry, agentManager, config: config.meetingWorkers, onDispatch: (item) => dispatcher.dispatch(item).catch(…) })` (scheduler-seam precedent, breaks the manager↔dispatcher cycle) — then `agentManager.setWorkerPool(pool)`; `pool.start()` (watchdog interval + restart sweep); `pool.stop()` in shutdown.
- **KPR-184:** add `"worker-pool"` to `IN_PROCESS_PORTED_SERVERS` (it is in-process ⇒ core-only; update the constant's "the 10 KPR-122-ported" comment to "…plus later in-process servers"). Admin validation and registry sanitization then enforce core-only for free.
- **Provisioning / rollout (Day-1-OOB layer 2):** the tools appear only for agents whose `coreServers` includes `"worker-pool"` — `shouldEnableInProcessServer` is membership, nothing else. Shipping the engine changes nothing by itself: the operator step is adding `worker-pool` to each conference boss's `coreServers` (`admin_agent_update` / beekeeper CLI) + SIGUSR1, effective next spawn. The plan and rollout notes must name this step explicitly.
- Lane B bosses reach the tools through the KPR-348 `ToolBridge` like every other in-process server — no adapter changes. Workers themselves are always claude-lane regardless of the boss's lane.
- `docs/providers.md`: one additive row/note — worker-pool tools available on all tool-executing lanes; dispatched workers always run on the Claude lane.

Tool surface (3 tools; all handlers try/caught returning structured errors, in-process convention):

```
worker_dispatch
  desc: Dispatch a background worker to fetch data or do legwork for this meeting.
        Returns immediately — end your turn after telling the room you've sent
        someone; you will be re-triggered in this thread with the worker's report.
        Meeting-only. Checks the claim ledger first: if an equivalent task is
        already in progress you get the claimant's name instead of a new worker.
  input: {
    task: string   // z.string().min(10) — what to fetch/do AND what to return;
                   // self-contained (the worker has your tools but not this conversation)
  }
  returns (text): "Worker dispatched (claim <id>). You'll be re-triggered here with the report."
               |  "Already claimed by <AgentName> (claim <id>, started <n>m ago), in progress — say so in the thread."
               |  refusal text (not a meeting / pool saturated / claude circuit open / pool disabled)

worker_status
  desc: List this meeting's worker claims (running and recently finished).
  input: {}
  returns: one line per claim — id, status, claimant, age, task preview (80 chars)

worker_cancel
  desc: Cancel a running worker claim you dispatched.
  input: { claimId: string }
  returns: confirmation | "not found / not yours / already finished"
```

`worker_dispatch` handler sequence (single async handler, no cross-await atomicity assumed except step 5 — the insert is the only atomic step):
1. **Meeting gate:** `context.current.channelKind === "slack" && context.current.channelLabel?.startsWith("conf-")` — mirrors dispatcher step 0.7's discriminator (both halves); else refuse with pointer to `bg_execute`/Task.
2. **Breaker pre-check (read-only):** `agentManager.circuitBreakers.stateFor("claude")` open+enabled ⇒ refuse honestly ("provider outage — can't dispatch a worker right now"). No permit acquired, nothing recorded — breaker-invisible (KPR-354 posture).
3. **Caps (check-then-act, accepted):** live workers ≥ `maxConcurrent`, or running claims for this thread ≥ `perMeetingMax` ⇒ refuse with counts. The check races under concurrent round-0 fan-out — bounded overshoot (at most one extra worker per concurrent dispatcher), **explicitly accepted**: caps are load valves, not correctness invariants; the plan must not add locking or post-insert re-count machinery here.
4. **Semantic dedup (best-effort):** load `status: "running"` claims for `threadId`; if any, one `workerClaimDedup` sidecar call (§A2); on a duplicate verdict return the already-claimed text (claimant name resolved via registry).
5. **Atomic claim:** `insertOne` with `taskKey` (see §A2); duplicate-key error ⇒ read the winner, return already-claimed text.
6. **Spawn** the detached worker (§A3) — `void`-ed promise with its own containment; the tool returns immediately with the claim id.

### A2. Claim ledger — `meeting_worker_claims`

New Mongo collection (add to the CLAUDE.md engine-written list):

```ts
interface WorkerClaimDoc {
  _id: ObjectId;                     // claim id (string form used in tool text + item ids)
  threadId: string;                  // meeting thread key — same `threadId ?? id` formula as dispatcher/runWorkItemTurn
  // Re-entry source snapshot (callback-doc template — exactly the WorkItemContext seven):
  source: { adapterId: string; channelId: string; channelKind: string;
            channelLabel: string; slackTs: string; slackThreadTs: string };
  taskText: string;
  taskKey: string;                   // sha256 of lowercase/whitespace-collapsed taskText — exact-match atomicity key
  status: "running" | "done" | "failed" | "expired" | "cancelled";
  bossAgentId: string;
  workerModel: string;
  createdAt: Date; updatedAt: Date;
  expiresAt: Date;                   // createdAt + claimTtlMinutes — watchdog deadline, NOT a Mongo TTL delete
  resultText?: string;               // worker output, truncated to 8000 chars
  error?: string;
  durationMs?: number; costUsd?: number; toolCalls?: number;   // C18: the worker measurement surface
  dedup?: { compared: number; verdict: "unique" | "duplicate"; costUsd: number };
}
```

Indexes:
- `{ threadId: 1, taskKey: 1 }` **unique, partial** `{ status: "running" }` — the atomic "I got this". Two bosses inserting the identical normalized task race on this index; the loser's duplicate-key error is the claim-denied signal. Near-equivalent-but-not-identical texts are the classifier's job (below) and a lost race there is accepted duplicate work (ticket-explicit).
- `{ threadId: 1, status: 1 }` — status/dedup reads.
- `{ updatedAt: 1 }` TTL `expireAfterSeconds: 7 * 86400` — housekeeping deletion only (terminal-status docs age out; the watchdog handles *live* expiry via `expiresAt` + status flip, so a deleted doc is always already terminal).

**Semantic dedup — `workerClaimDedup` sidecar task.** New entry in `TASKS` (`src/llm/registry.ts`; `LLMTask` union widened): `{ provider: "anthropic", modelId: () => config.modelRouter.model }` — same classifier-grade binding the meeting classifier borrows (task bindings are code constants, spec ⚠3 there). Call shape (meeting-classifier template): system prompt "decide whether the NEW task would substantially duplicate any OPEN task's work — near-equivalent data fetches count as duplicates; different targets or clearly different deliverables do not"; user prompt = open claims (id + taskText, capped ~10) + new task; `jsonSchema: { duplicateOf: string | null }` (claim id or null); `maxOutputTokens: 128`, `temperature: 0`, `timeoutMs: config.modelRouter.timeoutMs`. Fallbacks: no anthropic key / call error / parse failure / non-open id returned ⇒ treat as unique and proceed to insert (fail-open to duplicate work, never to a blocked dispatch); exact-key index still backstops identical text. Verdict + cost stamped on the new claim's `dedup` field.

**Watchdog (orphan recovery).** Pool-service interval (60s): `find({ status: "running", expiresAt: { $lt: now } })` → for each, atomic `findOneAndUpdate({ _id, status: "running" }, { $set: { status: "expired", … } })`; on success abort any live worker handle for that claim and dispatch a re-entry item (§A4) with an honest expiry report ("the worker did not finish in time — re-dispatch if the room still needs it"). Covers: worker hung past its own wall clock (belt-and-braces — the worker `timeoutMs` (10m) < claim TTL (30m), so the normal path is worker-timeout → `failed` first), pool-service bugs, and claims from a dead process.

**Restart sweep.** `pool.start()` runs once: every `status: "running"` claim flips to `expired` immediately (workers are in-process; a restart killed them all) with the same honest re-entry notice. A fresh process can never have live workers, so this is safe unconditionally.

### A3. Worker spawn path — `runWorkerTurn`

Manager-adjacent method on the pool service (deps: registry + the same runner constructor inputs the manager holds, threaded in via `setWorkerPool`'s handshake or a small factory callback the manager provides — plan's choice; the spec constraint is only *what* the spawn is):

```ts
// Per dispatch:
const boss = registry.get(claim.bossAgentId);            // re-checked live
const workerConfig: AgentConfig = {
  ...boss,
  model: config.meetingWorkers.workerModel,              // claude-lane pin — bare id/alias, default "sonnet"
  coreServers: boss.coreServers.filter((s) => !WORKER_SERVER_DENYLIST.has(s)),
  delegateServers: [],                                   // C19: workers never nest delegates
  schedule: [],                                          // paranoia — nothing reads it on this path, keep it inert
};
const runner = new AgentRunner(workerConfig, memoryManager, plugins, skillIndex,
  eventSubscribersJson, prefetcher, teamRoster, db, /* prefixCache: */ undefined, memoryLifecycle);
const adapter = new ClaudeAgentAdapter(runner);
// abort registry: this.liveWorkers.set(claimId, { abort: () => adapter.abort(), bossAgentId })
const result = await adapter.runTurn({
  prompt: workerTaskPrompt(claim),                       // the task text + return-format instruction
  sessionId: undefined,                                  // sessionless — fresh every time, sessions collection untouched
  workItemContext: workItemContextFromClaim(claim),      // the stored source seven
  resourceLimits: {
    maxTurns: config.meetingWorkers.workerMaxTurns,      // default 25
    timeoutMs: config.meetingWorkers.workerTimeoutMs,    // default 600_000 — KPR-354's nested backstop precedent
    budgetUsd: boss.budgetUsd,                           // operator's per-turn cost cap still binds
  },
  systemPromptOverride: workerCharter(boss, claim),      // total replacement — voice precedent
});
```

- **Identity & toolkit:** the worker runs as the boss's config clone — same coreServers (minus denylist), skills, memory scopes, cwd resolution — so "read a doc, pull numbers, check state" uses exactly the capabilities the room expects the boss to have. `WORKER_SERVER_DENYLIST` (module constant, `src/workers/meeting-worker-pool.ts`): `slack`, `quo`, `resend`, `team`, `event-bus`, `callback`, `schedule`, `recall`, `voice`, `admin`, `worker-pool`, `background`, `keychain`, `code-task`. Rationale per entry: outbound message surfaces (through-the-boss enforcement); self-scheduling/re-entry surfaces (a worker must not mint callbacks or events as the boss); recursion (`worker-pool`); admin (a legwork worker has no business editing agent definitions); **`background`** (r1 blocking — `bg_execute` spawns detached processes that would survive the worker's wall clock, `worker_cancel`, `stopAgent`, and the restart sweep, breaking E5's "no worker survives by construction" invariant; a worker's shell needs run inside its own Bash tool under the 10m wall clock); **`keychain`** (r1 — leak amplification: a worker's entire output is destined to be relayed into a meeting thread by the boss, so credential reads are denied deliberately — vendor-CLI servers that hold their own credentials at spawn are unaffected); **`code-task`** (r1 — spawns long-lived Claude Code CLI sessions from a 10-minute-capped worker; the boss delegates coding himself, in his own turn). Memory servers **stay** — a worker may read/write memory as the boss: same trust domain, read access genuinely useful (**reviewer-confirmed, r1**).
- **Shape for KPR-409 (plan directive):** implement `runWorkerTurn` taking a per-role parameter object — `{ model, coreServers (post-filter), maxTurns, timeoutMs, charter }` — with the fetch-worker role supplying the values shown above. The snippet is the fetch-worker instantiation, not the signature: KPR-409's scribe reuses the same method with its own role object (haiku pin, `coreServers: []`, scribe caps/charter) and zero changes to this file.
- **Charter (`workerCharter`)** — lean, total override, no soul/constitution (cheap + focused): identity ("you are a background research worker acting for <BossName> during a meeting in #<label>"), the task, the return contract ("reply with a concise, factual, self-contained report — it will be relayed to the meeting by <BossName>; include concrete numbers/quotes/paths; say clearly if you could not complete the task"), and the no-posting rule as information, not enforcement ("you have no messaging tools; your final message IS the deliverable").
- **Sessionless by construction:** `runner.send` never touches `sessionStore` (persistence is `finalizeSpawnResult`, manager-level, not on this path — verified). No `sessions` rows, no marks, no KPR-313 interactions.
- **`prefixCache: undefined`:** the charter override bypasses `buildSystemPrompt` anyway (verified `systemPromptOverride ?? buildSystemPrompt` at the send site), but passing no cache makes worker turns provably unable to touch the boss's cached prefix.
- **Not budget-accounted, lock-exempt:** no `withSpawnTicket`, no `activeSpawnCount`, no per-thread lock (workers have no thread) — bounds are the pool caps (Key Points rationale). `stopAgent(agentId)` gains one hook: `this.workerPool?.abortForBoss(agentId)` (walks `liveWorkers`); shutdown aborts all.
- **Breaker-invisible:** no permit, no record (KPR-354 posture) — a worker provider fault becomes a `failed` claim and an honest boss report, never a breaker trip. The read-only pre-check in `worker_dispatch` keeps dispatch honest during a known outage.
- **Completion (both outcomes), in a `finally`-disciplined wrapper that never throws:** atomic `findOneAndUpdate({ _id, status: "running" }, { $set: { status, resultText|error, durationMs, costUsd, toolCalls, updatedAt } })`. If the claim is no longer `running` (expired by watchdog, cancelled, restart-swept), **drop** the result with a log line — the boss was already notified by whoever flipped the status. On a won transition → §A4 re-entry dispatch. `liveWorkers` entry removed in `finally`.

### A4. Completion → boss re-entry

On claim transition to `done`/`failed`/`expired`, the pool builds the callback-shaped WorkItem and hands it to `onDispatch`:

```ts
const item: WorkItem = {
  id: `worker:${claimId}`,                       // unique per claim — dispatcher dedup-safe; fires at most once (atomic transition gates)
  text: workerReportPrompt(claim),               // see below
  source: { kind: claim.source.channelKind as ChannelKind, id: claim.source.channelId,
            label: claim.source.channelLabel, adapterId: claim.source.adapterId },
  sender: "system",
  threadId: claim.threadId,
  timestamp: new Date(),
  meta: { slackTs: claim.source.slackTs, slackThreadTs: claim.source.slackThreadTs,
          targetAgentId: claim.bossAgentId },
};
```

`workerReportPrompt`: `[Worker report — <done|failed|expired>] Task: <taskText>\n\n<resultText | error>\n\nYou dispatched this worker during the meeting in this thread. Interpret the finding and post what the room needs, as yourself — do not paste the raw report verbatim if a summary serves better. If the meeting has moved on and this is no longer useful, reply "No response needed."` (escape phrase matches `NON_RESPONSE_PATTERNS[0]` — C4-coherent; a stale finding suppresses cleanly on the single-dispatch leg's existing `isNonResponse` branch.)

Verified flow downstream, all existing code untouched:
- **Boss-gone guard:** pool pre-checks `registry.get(bossAgentId)` present + not disabled before dispatching (scheduler's callback pre-check, same rationale); if gone, mark the claim's `error` and skip. This guard is load-bearing: without it, a step-0 miss on a `conf-*`-labeled item would fall through to `resolveConferenceAgents` and fire a full classifier fan-out off a system item (verified fall-through order).
- `resolveAgents` step 0 pins the boss → single-dispatch leg → `runWorkItemTurn` → per-thread lock serializes the re-entry behind any in-flight boss meeting turn (correct ordering: his lock-predecessor's session write lands first) → the boss's meeting-thread session resumes with full meeting context → reply delivered into the Slack thread via `slackThreadTs`.
- **Conference machinery untouched by construction:** no conference meta ⇒ `conferenceRoundOf` undefined ⇒ no reaction caps, no kill-suppression legs, no mark bookkeeping (mark rules key on `resolved.conferenceMode`, absent here — the boss's own posted message reaches other participants as delta via the re-fetched transcript on the next trigger; the boss's own next delta re-includes his post — benign duplication under the covering invariant, C9/C10).
- **Outage (KPR-307):** `policyFor` gains one line — `if (id.startsWith("worker:")) return "silent";` (callback/event/team one-shot posture: queue silently, no thread notice). While the boss's provider circuit is open, the re-entry queues in `outage_queue` and replays; the claim is already terminal, so nothing double-fires.
- **Re-entry turn errors:** `handleTurnFailure` delivers today's error text to the thread — accepted, identical to callback behavior (consistency over special-casing).

### A5. Config — `meetingWorkers` (hive.yaml, liberal-loader)

```yaml
meetingWorkers:
  workerModel: sonnet        # claude-lane pin for fetch workers (bare id or CLI alias)
  maxConcurrent: 4           # engine-wide live workers
  perMeetingMax: 3           # running claims per meeting thread
  claimTtlMinutes: 30        # watchdog deadline
  workerMaxTurns: 25
  workerTimeoutMs: 600000    # 10m — KPR-354 nested-backstop precedent; must stay < claim TTL
  enabled: true              # false ⇒ tools refuse with an honest notice; nothing else changes
```

All keys optional with these defaults in `config.ts`. `workerModel: sonnet` (alias) chosen deliberately over a dated model id — drift-proof against model launches (the LLM-catalog launch-sync gotcha does not apply: this string goes to SDK `Options.model`, not the sidecar catalog). Ticket's "sonnet/haiku pinned": sonnet default; operators pin haiku via config. No per-dispatch tier parameter (YAGNI).

### A6. Observability (C18 — existing surfaces only)

- **The claim ledger is the measurement surface:** status counts, `durationMs`, `costUsd`, `toolCalls`, dedup verdicts — all queryable per meeting. No new telemetry `kind`, no `agent_turn_telemetry` rows for worker turns, no new activity records.
- Log lines (redaction-safe — ids/status/durations, task previews ≤80 chars): `Worker dispatched`, `Worker claim denied (duplicate)`, `Worker completed`, `Worker failed`, `Worker claim expired`, `Worker result dropped (claim no longer running)`. **Redaction rule (explicit):** `taskText` is agent-authored — the 80-char preview cap is a hard limit on every log site, and `resultText` is **never** logged at any length (ledger-only); the log-redaction convention (no message text) governs.
- The boss's re-entry turn is an ordinary turn — it lands in `activity_log`/`agent_turn_telemetry` through the existing pipeline with no conference fields (correct: it is not a conference turn). Meeting-efficacy comparison (did rooms get faster?) reads the KPR-389 fields already shipping: `conferenceRound`/`durationMs`/`toolMs` on meeting turns before vs. after pool adoption.
- `hive doctor`: nothing (informational-section YAGNI; the ledger is one mongosh query away). Revisit only if operators ask.

## Design — Part B: scribe (**KPR-409's design** — kept here deliberately so KPR-409's maturation lifts it verbatim; out of KPR-390's scope)

### B1. Turn kind — the forced decision (binding 1)

**The scribe is a pool worker role, not a meeting participant.** It is never added to `meetingRosters`, never appears in classifier candidate lists (round 0 or reaction pass), never receives conference dispatch of any kind — so the C14/C15 question ("does it inherit reaction caps + decline pressure?") is answered structurally: neither turn kind applies; the scribe runs on the §A3 worker path (own caps: `scribeMaxTurns` 8 / `scribeTimeoutMs` 120s — summary-writing needs no tools beyond none-at-all; see B2) and has no posting surface (denylist). No roster/classifier/preamble code changes.

### B2. Trigger + worker shape

- **Cadence:** dispatcher seam — after a successful round-0 conference delivery, `dispatchToAgent` calls `workerPool.noteMeetingActivity(threadId, sourceSeven)` (fire-and-forget). The pool debounces per thread (default 90s quiet) and skips if fewer than `scribeMinNewMessages` (default 6) messages arrived since `coveredThroughTs`. One scribe run per thread at a time (in-memory flag + `meeting_summaries.updating` guard with its own staleness override).
- **Scribe worker:** `runWorkerTurn` with `workerModel: config.meetingWorkers.scribeModel` (default `haiku`), `coreServers: []` (the transcript is in the prompt; a scribe needs zero tools — strongest possible through-the-boss posture), charter = "maintain the running summary" + prior summary + new messages (fetched via the pool's own `fetchThreadHistory` access — requires threading the slack adapter or a fetch callback into the pool; plan detail), return contract = the full replacement summary (decisions, open questions, per-participant positions; ≤ ~2500 chars).
- **Storage:** `meeting_summaries` — `{ _id: threadId, summaryText, coveredThroughTs, version, updatedAt, updating?: { startedAt } }`; 7d TTL on `updatedAt`. Not the claims collection (different lifecycle, no claim semantics — severability).

### B3. C13 anchor integration — the only conference-code edit in the ticket pair

`buildConferenceContext` **full arm only** (the delta arm and mark mechanics are off-limits — binding 2): when a `meeting_summaries` doc exists for the thread, the full-mode context becomes `[Meeting summary]\n<summaryText>\n` + the existing-format tail of messages with `ts > coveredThroughTs` (same 100-cap, same body formatter) instead of `formatThreadContext(history)`. `injectionHighWaterTs` = max over the injected tail ∪ round-0 trigger ts — **unchanged formula**, and the covering argument holds in the C13-authorized generalized sense: summary ∪ tail ∪ terminal slot covers the thread for the fresh session (C9/C10's literal-message invariant is deliberately relaxed to semantic coverage *only* on this arm, exactly as KPR-388's non-goal note anticipated; C7's one-degraded-turn allowance covers a stale summary's window). No summary doc ⇒ today's full transcript byte-identical (C6 pin untouched); delta-eligible agents never touch this arm. New byte pin for the summary-mode shape; the summary header must not collide with `[New message]:` or the delta header (C3/C10 pin unambiguity).

### B4. Scribe non-interactions (explicit)

Scribe runs are invisible to: the reaction tracker (C1/C2 — no writes), marks (C12 — scribe turns are not conference turns; `meetingLastSeenTs` untouched), KPR-389 shaping (no conference meta), and the claim ledger (separate storage). A scribe failure degrades to today's full-transcript behavior silently — the summary is an optimization, never a correctness dependency.

## Integration points

**Part A**
- `src/workers/meeting-worker-pool.ts` (new) — service, denylist constant, watchdog, restart sweep, `abortForBoss`.
- `src/workers/worker-pool-mcp-server.ts` (new) — 3 tools, context-ref pattern.
- `src/agents/agent-runner.ts` — optional `workerPool` constructor dep; `buildInProcessServers` `worker-pool` block (context-ref refresh).
- `src/agents/agent-manager.ts` — `setWorkerPool`; pass-through into `AgentRunner` construction; `stopAgent` → `abortForBoss`; runner-construction inputs exposed to the pool (factory callback or handshake — plan's choice).
- `src/agents/in-process-servers.ts` — add `"worker-pool"`, comment update (KPR-184 enforcement).
- `src/llm/registry.ts` + `src/llm/types.ts` — `workerClaimDedup` task binding.
- `src/outage/outage-notices.ts` — `worker:` → `silent` in `policyFor`.
- `src/config.ts` — `meetingWorkers` section.
- `src/index.ts` — pool construction/wiring/start/stop.
- `docs/providers.md` — additive worker-pool note.
- CLAUDE.md collections list — `meeting_worker_claims`.
- **Untouched:** dispatcher conference resolution/injection/marks/preamble/suppression legs, session-store, spawn shaping, provider adapters, scheduler.

**Part B (KPR-409 — none of these files are touched by KPR-390)**
- `src/channels/dispatcher.ts` — `noteMeetingActivity` seam in `dispatchToAgent`; `buildConferenceContext` full-arm summary branch + formatter.
- pool service — scribe cadence/debounce, `meeting_summaries` store, scribe charter.
- `src/config.ts` — `scribeModel`, `scribeDebounceMs`, `scribeMinNewMessages`, scribe caps.
- New summary-mode byte pin in `dispatcher-conference.test.ts`; C6 pin stays green (no-summary path byte-identical).

## Edge cases

- **E1 Boss turn killed after dispatch (incl. 120s reaction clamp):** worker detached from the turn's abort chain by construction — claim lives, worker runs, re-entry fires. The room may never have heard "I sent someone" (the killed turn was suppressed) — the boss's re-entry post is then the first signal; acceptable.
- **E2 Dispatch from a reaction turn (C19):** `worker_dispatch` + dedup call fit comfortably in the 6-turn/120s clamp (one tool call + ~1s sidecar). Workers can't nest delegates (`delegateServers: []`), so the KPR-354 abort-chain hazard is structurally unreachable.
- **E3 Duplicate dispatch race:** identical normalized text ⇒ unique-index loser gets claimed-by text (atomic). Near-equivalent concurrent texts inside the classifier's blind window ⇒ two workers — accepted waste (ticket-explicit), bounded by `perMeetingMax`.
- **E4 Worker died / hung:** own wall clock (10m) → `failed` + honest report; watchdog (30m) backstops a hung completion path → `expired` + honest report; both paths end in exactly one re-entry (atomic status transition gates).
- **E5 Engine restart mid-worker:** restart sweep expires all `running` claims with notice; no worker survives by construction — the `background` denylist entry is load-bearing here (a worker cannot spawn detached processes that would outlive the wall clock, `worker_cancel`, `stopAgent`, or the restart); ledger (Mongo) survives, in-memory state rebuilt empty.
- **E6 Boss deleted/disabled before completion:** pre-dispatch registry guard skips re-entry and annotates the claim — critically also preventing the step-0-miss → conference-fan-out fall-through (verified hazard).
- **E7 Meeting went quiet / roster swept:** re-entry needs no roster (step-0 pin) — a late finding still posts to the thread; claim TTL bounds lateness to ≤30m.
- **E8 Outage at completion:** re-entry queues silently (`policyFor` `worker:` → silent) and replays via KPR-307; dedup-exempt replays re-fire the same `worker:<claimId>` id safely.
- **E9 Outage at dispatch:** breaker pre-check refuses with honest text; the boss tells the room. No claim is created (no orphan).
- **E10 Re-entry vs per-thread lock / conference rounds:** re-entry serializes on `agentId:threadId` behind in-flight boss meeting turns; it carries no conference meta so KPR-389 shaping, kill legs, and KPR-388 mark writes all no-op on it (verified key-off fields). The boss's posted finding reaches peers as delta on their next trigger; his own next delta re-includes it (benign duplication, C9/C10).
- **E11 Boss's report suppressed:** `"No response needed."` on a stale finding suppresses via the existing single-dispatch `isNonResponse` branch — no filler in the thread.
- **E12 Huge worker output:** `resultText` truncated to 8000 chars with a truncation marker; the charter asks for concise reports so this is the backstop, not the norm.
- **E13 `worker_cancel` vs completion race:** both sides transition atomically from `running`; the loser drops (completion after cancel logs `result dropped`; cancel after completion returns "already finished").
- **E14 Non-meeting invocation / disabled pool:** refusal text with alternatives; no state touched.
- **E15 (Part B / KPR-409) Scribe failure / stale summary:** full-transcript fallback is automatic (no summary doc / old `coveredThroughTs` just lengthens the tail toward today's exact behavior at the 100-cap).

## Test plan

Negative-verify per repo convention (revert the source hunk, confirm the new test fails) for T1/T3/T5/T7; unit tests beside source (`src/workers/*.test.ts`, additions to existing suites).

**Part A**
- **T1 (atomic claim):** two concurrent `worker_dispatch` handler invocations, identical task ⇒ exactly one claim doc; loser's response names the claimant. Table: distinct tasks ⇒ two claims; `perMeetingMax` reached ⇒ refusal; concurrent distinct dispatches straddling the cap ⇒ bounded overshoot tolerated (pin the check-then-act acceptance — assert no lock/re-count was added, not a stricter bound).
- **T2 (dedup):** mocked registry `generateForTask` returning `duplicateOf` ⇒ no insert + claimed-by text; returning null ⇒ insert; throwing / no-key ⇒ insert (fail-open pin); dedup metadata stamped.
- **T3 (worker spawn shape):** captured `AgentRunner` construction — model pinned from config, denylist stripped from `coreServers`, `delegateServers: []`, `prefixCache` undefined; `runTurn` receives `sessionId: undefined`, worker limits, a `systemPromptOverride`. Negative-verify: without the clone, boss model/servers leak through.
- **T4 (completion → re-entry):** success ⇒ claim `done` + `onDispatch` receives the pinned WorkItem (id `worker:<claimId>`, `targetAgentId`, source seven from the claim — byte pin); failure ⇒ `failed` + report includes error; completion after watchdog expiry ⇒ dropped, no dispatch (atomicity pin).
- **T5 (guards):** boss deleted ⇒ no dispatch (and specifically no conference fan-out — assert `onDispatch` not called with an unpinned item); breaker open ⇒ dispatch refused, no claim; non-`conf-` label or non-slack `channelKind` ⇒ refused; `enabled: false` ⇒ refused.
- **T6 (watchdog + restart sweep):** expired running claim ⇒ `expired` + one re-entry + live-worker abort called; boot sweep flips all `running` ⇒ `expired` with notices.
- **T7 (`policyFor`):** `worker:` id ⇒ `silent` (table row beside the existing prefixes). Negative-verify: pre-fix returns `notify`.
- **T8 (stopAgent/shutdown):** `stopAgent(boss)` aborts that boss's live workers only; `pool.stop()` aborts all + clears the interval.
- **T9 (conference stack untouched):** the existing `dispatcher-conference.test.ts` suite passes with zero edits (C6/C10/C3 pins byte-green) — asserted by construction in CI, called out in the plan as a review gate.
- **T10 (registry task):** `workerClaimDedup` binds classifier-grade model; capability/no-key error surfaces to the tool's fail-open path.

**Part B (KPR-409 — moves wholesale; no KPR-390 test depends on any of it)**
- Summary-mode byte pin (full arm with summary doc: header + tail shape; high-water = max tail ts ∪ trigger); no-summary ⇒ existing C6 pin unmodified; delta-eligible agent never reads summaries; scribe worker gets `coreServers: []` + haiku pin; debounce/min-messages gating; `updating` staleness override; scribe absent from roster/classifier inputs (structural pin).

## Canon compliance

- **C1/C2:** no tracker reads/writes anywhere in the pool; the re-entry turn is not a conference turn and cannot perturb selection/claim recording.
- **C3:** terminal-slot contract untouched; re-entry items carry no conference meta, and the report prompt's escape phrase reuses the C4 wording rather than inventing a new one.
- **C4:** `NON_RESPONSE_PATTERNS` unmodified; boss suppression of stale findings rides the existing branch.
- **C6/C10:** Part A touches neither pin; Part B updates none of them — the summary mode adds a *new* pin beside C6 (no-summary path stays byte-identical) and its header avoids the delta/terminal markers.
- **C7 (Part B / KPR-409):** a stale scribe summary is at worst the allowed degraded window before the anchor heals on the next scribe run. KPR-390 has no C7 surface.
- **C9/C10:** mark mechanics untouched in both parts; Part B's semantic-coverage relaxation is confined to the C13-authorized arm and named explicitly (§B3).
- **C12:** mark bookkeeping placement untouched; re-entry turns skip it by key-off construction.
- **C13 (binding 2 — binds KPR-409):** the scribe integrates at exactly the full-injection arm — the only conference-code edit in the pair, isolated in Part B; KPR-390 does not touch the anchor site.
- **C14/C15 (binding 1 — decided here, executed by KPR-409):** scribe turn-kind decided explicitly — out-of-band pool worker, no roster membership, no reaction caps, no preamble exposure (§B1).
- **C18 (binding 3):** no parallel telemetry fields — the claim ledger + existing KPR-389 turn fields are the measurement surface (§A6).
- **C19/E2 (binding 4):** worker lifecycle decoupled from the dispatching turn's abort chain; nested delegates structurally unreachable from workers (§A3, E2).
- **C20/remaining:** no contradictions identified; any canon item not named here is untouched by construction (no edits to the files that carry it in Part A).

## Open questions / delegated assumptions

None blocking. The scribe split is settled (operator-approved — Part B = KPR-409). ⚠-flagged spec-chosen calibrations for reviewer attention: worker model default (`sonnet` alias; scribe's `haiku` default is KPR-409's), pool caps (4 engine / 3 per meeting), claim TTL 30m vs worker wall clock 10m, the 8000-char report truncation, the no-reaction-pass decision (trigger-gated follow-up), workers-outside-`spawnBudget` (rationale in Key Points), and memory servers remaining on workers.
