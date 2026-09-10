# KPR-468 plan — chunk 5: boot order, the shutdown drain, and `CLAUDE.md`

Implements design **D10** (boot order, `start()` after adapter registration, the drain) and **AC14**/**AC17**. One task, one commit.

**⚠ Rebase before starting this task.** Every `src/index.ts` line number quoted in the spec (`:466`, `:474`, `:632`, `:634`, `:639`, `:943`) was read at `272b17d`, **before KPR-454's wiring landed in the same above-boundary block** (`:404-473`). KPR-454 is a hard blocker, so its wiring is already in the file by the time this task runs, and the numbers have moved. **Rebase onto KPR-454's merged wiring and re-derive every anchor from the file.** The anchor *strings* below are stable and are what every step keys on:

| anchor string | role |
| --- | --- |
| `// ── Spawn-capable boundary` | the marker; the new block goes immediately **above** it |
| `setOpsPublisher(` | KPR-454's last above-boundary wiring line; the new block goes **after** it |
| `process.on("SIGUSR1"` | the existing handler whose **body** gains one line — never a second listener |
| `dispatcher.registerAdapter(slackAdapter)` | the earliest point a transport can be bound |
| `await slackAdapter.start(` | Slack connect |
| `await obligations.start(` | KPR-456's start-after-Slack precedent; the new `start()` goes **immediately after** it |
| `await obligations.stop()` | the drain precedent; `await opsNotifier.stop()` goes **immediately after** it |
| `await slackAdapter.stop()` / `await mongoClient.close()` | the two the drain must precede |

**Why the wiring and the `start()` have deliberately disjoint valid ranges.** This is the `workerPool.start()` precedent stated for a second subsystem. `init()` and `setOpsNotifier(` must sit **above** the boundary because **intake is reachable from a turn**: D6 names an agent tool call as one of the inbound surfaces, so once KPR-455 wires an agent-facing edge the intake singleton *is* a per-spawn read, and wiring it above the marker now is what keeps that true without a later move — exactly the class of silent breakage KPR-414 was spent removing. `start()` must sit **below** `dispatcher.registerAdapter(slackAdapter)` because a sweep that begins before its adapters exist would burn attempts against nothing: every due row would resolve `transportUnbound` and the counter would fill with boot noise. **And the first subscription load's placement inside `start()` is load-bearing in the same direction** — it is what puts every `validateTarget` after every `registerTransport`, so the check has adapters to run against.

---

### Task 7: wire, guard, document

**Files:**

- Modify: `src/index.ts` (the above-boundary wiring block; the `SIGUSR1` handler body; after `await obligations.start(`; the `shutdown` function)
- Modify: `src/boot-order.test.ts` (all three lists + a new lifecycle `describe`)
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Re-derive the anchors after the rebase.

```bash
grep -n "Spawn-capable boundary\|setOpsPublisher(\|process.on(\"SIGUSR1\"\|dispatcher.registerAdapter(slackAdapter)\|await slackAdapter.start(\|await obligations.start(\|await obligations.stop()\|await slackAdapter.stop()\|await mongoClient.close()" src/index.ts
```

Record the observed line numbers in the implementation report. If `setOpsPublisher(` is **absent**, KPR-454 is not merged and this task cannot run — stop and report the blocker rather than wiring against today's file.

- [ ] **Step 2:** Insert the wiring block immediately **before** the `// ── Spawn-capable boundary` comment and **after** KPR-454's `setOpsPublisher(` block.

```typescript
  // KPR-468 (D10): the ops notifier — the acknowledgement ledger and its
  // sweep. Construction, init() and singleton registration sit ABOVE the
  // spawn-capable boundary below because INTAKE IS REACHABLE FROM A TURN: D6
  // names an agent tool call among the inbound acknowledgement surfaces, so
  // once KPR-455 wires an agent-facing edge the intake singleton is a
  // per-spawn read. Guarded by src/boot-order.test.ts, which carries both
  // anchors in all three of its lists.
  //
  // registerTransport() + start() deliberately sit LOWER, after
  // dispatcher.registerAdapter(slackAdapter) — the workerPool.start()
  // disjoint-range precedent. A sweep that began before its adapters exist
  // would burn attempts against nothing: every due row would resolve
  // transportUnbound and the counter would fill with boot noise.
  //
  // init() is NON-FATAL to boot, with a split posture (D10):
  //  - the (subscriptionId, dedupeKey) UNIQUE index failing THROWS, so
  //    setOpsNotifier never runs, the singleton stays unset, every intake call
  //    answers { state: "unavailable" } and the sweep never starts. Running
  //    the ledger without its identity guarantee is worse than not running it.
  //  - a REASON-MAP fault does not throw: the singleton IS set, intake is
  //    live, and only the sweep stays off — reasons feed remediation at
  //    delivery and intake consumes none of them.
  //  - every other index fault is contained, counted, and keeps it usable.
  const opsNotifier = new OpsNotifier(db, config.activity.retentionDays);
  try {
    await opsNotifier.init();
    setOpsNotifier(opsNotifier);
    log.info("Ops notifier wired (KPR-468)");
  } catch (err) {
    log.error("Ops notifier init failed — the acknowledgement ledger is OFF this boot", {
      error: String(err),
    });
  }
```

Imports at the top of `index.ts`:

```typescript
import { OpsNotifier } from "./ops/notifier.js";
import { setOpsNotifier } from "./ops/notifier-singleton.js";
```

⚠ **Naming collision to avoid, exactly as KPR-454's plan flags for its own singleton.** `src/ops/notifier-singleton.ts` exports a reader named `opsNotifier()`. `index.ts` imports **only** `setOpsNotifier`, so the local `const opsNotifier` is unambiguous — but the boot-order anchors are the literal strings `await opsNotifier.init()` and `setOpsNotifier(`, so **do not add the reader import later without renaming one of the two.**

⚠ **`db` and `config.activity.retentionDays` must both already be in scope at this point.** KPR-454's block one line above uses exactly the same two (`new OpsPublisher(db, config.activity.retentionDays)`), so if that block compiles here, this one does. Confirm rather than assume — a `db` bound later in the file is a compile error, not a runtime one, and `tsc` in Step 7 catches it.

- [ ] **Step 3:** Add one line to the existing `SIGUSR1` handler's **body**.

Do **not** add a second `process.on("SIGUSR1", …)` listener (integration point 6). After KPR-454's rebase the handler reads roughly:

```typescript
  process.on("SIGUSR1", () => {
    prefixCache.invalidateAll("sigusr1");
    safeReload();
    void opsPublisher.reloadSubscriptions();
    // KPR-468 D6: refresh the notifier's own loaded subscription set. The
    // reload is deliberately DUPLICATED with the publisher's — the two are
    // different projections of the same rows for different purposes at
    // different lifecycle points (compiled filters above the boundary vs.
    // transport bindings validated against registered adapters, which cannot
    // load before start()). See notifier.ts's reloadSubscriptions comment
    // before consolidating them.
    //
    // A SIGUSR1 arriving BEFORE start() is harmless: the reload loads the
    // subscriptions UNVALIDATED (no adapter is registered yet, which is D6's
    // already-specified "unjudged binding" branch), no sweep is running to
    // consume the result, and start()'s own first load runs afterwards with
    // the adapters bound and re-validates every target. Worst case: one
    // wasted find().
    void opsNotifier.reloadSubscriptions();
  });
```

The bare `void` is correct rather than a swallowed error: `reloadSubscriptions()` catches its own fault, warns and counts, and the promise it returns rejects only when called with `rethrow = true`, which this call site does not do.

- [ ] **Step 4:** Register the transport and start the sweep, immediately after `await obligations.start(...)`.

The constructor takes **exactly these two arguments** — the bot token and the echo-registration callback. Everything else the transport needs is code-resident, and it is handed no target: the target rides each `NotificationView` (D6).

```typescript
  // KPR-468 (D6, D10, C14): bind the one transport, then start the sweep —
  // AFTER dispatcher.registerAdapter(slackAdapter) and await
  // slackAdapter.start(). The echo callback is not hygiene: without it an ops
  // post into a channel the bot listens to is re-ingested as a WorkItem and
  // SPAWNS AN AGENT TURN (D10 invariant (b)), and a turn that then fails a
  // tool republishes and the loop closes. Same shape as obligations.start()
  // one line above.
  opsNotifier.registerTransport(
    new SlackOpsTransport(config.slack.botToken, (channel, ts) => slack.registerOutboundTs(channel, ts)),
  );
  // start() does the FIRST subscription load — which is what puts every
  // validateTarget after every registerTransport — arms the 60 s reload timer,
  // and begins the sweep. A first-load fault is contained inside start(),
  // leaving the notifier unstarted with intake still live.
  await opsNotifier.start();
```

Import:

```typescript
import { SlackOpsTransport } from "./ops/slack-transport.js";
```

- [ ] **Step 5:** Drain on shutdown.

In the `shutdown` function, add `await opsNotifier.stop();` **immediately after** `await obligations.stop();`. That places it before `await slackAdapter.stop()` and `await mongoClient.close()` — the KPR-456 ordering D12 names.

```typescript
    await obligations.stop();
    // KPR-468 D10: sets the stopped latch, clears the reload and sweep timers,
    // stops accepting new intake, and awaits the in-flight tick. The tick exits
    // at its next checkpoint — between events inside ingest, between rows
    // inside expiry and delivery, and between the three phases — so the wait is
    // bounded by whichever unit of work is in hand: one event's application, or
    // one attempt at the adapter's own deadline. NOT open-ended, and NOT a full
    // ingest budget (which is what an ingest phase with no stopped latch would
    // have made it — see IngestPhase's `stopped` parameter).
    await opsNotifier.stop();
```

**`stop()` is safe on a notifier whose `init()` threw.** The local `const opsNotifier` exists whether or not `setOpsNotifier` ran, so shutdown calls `stop()` on it either way; `stop()` touches only the two latch booleans and two possibly-`undefined` timers plus a possibly-`undefined` `flight` — no store access, no throw.

- [ ] **Step 6:** Extend `src/boot-order.test.ts` — **all three lists**, then a new lifecycle block.

Add to `(a)`'s presence pass, after KPR-454's two entries:

```typescript
    // KPR-468: the ops notifier's intake is a spawn-read surface (D6 names an
    // agent tool call among the inbound acknowledgement edges KPR-455 will
    // build), so both anchors are order-pinned below.
    offsetOf("await opsNotifier.init()");
    offsetOf("setOpsNotifier(");
```

Add the **same two** `offsetOf(...)` entries to `(b)`'s `wiringOffsets` array and to `(c)`'s `wiringStart` `Math.max(...)` set. **All three, not one** — `(a)` is presence-only and adding to it alone is the exact failure mode the guard exists to catch; `(b)` is what fails if the wiring moves below the marker; and `(c)`'s superset sweep must be bounded by the **latest** wiring anchor or a surface introduced *between* two wiring calls passes green.

`await opsNotifier.start()` sits **after** `wiringStart`, so `(c)`'s sweep does not see it and its `allowlist` needs **no** entry. Pin that property so a later refactor has to argue with it — inside the **first** `describe`, the one that defines `codeOnly` and `offsetOf`. **The label is `(d)`**: that file's existing cases are `(a)`, `(b)` and `(c)` only, and the labels are how this plan's own Verification Rules refer to them.

```typescript
  it("(d) opsNotifier.start( follows the wiring, so (c)'s allowlist needs no entry (KPR-468 AC14)", () => {
    // Scope: this scans index.ts, not src/ops/. A later refactor that moves
    // `await opsNotifier.start()` above the wiring must either move it back or
    // add it to (c)'s allowlist under the reviewed-classification discipline
    // that list's own comment demands.
    //
    // offsetOf(), not codeOnly.indexOf(): a missing anchor still fails either
    // way (-1 > -1 is false), but a bare indexOf reports "expected -1 to be
    // greater than -1", while offsetOf reports the file's own "anchor not
    // found: … update this test's anchors" — which is the difference between
    // a reader who knows what happened and one who goes looking.
    const wiringStart = Math.max(offsetOf("await opsNotifier.init()"), offsetOf("setOpsNotifier("));
    expect(offsetOf("await opsNotifier.start()")).toBeGreaterThan(wiringStart);
  });
```

Then add a second lifecycle `describe`, on the KPR-456 block's pattern (`boot-order.test.ts:134-164`):

```typescript
describe("KPR-468 ops notifier readiness and drain order", () => {
  const code = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  function at(text: string): number {
    const offset = code.indexOf(text);
    expect(offset, "missing lifecycle anchor " + text).toBeGreaterThanOrEqual(0);
    return offset;
  }

  it("registers the singleton before every spawn-capable surface", () => {
    for (const surface of [
      "await bgTaskManager.start()",
      "await bgTaskManager.scanOrphans()",
      "await codeTaskManager.start()",
      "await slackAdapter.start(",
      "scheduler.start()",
    ])
      expect(at("setOpsNotifier(")).toBeLessThan(at(surface));
  });

  it("binds the transport before starting the sweep, and starts it after the adapters", () => {
    // D6/D10: the first subscription load happens inside start(), so every
    // validateTarget must run after every registerTransport — and a sweep that
    // began before its adapters exist would burn attempts against nothing.
    expect(at("opsNotifier.registerTransport(")).toBeLessThan(at("await opsNotifier.start()"));
    expect(at("await opsNotifier.start()")).toBeGreaterThan(at("dispatcher.registerAdapter(slackAdapter)"));
    expect(at("await opsNotifier.start()")).toBeGreaterThan(at("await slackAdapter.start("));
  });

  it("drains the notifier before closing Slack or Mongo", () => {
    const shutdown = code.slice(at("const shutdown = async"));
    const stop = shutdown.indexOf("await opsNotifier.stop()");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(shutdown.indexOf("await slackAdapter.stop()")).toBeGreaterThan(stop);
    expect(shutdown.indexOf("await mongoClient.close()")).toBeGreaterThan(stop);
  });

  it("adds no second SIGUSR1 listener", () => {
    expect(code.split('process.on("SIGUSR1"').length - 1).toBe(1);
  });
});
```

- [ ] **Step 7:** Verify, then **negative-verify** — mutation **NV8** (the plan index's Verification Rules; the only one hosted in this chunk).

```bash
npx vitest run src/boot-order.test.ts
npx tsc --noEmit
```

Expected: every case passes.

**Negative-verify (required):** move the whole `opsNotifier` wiring block from above the boundary marker to **immediately after `await bgTaskManager.scanOrphans();`**, re-run, and confirm **both `(b)` and `(c)` fail while `(a)` and the new `(d)` stay green** — predict all four before running.

- `(b)` bounds `Math.max(wiringOffsets) < Math.min(surfaceOffsets)`, and its offsets are **named surfaces**, not the marker (which is a comment the test never reads). The earliest named surface is `await bgTaskManager.start()`, so the relocated anchors now exceed it.
- `(c)` sweeps the region **before** `wiringStart`, which is a `Math.max` over the wiring anchors, so relocating pulls `bgTaskManager.start(` and `bgTaskManager.scanOrphans(` into that region and both surface as unallowlisted offenders. **That second red test reads as a mis-applied mutation and invites an implementer to "fix" it by widening `(c)`'s allowlist. Do not.** Record both offenders in the implementation report.
- `(a)` is presence-only, so it stays green — which is precisely why adding to `(a)` alone is the failure mode the guard exists to catch.
- `(d)` also stays green, and that is correct rather than a gap: it bounds `await opsNotifier.start()` against the **wiring**, and the relocated wiring still precedes `start()` (which sits after `await obligations.start(`, far below `scanOrphans`). `(d)` is about the allowlist argument; `(b)` and `(c)` are the boundary's guards.

**"Just below the marker" is NOT a valid mutation target.** KPR-454's plan measured that case: `(b)` bounds against named surfaces rather than against the marker, so a block relocated to just below the marker still sits above `bgTaskManager.start()` and `(b)` **passes** — the mutation never crosses the boundary the check enforces.

Restore.

- [ ] **Step 8:** `CLAUDE.md` (AC17).

**(a) The engine-written MongoDB collections list.** Insert alphabetically-adjacent to KPR-454's three `ops_*` entries:

> `ops_notifications` (KPR-468 — the D7 acknowledgement ledger, one document per `(subscriptionId, dedupeKey)`; **nine** indexes: a **unique** `(subscriptionId, dedupeKey)` that carries a correctness role (its failure alone leaves the notifier unstarted — the duplicate-key error *is* the race detector for the sweep's conditional-update-then-insert), `{dedupeKey: 1}` for the clearing fan-out (which is applied across **all** subscriptions, independent of the clearing event's own matches — a clearing reason is `informational` and normally matches nobody), three delivery-scan arms `{state, attemptCount, nextNudgeAt}` / `{forceDeliver, nextNudgeAt}` / `{state, nextNudgeAt}` whose first two are structurally immune to the cadence-stall backlog by a leading-key equality bound, two saturating-gauge indexes `{stalledReason, state}` and `{lastOutcome, state}`, `{state, snoozedUntil}` for snooze expiry, and a `{expiresAt: 1}` TTL at `expireAfterSeconds: 0`. **No index is `sparse`** — a compound sparse index over ascending keys indexes a document containing *at least one* key, so the flag would have been a no-op dressed as a guarantee; boundedness rests on leading-key equality plus MongoDB's type bracketing. Retention is state-conditional and the conditional lives in the **field**: `expiresAt` is set only while the row is stopped (`seen`/`dismissed`/`cleared`) at `stateAt + min(30 d, config.activity.retentionDays)` and is unset while it is working (`pending`/`delivered`/`snoozed`) — a TTL on `stateAt` would delete working rows), `ops_policy` (KPR-468 — one operator-written document `_id: "ops"` holding the D8 cadence table keyed `<class>:<retry>`, D5's named cadence profiles, the minimum-nudge floor and the snooze maximum; no TTL, and **zero rows ship** — its content is the deployment gate)

**(b) The `telemetry` entry.** Append to that collection's existing parenthetical:

> ; ops notifier heartbeat `ops_notifier_stats` KPR-468 — sweep freshness, cursor position, `eventsBehind`/`oldestUnappliedAt`, the four saturating row gauges and every fault counter, read by KPR-455; **and `ops_sweep_cursor` KPR-468, which is DURABLE SWEEP PROGRESS, NOT A HEARTBEAT** — every other document in this collection is disposable stats and a reader must not generalize from them. Dropping the `telemetry` collection therefore has a consequence the other kinds do not have: the cursor re-initializes to the server clock (never to the beginning of the log — a backfilling notifier would deliver weeks of history on its first tick and re-mint rows for conditions whose ledger rows had already aged out), so every event published in the gap is **never notified**. Bounded, counted as `cursorReinitialized`, and **not recoverable by a restart**.

**(c) One Common Gotchas bullet:**

> - **Ops notifier — the acknowledgement ledger (KPR-468):** the wire between KPR-454's publish and KPR-455's read. It mints one `ops_notifications` row per `(subscriptionId, dedupeKey)` from the `matchedSubscriptionIds` the accept path stamped — it **never re-evaluates a match** — delivers each through an `OpsTransport` adapter, nudges on an operator-registered cadence, expires snoozes, and applies clearing facts, all on a bounded non-overlapping 30 s sweep. Acknowledgement intake is the one non-swept path: a direct, deadline-bounded read-plus-CAS live from `init()`. **The intended steady state is that nothing is delivered:** with zero `ops_subscriptions` rows no ledger row is ever created. **With no `ops_policy` cadence registered a row is *attempted* once per occurrence — its first appearance, each recurrence after a clear, and each expiry of a snooze — and is never nudged between them.** The word is *attempted*, not *delivered*: no retry ladder ships (D6's `rejected` carries no retry hint to schedule from), so a first attempt that comes back `rejected` or `unknown` means that occurrence is never delivered at all, with no re-attempt until the row's next occurrence. Two levers, both **data, no `hive.yaml` key**: `ops_subscriptions.enabled: false` on one row stops delivery and nudging for that subscriber within one 60 s reload (resuming takes that reload **plus** one ~5 min stall re-check, because a declined row is pushed forward rather than left at the head of the due-scan), and registering or restoring an `ops_policy` cadence entry resumes nudging within one stall re-check with no restart. Rollback is a code revert. **Sequencing: KPR-468 must not ship without KPR-455's inbound acknowledgement edge** — an operator who registers both a subscription and a cadence before that edge lands gets `judgment`/`integrity` rows and never-recovering `resource` conditions nudging with nothing able to acknowledge them, and the per-subscription kill switch is the only stop. One `hive doctor` caveat: this ticket ships **no** doctor section; the heartbeat is a write and every reader is KPR-455's. Diagnosing a stuck sweep: `ingestFaults` climbing while `cursorAt` stands still and `oldestUnappliedAt` ages is **one event faulting deterministically** — ingest stops at it on every tick by design (no automatic skip, no quarantine), and the remedy is operator intervention: repair or remove the offending `ops_events` document, or deliberately write the cursor past it.

- [ ] **Step 9:** Verify and commit.

```bash
npx vitest run src/boot-order.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check
git diff --check
```

Expected: exit 0 throughout. Record actual test totals; do not invent them.

```bash
git add src/index.ts src/boot-order.test.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(KPR-468): wire the ops notifier above the spawn-capable boundary

D10: construction, init() and setOpsNotifier above index.ts's boundary
marker — intake is reachable from a turn, since D6 names an agent tool
call among the inbound acknowledgement edges KPR-455 will build — with
both anchors in all three of boot-order.test.ts's lists and a new
lifecycle block pinning registerTransport before start(), start() after
dispatcher.registerAdapter(slackAdapter) and slackAdapter.start(), and
opsNotifier.stop() before Slack and Mongo close.

The wiring and the start() have deliberately disjoint valid ranges (the
workerPool.start() precedent): a sweep that began before its adapters
exist would burn attempts against nothing, and the first subscription
load lives inside start() so every validateTarget has an adapter to run
against.

CLAUDE.md gains ops_notifications and ops_policy with their keys, indexes
and TTL posture, both new telemetry kinds — with ops_sweep_cursor marked
as durable sweep progress rather than disposable stats — and one Common
Gotchas bullet naming the two data levers, the no-cadence default in its
precise "attempted once per occurrence" form, and the KPR-455 sequencing
constraint.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
