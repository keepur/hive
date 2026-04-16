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

  it("loads core-only skills", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "alpha", "one", ["milo"]);

    const index = loadSkillIndex(core);

    expect(getSkillsForAgent(index, "milo")).toHaveLength(1);
    expect(getSkillsForAgent(index, "other")).toHaveLength(0);
  });

  it("loads plugin-bundled skills alongside core", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "alpha", "core-skill", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "beta", "plugin-skill", ["milo"]);

    const index = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);

    const miloSkills = getSkillsForAgent(index, "milo");
    expect(miloSkills).toHaveLength(2);
    expect(miloSkills.map((s) => s.path).sort()).toEqual(
      [join(core, "alpha"), join(pluginDir, "skills", "beta")].sort(),
    );
  });

  it("core wins collision vs plugin", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "shared", "core-version", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "shared", "plugin-version", ["milo"]);

    const index = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);

    const paths = getSkillsForAgent(index, "milo").map((s) => s.path);
    expect(paths).toEqual([join(core, "shared")]);
  });

  it("first-loaded plugin wins collision vs later plugin", () => {
    const core = join(tmp, "core-skills");
    mkdirSync(core, { recursive: true });

    const pluginA = join(tmp, "plugin-a");
    writeSkill(join(pluginA, "skills"), "shared", "a-version", ["milo"]);

    const pluginB = join(tmp, "plugin-b");
    writeSkill(join(pluginB, "skills"), "shared", "b-version", ["milo"]);

    const index = loadSkillIndex(core, [
      makePlugin("plugin-a", pluginA),
      makePlugin("plugin-b", pluginB),
    ]);

    const paths = getSkillsForAgent(index, "milo").map((s) => s.path);
    expect(paths).toEqual([join(pluginA, "skills", "shared")]);
  });

  it("ignores plugins with no skills/ subdir", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "alpha", "one", ["milo"]);

    const pluginDir = join(tmp, "plugin-no-skills");
    mkdirSync(pluginDir, { recursive: true });

    const index = loadSkillIndex(core, [makePlugin("plugin-no-skills", pluginDir)]);
    expect(getSkillsForAgent(index, "milo")).toHaveLength(1);
  });

  it("universal skills merge across core and plugins", () => {
    const core = join(tmp, "core-skills");
    writeSkill(core, "alpha", "for-milo", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "beta", "for-all", ["all"]);

    const index = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);

    expect(getSkillsForAgent(index, "milo")).toHaveLength(2);
    expect(getSkillsForAgent(index, "brand-new")).toHaveLength(1);
  });

  it("hot reload picks up a newly-written plugin skill", () => {
    const core = join(tmp, "core-skills");
    mkdirSync(core, { recursive: true });

    const pluginDir = join(tmp, "plugin-a");
    mkdirSync(join(pluginDir, "skills"), { recursive: true });

    const before = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);
    expect(getSkillsForAgent(before, "milo")).toHaveLength(0);

    writeSkill(join(pluginDir, "skills"), "beta", "new-skill", ["milo"]);

    const after = loadSkillIndex(core, [makePlugin("plugin-a", pluginDir)]);
    expect(getSkillsForAgent(after, "milo")).toHaveLength(1);
  });
});
