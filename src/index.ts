import { existsSync, mkdirSync, watch } from "node:fs";
import { resolve } from "node:path";
import {
  skillsDir,
  hiveHome,
  hiveStateDir,
  engineDir,
  agentsDir,
  agentScratchDir,
  agentReportsDir,
  agentFeedsDir,
} from "./paths.js";
import { MongoClient } from "mongodb";
import { initInstanceGit } from "./skills/instance-git.js";
import { verifyPackageIntegrity, checkAllowlistDrift } from "./skills/integrity.js";
import { checkUpgradeNotice } from "./skills/upgrade-notice.js";
import { config } from "./config.js";
import { createLogger } from "./logging/logger.js";
import { AgentRegistry } from "./agents/agent-registry.js";
import { AgentManager } from "./agents/agent-manager.js";
import { PrefixCache } from "./agents/prefix-cache.js";
import { invalidatePrefixCacheByMemoryPath } from "./agents/prefix-invalidation.js";
import { SpawnCoordinatorHeartbeat } from "./agents/spawn-coordinator-heartbeat.js";
import { TeamCache } from "./team-roster/team-cache.js";
import { TeamRoster } from "./team-roster/team-roster.js";
import { ContactsWatcher } from "./team-roster/contacts-watcher.js";
import { SlackGateway } from "./slack/slack-gateway.js";
import { MemoryManager } from "./memory/memory-manager.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { HealthReporter } from "./health/health-reporter.js";
import { LinearClient } from "./linear/linear-client.js";
import { SessionStore } from "./agents/session-store.js";
import { TurnTelemetryStore } from "./agents/turn-telemetry.js";
import { Dispatcher } from "./channels/dispatcher.js";
import { SlackAdapter } from "./channels/slack-adapter.js";
import { SmsAdapter } from "./channels/sms-adapter.js";
import { IMessageAdapter } from "./channels/imessage-adapter.js";
import { TaskClient } from "./tasks/task-client.js";
import { TaskLedger } from "./tasks/task-ledger.js";
import { BackgroundTaskManager } from "./background/background-task-manager.js";
import { CodeTaskManager } from "./code-task/code-task-manager.js";
import { MeetingMonitor } from "./recall/meeting-monitor.js";
import { RetryQueue } from "./sweeper/retry-queue.js";
import { Sweeper } from "./sweeper/sweeper.js";
import { RetentionSweeper } from "./retention/retention-sweeper.js";
import { setGeminiApiKey } from "./files/file-processor.js";
import { MemoryStore } from "./memory/memory-store.js";
import { MemoryEmbedder } from "./memory/memory-embedder.js";
import { MemoryLifecycle } from "./memory/memory-lifecycle.js";
import { MemoryLifecycleHeartbeat } from "./memory/memory-lifecycle-heartbeat.js";
import { AdminApi } from "./admin/admin-api.js";
import { ActivityLogger } from "./activity/activity-logger.js";
import { runMigrations } from "./migrations/run-migrations.js";
import { checkFirstBoot } from "./startup/first-boot.js";
import { SlackInternalApi } from "./slack/slack-internal-api.js";
import { preflightBotScopes } from "./slack/slack-scope-preflight.js";
import { installKeepAliveDispatcher } from "./http/loopback-dispatcher.js";
const log = createLogger("index");

function provisionAgentDirs(agentIds: string[]): void {
  for (const agentId of agentIds) {
    for (const dir of [agentScratchDir(agentId), agentReportsDir(agentId), agentFeedsDir(agentId)]) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        log.warn("Failed to provision agent dir", { agentId, dir, err });
      }
    }
  }
}

