import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolveConfigFile } from "../paths.js";

export type SingleInstanceEnv = Record<string, string>;

type HiveYamlShape = {
  instance?: {
    id?: string;
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

  let yaml: HiveYamlShape = {};
  if (existsSync(configPath)) {
    yaml = (parseYaml(readFileSync(configPath, "utf-8")) as HiveYamlShape) ?? {};
  }

  const id = yaml.instance?.id ?? "hive";
  // This handoff carries identity/selectors only. Ports are corroborated by
  // the service/process adapters and are never treated as a kill set.
  const env: SingleInstanceEnv = {
    HIVE_SINGLE_INSTANCE: "1",
    HIVE_SINGLE_ID: id,
    HIVE_SINGLE_CONFIG: configPath,
    HIVE_SINGLE_ROOT: hiveHome,
  };
  if (tag) env.HIVE_SINGLE_TAG = tag;
  return env;
}
