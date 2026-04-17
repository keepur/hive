import { execFileSync } from "node:child_process";
import { readConfig } from "./hive-config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("hive-restart");

/**
 * Attempt to restart the Hive LaunchAgent if it's running.
 * Returns true if restart was triggered, false if service wasn't running.
 */
export function restartHiveService(): boolean {
  const config = readConfig();
  const instanceId = config.instanceId ?? config.id ?? "hive";
  const label = `com.hive.${instanceId}.agent`;

  // Check if the LaunchAgent is loaded (query specific label, not full list)
  try {
    execFileSync("launchctl", ["list", label], { stdio: "pipe" });
    // Exit code 0 means the service is loaded
  } catch {
    // Non-zero exit = not loaded
    return false;
  }

  // Get current user's UID for the gui/ domain
  const uid = execFileSync("id", ["-u"], {
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();

  try {
    execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], {
      stdio: "pipe",
    });
    log.info("Hive service restarted", { label });
    return true;
  } catch (err) {
    log.warn("Failed to restart hive service", { label, error: String(err) });
    return false;
  }
}
