# KPR-414 — Meeting-mode operational hardening: boot-order gap for pool/scribe wiring, scribe `stop()` shutdown race

**Epic:** KPR-386 (meeting mode) · **Kind:** corrective child, filed by the epic's integrated-head review r1 (findings 3 and 5, both severity: minor)
**Origin:** two low-impact, self-healing operational-hygiene defects from the same review round, bundled into one mechanical ticket. Both are boundary-of-process bugs (boot, shutdown), neither is a running-state defect.
**Status:** spec-ready (spec review round 2 — approved after fixes, caught-by: spec-review/2/opus; verified against the epic head at `bf4409d`; r2 applied spec-review r1's blocker + five should-fix findings, r3 applies spec-review r2's four should-fix findings, all in T1(c)'s scan and T4's test mechanics)

## TL;DR

Two process-boundary gaps in the KPR-390/KPR-409 wiring. **(1)** `agentManager.setWorkerPool` and `dispatcher.setMeetingScribe` run at `index.ts:760`/`:787`, ~330 lines *after* the first spawn-capable surface starts (`bgTaskManager.start()`, `:426`) — violating the invariant `index.ts:399-406` states in its own words for provider-plugin activation; a turn dispatched in that window silently loses the worker-pool tools and the summary anchor. **(2)** `MeetingScribe.stop()` aborts the handles it can see and latches nothing, so a `noteActivity` racing shutdown can start a fresh role turn whose abort handle nobody will ever call. The fix is a **split move** — wiring (plus an early, idempotent `workerPool.ensureIndexes()`) goes above the boundary, `workerPool.start()` (boot sweep) deliberately stays below Slack-adapter registration, because no single site satisfies both constraints — a **required** `liveWorkers` guard on the boot sweep, a three-point `stopped` latch in the scribe whose decisive checkpoint **throws out of `onAbortHandle`** so the turn is never started, and one source-order guard test.

## ⚠ Key Points

1. **Verified against live code at `bf4409d`, not transcribed from the findings.** Boundary rule: `index.ts:399-406` (comment) + `:406` (`await agentManager.activateProviderPlugins()`). First spawn-capable surface: `:426-427`. Pool block: `:748-770` (wiring at `:760`, `start()` at `:765`). Scribe block: `:772-792` (wiring at `:787`). Per-turn pool read: `agent-manager.ts:733-735`. Scribe seams: `dispatcher.ts:1601`, `:1954` (cadence), `:1740` (anchor). Scribe lifecycle: `meeting-scribe.ts:150-176` (`noteActivity`), `:180-188` (`stop`), `:244` (handle registration). Pool comparison: `meeting-worker-pool.ts:233-245`. Abort lifecycle (r2, the blocker's evidence): `meeting-worker-pool.ts:591-623` (`runRoleTurn`'s single try, catch at `:621-623`), `claude-agent-adapter.ts:21-23`, `agent-runner.ts:343` (`activeQuery = null`), `:2091` (assigned), `:2434-2441` (`abort()` is a **no-op** while `activeQuery` is null).
2. **Finding 3's impact is exactly as filed, and self-heals.** `AgentManager.createProviderAdapter` reads `this.workerPool` **per spawn** (`agent-manager.ts:733-735`), and both dispatcher scribe seams are `this.meetingScribe?.` optional chains — so an in-window turn degrades to byte-identical pre-epic behavior and the next turn is whole. Nothing is persisted wrong; there is nothing to migrate.
3. **The fix is a split move, and the split is forced, not stylistic.** Constraint A (wiring precedes the first spawn-capable surface) requires a site above `:426`. Constraint B (the boot sweep's honest expiry re-entry must be *deliverable*) requires a site below `dispatcher.registerAdapter(slackAdapter)` at `:566` — `deliverAgentResult` is `if (!sourceAdapter) return;` (`dispatcher.ts:570-572`) and the adapter is resolved **before** the turn runs (`:324`), so an early sweep would pay for a full boss turn and silently drop its output. The two constraints are disjoint. Wiring moves to just after the `Dispatcher` construction (`:414`); `await workerPool.start()` stays exactly where it is. **r2:** the moved block also calls `await workerPool.ensureIndexes()` — the pool's own already-public, idempotent method — so the claim ledger's atomicity index exists before the first surface can start. `start()`'s body is untouched and re-runs it (three `createIndex` no-ops); see Alternatives F for why that beats splitting `start()`.
4. **The move widens one window that an existing comment's premise depends on — and D3 is therefore REQUIRED, not severable (r2).** `sweepOnRestart`'s "a fresh process can never have live workers, so every running claim is an orphan" (`meeting-worker-pool.ts:729-730`) is true only while wiring and `start()` are adjacent. One guard — skip claims currently in `liveWorkers` — restores the premise as code. Without it, an in-window claim is not merely "expired with an honest notice": `expireClaim` (`:738-756`) flips the doc, **aborts the live worker mid-flight**, and fires a re-entry whose stated reason — "engine restarted mid-worker" — is **false** (the worker was dispatched seconds earlier, in this same boot). D1 is what makes that reachable, so D1 without D3 trades one self-healing gap for a new, worse one.
5. **Finding 5 needs more than the pool's shape — and the naive "self-abort" fix is inert (r2 blocker).** A `stopped` boolean alone closes only the outermost window. `run()` awaits Mongo *before* it spawns, and the abort handle is registered *inside* `runRoleTurn`. The latch is therefore checked at three points: gate 0 in `noteActivity` (synchronous, above the C36 claim), a pre-spawn check in `run()` (before the `updating` write, so shutdown leaves no stub doc), and inside the `onAbortHandle` callback. That third checkpoint **throws** — it does not call `abort()`. Calling `abort()` there would be a guaranteed no-op: `onAbortHandle` fires at `meeting-worker-pool.ts:600`, one line *before* `adapter.runTurn()` at `:601`, and `AgentRunner.abort()` (`agent-runner.ts:2434-2441`) does nothing while `activeQuery` is null — which it is until `:2091`, deep inside `send()`. Throwing is what closes the window: `runRoleTurn` invokes the callback **inside the same `try`** that wraps `runTurn` (`:591-623`), so the throw unwinds *before the turn is ever started* and is contained by the existing `catch` into a normal error-shaped `RoleTurnOutcome`. Nothing is spawned, so there is nothing to abort. Checkpoints 1 and 2 exist to avoid paying for Mongo round-trips at all.
6. **Finding 5's literal "clear `abortHandles`" ask is declined, deliberately.** The map is self-cleaning through the shared `finally` (`:168-175`), whose ⚠ comment makes the paired `inFlight`/`abortHandles` release a stated invariant. Clearing one map in `stop()` and not the other splits that pairing to buy nothing — the process is exiting. The latch is the fix; the clear is cosmetics that contradict a live invariant.
7. **This ticket does not touch the pool's `stop()`, `runWorkerTurn`, `spawnFetchWorker`, or `runRoleTurn`.** C24/C34 freeze that surface, and the finding's own comparison establishes that the pool's shape is adequate for the pool. The only pool edit proposed is the `sweepOnRestart` guard (Key Point 4) — outside every frozen function, and named here rather than left for a reviewer to find. Checkpoint 3's throw deliberately rides `runRoleTurn`'s **existing** caller-supplied-callback contract (`onAbortHandle` is the scribe's own closure) precisely so `runRoleTurn` stays byte-untouched.
8. **Finding 3 gets a structural guard, because prose is what failed.** The invariant existed, in the file, in words, and the KPR-390/KPR-409 wiring landed below it anyway. A ~50-line source-order test (`no-deprecated-models.test.ts` precedent) pins wiring-before-boundary, and — per the KPR-228 lesson recorded in that precedent — **fails loudly if any anchor string goes missing**, so a rename cannot silently disable it. r2 adds a superset sweep over every `.start(`/`.scanOrphans(` in the file with a two-entry allowlist, so a spawn-capable surface introduced *above* the wiring fails the guard instead of slipping past a hand-maintained anchor list.
9. **In scope:** move two wiring blocks (plus an early `ensureIndexes()` call), one required sweep guard, one `stopped` latch at three checkpoints, one boundary comment, one new guard test, three scribe tests, one pool test, one small test-harness fidelity fix. **Out of scope:** any lifecycle-management refactor of pool or scribe, a `MeetingScribe.start()`, shutdown-order changes in `index.ts`, any change to `AgentRunner`/`send()`'s abort lifecycle (Open Questions), config knobs, telemetry, docs surfaces.
10. **⚠ Non-blocking (pre-existing, not adopted):** `bgTaskManager.scanOrphans()` (`:427`) already dispatches completion turns before any adapter is registered — the same deliverability hazard constraint B protects the boot sweep from. It is out of scope, and its existence is not a licence to add a second instance.
11. **⚠ Non-blocking (pre-existing, recorded by r2, deliberately not fixed):** an abort handle registered the *normal* way is also inert for a stretch — `onAbortHandle`/`liveWorkers.set` fires before `runTurn`, and `AgentRunner.abort()` does nothing until `send()` assigns `activeQuery` ~150 lines and several awaits later. This affects fetch workers (`meeting-worker-pool.ts:498`) identically. KPR-414 neither introduces nor fixes it; see Open Questions.

