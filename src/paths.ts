import { existsSync } from "node:fs";
import { resolve } from "node:path";

const home = process.env.HOME ?? "/tmp";

/**
 * Resolve the Hive home directory.
 *
 * Priority:
 *   1. HIVE_HOME env var (explicit — always wins)
 *   2. ./hive.yaml in cwd (project-local / dev repo mode)
 *   3. ~/hive/ (default for npm installs; v0.2.0 — was ~/.hive in v0.1.x)
 */
export function resolveHiveHome(): string {
  if (process.env.HIVE_HOME) return resolve(process.env.HIVE_HOME);
  if (existsSync(resolve(process.cwd(), "hive.yaml"))) return process.cwd();
  return resolve(home, "hive");
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

/** Customer-space skills directory. */
export const skillsDir = resolve(hiveHome, "skills");

/**
 * Engine root inside the instance directory.
 *
 * Everything under here is wipe-and-replace on upgrade: `dist/`, `node_modules/`,
 * `seeds/`, `service/`, `plugins/claude-code/`, `package.json`. Nothing agent-authored
 * or operator-owned lives here.
 */
export const engineDir = resolve(hiveHome, ".hive");

/**
 * Instance-local engine state directory.
 *
 * Holds the instance-git working tree, installed-snapshot.json, previous-snapshot.json,
 * and the upgrade-notice flag. Must survive `rm -rf .hive` upgrades — that's why it's
 * a sibling of `.hive/`, not a child.
 */
export const hiveStateDir = resolve(hiveHome, ".hive-state");

/**
 * GIT_DIR location for the instance-local git repo.
 *
 * Callers in instance-git.ts use this as `GIT_DIR` and `hiveHome` as `GIT_WORK_TREE`.
 */
export const instanceGitDir = resolve(hiveStateDir, "git");

/**
 * Core agent seeds directory (ships with the npm package).
 * Resolved from the package root, not from hiveHome — seeds are immutable
 * package content, not customer-space data.
 *
 * Dev: import.meta.dirname = <repo>/src/ → resolve("..", "seeds") = <repo>/seeds/
 * Bundled: import.meta.dirname = <package>/pkg/ → resolve("..", "seeds") = <package>/seeds/
 */
export const seedsDir = resolve(import.meta.dirname, "..", "seeds");

/**
 * Instance-local per-agent home root: `<hiveHome>/agents/`.
 * The runner creates `<this>/<agentId>/` subdirs lazily on first use.
 */
export function agentsDir(home: string = hiveHome): string {
  return resolve(home, "agents");
}

/**
 * Default session cwd for an agent with no archetype-provided cwd.
 * Business agents (Milo, River, Jessica, etc.) land here.
 */
export function agentScratchDir(agentId: string, home: string = hiveHome): string {
  return resolve(agentsDir(home), agentId, "scratch");
}

/**
 * Per-agent Playwright MCP home — holds the browser profile (`user-data/`)
 * and CDP artifacts (snapshots, traces, screenshots) via `--output-dir`.
 */
export function agentPlaywrightDir(agentId: string, home: string = hiveHome): string {
  return resolve(agentsDir(home), agentId, "playwright");
}
