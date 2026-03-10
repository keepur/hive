# Plugin Architecture -- Implementation Specs

## 1. Plugin Manifest Schema

### File: `plugins/<name>/plugin.yaml`

```yaml
name: dodi
description: DodiHome cabinet manufacturing integrations
mcp-servers:
  hubspot-crm:
    entry: mcp-servers/hubspot-crm/hubspot-crm-mcp-server.ts
    env: [HUBSPOT_API_KEY]
  dodi-ops:
    entry: mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
    env: [DODI_OPS_API_URL, DODI_OPS_API_KEY]
    agent-env:
      DODI_OPS_MODE: dodiOpsMode
      DODI_OPS_AGENT_ID: id
  catalog:
    entry: mcp-servers/catalog/catalog-mcp-server.ts
    env: [CATALOG_API_URL, CATALOG_API_KEY]
  permits:
    entry: mcp-servers/permits/permit-mcp-server.ts
    env: [PERMITS_MONGO_URI]
agents-templates:
  - sdr
  - customer-success
  - marketing-manager
  - executive-assistant
  - product-manager
  - product-specialist
  - vp-engineering
  - devops
  - production-support
```

### TypeScript Interfaces

```typescript
// src/plugins/types.ts

export interface PluginMcpServer {
  entry: string;           // path to .ts entry point, relative to plugin root
  env?: string[];          // required process.env var names (validation + passthrough)
  agentEnv?: Record<string, string>;  // maps ENV_VAR -> agentConfig field name
}

export interface PluginManifest {
  name: string;
  description?: string;
  mcpServers: Record<string, PluginMcpServer>;  // server-name -> config
  agentsTemplates: string[];                     // template directory names
}

export interface LoadedPlugin {
  name: string;
  dir: string;             // absolute path to plugin root
  manifest: PluginManifest;
}
```

---

## 2. Files to Create

### 2.1 `src/plugins/types.ts`

TypeScript types as shown above. Pure type definitions, no runtime code.

### 2.2 `src/plugins/plugin-loader.ts`

Responsible for discovering and loading enabled plugins.

```typescript
// src/plugins/plugin-loader.ts

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import type { LoadedPlugin, PluginManifest } from "./types.js";

const log = createLogger("plugin-loader");

/**
 * Load all enabled plugins.
 * @param pluginNames - plugin names from hive.yaml `plugins` array
 * @param rootDir - project root (where plugins/ lives)
 * @returns array of loaded plugins with validated manifests
 */
export function loadPlugins(pluginNames: string[], rootDir: string): LoadedPlugin[] {
  const plugins: LoadedPlugin[] = [];

  for (const name of pluginNames) {
    const pluginDir = resolve(rootDir, "plugins", name);
    const manifestPath = join(pluginDir, "plugin.yaml");

    if (!existsSync(manifestPath)) {
      log.warn("Plugin manifest not found, skipping", { plugin: name, path: manifestPath });
      continue;
    }

    const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
    const manifest = normalizeManifest(raw);

    // Validate: check that declared MCP server entry points exist
    for (const [serverName, serverDef] of Object.entries(manifest.mcpServers)) {
      const entryPath = join(pluginDir, serverDef.entry);
      if (!existsSync(entryPath)) {
        log.warn("Plugin MCP server entry not found", {
          plugin: name, server: serverName, entry: entryPath,
        });
      }
    }

    // Validate: check that declared agent template dirs exist
    for (const tpl of manifest.agentsTemplates) {
      const tplDir = join(pluginDir, "agents-templates", tpl);
      if (!existsSync(tplDir)) {
        log.warn("Plugin agent template not found", { plugin: name, template: tpl, path: tplDir });
      }
    }

    plugins.push({ name, dir: pluginDir, manifest });
    log.info("Plugin loaded", {
      plugin: name,
      mcpServers: Object.keys(manifest.mcpServers),
      templates: manifest.agentsTemplates,
    });
  }

  return plugins;
}

function normalizeManifest(raw: any): PluginManifest {
  return {
    name: raw.name ?? "",
    description: raw.description ?? "",
    mcpServers: Object.fromEntries(
      Object.entries(raw["mcp-servers"] ?? {}).map(([k, v]: [string, any]) => [
        k,
        {
          entry: v.entry,
          env: v.env ?? [],
          agentEnv: v["agent-env"] ?? {},
        },
      ]),
    ),
    agentsTemplates: raw["agents-templates"] ?? [],
  };
}
```

### 2.3 `plugins/dodi/plugin.yaml`

