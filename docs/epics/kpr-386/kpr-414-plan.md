# KPR-414 — Meeting-mode operational hardening: boot-order gap + scribe stop() race — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Worker-pool and scribe wiring completes before any spawn-capable surface starts (restoring `index.ts`'s own stated invariant), the boot sweep is protected against the wider window that move creates, and `MeetingScribe.stop()` genuinely prevents any new role turn from starting after it returns — on every interleaving, including the one where a handle is registered after `stop()` has already swept.

**Architecture:** Four coordinated changes. **D1** (`src/index.ts`) splits the pool/scribe block: construction, `setWorkerPool`, an early `ensureIndexes()` call, and `setMeetingScribe` move to just after the `Dispatcher` is constructed; `workerPool.start()` (the restart sweep + watchdog) deliberately stays at its current, later site because its re-entry turns need a registered Slack adapter to be deliverable. **D2** (`src/index.ts`) promotes the existing KPR-394 boundary comment into a named, generalized file invariant. **D3** (`src/workers/meeting-worker-pool.ts`) adds a `liveWorkers` guard to `sweepOnRestart`, required (not optional) because D1 widens the window in which a boss can legitimately claim before the sweep runs. **D4** (`src/workers/meeting-scribe.ts`) adds a `stopped` latch checked at three points in the scribe's lifecycle; the third (inside the `onAbortHandle` callback) **throws** rather than calling the handed `abort()`, because that `abort()` is provably a no-op at the moment it would fire — the throw is absorbed by `runRoleTurn`'s own existing "never throws" try/catch, so the turn is never started and `runRoleTurn` itself needs zero edits.

**Tech Stack:** TypeScript, Vitest.

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `src/index.ts`'s boot-order (new `src/boot-order.test.ts`, a static source-order guard — the file is a side-effecting `main()`, so this is a text-scan test, not an import test), `MeetingWorkerPool.sweepOnRestart` (`src/workers/meeting-worker-pool.test.ts`), `MeetingScribe.noteActivity`/`run`/`stop` (`src/workers/meeting-scribe.test.ts`)
  - Reason: all four design points are pure control-flow/ordering changes with no I/O beyond what the existing test harnesses already fake
  - Minimum assertions: (1) wiring calls (including the new early `ensureIndexes()`) precede every named spawn-capable surface start, and a superset scan over every `.start(`/`.scanOrphans(` in the file (comments stripped) catches an unnamed one too; (2) the restart sweep skips a claim present in `liveWorkers` and still expires a claim that is not; (3) `noteActivity` after `stop()` does nothing; (4) a run already past its gates does not spawn if `stop()` lands during its Mongo read; (5) a turn whose abort handle would be minted after `stop()`'s sweep is never started, and the mechanism is provably not a call to the (inert) `abort()`

- Integration: `not-required`
  - Scope: n/a
  - Reason: see Non-Required Rationale
  - Harness: not-applicable
  - Minimum assertions: n/a

- E2E: `not-required`
  - Scope: n/a
  - Reason: see Non-Required Rationale
  - Harness: not-applicable
  - Minimum assertions: n/a

### Critical Flows

- A fresh engine boot wires the worker pool and scribe before the Slack adapter (or any other spawn-capable surface) can dispatch a turn, so no turn in the boot window silently loses `worker-pool` tools or the scribe's summary anchor.
- A restart that lands mid-worker (a boss claimed a task before the restart sweep ran) is not incorrectly expired and killed by that sweep.
- A shutdown that races an in-flight `noteActivity` call never leaves an unabortable, unregistered scribe turn running past `stop()`.

### Regression Surface

- `src/workers/meeting-worker-pool.test.ts`'s existing restart-sweep row (`:630`, T6) and all four `pool.start()` fixtures (`:635`, `:684`, `:703`, `:733`) must stay green — D3 must not change behavior for the case (no live claims) those rows already cover.
- `src/workers/meeting-scribe.test.ts`'s existing `stop() (D2i)` describe (`:812-840`) must stay green — the latch adds behavior only on paths those two rows don't exercise.
- The full conference test suite (`dispatcher-conference.test.ts`), containment pins, and capacity-isolation rows (D2f in the pool suite) are untouched by every change here and must stay green.

### Commands

- Unit: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/boot-order.test.ts src/workers/meeting-worker-pool.test.ts src/workers/meeting-scribe.test.ts`
- Integration: not-applicable
- E2E: not-applicable
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` (typecheck + lint + format + full suite, before pre-PR review)

### Harness Requirements

- None beyond the existing suites' fixtures, plus one small fidelity fix to `meeting-scribe.test.ts`'s `makeFakePool()` (Task 4) so its `runRoleTurn` reproduces the real one's try/catch shape — required for T4 to exercise the real containment contract rather than a divergent stand-in.

### Non-Required Rationale

- Integration: every design point is exercised end-to-end by the existing unit-level mocked suites (the pool/scribe suites already simulate the full dispatch → claim → turn → completion chain with mocked boundaries; the boot-order test reads the real `index.ts` source directly). No real Mongo, Slack, or provider call is needed to prove any of D1-D4.
- E2E: no user-facing behavior changes beyond the boot-window self-heal already existing pre-fix (now closed) and shutdown cleanliness (unobservable without inducing a live restart/shutdown race, which the unit tests already reproduce deterministically).

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

- `src/index.ts` — D1 (move six statements + add one `ensureIndexes()` call), D2 (boundary marker comment).
- `src/workers/meeting-worker-pool.ts` — D3 (one guard clause inside `sweepOnRestart`).
- `src/workers/meeting-scribe.ts` — D4 (one field, one exported constant, three checkpoints, one line in `stop()`).
- `src/boot-order.test.ts` *(new)* — T1.
- `src/workers/meeting-worker-pool.test.ts` — T5 (D3 regression).
- `src/workers/meeting-scribe.test.ts` — one harness fidelity fix, T2/T3/T4.

## Task 1: D1 + D2 — `src/index.ts`

