import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveHiveHome, resolveConfigFile } from "../paths.js";
import { relocateBetaPlugins } from "./update-preflight.js";

function readInstalledVersion(engineDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(engineDir, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export interface UpdateOptions {
  tag?: string;
  instance?: string;
}

/**
 * Derive the per-instance facts deploy.sh needs in single-instance mode.
 *
 * Reads only what we need from hive.yaml — does NOT import ../config.ts because
 * config.ts pulls in dotenv + Mongo + keychain wiring at module load and would
 * throw on missing env in environments where `hive update` is the *first* thing
 * run after install. This keeps `hive update` startable on a half-configured box.
 */
type SingleInstanceEnv = Record<string, string>;

function deriveSingleInstanceEnv(hiveHome: string, tag: string): SingleInstanceEnv {
  const configPath = resolveConfigFile(hiveHome);
  const configFile = process.env.HIVE_CONFIG || "hive.yaml";

  let yaml: Record<string, any> = {};
  if (existsSync(configPath)) {
    yaml = (parseYaml(readFileSync(configPath, "utf-8")) as Record<string, any>) ?? {};
  }

  const id = (yaml.instance?.id as string) ?? "hive";
  const portBase = (yaml.instance?.portBase as number) ?? 3100;
  const portOverrides = Object.values((yaml.instance?.ports as Record<string, number>) ?? {});

  // Base port range covers every server config.ts derives from portBase
  // (background..voice = +0..+6). Explicit overrides extend the kill-set so
  // remapped ports also get cleared. Dedup to keep the arg compact.
  const derived = Array.from({ length: 7 }, (_, i) => portBase + i);
  const allPorts = Array.from(new Set([...derived, ...portOverrides])).sort((a, b) => a - b);

  // Logs dir mirrors the resolveDotenvPath naming convention:
  // hive-<suffix>.yaml → logs-<suffix>, hive.yaml → logs.
  const suffix = configFile.match(/^hive-(.+)\.yaml$/)?.[1];
  const logsDir = suffix ? `logs-${suffix}` : "logs";

  const env: SingleInstanceEnv = {
    HIVE_SINGLE_INSTANCE: "1",
    HIVE_SINGLE_ID: id,
    HIVE_SINGLE_CONFIG: configFile,
    HIVE_SINGLE_LOGS: logsDir,
    HIVE_SINGLE_PORTS: allPorts.join(" "),
    HIVE_SINGLE_ROOT: hiveHome,
  };
  // Tag is also passed via --tag flag for deploy.sh's existing parsing path,
  // but mirroring it as HIVE_SINGLE_TAG keeps the env contract self-contained.
  if (tag) env.HIVE_SINGLE_TAG = tag;
  return env;
}

/**
 * Shell out to deploy.sh for the actual fetch/swap/restart/health-check.
 * Keeps deploy.sh as the single implementation; this function is the typed
 * CLI surface for operators running `hive update`.
 */
export async function runUpdate(opts: UpdateOptions = {}): Promise<void> {
  const hiveHome = resolveHiveHome();
  const engineDir = resolve(hiveHome, ".hive");
  const deployScript = resolve(engineDir, "service", "deploy.sh");

  if (!existsSync(deployScript)) {
    console.error(`deploy.sh not found at ${deployScript}.`);
    console.error("Either the engine isn't populated (.hive/ missing) or this is a dev install.");
    process.exit(1);
  }

  const fromVersion = readInstalledVersion(engineDir);
  const tag = opts.tag ?? "latest";

  console.log(`Updating @keepur/hive (current: ${fromVersion}, target: ${tag})...`);

  // Beta pre-release safety net: relocate any plugins that 0.2.0-pre
  // `hive plugin add` misrouted into <engineDir>/plugins/node_modules/.
  // Must run before deploy.sh wipes .hive/. Idempotent.
  const relocated = relocateBetaPlugins();
  if (relocated.moved.length > 0) {
    console.log(
      `  ✓ Relocated ${relocated.moved.length} pre-release plugin(s) from .hive/ to plugins/: ${relocated.moved.join(", ")}`,
    );
  }

  const args = ["--tag=" + tag];
  if (opts.instance) args.push("--instance=" + opts.instance);

  // KPR-70: always run deploy.sh in single-instance mode from `hive update`.
  // The instance running the update is the only instance to update — we don't
  // read the engine-shipped instances.conf (which historically carried our dev
  // dodi/personal rows and broke every customer install).
  const singleEnv = deriveSingleInstanceEnv(hiveHome, tag);

  try {
    execFileSync(deployScript, args, {
      stdio: "inherit",
      env: { ...process.env, ...singleEnv },
    });
  } catch {
    console.error("Update failed. See deploy.sh output above.");
    process.exit(1);
  }

  const toVersion = readInstalledVersion(engineDir);
  if (fromVersion === toVersion) {
    console.log(`Already at latest matching tag: ${toVersion}.`);
  } else {
    console.log(`Updated: ${fromVersion} → ${toVersion}.`);
  }
}
