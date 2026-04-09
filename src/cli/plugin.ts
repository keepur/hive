import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hiveHome } from "../paths.js";

const pluginsDir = resolve(hiveHome, "plugins");

export async function runPlugin(subcommand?: string, target?: string): Promise<void> {
  switch (subcommand) {
    case "add": {
      if (!target) { console.error("Usage: hive plugin add <package-name>"); process.exit(1); }
      mkdirSync(pluginsDir, { recursive: true });
      const pkgJsonPath = resolve(pluginsDir, "package.json");
      if (!existsSync(pkgJsonPath)) execFileSync("npm", ["init", "-y"], { cwd: pluginsDir, stdio: "pipe" });
      console.log(`Installing ${target}...`);
      execFileSync("npm", ["install", target], { cwd: pluginsDir, stdio: "inherit" });
      console.log(`Installed ${target}`);
      break;
    }
    case "list": {
      if (!existsSync(pluginsDir)) { console.log("No plugins installed."); return; }
      const pkgJsonPath = resolve(pluginsDir, "package.json");
      if (!existsSync(pkgJsonPath)) { console.log("No plugins installed."); return; }
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const deps = pkg.dependencies ?? {};
      if (Object.keys(deps).length === 0) { console.log("No plugins installed."); return; }
      console.log("Installed plugins:");
      for (const [name, version] of Object.entries(deps)) console.log(`  ${name}@${version}`);
      break;
    }
    case "remove": {
      if (!target) { console.error("Usage: hive plugin remove <package-name>"); process.exit(1); }
      if (!existsSync(pluginsDir)) { console.error("No plugins directory found."); process.exit(1); }
      console.log(`Removing ${target}...`);
      execFileSync("npm", ["uninstall", target], { cwd: pluginsDir, stdio: "inherit" });
      console.log(`Removed ${target}`);
      break;
    }
    default:
      console.error("Usage: hive plugin <add|list|remove> [package]");
      process.exit(1);
  }
}
