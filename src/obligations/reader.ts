import { z } from "zod";
import type { Filter } from "mongodb";
import {
  type Obligation,
  type Occurrence,
  type DiscoveryInput,
  discoveryInputSchema,
  cancelledAt,
  fail,
  occurrenceSchema,
  parseStored,
  occurrenceId,
} from "./types.js";
import { adjacent, currentDue, localDeadline } from "./deadlines.js";
import { ObligationStore, DURABLE_READ } from "./store.js";
import { ReceiptStore, reconcileReceipt } from "./receipts.js";
import { claimable, safeError } from "./delivery.js";

const cursorSchema = z
  .object({
    version: z.literal(1),
    section: z.enum(["definitions", "overdue", "history"]),
    owner: z.string().max(100),
    after: z.string().max(150),
  })
  .strict();
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
  } catch {
    return fail("invalid_cursor");
  }
}
export class ObligationReader {
  constructor(
    readonly store: ObligationStore,
    readonly receipts: ReceiptStore,
    readonly clock: () => Date,
  ) {}
  async heartbeat(): Promise<unknown> {
    const row = await this.store.telemetry.findOne({ kind: "delivery_obligations_stats" }, DURABLE_READ);
    if (!row) return { state: "unknown", reason: "no_heartbeat" };
    const now = this.clock().getTime();
    const last = row.lastSuccessfulSweep instanceof Date ? row.lastSuccessfulSweep.getTime() : null;
    return {
      state: !last || now - last > 120_000 ? "unknown" : row.state,
      timestamp: row.timestamp,
      lastSuccessfulSweep: row.lastSuccessfulSweep,
      stale: !last || now - last > 120_000,
      backlogCount: row.backlogCount,
      backlogObligations: row.backlogObligations,
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
        occurrenceId: o._id,
        obligationId: o.obligationId,
        dueAt: o.dueAt,
        windowStart: o.windowStart,
        localDeadline: localDeadline(d, o.dueAt),
        cancelled: effectiveCancelled,
        evaluation: o.evaluation,
        delivery: o.delivery,
        notice: o.notice ?? null,
        acknowledgement: o.acknowledgement ?? null,
        history: evidence.history,
        sendable: !effectiveCancelled && this.clock() > o.windowStart && claimable(o.delivery, this.clock()),
        notified: o.notice?.state === "acknowledged",
        correctedAfterNotice:
          o.evaluation === "on_time" &&
          o.notice !== undefined &&
          ["sending", "acknowledged", "unknown"].includes(o.notice.state),
      };
    } catch (err) {
      return {
        occurrenceId: o._id,
        dueAt: o.dueAt,
        state: "integrity_or_storage_error",
        reason: safeError(err),
        sendable: false,
      };
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
      current = found
        ? await this.occurrenceView(await this.store.occurrence(id))
        : {
            occurrenceId: id,
            obligationId: d._id,
            dueAt: due,
            sendable: d.deliveryAdmission === undefined,
            delivery: "pending",
            materialized: false,
          };
    }
    const recent = await this.store.occurrences
      .find({ obligationId: d._id }, DURABLE_READ)
      .sort({ dueAt: -1 })
      .limit(5)
      .toArray();
    return {
      definition: d,
      nextDeadline: nextEligible,
      nextLocalDeadline: nextEligible ? localDeadline(d, nextEligible) : null,
      current,
      recent: await Promise.all(recent.map((o) => this.occurrenceView(parseStored(occurrenceSchema, o)))),
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
      producerAgentId: agentId,
      dueAt: { $lte: this.clock() },
      $or: [
        { "delivery.state": { $ne: "acknowledged" } },
        { "acknowledgement.receiptWriteState": { $in: ["pending", "expired_unresolved"] } },
      ],
    };
    const rows = await this.store.occurrencesPage(filter, after, input.limit + 1);
    const page = rows.slice(0, input.limit);
    const backlog = await this.store.definitions
      .find({ producerAgentId: agentId }, DURABLE_READ)
      .sort({ scanThrough: 1 })
      .limit(1)
      .toArray();
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
      ...((await this.definitionView(d)) as object),
      occurrences: await Promise.all(page.map((o) => this.occurrenceView(o))),
      nextCursor: rows.length > input.limit ? cursor("history", id, page.at(-1)!._id) : null,
      heartbeat: await this.heartbeat(),
      receiptRetentionMs: await this.receipts.retentionMs(),
    };
  }
}
