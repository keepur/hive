# Plugin Separation — Design Spec

**Date**: 2026-03-20
**Status**: Draft

## Problem

Hive has an external customer who runs his own agent setup. He can't safely pull and deploy the latest repo because DodiHome-specific code is still baked into core:

1. **9 of 10 agent templates** in `agents-templates/` reference DodiHome MCP servers (`hubspot-crm`, `dodi-ops`, `catalog`, `permits`, `crm-search`, `product-search`, `ops-search`). Running `npm run setup:agents` gives him agents wired to servers he doesn't have.

2. **3 search MCP servers** (`crm-search`, `product-search`, `ops-search`) are hardcoded in `agent-runner.ts` and query DodiHome's Qdrant collections. They compile but fail at runtime for anyone without that data.

3. **"chief-of-staff" is hardcoded** as the admin/privileged agent ID in `conversation-search-mcp-server.ts` (access control) and `admin-mcp-server.ts` (audit trail).

The plugin infrastructure is already built — loader, types, agent-runner wiring, template generator all work. The 4 business MCP servers are already moved to `plugins/dodi/mcp-servers/`. What remains is completing the file moves and removing hardcoded references.

## Current State

### Already done
- `src/plugins/types.ts` — TypeScript interfaces
- `src/plugins/plugin-loader.ts` — discovery, validation, loading
- `src/agents/agent-runner.ts` lines 381+ — plugin MCP server injection with env-map and agent-env
- `setup/generate-agents.ts` lines 182+ — merges plugin agent templates into generation
- `plugins/dodi/plugin.yaml` — manifest with 4 MCP servers + 9 agent template IDs
- `plugins/dodi/mcp-servers/` — hubspot-crm, dodi-ops, catalog, permits (source already moved)

