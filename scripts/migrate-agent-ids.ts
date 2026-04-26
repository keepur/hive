#!/usr/bin/env node
/**
 * KPR-88: Agent ID rename migration.
 *
 * Usage:
 *   npx tsx scripts/migrate-agent-ids.ts <instance> --dry-run
 *   npx tsx scripts/migrate-agent-ids.ts <instance> --apply
 *
 * Reads rename map from scripts/agent-id-rename-map.ts and applies it across:
 *   - MongoDB collections (renames _id and *.agentId / *.defaultAgentId fields,
 *     plus a small set of cross-cutting embedded references discovered during
 *     audit: team_messages.senderId, team_channels members[]/_id/text,
 *     memory.updatedBy/path, memory_versions.savedBy/path,
 *     sessions._id (prefix) and sessions.threadId, *_overrides.updatedBy,
 *     and agent_definition_versions.snapshot._id).
 *   - per-agent filesystem directories at ~/services/hive/<instance>/agents/<id>/
 *
 * Idempotent: re-running after a clean migration is a no-op.
 *
 * The script prints `applied_frames count` and refuses to mutate it. If a frame
 * has been adopted (KPR-84) the operator must un-adopt before this migration
 * runs (see plan Step 1.0b for rationale).
 */

import { type Collection, type Db, MongoClient, type WithId } from "mongodb";
import { cpSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/**
 * Additional "actor" fields where renamed agents appear as the user/actor
 * who edited a record (rather than the subject of the record). We rename
 * these for clean attribution; not strictly required for correctness, but
 * leaving them stale would point audit trails at non-existent IDs.
 */
const ACTOR_FIELDS: { name: string; field: string }[] = [
  { name: "memory", field: "updatedBy" },
  { name: "memory_versions", field: "savedBy" },
  { name: "model_overrides", field: "updatedBy" },
  { name: "prompt_overrides", field: "updatedBy" },
  { name: "agent_config_overrides", field: "updatedBy" },
  { name: "schedule_overrides", field: "updatedBy" },
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

  if (!instance || dryRun === apply) {
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

    // Safety gate: refuse to run if applied_frames is non-empty.
    const framesCount = await db.collection("applied_frames").countDocuments({});
    console.log(`applied_frames count: ${framesCount}`);
    if (framesCount > 0) {
      console.error(
        "Refusing to run: applied_frames is non-empty. Un-adopt frames before running this migration (see plan Step 1.0b).",
      );
      process.exit(2);
    }

    // Phase A: MongoDB collections (subject IDs)
    const stats: MigrationStats[] = [];
    for (const coll of COLLECTIONS) {
      const collStats = coll.isId
        ? await migrateIdField(client, db, coll.name, dryRun)
        : await migrateNonIdField(db, coll.name, coll.field, dryRun);
      stats.push({
        ...collStats,
        collection: coll.name,
        field: coll.field,
      });
    }

    // Phase A2: actor / attribution fields (cross-cutting)
    for (const { name, field } of ACTOR_FIELDS) {
      const s = await migrateNonIdField(db, name, field, dryRun);
      stats.push({ ...s, collection: name, field });
    }

    // Phase A3: embedded / structural fields that aren't simple equality.
    const embeddedStats = await migrateEmbeddedReferences(client, db, dryRun);
    stats.push(...embeddedStats);

    console.log("\n=== MongoDB migration ===");
    let totalMatched = 0;
    let totalModified = 0;
    for (const s of stats) {
      console.log(
        `  ${s.collection.padEnd(28)} ${s.field.padEnd(20)} matched=${s.matched.toString().padStart(5)} ${dryRun ? "would-modify" : "modified"}=${s.modified}`,
      );
      totalMatched += s.matched;
      totalModified += s.modified;
    }
    console.log(
      `  TOTAL                                                matched=${totalMatched
        .toString()
        .padStart(5)} ${dryRun ? "would-modify" : "modified"}=${totalModified}`,
    );

    // Phase B: filesystem
    console.log("\n=== Per-agent directories ===");
    const dirActions = planDirectoryActions(agentsDir);
    for (const action of dirActions) {
      console.log(
        `  ${action.action.padEnd(24)} ${action.from} → ${action.to}${action.notes ? "  (" + action.notes + ")" : ""}`,
      );
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
  // _id rename requires delete + re-insert. Wrap in a session transaction so a
  // partial failure (insert succeeds, delete fails) never leaves duplicates.
  // MongoDB transactions require a replica set; on a standalone mongod we
  // print a warning and fall through to a non-transactional sequence.
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
      console.warn(`  ! ${collectionName}: ${newId} already exists; skipping rename of ${oldId}`);
      continue;
    }
    const newDoc: Record<string, unknown> = { ...doc, _id: newId };
    await renameIdInTransaction(client, coll, oldId, newDoc);
    modified++;
  }
  return { matched, modified };
}

async function renameIdInTransaction(
  client: MongoClient,
  coll: Collection,
  oldId: string,
  newDoc: Record<string, unknown>,
): Promise<void> {
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
        `  ! MongoDB is running standalone (no replica set). Transactions unavailable. Performing unsafe insert+delete for ${oldId}; if interrupted between the two ops, manual cleanup is required.`,
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
    const result = await coll.updateMany(filter, {
      $set: { [field]: newId },
    });
    modified += result.modifiedCount;
  }
  return { matched, modified };
}

