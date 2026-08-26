# KPR-399 — Aborted turns never persist session — replays restart from scratch

Child of hotfix epic **KPR-397**. Status: **spec draft** (Gate 1 delegated).

> **Decision Register canon consumed:** D1 (binary-OR progress predicate,
> fail-closed — reused verbatim as this spec's persist gate), D3 (with-progress
> deadline + open breaker → legacy path, never outage_queue; closed-circuit
> re-dispatch is KPR-402's surface), D5 (no third deadline shape; breaker arms
> untouched — this spec adds no classification changes), D6 (kpr-398-spec
> §Design.4 contract table is the binding classification baseline for every
> abort shape referenced below), D8 (accepted residuals as recorded).
> Cross-epic canon C3 (KPR-385): non-success sessionId handling asymmetry
> across providers is deliberate per-provider parameterization — **this ticket
> is Claude-lane-only**; see Non-Goals.

## TL;DR

`finalizeSpawnResult` (`src/agents/agent-manager.ts:1871`) gates session
persistence on `result.sessionId && !result.aborted`, so a deadline-aborted (or
operator-aborted) turn never records the sessionId the runner already captured
— even though the `RunResult` of an aborted turn carries a valid, resumable id
(captured from the SDK's `system/init` message at `agent-runner.ts:2049-2052`
and returned intact because abort *closes* the iterator rather than throwing,
L2224-2231). Every replay and every follow-up message in the thread then spawns
with `resumeSession: "new"` and redoes the same first N minutes — the
user-visible "think / hit-wall / restart" loop; a task needing more than
`timeoutMs` can never complete at any timeout value. The fix is manager-side
and small: **relax the persist guard to also persist aborted turns** on the
Claude lane (`client-transcript` session semantics — claude + Lane A
kimi/deepseek/grok), gated on the D1 progress predicate (`toolCalls>0 |
streamed | text nonempty`, fail-closed), with no token-stats overwrite; plus a
narrow, KPR-350-style **one-shot fresh-retry self-heal** for a resume that the
SDK rejects (defensive cover for the mid-tool-call resume ambiguity the ticket
flags). The replay path and next-user-message path need **zero changes**: both
re-enter through `runWorkItemTurn` → `sessionStore.get`, so they pick up the
persisted handle automatically. No runner changes, no dispatcher changes, no
store-schema changes.

## Key Points

- **The runner already captures the id as-assigned.** `resultSessionId` is
  initialized to the resumed id (`agent-runner.ts:2004`), overwritten by
  `system/init` (`L2049-2052`), by assistant messages (`L2115-2117`), and by
  the result message (`L2124`), and is returned in `RunResult.sessionId` on
  every exit path including aborts (abort → `q.close()` → iterator ends
  cleanly, no throw — L2224-2231, L2292-2299). **No agent-runner change is
  needed.** The ticket's `~L1860 resumeSession: sessionId ?? "new"` site is a
  *log line* (the symptom in the evidence); the actual resume wiring is
  `...(sessionId ? { resume: sessionId } : {})` at L1972, and the defect is
  the manager-side persist guard.
- **One guard, one file.** The persist site is
  `finalizeSpawnResult` (`agent-manager.ts:1869-1905`), which runs inside the
  per-thread lock (`spawnTurn` L1097, inside the `withSpawnTicket` lambda) —
  the write is issued before the lock releases (fire-and-forget, consistent
  with the success-path write), so any re-entry whose store read happens
  after finalize sees the handle. A contender *already waiting on the lock*
  read the store pre-lock (`runWorkItemTurn` L861) and does not — a
  pre-existing residual, see Edge case 7.
- **Persist gate (aborted turns):** `sessionSemanticsFor(route.provider) ===
  "client-transcript"` **AND** `result.sessionId` nonempty **AND**
  `hasObservedProgress(result)` — the exact D1 predicate, exported from
  `error-classification.ts` so the classifier and the persist gate can never
  diverge. Zero-progress aborts persist nothing (fail-closed = pre-399
  behavior): progress is the proof the CLI actually ran and flushed a
  transcript; a zero-progress abort's id may point at a never-flushed file,
  and a rotated id with zero progress is indistinguishable from a
  failed-resume mint (the same hazard the KPR-313 churn-mint rider kills on
  the error path).
- **No token-stats clobber:** the aborted-turn persist calls
  `sessionStore.set(...)` **without** `tokenData` — aborted turns carry
  all-zero usage (the SDK result message never arrives), and `set()` without
  tokenData updates only `sessionId`/`provider`/`updatedAt`, preserving the
  prior turn's stats (`session-store.ts:195-201`).
