# KPR-409 Implementation Plan — Scribe role: running meeting summary as the fresh-session anchor

**Goal:** a cheap (`haiku`), tool-less pool worker maintains a per-thread **running summary** in a new `meeting_summaries` collection during an active meeting, and `buildConferenceContext`'s full arm injects **summary + messages-since-summary** instead of the raw 105-message transcript. The scribe is not a meeting participant, has no posting surface, and every failure mode degrades silently to today's byte-identical behavior.

**Tech stack:** TypeScript (strict, no `any` without justification), Node 22, MongoDB (native driver `^7.5.0` — v7 `findOneAndUpdate`/`updateOne` semantics), Claude Agent SDK via the existing `buildWorkerAdapter` manager hook, vitest (tests beside source).

**Spec:** `docs/epics/kpr-386/kpr-409-spec.md` (spec-ready, review clean r3 — binding contract). Epic branch `KPR-386` @ `dc2a685` (KPR-387/388/389/390 all merged).

**Canon note:** C1–C29 bind. This ticket files **two formal relaxation REQUESTS** against canon — R1 (C13/C26: two round-level conference hunks beyond the sanctioned full-arm anchor) and R2 (C9: the mark advances over summarized-but-not-literally-injected messages). Neither is self-authorized; both are submitted for the **coherence reviewer's ruling at this ticket's own merge seam**, the same mechanism KPR-390 used for its containment relaxations. Ruling on R1/R2 is **not this plan's job and not the implementer's** — see "Out-of-scope guard rails".

---

## ⚠ R2-as-primary / F1-as-documented-fallback — explicit decision statement

**This plan implements R2 as the primary and default path.** The summary arm's high-water mark is

```ts
injectionHighWaterTs: maxSlackTs([...tail.map((m) => m.ts), summary.coveredThroughTs, roundZeroTriggerTs])
```

— `coveredThroughTs` maxed in, per spec §D4's recommendation. Test **T2(b)** and **T5** are written against R2 (empty tail ⇒ `injectionHighWaterTs === coveredThroughTs`, and `setMeetingMark` IS called).

**F1 is documented, not built.** If the coherence reviewer rejects R2 at the merge seam, F1 is the fallback: the summary arm returns `injectionHighWaterTs: undefined`, `dispatchToAgent:1114`'s `else if` skips `setMeetingMark`, and no mark is ever written from a summary turn.

⚠ **Cost of the switch — stated precisely, because the obvious reading is wrong.** F1 is **not** "delete the `summary.coveredThroughTs` term". Deleting only that term leaves `maxSlackTs([...tail.map((m) => m.ts), roundZeroTriggerTs])`, which is still a **defined** string on every round-0 summary turn (the trigger ts) and on every non-empty-tail turn (the tail max) — so `setMeetingMark` still fires in three of the four cases, and what you would have built is the withdrawn "max in only when the tail is non-empty" variant (spec §D4 retracts it), not F1. **True F1 is the deletion of the entire `injectionHighWaterTs: maxSlackTs([...])` property assignment**, leaving the summary arm returning `{ threadContext, injectionMode: "summary" }` with **no `injectionHighWaterTs` key at all** (hence `undefined` on every summary turn, exactly as spec §D4 defines it).

Consequently the test cost is **five inversions, not two**: both **T2(a)** cases, **T2(b)**, **T2(c)**, and **T5** all assert `setMeetingMark` was called with a value in summary mode, and all five flip to pinning its absence under F1. Cost of the *behavior*: a fresh entrant never converts to delta and re-enters the summary arm on every turn — traded deliberately, priced at spec §D4.

Implementers: build R2. Do not build F1 speculatively, do not add a config flag to switch between them, and do not soften R2 into the withdrawn "max in only when the tail is non-empty" variant (spec §D4 explicitly retracts it — it does not exist).

---

## Testing Contract

### Test groups

| Group | Verdict | Scope / Reason | Harness | Minimum assertions |
|---|---|---|---|---|
| **Unit** | **required** | Every new module and every touched engine seam: the `MeetingScribe` service (gating table, synchronous single-flight claim, `updating` doc guard, summary write/truncation, role-params containment, abort registry, `stop()`), the pool's two pure additions (`runRoleTurn` clone shape + `hasCapacity`), the config resolver's seven scribe keys, and the dispatcher's summary anchor (byte pin, high-water formula, delta-arm isolation, self-heal leg, round-level cadence seam) | vitest beside source: new `src/workers/meeting-scribe.test.ts` + additions to `src/channels/dispatcher-conference.test.ts`, `src/workers/meeting-worker-pool.test.ts`, `src/config.test.ts`. Fake `Db`/collection objects (`meeting-worker-pool.test.ts` / `callback-mcp-server.test.ts` precedent), injected fake pool + registry + `now` seams, the existing conference-suite mock stack (`makeMockAgentManager` session-ref map, `makeMockSlackAdapter`, hoisted classifier mock) | Spec **T1–T12** in full (T1 summary byte pin incl. the empty-tail row; T2 high-water formula **written against R2**, with the F1 inversion note recorded in the test file; T3 C6 pin unmodified; T4 delta arm never reads summaries; T5 self-heal leg untouched; T6 round-level cadence seam incl. the deliberate round-1 selection gating; T7 role-params + containment pin on the **built worker config**, not prose; T8 the seven-row gating table; T9 write + single-flight incl. stale-`updating` override; T10 no side effects; **T11 synchronous-claim race** — five in-tick calls ⇒ exactly one `runRoleTurn`; **T12 capacity isolation** — a live scribe leaves `pool.hasCapacity()` true and four fetch dispatches still succeed at `maxConcurrent: 4`) **plus**: `getSummary` stub-doc guard (a doc carrying only `_id` + `updating` from a failed first run must read as *no summary*), `getSummary` fail-soft (Mongo throw ⇒ `undefined` ⇒ full arm, dispatch still completes), `ensureIndexes` spec pin (`{ updatedAt: 1 }, { expireAfterSeconds: 604800 }`), pool-level companion to T12 (`runRoleTurn` alone registers nothing in `liveWorkers` and does not move `hasCapacity()`), config-resolver liberal-loader rows (absent / garbage / valid × 7 keys) |
| **Integration** | **not-required** (as a separate harness) | Matches the KPR-390 precedent exactly: the repo has **no live-Mongo/integration tier** — every engine suite runs on fake `Db` objects (callback, outage-queue, worker-pool, dispatcher precedents). Each cross-module seam here is pinned at its own boundary by a unit suite: the dispatcher↔scribe seam by call-count + arg assertions on an injected fake scribe in the conference suite; the scribe↔pool seam by captured `runRoleTurn` args and a real `MeetingWorkerPool` instance in the scribe suite (T12); the pool↔manager seam is **unchanged from KPR-390** (`buildWorkerAdapter` is reused verbatim, already pinned in `agent-manager.test.ts`). | n/a | n/a |
| **E2E** | **not-required** | Requires live Slack, a real `conf-*` meeting long enough to trigger the scribe, and real haiku spawns. Covered by operator rollout validation on a fleet instance post-deploy — the same posture KPR-387/388/389/390 all shipped under (unit + byte pins + live validation). See the Rollout note in Task G. | n/a | n/a |

### Spec T1–T12 → plan mapping

| Spec test | Where |
|---|---|
| T1 summary-mode byte pin (+ empty-tail row) | Task E — `dispatcher-conference.test.ts` |
| T2 high-water formula (a/b/c) — **R2** | Task E — `dispatcher-conference.test.ts` |
| T3 C6 pin unchanged (`:492`, `:770` unmodified) | Task E + Task G review gate (zero edits to existing cases) |
| T4 delta arm never reads summaries | Task E |
| T5 self-heal leg untouched (summary + `resumedSession:false` ⇒ set, not clear) | Task E |
| T6 cadence seam, round-level | Task E |
| T7 role-params + containment pin | Task D — `meeting-scribe.test.ts` |
| T8 gating table (7 rows) | Task D |
| T9 write + single-flight + stale-`updating` override | Task D |
| T10 no side effects (structural) | Task D |
| T11 synchronous-claim race | Task D |
| T12 capacity isolation | Task D (end-to-end through the scribe) + Task C (pool-level companion) |
| config resolver rows | Task A — `config.test.ts` |

### Critical flows

