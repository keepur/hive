# Seed-Bundled Skills Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Extend the skill loader to scan `seeds/<agent>/skills/` directories so the Chief of Staff ships with bundled skills that work on first boot — no registry, no network, no second install step.

**Architecture:** The skill scanner (`skill-loader.ts`) currently supports two-tier scanning: plugins, then customer space. We add a third tier — seed-bundled — scanned first so seeds beat plugins but still lose to customer space (precedence: customer > seeds > plugins). Seed directories are resolved from the package root via `import.meta.dirname`. The `AgentManager` discovers seed dirs and passes them to `loadSkillIndex` alongside plugins. CoS skills ship as SKILL.md files under `seeds/chief-of-staff/skills/`.

**Tech Stack:** TypeScript, Node fs, Vitest

**Spec:** `docs/specs/2026-04-15-mvp-readiness-epic.md` Track 4

---

### Task 1: Add `seedsDir` to `src/paths.ts`

**Files:**
- Modify: `src/paths.ts` — append after line 47 (end of file)

Seeds live in the npm package itself (not in customer space). In dev mode, they're at `<repo>/seeds/`. In a global npm install, they're at `<package-root>/seeds/`. In both cases, `seeds/` is one directory up from the module's own directory (`src/` in dev, `pkg/` in bundled), so `resolve(import.meta.dirname, "..", "seeds")` works for both contexts.

- [ ] **Step 1:** Append `seedsDir` export after the last line of `src/paths.ts`

```typescript
/**
 * Core agent seeds directory (ships with the npm package).
 * Resolved from the package root, not from hiveHome — seeds are immutable
 * package content, not customer-space data.
 *
 * Dev: import.meta.dirname = <repo>/src/ → resolve("..", "seeds") = <repo>/seeds/
 * Bundled: import.meta.dirname = <package>/pkg/ → resolve("..", "seeds") = <package>/seeds/
 */
export const seedsDir = resolve(import.meta.dirname, "..", "seeds");
```

- [ ] **Step 2:** Verify

Run: `npx tsx -e "import { seedsDir } from './src/paths.js'; console.log(seedsDir)"`
Expected: prints `<repo>/seeds` (absolute path)

- [ ] **Step 3:** Commit

```bash
git add src/paths.ts
git commit -m "feat(paths): add seedsDir for core agent seed resolution"
```

---

### Task 2: Extend `loadSkillIndex` to scan seed directories

**Files:**
- Modify: `src/agents/skill-loader.ts:33-72`

The signature gains an optional `seedDirs` parameter — an array of absolute paths to seed directories (e.g., `["<repo>/seeds/chief-of-staff"]`). Each seed dir is expected to have a `skills/` subdirectory following the same workflow layout as plugins. Scan order: seeds first (wins over plugins via first-in-wins), then plugins, then customer space (wins over everything via `winsCollisions`).

- [ ] **Step 1:** Update the `loadSkillIndex` signature and add seed scanning

Replace the entire `loadSkillIndex` function (lines 33-73). The signature gains `seedDirs?: string[]`. Scan order: seeds first (highest non-customer precedence), then plugins, then customer. Among non-customer sources, `scanWorkflowsFrom` uses first-in-wins — so seeds beat plugins. Customer always wins via `winsCollisions: true`.

Precedence (high to low): **customer > seeds > plugins**. This matches the epic spec: seed skills are part of the product's core identity (CoS onboarding) and a plugin should not be able to stomp on them.

```typescript
export function loadSkillIndex(
  customerSkillsDir: string,
  plugins?: LoadedPlugin[],
  seedDirs?: string[],
): SkillIndex {
  const index: SkillIndex = new Map();
  const universalPlugins: SdkPluginConfig[] = [];
  const collisionMap = new Map<string, CollisionEntry>();

  // Seeds first — win over plugins (first-in-wins among non-customer sources)
  for (const seedDir of seedDirs ?? []) {
    const seedSkillsDir = join(seedDir, "skills");
    if (!existsSync(seedSkillsDir)) continue;
    const seedName = seedDir.split("/").pop() ?? "seed";
    scanWorkflowsFrom(seedSkillsDir, `seed:${seedName}`, collisionMap, index, universalPlugins, false);
  }

  // Plugins second — lose to seeds (first-in-wins), lose to customer (winsCollisions)
  for (const plugin of plugins ?? []) {
    const pluginSkillsDir = join(plugin.dir, "skills");
    if (!existsSync(pluginSkillsDir)) continue;
    scanWorkflowsFrom(pluginSkillsDir, plugin.name, collisionMap, index, universalPlugins, false);
  }

  // Customer space last — wins all collisions
  if (existsSync(customerSkillsDir)) {
    scanWorkflowsFrom(customerSkillsDir, "customer", collisionMap, index, universalPlugins, true);
  } else {
    log.debug("No customer skills directory found", { path: customerSkillsDir });
  }

  // Merge universal plugins into every agent's list + expose via sentinel
  if (universalPlugins.length > 0) {
    for (const agentId of [...index.keys()]) {
      const existing = index.get(agentId)!;
      existing.push(...universalPlugins);
    }
    index.set("__universal__", universalPlugins);
  }

  // Post-scan: detect customer modifications to registry-installed skills
  _modifiedSkills = detectModifiedSkills(collisionMap, customerSkillsDir);

  log.info("Skill index loaded", {
    workflows: collisionMap.size,
    agents: index.size - (index.has("__universal__") ? 1 : 0),
  });

  return index;
}
```

