# Implementation Roadmap: DodiHome Task Ledger

## Design Summary

- **Pattern:** Follows the existing `memory-mcp-server.ts` pattern — standalone stdio subprocess, `McpServer` from `@modelcontextprotocol/sdk`, env vars for config, raw `fetch()` for HTTP
- **No new dependencies:** Uses native `fetch()` and existing `@modelcontextprotocol/sdk` + `zod`
- **Conditional registration:** MCP server only spins up when `DODI_API_KEY` is set
- **Failure isolation:** All API calls are fire-and-forget with try/catch — never block agent responses

## Implementation Phases

### Phase 1: Config
- Add `dodi.apiUrl` and `dodi.apiKey` to `src/config.ts`
- Uses `optional()` helper — both have defaults (localhost:3002, empty string)

### Phase 2: Task MCP Server
- Create `src/dodi/task-mcp-server.ts` — standalone stdio MCP server
- 6 tools: task_create, task_get, task_update, task_list, task_add_comment, task_search
- Reads `DODI_API_URL` and `DODI_API_KEY` from env (passed by agent runner)

### Phase 3: Agent Runner Registration
- Register "tasks" MCP server in `buildMcpServers()` when API key is configured
- Passes env vars to subprocess

### Phase 4: Task Client + Index Wiring
- Create `src/dodi/task-client.ts` — thin HTTP client for main-process use
- Instantiate in `src/index.ts` — ready for dispatcher when it's built

## Dependencies

- dodi_v2 REST API (can build against contract, test once deployed)
- Multi-channel dispatcher (Phase 4 dispatcher integration deferred)

## Risks

- Thread-to-task map will be in-memory (resets on restart) — acceptable for v1
- dodi_v2 API contract may evolve — thin client makes changes easy
