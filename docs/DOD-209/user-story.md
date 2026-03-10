# Plugin Architecture -- User Story

## Story

**As a** Hive platform operator (non-DodiHome customer),
**I want** DodiHome-specific MCP servers, agent templates, and hardcoded references separated from the core platform,
**so that** I can pull upstream updates without inheriting business-specific integrations I do not use.

## Background

Hive is a multi-agent Slack orchestration framework built on TypeScript and the Claude Agent SDK. It was purpose-built for DodiHome but is now being adopted by other customers. Approximately 80% of the codebase is generic platform code (dispatcher, triage, model router, agent runner, memory, adapters, core MCP servers). The remaining 20% is DodiHome-specific: 4 MCP servers (hubspot-crm, dodi-ops, catalog, permits) and 9 agent templates (all except chief-of-staff).

The knowledge base was previously a single `knowledge-base-mcp-server` with hardcoded DodiHome collection names. That has already been split into 3 domain search servers (`crm-search`, `product-search`, `ops-search`) which stay in core -- that work is done. This plan addresses the remaining DodiHome code.

Today, every customer gets the full DodiHome stack on clone. There is no mechanism to opt in or out of business-specific code. Several hardcoded DodiHome references (audit channel name, default GWS account, email domain) further couple the platform to a single tenant.

## Acceptance Criteria

### Plugin Discovery and Loading

1. The system reads `plugins` from `hive.yaml` (e.g., `plugins: [dodi]`) and only loads listed plugins.
2. A fresh install with no plugins configured provides only the platform core and the `chief-of-staff` agent template.
3. Each plugin has a `plugin.yaml` manifest declaring its MCP servers (with entry points, env vars, and agent-env mappings) and agent templates.
4. Plugin MCP servers are discoverable by the agent runner alongside core servers, with no hardcoded instantiation.
5. Plugin agent templates are discoverable by `setup/generate-agents.ts` alongside core templates.

### Plugin Isolation

6. Plugin code lives under `plugins/<name>/` and does not modify any file outside that directory.
7. Plugin MCP servers compile to `dist/plugins/<name>/` and are resolved from there at runtime.
8. Adding or removing a plugin requires only a `hive.yaml` change and a rebuild -- no source edits.

### DodiHome Migration

9. The 4 DodiHome MCP servers are moved from `src/` to `plugins/dodi/mcp-servers/`:
   - `src/hubspot/` (2 files: `hubspot-crm-mcp-server.ts`, `hubspot-api-client.ts`) -> `plugins/dodi/mcp-servers/hubspot-crm/`
   - `src/dodi-ops/` (1 file: `dodi-ops-mcp-server.ts`) -> `plugins/dodi/mcp-servers/dodi-ops/`
   - `src/catalog/` (1 file: `catalog-mcp-server.ts`) -> `plugins/dodi/mcp-servers/catalog/`
   - `src/permits/` (1 file: `permit-mcp-server.ts`) -> `plugins/dodi/mcp-servers/permits/`
10. The 9 DodiHome agent templates are moved from `agents-templates/` to `plugins/dodi/agents-templates/`: sdr, customer-success, marketing-manager, executive-assistant, product-manager, product-specialist, vp-engineering, devops, production-support.
11. The DodiHome plugin works identically to the current monolithic setup when `plugins: [dodi]` is configured.

### Hardcoded Reference Removal

12. The `"jessica"` audit channel name (hardcoded in `src/index.ts` line 150) is moved to `config.slack.auditChannel` via `hive.yaml`.
13. The `bot@dodihome.com` GWS account default (`src/config.ts` line 98) is changed to empty string -- configured per instance.
14. The `149-loWJnUWfJP6rEAsuFoYsI2pS1JjRM` shared folder ID default (`src/config.ts` line 100) is changed to empty string.
15. The `@dodihome.com` email domain in the resend from-address (`src/agents/agent-runner.ts` line 197) is replaced with `config.resend.emailDomain`.

### Setup Wizard

16. The setup wizard (`setup/setup-wizard.ts`) includes a plugin selection step that scans `plugins/*/plugin.yaml` and lets the operator choose which to enable.

### Build System

17. `npm run build` compiles both `src/` (via `tsconfig.json`) and `plugins/*/mcp-servers/` (via `tsconfig.plugins.json`) into their respective `dist/` locations.
18. `npm run setup:agents` discovers templates from both core (`agents-templates/`) and enabled plugins.

### Backward Compatibility

19. Existing DodiHome deployments continue to work with `plugins: [dodi]` in `hive.yaml` -- no behavioral change.
20. Agent `agent.yaml` files that reference plugin MCP servers by name (e.g., `hubspot-crm`) continue to work without modification.
21. The agent runner's existing filter (agents declare servers in `agent.yaml`, runner only wires allowed servers) is unchanged.

## Out of Scope

- **Plugin registry or marketplace** -- plugins are local directories, not downloaded packages.
- **Plugin versioning or dependency resolution** -- plugins are part of the repo (or manually placed), not semver-managed.
- **Runtime plugin loading** -- plugins are resolved at build time and startup. No hot-loading of plugins.
- **Plugin-provided dispatcher hooks, adapters, or scheduler extensions** -- only MCP servers and agent templates are pluggable in this phase.
- **Multi-tenant isolation** -- plugins are instance-level configuration, not per-user or per-workspace.
- **Breaking changes to agent.yaml schema** -- agents continue to list server names; the runner resolves them from core + plugins.
- **Knowledge base refactoring** -- the split into crm-search/product-search/ops-search is already done; those servers stay in core.