/**
 * Embedded / structural references that the simple equality update doesn't
 * cover. Each handler returns a `MigrationStats` row so totals roll up
 * cleanly.
 */
async function migrateEmbeddedReferences(client: MongoClient, db: Db, dryRun: boolean): Promise<MigrationStats[]> {
  const out: MigrationStats[] = [];
  out.push(await migrateMemoryPaths(db, "memory", dryRun));
  out.push(await migrateMemoryPaths(db, "memory_versions", dryRun));
  out.push(await migrateTeamMessagesSenderId(db, dryRun));
  out.push(await migrateTeamChannels(client, db, dryRun));
  out.push(await migrateSessionIds(client, db, dryRun));
  out.push(await migrateAgentDefinitionVersionsSnapshotId(db, dryRun));
  return out;
}

async function migrateMemoryPaths(db: Db, collectionName: string, dryRun: boolean): Promise<MigrationStats> {
  const coll = db.collection(collectionName);
  let matched = 0;
  let modified = 0;
  for (const [oldId, newId] of Object.entries(AGENT_ID_RENAME_MAP.rename)) {
    const filter = { path: { $regex: `^agents/${escapeRegex(oldId)}/` } };
    const docs = await coll.find(filter).toArray();
    matched += docs.length;
    if (docs.length === 0) continue;
    if (dryRun) {
      modified += docs.length;
      continue;
    }
    for (const doc of docs) {
      const oldPath = doc.path as string;
      const newPath = oldPath.replace(new RegExp(`^agents/${escapeRegex(oldId)}/`), `agents/${newId}/`);
      await coll.updateOne({ _id: doc._id }, { $set: { path: newPath } });
      modified++;
    }
  }
  return { collection: collectionName, field: "path", matched, modified };
}

async function migrateTeamMessagesSenderId(db: Db, dryRun: boolean): Promise<MigrationStats> {
  return migrateNonIdField(db, "team_messages", "senderId", dryRun).then((s) => ({
    ...s,
    collection: "team_messages",
    field: "senderId",
  }));
}

/**
 * team_channels stores DM channels with `_id` like `dm:<userId>:<agentId>`,
 * `members: [<userId>, <agentId>]`, and references the channel id inside
 * `text` / `command.result` of the seed message. Strategy: for each old id
 * referenced anywhere on the doc, materialize a renamed copy under the new id
 * and remove the old.
 */
async function migrateTeamChannels(client: MongoClient, db: Db, dryRun: boolean): Promise<MigrationStats> {
  const coll = db.collection("team_channels");
  let matched = 0;
  let modified = 0;
  for (const [oldId, newId] of Object.entries(AGENT_ID_RENAME_MAP.rename)) {
    const filter = {
      $or: [{ _id: { $regex: `:${escapeRegex(oldId)}$` } }, { members: oldId }, { createdBy: oldId }],
    };
    // findOne first; we'll iterate per-doc to handle _id rename safely.
    const docs = await coll.find(filter as Record<string, unknown>).toArray();
    matched += docs.length;
    if (docs.length === 0) continue;
    if (dryRun) {
      modified += docs.length;
      continue;
    }
    for (const doc of docs) {
      const oldDocId = doc._id as unknown as string;
      const newDocId =
        typeof oldDocId === "string" ? oldDocId.replace(new RegExp(`:${escapeRegex(oldId)}$`), `:${newId}`) : oldDocId;
      const newMembers = Array.isArray(doc.members)
        ? (doc.members as unknown[]).map((m) => (m === oldId ? newId : m))
        : doc.members;
      const newCreatedBy = doc.createdBy === oldId ? newId : doc.createdBy;
      const updateSet: Record<string, unknown> = {
        members: newMembers,
        createdBy: newCreatedBy,
      };
      if (newDocId !== oldDocId) {
        // _id rename: insert new, delete old.
        const replacement: Record<string, unknown> = {
          ...doc,
          ...updateSet,
          _id: newDocId,
        };
        const existing = await coll.findOne({
          _id: newDocId as never,
        });
        if (existing) {
          console.warn(`  ! team_channels: ${newDocId} already exists; skipping rename of ${oldDocId}`);
          continue;
        }
        await renameIdInTransaction(client, coll, oldDocId, replacement);
      } else {
        await coll.updateOne({ _id: oldDocId as never }, { $set: updateSet });
      }
      modified++;
    }
  }
  return {
    collection: "team_channels",
    field: "_id/members/createdBy",
    matched,
    modified,
  };
}

