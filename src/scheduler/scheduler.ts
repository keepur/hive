import { createLogger } from "../logging/logger.js";
import { config } from "../config.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { HealthReporter } from "../health/health-reporter.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import { MongoClient, type Collection, type Db } from "mongodb";

const log = createLogger("scheduler");

interface CronJob {
  agentId: string;
  cron: string;
  task: string;
  lastRun: Date | null;
}

interface CallbackDoc {
  agentId: string;
  dueAt: Date;
  context: string;
  createdAt: Date;
  status: "pending" | "fired" | "cancelled";
  source: {
    adapterId: string;
    channelId: string;
    channelKind: string;
    channelLabel: string;
    threadId: string;
    slackTs: string;
    slackThreadTs: string;
  };
}

export class Scheduler {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cronTimer: ReturnType<typeof setInterval> | null = null;
  private callbackTimer: ReturnType<typeof setInterval> | null = null;
  private agentManager: AgentManager;
  private memoryManager: MemoryManager;
  private healthReporter: HealthReporter;
  private registry: AgentRegistry;
  private cronJobs: CronJob[] = [];
  private mongoClient: MongoClient | null = null;
  private callbackCollection: Collection<CallbackDoc> | null = null;
  private onCallbackDispatch?: (item: WorkItem) => void;

  constructor(
    agentManager: AgentManager,
    memoryManager: MemoryManager,
    healthReporter: HealthReporter,
    registry: AgentRegistry,
    onCallbackDispatch?: (item: WorkItem) => void,
  ) {
    this.agentManager = agentManager;
    this.memoryManager = memoryManager;
    this.healthReporter = healthReporter;
    this.registry = registry;
    this.onCallbackDispatch = onCallbackDispatch;

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

  async connectDb(uri: string, dbName: string): Promise<void> {
    this.mongoClient = new MongoClient(uri);
    await this.mongoClient.connect();
    const db = this.mongoClient.db(dbName);
    this.callbackCollection = db.collection<CallbackDoc>("agent_callbacks");
    // Index for efficient polling
    await this.callbackCollection.createIndex({ status: 1, dueAt: 1 });
    log.info("Callback store connected", { db: dbName });
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

    // Callbacks: check every 30 seconds for due agent callbacks
    if (this.callbackCollection) {
      this.callbackTimer = setInterval(() => {
        this.checkCallbacks().catch((err) => {
          log.error("Callback check failed", { error: String(err) });
        });
      }, 30_000);
    }

    log.info("Scheduler started", {
      heartbeatMs: config.scheduler.heartbeatIntervalMs,
      cronJobs: this.cronJobs.length,
      callbacksEnabled: !!this.callbackCollection,
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
    if (this.callbackTimer) {
      clearInterval(this.callbackTimer);
      this.callbackTimer = null;
    }
    this.mongoClient?.close().catch(() => {});
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

        const workItem: WorkItem = {
          id: `sched:${job.agentId}:${job.task}:${Date.now()}`,
          text: `[Scheduled task: ${job.task}] Execute your scheduled "${job.task}" task now.`,
          source: { kind: "scheduler", id: job.agentId, label: "scheduler" },
          sender: "system",
          threadId: `scheduler:${job.agentId}:${job.task}:${now.toISOString().split("T")[0]}`,
          timestamp: now,
        };
        this.agentManager.sendMessage(job.agentId, workItem).catch((err) => {
          log.error("Scheduled task failed", { agentId: job.agentId, task: job.task, error: String(err) });
        });
      }
    }
  }

  private async checkCallbacks(): Promise<void> {
    if (!this.callbackCollection) return;

    const now = new Date();

    // Find all due callbacks and mark them fired atomically
    const cursor = this.callbackCollection.find({
      status: "pending",
      dueAt: { $lte: now },
    });

    for await (const cb of cursor) {
      // Mark as fired first to prevent double-dispatch
      const updateResult = await this.callbackCollection.updateOne(
        { _id: cb._id, status: "pending" },
        { $set: { status: "fired", firedAt: now } },
      );
      if (updateResult.modifiedCount === 0) continue; // already picked up

      log.info("Firing callback", {
        agentId: cb.agentId,
        callbackId: cb._id.toString(),
        contextPreview: cb.context.slice(0, 80),
      });

      // Verify the agent still exists
      if (!this.registry.get(cb.agentId)) {
        log.warn("Callback agent not found, skipping", { agentId: cb.agentId });
        continue;
      }

      const workItem: WorkItem = {
        id: `callback:${cb._id.toString()}`,
        text: `[Scheduled callback] ${cb.context}`,
        source: {
          kind: (cb.source.channelKind || "slack") as ChannelKind,
          id: cb.source.channelId,
          label: cb.source.channelLabel,
          adapterId: cb.source.adapterId,
        },
        sender: "system",
        threadId: cb.source.threadId || undefined,
        timestamp: now,
        meta: {
          slackTs: cb.source.slackTs,
          slackThreadTs: cb.source.slackThreadTs,
          targetAgentId: cb.agentId,
        },
      };

      if (this.onCallbackDispatch) {
        // Route through dispatcher for full pipeline (triage, agent, delivery)
        this.onCallbackDispatch(workItem);
      } else {
        // Fallback: direct to agent manager (no response routing)
        this.agentManager.sendMessage(cb.agentId, workItem).catch((err) => {
          log.error("Callback dispatch failed", {
            agentId: cb.agentId,
            callbackId: cb._id.toString(),
            error: String(err),
          });
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
