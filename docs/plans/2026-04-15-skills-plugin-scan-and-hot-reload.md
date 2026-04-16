# Skills: Plugin Scan + Hot Reload Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Extend `skill-loader.ts` to scan plugin-bundled skills with deterministic collision handling, and wire `AgentManager` so both boot and SIGUSR1 reload pick up plugin skills.

**Architecture:** `loadSkillIndex` gains an optional `plugins` parameter. Core skills (`<repo>/skills/`) load first, then each plugin's `<plugin.dir>/skills/` in `hive.yaml` order. Collision is detected at the bare workflow directory name: first registration wins, second is logged and skipped. `AgentManager` passes `this.plugins` at both call sites (constructor line 50 and `reloadSkills()` lines 64–70). §6.2 hot reload is already wired — only the §6.1 signature change needs to flow through `reloadSkills()`.

**Tech Stack:** TypeScript, Node `fs`, Claude Agent SDK, Vitest.

**Spec:** `docs/specs/2026-04-14-skills-system-design.md` §§6.1–6.2

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/agents/skill-loader.ts` | Single entry `loadSkillIndex(skillsDir?, plugins?)`. Scans core + plugin dirs, builds workflow collision map, returns `SkillIndex`. Also fixes stale debug log. |
| `src/agents/agent-manager.ts` | Pass `this.plugins` at both `loadSkillIndex` call sites. |
| `src/agents/skill-loader.test.ts` (new) | Covers: core-only load, plugin scan, core-vs-plugin collision, plugin-vs-plugin collision, missing `skills/` subdir in plugin, hot reload re-pickup, universal merging still works. |

---

## Task 1: Extract core workflow scan into a helper

**Files:**
- Modify: `src/agents/skill-loader.ts`

Refactor the inner loop of `loadSkillIndex` into a private helper `scanWorkflowsFrom(dir, source, collisionMap, index, universalPlugins)` so the same code can run against core and each plugin. No behavior change in this task — just the extraction.

- [ ] **Step 1:** Open `src/agents/skill-loader.ts` and replace the whole file with the refactored version below. The new version:
  - Adds `plugins?: LoadedPlugin[]` parameter to `loadSkillIndex`
  - Extracts workflow-scanning into `scanWorkflowsFrom`
  - Adds a `Map<string, { source: string; path: string }>` collision map keyed by bare workflow directory name
  - Logs structured collision warnings
  - Fixes the stale `.claude/skills/` debug log
  - Scans core first, then plugins in order

```typescript
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import type { LoadedPlugin } from "../plugins/types.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-loader");

export type SkillIndex = Map<string, SdkPluginConfig[]>;

type CollisionEntry = { source: string; path: string };

/**
 * Scan core skills/ and (optionally) plugin-bundled skills, build a map of
 * agentId → SdkPluginConfig[] for that agent's workflows.
 *
 * Collisions are detected on bare workflow directory name. Core wins over
 * plugins; earlier plugins win over later plugins (input order from hive.yaml
 * is preserved by loadPlugins in src/plugins/plugin-loader.ts).
 */
export function loadSkillIndex(
  skillsDir: string = resolve("skills"),
  plugins?: LoadedPlugin[],
): SkillIndex {
  const index: SkillIndex = new Map();
  const universalPlugins: SdkPluginConfig[] = [];
  const collisionMap = new Map<string, CollisionEntry>();

  // Core first
  if (existsSync(skillsDir)) {
    scanWorkflowsFrom(skillsDir, "core", collisionMap, index, universalPlugins);
  } else {
    log.debug("No core skills directory found", { path: skillsDir });
  }

  // Then plugins, in hive.yaml order
  for (const plugin of plugins ?? []) {
    const pluginSkillsDir = join(plugin.dir, "skills");
    if (!existsSync(pluginSkillsDir)) continue;
    scanWorkflowsFrom(pluginSkillsDir, plugin.name, collisionMap, index, universalPlugins);
  }

  // Merge universal plugins into every agent's list + expose via sentinel
  if (universalPlugins.length > 0) {
    for (const agentId of [...index.keys()]) {
      const existing = index.get(agentId)!;
      existing.push(...universalPlugins);
    }
    index.set("__universal__", universalPlugins);
  }

  log.info("Skill index loaded", {
    workflows: collisionMap.size,
    agents: index.size - (index.has("__universal__") ? 1 : 0),
  });

  return index;
}

/**
 * Scan one top-level skills directory (core or plugin), register non-colliding
 * workflows into the index, and append to universalPlugins for hive-wide skills.
 */
