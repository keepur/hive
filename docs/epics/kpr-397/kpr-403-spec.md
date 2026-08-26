# KPR-403 — Outage-store boot recovery: deadline-aware stale bound + periodic re-sweep of replaying orphans

Child of hotfix epic **KPR-397**. Status: **spec draft** (Gate 1 delegated).

> **Canon consumed:** D19 (enqueueOrigin schema canon — the new doc field copies
> its exact pattern: sparse, `$setOnInsert`-immutable, required on the enqueue
> input, legacy-docs-fall-back; the lexicographic class order and `claimNext`'s
> sort/filter are **not touched**), D20 (acquire-time `deadlineMs` upper bound —
> `AgentManager.acquireDeadlineMs` is the established pattern and is reused
> verbatim behind a thin public wrapper), D21 (no model ids in any code block
> below), D13/D6 (untouched — stated as non-goals; no breaker or classifier file
> is edited), D22(ii) (KPR-399 reads kpr-400-spec §Design.3/§Edge-10 —
> this design does not move `claimNext`'s ordering or the replay classes;
> `enqueueOrigin` immutability is preserved by recovery).
> **Origin:** kpr-400-spec §Edge-9 / ⚠A6 — the flagged adjacent observation,
> now folded in by operator scope amendment.

## TL;DR

The outage store's `replaying`-orphan recovery has two latent quirks, both
verified in source on this branch:

1. **Stale bound encodes the dead flat-300s assumption.**
   `STALE_REPLAYING_MS = 300_000 + 60_000` (`outage-queue-store.ts:97`) is the
   same class of wrongness KPR-400's F1 fixed breaker-side for probe staleness:
   a `replaying` doc whose replay turn legitimately runs longer (600s opus-tier
   agents on the router path, 900s per-agent-override architects) can be
   reverted to `pending` **while its turn is still running**, setting up a
   duplicate dispatch of a real user turn.
2. **Recovery runs exactly once, at boot.** `recoverStaleReplaying` is called
   only from `OutageReplayProcessor.start()` (`outage-replay-processor.ts:32`).
   A crash-orphaned doc that is *younger than the bound at boot* (claimed at
   T, crash at T+10s, restart at T+30s) is never re-examined: it sits
   `replaying` forever — and because `expireOlderThan` filters on
   `status: "pending"` and TTL needs a `Date` `doneAt`, a stuck `replaying`
   doc is **immortal**: it escapes maxAgeHours expiry *and* the terminal TTL.

Fix — ticket option **(d)**, adapted from claim-time to **enqueue-time**
stamping (ruling in §Design.1): the dispatcher stamps each queue doc with
`deadlineMs` — the same D20 acquire-time upper bound the breaker's probe
staleness already uses, computed by a thin public wrapper around
`AgentManager.acquireDeadlineMs` — so recovery reads the bound **from the doc
itself**: stale ⇔ `now − lastAttemptAt > (doc.deadlineMs ?? 300_000) + 60s
grace`. Legacy docs (field absent) keep the exact current 360s behavior. And
the sweep becomes **periodic**: folded into the 15s poller tick as its first
step (boot call retained for immediacy), idempotent with itself and with the
boot pass. Disposition unchanged: swept orphans go back to `pending`
(precedent followed and justified, §Design.4). Zero breaker changes, zero
classification changes, zero `claimNext` ordering changes, no index.ts wiring
changes. Fully unit-verifiable; no live-instance items.

## Key Points

- **Who knows what at recovery time (verified):** the store is Mongo-only
  (constructor takes a bare `Collection`, `outage-queue-store.ts:100`); the
  processor has store + dispatcher + config only (`outage-replay-processor.ts:23`);
  neither can reach the agent registry. The two places that *can* know an
  agent's deadline are the manager (`acquireDeadlineMs`, `agent-manager.ts:901`
  — private, D20) and the dispatcher (holds `agentManager`,
  `dispatcher.ts:79`, and is already the sole enqueue author at
  `dispatcher.ts:660`). That seam decides the ruling: stamp the bound where
  registry access already lives — at enqueue — and let recovery be pure store
  logic reading the doc.
