#!/usr/bin/env npx tsx
/**
 * Generate launchd plists for Hive with correct paths for this machine.
 *
 * Generates:
 *   service/com.hive.agent.plist      — main Hive service
 *   service/com.hive.rotate-logs.plist — daily log rotation
 *
 * Usage:
 *   npx tsx setup/generate-plist.ts
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");

// Load instance ID from hive.yaml
const hiveConfigPath = resolve(ROOT, process.env.HIVE_CONFIG ?? "hive.yaml");
let hiveConfig: Record<string, any> = {};
if (existsSync(hiveConfigPath)) {
  hiveConfig = parseYaml(readFileSync(hiveConfigPath, "utf-8")) ?? {};
}
const instanceId = (hiveConfig.instance?.id as string) ?? "hive";

const home = process.env.HOME ?? "/tmp";
const DEPLOY_DIR = process.env.HIVE_DEPLOY_DIR ?? resolve(home, "services", instanceId);
const SERVICE_DIR = join(ROOT, "service");
const LOGS_DIR = join(DEPLOY_DIR, "logs");

const LABEL = `com.hive.${instanceId}.agent`;
const LABEL_LOGS = `com.hive.${instanceId}.rotate-logs`;
const LABEL_DEPLOY = `com.hive.${instanceId}.deploy-check`;

// Detect paths
const nodePath = execSync("which node", { encoding: "utf-8" }).trim();
const pathEnv = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

// Ensure directories exist
if (!existsSync(SERVICE_DIR)) mkdirSync(SERVICE_DIR, { recursive: true });
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

// ── Main Hive service plist ────────────────────────────────────────

const hivePlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>dist/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${DEPLOY_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${home}</string>
    <key>DEPLOY_DIR</key>
    <string>${DEPLOY_DIR}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${LOGS_DIR}/hive.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGS_DIR}/hive.err</string>
</dict>
</plist>
`;

const hivePlistPath = join(SERVICE_DIR, `${LABEL}.plist`);
writeFileSync(hivePlistPath, hivePlist);
console.log(`Generated: ${hivePlistPath}`);
console.log(`  Label: ${LABEL}`);
console.log(`  Node: ${nodePath}`);
console.log(`  Working dir: ${DEPLOY_DIR}`);
console.log(`  Logs: ${LOGS_DIR}/`);

// ── Log rotation plist ─────────────────────────────────────────────

const rotatePlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_LOGS}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${DEPLOY_DIR}/service/rotate-logs.sh</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOGS_DIR}/rotate-logs.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGS_DIR}/rotate-logs.log</string>
</dict>
</plist>
`;

const rotatePlistPath = join(SERVICE_DIR, `${LABEL_LOGS}.plist`);
writeFileSync(rotatePlistPath, rotatePlist);
console.log(`Generated: ${rotatePlistPath}`);
console.log(`  Label: ${LABEL_LOGS}`);

// ── Deploy checker plist ──────────────────────────────────────────

const deployCheckPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_DEPLOY}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${DEPLOY_DIR}/service/deploy-check.sh</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>

  <key>StartInterval</key>
  <integer>300</integer>

  <key>StandardOutPath</key>
  <string>${LOGS_DIR}/deploy-check.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGS_DIR}/deploy-check.log</string>
</dict>
</plist>
`;

const deployCheckPlistPath = join(SERVICE_DIR, `${LABEL_DEPLOY}.plist`);
writeFileSync(deployCheckPlistPath, deployCheckPlist);
console.log(`Generated: ${deployCheckPlistPath}`);
console.log(`  Label: ${LABEL_DEPLOY}`);
