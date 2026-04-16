import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  initInstanceGit,
  commitToState,
  commitRemovalToState,
} from "./instance-git.js";

/** Helper to run git commands against the test instance repo. */
function git(hiveHome: string, ...args: string[]): string {
  const gitDir = resolve(hiveHome, ".hive", "git");
  return execFileSync("git", [...args], {
    cwd: hiveHome,
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: hiveHome },
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

describe("instance-git", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "instance-git-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("initInstanceGit creates .hive/git with both branches", () => {
    initInstanceGit(tmp);

    const gitDir = resolve(tmp, ".hive", "git");
    expect(existsSync(gitDir)).toBe(true);

    const branches = git(tmp, "branch", "--list");
    expect(branches).toContain("installed");
    expect(branches).toContain("state");
  });

  it("initInstanceGit is idempotent", () => {
    initInstanceGit(tmp);
    initInstanceGit(tmp);

    const branches = git(tmp, "branch", "--list");
    expect(branches).toContain("installed");
    expect(branches).toContain("state");
  });

  it("commitToState creates a commit with correct message and author", () => {
    initInstanceGit(tmp);

    const skillDir = join(tmp, "skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Test skill");

    commitToState(
      tmp,
      ["skills/test-skill/SKILL.md"],
      "install: test-skill@1.0.0",
      "admin",
    );

    const logOutput = git(tmp, "log", "--oneline", "-1", "--format=%s|%an");
    const [subject, author] = logOutput.split("|");
    expect(subject).toBe("install: test-skill@1.0.0");
    expect(author).toBe("admin");
  });

  it("commitToState is a no-op when nothing changed", () => {
    initInstanceGit(tmp);

    const skillDir = join(tmp, "skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Test skill");

    commitToState(tmp, ["skills/test-skill/SKILL.md"], "first commit");
    commitToState(tmp, ["skills/test-skill/SKILL.md"], "duplicate commit");

    // Should have init commit + 1 real commit = 2 total on state branch
    const logOutput = git(tmp, "log", "--oneline");
    const lines = logOutput.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3); // 2 init commits + first commit
  });

  it("commitToState handles uninitialized repo gracefully", () => {
    // Should not throw — just warns and returns
    expect(() =>
      commitToState(tmp, ["skills/foo/SKILL.md"], "should not throw"),
    ).not.toThrow();
  });

  it("commitRemovalToState records file removals", () => {
    initInstanceGit(tmp);

    // Add a file first
    const skillDir = join(tmp, "skills", "doomed");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Doomed skill");
    commitToState(tmp, ["skills/doomed/SKILL.md"], "install: doomed");

    // Remove the file from disk
    unlinkSync(join(skillDir, "SKILL.md"));

    commitRemovalToState(
      tmp,
      ["skills/doomed/SKILL.md"],
      "remove: doomed skill",
    );

    const logOutput = git(tmp, "log", "--oneline");
    const lines = logOutput.split("\n").filter(Boolean);
    // 2 init commits + install + removal = 4
    expect(lines).toHaveLength(4);
    expect(logOutput).toContain("remove: doomed skill");
  });
});
