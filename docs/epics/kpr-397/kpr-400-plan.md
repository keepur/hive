# KPR-400 — Probe Admission & Patience Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** After provider recovery the half-open probe slot goes to the cheapest available real turn and any probe that does run long gets its full deadline: **(F1)** `acquire()` meta gains `deadlineMs`, the armed probe stores `deadlineMs + 60s grace` as its own staleness bound (meta-less acquires keep the exact pre-KPR-400 360s), and the reconciliation comparison uses that per-probe bound — so a legitimate 400–900s probe is never mid-flight stale-killed and its success closes the circuit; the manager threads an acquire-time upper bound (`max(agentConfig.timeoutMs ?? 300_000, claude static-tier limit)`) into the sole production acquire site. **(F2)** the outage queue records *why* each doc was enqueued (`enqueueOrigin: "fast-fail" | "post-turn-fault"`, `$setOnInsert`-immutable) and `claimNext()` claims fast-fail-class docs (turns that never ran) before post-turn-fault-class docs (trip-crossing hard-faulters incl. deadline burners), oldest-first within class. **(D9)** the two stale Lane-B-only breaker comments and the classifier's `input.error ??` attenuation shape get truth-ups, the last with a pin test. Zero classification changes, zero probe-settlement changes, no snapshot/contract field additions, D13's three p95 pins untouched.

