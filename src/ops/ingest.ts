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
    return {
      ok,
      stoppedEarly,
      cursorAt: cursor.publishedAt,
      eventsBehind,
      oldestUnappliedAt: first?.publishedAt ?? null,
    };
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
          // ⚠ deliveryReference IS unset here, and this is the ONE write that
          // unsets it. A reopen starts a new occurrence in `pending`, and
          // snooze expiry reads deliveryReference as "a transport accepted a
          // delivery IN THIS OCCURRENCE" (delivery.ts, expire). Retained
          // across this boundary, a reopen → rejected attempt → snooze →
          // expiry reported `delivered` for an occurrence nothing accepted.
          // The previous occurrence's reference is not lost to history: its
          // accepted attempt is still in attempts[] until the ring rolls.
          $unset: { expiresAt: "", stalledAt: "", stalledReason: "", deliveryReference: "" },
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
