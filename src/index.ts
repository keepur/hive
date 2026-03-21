import { existsSync, watch } from "node:fs";
import { resolve } from "node:path";
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
import { TaskClient } from "./tasks/task-client.js";
import { TaskLedger } from "./tasks/task-ledger.js";
import { BackgroundTaskManager } from "./background/background-task-manager.js";
import { CodeTaskManager } from "./code-task/code-task-manager.js";
import { MeetingMonitor } from "./recall/meeting-monitor.js";
import { RetryQueue } from "./sweeper/retry-queue.js";
import { Sweeper } from "./sweeper/sweeper.js";
import { setGeminiApiKey } from "./files/file-processor.js";
const log = createLogger("index");

async function main(): Promise<void> {
  log.info("Hive starting up");

  // Initialize Gemini vision for image processing
  if (config.gemini.apiKey) {
    setGeminiApiKey(config.gemini.apiKey);
    log.info("Gemini vision enabled", { model: config.gemini.visionModel });
  }

  // Load agent definitions
  const registry = new AgentRegistry(config.agents.definitionsPath);
  await registry.connectDb(config.mongo.uri, config.mongo.dbName);
  await registry.load();
  log.info("Agent registry loaded", { agents: registry.listIds() });

  // Initialize core systems
  const memoryManager = new MemoryManager(config.mongo.uri, config.mongo.dbName);
  await memoryManager.init();

  const sessionStore = new SessionStore(config.mongo.uri);
  await sessionStore.connect(config.mongo.dbName);

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

  const agentManager = new AgentManager(registry, memoryManager, sessionStore);
  const healthReporter = new HealthReporter(agentManager, memoryManager, registry);
  const dispatcher = new Dispatcher(
    registry,
    agentManager,
    healthReporter,
    config.agents.defaultAgent,
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
    config.codeTask.pluginDir,
    config.codeTask.maxConcurrent,
    config.tasksDir.code,
    (item) =>
      dispatcher.dispatch(item).catch((err) => {
        log.error("Code task completion dispatch failed", { error: String(err) });
      }),
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

  // --- Hot reload ---
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  const reload = async () => {
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

  // Watch agents/ directory for changes — debounced to 500ms
  const agentsDir = resolve(config.agents.definitionsPath);
  watch(agentsDir, { recursive: true }, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload(), 500);
  });

  // Watch skills/ directory for changes — debounced to 500ms
  const skillsDir = resolve("skills");
  if (existsSync(skillsDir)) {
    watch(skillsDir, { recursive: true }, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => reload(), 500);
    });
    log.info("Skills hot-reload enabled", { watched: skillsDir });
  }

  // SIGUSR1: manual hot-reload trigger
  process.on("SIGUSR1", () => reload());
  log.info("Hot-reload enabled", { watched: agentsDir, signal: "SIGUSR1" });

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

  // Set Slack audit channel for app/SMS notifications
  const auditChannelName = config.slack.auditChannel;
  if (auditChannelName) {
    try {
      const channels = await slack.client.conversations.list({ types: "public_channel", limit: 200 });
      const auditCh = (channels.channels ?? []).find((c: any) => c.name === auditChannelName);
      if (auditCh?.id) {
        dispatcher.setAuditChannel(slackAdapter, auditCh.id);
        log.info("Audit channel configured", { channel: auditChannelName, id: auditCh.id });
      }
    } catch (err) {
      log.warn("Failed to configure audit channel", { error: String(err) });
    }
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

  // WebSocket adapter — mobile app channel
  let wsAdapter: import("./channels/ws/ws-adapter.js").WsAdapter | undefined;
  if (config.ws.enabled && config.ws.jwtSecret) {
    const { DeviceRegistry } = await import("./channels/ws/device-registry.js");
    const { WsAdapter } = await import("./channels/ws/ws-adapter.js");

    const deviceRegistry = new DeviceRegistry(config.mongo.uri, config.mongo.dbName, config.ws.jwtSecret);
    await deviceRegistry.connect();

    wsAdapter = new WsAdapter(config.ws.port, deviceRegistry, config.ws.jwtSecret);
    dispatcher.registerAdapter(wsAdapter);
    await wsAdapter.start((item) => {
      dispatcher.dispatch(item).catch((err) => {
        log.error("WS dispatch failed", { error: String(err), source: item.source.label });
      });
    });
    log.info("WebSocket adapter started", { port: config.ws.port });
  }

  // Start scheduler (with callback support via MongoDB)
  const scheduler = new Scheduler(agentManager, memoryManager, healthReporter, registry, (item) => {
    dispatcher.dispatch(item).catch((err) => {
      log.error("Callback dispatch failed", { error: String(err) });
    });
  });
  await scheduler.connectDb(config.mongo.uri, config.mongo.dbName);
  scheduler.start();
  log.info("Scheduler started");

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
    },
    taskClient.isConfigured ? taskClient : undefined,
  );
  sweeper.start();
  log.info("Sweeper started", { intervalMs: config.sweeper.intervalMs });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutdown signal received", { signal });
    sweeper.stop();
    await smsAdapter.stop();
    if (wsAdapter) await wsAdapter.stop();
    scheduler.stop();
    bgTaskManager.stop();
    codeTaskManager.stop();
    meetingMonitor?.stop();
    agentManager.stopAll();
    await sessionStore.close();
    await slackAdapter.stop();
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
