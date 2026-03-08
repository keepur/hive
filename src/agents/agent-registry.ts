import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig, AgentSchedule } from "../types/agent-config.js";
import { MongoClient, type Collection, type Db } from "mongodb";

const log = createLogger("agent-registry");

interface ModelOverride {
  agentId: string;
  model: string;
  updatedAt: Date;
  updatedBy?: string;
}

export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();
  private basePath: string;
  private modelOverrides = new Map<string, string>();
  private db?: Db;
  private overridesCollection?: Collection<ModelOverride>;

  constructor(basePath: string) {
    this.basePath = resolve(basePath);
  }

  /** Connect to MongoDB for dynamic model overrides */
  async connectDb(mongoUri: string, dbName: string): Promise<void> {
    const client = new MongoClient(mongoUri);
    await client.connect();
    this.db = client.db(dbName);
    this.overridesCollection = this.db.collection<ModelOverride>("model_overrides");
    await this.overridesCollection.createIndex({ agentId: 1 }, { unique: true });
    await this.loadModelOverrides();
    log.info("Model overrides loaded from MongoDB");
  }

  private async loadModelOverrides(): Promise<void> {
    if (!this.overridesCollection) return;
    const docs = await this.overridesCollection.find().toArray();
    this.modelOverrides.clear();
    for (const doc of docs) {
      this.modelOverrides.set(doc.agentId, doc.model);
    }
    if (docs.length > 0) {
      log.info("Active model overrides", {
        overrides: Object.fromEntries(this.modelOverrides),
      });
    }
  }

  async load(): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
    // Refresh model overrides on every reload
    await this.loadModelOverrides();
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

    const agentId = (raw.id as string) || dirName;
    const yamlModel = (raw.model as string) || "claude-sonnet-4-6";
    const model = this.modelOverrides.get(agentId) ?? yamlModel;

    if (this.modelOverrides.has(agentId)) {
      log.info("Model override active", { agent: agentId, yaml: yamlModel, override: model });
    }

    return {
      id: agentId,
      name: (raw.name as string) || dirName,
      model,
      channels: (raw.channels as string[]) || [],
      keywords: (raw.keywords as string[]) || [],
      isDefault: (raw.isDefault as boolean) || false,
      schedule: (raw.schedule as AgentSchedule[]) || [],
      budgetUsd: (raw.budgetUsd as number) || 10,
      maxTurns: (raw.maxTurns as number) || 25,
      icon: (raw.icon as string) || "",
      slackBot: (raw.slackBot as string) || undefined,
      servers: (raw.servers as string[]) || undefined,
      maxConcurrent: (raw.maxConcurrent as number) || undefined,
      timeoutMs: (raw.timeoutMs as number) || undefined,
      triageModel: (raw.triageModel as string) || undefined,
      dodiOpsMode: (raw.dodiOpsMode as "full" | "readonly") || undefined,
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