- [ ] **Step 2:** Update the JSDoc comment above `loadSkillIndex` (lines 24-32)

Replace the existing block comment:

```typescript
/**
 * Scan seed-bundled skills, plugin-bundled skills, and customer-space skills,
 * build a map of agentId → SdkPluginConfig[] for that agent's workflows.
 *
 * Precedence (high to low): customer > seeds > plugins.
 * Customer space always wins (shadow). Among non-customer sources, first
 * registered wins — seeds are scanned before plugins so they take priority.
 * Customer→customer collisions are errors — neither version loads.
 */
```

- [ ] **Step 3:** Verify — typecheck passes

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 4:** Commit

```bash
git add src/agents/skill-loader.ts
git commit -m "feat(skills): extend loadSkillIndex to scan seed directories"
```

---

### Task 3: Thread seed dirs through `AgentManager`

**Files:**
- Modify: `src/agents/agent-manager.ts:44-51` (constructor)
- Modify: `src/agents/agent-manager.ts:65-71` (reloadSkills)
- Modify: `src/paths.ts` (import seedsDir — already added in Task 1)

The `AgentManager` needs to discover seed directories and pass them to `loadSkillIndex`. Seeds live at `<seedsDir>/<agent-id>/` — we scan the `seedsDir` directory for subdirectories, each one being a potential seed with a `skills/` subdirectory.

- [ ] **Step 1:** Add seed directory discovery and pass to `loadSkillIndex`

In `agent-manager.ts`, make these import changes:

Replace the existing paths import (line 15):
```typescript
// Before:
import { skillsDir } from "../paths.js";
// After:
import { skillsDir, seedsDir } from "../paths.js";
```

Add these new imports (none of these exist in the file currently):
```typescript
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
```

Add a private field to the class (after `private skillIndex: SkillIndex;` on line 40):

```typescript
private seedDirs: string[];
```

In the constructor, replace the `this.skillIndex` line (line 51) with seed discovery + skill loading:

```typescript
this.seedDirs = discoverSeedDirs(seedsDir);
this.skillIndex = loadSkillIndex(skillsDir, this.plugins, this.seedDirs);
```

Add the discovery function (module-level, before the class declaration):

```typescript
/**
 * Discover seed directories that contain skills.
 * Returns absolute paths to seed dirs (e.g., ["<repo>/seeds/chief-of-staff"]).
 */
function discoverSeedDirs(rootSeedsDir: string): string[] {
  if (!existsSync(rootSeedsDir)) return [];
  try {
    return readdirSync(rootSeedsDir)
      .map((d) => join(rootSeedsDir, d))
      .filter((p) => {
        try {
          return statSync(p).isDirectory() && existsSync(join(p, "skills"));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
```

- [ ] **Step 2:** Update `reloadSkills()` to pass seed dirs

Replace the existing `reloadSkills()` body (lines 65-71) to pass `this.seedDirs`:

```typescript
reloadSkills(): void {
  try {
    this.skillIndex = loadSkillIndex(skillsDir, this.plugins, this.seedDirs);
  } catch (err) {
    log.warn("Skill reload failed, retaining previous index", { error: String(err) });
  }
}
```

Note: `seedDirs` are fixed at construction time (same as `plugins`). Seeds don't change at runtime — they're immutable package content.

- [ ] **Step 3:** Verify — typecheck passes

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 4:** Commit

```bash
git add src/agents/agent-manager.ts
git commit -m "feat(skills): thread seed directories through AgentManager to skill loader"
```

---

### Task 4: Create CoS seed-bundled skill stubs

**Files:**
- Create: `seeds/chief-of-staff/skills/onboarding/skills/onboarding/SKILL.md`
- Create: `seeds/chief-of-staff/skills/credential-setup/skills/credential-setup/SKILL.md`
- Create: `seeds/chief-of-staff/skills/agent-builder/skills/agent-builder/SKILL.md`
- Create: `seeds/chief-of-staff/skills/capability-inventory/skills/capability-inventory/SKILL.md`

These are the four bundled skills defined in Track 4 of the epic. Each follows the standard two-level layout: `<workflow>/skills/<skill>/SKILL.md`.

