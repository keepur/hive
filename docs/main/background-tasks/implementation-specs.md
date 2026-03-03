# Implementation Specs: Background Task System

## Files to Create

### `src/background/background-task-manager.ts`

```typescript
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { createLogger } from "../logging/logger.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
```

**Class: BackgroundTaskManager**
- `constructor(port: number, onComplete: (item: WorkItem) => void)`
- `async start(): Promise<void>` — mkdir `/tmp/hive-bg-tasks`, create and listen HTTP server on `127.0.0.1:port`
- `async scanOrphans(): Promise<void>` — read `*.json` from tasks dir, probe PIDs, fire notifications for dead processes, poll alive ones
- `stop(): void` — close HTTP server, clear polling intervals
- `private handleRequest(req, res)` — route POST/GET, parse JSON body, extract `:id` from URL
- `private async spawnTask(body: CreateRequest): Promise<BackgroundTask>` — spawn detached, write metadata, listen for exit
- `private handleExit(id: string, code: number | null): void` — update metadata, read log tail, build WorkItem, call onComplete
- `private async taskStatus(id: string): Promise<StatusResponse>` — read metadata + tail log
- `private async listTasks(agentId?: string): Promise<ListResponse>` — filter in-memory map
- `private async writeMeta(task: BackgroundTask): Promise<void>` — write JSON to metaPath
- `private async tailLog(logPath: string, lines: number): Promise<string>` — read file, return last N lines

**Interfaces (defined in this file):**
```typescript
interface BackgroundTaskContext {
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
  startedAt: string;  // ISO 8601
  completedAt: string | null;
  logPath: string;
  metaPath: string;
  context: BackgroundTaskContext;
  pid: number | null;
}
```

**HTTP API:**
- `POST /tasks` — body: `{ command: string, cwd?: string, context: BackgroundTaskContext }` → response: `{ id: string, status: "running" }`
- `GET /tasks/:id` — response: `{ id, status, exitCode, startedAt, completedAt, output: string }`
- `GET /tasks?agentId=X` — response: `{ tasks: StatusResponse[] }`

