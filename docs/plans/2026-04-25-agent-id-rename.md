# KPR-88: Agent ID Standardization — Name-Based IDs Migration

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.

**Goal:** Rename agent IDs from role-based (`chief-of-staff`, `vp-engineering`, etc.) to name-based (`mokie`, `jasper`, etc.) across the entire Hive ecosystem — engine code, plugin seeds, MongoDB collections (dodi + keepur), per-agent directories, and operator memory. Deliver a reusable migration script so the same operation can run against any instance.

**Architecture:** Two artifacts ship in this plan:
1. **Engine + plugin code changes** that remove hardcoded `chief-of-staff` references in favor of config-driven lookup, and rename plugin seed files to use the new IDs.
2. **A standalone TypeScript migration script** at `scripts/migrate-agent-ids.ts` that connects to a target Hive instance's MongoDB, applies the rename map across all 11 collections, renames per-agent directories, validates, and supports `--dry-run`.

After the code lands and merges, the operator runs the script against dodi, then keepur. The script is idempotent — re-running it after a clean migration is a no-op.

**Tech Stack:** TypeScript (NodeNext, strict), MongoDB driver `^7.1.0` (already a hive dep), Vitest for tests.

**Spec reference:** Linear ticket KPR-88 description.

---

## Rename Map

```
chief-of-staff      → mokie
customer-success    → jessica
devops              → colt
executive-assistant → rae
marketing-manager   → river
nora                → nora        (no change)
product-manager     → chloe
product-specialist  → wyatt
production-support  → sige
sdr                 → milo
vp-engineering      → jasper
```

10 renames; nora is the no-op (already name-based — was the asymmetry that motivated the fix).

---

## Discovered scope (dodi instance, 2026-04-25)

MongoDB documents to migrate:

| Collection | Field | Count |
|---|---|---|
| `agent_definitions` | `_id` | 10 |
| `agent_definition_versions` | `agentId` | 19 |
| `agent_memory` | `agentId` | 1734 |
| `agent_callbacks` | `agentId` | 167 |
| `sessions` | `agentId` | 543 |
| `model_overrides` | `agentId` | 3 |
| `activity_log` | `agentId` | 2436 |
| `prompt_overrides` | `agentId` | 3 |
| `agent_config_overrides` | `agentId` | 6 |
| `schedule_overrides` | `agentId` | 2 |
| `devices` | `defaultAgentId` | 7 |
| **Total** | | **4,930** |

Engine code references to update:

| File | Line | Reference |
|---|---|---|
| `src/config.ts` | 138 | `defaultAgent: optional("DEFAULT_AGENT", "chief-of-staff")` |
| `src/setup/wizard.ts` | 150 | `findOne({ _id: "chief-of-staff" })` |
| `src/setup/wizard.ts` | 686 | `hive.agents["chief-of-staff"]` |
| `src/setup/wizard.ts` | 690 | seed path `resolve(..., "chief-of-staff", ...)` |
| `src/setup/wizard.ts` | 743 | `hive.agents?.["chief-of-staff"]?.name` |
| `src/search/conversation-search-mcp-server.ts` | 19 | `DEFAULT_AGENT = ... ?? "chief-of-staff"` |
| `src/startup/first-boot.ts` | 18 | `const COS_AGENT_ID = "chief-of-staff"` |
| `src/memory/memory-mcp-server.ts` | 8 | docstring example only |

Plugin seed files to rename (`plugins/dodi/agent-seeds/`):
- 9 files, names match old role-IDs

Per-agent directories on dodi: 13 dirs total (including 2 orphan first-name dirs from a prior partial migration — those merge into the new homes during this rename).

Per-agent directories on keepur: TBD (script will discover at runtime).

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `scripts/migrate-agent-ids.ts` | The migration tool. Reads rename map from a config or constant; applies to all collections + filesystem. |
| `scripts/migrate-agent-ids.test.ts` | Unit tests for the rename functions (collection mappers, dir merger). |
| `scripts/agent-id-rename-map.ts` | The rename map as a typed constant. Imported by the migration script and by tests. |
| `tsconfig.scripts.json` | Separate tsconfig so `scripts/` is typecheckable (mirrors the existing `tsconfig.plugins.json` pattern). |

### Files to modify (engine)

| File | Reason |
|---|---|
| `src/setup/wizard.ts` | Replace 4 hardcoded `chief-of-staff` strings with reads from config/env |
| `src/startup/first-boot.ts` | Replace `COS_AGENT_ID = "chief-of-staff"` with config read |
| `src/memory/memory-mcp-server.ts` | Update docstring example (cosmetic) |
| `package.json` | Add `npm run migrate:agent-ids` script + extend `npm run typecheck` to include scripts/ |
| `vitest.config.ts` | Add `scripts/**/*.test.ts` to `include` |

`src/config.ts:138` already env-overridable (`DEFAULT_AGENT` env var) — the literal `"chief-of-staff"` is the *fallback*, which is fine to keep for fresh installs that don't override (an operator setting up a new instance can pick any default).

### Files to modify (plugin seeds)

`plugins/dodi/agent-seeds/<old-id>.yaml` → `plugins/dodi/agent-seeds/<new-id>.yaml`:
- `customer-success.yaml` → `jessica.yaml`
- `devops.yaml` → `colt.yaml`
- `executive-assistant.yaml` → `rae.yaml`
- `marketing-manager.yaml` → `river.yaml`
- `product-manager.yaml` → `chloe.yaml`
- `product-specialist.yaml` → `wyatt.yaml`
- `production-support.yaml` → `sige.yaml`
- `sdr.yaml` → `milo.yaml`
- `vp-engineering.yaml` → `jasper.yaml`

