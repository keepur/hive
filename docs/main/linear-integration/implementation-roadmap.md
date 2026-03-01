# Linear Integration — Implementation Roadmap

## Design Summary

This feature gives Hive agents direct access to Linear via MCP tools. Three components:

1. **LinearClient** — A thin wrapper around `@linear/sdk` with methods for the full issue lifecycle (create, update, comment, list, search, workflow states, list teams, find by identifier). All team-scoped methods accept an optional `teamId` parameter.

2. **Linear MCP Server** — A stdio subprocess MCP server exposing eight tools that agents use during their sessions. Follows the existing MCP server pattern (same as memory and dodi task servers). Tools accept an optional `teamId` — the agent is responsible for knowing its team (stored in memory).

3. **Agent Runner Registration** — Conditional wiring so the MCP server spins up when `LINEAR_API_KEY` is configured. `LINEAR_TEAM_ID` is optional — serves as the default, but agents can override via their own memory.

## Per-Agent Team Selection

Rather than hardcoding a single team for all agents, each agent discovers and remembers its own team:

- **First use:** Agent calls `linear_list_teams` to see available teams, asks the user which one to use, then stores the team ID in memory (e.g. `memory_write("linear-team", "{ id: '...', name: 'Marketing' }")`).
- **Subsequent use:** Agent reads its team from memory and passes the `teamId` to Linear tools.
- **Switching:** User tells the agent to change teams — agent updates memory.

This is part of agent "orientation" — the same way an agent learns other preferences on first interaction.

## Implementation Phases

### Phase 1: Config + LinearClient

**Goal:** Add Linear config and create `LinearClient` with full issue lifecycle methods.

**Work:**
- Add `teamId` to the `linear` config block in `src/config.ts` (optional default).
- Create `src/linear/linear-client.ts` with methods: `createIssue`, `updateIssue`, `addComment`, `listIssues`, `searchIssues`, `getWorkflowStates`, `findIssueByIdentifier`, `listTeams`.
- All team-scoped methods accept an optional `teamId` that overrides the constructor default.

**Verification:** `npm run build` succeeds.

**Estimated effort:** Small-medium. One config line, one new file with eight methods.

### Phase 2: Linear MCP Server

**Goal:** Create the MCP server as a standalone stdio process with eight tools.

**Work:**
- Create `src/linear/linear-mcp-server.ts` following the existing MCP server pattern.
- Read `LINEAR_API_KEY` and `LINEAR_TEAM_ID` (optional default) from environment variables.
- Instantiate LinearClient internally (the server runs as a subprocess).
- Register eight tools: `linear_list_teams`, `linear_list_issues`, `linear_get_issue`, `linear_create_issue`, `linear_update_issue`, `linear_add_comment`, `linear_search`, `linear_list_states`.
- All team-scoped tools accept an optional `teamId` input parameter.

**Verification:** `npm run build` succeeds. Manual test: run the compiled server directly and send JSON-RPC tool calls via stdin.

**Estimated effort:** Medium. One new file, eight tool registrations, but the pattern is well-established.

### Phase 3: Agent Runner Registration

**Goal:** Wire the MCP server into agent sessions so agents have access to Linear tools.

**Work:**
- In `src/agents/agent-runner.ts`, add a conditional block in `buildMcpServers()` that registers the Linear MCP server when `LINEAR_API_KEY` is configured.
- Pass `LINEAR_TEAM_ID` as env var if set (serves as default).

**Verification:** Start Hive, open a Slack thread, confirm agent can call Linear tools. If API key is missing, confirm no Linear server is registered.

**Estimated effort:** Small. One conditional block (~10 lines).

## Phase Dependencies

```
Phase 1 (Config + Client)
  └──> Phase 2 (MCP Server) ──> Phase 3 (Agent Registration)
```

Strictly sequential — each phase builds on the previous.

## Dependencies

| Dependency | Status |
|-----------|--------|
| `@linear/sdk` | Already installed |
| `@modelcontextprotocol/sdk` | Already installed |
| Existing MCP server pattern | Established in codebase |
| `LINEAR_API_KEY` in `.env` | Already configured |
| `LINEAR_TEAM_ID` in `.env` | Optional — agents discover their own team |

## Risks

### Linear API Availability
**Risk:** Linear API downtime blocks agent Linear operations.
**Mitigation:** All client methods are try/catch with logging. Failures surface to the agent as tool errors but never crash the session.

### MCP Server Process Management
**Risk:** The Linear MCP server subprocess crashes, leaving agents without Linear tools.
**Mitigation:** Agent SDK manages subprocess lifecycles. If the server fails to start, the agent operates without Linear tools.
