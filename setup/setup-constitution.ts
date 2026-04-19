#!/usr/bin/env npx tsx
/**
 * Render bootstrap constitution template → MongoDB.
 * Reads setup/templates/constitution-bootstrap.md.tpl, renders with
 * hive.yaml owner name, upserts to memory collection.
 *
 * Re-run safety: if Section 2 has been authored (by CoS during onboarding),
 * only Section 1 (preamble) is overwritten. Section 2 is preserved.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MongoClient } from "mongodb";
import { render } from "./template-renderer.ts";

const ROOT = resolve(import.meta.dirname, "..");
const HIVE_CONFIG = resolve(process.env.HIVE_CONFIG ?? join(ROOT, "hive.yaml"));
const SECTION_2_DELIMITER = "<!-- SECTION 2: OPERATIONAL -->";

function loadConfig(): Record<string, any> {
  if (!existsSync(HIVE_CONFIG)) {
    console.error("hive.yaml not found.");
    process.exit(1);
  }
  return parseYaml(readFileSync(HIVE_CONFIG, "utf-8")) ?? {};
}

async function main() {
  const config = loadConfig();

  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const instanceId = (config.instance?.id as string) ?? "hive";
  const mongoDb = process.env.MONGODB_DB || `hive_${instanceId}`;

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDb);

  const tplPath = join(ROOT, "setup", "templates", "constitution-bootstrap.md.tpl");
  if (!existsSync(tplPath)) {
    console.log("No bootstrap constitution template found — skipping.");
    await client.close();
    return;
  }

  const tpl = readFileSync(tplPath, "utf-8");
  const renderedBootstrap = render(tpl, { business: config.business ?? {} });

  // Re-run safety: preserve Section 2 if it was authored by CoS
  const existing = await db.collection("memory").findOne({ path: "shared/constitution.md" });
  let content: string;

  if (existing) {
    const delimiterIdx = existing.content.indexOf(SECTION_2_DELIMITER);
    if (delimiterIdx !== -1) {
      // Section 2 exists — preserve it, only replace Section 1
      const existingSection2 = existing.content.slice(delimiterIdx);
      const newSection1 = renderedBootstrap.slice(
        0,
        renderedBootstrap.indexOf(SECTION_2_DELIMITER),
      );
      content = newSection1 + existingSection2;
    } else {
      // No delimiter — pre-onboarding state, replace entirely
      content = renderedBootstrap;
    }
  } else {
    content = renderedBootstrap;
  }

  if (existing && existing.content !== content) {
    await db.collection("memory_versions").insertOne({
      path: "shared/constitution.md",
      content: existing.content,
      savedAt: existing.updatedAt,
      savedBy: existing.updatedBy || "system",
    });
    await db
      .collection("memory")
      .updateOne(
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
