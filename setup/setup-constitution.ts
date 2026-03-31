#!/usr/bin/env npx tsx
/**
 * Render constitution template → MongoDB.
 * Reads setup/templates/constitution-{personal|business}.md.tpl, renders with
 * hive.yaml context, upserts to memory collection.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MongoClient } from "mongodb";
import { render } from "./template-renderer.ts";

const ROOT = resolve(import.meta.dirname, "..");
const HIVE_CONFIG = resolve(process.env.HIVE_CONFIG ?? join(ROOT, "hive.yaml"));

function loadConfig(): Record<string, any> {
  if (!existsSync(HIVE_CONFIG)) {
    console.error("hive.yaml not found.");
    process.exit(1);
  }
  return parseYaml(readFileSync(HIVE_CONFIG, "utf-8")) ?? {};
}

async function main() {
  const config = loadConfig();
  const instanceType = (config.instance?.type as string) ?? "business";

  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const instanceId = (config.instance?.id as string) ?? "hive";
  const mongoDb = process.env.MONGODB_DB || `hive_${instanceId}`;

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDb);

  // Build team map from agent_definitions in MongoDB
  const team: Record<string, string> = {};
  const agentDocs = await db.collection("agent_definitions").find({}, { projection: { _id: 1, name: 1 } }).toArray();
  for (const doc of agentDocs) {
    team[doc._id as string] = (doc as any).name ?? doc._id;
  }

  const constitutionFile =
    instanceType === "personal" ? "constitution-personal.md.tpl" : "constitution-business.md.tpl";
  const typedPath = join(ROOT, "setup", "templates", constitutionFile);
  const legacyPath = join(ROOT, "setup", "templates", "constitution.md.tpl");
  const constitutionTplPath = existsSync(typedPath) ? typedPath : legacyPath;

  if (!existsSync(constitutionTplPath)) {
    console.log("No constitution template found — skipping.");
    await client.close();
    return;
  }

  const constitutionTpl = readFileSync(constitutionTplPath, "utf-8");
  const content = render(constitutionTpl, { business: config.business ?? {}, team });

  const existing = await db.collection("memory").findOne({ path: "shared/constitution.md" });
  if (existing && existing.content !== content) {
    await db.collection("memory_versions").insertOne({
      path: "shared/constitution.md",
      content: existing.content,
      savedAt: existing.updatedAt,
      savedBy: existing.updatedBy || "system",
    });
    await db.collection("memory").updateOne(
      { path: "shared/constitution.md" },
      { $set: { content, updatedAt: new Date(), updatedBy: "setup:constitution" } },
    );
    console.log("  SYNC shared/constitution.md → MongoDB");
  } else if (!existing) {
    await db.collection("memory").insertOne({
      path: "shared/constitution.md",
      content,
      updatedAt: new Date(),
      updatedBy: "setup:constitution",
    });
    console.log("  SYNC shared/constitution.md → MongoDB (new)");
  } else {
    console.log("  SKIP shared/constitution.md — unchanged");
  }

  await client.close();
}

main().catch((err) => {
  console.error("Constitution setup failed:", err);
  process.exit(1);
});