- **The drain is serial and tick-guarded — this bounds every race.** There is
  exactly one `claimNext` caller (the drain), the drain awaits each dispatch,
  and `tick()` is re-entrancy-guarded (`ticking` flag,
  `outage-replay-processor.ts:50-59`). So within one process **at most one doc
  is legitimately `replaying` at a time, and a sweep can never run while this
  process's own replay dispatch is in flight** — the sweep-in-tick literally
  cannot see (let alone steal) its own live claim. The deadline-aware bound is
  therefore the guard for the *cross-process* window (restart overlap: a
  predecessor process still finishing a turn while the new boot sweeps) and the
  honest lease semantics for any future concurrency change.
- **The ticket's literal (d) ("claimNext stamps claimDeadlineMs") doesn't
  survive contact with the atomicity of the claim:** the claimer picks the next
  doc *atomically* via `findOneAndUpdate` sort — it cannot know the doc's
  `agentId` (hence its deadline) until after the claim, and the processor has
  no registry anyway. Claim-time stamping would need claim → resolve → second
  write (non-atomic) plus a new resolver injection. Enqueue-time stamping is
  the same doc-carried idea at the seam that already knows the answer, and the
  staleness drift it accepts (config change during ≤4h queue residence) is
  negligible and over-estimate-safe (§Edge-3).
- **Boot semantics clarified, precedent kept:** after a genuine crash no
  previous-process turn can still be running, so an age bound at boot looks
  redundant — but `kickstart -k` restart overlap means a predecessor process
  may still be draining for a short window, which is exactly what the young-doc
  protection is for. We keep the conservative shape (bound applies at boot too)
  and close the resulting young-orphan hole with the periodic re-sweep instead
  of sweeping aggressively at boot.
- **Disposition (constraint 4): back to `pending`, attempts untouched —
  current precedent followed, and it is right** (§Design.4): expiring would
  silently drop a real user's message; partial-side-effect re-run is already
  the accepted KPR-307/KPR-398-Finding-4 posture for hard-faulted
  partially-run turns, the `replayWrap` note marks the replay to the agent,
  and the crash-loop poison case is newly *bounded* by this very fix (a
  recovered doc becomes `pending` and thus expirable at maxAgeHours — today's
  stuck doc is immortal).

## Problem

`src/outage/outage-queue-store.ts` + `src/outage/outage-replay-processor.ts`,
verified on branch @ 88f4e5c:

- **Q1 — wrong bound.** `recoverStaleReplaying(staleMs = STALE_REPLAYING_MS)`
  reverts `replaying` docs with `lastAttemptAt < now − 360s` to `pending`.
  The replay turn's real wall clock is the claimed agent's deadline —
  up to 900s on dodi today (kpr-400-spec R2 documents the same fleet reality
  breaker-side). Scenario: restart overlap (or any future concurrent sweep)
  while a 900s agent's replay is at minute 7 → doc reverted → re-claimed →
  the same user turn dispatched twice, racing its still-running twin.
- **Q2 — one-shot sweep.** Recovery runs once in `start()`. A `replaying`
  orphan younger than the bound at that instant is never looked at again.
  Follow-on today: the orphan also never expires (`expireOlderThan` is
  `pending`-only; TTL keys on terminal `doneAt: Date`) — permanent silent
  loss of a queued user turn plus a permanently-held `(itemId, agentId)`
  slot (a later re-enqueue of the same item upserts into the stuck doc's key
  and is swallowed by the `$setOnInsert` no-op).

Both are pre-existing (KPR-307-era), not KPR-400 residuals; KPR-400 §Edge-9
flagged them, this ticket fixes them.

## Goals

1. **G1 — deadline-aware staleness:** a `replaying` doc is never reverted while
   its replay turn could still legitimately be running: per-doc bound = the
   turn's acquire-time deadline upper bound (D20 semantics) + grace; legacy
   docs keep today's 360s exactly.
