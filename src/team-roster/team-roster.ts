import type { TeamCache } from "./team-cache.js";
import type { TeamMember } from "./types.js";

export interface TeamRosterOptions {
  includeArchived?: boolean;
  includeAgents?: boolean;
}

/**
 * Engine-native team API. Backed by a two-slice cache (humans + agents).
 * Exposes:
 *   - getTeam(): list view (humans + agents) with sort + archived filter
 *   - lookupHuman(): exact match by name OR email (case-insensitive)
 *   - lookupAgent(): exact match by agentId OR name/alias
 *   - teamSummary(): markdown block for system-prompt injection
 */
export class TeamRoster {
  constructor(private cache: TeamCache) {}

  async getTeam(opts: TeamRosterOptions = {}): Promise<TeamMember[]> {
    const includeArchived = opts.includeArchived ?? false;
    const includeAgents = opts.includeAgents ?? true;

    const humans = await this.cache.getHumans();
    const agents = includeAgents ? await this.cache.getAgents() : [];
    const all = [...humans, ...agents];
    const filtered = includeArchived ? all : all.filter((m) => m.category !== "archived");

    return filtered.sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.name.localeCompare(b.name);
    });
  }

  async lookupHuman(args: { name?: string; email?: string }): Promise<TeamMember | null> {
    const haveName = typeof args.name === "string" && args.name.length > 0;
    const haveEmail = typeof args.email === "string" && args.email.length > 0;
    if (haveName === haveEmail) {
      throw new Error("lookupHuman: exactly one of name|email required");
    }

    const humans = (await this.cache.getHumans()).filter((m) => m.category === "team-human");

    if (haveEmail) {
      const target = args.email!.toLowerCase();
      const matches = humans.filter((m) => m.email && m.email.toLowerCase() === target);
      return pickMostRecent(matches);
    }

    const target = args.name!.toLowerCase();
    const matches = humans.filter((m) => m.name.toLowerCase() === target);
    return pickMostRecent(matches);
  }

  async lookupAgent(args: { agentId?: string; name?: string }): Promise<TeamMember | null> {
    const haveId = typeof args.agentId === "string" && args.agentId.length > 0;
    const haveName = typeof args.name === "string" && args.name.length > 0;
    if (haveId === haveName) {
      throw new Error("lookupAgent: exactly one of agentId|name required");
    }

    const agents = await this.cache.getAgents();

    if (haveId) {
      // agentId match is case-sensitive — these are stable identifiers.
      return agents.find((m) => m.agentId === args.agentId) ?? null;
    }

    const target = args.name!.toLowerCase();
    const direct = agents.find((m) => m.name.toLowerCase() === target);
    if (direct) return direct;
    return agents.find((m) => (m.aliases ?? []).some((a) => a.toLowerCase() === target)) ?? null;
  }

  /**
   * Markdown summary block for system-prompt injection. Concise — names + roles
   * + agent slack channels. Full details available via the lookup tools.
   */
  async teamSummary(): Promise<string> {
    const team = await this.getTeam({ includeArchived: false, includeAgents: true });
    const humans = team.filter((m) => m.kind === "human");
    const agents = team.filter((m) => m.kind === "agent");

    const lines: string[] = ["## Team"];
    if (humans.length > 0) {
      lines.push("", "### Humans");
      for (const h of humans) {
        const role = h.role ? ` — ${h.role}` : "";
        lines.push(`- **${h.name}**${role}`);
      }
    }
    if (agents.length > 0) {
      lines.push("", "### AI Agents");
      for (const a of agents) {
        const role = a.role ? ` — ${a.role}` : "";
        const channel = a.slackChannel ? ` (\`#${a.slackChannel}\`)` : "";
        lines.push(`- **${a.name}**${channel}${role}`);
      }
    }
    if (humans.length === 0 && agents.length === 0) {
      return "";
    }
    lines.push("", "Use `team_lookup_human` / `team_lookup_agent` for full contact details.");
    return lines.join("\n");
  }
}

function pickMostRecent(matches: TeamMember[]): TeamMember | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const sorted = [...matches].sort((a, b) => {
    const aTs = a.updatedAt ? a.updatedAt.getTime() : 0;
    const bTs = b.updatedAt ? b.updatedAt.getTime() : 0;
    return bTs - aTs; // most recent first
  });
  return sorted[0];
}
