import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface MigrateOptions {
  instanceDir: string;
  dryRun?: boolean;
}

/**
 * Shell out to install/migrate-0.2.sh shipped with the engine package.
 * Customers can also `curl | bash` the script directly — this is just the
 * typed CLI surface for convenience.
 */
export async function runMigrate(opts: MigrateOptions): Promise<void> {
  // Locate migrate-0.2.sh relative to this module. At runtime it lives at
  // <engine>/install/migrate-0.2.sh (bundled install) or
  // <repo>/install/migrate-0.2.sh (dev install).
  const here = fileURLToPath(import.meta.url);
  // here = .../pkg/cli.min.js (bundled) or .../dist/cli/migrate.js (dev)
  // Walk up to the package root.
  const pkgRoot = resolve(here, "..", "..");
  const script = resolve(pkgRoot, "install", "migrate-0.2.sh");

  if (!existsSync(script)) {
    console.error(`migrate-0.2.sh not found at ${script}`);
    console.error("Falling back to the standalone: curl https://.../migrate-0.2.sh | bash -s --");
    process.exit(1);
  }

  const args = opts.dryRun ? ["--dry-run", opts.instanceDir] : [opts.instanceDir];
  try {
    execFileSync("bash", [script, ...args], { stdio: "inherit" });
  } catch {
    process.exit(1);
  }
}
