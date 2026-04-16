# Skills Customer-Space & Registry Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Eliminate shipped-with-core skills, partition the filesystem into engine-owned vs customer-owned, add instance-local git audit, implement the `hive skill` and `hive registry` CLI, and wire boot-time integrity checks.

**Architecture:** The skill loader gains a second scan path (`<hiveHome>/skills/`) for customer-space skills alongside existing plugin-bundled scans. A write guard intercepts agent SKILL.md writes to inject provenance metadata and commit to an instance-local git `state` branch. The registry is a git repo; `hive skill add` shallow-clones, extracts, projects flat→nested, and records origin metadata. Boot-time checks verify package integrity via `installed-snapshot.json`.

**Tech Stack:** TypeScript, Node 24, git CLI (via `execFileSync`), SHA-256 (`node:crypto`), vitest

**Spec references:**
- `docs/specs/2026-04-15-skills-customer-space-design.md` (customer-space spec)
- `docs/specs/2026-04-15-skills-registry-design.md` (registry spec)

---

## File Map

### New files

| File | Responsibility |
|------|----------------|
| `src/skills/skill-paths.ts` | Resolve customer-space skills dir, `.hive/` metadata dir, snapshot paths |
| `src/skills/write-guard.ts` | Intercept SKILL.md writes: path constraint, frontmatter injection, state-branch commit |
| `src/skills/frontmatter.ts` | Parse and serialize SKILL.md YAML frontmatter (shared by loader, write guard, CLI) |
| `src/skills/content-hash.ts` | SHA-256 content hash per registry spec §8.3 |
| `src/skills/instance-git.ts` | Initialize and operate instance-local git repo (installed/state branches) |
| `src/skills/integrity.ts` | Boot-time package integrity check + allowlist drift warnings |
| `src/skills/upgrade-notice.ts` | First-boot upgrade notice (one-time, §10.5) |
| `src/skills/registry-fetch.ts` | Git fetch layer: shallow-clone, partial-clone, cleanup |
| `src/skills/registry-resolver.ts` | Read `skillRegistries` from config, resolve registry for a skill name |
| `src/skills/projection.ts` | Flat→nested projection rule (registry `workflow:` → runtime path) |
| `src/skills/install.ts` | Full install flow: fetch → resolve → project → copy → metadata → commit |
| `src/skills/upgrade.ts` | Upgrade flow: fetch → SHA compare → three-way diff → prompt → commit |
| `src/skills/remove.ts` | Remove flow: warn-if-modified → delete → commit |
| `src/cli/skill.ts` | `hive skill add/list/upgrade/remove/search` CLI handler |
| `src/cli/registry.ts` | `hive registry add/list/remove` CLI handler |
| `src/skills/skill-paths.test.ts` | Tests for path resolution |
| `src/skills/frontmatter.test.ts` | Tests for frontmatter parse/serialize |
| `src/skills/content-hash.test.ts` | Tests for content hashing |
| `src/skills/instance-git.test.ts` | Tests for git operations |
| `src/skills/projection.test.ts` | Tests for flat→nested projection |
| `src/skills/install.test.ts` | Tests for install flow (mocked git) |
| `src/skills/upgrade.test.ts` | Tests for upgrade flow |

### Modified files

| File | Change |
|------|--------|
| `src/agents/skill-loader.ts` | Remove core scan, add customer-space scan, reverse collision precedence (customer wins over plugin) |
| `src/agents/skill-loader.test.ts` | Update tests for new scan order and collision rules |
| `src/agents/agent-manager.ts` | Pass `hiveHome` to `loadSkillIndex` for customer-space path |
| `src/index.ts` | Add boot-time integrity check, upgrade notice, watch `<hiveHome>/skills/` instead of `resolve("skills")` |
| `src/config.ts` | Add `skillRegistries` config field |
| `src/paths.ts` | Export `skillsDir` and `hiveMetaDir` helpers |
| `src/cli.ts` | Add `skill` and `registry` CLI commands |
| `build/bundle.ts` | No change needed (CLI entry point is already bundled) |

---

### Task 1: Skill Paths & Frontmatter Utilities

**Files:**
- Create: `src/skills/skill-paths.ts`
- Create: `src/skills/frontmatter.ts`
- Create: `src/skills/content-hash.ts`
- Modify: `src/paths.ts:39-40`
- Test: `src/skills/skill-paths.test.ts`
- Test: `src/skills/frontmatter.test.ts`
- Test: `src/skills/content-hash.test.ts`

- [ ] **Step 1:** Add `skillsDir` and `hiveMetaDir` exports to `src/paths.ts`

```typescript
/** Customer-space skills directory. */
export const skillsDir = resolve(hiveHome, "skills");

/** Instance-local metadata directory (.hive/). */
export const hiveMetaDir = resolve(hiveHome, ".hive");
```

- [ ] **Step 2:** Create `src/skills/skill-paths.ts`

```typescript
import { resolve, join } from "node:path";
import { skillsDir } from "../paths.js";

/**
 * Resolve the runtime path for a skill given its workflow and name.
 * Layout: <skillsDir>/<workflow>/skills/<name>/SKILL.md
 */
export function skillRuntimePath(workflow: string, name: string): string {
  return join(skillsDir, workflow, "skills", name);
}

/**
 * Check whether a given absolute path is inside the customer-space skills dir.
 */
export function isInsideCustomerSpace(path: string): boolean {
  const resolved = resolve(path);
  const base = resolve(skillsDir);
  return resolved.startsWith(base + "/") || resolved === base;
}

/**
 * Extract workflow and skill name from a runtime path inside customer space.
 * Returns null if the path doesn't match the expected layout.
 */
export function parseSkillPath(path: string): { workflow: string; name: string } | null {
  const resolved = resolve(path);
  const base = resolve(skillsDir);
  if (!resolved.startsWith(base + "/")) return null;
  const rel = resolved.slice(base.length + 1);
  // Expected: <workflow>/skills/<name>/SKILL.md or <workflow>/skills/<name>
  const match = rel.match(/^([^/]+)\/skills\/([^/]+)/);
  if (!match) return null;
  return { workflow: match[1]!, name: match[2]! };
}
```

- [ ] **Step 3:** Create `src/skills/frontmatter.ts`

Handles parsing and serializing SKILL.md YAML frontmatter. The parser must handle:
- Standard fields: `name`, `description`, `agents`, `workflow`
- Origin block: `origin.type`, `origin.source`, `origin.base-version`, `origin.base-tag`, `origin.base-content-hash`, `origin.installed-at`, `origin.modified`
- Author block: `author.agent-id`, `author.authored-at`, `author.reason`

```typescript
import { readFileSync, writeFileSync } from "node:fs";

export interface SkillOrigin {
  type: "registry" | "agent-authored";
  source?: string;
  "base-version"?: string;
  "base-tag"?: string;
  "base-content-hash"?: string;
  "installed-at"?: string;
  modified?: boolean;
}

export interface SkillAuthor {
  "agent-id": string;
  "authored-at": string;
  reason?: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  agents: string[];
  workflow?: string;
  origin?: SkillOrigin;
  author?: SkillAuthor;
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Uses simple regex-based parsing for the known fields — no YAML library dependency.
 * Returns the parsed frontmatter and the body (everything after the closing ---).
 */
export function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  // Implementation: regex match ^---\n ... \n--- boundary,
  // then parse known fields from the YAML block.
  // For nested blocks (origin:, author:), parse indented key: value lines.
  // Agents field: support both inline [a, b] and list format.
  // This is a simple parser for known fields, not a general YAML parser.
  throw new Error("TODO: implement");
}

/**
 * Serialize frontmatter + body back to SKILL.md content string.
 * Produces valid YAML frontmatter in a canonical field order.
 */
export function serializeFrontmatter(fm: SkillFrontmatter, body: string): string {
  throw new Error("TODO: implement");
}

/**
 * Read a SKILL.md file and return parsed frontmatter + body.
 */
export function readSkillMd(path: string): { frontmatter: SkillFrontmatter; body: string } {
  return parseFrontmatter(readFileSync(path, "utf-8"));
}

/**
 * Write a SKILL.md file from frontmatter + body.
 */
export function writeSkillMd(path: string, fm: SkillFrontmatter, body: string): void {
  writeFileSync(path, serializeFrontmatter(fm, body));
}

/**
 * Strip the origin: block from frontmatter content string for content-hash computation.
 * Returns the SKILL.md content with origin: block removed from frontmatter.
 */
export function stripOriginBlock(content: string): string {
  throw new Error("TODO: implement");
}
```

Note: Use simple regex/string parsing, NOT a YAML library. The frontmatter shape is fixed and known; a general parser adds unnecessary dependency.

- [ ] **Step 4:** Create `src/skills/content-hash.ts`

Per registry spec §8.3: SHA-256 of SKILL.md (origin: block excluded) + sidecar files in alphabetical path order, separated by null bytes.

```typescript
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripOriginBlock } from "./frontmatter.js";

/**
 * Compute the base-content-hash for a skill directory.
 * Per registry spec §8.3:
 * - SKILL.md content with origin: frontmatter block excluded
 * - Concatenated with all sidecar files in alphabetical relative-path order
 * - Files separated by null bytes (\x00)
 * - SHA-256, hex-encoded
 */
export function computeContentHash(skillDir: string): string {
  const files = collectFiles(skillDir).sort();
  const hash = createHash("sha256");

  for (let i = 0; i < files.length; i++) {
    if (i > 0) hash.update("\x00");
    const filePath = join(skillDir, files[i]!);
    const content = readFileSync(filePath, "utf-8");
    if (files[i] === "SKILL.md") {
      hash.update(stripOriginBlock(content));
    } else {
      hash.update(content);
    }
  }

  return hash.digest("hex");
}

/** Recursively collect all file paths relative to dir, sorted alphabetically. */
function collectFiles(dir: string, prefix = ""): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full, rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}
```

