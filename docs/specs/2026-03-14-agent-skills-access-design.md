# Agent Skills Access

**Date**: 2026-03-14
**Status**: Draft

## Problem

Hive agents (chief-of-staff, vp-engineering, etc.) have no access to Claude Code skills/plugins during their sessions. Skills like `dodi-dev:brainstorm`, `dodi-dev:implement`, `/quality-gate`, etc. are only available in interactive Claude Code sessions, not in SDK-spawned agent sessions.

## Solution

Add a `plugins` field to `agent.yaml` (same pattern as the existing `servers` whitelist) and wire it through to the SDK's `query()` call via the `plugins` option.

### How It Works

1. **Hive-level plugin directory**: `plugins/claude-code/` (gitignored, like `agents/`)
2. **Agent declaration**: each `agent.yaml` lists which plugins it needs
3. **Agent runner**: reads the `plugins` list, resolves paths from `plugins/claude-code/`, passes them to the SDK as `SdkPluginConfig[]`
4. **Setup**: `npm run setup:agents` copies/symlinks plugins from the user's installed plugin cache into `plugins/claude-code/`
5. **Deploy**: `deploy.sh` syncs `plugins/claude-code/` from dev to the deploy dir

### agent.yaml Example

```yaml
name: VP Engineering
model: haiku
servers:
  - memory
  - github-issues
  - background
plugins:
  - dodi-dev
  - commit-commands
```

### Plugin Resolution

`plugins/claude-code/` mirrors the plugin cache structure:

```
plugins/claude-code/
├── dodi-dev/           # from ~/.claude/plugins/cache/dodi-skills/dodi-dev/<version>/
├── commit-commands/    # from ~/.claude/plugins/cache/dodi-skills/commit-commands/<version>/
└── ...
```

Each entry is a directory containing the plugin's skills, agents, etc. The SDK receives `{ type: 'local', path: '<absolute-path-to-plugin-dir>' }`.

## Changes

### 1. AgentConfig type (`src/types/agent-config.ts`)

Add `plugins?: string[]` field alongside `servers`.

### 2. AgentRunner (`src/agents/agent-runner.ts`)

- New method `buildPlugins()` that maps agent's `plugins` list → `SdkPluginConfig[]` by resolving against `plugins/claude-code/`
- Pass result into `query()` options

### 3. Agent generation (`setup/generate-agents.ts`)

- After generating agents, copy/symlink plugins from the user's installed plugin cache (`~/.claude/plugins/cache/`) into `plugins/claude-code/`
- Source paths: `~/.claude/plugins/cache/<source-repo>/<plugin-name>/<version>/`
- Need a mapping of plugin-name → cache location. This can be a simple config section in `hive.yaml` or auto-discovered from the cache directory.

### 4. Deploy script (`service/deploy.sh`)

Add `plugins/claude-code/` to the rsync alongside `agents/`:

```bash
rsync -a --delete plugins/claude-code/ "$DEPLOY_DIR/plugins/claude-code/"
```

### 5. .gitignore

Add `/plugins/claude-code/` (the directory is generated, not checked in).

### 6. Agent templates

Update relevant `agent.yaml` templates with their `plugins` lists.

## Plugin Source Mapping

The tricky part: knowing which cache path maps to which plugin name. Options:

**Option A — Explicit mapping in hive.yaml**:
```yaml
claude_plugins:
  dodi-dev: dodi-skills        # → ~/.claude/plugins/cache/dodi-skills/dodi-dev/<latest>/
  commit-commands: dodi-skills
```

**Option B — Scan the cache**: Walk `~/.claude/plugins/cache/*/` and build an index of all available plugins by directory name.

**Recommendation**: Option B (auto-scan). Less config, works as plugins are added/removed. Fall back to a warning if a plugin declared in `agent.yaml` isn't found in the cache.

## Guardrails

- **No plugins by default**: If `plugins` is omitted from `agent.yaml`, agent gets no plugins (same pattern as `servers` before it was added — backward compatible).
- **Missing plugin = warning, not crash**: If a declared plugin isn't found in `plugins/claude-code/`, log a warning and skip it. Agent still starts.
- **Plugin directory validation**: `setup:agents` should verify each plugin dir has at least a `skills/` subdirectory or a valid plugin manifest.

## Out of Scope

- Runtime plugin hot-reload (agents already get fresh config on next session)
- Per-skill granularity within a plugin (SDK doesn't support this — it's all-or-nothing per plugin)
- Plugin version pinning (use whatever version is in the cache)
