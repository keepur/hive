# Engine → `.hive/` Relocation Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Relocate engine code (`dist/`, `node_modules/`, `seeds/`, `service/`, `plugins/claude-code/`, `package.json`) into `<instance>/.hive/`, and split instance-local engine state (git, snapshots, upgrade-notice flag) into a sibling `<instance>/.hive-state/`. After this lands, `.hive/` is a wipe-and-replace upgrade boundary.

**Architecture:** One new path constant (`engineDir` = `<hiveHome>/.hive`), one renamed constant (`hiveMetaDir` → `hiveStateDir` = `<hiveHome>/.hive-state`), one new derived constant (`instanceGitDir` = `<hiveStateDir>/git`). All engine-path callers (`config.ts`, `agent-runner.ts`, `cli/plugin.ts`, `cli/daemon.ts`, `cli.ts`) switch from `hiveHome`-relative to `engineDir`-relative. All instance-state callers (`instance-git.ts`, `integrity.ts`, `upgrade-notice.ts`, `index.ts`) switch from the old `.hive/` metadata dir to `hiveStateDir`. Startup gains a "both layouts coexist" guard that refuses to boot.

**Tech Stack:** TypeScript (strict), Node 24, Vitest, bash (`service/deploy.sh`).

**Scope boundary:** Phase 2 only. The `deploy.sh` rewrite (Phase 3), fresh-install flow (Phase 4), and migration of existing 0.1.x instances (Phase 5) are out of scope and will land separately.

