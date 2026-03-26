# Subagent Tool Delegation — Design Spec

**Date**: 2026-03-26
**Status**: Draft (v3 — post second review)
**Scope**: Reduce context bloat by delegating heavy MCP tool namespaces to SDK-native subagents
**Labels**: productization

## Problem

Every MCP server connected to an agent session dumps its full tool schemas into the agent's context window. A typical agent has 40-80+ tool definitions consuming 5-15K tokens — before the conversation even starts. As we add more integrations (ClickUp, HubSpot, dodi-ops, Google, etc.), this gets worse.

## Key Discovery

The Claude Agent SDK natively supports scoped subagents via `AgentDefinition`. Subagent MCP servers are:
- **Scoped**: the subagent only gets the servers in its own `mcpServers` array, NOT the parent's
- **Lazy**: MCP connections are spawned when the subagent is invoked, not at session start
- **Isolated**: the parent's context never sees the subagent's tool schemas

No custom MCP server or proxy layer needed — the SDK handles everything.

### Critical: `AgentMcpServerSpec` — Record form only

`AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>`

- **String form**: references a server from the parent's `mcpServers`. This defeats the purpose — the parent must have the server connected, so its tool schemas are already in parent context.
- **Record form**: `{ "hubspot-crm": serverConfig }` — inline server config unique to the subagent. Parent never connects it.

**This spec uses only the Record form.** The string form MUST NOT be used for delegate servers.

## Design

### Two-tier server classification

The `servers` key in `agent.yaml` gains a tier annotation:

```yaml
servers:
  core:
    - memory
    - slack
    - callback
    - event-bus
  delegate:
    - hubspot-crm
    - dodi-ops
    - clickup
    - google
    - resend
```

**Core servers**: Connected directly to the parent agent session. Tool schemas in context. These must include any context-dependent servers (callback, background, code-task, recall) that embed channel/thread context in their env vars — these servers cannot be delegated because the subagent runs in a fresh session without the parent's channel context.

**Delegate servers**: NOT connected to the parent session. Each becomes a named subagent via `AgentDefinition`. The parent invokes them via the SDK's `Agent` tool. Safe to delegate: application-data servers (hubspot, dodi-ops, clickup, google, resend, brave-search, contacts, permits, linear, etc.) that don't depend on the parent's channel context.

**Backward compatibility**: If `servers` is a flat string array (old format), all servers are treated as `core` (current behavior). The tiered format is opt-in.

### How it works

1. **Agent runner builds the `query()` call** with:
   - `mcpServers`: only core servers
   - `agents`: one `AgentDefinition` per delegate namespace

2. **Parent agent's system prompt** includes a summary of delegate namespaces, injected after the agent's `system-prompt.md` and before the constitution:
   ```
   ## Available via subagents

   Use the Agent tool to delegate tasks to these specialists:
   - hubspot-crm: Search and manage CRM — deals, contacts, companies, notes, tasks
   - dodi-ops: Production operations — jobs, cases, designs, cutlists, comments, attachments
   - clickup: Task management — tasks, lists, spaces, comments
   - google: Email (Gmail), calendar, Google Drive files
   - resend: Send outbound email with file attachments
   ```

3. **When the parent needs a delegate tool**, it calls:
   ```
   Agent(name: "hubspot-crm", prompt: "Search deals for Jones. Return deal name, stage, amount, last activity.")
   ```

4. **The SDK spawns the subagent** with only the hubspot-crm MCP server. The subagent's context has the 17 HubSpot tool schemas. The parent's context doesn't.

5. **Subagent executes**, returns result as text. Parent continues.

### AgentDefinition construction

In `agent-runner.ts`, for each delegate server:

```typescript
const delegateAgents: Record<string, AgentDefinition> = {};

for (const serverName of delegateServers) {
  const serverConfig = this.buildServerConfig(serverName, context);
  const description = NAMESPACE_DESCRIPTIONS[serverName] ?? serverName;

  delegateAgents[serverName] = {
    description,
    prompt: `You are a tool specialist for ${serverName}. Execute the requested task using your available tools. Return results concisely. Do not add commentary or explanation beyond what was asked.`,
    mcpServers: [{ [serverName]: serverConfig }],  // Record form — NOT string reference
    model: 'inherit',
    maxTurns: 10,
    disallowedTools: ['Agent'],  // subagents cannot spawn sub-subagents
  };
}

// In the query() call:
const q = query({
  prompt,
  options: {
    mcpServers: coreServers,
    agents: delegateAgents,
    // ... rest of options unchanged
  },
});
```

