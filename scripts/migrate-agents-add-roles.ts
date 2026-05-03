#!/usr/bin/env npx tsx
/**
 * One-time migration: backfill `roles: string[]` on agent_definitions (KPR-141).
 *
 * Operations (idempotent, safe to re-run):
 *   - For each agent in the appropriate ROLES_MAP (selected by --instance),
 *     set `roles` if currently empty/missing. Existing non-empty `roles` are
 *     left untouched.
 *
 * Usage:
 *   npm run migrate:agents:add-roles -- --instance dodi               # dry-run
 *   npm run migrate:agents:add-roles -- --instance dodi --apply       # commit
 *   npm run migrate:agents:add-roles -- --instance keepur --apply
 *
 * Env: MONGODB_URI (default mongodb://localhost:27017)
 *
 * If your instance isn't dodi or keepur, edit ROLES_MAP_<INSTANCE> in this
 * file before running, or use the admin MCP `agent_update` tool to set roles
 * one-by-one.
 */

import { MongoClient } from "mongodb";

const ROLES_MAP_DODI: Record<string, string[]> = {
  mokie: ["Chief of Staff"],
  jasper: ["VP Engineering"],
  colt: ["DevOps"],
  chloe: ["Product Manager"],
  river: ["Marketing Manager"],
  jessica: ["Customer Success"],
  milo: ["Sales Development Representative"],
  wyatt: ["Product Specialist"],
  sige: ["Production Support", "Bilingual liaison (Mandarin/English)"],
  rae: ["Receptionist"],
  nora: ["Operations & Purchasing"],
};

const ROLES_MAP_KEEPUR: Record<string, string[]> = {
  hermi: ["Chief of Staff"],
  alexandria: ["Engineering Lead"],
  samantha: ["Marketing Operations"],
  luna: ["Content Manager"],
};

const ROLES_MAPS: Record<string, Record<string, string[]>> = {
  dodi: ROLES_MAP_DODI,
  keepur: ROLES_MAP_KEEPUR,
};

interface AgentDoc {
  _id: string;
  name: string;
  roles?: string[];
  disabled?: boolean;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const instanceIdx = process.argv.indexOf("--instance");
  if (instanceIdx === -1 || !process.argv[instanceIdx + 1]) {
    console.error("Usage: npm run migrate:agents:add-roles -- --instance <id> [--apply]");
    process.exit(1);
  }
  const instance = process.argv[instanceIdx + 1];
  const map = ROLES_MAPS[instance];
  if (!map) {
    console.error(`Unknown instance "${instance}". Known: ${Object.keys(ROLES_MAPS).join(", ")}.`);
    console.error(`Edit scripts/migrate-agents-add-roles.ts to add a ROLES_MAP for this instance.`);
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const dbName = `hive_${instance}`;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const agents = db.collection<AgentDoc>("agent_definitions");

  const all = await agents.find({}).toArray();

  let willUpdate = 0;
  let alreadySet = 0;
  let unmapped = 0;
  const ops: Array<{ updateOne: { filter: { _id: string }; update: { $set: { roles: string[]; updatedAt: Date; updatedBy: string } } } }> = [];

  for (const a of all) {
    if (a.roles && a.roles.length > 0) {
      alreadySet++;
      continue;
    }
    const roles = map[a._id];
    if (!roles) {
      unmapped++;
      console.warn(`  unmapped: ${a._id} (${a.name}) — add to ROLES_MAP_${instance.toUpperCase()} or set via admin agent_update`);
      continue;
    }
    willUpdate++;
    ops.push({
      updateOne: {
        filter: { _id: a._id },
        update: {
          $set: {
            roles,
            updatedAt: new Date(),
            updatedBy: "migrate-agents-add-roles",
          },
        },
      },
    });
  }

  console.log(`Plan against ${dbName}.agent_definitions (total: ${all.length}):`);
  console.log(`  will update: ${willUpdate}`);
  console.log(`  already set: ${alreadySet}`);
  console.log(`  unmapped (skipped): ${unmapped}`);

  if (!apply) {
    console.log("\n(dry-run; pass --apply to commit)");
    await client.close();
    return;
  }

  if (ops.length > 0) {
    const r = await agents.bulkWrite(ops);
    console.log(`Updates: matched=${r.matchedCount} modified=${r.modifiedCount}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
