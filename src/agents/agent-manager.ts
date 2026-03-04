import { createLogger } from "../logging/logger.js";
import type { AgentConfig, AgentState, AgentStatus } from "../types/agent-config.js";
import type { WorkItem } from "../types/work-item.js";
import { AgentRunner, type RunResult, type StreamCallback, type WorkItemContext } from "./agent-runner.js";
import { AgentRegistry } from "./agent-registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SessionStore } from "./session-store.js";
import type { SweepResult } from "../sweeper/sweeper.js";

const log = createLogger("agent-manager");

interface QueuedMessage {
  message: WorkItem;
  onStream?: StreamCallback;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

export class AgentManager {
  private states = new Map<string, AgentState>();
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private activeRunners = new Map<string, Set<AgentRunner>>();
  private activeThreads = new Map<string, Set<string>>();
  private registry: AgentRegistry;
  private memoryManager: MemoryManager;
  private sessionStore: SessionStore;

  constructor(registry: AgentRegistry, memoryManager: MemoryManager, sessionStore: SessionStore) {
    this.registry = registry;
    this.memoryManager = memoryManager;
    this.sessionStore = sessionStore;
  }

  private createRunner(agentId: string): AgentRunner {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    return new AgentRunner(config, this.memoryManager);
  }

  private ensureState(agentId: string): void {
    if (!this.states.has(agentId)) {
      this.states.set(agentId, {
        id: agentId,
        status: "idle",
        lastActivity: new Date(),
        messagesProcessed: 0,
        errorCount: 0,
        activeThreadCount: 0,
      });
    }
  }

  async sendMessage(agentId: string, message: WorkItem, onStream?: StreamCallback): Promise<RunResult> {
    this.ensureState(agentId);
    const threadId = message.threadId ?? message.id;
    const threadKey = `${agentId}:${threadId}`;

    return new Promise<RunResult>((resolve, reject) => {
      const queue = this.queues.get(threadKey) ?? [];
      queue.push({ message, onStream, resolve, reject });
      this.queues.set(threadKey, queue);
      this.processThreadQueue(agentId, threadKey).catch((err) => {
        log.error("processThreadQueue failed unexpectedly", { agentId, threadKey, error: String(err) });
        this.processing.delete(threadKey);
        const activeSet = this.activeThreads.get(agentId);
        if (activeSet) {
          activeSet.delete(threadKey);
          this.updateThreadCount(agentId);
          if (activeSet.size === 0) this.updateStatus(agentId, "idle");
        }
        const queue = this.queues.get(threadKey);
        if (queue) {
          for (const pending of queue) {
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.queues.delete(threadKey);
        }
        this.retryDeferredThreads(agentId);
      });
    });
  }

  private async processThreadQueue(agentId: string, threadKey: string): Promise<void> {
    // Serialize within same thread
    if (this.processing.has(threadKey)) return;

    const queue = this.queues.get(threadKey);
    if (!queue || queue.length === 0) return;

    // Check concurrency limit
    const config = this.registry.get(agentId);
    const limit = config?.maxConcurrent ?? 3;
    const activeSet = this.activeThreads.get(agentId) ?? new Set();
    if (activeSet.size >= limit) {
      log.debug("Agent at concurrency limit, deferring", { agentId, threadKey, active: activeSet.size, limit });
      return;
    }

    this.processing.add(threadKey);
    activeSet.add(threadKey);
    this.activeThreads.set(agentId, activeSet);
    this.updateStatus(agentId, "processing");
    this.updateThreadCount(agentId);

    const runner = this.createRunner(agentId);
    const runners = this.activeRunners.get(agentId) ?? new Set();
    runners.add(runner);
    this.activeRunners.set(agentId, runners);

    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const threadId = item.message.threadId ?? item.message.id;
        const existingSession = await this.sessionStore.get(agentId, threadId);

        const bgContext: WorkItemContext = {
          adapterId: item.message.source.adapterId ?? item.message.source.kind,
          channelId: item.message.source.id,
          channelKind: item.message.source.kind,
          channelLabel: item.message.source.label,
          threadId: item.message.threadId ?? item.message.id,
          slackTs: (item.message.meta?.slackTs as string) ?? "",
          slackThreadTs: (item.message.meta?.slackThreadTs as string) ?? "",
        };

        const result = await runner.send(item.message.text, existingSession, item.onStream, bgContext);

        if (result.sessionId && !result.aborted) {
          this.sessionStore.set(agentId, threadId, result.sessionId);
        }

        const state = this.states.get(agentId)!;
        state.messagesProcessed++;
        state.lastActivity = new Date();
        state.currentSessionId = result.sessionId;

        if (result.error) {
          state.errorCount++;
          // Don't set agent to error — other threads may be fine
        }

        item.resolve(result);
      } catch (err) {
        const state = this.states.get(agentId);
        if (state) {
          state.errorCount++;
          state.lastActivity = new Date();
        }
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Cleanup
    runners.delete(runner);
    this.processing.delete(threadKey);
    activeSet.delete(threadKey);
    this.queues.delete(threadKey);
    this.updateThreadCount(agentId);

    if (activeSet.size === 0) {
      this.updateStatus(agentId, "idle");
    }

    // Pick up deferred threads that were waiting for a slot
    this.retryDeferredThreads(agentId);
  }

  private updateThreadCount(agentId: string): void {
    const state = this.states.get(agentId);
    if (state) {
      state.activeThreadCount = this.activeThreads.get(agentId)?.size ?? 0;
    }
  }

  private retryDeferredThreads(agentId: string): void {
    const prefix = `${agentId}:`;
    for (const [threadKey, queue] of this.queues) {
      if (threadKey.startsWith(prefix) && queue.length > 0 && !this.processing.has(threadKey)) {
        this.processThreadQueue(agentId, threadKey);
        break; // One at a time to respect limit
      }
    }
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
    const runners = this.activeRunners.get(agentId);
    if (runners) {
      for (const runner of runners) {
        runner.abort();
      }
      runners.clear();
    }
    this.activeRunners.delete(agentId);
    this.activeThreads.delete(agentId);
    this.updateStatus(agentId, "stopped");
  }

  stopAll(): void {
    for (const agentId of this.states.keys()) {
      this.stopAgent(agentId);
    }
    log.info("All agents stopped");
  }

  /**
   * Find which agent was handling a given thread (delegates to SessionStore).
   * Used by Dispatcher for thread-continuity after restart.
   */
  async findAgentForThread(threadId: string): Promise<string | undefined> {
    return this.sessionStore.findAgentByThread(threadId);
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
      activeThreadCount: 0,
    });
    log.info("Agent restarted", { agentId });
  }

