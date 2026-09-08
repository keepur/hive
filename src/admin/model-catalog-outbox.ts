import { BSON, type Db, type Filter } from "mongodb";
import { isDeepStrictEqual } from "node:util";
import { catalogCollections, JOURNALED } from "./model-catalog-export.js";
import {
  counter as integer,
  nonblank,
  validDate,
  validDelivery,
  type ChangeDelivery,
} from "./model-catalog-notification.js";
import type { CatalogChangeDoc } from "./model-catalog-types.js";

export type MutationKind = "claim" | "renew" | "prepare" | "send-intent" | "release" | "ack";

export interface Transition {
  kind: MutationKind;
  before: CatalogChangeDoc;
  after: CatalogChangeDoc;
  localNow: Date;
  live: boolean;
}

export type Evidence =
  | { kind: "applied"; row: CatalogChangeDoc; source: "ack" | "evidence" }
  | { kind: "advanced"; row: CatalogChangeDoc }
  | { kind: "superseded" }
  | { kind: "unknown" }
  | { kind: "miss" };

export interface CandidateCursor {
  createdAt: Date;
  id: string;
}

export interface CandidatePage {
  rows: CatalogChangeDoc[];
  next?: CandidateCursor;
}

export const copy = <T>(value: T): T => BSON.deserialize(BSON.serialize({ value })).value as T;

export function validChange(row: CatalogChangeDoc): boolean {
  try {
    return validChangeValue(row);
  } catch {
    return false;
  }
}

function validChangeValue(row: CatalogChangeDoc): boolean {
  if (
    !row ||
    typeof row !== "object" ||
    !nonblank(row._id) ||
    !nonblank(row.provider) ||
    row.provider === "gemini" ||
    !integer(row.revision) ||
    row.revision < 1 ||
    !validDate(row.createdAt) ||
    !nonblank(row.snapshotId) ||
    !nonblank(row.updatedBy) ||
    !integer(row.modelCount) ||
    !["manual", "discovery"].includes(row.source) ||
    (row.source === "discovery" && !["claude", "grok", "codex"].includes(row.provider)) ||
    typeof row.bootstrap !== "boolean" ||
    !Array.isArray(row.added) ||
    !row.added.every(nonblank) ||
    !Array.isArray(row.removed) ||
    !row.removed.every(nonblank)
  )
    return false;
  return validDelivery(row.delivery, row._id);
}

const dateExpr = (path: string) => ({ $eq: [{ $type: path }, "date"] });
const atOrBefore = (path: string, now: Date) => ({
  $and: [dateExpr(path), { $lte: [path, { $literal: now }] }, { $lte: [path, "$$NOW"] }],
});
const activeAt = (path: string, now: Date) => ({
  $and: [dateExpr(path), { $gt: [path, { $literal: now }] }, { $gt: [path, "$$NOW"] }],
});

export function eligibleExpression(now: Date) {
  return {
    $or: [
      {
        $and: [
          { $eq: ["$delivery.state", "pending"] },
          { $eq: [{ $type: "$delivery.retryBlocked" }, "missing"] },
          atOrBefore("$delivery.nextAttemptAt", now),
        ],
      },
      {
        $and: [{ $eq: ["$delivery.state", "claimed"] }, atOrBefore("$delivery.claim.leaseExpiresAt", now)],
      },
    ],
  };
}

export function transition(
  kind: MutationKind,
  row: CatalogChangeDoc,
  next: ChangeDelivery,
  at: Date,
  live: boolean,
): Transition {
  if (!validChange(row) || !validDate(at)) throw new Error("invalid-state");
  const after = { ...copy(row), delivery: { ...copy(next), version: (row.delivery.version ?? 0) + 1 } };
  if (!validChange(after)) throw new Error("invalid-state");
  return { kind, before: copy(row), after, localNow: new Date(at), live };
}

