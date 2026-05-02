import { describe, it, expect } from "vitest";
import { buildTeamRosterTools, createTeamRosterMcpServer } from "./team-roster-mcp-server.js";
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
  role: "CEO",
  category: "team-human",
};
const jasper: TeamMember = {
  kind: "agent",
  id: "jasper",
  name: "Jasper",
  category: "team-agent",
  agentId: "jasper",
  slackChannel: "agent-jasper",
  active: true,
};

function findTool(tools: ReturnType<typeof buildTeamRosterTools>, name: string) {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe("createTeamRosterMcpServer", () => {
  it("constructs with name + instance", () => {
    const roster = new TeamRoster(makeCache([may], [jasper]));
    const server = createTeamRosterMcpServer(roster);
    expect(server).toHaveProperty("instance");
    expect(server.name).toBe("team-roster");
  });
});

describe("team-roster MCP tool handlers", () => {
  it("registers all three tools", () => {
    const roster = new TeamRoster(makeCache([may], [jasper]));
    const tools = buildTeamRosterTools(roster);
    expect(tools.map((t) => t.name).sort()).toEqual(["team_list", "team_lookup_agent", "team_lookup_human"]);
  });

  it("team_list returns JSON of active members", async () => {
    const roster = new TeamRoster(makeCache([may], [jasper]));
    const tools = buildTeamRosterTools(roster);
    const result = await findTool(tools, "team_list").handler({}, undefined);
    const text = (result.content?.[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((m: TeamMember) => m.id).sort()).toEqual(["jasper", "may-id"]);
  });

  it("team_list with includeAgents=false returns humans only", async () => {
    const roster = new TeamRoster(makeCache([may], [jasper]));
    const tools = buildTeamRosterTools(roster);
    const result = await findTool(tools, "team_list").handler({ includeAgents: false }, undefined);
    const parsed = JSON.parse((result.content?.[0] as { type: string; text: string }).text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("may-id");
  });

  it("team_lookup_human returns full card by email", async () => {
    const roster = new TeamRoster(makeCache([may], []));
    const tools = buildTeamRosterTools(roster);
    const result = await findTool(tools, "team_lookup_human").handler({ email: "may@dodihome.com" }, undefined);
    const parsed = JSON.parse((result.content?.[0] as { type: string; text: string }).text);
    expect(parsed.id).toBe("may-id");
    expect(parsed.email).toBe("may@dodihome.com");
  });

  it("team_lookup_human returns isError when both args provided", async () => {
    const roster = new TeamRoster(makeCache([may], []));
    const tools = buildTeamRosterTools(roster);
    const result = await findTool(tools, "team_lookup_human").handler({ name: "x", email: "y@z.com" }, undefined);
    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text: string }).text).toMatch(/exactly one/);
  });

  it("team_lookup_human returns 'null' string on miss", async () => {
    const roster = new TeamRoster(makeCache([may], []));
    const tools = buildTeamRosterTools(roster);
    const result = await findTool(tools, "team_lookup_human").handler({ email: "nobody@example.com" }, undefined);
    expect((result.content?.[0] as { text: string }).text).toBe("null");
  });

  it("team_lookup_agent finds by alias", async () => {
    const jasperWithAlias: TeamMember = { ...jasper, aliases: ["jas"] };
    const roster = new TeamRoster(makeCache([], [jasperWithAlias]));
    const tools = buildTeamRosterTools(roster);
    const result = await findTool(tools, "team_lookup_agent").handler({ name: "jas" }, undefined);
    const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
    expect(parsed.agentId).toBe("jasper");
  });

  it("team_lookup_agent returns isError when neither arg provided", async () => {
    const roster = new TeamRoster(makeCache([], [jasper]));
    const tools = buildTeamRosterTools(roster);
    const result = await findTool(tools, "team_lookup_agent").handler({}, undefined);
    expect(result.isError).toBe(true);
  });
});
