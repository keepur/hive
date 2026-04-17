import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hiveHome } from "../paths.js";

/** Resolve the hive.yaml config file path. */
export function configPath(): string {
  return resolve(hiveHome, process.env.HIVE_CONFIG || "hive.yaml");
}

/** Read hive.yaml as a plain object. Returns {} if file doesn't exist. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readConfig(path?: string): any {
  const p = path ?? configPath();
  if (!existsSync(p)) return {};
  return parseYaml(readFileSync(p, "utf-8")) ?? {};
}

/** Write a plain object back to hive.yaml. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function writeConfig(data: any, path?: string): void {
  const p = path ?? configPath();
  writeFileSync(p, stringifyYaml(data, { lineWidth: 0 }));
}
