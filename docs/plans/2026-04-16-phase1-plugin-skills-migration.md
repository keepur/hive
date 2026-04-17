# Phase 1: Plugin Architecture, Skills Registry Seed, and Skill Migration

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Make `hive plugin add/remove/list` work end-to-end with npm-installed plugins, seed the default skills registry, and migrate agent-authored skills out of the dodi plugin tree into customer space.

**Architecture:** Plugin loader and agent-runner get dual-path resolution (npm-installed `node_modules/<pkg>/` + in-tree `<name>/` fallback). Plugin CLI gets post-install validation, `hive.yaml` config tracking, and LaunchAgent auto-restart. Skills from `plugins/dodi/skills/` are deleted from the repo and migrated to customer space on dodi-hive via a one-time script.

**Tech Stack:** TypeScript, Node child_process (`execFileSync`), yaml library, vitest

**Spec:** `docs/specs/2026-04-16-phase1-plugin-skills-migration-design.md`

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/cli/hive-config.ts` | **Create** — shared `readConfig`/`writeConfig` for hive.yaml |
| `src/cli/hive-restart.ts` | **Create** — LaunchAgent detection + restart utility |
| `src/cli/plugin.ts` | **Rewrite** — add/remove/list with validation + config tracking + restart |
| `src/cli/registry.ts` | **Modify** — import shared config utils |
| `src/plugins/plugin-loader.ts` | **Modify** — dual-path resolution |
| `src/plugins/plugin-loader.test.ts` | **Modify** — tests for dual-path |
| `src/agents/agent-runner.ts` | **Modify** — three-path MCP server resolution |
| `package.json` | **Modify** — add `hiveApi` field |
| `plugins/dodi/skills/` | **Delete** — all skill suites removed |
| `plugins/dodi/plugin.yaml` | **Modify** — remove skills reference |
| `scripts/migrate-skills-to-customer-space.ts` | **Create** — one-time migration script |

---

### Task 1: Extract shared config utilities

**Files:**
- Create: `src/cli/hive-config.ts`
- Modify: `src/cli/registry.ts`

- [ ] **Step 1:** Create `src/cli/hive-config.ts`

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hiveHome } from "../paths.js";

/** Resolve the hive.yaml config file path. */
export function configPath(): string {
  return resolve(hiveHome, process.env.HIVE_CONFIG || "hive.yaml");
}

/** Read hive.yaml as a plain object. Returns {} if file doesn't exist. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readConfig(path?: string): any {
  const p = path ?? configPath();
  if (!existsSync(p)) return {};
  return parseYaml(readFileSync(p, "utf-8")) ?? {};
}

/** Write a plain object back to hive.yaml. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function writeConfig(data: any, path?: string): void {
  const p = path ?? configPath();
  writeFileSync(p, stringifyYaml(data, { lineWidth: 0 }));
}
```

- [ ] **Step 2:** Update `src/cli/registry.ts` to use the shared module

Replace the local `readConfig`/`writeConfig` functions and the config path computation at the top of `runRegistry`:

```typescript
// Replace these imports at the top:
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hiveHome } from "../paths.js";

// With:
import { readConfig, writeConfig, configPath } from "./hive-config.js";
```

Inside `runRegistry`, replace `const configPath = resolve(hiveHome, process.env.HIVE_CONFIG || "hive.yaml");` with `const cfgPath = configPath();` and update all `readConfig(configPath)` → `readConfig(cfgPath)`, `writeConfig(configPath, config)` → `writeConfig(config, cfgPath)`.

**⚠ Argument order flip:** The old local `writeConfig(path, data)` has the path first. The new shared `writeConfig(data, path?)` has data first. Every call site in `registry.ts` must be updated — `writeConfig(configPath, config)` → `writeConfig(config, cfgPath)`. Getting this wrong silently writes the path string as YAML content.

Delete the local `readConfig` and `writeConfig` functions at the bottom of the file.