- **Replay prefers resume with zero replay-path changes.** The outage replay
  processor re-dispatches the original WorkItem
  (`outage-replay-processor.ts:101-111`) → `dispatch()` →
  `runWorkItemTurn(agentId, item)` → `sessionStore.get` (`agent-manager.ts:861`)
  → `ctx.sessionId` → `options.resume`. The same holds for the next USER
  message in the thread, and for reflection turns (post-lock re-resolve,
  L932). Once the aborted turn's id is in the store, **every** re-entry
  resumes it. Nothing in the dispatcher changes.
- **Defensive SDK-resume self-heal (the ticket's Caution, designed for both
  possible SDK behaviors):** resuming a transcript that ends mid-tool-call
  either (a) works — the CLI repairs dangling `tool_use` blocks at load — or
  (b) fails (unknown-session error, or an API 400 "`tool_use` ids … without
  `tool_result`" on the first continuation). We cannot verify from a
  worktree; the design assumes neither. A new, narrow `else if` arm in
  `spawnTurn` (mirroring the KPR-350 stale-server-handle arm, semantics-gated
  `client-transcript`) matches the resume-rejection surfaces and retries
  **once** fresh — bounded loss of one thread's context instead of a dead
  thread erroring identically until the 7-day TTL. Both matcher surfaces
  classify `non-provider` today (no `FAULT_PATTERNS` row matches), so the arm
  is breaker-invisible either way. The matcher is docs-sourced and **must be
  refined against the live capture** (same posture as KPR-350's, refined in
  KPR-351).
- **Claude-lane-only (cross-epic canon C3).** The gate is the existing
  `SESSION_SEMANTICS` descriptor: `client-transcript` = claude + Lane A
  passthrough (kimi/deepseek/grok), which all ride
  `ClaudeAgentAdapter`/`AgentRunner` and inherit the fix with zero
  per-provider work. openai/gemini (`server-resumable`) and codex
  (`stateless-replay`) keep the `!result.aborted` behavior byte-for-byte —
  any Lane B resume-on-abort goes through the KPR-385 scaffold hooks, never a
  silent unification here.
- **KPR-402's surface, stated:** post-399, a re-entry **whose store read
  occurs after the aborted turn's finalize** can rely on
  `sessionStore.get(agentId, threadId)` returning the aborted turn's handle
  whenever the abort had observed progress on a client-transcript route —
  pointing at a CLI transcript that contains the original prompt plus all
  partial assistant/tool work. Outage replay and any later dispatch qualify
  (their `runWorkItemTurn` read happens after the aborted turn completed —
  modulo the fail-soft write residual, §Design.2); a
  contender **already waiting on the per-thread lock** does not — it read the
  store pre-lock and spawns on the stale value (pre-existing residual, Edge
  case 7). What KPR-402 must NOT rely on: a persisted handle for
  zero-progress aborts (none is written), a fresh handle for an
  already-waiting contender, or any replay-prompt shaping (replay still
  re-sends the wrapped original prompt into a session that already contains
  it — accepted residual here, KPR-402's surface to refine).
- ⚠ **Delegated:** predicate reuse via export (vs duplicating three
  comparisons), the no-tokenData persist shape, the self-heal arm's matcher
  wording and its placement as a third `else if`, and the live-verification
  evidence bar are routine choices made here, flagged for the register. No
  open product questions.

## Problem

**Defect.** A turn aborted by the wall-clock deadline (`agent-runner.ts:2034-2043`
→ `abort()` L2292-2299) or by operator stop returns a `RunResult` with
`aborted: true` and a **valid `sessionId`** — but `finalizeSpawnResult`'s
guard (`agent-manager.ts:1871`)

```ts
if (result.sessionId && !result.aborted) { … sessionStore.set(…) … }
```

skips persistence entirely. The `sessions` row for the thread is never
written (first-turn case) or never advanced (resumed case — tolerable, id is
stable), so the outage replay, the KPR-402 re-dispatch, and the user's next
message in the thread all spawn fresh (`resumeSession: "new"` in the
`agent-runner.ts:1857-1864` spawn log). The agent redoes the same first
N minutes of work, hits the same deadline, and aborts again — forever. The
KPR-398 classifier fix stops this loop from *tripping the breaker*; it does
nothing to stop the *restart-from-scratch* loop itself. That is this ticket.

**Evidence (ticket, 2026-08-26):** Fable's thread
`slack:C0BT21S7Q0Y:1787708067.984699` dispatched with `resumeSession:"new"` at
02:11:59, 02:18:14, 02:23:15, 02:28:45Z — same task, from zero, ≥4 times; the
`sessions` collection shows no row for the thread until the short, successful
02:28:49Z reflection turn (the first non-aborted completion, which the
existing guard finally persisted).

**Why the id on an aborted turn is real.** The Claude CLI appends every
message to the session JSONL incrementally during the turn, and the SDK's
`close()` is not an instant kill: it ends stdin, then SIGTERMs the subprocess
only after a 2s grace (SIGKILL 5s later) — verified in the installed SDK
(`@anthropic-ai/claude-agent-sdk` 0.2.141, `sdk.mjs` ProcessTransport
`close()`). By the time a 300s deadline fires, the transcript on disk holds
the user prompt and all completed assistant/tool messages. `client-transcript`
semantics (`provider-adapters/types.ts:70-86`) means that file **is** the
session — resuming it replays the partial turn's context.

**The one genuine unknown (ticket Caution).** A transcript killed mid-tool-call
can end with an assistant `tool_use` block that has no `tool_result`. Whether
`--resume` of such a transcript (i) is repaired by the CLI at load (it
synthesizes interrupted tool_results — the behavior of the interactive ESC
path) or (ii) errors (unknown-session if the file never flushed, or an API 400
`tool_use`-without-`tool_result` on the first continuation call) **cannot be
verified from this worktree** — unit mocks hide exactly this (the beekeeper
SDK-mock gotcha class). The design below is safe under both: (i) is the happy
path; (ii) is caught by the self-heal arm (one fresh retry, thread never
dies). The Testing Contract makes live verification a deliver-lane gate.

## Goals

1. A deadline- or operator-aborted Claude-lane turn **with observed progress**
   (D1 predicate) issues its sessionId persist to the `sessions` row before
   the per-thread lock releases (fire-and-forget, success-path parity).
2. Every re-entry path whose store read occurs after finalize — outage
   replay, KPR-402 re-dispatch, next user message, reflection — resumes that
   session automatically (no per-path changes; falls out of the existing
   `sessionStore.get` reads).
3. A resume the SDK rejects (mid-tool-abort pathology, never-flushed id)
   self-heals with one fresh retry instead of producing a dead thread.
4. Lane B (`server-resumable`/`stateless-replay`) behavior is byte-for-byte
   unchanged (C3).
5. Unit tests pin the persist gate both directions plus the C3 exclusion;
   live-instance verification of SDK resume semantics is an explicit,
   non-mockable Testing Contract item for the deliver lane.

## Non-Goals

- **No Lane B generalization (cross-epic canon C3).** openai/gemini/codex
  keep skipping persistence on aborted turns. Resume-on-abort for
  `server-resumable` providers (persisting a `previous_response_id`/
  `previous_interaction_id` observed mid-turn) and abort checkpointing for
  codex's `provider_turn_history` are **explicitly out of scope** and must go
  through the KPR-385 scaffold hooks as deliberate per-provider
  parameterization — never a silent unification here.
- **No classification changes.** `classifyTurnResult`, the D6 contract table,
  and every breaker arm are untouched (D5). This ticket only *exports* the
  existing D1 predicate.
- **No dispatcher/outage-queue changes.** The D3 gate, replay processor,
  notice policy, and replay-prompt wrap (`replayWrap`) are unchanged. Replay
  re-prompt shaping ("continue" nudges, duplicate-prompt suppression) is
  KPR-402's surface.
- **No runner changes.** Capture-as-assigned already exists; no mid-turn
  eager persistence (see Rejected alternatives).
- **No session-store schema changes.** Same collection, same `set()` surface,
  same 7-day TTL, same KPR-313 normalization/scrub semantics.
- **No abort-mechanics changes.** `query.close()` remains the only abort;
  `query.interrupt()` (graceful, transcript-repairing) is a **control request
  available only in streaming-input mode** (SDK d.ts: "only supported when
  streaming input/output is used") and hive passes a string prompt — recorded
  as a possible future improvement, not attemptable in a hotfix.
- **No `timeoutMs`/budget policy changes.**

## Design

### 1. Export the D1 predicate (`error-classification.ts`)

`hasObservedProgress` (L145-147) becomes `export function` — no body change.
The persist gate and the classifier consume the identical predicate, so a
future predicate change (a D-register event) moves both surfaces at once.
The module stays pure and dependency-free.

⚠ Delegated choice: export-and-reuse over duplicating the three comparisons in
`agent-manager.ts`. Divergence here would be silent and behavioral; one source
of truth wins.

### 2. Persist-on-abort (`finalizeSpawnResult`, `agent-manager.ts:1869-1905`)

Current shape:

```ts
const newSessionId = result.sessionId || ctx.sessionId || "";
if (result.sessionId && !result.aborted) {
  const resumable = persistsResumableHandle(sessionSemanticsFor(route.provider));
  const churnMint = !!result.error && !!ctx.sessionId && result.sessionId !== ctx.sessionId;
  if (churnMint) { …warn, skip… } else {
    this.sessionStore.set(ctx.agentId, ctx.threadId, resumable ? result.sessionId : "", route.provider, { …tokenData… });
  }
}
```

New shape (illustrative — exact code is the implement lane's):

```ts
const newSessionId = result.sessionId || ctx.sessionId || "";
// KPR-399: an aborted Claude-lane turn with observed progress persists its
// session so replays/retries/follow-ups resume instead of restarting.
// client-transcript ONLY (C3): the id is a local transcript handle the CLI
// flushed incrementally — progress (D1 predicate) is the proof it ran.
// Zero-progress aborts persist nothing (fail-closed: the id may point at a
// never-flushed file, and a rotated id with zero progress is
// indistinguishable from a failed-resume mint — churn-mint's own rationale).
const abortPersist =
  result.aborted === true &&
  !!result.sessionId &&
  sessionSemanticsFor(route.provider) === "client-transcript" &&
  hasObservedProgress(result) &&
  // Mint-safety belt (churn-mint's condition, applied verbatim): an aborted
  // turn that ALSO errored, resumed a session, and came back with a
  // DIFFERENT id never overwrites the row. Rare shape (deadline aborts
  // carry no error), but it makes the arm self-evidently mint-safe.
  !(result.error && ctx.sessionId && result.sessionId !== ctx.sessionId);

if (result.sessionId && !result.aborted) {
  … existing block, byte-for-byte (churn-mint rider, resumable gate, tokenData) …
} else if (abortPersist) {
  log.info("Persisting session from aborted turn — replay/follow-up will resume (KPR-399)", {
    agentId: ctx.agentId, threadId: ctx.threadId,
    timedOut: result.timedOut === true,
  });
  // NO tokenData: aborted turns carry all-zero usage (SDK result message
  // never arrived) — set() without tokenData updates sessionId/provider/
  // updatedAt only, preserving the prior turn's stats.
  this.sessionStore.set(ctx.agentId, ctx.threadId, result.sessionId, route.provider);
}
```

Properties:

- **Success path byte-identical** (churn-mint rider, `resumable ? id : ""`
  row-keeping for stateless providers, tokenData handling — all untouched).
- **Issued before the lock releases** (`spawnTurn` calls finalize at L1097,
  inside the `withSpawnTicket` lambda), fire-and-forget with fail-soft
  `withRetry` exactly as the success-path write is today — same residual (a
  Mongo blip loses one persist, error-logged by withRetry's fallback path,
  self-corrects next turn). Any
  re-entry whose store read occurs after finalize (outage replay, a later
  dispatch, reflection's post-lock re-resolve) sees the handle. The post-lock
  re-reads elsewhere in `spawnTurn` are **conditional** (reflection-only
  L932, provider-mismatch-only L960, server-resumable-only L1065): an
  ordinary same-provider contender reads the store **pre-lock**
  (`runWorkItemTurn` L861) and then waits — see Edge case 7 for the accepted
  residual.
- **`persistsResumableHandle` is not consulted on this arm** — the
  `client-transcript` equality check is strictly narrower (it excludes
  `server-resumable` too, which `persistsResumableHandle` would admit). That
  *is* the C3 scoping, expressed in the existing descriptor vocabulary.
- **Operator abort and deadline abort are handled uniformly** (both reach
  here as `aborted: true`; deadline additionally sets `timedOut`). An
  operator "stop" persisting partial context is desired: the next message in
  the thread continues where the agent was stopped. The manager's early-abort
  synthetic result (`synthesizeAbortedResult`, L1553-1572) is automatically
  excluded: `toolCalls: 0, streamed: false, text: ""` — zero progress (and
  for first turns, empty sessionId).
- `newSessionId`/`state.currentSessionId`/telemetry guards
  (`recordSpawnObservability` L1803 `!result.aborted`) are unchanged —
  turn telemetry for aborted turns stays out, deliberately (no usage data
  exists to record).

### 3. Resume-rejection self-heal (`spawnTurn`, third `else if` arm)

New sentinel matcher in `error-classification.ts` (exported, pattern-pinned):

```ts
/**
 * KPR-399: Claude-lane resume-rejection surfaces. (1) the CLI's
 * unknown-session error — the persisted id's transcript never flushed
 * (abort before first write) or was removed; (2) the Messages API 400 when a
 * resumed transcript ends with a dangling tool_use the CLI did not repair.
 * Docs/community-sourced — REFINE against the live capture at delivery
 * (KPR-350 posture; its matcher was refined in KPR-351 L2). Deliberately
 * narrow: a false positive costs one thread's context (fresh retry), a miss
 * costs a dead thread until the 7d TTL. Neither alternate may overlap the
 * auth row (superset rule) — both classify non-provider today, keeping the
 * arm breaker-invisible.
 */
export function isClaudeResumeLoadError(reason: string): boolean {
  return (
    /no conversation found with session/i.test(reason) ||
    /tool_use[\s\S]{0,120}?without[\s\S]{0,40}?tool_result/i.test(reason)
  );
}
```

Arm placement — `spawnTurn`'s existing retry chain (`agent-manager.ts:1020-1088`)
gains a third `else if` after auth-rebuild and stale-server-handle:

```ts
} else if (
  finalResult.error &&
  isClaudeResumeLoadError(finalResult.error) &&
  effectiveCtx.sessionId &&
  sessionSemanticsFor(shaping.route.provider) === "client-transcript"
) {
  log.warn("spawnTurn claude resume rejected — one fresh retry (KPR-399)", {
    agentId, threadId, timedOut: finalResult.timedOut === true, // no handle value logged (redaction posture)
  });
  finalResult = await this.runOneSpawnAttempt(
    { ...effectiveCtx, sessionId: undefined }, shaping, ticket, onStream,
  );
}
```

Semantics, all inherited from the established arms:

- **Single retry** (`else if` chain ⇒ at most one retry per turn, arms
  mutually exclusive); **record-once** untouched (only the finalized attempt
  reaches the breaker, L1095); the store is not pre-scrubbed — a successful
  fresh retry overwrites the row via finalize (self-correcting), a failed one
  leaves it for the next turn's re-trip (bounded waste: one extra attempt per
  turn, never a dead thread — KPR-350's exact accepted residual).
- **Breaker-invisible:** both matcher surfaces classify `non-provider`
  (verified against `FAULT_PATTERNS` — no row matches either string), so even
  without the arm they never trip; with the arm the retried attempt's result
  is what gets recorded.
- **Semantics-gated, not provider-gated** — the KPR-347 seam: dead for
  `server-resumable` (their resume errors mean other things and have their
  own arm) and `stateless-replay` (nothing to resume).
- Matcher narrowness is regression-pinned like the auth row: each alternate
  gets a positive pin, and the auth-row alternates get negative pins against
  this matcher (no cross-arm capture).

Why this arm is in-scope for a hotfix: persist-on-abort is what *creates* the
class of ids whose resumability is uncertain (mid-tool kill, flush timing).
Shipping the persist without the fail-safe converts SDK behavior (ii) into a
7-day dead thread — strictly worse than today's restart loop. The arm is the
insurance that makes the persist safe to ship ahead of live confirmation.

### 4. What re-entry paths see (verified, zero changes)

| Path | Read site | Behavior post-399 |
|---|---|---|
| Outage replay | processor re-dispatches original item (`outage-replay-processor.ts:101-111`) → `dispatch()` (dedup bypassed for replays) → `runWorkItemTurn` → `sessionStore.get` (`agent-manager.ts:861`) | resumes aborted session; wrapped original prompt re-sent into it |
| Next user message | same `runWorkItemTurn` read | resumes aborted session — **context intact** (the desired interaction) |
| Reflection | timer capture (L1405) + authoritative post-lock re-resolve (L932-938) | reflects over the partial turn's session |
| KPR-402 re-dispatch | whatever re-entry it builds on `runWorkItemTurn`/`dispatch` | contract in Key Points ("KPR-402's surface, stated") |
| D3 legacy path (with-progress deadline + open breaker: delivered, not queued) | no replay occurs; the *user's* next message is the re-entry | resumes — the loop breaks even where the queue never engages |

The persisted row also feeds `findAgentByThread`/`findAgentsByThread` — a
side benefit: thread→agent continuity after a restart now survives a thread
whose only turns were aborted (previously such threads had no row at all).

### 5. Rejected alternatives (⚠ delegated, recorded)

- **Eager mid-turn persistence** (write the row the moment `system/init`
  arrives): needs sessionStore (or a callback) plumbed into the runner,
  bypasses the KPR-313 provider/churn logic that lives in finalize, and races
  the per-thread-lock ordering guarantees for zero additional coverage except
  a hive-process crash mid-turn (accepted residual: a crash loses at most the
  in-flight turn's handle, exactly as today).
- **On-abort checkpoint via `query.interrupt()`** (graceful stop → CLI writes
  repaired transcript): unavailable — control requests require streaming-input
  mode; hive's `send()` passes a string prompt (`agent-runner.ts:1944-1946`).
  Converting the Claude lane to streaming input is an epic-scale change, not a
  hotfix. Recorded as the long-term "clean abort" direction.
- **Persist zero-progress aborts too:** rejected — no evidence the transcript
  flushed, no context worth resuming (at most the duplicated prompt), and it
  reintroduces the failed-resume-mint overwrite hazard churn-mint exists to
  block. D1's fail-closed posture applies.
- **Replay-path "prefer resume" edits:** unnecessary — resume preference is
  emergent from the existing store reads (§4). Touching the dispatcher would
  be scope creep into D3/KPR-402 territory.

## Integration points

| Surface | File | Change |
|---|---|---|
| Predicate export | `src/agents/provider-adapters/error-classification.ts` | `hasObservedProgress` exported (no body change); new `isClaudeResumeLoadError` + doc comment |
| Persist gate | `src/agents/agent-manager.ts:1869-1905` (`finalizeSpawnResult`) | `abortPersist` arm (§Design.2); success path byte-identical |
| Self-heal arm | `src/agents/agent-manager.ts:1020-1088` (`spawnTurn` retry chain) | third `else if` (§Design.3) |
| Session store | `src/agents/session-store.ts` | none (no-tokenData `set()` already behaves as needed, L195-201) |
| Runner | `src/agents/agent-runner.ts` | none (capture-as-assigned already present) |
| Dispatcher / outage | `src/channels/dispatcher.ts`, `src/outage/*` | none (resume preference is emergent — §Design.4) |
| Semantics descriptor | `src/agents/provider-adapters/types.ts` | none (read-only consumption of `SESSION_SEMANTICS`) |
| KPR-402 (blocked on this) | — | consumes the "KPR-402's surface, stated" contract (Key Points) |
| Docs | `docs/providers.md` | ⚠ one-row caveat *optional*: client-transcript lanes now resume after aborted turns; Lane B does not (deliberate, C3). Flagged for review; classification/persistence is engine-internal so the KPR-398 precedent says not required |

## Edge cases

1. **First-ever turn of a thread, deadline abort with progress** — no prior
   row; `system/init` id captured; persisted. Replay/follow-up resumes the
   partial first turn. (The incident's exact shape.)
2. **First-ever turn, abort with zero progress** — nothing persisted
   (fail-closed); replay restarts fresh = pre-399 behavior, D6 row
   "zero progress → hard timeout" outage path unaffected.
3. **Abort during a resumed turn, id stable** (KPR-310-verified normal case)
   — persist is a same-id TTL refresh; harmless.
4. **Abort during a resumed turn, id rotated** (post-compaction rotation,
   KPR-211) — rotated id persisted *only with progress*; the rotated
   transcript contains the replayed history + partial turn, so it is the
   right handle. Rotation with zero progress → skip (mint-guard, §Design.2).
5. **Operator stop/abort (ticket lifecycle)** — same `aborted: true` shape,
   same mechanics (deadline abort *is* `abort()` + `timedOut` stamp); with
   progress → persisted (next message continues context); the early-abort
   synthetic result (assembly-window abort) is zero-progress → skipped.
6. **Abort before `system/init`** (operator abort in the first ~seconds of a
   first turn) — `result.sessionId === ""` → guard skips.
7. **Concurrent same-thread turns — mid-turn-contender stale read (ACCEPTED
   PRE-EXISTING RESIDUAL).** A user message dispatched while the long turn is
   still running/aborting (the mid-turn "are you there?" ping is exactly this
   shape) reads the store **pre-lock** (`runWorkItemTurn` L861), waits on the
   per-thread lock, then spawns with the stale value: it misses the aborted
   turn's just-persisted handle, runs fresh, and its own success-persist
   overwrites that handle. The post-lock re-reads in `spawnTurn` do not cover
   this case — they are conditional (reflection-only L932,
   provider-mismatch-only L960, server-resumable-only L1065). This race
   predates KPR-399 (the same pre-lock read raced success-path persists) and
   this fix neither creates nor worsens it; an unconditional post-lock
   re-resolve is deliberately **out of scope** (YAGNI, hotfix) and noted as a
   possible KPR-402-adjacent follow-up if KPR-402's spec wants the stronger
   guarantee for its re-dispatch.
8. **Reflection after an aborted turn** — post-quiescence reflection resumes
   the aborted session and reflects over partial work; acceptable and
   arguably desirable (memory captures the in-progress state).
9. **Resume rejected (SDK behavior (ii))** — self-heal arm: one fresh retry,
   context lost for that thread once, row overwritten on success; never a
   dead thread. Breaker never sees a hard fault from either surface.
10. **Lane B abort** — openai/gemini/codex: `!result.aborted` guard outcome
    unchanged (C3 pin in tests). Their adapters' aborted results never reach
    the new arm (semantics gate).
11. **Lane A passthrough abort** — kimi/deepseek/grok ride
    `AgentRunner.send()` verbatim → same capture, same persist, same
    self-heal; resume replays the transcript against a cold vendor cache
    (documented parity caveat, unchanged).
12. **Replayed prompt duplication** — the resumed transcript already contains
    the original user message; replay re-sends the `replayWrap`-ed original.
    The agent sees its partial work between the two — which is exactly what
    prevents redoing side effects. Accepted residual (D8-style); prompt
    shaping is KPR-402's surface.
13. **Provider transition after an aborted turn** — the persisted row carries
    `provider`; the KPR-313 identity guard handles a later provider switch
    exactly as for success-persisted rows (handoff, history clear). No new
    interaction.
14. **7-day TTL** — unchanged; an aborted-turn row ages out like any other.

## Testing Contract

### Unit (mockable — `src/agents/*.test.ts` beside source, per repo convention)

Persist gate (`finalizeSpawnResult`, mocked `SessionStore`):

1. **New direction:** aborted claude-lane result with progress
   (`{aborted: true, timedOut: true, sessionId: "s1", toolCalls: 46, streamed: true, text: ""}`)
   → `set(agentId, threadId, "s1", "claude")` called **without tokenData**.
   **Negative-verify** (repo convention): restore the `!result.aborted`-only
   guard and confirm this test fails on pre-fix code.
2. Each D1 signal independently sufficient (three rows: `toolCalls: 1` alone /
   `streamed: true` alone / `text: "partial"` alone) → persisted.
3. **Fail-closed:** aborted, zero progress (`toolCalls: 0, streamed: false,
   text: ""`) → `set` NOT called. Also the `synthesizeAbortedResult` shape.
4. **C3 pins:** aborted-with-progress on `openai`, `gemini`, `codex` routes →
   `set` NOT called. On `kimi`/`grok` (client-transcript) → called (Lane A
   inheritance pin).
5. Empty `sessionId` on aborted result → not called.
6. **Success path unperturbed:** success persist with tokenData, churn-mint
   skip on error turns, stateless `""`-row write — existing pins re-run
   unedited (byte-identical branch).

Self-heal arm (`spawnTurn`, mocked adapter):

7. Error matching each `isClaudeResumeLoadError` alternate + `ctx.sessionId`
   set + claude route → exactly one retry with `sessionId: undefined`;
   retry's result becomes the turn result; breaker `record` called once.
8. Arm dead without a sessionId; dead on `openai` (semantics gate); mutually
   exclusive with auth-rebuild and stale-handle arms (`else if` single-retry
   pins, matching the KPR-350/351 test style).
9. **Matcher narrowness matrix:** both alternates positive-pinned; every
   `isAuthRebuildResumeError` alternate and both `isStaleServerHandleError`
   openai alternates negative-pinned against `isClaudeResumeLoadError` (and
   the new alternates against the auth row — superset rule holds:
   `classifyErrorString` of both strings → `non-provider`, pinned —
   `classifyErrorString` is module-private, so route the pin through
   `classifyTurnResult({ error })` rather than exporting the helper).

Predicate export:

10. `hasObservedProgress` export is consumed by both sites — a type-level/
    import pin (trivially, the persist tests exercise it); classifier tests
    from KPR-398 re-run unedited.

Re-entry preference (mocked store):

11. `runWorkItemTurn` builds `ctx.sessionId` from `sessionStore.get` — after
    a simulated aborted-turn persist, a second `runWorkItemTurn` on the same
    thread passes the persisted id into `spawnTurn` (pins "replay prefers
    resume" without touching dispatcher code).

### Live-instance verification (deliver lane — explicitly NOT unit-mockable, per the ticket's Caution)

To be executed on a real instance (dodi or keepur dev agent) before
ready-to-merge; evidence pasted into the ticket:

- **V1 — abort persists:** set a test agent's `timeoutMs` low (e.g. 60s);
  send a thread message that forces a long multi-tool turn. Run the scenario
  **twice**: once with the deadline landing mid-**Bash** tool call (e.g.
  "clone and summarize a large repo"), and once with it landing mid-**MCP**
  tool call (e.g. a slow `conversation-search` or `code-task` invocation) —
  the dangling-`tool_use` repair path is the ticket Caution's real subject
  and MCP tool_use blocks are its primary shape. **Evidence (each run):** the
  KPR-399 "Persisting session from aborted turn" log line; the `sessions` doc
  for `{agentId}:{threadId}` carrying a sessionId with `updatedAt` at abort
  time (mongosh).
- **V2 — follow-up resumes with context (the headline scenario):** send a
  follow-up message in the same thread ("continue"). **Evidence — all four
  corroborators:** (1) the follow-up spawn log shows `resumeSession: <id>`
  (not `"new"`) with the id **equal to** the persisted `sessions` doc's
  sessionId; (2) the resumed session's JSONL on disk
  (`~/.claude/projects/…/<id>.jsonl`) contains the pre-abort tool calls;
  (3) the agent's reply references a **concrete artifact created before the
  abort** (a file it wrote, a command's output) rather than restarting;
  (4) no resume-rejection warn fired. This is the direct probe of SDK
  behavior (i) vs (ii).
- **V3 — outage-replay resumes:** replay requires an open breaker plus a
  queued turn, so force the breaker open per the KPR-307 test recipe against
  a thread that already carries a persisted aborted-turn handle, let the 15s
  poller replay it, and confirm the replayed dispatch's spawn log shows the
  persisted id. If forcing is impractical on the instance, V2 plus unit test
  11 is the accepted fallback — record in the ticket which of the two was
  done.
- **V4 — rejection self-heal (only if V2 exposes behavior (ii)):** capture
  the exact production error string — inspect `RunResult.error` itself, not
  just CLI stderr: the runner flattens non-success result subtypes into
  `error` (agent-runner.ts L2167-2171, raw text only when an `errors` array
  is present), so a mid-continuation API failure may surface as the bare
  subtype (e.g. `error_during_execution`), which the matcher will never see — refine `isClaudeResumeLoadError` to
  match it (matcher refinement is in-contract, KPR-350 posture), and verify
  the "resume rejected — one fresh retry" warn fires and the retry completes.
  If V2 shows behavior (i), V4 is a no-op; the arm remains as insurance for
  the never-flushed-id case.
- **Record the observed SDK behavior in the ticket** either way — KPR-402's
  spec consumes it (whether a replayed resume continues mid-tool cleanly
  determines how aggressive its re-dispatch can be).

## Open assumptions (⚠ = delegated, decided here)

- ⚠ **A1 — Persist gate composition:** aborted-persist requires the D1
  progress predicate (exported, single source) + `client-transcript`
  semantics + nonempty id; no tokenData on the aborted write. Routine
  engineering choice; rationale §Design.2.
- ⚠ **A2 — Self-heal arm in-scope:** the persist creates the uncertain-id
  class, so its fail-safe ships in the same change (clean-wrap posture; a
  dead-thread regression behind a 7-day TTL is not an acceptable hotfix
  residual). If review rules it out, the persist must then be gated on V2
  confirming SDK behavior (i) before merge.
- ⚠ **A3 — Matcher wording** is docs-sourced and refined against live capture
  at delivery (KPR-350 precedent). The narrowness matrix pins protect the
  auth-row superset rule either way.
- ⚠ **A4 — Operator aborts persist too** (uniform with deadline aborts).
  If product wants "stop" to also mean "forget the partial work", that is a
  one-line gate on `result.timedOut` — no structural change. Defaulting to
  context-preserving.
- ⚠ **A5 — `docs/providers.md` untouched** (engine-internal persistence
  semantics; same ruling as KPR-398's A4). One-row caveat if review wants it.
- **A6 (informational)** — SDK behavior on mid-tool resume is genuinely
  unknown from this worktree; the design is safe under both outcomes and V2
  resolves it. This is the only assumption with a live dependency, and it
  gates ready-to-merge, not spec-ready.
