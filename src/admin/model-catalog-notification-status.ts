import type { Db } from "mongodb";
import {
  NOTICE_REASONS,
  display,
  nonblank,
  validBinding,
  validDate,
  validDelivery,
  type NoticeReason,
} from "./model-catalog-notification.js";

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const date = (value: unknown): number | undefined => (validDate(value) ? value.getTime() : undefined);

export interface NotificationStatus {
  provider: string;
  pending: number;
  claimed: number;
  prepared: number;
  uncertain: number;
  blocked: number;
  invalid: number;
  oldest?: { id: string; at?: number };
  nextAt?: number;
  reason?: { code: NoticeReason; at: number };
  acknowledgedAt?: number;
  timingTrouble: boolean;
}

export type NotificationReport = { kind: "available"; rows: NotificationStatus[] } | { kind: "unavailable" };

export function emptyNotificationStatus(provider: string): NotificationStatus {
  return {
    provider,
    pending: 0,
    claimed: 0,
    prepared: 0,
    uncertain: 0,
    blocked: 0,
    invalid: 0,
    timingTrouble: false,
  };
}

export function addNotificationStatus(status: NotificationStatus, raw: unknown, now: number): void {
  const row = obj(raw);
  const delivery = obj(row.delivery);
  const claim = obj(delivery.claim);
  const preparation = obj(delivery.preparation);
  const receipt = obj(delivery.receipt);
  const state = delivery.state;
  const createdAt = date(row.createdAt);
  const next =
    delivery.retryBlocked === true
      ? undefined
      : date(state === "claimed" ? claim.leaseExpiresAt : delivery.nextAttemptAt);
  const processed = date(preparation.processedAt);
  const acknowledged = date(receipt.acknowledgedAt);
  const diagnostic = obj(delivery.diagnostic);
  const badTime = (parent: Record<string, unknown>, field: string) =>
    Object.hasOwn(parent, field) && (date(parent[field]) === undefined || date(parent[field])! > now);
  const timingTrouble =
    createdAt === undefined ||
    createdAt > now ||
    !validDate(delivery.nextAttemptAt) ||
    badTime(delivery, "lastAttemptAt") ||
    badTime(claim, "startedAt") ||
    badTime(obj(claim.sendIntent), "startedAt") ||
    badTime(preparation, "processedAt") ||
    badTime(receipt, "acknowledgedAt") ||
    badTime(diagnostic, "at");
  if (timingTrouble || delivery.retryBlocked === true) status.timingTrouble = true;

  const mutableValid = validDelivery(row.delivery);
  if (!mutableValid || createdAt === undefined) status.invalid++;

  // Retained uncertainty survives a terminal receipt, including crash/rebinding recovery.
  if (delivery.uncertainSend === true || Object.hasOwn(claim, "sendIntent")) status.uncertain++;
  if (delivery.retryBlocked === true) status.blocked++;

  const diagnosticAt = date(diagnostic.at);
  if (
    NOTICE_REASONS.has(diagnostic.reason as NoticeReason) &&
    diagnosticAt !== undefined &&
    diagnosticAt <= now &&
    (!status.reason || diagnosticAt > status.reason.at)
  ) {
    status.reason = { code: diagnostic.reason as NoticeReason, at: diagnosticAt };
  }

  const terminal = mutableValid && state === "delivered" && acknowledged !== undefined && !timingTrouble;
  if (terminal) {
    status.acknowledgedAt = Math.max(status.acknowledgedAt ?? -Infinity, acknowledged);
    return;
  }

  if (state === "claimed") status.claimed++;
  else status.pending++;
  if (nonblank(preparation.id) && validBinding(preparation.binding) && processed !== undefined) status.prepared++;
  if (!status.oldest || (createdAt !== undefined && (status.oldest.at === undefined || createdAt < status.oldest.at))) {
    status.oldest = { id: typeof row._id === "string" ? row._id : "unavailable", at: createdAt };
  }
  if (next !== undefined) status.nextAt = Math.min(status.nextAt ?? Infinity, next);
  if (next === undefined) status.timingTrouble = true;
}

// Computed inclusion preserves missing versus supplied scalar/null/object values. Dotted-only
// preparation projection can erase a malformed parent; keep its original type/value instead.
// Object fields with a missing Mongo expression remain absent, never synthesized as undefined/null.
export const notificationStatusProjection = {
  _id: 1,
  provider: 1,
  createdAt: 1,
  delivery: {
    $cond: [
      { $eq: [{ $type: "$delivery" }, "object"] },
      {
        ...Object.fromEntries(
          [
            "state",
            "attempts",
            "version",
            "nextAttemptAt",
            "lastAttemptAt",
            "claim",
            "receipt",
            "uncertainSend",
            "diagnostic",
            "retryBlocked",
          ].map((key) => [key, `$delivery.${key}`]),
        ),
        preparation: {
          $cond: [
            { $eq: [{ $type: "$delivery.preparation" }, "object"] },
            {
              id: "$delivery.preparation.id",
              binding: "$delivery.preparation.binding",
              processedAt: "$delivery.preparation.processedAt",
            },
            "$delivery.preparation",
          ],
        },
      },
      "$delivery",
    ],
  },
};

export async function readNotificationStatus(db: Db, now = Date.now()): Promise<NotificationReport> {
  try {
    const rows = new Map<string, NotificationStatus>();
    const cursor = db
      .collection("agent_model_catalog_changes")
      .find({ provider: { $ne: "gemini" } }, { projection: notificationStatusProjection });
    for await (const row of cursor) {
      const provider = typeof row.provider === "string" && row.provider.trim() ? row.provider : "unknown-provider";
      const status = rows.get(provider) ?? emptyNotificationStatus(provider);
      addNotificationStatus(status, row, now);
      rows.set(provider, status);
    }
    return { kind: "available", rows: [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider)) };
  } catch {
    return { kind: "unavailable" };
  }
}

export function notificationNote(status: NotificationStatus, now = Date.now()): string {
  const oldest = status.oldest
    ? `${display(status.oldest.id, 160)}; age ${
        status.oldest.at === undefined || status.oldest.at > now
          ? "unavailable"
          : `${Math.floor((now - status.oldest.at) / 60_000)}m`
      }`
    : "none";
  return (
    `${display(status.provider, 160)}: notifications pending ${status.pending}, in progress ${status.claimed}, ` +
    `prepared ${status.prepared}, possibly repeated ${status.uncertain}, retry blocked ${status.blocked}, ` +
    `invalid ${status.invalid}; oldest ${oldest}; next retry/lease expiry ${
      status.nextAt === undefined
        ? status.pending + status.claimed
          ? "unavailable"
          : "none"
        : new Date(status.nextAt).toISOString()
    }; reason ${status.reason?.code ?? (status.invalid ? "invalid-state" : "none")}` +
    `${status.timingTrouble ? "; timing unavailable/clock-inconsistent" : ""}` +
    (status.acknowledgedAt === undefined
      ? "; no recorded acknowledgment."
      : `; CoS processed; Slack accepted ${new Date(status.acknowledgedAt).toISOString()}.`)
  );
}
