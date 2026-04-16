# Build Pipeline Validation — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Validate that the `@keepur/hive` npm bundle is publish-ready — correct files ship, nothing forbidden leaks, the CLI actually runs from the bundled output, and CI catches regressions.

**Architecture:** The bundle pipeline is a two-stage process: `tsc` compiles `src/` → `dist/`, then `build/bundle.ts` (esbuild) minifies `dist/` → `pkg/`. The npm tarball ships `pkg/`, `seeds/`, `templates/`, and `scripts/honeypot`. This plan adds automated verification at each stage: tarball content audit (what ships), runtime smoke test (does it run), and CI integration (catch regressions).

**Tech Stack:** esbuild, npm pack, Node.js assert, Vitest

---

### Task 1: Add honeypot to package.json and clean up stale TODO

**Files:**
- Modify: `package.json:5-12`
- Modify: `build/bundle.ts:59`

- [ ] **Step 1:** Add `scripts/honeypot` to the `bin` field in `package.json` so it's available globally after `npm i -g`

In `package.json`, change:

```json
"bin": {
  "hive": "pkg/cli.min.js"
},
"files": [
  "pkg/",
  "seeds/",
  "templates/"
],
```

to:

```json
"bin": {
  "hive": "pkg/cli.min.js",
  "honeypot": "scripts/honeypot"
},
"files": [
  "pkg/",
  "seeds/",
  "templates/",
  "scripts/honeypot"
],
```

- [ ] **Step 2:** Remove the stale TODO in `build/bundle.ts` line 59

The comment says `// TODO: Add "setup/wizard": "dist/setup/wizard.js" once src/setup/wizard.ts is created (Task 7)`. The wizard now exists (`src/setup/wizard.ts`) and is already bundled into `pkg/cli.min.js` via the dynamic import chain: `cli.ts` → `setup/init.ts` → `wizard.ts`. esbuild inlines these dynamic imports. No separate entry point needed.

Replace the TODO block:

```typescript
// Main server
// TODO: Add "setup/wizard": "dist/setup/wizard.js" once src/setup/wizard.ts is created (Task 7)
await build({
  ...shared,
  entryPoints: {
    server: "dist/index.js",
  },
});
```

with:

```typescript
// Main server (wizard is bundled into cli.min.js via dynamic imports)
await build({
  ...shared,
  entryPoints: {
    server: "dist/index.js",
  },
});
```

- [ ] **Step 3:** Verify

Run: `npm pack --dry-run 2>&1 | grep honeypot`
Expected: `npm notice <size> scripts/honeypot`

Run: `bash -n scripts/honeypot && echo "syntax ok"`
Expected: `syntax ok`

Verify executable bit: `ls -la scripts/honeypot` should show `-rwxr-xr-x`.

- [ ] **Step 4:** Commit

```bash
git add package.json build/bundle.ts
git commit -m "chore(pkg): add honeypot to bin/files, remove stale wizard TODO"
```

---

### Task 2: Create tarball content audit script

**Files:**
- Create: `scripts/check-bundle-pack.mjs`

This script runs `npm pack --dry-run`, parses the output, and verifies the tarball contains exactly what it should — and nothing it shouldn't. It's the "what ships" guardrail complementing the existing "what strings" guardrail (`check-bundle-strings.mjs`).

- [ ] **Step 1:** Create `scripts/check-bundle-pack.mjs`

```javascript
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
  "templates/constitution.md.tpl",
  "scripts/honeypot",
];

// All MCP servers must be present
const expectedMcp = [
  "memory", "structured-memory", "contacts", "admin", "callback",
  "schedule", "github-issues", "linear", "clickup", "google",
  "keychain", "quo", "resend", "search-conversation",
  "background-task", "recall", "task", "event-bus", "team",
  "code-search", "code-task", "workflow", "voice",
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
```

- [ ] **Step 2:** Verify

Run: `node scripts/check-bundle-pack.mjs`
Expected output (approximately):
```
OK: 36 files, 1.7 MB compressed, 7.9 MB unpacked
  ✓ 30 required files present
  ✓ No forbidden paths
  ✓ CLI shebang present
```

- [ ] **Step 3:** Commit

```bash
git add scripts/check-bundle-pack.mjs
git commit -m "test(bundle): add tarball content audit script"
```

---

### Task 3: Create bundle runtime smoke test

**Files:**
- Create: `scripts/check-bundle-runtime.mjs`

Verifies the bundled CLI actually executes — not just that it builds. Runs `node pkg/cli.min.js --version` and `--help` to catch missing imports, broken externals, or runtime errors. This is the "does it run" guardrail.

- [ ] **Step 1:** Create `scripts/check-bundle-runtime.mjs`

```javascript
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
```

- [ ] **Step 2:** Verify

Run: `node scripts/check-bundle-runtime.mjs`
Expected output (approximately):
```
  ✓ --version: hive v0.1.0
  ✓ --help: usage text present (N lines)
  ✓ server.min.js: loaded (exited on missing config — expected)

OK: Bundle runtime checks passed.
```

- [ ] **Step 3:** Commit

```bash
git add scripts/check-bundle-runtime.mjs
git commit -m "test(bundle): add runtime smoke test for bundled CLI"
```

---

### Task 4: Wire bundle checks into npm scripts and CI

**Files:**
- Modify: `package.json:42-43`

Update the `check:bundle` npm script to run all three bundle checks in sequence: build the bundle, check for forbidden strings, audit tarball contents, and run runtime smoke tests.

- [ ] **Step 1:** Update `check:bundle` in `package.json`

Change:

```json
"check:bundle": "npm run bundle && node scripts/check-bundle-strings.mjs",
```

to:

```json
"check:bundle": "npm run bundle && node scripts/check-bundle-strings.mjs && node scripts/check-bundle-pack.mjs && node scripts/check-bundle-runtime.mjs",
```

- [ ] **Step 2:** Verify

Run: `npm run check:bundle`
Expected: All three checks pass sequentially — forbidden strings, tarball content, runtime smoke.

- [ ] **Step 3:** Commit

```bash
git add package.json
git commit -m "ci(bundle): wire tarball audit + runtime smoke into check:bundle"
```

---

### Task 5: End-to-end validation

No files to modify — this task runs the full pipeline and verifies everything works together.

- [ ] **Step 1:** Run the full check suite

Run: `npm run check`
Expected: typecheck, lint, format, and tests all pass.

- [ ] **Step 2:** Run the bundle check

Run: `npm run check:bundle`
Expected: bundle builds, all three guardrails pass.

- [ ] **Step 3:** Verify npm pack output one final time

Run: `npm pack --dry-run 2>&1 | grep "total files"`
Expected: `npm notice total files: 36` (35 + scripts/honeypot)

- [ ] **Step 4:** Commit (only if any fixups were needed)

```bash
git commit -m "fix(bundle): address validation findings"
```
