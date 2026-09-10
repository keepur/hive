# KPR-468 plan — chunk 2b: `IngestPhase`

The second half of chunk 2, split at the **Task 3 | Task 4 seam** because the combined file ran past this plan's 1,000-line bound once round 2's harness-contract, stopped-latch and clearing-precondition material landed (the chunk-1 / 1b precedent; recorded in the plan index as the bound requires). **Read [chunk 2](kpr-468-plan-2-ledger-and-ingest.md) first** — this task consumes the `OpsNotificationStore`, `WRITE`, `isDuplicateKey` and the extended test double that file creates, and it is governed by the same four rules stated in its header:

1. **Idempotence is apply-if-strictly-newer over `(publishedAt, _id)`, not `latestEventId` equality.**
2. **Clearing is applied to every row on the cleared `dedupeKey`, across all subscriptions, independent of `e.matchedSubscriptionIds`.**
3. **Ingest's unit of containment is the EVENT, not the row.**
4. **`$set` and `$unset` never name the same path in one update.**

One task, one commit.

---

### Task 4: `IngestPhase`

**Files:**

- Create: `src/ops/ingest.ts`
- Create: `src/ops/ingest.integration.test.ts`

`IngestPhase` is constructed with `(events, store, counters, subscriptionsRef, retentionDays, stopped)` and **nothing else** — deliberately, so it does not depend on `OpsNotifier`, which chunk 3 creates. Task 4 must be verifiable before Task 5 exists, and the last parameter is a plain `() => boolean` for exactly that reason: D5's "the tick checks its stopped latch **between rows and phases**" and D10's "the drain is bounded by one adapter deadline" are both false of an ingest phase with no checkpoint — with `INGEST_EVENT_BUDGET = 1000` and up to three CAS'd writes per (event, subscription), a `stop()` arriving at the top of ingest would be bounded by a full ingest budget instead.

