# Local Knowledge Base — Implementation Roadmap

## Phase 1: Local Infrastructure

**Goal**: Install and configure Ollama and Qdrant as local services on the Mac Mini.

### Tasks

1. Install Ollama via Homebrew, pull `bge-large` model
2. Install Qdrant via Homebrew or Docker, configure storage directory
3. Create launchd plists for both services (`com.dodi.ollama.plist`, `com.dodi.qdrant.plist`)
4. Verify Ollama embedding endpoint responds at `http://localhost:11434/api/embed`
5. Verify Qdrant REST API responds at `http://localhost:6333`
6. Create Qdrant collections with correct schema (see implementation-specs.md)
7. Smoke-test: embed a sample query via Ollama, insert into Qdrant, search, verify results

### Deliverables

- Both services running as LaunchAgents, auto-start on boot
- Qdrant collections created: `contacts`, `deals`, `activities`, `projects`, `designs`, `quotes`, `orders`, `jobs`, `tasks`, `parts`, `cases`, `persons`
- Embedding latency benchmark: single query embed time < 200ms

### Estimated effort: 1 session

---

## Phase 2: Migration

**Goal**: Re-embed all 70K existing HubSpot records using nomic-embed-text and load into Qdrant.

### Tasks

1. Write a one-time migration script (`scripts/migrate-to-qdrant.ts`) that:
   - Reads all records from Atlas `rag_contacts`, `rag_deals`, `rag_activities`
   - Re-embeds each record's `embeddingText` using Ollama (batch processing)
   - Upserts into corresponding Qdrant collections with full payload
2. Run migration in batches (Ollama handles batches locally, no rate limits)
3. Validate record counts match between Atlas and Qdrant
4. Run search quality comparison: 20+ known queries, compare top-5 results between Atlas and Qdrant
5. Document any relevance differences

### Deliverables

- All 70K records loaded into Qdrant with bge-large embeddings (1024 dims)
- Search quality report comparing Atlas/Voyage vs Qdrant/Ollama results
- Migration script retained for re-runs if needed

### Dependencies

- Phase 1 complete (Ollama + Qdrant running)

### Estimated effort: 1 session

---

## Phase 3: KB MCP Server Swap

**Goal**: Update `knowledge-base-mcp-server.ts` to use Ollama for embedding and Qdrant for search.

### Tasks

1. Add `@qdrant/js-client-rest` dependency to Hive
2. Replace `embed()` function: Voyage AI HTTP call → Ollama local HTTP call
3. Replace `$vectorSearch` aggregations → Qdrant `search` API calls
4. Run all collections in parallel (Qdrant supports concurrent queries, unlike sequential Atlas calls)
5. Update `kb_find_similar`: fetch source embedding from Qdrant, search Qdrant
6. Update `kb_timeline`: embed with Ollama, search Qdrant `activities` collection
7. Update `kb_stats`: query Qdrant for collection counts (or keep MongoDB for aggregation stats)
8. Keep Atlas connection as a fallback behind an env var flag (`KB_BACKEND=qdrant|atlas`)
9. Measure end-to-end latency: target < 1 second for `kb_search` with `objectType: "all"`
10. Deploy to production, monitor for 48 hours

### Deliverables

- Updated `knowledge-base-mcp-server.ts` using Qdrant + Ollama
- Env var `KB_BACKEND` for fallback switching
- Latency benchmarks: before vs after
- No changes needed to agent configs (tool interface unchanged)

### Dependencies

- Phase 2 complete (data loaded in Qdrant)

### Estimated effort: 1 session

---

## Phase 4: Pipeline Update

**Goal**: Update the nightly HubSpot pipeline to embed with Ollama and write to Qdrant instead of Voyage AI and Atlas.

### Tasks

1. Update `hubspot-embed.ts` in `~/github/marketing/projects/hubspot-pipeline/`:
   - Replace `embedBatch()` Voyage AI call → Ollama local batch embed
   - Replace MongoDB `rag_*` collection writes → Qdrant upserts
   - Keep the same `OBJECT_CONFIGS` structure, same embedding text builders
   - Keep `EMBED_DIMENSIONS` at 1024 (bge-large matches Voyage-4-lite)
   - Remove `ensureVectorIndex()` (no longer needed)
2. Update env var requirements: remove `VOYAGE_API_KEY`, add `OLLAMA_URL` and `QDRANT_URL`
3. Test incremental embedding: run with a few new/changed records, verify upsert behavior
4. Test `--reembed` flag still works for full re-embedding
5. Update crontab entry if any path/env changes needed
6. Remove Voyage AI API key from pipeline `.env` (cost savings)

