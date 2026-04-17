import { readConfig, writeConfig, configPath } from "./hive-config.js";

export async function runRegistry(subcommand?: string, ...args: string[]): Promise<void> {
  const cfgPath = configPath();

  switch (subcommand) {
    case "add": {
      const url = args[0];
      if (!url) {
        console.error("Usage: hive registry add <url> [--as <name>] [--default]");
        process.exit(1);
      }

      const asIdx = args.indexOf("--as");
      const name = asIdx >= 0 && args[asIdx + 1] ? args[asIdx + 1] : inferName(url);
      const isDefault = args.includes("--default");

      const config = readConfig(cfgPath);
      if (!config.skillRegistries) config.skillRegistries = [];

      if (config.skillRegistries.some((r: { name: string }) => r.name === name)) {
        console.error(`Registry "${name}" already exists.`);
        process.exit(1);
      }

      if (isDefault) {
        for (const r of config.skillRegistries) delete r.default;
      }

      config.skillRegistries.push({ name, url, ...(isDefault ? { default: true } : {}) });
      writeConfig(config, cfgPath);
      console.log(`Added registry "${name}" (${url})${isDefault ? " [default]" : ""}`);
      break;
    }

    case "list": {
      const config = readConfig(cfgPath);
      const registries = config.skillRegistries ?? [];

      if (registries.length === 0) {
        console.log("No registries configured. Using built-in default: https://github.com/keepur/hive-skills");
        return;
      }

      console.log("Configured registries:\n");
      for (const r of registries) {
        const marker = r.default ? " (default)" : "";
        console.log(`  ${r.name}${marker}`);
        console.log(`    ${r.url}`);
      }
      break;
    }

    case "remove": {
      const name = args[0];
      if (!name) {
        console.error("Usage: hive registry remove <name>");
        process.exit(1);
      }

      const config = readConfig(cfgPath);
      if (!config.skillRegistries) {
        console.error("No registries configured.");
        process.exit(1);
      }

      const idx = config.skillRegistries.findIndex((r: { name: string }) => r.name === name);
      if (idx < 0) {
        console.error(`Registry "${name}" not found.`);
        process.exit(1);
      }

      config.skillRegistries.splice(idx, 1);
      writeConfig(config, cfgPath);
      console.log(`Removed registry "${name}". Installed skills from this registry are unaffected.`);
      break;
    }

    default:
      console.error("Usage: hive registry <add|list|remove>");
      process.exit(1);
  }
}

function inferName(url: string): string {
  const cleaned = url.replace(/\.git$/, "").replace(/\/$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts
    .slice(-2)
    .join("-")
    .replace(/^github\.com-/, "");
}