/**
 * sessions._id is `<agentId>:<threadId>` and sessions.threadId can also embed
 * the agentId at the end (e.g., `team:dm:<userId>:<agentId>`). Rebuild both.
 */
async function migrateSessionIds(client: MongoClient, db: Db, dryRun: boolean): Promise<MigrationStats> {
  const coll = db.collection("sessions");
  let matched = 0;
  let modified = 0;
  for (const [oldId, newId] of Object.entries(AGENT_ID_RENAME_MAP.rename)) {
    const filter = {
      $or: [{ _id: { $regex: `^${escapeRegex(oldId)}:` } }, { threadId: { $regex: `:${escapeRegex(oldId)}$` } }],
    };
    const docs = (await coll.find(filter as Record<string, unknown>).toArray()) as WithId<Record<string, unknown>>[];
    matched += docs.length;
    if (docs.length === 0) continue;
    if (dryRun) {
      modified += docs.length;
      continue;
    }
    for (const doc of docs) {
      const oldDocId = doc._id as unknown as string;
      const newDocId =
        typeof oldDocId === "string" ? oldDocId.replace(new RegExp(`^${escapeRegex(oldId)}:`), `${newId}:`) : oldDocId;
      const oldThreadId = doc.threadId;
      const newThreadId =
        typeof oldThreadId === "string"
          ? oldThreadId.replace(new RegExp(`:${escapeRegex(oldId)}$`), `:${newId}`)
          : oldThreadId;

      if (newDocId !== oldDocId) {
        const replacement: Record<string, unknown> = {
          ...doc,
          _id: newDocId,
          threadId: newThreadId,
        };
        const existing = await coll.findOne({
          _id: newDocId as never,
        });
        if (existing) {
          console.warn(`  ! sessions: ${newDocId} already exists; skipping rename of ${oldDocId}`);
          continue;
        }
        await renameIdInTransaction(client, coll, oldDocId as string, replacement);
      } else if (newThreadId !== oldThreadId) {
        await coll.updateOne({ _id: oldDocId as never }, { $set: { threadId: newThreadId } });
      }
      modified++;
    }
  }
  return {
    collection: "sessions",
    field: "_id/threadId",
    matched,
    modified,
  };
}

/**
 * agent_definition_versions.snapshot._id is the embedded copy of the agent
 * definition's _id at version time. Rename it inside snapshot to match.
 */
async function migrateAgentDefinitionVersionsSnapshotId(db: Db, dryRun: boolean): Promise<MigrationStats> {
  const coll = db.collection("agent_definition_versions");
  let matched = 0;
  let modified = 0;
  for (const [oldId, newId] of Object.entries(AGENT_ID_RENAME_MAP.rename)) {
    const filter = { "snapshot._id": oldId };
    const count = await coll.countDocuments(filter);
    matched += count;
    if (count === 0) continue;
    if (dryRun) {
      modified += count;
      continue;
    }
    const result = await coll.updateMany(filter, {
      $set: { "snapshot._id": newId },
    });
    modified += result.modifiedCount;
  }
  return {
    collection: "agent_definition_versions",
    field: "snapshot._id",
    matched,
    modified,
  };
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
      actions.push({
        from: oldDir,
        to: newDir,
        action: "merge",
        notes: "destination already exists; merge contents",
      });
    } else if (oldExists) {
      actions.push({ from: oldDir, to: newDir, action: "rename" });
    } else if (newExists) {
      actions.push({
        from: oldDir,
        to: newDir,
        action: "skip-already-migrated",
        notes: "already at new id",
      });
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
      cpSync(a.from, a.to, {
        recursive: true,
        errorOnExist: false,
        force: false,
      });
      rmSync(a.from, { recursive: true, force: true });
    }
    // skip-already-migrated: no-op
  }
}

