/**
 * Agent ID rename map for KPR-88: role-based → name-based.
 *
 * Imported by scripts/migrate-agent-ids.ts and its tests.
 * Single source of truth — do not duplicate this map in the migration script.
 */

export interface RenameMap {
  /** Map from old role-based ID to new name-based ID. */
  readonly rename: Readonly<Record<string, string>>;
  /** IDs that already use the new convention; included for completeness. */
  readonly unchanged: readonly string[];
}

export const AGENT_ID_RENAME_MAP: RenameMap = {
  rename: {
    "chief-of-staff": "mokie",
    "customer-success": "jessica",
    devops: "colt",
    "executive-assistant": "rae",
    "marketing-manager": "river",
    "product-manager": "chloe",
    "product-specialist": "wyatt",
    "production-support": "sige",
    sdr: "milo",
    "vp-engineering": "jasper",
  },
  unchanged: ["nora"],
};

/** Lookup helper: returns new ID for a known old ID, or undefined if not in map. */
export function newIdFor(oldId: string): string | undefined {
  return AGENT_ID_RENAME_MAP.rename[oldId];
}

/** Lookup helper: returns true if the ID is a known old role-based ID that needs renaming. */
export function isOldId(id: string): boolean {
  return id in AGENT_ID_RENAME_MAP.rename;
}

/** Lookup helper: returns true if the ID is already in name-based form (post-migration). */
export function isNewId(id: string): boolean {
  const newIds = new Set(Object.values(AGENT_ID_RENAME_MAP.rename));
  return newIds.has(id) || AGENT_ID_RENAME_MAP.unchanged.includes(id);
}
