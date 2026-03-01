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

  const linearClient = new LinearClient();
  linearClient.init();

  const agentManager = new AgentManager(registry, memoryManager, sessionStore);
  const healthReporter = new HealthReporter(agentManager, memoryManager);
  const dispatcher = new Dispatcher(registry, agentManager, healthReporter, config.agents.defaultAgent);

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

  // Start Slack adapter (wraps SlackGateway)
  const slack = new SlackGateway(config.slack.appToken, config.slack.botToken);
  const slackAdapter = new SlackAdapter(slack, registry);
  dispatcher.registerAdapter(slackAdapter);
  await slackAdapter.start((item) => dispatcher.dispatch(item));
  log.info("Slack adapter connected");

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
    await smsAdapter.start((item) => dispatcher.dispatch(item));
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

main().catch((err) => {
  log.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
