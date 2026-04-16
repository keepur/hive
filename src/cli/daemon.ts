import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { hiveHome } from "../paths.js";

function getInstanceId(): string {
  const configPath = resolve(hiveHome, process.env.HIVE_CONFIG ?? "hive.yaml");
  if (!existsSync(configPath)) return "hive";
  const config = parseYaml(readFileSync(configPath, "utf-8")) ?? {};
  return (config.instance?.id as string) ?? "hive";
}

function getLabel(): string {
  return `com.hive.${getInstanceId()}.agent`;
}

function getPlistPath(): string {
  return resolve(hiveHome, "service", `${getLabel()}.plist`);
}

function getLaunchAgentLink(): string {
  const home = process.env.HOME ?? "/tmp";
  return resolve(home, "Library", "LaunchAgents", `${getLabel()}.plist`);
}

export async function startDaemon(pkgRoot: string): Promise<void> {
  const label = getLabel();
  const plistPath = getPlistPath();
  const linkPath = getLaunchAgentLink();
  const serviceDir = resolve(hiveHome, "service");
  const logsDir = resolve(hiveHome, "logs");

  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const nodePath = execFileSync("which", ["node"], { encoding: "utf-8" }).trim();
  const serverPath = existsSync(resolve(pkgRoot, "pkg", "server.min.js"))
    ? resolve(pkgRoot, "pkg", "server.min.js")
    : resolve(pkgRoot, "dist", "index.js");

  const home = process.env.HOME ?? "/tmp";
  const pathEnv = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${serverPath}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${hiveHome}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HIVE_HOME</key>
    <string>${hiveHome}</string>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${home}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${logsDir}/hive.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/hive.err</string>
</dict>
</plist>
`;

  writeFileSync(plistPath, plist);
  console.log(`Generated plist: ${plistPath}`);

  // Ensure ~/Library/LaunchAgents/ exists and create symlink
  const launchAgentsDir = resolve(linkPath, "..");
  mkdirSync(launchAgentsDir, { recursive: true });
  if (existsSync(linkPath)) unlinkSync(linkPath);
  symlinkSync(plistPath, linkPath);

  // Unload first if already loaded (idempotent restart)
  try {
    execFileSync("launchctl", ["unload", linkPath], { stdio: "pipe" });
  } catch {
    // Not loaded — fine
  }

  try {
    execFileSync("launchctl", ["load", linkPath], { stdio: "inherit" });
    console.log(`Started ${label}`);
  } catch {
    throw new Error(`Failed to start ${label}. Check: launchctl list | grep hive`);
  }
}

export async function stopDaemon(): Promise<void> {
  const linkPath = getLaunchAgentLink();
  const label = getLabel();

  if (!existsSync(linkPath)) {
    console.log(`No LaunchAgent found for ${label}`);
    return;
  }

  try {
    execFileSync("launchctl", ["unload", linkPath], { stdio: "inherit" });
    console.log(`Stopped ${label}`);
  } catch {
    console.error(`Failed to stop ${label}`);
  }

  // Clean up symlink
  try {
    if (existsSync(linkPath)) unlinkSync(linkPath);
    console.log(`Removed ${linkPath}`);
  } catch {
    // Non-critical — stale symlink won't cause harm
  }
}