Each file's internal `id:` field also updates.

---

## Task 1: Pre-flight discovery and inventory

**Files:** none — read-only audit run from the working directory.

- [ ] **Step 1.0:** **PR base decision.** Confirm with operator before any commits: does KPR-74 (Day-1 OOB epic) have a tracking branch in hive, or do we PR directly to main? If main: branch from main, PR base main. If epic branch: branch from `KPR-74-<slug>`, PR base that. Capture the answer here:

```
PR base: ___________________ (operator confirms before Task 2)
```

- [ ] **Step 1.0b:** **`applied_frames` precheck.** If KPR-84 (Frames Phase 1) has shipped and adopted hive-baseline against this instance, the migration script will not touch nested `applied_frames` keys correctly. Run:

```bash
mongosh hive_dodi --quiet --eval 'print("applied_frames count: " + db.applied_frames.countDocuments({}))'
mongosh hive_keepur --quiet --eval 'print("applied_frames count: " + db.applied_frames.countDocuments({}))' 2>/dev/null || echo "(keepur applied_frames not present)"
```

If either count > 0, **stop**. Frames-aware nested-key migration logic needs to be added to the script (or run an `applied_frames` cleanup pass first). Do not proceed.

Two paths forward when this fires — coordinate with operator before continuing:
- **(a)** Run KPR-88 first by un-adopting any frames against the affected instance, then re-adopt after KPR-88 runs (preferred when only one frame has been adopted).
- **(b)** Extend this migration script with nested-key support for `applied_frames.resources.coreservers[<old-id>]`, `applied_frames.resources.schedule[<old-id>]`, `applied_frames.resources.prompts[<old-id>]`, and `applied_frames.driftAccepted[].resource` (which embeds agent ids in strings like `prompts:<old-id>`). Then re-run.

Pick (a) for speed in early phases when adoption volume is low; pick (b) once Frames is established and un-adoption isn't reasonable.

- [ ] **Step 1.1:** Confirm the rename map is current. Verify each old ID exists in the target instance and the new ID does not.

```bash
mongosh hive_dodi --quiet --eval '
const map = {
  "chief-of-staff": "mokie", "customer-success": "jessica", "devops": "colt",
  "executive-assistant": "rae", "marketing-manager": "river", "product-manager": "chloe",
  "product-specialist": "wyatt", "production-support": "sige", "sdr": "milo",
  "vp-engineering": "jasper"
};
for (const [oldId, newId] of Object.entries(map)) {
  const oldExists = !!db.agent_definitions.findOne({_id: oldId});
  const newExists = !!db.agent_definitions.findOne({_id: newId});
  print(`${oldId.padEnd(22)} → ${newId.padEnd(10)}  oldExists=${oldExists}  newExists=${newExists}`);
}
'
```

Expected: every `oldExists=true`, every `newExists=false`. If any new ID already exists (e.g., `nora` showing `newExists=true` with no rename pair), that's a separate concern — investigate before proceeding.

- [ ] **Step 1.2:** Snapshot the current state for rollback. Full DB dumps (no `--collection` flags — `mongodump` only takes one `--collection` per invocation, and a full DB dump is strictly safer than a hand-picked list).

```bash
mkdir -p /tmp/kpr-88-pre-migration
mongodump --db hive_dodi --out /tmp/kpr-88-pre-migration/dodi
ls -la /tmp/kpr-88-pre-migration/dodi/hive_dodi/
```

Expected: BSON files for every collection in hive_dodi.

- [ ] **Step 1.3:** Same for keepur.

```bash
mongosh hive_keepur --quiet --eval 'db.getCollectionNames().forEach(c => print(c))' | sort
mongodump --db hive_keepur --out /tmp/kpr-88-pre-migration/keepur
```

