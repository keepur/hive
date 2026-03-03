# Implementation Roadmap: Background Task System

## Design Summary

### Problem
Agents block on long-running tools (tests, deploys, builds). The Claude SDK runs bash tools synchronously within a query. A 5-minute timeout aborts the query, losing all work. The Hive process itself has deadlocked after abort-related bugs in the queue management.

### Solution
A two-component system: a **BackgroundTaskManager** running in the Hive host process (HTTP server + process spawner), and a **Background Task MCP Server** (stdio subprocess available to agents). Communication is via HTTP over loopback. Completion notifications route through the existing Dispatcher for proper Slack delivery.

### Key Technical Decisions
- **Local HTTP for IPC** (not Unix socket, not shared memory) — the MCP server is a separate process and can't share state with Hive. HTTP is simple, debuggable (`curl`), and reliable.
- **Context via env vars** — `buildMcpServers()` is called per-query inside `send()`, so env vars are fresh for each message. The MCP server reads Slack context from env vars and includes them in HTTP requests.
- **Completion via Dispatcher.dispatch()** — preserves full Slack delivery pipeline (adapter resolution, threading, audit logging). No special-casing needed.
- **Detached + no unref()** — the child process survives Hive abort (`detached: true`) but Hive still receives the `exit` event (no `unref()`).
- **File-based metadata** — `/tmp/hive-bg-tasks/{id}.json` for crash recovery. Scanned on startup.

## Implementation Phases

### Phase 1: Bug Fixes (no dependencies)
- Fix `processThreadQueue` deadlock in agent-manager.ts
- Add `unhandledRejection` handler in index.ts
- Add 30s timeout to git operations in memory-manager.ts

### Phase 2: Core Infrastructure (depends on Phase 1 for config.ts)
- Add `background.port` to config.ts
- Create BackgroundTaskManager (HTTP server, process spawning, completion notifications, crash recovery)
- Create Background Task MCP server (bg_execute, bg_status, bg_list)

### Phase 3: Wiring (depends on Phase 2)
- Add WorkItemContext to agent-runner.ts, wire into send() and buildMcpServers()
- Extract context in agent-manager.ts, pass to runner
- Instantiate and wire BackgroundTaskManager in index.ts

### Phase 4: Agent Configuration (depends on Phase 3)
- Add `background` to VP Engineering servers allowlist
- Add Background Tasks section to VP Engineering system prompt
- Regenerate agents from templates

## Risk Considerations

- **MCP server env vars on resumed sessions**: The SDK re-establishes MCP connections per `query()` call, even with `resume`. Env vars are fresh each time. Verified by reading agent-runner.ts — `buildMcpServers()` is called inside `send()`.
- **Concurrent background tasks**: Multiple tasks can run simultaneously. Each gets a unique ID and independent exit handler. The task map is keyed by ID, not agent.
- **Orphan detection false positive**: A PID could be reused by the OS after Hive restart. Mitigated by checking metadata timestamp — if the task started days ago and the PID is alive, it's likely reused. In practice, `/tmp` is cleared on reboot so stale metadata is gone.
