#!/usr/bin/env npx tsx

/**
 * One-time migration: seed MongoDB memory collection from hive-memory repo files.
 * Usage: npx tsx scripts/seed-memory.ts
 */

import { MongoClient } from "mongodb";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_PATH = process.env.HIVE_MEMORY_PATH ?? resolve(process.env.HOME ?? "", "github/hive-memory");
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";

// Get all tracked files from the repo
const files = execSync(`git -C "${REPO_PATH}" ls-files`, { encoding: "utf-8" })
  .trim()
  .split("\n")
  .filter((f) => f && !f.startsWith("."));

console.log(`Found ${files.length} files in ${REPO_PATH}`);

const client = new MongoClient(MONGODB_URI);
await client.connect();
const db = client.db(MONGODB_DB);
const collection = db.collection("memory");

await collection.createIndex({ path: 1 }, { unique: true });

let inserted = 0;
let skipped = 0;

for (const file of files) {
  const content = await readFile(resolve(REPO_PATH, file), "utf-8");

  const existing = await collection.findOne({ path: file });
  if (existing) {
    console.log(`  SKIP ${file} (already exists)`);
    skipped++;
    continue;
  }

  await collection.insertOne({
    path: file,
    content,
    updatedAt: new Date(),
    updatedBy: "migration",
  });
  console.log(`  SEED ${file} (${content.length} chars)`);
  inserted++;
}

console.log(`\nDone: ${inserted} inserted, ${skipped} skipped`);
await client.close();
