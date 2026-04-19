import { createLogger } from "../logging/logger.js";
import type { AgentConfig, AgentState, AgentStatus } from "../types/agent-config.js";
import type { WorkItem } from "../types/work-item.js";
import { AgentRunner, type RunResult, type StreamCallback, type WorkItemContext } from "./agent-runner.js";
import { AgentRegistry } from "./agent-registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SessionStore } from "./session-store.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import { formatFilesForPrompt } from "../files/file-processor.js";
import { routeModel, type ResourceLimits } from "./model-router.js";
import { config as appConfig } from "../config.js";
import { loadPlugins } from "../plugins/plugin-loader.js";
import type { LoadedPlugin } from "../plugins/types.js";
import { loadSkillIndex, type SkillIndex } from "./skill-loader.js";
import { skillsDir, seedsDir, hiveHome } from "../paths.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConversationIndex } from "../search/conversation-index.js";
import type { ActivityLogger } from "../activity/activity-logger.js";
import type { CodeIndexPrefetcher } from "../code-index/prefetcher.js";

const log = createLogger("agent-manager");
const conversationIndex = new ConversationIndex();

/**
 * Discover seed directories that contain skills.
 * Returns absolute paths to seed dirs (e.g., ["<repo>/seeds/chief-of-staff"]).
 */