### Not done
- Agent templates not moved (still in core `agents-templates/`)
- 3 search MCP servers not moved (still hardcoded in `agent-runner.ts`)
- `conversation-search` not moved (but may stay in core — it's generic except for the access control check)
- Hardcoded "chief-of-staff" references in access control and audit logging

## Solution

### 1. Move 9 agent templates to plugin

Move from `agents-templates/<id>/` to `plugins/dodi/agents-templates/<id>/` for:
- sdr, customer-success, marketing-manager, executive-assistant, product-manager, product-specialist, vp-engineering, devops, production-support

**Keep `chief-of-staff` in core** — it's the only truly generic template (coordination, delegation, no business-specific servers).

After the move, `agents-templates/` contains only `chief-of-staff`. When a customer without the `dodi` plugin runs `npm run setup:agents`, they get one agent. With the plugin enabled, they get all 10.

The template generator already handles this (`setup/generate-agents.ts` lines 182-205). No code changes needed — just the file move.

### 2. Move 3 search MCP servers to plugin

Move `src/search/crm-search-mcp-server.ts`, `src/search/product-search-mcp-server.ts`, and `src/search/ops-search-mcp-server.ts` to `plugins/dodi/mcp-servers/`.

Remove the hardcoded entries from `agent-runner.ts` (lines 349-371). These become plugin MCP servers loaded dynamically like the other 4.

Update `plugins/dodi/plugin.yaml` to add:

```yaml
crm-search:
  entry: mcp-servers/crm-search/crm-search-mcp-server.ts
  env: [QDRANT_URL, OLLAMA_URL, KB_EMBED_MODEL, KB_BACKEND, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
product-search:
  entry: mcp-servers/product-search/product-search-mcp-server.ts
  env: [QDRANT_URL, OLLAMA_URL, KB_EMBED_MODEL, VOYAGEAI_API_KEY]
ops-search:
  entry: mcp-servers/ops-search/ops-search-mcp-server.ts
  env: [QDRANT_URL, OLLAMA_URL, KB_EMBED_MODEL, VOYAGEAI_API_KEY]
```

**Keep `conversation-search` in core** — it searches agent conversations (generic), not business data. But fix the hardcoded access control (see below).

### 3. Make admin agent ID configurable

Replace hardcoded `"chief-of-staff"` string checks with a config value.

**`src/config.ts`**: Already has `defaultAgent` (line 89). Add or reuse this as the admin agent ID — the default agent and the admin agent are the same concept.

**`src/search/conversation-search-mcp-server.ts` (line 56)**:
```typescript
// Before:
if (effectiveAgentId !== AGENT_ID && AGENT_ID !== "chief-of-staff") {

// After — pass DEFAULT_AGENT as env var to the MCP server:
const ADMIN_AGENT = process.env.DEFAULT_AGENT ?? "chief-of-staff";
if (effectiveAgentId !== AGENT_ID && AGENT_ID !== ADMIN_AGENT) {
```

**`src/admin/admin-mcp-server.ts`**: The `updatedBy: "chief-of-staff"` strings are audit logs. Change to use `AGENT_ID` env var (already available to all MCP servers):
```typescript
updatedBy: process.env.AGENT_ID ?? "unknown"
```

### 4. Update build config

Add `plugins/dodi/mcp-servers/` to `tsconfig.plugins.json` (or the existing tsconfig if there's no separate one). The moved search servers need to compile to `dist/plugins/dodi/mcp-servers/`.

Verify the existing plugin build path works — `agent-runner.ts` line 391 already resolves:
```typescript
const compiledPath = resolve(`dist/plugins/${plugin.name}/${serverDef.entry.replace(/\.ts$/, ".js")}`);
```

### 5. Clean up agent template server references

After the search servers become plugin servers, verify that agent templates referencing them (e.g., `servers: [crm-search, product-search]` in agent.yaml files) still resolve correctly. The agent-runner's server whitelist filters the merged set of core + plugin servers, so this should work without changes to the templates themselves.

## Files Changed

### Moved (core → plugin)
| From | To |
|------|-----|
| `agents-templates/sdr/` | `plugins/dodi/agents-templates/sdr/` |
| `agents-templates/customer-success/` | `plugins/dodi/agents-templates/customer-success/` |
| `agents-templates/marketing-manager/` | `plugins/dodi/agents-templates/marketing-manager/` |
| `agents-templates/executive-assistant/` | `plugins/dodi/agents-templates/executive-assistant/` |
| `agents-templates/product-manager/` | `plugins/dodi/agents-templates/product-manager/` |
| `agents-templates/product-specialist/` | `plugins/dodi/agents-templates/product-specialist/` |
| `agents-templates/vp-engineering/` | `plugins/dodi/agents-templates/vp-engineering/` |
| `agents-templates/devops/` | `plugins/dodi/agents-templates/devops/` |
| `agents-templates/production-support/` | `plugins/dodi/agents-templates/production-support/` |
| `src/search/crm-search-mcp-server.ts` | `plugins/dodi/mcp-servers/crm-search/crm-search-mcp-server.ts` |
| `src/search/product-search-mcp-server.ts` | `plugins/dodi/mcp-servers/product-search/product-search-mcp-server.ts` |
| `src/search/ops-search-mcp-server.ts` | `plugins/dodi/mcp-servers/ops-search/ops-search-mcp-server.ts` |

### Modified
| File | Change |
|------|--------|
| `src/agents/agent-runner.ts` | Remove hardcoded crm-search, product-search, ops-search server entries (lines 349-371) |
| `src/search/conversation-search-mcp-server.ts` | Replace hardcoded "chief-of-staff" with `DEFAULT_AGENT` env var |
| `src/admin/admin-mcp-server.ts` | Replace `updatedBy: "chief-of-staff"` with `AGENT_ID` env var |
| `plugins/dodi/plugin.yaml` | Add 3 search MCP server entries |
| `tsconfig.json` or build config | Ensure plugin source compiles |

### Unchanged
| File | Why |
|------|-----|
| `agents-templates/chief-of-staff/` | Stays in core — generic coordinator template |
| `src/search/conversation-search-mcp-server.ts` | Stays in core — generic (searches agent convos, not business data) |
| `src/plugins/plugin-loader.ts` | Already handles everything needed |
| `setup/generate-agents.ts` | Already merges plugin templates |

## Verification

1. **Clean deploy (no plugins)**: `hive.yaml` with `plugins: []` → only chief-of-staff agent generated, no DodiHome MCP servers loaded, `npm run check` passes
2. **DodiHome deploy**: `hive.yaml` with `plugins: [dodi]` → all 10 agents generated, all MCP servers (core + plugin) available, identical behavior to current state
3. **Build**: `npm run build` compiles both core and plugin TypeScript
4. **Search servers**: agents with `crm-search` / `product-search` / `ops-search` in their `servers` list get those servers injected via plugin, same env vars as before
5. **Admin access control**: conversation-search respects `DEFAULT_AGENT` env var, admin-mcp-server logs actual agent ID

## Risks

- **Import paths**: The 3 search servers may import shared utilities from `src/search/` (e.g., embedding helpers). If so, those shared modules stay in core and the plugin servers import from the compiled core path. Check imports before moving.
- **Template variable references**: Some agent templates may reference business-specific template variables (like `{{sms_channels}}`). These are populated from `hive.yaml` — if the customer's `hive.yaml` doesn't define them, they render as empty strings. This is fine (graceful degradation), but worth documenting.
- **`env-map` in plugin.yaml**: The current manifest uses `env-map` which isn't in the original spec but IS supported by the loader. Keep it — it's useful for aliasing env vars without renaming them in .env.