2. **G2 — no immortal orphans:** every crash-orphaned `replaying` doc is
   recovered within one sweep period of crossing its bound (15s tick cadence,
   best-effort under a busy drain), then flows through the normal
   pending → replay/expire lifecycle.
3. **G3 — never steal a live claim:** the sweep must not revert a doc whose
   turn is genuinely in flight — guaranteed within-process by the tick guard +
   serial drain, and cross-process by the deadline-aware bound; recovery writes
   are CAS-shaped so a doc that moved under the sweep is left alone.
4. **G4 — canon intact:** `claimNext` filter/sort untouched (D19 ordering,
   D22(ii)); `enqueueOrigin` immutability preserved by recovery; no breaker,
   classifier, or p95 surface touched (D13/D6 trivially intact).
5. **G5 — fully unit-verified** (fake-driver store suite, mock-store processor
   harness, dispatcher harness, manager row); negative-verify per repo
   convention.

## Non-Goals

- No breaker changes of any kind — `provider-circuit-breaker.ts` is not edited;
  D13's p95 pins and the probe-staleness machinery (KPR-400 F1) are out of
  scope and untouched.
- No classification changes — D6 table byte-intact; `error-classification.ts`
  not edited.
- No change to `claimNext` ordering, the replay classes, or `enqueueOrigin`
  semantics (D19; D22(ii) — KPR-399's rebase contract against kpr-400-spec
  §Design.3 is undisturbed).
- No dispatcher behavior change beyond passing one additional enqueue field —
  notices, policies, depth handling, release paths all unchanged.
- No new periodic infrastructure — the sweep rides the existing 15s tick; no
  new timer, no sweeper step, no index.ts wiring change.
- No disposition redesign — swept orphans revert to `pending` (justified,
  §Design.4); no attempt-counting changes, no new statuses.
- No retroactive backfill of `deadlineMs` onto existing docs — the legacy
  fallback covers the deploy-mid-outage window (D19-analog posture).

## Design

### 1. The (a)–(d) ruling

| Option | Verdict | Why |
|---|---|---|
| (a) registry lookup at recovery time | **Rejected** | Neither store nor processor has registry access; fixing that means injecting a resolver (or the manager) through index.ts into the processor — new wiring for a hotfix — and the resolver answers with *current* config for a turn claimed under *past* config (wrong clock after a mid-outage config edit; undefined for a deleted agent). Recovery should not need a live dependency to interpret durable state. |
| (b) fleet-wide max bound | **Rejected** | Needs the same registry access as (a) just to compute the max (or goes stale if computed once at boot), and penalizes every short-agent orphan with the fleet's worst-case wait (~960s to recover a doc whose turn could never run past 300s). Looser *and* no simpler. |
| (c) raised config constant | **Rejected** | Re-encodes fleet knowledge as a magic number — exactly the class of wrongness being fixed; breaks silently for the next longer-deadline agent. Crude-but-honest was the pre-KPR-400 world; the D20 pattern now exists and costs one field. |
| (d) doc-carried bound, **enqueue-time variant** | **Accepted** | The doc carries its own bound: deadline-aware per-doc, survives restarts, recovery stays pure store logic (no layering violation, zero new wiring). Adapted from the ticket's claim-time sketch because the claim is atomic — the claimer can't know the doc's agent before claiming, and the processor has no registry (§Key Points); the enqueue seam (dispatcher → agentManager) already knows the answer and mirrors D19's field pattern + D20's helper exactly. |

### 2. Doc-carried deadline (`outage-queue-store.ts`, `dispatcher.ts`, `agent-manager.ts`)

