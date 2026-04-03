# Intent-Aware Delegates — Design Spec

**Date**: 2026-03-26
**Status**: Draft (v2 — post spec review)
**Scope**: Replace raw tool delegation with intent-aware delegates that translate domain language to system hierarchy
**Depends on**: Subagent tool delegation (#37, shipped)
**Labels**: productization

## Problem

Delegate subagents (shipped in #37) reduce context bloat by moving heavy tool namespaces out of the parent agent's context. But the delegate's own experience is still poor — it receives a raw tool call and must navigate complex hierarchies to do anything useful.

**ClickUp example (Mike's CFO workflow):**

Mike says: "Create a task for Acme — Q1 books need to close by April 15"

Current flow (5+ tool calls inside the delegate):
1. `clickup_list_workspaces` → find "Acme Corp Holdings" among 7 workspaces
2. `clickup_list_spaces` → find "Finance" among 5 spaces
3. `clickup_list_folders` → find "Monthly Close" folder
4. `clickup_list_lists` → find "Q1 2026" list
5. `clickup_create_task` → finally create the task

That's 4 navigation round-trips before doing anything useful. The delegate burns turns, tokens, and latency on hierarchy traversal that's the same every time.

**This pattern repeats everywhere:**
- dodi-ops: Jessica shouldn't look up `CASE-343` — she thinks "Sarah's kitchen job"
- HubSpot: agents shouldn't navigate pipeline → stage → deal — they think "the Smith proposal"
- Google: agents shouldn't list calendars → find the right one — they know which calendar they use

## Insight

Most system hierarchies have two layers:
- **Static structure** — workspaces, spaces, departments, pipelines. Changes quarterly at most.
- **Dynamic content** — lists, tasks, deals, cases. Changes daily.

Agents shouldn't navigate static structure. They should already know it.

## Design

### Intent-Aware Delegate

An intent-aware delegate is a delegate subagent (as shipped in #37) with an **enhanced system prompt** that contains:

1. **A cached hierarchy map** — the static structure pre-resolved to IDs
2. **Domain-language instructions** — how to interpret the parent agent's natural language requests
3. **Navigation shortcuts** — skip straight to the dynamic layer

The delegate still uses the same underlying MCP tools. No new tools, no new servers. The intelligence is in the prompt.

### Architecture

```
Parent Agent (CFO Assistant)
  → "Create a task for Acme — Q1 close by April 15"
  → Agent tool invocation: delegate to "clickup"
    → Intent-Aware ClickUp Delegate
      → System prompt contains: Acme = workspace 12345, Finance = space 67890
      → Skips to: list_folders(space=67890) or list_lists(folder=...)
      → Creates task in 1-2 calls instead of 5
      → Returns: "Created task 'Q1 close' in Acme → Finance → Monthly Close → Q1 2026"
```

### Enhanced Delegate Prompt Structure

Current delegate prompt (from #37):
```
You are a tool specialist for clickup. Execute the requested task
using your available tools. Return results concisely.
```

Intent-aware delegate prompt:
```
You are a ClickUp specialist for {agent.name}'s workflow.

## Workspace Map

| Client | Workspace ID | Primary Space | Space ID |
|--------|-------------|---------------|----------|
| Acme Corp | 12345 | Finance | 67890 |
| BoardCo | 11111 | Board Ops | 22222 |
| Coaching | 33333 | Clients | 44444 |
| ... | ... | ... | ... |

## Navigation Rules

- When the user mentions a client name, resolve to the workspace/space
  from the map above. Do NOT call list_workspaces or list_spaces.
- Start navigation at the space level (list_folders or list_folderless_lists).
- For task creation, navigate to the correct list first, then create.
- For task search, use search_tasks with the workspace ID from the map.
- Return results using client names, not raw IDs.

## Domain Context

{Injected from agent memory — recent work context, common lists, etc.}
```

### Implementation: Delegate Prompt Override

The current `buildDelegateAgents()` constructs a generic prompt for every delegate:

```typescript
prompt: `You are a tool specialist for ${serverName}...`
```

We need a mechanism for agents to provide a **custom delegate prompt** per server. This is the only infrastructure change needed.

**Approach: `delegate-prompts/` directory alongside soul.md**

```
agents-templates/cfo-assistant/
├── agent.yaml.tpl
├── soul.md
├── system-prompt.md.tpl
└── delegate-prompts/
    └── clickup.md.tpl       ← custom prompt for clickup delegate
```

Delegate prompts can be substantial (workspace maps, navigation rules, domain context) and don't belong inline in YAML. The directory approach follows the existing `.md.tpl` pattern for agent prompt content.

### Template Generator Changes

The current generator (`setup/generate-agents.ts`) loops over files in each template directory with `readdirSync()` and does not recurse into subdirectories. It will throw `EISDIR` if it encounters a directory entry. The generator needs these changes:

1. **Directory detection** — when iterating template dir entries, check `statSync(srcPath).isDirectory()`. If the entry is `delegate-prompts/`, handle it specially instead of trying to read it as a file.

2. **Per-file rendering** — iterate files inside `delegate-prompts/`, render each `<server-name>.md.tpl` through the existing `renderAgent()` template engine (supports `{{agent.name}}`, `{{#if}}`, etc.).

3. **YAML serialization** — collect rendered prompts into a `delegatePrompts: Record<string, string>` map. Write this into the generated `agent.yaml` using YAML block scalar syntax (`|`) to preserve markdown formatting:

```yaml
delegatePrompts:
  clickup: |
    You are a ClickUp specialist for Finance's workflow.

    ## Workspace Map
    | Client | Workspace ID | Primary Space | Space ID |
    ...
```

4. **Output location** — the rendered delegate prompts live only in the generated `agent.yaml` (in `agents/`), not as separate files. The generator consumes `.md.tpl` sources and produces a single YAML field.

### Agent Registry Changes

`loadAgent()` in `agent-registry.ts` must explicitly extract the new field from parsed YAML:

```typescript
delegatePrompts: (raw.delegatePrompts as Record<string, string>) || undefined,
```

The `delegatePrompts` field is **not overridable** via MongoDB `ConfigOverride`. Delegate prompts are part of the agent's core identity (like `systemPrompt`), not operational config. Runtime tuning should use memory, not overrides.

### Hierarchy Map: Population and Refresh

The workspace map in the delegate prompt needs to come from somewhere.

**Phase 1 (guinea pig):** Hand-authored. Mike has ~7 workspaces. We write the map once, update it when clients change. This is fine for proving the pattern.

**Phase 2 (automation):** The **parent agent** (CFO assistant) runs a scheduled task (like `memory-review`) that invokes the ClickUp delegate to traverse all workspaces/spaces, builds the hierarchy map, and stores it as a **hot-tier pinned memory record** (topic: `clickup-hierarchy-map`, importance: `critical`). At session construction time, `buildDelegateAgents()` queries the parent's hot memory for this record and injects it into the delegate prompt, replacing the static template map. This requires `buildDelegateAgents()` to accept a memory context parameter — a non-trivial but well-scoped change.

**Phase 3 (memory integration):** The delegate prompt is partially dynamic — the cached map (from Phase 2 pinned memory) provides structure, but additional hot memory injects recent context:
- "Last session: Mike was working on Acme Q1 close, list ID 99999"
- "BoardCo has a new folder 'Q2 Planning' created this week"

This is where the intent-aware pattern connects back to the structured memory system. The delegate gets smarter over time without code changes.

### What Changes

| Component | Change | Scope |
|-----------|--------|-------|
| `agent-runner.ts` | `buildDelegateAgents()` checks for custom delegate prompt file/config | Small — prompt string override |
| `agents-templates/` | New `delegate-prompts/` directory convention | Convention only |
| Template generator | Directory detection, per-file rendering, YAML block scalar serialization | Medium — see "Template Generator Changes" above |
| Agent config type | Add optional `delegatePrompts?: Record<string, string>` to AgentConfig | Type addition |
| Agent registry | Extract `delegatePrompts` from parsed YAML in `loadAgent()` | One line |
| ClickUp server registration | Wire ClickUp into `buildAllServerConfigs()` — requires `CLICKUP_API_TOKEN` env var, `config.clickup.apiKey` in config.ts | Small — follows Linear pattern |
| Personal instance templates | Create CFO agent template with ClickUp delegate prompt | New template |

### What Doesn't Change

- ClickUp MCP server — no modifications to tools or API calls
- Delegate subagent construction — same `AgentDefinition` structure, just different `prompt` field
- Parent agent system prompt — still sees `- clickup: Task management — tasks, lists, spaces, comments`
- Model routing — delegates still use `model: "inherit"`

## Guinea Pig: Mike's CFO Agent

### New Agent Template: `cfo-assistant`

```
agents-templates/cfo-assistant/
├── agent.yaml.tpl
├── soul.md                    ← CFO personality, Mike's working style
├── system-prompt.md.tpl       ← Role definition, client list, priorities
└── delegate-prompts/
    └── clickup.md.tpl         ← Workspace map + navigation rules
```

**Servers:**
```yaml
servers:
  core:
    - memory
    - slack
    - callback
  delegate:
    - clickup
    - google        # calendar for client meetings
    - brave-search  # research
```

**Why a new template, not reusing chief-of-staff:** The CFO role has distinct domain context (clients, financial workflows, board responsibilities) that would pollute a general-purpose chief-of-staff. Dedicated template keeps it focused.

### Personal Instance Config

```yaml
# hive-personal.yaml (additions)
agents:
  cfo-assistant:
    name: "Finance"    # or whatever Mike wants to call it
```

### ClickUp Server Registration

ClickUp MCP server exists (`src/clickup/clickup-mcp-server.ts`) but is not yet wired into `buildAllServerConfigs()`. Required:

1. Add `clickup` section to `config.ts`: `clickup: { apiKey: env.CLICKUP_API_TOKEN || "" }`
2. Add registration block in `buildAllServerConfigs()` (gated on `config.clickup.apiKey`):
```typescript
if (config.clickup.apiKey) {
  servers["clickup"] = {
    type: "stdio",
    command: "node",
    args: [resolve("dist/clickup/clickup-mcp-server.js")],
    env: { CLICKUP_API_TOKEN: config.clickup.apiKey },
  };
}
```
3. Add `CLICKUP_API_TOKEN` to `.env` on personal instance

### Rollout Plan

1. Wire ClickUp into `config.ts` + `buildAllServerConfigs()` (see above)
2. Add `delegatePrompts` field to `AgentConfig` type + `loadAgent()` extraction
3. Update `buildDelegateAgents()` to use custom prompt when `delegatePrompts[serverName]` exists
4. Update template generator to handle `delegate-prompts/` directory
5. Create `cfo-assistant` agent template with hand-authored ClickUp workspace map
6. Deploy to personal instance, test with Mike
7. Iterate on the workspace map and navigation rules based on real usage

## Future: Pattern Generalization

Once proven on ClickUp, the same pattern applies to every heavy namespace:

| Namespace | Static Layer (cache) | Dynamic Layer (navigate) |
|-----------|---------------------|-------------------------|
| ClickUp | Workspaces → Spaces | Folders → Lists → Tasks |
| dodi-ops | Projects → Job types | Jobs → Cases → Comments |
| HubSpot | Pipelines → Stages | Deals → Contacts → Activities |
| Google | Calendars, Drive folders | Events, Files |

Each gets a `delegate-prompts/{namespace}.md.tpl` with its cached map and domain rules.

**Memory integration** (Phase 3) makes this self-maintaining: agents learn which lists/folders/deals they use most, pin that context, and the delegate prompt gets smarter without manual updates.

## Non-Goals

- **No new MCP tools** — the intelligence is in the prompt, not in code
- **No splitting ClickUp into sub-servers** — 15 tools is fine for a focused delegate
- **No cross-delegate coordination** — each delegate operates independently
- **No dynamic prompt generation at runtime** — Phase 1 is static templates; dynamic comes with memory integration in Phase 2/3

## Decisions

1. **maxTurns for intent-aware delegates** — **7 turns**. With navigation shortcuts, most operations should complete in 3-5 turns. 7 gives headroom for a folder→list→task chain with one retry, while preventing runaway delegates. This can be made configurable per-delegate later if needed, but a single default is fine for Phase 1.
2. **Delegate memory** — **parent-only**. Delegates stay stateless. Memory access in a delegate creates the context-dependent server problem (the delegate would need AGENT_ID wiring, and which agent's memory does it read?). All learning stays in the parent; the parent's memory feeds into the delegate prompt at construction time.
3. **Error context** — **text response only** (current behavior). The SDK returns the delegate's final text response to the parent. This is sufficient — the parent can retry or ask the user for clarification. No special error channel needed.

## Open Questions

1. **Per-delegate maxTurns override** — should `delegatePrompts` config also allow a `maxTurns` override per server? Not needed for Phase 1, but may matter when dodi-ops (49 tools) gets an intent-aware delegate that needs more room.
