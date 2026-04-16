import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { skillRuntimePath, isInsideCustomerSpace, parseSkillPath } from "./skill-paths.js";
import { skillsDir } from "../paths.js";

describe("skillRuntimePath", () => {
  it("returns the expected layout path", () => {
    const result = skillRuntimePath("dodi-dev", "brainstorm");
    expect(result).toBe(join(skillsDir, "dodi-dev", "skills", "brainstorm"));
  });
});

describe("isInsideCustomerSpace", () => {
  it("returns true for a path inside skills dir", () => {
    expect(isInsideCustomerSpace(join(skillsDir, "wf", "skills", "foo"))).toBe(true);
  });

  it("returns true for the skills dir itself", () => {
    expect(isInsideCustomerSpace(skillsDir)).toBe(true);
  });

  it("returns false for a path outside skills dir", () => {
    expect(isInsideCustomerSpace("/tmp/not-skills")).toBe(false);
  });

  it("returns false for a sibling path with shared prefix", () => {
    expect(isInsideCustomerSpace(skillsDir + "-extra")).toBe(false);
  });
});

describe("parseSkillPath", () => {
  it("extracts workflow and name from a valid path", () => {
    const path = join(skillsDir, "dodi-dev", "skills", "brainstorm");
    expect(parseSkillPath(path)).toEqual({
      workflow: "dodi-dev",
      name: "brainstorm",
    });
  });

  it("extracts from a deeper path inside a skill dir", () => {
    const path = join(skillsDir, "dodi-dev", "skills", "brainstorm", "SKILL.md");
    expect(parseSkillPath(path)).toEqual({
      workflow: "dodi-dev",
      name: "brainstorm",
    });
  });

  it("returns null for a path outside skills dir", () => {
    expect(parseSkillPath("/tmp/foo/skills/bar")).toBeNull();
  });

  it("returns null for a path missing the skills/ segment", () => {
    expect(parseSkillPath(join(skillsDir, "dodi-dev", "brainstorm"))).toBeNull();
  });
});