The DodiHome plugin manifest (exact content shown in Section 1).

### 2.4 `tsconfig.plugins.json`

Separate TypeScript config for compiling plugin MCP servers.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist/plugins",
    "rootDir": "plugins",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["plugins/*/mcp-servers/**/*.ts"],
  "exclude": ["node_modules"]
}
```

This compiles `plugins/dodi/mcp-servers/hubspot-crm/hubspot-crm-mcp-server.ts` to `dist/plugins/dodi/mcp-servers/hubspot-crm/hubspot-crm-mcp-server.js`.

---

## 3. Files to Modify

### 3.1 `src/config.ts`

**Changes:**

1. Add `plugins` config field (after `agents` block, around line 93):
```typescript
plugins: (hive.plugins ?? []) as string[],
```

2. Add `slack.auditChannel` (inside existing `slack` block, after line 51):
```typescript
slack: {
  // ... existing fields ...
  auditChannel: optional("SLACK_AUDIT_CHANNEL", hive.slack?.auditChannel ?? ""),
},
```

3. Add `resend.emailDomain` and `resend.businessName` (inside existing `resend` block, after line 114):
```typescript
resend: {
  // ... existing fields ...
  emailDomain: optional("RESEND_EMAIL_DOMAIN", hive.resend?.emailDomain ?? ""),
  businessName: optional("RESEND_BUSINESS_NAME", hive.resend?.businessName ?? ""),
},
```

4. Change GWS defaults to empty strings (lines 98 and 100):
```typescript
googleWorkspace: {
  account: optional("GWS_ACCOUNT", hive.googleWorkspace?.account ?? ""),      // was "bot@dodihome.com"
  gwsPath: optional("GWS_PATH", ""),
  sharedFolder: optional("GWS_SHARED_FOLDER", hive.googleWorkspace?.sharedFolder ?? ""),  // was hardcoded folder ID
},
```

DodiHome's `hive.yaml` will set:
```yaml
googleWorkspace:
  account: bot@dodihome.com
  sharedFolder: 149-loWJnUWfJP6rEAsuFoYsI2pS1JjRM

slack:
  auditChannel: jessica

resend:
  emailDomain: dodihome.com
  businessName: DodiHome
```

### 3.2 `src/index.ts`

**Lines 147-157** -- Replace hardcoded `"jessica"` with configurable audit channel:

```typescript
// Before (lines 147-157):
try {
  const channels = await slack.client.conversations.list({ types: "public_channel", limit: 200 });
  const jessicaCh = (channels.channels ?? []).find((c: any) => c.name === "jessica");
  if (jessicaCh?.id) {
    dispatcher.setAuditChannel(slackAdapter, jessicaCh.id);
    log.info("Audit channel configured", { channel: "jessica", id: jessicaCh.id });
  }
} catch (err) {
  log.warn("Failed to configure audit channel", { error: String(err) });
}

// After:
const auditChannelName = config.slack.auditChannel;
if (auditChannelName) {
  try {
    const channels = await slack.client.conversations.list({ types: "public_channel", limit: 200 });
    const auditCh = (channels.channels ?? []).find((c: any) => c.name === auditChannelName);
    if (auditCh?.id) {
      dispatcher.setAuditChannel(slackAdapter, auditCh.id);
      log.info("Audit channel configured", { channel: auditChannelName, id: auditCh.id });
    }
  } catch (err) {
    log.warn("Failed to configure audit channel", { error: String(err) });
  }
}
```

### 3.3 `src/agents/agent-runner.ts`

Two changes:

**Change 1: Fix hardcoded email domain (line 197)**

```typescript
// Before (line 197):
const agentFromAddress = `${this.agentConfig.name} (DodiHome) <${agentName}@dodihome.com>`;

// After:
const emailDomain = config.resend.emailDomain;
const businessLabel = config.resend.businessName ? ` (${config.resend.businessName})` : "";
const agentFromAddress = emailDomain
  ? `${this.agentConfig.name}${businessLabel} <${agentName}@${emailDomain}>`
  : config.resend.fromAddress;
