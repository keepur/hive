#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dirname, resolve, join } from "node:path";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";

function resolveCliHiveHome(): string {
  if (process.env.HIVE_HOME) return resolve(process.env.HIVE_HOME);
  let dir = resolve(process.cwd());
  while (true) {
    if (existsSync(resolve(dir, "hive.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.env.HOME ?? "/tmp", "hive");
}

/**
 * Guard `hive start` against running with no configured instance. Without a real
 * hive.yaml we fall through to built-in defaults (portBase 3100, id "hive") and
 * crash on port collision — so bail out with an actionable message.
 */
function ensureHiveInstallOrExit(): string {
  const home = resolveCliHiveHome();
  if (existsSync(join(home, "hive.yaml"))) return home;

  const lines: string[] = [
    `No Hive install found at ${home}.`,
    `  Run \`hive init\` to set up a new instance, or`,
    `  pass --config <path/to/hive.yaml> to use an existing one, or`,
    `  set HIVE_HOME to an existing install directory.`,
  ];

  // Scan ~/services/hive for existing installs and list as hints
  const userHome = process.env.HOME ?? "/tmp";
  const servicesRoot = resolve(userHome, "services", "hive");
  const found: string[] = [];
  if (existsSync(servicesRoot)) {
    try {
      for (const dir of readdirSync(servicesRoot)) {
        const yamlPath = join(servicesRoot, dir, "hive.yaml");
        if (existsSync(yamlPath)) found.push(join(servicesRoot, dir));
      }
    } catch {
      // ignore — hint is best-effort
    }
  }
  if (found.length > 0) {
    lines.push("");
    lines.push(`Available installs: ${found.join(", ")}`);
  }

  console.error(lines.join("\n"));
  process.exit(1);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  // Subcommands declare their own flags by inspecting process.argv directly
  // (see e.g. migrate-0.2's --dry-run handling). Strict mode would reject
  // those before the subcommand runs.
  strict: false,
  options: {
    help: { type: "boolean", short: "h", default: false },
    daemon: { type: "boolean", default: false },
    config: { type: "string" },
    version: { type: "boolean", short: "v", default: false },
    verbose: { type: "boolean", default: false },
    tag: { type: "string" },
    instance: { type: "string" },
  },
});

const command = positionals[0];

function stringOption(name: "config" | "tag" | "instance", parsed: string | undefined): string | undefined {
  if (typeof parsed === "string") return parsed;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === `--${name}`) {
      const next = args[i + 1];
      return next && !next.startsWith("--") ? next : undefined;
    }
    if (arg?.startsWith(`--${name}=`)) {
      return arg.slice(name.length + 3);
    }
  }
  return undefined;
}

function booleanOption(name: "verbose", parsed: boolean | undefined): boolean {
  if (parsed) return true;
  return process.argv.slice(2).includes(`--${name}`);
}

const configValue = stringOption("config", typeof values.config === "string" ? values.config : undefined);
const tagValue = stringOption("tag", typeof values.tag === "string" ? values.tag : undefined);
const instanceValue = stringOption("instance", typeof values.instance === "string" ? values.instance : undefined);
const verboseValue = booleanOption("verbose", typeof values.verbose === "boolean" ? values.verbose : undefined);

if (values.version) {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf-8"));
  console.log(`hive v${pkg.version}`);
  process.exit(0);
}

if (values.help || !command) {
  console.log(`
hive — AI agent platform

Usage:
  hive <command> [options]

Commands:
  init              Setup wizard (prereqs + config)
  start             Start Hive (foreground)
  start --daemon    Install + start as LaunchAgent
  stop              Stop LaunchAgent
  status            Health check
  update            Update engine to latest (or --tag=<tag>) and restart
  rollback          Restore the previous engine (.hive.prev) and restart
  migrate-0.2       Migrate a 0.1.x instance dir to the 0.2.0 layout
  doctor            Check prereqs, services, agent health
  plugin add <pkg>  Install a plugin package
  plugin list       List installed plugins
  plugin remove     Uninstall a plugin
  skill add <spec>  Install a skill from a registry
  skill list        List installed skills
  skill upgrade     Upgrade installed skills
  skill remove      Remove an installed skill
  skill sync        Sync customer-space skills with operatorSkillsRepo
  skill search      Search for skills
  registry add      Add a skill registry
  registry list     List configured registries
  registry remove   Remove a registry
  credentials list           Show third-party API keys (Honeypot)
  credentials add <KEY>      Set or rotate a credential
  credentials remove <KEY>   Delete a credential

Options:
  --config <path>   Path to hive.yaml
  -v, --version     Show version
  -h, --help        Show this help
`);
  process.exit(0);
}

const PKG_ROOT = resolve(import.meta.dirname, "..");

if (typeof configValue === "string") {
  const configPath = resolve(configValue);
  if (existsSync(configPath)) {
    const stat = statSync(configPath);
    process.env.HIVE_HOME = stat.isDirectory() ? configPath : resolve(configPath, "..");
  } else {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }
}

function resolveInstanceHome(instanceId: string): string | null {
  const userHome = process.env.HOME ?? "/tmp";
  const candidate = resolve(userHome, "services", "hive", instanceId);
  return existsSync(join(candidate, "hive.yaml")) ? candidate : null;
}

switch (command) {
  case "init": {
    const { runSetupWizard } = await import("./setup/init.js");
    await runSetupWizard(PKG_ROOT);
    break;
  }
  case "start": {
    const hiveHome = ensureHiveInstallOrExit();
    if (values.daemon) {
      const { startDaemon } = await import("./cli/daemon.js");
      await startDaemon(hiveHome);
    } else {
      const { execFileSync } = await import("node:child_process");
      const serverPath = existsSync(resolve(PKG_ROOT, "pkg", "server.min.js"))
        ? resolve(PKG_ROOT, "pkg", "server.min.js")
        : resolve(PKG_ROOT, "dist", "index.js");
      execFileSync(process.execPath, [serverPath], {
        stdio: "inherit",
        env: { ...process.env, HIVE_HOME: hiveHome },
      });
    }
    break;
  }
  case "stop": {
    const { stopDaemon } = await import("./cli/daemon.js");
    await stopDaemon(resolveCliHiveHome());
    break;
  }
  case "status": {
    const { showStatus } = await import("./cli/status.js");
    await showStatus();
    break;
  }
  case "update": {
    const { runUpdate } = await import("./cli/update.js");
    await runUpdate({
      tag: tagValue,
      instance: instanceValue,
    });
    break;
  }
  case "rollback": {
    const { runRollback } = await import("./cli/rollback.js");
    await runRollback({
      instance: instanceValue,
    });
    break;
  }
  case "migrate-0.2": {
    const instanceDir = positionals[1];
    if (!instanceDir) {
      console.error("Usage: hive migrate-0.2 [--dry-run] <instance_dir>");
      process.exit(2);
    }
    const dryRun = process.argv.includes("--dry-run");
    const { runMigrate } = await import("./cli/migrate.js");
    await runMigrate({ instanceDir, dryRun });
    break;
  }
  case "doctor": {
    if (!process.env.HIVE_HOME && typeof instanceValue === "string") {
      const instanceHome = resolveInstanceHome(instanceValue);
      if (instanceHome) {
        process.env.HIVE_HOME = instanceHome;
      }
    }
    const { runDoctor } = await import("./cli/doctor.js");
    await runDoctor({ verbose: verboseValue });
    break;
  }
  case "plugin": {
    const subcommand = positionals[1];
    const target = positionals[2];
    const { runPlugin } = await import("./cli/plugin.js");
    await runPlugin(subcommand, target);
    break;
  }
  case "skill": {
    const subcommand = positionals[1];
    const args = positionals.slice(2);
    const { runSkill } = await import("./cli/skill.js");
    await runSkill(subcommand, ...args);
    break;
  }
  case "registry": {
    const subcommand = positionals[1];
    const args = positionals.slice(2);
    const { runRegistry } = await import("./cli/registry.js");
    await runRegistry(subcommand, ...args);
    break;
  }
  case "credentials": {
    const subcommand = positionals[1];
    const args = positionals.slice(2);
    const { runCredentialsCommand } = await import("./cli/credentials.js");
    const code = await runCredentialsCommand(subcommand, args);
    process.exit(code);
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "hive --help" for usage.');
    process.exit(1);
}
