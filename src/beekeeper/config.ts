import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BeekeeperConfig } from "./types.js";

export function loadConfig(): BeekeeperConfig {
  const configPath = resolve(process.env.BEEKEEPER_CONFIG ?? "./beekeeper.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`Beekeeper config not found: ${configPath}`);
  }

  const raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;

  const authToken = process.env.BEEKEEPER_AUTH_TOKEN;
  if (!authToken) {
    throw new Error("Missing required env var: BEEKEEPER_AUTH_TOKEN");
  }

  // Expand ~ in workspace paths
  const workspaces: Record<string, string> = {};
  const rawWorkspaces = (raw.workspaces ?? {}) as Record<string, string>;
  for (const [name, path] of Object.entries(rawWorkspaces)) {
    workspaces[name] = path.replace(/^~/, process.env.HOME ?? "");
  }

  return {
    port: (raw.port as number) ?? 3099,
    defaultWorkspace: (raw.default_workspace as string) ?? "hive",
    model: (raw.model as string) ?? "claude-opus-4-5-20250514",
    workspaces,
    confirmOperations: (raw.confirm_operations as string[]) ?? [
      "git push --force",
      "git branch -D",
      "rm -rf",
      "rm -r",
      "git reset --hard",
      "git checkout -- .",
      "git clean -f",
    ],
    authToken,
  };
}
