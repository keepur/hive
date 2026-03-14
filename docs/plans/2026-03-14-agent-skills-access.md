# Agent Skills Access — Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Give hive agents access to Claude Code plugins/skills via a `plugins` field in agent.yaml, with plugin resolution from a hive-level `plugins/claude-code/` directory.

**Architecture:** `setup:agents` scans `~/.claude/plugins/cache/` and copies plugins into `plugins/claude-code/`. Each agent's `agent.yaml` declares which plugins it needs. `AgentRunner` resolves those names to paths and passes them to the SDK's `query()` as `SdkPluginConfig[]`. `deploy.sh` rsyncs the directory to the deploy machine.

**Tech Stack:** TypeScript, Claude Agent SDK (`SdkPluginConfig`), Node.js fs APIs

---

### Task 1: Add `plugins` field to AgentConfig type

**Files:**
- Modify: `src/types/agent-config.ts:6-27`

- [ ] **Step 1:** Add `plugins?: string[]` to `AgentConfig` interface

```typescript
  servers?: string[]; // MCP server allowlist. Omit = all servers (backward compat)
  plugins?: string[]; // Claude Code plugin allowlist. Omit = no plugins
```

- [ ] **Step 2:** Add `plugins` to `ConfigOverride` interface (for runtime overrides via MongoDB)

```typescript
  servers?: ArrayOverride;
  plugins?: ArrayOverride;
```

- [ ] **Step 3:** Verify

Run: `npm run typecheck`
Expected: Clean pass (no existing code references `plugins` on AgentConfig yet)

- [ ] **Step 4:** Commit

```bash
git add src/types/agent-config.ts
git commit -m "feat: add plugins field to AgentConfig type"
```

---

### Task 2: Add plugin sync to `setup/generate-agents.ts`

**Files:**
- Modify: `setup/generate-agents.ts`

- [ ] **Step 1:** Add imports and constants at top of file

```typescript
import { cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";

const PLUGINS_DIR = join(ROOT, "plugins", "claude-code");
const PLUGIN_CACHE = join(homedir(), ".claude", "plugins", "cache");
```

- [ ] **Step 2:** Add `syncPlugins()` function before `main()`

This function scans the plugin cache, finds the latest version of each plugin, and copies it into `plugins/claude-code/`. "Latest" is determined by directory mtime (most recently modified).

```typescript
function syncPlugins(): void {
  // Collect all plugins declared in agent templates
  const declaredPlugins = new Set<string>();
  for (const { templateDir } of allAgents) {
    // Can't reference allAgents here — we'll call this after building allAgents
  }

  // Scan cache: cache/<source-repo>/<plugin-name>/<version>/
  if (!existsSync(PLUGIN_CACHE)) {
    console.log("\n  No plugin cache found — skipping plugin sync");
    return;
  }

  // Build index: plugin-name → latest cache path
  const pluginIndex = new Map<string, string>();
  const sourceRepos = readdirSync(PLUGIN_CACHE).filter((d) =>
    statSync(join(PLUGIN_CACHE, d)).isDirectory(),
  );

  for (const repo of sourceRepos) {
    const repoDir = join(PLUGIN_CACHE, repo);
    const plugins = readdirSync(repoDir).filter((d) =>
      statSync(join(repoDir, d)).isDirectory(),
    );

    for (const pluginName of plugins) {
      const pluginDir = join(repoDir, pluginName);
      const versions = readdirSync(pluginDir).filter((d) =>
        statSync(join(pluginDir, d)).isDirectory(),
      );

      if (versions.length === 0) continue;

      // Pick latest by mtime
      const latest = versions
        .map((v) => ({ v, mtime: statSync(join(pluginDir, v)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0]!;

      pluginIndex.set(pluginName, join(pluginDir, latest.v));
    }
  }

  // Ensure output dir exists
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  // Copy each indexed plugin into plugins/claude-code/<name>/
  let synced = 0;
  for (const [name, sourcePath] of pluginIndex) {
    const destPath = join(PLUGINS_DIR, name);

    // Remove existing copy and replace
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }

    cpSync(sourcePath, destPath, { recursive: true });
    console.log(`  SYNC plugin ${name} ← ${sourcePath}`);
    synced++;
  }

  console.log(`\n  ${synced} plugin(s) synced to plugins/claude-code/`);
}
```

- [ ] **Step 3:** Call `syncPlugins()` at the end of `main()`, after agent generation and before writing metadata

```typescript
  // Sync Claude Code plugins from cache
  syncPlugins();

  // Save metadata
  writeFileSync(META_FILE, JSON.stringify(newMeta, null, 2) + "\n");
```

- [ ] **Step 4:** Verify

Run: `npx tsx setup/generate-agents.ts`
Expected: See `SYNC plugin dodi-dev ← ...` lines and `plugins/claude-code/dodi-dev/` directory created

- [ ] **Step 5:** Commit

```bash
git add setup/generate-agents.ts
git commit -m "feat: sync Claude Code plugins from cache during agent setup"
```

---

### Task 3: Wire plugins into AgentRunner

