# Hive-Native Skills — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Enable hive agents to use repo-native skills organized by workflow, loaded via the SDK's plugin system.

**Architecture:** A `skills/` directory at repo root contains workflow folders, each structured as an SDK-compatible plugin (`.claude/skills/<name>/SKILL.md`). A `SkillIndex` module scans skills at startup, parses `agents` frontmatter, and builds a per-agent map. `AgentRunner` merges native skills with external plugins before passing to `query()`. Hot-reload watches `skills/` alongside `agents/`.

**Tech Stack:** TypeScript, Claude Agent SDK (`SdkPluginConfig`), Node.js fs APIs, YAML frontmatter parsing

---

### Task 1: Create skill-loader module

**Files:**
- Create: `src/agents/skill-loader.ts`

- [ ] **Step 1:** Create the skill-loader module

```typescript
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-loader");

export type SkillIndex = Map<string, SdkPluginConfig[]>;

/**
 * Scan skills/ for workflow directories, parse SKILL.md frontmatter,
 * build a map of agentId → SdkPluginConfig[] for that agent's workflows.
 */
export function loadSkillIndex(skillsDir: string = resolve("skills")): SkillIndex {
  const index: SkillIndex = new Map();

  if (!existsSync(skillsDir)) {
    log.debug("No skills directory found", { path: skillsDir });
    return index;
  }

  // Collect workflows that apply to "all" agents
  const universalPlugins: SdkPluginConfig[] = [];

  // Each top-level dir in skills/ is a workflow
  const workflows = readdirSync(skillsDir).filter((d) =>
    statSync(join(skillsDir, d)).isDirectory(),
  );

  for (const workflow of workflows) {
    const workflowPath = join(skillsDir, workflow);
    const skillsSubdir = join(workflowPath, ".claude", "skills");

    if (!existsSync(skillsSubdir)) {
      log.debug("Workflow missing .claude/skills/, skipping", { workflow });
      continue;
    }

    const pluginConfig: SdkPluginConfig = { type: "local", path: workflowPath };

    // Scan each skill inside the workflow for agents frontmatter
    const agentIds = new Set<string>();
    let hasAll = false;

    const skillDirs = readdirSync(skillsSubdir).filter((d) =>
      statSync(join(skillsSubdir, d)).isDirectory(),
    );

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
      log.debug("Workflow registered as universal", { workflow, skills: skillDirs.length });
    } else if (agentIds.size > 0) {
      for (const agentId of agentIds) {
        const existing = index.get(agentId) ?? [];
        existing.push(pluginConfig);
        index.set(agentId, existing);
      }
      log.debug("Workflow registered", { workflow, agents: [...agentIds], skills: skillDirs.length });
    }
  }

  // Merge universal plugins into every agent's list
  if (universalPlugins.length > 0) {
    // Get all agent IDs currently in the index
    const allAgentIds = new Set(index.keys());
    // Also need to handle agents with no workflow-specific skills —
    // they'll get universal plugins when looked up via getSkillsForAgent()
    for (const agentId of allAgentIds) {
      const existing = index.get(agentId)!;
      existing.push(...universalPlugins);
    }
    // Store universal plugins under a sentinel key for agents not yet in the index
    index.set("__universal__", universalPlugins);
  }

  const totalWorkflows = workflows.filter((w) => existsSync(join(skillsDir, w, ".claude", "skills"))).length;
  log.info("Skill index loaded", { workflows: totalWorkflows, agents: index.size - (index.has("__universal__") ? 1 : 0) });

  return index;
}

/**
 * Look up skills for a specific agent. Merges agent-specific + universal.
 */
export function getSkillsForAgent(index: SkillIndex, agentId: string): SdkPluginConfig[] {
  const agentSkills = index.get(agentId) ?? [];
  const universal = index.get("__universal__") ?? [];

  // If agent already has universal plugins merged (from loadSkillIndex), avoid duplicates
  if (agentSkills.length > 0 && universal.length > 0) {
    const paths = new Set(agentSkills.map((p) => p.path));
    const missing = universal.filter((p) => !paths.has(p.path));
    return [...agentSkills, ...missing];
  }

  // Agent not in index — just return universal
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

  // Match "agents:" followed by YAML list items
  const agentsMatch = frontmatter.match(/^agents:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (agentsMatch) {
    return agentsMatch[1]!
      .split("\n")
      .map((line) => line.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean);
  }

  // Also support inline format: agents: [sdr, chief-of-staff]
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

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: Clean pass

- [ ] **Step 3:** Commit

```bash
git add src/agents/skill-loader.ts
git commit -m "feat: add skill-loader module for hive-native skills"
```

---

### Task 2: Wire skills into AgentRunner

**Files:**
- Modify: `src/agents/agent-runner.ts:1-48` (imports + constructor)
- Modify: `src/agents/agent-runner.ts:494` (send method)

- [ ] **Step 1:** Add import and constructor field

Add import at top:

```typescript
import { type SkillIndex, getSkillsForAgent } from "./skill-loader.js";
```

Add `skillIndex` field and update constructor:

```typescript
export class AgentRunner {
  private agentConfig: AgentConfig;
  private memoryManager: MemoryManager;
  private plugins: LoadedPlugin[];
  private skillIndex: SkillIndex;
  private activeQuery: Query | null = null;

