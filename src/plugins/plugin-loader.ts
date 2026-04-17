import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import type { LoadedPlugin, PluginManifest } from "./types.js";
import { HIVE_PLUGIN_API_VERSION } from "./api-version.js";

const log = createLogger("plugin-loader");

export function loadPlugins(pluginNames: string[], rootDir: string): LoadedPlugin[] {
  const plugins: LoadedPlugin[] = [];

  for (const name of pluginNames) {
    // Dual-path resolution: npm-installed (node_modules/) first, in-tree fallback second
    const npmDir = resolve(rootDir, "plugins", "node_modules", name);
    const inTreeDir = resolve(rootDir, "plugins", name);
    const npmManifest = join(npmDir, "plugin.yaml");
    const inTreeManifest = join(inTreeDir, "plugin.yaml");

    let pluginDir: string;
    if (existsSync(npmManifest)) {
      pluginDir = npmDir;
    } else if (existsSync(inTreeManifest)) {
      pluginDir = inTreeDir;
    } else {
      log.warn("Plugin manifest not found, skipping", {
        plugin: name,
        tried: [npmManifest, inTreeManifest],
      });
      continue;
    }

    const manifestPath = join(pluginDir, "plugin.yaml");
    const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
    const manifest = normalizeManifest(raw);

    if (manifest.hiveApi) {
      const compatible = isHiveApiCompatible(manifest.hiveApi, HIVE_PLUGIN_API_VERSION);
      if (!compatible) {
        log.warn("Plugin declares incompatible hiveApi range, skipping", {
          plugin: name,
          requires: manifest.hiveApi,
          running: HIVE_PLUGIN_API_VERSION,
        });
        continue;
      }
    }

    for (const [serverName, serverDef] of Object.entries(manifest.mcpServers)) {
      const entryPath = join(pluginDir, serverDef.entry);
      if (!existsSync(entryPath)) {
        log.warn("Plugin MCP server entry not found", {
          plugin: name,
          server: serverName,
          entry: entryPath,
        });
      }
    }

    for (const seed of manifest.agentSeeds) {
      const seedPath = join(pluginDir, "agent-seeds", seed);
      if (!existsSync(seedPath)) {
        log.warn("Plugin agent seed not found", { plugin: name, seed, path: seedPath });
      }
    }

    plugins.push({ name, dir: pluginDir, manifest });
    log.info("Plugin loaded", {
      plugin: name,
      mcpServers: Object.keys(manifest.mcpServers),
      seeds: manifest.agentSeeds,
    });
  }

  return plugins;
}

/**
 * Minimal semver range check. Supports caret ranges ("^1.0.0") and exact
 * versions ("1.0.0"). Anything else is treated as accept-any with a warn.
 */
export function isHiveApiCompatible(range: string, version: string): boolean {
  const trimmed = range.trim();
  if (trimmed === version) return true;
  if (trimmed.startsWith("^")) {
    const want = trimmed.slice(1).split(".").map(Number);
    const have = version.split(".").map(Number);
    if (want.length < 1 || have.length < 1) return false;
    if (want[0] !== have[0]) return false;
    if ((have[1] ?? 0) < (want[1] ?? 0)) return false;
    if ((have[1] ?? 0) === (want[1] ?? 0) && (have[2] ?? 0) < (want[2] ?? 0)) return false;
    return true;
  }
  log.warn("Unrecognized hiveApi range syntax, accepting", { range });
  return true;
}

export function normalizeManifest(raw: any): PluginManifest {
  return {
    name: raw.name ?? "",
    description: raw.description ?? "",
    hiveApi: raw.hiveApi ?? raw["hive-api"] ?? undefined,
    mcpServers: Object.fromEntries(
      Object.entries(raw["mcp-servers"] ?? {}).map(([k, v]: [string, any]) => [
        k,
        {
          entry: v.entry,
          description: v.description,
          usage: v.usage,
          notFor: v["not-for"],
          env: v.env ?? [],
          envMap: v["env-map"] ?? {},
          agentEnv: v["agent-env"] ?? {},
        },
      ]),
    ),
    agentSeeds: raw["agent-seeds"] ?? raw["agents-templates"] ?? [],
    registerCommands: raw["register-commands"] ?? undefined,
  };
}

export async function registerPluginCommands(
  plugins: LoadedPlugin[],
  registry: import("../team/command-registry.js").CommandRegistry,
): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.manifest.registerCommands) continue;
    try {
      const modulePath = resolve(plugin.dir, "dist", plugin.manifest.registerCommands);
      const mod = await import(modulePath);
      if (typeof mod.registerCommands === "function") {
        mod.registerCommands(registry);
        log.info("Plugin commands registered", { plugin: plugin.name });
      }
    } catch (err) {
      log.warn("Failed to load plugin commands", { plugin: plugin.name, error: String(err) });
    }
  }
}
