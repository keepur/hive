# KPR-75: Per-Agent Private Skills Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Add `<hiveHome>/agents/<id>/skills/` as a 4th skill source — agent-private, agent-authored, agent-scoped implicitly by path. Local filesystem only — no commits, no pushes, no sync.

**Architecture:** Extend `loadSkillIndex` to accept an `agentIds: string[]` and scan each agent's private skills dir as a 4th source. Path is source of truth: any `agents:` frontmatter in agent-private skills is a hard error. Per-agent collisions are NOT collisions (Luna's `publish-blog-post` and Sam's `publish-blog-post` coexist). Customer-space still wins within an agent's scope. File-watcher extended to cover `agentsDir()` recursively. **Agent-private skills are local-filesystem-only — no `commitToState`, no auto-commit, no sync.**

**Tech Stack:** TypeScript, Node, MongoDB. Reuses existing skill-loader, paths helpers, file watcher.

**Out of scope** (separate tickets):
- Sharing flow (agent → operator → other agents)
- Auto-formatting / linting agent-authored SKILL.md
- Versioning beyond what filesystem already provides
- Agent self-modifying prompts/soul/config (Constitution 1.11 forbids)
- Audit trail / rollback (skipped per "no pushing anywhere" — agent-private skills are ephemeral by intent; revisit if audit becomes important)

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `src/paths.ts` | `agentSkillsDir(agentId, home?)` helper | **modify** (add 5 lines) |
| `src/agents/skill-loader.ts` | 4th source scan, `implicitAgentScope` param, per-agent collision rules | **modify** (~80 lines added) |
| `src/agents/skill-loader.test.ts` | New tests for 4th source | **modify** (~150 lines added) |
| `src/agents/agent-manager.ts` | Pass agent IDs to `loadSkillIndex` on boot + reload | **modify** (~6 lines) |
| `src/index.ts` | Extend file watcher to `agentsDir()` | **modify** (~8 lines) |
| `setup/templates/constitution-bootstrap.md.tpl` | §2.3 affordance copy | **modify** (~10 lines) |
| `docs/specs/2026-04-28-per-agent-private-skills-design.md` | Short design doc | **create** |

---

## Pre-flight

- [ ] **Verify worktree:** `cd /Users/mokie/github/hive-KPR-75 && git branch --show-current` → `KPR-75`
- [ ] **Verify config symlinks:** `ls -la .env hive.yaml` → both symlinked to `~/github/hive/`
- [ ] **Print actual signatures before writing code:**

```bash
cd /Users/mokie/github/hive-KPR-75 && \
  grep -n "^export\|function scanWorkflowsFrom\|function removeWorkflowFromIndex" src/agents/skill-loader.ts | head -15 && \
  grep -n "agentScratchDir\|agentsDir" src/paths.ts | head && \
  grep -n "loadSkillIndex\|reloadSkills" src/agents/agent-manager.ts | head && \
  grep -n "watch\|reload\|SIGUSR1\|skillsDir" src/index.ts | head
```

Code blocks below are written against signatures verified 2026-04-28:
- `loadSkillIndex(customerSkillsDir, plugins?, seedDirs?): SkillIndex` — needs new `agentIds?: string[]` param
- `scanWorkflowsFrom(rootDir, source, collisionMap, index, universalPlugins, winsCollisions): void` — needs new `implicitAgentScope?: string` param
- `agentsDir(home?)`, `agentScratchDir/Reports/Feeds/PlaywrightDir(agentId, home?)` already exist — `agentSkillsDir` does not

---

### Task 1: `agentSkillsDir` helper

**Files:**
- Modify: `src/paths.ts`

- [ ] **Step 1:** Add helper next to existing `agentScratchDir`/etc.

```typescript
export function agentSkillsDir(agentId: string, home: string = hiveHome): string {
  return resolve(agentsDir(home), agentId, "skills");
}
```

- [ ] **Step 2:** Verify

