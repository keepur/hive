# KPR-403 — Outage-Store Boot Recovery Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** The outage store's `replaying`-orphan recovery becomes deadline-aware and periodic: **(Q1)** every queue doc is stamped at enqueue with `deadlineMs` — the same D20 acquire-time wall-clock upper bound the breaker's probe staleness uses (KPR-400 F1), computed by a new thin public manager wrapper (`turnDeadlineUpperBoundMs`) and threaded through the dispatcher's single enqueue site — and `recoverStaleReplaying` reads the bound **from the doc itself** (stale ⇔ `now − lastAttemptAt > (doc.deadlineMs ?? 300_000) + 60s grace`), so a 900s agent's replay at minute 7 is never reverted mid-flight and legacy docs keep the exact old 360s behavior; **(Q2)** the sweep runs at boot AND as the 15s poller tick's first step (sweep → expire → drain), so a crash-orphan younger than the bound at boot — today immortal (escapes `pending`-only expiry and the terminal-`doneAt` TTL) — is recovered within one sweep period of crossing its bound. Recovery writes are CAS-shaped on `(_id, status, lastAttemptAt)` so a doc released-and-re-claimed under the sweep no-ops; a `lastAttemptAt: null` `replaying` doc is skipped-with-warn, never silently recycled. Disposition unchanged: swept orphans revert to `pending`, attempts untouched. **Zero breaker changes, zero classifier changes, zero `claimNext` changes, zero index.ts wiring, no new index, no `docs/providers.md` edit.**

**Architecture:** Four source files, four test files. `src/agents/agent-manager.ts` — one new public wrapper (`turnDeadlineUpperBoundMs`) inserted directly beneath the private D20 helper `acquireDeadlineMs` (L907–912); the helper itself is untouched (its KPR-400 pins remain the behavior contract). `src/outage/outage-queue-store.ts` — `deadlineMs` on doc + input (D19 pattern verbatim: required on input, `$setOnInsert`-immutable, sparse/optional on the doc), `STALE_REPLAYING_MS` split into exported `STALE_REPLAYING_FALLBACK_MS` (300s) + `STALE_REPLAYING_GRACE_MS` (60s), `recoverStaleReplaying` rewritten parameterless/per-doc/CAS per the spec sketch; **`claimNext`, `enqueue`'s key/upsert shape, `release`, `recordFailedAttempt`, and `ensureIndexes` untouched** (recovery reads by the existing `{ status, enqueuedAt }` index prefix over an O(1) candidate set). `src/channels/dispatcher.ts` — one field added at the single enqueue site (`handleOutageTurn`, L660); both callers (fast-fail L518, post-turn L587) flow through it; the replayed-fast-fail release branch (L623) untouched. `src/outage/outage-replay-processor.ts` — sweep folded into `tick()` as its catch-wrapped first step; the `start()` boot call retained (immediacy + the existing test pin); comment truth-ups. `src/index.ts` — **not edited**.

**Tech Stack:** TypeScript (strict), Vitest, existing seams only — `outage-queue-store.test.ts`'s `FakeOutageCollection` driver fake (already models `find`, Date-equality matching, `updateOne`, `$setOnInsert` upserts, injected clock — no fake extension; T4 adds a one-shot monkey-patched `updateOne` interposer, spelled out in Task 4), `outage-replay-processor.test.ts`'s mock store + a new compact real-store mini-harness for the T6 end-to-end pin, `dispatcher.test.ts`'s `makeOutageStore`/`makeMockAgentManager`/`slackItem`/`replayItem`, `agent-manager.test.ts`'s `registry._agents`/`makeAgentConfig`/`RESOURCE_TIER_DEFAULTS`.

> **Authoritative spec:** `docs/epics/kpr-397/kpr-403-spec.md` @ e308ca3 (three Frontier rounds, final clean; §Design.1 (d)-enqueue-time ruling binding; T1–T10 binding; ⚠A1–A6 decided).
>
> **Decision Register canon consumed (KPR-397 epic):** D19 (the new `deadlineMs` field copies `enqueueOrigin`'s exact schema pattern — sparse, `$setOnInsert`-immutable, required on the enqueue input, legacy-docs-fall-back; `claimNext`'s sort/filter and the lexicographic class order are **not touched**), D20 (`AgentManager.acquireDeadlineMs` at agent-manager.ts:907 reused verbatim behind a thin public wrapper — the helper itself is not edited), D21 (model ids appearing in test code blocks are the current-ceiling ids the existing suites already use — no new ids invented), D26 (KPR-399 resume-first re-replay claims scoped exactly as spec §Edge-10/§Design.4 states them — this plan neither strengthens nor tests them; b2f4745 is on this branch, no rebase contract to manage), D28 (fixture-swap precedent available if an anchor collision appears — none expected: all anchors verified against the branch @ e308ca3), D13/D6 (trivially intact — no breaker or classifier file is edited; verified by zero-diff check in Task 8).

## Testing Contract

### Required Test Groups

- **Unit: required**
  - *Scope:* (1) **Store** (`outage-queue-store.test.ts`, driver fake): T1 — legacy `replaying` doc (field stripped), `lastAttemptAt` 7 min old → recovered; 5 min old → not (fallback+grace = the old 360s, byte-equivalent — the migrated form of the pre-existing recovery row); T2 — doc `deadlineMs: 900_000` at 8 min → **not** recovered; T3 — same shape at 17 min → recovered to `pending`, `attempts` and `enqueueOrigin` byte-unchanged; T4 — CAS: `lastAttemptAt` moved in the read→write gap (one-shot `updateOne` interposer) → not reverted, count excludes it; T5 — `enqueue` stamps `deadlineMs` via `$setOnInsert`; a re-enqueue of the same key with a different value never rewrites (D19 immutability); plus a skip-with-warn pin — a `lastAttemptAt: null` `replaying` doc is skipped, not reverted (spec sketch behavior). (2) **Processor** (`outage-replay-processor.test.ts`): T6 — the Q2 headline pin, real store over a mini driver fake: fresh-claimed orphan survives the boot-time sweep (young), clock advances past its bound, the next `tick()` recovers it and the **same tick's** drain claims and replays it; T7 — tick order recover → expire → drain (label spy), and a sweep rejection is caught with expire/drain still running; T10 — the existing `start()` boot-recovery row at L177–186 keeps its L180 pre-interval pin and gains one assertion: after the first 15s advance the sweep count is 2 (boot + tick). (3) **Manager** (`agent-manager.test.ts`): T8 — `turnDeadlineUpperBoundMs`: per-agent-override agent → its `timeoutMs` (900s); no-override opus-tier agent → `RESOURCE_TIER_DEFAULTS.opus.timeoutMs`; unknown agentId → 300s fallback. (4) **Dispatcher** (`dispatcher.test.ts`, mocked store + mocked manager): T9 — both origin paths (fast-fail instanceof, post-turn zero-progress gate) enqueue `deadlineMs` from the manager wrapper; the replayed-fast-fail `release("pending")` branch never calls the wrapper and never reaches enqueue.
  - *Reason:* T2/T4 are Q1's fix and its concurrency belt; T6 is Q2's fix end-to-end; T1 pins legacy compatibility (⚠A2); T5 pins ⚠A3 immutability; T8 pins the wrapper (without it the stamp is dead code); T9 pins the production threading; T7/T10 pin the fold's ordering and resilience.
  - *Minimum assertions:* spec §Testing rows T1–T5 (+ skip-warn) → `src/outage/outage-queue-store.test.ts` (pre-existing flat-bound recovery row **migrated into** a new `KPR-403` describe appended at end of file); T6/T7 → `src/outage/outage-replay-processor.test.ts` (new describe + mini-harness appended at end of file); T10 → same file, one added assertion inside the existing `start()` row (declared edit — the L180 pre-interval pin itself is byte-unmodified); T8 → `src/agents/agent-manager.test.ts` (three rows inside the KPR-306 wrap-point describe, after the KPR-400 F1 rows); T9 → `src/channels/dispatcher.test.ts` (three rows inside `outage interception (KPR-307)`, after the KPR-400 F2 rows). Negative-verify anchors: Tasks 2 (manager), 4 (store — commit-anchored + a manual CAS-filter edit), 5 (dispatcher), 7 (processor).
- **Integration: not-required** — Harness: not-applicable.
- **E2E: not-required** — Harness: not-applicable.

### Critical Flows