- [ ] **Step 3:** Verify

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 4:** Commit

```
feat(cli): extract shared hive-config utilities from registry.ts
```

---

### Task 2: Create LaunchAgent restart utility

**Files:**
- Create: `src/cli/hive-restart.ts`

- [ ] **Step 1:** Create `src/cli/hive-restart.ts`

```typescript
import { execFileSync } from "node:child_process";
import { readConfig } from "./hive-config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("hive-restart");

/**
 * Attempt to restart the Hive LaunchAgent if it's running.
 * Returns true if restart was triggered, false if service wasn't running.
 */
export function restartHiveService(): boolean {
  const config = readConfig();
  const instanceId = config.instanceId ?? config.id ?? "hive";
  const label = `com.hive.${instanceId}.agent`;

  // Check if the LaunchAgent is loaded (query specific label, not full list)
  try {
    execFileSync("launchctl", ["list", label], { stdio: "pipe" });
    // Exit code 0 means the service is loaded
  } catch {
    // Non-zero exit = not loaded
    return false;
  }

  // Get current user's UID for the gui/ domain
  const uid = execFileSync("id", ["-u"], {
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();

  try {
    execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], {
      stdio: "pipe",
    });
    log.info("Hive service restarted", { label });
    return true;
  } catch (err) {
    log.warn("Failed to restart hive service", { label, error: String(err) });
    return false;
  }
}
```

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 3:** Commit

```
feat(cli): add LaunchAgent restart utility
```

---

### Task 3: Plugin loader dual-path resolution

**Files:**
- Modify: `src/plugins/plugin-loader.ts:10-21`
- Modify: `src/plugins/plugin-loader.test.ts`

- [ ] **Step 1:** Update `loadPlugins` in `plugin-loader.ts`

Replace the plugin directory resolution (lines 13–20):

```typescript
// OLD:
    const pluginDir = resolve(rootDir, "plugins", name);
    const manifestPath = join(pluginDir, "plugin.yaml");

    if (!existsSync(manifestPath)) {
      log.warn("Plugin manifest not found, skipping", { plugin: name, path: manifestPath });
      continue;
    }
```

With:

```typescript
    // Dual-path resolution: npm-installed (node_modules/) first, in-tree fallback second
    const npmDir = resolve(rootDir, "plugins", "node_modules", name);
    const inTreeDir = resolve(rootDir, "plugins", name);
    const npmManifest = join(npmDir, "plugin.yaml");
    const inTreeManifest = join(inTreeDir, "plugin.yaml");

    let pluginDir: string;
    if (existsSync(npmManifest)) {
      pluginDir = npmDir;
    } else if (existsSync(inTreeManifest)) {
      pluginDir = inTreeDir;
    } else {
      log.warn("Plugin manifest not found, skipping", {
        plugin: name,
        tried: [npmManifest, inTreeManifest],
      });
      continue;
    }
```

The rest of the function (lines 22–63) references `pluginDir` and remains unchanged.

- [ ] **Step 2:** Update tests in `plugin-loader.test.ts`

Add a new test for the dual-path behavior:

```typescript
  it("resolves npm-installed plugin via node_modules/ path", () => {
    const manifestYaml = `name: npm-plugin\nhiveApi: "^1.0.0"\n`;
    vi.mocked(existsSync).mockImplementation((path: any) => {
      // Manifest exists at node_modules path, not in-tree
      return String(path).includes("node_modules/npm-plugin/plugin.yaml");
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["npm-plugin"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].dir).toContain("node_modules");
    expect(result[0].dir).toContain("npm-plugin");
  });

  it("falls back to in-tree path when node_modules path missing", () => {
    const manifestYaml = `name: intree\n`;
    vi.mocked(existsSync).mockImplementation((path: any) => {
      const p = String(path);
      // Only in-tree manifest exists
      if (p.includes("node_modules")) return false;
      return p.includes("intree");
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["intree"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].dir).not.toContain("node_modules");
  });

  it("resolves scoped npm package names", () => {
    const manifestYaml = `name: "@keepur/hive-plugin-foo"\nhiveApi: "^1.0.0"\n`;
    vi.mocked(existsSync).mockImplementation((path: any) => {
      return String(path).includes("node_modules/@keepur/hive-plugin-foo/plugin.yaml");
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["@keepur/hive-plugin-foo"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].dir).toContain("@keepur");
  });
```

