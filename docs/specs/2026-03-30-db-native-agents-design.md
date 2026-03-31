# DB-Native Agents

**Date**: 2026-03-30
**Status**: Draft
**Problem**: Agent definitions live in code (templates). Code changes can destroy agents that only exist in other instances. Rigid 1:1 archetype-to-role mapping doesn't work across different businesses.

## Design

Agent definitions move from the template→generate→file pipeline to **MongoDB documents**. Every agent starts blank and is shaped through conversation (soul, role, personality) and admin tooling (servers, channels, model). Agents evolve over time through self-authored soul notes.

### What Goes Away

| Component | Status |
|-----------|--------|
| `agents-templates/` | Removed |
| `agents/` (generated) | Removed |
| `setup/generate-agents.ts` | Removed |
| `.hive-generated.json` | Removed |
| `model_overrides` collection | Removed (field on document) |
| `agent_config_overrides` collection | Removed (edit document directly) |
| `prompt_overrides` collection | Removed (fields on document) |
| `schedule_overrides` collection | Removed (schedule is a field on document) |

### What Stays

- **Constitution** — shared rules in `memory` collection, unchanged
- **Agent memory** — `memory` + `memory_versions` collections, unchanged
- **Sessions** — `sessions` collection, unchanged
- **Admin MCP server** — expanded with agent CRUD tools
- **Admin REST API** — expanded with agent CRUD endpoints (for beekeeper)
- **AgentRunner** — minor change: `buildSystemPrompt` adds soul notes layer; rest unchanged
- **AgentManager** — unchanged (manages runtime state)
- **Dispatcher** — unchanged (routes via registry)

## Agent Definition Document

```typescript
interface AgentDefinition {
  // Identity
  _id: string;                    // "rae", "jasper" — immutable after creation
  name: string;                   // Display name
  icon: string;                   // Emoji or URL

  // LLM
  model: string;                  // Model ceiling (claude-haiku-4-5, claude-sonnet-4-6, etc.)
  triageModel?: string;           // Override triage classifier model

  // Routing
  channels: string[];             // Slack channels this agent owns
  passiveChannels: string[];      // Listen-only channels
  keywords: string[];             // Routing keywords (reserved for future use)
  isDefault: boolean;             // Catch-all for unmatched messages

  // Capabilities
  coreServers: string[];          // MCP servers for parent session (admin-assigned)
  delegateServers: string[];      // MCP servers for subagent delegation
  delegatePrompts: Record<string, string>; // Custom prompts per delegate server
  plugins?: string[];             // Claude Code plugin allowlist
  dodiOpsMode?: "full" | "readonly";

  // Identity (two-layer)
  soul: string;                   // Base identity — admin-owned, set at creation
  soulNotes: SoulNote[];          // Agent-owned observations — agent can CRUD
  systemPrompt: string;           // Auto-assembled (see below), or manual override

  // Scheduling
  schedule: ScheduleEntry[];      // Cron tasks
  subscribe?: string[];           // Event bus subscriptions

  // Limits
  budgetUsd: number;
  maxTurns: number;
  maxConcurrent: number;
  timeoutMs: number;

  // Lifecycle
  disabled: boolean;
  slackBot?: string;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;              // "beekeeper", "chief-of-staff", agent ID, etc.
}

interface SoulNote {
  id: string;                     // UUID
  content: string;                // The insight/learning
  createdAt: Date;
  updatedAt: Date;
}

interface ScheduleEntry {
  cron: string;
  task: string;
}
```

**Collection**: `agent_definitions`
**Indexes**: `{ _id: 1 }` (default), `{ channels: 1 }`, `{ disabled: 1 }`

## Two-Layer Soul

The agent's identity is split into two layers with clear ownership:

| Layer | Owner | Mutability | Purpose |
|-------|-------|-----------|---------|
| `soul` | Admin (beekeeper, chief-of-staff, GUI) | Admin-only writes | Core personality, voice, values, role definition |
| `soulNotes` | The agent itself | Agent CRUD via MCP tool | Learned insights, behavioral adjustments, self-knowledge |