(If keepur DB doesn't exist, mongodump returns an empty dump cleanly.)

- [ ] **Step 1.4:** Verify per-agent directories on both instances:

```bash
ls /Users/mokie/services/hive/dodi/agents/ | sort
ls /Users/mokie/services/hive/keepur/agents/ 2>/dev/null | sort || echo "(keepur agents dir not present)"
```

Note any directories that don't fit the rename map (orphans like `milo/`, `river/` on dodi from prior partial migrations).

- [ ] **Step 1.5:** No commit; this is verification only.

---

## Task 2: Rename map module

**Files:**
- Create: `scripts/agent-id-rename-map.ts`

- [ ] **Step 2.1:** Create the rename map as a typed module:

```typescript
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
    "devops": "colt",
    "executive-assistant": "rae",
    "marketing-manager": "river",
    "product-manager": "chloe",
    "product-specialist": "wyatt",
    "production-support": "sige",
    "sdr": "milo",
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
```

- [ ] **Step 2.2:** Create `tsconfig.scripts.json` so `scripts/` is in a typechecked tree (mirrors `tsconfig.plugins.json`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist/scripts",
    "rootDir": "scripts",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["scripts/**/*.ts"],
  "exclude": ["node_modules", "scripts/**/*.test.ts"]
}
```

Update `package.json` `typecheck` script to also typecheck scripts/:

```json
"typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.plugins.json && tsc --noEmit -p tsconfig.scripts.json"
```

(If `typecheck` already runs the plugin tsconfig, just append the scripts tsconfig.)

Update `vitest.config.ts` `include` to add `scripts/**/*.test.ts`:

```typescript
include: ["src/**/*.test.ts", "plugins/**/*.test.ts", "setup/**/*.test.ts", "scripts/**/*.test.ts"],
```

- [ ] **Step 2.3:** Verify

```bash
npm run typecheck
```

Expected: no errors. The `tsconfig.scripts.json` typecheck includes the rename map.

- [ ] **Step 2.4:** Commit

```bash
git add scripts/agent-id-rename-map.ts tsconfig.scripts.json package.json vitest.config.ts
git commit -m "feat(kpr-88): rename map + tsconfig/vitest wiring for scripts/"
```

---

## Task 3: Migration script

**Files:**
- Create: `scripts/migrate-agent-ids.ts`

- [ ] **Step 3.1:** Create `scripts/migrate-agent-ids.ts`. Self-contained CLI script that connects to a Hive instance MongoDB, applies the rename across all collections + per-agent directories, with `--dry-run` and `--apply` modes.

```typescript
#!/usr/bin/env node
/**
 * KPR-88: Agent ID rename migration.
 *
 * Usage:
 *   npx tsx scripts/migrate-agent-ids.ts <instance> --dry-run
 *   npx tsx scripts/migrate-agent-ids.ts <instance> --apply
 *
 * Reads rename map from scripts/agent-id-rename-map.ts and applies it across:
 *   - 11 MongoDB collections (renames _id and *.agentId / *.defaultAgentId fields)
 *   - per-agent filesystem directories at ~/services/hive/<instance>/agents/<id>/
 *
 * Idempotent: re-running after a clean migration is a no-op.
 */

import { MongoClient, type Db } from "mongodb";
import { existsSync, statSync, renameSync, readdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AGENT_ID_RENAME_MAP } from "./agent-id-rename-map.js";

interface CollectionMigration {
  /** Collection name. */
  name: string;
  /** Field to rename (or "_id" for the document ID itself). */
  field: string;
  /** True if the field is the _id (requires delete + insert; cannot $set _id). */
  isId?: boolean;
}

const COLLECTIONS: CollectionMigration[] = [
  { name: "agent_definitions", field: "_id", isId: true },
  { name: "agent_definition_versions", field: "agentId" },
  { name: "agent_memory", field: "agentId" },
  { name: "agent_callbacks", field: "agentId" },
  { name: "sessions", field: "agentId" },
  { name: "model_overrides", field: "agentId" },
  { name: "activity_log", field: "agentId" },
  { name: "prompt_overrides", field: "agentId" },
  { name: "agent_config_overrides", field: "agentId" },
  { name: "schedule_overrides", field: "agentId" },
  { name: "devices", field: "defaultAgentId" },
];

interface MigrationStats {
  collection: string;
  field: string;
  matched: number;
  modified: number;
}

interface DirectoryAction {
  from: string;
  to: string;
  action: "rename" | "merge" | "skip-already-migrated";
  notes?: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const instance = args[0];
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");

  if (!instance || (dryRun === apply)) {
    console.error("Usage: migrate-agent-ids <instance> --dry-run | --apply");
    process.exit(1);
  }

  const dbName = `hive_${instance}`;
  const servicePath = join(homedir(), "services", "hive", instance);
  const agentsDir = join(servicePath, "agents");

  console.log(`Migration: ${dbName}`);
  console.log(`Mode:      ${dryRun ? "DRY-RUN" : "APPLY"}`);
  console.log(`Service:   ${servicePath}`);
  console.log("");

  const client = new MongoClient("mongodb://localhost:27017");
  try {
    await client.connect();
    const db = client.db(dbName);

    // Phase A: MongoDB collections
    const stats: MigrationStats[] = [];
    for (const coll of COLLECTIONS) {
      const collStats = coll.isId
        ? await migrateIdField(client, db, coll.name, dryRun)
        : await migrateNonIdField(db, coll.name, coll.field, dryRun);
      stats.push({ ...collStats, collection: coll.name, field: coll.field });
    }

    console.log("\n=== MongoDB migration ===");
    let totalMatched = 0;
    let totalModified = 0;
    for (const s of stats) {
      console.log(
        `  ${s.collection.padEnd(28)} ${s.field.padEnd(16)} matched=${s.matched.toString().padStart(5)} ${dryRun ? "would-modify" : "modified"}=${s.modified}`,
      );
      totalMatched += s.matched;
      totalModified += s.modified;
    }
    console.log(`  TOTAL                                            matched=${totalMatched.toString().padStart(5)} ${dryRun ? "would-modify" : "modified"}=${totalModified}`);

    // Phase B: filesystem
    console.log("\n=== Per-agent directories ===");
    const dirActions = planDirectoryActions(agentsDir);
    for (const action of dirActions) {
      console.log(`  ${action.action.padEnd(24)} ${action.from} → ${action.to}${action.notes ? "  (" + action.notes + ")" : ""}`);
    }
    if (apply) {
      executeDirectoryActions(dirActions);
    }

    // Phase C: validation
    if (apply) {
      console.log("\n=== Post-migration validation ===");
      await validate(db, agentsDir);
    }

    console.log("\nDone.");
  } finally {
    await client.close();
  }
}

async function migrateIdField(
  client: MongoClient,
  db: Db,
  collectionName: string,
  dryRun: boolean,
): Promise<{ matched: number; modified: number }> {
  // _id rename requires delete + re-insert. We do it inside a session transaction
  // so a partial failure (insert succeeds, delete fails) never leaves duplicates.
  // MongoDB transactions require a replica set; if running against a standalone
  // mongod, the transaction call throws and we fall back to a logged unsafe path.
  const coll = db.collection(collectionName);
  let matched = 0;
  let modified = 0;
  for (const [oldId, newId] of Object.entries(AGENT_ID_RENAME_MAP.rename)) {
    const doc = await coll.findOne({ _id: oldId as never });
    if (!doc) continue;
    matched++;
    if (dryRun) {
      modified++;
      continue;
    }
    const existingNew = await coll.findOne({ _id: newId as never });
    if (existingNew) {
      console.warn(`  ⚠ ${collectionName}: ${newId} already exists; skipping rename of ${oldId}`);
      continue;
    }
    const newDoc = { ...doc, _id: newId };
    await renameIdInTransaction(client, coll, oldId, newDoc);
    modified++;
  }
  return { matched, modified };
}

async function renameIdInTransaction(
  client: MongoClient,
  coll: import("mongodb").Collection,
  oldId: string,
  newDoc: Record<string, unknown>,
): Promise<void> {
  // Wrap insert+delete in a session transaction (replica set required).
  // Falls back to non-transactional sequence on standalone mongod with a clear warning.
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await coll.insertOne(newDoc as never, { session });
      await coll.deleteOne({ _id: oldId as never }, { session });
    });
  } catch (err: unknown) {
    const msg = (err as Error)?.message ?? "";
    if (msg.includes("Transaction numbers are only allowed on a replica set member or mongos")) {
      console.warn(
        `  ⚠ MongoDB is running standalone (no replica set). Transactions unavailable. Performing unsafe insert+delete for ${oldId}; if interrupted between the two ops, manual cleanup is required.`,
      );
      await coll.insertOne(newDoc as never);
      await coll.deleteOne({ _id: oldId as never });
    } else {
      throw err;
    }
  } finally {
    await session.endSession();
  }
}

