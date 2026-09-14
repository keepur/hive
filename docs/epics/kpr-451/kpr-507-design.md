# KPR-507 — Ops publisher: order subscription reloads so a stale read cannot restamp immutable matches

## TL;DR

`OpsPublisher.reloadSubscriptions()` (`src/ops/publisher.ts:291-304`) assigns every completed `ops_subscriptions` read unconditionally. The 60 s timer and the existing SIGUSR1 handler (`src/index.ts:726`) overlap, so an older read that finishes last replaces a newer committed set; match evaluation (`publisher.ts:739`) then writes that obsolete list onto the immutable `ops_events` insert as `matchedSubscriptionIds`. This child mirrors the start-numbered commit KPR-468 applied to the notifier's own reload: a completion replaces the array only if no later-started reload has already committed. Failed and `stopping`-skipped reloads commit nothing and supersede nothing, so KPR-454's "a reload fault keeps the previous set" canon holds. The two caches stay separate.

## Key Points

- **The race has two directions and they are not equal.** Disable-then-stale-restore stamps obsolete interest; once KPR-468's notifier has committed its own disable reload it creates no new row and makes no post, so downstream harm is bounded. Enable-then-stale-wipe stamps `[]` onto an event that should have matched; KPR-458 forbids downstream re-evaluation, so that event's notification is **permanently lost**.
- **Order by start, not by finish.** Every read-performing reload takes the next `reloadsStarted` number *before its first await*. A result commits only when `seq >= reloadCommitted`. The comparison, the committed number, the array replacement and the post-load audit run synchronously — no await between them.
- **Fault and stop semantics are preserved, not rewritten.** `if (this.stopping) return` still allocates no sequence number and performs no read. A thrown load increments `subscriptionReloadFaults`, warns, returns, and does **not** advance `reloadCommitted`. Publisher reload never rethrows: `init()` stays boot-non-fatal and an empty first set remains a legal zero-match.
- **The post-load audit and its gauge are properties of the committed set.** `subscriptionRowAnomalies` is SET per committed reload, unlike the notifier's cumulative `subscriptionUnloaded`. A discarded success must not run `auditSubscriptionRows`, must not rewrite `subscriptionAnomalySignature`, and must not increment `subscriptionReloadFaults`. A discarded older success that *would* have restored a clean set must not zero a gauge a newer commit just raised.
- **`init()` / the enable-gate / match evaluation do not have a second unordered-commit site.** The only assignment to `this.subscriptions` is inside `reloadSubscriptions`. `init()` awaits that method and arms the timer *after* the await. `auditLoadedEnableGate` reads the reasons map, once, and never the subscription array. SIGUSR1 is registered after `init()` at boot (`index.ts:566` then `:719`), so production first-load cannot overlap the signal; tests still pin the first-load interleaving.
- **Do not share or merge the two caches.** KPR-468 canon: this ordering is local to the publisher the same way the notifier's is local to the notifier. KPR-501 consumes the fix by publishing through the existing `OpsPublisher` accept path; it must not fork a second unordered loader.
- **In scope:** ordered commit in `reloadSubscriptions`, preservation of every counter and latch that path already touches, barrier-driven regressions through the real publisher + matcher + insert, a one-line `CLAUDE.md` note. **Out of scope:** downstream re-matching, cache consolidation, KPR-501's producer, KPR-455's reader, any `ops_events` / subscription schema change, any new `hive.yaml` key.
- **⚠ Residual, inherited from KPR-468, not enlarged:** two overlapping reads that both *started* before a mutation can both snapshot the pre-mutation set; the next timer or SIGUSR1 heals. Start-order is the operator-intent case (SIGUSR1 after a disable, overlapping a timer that started before it). Named, not solved.

## Scope and authority

Ticket: **KPR-507 — Ops publisher: order subscription reloads so a stale read can't restamp immutable matches**. Parent: KPR-451. Filed by the epic driver from a Frontier sibling observation during KPR-468's child-final review (round 3, `caught-by: child-pr/3/Frontier`). Not a MATERIAL_DRIFT corrective: KPR-454's design of the loaded set is right; this is an implementation race on overlapping completions.

Worktree baseline: `epic/kpr-451` at `c79eafac` (KPR-468 merged). Every runtime fact below was read at that tree.

**Binding canon** (following a bullet needs no re-justification; contradicting one is a finding):