1. **Happy path (cadence):** human posts in a `conf-*` thread → `resolveConferenceAgents` fetches history → `noteActivity` fires once, fire-and-forget, before the responder fan-out → gates pass (not disabled, outside debounce, not in flight, under `scribeMaxConcurrent`, no fresh `updating`, ≥ 6 new messages, pool has capacity, base agent live) → `updating` set → `pool.runRoleTurn` with `coreServers: []` / haiku / maxTurns 4 / 120s / scribe charter → summary text returned → `updateOne` upsert (truncated at 2500, `coveredThroughTs` = max fed ts, `version` incremented, `updating` unset) → `lastRunAt` stamped.
2. **Happy path (anchor):** a fresh-session agent enters the meeting → `buildConferenceContext` full arm → `getSummary` hits → `formatSummaryContext(summary, tail)` injected instead of the raw transcript → `injectionMode: "summary"` rides in `meta.conferenceInjectionMode` → turn succeeds → `setMeetingMark` to `max(tail ∪ coveredThroughTs ∪ trigger)` (**R2**) → next turn is delta-eligible and never reads a summary again.
3. **Degradation paths (all silent, all to today's exact behavior):** no summary doc (E1) / scribe turn failed (E2) / stale summary (E3) / `getSummary` throws / `scribeEnabled: false` (E10) / TTL-aged doc ⇒ the plain full arm's byte-identical three lines.
4. **Concurrency:** one round's `Promise.all` fan-out plus overlapping rounds in one thread ⇒ the synchronous `inFlight` claim admits exactly one run (T11); a crash leftover across restart ⇒ the `updating` doc guard with `2 × scribeTimeoutMs` staleness override (T9); if both were defeated, last-write-wins with the later `coveredThroughTs` is strictly better (no corruption path).
5. **Capacity:** a live scribe never enters `liveWorkers`, so `dispatch()`'s `maxConcurrent` check is untouched (T12); the scribe yields to a saturated pool one-directionally via gate 5b.

### Regression surface (must stay green)

Baselines **measured at `dc2a685`** with `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test`:

| Suite | Baseline @ `dc2a685` | Allowed edits |
|---|---|---|
| `src/channels/dispatcher-conference.test.ts` | **34 passed** (28 `it` blocks; the extra 6 are `it.each` rows) | **Additions only.** Every existing case must pass **unedited** — T3 review gate. ⚠ The spec says "the existing 28 cases"; the true vitest count is **34**. Use 34 as the baseline. |
| `src/channels/dispatcher.test.ts` | **96 passed** | **ZERO** — no case may need editing (the anchor is conference-only) |
| `src/agents/agent-manager.test.ts` | **248 passed** | additions only (none expected); **whole-file runs only, never `-t`** |
| `src/workers/meeting-worker-pool.test.ts` | **29 passed** | additions only (Task C); every existing case unedited — C24 gate |
| `src/config.test.ts` | **29 passed** | additions only (Task A) |
| Combined 5-file baseline | **436 passed / 5 files** | — |
| Full sweep `npm run check` + `npm run check:bundle` (4 guards) | green | — |

### Commands (env stubs required on every test/check run)

```bash
export SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test
npx vitest run src/workers/                                # pool + scribe + dedup + mcp suites
npx vitest run src/workers/meeting-scribe.test.ts          # new suite
npx vitest run src/workers/meeting-worker-pool.test.ts     # expect: 29 + Task C additions
npx vitest run src/channels/dispatcher-conference.test.ts  # expect: 34 + Task E additions, zero existing edits
npx vitest run src/channels/dispatcher.test.ts             # expect: 96 passed, file untouched
npx vitest run src/agents/agent-manager.test.ts            # WHOLE FILE ONLY — never -t; expect 248
npx vitest run src/config.test.ts                          # expect: 29 + Task A additions
npm run check                                              # typecheck + lint + format + test
npm run check:bundle                                       # bundle + 4 guards
```

Husky note: `.husky/pre-commit` runs `npx lint-staged` — expect staged files to be rewritten (prettier/eslint `--fix`) at commit time; a shifted diff at commit is lint-staged, not a lost edit.

### Harness requirements

- **Mongo-backed collection testing (repo precedent = `src/workers/meeting-worker-pool.test.ts`'s `makeFakeClaims()`, itself the `callback-mcp-server.test.ts` fake-`Db` pattern):** the scribe suite needs a **name-keyed** fake `Db` (`db.collection(name)` returns a distinct in-memory collection per name), because T12 instantiates a real `MeetingWorkerPool` (`meeting_worker_claims`) alongside the scribe (`meeting_summaries`) against one `Db`. Reuse the same `matches()` query-matcher shape and the same operator surface, extended with `$inc` and `$unset` for the summary upsert. Deliberate duplication across test files — repo precedent keeps test harnesses file-local (`meeting-worker-pool.test.ts` does not import from any other suite).
- **Pool seam:** the scribe takes `pool` as an injected dep typed to a narrow interface (`{ runRoleTurn; hasCapacity }`) so T7/T8/T11 can pass a `vi.fn()` fake and T12 can pass the real pool. Same "capabilities not construction inputs" posture as `WorkerPoolManagerHooks`.
- **Detached-run flushing:** `noteActivity` returns `void` and detaches through `void this.run(...)`. Reuse `meeting-worker-pool.test.ts`'s `flush(times = 6)` helper (microtask spins + a `setTimeout(0)`) — never real sleeps.
- **Clock seams:** inject `now: () => Date` (constructor dep, `MeetingWorkerPoolDeps` precedent) for the debounce and the `2 × scribeTimeoutMs` staleness override, as a mutable `let clock` advanced by reassignment. `vi.useFakeTimers()` is not needed — there are no intervals in the scribe. ⚠ **Default the fake epoch to a realistic value** (`new Date(1_724_680_000_000)`), never near zero: a small epoch interacts with any arithmetic debounce sentinel to block the first-ever run on every thread, which would make gating tests pass vacuously. One case (D2b′) deliberately uses a low epoch to pin that the source has no such sentinel.
- **Dispatcher seam:** the conference suite injects a fake scribe via `dispatcher.setMeetingScribe({ noteActivity: vi.fn(), getSummary: vi.fn() } as any)` — same setter-injection shape as the existing `dispatcher.setSlackAdapter(mockSlackAdapter as any)` in that suite's `beforeEach`. Tests that must exercise today's behavior simply do not call the setter (undefined scribe ⇒ optional-chained no-op).
- **Byte pins:** follow the existing conference-suite convention — template literals with **flush-left continuation lines** inside backticks (the preamble pin breaks on leading whitespace) and minute-granularity `timestamp` offsets so `(N min ago)` labels stay deterministic without fake timers.

### Non-required rationale

Recorded in the group table above. Integration: no live-Mongo tier exists in this repo and each seam is boundary-pinned by a unit suite (KPR-390 precedent, verbatim). E2E: live-fleet validation on a real `conf-*` meeting is the operative check, per the KPR-387→390 precedent.

### Verification rules

- **Evidence before claims** (`dodi-dev:verify`): every "passes" statement in a commit message, the PR body, or the final report must be backed by a command actually run in the session, with its output.
- `agent-manager.test.ts` runs **whole-file only** — never `-t` (repo rule).
- **Negative-verify (Task F) runs before any completion claim.** Every expected-FAIL probe must be observed failing on the reverted code, then restored, then re-run to green; `git status --short` confirmed clean after the pass.
- **C24 gate** (Task G): `git diff dc2a685..HEAD -- src/workers/meeting-worker-pool.ts` must show **zero executable line changes inside `runWorkerTurn`, `spawnFetchWorker`, `dispatch`, `finishClaim`, `dispatchReentry`, `expireClaim`, `sweepExpired`, `sweepOnRestart`, `stop`, `abortForBoss`, `cancel`** — only the three sanctioned comment corrections and the two pure additions.
- **T3 gate** (Task G): `dispatcher-conference.test.ts`'s existing 34 cases pass with **no edits** to any of them.

---

## Tasks

Baseline check before starting:

```bash
cd /Users/mokie/github/hive-KPR-386 && git status --short   # expect: clean (or only .dodi/ manifest noise)
git log --oneline -1                                        # expect: dc2a685 or a later docs-only commit
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
  src/channels/dispatcher-conference.test.ts src/channels/dispatcher.test.ts \
  src/workers/meeting-worker-pool.test.ts src/config.test.ts src/agents/agent-manager.test.ts
# expect: Test Files 5 passed (5) / Tests 436 passed (436)
```

---

### Task A — Config: seven scribe keys + liberal-loader resolver

- [ ] **A1.** In `src/workers/worker-pool-config.ts`, append the seven scribe fields to `MeetingWorkersConfig` (after `enabled`):

```ts
  /** false ⇒ tools refuse with an honest notice; nothing else changes. */
  enabled: boolean;

  // --- KPR-409 scribe (Part B) ---
  /** The rollback lever for the prompt-shape change. false ⇒ no scribe runs
   *  AND no anchor branch (getSummary short-circuits) ⇒ byte-identical to
   *  pre-KPR-409. Deliberately separate from `enabled` so an operator can keep
   *  fetch-workers while reverting the injection change. */
  scribeEnabled: boolean;
  /** Claude-lane pin for the scribe — same posture as workerModel. */
  scribeModel: string;
  /** Minimum wall clock between two scribe runs on one thread. */
  scribeDebounceMs: number;
  /** Novelty floor: fewer new messages than this ⇒ abandon silently. */
  scribeMinNewMessages: number;
  /** Engine-wide live scribes. SEPARATE from maxConcurrent — scribes never
   *  consume a fetch-worker slot (spec §D3 capacity disposition). */
  scribeMaxConcurrent: number;
  /** Runaway bound, not a working budget — coreServers: [] means no MCP loop. */
  scribeMaxTurns: number;
  /** Scribe wall clock. No claimTtlMinutes interaction — the scribe creates no claim. */
  scribeTimeoutMs: number;
}
```

- [ ] **A2.** In the same file, append the seven defaults to `DEFAULT_MEETING_WORKERS_CONFIG`:

```ts
  enabled: true,
  scribeEnabled: true,
  scribeModel: "haiku",
  scribeDebounceMs: 90_000,
  scribeMinNewMessages: 6,
  scribeMaxConcurrent: 2,
  scribeMaxTurns: 4,
  scribeTimeoutMs: 120_000,
};
```

- [ ] **A3.** In `src/config.ts`, inside `resolveMeetingWorkersConfig`'s returned object (after `enabled:`), add the seven resolver lines using the existing `posNum` / string-trim / boolean idioms. ⚠ **No TTL clamp** — the scribe creates no claim, so `claimTtlMinutes`'s invariant is untouched; do not add a `scribeTimeoutMs` clamp:

```ts
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    // KPR-409 scribe keys — same liberal-loader idioms; no TTL clamp (the
    // scribe creates no claim, so claimTtlMinutes's invariant is untouched).
    scribeEnabled: typeof r.scribeEnabled === "boolean" ? r.scribeEnabled : d.scribeEnabled,
    scribeModel: typeof r.scribeModel === "string" && r.scribeModel.trim() ? r.scribeModel.trim() : d.scribeModel,
    scribeDebounceMs: posNum(r.scribeDebounceMs, d.scribeDebounceMs),
    scribeMinNewMessages: posNum(r.scribeMinNewMessages, d.scribeMinNewMessages),
    scribeMaxConcurrent: posNum(r.scribeMaxConcurrent, d.scribeMaxConcurrent),
    scribeMaxTurns: posNum(r.scribeMaxTurns, d.scribeMaxTurns),
    scribeTimeoutMs: posNum(r.scribeTimeoutMs, d.scribeTimeoutMs),
  };
```

- [ ] **A4.** In `src/config.test.ts`, extend the `describe("resolveMeetingWorkersConfig (KPR-390)")` block with a scribe-keys block (additions only — do not edit existing cases):

```ts
  it("KPR-409: scribe keys default when absent", () => {
    const c = resolveMeetingWorkersConfig({ workerModel: "opus" });
    expect(c.scribeEnabled).toBe(true);
    expect(c.scribeModel).toBe("haiku");
    expect(c.scribeDebounceMs).toBe(90_000);
    expect(c.scribeMinNewMessages).toBe(6);
    expect(c.scribeMaxConcurrent).toBe(2);
    expect(c.scribeMaxTurns).toBe(4);
    expect(c.scribeTimeoutMs).toBe(120_000);
  });

  it("KPR-409: garbage scribe values fall back to defaults", () => {
    const c = resolveMeetingWorkersConfig({
      scribeEnabled: "yes",
      scribeModel: "   ",
      scribeDebounceMs: -1,
      scribeMinNewMessages: "six",
      scribeMaxConcurrent: 0,
      scribeMaxTurns: null,
      scribeTimeoutMs: NaN,
    });
    expect(c).toMatchObject({
      scribeEnabled: true,
      scribeModel: "haiku",
      scribeDebounceMs: 90_000,
      scribeMinNewMessages: 6,
      scribeMaxConcurrent: 2,
      scribeMaxTurns: 4,
      scribeTimeoutMs: 120_000,
    });
  });

  it("KPR-409: valid scribe values pass through; scribeTimeoutMs never clamps claimTtlMinutes", () => {
    const c = resolveMeetingWorkersConfig({
      scribeEnabled: false,
      scribeModel: "  sonnet  ",
      scribeDebounceMs: 30_000,
      scribeMinNewMessages: 3,
      scribeMaxConcurrent: 5,
      scribeMaxTurns: 2,
      scribeTimeoutMs: 3_600_000, // 60m > claimTtlMinutes default 30m — must NOT clamp
    });
    expect(c.scribeEnabled).toBe(false);
    expect(c.scribeModel).toBe("sonnet");
    expect(c.scribeDebounceMs).toBe(30_000);
    expect(c.scribeMinNewMessages).toBe(3);
    expect(c.scribeMaxConcurrent).toBe(5);
    expect(c.scribeMaxTurns).toBe(2);
    expect(c.claimTtlMinutes).toBe(DEFAULT_MEETING_WORKERS_CONFIG.claimTtlMinutes);
  });
```

- [ ] **A5.** Verify:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/config.test.ts
# expect: 32 passed (29 baseline + 3)
npm run typecheck   # expect: clean
```

- [ ] **A6.** Commit: `feat(workers): meetingWorkers scribe config keys — seven liberal-loader entries (KPR-409)`

---

### Task B — Pool: `runRoleTurn` + `hasCapacity` (pure additions) + three sanctioned comment corrections

⚠ **C24 gate.** This task adds two public methods and edits **three comment blocks**. **No executable line inside `runWorkerTurn`, `spawnFetchWorker`, `dispatch`, `finishClaim`, `dispatchReentry`, or any sweep may change.** Do **not** refactor `runWorkerTurn` to delegate to `runRoleTurn` — the ~25 lines of duplication are deliberate (spec ⚠ Key Point 2). "Extract the common core" is the one refactor this ticket forbids.

- [ ] **B1.** Correct comment 1 — the file header (`src/workers/meeting-worker-pool.ts:12-13`). Replace:

```
 * The scribe role (Part B) is KPR-409 — it will reuse runWorkerTurn with its
 * own WorkerRoleParams and zero changes to this file's spawn path.
```

with:

```
 * The scribe role (KPR-409) is a SIBLING, not a reuse: runWorkerTurn is
 * claim-coupled end-to-end (workerTaskPrompt → finishClaim → dispatchReentry),
 * so a scribe on that path would post its summary into the meeting. The scribe
 * calls runRoleTurn() instead — same clone-and-run core, zero ledger contact,
 * zero re-entry — and this file's spawn path is unchanged.
```

- [ ] **B2.** Correct comment 2 — `WorkerRoleParams`'s doc comment (`~:115-119`). Replace the trailing clause:

```
 * Per-role spawn parameters (spec §A3 plan directive): the fetch-worker role
 * is Part A's only instantiation; KPR-409's scribe supplies its own object
 * (haiku pin, coreServers: [], scribe caps/charter) with zero changes here.
```

with:

```
 * Per-role spawn parameters (spec §A3 plan directive): the fetch-worker role
 * is Part A's only instantiation on the claim path; KPR-409's scribe supplies
 * its own object (haiku pin, coreServers: [], scribe caps/charter) to the
 * sibling runRoleTurn(), with zero changes to this type.
```

- [ ] **B3.** Correct comment 3 — `runWorkerTurn`'s own doc comment (`~:441-443`), now flatly wrong. Replace:

```
   * Role-parameterized worker turn (spec §A3 plan directive — KPR-409's
   * scribe reuses this with its own role object). Never throws; completion
```

with:

```
   * Role-parameterized worker turn (spec §A3 plan directive). CLAIM-COUPLED:
   * prompt from workerTaskPrompt(claim), context from workItemContextFromClaim,
   * completion through finishClaim → dispatchReentry. KPR-409's scribe does NOT
   * use this path (it would post into the meeting) — see runRoleTurn below.
   * Never throws; completion
```

- [ ] **B4.** Add `hasCapacity()` as a public method immediately after `stop()` (pure addition):

```ts
  /**
   * KPR-409: read-only capacity probe for out-of-band callers (the scribe's
   * gate 5b). One-directional BY DESIGN: the scribe yields when fetch-workers
   * are busy, and a scribe can never make the pool busy — scribes are never
   * registered in liveWorkers, so this count is fetch-workers only.
   */
  hasCapacity(): boolean {
    return this.liveWorkers.size < this.deps.config.maxConcurrent;
  }
```

- [ ] **B5.** Add `runRoleTurn()` as a public method immediately **after** `runWorkerTurn` (so the sibling relationship reads in file order) — a pure addition:

```ts
  /**
   * KPR-409: claim-free sibling of runWorkerTurn. Same clone-and-run core,
   * but it touches NO collection, fires NO dispatchReentry, and registers in
   * NO liveWorkers map — so a role turn can never post into a meeting and can
   * never consume a maxConcurrent slot a boss's worker_dispatch needs
   * (spec §D3 capacity disposition). Its bound and its abort registry belong
   * to the caller, wired through onAbortHandle.
   *
   * Deliberate duplication of runWorkerTurn's ~25-line skeleton: C24 freezes
   * Part A's spawn path and outranks DRY here. Do NOT extract a common core.
   *
   * Returns the raw outcome, or null when the manager hooks are not bound.
   * Never throws.
   */
  async runRoleTurn(args: {
    base: AgentConfig;
    role: WorkerRoleParams;
    prompt: string;
    /** The seven-required shape `workItemContextFromClaim` already returns —
     *  deliberately NOT the all-optional WorkerPoolTurnContext, so no cast and
     *  no agent-runner import are needed to satisfy adapter.runTurn. */
    workItemContext: {
      adapterId: string;
      channelId: string;
      channelKind: string;
      channelLabel: string;
      threadId: string;
      slackTs: string;
      slackThreadTs: string;
    };
    onAbortHandle?: (abort: () => void) => void;
  }): Promise<RoleTurnOutcome | null> {
    const startedAt = Date.now();
    if (!this.manager) return null;
    try {
      const workerConfig: AgentConfig = {
        ...args.base,
        model: args.role.model,
        coreServers: args.role.coreServers,
        delegateServers: [], // C19: role turns never nest delegates
        schedule: [], // paranoia — nothing reads it on this path, keep it inert
      };
      const adapter = this.manager.buildWorkerAdapter(workerConfig);
      args.onAbortHandle?.(() => adapter.abort());
      const result = await adapter.runTurn({
        prompt: args.prompt,
        sessionId: undefined, // sessionless — `sessions` untouched
        workItemContext: args.workItemContext,
        resourceLimits: {
          maxTurns: args.role.maxTurns,
          timeoutMs: args.role.timeoutMs,
          budgetUsd: args.base.budgetUsd, // operator's per-turn cost cap still binds
        },
        systemPromptOverride: args.role.charter, // total replacement — voice precedent
      });
      return {
        text: result.text,
        error: result.error,
        timedOut: result.timedOut,
        aborted: result.aborted,
        costUsd: result.costUsd,
        toolCalls: result.toolCalls,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return { error: String(err).slice(0, 2000), durationMs: Date.now() - startedAt };
    }
  }
```

- [ ] **B6.** Add the outcome type beside `LiveWorker` (before the class) — a pure addition:

```ts
/** KPR-409: raw outcome of a claim-free role turn (no ledger transition). */
export interface RoleTurnOutcome {
  text?: string;
  error?: string;
  timedOut?: boolean;
  aborted?: boolean;
  costUsd?: number;
  toolCalls?: number;
  durationMs: number;
}
```

⚠ **No new import is needed, and none should be added.** `meeting-worker-pool.ts` does **not** import `../agents/agent-runner.js` today (it imports only `AgentProviderAdapter` from `provider-adapters/types.js`), so an earlier draft's "extend the existing runner import line" was a false premise. Typing `runRoleTurn`'s `workItemContext` as the **seven-required inline shape** (B5) — the same literal type `workItemContextFromClaim` already declares at `:702-709` — satisfies `adapter.runTurn`'s `WorkItemContext` structurally with **no import and no type assertion**. Do not reach for `WorkerPoolTurnContext` here: its fields are all-optional, which is exactly what would have forced the cast.

- [ ] **B7.** Verify (no test changes yet — this must compile and leave the pool suite untouched):

```bash
npm run typecheck   # expect: clean
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/workers/meeting-worker-pool.test.ts
# expect: 29 passed (baseline unchanged — pure additions)
git diff -U0 dc2a685 -- src/workers/meeting-worker-pool.ts | grep -c "^-[^-]"
# expect: only the three comment blocks' removed lines (count them; no executable "-" line)
```

- [ ] **B8.** Commit: `feat(workers): pool runRoleTurn + hasCapacity — claim-free sibling for the scribe (KPR-409)`

---

### Task C — Pool suite: `runRoleTurn`/`hasCapacity` contract tests

Additions only to `src/workers/meeting-worker-pool.test.ts`. Do not edit any existing case (C24 gate).

- [ ] **C1.** Add a new `describe("MeetingWorkerPool — runRoleTurn (KPR-409 sibling)")` block using the existing `makeFixture()`:

```ts
describe("MeetingWorkerPool — runRoleTurn (KPR-409 sibling)", () => {
  const roleArgs = (over: AnyDoc = {}) => ({
    base: {
      id: "boss",
      name: "Jasper",
      model: "opus",
      coreServers: ["memory", "slack", "worker-pool"],
      delegateServers: ["crm-search"],
      schedule: [{ cron: "0 9 * * *" }],
      budgetUsd: 2.5,
    } as any,
    role: { model: "haiku", coreServers: [], maxTurns: 4, timeoutMs: 120_000, charter: "CHARTER" },
    prompt: "summarize this",
    workItemContext: meetingCtx as any,
    ...over,
  });

  it("clones the base config with the role's model/servers, delegateServers [] and schedule []", async () => {
    const f = makeFixture();
    await f.pool.runRoleTurn(roleArgs());
    expect(f.builtConfigs).toHaveLength(1);
    expect(f.builtConfigs[0]).toMatchObject({
      id: "boss",
      model: "haiku",
      coreServers: [],
      delegateServers: [],
      schedule: [],
      budgetUsd: 2.5,
    });
  });

  it("passes the charter as systemPromptOverride, runs sessionless, and binds the base budget", async () => {
    const f = makeFixture();
    await f.pool.runRoleTurn(roleArgs());
    const req = f.runTurn.mock.calls[0][0];
    expect(req.systemPromptOverride).toBe("CHARTER");
    expect(req.sessionId).toBeUndefined();
    expect(req.resourceLimits).toEqual({ maxTurns: 4, timeoutMs: 120_000, budgetUsd: 2.5 });
  });

  // ⚠ Two cases, because at maxConcurrent: 4 the assertion
  // `hasCapacity() === true` is INSENSITIVE to the bug: one wrongly-registered
  // role turn gives liveWorkers.size 1, and `1 < 4` is still true. Only the
  // dispatch-admission count discriminates there. The maxConcurrent: 1 case is
  // the one where hasCapacity() itself genuinely flips.
  it("T12 (pool half, maxConcurrent 1): a live role turn leaves hasCapacity() true", async () => {
    const f = makeFixture({ config: { maxConcurrent: 1 }, runTurnImpl: () => new Promise(() => {}) });
    void f.pool.runRoleTurn(roleArgs());
    await flush();
    // Discriminating: if runRoleTurn registered in liveWorkers, size would be
    // 1 and `1 < 1` would make this false.
    expect(f.pool.hasCapacity()).toBe(true);
  });

  it("T12 (pool half, maxConcurrent 4): a live role turn consumes no dispatch slot", async () => {
    // ⚠ perMeetingMax raised: the default is 3, and four dispatches on ONE
    // thread would be refused by the per-meeting cap before the engine-wide
    // cap is ever reached — which would make this test pass for the wrong
    // reason. maxConcurrent stays at its default 4 (the value under test).
    const f = makeFixture({
      config: { maxConcurrent: 4, perMeetingMax: 10 },
      runTurnImpl: () => new Promise(() => {}),
    });
    void f.pool.runRoleTurn(roleArgs());
    await flush();
    const results = [];
    for (const t of ["a", "b", "c", "d"]) results.push(await f.pool.dispatch(dispatchReq(t)));
    // Discriminating: with the role turn wrongly in liveWorkers, the 4th
    // dispatch sees size 4 >= 4 and is refused.
    expect(results.every((r) => r.startsWith("Worker dispatched (claim "))).toBe(true);
    expect(results.some((r) => r.includes("Worker pool saturated"))).toBe(false);
    expect(f.hooks.buildWorkerAdapter).toHaveBeenCalledTimes(5); // 1 role + 4 fetch
    expect(f.pool.hasCapacity()).toBe(false); // now genuinely full, on fetch workers alone
  });

  it("touches no claim ledger and fires no re-entry", async () => {
    const f = makeFixture();
    await f.pool.runRoleTurn(roleArgs());
    expect(f.claims.docs).toHaveLength(0);
    expect(f.onDispatch).not.toHaveBeenCalled();
  });

  it("invokes onAbortHandle synchronously with a working abort, and never throws on adapter failure", async () => {
    const f = makeFixture({ runTurnImpl: async () => { throw new Error("boom"); } });
    let handle: (() => void) | undefined;
    const out = await f.pool.runRoleTurn(roleArgs({ onAbortHandle: (a: () => void) => { handle = a; } }));
    expect(handle).toBeTypeOf("function");
    handle!();
    expect(f.abortSpy).toHaveBeenCalled();
    expect(out?.error).toContain("boom");
  });

  it("returns null when manager hooks are not bound", async () => {
    const claims = makeFakeClaims();
    const pool = new MeetingWorkerPool({
      db: { collection: () => claims } as any,
      registry: { get: () => undefined } as any,
      onDispatch: vi.fn(),
      config: { ...DEFAULT_MEETING_WORKERS_CONFIG },
    });
    expect(await pool.runRoleTurn(roleArgs())).toBeNull();
  });
});
```

- [ ] **C2.** Verify:

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/workers/meeting-worker-pool.test.ts
# expect: 35 passed (29 baseline + 6), zero edits to existing cases
```

- [ ] **C3.** Commit: `test(workers): runRoleTurn clone/containment/capacity-isolation contract (KPR-409)`

---

### Task D — `MeetingScribe` service + its suite

- [ ] **D1.** Create `src/workers/meeting-scribe.ts`.

⚠ **Load-bearing orderings, do not rearrange:**
- Gates 1, 3, 2a, 5a are **synchronous reads above the `inFlight.add`** — nothing between the `has` check and the `add` may yield. Moving the claim below an `await` reintroduces the race T11 pins.
- `inFlight.delete` and `abortHandles.delete` live in **one shared `finally`**. They are two views of one lifecycle; clearing one without the other leaks handles and leaves `stop()` aborting completed adapters.

```ts
/**
 * KPR-409: the meeting scribe — a cheap, tool-less pool worker that maintains
 * one running summary per meeting thread in `meeting_summaries`, so a
 * fresh-session entrant gets `summary + tail` instead of the raw transcript.
 *
 * NOT a meeting participant: never in a roster, never a classifier candidate,
 * never a conference dispatch, no posting surface. Its turn runs through
 * MeetingWorkerPool.runRoleTurn — sessionless, lock-exempt, breaker-invisible,
 * not spawnBudget-accounted, and (unlike a fetch-worker) never registered in
 * the pool's liveWorkers, so it can never starve a boss's worker_dispatch.
 *
 * Never a correctness dependency: every failure, gate, and outage falls
 * through to today's byte-identical full-transcript injection.
 */
import type { Collection, Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { MeetingWorkersConfig } from "./worker-pool-config.js";
import type { RoleTurnOutcome, WorkerRoleParams } from "./meeting-worker-pool.js";

const log = createLogger("meeting-scribe");

/** Hard truncation on write. Deliberately ABOVE the charter's 2000-char soft
 *  instruction: the gap absorbs a small model's normal overshoot so the cap
 *  only ever fires on a genuinely runaway summary. Do NOT align the numbers. */
export const SUMMARY_TEXT_CAP = 2500;
const SUMMARIES_TTL_SECONDS = 7 * 86_400;

/** Structurally assignable from SlackAdapter's ThreadMessage — declared
 *  locally so src/workers/ stays free of a src/channels/ dependency (the
 *  worker-pool-config cycle-safety posture). */
export interface ScribeMessage {
  author: string;
  text: string;
  timestamp: Date;
  ts: string;
}

export interface MeetingSummaryDoc {
  _id: string; // threadId
  summaryText: string;
  coveredThroughTs: string;
  version: number;
  updatedAt: Date;
  updating?: { startedAt: Date };
}

/** What the dispatcher's anchor reads. */
export interface MeetingSummary {
  summaryText: string;
  coveredThroughTs: string;
}

/** Narrow pool surface — capabilities only (WorkerPoolManagerHooks posture).
 *  Mirrors runRoleTurn's seven-required workItemContext shape exactly. */
export interface ScribePoolSurface {
  runRoleTurn(args: {
    base: AgentConfig;
    role: WorkerRoleParams;
    prompt: string;
    workItemContext: {
      adapterId: string;
      channelId: string;
      channelKind: string;
      channelLabel: string;
      threadId: string;
      slackTs: string;
      slackThreadTs: string;
    };
    onAbortHandle?: (abort: () => void) => void;
  }): Promise<RoleTurnOutcome | null>;
  hasCapacity(): boolean;
}

export interface ScribeRegistry {
  get(id: string): AgentConfig | undefined;
}

export interface MeetingScribeDeps {
  db: Db;
  registry: ScribeRegistry;
  pool: ScribePoolSurface;
  config: MeetingWorkersConfig;
  now?: () => Date;
}

export interface NoteActivityArgs {
  threadId: string;
  history: ScribeMessage[];
  channelLabel: string;
  roster: Array<{ name: string }>;
  /** Config donor — any roster member of the triggering round. Re-resolved
   *  live at run time; budgetUsd therefore varies with the trigger (accepted). */
  baseAgentId: string;
  /** Real turn context from the triggering WorkItem — inert under
   *  coreServers: [] but honest, and correct if that ever widens. */
  source: {
    adapterId: string;
    channelId: string;
    channelKind: string;
    slackTs: string;
    slackThreadTs: string;
  };
}

export class MeetingScribe {
  private readonly summaries: Collection<MeetingSummaryDoc>;
  private readonly inFlight = new Set<string>();
  private readonly abortHandles = new Map<string, () => void>();
  private readonly lastRunAt = new Map<string, number>();
  private readonly now: () => Date;

  constructor(private readonly deps: MeetingScribeDeps) {
    this.summaries = deps.db.collection<MeetingSummaryDoc>("meeting_summaries");
    this.now = deps.now ?? (() => new Date());
  }

  /** TTL housekeeping only — no correctness role, so index.ts .catch-logs this
   *  rather than making it boot-fatal (deliberate divergence from the claim
   *  ledger's C27 posture; spec §Integration points issue 5). */
  async ensureIndexes(): Promise<void> {
    await this.summaries.createIndex({ updatedAt: 1 }, { expireAfterSeconds: SUMMARIES_TTL_SECONDS });
  }

  /** Fail-soft read for the dispatcher's full-arm anchor. Never throws. */
  async getSummary(threadId: string): Promise<MeetingSummary | undefined> {
    const cfg = this.deps.config;
    if (!cfg.enabled || !cfg.scribeEnabled) return undefined; // E10 — reverts the anchor immediately
    try {
      const doc = await this.summaries.findOne({ _id: threadId });
      // A doc carrying only { _id, updating } is a failed-first-run stub, not
      // a summary — both fields must be present or the anchor must not fire.
      if (!doc?.summaryText || !doc.coveredThroughTs) return undefined;
      return { summaryText: doc.summaryText, coveredThroughTs: doc.coveredThroughTs };
    } catch (err) {
      log.warn("Summary read failed — falling back to full injection", { error: String(err) });
      return undefined;
    }
  }

  /**
   * Cadence trigger. Returns void synchronously and NEVER throws — the two
   * conference seams are fire-and-forget, and removing them must restore
   * byte-identical behavior.
   *
   * ⚠ Gates 1/3/2a/5a are synchronous and sit ABOVE the claim; the claim is
   * taken before the first await (a round's Promise.all fan-out and
   * overlapping rounds both land in one tick). Do not reorder.
   */
  noteActivity(args: NoteActivityArgs): void {
    const cfg = this.deps.config;
    if (!cfg.enabled || !cfg.scribeEnabled) return; // gate 1
    const { threadId } = args;
    // ⚠ Gate 3 must distinguish "never run" from "ran too recently". A `?? 0`
    // sentinel conflates them: under any clock whose epoch is below
    // scribeDebounceMs (a fake `now` seam, or a genuinely fresh process on a
    // mocked clock), `now - 0 < 90_000` blocks the FIRST EVER run on every
    // thread — the scribe would silently never start, and every "no run"
    // gating test would pass for the wrong reason. Use an explicit
    // has-run-before check, never an arithmetic sentinel.
    const lastRun = this.lastRunAt.get(threadId);
    if (lastRun !== undefined && this.now().getTime() - lastRun < cfg.scribeDebounceMs) return; // gate 3
    if (this.inFlight.has(threadId)) return; // gate 2a — synchronous
    if (this.inFlight.size >= cfg.scribeMaxConcurrent) return; // gate 5a — synchronous
    this.inFlight.add(threadId); // claimed BEFORE any await
    void this.run(args)
      .catch((err) => log.warn("Scribe run failed — summary unchanged", { error: String(err) }))
      .finally(() => {
        // ⚠ ONE shared lifecycle: both maps are keyed on threadId and must be
        // released together on every path incl. throw and abort. Splitting
        // them leaks a handle per thread and leaves stop() aborting adapters
        // that completed long ago.
        this.inFlight.delete(threadId);
        this.abortHandles.delete(threadId);
      });
  }

  /** Aborts every live scribe run. Scribes are not in the pool's liveWorkers,
   *  so pool.stop()/abortForBoss deliberately do not reach them (spec §D3/E5). */
  stop(): void {
    for (const [threadId, abort] of this.abortHandles) {
      try {
        abort();
      } catch (err) {
        log.warn("Scribe abort threw during stop — contained", { threadId, error: String(err) });
      }
    }
  }

  private async run(args: NoteActivityArgs): Promise<void> {
    const cfg = this.deps.config;
    const { threadId } = args;

    const doc = await this.summaries.findOne({ _id: threadId }).catch((err) => {
      log.warn("Scribe summary read failed — abandoning this trigger", { error: String(err) });
      return null;
    });

    // Gate 2b — crash-leftover guard across restarts (the in-memory set is
    // empty after a restart; a stale `updating` older than 2x the wall clock
    // is overridden).
    const updatingAt = doc?.updating?.startedAt?.getTime();
    if (updatingAt !== undefined && this.now().getTime() - updatingAt < 2 * cfg.scribeTimeoutMs) return;

    // Gate 4 — novelty. First run: coveredThroughTs absent ⇒ every message
    // counts, so a meeting summarizes once it is scribeMinNewMessages deep.
    const coveredNum = parseFloat(doc?.coveredThroughTs ?? "0");
    const newMessages = args.history.filter((m) => parseFloat(m.ts) > coveredNum);
    if (newMessages.length < cfg.scribeMinNewMessages) return;

    // Gate 5b — one-directional yield: a busy pool means the engine is busy.
    if (!this.deps.pool.hasCapacity()) return;

    // E8 — live registry re-check (mirrors spawnFetchWorker's re-check).
    const base = this.deps.registry.get(args.baseAgentId);
    if (!base || base.disabled) return;

    const startedAt = this.now();
    await this.summaries
      .updateOne(
        { _id: threadId },
        { $set: { updating: { startedAt }, updatedAt: startedAt } },
        { upsert: true },
      )
      .catch((err) => log.warn("Scribe updating-flag write failed — proceeding", { error: String(err) }));

    try {
      const role: WorkerRoleParams = {
        model: cfg.scribeModel,
        coreServers: [], // C22 — the transcript is in the prompt; the scribe needs nothing
        maxTurns: cfg.scribeMaxTurns,
        timeoutMs: cfg.scribeTimeoutMs,
        charter: scribeCharter(args.channelLabel),
      };
      const outcome = await this.deps.pool.runRoleTurn({
        base,
        role,
        prompt: scribeTurnPrompt(args.channelLabel, args.roster, doc?.summaryText, newMessages, startedAt),
        workItemContext: {
          adapterId: args.source.adapterId,
          channelId: args.source.channelId,
          channelKind: args.source.channelKind,
          channelLabel: args.channelLabel,
          threadId,
          slackTs: args.source.slackTs,
          slackThreadTs: args.source.slackThreadTs,
        },
        onAbortHandle: (abort) => this.abortHandles.set(threadId, abort),
      });

      const text = outcome?.text?.trim();
      if (!outcome || outcome.error || outcome.timedOut || outcome.aborted || !text) {
        log.info("Scribe turn produced no summary — prior summary stands", {
          threadId,
          error: outcome?.error?.slice(0, 120),
          timedOut: outcome?.timedOut,
          aborted: outcome?.aborted,
        });
        return;
      }

      const coveredThroughTs = newMessages.reduce(
        (best, m) => (parseFloat(m.ts) > parseFloat(best) ? m.ts : best),
        doc?.coveredThroughTs ?? newMessages[0].ts,
      );
      await this.summaries.updateOne(
        { _id: threadId },
        {
          $set: {
            summaryText: text.slice(0, SUMMARY_TEXT_CAP),
            coveredThroughTs,
            updatedAt: this.now(),
          },
          $inc: { version: 1 },
          $unset: { updating: "" },
        },
        { upsert: true },
      );
      log.info("Scribe summary updated", {
        threadId,
        covered: newMessages.length,
        costUsd: outcome.costUsd,
        durationMs: outcome.durationMs,
      });
    } finally {
      // Clear `updating` on EVERY path (success already unset it; this covers
      // failure/timeout/abort/throw) and stamp the debounce for any attempted
      // turn — a persistently failing scribe must not re-run every round.
      await this.summaries
        .updateOne({ _id: threadId }, { $unset: { updating: "" }, $set: { updatedAt: this.now() } })
        .catch((err) => log.warn("Scribe updating-flag clear failed", { error: String(err) }));
      this.lastRunAt.set(threadId, this.now().getTime());
    }
  }
}

/** Exported for a byte pin. Total systemPromptOverride replacement — no soul,
 *  no constitution (voice/fetch-worker precedent). ⚠ The 2000 here is a SOFT
 *  instruction; SUMMARY_TEXT_CAP (2500) is the hard write-side truncation. The
 *  500-char headroom is deliberate — do not align them. */
export function scribeCharter(channelLabel: string): string {
  return `You are the scribe for a meeting in #${channelLabel}. You maintain one running
summary of the meeting for colleagues who join late.

Rewrite the summary below to incorporate the new messages. Return the COMPLETE
replacement summary — not a diff, not a preface, not a commentary.

Cover: decisions made, open questions, and each participant's current position.
Drop resolved chatter. Stay under 2000 characters.

You have no tools and no messaging surface. Your final message IS the summary.`;
}

/** Exported for a byte pin. Reuses the conference body shape
 *  (`Author (n min ago): text`) so the scribe reads the same transcript
 *  format the meeting agents do. */
export function scribeTurnPrompt(
  channelLabel: string,
  roster: Array<{ name: string }>,
  priorSummary: string | undefined,
  newMessages: ScribeMessage[],
  at: Date,
): string {
  const participants = roster.map((r) => r.name).join(", ");
  const body = newMessages
    .map((m) => `${m.author} (${formatTimeAgo(m.timestamp, at)}): ${m.text}`)
    .join("\n");
  return (
    `Meeting: #${channelLabel}\n` +
    `Participants: ${participants}\n\n` +
    `CURRENT SUMMARY:\n${priorSummary ?? "(none yet — this is the first summary of this meeting.)"}\n\n` +
    `NEW MESSAGES:\n${body}`
  );
}

function formatTimeAgo(timestamp: Date, at: Date): string {
  const seconds = Math.floor((at.getTime() - timestamp.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
```

- [ ] **D2.** Create `src/workers/meeting-scribe.test.ts` with a **name-keyed** fake `Db`. Reuse `meeting-worker-pool.test.ts`'s `matches()`/`flush()` shapes, extended with `$inc` and `$unset`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("./worker-claim-dedup.js", () => ({
  classifyClaimDedup: vi.fn(async () => ({ duplicateOfClaimId: null, costUsd: 0 })),
}));

import { MeetingScribe, scribeCharter, SUMMARY_TEXT_CAP, type ScribeMessage } from "./meeting-scribe.js";
import { MeetingWorkerPool } from "./meeting-worker-pool.js";
import { DEFAULT_MEETING_WORKERS_CONFIG } from "./worker-pool-config.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- fake Mongo Db/collection
   harness (meeting-worker-pool.test.ts precedent): structurally simulated. */
type AnyDoc = Record<string, any>;
```

Required helpers: `makeFakeCollection()` (supporting `createIndex` recorder, `findOne`, `updateOne` with `$set`/`$inc`/`$unset` + `upsert`, plus the claim-ledger operators when the pool shares the Db), `makeFakeDb()` returning a per-name collection map, `makeScribe(overrides)` (config, registry agents, fake `pool` with `runRoleTurn: vi.fn()` + `hasCapacity: vi.fn(() => true)`, injectable `now`), `makeArgs(overrides)` producing a `NoteActivityArgs` with a 6-message history, and `flush()`.

Cases (spec T7–T12 + the additions from the Testing Contract):

- [ ] **D2a — T7 role-params + containment pin.** Captured `runRoleTurn` args: `role.model === "haiku"` (from `scribeModel`), **`role.coreServers` deep-equals `[]`**, `role.maxTurns === 4`, `role.timeoutMs === 120_000`, `role.charter === scribeCharter("conf-tahoe")` **byte-exact** (assert against the literal string, not the function, for at least the first and last lines — the charter is a pinned contract), `base` is the resolved registry config, and `workItemContext` carries all seven fields from `args.source` + `channelLabel` + `threadId`. **Also pin `prompt` byte-exact** against `scribeTurnPrompt(channelLabel, roster, priorSummary, newMessages, at)` — the function is exported "for a byte pin" and that claim must be backed by an assertion: assert the header lines (`Meeting: #conf-tahoe`, `Participants: …`), the `CURRENT SUMMARY:` block including the `(none yet — …)` sentinel on a first run **and** the prior text on a subsequent run, and the `NEW MESSAGES:` body's `Author (n min ago): text` shape.
- [ ] **D2b — T8 gating table (7 rows, `it.each`).** `enabled: false` ⇒ no run; `scribeEnabled: false` ⇒ no run; already in flight (a first call whose `runRoleTurn` never resolves, then a second call) ⇒ no second run; `inFlight.size >= scribeMaxConcurrent` (two live threads at `scribeMaxConcurrent: 2`, third thread) ⇒ no run; within `scribeDebounceMs` of `lastRunAt` ⇒ no run; `newMessages.length < scribeMinNewMessages` ⇒ no run; `pool.hasCapacity()` false ⇒ no run; base agent missing **or** `disabled: true` ⇒ no run. Every row asserts `runRoleTurn` not called **and** no write to `meeting_summaries` beyond (at most) the `updating` flag.

  ⚠ **Three rows (already-in-flight, `scribeMaxConcurrent` reached, within-debounce) can only be constructed by first performing a real run**, so "assert `runRoleTurn` called exactly once" is wrong for them — the count includes that prior real call. For those three: `mockClear()` on `runRoleTurn` immediately after the seeding run completes, before the gated call under test, so the row's assertion reads "not called" cleanly like the other four. The in-flight and within-debounce rows additionally need the injected clock advanced past `scribeDebounceMs` as part of constructing the seeded state — resolving the seeding run stamps `lastRunAt`, so gate 3 would otherwise block the row's own setup.

  ⚠ **Every row MUST carry a paired positive control in the same test:** after asserting the gate blocked the run, lift exactly that gate (flip the flag, resolve the in-flight run, advance the injected clock past `scribeDebounceMs`, add the missing messages, make `hasCapacity()` true, restore the agent) and assert `runRoleTurn` is then called **exactly once** with the same args. Without the control, a harness that never runs at all — the failure mode issue 2's sentinel fix closes at the source — makes all seven rows pass vacuously. The control is what turns "zero calls" from an ambiguous observation into a discriminating one.

  ⚠ **Harness clock:** `now` is injected as a mutable `let clock = new Date(1_724_680_000_000)` with `now: () => clock` (a realistic epoch, orders of magnitude above `scribeDebounceMs` and `2 × scribeTimeoutMs`), advanced by reassignment. This is belt-and-braces on top of the `lastRun !== undefined` source fix, not a substitute for it — do not implement one without the other.

- [ ] **D2b′ — gate-3 sentinel pin (⚠ the assertion that discriminates the sentinel bug).** A separate case constructed with a **deliberately low epoch**: `now: () => new Date(50_000)` (below the 90 000 ms `scribeDebounceMs`), a thread with no prior `lastRunAt` entry, and otherwise-passing gates ⇒ `runRoleTurn` called **exactly once**. Under the `?? 0` sentinel this evaluates `50_000 - 0 < 90_000` and blocks the first-ever run, so the case fails with zero calls; under `lastRun !== undefined` it passes. This is the one test that fails on the sentinel regardless of what the rest of the harness's epoch is set to. (Negative-verified in Task F/NV8b.)
- [ ] **D2c — T9 write + single-flight.** Success ⇒ one upsert with `summaryText` present, `coveredThroughTs` equal to the max ts of the messages fed in, `version` incremented (`$inc`), `updating` unset. A >2500-char return ⇒ `summaryText.length === SUMMARY_TEXT_CAP`. Failure / `timedOut` / `aborted` / empty text ⇒ **no** `summaryText` write, `updating` cleared, prior summary intact. A seeded `updating.startedAt` **fresher** than `2 × scribeTimeoutMs` ⇒ abandoned; one **older** ⇒ overridden and the run proceeds.
- [ ] **D2d — T10 no side effects (structural).** A scribe run performs zero writes to `meeting_worker_claims` (assert that collection's doc array stays empty), zero `onDispatch` calls on the shared pool, and zero `sessions` access (the fake Db records `collection()` names — assert only `meeting_summaries` and `meeting_worker_claims` are ever requested).
- [ ] **D2e — T11 synchronous-claim race.** Five `noteActivity(args)` calls issued back-to-back in one tick against a thread with no prior summary, with `runRoleTurn` returning a never-resolving promise ⇒ `runRoleTurn` called **exactly once**. (Negative-verified in Task F/NV5.)
- [ ] **D2f — T12 capacity isolation (end-to-end).** Build a real `MeetingWorkerPool` on the shared fake Db with a bound fake manager whose `runTurn` never resolves; construct the scribe with that pool; start one scribe run via `noteActivity` + `flush()`.

  ⚠ **The observable is dispatch admission, not `hasCapacity()`.** At `maxConcurrent: 4`, a wrongly-registered scribe gives `liveWorkers.size === 1`, and `1 < 4` is still `true` — so `expect(pool.hasCapacity()).toBe(true)` is **insensitive to the bug it is supposed to guard**, the same wrong-reason-pass trap the `perMeetingMax` note closes. Assert instead:
  - **Config `{ maxConcurrent: 4, perMeetingMax: 10 }`** (the 3-default would refuse the fourth dispatch on the per-meeting cap first): four distinct `pool.dispatch(...)` calls **all return the "Worker dispatched (claim …" string**, none contains "Worker pool saturated", and `buildWorkerAdapter` was called **5** times. With the scribe in `liveWorkers`, the fourth dispatch is refused and the count is 4 — the assertion fails.
  - **Plus a `{ maxConcurrent: 1 }` variant**, the only configuration where `hasCapacity()` itself discriminates: one live scribe ⇒ `hasCapacity()` **true** (registration would make it `1 < 1` = false).

  (Negative-verified in Task F/NV6.)
- [ ] **D2g — `getSummary` guards.** Absent doc ⇒ `undefined`. Stub doc (`{_id, updating, updatedAt}` only, no `summaryText`) ⇒ `undefined`. `scribeEnabled: false` with a complete doc present ⇒ `undefined` **and `findOne` never called** (short-circuit before the read — E10). `findOne` throwing ⇒ `undefined`, no throw escapes.
- [ ] **D2h — `ensureIndexes` pin.** The recorded `createIndex` call is exactly `[{ updatedAt: 1 }, { expireAfterSeconds: 604800 }]`, and a rejecting `createIndex` makes `ensureIndexes()` reject (index.ts owns the `.catch` — the method itself does not swallow).
- [ ] **D2i — `stop()`.** Two live runs on different threads ⇒ both aborts invoked; an abort that throws is contained and the other still fires; a settled run's handle is gone (call `stop()` after a completed run ⇒ zero aborts).

- [ ] **D3.** Verify:

```bash
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/workers/
# expect: all worker suites green; meeting-scribe.test.ts covering T7-T12 + guards
```

- [ ] **D4.** Commit: `feat(workers): meeting scribe — running summary, synchronous single-flight, capacity-isolated (KPR-409)`

---

### Task E — Dispatcher: `injectionMode` widening, summary anchor, cadence seams + conference-suite tests

⚠ **Three conference-code hunks total.** The full-arm anchor is the **C26-sanctioned** one; the two `noteActivity` calls are **R1, requested not claimed**. Both `noteActivity` hunks must remain additive, fire-and-forget, and behavior-neutral — removing them must restore byte-identical behavior.

⚠ **R1 rollback, stated as concretely as R2's "delete one line":** if the coherence reviewer rejects R1, delete the two `noteActivity` blocks (E6 and E7) and add one call from `buildConferenceContext`'s full arm instead; rewrite T6's call-count rows (round-0 exactly-one becomes one-per-full-arm-agent, and the classifier-selects-nobody row is deleted — that path no longer fires); accept the summary freeze once every participant converts to delta, measure it through the `injectionMode: "summary"` telemetry, and file the follow-up. Nothing else in this ticket changes — the anchor, the scribe module, storage, and config are all R1-independent.

- [ ] **E1.** Widen `injectionMode` at the four sites (one commit of its own — it is meaningless alone but reviewable as a unit):
  - `src/channels/dispatcher.ts:73` — `injectionMode?: "full" | "delta" | "summary";` on `ResolvedAgent`
  - `src/channels/dispatcher.ts:1344` — `buildConferenceContext`'s return type: `injectionMode: "full" | "delta" | "summary"`
  - `src/agents/agent-manager.ts:199-201` — `conferenceInjectionModeOf`:
    ```ts
    function conferenceInjectionModeOf(item: WorkItem): "full" | "delta" | "summary" | undefined {
      const v = item.meta?.conferenceInjectionMode;
      return v === "full" || v === "delta" || v === "summary" ? v : undefined;
    }
    ```
  - `src/agents/turn-telemetry.ts:19` and `:42` — both `injectionMode?: "full" | "delta" | "summary";`

  ⚠ **Do NOT touch `dispatcher.ts:1100`.** The self-heal leg is `=== "delta"`-exclusive and stays correct unmodified: a summary turn is already a fresh session, so there is no continuity to heal. T5 pins this.

- [ ] **E2.** Commit: `feat(telemetry): widen conference injectionMode to include "summary" (KPR-409)`

- [ ] **E3.** Add the scribe setter to `Dispatcher` (beside `setSlackAdapter`, ~:170) and the field (beside `private slackAdapter?`, ~:116):

```ts
  /** KPR-409: optional running-summary source for the full-arm anchor.
   *  Absent ⇒ every conference path behaves exactly as pre-KPR-409. */
  private meetingScribe?: MeetingScribe;

  setMeetingScribe(scribe: MeetingScribe): void {
    this.meetingScribe = scribe;
  }
```

with `import type { MeetingScribe } from "../workers/meeting-scribe.js";` beside the existing type imports.

- [ ] **E4.** Add `formatSummaryContext` as a private method **immediately after `formatDeltaContext`** (`~:1385`):

```ts
  /**
   * KPR-409: summary-mode context — running summary plus the messages that
   * postdate it. Marker-collision checked (C3/C10): neither marker is
   * "[New message]:" (the terminal slot) nor "[New messages since your last
   * turn:]" (the delta header), and neither starts with "[New".
   * The tail block is omitted entirely when `tail` is empty.
   */
  private formatSummaryContext(
    summaryText: string,
    tail: ThreadMessage[],
    channelName: string,
    roster: RosterMember[],
  ): string {
    const participantNames = roster.map((r) => r.name).join(", ");
    const header = `[Meeting thread in #${channelName} — participants: ${participantNames}]`;
    const base = `${header}\n[Running summary of the meeting so far:]\n\n${summaryText}`;
    if (tail.length === 0) return base;
    const formatted = tail
      .map((m) => `${m.author} (${this.formatTimeAgo(m.timestamp)}): ${m.text}`)
      .join("\n");
    return `${base}\n\n[Messages since the summary:]\n\n${formatted}`;
  }
```

- [ ] **E5.** Rewire `buildConferenceContext`'s **full arm only** (`:1347-1353`). The delta arm below it and the eligibility predicate itself are untouched:

```ts
    if (!ref?.sessionId || !ref.meetingLastSeenTs || ref.provider !== provider) {
      // KPR-409 (C13-sanctioned anchor): a running summary replaces the raw
      // transcript for fresh-session entrants. Fail-soft by construction —
      // getSummary never throws and returns undefined when the scribe is
      // absent, disabled, or has nothing yet, in which case the three lines
      // below are byte-identical to pre-KPR-409 (C6 pin).
      const summary = await this.meetingScribe?.getSummary(threadId);
      if (summary) {
        const coveredNum = parseFloat(summary.coveredThroughTs);
        // Same 100-cap as truncateHistory's tail; no first-5 pin — the summary
        // holds the thread opening (the delta arm's own reasoning).
        const tail = history.filter((m) => parseFloat(m.ts) > coveredNum).slice(-100);
        return {
          threadContext: this.formatSummaryContext(summary.summaryText, tail, channelName, roster),
          injectionMode: "summary",
          injectionHighWaterTs: maxSlackTs([
            ...tail.map((m) => m.ts),
            // ⚠ R2 (requested relaxation, spec §D4): REQUIRED, not cosmetic.
            // Without it an empty tail at round 1 yields undefined, setMeetingMark
            // is skipped, and the agent never converts to delta. If the coherence
            // reviewer rules F1 instead, the fix is to delete this one line (and
            // invert T2(b)/T5) — see the plan header.
            summary.coveredThroughTs,
            roundZeroTriggerTs,
          ]),
        };
      }
      return {
        threadContext: this.formatThreadContext(history, channelName, roster),
        injectionMode: "full",
        injectionHighWaterTs: maxSlackTs([...this.truncateHistory(history).map((m) => m.ts), roundZeroTriggerTs]),
      };
    }
```

- [ ] **E6. R1 hunk 1** — cadence seam in `resolveConferenceAgents`, placed **after the `if (this.slackAdapter) { … }` history fetch block (`~:1246`) and before `classifyMeetingMessage`** — i.e. before the responder fan-out, so it fires even when the classifier selects nobody (E12):

```ts
    // KPR-409 (R1 — requested C26 relaxation): round-level cadence trigger.
    // Fires once per round-0 pass INCLUDING passes where the classifier
    // selects nobody. Fire-and-forget: noteActivity returns void, never
    // throws, and removing this hunk restores byte-identical behavior.
    // (`rosterMembers.length > 0` is redundant with the :1229 early return —
    // kept deliberately so the seam states its own precondition locally and
    // survives any future reordering. Not a bug; do not "simplify" it away.)
    if (history.length > 0 && rosterMembers.length > 0) {
      this.meetingScribe?.noteActivity({
        threadId,
        history,
        channelLabel: item.source.label,
        roster: rosterMembers,
        baseAgentId: rosterMembers[0].agentId,
        source: {
          adapterId: item.source.adapterId ?? item.source.kind,
          channelId: item.source.id,
          channelKind: item.source.kind,
          slackTs: (item.meta?.slackTs as string) ?? "",
          slackThreadTs: (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string) ?? threadId,
        },
      });
    }
```

- [ ] **E7. R1 hunk 2** — cadence seam in `triggerConferenceReactions`, placed **after the `if (this.slackAdapter) { … }` re-fetch block (`~:1494`) and before `const responderName = …` (`~:1497`)**. ⚠ **Deliberately selection-gated:** the three early returns (`!roster` `:1424`, empty `peerMembers` `:1452`, empty `respondAgentIds` `:1465`) all sit **before** the re-fetch, so on those paths there is no history to hand the scribe. Do not "fix" that asymmetry — round 0 already guarantees one trigger per human message, which is the cadence that matters (T6 pins the asymmetry):

```ts
    // KPR-409 (R1 — requested C26 relaxation): round-1 cadence trigger.
    // Selection-gated by construction (the three early returns above precede
    // the re-fetch). Same fire-and-forget contract as the round-0 seam.
    if (history.length > 0 && allRosterMembers.length > 0) {
      this.meetingScribe?.noteActivity({
        threadId,
        history,
        channelLabel: originalItem.source.label,
        roster: allRosterMembers,
        baseAgentId: allRosterMembers[0].agentId,
        source: {
          adapterId: originalItem.source.adapterId ?? originalItem.source.kind,
          channelId: originalItem.source.id,
          channelKind: originalItem.source.kind,
          slackTs: humanTs,
          slackThreadTs:
            (originalItem.meta?.slackThreadTs as string) ?? (originalItem.meta?.slackTs as string) ?? threadId,
        },
      });
    }
```

- [ ] **E8.** Add tests to `src/channels/dispatcher-conference.test.ts` inside the existing `describe("delta context injection (KPR-388)")` block (it already owns `seedRef`, `makeHistory`, `soloClassifier`, `PREAMBLE`) — **additions only, zero edits to existing cases**. Add a `seedScribe()` helper that installs a fake via `dispatcher.setMeetingScribe({ getSummary: vi.fn(...), noteActivity: vi.fn() } as any)`.

- [ ] **E8a — T1 summary-mode byte pin.** Fresh-session ref (no seeded ref) + a summary doc `{ summaryText: "S", coveredThroughTs: "1000.0002" }` + `THREE_MSG_HISTORY()` ⇒ `turnItem.text` byte-exact:

```ts
      const expectedSummary =
        `[Meeting thread in #conf-summary — participants: Jasper]\n` +
        `[Running summary of the meeting so far:]\n\n` +
        `S\n\n` +
        `[Messages since the summary:]\n\n` +
        `May (5 min ago): newer message`;
      expect(turnItem.text).toBe(
        `${PREAMBLE("conf-summary", "Jasper")}\n${expectedSummary}\n---\n[New message]:\n${item.text}`,
      );
      expect(turnItem.meta.conferenceInjectionMode).toBe("summary");
      expect(turnItem.text).not.toContain("[New messages since your last turn:]");
      expect(turnItem.text).not.toContain("old message"); // pre-summary content is gone
```

  Plus an **empty-tail row**: `coveredThroughTs: "1000.0003"` (covers the whole history) ⇒ the text ends at the summary, with **no** dangling `[Messages since the summary:]` header.

- [ ] **E8b — T2 high-water formula (R2).**
  - (a) Non-empty tail, round 0 with `slackTs: "1000.0004"` ⇒ `setMeetingMark` called with `"1000.0004"` (trigger max-in wins); with a trigger ts *below* the tail max ⇒ the tail max wins.
  - (b) ⚠ **The correction pin.** Empty tail (`coveredThroughTs` ≥ every history ts) on a **round-1** dispatch (no `roundZeroTriggerTs`) ⇒ `setMeetingMark` **called** with `coveredThroughTs`. Build this through `triggerConferenceReactions` (a round-0 responder whose reaction pass selects a peer) or by asserting the round-1 leg the existing `:1126` case already exercises.
  - (c) Round 0 ⇒ maxed against `roundZeroTriggerTs`.
  - Record the F1 inversion in a comment above the block:
    ```ts
    // ⚠ Written against R2 (spec §D4, plan header decision). If the coherence
    // reviewer rules F1 instead, ALL FIVE of the tests below INVERT — both
    // T2(a) cases, T2(b), T2(c) and T5 — because true F1 deletes the whole
    // injectionHighWaterTs property from the summary arm (not just the
    // coveredThroughTs term), so the mark is undefined and setMeetingMark is
    // never called on ANY summary turn. Rewrite all five to pin the absence.
    ```
- [ ] **E8c — T3 C6 pin unchanged.** No new test; the gate is that the existing byte-exact assembly pin (`:492`) and full-mode mark case (`:770`) pass **unmodified**. Add one explicit control case: scribe installed but `getSummary` resolving `undefined` ⇒ `turnItem.text` byte-equals the pre-KPR-409 full-mode shape (`toContain("old message")`, no summary markers).
- [ ] **E8d — T4 delta arm never reads summaries.** Delta-eligible agent (`seedRef` with sessionId + claude + mark) **with** a summary doc present ⇒ `getSummary` **not called**, `injectionMode: "delta"`, and the delta byte pin at `:715` shape reproduced.
- [ ] **E8e — T5 self-heal leg untouched.** Summary-mode turn where `runWorkItemTurn` resolves with `resumedSession: false` ⇒ `setMeetingMark` called, `clearMeetingMark` **not** called (mirrors the existing `:1158` full-mode case).
- [ ] **E8f — T6 cadence seam, round-level.**
  - A round-0 pass where the classifier selects **N = 2** responders ⇒ `noteActivity` called **exactly once**, with `history` deep-equal to the fetched array and `roster` the full roster-member list. (Negative-verified in Task F/NV4.)
  - A round-0 pass where the classifier selects **nobody** ⇒ still exactly one `noteActivity` call (E12).
  - A round-1 pass where reactors **are** selected ⇒ one additional call. A round-1 pass where the reaction classifier selects **nobody** ⇒ **no** additional call (the early return precedes the re-fetch) — assert this explicitly rather than papering over the asymmetry.
  - `getSummary` **throwing** ⇒ the dispatch still completes, `runWorkItemTurn` still called, full-arm shape injected. (⚠ The production `getSummary` never throws; this case pins the dispatcher's tolerance of a misbehaving injected scribe — use a fake that rejects.)

- [ ] **E9.** Verify:

```bash
npm run typecheck
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
# expect: 34 baseline cases green + the new cases; ZERO edits to existing cases
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
# expect: 96 passed, file untouched
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
# WHOLE FILE ONLY — expect: 248 passed
git diff --stat dc2a685 -- src/channels/dispatcher-conference.test.ts   # additions only
```

- [ ] **E10.** Commit: `feat(dispatcher): summary-mode conference anchor + round-level scribe cadence seams (KPR-409)`

---

### Task F — Negative-verify pass (no commit)

For each expected-FAIL probe: make the temporary edit, run the named suite, **confirm the named test fails**, then `git checkout -- <file>` and re-run to green. Confirm `git status --short` clean after the whole pass.

**Expected-FAIL probes (revert-the-fix ⇒ the new test must fail):**

- [ ] **NV1 (T1 anchor).** In `buildConferenceContext`, delete the `if (summary) { … }` block (leaving the plain full-arm return) → `npx vitest run src/channels/dispatcher-conference.test.ts`: the T1 byte pin fails with the raw-transcript shape. Restore.
- [ ] **NV2 (T2 / R2 formula).** Delete `summary.coveredThroughTs,` from the summary arm's `maxSlackTs([...])` array → conference suite: **T2(b) fails** — `injectionHighWaterTs` is `undefined` and `setMeetingMark` is never called. Restore. ⚠ This probe proves the term is load-bearing for the empty-tail case; it is **not** the F1 diff. F1 deletes the entire `injectionHighWaterTs` property (see the plan header) and inverts all five summary-mode mark tests, not just T2(b).
- [ ] **NV3 (T4 delta isolation).** Hoist `const summary = await this.meetingScribe?.getSummary(threadId);` **above** the `if (!ref?.sessionId || …)` predicate → conference suite: T4 fails (`getSummary` called on a delta-eligible agent). Restore.
- [ ] **NV4 (⚠ seam-placement defect — T6. NOT the concurrency race; see NV5 for that).** Move the `noteActivity` call out of `resolveConferenceAgents` and into `buildConferenceContext`'s full arm (the earlier design the spec corrected) → conference suite: **the round-0 exactly-one call-count assertion fails at N** (one call per responder), **and** the classifier-selects-nobody case fails at 0 calls. Restore.

  ⚠ **Scope note, so nobody reads this as the race guard:** the conference suite injects a **fake** scribe (`noteActivity: vi.fn()`), so no `inFlight` logic executes in this probe at all. NV4 measures a **dispatcher-side property** — that the trigger is per-round rather than per-agent, and fires even on an empty selection. The spec's *concurrency* race (the synchronous claim) is a scribe-internal property, guarded solely by **NV5/T11**. Both probes are real and neither substitutes for the other.
- [ ] **NV5 (⚠ the synchronous-claim race — T11).** In `MeetingScribe.noteActivity`, move `this.inFlight.add(threadId)` from above `void this.run(args)` into the top of `run()` **below** the first `await` (i.e. after the `findOne`) → `npx vitest run src/workers/meeting-scribe.test.ts`: T11 observes **five** `runRoleTurn` invocations instead of one. Restore. ⚠ This must be observed **failing** on the pre-fix ordering — a T11 that only passes on the fixed code proves nothing.
- [ ] **NV6 (⚠ the capacity-isolation gap — T12).** In `MeetingWorkerPool.runRoleTurn`, register the role turn in `liveWorkers` — add, immediately after `buildWorkerAdapter`:
  ```ts
  this.liveWorkers.set(args.workItemContext.threadId, { abort: () => adapter.abort(), bossAgentId: args.base.id });
  ```
  → `npx vitest run src/workers/`. ⚠ **Exactly which assertions fail, and why the obvious one does not:**
  - **Fails:** the `maxConcurrent: 4` cases (D2f end-to-end and the Task C pool-level companion) — with the scribe holding a slot, the fourth `pool.dispatch` sees `4 >= 4` and returns "Worker pool saturated (4/4 engine-wide) …", so the all-dispatched assertion fails, the no-saturation assertion fails, and `buildWorkerAdapter` is called **4** times instead of 5.
  - **Fails:** the `maxConcurrent: 1` variants — `hasCapacity()` becomes `1 < 1` = `false`.
  - **⚠ Does NOT fail, and must not be relied on:** any `hasCapacity() === true` assertion taken at `maxConcurrent: 4`. One extra live worker leaves `1 < 4` true, so that assertion is blind to this exact bug. If the only red test in this probe is a `maxConcurrent: 1` case or a dispatch-count case, that is correct and expected.

  Restore.
- [ ] **NV7 (T7 containment).** In `MeetingScribe.run`, build the role with `coreServers: base.coreServers` and `model: base.model` → scribe suite: T7 fails (boss servers/model leak into the built worker config). Restore.
- [ ] **NV8 (T9 `updating` lifecycle).** Delete the `finally` block's `$unset: { updating: "" }` clear in `MeetingScribe.run` → scribe suite: the failure/timeout row of T9 fails (`updating` still set after a failed run, so the next trigger is blocked by gate 2b). Restore.
- [ ] **NV8b (⚠ the debounce sentinel — D2b′).** In `MeetingScribe.noteActivity`, revert gate 3 to the arithmetic sentinel: `if (this.now().getTime() - (this.lastRunAt.get(threadId) ?? 0) < cfg.scribeDebounceMs) return;` → `npx vitest run src/workers/meeting-scribe.test.ts`: **D2b′ fails with zero `runRoleTurn` calls** (its low-epoch clock makes `50_000 - 0 < 90_000` true, so the first-ever run on a never-summarized thread is blocked). The realistic-epoch rows stay green — which is exactly why D2b′ has to exist. Restore.
- [ ] **NV9 (`getSummary` stub guard).** Change `getSummary`'s guard to `if (!doc) return undefined;` (dropping the `summaryText`/`coveredThroughTs` check) → scribe suite: the stub-doc case fails (a failed-first-run stub reads as a summary, which would inject `undefined` into the anchor). Restore.

**Expected-PASS controls (behavior-preserving edits ⇒ suites stay green, demonstrating the pins target behavior, not incidentals):**

- [ ] **NV10.** Rename the private method `MeetingScribe.run` → `runScribeTurn` (declaration + the single call site in `noteActivity`) → `npx vitest run src/workers/` stays green. Restore.
- [ ] **NV11.** Reorder the two synchronous gates 2a and 5a in `noteActivity` (`inFlight.size >= scribeMaxConcurrent` before `inFlight.has(threadId)`) → scribe suite stays green **except** it must NOT be left in place: with `scribeMaxConcurrent: 1` and a live run on the same thread, the reordering changes which gate fires but not the outcome. Confirm green, then restore (this is a control that the gate assertions test outcomes, not ordering artifacts).
- [ ] **NV12.** In `formatSummaryContext`, replace the local `participantNames` join with an equivalent `roster.map((r) => r.name).join(", ")` inlined at the template site → conference suite stays green (the byte pin targets output, not structure). Restore.

- [ ] **NV13.** Final state check:

```bash
git status --short   # expect: clean (or only .dodi/ manifest noise)
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run \
  src/workers/ src/channels/dispatcher-conference.test.ts src/channels/dispatcher.test.ts src/config.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
# expect: all green
```

---

### Task G — index.ts wiring, docs sync, full sweep, gates

- [ ] **G1.** In `src/index.ts`, construct the scribe immediately after `await workerPool.start()` / its log line (`~:757`):

```ts
  // KPR-409: meeting scribe — running summary for the conference full-arm
  // anchor. Constructed after the pool (it consumes runRoleTurn/hasCapacity)
  // and injected into the dispatcher by setter, the setSlackAdapter precedent.
  const meetingScribe = new MeetingScribe({
    db,
    registry,
    pool: workerPool,
    config: config.meetingWorkers,
  });
  // ⚠ NOT awaited-fatal, deliberately diverging from the claim ledger's C27
  // boot-fatal posture: the scribe's only index is 7-day TTL housekeeping with
  // no correctness role. Without it, summary docs simply accumulate. Making an
  // explicitly-optional, always-degradable feature boot-fatal would contradict
  // this feature's own degrade-silently rule (spec §Integration points issue 5).
  meetingScribe.ensureIndexes().catch((err) => log.error("Scribe index setup failed", { error: String(err) }));
  dispatcher.setMeetingScribe(meetingScribe);
  log.info("Meeting scribe wired", {
    scribeEnabled: config.meetingWorkers.scribeEnabled,
    scribeModel: config.meetingWorkers.scribeModel,
    scribeMaxConcurrent: config.meetingWorkers.scribeMaxConcurrent,
  });
```

with `import { MeetingScribe } from "./workers/meeting-scribe.js";` beside the pool import (`:33`).

- [ ] **G2.** In the shutdown block, add `meetingScribe.stop();` immediately after `workerPool.stop();` (`~:882`). Then verify and commit:

```bash
npm run typecheck   # expect: clean
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/workers/ src/channels/
# expect: green
```

Commit: `feat: wire the meeting scribe into the engine lifecycle (KPR-409)`

- [ ] **G3.** Docs sync — `CLAUDE.md`:
  - **Collections list** (`:272`): insert after the `meeting_worker_claims (…)` entry:
    ```
    `meeting_summaries` (meeting scribe running summary KPR-409 — one doc per meeting thread keyed by `_id: threadId`; `summaryText` capped at 2500 chars, `coveredThroughTs` high-water, single-flight `updating` guard; 7d TTL housekeeping, index non-fatal at boot),
    ```
  - **Key Files** (after the `src/workers/meeting-worker-pool.ts` bullet at `:74`) — ⚠ mechanical sharpening beyond the spec's file list, for consistency with how its sibling module is documented:
    ```
    - `src/workers/meeting-scribe.ts` — meeting scribe (KPR-409): per-thread running summary in `meeting_summaries`, activity-triggered debounced re-dispatch via the two round-level conference seams, tool-less haiku role turns through the pool's `runRoleTurn` (own `scribeMaxConcurrent` counter — never consumes a fetch-worker slot); feeds `buildConferenceContext`'s full-arm summary anchor
    ```
  - **`delegateServers` constraint paragraph:** no change — the scribe adds no MCP server.

- [ ] **G4.** Docs sync — `docs/epics/kpr-386/kpr-390-spec.md`: under the `## Design — Part B: scribe` heading (`:244`), add a pointer line (no content edits — the spec is history):

```
> ⚠ **SUPERSEDED (2026-08-27).** This Part B design is carried here as history.
> The binding contract is `docs/epics/kpr-386/kpr-409-spec.md`, which corrects
> it in three load-bearing places: the scribe uses a NEW sibling `runRoleTurn`
> (not `runWorkerTurn` — that path is claim-coupled and would post into the
> meeting), the cadence trigger sits at two ROUND-LEVEL dispatch sites (not
> inside `buildConferenceContext`), and the high-water formula is NOT unchanged
> (R2, spec §D4). Read KPR-409's spec, not this section.
```

- [ ] **G5. `docs/providers.md` — stated conclusion: NO CHANGE REQUIRED.** Rationale, recorded here so review need not re-derive it: KPR-390 earned its "Meeting worker pool" section (`:40-42`) because it added a **tool surface** (`worker_dispatch`/`worker_status`/`worker_cancel`) whose cross-lane availability and Lane B bridging is a provider-parity fact. KPR-409 adds **no MCP server and no tool** (spec ⚠ Key Point 7, C23). Its only provider-visible effect is that agents on **every** lane receive a shorter injected prompt in the conference full arm — provider-agnostic by construction, and already covered by the existing meeting rows. The spec lists `docs/providers.md` under **Explicitly untouched**, and a plan may not overrule its binding spec — so this plan makes no change.

  ⚠ **Flagged for the coherence reviewer / a follow-up (not a code change in this ticket):** there is a genuine ops-relevant fact that the existing "Meeting worker pool" section arguably should carry — **the scribe, like the fetch-worker, is Claude-lane-pinned** (`scribeModel`, default `haiku`). A meeting whose participants are all Lane A/Lane B agents on an instance with no working Claude auth gets no summaries at all, silently, and the full arm quietly stays on raw transcripts. That is exactly the class of fact the section's existing "Dispatched workers themselves always run on the Claude lane" sentence exists to state. Adding one parallel sentence is a defensible call — but it is the reviewer's to make against the spec's untouched list, not this plan's to take.

- [ ] **G6. C24 gate (frozen spawn path):**

```bash
git diff dc2a685..HEAD -- src/workers/meeting-worker-pool.ts
# Manually confirm: the ONLY changes inside runWorkerTurn / spawnFetchWorker /
# dispatch / finishClaim / dispatchReentry / expireClaim / the sweeps / stop /
# abortForBoss / cancel are the THREE sanctioned comment blocks (B1-B3).
# Everything else is a pure addition (RoleTurnOutcome, hasCapacity, runRoleTurn).
git diff dc2a685..HEAD -- src/workers/meeting-worker-pool.ts | grep "^-" | grep -v "^---"
# expect: only comment lines (leading " *" or " //"), zero executable lines
```

- [ ] **G7. T3 gate (existing conference pins unedited):**

```bash
git diff dc2a685..HEAD -- src/channels/dispatcher-conference.test.ts | grep "^-" | grep -v "^---"
# expect: EMPTY — additions only, no existing case edited
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
# expect: all 34 baseline cases + the Task E additions green
```

- [ ] **G8. Full sweep:**

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
# expect: typecheck clean, lint clean, format clean, ALL test files passed
```

- [ ] **G9. Bundle + guards** (`meeting-scribe.ts` is reachable from `index.ts` — it must bundle; no standalone shims, no `import.meta.url` guards, no new externals):

```bash
npm run check:bundle
# expect: esbuild bundle OK + check-bundle-strings, check-bundle-pack,
# check-bundle-runtime, check-bundle-qdrant-stub all pass
```

- [ ] **G10.** Commit: `docs: meeting_summaries collection, scribe key-file, KPR-390 Part B superseded pointer (KPR-409)`
- [ ] **G11.** If G8/G9 surfaced mechanical fixes (format, lint), commit them: `chore: quality-gate fixes (KPR-409)`

**Rollout note (goes in the PR body and the ticket):**

> Shipping this engine change is **on by default** but inert until a meeting is 6 messages deep (`scribeMinNewMessages`), and it changes nothing for delta-eligible agents. Operator steps per instance:
> 1. Deploy + `launchctl kickstart -k gui/$(id -u)/com.hive.<id>.agent`. No agent-def change and no SIGUSR1 needed — the scribe is engine-level, not per-agent.
> 2. Optional `hive.yaml` `meetingWorkers:` keys (all optional; defaults: `scribeEnabled: true`, haiku, 90s debounce, 6-message novelty floor, 2 engine-wide, 4 maxTurns, 120s wall clock).
> 3. Validate on a live `conf-*` meeting past 6 messages: `db.meeting_summaries.findOne({_id: "<threadId>"})` shows `summaryText` + `coveredThroughTs` + `version`; a fresh entrant's `agent_turn_telemetry` row carries `injectionMode: "summary"`.
> **Rollback lever:** `meetingWorkers.scribeEnabled: false` + restart ⇒ no scribe runs, no anchor branch, byte-identical to pre-KPR-409. (Deliberately separate from `enabled`, so fetch-workers keep working while the injection change is reverted.)
> **Cost note:** one haiku turn per active meeting per ~90s, tool-less, 4-turn capped. It never consumes a fetch-worker slot and yields to a saturated pool.

---

## Out-of-scope guard rails (do NOT touch)

- **⚠ R1/R2 rulings are NOT this plan's job.** Both relaxations are stated honestly in the spec, implemented as specified (R2 primary), and **submitted for the coherence reviewer at this ticket's merge seam**. The implementer does not decide them, does not pre-emptively implement F1, does not add a config switch between R2 and F1, and does not weaken R2 into the withdrawn "max in only when the tail is non-empty" variant.
- **⚠ This is the epic's LAST child — no further splits.** Anything discovered that would justify a new ticket gets filed as a follow-up, not carved out of this scope.
- **`runWorkerTurn` / `spawnFetchWorker` / `dispatch` / `finishClaim` / `dispatchReentry` / the sweeps / `stop` / `abortForBoss` / `cancel`:** zero executable edits (C24). The forbidden refactor is "extract the common core of `runWorkerTurn` and `runRoleTurn`" — the duplication is deliberate.
- **`liveWorkers` / `maxConcurrent` sharing:** scribes get their own `scribeMaxConcurrent` counter and their own `abortHandles` map. Do not register scribes in `liveWorkers`, do not route them through `abortForBoss`, do not make `hasCapacity()` count scribes.
- **The delta arm, the eligibility predicate, `truncateHistory`, `formatDeltaContext`, `formatThreadContext`:** untouched. `dispatcher.ts:1100`'s `=== "delta"` self-heal leg stays exactly as written.
- **Mark mechanics:** `setMeetingMark` / `clearMeetingMark`, their call sites, and their placement relative to the outage gates are untouched. Only the *value* handed to `setMeetingMark` on the summary arm changes (R2).
- **The roster, classifier, preamble, reaction tracker, KPR-389 shaping, and the kill-suppression leg:** structurally unreachable from a scribe run (spec §D2) — no code there changes and no new turn kind is invented.
- **No new MCP tool, no `worker-pool` tool changes, no `in-process-servers.ts` entry, no `hive doctor` section, no new telemetry kind, no `agent_turn_telemetry` row for scribe turns** (C18/C23). The scribe's measurement surface is the widened `injectionMode` field only.
- **No Lane B `buildToolTransportInventory` compensation** — C23 is a structural no-op here (nothing to compensate for). Do not add a `meeting-scribe` inventory entry.
- **`SUMMARY_TEXT_CAP` (2500) vs the charter's 2000:** deliberate headroom. Do not align them.
- **`ensureIndexes` stays non-fatal at boot** — do not "fix" it to match the claim ledger's C27 posture.
- **`docs/providers.md`:** no change (G5 conclusion).
- **Hierarchical / cross-meeting / global summarization, summary versioning UI, an operator command to force a scribe run:** all explicitly out of scope (spec §Non-goals).

## Commit sequence summary

| # | Commit | Files |
|---|---|---|
| 1 | `feat(workers): meetingWorkers scribe config keys — seven liberal-loader entries (KPR-409)` | `worker-pool-config.ts`, `config.ts`, `config.test.ts` |
| 2 | `feat(workers): pool runRoleTurn + hasCapacity — claim-free sibling for the scribe (KPR-409)` | `meeting-worker-pool.ts` (2 additions + 3 comment corrections) |
| 3 | `test(workers): runRoleTurn clone/containment/capacity-isolation contract (KPR-409)` | `meeting-worker-pool.test.ts` |
| 4 | `feat(workers): meeting scribe — running summary, synchronous single-flight, capacity-isolated (KPR-409)` | `meeting-scribe.ts` + `meeting-scribe.test.ts` |
| 5 | `feat(telemetry): widen conference injectionMode to include "summary" (KPR-409)` | `dispatcher.ts` (2 type sites), `agent-manager.ts`, `turn-telemetry.ts` |
| 6 | `feat(dispatcher): summary-mode conference anchor + round-level scribe cadence seams (KPR-409)` | `dispatcher.ts`, `dispatcher-conference.test.ts` |
| 7 | `feat: wire the meeting scribe into the engine lifecycle (KPR-409)` | `index.ts` |
| 8 | `docs: meeting_summaries collection, scribe key-file, KPR-390 Part B superseded pointer (KPR-409)` | `CLAUDE.md`, `docs/epics/kpr-386/kpr-390-spec.md` |
| 9 | (conditional) `chore: quality-gate fixes (KPR-409)` | — |

⚠ Task G's index wiring is commit 7 (step G2); Task F (negative-verify) produces no commit. Task ordering is the hard dependency chain **A → B → C → D → E → F → G**, exactly as the tasks are documented: F runs after Task E's dispatcher commit and before Task G's wiring, docs, and full sweep. (An earlier draft said "F immediately before G8" — F runs before *all* of Task G, not just the sweep step.)
