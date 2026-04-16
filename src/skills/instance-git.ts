import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
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
 * Uses a temporary GIT_INDEX_FILE so we never switch branches or modify
 * the live working tree's index.
 */
export function commitToState(hiveHome: string, files: string[], message: string, authorName?: string): void {
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (!existsSync(gitDir)) {
    log.warn("Instance git not initialized — skipping state commit");
    return;
  }

  const tmpIndex = join(gitDir, "state-index.tmp");
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome, GIT_INDEX_FILE: tmpIndex };
  const gitPlumb = (...args: string[]): string =>
    execFileSync("git", [...args], { cwd: hiveHome, env, stdio: "pipe", encoding: "utf-8" }).trim();

  try {
    // Read the current state branch tree into the temp index
    gitPlumb("read-tree", "state");

    // Stage files into the temp index (reads from working tree via GIT_WORK_TREE)
    for (const file of files) {
      gitPlumb("add", "--force", "--", file);
    }

    // Remove common junk files that recursive add may have staged
    try {
      gitPlumb("rm", "--cached", "--ignore-unmatch", "-r", "--", "**/.DS_Store");
    } catch {
      // Ignore — no .DS_Store files staged
    }

    // Write a tree object from the temp index
    const tree = gitPlumb("write-tree");

    // Get current state branch tip as parent
    const parent = gitPlumb("rev-parse", "state");

    // Check if tree differs from parent's tree
    const parentTree = gitPlumb("rev-parse", "state^{tree}");
    if (tree === parentTree) {
      return; // Nothing changed
    }

    // Create the commit object
    const authorArg = authorName ? `${authorName} <${authorName}@hive>` : "hive <hive@localhost>";
    const commitArgs = ["commit-tree", tree, "-p", parent, "-m", message, "--author", authorArg];
    const commitSha = gitPlumb(...commitArgs);

    // Advance the state branch ref
    gitPlumb("update-ref", "refs/heads/state", commitSha);

    log.debug("State branch commit", { message, files: files.length });
  } catch (err) {
    log.warn("Failed to commit to state branch", {
      error: String(err),
      message,
    });
  } finally {
    try {
      if (existsSync(tmpIndex)) unlinkSync(tmpIndex);
    } catch {
      // best effort cleanup
    }
  }
}

/**
 * Commit a removal to the 'state' branch.
 * Uses a temporary GIT_INDEX_FILE so we never switch branches or modify
 * the live working tree's index.
 */
export function commitRemovalToState(hiveHome: string, files: string[], message: string): void {
  const gitDir = resolve(hiveHome, ".hive", "git");
  if (!existsSync(gitDir)) return;

  const tmpIndex = join(gitDir, "state-index.tmp");
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome, GIT_INDEX_FILE: tmpIndex };
  const gitPlumb = (...args: string[]): string =>
    execFileSync("git", [...args], { cwd: hiveHome, env, stdio: "pipe", encoding: "utf-8" }).trim();

  try {
    // Read the current state branch tree into the temp index
    gitPlumb("read-tree", "state");

    for (const file of files) {
      try {
        gitPlumb("rm", "-r", "--cached", "--", file);
      } catch {
        // File might not be tracked
      }
    }

    // Write a tree object from the temp index
    const tree = gitPlumb("write-tree");

    // Get current state branch tip as parent
    const parent = gitPlumb("rev-parse", "state");

    // Check if tree differs from parent's tree
    const parentTree = gitPlumb("rev-parse", "state^{tree}");
    if (tree === parentTree) {
      return; // Nothing changed
    }

    // Create the commit object
    const commitSha = gitPlumb("commit-tree", tree, "-p", parent, "-m", message);

    // Advance the state branch ref
    gitPlumb("update-ref", "refs/heads/state", commitSha);

    log.debug("State branch removal commit", { message });
  } catch (err) {
    log.warn("Failed to commit removal to state branch", {
      error: String(err),
    });
  } finally {
    try {
      if (existsSync(tmpIndex)) unlinkSync(tmpIndex);
    } catch {
      // best effort cleanup
    }
  }
}
