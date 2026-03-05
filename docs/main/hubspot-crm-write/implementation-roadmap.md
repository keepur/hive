# Implementation Roadmap: HubSpot CRM Write

## Design Summary

New `hubspot-crm` MCP server alongside the existing read-only `crm-search` server. Two new files (API client + MCP server), plus wiring changes in agent-runner, config, and agent templates.

The API client reuses proven patterns from the marketing extraction client (rate limiting, retry, auth) but is focused on single-object CRUD rather than bulk extraction.

## Phases

### Phase 1: Core (API Client + MCP Server)
- `hubspot-api-client.ts` — rate limiter, retry, CRUD methods
- `hubspot-crm-mcp-server.ts` — 9 MCP tools
- Independent of other changes; can be built and tested standalone

### Phase 2: Wiring
- `agent-runner.ts` — register server, gated on env var
- `config.ts` — add hubspot.apiKey config entry
- Depends on Phase 1 files existing

### Phase 3: Agent Templates
- Add `hubspot-crm` to server lists for Jessica, SDR, Rae
- Add `crm-search` to Rae (missing today)
- Independent of Phase 2

## Dependencies

- Read/write HubSpot API key (user to provide)
- No new npm dependencies needed (uses native fetch)

## Risks

- Association type IDs are hardcoded — if HubSpot changes them, we'll need to update
- Rate limiter is per-server-process — multiple agents running simultaneously share HubSpot's account-level limit but have separate rate limiters. The 95/10s limit per server provides enough headroom for 2-3 concurrent agents.
