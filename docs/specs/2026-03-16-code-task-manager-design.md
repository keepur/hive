# Code Task Manager — Design Spec

**Date**: 2026-03-16
**Status**: Draft

## Problem

Jasper (VP Engineering) must simultaneously follow a multi-step dev process AND write production-quality code. These are two different cognitive loads competing for the same context window:

- **Process**: pick up ticket, create worktree, write plan, dispatch implementers, run quality gate, review, create PR, wait for CI, merge
- **Code**: understand the codebase, find the right files, write correct TypeScript, run tests, debug failures

Result: Jasper either follows process and writes bad code, or writes decent code and skips process steps. Context overload causes hallucinated tool calls — claiming actions happened when they didn't.

The dodi-dev skills (`pickup`, `write-plan`, `implement`, `review`, `submit`) already encode the correct process. Claude Code already knows how to write code. The problem is asking one agent to do both.

## Solution

**Split Jasper into two loops:**

| Loop | Role | Runs as |
|------|------|---------|
| **Outer (Jasper)** | Orchestrator — follows process, delegates coding, handles escalations, reports status | Hive agent (Slack) |
| **Inner (Claude Code)** | Executor — writes code, runs tests, commits, follows CLAUDE.md conventions | Claude Code CLI session |

A new **CodeTaskManager** (modeled on BackgroundTaskManager) manages Claude Code sessions as long-running background tasks. A new **code-task MCP server** gives Jasper three tools to control them.

### What the Inner Session Gets Automatically

When Claude Code spawns with `cwd` set to a dodi_v2 worktree:

- **CLAUDE.md** — project conventions, architecture, commands, patterns (auto-loaded)
- **DEVELOPMENT-PROCESS.md** — referenced from CLAUDE.md (agent reads on first task)
- **Project skills** (`.claude/skills/`) — `/quality-gate`, `/create-tests`, `/meteor-compliance`, `/dev-servers`, etc.
- **dodi-dev plugin skills** — `dodi-dev:implement`, `dodi-dev:review`, `dodi-dev:submit`, etc. (loaded via `--plugin-dir`)
- **MCP servers** — Linear, etc. (loaded via `--mcp-config` if needed)

No special wiring needed for any of this — it's how Claude Code works.

## Architecture

```
Slack message ("pick up DOD-250")
  → Jasper (Hive agent, outer loop)
    → code_task({ prompt, worktree, ... })
      → CodeTaskManager (HTTP, like BackgroundTaskManager)
        → spawns: claude -p "..." --plugin-dir dodi-dev [flags]
          → Claude Code session (inner loop)
            ├── auto-loads CLAUDE.md, project skills, plugin skills
            ├── writes code, runs tests, commits
            ├── needs decision? → reports NEEDS_CONTEXT/BLOCKED status → exits
            └── done? → exits with code 0
        → on exit:
          ├── success + no escalation markers: completion WorkItem → Jasper's thread
          ├── escalation markers in output: escalation WorkItem → Jasper's thread
          └── failure: failure WorkItem → Jasper's thread
      ← Jasper sees result, decides next step
```

### Key Design Decision: CLI, Not SDK

The Agent SDK (`query()`) would give us in-process hooks and streaming, but:

1. **Claude Code CLI already handles skills, plugins, CLAUDE.md, permissions** — the SDK would require reimplementing all of this
2. **Process isolation** — a runaway Claude Code session can't crash Hive
3. **The BackgroundTaskManager pattern already works** — proven for fire-and-forget subprocesses with completion notifications
4. **Simplicity** — spawning `claude -p` with `child_process.spawn()` and an args array is 20 lines of code, not a new subsystem

The CLI gives us everything we need. What it doesn't give us (mid-session hooks) we handle differently — see Escalation below.

## MCP Server Tools

### `code_task` — Start a Claude Code session

Spawns a Claude Code CLI session as a detached background process.

```typescript
{
  name: "code_task",
  inputSchema: {
    type: "object",
    properties: {
      prompt:       { type: "string", description: "What to do (task description, plan reference, etc.)" },
      cwd:          { type: "string", description: "Working directory (worktree path)" },
      allowedTools: { type: "array", items: { type: "string" }, description: "Tools to pre-approve (default: Read,Write,Edit,Bash,Glob,Grep,Agent)" },
      maxTurns:     { type: "number", description: "Max agentic turns (default: 100)" },
      maxBudget:    { type: "number", description: "Max spend in USD (default: 5.00)" },
      model:        { type: "string", description: "Model override (default: from config)" },
      sessionId:    { type: "string", description: "Resume a previous session (for responding to escalations)" },
    },
    required: ["prompt", "cwd"]
  }
}
```

