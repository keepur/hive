import { randomUUID } from "node:crypto";
import type { Filter } from "mongodb";
import { createLogger } from "../logging/logger.js";
import {
  type Obligation,
  type Occurrence,
  type Attempt,
  obligationSchema,
  occurrenceSchema,
  cancelledAt,
  fail,
  ObligationError,
} from "./types.js";
import { scan, localDeadline } from "./deadlines.js";
import { ObligationStore, assertWrite, DURABLE_READ } from "./store.js";
import { ReceiptStore, reconcileReceipt, type Evidence } from "./receipts.js";
import { DeliveryService, claimable } from "./delivery.js";
import { escapeSlack, type ObligationPoster } from "./slack-post.js";

const log = createLogger("delivery-obligations");
const INTERVAL = 30_000;
export function laggingFilter(now: Date): Filter<Obligation> {
  return {
    scanThrough: { $lt: now },
    $or: [{ deactivatedAt: { $exists: false } }, { $expr: { $lt: ["$scanThrough", "$deactivatedAt"] } }],
  };
}
export function recoveryFilter(now?: Date): Filter<Occurrence> {
  return {
    $or: [
      // Inspect all delivery/notice intents; invocation tokens distinguish active
      // same-boot work from abandoned work. Counting active work is conservative.
      { "delivery.state": "sending" },
      { "notice.state": "sending" },
      { repairAt: now ? { $type: "date", $lte: now } : { $type: "date" } },
      {
        "acknowledgement.receiptWriteState": "pending",
        ...(now ? { $or: [{ repairAt: null }, { repairAt: { $lte: now } }] } : {}),
      },
    ],
  };
}
export function deliveryEvaluation(e: Evidence): Occurrence["evaluation"] {
  const o = e.occurrence;
  if (e.confirmed && o.acknowledgement) {
    const at = o.acknowledgement.acknowledgedAt;
    if (at <= o.windowStart) return "integrity_error";
    return at <= o.dueAt ? "on_time" : "late";
  }
  if (o.acknowledgement) return "evidence_incomplete";
  return "no_confirmed_delivery";
}
export function noticeText(o: Occurrence): string {
  const destination = o.definition.destination;
  return escapeSlack(
    "No confirmed delivery of " +
      o.definition.deliverable +
      " from " +
      o.producerAgentId +
      " by " +
      localDeadline(o.definition, o.dueAt) +
      " to " +
      destination.channelId +
      (destination.threadTs ? " thread " + destination.threadTs : "") +
      ". Obligation " +
      o.obligationId +
      "; deadline " +
      o.dueAt.toISOString() +
      ".",
  );
}
export class ObligationSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private flight: Promise<void> | undefined;
  private stopped = false;
  private scanCursor: string | undefined;
  private admissionCursor: string | undefined;
  private recoveryCursor: string | undefined;
  private evaluationCursor: string | undefined;
  private lastSuccessfulSweep: Date | null = null;
  constructor(
    readonly store: ObligationStore,
    readonly receipts: ReceiptStore,
    readonly delivery: DeliveryService,
    readonly poster: ObligationPoster,
    readonly bootId: string,
    readonly clock: () => Date,
    readonly canWrite: () => boolean,
  ) {}
  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    await this.sweepOnce();
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.sweepOnce();
    }, INTERVAL);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flight;
  }
  sweepOnce(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.stopped) return Promise.resolve();
    this.flight = this.run()
      .catch(() => {
        log.warn("Obligation sweep unavailable", { reason: "storage_unavailable" });
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }
  private async materialize(now: Date): Promise<boolean> {
    const rows = await this.store.definitionsPage(laggingFilter(now), this.scanCursor, 20);
    let ok = true;
    for (const d of rows) {
      try {
        const target = d.deactivatedAt && d.deactivatedAt < now ? d.deactivatedAt : now;
        const batch = scan(d.deadline, d.scanThrough, target, 1440);
        let cursor = d;
        for (const due of batch.due) {
          await this.store.materialize(d, due);
          await this.store.advance(cursor, due);
          cursor = (await this.store.get(d._id)) ?? fail("definition_missing");
        }
        await this.store.advance(cursor, batch.through);
      } catch {
        ok = false;
      }
      this.scanCursor = d._id;
    }
    if (rows.length < 20) this.scanCursor = undefined;
    return ok;
  }
  private async recover(now: Date): Promise<boolean> {
    let ok = true;
    const defs = await this.store.definitionsPage({ deliveryAdmission: { $exists: true } }, this.admissionCursor, 100);
    for (const d of defs) {
      try {
        await this.delivery.recoverAdmission(d._id, d.deliveryAdmission!);
      } catch {
        ok = false;
      }
      this.admissionCursor = d._id;
    }
    if (defs.length < 100) this.admissionCursor = undefined;
    const filter = recoveryFilter(now);
    const rows = await this.store.occurrencesPage(filter, this.recoveryCursor, 100);
    for (const before of rows) {
      try {
        const o = await this.store.occurrence(before._id);
        const patch: Partial<Occurrence> = {};
        if (this.delivery.interrupted(o)) {
          patch.delivery = { ...o.delivery, state: "unknown", reason: "interrupted_attempt" };
          patch.checkAt = now;
        }
        if (o.notice?.state === "sending" && !this.noticeIsActive(o.notice)) {
          patch.notice = { ...o.notice, state: "unknown", reason: "interrupted_attempt" };
          patch.checkAt = now;
        }
        if (Object.keys(patch).length) await this.store.cas(o, patch);
        const latest = await this.store.occurrence(o._id);
        // Terminal receipt states may still have an obsolete repairAt after
        // a lost CAS acknowledgement. The same queue clears it without repair.
        await reconcileReceipt(this.store, this.receipts, latest._id, this.clock, true);
      } catch {
        ok = false;
        try {
          const fresh = await this.store.occurrence(before._id);
          await this.store.cas(fresh, { repairAt: new Date(now.getTime() + INTERVAL) });
        } catch {
          /* preserve pending evidence; heartbeat becomes stale */
        }
      }
      this.recoveryCursor = before._id;
    }
    if (rows.length < 100) this.recoveryCursor = undefined;
    return ok;
  }
  private noticeIsActive(notice: Attempt): boolean {
    return (
      notice.ownerBootId === this.bootId &&
      notice.claimToken !== undefined &&
      this.store.activeNotices.has(notice.claimToken)
    );
  }
  async evaluate(id: string, now: Date): Promise<void> {
    let ownedNoticeToken: string | undefined;
    try {
      for (let n = 0; n < 8; n++) {
        let o = await this.store.occurrence(id);
        const definition = await this.store.definitionFor(o);
        if (cancelledAt(definition, o.dueAt)) {
          if (await this.store.cas(o, { cancelled: true, checkAt: null })) return;
          continue;
        }
        if (o.dueAt > now) return;
        // This may repair a pending receipt and returns its NEW revision.
        const e = await reconcileReceipt(this.store, this.receipts, id, this.clock, true);
        o = e.occurrence;
        const evaluation = deliveryEvaluation(e);
        if (evaluation === "on_time" || evaluation === "evidence_incomplete" || evaluation === "integrity_error") {
          if (
            await this.store.cas(o, {
              evaluation,
              evaluatedAt: now,
              checkAt:
                evaluation === "evidence_incomplete" && o.acknowledgement?.receiptWriteState === "pending"
                  ? new Date(now.getTime() + INTERVAL)
                  : null,
            })
          )
            return;
          continue;
        }
        if (o.notice?.state === "acknowledged" || o.notice?.state === "unknown") {
          if (await this.store.cas(o, { evaluation, evaluatedAt: now, checkAt: null })) return;
          continue;
        }
        if (o.notice && !claimable(o.notice, now)) {
          if (
            await this.store.cas(o, {
              evaluation,
              evaluatedAt: now,
              checkAt: o.notice.retryAt ?? new Date(now.getTime() + INTERVAL),
            })
          )
            return;
          continue;
        }
        // Re-read cutoff and exact receipt/checkpoint immediately before CAS.
        const cutoff = await this.store.definitionFor(o);
        if (cancelledAt(cutoff, o.dueAt)) continue;
        const finalEvidence = await reconcileReceipt(this.store, this.receipts, id, this.clock, true);
        if (finalEvidence.occurrence.revision !== o.revision || deliveryEvaluation(finalEvidence) !== evaluation)
          continue;
        const token = randomUUID();
        const notice: Attempt = {
          intentId: o.notice?.intentId ?? o._id + "/notice",
          state: "sending",
          claimToken: token,
          ownerBootId: this.bootId,
          startedAt: now,
        };
        if (!this.canWrite()) return fail("identity_unverified");
        // Register before the CAS can commit or pause; the token remains live
        // through posting, outcome publication and local exception cleanup.
        ownedNoticeToken = token;
        this.store.activeNotices.add(token);
        // Unknown claim result never proceeds to post. Recovery retains it.
        if (!(await this.store.cas(o, { notice, evaluation, evaluatedAt: now, checkAt: now }))) {
          this.store.activeNotices.delete(token);
          ownedNoticeToken = undefined;
          continue;
        }
        if (!this.canWrite()) return fail("identity_unverified");
        const outcome = await this.poster.post(o.definition.noticeDestination, noticeText(o));
        for (let publish = 0; publish < 8; publish++) {
          const current = await this.store.occurrence(id);
          if (!current.notice || current.notice.claimToken !== notice.claimToken) return;
          if (current.notice.state === "acknowledged") return;
          const terminal: Attempt = { ...current.notice, state: outcome.kind };
          if (outcome.kind === "acknowledged") {
            terminal.acknowledgedAt = outcome.acknowledgedAt;
            terminal.providerMessageTs = outcome.ts;
          } else {
            terminal.reason = outcome.reason;
            if (outcome.kind === "rejected") terminal.retryAt = outcome.retryAt;
          }
          // Preserve a concurrently published delivery/checkpoint revision.
          if (
            await this.store.cas(current, {
              notice: terminal,
              checkAt: outcome.kind === "rejected" ? outcome.retryAt : now,
            })
          )
            return;
        }
        return fail("state_contention");
      }
      return fail("state_contention");
    } catch (err) {
      if (ownedNoticeToken) {
        try {
          const latest = await this.store.occurrence(id);
          if (latest.notice?.claimToken === ownedNoticeToken && latest.notice.state === "sending") {
            await this.store.cas(latest, {
              notice: { ...latest.notice, state: "unknown", reason: "interrupted_attempt" },
              checkAt: now,
            });
          }
        } catch {
          /* retain the non-retryable durable intent */
        }
      }
      throw err;
    } finally {
      if (ownedNoticeToken) this.store.activeNotices.delete(ownedNoticeToken);
    }
  }
  private async evaluations(now: Date): Promise<boolean> {
    const rows = await this.store.occurrencesPage(
      { dueAt: { $lte: now }, checkAt: { $type: "date", $lte: now } },
      this.evaluationCursor,
      100,
    );
    let ok = true;
    for (const row of rows) {
      try {
        await this.evaluate(row._id, now);
      } catch (err) {
        ok = false;
        try {
          const fresh = await this.store.occurrence(row._id);
          const integrity = err instanceof ObligationError && err.code === "evidence_integrity";
          const patch: Partial<Occurrence> = {
            evaluation: integrity ? "integrity_error" : "pending",
            checkAt: new Date(now.getTime() + INTERVAL),
          };
          await this.store.cas(fresh, patch);
        } catch {
          /* retain original state on infrastructure failure */
        }
      }
      this.evaluationCursor = row._id;
    }
    if (rows.length < 100) this.evaluationCursor = undefined;
    return ok;
  }
  private async run(): Promise<void> {
    const now = this.clock();
    if (!this.canWrite()) return fail("identity_unverified");
    const recovered = await this.recover(now);
    const materialized = await this.materialize(now);
    const evaluated = await this.evaluations(now);
    const backlogObligations = await this.store.definitions.countDocuments(laggingFilter(now), DURABLE_READ);
    const pendingOccurrences = await this.store.occurrences.countDocuments(
      {
        dueAt: { $lte: now },
        checkAt: { $type: "date" },
      },
      DURABLE_READ,
    );
    const pendingAdmissions = await this.store.definitions.countDocuments(
      { deliveryAdmission: { $exists: true } },
      DURABLE_READ,
    );
    // No dueAt/cancellation/retry-time filter: throttled or future evidence
    // repair and retained admissions are unfinished work between pages too.
    const pendingRecoveryOccurrences = await this.store.occurrences.countDocuments(recoveryFilter(), DURABLE_READ);
    const backlogCount = backlogObligations + pendingOccurrences + pendingAdmissions + pendingRecoveryOccurrences;
    if (recovered && materialized && evaluated) this.lastSuccessfulSweep = now;
    assertWrite(
      await this.store.telemetry.updateOne(
        { kind: "delivery_obligations_stats" },
        {
          $set: {
            kind: "delivery_obligations_stats",
            timestamp: now,
            lastSuccessfulSweep: this.lastSuccessfulSweep,
            backlogObligations,
            pendingOccurrences,
            pendingAdmissions,
            pendingRecoveryOccurrences,
            backlogCount,
            state: recovered && materialized && evaluated ? (backlogCount === 0 ? "ok" : "backlog") : "degraded",
          },
        },
        { upsert: true, writeConcern: { w: "majority", wtimeoutMS: 5000 } },
      ),
    );
  }
}
export { obligationSchema, occurrenceSchema };