  sweep(): SweepResult {
    let pruned = 0;
    const errors: string[] = [];

    // 1. Remove zombie states — agents removed from registry
    for (const [agentId, state] of this.states) {
      if (!this.registry.get(agentId) && (state.status === "stopped" || state.status === "idle")) {
        this.states.delete(agentId);
        this.activeRunners.delete(agentId);
        this.activeThreads.delete(agentId);
        pruned++;
        log.info("Zombie agent state removed", { agentId });
      }
    }

    // 2. Detect stuck processing flags
    for (const threadKey of this.processing) {
      const agentId = threadKey.split(":")[0];
      const runners = this.activeRunners.get(agentId);
      if (!runners || runners.size === 0) {
        // No active runners but processing flag is set — stuck
        this.processing.delete(threadKey);
        const activeSet = this.activeThreads.get(agentId);
        if (activeSet) {
          activeSet.delete(threadKey);
          this.updateThreadCount(agentId);
          if (activeSet.size === 0) this.updateStatus(agentId, "idle");
        }
        pruned++;
        log.warn("Stuck processing flag cleared", { threadKey, agentId });

        // Try to restart the queue for this thread
        const queue = this.queues.get(threadKey);
        if (queue && queue.length > 0) {
          this.processThreadQueue(agentId, threadKey).catch((err) => {
            log.error("Failed to restart stuck queue", { threadKey, error: String(err) });
          });
        }
      }
    }

    // 3. Retry deferred threads for ALL agents with pending queues
    const agentIds = new Set<string>();
    for (const threadKey of this.queues.keys()) {
      agentIds.add(threadKey.split(":")[0]);
    }
    for (const agentId of agentIds) {
      this.retryDeferredThreads(agentId);
    }

    return { component: "agent-manager", pruned, retried: 0, bytesFreed: 0, errors };
  }
}
