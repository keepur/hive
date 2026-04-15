#!/usr/bin/env node
/**
 * One-shot migration: move top-level `dodiOpsMode` on existing agent_definitions
 * documents into `metadata.dodiOpsMode`.
 *
 * Why: #135 replaced the typed `dodiOpsMode?: "full" | "readonly"` field on
 * AgentDefinition with a generic `metadata?: Record<string, unknown>` bag.
 * Seeds and plugin.yaml were updated, but existing Mongo documents on live
 * deploys (dodi-hive) still have the old top-level field. Without this
 * migration, `toAgentConfig` reads `undefined` for metadata, the dotted-path
 * resolver returns "", and the dodi-ops MCP server receives DODI_OPS_MODE=""
 * — which silently degrades production-support from readonly to whatever
 * the server's empty-mode default is.
 *
 * This script is not part of the bundled output. Run it against the target
 * hive's Mongo before starting the new service version:
 *
 *   node scripts/migrate-agent-metadata.mjs
 *
 * Reads MONGODB_URI and MONGODB_DB from the same .env file as the service.
 * Idempotent — running twice is a no-op.
 */
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.env.HIVE_HOME ?? process.cwd(), ".env");
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const dbName = process.env.MONGODB_DB ?? `hive_${process.env.INSTANCE_ID ?? "hive"}`;

console.log(`Connecting to ${uri} / ${dbName}...`);
const client = new MongoClient(uri);
await client.connect();

try {
  const db = client.db(dbName);
  const agentDefs = db.collection("agent_definitions");

  // Not bundled into pkg/ — this script runs directly from the source tree
  // at deploy time. Safe to contain the legacy field name as a literal.
  const candidates = await agentDefs.find({ dodiOpsMode: { $exists: true } }).toArray();
  if (candidates.length === 0) {
    console.log("No agent documents with legacy field. Nothing to migrate.");
    process.exit(0);
  }

  console.log(`Found ${candidates.length} agent(s) with legacy field:`);
  for (const doc of candidates) {
    console.log(`  ${doc._id}: dodiOpsMode=${doc.dodiOpsMode}`);
  }

  const result = await agentDefs.updateMany({ dodiOpsMode: { $exists: true } }, [
    { $set: { "metadata.dodiOpsMode": "$dodiOpsMode" } },
    { $unset: "dodiOpsMode" },
  ]);

  console.log(`\nMigrated ${result.modifiedCount} document(s).`);

  const remaining = await agentDefs.countDocuments({ [legacyField]: { $exists: true } });
  if (remaining > 0) {
    console.error(`ERROR: ${remaining} documents still have the legacy field. Migration incomplete.`);
    process.exit(1);
  }

  console.log("Done.");
} finally {
  await client.close();
}
