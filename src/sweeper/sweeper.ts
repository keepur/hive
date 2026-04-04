import { createLogger } from "../logging/logger.js";
import type { Dispatcher } from "../channels/dispatcher.js";
import type { SlackAdapter } from "../channels/slack-adapter.js";
import type { BackgroundTaskManager } from "../background/background-task-manager.js";
import type { CodeTaskManager } from "../code-task/code-task-manager.js";
import type { MeetingMonitor } from "../recall/meeting-monitor.js";
import type { TaskLedger } from "../tasks/task-ledger.js";
import type { SlackGateway } from "../slack/slack-gateway.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { RetryQueue } from "./retry-queue.js";
import type { TaskClient } from "../tasks/task-client.js";
import type { MemoryLifecycle } from "../memory/memory-lifecycle.js";
import type { DreamConfig } from "../memory/memory-types.js";

const log = createLogger("sweeper");

export interface SweepResult {
  component: string;
  pruned: number;
  retried: number;
  bytesFreed: number;
  errors: string[];
}

export interface SweeperConfig {
  intervalMs: number;
  threadTtlMs: number;
  taskFileTtlMs: number;
  meetingSessionTtlMs: number;
  cacheTtlMs: number;
  memorySweepIntervalHours?: number;
  dreamConfig?: DreamConfig;
}

export interface SweeperTargets {
  dispatcher: Dispatcher;
  slackAdapters: SlackAdapter[];
  bgTaskManager: BackgroundTaskManager;
  codeTaskManager?: CodeTaskManager;
  meetingMonitor?: MeetingMonitor;
  taskLedger?: TaskLedger;
  slackGateways: SlackGateway[];
  agentManager: AgentManager;
  retryQueue?: RetryQueue;
  memoryLifecycle?: MemoryLifecycle;
}

export class Sweeper {
  private config: SweeperConfig;
  private targets: SweeperTargets;
  private taskClient?: TaskClient;
  private taskId?: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepCount = 0;
  private gatewayCycleCounter = 0;
  private memoryCycleCounter = 0;
  private memorySweepEvery: number;
  private lastDreamAt = 0; // timestamp of last dream run

  private static readonly GATEWAY_SWEEP_EVERY = 12; // every 12th cycle (~1h at 5min interval)

