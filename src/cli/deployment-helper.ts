import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigFile } from "../paths.js";
import { deriveSingleInstanceEnv } from "./single-instance-env.js";

export function deploymentHelperFor(moduleUrl: string): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDirectory, "deploy.min.js"),
    resolve(moduleDirectory, "..", "..", "pkg", "deploy.min.js"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    const info = lstatSync(canonical);
    if (info.isFile() && !info.isSymbolicLink()) return canonical;
  }
  throw new Error(`matching packaged deployment helper is missing (${candidates.join(", ")})`);
}

export function invokeDeploymentHelper(
  moduleUrl: string,
  hiveHome: string,
  args: readonly string[],
  tag?: string,
): void {
  const helper = deploymentHelperFor(moduleUrl);
  const identity = deriveSingleInstanceEnv(hiveHome, tag);
  execFileSync(process.execPath, [helper, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...identity,
      HIVE_HOME: hiveHome,
      HIVE_CONFIG: resolveConfigFile(hiveHome),
    },
  });
}
