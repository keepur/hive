import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolveConfigFile } from "../paths.js";

export type SingleInstanceEnv = Record<string, string>;

type HiveYamlShape = {
  instance?: {
    id?: string;
    portBase?: number;
    ports?: Record<string, number>;
  };
};

/**
 * Derive the per-instance facts deploy.sh needs in single-instance mode (KPR-70).
 *
 * Reads only what we need from hive.yaml — does NOT import ../config.ts because
 * config.ts pulls in dotenv + Mongo + keychain wiring at module load and would
 * throw on missing env in environments where `hive update` / `hive rollback` is
 * the *first* thing run after install. Keeps these CLI commands startable on a
 * half-configured box.
 *
 * Used by both `runUpdate` and `runRollback` so customer installs (which ship
 * an empty instances.conf) get the same treatment on both paths — without this,
 * rollback would hit `ERROR: No instances found` before deploy.sh's --rollback
 * short-circuit ever runs.
 */
export function deriveSingleInstanceEnv(hiveHome: string, tag?: string): SingleInstanceEnv {
  const configPath = resolveConfigFile(hiveHome);
  const configFile = process.env.HIVE_CONFIG || "hive.yaml";

  let yaml: HiveYamlShape = {};
  if (existsSync(configPath)) {
    yaml = (parseYaml(readFileSync(configPath, "utf-8")) as HiveYamlShape) ?? {};
  }

  const id = yaml.instance?.id ?? "hive";
  const portBase = yaml.instance?.portBase ?? 3100;
  const portOverrides = Object.values(yaml.instance?.ports ?? {});

  // Base port range covers every server config.ts derives from portBase
  // (background..voice = +0..+6). Explicit overrides extend the kill-set so
  // remapped ports also get cleared. Dedup to keep the arg compact.
  const derived = Array.from({ length: 7 }, (_, i) => portBase + i);
  const allPorts = Array.from(new Set([...derived, ...portOverrides])).sort((a, b) => a - b);

  // Logs dir is always "logs" — daemon.ts hardcodes that for npm installs and
  // wizard.ts mkdirs only "logs". The historical "logs-<suffix>" convention
  // was a multi-instance dev-only artifact handled via the workspace-level
  // instances.conf, not via single-instance mode.
  const env: SingleInstanceEnv = {
    HIVE_SINGLE_INSTANCE: "1",
    HIVE_SINGLE_ID: id,
    HIVE_SINGLE_CONFIG: configFile,
    HIVE_SINGLE_LOGS: "logs",
    HIVE_SINGLE_PORTS: allPorts.join(" "),
    HIVE_SINGLE_ROOT: hiveHome,
  };
  if (tag) env.HIVE_SINGLE_TAG = tag;
  return env;
}
