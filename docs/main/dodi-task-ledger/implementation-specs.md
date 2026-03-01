# Implementation Specs: DodiHome Task Ledger

## Files to Modify

### `src/config.ts`
Add `dodi` block after `linear`:
```typescript
dodi: {
  apiUrl: optional("DODI_API_URL", "http://localhost:3002"),
  apiKey: optional("DODI_API_KEY", ""),
},
```

### `src/agents/agent-runner.ts`
In `buildMcpServers()`, after the memory server block, add:
```typescript
if (config.dodi.apiKey) {
  servers["tasks"] = {
    type: "stdio",
    command: "node",
    args: [resolve("dist/dodi/task-mcp-server.js")],
    env: {
      DODI_API_URL: config.dodi.apiUrl,
      DODI_API_KEY: config.dodi.apiKey,
    },
  };
}
```

### `src/index.ts`
Import and instantiate `DodiTaskClient`:
```typescript
import { DodiTaskClient } from "./dodi/task-client.js";
const taskClient = new DodiTaskClient(config.dodi.apiUrl, config.dodi.apiKey);
```
Ready for future dispatcher wiring.

## Files to Create

### `src/dodi/task-mcp-server.ts`
Standalone stdio MCP server (follows memory-mcp-server.ts pattern exactly).

**Env vars:** `DODI_API_URL`, `DODI_API_KEY`

**Helper function:**
```typescript
async function api(method: string, path: string, body?: object): Promise<any>
```
- Builds URL from `DODI_API_URL/api{path}`
- Sets `X-API-Key` header
- Sets `Content-Type: application/json` when body present
- Throws on non-ok response

**Tools (6 total):**

| Tool | Method | Path | Input |
|------|--------|------|-------|
| task_create | POST | /tasks | name, description?, type?, priority?, jobIds?, assignedTo?, dueDate? |
| task_get | GET | /tasks/:id | taskId |
| task_update | PUT | /tasks/:id | taskId, state?, priority?, assignedTo?, description?, dueDate? |
| task_list | GET | /tasks?params | state?, type?, assignedTo?, limit? |
| task_add_comment | POST | /tasks/:id/comments | taskId, body |
| task_search | GET | /tasks?q= | query, limit? |

**Type enums:**
- Task type: FOLLOW_UP, ACTION_ITEM, QA, FABRICATION, ASSEMBLY, PURCHASING, LOGISTICS
- Task state: TODO, IN_PROGRESS, BLOCKED, PAUSED, DONE
- Priority: 1=Back Burner, 2=Low, 3=Normal, 4=High, 5=Urgent

### `src/dodi/task-client.ts`
Thin HTTP client for main-process use (not MCP — direct calls).

```typescript
export class DodiTaskClient {
  constructor(apiUrl: string, apiKey: string)
  get isConfigured(): boolean  // true if apiKey is non-empty
  async createTask(input): Promise<{ _id: string } | null>
  async updateTask(taskId, input): Promise<boolean>
  async addComment(taskId, body): Promise<boolean>
}
```

- Uses `createLogger("dodi-task-client")` for logging
- All methods: try/catch, log errors, return null/false on failure, never throw

## Testing

1. `npm run build` — verify no compilation errors
2. Standalone MCP test: `DODI_API_URL=http://localhost:3002 DODI_API_KEY=xxx node dist/dodi/task-mcp-server.js`
3. Integration: start Hive, ask agent to "list my tasks"
