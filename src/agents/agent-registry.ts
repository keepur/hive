import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig, AgentSchedule, ConfigOverride, ArrayOverride } from "../types/agent-config.js";
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
  private configOverrides = new Map<string, ConfigOverride>();
  private db?: Db;
  private overridesCollection?: Collection<ModelOverride>;
  private configOverridesCollection?: Collection<ConfigOverride>;
  private templateConfigs = new Map<string, AgentConfig>(); // pre-override snapshots

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

    this.configOverridesCollection = this.db.collection<ConfigOverride>("agent_config_overrides");
    await this.configOverridesCollection.createIndex({ agentId: 1 }, { unique: true });
    await this.loadConfigOverrides();
    log.info("Config overrides loaded from MongoDB");
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

  private async loadConfigOverrides(): Promise<void> {
    if (!this.configOverridesCollection) return;
    const docs = await this.configOverridesCollection.find().toArray();
    this.configOverrides.clear();
    for (const doc of docs) {
      this.configOverrides.set(doc.agentId, doc);
    }
    if (docs.length > 0) {
      log.info("Active config overrides", {
        agents: docs.map((d) => d.agentId),
      });
    }
  }

  async load(): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
    // Refresh overrides on every reload
    await this.loadModelOverrides();
    await this.loadConfigOverrides();
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

    const config: AgentConfig = {
      id: agentId,
      name: (raw.name as string) || dirName,
      model,
      channels: (raw.channels as string[]) || [],
      passiveChannels: (raw.passiveChannels as string[]) || [],
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

    // Save pre-override snapshot for comparison
    this.templateConfigs.set(config.id, { ...config });

    return this.applyConfigOverrides(config);
  }

  private applyConfigOverrides(config: AgentConfig): AgentConfig {
    const override = this.configOverrides.get(config.id);
    if (!override) return config;

    const template = this.templateConfigs.get(config.id);

    // Apply array field overrides
    const arrayFields = ["channels", "passiveChannels", "keywords", "servers"] as const;
    for (const field of arrayFields) {
      const arrOverride = override[field] as ArrayOverride | undefined;
      if (!arrOverride) continue;

      if (arrOverride.replace) {
        (config as unknown as Record<string, unknown>)[field] = [...arrOverride.replace];
      } else {
        const base = [...((template?.[field] as string[]) || [])];
        const added = arrOverride.add ? [...base, ...arrOverride.add.filter((v) => !base.includes(v))] : base;
        const result = arrOverride.remove ? added.filter((v) => !arrOverride.remove!.includes(v)) : added;
        (config as unknown as Record<string, unknown>)[field] = result;
      }
    }

    // Apply scalar field overrides
    if (override.isDefault !== undefined) config.isDefault = override.isDefault;
    if (override.budgetUsd !== undefined) config.budgetUsd = override.budgetUsd;
    if (override.maxTurns !== undefined) config.maxTurns = override.maxTurns;
    if (override.maxConcurrent !== undefined) config.maxConcurrent = override.maxConcurrent;
    if (override.timeoutMs !== undefined) config.timeoutMs = override.timeoutMs;

    log.info("Config override applied", { agent: config.id });
    return config;
  }

  /** Get the pre-override template config for an agent */
  getTemplate(id: string): AgentConfig | undefined {
    return this.templateConfigs.get(id);
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

  /** Check if any agent has this channel as passive (listen but don't auto-route) */
  isPassiveChannel(channelName: string): boolean {
    return this.getAll().some((a) => a.passiveChannels.includes(channelName));
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
