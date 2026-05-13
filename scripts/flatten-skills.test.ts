import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFlattenPlan, flattenRoot, planFlatten } from "./flatten-skills.js";

function writeNestedSkill(root: string, workflow: string, skill: string, body = "test"): string {
  const dir = join(root, "skills", workflow, "skills", skill);
  mkdirSync(dir, { recursive: true });
  const skillMd = join(dir, "SKILL.md");
  writeFileSync(skillMd, `---\nname: ${skill}\ndescription: ${body}\n---\n\n# ${skill}\n`);
  return skillMd;
}

function writeFlatSkill(root: string, skill: string, body = "test"): string {
  const dir = join(root, "skills", skill);
  mkdirSync(dir, { recursive: true });
  const skillMd = join(dir, "SKILL.md");
  writeFileSync(skillMd, `---\nname: ${skill}\ndescription: ${body}\n---\n\n# ${skill}\n`);
  return skillMd;
}

describe("planFlatten", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "flatten-skills-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("plans moves for double-skills layout", () => {
    writeNestedSkill(tmp, "alpha", "alpha");
    writeNestedSkill(tmp, "beta", "beta");

    const plan = planFlatten(tmp);

    expect(plan.moves).toHaveLength(2);
    expect(plan.moves.map((m) => m.to).sort()).toEqual(
      [join(tmp, "skills", "alpha"), join(tmp, "skills", "beta")].sort(),
    );
    expect(plan.moves.every((m) => !m.renamed)).toBe(true);
    expect(plan.emptyWorkflows.sort()).toEqual(
      [join(tmp, "skills", "alpha"), join(tmp, "skills", "beta")].sort(),
    );
  });

  it("returns empty plan for already-flat layout (no-op)", () => {
    writeFlatSkill(tmp, "alpha");
    writeFlatSkill(tmp, "beta");

    const plan = planFlatten(tmp);

    expect(plan.moves).toEqual([]);
    expect(plan.alreadyFlat.sort()).toEqual(["alpha", "beta"]);
    expect(plan.emptyWorkflows).toEqual([]);
  });

  it("renames on collision: same inner skill name across workflows", () => {
    // Both workflows ship a skill called "shared" → second one gets prefixed.
    writeNestedSkill(tmp, "alpha", "shared");
    writeNestedSkill(tmp, "beta", "shared");

    const plan = planFlatten(tmp);

    expect(plan.moves).toHaveLength(2);
    const dests = plan.moves.map((m) => m.to.split("/").pop()).sort();
    // First-seen workflow keeps the bare name; second is prefixed.
    expect(dests).toContain("shared");
    expect(dests.some((d) => d?.endsWith("-shared"))).toBe(true);
    expect(plan.moves.filter((m) => m.renamed).length).toBe(1);
  });

  it("renames around already-flat skill that occupies the desired name", () => {
    // Already-flat "shared" exists; nested workflow also has a "shared" skill.
    writeFlatSkill(tmp, "shared");
    writeNestedSkill(tmp, "alpha", "shared");

    const plan = planFlatten(tmp);

    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]!.renamed).toBe(true);
    expect(plan.moves[0]!.to.split("/").pop()).toBe("alpha-shared");
  });

  it("skips inner dirs without SKILL.md", () => {
    writeNestedSkill(tmp, "alpha", "real");
    // Create a stray inner dir with no SKILL.md
    mkdirSync(join(tmp, "skills", "alpha", "skills", "junk"), { recursive: true });

    const plan = planFlatten(tmp);

    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]!.originalSkill).toBe("real");
  });

  it("returns empty plan when skills/ does not exist", () => {
    const plan = planFlatten(tmp);
    expect(plan.moves).toEqual([]);
    expect(plan.emptyWorkflows).toEqual([]);
    expect(plan.alreadyFlat).toEqual([]);
  });
});