Update the existing "sets dir to resolved plugin path" test to account for both paths being checked:

```typescript
  it("sets dir to resolved plugin path", () => {
    const manifestYaml = `name: foo\n`;
    vi.mocked(existsSync).mockImplementation((path: any) => {
      const p = String(path);
      // In-tree path exists (no node_modules match)
      if (p.includes("node_modules")) return false;
      return p.endsWith("plugin.yaml") || p.includes("foo");
    });
    vi.mocked(readFileSync).mockReturnValue(manifestYaml);

    const result = loadPlugins(["foo"], "/root");
    expect(result).toHaveLength(1);
    expect(result[0].dir).toContain("plugins");
    expect(result[0].dir).toContain("foo");
  });
```

- [ ] **Step 3:** Verify

Run: `npm run test -- src/plugins/plugin-loader.test.ts`
Expected: all tests pass

- [ ] **Step 4:** Commit

```
feat(plugins): dual-path resolution — node_modules/ then in-tree fallback
```

---

### Task 4: Agent-runner three-path MCP server resolution

**Files:**
- Modify: `src/agents/agent-runner.ts:617-620`

- [ ] **Step 1:** Update the plugin MCP server path resolution

Replace lines 617–620:

```typescript
        const devPath = resolve(DIST_DIR, `plugins/${plugin.name}/${serverDef.entry.replace(/\.ts$/, ".js")}`);
        const npmPath = resolve(hiveHome, "plugins", plugin.name, "dist", "mcp",
          serverDef.entry.replace(/\.ts$/, ".min.js").replace(/^.*\//, ""));
        const compiledPath = existsSync(npmPath) ? npmPath : devPath;
```

With:

```typescript
        // Three-path resolution, first that exists wins:
        // 1. Dev build from source (wins during active development)
        // 2. npm-installed under node_modules/ (new — for hive plugin add)
        // 3. In-tree fallback (legacy — plugins/dodi/ without node_modules)
        const entryJs = serverDef.entry.replace(/\.ts$/, ".js");
        const entryMin = serverDef.entry.replace(/\.ts$/, ".min.js").replace(/^.*\//, "");
        const devPath = resolve(DIST_DIR, `plugins/${plugin.name}/${entryJs}`);
        const npmPath = resolve(hiveHome, "plugins", "node_modules", plugin.name, "dist", "mcp", entryMin);
        const inTreePath = resolve(hiveHome, "plugins", plugin.name, "dist", "mcp", entryMin);
        const compiledPath = [devPath, npmPath, inTreePath].find((p) => existsSync(p)) ?? devPath;
```

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: no errors

Run: `npm run test`
Expected: existing tests pass (agent-runner tests mock the plugin paths)

- [ ] **Step 3:** Commit

```
feat(agent-runner): three-path plugin MCP server resolution
```

---

### Task 5: Rewrite plugin CLI

**Files:**
- Rewrite: `src/cli/plugin.ts`

- [ ] **Step 1:** Export `isHiveApiCompatible` from `plugin-loader.ts`

The function is currently module-private. Add `export` to the function declaration in `src/plugins/plugin-loader.ts:70`:

```typescript
// Change:
function isHiveApiCompatible(range: string, version: string): boolean {
// To:
export function isHiveApiCompatible(range: string, version: string): boolean {
```