---

## Problem

### Finding 3 — the wiring lands below the file's own boundary

`index.ts:399-406` states the rule, for provider plugins, in the file itself:

```ts
  // KPR-394 (§4.3 phase b / §4.6): activate declared provider plugins
  // BEFORE any spawn-capable surface starts — bgTaskManager.start()/
  // scanOrphans() completion callbacks can already dispatch turns, so the
  // await sits here, immediately after construction. The
  // registerPluginCommands slot further down runs after slackAdapter.start
  // and would open a declared-but-unregistered boot window — deliberately
  // not reused.
  await agentManager.activateProviderPlugins();
```

`kpr-394-spec.md:111` is even more explicit: activation must sit "before `bgTaskManager.start()`/`scanOrphans()` …, **not merely before the first channel-adapter start**."

Boot order as it stands:

| `index.ts` | Call | Spawn-capable? |
|---|---|---|
| `:406` | `await agentManager.activateProviderPlugins()` | — (the stated boundary) |
| `:426-427` | `await bgTaskManager.start()` / `scanOrphans()` | **yes** (orphan completions → `dispatcher.dispatch`) |
| `:448-449` | `await codeTaskManager.start()` / `scanOrphans()` | **yes** |
| `:460` | `await meetingMonitor.start()` | **yes** |
| `:566-568` | `registerAdapter(slackAdapter)` / `setSlackAdapter` / `await slackAdapter.start(…)` | **yes** |
| `:623`, `:636`, `:694`, `:734`, `:745` | sms / iMessage / ws / voice / scheduler starts | **yes** |
| `:760` | **`agentManager.setWorkerPool(workerPool)`** | — |
| `:765` | `await workerPool.start()` | — |
| `:787` | **`dispatcher.setMeetingScribe(meetingScribe)`** | — |
| `:840` | `outageReplayProcessor.start()` | **yes** (15s replay poller → `dispatcher`) |

Two spawn-visible capabilities are wired ~330 lines and **nine** spawn-capable surfaces below the boundary the file declares. (The outage replay poller is a tenth, but it sits *below* the pool/scribe blocks, so it does not move the boundary arithmetic — it is listed because it is exactly the kind of surface the T1 "anchor set is partial" caveat exists to catch.) Nothing forced this — the pool's own comment (`:748-749`) explains only that construction must follow the **dispatcher** (`:408`), which is a 6-line constraint, not a 340-line one.

**Impact (verified, and bounded).** For a turn dispatched in the window:

- `createProviderAdapter` reads `this.workerPool` per spawn (`agent-manager.ts:733-735`); `undefined` ⇒ `runnerOptions` omits the pool ⇒ the runner never builds the `worker-pool` in-process server. A boss with `worker-pool` in `coreServers` simply does not see `worker_dispatch`/`worker_status`/`worker_cancel` that turn (a Day-1-OOB layer-2 absence, not an error).
- Both cadence seams (`dispatcher.ts:1601`, `:1954`) and the anchor (`:1740`) are `this.meetingScribe?.` — `undefined` ⇒ no cadence trigger, no summary anchor, full-transcript injection.

Both degrade to exactly pre-epic behavior and self-heal on the next turn. That is why this is minor. It is nonetheless an *accident*: the divergence from a written invariant was never ruled on.

### Finding 5 — `MeetingScribe.stop()` has no effect on work that has not started yet

```ts
  stop(): void {
    for (const [threadId, abort] of this.abortHandles) {
      try { abort(); } catch (err) { log.warn("Scribe abort threw during stop — contained", { threadId, error: String(err) }); }
    }
  }
```

`stop()` is a single synchronous pass over one map — it latches nothing. (The `for…of` reads the live `Map`, but the loop body is synchronous, so nothing can be inserted mid-pass; the gap is everything that happens *after* the pass returns.) Three windows stay open:

1. **`noteActivity` after `stop()`** — every gate (`:152-164`) is a config/debounce/capacity check; none knows about shutdown. It claims `inFlight` and spawns.
2. **`run()` already past the gates** — it awaits `summaries.findOne` (`:194`) and writes the `updating` flag (`:219`) before reaching `runRoleTurn` (`:231`). A `stop()` landing in those awaits is invisible to it.
3. **Handle registration after the pass** — `onAbortHandle` (`:244`) is invoked from inside `runRoleTurn` (`meeting-worker-pool.ts:600`). A handle registered after `stop()` iterated is an orphan by construction.