```bash
cd /Users/mokie/github/hive-KPR-75 && npm run typecheck 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 3:** Commit

```bash
git add src/paths.ts
git commit -m "feat(paths,KPR-75): agentSkillsDir helper"
```

---

### Task 2: Extend `loadSkillIndex` and `scanWorkflowsFrom`

**Files:**
- Modify: `src/agents/skill-loader.ts`

This task changes the loader signature, adds the 4th-source scan, threads `implicitAgentScope` through, and amends collision rules. Done as a single commit because the changes are interlocked.

**Load-bearing invariant (do not reorder later):** the agent-private pass must run AFTER seeds/plugins (so per-agent skills outrank them within scope) and BEFORE customer (so customer can shadow agent-private when scoped). Any future reordering of the four passes silently breaks the customer-shadow eviction logic in step 3.

- [ ] **Step 1:** Add `agentIds` and `hiveHomeOverride` params to `loadSkillIndex`. The override is required for testability — `paths.ts:40` resolves `hiveHome` at module-load, so unit tests can't mutate it via `process.env`. After step 1's edits the skeleton looks like:

```typescript
export function loadSkillIndex(
  customerSkillsDir: string,
  plugins?: LoadedPlugin[],
  seedDirs?: string[],
  agentIds?: string[],          // NEW — agent-private skill discovery
  hiveHomeOverride?: string,    // NEW — for testability; production passes nothing
): SkillIndex {
  const index: SkillIndex = new Map();
  const universalPlugins: SdkPluginConfig[] = [];
  const collisionMap = new Map<string, CollisionEntry>();

  // 1) Seeds (lowest precedence after agent-private)
  if (seedDirs) {
    for (const seedDir of seedDirs) { /* unchanged */ }
  }

  // 2) Plugins
  if (plugins) {
    for (const plugin of plugins) { /* unchanged */ }
  }

  // 3) Agent-private — NEW
  if (agentIds) {
    for (const agentId of agentIds) {
      const dir = agentSkillsDir(agentId, hiveHomeOverride);
      if (!existsSync(dir)) continue;
      scanWorkflowsFrom(
        dir,
        `agent-private:${agentId}`,
        collisionMap,
        index,
        universalPlugins,
        false,           // never wins collisions globally
        agentId,         // implicitAgentScope — path is source of truth
      );
    }
  }

  // 4) Customer (highest precedence — operator authority)
  scanWorkflowsFrom(
    customerSkillsDir,
    "customer",
    collisionMap,
    index,
    universalPlugins,
    true,
  );

  // ... rest unchanged
}
```

Add the `agentSkillsDir` import at the top of the file:

```typescript
import { agentSkillsDir } from "../paths.js";
```

- [ ] **Step 2:** Extend `scanWorkflowsFrom` to accept `implicitAgentScope`.

```typescript
function scanWorkflowsFrom(
  rootDir: string,
  source: string,
  collisionMap: Map<string, CollisionEntry>,
  index: SkillIndex,
  universalPlugins: SdkPluginConfig[],
  winsCollisions: boolean,
  implicitAgentScope?: string,   // NEW — when set, path overrides frontmatter
): void {
  // ... existing scan logic ...

  // Inside the per-skill loop, where `agents: string[]` is parsed from frontmatter:
  const declaredAgents = parseAgentsFromFrontmatter(content);

  let scopedAgents: string[];
  if (implicitAgentScope) {
    // Path is source of truth — frontmatter agents: is forbidden in agent-private skills.
    if (declaredAgents.length > 0) {
      throw new Error(
        `Agent-private skill at ${skillMdPath} declares agents: in frontmatter. ` +
        `For skills under agents/${implicitAgentScope}/skills/, the path is the source of truth — ` +
        `remove the agents: field.`,
      );
    }
    scopedAgents = [implicitAgentScope];
  } else {
    scopedAgents = declaredAgents;
  }

  // Use `scopedAgents` instead of `declaredAgents` from here down.
}
```

- [ ] **Step 3:** Adjust collision rules so per-agent skills don't false-positive.

Find the existing collision-detection block in `scanWorkflowsFrom`. Today's rule: a workflow name (e.g., `publish-blog-post`) registered twice anywhere in the index is a collision. New rule: agent-private skills are scoped per-agent, so two different agents each having the same workflow name in their private skills is NOT a collision.

Update the collision key from `workflowName` to a composite that includes the implicit scope when present:

```typescript
// Old (illustrative):
// const key = workflowName;
// if (collisionMap.has(key)) { /* collision logic */ }

