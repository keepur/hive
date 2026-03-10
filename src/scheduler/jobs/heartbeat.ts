import type { HealthReporter } from "../../health/health-reporter.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("heartbeat");

export async function runHeartbeat(healthReporter: HealthReporter, memoryManager: MemoryManager): Promise<void> {
  try {
    await memoryManager.pull();
    await healthReporter.writeToMemory();
    log.info("Heartbeat complete");
  } catch (err) {
    log.error("Heartbeat failed", { error: String(err) });
  }
}
