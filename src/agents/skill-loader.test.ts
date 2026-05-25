import { vi } from "vitest";

const { TEST_HIVE_HOME } = vi.hoisted(() => {
  // KPR-225 F3: isolate HIVE_HOME so skill-loader tests that omit the
  // 5th-arg `hiveHomeOverride` (legacy-shape tests in the first two
  // describe blocks) don't write `.skill-projections/` into the operator's
  // real `~/hive`. vi.hoisted runs BEFORE imports — paths.ts then resolves
  // hiveHome to this temp dir at module-load. Top-of-file `process.env`
  // mutation does NOT work because Vitest hoists ESM imports above
  // top-level statements (see skill-loader.test.ts comment at the
  // KPR-75 5th-arg test for the original documentation of this trap).
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdtempSync } = require("node:fs");
  const { tmpdir: tmpdirFn } = require("node:os");
  const { join: joinFn } = require("node:path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = mkdtempSync(joinFn(tmpdirFn(), "hive-skill-loader-test-"));
  process.env.HIVE_HOME = dir;
  return { TEST_HIVE_HOME: dir };
});

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillIndex, getSkillsForAgent, getModifiedSkills } from "./skill-loader.js";
import { computeContentHash } from "../skills/content-hash.js";
import type { LoadedPlugin } from "../plugins/types.js";

afterAll(() => {
  rmSync(TEST_HIVE_HOME, { recursive: true, force: true });
});

/**
 * Legacy double-`skills/` fixture: <root>/<workflow>/skills/<skill>/SKILL.md.
 * KPR-214 keeps this path supported during the operator-skills repo migration
 * window — once KPR-215 ships, a follow-up can remove this fixture and the
 * loader's legacy branch.
 */
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

/**
 * Flat (KPR-214) fixture: <root>/<skill>/SKILL.md.
 * The shape a vanilla Claude SDK plugin ships.
 */
function writeFlatSkill(root: string, skill: string, agents: string[]): void {
  const dir = join(root, skill);
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
    brokenServers: {},
  };
}

function expectProjectedSkill(
  plugin: { path: string },
  skill: string,
  target: string,
): void {
  expect(plugin.path).toContain(".skill-projections");
  const linkPath = join(plugin.path, "skills", skill);
  expect(existsSync(linkPath)).toBe(true);
  expect(readlinkSync(linkPath)).toContain(target);
}