**And window 3 cannot be closed by aborting (r2).** The obvious fix — have the callback call the `abort` it was handed — is a guaranteed no-op. `runRoleTurn` builds a **fresh** `AgentRunner` per call (`agent-manager.ts:629-645`), invokes `onAbortHandle` at `meeting-worker-pool.ts:600`, and only then calls `adapter.runTurn()` at `:601`. `ClaudeAgentAdapter.abort()` (`claude-agent-adapter.ts:21-23`) delegates to `AgentRunner.abort()` (`agent-runner.ts:2434-2441`), whose entire body is guarded by `if (this.activeQuery)` — and `activeQuery` is `null` at construction (`:343`), assigned only at `:2091`, deep inside `send()`. At the instant `onAbortHandle` fires there is no query, so `abort()` does not even set `_aborted`. Any design that "self-aborts" there is a contract-shaped lie of exactly the kind C38 forbids. D4's checkpoint 3 therefore throws instead.

**Why the scribe has no backstop the pool has.** `MeetingWorkerPool.stop()` (`:233-245`) is the same shape — sweep and return, no latch — but the pool's `dispatch()` is reachable only from an agent's tool call inside a turn, which `agentManager.stopAll()` (`index.ts:927`) aborts, and its spawns are bounded by `maxConcurrent`. The scribe's only entry point is a fire-and-forget dispatcher seam on a conference turn; scribe role turns are deliberately **not** in `liveWorkers` (C35), so `workerPool.stop()` cannot reach them, and they are not manager-registered, so `stopAll()` cannot either.

**And the shutdown order makes the race concrete, not theoretical.** `index.ts` shutdown: `workerPool.stop()` `:916` → `meetingScribe.stop()` `:917` → … → `agentManager.stopAll()` `:927` → `await slackAdapter.stop()` `:932`. The Slack gateway keeps delivering messages, and the dispatcher keeps running conference turns, for fifteen lines and several `await`s after the scribe has "stopped". A conference round in that stretch calls `noteActivity` and starts a haiku turn nothing will ever abort.

**Impact.** Shutdown-only: one orphaned in-flight scribe turn during process exit. The process is going away; the turn dies with it. Worth closing for the reason C38 was invoked three times in this epic — call-site fail-safety is structural, and a `stop()` that does not stop is exactly the contract-shaped lie C38 exists to forbid.

## Goals

- **G1.** Worker-pool and scribe wiring complete before any spawn-capable surface starts, restoring the invariant `index.ts:399-406` states.
- **G2.** The worker pool's boot sweep keeps its deliverable honest-expiry re-entry (KPR-390 E5) — the reorder must not trade one silent gap for another.
- **G3.** After `MeetingScribe.stop()` returns, no scribe role turn can be running unaborted or subsequently started — on every interleaving, including one that races the abort-handle registration. On that racing interleaving the guarantee is delivered by **never starting the turn**, not by aborting it: an abort issued at the registration instant is provably inert (Problem §Finding 5), so a design that relied on one would not meet this goal.
- **G4.** The boot-order invariant is enforced by an executable guard, not only by a comment.
- **G5.** Every KPR-390/KPR-409 behavior survives intact: containment, capacity isolation (C35), single-flight (C36), degrade-silently posture, prompt bytes.

## Non-goals

- **No lifecycle-management refactor** of `MeetingWorkerPool` or `MeetingScribe`. No shared `Lifecycle` base, no `start()` on the scribe, no state machine. This is a latch and a move.
- **No change to `MeetingWorkerPool.stop()`, `runWorkerTurn`, `spawnFetchWorker`, or `runRoleTurn`** (C24/C34). The pool's stop shape is adequate for the pool; making the two symmetric is not a goal.
- **No change to `AgentRunner`, `AgentRunner.send()`, or `AgentRunner.abort()`.** The pre-existing inert-abort window (Key Point 11 / Open Questions) is real and is *not* KPR-414's to fix — touching the runner's abort lifecycle would put a hot, universally-shared spawn path in a two-defect hygiene ticket's blast radius.
- **No change to `index.ts`'s shutdown order.** Moving `meetingScribe.stop()` below `slackAdapter.stop()` would narrow window 1 without closing windows 2 and 3, and reorders a sequence whose comments (`:905-908`) record deliberate constraints. Rejected in favor of the latch.
- **No change to `workerPool.start()`'s own contents** — `ensureIndexes` stays inside it and stays boot-fatal (C27/C40), the sweep stays best-effort, the watchdog interval is untouched. This is not assumed: `start()` is the pool's self-contained "make me operational" contract, relied on by the pool suite's fixtures (`meeting-worker-pool.test.ts:635`, `:683`, `:703`, `:733`) and by D3's new T5. Splitting it (Alternatives F) would buy nothing an extra idempotent `ensureIndexes()` call at the early site does not already buy, and would cost a contract change plus a fixture migration. The one pool-source edit is the D3 guard, inside `sweepOnRestart`, outside every frozen surface.
- **No config knob, no telemetry field, no log-line contract, no `hive doctor` surface, no `docs/providers.md` row.** Rollback is a code revert.
- **No migration, no data fix.** Nothing durable is written wrong by either defect.

---

## Design

### D1. Split the pool/scribe block: wiring above the boundary, boot sweep below the adapters

**Move to `index.ts`, immediately after the `Dispatcher` construction (`:414`), before the background-task manager:**

- `const workerPool = new MeetingWorkerPool({ … })` (`:750-759`)
- `agentManager.setWorkerPool(workerPool)` (`:760`)
- **`await workerPool.ensureIndexes()`** *(new call, r2 — see "Why the indexes come along" below)*
- `const meetingScribe = new MeetingScribe({ … })` (`:775-780`)
- `meetingScribe.ensureIndexes().catch(…)` (`:786`)
- `dispatcher.setMeetingScribe(meetingScribe)` (`:787`)
- the "Meeting scribe wired" log (`:788-792`)

**Stays at its current site (`:765`), with a new comment saying why:**

- `await workerPool.start()` and the "Meeting worker pool started" log (`:766-770`)

**Why the indexes come along (r2).** `ensureIndexes()` creates the partial-unique `(threadId, taskKey)` index that *is* the claim ledger's atomicity primitive (`meeting-worker-pool.ts:205-216`, called from `start()` at `:219`) — without it, two bosses claiming the same normalized task both succeed and the duplicate-key "claim denied" signal never fires. Pre-KPR-414 that index is guaranteed present before any claim can be inserted only because wiring (`:760`) and `start()` (`:765`) are five lines apart. D1 moves wiring ~340 lines earlier — across `slackAdapter.start()` (`:568`) — so the window in which the pool is *dispatchable but unindexed* becomes real, live-Slack time. **The r1 draft justified this as "a first-ever boot has no meetings"; that claim is not verifiable from code** — it is an assertion about a Slack workspace's channel history and about how promptly the gateway replays, neither of which the engine controls. The window is closed instead of argued away: `ensureIndexes()` is already public and idempotent (three `createIndex` calls, no-ops when the indexes exist), so the moved block simply calls it. `start()` re-runs it later at cost of three no-op round-trips, keeping its own contract intact and its boot-fatal posture at *both* sites — failing earlier is strictly better, because it fails before any surface is up. (Note the index is absent only until the first successful `ensureIndexes()` against a given database; TTL evicts documents, never indexes.)

