import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillIndex, getSkillsForAgent, getModifiedSkills } from "./skill-loader.js";
import { computeContentHash } from "../skills/content-hash.js";
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

  it("detects customer modifications to registry-installed skills on reload", () => {
    const customer = join(tmp, "customer-skills");
    const skillDir = join(customer, "alpha", "skills", "one");
    mkdirSync(skillDir, { recursive: true });

    // Write a skill with origin metadata — compute base hash first
    const initialBody = "# One\nInitial content\n";
    const initialSkillMd = [
      "---",
      "name: one",
      "description: test",
      "agents: [milo]",
      "origin:",
      "  type: registry",
      "  source: keepur/test-skills",
      "  base-content-hash: PLACEHOLDER",
      "---",
      initialBody,
    ].join("\n");
    writeFileSync(join(skillDir, "SKILL.md"), initialSkillMd);

    // Compute the base content hash from the initial state
    const baseHash = computeContentHash(skillDir);

    // Rewrite with the correct base hash
    const skillMdWithHash = initialSkillMd.replace("PLACEHOLDER", baseHash);
    writeFileSync(join(skillDir, "SKILL.md"), skillMdWithHash);

    // First load — hashes match, no modification detected
    loadSkillIndex(customer);
    expect(getModifiedSkills().size).toBe(0);

    // Now modify the skill content
    writeFileSync(
      join(skillDir, "SKILL.md"),
      skillMdWithHash.replace("Initial content", "Modified content"),
    );

    // Reload — modification should be detected
    loadSkillIndex(customer);
    expect(getModifiedSkills().has(skillDir)).toBe(true);
  });

  it("loads seed-bundled skills", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const seedDir = join(tmp, "chief-of-staff");
    writeSkill(join(seedDir, "skills"), "onboarding", "onboarding-skill", ["chief-of-staff"]);

    const index = loadSkillIndex(customer, [], [seedDir]);

    expect(getSkillsForAgent(index, "chief-of-staff")).toHaveLength(1);
    expect(getSkillsForAgent(index, "chief-of-staff")[0]!.path).toBe(
      join(seedDir, "skills", "onboarding"),
    );
  });

  it("seed skill wins over plugin skill (same workflow name)", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const seedDir = join(tmp, "chief-of-staff");
    writeSkill(join(seedDir, "skills"), "onboarding", "seed-version", ["chief-of-staff"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "onboarding", "plugin-version", ["chief-of-staff"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)], [seedDir]);

    const paths = getSkillsForAgent(index, "chief-of-staff").map((s) => s.path);
    expect(paths).toEqual([join(seedDir, "skills", "onboarding")]);
  });

  it("customer skill shadows seed-bundled skill", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "onboarding", "customer-version", ["chief-of-staff"]);

    const seedDir = join(tmp, "chief-of-staff");
    writeSkill(join(seedDir, "skills"), "onboarding", "seed-version", ["chief-of-staff"]);

    const index = loadSkillIndex(customer, [], [seedDir]);

    const paths = getSkillsForAgent(index, "chief-of-staff").map((s) => s.path);
    expect(paths).toEqual([join(customer, "onboarding")]);
  });

  it("ignores seed dirs with no skills/ subdirectory", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const seedDir = join(tmp, "empty-seed");
    mkdirSync(seedDir, { recursive: true });

    const index = loadSkillIndex(customer, [], [seedDir]);
    expect(index.size).toBe(0);
  });

  it("loads skills from multiple seed dirs", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const seedA = join(tmp, "seed-a");
    writeSkill(join(seedA, "skills"), "alpha", "skill-a", ["agent-a"]);

    const seedB = join(tmp, "seed-b");
    writeSkill(join(seedB, "skills"), "beta", "skill-b", ["agent-b"]);

    const index = loadSkillIndex(customer, [], [seedA, seedB]);

    expect(getSkillsForAgent(index, "agent-a")).toHaveLength(1);
    expect(getSkillsForAgent(index, "agent-b")).toHaveLength(1);
  });
});
