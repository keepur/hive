#!/usr/bin/env npx tsx
/**
 * Sync Claude Code plugins from cache/marketplaces → plugins/claude-code/.
 *
 * Usage:
 *   npx tsx setup/generate-agents.ts
 */

import { existsSync, mkdirSync, readdirSync, statSync, cpSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");

const PLUGINS_DIR = join(ROOT, "plugins", "claude-code");
const PLUGIN_CACHE = join(homedir(), ".claude", "plugins", "cache");
const PLUGIN_MARKETPLACES = join(homedir(), ".claude", "plugins", "marketplaces");

function syncPlugins(): void {
  if (!existsSync(PLUGIN_CACHE) && !existsSync(PLUGIN_MARKETPLACES)) {
    console.log("\n  No plugin cache or marketplaces found — skipping plugin sync");
    return;
  }

  // Build index: plugin-name → source path (marketplaces take priority over cache)
  const pluginIndex = new Map<string, string>();

  // 1. Scan cache (versioned directories, pick latest by mtime)
  if (existsSync(PLUGIN_CACHE)) {
    const sourceRepos = readdirSync(PLUGIN_CACHE).filter((d) => statSync(join(PLUGIN_CACHE, d)).isDirectory());

    for (const repo of sourceRepos) {
      const repoDir = join(PLUGIN_CACHE, repo);
      const plugins = readdirSync(repoDir).filter((d) => statSync(join(repoDir, d)).isDirectory());

      for (const pluginName of plugins) {
        const pluginDir = join(repoDir, pluginName);
        const versions = readdirSync(pluginDir).filter((d) => statSync(join(pluginDir, d)).isDirectory());

        if (versions.length === 0) continue;

        // Pick latest by mtime
        const latest = versions
          .map((v) => ({ v, mtime: statSync(join(pluginDir, v)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0]!;

        pluginIndex.set(pluginName, join(pluginDir, latest.v));
      }
    }
  }

  // 2. Scan marketplaces (flat directories, override cache — always latest)
  if (existsSync(PLUGIN_MARKETPLACES)) {
    const marketplaces = readdirSync(PLUGIN_MARKETPLACES).filter((d) =>
      statSync(join(PLUGIN_MARKETPLACES, d)).isDirectory(),
    );

    for (const marketplace of marketplaces) {
      const marketplaceDir = join(PLUGIN_MARKETPLACES, marketplace);
      const plugins = readdirSync(marketplaceDir).filter((d) => statSync(join(marketplaceDir, d)).isDirectory());

      for (const pluginName of plugins) {
        if (pluginName.startsWith(".")) continue;
        const pluginPath = join(marketplaceDir, pluginName);
        // Only index if it looks like a plugin (has skills/ or .claude-plugin/)
        if (!existsSync(join(pluginPath, "skills")) && !existsSync(join(pluginPath, ".claude-plugin"))) continue;
        pluginIndex.set(pluginName, pluginPath);
      }
    }
  }

  // Ensure output dir exists
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  // Copy each indexed plugin into plugins/claude-code/<name>/
  let synced = 0;
  for (const [name, sourcePath] of pluginIndex) {
    // Validate: must contain skills/ dir or a manifest to be a real plugin
    const hasSkills = existsSync(join(sourcePath, "skills"));
    const hasManifest = existsSync(join(sourcePath, "plugin.json"));
    if (!hasSkills && !hasManifest) {
      console.log(`  SKIP plugin ${name} — no skills/ dir or plugin.json`);
      continue;
    }

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

function main() {
  syncPlugins();
}
main();
