import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import type { SweepResult } from "../sweeper/sweeper.js";

const log = createLogger("bg-task-manager");
const TASKS_DIR = "/tmp/hive-bg-tasks";
const LOG_TAIL_LINES = 100;

export interface BackgroundTaskContext {
  agentId: string;
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
}

interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "completed" | "failed" | "orphaned";
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  logPath: string;
  metaPath: string;
  context: BackgroundTaskContext;
  pid: number | null;
}

export class BackgroundTaskManager {
  private port: number;
  private tasks = new Map<string, BackgroundTask>();
  private onComplete: (item: WorkItem) => void;
  private server: Server | null = null;
  private orphanPollers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(port: number, onComplete: (item: WorkItem) => void) {
    this.port = port;
    this.onComplete = onComplete;
  }

  async start(): Promise<void> {
    await mkdir(TASKS_DIR, { recursive: true });

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error("HTTP handler error", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, "127.0.0.1", () => resolve());
    });

    log.info("Background task manager started", { port: this.port });
  }

  async scanOrphans(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(TASKS_DIR);
    } catch {
      return;
    }

    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    let orphaned = 0;
    let recovered = 0;

    for (const file of jsonFiles) {
      try {
        const content = await readFile(`${TASKS_DIR}/${file}`, "utf-8");
        const task: BackgroundTask = JSON.parse(content);

        this.tasks.set(task.id, task);

        if (task.status === "running" && task.pid) {
          if (this.isProcessAlive(task.pid)) {
            // Still running — poll for exit
            this.pollOrphan(task.id, task.pid);
            recovered++;
          } else {
            // Died while Hive was down
            task.status = "orphaned";
            task.completedAt = new Date().toISOString();
            await this.writeMeta(task);
            this.fireCompletion(task);
            orphaned++;
          }
        }
      } catch (err) {
        log.warn("Failed to read orphan task file", { file, error: String(err) });
      }
    }

    if (orphaned > 0 || recovered > 0) {
      log.info("Orphan scan complete", { orphaned, recovered, total: jsonFiles.length });
    }
  }

  stop(): void {
    for (const [id, timer] of this.orphanPollers) {
      clearInterval(timer);
    }
    this.orphanPollers.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    log.info("Background task manager stopped");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    // POST /tasks — spawn a new background task
    if (req.method === "POST" && url.pathname === "/tasks") {
      const body = await this.readBody(req);
      const parsed = JSON.parse(body);

      const task = await this.spawnTask(parsed);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: task.id, status: "running" }));
      return;
    }

    // GET /tasks/:id — get task status
    const idMatch = url.pathname.match(/^\/tasks\/([a-f0-9-]+)$/);
    if (req.method === "GET" && idMatch) {
      const id = idMatch[1];
      const status = await this.taskStatus(id);

      if (!status) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Task not found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }

    // GET /tasks — list tasks
    if (req.method === "GET" && url.pathname === "/tasks") {
      const agentId = url.searchParams.get("agentId") ?? undefined;
      const list = await this.listTasks(agentId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tasks: list }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async spawnTask(body: {
    command: string;
    cwd?: string;
    context: BackgroundTaskContext;
  }): Promise<BackgroundTask> {
    const id = randomUUID();
    const logPath = `${TASKS_DIR}/${id}.log`;
    const metaPath = `${TASKS_DIR}/${id}.json`;
    const cwd = body.cwd ?? process.env.HOME ?? "/tmp";

    const logFd = openSync(logPath, "a");

    const child = spawn(body.command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    // Close the fd in the parent — the child inherited it
    closeSync(logFd);

    const task: BackgroundTask = {
      id,
      command: body.command,
      cwd,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      logPath,
      metaPath,
      context: body.context,
      pid: child.pid ?? null,
    };

    this.tasks.set(id, task);
    await this.writeMeta(task);

    child.on("exit", (code) => this.handleExit(id, code));
    child.on("error", (err) => {
      log.error("Background task process error", { id, error: String(err) });
      this.handleExit(id, 1);
    });

    log.info("Background task spawned", {
      id,
      command: body.command,
      cwd,
      pid: child.pid,
      agentId: body.context.agentId,
    });

    return task;
  }

  private async handleExit(id: string, code: number | null): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;

    task.exitCode = code ?? 1;
    task.status = task.exitCode === 0 ? "completed" : "failed";
    task.completedAt = new Date().toISOString();

    await this.writeMeta(task);
    this.fireCompletion(task);
  }

  private fireCompletion(task: BackgroundTask): void {
    const startTime = new Date(task.startedAt).getTime();
    const endTime = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
    const durationSec = ((endTime - startTime) / 1000).toFixed(1);

    // Read output synchronously-ish via a promise we don't await
    // (fireCompletion is called from event handlers, keep it non-blocking)
    this.tailLog(task.logPath, LOG_TAIL_LINES)
      .then((output) => {
        const statusEmoji =
          task.status === "completed" ? "completed" : task.status === "failed" ? "failed" : "orphaned";

        const completionItem: WorkItem = {
          id: `bg:${task.id}:done:${Date.now()}`,
          text: [
            `[Background task ${statusEmoji}] Task \`${task.id}\` finished with exit code ${task.exitCode ?? "unknown"}.`,
            `Command: \`${task.command}\``,
            `Duration: ${durationSec}s`,
            `Output (last ${LOG_TAIL_LINES} lines):`,
            "```",
            output || "(no output)",
            "```",
          ].join("\n"),
          source: {
            kind: (task.context.channelKind || "internal") as ChannelKind,
            id: task.context.channelId,
            label: task.context.channelLabel,
            adapterId: task.context.adapterId,
          },
          sender: "system",
          threadId: task.context.threadId,
          timestamp: new Date(),
          meta: {
            slackTs: task.context.slackTs,
            slackThreadTs: task.context.slackThreadTs,
            bgTaskId: task.id,
          },
        };

        log.info("Background task completed, dispatching notification", {
          id: task.id,
          status: task.status,
          exitCode: task.exitCode,
          durationSec,
          agentId: task.context.agentId,
        });

        this.onComplete(completionItem);
      })
      .catch((err) => {
        log.error("Failed to fire completion notification", { id: task.id, error: String(err) });
      });
  }

  private async taskStatus(id: string): Promise<Record<string, unknown> | null> {
    const task = this.tasks.get(id);
    if (!task) return null;

    const output = await this.tailLog(task.logPath, LOG_TAIL_LINES);

    return {
      id: task.id,
      status: task.status,
      exitCode: task.exitCode,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      command: task.command,
      output,
    };
  }

  private async listTasks(agentId?: string): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];

    for (const task of this.tasks.values()) {
      if (agentId && task.context.agentId !== agentId) continue;

      results.push({
        id: task.id,
        status: task.status,
        exitCode: task.exitCode,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        command: task.command,
      });
    }

    return results;
  }

  private async writeMeta(task: BackgroundTask): Promise<void> {
    try {
      await writeFile(task.metaPath, JSON.stringify(task, null, 2), "utf-8");
    } catch (err) {
      log.error("Failed to write task metadata", { id: task.id, error: String(err) });
    }
  }

  private async tailLog(logPath: string, lines: number): Promise<string> {
    try {
      const content = await readFile(logPath, "utf-8");
      const allLines = content.split("\n");
      return allLines.slice(-lines).join("\n").trim();
    } catch {
      return "";
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private pollOrphan(taskId: string, pid: number): void {
    const timer = setInterval(() => {
      if (!this.isProcessAlive(pid)) {
        clearInterval(timer);
        this.orphanPollers.delete(taskId);

        const task = this.tasks.get(taskId);
        if (task && task.status === "running") {
          task.status = "orphaned";
          task.completedAt = new Date().toISOString();
          this.writeMeta(task).then(() => this.fireCompletion(task));
        }
      }
    }, 5_000);

    this.orphanPollers.set(taskId, timer);
  }

  async sweep(taskFileTtlMs: number): Promise<SweepResult> {
    const cutoff = Date.now() - taskFileTtlMs;
    let pruned = 0;
    let bytesFreed = 0;
    const errors: string[] = [];

    for (const [id, task] of this.tasks) {
      if (task.status === "running") continue;
      if (!task.completedAt) continue;

      const completedTime = new Date(task.completedAt).getTime();
      if (completedTime > cutoff) continue;

      // Delete files
      for (const filePath of [task.metaPath, task.logPath]) {
        try {
          const st = await stat(filePath);
          bytesFreed += st.size;
          await unlink(filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            errors.push(`Failed to delete ${filePath}: ${String(err)}`);
          }
        }
      }

      this.tasks.delete(id);
      pruned++;
    }

    return { component: "bg-task-manager", pruned, retried: 0, bytesFreed, errors };
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }
}
