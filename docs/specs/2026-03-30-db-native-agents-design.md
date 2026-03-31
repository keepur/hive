# DB-Native Agents

**Date**: 2026-03-30
**Status**: Draft
**Problem**: Agent definitions live in code (templates). Code changes can destroy agents that only exist in other instances. Rigid 1:1 archetype-to-role mapping doesn't work across different businesses.

## Design

Agent definitions move from the template→generate→file pipeline to **MongoDB documents**. Every agent starts blank and is shaped through conversation (soul, role, personality) and admin tooling (servers, channels, model).

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
- **AgentRunner** — unchanged (receives AgentConfig, doesn't care where it came from)
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

  // Identity
  soul: string;                   // Personality, voice, values — admin-owned
  systemPrompt: string;           // Optional guardrails/workflow instructions — admin-owned

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

interface ScheduleEntry {
  cron: string;
  task: string;
}
```

**Collection**: `agent_definitions`
**Indexes**: `{ _id: 1 }` (default), `{ channels: 1 }`, `{ disabled: 1 }`

**Defaults** (applied by `toAgentConfig` when fields are absent — relevant for seeds and `agent_create`):
- `maxConcurrent`: 3
- `timeoutMs`: 300000 (5 min)
- `budgetUsd`: 10
- `maxTurns`: 200
- `icon`: ""
- `keywords`: []
- `passiveChannels`: []
- `delegatePrompts`: {}
- `schedule`: []

## Version History

Every mutation to an agent definition is versioned, following the same pattern as `memory_versions`.

```typescript
interface AgentDefinitionVersion {
  agentId: string;                // References agent_definitions._id
  snapshot: AgentDefinition;      // Full document at time of change (includes updatedBy)
  changedFields: string[];        // Which fields were modified
  createdAt: Date;                // When this version was saved
}
```

**Collection**: `agent_definition_versions`
**Indexes**: `{ agentId: 1, createdAt: -1 }`

**When a version is created**: on every `agent_update`, `agent_delete`, schedule change, or prompt change — any write to `agent_definitions`. The **previous** state is saved before the update is applied.

**Rollback**: the admin MCP server and REST API expose:
```
agent_history  — List recent versions for an agent
agent_rollback — Restore agent to a previous version
```

This protects against accidental soul wipes, bad config changes, or any mutation that needs to be undone. Versions are kept indefinitely (same retention as `memory_versions`).

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

**Connection model:** `index.ts` creates a shared `MongoClient` and passes `db.collection("agent_definitions")` to the registry constructor. No self-managed connection — same pattern as other components that share the client.

**Removed code:**
- Constructor no longer takes `basePath` — takes injected `Collection<AgentDefinition>` instead
- `config.agents.definitionsPath` removed from `config.ts`
- `getTemplate()` method removed (no override deltas to compute)
- `applyConfigOverrides()` function removed
- `ConfigOverride`, `PromptOverride` types removed from `agent-config.ts`
- `templateConfigs` map removed
- All four override collection references (`model_overrides`, `agent_config_overrides`, `prompt_overrides`, `schedule_overrides`) removed

**Unchanged:** Query methods (`findByChannel`, `findByName`, `getSubscriberMap`, `getAll`, etc.) continue to work against the in-memory `agents` map populated by `load()`. No interface change for downstream consumers.

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
      systemPrompt: doc.systemPrompt,
    };
  }
}
```

**Hot reload**: MongoDB change stream on `agent_definitions` replaces the file system watcher on `agents/`.

The registry accepts an `onReload` callback at construction. `index.ts` passes the existing `reload()` closure (which already calls `registry.load()`, `scheduler.reloadSchedules()`, and notifies `agentManager`). The change stream / polling timer invokes this callback on changes. The `fs.watch(agentsDir, ...)` block in `index.ts` is removed entirely.

`SIGUSR1` handler stays as a manual reload trigger (useful for debugging).

**Polling fallback** (for standalone MongoDB without replica set — current dev setup):
- On `connectDb()`, attempt `collection.watch()`. If it throws (no replica set), fall back to polling.
- Polling: every 30s, query `agent_definitions` for documents with `updatedAt > lastPollTime`. If any found, trigger full `load()`.
- Once set up, the mode (change stream vs polling) is fixed for the process lifetime — no hot-switching.

## Schedule MCP Server

Today `schedule-mcp-server.ts` reads/writes `schedule_overrides` as a separate layer on top of `AGENT_SCHEDULE_DEFAULTS` (passed as env var at spawn time). After this change, both layers collapse into the single `schedule` field on `agent_definitions`.

**Schedule MCP server changes:**
- Reads/writes `agent_definitions.schedule` directly via MongoDB (no more `schedule_overrides` collection)
- Runner already passes `MONGODB_URI`, `MONGODB_DB`, and `AGENT_ID` to the schedule server — only change is dropping `AGENT_SCHEDULE_DEFAULTS`
- Server reads current schedule from DB on each tool call — no stale-at-spawn-time issue
- The entire `defaults`/merge pattern is removed — server reads only `agent_definitions.schedule` (single source)
- `schedule: []` (empty array) = all jobs disabled, replacing the `null`-schedule sentinel

**Scheduler changes:**
- `reloadSchedules()` reads schedules from `registry.getAll()` only — no separate `loadScheduleOverrides()` call
- `scheduleOverrides` member, `ScheduleOverride` interface, and `schedule_overrides` index creation all removed
- Two-layer merge logic removed — single authoritative field

**Admin MCP server changes:**
- Existing override tools (`model_set`, `model_reset`, `config_set`, `config_reset`, `config_add`, `config_remove`, `prompt_set`, `prompt_reset`, `schedule_set`, `schedule_disable`, `schedule_reset`) are **removed**
- Replaced by `agent_update` which writes any field on `agent_definitions` directly
- `agent_enable`/`agent_disable` remain as convenience MCP tools + REST endpoints (`POST /admin/agents/:id/enable`, `POST /admin/agents/:id/disable`)
- All four override collection references removed from admin server
- Admin MCP server writes to `agent_definitions` directly via MongoDB (stdio subprocess, no REST round-trip). Runner passes `MONGODB_URI`, `MONGODB_DB` as env vars (already in the spawn block). `ADMIN_API_TOKEN` is only for the REST API surface — not needed by the MCP server.

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
2. Soul — personality, voice, values (admin-authored)
3. systemPrompt — optional guardrails/workflow instructions (admin-authored, when present)
4. Constitution — shared rules (instance-level)
5. Server instructions — delegate namespace summaries (existing behavior from `buildSystemPrompt`)
6. Agent memory — hot tier
```

Same assembly as today minus the template rendering step. "Server instructions" refers to the existing delegate namespace summaries already generated by `buildSystemPrompt()` — not a new mechanism.

## hive.yaml Changes

The `agents:` section in hive.yaml currently maps template IDs to names and holds `defaultAgent`. Agent names move to the database. `defaultAgent` stays in hive.yaml but moves to a top-level key:

```yaml
# Before
agents:
  definitionsPath: "agents/"
  defaultAgent: "executive-assistant"
  executive-assistant:
    name: "Rae"
  vp-engineering:
    name: "Jasper"

# After
defaultAgent: "rae"   # Catch-all agent ID (used by conversation-search, dispatcher fallback)
# Agent definitions live in MongoDB — no agents section needed
```

`config.agents` block is removed entirely from `config.ts` — including `definitionsPath`, `defaultAgent`, and `defaultModel` (dead code). All references to `config.agents.defaultAgent` update to `config.defaultAgent`:
- `src/index.ts` — dispatcher construction
- `src/agents/agent-runner.ts` — conversation-search `DEFAULT_AGENT` env var
- `src/agents/agent-runner.test.ts` — mock config object

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

Seed files include all `AgentDefinition` fields including `delegatePrompts` (today these live in `delegate-prompts/*.md` template files — seeds inline them as YAML).

## Migration

One-time script: `npm run migrate:agents`

For each agent directory in `agents/`:
1. Read `agent.yaml`, `soul.md`, `system-prompt.md` (3 files)
2. Read existing overrides from `model_overrides`, `agent_config_overrides`, `prompt_overrides`, `schedule_overrides`
3. Merge into a single `AgentDefinition` document (overrides win over file values)
4. Insert into `agent_definitions`

After migration, verify agent count matches, then the old collections and `agents/` directory can be cleaned up.

## Scope & Non-Goals

**In scope**:
- `agent_definitions` collection + schema
- `agent_definition_versions` collection (version history + rollback)
- AgentRegistry rewrite (DB-backed)
- Admin MCP tools for agent CRUD + history/rollback
- Admin REST API for agent CRUD + history/rollback
- System prompt assembly changes
- Schedule MCP server rewrite (read/write `agent_definitions` directly)
- Plugin seed mechanism
- Migration script (read 3 files per agent from `agents/` + existing DB overrides → `agent_definitions`)
- Remove template pipeline

**Out of scope (future work)**:
- Web admin GUI (API-first, GUI later)
- Agent self-evolution / soul notes (needs its own design — deferred)
- Agent capability bundles / composable roles
- Agent cloning / forking