function scanWorkflowsFrom(
  rootDir: string,
  source: string,
  collisionMap: Map<string, CollisionEntry>,
  index: SkillIndex,
  universalPlugins: SdkPluginConfig[],
): void {
  let workflows: string[];
  try {
    workflows = readdirSync(rootDir).filter((d) =>
      statSync(join(rootDir, d)).isDirectory(),
    );
  } catch (err) {
    log.warn("Failed to read skills directory", { source, path: rootDir, error: String(err) });
    return;
  }

  for (const workflow of workflows) {
    const workflowPath = join(rootDir, workflow);
    const skillsSubdir = join(workflowPath, "skills");

    if (!existsSync(skillsSubdir)) {
      log.debug("Workflow missing skills/ subdirectory, skipping", { source, workflow });
      continue;
    }

    const existing = collisionMap.get(workflow);
    if (existing) {
      log.warn("Skill workflow collision — keeping first, skipping second", {
        workflow,
        kept: existing,
        skipped: { source, path: workflowPath },
      });
      continue;
    }
    collisionMap.set(workflow, { source, path: workflowPath });

    const pluginConfig: SdkPluginConfig = { type: "local", path: workflowPath };

    const agentIds = new Set<string>();
    let hasAll = false;

    let skillDirs: string[];
    try {
      skillDirs = readdirSync(skillsSubdir).filter((d) =>
        statSync(join(skillsSubdir, d)).isDirectory(),
      );
    } catch (err) {
      log.warn("Failed to read workflow skills subdir", { source, workflow, error: String(err) });
      continue;
    }

    for (const skillDir of skillDirs) {
      const skillMd = join(skillsSubdir, skillDir, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      const agents = parseAgentsFromFrontmatter(readFileSync(skillMd, "utf-8"));
      for (const agent of agents) {
        if (agent === "all") {
          hasAll = true;
        } else {
          agentIds.add(agent);
        }
      }
    }

    if (hasAll) {
      universalPlugins.push(pluginConfig);
      log.debug("Workflow registered as universal", { source, workflow, skills: skillDirs.length });
    } else if (agentIds.size > 0) {
      for (const agentId of agentIds) {
        const existing = index.get(agentId) ?? [];
        existing.push(pluginConfig);
        index.set(agentId, existing);
      }
      log.debug("Workflow registered", {
        source,
        workflow,
        agents: [...agentIds],
        skills: skillDirs.length,
      });
    }
  }
}

/**
 * Look up skills for a specific agent. Merges agent-specific + universal.
 */
export function getSkillsForAgent(index: SkillIndex, agentId: string): SdkPluginConfig[] {
  const agentSkills = index.get(agentId) ?? [];
  const universal = index.get("__universal__") ?? [];

  if (agentSkills.length > 0 && universal.length > 0) {
    const paths = new Set(agentSkills.map((p) => p.path));
    const missing = universal.filter((p) => !paths.has(p.path));
    return [...agentSkills, ...missing];
  }

  if (agentSkills.length === 0 && universal.length > 0) {
    return [...universal];
  }

  return agentSkills;
}

/**
 * Parse the agents field from SKILL.md YAML frontmatter.
 * Returns empty array if no frontmatter or no agents field.
 */
function parseAgentsFromFrontmatter(content: string): string[] {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];

  const frontmatter = match[1]!;

  const agentsMatch = frontmatter.match(/^agents:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (agentsMatch) {
    return agentsMatch[1]!
      .split("\n")
      .map((line) => line.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean);
  }

  const inlineMatch = frontmatter.match(/^agents:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
}
```

- [ ] **Step 2:** Verify typecheck.

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3:** Run existing agent-manager test to confirm no regression from the refactor (it exercises `loadSkillIndex()` with no args).

Run: `npx vitest run src/agents/agent-manager.test.ts`
Expected: all tests pass.

---

## Task 2: Wire `AgentManager` to pass plugins into loader

**Files:**
- Modify: `src/agents/agent-manager.ts:50` and `src/agents/agent-manager.ts:64-70`

- [ ] **Step 1:** At line 50, replace:

```typescript
    this.skillIndex = loadSkillIndex();
```

with:

```typescript
    this.skillIndex = loadSkillIndex(undefined, this.plugins);
```

- [ ] **Step 2:** In `reloadSkills()` (lines 64–70), replace:

```typescript
  reloadSkills(): void {
    try {
      this.skillIndex = loadSkillIndex();
    } catch (err) {
      log.warn("Skill reload failed, retaining previous index", { error: String(err) });
    }
  }
```

with:

```typescript
  reloadSkills(): void {
    try {
      this.skillIndex = loadSkillIndex(undefined, this.plugins);
    } catch (err) {
      log.warn("Skill reload failed, retaining previous index", { error: String(err) });
    }
  }
```

- [ ] **Step 3:** Verify typecheck.

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 3: Tests for plugin scan + collision + hot reload

**Files:**
- Create: `src/agents/skill-loader.test.ts`

- [ ] **Step 1:** Create the test file. Uses a temp dir fixture — builds core and fake plugin trees on disk, runs `loadSkillIndex`, asserts on the returned index and on collision warnings via a spy.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillIndex, getSkillsForAgent } from "./skill-loader.js";
import type { LoadedPlugin } from "../plugins/types.js";

function writeSkill(
  root: string,
  workflow: string,
  skill: string,
  agents: string[],
): void {
  const dir = join(root, workflow, "skills", skill);
  mkdirSync(dir, { recursive: true });
  const agentsYaml = agents.map((a) => `  - ${a}`).join("\n");
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${skill}\ndescription: test\nagents:\n${agentsYaml}\n---\n\n# ${skill}\n`,
  );
}