Dependency check (read, not assumed): `MeetingWorkerPool`'s constructor needs `db` (`index.ts:156`), `registry` (`:245`), `config.meetingWorkers`, and an `onDispatch` closure over `dispatcher` (`:408`) — the closure body runs later, so only the binding must exist. `setWorkerPool` needs `agentManager` (`:385`). `MeetingScribe` needs the pool. `setMeetingScribe` needs the dispatcher. Every one of those exists by `:414`. `WorkerPoolManagerHooks.buildWorkerAdapter` (`agent-manager.ts:629-645`) reads `this.plugins`/`this.skillIndex`/`this.registry` **at invocation**, not at bind time, so binding earlier captures nothing stale. The pool's own "constructed after the dispatcher (scheduler-seam precedent)" comment (`:748-749`) is satisfied by the new site and should be reworded to state the *boundary* reason, which is the stronger constraint.

**Why `start()` cannot come along.** `sweepOnRestart` → `expireClaim` → `dispatchReentry` → `onDispatch` → `dispatcher.dispatch`. In `dispatchToAgent` the adapter is resolved at `dispatcher.ts:324` — *before* `runWorkItemTurn` — and `deliverAgentResult` opens `if (!sourceAdapter) return;` (`:570-572`). Run the sweep before `registerAdapter(slackAdapter)` (`:566`) and each orphaned claim buys a full frontier-model boss turn whose output is discarded in silence. KPR-390 E5 designed that notice deliberately; the reorder must not eat it.

Proposed comment at the retained site (shape, not final bytes):

```ts
  // KPR-414: the pool's WIRING — and its ensureIndexes() — moved above the
  // spawn-capable boundary (see the block after the Dispatcher
  // construction); ensureIndexes is idempotent, so start() re-running it
  // here is three no-op createIndex calls and start()'s contract is intact.
  // This call — restart sweep, watchdog — deliberately stays HERE, below
  // dispatcher.registerAdapter(slackAdapter): the sweep's honest expiry
  // re-entry is a real boss turn, and dispatchToAgent resolves its delivery
  // adapter BEFORE running the turn (dispatcher.ts:324 / :570-572), so an
  // early sweep would pay for the turn and silently drop the notice.
  // Wiring-before-surfaces and sweep-after-adapters have disjoint valid
  // ranges; the split is forced, not stylistic.
  await workerPool.start();
```

### D2. Promote the boundary from a KPR-394 detail to a named file invariant

The rule currently lives inside a comment about provider plugins, which is how a later author reads it as a provider-plugin rule and wires below it. Add a short boundary marker immediately above the background-task-manager block (`:416`), naming the line and what it means, and leave `:399-406` otherwise untouched (it is accurate). Shape:

```ts
  // ── Spawn-capable boundary (KPR-394, restated by KPR-414) ──────────────
  // Everything BELOW this line can dispatch a turn: bgTaskManager /
  // codeTaskManager orphan-completion callbacks, meetingMonitor, every
  // channel adapter, the scheduler. Anything a turn READS PER SPAWN —
  // provider plugins, the worker pool, the meeting scribe — must be wired
  // ABOVE it, or turns in the boot window silently see the pre-feature
  // engine. Guarded by src/boot-order.test.ts.
```

This is the "explicitly amend the stated rule" half of the ticket's ask, answered by generalizing the rule rather than carving an exception into it — no exception is warranted, since the wiring has no dependency that forces it late.

### D3. Bound the restart sweep by live-worker membership (required with D1)

`sweepOnRestart` justifies its unconditional flip on process freshness (`meeting-worker-pool.ts:729-736`):

```ts
  /** Boot sweep: a fresh process can never have live workers, so every
   *  running claim is an orphan — flip unconditionally with notice (E5). */
```

After D1 the wiring→`start()` gap spans nine spawn-capable surface starts (including a paginated `conversations.list`, `:582-591`), so a boss *can* claim before the sweep runs, and that premise stops being true. Restore it as code:

```ts
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

Not inside `runWorkerTurn`/`spawnFetchWorker`, so C24/C34's freeze is untouched; consistent with C35 (`liveWorkers` is fetch-workers only, which is exactly the set that can hold a claim).

**Not severable from D1 (r2 ruling).** The r1 draft called the residual "an in-window claim expired with an honest notice — degraded, never silent," and that description was wrong. Reading `expireClaim` (`meeting-worker-pool.ts:738-756`), the full residual is: the claim is flipped `expired`; **the live worker's abort handle is invoked and the in-flight worker turn is killed mid-flight** (its spend already paid, its report never produced); and `dispatchReentry` tells the boss `"engine restarted mid-worker"` — which in this scenario is **factually false**. The engine did not restart mid-worker; the worker was dispatched seconds earlier, in this same boot, by this same process. So the residual is a killed turn plus a false explanation to the agent that owns it — the exact "honest notice" property KPR-390 E5 was designed to guarantee, inverted. D1 is what makes this reachable (today the window is five lines and no dispatch can land inside it), so D1 must not ship without D3. This is the same reasoning as constraint B: the reorder must not trade a self-healing gap for a silent-or-lying one. It is also what T5's negative-verify actually observes.

### D4. `MeetingScribe` — a `stopped` latch at three checkpoints

```ts
  private stopped = false;
