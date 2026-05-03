#!/usr/bin/env npx tsx
/**
 * Migrate agent definitions from files + override collections to agent_definitions.
 *
 * For each agent directory in agents/:
 * 1. Read agent.yaml, soul.md, system-prompt.md
 * 2. Read existing overrides from model_overrides, agent_config_overrides, prompt_overrides, schedule_overrides
 * 3. Merge into a single AgentDefinition document (overrides win over file values)
 * 4. Upsert into agent_definitions
 *
 * Usage: npm run migrate:agents [--dry-run]
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MongoClient } from "mongodb";
import type { AgentDefinition } from "../src/types/agent-definition.js";
import { AGENT_DEFINITION_DEFAULTS } from "../src/types/agent-definition.js";

const ROOT = resolve(import.meta.dirname, "..");
const AGENTS_DIR = resolve(process.env.AGENTS_PATH ?? join(ROOT, "agents"));
const DRY_RUN = process.argv.includes("--dry-run");

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const mongoDb = process.env.MONGODB_DB || "hive";

async function main() {
  if (!existsSync(AGENTS_DIR)) {
    console.log(`No agents/ directory found at ${AGENTS_DIR} — nothing to migrate.`);
    return;
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(mongoDb);

  // Load existing overrides
  const modelOverrides = await db.collection("model_overrides").find().toArray();
  const configOverrides = await db.collection("agent_config_overrides").find().toArray();
  const promptOverrides = await db.collection("prompt_overrides").find().toArray();
  const scheduleOverrides = await db.collection("schedule_overrides").find().toArray();

  const modelMap = new Map(
    modelOverrides.map((d: Record<string, unknown>) => [d.agentId as string, d.model as string]),
  );
  const configMap = new Map(configOverrides.map((d: Record<string, unknown>) => [d.agentId as string, d]));
  const promptMap = new Map(promptOverrides.map((d: Record<string, unknown>) => [d.agentId as string, d]));
  const scheduleMap = new Map(scheduleOverrides.map((d: Record<string, unknown>) => [d.agentId as string, d]));

  const agentDefs = db.collection("agent_definitions");
  const entries = readdirSync(AGENTS_DIR).filter((d) => statSync(join(AGENTS_DIR, d)).isDirectory());

  let migrated = 0;
  let skipped = 0;

  for (const dirName of entries) {
    const agentDir = join(AGENTS_DIR, dirName);
    const yamlPath = join(agentDir, "agent.yaml");

    if (!existsSync(yamlPath)) {
      console.log(`  SKIP ${dirName} — no agent.yaml`);
      skipped++;
      continue;
    }

    // Check if already migrated
    const existing = await agentDefs.findOne({
      _id: dirName as unknown as Record<string, never>,
    });
    if (existing) {
      console.log(`  SKIP ${dirName} — already exists in agent_definitions`);
      skipped++;
      continue;
    }

    // Read files
    const raw = parseYaml(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
    const soul = existsSync(join(agentDir, "soul.md")) ? readFileSync(join(agentDir, "soul.md"), "utf-8") : "";
    const systemPrompt = existsSync(join(agentDir, "system-prompt.md"))
      ? readFileSync(join(agentDir, "system-prompt.md"), "utf-8")
      : "";

    const agentId = (raw.id as string) || dirName;

    // Parse tiered servers
    const rawServers = raw.servers;
    let coreServers: string[];
    let delegateServers: string[];
    if (Array.isArray(rawServers)) {
      coreServers = rawServers as string[];
      delegateServers = [];
    } else if (rawServers && typeof rawServers === "object") {
      const tiered = rawServers as { core?: string[]; delegate?: string[] };
      coreServers = tiered.core ?? [];
      delegateServers = tiered.delegate ?? [];
    } else {
      coreServers = [];
      delegateServers = [];
    }

    // Build base definition
    const now = new Date();
    const def: AgentDefinition = {
      _id: agentId,
      name: (raw.name as string) || dirName,
      model: (modelMap.get(agentId) ?? (raw.model as string)) || "claude-sonnet-4-6",
      icon: (raw.icon as string) || "",
      channels: (raw.channels as string[]) || [],
      passiveChannels: (raw.passiveChannels as string[]) || [],
      keywords: (raw.keywords as string[]) || [],
      isDefault: (raw.isDefault as boolean) || false,
      coreServers,
      delegateServers,
      delegatePrompts: (raw.delegatePrompts as Record<string, string>) || {},
      plugins: (raw.plugins as string[]) || undefined,
      metadata: (raw.metadata as Record<string, unknown>) || undefined,
      soul,
      systemPrompt,
      schedule: (raw.schedule as AgentDefinition["schedule"]) || [],
      subscribe: (raw.subscribe as string[]) || [],
      budgetUsd: (raw.budgetUsd as number) || 10,
      maxTurns: (raw.maxTurns as number) || 200,
      maxConcurrent: (raw.maxConcurrent as number) || 3,
      timeoutMs: (raw.timeoutMs as number) || 300_000,
      disabled: (raw.disabled as boolean) || false,
      slackBot: (raw.slackBot as string) || undefined,
      roles: (raw.roles as string[]) ?? AGENT_DEFINITION_DEFAULTS.roles,
      createdAt: now,
      updatedAt: now,
      updatedBy: "migration",
    };

    // Apply config overrides (overrides win)
    const co = configMap.get(agentId) as Record<string, unknown> | undefined;
    if (co) {
      for (const field of [
        "channels",
        "passiveChannels",
        "keywords",
        "coreServers",
        "delegateServers",
        "plugins",
        "subscribe",
      ]) {
        const ov = (co[field] ?? (field === "coreServers" ? co.servers : undefined)) as
          | {
              replace?: string[];
              add?: string[];
              remove?: string[];
            }
          | undefined;
        if (!ov) continue;
        if (ov.replace) {
          (def as Record<string, unknown>)[field] = [...ov.replace];
        } else {
          const base = [...(((def as Record<string, unknown>)[field] as string[] | undefined) ?? [])];
          const added = ov.add ? [...base, ...ov.add.filter((v: string) => !base.includes(v))] : base;
          const result = ov.remove ? added.filter((v: string) => !ov.remove!.includes(v)) : added;
          (def as Record<string, unknown>)[field] = result;
        }
      }
      if (co.isDefault !== undefined) def.isDefault = co.isDefault as boolean;
      if (co.budgetUsd !== undefined) def.budgetUsd = co.budgetUsd as number;
      if (co.maxTurns !== undefined) def.maxTurns = co.maxTurns as number;
      if (co.maxConcurrent !== undefined) def.maxConcurrent = co.maxConcurrent as number;
      if (co.timeoutMs !== undefined) def.timeoutMs = co.timeoutMs as number;
      if (co.disabled !== undefined) def.disabled = co.disabled as boolean;
    }

    // Apply prompt overrides
    const po = promptMap.get(agentId) as Record<string, unknown> | undefined;
    if (po) {
      if (po.soul !== undefined) def.soul = po.soul as string;
      if (po.systemPrompt !== undefined) def.systemPrompt = po.systemPrompt as string;
    }

    // Apply schedule overrides
    const so = scheduleMap.get(agentId) as Record<string, unknown> | undefined;
    if (so) {
      if (so.schedule === null) {
        def.schedule = [];
      } else if (so.schedule) {
        def.schedule = so.schedule as AgentDefinition["schedule"];
      }
    }

    if (DRY_RUN) {
      console.log(`  DRY-RUN ${agentId}: ${def.name} (${def.model})`);
      console.log(`    channels: [${def.channels.join(", ")}]`);
      console.log(`    coreServers: [${def.coreServers.join(", ")}]`);
      console.log(`    disabled: ${def.disabled}`);
      console.log(`    schedule: ${def.schedule.length} jobs`);
    } else {
      await agentDefs.insertOne(def as unknown as Record<string, unknown>);
      console.log(`  MIGRATE ${agentId}: ${def.name} (${def.model})`);
    }
    migrated++;
  }

  console.log(`\n${DRY_RUN ? "DRY-RUN: " : ""}${migrated} agents migrated, ${skipped} skipped`);

  if (!DRY_RUN) {
    await agentDefs.createIndex({ channels: 1 });
    await agentDefs.createIndex({ disabled: 1 });
    console.log("Indexes created on agent_definitions");
  }

  await client.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
