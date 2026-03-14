# Hive-Native Skills

**Date**: 2026-03-14
**Status**: Draft

## Problem

Agents have access to MCP tools and external plugins (via `plugins/claude-code/`), but lack structured, reusable workflows for recurring tasks like morning briefings, standup prep, and reporting. Today these workflows live as verbal Slack instructions — inconsistent, forgotten across sessions, and invisible to developers.

## Solution

A `skills/` directory at the repo root containing hive-native skill definitions. Each skill is a SKILL.md file that provides structured instructions for how to use existing MCP tools. Skills are organized by workflow, with each SKILL.md declaring which agent(s) it belongs to via an `agents` frontmatter field.

### Key Decisions

- **Organized by workflow, not by role** — related skills live together (e.g., all morning-briefing skills in one folder), making coordination visible at a glance
- **Agent assignment in the skill, not in agent.yaml** — `agents: [sdr]` in the SKILL.md frontmatter. One place to see who does what, no cross-referencing agent configs. This is intentionally different from the `servers` pattern — skills are authored and understood from the skill's perspective, not the agent's.
- **Checked into git** — unlike `plugins/claude-code/` (synced from cache, gitignored), native skills are part of the repo
- **No new code** — skills are just SKILL.md recipes that use existing MCP tools
- **Agents see all skills in a workflow** — no per-agent filtering at the SDK level. The `agents` field is for developer visibility and documentation, not hard gating. Sibling visibility is a feature — e.g., Mokie (CoS) running morning-briefing benefits from seeing what the standup-prep skills produce.

### Directory Structure

The SDK expects plugins to have a `.claude/skills/<skill-name>/SKILL.md` structure internally. Each workflow folder is a self-contained plugin:

```
skills/
└── morning-briefing/                          # workflow folder = one SDK plugin
    └── .claude/
        └── skills/
            ├── sales-standup-prep/
            │   └── SKILL.md                   # agents: [sdr]
            ├── dev-standup-prep/
            │   └── SKILL.md                   # agents: [vp-engineering]
            ├── cs-standup-prep/
            │   └── SKILL.md                   # agents: [customer-success]
            ├── marketing-standup-prep/
            │   └── SKILL.md                   # agents: [marketing-manager]
            └── morning-briefing/
                └── SKILL.md                   # agents: [chief-of-staff]
```

### SKILL.md Format

Follows the existing Claude Code skill convention with one addition — the `agents` field:

```yaml
---
name: sales-standup-prep
description: Compile pipeline metrics, new leads, and outreach activity for the morning standup
agents:
  - sdr
---

# Sales Standup Prep

[Multi-step workflow instructions using existing MCP tools...]
```

**Frontmatter fields:**
- `name` (required) — skill identifier
- `description` (required) — what the skill does and when to use it
- `agents` (required) — list of agent IDs that should have this skill. Use `all` as a value to mean every agent.
- `tools` (optional) — documentation only. Lists MCP tools the skill expects to use. Not enforced at load time.

### How It Works

#### Loading

On startup, scan `skills/` for workflow directories (first-level subdirectories). Each workflow directory that contains a `.claude/skills/` subdirectory is a valid plugin.

Build a `SkillIndex`: a `Map<agentId, SdkPluginConfig[]>` that maps each agent to the workflow plugins it participates in. A workflow is included for an agent if any SKILL.md inside it lists that agent in its `agents` field (or has `all`).

#### SDK Integration

The SDK's `plugins` option accepts `{ type: 'local', path: string }`. Each workflow folder (e.g., `skills/morning-briefing/`) is passed as a separate local plugin. The SDK discovers skills via the `.claude/skills/` convention inside each plugin directory.

All agents participating in a workflow see all skills in that workflow. This is by design — the `agents` field tells the developer who's responsible, but at runtime the agent sees the full workflow context.

#### Coexistence with External Plugins

Both systems feed into the same SDK `plugins` array:

```typescript
const sdkPlugins = [
  ...this.buildSdkPlugins(),        // plugins/claude-code/ (external)
  ...this.buildNativeSkills(),       // skills/ (hive-native)
];
```

## Changes

### 1. Skill Loader (`src/agents/skill-loader.ts`)

New module that:
- Scans `skills/` for workflow directories containing `.claude/skills/`
- Parses each SKILL.md's YAML frontmatter to extract the `agents` field
- Builds a `Map<agentId, SdkPluginConfig[]>` (the skill index)
- Exports a `loadSkillIndex()` function called once at startup
- Handles `all` sentinel: workflows containing an `agents: [all]` skill are included for every agent

The index is built once and held in memory. It rebuilds when `skills/` changes via the existing hot-reload infrastructure (file watch + SIGUSR1 in agent-manager.ts).

### 2. Agent Runner (`src/agents/agent-runner.ts`)

- Constructor receives the skill index (or imports it as a singleton)
- New method `buildNativeSkills()` that looks up `this.agentConfig.id` in the skill index
- Merges result with `buildSdkPlugins()` before passing to `query()`

### 3. Agent Manager (`src/agents/agent-manager.ts`)

- Loads the skill index at startup via `loadSkillIndex()`
- Passes it to AgentRunner (or the singleton is imported directly)
- Adds `skills/` to the file-watch list for hot-reload

### 4. Skills Directory

Create `skills/` at repo root with the morning-briefing workflow as the first set. Skill content is a separate task — this spec covers the infrastructure only.

### 5. Deploy

`skills/` is checked into git, so it arrives via `git pull` in the deploy pipeline. No rsync step needed (unlike `plugins/claude-code/` which is gitignored). The deploy script (`service/deploy.sh`) requires no changes.

## What a Skill Is NOT

- Not a replacement for system prompts (standing orders and identity stay in soul.md / system-prompt.md)
- Not a replacement for MCP tools (skills use tools, they don't replace them)
- Not enforced access control (the `agents` field is for organization, not security)
- Not runtime-configurable via MongoDB overrides (skills are code, not config)

## Out of Scope

- Skill content (the actual morning-briefing SKILL.md recipes) — separate task
- Runtime skill management via admin MCP server
- Skill versioning
- Per-agent skill filtering at the SDK level (intentionally omitted — agents see full workflows)
