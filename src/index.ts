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

  const linearClient = new LinearClient();
  linearClient.init();

  const agentManager = new AgentManager(registry);
  const healthReporter = new HealthReporter(agentManager, memoryManager);
  const messageRouter = new MessageRouter(registry, agentManager, config.agents.defaultAgent);

  // Start Slack gateway
  const slack = new SlackGateway(config.slack.appToken, config.slack.botToken);

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

  // Start scheduler
  const scheduler = new Scheduler(agentManager, memoryManager, healthReporter, registry);
  scheduler.start();
  log.info("Scheduler started");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutdown signal received", { signal });
    scheduler.stop();
    agentManager.stopAll();
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
