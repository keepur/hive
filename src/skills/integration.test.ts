import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill } from "./install.js";
import { upgradeSkill } from "./upgrade.js";
import { removeSkill } from "./remove.js";
import { initInstanceGit } from "./instance-git.js";
import { parseFrontmatter } from "./frontmatter.js";
import { loadSkillIndex, getSkillsForAgent } from "../agents/skill-loader.js";

/**
 * Create a local file:// git repo that acts as a mock skill registry.
 * Returns the file:// URL and the repo directory path.
 */
function createMockRegistry(
  tmp: string,
  skills: {
    name: string;
    workflow?: string;
    agents?: string;
    content?: string;
  }[],
): { url: string; repoDir: string } {
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
      `agents: [${skill.agents ?? "all"}]`,
      ...(skill.workflow ? [`workflow: ${skill.workflow}`] : []),
      "---",
      "",
      `# ${skill.name}`,
      skill.content ?? "Initial content",
    ].join("\n");
    writeFileSync(join(skillDir, "SKILL.md"), fm);
  }

  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: repoDir,
    stdio: "pipe",
  });

  return { url: `file://${repoDir}`, repoDir };
}

/**
 * Update a skill in the mock registry and commit.
 */
function updateRegistrySkill(
  repoDir: string,
  skillName: string,
  newContent: string,
): void {
  const skillMdPath = join(repoDir, "skills", skillName, "SKILL.md");
  const existing = readFileSync(skillMdPath, "utf-8");
  // Replace just the body content after the frontmatter
  const fmEnd = existing.indexOf("---", 4);
  const frontmatter = existing.slice(0, fmEnd + 3);
  writeFileSync(skillMdPath, `${frontmatter}\n\n# ${skillName}\n${newContent}`);

  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", `update ${skillName}`], {
    cwd: repoDir,
    stdio: "pipe",
  });
}

describe("skills integration: install → upgrade → remove", () => {
  let tmp: string;
  let targetSkillsDir: string;
  let targetHiveHome: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-integration-test-"));
    targetHiveHome = join(tmp, "hive-home");
    targetSkillsDir = join(targetHiveHome, "skills");
    mkdirSync(targetSkillsDir, { recursive: true });
    initInstanceGit(targetHiveHome);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("install → list → upgrade → remove", async () => {
    // --- Setup: create a registry with one skill ---
    const { url, repoDir } = createMockRegistry(tmp, [
      {
        name: "greet-customer",
        workflow: "customer-support",
        agents: "customer-success",
        content: "Greet the customer warmly.",
      },
    ]);

    // --- Step 1: Install the skill ---
    const result = installSkill(
      url,
      "greet-customer",
      targetSkillsDir,
      targetHiveHome,
    );

    expect(result.name).toBe("greet-customer");
    expect(result.workflow).toBe("customer-support");

    // --- Step 2: Verify projection into workflow directory ---
    const expectedPath = join(
      targetSkillsDir,
      "customer-support",
      "skills",
      "greet-customer",
    );
    expect(result.targetPath).toBe(expectedPath);
    expect(existsSync(join(expectedPath, "SKILL.md"))).toBe(true);

    // --- Step 3: Verify origin metadata ---
    const installedContent = readFileSync(
      join(expectedPath, "SKILL.md"),
      "utf-8",
    );
    const { frontmatter } = parseFrontmatter(installedContent);

    expect(frontmatter.origin).toBeDefined();
    expect(frontmatter.origin!.type).toBe("registry");
    expect(frontmatter.origin!.source).toBe(url);
    expect(frontmatter.origin!["base-content-hash"]).toBeTruthy();
    expect(frontmatter.origin!["base-version"]).toBe(result.version);
    expect(frontmatter.origin!.modified).toBe(false);

    // --- Step 4: Load skill index and verify agent assignment ---
    const index = loadSkillIndex(targetSkillsDir);
    const csSkills = getSkillsForAgent(index, "customer-success");
    expect(csSkills.length).toBeGreaterThan(0);
    expect(csSkills.some((s) => s.path.includes("customer-support"))).toBe(
      true,
    );

    // Agent not in the list should not get this skill (it's not "all")
    const otherSkills = getSkillsForAgent(index, "sdr");
    expect(otherSkills.length).toBe(0);

    // --- Step 5: Simulate upgrade ---
    updateRegistrySkill(
      repoDir,
      "greet-customer",
      "Greet the customer warmly and ask how their day is going.",
    );

    const upgradeResult = await upgradeSkill(
      "greet-customer",
      targetSkillsDir,
      targetHiveHome,
      async () => "take" as const,
    );

    expect(upgradeResult.action).toBe("applied");
    expect(upgradeResult.newVersion).toBeTruthy();
    expect(upgradeResult.newVersion).not.toBe(upgradeResult.oldVersion);

    // --- Step 6: Verify content was updated ---
    const upgradedContent = readFileSync(
      join(expectedPath, "SKILL.md"),
      "utf-8",
    );
    expect(upgradedContent).toContain("ask how their day is going");

    const { frontmatter: upgradedFm } = parseFrontmatter(upgradedContent);
    expect(upgradedFm.origin!["base-version"]).toBe(upgradeResult.newVersion);

    // --- Step 7: Remove the skill ---
    await removeSkill("greet-customer", targetSkillsDir, targetHiveHome, {
      force: true,
    });

    // --- Step 8: Verify the skill directory is gone ---
    expect(existsSync(expectedPath)).toBe(false);

    // The entire workflow directory should also be cleaned up (no other skills in it)
    expect(existsSync(join(targetSkillsDir, "customer-support"))).toBe(false);
  });
});
