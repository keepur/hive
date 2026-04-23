import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { engineDir, hiveHome } from "../paths.js";

/**
 * One-shot relocation for beta customers whose `hive plugin add` (on a 0.2.0
 * pre-release) landed plugins at `<engineDir>/plugins/node_modules/` instead
 * of `<hiveHome>/plugins/node_modules/`. Must run before deploy.sh wipes
 * `.hive/` — otherwise the misrouted plugins are lost.
 *
 * Idempotent: returns early if there's nothing to move.
 */
export function relocateBetaPlugins(
  hive: string = hiveHome,
  engine: string = engineDir,
): { moved: string[]; skipped: boolean } {
  const srcDir = resolve(engine, "plugins", "node_modules");
  const dstDir = resolve(hive, "plugins", "node_modules");

  if (!existsSync(srcDir)) return { moved: [], skipped: true };

  const entries = readdirSync(srcDir);
  if (entries.length === 0) return { moved: [], skipped: true };

  mkdirSync(dstDir, { recursive: true });
  const moved: string[] = [];
  for (const name of entries) {
    const src = resolve(srcDir, name);
    const dst = resolve(dstDir, name);
    if (existsSync(dst)) {
      // Already relocated once, or a fresh-install overlap. Leave the
      // hive-home copy as canonical; remove the engine-dir copy.
      continue;
    }
    renameSync(src, dst);
    moved.push(name);
  }
  return { moved, skipped: false };
}