Returns immediately with task ID.

### `code_status` — Check session progress

```typescript
{
  name: "code_status",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Task ID" }
    },
    required: ["id"]
  }
}
```

Returns: status (`running`, `completed`, `failed`, `needs_input`, `orphaned`), exit code, duration, last N lines of output, escalation details (if `needs_input`).

### `code_respond` — Resume a session waiting for input

```typescript
{
  name: "code_respond",
  inputSchema: {
    type: "object",
    properties: {
      id:       { type: "string", description: "Task ID of the waiting session" },
      response: { type: "string", description: "Answer to the session's question" },
    },
    required: ["id", "response"]
  }
}
```

Resumes the Claude Code session with the response injected as a follow-up prompt via `claude --resume <sessionId> -p "<response>"`.

## Escalation: The Hard Problem

### Why This Is Hard

Claude Code's `--print` mode runs to completion. There's no mid-execution "pause and ask." Every existing implementation (steipete/claude-code-mcp, jefest-mcp, etc.) either:
- Runs to completion or fails (no escalation)
- Uses `--dangerously-skip-permissions` and hopes for the best

### Our Approach: Exit-and-Resume

Instead of trying to pause mid-session, we use Claude Code's **session resumption**:

1. **Inner session hits a decision point** — the dodi-dev skills already define escalation statuses: `BLOCKED`, `NEEDS_CONTEXT`. The implementer subagent prompt says: "If something is too hard or unclear, STOP and escalate."

2. **Session exits with structured output** — the inner session's final message contains the escalation:
   ```
   Status: NEEDS_CONTEXT
   Question: The plan says to modify ProjectController but there are two versions...
   Context: [relevant details]
   ```

3. **CodeTaskManager parses the output** — detects escalation status in the output text, sets task status to `needs_input`, fires a WorkItem back to Jasper's thread.

4. **Jasper sees the escalation** — reads the question, thinks about it, calls `code_respond(taskId, "use the v2 controller at src/modules/project/api/v2/...")`.

5. **CodeTaskManager resumes the session** — spawns `claude --resume <sessionId> -p "<response>"`. The inner session continues with full prior context.

### Escalation Detection

Claude Code with `--output-format json` returns:

```json
{
  "session_id": "uuid",
  "result": "final text output",
  "subtype": "success" | "error_max_turns" | "error_max_budget_usd",
  "total_cost_usd": 0.42,
  "duration_ms": 12345
}
```

The manager scans `result` for structured markers:
- `Status: NEEDS_CONTEXT` or `Status: BLOCKED` → task status becomes `needs_input`
- `subtype: "error_max_turns"` → budget/complexity escalation
- `subtype: "error_max_budget_usd"` → cost escalation
- Any other non-zero exit → `failed`

These markers already exist in the dodi-dev skill ecosystem. The implementer prompt requires agents to report status as `DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`. We're just reading what's already there.

### What Gets Escalated to Jasper

- **NEEDS_CONTEXT** — "I need more information to proceed" → Jasper provides context, resumes
- **BLOCKED** — "I can't do this, here's why" → Jasper reassesses (break task smaller, different model, escalate to May)
- **Permission/judgment calls** — "Should I refactor X or patch it?" → Jasper decides
- **Failures after retries** — tests fail 3 times → Jasper investigates
- **Budget/turn limits hit** — session ran out of runway

### What Gets Escalated to May (via Jasper)

- Architectural decisions beyond Jasper's scope
- Multiple tasks blocked on the same issue (systemic problem)
- Budget concerns (aggregate cost trending high)

## CodeTaskManager

Modeled directly on `BackgroundTaskManager`. Lives at `src/code-task/code-task-manager.ts`.

### State Machine

```
                 ┌─ code_respond ─┐
                 ▼                │
spawned → running → completed     │
              │    → failed       │
              │    → needs_input ─┘
              │    → orphaned
              └─── (timeout) → failed
```

### Differences from BackgroundTaskManager

