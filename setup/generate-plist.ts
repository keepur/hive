#!/usr/bin/env npx tsx
/**
 * Generate the launchd plist for Hive with correct paths for this machine.
 *
 * Usage:
 *   npx tsx setup/generate-plist.ts
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SERVICE_DIR = join(ROOT, "service");
const PLIST_PATH = join(SERVICE_DIR, "com.hive.orchestrator.plist");
const LOGS_DIR = join(ROOT, "logs");

// Detect paths
const nodePath = execSync("which node", { encoding: "utf-8" }).trim();
const home = process.env.HOME ?? "/tmp";
const pathEnv = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

// Ensure directories exist
if (!existsSync(SERVICE_DIR)) mkdirSync(SERVICE_DIR, { recursive: true });
if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hive.orchestrator</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${ROOT}/dist/index.js</string>
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
  <string>${LOGS_DIR}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGS_DIR}/stderr.log</string>
</dict>
</plist>
`;

writeFileSync(PLIST_PATH, plist);
console.log(`Generated: ${PLIST_PATH}`);
console.log(`  Node: ${nodePath}`);
console.log(`  Working dir: ${ROOT}`);
console.log(`  Logs: ${LOGS_DIR}/`);