1. **900s agent's replay at minute 7 survives a sweep (Q1 cured):** doc stamped `deadlineMs: 900_000` at enqueue → claimed → a sweep at +8 min computes bound 960s, sees age 480s, skips. Pre-fix, the flat 360s bound reverted it to `pending` and set up a duplicate dispatch racing its still-running twin (T2).
2. **Immortal young orphan cured (Q2):** crash at claim+10s, restart at +30s → boot sweep skips (young — correct), and pre-fix nothing ever looked again (`expireOlderThan` is `pending`-only, TTL needs a terminal `doneAt`). Post-fix the tick-folded sweep recovers it one sweep period after its bound passes, and the same tick's drain replays it (T6).
3. **Cross-process steal window guarded three ways:** per-doc bound (a predecessor's live claim is not swept until its turn's deadline + grace has provably passed — T2), CAS write (a doc released-and-re-claimed between the sweep's read and write no-ops — T4), and within-process the tick guard + serial drain make the folded sweep structurally unable to see its own live claim (no test needed — pre-existing re-entrancy row pins the guard).
4. **Legacy-window behavior:** a pre-KPR-403 doc (no `deadlineMs`) recovers on exactly today's 360s clock — fallback 300s + grace 60s, pinned at both boundary sides (T1, ⚠A2).
5. **Recovered over-age orphan expires, not replays:** sweep-before-expire tick ordering (T7) sends a >maxAgeHours recovered doc through `expireOlderThan` in the same tick, with the standard batched notice (spec §Edge-7 — falls out of ordering; no dedicated row).

### Regression Surface

- **KPR-400 F2 rows (must stay green, zero edits):** `outage-queue-store.test.ts`'s `OutageQueueStore — enqueue-origin replay ordering (KPR-400 F2)` describe — all four rows (class-ordered `claimNext`, legacy-doc BSON priority, `"fast-fail" < "post-turn-fault"` constant pin, origin `$setOnInsert` immutability); `dispatcher.test.ts`'s three `KPR-400 F2` rows plus the two `★ KPR-398` deadline-gate rows and the release-before-depth row; `agent-manager.test.ts`'s two `KPR-400 F1` acquire-meta rows. This plan touches `claimNext` and `enqueue`'s key shape **not at all**; the only `enqueue` hunk adds the `deadlineMs` `$setOnInsert` line. Explicitly re-run by name in Task 8.
- **D13 pins (hard constraint, trivially intact):** `provider-circuit-breaker.test.ts`'s `KPR-401 pins` describe and the whole breaker/classifier surface — **no breaker or classifier file is edited**; Task 8 proves it with a zero-diff check over `src/agents/provider-circuit-breaker.*` and `src/agents/provider-adapters/`.
- `src/outage/outage-queue-store.test.ts` — every pre-existing row except the migrated flat-bound recovery row (L240–252, superseded by T1) is preserved verbatim; `makeInput` gains a `deadlineMs: 300_000` default (typecheck compat) that keeps the old rows' arithmetic identical (300s + 60s grace = old 360s).
- `src/outage/outage-replay-processor.test.ts` — every pre-existing row preserved; the one declared edit is the added post-advance sweep-count assertion in the `start()` row (T10); the L180 pre-interval boot-call pin is byte-unmodified.
- `src/channels/dispatcher.test.ts` — all pre-existing rows preserved verbatim; `makeMockAgentManager` gains a `turnDeadlineUpperBoundMs` stub (compat — without it the dispatcher source change TypeErrors inside `handleOutageTurn`'s try and every enqueue row fails); existing `objectContaining` assertions tolerate the extra enqueue field.
- `src/agents/agent-manager.test.ts` — no pre-existing row edits; the wrapper is additive and no existing row calls it. KPR-399 (b2f4745) rows in this suite are untouched and covered by the full-suite gate.
- `src/index.ts`, `docs/providers.md`, Lane B adapters, session store — deliberately untouched (spec §Integration).

### Commands

All commands run from the child worktree root. **The delivery worktree ships without `node_modules` — Task 0 runs `npm ci` first.** Env stubs are required for anything importing config (all three; `SLACK_BOT_TOKEN` is the one that actually trips):

```bash
export SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test
```

- **Setup (Task 0):** `npm ci`
- **Unit (the four touched suites):** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts src/outage/outage-replay-processor.test.ts src/channels/dispatcher.test.ts src/agents/agent-manager.test.ts`
- **Integration / E2E:** n/a
- **Broader regression:** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (typecheck + lint + format + full test suite)

### Harness Requirements

Existing Vitest harness plus three contained extensions, each spelled out in its task:

1. **T4 interposer (Task 4):** the store fake's `find()` snapshots eagerly at call time, so the read→write race cannot be staged by ordinary fixtures. The T4 row monkey-patches `fake.updateOne` **one-shot**: before delegating to the original, it moves the target doc's `lastAttemptAt` (simulating a release + re-claim landing between the sweep's `find` and its CAS write), then restores itself. The CAS filter (Date-equality on the snapshot's `lastAttemptAt`) must then no-op — `matches()` already compares Dates by `getTime()`, so no fake extension is needed.
2. **T6 mini-harness (Task 7):** a compact in-file driver fake (`MiniOutageCollection`: `updateOne`/`updateMany`/`findOne`/`findOneAndUpdate`/`find` with equality + `$lt` + Date-equality matching) driving the **real** `OutageQueueStore` through the **real** `OutageReplayProcessor.tick()`. The store suite's fake stays the authority on query-shape fidelity (ordering, upserts); the mini-harness exists solely so the young-orphan pin exercises real recovery/claim logic instead of mock choreography, and it stays beside its subject per the repo test-location convention (no new shared module).
3. **Compat stubs (Task 3, same commit as the source):** `makeInput` gains `deadlineMs: 300_000` (the input field is required — typecheck); `makeMockAgentManager` gains `turnDeadlineUpperBoundMs: vi.fn().mockReturnValue(900_000)` (the dispatcher now calls it inside `handleOutageTurn`'s try — a missing stub would be caught as a store failure and fail every enqueue row).

### Non-Required Rationale (only for not-required groups)

- **Integration:** unit-only is the spec's explicit verification posture (§Testing) and the KPR-400/401 precedent: the store suite drives the real query shapes against a driver-surface fake that already models every primitive this design uses (`find`, `updateOne` with Date-equality filters, `$setOnInsert` upserts, clock injection); the processor suite drives the real tick/drain chain; the dispatcher suite drives the real `handleTurnFailure` → `handleOutageTurn` chain; the manager rows call the real wrapper over the real D20 helper. Unlike KPR-400 there is **no new environment-coupled behavior at all** (no BSON type-ordering reliance added — the sweep filter is a plain `status` equality), so a live-instance checklist would verify nothing a unit row doesn't.
- **E2E:** no channel, process, or vendor boundary changes; orphan-recovery latency is best-effort and never a user-facing promise (⚠A6).

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Honest exit codes: never pipe a vitest run through another command without `set -o pipefail` in that shell; the commands below deliberately avoid piping vitest entirely.
- **Negative-verify (repo convention, `feedback_negative_verify_regression_tests`):** stash-free, commit-anchored reverse-apply — `git diff <anchor>^ <anchor> -- <source-file> | git apply -R`, run the suite, then `git checkout <anchor> -- <source-file>` to restore. **Never `git stash`.** Load-bearing behavioral anchors: Task 2 (manager — all three T8 rows must fail: the wrapper doesn't exist pre-fix), Task 4 (store — T2/T3/T4/T5 must fail, T3 on its stamp-persistence assertion; T1/skip-warn pass both ways by design, documented pins; plus a manual CAS-filter edit as T4's sharper spec-mandated anchor), Task 5 (dispatcher — both stamp rows must fail; the release-branch row passes both ways by design), Task 7 (processor — T6, the T7 order row, and the T10 added assertion must fail; the T7 catch row passes both ways by design).
- Per-commit-green discipline: every commit leaves the touched suites green; negative-verify steps run between a source commit and its test commit and always end with a restore + green re-run.

---

## Task 0: Worktree setup + baseline

**Files:** none (setup/verification only)

- [ ] **Step 1:** Install dependencies (the delivery worktree has no `node_modules`):

```bash
npm ci
```

- [ ] **Step 2:** Baseline the four suites this plan touches — must be green before any edit:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts src/outage/outage-replay-processor.test.ts src/channels/dispatcher.test.ts src/agents/agent-manager.test.ts
```

Expected: 0 failures. If not, stop — the branch base is broken; report a blocker.

- [ ] **Step 3:** No commit.

## Task 1: Manager — `turnDeadlineUpperBoundMs` thin public wrapper (D20)

**Files:**
- Modify: `src/agents/agent-manager.ts` (one insertion directly beneath the private `acquireDeadlineMs` helper, ~L907–912; the helper itself is **not edited** — D20)

- [ ] **Step 1:** Replace:

```ts
  private acquireDeadlineMs(provider: AgentProviderId, agentConfig: AgentConfig | undefined): number {
    const configuredMs = agentConfig?.timeoutMs ?? 300_000;
    if (!agentConfig || provider !== "claude") return configuredMs;
    const tierLimitMs = resolveResourceLimits(modelToTier(agentConfig.model), agentConfig.resourceTiers).timeoutMs;
    return Math.max(configuredMs, tierLimitMs);
  }
```

with:

```ts
  private acquireDeadlineMs(provider: AgentProviderId, agentConfig: AgentConfig | undefined): number {
    const configuredMs = agentConfig?.timeoutMs ?? 300_000;
    if (!agentConfig || provider !== "claude") return configuredMs;
    const tierLimitMs = resolveResourceLimits(modelToTier(agentConfig.model), agentConfig.resourceTiers).timeoutMs;
    return Math.max(configuredMs, tierLimitMs);
  }

  /** KPR-403: D20 acquire-time upper bound, exposed for outage-doc stamping.
   *  The dispatcher stamps each outage-queue doc with this bound at enqueue
   *  (the seam that has registry access), so the store's recovery sweep can
   *  read a doc's replay-turn wall-clock ceiling from the doc itself — no
   *  registry dependency at recovery time. Unknown agents fall back to the
   *  300s default (the doc still recovers by its stamped bound even if the
   *  agent is later deleted — kpr-403-spec §Edge-4). */
  turnDeadlineUpperBoundMs(agentId: string): number {
    const agentConfig = this.registry.get(agentId);
    const provider = agentConfig ? resolveProviderModel(agentConfig.model).provider : "claude";
    return this.acquireDeadlineMs(provider, agentConfig);
  }
```

- [ ] **Step 2:** Verify — format, typecheck, manager suite untouched-green:

```bash
npx prettier --write src/agents/agent-manager.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected: typecheck clean; 0 failures (the wrapper is additive — no existing row calls it; `resolveProviderModel` is module-local in `agent-manager.ts` and `AgentConfig` is already imported, both verified at plan time).

- [ ] **Step 3:** Commit:

```bash
git add src/agents/agent-manager.ts
git commit -m "feat(agent-manager): expose turnDeadlineUpperBoundMs — thin public wrapper over the D20 acquire-time bound (KPR-403)

The outage store's recovery sweep needs each queue doc's replay-turn
wall-clock upper bound, but neither the store (bare Collection) nor the
replay processor has registry access — the dispatcher's enqueue site is
the seam that does. Expose the KPR-400 F1 helper (acquireDeadlineMs,
unchanged — its pins remain the behavior contract) behind a public
one-liner so the dispatcher can stamp deadlineMs at enqueue. Unknown
agents fall back to the 300s default.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 2: Manager tests — T8 wrapper rows + negative-verify

**Files:**
- Modify: `src/agents/agent-manager.test.ts` (three rows inserted inside the nested `describe("provider circuit breaker at the wrap point (KPR-306)")`, immediately AFTER the closing `});` of the `it("KPR-400 F1: acquire meta deadlineMs ≥ the opus tier limit when the agent has no explicit timeoutMs", …)` block and BEFORE the `it("KPR-347 T5: assembly throws with a provider-fault-shaped message …")` block). **No edits to any pre-existing row.**

- [ ] **Step 1:** Insert at the location above, verbatim (`manager`, `registry`, `makeAgentConfig`, and the imported `RESOURCE_TIER_DEFAULTS` are all in scope; the rows sit beside the KPR-400 F1 rows because the wrapper is the same D20 surface those rows pin from the acquire side):

```ts
      it("KPR-403: turnDeadlineUpperBoundMs — per-agent timeoutMs override wins (900s architect shape)", () => {
        // NEGATIVE-VERIFY prediction (Step 3): pre-fix the wrapper does not
        // exist — all three KPR-403 rows fail with a TypeError.
        registry._agents.set(
          "agent-arch-403",
          makeAgentConfig({ id: "agent-arch-403", name: "Architect", model: "claude-sonnet-4-6", timeoutMs: 900_000 }),
        );
        // sonnet tier limit (300s) < explicit timeoutMs → max picks 900s.
        expect(manager.turnDeadlineUpperBoundMs("agent-arch-403")).toBe(900_000);
      });

      it("KPR-403: turnDeadlineUpperBoundMs — router-path agent with no override gets the long tier limit", () => {
        registry._agents.set(
          "agent-opus-403",
          makeAgentConfig({ id: "agent-opus-403", name: "OpusAgent", model: "claude-opus-4-7" }),
        );
        // No explicit timeoutMs (default 300s) < opus tier limit → max picks the tier.
        expect(manager.turnDeadlineUpperBoundMs("agent-opus-403")).toBe(RESOURCE_TIER_DEFAULTS.opus.timeoutMs);
      });

      it("KPR-403: turnDeadlineUpperBoundMs — unknown agentId falls back to the 300s default", () => {
        expect(manager.turnDeadlineUpperBoundMs("no-such-agent")).toBe(300_000);
      });
```

- [ ] **Step 2:** Verify green on fixed code, and confirm the diff is insertion-only:

```bash
npx prettier --write src/agents/agent-manager.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
git diff -- src/agents/agent-manager.test.ts
```

Expected: all tests pass including the three new rows; the diff is one contiguous insertion — no pre-existing row (in particular neither KPR-400 F1 row) touched.

- [ ] **Step 3:** Negative-verify (NO `git stash`). Task 1's commit is `HEAD`; reverse-apply its manager diff:

```bash
git diff HEAD~1 HEAD -- src/agents/agent-manager.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected: **exactly the three KPR-403 rows fail** (`manager.turnDeadlineUpperBoundMs is not a function` on pre-fix code); every pre-existing row passes. If they do not fail, stop and fix the tests.

Restore and confirm:

```bash
git checkout HEAD -- src/agents/agent-manager.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected `git status --short`: exactly ` M src/agents/agent-manager.test.ts`. Suite green post-restore.

- [ ] **Step 4:** Commit:

```bash
git add src/agents/agent-manager.test.ts
git commit -m "test(agent-manager): KPR-403 pins — turnDeadlineUpperBoundMs wrapper (override / tier / unknown-agent fallback)

Negative-verified: with Task 1's agent-manager.ts diff reverse-applied,
all three rows fail (the wrapper does not exist on pre-fix code); every
pre-existing row — including both KPR-400 F1 acquire-meta rows — passes
both ways with zero edits.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 3: Store + dispatcher source — deadlineMs stamp, per-doc CAS recovery, dispatcher threading

**Files:**
- Modify: `src/outage/outage-queue-store.ts` (constants split; doc + input field; `$setOnInsert` write; `recoverStaleReplaying` rewrite. **`claimNext`, `enqueue`'s key/filter, `release`, `recordFailedAttempt`, `ensureIndexes` untouched.**)
- Modify: `src/channels/dispatcher.ts` (one field at the single enqueue site in `handleOutageTurn`)
- Modify: `src/outage/outage-queue-store.test.ts` (**one line**: `makeInput` gains the now-required `deadlineMs` default — typecheck compat; the T-rows are Task 4)
- Modify: `src/channels/dispatcher.test.ts` (**one line**: `makeMockAgentManager` gains the `turnDeadlineUpperBoundMs` stub — runtime compat; the T9 rows are Task 5)

This is deliberately one commit: `OutageEnqueueInput.deadlineMs` is **required**, so a store-only commit leaves `npm run typecheck` red (dispatcher call + `makeInput` missing the field), and the dispatcher's new call into the mocked manager TypeErrors inside `handleOutageTurn`'s try/catch without the mock stub — failing every existing enqueue row (KPR-400 Task 5 precedent for the coupled-commit shape).

- [ ] **Step 1 (store — constants split, spec §Design.3):** In `src/outage/outage-queue-store.ts`, replace:

```ts
/** `replaying` docs older than one turn deadline (300s) + slack revert to
 *  pending at boot — crash between claim and release (spec §7.1). */
export const STALE_REPLAYING_MS = 300_000 + 60_000;
```

with:

```ts
/** Legacy-doc fallback: pre-KPR-403 docs carry no deadlineMs; 300s was the
 *  flat-deadline assumption the old STALE_REPLAYING_MS encoded. */
export const STALE_REPLAYING_FALLBACK_MS = 300_000;
/** Grace beyond the turn's deadline for outcome-write + delivery latency. */
export const STALE_REPLAYING_GRACE_MS = 60_000;
```

(Grep confirmed at plan time: no consumer of `STALE_REPLAYING_MS` outside this file.)

- [ ] **Step 2 (store — doc field, D19 pattern):** Replace (inside `OutageQueueDoc`):

```ts
  enqueueOrigin?: OutageEnqueueOrigin;
  status: OutageQueueStatus;
```

with:

```ts
  enqueueOrigin?: OutageEnqueueOrigin;
  /** KPR-403: upper bound on ONE replay turn's wall clock for this doc's
   *  agent, captured at enqueue (D20 semantics via
   *  AgentManager.turnDeadlineUpperBoundMs; mirrors the breaker acquire
   *  meta's deadlineMs naming, KPR-400 F1). $setOnInsert-immutable —
   *  back-to-pending releases and recovery never touch it; a re-enqueue
   *  after config drift does not rewrite it (spec ⚠A3). Optional: absent
   *  on pre-KPR-403 docs, which take the recovery sweep's legacy 300s
   *  fallback (spec ⚠A2, D19-analog posture). */
  deadlineMs?: number;
  status: OutageQueueStatus;
```

- [ ] **Step 3 (store — input field):** Replace:

```ts
  /** KPR-400 (F2): required from callers — see OutageEnqueueOrigin. */
  enqueueOrigin: OutageEnqueueOrigin;
}
```

with:

```ts
  /** KPR-400 (F2): required from callers — see OutageEnqueueOrigin. */
  enqueueOrigin: OutageEnqueueOrigin;
  /** KPR-403: required from callers — see OutageQueueDoc.deadlineMs. */
  deadlineMs: number;
}
```

- [ ] **Step 4 (store — `$setOnInsert` write):** Replace (inside `enqueue` — the only `enqueue` hunk; key/filter/upsert shape untouched):

```ts
          // KPR-400 (F2): $setOnInsert = immutable after first enqueue.
          enqueueOrigin: input.enqueueOrigin,
          status: "pending",
