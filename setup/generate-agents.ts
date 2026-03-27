#!/usr/bin/env npx tsx
/**
 * Generate agent definitions from templates.
 * Reads hive.yaml for business context, renders agents-templates/ → agents/
 *
 * Usage:
 *   npx tsx setup/generate-agents.ts [--force]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, cpSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { render, fileHash } from "./template-renderer.ts";
import { MongoClient } from "mongodb";

const ROOT = resolve(import.meta.dirname, "..");
const TEMPLATES_DIR = join(ROOT, "agents-templates");
const AGENTS_DIR = resolve(process.env.AGENTS_PATH ?? join(ROOT, "agents"));
const HIVE_CONFIG = resolve(process.env.HIVE_CONFIG ?? join(ROOT, "hive.yaml"));
const META_FILE = join(ROOT, ".hive-generated.json");

const PLUGINS_DIR = join(ROOT, "plugins", "claude-code");
const PLUGIN_CACHE = join(homedir(), ".claude", "plugins", "cache");
const PLUGIN_MARKETPLACES = join(homedir(), ".claude", "plugins", "marketplaces");

interface SmsLine {
  id: string;
  label: string;
  number: string;
  slackChannel: string;
}

// Load hive.yaml
function loadConfig(): Record<string, any> {
  if (!existsSync(HIVE_CONFIG)) {
    console.error("hive.yaml not found. Run 'npm run setup' first.");
    process.exit(1);
  }
  return parseYaml(readFileSync(HIVE_CONFIG, "utf-8")) ?? {};
}

// Pre-process SMS-specific template directives, then delegate to shared render()
function renderAgent(template: string, ctx: Record<string, any>): string {
  // Handle {{#sms_section}}...{{/sms_section}} blocks (special: checks lines.length)
  template = template.replace(/\{\{#sms_section\}\}([\s\S]*?)\{\{\/sms_section\}\}/g, (_, block) => {
    const lines: SmsLine[] = ctx.sms?.lines ?? [];
    if (lines.length === 0) return "";
    return block;
  });

  // Replace {{sms_channels}} with list of channel names
  template = template.replace(/\{\{sms_channels\}\}/g, () => {
    const lines: SmsLine[] = ctx.sms?.lines ?? [];
    return lines.map((l) => `#${l.slackChannel}`).join(", ");
  });

  // Replace {{sms_lines_description}} with per-line descriptions
  template = template.replace(/\{\{sms_lines_description\}\}/g, () => {
    const lines: SmsLine[] = ctx.sms?.lines ?? [];
    return lines
      .map((l) => `Messages in \`#${l.slackChannel}\` are incoming SMS to ${l.label}'s number ${l.number}.`)
      .join("\n");
  });

  // Delegate remaining variable + conditional substitution to shared renderer
  return render(template, ctx);
}

function syncPlugins(): void {
  if (!existsSync(PLUGIN_CACHE) && !existsSync(PLUGIN_MARKETPLACES)) {
    console.log("\n  No plugin cache or marketplaces found — skipping plugin sync");
    return;
  }

  // Build index: plugin-name → source path (marketplaces take priority over cache)
  const pluginIndex = new Map<string, string>();

  // 1. Scan cache (versioned directories, pick latest by mtime)
  if (existsSync(PLUGIN_CACHE)) {
    const sourceRepos = readdirSync(PLUGIN_CACHE).filter((d) => statSync(join(PLUGIN_CACHE, d)).isDirectory());

    for (const repo of sourceRepos) {
      const repoDir = join(PLUGIN_CACHE, repo);
      const plugins = readdirSync(repoDir).filter((d) => statSync(join(repoDir, d)).isDirectory());

      for (const pluginName of plugins) {
        const pluginDir = join(repoDir, pluginName);
        const versions = readdirSync(pluginDir).filter((d) => statSync(join(pluginDir, d)).isDirectory());

        if (versions.length === 0) continue;

        // Pick latest by mtime
        const latest = versions
          .map((v) => ({ v, mtime: statSync(join(pluginDir, v)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0]!;

        pluginIndex.set(pluginName, join(pluginDir, latest.v));
      }
    }
  }

  // 2. Scan marketplaces (flat directories, override cache — always latest)
  if (existsSync(PLUGIN_MARKETPLACES)) {
    const marketplaces = readdirSync(PLUGIN_MARKETPLACES).filter((d) =>
      statSync(join(PLUGIN_MARKETPLACES, d)).isDirectory(),
    );

    for (const marketplace of marketplaces) {
      const marketplaceDir = join(PLUGIN_MARKETPLACES, marketplace);
      const plugins = readdirSync(marketplaceDir).filter((d) => statSync(join(marketplaceDir, d)).isDirectory());

      for (const pluginName of plugins) {
        if (pluginName.startsWith(".")) continue;
        const pluginPath = join(marketplaceDir, pluginName);
        // Only index if it looks like a plugin (has skills/ or .claude-plugin/)
        if (!existsSync(join(pluginPath, "skills")) && !existsSync(join(pluginPath, ".claude-plugin"))) continue;
        pluginIndex.set(pluginName, pluginPath);
      }
    }
  }

  // Ensure output dir exists
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  // Copy each indexed plugin into plugins/claude-code/<name>/
  let synced = 0;
  for (const [name, sourcePath] of pluginIndex) {
    // Validate: must contain skills/ dir or a manifest to be a real plugin
    const hasSkills = existsSync(join(sourcePath, "skills"));
    const hasManifest = existsSync(join(sourcePath, "plugin.json"));
    if (!hasSkills && !hasManifest) {
      console.log(`  SKIP plugin ${name} — no skills/ dir or plugin.json`);
      continue;
    }

    const destPath = join(PLUGINS_DIR, name);

    // Remove existing copy and replace
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }

    cpSync(sourcePath, destPath, { recursive: true });
    console.log(`  SYNC plugin ${name} ← ${sourcePath}`);
    synced++;
  }

  console.log(`\n  ${synced} plugin(s) synced to plugins/claude-code/`);
}

async function main() {
  const force = process.argv.includes("--force");
  const config = loadConfig();

  // Build template context
  const instanceType = (config.instance?.type as string) ?? "business";
  const ctx = {
    business: config.business ?? {},
    sms: config.sms ?? { lines: [] },
    quo: config.quo ?? {},
    instance: {
      id: (config.instance?.id as string) ?? "hive",
      type: instanceType,
      personal: instanceType === "personal",
      business: instanceType === "business",
    },
  };

  // Build team map: agentId → display name
  const agentConfigs: Record<string, any> = config.agents ?? {};
  const team: Record<string, string> = {};
  for (const [id, def] of Object.entries(agentConfigs)) {
    team[id] = (def as any).name ?? id;
  }

  // Load existing generation metadata
  let meta: Record<string, string> = {};
  if (existsSync(META_FILE)) {
    meta = JSON.parse(readFileSync(META_FILE, "utf-8"));
  }

  const newMeta: Record<string, string> = {};
  let generated = 0;
  let skipped = 0;

  // Core templates
  const coreAgents = readdirSync(TEMPLATES_DIR).filter((d) => statSync(join(TEMPLATES_DIR, d)).isDirectory());

  // Plugin templates (from enabled plugins in hive.yaml)
  const enabledPlugins: string[] = config.plugins ?? [];
  const pluginAgents: Array<{ id: string; templateDir: string }> = [];

  for (const pluginName of enabledPlugins) {
    const pluginTemplatesDir = join(ROOT, "plugins", pluginName, "agents-templates");
    if (!existsSync(pluginTemplatesDir)) continue;
    const templates = readdirSync(pluginTemplatesDir).filter((d) =>
      statSync(join(pluginTemplatesDir, d)).isDirectory(),
    );
    for (const t of templates) {
      if (coreAgents.includes(t)) {
        console.log(`  SKIP plugin/${pluginName}/${t} (conflicts with core template)`);
        continue;
      }
      pluginAgents.push({ id: t, templateDir: join(pluginTemplatesDir, t) });
    }
  }

  // Merge: core uses TEMPLATES_DIR, plugin uses own dir
  const configuredAgentIds = Object.keys(agentConfigs);
  const allCandidates = [...coreAgents.map((id) => ({ id, templateDir: join(TEMPLATES_DIR, id) })), ...pluginAgents];

  // If agents are explicitly listed in config, only generate those (+ plugin agents which are always included)
  const allAgents =
    configuredAgentIds.length > 0
      ? allCandidates.filter((a) => configuredAgentIds.includes(a.id) || pluginAgents.some((p) => p.id === a.id))
      : allCandidates;

  for (const { id: agentId, templateDir } of allAgents) {
    const agentDir = join(AGENTS_DIR, agentId);

    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }

    // Build per-agent context with agent identity and team roster
    const agentName = team[agentId] ?? agentId;
    const agentCtx = {
      ...ctx,
      agent: {
        name: agentName,
        name_lower: agentName.toLowerCase(),
        id: agentId,
      },
      team,
    };

    const entries = readdirSync(templateDir);
    const delegatePrompts: Record<string, string> = {};

    for (const entry of entries) {
      const srcPath = join(templateDir, entry);
      const stat = statSync(srcPath);

      // Handle delegate-prompts/ subdirectory
      if (stat.isDirectory()) {
        if (entry === "delegate-prompts") {
          const promptFiles = readdirSync(srcPath);
          for (const pf of promptFiles) {
            if (!pf.endsWith(".md") && !pf.endsWith(".md.tpl")) {
              console.log(`  SKIP delegate-prompts/${pf} (not .md or .md.tpl)`);
              continue;
            }
            const pfPath = join(srcPath, pf);
            const pfRaw = readFileSync(pfPath, "utf-8");
            const pfContent = pf.endsWith(".tpl") ? renderAgent(pfRaw, agentCtx) : pfRaw;
            // server name = filename without .md.tpl or .md
            const serverName = pf.replace(/\.md(\.tpl)?$/, "");
            delegatePrompts[serverName] = pfContent;
          }
        }
        continue;
      }

      const isTemplate = entry.endsWith(".tpl");
      const outName = isTemplate ? entry.slice(0, -4) : entry; // strip .tpl
      const outPath = join(agentDir, outName);
      const metaKey = `${agentId}/${outName}`;

      const raw = readFileSync(srcPath, "utf-8");
      const content = isTemplate ? renderAgent(raw, agentCtx) : raw;
      const hash = fileHash(content);
      newMeta[metaKey] = hash;

      // Check if output file exists and was modified by user
      if (existsSync(outPath) && !force) {
        const existing = readFileSync(outPath, "utf-8");
        const existingHash = fileHash(existing);
        const originalHash = meta[metaKey];

        if (originalHash && existingHash !== originalHash) {
          console.log(`  SKIP ${metaKey} (modified by user — use --force to overwrite)`);
          newMeta[metaKey] = existingHash; // preserve user's version in meta
          skipped++;
          continue;
        }
      }

      writeFileSync(outPath, content);
      console.log(`  WRITE ${metaKey}`);
      generated++;
    }

    // Inject delegatePrompts into agent.yaml if any were found
    if (Object.keys(delegatePrompts).length > 0) {
      const yamlPath = join(agentDir, "agent.yaml");
      if (existsSync(yamlPath)) {
        let yaml = readFileSync(yamlPath, "utf-8");
        // Strip existing delegatePrompts block for idempotent re-runs
        yaml = yaml.replace(/\ndelegatePrompts:[\s\S]*$/, "");
        // Build YAML block scalar entries
        const lines: string[] = ["delegatePrompts:"];
        for (const [server, prompt] of Object.entries(delegatePrompts)) {
          lines.push(`  ${server}: |`);
          // Strip trailing newline to avoid extra blank line in block scalar
          const promptLines = prompt.replace(/\n$/, "").split("\n");
          for (const line of promptLines) {
            lines.push(`    ${line}`);
          }
        }
        yaml += "\n" + lines.join("\n") + "\n";
        writeFileSync(yamlPath, yaml);
        console.log(`  INJECT ${agentId}/agent.yaml delegatePrompts: [${Object.keys(delegatePrompts).join(", ")}]`);
      }
    }
  }

  // Also add SMS channels to executive-assistant agent.yaml if SMS is configured
  const eaYamlPath = join(AGENTS_DIR, "executive-assistant", "agent.yaml");
  if (existsSync(eaYamlPath) && ctx.sms.lines.length > 0) {
    let yaml = readFileSync(eaYamlPath, "utf-8");
    const smsChannels = ctx.sms.lines.map((l: SmsLine) => l.slackChannel);
    for (const ch of smsChannels) {
      if (!yaml.includes(ch)) {
        yaml = yaml.replace(/^channels:\n/m, `channels:\n  - ${ch}\n`);
      }
    }
    writeFileSync(eaYamlPath, yaml);
  }

  // Render constitution and sync directly to MongoDB
  const constitutionFile =
    instanceType === "personal" ? "constitution-personal.md.tpl" : "constitution-business.md.tpl";
  // Fall back to legacy constitution.md.tpl if the typed file doesn't exist
  const typedPath = join(ROOT, "setup", "templates", constitutionFile);
  const legacyPath = join(ROOT, "setup", "templates", "constitution.md.tpl");
  const constitutionTplPath = existsSync(typedPath) ? typedPath : legacyPath;
  if (existsSync(constitutionTplPath)) {
    const constitutionTpl = readFileSync(constitutionTplPath, "utf-8");
    const constitutionCtx = { business: ctx.business, team };
    const content = render(constitutionTpl, constitutionCtx);

    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
    const mongoDb = process.env.MONGODB_DB || "hive";
    try {
      const client = new MongoClient(mongoUri);
      await client.connect();
      const db = client.db(mongoDb);

      const existing = await db.collection("memory").findOne({ path: "shared/constitution.md" });
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
            { $set: { content, updatedAt: new Date(), updatedBy: "setup:agents" } },
          );
        console.log("  SYNC shared/constitution.md → MongoDB");
      } else if (!existing) {
        await db.collection("memory").insertOne({
          path: "shared/constitution.md",
          content,
          updatedAt: new Date(),
          updatedBy: "setup:agents",
        });
        console.log("  SYNC shared/constitution.md → MongoDB (new)");
      }

      await client.close();
    } catch (err) {
      console.warn(`  WARN: Failed to sync constitution to MongoDB: ${err}`);
    }
  }

  // Sync Claude Code plugins from cache
  syncPlugins();

  // Save metadata
  writeFileSync(META_FILE, JSON.stringify(newMeta, null, 2) + "\n");

  console.log(`\nDone: ${generated} files generated, ${skipped} skipped`);
}

main();