**Assembly order in system prompt** (see [System Prompt Assembly](#system-prompt-assembly) for the full list including optional layers).

The agent **cannot** modify `soul`. The agent **owns** `soulNotes` — it can add, edit, and delete its own notes. This preserves core identity while allowing growth.

### Soul Note MCP Tool

New tool on the **memory** MCP server (since it's already agent-identity-adjacent):

```
soul_note_add    — Record a lasting insight about yourself
soul_note_update — Revise an existing soul note
soul_note_remove — Remove a soul note that no longer applies
soul_note_list   — Review your current soul notes
```

These write directly to the `soulNotes` array on the agent's `agent_definitions` document.

## Agent CRUD

### Admin MCP Server (in-hive agents)

New tools added to the existing admin MCP server. Any agent with `admin` in its server list can manage agents. Note: the admin server was removed from all agents in PR #62 (beekeeper manages via CLI). This change intentionally re-enables it as an assignable server — instances with a chief-of-staff or similar coordinator can grant `admin` to that agent.

```
agent_create   — Create a new blank agent
agent_get      — Read an agent's full definition
agent_update   — Modify agent fields (soul, channels, servers, model, etc.)
agent_delete   — Remove an agent definition (with confirmation)
agent_list     — List all agents with status summary
```

### Admin REST API (external clients)

Same operations exposed as HTTP endpoints on the existing admin API port. Beekeeper, CLI tools, and future web UI are clients.

```
POST   /admin/agents          — Create agent
GET    /admin/agents           — List agents
GET    /admin/agents/:id       — Get agent
PATCH  /admin/agents/:id       — Update agent fields
DELETE /admin/agents/:id       — Delete agent
```

Auth: dedicated `ADMIN_API_TOKEN` env var in `.env` (separate from `BG_TASK_AUTH_TOKEN` to keep access surfaces independent).

### Server Registry

Agents are assigned servers from the instance's available pool. The available servers are determined by what's configured in the codebase + plugins — this doesn't change. But we formalize the list so admin tools can present it:

```typescript
interface ServerInfo {
  id: string;              // "memory", "slack", "hubspot-crm", etc.
  name: string;            // Human-readable name
  description: string;     // What it does
  source: "core" | string; // "core" or plugin name
  contextDependent: boolean; // Needs thread/channel env vars
}
```

`AgentRunner.getAvailableServers()` returns this list. The admin MCP tools and REST API expose it so clients can show a picker. No new collection needed — this is derived from the runner's server configuration code.

## AgentRegistry Changes

Today: reads `agents/` directory, applies MongoDB overrides.
After: reads `agent_definitions` collection directly.

**Removed code:**
- Constructor no longer takes `basePath` — takes MongoDB collection reference instead
- `config.agents.definitionsPath` removed from `config.ts`
- `getTemplate()` method removed (no override deltas to compute)
- `applyConfigOverrides()` function removed
- `ConfigOverride`, `PromptOverride` types removed from `agent-config.ts`
- `templateConfigs` map removed
- All four override collection references (`model_overrides`, `agent_config_overrides`, `prompt_overrides`, `schedule_overrides`) removed

```typescript
class AgentRegistry {
  // Before: load from disk + apply overrides
  // After: load from MongoDB directly
  async load(): Promise<LoadResult> {
    const docs = await this.agentDefs.find().toArray();
    const newAgents = new Map<string, AgentConfig>();

    for (const doc of docs) {
      if (doc.disabled) continue;
      newAgents.set(doc._id, this.toAgentConfig(doc));
    }

    // Diff against current agents → { added, updated, removed }
    return this.applyDiff(newAgents);
  }

  // Convert DB document to runtime config
  private toAgentConfig(doc: AgentDefinition): AgentConfig {
    return {
      id: doc._id,
      name: doc.name,
      model: doc.model,
      channels: doc.channels,
      // ... direct field mapping, no overrides needed
      soul: doc.soul,
      // Soul notes assembled into prompt by runner
      soulNotes: doc.soulNotes,
      systemPrompt: doc.systemPrompt,
    };
  }
}
```

**Hot reload**: MongoDB change stream on `agent_definitions` replaces the file system watcher. Initialized in `AgentRegistry.connectDb()`. On change event:
1. `registry.load()` — reload agent definitions
2. `scheduler.reloadSchedules()` — pick up schedule changes
3. `agentManager` notified of added/removed agents

`SIGUSR1` handler stays as a manual reload trigger (useful for debugging). The file system watcher on `agents/` is removed.

Falls back to periodic polling (30s) if change streams aren't available (e.g., standalone MongoDB without replica set).

## Schedule MCP Server

Today `schedule-mcp-server.ts` reads/writes `schedule_overrides` as a separate layer on top of `AGENT_SCHEDULE_DEFAULTS` (passed as env var at spawn time). After this change, both layers collapse into the single `schedule` field on `agent_definitions`.

**Schedule MCP server changes:**
- Reads/writes `agent_definitions.schedule` directly via MongoDB (no more `schedule_overrides` collection)
- Runner passes `MONGODB_URI`, `DB_NAME`, and `AGENT_ID` as env vars (replacing `AGENT_SCHEDULE_DEFAULTS`)
- Server reads current schedule from DB on each tool call — no stale-at-spawn-time issue
- `schedule: []` (empty array) = all jobs disabled, replacing the `null`-schedule sentinel

**Scheduler changes:**
- `reloadSchedules()` reads `agent_definitions.schedule` directly instead of layering `schedule_overrides` on top of agent config
- Two-layer merge logic removed — single authoritative field

**Admin MCP server schedule tools** (`schedule_disable`, `schedule_set`, `schedule_reset`) also write to `agent_definitions.schedule` directly.

## Constitution

Today `generate-agents.ts` renders `constitution.md.tpl` with business context and upserts to MongoDB. With the template pipeline removed, constitution rendering moves to a standalone step:

```bash
npm run setup:constitution   # Renders constitution template → MongoDB
```

This is a thin script that reads `setup/templates/constitution-{personal|business}.md.tpl`, renders with `hive.yaml` context, and upserts to the `memory` collection. Same logic as today, extracted from `generate-agents.ts`.

## Setup Commands

Today `npm run setup:agents` does three things: generate agent files, sync plugins, and render constitution. After this change:

```bash
npm run setup              # Runs all setup steps below
npm run setup:constitution # Render constitution template → MongoDB
npm run setup:seeds        # Import plugin agent seeds → agent_definitions (skip if exists)
npm run setup:plugins      # Sync Claude Code plugins from cache → plugins/claude-code/
```

`npm run setup:agents` is removed. The `setup` command runs all three steps. `config.agents.definitionsPath` is removed from `config.ts`.

## System Prompt Assembly

Today the runner assembles: date/time → soul → systemPrompt → constitution → memory.

After: `systemPrompt` as a separate authored field goes away for most agents. The prompt is assembled from components:

```
1. Date/time (auto)
2. Soul — base identity (admin-authored)
3. Soul notes — agent's learned insights (agent-authored)
4. Constitution — shared rules (instance-level)
5. systemPrompt — optional manual guardrails (when present)
6. Server instructions — delegate namespace summaries (existing behavior from `buildSystemPrompt`)
7. Agent memory — hot tier
```

The `systemPrompt` field remains available as an **optional manual override** for cases where an admin needs to inject specific guardrails or workflow instructions that don't fit in the soul. When present, it's inserted between soul notes and constitution.

"Server instructions" refers to the existing delegate namespace summaries already generated by `buildSystemPrompt()` — not a new mechanism. Each delegate server's description is listed so the agent knows what subagents are available.

## hive.yaml Changes

The `agents:` section in hive.yaml currently maps template IDs to names. This goes away — agent names live in the database.

```yaml
# Before
agents:
  executive-assistant:
    name: "Rae"
  vp-engineering:
    name: "Jasper"

# After — no agents section needed
# Agents are created via API/MCP tools
```

The rest of hive.yaml (business context, SMS config, ports, etc.) stays unchanged.

## Plugin Agents

Today plugins ship agent templates in `plugins/<name>/agents-templates/`. After this change, plugins can ship **seed definitions** — JSON/YAML files that the setup process imports into MongoDB if the agent doesn't already exist.

```
plugins/dodi/agent-seeds/
├── production-support.yaml
├── customer-success.yaml
└── ...
```

`npm run setup` checks: does this agent ID exist in `agent_definitions`? If no, insert the seed. If yes, **skip** — DB is source of truth. Plugin upgrades that add new recommended servers or change defaults do NOT auto-apply to existing agents. This is intentional: once an agent exists, its definition is admin-owned. Plugin changelogs should note recommended manual updates.

## Scope & Non-Goals

**In scope**:
- `agent_definitions` collection + schema
- AgentRegistry rewrite (DB-backed)
- Admin MCP tools for agent CRUD
- Admin REST API for agent CRUD
- Soul note MCP tools
- System prompt assembly changes
- Plugin seed mechanism
- Remove template pipeline

**Out of scope (future work)**:
- Web admin GUI (API-first, GUI later)
- Agent capability bundles / composable roles
- Agent cloning / forking
- Conversational agent creation UX (beekeeper concern, not Hive concern)
- Migration script for existing agents (separate task)
