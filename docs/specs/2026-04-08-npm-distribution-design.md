# Hive npm Distribution

**Date**: 2026-04-08
**Status**: Reviewed
**Scope**: Package Hive as `@keepur/hive` on npm — closed-source, minified, CLI-driven install

## Problem

Hive is distributed by giving people access to the git repo. This exposes all source code and requires users to clone, install deps, and build from source. We're preparing to give customers preview access — they need a clean install experience with no source code visibility.

## Goals

1. **No source code visible** — customers install a package, not a repo
2. **One-command install** — `npm i -g @keepur/hive` then `hive init`
3. **macOS only** — Mac Mini, LaunchAgent in GUI session
4. **Plugin separation** — core framework ships as `@keepur/hive`, business-specific plugins (dodi) stay private
5. **Full prereq management** — MongoDB, Ollama, Qdrant, local models all handled by the installer

## Non-Goals

- Linux/Windows support
- Bytenode/V8 bytecode (overkill for preview access — minified bundles are sufficient)
- Plugin marketplace or registry
- Auto-update daemon

## Design

### Package Structure

Published npm package (`@keepur/hive`):

```
@keepur/hive/
├── pkg/                         # Minified bundles (esbuild output, publish-ready)
│   ├── cli.min.js               # CLI entry point
│   ├── server.min.js            # Main Hive server
│   ├── mcp/                     # Built-in MCP server bundles (stdio subprocesses)
│   │   ├── memory.min.js
│   │   ├── structured-memory.min.js
│   │   ├── contacts.min.js
│   │   ├── admin.min.js
│   │   ├── callback.min.js
│   │   ├── schedule.min.js
│   │   ├── github-issues.min.js
│   │   ├── linear.min.js
│   │   ├── clickup.min.js
│   │   ├── google.min.js
│   │   ├── keychain.min.js
│   │   ├── quo.min.js
│   │   ├── resend.min.js
│   │   ├── search-conversation.min.js
│   │   ├── background-task.min.js
│   │   ├── recall.min.js
│   │   ├── task.min.js
│   │   ├── event-bus.min.js
│   │   ├── team.min.js
│   │   ├── code-search.min.js
│   │   ├── code-task.min.js
│   │   ├── workflow.min.js
│   │   └── voice.min.js
│   └── setup/                   # Setup wizard + prereqs (also minified)
│       ├── wizard.min.js
│       ├── install-prereqs.sh
│       └── slack-manifest.yaml
├── seeds/                       # Default agent seed (ships with core)
│   └── chief-of-staff/
│       ├── agent.yaml
│       └── system-prompt.md
├── templates/                   # Non-code assets (ship as-is)
│   └── constitution.md.tpl
├── package.json
└── README.md
```

**Note on MCP server types:**
- **stdio servers** (listed above) — bundled and shipped in `pkg/mcp/`. Spawned as Node subprocesses by the agent runner.
- **HTTP MCP servers** (Slack via `https://mcp.slack.com/mcp`) — configured at runtime with auth token, not bundled. No packaging needed.
- **npx-based servers** (Playwright via `npx @playwright/mcp`) — downloaded at runtime. Not bundled. Treated as optional — the agent runner already handles the `npx` invocation.
- **Third-party stdio servers** (`brave-search-mcp`) — listed as npm dependencies, resolved at runtime via `createRequire` (see Agent Runner Changes). Not bundled.
- **Plugin MCP servers** (crm-search, product-search, ops-search, hubspot-crm, dodi-ops, catalog, permits) — ship in their respective plugin packages, NOT in core.

**Why `pkg/` instead of `dist/`:** The `dist/` directory is the tsc output (unminified JS + source maps). The `pkg/` directory holds the publish-ready minified bundles. Only `pkg/` is listed in the `files` whitelist — `dist/` never ships. This prevents accidentally publishing readable source code.

### package.json Changes

```json
{
  "name": "@keepur/hive",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "hive": "pkg/cli.min.js"
  },
  "files": [
    "pkg/",
    "seeds/",
    "templates/"
  ],
  "engines": {
    "node": ">=22.0.0"
  }
}
```