- **Manager:** new thin public wrapper beside the D20 helper —

  ```ts
  /** KPR-403: D20 acquire-time upper bound, exposed for outage-doc stamping. */
  turnDeadlineUpperBoundMs(agentId: string): number {
    const agentConfig = this.registry.get(agentId);
    const provider = agentConfig ? resolveProviderModel(agentConfig.model).provider : "claude";
    return this.acquireDeadlineMs(provider, agentConfig);
  }
  ```

  No change to `acquireDeadlineMs` itself (stays private; its KPR-400 pins are
  the behavior contract — the wrapper gets one thin row, T8).
- **Store schema:** `OutageQueueDoc` + `OutageEnqueueInput` gain
  `deadlineMs` — D19 pattern verbatim: **required on the input**, written
  **`$setOnInsert`** (immutable after first enqueue; back-to-pending releases
  and recovery never touch it; a re-enqueue after config drift does not rewrite
  it), **sparse on the doc** (optional in the type — absent on pre-KPR-403
  docs, which take the legacy fallback). Semantics: *upper bound on one replay
  turn's wall clock for this doc's agent, captured at enqueue* (mirrors the
  breaker meta's `deadlineMs` naming from KPR-400 F1).
- **Dispatcher:** `handleOutageTurn`'s enqueue call
  (`dispatcher.ts:660`) adds
  `deadlineMs: this.agentManager.turnDeadlineUpperBoundMs(agentId)`. Both
  callers (fast-fail at :518, post-turn at :587) flow through this single
  enqueue site — no per-caller work. The replayed-fast-fail release branch
  (:623) is untouched (release never writes the field).
- **Not touched:** `claimNext` (filter, sort, `$set` payload), `enqueue`'s
  key/upsert shape, `release`/`recordFailedAttempt`, indexes for claim order.
  No new index: recovery reads by `{ status: 1, enqueuedAt: 1 }`'s prefix
  (`status: "replaying"` equality) and the candidate set is O(1)-small
  (serial drain ⇒ ≤1 legitimate `replaying` doc + rare orphans).

### 3. Deadline-aware recovery + periodic sweep (`outage-queue-store.ts`, `outage-replay-processor.ts`)

- **Constants:** replace `STALE_REPLAYING_MS` with its two split components
  (same split KPR-400 F1 performed breaker-side):

  ```ts
  /** Legacy-doc fallback: pre-KPR-403 docs carry no deadlineMs; 300s was the
   *  flat-deadline assumption the old STALE_REPLAYING_MS encoded. */
  export const STALE_REPLAYING_FALLBACK_MS = 300_000;
  /** Grace beyond the turn's deadline for outcome-write + delivery latency. */
  export const STALE_REPLAYING_GRACE_MS = 60_000;
  ```

  Fallback + grace = 360s = byte-equivalent legacy behavior. Grep confirms no
  consumer of `STALE_REPLAYING_MS` outside the store file.
- **`recoverStaleReplaying()` becomes per-doc and parameterless** (the
  `staleMs` param is meaningless under per-doc bounds; tests migrate):

  ```ts
  /** Recovery sweep: crash between claim and release leaves `replaying`
   *  orphans. Per-doc deadline-aware (KPR-403): a doc is stale only past its
   *  own stamped turn-deadline upper bound (+grace) — never while its replay
   *  turn could legitimately still be running. Runs at boot AND every poller
   *  tick (the boot-only sweep stranded young orphans forever). CAS on
   *  (_id, status, lastAttemptAt) so a doc that moved under the sweep —
   *  released and re-claimed between read and write — is left alone. */
  async recoverStaleReplaying(): Promise<number> {
    const nowMs = this.now().getTime();
    const docs = await this.collection.find({ status: "replaying" }).toArray();
    let recovered = 0;
    for (const doc of docs) {
      const boundMs = (doc.deadlineMs ?? STALE_REPLAYING_FALLBACK_MS) + STALE_REPLAYING_GRACE_MS;
      if (!doc.lastAttemptAt || nowMs - doc.lastAttemptAt.getTime() <= boundMs) continue;
      const result = await this.collection.updateOne(
        { _id: doc._id, status: "replaying", lastAttemptAt: doc.lastAttemptAt },
        { $set: { status: "pending" } },
      );
      recovered += result.modifiedCount;
    }
    if (recovered > 0) {
      log.warn("Recovered stale replaying outage docs to pending", { count: recovered });
    }
    return recovered;
  }
  ```

  (The fake already models `find`, Date-equality matching, and `updateOne` —
  no fake extension needed. A `lastAttemptAt: null` `replaying` doc is
  unreachable via `claimNext` but deliberately skipped rather than reverted —
  malformed data should be conspicuous in logs/doctor, not silently recycled.)
- **Processor:** the sweep becomes the tick's first step; the boot call stays
  (immediacy — first tick is 15s out — and the existing processor pin at
  `outage-replay-processor.test.ts:180` expects it):

  ```ts
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // KPR-403: periodic re-sweep — boot-only recovery stranded orphans
      // younger than the bound at boot. Failure must not starve expire/drain.
      await this.store
        .recoverStaleReplaying()
        .catch((err) => log.warn("Stale-replaying recovery failed", { error: String(err) }));
      await this.expireStale();
      await this.drain();
    } finally {
      this.ticking = false;
    }
  }
  ```

  Ordering inside the tick is deliberate: sweep → expire → drain, so a
  recovered over-age orphan is expired (with its batched notice) in the same
  tick rather than replayed, and a recovered fresh orphan is claimable by the
  same tick's drain. Idempotence: the sweep's filter (status + per-doc age
  CAS) makes boot-pass/tick-pass/repeat-pass all no-ops after first success.
- **Live-turn interplay (constraint 3, explicit):** primary protection is
  structural — one `claimNext` caller, serial drain, tick re-entrancy guard ⇒
  a sweep never executes while this process's replay dispatch is in flight, so
  it cannot observe its own live claim. Secondary protection is the per-doc
  bound ⇒ a predecessor process's live claim (restart overlap) is not swept
  until its turn's deadline + grace has provably passed. Tertiary is the CAS ⇒
  a doc released-and-re-claimed between the sweep's read and write (fresh
  `lastAttemptAt`) no-ops. Cost: one indexed `find` on `status: "replaying"`
  per tick over an O(1) candidate set, plus one `updateOne` per actual orphan.