  constructor(agentConfig: AgentConfig, memoryManager: MemoryManager, plugins: LoadedPlugin[] = [], skillIndex: SkillIndex = new Map()) {
    this.agentConfig = agentConfig;
    this.memoryManager = memoryManager;
    this.plugins = plugins;
    this.skillIndex = skillIndex;
  }
```

- [ ] **Step 2:** Add `buildNativeSkills()` method after `buildSdkPlugins()`

```typescript
  private buildNativeSkills(): SdkPluginConfig[] {
    return getSkillsForAgent(this.skillIndex, this.agentConfig.id);
  }
```

- [ ] **Step 3:** Merge native skills with external plugins in `send()`

Change line 494 from:

```typescript
    const sdkPlugins = this.buildSdkPlugins();
```

To:

```typescript
    const sdkPlugins = [...this.buildSdkPlugins(), ...this.buildNativeSkills()];
```

- [ ] **Step 4:** Verify

Run: `npm run typecheck`
Expected: Clean pass

- [ ] **Step 5:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat: wire native skills into agent runner sessions"
```

---

### Task 3: Pass skill index through AgentManager

**Files:**
- Modify: `src/agents/agent-manager.ts:1-46` (imports, constructor, createRunner)

- [ ] **Step 1:** Add import

```typescript
import { loadSkillIndex, type SkillIndex } from "./skill-loader.js";
```

- [ ] **Step 2:** Add `skillIndex` field and load it in constructor

Add field:

```typescript
  private skillIndex: SkillIndex;
```

In constructor, after `this.plugins = loadPlugins(...)`:

```typescript
    this.skillIndex = loadSkillIndex();
```

- [ ] **Step 3:** Pass skill index to AgentRunner in `createRunner()`

Change:

```typescript
    return new AgentRunner(config, this.memoryManager, this.plugins);
```

To:

```typescript
    return new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex);
```

- [ ] **Step 4:** Add `reloadSkills()` method for hot-reload

```typescript
  reloadSkills(): void {
    this.skillIndex = loadSkillIndex();
  }
```

- [ ] **Step 5:** Verify

Run: `npm run typecheck`
Expected: Clean pass

- [ ] **Step 6:** Commit

```bash
git add src/agents/agent-manager.ts
git commit -m "feat: load and pass skill index through agent manager"
```

---

### Task 4: Add skills/ to hot-reload watcher

**Files:**
- Modify: `src/index.ts:100-138` (hot-reload section)

- [ ] **Step 1:** Add skills reload to the `reload()` function

After `await scheduler.reloadSchedules();` (line 126), add:

```typescript
    agentManager.reloadSkills();
```

- [ ] **Step 2:** Add file watcher for `skills/` directory

After the agents watcher block (line 134), add:

```typescript
  // Watch skills/ directory for changes — debounced to 500ms
  const skillsDir = resolve("skills");
  if (existsSync(skillsDir)) {
    watch(skillsDir, { recursive: true }, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reload(), 500);
    });
    log.info("Skills hot-reload enabled", { watched: skillsDir });
  }
```

Add `existsSync` to the existing `import` from `"node:fs"` at the top of index.ts (if not already imported).

- [ ] **Step 3:** Verify

Run: `npm run typecheck`
Expected: Clean pass

- [ ] **Step 4:** Commit

```bash
git add src/index.ts
git commit -m "feat: hot-reload skill index on skills/ directory changes"
```

---

### Task 5: Create morning-briefing workflow skeleton

**Files:**
- Create: `skills/morning-briefing/.claude/skills/sales-standup-prep/SKILL.md`
- Create: `skills/morning-briefing/.claude/skills/dev-standup-prep/SKILL.md`
- Create: `skills/morning-briefing/.claude/skills/cs-standup-prep/SKILL.md`
- Create: `skills/morning-briefing/.claude/skills/marketing-standup-prep/SKILL.md`
- Create: `skills/morning-briefing/.claude/skills/morning-briefing/SKILL.md`

- [ ] **Step 1:** Create directory structure

```bash
mkdir -p skills/morning-briefing/.claude/skills/{sales-standup-prep,dev-standup-prep,cs-standup-prep,marketing-standup-prep,morning-briefing}
```

- [ ] **Step 2:** Create sales-standup-prep SKILL.md

```markdown
---
name: sales-standup-prep
description: Compile pipeline metrics, new leads, and outreach activity for the morning standup
agents:
  - sdr
---

# Sales Standup Prep

Prepare the sales standup report using CRM and pipeline data.

## Steps

1. Use `crm_search` to pull deals updated in the last 24 hours
2. Use `crm_search` to find new leads created since yesterday
3. Use `ops_search` to check for new quotes or proposals
4. Compile a brief summary with: new leads, pipeline movement, follow-ups due today
5. Save the report to memory using `memory_write` at path `reports/sales-standup-prep-{date}.md`
```

- [ ] **Step 3:** Create dev-standup-prep SKILL.md

```markdown
---
name: dev-standup-prep
description: Compile engineering status — open PRs, CI health, and backlog updates for the morning standup
agents:
  - vp-engineering
---

# Dev Standup Prep

Prepare the engineering standup report.

## Steps

1. Use `github_issues_list` to find issues updated in the last 24 hours
2. Check for any open PRs or recently merged work
3. Review backlog priorities and blockers
4. Compile a brief summary with: completed work, in-progress items, blockers
5. Save the report to memory using `memory_write` at path `reports/dev-standup-prep-{date}.md`
```

- [ ] **Step 4:** Create cs-standup-prep SKILL.md

```markdown
---
name: cs-standup-prep
description: Compile customer activity — open cases, follow-ups due, and escalations for the morning standup
agents:
  - customer-success
---

# CS Standup Prep

Prepare the customer success standup report.

## Steps

1. Use `ops_search` to find open cases and recent customer activity
2. Use `crm_search` to check for follow-ups due today
3. Review any escalations or urgent customer requests
4. Compile a brief summary with: open cases, follow-ups due, escalations
5. Save the report to memory using `memory_write` at path `reports/cs-standup-prep-{date}.md`
```

- [ ] **Step 5:** Create marketing-standup-prep SKILL.md

```markdown
---
name: marketing-standup-prep
description: Compile marketing activity — campaigns, content pipeline, and lead gen metrics for the morning standup
agents:
  - marketing-manager
---

# Marketing Standup Prep

Prepare the marketing standup report.

## Steps

1. Use `crm_search` to pull lead generation metrics from the last 24 hours
2. Review any active campaigns or content in progress
3. Check for market research tasks or competitive updates
4. Compile a brief summary with: lead gen numbers, campaign status, content pipeline
5. Save the report to memory using `memory_write` at path `reports/marketing-standup-prep-{date}.md`
```

- [ ] **Step 6:** Create morning-briefing SKILL.md

```markdown
---
name: morning-briefing
description: Aggregate all standup prep reports into a unified morning briefing for leadership
agents:
  - chief-of-staff
---

# Morning Briefing

Compile the unified morning briefing from all department standup prep reports.

## Steps

1. Read each department's standup prep from memory:
   - `memory_read` path `reports/sales-standup-prep-{date}.md`
   - `memory_read` path `reports/dev-standup-prep-{date}.md`
   - `memory_read` path `reports/cs-standup-prep-{date}.md`
   - `memory_read` path `reports/marketing-standup-prep-{date}.md`
2. Synthesize into a single briefing with sections: Sales, Engineering, Customer Success, Marketing
3. Flag any cross-department items (e.g., customer escalation needing engineering attention)
4. Post the briefing to the appropriate Slack channel
5. Save the briefing to memory using `memory_write` at path `reports/morning-briefing-{date}.md`
```

- [ ] **Step 7:** Verify structure

Run: `find skills/ -type f`
Expected:
```
skills/morning-briefing/.claude/skills/sales-standup-prep/SKILL.md
skills/morning-briefing/.claude/skills/dev-standup-prep/SKILL.md
skills/morning-briefing/.claude/skills/cs-standup-prep/SKILL.md
skills/morning-briefing/.claude/skills/marketing-standup-prep/SKILL.md
skills/morning-briefing/.claude/skills/morning-briefing/SKILL.md
```

- [ ] **Step 8:** Commit

```bash
git add skills/
git commit -m "feat: add morning-briefing workflow skill skeletons"
```

---

### Task 6: Verify end-to-end

- [ ] **Step 1:** Run full check

Run: `npm run check`
Expected: All checks pass (typecheck + lint + format + test)

- [ ] **Step 2:** Verify skill index loads correctly

Run: `node -e "import('./dist/agents/skill-loader.js').then(m => { const idx = m.loadSkillIndex(); console.log('Agents with skills:', [...idx.keys()].filter(k => k !== '__universal__')); })"`

Expected: Agents `sdr`, `vp-engineering`, `customer-success`, `marketing-manager`, `chief-of-staff` appear in the index.

(Note: requires `npm run build` first since we're importing from dist/)

- [ ] **Step 3:** Commit any fixes, then final commit

```bash
git add -A
git commit -m "chore: fix lint/format issues from native skills implementation"
```
