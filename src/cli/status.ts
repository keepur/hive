import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { hiveHome } from "../paths.js";

export async function showStatus(): Promise<void> {
  console.log(`Hive home: ${hiveHome}`);

  const configPath = resolve(hiveHome, process.env.HIVE_CONFIG ?? "hive.yaml");
  if (!existsSync(configPath)) {
    console.log("Status: not initialized (run 'hive init')");
    return;
  }

  const config = parseYaml(readFileSync(configPath, "utf-8")) ?? {};
  const instanceId = (config.instance?.id as string) ?? "hive";
  const label = `com.hive.${instanceId}.agent`;

  console.log(`Instance: ${instanceId}`);

  try {
    const output = execFileSync("launchctl", ["list"], { encoding: "utf-8" });
    const running = output.split("\n").find((line) => line.includes(label));
    if (running) {
      const parts = running.trim().split(/\s+/);
      const pid = parts[0];
      const exitCode = parts[1];
      console.log(`Service: running (PID ${pid}, last exit ${exitCode})`);
    } else {
      console.log("Service: not running");
    }
  } catch {
    console.log("Service: unknown (could not query launchctl)");
  }

  try {
    execFileSync("mongosh", ["--eval", "db.runCommand({ping:1})", "--quiet"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    console.log("MongoDB: connected");
  } catch {
    console.log("MongoDB: not reachable");
  }
}