// New:
const collisionKey = implicitAgentScope
  ? `${implicitAgentScope}::${workflowName}`   // per-agent scope
  : workflowName;                              // global scope (customer/seed/plugin)
if (collisionMap.has(collisionKey)) { /* unchanged collision logic */ }
collisionMap.set(collisionKey, { source, path: skillDir });
```

This means:
- Luna's `publish-blog-post` → key `luna::publish-blog-post`
- Sam's `publish-blog-post` → key `sam::publish-blog-post` (no collision)
- Customer-space `publish-blog-post` → key `publish-blog-post` (global, can shadow specific agent's private skill via the existing winsCollisions=true path)

For the customer-shadowing-private case, the customer pass enters `scanWorkflowsFrom` with `winsCollisions=true` and *no* `implicitAgentScope`. When the customer skill's workflow name matches an agent-private skill's workflow name *for an agent the customer skill is scoped to*, customer should win. To preserve operator authority, when applying customer skills, also remove any per-agent-keyed entries for agents the customer skill is scoped to:

```typescript
// Inside the customer-wins branch (winsCollisions === true && !implicitAgentScope):
// After removing the global entry, also evict any per-agent-keyed entry for this workflow
// for any agent in this skill's scope (declaredAgents).
for (const agentId of scopedAgents) {
  const perAgentKey = `${agentId}::${workflowName}`;
  if (collisionMap.has(perAgentKey)) {
    const evicted = collisionMap.get(perAgentKey)!;
    log.warn("Customer-space skill shadows agent-private skill", {
      workflow: workflowName,
      agent: agentId,
      shadowed: evicted.path,
      winner: skillDir,
    });
    collisionMap.delete(perAgentKey);
    removeWorkflowFromIndex(evicted.path, index, universalPlugins);
  }
}
```

- [ ] **Step 4:** Verify the loader compiles.

```bash
cd /Users/mokie/github/hive-KPR-75 && npm run typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 5:** Commit

```bash
git add src/agents/skill-loader.ts
git commit -m "feat(skills,KPR-75): 4th source — agents/<id>/skills/ with implicitAgentScope"
```

---

### Task 3: Loader tests

**Files:**
- Modify: `src/agents/skill-loader.test.ts`

Existing tests pass an absent 4th argument; they continue to work. Add new tests for agent-private behavior.

- [ ] **Step 1:** Add a `writeAgentSkill` helper near the existing `writeSkill`:

```typescript
function writeAgentSkill(
  hiveHome: string,
  agentId: string,
  workflow: string,
  skill: string,
  // No `agents` arg — path is source of truth.
): void {
  const dir = join(hiveHome, "agents", agentId, "skills", workflow, "skills", skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${skill}\ndescription: test\n---\n\n# ${skill}\n`,
  );
}

