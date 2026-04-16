import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillIndex, getSkillsForAgent } from "./skill-loader.js";
import type { LoadedPlugin } from "../plugins/types.js";

function writeSkill(
  root: string,
  workflow: string,
  skill: string,
  agents: string[],
): void {
  const dir = join(root, workflow, "skills", skill);
  mkdirSync(dir, { recursive: true });
  const agentsYaml = agents.map((a) => `  - ${a}`).join("\n");
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${skill}\ndescription: test\nagents:\n${agentsYaml}\n---\n\n# ${skill}\n`,
  );
}

function makePlugin(name: string, dir: string): LoadedPlugin {
  return {
    name,
    dir,
    manifest: {
      name,
      mcpServers: {},
      agentSeeds: [],
    },
  };
}

describe("loadSkillIndex", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-loader-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads customer-space skills", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "alpha", "one", ["milo"]);

    const index = loadSkillIndex(customer);

    expect(getSkillsForAgent(index, "milo")).toHaveLength(1);
    expect(getSkillsForAgent(index, "other")).toHaveLength(0);
  });

  it("loads plugin-bundled skills alongside customer", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "alpha", "customer-skill", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "beta", "plugin-skill", ["milo"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)]);

    const miloSkills = getSkillsForAgent(index, "milo");
    expect(miloSkills).toHaveLength(2);
    expect(miloSkills.map((s) => s.path).sort()).toEqual(
      [join(customer, "alpha"), join(pluginDir, "skills", "beta")].sort(),
    );
  });

  it("customer skill shadows plugin-bundled skill", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "shared", "customer-version", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "shared", "plugin-version", ["milo"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)]);

    const paths = getSkillsForAgent(index, "milo").map((s) => s.path);
    expect(paths).toEqual([join(customer, "shared")]);
  });

  it("customer skill shadows plugin universal skill", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "shared", "customer-all", ["all"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "shared", "plugin-all", ["all"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)]);

    // Customer version should win — only one universal skill
    const universal = getSkillsForAgent(index, "brand-new");
    expect(universal).toHaveLength(1);
    expect(universal[0]!.path).toBe(join(customer, "shared"));
  });

  it("first-loaded plugin wins collision vs later plugin", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const pluginA = join(tmp, "plugin-a");
    writeSkill(join(pluginA, "skills"), "shared", "a-version", ["milo"]);

    const pluginB = join(tmp, "plugin-b");
    writeSkill(join(pluginB, "skills"), "shared", "b-version", ["milo"]);

    const index = loadSkillIndex(customer, [
      makePlugin("plugin-a", pluginA),
      makePlugin("plugin-b", pluginB),
    ]);

    const paths = getSkillsForAgent(index, "milo").map((s) => s.path);
    expect(paths).toEqual([join(pluginA, "skills", "shared")]);
  });

  it("ignores plugins with no skills/ subdir", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "alpha", "one", ["milo"]);

    const pluginDir = join(tmp, "plugin-no-skills");
    mkdirSync(pluginDir, { recursive: true });

    const index = loadSkillIndex(customer, [makePlugin("plugin-no-skills", pluginDir)]);
    expect(getSkillsForAgent(index, "milo")).toHaveLength(1);
  });

  it("universal skills merge across customer and plugins", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "alpha", "for-milo", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "beta", "for-all", ["all"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)]);

    expect(getSkillsForAgent(index, "milo")).toHaveLength(2);
    expect(getSkillsForAgent(index, "brand-new")).toHaveLength(1);
  });

  it("hot reload picks up a newly-written plugin skill", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const pluginDir = join(tmp, "plugin-a");
    mkdirSync(join(pluginDir, "skills"), { recursive: true });

    const before = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)]);
    expect(getSkillsForAgent(before, "milo")).toHaveLength(0);

    writeSkill(join(pluginDir, "skills"), "beta", "new-skill", ["milo"]);

    const after = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)]);
    expect(getSkillsForAgent(after, "milo")).toHaveLength(1);
  });
});
