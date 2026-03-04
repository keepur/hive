# HubSpot Data Jailbreak — Implementation Roadmap

## Design Summary

### Architecture
- **One-way extraction** from HubSpot v3 REST API into two destinations:
  1. dodi_v2's MongoDB — structured data mapped to existing Persons, Orgs, Deals, Tasks schemas
  2. MongoDB Atlas — vector-embedded copies for semantic search by Hive agents
- **Read-only HubSpot client** using raw `fetch()` (no SDK, follows existing quo-mcp-server pattern)
- **CRM Search MCP server** queries Atlas vector index at runtime (zero HubSpot API calls)
- **SDR agent template** uses CRM search + other tools for lead qualification and outreach

### Technical Decisions
- Raw `fetch()` over HubSpot Node SDK — consistent with codebase patterns, zero new dependencies
- Voyage AI `voyage-3-lite` for embeddings — stays in Anthropic ecosystem, 1024 dimensions
- Separate Atlas cluster for vector store — keeps Hive's local MongoDB unaffected
- Token-bucket rate limiter — 95 req/10s headroom under HubSpot's 100/10s limit
- Activities stored as raw dump — no dodi schema yet, but still vector-embedded for RAG

## Implementation Phases

### Phase 1: HubSpot API Client
- `src/hubspot/hubspot-client.ts`
- Read-only, rate-limited, paginated extraction methods
- No dependencies on other phases

### Phase 2: Sync Pipeline + Embeddings
- `src/hubspot/hubspot-sync.ts`
- Depends on Phase 1 (uses hubspot-client)
- Handles: extraction, dodi schema transformation, Atlas embedding, ID mapping
- Config wiring in `src/config.ts`, `.env.example`, `package.json`

### Phase 3: CRM Search MCP Server
- `src/hubspot/crm-search-mcp-server.ts`
- Depends on Phase 2 (needs data in Atlas)
- Agent runner wiring in `src/agents/agent-runner.ts`

### Phase 4: SDR Agent Template
- `agents-templates/sdr/` (agent.yaml.tpl, system-prompt.md.tpl, soul.md.tpl)
- No code dependency on other phases (template only)
- Can be built in parallel with Phase 3

## Dependencies and Prerequisites

| Prerequisite | Phase | Status |
|--------------|-------|--------|
| HubSpot Private App (read-only scopes) | Phase 1 | Manual — user creates |
| MongoDB Atlas cluster | Phase 2 | Manual — user creates |
| Voyage AI API key | Phase 2 | Manual — user obtains |
| dodi_v2 MongoDB accessible from hive | Phase 2 | Existing (DODI_MONGODB_URI) |
| Data synced into Atlas | Phase 3 | Produced by Phase 2 |

## Parallelization Plan

```
Batch 1 (parallel):
  Agent A → Phase 1: hubspot-client.ts
  Agent B → Phase 4: SDR agent template
  Agent C → Config wiring (config.ts, .env.example, package.json, agent-runner.ts)

Batch 2 (sequential, after Batch 1):
  Agent D → Phase 2: hubspot-sync.ts (extraction + transformation + embeddings)

Batch 3 (sequential, after Batch 2):
  Agent E → Phase 3: crm-search-mcp-server.ts
```

## Risk Considerations

- **HubSpot rate limits during bulk sync**: Mitigated by token-bucket rate limiter (95/10s)
- **Large dataset pagination**: HubSpot search API returns max 10,000 results per query — may need to use `createdAt` range splitting for datasets > 10k per object type
- **FSM state mapping for deals**: HubSpot pipeline stages don't map 1:1 to dodi FSM states — requires manual mapping table
- **Atlas vector index creation**: Must be done via Atlas UI or Admin API, not MongoDB driver — sync script should document this
