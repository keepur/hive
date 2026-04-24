import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import type { BrokenServer, LoadedPlugin, PluginManifest } from "./types.js";
import { HIVE_PLUGIN_API_VERSION } from "./api-version.js";

const log = createLogger("plugin-loader");

/**
 * Options for locating compiled plugin entries. Plugins can arrive through
 * three channels; each has a different filesystem shape.
 *
 * Callers pass `distDir` so this module stays agnostic about where the engine
 * bundle lives — agent-runner computes it from `import.meta.dirname` and hands
 * it through.
 */
export interface PluginResolveOptions {
  /** `<hiveHome>` — holds `plugins/<name>/` and `plugins/node_modules/<name>/`. */
  hiveHome: string;
  /** Engine DIST_DIR. When running from the dev repo, this holds `plugins/<name>/*.js`. */
  distDir?: string;
}

/**
 * Resolve a plugin MCP server's compiled entry. Returns the first existing
 * path by priority, or a `BrokenServer` describing which paths were tried.
 *
 * Priority (first existing wins):
 *   1. Dev build:      <distDir>/plugins/<name>/<entry>.js
 *   2. npm bundled:    <hiveHome>/plugins/node_modules/<name>/dist/<entry>.min.js
 *   3. npm unbundled:  <hiveHome>/plugins/node_modules/<name>/dist/<entry>.js
 *   4. In-tree bundled: <hiveHome>/plugins/<name>/dist/<entry>.min.js
 *   5. In-tree unbundled: <hiveHome>/plugins/<name>/dist/<entry>.js
 *
 * The `.js` fallbacks at (3) and (5) exist because a local `tsc` produces
 * un-minified output. Without this, customers who build a plugin with plain
 * `tsc` (the natural thing to do) would hit a silent spawn failure.
 */
export function resolvePluginServerPath(
  pluginName: string,
  serverEntry: string,
  opts: PluginResolveOptions,
): { path: string } | BrokenServer {
  const entryJs = serverEntry.replace(/\.ts$/, ".js");
  const entryMin = serverEntry.replace(/\.ts$/, ".min.js");

  const candidates: string[] = [];
  if (opts.distDir) {
    candidates.push(resolve(opts.distDir, `plugins/${pluginName}/${entryJs}`));
  }
  candidates.push(
    resolve(opts.hiveHome, "plugins", "node_modules", pluginName, "dist", entryMin),
    resolve(opts.hiveHome, "plugins", "node_modules", pluginName, "dist", entryJs),
    resolve(opts.hiveHome, "plugins", pluginName, "dist", entryMin),
    resolve(opts.hiveHome, "plugins", pluginName, "dist", entryJs),
  );

  for (const path of candidates) {
    if (existsSync(path)) return { path };
  }

  return {
    reason: `no compiled entry found (expected one of .min.js or .js under dist/)`,
    pathsChecked: candidates,
  };
}

export function loadPlugins(
  pluginNames: string[],
  rootDir: string,
  resolveOpts?: { distDir?: string },
): LoadedPlugin[] {
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

    // Resolve each declared MCP server entry to its compiled artifact. Servers
    // that don't resolve are tracked as `broken` so downstream consumers can
    // surface the failure instead of spawning a missing file silently.
    const brokenServers: Record<string, BrokenServer> = {};
    for (const [serverName, serverDef] of Object.entries(manifest.mcpServers)) {
      const resolved = resolvePluginServerPath(name, serverDef.entry, {
        hiveHome: rootDir,
        distDir: resolveOpts?.distDir,
      });
      if ("reason" in resolved) {
        brokenServers[serverName] = resolved;
        log.error("Plugin MCP server entry not resolvable", {
          plugin: name,
          server: serverName,
          entry: serverDef.entry,
          reason: resolved.reason,
          pathsChecked: resolved.pathsChecked,
        });
      }
    }

    for (const seed of manifest.agentSeeds) {
      const seedPath = join(pluginDir, "agent-seeds", seed);
      if (!existsSync(seedPath)) {
        log.warn("Plugin agent seed not found", { plugin: name, seed, path: seedPath });
      }
    }

    plugins.push({ name, dir: pluginDir, manifest, brokenServers });
    const brokenNames = Object.keys(brokenServers);
    log.info("Plugin loaded", {
      plugin: name,
      mcpServers: Object.keys(manifest.mcpServers),
      seeds: manifest.agentSeeds,
      ...(brokenNames.length ? { brokenServers: brokenNames } : {}),
    });
  }

  return plugins;
}

/**
 * Re-check broken MCP server entries against the filesystem and drop any that
 * now resolve. Mutates `plugin.brokenServers` in place. Intended for SIGUSR1
 * recovery when plugin dist files land after startup (e.g., a race between
 * the engine restart and whatever populates `<hiveHome>/plugins/<name>/dist/`).
 *
 * Active agent sessions keep their cached runner state; the next new session
 * picks up the unmarked server naturally because agent-runner reads
 * `plugin.brokenServers` at spawn time.
 *
 * Returns the names of rescued servers (per plugin) so callers can log a
 * useful summary without re-walking the map.
 */
export function rescanPluginBrokenServers(
  plugins: LoadedPlugin[],
  rootDir: string,
  resolveOpts?: { distDir?: string },
): { rescued: Record<string, string[]>; stillBroken: Record<string, string[]> } {
  const rescued: Record<string, string[]> = {};
  const stillBroken: Record<string, string[]> = {};

  for (const plugin of plugins) {
    const brokenNames = Object.keys(plugin.brokenServers);
    if (brokenNames.length === 0) continue;

    for (const serverName of brokenNames) {
      const serverDef = plugin.manifest.mcpServers[serverName];
      if (!serverDef) {
        // Server was removed from the manifest since startup — drop the stale entry.
        delete plugin.brokenServers[serverName];
        continue;
      }
      const resolved = resolvePluginServerPath(plugin.name, serverDef.entry, {
        hiveHome: rootDir,
        distDir: resolveOpts?.distDir,
      });
      if ("path" in resolved) {
        delete plugin.brokenServers[serverName];
        (rescued[plugin.name] ??= []).push(serverName);
      } else {
        (stillBroken[plugin.name] ??= []).push(serverName);
      }
    }
  }

  return { rescued, stillBroken };
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
          secretEnv: v["secret-env"] ?? [],
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
