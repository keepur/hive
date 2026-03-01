# Linear Integration — User Story

## User Story

**As** Mokie (CEO and sole operator),
**I want** Hive agents — especially River (Marketing Manager) — to be able to read, create, update, and search Linear issues from within their agent sessions,
**So that** agents can manage and track work in Linear teams where that's the appropriate tool, without me acting as a middleman.

## Background

Linear is already in the stack for DodiHome dev/PM work. The **primary task ledger** for agent activity tracking is dodi_v2. Linear is not the task ledger — it's a **tool integration** that agents use when their work involves Linear teams.

The immediate use case is River, who needs Linear access for marketing task assignments. Other agents may use it for dev-related issues or cross-team visibility as needs arise.

## Acceptance Criteria

### AC-1: Agents Can Interact with Linear via MCP Tools

- **Given** an agent session is running and `LINEAR_API_KEY` is configured,
- **When** the agent needs to create, read, update, search, or comment on Linear issues,
- **Then** the agent can use the Linear MCP server tools (`linear_create_issue`, `linear_get_issue`, `linear_update_issue`, `linear_search`, `linear_add_comment`, `linear_list_issues`, `linear_list_states`, `linear_list_teams`),
- **And** operations use the agent's preferred team (from memory) or the configured default.

### AC-2: Per-Agent Team Selection via Memory

- **Given** an agent uses Linear tools for the first time and has no team stored in memory,
- **When** the agent needs to scope a Linear operation to a team,
- **Then** the agent asks the user which Linear team it should work with,
- **And** stores the team ID in its persistent memory (e.g. `linear-team` in the agent's memory directory),
- **And** uses that team for all subsequent Linear operations.

### AC-3: Agent Can Switch Teams

- **Given** an agent has a Linear team stored in memory,
- **When** the user tells the agent to use a different Linear team,
- **Then** the agent updates its stored team in memory,
- **And** uses the new team for all subsequent operations.

### AC-4: Linear Failures Never Block Agent Responses

- **Given** the Linear API is unavailable, rate-limited, or returns an error,
- **When** an agent attempts a Linear operation,
- **Then** the error is surfaced to the agent (so it can inform the user) but never crashes the agent session.

### AC-5: Graceful Degradation Without Configuration

- **Given** `LINEAR_API_KEY` is not set in the environment,
- **When** Hive starts up,
- **Then** the Linear MCP server is not registered with agents,
- **And** the system behaves exactly as it does today.

## Out of Scope (for this iteration)

- Dispatcher auto-creating Linear issues (dodi_v2 handles task ledger duties).
- Bidirectional sync (changes in Linear triggering actions in Hive).
- Custom Linear labels, projects, or cycles.
