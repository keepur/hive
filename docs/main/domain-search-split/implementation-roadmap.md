# Domain Search Split — Implementation Roadmap

## Design Summary

Split the monolithic `knowledge-base-mcp-server.ts` (1005 lines) into three domain-specific MCP servers backed by a shared utilities module. Each server owns a distinct set of Qdrant collections and exposes domain-appropriate tools. The shared module extracts all common infrastructure: embedding, Qdrant client management, MongoDB stage resolution, and parameterized result formatting.

```
src/search/
  search-shared.ts              # Shared infra (~200 lines)
  crm-search-mcp-server.ts      # CRM domain (~350 lines)
  product-search-mcp-server.ts  # Product domain (~150 lines)
  ops-search-mcp-server.ts      # Ops domain (~150 lines)
  knowledge-base-mcp-server.ts  # DELETED
```

The CRM server inherits all current complexity (Atlas fallback, deals pipeline filtering, timeline, find-similar, stats aggregation). Product and ops servers are simpler — Qdrant-only with search + stats tools.

## Phases

### Phase 1: Extract Shared Module

**File:** `src/search/search-shared.ts`

Extract from `knowledge-base-mcp-server.ts`:
- `SearchBackend` interface and `createSearchBackend()` factory (lazy Qdrant + MongoDB init)
- `embed()`, `embedOllama()`, `embedVoyage()`
- `searchQdrant()` helper
- `loadStageMappings()`, `resolveStage()`, `resolvePipeline()`, `enrichEmbeddingText()`
- `formatResult()` — refactored to accept a `FieldConfig` mapping so each domain controls display
- `ToolResult` type
- Env var reading (OLLAMA_URL, QDRANT_URL, MONGO_URI, VOYAGE_KEY, EMBED_MODEL, KB_BACKEND)

**Validation:** Import from the existing monolithic server temporarily to verify the extraction compiles. This is a scaffolding step — the import is removed once all three servers are built.

**Estimated size:** ~200 lines.

### Phase 2: Build Domain Servers (parallel)

Three servers built in parallel. Each is a standalone `#!/usr/bin/env node` MCP server using `StdioServerTransport`.

#### Phase 2a: CRM Search Server

**File:** `src/search/crm-search-mcp-server.ts`

Most complex of the three — inherits Atlas fallback, deals pipeline filtering, find-similar, timeline, and stats aggregation from the original server.

- Tools: `crm_search`, `crm_find_similar`, `crm_timeline`, `crm_stats`
- Collections (Qdrant): `contacts`, `deals`, `activities`
- Collections (Atlas): `rag_contacts`, `rag_deals`, `rag_activities`
- Special behavior: deals filtered to `pipeline: "default"` with 3x oversampling

**Estimated size:** ~350 lines.

#### Phase 2b: Product Search Server

**File:** `src/search/product-search-mcp-server.ts`

Simplest server. Qdrant-only. No Atlas fallback needed (product data was never in Atlas).

- Tools: `product_search`, `product_stats`
- Collections: `parts`, `product_families`, `designs`, `design_iterations`
- No special filtering or oversampling

**Estimated size:** ~150 lines.

#### Phase 2c: Ops Search Server

**File:** `src/search/ops-search-mcp-server.ts`

Similar complexity to product server. Qdrant-only.

- Tools: `ops_search`, `ops_stats`
- Collections: `persons`, `projects`, `quotes`, `orders`, `jobs`, `operational_tasks`, `cases`, `comments`
- No special filtering or oversampling

**Estimated size:** ~150 lines.

### Phase 3: Agent Runner Update

**File:** `src/agents/agent-runner.ts`

Replace lines 287-304 (single `knowledge-base` registration) with three registrations:

1. `crm-search` — includes `KB_BACKEND` env var for atlas legacy support
2. `product-search` — Qdrant-only, no `KB_BACKEND`
3. `ops-search` — Qdrant-only, no `KB_BACKEND`

