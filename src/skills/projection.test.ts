import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWorkflow, projectToRuntime } from "./projection.js";

describe("extractWorkflow", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "projection-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns workflow field from SKILL.md frontmatter", () => {
    const skillDir = join(tmp, "sales-standup-prep");
    mkdirSync(skillDir, { recursive: true });
    const skillMd = join(skillDir, "SKILL.md");
    writeFileSync(
      skillMd,
      `---
name: sales-standup-prep
description: Prep for daily standup
agents: [milo]
workflow: morning-briefing
---

# Sales Standup Prep
`,
    );
    expect(extractWorkflow(skillMd, "sales-standup-prep")).toBe(
      "morning-briefing",
    );
  });

  it("falls back to skill name when no workflow field", () => {
    const skillDir = join(tmp, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillMd = join(skillDir, "SKILL.md");
    writeFileSync(
      skillMd,
      `---
name: my-skill
description: A skill without workflow
agents: [all]
---

# My Skill
`,
    );
    expect(extractWorkflow(skillMd, "my-skill")).toBe("my-skill");
  });

  it("falls back to skill name when no frontmatter", () => {
    const skillDir = join(tmp, "no-frontmatter");
    mkdirSync(skillDir, { recursive: true });
    const skillMd = join(skillDir, "SKILL.md");
    writeFileSync(skillMd, "# Just a plain markdown file\n\nNo frontmatter here.\n");
    expect(extractWorkflow(skillMd, "no-frontmatter")).toBe("no-frontmatter");
  });
});

describe("projectToRuntime", () => {
  it("maps skill name and workflow to nested runtime path", () => {
    expect(
      projectToRuntime("/inst/skills", "morning-briefing", "sales-standup-prep"),
    ).toBe("/inst/skills/morning-briefing/skills/sales-standup-prep");
  });

  it("handles degenerate case where workflow equals skill name", () => {
    expect(projectToRuntime("/inst/skills", "my-skill", "my-skill")).toBe(
      "/inst/skills/my-skill/skills/my-skill",
    );
  });
});
