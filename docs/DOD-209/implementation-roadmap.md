# Plugin Architecture -- Implementation Roadmap

## Design Summary

The plugin architecture introduces a `plugins/` directory convention that lets business-specific code (MCP servers and agent templates) live in self-contained directories with a `plugin.yaml` manifest. The agent runner and template generator are modified to discover servers and templates from both core locations and enabled plugins. Hardcoded DodiHome references are extracted to `hive.yaml` configuration. The DodiHome-specific code becomes the first plugin (`plugins/dodi/`).

### Completed Prior Work

The knowledge base split (single `knowledge-base-mcp-server` -> 3 domain servers: `crm-search`, `product-search`, `ops-search`) is done and stays in core. That work is not part of this plan.

### Key Design Decisions

- **Convention over configuration**: plugins are directories under `plugins/` with a known structure. No plugin framework or SDK.
- **Build-time compilation**: plugin MCP servers are TypeScript, compiled by `tsc` into `dist/plugins/<name>/`. No runtime transpilation.
- **Manifest-driven discovery**: `plugin.yaml` declares MCP servers (with entry points, env vars, and agent-env mappings) and agent templates. The agent runner reads manifests at startup.
- **Additive only**: plugins can only add MCP servers and agent templates. They cannot override core behavior, hook into the dispatcher, or modify routing.
- **Agent-env mappings**: plugin manifests declare `agent-env` maps (ENV_VAR -> agentConfig field name), resolved by the agent runner at build time.

---

## Phase 1: Plugin Infrastructure

**Goal**: Establish the plugin directory convention, manifest schema, loader, and config changes. No code moves yet.

### Files to create
- `src/plugins/types.ts` -- `PluginMcpServer`, `PluginManifest`, `LoadedPlugin` interfaces
- `src/plugins/plugin-loader.ts` -- reads `hive.yaml` plugins list, loads and validates each `plugin.yaml`, returns typed manifest objects

### Files to modify
- `src/config.ts` -- add `plugins` array (from `hive.plugins`, default `[]`), add `slack.auditChannel`, add `resend.emailDomain` and `resend.businessName`, change GWS defaults from `"bot@dodihome.com"` / `"149-loWJnUWfJP6rEAsuFoYsI2pS1JjRM"` to `""`
- `src/index.ts` -- replace hardcoded `"jessica"` channel lookup (line 150) with `config.slack.auditChannel`, skip if empty
- `src/agents/agent-runner.ts` -- fix `@dodihome.com` email domain (line 197) to use `config.resend.emailDomain`

### Specific changes in `src/config.ts`
- Line 98: `"bot@dodihome.com"` -> `hive.googleWorkspace?.account ?? ""`
- Line 100: `"149-loWJnUWfJP6rEAsuFoYsI2pS1JjRM"` -> `hive.googleWorkspace?.sharedFolder ?? ""`
- Add inside `slack` block: `auditChannel: optional("SLACK_AUDIT_CHANNEL", hive.slack?.auditChannel ?? "")`
- Add inside `resend` block: `emailDomain` and `businessName`
- Add top-level: `plugins: (hive.plugins ?? []) as string[]`

**Exit criteria**: Config loads cleanly with new fields. No hardcoded DodiHome values in config defaults. Audit channel is configurable. Plugin loader can parse a test manifest.

---

## Phase 2: Agent Runner Plugin Integration

**Goal**: Wire the plugin loader into the agent runner so plugin MCP servers are discoverable alongside core servers.

### Files to modify
- `src/agents/agent-runner.ts`:
  - Add `plugins: LoadedPlugin[]` field and constructor parameter (line 41)
  - Remove 4 DodiHome server blocks from `buildMcpServers()` (lines 322-371: hubspot-crm, dodi-ops, catalog, permits)
  - Add plugin injection loop after core servers, before guardrail filter (line 384)
  - Plugin loop resolves compiled path (`dist/plugins/<name>/<entry>.js`), builds env from `env` list + `agentEnv` mappings
- `src/agents/agent-manager.ts`:
  - Import and call `loadPlugins()` in constructor
  - Store as `private plugins: LoadedPlugin[]`
  - Pass `this.plugins` to `new AgentRunner(config, this.memoryManager, this.plugins)` (line 41)

### Agent-env resolution
For each plugin server with `agentEnv` mappings, the agent runner resolves values:
```
DODI_OPS_MODE: dodiOpsMode  ->  agentConfig.dodiOpsMode ?? ""
DODI_OPS_AGENT_ID: id       ->  agentConfig.id
```

**Exit criteria**: With no plugins configured, behavior is unchanged. A test plugin MCP server can be registered and appears in the available server pool.

---

## Phase 3: Template Generator Plugin Integration

**Goal**: Make `setup/generate-agents.ts` discover templates from enabled plugins.

### Files to modify
- `setup/generate-agents.ts`:
  - Lines 96-100: replace single `agents` list with `coreAgents` + `pluginAgents` merged into `allAgents`
  - Read `config.plugins` from `hive.yaml`
  - For each enabled plugin, scan `plugins/<name>/agents-templates/` for template directories
  - Core templates win on name conflicts (log warning, skip plugin version)
  - Iterate `allAgents` with per-entry `templateDir` instead of deriving from `TEMPLATES_DIR`

