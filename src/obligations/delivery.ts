import { randomUUID } from "node:crypto";
import type { Admission, Attempt, Occurrence } from "./types.js";
import { deliveryInputSchema, fail, cancelledAt, same, occurrenceId, ObligationError } from "./types.js";
import { windowStart } from "./deadlines.js";
import { ObligationStore, DURABLE_READ } from "./store.js";
import { ReceiptStore, reconcileReceipt } from "./receipts.js";
import { attributedText, type ObligationPoster, type PostOutcome } from "./slack-post.js";

export function claimable(a: Attempt, now: Date): boolean {
  return a.state === "pending" || (a.state === "rejected" && (!a.retryAt || a.retryAt <= now));
}
export function safeError(err: unknown): string {
  return err instanceof ObligationError ? err.code : "storage_unavailable";
}
export class DeliveryService {
  constructor(
    readonly store: ObligationStore,
    readonly receipts: ReceiptStore,
    readonly poster: ObligationPoster,
    readonly bootId: string,
    readonly clock: () => Date,
    readonly canWrite: () => boolean,
  ) {}
  async historical(o: Occurrence): Promise<unknown> {
    if (!this.canWrite())
      return { state: "delivery_outcome_unknown", reason: "identity_unverified", retryAllowed: false };
    try {
      const evidence = await reconcileReceipt(this.store, this.receipts, o._id, this.clock, true);
      return {
        state: evidence.confirmed ? "confirmed_delivery" : "delivery_evidence_incomplete",
        dueAt: evidence.occurrence.dueAt,
        acknowledgement: evidence.occurrence.acknowledgement,
        history: evidence.history,
        cancelled: cancelledAt(await this.store.definitionFor(o), o.dueAt),
        retryAllowed: false,
      };
    } catch (err) {
      return { state: "delivery_outcome_unknown", reason: safeError(err), retryAllowed: false };
    }
  }
  async transfer(a: Admission, obligationId: string): Promise<boolean> {
    // Admission is authority even if deactivation has since committed.
    const d = await this.store.get(obligationId);
    if (!same(d?.deliveryAdmission, a)) return false;
    await this.store.admittedOccurrence(d!);
    for (let n = 0; n < 8; n++) {
      const o = await this.store.occurrence(a.occurrenceId);
      if (o.delivery.claimToken === a.claimToken) {
        return o.delivery.state === "sending";
      }
      if (!claimable(o.delivery, this.clock())) {
        await this.store.release(obligationId, a);
        return false;
      }
      const sending: Attempt = {
        intentId: a.intentId,
        claimToken: a.claimToken,
        ownerBootId: a.ownerBootId,
        state: "sending",
        startedAt: this.clock(),
      };
      try {
        if (await this.store.cas(o, { delivery: sending })) return true;
      } catch {
        const observed = await this.store.occurrence(o._id);
        return observed.delivery.claimToken === a.claimToken && observed.delivery.state === "sending";
      }
    }
    return false;
  }
  async settle(id: string, token: string, outcome: PostOutcome): Promise<Occurrence | null> {
    for (let n = 0; n < 8; n++) {
      const o = await this.store.occurrence(id);
      if (o.delivery.claimToken !== token) return null;
      if (o.delivery.state === "acknowledged") return o;
      if (!["sending", "unknown"].includes(o.delivery.state)) return null;
      const now = this.clock();
      const patch: Partial<Occurrence> = { checkAt: now };
      if (outcome.kind === "acknowledged") {
        patch.delivery = {
          ...o.delivery,
          state: "acknowledged",
          acknowledgedAt: outcome.acknowledgedAt,
          providerMessageTs: outcome.ts,
        };
        delete patch.delivery.reason;
        patch.acknowledgement = {
          receiptId: o._id + "/receipt",
          providerMessageTs: outcome.ts,
          acknowledgedAt: outcome.acknowledgedAt,
          timestamp: now,
          receiptWriteState: "pending",
        };
        patch.repairAt = now;
      } else {
        patch.delivery = { ...o.delivery, state: outcome.kind, reason: outcome.reason };
        if (outcome.kind === "rejected") patch.delivery.retryAt = outcome.retryAt;
      }
      try {
        if (await this.store.cas(o, patch)) return await this.store.occurrence(id);
      } catch {
        const observed = await this.store.occurrence(id);
        if (observed.delivery.claimToken === token && observed.delivery.state === outcome.kind) return observed;
        return null;
      }
    }
    return null;
  }
  async deliver(agentId: string, input: unknown): Promise<unknown> {
    const parsed = deliveryInputSchema.safeParse(input);
    if (!parsed.success) return { state: "invalid_input", retryAllowed: false };
    if (!this.canWrite())
      return { state: "delivery_outcome_unknown", reason: "identity_unverified", retryAllowed: false };
    const { obligationId, text } = parsed.data;
    const dueAt = new Date(parsed.data.dueAt);
    const d = (await this.store.get(obligationId)) ?? fail("unknown_obligation");
    if (d.producerAgentId !== agentId) return fail("wrong_producer");
    const now = this.clock();
    const lower = windowStart(d, dueAt);
    const body = attributedText(agentId, text);
    if (body.length > 3900) return fail("content_invalid");
    if (now <= lower) return fail("window_not_open");
    // All identity/input/recurrence/window checks precede materialization.
    // Historical acknowledged responses remain available after cancellation.
    const id = occurrenceId(obligationId, dueAt);
    const existing = await this.store.occurrences.findOne({ _id: id }, DURABLE_READ);
    if (existing) {
      const o = await this.store.occurrence(id);
      await this.store.definitionFor(o);
      if (o.delivery.state === "acknowledged") return this.historical(o);
    }
    if (cancelledAt(d, dueAt)) return fail("expectation_cancelled");
    if (!this.canWrite())
      return { state: "delivery_outcome_unknown", reason: "identity_unverified", retryAllowed: false };
    const o = await this.store.materialize(d, dueAt);
    if (o.delivery.state === "acknowledged") return this.historical(o);
    if (!claimable(o.delivery, now)) {
      return { state: o.delivery.state, retryAt: o.delivery.retryAt, retryAllowed: false };
    }
    // Register liveness before admission can be observed by a concurrent
    // sweep, including commit-then-throw. Only this invocation removes it.
    const token = randomUUID();
    this.store.activeDeliveries.add(token);
    try {
      const a = await this.store.admit(o, this.bootId, token);
      if (!a) {
        const latest = (await this.store.get(obligationId)) ?? fail("definition_missing");
        return {
          state: cancelledAt(latest, dueAt) ? "expectation_cancelled" : "admission_unavailable",
          retryAllowed: false,
        };
      }
      let transferred = false;
      try {
        transferred = await this.transfer(a, obligationId);
      } catch {
        return { state: "delivery_outcome_unknown", reason: "storage_unavailable", retryAllowed: false };
      }
      if (!transferred) return { state: "delivery_outcome_unknown", retryAllowed: false };
      // Release is cleanup, never a second authority check. A release failure
      // retains the slot for recovery and cannot cause a duplicate submission.
      try {
        await this.store.release(obligationId, a);
      } catch {
        /* durable handoff retained */
      }
      if (!this.canWrite())
        return { state: "delivery_outcome_unknown", reason: "identity_unverified", retryAllowed: false };
      const result = await this.poster.post(d.destination, body);
      try {
        const settled = await this.settle(id, a.claimToken, result);
        if (!settled) return { state: "delivery_outcome_unknown", retryAllowed: false };
        if (settled.delivery.state === "acknowledged") return this.historical(settled);
        return {
          state: settled.delivery.state,
          retryAt: settled.delivery.retryAt,
          retryAllowed:
            settled.delivery.state === "rejected" &&
            !cancelledAt((await this.store.get(obligationId)) ?? fail("definition_missing"), dueAt),
        };
      } catch {
        return { state: "delivery_outcome_unknown", reason: "storage_unavailable", retryAllowed: false };
      }
    } finally {
      this.store.activeDeliveries.delete(token);
    }
  }
  isActive(token: string | undefined, ownerBootId: string | undefined): boolean {
    return ownerBootId === this.bootId && token !== undefined && this.store.activeDeliveries.has(token);
  }
  interrupted(o: Occurrence): boolean {
    return o.delivery.state === "sending" && !this.isActive(o.delivery.claimToken, o.delivery.ownerBootId);
  }
  /** Reconcile a persisted handoff, never submit it to Slack. */
  async recoverAdmission(obligationId: string, a: Admission): Promise<void> {
    const d = await this.store.get(obligationId);
    if (!same(d?.deliveryAdmission, a)) return;
    const o = (await this.store.admittedOccurrence(d!))!;
    // A shared same-boot token denotes a still-executing invocation. It
    // cannot be reclaimed because it is slow, paused, or awaiting Mongo.
    if (this.isActive(a.claimToken, a.ownerBootId)) return;
    if (o.delivery.claimToken === a.claimToken) {
      if (o.delivery.state === "sending") {
        if (
          !(await this.store.cas(o, {
            delivery: { ...o.delivery, state: "unknown", reason: "interrupted_attempt" },
            checkAt: this.clock(),
          }))
        )
          return;
      }
      // Majority-observed transfer/outcome plus no active invocation permits
      // clearing this exact slot, including an abandoned same-boot handoff.
      await this.store.release(obligationId, a);
      return;
    }
    if (claimable(o.delivery, this.clock())) {
      const unknown: Attempt = {
        intentId: a.intentId,
        claimToken: a.claimToken,
        ownerBootId: a.ownerBootId,
        state: "unknown",
        reason: "interrupted_attempt",
      };
      if (!(await this.store.cas(o, { delivery: unknown, checkAt: this.clock() }))) return;
      // Only a durably observed matching transfer/outcome permits release.
      const observed = await this.store.occurrence(o._id);
      if (observed.delivery.claimToken !== a.claimToken) return;
    }
    // Different non-claimable token proves the admission lost.
    await this.store.release(obligationId, a);
  }
}
