import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import { parseClaudeOutput, detectEscalation, resolveTaskStatus } from "./output-parser.js";
import type { ClaudeCodeOutput, EscalationInfo } from "./output-parser.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import type { SweepResult } from "../sweeper/sweeper.js";

const log = createLogger("code-task-manager");
const RESULT_TAIL_CHARS = 2000;
const LOG_TAIL_LINES = 100;

export interface CodeTaskContext {
  agentId: string;
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
}

interface CodeTask {
  id: string;
  prompt: string;
  cwd: string;
  model: string;
  maxTurns: number;
  maxBudget: number;
  status: "running" | "completed" | "failed" | "needs_input" | "orphaned";
  exitCode: number | null;
  startedAt: string;
  completedAt: string | null;
  stdoutPath: string;
  stderrPath: string;
  metaPath: string;
  context: CodeTaskContext;
  pid: number | null;
  // Claude Code session tracking
  sessionId: string | null;
  costUsd: number;
  numTurns: number;
  escalation: EscalationInfo | null;
  // Resume chain — tracks parent task if this was spawned by code_respond
  parentTaskId: string | null;
}

export interface CodeTaskManagerOptions {
  /** Path to the claude CLI binary (default: "claude") */
  cliBin?: string;
}

export class CodeTaskManager {
  private port: number;
  private authToken: string;
  private pluginDir: string;
  private maxConcurrent: number;
  private tasksDir: string;
  private cliBin: string;
  private tasks = new Map<string, CodeTask>();
  private onComplete: (item: WorkItem) => void;
  private server: Server | null = null;
  private orphanPollers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    port: number,
    authToken: string,
    pluginDir: string,
    maxConcurrent: number,
    tasksDir: string,
    onComplete: (item: WorkItem) => void,
    options?: CodeTaskManagerOptions,
  ) {
    this.port = port;
    this.authToken = authToken;
    this.pluginDir = pluginDir;
    this.maxConcurrent = maxConcurrent;
    this.tasksDir = tasksDir;
    this.onComplete = onComplete;
    this.cliBin = options?.cliBin ?? "claude";
  }

  async start(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true });

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

    log.info("Code task manager started", { port: this.port });
  }

  async scanOrphans(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.tasksDir);
    } catch {
      return;
    }

    const jsonFiles = files.filter((f) => f.endsWith(".meta.json"));
    let orphaned = 0;
    let recovered = 0;

    for (const file of jsonFiles) {
      try {
        const content = await readFile(`${this.tasksDir}/${file}`, "utf-8");
        const task: CodeTask = JSON.parse(content);

        this.tasks.set(task.id, task);

        if (task.status === "running" && task.pid) {
          if (this.isProcessAlive(task.pid)) {
            this.pollOrphan(task.id, task.pid);
            recovered++;
          } else {
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
    for (const [, timer] of this.orphanPollers) {
      clearInterval(timer);
    }
    this.orphanPollers.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    log.info("Code task manager stopped");
  }

  // ── HTTP ────────────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${this.authToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // POST /tasks — spawn a new code task
    if (req.method === "POST" && url.pathname === "/tasks") {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await this.readBody(req));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      try {
        const task = await this.spawnTask(parsed as Parameters<typeof this.spawnTask>[0]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: task.id, status: "running" }));
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        const status = msg.includes("concurrency") ? 429 : 400;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // POST /tasks/:id/respond — resume a needs_input task
    const respondMatch = url.pathname.match(/^\/tasks\/([a-f0-9-]+)\/respond$/);
    if (req.method === "POST" && respondMatch) {
      const id = respondMatch[1];

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(await this.readBody(req));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      try {
        const task = await this.resumeTask(id, parsed.response as string, parsed.context as CodeTaskContext);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: task.id, status: "running", resumedFrom: id }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
      }
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
      const list = this.listTasks(agentId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tasks: list }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ── Spawn ───────────────────────────────────────────────────────────

  private async spawnTask(body: {
    prompt: string;
    cwd: string;
    model?: string;
    maxTurns?: number;
    maxBudget?: number;
    sessionId?: string;
    context: CodeTaskContext;
    parentTaskId?: string;
  }): Promise<CodeTask> {
    // Concurrency check
    const running = [...this.tasks.values()].filter((t) => t.status === "running").length;
    if (running >= this.maxConcurrent) {
      throw new Error(
        `Max concurrency reached (${this.maxConcurrent} running). Wait for a task to finish or increase the limit.`,
      );
    }

    const id = randomUUID();
    const stdoutPath = `${this.tasksDir}/${id}.stdout.json`;
    const stderrPath = `${this.tasksDir}/${id}.stderr.log`;
    const metaPath = `${this.tasksDir}/${id}.meta.json`;
    const cwd = body.cwd;
    const model = body.model ?? "";
    const maxTurns = body.maxTurns ?? 100;
    const maxBudget = body.maxBudget ?? 5.0;

    const args = this.buildArgs({
      prompt: body.prompt,
      maxTurns,
      maxBudget,
      model,
      sessionId: body.sessionId,
    });

    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");

    const child = spawn(this.cliBin, args, {
      cwd,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });

    // Attach listeners before closing fds to avoid missing immediate exits (ENOENT, etc.)
    child.on("exit", (code) => this.handleExit(id, code));
    child.on("error", (err) => {
      log.error("Code task process error", { id, error: String(err) });
      this.handleExit(id, 1);
    });

    closeSync(stdoutFd);
    closeSync(stderrFd);

    const task: CodeTask = {
      id,
      prompt: body.prompt.slice(0, 500), // truncate for metadata
      cwd,
      model,
      maxTurns,
      maxBudget,
      status: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      stdoutPath,
      stderrPath,
      metaPath,
      context: body.context,
      pid: child.pid ?? null,
      sessionId: body.sessionId ?? null,
      costUsd: 0,
      numTurns: 0,
      escalation: null,
      parentTaskId: body.parentTaskId ?? null,
    };

    this.tasks.set(id, task);
    await this.writeMeta(task);

    log.info("Code task spawned", {
      id,
      cwd,
      model: model || "(default)",
      maxTurns,
      maxBudget,
      pid: child.pid,
      agentId: body.context.agentId,
      parentTaskId: body.parentTaskId ?? null,
    });

    return task;
  }

  private buildArgs(params: {
    prompt: string;
    maxTurns: number;
    maxBudget: number;
    model: string;
    sessionId?: string;
  }): string[] {
    const args: string[] = [];

    if (params.sessionId) {
      // Resume an existing session
      args.push("--resume", params.sessionId, "-p", params.prompt);
    } else {
      args.push("-p", params.prompt);
    }

    args.push("--plugin-dir", this.pluginDir, "--output-format", "json", "--dangerously-skip-permissions");

    args.push("--max-turns", String(params.maxTurns));
    args.push("--max-budget-usd", String(params.maxBudget));

    if (params.model) {
      args.push("--model", params.model);
    }

    return args;
  }

  // ── Resume ──────────────────────────────────────────────────────────

  private async resumeTask(taskId: string, response: string, context?: CodeTaskContext): Promise<CodeTask> {
    const original = this.tasks.get(taskId);
    if (!original) throw new Error(`Task ${taskId} not found`);
    if (original.status !== "needs_input") {
      throw new Error(`Task ${taskId} is ${original.status}, not needs_input`);
    }
    if (!original.sessionId) {
      throw new Error(`Task ${taskId} has no session ID for resume`);
    }

    // Spawn a new task that resumes the original session
    return this.spawnTask({
      prompt: response,
      cwd: original.cwd,
      model: original.model,
      maxTurns: original.maxTurns,
      maxBudget: original.maxBudget,
      sessionId: original.sessionId,
      context: context ?? original.context,
      parentTaskId: taskId,
    });
  }

  // ── Exit handling ───────────────────────────────────────────────────

  private async handleExit(id: string, code: number | null): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;

    task.exitCode = code ?? 1;
    task.completedAt = new Date().toISOString();

    // Parse Claude Code output
    let output: ClaudeCodeOutput | null = null;
    try {
      const stdout = await readFile(task.stdoutPath, "utf-8");
      output = parseClaudeOutput(stdout);
    } catch {
      // stdout file missing or unreadable
    }

    if (output) {
      task.sessionId = output.sessionId;
      task.costUsd = output.costUsd;
      task.numTurns = output.numTurns;
    }

    // Detect escalation
    const escalation = output ? detectEscalation(output.result) : null;
    task.escalation = escalation;

    // Resolve status
    task.status = resolveTaskStatus(task.exitCode, output, escalation);

    await this.writeMeta(task);
    this.fireCompletion(task, output);
  }

  private fireCompletion(task: CodeTask, output?: ClaudeCodeOutput | null): void {
    const startTime = new Date(task.startedAt).getTime();
    const endTime = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
    const durationSec = ((endTime - startTime) / 1000).toFixed(1);

    const buildText = async (): Promise<string> => {
      if (task.status === "needs_input" && task.escalation) {
        // Escalation — needs Jasper's input
        const lines = [`[Code task needs input] Task \`${task.id}\` is waiting for a decision.`, ""];
        if (task.escalation.status === "BLOCKED") {
          lines.push(`**BLOCKED**: ${task.escalation.question || "No details provided."}`);
        } else {
          lines.push(`**Needs context**: ${task.escalation.question || "No details provided."}`);
        }
        if (task.escalation.context) {
          lines.push("", `Context: ${task.escalation.context}`);
        }
        lines.push(
          "",
          `Duration: ${durationSec}s | Cost: $${task.costUsd.toFixed(2)} | Turns: ${task.numTurns}`,
          "",
          `To respond: \`code_respond({ id: "${task.id}", response: "your answer" })\``,
        );
        return lines.join("\n");
      }

      if (task.status === "needs_input" && output?.subtype) {
        // Budget or turn limit hit
        const reason =
          output.subtype === "error_max_turns"
            ? `Hit max turns limit (${task.maxTurns})`
            : `Hit budget limit ($${task.maxBudget})`;
        return [
          `[Code task limit reached] Task \`${task.id}\` — ${reason}.`,
          `Duration: ${durationSec}s | Cost: $${task.costUsd.toFixed(2)} | Turns: ${task.numTurns}`,
          "",
          "The session can be resumed with additional budget/turns via `code_respond`.",
          "",
          `Result (last ${RESULT_TAIL_CHARS} chars):`,
          "```",
          (output.result || "(no output)").slice(-RESULT_TAIL_CHARS),
          "```",
        ].join("\n");
      }

      if (task.status === "completed") {
        const result = output?.result || "(no output)";
        return [
          `[Code task completed] Task \`${task.id}\` finished successfully.`,
          `Duration: ${durationSec}s | Cost: $${task.costUsd.toFixed(2)} | Turns: ${task.numTurns}`,
          "",
          `Result (last ${RESULT_TAIL_CHARS} chars):`,
          "```",
          result.slice(-RESULT_TAIL_CHARS),
          "```",
        ].join("\n");
      }

      // Failed or orphaned
      let logTail = "";
      try {
        const stderr = await readFile(task.stderrPath, "utf-8");
        const lines = stderr.split("\n");
        logTail = lines.slice(-LOG_TAIL_LINES).join("\n").trim();
      } catch {
        logTail = "(no stderr output)";
      }

      const resultSnippet = output?.result ? output.result.slice(-RESULT_TAIL_CHARS) : "";

      return [
        `[Code task ${task.status}] Task \`${task.id}\` exited with code ${task.exitCode ?? "unknown"}.`,
        `Duration: ${durationSec}s | Cost: $${task.costUsd.toFixed(2)} | Turns: ${task.numTurns}`,
        "",
        resultSnippet ? `Result:\n\`\`\`\n${resultSnippet}\n\`\`\`\n` : "",
        `Stderr (last ${LOG_TAIL_LINES} lines):`,
        "```",
        logTail || "(empty)",
        "```",
      ]
        .filter(Boolean)
        .join("\n");
    };

    buildText()
      .then((text) => {
        const completionItem: WorkItem = {
          id: `ct:${task.id}:done:${Date.now()}`,
          text,
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
            codeTaskId: task.id,
          },
        };

        log.info("Code task completed, dispatching notification", {
          id: task.id,
          status: task.status,
          exitCode: task.exitCode,
          costUsd: task.costUsd,
          numTurns: task.numTurns,
          durationSec,
          agentId: task.context.agentId,
          hasEscalation: !!task.escalation,
        });

        this.onComplete(completionItem);
      })
      .catch((err) => {
        log.error("Failed to fire completion notification", { id: task.id, error: String(err) });
      });
  }

  // ── Status / List ───────────────────────────────────────────────────

  private async taskStatus(id: string): Promise<Record<string, unknown> | null> {
    const task = this.tasks.get(id);
    if (!task) return null;

    let stderrTail = "";
    try {
      const content = await readFile(task.stderrPath, "utf-8");
      const lines = content.split("\n");
      stderrTail = lines.slice(-LOG_TAIL_LINES).join("\n").trim();
    } catch {
      // file not ready yet
    }

    return {
      id: task.id,
      status: task.status,
      exitCode: task.exitCode,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      cwd: task.cwd,
      model: task.model,
      costUsd: task.costUsd,
      numTurns: task.numTurns,
      sessionId: task.sessionId,
      escalation: task.escalation,
      parentTaskId: task.parentTaskId,
      stderrTail,
    };
  }

  private listTasks(agentId?: string): Array<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = [];

    for (const task of this.tasks.values()) {
      if (agentId && task.context.agentId !== agentId) continue;

      results.push({
        id: task.id,
        status: task.status,
        exitCode: task.exitCode,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        costUsd: task.costUsd,
        numTurns: task.numTurns,
        cwd: task.cwd,
        prompt: task.prompt,
      });
    }

    return results;
  }

  // ── Sweep ───────────────────────────────────────────────────────────

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

      for (const filePath of [task.metaPath, task.stdoutPath, task.stderrPath]) {
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

    return { component: "code-task-manager", pruned, retried: 0, bytesFreed, errors };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private async writeMeta(task: CodeTask): Promise<void> {
    try {
      await writeFile(task.metaPath, JSON.stringify(task, null, 2), "utf-8");
    } catch (err) {
      log.error("Failed to write task metadata", { id: task.id, error: String(err) });
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
