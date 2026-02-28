import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { HealthReporter } from "../health/health-reporter.js";
import type { AgentRegistry } from "../agents/agent-registry.js";

const log = createLogger("scheduler");

interface CronJob {
  agentId: string;
  cron: string;
  task: string;
  lastRun: Date | null;
}

export class Scheduler {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cronTimer: ReturnType<typeof setInterval> | null = null;
  private agentManager: AgentManager;
  private memoryManager: MemoryManager;
  private healthReporter: HealthReporter;
  private registry: AgentRegistry;
  private cronJobs: CronJob[] = [];

  constructor(
    agentManager: AgentManager,
    memoryManager: MemoryManager,
    healthReporter: HealthReporter,
    registry: AgentRegistry,
  ) {
    this.agentManager = agentManager;
    this.memoryManager = memoryManager;
    this.healthReporter = healthReporter;
    this.registry = registry;

    // Build cron job list from agent configs
    for (const agent of registry.getAll()) {
      for (const schedule of agent.schedule) {
        this.cronJobs.push({
          agentId: agent.id,
          cron: schedule.cron,
          task: schedule.task,
          lastRun: null,
        });
      }
    }
  }

  start(): void {
    // Heartbeat: write health status to memory repo
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.memoryManager.pull();
        await this.healthReporter.writeToMemory();
      } catch (err) {
        log.error("Heartbeat failed", { error: String(err) });
      }
    }, config.scheduler.heartbeatIntervalMs);

    // Cron: check every minute for scheduled tasks
    this.cronTimer = setInterval(() => {
      this.checkCronJobs();
    }, 60_000);

    log.info("Scheduler started", {
      heartbeatMs: config.scheduler.heartbeatIntervalMs,
      cronJobs: this.cronJobs.length,
    });
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    log.info("Scheduler stopped");
  }

  private checkCronJobs(): void {
    const now = new Date();

    for (const job of this.cronJobs) {
      if (cronMatches(job.cron, now)) {
        // Skip if already ran this minute
        if (job.lastRun && isSameMinute(job.lastRun, now)) continue;

        job.lastRun = now;
        log.info("Triggering scheduled task", { agentId: job.agentId, task: job.task });

        this.agentManager
          .sendMessage(job.agentId, {
            text: `[Scheduled task: ${job.task}] Execute your scheduled "${job.task}" task now.`,
            channel: "scheduler",
            user: "system",
            ts: Date.now().toString(),
          })
          .catch((err) => {
            log.error("Scheduled task failed", { agentId: job.agentId, task: job.task, error: String(err) });
          });
      }
    }
  }
}

// Minimal cron parser: "minute hour day-of-month month day-of-week"
function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return false;

  const [minPart, hourPart, domPart, monPart, dowPart] = parts;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay(); // 0=Sunday

  return (
    fieldMatches(minPart, minute) &&
    fieldMatches(hourPart, hour) &&
    fieldMatches(domPart, dayOfMonth) &&
    fieldMatches(monPart, month) &&
    fieldMatches(dowPart, dayOfWeek)
  );
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;

  // Handle ranges like "1-5"
  if (field.includes("-")) {
    const [start, end] = field.split("-").map(Number);
    return value >= start && value <= end;
  }

  // Handle lists like "1,3,5"
  if (field.includes(",")) {
    return field.split(",").map(Number).includes(value);
  }

  // Handle step like "*/5"
  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    return value % step === 0;
  }

  return Number(field) === value;
}

function isSameMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}
