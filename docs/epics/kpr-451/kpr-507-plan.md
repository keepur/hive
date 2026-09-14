# KPR-507 — Ops publisher reload ordering implementation plan

> **For agentic workers:** Execute this plan through the epic implementation lane (`dodi-dev:implement-ticket`). Read this single file as the whole plan — the ticket is small enough that no chunk split is needed.

**Goal:** Make `OpsPublisher.reloadSubscriptions()` commit by start order, not completion order, so an older overlapping reload can never undo a later one's committed subscription set — closing the race whose enable-direction blast radius is a permanently lost notification (KPR-458's immutable-stamp rule).

**Implementation approach:** Mirror, do not extract, the ordering pattern KPR-468 already shipped on `OpsNotifier.reloadSubscriptions` (`src/ops/notifier.ts:294-405`, fields at `:91-92`): two private start/commit sequence integers, a `seq` taken before the first await, and a synchronous, no-await commit block that only replaces state when `seq >= reloadCommitted`. The publisher's own six-line version is a **separate, duplicated** implementation — same shape, different projection (an array + admissibility audit, vs. the notifier's Map + bindability validation) — per [KPR-507 design](kpr-507-design.md) D1 ("Do not extract a helper shared with `OpsNotifier.reloadSubscriptions`"). Every counter, latch and warn the current method touches keeps its documented meaning under D2's restated table: a discarded success is not a fault, does not run the row audit, and does not touch the anomaly signature or gauge.

**Dependency order:** One sequential unit — the implementation (Task 1) must land before the tests that exercise it (Task 2) can pass, and both must land before the documentation task (Task 3), which also carries the final `npm run check` gate. No external ticket dependency: KPR-454 (producer) and KPR-468 (mirrored pattern) are both already merged on this worktree's base (`epic/kpr-451` at `c79eafac`). Nothing in `src/ops/notifier.ts` is imported, modified, or shared.

**Tech Stack:** Existing TypeScript strict / Node 22–24, Vitest, the existing in-memory Mongo double (`src/ops/testing/fake-db.ts`). No dependency addition, no new collection, no new `hive.yaml` key.

**Approved input:** [KPR-507 design](kpr-507-design.md), spec sha256 `32f7c8305239541b671a6f86dc9abc0edba57bf8e3c02ee5260980cd9a9b404a` (re-verified at plan time — unchanged), clean at spec-review round 4 with Gate 1 delegated signoff. Planner routing: Standard tier (spec-review round 4, runtime=codex model=gpt-6-astra effort=high — "familiar local change with settled commit, failure, and lifecycle semantics; deterministic regression scenarios and the existing harness are specified; no migration or cross-component redesign remains").

**Epic Decision Register canon carried forward (KPR-451, read at plan time):** KPR-454 — "a reload fault keeps the previous set; it never empties it" and "`matchedSubscriptions` is exactly `matchedSubscriptionIds.length`, never capped." KPR-458 — "match evaluation is pure, rides the immutable publish insert as `matchedSubscriptionIds`, and is never re-evaluated downstream" (this is *why* the enable-direction bug is a permanent loss rather than a self-healing one). KPR-468 — "completed disables stop later posts: older reloads cannot replace later successful commits, while failed or guard-skipped reloads supersede nothing. This ordering is local to the notifier and does not repair the publisher's separate cache. Sibling follow-up KPR-507 (this ticket) blocks KPR-501." This plan is exactly that follow-up; it does not touch the notifier, does not merge the two caches, and does not unblock or implement any part of KPR-501 beyond leaving `OpsPublisher`'s cache safe for a second producer to publish through later.

**Execution boundary:** This plan drafts artifacts only. It does not implement, push, edit PM state, deploy, or start a service. Drafting makes no runtime success claim; child readiness and delivery remain dispatcher-owned.

---

## Files to modify

