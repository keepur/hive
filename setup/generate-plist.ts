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
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVICE_DIR = join(ROOT, "service");
const LOGS_DIR = join(ROOT, "logs");

const LABEL = "com.hive.agent";
const LABEL_LOGS = "com.hive.rotate-logs";

// Detect paths
const nodePath = execSync("which node", { encoding: "utf-8" }).trim();
const home = process.env.HOME ?? "/tmp";
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
  <string>${ROOT}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${home}</string>
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
console.log(`  Working dir: ${ROOT}`);
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
    <string>${ROOT}/service/rotate-logs.sh</string>
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
