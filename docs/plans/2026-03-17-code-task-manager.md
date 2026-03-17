# Code Task Manager — Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Goal:** Add a CodeTaskManager that spawns Claude Code CLI sessions as background coding tasks, with escalation support via session resume.

**Architecture:** New `src/code-task/` module with HTTP manager + MCP server, following the exact BackgroundTaskManager pattern. Wired into index.ts, sweeper, and agent-runner. Jasper gets the `code-task` MCP server.

**Tech Stack:** TypeScript, Node HTTP, MCP SDK (`@modelcontextprotocol/sdk`), zod, child_process.spawn

**Spec:** `docs/specs/2026-03-16-code-task-manager-design.md`

---

### Task 1: Output Parser

**Files:**
- Create: `src/code-task/output-parser.ts`

No dependencies — pure functions, easy to test in isolation.

- [ ] **Step 1:** Create the output parser module

```typescript
// src/code-task/output-parser.ts

export interface ClaudeCodeOutput {
  sessionId: string | null;
  result: string;
  subtype: string; // "success" | "error_max_turns" | "error_max_budget_usd" | ...
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}

export interface EscalationInfo {
  status: "NEEDS_CONTEXT" | "BLOCKED";
  question: string;
  context: string;
}

/**
 * Parse Claude Code JSON output from stdout.
 * Returns null if output is not valid JSON or not a Claude Code result.
 */
export function parseClaudeOutput(stdout: string): ClaudeCodeOutput | null {
  // Parse JSON, extract fields, handle malformed output
}

/**
 * Scan the result text for dodi-dev escalation markers.
 * Returns null if no escalation detected.
 */
export function detectEscalation(result: string): EscalationInfo | null {
  // Look for "Status: NEEDS_CONTEXT" or "Status: BLOCKED" patterns
  // Extract the question and context that follows
}

/**
 * Determine the task status from parsed output.
 */
export function resolveTaskStatus(
  exitCode: number | null,
  output: ClaudeCodeOutput | null,
  escalation: EscalationInfo | null,
): "completed" | "failed" | "needs_input" {
  // escalation detected → needs_input
  // exit 0 + success subtype → completed
  // error_max_turns or error_max_budget_usd → needs_input (budget/turn escalation)
  // everything else → failed
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit src/code-task/output-parser.ts`
Expected: clean compilation

- [ ] **Step 3:** Commit

```bash
git add src/code-task/output-parser.ts
git commit -m "feat(code-task): add Claude Code output parser with escalation detection"
```

---

### Task 2: CodeTaskManager

**Files:**
- Create: `src/code-task/code-task-manager.ts`

The HTTP server that spawns and manages Claude Code sessions. Direct adaptation of BackgroundTaskManager with: separate stdout/stderr capture, output parsing, `needs_input` state, session resume, cost tracking, concurrency limit.

- [ ] **Step 1:** Create the manager

Key differences from BackgroundTaskManager:
- `CodeTask` interface adds: `sessionId`, `costUsd`, `escalation`, `prompt` fields
- Status includes `"needs_input"` in addition to running/completed/failed/orphaned
- `spawnTask()` separates stdout (JSON) and stderr (log) into different files
- `handleExit()` calls output parser, detects escalations, sets appropriate status
- `fireCompletion()` formats differently for completion vs escalation vs failure
- New `resumeTask()` method for `code_respond` — spawns `claude --resume <sessionId> -p <response>`
- Concurrency check in `spawnTask()` — reject if at max concurrent running tasks
- `buildArgs()` constructs the CLI arguments per spec

HTTP routes:
- `POST /tasks` — spawn new task (same as bg)
- `GET /tasks/:id` — get status (same as bg, plus escalation info)
- `GET /tasks?agentId=` — list tasks (same as bg)
- `POST /tasks/:id/respond` — resume a needs_input task (NEW)

Constructor: `(port, authToken, pluginDir, maxConcurrent, onComplete)`

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit src/code-task/code-task-manager.ts`
Expected: clean compilation

- [ ] **Step 3:** Commit

```bash
git add src/code-task/code-task-manager.ts
git commit -m "feat(code-task): add CodeTaskManager — spawns and manages Claude Code sessions"
```

---

### Task 3: MCP Server

**Files:**
- Create: `src/code-task/code-task-mcp-server.ts`

Thin stdio MCP server — proxies to CodeTaskManager via HTTP. Follow the exact pattern of `background-task-mcp-server.ts`.

- [ ] **Step 1:** Create the MCP server

Three tools:
- `code_task` — POST /tasks, returns task ID
- `code_status` — GET /tasks/:id, returns status + output + escalation
- `code_respond` — POST /tasks/:id/respond, returns resume confirmation

Env vars: `CT_TASK_API`, `CT_AUTH_TOKEN`, `CT_AGENT_ID`, `CT_ADAPTER_ID`, `CT_CHANNEL_ID`, `CT_CHANNEL_KIND`, `CT_CHANNEL_LABEL`, `CT_THREAD_ID`, `CT_SLACK_TS`, `CT_SLACK_THREAD_TS`

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit src/code-task/code-task-mcp-server.ts`
Expected: clean compilation

- [ ] **Step 3:** Commit

```bash
git add src/code-task/code-task-mcp-server.ts
git commit -m "feat(code-task): add code-task MCP server with 3 tools"
```

---

### Task 4: Config + Wiring