**Reference:** [`docs/specs/2026-04-21-engine-hive-dir-design.md`](../specs/2026-04-21-engine-hive-dir-design.md). Linear: [KPR-52](https://linear.app/keepur/issue/KPR-52).

---

## File Structure

### Modified

| File | Responsibility after change |
|------|------------------------------|
| `src/paths.ts` | Add `engineDir`, `hiveStateDir`, `instanceGitDir`; drop `hiveMetaDir`; change fallback home from `~/.hive` to `~/hive` |
| `src/index.ts` | Import `hiveStateDir` (not `hiveMetaDir`); pass it to integrity/upgrade-notice; add startup guard that refuses to boot if both `<hiveHome>/dist/index.js` and `<hiveHome>/.hive/dist/index.js` exist |
| `src/skills/instance-git.ts` | Use `instanceGitDir` + `hiveStateDir` from `paths.ts`; drop per-function `.hive/git` re-derivation |
| `src/skills/integrity.ts` | Rename param `hiveMetaDir` → `hiveStateDir`; change `writeSnapshot` signature to `(stateDir, packageRoot, declaredFiles)`; delete `PACKAGE_PATHS` set; collapse dotfile guard into unified `ALLOWLISTED` |
| `src/skills/upgrade-notice.ts` | Rename param `hiveMetaDir` → `hiveStateDir` (mechanical) |
| `src/config.ts` | Plugin discovery root: `hiveHome` → `engineDir` |
| `src/agents/agent-runner.ts` (lines 652–653) | Plugin server path resolution: `hiveHome` → `engineDir` |
| `src/cli/plugin.ts` (line 11) | `pluginsDir` uses `engineDir` not `hiveHome` |
| `src/cli/daemon.ts` | `serverPath` reads from `engineDir`; drop unused `pkgRoot` parameter from `startDaemon()` |
| `src/cli.ts` | Update `startDaemon(PKG_ROOT)` call site to `startDaemon()` |
| `src/cli/doctor.ts` | Add one check: warn if live-plist `ProgramArguments` doesn't match expected `<engineDir>/dist/index.js` (or `pkg/server.min.js`) |
| `service/deploy.sh` (lines 194–195) | rsync targets `$DEPLOY_DIR/.hive/dist/` and `$DEPLOY_DIR/.hive/plugins/claude-code/` |
| `src/skills/instance-git.test.ts` | Fixture paths move from `<tmp>/.hive/git` to `<tmp>/.hive-state/git` |

### Created

| File | Responsibility |
|------|----------------|
| `src/paths.test.ts` | Assert `engineDir`, `hiveStateDir`, `instanceGitDir` resolve against `hiveHome` as expected |
| `src/cli/daemon.test.ts` | Assert generated plist `ProgramArguments[1]` == `<engineDir>/dist/index.js` and `WorkingDirectory` == `<hiveHome>` |
| `src/skills/integrity.test.ts` | Assert `writeSnapshot(stateDir, packageRoot, files)` writes under `stateDir`; assert `checkAllowlistDrift` accepts `.hive` and `.hive-state` and does not warn on the Phase 1 sibling dirs |

### Not touched (deferred to later phases)

- `hive.yaml.example` — no `plugins/claude-code/` references to update; examples are schema-agnostic.
- `service/com.hive.personal.agent.plist` — absent from this branch; nothing to edit.
- `service/install.sh`, `service/instances.conf` — deferred to Phase 3.
- Migration script for 0.1.x → 0.2.0 — deferred to Phase 5.

---

## Task Sequencing

Tasks build bottom-up: paths first, then consumers, then tests, then the shell script, then the gate. Commit after each task so a revert stays surgical.

---

### Task 1: Rewrite `src/paths.ts` path constants

**Files:**
- Modify: `src/paths.ts`

- [ ] **Step 1:** Change the fallback in `resolveHiveHome()` from `~/.hive` to `~/hive`.

In `src/paths.ts`, replace line 17:

```ts
  return resolve(home, ".hive");
```

with:

```ts
  return resolve(home, "hive");
```

Also update the doc comment at lines 6–13:

```ts
/**
 * Resolve the Hive home directory.
 *
 * Priority:
 *   1. HIVE_HOME env var (explicit — always wins)
 *   2. ./hive.yaml in cwd (project-local / dev repo mode)
 *   3. ~/hive/ (default for npm installs; v0.2.0 — was ~/.hive in v0.1.x)
 */
```

- [ ] **Step 2:** Replace `hiveMetaDir` export with `engineDir`, `hiveStateDir`, `instanceGitDir`.

Delete lines 45–46 (the `hiveMetaDir` block and its doc comment) and insert:

```ts
/**
 * Engine root inside the instance directory.
 *
 * Everything under here is wipe-and-replace on upgrade: `dist/`, `node_modules/`,
 * `seeds/`, `service/`, `plugins/claude-code/`, `package.json`. Nothing agent-authored
 * or operator-owned lives here.
 */
export const engineDir = resolve(hiveHome, ".hive");

/**
 * Instance-local engine state directory.
 *
 * Holds the instance-git working tree, installed-snapshot.json, previous-snapshot.json,
 * and the upgrade-notice flag. Must survive `rm -rf .hive` upgrades — that's why it's
 * a sibling of `.hive/`, not a child.
 */
export const hiveStateDir = resolve(hiveHome, ".hive-state");

/**
 * GIT_DIR location for the instance-local git repo.
 *
 * Callers in instance-git.ts use this as `GIT_DIR` and `hiveHome` as `GIT_WORK_TREE`.
 */
export const instanceGitDir = resolve(hiveStateDir, "git");
```

- [ ] **Step 3:** Verify compile.

Run: `npx tsc --noEmit`
Expected: errors pointing at files that still import `hiveMetaDir` (`src/index.ts`, `src/skills/integrity.ts`, `src/skills/upgrade-notice.ts`). That's the signal for Task 2+ — we fix them next.

- [ ] **Step 4:** Commit.

```bash
git add src/paths.ts
git commit -m "feat(paths): add engineDir + hiveStateDir, drop hiveMetaDir (KPR-52)"
```

---

### Task 2: Migrate `src/skills/instance-git.ts` to `instanceGitDir` / `hiveStateDir`

**Files:**
- Modify: `src/skills/instance-git.ts`

- [ ] **Step 1:** Replace imports.

In `src/skills/instance-git.ts`, replace line 3:

```ts
import { resolve, join } from "node:path";
```

with:

```ts
import { join } from "node:path";
import { hiveStateDir, instanceGitDir } from "../paths.js";
```

(`resolve` is no longer needed once all `.hive/git` re-derivations are gone.)

- [ ] **Step 2:** Rewrite `initInstanceGit`.

Replace lines 15–41 (`export function initInstanceGit(...)` through the closing brace) with:

```ts
export function initInstanceGit(hiveHome: string): void {
  if (existsSync(instanceGitDir)) return; // Already initialized

  mkdirSync(hiveStateDir, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", [...args], {
      cwd: hiveHome,
      env: { ...process.env, GIT_DIR: instanceGitDir, GIT_WORK_TREE: hiveHome },
      stdio: "pipe",
    });

  git("init");
  git("config", "user.name", "hive-instance");
  git("config", "user.email", "hive@localhost");

  // Create initial empty commit on 'installed' branch
  git("checkout", "-b", "installed");
  git("commit", "--allow-empty", "-m", "init: installed branch");

  // Create 'state' branch from the same root
  git("checkout", "-b", "state");
  git("commit", "--allow-empty", "-m", "init: state branch");

  log.info("Instance-local git initialized", { gitDir: instanceGitDir });
}
```

Also update the doc comment at lines 8–14 to match the new path:

```ts
/**
 * Initialize the instance-local git repo if not already present.
 * Creates `.hive-state/git/` with `installed` and `state` branches.
 *
 * Uses a SEPARATE git dir at `.hive-state/git` (via GIT_DIR env var)
 * to avoid conflicts with any existing `.git` at hiveHome.
 */
```

- [ ] **Step 3:** Rewrite `gitCmd` (lines 46–54).

```ts
function gitCmd(hiveHome: string, ...args: string[]): string {
  return execFileSync("git", [...args], {
    cwd: hiveHome,
    env: { ...process.env, GIT_DIR: instanceGitDir, GIT_WORK_TREE: hiveHome },
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}
```

- [ ] **Step 4:** Rewrite `commitToState` (the `gitDir`/`tmpIndex`/`env` block at lines 62–69).

Replace:

```ts
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (!existsSync(gitDir)) {
    log.warn("Instance git not initialized — skipping state commit");
    return;
  }

  const tmpIndex = join(gitDir, "state-index.tmp");
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome, GIT_INDEX_FILE: tmpIndex };
```

with:

```ts
  if (!existsSync(instanceGitDir)) {
    log.warn("Instance git not initialized — skipping state commit");
    return;
  }

  const tmpIndex = join(instanceGitDir, "state-index.tmp");
  const env = {
    ...process.env,
    GIT_DIR: instanceGitDir,
    GIT_WORK_TREE: hiveHome,
    GIT_INDEX_FILE: tmpIndex,
  };
```

- [ ] **Step 5:** Rewrite `commitRemovalToState` (the `gitDir`/`tmpIndex`/`env` block at lines 145–149).

Replace:

```ts
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (!existsSync(gitDir)) return;

  const tmpIndex = join(gitDir, "state-index.tmp");
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome, GIT_INDEX_FILE: tmpIndex };
```

with:

```ts
  if (!existsSync(instanceGitDir)) return;

  const tmpIndex = join(instanceGitDir, "state-index.tmp");
  const env = {
    ...process.env,
    GIT_DIR: instanceGitDir,
    GIT_WORK_TREE: hiveHome,
    GIT_INDEX_FILE: tmpIndex,
  };
```

- [ ] **Step 6:** Verify.

Run: `npx tsc --noEmit src/skills/instance-git.ts`
Expected: no errors from this file (downstream errors in `index.ts`/`integrity.ts` are fine — addressed in later tasks).

Run: `grep -n "\.hive.*git\|resolve.*\.hive" src/skills/instance-git.ts`
Expected: no matches (only the doc-comment string `.hive-state/git/` should remain — that grep won't hit it because the pattern requires `.hive` followed by `git` without `-state`).

- [ ] **Step 7:** Commit.

```bash
git add src/skills/instance-git.ts
git commit -m "refactor(instance-git): use instanceGitDir + hiveStateDir from paths (KPR-52)"
```

---

### Task 3: Update `src/skills/integrity.ts`

**Files:**
- Modify: `src/skills/integrity.ts`

- [ ] **Step 1:** Rename `verifyPackageIntegrity`'s second parameter.

Replace line 13:

```ts
export function verifyPackageIntegrity(hiveHome: string, hiveMetaDir: string): { ok: boolean; warnings: string[] } {
  const snapshotPath = resolve(hiveMetaDir, "installed-snapshot.json");
```

with:

```ts
export function verifyPackageIntegrity(hiveHome: string, hiveStateDir: string): { ok: boolean; warnings: string[] } {
  const snapshotPath = resolve(hiveStateDir, "installed-snapshot.json");
```

- [ ] **Step 2:** Replace `checkAllowlistDrift` (lines 52–81).

Full replacement:

```ts
export function checkAllowlistDrift(hiveHome: string): void {
  const ALLOWLISTED = [
    "skills",
    "plugins",
    "workflow",
    "data",
    "agents",
    "logs",
    ".hive",
    ".hive-state",
    ".env",
    "hive.yaml",
    "hive-",
    "beekeeper.yaml",
    ".hive-generated.json",
  ];

  try {
    const entries = readdirSync(hiveHome);
    const warnings: string[] = [];

    for (const entry of entries) {
      if (ALLOWLISTED.some((p) => entry.startsWith(p))) continue;
      warnings.push(entry);
    }

    if (warnings.length > 0) {
      log.warn("Unexpected files in instance directory", { files: warnings });
    }
  } catch {
    // Non-fatal
  }
}
```

Notes:
- `PACKAGE_PATHS` is gone — those paths live under `.hive/` after Phase 2 and the `.hive` entry in `ALLOWLISTED` matches them by prefix.
- The dotfile guard is gone — `.hive`, `.hive-state`, `.env`, `.hive-generated.json` are all explicit in `ALLOWLISTED`.
- The `p.replace("/", "")` noise from the original is gone — no entries contain `/`.

- [ ] **Step 3:** Change `writeSnapshot` signature.

Replace lines 83–98:

```ts
export function writeSnapshot(packageRoot: string, declaredFiles: string[]): void {
  const entries: SnapshotEntry[] = [];
  for (const file of declaredFiles) {
    const fullPath = resolve(packageRoot, file);
    if (!existsSync(fullPath)) continue;
    if (statSync(fullPath).isDirectory()) {
      walkDir(fullPath, file, entries);
    } else {
      const content = readFileSync(fullPath);
      entries.push({ path: file, hash: createHash("sha256").update(content).digest("hex") });
    }
  }
  const snapshotDir = resolve(packageRoot, ".hive");
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(resolve(snapshotDir, "installed-snapshot.json"), JSON.stringify(entries, null, 2));
}
```

with:

```ts
export function writeSnapshot(stateDir: string, packageRoot: string, declaredFiles: string[]): void {
  const entries: SnapshotEntry[] = [];
  for (const file of declaredFiles) {
    const fullPath = resolve(packageRoot, file);
    if (!existsSync(fullPath)) continue;
    if (statSync(fullPath).isDirectory()) {
      walkDir(fullPath, file, entries);
    } else {
      const content = readFileSync(fullPath);
      entries.push({ path: file, hash: createHash("sha256").update(content).digest("hex") });
    }
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, "installed-snapshot.json"), JSON.stringify(entries, null, 2));
}
```

Note: no in-tree callers of `writeSnapshot` exist today — Phase 4's installer is the first real caller. `grep -rn "writeSnapshot" src/` should return only the definition.

- [ ] **Step 4:** Verify no callers break.

Run: `grep -rn "writeSnapshot\|PACKAGE_PATHS" src/`
Expected: only the definition in `integrity.ts`, no callers, no `PACKAGE_PATHS` references remaining.

Run: `npx tsc --noEmit src/skills/integrity.ts`
Expected: no errors from this file.

- [ ] **Step 5:** Commit.

```bash
git add src/skills/integrity.ts
git commit -m "refactor(integrity): rename hiveMetaDir param, split writeSnapshot signature, drop PACKAGE_PATHS (KPR-52)"
```

---

### Task 4: Rename parameter in `src/skills/upgrade-notice.ts`

**Files:**
- Modify: `src/skills/upgrade-notice.ts`

- [ ] **Step 1:** Mechanical rename — `hiveMetaDir` → `hiveStateDir` everywhere in the file.

Replace line 7:

```ts
export function checkUpgradeNotice(hiveMetaDir: string, skillsDir: string): void {
  const noticeFlag = resolve(hiveMetaDir, "upgrade-notice-emitted");
```

with:

```ts
export function checkUpgradeNotice(hiveStateDir: string, skillsDir: string): void {
  const noticeFlag = resolve(hiveStateDir, "upgrade-notice-emitted");
```

Replace line 11:

```ts
    const prevSnapshotPath = resolve(hiveMetaDir, "previous-snapshot.json");
```

with:

```ts
    const prevSnapshotPath = resolve(hiveStateDir, "previous-snapshot.json");
```

Replace line 49:

```ts
    mkdirSync(hiveMetaDir, { recursive: true });
```

with:

```ts
    mkdirSync(hiveStateDir, { recursive: true });
```

- [ ] **Step 2:** Verify.

Run: `grep -n "hiveMetaDir" src/skills/upgrade-notice.ts`
Expected: no matches.

- [ ] **Step 3:** Commit.

```bash
git add src/skills/upgrade-notice.ts
git commit -m "refactor(upgrade-notice): rename hiveMetaDir param to hiveStateDir (KPR-52)"
```

---

### Task 5: Wire `src/index.ts` to the new paths + add startup guard

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1:** Swap the `paths.js` import.

Replace line 2:

```ts
import { skillsDir, hiveHome, hiveMetaDir } from "./paths.js";
```

with:

```ts
import { skillsDir, hiveHome, hiveStateDir, engineDir } from "./paths.js";
```

- [ ] **Step 2:** Update the two integrity/upgrade-notice calls.

Replace lines 45 and 48:

```ts
  verifyPackageIntegrity(hiveHome, hiveMetaDir);
  checkAllowlistDrift(hiveHome);
  initInstanceGit(hiveHome);
  checkUpgradeNotice(hiveMetaDir, skillsDir);
```

with:

```ts
  // Refuse to boot if both 0.1.x and 0.2.0 engine layouts exist side-by-side
  // (catches botched manual upgrades where someone extracted a 0.2.0 tarball
  // over a 0.1.x instance without removing the old dist/).
  if (existsSync(resolve(hiveHome, "dist", "index.js")) && existsSync(resolve(engineDir, "dist", "index.js"))) {
    log.error(
      "Conflicting engine layouts detected — both <hiveHome>/dist/ and <hiveHome>/.hive/dist/ exist. " +
        "Remove the old <hiveHome>/dist/ before starting 0.2.0.",
      { hiveHome, engineDir },
    );
    process.exit(1);
  }

  verifyPackageIntegrity(hiveHome, hiveStateDir);
  checkAllowlistDrift(hiveHome);
  initInstanceGit(hiveHome);
  checkUpgradeNotice(hiveStateDir, skillsDir);
```

- [ ] **Step 3:** Add the `resolve` import if not already present.

Check the imports at the top of `src/index.ts`. `resolve` from `node:path` is needed for the new guard. If not present, add:

```ts
import { resolve } from "node:path";
```

(Place it with other `node:` imports near `import { existsSync, watch } from "node:fs";` on line 1.)

- [ ] **Step 4:** Verify compile.

Run: `npx tsc --noEmit`
Expected: zero errors across the whole codebase. This is the first time since Task 1 that typecheck should pass clean.

- [ ] **Step 5:** Commit.

```bash
git add src/index.ts
git commit -m "feat(startup): use hiveStateDir + guard against conflicting engine layouts (KPR-52)"
```

---

### Task 6: Point plugin discovery at `engineDir` — `src/config.ts`

**Files:**
- Modify: `src/config.ts` (line 8 import, lines 24–36 `discoverPluginDirs`)

- [ ] **Step 1:** Add `engineDir` to the `paths.js` import.

Replace line 8:

```ts
import { hiveHome, resolveConfigFile, resolveDotenvPath } from "./paths.js";
```

with:

```ts
import { engineDir, hiveHome, resolveConfigFile, resolveDotenvPath } from "./paths.js";
```

- [ ] **Step 2:** Update `discoverPluginDirs`.

Replace lines 24–36:

```ts
/** Auto-discover all plugin dirs under <hiveHome>/plugins/claude-code/, or use explicit list from hive.yaml */
function discoverPluginDirs(yamlDirs?: string[]): string[] {
  // Explicit list in hive.yaml takes precedence
  if (yamlDirs?.length) {
    return yamlDirs.map((d) => resolve(d.replace(/^~/, process.env.HOME ?? "/tmp")));
  }
  // Auto-scan <hiveHome>/plugins/claude-code/*/
  const parentDir = resolve(hiveHome, "plugins/claude-code");
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir)
    .map((name) => resolve(parentDir, name))
    .filter((p) => statSync(p).isDirectory());
}
```

with:

```ts
/** Auto-discover all plugin dirs under <engineDir>/plugins/claude-code/, or use explicit list from hive.yaml */
function discoverPluginDirs(yamlDirs?: string[]): string[] {
  // Explicit list in hive.yaml takes precedence
  if (yamlDirs?.length) {
    return yamlDirs.map((d) => resolve(d.replace(/^~/, process.env.HOME ?? "/tmp")));
  }
  // Auto-scan <engineDir>/plugins/claude-code/*/
  const parentDir = resolve(engineDir, "plugins/claude-code");
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir)
    .map((name) => resolve(parentDir, name))
    .filter((p) => statSync(p).isDirectory());
}
```

- [ ] **Step 3:** Verify.

Run: `npx tsc --noEmit src/config.ts`
Expected: no errors.

- [ ] **Step 4:** Commit.

```bash
git add src/config.ts
git commit -m "feat(config): discover plugins under engineDir not hiveHome (KPR-52)"
```

---

### Task 7: Update plugin server resolution in `src/agents/agent-runner.ts`

**Files:**
- Modify: `src/agents/agent-runner.ts`

- [ ] **Step 1:** Find the existing `paths.js` import line and confirm it already pulls in `hiveHome` (it should — lines 652–653 use it). Add `engineDir` to that import.

Run: `grep -n 'from "../paths.js"\|from "../paths"' src/agents/agent-runner.ts`
Expected output: one import line pulling in `hiveHome`. Add `engineDir` to it. Example if the existing line is:

```ts
import { hiveHome, agentsDir, agentScratchDir, agentPlaywrightDir } from "../paths.js";
```

Change to:

```ts
import { engineDir, hiveHome, agentsDir, agentScratchDir, agentPlaywrightDir } from "../paths.js";
```

(Preserve whatever symbols the current import has — the only additive change is `engineDir`.)

- [ ] **Step 2:** Update lines 652–653.

Replace:

```ts
        const npmPath = resolve(hiveHome, "plugins", "node_modules", plugin.name, "dist", entryMin);
        const inTreePath = resolve(hiveHome, "plugins", plugin.name, "dist", entryMin);
```

with:

```ts
        const npmPath = resolve(engineDir, "plugins", "node_modules", plugin.name, "dist", entryMin);
        const inTreePath = resolve(engineDir, "plugins", plugin.name, "dist", entryMin);
```

- [ ] **Step 3:** Verify no other `hiveHome.*plugins` references slipped through.

Run: `grep -n 'hiveHome.*plugins\|hiveHome, "plugins"' src/agents/agent-runner.ts`
Expected: no matches.

Run: `npx tsc --noEmit src/agents/agent-runner.ts`
Expected: no errors.

- [ ] **Step 4:** Commit.

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(agent-runner): resolve plugin server entry under engineDir (KPR-52)"
```

---

### Task 8: Update `pluginsDir` in `src/cli/plugin.ts`

**Files:**
- Modify: `src/cli/plugin.ts` (line 5 import, line 11 constant)

- [ ] **Step 1:** Swap the `paths.js` import.

Replace line 5:

```ts
import { hiveHome } from "../paths.js";
```

with:

```ts
import { engineDir } from "../paths.js";
```

- [ ] **Step 2:** Update line 11.

Replace:

```ts
const pluginsDir = resolve(hiveHome, "plugins");
```

with:

```ts
const pluginsDir = resolve(engineDir, "plugins");
```

- [ ] **Step 3:** Verify.

Run: `grep -n 'hiveHome' src/cli/plugin.ts`
Expected: no matches.

Run: `npx tsc --noEmit src/cli/plugin.ts`
Expected: no errors.

- [ ] **Step 4:** Commit.

```bash
git add src/cli/plugin.ts
git commit -m "feat(cli/plugin): install plugins under engineDir (KPR-52)"
```

---

### Task 9: Plist `serverPath` uses `engineDir`, drop `pkgRoot` param, extract `buildPlist` — `src/cli/daemon.ts`

**Files:**
- Modify: `src/cli/daemon.ts`

This task lands three related changes in one commit: (1) add `engineDir` import, (2) drop `pkgRoot` param and repoint `serverPath`, (3) extract the plist string template into a pure `buildPlist()` helper so Task 12 can assert its contents without invoking `launchctl`. Doing the extraction here (not in Task 12) means `daemon.ts` only gets touched once.

- [ ] **Step 1:** Add `engineDir` to the `paths.js` import.

Replace line 5:

```ts
import { hiveHome } from "../paths.js";
```

with:

```ts
import { engineDir, hiveHome } from "../paths.js";
```

- [ ] **Step 2:** Extract the plist template into an exported `buildPlist` helper.

Add this function near the top of `src/cli/daemon.ts` (below the existing `getLabel`/`getPlistPath`/`getLaunchAgentLink` helpers, above `startDaemon`):

```ts
export function buildPlist(opts: {
  label: string;
  nodePath: string;
  serverPath: string;
  hiveHome: string;
  home: string;
  pathEnv: string;
  logsDir: string;
}): string {
  const { label, nodePath, serverPath, hiveHome, home, pathEnv, logsDir } = opts;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverPath}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${hiveHome}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HIVE_HOME</key>
    <string>${hiveHome}</string>
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
  <string>${logsDir}/hive.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/hive.err</string>
</dict>
</plist>
`;
}
```

- [ ] **Step 3:** Update `startDaemon` signature, swap `pkgRoot` for `engineDir`, and call `buildPlist`.

Replace lines 27–89 (from the `export async function startDaemon(pkgRoot: string)` signature through the closing backtick/semicolon of the inline plist template literal). Do **not** touch line 91's `writeFileSync(plistPath, plist);` — it stays, and `plist` is now the return value of `buildPlist`:

```ts
export async function startDaemon(pkgRoot: string): Promise<void> {
  const label = getLabel();
  const plistPath = getPlistPath();
  const linkPath = getLaunchAgentLink();
  const serviceDir = resolve(hiveHome, "service");
  const logsDir = resolve(hiveHome, "logs");

  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const nodePath = execFileSync("which", ["node"], { encoding: "utf-8" }).trim();
  const serverPath = existsSync(resolve(pkgRoot, "pkg", "server.min.js"))
    ? resolve(pkgRoot, "pkg", "server.min.js")
    : resolve(pkgRoot, "dist", "index.js");

  const home = process.env.HOME ?? "/tmp";
  const pathEnv = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverPath}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${hiveHome}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HIVE_HOME</key>
    <string>${hiveHome}</string>
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
  <string>${logsDir}/hive.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/hive.err</string>
</dict>
</plist>
`;
```

with:

```ts
export async function startDaemon(): Promise<void> {
  const label = getLabel();
  const plistPath = getPlistPath();
  const linkPath = getLaunchAgentLink();
  const serviceDir = resolve(hiveHome, "service");
  const logsDir = resolve(hiveHome, "logs");

  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const nodePath = execFileSync("which", ["node"], { encoding: "utf-8" }).trim();
  const serverPath = existsSync(resolve(engineDir, "pkg", "server.min.js"))
    ? resolve(engineDir, "pkg", "server.min.js")
    : resolve(engineDir, "dist", "index.js");

  const home = process.env.HOME ?? "/tmp";
  const pathEnv = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

  const plist = buildPlist({ label, nodePath, serverPath, hiveHome, home, pathEnv, logsDir });
```

The generated plist's `WorkingDirectory` is still set to `hiveHome` (inside `buildPlist`) — do not change that. Only `serverPath` moves under `.hive/`.

Everything after `writeFileSync(plistPath, plist);` (console log, symlink management, launchctl load) stays untouched.

- [ ] **Step 4:** Verify.

Run: `grep -n "pkgRoot\|pkg_root" src/cli/daemon.ts`
Expected: no matches.

Run: `npx tsc --noEmit src/cli/daemon.ts`
Expected: error at the caller in `src/cli.ts` — that's Task 10.

- [ ] **Step 5:** Commit.

```bash
git add src/cli/daemon.ts
git commit -m "feat(cli/daemon): plist entry point reads from engineDir, extract buildPlist helper (KPR-52)"
```

---

### Task 10: Update `startDaemon` call site — `src/cli.ts`

**Files:**
- Modify: `src/cli.ts` (line ~123)

- [ ] **Step 1:** Drop the `PKG_ROOT` argument.

Replace line 123:

```ts
      await startDaemon(PKG_ROOT);
```

with:

```ts
      await startDaemon();
```

The non-daemon `hive start` path immediately below (lines 126–129) continues to use `PKG_ROOT` — leave it alone. Per spec: `import.meta.dirname` from compiled `cli.js` already resolves to the engine root after Phase 2, so `PKG_ROOT` naturally becomes `<engineDir>`. No regression.

- [ ] **Step 2:** Verify full typecheck.

Run: `npx tsc --noEmit`
Expected: zero errors across the whole codebase.

- [ ] **Step 3:** Commit.

```bash
git add src/cli.ts
git commit -m "refactor(cli): drop pkgRoot arg from startDaemon (KPR-52)"
```

---

### Task 11: Add live-plist drift check to `src/cli/doctor.ts`

**Files:**
- Modify: `src/cli/doctor.ts`

This is the mitigation for "stale plist surviving upgrade" (runtime failure mode #3 in the spec). A hive may run 0.2.0 successfully from the new entry point while the on-disk plist still points at the old 0.1.x path — if launchd is later reloaded, it will fail. `hive doctor` should surface that.

- [ ] **Step 1:** Add the required imports at the top of `src/cli/doctor.ts`.

The file already imports `resolve` from `node:path` (line 1) and `existsSync` is NOT currently imported. Add `readFileSync` and `existsSync` from `node:fs`, and `engineDir` from `../paths.js`. The existing `paths.js` import (line 18) becomes:

```ts
import { engineDir, hiveHome } from "../paths.js";
```

Add a new import near the top:

```ts
import { existsSync, readFileSync } from "node:fs";
```

Do NOT add `import { config } from "../config.js"` — `doctor.ts` deliberately loads config lazily via `tryLoadConfig()` (see lines 56–59) so `hive doctor` can still diagnose a broken-config instance. Use the already-resolved `config` local from `tryLoadConfig()`'s return value.

- [ ] **Step 2:** Append a new `Check` literal to the `checks: Check[]` array under the `// ── Services ──` comment (after the existing "Slack auth.test" check at line 195).

The file uses `Check` objects with shape `{ name, group, required, test, remedy }`. `test` returns `boolean | Promise<boolean>`. Append:

```ts
    {
      name: "live plist points at engine entry",
      group: "services",
      required: false,
      test: async () => {
        if (!config) return true; // Config group already reports the broken-config case
        const label = `com.hive.${config.instance.id}.agent`;
        const home = process.env.HOME ?? "";
        const plistPath = resolve(home, "Library/LaunchAgents", `${label}.plist`);
        if (!existsSync(plistPath)) return true; // No live plist = nothing to verify (not this check's job to create one)
        const plist = readFileSync(plistPath, "utf-8");
        const expectedEntry = resolve(engineDir, "dist", "index.js");
        const expectedMinified = resolve(engineDir, "pkg", "server.min.js");
        return plist.includes(expectedEntry) || plist.includes(expectedMinified);
      },
      remedy: "Live plist ProgramArguments does not reference <engineDir>/dist/index.js. Run `hive daemon start` to regenerate the plist.",
    },
```

Rationale:
- `required: false` — this is advisory (a stale plist can still boot Hive as long as the node process happens to be running from the right path), so it prints with `○` not `✗` and doesn't fail the doctor run.
- Returns `true` when config is null or plist is absent — those are "not applicable" cases, and other checks surface the root cause.
- Resolves the plist **file path** directly (`~/Library/LaunchAgents/<label>.plist`). Do **not** reuse `resolveServicePath` from `doctor-checks.js` — despite the name, that helper returns the plist's `WorkingDirectory` contents (the deploy dir), not the path to the plist file itself. `readFileSync` on it would throw EISDIR.
- Label derived from `config.instance.id` matches the pattern in `src/cli/daemon.ts:getLabel()`, so multi-instance installs (`com.hive.dodi.agent`, `com.hive.keepur.agent`) are handled correctly. Note: the header log at `doctor.ts:43` still hardcodes `"com.hive.agent"` — that's a pre-existing minor bug, out of scope for this PR.

- [ ] **Step 3:** Verify.

Run: `npx tsc --noEmit`
Expected: zero errors.

Run: `npm run lint -- src/cli/doctor.ts`
Expected: no lint errors.

- [ ] **Step 4:** Commit.

```bash
git add src/cli/doctor.ts
git commit -m "feat(doctor): warn when live plist ProgramArguments drifts from engineDir (KPR-52)"
```

---

### Task 12: Update and add tests

**Files:**
- Modify: `src/skills/instance-git.test.ts`
- Create: `src/paths.test.ts`
- Create: `src/cli/daemon.test.ts`
- Create: `src/skills/integrity.test.ts`

- [ ] **Step 1:** Update `src/skills/instance-git.test.ts`.

The test helper at lines 9–17 hardcodes `.hive/git`. Change the `gitDir` derivation to `.hive-state/git`:

```ts
function git(hiveHome: string, ...args: string[]): string {
  const gitDir = resolve(hiveHome, ".hive-state", "git");
  return execFileSync("git", [...args], {
    cwd: hiveHome,
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome },
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}
```

And the assertion at line 33:

```ts
    const gitDir = resolve(tmp, ".hive-state", "git");
    expect(existsSync(gitDir)).toBe(true);
```

Also update the test name at line 30 for clarity:

```ts
  it("initInstanceGit creates .hive-state/git with both branches", () => {
```

- [ ] **Step 2:** Create `src/paths.test.ts`.

```ts
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { engineDir, hiveHome, hiveStateDir, instanceGitDir } from "./paths.js";

describe("paths", () => {
  it("engineDir resolves to <hiveHome>/.hive", () => {
    expect(engineDir).toBe(resolve(hiveHome, ".hive"));
  });

  it("hiveStateDir resolves to <hiveHome>/.hive-state", () => {
    expect(hiveStateDir).toBe(resolve(hiveHome, ".hive-state"));
  });

  it("instanceGitDir is under hiveStateDir", () => {
    expect(instanceGitDir).toBe(resolve(hiveStateDir, "git"));
  });
});
```

- [ ] **Step 3:** Create `src/cli/daemon.test.ts`.

`buildPlist` was already extracted as an exported helper in Task 9, so the test can call it directly without invoking `launchctl` or `writeFileSync`.

Test (`src/cli/daemon.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { buildPlist } from "./daemon.js";

describe("buildPlist", () => {
  it("ProgramArguments points at the provided serverPath", () => {
    const plist = buildPlist({
      label: "com.hive.test.agent",
      nodePath: "/usr/local/bin/node",
      serverPath: "/home/me/hive/.hive/dist/index.js",
      hiveHome: "/home/me/hive",
      home: "/home/me",
      pathEnv: "/usr/bin",
      logsDir: "/home/me/hive/logs",
    });
    expect(plist).toContain("<string>/home/me/hive/.hive/dist/index.js</string>");
  });

  it("WorkingDirectory stays at hiveHome (not under .hive/)", () => {
    const plist = buildPlist({
      label: "com.hive.test.agent",
      nodePath: "/usr/local/bin/node",
      serverPath: "/home/me/hive/.hive/dist/index.js",
      hiveHome: "/home/me/hive",
      home: "/home/me",
      pathEnv: "/usr/bin",
      logsDir: "/home/me/hive/logs",
    });
    expect(plist).toMatch(/<key>WorkingDirectory<\/key>\s*<string>\/home\/me\/hive<\/string>/);
  });
});
```

- [ ] **Step 4:** Create `src/skills/integrity.test.ts`.

Scope the test to `writeSnapshot` only — that's the function whose signature actually changed. `checkAllowlistDrift` is already try/catch-wrapped and communicates via `log.warn` with no return value or throw, so a meaningful test would require refactoring the function to return the warning list. That refactor is out of scope for Phase 2 — the allowlist change is simple enough to verify by eye in review, and a future PR can add return-value-based testability alongside whatever change needs it.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeSnapshot } from "./integrity.js";

describe("writeSnapshot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "integrity-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes installed-snapshot.json under stateDir, not packageRoot", () => {
    const packageRoot = join(tmp, "engine");
    const stateDir = join(tmp, "state");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"name":"x"}');

    writeSnapshot(stateDir, packageRoot, ["package.json"]);

    expect(existsSync(resolve(stateDir, "installed-snapshot.json"))).toBe(true);
    expect(existsSync(resolve(packageRoot, ".hive", "installed-snapshot.json"))).toBe(false);
  });

  it("records declared files with sha256 hashes", () => {
    const packageRoot = join(tmp, "engine");
    const stateDir = join(tmp, "state");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), '{"name":"x"}');

    writeSnapshot(stateDir, packageRoot, ["package.json"]);

    const snapshot = JSON.parse(readFileSync(resolve(stateDir, "installed-snapshot.json"), "utf-8"));
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toHaveProperty("path", "package.json");
    expect(snapshot[0].hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 5:** Run the suite.

Run: `npm run test -- src/paths.test.ts src/skills/instance-git.test.ts src/skills/integrity.test.ts src/cli/daemon.test.ts`
Expected: all tests pass.

- [ ] **Step 6:** Commit.

```bash
git add src/paths.test.ts src/cli/daemon.test.ts src/skills/integrity.test.ts src/skills/instance-git.test.ts
git commit -m "test: cover engineDir/hiveStateDir paths, plist builder, writeSnapshot signature (KPR-52)"
```

---

### Task 13: Update `service/deploy.sh` rsync targets

**Files:**
- Modify: `service/deploy.sh` (lines 194–195)

- [ ] **Step 1:** Redirect the sync targets into `.hive/`.

Replace lines 194–195:

```bash
run_cmd rsync -a --delete "$BUILD_DIR/dist/" "$DEPLOY_DIR/dist/"
[[ -d "$BUILD_DIR/plugins/claude-code" ]] && run_cmd rsync -a --delete "$BUILD_DIR/plugins/claude-code/" "$DEPLOY_DIR/plugins/claude-code/"
```

with:

```bash
# Ensure engine dir exists (wipe-and-replace target)
run_cmd mkdir -p "$DEPLOY_DIR/.hive"
run_cmd rsync -a --delete "$BUILD_DIR/dist/" "$DEPLOY_DIR/.hive/dist/"
[[ -d "$BUILD_DIR/plugins/claude-code" ]] && run_cmd rsync -a --delete "$BUILD_DIR/plugins/claude-code/" "$DEPLOY_DIR/.hive/plugins/claude-code/"
```

Everything else in `deploy.sh` stays — the `git pull --ff-only` in the deploy dir, skill auto-commit, `npm install --omit=dev` at the deploy root, etc. All of that is Phase 3's problem, not Phase 2's. Phase 2 keeps `deploy.sh` working end-to-end with the new layout; the wholesale rewrite lands later.

Caveat worth flagging in the PR description: after this change, `deploy.sh` assumes the deploy dir has already had its engine contents relocated into `.hive/`. For live dodi/keepur instances that's Phase 5's job. The working assumption for this PR's smoke test is a fresh `$DEPLOY_DIR` with an empty `.hive/` to receive the rsync.

- [ ] **Step 2:** Shell-lint.

Run: `shellcheck service/deploy.sh`
Expected: no new errors vs. pre-change state (existing warnings from elsewhere in the file are not this PR's problem).

- [ ] **Step 3:** Commit.

```bash
git add service/deploy.sh
git commit -m "chore(deploy): sync engine artifacts into .hive/ (KPR-52)"
```

---

### Task 14: Quality gate

**Files:** none (runs the repo's `check` command).

- [ ] **Step 1:** Run the full check.

Run: `npm run check`
Expected: `typecheck + lint + format + test` all pass.

- [ ] **Step 2:** Smoke-test dev mode.

Run: `npm run dev` (in a separate terminal)
Expected: Hive boots, logs `"Hive is running"`. Dev mode runs from the repo root (not an instance dir), so the `.hive/` layout does not apply — this confirms the paths.ts changes didn't regress dev-mode path resolution.

Kill with Ctrl-C after you see the startup banner.

- [ ] **Step 3:** Fresh-install smoke test (manual, documented in PR description).

Build a tarball from this branch, extract it into an empty `<tmpinstance>/.hive/`, drop in a minimal `hive.yaml` + `.env` at `<tmpinstance>/`, run `hive daemon start` (or run the compiled `.hive/dist/index.js` directly with `HIVE_HOME=<tmpinstance>`). Confirm the logs say `"Hive is running"`. This is the acceptance criterion from the spec — validating it manually before handing off is cheaper than discovering it's broken in CI.

If the smoke test fails, fix the root cause and re-run `npm run check` before proceeding.

- [ ] **Step 4:** Nothing to commit (no new files).

---

## Open questions resolved during execution

- `com.hive.personal.agent.plist` listed in the spec's "Files touched" is not present on this branch; no change applies.
- `hive.yaml.example` carries no `plugins/claude-code/` references; no update needed beyond Phase 2's scope.
- The spec's `src/paths.ts` sketch omits the `hiveMetaDir` export's fate — this plan deletes it cleanly because every caller is migrated in the same PR.

## Cross-phase dependencies worth noting (not in this PR)

- Phase 3 (`deploy.sh` rewrite) will replace the minimal rsync change in Task 13 with a fundamentally different flow. That PR will conflict with this one; that's expected and Phase 3 inherits the merged changes as its baseline.
- Phase 4 (installer docs refresh) will land the first real caller of `writeSnapshot(stateDir, packageRoot, declaredFiles)`. Phase 2 leaves the function with the correct signature and no callers — Phase 4 plugs in without a compat shim.
- Phase 5 (migration script) reads the old `<instance>/.hive/` metadata dir contents, rewrites them into `<instance>/.hive-state/`, and relocates engine artifacts into `<instance>/.hive/`. Phase 5 does not depend on the startup guard from Task 5 because it does the layout swap before re-starting the engine.