async function migrateNonIdField(
  db: Db,
  collectionName: string,
  field: string,
  dryRun: boolean,
): Promise<{ matched: number; modified: number }> {
  const coll = db.collection(collectionName);
  let matched = 0;
  let modified = 0;
  for (const [oldId, newId] of Object.entries(AGENT_ID_RENAME_MAP.rename)) {
    const filter = { [field]: oldId };
    const count = await coll.countDocuments(filter);
    matched += count;
    if (count === 0) continue;
    if (dryRun) {
      modified += count;
      continue;
    }
    const result = await coll.updateMany(filter, { $set: { [field]: newId } });
    modified += result.modifiedCount;
  }
  return { matched, modified };
}

function planDirectoryActions(agentsDir: string): DirectoryAction[] {
  if (!existsSync(agentsDir) || !statSync(agentsDir).isDirectory()) {
    return [];
  }
  const entries = readdirSync(agentsDir).filter((e) => {
    const full = join(agentsDir, e);
    return existsSync(full) && statSync(full).isDirectory();
  });
  const actions: DirectoryAction[] = [];
  for (const [oldId, newId] of Object.entries(AGENT_ID_RENAME_MAP.rename)) {
    const oldDir = join(agentsDir, oldId);
    const newDir = join(agentsDir, newId);
    const oldExists = entries.includes(oldId);
    const newExists = entries.includes(newId);
    if (oldExists && newExists) {
      actions.push({ from: oldDir, to: newDir, action: "merge", notes: "destination already exists; merge contents" });
    } else if (oldExists) {
      actions.push({ from: oldDir, to: newDir, action: "rename" });
    } else if (newExists) {
      actions.push({ from: oldDir, to: newDir, action: "skip-already-migrated", notes: "already at new id" });
    }
    // neither: skip silently
  }
  return actions;
}

function executeDirectoryActions(actions: DirectoryAction[]): void {
  for (const a of actions) {
    if (a.action === "rename") {
      renameSync(a.from, a.to);
    } else if (a.action === "merge") {
      // Copy contents of old → new (preserving structure), then remove old.
      // cpSync recursive merge keeps existing files in dest unless overwritten.
      cpSync(a.from, a.to, { recursive: true, errorOnExist: false, force: false });
      rmSync(a.from, { recursive: true, force: true });
    }
    // skip-already-migrated: no-op
  }
}

