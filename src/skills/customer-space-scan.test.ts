import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCustomerSpaceSkills, skillsFromSource } from "./customer-space-scan.js";

describe("scanCustomerSpaceSkills", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-scan-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(workflow: string, name: string, frontmatter: string) {
    const dir = join(root, workflow, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`);
  }

  it("returns empty array for missing root", () => {
    expect(scanCustomerSpaceSkills(join(root, "nonexistent"))).toEqual([]);
  });

  it("finds skills under workflow/skills/<name>/SKILL.md", () => {
    writeSkill("morning-briefing", "wakeup", "name: wakeup\ndescription: test");
    writeSkill("default", "helper", "name: helper\ndescription: test");

    const found = scanCustomerSpaceSkills(root);
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.name).sort()).toEqual(["helper", "wakeup"]);
  });

  it("parses origin frontmatter", () => {
    writeSkill(
      "default",
      "from-op",
      `name: from-op
description: test
origin:
  type: registry
  source: https://github.com/operator/skills
  base-version: abc123
  base-content-hash: deadbeef
  installed-at: 2026-04-28T00:00:00Z
  modified: false`,
    );

    const found = scanCustomerSpaceSkills(root);
    expect(found[0].origin?.source).toBe("https://github.com/operator/skills");
    expect(found[0].origin?.modified).toBe(false);
  });

  it("skips directories without SKILL.md", () => {
    mkdirSync(join(root, "default", "skills", "incomplete"), { recursive: true });
    expect(scanCustomerSpaceSkills(root)).toEqual([]);
  });

  it("skillsFromSource filters by origin URL", () => {
    writeSkill(
      "default",
      "a",
      "name: a\ndescription: test\norigin:\n  type: registry\n  source: https://op.git",
    );
    writeSkill(
      "default",
      "b",
      "name: b\ndescription: test\norigin:\n  type: registry\n  source: https://other.git",
    );

    const all = scanCustomerSpaceSkills(root);
    const filtered = skillsFromSource(all, "https://op.git");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("a");
  });
});