```

with:

```ts
          // KPR-400 (F2): $setOnInsert = immutable after first enqueue.
          enqueueOrigin: input.enqueueOrigin,
          // KPR-403: same immutability — the stamp is the enqueue-time truth.
          deadlineMs: input.deadlineMs,
          status: "pending",
```

- [ ] **Step 5 (store — per-doc CAS recovery, spec sketch verbatim):** Replace:

```ts
  /** Boot recovery: crash between claim and release leaves `replaying` orphans. */
  async recoverStaleReplaying(staleMs: number = STALE_REPLAYING_MS): Promise<number> {
    const cutoff = new Date(this.now().getTime() - staleMs);
    const result = await this.collection.updateMany(
      { status: "replaying", lastAttemptAt: { $lt: cutoff } },
      { $set: { status: "pending" } },
    );
    if (result.modifiedCount > 0) {
      log.warn("Recovered stale replaying outage docs to pending", { count: result.modifiedCount });
    }
    return result.modifiedCount;
  }
```

with:

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
      if (!doc.lastAttemptAt) {
        // Unreachable via claimNext (it always stamps lastAttemptAt) — skip,
        // but loudly: malformed data should be conspicuous, not recycled.
        log.warn("Replaying doc with no lastAttemptAt — skipped by recovery", {
          itemId: doc.itemId,
          agentId: doc.agentId,
        });
        continue;
      }
      const boundMs = (doc.deadlineMs ?? STALE_REPLAYING_FALLBACK_MS) + STALE_REPLAYING_GRACE_MS;
      if (nowMs - doc.lastAttemptAt.getTime() <= boundMs) continue;
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

- [ ] **Step 6 (dispatcher — the single enqueue site):** In `src/channels/dispatcher.ts` (`handleOutageTurn`), replace:

```ts
      await outage.store.enqueue({ itemId: item.id, agentId, provider, workItem: item, policy, enqueueOrigin: origin });