**Exit criteria**: `npm run setup:agents` with no plugins generates only `chief-of-staff`. With `plugins: [dodi]`, generates all 10 agents.

---

## Phase 4: Move DodiHome Code

**Goal**: Move DodiHome-specific code into `plugins/dodi/`. Depends on Phases 1-3.

### Create plugin structure
```
plugins/dodi/
  plugin.yaml
  mcp-servers/
    hubspot-crm/
      hubspot-crm-mcp-server.ts
      hubspot-api-client.ts
    dodi-ops/
      dodi-ops-mcp-server.ts
    catalog/
      catalog-mcp-server.ts
    permits/
      permit-mcp-server.ts
  agents-templates/
    sdr/
    customer-success/
    marketing-manager/
    executive-assistant/
    product-manager/
    product-specialist/
    vp-engineering/
    devops/
    production-support/
```

### Git operations
- `git mv src/hubspot/ plugins/dodi/mcp-servers/hubspot-crm/`
- `git mv src/dodi-ops/ plugins/dodi/mcp-servers/dodi-ops/`
- `git mv src/catalog/ plugins/dodi/mcp-servers/catalog/`
- `git mv src/permits/ plugins/dodi/mcp-servers/permits/`
- `git mv agents-templates/sdr/ plugins/dodi/agents-templates/sdr/` (repeat for all 9)
- Create `plugins/dodi/plugin.yaml`
- Add `plugins: [dodi]` to `hive.yaml`

All 4 MCP servers are self-contained (no imports from `src/`), so no import path changes are needed.

**Exit criteria**: `npm run build` compiles core + plugin. DodiHome deployment with `plugins: [dodi]` behaves identically to current monolithic setup. Fresh install without the plugin starts with only `chief-of-staff`.

---

## Phase 5: Build System

**Goal**: Plugin TypeScript compiles cleanly alongside core.

### Files to create
- `tsconfig.plugins.json` -- separate config targeting `plugins/*/mcp-servers/**/*.ts`, outputting to `dist/plugins/`

### Files to modify
- `package.json` line 7: `"build": "tsc"` -> `"build": "tsc && tsc -p tsconfig.plugins.json"`, add `"build:plugins": "tsc -p tsconfig.plugins.json"`

**Exit criteria**: `npm run build` produces both `dist/` (core) and `dist/plugins/dodi/` (plugin servers). Compiled paths match what the agent runner resolves.

---

## Phase 6: Setup Wizard and Docs

**Goal**: Plugin selection in the setup wizard. Documentation updates.

### Files to modify
- `setup/setup-wizard.ts` -- add plugin selection section between Optional Integrations (line 345) and Agent Setup (line 347). Scan `plugins/*/plugin.yaml`, present list with descriptions, save to `hive.yaml` `plugins` array.
- `hive.yaml.example` -- add `plugins`, `slack.auditChannel`, `resend.emailDomain`, `resend.businessName`, `googleWorkspace.account`, `googleWorkspace.sharedFolder`

**Exit criteria**: Setup wizard offers plugin selection. `hive.yaml.example` documents all new config fields.

---

## Dependencies

| Phase | Depends On | Notes |
|-------|-----------|-------|
| Phase 1 (Infrastructure) | Nothing | Can start immediately |
| Phase 2 (Agent Runner) | Phase 1 | Needs types and plugin-loader |
| Phase 3 (Template Generator) | Phase 1 | Needs config.plugins |
| Phase 4 (Move Code) | Phases 1-3 | Plugin discovery must work before files move |
| Phase 5 (Build System) | Phase 4 | Needs plugin files in place to compile |
| Phase 6 (Wizard + Docs) | Phase 1 | Only needs config fields |

Phases 2 and 3 can run in parallel once Phase 1 is complete.
Phases 5 and 6 can run in parallel once Phase 4 is complete.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Import path breakage after MCP server move | Low | Medium | All 4 servers are self-contained (no `src/` imports), only use npm packages. Verify with `tsc` before committing. |
| Existing `hive.yaml` files missing `plugins` field | High | Low | Default to `[]`. Setup wizard adds field on next run. Existing DodiHome deploys need one-time `plugins: [dodi]` addition. |
| Agent templates reference MCP servers that become plugin-only | Medium | Medium | Agent.yaml `servers` list is just names -- resolution is the runner's job. If plugin not loaded, server is simply unavailable (agent still starts, just without that tool). |
| `tsconfig.json` dual rootDir complexity | Medium | Medium | Use separate `tsconfig.plugins.json` with its own rootDir/outDir rather than fighting single-project constraints. |
| Deploy script misses plugin dist artifacts | Low | High | Deploy script does full `npm run build` and rsync of `dist/`. Plugin output lands in `dist/plugins/` so it is included automatically. |
| `agent-env` resolution from unknown fields | Low | Low | Unknown `agentConfig` fields default to empty string. Plugin authors responsible for documenting required agent.yaml fields. |

## Verification Summary

1. `npm run build` compiles core + plugins without errors
2. No DodiHome server registrations remain in `src/agents/agent-runner.ts`
3. `npm run setup:agents` generates `chief-of-staff` from core, 9 from dodi plugin
4. `plugins: [dodi]` -> everything works identically to today
5. `plugins: []` -> clean platform, only `chief-of-staff`
6. No hardcoded `dodihome` references in `src/` (grep -ri dodihome src/ returns nothing)