  constructor(config: SweeperConfig, targets: SweeperTargets, taskClient?: TaskClient) {
    this.config = config;
    this.targets = targets;
    this.taskClient = taskClient;
    // Derive memory sweep cycle count: e.g., 6 hours / (300000ms → 0.0833h) = 72 cycles
    const sweepIntervalH = config.memorySweepIntervalHours ?? 6;
    this.memorySweepEvery = Math.round((sweepIntervalH * 3600000) / config.intervalMs);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        log.error("Sweep cycle failed", { error: String(err) });
      });
    }, this.config.intervalMs);
    log.info("Sweeper started", { intervalMs: this.config.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Sweeper stopped");
  }

  async sweep(): Promise<SweepResult[]> {
    const start = Date.now();
    this.sweepCount++;
    this.gatewayCycleCounter++;
    const results: SweepResult[] = [];

    // 1. Dispatcher — prune threadAgentMap
    try {
      results.push(this.targets.dispatcher.sweep(this.config.threadTtlMs));
    } catch (err) {
      results.push({ component: "dispatcher", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
    }

    // 2. Slack adapters — prune threadContextMap
    for (const adapter of this.targets.slackAdapters) {
      try {
        results.push(adapter.sweep(this.config.threadTtlMs));
      } catch (err) {
        results.push({
          component: `slack-adapter:${adapter.id}`,
          pruned: 0,
          retried: 0,
          bytesFreed: 0,
          errors: [String(err)],
        });
      }
    }

    // 3. Task ledger — prune threadTaskMap
    if (this.targets.taskLedger) {
      try {
        results.push(this.targets.taskLedger.sweep(this.config.threadTtlMs));
      } catch (err) {
        results.push({ component: "task-ledger", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
      }
    }

    // 4. Background task manager — prune completed tasks + delete old files
    try {
      results.push(await this.targets.bgTaskManager.sweep(this.config.taskFileTtlMs));
    } catch (err) {
      results.push({ component: "bg-task-manager", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
    }

    // 4b. Code task manager — prune completed code tasks + delete old files
    if (this.targets.codeTaskManager) {
      try {
        results.push(await this.targets.codeTaskManager.sweep(this.config.taskFileTtlMs));
      } catch (err) {
        results.push({ component: "code-task-manager", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
      }
    }

    // 5. Meeting monitor — remove ended sessions
    if (this.targets.meetingMonitor) {
      try {
        results.push(this.targets.meetingMonitor.sweep(this.config.meetingSessionTtlMs));
      } catch (err) {
        results.push({ component: "meeting-monitor", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
      }
    }

    // 6. Slack gateways — clear name caches (every 12th cycle)
    if (this.gatewayCycleCounter >= Sweeper.GATEWAY_SWEEP_EVERY) {
      this.gatewayCycleCounter = 0;
      for (const gw of this.targets.slackGateways) {
        try {
          results.push(gw.sweep());
        } catch (err) {
          results.push({ component: "slack-gateway", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
        }
      }
    }

    // 7. Agent manager — zombie cleanup, stuck detection, deferred retry
    try {
      results.push(this.targets.agentManager.sweep());
    } catch (err) {
      results.push({ component: "agent-manager", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
    }

    // 8. Retry queue — process pending retries
    if (this.targets.retryQueue) {
      try {
        const retryStats = await this.targets.retryQueue.processRetries();
        results.push({
          component: "retry-queue",
          pruned: retryStats.dropped,
          retried: retryStats.retried,
          bytesFreed: 0,
          errors: retryStats.errors,
        });
      } catch (err) {
        results.push({ component: "retry-queue", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
      }
    }

    // 9. Memory lifecycle — tier scoring, budget enforcement, summarization
    if (this.targets.memoryLifecycle) {
      this.memoryCycleCounter++;
      if (this.memoryCycleCounter >= this.memorySweepEvery) {
        this.memoryCycleCounter = 0;
        try {
          results.push(await this.targets.memoryLifecycle.sweep());
        } catch (err) {
          results.push({ component: "memory-lifecycle", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
        }
      }
    }

    // 10. autoDream — proactive memory consolidation
    // Trigger conditions: (a) after regular memory sweep, or (b) all agents idle for threshold
    if (this.targets.memoryLifecycle && this.config.dreamConfig?.enabled) {
      const dreamCfg = this.config.dreamConfig;
      const cooldownMs = dreamCfg.cooldownMinutes * 60 * 1000;
      const now = Date.now();
      const cooldownElapsed = (now - this.lastDreamAt) > cooldownMs;

      // (a) Post-sweep trigger: runs right after the regular memory lifecycle sweep
      const justSwept = this.memoryCycleCounter === 0; // counter was just reset above

      // (b) Idle trigger: all agents idle for threshold duration
      let allIdle = false;
      if (cooldownElapsed && !justSwept) {
        const thresholdMs = dreamCfg.idleThresholdMinutes * 60 * 1000;
        const states = this.targets.agentManager.getAllStates();
        allIdle = states.length > 0 && states.every(
          (s) => s.status === "idle" && (now - s.lastActivity.getTime()) > thresholdMs,
        );
      }

      if (cooldownElapsed && (justSwept || allIdle)) {
        const trigger = justSwept ? "post-sweep" : "idle";
        log.info("autoDream triggered", { trigger });
        try {
          const dreamResult = await this.targets.memoryLifecycle.dream();
          this.lastDreamAt = Date.now();
          const totalActions = dreamResult.merged + dreamResult.contradictions + dreamResult.promoted;
          if (totalActions > 0 || dreamResult.errors.length > 0) {
            results.push({
              component: "autodream",
              pruned: dreamResult.merged + dreamResult.contradictions,
              retried: dreamResult.promoted,
              bytesFreed: 0,
              errors: dreamResult.errors,
            });
          }
        } catch (err) {
          results.push({ component: "autodream", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
        }
      }
    }

    // Aggregate
    const durationMs = Date.now() - start;
    const totalPruned = results.reduce((sum, r) => sum + r.pruned, 0);
    const totalRetried = results.reduce((sum, r) => sum + r.retried, 0);
    const totalBytesFreed = results.reduce((sum, r) => sum + r.bytesFreed, 0);
    const totalErrors = results.flatMap((r) => r.errors);

    const isQuiet = totalPruned === 0 && totalRetried === 0 && totalBytesFreed === 0 && totalErrors.length === 0;
    const logFn = isQuiet ? log.debug.bind(log) : log.info.bind(log);

    logFn("Sweep cycle complete", {
      cycle: this.sweepCount,
      durationMs,
      pruned: totalPruned,
      retried: totalRetried,
      bytesFreed: totalBytesFreed,
      errors: totalErrors.length,
      components: results.map((r) => `${r.component}:${r.pruned}p/${r.retried}r`).join(" "),
    });

    // Report to dodi_v2
    if (this.taskClient?.isConfigured && !isQuiet) {
      await this.reportToDodi(durationMs, totalPruned, totalRetried, totalBytesFreed, totalErrors);
    }

    return results;
  }

  private async reportToDodi(
    durationMs: number,
    totalPruned: number,
    totalRetried: number,
    totalBytesFreed: number,
    totalErrors: string[],
  ): Promise<void> {
    try {
      // Create task on first report
      if (!this.taskId) {
        const task = await this.taskClient!.createTask({
          name: "[Sweeper] Periodic maintenance",
          type: "AGENT",
          description: "Long-running system health task. Each comment is a sweep cycle report.",
        });
        if (task) {
          this.taskId = task._id;
        }
      }

      if (!this.taskId) return;

      const comment = [
        `**Sweep #${this.sweepCount}** (${durationMs}ms)`,
        `Pruned: ${totalPruned} | Retried: ${totalRetried} | Freed: ${this.formatBytes(totalBytesFreed)}`,
        totalErrors.length > 0 ? `Errors: ${totalErrors.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      await this.taskClient!.addComment(this.taskId, comment);

      if (totalErrors.length > 0) {
        await this.taskClient!.updateTask(this.taskId, { state: "NEEDS_ATTENTION" });
      }
    } catch (err) {
      log.warn("Failed to report to dodi_v2", { error: String(err) });
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }
}
