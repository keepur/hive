# Domain Search Split — User Story

## Story

**As** an agent in the Hive system,
**I want** domain-specific semantic search servers (CRM, product, operations) instead of a single monolithic knowledge base,
**so that** my search results are relevant to my domain and not polluted by unrelated data from other embedding spaces.

## Background

The current `knowledge-base` MCP server (1005 lines) searches across all Qdrant collections simultaneously. When an SDR agent searches for "homeowners in Austin," results include production jobs, parts, and design iterations alongside the contacts they actually need. Each domain has fundamentally different embedding characteristics — customer relationship text, product catalog descriptions, and operational project data occupy distinct semantic spaces that should not be mixed in a single ranked result set.

## Scope

### In Scope

1. **Shared utilities module** (`search-shared.ts`) — extract common infrastructure from the monolithic server into a reusable module: embedding functions, Qdrant client factory, MongoDB connection for stage mappings, result formatting, and type definitions.

2. **CRM Search server** (`crm-search-mcp-server.ts`) — contacts, companies, deals, activities. Supports both Qdrant (primary) and Atlas (legacy fallback) backends. Four tools: `crm_search`, `crm_find_similar`, `crm_timeline`, `crm_stats`.

3. **Product Search server** (`product-search-mcp-server.ts`) — parts, product families, designs, design iterations. Qdrant-only (this data never existed in Atlas). Two tools: `product_search`, `product_stats`.

4. **Ops Search server** (`ops-search-mcp-server.ts`) — persons, projects, quotes, orders, jobs, operational tasks, cases, comments. Qdrant-only. Two tools: `ops_search`, `ops_stats`.

5. **Agent runner update** — replace the single `knowledge-base` server registration with three separate registrations (`crm-search`, `product-search`, `ops-search`), each with appropriate env vars.

6. **Agent template updates** — all 9 agents that reference `knowledge-base` are updated to reference their domain-appropriate server(s). One agent (Wyatt) gains `product-search` as a new capability.

7. **Deletion of the old server** — `knowledge-base-mcp-server.ts` is removed entirely. No compatibility shim, no transition period.

### Out of Scope

- Changes to embed scripts (`hubspot-embed.ts`, `dodi-embed.ts`) — they already write to separate Qdrant collections.
- Changes to the catalog MCP server — it provides structured API access and complements product-search (semantic discovery).
- New Qdrant collections or index changes.
- Cross-domain search (an agent that needs multiple domains gets multiple servers).

## Acceptance Criteria

### AC-1: Shared Module

- [ ] `search-shared.ts` exports `createSearchBackend()` that returns a `SearchBackend` object with lazy-initialized Qdrant client and MongoDB connection.
- [ ] Embedding functions (`embed`, `embedOllama`, `embedVoyage`) are exported and usable by all three servers.
- [ ] `searchQdrant()` helper is exported with the same filter/limit interface as the current implementation.
- [ ] Stage/pipeline resolution (`resolveStage`, `resolvePipeline`, `loadStageMappings`) is exported.
- [ ] `formatResult()` accepts a domain-specific field configuration so each server controls which fields are displayed.
- [ ] `ToolResult` type is exported.

### AC-2: CRM Search Server

- [ ] `crm_search` accepts `query`, `objectType` (contact/company/deal/activity/all), and `limit`. Defaults: objectType=all, limit=10.
- [ ] `crm_find_similar` accepts `hubspotId`, `objectType` (contact/company/deal/activity), and `limit`. Finds records using the source record's embedding vector.
- [ ] `crm_timeline` accepts `name` and `limit`. Returns chronological activity history sorted by date.
- [ ] `crm_stats` accepts `metric` (pipeline/lifecycle/activity_types/overview). Returns aggregated statistics.
- [ ] Deals collection is filtered to `pipeline: "default"` (Sales Pipeline only) with 3x oversampling.
- [ ] Supports `KB_BACKEND=atlas` fallback for legacy Atlas vector search.
- [ ] Collections searched: `contacts`, `deals`, `activities` (Qdrant) or `rag_contacts`, `rag_deals`, `rag_activities` (Atlas).

