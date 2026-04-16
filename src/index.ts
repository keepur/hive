import { existsSync, watch } from "node:fs";
import { skillsDir, hiveHome, hiveMetaDir } from "./paths.js";
import { MongoClient } from "mongodb";
import { initInstanceGit } from "./skills/instance-git.js";
import { verifyPackageIntegrity, checkAllowlistDrift } from "./skills/integrity.js";
import { checkUpgradeNotice } from "./skills/upgrade-notice.js";
import { config } from "./config.js";
import { createLogger } from "./logging/logger.js";
import { AgentRegistry } from "./agents/agent-registry.js";
import { AgentManager } from "./agents/agent-manager.js";
import { SlackGateway } from "./slack/slack-gateway.js";
import { MemoryManager } from "./memory/memory-manager.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { HealthReporter } from "./health/health-reporter.js";
import { LinearClient } from "./linear/linear-client.js";
import { SessionStore } from "./agents/session-store.js";
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
import { setGeminiApiKey } from "./files/file-processor.js";
import { MemoryStore } from "./memory/memory-store.js";
import { MemoryEmbedder } from "./memory/memory-embedder.js";
import { MemoryLifecycle } from "./memory/memory-lifecycle.js";
import { AdminApi } from "./admin/admin-api.js";
import { ActivityLogger } from "./activity/activity-logger.js";
import { runMigrations } from "./migrations/run-migrations.js";
const log = createLogger("index");

async function main(): Promise<void> {
  log.info("Hive starting up", { instance: config.instance.id, portBase: config.instance.portBase });

  // Boot-time integrity + upgrade checks
  verifyPackageIntegrity(hiveHome, hiveMetaDir);
  checkAllowlistDrift(hiveHome);
  initInstanceGit(hiveHome);
  checkUpgradeNotice(hiveMetaDir, skillsDir);

  // Initialize Gemini vision for image processing
  if (config.gemini.apiKey) {
    setGeminiApiKey(config.gemini.apiKey);
    log.info("Gemini vision enabled", { model: config.gemini.visionModel });
  }

  // Shared MongoDB client
  const mongoClient = new MongoClient(config.mongo.uri);
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

  const reload = async () => {
    // Guard: reload may fire via change stream before agentManager/scheduler are assigned
    if (!agentManager || !scheduler) return;

    log.info("Hot-reloading agent registry...");
    const result = await registry.load();

    if (result.added.length) log.info("New agents online", { agents: result.added });
    if (result.updated.length) log.info("Agents updated", { agents: result.updated });
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
  };

  registry = new AgentRegistry(agentDefsCollection as any, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload(), 500);
  });
  await registry.load();
  log.info("Agent registry loaded", { agents: registry.listIds() });

  // Initialize core systems
  const memoryManager = new MemoryManager(config.mongo.uri, config.mongo.dbName);
  await memoryManager.init();

  // Structured memory lifecycle — always enabled
  const memoryStore = new MemoryStore(config.mongo.uri, config.mongo.dbName);
  await memoryStore.init();
  memoryManager.memoryStore = memoryStore;
  const memoryEmbedder = new MemoryEmbedder();
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
  );
  log.info("Structured memory lifecycle enabled");

  const sessionStore = new SessionStore(config.mongo.uri);
  await sessionStore.connect(config.mongo.dbName);

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
      mongoUri: config.mongo.uri,
      dbName: config.mongo.dbName,
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

  agentManager = new AgentManager(registry, memoryManager, sessionStore, activityLogger, prefetcher);
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
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reload(), 500);
    });
    log.info("Skills hot-reload enabled", { watched: skillsDir });
  }

  // SIGUSR1: manual hot-reload trigger
  process.on("SIGUSR1", () => reload());
  log.info("Hot-reload enabled", { signal: "SIGUSR1" });

  // Start Slack adapter
  // Exclude SMS channels — those are handled directly by the SmsAdapter
  const smsChannels = config.sms.lines.map((l) => l.slackChannel).filter(Boolean);
  const slack = new SlackGateway(config.slack.appToken, config.slack.botToken);
  const slackAdapter = new SlackAdapter(slack, registry, smsChannels, "slack");
  dispatcher.registerAdapter(slackAdapter);
  await slackAdapter.start((item) => {
    dispatcher.dispatch(item).catch((err) => {
      log.error("Slack dispatch failed", { error: String(err), source: item.source.label });
    });
  });
  log.info("Slack adapter connected");

  // Audit routing: every agent mirrors non-Slack conversations to their own
  // homeBase channel. The global slack.auditChannel (if set) is the fallback
  // for agents whose homeBase can't be resolved.
  try {
    const channelIdByName = new Map<string, string>();
    let cursor: string | undefined = undefined;
    do {
      const page = await slack.client.conversations.list({
        types: "public_channel",
        limit: 1000,
        cursor,
      });
      for (const c of page.channels ?? []) {
        if (c.name && c.id) channelIdByName.set(c.name, c.id);
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    const fallbackName = config.slack.auditChannel;
    const fallbackId = fallbackName ? channelIdByName.get(fallbackName) : undefined;
    dispatcher.setAuditChannel(slackAdapter, channelIdByName, fallbackId);
    log.info("Audit channel configured", {
      channels: channelIdByName.size,
      fallback: fallbackName || null,
      fallbackResolved: Boolean(fallbackId),
    });
  } catch (err) {
    log.warn("Failed to configure audit channel", { error: String(err) });
  }

  // SMS adapter — direct path, bypasses Slack
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
    iMessageAdapter = new IMessageAdapter(
      config.imessage,
      config.mongo.uri,
      config.mongo.dbName,
      slack,
      config.instance.id,
    );
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

  const teamStore = new TeamStore(config.mongo.uri, config.mongo.dbName);
  await teamStore.connect();

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
    beekeeperRegistration = startBeekeeperRegistration({
      beekeeperPort: config.beekeeper.port,
      wsPort: config.ws.port,
    });
    log.info("Beekeeper registration loop started", {
      beekeeperPort: config.beekeeper.port,
      wsPort: config.ws.port,
    });
  }

  // Voice adapter — Vapi phone integration (custom LLM endpoint)
  let voiceAdapter: import("./channels/voice/voice-adapter.js").VoiceAdapter | undefined;
  if (config.voice.enabled && config.voice.serverSecret) {
    const { VoiceAdapter } = await import("./channels/voice/voice-adapter.js");

    voiceAdapter = new VoiceAdapter(config.voice.port, config.voice.serverSecret, registry, memoryManager);
    await voiceAdapter.start();
    log.info("Voice adapter started", { port: config.voice.port });
  }

  // Start scheduler (with callback support via MongoDB)
  scheduler = new Scheduler(agentManager, memoryManager, healthReporter, registry, (item) => {
    dispatcher.dispatch(item).catch((err) => {
      log.error("Callback dispatch failed", { error: String(err) });
    });
  });
  await scheduler.connectDb(config.mongo.uri, config.mongo.dbName);
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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutdown signal received", { signal });
    sweeper.stop();
    adminApi?.stop();
    registry.stopWatching();
    await smsAdapter.stop();
    if (iMessageAdapter) await iMessageAdapter.stop();
    beekeeperRegistration?.stop();
    if (wsAdapter) await wsAdapter.stop();
    voiceAdapter?.stop();
    await teamStore.close();
    scheduler.stop();
    await bgTaskManager.stop();
    await codeTaskManager.stop();
    await prefetcher?.close();
    meetingMonitor?.stop();
    agentManager.stopAll(); // Note: doesn't await in-flight turns — some final records may not reach the buffer
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
