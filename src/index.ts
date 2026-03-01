import { watch } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config.js";
import { createLogger } from "./logging/logger.js";
import { AgentRegistry } from "./agents/agent-registry.js";
import { AgentManager } from "./agents/agent-manager.js";
import { SlackGateway } from "./slack/slack-gateway.js";
import { MessageRouter } from "./slack/message-router.js";
import { MemoryManager } from "./memory/memory-manager.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { HealthReporter } from "./health/health-reporter.js";
import { isStatusQuery, handleStatusQuery } from "./health/health-query.js";
import { LinearClient } from "./linear/linear-client.js";
import { SessionStore } from "./agents/session-store.js";
import { SmsPoller } from "./scheduler/jobs/sms-poller.js";

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
  const messageRouter = new MessageRouter(registry, agentManager, config.agents.defaultAgent);

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

  // Start Slack gateway
  const slack = new SlackGateway(config.slack.appToken, config.slack.botToken);

  // Allow bot messages (from integrations like Quo) in all agent-watched channels
  const allAgentChannels = registry.getAll().flatMap((a) => a.channels);
  slack.addIntegrationChannels(allAgentChannels);

  // Assistant thread events (AI Apps split view)
  slack.onThreadStarted((event) => messageRouter.handleThreadStarted(event, slack));
  slack.onThreadContextChanged((event) => messageRouter.handleContextChanged(event, slack));

  slack.onMessage(async (msg) => {
    // Intercept status queries before routing to agents
    if (isStatusQuery(msg)) {
      const statusText = handleStatusQuery(healthReporter);
      const threadTs = msg.threadTs ?? msg.ts;
      await slack.postMessage(msg.channel, statusText, threadTs);
      return;
    }

    messageRouter.route(msg, slack);
  });

  await slack.start();
  log.info("Slack gateway connected");

  // Start SMS poller — polls Quo API directly for incoming messages
  const smsPoller = new SmsPoller(config.quo.apiKey, messageRouter, slack);
  if (config.quo.apiKey && config.quo.phoneNumberId) {
    smsPoller.addLine(config.quo.phoneNumberId, "May (CEO)", "quo-may");
    await smsPoller.start(30_000);
  }

  // Start scheduler
  const scheduler = new Scheduler(agentManager, memoryManager, healthReporter, registry);
  scheduler.start();
  log.info("Scheduler started");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutdown signal received", { signal });
    smsPoller.stop();
    scheduler.stop();
    agentManager.stopAll();
    await sessionStore.close();
    await slack.stop();
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
