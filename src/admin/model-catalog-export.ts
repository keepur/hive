import { isDeepStrictEqual } from "node:util";
import type { Collection, Db } from "mongodb";
import type { CatalogChangeDoc, CatalogDoc, CatalogVersion, RecoveryResult } from "./model-catalog-types.js";
import { CatalogError, safeError } from "./model-catalog-value.js";

export const JOURNALED = { writeConcern: { w: 1, j: true } } as const;

export const isDuplicate = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);

export function catalogCollections(db: Db) {
  return {
    catalogs: db.collection<CatalogDoc>("agent_model_catalog", JOURNALED),
    versions: db.collection<CatalogVersion>("agent_model_catalog_versions", JOURNALED),
    changes: db.collection<CatalogChangeDoc>("agent_model_catalog_changes", JOURNALED),
  };
}

export type CatalogCollections = ReturnType<typeof catalogCollections>;

async function insertImmutable<T extends { _id: string }>(
  collection: Collection<T>,
  payload: T,
  immutable: (row: T) => unknown,
): Promise<void> {
  try {
    await collection.insertOne(payload as never, JOURNALED);
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const found = await collection.findOne({ _id: payload._id } as never);
    if (!found || !isDeepStrictEqual(immutable(found as T), immutable(payload))) {
      throw new CatalogError({
        code: "storage",
        message: "Model catalog immutable export mismatch; recovery remains pending.",
      });
    }
  }
}

export async function recoverProvider(collections: CatalogCollections, provider: string): Promise<RecoveryResult> {
  let hasEnvelope = false;
  try {
    const doc = await collections.catalogs.findOne({ _id: provider }),
      envelope = doc?.pendingExport;
    if (!envelope) return { provider, kind: "recovered" };
    hasEnvelope = true;
    await insertImmutable(collections.versions, envelope.version, (row) => row);
    if (envelope.change) {
      const change: CatalogChangeDoc = {
        ...envelope.change,
        delivery: { state: "pending", attempts: 0, nextAttemptAt: envelope.change.createdAt },
      };
      await insertImmutable(collections.changes, change, ({ delivery: _delivery, ...immutable }) => immutable);
    }
    await collections.catalogs.updateOne(
      { _id: provider, "pendingExport.version._id": envelope.version._id },
      { $unset: { pendingExport: "" } },
      JOURNALED,
    );
    const after = await collections.catalogs.findOne({ _id: provider });
    return after?.pendingExport
      ? { provider, kind: "pending", error: safeError(provider, "storage") }
      : { provider, kind: "recovered" };
  } catch (error) {
    return {
      provider,
      kind: hasEnvelope ? "pending" : "error",
      error: error instanceof CatalogError ? error.safe : safeError(provider, "storage"),
    };
  }
}
