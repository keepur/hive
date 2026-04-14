import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { stopDaemon, startDaemon } from "./daemon.js";

export async function runUpdate(): Promise<void> {
  console.log("Stopping Hive...");
  await stopDaemon();
  console.log("Updating @keepur/hive...");
  try {
    execFileSync("npm", ["update", "-g", "@keepur/hive"], { stdio: "inherit" });
    console.log("Update complete.");
  } catch {
    console.error("Update failed.");
    process.exit(1);
  }
  const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
  const updatedPkgRoot = resolve(npmRoot, "@keepur", "hive");
  console.log("Restarting Hive...");
  await startDaemon(updatedPkgRoot);
}