function discoverSeedDirs(rootSeedsDir: string): string[] {
  if (!existsSync(rootSeedsDir)) return [];
  try {
    return readdirSync(rootSeedsDir)
      .map((d) => join(rootSeedsDir, d))
      .filter((p) => {
        try {
          return statSync(p).isDirectory() && existsSync(join(p, "skills"));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

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
  // Keyed by agentId → list of currently in-flight WorkItems (one per active thread).
  private activeWorkItems = new Map<string, WorkItem[]>();
  private registry: AgentRegistry;
  private memoryManager: MemoryManager;
  private sessionStore: SessionStore;
  private plugins: LoadedPlugin[];
  private seedDirs: string[];
  private skillIndex: SkillIndex;
  private activityLogger?: ActivityLogger;
  private prefetcher?: CodeIndexPrefetcher;

  constructor(registry: AgentRegistry, memoryManager: MemoryManager, sessionStore: SessionStore, activityLogger?: ActivityLogger, prefetcher?: CodeIndexPrefetcher) {
    this.registry = registry;
    this.memoryManager = memoryManager;
    this.sessionStore = sessionStore;
    this.activityLogger = activityLogger;
    this.prefetcher = prefetcher;
    this.plugins = loadPlugins(appConfig.plugins, hiveHome);
    this.seedDirs = discoverSeedDirs(seedsDir);
    this.skillIndex = loadSkillIndex(skillsDir, this.plugins, this.seedDirs);
  }

  getPlugins(): LoadedPlugin[] {
    return this.plugins;
  }

  getActiveWorkItems(agentId: string): WorkItem[] {
    return this.activeWorkItems.get(agentId) ?? [];
  }

  private createRunner(agentId: string): AgentRunner {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
    return new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher);
  }

  reloadSkills(): void {
    try {
      this.skillIndex = loadSkillIndex(skillsDir, this.plugins, this.seedDirs);
    } catch (err) {
      log.warn("Skill reload failed, retaining previous index", { error: String(err) });
    }
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

    let turnCount = 0;
    let lastItem: QueuedMessage | undefined;
    let lastResult: RunResult | undefined;

    while (queue.length > 0) {
      const item = queue.shift()!;
      // Track this item as active for cross-subsystem visibility (e.g., slack internal API
      // threading fallback). Must be set BEFORE runner.send() and cleared in finally.
      const activeList = this.activeWorkItems.get(agentId) ?? [];
      activeList.push(item.message);
      this.activeWorkItems.set(agentId, activeList);
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

        // Prepend sender identity so the agent knows who they're talking to.
        // For team channel (KPR-23): `meta.user` is the server-asserted
        // identity forwarded by beekeeper after JWT verification. When set,
        // surface it so agents treat it as "the user I'm talking with,"
        // distinct from the cosmetic device label. Scoped to team-channel
        // sources only (KPR-27) — no other adapter has authority to assert
        // a user identity, and a stray `meta.user` from slack/sms/scheduler
        // must not leak into the prompt.
        const senderLabel = item.message.senderName ?? item.message.sender;
        const userId =
          item.message.source.kind === "team"
            ? (item.message.meta?.user as string | undefined)
            : undefined;
        let prompt: string;
        if (userId) {
          prompt = `[user:${userId} via ${senderLabel} in #${item.message.source.label}]: ${item.message.text}`;
        } else if (item.message.senderName) {
          const slackThreadTs = (item.message.meta as any)?.slackThreadTs;
          const slackTs = (item.message.meta as any)?.slackTs;
          const threadHint = slackThreadTs ? `, thread=${slackThreadTs}` : slackTs ? `, thread=${slackTs}` : "";
          prompt = `[${senderLabel} in #${item.message.source.label}${threadHint}]: ${item.message.text}`;
        } else {
          prompt = item.message.text;
        }

        // Append file attachments to prompt
        if (item.message.files?.length) {
          prompt += formatFilesForPrompt(item.message.files);
        }

        // Model routing — classify complexity and pick the right model tier
        let modelOverride: string | undefined;
        let routerCostUsd = 0;
        let resourceLimits: ResourceLimits | undefined;
        if (appConfig.modelRouter.enabled && item.message.sender !== "system") {
          try {
            const agentConfig = this.registry.get(agentId);
            if (agentConfig) {
              const route = await routeModel(
                item.message.text,
                agentConfig.model,
                agentConfig.resourceTiers,
              );
              modelOverride = route.model !== agentConfig.model ? route.model : undefined;
              routerCostUsd = route.costUsd;
              resourceLimits = route.resourceLimits;
            }
          } catch (err) {
            log.warn("Model router failed, using default", { agentId, error: String(err) });
          }
        }

        const result = await runner.send(prompt, existingSession, item.onStream, bgContext, modelOverride, resourceLimits);
        result.costUsd += routerCostUsd;

        if (result.sessionId && !result.aborted) {
          this.sessionStore.set(agentId, threadId, result.sessionId, {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: result.cacheReadTokens,
            cacheCreationTokens: result.cacheCreationTokens,
            contextWindow: result.contextWindow,
            compactions: result.compactions,
            preCompactTokens: result.preCompactTokens,
          });
        }

        const state = this.states.get(agentId)!;
        state.messagesProcessed++;
        state.lastActivity = new Date();
        state.currentSessionId = result.sessionId;

        if (result.error) {
          state.errorCount++;
          // Don't set agent to error — other threads may be fine
          // Clear stale session so next message starts fresh
          if (existingSession) {
            this.sessionStore.delete(agentId, threadId);
          }
        }

        item.resolve(result);

        turnCount++;
        lastItem = item;
        lastResult = result;

        // Fire-and-forget: index conversation turn for semantic recall
        if (result.text && !result.error) {
          conversationIndex.index({
            agentId,
            threadId,
            channelId: item.message.source.id,
            source: item.message.source.kind,
            senderName: item.message.senderName ?? "unknown",
            timestampUnix: Math.floor(Date.now() / 1000),
            timestamp: new Date().toISOString(),
            inbound: prompt,
            response: result.text,
          }).catch(err => log.warn("Conversation indexing failed", { agentId, error: String(err) }));
        }

        // Record activity for audit trail
        this.activityLogger?.record({
          agentId,
          threadId,
          timestamp: new Date(),
          sender: item.message.sender,
          senderName: item.message.senderName,
          channel: item.message.source.label,
          channelKind: item.message.source.kind,
          model: modelOverride ?? config?.model ?? "unknown",
          modelTier: undefined, // Model router tier not currently passed through
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          contextWindow: result.contextWindow,
          toolCalls: result.toolCalls,
          toolSummary: result.toolSummary,
          compactions: result.compactions,
          streamed: result.streamed,
          error: result.error,
        });
      } catch (err) {
        const state = this.states.get(agentId);
        if (state) {
          state.errorCount++;
          state.lastActivity = new Date();
        }
        // Record failed turn in audit trail
        this.activityLogger?.record({
          agentId,
          threadId: item.message.threadId ?? item.message.id,
          timestamp: new Date(),
          sender: item.message.sender,
          senderName: item.message.senderName,
          channel: item.message.source.label,
          channelKind: item.message.source.kind,
          model: config?.model ?? "unknown",
          costUsd: 0,
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          contextWindow: 0,
          toolCalls: 0,
          toolSummary: "none",
          compactions: 0,
          streamed: false,
          error: String(err),
        });
        item.reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        const remaining = (this.activeWorkItems.get(agentId) ?? []).filter((w) => w.id !== item.message.id);
        if (remaining.length === 0) this.activeWorkItems.delete(agentId);
        else this.activeWorkItems.set(agentId, remaining);
      }
    }

    // End-of-conversation reflection — prompt agent to save memories
    const allServers = [...(config?.coreServers ?? []), ...(config?.delegateServers ?? [])];
    const hasMemoryServer = allServers.includes("memory")
      || allServers.includes("structured-memory");
    if (
      hasMemoryServer &&
      lastResult &&
      lastItem &&
      !lastResult.error &&
      !lastResult.aborted &&
      turnCount >= appConfig.memory.reflectionMinTurns &&
      lastItem.message.sender !== "system"
    ) {
      try {
        const reflectionPrompt = [
          "[System — end of conversation reflection]",
          "This conversation is wrapping up. Review what was discussed:",
          "- Were any new facts, decisions, or commitments made?",
          "- Did anything contradict or update what you previously knew?",
          "- Should any existing memories be updated or forgotten?",
          "",
          "If yes, use memory_save, memory_update, or memory_forget now.",
          "If nothing worth saving, do nothing.",
        ].join("\n");

        const reflectionResult = await runner.send(reflectionPrompt, lastResult.sessionId);
        log.info("Reflection completed", {
          agentId,
          threadKey,
          turnCount,
          costUsd: reflectionResult.costUsd,
          toolCalls: reflectionResult.toolCalls,
          toolSummary: reflectionResult.toolSummary || undefined,
        });

        // Persist session so next message picks up post-reflection state
        if (reflectionResult.sessionId && !reflectionResult.aborted) {
          const threadId = lastItem.message.threadId ?? lastItem.message.id;
          this.sessionStore.set(agentId, threadId, reflectionResult.sessionId, {
            inputTokens: reflectionResult.inputTokens,
            outputTokens: reflectionResult.outputTokens,
            cacheReadTokens: reflectionResult.cacheReadTokens,
            cacheCreationTokens: reflectionResult.cacheCreationTokens,
            contextWindow: reflectionResult.contextWindow,
            compactions: reflectionResult.compactions,
            preCompactTokens: reflectionResult.preCompactTokens,
          });
        }
      } catch (err) {
        log.warn("Reflection failed, non-critical", { agentId, threadKey, error: String(err) });
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

  /**
   * Find ALL agents that have sessions for a given thread (delegates to SessionStore).
   * Used by Dispatcher to recover multi-agent participant sets after restart.
   */
  async findAgentsForThread(threadId: string): Promise<string[]> {
    return this.sessionStore.findAgentsByThread(threadId);
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
