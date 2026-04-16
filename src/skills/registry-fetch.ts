import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, rmSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../logging/logger.js";

const log = createLogger("registry-fetch");

export interface CloneResult {
  dir: string;
  headSha: string;
  cleanup: () => void;
}

export function verifyGitAvailable(): void {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "git is required for skill installation but was not found. Install git and retry.",
    );
  }
}

export function shallowClone(url: string): CloneResult {
  const parent = mkdtempSync(join(tmpdir(), "hive-skill-install-"));
  const tmpDir = join(parent, "repo");
  const cleanup = () => {
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    execFileSync("git", ["clone", "--depth", "1", url, tmpDir], {
      stdio: "pipe",
      timeout: 60_000,
    });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    log.debug("Shallow clone complete", { url, headSha });
    return { dir: tmpDir, headSha, cleanup };
  } catch (err) {
    cleanup();
    throw new Error(`registry fetch failed: ${String(err)}`);
  }
}

export function partialClone(url: string): CloneResult {
  const parent = mkdtempSync(join(tmpdir(), "hive-skill-upgrade-"));
  const tmpDir = join(parent, "repo");
  const cleanup = () => {
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    try {
      execFileSync(
        "git",
        ["clone", "--filter=blob:none", "--no-checkout", url, tmpDir],
        { stdio: "pipe", timeout: 120_000 },
      );
      // Checkout HEAD so files are available
      execFileSync("git", ["checkout"], { cwd: tmpDir, stdio: "pipe" });
    } catch {
      rmSync(tmpDir, { recursive: true, force: true });
      execFileSync("git", ["clone", url, tmpDir], {
        stdio: "pipe",
        timeout: 120_000,
      });
    }

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: tmpDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    log.debug("Partial clone complete", { url, headSha });
    return { dir: tmpDir, headSha, cleanup };
  } catch (err) {
    cleanup();
    throw new Error(`registry fetch failed: ${String(err)}`);
  }
}

export function lsRemoteHead(url: string): string {
  const output = execFileSync("git", ["ls-remote", url, "HEAD"], {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
  const sha = output.split("\t")[0];
  if (!sha) throw new Error(`Could not determine HEAD for ${url}`);
  return sha;
}

export function listSkillsInClone(cloneDir: string): string[] {
  const skillsPath = join(cloneDir, "skills");
  if (!existsSync(skillsPath)) return [];
  return readdirSync(skillsPath).filter((entry) => {
    try {
      const full = join(skillsPath, entry);
      return (
        statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"))
      );
    } catch {
      return false;
    }
  });
}

export function checkoutSha(cloneDir: string, sha: string): void {
  execFileSync("git", ["checkout", sha], { cwd: cloneDir, stdio: "pipe" });
}

export function findTagForSha(
  cloneDir: string,
  sha: string,
): string | undefined {
  try {
    const tag = execFileSync(
      "git",
      ["describe", "--tags", "--exact-match", sha],
      {
        cwd: cloneDir,
        stdio: "pipe",
        encoding: "utf-8",
      },
    ).trim();
    return tag || undefined;
  } catch {
    return undefined;
  }
}
