# Implementation Roadmap

## Design Summary

Pure rename/move operation. No logic changes, no new features. The MCP server moves from `src/hubspot/` to `src/search/`, gets a new name and tool prefix, and all references across templates, prompts, and docs are updated.

## Implementation Phases

### Phase 1: Server rename + move (1 file create, 1 file delete)
- Move `src/hubspot/crm-search-mcp-server.ts` → `src/search/knowledge-base-mcp-server.ts`
- Update server name, tool names, tool descriptions inside the file

### Phase 2: Agent runner update (1 file)
- Update server key and compiled path in `src/agents/agent-runner.ts`

### Phase 3: Template updates (8+ files)
- Replace `crm-search` → `knowledge-base` in all agent.yaml templates
- Update tool name references in system prompt templates

### Phase 4: Docs (1 file)
- Update `docs/architecture.md`

All phases are independent and can run in parallel.

## Risks

- **Zero logic risk** — this is a rename only, no behavior changes
- **Agent confusion during rollover** — agents with active sessions will see old tool names until their session restarts. Non-issue since deploy restarts all sessions.
