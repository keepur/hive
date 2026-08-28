# KPR-400 — Half-open probe admits the tripping long turn — breaker slow to self-heal

Child of hotfix epic **KPR-397**. Status: **spec draft** (Gate 1 delegated).

> **Canon consumed:** D6 (kpr-398-spec §Design.4 contract table is the binding
> classification baseline — byte-intact here), D8/D16 (accepted residuals — not
> relitigated), D9 (open handoffs: breaker comment truth-ups at
> `provider-circuit-breaker.ts:286`/`~429` and the `input.error ??` attenuation
> shape — **in scope here**), D13 (KPR-401's success-only p95 gates at record()
> ~L262 + settleProbe ~L436 + negative guard, all test-pinned — this design
> touches none of them).

## TL;DR

Which turn becomes the half-open probe is decided implicitly: the **first
`acquire()` to reach the breaker after cooldown elapses**
(`provider-circuit-breaker.ts:190-208`), and the 15s outage-replay drain
(`outage-replay-processor.ts` → `claimNext()` oldest-`enqueuedAt`-first) makes
that, with high probability, the oldest queued item — which is biased toward
exactly the long turn whose deadline burn accompanied the trip. Post-KPR-398
this no longer re-trips (a with-progress deadline abort settles the probe
**inconclusive**: reopen, backoff exponent unchanged, D6) and the replayed item
**exits the queue as `done` with its partial work delivered** (verified trace
below) — but two residual defects remain: **(R1)** a long turn admitted as
probe burns up to its full `timeoutMs` (900s on dodi's architects) before the
circuit can even *fail to close*, when a 3-second turn would have closed it;
**(R2)** `PROBE_STALE_MS = 360_000` mid-flight stale-reconciles any probe that
legitimately runs past 360s — deterministically wrong for the 900s architects
and *already* wrong for opus-tier agents on the router path (tier default 600s; router-off/system-sender turns still run the 300s fallback) — discarding
a genuine probe success as telemetry-only and leaving the circuit open.

Fix (hybrid of ticket options **(b)** + the stale-bound follow-on; **(a)** and
**(c)** rejected with rationale in §Design.1): **(F1)** the probe-staleness
bound follows the probe turn's own deadline — `acquire()` meta gains
`deadlineMs`, the armed probe stores `deadlineMs + 60s grace` (fallback: the
existing 360s) — and **(F2)** the outage queue records *why* each doc was
enqueued (`enqueueOrigin: "fast-fail" | "post-turn-fault"`) and `claimNext()`
prefers fast-fail-class docs (turns that never ran, typically short interactive
traffic) over post-turn-fault-class docs (turns that demonstrably ran into a
hard fault, including full-deadline burns), oldest-first within class — so the
probe slot goes to the cheapest available real turn. Zero classification
changes, zero probe-settlement changes, D13 pins untouched. Fully
unit-verifiable; no live-instance items.

## Key Points

- **Probe admission verified:** there is no explicit probe *selection*
  anywhere. `spawnTurn` calls `circuitBreakers.acquire(route.provider, …)` as
  the first act inside the spawn ticket (`agent-manager.ts:916` — the single
  production acquire site); in half-open the first acquire becomes the probe.
  Acquire sources: the 15s replay drain (oldest-first), live channel turns,
  cron/callback/event one-shots. The drain's serial `await dispatch()` means a
  replay-sourced probe *blocks the drain* for its full runtime; the ticket's
  "whatever is next in the replay queue" is confirmed, with the refinement that
  live turns can race for the slot.
- **Replayed-probe deadline-abort trace (post-398, verified):** replayed long
  turn admitted as probe → deadline fires with progress → `record()` routes to
  `settleProbe` → `turn-deadline` arm → `reopen(now, false)` (exponent
  unchanged). Dispatcher then: `maybeHandlePostTurnOutage` classifies
  `turn-deadline` ∉ `HARD_FAULT_KINDS` → **not** re-queued (Finding-4 path);
  `runResult.error` is `undefined` on the Claude deadline path (iterator
  closed, not thrown) → skips `resolveReplayRealFailure` → partial text (or
  `_No response._`) **delivered** → `recordTurnSuccess` releases the doc
  **`done`**; episode persists (breaker reopened). **The self-sustaining loop
  and the side-effect re-run concern are both already dead** — each queued long
  turn burns at most one more probe cycle, then leaves the queue. The residual
  is latency + waste, not a loop.
- **Stale-probe mid-flight trace (verified):** probe armed at T; any concurrent
  `acquire()` at T+360s+ (live traffic while a replay-probe runs; the poller's
  own 15s acquires while a *live-sourced* probe runs) fires the reconciliation
  at `acquire()` L174-188: probe slot cleared, `reopen(now, false)`. When the
  real probe turn later records, `this.probe !== p` and state ≠ closed →
  **telemetry-only**: a legitimate 400s probe *success* is discarded and the
  circuit stays open. With `openMaxMs` cooldowns this wedges recovery behind
  yet another probe cycle. This is live on dodi today (900s architects; 600s
  opus tier agents were already exposed pre-tourniquet).
- **(a)/(b)/(c) ruling:** (a) synthetic ping **rejected** — the fleet runs
  subscription auth (no `ANTHROPIC_API_KEY` by design), so a "1-token ping" on
  the Claude lane is a full CLI spawn, not a cheap API call; it violates
  KPR-306's probes-are-real-turns tenet and adds provider-path/cost/auth
  surface a hotfix can't justify. (c) probe deadline cap **rejected** — it
  truncates a *real user's* replayed turn, which under the D3/Finding-4
  semantics then completes-with-delivery and goes `done`: the user's request is
  permanently half-answered; worse, a capped probe that is merely slow to first
  byte aborts zero-progress → hard `timeout` → `settleProbe` hard-fault arm →
  **backoff escalation** — (c) can make healing *worse*. (b) **accepted in
  concrete form** (enqueue-origin class ordering) + the stale-bound fix the
  ticket itself flags as mandatory under any non-redesign option. Each piece
  pays rent independently: F2 gets a short probe admitted fast; F1 lets any
  probe that does run long actually deliver its verdict.
- **What this deliberately does not do:** no breaker state-machine or
  settlement changes (with-progress deadline probes stay inconclusive — D6
  binding, rationale documented in the D9 comment truth-ups, not relitigated);
  no starving replay while open (`outage-replay-processor.ts` §4 design note
  stands: the first post-cooldown replay attempt *is* the probe); no
  classification changes; no snapshot/contract field additions.
- **D9 handoffs executed here:** the two stale Lane-B-only breaker comments and
  the `input.error ??` attenuation shape get truth-up comments + a pin test
  (comment/documentation only — zero behavior change).

## Problem (post-398 residual framing)

**Incident (2026-08-26 02:11–02:18Z):** claude circuit half-opens at 02:11:59Z
and admits fable's replayed long turn as probe; it burns the full 300s
`timeoutMs`, classifies (pre-398) hard `timeout`, re-opens with escalation
(15s→30s→60s); loop repeats until 02:18:05Z when Mokie's short interactive turn
happens to win the probe slot and closes the circuit in 3s.

**What KPR-398 already fixed (merged, on this branch):** the same probe now
classifies `turn-deadline` (with progress) → inconclusive reopen, no
escalation, no streak reset; and the dispatcher's reconciled post-turn gate
routes the with-progress deadline abort down the legacy path, so the replayed
doc resolves `done` with partial delivery instead of re-queueing. The
*disease* (probe re-trips breaker) is cured; the *selection* and *patience*
defects remain:

- **R1 — worst-candidate selection.** Oldest-first replay drain + trip-time
  enqueue order put the most expensive turn at the head. Healing latency after
  provider recovery ≈ head item's runtime bounded by its `timeoutMs`
  (up to ~915s per long queued item on dodi, cooldown included), when any
  short queued turn — or the first live turn — would close in seconds. Each
  long-item probe cycle also wastes a full deadline of spend for a truncated
  answer.
- **R2 — probe patience bound is wrong.** `PROBE_STALE_MS = 360_000`
  (`provider-circuit-breaker.ts:74`) encodes "default 300s deadline + 60s
  grace". Effective deadlines today: 900s (four dodi architects, per-agent
  `timeoutMs`), 600s (opus resource-tier default on the router path), 300s
  default. Any probe legitimately running past 360s is stale-reconciled by the
  next concurrent acquire; its eventual outcome — *including success* — is
  telemetry-only. Under outage conditions concurrent acquires are the norm
  (queued traffic + live traffic), so long-agent probes are near-deterministically
  killed mid-flight and recovery wedges.
