import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildServicePlist,
  getServiceLabel,
  getServiceLaunchAgentLink,
  getServicePlistPath,
  validateInstanceId,
} from "../deployment/services.js";
import { invokeDeploymentHelper } from "./deployment-helper.js";

export function getInstanceId(hiveHome: string): string {
  const configPath = resolve(hiveHome, process.env.HIVE_CONFIG ?? "hive.yaml");
  if (!existsSync(configPath)) return "hive";
  const config = parseYaml(readFileSync(configPath, "utf8")) as { instance?: { id?: unknown } } | null;
  const id = config?.instance?.id ?? "hive";
  if (typeof id !== "string") throw new Error("invalid configured instance ID");
  return validateInstanceId(id);
}

export function getLabel(hiveHome: string): string {
  return getServiceLabel(getInstanceId(hiveHome), "engine");
}

export function getPlistPath(hiveHome: string): string {
  return getServicePlistPath(hiveHome, getInstanceId(hiveHome), "engine");
}

export function getLaunchAgentLink(hiveHome: string): string {
  return getServiceLaunchAgentLink(process.env.HOME ?? "/tmp", getInstanceId(hiveHome), "engine");
}

/** Compatibility wrapper for callers that still construct an engine plist. */
export function buildPlist(options: {
  label: string;
  nodePath: string;
  serverPath: string;
  hiveHome: string;
  home: string;
  pathEnv: string;
  logsDir: string;
}): string {
  return buildServicePlist({
    label: options.label,
    nodePath: options.nodePath,
    entrypoint: options.serverPath,
    args: [],
    hiveHome: options.hiveHome,
    configPath: resolve(options.hiveHome, process.env.HIVE_CONFIG ?? "hive.yaml"),
    home: options.home,
    pathEnv: options.pathEnv,
    overrides: {},
    stdout: resolve(options.logsDir, "hive.log"),
    stderr: resolve(options.logsDir, "hive.err"),
  });
}

export async function startDaemon(hiveHome: string): Promise<void> {
  invokeDeploymentHelper(import.meta.url, hiveHome, ["--start", `--instance=${getInstanceId(hiveHome)}`]);
}

export async function stopDaemon(hiveHome: string): Promise<void> {
  invokeDeploymentHelper(import.meta.url, hiveHome, ["--stop", `--instance=${getInstanceId(hiveHome)}`]);
}
