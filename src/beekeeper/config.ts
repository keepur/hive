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


export function loadConfig(): BeekeeperConfig {
  const configPath = resolve(process.env.BEEKEEPER_CONFIG ?? "./beekeeper.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`Beekeeper config not found: ${configPath}`);
  }

  const raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;

  const jwtSecret = process.env.BEEKEEPER_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("Missing required env var: BEEKEEPER_JWT_SECRET");
  }

  const adminSecret = process.env.BEEKEEPER_ADMIN_SECRET;
  if (!adminSecret) {
    throw new Error("Missing required env var: BEEKEEPER_ADMIN_SECRET");
  }

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("Missing required env var: MONGO_URI");
  }

  // Auto-discover: installed plugins + user skills + explicit extras
  const installedPlugins = discoverInstalledPlugins();
  const userSkills = discoverUserSkills();
  const extraPlugins = (raw.plugins as string[])?.map((p) => p.replace(/^~/, process.env.HOME ?? "")) ?? [];
  const allPlugins = [...new Set([...installedPlugins, ...userSkills, ...extraPlugins])];

  log.info("Plugin discovery complete", {
    installed: installedPlugins.length,
    userSkills: userSkills.length,
    extra: extraPlugins.length,
    total: allPlugins.length,
  });

  return {
    port: (raw.port as number) ?? 3099,
    model: (raw.model as string) ?? "claude-opus-4-6",
    confirmOperations: (raw.confirm_operations as string[]) ?? [
      "git push --force",
      "git branch -D",
      "rm -rf",
      "rm -r",
      "git reset --hard",
      "git checkout -- .",
      "git clean -f",
    ],
    jwtSecret,
    adminSecret,
    mongoUri,
    mongoDbName: (raw.mongo_db as string) ?? "hive",
    plugins: allPlugins,
  };
}
