import { existsSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";

/**
 * Entries mirror package.json `files` plus package.json itself (which npm
 * always includes in a pack tarball but isn't listed in `files`). One path
 * per line. `scripts/honeypot` is a single binary (not the whole scripts/
 * dir), so the rsync must operate on that exact path.
 *
 * Must match Phase 3's `fetch_engine` tarball shape byte-for-byte so `hive
 * update` and `hive init` land on identical `.hive/` layouts. If the package
 * `files` field changes, update both here and deploy.sh's fetch_engine at
 * the same time.
 */
export const PACKAGE_ENTRIES = ["pkg", "seeds", "templates", "scripts/honeypot", "package.json"] as const;

export interface PopulateEngineOptions {
  /**
   * Skip the `npm install --omit=dev` step. Intended for unit tests that
   * don't want the registry round-trip or for callers that will install
   * deps themselves.
   */
  skipInstall?: boolean;
}

/**
 * Copies the running CLI's package contents into `<instance>/.hive/` and
 * installs runtime dependencies locally so the bundle's externals resolve.
 * Intended for the `hive init` wizard's bundled path only — non-bundled
 * dev installs have no `pkg/` to copy.
 *
 * The bundle keeps ~14 runtime externals (native modules, large SDKs with
 * dynamic internals, libs with asset loading) because bundling them in is
 * either impossible or breaks at runtime. Those externals must be resolvable
 * from `.hive/pkg/`, so we `npm install --omit=dev` inside `.hive/` after the
 * copy. Node's module resolution walks up from `.hive/pkg/server.min.js` to
 * `.hive/node_modules/` and finds the deps.
 *
 * Throws if `.hive/` already exists: the wizard's upstream `existingInstall()`
 * check is scoped to `hive.yaml`; this is defense-in-depth to avoid silently
 * clobbering a partially-populated engine dir.
 */
export function populateEngine(pkgRoot: string, instanceDir: string, opts: PopulateEngineOptions = {}): void {
  const engineDir = resolve(instanceDir, ".hive");
  if (existsSync(engineDir)) {
    throw new Error(
      `Engine already populated at ${engineDir}. If this is a resume after an ` +
        `interrupted init, rm -rf ${engineDir} and re-run 'hive init'. ` +
        `populateEngine does not silently overwrite.`,
    );
  }
  mkdirSync(engineDir, { recursive: true });

  for (const entry of PACKAGE_ENTRIES) {
    const src = resolve(pkgRoot, entry);
    if (!existsSync(src)) continue;
    const dst = resolve(engineDir, entry);
    mkdirSync(dirname(dst), { recursive: true });

    const isDir = statSync(src).isDirectory();
    const srcArg = isDir ? `${src}/` : src;
    const dstArg = isDir ? `${dst}/` : dst;
    if (isDir) mkdirSync(dst, { recursive: true });
    execFileSync("rsync", ["-a", srcArg, dstArg]);
  }

  if (opts.skipInstall) return;
  if (!existsSync(resolve(engineDir, "package.json"))) return;

  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-progress"], {
    cwd: engineDir,
    stdio: "inherit",
  });
}
