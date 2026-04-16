import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "../logging/logger.js";

const log = createLogger("instance-git");

/**
 * Initialize the instance-local git repo if not already present.
 * Creates .hive/git with `installed` and `state` branches.
 *
 * Uses a SEPARATE git dir at `.hive/git` (via GIT_DIR env var)
 * to avoid conflicts with any existing `.git` at hiveHome.
 */
export function initInstanceGit(hiveHome: string): void {
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (existsSync(gitDir)) return; // Already initialized

  mkdirSync(resolve(hiveHome, ".hive"), { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", [...args], {
      cwd: hiveHome,
      env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome },
      stdio: "pipe",
    });

  git("init");
  git("config", "user.name", "hive-instance");
  git("config", "user.email", "hive@localhost");

  // Create initial empty commit on 'installed' branch
  git("checkout", "-b", "installed");
  git("commit", "--allow-empty", "-m", "init: installed branch");

  // Create 'state' branch from the same root
  git("checkout", "-b", "state");
  git("commit", "--allow-empty", "-m", "init: state branch");

  log.info("Instance-local git initialized", { gitDir });
}

/**
 * Helper to run git commands against the instance-local repo.
 */
function gitCmd(hiveHome: string, ...args: string[]): string {
  const gitDir = resolve(hiveHome, ".hive", "git");
  return execFileSync("git", [...args], {
    cwd: hiveHome,
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome },
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

/**
 * Commit a file change to the 'state' branch.
 * Used by the write guard and install/upgrade/remove flows.
 */
export function commitToState(
  hiveHome: string,
  files: string[],
  message: string,
  authorName?: string,
): void {
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (!existsSync(gitDir)) {
    log.warn("Instance git not initialized — skipping state commit");
    return;
  }

  try {
    const branch = gitCmd(hiveHome, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "state") {
      gitCmd(hiveHome, "checkout", "state");
    }

    for (const file of files) {
      gitCmd(hiveHome, "add", "--force", file);
    }

    // Check if there's anything to commit
    try {
      gitCmd(hiveHome, "diff", "--cached", "--quiet");
      return; // Nothing staged
    } catch {
      // diff --quiet exits non-zero when there are staged changes — expected
    }

    const authorArg = authorName
      ? `${authorName} <${authorName}@hive>`
      : "hive <hive@localhost>";
    gitCmd(hiveHome, "commit", "--author", authorArg, "-m", message);
    log.debug("State branch commit", { message, files: files.length });
  } catch (err) {
    log.warn("Failed to commit to state branch", {
      error: String(err),
      message,
    });
  }
}

/**
 * Commit a removal to the 'state' branch.
 */
export function commitRemovalToState(
  hiveHome: string,
  files: string[],
  message: string,
): void {
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (!existsSync(gitDir)) return;

  try {
    const branch = gitCmd(hiveHome, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "state") gitCmd(hiveHome, "checkout", "state");

    for (const file of files) {
      try {
        gitCmd(hiveHome, "rm", "-r", "--cached", file);
      } catch {
        // File might not be tracked
      }
    }

    try {
      gitCmd(hiveHome, "diff", "--cached", "--quiet");
      return;
    } catch {
      // Has staged changes
    }

    gitCmd(hiveHome, "commit", "-m", message);
    log.debug("State branch removal commit", { message });
  } catch (err) {
    log.warn("Failed to commit removal to state branch", {
      error: String(err),
    });
  }
}
