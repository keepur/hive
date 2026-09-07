# KPR-456 plan chunk 3 — bounded checker and read-only discovery

Parent: [implementation plan](kpr-456-plan.md). Depends on chunks 1–2.

## Task 7: Fair, bounded independent sweep

**Create:** src/obligations/sweeper.ts
**Test:** src/obligations/obligations.integration.test.ts

- [ ] Add this complete implementation. A traversal cursor rotates each bounded lane so a persistently failing early record cannot starve later records. Only the registry scanThrough cursor declares deadline coverage; traversal cursors never imply evaluation success.

~~~typescript
import { randomUUID } from "node:crypto";
import type { Filter } from "mongodb";
import { createLogger } from "../logging/logger.js";
import {
  type Obligation, type Occurrence, type Attempt, obligationSchema, occurrenceSchema,
  cancelledAt, fail, ObligationError,
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
    $or: [
      { deactivatedAt: { $exists: false } },
      { $expr: { $lt: ["$scanThrough", "$deactivatedAt"] } },
    ],
  };
}
export function recoveryFilter(now?: Date): Filter<Occurrence> {
  return { $or: [
    // Inspect all delivery/notice intents; invocation tokens distinguish active
    // same-boot work from abandoned work. Counting active work is conservative.
    { "delivery.state": "sending" },
    { "notice.state": "sending" },
    { repairAt: now ? { $type: "date", $lte: now } : { $type: "date" } },
    { "acknowledgement.receiptWriteState": "pending",
      ...(now ? { $or: [{ repairAt: null }, { repairAt: { $lte: now } }] } : {}) },
  ] };
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
    "No confirmed delivery of " + o.definition.deliverable + " from " + o.producerAgentId
    + " by " + localDeadline(o.definition, o.dueAt)
    + " to " + destination.channelId + (destination.threadTs ? " thread " + destination.threadTs : "")
    + ". Obligation " + o.obligationId + "; deadline " + o.dueAt.toISOString() + ".",
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
    this.timer = setInterval(() => { void this.sweepOnce(); }, INTERVAL);
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
    this.flight = this.run().catch(() => {
      log.warn("Obligation sweep unavailable", { reason: "storage_unavailable" });
    }).finally(() => { this.flight = undefined; });
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
      } catch { ok = false; }
      this.scanCursor = d._id;
    }
    if (rows.length < 20) this.scanCursor = undefined;
    return ok;
  }
  private async recover(now: Date): Promise<boolean> {
    let ok = true;
    const defs = await this.store.definitionsPage(
      { deliveryAdmission: { $exists: true } }, this.admissionCursor, 100,
    );
    for (const d of defs) {
      try { await this.delivery.recoverAdmission(d._id, d.deliveryAdmission!); }
      catch { ok = false; }
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
        } catch { /* preserve pending evidence; heartbeat becomes stale */ }
      }
      this.recoveryCursor = before._id;
    }
    if (rows.length < 100) this.recoveryCursor = undefined;
    return ok;
  }
  private noticeIsActive(notice: Attempt): boolean {
    return notice.ownerBootId === this.bootId && notice.claimToken !== undefined
      && this.store.activeNotices.has(notice.claimToken);
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
        if (await this.store.cas(o, {
          evaluation, evaluatedAt: now,
          checkAt: evaluation === "evidence_incomplete"
            && o.acknowledgement?.receiptWriteState === "pending"
            ? new Date(now.getTime() + INTERVAL) : null,
        })) return;
        continue;
      }
      if (o.notice?.state === "acknowledged" || o.notice?.state === "unknown") {
        if (await this.store.cas(o, { evaluation, evaluatedAt: now, checkAt: null })) return;
        continue;
      }
      if (o.notice && !claimable(o.notice, now)) {
        if (await this.store.cas(o, {
          evaluation, evaluatedAt: now,
          checkAt: o.notice.retryAt ?? new Date(now.getTime() + INTERVAL),
        })) return;
        continue;
      }
      // Re-read cutoff and exact receipt/checkpoint immediately before CAS.
      const cutoff = await this.store.definitionFor(o);
      if (cancelledAt(cutoff, o.dueAt)) continue;
      const finalEvidence = await reconcileReceipt(this.store, this.receipts, id, this.clock, true);
      if (finalEvidence.occurrence.revision !== o.revision
        || deliveryEvaluation(finalEvidence) !== evaluation) continue;
      const token = randomUUID();
      const notice: Attempt = {
        intentId: o.notice?.intentId ?? o._id + "/notice",
        state: "sending", claimToken: token, ownerBootId: this.bootId, startedAt: now,
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
        if (await this.store.cas(current, {
          notice: terminal,
          checkAt: outcome.kind === "rejected" ? outcome.retryAt : now,
        })) return;
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
              notice: { ...latest.notice, state: "unknown", reason: "interrupted_attempt" }, checkAt: now,
            });
          }
        } catch { /* retain the non-retryable durable intent */ }
      }
      throw err;
    } finally {
      if (ownedNoticeToken) this.store.activeNotices.delete(ownedNoticeToken);
    }
  }
  private async evaluations(now: Date): Promise<boolean> {
    const rows = await this.store.occurrencesPage(
      { dueAt: { $lte: now }, checkAt: { $type: "date", $lte: now } },
      this.evaluationCursor, 100,
    );
    let ok = true;
    for (const row of rows) {
      try { await this.evaluate(row._id, now); }
      catch (err) {
        ok = false;
        try {
          const fresh = await this.store.occurrence(row._id);
          const integrity = err instanceof ObligationError && err.code === "evidence_integrity";
          const patch: Partial<Occurrence> = {
            evaluation: integrity ? "integrity_error" : "pending",
            checkAt: new Date(now.getTime() + INTERVAL),
          };
          await this.store.cas(fresh, patch);
        } catch { /* retain original state on infrastructure failure */ }
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
    const pendingOccurrences = await this.store.occurrences.countDocuments({
      dueAt: { $lte: now }, checkAt: { $type: "date" },
    }, DURABLE_READ);
    const pendingAdmissions = await this.store.definitions.countDocuments(
      { deliveryAdmission: { $exists: true } }, DURABLE_READ,
    );
    // No dueAt/cancellation/retry-time filter: throttled or future evidence
    // repair and retained admissions are unfinished work between pages too.
    const pendingRecoveryOccurrences = await this.store.occurrences.countDocuments(
      recoveryFilter(), DURABLE_READ,
    );
    const backlogCount = backlogObligations + pendingOccurrences
      + pendingAdmissions + pendingRecoveryOccurrences;
    if (recovered && materialized && evaluated) this.lastSuccessfulSweep = now;
    assertWrite(await this.store.telemetry.updateOne(
      { kind: "delivery_obligations_stats" },
      { $set: {
        kind: "delivery_obligations_stats", timestamp: now,
        lastSuccessfulSweep: this.lastSuccessfulSweep,
        backlogObligations, pendingOccurrences, pendingAdmissions, pendingRecoveryOccurrences,
        backlogCount,
        state: recovered && materialized && evaluated
          ? (backlogCount === 0 ? "ok" : "backlog") : "degraded",
      } }, { upsert: true, writeConcern: { w: "majority", wtimeoutMS: 5000 } },
    ));
  }
}
export { obligationSchema, occurrenceSchema };
~~~

A local exception fences its unknown publication by the exact notice claim token held by that evaluate invocation. Register the shared active notice token before claiming, including majority-committed claims whose acknowledgement throws. A definitely losing CAS removes only that token before retrying; finally removes it on every other exit. If both outcome publication and exception cleanup fail, the retained sending intent is recovered to unknown on a later same-boot sweep once its token is inactive, without another post. Recovery scans sending notices regardless of boot, deadline or cancellation; it preserves active same-boot tokens and token-fences any abandoned intent through the observed occurrence revision. Two live sweepers share a boot ID and the same guarded Db coordination, so ownerBootId alone must never be used to interrupt another sweeper's request. No timeout or age threshold makes a live notice token abandoned.

Heartbeat backlogCount counts unfinished work units across the materialization, due-evaluation, registry-admission and occurrence-recovery lanes. An occurrence can have both evaluation and recovery work, so the sum is not a distinct-occurrence count. Recovery counts include future/cancelled checkpoints and delayed repairAt work; bounded pages and technical retry delays cannot hide them. A successful bounded tick with remaining work reports state=backlog; failed lanes report degraded.

## Task 8: Bounded, read-only inspection and producer discovery

**Create:** src/obligations/reader.ts

- [ ] Add this implementation.

~~~typescript
import { z } from "zod";
import type { Filter } from "mongodb";
import {
  type Obligation, type Occurrence, type DiscoveryInput,
  discoveryInputSchema, cancelledAt, fail, occurrenceSchema, parseStored, occurrenceId,
} from "./types.js";
import { adjacent, currentDue, localDeadline } from "./deadlines.js";
import { ObligationStore, DURABLE_READ } from "./store.js";
import { ReceiptStore, reconcileReceipt } from "./receipts.js";
import { claimable, safeError } from "./delivery.js";

const cursorSchema = z.object({
  version: z.literal(1), section: z.enum(["definitions", "overdue", "history"]),
  owner: z.string().max(100), after: z.string().max(150),
}).strict();
export function cursor(section: "definitions" | "overdue" | "history", owner: string, after: string): string {
  return Buffer.from(JSON.stringify({ version: 1, section, owner, after })).toString("base64url");
}
export function decodeCursor(value: string | undefined, section: string, owner: string): string | undefined {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 500) return fail("invalid_cursor");
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
    if (parsed.section !== section || parsed.owner !== owner) return fail("invalid_cursor");
    return parsed.after;
  } catch { return fail("invalid_cursor"); }
}
export class ObligationReader {
  constructor(readonly store: ObligationStore, readonly receipts: ReceiptStore, readonly clock: () => Date) {}
  async heartbeat(): Promise<unknown> {
    const row = await this.store.telemetry.findOne({ kind: "delivery_obligations_stats" }, DURABLE_READ);
    if (!row) return { state: "unknown", reason: "no_heartbeat" };
    const now = this.clock().getTime();
    const last = row.lastSuccessfulSweep instanceof Date ? row.lastSuccessfulSweep.getTime() : null;
    return {
      state: !last || now - last > 120_000 ? "unknown" : row.state,
      timestamp: row.timestamp, lastSuccessfulSweep: row.lastSuccessfulSweep,
      stale: !last || now - last > 120_000,
      backlogCount: row.backlogCount, backlogObligations: row.backlogObligations,
      pendingOccurrences: row.pendingOccurrences,
      pendingAdmissions: row.pendingAdmissions,
      pendingRecoveryOccurrences: row.pendingRecoveryOccurrences,
    };
  }
  async occurrenceView(o: Occurrence): Promise<unknown> {
    try {
      const evidence = await reconcileReceipt(this.store, this.receipts, o._id, this.clock, false);
      o = evidence.occurrence;
      const d = await this.store.definitionFor(o);
      const effectiveCancelled = cancelledAt(d, o.dueAt);
      return {
        occurrenceId: o._id, obligationId: o.obligationId, dueAt: o.dueAt,
        windowStart: o.windowStart, localDeadline: localDeadline(d, o.dueAt),
        cancelled: effectiveCancelled, evaluation: o.evaluation,
        delivery: o.delivery, notice: o.notice ?? null,
        acknowledgement: o.acknowledgement ?? null, history: evidence.history,
        sendable: !effectiveCancelled && this.clock() > o.windowStart
          && claimable(o.delivery, this.clock()),
        notified: o.notice?.state === "acknowledged",
        correctedAfterNotice: o.evaluation === "on_time" && o.notice !== undefined
          && ["sending", "acknowledged", "unknown"].includes(o.notice.state),
      };
    } catch (err) {
      return { occurrenceId: o._id, dueAt: o.dueAt, state: "integrity_or_storage_error",
        reason: safeError(err), sendable: false };
    }
  }
  private async definitionView(d: Obligation): Promise<unknown> {
    // A retained admission requires its exact projection even when its dueAt
    // is old, future or cancelled. This validation performs only reads.
    await this.store.admittedOccurrence(d);
    const now = this.clock();
    const due = currentDue(d, now);
    const next = adjacent(d.deadline, now, 1);
    const nextEligible = d.deactivatedAt && next > d.deactivatedAt ? null : next;
    let current: unknown = null;
    if (due) {
      const id = occurrenceId(d._id, due);
      const found = await this.store.occurrences.findOne({ _id: id }, DURABLE_READ);
      if (!found && due <= d.scanThrough) return fail("evidence_integrity");
      current = found ? await this.occurrenceView(await this.store.occurrence(id))
        : { occurrenceId: id, obligationId: d._id, dueAt: due,
          sendable: d.deliveryAdmission === undefined, delivery: "pending", materialized: false };
    }
    const recent = await this.store.occurrences.find({ obligationId: d._id }, DURABLE_READ)
      .sort({ dueAt: -1 }).limit(5).toArray();
    return {
      definition: d, nextDeadline: nextEligible,
      nextLocalDeadline: nextEligible ? localDeadline(d, nextEligible) : null,
      current, recent: await Promise.all(recent.map((o) => this.occurrenceView(parseStored(occurrenceSchema, o)))),
      scanThrough: d.scanThrough,
      backlog: d.scanThrough < (d.deactivatedAt && d.deactivatedAt < now ? d.deactivatedAt : now),
    };
  }
  async definitions(agentId: string | undefined, raw: unknown): Promise<unknown> {
    const input = discoveryInputSchema.parse(raw);
    const owner = agentId ?? "*";
    const after = decodeCursor(input.cursor, "definitions", owner);
    const rows = await this.store.definitionsPage(agentId ? { producerAgentId: agentId } : {}, after, input.limit + 1);
    const page = rows.slice(0, input.limit);
    return {
      definitions: await Promise.all(page.map((d) => this.definitionView(d))),
      nextCursor: rows.length > input.limit ? cursor("definitions", owner, page.at(-1)!._id) : null,
      heartbeat: await this.heartbeat(),
      receiptRetentionMs: await this.receipts.retentionMs(),
      overdueQuery: { section: "overdue", limit: input.limit },
    };
  }
  async discover(agentId: string, raw: unknown): Promise<unknown> {
    const input: DiscoveryInput = discoveryInputSchema.parse(raw);
    if (input.section === "definitions") return this.definitions(agentId, input);
    const after = decodeCursor(input.cursor, "overdue", agentId);
    const filter: Filter<Occurrence> = {
      producerAgentId: agentId, dueAt: { $lte: this.clock() },
      $or: [
        { "delivery.state": { $ne: "acknowledged" } },
        { "acknowledgement.receiptWriteState": { $in: ["pending", "expired_unresolved"] } },
      ],
    };
    const rows = await this.store.occurrencesPage(filter, after, input.limit + 1);
    const page = rows.slice(0, input.limit);
    const backlog = await this.store.definitions.find({ producerAgentId: agentId }, DURABLE_READ)
      .sort({ scanThrough: 1 }).limit(1).toArray();
    return {
      occurrences: await Promise.all(page.map((o) => this.occurrenceView(o))),
      nextCursor: rows.length > input.limit ? cursor("overdue", agentId, page.at(-1)!._id) : null,
      earliestScanThrough: backlog[0]?.scanThrough ?? null,
      heartbeat: await this.heartbeat(),
      receiptRetentionMs: await this.receipts.retentionMs(),
      note: "Current keys and per-definition scan/backlog are in section definitions. Acknowledged history is in recent occurrences and the operator show command.",
    };
  }
  async show(id: string, input: { cursor?: string; limit: number }): Promise<unknown> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) return fail("invalid_limit");
    const d = (await this.store.get(id)) ?? fail("unknown_obligation");
    const after = decodeCursor(input.cursor, "history", id);
    const rows = await this.store.occurrencesPage({ obligationId: id }, after, input.limit + 1);
    const page = rows.slice(0, input.limit);
    return {
      ...(await this.definitionView(d) as object),
      occurrences: await Promise.all(page.map((o) => this.occurrenceView(o))),
      nextCursor: rows.length > input.limit ? cursor("history", id, page.at(-1)!._id) : null,
      heartbeat: await this.heartbeat(),
      receiptRetentionMs: await this.receipts.retentionMs(),
    };
  }
}
~~~

Inspection never calls register/materialize/init/repair/post. Definitions show current keys without creating occurrences. Overdue pagination includes deactivated obligations, sends nothing for sending/unknown states, and excludes acknowledged rows from the work queue while retaining them in recent/history views. Cancellation is derived from the registry cutoff, even for stale future snapshots.

Malformed persisted rows must be shown as an explicit integrity error by the CLI/tool wrapper, never omitted as successfully delivered. For a malformed definition page, fail the page with a bounded integrity error rather than skipping it.

- [ ] Run:

~~~bash
npx vitest run src/obligations/obligations.integration.test.ts src/obligations/reader.test.ts src/scheduler/scheduler.test.ts
npm run typecheck
git diff --check
~~~

Expected: zero lost deadlines after bounded catch-up, no notice duplicates, read-only spies record zero mutations/sends, expired history stays expired. Commit:

~~~bash
git add src/obligations/sweeper.ts src/obligations/reader.ts src/obligations/testing/fake-db.ts src/obligations/testing/harness.ts src/obligations/obligations.integration.test.ts src/obligations/reader.test.ts
git commit -m "feat: check delivery deadlines independently and expose overdue evidence"
~~~