- **R3 — (ticket's side-effect concern) verified resolved by 398.** A replayed
  with-progress deadline-aborted probe leaves the queue as `done` (trace in
  §Key Points). Only *zero-progress* (hang-signature) replays go back to
  `pending` — correct, that's the provider-still-down case.

## Goals

1. **G1 — cheap probes when available:** after provider recovery, the probe
   slot goes to a fast-fail-class item (turn that never ran) before any
   post-turn-fault-class item; healing latency tracks the cheapest queued turn,
   not the most expensive.
2. **G2 — probes get their full deadline** (per-attempt: one permit can legitimately span two runner attempts via the auth-rebuild or stale-handle single retries — both fast-error shapes, never full-deadline burns — so G2 holds per attempt, not per permit; marginal, pre-existing under the 360s bound): a probe is never stale-reconciled
   while still inside its own turn's wall clock (+grace); a legitimate 400–900s
   probe success closes the circuit.
3. **G3 — canon intact:** zero classification changes (D6 table byte-intact),
   zero probe-settlement changes, D13's three p95 pins stay green.
4. **G4 — D9 truth-ups:** breaker comments at the `turn-deadline` record arm and
   settleProbe arm name both sources (Lane B sentinel + Claude-lane
   with-progress deadline abort) and state the binding keep-inconclusive
   rationale; the `input.error ??` attenuation shape is documented and pinned.
5. **G5 — fully unit-verified** (clock-injected breaker, fake-driver store,
   existing dispatcher harness); negative-verify per repo convention.

## Non-Goals

- No synthetic-probe infrastructure (option (a)) and no probe deadline caps
  (option (c)) — rejected, §Key Points.
- No change to probe *settlement* semantics: with-progress deadline probes
  remain inconclusive (D6 — binding; documented, not relitigated).
- No change to the replay drain's no-breaker-precheck design (§4 note in
  `outage-replay-processor.ts`): replays still probe; we reorder, never starve.
