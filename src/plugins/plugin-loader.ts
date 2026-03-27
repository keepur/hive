import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import type { LoadedPlugin, PluginManifest } from "./types.js";

const log = createLogger("plugin-loader");

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

export function normalizeManifest(raw: any): PluginManifest {
  return {
    name: raw.name ?? "",
    description: raw.description ?? "",
    mcpServers: Object.fromEntries(
      Object.entries(raw["mcp-servers"] ?? {}).map(([k, v]: [string, any]) => [
        k,
        {
          entry: v.entry,
          description: v.description,
          env: v.env ?? [],
          envMap: v["env-map"] ?? {},
          agentEnv: v["agent-env"] ?? {},
        },
      ]),
    ),
    agentsTemplates: raw["agents-templates"] ?? [],
  };
}