**Architecture:** Six source files, five test files. `src/agents/provider-circuit-breaker.ts` — const split (`PROBE_STALE_DEFAULT_DEADLINE_MS` + `PROBE_STALE_GRACE_MS` replace `PROBE_STALE_MS`), one new private field (`probeStaleAfterMs`), acquire meta widened (breaker + registry), per-probe bound armed/cleared/compared, D9 comment truth-ups ×2 — **no `record()` closed-state arm, `settleProbe`, `pushSample`, or `snapshot()` logic changes**. `src/agents/agent-manager.ts` — one private helper beside `providerFor` + three lines at the L916 acquire site (disjoint from KPR-399's PR #414 regions). `src/outage/outage-queue-store.ts` — origin type + doc/input field + `$setOnInsert` write + two-key `claimNext` sort + new index + doc comments. `src/channels/dispatcher.ts` — `handleOutageTurn` gains an `origin` param threaded from its exactly two callers; the enqueue passes it through. `src/outage/outage-replay-processor.ts` — comment touch-up only (no code). `src/agents/provider-adapters/error-classification.ts` — comment only (D9 item 3). **No `docs/providers.md` edit** (probe admission is engine-internal, spec §Integration points).

**Tech Stack:** TypeScript (strict), Vitest, existing seams only — `provider-circuit-breaker.test.ts`'s fake-clock `makeRegistry`, `outage-queue-store.test.ts`'s `FakeOutageCollection` driver fake (its `findOneAndUpdate` sort gains multi-key + BSON missing-before-string support — test-harness change, spelled out in Task 6), `dispatcher.test.ts`'s `makeOutageStore` mock + `makeMockAgentManager`, `agent-manager.test.ts`'s real `manager.circuitBreakers` (spy, not mock) + `smsCtx`/`makeAgentConfig`/`registry._agents`.

> **Authoritative spec:** `docs/epics/kpr-397/kpr-400-spec.md` @ ca157bb (Frontier round clean; the (b)+stale-bound hybrid is the ruling — §Design.1; T1–T9 binding).
>
> **Decision Register canon consumed (KPR-397 epic):** D6 (classification table byte-intact — this plan touches zero classifier behavior; the one classifier edit is a comment), D8/D16 (accepted residuals stand — long-probe head-of-line blocking ⚠A7 documented, not "fixed"), D9 (the three truth-ups execute here — breaker ×2 in Task 1, classifier + pin in Task 8), **D13 hard constraint** (the three success-only p95 pins — closed-state `record()` gate, `settleProbe` gate, negative guard, all in the `KPR-401 pins` describe — must pass with **zero edits**; F1 touches the reconciliation comparison only, verified explicitly in Tasks 2 and 9).
>
> **KPR-399 merge-order posture (PR #414, parked, not on this branch):** #414 touches `agent-manager.ts` in the `spawnTurn` retry chain (~L1020–1131) and `finalizeSpawnResult` (~L1869–1990). This plan's `agent-manager.ts` edits are the acquire site (L915–919, top of the `withSpawnTicket` lambda) and a new private helper inserted after `providerFor` (~L886) — **disjoint regions, same file**; all anchors below are text-based and survive line drift. No semantic conflict in either merge order: F2's field is additive and F1 is deadline-agnostic about how the turn spends its clock; when #414 lands, KPR-399 should re-read kpr-400-spec §Design.3 (a resumed deadline-burner replay is naturally cheaper — possible future third origin nuance, nothing here blocks it). If #414 merges into the epic branch mid-implementation: rebase, resolve any hunk-adjacency noise in favor of both changes.

## Testing Contract

### Required Test Groups

- **Unit: required**
  - *Scope:* (1) **Breaker F1** (`provider-circuit-breaker.test.ts`, fake clock): T1 — probe armed with `deadlineMs: 900_000` is NOT stale-reconciled by a concurrent acquire at +400s (contract reject `retryAfterMs: 0`, `probeInFlight` still true) and its success at +420s closes the circuit; T2 — meta-without-`deadlineMs` acquire keeps the exact 360s fallback, and the existing meta-less stale-probe row (L288, `advance(360_001)`) stays green **unmodified** (it IS the fallback pin); T3 — the per-probe bound still fires past `deadlineMs + grace` (+961s reconciles, reopen without escalation, late record telemetry-only — lost-permit belt preserved). (2) **Manager F1** (`agent-manager.test.ts`, spy on the real `manager.circuitBreakers.acquire`): T7 — acquire meta carries `deadlineMs: 900_000` for an agent with explicit `timeoutMs: 900_000` (sonnet model, tier 300s < configured) and `deadlineMs: 600_000` (opus tier limit) for an opus-model agent with no explicit `timeoutMs`. (3) **Store F2** (`outage-queue-store.test.ts`, driver fake): T5 — three docs (post-turn-fault@T0, fast-fail@T1, fast-fail@T2) claim in order T1, T2, T0; a legacy doc (field absent) claims first (BSON missing < string, ⚠A5); the constant-ordering pin `"fast-fail" < "post-turn-fault"` as strings (⚠A2); origin immutability (double-enqueue no-op + back-to-pending release never touch it). (4) **Dispatcher F2** (`dispatcher.test.ts`, mocked store): T6 — `ProviderCircuitOpenError` path enqueues `enqueueOrigin: "fast-fail"`; the post-turn zero-progress deadline shape (the `★ timeout gate: timedOut && aborted with breaker open` fixture, cited by name — KPR-398) enqueues `"post-turn-fault"`; a replay fast-failing again releases `pending` and never re-enqueues (origin untouched — store-level immutability is T5's job). (5) **Classifier D9 pin** (`error-classification.test.ts`): T9 — `{ error: "boom", timedOut: true, aborted: true, toolCalls: 1 }` → `{ outcome: "fault", kind: "turn-deadline", message: "boom" }` (the `input.error ??` attenuation shape is deliberate and pinned).
  - *Reason:* T1/T3 are the R2 fix and its preserved belt; T2 pins the no-meta compatibility contract; T7 pins the manager threading (without it F1 is dead code in production); T5/T6 are the R1 fix end-to-end across the store/dispatcher seam; T9 executes the D9 handoff.
  - *Minimum assertions:* spec §Testing rows T1–T3 → `src/agents/provider-circuit-breaker.test.ts` (new `KPR-400 F1` describe, three rows); T4 → same file, zero edits to any pre-existing row (verified in Tasks 2 + 9); T5 → `src/outage/outage-queue-store.test.ts` (new `KPR-400 F2` describe, four rows); T6 → `src/channels/dispatcher.test.ts` (three new rows inside `outage interception (KPR-307)`); T7 → `src/agents/agent-manager.test.ts` (two rows inside the KPR-306 wrap-point describe); T8 → dispatcher suite pre-existing rows (incl. both KPR-398 ★ rows) green unmodified (Tasks 7 + 9); T9 → `src/agents/provider-adapters/error-classification.test.ts` (one-row describe). Negative-verify anchors: Tasks 2 (breaker), 4 (manager), 6 (store), 7 (dispatcher).
- **Integration: not-required** — Harness: not-applicable.
- **E2E: not-required** — Harness: not-applicable.

### Critical Flows

1. **900s architect probe survives concurrency (R2 cured):** trip → cooldown → acquire with `deadlineMs: 900_000` becomes probe → concurrent acquire at +400s rejects `retryAfterMs: 0` (probe kept) → probe success at +420s **closes** the circuit. Pre-fix, the +400s acquire stale-reconciled the probe and its success landed telemetry-only with the circuit open.
2. **Cheapest-turn probe selection (R1 cured):** with a deadline-burner queued at trip time and a fast-failed interactive turn queued during the outage, `claimNext()` hands the drain the fast-fail doc first — the first post-cooldown replay (the probe, per the replay processor's §4 no-precheck design) is the short turn; the burner replays last, normally against a closed breaker.
3. **Legacy-window behavior:** a pre-KPR-400 doc (no `enqueueOrigin`) claims with top priority — acceptable for the one mid-outage-deploy window (⚠A5), pinned so it is a decision, not an accident.
4. **Fallback compatibility:** any acquire without `deadlineMs` (all existing tests, hypothetical future callers) keeps the exact 360s bound — the pre-existing stale-probe row passes byte-unmodified.
5. **Zero-progress replay probe (provider still hung):** unchanged semantics — hard `timeout` → settleProbe escalates → post-turn gate releases the doc back to `pending` with origin untouched (immutable): stays fast-fail-class if it started there (spec §Edge-7, deliberate).

### Regression Surface

- **D13 pins (hard constraint):** the three success-only p95 rows in `provider-circuit-breaker.test.ts`'s `KPR-401 pins — aborted/deadline turns never pollute the p95 window` describe — closed-state `record()` gate, `settleProbe` gate, `pushSample` negative guard. **Zero edits permitted**; explicitly re-run and diff-checked in Tasks 2 and 9.
- `src/agents/provider-circuit-breaker.test.ts` — every other pre-existing row (KPR-306 trip/recovery/backoff/contract rows, cross-episode gate rows, turn-deadline INCONCLUSIVE describe, shadow-mode rows, the L288 stale-probe row) preserved verbatim; the new describe is append-only at end of file.
- `src/channels/dispatcher.test.ts` — the KPR-307 outage describe's rows all preserved verbatim, in particular the two KPR-398 ★ rows (zero-progress queues / with-progress legacy path — spec T8) and the release-before-depth row; new rows are append-only within the describe.
- `src/outage/outage-queue-store.test.ts` — all pre-existing rows pass with the harness sort extension (all-docs-same-class degenerates to oldest-first, which is exactly the old behavior); `makeInput` gains a default `enqueueOrigin` (typecheck compat) that no existing row asserts against.
- `src/outage/outage-replay-processor.test.ts` — untouched file; its store is a mock (`claimNext: vi.fn()`), so the sort change is invisible to it; must pass unedited.
- `src/agents/agent-manager.test.ts` — no pre-existing row edits; existing KPR-306 wrap-point rows acquire without asserting meta, and the meta widening is additive.
- `src/agents/provider-adapters/error-classification.test.ts` — all rows preserved; the KPR-398 describe already pins the no-error synthesized message; the new T9 row is append-only. Source change behind it is comment-only.
- `docs/providers.md` — deliberately untouched.

### Commands

All commands run from the child worktree root. **The delivery worktree ships without `node_modules` — Task 0 runs `npm ci` first.** Env stubs are required for anything importing config (all three; `SLACK_BOT_TOKEN` is the one that actually trips):

```bash
export SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test
```

- **Setup (Task 0):** `npm ci`
- **Unit (the six touched suites):** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts src/agents/agent-manager.test.ts src/outage/outage-queue-store.test.ts src/outage/outage-replay-processor.test.ts src/channels/dispatcher.test.ts src/agents/provider-adapters/error-classification.test.ts`
- **Integration / E2E:** n/a
- **Broader regression:** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (typecheck + lint + format + full test suite)

### Harness Requirements

Existing Vitest harness plus one extension spelled out in Task 6: `FakeOutageCollection.findOneAndUpdate`'s sort currently destructures a **single** sort key; it must handle the two-key `{ enqueueOrigin: 1, enqueuedAt: 1 }` sort and mirror the one BSON type-ordering fact `claimNext` relies on (missing/null sorts before string). That fact is documented Mongo behavior — mirrored in the fake and noted in a code comment (spec §Testing verification posture; the residual does not justify a live-instance checklist). Everything else uses seams that already exist: `makeRegistry` (injected clock), `expectOpenThrow`, `smsCtx`/`makeAgentConfig`/`registry._agents`, `makeOutageStore`/`makeTurn`/`slackItem`/`replayItem`.

### Non-Required Rationale (only for not-required groups)

- **Integration:** the breaker is a pure in-memory state machine driven end-to-end by its fake-clock suite; the store suite drives the real query shapes against a driver-surface fake; the dispatcher suite drives the real `handleTurnFailure`/`maybeHandlePostTurnOutage`/`handleOutageTurn` chain against a mocked store; the manager suite drives the real `spawnTurn` → `acquire` path with a real breaker registry. Those ARE this repo's integration surfaces for this seam (KPR-401 precedent). The single environment-coupled behavior (BSON missing < string) is documented, mirrored, and comment-noted.
- **E2E:** no channel, process, or vendor boundary changes; replay ordering is best-effort and never a user-facing promise (⚠A4).

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Honest exit codes: never pipe a vitest run through another command without `set -o pipefail` in that shell; the commands below deliberately avoid piping vitest entirely.
- **Negative-verify (repo convention, `feedback_negative_verify_regression_tests`):** stash-free, commit-anchored reverse-apply — `git diff <anchor>^ <anchor> -- <source-file> | git apply -R`, run the suite, then `git checkout <anchor> -- <source-file>` to restore. **Never `git stash`.** Load-bearing behavioral anchors: Task 2 (breaker — T1 must fail pre-fix), Task 4 (manager — both T7 rows must fail), Task 6 (store — ordering/legacy/immutability rows must fail), Task 7 (dispatcher — both origin rows must fail). Rows that pass both ways are pins, called out per task (T2/T3 breaker rows, the constant-ordering pin, the replay-release dispatcher row). Task 8's T9 is **degenerate by construction** (comment-only source change — no pre-fix state to fail against; KPR-401 Task 7 precedent).
- Per-commit-green discipline: every commit leaves the touched suites green; negative-verify steps run between a source commit and its test commit and always end with a restore + green re-run.

---

## Task 0: Worktree setup + baseline

**Files:** none (setup/verification only)

- [ ] **Step 1:** Install dependencies (the delivery worktree has no `node_modules`):

```bash
npm ci
```

- [ ] **Step 2:** Baseline the six suites this plan touches — must be green before any edit:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts src/agents/agent-manager.test.ts src/outage/outage-queue-store.test.ts src/outage/outage-replay-processor.test.ts src/channels/dispatcher.test.ts src/agents/provider-adapters/error-classification.test.ts
```

Expected: 0 failures. If not, stop — the branch base is broken; report a blocker.

- [ ] **Step 3:** No commit.

## Task 1: Breaker F1 — per-probe stale bound + D9 comment truth-ups ×2

**Files:**
- Modify: `src/agents/provider-circuit-breaker.ts` (nine text-anchored edits: const block ~L64–74; field ~L145; acquire signature + reconciliation ~L171–188; reconciliation clear ~L185–187; probe-arm ~L199–202; record() probe-clear ~L243–246; record() turn-deadline comment ~L285–293; settleProbe comment ~L428–431; registry acquire ~L497–500)
- Test: none in this task (existing suite must stay green; new tests are Task 2)

- [ ] **Step 1 (const split — spec §Design.2):** Replace:

```ts
/**
 * Probe-permit staleness bound: default 300s turn deadline + 60s grace. A
 * probe permit never recorded (caller lost between acquire and record —
 * structurally prevented at the wrap point, belt-and-braces here) is
 * reconciled as inconclusive on the next acquire.
 *
 * Agents with a custom `timeoutMs` > 300s can hit premature stale-probe
 * reconciliation here — bounded and safe: a late probe success still
 * records as telemetry-only, and the next post-cooldown turn re-probes.
 */
const PROBE_STALE_MS = 360_000;
```

with:

```ts
/**
 * Probe-permit staleness (KPR-400 F1): the bound follows the probe turn's
 * OWN deadline, captured at its acquire() (`meta.deadlineMs`), plus a fixed
 * grace. Staleness is a lost-permit guard for THIS probe (caller lost
 * between acquire and record — structurally prevented at the wrap point,
 * belt-and-braces here); the old flat 360s bound stale-killed any probe
 * legitimately running past 360s (900s per-agent `timeoutMs` architects,
 * 600s opus-tier agents on the router path) and discarded its eventual
 * outcome — including success — as telemetry-only, wedging recovery
 * (kpr-400-spec R2). Meta-less acquires (tests, hypothetical future
 * callers) keep the exact pre-KPR-400 bound: 300s default deadline + 60s
 * grace = 360s.
 */
const PROBE_STALE_DEFAULT_DEADLINE_MS = 300_000;
const PROBE_STALE_GRACE_MS = 60_000;
```

- [ ] **Step 2 (per-probe field):** Replace:

```ts
  private probe: InternalPermit | null = null;
  private probeStartedAt: number | null = null;
```

with:

```ts
  private probe: InternalPermit | null = null;
  private probeStartedAt: number | null = null;
  // KPR-400 (F1): this probe's staleness bound — (deadlineMs at acquire ??
  // 300s default) + 60s grace. Armed with the probe, cleared wherever the
  // probe slot is cleared. Deliberately NOT surfaced in snapshot() (no
  // contract field additions — kpr-400-spec Non-Goals).
  private probeStaleAfterMs: number | null = null;
```

- [ ] **Step 3 (acquire signature + reconciliation comparison):** Replace:

```ts
  acquire(meta?: { agentId?: string; threadId?: string }): TurnPermit {
    const now = this.now();

    // Belt-and-braces: reconcile a probe permit that was never recorded.
    if (
      this.state === "half-open" &&
      this.probe !== null &&
      this.probeStartedAt !== null &&
      now - this.probeStartedAt > PROBE_STALE_MS
    ) {
```

with:

```ts
  acquire(meta?: { agentId?: string; threadId?: string; deadlineMs?: number }): TurnPermit {
    const now = this.now();

    // Belt-and-braces: reconcile a probe permit that was never recorded.
    // KPR-400 (F1): the comparison uses the per-probe bound armed below — a
    // probe still inside its own turn's wall clock (+grace) is never
    // reconciled; concurrent acquires keep rejecting with the contract's
    // retryAfterMs 0 until the probe records or genuinely goes stale. The
    // ?? fallback covers only a probe armed before this field existed
    // (impossible in-process) — belt for the belt.
    if (
      this.state === "half-open" &&
      this.probe !== null &&
      this.probeStartedAt !== null &&
      now - this.probeStartedAt >
        (this.probeStaleAfterMs ?? PROBE_STALE_DEFAULT_DEADLINE_MS + PROBE_STALE_GRACE_MS)
    ) {
```

- [ ] **Step 4 (reconciliation clears the bound):** Replace (inside the block edited in Step 3, after the `log.warn`):

```ts
      this.probe = null;
      this.probeStartedAt = null;
      this.reopen(now, false);
    }
```

with:

```ts
      this.probe = null;
      this.probeStartedAt = null;
      this.probeStaleAfterMs = null;
      this.reopen(now, false);
    }
```

- [ ] **Step 5 (probe-arm stores the bound):** Replace:

```ts
      if (this.probe === null) {
        const permit = this.issuePermit(true, now);
        this.probe = permit;
        this.probeStartedAt = now;
```

with:

```ts
      if (this.probe === null) {
        const permit = this.issuePermit(true, now);
        this.probe = permit;
        this.probeStartedAt = now;
        // KPR-400 (F1): the probe's staleness bound follows its own turn's
        // deadline; meta-less acquires keep the pre-KPR-400 360s bound.
        this.probeStaleAfterMs =
          (meta?.deadlineMs ?? PROBE_STALE_DEFAULT_DEADLINE_MS) + PROBE_STALE_GRACE_MS;
```

- [ ] **Step 6 (record() probe branch clears the bound):** Replace:

```ts
    if (this.probe === p) {
      this.probe = null;
      this.probeStartedAt = null;
      this.settleProbe(classification, now, llmMs);
      return;
    }
```

with:

```ts
    if (this.probe === p) {
      this.probe = null;
      this.probeStartedAt = null;
      this.probeStaleAfterMs = null;
      this.settleProbe(classification, now, llmMs);
      return;
    }
```

- [ ] **Step 7 (D9 item 1 — record() turn-deadline arm names both sources):** Replace:

```ts
        } else if (classification.kind === "turn-deadline") {
          // Lane B wall-clock deadline expiry: inconclusive, like "aborted".
          // Never trips (a slow-but-healthy tool can consume the whole wall
          // clock) but ALSO never resets the streak — unlike every other
          // non-hard fault it is NOT proof the provider responded: a
          // genuinely hung provider yields exactly this result every turn
          // (the hive deadline preempts undici's own timeouts), and a reset
          // here would blind hang-type outage detection permanently.
          return;
```

with:

```ts
        } else if (classification.kind === "turn-deadline") {
          // Deadline expiry: inconclusive, like "aborted". TWO sources map
          // here (D9 truth-up, KPR-400): the Lane B wall-clock sentinel
          // (error_turn_deadline — progress-blind) AND the Claude-lane /
          // Lane A passthrough deadline abort WITH observed progress
          // (timedOut && aborted && progress — KPR-398). Never trips (a
          // slow-but-healthy tool can consume the whole wall clock) but
          // ALSO never resets the streak: the Lane B sentinel is NOT proof
          // the provider responded (a genuinely hung provider yields
          // exactly this result every turn — the hive deadline preempts
          // undici's own timeouts), and a reset here would blind hang-type
          // outage detection permanently.
          return;
```

- [ ] **Step 8 (D9 item 2 — settleProbe truth-up):** Replace:

```ts
        // A deadline-expired probe proves nothing (the provider may still be
        // hung) — inconclusive like "aborted" below, NOT a recovery close.
        classification.kind !== "turn-deadline")
```

with:

```ts
        // A deadline-expired probe stays inconclusive — NOT a recovery
        // close — even though a WITH-PROGRESS deadline abort (Claude lane,
        // KPR-398) DOES prove the provider responded this turn. Binding
        // ruling (kpr-398-spec §Design.4 / epic D6; D9 truth-up, KPR-400):
        // closing on that shape would close the circuit on exactly the
        // turn-shape that caused the incident, and a provider degraded to
        // trickle-slow (first bytes, then stall) would close every probe.
        // The Lane B sentinel (progress-blind) proves nothing either way.
        // Inconclusive like "aborted" below.
        classification.kind !== "turn-deadline")
```

- [ ] **Step 9 (registry acquire mirrors the meta):** Replace:

```ts
  /** Throws ProviderCircuitOpenError if open (and no probe permit available). */
  acquire(provider: AgentProviderId, meta?: { agentId?: string; threadId?: string }): TurnPermit {
    return this.breakerFor(provider).acquire(meta);
  }
```

with:

```ts
  /** Throws ProviderCircuitOpenError if open (and no probe permit available).
   *  meta.deadlineMs (KPR-400 F1): the turn's effective wall-clock upper
   *  bound — becomes the armed probe's staleness bound (+60s grace). */
  acquire(
    provider: AgentProviderId,
    meta?: { agentId?: string; threadId?: string; deadlineMs?: number },
  ): TurnPermit {
    return this.breakerFor(provider).acquire(meta);
  }
```

- [ ] **Step 10:** Verify — format, typecheck, existing suite untouched-green (incl. the D13 pins and the L288 stale row, which now exercises the 360s fallback path):

```bash
npx prettier --write src/agents/provider-circuit-breaker.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts
```

Expected: typecheck clean; all existing breaker tests pass with **zero test-file edits** (T4 first checkpoint — the meta-less fallback preserves every pinned behavior byte-for-byte).

- [ ] **Step 11:** Commit:

```bash
git add src/agents/provider-circuit-breaker.ts
git commit -m "fix(circuit-breaker): probe staleness follows the probe turn's own deadline + grace (KPR-400 F1)

The flat PROBE_STALE_MS = 360s bound mid-flight stale-reconciled any
half-open probe legitimately running past 360s — deterministic for 900s
per-agent-timeoutMs architects and already live for 600s opus-tier agents —
discarding a genuine probe success as telemetry-only and wedging recovery
behind another cooldown cycle. acquire() meta gains deadlineMs; the armed
probe stores (deadlineMs ?? 300s) + 60s grace as its own bound and the
reconciliation comparison uses it. Meta-less acquires keep the exact 360s
behavior (existing stale-probe rows pass unmodified). No record()
closed-state, settleProbe, pushSample, or snapshot changes — D13's three
p95 pins untouched. Also carries the two D9 comment truth-ups: the
turn-deadline record arm names both sources (Lane B sentinel + KPR-398
with-progress Claude-lane abort) and settleProbe states the binding
keep-inconclusive ruling (kpr-398-spec §Design.4 / epic D6).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 2: Breaker F1 tests — T1/T2/T3 + negative-verify + D13 checkpoint

**Files:**
- Modify: `src/agents/provider-circuit-breaker.test.ts` (one new describe appended at end of file, after the closing `});` of the `KPR-401 pins — aborted/deadline turns never pollute the p95 window` describe). **No edits to any pre-existing row (T4).**

- [ ] **Step 1:** Append at end of file, verbatim (module-scope helpers `makeRegistry`/`hardFault`/`success`/`expectOpenThrow` are in scope):

```ts

describe("KPR-400 F1 — probe staleness follows the probe's own deadline", () => {
  function tripped() {
    const h = makeRegistry();
    h.turn(hardFault());
    h.turn(hardFault());
    h.turn(hardFault());
    return h;
  }

  it("T1: a 900s-deadline probe is NOT stale-killed at +400s and its +420s success closes the circuit", () => {
    // NEGATIVE-VERIFY prediction (Step 3): on pre-fix code the +400s acquire
    // stale-reconciles the probe (flat 360s bound) — retryAfterMs comes back
    // 15_000 (fresh cooldown window) instead of the contract's 0, and the
    // probe's eventual success is telemetry-only, leaving the circuit open.
    const { registry, advance } = tripped();
    advance(15_000);
    const probe = registry.acquire("claude", { deadlineMs: 900_000 });
    expect(probe.isProbe).toBe(true);

    advance(400_000); // probe legitimately mid-flight (< 900s + 60s grace)
    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.retryAfterMs).toBe(0); // contract reject — probe kept, NOT reconciled
    expect(registry.stateFor("claude")!.probeInFlight).toBe(true);

    advance(20_000); // probe records success at +420s total
    registry.record(probe, success(), 420_000);
    expect(registry.stateFor("claude")!.state).toBe("closed");
  });

  it("T2: acquire meta WITHOUT deadlineMs keeps the exact 360s fallback bound", () => {
    // Pin, passes both pre- and post-fix by design: (undefined ?? 300s) +
    // 60s = the old PROBE_STALE_MS. The meta-LESS variant is pinned by the
    // pre-existing row "stale probe permit is reconciled as inconclusive on
    // next acquire" (advance(360_001)), which this plan leaves byte-
    // unmodified — together they are the fallback contract.
    const { registry, advance } = tripped();
    advance(15_000);
    const probe = registry.acquire("claude", { agentId: "agent-x" }); // no deadlineMs
    expect(probe.isProbe).toBe(true);
    advance(360_001);
    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.retryAfterMs).toBe(15_000); // reconciled → reopened (no escalation) → fresh cooldown
    expect(registry.stateFor("claude")!.probeInFlight).toBe(false);
  });

  it("T3: the per-probe bound still fires past deadlineMs + grace — lost-permit belt preserved", () => {
    // Pin, passes both ways (pre-fix the flat 360s bound fires even earlier).
    const { registry, advance } = tripped();
    advance(15_000);
    const probe = registry.acquire("claude", { deadlineMs: 900_000 });
    expect(probe.isProbe).toBe(true);
    advance(960_001); // > 900_000 + 60_000 grace
    const err = expectOpenThrow(() => registry.acquire("claude"));
    expect(err.retryAfterMs).toBe(15_000); // reconciled inconclusive: exponent unchanged, base cooldown
    expect(registry.stateFor("claude")!.probeInFlight).toBe(false);
    // The lost probe's late record is telemetry-only — never closes.
    registry.record(probe, success(), 100);
    expect(registry.stateFor("claude")!.state).toBe("open");
  });
});
```

- [ ] **Step 2:** Verify green on fixed code, and confirm the test diff is append-only (T4 — no pre-existing row touched):

```bash
npx prettier --write src/agents/provider-circuit-breaker.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts
git diff -- src/agents/provider-circuit-breaker.test.ts
```

Expected: all tests pass including the three new rows; the `git diff` shows exactly one appended describe (plus possible prettier reflow inside it) — **no hunk touches the `KPR-401 pins` describe or any other pre-existing row**.

- [ ] **Step 3:** Negative-verify (NO `git stash`). Task 1's commit is `HEAD`; reverse-apply its breaker diff:

```bash
git diff HEAD~1 HEAD -- src/agents/provider-circuit-breaker.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts
```

Expected: **exactly the T1 row fails** on pre-fix code (retryAfterMs 15_000 ≠ 0 at +400s; final state "open" ≠ "closed"). T2 and T3 pass both ways **by design** (documented pins — the fallback and the belt). Every pre-existing row passes. (Note: the reverse-applied file has the old `acquire(meta?)` signature; the tests' `{ deadlineMs }` argument is an ignored excess property at runtime — vitest does not typecheck.) If T1 does not fail, stop — the test is not pinning the fix; fix the test.

Restore and confirm:

```bash
git checkout HEAD -- src/agents/provider-circuit-breaker.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts
```

Expected `git status --short`: exactly ` M src/agents/provider-circuit-breaker.test.ts`. Suite green post-restore.

- [ ] **Step 4:** Commit:

```bash
git add src/agents/provider-circuit-breaker.test.ts
git commit -m "test(circuit-breaker): KPR-400 F1 pins — deadline-following stale bound, 360s fallback, past-grace belt

