import { describe, it, expect } from "vitest";
import { TeamRoster } from "./team-roster.js";
import type { TeamCache } from "./team-cache.js";
import type { TeamMember } from "./types.js";

function makeCache(humans: TeamMember[], agents: TeamMember[]): TeamCache {
  return {
    getHumans: async () => humans,
    getAgents: async () => agents,
    invalidateHumans: () => {},
    invalidateAgents: () => {},
  } as unknown as TeamCache;
}

const may: TeamMember = {
  kind: "human",
  id: "may-id",
  name: "May Huang",
  email: "may@dodihome.com",
  roles: ["CEO"],
  pronouns: "she/her",
  category: "team-human",
  updatedAt: new Date("2026-04-01T00:00:00Z"),
};
const mayNewer: TeamMember = { ...may, id: "may-id-newer", updatedAt: new Date("2026-05-01T00:00:00Z") };
const archived: TeamMember = {
  kind: "human",
  id: "former",
  name: "Konstantin",
  email: "k@dodihome.com",
  category: "archived",
};
const jasper: TeamMember = {
  kind: "agent",
  id: "jasper",
  name: "Jasper",
  category: "team-agent",
  agentId: "jasper",
  slackChannel: "agent-jasper",
  model: "claude-sonnet-4-6",
  aliases: ["jas"],
  active: true,
};
const noraDisabled: TeamMember = {
  kind: "agent",
  id: "nora",
  name: "Nora",
  category: "archived",
  agentId: "nora",
  active: false,
};

describe("TeamRoster.getTeam", () => {
  it("returns active humans + active agents by default, sorted by category then name", async () => {
    const roster = new TeamRoster(makeCache([may, archived], [jasper, noraDisabled]));
    const team = await roster.getTeam();
    const ids = team.map((m) => m.id);
    expect(ids).toEqual(["jasper", "may-id"]); // team-agent < team-human alphabetically; within same category by name
    expect(ids).not.toContain("former");
    expect(ids).not.toContain("nora");
  });

  it("includes archived members when includeArchived=true", async () => {
    const roster = new TeamRoster(makeCache([may, archived], [jasper, noraDisabled]));
    const team = await roster.getTeam({ includeArchived: true });
    const ids = team.map((m) => m.id);
    expect(ids).toContain("former");
    expect(ids).toContain("nora");
  });

  it("excludes agents when includeAgents=false", async () => {
    const roster = new TeamRoster(makeCache([may], [jasper]));
    const team = await roster.getTeam({ includeAgents: false });
    expect(team).toHaveLength(1);
    expect(team[0].id).toBe("may-id");
  });
});

describe("TeamRoster.lookupHuman", () => {
  it("matches by name (case-insensitive)", async () => {
    const roster = new TeamRoster(makeCache([may], []));
    const result = await roster.lookupHuman({ name: "may huang" });
    expect(result?.id).toBe("may-id");
  });

  it("matches by email (case-insensitive)", async () => {
    const roster = new TeamRoster(makeCache([may], []));
    const result = await roster.lookupHuman({ email: "MAY@DODIHOME.COM" });
    expect(result?.id).toBe("may-id");
  });

  it("returns null on miss", async () => {
    const roster = new TeamRoster(makeCache([may], []));
    const result = await roster.lookupHuman({ email: "nobody@x.com" });
    expect(result).toBeNull();
  });

  it("does not match archived members", async () => {
    const roster = new TeamRoster(makeCache([archived], []));
    const result = await roster.lookupHuman({ name: "Konstantin" });
    expect(result).toBeNull();
  });

  it("returns most recently updated when multiple match same email", async () => {
    const roster = new TeamRoster(makeCache([may, mayNewer], []));
    const result = await roster.lookupHuman({ email: "may@dodihome.com" });
    expect(result?.id).toBe("may-id-newer");
  });

  it("throws when both args provided", async () => {
    const roster = new TeamRoster(makeCache([may], []));
    await expect(roster.lookupHuman({ name: "x", email: "x@y.com" })).rejects.toThrow(/exactly one/);
  });

  it("throws when neither arg provided", async () => {
    const roster = new TeamRoster(makeCache([may], []));
    await expect(roster.lookupHuman({})).rejects.toThrow(/exactly one/);
  });
});

describe("TeamRoster.lookupAgent", () => {
  it("matches by agentId (case-sensitive)", async () => {
    const roster = new TeamRoster(makeCache([], [jasper]));
    expect((await roster.lookupAgent({ agentId: "jasper" }))?.id).toBe("jasper");
    expect(await roster.lookupAgent({ agentId: "JASPER" })).toBeNull(); // case-sensitive
  });

  it("matches by name (case-insensitive)", async () => {
    const roster = new TeamRoster(makeCache([], [jasper]));
    expect((await roster.lookupAgent({ name: "JASPER" }))?.id).toBe("jasper");
  });

  it("matches by alias (case-insensitive)", async () => {
    const roster = new TeamRoster(makeCache([], [jasper]));
    expect((await roster.lookupAgent({ name: "jas" }))?.id).toBe("jasper");
    expect((await roster.lookupAgent({ name: "JAS" }))?.id).toBe("jasper");
  });

  it("returns null on miss", async () => {
    const roster = new TeamRoster(makeCache([], [jasper]));
    expect(await roster.lookupAgent({ name: "noone" })).toBeNull();
  });

  it("does not match archived/disabled agents (symmetric with lookupHuman)", async () => {
    const roster = new TeamRoster(makeCache([], [noraDisabled]));
    expect(await roster.lookupAgent({ agentId: "nora" })).toBeNull();
    expect(await roster.lookupAgent({ name: "Nora" })).toBeNull();
  });

  it("throws when both args provided", async () => {
    const roster = new TeamRoster(makeCache([], [jasper]));
    await expect(roster.lookupAgent({ agentId: "x", name: "y" })).rejects.toThrow(/exactly one/);
  });
});

describe("TeamRoster.teamSummary", () => {
  it("emits markdown with sections + members", async () => {
    const roster = new TeamRoster(makeCache([may], [jasper]));
    const summary = await roster.teamSummary();
    expect(summary).toContain("## Team");
    expect(summary).toContain("### Humans");
    expect(summary).toContain("### AI Agents");
    expect(summary).toContain("**May Huang**");
    expect(summary).toContain("CEO");
    expect(summary).toContain("**Jasper**");
    expect(summary).toContain("`#agent-jasper`");
    expect(summary).toContain("team_lookup_human");
  });

  it("returns empty string when team is empty", async () => {
    const roster = new TeamRoster(makeCache([], []));
    const summary = await roster.teamSummary();
    expect(summary).toBe("");
  });

  it("excludes archived members", async () => {
    const roster = new TeamRoster(makeCache([may, archived], [jasper, noraDisabled]));
    const summary = await roster.teamSummary();
    expect(summary).not.toContain("Konstantin");
    expect(summary).not.toContain("Nora");
  });

  it("joins multiple roles with ' / ' for agents", async () => {
    const multiRoleAgent: TeamMember = {
      kind: "agent",
      id: "multi",
      name: "Multi",
      category: "team-agent",
      agentId: "multi",
      roles: ["A", "B"],
      active: true,
    };
    const roster = new TeamRoster(makeCache([], [multiRoleAgent]));
    const summary = await roster.teamSummary();
    expect(summary).toContain("**Multi** — A / B");
  });
});