- [ ] **Step 5:** Write tests for all three modules

Tests should cover:
- `skill-paths.test.ts`: `isInsideCustomerSpace` with valid/invalid paths, `parseSkillPath` with valid layout and non-matching paths, `skillRuntimePath` output format
- `frontmatter.test.ts`: parse inline agents `[a, b]`, parse list agents, parse with origin block, parse with author block, serialize roundtrip, `stripOriginBlock` removes only origin block
- `content-hash.test.ts`: hash of single SKILL.md, hash with sidecars, hash excludes origin block, hash is stable across repeated calls

- [ ] **Step 6:** Verify

Run: `npx vitest run src/skills/`
Expected: All tests pass

- [ ] **Step 7:** Commit

```bash
git add src/paths.ts src/skills/skill-paths.ts src/skills/frontmatter.ts src/skills/content-hash.ts src/skills/*.test.ts
git commit -m "feat(skills): add path resolution, frontmatter parser, and content-hash utilities"
```

---

### Task 2: Skill Loader Refactor — Customer-Space Scan

**Files:**
- Modify: `src/agents/skill-loader.ts:21-58` (loadSkillIndex signature and scan order)
- Modify: `src/agents/skill-loader.test.ts`
- Modify: `src/agents/agent-manager.ts:49-50` (pass hiveHome)

- [ ] **Step 1:** Change `loadSkillIndex` signature and scan order

Current signature:
```typescript
export function loadSkillIndex(
  skillsDir: string = resolve("skills"),
  plugins?: LoadedPlugin[],
): SkillIndex
```

New signature:
```typescript
export function loadSkillIndex(
  customerSkillsDir: string,
  plugins?: LoadedPlugin[],
): SkillIndex
```

Change the scan order per customer-space spec §6.4 and §8 (name collision):
1. **Plugin-bundled first** (unchanged loop over `plugins`)
2. **Customer-space second** — scan `customerSkillsDir`

And reverse collision semantics per spec §8: customer space wins over plugins (previously core won). The `collisionMap` check in `scanWorkflowsFrom` must be changed so that:
- Plugin→plugin collision: first plugin wins (unchanged)
- Customer→plugin collision: customer wins (new — customer is scanned second but takes precedence)

Implementation approach: scan plugins first into a preliminary map, then scan customer space. When customer space finds a collision with a plugin workflow, log a warning but **replace** the plugin entry with the customer entry (customer wins). When customer space finds a collision with another customer workflow, error out.

The simplest approach: scan plugins first, then scan customer space with a flag indicating "this source wins collisions." Refactor `scanWorkflowsFrom` to accept a `winsCollisions: boolean` parameter.

- [ ] **Step 2:** Remove the core-skills scan

Delete the block at lines 29-34 that scans `skillsDir` as "core." Replace with customer-space scan after plugins:

```typescript
// Plugins first (in hive.yaml order)
for (const plugin of plugins ?? []) {
  const pluginSkillsDir = join(plugin.dir, "skills");
  if (!existsSync(pluginSkillsDir)) continue;
  scanWorkflowsFrom(pluginSkillsDir, plugin.name, collisionMap, index, universalPlugins, false);
}

// Customer space second — wins collisions with plugins
if (existsSync(customerSkillsDir)) {
  scanWorkflowsFrom(customerSkillsDir, "customer", collisionMap, index, universalPlugins, true);
} else {
  log.debug("No customer skills directory found", { path: customerSkillsDir });
}
```

- [ ] **Step 3:** Update `scanWorkflowsFrom` for collision override

Add `winsCollisions: boolean` parameter. When `winsCollisions` is true and a collision is found:
- If the existing entry's source is NOT "customer", log a shadow warning and **replace** the existing entry (remove from index, update collisionMap)
- If the existing entry's source IS "customer", this is a customer→customer collision — log error and skip (the loader should surface this clearly)

```typescript
function scanWorkflowsFrom(
  rootDir: string,
  source: string,
  collisionMap: Map<string, CollisionEntry>,
  index: SkillIndex,
  universalPlugins: SdkPluginConfig[],
  winsCollisions: boolean,
): void {
  // ... existing workflow enumeration ...

  for (const workflow of workflows) {
    const existing = collisionMap.get(workflow);
    if (existing) {
      if (winsCollisions && existing.source !== "customer") {
        // Customer shadows plugin — replace
        log.warn("Customer skill shadows plugin-bundled skill", {
          workflow,
          shadowed: existing,
          shadowedBy: { source, path: workflowPath },
        });
        // Remove the plugin's entries from the index for this workflow
        removeWorkflowFromIndex(existing.path, index, universalPlugins);
        collisionMap.set(workflow, { source, path: workflowPath });
        // Fall through to register the customer version
      } else if (winsCollisions && existing.source === "customer") {
        // Customer→customer collision — error, do not load either
        log.error("Duplicate customer skill — resolve manually", {
          workflow,
          first: existing.path,
          second: workflowPath,
        });
        continue;
      } else {
        // Plugin→plugin: first wins (existing behavior)
        log.warn("Skill workflow collision — keeping first, skipping second", {
          workflow,
          kept: existing,
          skipped: { source, path: workflowPath },
        });
        continue;
      }
    } else {
      collisionMap.set(workflow, { source, path: workflowPath });
    }

    // ... rest of skill registration (pluginConfig, agentIds, etc.) ...
  }
}
```

Add helper `removeWorkflowFromIndex` to remove a specific workflow path from all agent entries and universalPlugins.

- [ ] **Step 4:** Update `agent-manager.ts` to pass `hiveHome`

In `src/agents/agent-manager.ts` constructor (line 50):

```typescript
// Before:
this.skillIndex = loadSkillIndex(undefined, this.plugins);

// After:
import { skillsDir } from "../paths.js";
this.skillIndex = loadSkillIndex(skillsDir, this.plugins);
```

Same change in `reloadSkills()` method.

- [ ] **Step 5:** Update `src/index.ts` skills watcher

Change the watched directory from `resolve("skills")` to the customer-space path:

```typescript
// Before:
const skillsDir = resolve("skills");

// After:
import { skillsDir } from "./paths.js";
```

The variable is already named `skillsDir`, so the rest of the watcher code stays the same.

- [ ] **Step 6:** Update tests in `skill-loader.test.ts`

Update existing tests:
- Rename `core` references to `customer` where applicable
- Reverse collision test: customer now wins over plugin (not vice versa)
- Add test: customer→customer collision logs error and loads neither
- Add test: customer-space scan with no customer dir is graceful no-op
- Keep existing plugin→plugin collision test (first wins)

New tests:
- `customer skill shadows plugin-bundled skill` — same workflow name, customer version is loaded
- `customer→customer collision errors` — two customer workflows with same name, neither loads

- [ ] **Step 7:** Verify

Run: `npx vitest run src/agents/skill-loader`
Expected: All tests pass (old tests updated, new collision tests pass)

- [ ] **Step 8:** Commit

```bash
git add src/agents/skill-loader.ts src/agents/skill-loader.test.ts src/agents/agent-manager.ts src/index.ts
git commit -m "feat(skills): scan customer-space skills dir, customer wins collisions over plugins"
```

---

### Task 3: Instance-Local Git Audit Branch

**Files:**
- Create: `src/skills/instance-git.ts`
- Test: `src/skills/instance-git.test.ts`

- [ ] **Step 1:** Create `src/skills/instance-git.ts`

This module manages the instance-local git repo at `<hiveHome>` with two branches:
- `installed` — snapshot of package-shipped state (rewritten on upgrade)
- `state` — customer-owned content audit trail (commits on skill writes)

Neither branch is ever pushed. The repo is separate from any source-control repo.

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "../logging/logger.js";

const log = createLogger("instance-git");

/**
 * Initialize the instance-local git repo if not already present.
 * Creates .hive/.git (using a separate git dir to avoid conflicts with
 * any existing .git at hiveHome) with `installed` and `state` branches.
 *
 * Uses --separate-git-dir so the .git directory lives inside .hive/
 * and doesn't interfere with any parent repo's .git.
 */