### 4. Disposition of swept orphans (constraint 4)

**Ruling: back to `pending`, attempts unchanged — today's boot-recovery
precedent, kept.** Justification against the alternative (expire):

- Expiring silently drops a real user's queued turn with no notice path (the
  expiry notice machinery keys off `expireOlderThan`'s pending scan;
  bolting notices onto recovery is new surface for a hotfix). Re-running risks
  a duplicate partial side effect **only when the process crashed mid-turn** —
  rare — while expiring loses the turn **every** time.
- Partial-side-effect re-run is already the queue's accepted posture:
  post-turn-fault docs *ran* (possibly with side effects) before enqueue
  (kpr-400-spec §Design.3), and zero-progress replays re-enter `pending` with
  origin intact (kpr-400-spec §Edge-7); KPR-398's Finding-4/D3 semantics route
  only *completed-with-delivery* shapes to `done`. A crash orphan gives zero
  progress evidence — `pending` is the conservative reading consistent with
  that canon, and `replayWrap`'s note (`outage-notices.ts:82`) flags the
  replay to the agent.
- Attempts stay untouched: `attempts` means *real (breaker-closed) replay
  attempts* (§5-2g contract, written only by `recordFailedAttempt`); a crash
  is not a turn outcome. The poison case (a doc whose replay reliably crashes
  the engine) is newly **bounded** rather than newly created: recovered →
  `pending` → `expireOlderThan` retires it at maxAgeHours. Accepted residual
  (⚠A4) — today's alternative is an immortal stuck doc, strictly worse.

## Integration points

