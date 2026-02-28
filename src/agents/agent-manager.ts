import { createLogger } from "../logging/logger.js";
import type { AgentConfig, AgentState, AgentStatus, IncomingMessage } from "../types/agent-config.js";
import { AgentRunner, type RunResult } from "./agent-runner.js";
import { AgentRegistry } from "./agent-registry.js";

const log = createLogger("agent-manager");

interface QueuedMessage {
  message: IncomingMessage;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

export class AgentManager {
  private runners = new Map<string, AgentRunner>();
  private states = new Map<string, AgentState>();
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private registry: AgentRegistry;

  constructor(registry: AgentRegistry) {
    this.registry = registry;
  }

  private getOrCreateRunner(agentId: string): AgentRunner {
    let runner = this.runners.get(agentId);
    if (!runner) {
      const config = this.registry.get(agentId);
      if (!config) throw new Error(`Unknown agent: ${agentId}`);
      runner = new AgentRunner(config);
      this.runners.set(agentId, runner);
      this.states.set(agentId, {
        id: agentId,
        status: "idle",
        lastActivity: new Date(),
        messagesProcessed: 0,
        errorCount: 0,
      });
    }
    return runner;
  }

  async sendMessage(agentId: string, message: IncomingMessage): Promise<RunResult> {
    this.getOrCreateRunner(agentId);

    return new Promise<RunResult>((resolve, reject) => {
      const queue = this.queues.get(agentId) ?? [];
      queue.push({ message, resolve, reject });
      this.queues.set(agentId, queue);
      this.processQueue(agentId);
    });
  }

  private async processQueue(agentId: string): Promise<void> {
    if (this.processing.has(agentId)) return;

    const queue = this.queues.get(agentId);
    if (!queue || queue.length === 0) return;

    this.processing.add(agentId);
    this.updateStatus(agentId, "processing");

    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const runner = this.getOrCreateRunner(agentId);
        const result = await runner.send(item.message.text);

        const state = this.states.get(agentId)!;
        state.messagesProcessed++;
        state.lastActivity = new Date();
        state.currentSessionId = result.sessionId;

        if (result.error) {
          state.errorCount++;
          this.updateStatus(agentId, "error");
        }

        item.resolve(result);
      } catch (err) {
        const state = this.states.get(agentId);
        if (state) {
          state.errorCount++;
          state.lastActivity = new Date();
        }
        this.updateStatus(agentId, "error");
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.processing.delete(agentId);
    this.updateStatus(agentId, "idle");
  }

  private updateStatus(agentId: string, status: AgentStatus): void {
    const state = this.states.get(agentId);
    if (state) {
      state.status = status;
      log.debug("Agent status changed", { agentId, status });
    }
  }

  getState(agentId: string): AgentState | undefined {
    return this.states.get(agentId);
  }

  getAllStates(): AgentState[] {
    return Array.from(this.states.values());
  }

  stopAgent(agentId: string): void {
    const runner = this.runners.get(agentId);
    if (runner) {
      runner.abort();
      this.updateStatus(agentId, "stopped");
    }
  }

  stopAll(): void {
    for (const [id] of this.runners) {
      this.stopAgent(id);
    }
    log.info("All agents stopped");
  }

  restartAgent(agentId: string): void {
    this.stopAgent(agentId);
    const runner = this.runners.get(agentId);
    if (runner) {
      runner.resetSession();
      this.updateStatus(agentId, "idle");
      log.info("Agent restarted", { agentId });
    }
  }
}