Key: `"private": true` is removed. The `files` whitelist means npm only publishes `pkg/`, `seeds/`, and `templates/`. No `src/`, no `dist/`, no `plugins/`, no `tsconfig`, no tests. The `pkg/` directory contains only minified bundles — `dist/` (unminified tsc output) never ships.

### CLI Entry Point (`src/cli.ts`)

```
hive init              # Full setup wizard (prereqs + config)
hive start             # Foreground mode (Ctrl+C to stop)
hive start --daemon    # Install + start LaunchAgent
hive stop              # Stop LaunchAgent
hive status            # Health check — running? which agents loaded?
hive update            # stop → npm update -g @keepur/hive → restart
hive doctor            # Check prereqs, services, MongoDB, agent health
hive plugin add <pkg>  # npm install plugin package into ~/.hive/plugins/
hive plugin list       # List installed plugins
hive plugin remove     # Uninstall plugin
```

The CLI resolves the Hive home directory in this order:
1. `--config ./path` (explicit)
2. `./hive.yaml` in cwd (project-local)
3. `~/.hive/hive.yaml` (default)

### Hive Home Directory (`~/.hive/`)

Created by `hive init`. All instance state lives here:

```
~/.hive/
├── hive.yaml              # Instance config
├── .env                   # Secrets
├── plugins/               # Installed plugin packages
├── logs/                  # Service logs
├── service/               # Generated plists
│   ├── com.hive.<id>.agent.plist
│   ├── com.hive.<id>.rotate-logs.plist
│   └── rotate-logs.sh
└── data/                  # Local state (caches, etc.)
```

### Build Pipeline

Two-stage build, both in the dev repo:

**Stage 1: TypeScript compilation** (existing)
```
src/**/*.ts → tsc → dist/**/*.js
```

**Stage 2: Bundle + minify** (new)
```
dist/**/*.js → esbuild → pkg/**/*.min.js
```

Each entry point gets its own bundle, output to `pkg/` (not `dist/`). esbuild config:

```ts
// build/bundle.ts
import { build } from "esbuild";

const shared = {
  outdir: "pkg",
  outExtension: { ".js": ".min.js" },
  bundle: true,
  minify: true,
  platform: "node" as const,
  target: "node22",
  format: "esm" as const,
  external: [
    // Native modules — can't be bundled, require compilation on target machine
    "better-sqlite3",
    // Large SDKs with dynamic internals — keep as npm dependencies
    "mongodb",
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai/sdk",
    "@modelcontextprotocol/sdk",
    "@slack/socket-mode",
    "@slack/web-api",
    "@linear/sdk",
    "@qdrant/js-client-rest",
    // File-processing libs with complex internal asset loading
    "pdf-parse",
    "mammoth",
    "xlsx",
    // NOTE: @dodi-hq/fsm-persistence, @dodi-hq/task-core, @dodi-hq/workflow-core
    // are intentionally BUNDLED (not external) — they are pure JS and customers
    // won't have access to the private @dodi-hq npm scope. Bundling them into
    // workflow.min.js avoids install failures.
    // Third-party MCP servers (resolved via createRequire at runtime)
    "brave-search-mcp",
  ],
};

// CLI entry point — gets shebang banner
await build({
  ...shared,
  entryPoints: { "cli": "dist/cli.js" },
  banner: { js: "#!/usr/bin/env node" },
});

// Everything else — no shebang
await build({
  ...shared,
  entryPoints: {
    "server": "dist/index.js",
    // Each MCP server is a separate entry point (spawned as subprocess)
    "mcp/memory": "dist/memory-mcp-server.js",
    "mcp/contacts": "dist/contacts-mcp-server.js",
    "mcp/schedule": "dist/schedule/schedule-mcp-server.js",
    "mcp/workflow": "dist/workflow/workflow-mcp-server.js",
    "mcp/voice": "dist/voice/voice-mcp-server.js",
    // ... etc for each built-in MCP server (see Package Structure for full list)
    "setup/wizard": "dist/setup-wizard.js",
  },
});
```

