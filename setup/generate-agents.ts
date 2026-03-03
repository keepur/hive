#!/usr/bin/env npx tsx
/**
 * Generate agent definitions from templates.
 * Reads hive.yaml for business context, renders agents-templates/ → agents/
 *
 * Usage:
 *   npx tsx setup/generate-agents.ts [--force]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { render, fileHash } from "./template-renderer.ts";

const ROOT = resolve(import.meta.dirname, "..");
const TEMPLATES_DIR = join(ROOT, "agents-templates");
const AGENTS_DIR = join(ROOT, "agents");
const HIVE_CONFIG = join(ROOT, "hive.yaml");
const META_FILE = join(ROOT, ".hive-generated.json");

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
  template = template.replace(
    /\{\{#sms_section\}\}([\s\S]*?)\{\{\/sms_section\}\}/g,
    (_, block) => {
      const lines: SmsLine[] = ctx.sms?.lines ?? [];
      if (lines.length === 0) return "";
      return block;
    },
  );

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

function main() {
  const force = process.argv.includes("--force");
  const config = loadConfig();

  // Build template context
  const ctx = {
    business: config.business ?? {},
    sms: config.sms ?? { lines: [] },
    quo: config.quo ?? {},
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

  // Get list of template agents
  const agents = readdirSync(TEMPLATES_DIR).filter((d) =>
    statSync(join(TEMPLATES_DIR, d)).isDirectory(),
  );

  for (const agentId of agents) {
    const templateDir = join(TEMPLATES_DIR, agentId);
    const agentDir = join(AGENTS_DIR, agentId);

    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }

    // Build per-agent context with agent identity and team roster
    const agentCtx = {
      ...ctx,
      agent: {
        name: team[agentId] ?? agentId,
        id: agentId,
      },
      team,
    };

    const files = readdirSync(templateDir);
    for (const file of files) {
      const srcPath = join(templateDir, file);
      const isTemplate = file.endsWith(".tpl");
      const outName = isTemplate ? file.slice(0, -4) : file; // strip .tpl
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

  // Generate constitution if template exists and memory path is configured
  const constitutionTplPath = join(ROOT, "setup", "templates", "constitution.md.tpl");
  if (existsSync(constitutionTplPath)) {
    const memoryPath = (config.memory?.localPath ?? `${process.env.HOME}/hive-memory`).replace("~", process.env.HOME ?? "/tmp");
    const sharedDir = join(memoryPath, "shared");
    const constitutionOutPath = join(sharedDir, "constitution.md");

    if (existsSync(sharedDir)) {
      const constitutionTpl = readFileSync(constitutionTplPath, "utf-8");
      const constitutionCtx = { business: ctx.business, team };
      const content = render(constitutionTpl, constitutionCtx);

      // Check if user modified the constitution (respect their changes)
      const constitutionMetaKey = "shared/constitution.md";
      if (existsSync(constitutionOutPath) && !force) {
        const existing = readFileSync(constitutionOutPath, "utf-8");
        const existingHash = fileHash(existing);
        const originalHash = meta[constitutionMetaKey];
        if (originalHash && existingHash !== originalHash) {
          console.log(`  SKIP ${constitutionMetaKey} (modified by user — use --force to overwrite)`);
          newMeta[constitutionMetaKey] = existingHash;
        } else {
          writeFileSync(constitutionOutPath, content);
          newMeta[constitutionMetaKey] = fileHash(content);
          console.log(`  WRITE ${constitutionMetaKey}`);
        }
      } else {
        writeFileSync(constitutionOutPath, content);
        newMeta[constitutionMetaKey] = fileHash(content);
        console.log(`  WRITE ${constitutionMetaKey}`);
      }
    }
  }

  // Save metadata
  writeFileSync(META_FILE, JSON.stringify(newMeta, null, 2) + "\n");

  console.log(`\nDone: ${generated} files generated, ${skipped} skipped`);
}

main();