- [ ] **Step 2:** Rewrite `src/cli/plugin.ts`

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { hiveHome } from "../paths.js";
import { readConfig, writeConfig, configPath } from "./hive-config.js";
import { restartHiveService } from "./hive-restart.js";
import { HIVE_PLUGIN_API_VERSION } from "../plugins/api-version.js";
import { isHiveApiCompatible } from "../plugins/plugin-loader.js";

const pluginsDir = resolve(hiveHome, "plugins");

export async function runPlugin(subcommand?: string, target?: string): Promise<void> {
  switch (subcommand) {
    case "add":
      return pluginAdd(target);
    case "remove":
      return pluginRemove(target);
    case "list":
      return pluginList();
    default:
      console.error("Usage: hive plugin <add|list|remove> [package]");
      process.exit(1);
  }
}

function pluginAdd(target?: string): void {
  if (!target) {
    console.error("Usage: hive plugin add <package-name>");
    process.exit(1);
  }

  // Step 1: npm install
  mkdirSync(pluginsDir, { recursive: true });
  const pkgJsonPath = resolve(pluginsDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    execFileSync("npm", ["init", "-y"], { cwd: pluginsDir, stdio: "pipe" });
  }

  console.log(`Installing ${target}...`);
  try {
    execFileSync("npm", ["install", target], { cwd: pluginsDir, stdio: "pipe" });
  } catch (err) {
    console.error(`Failed to install ${target}: ${String(err)}`);
    process.exit(1);
  }

  // Step 2: Post-install validation
  const installedDir = resolve(pluginsDir, "node_modules", target);
  const manifestPath = join(installedDir, "plugin.yaml");

  if (!existsSync(manifestPath)) {
    console.error(`Not a valid hive plugin — no plugin.yaml found in ${target}.`);
    rollbackInstall(target);
    process.exit(1);
  }

  const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
  const hiveApi: string | undefined = raw?.hiveApi ?? raw?.["hive-api"];

  if (hiveApi && !isHiveApiCompatible(hiveApi, HIVE_PLUGIN_API_VERSION)) {
    console.error(
      `Plugin requires hiveApi ${hiveApi} but this hive is ${HIVE_PLUGIN_API_VERSION}.`,
    );
    rollbackInstall(target);
    process.exit(1);
  }

  const version = raw?.version ?? "unknown";

  // Step 3: Update hive.yaml
  const cfgPath = configPath();
  const config = readConfig(cfgPath);
  if (!config.plugins) config.plugins = [];
  if (!config.plugins.includes(target)) {
    config.plugins.push(target);
    writeConfig(config, cfgPath);
    console.log("✓ Updated hive.yaml");
  }

  // Step 4: Restart
  const restarted = restartHiveService();
  if (restarted) {
    console.log("✓ Restarting hive... done");
  } else {
    console.log("Start hive to activate the plugin.");
  }

  console.log(
    `✓ Installed ${target} (v${version}${hiveApi ? `, hiveApi ${hiveApi}` : ""})`,
  );
}

function pluginRemove(target?: string): void {
  if (!target) {
    console.error("Usage: hive plugin remove <package-name>");
    process.exit(1);
  }

  if (!existsSync(pluginsDir)) {
    console.error("No plugins directory found.");
    process.exit(1);
  }

  console.log(`Removing ${target}...`);
  try {
    execFileSync("npm", ["uninstall", target], { cwd: pluginsDir, stdio: "pipe" });
  } catch (err) {
    console.error(`Failed to uninstall ${target}: ${String(err)}`);
    process.exit(1);
  }

  // Update hive.yaml — silently skip if not present (legacy plugin)
  const cfgPath = configPath();
  const config = readConfig(cfgPath);
  if (Array.isArray(config.plugins)) {
    const idx = config.plugins.indexOf(target);
    if (idx >= 0) {
      config.plugins.splice(idx, 1);
      writeConfig(config, cfgPath);
      console.log("✓ Updated hive.yaml");
    }
  }

  // Restart
  const restarted = restartHiveService();
  if (restarted) {
    console.log("✓ Restarting hive... done");
  } else {
    console.log("Restart hive to complete removal.");
  }

  console.log(`Removed ${target}`);
}