```

**Checkpoint 1 — gate 0 in `noteActivity`,** first line of the synchronous gate chain, above the C36 claim:

```ts
  noteActivity(args: NoteActivityArgs): void {
    if (this.stopped) return; // gate 0 — shutdown latched; see stop()
    const cfg = this.deps.config;
    if (!cfg.enabled || !cfg.scribeEnabled) return; // gate 1
```

**Checkpoint 2 — pre-spawn, in `run()`,** after the E8 registry re-check (`:214-216`) and **before** the `updating` write (`:218-221`), so a shutdown-interrupted run leaves no stub doc for gate 2b to age out:

```ts
    if (this.stopped) return; // shutdown began while this run awaited Mongo
```

**Checkpoint 3 — inside the `onAbortHandle` callback** (`:244`), the only check that closes the window completely, because `stop()`'s pass and this registration are two points in the same unsynchronized sequence. It **throws**; it does not abort:

```ts
/** Thrown out of the scribe's onAbortHandle callback when stop() has already
 *  latched. Exported so the test can pin the mechanism, not the prose. */
export const SCRIBE_STOPPED_ERROR = "meeting scribe stopped before turn start";
```

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

**`stop()` sets the latch first, then makes its pass:**

```ts
  stop(): void {
    this.stopped = true; // latch BEFORE the pass — a turn whose handle is
                         // minted after this point is refused at checkpoint 3
                         // and never started
    for (const [threadId, abort] of this.abortHandles) { … unchanged … }
  }
```

**What `run()` does with the resulting outcome — checked, no accommodation needed.** `runRoleTurn`'s catch returns `{ error, durationMs }` with no `text`/`timedOut`/`aborted`/`costUsd`/`toolCalls`. In `run()` (`meeting-scribe.ts:247-256`), `outcome?.text?.trim()` is `undefined` and `outcome.error` is truthy, so the existing no-summary branch fires: it logs `"Scribe turn produced no summary — prior summary stands"` with the error preview and returns, leaving the prior summary standing. This is the same branch a genuine `adapter.runTurn()` error already takes — bare-error outcomes are not a new shape. The `finally` (`:281-289`) then clears any `updating` stub and stamps `lastRunAt`, exactly as on the abort path. Nothing in `run()` changes.

**Safe under either containment outcome.** Checkpoint 3's *primary* guarantee — the turn is never spawned — holds unconditionally, because the throw precedes `runTurn` by one statement. Containment is then belt-and-braces: today `runRoleTurn`'s try/catch absorbs it (JSDoc `:569`, "Never throws"), and if that ever changed, `run()` has `try/finally` with no `catch`, so the throw would propagate to `noteActivity`'s `.catch()` (`:166-167`) and be logged as a warn, with the shared `finally` (`:168-175`) still releasing both maps. Degraded log level, identical safety. Nothing leaks in either case.

**No un-stop.** The latch is process-terminal; a `resume()` would be an unused API on a shutdown path. **No `abortHandles.clear()`** — see Key Point 6: the shared `finally` (`:168-175`) owns paired release, and its ⚠ comment makes that an invariant; clearing one map there buys nothing on an exiting process and splits a stated pairing. **`inFlight` untouched** for the same reason.

**Why not mirror `MeetingWorkerPool.stop()` exactly.** The pool's shape relies on backstops the scribe does not have (Problem §Finding 5). Copying it would reproduce, in the one place the finding says it is not survivable, the shape the finding says is only survivable elsewhere.

### Alternatives considered and rejected

**A. Move the whole pool/scribe block early, `workerPool.start()` included.** One contiguous move, one comment, no split. Rejected on Key Point 3: the boot sweep's re-entry turns would run before `registerAdapter(slackAdapter)` and their output would be dropped by `deliverAgentResult`'s `if (!sourceAdapter) return;`. That trades a self-healing missing-tool window for a silently-lost honest notice plus a wasted frontier-model turn — strictly worse, and it would quietly extend the pre-existing `bgTaskManager.scanOrphans()` hazard class (Key Point 10) rather than declining to join it.

**B. Amend the invariant instead of moving the wiring** (the ticket's explicit second option). Rejected because no dependency forces the wiring late — the whole constraint is "after the `Dispatcher` exists," six lines up. An exception would have to read "spawn-visible capabilities may be wired after spawn-capable surfaces start, provided they degrade quietly," which is the general case, i.e. the invariant deleted. D2 generalizes the rule instead.

**C. Reorder `index.ts` shutdown so `meetingScribe.stop()` runs after `slackAdapter.stop()`.** Narrows window 1 only; windows 2 and 3 are internal to the scribe and unaffected. Also perturbs a shutdown sequence carrying explicit ordering rationale (`:905-908`, KPR-139). Rejected — the latch is smaller and total.

**D. Give `MeetingScribe` its own `liveWorkers`-style registry and have `workerPool.stop()` sweep it.** Directly contradicts C35 (out-of-band roles never enter `liveWorkers`, never share the pool's bound) and re-couples two things KPR-409 deliberately kept apart. Rejected.

**E. Guard the boot order with a comment only, no test.** That is precisely what was in place when this defect was introduced. Rejected on the epic's own code-enforce-don't-prose-enforce posture.

**F. Split `workerPool.start()` itself — `ensureIndexes()` + watchdog early with the wiring, `sweepOnRestart()` alone late** (r2, raised by spec-review r1 as the middle option the draft never considered). This is the right *diagnosis*: the atomicity index must exist before the pool becomes dispatchable, and the draft's "a first-ever boot has no meetings" hand-wave is not verifiable. It is the wrong *mechanism*, on two counts. **(i)** The index half needs no refactor at all — `ensureIndexes()` is already a public, idempotent method, so the early block can simply call it (D1). A split would change `start()`'s contract ("make me operational") for zero additional coverage, and would need the pool suite's four `pool.start()` fixtures (`meeting-worker-pool.test.ts:635`, `:683`, `:703`, `:733`) plus D3's new T5 migrated to the new pair — churn in a file adjacent to a frozen surface, for nothing. **(ii)** Moving the **watchdog** early is actively undesirable. `sweepExpired` → `expireClaim` → `dispatchReentry` produces the same real boss turn the restart sweep does, so an early watchdog re-opens constraint B's hole on a 60s timer: it is safe only if boot reliably completes to `registerAdapter(slackAdapter)` within one interval — true in practice, timing-dependent by construction, and exactly the reasoning D1 refuses to accept for the sweep. The watchdog belongs with the sweep, below the adapters. **Ruling: rejected in favor of D1's early idempotent `ensureIndexes()` call**, which resolves the same window with no contract change, no new method, and no timing assumption — and which is why the "no change to `start()`'s contents" non-goal is now justified rather than assumed.

**G. Have checkpoint 3 call the `abort` it was handed instead of throwing** (the r1 draft's design). Rejected as provably inert: `onAbortHandle` fires one statement before `adapter.runTurn()`, and `AgentRunner.abort()` does nothing while `activeQuery` is null (Problem §Finding 5, Key Point 5). The turn would run to completion, unaborted and — because the callback also returns without registering — unregistered, which is worse than the pre-fix behavior it claims to fix. This is precisely the class of failure the ticket exists to close, so shipping it would have been C38-violating in the same breath as invoking C38.

## Integration points

| File | Change |
|---|---|
| `src/index.ts` | D1: move six statements (pool + scribe construction, `setWorkerPool`, scribe `ensureIndexes`, `setMeetingScribe`, scribe log) from `:748-792` to just after `:414`, and add one new `await workerPool.ensureIndexes()` in the moved block; leave `await workerPool.start()` + its log at the current site with a new rationale comment; reword the pool block's `:748-749` comment. D2: boundary marker comment above `:416`. |
| `src/workers/meeting-worker-pool.ts` | D3: one `liveWorkers` guard + comment inside `sweepOnRestart` (`:731-736`). Nothing else — `stop()`, `start()`, `ensureIndexes`, `runWorkerTurn`, `spawnFetchWorker`, `runRoleTurn`, `dispatch`, the watchdog all untouched. |
| `src/workers/meeting-scribe.ts` | D4: one private field, one exported error-message constant, three checkpoints, one line in `stop()`, comments. |
| `src/boot-order.test.ts` *(new)* | Source-order guard (T1). |
| `src/workers/meeting-scribe.test.ts` | Three rows in the existing `stop() (D2i)` describe (`:812-842`, T2–T4), plus one fidelity fix to `makeFakePool()` (`:149-184`) so its `runRoleTurn` mirrors the real one's try/catch — see Testing. |
| `src/workers/meeting-worker-pool.test.ts` | One row for D3 (T5). |

No config, schema, migration, bundle, doctor, docs, or provider-parity impact. `hive.yaml` untouched.

## Testing

The scribe suite's harness supplies nearly everything needed: `makeFakeCollection()` (`meeting-scribe.test.ts:56-121`, including the `updateCalls` log and the `updateOne` push at `:106-107`), `makeFakePool()` with `hold()`/`abortByThread` (`:149-184`), `makeArgs()` (`:226`), `makeScribe()` (`:250`), `flush()` (`:308`), `summarySnapshot()` (`:315`). The pool suite has `makeFixture()`/`seedClaim()` (`meeting-worker-pool.test.ts`).

**One harness fidelity fix is required (r2).** `makeFakePool().runRoleTurn` currently calls `args.onAbortHandle?.(abort)` *outside* any try/catch (`:157-161`), which does **not** mirror the real `runRoleTurn`, where that call sits inside the single try whose catch returns `{ error, durationMs }` (`meeting-worker-pool.ts:591-623`). Under the fake, a throwing callback rejects `runRoleTurn`; under the real pool it produces an error-shaped outcome. Wrap the fake's body — `onAbortHandle` invocation *and* `impl(args)` — in the same try/catch shape, returning `{ error: String(err).slice(0, 2000), durationMs: 0 }`. No existing row passes a throwing callback, so nothing else changes; T4 then exercises the real contract rather than a divergent stand-in.

- **T1 — boot-order guard (`src/boot-order.test.ts`, new).** Read `src/index.ts` via `fileURLToPath(new URL("./index.ts", import.meta.url))` — cwd-independent, worktree-safe. Three assertions:
  - **(a) Named anchors present.** Locate the offsets of the wiring anchors (`await agentManager.activateProviderPlugins()`, `agentManager.setWorkerPool(`, `await workerPool.ensureIndexes()`, `dispatcher.setMeetingScribe(`) and of a named anchor set of spawn-capable surface starts (`await bgTaskManager.start()`, `await bgTaskManager.scanOrphans()`, `await codeTaskManager.start()`, `await slackAdapter.start(`, `await smsAdapter.start(`, `scheduler.start()`). Assert **every anchor was found** — the KPR-228 lesson from the `no-deprecated-models.test.ts` precedent: a guard that silently matches nothing is worse than no guard, so a rename must fail the suite, not disable it.
  - **(b) Ordering.** Each wiring offset is less than the minimum named-surface offset.
  - **(c) Superset sweep (r2 advisory; r3 fixes a self-inflicted false-positive).** Scan the file **with `//` line-comments stripped first** (a simple per-line `line.replace(/\/\/.*$/, "")` before matching — this file has no block comments in the relevant region, so nothing more elaborate is needed) for every `/\.(start|scanOrphans)\s*\(/g` occurrence, and assert that every match *preceding* the wiring offsets is in a small explicit allowlist of known non-spawn-capable starts — today exactly `dbIdentityMonitor.start(` (`:164`) and `contactsWatcher.start(` (`:275`). **Why the strip is required, not optional:** the boundary comment at `index.ts:400` (left in place by this spec, above the new wiring site) reads *"…bgTaskManager.start()/…"* in prose — an unstripped scan matches that comment's `.start(` as a real early hit that isn't in the allowlist. Without stripping, the guard would fail against the *correct* post-fix source, and the easiest "fix" available to whoever hits that is broadening the allowlist — which hollows out (c) for exactly the case it exists to catch. This converts T1's weakest failure mode from silent to loud: a spawn-capable surface introduced *above* the wiring no longer slips past a hand-maintained list — it appears as an unallowlisted early `.start(` and fails the suite until an author classifies it (add to the allowlist if inert, or move the wiring if not).
  - Document in-file that the named surface set in (a) is an *anchor set*, not an exhaustive inventory (`outageReplayProcessor.start()` at `:840` is a real spawn-capable surface deliberately not named, because it sits below the wiring and adds nothing to the bound), and that (c) is what covers additions.
  - **Negative-verify:** restore either wiring call to its pre-fix position → (b) fails; rename `bgTaskManager` → (a) fails; insert a `fooAdapter.start()` above the wiring → (c) fails.
- **T2 — `noteActivity` after `stop()` is inert (gate 0).** `f.scribe.stop(); f.scribe.noteActivity(makeArgs()); await flush();` → `f.pool.runRoleTurn` not called, `summarySnapshot(f.summaries)` unchanged, `f.summaries.updateCalls` empty (no `updating` stub). **Negative-verify:** drop gate 0 → `runRoleTurn` called once.
- **T3 — a run past the gates does not spawn if `stop()` lands during its Mongo read (checkpoint 2).** `f.summaries.findOne.mockImplementationOnce(async () => { f.scribe.stop(); return null; })`, then `noteActivity` + `flush()` → `runRoleTurn` not called **and** `f.summaries.updateCalls` empty (checkpoint 2 sits above the `updating` write, so shutdown leaves no stub for gate 2b). **Negative-verify:** drop checkpoint 2 → `runRoleTurn` called and an `updating` write is recorded.
- **T4 — a turn whose handle is minted after `stop()` is never started (checkpoint 3).** ⚠ **This row is deliberately not written as "assert `abort` was called."** That assertion is what let the r1 design through review: it passes over an inert `abort()` (the fake's `abort` is a `vi.fn()`, so calling it proves nothing about whether a real query would have stopped). T4 must assert **the turn never ran**.
  - **Harness.** Use `makeFakePool()` *after* the fidelity fix above, so its `runRoleTurn` reproduces the real one's exact sequence and containment: `const abort = vi.fn(); try { abortByThread.set(threadId, abort); args.onAbortHandle?.(abort); return await impl(args); } catch (err) { return { error: String(err)…, durationMs: 0 } }` — the `abortByThread.set` (already present in `makeFakePool()`'s current body, `:160`) is not new; keep it, since dropping it would break T4's own assertion (4) and both existing D2i rows. Route the turn body through a `vi.fn()` `impl` — that mock **is** the "did the turn start?" probe, standing in for `adapter.runTurn()`, which in the real pool is the statement immediately after `onAbortHandle`.
  - **Seed (r3 fix — required for assertion (2) to mean anything).** Push a prior summary doc before dispatching: `f.summaries.docs.push({ _id: THREAD, summaryText: "PRIOR", coveredThroughTs: "0", version: 1, updatedAt: new Date(BASE_EPOCH - 300_000) })` (the exact shape `meeting-scribe.test.ts:389-394`'s D2a row already seeds). Without a prior doc, `checkpoint 2`'s `updating` write is an *upsert* against an empty collection and would itself create the thread's first row — "unchanged" would then be vacuously comparing `[]` to `[]` in the wrong way (see assertion (2) below) rather than proving the prior summary survived.
  - **Arrange (r3 fix — `f.summaries.updateOne` is a plain method, not `vi.fn`-backed).** Delegate-patch it, mirroring the existing `f.claims.find` swap at `meeting-worker-pool.test.ts:679-682`: `const realUpdateOne = f.summaries.updateOne.bind(f.summaries); let armed = true; f.summaries.updateOne = (async (...callArgs: any[]) => { if (armed) { armed = false; f.scribe.stop(); } return realUpdateOne(...callArgs); }) as any;`. This makes `stop()` land in the only window checkpoint 3 exists for — between checkpoint 2's `updating` write and handle registration — without adding a second harness change beyond the one fidelity fix already scoped (the patch lives in the test body, not in `makeFakeCollection`). Then `noteActivity(makeArgs())` + `flush()`.
  - **Assert.** (1) the `impl` probe was **never called** — the turn was never started; this is the anti-vacuity guard's companion, but is not itself sufficient (see (3)); (2) `summarySnapshot(f.summaries)` equals `[{ _id: THREAD, summaryText: "PRIOR", coveredThroughTs: "0", version: 1 }]` — the seeded doc, untouched — proving the run left no trace beyond the expected `updating` stub/clear cycle (which `run()`'s `finally` already performs on every path, seeded or not); (3) **the anti-vacuity guard**: `await f.pool.runRoleTurn.mock.results[0].value` resolves (does not reject) to an outcome whose `.error` is a string `toContain`-ing `SCRIBE_STOPPED_ERROR` — this is what makes the row fail even if (1) and (4) somehow passed vacuously (a fully-gated `noteActivity` would make both trivially true with no call at all; dereferencing `mock.results[0]` on zero calls throws, so (3) alone closes that hole); (4) `f.pool.abortByThread.get(THREAD)` was never called, and a second `f.scribe.stop()` still calls nothing — no handle was ever registered.
  - **Negative-verify (must fail for the right reason).** Replace checkpoint 3's `throw` with the r1 design (`if (this.stopped) { abort(); return; }`) → assertion (1) **fails**: `impl` runs, because the inert `abort()` cannot prevent the turn. Remove checkpoint 3 entirely → (1) fails identically, and (4) additionally fails. Gate `noteActivity` out entirely (e.g. comment out checkpoint 1) → (1) and (4) pass vacuously, but (3) throws on `mock.results[0]` being `undefined` — confirming (3) is load-bearing, not decorative. No variant — inert or vacuous — can turn this row green.
  - **Containment cross-check (same row or a sibling `it`).** With the checkpoint in place, assert `noteActivity` did not reject and the scribe's maps are empty afterward — pinning that the shared `finally` (`meeting-scribe.ts:168-175`) released `inFlight`/`abortHandles` on this path too.
- **T5 — the restart sweep spares a live claim (D3).** On the pool fixture, seed one `running` claim, drive `dispatch()` to a held `runTurn` so the claim is in `liveWorkers`, then `await pool.start()` → that claim stays `running` and fires no re-entry, while a second seeded (not-live) `running` claim is expired with `"engine restarted mid-worker"`. **Negative-verify:** remove the guard → the live claim is expired, its worker is aborted mid-flight, and the boss receives the false `"engine restarted mid-worker"` re-entry (assert all three — that triple *is* the residual D3 is required to prevent).
- **Non-regression, no new rows.** `meeting-scribe.test.ts:812-842` (the existing `stop()` D2i describe, two rows: aborts every live run and contains a throwing abort; holds no handle for a settled run) must stay green — the latch adds behavior on paths those rows never exercise. `meeting-worker-pool.test.ts:630` (T6 restart sweep) seeds claims directly into the ledger and never populates `liveWorkers`, so D3 leaves it green. The 28 conference tests, the containment pins, and the capacity-isolation rows (D2f) are untouched by every change here.

## Edge cases

- **Boot window between wiring and `workerPool.start()`.** A boss dispatching a worker there gets the tools and a valid claim, and the claim is **atomically protected**: D1's early `await workerPool.ensureIndexes()` runs in the moved block, so the partial-unique `(threadId, taskKey)` index exists before any surface starts, on a first-ever boot as much as on any other. (r2: the r1 draft instead argued the window was safe because "a first-ever boot has no meetings" — an unverifiable claim about workspace state, now replaced by a mechanism. See D1 §"Why the indexes come along".) D3 then keeps the in-window claim safe from the restart sweep that follows.
- **`ensureIndexes()` failing at the early site.** Boot-fatal, as it is today inside `start()` — but now fatal *before* any spawn-capable surface is up, which is a strictly better failure point. The later `start()` call would have failed identically; nothing is masked.
- **Turn in flight when `stop()` is called, with its handle already registered.** Unchanged behavior: the sweep aborts it, the shared `finally` releases both maps, `runRoleTurn` returns an `aborted` outcome, and `run()`'s existing branch (`:248-255`) leaves the prior summary standing.
- **`stop()` lands between checkpoint 2 and handle registration (the checkpoint-3 path).** The `updating` stub written at `meeting-scribe.ts:219-221` already exists when the throw fires, and `run()`'s `finally` (`:281-289`) clears it and stamps `lastRunAt` on the way out, exactly as on the abort and error paths. So the doc left behind is the same one any failed turn leaves — and `getSummary`'s stub guard (`:133`) already refuses to read a `{ _id, updating }`-only doc as a summary. No new state, no stub for gate 2b to age out on the next boot beyond what a plain failure already produces.
- **`stop()` called twice.** Idempotent: the latch is already true, the map is already swept (and self-emptying), nothing re-aborts a settled run.
- **`stop()` with an empty `abortHandles` map.** The latch still takes effect; that is the case T2 covers and the pre-fix code did not.
- **Scribe disabled (`scribeEnabled: false`).** Gate 1 already returns before anything; gate 0 is a no-op ahead of it. No behavior change.
- **Boot sweep with the pool wired but a boss agent removed from the roster.** Unchanged: `dispatchReentry`'s boss-gone guard (`:679-689`, C26 load-bearing) still skips the notice and annotates the claim.
- **`meetingWorkers.enabled: false`.** Wiring still happens (the pool object is constructed and bound; `dispatch()` returns the disabled text at `:277-279`), exactly as today — the move changes when, not whether.
- **SIGUSR1 during or after the boot window.** Irrelevant to both fixes: the reload path never touches pool/scribe wiring, and neither fix adds state that a reload could invalidate.

## Canon compliance

- **C24 / C34** — `runWorkerTurn`, `spawnFetchWorker`, `runRoleTurn`, and `WorkerRoleParams` are byte-untouched; no common core is extracted. The one pool edit (D3) is in `sweepOnRestart`, outside the frozen surface, and is declared rather than slipped in.
- **C25 / C28** — caps stay load valves (no locking added), and abort stays initiator-owned: D3 makes the *restart sweep* decline to expire a claim whose initiator is this process, which is the sweep's own stated premise, not a new ownership rule.
- **C35** — scribe runs still never enter `liveWorkers`; D3 reads that map, and reading it for "is this claim mine" is consistent with its fetch-worker-only meaning.
- **C36** — gate 0 is synchronous and sits **above** the single-flight claim, preserving the "claim before the first await" ordering the ⚠ comment at `:146-149` protects.
- **C38** — a `stop()` that leaves work startable is the contract-shaped lie C38 generalizes C27 to forbid. Checkpoint 3 makes the guarantee structural rather than timing-dependent, and it does so by **refusing to start the turn**, which is a guarantee the code can actually keep. r2 note: the r1 design's `abort()` in that callback would itself have been a fresh C38 violation — a call that reads as "this turn is stopped" while `AgentRunner.abort()` provably does nothing at that instant (`agent-runner.ts:2434-2441` with `activeQuery` null). Meeting C38 here required rejecting the C38-shaped-looking fix; the throw is the version whose stated guarantee is true.
- **C40** — index posture is unchanged and index-class-dependent: the pool's `ensureIndexes` stays boot-fatal and stays inside `start()`; D1 adds an *additional* boot-fatal call at the early site (same method, same posture, idempotent — a stronger guarantee at an earlier point, not a relaxation). The scribe's TTL index stays catch-logged (and moves with its block, still non-fatal).
- **KPR-394 §4.3/§4.6** — the invariant is restated and, for the first time, executably guarded; provider-plugin activation itself is untouched and gains a regression pin it did not have.

## Open questions / assumptions

- **⚠ Blocking-if-declined (r2 — reclassified from "severable, recommend include"; r3 completes the fallback statement):** D3's `liveWorkers` guard in `sweepOnRestart`. It touches `meeting-worker-pool.ts`, adjacent to a frozen surface (C24/C34) though not inside it. r1's spec called the no-D3 residual an "honest notice"; reading `expireClaim` (`:738-756`) shows it is a **live worker killed mid-flight plus a false stated reason** to its boss (D3). D1 is what makes that reachable. So the pairing is not a preference: **if a reviewer rules D3 out of scope, D1 must not ship either** — and the fallback is not simply "D2/D4 alone" as stated in r2, because **D2's proposed comment text ends "Guarded by src/boot-order.test.ts", and T1's assertion (b) (wiring offset < surface offset) is only true after D1 ships.** Under the fallback: D2's comment loses its final sentence (the boundary is still named, but no guard exists yet to cite), T1 is deferred in full (not partially written against an unmoved boundary), and G4 is explicitly unmet for this ticket rather than silently claimed. D4 (the scribe latch) is fully independent of D1/D2/D3/T1 and ships regardless of this ruling.
- **⚠ Non-blocking (assumption, evidence-backed):** the moved block has no ordering dependency beyond the `Dispatcher` binding — including the new early `await workerPool.ensureIndexes()`, which needs only the `db` handle bound in the constructor (`index.ts:156`, well above `:414`). Verified by reading every field of `MeetingWorkerPoolDeps`/`MeetingScribeDeps` and `WorkerPoolManagerHooks.buildWorkerAdapter` (invocation-time reads only). Recorded as an assumption because `index.ts` has no boot test today; T1 is what makes it durable.
- **⚠ Non-blocking (declined, with reasoning):** finding 5's literal "clear `abortHandles`" ask (Key Point 6). Re-open trigger: any future path where a `MeetingScribe` outlives a `stop()` — i.e. if an un-stop is ever introduced — at which point the map must be cleared *and* the latch reset together.
- **⚠ Non-blocking (out of scope, recorded):** `bgTaskManager.scanOrphans()` dispatching completion turns before any adapter is registered (`index.ts:427` vs `:566`) is the same deliverability hazard D1 keeps the boot sweep away from, and it exists today for background tasks. Not diagnosed here; worth a separate look if orphan-completion answers are ever observed missing after a restart.
- **⚠ Non-blocking (scope guard, narrowed in r2):** T1's *named* surface anchor set is deliberately partial (six calls; `outageReplayProcessor.start()` at `index.ts:840` is a real seventh it does not name, harmlessly, since it sits below the wiring). The r1 residual — a future surface introduced *above* the wiring being silently missed — is now covered by T1's superset sweep (c), which fails on any unallowlisted early `.start(`/`.scanOrphans(`. The remaining, accepted residual is narrow: a spawn-capable surface that starts itself through some spelling other than `.start(`/`.scanOrphans(`. The in-file comment must say so explicitly.
- **⚠ Non-blocking (pre-existing gap, recorded by r2, deliberately NOT fixed here):** an abort handle registered the *normal* way — an ordinary in-flight scribe turn, no shutdown involved — is inert for the whole stretch between `onAbortHandle` firing and `AgentRunner.send()` assigning `activeQuery`. `runRoleTurn` invokes `onAbortHandle` at `meeting-worker-pool.ts:600`, `runTurn` → `send()` begins at `agent-runner.ts:1940`, and `activeQuery` is not assigned until `:2091` — ~150 lines of prompt assembly with real awaits in between — while `abort()` (`:2434-2441`) is a no-op for that entire duration. So `MeetingScribe.stop()`, `MeetingWorkerPool.stop()`, `abortForBoss`, `worker_cancel`, and the watchdog's `expireClaim` all have a short window in which their abort silently does nothing and the turn runs on. **Fetch workers have the identical shape** (`meeting-worker-pool.ts:498` registers `liveWorkers` before `runTurn`). KPR-414 neither introduces this nor fixes it: it predates the epic, it lives in `AgentRunner`'s abort lifecycle (a universally-shared spawn path), and closing it properly means a pending-abort latch in the runner — a separate ticket with its own blast radius. Recorded so a later reader does not mistake KPR-414's checkpoint 3 for a general solution: checkpoint 3 sidesteps the gap for one specific path by never starting the turn, and claims nothing beyond that.