```

**Change 2: Remove DodiHome server blocks (lines 322-371), add plugin injection**

Remove the 4 hardcoded DodiHome server blocks:
- Lines 322-331: `hubspot-crm` server
- Lines 333-348: `dodi-ops` server
- Lines 350-361: `catalog` server
- Lines 363-371: `permits` server

Replace with plugin injection (inserted after core servers, before the guardrail filter at line 384):

```typescript
// Plugin servers
for (const plugin of this.plugins) {
  for (const [name, serverDef] of Object.entries(plugin.manifest.mcpServers)) {
    if (servers[name]) {
      log.warn("Plugin server name conflicts with core server, skipping", {
        plugin: plugin.name, server: name,
      });
      continue;
    }
    const compiledPath = resolve(
      `dist/plugins/${plugin.name}/${serverDef.entry.replace(/\.ts$/, ".js")}`,
    );

    // Build env: process.env vars from env list + agent-env mappings
    const env: Record<string, string> = {
      AGENT_ID: this.agentConfig.id,
      AGENT_NAME: this.agentConfig.name,
      MONGODB_URI: config.mongo.uri,
      MONGODB_DB: config.mongo.dbName,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };

    // Pass declared process.env vars
    for (const envVar of serverDef.env ?? []) {
      if (process.env[envVar]) env[envVar] = process.env[envVar]!;
    }

    // Resolve agent-env mappings: ENV_VAR -> agentConfig[fieldName]
    for (const [envVar, fieldName] of Object.entries(serverDef.agentEnv ?? {})) {
      env[envVar] = String((this.agentConfig as any)[fieldName] ?? "");
    }

    servers[name] = {
      type: "stdio",
      command: "node",
      args: [compiledPath],
      env,
    };
  }
}
```

**Change 3: Accept plugins in constructor**

```typescript
// Before (line 41):
constructor(agentConfig: AgentConfig, memoryManager: MemoryManager) {

// After:
private plugins: LoadedPlugin[];

constructor(agentConfig: AgentConfig, memoryManager: MemoryManager, plugins: LoadedPlugin[] = []) {
  this.agentConfig = agentConfig;
  this.memoryManager = memoryManager;
  this.plugins = plugins;
}
```

Add import at top:
```typescript
import type { LoadedPlugin } from "../plugins/types.js";
```

### 3.4 `src/agents/agent-manager.ts`

**Change 1: Load plugins once at construction**

```typescript
import { loadPlugins } from "../plugins/plugin-loader.js";
import type { LoadedPlugin } from "../plugins/types.js";

export class AgentManager {
  // ... existing fields ...
  private plugins: LoadedPlugin[];

  constructor(registry: AgentRegistry, memoryManager: MemoryManager, sessionStore: SessionStore) {
    this.registry = registry;
    this.memoryManager = memoryManager;
    this.sessionStore = sessionStore;
    this.plugins = loadPlugins(config.plugins, process.cwd());
  }
```

Note: `config.plugins` comes from the existing `config` import (line 11: `import { config as appConfig } from "../config.js"`). After adding `plugins` to config, this becomes `appConfig.plugins`.

**Change 2: Pass plugins to AgentRunner (line 41)**

```typescript
// Before:
return new AgentRunner(config, this.memoryManager);

// After:
return new AgentRunner(config, this.memoryManager, this.plugins);
```

### 3.5 `setup/generate-agents.ts`

**Lines 96-99** -- After reading core templates, also read plugin templates:

```typescript
// Before (lines 96-100):
const agents = readdirSync(TEMPLATES_DIR).filter((d) =>
  statSync(join(TEMPLATES_DIR, d)).isDirectory(),
);

for (const agentId of agents) {
  const templateDir = join(TEMPLATES_DIR, agentId);

// After:
// Core templates
const coreAgents = readdirSync(TEMPLATES_DIR).filter((d) =>
  statSync(join(TEMPLATES_DIR, d)).isDirectory(),
);

// Plugin templates (from enabled plugins in hive.yaml)
const enabledPlugins: string[] = config.plugins ?? [];
const pluginAgents: Array<{ id: string; templateDir: string }> = [];

for (const pluginName of enabledPlugins) {
  const pluginTemplatesDir = join(ROOT, "plugins", pluginName, "agents-templates");
  if (!existsSync(pluginTemplatesDir)) continue;
  const templates = readdirSync(pluginTemplatesDir).filter((d) =>
    statSync(join(pluginTemplatesDir, d)).isDirectory(),
  );
  for (const t of templates) {
    // Core wins on name conflicts
    if (coreAgents.includes(t)) {
      console.log(`  SKIP plugin/${pluginName}/${t} (conflicts with core template)`);
      continue;
    }
    pluginAgents.push({ id: t, templateDir: join(pluginTemplatesDir, t) });
  }
}

// Merge: core uses TEMPLATES_DIR, plugin uses own dir
const allAgents = [
  ...coreAgents.map(id => ({ id, templateDir: join(TEMPLATES_DIR, id) })),
  ...pluginAgents,
];

for (const { id: agentId, templateDir } of allAgents) {
```

Then replace `join(TEMPLATES_DIR, agentId)` references inside the loop with the `templateDir` variable from the iteration.

### 3.6 `setup/setup-wizard.ts`

Add a plugin selection section after the Optional Integrations section (around line 345, before Agent Setup):

```typescript
// ── Plugin Selection ──────────────────────────────────────────
section("Plugins");

const pluginsDir = join(ROOT, "plugins");
if (existsSync(pluginsDir)) {
  const available = readdirSync(pluginsDir).filter((d) => {
    return existsSync(join(pluginsDir, d, "plugin.yaml"));
  });

  if (available.length > 0) {
    console.log("Available plugins:\n");
    for (const p of available) {
      const manifest = parseYaml(readFileSync(join(pluginsDir, p, "plugin.yaml"), "utf-8"));
      console.log(`  ${p} -- ${manifest.description ?? "(no description)"}`);
    }
    console.log("");

    const current = (hive.plugins ?? []).join(", ") || "none";
    const selected = await ask(
      "Which plugins to enable? (comma-separated, or 'none')",
      current,
    );
    if (selected.toLowerCase() !== "none") {
      hive.plugins = selected.split(",").map((s: string) => s.trim()).filter(Boolean);
    } else {
      hive.plugins = [];
    }
  } else {
    console.log("No plugins found in plugins/ directory.");
    hive.plugins = [];
  }
} else {
  console.log("No plugins/ directory found.");
  hive.plugins = [];
}

saveHiveYaml(hive);
```

### 3.7 `package.json`

**Build script update (line 7):**

```json
{
  "scripts": {
    "build": "tsc && tsc -p tsconfig.plugins.json",
    "build:plugins": "tsc -p tsconfig.plugins.json"
  }
}
```

The `tsc -p tsconfig.plugins.json` step is a no-op if no plugin TypeScript files exist.

---

## 4. Files to Move (git mv)

### MCP Servers

| Current Location | New Location |
|-----------------|-------------|
| `src/hubspot/hubspot-crm-mcp-server.ts` | `plugins/dodi/mcp-servers/hubspot-crm/hubspot-crm-mcp-server.ts` |
| `src/hubspot/hubspot-api-client.ts` | `plugins/dodi/mcp-servers/hubspot-crm/hubspot-api-client.ts` |
| `src/dodi-ops/dodi-ops-mcp-server.ts` | `plugins/dodi/mcp-servers/dodi-ops/dodi-ops-mcp-server.ts` |
| `src/catalog/catalog-mcp-server.ts` | `plugins/dodi/mcp-servers/catalog/catalog-mcp-server.ts` |
| `src/permits/permit-mcp-server.ts` | `plugins/dodi/mcp-servers/permits/permit-mcp-server.ts` |

These servers are self-contained (no imports from `src/`). They import only from npm packages. No import path changes needed.

### Agent Templates

| Current Location | New Location |
|-----------------|-------------|
| `agents-templates/sdr/` | `plugins/dodi/agents-templates/sdr/` |
| `agents-templates/customer-success/` | `plugins/dodi/agents-templates/customer-success/` |
| `agents-templates/marketing-manager/` | `plugins/dodi/agents-templates/marketing-manager/` |
| `agents-templates/executive-assistant/` | `plugins/dodi/agents-templates/executive-assistant/` |
| `agents-templates/product-manager/` | `plugins/dodi/agents-templates/product-manager/` |
| `agents-templates/product-specialist/` | `plugins/dodi/agents-templates/product-specialist/` |
| `agents-templates/vp-engineering/` | `plugins/dodi/agents-templates/vp-engineering/` |
| `agents-templates/devops/` | `plugins/dodi/agents-templates/devops/` |
| `agents-templates/production-support/` | `plugins/dodi/agents-templates/production-support/` |

Only `agents-templates/chief-of-staff/` remains in core.

Agent templates are plain files (YAML, Markdown), not TypeScript. No compilation needed.

---

## 5. Agent-Env Strategy

The `dodi-ops` MCP server needs agent-specific env vars that come from `agentConfig` fields, not from `process.env`. For example, `DODI_OPS_MODE` comes from `agentConfig.dodiOpsMode`, and `DODI_OPS_AGENT_ID` comes from `agentConfig.id`.

The plugin manifest declares an `agent-env` mapping:

```yaml
mcp-servers:
  dodi-ops:
    entry: mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
    env: [DODI_OPS_API_URL, DODI_OPS_API_KEY]
    agent-env:
      DODI_OPS_MODE: dodiOpsMode
      DODI_OPS_AGENT_ID: id
```

At server build time, the agent-runner resolves each `agent-env` entry:

```typescript
for (const [envVar, fieldName] of Object.entries(serverDef.agentEnv ?? {})) {
  env[envVar] = String((this.agentConfig as any)[fieldName] ?? "");
}
```

- `DODI_OPS_MODE` -> looks up `agentConfig.dodiOpsMode` -> e.g., `"full"` or `"readonly"`
- `DODI_OPS_AGENT_ID` -> looks up `agentConfig.id` -> e.g., `"production-support"`
- Unknown fields -> empty string

For `env` list vars (`HUBSPOT_API_KEY`, `DODI_OPS_API_URL`, etc.), the loader passes them from `process.env`:

```typescript
for (const envVar of serverDef.env ?? []) {
  if (process.env[envVar]) env[envVar] = process.env[envVar]!;
}
```

---

## 6. Component Breakdown

### Plugin Loader (`src/plugins/plugin-loader.ts`)

- **Input**: plugin names from config, project root path.
- **Output**: array of `LoadedPlugin` objects with validated manifests.
- **Error handling**: missing manifest = warning + skip. Missing entry point = warning (server will fail at runtime if agent requests it).
- **Called by**: `AgentManager` constructor (once at startup), template generator.

### Agent Runner Plugin Integration (`src/agents/agent-runner.ts`)

- **Change scope**: constructor signature (accept `plugins`), `buildMcpServers()` method (remove DodiHome blocks, add plugin loop). No changes to `send()`, `buildSystemPrompt()`, or other methods.
- **Plugin servers receive**: standard base env (`AGENT_ID`, `AGENT_NAME`, `MONGODB_URI`, `MONGODB_DB`, `PATH`, `HOME`) + declared `env` vars from `process.env` + declared `agent-env` vars resolved from `agentConfig`.
- **Resolution**: plugin server compiled path = `dist/plugins/<name>/<entry with .ts replaced by .js>`.
- **Existing filter unchanged**: the `agent.yaml` `servers` allowlist (lines 384-392) continues to gate which servers an agent actually gets.

### Template Generator Plugin Integration (`setup/generate-agents.ts`)

- **Change scope**: template directory discovery loop (lines 96-100). Template rendering logic unchanged.
- **Plugin templates**: same format as core templates (agent.yaml, system-prompt.md, soul.md, etc.).
- **Conflict handling**: if a plugin template has the same name as a core template, log a warning and skip the plugin version. Core always wins.

### Setup Wizard Plugin Selection (`setup/setup-wizard.ts`)

- **Change scope**: add one new section between Optional Integrations and Agent Setup.
- **UI**: list available plugins with descriptions from manifests, accept comma-separated selection.
- **Storage**: `plugins` array in `hive.yaml`.

---

## 7. Testing Requirements

### Unit Tests

- **Plugin loader**: valid manifest parsing (including `agent-env`), missing manifest handling, missing entry point warning, empty plugins list.
- **Agent runner**: core servers unchanged when no plugins, plugin servers appear in available pool, name conflicts resolved (core wins), filter still works with plugin servers, `agent-env` resolution from `agentConfig`.
- **Template generator**: core-only when no plugins, core+plugin when enabled, conflict handling.

### Integration Tests

- **Fresh install**: `npm run setup` with no plugins -> only chief-of-staff generated. Start -> no DodiHome servers in logs.
- **DodiHome install**: `plugins: [dodi]` -> all 10 agents generated. Start -> all servers available. Agent requesting `hubspot-crm` gets it.
- **Plugin removal**: remove `dodi` from plugins list, restart -> DodiHome servers gone, agents requesting them get reduced server set.

### Manual Verification Checklist

- [ ] `npm run build` compiles core and plugin MCP servers without errors
- [ ] No DodiHome server registrations in `src/agents/agent-runner.ts` (lines 322-371 removed)
- [ ] `npm run setup:agents` generates `chief-of-staff` from core, 9 agents from dodi plugin
- [ ] `plugins: [dodi]` -> everything works identically to current behavior
- [ ] `plugins: []` -> clean platform, only `chief-of-staff`
- [ ] No hardcoded `dodihome` references in `src/` (grep confirms)
- [ ] Audit channel configurable via `hive.yaml` `slack.auditChannel`
- [ ] GWS account and shared folder default to empty strings
- [ ] Email from-address uses `config.resend.emailDomain` and `config.resend.businessName`
- [ ] Deploy script produces working build with plugins
