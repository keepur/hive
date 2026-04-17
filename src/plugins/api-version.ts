import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "../logging/logger.js";

const log = createLogger("api-version");

/**
 * Hive plugin API version. Plugins declare a compatibility range in their
 * plugin.yaml under `hiveApi:` (e.g. "^1.0.0"). The loader skips plugins
 * whose declared range does not include this version. Bump the major in
 * package.json when a change to the plugin contract (manifest schema,
 * agent-env resolver, base env var set) breaks existing plugins.
 *
 * Source of truth: the top-level `hiveApi` field in the package's
 * package.json. Read at module load; falls back to "1.0.0" only if
 * package.json cannot be located (unusual environments like ad-hoc
 * bundles without a sibling manifest).
 */
function readHiveApiFromPackageJson(): string | null {
  const candidates = [
    // dev / built: src/plugins/ (or dist/plugins/) → repo root
    resolve(import.meta.dirname, "..", "..", "package.json"),
    // bundled: pkg/ → package root
    resolve(import.meta.dirname, "..", "package.json"),
  ];
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf-8"));
      if (pkg?.name === "@keepur/hive" && typeof pkg.hiveApi === "string") {
        return pkg.hiveApi;
      }
    } catch {
      continue;
    }
  }
  return null;
}

const resolved = readHiveApiFromPackageJson();
if (!resolved) {
  log.warn("Could not read hiveApi from package.json; falling back to 1.0.0");
}

export const HIVE_PLUGIN_API_VERSION: string = resolved ?? "1.0.0";