async function main(): Promise<void> {
  // KPR-252: pool all outbound HTTP (loopback control plane + external) behind a
  // single keep-alive dispatcher before any fetch() runs, so the registration
  // loop and task-ledger clients reuse connections instead of exhausting the
  // IPv4 ephemeral port range. Must run before startBeekeeperRegistration().
  installKeepAliveDispatcher();
  log.info("Hive starting up", { instance: config.instance.id, portBase: config.instance.portBase });

  // Boot-time integrity + upgrade checks
  // Refuse to boot if both 0.1.x and 0.2.0 engine layouts exist side-by-side
  // (catches botched manual upgrades where someone extracted a 0.2.0 tarball
  // over a 0.1.x instance without removing the old dist/).
  if (existsSync(resolve(hiveHome, "dist", "index.js")) && existsSync(resolve(engineDir, "dist", "index.js"))) {
    log.error(
      "Conflicting engine layouts detected — both <hiveHome>/dist/ and <hiveHome>/.hive/dist/ exist. " +
        "Remove the old <hiveHome>/dist/ before starting 0.2.0.",
      { hiveHome, engineDir },
    );
    process.exit(1);
  }

  verifyPackageIntegrity(hiveHome, hiveStateDir);
  checkAllowlistDrift(hiveHome);
  initInstanceGit(hiveHome);
  checkUpgradeNotice(hiveStateDir, skillsDir);

  // Initialize Gemini vision for image processing
  if (config.gemini.apiKey) {
    setGeminiApiKey(config.gemini.apiKey);
    log.info("Gemini vision enabled", { model: config.gemini.visionModel });
  }

  // Shared MongoDB client — KPR-121: single pool for the whole hive process.
  // All in-process Mongo consumers (MemoryManager, MemoryStore, SessionStore,
  // Scheduler, TeamStore, IMessageAdapter, CodeIndexPrefetcher, etc.) receive
  // `db` from this client instead of opening their own.
  const mongoClient = new MongoClient(config.mongo.uri, {
    heartbeatFrequencyMS: 30_000,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
    maxIdleTimeMS: 300_000,
    retryWrites: true,
    retryReads: true,
  });
  await mongoClient.connect();
  const db = mongoClient.db(config.mongo.dbName);

  // Agent definitions collection
  const agentDefsCollection = db.collection("agent_definitions");
  await agentDefsCollection.createIndex({ channels: 1 });
  await agentDefsCollection.createIndex({ disabled: 1 });

  // Run DB migrations (fatal on failure — downstream code depends on migrated shape)
  await runMigrations(db);

  // Forward-declare variables used in reload closure (assigned after reload() definition)
  // eslint-disable-next-line prefer-const
  let registry: AgentRegistry;
  // eslint-disable-next-line prefer-const
  let agentManager: AgentManager;
  // eslint-disable-next-line prefer-const
  let scheduler: Scheduler;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackAuditId: string | undefined;

  const reload = async () => {
    // Guard: reload may fire via change stream before agentManager/scheduler are assigned
    if (!agentManager || !scheduler) return;

    log.info("Hot-reloading agent registry...");
    const result = await registry.load();

    if (result.added.length) log.info("New agents online", { agents: result.added });
    if (result.updated.length) log.info("Agents updated", { agents: result.updated });
    provisionAgentDirs(registry.listIds());
    if (result.removed.length) {
      log.info("Agents removed", { agents: result.removed });
      for (const id of result.removed) {
        agentManager.stopAgent(id);
      }
    }

    // Stop disabled agents (abort active runners)
    const disabled = registry.getDisabled();
    for (const agent of disabled) {
      agentManager.stopAgent(agent.id);
    }
    if (disabled.length) {
      log.info("Disabled agents stopped", { agents: disabled.map((a) => a.id) });
    }

    // Reload schedule overrides
    await scheduler.reloadSchedules();
    agentManager.reloadSkills();
    agentManager.rescanPlugins();
  };

  registry = new AgentRegistry(agentDefsCollection as any, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload(), 500);
  });
  await registry.load();
  log.info("Agent registry loaded", { agents: registry.listIds() });
  provisionAgentDirs(registry.listIds());

  // KPR-139: engine-native team API. Single in-process cache shared between
  // engine code (system-prompt assembly) and the agent-facing team-roster MCP
  // server. Agents-slice invalidates via AgentRegistry.onPostReload; humans-
  // slice invalidates via ContactsWatcher.
  const teamCache = new TeamCache(db);
  const teamRoster = new TeamRoster(teamCache);
  // KPR-213: write-through prefix cache. Singleton owned at the top level
  // so every wiring point that mutates a prefix-affecting input can call
  // invalidateAgent / invalidateAll synchronously. AgentRunner reads through
  // it via AgentManager.
  const prefixCache = new PrefixCache();
  registry.onPostReload(() => {
    teamCache.invalidateAgents();
    // Agent-def updates are global from the prefix's perspective: the team
    // summary may have changed (subsumes per-agent invalidation since the
    // team summary appears in every agent's prefix), and the agent's own
    // soul/systemPrompt/coreServers may have changed. invalidateAll is the
    // simpler, correct choice.
    prefixCache.invalidateAll("agent-def-update");
  });
  const contactsWatcher = new ContactsWatcher(db, teamCache, () => prefixCache.invalidateAll("team-roster-humans"));
  await contactsWatcher.start();

  // Initialize core systems
  const memoryManager = new MemoryManager(db);
  await memoryManager.init();
  // KPR-213: FS-style memory writes (constitution, agent memory.md) flow
  // through MemoryManager.write — wire prompt-prefix invalidation here.
  // Path-aware: shared/* invalidates all; agents/<id>/* invalidates that agent;
  // status/* is operational telemetry and does not affect prompts.
  memoryManager.setOnWrite((path, reason) => {
    invalidatePrefixCacheByMemoryPath(prefixCache, path, reason);
  });

  // Structured memory lifecycle — always enabled
  // KPR-241: embedder constructed before store so it can be injected as the
  // MemoryVectorIndex implementation for tier-sync on setTier/setTierBulk.
  const memoryEmbedder = new MemoryEmbedder();
  const memoryStore = new MemoryStore(db, memoryEmbedder);
  await memoryStore.init();
  memoryManager.memoryStore = memoryStore;
  // KPR-213: structured-memory mutations from autoDream lifecycle and the
  // knowledge-extractor go through this shared store instance (separate
  // from the per-MCP stores — those wire onMutate themselves). Bulk-id
  // paths pass `null` → invalidateAll.
  memoryStore.setOnMutate((agentId, reason) => {
    if (agentId === null) prefixCache.invalidateAll(reason);
    else prefixCache.invalidateAgent(agentId, reason);
  });
  const memoryLifecycle = new MemoryLifecycle(
    memoryStore,
    memoryEmbedder,
    {
      hotBudgetTokens: config.memory.hotBudgetTokens,
      sweepIntervalHours: config.memory.sweepIntervalHours,
      hotThreshold: config.memory.hotThreshold,
      warmThreshold: config.memory.warmThreshold,
      recencyHalfLifeDays: config.memory.recencyHalfLifeDays,
      coldSummaryMinRecords: config.memory.coldSummaryMinRecords,
      coldRetentionDays: config.memory.coldRetentionDays,
      purgeRetentionDays: config.memory.purgeRetentionDays,
    },
    config.autoDream,
    async () => new Set(registry!.listIds()),
  );
  log.info("Structured memory lifecycle enabled");

  const sessionStore = new SessionStore(db);
  await sessionStore.init();

  const turnTelemetryStore = new TurnTelemetryStore(db);
  await turnTelemetryStore.init();

  // Activity logger — queryable audit trail for agent turns
  let activityLogger: ActivityLogger | undefined;
  if (config.activity.enabled) {
    activityLogger = new ActivityLogger(db, config.activity);
    await activityLogger.connect();
  }

  if (config.linear.apiKey) {
    const linearClient = new LinearClient(config.linear.apiKey, config.linear.teamId || undefined);
    log.info("Linear client configured");
  }

  const taskClient = new TaskClient(config.taskLedger.apiUrl, config.taskLedger.apiKey);
  if (taskClient.isConfigured) {
    log.info("Task ledger client configured", { apiUrl: config.taskLedger.apiUrl });
  }

  const taskLedger = new TaskLedger(config.taskLedger.apiUrl, config.taskLedger.agentKeys, config.taskLedger.apiKey);
  if (taskLedger.isConfigured) {
    log.info("Task ledger auto-tracking enabled", {
      apiUrl: config.taskLedger.apiUrl,
      agents: Object.keys(config.taskLedger.agentKeys),
    });
  }

  // Code index prefetcher + knowledge extractor (optional — only when codeIndex enabled)
  let prefetcher: import("./code-index/prefetcher.js").CodeIndexPrefetcher | undefined;
  let knowledgeExtractor: import("./code-task/knowledge-extractor.js").KnowledgeExtractor | undefined;

  if (config.codeIndex.enabled) {
    const { CodeIndexPrefetcher } = await import("./code-index/prefetcher.js");
    const { KnowledgeExtractor } = await import("./code-task/knowledge-extractor.js");

    prefetcher = new CodeIndexPrefetcher({
      db,
      qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
      ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
      scoreThreshold: config.codeIndex.scoreThreshold,
      prefetchLimit: config.codeIndex.prefetchLimit,
    });

    if (config.codeIndex.sessionKnowledge.enabled) {
      knowledgeExtractor = new KnowledgeExtractor(memoryStore, memoryEmbedder);
    }

    log.info("Code index integration enabled", {
      prefetch: true,
      sessionKnowledge: knowledgeExtractor !== undefined,
    });
  }

  agentManager = new AgentManager(
    registry,
    memoryManager,
    sessionStore,
    db,
    turnTelemetryStore,
    activityLogger,
    prefetcher,
    teamRoster,
    prefixCache,
    undefined,
    memoryLifecycle,
  );
  const healthReporter = new HealthReporter(agentManager, memoryManager, registry);
  const dispatcher = new Dispatcher(
    registry,
    agentManager,
    healthReporter,
    config.defaultAgent,
    taskLedger.isConfigured ? taskLedger : undefined,
  );

  // Background task manager — agents can spawn detached background processes
  const bgTaskManager = new BackgroundTaskManager(
    config.background.port,
    config.background.authToken,
    config.tasksDir.background,
    (item) =>
      dispatcher.dispatch(item).catch((err) => {
        log.error("Background task completion dispatch failed", { error: String(err) });
      }),
  );
  await bgTaskManager.start();
  await bgTaskManager.scanOrphans();
  log.info("Background task manager started", { port: config.background.port });

  // Code task manager — agents can spawn Claude Code CLI sessions
  const codeTaskManager = new CodeTaskManager(
    config.codeTask.port,
    config.codeTask.authToken,
    config.codeTask.pluginDirs,
    config.codeTask.maxConcurrent,
    config.tasksDir.code,
    (item) =>
      dispatcher.dispatch(item).catch((err) => {
        log.error("Code task completion dispatch failed", { error: String(err) });
      }),
    {
      prefetcher,
      knowledgeExtractor,
      maxLifetimeMs: config.codeTask.maxLifetimeMs,
      staleGraceMs: config.codeTask.staleGraceMs,
    },
  );
  await codeTaskManager.start();
  await codeTaskManager.scanOrphans();
  log.info("Code task manager started", { port: config.codeTask.port });

  // Meeting monitor — real-time meeting participation via Recall.ai
  let meetingMonitor: MeetingMonitor | undefined;
  if (config.recall.apiKey) {
    meetingMonitor = new MeetingMonitor(config.recall.monitorPort, config.recall.webhookSecret, (item) =>
      dispatcher.dispatch(item).catch((err) => {
        log.error("Meeting monitor dispatch failed", { error: String(err) });
      }),
    );
    await meetingMonitor.start();
    log.info("Meeting monitor started", { port: config.recall.monitorPort });
    if (config.recall.apiKey && !config.recall.webhookSecret) {
      log.error("Real-time transcript delivery disabled — RECALL_WEBHOOK_SECRET not set");
    }
  }

  // Watch skills/ directory for changes — debounced to 500ms
  if (existsSync(skillsDir)) {
    watch(skillsDir, { recursive: true }, () => {
      // KPR-213: skill registry changes don't currently affect the prefix
      // (skills are wired as SDK plugins, not into the prompt). Invalidate
      // anyway so the cache stays consistent with the runtime view in case
      // the toolkit section ever starts reflecting the skill index.
      prefixCache.invalidateAll("skill-change");
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reload(), 500);
    });
    log.info("Skills hot-reload enabled", { watched: skillsDir });
  }

  // KPR-75: watch agents/ for SKILL.md changes (per-agent private skills).
  // Filter by SKILL.md — agents write to scratch/, reports/, feeds/, playwright/
  // constantly during normal operation; rebuilding the skill index on every
  // scratch write would be a perf and log-noise nightmare. On platforms where
  // `filename` may be null (Linux, some macOS event variants), fall back to
  // debounced reload — the 500ms debounce coalesces the trigger.
  const agentsRoot = agentsDir();
  if (existsSync(agentsRoot)) {
    watch(agentsRoot, { recursive: true }, (_event, filename) => {
      const isSkillMd = typeof filename === "string" && filename.endsWith("SKILL.md");
      const filenameMissing = filename === null || filename === undefined;
      if (isSkillMd || filenameMissing) {
        // KPR-213: per-agent skills also feed the toolkit section in the
        // future; invalidate prefix cache for safety. Same call site as the
        // global skills watch above.
        prefixCache.invalidateAll("agent-skill-change");
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => reload(), 500);
      }
    });
    log.info("Agent-private skills hot-reload enabled", { watched: agentsRoot });
  }

  // SIGUSR1: manual hot-reload trigger. KPR-213: also flush the prefix cache.
  // Operators historically used SIGUSR1 to force-fresh prefixes; the cache
  // now invalidates automatically on every write path, so SIGUSR1 is no
  // longer load-bearing for prefix freshness — it stays as an explicit
  // escape hatch.
  process.on("SIGUSR1", () => {
    prefixCache.invalidateAll("sigusr1");
    reload();
  });
  log.info("Hot-reload enabled", { signal: "SIGUSR1" });

  // KPR-213: heartbeat prefix-cache stats to Mongo so the out-of-process
  // `hive doctor` CLI can render them. Doctor doesn't share memory with
  // the engine. 30s cadence — same as agent-registry / contacts watchers.
  const PREFIX_CACHE_HEARTBEAT_MS = 30_000;
  const telemetryCollection = db.collection("telemetry");
  const writeStats = async () => {
    try {
      const s = prefixCache.stats();
      await telemetryCollection.updateOne(
        { kind: "prefix_cache_stats" },
        { $set: { ...s, updatedAt: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      log.warn("prefix-cache stats heartbeat failed", { error: String(err) });
    }
  };
  // Initial write at startup so doctor sees zeros instead of "no telemetry".
  await writeStats();
  const prefixCacheHeartbeat = setInterval(writeStats, PREFIX_CACHE_HEARTBEAT_MS);
  prefixCacheHeartbeat.unref();

  // KPR-220 Phase 11: spawn-coordinator stats heartbeat. Cancels on service
  // shutdown only (spec S8) — NOT on `stopAll()` — so the doctor still sees
  // stopped agents in the snapshot.
  const spawnCoordinatorHeartbeat = new SpawnCoordinatorHeartbeat(agentManager, telemetryCollection);
  await spawnCoordinatorHeartbeat.writeOnce();
  spawnCoordinatorHeartbeat.start();

  // KPR-241: memory-lifecycle stats heartbeat. Same cadence + pattern as
  // SpawnCoordinatorHeartbeat. `telemetryCollection` is the existing local
  // ref; do not re-call db.collection("telemetry").
  const memoryLifecycleHeartbeat = new MemoryLifecycleHeartbeat(memoryStore, telemetryCollection, {
    getActiveAgentIds: async () => new Set(registry!.listIds()),
  });
  await memoryLifecycleHeartbeat.writeOnce();
  memoryLifecycleHeartbeat.start();

  // Start Slack adapter
  // Exclude SMS channels — those are handled directly by the SmsAdapter
  const smsChannels = config.sms.lines.map((l) => l.slackChannel).filter(Boolean);
  const slack = new SlackGateway(config.slack.appToken, config.slack.botToken);
  const slackAdapter = new SlackAdapter(slack, registry, smsChannels, "slack", config.defaultAgent);
  dispatcher.registerAdapter(slackAdapter);
  dispatcher.setSlackAdapter(slackAdapter);
  await slackAdapter.start((item) => {
    dispatcher.dispatch(item).catch((err) => {
      log.error("Slack dispatch failed", { error: String(err), source: item.source.label });
    });
  });
  log.info("Slack adapter connected");

  // Audit routing: every agent mirrors non-Slack conversations to their own
  // homeBase channel. The global slack.auditChannel (if set) is the fallback
  // for agents whose homeBase can't be resolved.
  const channelIdByName = new Map<string, string>();
  try {
    let cursor: string | undefined = undefined;
    do {
      const page = await slack.client.conversations.list({
        types: "public_channel,private_channel",
        limit: 1000,
        cursor,
      });
      for (const c of page.channels ?? []) {
        if (c.name && c.id) channelIdByName.set(c.name, c.id);
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    const fallbackName = config.slack.auditChannel;
    fallbackAuditId = fallbackName ? channelIdByName.get(fallbackName) : undefined;
    dispatcher.setAuditChannel(slackAdapter, channelIdByName, fallbackAuditId);
    log.info("Audit channel configured", {
      channels: channelIdByName.size,
      fallback: fallbackName || null,
      fallbackResolved: Boolean(fallbackAuditId),
    });
  } catch (err) {
    log.warn("Failed to configure audit channel", { error: String(err) });
  }

  // Slack internal API — local HTTP server for agent-side Slack MCP tools
  let slackInternalApi: SlackInternalApi | null = null;
  if (config.slack.localMcpServer) {
    await preflightBotScopes(config.slack.botToken);
    slackInternalApi = new SlackInternalApi({
      port: config.slackInternal.port,
      authToken: config.slackInternal.authToken,
      gateway: slack,
      agentManager,
    });
    await slackInternalApi.start();
    log.info("Slack internal API started", { port: config.slackInternal.port });
  }

  // SMS adapter — direct path, bypasses Slack. Per-turn-spawn routing is
  // handled inside the dispatcher (KPR-223); the adapter just emits WorkItems.
  const smsAdapter = new SmsAdapter(config.quo.apiKey, config.sms.lines);
  dispatcher.registerAdapter(smsAdapter);
  if (config.quo.apiKey && config.sms.lines.length > 0) {
    await smsAdapter.start((item) => {
      dispatcher.dispatch(item).catch((err) => {
        log.error("SMS dispatch failed", { error: String(err), source: item.source.label });
      });
    });
    log.info("SMS adapter started", { lines: config.sms.lines.length });
  }

  // iMessage adapter — poll chat.db for inbound, AppleScript for outbound
  let iMessageAdapter: IMessageAdapter | undefined;
  if (config.imessage.enabled) {
    iMessageAdapter = new IMessageAdapter(config.imessage, db, slack, config.instance.id);
    dispatcher.registerAdapter(iMessageAdapter);
    await iMessageAdapter.start((item) => {
      dispatcher.dispatch(item).catch((err) => {
        log.error("iMessage dispatch failed", { error: String(err) });
      });
    });
    log.info("iMessage adapter started");
  }

  // Set AgentRunner registry ref for Team MCP server
  const { AgentRunner } = await import("./agents/agent-runner.js");
  AgentRunner.registryRef = registry;

  // Team layer — channels, DMs, commands. Always on when mongo is available;
  // no feature gate (KPR-11).
  const { TeamStore } = await import("./team/team-store.js");
  const { CommandRegistry } = await import("./team/command-registry.js");

  const teamStore = new TeamStore(db);
  await teamStore.init();

  // Narrow resolver closure — keeps CommandRegistry decoupled from AgentRegistry.
  // Exact id wins; otherwise case-insensitive display name match.
  // NOTE: `registry.getAll()` is called inside the closure on every invocation
  // so hot-reloaded agents (SIGUSR1) become visible immediately. Don't hoist.
  const resolveAgent = (input: string): { id: string; name: string } | null => {
    const all = registry.getAll();
    const byId = all.find((a) => a.id === input);
    if (byId) return { id: byId.id, name: byId.name };
    const lower = input.toLowerCase();
    const byName = all.find((a) => a.name.toLowerCase() === lower);
    return byName ? { id: byName.id, name: byName.name } : null;
  };

  const commandRegistry = new CommandRegistry(teamStore, resolveAgent);
  dispatcher.setTeamStore(teamStore);

  log.info("Team layer initialized");

  const { registerPluginCommands } = await import("./plugins/plugin-loader.js");
  await registerPluginCommands(agentManager.getPlugins(), commandRegistry);

  // WebSocket adapter — loopback-only, proxied through @keepur/beekeeper.
  // Beekeeper terminates external auth and forwards frames via
  // ws://127.0.0.1:<port>/?internal=1&deviceId=...&name=...
  let wsAdapter: import("./channels/ws/ws-adapter.js").WsAdapter | undefined;
  if (config.ws.enabled) {
    const { WsAdapter } = await import("./channels/ws/ws-adapter.js");

    wsAdapter = new WsAdapter(config.ws.port, {
      teamStore,
      commandRegistry,
      agentRegistry: registry,
      agentManager,
      // Adapter-level fallback used by dispatcher meta routing (KPR-223 moved
      // per-turn-spawn gating into the dispatcher itself).
      defaultAgentId: config.defaultAgent,
    });
    dispatcher.registerAdapter(wsAdapter);
    await wsAdapter.start((item) => {
      dispatcher.dispatch(item).catch((err) => {
        log.error("WS dispatch failed", { error: String(err), source: item.source.label });
      });
    });
    log.info("WebSocket adapter started", { port: config.ws.port });
  }

  // Beekeeper federation — advertise this Hive instance to sibling Beekeeper
  // on loopback. Gated on ws.enabled since there's nothing to advertise
  // without a running WS adapter.
  let beekeeperRegistration: { stop: () => void } | undefined;
  if (config.ws.enabled) {
    const { startBeekeeperRegistration } = await import("./beekeeper-client.js");
    const capabilityName = `hive-${config.instance.id}`;
    beekeeperRegistration = startBeekeeperRegistration({
      beekeeperPort: config.beekeeper.port,
      wsPort: config.ws.port,
      capabilityName,
    });
    log.info("Beekeeper registration loop started", {
      beekeeperPort: config.beekeeper.port,
      wsPort: config.ws.port,
      capabilityName,
    });
  }

  // Voice adapter — Vapi phone integration (custom LLM endpoint)
  let voiceAdapter: import("./channels/voice/voice-adapter.js").VoiceAdapter | undefined;
  if (config.voice.enabled && config.voice.serverSecret) {
    const { VoiceAdapter } = await import("./channels/voice/voice-adapter.js");

    voiceAdapter = new VoiceAdapter(
      config.voice.port,
      config.voice.serverSecret,
      registry,
      memoryManager,
      agentManager, // KPR-219: needed for the per-turn flag-on path
      dispatcher, // KPR-223: routes voice turns through the dispatcher (taskLedger + audit; dedup skipped)
    );
    await voiceAdapter.start();
    log.info("Voice adapter started", { port: config.voice.port });
  }

  // Start scheduler (with callback support via MongoDB)
  scheduler = new Scheduler(agentManager, memoryManager, healthReporter, registry, (item) => {
    dispatcher.dispatch(item).catch((err) => {
      log.error("Callback dispatch failed", { error: String(err) });
    });
  });
  await scheduler.connectDb(db);
  scheduler.start();
  log.info("Scheduler started");

  // Start watching for agent definition changes
  await registry.startWatching();

  // Admin REST API
  let adminApi: AdminApi | undefined;
  if (config.adminApi.token) {
    adminApi = new AdminApi(
      config.adminApi.port,
      config.adminApi.token,
      agentDefsCollection as any,
      db.collection("agent_definition_versions") as any,
      () => reload(),
    );
    await adminApi.start();
    log.info("Admin API started", { port: config.adminApi.port });
  }

  // Periodic sweeper — state cleanup, message recovery, health metrics
  const retryQueue = new RetryQueue({
    maxAttempts: config.sweeper.retryMaxAttempts,
    baseDelayMs: config.sweeper.retryBaseDelayMs,
  });
  dispatcher.setRetryQueue(retryQueue);

  const slackAdapters = [slackAdapter];
  const slackGateways = [slack];

  const sweeper = new Sweeper(
    {
      intervalMs: config.sweeper.intervalMs,
      threadTtlMs: config.sweeper.threadTtlMs,
      taskFileTtlMs: config.sweeper.taskFileTtlMs,
      meetingSessionTtlMs: config.sweeper.meetingSessionTtlMs,
      cacheTtlMs: config.sweeper.cacheTtlMs,
      memorySweepIntervalHours: config.memory.sweepIntervalHours,
      dreamConfig: config.autoDream,
    },
    {
      dispatcher,
      slackAdapters,
      bgTaskManager,
      codeTaskManager,
      meetingMonitor,
      taskLedger: taskLedger.isConfigured ? taskLedger : undefined,
      slackGateways,
      agentManager,
      retryQueue,
      memoryLifecycle,
    },
    taskClient.isConfigured ? taskClient : undefined,
  );
  sweeper.start();
  log.info("Sweeper started", { intervalMs: config.sweeper.intervalMs });

  // Retention sweeper — deletes (or dry-runs) age-over files under agents/*, data/, logs/.
  // Ships in dry-run mode (enabled: false) until operator flips the flag after a week of
  // dry-run Slack reports prove the candidate list is sane. See KPR-51 design spec.
  const retentionSweeper = new RetentionSweeper(config.retention, {
    hiveHome,
    report: async (text) => {
      if (fallbackAuditId) {
        await slack
          .postMessage(fallbackAuditId, text)
          .catch((err) => log.warn("Retention report: Slack post failed", { error: String(err) }));
      } else {
        log.info("Retention report (no audit channel configured)", { text });
      }
    },
  });
  retentionSweeper.start();
  log.info("Retention sweeper started", {
    enabled: config.retention.enabled,
    intervalMs: config.retention.intervalMs,
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutdown signal received", { signal });
    sweeper.stop();
    retentionSweeper.stop();
    adminApi?.stop();
    registry.stopWatching();
    // contactsWatcher kept alive until after agentManager.stopAll() so any
    // in-flight buildSystemPrompt() that reaches teamSummary() doesn't race
    // a closed Mongo client. (Stopping the watcher just halts invalidation;
    // it doesn't tear down the cache.) See KPR-139.
    await smsAdapter.stop();
    if (slackInternalApi) await slackInternalApi.stop();
    if (iMessageAdapter) await iMessageAdapter.stop();
    beekeeperRegistration?.stop();
    if (wsAdapter) await wsAdapter.stop();
    voiceAdapter?.stop();
    scheduler.stop();
    await bgTaskManager.stop();
    await codeTaskManager.stop();
    await prefetcher?.close();
    meetingMonitor?.stop();
    spawnCoordinatorHeartbeat.stop();
    memoryLifecycleHeartbeat.stop();
    agentManager.stopAll(); // Note: doesn't await in-flight turns — some final records may not reach the buffer
    contactsWatcher.stop();
    if (activityLogger) await activityLogger.stop();
    await sessionStore.close();
    await memoryStore.close();
    await slackAdapter.stop();
    await mongoClient.close();
    log.info("Hive shut down cleanly");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  log.info("Hive is running");

  // First-boot: greet owner and offer onboarding if this is a fresh hive
  checkFirstBoot(memoryManager, registry, dispatcher, channelIdByName).catch((err) => {
    log.error("First-boot check failed", { error: String(err) });
  });
}

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", {
    error: String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

main().catch((err) => {
  log.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