Negative-verified: with Task 1's breaker diff reverse-applied, T1 fails on
pre-fix code (the +400s concurrent acquire stale-kills the 900s probe and
its success lands telemetry-only); T2/T3 pass both ways by design (fallback
and lost-permit-belt pins), and every pre-existing row — including the
three KPR-401 D13 p95 pins and the meta-less 360s stale row — passes both
ways with zero edits.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 3: Manager F1 — acquire-time deadlineMs upper bound at the sole production acquire site

**Files:**
- Modify: `src/agents/agent-manager.ts` (three text-anchored edits: type import L2; new private helper inserted after `providerFor` ~L886; acquire site L915–919). **Disjoint from KPR-399 PR #414's regions (retry chain ~L1020–1131, `finalizeSpawnResult`).**

- [ ] **Step 1 (type import):** Replace:

```ts
import type { AgentState, AgentStatus } from "../types/agent-config.js";
```

with:

```ts
import type { AgentConfig, AgentState, AgentStatus } from "../types/agent-config.js";
```

- [ ] **Step 2 (helper — spec §Design.2, verbatim formula):** Insert immediately after the closing `}` of `providerFor` (anchor below), i.e. replace:

```ts
  providerFor(agentId: string): AgentProviderId | null {
    const agentConfig = this.registry.get(agentId);
    if (!agentConfig) return null;
    return resolveProviderModel(agentConfig.model).provider;
  }
```