Its two test files are also the two in this plan that do **not** import the shared harness module (chunk 3b Step 4's "Harness contract"): that module constructs an `OpsNotifier`, which does not exist until Task 5, and Task 4's independence from Task 5 is the whole reason this constructor takes what it takes. `notification-store.test.ts` and `ingest.integration.test.ts` build a `FakeDb` and construct `OpsNotificationStore` / `IngestPhase` directly.

- [ ] **Step 1:** Create `src/ops/ingest.ts`.

```typescript
/**
 * KPR-468 D3/D4/D8(b): the event-driven phase — the cursor, clearing
 * application, row creation and D7-rule-4 renewal.
 *
 * THIS MODULE NEVER IMPORTS src/ops/match.ts AND NEVER RE-EVALUATES A MATCH
 * (D12, C2, AC2). Re-evaluation would let a subscription registered after
 * accept acquire a past event, contradicting D5, and would make the stored
 * count a lie.
 */
import { ObjectId, type Collection, type Filter } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { OpsEvent, OpsSubscription } from "./types.js";
import {
  GAUGE_COUNT_LIMIT,
  INGEST_EVENT_BUDGET,
  INGEST_PAGE_SIZE,
  OPS_SYSTEM_PRINCIPAL,
  expiresAtFor,
  type OpsNotification,
  type OpsNotifierCounters,
} from "./notification-types.js";
import { isDuplicateKey, WRITE, type OpsNotificationStore, type SweepCursor } from "./notification-store.js";

const log = createLogger("ops-ingest");

export interface IngestResult {
  ok: boolean;
  /**
   * D5/D10: the phase left work in hand because stop() was requested.
   *
   * ⚠ NOTHING IN PRODUCTION READS THIS. `OpsNotifier.runPhases` re-reads its
   * own `this.stopping` at both between-phase seams rather than branching on
   * this field, and in production the two are the same latch, so the field is
   * bookkeeping — the phase's honest self-report, asserted by chunk 2b's own
   * stopped-checkpoint case and by nobody else. Read the "reconciled claim
   * sites" as three *statements of the same fact*, not three consumers. Making
   * `runPhases` branch on it instead would be defensible (the phase is the
   * thing that knows it stopped short) and is deliberately not done: the seam
   * after `expire()` has no equivalent field to branch on, and one seam reading
   * a returned flag while its neighbour reads the latch is worse than both
   * reading the latch.
   */
  stoppedEarly: boolean;
  cursorAt: Date;
  /** Saturating at GAUGE_COUNT_LIMIT; read as "at least N". */
  eventsBehind: number;
  /** ALWAYS reported on a non-drained stop, never silently omitted (D5). */
  oldestUnappliedAt: Date | null;
}

/**
 * D3: the position filter over ops_events's (publishedAt, _id) total order.
 * The `_id` half is the ONE place this child compares ObjectIds directly —
 * every reference the ledger STORES is a hex string instead.
 */
export function strictlyAfter(cursor: SweepCursor): Filter<OpsEvent> {
  if (cursor.eventId === null) return { publishedAt: { $gt: cursor.publishedAt } };
  const id = new ObjectId(cursor.eventId);
  return {
    $or: [{ publishedAt: { $gt: cursor.publishedAt } }, { publishedAt: cursor.publishedAt, _id: { $gt: id } }],
  };
}

/**
 * D3: apply-if-strictly-newer, the precondition on EVERY ledger application.
 * A strengthening of D12's `latestEventId`-equality phrasing, not a departure
 * from it: equality guards an exact replay of the LAST event only, so a page
 * in which one dedupeKey is touched twice replays the OLDER touch, passes the
 * equality test, and double-counts eventCount — a direct C17 failure.
 */
export function newerThan(e: OpsEvent): Filter<OpsNotification> {
  const id = String(e._id);
  return {
    $or: [
      { appliedThroughAt: { $lt: e.publishedAt } },
      { appliedThroughAt: e.publishedAt, appliedThroughId: { $lt: id } },
    ],
  } as Filter<OpsNotification>;
}

/**
 * D4/D8: the provenance test, decided by the CLEARED row's snapshotted class
 * and restricted to what the envelope makes checkable — this component judges
 * nothing.
 *
 * The same-producer clause is NOT defence-in-depth; it closes a case
 * publish-time validation genuinely misses. D4 requires clearsReasonIds to
 * name reasons of the same producer and C19 enforces that at publish — but
 * the enforcement is over the REASONID COMPONENT ONLY (KPR-454's accept path
 * tests reasonIdOfDedupeKey(input.clears) for membership). dedupeKey is
 * producer:subjectKind:subjectId:reasonId:generation, so the PRODUCER
 * component of a `clears` key is never constrained, and a clears naming
 * another producer's key whose reasonId happens to collide passes publish
 * intact. This clause is the only check that catches it.
 */
export function clearingProvenanceOk(row: OpsNotification, e: OpsEvent): boolean {
  if (e.producer !== row.producer) return false;
  switch (row.class) {
    case "resource":
      return true;
    case "judgment":
    case "integrity":
      return e.evidence.length >= 1;
    case "informational":
    default:
      return false;
  }
}

export class IngestPhase {
  constructor(
    private readonly events: Collection<OpsEvent>,
    private readonly store: OpsNotificationStore,
    private readonly counters: OpsNotifierCounters,
    private readonly subscriptions: () => Map<string, OpsSubscription>,
    private readonly retentionDays: number,
    /**
     * D5/D10: the stopped latch, checked BETWEEN EVENTS. Without it the drain
     * is bounded by a whole INGEST_EVENT_BUDGET of events rather than by "one
     * adapter deadline", and index.ts's shutdown comment, chunk 5's drain
     * comment and D10 would all assert a property this phase does not have.
     * A plain callback rather than the notifier itself, so Task 4 stays
     * independent of Task 5.
     */
    private readonly stopped: () => boolean = () => false,
  ) {}

  async run(now: Date): Promise<IngestResult> {
    let cursor = await this.store.readCursor();
    if (!cursor) {
      // D3's cold-start rule, deliberate in BOTH directions. Forward: KPR-454
      // ships ahead of this child and accumulates, and a notifier that woke up
      // and delivered weeks of backlog would be exactly the flood this epic
      // exists to remove — worse, it would re-mint rows for conditions whose
      // ledger rows had already aged out, resurrecting long-dead
      // acknowledgements. Backward: events published while no cursor existed
      // are never notified, bounded by one sweep interval.
      cursor = { publishedAt: now, eventId: null };
      await this.store.writeCursor(cursor);
      this.counters.cursorReinitialized += 1;
      log.warn("ops sweep cursor absent — initializing to the server clock; no backfill", {
        at: now.toISOString(),
      });
      return { ok: true, stoppedEarly: false, cursorAt: cursor.publishedAt, eventsBehind: 0, oldestUnappliedAt: null };
    }

    let applied = 0;
    let ok = true;
    let drained = false;
    let stoppedEarly = false;
    let advanced: SweepCursor | undefined;

    pages: while (true) {
      // D5/D10 checkpoint #1 — between pages, so a stop costs at most the page
      // in hand rather than a full INGEST_EVENT_BUDGET.
      if (this.stopped()) {
        stoppedEarly = true;
        break;
      }
      const page = await this.events
        .find(strictlyAfter(cursor))
        .sort({ publishedAt: 1, _id: 1 })
        .limit(INGEST_PAGE_SIZE)
        .toArray();
      if (page.length === 0) {
        drained = true;
        break;
      }
      for (const e of page) {
        // D5/D10 checkpoint #2 — BETWEEN EVENTS, which is what actually bounds
        // the drain: one event's application (a clearing fan-out plus up to
        // three CAS'd writes per stamped subscription) is the unit a stop
        // waits for, and it is not interruptible mid-event without breaking
        // D8(b)'s event-level containment. Leaving the cursor here is safe for
        // exactly the reason a fault leaves it here — every application is a
        // CAS'd apply-if-newer write, so the next tick's replay is a no-op.
        if (this.stopped()) {
          stoppedEarly = true;
          break pages;
        }
        try {
          await this.applyEvent(e, now);
        } catch (err) {
          // D8(b): the unit of containment is the EVENT, not the row. A fault
          // anywhere in applying `e` — its clearing fan-out, or any one of its
          // per-subscription renewals — means `e` is not fully applied, so the
          // phase STOPS AT `e` and the cursor advances no further than its
          // predecessor. PER-ROW CONTINUE IS FORBIDDEN HERE: applying 6…N and
          // advancing the cursor to N would leave `e` permanently unnotified,
          // uncounted, and invisible to eventsBehind — not BEHIND the cursor
          // but UNDER it. Re-reading the page is safe and cheap because every
          // application is a CAS'd apply-if-newer write, so the rows that did
          // apply are total no-ops on the retry.
          this.counters.ingestFaults += 1;
          log.error("ops ingest fault — stopping this tick at the faulting event", {
            eventId: String(e._id),
            error: String(err),
          });
          ok = false;
          break pages;
        }
        advanced = { publishedAt: e.publishedAt, eventId: String(e._id) };
        cursor = advanced;
        applied += 1;
        this.counters.eventsApplied += 1;
      }
      if (page.length < INGEST_PAGE_SIZE) {
        drained = true;
        break;
      }
      // The budget is checked BETWEEN pages, deliberately: it removes D5's
      // two-branch oldestUnappliedAt entirely in favour of one always-paid
      // bounded findOne below.
      if (applied >= INGEST_EVENT_BUDGET) break;
    }

    // D3: the cursor is written ONLY after the page's ledger writes are
    // acknowledged (each was awaited above), with majority write concern. It
    // is written once at the end of the tick rather than per page, which is
    // strictly safer — a crash re-processes more, never less.
    if (advanced) await this.store.writeCursor(advanced);

    if (drained && ok)
      return { ok, stoppedEarly, cursorAt: cursor.publishedAt, eventsBehind: 0, oldestUnappliedAt: null };

    // D5: ALWAYS reported, never silently omitted — on the stopped-early stop
    // too, which is two bounded indexed reads paid during a drain and buys the
    // invariant "no caller has to know which stop produced this result". One
    // extra bounded indexed read on the same {publishedAt, _id} index the page
    // sort uses.
    //
    // ⚠ D8(b) PERMITS a mid-page fault to leave the cursor where the tick
    // found it, so in principle this read can return an already-applied event
    // and the reported age is an UPPER BOUND rather than exact. THIS
    // IMPLEMENTATION CURRENTLY BEATS THAT BOUND: `advanced` always names the
    // last FULLY-applied event and `cursor` is only ever assigned from it, so
    // `strictlyAfter(cursor)` is exact on both the fault and the budget stop.
    // The comment stays because the LOOSER property is the contract — an
    // implementation that (legitimately, under D8(b)) stopped writing `cursor`
    // per event would still be correct — and because the slack is
    // one-directional: an over-report errs toward alarm, which is the safe
    // direction for the one gap this figure exists to expose.
    const first = await this.events.findOne(strictlyAfter(cursor), { sort: { publishedAt: 1, _id: 1 } });
    const eventsBehind = await this.events.countDocuments(strictlyAfter(cursor), { limit: GAUGE_COUNT_LIMIT });
    return { ok, stoppedEarly, cursorAt: cursor.publishedAt, eventsBehind, oldestUnappliedAt: first?.publishedAt ?? null };
  }

  /** D4: two INDEPENDENT applications, in this order. */
  private async applyEvent(e: OpsEvent, now: Date): Promise<void> {
    if (e.clears) await this.applyClearing(e, now);
    await this.applyRenewal(e, now);
  }

  /**
   * D4(a). Every row whose dedupeKey equals e.clears — ACROSS ALL
   * SUBSCRIPTIONS, INDEPENDENT OF e.matchedSubscriptionIds. This scope is not
   * an optimization and reversing it breaks the contract: a clearing reason is
   * `informational` and normally matches ZERO subscriptions, so a match-scoped
   * clearing would clear nothing, every `resource` condition would nudge
   * forever, and D12's assertion that recovering resource conditions fall
   * silent on their own would be false.
   *
   * Per-row CAS'd updateOne, NEVER an updateMany — the watermark is a PER-ROW
   * precondition and two rows on one dedupeKey can sit at different positions.
   * AC8 asserts no code path issues an updateMany against ops_notifications.
   */
  private async applyClearing(e: OpsEvent, now: Date): Promise<void> {
    const rows = await this.store.notifications.find({ dedupeKey: e.clears! }).toArray();
    if (rows.length === 0) {
      // Nobody was listening. D8 answers openness from the LOG, not the ledger.
      this.counters.clearNoRow += 1;
      return;
    }
    for (const row of rows) {
      if (!clearingProvenanceOk(row, e)) {
        // Already stored by the publisher — it is a fact that someone tried —
        // and it does not transition the row.
        this.counters.clearRefused += 1;
        continue;
      }
      // D4: stateAt on every SYSTEM transition is the TICK's now, never the
      // event's publishedAt. expiresAt derives from stateAt, so a backlogged
      // sweep applying an hours-old clearing event would otherwise set a
      // retention horizon measured from that older instant and could TTL the
      // row before any reader saw it close. The event's own instant is not
      // lost: it is on lastEventAt and stateEventId already.
      const res = await this.store.notifications.updateOne(
        // ⚠ PLAN-WRITER'S DEVIATION, recorded as one in the plan index's
        // "Assumptions carried into implementation" — do not silently
        // "simplify" it back. D4 says the cleared-row no-op happens "by the D3
        // watermark", and the watermark ALONE would let a genuinely NEWER
        // clearing fact re-apply to an already-cleared row: state stays
        // `cleared`, but stateAt, stateEventId, appliedThrough* and — the one
        // that matters — expiresAt all advance, so a flapping producer
        // republishing a recovery every few minutes extends a closed row's
        // retention horizon indefinitely and the row never ages out.
        // `state: { $ne: "cleared" }` makes that a matchedCount-0 no-op
        // instead. Two consequences, both accepted and both tested: the second
        // clearing publication increments NEITHER rowsCleared NOR clearRefused
        // (it is not a provenance failure — a cleared row passes provenance —
        // it simply matched nothing), and stateEventId keeps naming the FIRST
        // clearing event forever, which is the honest answer to "what closed
        // this row".
        { _id: row._id, state: { $ne: "cleared" }, ...newerThan(e) },
        {
          $set: {
            state: "cleared",
            stateAt: now,
            principal: OPS_SYSTEM_PRINCIPAL,
            principalAt: now,
            stateEventId: String(e._id),
            expiresAt: expiresAtFor("cleared", now, this.retentionDays)!,
            appliedThroughAt: e.publishedAt,
            appliedThroughId: String(e._id),
          },
          // D4: forceDeliver, stalledAt/stalledReason and snoozedUntil are
          // deliberately LEFT ALONE and there is no fourth write arm for them.
          // All three are PROVABLY inert on a cleared row: nextNudgeAt is
          // unset so no delivery arm's index range contains it; every stall
          // gauge's index carries state ∈ {pending, delivered}; and the expiry
          // scan keys on state: "snoozed". A reopen re-sets forceDeliver and
          // unsets the stall markers explicitly. ⚠ It does NOT touch
          // snoozedUntil — so `snoozed → cleared → reopened` carries a stale
          // snoozedUntil into `pending`, and that residue is inert for the same
          // reason as above (the expiry scan keys on state: "snoozed", and
          // buildView's ledger block omits the field) but it IS inherited
          // across the boundary. Named rather than fixed: unsetting it in the
          // reopen arm would be a fourth thing that write does for a field no
          // reader consults.
          $unset: { nextNudgeAt: "" },
        },
        WRITE,
      );
      if (res.matchedCount === 1) this.counters.rowsCleared += 1;
    }
  }

  /**
   * D4(b). Row creation and D7-rule-4 renewal for e's OWN dedupeKey, across
   * e.matchedSubscriptionIds — the stamped list, never a re-evaluation.
   *
   * The write is TWO STEPS rather than an aggregation-pipeline update, and the
   * conditional update carries NO `upsert`: the (subscriptionId, dedupeKey)
   * unique index must remain the race detector, and the repo's double supports
   * neither pipeline updates nor an upsert whose filter carries operators.
   */
  private async applyRenewal(e: OpsEvent, now: Date): Promise<void> {
    const advance = {
      latestEventId: String(e._id),
      lastEventAt: e.publishedAt,
      latestDetail: e.detail,
      latestEvidence: e.evidence,
      appliedThroughAt: e.publishedAt,
      appliedThroughId: String(e._id),
    };
    for (const subscriptionId of e.matchedSubscriptionIds) {
      const sub = this.subscriptions().get(subscriptionId);
      // D4/D12: a stamped subscription that is absent, disabled, or whose
      // target its registered adapter rejected yields NO ROW — and the event's
      // stored matchedSubscriptions count STILL STANDS. It was honest for the
      // set that existed at accept and was never a delivery promise.
      if (!sub) continue;

      // Arm A — reopen a `cleared` row (D7 rule 4). forceDeliver is what makes
      // "the design errs toward a duplicate rather than a gap" TRUE under the
      // shipped default: attemptCount is monotonic and a reopen does not reset
      // it, so without the flag a condition that demonstrably came back would
      // fail an `attemptCount === 0 ∨ cadence` gate and never be delivered.
      const reopened = await this.store.notifications.updateOne(
        { subscriptionId, dedupeKey: e.dedupeKey, state: "cleared", ...newerThan(e) },
        {
          $set: {
            ...advance,
            state: "pending",
            stateAt: now,
            stateEventId: String(e._id),
            principal: OPS_SYSTEM_PRINCIPAL,
            principalAt: now,
            nextNudgeAt: now,
            forceDeliver: true,
          },
          $inc: { eventCount: 1 },
          $unset: { expiresAt: "", stalledAt: "", stalledReason: "" },
        },
        WRITE,
      );
      if (reopened.matchedCount === 1) {
        this.counters.rowsRenewed += 1;
        continue;
      }

      // Arm B — advance any non-cleared row. nextNudgeAt is deliberately NOT
      // reset: a repeat must not restart the cadence clock, or a flapping
      // producer nudges on its own schedule instead of the operator's.
      const renewed = await this.store.notifications.updateOne(
        { subscriptionId, dedupeKey: e.dedupeKey, state: { $ne: "cleared" }, ...newerThan(e) },
        { $set: advance, $inc: { eventCount: 1 } },
        WRITE,
      );
      if (renewed.matchedCount === 1) {
        this.counters.rowsRenewed += 1;
        continue;
      }

      // Arm C — insert. Arms A and B both missing means EITHER the row does
      // not exist OR it exists and the event is not newer; a duplicate-key
      // error resolves that ambiguity in favour of the second and is a NO-OP,
      // not a fault (D4 step 2).
      try {
        await this.store.notifications.insertOne(this.freshRow(e, sub, now), WRITE);
        this.counters.rowsCreated += 1;
      } catch (err) {
        if (isDuplicateKey(err)) {
          this.counters.renewalStale += 1;
          continue;
        }
        throw err;
      }
    }
  }

  private freshRow(e: OpsEvent, sub: OpsSubscription, now: Date): OpsNotification {
    return {
      subscriptionId: sub._id,
      subscriberId: sub.subscriberId,
      dedupeKey: e.dedupeKey,
      producer: e.producer,
      reasonId: e.reasonId,
      class: e.class,
      waiting: e.waiting,
      retry: e.retry,
      subject: e.subject,
      generation: e.generation,
      firstEventId: String(e._id),
      latestEventId: String(e._id),
      eventCount: 1,
      firstSeenAt: e.publishedAt,
      lastEventAt: e.publishedAt,
      state: "pending",
      stateAt: now,
      principal: OPS_SYSTEM_PRINCIPAL,
      principalAt: now,
      attempts: [],
      attemptCount: 0,
      nudgeCount: 0,
      // D5: first delivery IS the first nudge, so a fresh row is due now and
      // there is exactly one delivery code path.
      nextNudgeAt: now,
      appliedThroughAt: e.publishedAt,
      appliedThroughId: String(e._id),
      latestDetail: e.detail,
      latestEvidence: e.evidence,
    };
  }
}
```

⚠ **Two facts about this file that a reviewer will question and that are deliberate.**

- **The clearing fan-out is unbounded in principle.** `find({ dedupeKey })` returns one row per subscription holding that key, so it is bounded by the operator's subscriber count — not by traffic — and the spec accepts that shape. It is the one read in this chunk with no `limit`, and adding one would silently leave rows uncleared, which is strictly worse than a read sized by a number the operator chose.
- **`clearingProvenanceOk`'s `informational` arm returns `false` after the same-producer check has already run.** The two are not redundant: chunk 6's mutation **NV3** deletes the producer clause and the `resource` arm must then be the one that goes green-to-red, which requires the producer check to be a separate, earlier conjunct rather than folded into each class arm.

- [ ] **Step 2:** Create `src/ops/ingest.integration.test.ts`.

Cover, at minimum, each of the following as a named case. Chunk 6 re-drives the subset that maps to an acceptance criterion; these are the module's own.

- `strictlyAfter` with a null-`eventId` cursor returns only events published strictly after it, and with a real `eventId` breaks a `publishedAt` tie on `_id`.
- A fresh event with one stamped subscription creates one `pending` row with `nextNudgeAt = now`, `attemptCount: 0`, `eventCount: 1`, `appliedThrough*` at the event's position, and `principal = OPS_SYSTEM_PRINCIPAL`.
- A stamped id absent from the loaded map creates **no** row and leaves the event document byte-identical.
- Renewal on `pending` advances `latestEventId` / `lastEventAt` / `eventCount` / `latestDetail` / `latestEvidence` and **does not** reset `nextNudgeAt`.
- Renewal on `seen` and on `dismissed` advances and sends nothing new (state unchanged, `nextNudgeAt` still unset).
- Renewal on `snoozed` advances and leaves `snoozedUntil` untouched.
- Renewal on `cleared` reopens to `pending` with `forceDeliver: true`, `nextNudgeAt = now`, `stateEventId` = the renewing event, and `expiresAt` / `stalledAt` / `stalledReason` all unset.
- The watermark: applying the same event twice leaves `eventCount` at 1; applying an **older** event after a newer one changes nothing.
- Clearing with zero `matchedSubscriptionIds` clears rows on the named key across two different subscriptions.
- The four provenance rows (`resource` clears same-producer; `judgment`/`integrity` need `evidence.length >= 1`; `informational` never clears), plus `dismissed` clears and `cleared` is a no-op, plus the cross-producer refusal.
- **A *newer* clearing fact on an already-`cleared` row** — the deviation above — leaves `state`, `stateAt`, `stateEventId`, `expiresAt` and `appliedThrough*` byte-identical and increments **neither** `rowsCleared` nor `clearRefused`. (Seed the row cleared by `e1`, then apply a strictly newer `e2` naming the same key with identical provenance. Against the watermark-only form every one of those five fields moves and `rowsCleared` reaches 2, which is what makes this case able to fail.)
- A clearing event naming a `dedupeKey` with no row increments `clearNoRow` and nothing else.
- The cursor advances to the last fully-applied event and is written **once**, with majority write concern.
- An absent cursor initializes to `now`, counts `cursorReinitialized`, and creates **zero** rows over a log seeded with 50 pre-existing events.
- Event-level containment: a fault on the third of five leaves the cursor at the second, events 3–5 unapplied, `ingestFaults` at 1, `ok: false`; the next tick applies 3, 4 and 5.
- `eventsBehind` saturates at `GAUGE_COUNT_LIMIT` and `oldestUnappliedAt` is non-null on every non-drained stop.
- **The stopped checkpoint:** with a `stopped` callback that returns `true` from the third event onward, a five-event page applies exactly two events, returns `stoppedEarly: true` with `ok: true` (a stop is not a fault, so `ingestFaults` stays 0), writes the cursor at the second event, and a following run with `stopped` back to `false` applies 3, 4 and 5. Drive the same with `stopped` true from the outset and assert **zero** `ops_events` `find` operations in the double's `operations` log — the between-pages checkpoint, which is what keeps a drain from paying even one **page** read. ⚠ It does not keep the phase from touching the collection at all, and the assertion must not be read that way: with no page applied the run is neither drained nor faulted, so it still falls through to the always-paid `findOne` + `countDocuments` (the `oldestUnappliedAt`/`eventsBehind` pair, whose "always reported" invariant is deliberate). The double logs `find`, `findOne` and `countDocuments` as **distinct** operation names (`src/obligations/testing/fake-db.ts:81-82` records `operation` verbatim), which is the only reason the narrow assertion is both true and writable.

- [ ] **Step 3:** Verify and commit.

```bash
npx vitest run src/ops/ingest.integration.test.ts src/ops/notification-store.test.ts
npx tsc --noEmit
```

Expected: all cases pass, `tsc` exits 0.

**Also assert the structural prohibition by hand, before chunk 6 automates it:**

```bash
grep -rn "match.js\|match\.ts" src/ops/ingest.ts src/ops/notification-store.ts || echo "OK — no match evaluator import"
```

```bash
git add src/ops/ingest.ts src/ops/ingest.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(KPR-468): ingest — clearing fan-out, renewal, the apply-if-newer watermark

D3/D4/D8(b): the cursor loop over ops_events's (publishedAt, _id) order,
clearing applied to every row on the cleared dedupeKey INDEPENDENT of the
clearing event's own matches, the per-class provenance test including the
same-producer clause that closes C19's reasonId-only publish check, and
D7-rule-4 renewal as a conditional-update-then-insert whose duplicate-key
error is the race detector.

Every application is CAS'd apply-if-strictly-newer over (publishedAt,
_id), which is what makes ANY prefix replay a total no-op and what keeps
eventCount counting distinct events rather than sweep attempts (C17).
Ingest's unit of containment is the EVENT: a fault stops the phase at it
and the cursor advances no further than its predecessor. Per-row continue
is forbidden here and is the delivery phase's rule instead. The same unit
bounds the drain — the stopped latch is checked between pages and between
events, so a stop costs one event's application rather than a full
INGEST_EVENT_BUDGET.

The clearing arm additionally preconditions on state != cleared, a
plan-writer's deviation from D4's watermark-only phrasing recorded in the
plan index: without it a flapping recovery would keep advancing a closed
row's expiresAt and the row would never age out.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```