**Note on session resume**: When the parent session is resumed (`resume: sessionId`), the `agents` parameter must be passed again with the same definitions. The current `send()` method re-builds all options on every call, so this works by construction.

### Why `model: 'inherit'` not Haiku

The subagent's job may be mechanically simple (one tool call) or complex (multi-step: look up job → find design → check cutlist → flag issue). Haiku struggles with multi-step tool chains. Defaulting to the parent's model ensures quality. The cost savings come from not loading 50+ tool schemas into every parent turn — not from downgrading the subagent model.

`'inherit'` resolves to the parent's model alias, not the full model string — the SDK handles the mapping.

### `disallowedTools: ['Agent']` — no sub-subagents

The SDK explicitly states: "Subagents cannot spawn their own subagents." All delegate `AgentDefinition` objects include `disallowedTools: ['Agent']` to enforce this. Without this, a delegate subagent running under `bypassPermissions` could attempt to spawn a sub-subagent, which would either silently fail or error.

### Namespace descriptions

Central registry of one-line descriptions, used for both the parent prompt and the `AgentDefinition.description`:

```typescript
// src/delegate/namespace-descriptions.ts
export const NAMESPACE_DESCRIPTIONS: Record<string, string> = {
  "hubspot-crm": "Search and manage CRM — deals, contacts, companies, notes, tasks, activities",
  "dodi-ops": "Production operations — jobs, cases, designs, cutlists, comments, attachments",
  "clickup": "Task management — tasks, lists, spaces, comments, custom fields",
  "google": "Email (Gmail), calendar, Google Drive files",
  "resend": "Send outbound email with file attachments",
  "brave-search": "Web search, news, local business lookup",
  "contacts": "Contact lookups by name, email, or phone",
  "permits": "Permit pipeline data",
  "linear": "Issue tracking and project management",
};
```

Plugin MCP servers register descriptions in their plugin manifest (`description` field per MCP server entry).

### Config changes

**`AgentConfig` removes `servers` and adds `coreServers` + `delegateServers`:**

```typescript
interface AgentConfig {
  // ... existing fields ...
  // servers?: string[];  — REMOVED
  coreServers: string[];
  delegateServers: string[];
}
```

The YAML `servers:` key (either flat array or tiered object) is parsed in `loadAgent()` and stored as `coreServers`/`delegateServers`. The raw `servers` field does not exist on `AgentConfig` at runtime — this eliminates ambiguity about which field is authoritative.

In `agent-registry.ts loadAgent()`:

```typescript
const rawServers = raw.servers;
let coreServers: string[];
let delegateServers: string[];

if (Array.isArray(rawServers)) {
  // Backward compat: flat array = all core
  coreServers = rawServers;
  delegateServers = [];
} else if (rawServers && typeof rawServers === 'object') {
  coreServers = rawServers.core ?? [];
  delegateServers = rawServers.delegate ?? [];
} else {
  coreServers = [];
  delegateServers = [];
}
```

### ConfigOverride handling

Replace `servers` in `arrayFields` with `coreServers` and `delegateServers`:

```typescript
const arrayFields = ["channels", "passiveChannels", "keywords", "coreServers", "delegateServers", "plugins", "subscribe"] as const;
```

`ConfigOverride` type:
```typescript
interface ConfigOverride {
  // servers?: ArrayOverride;  — REMOVED (backward compat: see below)
  coreServers?: ArrayOverride;
  delegateServers?: ArrayOverride;
  // ... other fields
}
```

**Backward compat for existing MongoDB documents**: Old `ConfigOverride` documents may have `servers` (not `coreServers`). In `applyConfigOverrides`, if the document has `servers` but not `coreServers`, treat `servers` as `coreServers`:

```typescript
if (override.servers && !override.coreServers) {
  override.coreServers = override.servers;
}
```

### All `servers` read sites — migration checklist

Every place that reads `AgentConfig.servers` must be updated:

