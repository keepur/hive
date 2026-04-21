import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stopDaemon, startDaemon } from "./daemon.js";

function readInstalledVersion(pkgRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(pkgRoot, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export async function runUpdate(): Promise<void> {
  const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
  const pkgRoot = resolve(npmRoot, "@keepur", "hive");
  const fromVersion = readInstalledVersion(pkgRoot);

  console.log("Stopping Hive...");
  await stopDaemon();
  console.log(`Updating @keepur/hive (current: ${fromVersion})...`);
  try {
    execFileSync("npm", ["update", "-g", "@keepur/hive"], { stdio: "inherit" });
  } catch {
    console.error("Update failed.");
    process.exit(1);
  }
  const toVersion = readInstalledVersion(pkgRoot);
  if (fromVersion === toVersion) {
    console.log(`Already at latest version: ${toVersion}.`);
  } else {
    console.log(`Updated: ${fromVersion} → ${toVersion}.`);
  }
  console.log("Restarting Hive...");
  await startDaemon(pkgRoot);
}