All three share: `OLLAMA_URL`, `QDRANT_URL`, `KB_EMBED_MODEL`, `MONGODB_ATLAS_URI`, `MONGODB_STAGING_URI`, `VOYAGEAI_API_KEY`.

Each server is gated by the agent's `servers` list in its YAML config (same pattern as all other MCP servers).

### Phase 4: Agent Template Updates

Update 9 agent template files. Replace `knowledge-base` references with domain-appropriate servers per the mapping table in the user story. Add `product-search` to Wyatt's template (new capability).

Files to edit:
- `agents-templates/chief-of-staff/agent.yaml.tpl`
- `agents-templates/sdr/agent.yaml.tpl`
- `agents-templates/marketing-manager/agent.yaml.tpl`
- `agents-templates/executive-assistant/agent.yaml.tpl`
- `agents-templates/devops/agent.yaml.tpl`
- `agents-templates/customer-success/agent.yaml`
- `agents-templates/product-manager/agent.yaml.tpl`
- `agents-templates/product-specialist/agent.yaml.tpl`
- `agents-templates/production-support/agent.yaml`

After editing, run `npm run setup:agents` to regenerate `agents/`.

### Phase 5: Delete Old Server and Verify

1. Delete `src/search/knowledge-base-mcp-server.ts`.
2. Grep the codebase for any remaining `knowledge-base` references and remove them.
3. `npm run build` — must succeed with no errors.
4. `npm run setup:agents` — regenerated configs must reference new servers only.
5. Manual smoke test: start each server with appropriate env vars, verify tool listing.

## Dependencies

| Dependency | Phase | Notes |
|-----------|-------|-------|
| Shared module must exist before domain servers | Phase 1 before Phase 2 | Domain servers import from `search-shared.ts` |
| Domain servers must exist before agent-runner update | Phase 2 before Phase 3 | Runner references `dist/search/*.js` paths |
| Agent-runner must register servers before templates reference them | Phase 3 before Phase 4 | Templates list server names; runner must know how to spawn them |
| All new code must be in place before old server is deleted | Phases 1-4 before Phase 5 | Clean cutover, no transition period |
| Qdrant collections already exist | None | Embed scripts (`hubspot-embed.ts`, `dodi-embed.ts`) already write to separate collections |
| `design_iterations` collection | Phase 2b | Must exist in Qdrant if product-search references it. If not yet populated, the server handles empty collections gracefully (returns 0 results). |

## Risks and Mitigations

### Risk: Subprocess count increase (1 server per agent -> up to 3 per agent)

Mokie goes from 1 knowledge-base subprocess to 3 search subprocesses. Each is a Node process.

**Mitigation:** MCP servers are lazy-initialized — they only connect to Qdrant/MongoDB on first tool call, not at spawn. Memory footprint is small for idle servers. Monitor with `ps` after deploy. If resource pressure appears, consider a single multiplexed server with domain-scoped tools (but this is unlikely to be needed for 10 agents).

### Risk: Atlas fallback only in CRM server

Product and ops servers are Qdrant-only. If Qdrant is down, these servers return errors.

**Mitigation:** This matches reality — product and ops data was never in Atlas. The CRM server retains Atlas fallback for the data that was historically stored there. Qdrant runs locally on the same Mac Mini, so availability is coupled to the host anyway.

### Risk: design_iterations collection may not exist yet

The plan includes `design_iterations` in product-search, but no embed script currently writes to it.

**Mitigation:** `searchQdrant()` catches collection-not-found errors and returns empty results. The product-search server works without this collection. When the embed pipeline is extended to include design iterations, product-search will pick them up automatically.

### Risk: Agent template edits are manual and error-prone

Nine files across different directory structures, some `.yaml` and some `.yaml.tpl`.

**Mitigation:** After editing, run `npm run setup:agents` and diff the generated `agents/` directory against the previous state. Grep for any remaining `knowledge-base` references as a final check.