function writeAgentSkillWithAgentsField(
  hiveHome: string,
  agentId: string,
  workflow: string,
  skill: string,
  agents: string[],  // For the "should error" test
): void {
  const dir = join(hiveHome, "agents", agentId, "skills", workflow, "skills", skill);
  mkdirSync(dir, { recursive: true });
  const agentsYaml = agents.map((a) => `  - ${a}`).join("\n");
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${skill}\ndescription: test\nagents:\n${agentsYaml}\n---\n\n# ${skill}\n`,
  );
}
```

- [ ] **Step 2:** Add a new `describe("agent-private skills (KPR-75)", ...)` block at the end of the file.

```typescript
describe("agent-private skills (KPR-75)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-loader-kpr75-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads skills from agents/<id>/skills/ scoped to that agent only", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");

    // 5th arg `hiveHomeOverride` is required — paths.ts resolves hiveHome at
    // module-load, so process.env.HIVE_HOME mutation has no effect on the
    // already-resolved const. The override threads tmp dir into agentSkillsDir.
    const index = loadSkillIndex(customer, [], [], ["luna", "sam"], tmp);

    expect(getSkillsForAgent(index, "luna").map((s) => s.path))
      .toContain(join(tmp, "agents", "luna", "skills", "blog-flow", "skills", "publish-blog-post"));
    expect(getSkillsForAgent(index, "sam")).toEqual([]);
  });

  it("two agents with same skill name do NOT collide", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");
    writeAgentSkill(tmp, "sam", "blog-flow", "publish-blog-post");

    const index = loadSkillIndex(customer, [], [], ["luna", "sam"], tmp);

    expect(getSkillsForAgent(index, "luna")).toHaveLength(1);
    expect(getSkillsForAgent(index, "sam")).toHaveLength(1);
    expect(getSkillsForAgent(index, "luna")[0].path).toContain("agents/luna");
    expect(getSkillsForAgent(index, "sam")[0].path).toContain("agents/sam");
  });

  it("throws on an agent-private skill that declares agents: in frontmatter", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    writeAgentSkillWithAgentsField(tmp, "luna", "blog-flow", "publish-blog-post", ["sam"]);

    expect(() => loadSkillIndex(customer, [], [], ["luna"], tmp))
      .toThrow(/path is the source of truth/);
  });

  it("customer-space skill shadows agent-private skill for the agents it scopes to", () => {
    const customer = join(tmp, "skills");
    writeSkill(customer, "blog-flow", "publish-blog-post", ["luna"]);
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");

    const index = loadSkillIndex(customer, [], [], ["luna"], tmp);

    const lunaPaths = getSkillsForAgent(index, "luna").map((s) => s.path);
    expect(lunaPaths).toEqual([join(customer, "blog-flow", "skills", "publish-blog-post")]);
  });

  it("plugin skill scoped to a different agent does not block agent-private skill", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "blog-flow", "publish-blog-post", ["sam"]);
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");

    const index = loadSkillIndex(
      customer,
      [makePlugin("plugin-a", pluginDir)],
      [],
      ["luna", "sam"],
      tmp,
    );

    expect(getSkillsForAgent(index, "luna")[0].path).toContain("agents/luna");
    expect(getSkillsForAgent(index, "sam")[0].path).toContain("plugin-a");
  });

  it("missing agent dir is silently skipped", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    // No agents/ directory at all.

    const index = loadSkillIndex(customer, [], [], ["luna", "sam"], tmp);

    expect(index.size).toBe(0);
  });

  it("hot-reload picks up new agent-private skills", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);

    let index = loadSkillIndex(customer, [], [], ["luna"], tmp);
    expect(getSkillsForAgent(index, "luna")).toEqual([]);

    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");
    index = loadSkillIndex(customer, [], [], ["luna"], tmp);
    expect(getSkillsForAgent(index, "luna")).toHaveLength(1);
  });
});
```

- [ ] **Step 3:** Verify

```bash
cd /Users/mokie/github/hive-KPR-75 && npx vitest run src/agents/skill-loader.test.ts 2>&1 | tail -10
```

Expected: all existing tests still pass + 7 new tests pass.

- [ ] **Step 4:** Commit

```bash
git add src/agents/skill-loader.test.ts
git commit -m "test(skills,KPR-75): per-agent skill loading and collision scoping"
```

---

### Task 4: Wire agent IDs into `loadSkillIndex` callers

**Files:**
- Modify: `src/agents/agent-manager.ts`

**Verified during pre-flight:** AgentManager already injects `AgentRegistry` in its constructor (`agent-manager.ts:72`) and stores it as `this.registry` (line 73). No constructor surgery needed — `this.registry.listIds()` is already available at both call sites.

- [ ] **Step 1:** Update both `loadSkillIndex` call sites in `src/agents/agent-manager.ts`.

```typescript
// Constructor (~line 80):
this.skillIndex = loadSkillIndex(
  skillsDir,
  this.plugins,
  this.seedDirs,
  this.registry.listIds(),
);