The skill content in this task is intentionally minimal — enough to be loaded by the scanner and assigned to the `chief-of-staff` agent. The full skill prompts are a separate body-of-work (writing the actual onboarding interview flow, credential walkthrough, etc.). This task establishes the structure and wiring.

- [ ] **Step 1:** Create the onboarding skill

```bash
mkdir -p seeds/chief-of-staff/skills/onboarding/skills/onboarding
```

Write `seeds/chief-of-staff/skills/onboarding/skills/onboarding/SKILL.md`:

```markdown
---
name: onboarding
description: First-contact onboarding interview — learns about the business and writes findings to shared/business-context.md
agents:
  - chief-of-staff
---

# Onboarding

Structured first-contact interview for new hive owners. Learn about their business, team, products, and services. Write findings to `shared/business-context.md` in MongoDB memory so all future agents inherit the full business context.

## When to use

Run this skill on first contact with a new user — when `shared/business-context.md` contains only the skeleton seeded by `hive init`.

## What to do

1. Introduce yourself and explain your role as Chief of Staff
2. Interview the owner about their business:
   - Company name, industry, location
   - Products and services offered
   - Team members and their roles
   - Key customers and markets
   - Business goals and priorities
3. Write a comprehensive `shared/business-context.md` using the memory tools
4. Summarize what you learned and confirm with the owner
```

- [ ] **Step 2:** Create the credential setup skill

```bash
mkdir -p seeds/chief-of-staff/skills/credential-setup/skills/credential-setup
```

Write `seeds/chief-of-staff/skills/credential-setup/skills/credential-setup/SKILL.md`:

```markdown
---
name: credential-setup
description: Guide the user through setting up credentials for services via honeypot (macOS Keychain)
agents:
  - chief-of-staff
---

# Credential Setup

Guide the hive owner through setting up credentials for services that require API keys or OAuth tokens.

## When to use

When the owner wants to connect a new service (Google, HubSpot, etc.) or when a tool fails because a required credential is missing.

## What to do

1. Identify which credential is needed
2. Explain what the service does and why the credential is needed
3. Walk the owner through obtaining the credential (API key page, OAuth flow, etc.)
4. Instruct them to run `honeypot set <KEY_NAME>` from their terminal
5. Verify the credential works by testing the relevant tool
6. Confirm success and explain what's now available
```

- [ ] **Step 3:** Create the agent builder skill

```bash
mkdir -p seeds/chief-of-staff/skills/agent-builder/skills/agent-builder
```

Write `seeds/chief-of-staff/skills/agent-builder/skills/agent-builder/SKILL.md`:

```markdown
---
name: agent-builder
description: Conversational agent creation — propose roles, configure agents, introduce them to the team
agents:
  - chief-of-staff
---

# Agent Builder

Create new agents conversationally. The owner describes what they need, you propose a role, configure the agent, and introduce it to the team.

## When to use

When the owner asks to create a new agent, add a team member, or needs help with a task that would be better handled by a dedicated agent.

## What to do

1. Understand what the owner needs — what problem, what domain, what tools
2. Propose a role with a name, personality, and capabilities
3. Confirm the proposal with the owner
4. Create the agent definition using admin MCP tools:
   - Set appropriate model ceiling (haiku for simple routing, sonnet for complex work)
   - Assign relevant MCP servers from core servers
   - Write a soul (personality) and system prompt (role/guardrails)
   - Create a Slack channel for the agent
5. Introduce the new agent to the owner in Slack
```

- [ ] **Step 4:** Create the capability inventory skill

```bash
mkdir -p seeds/chief-of-staff/skills/capability-inventory/skills/capability-inventory
```

Write `seeds/chief-of-staff/skills/capability-inventory/skills/capability-inventory/SKILL.md`:

```markdown
---
name: capability-inventory
description: Know what's installed and available — agents, servers, plugins, skills, registry offerings
agents:
  - chief-of-staff
---

# Capability Inventory

Know what's installed on this hive and what's available to install. Answer questions about capabilities, suggest additions, and help the owner understand their team.

## When to use

When the owner asks "what can you do?", "what agents do I have?", "what's available?", or similar discovery questions.

## What to do

1. Use admin MCP tools to list current agents and their configurations
2. Describe each agent's role, capabilities, and assigned MCP servers
3. If asked about available additions, describe what can be installed from the registry
4. Suggest agents or capabilities that might help based on the owner's business context
```

- [ ] **Step 5:** Verify the skill directory structure is correct

Run: `find seeds/chief-of-staff/skills -name "SKILL.md" | sort`
Expected:
```
seeds/chief-of-staff/skills/agent-builder/skills/agent-builder/SKILL.md
seeds/chief-of-staff/skills/capability-inventory/skills/capability-inventory/SKILL.md
seeds/chief-of-staff/skills/credential-setup/skills/credential-setup/SKILL.md
seeds/chief-of-staff/skills/onboarding/skills/onboarding/SKILL.md
```

