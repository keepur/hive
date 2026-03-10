# Local Knowledge Base — User Stories

## US-1: Sub-Second KB Search Latency

**As** an agent operator,
**I want** knowledge base searches to complete in under 1 second,
**so that** agent response times drop from 60-80 seconds to under 15 seconds.

### Context

The current KB search path is: Voyage AI API (embed query) → MongoDB Atlas `$vectorSearch` (3 sequential aggregations across `rag_contacts`, `rag_deals`, `rag_activities`). A single `kb_search` call takes ~16 seconds. Agents typically need 3-5 searches per response, compounding to 50-80 seconds of wall time spent on retrieval alone.

The replacement path is: Ollama local inference (embed query) → Qdrant local vector DB (search). Both services run on the same Mac Mini as Hive, eliminating all network round-trips.

### Acceptance Criteria

- [ ] A single `kb_search` call completes in under 1 second (p95), measured end-to-end from tool invocation to result return
- [ ] Query embedding via Ollama `bge-large` completes in under 200ms
- [ ] Qdrant search across all collections completes in under 100ms
- [ ] All existing KB tools (`kb_search`, `kb_find_similar`, `kb_timeline`, `kb_stats`) work with the new backend
- [ ] Search quality is validated against a set of 20+ known queries with expected top-3 results
- [ ] No regression in result relevance compared to Voyage AI + Atlas (spot-checked, not required to be identical)
- [ ] Atlas remains available as a fallback during the validation window

---

## US-2: Operational Data in Knowledge Base

**As** a team member,
**I want** agents to search operational data — projects, designs, quotes, orders, jobs, parts, and cases — not just CRM data,
**so that** agents can answer questions about production status, pricing, and project details without needing separate tool calls.

### Context

The current KB only contains HubSpot CRM data (contacts, companies, deals, activities). The dodi_v2 `master` database on the local MongoDB instance holds operational data that agents currently cannot search semantically:

| Collection | Count | Key Fields |
|------------|-------|------------|
| persons | 2,724 | name, email, phone, address |
| projects | 2,123 | name, status, customer, dates |
| designs | 5,502 | name, project, style, dimensions |
| quotes | 1,915 | project, total, status, line items |
| orders | 79 | project, total, status, line items |
| jobs | 626 | project, status, dates, operations |
| tasks | 1,519 | project, status, assignee, dates |
| parts | 6,062 | family, name, unit, cost, price |
| cases | 40 | project, type, status, description |

### Acceptance Criteria

- [ ] All 9 dodi_v2 collection types are embedded and searchable via `kb_search`
- [ ] New `objectType` filter values available: `project`, `design`, `quote`, `order`, `job`, `task`, `part`, `case`, `person`
- [ ] `kb_search` with `objectType: "all"` searches both CRM and operational collections
- [ ] Embedding text format for each operational type captures the fields most useful for semantic search
- [ ] Incremental ingestion pipeline runs nightly, using `updatedAt` timestamps to process only changed records
- [ ] `kb_stats` `overview` metric includes operational data counts
- [ ] Operational data search works independently of HubSpot pipeline (separate pipeline stage)

---

## US-3: Customer-Facing Data Sanitization

**As** a business owner,
**I want** customer-facing agents to never leak internal pricing, margin, cost, or strategy data,
**so that** agents can safely serve customers via iOS chat and email without exposing competitive or sensitive information.

### Context

Agents are increasingly customer-facing (iOS chat via dodi-shop, email via Resend). The KB contains sensitive internal data:

- **Parts**: cost, margin, supplier info
- **Deals**: internal notes, strategy comments, competitor comparisons
- **Activities**: internal meeting notes, strategy discussions
- **Quotes/Orders**: cost breakdowns, margin calculations

A post-retrieval sanitization layer will use a Haiku pass to strip sensitive data before returning results to customer-facing agent contexts.

### Acceptance Criteria

- [ ] `kb_search` accepts a `context` parameter with values `internal` (default) and `customer`
- [ ] When `context: "customer"`, search results are passed through a Haiku sanitization pass before being returned
- [ ] Sanitization removes: cost/margin data, internal notes, strategy comments, competitor mentions, supplier info
- [ ] Sanitization preserves: product names, descriptions, status, dates, contact info, project details
- [ ] Internal queries (`context: "internal"` or omitted) return raw results with no sanitization overhead
- [ ] Sanitization adds less than 500ms to total query time
- [ ] Sanitization is tested against 10+ examples with known sensitive data, verified to be stripped
- [ ] No false positives on customer-safe data (product specs, dimensions, style names are preserved)

---

## Out of Scope

- Changing agent system prompts or personality files
- Modifying dodi_v2 application code or APIs
- Customer-facing agent rollout (iOS chat, email) — this project provides the data layer only
- Changing the HubSpot extract stage (`hubspot-extract.ts`) — only the embed stage changes
- Migrating away from MongoDB for non-vector data
- Real-time sync (nightly batch is sufficient)
