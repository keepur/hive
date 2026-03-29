import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BeekeeperConfig } from "./types.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("beekeeper-config");

/**
 * Discover all installed Claude Code plugins from ~/.claude/plugins/installed_plugins.json.
 */
function discoverInstalledPlugins(): string[] {
  const home = process.env.HOME ?? "";
  const installedPath = join(home, ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(installedPath)) return [];

  try {
    const data = JSON.parse(readFileSync(installedPath, "utf-8")) as {
      plugins: Record<string, Array<{ installPath: string }>>;
    };
    const paths: string[] = [];
    for (const versions of Object.values(data.plugins)) {
      for (const entry of versions) {
        if (entry.installPath && existsSync(entry.installPath)) {
          paths.push(entry.installPath);
        }
      }
    }
    return paths;
  } catch {
    log.warn("Failed to read installed plugins");
    return [];
  }
}

/**
 * Discover user-level skills from ~/.claude/skills/.
 * Each subdirectory with a SKILL.md is loaded as a local plugin.
 */
function discoverUserSkills(): string[] {
  const home = process.env.HOME ?? "";
  const skillsDir = join(home, ".claude", "skills");
  if (!existsSync(skillsDir)) return [];

  const paths: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const fullPath = join(skillsDir, entry.name);
    if ((entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(fullPath, "SKILL.md"))) {
      paths.push(fullPath);
    }
  }
  return paths;
}

/**
 * Discover project-level skills from <workspace>/.claude/skills/.
 * Loads the .claude dir as a plugin so all skills under it are available.
 */
function discoverProjectSkills(workspaces: Record<string, string>): string[] {
  const paths: string[] = [];
  for (const wsPath of Object.values(workspaces)) {
    const dotClaude = join(wsPath, ".claude");
    const skillsDir = join(dotClaude, "skills");
    if (existsSync(skillsDir)) {
      paths.push(dotClaude);
    }
  }
  return paths;
}

export function loadConfig(): BeekeeperConfig {
  const configPath = resolve(process.env.BEEKEEPER_CONFIG ?? "./beekeeper.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`Beekeeper config not found: ${configPath}`);
  }

  const raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;

  const authToken = process.env.BEEKEEPER_AUTH_TOKEN;
  if (!authToken) {
    throw new Error("Missing required env var: BEEKEEPER_AUTH_TOKEN");
  }

  // Expand ~ in workspace paths
  const workspaces: Record<string, string> = {};
  const rawWorkspaces = (raw.workspaces ?? {}) as Record<string, string>;
  for (const [name, path] of Object.entries(rawWorkspaces)) {
    workspaces[name] = path.replace(/^~/, process.env.HOME ?? "");
  }

  // Auto-discover: installed plugins + user skills + project skills + explicit extras
  const installedPlugins = discoverInstalledPlugins();
  const userSkills = discoverUserSkills();
  const projectSkills = discoverProjectSkills(workspaces);
  const extraPlugins = (raw.plugins as string[])?.map((p) => p.replace(/^~/, process.env.HOME ?? "")) ?? [];
  const allPlugins = [...new Set([...installedPlugins, ...userSkills, ...projectSkills, ...extraPlugins])];

  log.info("Plugin discovery complete", {
    installed: installedPlugins.length,
    userSkills: userSkills.length,
    projectSkills: projectSkills.length,
    extra: extraPlugins.length,
    total: allPlugins.length,
  });

  return {
    port: (raw.port as number) ?? 3099,
    defaultWorkspace: (raw.default_workspace as string) ?? "hive",
    model: (raw.model as string) ?? "claude-opus-4-6",
    workspaces,
    confirmOperations: (raw.confirm_operations as string[]) ?? [
      "git push --force",
      "git branch -D",
      "rm -rf",
      "rm -r",
      "git reset --hard",
      "git checkout -- .",
      "git clean -f",
    ],
    authToken,
    plugins: allPlugins,
  };
}