| Aspect | BackgroundTaskManager | CodeTaskManager |
|--------|----------------------|-----------------|
| What it spawns | Any command | `claude` CLI only |
| Output parsing | Raw text (last 100 lines) | Structured: detects escalation markers, extracts session ID, cost |
| Resumption | None | `code_respond` → `claude --resume` |
| Status states | running/completed/failed/orphaned | + `needs_input` |
| Session tracking | None | Captures Claude Code `session_id` from JSON output for resume |
| Cost tracking | None | Extracts `total_cost_usd` from JSON output |

### Spawn Implementation

Uses `child_process.spawn()` with args array (no shell — per DOD-212 security requirements):

```typescript
private buildArgs(params: CodeTaskParams): string[] {
  const args = [
    "-p", params.prompt,
    "--plugin-dir", this.pluginDir,  // e.g. ~/github/hive/plugins/claude-code/dodi-dev
    "--output-format", "json",
    "--max-turns", String(params.maxTurns ?? 100),
    "--max-budget-usd", String(params.maxBudget ?? 5.0),
    "--permission-mode", "auto",
  ];

  if (params.allowedTools?.length) {
    args.push("--allowedTools", params.allowedTools.join(","));
  }

  if (params.model) {
    args.push("--model", params.model);
  }

  if (params.sessionId) {
    args.push("--resume", params.sessionId);
  }

  return args;
}
```

Spawned via `spawn("claude", args, { cwd: worktreePath, detached: true, stdio: [...] })` — same `detached: true` pattern as BackgroundTaskManager for process isolation.

### Output Handling

Unlike BackgroundTaskManager (which pipes both stdout and stderr to the same log file), CodeTaskManager separates them:

- **stdout** → captured to `<id>.stdout.json` — this is the structured JSON result
- **stderr** → captured to `<id>.stderr.log` — this is Claude Code's progress/debug output

On exit, the manager reads `stdout.json`, parses it, extracts `session_id`, `result`, `total_cost_usd`, and `subtype`. Then scans `result` for escalation markers.

### Completion WorkItem Format

```
[Code task completed] Task `<id>` finished successfully.
Ticket: DOD-250
Duration: 2m 34s | Cost: $0.42 | Turns: 23

Result:
<truncated result text, last 2000 chars>
```

### Escalation WorkItem Format

```
[Code task needs input] Task `<id>` is waiting for a decision.

Question: The plan references a ProjectController but there are two versions...

Context:
<relevant context from the session>

To respond: code_respond({ id: "<id>", response: "your answer" })
```

## Configuration

In `hive.yaml`:

```yaml
codeTask:
  pluginDir: ~/github/hive/plugins/claude-code/dodi-dev
  defaultModel: claude-sonnet-4-6
  defaultMaxTurns: 100
  defaultMaxBudget: 5.00
  defaultAllowedTools:
    - Read
    - Write
    - Edit
    - Bash
    - Glob
    - Grep
    - Agent
    - Skill
```

In `config.ts`:

```typescript
codeTask: {
  port: parseInt(optional("CODE_TASK_PORT", "3102"), 10),
  authToken: optional("CODE_TASK_AUTH_TOKEN", "") || randomUUID(),
  pluginDir: optional("CODE_TASK_PLUGIN_DIR", resolve("plugins/claude-code/dodi-dev")),
  defaultModel: optional("CODE_TASK_MODEL", "claude-sonnet-4-6"),
  defaultMaxTurns: parseInt(optional("CODE_TASK_MAX_TURNS", "100"), 10),
  defaultMaxBudget: parseFloat(optional("CODE_TASK_MAX_BUDGET", "5.00")),
},
```

## Wiring

### index.ts

```typescript
const codeTaskManager = new CodeTaskManager(
  config.codeTask.port,
  config.codeTask.authToken,
  config.codeTask.pluginDir,
  (item) => dispatcher.dispatch(item),
);
await codeTaskManager.start();
await codeTaskManager.scanOrphans();

sweeper.register("code-task-manager", (ttl) => codeTaskManager.sweep(ttl));
```

### agent-runner.ts — buildMcpServers()

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

### Agent Config — vp-engineering agent.yaml

Add `code-task` to Jasper's `servers` list:

```yaml
servers:
  - memory
  - conversation-search
  - slack
  - brave-search
  - linear
  - keychain
  - background
  - callback
  - google-workspace
  - code-task
```

