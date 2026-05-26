import type { MemoryTier } from "./memory-types.js";

/**
 * KPR-241: narrow interface for the vector-store side of memory.
 *
 * `MemoryStore` depends on this interface, not on `MemoryEmbedder` concretely,
 * so the store stays Mongo-only at the type boundary and store unit tests can
 * inject a no-op or stub without standing up a real Qdrant connection.
 *
 * `MemoryEmbedder` implements this interface (see `memory-embedder.ts`).
 */
export interface MemoryVectorIndex {
  /**
   * Sync the `tier` field of zero or more existing Qdrant points without
   * re-embedding. Used by `MemoryStore.setTier` and `setTierBulk` when a
   * record transitions tiers in Mongo.
   *
   * Best-effort: implementations should not throw — Mongo state is the
   * source of truth and Qdrant drift is surfaced via the doctor sweep.
   */
  setTierPayload(pointIds: string[], tier: MemoryTier): Promise<void>;
}