function findProjectedSkill(
  plugins: { path: string }[],
  skill: string,
): { path: string } | undefined {
  return plugins.find((plugin) => existsSync(join(plugin.path, "skills", skill)));
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

  it("loads multiple legacy skills under the same workflow without collisions", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "ai-analyst", "market-scan", ["milo"]);
    writeSkill(customer, "ai-analyst", "metrics-review", ["river"]);
    const helperDir = join(customer, "ai-analyst", "helpers");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(join(helperDir, "shared.md"), "shared workflow helper\n");

    const index = loadSkillIndex(customer, [], [], [], tmp);

    const milo = getSkillsForAgent(index, "milo");
    const river = getSkillsForAgent(index, "river");
    expect(milo).toHaveLength(1);
    expect(river).toHaveLength(1);
    expect(milo[0]!.path).not.toBe(river[0]!.path);
    expectProjectedSkill(
      milo[0]!,
      "market-scan",
      join(customer, "ai-analyst", "skills", "market-scan"),
    );
    expectProjectedSkill(
      river[0]!,
      "metrics-review",
      join(customer, "ai-analyst", "skills", "metrics-review"),
    );
    expect(readlinkSync(join(milo[0]!.path, "helpers"))).toContain(helperDir);
    expect(readlinkSync(join(river[0]!.path, "helpers"))).toContain(helperDir);
  });

  it("loads plugin-bundled skills alongside customer", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "alpha", "customer-skill", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "beta", "plugin-skill", ["milo"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)]);

    const miloSkills = getSkillsForAgent(index, "milo");
    expect(miloSkills).toHaveLength(2);
    expectProjectedSkill(
      findProjectedSkill(miloSkills, "customer-skill")!,
      "customer-skill",
      join(customer, "alpha", "skills", "customer-skill"),
    );
    expectProjectedSkill(
      findProjectedSkill(miloSkills, "plugin-skill")!,
      "plugin-skill",
      join(pluginDir, "skills", "beta", "skills", "plugin-skill"),
    );
  });

  it("customer skill shadows plugin-bundled skill", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "customer-flow", "shared", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "plugin-flow", "shared", ["milo"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)]);

    const milo = getSkillsForAgent(index, "milo");
    expect(milo).toHaveLength(1);
    expectProjectedSkill(milo[0]!, "shared", join(customer, "customer-flow", "skills", "shared"));
  });

  it("customer skill shadows plugin universal skill", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "customer-flow", "shared", ["all"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "plugin-flow", "shared", ["all"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)]);

    // Customer version should win — only one universal skill
    const universal = getSkillsForAgent(index, "brand-new");
    expect(universal).toHaveLength(1);
    expectProjectedSkill(universal[0]!, "shared", join(customer, "customer-flow", "skills", "shared"));
  });

  it("first-loaded plugin wins collision vs later plugin", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const pluginA = join(tmp, "plugin-a");
    writeSkill(join(pluginA, "skills"), "a-flow", "shared", ["milo"]);

    const pluginB = join(tmp, "plugin-b");
    writeSkill(join(pluginB, "skills"), "b-flow", "shared", ["milo"]);

    const index = loadSkillIndex(customer, [
      makePlugin("plugin-a", pluginA),
      makePlugin("plugin-b", pluginB),
    ]);

    const milo = getSkillsForAgent(index, "milo");
    expect(milo).toHaveLength(1);
    expectProjectedSkill(milo[0]!, "shared", join(pluginA, "skills", "a-flow", "skills", "shared"));
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
    expectProjectedSkill(
      getSkillsForAgent(index, "chief-of-staff")[0]!,
      "onboarding-skill",
      join(seedDir, "skills", "onboarding", "skills", "onboarding-skill"),
    );
  });

  it("seed skill wins over plugin skill (same skill name)", () => {
    const customer = join(tmp, "customer-skills");
    mkdirSync(customer, { recursive: true });

    const seedDir = join(tmp, "chief-of-staff");
    writeSkill(join(seedDir, "skills"), "seed-flow", "onboarding", ["chief-of-staff"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "plugin-flow", "onboarding", ["chief-of-staff"]);

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)], [seedDir]);

    const cos = getSkillsForAgent(index, "chief-of-staff");
    expect(cos).toHaveLength(1);
    expectProjectedSkill(cos[0]!, "onboarding", join(seedDir, "skills", "seed-flow", "skills", "onboarding"));
  });

  it("customer skill shadows seed-bundled skill", () => {
    const customer = join(tmp, "customer-skills");
    writeSkill(customer, "customer-flow", "onboarding", ["chief-of-staff"]);

    const seedDir = join(tmp, "chief-of-staff");
    writeSkill(join(seedDir, "skills"), "seed-flow", "onboarding", ["chief-of-staff"]);

    const index = loadSkillIndex(customer, [], [seedDir]);

    const cos = getSkillsForAgent(index, "chief-of-staff");
    expect(cos).toHaveLength(1);
    expectProjectedSkill(cos[0]!, "onboarding", join(customer, "customer-flow", "skills", "onboarding"));
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

// ---------------------------------------------------------------------------
// KPR-214 — flat layout (SDK convention)
// ---------------------------------------------------------------------------

describe("loadSkillIndex — flat layout (KPR-214)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-loader-flat-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads a flat customer skill (`<customer>/<skill>/SKILL.md`) and projects it", () => {
    const customer = join(tmp, "skills");
    writeFlatSkill(customer, "alpha", ["milo"]);

    const index = loadSkillIndex(customer, [], [], [], tmp);

    const milo = getSkillsForAgent(index, "milo");
    expect(milo).toHaveLength(1);
    // Plugin path is the projection root — NOT the original flat dir, since
    // the SDK expects a `<plugin>/skills/<skill>/SKILL.md` shape.
    expect(milo[0]!.path).toContain(".skill-projections");
    // The projection's `skills/<name>` symlink resolves back to the real dir.
    const projection = milo[0]!.path;
    const linkPath = join(projection, "skills", "alpha");
    expect(existsSync(linkPath)).toBe(true);
    expect(readlinkSync(linkPath)).toContain(join(customer, "alpha"));
  });

  it("loads a flat seed skill", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer, { recursive: true });
    const seedDir = join(tmp, "chief-of-staff");
    writeFlatSkill(join(seedDir, "skills"), "onboarding", ["chief-of-staff"]);

    const index = loadSkillIndex(customer, [], [seedDir], [], tmp);

    const cos = getSkillsForAgent(index, "chief-of-staff");
    expect(cos).toHaveLength(1);
    expect(cos[0]!.path).toContain(".skill-projections");
  });

  it("loads a flat plugin skill", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer, { recursive: true });
    const pluginDir = join(tmp, "plugin-a");
    writeFlatSkill(join(pluginDir, "skills"), "outreach", ["river"]);

    const plugin: LoadedPlugin = {
      name: "plugin-a",
      dir: pluginDir,
      manifest: { name: "plugin-a", mcpServers: {}, agentSeeds: [] },
      brokenServers: {},
    };
    const index = loadSkillIndex(customer, [plugin], [], [], tmp);

    const river = getSkillsForAgent(index, "river");
    expect(river).toHaveLength(1);
  });

  it("flat customer skill shadows flat plugin skill with the same name", () => {
    const customer = join(tmp, "skills");
    writeFlatSkill(customer, "shared", ["milo"]);
    const pluginDir = join(tmp, "plugin-a");
    writeFlatSkill(join(pluginDir, "skills"), "shared", ["milo"]);

    const plugin: LoadedPlugin = {
      name: "plugin-a",
      dir: pluginDir,
      manifest: { name: "plugin-a", mcpServers: {}, agentSeeds: [] },
      brokenServers: {},
    };
    const index = loadSkillIndex(customer, [plugin], [], [], tmp);

    const milo = getSkillsForAgent(index, "milo");
    expect(milo).toHaveLength(1);
    // Verify the surviving projection symlinks back to the customer dir, not
    // the plugin dir.
    const link = readlinkSync(join(milo[0]!.path, "skills", "shared"));
    expect(link).toContain(join(customer, "shared"));
    expect(link).not.toContain(join(pluginDir, "skills", "shared"));
  });

  it("first-loaded plugin wins flat collision vs later plugin", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer, { recursive: true });
    const pluginA = join(tmp, "plugin-a");
    writeFlatSkill(join(pluginA, "skills"), "shared", ["milo"]);
    const pluginB = join(tmp, "plugin-b");
    writeFlatSkill(join(pluginB, "skills"), "shared", ["milo"]);

    const plugins: LoadedPlugin[] = [
      { name: "plugin-a", dir: pluginA, manifest: { name: "plugin-a", mcpServers: {}, agentSeeds: [] }, brokenServers: {} },
      { name: "plugin-b", dir: pluginB, manifest: { name: "plugin-b", mcpServers: {}, agentSeeds: [] }, brokenServers: {} },
    ];
    const index = loadSkillIndex(customer, plugins, [], [], tmp);

    const milo = getSkillsForAgent(index, "milo");
    expect(milo).toHaveLength(1);
    const link = readlinkSync(join(milo[0]!.path, "skills", "shared"));
    expect(link).toContain(join(pluginA, "skills"));
  });

  it("universal flat skill (`agents: [all]`) goes into every agent's list", () => {
    const customer = join(tmp, "skills");
    writeFlatSkill(customer, "global-thing", ["all"]);
    writeFlatSkill(customer, "milo-only", ["milo"]);

    const index = loadSkillIndex(customer, [], [], [], tmp);

    expect(getSkillsForAgent(index, "milo")).toHaveLength(2);
    expect(getSkillsForAgent(index, "brand-new")).toHaveLength(1);
  });

  it("mixed customer (flat) + plugin (legacy): both load, customer flat wins on name collision", () => {
    // Operator has migrated their customer space to flat but still has a
    // legacy-layout plugin floating around. Mid-transition state.
    const customer = join(tmp, "skills");
    writeFlatSkill(customer, "shared", ["milo"]);

    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "shared", "shared", ["milo"]);

    const plugin: LoadedPlugin = {
      name: "plugin-a",
      dir: pluginDir,
      manifest: { name: "plugin-a", mcpServers: {}, agentSeeds: [] },
      brokenServers: {},
    };
    const index = loadSkillIndex(customer, [plugin], [], [], tmp);

    const milo = getSkillsForAgent(index, "milo");
    expect(milo).toHaveLength(1);
    const link = readlinkSync(join(milo[0]!.path, "skills", "shared"));
    expect(link).toContain(join(customer, "shared"));
  });

  it("dual-layout: flat and legacy under same root coexist (different skill names)", () => {
    // Operator migrating one skill at a time — flat already-migrated skills
    // and legacy not-yet-migrated skills must both load from the same root.
    const customer = join(tmp, "skills");
    writeFlatSkill(customer, "already-flat", ["milo"]);
    writeSkill(customer, "still-legacy", "still-legacy", ["milo"]);

    const index = loadSkillIndex(customer, [], [], [], tmp);

    const milo = getSkillsForAgent(index, "milo");
    expect(milo).toHaveLength(2);
  });

  it("hot reload picks up a newly-written flat skill", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer, { recursive: true });

    const before = loadSkillIndex(customer, [], [], [], tmp);
    expect(getSkillsForAgent(before, "milo")).toHaveLength(0);

    writeFlatSkill(customer, "alpha", ["milo"]);

    const after = loadSkillIndex(customer, [], [], [], tmp);
    expect(getSkillsForAgent(after, "milo")).toHaveLength(1);
  });

  it("detects modifications on a flat customer skill", () => {
    const customer = join(tmp, "skills");
    const skillDir = join(customer, "alpha");
    mkdirSync(skillDir, { recursive: true });

    const initialBody = "# Alpha\nInitial content\n";
    const initialSkillMd = [
      "---",
      "name: alpha",
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

    const baseHash = computeContentHash(skillDir);
    const skillMdWithHash = initialSkillMd.replace("PLACEHOLDER", baseHash);
    writeFileSync(join(skillDir, "SKILL.md"), skillMdWithHash);

    loadSkillIndex(customer, [], [], [], tmp);
    expect(getModifiedSkills().size).toBe(0);

    writeFileSync(
      join(skillDir, "SKILL.md"),
      skillMdWithHash.replace("Initial content", "Modified content"),
    );

    loadSkillIndex(customer, [], [], [], tmp);
    expect(getModifiedSkills().has(skillDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KPR-75 — agent-private skills under agents/<id>/skills/
// ---------------------------------------------------------------------------

function writeAgentSkill(hiveHome: string, agentId: string, workflow: string, skill: string): void {
  const dir = join(hiveHome, "agents", agentId, "skills", workflow, "skills", skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skill}\ndescription: test\n---\n\n# ${skill}\n`);
}

function writeAgentSkillWithAgentsField(
  hiveHome: string,
  agentId: string,
  workflow: string,
  skill: string,
  agents: string[],
): void {
  const dir = join(hiveHome, "agents", agentId, "skills", workflow, "skills", skill);
  mkdirSync(dir, { recursive: true });
  const agentsYaml = agents.map((a) => `  - ${a}`).join("\n");
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${skill}\ndescription: test\nagents:\n${agentsYaml}\n---\n\n# ${skill}\n`,
  );
}

/**
 * Flat agent-private fixture: <hiveHome>/agents/<id>/skills/<skill>/SKILL.md.
 * Same shape as customer-space — KPR-214 alignment with SDK convention
 * applies to agent-private space too.
 */
function writeFlatAgentSkill(hiveHome: string, agentId: string, skill: string): void {
  const dir = join(hiveHome, "agents", agentId, "skills", skill);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skill}\ndescription: test\n---\n\n# ${skill}\n`);
}

describe("agent-private skills (KPR-75)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-loader-kpr75-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads skills from agents/<id>/skills/ scoped to that agent only", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");

    // 5th arg `hiveHomeOverride` is required — paths.ts resolves hiveHome at
    // module-load, so process.env.HIVE_HOME mutation has no effect.
    const index = loadSkillIndex(customer, [], [], ["luna", "sam"], tmp);

    const luna = getSkillsForAgent(index, "luna");
    expect(luna).toHaveLength(1);
    expectProjectedSkill(
      luna[0]!,
      "publish-blog-post",
      join(tmp, "agents", "luna", "skills", "blog-flow", "skills", "publish-blog-post"),
    );
    expect(getSkillsForAgent(index, "sam")).toEqual([]);
  });

  it("two agents with same skill name do NOT collide", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");
    writeAgentSkill(tmp, "sam", "blog-flow", "publish-blog-post");

    const index = loadSkillIndex(customer, [], [], ["luna", "sam"], tmp);

    expect(getSkillsForAgent(index, "luna")).toHaveLength(1);
    expect(getSkillsForAgent(index, "sam")).toHaveLength(1);
    expectProjectedSkill(
      getSkillsForAgent(index, "luna")[0]!,
      "publish-blog-post",
      join(tmp, "agents", "luna", "skills", "blog-flow", "skills", "publish-blog-post"),
    );
    expectProjectedSkill(
      getSkillsForAgent(index, "sam")[0]!,
      "publish-blog-post",
      join(tmp, "agents", "sam", "skills", "blog-flow", "skills", "publish-blog-post"),
    );
  });

  it("rejects (skips) agent-private skill that declares agents: in frontmatter — does not crash loader", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    // Luna has a malformed private skill (declares agents: which is forbidden).
    // Sam has a valid one. Loader must reject Luna's silently and still build
    // Sam's so a single bad SKILL.md doesn't disable the rest of the hive.
    writeAgentSkillWithAgentsField(tmp, "luna", "blog-flow", "publish-blog-post", ["sam"]);
    writeAgentSkill(tmp, "sam", "research", "lookup");

    const index = loadSkillIndex(customer, [], [], ["luna", "sam"], tmp);

    expect(getSkillsForAgent(index, "luna")).toEqual([]);
    expect(getSkillsForAgent(index, "sam")).toHaveLength(1);
    expectProjectedSkill(
      getSkillsForAgent(index, "sam")[0]!,
      "lookup",
      join(tmp, "agents", "sam", "skills", "research", "skills", "lookup"),
    );
  });

  it("customer-space skill shadows agent-private skill for the agents it scopes to", () => {
    const customer = join(tmp, "skills");
    writeSkill(customer, "blog-flow", "publish-blog-post", ["luna"]);
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");

    const index = loadSkillIndex(customer, [], [], ["luna"], tmp);

    const luna = getSkillsForAgent(index, "luna");
    expect(luna).toHaveLength(1);
    expectProjectedSkill(
      luna[0]!,
      "publish-blog-post",
      join(customer, "blog-flow", "skills", "publish-blog-post"),
    );
  });

  it("plugin skill scoped to a different agent does not block agent-private skill", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    const pluginDir = join(tmp, "plugin-a");
    writeSkill(join(pluginDir, "skills"), "blog-flow", "publish-blog-post", ["sam"]);
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");

    const index = loadSkillIndex(customer, [makePlugin("plugin-a", pluginDir)], [], ["luna", "sam"], tmp);

    expectProjectedSkill(
      getSkillsForAgent(index, "luna")[0]!,
      "publish-blog-post",
      join(tmp, "agents", "luna", "skills", "blog-flow", "skills", "publish-blog-post"),
    );
    expectProjectedSkill(
      getSkillsForAgent(index, "sam")[0]!,
      "publish-blog-post",
      join(pluginDir, "skills", "blog-flow", "skills", "publish-blog-post"),
    );
  });

  it("missing agent dir is silently skipped", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    // No agents/ directory at all.

    const index = loadSkillIndex(customer, [], [], ["luna", "sam"], tmp);

    expect(index.size).toBe(0);
  });

  it("hot-reload picks up new agent-private skills", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);

    let index = loadSkillIndex(customer, [], [], ["luna"], tmp);
    expect(getSkillsForAgent(index, "luna")).toEqual([]);

    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");
    index = loadSkillIndex(customer, [], [], ["luna"], tmp);
    expect(getSkillsForAgent(index, "luna")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // KPR-214 flat layout for agent-private skills
  // -------------------------------------------------------------------------

  it("loads a flat agent-private skill", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    writeFlatAgentSkill(tmp, "luna", "publish-blog-post");

    const index = loadSkillIndex(customer, [], [], ["luna"], tmp);

    const luna = getSkillsForAgent(index, "luna");
    expect(luna).toHaveLength(1);
    // Flat agent-private skills go through projection (same as flat customer skills).
    expect(luna[0]!.path).toContain(".skill-projections");
    const link = readlinkSync(join(luna[0]!.path, "skills", "publish-blog-post"));
    expect(link).toContain(join(tmp, "agents", "luna", "skills", "publish-blog-post"));
  });

  it("two agents with same flat skill name do NOT collide", () => {
    const customer = join(tmp, "skills");
    mkdirSync(customer);
    writeFlatAgentSkill(tmp, "luna", "publish-blog-post");
    writeFlatAgentSkill(tmp, "sam", "publish-blog-post");

    const index = loadSkillIndex(customer, [], [], ["luna", "sam"], tmp);

    expect(getSkillsForAgent(index, "luna")).toHaveLength(1);
    expect(getSkillsForAgent(index, "sam")).toHaveLength(1);
    // Each gets its own projection (different keys, since different real paths).
    expect(getSkillsForAgent(index, "luna")[0]!.path).not.toBe(
      getSkillsForAgent(index, "sam")[0]!.path,
    );
  });

  it("flat customer skill shadows flat agent-private skill of same name", () => {
    const customer = join(tmp, "skills");
    writeFlatSkill(customer, "publish-blog-post", ["luna"]);
    writeFlatAgentSkill(tmp, "luna", "publish-blog-post");

    const index = loadSkillIndex(customer, [], [], ["luna"], tmp);

    const luna = getSkillsForAgent(index, "luna");
    expect(luna).toHaveLength(1);
    const link = readlinkSync(join(luna[0]!.path, "skills", "publish-blog-post"));
    expect(link).toContain(join(customer, "publish-blog-post"));
  });

  it("flat customer skill scoped to one agent shadows legacy agent-private skill of same name", () => {
    // KPR-227 follow-up: the explicit-agent branch must match by
    // entry.skillName so customer/operator authority works across flat and
    // legacy agent-private layouts.
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");

    const customer = join(tmp, "skills");
    writeFlatSkill(customer, "publish-blog-post", ["luna"]);

    const index = loadSkillIndex(customer, [], [], ["luna"], tmp);

    const luna = getSkillsForAgent(index, "luna");
    expect(luna).toHaveLength(1);
    const link = readlinkSync(join(luna[0]!.path, "skills", "publish-blog-post"));
    expect(link).toContain(join(customer, "publish-blog-post"));
  });

  it("F2 (KPR-225): customer skill with `agents: [all]` shadows agent-private skills of the same name", () => {
    // Pre-fix bug: when the customer skill scopes to `agents: [all]`, the
    // eviction loop iterated `agentIds` (which is empty in the hasAll case)
    // so no eviction fired. `getSkillsForAgent(luna)` returned BOTH the
    // agent-private and the universal customer entry.
    //
    // Post-fix: hasAll branch iterates collisionMap and evicts every
    // agent-private entry whose stored skillName matches the customer skill.
    const customer = join(tmp, "skills");
    writeFlatSkill(customer, "publish-blog-post", ["all"]);
    writeFlatAgentSkill(tmp, "luna", "publish-blog-post");
    writeFlatAgentSkill(tmp, "sam", "publish-blog-post");

    const index = loadSkillIndex(customer, [], [], ["luna", "sam"], tmp);

    // Both agents see exactly ONE entry — the customer (universal) one.
    // Pre-fix: would be 2 for each agent (customer + their own private).
    const luna = getSkillsForAgent(index, "luna");
    expect(luna).toHaveLength(1);
    const lunaLink = readlinkSync(join(luna[0]!.path, "skills", "publish-blog-post"));
    expect(lunaLink).toContain(join(customer, "publish-blog-post"));

    const sam = getSkillsForAgent(index, "sam");
    expect(sam).toHaveLength(1);
    const samLink = readlinkSync(join(sam[0]!.path, "skills", "publish-blog-post"));
    expect(samLink).toContain(join(customer, "publish-blog-post"));
  });

  it("KPR-227 (F2 follow-up): customer skill with `agents: [all]` shadows LEGACY agent-private skills", () => {
    // KPR-227 switches the hasAll filter to agent-private source +
    // `entry.skillName === skillName`, covering both layouts.
    writeAgentSkill(tmp, "luna", "blog-flow", "publish-blog-post");

    const customer = join(tmp, "skills");
    writeFlatSkill(customer, "publish-blog-post", ["all"]);

    const index = loadSkillIndex(customer, [], [], ["luna"], tmp);

    // Pre-fix: would be 2 (customer + legacy private). Post-fix: just the
    // customer (universal) entry.
    const luna = getSkillsForAgent(index, "luna");
    expect(luna).toHaveLength(1);
    const link = readlinkSync(join(luna[0]!.path, "skills", "publish-blog-post"));
    expect(link).toContain(join(customer, "publish-blog-post"));
  });
});

describe("rebuildProjectionRoot fail-fast (KPR-225 F3-bonus)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-loader-failfast-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loadSkillIndex throws when projection root cannot be created (parent is a regular file)", () => {
    // Pre-fix: rebuildProjectionRoot caught the error and log.warned, then
    // buildSkillProjection later threw a confusing ENOENT downstream.
    // Post-fix: throws immediately at load time at the actual root cause.
    //
    // Construct an unwritable hiveHome whose `.skill-projections` cannot be
    // created: make hiveHome itself a path inside a regular file so mkdir
    // can't even establish the parent. mkdirSync produces ENOTDIR.
    const blocker = join(tmp, "blocker-file");
    writeFileSync(blocker, "i am a file, not a dir");
    const badHiveHome = join(blocker, "fake-hive-home");
    const customer = join(badHiveHome, "skills");
    // No need to write a real skill — rebuildProjectionRoot fires at load
    // time before any skill scan runs.

    expect(() => loadSkillIndex(customer, [], [], [], badHiveHome)).toThrow(
      /ENOTDIR|EEXIST|EACCES|EROFS|ENOENT/,
    );
  });
});