export function initInstanceGit(hiveHome: string): void {
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (existsSync(gitDir)) return; // Already initialized

  mkdirSync(resolve(hiveHome, ".hive"), { recursive: true });

  // Initialize a bare-ish repo in .hive/git, using hiveHome as worktree
  const git = (...args: string[]) =>
    execFileSync("git", [...args], {
      cwd: hiveHome,
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome },
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

  log.info("Instance-local git initialized", { gitDir });
}

/**
 * Helper to run git commands against the instance-local repo.
 */
function gitCmd(hiveHome: string, ...args: string[]): string {
  const gitDir = resolve(hiveHome, ".hive", "git");
  return execFileSync("git", [...args], {
    cwd: hiveHome,
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome },
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

/**
 * Commit a file change to the 'state' branch.
 * Used by the write guard after a SKILL.md write or by the install/upgrade/remove flows.
 */
export function commitToState(
  hiveHome: string,
  files: string[],
  message: string,
  authorName?: string,
): void {
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (!existsSync(gitDir)) {
    log.warn("Instance git not initialized — skipping state commit");
    return;
  }

  try {
    // Ensure we're on the state branch
    const branch = gitCmd(hiveHome, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "state") {
      gitCmd(hiveHome, "checkout", "state");
    }

    // Stage the specific files (relative to hiveHome)
    for (const file of files) {
      // Use --force to add files that might be in .gitignore
      gitCmd(hiveHome, "add", "--force", file);
    }

    // Check if there's anything to commit
    try {
      gitCmd(hiveHome, "diff", "--cached", "--quiet");
      return; // Nothing staged
    } catch {
      // diff --quiet exits non-zero when there are staged changes — expected
    }

    const authorArg = authorName ? `${authorName} <${authorName}@hive>` : "hive <hive@localhost>";
    gitCmd(hiveHome, "commit", "--author", authorArg, "-m", message);
    log.debug("State branch commit", { message, files: files.length });
  } catch (err) {
    log.warn("Failed to commit to state branch", { error: String(err), message });
  }
}

/**
 * Commit a removal to the 'state' branch.
 */
export function commitRemovalToState(
  hiveHome: string,
  files: string[],
  message: string,
): void {
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (!existsSync(gitDir)) return;

  try {
    const branch = gitCmd(hiveHome, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "state") gitCmd(hiveHome, "checkout", "state");

    for (const file of files) {
      try {
        gitCmd(hiveHome, "rm", "-r", "--cached", file);
      } catch {
        // File might not be tracked
      }
    }

    try {
      gitCmd(hiveHome, "diff", "--cached", "--quiet");
      return;
    } catch {
      // Has staged changes
    }

    gitCmd(hiveHome, "commit", "-m", message);
    log.debug("State branch removal commit", { message });
  } catch (err) {
    log.warn("Failed to commit removal to state branch", { error: String(err) });
  }
}
```

- [ ] **Step 2:** Write tests for instance-git

Tests using temp directories:
- `initInstanceGit` creates `.hive/git` with both branches
- `initInstanceGit` is idempotent (second call is a no-op)
- `commitToState` creates a commit with the right message and author
- `commitToState` is a no-op when nothing changed
- `commitToState` handles uninitialized repo gracefully (warns, doesn't throw)
- `commitRemovalToState` records file removals

- [ ] **Step 3:** Verify

Run: `npx vitest run src/skills/instance-git`
Expected: All tests pass

- [ ] **Step 4:** Commit

```bash
git add src/skills/instance-git.ts src/skills/instance-git.test.ts
git commit -m "feat(skills): instance-local git audit branch (installed + state)"
```

---

### Task 4: Write Guard for Agent Authorship

**Files:**
- Create: `src/skills/write-guard.ts`

- [ ] **Step 1:** Create the write guard

The write guard is called by `agent-runner.ts` when an agent writes a file matching the SKILL.md path pattern. It enforces:

1. Path constraint: writes must target `<hiveHome>/skills/`
2. Frontmatter injection: new files get `origin.type: agent-authored`, `author.agent-id`, `author.authored-at`
3. Git commit to state branch

```typescript
import { existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { skillsDir, hiveMetaDir } from "../paths.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { commitToState } from "./instance-git.js";
import { isInsideCustomerSpace } from "./skill-paths.js";
import { hiveHome } from "../paths.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("write-guard");

export interface WriteGuardContext {
  agentId: string;
  reason?: string;
}

/**
 * Check if a file path is a SKILL.md write that should go through the write guard.
 */
export function isSkillWrite(path: string): boolean {
  const resolved = resolve(path);
  return resolved.endsWith("/SKILL.md") && isInsideCustomerSpace(resolved);
}

/**
 * Process a SKILL.md write through the guard.
 * - Validates the path is in customer space
 * - Injects agent-authored metadata for new skills
 * - Commits to the state branch
 *
 * Returns the (possibly modified) content to write.
 * Throws if the path violates the customer-space constraint.
 */
export function processSkillWrite(
  path: string,
  content: string,
  ctx: WriteGuardContext,
): string {
  const resolved = resolve(path);

  if (!isInsideCustomerSpace(resolved)) {
    throw new Error(
      `Skill write rejected: ${resolved} is outside customer space (${skillsDir}). ` +
      `Agent-authored skills must be written under ${skillsDir}/.`,
    );
  }

  const isNew = !existsSync(resolved);
  let finalContent = content;

  if (isNew) {
    // Inject agent-authored metadata
    try {
      const { frontmatter, body } = parseFrontmatter(content);
      if (!frontmatter.origin) {
        frontmatter.origin = {
          type: "agent-authored",
        };
        frontmatter.author = {
          "agent-id": ctx.agentId,
          "authored-at": new Date().toISOString(),
          ...(ctx.reason ? { reason: ctx.reason } : {}),
        };
        finalContent = serializeFrontmatter(frontmatter, body);
      }
    } catch {
      // If frontmatter parsing fails, write as-is — the loader will skip malformed files
      log.warn("Could not parse frontmatter for metadata injection", { path: resolved });
    }
  }

  // Commit to state branch (async-safe: git operations are synchronous)
  const relPath = relative(hiveHome, resolved);
  const message = isNew
    ? `agent-authored: ${relPath}${ctx.reason ? ` — ${ctx.reason}` : ""}`
    : `update: ${relPath}`;
  commitToState(hiveHome, [relPath], message, ctx.agentId);

  return finalContent;
}
```

- [ ] **Step 2:** Wire the write guard into agent-runner

In `src/agents/agent-runner.ts`, the Write tool callback needs to check `isSkillWrite(path)` and route through `processSkillWrite` if true. The exact wiring depends on how the Agent SDK exposes file write hooks. If the SDK doesn't have a hook, the guard runs at the loader-reload boundary instead (checking for new/changed SKILL.md files in customer space and committing them).

**Decision point for implementation:** check the Agent SDK's `ClaudeAgent` configuration for file write interception. If available, wire directly. If not, use the loader-reload approach (SIGUSR1 / fs.watch handler runs the guard on any new or changed SKILL.md files).

The simpler approach (and the one that doesn't depend on SDK internals): run the guard at reload time. In `agent-manager.ts`'s `reloadSkills()`, after re-scanning the index, check for any SKILL.md files in customer space that are not yet committed to the state branch, and commit them.

- [ ] **Step 3:** Commit

```bash
git add src/skills/write-guard.ts
git commit -m "feat(skills): write guard for agent-authored skill metadata injection"
```

---

### Task 5: Boot-Time Integrity Check

**Files:**
- Create: `src/skills/integrity.ts`
- Create: `src/skills/upgrade-notice.ts`
- Modify: `src/index.ts` (add boot-time calls)

- [ ] **Step 1:** Create `src/skills/integrity.ts`

The integrity check verifies package-declared files against `installed-snapshot.json`. The snapshot is written by the package's postinstall hook (or by the `hive init` / `hive update` flow).

```typescript
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { hiveHome, hiveMetaDir } from "../paths.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("integrity");

interface SnapshotEntry {
  path: string;
  hash: string; // SHA-256
}

const SNAPSHOT_PATH = resolve(hiveMetaDir, "installed-snapshot.json");

// Paths the customer is allowed to have outside the package manifest
const ALLOWLISTED_PREFIXES = [
  "skills/",
  "plugins/",
  ".hive/",
  ".env",
  "hive.yaml",
  "hive-",         // hive-personal.yaml etc.
];

/**
 * Verify package integrity at boot time.
 * Returns { ok: boolean, drift: string[] } where drift lists any mismatched paths.
 * Refuses to start (throws) on package integrity failure.
 */
export function verifyPackageIntegrity(): { ok: boolean; warnings: string[] } {
  if (!existsSync(SNAPSHOT_PATH)) {
    log.warn("No installed-snapshot.json — skipping integrity check (first install?)");
    return { ok: true, warnings: [] };
  }

  const snapshot: SnapshotEntry[] = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8"));
  const drift: string[] = [];

  for (const entry of snapshot) {
    const fullPath = resolve(hiveHome, entry.path);
    if (!existsSync(fullPath)) {
      drift.push(`missing: ${entry.path}`);
      continue;
    }
    const content = readFileSync(fullPath);
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== entry.hash) {
      drift.push(`modified: ${entry.path}`);
    }
  }

  if (drift.length > 0) {
    log.error("Package integrity check FAILED — refusing to start", { drift });
    throw new Error(
      `Package integrity check failed. ${drift.length} file(s) have been modified or are missing:\n` +
      drift.map((d) => `  - ${d}`).join("\n") +
      `\nThis usually means someone edited files in the engine directory. ` +
      `Reinstall with: npm install @keepur/hive@<version>`,
    );
  }

  return { ok: true, warnings: [] };
}

/**
 * Check for files outside package-owned and allowlisted paths.
 * Logs warnings but does not refuse to start.
 */
export function checkAllowlistDrift(): void {
  // Walk top-level entries in hiveHome, skip known package and allowlisted paths
  // Log any unexpected files/directories as drift warnings
  // This is discovery, not enforcement
  try {
    const entries = readdirSync(hiveHome);
    const packagePaths = new Set(["dist", "node_modules", "package.json", "package-lock.json", "pkg", "seeds", "templates"]);
    const warnings: string[] = [];

    for (const entry of entries) {
      if (packagePaths.has(entry)) continue;
      if (entry.startsWith(".") && entry !== ".hive") continue; // .env handled by prefix
      if (ALLOWLISTED_PREFIXES.some((p) => entry.startsWith(p.replace("/", "")))) continue;

      warnings.push(entry);
    }

    if (warnings.length > 0) {
      log.warn("Unexpected files in instance directory (not package-owned, not allowlisted)", { files: warnings });
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Write the installed-snapshot.json for the current package state.
 * Called by the install hook or `hive init`/`hive update`.
 */
export function writeSnapshot(packageRoot: string, declaredFiles: string[]): void {
  const entries: SnapshotEntry[] = [];
  for (const file of declaredFiles) {
    const fullPath = resolve(packageRoot, file);
    if (!existsSync(fullPath)) continue;
    if (statSync(fullPath).isDirectory()) {
      // Recurse into directory
      walkDir(fullPath, file, entries, packageRoot);
    } else {
      const content = readFileSync(fullPath);
      entries.push({
        path: file,
        hash: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  const snapshotDir = resolve(packageRoot, ".hive");
  if (!existsSync(snapshotDir)) {
    const { mkdirSync } = require("node:fs");
    mkdirSync(snapshotDir, { recursive: true });
  }
  const fs = require("node:fs");
  fs.writeFileSync(resolve(snapshotDir, "installed-snapshot.json"), JSON.stringify(entries, null, 2));
}

function walkDir(dir: string, prefix: string, entries: SnapshotEntry[], root: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      walkDir(full, rel, entries, root);
    } else {
      const content = readFileSync(full);
      entries.push({ path: rel, hash: createHash("sha256").update(content).digest("hex") });
    }
  }
}
```

- [ ] **Step 2:** Create `src/skills/upgrade-notice.ts`

Per customer-space spec §10.5: one-time notice when an upgrade removes shipped skills.

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { hiveMetaDir, skillsDir } from "../paths.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("upgrade-notice");
const NOTICE_FLAG = resolve(hiveMetaDir, "upgrade-notice-emitted");

/**
 * Check if an upgrade removed shipped skills and emit a one-time notice.
 * Reads the previous snapshot to find skill paths that were in the old version
 * but are no longer present.
 */
export function checkUpgradeNotice(): void {
  if (existsSync(NOTICE_FLAG)) return; // Already emitted

  const prevSnapshotPath = resolve(hiveMetaDir, "previous-snapshot.json");
  if (!existsSync(prevSnapshotPath)) return; // No previous version data

  try {
    const prevSnapshot = JSON.parse(readFileSync(prevSnapshotPath, "utf-8"));
    const removedSkills: string[] = [];

    for (const entry of prevSnapshot) {
      if (typeof entry.path === "string" && entry.path.startsWith("skills/") && entry.path.endsWith("SKILL.md")) {
        // Extract skill name from path
        const match = entry.path.match(/^skills\/([^/]+)\//);
        if (match && !existsSync(resolve(skillsDir, match[1]!))) {
          removedSkills.push(match[1]!);
        }
      }
    }

    if (removedSkills.length === 0) return;

    // Deduplicate
    const unique = [...new Set(removedSkills)];

    const notice = [
      "",
      "=".repeat(72),
      "Your previous version of hive shipped the following skills in its tarball:",
      ...unique.map((s) => `  - ${s}`),
      "",
      "These are no longer part of the hive core package. You can re-install any of",
      "them from the default Keepur registry with:",
      "",
      "  hive skill add <name>",
      "",
      "Agent-authored skills you or your agents wrote on this hive are unaffected and",
      "continue to work. This notice only appears once.",
      "=".repeat(72),
      "",
    ].join("\n");

    log.info(notice);
    console.log(notice);

    // Record emission
    mkdirSync(hiveMetaDir, { recursive: true });
    writeFileSync(NOTICE_FLAG, new Date().toISOString());
  } catch (err) {
    log.warn("Failed to check upgrade notice", { error: String(err) });
  }
}
```

- [ ] **Step 3:** Wire into `src/index.ts` startup

Add early in the `startHive()` function, before agent registry load:

```typescript
import { initInstanceGit } from "./skills/instance-git.js";
import { verifyPackageIntegrity, checkAllowlistDrift } from "./skills/integrity.js";
import { checkUpgradeNotice } from "./skills/upgrade-notice.js";

// Boot-time checks
verifyPackageIntegrity();  // Throws on drift — prevents startup
checkAllowlistDrift();     // Warnings only
initInstanceGit(hiveHome); // Initialize .hive/git if needed
checkUpgradeNotice();      // One-time notice after upgrade
```

Note: `hiveHome` is already available from config loading. Import from `src/paths.ts`.

- [ ] **Step 4:** Verify

Run: `npx vitest run src/skills/integrity && npx vitest run src/skills/upgrade-notice`
Expected: Tests pass

- [ ] **Step 5:** Commit

```bash
git add src/skills/integrity.ts src/skills/upgrade-notice.ts src/index.ts
git commit -m "feat(skills): boot-time integrity check and upgrade notice"
```

---

### Task 6: Registry Config & Resolver

**Files:**
- Modify: `src/config.ts` (add `skillRegistries` field)
- Create: `src/skills/registry-resolver.ts`

- [ ] **Step 1:** Add `skillRegistries` to config

In `src/config.ts`, add to the config object:

```typescript
skillRegistries: (hive.skillRegistries as RegistryConfig[] | undefined) ?? [
  { name: "keepur-default", url: "https://github.com/keepur/hive-skills", default: true },
],
```

Type definition:

```typescript
export interface RegistryConfig {
  name: string;
  url: string;
  default?: boolean;
}
```

- [ ] **Step 2:** Create `src/skills/registry-resolver.ts`

```typescript
import { config } from "../config.js";
import type { RegistryConfig } from "../config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("registry-resolver");

export interface ResolvedRegistry {
  name: string;
  url: string;
}

/**
 * Parse a skill specifier into its components.
 *
 * Formats:
 *   - "morning-briefing" → name only, resolve from default registry
 *   - "keepur-default:morning-briefing" → registry prefix + name
 *   - "https://github.com/foo/bar#skills/morning-briefing" → inline URL
 *   - "file:///path/to/repo#skills/morning-briefing" → local URL
 *   - "https://github.com/owner/repo/tree/main/skills/name" → GitHub web URL (convenience)
 */
export interface ParsedSkillSpec {
  name: string;
  registryName?: string;
  inlineUrl?: string;
}

export function parseSkillSpec(spec: string): ParsedSkillSpec {
  // Inline URL with fragment
  if (spec.includes("#skills/")) {
    const [url, fragment] = spec.split("#skills/");
    return { name: fragment!, inlineUrl: url! };
  }

  // GitHub web URL convenience form
  const ghMatch = spec.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/[^/]+\/skills\/([^/]+)/,
  );
  if (ghMatch) {
    return {
      name: ghMatch[3]!,
      inlineUrl: `https://github.com/${ghMatch[1]}/${ghMatch[2]}`,
    };
  }

  // Registry prefix
  if (spec.includes(":") && !spec.includes("//")) {
    const [registry, name] = spec.split(":");
    return { name: name!, registryName: registry! };
  }

  // Plain name
  return { name: spec };
}

/**
 * Resolve which registry to use for a skill install/upgrade.
 */
export function resolveRegistry(spec: ParsedSkillSpec): ResolvedRegistry {
  const registries = config.skillRegistries;

  if (spec.inlineUrl) {
    // Inline URL — use directly, derive name from URL
    const name = inferRegistryName(spec.inlineUrl);
    return { name, url: spec.inlineUrl };
  }

  if (spec.registryName) {
    // Explicit prefix — find by name
    const found = registries.find((r) => r.name === spec.registryName);
    if (!found) {
      throw new Error(
        `Unknown registry: "${spec.registryName}". ` +
        `Configured registries: ${registries.map((r) => r.name).join(", ")}`,
      );
    }
    return { name: found.name, url: found.url };
  }

  // No prefix — use default
  const defaultReg = registries.find((r) => r.default) ?? registries[0];
  if (!defaultReg) {
    throw new Error("No skill registries configured. Add one with: hive registry add <url>");
  }
  return { name: defaultReg.name, url: defaultReg.url };
}

/**
 * Infer a short registry name from a git URL.
 * e.g. "https://github.com/acme/hive-skills" → "acme-hive-skills"
 */
function inferRegistryName(url: string): string {
  try {
    const cleaned = url.replace(/\.git$/, "");
    const parts = cleaned.split("/").filter(Boolean);
    return parts.slice(-2).join("-");
  } catch {
    return "inline";
  }
}
```

- [ ] **Step 3:** Commit

```bash
git add src/config.ts src/skills/registry-resolver.ts
git commit -m "feat(skills): registry config schema and resolver"
```

---

### Task 7: Git Fetch Layer & Projection Rule

**Files:**
- Create: `src/skills/registry-fetch.ts`
- Create: `src/skills/projection.ts`
- Test: `src/skills/projection.test.ts`

- [ ] **Step 1:** Create `src/skills/registry-fetch.ts`

Wraps git CLI for shallow-clone, partial-clone, and cleanup. All git operations use `execFileSync` (no shell).

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createLogger } from "../logging/logger.js";

const log = createLogger("registry-fetch");

export interface CloneResult {
  dir: string;         // Temp directory with the cloned repo
  headSha: string;     // HEAD commit SHA
  cleanup: () => void; // Call to remove the temp directory
}

/**
 * Verify that git is available on the system.
 * Called at CLI startup, not at fetch time.
 */
export function verifyGitAvailable(): void {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "git is required for skill installation but was not found. " +
      "Install git and retry.",
    );
  }
}

/**
 * Shallow-clone a registry for install (--depth 1).
 * Used by `hive skill add`.
 */
export function shallowClone(url: string): CloneResult {
  const tmpDir = resolve("/tmp", `hive-skill-install-${Date.now()}`);
  const cleanup = () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    execFileSync("git", ["clone", "--depth", "1", url, tmpDir], {
      stdio: "pipe",
      timeout: 60_000,
    });

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();

    return { dir: tmpDir, headSha, cleanup };
  } catch (err) {
    cleanup();
    throw new Error(`registry fetch failed: ${String(err)}`);
  }
}

/**
 * Partial-clone a registry for upgrade (needs access to historical SHAs).
 * Falls back to full clone if partial clone is not supported.
 */
export function partialClone(url: string): CloneResult {
  const tmpDir = resolve("/tmp", `hive-skill-upgrade-${Date.now()}`);
  const cleanup = () => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    // Try partial clone first
    try {
      execFileSync(
        "git",
        ["clone", "--filter=blob:none", "--no-checkout", url, tmpDir],
        { stdio: "pipe", timeout: 120_000 },
      );
    } catch {
      // Fall back to full clone
      rmSync(tmpDir, { recursive: true, force: true });
      execFileSync("git", ["clone", url, tmpDir], {
        stdio: "pipe",
        timeout: 120_000,
      });
    }

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();

    return { dir: tmpDir, headSha, cleanup };
  } catch (err) {
    cleanup();
    throw new Error(`registry fetch failed: ${String(err)}`);
  }
}

/**
 * Check the current HEAD of a remote registry without cloning.
 */
export function lsRemoteHead(url: string): string {
  const output = execFileSync("git", ["ls-remote", url, "HEAD"], {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();

  const sha = output.split("\t")[0];
  if (!sha) throw new Error(`Could not determine HEAD for ${url}`);
  return sha;
}

/**
 * List available skill names in a cloned registry.
 */
export function listSkillsInClone(cloneDir: string): string[] {
  const skillsDir = join(cloneDir, "skills");
  if (!existsSync(skillsDir)) return [];

  const { readdirSync, statSync } = require("node:fs");
  return readdirSync(skillsDir).filter((entry: string) => {
    try {
      const full = join(skillsDir, entry);
      return statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
    } catch {
      return false;
    }
  });
}

/**
 * Checkout a specific SHA in a cloned repo and return the skill directory contents.
 */
export function checkoutSha(cloneDir: string, sha: string): void {
  execFileSync("git", ["checkout", sha], {
    cwd: cloneDir,
    stdio: "pipe",
  });
}

/**
 * Find a tag pointing at or before a specific SHA.
 */
export function findTagForSha(cloneDir: string, sha: string): string | undefined {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--exact-match", sha], {
      cwd: cloneDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    return tag || undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2:** Create `src/skills/projection.ts`

Per registry spec §7.2: flat `skills/<name>/` → nested `<skillsDir>/<workflow>/skills/<name>/`.

```typescript
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { skillsDir } from "../paths.js";

/**
 * Read the workflow: field from a SKILL.md file's frontmatter.
 * Returns the workflow name, or the skill name as fallback if workflow: is absent.
 */
export function extractWorkflow(skillMdPath: string, skillName: string): string {
  const content = readFileSync(skillMdPath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return skillName;

  const workflowMatch = fmMatch[1]!.match(/^workflow:\s*(.+)$/m);
  if (!workflowMatch) return skillName;

  return workflowMatch[1]!.trim();
}

/**
 * Compute the runtime target path for a registry skill.
 * Registry: skills/<name>/ → Runtime: <skillsDir>/<workflow>/skills/<name>/
 */
export function projectToRuntime(workflow: string, skillName: string): string {
  return join(skillsDir, workflow, "skills", skillName);
}
```

- [ ] **Step 3:** Write projection tests

```
- "sales-standup-prep" with workflow: "morning-briefing" → <skillsDir>/morning-briefing/skills/sales-standup-prep/
- "quality-gate" with workflow: "project-tools" → <skillsDir>/project-tools/skills/quality-gate/
- skill with no workflow: field → <skillsDir>/<name>/skills/<name>/ (degenerate case)
```

- [ ] **Step 4:** Commit

```bash
git add src/skills/registry-fetch.ts src/skills/projection.ts src/skills/projection.test.ts
git commit -m "feat(skills): git fetch layer and flat-to-nested projection rule"
```

---

### Task 8: Install Flow

**Files:**
- Create: `src/skills/install.ts`
- Test: `src/skills/install.test.ts`

- [ ] **Step 1:** Create `src/skills/install.ts`

Wires fetch → resolve → project → copy → metadata injection → state-branch commit → loader reload.

```typescript
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { shallowClone, listSkillsInClone, findTagForSha } from "./registry-fetch.js";
import { extractWorkflow, projectToRuntime } from "./projection.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { computeContentHash } from "./content-hash.js";
import { commitToState } from "./instance-git.js";
import { hiveHome, skillsDir } from "../paths.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-install");

export interface InstallResult {
  name: string;
  workflow: string;
  targetPath: string;
  version: string;
}

/**
 * Install a skill from a registry.
 * Per registry spec §7.1.
 */
export function installSkill(
  registryUrl: string,
  skillName: string,
): InstallResult {
  // Step 1-2: Shallow clone
  const clone = shallowClone(registryUrl);

  try {
    // Step 3: Resolve skill directory
    const skillSrcDir = join(clone.dir, "skills", skillName);
    if (!existsSync(skillSrcDir)) {
      const available = listSkillsInClone(clone.dir);
      throw new Error(
        `Skill "${skillName}" not found in registry ${registryUrl}. ` +
        `Available skills: ${available.join(", ") || "(none)"}`,
      );
    }

    // Step 4: Read frontmatter, extract workflow
    const skillMdPath = join(skillSrcDir, "SKILL.md");
    const workflow = extractWorkflow(skillMdPath, skillName);

    // Step 4a: Validate name field
    const rawContent = readFileSync(skillMdPath, "utf-8");
    const fmMatch = rawContent.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const nameMatch = fmMatch[1]!.match(/^name:\s*(.+)$/m);
      if (nameMatch && nameMatch[1]!.trim() !== skillName) {
        console.log(
          `Warning: registry skill directory 'skills/${skillName}/' declares name '${nameMatch[1]!.trim()}' ` +
          `in its SKILL.md frontmatter. The directory name is authoritative — installing as '${skillName}'.`,
        );
      }
    }

    // Step 5: Construct target path
    const targetPath = projectToRuntime(workflow, skillName);

    // Check for existing install
    if (existsSync(targetPath)) {
      throw new Error(
        `Skill "${skillName}" is already installed at ${targetPath}. ` +
        `Use "hive skill upgrade ${skillName}" to update, or "hive skill remove ${skillName}" first.`,
      );
    }

    // Step 6: Copy entire skill directory
    mkdirSync(targetPath, { recursive: true });
    cpSync(skillSrcDir, targetPath, { recursive: true });

    // Step 7: Record install metadata
    const contentHash = computeContentHash(targetPath);
    const tag = findTagForSha(clone.dir, clone.headSha);
    const { frontmatter, body } = parseFrontmatter(readFileSync(join(targetPath, "SKILL.md"), "utf-8"));

    frontmatter.origin = {
      type: "registry",
      source: registryUrl,
      "base-version": clone.headSha,
      ...(tag ? { "base-tag": tag } : {}),
      "base-content-hash": contentHash,
      "installed-at": new Date().toISOString(),
      modified: false,
    };

    writeFileSync(join(targetPath, "SKILL.md"), serializeFrontmatter(frontmatter, body));

    // Step 8: Commit to state branch
    const relPath = relative(hiveHome, targetPath);
    commitToState(
      hiveHome,
      [relPath],
      `install: ${workflow}/${skillName} from ${registryUrl}@${clone.headSha.slice(0, 8)}`,
    );

    log.info("Skill installed", { name: skillName, workflow, version: clone.headSha.slice(0, 8) });

    return {
      name: skillName,
      workflow,
      targetPath,
      version: clone.headSha,
    };
  } finally {
    // Step 9: Cleanup
    clone.cleanup();
  }
}
```

- [ ] **Step 2:** Write install tests

Use a local `file://` URL pointing at a temp directory structured as a registry. Tests:
- Install a skill with `workflow:` field — lands in correct nested path
- Install a skill without `workflow:` field — degenerate case
- Install records origin metadata in frontmatter
- Install of nonexistent skill name errors with available list
- Install of already-installed skill errors
- Cleanup runs even on failure

- [ ] **Step 3:** Verify

Run: `npx vitest run src/skills/install`

- [ ] **Step 4:** Commit

```bash
git add src/skills/install.ts src/skills/install.test.ts
git commit -m "feat(skills): registry install flow with metadata injection"
```

---

### Task 9: Upgrade Flow

**Files:**
- Create: `src/skills/upgrade.ts`
- Test: `src/skills/upgrade.test.ts`

- [ ] **Step 1:** Create `src/skills/upgrade.ts`

Per registry spec §8.

```typescript
import { existsSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { partialClone, lsRemoteHead, checkoutSha, findTagForSha } from "./registry-fetch.js";
import { readSkillMd, writeSkillMd, parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { computeContentHash } from "./content-hash.js";
import { commitToState } from "./instance-git.js";
import { hiveHome, skillsDir } from "../paths.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-upgrade");

export type UpgradeAction = "up-to-date" | "applied" | "kept" | "taken" | "merged" | "removed-upstream";

export interface UpgradeResult {
  name: string;
  action: UpgradeAction;
  oldVersion: string;
  newVersion?: string;
}

/**
 * Upgrade a single installed skill.
 * Per registry spec §8.1.
 *
 * promptFn is called when the customer has local modifications and needs to choose.
 * In non-interactive mode, pass a function that returns "keep" by default.
 */
export async function upgradeSkill(
  skillName: string,
  promptFn: (yours: string, theirs: string, base?: string) => Promise<"keep" | "take">,
): Promise<UpgradeResult> {
  // Find the installed skill
  const installed = findInstalledSkill(skillName);
  if (!installed) {
    throw new Error(`Skill "${skillName}" is not installed or is not registry-sourced.`);
  }

  const { frontmatter } = readSkillMd(join(installed.path, "SKILL.md"));
  const origin = frontmatter.origin;
  if (!origin || origin.type !== "registry" || !origin.source || !origin["base-version"]) {
    throw new Error(`Skill "${skillName}" has no registry origin metadata.`);
  }

  // Step 2: Check remote HEAD
  const remoteHead = lsRemoteHead(origin.source);
  const oldVersion = origin["base-version"];

  // Step 3: Compare SHAs
  if (remoteHead === oldVersion) {
    return { name: skillName, action: "up-to-date", oldVersion };
  }

  // Step 4: Clone registry
  const clone = partialClone(origin.source);

  try {
    // Step 5: Check if skill still exists
    const skillSrcDir = join(clone.dir, "skills", skillName);
    if (!existsSync(join(skillSrcDir, "SKILL.md"))) {
      console.log(`Warning: "${skillName}" was removed from ${origin.source} — keeping your installed copy.`);
      return { name: skillName, action: "removed-upstream", oldVersion };
    }

    // Step 7: Unmodified — apply cleanly
    if (!origin.modified) {
      cpSync(skillSrcDir, installed.path, { recursive: true });
      const newHash = computeContentHash(installed.path);
      const tag = findTagForSha(clone.dir, remoteHead);
      const { frontmatter: updatedFm, body } = readSkillMd(join(installed.path, "SKILL.md"));
      updatedFm.origin = {
        ...updatedFm.origin!,
        "base-version": remoteHead,
        "base-content-hash": newHash,
        "installed-at": new Date().toISOString(),
        modified: false,
        ...(tag ? { "base-tag": tag } : {}),
      };
      writeSkillMd(join(installed.path, "SKILL.md"), updatedFm, body);

      const relPath = relative(hiveHome, installed.path);
      commitToState(hiveHome, [relPath], `upgrade: ${skillName} ${oldVersion.slice(0, 8)} → ${remoteHead.slice(0, 8)}`);

      return { name: skillName, action: "applied", oldVersion, newVersion: remoteHead };
    }

    // Step 8: Modified — prompt
    const yours = readFileSync(join(installed.path, "SKILL.md"), "utf-8");
    const theirs = readFileSync(join(skillSrcDir, "SKILL.md"), "utf-8");

    // Try to get the base version
    let base: string | undefined;
    try {
      checkoutSha(clone.dir, oldVersion);
      const basePath = join(clone.dir, "skills", skillName, "SKILL.md");
      if (existsSync(basePath)) {
        base = readFileSync(basePath, "utf-8");
      }
    } catch {
      // Base unreachable — two-way degraded case
    }

    const choice = await promptFn(yours, theirs, base);

    if (choice === "keep") {
      return { name: skillName, action: "kept", oldVersion };
    }

    // Take upstream version
    // Back up if base was unreachable
    if (!base) {
      const backupDir = resolve(hiveHome, ".hive", "skill-backups", `${skillName}-${Date.now()}`);
      mkdirSync(backupDir, { recursive: true });
      cpSync(installed.path, backupDir, { recursive: true });
      log.info("Backed up modified skill before upgrade", { backup: backupDir });
    }

    cpSync(skillSrcDir, installed.path, { recursive: true });
    const newHash = computeContentHash(installed.path);
    const tag = findTagForSha(clone.dir, remoteHead);
    const { frontmatter: updatedFm, body } = readSkillMd(join(installed.path, "SKILL.md"));
    updatedFm.origin = {
      ...updatedFm.origin!,
      "base-version": remoteHead,
      "base-content-hash": newHash,
      "installed-at": new Date().toISOString(),
      modified: false,
      ...(tag ? { "base-tag": tag } : {}),
    };
    writeSkillMd(join(installed.path, "SKILL.md"), updatedFm, body);

    const relPath = relative(hiveHome, installed.path);
    commitToState(hiveHome, [relPath], `upgrade: ${skillName} ${oldVersion.slice(0, 8)} → ${remoteHead.slice(0, 8)} (took upstream)`);

    return { name: skillName, action: "taken", oldVersion, newVersion: remoteHead };
  } finally {
    clone.cleanup();
  }
}

/**
 * Find an installed skill by name, searching all workflows in customer space.
 */
function findInstalledSkill(name: string): { path: string; workflow: string } | null {
  if (!existsSync(skillsDir)) return null;
  const { readdirSync, statSync } = require("node:fs");

  for (const workflow of readdirSync(skillsDir)) {
    const skillPath = join(skillsDir, workflow, "skills", name);
    if (existsSync(join(skillPath, "SKILL.md"))) {
      return { path: skillPath, workflow };
    }
  }
  return null;
}

export { findInstalledSkill };
```

- [ ] **Step 2:** Write upgrade tests (mocked git, file:// registries)

- [ ] **Step 3:** Commit

```bash
git add src/skills/upgrade.ts src/skills/upgrade.test.ts
git commit -m "feat(skills): upgrade flow with three-way diff support"
```

---

### Task 10: Remove Flow

**Files:**
- Create: `src/skills/remove.ts`

- [ ] **Step 1:** Create `src/skills/remove.ts`

Per registry spec §9.

```typescript
import { existsSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { readSkillMd } from "./frontmatter.js";
import { commitRemovalToState } from "./instance-git.js";
import { hiveHome, skillsDir } from "../paths.js";
import { findInstalledSkill } from "./upgrade.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-remove");

export interface RemoveOptions {
  force?: boolean;
  confirmFn?: (message: string) => Promise<boolean>;
}

/**
 * Remove an installed skill from customer space.
 * Per registry spec §9.1.
 */
export async function removeSkill(
  skillName: string,
  opts: RemoveOptions = {},
): Promise<void> {
  const installed = findInstalledSkill(skillName);
  if (!installed) {
    throw new Error(`Skill "${skillName}" is not installed.`);
  }

  // Check for modifications (warn before removing)
  const skillMdPath = join(installed.path, "SKILL.md");
  if (existsSync(skillMdPath)) {
    try {
      const { frontmatter } = readSkillMd(skillMdPath);
      const isModified = frontmatter.origin?.modified === true || frontmatter.origin?.type === "agent-authored";

      if (isModified && !opts.force) {
        const message =
          `Warning: ${installed.workflow}/${skillName} has local modifications that will be removed. ` +
          `Your changes are preserved in git history on the 'state' branch; ` +
          `you can recover them later with 'git show state:skills/${installed.workflow}/skills/${skillName}/'. ` +
          `Proceed?`;

        if (opts.confirmFn) {
          const confirmed = await opts.confirmFn(message);
          if (!confirmed) {
            console.log("Aborted.");
            return;
          }
        } else {
          console.log(message);
          console.log("Use --force to skip this prompt.");
          return;
        }
      }
    } catch {
      // Frontmatter parse failure — proceed with removal
    }
  }

  // Delete the directory
  const relPath = relative(hiveHome, installed.path);
  rmSync(installed.path, { recursive: true, force: true });

  // Clean up empty workflow directory if this was the last skill
  const workflowSkillsDir = join(skillsDir, installed.workflow, "skills");
  if (existsSync(workflowSkillsDir)) {
    const { readdirSync } = require("node:fs");
    const remaining = readdirSync(workflowSkillsDir);
    if (remaining.length === 0) {
      rmSync(join(skillsDir, installed.workflow), { recursive: true, force: true });
    }
  }

  // Commit removal
  commitRemovalToState(hiveHome, [relPath], `remove: ${installed.workflow}/${skillName}`);

  log.info("Skill removed", { name: skillName, workflow: installed.workflow });
  console.log(`Removed ${installed.workflow}/${skillName}`);
}
```

- [ ] **Step 2:** Commit

```bash
git add src/skills/remove.ts
git commit -m "feat(skills): remove flow with modification warning"
```

---

### Task 11: CLI Commands — `hive skill` and `hive registry`

**Files:**
- Create: `src/cli/skill.ts`
- Create: `src/cli/registry.ts`
- Modify: `src/cli.ts:24-49` (help text)
- Modify: `src/cli.ts:64-117` (command switch)

- [ ] **Step 1:** Create `src/cli/skill.ts`

```typescript
import { verifyGitAvailable } from "../skills/registry-fetch.js";
import { parseSkillSpec, resolveRegistry } from "../skills/registry-resolver.js";
import { installSkill } from "../skills/install.js";
import { upgradeSkill } from "../skills/upgrade.js";
import { removeSkill } from "../skills/remove.js";
import { skillsDir } from "../paths.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export async function runSkill(subcommand?: string, ...args: string[]): Promise<void> {
  verifyGitAvailable();

  switch (subcommand) {
    case "add": {
      const spec = args[0];
      if (!spec) {
        console.error("Usage: hive skill add <name|registry:name|url#skills/name>");
        process.exit(1);
      }
      const parsed = parseSkillSpec(spec);
      const registry = resolveRegistry(parsed);
      const result = installSkill(registry.url, parsed.name);
      console.log(`Installed ${result.workflow}/${result.name} (${result.version.slice(0, 8)})`);
      break;
    }

    case "list": {
      const showAvailable = args.includes("--available");
      if (showAvailable) {
        await listAvailable(args);
      } else {
        listInstalled();
      }
      break;
    }

    case "upgrade": {
      const target = args[0];
      if (!target) {
        console.error("Usage: hive skill upgrade <name|--all>");
        process.exit(1);
      }

      const promptFn = async (yours: string, theirs: string, base?: string): Promise<"keep" | "take"> => {
        console.log("\n--- Your version (installed) ---");
        console.log(yours.slice(0, 500) + (yours.length > 500 ? "\n..." : ""));
        console.log("\n--- Upstream version (registry) ---");
        console.log(theirs.slice(0, 500) + (theirs.length > 500 ? "\n..." : ""));
        if (base) console.log("\n(Three-way diff available — base version accessible)");
        else console.log("\n(Two-way comparison — base version unreachable)");

        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question("\n[k]eep your version or [t]ake upstream? ", resolve);
        });
        rl.close();
        return answer.toLowerCase().startsWith("t") ? "take" : "keep";
      };

      if (target === "--all") {
        await upgradeAll(promptFn);
      } else {
        const result = await upgradeSkill(target, promptFn);
        console.log(`${result.name}: ${result.action}`);
      }
      break;
    }

    case "remove": {
      const name = args[0];
      if (!name) {
        console.error("Usage: hive skill remove <name> [--force]");
        process.exit(1);
      }
      const force = args.includes("--force");

      const confirmFn = async (message: string): Promise<boolean> => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`${message} [y/N] `, resolve);
        });
        rl.close();
        return answer.toLowerCase() === "y";
      };

      await removeSkill(name, { force, confirmFn });
      break;
    }

    case "search": {
      const query = args[0];
      if (!query) {
        console.error("Usage: hive skill search <query>");
        process.exit(1);
      }
      await searchSkills(query);
      break;
    }

    default:
      console.error("Usage: hive skill <add|list|upgrade|remove|search> [args]");
      process.exit(1);
  }
}

function listInstalled(): void {
  if (!existsSync(skillsDir)) {
    console.log("No skills installed.");
    return;
  }

  const workflows = readdirSync(skillsDir).filter((d) => {
    try { return require("node:fs").statSync(join(skillsDir, d)).isDirectory(); } catch { return false; }
  });

  if (workflows.length === 0) {
    console.log("No skills installed.");
    return;
  }

  console.log("Installed skills:\n");
  console.log("  %-25s %-20s %-15s %-30s %s", "NAME", "WORKFLOW", "ORIGIN", "SOURCE", "MODIFIED");

  for (const workflow of workflows.sort()) {
    const skillsSubdir = join(skillsDir, workflow, "skills");
    if (!existsSync(skillsSubdir)) continue;

    for (const skill of readdirSync(skillsSubdir).sort()) {
      const mdPath = join(skillsSubdir, skill, "SKILL.md");
      if (!existsSync(mdPath)) continue;

      try {
        const content = readFileSync(mdPath, "utf-8");
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        const fm = fmMatch?.[1] ?? "";

        const originType = fm.match(/^\s*type:\s*(.+)$/m)?.[1]?.trim() ?? "unknown";
        const source = fm.match(/^\s*source:\s*(.+)$/m)?.[1]?.trim()
          ?? fm.match(/^\s*agent-id:\s*(.+)$/m)?.[1]?.trim()
          ?? "-";
        const modified = fm.match(/^\s*modified:\s*(.+)$/m)?.[1]?.trim() ?? "-";

        console.log("  %-25s %-20s %-15s %-30s %s", skill, workflow, originType, source, modified);
      } catch {
        console.log("  %-25s %-20s %-15s %-30s %s", skill, workflow, "?", "?", "?");
      }
    }
  }
}

async function listAvailable(args: string[]): Promise<void> {
  const fromIdx = args.indexOf("--from");
  const fromArg = fromIdx >= 0 ? args[fromIdx + 1] : undefined;

  // Resolve registry
  const { shallowClone, listSkillsInClone } = await import("../skills/registry-fetch.js");
  const { config } = await import("../config.js");

  const registries = fromArg
    ? [{ name: fromArg, url: config.skillRegistries.find((r) => r.name === fromArg)?.url ?? fromArg }]
    : config.skillRegistries;

  for (const reg of registries) {
    console.log(`\nRegistry: ${reg.name} (${reg.url})\n`);
    const clone = shallowClone(reg.url);
    try {
      const names = listSkillsInClone(clone.dir);
      if (names.length === 0) {
        console.log("  (no skills)");
        continue;
      }
      for (const name of names.sort()) {
        // Read description from frontmatter
        const mdPath = join(clone.dir, "skills", name, "SKILL.md");
        const content = readFileSync(mdPath, "utf-8");
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const desc = descMatch?.[1]?.trim() ?? "";
        console.log(`  %-30s %s`, name, desc);
      }
    } finally {
      clone.cleanup();
    }
  }
}

async function searchSkills(query: string): Promise<void> {
  // Search installed skills first
  console.log("Searching installed skills...\n");
  const lowerQuery = query.toLowerCase();

  if (existsSync(skillsDir)) {
    for (const workflow of readdirSync(skillsDir)) {
      const skillsSubdir = join(skillsDir, workflow, "skills");
      if (!existsSync(skillsSubdir)) continue;

      for (const skill of readdirSync(skillsSubdir)) {
        const mdPath = join(skillsSubdir, skill, "SKILL.md");
        if (!existsSync(mdPath)) continue;

        const content = readFileSync(mdPath, "utf-8");
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const desc = descMatch?.[1]?.trim() ?? "";

        if (skill.toLowerCase().includes(lowerQuery) || desc.toLowerCase().includes(lowerQuery)) {
          console.log(`  ${skill} (${workflow}) — ${desc}`);
        }
      }
    }
  }
}

async function upgradeAll(
  promptFn: (yours: string, theirs: string, base?: string) => Promise<"keep" | "take">,
): Promise<void> {
  if (!existsSync(skillsDir)) {
    console.log("No skills installed.");
    return;
  }

  const skills: string[] = [];
  for (const workflow of readdirSync(skillsDir)) {
    const skillsSubdir = join(skillsDir, workflow, "skills");
    if (!existsSync(skillsSubdir)) continue;

    for (const skill of readdirSync(skillsSubdir).sort()) {
      const mdPath = join(skillsSubdir, skill, "SKILL.md");
      if (!existsSync(mdPath)) continue;

      try {
        const content = readFileSync(mdPath, "utf-8");
        if (content.includes("type: registry")) {
          skills.push(skill);
        }
      } catch { /* skip */ }
    }
  }

  if (skills.length === 0) {
    console.log("No registry-sourced skills to upgrade.");
    return;
  }

  for (const name of skills) {
    try {
      const result = await upgradeSkill(name, promptFn);
      console.log(`${result.name}: ${result.action}`);
    } catch (err) {
      console.error(`${name}: failed — ${String(err)}`);
    }
  }
}
```

- [ ] **Step 2:** Create `src/cli/registry.ts`

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { hiveHome } from "../paths.js";
import { load as loadYaml, dump as dumpYaml } from "js-yaml"; // or use simple string manipulation

export async function runRegistry(subcommand?: string, ...args: string[]): Promise<void> {
  const configPath = resolve(hiveHome, process.env.HIVE_CONFIG || "hive.yaml");

  switch (subcommand) {
    case "add": {
      const url = args[0];
      if (!url) {
        console.error("Usage: hive registry add <url> [--as <name>] [--default]");
        process.exit(1);
      }

      const asIdx = args.indexOf("--as");
      const name = asIdx >= 0 ? args[asIdx + 1]! : inferName(url);
      const isDefault = args.includes("--default");

      // Read current hive.yaml, add to skillRegistries
      const config = readHiveYaml(configPath);
      if (!config.skillRegistries) config.skillRegistries = [];

      // Check for duplicate
      if (config.skillRegistries.some((r: any) => r.name === name)) {
        console.error(`Registry "${name}" already exists. Remove it first with: hive registry remove ${name}`);
        process.exit(1);
      }

      // If --default, unset previous default
      if (isDefault) {
        for (const r of config.skillRegistries) r.default = undefined;
      }

      config.skillRegistries.push({ name, url, ...(isDefault ? { default: true } : {}) });
      writeHiveYaml(configPath, config);
      console.log(`Added registry "${name}" (${url})${isDefault ? " [default]" : ""}`);
      break;
    }

    case "list": {
      const config = readHiveYaml(configPath);
      const registries = config.skillRegistries ?? [];

      if (registries.length === 0) {
        console.log("No registries configured. Using built-in default: https://github.com/keepur/hive-skills");
        return;
      }

      console.log("Configured registries:\n");
      for (const r of registries) {
        const marker = r.default ? " (default)" : "";
        console.log(`  ${r.name}${marker}`);
        console.log(`    ${r.url}`);
      }
      break;
    }

    case "remove": {
      const name = args[0];
      if (!name) {
        console.error("Usage: hive registry remove <name>");
        process.exit(1);
      }

      const config = readHiveYaml(configPath);
      if (!config.skillRegistries) {
        console.error("No registries configured.");
        process.exit(1);
      }

      const idx = config.skillRegistries.findIndex((r: any) => r.name === name);
      if (idx < 0) {
        console.error(`Registry "${name}" not found.`);
        process.exit(1);
      }

      config.skillRegistries.splice(idx, 1);
      writeHiveYaml(configPath, config);
      console.log(`Removed registry "${name}". Installed skills from this registry are unaffected.`);
      break;
    }

    default:
      console.error("Usage: hive registry <add|list|remove>");
      process.exit(1);
  }
}

function readHiveYaml(path: string): any {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  // Simple YAML parsing — hive.yaml is well-structured
  // Use js-yaml if available, otherwise a simple parser
  try {
    const yaml = require("js-yaml");
    return yaml.load(content) ?? {};
  } catch {
    throw new Error("Could not parse hive.yaml. Ensure js-yaml is available.");
  }
}

function writeHiveYaml(path: string, data: any): void {
  const yaml = require("js-yaml");
  writeFileSync(path, yaml.dump(data, { lineWidth: -1 }));
}

function inferName(url: string): string {
  const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts.slice(-2).join("-").replace(/^github\.com-/, "");
}
```

- [ ] **Step 3:** Wire into `src/cli.ts`

Add to the help text:

```
  skill add <spec>  Install a skill from a registry
  skill list        List installed skills
  skill upgrade     Upgrade installed skills
  skill remove      Remove an installed skill
  skill search      Search for skills
  registry add      Add a skill registry
  registry list     List configured registries
  registry remove   Remove a registry
```

Add to the switch statement:

```typescript
case "skill": {
  const subcommand = positionals[1];
  const args = positionals.slice(2);
  const { runSkill } = await import("./cli/skill.js");
  await runSkill(subcommand, ...args);
  break;
}
case "registry": {
  const subcommand = positionals[1];
  const args = positionals.slice(2);
  const { runRegistry } = await import("./cli/registry.js");
  await runRegistry(subcommand, ...args);
  break;
}
```

- [ ] **Step 4:** Verify

Run: `npm run typecheck && npm run build`
Expected: Clean compilation

- [ ] **Step 5:** Commit

```bash
git add src/cli/skill.ts src/cli/registry.ts src/cli.ts
git commit -m "feat(skills): hive skill and hive registry CLI commands"
```

---

### Task 12: Remove `skills/` from Repo Root

**Files:**
- Delete: `skills/` directory (all 5 workflows)
- Modify: `.gitignore` (if `skills/` needs to be ignored for customer instances running from repo root in dev)

- [ ] **Step 1:** Verify the skills are documented/triaged

Before removing, confirm the 5 workflows (`agent-builder`, `inbound-triage`, `jasper-reports`, `morning-briefing`, `project-tools`) are either:
- Published to the default Keepur registry (a separate task — repo creation)
- Documented as dropped

This is the Keepur-side triage from customer-space spec §10.3. The actual registry publication (creating `github.com/keepur/hive-skills` and seeding it) is a separate out-of-band task.

- [ ] **Step 2:** Remove the `skills/` directory from the repo

```bash
git rm -r skills/
```

- [ ] **Step 3:** Add `skills/` to `.gitignore`

So that customer-space skills created during dev (when running from the repo root) don't get accidentally committed:

```
# Customer-space skills (created at runtime, not part of the package)
skills/
```

- [ ] **Step 4:** Commit

```bash
git add -A skills/ .gitignore
git commit -m "feat(skills): remove shipped skills from core repo

Skills are no longer part of the hive core package. They will be
available from the default Keepur registry (github.com/keepur/hive-skills)
for customers to install with 'hive skill add <name>'."
```

---

### Task 13: Spec Amendments

**Files:**
- Modify: `docs/specs/2026-04-14-skills-system-design.md`
- Modify: `docs/specs/2026-04-14-plugin-architecture-design.md` (if it exists)

- [ ] **Step 1:** Amend skills-system-design.md per customer-space spec §12.1

- §5.2: Remove category 1 ("Shipped with Hive core"), add cross-reference to customer-space spec §5
- §6: Add §6.3 "Customer-space skills" subsection with cross-references
- §7: Update from "Reserved, Not Built" to "Specified in registry spec" with cross-reference
- §8: Add cross-reference noting agent-authored skills now in `<instance-dir>/skills/`
- §9: Add note that deferral condition has not been triggered

- [ ] **Step 2:** Amend plugin-architecture-design.md §7.1 per customer-space spec §12.2

Add the paragraph from spec §12.2 about the parallel rule for skills — zero skills in tarball, skills arrive via three channels, trust posture asymmetry cross-reference.

- [ ] **Step 3:** Commit

```bash
git add docs/specs/
git commit -m "docs(spec): amend skills-system-design and plugin-architecture per KPR-29 specs"
```

---

### Task 14: Modification Detection on Loader Reload

**Files:**
- Modify: `src/agents/skill-loader.ts` (add auto-detection in customer-space scan)

- [ ] **Step 1:** Add modification detection to the customer-space scan

Per registry spec §8.3: on loader reload, for any skill with `origin.type: registry` and `origin.modified: false`, recompute the content hash and compare against `origin.base-content-hash`. If different, flip `origin.modified: true`.

Add this check inside `scanWorkflowsFrom` when processing customer-space skills (source === "customer"). For each SKILL.md with registry origin and `modified: false`:

1. Read `origin.base-content-hash` from frontmatter
2. Recompute `computeContentHash(skillDir)`
3. If they differ, update the SKILL.md frontmatter to set `modified: true`

Performance optimization: check directory mtime before recomputing hash. Skip if mtime hasn't changed since last check. Store last-check timestamps in memory (not persisted — reset on restart is fine).

- [ ] **Step 2:** Commit

```bash
git add src/agents/skill-loader.ts
git commit -m "feat(skills): auto-detect customer modifications to registry-installed skills"
```

---

### Task 15: Integration Test

**Files:**
- Create: `src/skills/integration.test.ts`

- [ ] **Step 1:** Write an end-to-end integration test

Using a temp directory as `hiveHome` and a local `file://` git repo as a mock registry:

1. Set up a local git repo with two skills (one with `workflow:`, one without)
2. Run `installSkill(fileUrl, "skill-a")` — verify files land in correct nested path with origin metadata
3. Run `installSkill(fileUrl, "skill-b")` — verify degenerate projection
4. Verify `listInstalled` shows both
5. Edit skill-a's SKILL.md content
6. Trigger loader reload — verify `origin.modified` flips to `true`
7. Run `upgradeSkill("skill-a", ...)` — verify modified prompt is triggered
8. Run `removeSkill("skill-b")` — verify directory is cleaned up
9. Verify state branch has audit commits for each operation

- [ ] **Step 2:** Verify

Run: `npx vitest run src/skills/integration`

- [ ] **Step 3:** Commit

```bash
git add src/skills/integration.test.ts
git commit -m "test(skills): end-to-end integration test for install/upgrade/remove"
```

---

## Dependency Graph

```
Task 1 (paths, frontmatter, hash) ─────┐
                                        ├─→ Task 3 (instance-git)
Task 2 (loader refactor) ──────────────┤
                                        ├─→ Task 4 (write guard)
                                        │
Task 6 (config + resolver) ────────────┤
                                        ├─→ Task 7 (fetch + projection)
                                        │         │
                                        │         ├─→ Task 8 (install)
                                        │         ├─→ Task 9 (upgrade)
                                        │         └─→ Task 10 (remove)
                                        │                 │
Task 5 (integrity + notice) ───────────│                 ├─→ Task 11 (CLI)
                                        │                 │
Task 12 (remove skills/) ──────────────│─────────────────┘
                                        │
Task 13 (spec amendments) ─────────────┘
Task 14 (modification detection) ← Task 1
Task 15 (integration test) ← Tasks 1-11
```

**Parallelizable groups:**
- Tasks 1, 2, 6 can start in parallel (no mutual dependencies)
- Tasks 3, 4, 5 depend on Task 1
- Tasks 7, 8, 9, 10 are sequential (each builds on prior)
- Task 11 depends on 8, 9, 10
- Task 12 can happen any time after Task 2
- Task 13 can happen any time
- Task 14 depends on Task 1
- Task 15 depends on everything else

---

## Out-of-Band Work (Not in This Plan)

These items from the spec are manual operations or separate repos, not code tasks in hive-core:

1. **Create `github.com/keepur/hive-skills` repo** — seed with triaged skills from the current `skills/` tree, cut `skills-v1.0` tag
2. **Migration execution on dodi-hive** — pre-upgrade audit, backup, upgrade, reinstall
3. **Migration execution on Mike's mac-mini** — same, plus restore `morning-briefing` edit
4. **KPR-29 Linear ticket update** — mark as resolved per customer-space spec §12.3
