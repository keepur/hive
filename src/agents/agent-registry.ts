import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { toAgentConfig } from "../types/agent-definition.js";
import type { Collection, ChangeStream } from "mongodb";

const log = createLogger("agent-registry");

const POLL_INTERVAL_MS = 30_000;

export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();
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

    const newDisabled: AgentConfig[] = [];

    for (const doc of docs) {
      const config = toAgentConfig(doc);
      currentIds.add(config.id);

      if (config.disabled) {
        newDisabled.push(config);
        continue;
      }

      if (previousIds.has(config.id)) {
        updated.push(config.id);
      } else {
        added.push(config.id);
      }

      this.agents.set(config.id, config);
      log.info("Loaded agent", { id: config.id, name: config.name });
    }

    this.disabledAgents = newDisabled;

    const removed: string[] = [];
    for (const id of previousIds) {
      if (!currentIds.has(id)) {
        this.agents.delete(id);
        removed.push(id);
        log.info("Removed agent", { id });
      }
    }

    this.lastPollTime = new Date();
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
      return pattern.test(text);
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
