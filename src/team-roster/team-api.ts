import type { TeamCache } from "./team-cache.js";
import type { TeamMember } from "./types.js";

export interface TeamListOptions {
  includeArchived?: boolean;
  includeAgents?: boolean;
}

export class TeamApi {
  constructor(private readonly cache: TeamCache) {}

  async getTeam(opts: TeamListOptions = {}): Promise<TeamMember[]> {
    const includeArchived = opts.includeArchived ?? false;
    const includeAgents = opts.includeAgents ?? true;
    const humans = await this.cache.getHumans();
    const agents = includeAgents ? await this.cache.getAgents() : [];
    const all = [...humans, ...agents];
    const filtered = includeArchived ? all : all.filter((m) => m.active !== false);
    return filtered.sort((a, b) => {
      // humans before agents, then by name
      if (a.kind !== b.kind) return a.kind === "human" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async lookupHuman(arg: { name?: string; email?: string }): Promise<TeamMember | null> {
    const hasName = typeof arg.name === "string" && arg.name.length > 0;
    const hasEmail = typeof arg.email === "string" && arg.email.length > 0;
    if (hasName === hasEmail) {
      throw new Error("team_lookup_human requires exactly one of { name, email }");
    }
    const humans = (await this.cache.getHumans()).filter((m) => m.category === "team-human");
    if (hasEmail) {
      const target = arg.email!.toLowerCase();
      const matches = humans.filter((m) => m.email && m.email.toLowerCase() === target);
      return mostRecent(matches);
    }
    const target = arg.name!.toLowerCase();
    const matches = humans.filter((m) => m.name.toLowerCase() === target);
    return mostRecent(matches);
  }

  async lookupAgent(arg: { agentId?: string; name?: string }): Promise<TeamMember | null> {
    const hasId = typeof arg.agentId === "string" && arg.agentId.length > 0;
    const hasName = typeof arg.name === "string" && arg.name.length > 0;
    if (hasId === hasName) {
      throw new Error("team_lookup_agent requires exactly one of { agentId, name }");
    }
    const agents = await this.cache.getAgents();
    if (hasId) {
      // case-sensitive — agent IDs are stable identifiers
      return agents.find((m) => m.agentId === arg.agentId) ?? null;
    }
    const target = arg.name!.toLowerCase();
    const direct = agents.find((m) => m.name.toLowerCase() === target);
    if (direct) return direct;
    const aliasMap = await this.cache.getAgentAliases();
    const aliasedId = aliasMap.get(target);
    if (!aliasedId) return null;
    return agents.find((m) => m.agentId === aliasedId) ?? null;
  }

  async teamSummary(): Promise<string> {
    const members = await this.getTeam({ includeArchived: false, includeAgents: true });
    if (members.length === 0) return "";
    const lines: string[] = [];
    lines.push("## Team Roster\n");
    lines.push("| Name | Role | Channel | Pronouns |");
    lines.push("|---|---|---|---|");
    for (const m of members) {
      const channel = m.slackChannel ? `#${m.slackChannel}` : "";
      lines.push(`| ${m.name} | ${m.role ?? ""} | ${channel} | ${m.pronouns ?? ""} |`);
    }
    return lines.join("\n");
  }
}

function mostRecent(matches: TeamMember[]): TeamMember | null {
  if (matches.length === 0) return null;
  // We don't carry updatedAt on TeamMember; matches list order from getHumans
  // mirrors Mongo natural order. For determinism with multiple matches, return
  // the first; team-human duplicates are a data hygiene issue surfaced at
  // migration time.
  return matches[0];
}