- **KPR-454:** a reload fault keeps the previous set; it never empties it, because an empty set silently makes every event a zero-match. Subscription rows are loaded and untrusted; a row lacking a plain-object `filter` or a string `_id` (≤200) is skipped from matching and counted. `matchedSubscriptions` is exactly `matchedSubscriptionIds.length`, never capped. `init()` is boot-non-fatal. Counters live only behind uncalled `getSnapshot()`.
- **KPR-458:** match evaluation is pure, rides the immutable publish insert as `matchedSubscriptionIds`, and is **never re-evaluated downstream**. The accept path ships with the producer.
- **KPR-468:** completed disables stop later posts: older reloads cannot replace later successful commits, while failed or guard-skipped reloads supersede nothing. **This ordering is local to the notifier and does not repair the publisher's separate cache.** Future producers, including KPR-501, must preserve the shared publish/drain ordering consumed by the notifier's cursor. Sibling follow-up KPR-507 (this ticket) blocks KPR-501.

**Dependencies.** KPR-454 is merged (`c068ee33`) and is the code this ticket edits. KPR-468 is merged (`c79eafac`) and is the pattern this ticket mirrors, not a code dependency: nothing in `src/ops/notifier.ts` is imported or copied as a shared helper. KPR-501 is Backlog and blocked by this ticket. KPR-455 is Backlog and is **not** affected (confirmed below).

This artifact follows `docs/epics/kpr-451/` and the conventions in `CLAUDE.md` / `AGENTS.md`. Drafting does not approve an implementation plan. KPR-454's signed design body is not edited: overlapping-commit order was unspecified there, and a human-signed artifact is corrected by append-only supersession, never by editing the signed body (KPR-458 canon). This spec is that supersession for the reload-commit rule.

## Problem and observed code

### What runs today

`loadSubscriptions()` (`src/ops/store.ts:266-268`) is a bare `find({ enabled: true }).toArray()` — no sort, no shape check, no generation token. `OpsPublisher.reloadSubscriptions()` is the only writer of `this.subscriptions`:

```
async reloadSubscriptions(): Promise<void> {
  if (this.stopping) return;
  try {
    this.subscriptions = await this.store.loadSubscriptions();
  } catch (err) {
    this.counters.subscriptionReloadFaults += 1;
    log.warn("Ops subscription reload failed — keeping the previous set", { error: String(err) });
    return;
  }
  this.auditSubscriptionRows(this.subscriptions);
}
```

The assignment is the await. Two overlapping calls both pass the `stopping` check, both issue a find, and **whichever find settles last wins**, regardless of which call started first.

Callers of that method, all fire-and-forget except `init()`'s first await:

| Site | Shape |
| --- | --- |
| `init()` `:220` | `await this.reloadSubscriptions()`, then the timer is armed |
| 60 s timer `:229` | `setInterval(() => void this.reloadSubscriptions(), SUBSCRIPTION_RELOAD_MS)`, `unref()`'d |
| SIGUSR1 `src/index.ts:726` | `void opsPublisher.reloadSubscriptions()` inside the existing handler, never a second `process.on` |
| Tests | direct `await publisher.reloadSubscriptions()` after inserting rows |

Accept-path step 6 (`publisher.ts:739`) is a pure `evaluateMatches(draft, this.subscriptions)`. Step 8 inserts that array as `matchedSubscriptionIds` and its length as `matchedSubscriptions`. Nothing downstream re-reads `ops_subscriptions` to decide who was interested.

### The reproduction (KPR-468 child-final review, both directions, through the real publisher + matcher + insert)

| Database state after change | Loaded count after newer reload | After older completion | Next event's stamp |
| --- | --- | --- | --- |
| Subscriber **disabled** (`enabled: false`, so `find({enabled:true})` returns it no longer) | 0 | 1 | `["subscriber"]` |
| Subscriber **enabled** | 1 | 0 | `[]` |

The construction is the double's `pause(collection, operation, when, after=true)` (`src/ops/testing/fake-db.ts:369-394`). `operation()` copies the find result **before** entering the after-hook (`:323-325`), so reload A can hold a genuinely older captured array while reload B runs against the mutated collection and commits.

### Why the two directions differ

