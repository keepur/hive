import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveHiveHome } from "../paths.js";

function readEngineVersion(engineDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(engineDir, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export interface RollbackOptions {
  instance?: string;
}

/**
 * Shell out to deploy.sh --rollback to swap .hive ↔ .hive.prev.
 * --instance=<id> is required at the shell layer; we surface the instance
 * defaulting to HIVE_HOME's basename when not specified.
 */
export async function runRollback(opts: RollbackOptions = {}): Promise<void> {
  const hiveHome = resolveHiveHome();
  const engineDir = resolve(hiveHome, ".hive");
  const prevDir = resolve(hiveHome, ".hive.prev");
  const deployScript = resolve(engineDir, "service", "deploy.sh");

  if (!existsSync(deployScript)) {
    console.error(`deploy.sh not found at ${deployScript}.`);
    process.exit(1);
  }
  if (!existsSync(prevDir)) {
    console.error(`No previous engine at ${prevDir}. Rollback unavailable.`);
    process.exit(1);
  }

  const fromVersion = readEngineVersion(engineDir);
  const toVersion = readEngineVersion(prevDir);
  const instance = opts.instance ?? hiveHome.split("/").filter(Boolean).pop() ?? "default";

  console.log(`Rolling back ${instance}: ${fromVersion} → ${toVersion}`);

  try {
    execFileSync(deployScript, ["--rollback", `--instance=${instance}`], { stdio: "inherit" });
  } catch {
    console.error("Rollback failed. See deploy.sh output above.");
    process.exit(1);
  }

  const actualVersion = readEngineVersion(engineDir);
  console.log(`Rollback complete: ${actualVersion}.`);
}