**Files:**
- Modify: `src/agents/agent-runner.ts`

- [ ] **Step 1:** Import `SdkPluginConfig`, `existsSync` and add `resolve` for plugins dir

Add to existing imports:

```typescript
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
```

- [ ] **Step 2:** Add `buildSdkPlugins()` method to `AgentRunner` class (after `buildMcpServers`)

```typescript
  private buildSdkPlugins(): SdkPluginConfig[] {
    const pluginNames = this.agentConfig.plugins;
    if (!pluginNames?.length) return [];

    const sdkPlugins: SdkPluginConfig[] = [];
    const pluginsDir = resolve("plugins/claude-code");

    for (const name of pluginNames) {
      const pluginPath = resolve(pluginsDir, name);
      if (!existsSync(pluginPath)) {
        log.warn("Plugin not found, skipping", { plugin: name, expected: pluginPath, agent: this.agentConfig.id });
        continue;
      }
      sdkPlugins.push({ type: "local", path: pluginPath });
    }

    if (sdkPlugins.length > 0) {
      log.debug("Loaded plugins for agent", {
        agent: this.agentConfig.id,
        plugins: sdkPlugins.map((p) => p.path),
      });
    }

    return sdkPlugins;
  }
```

- [ ] **Step 3:** Pass plugins into `query()` call in `send()` method

In the `send()` method, after `const mcpServers = this.buildMcpServers(context);` add:

```typescript
    const sdkPlugins = this.buildSdkPlugins();
```

Then in the `query()` options object, add the plugins spread:

```typescript
        ...(sdkPlugins.length > 0 ? { plugins: sdkPlugins } : {}),
```

Place it after the `mcpServers` spread.

- [ ] **Step 4:** Verify

Run: `npm run typecheck`
Expected: Clean pass

- [ ] **Step 5:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat: wire Claude Code plugins into agent SDK sessions"
```

---

### Task 4: Handle plugins in agent config override system

**Files:**
- Modify: `src/agents/agent-registry.ts` (where ConfigOverride is applied)

- [ ] **Step 1:** Find where `servers` ArrayOverride is applied and add matching logic for `plugins`

Search for the existing `servers` override handling and replicate the pattern for `plugins`. The logic should handle `replace`, `add`, and `remove` operations on the `plugins` array, same as it does for `servers`.

- [ ] **Step 2:** Verify

Run: `npm run typecheck`
Expected: Clean pass

- [ ] **Step 3:** Commit

```bash
git add src/agents/agent-registry.ts
git commit -m "feat: support plugins field in agent config overrides"
```

---

### Task 5: Update deploy script

**Files:**
- Modify: `service/deploy.sh`

- [ ] **Step 1:** Add plugins/claude-code to backup step (step 8)

After the existing agents backup line:

```bash
run_cmd cp -a "$DEPLOY_DIR/plugins/claude-code" "$DEPLOY_DIR/plugins/claude-code.bak" 2>/dev/null || true
```

- [ ] **Step 2:** Add plugins/claude-code to rsync step (step 9)

After the existing agents rsync line:

```bash
run_cmd rsync -a --delete "$BUILD_DIR/plugins/claude-code/" "$DEPLOY_DIR/plugins/claude-code/"
```

- [ ] **Step 3:** Add plugins/claude-code to rollback function

After the agents rollback block:

```bash
  if [[ -d "$DEPLOY_DIR/plugins/claude-code.bak" ]]; then
    run_cmd rm -rf "$DEPLOY_DIR/plugins/claude-code"
    run_cmd mv "$DEPLOY_DIR/plugins/claude-code.bak" "$DEPLOY_DIR/plugins/claude-code"
  fi
```

- [ ] **Step 4:** Add plugins/claude-code.bak to cleanup step (step 13)

```bash
run_cmd rm -rf "$DEPLOY_DIR/dist.bak" "$DEPLOY_DIR/agents.bak" "$DEPLOY_DIR/plugins/claude-code.bak"
```

- [ ] **Step 5:** Commit

```bash
git add service/deploy.sh
git commit -m "feat: include plugins/claude-code in deploy pipeline"
```

---

### Task 6: Update .gitignore and agent templates

**Files:**
- Modify: `.gitignore`
- Modify: `agents-templates/*/agent.yaml.tpl` (all 10 templates)

- [ ] **Step 1:** Add `/plugins/claude-code/` to .gitignore

After the `/agents/` line:

```
/agents/
/plugins/claude-code/
```

- [ ] **Step 2:** Add `plugins` field to each agent.yaml.tpl

Every agent gets the `dodi-dev` plugin (universal workflow skills). Add after `servers:` block in each template:

```yaml
plugins:
  - dodi-dev
```

- [ ] **Step 3:** Verify

Run: `npx tsx setup/generate-agents.ts`
Expected: Generated agents include `plugins:` field, plugins/claude-code/ is populated

- [ ] **Step 4:** Commit

```bash
git add .gitignore agents-templates/
git commit -m "feat: add plugins field to all agent templates"
```