async function validate(db: Db, agentsDir: string): Promise<void> {
  // Check 1: no document in any collection still references an old ID.
  let stragglers = 0;
  for (const coll of COLLECTIONS) {
    if (coll.isId) {
      for (const oldId of Object.keys(AGENT_ID_RENAME_MAP.rename)) {
        const exists = await db.collection(coll.name).findOne({ _id: oldId as never });
        if (exists) {
          console.warn(`  ⚠ straggler: ${coll.name}._id = "${oldId}" still exists`);
          stragglers++;
        }
      }
    } else {
      for (const oldId of Object.keys(AGENT_ID_RENAME_MAP.rename)) {
        const count = await db.collection(coll.name).countDocuments({ [coll.field]: oldId });
        if (count > 0) {
          console.warn(`  ⚠ straggler: ${coll.name}.${coll.field} = "${oldId}" → ${count} docs`);
          stragglers += count;
        }
      }
    }
  }
  if (stragglers === 0) {
    console.log("  ✓ MongoDB: no stragglers");
  } else {
    console.warn(`  ✗ MongoDB: ${stragglers} stragglers — re-run --apply or investigate`);
  }

  // Check 2: per-agent directories use new IDs.
  if (existsSync(agentsDir)) {
    const dirs = readdirSync(agentsDir);
    const oldDirs = dirs.filter((d) => d in AGENT_ID_RENAME_MAP.rename);
    if (oldDirs.length === 0) {
      console.log("  ✓ Filesystem: no orphan old-ID directories");
    } else {
      console.warn(`  ✗ Filesystem: orphan old-ID dirs: ${oldDirs.join(", ")}`);
    }
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

- [ ] **Step 3.2:** Create `scripts/migrate-agent-ids.test.ts`. Tests for the pure-function helpers (rename map lookup, directory action planner). MongoDB integration is exercised by the actual run.

```typescript
import { describe, it, expect } from "vitest";
import {
  AGENT_ID_RENAME_MAP,
  newIdFor,
  isOldId,
  isNewId,
} from "./agent-id-rename-map.js";

describe("AGENT_ID_RENAME_MAP", () => {
  it("contains 10 renames", () => {
    expect(Object.keys(AGENT_ID_RENAME_MAP.rename)).toHaveLength(10);
  });

  it("includes nora as unchanged", () => {
    expect(AGENT_ID_RENAME_MAP.unchanged).toContain("nora");
  });

  it("newIdFor returns mapped values", () => {
    expect(newIdFor("chief-of-staff")).toBe("mokie");
    expect(newIdFor("vp-engineering")).toBe("jasper");
  });

  it("newIdFor returns undefined for unknown ids", () => {
    expect(newIdFor("nora")).toBeUndefined();
    expect(newIdFor("not-an-agent")).toBeUndefined();
  });

  it("isOldId true for known old ids", () => {
    expect(isOldId("chief-of-staff")).toBe(true);
    expect(isOldId("mokie")).toBe(false);
    expect(isOldId("nora")).toBe(false);
  });

  it("isNewId true for new ids and unchanged", () => {
    expect(isNewId("mokie")).toBe(true);
    expect(isNewId("nora")).toBe(true);
    expect(isNewId("chief-of-staff")).toBe(false);
  });

  it("rename targets are all distinct", () => {
    const targets = Object.values(AGENT_ID_RENAME_MAP.rename);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("no rename target collides with another rename source", () => {
    const sources = new Set(Object.keys(AGENT_ID_RENAME_MAP.rename));
    for (const target of Object.values(AGENT_ID_RENAME_MAP.rename)) {
      expect(sources.has(target)).toBe(false);
    }
  });
});
```

- [ ] **Step 3.3:** Add an npm script in `package.json`:

```json
"migrate:agent-ids": "tsx scripts/migrate-agent-ids.ts"
```

(Add inside the existing `"scripts": { ... }` block, alphabetical-ish near other `migrate:*` entries if present.)

- [ ] **Step 3.4:** Verify

```bash
npm run typecheck
npx vitest run scripts/migrate-agent-ids.test.ts
```

Expected: typecheck clean, 8 tests pass.

- [ ] **Step 3.5:** Commit

```bash
git add scripts/migrate-agent-ids.ts scripts/migrate-agent-ids.test.ts package.json
git commit -m "feat(kpr-88): migration script for agent ID rename"
```

---

## Task 4: De-hardcode `chief-of-staff` in engine code

**Files:**
- Modify: `src/setup/wizard.ts`
- Modify: `src/startup/first-boot.ts`
- Modify: `src/memory/memory-mcp-server.ts` (cosmetic docstring)

`src/config.ts:138` and `src/search/conversation-search-mcp-server.ts:19` already use `process.env.DEFAULT_AGENT ?? "chief-of-staff"` patterns — the literal is a fallback for fresh installs that don't override. We **keep** those as-is; the literal is just a default for the case where no instance config exists yet, and `mokie` is dodi-specific anyway.

The engine work here is just for the spots where the literal `"chief-of-staff"` appears without env-fallback.

- [ ] **Step 4.1:** Replace `chief-of-staff` literals in `src/setup/wizard.ts`. Each occurrence (lines 150, 686, 690, 743) becomes a read from a single helper that resolves to either the env var or a config value. Add the helper near the top of the file (after imports):

```typescript
function resolveCosAgentId(): string {
  return process.env.DEFAULT_AGENT ?? "chief-of-staff";
}
```

Then replace the four call sites. For example, line 150:

```typescript
// Before:
const agent = await db.collection("agent_definitions").findOne({ _id: "chief-of-staff" as any });

// After:
const cosId = resolveCosAgentId();
const agent = await db.collection("agent_definitions").findOne({ _id: cosId as any });
```

For line 686 (`hive.agents["chief-of-staff"] = ...`), line 690 (seed path resolve), and line 743 (`hive.agents?.["chief-of-staff"]?.name`), apply the same pattern: use `resolveCosAgentId()` to get the id once at the top of the relevant function, then reference the variable.

- [ ] **Step 4.2:** Replace `COS_AGENT_ID` constant in `src/startup/first-boot.ts`:

```typescript
// Before:
const COS_AGENT_ID = "chief-of-staff";

// After:
const COS_AGENT_ID = process.env.DEFAULT_AGENT ?? "chief-of-staff";
```

(Single-line change; the rest of the file already references the constant.)

- [ ] **Step 4.3:** Update the docstring in `src/memory/memory-mcp-server.ts:8`. Change the example from `"chief-of-staff"` to a generic placeholder like `"<agent-id>"`:

```typescript
// Before:
*   AGENT_ID     — the agent's ID (e.g. "chief-of-staff")

// After:
*   AGENT_ID     — the agent's ID (e.g. "mokie")
```

- [ ] **Step 4.4:** Verify

```bash
npm run check
```

Expected: typecheck + tests pass. If a test mocks the wizard and expects `chief-of-staff` literally, update the mock to use the env-overridden value.

- [ ] **Step 4.5:** Commit

```bash
git add src/setup/wizard.ts src/startup/first-boot.ts src/memory/memory-mcp-server.ts
git commit -m "refactor(kpr-88): de-hardcode chief-of-staff in engine wizard/first-boot"
```

---

## Task 5: Rename plugin agent-seed files

**Files:**
- Rename: 9 files in `plugins/dodi/agent-seeds/`
- Modify: each file's internal `id:` field

- [ ] **Step 5.1:** Rename the seed files using git mv (preserves blame):

```bash
cd plugins/dodi/agent-seeds
git mv customer-success.yaml jessica.yaml
git mv devops.yaml colt.yaml
git mv executive-assistant.yaml rae.yaml
git mv marketing-manager.yaml river.yaml
git mv product-manager.yaml chloe.yaml
git mv product-specialist.yaml wyatt.yaml
git mv production-support.yaml sige.yaml
git mv sdr.yaml milo.yaml
git mv vp-engineering.yaml jasper.yaml
cd ../../..
```

- [ ] **Step 5.2:** Update each seed's internal `id:` field. For each renamed file, find the line `id: <old-id>` and replace with the new id.

```bash
# Verify each file currently has the matching old id
for pair in \
  "jasper.yaml:vp-engineering" \
  "jessica.yaml:customer-success" \
  "colt.yaml:devops" \
  "rae.yaml:executive-assistant" \
  "river.yaml:marketing-manager" \
  "chloe.yaml:product-manager" \
  "wyatt.yaml:product-specialist" \
  "sige.yaml:production-support" \
  "milo.yaml:sdr"; do
  file="${pair%%:*}"
  oldId="${pair##*:}"
  if ! grep -q "^id: ${oldId}$" "plugins/dodi/agent-seeds/${file}"; then
    echo "ERROR: plugins/dodi/agent-seeds/${file} does not contain 'id: ${oldId}'"
  fi
done
```

If all files report nothing (silent success), proceed. If any error, investigate before proceeding.

```bash
# Apply the id rewrites
sed -i.bak 's/^id: vp-engineering$/id: jasper/'        plugins/dodi/agent-seeds/jasper.yaml
sed -i.bak 's/^id: customer-success$/id: jessica/'     plugins/dodi/agent-seeds/jessica.yaml
sed -i.bak 's/^id: devops$/id: colt/'                  plugins/dodi/agent-seeds/colt.yaml
sed -i.bak 's/^id: executive-assistant$/id: rae/'      plugins/dodi/agent-seeds/rae.yaml
sed -i.bak 's/^id: marketing-manager$/id: river/'      plugins/dodi/agent-seeds/river.yaml
sed -i.bak 's/^id: product-manager$/id: chloe/'        plugins/dodi/agent-seeds/chloe.yaml
sed -i.bak 's/^id: product-specialist$/id: wyatt/'     plugins/dodi/agent-seeds/wyatt.yaml
sed -i.bak 's/^id: production-support$/id: sige/'      plugins/dodi/agent-seeds/sige.yaml
sed -i.bak 's/^id: sdr$/id: milo/'                     plugins/dodi/agent-seeds/milo.yaml
rm plugins/dodi/agent-seeds/*.bak
```

- [ ] **Step 5.3:** Verify the renames are clean. Each file should have its new id.

```bash
for f in plugins/dodi/agent-seeds/*.yaml; do
  name=$(basename "$f" .yaml)
  id=$(grep "^id:" "$f" | head -1 | awk '{print $2}')
  if [ "$name" != "$id" ]; then
    echo "MISMATCH: file=${name} id=${id}"
  fi
done
echo "Done."
```

Expected: only "Done." line; no mismatch warnings.

- [ ] **Step 5.4:** Skill scoping — scan plugin skills for `agents:` frontmatter referencing old IDs. If `plugins/dodi/skills/` ever contained skills with `agents: [<old-id>]` frontmatter, those need updating.

```bash
grep -rn -E "agents:.*?(chief-of-staff|customer-success|devops|executive-assistant|marketing-manager|product-manager|product-specialist|production-support|sdr|vp-engineering)" plugins/dodi/skills/ 2>/dev/null
```

Expected: empty result. If any matches are found, update them with the new IDs (manual edit).

- [ ] **Step 5.5:** Verify

```bash
npm run check
```

Expected: clean.

- [ ] **Step 5.6:** Commit

```bash
git add plugins/dodi/agent-seeds/
git commit -m "feat(kpr-88): rename plugin seed files to name-based IDs"
```

---

## Task 6: Dry-run on dodi

**Files:** none — operational run.

- [ ] **Step 6.1:** From the hive repo root, run the migration script in dry-run mode against dodi:

```bash
npm run migrate:agent-ids -- dodi --dry-run
```

Expected output structure:

```
Migration: hive_dodi
Mode:      DRY-RUN
Service:   /Users/<user>/services/hive/dodi

=== MongoDB migration ===
  agent_definitions             _id              matched=    10 would-modify=10
  agent_definition_versions     agentId          matched=    19 would-modify=19
  agent_memory                  agentId          matched=  1734 would-modify=1734
  agent_callbacks               agentId          matched=   167 would-modify=167
  sessions                      agentId          matched=   543 would-modify=543
  model_overrides               agentId          matched=     3 would-modify=3
  activity_log                  agentId          matched=  2436 would-modify=2436
  prompt_overrides              agentId          matched=     3 would-modify=3
  agent_config_overrides        agentId          matched=     6 would-modify=6
  schedule_overrides            agentId          matched=     2 would-modify=2
  devices                       defaultAgentId   matched=     7 would-modify=7
  TOTAL                                          matched=  4930 would-modify=4930

=== Per-agent directories ===
  rename                   /Users/.../agents/chief-of-staff → /Users/.../agents/mokie
  rename                   /Users/.../agents/customer-success → /Users/.../agents/jessica
  rename                   /Users/.../agents/devops → /Users/.../agents/colt
  rename                   /Users/.../agents/executive-assistant → /Users/.../agents/rae
  merge                    /Users/.../agents/marketing-manager → /Users/.../agents/river  (destination already exists; merge contents)
  rename                   /Users/.../agents/product-manager → /Users/.../agents/chloe
  rename                   /Users/.../agents/product-specialist → /Users/.../agents/wyatt
  rename                   /Users/.../agents/production-support → /Users/.../agents/sige
  merge                    /Users/.../agents/sdr → /Users/.../agents/milo  (destination already exists; merge contents)
  rename                   /Users/.../agents/vp-engineering → /Users/.../agents/jasper

Done.
```

- [ ] **Step 6.2:** Sanity check the totals against Task 1's discovery. The `matched` counts should equal the inventory numbers. If they differ, investigate before proceeding.

- [ ] **Step 6.3:** No commit; this is a verification run.

---

## Task 7: Apply on dodi + smoke test

**Files:** none — operational run.

- [ ] **Step 7.1:** Stop the dodi hive service before running the migration. Live writes during migration would create stragglers.

```bash
launchctl bootout gui/$(id -u)/com.hive.dodi.agent
sleep 3
launchctl list | grep com.hive.dodi || echo "Stopped."
```

- [ ] **Step 7.2:** Apply the migration:

```bash
npm run migrate:agent-ids -- dodi --apply
```

Expected: all the same numbers as the dry-run, but printed as `modified=N`. Validation section at the end should report:

```
=== Post-migration validation ===
  ✓ MongoDB: no stragglers
  ✓ Filesystem: no orphan old-ID directories
```

If stragglers, re-run `--apply` (script is idempotent; re-running picks up missed records).

- [ ] **Step 7.3:** Spot-check the renamed agent definitions:

```bash
mongosh hive_dodi --quiet --eval '
db.agent_definitions.find({}, {_id: 1, name: 1}).sort({_id: 1}).forEach(a => print(`  ${a._id.padEnd(12)} ${a.name||"?"}`));'
```

Expected: 11 agents, all with name-based IDs (mokie, jessica, colt, rae, river, nora, chloe, wyatt, sige, milo, jasper).

- [ ] **Step 7.4:** Restart the dodi service:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hive.dodi.agent.plist
sleep 5
launchctl list | grep com.hive.dodi
```

Wait for the engine to come up. Tail the log briefly to confirm clean startup:

```bash
tail -50 ~/services/hive/dodi/logs/hive.log
```

Look for: agent definitions loaded successfully, no "agent not found: chief-of-staff" or similar errors.

- [ ] **Step 7.5:** Smoke test — send a Slack message addressed to one of the renamed agents (Mokie or Jasper) via Slack, confirm the response routes correctly. (Operator-driven; this is a live system test.)

```
@Mokie ping
```

Expected: response from Mokie (chief-of-staff agent now keyed at `_id: mokie`) within ~30 seconds.

- [ ] **Step 7.6:** Verify per-agent directories are renamed:

```bash
ls /Users/mokie/services/hive/dodi/agents/ | sort
```

Expected: 11 dirs, all name-based (mokie, jessica, colt, rae, river, nora, chloe, wyatt, sige, milo, jasper). No more orphan `milo/`/`river/` (merged into proper homes during the apply).

- [ ] **Step 7.7:** No commit; operational milestone only.

---

## Task 8: Apply on keepur

**Files:** none — operational run.

Same pattern as Task 7, against the keepur instance:

- [ ] **Step 8.1:** Dry-run first:

```bash
npm run migrate:agent-ids -- keepur --dry-run
```

Keepur's counts will differ from dodi (smaller/newer instance with fewer historical docs). Some collections may be empty.

- [ ] **Step 8.2:** Stop keepur:

```bash
launchctl bootout gui/$(id -u)/com.hive.keepur.agent
sleep 3
```

- [ ] **Step 8.3:** Apply:

```bash
npm run migrate:agent-ids -- keepur --apply
```

- [ ] **Step 8.4:** Restart:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hive.keepur.agent.plist
sleep 5
tail -50 ~/services/hive/keepur/logs/hive.log
```

- [ ] **Step 8.5:** Verify and smoke test (Slack ping to one keepur agent).

- [ ] **Step 8.6:** No commit; operational.

---

## Task 9: Auto-memory and documentation cleanup

**Files:**
- Modify: `/Users/mokie/.claude/projects/-Users-mokie-github-hive/memory/MEMORY.md`
- Modify: `/Users/mokie/.claude/projects/-Users-mokie-github-hive/memory/*.md` (any references)
- Modify: `CLAUDE.md` (if it references old IDs)

This task updates the operator's auto-memory and any docs that reference old IDs. Auto-memory is in `~/.claude/projects/.../memory/` and is operator-local — not committed to the repo.

- [ ] **Step 9.1:** Audit references in operator memory:

```bash
grep -rn -E "(chief-of-staff|customer-success|executive-assistant|marketing-manager|product-manager|product-specialist|production-support|vp-engineering|sdr|devops)" /Users/mokie/.claude/projects/-Users-mokie-github-hive/memory/ 2>/dev/null
```

Expected: a handful of references in MEMORY.md and a few topic files. For each, replace with the new name-based ID. Some may be in narrative form ("Chief of Staff" with a capital C) — those are role-references in prose, leave them. Update only the IDs (`chief-of-staff` → `mokie`, etc.).

- [ ] **Step 9.2:** Audit references in repo docs:

```bash
grep -rn -E "(chief-of-staff|customer-success|executive-assistant|marketing-manager|product-manager|product-specialist|production-support|vp-engineering|sdr|devops)" \
  CLAUDE.md README.md docs/ \
  | grep -v "(KPR-|2026-04-25-agent-id-rename\.md|MIGRATION|migration|rename)" \
  | head
```

Expected: a few references in CLAUDE.md (the engine seeds list), maybe in `docs/architecture.md`. Update them to use new IDs.

- [ ] **Step 9.3:** Verify

```bash
npm run check
```

Expected: clean (no test should depend on the old strings as test fixtures — that would have been caught in Task 4).

- [ ] **Step 9.4:** Commit (engine docs only — auto-memory is not in the repo)

```bash
git add CLAUDE.md README.md docs/
git commit -m "docs(kpr-88): update agent ID references after rename"
```

---

## Task 10: Open the PR

**Files:** none — PR creation.

- [ ] **Step 10.1:** Push the branch:

```bash
git push -u origin KPR-88-agent-id-rename
```

(Branch name should match what `dodi-dev:pickup` set up. If you skipped `dodi-dev:pickup` and worked on a different branch name, adjust accordingly.)

- [ ] **Step 10.2:** Create the PR. Per `feedback_pr_base_on_epic_branches.md`, this is a child of KPR-74 (Day-1 OOB epic). Check whether the epic has a tracking branch in hive; if not, target main. **Confirm with operator** which base to use.

```bash
gh pr create --base main --title "feat: KPR-88 — agent ID standardization (name-based IDs)" --body "$(cat <<'EOF'
## Summary

Migrates agent IDs from role-based (`chief-of-staff`, `vp-engineering`, etc.) to name-based (`mokie`, `jasper`, etc.) across:
- Engine code (de-hardcoded `chief-of-staff` in setup wizard + first-boot)
- Plugin agent-seed files (renamed + internal `id:` updated)
- A new migration script at `scripts/migrate-agent-ids.ts` for the per-instance MongoDB + filesystem rename
- Operator memory + repo docs

## Why

Per Linear KPR-88: 10 role-based + 1 name-based (nora) was an inconsistent baseline. Jasper's recent rescoping (VP Engineering → Engineering Coordinator) showed that the role-based ID makes scope changes "not stick" — every read of his record reasserts the old role.

## Test plan

- [x] `npm run check` green
- [x] Migration script unit tests pass
- [x] Dry-run against dodi shows expected counts (~4,930 docs)
- [x] Apply against dodi: post-validation reports no stragglers
- [x] Smoke test: Slack ping to renamed agent routes correctly
- [x] Repeat for keepur
- [x] Per-agent dirs renamed with no orphans

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 10.3:** Return the PR URL.

---

## What this plan does NOT do

- **Slack channel renames.** Channels already use `agent-<name>` convention (e.g., `#agent-jasper`, `#agent-mokie`) so no Slack rename needed. Verify during Task 7 smoke test.
- **Engine seed tree at `seeds/chief-of-staff/`.** The hive engine ships a CoS seed at `<repo>/seeds/chief-of-staff/agent.yaml` (engine-level, not plugin-level — confirmed by inspection 2026-04-25). This is the seed used by `hive setup` for **fresh instances**. After this migration, dodi/keepur are migrated, but a brand-new instance bootstrapped from this engine still gets `chief-of-staff` by default. Renaming the engine seed is a separate concern (affects the day-1 OOB experience for all future operators) — track as KPR-74-child follow-up; do not address here.
- **`DEFAULT_AGENT` env-fallback literal in `src/config.ts` and `conversation-search-mcp-server.ts`.** Both retain `?? "chief-of-staff"` as the fallback when no env override is set. After this migration, that fallback is staler than ideal — but it only fires on instances with no `DEFAULT_AGENT` set, which is mostly fresh-install territory and pairs with the engine seed concern above. Track as the same KPR-74-child follow-up.
- **Cross-instance frame nested-key migration.** Caught by Step 1.0b precheck: if `applied_frames` is non-empty at run time, the plan stops. The flat key-based `updateMany` won't reach nested keys like `applied_frames.resources.coreservers["chief-of-staff"]`. Adding nested-key support to the script is out of scope for this plan; treat the precheck as the gate. If the precheck fires, file a follow-up ticket and pause this work until the script is extended.
- **Email/SMS aliases.** Each agent has an email like `mokie@dodihome.com` already (or `jasper@dodihome.com`). Aliases are managed externally; not affected by this rename.
- **Resend / outbound email from-addresses.** These resolve from agent `name` (display name), not `_id`. Unaffected.

---

## Acceptance criteria (rolled up)

- [ ] `npm run check` green throughout
- [ ] Migration script idempotent (rerun = no-op)
- [ ] Dodi: 11 name-based agents in `db.agent_definitions`; per-agent dirs match; no stragglers in audit
- [ ] Keepur: same clean result
- [ ] Slack ping to a renamed agent routes correctly on each instance
- [ ] No `chief-of-staff` literals in `src/` (except the env-fallback default in config.ts and conversation-search-mcp-server.ts, which are intentional)
- [ ] Plugin seed files renamed; internal `id:` matches filename
- [ ] No `any` introduced in production code
- [ ] PR opened against the correct base (main, or epic branch if KPR-74 has one)
- [ ] Operator memory + repo docs updated
- [ ] `applied_frames` (if present) flagged for follow-up

---

## Test coverage summary

| File | Test count | Type |
|---|---|---|
| `scripts/migrate-agent-ids.test.ts` | 8 | Unit (rename map + helpers) |
| Engine `npm run check` | (existing) | Catches any test breakage from de-hardcoding |
| Dodi/keepur smoke (Tasks 7, 8) | manual | Integration against live instances |
