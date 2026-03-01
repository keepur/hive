# Linear Integration — Implementation Specs

## Files to Create or Modify

| File | Action | Phase |
|------|--------|-------|
| `src/config.ts` | Modify | 1 |
| `src/linear/linear-client.ts` | Create | 1 |
| `src/linear/linear-mcp-server.ts` | Create | 2 |
| `src/agents/agent-runner.ts` | Modify | 3 |

---

## Phase 1: Config + LinearClient

### 1.1 Config Change (`src/config.ts`)

Add `teamId` to the existing linear config block:

```typescript
linear: {
  apiKey: optional("LINEAR_API_KEY", ""),
  teamId: optional("LINEAR_TEAM_ID", ""),
},
```

`teamId` is optional — serves as the default when agents haven't chosen their own team.

### 1.2 LinearClient (`src/linear/linear-client.ts`)

New file. Thin wrapper around `@linear/sdk`.

#### Interfaces

```typescript
interface IssueResult {
  identifier: string;  // e.g. "HIVE-42"
  id: string;          // UUID
  url: string;         // Linear web URL
}

interface CreateIssueOpts {
  description?: string;
  priority?: number;     // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  stateId?: string;      // workflow state UUID
  labelIds?: string[];   // label UUIDs
  teamId?: string;       // override default team
}

interface UpdateIssueFields {
  title?: string;
  description?: string;
  stateId?: string;
  priority?: number;
}

interface IssueSummary {
  identifier: string;
  id: string;
  title: string;
  state: string;        // workflow state name
  priority: number;
  url: string;
}

interface IssueDetail extends IssueSummary {
  description?: string;
}

interface WorkflowState {
  id: string;
  name: string;
  type: string;   // "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled"
}

interface TeamInfo {
  id: string;
  name: string;
  key: string;          // e.g. "HIVE", "DOD", "MKT"
}
```

#### Class

```typescript
export class LinearClient {
  constructor(apiKey: string, private defaultTeamId?: string)
```

The `defaultTeamId` is optional. Methods that need a team use `teamId ?? this.defaultTeamId` and throw/return-null if neither is provided.

#### Methods

| Method | Returns | Notes |
|--------|---------|-------|
| `listTeams()` | `TeamInfo[]` | List all teams accessible to the API key |
| `createIssue(title, opts?)` | `IssueResult \| null` | `opts.teamId` overrides default |
| `updateIssue(issueId, fields)` | `boolean` | `issueId` is UUID, no team needed |
| `addComment(issueId, body)` | `string \| null` | Returns comment ID |
| `listIssues(opts?)` | `IssueSummary[]` | `opts.teamId` overrides default; filter by `stateType`, `limit` (default 50) |
| `searchIssues(term, limit?, teamId?)` | `IssueSummary[]` | Full-text search, optionally filtered to team |
| `getWorkflowStates(teamId?)` | `WorkflowState[]` | Sorted by position |
| `findIssueByIdentifier(id)` | `IssueDetail \| null` | Accepts UUID or identifier like "HIVE-42" |

All methods: try/catch, log errors via `createLogger("linear-client")`, return null/false/empty on failure, never throw.

---

## Phase 2: Linear MCP Server

### 2.1 File: `src/linear/linear-mcp-server.ts`

New file. Follows the same pattern as `src/dodi/task-mcp-server.ts`.

#### Server Setup

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LinearClient } from "./linear-client.js";

const apiKey = process.env.LINEAR_API_KEY;
const defaultTeamId = process.env.LINEAR_TEAM_ID || undefined;

if (!apiKey) {
  console.error("LINEAR_API_KEY is required");
  process.exit(1);
}