**Files:**
- Modify: `src/config.ts` — add `codeTask` section
- Modify: `src/index.ts` — construct CodeTaskManager, start, scanOrphans, shutdown
- Modify: `src/sweeper/sweeper.ts` — add to SweeperTargets, add sweep step
- Modify: `src/agents/agent-runner.ts` — add `code-task` MCP server entry in buildMcpServers()

- [ ] **Step 1:** Add config

In `src/config.ts`, add after the `background` block:

```typescript
codeTask: {
  port: parseInt(optional("CODE_TASK_PORT", "3102"), 10),
  authToken: optional("CODE_TASK_AUTH_TOKEN", "") || randomUUID(),
  pluginDir: optional("CODE_TASK_PLUGIN_DIR", resolve("plugins/claude-code/dodi-dev")),
  defaultModel: optional("CODE_TASK_MODEL", "claude-sonnet-4-6"),
  defaultMaxTurns: parseInt(optional("CODE_TASK_MAX_TURNS", "100"), 10),
  defaultMaxBudget: parseFloat(optional("CODE_TASK_MAX_BUDGET", "5.00")),
  maxConcurrent: parseInt(optional("CODE_TASK_MAX_CONCURRENT", "2"), 10),
},
```

- [ ] **Step 2:** Wire in index.ts

After bgTaskManager setup (~line 83), add:

```typescript
const codeTaskManager = new CodeTaskManager(
  config.codeTask.port,
  config.codeTask.authToken,
  config.codeTask.pluginDir,
  config.codeTask.maxConcurrent,
  (item) => dispatcher.dispatch(item).catch((err) => {
    log.error("Code task completion dispatch failed", { error: String(err) });
  }),
);
await codeTaskManager.start();
await codeTaskManager.scanOrphans();
log.info("Code task manager started", { port: config.codeTask.port });
```

Add `codeTaskManager` to SweeperTargets construction. Add `codeTaskManager.stop()` to shutdown.

- [ ] **Step 3:** Add to sweeper

In `SweeperTargets` interface, add `codeTaskManager?: CodeTaskManager`. In `sweep()`, add a step after the bgTaskManager sweep (step 4.5):

```typescript
if (this.targets.codeTaskManager) {
  try {
    results.push(await this.targets.codeTaskManager.sweep(this.config.taskFileTtlMs));
  } catch (err) {
    results.push({ component: "code-task-manager", pruned: 0, retried: 0, bytesFreed: 0, errors: [String(err)] });
  }
}
```

- [ ] **Step 4:** Add MCP server to agent-runner

In `buildMcpServers()`, add after the `callback` server block:

```typescript
servers["code-task"] = {
  type: "stdio",
  command: "node",
  args: [resolve("dist/code-task/code-task-mcp-server.js")],
  env: {
    CT_TASK_API: `http://127.0.0.1:${config.codeTask.port}`,
    CT_AUTH_TOKEN: config.codeTask.authToken,
    CT_AGENT_ID: this.agentConfig.id,
    CT_ADAPTER_ID: context?.adapterId ?? "",
    CT_CHANNEL_ID: context?.channelId ?? "",
    CT_CHANNEL_KIND: context?.channelKind ?? "internal",
    CT_CHANNEL_LABEL: context?.channelLabel ?? "",
    CT_THREAD_ID: context?.threadId ?? "",
    CT_SLACK_TS: context?.slackTs ?? "",
    CT_SLACK_THREAD_TS: context?.slackThreadTs ?? "",
  },
};
```

- [ ] **Step 5:** Verify

Run: `npm run typecheck`
Expected: clean

- [ ] **Step 6:** Commit

```bash
git add src/config.ts src/index.ts src/sweeper/sweeper.ts src/agents/agent-runner.ts
git commit -m "feat(code-task): wire CodeTaskManager into config, index, sweeper, and agent-runner"
```

---

### Task 5: Agent Config

**Files:**
- Modify: `agents-templates/vp-engineering/agent.yaml.tpl` — add `code-task` to servers

- [ ] **Step 1:** Add `code-task` to Jasper's server list

Add `- code-task` to the `servers` array.

- [ ] **Step 2:** Regenerate agents

Run: `npm run setup:agents`
Expected: `agents/vp-engineering/agent.yaml` includes `code-task` in servers

- [ ] **Step 3:** Commit

```bash
git add agents-templates/vp-engineering/agent.yaml.tpl
git commit -m "feat(code-task): add code-task server to Jasper's agent config"
```

---

### Task 6: Tests

**Files:**
- Create: `src/code-task/code-task-manager.test.ts`

- [ ] **Step 1:** Write tests

Cover:
- `parseClaudeOutput()` — valid JSON, malformed JSON, missing fields
- `detectEscalation()` — NEEDS_CONTEXT, BLOCKED, no escalation, partial matches
- `resolveTaskStatus()` — all status combinations
- CodeTaskManager HTTP API — spawn, status, list, respond (mock the `claude` binary)
- Concurrency limit enforcement
- Orphan recovery

- [ ] **Step 2:** Verify

Run: `npm run test -- --run src/code-task/`
Expected: all tests pass

- [ ] **Step 3:** Commit

```bash
git add src/code-task/code-task-manager.test.ts
git commit -m "test(code-task): add tests for output parser and CodeTaskManager"
```

---

### Task 7: Quality Gate

- [ ] **Step 1:** Run full check

Run: `npm run check`
Expected: typecheck + lint + format + test all pass

- [ ] **Step 2:** Fix any issues found

- [ ] **Step 3:** Final commit if needed