**Externals strategy**: Anything with native bindings, dynamic `require()`, `__dirname`-relative asset loading, or complex internal file references stays external. These are listed as `dependencies` in `package.json` and npm installs them on the customer's machine. The minified bundles import them at runtime. Pure-JS deps like `dotenv`, `yaml`, `csv-parse`, `jsonwebtoken` are intentionally bundled (reduces install footprint). `ws` is bundled — its optional native addons (`bufferutil`, `utf-8-validate`) are not required. This list should be validated via test bundling — if a bundle fails to run, the missing external gets added.

### Prerequisites Installer

`hive init` runs a comprehensive prereqs check before the setup wizard. Expanded from today's `install-prereqs.sh`:

```
1. Xcode CLI Tools    — xcode-select --install (needed for native module compilation)
2. Homebrew           — install if missing
3. Node.js >= 22      — install/upgrade via brew
4. MongoDB            — brew install + brew services start
5. Ollama             — brew install + brew services start
6. Ollama models      — ollama pull bge-large, ollama pull qwen2.5:3b
7. Qdrant             — brew install + brew services start
8. gh CLI             — brew install (for GitHub Issues MCP)
```

Each step: check → install if missing → verify → report. The wizard continues even if optional deps (gh, Ollama, Qdrant) are skipped — they're only needed for specific MCP servers.

Required vs optional:
- **Required**: Homebrew, Node, MongoDB (core functionality)
- **Recommended**: Ollama + models, Qdrant (semantic search, memory recall)
- **Optional**: gh CLI, gog CLI (specific integrations)

### Plugin Distribution

Plugins are separate npm packages. Convention: `@keepur/hive-plugin-<name>`.

```bash
hive plugin add @keepur/hive-plugin-dodi    # npm install into ~/.hive/plugins/
hive plugin add @acme/hive-plugin-custom    # third-party plugins work too
```

Plugin package structure:
```
@keepur/hive-plugin-dodi/
├── dist/
│   └── mcp/                # Minified MCP server bundles
│       ├── hubspot-crm.min.js
│       ├── dodi-ops.min.js
│       └── ...
├── agent-seeds/            # Agent seed YAML/MD files
│   ├── sdr/
│   ├── customer-success/
│   └── ...
├── plugin.yaml             # Plugin manifest (same format as today)
└── package.json
```

The existing `plugin.yaml` manifest format works as-is. The `entry` field in the manifest points to the minified bundle instead of the TypeScript source. Plugin MCP servers are spawned as subprocesses just like today — the only change is the file path resolution (from `~/.hive/plugins/` instead of `plugins/` in the repo).

### Agent Runner Changes

The agent runner (`src/agents/agent-runner.ts`) spawns MCP servers as child processes. Today it resolves all ~20 server paths relative to `process.cwd()` via `resolve("dist/...")`. This is a systematic refactor — every server definition in `buildAllServerConfigs` needs updating.

**Four categories of MCP server resolution:**

1. **Built-in stdio servers** (~23 servers): Resolve from the package's own `pkg/mcp/` directory using `import.meta.dirname`. This is the bulk of the work.
   ```ts
   // Before: resolve("dist/memory/memory-mcp-server.js")
   // After:  resolve(PKG_DIR, "mcp", "memory.min.js")
   const PKG_DIR = import.meta.dirname;  // already <package-root>/pkg/ since server.min.js lives there
   ```

2. **Plugin stdio servers**: Resolve from `~/.hive/plugins/<plugin-name>/dist/mcp/`
   ```ts
   const serverPath = resolve(HIVE_HOME, "plugins", pluginName, "dist", "mcp", serverEntry);
   ```

3. **Third-party npm servers** (`brave-search-mcp`): Use `createRequire` to resolve from the package's own `node_modules`, which works regardless of global vs local install.
   ```ts
   import { createRequire } from "node:module";
   const require = createRequire(import.meta.url);
   const bravePath = require.resolve("brave-search-mcp/dist/index.js");
   ```