| Surface | File | Change |
|---|---|---|
| Store | `src/outage/outage-queue-store.ts` | `deadlineMs` on doc + input (`$setOnInsert`, D19 pattern); `recoverStaleReplaying` → parameterless, per-doc bound, CAS writes; `STALE_REPLAYING_MS` → `STALE_REPLAYING_FALLBACK_MS` + `STALE_REPLAYING_GRACE_MS`; doc comments. **`claimNext`/`enqueue` key/order untouched.** |
| Replay poller | `src/outage/outage-replay-processor.ts` | sweep as tick step 1 (catch-wrapped); boot call retained; §7.1 comment truth-up (boot-only → boot + periodic) |
| Dispatcher | `src/channels/dispatcher.ts` | one field added at the single enqueue site (:660): `deadlineMs` via the manager wrapper |
| Manager | `src/agents/agent-manager.ts` | public `turnDeadlineUpperBoundMs(agentId)` wrapper over the existing private D20 helper — no change to the helper itself |
| Wiring | `src/index.ts` | **none** |
| Breaker / classifier | — | **not edited** (D13/D6 trivially intact) |
| Tests | store / processor / dispatcher / manager suites | §Testing |
| Docs | `docs/providers.md` | none — store recovery is engine-internal, not a provider-behavior surface (same posture as kpr-400 §Integration) |

## Edge cases

1. **Legacy docs (no `deadlineMs`):** fallback + grace = exactly today's 360s
   — behavior-identical for the one deploy-mid-outage window; docs enqueued
   post-deploy are stamped. D19-analog posture (⚠A2).
2. **Restart overlap (predecessor still draining):** new boot's sweep sees the
   old claim but its per-doc bound says "could still be running" until
   deadline + grace — no steal. Past the bound, the predecessor is assumed
   dead (its runner enforces the same deadline) and the doc is recovered.
3. **Config drift between enqueue and recovery:** stamp is immutable.
   Deadline *lowered* later → over-estimate → orphan waits longer (harmless).
   Deadline *raised* mid-outage above the stamp → theoretical under-estimate,
   material only in the restart-overlap window (within-process the tick guard
   already prevents any steal); consequence is one bounded duplicate replay.
   Accepted (⚠A3) — same over/under asymmetry argument as kpr-400 ⚠A3.
4. **Agent deleted between enqueue and recovery:** the doc still recovers by
   its stamped bound — no registry lookup needed (a virtue of (d)); the
   pinned-agent pre-check in `dispatch()` then expires it before any spawn
   (kpr-400-spec §Edge-11, unchanged).
5. **Sweep failure in a tick:** caught and warn-logged inside the tick; expire
   and drain proceed. Boot-call failure handling unchanged.
6. **Busy drain delays sweeps:** a long replay turn holds `ticking`, so sweep
   cadence degrades from 15s to "after the current drain" — orphans wait,
   nothing corrupts. Accepted; symmetric with expiry's existing latency under
   the same guard.
7. **Recovered over-age orphan:** sweep-before-expire ordering expires it in
   the same tick, with the standard batched expiry notice — it re-enters the
   normal lifecycle rather than replaying a >4h-stale turn.
8. **Same-item re-enqueue while a doc is stuck `replaying`:** today the upsert
   no-ops into the stuck doc (message swallowed forever). Post-fix the stuck
   doc eventually recovers and replays — the immortality fix also unblocks
   this key. No code change needed; falls out of Q2's fix.
9. **`enqueueOrigin` under recovery:** never written by the sweep — a
   recovered doc keeps its class and re-claims per D19 ordering. Pinned (T9).
