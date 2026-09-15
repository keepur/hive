import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { resolveHiveHome } from "../paths.js";
import { invokeDeploymentHelper } from "./deployment-helper.js";
import { deriveSingleInstanceEnv } from "./single-instance-env.js";

function readInstalledVersion(engineDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(engineDir, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export interface UpdateOptions {
  tag?: string;
  artifact?: string;
  instance?: string;
  dryRun?: boolean;
}

/** Invoke this CLI package's matching frozen lifecycle helper. */
export async function runUpdate(options: UpdateOptions = {}): Promise<void> {
  if (options.tag !== undefined && options.artifact !== undefined) {
    throw new Error("--artifact and --tag are mutually exclusive");
  }
  if (options.artifact !== undefined) {
    if (!isAbsolute(options.artifact) || !options.artifact.endsWith(".tgz")) {
      throw new Error("--artifact must be an absolute .tgz path");
    }
    const info = lstatSync(options.artifact);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("--artifact must be a regular file");
  }
  const hiveHome = resolveHiveHome();
  const identity = deriveSingleInstanceEnv(hiveHome, options.tag);
  if (options.instance !== undefined && options.instance !== identity.HIVE_SINGLE_ID) {
    throw new Error("--instance does not match the selected config");
  }
  const engineDir = resolve(hiveHome, ".hive");
  const fromVersion = readInstalledVersion(engineDir);
  const selector = options.artifact ?? options.tag ?? "latest";
  console.log(`Updating engine and enabled voice worker (current: ${fromVersion}, target: ${selector})...`);
  const args = options.artifact ? [`--artifact=${options.artifact}`] : [`--tag=${options.tag ?? "latest"}`];
  args.push(`--instance=${identity.HIVE_SINGLE_ID}`);
  if (options.dryRun) args.push("--dry-run");
  try {
    invokeDeploymentHelper(import.meta.url, hiveHome, args, options.tag);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Update failed.");
    process.exit(1);
  }
  if (!options.dryRun) console.log(`Installed release: ${readInstalledVersion(engineDir)}.`);
}