4. **HTTP and npx-based servers** (Slack MCP, Playwright): No path resolution needed — these are configured with URLs or `npx` commands at runtime. No changes required.

### Config Loading Changes

`src/config.ts` currently loads `.env` and `hive.yaml` from the working directory, with `HIVE_CONFIG` env var supporting multi-instance (e.g., `HIVE_CONFIG=hive-personal.yaml` → loads `.env-personal`). The new `HIVE_HOME` model needs to coexist with this.

**Resolution rules:**

```ts
// 1. HIVE_HOME env var (explicit) — always wins if set
// 2. ./hive.yaml in cwd (project-local / dev repo mode)
// 3. ~/.hive/ (default for npm installs)
const hiveHome = process.env.HIVE_HOME
  ?? (existsSync("./hive.yaml") ? process.cwd() : resolve(home, ".hive"));

// Within a home directory, HIVE_CONFIG still works for multi-instance:
//   HIVE_HOME=~/.hive HIVE_CONFIG=hive-personal.yaml
//   → loads ~/.hive/hive-personal.yaml + ~/.hive/.env-personal
const configFile = process.env.HIVE_CONFIG ?? "hive.yaml";
const hiveConfigPath = resolve(hiveHome, configFile);
const dotenvSuffix = configFile.match(/^hive-(.+)\.yaml$/)?.[1];
const dotenvPath = resolve(hiveHome, dotenvSuffix ? `.env-${dotenvSuffix}` : ".env");
```

This preserves backward compatibility: existing deploys with `HIVE_CONFIG` still work. New npm installs use `HIVE_HOME` (defaulting to `~/.hive/`). Both can be combined for multi-instance npm installs.

### Setup Wizard Changes

The wizard today writes to the repo root. In the npm distribution, it writes to `~/.hive/`:

- Decouple from `ROOT = resolve(import.meta.dirname, "..")` assumption
- Accept `hiveHome` as parameter (defaults to `~/.hive/`)
- Templates (constitution, slack manifest) resolved from the package's `templates/` dir
- Generated plists go to `~/.hive/service/` and symlinked to `~/Library/LaunchAgents/`

The wizard flow stays the same. The only change is where files are read from (package) and written to (`~/.hive/`).

### LaunchAgent (Daemon Mode)

`hive start --daemon` generates and installs a LaunchAgent plist:

```xml
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hive.{id}.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/opt/homebrew/lib/node_modules/@keepur/hive/pkg/server.min.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/username/.hive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HIVE_HOME</key>
    <string>/Users/username/.hive</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  ...
</dict>
</plist>
```

**Important**: launchd does not expand `~` in any plist field. All paths must be fully resolved absolute paths. The plist generator resolves `node` path via `which node`, the package path via `npm root -g`, and `HIVE_HOME` via `os.homedir()` at generation time.

The plist points to the globally-installed package's `server.min.js`. `hive update` stops the service → runs `npm update -g @keepur/hive` → restarts. No hot-swap — clean stop/start to avoid split-brain with in-flight MCP server subprocesses.

### Publish Pipeline

Manual for now (no CI):

```bash
# In the dev repo:
npm run build           # Stage 1: tsc → dist/
npm run bundle          # Stage 2: esbuild minify → pkg/
npm pack --dry-run      # Verify what ships (only pkg/, seeds/, templates/)
npm publish             # Publish to npm as @keepur/hive
```

The `prepare` script in package.json gates unauthorized publishes (same pattern Claude Code uses). Only publish from the dev machine or a trusted CI job.

### Migration Path

For existing Hive deploys (your own infrastructure):

1. **No change required** — the dev repo still works exactly as before (`npm run dev`, `npm run build`, deploy.sh)
2. The npm package is an additional distribution channel, not a replacement
3. `package.json` loses `"private": true` and gains `bin`/`files` fields — these don't affect dev workflow
4. The new `src/cli.ts` and `build/bundle.ts` are additive — they don't touch existing code