- No `ProviderCircuitOpenError` / `CircuitBreakerSnapshot` contract changes
  (additive-only rule preserved by adding nothing).
- No KPR-399 integration (parked PR #414, not on this branch) — interplay noted
  in §Edge cases only.
- No redesign of the store's boot-only `recoverStaleReplaying` /
  `STALE_REPLAYING_MS` (see §Edge cases E9 — adjacent observation flagged for
  the epic driver, out of scope).
- No `timeoutMs` policy changes (tourniquet values stand).

## Design

### 1. Fix-direction ruling

| Option | Verdict | Why |
|---|---|---|
| (a) synthetic 1-token ping | **Rejected** | Subscription auth ⇒ no raw API path on the Claude lane (a ping = full CLI spawn: seconds, session/cost surface, prompt assembly); breaks KPR-306's probes-are-real-turns tenet; per-provider plumbing ×4 lanes. Not hotfix-shaped, and post-398 the payoff no longer justifies it. |
| (b) prefer cheapest queued item | **Accepted, concretized** | True per-item runtime is unknowable ex ante, but the queue already *knows* the one discriminator that matters: did this turn ever run? Fast-fail docs (breaker rejected pre-router — zero evidence of being expensive, typically live interactive traffic) vs post-turn-fault docs (ran and hard-faulted — the trip-crossing deadline burners live here). Two-class ordering, oldest-first within class. One schema field + one sort change. |
| (c) cap probe's effective deadline | **Rejected** | Truncates a real user's replayed work, which then resolves `done` (D3 completes-with-delivery) — permanently half-answered, never re-run at full budget. And a capped zero-progress-at-60s probe classifies hard `timeout` → `settleProbe` escalates backoff: strictly worse healing for slow-to-first-byte turns. |
| stale-bound follow-on | **Accepted (mandatory)** | The ticket names it; without it G2 fails under any non-redesign option, and it is *already* broken for 600s opus-tier agents independent of the tourniquet. |

### 2. F1 — probe staleness follows the probe's own deadline (`provider-circuit-breaker.ts`, `agent-manager.ts`)

**Which agent's `timeoutMs`? The probe permit holder's own** — concretely: the
deadline of the specific turn admitted as probe, captured at its `acquire()`.
Staleness is a lost-permit guard for *this* probe; a fleet max or config knob
would be both looser and stale-prone.

- `acquire(meta?)` meta gains optional `deadlineMs?: number`. The armed probe
  stores its bound: `probeStaleAfterMs = (meta.deadlineMs ?? 300_000) +
  PROBE_STALE_GRACE_MS` where `PROBE_STALE_GRACE_MS = 60_000` (the existing
  const's two components split; meta-less acquires — tests, hypothetical future
  callers — keep the exact current 360s behavior). The reconciliation block
  compares `now - probeStartedAt > probeStaleAfterMs` instead of the module
  const. No other acquire/settle logic changes.
- **Manager side (`agent-manager.ts:916` — sole production call site):** pass
  `deadlineMs` computed from registry state already in hand at that line. The
  runner's effective wall clock is `resourceLimits?.timeoutMs ??
  agentConfig.timeoutMs ?? 300_000` (`agent-runner.ts:2037`), where
  `resourceLimits` presence depends on the router gate — so the acquire-time
  value is a small **upper bound**, which is safe (over-estimating only delays
  reconciliation of a structurally-prevented lost-permit case; under-estimating
  is the live bug):
  `deadlineMs = max(agentConfig.timeoutMs ?? 300_000, claudeTierLimitMs)` with
  `claudeTierLimitMs = resolveResourceLimits(modelToTier(agentConfig.model),
  agentConfig.resourceTiers).timeoutMs` for claude-route agents (both helpers
  are pure imports from `model-router.ts`) and `0` for non-claude routes (Lane
  B pins `agentConfig.timeoutMs ?? 300_000` exactly at `prepareSpawn`; Lane A
  uses the runner fallback). One small private helper beside the acquire site.
- **Not touched:** `record()`'s closed-state arm, `settleProbe`, `pushSample`
  and both success-only p95 gates (D13 pins), the retryAfterMs-0 contract,
  `snapshot()` shape.

### 3. F2 — enqueue-origin replay ordering (`outage-queue-store.ts`, `dispatcher.ts`)

- `OutageQueueDoc` + `OutageEnqueueInput` gain
  `enqueueOrigin: "fast-fail" | "post-turn-fault"`, written `$setOnInsert`
  (immutable after first enqueue; back-to-pending releases never touch it).
- `handleOutageTurn(item, agentId, adapter, provider, origin)` — threaded from
  its exactly two callers: `handleTurnFailure` (`ProviderCircuitOpenError` ⇒
  `"fast-fail"` — the turn never ran) and `maybeHandlePostTurnOutage` ⇒
  `"post-turn-fault"` (the turn ran and classified into `HARD_FAULT_KINDS`
  with the breaker open — trip-crossing turns, incl. zero-progress deadline
  burns).
- `claimNext()` sort becomes `{ enqueueOrigin: 1, enqueuedAt: 1 }` (filter
  unchanged). `"fast-fail"` < `"post-turn-fault"` lexicographically — the
  string ordering is load-bearing and gets a dedicated pin test; a reviewer
  preferring a numeric weight field may substitute one (⚠A2). Legacy docs
  missing the field sort first under Mongo's BSON type order (null/missing <
  string) — i.e., with fast-fail-class priority: acceptable for the one
  mid-outage-deploy window (⚠A5). Index: add
  `{ status: 1, enqueueOrigin: 1, enqueuedAt: 1 }`; the existing
  `{ status: 1, enqueuedAt: 1 }` index stays (harmless, other readers).
- `outage-replay-processor.ts`: **no code change** — `claimNext()` encapsulates
  ordering. Update its "oldest-first" doc comments (§5-2b references) to
  "class-ordered, oldest-first within class".
- Net effect at the seam: after cooldown, the drain's next claim — the turn
  most likely to become the probe — is a never-ran (typically short,
  interactive) turn; deadline-burner docs replay last, by which time the
  circuit is normally closed and they simply run with a closed breaker.

### 4. D9 comment truth-ups (documentation-only; zero behavior change)

1. `provider-circuit-breaker.ts` record() `turn-deadline` arm (~L286): comment
   currently says "Lane B wall-clock deadline expiry" — now also carries
   Claude-lane (and Lane A passthrough) with-progress deadline aborts
   (KPR-398). Same inconclusive semantics, both sources named.
2. `provider-circuit-breaker.ts` settleProbe (~L429-431): "a deadline-expired
   probe proves nothing (the provider may still be hung)" is no longer the
   whole truth — a *with-progress* deadline abort does prove the provider
   responded. Truth-up states the binding ruling: it stays inconclusive
   (KPR-398 §Design.4 / epic D6) because closing on that shape would close the
   circuit on exactly the turn-shape that caused the incident, and a provider
   degraded to trickle-slow (first bytes, then stall) would close every probe.
3. `error-classification.ts` rule-1 message (`input.error ?? …`): document the
   attenuation shape — a real error string coexisting with deadline+progress
   becomes the `turn-deadline` message verbatim, suppressing the synthesized
   evidence string. Unreachable on the Claude deadline path today (`error`
   stays `undefined`; iterator closed, not thrown); comment records that the
   error-string-wins choice is deliberate (debuggability) and pinned (T9).

## Integration points

| Surface | File | Change |
|---|---|---|
| Breaker | `src/agents/provider-circuit-breaker.ts` | acquire meta `deadlineMs`; probe stores per-probe stale bound (`PROBE_STALE_GRACE_MS` split from `PROBE_STALE_MS`); reconciliation uses it; D9 comment truth-ups ×2. **No record()/settleProbe/pushSample/snapshot changes.** |
| Manager | `src/agents/agent-manager.ts:916` | compute + pass `deadlineMs` (private upper-bound helper using `modelToTier`/`resolveResourceLimits` + `agentConfig.timeoutMs`) |
| Dispatcher | `src/channels/dispatcher.ts` | `handleOutageTurn` gains `origin` param; two call sites pass `"fast-fail"` / `"post-turn-fault"`; enqueue passes it through |
| Store | `src/outage/outage-queue-store.ts` | `enqueueOrigin` on doc + input (`$setOnInsert`); `claimNext` two-key sort; new index; doc comments |
| Replay poller | `src/outage/outage-replay-processor.ts` | none (comment touch-up only) |
| Classifier | `src/agents/provider-adapters/error-classification.ts` | comment-only (D9 item 3) |
| Tests | breaker / store / dispatcher / manager suites | §Testing |
| Docs | `docs/providers.md` | none — probe admission is engine-internal, not a provider-behavior surface (same ⚠ posture as kpr-398 A4) |

## Edge cases

1. **900s architect probe + live traffic:** concurrent acquires reject with
   `retryAfterMs: 0` (contract, unchanged) for up to ~960s while the probe
   runs; rejected turns queue as fast-fail-class and replay promptly after
   settle. Accepted trade — the price of a real long turn finishing as probe;
   F2 makes long-turn probes rare (⚠A7).
2. **Queue holds only post-turn-fault docs:** ordering degenerates to today's
   oldest-first. Correct — some real turn must probe.
3. **Empty queue, no live traffic, circuit open:** circuit stays open until the
   first acquire (unchanged); harms nobody — an open circuit with zero demand
   fast-fails nothing.
4. **Short turn queued via post-turn gate** (e.g. a 5xx trip-crosser):
   deprioritized behind fast-fail docs — replays minutes later at worst; replay
   order is best-effort, never a user-facing promise (⚠A4).
5. **Mixed-provider outage:** queue and ordering are global (claimNext is
   provider-agnostic, as today); a doc whose provider's breaker is closed just
   runs normally regardless of class. Unchanged semantics.
6. **Shadow mode (`enabled: false`):** shadow probes get the same per-probe
   stale bound; still observe-only. No behavior change beyond the bound.
7. **Replayed probe, zero-progress deadline abort (provider still hung):** hard
   `timeout` → settleProbe escalates backoff → post-turn gate (breaker open) →
   doc released back to `pending`, origin unchanged (immutable) — stays
   fast-fail-class if it started there. Deliberate: zero-progress proves the
   *provider* hung, not that the item is expensive.
8. **Process restart mid-outage:** breaker state is in-memory (resets closed);
   `recoverStaleReplaying` at boot reverts old `replaying` orphans. Unchanged.
9. **Adjacent observation (out of scope, for the epic driver):** the store's
   boot-only recovery has two latent quirks untouched by this ticket —
   `STALE_REPLAYING_MS` (360s) shares the stale 300s-deadline assumption, and a
   `replaying` orphan *younger* than the bound at boot is never re-swept
   (recovery runs once, at `start()`), stranding it until manual intervention.
   Pre-existing, not KPR-400's residual defects; flag for a follow-up ticket.
10. **KPR-399 interplay (parked PR #414, not on this branch):** when aborted
    turns become resumable, a replayed deadline-burner may resume rather than
    re-run from scratch — cheaper probes naturally, and possibly a third
    enqueue-origin nuance. Nothing here blocks it: F2's field is additive and
    F1 is deadline-agnostic about how the turn spends its clock. KPR-399
    should re-read this spec's §Design.3 when it lands.
11. **Agent deleted/disabled between enqueue and replay:** pinned-agent
    pre-check in `dispatch()` expires the doc before any acquire — probe never
    sees it. Unchanged.

## Testing (all unit; no live-instance items)

**Verification posture (constraint 5): unit-only, KPR-401 precedent.** The
breaker is in-memory with an injected clock; the store suite runs a fake driver
(`outage-queue-store.test.ts` pattern); the dispatcher suite already fakes the
manager/breaker seam. The single environment-coupled behavior — Mongo sorting
missing fields before strings — is documented BSON type ordering, mirrored in
the fake and noted in a code comment; that residual does not justify a
live-instance checklist (contrast KPR-399, whose resume semantics touched live
session state).

- **T1 (F1 core):** probe armed with `deadlineMs: 900_000`; concurrent acquire
  at +400s does **not** stale-reconcile (rejects `retryAfterMs: 0`); probe
  records success at +420s → circuit closes. **Negative-verify:** revert the
  bound to the flat 360s const → same sequence stale-kills the probe, success
  lands telemetry-only, circuit stays open.
- **T2:** meta-less acquire keeps the exact 360s fallback (existing stale-probe
  test rows stay green unmodified — they are the fallback pins).
- **T3:** per-probe bound still fires past `deadlineMs + grace` (lost-permit
  belt-and-braces preserved): acquire at +961s reconciles, `reopen(false)`.
- **T4 (D13 guard):** run the existing breaker suite untouched — the three p95
  pins (record() success gate, settleProbe success gate, negative guard) must
  pass with zero edits.
- **T5 (F2 store):** three docs — post-turn-fault@T0, fast-fail@T1,
  fast-fail@T2 → claimNext order: T1, T2, T0. Plus legacy doc (field absent)
  sorts first. Plus the constant-ordering pin:
  `"fast-fail" < "post-turn-fault"` as strings.
- **T6 (F2 dispatcher):** `ProviderCircuitOpenError` path enqueues
  `origin: "fast-fail"`; post-turn-gate path (zero-progress deadline shape from
  the existing "★ timeout gate: timedOut && aborted with breaker open" fixture — cite by test name; its line has drifted since kpr-398) enqueues `"post-turn-fault"`; a replay
  fast-failing again releases `pending` without touching origin.
- **T7 (manager):** acquire meta carries `deadlineMs` ≥ agent `timeoutMs`
  (900_000 architect shape) and ≥ opus tier limit (600_000) for an opus-model
  agent with no explicit `timeoutMs`.
- **T8:** existing dispatcher outage-gate pins (kpr-398 T11/T12) green
  unmodified.
- **T9 (D9 item 3 pin):** `{ error: "boom", timedOut: true, aborted: true,
  toolCalls: 1 }` → `{ outcome: "fault", kind: "turn-deadline",
  message: "boom" }` — pins the attenuation shape as deliberate.

## Open assumptions (⚠ = delegated, decided here; none blocking)

- ⚠ **A1 — Hybrid ruling** (b-concretized + deadline-following stale bound; (a)
  and (c) rejected): rationale §Design.1. The judgment call of this spec.
- ⚠ **A2 — `enqueueOrigin` as strings** with load-bearing lexicographic sort,
  pinned by T5; numeric weight field is an acceptable reviewer substitution.
- ⚠ **A3 — Acquire-time deadline is an upper bound**, not the exact effective
  wall clock (router-path precedence makes exactness unknowable pre-
  `prepareSpawn`); over-estimation only lengthens the wedge in the
  structurally-prevented lost-permit case. Accepted.
- ⚠ **A4 — Class ordering applies globally**, including after the breaker
  closes — replay order is best-effort, not promised. Accepted.
- ⚠ **A5 — Legacy docs (missing field) sort with top priority** for the one
  deploy-mid-outage window. Accepted.
- ⚠ **A6 — §Edge-9 store boot-recovery quirks flagged, not fixed** — candidate
  follow-up ticket for the epic driver.
- ⚠ **A7 — Long-probe head-of-line blocking accepted** (§Edge-1) — consistent
  with the D8/D16 accepted-residual posture.
