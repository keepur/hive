#!/usr/bin/env npx tsx
/**
 * Interactive first-time instance setup.
 *
 * Prompts for instance ID and port base, writes/updates the `instance` section
 * in hive.yaml. Safe to re-run — shows current values and asks to confirm.
 *
 * Usage:
 *   npm run setup
 *   npx tsx setup/setup-instance.ts
 */

import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const HIVE_YAML = resolve(ROOT, "hive.yaml");

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\nWelcome to Hive Setup.\n");

  // Load existing config if present
  let config: Record<string, any> = {};
  if (existsSync(HIVE_YAML)) {
    config = parseYaml(readFileSync(HIVE_YAML, "utf-8")) ?? {};
  }

  const currentId = config.instance?.id;
  const currentPortBase = config.instance?.portBase;

  if (currentId) {
    console.log(`Current instance: id=${currentId}, portBase=${currentPortBase}`);
    console.log("");
  }

  // Prompt for instance ID
  const defaultId = currentId ?? "dodi";
  const idInput = await rl.question(`Instance ID (lowercase, no spaces) [${defaultId}]: `);
  const instanceId = idInput.trim() || defaultId;

  if (!/^[a-z][a-z0-9-]*$/.test(instanceId)) {
    console.error("Error: Instance ID must be lowercase letters, numbers, and hyphens, starting with a letter.");
    process.exit(1);
  }

  // Prompt for port base
  const defaultPort = currentPortBase ?? 3100;
  const portInput = await rl.question(`Port base (100-port block) [${defaultPort}]: `);
  const portBase = parseInt(portInput.trim() || String(defaultPort), 10);

  if (isNaN(portBase) || portBase < 1024 || portBase > 65400) {
    console.error("Error: Port base must be a number between 1024 and 65400.");
    process.exit(1);
  }

  // Show summary
  console.log("\nInstance configuration:");
  console.log(`  ID:          ${instanceId}`);
  console.log(`  Database:    hive_${instanceId}`);
  console.log(`  Ports:       ${portBase}-${portBase + 3} (bg, recall, code-task, ws)`);
  console.log(`  Tmp dirs:    /tmp/${instanceId}-code-tasks, /tmp/${instanceId}-bg-tasks`);
  console.log(`  Deploy dir:  ~/services/${instanceId}`);
  console.log(`  LaunchAgent: com.hive.${instanceId}.agent`);

  const confirm = await rl.question("\nWrite to hive.yaml? [Y/n]: ");
  if (confirm.trim().toLowerCase() === "n") {
    console.log("Aborted.");
    rl.close();
    return;
  }

  // Write to hive.yaml
  config.instance = { id: instanceId, portBase };
  writeFileSync(HIVE_YAML, stringifyYaml(config, { lineWidth: 120 }));

  console.log("\n✓ Instance configured. Next steps:");
  console.log("  1. Edit .env with your Slack tokens and API keys");
  console.log("  2. npm run setup:agents    — generate agent configs");
  console.log("  3. npm run setup:plist     — generate LaunchAgent plists");
  console.log("  4. service/install.sh      — install and start service");
  console.log("");
  console.log("Note: Each Hive instance needs its own Slack app.");
  console.log("Create one at https://api.slack.com/apps and add the tokens to .env:");
  console.log("  SLACK_APP_TOKEN=xapp-...");
  console.log("  SLACK_BOT_TOKEN=xoxb-...");

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