KPR-468 ingest resolves each stamped id against *its own* loaded map and creates no row for an id that is absent, disabled, or whose target fails `validateTarget`. After the notifier has committed a disable reload, a stale publisher stamp naming that id is a no-op at ingest: no new row, no post. Bounded, still wrong (the stored `matchedSubscriptions` count is a lie about accept-time interest), but not a lost notification.

The enable direction has no such backstop. The event is stored with `matchedSubscriptionIds: []`. The notifier never sees the subscriber. A later publisher reload cannot patch an immutable document. That is the KPR-458 C2/D5 rule working as designed against a dishonest stamp.

A filter change on an already-enabled row is the same commit race with the same two blast radii (obsolete interest vs. a missed match). The required reproductions are the enable/disable pair; the commit rule covers the filter case without a third mechanism.

### What is *not* the same shape

- **`auditLoadedEnableGate` (`publisher.ts:261-288`).** Runs once at the end of `init()`, over the reasons map, contained, never assigns `this.subscriptions`. Reasons do not reload (restart is the lever). Not in this race.
- **Match evaluation.** A pure read of the current array. No assignment.
- **The notifier's reload.** Already ordered (`notifier.ts:294-405`, `reloadsStarted` / `reloadCommitted`). Separate projection: compiled filters above the spawn-capable boundary vs. transport bindings validated against adapters registered below it. Canon keeps them separate.
- **KPR-455.** Reads stored `ops_events` (and the notifier heartbeat). It never consults the publisher's in-memory array. This fix makes the stamps it already renders as `matchedAtPublish` honest under overlap; it does not change the envelope, the rendering rule, or any KPR-455 file.

## Goals and non-goals

**Goals.** A later-started successful publisher reload cannot be undone by an earlier-started one finishing after it. The next event's immutable stamp reflects the later committed set, in both directions of the reproduction. A reload fault still keeps the previous set and still counts. A `stopping` skip still reads nothing and still supersedes nothing. The post-load audit and every counter that path already touches keep their documented meaning. KPR-501, publishing through this publisher, inherits the ordered cache without rebuilding it.

