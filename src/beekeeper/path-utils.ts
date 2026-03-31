import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Validate that a path is a directory under the user's home directory.
 * Resolves symlinks before checking.
 * Returns the resolved absolute path, or throws with a descriptive error.
 */
export function validatePath(inputPath: string): string {
  const home = realpathSync(homedir());
  const expanded = inputPath.replace(/^~/, home);
  const absolute = resolve(expanded);

  let resolved: string;
  try {
    resolved = realpathSync(absolute);
  } catch {
    throw new Error(`Path does not exist: ${inputPath}`);
  }

  if (resolved !== home && !resolved.startsWith(home + "/")) {
    throw new Error(`Path is outside home directory: ${inputPath}`);
  }

  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${inputPath}`);
  }

  return resolved;
}