const linearClient = new LinearClient(apiKey, defaultTeamId);
const server = new McpServer({ name: "linear", version: "1.0.0" });
```

#### Tools (8 total)

| Tool | Input | Description |
|------|-------|-------------|
| `linear_list_teams` | (none) | List all Linear teams accessible to Hive |
| `linear_list_issues` | teamId?, statusType?, limit? | List issues filtered by team and workflow state type |
| `linear_get_issue` | issueId | Get full details by identifier or UUID |
| `linear_create_issue` | title, teamId?, description?, priority?, stateName? | Create issue in specified or default team |
| `linear_update_issue` | issueId, title?, description?, priority?, stateName? | Update issue fields |
| `linear_add_comment` | issueId, body | Add comment to issue |
| `linear_search` | query, teamId?, limit? | Full-text search, optionally scoped to team |
| `linear_list_states` | teamId? | List workflow states for a team |

**Key design point:** `teamId` is optional on all team-scoped tools. The agent is responsible for passing its preferred team (from memory). If omitted, falls back to the `LINEAR_TEAM_ID` env var default. If neither exists, returns an error telling the agent to specify a team (which prompts the agent to ask the user and store it).

#### State Name Resolution

Cache workflow states per team on first use:

```typescript
const stateCaches = new Map<string, Map<string, string>>();

async function resolveStateName(name: string, teamId?: string): Promise<string | undefined> {
  const tid = teamId ?? defaultTeamId;
  if (!tid) return undefined;
  if (!stateCaches.has(tid)) {
    const states = await linearClient.getWorkflowStates(tid);
    stateCaches.set(tid, new Map(states.map(s => [s.name.toLowerCase(), s.id])));
  }
  return stateCaches.get(tid)!.get(name.toLowerCase());
}
```

#### Server Startup

```typescript
const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## Phase 3: Agent Runner Registration

### 3.1 MCP Server Registration (`src/agents/agent-runner.ts`)

Add conditional block in `buildMcpServers()`:

```typescript
if (config.linear.apiKey) {
  const env: Record<string, string> = {
    LINEAR_API_KEY: config.linear.apiKey,
  };
  if (config.linear.teamId) {
    env.LINEAR_TEAM_ID = config.linear.teamId;
  }
  servers["linear"] = {
    type: "stdio",
    command: "node",
    args: [resolve("dist/linear/linear-mcp-server.js")],
    env,
  };
}
```

Note: Only `LINEAR_API_KEY` is required. `LINEAR_TEAM_ID` is optional — agents discover their own team via `linear_list_teams` and store it in memory.

---

## Agent Orientation Flow

When an agent first uses Linear (no team in memory):

1. Agent calls `linear_list_teams` to see available teams.
2. Agent asks the user: "Which Linear team should I work with?" — presents the list.
3. User picks a team (e.g. "Marketing").
4. Agent stores team in memory: `memory_write("linear-team", "{ \"id\": \"...\", \"name\": \"Marketing\", \"key\": \"MKT\" }")`.
5. Agent passes `teamId` to all subsequent Linear tool calls.

When user wants to switch teams:

1. User says: "Use the Engineering team in Linear from now on."
2. Agent calls `linear_list_teams` to resolve the team ID.
3. Agent updates memory with the new team.

This behavior is driven by the agent's system prompt and tool descriptions — no special code needed beyond making `teamId` optional on tools.

---

## Testing

### Phase 1: Build Verification
- [ ] `npm run build` succeeds with zero errors

### Phase 2: MCP Server Standalone Test
- [ ] Run: `LINEAR_API_KEY=xxx node dist/linear/linear-mcp-server.js` (no default team)
- [ ] `tools/list` returns all 8 tools
- [ ] `linear_list_teams` returns available teams
- [ ] `linear_list_issues` without `teamId` returns error (no default set)
- [ ] `linear_list_issues` with `teamId` returns issues
- [ ] `linear_create_issue` with `teamId` creates issue, `linear_get_issue` retrieves it
- [ ] `linear_add_comment` and `linear_update_issue` work on the test issue
- [ ] `linear_search` and `linear_list_states` work with explicit `teamId`
- [ ] Clean up test issue

### Phase 3: Integration Test
- [ ] Start Hive with `LINEAR_API_KEY` set (no `LINEAR_TEAM_ID`)
- [ ] Ask agent to work with Linear — confirm it asks which team to use
- [ ] Agent stores team in memory and uses it for subsequent calls
- [ ] Tell agent to switch teams — confirm it updates memory
- [ ] Start Hive without `LINEAR_API_KEY` — confirm no Linear server registered