**Non-goals.** Re-evaluating matches downstream. Merging the publisher and notifier subscription projections, extracting a shared loader, or sharing the sequence-number pair. Changing `loadSubscriptions()`, `evaluateMatches`, the accept-path field set, or `matchedSubscriptions ≡ length`. Adding `rethrow` to the publisher (the notifier's `start()` posture; the publisher has no `start()`). Resetting the sequence pair on re-entrant `init()`. A write-guard skip on the publisher (it has none today). Single-flighting the reload. Any KPR-501 producer work. Any KPR-455 reader/intake work. Any new collection, index, `hive.yaml` key, heartbeat, or doctor section.

## Design

### D1. Start-numbered commit, local to the publisher

Add two private integers on `OpsPublisher`, initialised to `0`:

```
reloadsStarted: number   // incremented once per read-performing call
reloadCommitted: number  // the seq of the last load that replaced this.subscriptions
```

They are mechanism. They do not appear on `getSnapshot()`. They are not the notifier's pair and are not exported.

`reloadSubscriptions` becomes:

1. `if (this.stopping) return;` — **before** taking a number. Guard-skipped calls perform no read, allocate no sequence number, supersede nothing. This is the existing latch, preserved, not a second check at commit time.
2. `const seq = ++this.reloadsStarted;` — **before the first await**, so start order is call order, not find-settlement order.
3. `const next = await this.store.loadSubscriptions();` into a **local**. The field is not touched yet.
4. On throw: `subscriptionReloadFaults += 1`, the existing warn, `return`. Do **not** assign `reloadCommitted`. Do **not** run the audit. Do **not** rethrow. An older in-flight success is still a fresher snapshot than the retained set, so it may still commit when it lands.
5. On success, synchronously:
   - `if (seq < this.reloadCommitted)` → one `log.debug` naming `reload` and `committed`, `return`. Not a fault.
   - else `this.reloadCommitted = seq; this.subscriptions = next; this.auditSubscriptionRows(next);`

The comparison, the committed-number write, the array replacement and the audit call execute with no await between them. Two completions cannot interleave the commit the way two awaits currently interleave the assignment.

Use `seq < reloadCommitted` (strict), matching the notifier. Each call takes a unique incremented seq, so equality is not a live case; do not invent a different comparator.

**Why not single-flight.** A SIGUSR1 that arrived while a timer load was in flight would join the in-flight promise and return the snapshot that started *before* the operator's disable. That is the kill-switch case. Ordered overlapping reads keep the signal's own find.

**Why not last-writer-wins with a "generation" from Mongo.** `loadSubscriptions()` returns no token, and adding one is a store change this ticket does not need. Start-order is the KPR-468-approved answer for the same two callers (timer and SIGUSR1) against the same collection.

**Do not extract a helper shared with `OpsNotifier.reloadSubscriptions`.** That is cache-consolidation adjacent, a cross-child edit to a merged sibling, and a different projection (array + admissibility audit vs. Map + bindability / `validateTarget`). Duplicate the six-line commit rule; do not DRY it.

### D2. Every counter and latch on this path, restated so a discarded load cannot lie

The reload path already touches four observables. After D1 they mean:

| Observable | Kind | On committed success | On discarded success | On thrown load | On `stopping` skip |
| --- | --- | --- | --- | --- | --- |
| `this.subscriptions` | current set | replaced with `next` | unchanged | unchanged (previous set) | unchanged |
| `getSnapshot().subscriptions` | `this.subscriptions.length` | new length | unchanged | unchanged | unchanged |
| `subscriptionRowAnomalies` | **gauge, SET per committed reload** (existing comment at `publisher.ts:130-134`: never accumulated) | `auditSubscriptionRows` sets it to the inadmissible count of `next` | **must not run the audit** — a discarded older success that captured a clean set would otherwise zero a gauge a newer commit just raised | existing: "the previous set is kept and was already audited, so re-auditing it would only re-set the counter to the value it already holds" (`:298-301`) | no-op |
| `subscriptionAnomalySignature` | change-latch for the warn | updated inside the audit | **must not run the audit** | unchanged | unchanged |
| `subscriptionReloadFaults` | monotonic | unchanged | **unchanged** (not a fault) | `+= 1` | unchanged |
| `reloadCommitted` | mechanism | set to `seq` | unchanged | unchanged | unchanged |
| anomaly warn | change-latched | fires iff the signature of `next` differs | must not fire | must not fire | must not fire |
| "reload failed" warn | per fault | no | no | yes, existing text | no |
| debug "superseded by a later reload" | per discard | no | yes, once | no | no |

`auditSubscriptionRows` stays contained (its own try/catch, audit-threw latch on `SUBSCRIPTION_AUDIT_FAULT_SIGNATURE`). Containment is not permission to run it on a discarded set: the method mutates the gauge and the signature, which are properties of what is committed.

No new counter. No new `getSnapshot()` field. The existing `subscriptionReloadFaults` / `subscriptionRowAnomalies` / `subscriptions` snapshot fields remain the operator-visible surface.

### D3. `init()`, first load, re-entrancy, stop — no second commit rule

**First load is this method.** `init()` `:220` is `await this.reloadSubscriptions()`. There is no parallel assignment, no `subscriptionsLoaded` flag, and no `rethrow` parameter. An empty array is both "no successful load yet" and "zero enabled subscriptions"; that coincidence is legal under KPR-454 (zero-match is a stored fact, and the intended shipped state is zero rows). A first-load fault therefore keeps `[]`, counts, and lets `init()` resolve — the existing boot-non-fatal posture. Do not add `rethrow`. Do not refuse to start the timer because the first load faulted. Do not treat `[]` as "not yet a set" the way the notifier treats its initial empty Map (`subscriptionsLoaded`).

**Timer vs. first load, production.** `init()` awaits the first reload *then* arms the interval (`:220` then `:226-230`). SIGUSR1 is registered later (`index.ts:719`), after `await opsPublisher.init()` (`:566`). On a normal boot the first load cannot overlap the timer or the signal.

**Timer vs. re-entrant `init()`, tests.** `init()` is re-entrant by design (`:221-225`). A second `init()` awaits a reload while the first init's interval may still be live. That *is* an overlap. D1 covers it. **Do not reset `reloadsStarted` / `reloadCommitted` on re-entry.** The notifier resets `subscriptionsLoaded` in `start()` because adapters bind below the boundary and the first `start()` load must re-validate; the publisher has no such re-validation and a reset would re-open "older finisher wins" against whatever committed during the previous life of the instance.

**`stop()`.** Sets `stopping`, clears the timer, then drains for up to `SHUTDOWN_DRAIN_MS`. The start-of-method guard is what makes a SIGUSR1 or a stray timer tick after `stop()` a no-op. An in-flight reload that already took a seq may still commit if it is the newest started success; drain jobs still in the queue then match against that set. That is existing behaviour plus D1, not a new shutdown contract. Do not add a second `stopping` check at commit time. Sequence ordering does not weaken the enqueue-side `stopping` refusal (`publisher.ts:486`).

**Enable-gate audit.** Unchanged, still after the first reload in `init()`. It does not read `this.subscriptions`.

### D4. Integration points (read-only or additive; no sibling rewrite)

| Point | Action |
| --- | --- |
| `src/ops/publisher.ts` `reloadSubscriptions` | The change. D1–D3. |
| `src/ops/publisher.ts` `init` / `stop` / `auditSubscriptionRows` / `auditLoadedEnableGate` / `accept` | Unchanged control flow. `init()` keeps calling `reloadSubscriptions()`; it does not grow a second loader. |
| `src/ops/store.ts` `loadSubscriptions` | Unchanged. |
| `src/ops/match.ts` | Unchanged. |
| `src/index.ts` SIGUSR1 | Unchanged. Still `void opsPublisher.reloadSubscriptions()` and, separately, `void opsNotifier.reloadSubscriptions()`. Still one listener. |
| `src/boot-order.test.ts` | No new anchor. No new `.start(`. |
| `src/ops/notifier.ts` | Not imported, not edited. |
| `CLAUDE.md` ops-publishing bullet | One sentence on ordered publisher reloads (AC8). The notifier's existing "older reloads cannot replace later successful commits" clause stays about the notifier. |
| KPR-501 | Out of this diff. Disposition: publish through this `OpsPublisher` (the module-global singleton and its accept path). Do not add a second `reloadSubscriptions` on a new class. The shared publish/drain ordering KPR-468 already requires of KPR-501 is a different constraint and is already canon. |
| KPR-455 | Out of this diff. It reads stored stamps and the notifier heartbeat; it does not read `this.subscriptions`. No rematuration is owed by this race-fix. (KPR-455's existing readiness strip is the rejected KPR-454 GATE1_AMENDMENT / empty ack-edge arm 1, unrelated.) |

### D5. Named residual

Start-order commits the later-*started* snapshot, not the later-*observed* one. If reload B starts after A, B's find runs, then a mutation happens, then A's find runs, B can commit the pre-mutation set and A's post-mutation set is discarded. The window is one overlap; the next timer (≤ 60 s) or SIGUSR1 heals. This is the same residual KPR-468 accepted. It is strictly smaller than today's last-finisher-wins, which loses the operator-intent case (A started before the disable, B started after it, A finishes last and restores the subscriber).

Two overlapping reads that both started before the mutation can both snapshot the pre-mutation set. Same healing path. D12 already rules that a reload lag may miss an event by seconds and that this is not a new failure mode, because D5 forbids retrospective enrolment.

## Acceptance criteria

Each criterion is an assertion a test can fail, not a restatement of D1.

1. **Disable direction, through the insert.** A later reload that observes `enabled: false` (loaded count 0) is not undone by an earlier reload that captured the enabled row finishing after it. The next published event — driven through `observeToolFailure` → enqueue → drain → accept → `insertOne` — has `matchedSubscriptionIds: []` and `matchedSubscriptions: 0`. `getSnapshot().subscriptions` stays 0 after the older completion.
2. **Enable direction, through the insert.** A later reload that observes an enabled row (loaded count 1) is not undone by an earlier reload that captured the empty/disabled set finishing after it. The next published event's `matchedSubscriptionIds` equals `[<that id>]` and `matchedSubscriptions` is 1. This is the permanent-loss direction and is not optional.
3. **A later reload that FAILS does not block the one after it, and that one still beats the earlier read.** Fault increments `subscriptionReloadFaults` and retains the then-current set; a subsequent successful reload commits the post-fault collection state; the original in-flight older success, released after that, does not restore its captured set. Next event stamps the post-fault committed set.
4. **An earlier read finishing after ONLY a failed later reload commits** — it is newer than the retained set. `subscriptionReloadFaults` is 1, the superseded debug line is **not** emitted, and the next event stamps the older-but-still-fresher-than-retained set. This is the fault-retention canon (KPR-454: a reload fault keeps the previous set *and does not supersede in-flight successes*).
5. **Discarded earlier first load.** `init()`'s first `reloadSubscriptions` is held after capturing its find; a concurrent `reloadSubscriptions()` commits a set the first find did not see; releasing the first load leaves the later set. `init()` resolves (timer armed, enable-gate audit ran, no throw). The next event stamps the later set. Pins that `init()` has no second unordered assignment and that we did not add a `rethrow` / unstarted posture.
6. **Discarded success is not a fault and does not run the audit.** After a newer commit has set `subscriptionRowAnomalies` to N>0 (a bad row appeared) and fired the anomaly warn once, releasing an older success that captured the clean set leaves the gauge at N, does not increment `subscriptionReloadFaults`, and does not emit a second anomaly warn or a "reload failed" warn. The converse — newer commit repaired the set to 0 anomalies; older captured the broken set — leaves the gauge at 0. This is what makes `subscriptionRowAnomalies` remain "the CURRENT loaded set" (`publisher.ts:130-134`) rather than "the last find that happened to finish".
7. **`stopping` skip still supersedes nothing.** After `stop()`, a `reloadSubscriptions()` call returns without a find (no new `operations` entry for `ops_subscriptions`/`find`), without incrementing `subscriptionReloadFaults`, and without incrementing `reloadsStarted`. Existing enqueue-side `stopping` refusal and bounded drain are unchanged. (`stop()` does not clear `stopping`; a new process or a new `OpsPublisher` instance is the restart path, as today.)
8. **`CLAUDE.md`.** The KPR-454 ops-publishing bullet gains one sentence: publisher subscription reloads are ordered by start; an older completion cannot replace a later successful commit; failed or `stopping`-skipped reloads supersede nothing. It must not claim the notifier fix repaired the publisher, and it must not imply the two caches are shared.

Existing criteria this child must not break, already tested, not re-specified: a reload fault keeps the previous set and leaves `subscriptionRowAnomalies` at the kept set's value (`publisher.integration.test.ts` "a reload FAULT leaves the counter alone"); a standing bad row warns once across reloads, not once per 60 s; the signature is order-independent; `matchedSubscriptions` is the stamped list's length with no cap; `init()` whose every `createIndex` rejects still yields a wired publisher.

## Testing Contract

The plan derives its contract from this section. Groups, commands and harness are fixed here; chunking is the plan's.

### Required test groups

- **Unit: not-required** (new cases). The commit rule is not extracted as a pure function — extracting it to share with the notifier is out of scope (D1). Existing `src/ops/match.test.ts` remains regression for the evaluator this stamp still calls. Do not add a unit suite whose only purpose is to justify an extraction this spec refuses.
  - Scope if a plan nevertheless extracts a helper: the comparator only (`seq < committed` vs. fault-does-not-advance). That extraction would be a spec mismatch, not a testing win.
  - Reason: the able-to-fail property is the interleaving against a captured find plus an immutable insert, which a unit test of two integers cannot see.

- **Integration: required.**
  - Scope: barrier-driven overlapping reloads on a real `OpsPublisher` over the existing in-memory Mongo double, with match evaluation and the accept-path insert in-process — not a mocked `reloadSubscriptions`, not a stubbed `evaluateMatches`, not an assertion on log lines alone.
  - Reason: both blast radii live on `ops_events.matchedSubscriptionIds`. A snapshot-length assertion without the next insert misses the enable-direction permanent loss. A matcher-only assertion misses the immutability.
  - Harness: **existing**, extended. `src/ops/testing/fake-db.ts` already copies the find result before the after-hook and already exposes `pause(collection, operation, when, after=true)` and `failNext`. `OpsPublisher.__drainForTests()` is already the publish→assert barrier. `src/ops/publisher.integration.test.ts` already constructs `FakeDb` + `OpsPublisher` + `setOpsPublisher` and drives `observeToolFailure`. Add a `describe` there (or an immediately-adjacent `src/ops/publisher-reload.integration.test.ts` if the file's size bound forces a split — prefer extending the existing file). Do not create a new harness module; do not import `notifier-harness.ts`.
  - Minimum assertions: AC1–AC7 as named tests. AC1 and AC2 each assert the **inserted document's** `matchedSubscriptionIds` and `matchedSubscriptions`, not merely `getSnapshot().subscriptions`. AC3–AC5 assert both the committed snapshot and the next event's stamp. AC6 asserts gauge, fault-counter and warn counts. AC7 asserts the absence of a find. The disable/enable pair uses `pause(OPS_SUBSCRIPTIONS_COLLECTION, "find", () => true, true)` — `after=true` is load-bearing; `after=false` holds *before* the copy and does not reproduce the captured-stale-result race. Fault injection uses `failNext` / an nth-call `when` against that same `find`, never `stop()` as a mid-scenario barrier (`publisher.ts:419-420`: `stop()` sets `stopping`, so later enqueues silently no-op).
  - AC8 is a documentation assertion: the `CLAUDE.md` sentence is present; a source scan or a focused string test is enough. Do not parse English beyond presence of the ordered-commit claim and absence of a "notifier repaired the publisher" claim.

- **E2E: not-required.**
  - Scope: a deployed instance, a live Mongo, a real SIGUSR1 against a running hive, a real 60 s wait.
  - Reason: the race is a process-local interleaving of two `find`s. The double's after-hook is a stricter construction than a live timer (it *guarantees* A holds a copied older result while B runs). A live SIGUSR1 adds nondeterminism and no further stamp rule.
  - Harness: not-applicable.
  - Minimum assertions: none; no assertion is waived from the integration group.

### Critical flows

- Timer-shaped reload A captured `{s1}` → operator disables `s1` → SIGUSR1-shaped reload B commits `[]` → A finishes → failure publish stamps `[]`.
- Reload A captured `[]` → operator enables `s1` → B commits `{s1}` → A finishes → failure publish stamps `["s1"]`.
- A held → B throws (`subscriptionReloadFaults === 1`, set retained) → C commits the post-fault collection → A finishes, discarded → next stamp is C's set.
- A held → B throws → A finishes and commits (no superseded debug line) → next stamp is A's set.
- `init()` first find held on empty → insert `s1` → concurrent reload commits `{s1}` → first find discarded → `init()` resolves → next stamp is `["s1"]`.
- Newer commit raised `subscriptionRowAnomalies` to 1 → older clean capture discarded → gauge stays 1, no fault increment, anomaly warn not re-fired.

### Regression surface

- Existing `publisher.integration.test.ts` anomaly suite (ObjectId `_id`, malformed `filter`, standing-row warn-once, order-independent signature, second-row warn, gauge returns to 0 on repair, fault leaves the gauge alone).
- `matchedSubscriptions === matchedSubscriptionIds.length` with a set larger than the reverted cap (`publisher.integration.test.ts` "no stored-list cap").
- `src/ops/acceptance.integration.test.ts` AC2 (zero-match document shape) and the reload-then-match subscriber-added path.
- `src/ops/capture-points.integration.test.ts` — capture points do not call `reloadSubscriptions` themselves; they must keep publishing.
- KPR-468 delivery/intake/notifier suites — this child does not edit `notifier.ts`. The double is shared; `pause` / `failNext` / `copy`-before-after-hook behaviour must remain.
- `src/boot-order.test.ts` — no new `.start(`, no moved `await opsPublisher.init()` / `setOpsPublisher(`.
- `src/index.ts` SIGUSR1 body — still one listener, still two separate `void …reloadSubscriptions()` calls, still no shared cache.

### Commands

Run from the child implementation worktree on Node 22 or 24 (CLAUDE.md: dev mode on Node 26 is broken by the Qdrant client's bundled dispatcher). A missing install is setup, not a skipped test. Dummy Slack env as today.

- Setup: `node --version` (expect v22.x or v24.x); `npm ci` if `node_modules` is missing
- Integration (this child): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/publisher.integration.test.ts`
- Adjacent publisher/accept regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/publisher.integration.test.ts src/ops/acceptance.integration.test.ts src/ops/capture-points.integration.test.ts src/ops/match.test.ts`
- Notifier regression (shared double): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/ops/delivery.integration.test.ts`
- Boot regression: `npx vitest run src/boot-order.test.ts`
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Hygiene: `git diff --check`
- Expected: exit 0, all selected tests pass, no skipped new contract cases. Record actual totals; do not invent expected test counts. Drafting makes no runtime success claim.

### Harness requirements

- `FakeDb.pause(OPS_SUBSCRIPTIONS_COLLECTION, "find", () => true, true)` — fourth argument `true` (after the copy). The KPR-468 reviewer pinned that `operation()` copies before the after-hook; publisher tests that hold *before* the find do not reproduce F1.
- `FakeDb.failNext` with an nth-call `when` for AC3/AC4. Do not wrap a second `failNth` in a new module; an inline counter in the test file is enough (the notifier helper exists because that suite already had one).
- `observeToolFailure` + `await publisher.__drainForTests()` as the only publish→assert barrier. Do not `await` the observe call and read Mongo; enqueue is synchronous and fires `void this.drain()`.
- Matching subscription fixture: an admissible enabled row (`plain-object filter`, string `_id` ≤ 200) so AC2's stamp is `[id]` rather than `[]` for an unrelated skip. Reuse the shape already in `publisher.integration.test.ts` (`subscriberId` / `transport` present so the row is a realistic document; the publisher matcher does not read `transport`).
- Logger remains the hoisted `mockLog` already in that file (`debug` is already a `vi.fn()`). AC3/AC4/AC6 count debug/warn calls through it.
- No live Mongo, no Slack token, no Anthropic key, no real SIGUSR1, no fake timers for the 60 s interval (the overlap is constructed with `pause`, not with `vi.advanceTimers`).

### Non-required rationale

- Unit: stated above — the comparator is not a product surface; the insert is.
- E2E: stated above — the double's after-hook is the reproduction, and a live signal cannot pin both directions deterministically.

### Verification rules

- Missing harness is not a skip reason; the double already has `pause(..., after=true)`.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote to the spec lane rather than reinterpreting this spec.
- Negative-verify is required at three points, each naming the mutation and the test that must fail:
  1. **AC1/AC2's commit rule** — restore unconditional `this.subscriptions = await this.store.loadSubscriptions()`. Both direction tests fail on the inserted stamp (disable restores `["s1"]`; enable restores `[]`).
  2. **AC6's audit-on-commit** — call `auditSubscriptionRows` on the discarded `next` as well. The gauge-stays-N case fails (older clean capture zeros it).
  3. **AC4's fault-does-not-supersede** — advance `reloadCommitted` in the `catch`. The "older success after only a failed later reload still commits" case fails (stamp stays the pre-A set).
- Restore after each mutation. Run targeted vitest while changing the reload, then `npm run check` before submission.

## Deployment and rollback

No schema change, no index change, no `hive.yaml` key, no new operator lever, no enrolment. The shipped state remains zero `ops_subscriptions` rows and `matchedSubscriptions: 0` on every event.

**Deploy.** Ordinary code deploy. The race only fires when two reloads overlap *and* the collection mutates between their finds *and* a publish lands on the restored-stale set. With zero rows the enable direction is unreachable and the disable direction has nothing to restore. Ordering is still the right default once an operator registers a subscriber (KPR-501's second producer, and any KPR-468 live deployment).

**Rollback.** Code revert. No configuration flag. A revert re-opens F1; it does not strand documents (stamps already written stay, which is the immutability the fix exists to respect).

**KPR-468 deployment gate is unchanged.** This child does not register subscriptions, cadence, or an inbound edge.

## Assumptions and remaining decisions

- **Non-blocking, observed:** production `init()` cannot overlap SIGUSR1 because the handler is registered after `init()` returns. The first-load AC still exists because tests, a re-entrant `init()`, and any future relocation of the handler can overlap it, and because "init has a second assignment" is the question the driver asked.
- **Non-blocking, inherited residual:** start-order vs. later-observed snapshot (D5). Same residual KPR-468 accepted. Not a new product decision.
- **⚠ Delegated, non-blocking:** one `log.debug` on discard, matching the notifier, so AC1/AC3 can count a superseded line rather than inferring solely from the stamp. Absence of the line is not a product defect; the stamp is the criterion.
- **⚠ Delegated, non-blocking:** the `CLAUDE.md` sentence (AC8). A collection of contracts documented only in this spec is invisible to the next reader; the KPR-452/KPR-454 precedent is that the bullet is updated in the same change.
- **No blocking product question.** The ticket's required fix, both reproductions, the KPR-468 pattern, and the "do not merge the caches" boundary are all decided. Intent is clear.

**KPR-501 disposition (for the driver, not this diff):** this spec *is* the disposition KPR-501 must consume. Publish through `OpsPublisher`'s accept path and this ordered `reloadSubscriptions`. Do not rebuild the machinery. The shared `(publishedAt, _id)` insert order KPR-468 already requires of a second producer remains a separate, already-canonical constraint.
