import type { Db, ObjectId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { ContactCategory, TeamMember } from "./types.js";

const log = createLogger("team-cache");
const TTL_MS = 60_000;

// Local narrow projections of the canonical schemas. These exist deliberately:
// the cache only needs the fields that participate in TeamMember mapping, and
// keeping a narrow shape here avoids a wide import surface from contacts-mcp-
// server.ts and agent-registry.ts. Add a field here only when TeamMember
// actually uses it; cross-check with the canonical types if the schema evolves.
interface AgentDefDoc {
  _id: string;
  name: string;
  roles?: string[];
  model?: string;
  homeBase?: string;
  channels?: string[];
  aliases?: string[];
  disabled?: boolean;
}

interface ContactDoc {
  _id: ObjectId;
  name: string;
  firstName?: string;
  lastName?: string;
  email: string | null;
  role?: string;
  pronouns?: string;
  category?: ContactCategory;
  updatedAt?: Date;
}

interface CacheSlice<T> {
  data: T[] | null;
  loadedAt: number;
}

/**
 * Two-slice in-memory cache for the team roster (humans + agents).
 *
 * - Humans slice: contacts where category ∈ {"team-human", "archived"}.
 *   Both are loaded together so `team_list` with includeArchived=true returns
 *   archived members; `lookupHuman` filters to category === "team-human" only.
 * - Agents slice: every record in agent_definitions; disabled→archived,
 *   else→team-agent. `team-agent` is not a stored ContactDoc.category — it's
 *   synthesized at query time per the spec.
 *
 * Invalidation hooks: invalidateHumans() / invalidateAgents() are called by
 * external listeners (the agent-registry onPostReload subscriber and the
 * contacts change-stream watcher). 60s TTL fallback in case a hook is missed.
 */
export class TeamCache {
  private humans: CacheSlice<TeamMember> = { data: null, loadedAt: 0 };
  private agents: CacheSlice<TeamMember> = { data: null, loadedAt: 0 };

  constructor(private db: Db) {}

  invalidateHumans(): void {
    log.debug("humans slice invalidated");
    this.humans = { data: null, loadedAt: 0 };
  }

  invalidateAgents(): void {
    log.debug("agents slice invalidated");
    this.agents = { data: null, loadedAt: 0 };
  }

  async getHumans(): Promise<TeamMember[]> {
    if (this.humans.data && Date.now() - this.humans.loadedAt < TTL_MS) {
      return this.humans.data;
    }
    const docs = await this.db
      .collection<ContactDoc>("contacts")
      .find({ category: { $in: ["team-human", "archived"] } })
      .toArray();
    const members: TeamMember[] = docs.map((d) => ({
      kind: "human" as const,
      id: d._id.toHexString(),
      name: d.name || `${d.firstName ?? ""} ${d.lastName ?? ""}`.trim(),
      email: d.email ?? undefined,
      roles: d.role ? [d.role] : [],
      pronouns: d.pronouns,
      category: (d.category === "archived" ? "archived" : "team-human") as TeamMember["category"],
      updatedAt: d.updatedAt,
    }));
    this.humans = { data: members, loadedAt: Date.now() };
    return members;
  }

  async getAgents(): Promise<TeamMember[]> {
    if (this.agents.data && Date.now() - this.agents.loadedAt < TTL_MS) {
      return this.agents.data;
    }
    const docs = await this.db.collection<AgentDefDoc>("agent_definitions").find({}).toArray();
    const members: TeamMember[] = docs.map((d) => ({
      kind: "agent" as const,
      id: d._id,
      name: d.name,
      roles: d.roles ?? [],
      category: d.disabled ? "archived" : "team-agent",
      agentId: d._id,
      slackChannel: d.homeBase ?? d.channels?.[0],
      model: d.model,
      aliases: d.aliases,
      active: !d.disabled,
    }));
    this.agents = { data: members, loadedAt: Date.now() };
    return members;
  }
}
