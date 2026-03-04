import { watch } from "node:fs";
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
import { MeetingMonitor } from "./recall/meeting-monitor.js";

const log = createLogger("index");

async function main(): Promise<void> {
  log.info("Hive starting up");

  // Load agent definitions
  const registry = new AgentRegistry(config.agents.definitionsPath);
  await registry.load();
  log.info("Agent registry loaded", { agents: registry.listIds() });

  // Initialize core systems
  const memoryManager = new MemoryManager(config.memory.localPath);
  await memoryManager.init();

  const sessionStore = new SessionStore(config.mongo.uri);
  await sessionStore.connect(config.mongo.dbName);

  if (config.linear.apiKey) {
    const linearClient = new LinearClient(
      config.linear.apiKey,
      config.linear.teamId || undefined,
    );
    log.info("Linear client configured");
  }

  const taskClient = new TaskClient(config.taskLedger.apiUrl, config.taskLedger.apiKey);
  if (taskClient.isConfigured) {
    log.info("Task ledger client configured", { apiUrl: config.taskLedger.apiUrl });
  }

  const taskLedger = new TaskLedger(
    config.taskLedger.apiUrl,
    config.taskLedger.agentKeys,
    config.taskLedger.apiKey,
  );
  if (taskLedger.isConfigured) {
    log.info("Task ledger auto-tracking enabled", {
      apiUrl: config.taskLedger.apiUrl,
      agents: Object.keys(config.taskLedger.agentKeys),
    });
  }

  const agentManager = new AgentManager(registry, memoryManager, sessionStore);
  const healthReporter = new HealthReporter(agentManager, memoryManager);
  const dispatcher = new Dispatcher(
    registry, agentManager, healthReporter, config.agents.defaultAgent,
    taskLedger.isConfigured ? taskLedger : undefined,
  );

  // Background task manager — agents can spawn detached background processes
  const bgTaskManager = new BackgroundTaskManager(
    config.background.port,
    (item) => dispatcher.dispatch(item).catch((err) => {
      log.error("Background task completion dispatch failed", { error: String(err) });
    }),
  );
  await bgTaskManager.start();
  await bgTaskManager.scanOrphans();
  log.info("Background task manager started", { port: config.background.port });

  // Meeting monitor — real-time meeting participation via Recall.ai
  let meetingMonitor: MeetingMonitor | undefined;
  if (config.recall.apiKey) {
    meetingMonitor = new MeetingMonitor(
      config.recall.monitorPort,
      (item) => dispatcher.dispatch(item).catch((err) => {
        log.error("Meeting monitor dispatch failed", { error: String(err) });
      }),
    );
    await meetingMonitor.start();
    log.info("Meeting monitor started", { port: config.recall.monitorPort });
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
  };

  // Watch agents/ directory for changes — debounced to 500ms
  const agentsDir = resolve(config.agents.definitionsPath);
  watch(agentsDir, { recursive: true }, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload(), 500);
  });

  // SIGUSR1: manual hot-reload trigger
  process.on("SIGUSR1", () => reload());
  log.info("Hot-reload enabled", { watched: agentsDir, signal: "SIGUSR1" });

  // Start primary Slack adapter (default agents)
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
  log.info("Slack adapter connected (primary)");

  // Start secondary Slack adapter (separate bot identity)
  let slackJasperAdapter: SlackAdapter | undefined;
  if (config.slackJasper.appToken && config.slackJasper.botToken) {
    const slackJasper = new SlackGateway(config.slackJasper.appToken, config.slackJasper.botToken);
    slackJasperAdapter = new SlackAdapter(slackJasper, registry, smsChannels, "slack:jasper", "vp-engineering");
    dispatcher.registerAdapter(slackJasperAdapter);
    await slackJasperAdapter.start((item) => {
      dispatcher.dispatch(item).catch((err) => {
        log.error("Slack (jasper) dispatch failed", { error: String(err), source: item.source.label });
      });
    });
    log.info("Slack adapter connected (secondary)");

    // Cross-register bot IDs so each gateway filters the other's messages
    slack.addPeerBotIds(slackJasper.resolvedBotUserId, slackJasper.resolvedBotId);
    slackJasper.addPeerBotIds(slack.resolvedBotUserId, slack.resolvedBotId);
    log.info("Cross-gateway bot ID filtering enabled");
  }

  // Set Slack as audit channel for cross-channel visibility
  try {
    const channels = await slack.client.conversations.list({ types: "public_channel", limit: 200 });
    const generalCh = (channels.channels ?? []).find((c: any) => c.name === "general");
    if (generalCh?.id) {
      dispatcher.setAuditChannel(slackAdapter, generalCh.id);
    }
  } catch {}

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

  // Start scheduler
  const scheduler = new Scheduler(agentManager, memoryManager, healthReporter, registry);
  scheduler.start();
  log.info("Scheduler started");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutdown signal received", { signal });
    await smsAdapter.stop();
    scheduler.stop();
    bgTaskManager.stop();
    meetingMonitor?.stop();
    agentManager.stopAll();
    await sessionStore.close();
    await slackAdapter.stop();
    if (slackJasperAdapter) await slackJasperAdapter.stop();
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
