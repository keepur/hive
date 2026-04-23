import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveHiveHome } from "../paths.js";
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

  try {
    execFileSync(deployScript, args, { stdio: "inherit" });
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
