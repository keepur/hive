// scripts/check-bundle-runtime.mjs
/**
 * Bundle runtime smoke test — verifies the bundled CLI can actually execute.
 *
 * Runs:
 *   1. node pkg/cli.min.js --version  → must print "hive v<version>"
 *   2. node pkg/cli.min.js --help     → must print usage text
 *   3. node pkg/server.min.js (exits immediately without config — just checks it loads)
 *
 * Prereq: npm run bundle (pkg/ must exist)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PKG_DIR = "pkg";

if (!existsSync(PKG_DIR)) {
  console.error(`error: ${PKG_DIR}/ not found — run 'npm run bundle' first`);
  process.exit(1);
}

let failures = 0;

// Test 1: hive --version
try {
  const version = execFileSync(
    process.execPath,
    [resolve(PKG_DIR, "cli.min.js"), "--version"],
    { encoding: "utf-8", timeout: 10000 },
  ).trim();
  if (/^hive v\d+\.\d+\.\d+/.test(version)) {
    console.log(`  ✓ --version: ${version}`);
  } else {
    console.error(`  ✗ --version: unexpected output: ${version}`);
    failures++;
  }
} catch (err) {
  console.error(`  ✗ --version: ${err.message}`);
  failures++;
}

// Test 2: hive --help
try {
  const help = execFileSync(
    process.execPath,
    [resolve(PKG_DIR, "cli.min.js"), "--help"],
    { encoding: "utf-8", timeout: 10000 },
  ).trim();
  if (help.includes("hive <command>") && help.includes("init")) {
    console.log(`  ✓ --help: usage text present (${help.split("\n").length} lines)`);
  } else {
    console.error(`  ✗ --help: missing expected content`);
    failures++;
  }
} catch (err) {
  console.error(`  ✗ --help: ${err.message}`);
  failures++;
}

// Test 3: server.min.js loads (will fail on missing config, but should not crash on import)
try {
  // Run with a timeout — the server will try to connect to MongoDB and fail,
  // but it should at least load without syntax/import errors.
  // We expect a non-zero exit (no config), but NOT a syntax error or missing module.
  execFileSync(
    process.execPath,
    [resolve(PKG_DIR, "server.min.js")],
    { encoding: "utf-8", timeout: 10000, env: { ...process.env, NODE_ENV: "test" } },
  );
  // If it exits cleanly, that's fine too
  console.log("  ✓ server.min.js: loaded without crash");
} catch (err) {
  const stderr = err.stderr ?? "";
  const stdout = err.stdout ?? "";
  // SyntaxError or missing module/package means the bundle is broken
  if (
    stderr.includes("SyntaxError") ||
    stderr.includes("Cannot find module") ||
    stderr.includes("Cannot find package") ||
    stderr.includes("ERR_MODULE_NOT_FOUND")
  ) {
    console.error(`  ✗ server.min.js: bundle broken — ${stderr.slice(0, 200)}`);
    failures++;
  } else {
    // Expected: exits with error because no MongoDB/config — that's fine
    console.log("  ✓ server.min.js: loaded (exited on missing config — expected)");
  }
}

if (failures > 0) {
  console.error(`\n${failures} runtime check(s) failed.`);
  process.exit(1);
}

console.log("\nOK: Bundle runtime checks passed.");
