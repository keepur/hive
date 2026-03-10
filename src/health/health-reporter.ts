import { createLogger } from "../logging/logger.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { MemoryManager } from "../memory/memory-manager.js";

const log = createLogger("health-reporter");

export interface HealthReport {
  lastUpdated: string;
  agents: Record<
    string,
    {
      status: string;
      lastActivity: string;
      messagesProcessed: number;
      errorCount: number;
      sessionId?: string;
      activeThreads: number;
    }
  >;
}

export class HealthReporter {
  private agentManager: AgentManager;
  private memoryManager: MemoryManager;

  constructor(agentManager: AgentManager, memoryManager: MemoryManager) {
    this.agentManager = agentManager;
    this.memoryManager = memoryManager;
  }

  generateReport(): HealthReport {
    const agents: HealthReport["agents"] = {};

    for (const state of this.agentManager.getAllStates()) {
      agents[state.id] = {
        status: state.status,
        lastActivity: state.lastActivity.toISOString(),
        messagesProcessed: state.messagesProcessed,
        errorCount: state.errorCount,
        sessionId: state.currentSessionId,
        activeThreads: state.activeThreadCount ?? 0,
      };
    }

    return {
      lastUpdated: new Date().toISOString(),
      agents,
    };
  }

  formatForSlack(): string {
    const report = this.generateReport();
    const agentIds = Object.keys(report.agents);

    if (agentIds.length === 0) {
      return "No agents are currently registered.";
    }

    const lines = [`*Hive Status* — ${new Date().toLocaleString()}\n`];

    for (const [id, info] of Object.entries(report.agents)) {
      const statusEmoji =
        info.status === "idle"
          ? ":white_circle:"
          : info.status === "processing"
            ? ":large_blue_circle:"
            : info.status === "error"
              ? ":red_circle:"
              : ":black_circle:";

      const threadInfo = info.activeThreads > 0 ? ` (${info.activeThreads} threads)` : "";
      lines.push(`${statusEmoji} *${id}*${threadInfo}`);
      lines.push(`  Messages: ${info.messagesProcessed} | Errors: ${info.errorCount}`);
      lines.push(`  Last active: ${new Date(info.lastActivity).toLocaleString()}`);
    }

    return lines.join("\n");
  }

  async writeToMemory(): Promise<void> {
    const report = this.generateReport();
    await this.memoryManager.write("status/health.json", JSON.stringify(report, null, 2));
    await this.memoryManager.commitAndPush("heartbeat: update agent status");
    log.info("Health report written to memory");
  }
}
