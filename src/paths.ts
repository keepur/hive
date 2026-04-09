import { existsSync } from "node:fs";
import { resolve } from "node:path";

const home = process.env.HOME ?? "/tmp";

/**
 * Resolve the Hive home directory.
 *
 * Priority:
 *   1. HIVE_HOME env var (explicit — always wins)
 *   2. ./hive.yaml in cwd (project-local / dev repo mode)
 *   3. ~/.hive/ (default for npm installs)
 */
export function resolveHiveHome(): string {
  if (process.env.HIVE_HOME) return resolve(process.env.HIVE_HOME);
  if (existsSync(resolve(process.cwd(), "hive.yaml"))) return process.cwd();
  return resolve(home, ".hive");
}

/**
 * Resolve config file path within a hive home.
 * HIVE_CONFIG selects the config file (e.g., hive-personal.yaml).
 */
export function resolveConfigFile(hiveHome: string): string {
  const configFile = process.env.HIVE_CONFIG || "hive.yaml";
  return resolve(hiveHome, configFile);
}

/**
 * Resolve .env file path matching the config file.
 * hive-personal.yaml → .env-personal, hive.yaml → .env
 */
export function resolveDotenvPath(hiveHome: string): string {
  const configFile = process.env.HIVE_CONFIG || "hive.yaml";
  const suffix = configFile.match(/^hive-(.+)\.yaml$/)?.[1];
  return resolve(hiveHome, suffix ? `.env-${suffix}` : ".env");
}

/** The resolved hive home directory (computed once at import time). */
export const hiveHome = resolveHiveHome();
