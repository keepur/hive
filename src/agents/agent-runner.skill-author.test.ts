import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillIndex, getSkillsForAgent } from "./skill-loader.js";
import { authorSkill } from "../skill-author/skill-author-mcp-server.js";

/**
 * KPR-104 integration: a skill written via the author_skill handler is
 * picked up by skill-loader.loadSkillIndex on the next call (mirrors what
 * happens on next session spawn in production).
 */
describe("author_skill -> skill-loader integration", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hive-author-skill-int-"));
    // Customer skills dir is allowed to be missing — loader handles that —
    // but create it so detectModifiedSkills has a stable parent.
    mkdirSync(join(home, "skills"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("authored skill loads under the calling agent's id on next loadSkillIndex", () => {
    const id = "river";
    const skillName = "drip-campaign";
    const content = [
      "---",
      `name: ${skillName}`,
      "description: write a 5-step drip",
      "---",
      "",
      "## Instructions",
      "Write the drip.",
      "",
    ].join("\n");

    const r = authorSkill({ skillName, content }, { agentId: id, hiveHome: home });
    expect(r.isError).toBeUndefined();

    // Confirm the nested KPR-75 layout was written:
    // <home>/agents/<id>/skills/<slug>/skills/<slug>/SKILL.md
    const written = join(
      home,
      "agents",
      id,
      "skills",
      skillName,
      "skills",
      skillName,
      "SKILL.md",
    );
    expect(existsSync(written)).toBe(true);

    // Now have the loader pick it up exactly the way the engine will on next
    // session spawn.
    const idx = loadSkillIndex(join(home, "skills"), [], [], [id], home);
    const forAgent = getSkillsForAgent(idx, id);
    const projected = forAgent.find((p) => existsSync(join(p.path, "skills", skillName)));
    expect(projected).toBeDefined();
    expect(projected!.path).toContain(".skill-projections");
    expect(readlinkSync(join(projected!.path, "skills", skillName))).toContain(
      join(home, "agents", id, "skills", skillName, "skills", skillName),
    );
  });

  it("two agents authoring the same slug do not collide — each gets its own", () => {
    const skillName = "shared-name";
    const body = `---\nname: ${skillName}\ndescription: t\n---\nbody\n`;

    expect(
      authorSkill({ skillName, content: body }, { agentId: "river", hiveHome: home }).isError,
    ).toBeUndefined();
    expect(
      authorSkill({ skillName, content: body }, { agentId: "milo", hiveHome: home }).isError,
    ).toBeUndefined();

    const idx = loadSkillIndex(join(home, "skills"), [], [], ["river", "milo"], home);
    const river = getSkillsForAgent(idx, "river").map((p) => p.path);
    const milo = getSkillsForAgent(idx, "milo").map((p) => p.path);
    expect(river).toHaveLength(1);
    expect(milo).toHaveLength(1);
    expect(readlinkSync(join(river[0]!, "skills", skillName))).toContain(
      join(home, "agents", "river", "skills", skillName, "skills", skillName),
    );
    expect(readlinkSync(join(milo[0]!, "skills", skillName))).toContain(
      join(home, "agents", "milo", "skills", skillName, "skills", skillName),
    );
  });
});

describe("filterCoreServers always-on injection", () => {
  it("retains skill-author for an agent whose coreServers does not list it", async () => {
    process.env.SLACK_APP_TOKEN ??= "xapp-test";
    process.env.SLACK_BOT_TOKEN ??= "xoxb-test";

    const { AgentRunner } = await import("./agent-runner.js");

    // Build a minimal-but-valid AgentConfig. Field set must match what
    // filterCoreServers reads: coreServers (string[]), autonomy.{externalComms,
    // codeTask, codeAccess}.
    const agentConfig = {
      id: "river",
      coreServers: [], // empty allowlist — only implicit servers should survive
      delegateServers: [],
      autonomy: { externalComms: false, codeTask: false, codeAccess: false },
    };
    const runner = Object.create(AgentRunner.prototype) as { agentConfig: typeof agentConfig };
    runner.agentConfig = agentConfig;

    const servers: Record<string, { type: string }> = {
      "skill-author": { type: "stdio" },
      schedule: { type: "stdio" },
      team: { type: "stdio" },
      "team-roster": { type: "sdk" },
      memory: { type: "stdio" }, // not in coreServers, not implicit -> should drop
    };
    // filterCoreServers is private — bypass typing via cast for the smoke test.
    const filtered = (
      runner as unknown as {
        filterCoreServers: (s: typeof servers) => typeof servers;
      }
    ).filterCoreServers(servers);
    expect(filtered["skill-author"]).toBeDefined();
    expect(filtered["memory"]).toBeUndefined();
  });
});
