import { createLogger } from "../logging/logger.js";
import type { AgentConfig, AgentState, AgentStatus, IncomingMessage } from "../types/agent-config.js";
import { AgentRunner, type RunResult, type StreamCallback } from "./agent-runner.js";
import { AgentRegistry } from "./agent-registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SessionStore } from "./session-store.js";

const log = createLogger("agent-manager");

interface QueuedMessage {
  message: IncomingMessage;
  onStream?: StreamCallback;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

export class AgentManager {
  private runners = new Map<string, AgentRunner>();
  private states = new Map<string, AgentState>();
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private registry: AgentRegistry;
  private memoryManager: MemoryManager;
  private sessionStore: SessionStore;

  constructor(registry: AgentRegistry, memoryManager: MemoryManager, sessionStore: SessionStore) {
    this.registry = registry;
    this.memoryManager = memoryManager;
    this.sessionStore = sessionStore;
  }

  private getOrCreateRunner(agentId: string): AgentRunner {
    let runner = this.runners.get(agentId);
    if (!runner) {
      const config = this.registry.get(agentId);
      if (!config) throw new Error(`Unknown agent: ${agentId}`);
      runner = new AgentRunner(config, this.memoryManager);
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

  async sendMessage(agentId: string, message: IncomingMessage, onStream?: StreamCallback): Promise<RunResult> {
    this.getOrCreateRunner(agentId);

    return new Promise<RunResult>((resolve, reject) => {
      const queue = this.queues.get(agentId) ?? [];
      queue.push({ message, onStream, resolve, reject });
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

        // Look up session for this thread
        const threadKey = item.message.threadTs ?? item.message.ts;
        const existingSession = await this.sessionStore.get(agentId, threadKey);

        const result = await runner.send(item.message.text, existingSession, item.onStream);

        // Persist session ID for this thread
        if (result.sessionId) {
          this.sessionStore.set(agentId, threadKey, result.sessionId);
        }

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
      this.runners.delete(agentId);
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
    this.sessionStore.clearAgent(agentId);
    this.states.set(agentId, {
      id: agentId,
      status: "idle",
      lastActivity: new Date(),
      messagesProcessed: 0,
      errorCount: 0,
    });
    log.info("Agent restarted", { agentId });
  }
}