function pluginList(): void {
  const cfgPath = configPath();
  const config = readConfig(cfgPath);
  const pluginNames: string[] = config.plugins ?? [];

  if (pluginNames.length === 0) {
    console.log("No plugins configured in hive.yaml.");
    return;
  }

  console.log("Installed plugins:\n");
  for (const name of pluginNames) {
    // Dual-path resolution: node_modules/<name>/ then <name>/
    const npmDir = resolve(pluginsDir, "node_modules", name);
    const inTreeDir = resolve(pluginsDir, name);
    const npmManifest = join(npmDir, "plugin.yaml");
    const inTreeManifest = join(inTreeDir, "plugin.yaml");

    let manifestPath: string | null = null;
    let isInTree = false;

    if (existsSync(npmManifest)) {
      manifestPath = npmManifest;
    } else if (existsSync(inTreeManifest)) {
      manifestPath = inTreeManifest;
      isInTree = true;
    }

    if (!manifestPath) {
      console.log(`  ${name}  ⚠ not found on disk`);
      continue;
    }

    try {
      const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
      const version = raw?.version ?? "?";
      const hiveApi = raw?.hiveApi ?? raw?.["hive-api"] ?? "";
      const tag = isInTree ? "  [in-tree]" : "";
      console.log(
        `  ${name}  v${version}${hiveApi ? `  (hiveApi ${hiveApi})` : ""}${tag}`,
      );
    } catch {
      console.log(`  ${name}  ⚠ failed to read plugin.yaml`);
    }
  }
}

function rollbackInstall(target: string): void {
  try {
    execFileSync("npm", ["uninstall", target], { cwd: pluginsDir, stdio: "pipe" });
  } catch {
    // Best effort — the install may have partially failed
  }
}
```

- [ ] **Step 3:** Verify

Run: `npm run typecheck`
Expected: no errors

Run: `npm run build`
Expected: builds successfully

- [ ] **Step 4:** Commit

```
feat(cli): rewrite plugin add/remove/list with validation and auto-restart
```

---

### Task 6: Add `hiveApi` to package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1:** Add the `hiveApi` field to the root `package.json`

Add after the `version` field:

```json
  "hiveApi": "1.0.0",
```

This is informational — the loader reads `HIVE_PLUGIN_API_VERSION` from `src/plugins/api-version.ts`, not from `package.json`. The field exists for npm metadata and external tooling.

- [ ] **Step 2:** Commit

```
chore: add hiveApi field to package.json
```

---

### Task 7: Remove skills from dodi plugin

**Files:**
- Delete: `plugins/dodi/skills/` (entire directory)
- Modify: `plugins/dodi/plugin.yaml`

- [ ] **Step 1:** Delete `plugins/dodi/skills/`

```bash
rm -rf plugins/dodi/skills/
```

- [ ] **Step 2:** Update `plugins/dodi/plugin.yaml`

If the manifest has a `skills:` field or any reference to the skills directory, remove it. The dodi plugin retains its MCP servers and agent seeds.

- [ ] **Step 3:** Verify the dodi plugin still loads

Run: `npm run typecheck`
Expected: no errors

Run: `npm run build`
Expected: builds successfully (plugin loader only validates MCP server entries, not skills dirs)

- [ ] **Step 4:** Commit

```
refactor(dodi): remove agent-authored skills from plugin tree