- `src/ops/publisher.ts` — the two new private sequence fields (near the existing `subscriptionAnomalySignature` / `reloadTimer` / `nextOpenSeq` field block, `:170-172`), and `reloadSubscriptions()` (currently `:291-304`) rewritten to the start-numbered commit rule. No other method changes: `init()`, `stop()`, `auditLoadedEnableGate()`, `auditSubscriptionRows()`, `accept()`, `getSnapshot()` keep their existing bodies and call sites.
- `src/ops/publisher.integration.test.ts` — one new `describe` block covering AC1–AC7 (or an immediately-adjacent new file, see Task 2's file-placement note).
- `CLAUDE.md` — one sentence appended to the existing **Ops tool-failure publishing (KPR-454, `src/ops/`)** bullet (`:300`), adjacent to the existing "the subscription set, by contrast, reloads every 60 s and on SIGUSR1" clause.

## Files deliberately not touched

`src/ops/store.ts` (`loadSubscriptions` stays a bare `find({enabled:true})`), `src/ops/match.ts`, `src/ops/notifier.ts`, `src/index.ts` (no boot-order wiring changes — `reloadSubscriptions` is already wired via `init()` and the existing SIGUSR1 handler), `src/boot-order.test.ts` (no new anchor), `src/ops/testing/fake-db.ts` (the harness already provides everything this ticket needs — see Task 2's Harness note), any `hive.yaml` key, any KPR-501 or KPR-455 file.

---

## Testing Contract

### Required Test Groups

- Unit: **not-required**
  - Scope: the commit-rule comparator in isolation, if a plan step nevertheless extracted one (it does not — see D1).
  - Reason: the able-to-fail property is the interleaving of two overlapping `find`s against a captured snapshot, ending in an immutable insert — a unit test of two integers cannot see either half. The design explicitly rejects extracting a helper whose only purpose would be to justify a unit suite.

- Integration: **required**
  - Scope: a real `OpsPublisher` over the existing in-memory Mongo double (`FakeDb`), driving `observeToolFailure` → enqueue → drain → `accept()` → `insertOne`, with the reload race constructed via `FakeDb.pause(OPS_SUBSCRIPTIONS_COLLECTION, "find", () => true, true)` (the `after=true` fourth argument is load-bearing — see Harness Requirements) and fault injection via `failNext`/an inline nth-call counter against that same `find`.
  - Reason: both blast radii (obsolete-interest and permanently-lost-match) live on the **inserted** `ops_events` document's `matchedSubscriptionIds`, not on `getSnapshot()` alone. A snapshot-only assertion would miss the enable-direction permanent loss; a matcher-only assertion would miss the immutability that makes it permanent.
  - Harness: **existing**, no extension needed. `src/ops/testing/fake-db.ts` already provides `pause(collection, operation, when, after)`, `failNext`, `failAll`/`clearFaults`, and `OpsPublisher.__drainForTests()` is already the publish→assert barrier used throughout `src/ops/publisher.integration.test.ts`.
  - Minimum assertions: AC1–AC7 as named tests (see Task 2). AC1/AC2 assert the **inserted document's** `matchedSubscriptionIds` and `matchedSubscriptions`, not merely `getSnapshot().subscriptions`. AC3–AC5 assert both the committed snapshot and the next event's stamp. AC6 asserts the gauge, the fault counter, and warn call counts. AC7 asserts the absence of a `find` operation on `OPS_SUBSCRIPTIONS_COLLECTION` (never a read of the private `reloadsStarted` counter — none is exposed, and none should be added).

- E2E: **not-required**
  - Scope: a deployed instance, a live Mongo, a real SIGUSR1 against a running hive, a real 60 s wait.
  - Reason: the race is a process-local interleaving of two in-process `find`s. The double's `pause(..., after=true)` construction is a *stricter* reproduction than a live timer — it guarantees the older read holds a genuinely stale captured result while the newer one commits — and a live SIGUSR1 would add network/timing nondeterminism without exercising a different code path.
  - Harness: not-applicable.
  - Minimum assertions: none; no assertion is waived from the integration group.

### Critical Flows

- Timer-shaped reload A captures `{s1}` (enabled) → operator disables `s1` → SIGUSR1-shaped reload B commits `[]` → A's held read is released and finishes → a failure publish stamps `matchedSubscriptionIds: []`, `matchedSubscriptions: 0`; `getSnapshot().subscriptions` stays `0`.
- Reload A captures `[]` (nothing enabled yet) → operator enables `s1` → reload B commits `{s1}` → A's held read is released and finishes → a failure publish stamps `matchedSubscriptionIds: ["s1"]`, `matchedSubscriptions: 1`.
- A held → B throws (`subscriptionReloadFaults === 1`, previously-committed set retained, unchanged) → C (a third, later-started reload) commits the post-fault collection state → A finishes and is discarded (no restoration) → the next event's stamp reflects C's set.
- A held → B throws → A finishes and commits (A is still newer than the retained set, since B never advanced `reloadCommitted`) → no "superseded" debug line is emitted for A → the next event's stamp reflects A's set.
- `init()`'s own first `reloadSubscriptions()` call is held (on an empty collection) → a row is inserted and a concurrent `reloadSubscriptions()` call commits `{s1}` → the first load's held read is released, observes it was superseded, and is discarded → `init()` still resolves (timer armed, enable-gate audit ran, no throw) → the next event's stamp reflects `["s1"]`.
- A newer commit has already raised `subscriptionRowAnomalies` to a nonzero count and fired the anomaly warn once → an older, already-in-flight success that had captured a *clean* set is released and discarded → the gauge stays at the newer count, `subscriptionReloadFaults` does not move, and no second anomaly warn (and no "reload failed" warn) is emitted for the discarded load.

### Regression Surface

- The full existing `publisher.integration.test.ts` anomaly suite (`describe("an unusable subscription row is COUNTED and NAMED, per reload (C2)")`, `describe("OpsPublisher survives a malformed subscription row")`, `describe("matchedSubscriptions IS matchedSubscriptionIds.length — no stored-list cap")`) — every one of these makes *sequential*, non-overlapping calls to `reloadSubscriptions()`, so under the new ordered-commit rule each call's `seq` is always `>= reloadCommitted` at the moment it resolves and every existing assertion holds unchanged. This is a property to verify, not assume (Task 1's own verification step runs this file before any new test is added).
- `describe("OpsPublisher boot and registry")` — `init()`'s own call to `reloadSubscriptions()` behaves identically for every existing case (a single, non-overlapping call always commits).
- `src/ops/acceptance.integration.test.ts` — AC2 (zero-match document shape) and any reload-then-match subscriber-added path.
- `src/ops/capture-points.integration.test.ts` — capture points never call `reloadSubscriptions` themselves and must keep publishing unaffected.
- `src/ops/match.test.ts` — the pure evaluator this stamp still calls is unchanged.
- KPR-468's own delivery/intake/notifier suites (`src/ops/delivery.integration.test.ts` and siblings) — this ticket does not edit `notifier.ts`; the double (`fake-db.ts`) is shared and must keep its `pause`/`failNext`/copy-before-after-hook behaviour intact for those suites too.
- `src/boot-order.test.ts` — no new `.start(` call, no anchor added or moved; this ticket adds no wiring above or below the spawn-capable boundary.
- `src/index.ts`'s SIGUSR1 handler body — still one listener, still two separate `void …reloadSubscriptions()` calls (`opsPublisher` and `opsNotifier`), still no shared cache between them.

### Commands

Run from `/Users/mokie/github/hive-kpr-507-mature` on Node 22 or 24 (CLAUDE.md: dev mode on Node 26 is broken by the Qdrant client's bundled dispatcher — this affects `npm run check`'s full suite, not the targeted commands below, but use 22/24 throughout for consistency).

- Setup: `node --version` (expect v22.x or v24.x); `npm ci` if `node_modules` is missing.
- Targeted (this ticket): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/publisher.integration.test.ts`
- Adjacent publisher/accept regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/publisher.integration.test.ts src/ops/acceptance.integration.test.ts src/ops/capture-points.integration.test.ts src/ops/match.test.ts`
- Notifier regression (shared double): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/delivery.integration.test.ts`
- Boot regression: `npx vitest run src/boot-order.test.ts`
- Typecheck while iterating: `npm run typecheck`
- Broader regression / submission gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Hygiene: `git diff --check`
- Expected for every Vitest command: exit 0, all selected tests pass, no skipped new contract cases. Expected for `npm run typecheck`: exit 0, no diagnostics. Expected for `npm run check`: typecheck, lint, format check and the full suite each exit 0. Record actual totals; do not invent expected test counts. Drafting (this plan) makes no runtime success claim.

### Harness Requirements

- `FakeDb.pause(OPS_SUBSCRIPTIONS_COLLECTION, "find", () => true, true)` — the fourth argument `true` (after the copy) is load-bearing: `operation()` copies the find result *before* entering the after-hook (`src/ops/testing/fake-db.ts` `operation()`), so `after=true` is what lets a held call retain a genuinely stale captured array while a second call commits against the mutated collection. `after=false` holds *before* the copy and does not reproduce the race.
- `FakeDb.failNext(OPS_SUBSCRIPTIONS_COLLECTION, "find")` (already used in the existing "a reload FAULT leaves the counter alone" test) covers a single-shot fault; where a test needs an nth-call fault, use `failNext`'s `when` predicate with an inline counter (e.g. `let seen = 0; fakeDb.failNext(OPS_SUBSCRIPTIONS_COLLECTION, "find", undefined, () => ++seen === n)`) rather than adding a new double method — `failNext`'s `when` parameter already supports this and `failAll`/`clearFaults` exist for a persistent fault if a scenario needs one. Do not add a test hook exposing `reloadsStarted`/`reloadCommitted`; AC7 is verified by the absence of a `find` operation instead.
- `observeToolFailure(...)` + `await publisher.__drainForTests()` as the only publish→assert barrier — `enqueueFailure` is synchronous and returns before the drainer runs, so a bare `await` on the observe call proves nothing (existing file convention, see its header comment).
- Reuse the existing fixture shape from the file's "unusable subscription row" and "no-stored-list-cap" describe blocks: an admissible enabled row needs `_id` (a plain string ≤ 200 chars), `enabled: true`, a plain-object `filter` (e.g. `{}` to match everything), and a `transport: { adapterId: "slack", target: "C1" }` object (present so the row is a realistic document; the publisher's own matcher does not read `transport`).
- The hoisted `mockLog` (`debug`, `info`, `warn`, `error`, all `vi.fn()`) already at the top of `publisher.integration.test.ts` is the log-call-counting surface for the new "superseded" debug line and for the existing anomaly-warn assertions; no new mock is needed.
- No live Mongo, no Slack token, no Anthropic key, no real SIGUSR1, no fake timers for the 60 s interval — the overlap is constructed with `pause`, never with `vi.advanceTimers` or a `Date.now` spy.

### Non-Required Rationale

- Unit: stated above — the comparator is not an independently useful product surface, and the insert is what actually needs proving.
- E2E: stated above — the double's `after=true` construction is the reproduction; a live signal cannot pin both directions deterministically.

### Verification Rules

- Missing harness is not a skip reason — the double already has everything this ticket needs (see Harness Requirements).
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote to the spec lane rather than reinterpreting the design.
- **Negative-verify, required at three points** (each: apply the mutation, confirm the named test fails, then restore and re-run to confirm green):
  1. **AC1/AC2's commit rule.** Temporarily restore the unconditional form (`this.subscriptions = await this.store.loadSubscriptions();` with no `seq`/`reloadCommitted` gate). Both direction tests (AC1 and AC2) must fail on the inserted stamp — the disable-direction test would see the enabled set restored (`["s1"]` instead of `[]`), and the enable-direction test would see the empty set restored (`[]` instead of `["s1"]`).
  2. **AC6's audit-on-commit rule.** Temporarily call `auditSubscriptionRows` on the discarded `next` array as well as the committed one. The "gauge stays at N, discarded clean capture does not zero it" case must fail.
  3. **AC4's fault-does-not-supersede rule.** Temporarily advance `reloadCommitted` inside the `catch` block on a thrown load. The "an older success landing after only a failed later reload still commits" case must fail (the stamp would incorrectly stay at the pre-fault set instead of the older-but-still-fresher-than-retained set).
- Run the targeted Vitest command after each task lands; run `npm run check` once before submission. No completion, commit, or PR claim before evidence from a fresh run of the relevant command.
- No live Slack posts, no production channel creation, no agent-definition edit, and no deploy during implementation.

---

## Task 1: Ordered start-numbered commit in `OpsPublisher.reloadSubscriptions`

**Outcome / spec coverage:** `OpsPublisher.reloadSubscriptions()` commits by the order calls *started*, not the order their reads *finished*, closing the race described in [KPR-507 design](kpr-507-design.md) §Problem. Covers D1 (the mechanism), D2 (every existing counter/latch keeps its documented meaning under the new rule), and D3 (no change to `init()`'s re-entrancy, first-load, or `stop()` postures). This task is the implementation half of AC1–AC7; Task 2 is its proof.

**Components and known files:**
- `src/ops/publisher.ts` — `OpsPublisher` class. Current private field block (`subscriptionAnomalySignature`, `reloadTimer`, `nextOpenSeq`, currently around `:170-172`) gains two new private fields: a start-sequence counter and a committed-sequence counter, both initialized to `0`, both undocumented on `getSnapshot()` and not exported as a test hook — mirroring the shape (not the code) of `src/ops/notifier.ts:91-92`. The current `reloadSubscriptions()` method body (currently `:291-304`) is rewritten per D1's five numbered steps in the design: guard first (unchanged), take the sequence number before the first await, load into a local variable (not yet assigned to `this.subscriptions`), on throw increment the fault counter and warn without touching the committed sequence, and on success synchronously compare-and-commit (discard-with-one-debug-line if superseded, else commit array + committed sequence + run the row audit).
- `src/ops/notifier.ts:294-405` (read-only reference) — the already-shipped mirror of this exact pattern, over a different projection (Map + bindability validation vs. this ticket's array + admissibility audit). Read it to confirm the shape; do not import from it, and do not factor a shared helper (D1 explicitly forbids this — the two are a deliberate duplication, not a missed DRY opportunity).
- `src/ops/publisher.ts` — `auditSubscriptionRows()` (currently `:323-363`), `subscriptionAnomalySignature`, `subscriptionRowAnomalies`, `subscriptionReloadFaults` counters: unchanged in their own bodies, but `auditSubscriptionRows` must now be called **only** from the committed-success branch, never from a discarded-success branch (this is the entire content of D2's "a discarded success must not run `auditSubscriptionRows`" rule).
- `src/ops/publisher.ts` — `init()` (currently `:214-239`) and `stop()` (currently `:372-393`): read them to confirm neither needs a change. `init()`'s existing `await this.reloadSubscriptions()` call and its existing re-entrancy handling (the `if (this.reloadTimer) clearInterval(...)` line) are untouched; the two new sequence fields are **not** reset on re-entrant `init()` calls (D3 — a reset would re-open "older finisher wins" against whatever committed during the instance's previous life). `stop()`'s existing `this.stopping = true` guard at the top of `reloadSubscriptions()` is the only `stopping` check; do not add a second one at commit time.

**Dependencies:** None — this is the first task.

**Interfaces, compatibility, and invariants (approved, from the design, D1–D3):**
- `if (this.stopping) return;` stays the first statement, evaluated **before** any sequence number is taken. A `stopping`-skipped call performs no read, allocates no sequence number, and supersedes nothing (AC7).
- The sequence number is taken (`++` the start counter) **before the first await** in every call, so start order is call order regardless of which read settles first.
- The store read result is held in a **local** variable; `this.subscriptions` is not touched until the commit branch runs.
- On a thrown load: increment `subscriptionReloadFaults`, keep the existing warn text and shape, `return`. Do **not** advance the committed-sequence counter, do **not** call `auditSubscriptionRows`, do **not** rethrow. (An older in-flight success is still a fresher snapshot than the retained set and may still commit when it lands — this is why a fault must not advance the committed counter.)
- On a successful load, synchronously (no `await` between the comparison and the commit): if this call's sequence number is strictly less than the committed-sequence counter, discard — emit one `log.debug` naming the call's own sequence number and the currently-committed one, then `return`. This is **not** a fault: do not touch `subscriptionReloadFaults`, and do not run the row audit. Otherwise, commit: set the committed-sequence counter to this call's sequence number, replace `this.subscriptions` with the freshly loaded array, then call `auditSubscriptionRows` on that same freshly loaded array.
- Use strict `<` for the discard comparison (matching `src/ops/notifier.ts:387`). Every call receives a unique, monotonically incremented sequence number, so an equality case is not live — do not add a separate branch for it.
- No `rethrow` parameter is added to `reloadSubscriptions` (unlike the notifier's `reloadSubscriptions(rethrow = false)` — the publisher has no caller that needs it, and `init()`'s existing boot-non-fatal posture must not change).
- The two new fields are never exposed on `getSnapshot()` and never given a `__`-prefixed test accessor. AC7's verification reads the absence of a `find` operation on the fake collection instead (see Harness Requirements).

**Acceptance criteria:** AC1 (disable direction not undone by an earlier finisher), AC2 (enable direction not undone by an earlier finisher — the permanent-loss direction), AC3 (a later reload that fails does not block the one after it, and that one still beats the earlier read), AC4 (an earlier read finishing after only a failed later reload still commits), AC5 (a discarded earlier first load inside `init()` does not block `init()` from resolving, and the later set still wins), AC6 (a discarded success is not a fault and does not re-run the row audit — the gauge and signature are properties of the committed set only), AC7 (a `stopping` skip still performs no read and supersedes nothing) — all as observable behavior; Task 2 is where each becomes a named, running test.

**Verification:**
- Tests and critical failure cases: no new tests are written in this task. The critical check is that every *existing* test in `src/ops/publisher.integration.test.ts` still passes unchanged, since every existing call to `reloadSubscriptions()` in that file is sequential (non-overlapping) and must therefore always satisfy `seq >= reloadCommitted` at commit time under the new rule.
- Harness/environment: none beyond the existing repo setup (Node 22/24, `npm ci` if needed).
- Run: `npm run typecheck`, then `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/publisher.integration.test.ts`, then the adjacent regression command (`src/ops/acceptance.integration.test.ts src/ops/capture-points.integration.test.ts src/ops/match.test.ts`).
- Expected: `npm run typecheck` exits 0 with no diagnostics. All four Vitest files pass with the same test count as before this task's edit (no test added or removed yet) and no new failures.

- [ ] Add the two private sequence fields and rewrite `reloadSubscriptions()` per the interfaces above, leaving every other method's body and every call site untouched.
- [ ] Verify: run the commands above; confirm typecheck is clean and every existing test in the four listed files still passes with an unchanged pass count.
- [ ] Commit the completed task.

## Task 2: Integration tests proving AC1–AC7

**Outcome / spec coverage:** AC1–AC7 each become a named, running integration test over the real `OpsPublisher` + the in-memory Mongo double + the real accept-path insert, satisfying the design's Testing Contract ("Integration: required... not a mocked `reloadSubscriptions`, not a stubbed `evaluateMatches`, not an assertion on log lines alone").

**Components and known files:**
- `src/ops/publisher.integration.test.ts` (1108 lines as of this plan) — add one new `describe` block. Placement: after the existing `describe("an unusable subscription row is COUNTED and NAMED, per reload (C2)")` / `describe("matchedSubscriptions IS matchedSubscriptionIds.length — no stored-list cap")` blocks (both of which already exercise `reloadSubscriptions()` and the subscription fixture shape) is a natural fit, but exact placement within the file is an implementer choice as long as the block is self-contained. If adding this block would make the file unreasonably large to review as one unit, create an immediately-adjacent `src/ops/publisher-reload.integration.test.ts` instead, following the same imports, `mockLog` hoisting pattern, and `beforeEach`/`afterEach` setup as the existing file — but prefer extending the existing file per the design's own stated preference.
- Existing fixtures to reuse, not reinvent: `driveFailure(tool, extra?)` / `driveSuccess(tool)` (observe-path helpers already in the file), `events()` (direct row read), `warnsMatching(fragment)` (counts `mockLog.warn` calls), the admissible-row shape from the `row(over)` helper in the "unusable subscription row" describe block (`_id`, `subscriberId`, `subscriberKind`, `enabled: true`, `filter: {}`, `transport: { adapterId: "slack", target: "C1" }`), and `publisher.__drainForTests()` as the publish→assert barrier.
- `FakeDb.pause` / `FakeDb.failNext` / `FakeDb.failAll` (`src/ops/testing/fake-db.ts`) — the race-construction primitives; see Harness Requirements in the Testing Contract above for the exact `pause(..., after=true)` requirement and the nth-call fault pattern.

**Dependencies:** Task 1 must be complete — these tests exercise the ordered-commit implementation and will fail against the pre-Task-1 code (which is exactly the negative-verify property required below).

**Interfaces, compatibility, and invariants:** Every new test must drive at least one real published event through `observeToolFailure` → `__drainForTests()` and read the **inserted document's** `matchedSubscriptionIds` / `matchedSubscriptions` fields (never `getSnapshot().subscriptions` alone) for AC1 and AC2 specifically, per the design's explicit instruction that a snapshot-only assertion would miss the enable-direction permanent loss. Use two or three distinct `OpsPublisher.reloadSubscriptions()` calls per scenario, held and released via `pause` to control finish order independently of start order — start order is simply the order the calls are issued (not awaited) in the test body.

**Acceptance criteria:** Each of AC1–AC7 from the design (quoted in full in [KPR-507 design](kpr-507-design.md) §Acceptance criteria) is a separate `it(...)` (or `it.each` where the disable/enable pair shares shape) that fails against the unmodified pre-Task-1 code and passes against Task 1's implementation.

**Verification:**
- Tests and critical failure cases: the six Critical Flows listed in the Testing Contract above map onto AC1 (disable direction), AC2 (enable direction), AC3/AC4 (fault-vs-supersede pair), AC5 (discarded first load inside `init()`), AC6 (discarded success is not a fault, does not touch the audit). AC7 is the `stopping`-skip case: after `publisher.stop()`, a subsequent `reloadSubscriptions()` call must produce no new `find` operation on `OPS_SUBSCRIPTIONS_COLLECTION` in `fakeDb.operations` and must not increment `subscriptionReloadFaults`.
- Harness/environment: none beyond `FakeDb` (already constructed in the file's `beforeEach`). No live Mongo, no Slack token, no Anthropic key, no real timers.
- Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/publisher.integration.test.ts` (or, if a new adjacent file was created, add it to this command).
- Expected: all seven new cases pass; the full file's existing test count is unchanged and still green. Additionally perform the three required negative-verifies from the Testing Contract's Verification Rules (temporarily reintroduce each of the three named implementation defects, confirm the specific test fails, then restore and re-confirm green) — record the outcome of each.

- [ ] Add the seven AC1–AC7 tests (or an `it.each` covering the AC1/AC2 pair plus five further cases) to `src/ops/publisher.integration.test.ts` (or the adjacent file, if size forces the split), reusing the existing fixtures and barrier pattern.
- [ ] Verify: run the targeted command and confirm all new and existing tests pass; perform and record the three negative-verifies.
- [ ] Commit the completed task.

## Task 3: CLAUDE.md documentation and the final gate

**Outcome / spec coverage:** AC8 — the KPR-454 **Ops tool-failure publishing** bullet in `CLAUDE.md` gains one sentence describing the ordered-commit rule, without claiming the notifier's fix repaired the publisher and without implying the two caches are shared. This task also runs the full `npm run check` submission gate.

**Components and known files:**
- `CLAUDE.md:300` — the **Ops tool-failure publishing (KPR-454, `src/ops/`)** bullet. The insertion point is immediately adjacent to the existing clause "…the reason map is loaded once in `init()`, so restart is the lever; the subscription set, by contrast, reloads every 60 s and on SIGUSR1)." The new sentence states, in the bullet's own voice: publisher subscription reloads are ordered by start, so an older completion cannot replace a later successful commit, and a failed or `stopping`-skipped reload supersedes nothing. Do not add a parallel sentence to the KPR-468 **Ops notifier** bullet — that ordering wording is not there today and this ticket does not add it there.

**Dependencies:** None on Tasks 1–2 for the edit itself, but this task is last because it also runs the final full-suite gate, which should only run once the code and tests are in place.

**Interfaces, compatibility, and invariants:** The added sentence must (a) state the ordered-commit rule for the publisher specifically, (b) not claim KPR-468's notifier fix repaired the publisher's cache, (c) not imply the publisher and notifier subscription caches are shared or merged, and (d) not be mirrored onto the KPR-468 **Ops notifier** bullet.

**Acceptance criteria:** AC8 — the sentence is present in the correct bullet, adjacent to the named existing clause, and satisfies the four constraints above; the KPR-468 **Ops notifier** bullet is untouched.

**Verification:**
- Tests and critical failure cases: this is a documentation assertion. Per the design's Testing Contract, "a source scan or a focused string test is enough" and English beyond presence of the ordered-commit claim (and absence of a "notifier repaired the publisher" claim) need not be parsed.
- Harness/environment: none.
- Run: `grep -n "the subscription set, by contrast, reloads every 60 s and on SIGUSR1" CLAUDE.md` to confirm the anchor clause is still present and locate the insertion point; after editing, `grep -c "ordered by start" CLAUDE.md` (or equivalent phrase actually used) should return exactly `1`, and a manual read of the KPR-468 **Ops notifier** bullet should confirm no mirrored sentence was added there. Then run the full gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`.
- Expected: the grep checks confirm placement and non-duplication; `npm run check` exits 0 (typecheck, lint, format, and the full test suite all pass).

- [ ] Add the one-sentence documentation update to the CLAUDE.md bullet at the specified insertion point.
- [ ] Verify: run the grep checks above, then `npm run check`; confirm exit 0 and record the result.
- [ ] Commit the completed task.

---

## Task order and commits

1. Task 1 — implementation. Run typecheck + existing regression files; commit alone (no new test yet, matching the design's own separation of the mechanism from its proof).
2. Task 2 — the seven AC tests, plus the three required negative-verifies (performed and reverted, not committed). Commit once all pass.
3. Task 3 — the CLAUDE.md sentence, plus the full `npm run check` gate. Commit last.

Do not parallelize: Task 2 asserts against the exact code Task 1 produces, and Task 3's full-suite gate is only meaningful once both are in place.

## Acceptance-criteria coverage map

| AC | Where it is proved |
| --- | --- |
| 1 | Task 1 (mechanism) + Task 2 disable-direction test, asserting the inserted document |
| 2 | Task 1 (mechanism) + Task 2 enable-direction test, asserting the inserted document (the permanent-loss direction — not optional) |
| 3 | Task 1 (mechanism) + Task 2 fault-then-later-commit test |
| 4 | Task 1 (mechanism) + Task 2 fault-then-earlier-still-commits test, asserting no superseded debug line |
| 5 | Task 1 (`init()` unchanged) + Task 2 discarded-first-load-inside-init test |
| 6 | Task 1 (audit gated to committed branch only) + Task 2 gauge/fault/warn-count test, both directions (raised-then-discarded-clean, and repaired-then-discarded-broken) |
| 7 | Task 1 (`stopping` guard unchanged, first statement) + Task 2 absent-find test |
| 8 | Task 3 CLAUDE.md sentence + grep verification |

## Engineering decisions and assumptions carried forward from the design (not re-decided here)

- **Non-blocking, observed (design §Assumptions):** production `init()` cannot overlap SIGUSR1 today because the handler is registered after `init()` returns (`src/index.ts:566` then `:719`). The AC5 test still exists because a test, a re-entrant `init()`, or a future relocation of the handler registration could overlap it, and because "does `init()` have a second unordered assignment" was the question that prompted this ticket.
- **Non-blocking, inherited residual (design D5):** start-order commits the later-*started* snapshot, not the later-*observed* one — two overlapping reads that both started before a collection mutation can both snapshot the pre-mutation state, healed by the next successful reload. This is the same residual KPR-468 already accepted for the notifier; it is not solved by this ticket and is not re-litigated here.
- **Delegated, non-blocking (design §Assumptions):** the one `log.debug` line on discard exists so AC1/AC3-family tests can count a superseded line directly rather than inferring solely from the stamp; its absence would not itself be a product defect, but this plan includes it because Task 1 mirrors the notifier's shape, which already includes it.
- **Delegated, non-blocking (design §Assumptions):** the CLAUDE.md sentence (AC8) is included in the same change per the KPR-452/KPR-454 precedent that documentation for a subscription-cache contract lands with the code that establishes it.
- No blocking product question remains open. The fix, both reproduction directions, the mirrored-not-shared pattern, and the CLAUDE.md placement are all decided in the design; this plan carries them forward without amendment.
