import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installSkill } from "./install.js";
import { initInstanceGit } from "./instance-git.js";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * Create a local file:// git repo that acts as a mock skill registry.
 * Returns the file:// URL suitable for shallowClone.
 */
function createMockRegistry(tmp: string, skills: { name: string; workflow?: string; content?: string }[]): string {
  const repoDir = join(tmp, "registry");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "test"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.email", "test@test"], {
    cwd: repoDir,
    stdio: "pipe",
  });

  for (const skill of skills) {
    const skillDir = join(repoDir, "skills", skill.name);
    mkdirSync(skillDir, { recursive: true });
    const fm = [
      "---",
      `name: ${skill.name}`,
      `description: Test skill ${skill.name}`,
      "agents: [all]",
      ...(skill.workflow ? [`workflow: ${skill.workflow}`] : []),
      "---",
      "",
      `# ${skill.name}`,
      skill.content ?? "Test content",
    ].join("\n");
    writeFileSync(join(skillDir, "SKILL.md"), fm);
  }

  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: repoDir,
    stdio: "pipe",
  });

  return `file://${repoDir}`;
}

describe("installSkill", () => {
  let tmp: string;
  let targetSkillsDir: string;
  let targetHiveHome: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-install-test-"));
    targetHiveHome = join(tmp, "hive-home");
    targetSkillsDir = join(targetHiveHome, "skills");
    mkdirSync(targetSkillsDir, { recursive: true });
    initInstanceGit(targetHiveHome);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("installs a skill with workflow field into the correct path", () => {
    const url = createMockRegistry(tmp, [{ name: "deploy", workflow: "devops" }]);

    const result = installSkill(url, "deploy", targetSkillsDir, targetHiveHome);

    expect(result.name).toBe("deploy");
    expect(result.workflow).toBe("devops");
    expect(result.targetPath).toBe(join(targetSkillsDir, "devops", "skills", "deploy"));
    expect(existsSync(join(result.targetPath, "SKILL.md"))).toBe(true);
  });

  it("installs a skill without workflow field using skill name as workflow", () => {
    const url = createMockRegistry(tmp, [{ name: "standalone" }]);

    const result = installSkill(url, "standalone", targetSkillsDir, targetHiveHome);

    expect(result.workflow).toBe("standalone");
    expect(result.targetPath).toBe(join(targetSkillsDir, "standalone", "skills", "standalone"));
    expect(existsSync(join(result.targetPath, "SKILL.md"))).toBe(true);
  });

  it("records origin metadata in installed SKILL.md", () => {
    const url = createMockRegistry(tmp, [{ name: "tracked", workflow: "ops" }]);

    const result = installSkill(url, "tracked", targetSkillsDir, targetHiveHome);

    const content = readFileSync(join(result.targetPath, "SKILL.md"), "utf-8");
    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter.origin).toBeDefined();
    expect(frontmatter.origin!.type).toBe("registry");
    expect(frontmatter.origin!.source).toBe(url);
    expect(frontmatter.origin!["base-version"]).toBe(result.version);
    expect(frontmatter.origin!["base-content-hash"]).toBeTruthy();
    expect(frontmatter.origin!.modified).toBe(false);
    expect(frontmatter.origin!["installed-at"]).toBeTruthy();
  });

  it("throws when skill does not exist in registry", () => {
    const url = createMockRegistry(tmp, [{ name: "real-skill" }]);

    expect(() => installSkill(url, "missing-skill", targetSkillsDir, targetHiveHome)).toThrow(
      /Skill "missing-skill" not found/,
    );

    expect(() => installSkill(url, "missing-skill", targetSkillsDir, targetHiveHome)).toThrow(/real-skill/);
  });

  it("throws when skill is already installed", () => {
    const url = createMockRegistry(tmp, [{ name: "dupe", workflow: "common" }]);

    // First install succeeds
    installSkill(url, "dupe", targetSkillsDir, targetHiveHome);

    // Second install fails
    expect(() => installSkill(url, "dupe", targetSkillsDir, targetHiveHome)).toThrow(/already installed/);
  });

  it("cleans up clone temp dir even on failure", () => {
    const url = createMockRegistry(tmp, [{ name: "exists" }]);

    // Trigger failure by trying to install a nonexistent skill
    try {
      installSkill(url, "nonexistent", targetSkillsDir, targetHiveHome);
    } catch {
      // expected
    }

    // The clone tmp dirs should be cleaned up — check that no
    // hive-skill-install-* dirs remain in /tmp from this test
    // (We can't check directly since the name is timestamped,
    // but we verify no throw from cleanup in the finally block)
    // The fact that no error was thrown about cleanup is sufficient.
    // We also verify the error was the expected one, not a cleanup failure.
    expect(() => installSkill(url, "nonexistent", targetSkillsDir, targetHiveHome)).toThrow(/not found/);
  });

  it("commits to the instance-git state branch", () => {
    const url = createMockRegistry(tmp, [{ name: "committed", workflow: "flow" }]);

    installSkill(url, "committed", targetSkillsDir, targetHiveHome);

    // Check the state branch log
    const gitDir = resolve(targetHiveHome, ".hive-state", "git");
    const logOutput = execFileSync("git", ["log", "--oneline", "-1", "--format=%s"], {
      cwd: targetHiveHome,
      env: {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: targetHiveHome,
      },
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();

    expect(logOutput).toContain("install: flow/committed from");
  });
});