```

with:

```ts
      await outage.store.enqueue({
        itemId: item.id,
        agentId,
        provider,
        workItem: item,
        policy,
        enqueueOrigin: origin,
        // KPR-403: enqueue-time deadline stamp — the doc carries its own
        // replay-turn wall-clock upper bound (D20 semantics) so the store's
        // recovery sweep needs no registry access. Both origin callers flow
        // through this single site; the replayed-fast-fail release branch
        // above never writes the field ($setOnInsert-immutable, spec ⚠A3).
        deadlineMs: this.agentManager.turnDeadlineUpperBoundMs(agentId),
      });
```

- [ ] **Step 7 (store test — typecheck compat only):** In `src/outage/outage-queue-store.test.ts`, replace (inside `makeInput`):

```ts
    enqueueOrigin: "fast-fail", // KPR-400 (F2): required input field; harness default
    ...overrides,
```

with:

```ts
    enqueueOrigin: "fast-fail", // KPR-400 (F2): required input field; harness default
    deadlineMs: 300_000, // KPR-403: required input field; 300s keeps old rows' 360s arithmetic identical
    ...overrides,
```

- [ ] **Step 8 (dispatcher test — runtime compat only):** In `src/channels/dispatcher.test.ts`, replace (inside `makeMockAgentManager`):

```ts
    providerFor: vi.fn().mockReturnValue("claude"),
    circuitBreakers: { stateFor: vi.fn().mockReturnValue(null) },
```

with:

```ts
    providerFor: vi.fn().mockReturnValue("claude"),
    // KPR-403: distinctive non-default value so stamp assertions are unambiguous.
    turnDeadlineUpperBoundMs: vi.fn().mockReturnValue(900_000),
    circuitBreakers: { stateFor: vi.fn().mockReturnValue(null) },
```

- [ ] **Step 9:** Verify — format, typecheck, all touched suites green:

```bash
npx prettier --write src/outage/outage-queue-store.ts src/channels/dispatcher.ts src/outage/outage-queue-store.test.ts src/channels/dispatcher.test.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts src/outage/outage-replay-processor.test.ts src/channels/dispatcher.test.ts
```

Expected: typecheck clean; 0 failures. (Existing store rows: `makeInput` now stamps `deadlineMs: 300_000`, so the pre-existing flat-bound recovery row exercises the identical 360s clock through the new per-doc path — the CAS filter's Date-equality is already modeled by the fake's `matches()`. Dispatcher rows: existing `objectContaining` assertions tolerate the extra field and the new stub prevents the TypeError. Processor rows: the store is a mock — `recoverStaleReplaying` is already stubbed parameterlessly.)

- [ ] **Step 10:** Commit:

```bash
git add src/outage/outage-queue-store.ts src/channels/dispatcher.ts src/outage/outage-queue-store.test.ts src/channels/dispatcher.test.ts
git commit -m "fix(outage): enqueue-time deadlineMs stamp + per-doc CAS-shaped stale-replaying recovery (KPR-403 Q1)

recoverStaleReplaying's flat STALE_REPLAYING_MS = 360s encoded the dead
flat-300s deadline assumption (the same class of wrongness KPR-400 F1
fixed breaker-side): a replaying doc whose replay turn legitimately runs
longer — 600s opus-tier agents, 900s per-agent-override architects — could
be reverted to pending while its turn was still running, setting up a
duplicate dispatch of a real user turn. Each queue doc now carries its own
bound: the dispatcher stamps deadlineMs at the single enqueue site
(turnDeadlineUpperBoundMs — D20 semantics; the seam that has registry
access), \$setOnInsert-immutable per the D19 enqueueOrigin pattern, and
recovery is pure store logic reading the doc: stale iff
now − lastAttemptAt > (doc.deadlineMs ?? 300s fallback) + 60s grace.
Legacy docs (field absent) keep the exact old 360s behavior. Recovery
writes are CAS-shaped on (_id, status, lastAttemptAt) so a doc released
and re-claimed under the sweep no-ops; a lastAttemptAt-null replaying doc
is skipped with a warn, never silently recycled. claimNext (filter, sort,
\$set payload), enqueue's key/upsert shape, release, recordFailedAttempt,
and indexes are untouched. One commit across store+dispatcher+two harness
compat lines: the input field is required and the dispatcher calls the
manager wrapper inside handleOutageTurn's try, so split commits would
leave typecheck or the dispatcher suite red.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 4: Store tests — T1–T5 + skip-warn pin + T4 interposer + negative-verify

**Files:**
- Modify: `src/outage/outage-queue-store.test.ts` (delete the superseded flat-bound recovery row; append one new describe at end of file). **No other pre-existing row edited — in particular the KPR-400 F2 describe is byte-unmodified.**

- [ ] **Step 1 (migrate the flat-bound row — superseded by T1):** Delete this entire row (inside `describe("OutageQueueStore (KPR-307)")`):

