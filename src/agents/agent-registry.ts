import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig, AgentSchedule, ConfigOverride, ArrayOverride, PromptOverride } from "../types/agent-config.js";
import { MongoClient, type Collection, type Db } from "mongodb";

const log = createLogger("agent-registry");

interface ModelOverride {
  agentId: string;
  model: string;
  updatedAt: Date;
  updatedBy?: string;
}

/**
 * Apply config overrides to an agent config.
 * Pure transformation — takes config, override, and template snapshot; returns modified config.
 */
export function applyConfigOverrides(
  config: AgentConfig,
  override: ConfigOverride | undefined,
  template: AgentConfig | undefined,
): AgentConfig {
  if (!override) return config;

  // Shallow copy to avoid mutating the cached MongoDB document
  const ov = { ...override };

  // Apply array field overrides
  const arrayFields = ["channels", "passiveChannels", "keywords", "coreServers", "delegateServers", "plugins", "subscribe"] as const;

  // Backward compat: old MongoDB override documents may have `servers` instead of `coreServers`
  if ((ov as any).servers && !ov.coreServers) {
    ov.coreServers = (ov as any).servers;
  }
  for (const field of arrayFields) {
    const arrOverride = ov[field] as ArrayOverride | undefined;
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
  if (ov.isDefault !== undefined) config.isDefault = ov.isDefault;
  if (ov.budgetUsd !== undefined) config.budgetUsd = ov.budgetUsd;
  if (ov.maxTurns !== undefined) config.maxTurns = ov.maxTurns;
  if (ov.maxConcurrent !== undefined) config.maxConcurrent = ov.maxConcurrent;
  if (ov.timeoutMs !== undefined) config.timeoutMs = ov.timeoutMs;
  if (ov.disabled !== undefined) config.disabled = ov.disabled;

  return config;
}

export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();
  private basePath: string;
  private modelOverrides = new Map<string, string>();
  private configOverrides = new Map<string, ConfigOverride>();
  private promptOverrides = new Map<string, PromptOverride>();
  private db?: Db;
  private overridesCollection?: Collection<ModelOverride>;
  private configOverridesCollection?: Collection<ConfigOverride>;
  private promptOverridesCollection?: Collection<PromptOverride>;
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

    this.promptOverridesCollection = this.db.collection<PromptOverride>("prompt_overrides");
    await this.promptOverridesCollection.createIndex({ agentId: 1 }, { unique: true });
    await this.loadPromptOverrides();
    log.info("Prompt overrides loaded from MongoDB");
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

  private async loadPromptOverrides(): Promise<void> {
    if (!this.promptOverridesCollection) return;
    const docs = await this.promptOverridesCollection.find().toArray();
    this.promptOverrides.clear();
    for (const doc of docs) {
      this.promptOverrides.set(doc.agentId, doc);
    }
    if (docs.length > 0) {
      log.info("Active prompt overrides", {
        agents: docs.map((d) => d.agentId),
      });
    }
  }

  async load(): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
    // Refresh overrides on every reload
    await this.loadModelOverrides();
    await this.loadConfigOverrides();
    await this.loadPromptOverrides();
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

    // Parse tiered servers: flat array (backward compat) or { core, delegate } object
    const rawServers = raw.servers;
    let coreServers: string[];
    let delegateServers: string[];

    if (Array.isArray(rawServers)) {
      // Backward compat: flat array = all core
      coreServers = rawServers;
      delegateServers = [];
    } else if (rawServers && typeof rawServers === "object") {
      const tiered = rawServers as { core?: string[]; delegate?: string[] };
      coreServers = tiered.core ?? [];
      delegateServers = tiered.delegate ?? [];
    } else {
      coreServers = [];
      delegateServers = [];
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
      coreServers,
      delegateServers,
      plugins: (raw.plugins as string[]) || undefined,
      maxConcurrent: (raw.maxConcurrent as number) || undefined,
      timeoutMs: (raw.timeoutMs as number) || undefined,
      triageModel: (raw.triageModel as string) || undefined,
      dodiOpsMode: (raw.dodiOpsMode as "full" | "readonly") || undefined,
      disabled: (raw.disabled as boolean) || false,
      subscribe: (raw.subscribe as string[]) || [],
      delegatePrompts: (raw.delegatePrompts as Record<string, string>) || undefined,
      soul,
      systemPrompt,
    };

    // Save pre-override snapshot for comparison
    this.templateConfigs.set(config.id, { ...config });

    // Apply prompt overrides (soul and/or systemPrompt from MongoDB)
    const promptOverride = this.promptOverrides.get(agentId);
    if (promptOverride) {
      if (promptOverride.soul !== undefined) config.soul = promptOverride.soul;
      if (promptOverride.systemPrompt !== undefined) config.systemPrompt = promptOverride.systemPrompt;
      log.info("Prompt override applied", {
        agent: agentId,
        fields: [
          ...(promptOverride.soul !== undefined ? ["soul"] : []),
          ...(promptOverride.systemPrompt !== undefined ? ["systemPrompt"] : []),
        ],
      });
    }

    return this.applyOverrides(config);
  }

  private applyOverrides(config: AgentConfig): AgentConfig {
    const override = this.configOverrides.get(config.id);
    const template = this.templateConfigs.get(config.id);
    const result = applyConfigOverrides(config, override, template);
    if (override) {
      log.info("Config override applied", { agent: config.id });
    }
    return result;
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
    return this.getAll().find((a) => !a.disabled && a.channels.includes(channelName));
  }

  /** Check if any agent has this channel as passive (listen but don't auto-route) */
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

  /** Return ALL agents whose names are mentioned in the text */
  findAllByName(text: string): AgentConfig[] {
    return this.getAll().filter((a) => {
      if (a.disabled) return false;
      const name = a.name.toLowerCase();
      // Match "hey River", "River,", "@River", or just "River" at word boundaries
      const pattern = new RegExp(`(?:^|hey\\s+|@)${name}\\b|\\b${name}[,:]`, "i");
      return pattern.test(text);
    });
  }

  getDefault(): AgentConfig | undefined {
    return this.getAll().find((a) => !a.disabled && a.isDefault);
  }

  /** Get all disabled agents (for admin reporting) */
  getDisabled(): AgentConfig[] {
    return this.getAll().filter((a) => a.disabled);
  }

  /** Build domain → subscriber agent IDs map from all agents' subscribe arrays */
  getSubscriberMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const agent of this.getAll()) {
      if (agent.disabled) continue;
      for (const sub of agent.subscribe ?? []) {
        // Support both domain-level ("deals") and action-level ("deals:won") subscriptions
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
