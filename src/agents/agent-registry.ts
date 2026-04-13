import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { toAgentConfig } from "../types/agent-definition.js";
import { config as appConfig } from "../config.js";
import { getArchetype } from "../archetypes/registry.js";
import "../archetypes/index.js";
import type { Collection, ChangeStream } from "mongodb";

const log = createLogger("agent-registry");

const POLL_INTERVAL_MS = 30_000;

export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();
  private originToAgent = new Map<string, string>();
  private disabledAgents: AgentConfig[] = [];
  private agentDefs: Collection<AgentDefinition>;
  private changeStream: ChangeStream | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime = new Date(0);
  private onReload?: () => void;

  constructor(agentDefs: Collection<AgentDefinition>, onReload?: () => void) {
    this.agentDefs = agentDefs;
    this.onReload = onReload;
  }

  async load(): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
    const docs = await this.agentDefs.find().toArray();
    const previousIds = new Set(this.agents.keys());
    const currentIds = new Set<string>();
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const newDisabled: AgentConfig[] = [];

    for (const doc of docs) {
      const agentConfig = toAgentConfig(doc, appConfig.autonomy);
      currentIds.add(agentConfig.id);

      // Disabled check first — skip all validation for disabled agents.
      // Without this, a disabled agent with invalid archetypeConfig would
      // fail validation and get evicted instead of being quietly skipped.
      if (agentConfig.disabled) {
        newDisabled.push(agentConfig);
        if (this.agents.has(agentConfig.id)) {
          this.agents.delete(agentConfig.id);
          removed.push(agentConfig.id);
          log.info("Disabled agent removed from active map", { id: agentConfig.id });
        }
        continue;
      }

      // Archetype validation (fail-closed on invalid archetypeConfig)
      if (agentConfig.archetype) {
        const def = getArchetype(agentConfig.archetype);
        if (!def) {
          // Graceful degradation — unknown archetype runs as unstructured.
          log.warn("Unknown archetype — loading agent as unstructured", {
            id: agentConfig.id,
            archetype: agentConfig.archetype,
          });
          agentConfig.archetype = undefined;
          agentConfig.archetypeConfig = undefined;
        } else {
          try {
            // Replace raw blob with archetype-validated typed config.
            agentConfig.archetypeConfig = def.validateConfig(agentConfig.archetypeConfig) as Record<string, unknown>;
          } catch (err) {
            log.error("Archetype config validation failed — agent will not load", {
              id: agentConfig.id,
              archetype: agentConfig.archetype,
              error: String(err),
            });
            // Fail-closed: evict any previously-loaded version so a stale valid
            // config doesn't keep serving requests after the DB doc goes bad.
            if (this.agents.has(agentConfig.id)) {
              this.agents.delete(agentConfig.id);
              removed.push(agentConfig.id);
              log.warn("Evicted previously-loaded agent due to archetype validation failure", {
                id: agentConfig.id,
              });
            }
            continue;
          }
        }
      }

      if (previousIds.has(agentConfig.id)) {
        updated.push(agentConfig.id);
      } else {
        added.push(agentConfig.id);
      }

      this.agents.set(agentConfig.id, agentConfig);
      log.info("Loaded agent", { id: agentConfig.id, name: agentConfig.name });
    }

    this.disabledAgents = newDisabled;

    for (const id of previousIds) {
      if (!currentIds.has(id)) {
        this.agents.delete(id);
        removed.push(id);
        log.info("Removed agent", { id });
      }
    }

    this.lastPollTime = new Date();
    this.rebuildOriginIndex();
    return { added, updated, removed };
  }

  async startWatching(): Promise<void> {
    try {
      this.changeStream = this.agentDefs.watch([], { fullDocument: "updateLookup" });
      this.changeStream.on("change", () => {
        log.info("Agent definition changed (change stream), triggering reload");
        this.onReload?.();
      });
      this.changeStream.on("error", (err) => {
        log.warn("Change stream error, falling back to polling", { error: String(err) });
        this.changeStream = null;
        this.startPolling();
      });
      log.info("Agent registry watching via change stream");
    } catch {
      log.info("Change stream not available, using polling fallback");
      this.startPolling();
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        const changed = await this.agentDefs.countDocuments({
          updatedAt: { $gt: this.lastPollTime },
        });
        if (changed > 0) {
          log.info("Agent definitions changed (poll), triggering reload", { changed });
          this.onReload?.();
        }
      } catch (err) {
        log.error("Poll check failed", { error: String(err) });
      }
    }, POLL_INTERVAL_MS);
    log.info("Agent registry watching via polling", { intervalMs: POLL_INTERVAL_MS });
  }

  private rebuildOriginIndex(): void {
    this.originToAgent.clear();
    // Sort by id so conflict resolution is deterministic regardless of Map iteration order.
    const sorted = [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const agent of sorted) {
      for (const slug of agent.catches ?? []) {
        if (this.originToAgent.has(slug)) {
          log.error("Origin conflict — first sorted agent wins", {
            origin: slug,
            winner: this.originToAgent.get(slug),
            loser: agent.id,
          });
          continue;
        }
        this.originToAgent.set(slug, agent.id);
      }
    }
  }

  stopWatching(): void {
    if (this.changeStream) {
      this.changeStream.close().catch(() => {});
      this.changeStream = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  getAll(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  async getAllDefinitions(): Promise<AgentDefinition[]> {
    return this.agentDefs.find().toArray();
  }

  listIds(): string[] {
    return Array.from(this.agents.keys());
  }

  findByChannel(channelName: string): AgentConfig | undefined {
    return this.getAll().find((a) => !a.disabled && a.channels.includes(channelName));
  }

  findByOrigin(slug: string): AgentConfig | undefined {
    const agentId = this.originToAgent.get(slug);
    return agentId ? this.agents.get(agentId) : undefined;
  }

  isPassiveChannel(channelName: string): boolean {
    return this.getAll().some((a) => !a.disabled && a.passiveChannels.includes(channelName));
  }

  findByKeyword(text: string): AgentConfig | undefined {
    const lower = text.toLowerCase();
    return this.getAll().find((a) =>
      !a.disabled &&
      a.keywords.some((kw) => {
        const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`).test(lower);
      }),
    );
  }

  findByName(text: string): AgentConfig | undefined {
    return this.findAllByName(text)[0];
  }

  findAllByName(text: string): AgentConfig[] {
    return this.getAll().filter((a) => {
      if (a.disabled) return false;
      const name = a.name.toLowerCase();
      const pattern = new RegExp(`(?:^|hey\\s+|@)${name}\\b|\\b${name}[,:]`, "i");
      if (pattern.test(text)) return true;
      // Also match on first name for multi-word names (e.g. "Alex" matches "Alex Chen")
      if (name.includes(" ")) {
        const firstName = name.split(" ")[0];
        const firstNamePattern = new RegExp(`(?:^|hey\\s+|@)${firstName}\\b|\\b${firstName}[,:]`, "i");
        return firstNamePattern.test(text);
      }
      return false;
    });
  }

  getDefault(): AgentConfig | undefined {
    return this.getAll().find((a) => !a.disabled && a.isDefault);
  }

  getDisabled(): AgentConfig[] {
    return this.disabledAgents;
  }

  getSubscriberMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const agent of this.getAll()) {
      if (agent.disabled) continue;
      for (const sub of agent.subscribe ?? []) {
        const domain = sub.includes(":") ? sub.split(":")[0] : sub;
        if (!map[domain]) map[domain] = [];
        if (!map[domain].includes(agent.id)) {
          map[domain].push(agent.id);
        }
      }
    }
    return map;
  }
}
