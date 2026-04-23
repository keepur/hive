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
import { existsSync, mkdirSync, cpSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

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

// Test 4: bundle runs from a relocated .hive/pkg/ path (post-Phase-4 layout)
try {
  const scratch = resolve(tmpdir(), `hive-bundle-check-${Date.now()}`);
  const engine = resolve(scratch, ".hive");
  try {
    mkdirSync(engine, { recursive: true });
    // Copy the built package's pkg/ + siblings into .hive/ to match the deployed
    // shape. PKG_DIR is the relative root the other tests also use.
    cpSync(PKG_DIR, resolve(engine, "pkg"), { recursive: true });
    if (existsSync("seeds")) {
      cpSync("seeds", resolve(engine, "seeds"), { recursive: true });
    }
    if (existsSync("templates")) {
      cpSync("templates", resolve(engine, "templates"), { recursive: true });
    }
    if (existsSync("package.json")) {
      cpSync("package.json", resolve(engine, "package.json"));
    }

    // Symlink the repo's node_modules into .hive/node_modules so the bundle's
    // runtime externals resolve. In the real deployed shape, populateEngine /
    // fetch_engine runs `npm install --omit=dev` inside .hive/ to produce this;
    // for a runtime smoke test, the dev repo's node_modules is functionally
    // equivalent and cheap. This test's job is to catch caller-relative path
    // regressions inside the bundle — not to re-validate the install pipeline.
    const repoNodeModules = resolve(process.cwd(), "node_modules");
    if (existsSync(repoNodeModules)) {
      symlinkSync(repoNodeModules, resolve(engine, "node_modules"), "dir");
    }

    // Loading test, parallel to Test 3: run server.min.js from the relocated path.
    // We expect a non-zero exit (no config), but NOT a syntax error or missing
    // module/package — the goal is "the bundle still resolves its sibling paths
    // correctly from the new CWD," not "the server runs to steady state."
    const serverPath = resolve(engine, "pkg", "server.min.js");
    try {
      execFileSync(process.execPath, [serverPath], {
        encoding: "utf-8",
        timeout: 10000,
        env: { ...process.env, NODE_ENV: "test", HIVE_HOME: scratch },
      });
      console.log("  ✓ .hive/pkg/ layout: server.min.js loaded without crash");
    } catch (err) {
      const stderr = err.stderr ?? "";
      if (
        stderr.includes("SyntaxError") ||
        stderr.includes("Cannot find module") ||
        stderr.includes("Cannot find package") ||
        stderr.includes("ERR_MODULE_NOT_FOUND")
      ) {
        console.error(`  ✗ .hive/pkg/ layout: bundle broken — ${stderr.slice(0, 200)}`);
        failures++;
      } else {
        console.log("  ✓ .hive/pkg/ layout: server.min.js loaded (exited on missing config — expected)");
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} catch (err) {
  console.error(`  ✗ .hive/pkg/ layout: setup failed — ${err.message}`);
  failures++;
}

if (failures > 0) {
  console.error(`\n${failures} runtime check(s) failed.`);
  process.exit(1);
}

console.log("\nOK: Bundle runtime checks passed.");
