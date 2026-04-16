#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
    daemon: { type: "boolean", default: false },
    config: { type: "string" },
    version: { type: "boolean", short: "v", default: false },
  },
});

const command = positionals[0];

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
  update            Stop → update package → restart
  doctor            Check prereqs, services, agent health
  plugin add <pkg>  Install a plugin package
  plugin list       List installed plugins
  plugin remove     Uninstall a plugin
  skill add <spec>  Install a skill from a registry
  skill list        List installed skills
  skill upgrade     Upgrade installed skills
  skill remove      Remove an installed skill
  skill search      Search for skills
  registry add      Add a skill registry
  registry list     List configured registries
  registry remove   Remove a registry

Options:
  --config <path>   Path to hive.yaml
  -v, --version     Show version
  -h, --help        Show this help
`);
  process.exit(0);
}

const PKG_ROOT = resolve(import.meta.dirname, "..");

if (values.config) {
  const configPath = resolve(values.config);
  if (existsSync(configPath)) {
    const stat = statSync(configPath);
    process.env.HIVE_HOME = stat.isDirectory() ? configPath : resolve(configPath, "..");
  } else {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }
}

switch (command) {
  case "init": {
    const { runSetupWizard } = await import("./setup/init.js");
    await runSetupWizard(PKG_ROOT);
    break;
  }
  case "start": {
    if (values.daemon) {
      const { startDaemon } = await import("./cli/daemon.js");
      await startDaemon(PKG_ROOT);
    } else {
      const { execFileSync } = await import("node:child_process");
      const serverPath = existsSync(resolve(PKG_ROOT, "pkg", "server.min.js"))
        ? resolve(PKG_ROOT, "pkg", "server.min.js")
        : resolve(PKG_ROOT, "dist", "index.js");
      execFileSync(process.execPath, [serverPath], {
        stdio: "inherit",
        env: { ...process.env, HIVE_HOME: process.env.HIVE_HOME ?? "" },
      });
    }
    break;
  }
  case "stop": {
    const { stopDaemon } = await import("./cli/daemon.js");
    await stopDaemon();
    break;
  }
  case "status": {
    const { showStatus } = await import("./cli/status.js");
    await showStatus();
    break;
  }
  case "update": {
    const { runUpdate } = await import("./cli/update.js");
    await runUpdate();
    break;
  }
  case "doctor": {
    const { runDoctor } = await import("./cli/doctor.js");
    await runDoctor();
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
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "hive --help" for usage.');
    process.exit(1);
}