// reloadSkills() (~line 100):
reloadSkills(): void {
  try {
    this.skillIndex = loadSkillIndex(
      skillsDir,
      this.plugins,
      this.seedDirs,
      this.registry.listIds(),
    );
  } catch (err) {
    log.warn("Skill reload failed, retaining previous index", { error: String(err) });
  }
}
```

No `hiveHomeOverride` arg in production — the loader falls back to the runtime `hiveHome` const, which is correct outside of tests.

- [ ] **Step 2:** Verify

```bash
cd /Users/mokie/github/hive-KPR-75 && npm run typecheck 2>&1 | tail -3
```

Expected: clean.

- [ ] **Step 3:** Commit

```bash
git add src/agents/agent-manager.ts src/index.ts
git commit -m "feat(agents,KPR-75): pass agent IDs to skill loader for private skill discovery"
```

---

### Task 5: Extend file watcher to `agentsDir`

**Files:**
- Modify: `src/index.ts`

The current watcher watches `skillsDir` only (lines 295–302 from the audit). Per-agent skills live under `agentsDir()` which isn't currently watched. Without this extension, an agent writing a new SKILL.md to its private dir won't trigger reload until the next SIGUSR1.

- [ ] **Step 1:** Find the existing skills watch block in `src/index.ts` and extend it.

```typescript
// Existing (illustrative):
// if (existsSync(skillsDir)) {
//   watch(skillsDir, { recursive: true }, () => { /* debounced reload */ });
// }

// Add immediately after:
const agentsRoot = agentsDir();
if (existsSync(agentsRoot)) {
  watch(agentsRoot, { recursive: true }, (_event, filename) => {
    // Filter to SKILL.md changes — agents write to scratch/, reports/, feeds/,
    // playwright/ constantly. Triggering a full skill-index rebuild on every
    // scratch write would be a perf and log-noise nightmare.
    //
    // Edge case: on Linux and on some macOS event variants, `filename` can be
    // null. Fall back to debounced reload anyway — cheap correctness over a
    // false perf economy. Reload is debounced 500ms so coalescing is automatic.
    const isSkillMd = typeof filename === "string" && filename.endsWith("SKILL.md");
    const filenameMissing = filename === null || filename === undefined;
    if (isSkillMd || filenameMissing) {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reload(), 500);
    }
  });
  log.info("Agent-private skills hot-reload enabled", { watched: agentsRoot });
}
```

Add `agentsDir` to the imports from `./paths.js` if not already imported.

- [ ] **Step 2:** Verify by tail-watching the engine log while writing a SKILL.md to a tmp agent dir. Smoke covered in Task 7. For now just typecheck:

```bash
cd /Users/mokie/github/hive-KPR-75 && npm run typecheck 2>&1 | tail -3
```

- [ ] **Step 3:** Commit

```bash
git add src/index.ts
git commit -m "feat(reload,KPR-75): watch agentsDir for SKILL.md changes"
```

---

### Task 6: Constitution §2.3 affordance

**Files:**
- Modify: `setup/templates/constitution-bootstrap.md.tpl`
- Create: `docs/specs/2026-04-28-per-agent-private-skills-design.md`

The constitution is DB-native: `npm run setup:constitution` renders this template into the `memory` collection at path `shared/constitution.md`. Section 1 is overwrite-on-render; Section 2 is preserved on subsequent renders (per memory `feedback_admin_skill_ownership.md` — Section 2 belongs to the CoS to maintain).

That means: the agent-private-skills affordance copy belongs in **Section 1** (the bootstrap-rendered, immutable-by-template part), so it ships with new instances by default and is enforced engine-side. Adding it to Section 2 risks operator-customization losing it.

**Verified during pre-flight:** the template's last numbered clause is **§1.23** (`No silent blocking`). KPR-80's PR #211 adds **§1.24** (`contacts vs crm_search` tool convention) and is currently OPEN, expected to merge first. To deconflict, this plan uses **§1.25**. If KPR-80 doesn't merge before KPR-75, the implementer should renumber to §1.24 — confirm by re-greping the current template at implementation time:

```bash
grep -n "^1\." setup/templates/constitution-bootstrap.md.tpl | tail -5
```

- [ ] **Step 1:** Insert the new clause in Section 1, after the last numbered clause (currently §1.23 → after KPR-80 lands, §1.24) and before the `### Group Conversations` subsection (around line 105 in the unmodified template).

