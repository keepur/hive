import { createHash } from "node:crypto";
import { BSON } from "mongodb";
import type {
  CatalogDoc,
  CatalogModel,
  CatalogSource,
  CatalogVersion,
  FailureCode,
  ModelInput,
  SafeCatalogError,
} from "./model-catalog-types.js";

export class CatalogError extends Error {
  constructor(readonly safe: SafeCatalogError) {
    super(safe.message);
  }
}

export function safeError(provider: string, code: FailureCode, httpStatus?: number): SafeCatalogError {
  return {
    code,
    message: `Model catalog ${provider}: ${code}${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}.`,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

export function reject(provider: string, code: FailureCode): never {
  throw new CatalogError(safeError(provider, code));
}

export function object(value: unknown, provider: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(provider, "malformed");
  return value as Record<string, unknown>;
}

export function string(value: unknown, provider: string, id = false): string {
  if (typeof value !== "string" || !value.trim() || (id && value.trim() !== value)) reject(provider, "malformed");
  return value;
}

export function normalizedPayload(provider: string, rows: unknown, manual = false): ModelInput[] {
  if (!Array.isArray(rows)) reject(provider, "malformed");
  if (!rows.length) reject(provider, "empty");
  const seen = new Set<string>();
  const result = rows.map((row) => {
    const x = object(row, provider),
      id = string(x.id, provider, true),
      displayName = string(x.displayName, provider);
    if (seen.has(id)) throw new CatalogError({ code: "malformed", message: "Duplicate model ids in input." });
    seen.add(id);
    if (manual && x.notes !== undefined && typeof x.notes !== "string") reject(provider, "malformed");
    return { id, displayName, ...(manual && x.notes ? { notes: x.notes as string } : {}) };
  });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1024 * 1024) reject(provider, "too-large");
  return result;
}

export function snapshotId(provider: string, models: ModelInput[]): string {
  return createHash("sha256")
    .update(JSON.stringify([provider, models.map((m) => [m.id, m.displayName, m.notes || null])]), "utf8")
    .digest("hex");
}

export function diffText(added: string[], removed: string[]): string {
  const fmt = (xs: string[]) => (xs.length ? ` (${xs.join(", ")})` : "");
  return `+${added.length}${fmt(added)}, -${removed.length}${fmt(removed)}`;
}

export function replacement(
  current: CatalogDoc | null,
  provider: string,
  input: ModelInput[],
  source: CatalogSource,
  updatedBy: string,
  commitId: string,
  now: Date,
  summary?: string,
) {
  const previous = current?.models ?? [],
    byId = new Map(previous.map((m) => [m.id, m]));
  const models: CatalogModel[] = input.map((m) => {
    const old = byId.get(m.id),
      notes = source === "discovery" ? old?.notes : m.notes;
    return { id: m.id, displayName: m.displayName, ...(notes ? { notes } : {}), addedAt: old?.addedAt ?? now };
  });
  normalizedPayload(provider, models, true);
  const ids = new Set(models.map((m) => m.id));
  const added = models.filter((m) => !byId.has(m.id)).map((m) => m.id),
    removed = previous.filter((m) => !ids.has(m.id)).map((m) => m.id);
  const bootstrap = previous.length === 0,
    hash = snapshotId(provider, models),
    revision = (current?.revision ?? 0) + 1;
  const common = {
    _id: commitId,
    provider,
    revision,
    snapshotId: hash,
    source,
    updatedBy,
    createdAt: now,
    bootstrap,
    added,
    removed,
    modelCount: models.length,
  };
  const version: CatalogVersion = { ...common, snapshot: models, changeSummary: summary || diffText(added, removed) };
  const pendingExport = { version, ...(bootstrap || added.length || removed.length ? { change: common } : {}) };
  const fields = {
    provider,
    models,
    revision,
    commitId,
    snapshotId: hash,
    source,
    updatedBy,
    updatedAt: now,
    pendingExport,
  };
  return {
    fields,
    version,
    unchanged: previous.length > 0 && (current?.snapshotId ?? snapshotId(provider, previous)) === hash,
  };
}

export function checkBson(doc: CatalogDoc): void {
  if (BSON.calculateObjectSize(doc) >= 16 * 1024 * 1024) reject(doc.provider, "too-large");
}