**Completion WorkItem structure:**
```typescript
const item: WorkItem = {
  id: `bg:${task.id}:done:${Date.now()}`,
  text: [
    `[Background task ${task.status}] Task \`${task.id}\` finished with exit code ${task.exitCode}.`,
    `Command: \`${task.command}\``,
    `Duration: ${durationSec}s`,
    `Output (last ${LOG_TAIL_LINES} lines):`,
    "```",
    output || "(no output)",
    "```",
  ].join("\n"),
  source: {
    kind: task.context.channelKind as ChannelKind,
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
```

### `src/background/background-task-mcp-server.ts`

Follows MCP pattern from `src/keychain/keychain-mcp-server.ts`.

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
```

**Env vars read from `process.env`:**
- `BG_TASK_API` (e.g., `http://127.0.0.1:3100`)
- `BG_AGENT_ID`
- `BG_ADAPTER_ID`, `BG_CHANNEL_ID`, `BG_CHANNEL_KIND`, `BG_CHANNEL_LABEL`
- `BG_THREAD_ID`, `BG_SLACK_TS`, `BG_SLACK_THREAD_TS`

**Tools:**
1. `bg_execute` — input: `{ command: z.string(), cwd: z.string().optional() }` — POST /tasks with context built from env vars
2. `bg_status` — input: `{ id: z.string() }` — GET /tasks/:id
3. `bg_list` — no input — GET /tasks?agentId={BG_AGENT_ID}

**Helper:** `buildContext()` returns a `BackgroundTaskContext` from env vars.
**Helper:** `bgApi(method, path, body?)` wraps `fetch()` calls to the manager API.

---

## Files to Modify

### `src/config.ts`
Add after `scheduler` block (line 107):
```typescript
background: {
  port: parseInt(optional("BG_TASK_PORT", "3100"), 10),
},
```

### `src/agents/agent-runner.ts`

**Add interface** after line 10 (after `StreamCallback` type):
```typescript
export interface WorkItemContext {
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
}
```

**Modify `buildMcpServers`** (line 66): Add parameter `context?: WorkItemContext`. Before the guardrail filter (line 192), add:
```typescript
servers["background"] = {
  type: "stdio",
  command: "node",
  args: [resolve("dist/background/background-task-mcp-server.js")],
  env: {
    BG_TASK_API: `http://127.0.0.1:${config.background.port}`,
    BG_AGENT_ID: this.agentConfig.id,
    BG_ADAPTER_ID: context?.adapterId ?? "",
    BG_CHANNEL_ID: context?.channelId ?? "",
    BG_CHANNEL_KIND: context?.channelKind ?? "internal",
    BG_CHANNEL_LABEL: context?.channelLabel ?? "",
    BG_THREAD_ID: context?.threadId ?? "",
    BG_SLACK_TS: context?.slackTs ?? "",
    BG_SLACK_THREAD_TS: context?.slackThreadTs ?? "",
  },
};
```

**Modify `send`** (line 204): Add 4th parameter `context?: WorkItemContext`. Pass to buildMcpServers:
```typescript
const mcpServers = this.buildMcpServers(context);
```

### `src/agents/agent-manager.ts`

**Add import** at top:
```typescript
import type { WorkItemContext } from "./agent-runner.js";
```

**In `processThreadQueue`** (line 96-99): Extract context from WorkItem and pass to runner:
```typescript
const context: WorkItemContext = {
  adapterId: item.message.source.adapterId ?? item.message.source.kind,
  channelId: item.message.source.id,
  channelKind: item.message.source.kind,
  channelLabel: item.message.source.label,
  threadId: item.message.threadId ?? item.message.id,
  slackTs: (item.message.meta?.slackTs as string) ?? "",
  slackThreadTs: (item.message.meta?.slackThreadTs as string) ?? "",
};
const result = await runner.send(item.message.text, existingSession, item.onStream, context);
```

**Bug fix** (line 62): Replace `this.processThreadQueue(agentId, threadKey);` with:
```typescript
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
```

### `src/index.ts`

**Add import:**
```typescript
import { BackgroundTaskManager } from "./background/background-task-manager.js";
```

**After dispatcher creation** (after line 51):
```typescript
const bgTaskManager = new BackgroundTaskManager(
  config.background.port,
  (item) => dispatcher.dispatch(item).catch((err) => {
    log.error("Background task completion dispatch failed", { error: String(err) });
  }),
);
await bgTaskManager.start();
await bgTaskManager.scanOrphans();
log.info("Background task manager started", { port: config.background.port });
```

**Add to shutdown** (before `agentManager.stopAll()` on line 132):
```typescript
bgTaskManager.stop();
```

**Add before `main().catch()`** (before line 146):
```typescript
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", {
    error: String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
```

### `src/memory/memory-manager.ts`

**Modify `git` method** (line 79-81): Add timeout option:
```typescript
private async git(command: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`git -C "${this.repoPath}" ${command}`, { timeout: 30_000 });
}
```

### `agents-templates/vp-engineering/agent.yaml.tpl`

Add `- background` after line 33 (after `- keychain`).

### `agents-templates/vp-engineering/system-prompt.md.tpl`

Add after `## Your Tools` section (before `## Response Behavior`):
```markdown
## Background Tasks
For any operation that might take more than 30 seconds (tests, builds, deploys, git push):
1. Use `bg_execute` instead of running the command directly
2. Respond immediately ("Tests kicked off, I'll report back when they finish")
3. You'll receive a notification in this thread when the task completes
4. Process the results and respond

Never block yourself waiting for a long-running operation.
```

---

## Testing Requirements

1. **Build**: `npm run build` compiles clean
2. **HTTP smoke test**: `curl http://127.0.0.1:3100/tasks` returns `{"tasks":[]}`
3. **Task lifecycle**: POST a `sleep 5 && echo done` task, GET status during and after
4. **End-to-end**: Message Jasper "run the tests" — confirm bg_execute used, immediate response, completion notification in same thread
5. **Crash recovery**: Kill Hive mid-task, restart, confirm orphan detection