async function validate(db: Db, agentsDir: string): Promise<void> {
  let stragglers = 0;
  for (const coll of COLLECTIONS) {
    if (coll.isId) {
      for (const oldId of Object.keys(AGENT_ID_RENAME_MAP.rename)) {
        const exists = await db.collection(coll.name).findOne({ _id: oldId as never });
        if (exists) {
          console.warn(`  ! straggler: ${coll.name}._id = "${oldId}" still exists`);
          stragglers++;
        }
      }
    } else {
      for (const oldId of Object.keys(AGENT_ID_RENAME_MAP.rename)) {
        const count = await db.collection(coll.name).countDocuments({ [coll.field]: oldId });
        if (count > 0) {
          console.warn(`  ! straggler: ${coll.name}.${coll.field} = "${oldId}" → ${count} docs`);
          stragglers += count;
        }
      }
    }
  }
  // Actor fields
  for (const { name, field } of ACTOR_FIELDS) {
    for (const oldId of Object.keys(AGENT_ID_RENAME_MAP.rename)) {
      const count = await db.collection(name).countDocuments({ [field]: oldId });
      if (count > 0) {
        console.warn(`  ! straggler: ${name}.${field} = "${oldId}" → ${count} docs`);
        stragglers += count;
      }
    }
  }
  // Embedded
  for (const oldId of Object.keys(AGENT_ID_RENAME_MAP.rename)) {
    for (const collName of ["memory", "memory_versions"]) {
      const count = await db.collection(collName).countDocuments({
        path: { $regex: `^agents/${escapeRegex(oldId)}/` },
      });
      if (count > 0) {
        console.warn(`  ! straggler: ${collName}.path agents/${oldId}/* → ${count} docs`);
        stragglers += count;
      }
    }
    const tmCount = await db.collection("team_messages").countDocuments({ senderId: oldId });
    if (tmCount > 0) {
      console.warn(`  ! straggler: team_messages.senderId = "${oldId}" → ${tmCount} docs`);
      stragglers += tmCount;
    }
    const tcCount = await db.collection("team_channels").countDocuments({
      $or: [{ _id: { $regex: `:${escapeRegex(oldId)}$` } }, { members: oldId }],
    } as Record<string, unknown>);
    if (tcCount > 0) {
      console.warn(`  ! straggler: team_channels references ${oldId} → ${tcCount} docs`);
      stragglers += tcCount;
    }
    const sessCount = await db.collection("sessions").countDocuments({
      _id: { $regex: `^${escapeRegex(oldId)}:` },
    } as Record<string, unknown>);
    if (sessCount > 0) {
      console.warn(`  ! straggler: sessions._id starts ${oldId}: → ${sessCount} docs`);
      stragglers += sessCount;
    }
    const sessTidCount = await db.collection("sessions").countDocuments({
      threadId: { $regex: `:${escapeRegex(oldId)}$` },
    } as Record<string, unknown>);
    if (sessTidCount > 0) {
      console.warn(`  ! straggler: sessions.threadId ends :${oldId} → ${sessTidCount} docs`);
      stragglers += sessTidCount;
    }
    const advCount = await db.collection("agent_definition_versions").countDocuments({ "snapshot._id": oldId });
    if (advCount > 0) {
      console.warn(`  ! straggler: agent_definition_versions.snapshot._id = "${oldId}" → ${advCount} docs`);
      stragglers += advCount;
    }
  }

  if (stragglers === 0) {
    console.log("  OK MongoDB: no stragglers");
  } else {
    console.warn(`  FAIL MongoDB: ${stragglers} stragglers — re-run --apply or investigate`);
  }

  if (existsSync(agentsDir)) {
    const dirs = readdirSync(agentsDir);
    const oldDirs = dirs.filter((d) => d in AGENT_ID_RENAME_MAP.rename);
    if (oldDirs.length === 0) {
      console.log("  OK Filesystem: no orphan old-ID directories");
    } else {
      console.warn(`  FAIL Filesystem: orphan old-ID dirs: ${oldDirs.join(", ")}`);
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