## Implementation Sequence

1. **CLI entry point** — `src/cli.ts` with subcommands (init, start, stop, status, update, plugin)
2. **Hive home directory** — config resolution changes in `src/config.ts`, path resolution in agent-runner
3. **Expanded prereqs** — Ollama, Qdrant, model pulls added to installer
4. **esbuild pipeline** — `build/bundle.ts`, npm scripts, minified output
5. **package.json for publish** — name, bin, files, engines, remove private
6. **Setup wizard decoupling** — write to `~/.hive/` instead of repo root, convert all `execSync` → `execFileSync` (DOD-212)
7. **Plugin CLI** — `hive plugin add/list/remove`
8. **Dry-run publish** — `npm pack --dry-run`, verify contents, test install on a clean machine

## Implementation Notes (from spec review)

### MCP Server Path Resolution is a Systematic Refactor

The agent runner has ~20 `resolve("dist/...")` calls that resolve relative to `process.cwd()`. In a globally-installed npm package, cwd is wherever the user ran the command — not the package directory. Every built-in MCP server definition in `buildAllServerConfigs` needs to anchor to the package install location via `import.meta.dirname`. This is not two code changes — it's a pass across the entire file.

Additionally, `brave-search-mcp` is resolved from `node_modules/brave-search-mcp/dist/index.js` (a path that won't exist in global installs) and Playwright MCP uses `npx @playwright/mcp@latest` (runtime download). Both need explicit handling.

### esbuild Externals Need an Audit

The spec lists a few obvious externals (mongodb, better-sqlite3, SDK packages). The full list is broader — any dep that uses `__dirname`-relative asset loading, dynamic `require()`, or native bindings will break when bundled. Specific concerns:
- `@modelcontextprotocol/sdk` — used by every MCP server, should be external
- `@linear/sdk` — large, used only by linear MCP server
- `pdf-parse`, `mammoth`, `xlsx` — complex internal file references
- `@qdrant/js-client-rest` — REST client, probably bundleable but large

This requires an audit pass as part of the esbuild pipeline work.

### Plist Tilde Expansion

launchd does not expand `~` in `WorkingDirectory` or `EnvironmentVariables`. All plist paths must use fully resolved absolute paths (e.g., `/Users/username/.hive`). The existing `generate-plist.ts` handles this correctly — the new plist generation must follow the same pattern.

### Setup Wizard Cleanup

Several items need fixing in the wizard for npm distribution:
- `execSync(shellString)` calls violate DOD-212 — must convert to `execFileSync(binary, argsArray)` before shipping to customers
- `isAgentDone()` checks for `agents/chief-of-staff/agent.yaml` on the filesystem — agents are in MongoDB now, need a MongoDB check instead
- Agent seeding currently imports from `plugins/dodi/agent-seeds/` — core package needs its own default agent seed (chief-of-staff) that ships independently of any plugin

### Native Module Prerequisites

`better-sqlite3` requires `node-gyp` compilation on install, which means **Xcode Command Line Tools** is a prerequisite. The prereqs installer should check for this (`xcode-select -p`).

### Config Model Merge

The existing `HIVE_CONFIG` env var (drives `.env-personal` / `.env-<suffix>` split for multi-instance) needs to coexist with the new `HIVE_HOME` model. The spec's resolution order should explicitly handle the case where both are set.

### Graceful Update

`hive update` replaces the package in-place while MCP server subprocesses may be running from the old files. The update command should: stop the service → update → restart. Not attempt a hot-swap.

### Default Agent Seed

The core package ships with one default agent seed: chief-of-staff. This is the minimum viable agent for a fresh install. Plugin agent seeds (sdr, customer-success, etc.) come with their respective plugin packages.

## Resolved Questions

1. **npm org**: `@keepur` — confirmed.
2. **Version strategy**: TBD — decide before first publish.
3. **Plugin publish**: `@keepur/hive-plugin-dodi` stays private (never on public npm). Internal deploys continue using the git repo directly.
