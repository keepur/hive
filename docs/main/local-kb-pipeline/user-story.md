# Local KB Pipeline — User Stories

## US-1: Fully Local KB Pipeline

**As** an agent operator,
**I want** the nightly HubSpot embed pipeline to run entirely on local infrastructure (Ollama + Qdrant + local MongoDB),
**so that** there is no dependency on Atlas or Voyage AI for keeping the knowledge base current.

### Context

Phases 1-3 migrated the KB MCP server to use local Qdrant + Ollama bge-large for search, but the nightly pipeline still writes to Atlas via Voyage AI. This means Qdrant data goes stale after each nightly run because new/changed records are only written to Atlas. The pipeline currently lives in the marketing repo (`hubspot-embed.ts`), which couples CRM data extraction with embedding concerns.

The fix is to split responsibilities: the marketing repo owns "extract external data into local MongoDB staging collections", and hive owns "embed staged data into the KB". The embed step moves from marketing into hive as `scripts/hubspot-embed.ts`, replacing Voyage AI with Ollama and Atlas `rag_*` writes with Qdrant upserts.

The full local flow becomes:
```
HubSpot API → local MongoDB staging_* → Ollama bge-large → Qdrant
```

### Acceptance Criteria

- [ ] A new `scripts/hubspot-embed.ts` in hive reads from local MongoDB `hubspot.staging_*` collections and writes to Qdrant
- [ ] Embeddings are generated via Ollama bge-large (1024 dimensions), not Voyage AI
- [ ] All 10 HubSpot object types are embedded: contact, company, deal, task, note, call, communication, email, meeting, form_submission
- [ ] The marketing repo's `run-nightly.sh` no longer includes an embed step; it only runs extract and sync
- [ ] The marketing repo connects to local MongoDB (`MONGODB_STAGING_URI`) instead of Atlas (`MONGODB_ATLAS_URI`)
- [ ] The KB MCP server connects to local MongoDB for stage mapping lookups
- [ ] `VOYAGE_API_KEY` is no longer required by any component in the pipeline
- [ ] Nightly cron runs marketing extract/sync at 3am and hive embed at 4am, sequenced correctly
- [ ] The `embed:hubspot` npm script is available in hive's `package.json`
- [ ] Qdrant data stays current after nightly runs (no stale data regression)

---

## US-2: Incremental Embedding

**As** an agent operator,
**I want** the nightly embed step to only process records that are new or changed since the last run,
**so that** the pipeline completes quickly and avoids redundant work re-embedding unchanged records.

### Context

The current marketing embed script processes all records on every run, which is wasteful when only a fraction of the ~70K records change each day. The new hive embed script tracks a high-water mark (`lastEmbedAt`) per object type in a local MongoDB `hubspot.embed_meta` collection. On each run, it queries staging collections for records with `extractedAt > lastEmbedAt` and only embeds those.

A `--reembed` flag allows forcing a full re-embed when needed (e.g., after changing the embedding model). A `--dry-run` flag shows what would be processed without actually embedding or writing. An `--objects` flag allows targeting specific object types.

### Acceptance Criteria

- [ ] The embed script maintains a `hubspot.embed_meta` collection with one document per object type, tracking `lastEmbedAt` and `recordCount`
- [ ] On incremental runs, only records with `extractedAt > lastEmbedAt` are processed
- [ ] After a successful embed run, `lastEmbedAt` is updated to the max `extractedAt` value of the processed batch
- [ ] `--reembed` flag ignores `lastEmbedAt` and processes all records in the specified object types
- [ ] `--dry-run` flag reports how many records would be processed per object type without embedding or upserting
- [ ] `--objects TYPE` flag restricts processing to a single object type (e.g., `--objects deal`)
- [ ] When `lastEmbedAt` has no prior value (first run or after reset), all records in the staging collection are processed
- [ ] Incremental runs with 0 new records complete in under 5 seconds (fast no-op)
- [ ] Initial seeding step sets `lastEmbedAt` watermarks to current timestamp so that the first incremental run finds 0 new records (Qdrant already has all existing records from Phase 2 migration)

---

## Out of Scope

- Changing the HubSpot extract stage (`hubspot-extract.ts`) beyond the env var rename
- Adding new object types not already in the existing HubSpot pipeline
- Operational data ingestion (dodi_v2 collections) — covered by a separate spec
- Customer-facing sanitization layer — covered by a separate spec
- Real-time sync (nightly batch is sufficient)
- Modifying agent system prompts or tool schemas
- Retiring Atlas entirely (may keep for other uses)