### AC-3: Product Search Server

- [ ] `product_search` accepts `query`, `objectType` (part/product_family/design/design_iteration/all), and `limit`. Defaults: objectType=all, limit=10.
- [ ] `product_stats` accepts `metric` (overview only for now). Returns point counts per collection.
- [ ] Collections searched: `parts`, `product_families`, `designs`, `design_iterations`.
- [ ] Qdrant-only — no Atlas backend support needed.

### AC-4: Ops Search Server

- [ ] `ops_search` accepts `query`, `objectType` (person/project/quote/order/job/task/case/comment/all), and `limit`. Defaults: objectType=all, limit=10.
- [ ] `ops_stats` accepts `metric` (overview only for now). Returns point counts per collection.
- [ ] Collections searched: `persons`, `projects`, `quotes`, `orders`, `jobs`, `operational_tasks`, `cases`, `comments`.
- [ ] Qdrant-only — no Atlas backend support needed.

### AC-5: Agent Runner Registration

- [ ] Three server registrations replace the single `knowledge-base` registration in `agent-runner.ts`.
- [ ] All three share env vars: `OLLAMA_URL`, `QDRANT_URL`, `KB_EMBED_MODEL`, `MONGODB_ATLAS_URI`, `MONGODB_STAGING_URI`, `VOYAGEAI_API_KEY`.
- [ ] CRM server additionally receives `KB_BACKEND` for atlas legacy support.
- [ ] Product and ops servers do not receive `KB_BACKEND` (Qdrant-only).

### AC-6: Agent Template Updates

All 9 agents are updated:

| Agent | Template File | Old | New |
|-------|--------------|-----|-----|
| Mokie (chief-of-staff) | `chief-of-staff/agent.yaml.tpl` | `knowledge-base` | `crm-search`, `product-search`, `ops-search` |
| Milo (sdr) | `sdr/agent.yaml.tpl` | `knowledge-base` | `crm-search` |
| River (marketing-manager) | `marketing-manager/agent.yaml.tpl` | `knowledge-base` | `crm-search` |
| Rae (executive-assistant) | `executive-assistant/agent.yaml.tpl` | `knowledge-base` | `crm-search` |
| Colt (devops) | `devops/agent.yaml.tpl` | `knowledge-base` | `crm-search` |
| Jessica (customer-success) | `customer-success/agent.yaml` | `knowledge-base` | `crm-search`, `product-search` |
| Chloe (product-manager) | `product-manager/agent.yaml.tpl` | `knowledge-base` | `crm-search`, `product-search` |
| Wyatt (product-specialist) | `product-specialist/agent.yaml.tpl` | (none) | `product-search` |
| Sige (production-support) | `production-support/agent.yaml` | `knowledge-base` | `ops-search` |

- [ ] Each agent's `servers` list is updated in its template file.
- [ ] No agent retains a reference to `knowledge-base`.
- [ ] Wyatt gains `product-search` as a new server (currently has only `memory`, `catalog`, `slack`, `callback`).
- [ ] After running `npm run setup:agents`, generated agent configs reflect the new servers.

### AC-7: Clean Removal

- [ ] `src/search/knowledge-base-mcp-server.ts` is deleted.
- [ ] No references to `knowledge-base` remain in agent templates, agent-runner, or any source file.
- [ ] Build succeeds (`npm run build`) with no errors.

### AC-8: Functional Verification

- [ ] Each server starts successfully as a stdio subprocess.
- [ ] CRM search returns only CRM-domain results (contacts, companies, deals, activities).
- [ ] Product search returns only product-domain results (parts, families, designs).
- [ ] Ops search returns only operations-domain results (persons, projects, jobs, etc.).
- [ ] Agents with multiple search servers can use each independently.
- [ ] CRM atlas fallback works when `KB_BACKEND=atlas` is set.
