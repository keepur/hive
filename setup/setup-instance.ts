#!/usr/bin/env npx tsx
/**
 * Interactive first-time instance setup.
 *
 * Features:
 *   - Port scanning to auto-detect next available 100-port block
 *   - Existing instance detection (records current port usage)
 *   - Writes/updates the `instance` section in hive.yaml
 *
 * Safe to re-run — shows current values and asks to confirm.
 *
 * Usage:
 *   npm run setup
 *   npx tsx setup/setup-instance.ts
 */

import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const HIVE_YAML = resolve(ROOT, "hive.yaml");

/** Check if a port is in use (returns true if occupied). */
function isPortInUse(port: number): boolean {
  try {
    const result = execFileSync("lsof", ["-i", `:${port}`, "-t"], { encoding: "utf-8" }).trim();
    return result.length > 0;
  } catch {
    // lsof exits non-zero when no matches — port is free
    return false;
  }
}

/** Find the first available 100-port block starting from 3100. */
function findAvailableBlock(): number {
  for (let base = 3100; base <= 6400; base += 100) {
    const anyInUse = [0, 1, 2, 3].some((offset) => isPortInUse(base + offset));
    if (!anyInUse) return base;
  }
  return 3100; // fallback
}

/** Detect ports currently used by node processes in common Hive ranges (best effort). */
function detectCurrentPorts(): Record<string, number> | null {
  const detected: Record<string, number> = {};
  const portCandidates = [
    ...Array.from({ length: 4 }, (_, i) => 3100 + i),
    ...Array.from({ length: 4 }, (_, i) => 3200 + i),
    ...Array.from({ length: 4 }, (_, i) => 3300 + i),
  ];

  for (const port of portCandidates) {
    try {
      const pids = execFileSync("lsof", ["-i", `:${port}`, "-t"], { encoding: "utf-8" }).trim();
      if (!pids) continue;
      const pid = pids.split("\n")[0]!;
      const cmd = execFileSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf-8" }).trim();
      if (cmd === "node") {
        const offset = port % 100;
        if (offset === 0 && !detected.background) detected.background = port;
        else if (offset === 1 && !detected.recall) detected.recall = port;
        else if (offset === 2 && !detected.codeTask) detected.codeTask = port;
        else if (!detected.ws) detected.ws = port;
      }
    } catch {
      // ignore
    }
  }

  return Object.keys(detected).length > 0 ? detected : null;
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\nWelcome to Hive Setup.\n");

  // Load existing config if present
  let config: Record<string, any> = {};
  if (existsSync(HIVE_YAML)) {
    config = parseYaml(readFileSync(HIVE_YAML, "utf-8")) ?? {};
  }

  const currentId = config.instance?.id;
  const currentPorts = config.instance?.ports;
  const currentPortBase = config.instance?.portBase;

  if (currentId) {
    console.log(`Current instance: ${currentId}`);
    if (currentPorts) {
      console.log(
        `  Ports: bg=${currentPorts.background}, recall=${currentPorts.recall}, code-task=${currentPorts.codeTask}, ws=${currentPorts.ws}`,
      );
    } else if (currentPortBase) {
      console.log(`  Port base: ${currentPortBase}`);
    }
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

  // Prompt for instance type
  const currentType = config.instance?.type;
  const defaultType = currentType ?? "personal";
  const typeInput = await rl.question(`Instance type — "personal" or "business" [${defaultType}]: `);
  const instanceType = typeInput.trim() || defaultType;

  if (instanceType !== "personal" && instanceType !== "business") {
    console.error('Error: Instance type must be "personal" or "business".');
    process.exit(1);
  }

  // Port assignment
  let ports: Record<string, number>;

  if (currentPorts) {
    // Existing explicit ports — keep them
    ports = currentPorts;
    console.log(`\nKeeping existing port assignments.`);
  } else if (currentPortBase) {
    // Existing portBase — derive but allow WS to stay where it was
    ports = {
      background: currentPortBase,
      recall: currentPortBase + 1,
      codeTask: currentPortBase + 2,
      ws: currentPortBase + 3,
    };
    console.log(`\nDerived ports from portBase ${currentPortBase}.`);
  } else {
    // New instance — scan for available block
    console.log("\nScanning for available ports...");
    const detected = detectCurrentPorts();

    if (detected && Object.keys(detected).length >= 2) {
      console.log(`Detected running Hive services:`);
      for (const [name, port] of Object.entries(detected)) {
        console.log(`  ${name}: ${port}`);
      }
      const useDetected = await rl.question("\nUse these ports? [Y/n]: ");
      if (useDetected.trim().toLowerCase() !== "n") {
        ports = detected;
      } else {
        const availableBlock = findAvailableBlock();
        ports = {
          background: availableBlock,
          recall: availableBlock + 1,
          codeTask: availableBlock + 2,
          ws: availableBlock + 3,
        };
      }
    } else {
      const availableBlock = findAvailableBlock();
      console.log(`Next available port block: ${availableBlock}xx`);
      const portInput = await rl.question(`Port base (100-port block) [${availableBlock}]: `);
      const portBase = parseInt(portInput.trim() || String(availableBlock), 10);

      if (isNaN(portBase) || portBase < 1024 || portBase > 65400) {
        console.error("Error: Port base must be a number between 1024 and 65400.");
        process.exit(1);
      }

      ports = { background: portBase, recall: portBase + 1, codeTask: portBase + 2, ws: portBase + 3 };
    }
  }

  // Show summary
  console.log("\nInstance configuration:");
  console.log(`  ID:          ${instanceId}`);
  console.log(`  Type:        ${instanceType}`);
  console.log(
    `  Constitution: ${instanceType === "personal" ? "lightweight (trust-based)" : "full (team governance)"}`,
  );
  console.log(`  Database:    hive_${instanceId}`);
  console.log(
    `  Ports:       bg=${ports.background}, recall=${ports.recall}, code-task=${ports.codeTask}, ws=${ports.ws}`,
  );
  console.log(`  Tmp dirs:    /tmp/${instanceId}-code-tasks, /tmp/${instanceId}-bg-tasks`);
  console.log(`  Deploy dir:  ~/services/${instanceId}`);
  console.log(`  LaunchAgent: com.hive.${instanceId}.agent`);

  const confirm = await rl.question("\nWrite to hive.yaml? [Y/n]: ");
  if (confirm.trim().toLowerCase() === "n") {
    console.log("Aborted.");
    rl.close();
    return;
  }

  // Write to hive.yaml — use explicit ports, drop portBase
  config.instance = { id: instanceId, type: instanceType, ports };
  delete config.instance.portBase;
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
