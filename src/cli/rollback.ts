import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveHiveHome } from "../paths.js";
import { deriveSingleInstanceEnv } from "./single-instance-env.js";

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
 * --instance=<id> is required at the shell layer; defaults to the instance.id
 * from hive.yaml (via HIVE_SINGLE_ID) so the arg matches the row deploy.sh
 * sees in single-instance mode. An explicit opts.instance still wins.
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

  // KPR-70: pass single-instance env so deploy.sh's --rollback short-circuit
  // can locate the row without reading the (now-empty) shipped instances.conf.
  // The --instance arg MUST agree with HIVE_SINGLE_ID — basename-derivation
  // breaks when a custom install path doesn't match the configured instance.id.
  const singleEnv = deriveSingleInstanceEnv(hiveHome);
  const instance = opts.instance ?? singleEnv.HIVE_SINGLE_ID;

  const fromVersion = readEngineVersion(engineDir);
  const toVersion = readEngineVersion(prevDir);

  console.log(`Rolling back ${instance}: ${fromVersion} → ${toVersion}`);

  try {
    execFileSync(deployScript, ["--rollback", `--instance=${instance}`], {
      stdio: "inherit",
      env: { ...process.env, ...singleEnv },
    });
  } catch {
    console.error("Rollback failed. See deploy.sh output above.");
    process.exit(1);
  }

  const actualVersion = readEngineVersion(engineDir);
  console.log(`Rollback complete: ${actualVersion}.`);
}