- [ ] **Step 6:** Commit

```bash
git add seeds/chief-of-staff/skills/
git commit -m "feat(cos): add seed-bundled skill stubs for Chief of Staff

Four skills ship with the CoS seed:
- onboarding: first-contact interview, writes shared/business-context.md
- credential-setup: guides honeypot set for service credentials
- agent-builder: conversational agent creation via admin MCP tools
- capability-inventory: what's installed, what's available"
```

---

### Task 5: Tests for seed-bundled skill scanning

**Files:**
- Modify: `src/agents/skill-loader.test.ts`

Add tests that verify seed directories are scanned and have the correct collision precedence: customer > seeds > plugins.

- [ ] **Step 1:** Add seed-bundled skill tests

Append the following tests to the existing `describe("loadSkillIndex", ...)` block:

```typescript
  it("loads seed-bundled skills", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const seedDir = join(tmp, "chief-of-staff");
    writeSkill(join(seedDir, "skills"), "onboarding", "onboarding-skill", ["chief-of-staff"]);

    const index = loadSkillIndex(customer, [], [seedDir]);

    expect(getSkillsForAgent(index, "chief-of-staff")).toHaveLength(1);
    expect(getSkillsForAgent(index, "chief-of-staff")[0]!.path).toBe(
      join(seedDir, "skills", "onboarding"),
    );
  });

  it("seed skill wins over plugin skill (same workflow name)", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const seedDir = join(tmp, "chief-of-staff");
    writeSkill(join(seedDir, "skills"), "onboarding", "seed-version", ["chief-of-staff"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "onboarding", "plugin-version", ["chief-of-staff"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)], [seedDir]);

    const paths = getSkillsForAgent(index, "chief-of-staff").map((s) => s.path);
    expect(paths).toEqual([join(seedDir, "skills", "onboarding")]);
  });

  it("customer skill shadows seed-bundled skill", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "onboarding", "customer-version", ["chief-of-staff"]);

    const seedDir = join(tmp, "chief-of-staff");
    writeSkill(join(seedDir, "skills"), "onboarding", "seed-version", ["chief-of-staff"]);

    const index = loadSkillIndex(customer, [], [seedDir]);

    const paths = getSkillsForAgent(index, "chief-of-staff").map((s) => s.path);
    expect(paths).toEqual([join(customer, "onboarding")]);
  });

  it("ignores seed dirs with no skills/ subdirectory", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const seedDir = join(tmp, "empty-seed");
    mkdirSync(seedDir, { recursive: true });

    const index = loadSkillIndex(customer, [], [seedDir]);
    expect(index.size).toBe(0);
  });

  it("loads skills from multiple seed dirs", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const seedA = join(tmp, "seed-a");
    writeSkill(join(seedA, "skills"), "alpha", "skill-a", ["agent-a"]);

    const seedB = join(tmp, "seed-b");
    writeSkill(join(seedB, "skills"), "beta", "skill-b", ["agent-b"]);

    const index = loadSkillIndex(customer, [], [seedA, seedB]);

    expect(getSkillsForAgent(index, "agent-a")).toHaveLength(1);
    expect(getSkillsForAgent(index, "agent-b")).toHaveLength(1);
  });
```

- [ ] **Step 2:** Verify all tests pass

Run: `npm run test -- src/agents/skill-loader.test.ts`
Expected: all tests pass, including the new seed-bundled tests

- [ ] **Step 3:** Commit

```bash
git add src/agents/skill-loader.test.ts
git commit -m "test(skills): add seed-bundled skill loader tests"
```

---

### Task 6: Full verification

- [ ] **Step 1:** Run full check suite

Run: `npm run check`
Expected: typecheck + lint + format + test all pass

- [ ] **Step 2:** Verify seed skills are loaded in dev mode

Run: `npx tsx -e "
import { loadSkillIndex, getSkillsForAgent } from './src/agents/skill-loader.js';
import { skillsDir, seedsDir } from './src/paths.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const seedDirs = readdirSync(seedsDir)
  .map(d => join(seedsDir, d))
  .filter(p => statSync(p).isDirectory() && existsSync(join(p, 'skills')));

console.log('Seed dirs:', seedDirs);
const index = loadSkillIndex(skillsDir, [], seedDirs);
const cosSkills = getSkillsForAgent(index, 'chief-of-staff');
console.log('CoS skills:', cosSkills.length);
cosSkills.forEach(s => console.log(' ', s.path));
"`

Expected: 4 CoS skills listed (onboarding, credential-setup, agent-builder, capability-inventory)

- [ ] **Step 3:** Fix any issues and re-run `npm run check`