with:

```ts
  providerFor(agentId: string): AgentProviderId | null {
    const agentConfig = this.registry.get(agentId);
    if (!agentConfig) return null;
    return resolveProviderModel(agentConfig.model).provider;
  }

  /**
   * KPR-400 (F1): acquire-time UPPER BOUND on the turn's effective wall
   * clock, threaded into the breaker as probe-staleness meta. The runner's
   * effective deadline is `resourceLimits?.timeoutMs ?? agentConfig.timeoutMs
   * ?? 300_000` (agent-runner.ts), and resourceLimits presence depends on
   * the router gate — unknowable exactly before prepareSpawn runs. So:
   * max(agent timeoutMs, claude static-tier limit). Over-estimating only
   * delays reconciliation of a structurally-prevented lost-permit case;
   * under-estimating is the live bug (a legitimate long probe stale-killed
   * mid-flight — kpr-400-spec R2, ⚠A3). Non-claude routes never get Claude
   * tier limits: Lane B pins `agentConfig.timeoutMs ?? 300_000` exactly at
   * prepareSpawn, Lane A uses the runner's identical fallback.
   */
  private acquireDeadlineMs(provider: AgentProviderId, agentConfig: AgentConfig | undefined): number {
    const configuredMs = agentConfig?.timeoutMs ?? 300_000;
    if (!agentConfig || provider !== "claude") return configuredMs;
    const tierLimitMs = resolveResourceLimits(modelToTier(agentConfig.model), agentConfig.resourceTiers).timeoutMs;
    return Math.max(configuredMs, tierLimitMs);
  }
```

- [ ] **Step 3 (acquire site — spec Key Points: `agent-manager.ts:916`, the single production acquire site):** Replace:

```ts
      const route = resolveProviderModel(this.registry.get(ctx.agentId)?.model ?? "");
      const permit = this.circuitBreakers.acquire(route.provider, {
        agentId: ctx.agentId,
        threadId: ctx.threadId,
      });
```

with:

```ts
      const acquireAgentConfig = this.registry.get(ctx.agentId);
      const route = resolveProviderModel(acquireAgentConfig?.model ?? "");
      const permit = this.circuitBreakers.acquire(route.provider, {
        agentId: ctx.agentId,
        threadId: ctx.threadId,
        // KPR-400 (F1): the probe turn's own deadline (upper bound) drives
        // the breaker's probe-staleness bound — see acquireDeadlineMs.
        deadlineMs: this.acquireDeadlineMs(route.provider, acquireAgentConfig),
      });
```

- [ ] **Step 4:** Verify — format, typecheck, manager suite untouched-green:

```bash
npx prettier --write src/agents/agent-manager.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected: typecheck clean; 0 failures (no existing row asserts on acquire meta; `modelToTier`/`resolveResourceLimits` are REAL in the test file — its `vi.mock("./model-router.js")` spreads `importOriginal` and stubs `routeModel` only, verified at plan time).

- [ ] **Step 5:** Commit:

```bash
git add src/agents/agent-manager.ts
git commit -m "feat(agent-manager): thread acquire-time deadlineMs upper bound into breaker acquire meta (KPR-400 F1)

spawnTurn's breaker acquire (the sole production acquire site) now passes
deadlineMs = max(agentConfig.timeoutMs ?? 300_000, claude static-tier
limit via modelToTier/resolveResourceLimits) — an upper bound on the
runner's effective wall clock, safe to over-estimate (⚠A3): the armed
probe's staleness bound follows it, so a 900s architect or 600s opus-tier
probe is no longer stale-killed mid-flight. Non-claude routes pass
agentConfig.timeoutMs ?? 300_000 (Lane B prepareSpawn pin / Lane A runner
fallback — no Claude tier math). Regions disjoint from KPR-399 PR #414
(retry chain, finalizeSpawnResult).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 4: Manager F1 tests — T7 + negative-verify