function makePlugin(name: string, dir: string): LoadedPlugin {
  return {
    name,
    dir,
    manifest: {
      name,
      version: "0.0.1",
      mcpServers: {},
      agentSeeds: [],
    } as LoadedPlugin["manifest"],
  };
}

describe("loadSkillIndex", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-loader-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads core-only skills", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "alpha", "one", ["milo"]);

    const index = loadSkillIndex(core);

    expect(getSkillsForAgent(index, "milo")).toHaveLength(1);
    expect(getSkillsForAgent(index, "other")).toHaveLength(0);
  });

  it("loads plugin-bundled skills alongside core", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "alpha", "core-skill", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "beta", "plugin-skill", ["milo"]);

    const index = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);

    const miloSkills = getSkillsForAgent(index, "milo");
    expect(miloSkills).toHaveLength(2);
    expect(miloSkills.map((s) => s.path).sort()).toEqual(
      [join(core, "alpha"), join(pluginDir, "skills", "beta")].sort(),
    );
  });

  it("core wins collision vs plugin", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "shared", "core-version", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "shared", "plugin-version", ["milo"]);

    const index = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);

    const paths = getSkillsForAgent(index, "milo").map((s) => s.path);
    expect(paths).toEqual([join(core, "shared")]);
  });

  it("first-loaded plugin wins collision vs later plugin", () => {
    const core = join(tmp, "core-skills");
    mkdirSync(core, { recursive: true });

    const pluginA = join(tmp, "plugin-a");
    writeSkill(join(pluginA, "skills"), "shared", "a-version", ["milo"]);

    const pluginB = join(tmp, "plugin-b");
    writeSkill(join(pluginB, "skills"), "shared", "b-version", ["milo"]);

    const index = loadSkillIndex(core, [
      makePlugin("plugin-a", pluginA),
      makePlugin("plugin-b", pluginB),
    ]);

    const paths = getSkillsForAgent(index, "milo").map((s) => s.path);
    expect(paths).toEqual([join(pluginA, "skills", "shared")]);
  });

  it("ignores plugins with no skills/ subdir", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "alpha", "one", ["milo"]);

    const pluginDir = join(tmp, "plugin-no-skills");
    mkdirSync(pluginDir, { recursive: true });

    const index = loadSkillIndex(core, [makePlugin("plugin-no-skills", pluginDir)]);
    expect(getSkillsForAgent(index, "milo")).toHaveLength(1);
  });

  it("universal skills merge across core and plugins", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "alpha", "for-milo", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "beta", "for-all", ["all"]);

    const index = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);

    expect(getSkillsForAgent(index, "milo")).toHaveLength(2);
    expect(getSkillsForAgent(index, "brand-new")).toHaveLength(1);
  });

  it("hot reload picks up a newly-written plugin skill", () => {
    const core = join(tmp, "core-skills");
    mkdirSync(core, { recursive: true });

    const pluginDir = join(tmp, "plugin-a");
    mkdirSync(join(pluginDir, "skills"), { recursive: true });

    const before = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);
    expect(getSkillsForAgent(before, "milo")).toHaveLength(0);

    writeSkill(join(pluginDir, "skills"), "beta", "new-skill", ["milo"]);

    const after = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);
    expect(getSkillsForAgent(after, "milo")).toHaveLength(1);
  });
});
```

- [ ] **Step 2:** Run the new tests.

Run: `npx vitest run src/agents/skill-loader.test.ts`
Expected: 7 tests pass.

- [ ] **Step 3:** Run full quality gate.

Run: `npm run check`
Expected: typecheck + lint + format + test all green.

- [ ] **Step 4:** Commit.

```bash
git add src/agents/skill-loader.ts src/agents/agent-manager.ts src/agents/skill-loader.test.ts docs/plans/2026-04-15-skills-plugin-scan-and-hot-reload.md
git commit -m "feat(skills): scan plugin-bundled skills with collision rules (#137)"
```

---

## Out of Scope (do not touch in this ticket)

- `<instance-dir>/skills/` scan (KPR-29 scope — customer-space partition)
- Removal of `<repo>/skills/` scan (KPR-29 scope)
- Write guard on agent SKILL.md writes (KPR-29 scope)
- `hive skill add/remove/list` CLI (reserved in spec §7, no ticket yet)
- Mongo storage for agent-authored skills (spec §9, deferred)

---

## Risks / Watch Items

- **`LoadedPlugin.manifest` shape in tests.** Minimal mock — if `PluginManifest` adds required fields, the `as` cast in `makePlugin` may need adjustment. Test-only concern, caught immediately by typecheck.
- **`fs.watch` on `<repo>/skills/` (existing, in `src/index.ts`).** Does not watch plugin dirs. Intentional: plugin skills change at plugin-install time, not at runtime; SIGUSR1 covers that case. Noted here so a future reader doesn't mistake it for a gap.
- **Collision on an agent's own workflow via agent-authored path.** Not applicable under #137 (agent writes still land in `<repo>/skills/`, which is scanned as `source: "core"` and wins any collision). Becomes relevant under KPR-29 when the instance-dir scan lands.