### Deliverables

- Updated `hubspot-embed.ts` writing to Qdrant via Ollama embeddings
- Nightly pipeline tested end-to-end (extract → embed → sync)
- Voyage AI API key retired from pipeline

### Dependencies

- Phase 3 complete (KB MCP server reading from Qdrant)

### Estimated effort: 1 session

---

## Phase 5: Operational Data Ingestion

**Goal**: Extract, embed, and load dodi_v2 operational data into Qdrant for semantic search.

### Tasks

1. Write a new pipeline script (`scripts/dodi-embed.ts` or new stage in marketing pipeline) that:
   - Connects to local MongoDB `master` database
   - Reads from collections: `persons`, `projects`, `designs`, `quotes`, `orders`, `jobs`, `tasks`, `parts`, `cases`
   - Builds embedding text for each record type (see implementation-specs.md for format)
   - Embeds via Ollama
   - Upserts into corresponding Qdrant collections
2. Implement incremental strategy: track `updatedAt` per collection, only process records changed since last run
3. Store last-run timestamps in a local metadata collection or file
4. Update `knowledge-base-mcp-server.ts`:
   - Add new `objectType` enum values
   - Add new Qdrant collections to search scope
   - Update `collectionsForType()` mapping
   - Update `formatResult()` for new record types
   - Update `kb_stats` overview to include operational data
5. Add crontab entry for nightly operational data sync (run after HubSpot pipeline, e.g., 4am)
6. Test search across mixed CRM + operational data

### Deliverables

- Operational data pipeline script with incremental sync
- ~20K operational records in Qdrant (across 9 collections)
- KB MCP server searching both CRM and operational data
- Crontab entry for nightly sync

### Dependencies

- Phase 3 complete (KB MCP server using Qdrant)

### Estimated effort: 2 sessions

---

## Phase 6: Sanitization Layer

**Goal**: Add a post-retrieval sanitization layer for customer-facing contexts.

### Tasks

1. Add `context` parameter to `kb_search` tool schema (`internal` | `customer`, default `internal`)
2. Implement sanitization function that:
   - Takes raw search results and passes them through a Haiku call
   - Haiku prompt instructs: strip cost, margin, supplier, strategy, competitor, internal notes
   - Preserves: product info, project status, dates, names, descriptions, dimensions
   - Returns cleaned result text
3. Only invoke sanitization when `context: "customer"` (zero overhead for internal queries)
4. Add sanitization to `kb_find_similar` and `kb_timeline` tools as well
5. Write test cases: 10+ examples with known sensitive data, verify sanitization
6. Benchmark: sanitization should add < 500ms per query

### Deliverables

- `context` parameter on all KB search tools
- Haiku-based sanitization pass for customer-facing results
- Test suite with sensitive data examples
- Performance benchmark showing sanitization overhead

### Dependencies

- Phase 3 complete (KB MCP server functional)
- Independent of Phases 4 and 5

### Estimated effort: 1 session

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| bge-large quality lower than Voyage-4-lite | Search relevance degrades | Phase 2 quality comparison before cutting over; can try alternative local models (e5-large, nomic-embed-text) |
| Qdrant service crashes or corrupts data | KB unavailable | Atlas fallback via `KB_BACKEND` env var; Qdrant snapshot backups |
| Ollama OOM on Mac Mini under load | Embedding fails | bge-large is ~1.2GB; monitor memory; set Ollama memory limits |
| Sanitization Haiku pass misses sensitive data | Customer sees internal pricing | Test suite with known sensitive data; log sanitized results for audit; start with internal-only rollout |
| Mac Mini disk space for local vector DB | Qdrant storage fills up | 70K records + 1024-dim vectors ≈ 280MB; 90K total with ops data well under 1GB |
| Nightly pipeline timing conflict | Stale data | Sequence pipelines: HubSpot at 3am, operational at 4am; add health checks |

## Rollback Plan

Each phase has an independent rollback path:

- **Phases 1-2**: No production impact. Delete Qdrant collections, stop services.
- **Phase 3**: Set `KB_BACKEND=atlas` to revert to Atlas + Voyage. No code deploy needed.
- **Phase 4**: Revert `hubspot-embed.ts` to Voyage + Atlas writes. Re-add Voyage API key.
- **Phase 5**: Remove operational collections from KB MCP server search scope. Data remains in Qdrant but is not queried.
- **Phase 6**: Remove `context` parameter handling. All queries return raw results (current behavior).