**Files:**
- Modify: `src/agents/agent-manager.test.ts` (two rows appended inside the nested `describe("provider circuit breaker at the wrap point (KPR-306)")`, immediately AFTER the closing `});` of the `it("probe recovery end-to-end: post-cooldown turn is admitted and closes the breaker", …)` block)

- [ ] **Step 1:** Insert at the location above, verbatim (`registry`, `makeAgentConfig`, `smsCtx`, `mockRunnerSend`, `makeRunResult`, and the imported `RESOURCE_TIER_DEFAULTS` are all in scope; `manager.circuitBreakers` is the real registry — spy, don't mock):

```ts
      it("KPR-400 F1: acquire meta deadlineMs ≥ the agent's own timeoutMs (900s architect shape)", async () => {
        // NEGATIVE-VERIFY prediction (Task 4 Step 3): pre-fix the acquire
        // meta carries agentId/threadId only — objectContaining fails.
        registry._agents.set(
          "agent-arch",
          makeAgentConfig({ id: "agent-arch", name: "Architect", model: "claude-sonnet-4-6", timeoutMs: 900_000 }),
        );
        const acquireSpy = vi.spyOn(manager.circuitBreakers, "acquire");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult());
        await manager.spawnTurn(smsCtx({ agentId: "agent-arch", threadId: "sms:line-1:kpr400-arch" }));
        // sonnet tier limit (300s) < explicit timeoutMs → max picks 900s.
        expect(acquireSpy).toHaveBeenCalledWith(
          "claude",
          expect.objectContaining({ agentId: "agent-arch", deadlineMs: 900_000 }),
        );
      });

      it("KPR-400 F1: acquire meta deadlineMs ≥ the opus tier limit when the agent has no explicit timeoutMs", async () => {
        registry._agents.set(
          "agent-opus",
          makeAgentConfig({ id: "agent-opus", name: "OpusAgent", model: "claude-opus-4-5" }),
        );
        const acquireSpy = vi.spyOn(manager.circuitBreakers, "acquire");
        mockRunnerSend.mockResolvedValueOnce(makeRunResult());
        await manager.spawnTurn(smsCtx({ agentId: "agent-opus", threadId: "sms:line-1:kpr400-opus" }));
        // No explicit timeoutMs (default 300s) < opus tier limit → max picks 600s.
        expect(acquireSpy).toHaveBeenCalledWith(
          "claude",
          expect.objectContaining({ deadlineMs: RESOURCE_TIER_DEFAULTS.opus.timeoutMs }),
        );
      });
```

- [ ] **Step 2:** Verify green on fixed code:

```bash
npx prettier --write src/agents/agent-manager.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected: all tests pass, including the two new KPR-400 rows.

- [ ] **Step 3:** Negative-verify (NO `git stash`). Task 3's commit is `HEAD`; reverse-apply its manager diff:

```bash
git diff HEAD~1 HEAD -- src/agents/agent-manager.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
```

Expected: **exactly the two new KPR-400 rows fail** (acquire meta lacks `deadlineMs` on pre-fix code); every pre-existing row passes. If they do not fail, stop and fix the tests.

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
git commit -m "test(agent-manager): KPR-400 F1 pins — acquire meta deadlineMs upper bound (agent timeoutMs / opus tier)

Negative-verified: with Task 3's agent-manager.ts diff reverse-applied,
both rows fail (acquire meta carries agentId/threadId only on pre-fix
code); every pre-existing row passes both ways.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 5: F2 source — enqueue-origin schema, class-ordered claimNext, dispatcher threading

**Files:**
- Modify: `src/outage/outage-queue-store.ts` (origin type + doc field + input field + `$setOnInsert` + `claimNext` sort/comment + index)
- Modify: `src/channels/dispatcher.ts` (import; `handleOutageTurn` signature + doc comment; both callers; enqueue pass-through)
- Modify: `src/outage/outage-replay-processor.ts` (drain doc comment only — no code)
- Modify: `src/outage/outage-queue-store.test.ts` (**one line**: `makeInput` default — typecheck compat for the now-required input field; the T5 rows are Task 6)

This is deliberately one commit: `OutageEnqueueInput.enqueueOrigin` is **required**, so store-only or dispatcher-only commits would leave `npm run typecheck` red between them (per-commit-green).

- [ ] **Step 1 (store — origin type):** In `src/outage/outage-queue-store.ts`, replace:

```ts
export type OutagePolicy = "notify" | "silent";
export type OutageQueueStatus = "pending" | "replaying" | "done" | "expired" | "failed";
```

with:

```ts
export type OutagePolicy = "notify" | "silent";
export type OutageQueueStatus = "pending" | "replaying" | "done" | "expired" | "failed";

/**
 * KPR-400 (F2): why the doc was enqueued — drives claimNext's class
 * ordering. "fast-fail" = the turn never ran (ProviderCircuitOpenError,
 * rejected pre-router — zero evidence of being expensive, typically live
 * interactive traffic). "post-turn-fault" = the turn RAN and classified
 * into HARD_FAULT_KINDS with the breaker open (trip-crossing turns, incl.
 * zero-progress deadline burns). The string values are load-bearing:
 * "fast-fail" < "post-turn-fault" lexicographically, so a plain ascending
 * sort yields the class preference (pinned in outage-queue-store.test.ts,
 * spec ⚠A2 — a numeric weight field is an acceptable substitution).
 */
export type OutageEnqueueOrigin = "fast-fail" | "post-turn-fault";
```

- [ ] **Step 2 (store — doc field):** Replace (inside `OutageQueueDoc`):

```ts
  policy: OutagePolicy;
  status: OutageQueueStatus;
```

with:

```ts
  policy: OutagePolicy;
  /** KPR-400 (F2): immutable after first enqueue ($setOnInsert; back-to-
   *  pending releases never touch it — a replay that fast-fails again keeps
   *  its original class, spec §Edge-7). Optional: absent on pre-KPR-400
   *  docs — BSON type ordering sorts missing before string, so legacy docs
   *  claim with top (fast-fail-class) priority for the one
   *  deploy-mid-outage window (spec ⚠A5, accepted). */
  enqueueOrigin?: OutageEnqueueOrigin;
  status: OutageQueueStatus;
```

- [ ] **Step 3 (store — input field):** Replace:

```ts
export interface OutageEnqueueInput {
  itemId: string;
  agentId: string;
  provider: string;
  workItem: WorkItem;
  policy: OutagePolicy;
}
```

with:

```ts
export interface OutageEnqueueInput {
  itemId: string;
  agentId: string;
  provider: string;
  workItem: WorkItem;
  policy: OutagePolicy;
  /** KPR-400 (F2): required from callers — see OutageEnqueueOrigin. */
  enqueueOrigin: OutageEnqueueOrigin;
}
```

- [ ] **Step 4 (store — `$setOnInsert` write):** Replace (inside `enqueue`):

```ts
        $setOnInsert: {
          provider: input.provider,
          workItem: input.workItem,
          policy: input.policy,
          status: "pending",
```

with:

```ts
        $setOnInsert: {
          provider: input.provider,
          workItem: input.workItem,
          policy: input.policy,
          // KPR-400 (F2): $setOnInsert = immutable after first enqueue.
          enqueueOrigin: input.enqueueOrigin,
          status: "pending",
```

- [ ] **Step 5 (store — class-ordered claimNext):** Replace:

```ts
  /** Atomic pending→replaying claim, oldest enqueuedAt first — copies the
   *  callback poller's mark-before-dispatch pattern (scheduler.ts). */
  async claimNext(): Promise<OutageQueueDoc | null> {
    return this.collection.findOneAndUpdate(
      { status: "pending" },
      { $set: { status: "replaying", lastAttemptAt: this.now() } },
      { sort: { enqueuedAt: 1 }, returnDocument: "after" },
    );
  }
```

with:

```ts
  /** Atomic pending→replaying claim — copies the callback poller's
   *  mark-before-dispatch pattern (scheduler.ts). KPR-400 (F2):
   *  class-ordered — fast-fail-class docs (turns that never ran) before
   *  post-turn-fault-class docs (turns that demonstrably ran into a hard
   *  fault, incl. full-deadline burns), oldest enqueuedAt first WITHIN each
   *  class — so after cooldown the drain's next claim (with high
   *  probability the half-open probe) is the cheapest available real turn.
   *  Ascending sort on the origin string IS the class preference
   *  ("fast-fail" < "post-turn-fault"); missing/legacy docs sort first
   *  under BSON type order (null/missing < string — documented Mongo
   *  behavior, mirrored in the test fake; spec ⚠A5). */
  async claimNext(): Promise<OutageQueueDoc | null> {
    return this.collection.findOneAndUpdate(
      { status: "pending" },
      { $set: { status: "replaying", lastAttemptAt: this.now() } },
      { sort: { enqueueOrigin: 1, enqueuedAt: 1 }, returnDocument: "after" },
    );
  }
```

- [ ] **Step 6 (store — index):** Replace (inside `ensureIndexes`):

```ts
    await this.collection.createIndex({ status: 1, enqueuedAt: 1 });
```

with:

```ts
    await this.collection.createIndex({ status: 1, enqueuedAt: 1 });
    // KPR-400 (F2): claimNext's class-ordered sort. The plain
    // { status, enqueuedAt } index above stays — expireOlderThan and
    // recoverStaleReplaying still read by it (harmless, other readers).
    await this.collection.createIndex({ status: 1, enqueueOrigin: 1, enqueuedAt: 1 });
```

- [ ] **Step 7 (dispatcher — import):** In `src/channels/dispatcher.ts`, replace:

```ts
import type { OutageQueueStore, OutageQueueConfig } from "../outage/outage-queue-store.js";
```

with:

```ts
import type { OutageQueueStore, OutageQueueConfig, OutageEnqueueOrigin } from "../outage/outage-queue-store.js";
```

- [ ] **Step 8 (dispatcher — fast-fail caller):** In `handleTurnFailure`, replace:

```ts
      if (err instanceof ProviderCircuitOpenError) {
        const handled = await this.handleOutageTurn(item, agentId, adapter, err.provider);
        if (handled) return;
```

with:

```ts
      if (err instanceof ProviderCircuitOpenError) {
        // KPR-400 (F2): the turn never ran — fast-fail class (replays first).
        const handled = await this.handleOutageTurn(item, agentId, adapter, err.provider, "fast-fail");
        if (handled) return;
```

- [ ] **Step 9 (dispatcher — post-turn caller):** In `maybeHandlePostTurnOutage`, replace:

```ts
    return this.handleOutageTurn(item, agentId, adapter, provider);
  }
```

with:

```ts
    // KPR-400 (F2): the turn RAN and hard-faulted with the breaker open —
    // post-turn-fault class (deadline burners live here; replays last).
    return this.handleOutageTurn(item, agentId, adapter, provider, "post-turn-fault");
  }
```

- [ ] **Step 10 (dispatcher — signature + enqueue):** Replace:

```ts
  private async handleOutageTurn(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    provider: string,
  ): Promise<boolean> {
```

with:

```ts
  private async handleOutageTurn(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    provider: string,
    /** KPR-400 (F2): enqueue class — threaded from the exactly two callers;
     *  $setOnInsert-immutable, so a replayed doc's re-visit here (the
     *  release-before-depth branch) never rewrites it. */
    origin: OutageEnqueueOrigin,
  ): Promise<boolean> {
```

and replace:

```ts
      await outage.store.enqueue({ itemId: item.id, agentId, provider, workItem: item, policy });
```

with:

```ts
      await outage.store.enqueue({ itemId: item.id, agentId, provider, workItem: item, policy, enqueueOrigin: origin });
```

- [ ] **Step 11 (replay processor — comment truth-up, no code):** In `src/outage/outage-replay-processor.ts`, replace:

```ts
  /**
   * Serial oldest-first drain (§5-2b). Outcomes are DISPATCHER-authored
```

with:

```ts
  /**
   * Serial class-ordered drain (§5-2b; KPR-400 F2: claimNext encapsulates
   * the ordering — fast-fail-class docs before post-turn-fault-class docs,
   * oldest-first within class, so the post-cooldown probe slot goes to the
   * cheapest available real turn). Outcomes are DISPATCHER-authored
```

- [ ] **Step 12 (store test — typecheck compat only):** In `src/outage/outage-queue-store.test.ts`, replace (inside `makeInput`):

```ts
    workItem: makeWorkItem(),
    policy: "notify",
    ...overrides,
```

with:

```ts
    workItem: makeWorkItem(),
    policy: "notify",
    enqueueOrigin: "fast-fail", // KPR-400 (F2): required input field; harness default
    ...overrides,
```

- [ ] **Step 13:** Verify — format, typecheck, all touched suites green:

```bash
npx prettier --write src/outage/outage-queue-store.ts src/channels/dispatcher.ts src/outage/outage-replay-processor.ts src/outage/outage-queue-store.test.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts src/outage/outage-replay-processor.test.ts src/channels/dispatcher.test.ts
```

Expected: typecheck clean; 0 failures. (Existing store rows: all docs now share the default `"fast-fail"` class, so the two-key sort degenerates to oldest-first — but the fake's sort still reads only its FIRST key until Task 6 extends it, which also yields `enqueueOrigin`-equal → insertion order… to avoid any ambiguity: the fake compares the single first sort key `enqueueOrigin`, all equal, so candidates keep array order, which in every existing row equals enqueue order = oldest-first. All existing rows pass; verified logic at plan time. Dispatcher rows: the store is a `vi.fn()` mock and existing `objectContaining` assertions tolerate the extra field. Replay-processor rows: `claimNext` is mocked.)

- [ ] **Step 14:** Commit:

```bash
git add src/outage/outage-queue-store.ts src/channels/dispatcher.ts src/outage/outage-replay-processor.ts src/outage/outage-queue-store.test.ts
git commit -m "feat(outage): enqueue-origin replay class ordering — fast-fail before post-turn-fault (KPR-400 F2)

The 15s replay drain claimed oldest-first, which after a trip put the most
expensive turn (the deadline burner whose spend accompanied the trip) at
the head — and the head claim is, with high probability, the half-open
probe. The queue now records why each doc was enqueued (enqueueOrigin,
\$setOnInsert-immutable: fast-fail = ProviderCircuitOpenError, the turn
never ran; post-turn-fault = ran and classified into HARD_FAULT_KINDS with
the breaker open) and claimNext sorts { enqueueOrigin: 1, enqueuedAt: 1 } —
the lexicographic string order IS the class preference (pinned), legacy
docs (field absent) sort first under BSON type order (accepted, one
deploy-mid-outage window). New { status, enqueueOrigin, enqueuedAt } index;
the old { status, enqueuedAt } index stays for the other readers.
handleOutageTurn threads the origin from its exactly two callers; the
replay processor is code-unchanged (comment truth-up only — claimNext
encapsulates the ordering). One commit across store+dispatcher: the input
field is required, so split commits would leave typecheck red.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 6: Store F2 tests — fake multi-key sort + T5 rows + negative-verify

**Files:**
- Modify: `src/outage/outage-queue-store.test.ts` (harness: `FakeOutageCollection.findOneAndUpdate` multi-key sort; one new describe appended at end of file)

- [ ] **Step 1 (harness — multi-key sort with BSON missing-before-string):** Replace:

```ts
  async findOneAndUpdate(filter: any, update: any, options?: { sort?: Record<string, 1 | -1> }) {
    let candidates = this.docs.filter((d) => matches(d, filter));
    if (options?.sort) {
      const [[key, dir]] = Object.entries(options.sort);
      candidates = [...candidates].sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : 0));
    }
    const doc = candidates[0];
    if (!doc) return null;
    applyUpdate(doc, update);
    return { ...doc };
  }
```

with:

```ts
  async findOneAndUpdate(filter: any, update: any, options?: { sort?: Record<string, 1 | -1> }) {
    let candidates = this.docs.filter((d) => matches(d, filter));
    if (options?.sort) {
      // KPR-400 (F2): multi-key sort, mirroring the ONE BSON type-ordering
      // fact claimNext relies on — a missing/null field sorts BEFORE any
      // string (documented Mongo behavior: null/missing < string), so
      // legacy docs without enqueueOrigin claim with top priority (⚠A5).
      const entries = Object.entries(options.sort);
      candidates = [...candidates].sort((a, b) => {
        for (const [key, dir] of entries) {
          const aMissing = a[key] === undefined || a[key] === null;
          const bMissing = b[key] === undefined || b[key] === null;
          if (aMissing !== bMissing) return (aMissing ? -1 : 1) * dir;
          if (aMissing && bMissing) continue;
          if (a[key] < b[key]) return -dir;
          if (a[key] > b[key]) return dir;
        }
        return 0;
      });
    }
    const doc = candidates[0];
    if (!doc) return null;
    applyUpdate(doc, update);
    return { ...doc };
  }
```

- [ ] **Step 2 (T5 rows):** Append at end of file (after the closing `});` of `describe("OutageQueueStore (KPR-307)")`), verbatim:

```ts

describe("OutageQueueStore — enqueue-origin replay ordering (KPR-400 F2)", () => {
  it("claimNext prefers fast-fail-class docs, oldest-first within class", async () => {
    // NEGATIVE-VERIFY prediction (Step 4): pre-fix claimNext sorts on
    // enqueuedAt alone (and enqueue writes no origin) — the burner (oldest)
    // claims first and this row fails.
    const { store, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "burner", enqueueOrigin: "post-turn-fault" })); // T0 — trip-crosser
    advance(60_000);
    await store.enqueue(makeInput({ itemId: "ff-old", enqueueOrigin: "fast-fail" })); // T1
    advance(60_000);
    await store.enqueue(makeInput({ itemId: "ff-new", enqueueOrigin: "fast-fail" })); // T2
    expect((await store.claimNext())?.itemId).toBe("ff-old"); // class first, then age
    expect((await store.claimNext())?.itemId).toBe("ff-new");
    expect((await store.claimNext())?.itemId).toBe("burner"); // deadline burner replays last
    expect(await store.claimNext()).toBeNull();
  });

  it("legacy doc (field absent) claims first — BSON missing < string (deploy-mid-outage window, ⚠A5)", async () => {
    const { store, fake, advance } = makeStore();
    await store.enqueue(makeInput({ itemId: "ff", enqueueOrigin: "fast-fail" })); // T0
    advance(60_000);
    await store.enqueue(makeInput({ itemId: "legacy" })); // T1 — then strip the field to simulate pre-KPR-400
    delete fake.docs.find((d) => d.itemId === "legacy")!.enqueueOrigin;
    expect((await store.claimNext())?.itemId).toBe("legacy"); // missing sorts before "fast-fail" despite being newer
    expect((await store.claimNext())?.itemId).toBe("ff");
  });

  it("constant-ordering pin: 'fast-fail' < 'post-turn-fault' as strings (load-bearing sort, ⚠A2)", () => {
    // The ascending index/sort on the origin string IS the class
    // preference. Renaming either literal breaks replay ordering silently —
    // this row makes it loud. (A numeric weight field is the sanctioned
    // substitution if a reviewer prefers it.)
    expect("fast-fail" < "post-turn-fault").toBe(true);
  });

  it("origin is $setOnInsert-immutable: double-enqueue and back-to-pending release never touch it", async () => {
    const { store, fake } = makeStore();
    await store.enqueue(makeInput({ enqueueOrigin: "fast-fail" }));
    await store.enqueue(makeInput({ enqueueOrigin: "post-turn-fault" })); // same (itemId, agentId) — no-op
    expect(fake.docs).toHaveLength(1);
    expect(fake.docs[0].enqueueOrigin).toBe("fast-fail");
    await store.claimNext();
    await store.release("msg-1", "agent-a", "pending", "circuit still open"); // fast-failed replay path
    expect(fake.docs[0].enqueueOrigin).toBe("fast-fail"); // spec §Edge-7: class survives release
  });
});
```

- [ ] **Step 3:** Verify green on fixed code:

```bash
npx prettier --write src/outage/outage-queue-store.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts
```

Expected: all tests pass — the four new rows and every pre-existing row (same-class docs degenerate to oldest-first).

- [ ] **Step 4:** Negative-verify (NO `git stash`). Task 5's commit is `HEAD`; reverse-apply **only its store source diff** (the dispatcher/processor/test-compat parts stay):

```bash
git diff HEAD~1 HEAD -- src/outage/outage-queue-store.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts
```

Expected: **three of the four new rows fail** on pre-fix store code — the ordering row (reverted `enqueue` writes no origin and `claimNext` sorts `enqueuedAt` alone → "burner" claims first), the legacy row ("ff" also lacks the field → oldest-first → "ff" claims first), and the immutability row (`fake.docs[0].enqueueOrigin` is `undefined`). The constant-ordering pin passes both ways **by design** (it pins the literals, not the store). Every pre-existing row passes. If the three rows do not fail, stop and fix the tests.

Restore and confirm:

```bash
git checkout HEAD -- src/outage/outage-queue-store.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/outage/outage-queue-store.test.ts
```

Expected `git status --short`: exactly ` M src/outage/outage-queue-store.test.ts`. Suite green post-restore.

- [ ] **Step 5:** Commit:

```bash
git add src/outage/outage-queue-store.test.ts
git commit -m "test(outage-queue-store): KPR-400 F2 pins — class-ordered claimNext, legacy-doc priority, string-ordering pin, origin immutability

The driver fake's findOneAndUpdate sort gains multi-key support mirroring
the one BSON fact claimNext relies on (missing/null < string). Negative-
verified: with Task 5's outage-queue-store.ts diff reverse-applied, the
ordering, legacy, and immutability rows fail on pre-fix code; the
constant-ordering pin passes both ways by design, and every pre-existing
row passes both ways.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 7: Dispatcher F2 tests — T6 origin threading + negative-verify + T8 checkpoint

**Files:**
- Modify: `src/channels/dispatcher.test.ts` (three rows inserted inside `describe("outage interception (KPR-307)")`, immediately AFTER the closing `});` of the `it("★ KPR-398: with-progress deadline turn with breaker open → legacy path, never queued", …)` block and BEFORE the line `it("sched: turns skip with a log — never queued, never noticed", async () => {`). **No edits to any pre-existing row (T8).**

- [ ] **Step 1:** Insert at the location above, verbatim (`makeCircuitOpenError`, `makeTurn`, `slackItem`, `replayItem`, `agentManager`, `store` are all in scope):

```ts
  it("KPR-400 F2: ProviderCircuitOpenError fast-fail enqueues enqueueOrigin 'fast-fail'", async () => {
    // NEGATIVE-VERIFY prediction (Step 3): pre-fix handleOutageTurn has no
    // origin param and enqueue carries no enqueueOrigin — objectContaining
    // fails.
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "m1", enqueueOrigin: "fast-fail" }),
    );
  });

  it("KPR-400 F2: post-turn zero-progress deadline gate enqueues enqueueOrigin 'post-turn-fault'", async () => {
    // Same fixture shape as the '★ timeout gate: timedOut && aborted with
    // breaker open' row above (cited by name — KPR-398 zero-progress hang
    // signature: empty finalMessage, toolCalls 0, streamed false).
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", errors: [], timedOut: true, aborted: true }),
    );
    agentManager.circuitBreakers.stateFor.mockReturnValue({ state: "open", enabled: true });
    await dispatcher.dispatch(slackItem({ id: "m1", threadId: "t1" }));
    expect(store.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "m1", enqueueOrigin: "post-turn-fault" }),
    );
  });

  it("KPR-400 F2: a replay fast-failing again releases pending and never re-enqueues (origin stays untouched)", async () => {
    // Pin, passes both ways by design: the release-before-depth branch
    // predates KPR-400; origin immutability itself is store-level
    // ($setOnInsert — pinned in outage-queue-store.test.ts). This row pins
    // that the dispatcher's replay path cannot even REACH enqueue.
    agentManager.runWorkItemTurn.mockRejectedValueOnce(makeCircuitOpenError());
    await dispatcher.dispatch(replayItem({ id: "m1" }));
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "pending");
    expect(store.enqueue).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2:** Verify green on fixed code, and confirm append-only (T8 — the two KPR-398 ★ rows and every other pre-existing row byte-unmodified):

```bash
npx prettier --write src/channels/dispatcher.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
git diff -- src/channels/dispatcher.test.ts
```

Expected: all tests pass including the three new rows; the diff is one contiguous insertion — no pre-existing row touched.

- [ ] **Step 3:** Negative-verify (NO `git stash`). At this point `HEAD` is Task 6's commit and **`HEAD~1` is Task 5's F2 source commit** — confirm with `git log --oneline -2`, then reverse-apply Task 5's dispatcher diff:

```bash
git log --oneline -2
git diff HEAD~2 HEAD~1 -- src/channels/dispatcher.ts | git apply -R
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected: **exactly the two origin rows fail** (enqueue is called without `enqueueOrigin` on pre-fix dispatcher code — runtime is unaffected by the store's required input type; vitest does not typecheck); the replay-release row passes both ways **by design** (documented pin); every pre-existing row passes. If the two rows do not fail, stop and fix the tests.

Restore and confirm:

```bash
git checkout HEAD~1 -- src/channels/dispatcher.ts
git status --short
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected `git status --short`: exactly ` M src/channels/dispatcher.test.ts`. Suite green post-restore.

- [ ] **Step 4:** Commit:

```bash
git add src/channels/dispatcher.test.ts
git commit -m "test(dispatcher): KPR-400 F2 pins — enqueueOrigin threading on both outage paths

Negative-verified: with Task 5's dispatcher.ts diff reverse-applied, the
fast-fail and post-turn-fault origin rows fail on pre-fix code (enqueue
carries no enqueueOrigin); the replay-release row passes both ways by
design (pre-existing release-before-depth branch), and every pre-existing
row — including both KPR-398 ★ deadline-gate rows (spec T8) — passes both
ways with zero edits.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 8: D9 item 3 — classifier attenuation comment + T9 pin (one commit; zero behavior change)

**Files:**
- Modify: `src/agents/provider-adapters/error-classification.ts` (comment only, inside `classifyTurnResult`'s rule-1 with-progress arm)
- Modify: `src/agents/provider-adapters/error-classification.test.ts` (one-row describe appended at end of file, after the closing `});` of the `KPR-398 — deadline abort with observed progress` describe)

- [ ] **Step 1 (comment):** In `src/agents/provider-adapters/error-classification.ts`, replace:

```ts
    if (hasObservedProgress(input)) {
      return {
        outcome: "fault",
        kind: "turn-deadline",
        message:
          input.error ??
```

with:

```ts
    if (hasObservedProgress(input)) {
      return {
        outcome: "fault",
        kind: "turn-deadline",
        // Attenuation shape (D9 truth-up, KPR-400 — deliberate, pinned in
        // error-classification.test.ts): a real error string coexisting
        // with deadline+progress becomes the turn-deadline message
        // VERBATIM, suppressing the synthesized evidence string below.
        // Unreachable on the Claude deadline path today (`error` stays
        // undefined — the runner's deadline closes the iterator, nothing
        // throws), but if a future caller supplies both, the error string
        // wins: it carries strictly more debugging signal than the
        // synthesized counters, and the KIND (not the message) is what the
        // breaker keys on.
        message:
          input.error ??
```

- [ ] **Step 2 (T9 pin):** Append at end of `src/agents/provider-adapters/error-classification.test.ts`, verbatim:

```ts

describe("KPR-400 D9 — error-string attenuation on the with-progress deadline arm (pin)", () => {
  it("a real error string coexisting with deadline+progress becomes the message verbatim (error wins over synthesized evidence)", () => {
    // Unreachable on the Claude deadline path today (error stays undefined;
    // iterator closed, not thrown) — this pins the deliberate error-wins
    // choice for any future caller that supplies both. Comment-only source
    // change behind this row: negative-verify is degenerate by construction
    // (no pre-fix state to fail against — KPR-401 Task 7 precedent).
    expect(
      classifyTurnResult({ error: "boom", timedOut: true, aborted: true, toolCalls: 1 }),
    ).toEqual({ outcome: "fault", kind: "turn-deadline", message: "boom" });
  });
});
```

- [ ] **Step 3:** Verify — format, typecheck, suite green, and confirm the source diff is comment-only:

```bash
npx prettier --write src/agents/provider-adapters/error-classification.ts src/agents/provider-adapters/error-classification.test.ts
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-adapters/error-classification.test.ts
git diff -- src/agents/provider-adapters/error-classification.ts
```

Expected: all tests pass including the new pin; the source diff contains **comment lines only** (D6: zero classification behavior change — every changed line starts with `//` or is whitespace).

- [ ] **Step 4:** Commit:

```bash
git add src/agents/provider-adapters/error-classification.ts src/agents/provider-adapters/error-classification.test.ts
git commit -m "docs(error-classification): D9 truth-up — pin the input.error attenuation on the with-progress deadline arm (KPR-400)

Comment-only source change: documents that a real error string coexisting
with deadline+progress becomes the turn-deadline message verbatim
(suppressing the synthesized evidence string) — deliberate (debuggability;
the breaker keys on kind, not message), unreachable on the Claude deadline
path today, and now pinned (spec T9). Negative-verify degenerate by
construction (no behavior change to fail against).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Task 9: Final verification — full gate + scope containment + explicit D13/T4/T8 checks

**Files:** none (verification only)

- [ ] **Step 1:** Full repo gate with the required env stubs:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
```

Expected: all four gates green — typecheck, lint, format, full vitest run (0 failures, including the untouched Lane B adapter, replay-processor, outage-notices, and agent-runner suites).

- [ ] **Step 2 (D13 explicit):** The three p95 pins must pass **with zero edits** — run them by name and prove the describe was never touched across the whole change:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/provider-circuit-breaker.test.ts -t "KPR-401 pins"
git diff HEAD~8 HEAD -- src/agents/provider-circuit-breaker.test.ts | grep "^[+-].*KPR-401" || true
```

Expected: 3 tests passed (closed-state record() success gate, settleProbe success gate, pushSample negative guard); the grep prints **nothing** — no added or removed diff line mentions KPR-401 (the appended KPR-400 describe lands after that describe's close; any `+`/`-` line inside the KPR-401 describe is a D13 violation: stop and investigate; the `|| true` keeps the no-match exit code from reading as a failure). Additionally confirm the breaker **source** diff never touches the pinned arms:

```bash
git diff HEAD~8 HEAD -- src/agents/provider-circuit-breaker.ts
```

Expected: no hunk modifies `pushSample`, the `case "success"` arm of `record()`, or any executable line of `settleProbe` (its comment truth-up is the only settleProbe hunk); the executable changes are confined to the const block, the field declarations, `acquire()`, the probe-clear lines in `record()`, and the registry `acquire` signature.

- [ ] **Step 3 (T4/T8 explicit):** Confirm both suites' pre-existing rows were never edited:

```bash
git diff HEAD~8 HEAD --stat -- src/channels/dispatcher.test.ts src/agents/provider-circuit-breaker.test.ts
git diff HEAD~8 HEAD -- src/channels/dispatcher.test.ts
```

Expected: the dispatcher test diff is a single contiguous insertion of the three KPR-400 rows (the ★ KPR-398 rows appear only as unchanged context); the breaker test diff is the appended KPR-400 describe only.

- [ ] **Step 4 (scope containment):** The eight KPR-400 commits touch exactly eleven files — none of them a Lane B adapter, the replay processor's code paths (comment hunks only), `agent-runner.ts`, the session store, KPR-399's PR #414 regions, or `docs/providers.md`:

```bash
git diff --stat HEAD~8 HEAD -- ':!docs'
```

Expected file SET, exactly (change bars/summary line aside):

```
src/agents/agent-manager.ts
src/agents/agent-manager.test.ts
src/agents/provider-adapters/error-classification.ts
src/agents/provider-adapters/error-classification.test.ts
src/agents/provider-circuit-breaker.ts
src/agents/provider-circuit-breaker.test.ts
src/channels/dispatcher.ts
src/channels/dispatcher.test.ts
src/outage/outage-queue-store.ts
src/outage/outage-queue-store.test.ts
src/outage/outage-replay-processor.ts
```

Additionally confirm the `agent-manager.ts` hunks stay inside the acquire site + the new helper (merge-order guard vs PR #414):

```bash
git diff HEAD~8 HEAD -- src/agents/agent-manager.ts
```

Expected: three hunks — the type import line, the `acquireDeadlineMs` helper after `providerFor`, and the acquire-site lines at the top of the `withSpawnTicket` lambda. No hunk touches the retry chain or `finalizeSpawnResult`.

- [ ] **Step 5:** No commit (verification-only task). Do not push, do not open a PR — that is the deliver lane's job.

---

## Plan-drafting advisories (implementer notes, not deviations)

- **[Task 1, Step 3/5]:** the excess-property widening of `meta` is additive — the breaker never *requires* `deadlineMs`; every existing caller and test compiles and behaves identically (the `??` chain reproduces the old 360s exactly: `(undefined ?? 300_000) + 60_000`).
- **[Task 1]:** the shadow-mode path (`enabled: false`) arms the same per-probe bound through the identical probe-arm branch — spec §Edge-6 needs no dedicated code and no dedicated test beyond the existing shadow rows staying green.
- **[Task 3]:** `agent-manager.ts` L1626's prose comment mentions "wedging a half-open probe permit for up to PROBE_STALE_MS" — still approximately true post-F1 (the bound is now per-probe); deliberately NOT edited to keep the diff inside the declared regions. Do not "fix" it.
- **[Task 5, Step 13]:** the parenthetical about the fake's single-key sort is the plan-time analysis of the *interim* state (source committed, harness extension still pending in Task 6); if any existing store row unexpectedly fails at Task 5's verify, pull Task 6 Step 1 (the harness extension only) forward into Task 5 and note the deviation — the rows themselves stay in Task 6.
- **[Task 6, legacy row]:** the `delete fake.docs...` line simulates a pre-KPR-400 doc because post-fix `enqueue` always writes the field; deleting is the honest fixture (BSON "missing", not `undefined`-valued).
- **[Task 7, Step 3]:** restore uses `git checkout HEAD~1 -- src/channels/dispatcher.ts` (the F2 source commit's version — `HEAD` is Task 6's test-only commit, whose tree carries the identical dispatcher.ts; either ref restores the same bytes, `HEAD~1` is named for clarity).
- **[Prettier reflow]:** several new `it(...)` titles and object literals exceed print width; each task's `prettier --write` before commit rewraps them — do not treat the reflow as a deviation.
- **[If PR #414 (KPR-399) merges into the epic branch mid-implementation]:** rebase; every anchor is text-based and lands in regions #414 does not touch. Shared file-level neighbors are `agent-manager.ts`/`agent-manager.test.ts` — resolve hunk-adjacency noise in favor of both changes; there is no semantic conflict (kpr-400-spec §Edge-10). After rebase, re-run the negative-verify anchors' `git log --oneline` sanity checks — relative anchors (`HEAD~N`) shift if the rebase lands mid-sequence.
- **[Adjacent, out of scope]:** the store's boot-only `recoverStaleReplaying`/`STALE_REPLAYING_MS` quirks (spec §Edge-9, ⚠A6) are flagged for the epic driver — do NOT fold them in here.