10. **KPR-399 interplay (parked PR #414, not on this branch):** none —
    recovery touches neither `claimNext` ordering nor replay classes; the new
    field is additive and invisible to kpr-400-spec §Design.3/§Edge-10, so
    KPR-399's D22(ii) rebase contract is undisturbed.

## Testing (all unit; no live-instance items)

**Verification posture (constraint 5): unit-only — KPR-400/401 precedent
holds.** The store suite's fake driver already models every primitive this
design uses (`find`, `updateOne` with Date-equality filters, `$setOnInsert`
upserts, clock injection via the `now` ctor param); the processor suite mocks
the store; the dispatcher harness fakes the manager seam. Unlike KPR-400 there
is no new environment-coupled behavior at all (no BSON type-ordering reliance
added), so a live-instance checklist would verify nothing a unit row doesn't.

| # | Suite | Row | Negative-verify |
|---|---|---|---|
| T1 | store | Legacy `replaying` doc (no `deadlineMs`), `lastAttemptAt` 7 min old → recovered; 5 min old → not. Pins fallback+grace = old 360s. | Existing recovery rows migrate to this shape; the 360s boundary itself is the pin. |
| T2 | store | Doc `deadlineMs: 900_000`, `lastAttemptAt` 8 min old → **not** recovered (young under 960s bound). | Revert per-doc bound to the flat 360s const → doc is (wrongly) recovered → row fails on pre-fix code. |
| T3 | store | Same doc at 17 min → recovered to `pending`; `attempts` and `enqueueOrigin` byte-unchanged. | — (paired with T2). |
| T4 | store | CAS: doc's `lastAttemptAt` mutated between the sweep's read and write (harness mutates after `find` resolves) → not reverted, count excludes it. | Drop `lastAttemptAt` from the CAS filter → row fails. |
| T5 | store | `enqueue` stamps `deadlineMs` via `$setOnInsert`; second enqueue of the same key with a different value does not rewrite (D19 immutability). | — |
| T6 | processor | Young-orphan re-sweep (the Q2 pin): store seeded with a fresh-claimed orphan; `start()`'s boot sweep recovers nothing; advance injected clock past bound; next `tick()` recovers it and the same tick's drain claims it. | Remove the sweep from `tick()` (pre-fix shape) → doc stays `replaying` forever → row fails on pre-fix code. |
| T7 | processor | Tick ordering: recover → expireStale → drain (spy call order); sweep rejection is caught and expire/drain still run. | — |
| T8 | manager | `turnDeadlineUpperBoundMs`: per-agent-override agent → its `timeoutMs`; router-path agent with no override on a long-deadline tier → the tier limit; unknown agentId → 300s fallback. (Thin wrapper rows; the underlying helper keeps its KPR-400 pins.) | — |
| T9 | dispatcher | Outage enqueue (both origin paths) carries `deadlineMs` from the manager wrapper; the replayed-fast-fail `release("pending")` branch writes no `deadlineMs`. Existing kpr-398/400 dispatcher pins green unmodified. | — |
| T10 | store | `start()` boot-recovery pin at `outage-replay-processor.test.ts:180` stays green (call count becomes ≥1 across start+ticks — assert the boot call fires before the first interval). | — |

## Open assumptions (⚠ = delegated, decided here; none blocking)

- ⚠ **A1 — (d)-enqueue-time ruling** ((a)/(b)/(c) rejected; ticket's
  claim-time sketch adapted): rationale §Design.1. The judgment call of this
  spec.
- ⚠ **A2 — legacy docs keep 360s** for the deploy-mid-outage window; no
  backfill migration. D19-analog posture, accepted.
- ⚠ **A3 — enqueue-time stamp is immutable**; config drift during queue
  residence accepted (over-estimate harmless; under-estimate window is
  restart-overlap-only and bounded). Mirrors kpr-400 ⚠A3's asymmetry argument.
- ⚠ **A4 — recovered docs revert to `pending`** (attempts unchanged); the
  crash-loop poison case is bounded by maxAgeHours expiry, accepted residual.
  §Design.4.
- ⚠ **A5 — grace stays 60s** (split from the old constant, symmetric with
  KPR-400's `PROBE_STALE_GRACE_MS`); the auth-rebuild/stale-handle single
  retries are fast-error shapes and don't warrant widening it (same reasoning
  as kpr-400 G2's per-attempt note).
- ⚠ **A6 — sweep cadence rides the 15s tick** and degrades under a busy drain
  (§Edge-6); no dedicated timer. Accepted — orphan-recovery latency is not a
  user-facing promise.
