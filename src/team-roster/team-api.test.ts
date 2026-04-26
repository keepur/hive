import { describe, expect, it } from "vitest";
import { TeamApi } from "./team-api.js";
import type { TeamMember } from "./types.js";

function fakeCache(humans: TeamMember[], agents: TeamMember[], aliases: Record<string, string> = {}) {
  return {
    getHumans: async () => humans,
    getAgents: async () => agents,
    getAgentAliases: async () => new Map(Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), v])),
  } as any;
}

const human = (over: Partial<TeamMember> = {}): TeamMember => ({
  kind: "human",
  id: "h1",
  name: "May",
  email: "may@dodihome.com",
  category: "team-human",
  active: true,
  ...over,
});
const agent = (over: Partial<TeamMember> = {}): TeamMember => ({
  kind: "agent",
  id: "mokie",
  agentId: "mokie",
  name: "Mokie",
  category: "team-agent",
  active: true,
  ...over,
});

describe("TeamApi", () => {
  it("getTeam excludes archived by default", async () => {
    const api = new TeamApi(
      fakeCache([human(), human({ id: "h2", name: "Konstantin", category: "archived", active: false })], []),
    );
    const out = await api.getTeam();
    expect(out.map((m) => m.name)).toEqual(["May"]);
  });

  it("getTeam(includeArchived) returns archived too", async () => {
    const api = new TeamApi(
      fakeCache([human(), human({ id: "h2", name: "Konstantin", category: "archived", active: false })], []),
    );
    const out = await api.getTeam({ includeArchived: true });
    expect(out.length).toBe(2);
  });

  it("getTeam(includeAgents=false) filters to humans", async () => {
    const api = new TeamApi(fakeCache([human()], [agent()]));
    const out = await api.getTeam({ includeAgents: false });
    expect(out.every((m) => m.kind === "human")).toBe(true);
  });

  it("lookupHuman by email is case-insensitive", async () => {
    const api = new TeamApi(fakeCache([human()], []));
    const out = await api.lookupHuman({ email: "MAY@DODIHOME.COM" });
    expect(out?.id).toBe("h1");
  });

  it("lookupHuman by name is case-insensitive exact match", async () => {
    const api = new TeamApi(fakeCache([human()], []));
    expect((await api.lookupHuman({ name: "may" }))?.id).toBe("h1");
    expect(await api.lookupHuman({ name: "ma" })).toBeNull();
  });

  it("lookupHuman throws on neither/both args", async () => {
    const api = new TeamApi(fakeCache([], []));
    await expect(api.lookupHuman({})).rejects.toThrow(/exactly one/);
    await expect(api.lookupHuman({ name: "x", email: "y@z.com" })).rejects.toThrow(/exactly one/);
  });

  it("lookupHuman ignores non-team-human records (defensive)", async () => {
    const api = new TeamApi(fakeCache([human({ category: "archived", active: false })], []));
    expect(await api.lookupHuman({ name: "May" })).toBeNull();
  });

  it("lookupAgent by agentId is case-sensitive", async () => {
    const api = new TeamApi(fakeCache([], [agent()]));
    expect((await api.lookupAgent({ agentId: "mokie" }))?.agentId).toBe("mokie");
    expect(await api.lookupAgent({ agentId: "Mokie" })).toBeNull();
  });

  it("lookupAgent by alias resolves to canonical agent", async () => {
    const api = new TeamApi(fakeCache([], [agent({ name: "Samantha", agentId: "samantha" })], { Sam: "samantha" }));
    expect((await api.lookupAgent({ name: "Sam" }))?.agentId).toBe("samantha");
  });

  it("lookupAgent throws on neither/both args", async () => {
    const api = new TeamApi(fakeCache([], []));
    await expect(api.lookupAgent({})).rejects.toThrow(/exactly one/);
    await expect(api.lookupAgent({ agentId: "a", name: "b" })).rejects.toThrow(/exactly one/);
  });

  it("teamSummary renders a markdown table with channel + pronouns", async () => {
    const api = new TeamApi(
      fakeCache(
        [human({ name: "May", role: "CEO", pronouns: "she/her" })],
        [agent({ name: "Mokie", role: "Chief of Staff", slackChannel: "agent-mokie", pronouns: "she/her" })],
      ),
    );
    const out = await api.teamSummary();
    expect(out).toContain("## Team Roster");
    expect(out).toContain("| Name | Role | Channel | Pronouns |");
    expect(out).toContain("| May | CEO |  | she/her |");
    expect(out).toContain("| Mokie | Chief of Staff | #agent-mokie | she/her |");
  });
});
