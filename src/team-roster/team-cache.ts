import type { Collection } from "mongodb";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { TeamMember } from "./types.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("team-roster:cache");
const TTL_MS = 60_000;

export interface ContactRow {
  _id: { toHexString(): string };
  name: string;
  firstName?: string;
  lastName?: string;
  email: string | null;
  role?: string;
  pronouns?: string;
  category?: string;
  updatedAt?: Date;
}

interface Slice<T> {
  data: T[] | null;
  populatedAt: number;
}

export class TeamCache {
  private humans: Slice<TeamMember> = { data: null, populatedAt: 0 };
  private agents: Slice<TeamMember> = { data: null, populatedAt: 0 };

  constructor(
    private readonly contactsCol: Collection<ContactRow>,
    private readonly registry: AgentRegistry,
  ) {}

  invalidateHumans(): void {
    log.debug("invalidate humans");
    this.humans = { data: null, populatedAt: 0 };
  }

  invalidateAgents(): void {
    log.debug("invalidate agents");
    this.agents = { data: null, populatedAt: 0 };
  }

  async getHumans(): Promise<TeamMember[]> {
    if (this.isFresh(this.humans)) return this.humans.data!;
    // Only `team-human` — `archived` is shared with deduped customer rows
    // from the migration script and isn't reliably "former team-human".
    // includeArchived on the humans slice is a no-op; team membership is
    // live data per spec, not history.
    const rows = await this.contactsCol.find({ category: "team-human" }).toArray();
    const data: TeamMember[] = rows.map((c) => ({
      kind: "human",
      id: c._id.toHexString(),
      name: c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
      email: c.email ?? undefined,
      role: c.role,
      pronouns: c.pronouns,
      category: "team-human",
      active: true,
    }));
    this.humans = { data, populatedAt: Date.now() };
    return data;
  }

  async getAgents(): Promise<TeamMember[]> {
    if (this.isFresh(this.agents)) return this.agents.data!;
    const defs = await this.registry.getAllDefinitions();
    const data: TeamMember[] = defs.map((d) => ({
      kind: "agent",
      id: d._id,
      agentId: d._id,
      name: d.name,
      role: d.title,
      slackChannel: d.homeBase,
      model: d.model,
      category: d.disabled ? "archived" : "team-agent",
      active: !d.disabled,
    }));
    this.agents = { data, populatedAt: Date.now() };
    return data;
  }

  async getAgentAliases(): Promise<Map<string, string>> {
    // alias-lowercased → agentId. Always derived from registry, not cached
    // separately — registry data is already cached.
    const defs = await this.registry.getAllDefinitions();
    const out = new Map<string, string>();
    for (const d of defs) {
      for (const alias of d.aliases ?? []) {
        out.set(alias.toLowerCase(), d._id);
      }
    }
    return out;
  }

  private isFresh<T>(slice: Slice<T>): boolean {
    return slice.data !== null && Date.now() - slice.populatedAt < TTL_MS;
  }
}