```ts
  it("recoverStaleReplaying reverts only over-age replaying docs", async () => {
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "stale" }));
    await store.claimNext(); // replaying at T0
    advance(400_000); // > 360s stale threshold
    await store.enqueue(makeInput({ itemId: "fresh-claim" }));
    await store.claimNext(); // replaying at T0+400s (fresh)

    const recovered = await store.recoverStaleReplaying();
    expect(recovered).toBe(1);
    expect(fake.docs.find((d) => d.itemId === "stale")?.status).toBe("pending");
    expect(fake.docs.find((d) => d.itemId === "fresh-claim")?.status).toBe("replaying");
  });
```

(Its pin migrates to the new describe's T1 in the explicit legacy-doc shape — spec T1: "Existing recovery rows migrate to this shape; the 360s boundary itself is the pin.")

- [ ] **Step 2 (T1–T5 + skip-warn):** Append at end of file (after the closing `});` of the `OutageQueueStore — enqueue-origin replay ordering (KPR-400 F2)` describe), verbatim:

```ts

describe("OutageQueueStore — deadline-aware stale-replaying recovery (KPR-403)", () => {
  it("T1: legacy doc (no deadlineMs) keeps the exact old 360s clock — 7 min recovered, 5 min not", async () => {
    // Pin, passes both pre- and post-fix by design: fallback (300s) + grace
    // (60s) = the old flat STALE_REPLAYING_MS. Migrated form of the original
    // flat-bound recovery row, with the legacy shape made explicit.
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "legacy-old" }));
    await store.claimNext(); // replaying, lastAttemptAt = T0
    advance(120_000);
    await store.enqueue(makeInput({ itemId: "legacy-young" }));
    await store.claimNext(); // replaying, lastAttemptAt = T0+120s
    for (const d of fake.docs) delete d.deadlineMs; // simulate pre-KPR-403 docs
    advance(300_000); // now: old is 420s (>360s) stale, young is 300s (≤360s)

    const recovered = await store.recoverStaleReplaying();
    expect(recovered).toBe(1);
    expect(fake.docs.find((d) => d.itemId === "legacy-old")?.status).toBe("pending");
    expect(fake.docs.find((d) => d.itemId === "legacy-young")?.status).toBe("replaying");
  });

  it("T2: a doc stamped deadlineMs 900_000 is NOT recovered at 8 minutes (young under its 960s bound)", async () => {
    // NEGATIVE-VERIFY prediction (Step 4): pre-fix the flat 360s bound
    // (wrongly) recovers this doc — the replay turn could still be running.
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ deadlineMs: 900_000 }));
    await store.claimNext(); // replaying, lastAttemptAt = T0
    advance(480_000); // 8 min — far past the old flat 360s, well under 960s

    expect(await store.recoverStaleReplaying()).toBe(0);
    expect(fake.docs[0].status).toBe("replaying");
  });

  it("T3: the same doc at 17 minutes IS recovered to pending — attempts and enqueueOrigin byte-unchanged", async () => {
    // Paired with T2. The recovery leg matches pre-fix too (1020s > both
    // bounds), but the deadlineMs-persistence assertion still fails on
    // pre-fix code (no stamp is ever written); the payload assertions pin
    // that recovery writes status ONLY.
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ deadlineMs: 900_000, enqueueOrigin: "post-turn-fault" }));
    await store.claimNext();
    advance(1_020_000); // 17 min > 900s + 60s grace

    expect(await store.recoverStaleReplaying()).toBe(1);
    expect(fake.docs[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      enqueueOrigin: "post-turn-fault", // spec §Edge-9: never written by the sweep
      deadlineMs: 900_000, // stamp immutable through recovery
    });
  });

  it("T4: CAS — a doc that moved between the sweep's read and write is left alone", async () => {
    // The fake's find() snapshots eagerly at call time, so the concurrent
    // release + re-claim is injected INTO the read→write gap by a one-shot
    // updateOne interposer: the CAS write then sees a moved lastAttemptAt.
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "stolen" }));
    await store.claimNext(); // replaying, lastAttemptAt = T0, deadlineMs 300k (harness default)
    advance(400_000); // past 360s — sweep-eligible on age alone

    const target = fake.docs.find((d) => d.itemId === "stolen")!;
    const originalUpdateOne = fake.updateOne.bind(fake);
    fake.updateOne = async (filter: unknown, update: unknown, options?: { upsert?: boolean }) => {
      fake.updateOne = originalUpdateOne; // interpose exactly once
      // Simulate a release + fresh re-claim landing after the sweep's find:
      target.lastAttemptAt = new Date((target.lastAttemptAt as Date).getTime() + 399_000);
      return originalUpdateOne(filter, update, options);
    };

    expect(await store.recoverStaleReplaying()).toBe(0); // count excludes the moved doc
    expect(fake.docs.find((d) => d.itemId === "stolen")?.status).toBe("replaying"); // untouched
  });

  it("T5: enqueue stamps deadlineMs via $setOnInsert; a re-enqueue with a different value never rewrites it", async () => {
    // D19 immutability (spec ⚠A3): the enqueue-time stamp is the truth even
    // after config drift + a back-to-pending release re-visits the same key.
    const { store, fake } = makeStore();
    await store.enqueue(makeInput({ deadlineMs: 600_000 }));
    expect(fake.docs[0].deadlineMs).toBe(600_000);
    await store.claimNext();
    await store.release("msg-1", "agent-a", "pending", "circuit still open");
    await store.enqueue(makeInput({ deadlineMs: 900_000 })); // same (itemId, agentId) — $setOnInsert no-op
    expect(fake.docs).toHaveLength(1);
    expect(fake.docs[0].deadlineMs).toBe(600_000);
  });

  it("a replaying doc with no lastAttemptAt is skipped by recovery, never reverted (skip-with-warn guard)", async () => {
    // Unreachable via claimNext (it always stamps lastAttemptAt) — pins that
    // malformed data stays conspicuous rather than being silently recycled.
    // Passes both pre- and post-fix by design (the old $lt filter never
    // matched null either); the pin makes the skip a decision, not an accident.
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "malformed" }));
    fake.docs[0].status = "replaying";
    fake.docs[0].lastAttemptAt = null;
    advance(10_000_000);
    expect(await store.recoverStaleReplaying()).toBe(0);
    expect(fake.docs[0].status).toBe("replaying");
  });
});
```

- [ ] **Step 3:** Verify green on fixed code, and confirm the KPR-400 F2 describe is untouched:

```bash
npx prettier --write src/outage/outage-queue-store.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts
git diff -- src/outage/outage-queue-store.test.ts
```

Expected: all tests pass; the diff shows the deleted flat-bound row and the appended describe only — **no hunk inside the `KPR-400 F2` describe or any other pre-existing row**.

- [ ] **Step 4:** Negative-verify A (commit-anchored, NO `git stash`). Task 3's commit is `HEAD`; reverse-apply **only its store source diff** (dispatcher + compat lines stay):

```bash
git diff HEAD~1 HEAD -- src/outage/outage-queue-store.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts
```

Expected: **exactly T2, T3, T4, and T5 fail** on pre-fix store code — T2 (flat 360s bound wrongly recovers the 900s doc: recovered 1 ≠ 0, status pending), T3 (recovery itself matches both ways, but the reverse-applied `enqueue` writes no stamp, so the `deadlineMs: 900_000` persistence assertion gets `undefined`), T4 (pre-fix recovery is a single `updateMany` — the interposer's gap never exists and the 400s-old doc is reverted), T5 (`enqueue` writes no `deadlineMs`: first assertion gets `undefined`). T1 and the skip-with-warn row pass both ways **by design** (documented pins — the 360s legacy clock and the null-`$lt` non-match are identical pre-fix). Every pre-existing row passes (`recoverStaleReplaying()` still parameter-compatible — the old signature's `staleMs` was defaulted). If T2/T3/T4/T5 do not fail, stop — the tests are not pinning the fix.

Restore and confirm:

```bash
git checkout HEAD -- src/outage/outage-queue-store.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts
```

Expected `git status --short`: exactly ` M src/outage/outage-queue-store.test.ts`. Suite green post-restore.

- [ ] **Step 5:** Negative-verify B (T4's sharper CAS anchor — the spec-mandated manual edit). In `src/outage/outage-queue-store.ts`, temporarily change the CAS filter line

```ts
        { _id: doc._id, status: "replaying", lastAttemptAt: doc.lastAttemptAt },
```

to

```ts
        { _id: doc._id, status: "replaying" },
```

then:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts -t "T4: CAS"
git checkout HEAD -- src/outage/outage-queue-store.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts
```

Expected: with the `lastAttemptAt` guard dropped, **the T4 row fails** (the moved doc is reverted anyway — recovered 1 ≠ 0); after the `git checkout` restore the full suite is green again. This proves the row pins the CAS shape specifically, not just the age bound.

- [ ] **Step 6:** Commit:

```bash
git add src/outage/outage-queue-store.test.ts
git commit -m "test(outage-queue-store): KPR-403 pins — per-doc deadline bound, CAS recovery, \$setOnInsert stamp immutability, legacy 360s clock

The flat-bound recovery row migrates to the new describe's T1 in explicit
legacy-doc shape (field stripped; 7min/5min boundary = the old 360s clock,
pinned both sides). T4 stages the read→write race with a one-shot
updateOne interposer (the fake's find() snapshots eagerly). Negative-
verified two ways: (a) with Task 3's outage-queue-store.ts diff reverse-
applied, T2/T3/T4/T5 fail on pre-fix code (flat bound steals the 900s
doc; no stamp written or persisted; updateMany has no CAS gap) while
T1/skip-warn pass both ways by design; (b) dropping lastAttemptAt from
the CAS filter fails exactly T4. The KPR-400 F2 describe and every other
pre-existing row pass both ways with zero edits.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 5: Dispatcher tests — T9 stamp threading + negative-verify

**Files:**
- Modify: `src/channels/dispatcher.test.ts` (three rows inserted inside `describe("outage interception (KPR-307)")`, immediately AFTER the closing `});` of the `it("KPR-400 F2: a replay fast-failing again releases pending and never re-enqueues (origin stays untouched)", …)` block and BEFORE the `it("sched: turns skip with a log — never queued, never noticed", …)` block). **No edits to any pre-existing row.**

- [ ] **Step 1:** Insert at the location above, verbatim (`makeCircuitOpenError`, `makeTurn`, `slackItem`, `replayItem`, `agentManager`, `store` are all in scope; the mock wrapper returns 900_000 — Task 3's distinctive stub):

```ts
  it("KPR-403: fast-fail enqueue stamps deadlineMs from the manager wrapper", async () => {
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix the enqueue site never
    // calls the wrapper and carries no deadlineMs — objectContaining fails.
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(agentManager.turnDeadlineUpperBoundMs).toHaveBeenCalledWith("executive-assistant");
    expect(store.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "m1", enqueueOrigin: "fast-fail", deadlineMs: 900_000 }),
    );
  });

  it("KPR-403: post-turn-fault enqueue stamps deadlineMs from the manager wrapper", async () => {
    // Same fixture shape as the '★ timeout gate' row above (KPR-398
    // zero-progress hang signature) — both origin classes flow through the
    // single enqueue site, so one stamp covers both callers.
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "m1", enqueueOrigin: "post-turn-fault", deadlineMs: 900_000 }),
    );
  });

  it("KPR-403: the replayed-fast-fail release branch never consults the wrapper and never reaches enqueue", async () => {
    // Pin, passes both ways by design: the release-before-depth branch
    // predates KPR-403 and release() has no deadline parameter — the stamp
    // stays $setOnInsert-immutable at the store (pinned there, T5).
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "pending");
    expect(agentManager.turnDeadlineUpperBoundMs).not.toHaveBeenCalled();
    expect(store.enqueue).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2:** Verify green on fixed code, and confirm insertion-only (KPR-400 F2 rows and both KPR-398 ★ rows byte-unmodified):

```bash
npx prettier --write src/channels/dispatcher.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
git diff -- src/channels/dispatcher.test.ts
```

Expected: all tests pass; the diff is one contiguous insertion — no pre-existing row touched.

- [ ] **Step 3:** Negative-verify (NO `git stash`). At this point `HEAD` is Task 4's commit and **`HEAD~1` is Task 3's source commit** — confirm with `git log --oneline -2`, then reverse-apply Task 3's dispatcher diff only:

```bash
git log --oneline -2
git diff HEAD~2 HEAD~1 -- src/channels/dispatcher.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected: **exactly the two stamp rows fail** (enqueue is called without `deadlineMs` and the wrapper is never consulted on pre-fix dispatcher code — runtime is unaffected by the store's required input type; vitest does not typecheck); the release-branch row passes both ways **by design** (documented pin); every pre-existing row — including all three KPR-400 F2 rows — passes. If the two rows do not fail, stop and fix the tests.

Restore and confirm:

```bash
git checkout HEAD~1 -- src/channels/dispatcher.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected `git status --short`: exactly ` M src/channels/dispatcher.test.ts`. Suite green post-restore. (`HEAD~1` and `HEAD` carry identical `dispatcher.ts` bytes — Task 4 was test-only; `HEAD~1` is named for clarity.)

- [ ] **Step 4:** Commit:

```bash
git add src/channels/dispatcher.test.ts
git commit -m "test(dispatcher): KPR-403 pins — deadlineMs stamp threading on both outage enqueue paths

Negative-verified: with Task 3's dispatcher.ts diff reverse-applied, the
fast-fail and post-turn-fault stamp rows fail on pre-fix code (enqueue
carries no deadlineMs, the wrapper is never consulted); the replay-release
row passes both ways by design (pre-existing release-before-depth branch),
and every pre-existing row — the three KPR-400 F2 rows and both KPR-398 ★
deadline-gate rows included — passes both ways with zero edits.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 6: Processor source — sweep folded into tick as step 1, boot call retained

**Files:**
- Modify: `src/outage/outage-replay-processor.ts` (two text-anchored edits: `start()` boot-call comment truth-up; `tick()` gains the catch-wrapped sweep as its first step)

- [ ] **Step 1 (boot-call comment truth-up — §7.1 boot-only → boot + periodic):** Replace:

```ts
    // Boot recovery: crash between claim and release leaves `replaying` orphans (§7.1).
    void this.store
```

with:

```ts
    // Boot sweep (KPR-403): immediate pass — the first interval tick is 15s
    // out. The recovery sweep also rides every tick() as its first step now;
    // boot-only recovery (§7.1's original shape) stranded orphans younger
    // than the bound at boot forever. This void call runs outside the tick
    // guard and can pathologically overlap the first tick's drain on a slow
    // boot query — the per-doc deadline bound (fresh claim ⇒ young ⇒
    // skipped) plus the store's CAS write cover that window.
    void this.store
```

- [ ] **Step 2 (tick fold — spec sketch verbatim):** Replace:

```ts
  /** One poll cycle. Public for tests. Re-entrancy-guarded — a slow drain can outlive the interval. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.expireStale();
      await this.drain();
    } finally {
      this.ticking = false;
    }
  }
```

with:

```ts
  /** One poll cycle. Public for tests. Re-entrancy-guarded — a slow drain can
   *  outlive the interval. Ordering is deliberate (KPR-403): sweep → expire →
   *  drain, so a recovered over-age orphan is expired (with its batched
   *  notice) in the same tick rather than replayed, and a recovered fresh
   *  orphan is claimable by the same tick's drain. The guard also means the
   *  folded sweep can never run while this process's own replay dispatch is
   *  in flight — it structurally cannot see its own live claim. */
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

- [ ] **Step 3:** Verify — format, typecheck, processor suite green **unmodified** (interim checkpoint: the existing `start()` row's L180 pin asserts the boot call count BEFORE the first interval advance, so folding the sweep into tick does not disturb it; the mock's `recoverStaleReplaying` resolves 0 for the tick-path call):

```bash
npx prettier --write src/outage/outage-replay-processor.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-replay-processor.test.ts
```

Expected: typecheck clean; 0 failures with zero test-file edits.

- [ ] **Step 4:** Commit:

```bash
git add src/outage/outage-replay-processor.ts
git commit -m "fix(outage): fold the stale-replaying sweep into the 15s tick as its first step (KPR-403 Q2)

Recovery ran exactly once, at boot: a crash-orphaned replaying doc younger
than the bound at that instant was never re-examined — and because
expireOlderThan is pending-only and the terminal TTL keys on a Date
doneAt, a stuck replaying doc was immortal (permanent silent loss of a
queued user turn plus a permanently-held (itemId, agentId) slot swallowing
same-key re-enqueues). The sweep now runs as tick()'s catch-wrapped first
step — sweep → expire → drain, so a recovered over-age orphan expires with
its batched notice in the same tick and a recovered fresh orphan is
claimable by the same tick's drain — and the boot call stays for
immediacy (first tick is 15s out). No new timer, no index.ts wiring; the
tick guard means the folded sweep can never observe this process's own
live claim, and the per-doc bound + CAS (Task 3) cover the void boot
sweep's guard-exempt window and cross-process restart overlap.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 7: Processor tests — T6 real-store pin + T7 ordering/resilience + T10 assertion + negative-verify

**Files:**
- Modify: `src/outage/outage-replay-processor.test.ts` (one assertion added inside the existing `start()` row — the T10 declared edit; a new describe + mini-harness appended at end of file. **No other pre-existing row edited.**)

- [ ] **Step 1 (T10 — declared edit to the existing `start()` row):** Replace:

```ts
  it("start() recovers stale replaying docs and ticks on the configured interval; stop() halts it", async () => {
    vi.useFakeTimers();
    processor.start();
    expect(store.recoverStaleReplaying).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1);
```

with:

```ts
  it("start() recovers stale replaying docs and ticks on the configured interval; stop() halts it", async () => {
    vi.useFakeTimers();
    processor.start();
    expect(store.recoverStaleReplaying).toHaveBeenCalledTimes(1); // boot call fires BEFORE the first interval
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.recoverStaleReplaying).toHaveBeenCalledTimes(2); // KPR-403: the sweep also rides every tick
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2 (T6 + T7):** Append at end of file (after the closing `});` of `describe("OutageReplayProcessor (KPR-307 §7.4)")`), verbatim:

```ts

// ---------------------------------------------------------------------------
// KPR-403: deadline-aware periodic re-sweep of replaying orphans
// ---------------------------------------------------------------------------

describe("OutageReplayProcessor — periodic stale-replaying re-sweep (KPR-403)", () => {
  it("KPR-403: tick order is sweep → expire → drain; same-tick recovery feeds the same tick's drain by construction", async () => {
    // NEGATIVE-VERIFY prediction (Step 4): pre-fix tick() has no sweep step —
    // the "recover" label never appears and this row fails.
    const store = makeStore();
    const dispatcher = makeDispatcher();
    const processor = new OutageReplayProcessor(store as never, dispatcher as never, CONFIG);
    const order: string[] = [];
    store.recoverStaleReplaying.mockImplementation(async () => {
      order.push("recover");
      return 0;
    });
    store.expireOlderThan.mockImplementation(async () => {
      order.push("expire");
      return [];
    });
    store.claimNext.mockImplementation(async () => {
      order.push("drain");
      return null;
    });
    await processor.tick();
    expect(order).toEqual(["recover", "expire", "drain"]);
  });

  it("KPR-403: a sweep rejection is caught — expire and drain still run", async () => {
    // Pin, passes both ways by design pre-/post-fix (pre-fix the sweep is
    // simply absent): the point is that a Mongo hiccup in the sweep must
    // never starve expiry or the drain (spec §Edge-5).
    const store = makeStore();
    const dispatcher = makeDispatcher();
    const processor = new OutageReplayProcessor(store as never, dispatcher as never, CONFIG);
    store.recoverStaleReplaying.mockRejectedValueOnce(new Error("mongo hiccup"));
    await processor.tick(); // must not throw
    expect(store.expireOlderThan).toHaveBeenCalledTimes(1);
    expect(store.claimNext).toHaveBeenCalledTimes(1);
  });

  it("★ KPR-403 Q2: a crash-orphan younger than its bound at boot is recovered by a later tick and replayed", async () => {
    // The Q2 headline pin, on the REAL store + REAL processor tick: mock
    // choreography here would only test the mocks. The mini driver fake
    // below covers exactly the surface this flow touches; query-shape
    // fidelity (ordering, upserts, CAS) is the store suite's job.
    let clock = Date.parse("2026-07-07T12:00:00Z");
    const coll = new MiniOutageCollection();
    const realStore = new OutageQueueStore(coll as never, () => new Date(clock));
    const workItem: WorkItem = {
      id: "m1",
      text: "original question",
      source: { kind: "slack", id: "C1", label: "general" },
      sender: "user1",
      threadId: "t1",
      timestamp: new Date("2026-07-07T10:00:00Z"),
    };
    // Fresh-claimed orphan: the process crashed 10s after claimNext stamped it.
    coll.docs.push({
      _id: "d1",
      itemId: "m1",
      agentId: "agent-a",
      provider: "claude",
      workItem,
      policy: "notify",
      enqueueOrigin: "fast-fail",
      deadlineMs: 300_000,
      status: "replaying",
      attempts: 0,
      enqueuedAt: new Date(clock - 10_000),
      lastAttemptAt: new Date(clock - 10_000),
      lastError: null,
      noticeSent: true,
      doneAt: null,
    });
    const dispatcher = {
      // Dispatcher-authored outcome (§5-2g): a successful replay releases done.
      dispatch: vi.fn().mockImplementation(async (item: WorkItem) => {
        await realStore.release(item.id, "agent-a", "done");
      }),
      deliverOutageNotice: vi.fn().mockResolvedValue(undefined),
    };
    const processor = new OutageReplayProcessor(realStore as never, dispatcher as never, CONFIG, () => new Date(clock));

    // Boot-time sweep (start()'s call, 10s after the crash): orphan is far
    // under its 360s bound — correctly untouched. Pre-fix, nothing would
    // EVER look at it again (expiry is pending-only; TTL needs a Date doneAt).
    expect(await realStore.recoverStaleReplaying()).toBe(0);
    expect(coll.docs[0].status).toBe("replaying");

    clock += 400_000; // past deadlineMs 300s + 60s grace
    await processor.tick(); // sweep → expire → drain in ONE tick

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const replayed = dispatcher.dispatch.mock.calls[0][0] as WorkItem;
    expect(replayed.meta).toMatchObject({ targetAgentId: "agent-a", outageReplay: true });
    expect(coll.docs[0].status).toBe("done"); // recovered → claimed → replayed → released
  });
});

// KPR-403 T6 harness: minimal driver fake for the REAL OutageQueueStore —
// equality + $lt + Date-equality matching, $set/$setOnInsert application.
// Deliberately tiny and test-local (repo convention: harness beside its
// subject); the store suite's FakeOutageCollection remains the authority on
// full query-shape fidelity.
function miniMatches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    const val = doc[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { $lt?: unknown };
      if ("$lt" in c && !(val !== null && (val as never) < (c.$lt as never))) return false;
    } else if (val instanceof Date && cond instanceof Date) {
      if (val.getTime() !== cond.getTime()) return false;
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

function miniApply(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  for (const [k, v] of Object.entries((update.$set as Record<string, unknown>) ?? {})) doc[k] = v;
}

class MiniOutageCollection {
  docs: Record<string, unknown>[] = [];

  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>) {
    const doc = this.docs.find((d) => miniMatches(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    miniApply(doc, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>) {
    let modifiedCount = 0;
    for (const doc of this.docs) {
      if (miniMatches(doc, filter)) {
        miniApply(doc, update);
        modifiedCount++;
      }
    }
    return { modifiedCount };
  }

  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>) {
    // Sort ignored: T6 stages at most one candidate; ordering fidelity is
    // the store suite's job (KPR-400 F2 rows).
    const doc = this.docs.find((d) => miniMatches(d, filter));
    if (!doc) return null;
    miniApply(doc, update);
    return { ...doc };
  }

  async findOne(filter: Record<string, unknown>) {
    const doc = this.docs.find((d) => miniMatches(d, filter));
    return doc ? { ...doc } : null;
  }

  find(filter: Record<string, unknown>) {
    const results = this.docs.filter((d) => miniMatches(d, filter)).map((d) => ({ ...d }));
    return { toArray: async () => results };
  }
}
```

- [ ] **Step 3 (imports):** The new rows need the real store class. Replace the file's import block line:

```ts
import type { OutageQueueDoc } from "./outage-queue-store.js";
```

with:

```ts
import { OutageQueueStore, type OutageQueueDoc } from "./outage-queue-store.js";
```

- [ ] **Step 4:** Verify green on fixed code:

```bash
npx prettier --write src/outage/outage-replay-processor.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-replay-processor.test.ts
git diff -- src/outage/outage-replay-processor.test.ts
```

Expected: all tests pass; the diff shows the import widening, the two added assertions/comment in the `start()` row, and the appended describe + harness — no other pre-existing row touched.

- [ ] **Step 5:** Negative-verify (NO `git stash`). At this point `HEAD` is Task 6's commit (Task 7's test edits are uncommitted working-tree state); reverse-apply its processor diff:

```bash
git log --oneline -1
git diff HEAD~1 HEAD -- src/outage/outage-replay-processor.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-replay-processor.test.ts
```

Expected: **exactly three failures** on pre-fix processor code — the T7 order row (no "recover" label: `["expire","drain"]` ≠ `["recover","expire","drain"]`), the ★ T6 row (tick never sweeps: dispatch 0 calls, doc stays `replaying` — the immortal-orphan bug reproduced), and the `start()` row's added assertion (sweep count stays 1 after the 15s advance). The T7 catch row passes both ways **by design** (documented pin). Every other pre-existing row passes. If those three do not fail, stop and fix the tests.

Restore and confirm:

```bash
git checkout HEAD -- src/outage/outage-replay-processor.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-replay-processor.test.ts
```

Expected `git status --short`: exactly ` M src/outage/outage-replay-processor.test.ts`. Suite green post-restore.

- [ ] **Step 6:** Commit:

```bash
git add src/outage/outage-replay-processor.test.ts
git commit -m "test(outage-replay): KPR-403 pins — young-orphan re-sweep end-to-end, tick ordering, sweep-failure resilience

The ★ Q2 pin runs the REAL store (mini driver fake) through the REAL
tick(): a fresh-claimed crash-orphan survives the boot sweep (young —
correct), then a later tick recovers it past its stamped bound and the
same tick's drain claims, replays, and releases it done. Negative-
verified: with Task 6's processor diff reverse-applied, the Q2 row (doc
stays replaying forever, dispatch never fires), the order row, and the
start() row's added tick-sweep count all fail on pre-fix code; the
catch-resilience row passes both ways by design, and the L180 boot-call
pre-interval pin is byte-unmodified either way.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 8: Final verification — full gate + scope containment + explicit KPR-400/D13 checks

**Files:** none (verification only)

- [ ] **Step 1:** Full repo gate with the required env stubs:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: all four gates green — typecheck, lint, format, full vitest run (0 failures, including the untouched breaker, classifier, Lane B adapter, session-store/KPR-399, and outage-notices suites).

- [ ] **Step 2 (KPR-400 F2 rows + F1 rows explicit):** Re-run the named regression rows and prove their describes were never edited:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts -t "KPR-400 F2"
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts -t "KPR-400 F2"
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts -t "KPR-400 F1"
git diff HEAD~7 HEAD -- src/outage/outage-queue-store.test.ts src/channels/dispatcher.test.ts | grep "^[+-].*KPR-400" || true
```

Expected: store 4 passed, dispatcher 3 passed, manager 2 passed; the grep prints **nothing** — no added or removed line mentions KPR-400 (the KPR-403 insertions land after/beside those rows as pure context; any `+`/`-` line inside a KPR-400 row is a regression-surface violation: stop and investigate; the `|| true` keeps the no-match exit code from reading as a failure).

- [ ] **Step 3 (D13/D6 trivially intact — zero-diff over breaker + classifier):**

```bash
git diff HEAD~7 HEAD -- src/agents/provider-circuit-breaker.ts src/agents/provider-circuit-breaker.test.ts src/agents/circuit-breaker-heartbeat.ts src/agents/provider-adapters/ src/index.ts docs/providers.md
```

Expected: **empty output** — no breaker, classifier, adapter, wiring, or provider-docs file was touched (spec Non-Goals; D13 pins green by construction, confirmed by Step 1's full run).

- [ ] **Step 4 (claimNext/enqueue containment):** Confirm the store diff never touches the claim path:

```bash
git diff HEAD~7 HEAD -- src/outage/outage-queue-store.ts
```

Expected: hunks confined to — the constants block (`STALE_REPLAYING_MS` → the two split consts), the `OutageQueueDoc`/`OutageEnqueueInput` field additions, the one `deadlineMs` line inside `enqueue`'s `$setOnInsert`, and the `recoverStaleReplaying` rewrite. **Zero hunks inside `claimNext`, `ensureIndexes`, `release`, `recordFailedAttempt`, `expireOlderThan`, or `enqueue`'s filter/upsert options** (D19/D22(ii): ordering, classes, and `enqueueOrigin` semantics undisturbed).

- [ ] **Step 5 (scope containment):** The seven KPR-403 commits touch exactly eight files:

```bash
git diff --stat HEAD~7 HEAD -- ':!docs'
```

Expected file SET, exactly (change bars/summary line aside):

```
src/agents/agent-manager.ts
src/agents/agent-manager.test.ts
src/channels/dispatcher.ts
src/channels/dispatcher.test.ts
src/outage/outage-queue-store.ts
src/outage/outage-queue-store.test.ts
src/outage/outage-replay-processor.ts
src/outage/outage-replay-processor.test.ts
```

Additionally confirm the `agent-manager.ts` diff is the single wrapper insertion (the private `acquireDeadlineMs` body byte-unchanged — D20):

```bash
git diff HEAD~7 HEAD -- src/agents/agent-manager.ts
```

Expected: one hunk — the `turnDeadlineUpperBoundMs` wrapper (plus its doc comment) inserted after `acquireDeadlineMs`'s closing brace; no line of `acquireDeadlineMs` itself appears as `+`/`-`.

- [ ] **Step 6:** No commit (verification-only task). Do not push, do not open a PR — that is the deliver lane's job.

---

## Plan-drafting advisories (implementer notes, not deviations)

- **[Task 1]:** `resolveProviderModel` is a module-local function in `agent-manager.ts` (L194) and `AgentConfig` is already imported (KPR-400 Task 3 added it) — the wrapper needs no import changes. Verified at plan time.
- **[Task 3, Step 7]:** the `makeInput` default of `deadlineMs: 300_000` is deliberate: 300s + the 60s grace reproduces the old 360s clock exactly, so every pre-existing recovery-adjacent row's arithmetic is unchanged through the new per-doc path during the Task 3→4 interim.
- **[Task 3, Step 8]:** the dispatcher mock's `turnDeadlineUpperBoundMs` stub must land in the **same commit** as the dispatcher source change — the call sits inside `handleOutageTurn`'s try, so a missing stub is swallowed as a store failure (`return false` → legacy error path) and silently fails every enqueue row rather than throwing loudly. This is why the compat line is in Task 3, not Task 5.
- **[Task 4, T1]:** the `delete d.deadlineMs` loop simulates pre-KPR-403 docs because post-fix `enqueue` always stamps the field — deleting is the honest fixture (BSON "missing", not `undefined`-valued), same pattern as KPR-400's legacy-origin row.
- **[Task 4, T4]:** the interposer patches `updateOne`, not `find`: the sweep's per-doc loop means the mutation must land after the snapshot but before the CAS write, and the first `updateOne` call is exactly that gap. The one-shot self-restore keeps any later write in the same row (there is none today) honest.
- **[Task 7, T6]:** the boot-sweep leg calls `realStore.recoverStaleReplaying()` directly rather than `processor.start()` — start() wraps the call in a `void` promise plus a real interval, which under fake timers adds flake surface without adding coverage: the existing `start()` row (T10) already pins that boot fires the sweep before the first interval. The mini-harness ignores `findOneAndUpdate` sort by design (one candidate); ordering fidelity belongs to the store suite's KPR-400 F2 rows.
- **[Task 7, Step 3]:** `OutageQueueStore` becomes a value import in the processor test (previously types-only). The file's existing `vi.mock("../logging/logger.js")` covers the store's own `createLogger("outage-queue")` too (same module id), so the T6 row's real-store recovery warn produces no console noise; no assertion keys on log output either way.
- **[Prettier reflow]:** several new `it(...)` titles and object literals exceed print width; each task's `prettier --write` before commit rewraps them — do not treat the reflow as a deviation.
- **[Interim-state note, Task 3]:** between Tasks 3 and 4 the old flat-bound recovery row still exists and passes (stamped-300k docs reproduce the 360s clock). Its deletion is Task 4's declared migration, not a fix-up.
- **[Adjacent, out of scope]:** `ensureIndexes`'s comment mentions `recoverStaleReplaying` "still read by it" — remains true post-fix (the sweep's `status: "replaying"` equality uses the `{ status, enqueuedAt }` index prefix); deliberately not edited. The `hive doctor` outage-queue section and `db.telemetry` surfaces are untouched (no observability additions in this hotfix — spec Non-Goals).

---

## Plan-review advisories (r1, verbatim — implementer notes, not deviations)

1. [Task 7, Step 1 / Regression Surface]: "the L180 pre-interval pin itself is byte-unmodified" is imprecise — the replacement appends a trailing comment to that line (the ASSERTION EXPRESSION is unchanged, the line is not). Fully declared verbatim; don't treat the wording as a diff-check predicate — read it as "assertion-unmodified".
2. [Tasks 2/4/5/7, NV steps]: expected vitest failure phrasings are illustrative — exact runtime error text may vary; the binding check is WHICH ROWS FAIL.
3. [Task 8, Step 5]: `git diff --stat` prints a summary line; compare the file SET ("change bars/summary line aside" — as already written).