| File | Line | Current usage | Fix |
|------|------|---------------|-----|
| `agent-runner.ts` | ~468 | `this.agentConfig.servers?.length` + `Set(this.agentConfig.servers)` for allowlist filter | Use `new Set([...coreServers, ...delegateServers])` for the full allowlist, but only connect `coreServers`. **Preserve the structured-memory special case** (lines 471-473): if `memory` is in the allowed set, `structured-memory` is also allowed. |
| `agent-manager.ts` | ~231 | `config?.servers?.some(s => s === "memory")` for reflection guard | Use `config.coreServers.includes("memory") \|\| config.coreServers.includes("structured-memory")` |
| `agent-registry.ts` | ~213 | `servers: (raw.servers as string[])` in loadAgent | Replace with tiered parsing (shown above) |
| `applyConfigOverrides` | ~29 | `"servers"` in `arrayFields` | Replace with `"coreServers"` and `"delegateServers"` |

### `buildMcpServers` refactor

Current: one monolithic `buildMcpServers(context)` that builds all server configs + applies the allowlist filter.

Refactored:
- `buildAllServerConfigs(context): Record<string, McpServerConfig>` — builds ALL server configs (core + plugin), no filtering
- `buildMcpServers(context): Record<string, McpServerConfig>` — calls `buildAllServerConfigs`, filters to `coreServers` only (for the parent session)
- `buildServerConfig(name, context): McpServerConfig` — calls `buildAllServerConfigs`, returns config for a single named server (for delegate `AgentDefinition`)

Note: `buildAllServerConfigs` runs once per `send()` call and can be cached within the call to avoid rebuilding for each delegate server.

### What this looks like in practice

**Before**: Jessica's session starts with 71 tools in context.

**After**: Jessica's session starts with ~23 core tools + 5 named subagents (one-line descriptions each, ~500 tokens total). When she needs HubSpot, she calls `Agent("hubspot-crm", "search deals for Jones")` — the subagent spawns with 17 HubSpot tools, executes, returns.

**Context savings**: ~10K tokens per session freed up for actual conversation.

## Files to Create

| File | Purpose |
|------|---------|
| `src/delegate/namespace-descriptions.ts` | Central registry of namespace one-line descriptions |

## Files to Modify

| File | Change |
|------|--------|
| `src/types/agent-config.ts` | Remove `servers`, add `coreServers` and `delegateServers` to `AgentConfig`; update `ConfigOverride` with `coreServers` and `delegateServers` (ArrayOverride); backward compat for old `servers` override documents |
| `src/agents/agent-registry.ts` | Parse tiered servers in `loadAgent()`; update `applyConfigOverrides` — replace `"servers"` with `"coreServers"` and `"delegateServers"` in `arrayFields`; backward compat for old override documents |
| `src/agents/agent-runner.ts` | Refactor `buildMcpServers` into `buildAllServerConfigs` + filter; build `AgentDefinition` objects for delegate namespaces with Record-form `mcpServers` and `disallowedTools: ['Agent']`; pass `agents` to `query()`; inject delegate summaries into system prompt (after system-prompt.md, before constitution) |
| `src/agents/agent-manager.ts` | Update reflection guard to use `config.coreServers` instead of `config.servers` |
| `src/plugins/types.ts` | Add optional `description?: string` to MCP server entries in plugin manifest |
| Agent templates (`agent.yaml.tpl` files) | Migrate from flat `servers:` to tiered `servers: { core, delegate }` where beneficial |

## Migration

1. Update `AgentConfig` type — remove `servers`, add `coreServers`/`delegateServers`
2. Update registry parsing + override system (backward compat for flat arrays + old MongoDB docs)
3. Update all 4 `servers` read sites
4. Refactor `buildMcpServers` into `buildAllServerConfigs` + filter + single-server lookup
5. Add `AgentDefinition` construction + `agents` option in `query()` call
6. Add namespace descriptions registry + system prompt injection
7. Add plugin manifest `description` field
8. Migrate one heavy agent (e.g., Jessica) to tiered format as a pilot
9. Measure context savings and verify subagent tool calling works
10. Roll out to remaining agents

## Not In Scope

- Subagent session caching (each call is fresh — could be added later)
- Multi-namespace subagent calls (one namespace per Agent call — parent can make multiple calls)
- Subagent memory persistence (subagent is stateless — parent manages memory)
- Custom delegate MCP server (SDK's native Agent + AgentDefinition handles this)
- Changes to the Claude Agent SDK
- Delegating context-dependent servers (callback, background, code-task, recall) — these must remain in core
