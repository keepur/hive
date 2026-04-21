// scripts/check-bundle-pack.mjs
/**
 * Tarball content guardrail — fails CI if the npm pack output contains
 * forbidden paths or is missing required files.
 *
 * Runs: npm pack --dry-run --json
 * Checks:
 *   1. Required files present (CLI, server, MCP servers, seeds, templates, honeypot)
 *   2. Forbidden paths absent (src/, dist/, plugins/, .env, hive.yaml)
 *   3. Package size within bounds
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "pipe"],
});

const [packInfo] = JSON.parse(packOutput);
const files = packInfo.files.map((f) => f.path);

// --- Required files ---
const required = [
  "package.json",
  "pkg/cli.min.js",
  "pkg/server.min.js",
  "seeds/chief-of-staff/agent.yaml",
  "templates/constitution-bootstrap.md.tpl",
  "scripts/honeypot",
];

// All MCP servers must be present
const expectedMcp = [
  "memory", "structured-memory", "contacts", "admin", "callback",
  "schedule", "github-issues", "linear", "clickup", "google",
  "keychain", "quo", "resend", "search-conversation",
  "background-task", "recall", "task", "event-bus", "team",
  "code-search", "code-task", "workflow", "voice", "slack",
];
for (const mcp of expectedMcp) {
  required.push(`pkg/mcp/${mcp}.min.js`);
}

const missing = required.filter((r) => !files.includes(r));
if (missing.length > 0) {
  console.error("FAIL: Missing required files in tarball:");
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

// --- Forbidden paths ---
const forbidden = ["src/", "dist/", "plugins/", "node_modules/", ".env", "hive.yaml"];
const leaked = files.filter((f) => forbidden.some((p) => f.startsWith(p) || f === p));
if (leaked.length > 0) {
  console.error("FAIL: Forbidden paths in tarball:");
  for (const l of leaked) console.error(`  - ${l}`);
  process.exit(1);
}

// --- Shebang check ---
const cliContent = readFileSync(resolve("pkg", "cli.min.js"), "utf-8");
if (!cliContent.startsWith("#!/usr/bin/env node")) {
  console.error("FAIL: pkg/cli.min.js missing shebang (#!/usr/bin/env node)");
  process.exit(1);
}

// --- Size check (warn if > 5 MB compressed, fail if > 10 MB) ---
const sizeMB = packInfo.size / (1024 * 1024);
const unpackedMB = packInfo.unpackedSize / (1024 * 1024);
if (sizeMB > 10) {
  console.error(`FAIL: Tarball too large: ${sizeMB.toFixed(1)} MB (limit: 10 MB)`);
  process.exit(1);
}
if (sizeMB > 5) {
  console.warn(`WARN: Tarball size: ${sizeMB.toFixed(1)} MB (consider investigating)`);
}

console.log(`OK: ${files.length} files, ${sizeMB.toFixed(1)} MB compressed, ${unpackedMB.toFixed(1)} MB unpacked`);
console.log(`  ✓ ${required.length} required files present`);
console.log(`  ✓ No forbidden paths`);
console.log(`  ✓ CLI shebang present`);