```markdown
### Per-agent private skills

1.25. **You can author your own skills under `agents/<your-id>/skills/`.** If you find yourself running the same multi-step routine often (a publish flow, a research checklist, a release-announcement format), draft it as a skill in `agents/<your-id>/skills/<workflow>/skills/<skill-name>/SKILL.md`. Skills you author here are private to you and survive across sessions.

The constitution still applies — a skill is a workflow shortcut, not an authority grant. Skills cannot edit your prompts, soul, or config (Constitution 1.11). They cannot grant tools or capabilities you don't already have. Do not write `agents:` in the frontmatter — the path is the source of truth (writing it triggers a hard error at load time).

Skills you author here are local to this instance only. They are not pushed, sync'd, or shared with other agents or other instances of this hive. If a skill becomes valuable enough that it should ship more broadly, surface it to the operator and they will promote it through the appropriate channel.
```

Find a sensible place to insert this (likely near the end of Section 1, before the Section 2 delimiter `<!-- SECTION 2: OPERATIONAL -->`). Number it consistently with the surrounding clauses.

- [ ] **Step 2:** Create the design doc.

```markdown
# Per-Agent Private Skills — Design (KPR-75)

**Status:** Implemented 2026-04-28
**Builds on:** `2026-03-14-agent-skills-access-design.md`, `2026-04-15-skills-customer-space-design.md`

## Problem

Today skills load from three sources (customer, seeds, plugins) and are scoped to agents via `agents:` frontmatter. To make a Luna-only skill, an operator authors `<instance>/skills/luna-blog-flow/...` with `agents: [luna]` in frontmatter. Two issues:

1. **Filesystem disagrees with intent.** The skill lives in shared customer-space; only the frontmatter says "Luna-only." Discoverability is wrong.
2. **Operator-authored, not agent-authored.** Agents can't self-author skills at runtime in their own home.

## Solution

A 4th skill source: `<hiveHome>/agents/<id>/skills/`. Skills there are agent-private, agent-authored, agent-scoped implicitly by path. Frontmatter `agents:` is forbidden (hard error) — path is the source of truth.

## Sync semantics

- **Per-agent collisions are not collisions.** Luna and Sam each having `publish-blog-post` is fine — they're scoped per-agent in the index.
- **Customer-space still wins** for the agents it scopes to. Operator authority preserved.
- **No commit, no push, no sync.** Agent-private skills are local-filesystem-only and ephemeral by design. If an agent's skill becomes valuable enough to share, the operator promotes it through the appropriate channel (manually, today; via a future publish flow).

## What this is NOT

- Not a sharing flow. No agent → other-agent or agent → operator-repo path. Out of scope per ticket.
- Not auto-tracked. No `commitToState` for agent-private skill writes — keeps the workflow ceremony-free and avoids any auto-push concern (per `feedback_deploy_skill_autocommit.md`).
- Not a config-edit channel. Constitution 1.11 forbids agents from editing their own prompts/soul/config; skills are workflow recipes only.

## File map

- `src/paths.ts` — `agentSkillsDir(agentId, home?)` helper
- `src/agents/skill-loader.ts` — 4th source scan, `implicitAgentScope` parameter, per-agent collision scoping
- `src/agents/agent-manager.ts` — pass agent IDs into `loadSkillIndex` on boot + reload
- `src/index.ts` — file watcher extended to `agentsDir()` (filtered to SKILL.md)
- `setup/templates/constitution-bootstrap.md.tpl` — §1.25 affordance copy
```

- [ ] **Step 3:** Render the constitution template locally to verify substitution works.

```bash
cd /Users/mokie/github/hive-KPR-75 && npm run setup:constitution 2>&1 | tail -5
```

(This may write to MongoDB — only do this if your test instance is acceptable. If not, just verify the template parses by `cat`-ing it.)

- [ ] **Step 4:** Commit

```bash
git add setup/templates/constitution-bootstrap.md.tpl docs/specs/2026-04-28-per-agent-private-skills-design.md
git commit -m "docs(KPR-75): per-agent skills affordance + design doc"
```

---

### Task 7: Full check + smoke test

- [ ] **Step 1:** Full check.

