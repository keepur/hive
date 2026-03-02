import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig, AgentSchedule } from "../types/agent-config.js";

const log = createLogger("agent-registry");

export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
  }

  async load(): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
    const previousIds = new Set(this.agents.keys());
    const currentIds = new Set<string>();
    const added: string[] = [];
    const updated: string[] = [];

    const entries = await readdir(this.basePath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const agentDir = join(this.basePath, entry.name);
      try {
        const config = await this.loadAgent(agentDir, entry.name);
        currentIds.add(config.id);

        if (previousIds.has(config.id)) {
          updated.push(config.id);
        } else {
          added.push(config.id);
        }

        this.agents.set(config.id, config);
        log.info("Loaded agent", { id: config.id, name: config.name });
      } catch (err) {
        log.error("Failed to load agent", { dir: entry.name, error: String(err) });
      }
    }

    // Remove agents whose directories were deleted
    const removed: string[] = [];
    for (const id of previousIds) {
      if (!currentIds.has(id)) {
        this.agents.delete(id);
        removed.push(id);
        log.info("Removed agent", { id });
      }
    }

    return { added, updated, removed };
  }

  private async loadAgent(dir: string, dirName: string): Promise<AgentConfig> {
    const yamlPath = join(dir, "agent.yaml");
    const promptPath = join(dir, "system-prompt.md");
    const soulPath = join(dir, "soul.md");

    const yamlContent = await readFile(yamlPath, "utf-8");
    const raw = parseYaml(yamlContent) as Record<string, unknown>;

    const systemPrompt = await readFile(promptPath, "utf-8");
    const soul = await readFile(soulPath, "utf-8").catch(() => "");

    return {
      id: (raw.id as string) || dirName,
      name: (raw.name as string) || dirName,
      model: (raw.model as string) || "claude-sonnet-4-6",
      channels: (raw.channels as string[]) || [],
      keywords: (raw.keywords as string[]) || [],
      isDefault: (raw.isDefault as boolean) || false,
      schedule: (raw.schedule as AgentSchedule[]) || [],
      budgetUsd: (raw.budgetUsd as number) || 10,
      maxTurns: (raw.maxTurns as number) || 25,
      icon: (raw.icon as string) || "",
      slackBot: (raw.slackBot as string) || undefined,
      servers: (raw.servers as string[]) || undefined,
      soul,
      systemPrompt,
    };
  }

  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  getAll(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  listIds(): string[] {
    return Array.from(this.agents.keys());
  }

  findByChannel(channelName: string): AgentConfig | undefined {
    return this.getAll().find((a) => a.channels.includes(channelName));
  }

  findByKeyword(text: string): AgentConfig | undefined {
    const lower = text.toLowerCase();
    return this.getAll().find((a) =>
      a.keywords.some((kw) => {
        const escaped = kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`).test(lower);
      }),
    );
  }

  findByName(text: string): AgentConfig | undefined {
    const lower = text.toLowerCase();
    return this.getAll().find((a) => {
      const name = a.name.toLowerCase();
      // Match "hey River", "River,", "@River", or just "River" at word boundaries
      const pattern = new RegExp(`(?:^|hey\\s+|@)${name}\\b|\\b${name}[,:]`, "i");
      return pattern.test(text);
    });
  }

  getDefault(): AgentConfig | undefined {
    return this.getAll().find((a) => a.isDefault);
  }
}