**Files:**
- Modify: `src/index.ts:399-406` (KPR-394's original comment — left untouched, D2 does not edit this)
- Modify: `src/index.ts:414` (insertion point for the moved wiring block AND, immediately after it, the D2 boundary marker)
- Modify: `src/index.ts:748-792` (D1, the block being split and moved out of)

⚠ **Step order matters and differs from an earlier draft of this plan.** The spec's D2 (`kpr-414-spec.md:157`) places the boundary marker **immediately above the background-task-manager block**, i.e. AFTER the moved wiring, not before it — empirically confirmed: a draft that inserted the marker first (with the wiring below it) reads as self-contradicting, since the marker's own text says "must be wired ABOVE it" while the wiring sits directly below. Step 1 below inserts the wiring block only; Step 2 adds the marker at its correct site, immediately before `// Background task manager`.

- [ ] **Step 1 (D1, wiring):** Insert the moved pool/scribe wiring block immediately after the `Dispatcher` construction closes.

Current text (`index.ts:406-417`, unchanged context shown for the insertion point):

```ts
  await agentManager.activateProviderPlugins();
  const healthReporter = new HealthReporter(agentManager, memoryManager, registry);
  const dispatcher = new Dispatcher(
    registry,
    agentManager,
    healthReporter,
    config.defaultAgent,
    taskLedger.isConfigured ? taskLedger : undefined,
  );

  // Background task manager — agents can spawn detached background processes
  const bgTaskManager = new BackgroundTaskManager(
```

Insert the D1 wiring block between the `Dispatcher` construction's closing `);` and the `// Background task manager` comment (the D2 marker goes in AFTER this, in Step 2 — inserting both at once here would put the marker above the wiring it's supposed to sit below):

```ts
  await agentManager.activateProviderPlugins();
  const healthReporter = new HealthReporter(agentManager, memoryManager, registry);
  const dispatcher = new Dispatcher(
    registry,
    agentManager,
    healthReporter,
    config.defaultAgent,
    taskLedger.isConfigured ? taskLedger : undefined,
  );

  // KPR-390: meeting worker pool — constructed after the dispatcher
  // (scheduler-seam precedent, breaks the manager↔dispatcher cycle).
  // KPR-414: wiring (incl. ensureIndexes) moved here, ABOVE the
  // spawn-capable boundary; workerPool.start() itself (restart sweep +
  // watchdog) deliberately stays at its original, later site — see the
  // comment there for why the split is forced, not stylistic.
  const workerPool = new MeetingWorkerPool({
    db,
    registry,
    config: config.meetingWorkers,
    onDispatch: (item) => {
      dispatcher.dispatch(item).catch((err) => {
        log.error("Worker re-entry dispatch failed", { error: String(err) });
      });
    },
  });
  agentManager.setWorkerPool(workerPool);
  // KPR-414: ensureIndexes is public and idempotent (three createIndex
  // calls, no-ops when the indexes already exist). Calling it here closes
  // the window — real once wiring moved ~340 lines earlier than start() —
  // in which the pool is dispatchable but its claim-ledger atomicity index
  // might not exist yet. start() re-runs it later at the cost of three
  // no-op round-trips; its own boot-fatal posture and contract are
  // untouched at both sites.
  await workerPool.ensureIndexes();

  // KPR-409: meeting scribe — running summary for the conference full-arm
  // anchor. Constructed after the pool (it consumes runRoleTurn/hasCapacity)
  // and injected into the dispatcher by setter, the setSlackAdapter precedent.
  // KPR-414: wiring moved here, ABOVE the spawn-capable boundary, alongside
  // the pool's.
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

  // ── Spawn-capable boundary (KPR-394, restated by KPR-414) ──────────────
  // Everything BELOW this line can dispatch a turn: bgTaskManager /
  // codeTaskManager orphan-completion callbacks, meetingMonitor, every
  // channel adapter, the scheduler. Anything a turn READS PER SPAWN —
  // provider plugins, the worker pool, the meeting scribe — must be wired
  // ABOVE it, or turns in the boot window silently see the pre-feature
  // engine. Guarded by src/boot-order.test.ts.

  // Background task manager — agents can spawn detached background processes
  const bgTaskManager = new BackgroundTaskManager(
```

Note: this single edit contains both Step 1's wiring block AND Step 2's marker comment, already in their final relative order (wiring, then marker, then bgTaskManager) — Steps 1 and 2 are described separately below only to name each piece's origin (D1 vs D2) per the spec's own itemization; apply them as one edit as shown.