```bash
cd /Users/mokie/github/hive-KPR-75 && npm run check 2>&1 | tail -8
```

Expected: typecheck + lint + format + test all green.

- [ ] **Step 2:** Bundle decontamination (KPR-80 lesson — make sure no plugin-specific strings leaked).

```bash
cd /Users/mokie/github/hive-KPR-75 && npm run check:bundle 2>&1 | tail -5
```

Expected: `OK: N bundle file(s) clean of forbidden strings`.

- [ ] **Step 3:** End-to-end smoke test.

The simplest smoke: write a SKILL.md to a fake agent dir under a tmp HIVE_HOME, build the loader, call it, confirm the skill is bound to that agent only.

```bash
SMOKE_HOME=$(mktemp -d) && \
mkdir -p "$SMOKE_HOME/agents/smoke-test/skills/test-flow/skills/smoke-skill" && \
cat > "$SMOKE_HOME/agents/smoke-test/skills/test-flow/skills/smoke-skill/SKILL.md" <<'EOF'
---
name: smoke-skill
description: KPR-75 smoke test
---
# Smoke skill body
EOF
mkdir -p "$SMOKE_HOME/skills" && \
cd /Users/mokie/github/hive-KPR-75 && npm run build 2>&1 | tail -2 && \
HIVE_HOME=$SMOKE_HOME node -e "
import('./dist/agents/skill-loader.js').then(m => {
  const idx = m.loadSkillIndex('$SMOKE_HOME/skills', [], [], ['smoke-test', 'other-agent']);
  console.log('smoke-test skills:', m.getSkillsForAgent(idx, 'smoke-test').map(s => s.path));
  console.log('other-agent skills:', m.getSkillsForAgent(idx, 'other-agent').map(s => s.path));
});
"
rm -rf "$SMOKE_HOME"
```

Expected output:
```
smoke-test skills: ['<SMOKE_HOME>/agents/smoke-test/skills/test-flow/skills/smoke-skill']
other-agent skills: []
```

If `loadSkillIndex` resolves `agentSkillsDir` from a load-time `hiveHome` const (not the env var), this smoke test will fail and you'll need the explicit-home overload from Task 3 step 2 note. Adjust accordingly.

---

### Task 8: PR

- [ ] Push branch:

```bash
cd /Users/mokie/github/hive-KPR-75 && git push -u origin KPR-75
```

- [ ] Create PR with `--base KPR-74-day1-oob` (KPR-75's parent ticket is the KPR-74 epic).

Title: `KPR-75: per-agent private skills under agents/<id>/skills/`

PR body should reference:
- The Linear ticket KPR-75
- The design doc `docs/specs/2026-04-28-per-agent-private-skills-design.md`
- Smoke test results
- Explicit list of out-of-scope items (sharing flow, auto-formatting, versioning, config self-edit)
- Note: **no commits, no pushes, no sync** for agent-private skills (per the explicit user directive)

---

## Acceptance criteria (from ticket)

- [x] Luna writes `agents/luna/skills/blog-flow/skills/publish-blog-post/SKILL.md`. After SIGUSR1 reload (or fs.watch trigger), she can invoke it.
- [x] Other agents do not see the skill in their slash command lists.
- [x] `npm update @keepur/hive` does not touch `agents/<id>/skills/` (already gitignored under `agents/`; engine never writes to it).
- [x] A plugin shipping `publish-blog-post` scoped to Luna does not shadow Luna's private one for her — but still applies to other agents the plugin scopes to.
- [x] Constitution §1.25 documents the affordance and the limit.
- [x] **No instance-git commit lands when an agent saves a skill** — local-filesystem-only by design.

## Follow-ups to consider after this lands

- File watcher could miss skills written by the `hive` engine itself if they bypass fs events on macOS — instrument and verify in production.
- If audit/rollback for agent-private skills becomes important, revisit the no-commit decision and add an opt-in `commitToState` path.
- Surface "this agent has private skills" in `hive skill list` output (currently lists only customer-space).
- Future: a `hive skill publish <agent>:<skill>` flow that an operator could run to promote a private skill into the operator repo (KPR-82 channel). Out of scope here; capture as new ticket if needed.
