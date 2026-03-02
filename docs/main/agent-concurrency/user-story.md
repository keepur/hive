# User Story: Agent Concurrency

## Story

As a Hive operator, I want agents to handle multiple threads concurrently so that a long-running task in one thread doesn't block the agent from responding to other threads, cron jobs, or channel messages.

## Acceptance Criteria

1. Messages in different threads for the same agent process concurrently (not serialized)
2. Messages in the same thread still process sequentially (conversation continuity)
3. Per-agent concurrency is capped (default 3) to prevent runaway resource usage
4. Agent responses timeout after a configurable duration (default 5 min) instead of hanging forever
5. Health status shows active thread count per agent
6. Cron jobs (e.g., check-ci-failures) don't block user messages and vice versa

## Out of Scope

- Priority lanes (user messages vs cron jobs) — deferred, per-thread queuing already separates them
- MCP server pooling — each concurrent thread gets its own MCP servers for now
- Bash/filesystem concurrency controls