export function transitionFilter(t: Transition): Filter<CatalogChangeDoc> {
  const before = t.before.delivery;
  const expressions: Record<string, unknown>[] = [{ $eq: ["$delivery", { $literal: before }] }];
  if (t.kind === "claim") {
    expressions.push(eligibleExpression(t.localNow), {
      $gt: [{ $literal: t.after.delivery.claim!.leaseExpiresAt }, "$$NOW"],
    });
  } else if (t.live) {
    expressions.push(activeAt("$delivery.claim.leaseExpiresAt", t.localNow));
  }
  if (t.kind === "renew") {
    expressions.push(
      {
        $gt: [{ $literal: t.after.delivery.claim!.leaseExpiresAt }, "$delivery.claim.leaseExpiresAt"],
      },
      { $gt: [{ $literal: t.after.delivery.claim!.leaseExpiresAt }, "$$NOW"] },
    );
  }
  return {
    _id: t.before._id,
    "delivery.state": before.state,
    "delivery.version": Object.hasOwn(before, "version") ? before.version : { $exists: false },
    ...(before.claim ? { "delivery.claim.token": before.claim.token } : {}),
    ...(t.kind === "ack" ? { "delivery.preparation.id": t.after.delivery.receipt!.preparationId } : {}),
    $expr: { $and: expressions },
  } as Filter<CatalogChangeDoc>;
}

export class ModelCatalogOutbox {
  private readonly changes;
  private indexInit?: Promise<void>;

  constructor(db: Db) {
    this.changes = catalogCollections(db).changes;
  }

  async ensureIndexes(): Promise<void> {
    if (!this.indexInit) {
      this.indexInit = Promise.all([
        this.changes.createIndex({
          "delivery.state": 1,
          "delivery.nextAttemptAt": 1,
          createdAt: 1,
          _id: 1,
        }),
        this.changes.createIndex({
          "delivery.state": 1,
          "delivery.claim.leaseExpiresAt": 1,
          createdAt: 1,
          _id: 1,
        }),
      ])
        .then(() => undefined)
        .catch(() => {
          this.indexInit = undefined;
          throw new Error("storage");
        });
    }
    return this.indexInit;
  }

  async due(now: Date, limit = 10, after?: CandidateCursor): Promise<CandidatePage> {
    if (
      !validDate(now) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      (after !== undefined && (!validDate(after.createdAt) || typeof after.id !== "string"))
    )
      throw new Error("invalid-state");
    const predicates: Record<string, unknown>[] = [
      eligibleExpression(now),
      dateExpr("$createdAt"),
      { $eq: [{ $type: "$_id" }, "string"] },
    ];
    if (after) {
      predicates.push({
        $or: [
          { $gt: ["$createdAt", { $literal: after.createdAt }] },
          {
            $and: [{ $eq: ["$createdAt", { $literal: after.createdAt }] }, { $gt: ["$_id", { $literal: after.id }] }],
          },
        ],
      });
    }
    const rows = await this.changes
      .find({ $expr: { $and: predicates } })
      .sort({ createdAt: 1, _id: 1 })
      .limit(limit)
      .toArray();
    const last = rows.at(-1);
    return {
      rows,
      ...(rows.length === limit && last ? { next: { createdAt: last.createdAt, id: last._id } } : {}),
    };
  }

  async read(id: string): Promise<CatalogChangeDoc | null> {
    return this.changes.findOne({ _id: id });
  }

  async evidence(t: Transition, mayRead: () => boolean = () => true): Promise<Evidence> {
    if (!mayRead()) return { kind: "unknown" };
    try {
      const row = await this.read(t.before._id);
      if (row && isDeepStrictEqual(row.delivery, t.after.delivery)) {
        return { kind: "applied", row, source: "evidence" };
      }
      if (row && validChange(row) && (row.delivery.version ?? 0) > (t.before.delivery.version ?? 0)) {
        const ownerToken = t.kind === "claim" ? t.after.delivery.claim!.token : t.before.delivery.claim!.token;
        if (row.delivery.state === "claimed" && row.delivery.claim!.token === ownerToken) {
          return { kind: "advanced", row };
        }
        return { kind: "superseded" };
      }
    } catch {
      // Negative or unavailable evidence cannot prove a mutation's outcome.
    }
    return { kind: "unknown" };
  }

  async apply(t: Transition, mayReadEvidence: () => boolean = () => true): Promise<Evidence> {
    try {
      const result = await this.changes.updateOne(
        transitionFilter(t),
        { $set: { delivery: t.after.delivery } },
        { ...JOURNALED, upsert: false },
      );
      if (result.acknowledged && result.matchedCount === 1) {
        return { kind: "applied", row: copy(t.after), source: "ack" };
      }
      const evidence = await this.evidence(t, mayReadEvidence);
      return evidence.kind === "unknown" ? { kind: "miss" } : evidence;
    } catch {
      const evidence = await this.evidence(t, mayReadEvidence);
      return t.kind === "claim" && evidence.kind === "applied" ? { kind: "unknown" } : evidence;
    }
  }
}
