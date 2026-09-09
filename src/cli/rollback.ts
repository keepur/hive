import { resolve } from "node:path";
import { resolveHiveHome } from "../paths.js";
import { invokeDeploymentHelper } from "./deployment-helper.js";
import { deriveSingleInstanceEnv } from "./single-instance-env.js";

export interface RollbackOptions {
  instance?: string;
  dryRun?: boolean;
}

/** Roll back the engine and enabled worker as one release unit. */
export async function runRollback(options: RollbackOptions = {}): Promise<void> {
  const hiveHome = resolveHiveHome();
  const identity = deriveSingleInstanceEnv(hiveHome);
  const instance = options.instance ?? identity.HIVE_SINGLE_ID;
  if (instance !== identity.HIVE_SINGLE_ID) throw new Error("--instance does not match the selected config");
  const args = ["--rollback", `--instance=${instance}`];
  if (options.dryRun) args.push("--dry-run");
  console.log(`Rolling back engine and enabled voice worker for ${instance}...`);
  try {
    invokeDeploymentHelper(import.meta.url, hiveHome, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Rollback failed.");
    process.exit(1);
  }
  if (!options.dryRun) console.log(`Rollback complete at ${resolve(hiveHome, ".hive")}.`);
}