- [ ] **Step 2 (D2, marker — same edit as Step 1, described separately per the spec's D1/D2 split):** The `// ── Spawn-capable boundary ──` block above is D2's contribution; it is already correctly placed immediately above `// Background task manager` by the Step 1 edit. No separate action needed here beyond confirming that placement — do not insert it a second time.

⚠ **A2 (advisory, worth knowing, not actioned):** immediately after Step 1's edit and before Step 3 removes the old site, the file has two declarations each of `const workerPool` and `const meetingScribe` and will not compile. This is expected and harmless — `npm run typecheck` is Step 4, run only after Step 3 also completes. Do not run an incremental typecheck between Steps 1 and 3 and treat a duplicate-declaration error as a problem.

- [ ] **Step 3 (D1, removal):** Remove the pool/scribe block from its old site, replacing it with only the retained `workerPool.start()` call (now carrying a rationale comment) and the "Meeting worker pool started" log — the construction/wiring/`setMeetingScribe`/scribe-log statements moved to Step 1 are deleted from here, not duplicated.

Current text (`index.ts:748-792`):

```ts
  // KPR-390: meeting worker pool — constructed after the dispatcher
  // (scheduler-seam precedent, breaks the manager↔dispatcher cycle).
  const workerPool = new MeetingWorkerPool({
    db,
    registry,
    config: config.meetingWorkers,
    onDispatch: (item) => {
      dispatcher.dispatch(item).catch((err) => {
        log.error("Worker re-entry dispatch failed", { error: String(err) });
      });
    },
  });
  agentManager.setWorkerPool(workerPool);
  // indexes + restart sweep + watchdog. Unguarded on purpose: the restart
  // sweep self-contains its own failures (pool.start), so the only throw that
  // reaches here is an ensureIndexes failure — boot-fatal like every other
  // boot-time datastore failure.
  await workerPool.start();
  log.info("Meeting worker pool started", {
    enabled: config.meetingWorkers.enabled,
    maxConcurrent: config.meetingWorkers.maxConcurrent,
    perMeetingMax: config.meetingWorkers.perMeetingMax,
  });

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

Replace with (the pool/scribe construction, `setWorkerPool`, `ensureIndexes`, `setMeetingScribe`, and scribe log are GONE from this site — they now live where Step 1 placed them; only `start()` and its log remain, with a new comment):

```ts
  // KPR-414: the pool's WIRING — and its ensureIndexes() — moved above the
  // spawn-capable boundary (see the block after the Dispatcher construction);
  // ensureIndexes is idempotent, so start() re-running it here is three
  // no-op createIndex calls and start()'s contract is intact. This call —
  // restart sweep, watchdog — deliberately stays HERE, below
  // dispatcher.registerAdapter(slackAdapter): the sweep's honest expiry
  // re-entry is a real boss turn, and dispatchToAgent resolves its delivery
  // adapter BEFORE running the turn (dispatcher.ts:324 / :570-572), so an
  // early sweep would pay for the turn and silently drop the notice.
  // Wiring-before-surfaces and sweep-after-adapters have disjoint valid
  // ranges; the split is forced, not stylistic. Unguarded on purpose: the
  // restart sweep self-contains its own failures (pool.start), so the only
  // throw that reaches here is an ensureIndexes failure — boot-fatal like
  // every other boot-time datastore failure.
  await workerPool.start();
  log.info("Meeting worker pool started", {
    enabled: config.meetingWorkers.enabled,
    maxConcurrent: config.meetingWorkers.maxConcurrent,
    perMeetingMax: config.meetingWorkers.perMeetingMax,
  });
```

- [ ] **Step 4:** Verify the file still typechecks and is formatted.

Run: `npm run typecheck && npx prettier --check src/index.ts`
Expected: no errors. (Both `workerPool` and `meetingScribe` are declared with `const` at their new site and referenced later in the file — e.g. `workerPool.stop()`/`meetingScribe.stop()` in the shutdown handler around `:916-917` — TypeScript's block-scoping means these references now resolve to the earlier declaration; there is no forward-reference issue since the whole file is one function body executed top-to-bottom.) If prettier reports drift, `npx prettier --write src/index.ts` and re-check.

- [ ] **Step 5:** Commit.

```bash
git add src/index.ts
git commit -m "fix(kpr-414): wire worker pool + scribe before any spawn-capable surface starts

index.ts states its own boundary invariant (KPR-394, :399-406) — wire
anything a turn reads per spawn BEFORE bgTaskManager.start() and every
other spawn-capable surface — but the meeting worker pool and scribe
wiring landed ~330 lines and nine surfaces below it. A turn dispatched
in that window silently lost worker-pool tools and the scribe's
summary anchor (self-healing on the next turn, but never ruled on).

D1: split the pool/scribe block. Construction, setWorkerPool, an early
idempotent ensureIndexes() call, MeetingScribe construction, and
setMeetingScribe move above the boundary. workerPool.start() (the
restart sweep + watchdog) deliberately stays at its original site: the
sweep's honest-expiry re-entry is a real boss turn whose delivery
adapter dispatcher.ts resolves BEFORE running the turn, so running the
sweep before Slack-adapter registration would pay for the turn and
silently drop its notice. The two constraints are disjoint; this is
the only site satisfying both.

D2: promote the boundary from a KPR-394-specific comment into a named,
generalized file invariant, now guarded by src/boot-order.test.ts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Task 2: D3 — `src/workers/meeting-worker-pool.ts`

**Files:**
- Modify: `src/workers/meeting-worker-pool.ts:731-736` (`sweepOnRestart`)

- [ ] **Step 1:** Add the `liveWorkers` guard.

Current text:

```ts
  /** Boot sweep: a fresh process can never have live workers, so every
   *  running claim is an orphan — flip unconditionally with notice (E5). */
  private async sweepOnRestart(): Promise<void> {
    const orphans = await this.claims.find({ status: "running" }).toArray();
    for (const claim of orphans) {
      await this.expireClaim(claim, "engine restarted mid-worker");
    }
  }
```

Replace with:

```ts
  /** Boot sweep: a fresh process can never have live workers, so every
   *  running claim is an orphan — flip unconditionally with notice (E5). */
  private async sweepOnRestart(): Promise<void> {
    const orphans = await this.claims.find({ status: "running" }).toArray();
    for (const claim of orphans) {
      // KPR-414: the pool is now WIRED above the spawn-capable boundary but
      // SWEPT after adapter registration, so a boss can legitimately claim in
      // between. A claim this process is actively running is by definition not
      // an orphan — the comment above ("a fresh process can never have live
      // workers") is the premise this guard now enforces.
      if (this.liveWorkers.has(claim._id.toString())) continue;
      await this.expireClaim(claim, "engine restarted mid-worker");
    }
  }
```

- [ ] **Step 2:** Verify the file still typechecks.

Run: `npm run typecheck`
Expected: no errors. (`this.liveWorkers` is an existing private field on the class — confirm its exact name/type by reading the class body if the typecheck surfaces anything unexpected, but it is already used elsewhere in the same file, e.g. the fetch-worker registration path.)

- [ ] **Step 3:** Commit.

```bash
git add src/workers/meeting-worker-pool.ts
git commit -m "fix(kpr-414): restart sweep spares claims this process is actively running

KPR-414's boot-order fix (index.ts) widens the gap between the pool
being wired (dispatchable) and workerPool.start() running the restart
sweep from ~5 lines to nine spawn-capable surface starts. sweepOnRestart's
own stated premise — 'a fresh process can never have live workers, so
every running claim is an orphan' — stops being true in that widened
window: a boss can now legitimately claim before the sweep runs.
Without this guard the sweep would expireClaim() a live claim, aborting
the in-flight worker mid-flight and telling its boss a re-entry reason
('engine restarted mid-worker') that is factually false for a worker
dispatched seconds earlier in this same boot.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Task 3: D4 — `src/workers/meeting-scribe.ts`

**Files:**
- Modify: `src/workers/meeting-scribe.ts:106-188` (class fields, `noteActivity`, `stop`)
- Modify: `src/workers/meeting-scribe.ts:218-244` (`run`, checkpoint 2 + checkpoint 3)

- [ ] **Step 1:** Add the `stopped` field and the exported error-message constant.

Current text (`meeting-scribe.ts:106-116`):

```ts
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
```

Replace with:

```ts
/** Thrown out of the scribe's onAbortHandle callback when stop() has already
 *  latched. Exported so the test can pin the mechanism, not the prose. */
export const SCRIBE_STOPPED_ERROR = "meeting scribe stopped before turn start";

export class MeetingScribe {
  private readonly summaries: Collection<MeetingSummaryDoc>;
  private readonly inFlight = new Set<string>();
  private readonly abortHandles = new Map<string, () => void>();
  private readonly lastRunAt = new Map<string, number>();
  private readonly now: () => Date;
  private stopped = false;

  constructor(private readonly deps: MeetingScribeDeps) {
    this.summaries = deps.db.collection<MeetingSummaryDoc>("meeting_summaries");
    this.now = deps.now ?? (() => new Date());
  }
```

- [ ] **Step 2:** Add checkpoint 1 (gate 0) to `noteActivity`, and update `stop()` to set the latch before its sweep.

Current text (`meeting-scribe.ts:150-188`):

```ts
  noteActivity(args: NoteActivityArgs): void {
    const cfg = this.deps.config;
    if (!cfg.enabled || !cfg.scribeEnabled) return; // gate 1
```

Replace with:

```ts
  noteActivity(args: NoteActivityArgs): void {
    if (this.stopped) return; // gate 0 — shutdown latched; see stop()
    const cfg = this.deps.config;
    if (!cfg.enabled || !cfg.scribeEnabled) return; // gate 1
```

(Everything else in `noteActivity`, from `const { threadId } = args;` through the closing `finally` block, is unchanged.)

Current text (`meeting-scribe.ts:178-188`):

```ts
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
```

Replace with:

```ts
  /** Aborts every live scribe run. Scribes are not in the pool's liveWorkers,
   *  so pool.stop()/abortForBoss deliberately do not reach them (spec §D3/E5). */
  stop(): void {
    this.stopped = true; // latch BEFORE the sweep — anything minted after this
    // point self-refuses at the onAbortHandle checkpoint
    for (const [threadId, abort] of this.abortHandles) {
      try {
        abort();
      } catch (err) {
        log.warn("Scribe abort threw during stop — contained", { threadId, error: String(err) });
      }
    }
  }
```

- [ ] **Step 3:** Add checkpoint 2 (pre-spawn) in `run()`, after the E8 registry re-check and before the `updating` write.

Current text (`meeting-scribe.ts:214-221`):

```ts
    // E8 — live registry re-check (mirrors spawnFetchWorker's re-check).
    const base = this.deps.registry.get(args.baseAgentId);
    if (!base || base.disabled) return;

    const startedAt = this.now();
    await this.summaries
      .updateOne({ _id: threadId }, { $set: { updating: { startedAt }, updatedAt: startedAt } }, { upsert: true })
      .catch((err) => log.warn("Scribe updating-flag write failed — proceeding", { error: String(err) }));
```

Replace with:

```ts
    // E8 — live registry re-check (mirrors spawnFetchWorker's re-check).
    const base = this.deps.registry.get(args.baseAgentId);
    if (!base || base.disabled) return;

    if (this.stopped) return; // checkpoint 2 — shutdown began while this run awaited Mongo

    const startedAt = this.now();
    await this.summaries
      .updateOne({ _id: threadId }, { $set: { updating: { startedAt }, updatedAt: startedAt } }, { upsert: true })
      .catch((err) => log.warn("Scribe updating-flag write failed — proceeding", { error: String(err) }));
```

- [ ] **Step 4:** Add checkpoint 3 — the throwing `onAbortHandle` callback.

Current text (`meeting-scribe.ts:244`):

```ts
        onAbortHandle: (abort) => this.abortHandles.set(threadId, abort),
```

Replace with:

```ts
        onAbortHandle: (abort) => {
          // KPR-414 checkpoint 3. stop() makes a single synchronous pass over
          // abortHandles; a handle minted after that pass would be an orphan.
          //
          // ⚠ We THROW rather than calling `abort()`, and that is load-bearing,
          // not stylistic. runRoleTurn invokes this callback at
          // meeting-worker-pool.ts:600, one line BEFORE adapter.runTurn() at
          // :601 — and ClaudeAgentAdapter.abort() → AgentRunner.abort() is a
          // no-op while activeQuery is null, which it is until deep inside
          // send() (agent-runner.ts:2091). Calling abort() here would return
          // silently having done nothing, and the turn would run to completion
          // unaborted AND unregistered: strictly worse than today.
          //
          // The throw unwinds INSIDE runRoleTurn's single try (:591-623), so
          // adapter.runTurn() is never reached — nothing is spawned, so there
          // is nothing to abort — and its catch (:621-623) contains the throw
          // into a normal error-shaped RoleTurnOutcome, which run()'s existing
          // `outcome.error` branch already handles. runRoleTurn is byte-
          // untouched: onAbortHandle is OUR closure, and throwing from a
          // caller-supplied callback is inside its existing contract.
          if (this.stopped) throw new Error(SCRIBE_STOPPED_ERROR);
          this.abortHandles.set(threadId, abort);
        },
```

- [ ] **Step 5:** Verify the file still typechecks and is formatted.

Run: `npm run typecheck && npx prettier --check src/workers/meeting-scribe.ts`
Expected: no typecheck errors. If prettier reports a formatting issue (the multi-line trailing comment on `stop()`'s new first line is a likely spot — prettier collapses aligned trailing-comment continuations), run `npx prettier --write src/workers/meeting-scribe.ts` and re-check — `npm run check`'s `format:check` step is non-fixing and will fail the whole gate on any drift.

- [ ] **Step 6:** Commit.

```bash
git add src/workers/meeting-scribe.ts
git commit -m "fix(kpr-414): MeetingScribe.stop() actually stops — a stopped latch at three checkpoints

stop() was a snapshot sweep of abortHandles: it latched nothing, so a
noteActivity call racing shutdown could pass every gate and start a
fresh role turn whose abort handle nobody would ever call. Three
windows stayed open after stop() returned: a fresh noteActivity call,
a run() already past its gates and awaiting Mongo, and a handle
registered after stop()'s sweep had already iterated.

Adds a `stopped` latch checked at three points: gate 0 in
noteActivity (synchronous, above the existing single-flight claim),
a pre-spawn check in run() before the updating-flag write (so a
shutdown-interrupted run leaves no stub doc), and inside the
onAbortHandle callback.

The third checkpoint THROWS rather than calling the abort() it was
handed — calling abort() there is a guaranteed no-op, since
onAbortHandle fires one statement before AgentRunner's query even
exists, so AgentRunner.abort() has nothing to act on. The throw is
absorbed by runRoleTurn's own existing try/catch (its documented
'never throws' contract), unwinding before adapter.runTurn() is ever
called — nothing is spawned, so there is nothing to leak, and
runRoleTurn needs zero edits.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Task 4: Tests

**Files:**
- Create: `src/boot-order.test.ts` (T1)
- Modify: `src/workers/meeting-worker-pool.test.ts` (T5)
- Modify: `src/workers/meeting-scribe.test.ts` (harness fidelity fix, T2/T3/T4)

- [ ] **Step 0: Import `SCRIBE_STOPPED_ERROR`.** T4 (Step 4) references it directly — without this the file fails to compile before any test runs.

Current text (`meeting-scribe.test.ts` top-of-file import):

```ts
import {
  MeetingScribe,
  scribeCharter,
  scribeTurnPrompt,
  SUMMARY_TEXT_CAP,
  type NoteActivityArgs,
  type ScribeMessage,
} from "./meeting-scribe.js";
```

Replace with:

```ts
import {
  MeetingScribe,
  scribeCharter,
  scribeTurnPrompt,
  SUMMARY_TEXT_CAP,
  SCRIBE_STOPPED_ERROR,
  type NoteActivityArgs,
  type ScribeMessage,
} from "./meeting-scribe.js";
```

- [ ] **Step 1: Harness fidelity fix in `meeting-scribe.test.ts`'s `makeFakePool()`.**

Locate `makeFakePool()` (`:149-183`). Its `runRoleTurn` currently invokes `args.onAbortHandle?.(abort)` **outside** any try/catch — the real `runRoleTurn` (`meeting-worker-pool.ts:591-623`) wraps that call and the turn body in the same try, with a catch returning `{ error, durationMs }`. Current exact text:

```ts
  const runRoleTurn = vi.fn(async (args: any) => {
    const threadId = args.workItemContext.threadId as string;
    const abort = vi.fn();
    abortByThread.set(threadId, abort);
    args.onAbortHandle?.(abort);
    return impl(args);
  });
```

Replace with:

```ts
  const runRoleTurn = vi.fn(async (args: any) => {
    const threadId = args.workItemContext.threadId as string;
    const abort = vi.fn();
    // KPR-414 (T4 fidelity): the real runRoleTurn wraps the onAbortHandle
    // call and the turn body in ONE try/catch (meeting-worker-pool.ts
    // :591-623), containing a throw from onAbortHandle into an
    // error-shaped outcome rather than letting it escape. This fake must
    // mirror that or T4 (checkpoint 3's throw-based containment) would
    // pass against a fake that doesn't actually exercise the real contract.
    try {
      abortByThread.set(threadId, abort);
      args.onAbortHandle?.(abort);
      return await impl(args);
    } catch (err) {
      return { error: String(err).slice(0, 2000), durationMs: 0 };
    }
  });
```

No existing row in the file passes a throwing `onAbortHandle` callback, so this change alone does not affect any existing test's outcome — empirically confirmed: all 35 pre-existing rows still pass after this step alone, before adding T2-T4.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/workers/meeting-scribe.test.ts`
Expected: same pass count as before this step (pure fidelity fix, no new tests yet).

- [ ] **Step 2: T2 — `noteActivity` after `stop()` is inert (gate 0).** Add to the existing `stop() (D2i)` describe (`:812-840`, before its closing `});`):

```ts
  it("T2 (KPR-414): noteActivity after stop() does nothing (gate 0)", async () => {
    const f = makeScribe();
    f.scribe.stop();
    f.scribe.noteActivity(makeArgs());
    await flush();
    expect(f.pool.runRoleTurn).not.toHaveBeenCalled();
    expect(summarySnapshot(f.summaries)).toEqual([]);
    expect(f.summaries.updateCalls).toEqual([]);
    // Distinguishes gate 0 from checkpoint 2: checkpoint 2 sits AFTER the
    // summary read inside run(), so removing gate 0 alone would still block
    // the write via checkpoint 2 — the three assertions above would still
    // pass and this test would silently stop covering gate 0. findOne must
    // never even be reached.
    expect(f.summaries.findOne).not.toHaveBeenCalled();
  });
```

**Negative-verify (empirically confirmed against the live worktree during plan-writing):** temporarily remove the `if (this.stopped) return;` line from `noteActivity` (Task 3 Step 2) → confirmed the first three assertions do NOT fail on their own, because checkpoint 2 (Task 3 Step 3) independently blocks the write later in `run()` — only the `findOne` assertion catches gate 0's removal. This is why that assertion is required, not optional polish. Restore before proceeding.

- [ ] **Step 3: T3 — a run past the gates does not spawn if `stop()` lands during its Mongo read (checkpoint 2).**

```ts
  it("T3 (KPR-414): stop() landing during the summary read prevents the spawn (checkpoint 2)", async () => {
    const f = makeScribe();
    f.summaries.findOne.mockImplementationOnce(async () => {
      f.scribe.stop();
      return null;
    });
    f.scribe.noteActivity(makeArgs());
    await flush();
    expect(f.pool.runRoleTurn).not.toHaveBeenCalled();
    expect(f.summaries.updateCalls).toEqual([]);
  });
```

**Negative-verify (empirically confirmed):** temporarily remove the `if (this.stopped) return;` line from `run()` (Task 3 Step 3) → `runRoleTurn` is called; this test fails. Restore before proceeding.

- [ ] **Step 4: T4 — a turn whose handle is minted after `stop()` is never started (checkpoint 3).** This is the row that pins the blocker fix. Do not write it as "assert `abort` was called" — that assertion is exactly what would let an inert `abort()`-based checkpoint 3 pass review; it must assert the turn never ran.

Spec T4's assertion (1) requires routing the turn body through a dedicated `vi.fn()` probe — a plan-review round flagged an earlier draft's reliance on inferring "never started" from assertions (2)/(3) alone as not actually implementing the spec's stated mechanism. `makeFakePool()` already exposes `setImpl()` for exactly this.

```ts
  it("T4 (KPR-414): a handle minted after stop()'s sweep is never started, and the mechanism is a throw, not an inert abort (checkpoint 3)", async () => {
    const f = makeScribe();
    // Seed a prior summary so "unchanged" (assertion 2) is a real check, not
    // a vacuous [] === [] comparison against an upsert-created row.
    f.summaries.docs.push({
      _id: THREAD,
      summaryText: "PRIOR",
      coveredThroughTs: "0",
      version: 1,
      updatedAt: new Date(BASE_EPOCH - 300_000),
    });

    // Route the turn body through a dedicated probe — this mock IS the
    // "did the turn start?" probe, standing in for adapter.runTurn(), which
    // in the real pool is the statement immediately after onAbortHandle.
    const implProbe = vi.fn(async () => ({ text: DEFAULT_SUMMARY, costUsd: 0.002, durationMs: 400 }));
    f.pool.setImpl(implProbe);

    // f.summaries.updateOne is a plain method, not vi.fn-backed (unlike
    // findOne) — delegate-patch it, mirroring the f.claims.find swap at
    // meeting-worker-pool.test.ts:679-682, so its FIRST call (the checkpoint-2
    // `updating` write) triggers stop() before returning, landing stop()
    // strictly between checkpoint 2 and checkpoint 3.
    const realUpdateOne = f.summaries.updateOne.bind(f.summaries);
    let armed = true;
    f.summaries.updateOne = (async (...callArgs: [any, any, any?]) => {
      if (armed) {
        armed = false;
        f.scribe.stop();
      }
      return realUpdateOne(...callArgs);
    }) as any;

    f.scribe.noteActivity(makeArgs());
    await flush();

    // (1) the impl probe was NEVER called — the turn was never started. Not
    // sufficient alone (a fully-gated noteActivity would make this trivially
    // true with zero calls at all) — see (3), the anti-vacuity guard.
    expect(implProbe).not.toHaveBeenCalled();

    // (2) the prior summary survives untouched (the updating stub/clear
    // cycle is excluded by summarySnapshot's projection) — proving the run
    // left no trace beyond the expected stub/clear cycle run()'s finally
    // already performs on every path.
    expect(summarySnapshot(f.summaries)).toEqual([
      { _id: THREAD, summaryText: "PRIOR", coveredThroughTs: "0", version: 1 },
    ]);

    // (3) THE ANTI-VACUITY GUARD. Dereferencing mock.results[0] on zero calls
    // throws, so this alone closes the "gated out entirely" hole (1) leaves
    // open (empirically confirmed: forcing noteActivity to return
    // immediately makes this assertion — specifically the toHaveBeenCalledTimes(1)
    // check — fail, rather than letting (1)/(4) pass vacuously). The outcome
    // is contained, not an escaped rejection, and carries the specific
    // SCRIBE_STOPPED_ERROR marker — proving the mechanism is checkpoint 3's
    // throw, not some other failure or a silently-inert abort() call.
    expect(f.pool.runRoleTurn).toHaveBeenCalledTimes(1);
    const outcome = await f.pool.runRoleTurn.mock.results[0].value;
    expect(outcome.error).toContain(SCRIBE_STOPPED_ERROR);

    // (4) no handle was ever registered in the scribe's OWN abortHandles map.
    // f.pool.abortByThread is a test-fixture tracking map the fake sets
    // unconditionally BEFORE invoking onAbortHandle (see Step 1's fidelity
    // fix), so it is populated regardless of whether the callback throws —
    // asserting it is undefined is WRONG (empirically confirmed: it fails,
    // because the map always has an entry). Observe indirectly instead: if
    // checkpoint 3's throw had NOT prevented `this.abortHandles.set(...)`
    // from running, a second stop() would find that entry and invoke abort()
    // on it. It must not.
    const abort = f.pool.abortByThread.get(THREAD)!;
    abort.mockClear();
    f.scribe.stop();
    expect(abort).not.toHaveBeenCalled();
  });
```

**Sibling test — T4 containment cross-check (spec's "Testing" T4 final bullet).** The spec separately requires confirming `noteActivity` did not reject and the scribe's shared lifecycle `finally` released its maps on this path too — `inFlight`/`abortHandles` are private, so "maps are empty" isn't directly assertable from outside, and reusing the same scribe instance after it has already called `stop()` doesn't work either (gate 0 blocks everything unconditionally once latched, so a same-instance recheck can't distinguish "maps released" from "gate 0 blocked it" — confirmed empirically: an earlier draft's same-instance recheck asserted a second call went through, which is false once `stop()` has latched). The genuinely testable proxy is the pool suite's own precedent for the identical class of claim (`meeting-worker-pool.test.ts` "review r1" row) — an `unhandledRejection` listener around the fresh instance's run:

```ts
  it("T4 containment cross-check (KPR-414): checkpoint 3's throw never escapes as an unhandled rejection", async () => {
    // `noteActivity`'s detached chain is `void this.run(args).catch(...).finally(...)`
    // (meeting-scribe.ts) — the `.catch()` is what must contain checkpoint
    // 3's throw. Mirrors the pool suite's own precedent for the same class
    // of claim (meeting-worker-pool.test.ts "review r1" row).
    const f = makeScribe();
    f.summaries.docs.push({
      _id: THREAD,
      summaryText: "PRIOR",
      coveredThroughTs: "0",
      version: 1,
      updatedAt: new Date(BASE_EPOCH - 300_000),
    });
    const realUpdateOne = f.summaries.updateOne.bind(f.summaries);
    let armed = true;
    f.summaries.updateOne = (async (...callArgs: [any, any, any?]) => {
      if (armed) {
        armed = false;
        f.scribe.stop();
      }
      return realUpdateOne(...callArgs);
    }) as any;

    const rejections: unknown[] = [];
    const handler = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", handler);
    try {
      f.scribe.noteActivity(makeArgs());
      await flush();
      await new Promise((r) => setTimeout(r, 20)); // let a late rejection surface before asserting
    } finally {
      process.off("unhandledRejection", handler);
    }
    expect(rejections).toEqual([]);
  });
```

Note: `f.pool.runRoleTurn`'s fake resolves via Step 1's try/catch wrapper — since the callback throws synchronously inside that try, `runRoleTurn` itself is still "called" (assertion count 1) but its returned outcome is the caught error, never a real turn result. Do not assert `not.toHaveBeenCalled()` on `runRoleTurn` itself — the attempt happens; what must never happen is the turn BODY completing, which assertions (1)/(2)/(3)/(4) together establish.

**Negative-verify (three variants, all empirically confirmed against the live worktree before trusting any):**
1. Replace checkpoint 3's `throw new Error(SCRIBE_STOPPED_ERROR)` with the inert design `if (this.stopped) { abort(); return; }` → confirmed failure on assertion (1): `implProbe` runs to completion, because the inert `abort()` cannot prevent the turn.
2. Remove checkpoint 3 entirely (the `if (this.stopped) ...` line, keeping only `this.abortHandles.set(threadId, abort);`) → confirmed identical failure mode to variant 1 (assertion (1) fails the same way).
3. Gate `noteActivity` out entirely (e.g. an unconditional early `return;` at the top, simulating checkpoint 1 always firing) → confirmed assertions (1)/(4) pass vacuously (zero calls), but assertion (3)'s `expect(f.pool.runRoleTurn).toHaveBeenCalledTimes(1)` fails — confirming (3) is load-bearing, not decorative, and no variant (inert or vacuous) can turn this row green.

Restore checkpoint 3 to its Task 3 Step 4 form before proceeding.

- [ ] **Step 5: T5 — the restart sweep spares a live claim (D3), in `meeting-worker-pool.test.ts`.**

Uses the pool test file's own `makeFixture()`/`seedClaim()`/`dispatchReq()`/`vi.waitFor` idiom (`:96-203`) and the existing restart-sweep test (`:630`, T6) as a model. `makeFixture()` already calls `pool.bindManager(hooks)`, so `dispatch()` works without `start()` — this is exactly the pre-sweep dispatch window D3 exists for. `runWorkerTurn` (`meeting-worker-pool.ts:497-498`) calls `this.liveWorkers.set(claimId, ...)` synchronously, one line before it awaits the (here, never-resolving) `adapter.runTurn(...)` — so `buildWorkerAdapter` having been called is the correct, verified signal that `liveWorkers` is populated.

⚠ **Place this row in the same describe as T6** — `MeetingWorkerPool — spawn, completion, re-entry (Task E)` (`:446-690`), right beside T6 (`:630`) and the `review r1` row (`:650`), NOT in the file's third describe (`— watchdog interval (fake timers)`, `:690+`), which runs `vi.useFakeTimers()` in its own `beforeEach` and would change `vi.waitFor`'s semantics and the watchdog interval this row's `stop()` call relies on clearing. (A plan-review round correctly flagged the describe choice as unstated and the fake-timers risk as real, but misnamed the target as "claim ledger + gates (Task D)" — confirmed by reading the file directly: T6 and the row this test sits beside are both inside Task E, not Task D. Task E, beside T6, is correct.)

Add a new row:

```ts
  it("T5 (KPR-414): sweepOnRestart spares a claim this process is actively running", async () => {
    const f = makeFixture({ runTurnImpl: () => new Promise(() => {}) }); // held forever — worker stays "live"
    const orphan = seedClaim(f.claims, { taskText: "orphan-task" });
    await f.pool.dispatch(dispatchReq("live-task"));
    // Wait for the detached runWorkerTurn to reach buildWorkerAdapter — that
    // call is what registers the claim in liveWorkers, synchronously and
    // BEFORE the (never-resolving) runTurn await.
    await vi.waitFor(() => expect(f.hooks.buildWorkerAdapter).toHaveBeenCalled());
    const live = f.claims.docs.find((d) => d.taskText === "live-task")!;
    expect(live.status).toBe("running");

    await f.pool.start();

    // Spared — this process is actively running it. Assert BEFORE stop():
    // stop() itself aborts every live worker as normal shutdown behavior,
    // unrelated to (and would mask) the sweepOnRestart guard under test.
    expect(f.claims.docs.find((d) => d._id.toString() === live._id.toString())!.status).toBe("running");
    expect(f.abortSpy).not.toHaveBeenCalled(); // the live worker was never aborted BY THE SWEEP
    expect(f.onDispatch).toHaveBeenCalledTimes(1); // the orphan's re-entry only — the live claim fires none

    // The true orphan is still expired with the normal notice.
    const orphanAfter = f.claims.docs.find((d) => d._id.toString() === orphan._id.toString())!;
    expect(orphanAfter.status).toBe("expired");
    expect(orphanAfter.error).toBe("engine restarted mid-worker");

    f.pool.stop(); // clear the watchdog interval, per this file's own T6 precedent
  });
```

⚠ **Assertion ordering is load-bearing, empirically confirmed.** An earlier draft of this row called `f.pool.stop()` before asserting `f.abortSpy`, and that assertion failed — `stop()` itself unconditionally aborts every remaining live worker (`meeting-worker-pool.ts:238-244`, normal shutdown behavior, unrelated to D3). Assert the "never aborted by the sweep" claim strictly before calling `stop()`, or the assertion tests the wrong thing.

The `onDispatch` count directly pins the spec's "fires no re-entry" clause for the live claim (spec T5) — without it, "no re-entry from the live claim" was only implied by the status assertion, not directly checked.

**Negative-verify (empirically confirmed):** temporarily remove the D3 guard (Task 2 Step 1, `if (this.liveWorkers.has(claim._id.toString())) continue;`) → confirmed failure: `expect(...).toBe("running")` on the live claim's status fails with `expected 'expired' to be 'running'` — the sweep expired it exactly as the guard exists to prevent.

- [ ] **Step 6: T1 — boot-order guard, `src/boot-order.test.ts` (new file).**

Spec T1 bullet 4 requires this file to document, in-comment, that the named anchor set is partial and what covers the residual — a plan-review round confirmed this was missing from an earlier draft. It is included below.

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// KPR-414: index.ts states its own boundary invariant (KPR-394, restated at
// the "Spawn-capable boundary" marker) but nothing enforced it — the
// worker-pool/scribe wiring silently landed ~330 lines below it. This test
// is a text-scan, not an import: index.ts is a side-effecting main() that
// would boot the engine if imported directly.
//
// The named anchor set in (a)/(b) is an ANCHOR SET, not an exhaustive
// inventory of every spawn-capable surface in the file. outageReplayProcessor
// .start() (index.ts:~840) is a real spawn-capable surface deliberately not
// named here — it sits below the wiring already, so naming it adds nothing
// to the ordering bound. Coverage for surfaces NOT named here comes from (c)'s
// superset sweep, which fails on any unallowlisted `.start(`/`.scanOrphans(`
// occurring before the wiring, named or not. The one residual (c) does not
// close: a spawn-capable surface that starts itself through some spelling
// other than `.start(`/`.scanOrphans(` — accepted, not exhaustive.
describe("boot order — spawn-capable boundary (KPR-414)", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  // Strip `//` line comments before scanning — the boundary marker comment
  // itself contains the substring "bgTaskManager.start()" in prose, which
  // would otherwise be a false-positive match for both the anchor scan and
  // the superset sweep below.
  const codeOnly = source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  function offsetOf(needle: string): number {
    const i = codeOnly.indexOf(needle);
    expect(i, `anchor not found: ${JSON.stringify(needle)} — index.ts may have been renamed/refactored; update this test's anchors`).toBeGreaterThanOrEqual(0);
    return i;
  }

  it("(a) named wiring and surface anchors are all present", () => {
    // Presence-only pass; offsetOf's own expect() does the assertion. Calling
    // each once here documents the full anchor set in one place.
    offsetOf("await agentManager.activateProviderPlugins()");
    offsetOf("agentManager.setWorkerPool(");
    offsetOf("await workerPool.ensureIndexes()");
    offsetOf("dispatcher.setMeetingScribe(");
    offsetOf("await bgTaskManager.start()");
    offsetOf("await bgTaskManager.scanOrphans()");
    offsetOf("await codeTaskManager.start()");
    offsetOf("await slackAdapter.start(");
    offsetOf("await smsAdapter.start(");
    offsetOf("scheduler.start()");
  });

  it("(b) wiring precedes every named spawn-capable surface", () => {
    const wiringOffsets = [
      offsetOf("agentManager.setWorkerPool("),
      offsetOf("await workerPool.ensureIndexes()"),
      offsetOf("dispatcher.setMeetingScribe("),
    ];
    const surfaceOffsets = [
      offsetOf("await bgTaskManager.start()"),
      offsetOf("await bgTaskManager.scanOrphans()"),
      offsetOf("await codeTaskManager.start()"),
      offsetOf("await slackAdapter.start("),
      offsetOf("await smsAdapter.start("),
      offsetOf("scheduler.start()"),
    ];
    const maxWiring = Math.max(...wiringOffsets);
    const minSurface = Math.min(...surfaceOffsets);
    expect(maxWiring).toBeLessThan(minSurface);
  });

  it("(c) no unallowlisted spawn-capable start precedes the wiring (superset sweep)", () => {
    const wiringStart = offsetOf("agentManager.setWorkerPool(");
    // Known non-spawn-capable `.start(`/`.scanOrphans(` calls that legitimately
    // precede the wiring. Adding to this list is a deliberate, reviewed
    // classification decision — not a way to silence a real finding.
    const allowlist = ["dbIdentityMonitor.start(", "contactsWatcher.start("];
    const pattern = /\.(start|scanOrphans)\s*\(/g;
    let match: RegExpExecArray | null;
    const offenders: string[] = [];
    while ((match = pattern.exec(codeOnly)) !== null) {
      if (match.index >= wiringStart) continue; // only care about matches BEFORE the wiring
      const context = codeOnly.slice(Math.max(0, match.index - 40), match.index + match[0].length);
      if (allowlist.some((a) => context.includes(a))) continue;
      offenders.push(context.trim());
    }
    expect(offenders, "an unallowlisted spawn-capable start/scanOrphans precedes the wiring — classify it (allowlist if inert, move the wiring if not)").toEqual([]);
  });
});
```

**Negative-verify (empirically confirmed — all three run against the live worktree during plan-writing):**
1. Swap in the pre-fix `index.ts` wholesale — ⚠ do NOT use `git show HEAD:src/index.ts` to fetch it: by the time this step runs, Tasks 1-3 are already committed, so `HEAD` points at the POST-fix file and this negative-verify would be vacuous (confirmed this exact mistake during plan-writing — using `HEAD` here silently passes all three assertions instead of failing them). Use the specific pre-KPR-414 commit instead: `git show 9a9e8ba:src/index.ts > /tmp/index-pre-fix.ts && cp /tmp/index-pre-fix.ts src/index.ts` (`9a9e8ba` is the "spec review r3 approved" commit — the epic-branch head this plan's lane was created from, before any KPR-414 code landed; confirm with `git log --oneline` if the branch has since diverged) → confirmed all three tests (a)/(b)/(c) fail together: (a)/(b) because the wiring calls now sit after the surface calls, (c) with a 17-entry offender list (every spawn-capable surface in the file) — a strong signal this guard is genuinely discriminating pre-fix from post-fix state, not just checking for anchor presence.
2. Insert `fooAdapter.start();` immediately above `agentManager.activateProviderPlugins()` (before the wiring) → confirmed test (c) fails with exactly one offender containing `fooAdapter.start(`.

Restore `index.ts` to its Task 1 (post-fix) state before proceeding — do not leave the pre-fix swap or the scratch insertion in place.

- [ ] **Step 7:** Run the full target set and confirm everything passes.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/boot-order.test.ts src/workers/meeting-worker-pool.test.ts src/workers/meeting-scribe.test.ts`
Expected: all tests pass, including the existing rows in both worker-pool and scribe suites (no regressions) and all new T1-T5 rows.

- [ ] **Step 7b:** Format check.

Run: `npx prettier --check src/boot-order.test.ts src/workers/meeting-worker-pool.test.ts src/workers/meeting-scribe.test.ts`
Expected: no drift. `printWidth` is 120 and `format:check` (part of `npm run check`) is non-fixing, so any drift here fails Task 5's gate later rather than just this one. If prettier reports issues (a few of T1's longer `expect(...)` failure-message lines are a likely spot), run `npx prettier --write` on the same file list and re-check.

- [ ] **Step 8:** Commit.

```bash
git add src/boot-order.test.ts src/workers/meeting-worker-pool.test.ts src/workers/meeting-scribe.test.ts
git commit -m "test(kpr-414): regression coverage for boot-order guard, restart-sweep guard, and the scribe stop() latch

T1 (new src/boot-order.test.ts): a text-scan guard on index.ts pinning
that worker-pool/scribe wiring precedes every named spawn-capable
surface, with a superset sweep so an unnamed future surface introduced
above the wiring fails loudly instead of silently. Comments are
stripped before scanning — the boundary marker's own prose would
otherwise false-positive against both passes.

T2-T4 (meeting-scribe.test.ts): the three stopped-latch checkpoints,
including a required harness fidelity fix to makeFakePool() so its
runRoleTurn mirrors the real one's try/catch containment. T4 is
deliberately not written as "assert abort was called" — that
assertion is exactly what let an inert checkpoint-3 design through an
earlier review round; it routes the turn body through a dedicated
probe to assert it never started, and pins the throw-based mechanism
via SCRIBE_STOPPED_ERROR, which cannot pass under an inert-abort, a
missing-checkpoint, or a fully-gated-out variant. A sibling row proves
the throw never escapes as an unhandled rejection.

T5 (meeting-worker-pool.test.ts): the restart sweep spares a claim
this process is actively running, fires no re-entry for it, and the
full pre-fix residual (expired status, mid-flight abort, false
re-entry reason) is asserted in the negative-verify pass.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Task 5: Full regression + push

- [ ] **Step 1:** Run the full check suite.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: exit 0 — typecheck, lint, format, and the full test suite all pass.

- [ ] **Step 2:** Confirm the commits are ready to push (pushing itself is the deliver-ticket lane's own submit-ticket-pr step — not part of this plan's scope).

Run: `git log --oneline -5`
Expected: the four commits from Tasks 1-4, on top of the epic branch head this lane branched from.
