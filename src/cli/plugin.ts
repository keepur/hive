import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { hiveHome } from "../paths.js";
import { readConfig, writeConfig, configPath } from "./hive-config.js";
import { restartHiveService } from "./hive-restart.js";
import { HIVE_PLUGIN_API_VERSION } from "../plugins/api-version.js";
import { isHiveApiCompatible } from "../plugins/plugin-loader.js";

const pluginsDir = resolve(hiveHome, "plugins");

/**
 * Resolve a plugin's version. `plugin.yaml` doesn't carry `version:` — the
 * canonical source is the sibling `package.json`. Fall back to the manifest
 * only if `package.json` is missing or unreadable.
 */
function resolvePluginVersion(manifestPath: string, manifestRaw: unknown): string {
  const pkgPath = join(manifestPath, "..", "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg?.version === "string") return pkg.version;
    } catch {
      // fall through to manifest
    }
  }
  const manifest = manifestRaw as { version?: unknown } | null | undefined;
  return typeof manifest?.version === "string" ? manifest.version : "unknown";
}

export async function runPlugin(subcommand?: string, target?: string): Promise<void> {
  switch (subcommand) {
    case "add":
      return pluginAdd(target);
    case "remove":
      return pluginRemove(target);
    case "list":
      return pluginList();
    default:
      console.error("Usage: hive plugin <add|list|remove> [package]");
      process.exit(1);
  }
}

function pluginAdd(target?: string): void {
  if (!target) {
    console.error("Usage: hive plugin add <package-name>");
    process.exit(1);
  }

  // Step 1: npm install
  mkdirSync(pluginsDir, { recursive: true });
  const pkgJsonPath = resolve(pluginsDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    execFileSync("npm", ["init", "-y"], { cwd: pluginsDir, stdio: "pipe" });
  }

  console.log(`Installing ${target}...`);
  try {
    execFileSync("npm", ["install", target], { cwd: pluginsDir, stdio: "pipe" });
  } catch (err) {
    console.error(`Failed to install ${target}: ${String(err)}`);
    process.exit(1);
  }

  // Step 2: Post-install validation
  const installedDir = resolve(pluginsDir, "node_modules", target);
  const manifestPath = join(installedDir, "plugin.yaml");

  if (!existsSync(manifestPath)) {
    console.error(`Not a valid hive plugin — no plugin.yaml found in ${target}.`);
    rollbackInstall(target);
    process.exit(1);
  }

  const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
  const hiveApi: string | undefined = raw?.hiveApi ?? raw?.["hive-api"];

  if (hiveApi && !isHiveApiCompatible(hiveApi, HIVE_PLUGIN_API_VERSION)) {
    console.error(`Plugin requires hiveApi ${hiveApi} but this hive is ${HIVE_PLUGIN_API_VERSION}.`);
    rollbackInstall(target);
    process.exit(1);
  }

  const version = resolvePluginVersion(manifestPath, raw);

  // Step 3: Update hive.yaml (rollback npm install on failure)
  const cfgPath = configPath();
  const config = readConfig(cfgPath);
  if (!config.plugins) config.plugins = [];
  if (!config.plugins.includes(target)) {
    config.plugins.push(target);
    try {
      writeConfig(config, cfgPath);
    } catch (err) {
      console.error(`Failed to update hive.yaml: ${String(err)}`);
      rollbackInstall(target);
      process.exit(1);
    }
    console.log("✓ Updated hive.yaml");
  }

  // Step 4: Restart
  const restarted = restartHiveService();
  if (restarted) {
    console.log("✓ Restarting hive... done");
  } else {
    console.log("Start hive to activate the plugin.");
  }

  console.log(`✓ Installed ${target} (v${version}${hiveApi ? `, hiveApi ${hiveApi}` : ""})`);
}

function pluginRemove(target?: string): void {
  if (!target) {
    console.error("Usage: hive plugin remove <package-name>");
    process.exit(1);
  }

  if (!existsSync(pluginsDir)) {
    console.error("No plugins directory found.");
    process.exit(1);
  }

  console.log(`Removing ${target}...`);
  try {
    execFileSync("npm", ["uninstall", target], { cwd: pluginsDir, stdio: "pipe" });
  } catch (err) {
    console.error(`Failed to uninstall ${target}: ${String(err)}`);
    process.exit(1);
  }

  // Update hive.yaml — silently skip if not present (legacy plugin)
  const cfgPath = configPath();
  const config = readConfig(cfgPath);
  if (Array.isArray(config.plugins)) {
    const idx = config.plugins.indexOf(target);
    if (idx >= 0) {
      config.plugins.splice(idx, 1);
      writeConfig(config, cfgPath);
      console.log("✓ Updated hive.yaml");
    }
  }

  // Restart
  const restarted = restartHiveService();
  if (restarted) {
    console.log("✓ Restarting hive... done");
  } else {
    console.log("Restart hive to complete removal.");
  }

  console.log(`Removed ${target}`);
}

function pluginList(): void {
  const cfgPath = configPath();
  const config = readConfig(cfgPath);
  const pluginNames: string[] = config.plugins ?? [];

  if (pluginNames.length === 0) {
    console.log("No plugins configured in hive.yaml.");
    return;
  }

  console.log("Installed plugins:\n");
  for (const name of pluginNames) {
    // Dual-path resolution: node_modules/<name>/ then <name>/
    const npmDir = resolve(pluginsDir, "node_modules", name);
    const inTreeDir = resolve(pluginsDir, name);
    const npmManifest = join(npmDir, "plugin.yaml");
    const inTreeManifest = join(inTreeDir, "plugin.yaml");

    let manifestPath: string | null = null;
    let isInTree = false;

    if (existsSync(npmManifest)) {
      manifestPath = npmManifest;
    } else if (existsSync(inTreeManifest)) {
      manifestPath = inTreeManifest;
      isInTree = true;
    }

    if (!manifestPath) {
      console.log(`  ${name}  ⚠ not found on disk`);
      continue;
    }

    try {
      const raw = parseYaml(readFileSync(manifestPath, "utf-8"));
      const version = resolvePluginVersion(manifestPath, raw);
      const hiveApi = raw?.hiveApi ?? raw?.["hive-api"] ?? "";
      const tag = isInTree ? "  [in-tree]" : "";
      console.log(`  ${name}  v${version}${hiveApi ? `  (hiveApi ${hiveApi})` : ""}${tag}`);
    } catch {
      console.log(`  ${name}  ⚠ failed to read plugin.yaml`);
    }
  }
}

function rollbackInstall(target: string): void {
  try {
    execFileSync("npm", ["uninstall", target], { cwd: pluginsDir, stdio: "pipe" });
  } catch {
    // Best effort — the install may have partially failed
  }
}