Agent-created skills belong in customer space (<hiveHome>/skills/),
not plugin-bundled. The 5 skill suites are migrated to customer space
on dodi-hive via scripts/migrate-skills-to-customer-space.ts and
published to the default skills registry where appropriate.
```

---

### Task 8: Create migration script for dodi-hive

**Files:**
- Create: `scripts/migrate-skills-to-customer-space.ts`

This is a one-time script run on dodi-hive and Mike's mac-mini after deploy.

- [ ] **Step 1:** Create `scripts/migrate-skills-to-customer-space.ts`

```typescript
#!/usr/bin/env npx tsx
/**
 * One-time migration: copy agent-authored skills from plugins/dodi/skills/
 * to customer space (<hiveHome>/skills/) with agent-authored metadata.
 *
 * Run on each deployment after updating to the version that removes
 * plugins/dodi/skills/ from the repo.
 *
 * Usage: npx tsx scripts/migrate-skills-to-customer-space.ts [source-dir]
 *
 * source-dir defaults to ./plugins/dodi/skills/ (for running before deploy)
 * or can point to a backup of the old skills directory.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { readSkillMd, writeSkillMd } from "../src/skills/frontmatter.js";
import { commitToState } from "../src/skills/instance-git.js";

// Resolve paths
const sourceDir = process.argv[2] ?? resolve("plugins", "dodi", "skills");
const hiveHome = process.env.HIVE_HOME ?? process.cwd();
const targetSkillsDir = resolve(hiveHome, "skills");

if (!existsSync(sourceDir)) {
  console.error(`Source directory not found: ${sourceDir}`);
  console.error("Pass the path to the old plugins/dodi/skills/ directory as an argument.");
  process.exit(1);
}

const timestamp = new Date().toISOString();
const migrated: string[] = [];

// Walk each workflow suite
for (const suite of readdirSync(sourceDir)) {
  const suiteDir = join(sourceDir, suite);
  if (!statSync(suiteDir).isDirectory()) continue;

  const targetSuiteDir = join(targetSkillsDir, suite);

  if (existsSync(targetSuiteDir)) {
    console.log(`⚠ Skipping ${suite} — already exists in customer space`);
    continue;
  }

  // Copy entire suite preserving structure
  mkdirSync(targetSuiteDir, { recursive: true });
  cpSync(suiteDir, targetSuiteDir, { recursive: true });

  // Inject metadata on each SKILL.md
  const skillsSubDir = join(targetSuiteDir, "skills");
  if (existsSync(skillsSubDir)) {
    for (const skill of readdirSync(skillsSubDir)) {
      const skillMdPath = join(skillsSubDir, skill, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      try {
        const { frontmatter, body } = readSkillMd(skillMdPath);
        if (!frontmatter.origin) {
          frontmatter.origin = { type: "agent-authored" };
          frontmatter.author = {
            "agent-id": "migrated-from-plugin",
            "authored-at": timestamp,
            reason:
              "Migrated from plugins/dodi/skills/ — agent-authored content restored to customer space",
          };
          writeSkillMd(skillMdPath, frontmatter, body);
          console.log(`  ✓ ${suite}/skills/${skill}/SKILL.md — metadata injected`);
        } else {
          console.log(`  → ${suite}/skills/${skill}/SKILL.md — origin already set, skipping`);
        }
      } catch (err) {
        console.error(`  ✗ ${suite}/skills/${skill}/SKILL.md — ${String(err)}`);
      }
    }
  }

  migrated.push(suite);
  console.log(`✓ Migrated ${suite}`);
}

if (migrated.length === 0) {
  console.log("\nNothing to migrate.");
  process.exit(0);
}

// Commit to state branch
const relPaths = migrated.map((s) => relative(hiveHome, join(targetSkillsDir, s)));
try {
  commitToState(
    hiveHome,
    relPaths,
    `migrate: restore ${migrated.length} agent-authored skill suites from plugins/dodi/skills/ to customer space`,
    "migrated-from-plugin",
  );
  console.log(`\n✓ Committed to state branch (${migrated.length} suites)`);
} catch (err) {
  console.warn(`\n⚠ State branch commit failed: ${String(err)}`);
  console.warn("Skills were copied but not committed. Run manually if needed.");
}

console.log(`\nMigration complete. ${migrated.length} suites moved to ${targetSkillsDir}`);
```

- [ ] **Step 2:** Verify the script compiles

Run: `npx tsx --check scripts/migrate-skills-to-customer-space.ts`
Expected: no syntax errors

- [ ] **Step 3:** Commit

```
feat: add one-time skill migration script for dodi-hive deployments
```

---

### Task 9: Run checks

- [ ] **Step 1:** Run full check suite

Run: `npm run check`
Expected: typecheck + lint + format + test all pass

- [ ] **Step 2:** Fix any issues found

If lint/format issues, run `npm run format` and fix lint errors.

- [ ] **Step 3:** Final commit (if needed)

```
chore: fix lint/format after plugin architecture changes
```

---

### Task 10: Skills registry seed (Keepur-side, external)

This task creates the `github.com/keepur/hive-skills` repo. It is executed outside the hive repo.

- [ ] **Step 1:** Create the repo

```bash
gh repo create keepur/hive-skills --public --description "Default skills registry for Hive"
```

- [ ] **Step 2:** Set up the directory structure

```
hive-skills/
├── README.md
└── skills/
    ├── morning-briefing/
    │   └── SKILL.md
    └── build-agent/
        └── SKILL.md
```

Each SKILL.md gets the registry frontmatter format with a `workflow:` field:

```yaml
---
name: morning-briefing
description: Aggregate standup prep reports into a unified morning briefing for leadership
agents: [all]
workflow: morning-briefing
---
```

Skill prose is generalized from the dodi-specific versions — remove channel IDs, dodi-specific tool names, agent-name hardcoding. The skill should work on any hive with the relevant MCP servers.

- [ ] **Step 3:** Triage the 5 skill suites

Per spec §4.2.2, triage at the suite level. Each suite contains 1–6 individual skills. Expected dispositions:

| Suite | Skills | Disposition | Notes |
|-------|--------|------------|-------|
| `morning-briefing` | 6 (orchestrator + 5 dept preps) | Publish (rewritten) | Generalize: remove channel IDs, dodi agent names. Dept standup skills need tool-name cleanup. Drop `marketing-standup-prep` (stub). |
| `agent-builder` | 1 (`build-agent`) | Publish (as-is) | Already generic — uses admin MCP tools |
| `project-tools` | 3 (`quality-gate`, `create-tests`, `dev-servers`) | Partial publish | `quality-gate` + `create-tests` are generic dev workflow. Drop `dev-servers` (dodi_v2-specific). |
| `inbound-triage` | 1 (`inbound-lead-triage`) | Drop | Requires HubSpot plugin + dodi-specific sales workflow |
| `jasper-reports` | 2 (`blocker-alert`, `deploy-report`) | Drop | Hardcodes channel IDs and repo names |

Target per spec: **≥2 skills** in the registry at `skills-v1.0`. Likely outcome: ~4 (morning-briefing orchestrator, build-agent, quality-gate, create-tests).

- [ ] **Step 4:** Tag and push

```bash
git tag skills-v1.0
git push origin main --tags
```

- [ ] **Step 5:** Smoke test from hive

```bash
# From the hive dev dir:
npx tsx src/cli.ts skill add morning-briefing
npx tsx src/cli.ts skill list
npx tsx src/cli.ts skill remove morning-briefing
```

Expected: install succeeds, skill appears in list with registry origin, remove cleans up.

---

## Deployment Sequence

After the PR merges and deploys:

1. **Before deploy:** Run the migration script on dodi-hive to copy skills to customer space:
   ```bash
   cd ~/services/hive
   npx tsx scripts/migrate-skills-to-customer-space.ts ./plugins/dodi/skills/
   ```

2. **Deploy:** Normal deploy flow — pulls, builds, restarts. The new code no longer has `plugins/dodi/skills/`, but customer-space copies are already in place from step 1.

3. **Verify:** Check that agents still see their skills (customer-space versions now shadow the deleted plugin versions).

4. **Mike's mac-mini:** Same migration if `plugins/dodi/skills/` exists there.