describe("applyFlattenPlan", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "flatten-apply-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("moves nested skills to flat layout and removes empty workflow dirs", () => {
    writeNestedSkill(tmp, "alpha", "alpha");
    writeNestedSkill(tmp, "beta", "beta");

    flattenRoot(tmp, { quiet: true });

    expect(existsSync(join(tmp, "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tmp, "skills", "beta", "SKILL.md"))).toBe(true);
    // The old `skills/alpha/skills/` and `skills/alpha/` should both be gone.
    expect(existsSync(join(tmp, "skills", "alpha", "skills"))).toBe(false);
    expect(readdirSync(join(tmp, "skills")).sort()).toEqual(["alpha", "beta"]);
  });

  it("idempotent: re-running on already-flat layout is a no-op", () => {
    writeFlatSkill(tmp, "alpha");
    writeFlatSkill(tmp, "beta");

    flattenRoot(tmp, { quiet: true });
    flattenRoot(tmp, { quiet: true });

    expect(existsSync(join(tmp, "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tmp, "skills", "beta", "SKILL.md"))).toBe(true);
    expect(readdirSync(join(tmp, "skills")).sort()).toEqual(["alpha", "beta"]);
  });

  it("dry-run does not modify the filesystem", () => {
    writeNestedSkill(tmp, "alpha", "alpha");

    const plan = flattenRoot(tmp, { dry: true, quiet: true });

    expect(plan.moves).toHaveLength(1);
    // Source still in place
    expect(existsSync(join(tmp, "skills", "alpha", "skills", "alpha", "SKILL.md"))).toBe(true);
    // Destination not yet created
    expect(existsSync(join(tmp, "skills", "alpha", "SKILL.md"))).toBe(false);
  });

  it("preserves existing flat skill that has the same name as a nested one (renames)", () => {
    writeFlatSkill(tmp, "shared", "flat-version");
    writeNestedSkill(tmp, "alpha", "shared", "nested-version");

    flattenRoot(tmp, { quiet: true });

    // Flat one untouched
    expect(existsSync(join(tmp, "skills", "shared", "SKILL.md"))).toBe(true);
    // Nested one lifted under prefixed name
    expect(existsSync(join(tmp, "skills", "alpha-shared", "SKILL.md"))).toBe(true);
  });

  it("keeps non-empty workflow dirs that have stray non-skill files", () => {
    writeNestedSkill(tmp, "alpha", "different-skill-name");
    // Stray README at the workflow level — flatten should NOT delete it.
    writeFileSync(join(tmp, "skills", "alpha", "README.md"), "stray\n");

    flattenRoot(tmp, { quiet: true });

    // The lifted skill landed at its own flat path.
    expect(existsSync(join(tmp, "skills", "different-skill-name", "SKILL.md"))).toBe(true);
    // The workflow dir survived because it has a stray README.
    expect(existsSync(join(tmp, "skills", "alpha", "README.md"))).toBe(true);
    // No SKILL.md leaked into the workflow dir itself.
    expect(existsSync(join(tmp, "skills", "alpha", "SKILL.md"))).toBe(false);
  });

  it("applies plan and resulting layout matches a planFlatten over the result (no-op)", () => {
    writeNestedSkill(tmp, "alpha", "alpha");
    writeNestedSkill(tmp, "beta", "beta");

    flattenRoot(tmp, { quiet: true });
    const replan = planFlatten(tmp);
    expect(replan.moves).toEqual([]);
  });
});

describe("applyFlattenPlan edge cases", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "flatten-edge-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("workflow with multiple inner skills lifts each separately", () => {
    // Single workflow that groups several skills — flatten lifts each one.
    writeNestedSkill(tmp, "alpha", "one");
    writeNestedSkill(tmp, "alpha", "two");
    writeNestedSkill(tmp, "alpha", "three");

    flattenRoot(tmp, { quiet: true });

    expect(existsSync(join(tmp, "skills", "one", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tmp, "skills", "two", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tmp, "skills", "three", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tmp, "skills", "alpha"))).toBe(false);
  });

  it("treats workflow dir with SKILL.md AS already-flat (does not recurse)", () => {
    // Hybrid that should not happen in practice: a workflow dir that itself
    // has a SKILL.md plus an inner skills/. The detector treats it as a flat
    // skill and leaves it alone — operator must clean up by hand.
    const flatDir = join(tmp, "skills", "alpha");
    mkdirSync(flatDir, { recursive: true });
    writeFileSync(join(flatDir, "SKILL.md"), "---\nname: alpha\n---\nflat\n");
    const nestedDir = join(tmp, "skills", "alpha", "skills", "alpha");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "SKILL.md"), "---\nname: alpha\n---\nnested\n");

    const plan = planFlatten(tmp);

    // Hybrid is left alone — no auto-migration when the layout is ambiguous.
    expect(plan.moves).toEqual([]);
    expect(plan.alreadyFlat).toContain("alpha");
  });
});
