import { BUILTIN_CATALOG_PROVIDERS } from "./model-catalog-types.js";

export const SCAN_INTERVAL_MS = 8 * 60 * 60 * 1000;
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const dateMs = (value: unknown): number | undefined =>
  value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : undefined;
const pastMs = (value: unknown, now: number): number | undefined => {
  const ms = dateMs(value);
  return ms !== undefined && ms <= now ? ms : undefined;
};
const codes = new Set([
  "auth",
  "client-version",
  "http",
  "timeout",
  "canceled",
  "malformed",
  "empty",
  "too-large",
  "storage",
]);
export function catalogTiming(snapshot: unknown, now: number) {
  const doc = record(snapshot),
    scan = record(doc.scan);
  const seeded = Array.isArray(doc.models) && doc.models.length > 0;
  const started = pastMs(scan.startedAt, now),
    succeeded = pastMs(scan.lastSucceededAt, now);
  const finished = pastMs(scan.finishedAt, now),
    lease = dateMs(scan.leaseExpiresAt);
  const completed = scan.outcome === "succeeded" || scan.outcome === "failed";
  const inconsistent =
    doc.scan !== undefined &&
    (started === undefined ||
      (completed && finished === undefined) ||
      (scan.lastSucceededAt !== undefined && succeeded === undefined) ||
      (scan.outcome === "succeeded" && succeeded === undefined) ||
      (finished !== undefined && started !== undefined && finished < started));
  return { doc, scan, seeded, started, succeeded, finished, lease, completed, inconsistent };
}
export function catalogDue(snapshot: unknown, now: number, startupAvailable: boolean, intervalMs = SCAN_INTERVAL_MS) {
  const t = catalogTiming(snapshot, now);
  // A future lease is never bypassed, even if another date is malformed.
  if (t.lease !== undefined && t.lease > now) return { due: false, recover: false, consumeStartup: false };
  const recover = t.scan.outcome === "running";
  const due =
    recover ||
    t.doc.scan === undefined ||
    (!t.seeded && startupAvailable) ||
    !t.completed ||
    t.inconsistent ||
    t.started === undefined ||
    now >= t.started + intervalMs;
  return { due, recover, consumeStartup: due && !t.seeded };
}
export function catalogStatus(provider: string, snapshot: unknown, now = Date.now()) {
  const t = catalogTiming(snapshot, now);
  const automatic = (BUILTIN_CATALOG_PROVIDERS as readonly string[]).includes(provider);
  const saved = pastMs(t.doc.updatedAt, now);
  const source = t.doc.source === "manual" || t.doc.source === "discovery" ? t.doc.source : "legacy/unknown";
  const ageMs = t.succeeded === undefined ? undefined : now - t.succeeded;
  const freshness =
    t.scan.lastSucceededAt === undefined
      ? "never"
      : ageMs === undefined
        ? "unknown/clock-inconsistent"
        : ageMs < SCAN_INTERVAL_MS
          ? "recent"
          : "overdue";
  const latest =
    t.scan.outcome === "running"
      ? t.lease === undefined
        ? "unfinished; lease unknown"
        : t.lease <= now
          ? "expired/unresolved"
          : "running"
      : t.completed
        ? String(t.scan.outcome)
        : t.doc.scan === undefined
          ? "never"
          : "unknown";
  const error = record(t.scan.error);
  const errorCode = typeof error.code === "string" && codes.has(error.code) ? error.code : "storage";
  const httpStatus =
    typeof error.httpStatus === "number" &&
    Number.isInteger(error.httpStatus) &&
    error.httpStatus >= 100 &&
    error.httpStatus <= 599
      ? error.httpStatus
      : undefined;
  return {
    provider,
    automatic,
    seeded: t.seeded,
    modelCount: Array.isArray(t.doc.models) ? t.doc.models.length : 0,
    source,
    savedAt: saved,
    succeededAt: t.succeeded,
    ageMs,
    freshness,
    latest,
    startedAt: t.started,
    finishedAt: t.finished,
    leaseExpiresAt: t.lease,
    nextAttemptAt: t.started === undefined ? undefined : t.started + SCAN_INTERVAL_MS,
    timingInconsistent: t.inconsistent,
    errorCode,
    httpStatus,
    recoveryPending: Object.hasOwn(t.doc, "pendingExport"),
  };
}
export type CatalogStatus = ReturnType<typeof catalogStatus>;
const when = (ms: number | undefined): string =>
  ms === undefined ? "unknown/clock-inconsistent" : new Date(ms).toISOString();
export function catalogStatusNote(s: CatalogStatus): string {
  const parts = [
    s.seeded
      ? `saved ${when(s.savedAt)} (${s.source}), ${s.modelCount} models`
      : "not yet seeded — manual option: agent_model_catalog_refresh",
  ];
  if (s.automatic) {
    parts.push(
      s.freshness === "never"
        ? "last discovery success never"
        : `last discovery success ${when(s.succeededAt)} (${s.freshness}${s.ageMs === undefined ? "" : `; age ${Math.floor(s.ageMs / 1000)}s`})`,
    );
    parts.push(`latest attempt ${s.latest}${s.startedAt === undefined ? "" : `, started ${when(s.startedAt)}`}`);
    if (s.latest === "failed")
      parts.push(
        `failed at ${when(s.finishedAt)} (${s.errorCode}${s.httpStatus === undefined ? "" : ` HTTP ${s.httpStatus}`})`,
      );
    if (["running", "expired/unresolved", "unfinished; lease unknown"].includes(s.latest))
      parts.push(`lease ${when(s.leaseExpiresAt)}`);
    parts.push(`next normal attempt ${when(s.nextAttemptAt)}`);
    if (s.timingInconsistent) parts.push("scan timing unavailable/clock-inconsistent");
    parts.push("automatic checks every 8h; discovery timestamps describe checks, not later manual edits");
  } else parts.push("manually maintained");
  if (s.recoveryPending) parts.push("audit/change recovery pending");
  return `${s.provider}: ${parts.join("; ")}.`;
}
export const catalogUnavailableNote = (provider: string): string => `${provider}: catalog storage unavailable.`;
