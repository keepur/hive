# User Story: DodiHome Task Ledger Integration

## User Story

**As** the business owner,
**I want** Hive agents to log their work as tasks in dodi_v2 (DodiHome),
**So that** I have a single task board — next to customers, jobs, and production data — showing everything agents are working on and have completed.

## Acceptance Criteria

1. Agents can create, read, update, query, and comment on dodi_v2 tasks via MCP tools
2. A standalone MCP server connects agents to the dodi_v2 REST API
3. A reusable HTTP client (`DodiTaskClient`) exists for main-process use (dispatcher, future integrations)
4. Config supports `DODI_API_URL` and `DODI_API_KEY` env vars with sensible defaults
5. MCP server only registers when `DODI_API_KEY` is configured
6. All dodi_v2 API failures are non-fatal — agent responses are never blocked

## Out of Scope

- Dispatcher integration (no `src/channels/dispatcher.ts` exists yet — will be wired when the multi-channel dispatcher is built)
- Replacing the Slack audit log (dual-write once dispatcher exists)
- dodi_v2 REST API implementation (separate Linear issue under DodiHome team)