## Jasper's New Workflow

Jasper's system prompt changes from "write code yourself" to "orchestrate Claude Code sessions":

### Typical Flow

1. **Pick up ticket** — read Linear issue, understand requirements
2. **Create worktree** — `git worktree add ../dodi_v2-DOD-250 -b DOD-250`
3. **Start coding session:**
   ```
   code_task({
     prompt: "You are working on DOD-250: <title>. <description>. Follow the dodi-dev workflow: write a plan, implement, run quality gate, review, and submit a PR.",
     cwd: "/Users/mokie/dev/dodi_v2-DOD-250"
   })
   ```
4. **Wait for result** — notified in-thread when done
5. **Handle escalations** — if session needs input, provide it via `code_respond`
6. **Report back** — update Linear, tell the team

### What Jasper Stops Doing

- Writing code directly
- Running builds or tests
- Trying to remember CLAUDE.md conventions
- Managing git commits within implementation

## File Structure

```
src/code-task/
├── code-task-manager.ts       # HTTP server, spawns/manages claude sessions
├── code-task-mcp-server.ts    # MCP interface (3 tools)
├── output-parser.ts           # Parse Claude Code JSON output, detect escalations
└── code-task-manager.test.ts  # Tests
```

## Security

- **No `--dangerously-skip-permissions`** — use `--permission-mode auto` with `--allowedTools` whitelist instead
- **Bearer token auth** on all HTTP endpoints (same pattern as BackgroundTaskManager)
- **Loopback only** — HTTP server on 127.0.0.1
- **Per-agent isolation** — tasks tagged with agent ID
- **Budget cap** — `--max-budget-usd` prevents runaway spend
- **Turn cap** — `--max-turns` prevents infinite loops
- **No shell injection** — `spawn("claude", argsArray)`, never shell strings

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Claude Code CLI not installed on deploy machine | Pre-flight check at startup, log error if missing |
| Session resume fails (context too old) | Detect failure, fire escalation with full context for fresh start |
| Inner session ignores dodi-dev skills | CLAUDE.md references DEVELOPMENT-PROCESS.md; skills auto-load via `--plugin-dir` |
| Cost overrun | Per-task budget cap + aggregate tracking per ticket |
| Orphaned sessions (Hive restarts) | Same orphan recovery pattern as BackgroundTaskManager |
| Plugin dir path differs dev vs deploy | Configured in hive.yaml, not hardcoded |
| ANTHROPIC_API_KEY needed for CLI | Must be set in deploy env — separate from Hive's subscription auth |

## Prior Art

- **steipete/claude-code-mcp** (1.2k stars) — single `claude_code` tool, no escalation, no resume. We extend this pattern significantly.
- **claude-code-mcp-enhanced** — adds "boomerang" parent-child tracking, heartbeats, retries. Closer to our design but still no session resume.
- **jefest-mcp** — 3-tier contract-based model (Opus plans → orchestrator → Sonnet executes in worktrees). Similar philosophy but uses structured documents, not exit-and-resume.
- **Hive's BackgroundTaskManager** — direct architectural ancestor. We reuse spawn, lifecycle, orphan recovery, and completion-via-dispatcher patterns.

## Open Questions

1. **Should the inner session get a Linear MCP?** Pro: can read tickets directly. Con: more tools = more context. Leaning: yes, pass `--mcp-config` with Linear only.

2. **Streaming progress to Slack?** CLI supports `--output-format stream-json`. We could pipe and post periodic updates. Leaning: not in v1, add if sessions feel "silent."

3. **Per-ticket cost aggregation** — track cumulative cost across resume cycles for budget alerting?

4. **Concurrent sessions** — Jasper might run sessions on multiple tickets. Should we cap concurrency? Leaning: allow 2-3 concurrent, configurable.

5. **Auth model for CLI** — deploy machine currently uses subscription auth (LaunchAgent/GUI session). Claude Code CLI may need `ANTHROPIC_API_KEY` instead. Need to verify.

## Out of Scope (v1)

- Agent SDK integration (hooks, in-process MCP servers)
- Streaming progress to Slack
- Automatic retry on transient failures
- Multi-repo sessions (only dodi_v2 for now)
- Other agents using code-task (Jasper only for now)
