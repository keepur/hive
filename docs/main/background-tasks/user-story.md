# User Story: Background Task System

## Story

**As** a Hive agent (especially VP Engineering),
**I want** to kick off long-running shell commands as background tasks and get notified when they complete,
**So that** I can respond to the user immediately instead of blocking for minutes and risking timeout.

## Acceptance Criteria

1. Agent can call `bg_execute(command, cwd?)` MCP tool to spawn a detached background process
2. The tool returns a task ID immediately (~1ms), not after the command finishes
3. When the background process exits, a completion notification is automatically delivered to the agent on the same Slack thread
4. The agent can check task status and output via `bg_status(id)` at any time
5. The agent can list all its background tasks via `bg_list()`
6. Completion notifications include: exit code, command, duration, and last 100 lines of output
7. The completion response is delivered to the correct Slack thread via the correct Slack adapter
8. Background tasks survive Hive process aborts (detached processes)
9. On Hive restart, orphaned tasks are detected and completion notifications are fired
10. The VP Engineering system prompt instructs the agent to use `bg_execute` for operations >30 seconds

## Bug Fix Acceptance Criteria

11. `processThreadQueue()` failure no longer permanently deadlocks a thread's queue
12. Unhandled promise rejections are logged instead of silently disappearing
13. Hung git operations (push, pull) are killed after 30 seconds instead of blocking forever

## Out of Scope

- Task cancellation (kill a running background task) — future enhancement
- Task output streaming (real-time output to Slack) — future enhancement
- Persistent task history beyond `/tmp` (cleared on reboot) — acceptable for now
