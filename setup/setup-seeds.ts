#!/usr/bin/env npx tsx
/**
 * Import plugin agent seeds → agent_definitions (skip if exists).
 * Reads YAML seed files from plugins/<name>/agent-seeds/.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MongoClient } from "mongodb";
import type { AgentDefinition } from "../src/types/agent-definition.js";
import { AGENT_DEFINITION_DEFAULTS } from "../src/types/agent-definition.js";

const ROOT = resolve(import.meta.dirname, "..");
const HIVE_CONFIG = resolve(process.env.HIVE_CONFIG ?? join(ROOT, "hive.yaml"));

async function main() {
  const config = existsSync(HIVE_CONFIG) ? (parseYaml(readFileSync(HIVE_CONFIG, "utf-8")) ?? {}) : {};

  const enabledPlugins: string[] = (config as any).plugins ?? [];
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
  const instanceId = ((config as any).instance?.id as string) ?? "hive";
  const mongoDb = process.env.MONGODB_DB || `hive_${instanceId}`;

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDb);
  const agentDefs = db.collection("agent_definitions");

  let imported = 0;
  let skipped = 0;

  for (const pluginName of enabledPlugins) {
    const seedsDir = join(ROOT, "plugins", pluginName, "agent-seeds");
    if (!existsSync(seedsDir)) continue;

    const files = readdirSync(seedsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

    for (const file of files) {
      const raw = parseYaml(readFileSync(join(seedsDir, file), "utf-8")) as any;
      if (!raw?._id) {
        console.log(`  SKIP ${pluginName}/${file} — no _id field`);
        continue;
      }

      const existing = await agentDefs.findOne({ _id: raw._id });
      if (existing) {
        console.log(`  SKIP ${raw._id} — already exists`);
        skipped++;
        continue;
      }

      const now = new Date();
      const doc: AgentDefinition = {
        _id: raw._id,
        name: raw.name ?? raw._id,
        model: raw.model ?? "claude-sonnet-4-6",
        icon: raw.icon ?? AGENT_DEFINITION_DEFAULTS.icon,
        catches: raw.catches,
        channels: raw.channels ?? [],
        passiveChannels: raw.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
        keywords: raw.keywords ?? AGENT_DEFINITION_DEFAULTS.keywords,
        isDefault: raw.isDefault ?? false,
        coreServers: raw.coreServers ?? [],
        delegateServers: raw.delegateServers ?? [],
        delegatePrompts: raw.delegatePrompts ?? AGENT_DEFINITION_DEFAULTS.delegatePrompts,
        plugins: raw.plugins,
        metadata: raw.metadata,
        soul: raw.soul ?? "",
        systemPrompt: raw.systemPrompt ?? "",
        schedule: raw.schedule ?? AGENT_DEFINITION_DEFAULTS.schedule,
        subscribe: raw.subscribe,
        budgetUsd: raw.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
        maxTurns: raw.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
        maxConcurrent: raw.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent,
        timeoutMs: raw.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
        disabled: raw.disabled ?? false,
        slackBot: raw.slackBot,
        roles: raw.roles ?? AGENT_DEFINITION_DEFAULTS.roles,
        createdAt: now,
        updatedAt: now,
        updatedBy: `setup:seed:${pluginName}`,
      };

      await agentDefs.insertOne(doc as any);
      console.log(`  SEED ${raw._id} from ${pluginName}/${file}`);
      imported++;
    }
  }

  console.log(`\n${imported} seeds imported, ${skipped} skipped`);
  await client.close();
}

main().catch((err) => {
  console.error("Seed import failed:", err);
  process.exit(1);
});
