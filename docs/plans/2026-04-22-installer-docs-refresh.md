# Installer / Docs Refresh Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Ticket:** [KPR-54](https://linear.app/keepur/issue/KPR-54) (Phase 4 of KPR-50, v0.2.0)
**Spec:** [2026-04-21-installer-docs-refresh-design.md](../specs/2026-04-21-installer-docs-refresh-design.md)
**Depends on:** [KPR-52](https://linear.app/keepur/issue/KPR-52) (engine in `.hive/`) and [KPR-53](https://linear.app/keepur/issue/KPR-53) (deploy flow rewrite) — both must be merged to `deploy` before this lands, because the fresh-install path this plan writes is predicated on the post-Phase-3 state.
**Branch:** `kpr-54` (branch from `deploy` after KPR-53 is merged)

**Goal:** A fresh beta customer's `curl | bash` → `hive init` produces a working 0.2.0 instance in the new layout. Every public doc describes that layout consistently. `hive update` and `hive rollback` (from Phase 3) are documented and tested from the customer CLI.

**Architecture:** One new source file (`src/setup/populate-engine.ts`) + one wizard call-site edit is the core code change. Everything else is documentation (internal + public). CI is already wired for `check:bundle` — verification pass only. The wizard runs `populateEngine(pkgRoot, targetDir)` (the instance root) only when `isBundled === true`, which copies `pkg/`, `seeds/`, `templates/`, `scripts/honeypot`, `package.json` from the running CLI into `<instance>/.hive/`. Non-bundled dev installs skip this — they run the engine in-place from `~/github/hive/`.

**Tech Stack:** TypeScript strict, Node 24, Vitest, GitHub Actions.

---

## File Structure

### New files
- `src/setup/populate-engine.ts` — `populateEngine(pkgRoot, instanceDir)` that copies the engine into `<instance>/.hive/`.
- `src/setup/populate-engine.test.ts` — vitest coverage for the populate function.

### Modified files
- `src/setup/wizard.ts` — insert a new `section("Engine") { populateEngine(...) }` block in the `isBundled === true` path. Placement: after the closing brace of the existing `if (!isBundled) { section("Deploy"); ... }` block (line 479) and before `section("Service")` (line 482). Memory/MongoDB (step 7) runs before either at line 434; Service is step 10.
- `scripts/check-bundle-runtime.mjs` — add a test case that runs `pkg/server.min.js` from a `.hive/pkg/` path and asserts it loads without resolution errors.
- `.github/workflows/ci.yml` — verification-only pass. The existing `Bundle decontamination check` step already runs `npm run check:bundle`; confirm it's present and no change is needed. If absent, add it.
- `install/bootstrap.sh` — add `HIVE_VERSION` env var support for pinned installs.
- `docs/getting-started.md` — path references, "where is my instance" paragraph.
- `docs/managing-your-hive.md` — path references, verify plugin/skill CLI sections.
- `docs/troubleshooting.md` — path references throughout.
- `docs/architecture.md` — directory layout section.
- `docs/onboarding-email.md` — audit only (expected: no change).
- `CLAUDE.md` — rewrite the "Dev vs Deploy" section.

### Not touched
- `package.json` `files`, `bin`, or publish config — already correct per Phase 2.
- `.github/workflows/publish.yml` — unchanged.
- `src/*` outside `setup/populate-engine.ts` and `setup/wizard.ts` — verification-only pass on `cli/plugin.ts` and `cli/skill.ts` (expected: already correct if Phase 2 was thorough; no change if so).
- `scripts/publish-docs.sh` — no file moves, still works as-is.
- License.
- Publishing 0.2.0 to npm — that happens in the Phase 3 deploy dry run and Phase 5 cutover.

### Precondition check
- KPR-52 (engine in `.hive/`) merged to `deploy`.
- KPR-53 (deploy flow rewrite) merged to `deploy`. Verify `hive update --help` or `cat src/cli/update.ts` shows the new shell-out shape, not the old `npm update -g` shape.
- `~/build/hive/pkg/server.min.js` exists (bundle produced by Phase 3's build phase).

---

## Task 1: Create `src/setup/populate-engine.ts`

**Files:**
- Create: `src/setup/populate-engine.ts`

This is the core new code. Mirrors the tarball shape Phase 3's `fetch_engine` produces — so a fresh `hive init` and an upgrade `hive update` land on byte-identical `.hive/` layouts.

- [ ] **Step 1:** Create the file.

```typescript
import { existsSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";

/**
 * Entries mirror package.json `files` plus package.json itself (which npm
 * always includes in a pack tarball but isn't listed in `files`). One path
 * per line. `scripts/honeypot` is a single binary (not the whole scripts/
 * dir), so the rsync must operate on that exact path.
 *
 * Must match Phase 3's `fetch_engine` tarball shape byte-for-byte so `hive
 * update` and `hive init` land on identical `.hive/` layouts. If the package
 * `files` field changes, update both here and deploy.sh's fetch_engine at
 * the same time.
 */
export const PACKAGE_ENTRIES = [
  "pkg",
  "seeds",
  "templates",
  "scripts/honeypot",
  "package.json",
] as const;

/**
 * Copies the running CLI's package contents into `<instance>/.hive/`.
 * Intended for the `hive init` wizard's bundled path only — non-bundled
 * dev installs have no `pkg/` to copy.
 *
 * Throws if `.hive/` already exists: the wizard's upstream `existingInstall()`
 * check is scoped to `hive.yaml`; this is defense-in-depth to avoid silently
 * clobbering a partially-populated engine dir.
 */
export function populateEngine(pkgRoot: string, instanceDir: string): void {
  const engineDir = resolve(instanceDir, ".hive");
  if (existsSync(engineDir)) {
    throw new Error(
      `Engine already populated at ${engineDir}. If this is a resume after an ` +
        `interrupted init, rm -rf ${engineDir} and re-run 'hive init'. ` +
        `populateEngine does not silently overwrite.`,
    );
  }
  mkdirSync(engineDir, { recursive: true });

  for (const entry of PACKAGE_ENTRIES) {
    const src = resolve(pkgRoot, entry);
    if (!existsSync(src)) continue;
    const dst = resolve(engineDir, entry);
    mkdirSync(dirname(dst), { recursive: true });

    const isDir = statSync(src).isDirectory();
    const srcArg = isDir ? `${src}/` : src;
    const dstArg = isDir ? `${dst}/` : dst;
    if (isDir) mkdirSync(dst, { recursive: true });
    execFileSync("rsync", ["-a", srcArg, dstArg]);
  }
}
```

Four correctness notes (repeated from spec for implementer reference — if you find yourself deleting any of these, stop and re-read):

1. **`scripts/honeypot` not `scripts/`**: `package.json` `files` ships the single honeypot binary, not the whole scripts/ dir.
2. **Parent dir creation**: `mkdirSync(dirname(dst))` before each rsync so nested paths like `scripts/honeypot` land correctly.
3. **rsync trailing-slash semantics**: trailing `/` on src means "copy contents"; no trailing slash means "copy as a file." The `isDir` branch handles both.
4. **rsync availability**: macOS ships `/usr/bin/rsync`. No special handling.

- [ ] **Step 2:** Verify

```bash
npx tsc --noEmit -p .
```
Expected: exits 0.

- [ ] **Step 3:** Don't commit yet — Task 2's tests land with this module.

---

## Task 2: Write `src/setup/populate-engine.test.ts`

**Files:**
- Create: `src/setup/populate-engine.test.ts`

- [ ] **Step 1:** Create the file.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { populateEngine, PACKAGE_ENTRIES } from "./populate-engine.js";

function makeFakePkgRoot(): string {
  const root = resolve(
    tmpdir(),
    `hive-populate-src-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "server.min.js"), "// server bundle");
  writeFileSync(join(root, "pkg", "cli.min.js"), "// cli bundle");
  mkdirSync(join(root, "seeds"), { recursive: true });
  writeFileSync(join(root, "seeds", "dodi.seed.ts"), "export {};");
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "templates", "hive.yaml.example"), "instance: {}\n");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "honeypot"), "#!/usr/bin/env bash\necho x\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@keepur/hive", version: "0.2.0" }));
  return root;
}

function makeInstanceDir(): string {
  const dir = resolve(
    tmpdir(),
    `hive-populate-dst-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("populateEngine", () => {
  let pkgRoot: string;
  let instanceDir: string;

  beforeEach(() => {
    pkgRoot = makeFakePkgRoot();
    instanceDir = makeInstanceDir();
  });

  afterEach(() => {
    rmSync(pkgRoot, { recursive: true, force: true });
    rmSync(instanceDir, { recursive: true, force: true });
  });

  it("creates .hive/ and copies each PACKAGE_ENTRIES member", () => {
    populateEngine(pkgRoot, instanceDir);
    const engine = resolve(instanceDir, ".hive");
    expect(existsSync(engine)).toBe(true);
    expect(existsSync(join(engine, "pkg", "server.min.js"))).toBe(true);
    expect(existsSync(join(engine, "pkg", "cli.min.js"))).toBe(true);
    expect(existsSync(join(engine, "seeds", "dodi.seed.ts"))).toBe(true);
    expect(existsSync(join(engine, "templates", "hive.yaml.example"))).toBe(true);
    expect(existsSync(join(engine, "scripts", "honeypot"))).toBe(true);
    expect(existsSync(join(engine, "package.json"))).toBe(true);
  });

  it("places scripts/honeypot at .hive/scripts/honeypot (not flattened)", () => {
    populateEngine(pkgRoot, instanceDir);
    const dst = resolve(instanceDir, ".hive", "scripts", "honeypot");
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, "utf-8")).toContain("honeypot");
    // No sibling at .hive/honeypot — parent-dir logic must not flatten.
    expect(existsSync(resolve(instanceDir, ".hive", "honeypot"))).toBe(false);
  });

  it("package.json content round-trips", () => {
    populateEngine(pkgRoot, instanceDir);
    const pkg = JSON.parse(
      readFileSync(resolve(instanceDir, ".hive", "package.json"), "utf-8"),
    );
    expect(pkg.name).toBe("@keepur/hive");
    expect(pkg.version).toBe("0.2.0");
  });

  it("throws if .hive/ is already populated", () => {
    populateEngine(pkgRoot, instanceDir);
    expect(() => populateEngine(pkgRoot, instanceDir)).toThrow(
      /Engine already populated/,
    );
  });

  it("silently skips missing entries (dev install without bundle)", () => {
    rmSync(join(pkgRoot, "pkg"), { recursive: true, force: true });
    populateEngine(pkgRoot, instanceDir);
    const engine = resolve(instanceDir, ".hive");
    expect(existsSync(join(engine, "pkg", "server.min.js"))).toBe(false);
    // Still copies what's available
    expect(existsSync(join(engine, "seeds"))).toBe(true);
    expect(existsSync(join(engine, "package.json"))).toBe(true);
  });

  it("copies directories as directories (not as files)", () => {
    populateEngine(pkgRoot, instanceDir);
    const pkgDir = resolve(instanceDir, ".hive", "pkg");
    expect(statSync(pkgDir).isDirectory()).toBe(true);
    const seedsDir = resolve(instanceDir, ".hive", "seeds");
    expect(statSync(seedsDir).isDirectory()).toBe(true);
  });

  it("PACKAGE_ENTRIES matches the tarball shape exactly", () => {
    // If this test fails, the deploy.sh fetch_engine rsync fallback also needs updating.
    expect(PACKAGE_ENTRIES).toEqual([
      "pkg",
      "seeds",
      "templates",
      "scripts/honeypot",
      "package.json",
    ]);
  });
});
```

- [ ] **Step 2:** Verify

```bash
npx vitest run src/setup/populate-engine.test.ts
```
Expected: all 7 tests pass.

- [ ] **Step 3:** Commit (Tasks 1 + 2 together — module + tests land atomically).

```bash
git checkout -b kpr-54
git add src/setup/populate-engine.ts src/setup/populate-engine.test.ts
git commit -m "feat(setup): populateEngine copies CLI package into .hive/ for fresh installs (KPR-54)"
```

---

## Task 3: Wire `populateEngine` into the `hive init` wizard

**Files:**
- Modify: `src/setup/wizard.ts` (insertion point at ~line 479, between the `!isBundled` deploy block and the `section("Service")` call)

- [ ] **Step 1:** Add the import. Find the existing imports at the top of `src/setup/wizard.ts` and add:

```typescript
import { populateEngine } from "./populate-engine.js";
```

Place it alphabetically near other `./` relative imports.

- [ ] **Step 2:** Find the insertion point. At around line 479, the `if (!isBundled) { section("Deploy"); ... }` block closes. Immediately after its closing brace, before `section("Service")`, add:

Find:

```typescript
  // ── 9. Deploy ──────────────────────────────────────────────────────
  if (!isBundled) {
    section("Deploy");

    const deployDir = join(process.env.HOME ?? "/tmp", "services", "hive");
    const deployExists = existsSync(join(deployDir, "package.json"));

    if (deployExists) {
      console.log(`Deploy directory exists: ${deployDir}`);
      const redeploy = await confirm("Sync latest build and config?", true);
      if (redeploy) {
        await doDeploy(deployDir, pkgRoot);
      } else {
        console.log("  ✓ Skipped");
      }
    } else {
      console.log("Hive runs from a separate deploy directory (not this dev repo).");
      console.log(`  Dev:    ${pkgRoot}`);
      console.log(`  Deploy: ${deployDir}`);
      console.log("");
      const setupDeploy = await confirm("Set up the deploy directory now?", true);
      if (setupDeploy) {
        await doDeploy(deployDir, pkgRoot);
      }
    }
  }

  // ── 10. Service ───────────────────────────────────────────────────
  section("Service");
```

Replace with:

```typescript
  // ── 9. Deploy (dev only) ───────────────────────────────────────────
  if (!isBundled) {
    section("Deploy");

    const deployDir = join(process.env.HOME ?? "/tmp", "services", "hive");
    const deployExists = existsSync(join(deployDir, "package.json"));

    if (deployExists) {
      console.log(`Deploy directory exists: ${deployDir}`);
      const redeploy = await confirm("Sync latest build and config?", true);
      if (redeploy) {
        await doDeploy(deployDir, pkgRoot);
      } else {
        console.log("  ✓ Skipped");
      }
    } else {
      console.log("Hive runs from a separate deploy directory (not this dev repo).");
      console.log(`  Dev:    ${pkgRoot}`);
      console.log(`  Deploy: ${deployDir}`);
      console.log("");
      const setupDeploy = await confirm("Set up the deploy directory now?", true);
      if (setupDeploy) {
        await doDeploy(deployDir, pkgRoot);
      }
    }
  }

  // ── 9.5. Engine (bundled only) ─────────────────────────────────────
  // For customer installs where the CLI was installed from npm, copy the
  // package contents into <instance>/.hive/ so the service points at
  // instance-local engine code. Dev installs (`npm run dev` from a git
  // checkout) skip this — the engine runs from the checkout directly.
  if (isBundled) {
    section("Engine");
    const engineDir = resolve(targetDir, ".hive");
    if (existsSync(engineDir)) {
      console.log(`  Engine already populated at ${engineDir}. Skipping.`);
    } else {
      populateEngine(pkgRoot, targetDir);
      console.log(`  ✓ Engine populated at ${engineDir}`);
    }
  }

  // ── 10. Service ───────────────────────────────────────────────────
  section("Service");
```

Three callouts:

1. **`resolve` must be available** — `src/setup/wizard.ts` likely already imports it from `node:path`. If not, add `resolve` to the existing `import { ... } from "node:path"` line.
2. **`targetDir` is the instance root** — `runWizard(targetDir, templatesDir, pkgRoot)` declares it as the first arg, and everything else in the wizard uses it consistently (`ENV_PATH = join(targetDir, ".env")`, etc.).
3. **The pre-check on `existsSync(engineDir)`** is a wizard-level courtesy: if the user is resuming after a crash, the `populateEngine` throw would make the error noisy. The wizard's "already populated, skipping" is friendlier. `populateEngine` still throws as the defense-in-depth layer — both checks are useful.

- [ ] **Step 3:** Verify

```bash
npx tsc --noEmit -p .
```
Expected: exits 0.

Run the wizard's unit tests if any exist:

```bash
npx vitest run src/setup/ 2>&1 | tail -20
```
Expected: passes (existing wizard tests don't exercise the new section; this is coverage for Task 2's file).

- [ ] **Step 4:** Commit

```bash
git add src/setup/wizard.ts
git commit -m "feat(wizard): call populateEngine for bundled installs (KPR-54)"
```

---

## Task 4: Extend `scripts/check-bundle-runtime.mjs` for CWD-shifted case

**Files:**
- Modify: `scripts/check-bundle-runtime.mjs`

The existing script tests that the bundle runs from its package-root location (Tests 1-3). We need to verify it also loads correctly when relocated to a `.hive/pkg/` path — that's where the engine lives in the deployed shape.

- [ ] **Step 1:** Read the existing file first to confirm current shape.

```bash
cat scripts/check-bundle-runtime.mjs
```

Existing state (as of this writing): 97 lines, top-level imports of `execFileSync`, `existsSync`, `resolve`. A module-level `const PKG_DIR = "pkg"` (relative path, not a resolved absolute root). Three sequential tests (no helper functions), each wrapped in try/catch, incrementing a `failures` counter, ending with a `process.exit(failures > 0 ? 1 : 0)`-style check.

- [ ] **Step 2:** Extend the top-level imports with `mkdirSync, cpSync, rmSync` and `tmpdir`. The existing `resolve` import stays — reuse it. Change:

```javascript
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
```

to:

```javascript
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
```

- [ ] **Step 3:** Add a new Test 4 before the final `if (failures > 0)` block. The test follows the same try/catch + `failures++` pattern as Tests 1-3 — don't wrap in a helper function; the script's style is procedural.

Insert immediately before the `if (failures > 0)` block (currently line 91):

```javascript
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
```

Why this shape:
- `PKG_DIR` (the script's existing const) is `"pkg"` relative to cwd — reuse it directly as the cpSync source, same way Tests 1-3 do.
- The "loaded without crash OR exited with recognizable missing-config error" oracle mirrors Test 3 exactly. Spec §4 frames this as "each [`import.meta.url` lookup] resolves to the bundle's location, not to a caller-relative path" — a module-not-found stderr would be a caller-relative regression, which this catches.
- No `--version` flag assumption: `server.min.js` is `src/index.ts` bundled and doesn't implement `--version`. Only `cli.min.js` does.

- [ ] **Step 4:** Verify the test passes against a fresh build.

```bash
npm run build && npm run bundle
npm run check:bundle
```
Expected: existing Test 1/2/3 lines plus a new `.hive/pkg/ layout: server.min.js loaded ...` line. If Test 4 stderr-grep flags a module resolution failure, that's a real bundle bug — stop and investigate before papering over it.

- [ ] **Step 5:** Commit

```bash
git add scripts/check-bundle-runtime.mjs
git commit -m "test(bundle): verify bundle runs from .hive/pkg/ layout (KPR-54)"
```

---

## Task 5: Verify `check:bundle` is wired into CI

**Files:**
- Read-only (verification pass): `.github/workflows/ci.yml`

Spec §4 calls for `check:bundle` to run on every CI push so a bundle regression can't ship silently. At the time this plan was written, `.github/workflows/ci.yml` already contains that step (`Bundle decontamination check: run: npm run check:bundle`, after the Test step). This task is a verification-only pass.

- [ ] **Step 1:** Read `.github/workflows/ci.yml` and confirm a `run: npm run check:bundle` line is present inside the main `check` job's steps.

```bash
grep -n 'check:bundle' .github/workflows/ci.yml
```

Expected: exactly one match, inside the `check` job, after the `Test` step.

- [ ] **Step 2:** Confirm the `npm run check:bundle` npm script in `package.json` still runs `check-bundle-runtime.mjs`.

```bash
grep -n '"check:bundle"' package.json
```

Expected: the script includes `node scripts/check-bundle-runtime.mjs` in its chain (`npm run bundle && ... && node scripts/check-bundle-runtime.mjs`). If it doesn't, stop and flag — the new Test 4 from Task 4 would never run in CI, which defeats the purpose.

- [ ] **Step 3:** If both check out, no commit. Note the verification in Task 16's final PR body. If either check failed, either (a) the CI step was removed after this plan was written → re-add it with a step named `Bundle runtime check` invoking `npm run check:bundle` after the `Test` step, then commit with `ci: re-wire check:bundle after regression (KPR-54)`, or (b) the npm script drifted → fix it with a matching commit.

- [ ] **Step 4:** No commit expected. Skip to Task 6.

---

## Task 6: Add `HIVE_VERSION` support to `install/bootstrap.sh`

**Files:**
- Modify: `install/bootstrap.sh`

Lets us point beta customers at a specific version during the 0.2.0 rollout window without publishing a new default. Default (no env var) is unchanged.

- [ ] **Step 1:** Read the current bootstrap.sh.

```bash
cat install/bootstrap.sh
```

- [ ] **Step 2:** Find the `npm i -g @keepur/hive` line and replace.

Find:

```bash
npm i -g @keepur/hive
```

Replace with:

```bash
npm i -g "@keepur/hive@${HIVE_VERSION:-latest}"
```

- [ ] **Step 3:** Verify

```bash
bash -n install/bootstrap.sh
```
Expected: syntax OK.

Optional manual check:

```bash
HIVE_VERSION=0.2.0 bash -x install/bootstrap.sh 2>&1 | grep "npm i -g"
```
(The `bash -x` trace should show the expanded `@keepur/hive@0.2.0` string before any real install runs. Ctrl-C before the script commits to system changes.)

- [ ] **Step 4:** Commit

```bash
git add install/bootstrap.sh
git commit -m "feat(bootstrap): HIVE_VERSION env var for pinned installs (KPR-54)"
```

---

## Task 7: Public docs path refresh — `docs/getting-started.md`

**Files:**
- Modify: `docs/getting-started.md`

- [ ] **Step 1:** Read the file.

```bash
cat docs/getting-started.md
```

- [ ] **Step 2:** Audit-and-edit pass. For each hit of:
- `~/.hive/logs/` → `<instance>/logs/` or explicit `~/services/hive/<your-instance>/logs/`
- `~/.hive/.env` → `<instance>/.env` or explicit path
- `~/.hive/` as a standalone HIVE_HOME reference → explain multi-instance default at `~/services/hive/<id>/`

Use `grep -n '~/\.hive' docs/getting-started.md` to enumerate.

- [ ] **Step 3:** Add a "where is my instance?" paragraph near the top of the file, right after the first install command block. Insert:

```markdown
## Where is my instance?

Your Hive instance lives at `~/services/hive/<your-id>/` by default (pick `<your-id>` during `hive init`). Everything that persists across upgrades — your config, logs, agent data, skills, plugins — is at the instance root.

The engine itself — the code Hive runs — lives in `<instance>/.hive/`. Think of `.hive/` as wipe-and-replace: `hive update` swaps it for a new version, `hive rollback` restores the previous one. Your data is never inside `.hive/`, so upgrades can't touch it.
```

Find a sensible insertion point — typically right after the initial `curl | bash` / `npm i -g @keepur/hive && hive init` command block, before any sections that describe running the service.

- [ ] **Step 4:** Replace every `~/.hive/logs/hive.log` reference with `~/services/hive/<your-instance>/logs/hive.log` (or the shorter `<instance>/logs/hive.log` if context is already established).

- [ ] **Step 5:** Verify

```bash
grep -n '~/\.hive' docs/getting-started.md
```
Expected: zero hits.

- [ ] **Step 6:** Don't commit yet — Tasks 8 and 9 touch related docs; group the doc-refresh into one commit.

---

## Task 8: Public docs path refresh — `managing-your-hive.md`, `troubleshooting.md`

**Files:**
- Modify: `docs/managing-your-hive.md`
- Modify: `docs/troubleshooting.md`

Same surgery as Task 7, applied to two more files.

- [ ] **Step 1:** Read both files and enumerate references.

```bash
grep -n '~/\.hive' docs/managing-your-hive.md docs/troubleshooting.md
```

- [ ] **Step 2:** For each hit, replace path references:
- `~/.hive/.env` → `<instance>/.env` (or explicit path)
- `~/.hive/logs/hive.log` → `<instance>/logs/hive.log` (or explicit path)
- `~/.hive/` as HIVE_HOME → `~/services/hive/<id>/`

- [ ] **Step 3:** In `managing-your-hive.md`, the plugin and skill sections reference `<instance>/plugins/` — verify they map correctly against Phase 2's layout.

Post-Phase-2 layout:
- Engine plugins → `<instance>/.hive/plugins/claude-code/`
- Instance-authored plugins → `<instance>/plugins/`

The `hive plugin add ...` CLI installs *instance-authored* plugins, which land at `<instance>/plugins/`. Verify that text (or equivalent) is present and correct. If the doc describes `hive plugin` installing into `<instance>/plugins/claude-code/`, that's wrong for the new layout.

- [ ] **Step 4:** In `troubleshooting.md`, section 4 (LaunchAgent not loaded) describes the plist at `~/Library/LaunchAgents/com.hive.<id>.agent.plist` pointing at `<instance>/.hive/dist/index.js` or `<instance>/.hive/pkg/server.min.js`. Verify the `ProgramArguments` description matches Phase 2's actual output. If wrong, correct to:

```
<instance>/.hive/pkg/server.min.js      # bundled install (customer)
<instance>/.hive/dist/index.js           # dev install (internal)
```

- [ ] **Step 5:** Verify

```bash
grep -n '~/\.hive' docs/managing-your-hive.md docs/troubleshooting.md
```
Expected: zero hits.

- [ ] **Step 6:** Don't commit yet.

---

## Task 9: Spot-audit `cli/plugin.ts` and `cli/skill.ts` against `engineDir`

**Files:**
- Read only (verification pass): `src/cli/plugin.ts`, `src/cli/skill.ts`

Phase 2 was supposed to route engine-plugin installs into `<instance>/.hive/plugins/` and instance-plugin installs to `<instance>/plugins/`. Verify this landed correctly.

- [ ] **Step 1:** Read both files.

```bash
cat src/cli/plugin.ts src/cli/skill.ts
```

- [ ] **Step 2:** For each path reference, confirm:
- Engine plugins (claude-code, built-in skills) → `resolve(engineDir, "plugins", ...)` where `engineDir` is `<instance>/.hive/`.
- Instance plugins (user-added via `hive plugin add`) → `resolve(hiveHome, "plugins", ...)`.

If Phase 2 missed anything here, patch it. Likely-fine case: no changes needed.

- [ ] **Step 3:** If no changes needed, note in the Task 9 commit message that this was a verification pass.

- [ ] **Step 4:** Don't commit yet.

---

## Task 10: Commit the public-docs refresh

**Files:** (all modified in Tasks 7-9)

- [ ] **Step 1:** One commit covering all three doc files.

```bash
git add docs/getting-started.md docs/managing-your-hive.md docs/troubleshooting.md
git commit -m "docs: refresh public docs for .hive/ layout (KPR-54)"
```

If Task 9 required changes:

```bash
git add src/cli/plugin.ts src/cli/skill.ts
git commit -m "fix(cli): route engine vs instance plugins to correct .hive/ paths (KPR-54)"
```

If Task 9 was a verification pass only, skip that commit.

---

## Task 11: Rewrite `CLAUDE.md` "Dev vs Deploy" section

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** Find the "Dev vs Deploy" section.

```bash
grep -n "Dev vs Deploy" CLAUDE.md
```

The section describes the current (0.1.x) model. It's likely near the bottom, before "Commands" or similar.

- [ ] **Step 2:** Replace the section contents. Old text lists things like `~/services/hive` being a git clone, `launchctl kickstart` restarting the deploy dir, etc. New text:

```markdown
## Dev vs Deploy

- **Dev**: `~/github/hive` — edit source, test, commit, push. Repo layout unchanged from 0.1.x.
- **Deploy**: `~/services/hive/<instance>/` — instance dir. Engine lives in `<instance>/.hive/` (wipe-and-replace on upgrade). Instance config, agent data, logs at instance root (survive upgrades).
- **Upgrade**: `hive update [--tag=X]` runs `deploy.sh`, which fetches the npm tarball and swaps `.hive/`. `hive rollback` restores `.hive.prev/`.
- **Deploy script location**: `<instance>/.hive/service/deploy.sh` (engine-shipped, not in the repo root at runtime).
- **CI runner**: self-hosted ARM64 runner on Mac Mini, unchanged.
- **Restart**: `launchctl kickstart -k gui/$(id -u)/<label>` — still the primitive for picking up engine or config changes.
```

- [ ] **Step 3:** Verify other parts of `CLAUDE.md` aren't stale.

Run:
```bash
grep -n '~/\.hive\|~/services/hive/\$' CLAUDE.md
grep -n 'deploy branch\|git pull.*deploy\|clone.*deploy' CLAUDE.md
```

Any hits on the second grep describe the old clone-as-instance model and need correcting. Most likely all already in the "Dev vs Deploy" section you just rewrote.

- [ ] **Step 4:** Don't commit yet.

---

## Task 12: Update `docs/architecture.md` directory layout

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1:** Find the "directory layout" or "Hive instance structure" section.

```bash
grep -n -i "directory\|layout\|instance struct" docs/architecture.md
```

- [ ] **Step 2:** Audit for phrases like:
- "the hive repo is cloned into `~/services/hive`"
- "deploy branch"
- "rsync dist/ into the instance"
- references to `<instance>/dist/` or `<instance>/node_modules/`

Replace with the Phase 2/3 description. The ASCII diagram in KPR-50's epic is the canonical shape:

```
~/services/hive/<instance>/
  .hive/                         # engine (wipe-and-replace on upgrade)
    pkg/ seeds/ templates/
    service/                     # deploy.sh + instances.conf (engine-shipped)
    scripts/honeypot
    package.json
  .hive.prev/                    # previous engine (rollback target), may be absent
  .env                           # instance config, survives upgrades
  hive.yaml
  beekeeper.yaml
  .hive-generated.json           # seed-hash cache, survives upgrades
  logs/                          # observability, survives upgrades
  agents/<agent_id>/             # per-agent home, survives upgrades
    scratch/ reports/ feeds/ playwright/
    workshop/                    # software-engineer archetype only
  workflow/                      # instance-authored flows
  data/                          # pipeline dump ground, transient
  skills/                        # instance-authored skills
  plugins/                       # instance-authored plugins
```

Paste this (or the equivalent already in `CLAUDE.md` / the epic) into the architecture doc.

- [ ] **Step 3:** Don't commit yet.

---

## Task 13: Audit `docs/onboarding-email.md`

**Files:**
- Read only: `docs/onboarding-email.md`

Spec §6 says this file is expected to be fine — two shell commands and a docs URL, all layout-independent. Verify.

- [ ] **Step 1:** Read the file.

```bash
cat docs/onboarding-email.md
```

- [ ] **Step 2:** Check that:
- `curl -fsSL .../install/bootstrap.sh | bash` is unchanged and still works (it does; Task 6 only added an optional env var).
- `npm i -g @keepur/hive && hive init` is present and unchanged.
- The docs URL points at `keepur/hive-docs` (public mirror).

- [ ] **Step 3:** If everything checks out, no change. Make a note in the commit that this was audit-only.

If something drifted (e.g., the docs URL moved), update it.

- [ ] **Step 4:** Don't commit yet.

---

## Task 14: Commit the internal docs refresh

**Files:** (all modified in Tasks 11-13)

- [ ] **Step 1:** Commit.

```bash
git add CLAUDE.md docs/architecture.md
# If docs/onboarding-email.md changed:
git add docs/onboarding-email.md 2>/dev/null || true
git commit -m "docs: refresh CLAUDE.md + architecture.md for .hive/ layout (KPR-54)"
```

---

## Task 15: Run `publish-docs.sh`

**Files:**
- Reads: `scripts/publish-docs.sh`
- Writes (via the script): `keepur/hive-docs` remote

The public mirror at `keepur/hive-docs` is what beta customers see when the onboarding email links them to install docs. After the doc-refresh commits land on main, sync them out.

- [ ] **Step 1:** Run from a dev tree on main (not from the kpr-54 branch).

**Skip this step in the implementation PR.** Publishing docs is a post-merge activity — running it from a feature branch would mirror unmerged changes to the public repo. Mention in the PR body that the publish step must run after merge.

In the PR description include:

> **Post-merge TODO**: `scripts/publish-docs.sh` must run after this merges to sync the updated docs to `keepur/hive-docs`. Running from the feature branch would publish unreleased content.

- [ ] **Step 2:** Document the post-merge step in the PR body (Task 17).

---

## Task 16: Full check + acceptance

- [ ] **Step 1:** Run the full quality gate.

```bash
npm run check
```
Expected: typecheck + lint + format + test all pass.

If Prettier complains: `npm run format && git commit -am "style: prettier (KPR-54)"`.

- [ ] **Step 2:** Bundle check explicitly (this is the gate the new Test 4 lands in).

```bash
npm run build
npm run bundle
npm run check:bundle
```
Expected: all pass, including the new Test 4 (`.hive/pkg/ layout: server.min.js loaded ...`). The CI workflow already runs `check:bundle`; this is the local mirror of that gate.

- [ ] **Step 3:** End-to-end fresh install (strongly recommended before PR).

Scratch scenario — don't run this on any real Mac Mini. This must exercise the **bundled** path: `populateEngine` only fires when the wizard detects `pkg/server.min.js` sitting next to the running CLI (see `wizard.ts:169` — `isBundled = existsSync(resolve(pkgRoot, "pkg", "server.min.js"))`). A `npm run dev` / `npx tsx` invocation is non-bundled and will skip the new Engine section entirely — that's correct behavior, but it doesn't exercise the new code path.

Two ways to test the bundled path:

```bash
# Option A: exercise via the globally-installed @keepur/hive CLI (post `npm i -g` from a local build).
# Before running, confirm `hive` resolves to the bundled install:
which hive
node -e "console.log(require.resolve('@keepur/hive/package.json'))"
# Then scratch init:
TESTHOME=$(mktemp -d -t kpr54-fresh.XXXXXX)
HIVE_HOME="$TESTHOME" hive init 2>&1 | tee /tmp/kpr54-init.log

# Option B: exercise via a local bundle directly.
npm run bundle
TESTHOME=$(mktemp -d -t kpr54-fresh.XXXXXX)
HIVE_HOME="$TESTHOME" node pkg/cli.min.js init 2>&1 | tee /tmp/kpr54-init.log
```

Then inspect:

```bash
ls "$TESTHOME/.hive"
cat "$TESTHOME/.hive/package.json"
```

Expected:
- Wizard completes the "Engine" section after "Memory (MongoDB)" and before "Service".
- `ls $TESTHOME/.hive` shows `pkg/`, `seeds/`, `templates/`, `scripts/`, `package.json`.
- Version in `.hive/package.json` matches the CLI's version.
- Wizard continues to "Service" section.

Cleanup:

```bash
rm -rf "$TESTHOME"
```

- [ ] **Step 4:** Acceptance checklist from spec §Acceptance.

- [ ] `populateEngine` unit tests (7 cases) green.
- [ ] `check:bundle` runs in CI (already wired; Task 5 confirmed).
- [ ] Fresh install end-to-end produces `.hive/` populated, no `.git/` in instance dir, `"Hive is running"` observed in logs.
- [ ] `grep -rn '~/\.hive' docs/` returns zero hits across `getting-started.md`, `managing-your-hive.md`, `troubleshooting.md`.
- [ ] `hive update --tag=<something>` and `hive rollback` work (verified in KPR-53; spot-check they still work against the freshly-installed instance).
- [ ] Onboarding email's two install command blocks produce a working 0.2.0 install.

- [ ] **Step 5:** Push + open PR.

```bash
git push -u origin kpr-54
gh pr create --base deploy --title "feat: fresh-install + doc refresh for .hive/ layout (KPR-54)" --body "$(cat <<'EOF'
## Summary
- `hive init` wizard now populates `<instance>/.hive/` from the running CLI's package root (bundled installs only; dev installs unchanged).
- New `src/setup/populate-engine.ts` + 7 unit tests. `PACKAGE_ENTRIES` is kept in sync with `deploy.sh` fetch_engine tarball shape.
- `scripts/check-bundle-runtime.mjs` gains a `.hive/pkg/` CWD-shifted case (Test 4). CI was already running `check:bundle`, so the new case flows straight to the gate.
- `install/bootstrap.sh` supports `HIVE_VERSION` env var for pinned installs (default: `latest`, unchanged).
- Public docs (`getting-started.md`, `managing-your-hive.md`, `troubleshooting.md`) refreshed: no more `~/.hive/` as HIVE_HOME references.
- Internal docs (`CLAUDE.md` Dev vs Deploy, `docs/architecture.md` directory layout) rewritten for Phase 2/3 reality.

Phase 4 of [KPR-50](https://linear.app/keepur/issue/KPR-50) (v0.2.0). Depends on KPR-52 and KPR-53.

## Test plan
- [ ] `npm run check` green
- [ ] `npm run check:bundle` green (both existing cases + new `.hive/pkg/` case)
- [ ] Fresh `hive init` produces `<instance>/.hive/` with `pkg/server.min.js`, `seeds/`, `templates/`, `scripts/honeypot`, `package.json`
- [ ] `hive update --tag=<next>` and `hive rollback` still work after fresh install (Phase 3 surface regression-check)
- [ ] `grep -rn '~/\.hive' docs/` zero hits
- [ ] Onboarding email install blocks produce a working install end-to-end

## Post-merge TODO
- Run `scripts/publish-docs.sh` from `main` to sync updated docs to `keepur/hive-docs`.
EOF
)"
```

---

## Out-of-scope reminders

If any come up during execution, stop and note — they are deferred:

- **Publishing 0.2.0 to npm** — Phase 3 deploy dry run / Phase 5 coordinated cutover.
- **Migrating existing 0.1.x installs** — Phase 5 / KPR-55.
- **Changing `package.json` `files`, `bin`, or publish workflow** — already correct per Phase 2.
- **Changing the npm package name or license** — spec non-goal.
- **CI enforcement of `publish-docs.sh` running after every doc-change merge** — explicitly out of scope per spec §Runtime failure modes.
- **License-text rewrite** — separate legal consideration, not part of the restructure.
