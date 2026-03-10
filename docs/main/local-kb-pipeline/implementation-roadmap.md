# Local KB Pipeline — Implementation Roadmap

## Design Summary

Phases 1-3 of DOD-206 moved the KB MCP server to local Qdrant + Ollama for search, but the nightly HubSpot pipeline still writes to Atlas via Voyage AI, causing Qdrant to go stale. Phase 4 completes the migration by making the full pipeline local.

The key architectural decision is moving the embed step from the marketing repo into hive. This establishes a clean boundary:

- **Marketing repo**: Extracts external data (HubSpot API) into local MongoDB staging collections. No embedding, no vector DB concerns.
- **Hive repo**: Reads staged data from local MongoDB, embeds via Ollama, upserts into Qdrant. Owns the KB data layer end-to-end.

Local MongoDB serves as the handoff point between the two repos. The marketing pipeline writes to `hubspot.staging_*` collections; the hive embed script reads from them. This decoupling means either side can change independently.

---

## Work Stream A: Marketing Repo Changes

**Goal**: Remove embedding responsibility from the marketing pipeline. Point data extraction at local MongoDB instead of Atlas.

### Tasks

1. Rename env var `MONGODB_ATLAS_URI` → `MONGODB_STAGING_URI` in `hubspot-extract.ts` (3 occurrences)
2. Rename env var `MONGODB_ATLAS_URI` → `MONGODB_STAGING_URI` in `hubspot-sync.ts` (same pattern)
3. Update `.env`: change Atlas connection string to local MongoDB (`mongodb://localhost:27017/hubspot`), remove `VOYAGE_API_KEY`
4. Remove the embed step from `run-nightly.sh` (pipeline becomes: extract → sync, 2 steps)
5. Archive `hubspot-embed.ts` (delete or move to an `_archive/` directory — the logic is ported to hive)

### Deliverables

- Marketing pipeline runs against local MongoDB only
- No Voyage AI or Atlas dependency
- Pipeline is faster (2 steps instead of 3)

### Dependencies

- Work Stream B must be ready before the old embed step is removed from production cron
- Local MongoDB must have staging data seeded (see Data Seeding below)

### Estimated effort: 1 session

---

## Work Stream B: Hive Repo Changes

**Goal**: Build the new embed script in hive and update the KB MCP server to read from local MongoDB.

### B1: New `scripts/hubspot-embed.ts`

1. Port text builder functions from marketing's `hubspot-embed.ts` (all 10 object types)
2. Port enrichment loaders: `loadContactNames()`, `loadActivityContactNames()`, `loadStageMap()`
3. Port helper functions: `stripHtml()`, `truncate()`
4. Port `OBJECT_CONFIGS` array with staging collection → Qdrant collection mapping
5. Reuse from `scripts/migrate-to-qdrant.ts`: `uuidV5()`/`pointId()`, `embedBatch()`, config constants
6. Write fresh: Qdrant upsert logic, payload builders, incremental logic (`embed_meta` collection), CLI arg parsing
7. Add `"embed:hubspot"` script to `package.json`

### B2: KB MCP Server Update

1. Update `src/search/knowledge-base-mcp-server.ts` to accept `MONGODB_STAGING_URI` as the MongoDB connection (with `MONGODB_ATLAS_URI` as fallback)
2. Update `src/agents/agent-runner.ts` to pass `MONGODB_STAGING_URI` to the KB MCP server environment

### Deliverables

- `scripts/hubspot-embed.ts` embeds from local staging into Qdrant
- KB MCP server reads stage mappings from local MongoDB
- Incremental embedding with `embed_meta` tracking
- CLI flags: `--dry-run`, `--reembed`, `--objects TYPE`

### Dependencies

- Qdrant and Ollama running locally (done in Phase 1)
- Existing data in Qdrant from Phase 2 migration
- Local MongoDB staging data seeded (see below)

### Estimated effort: 1 session

---

## Data Seeding

**Goal**: Populate local MongoDB with existing staging data so the new pipeline has a starting point.

### Steps

1. Run `mongodump` against the Atlas `hubspot` database to export all `staging_*` collections
2. Run `mongorestore` into local MongoDB `hubspot` database
3. Verify record counts match between Atlas and local for all 10 staging collections
4. Set `embed_meta` watermarks to current timestamp — Qdrant already has all existing records from the Phase 2 migration, so the first incremental run should find 0 new records
5. Run `npx tsx scripts/hubspot-embed.ts --dry-run` to confirm it reports 0 records to process

### Dependencies

- Atlas credentials available for the dump
- Local MongoDB running

### Estimated effort: 30 minutes

---

## Execution Order

| Step | Action | Blocks |
|------|--------|--------|
| 1 | Seed local MongoDB from Atlas dump | Nothing (prep step) |
| 2 | Build `scripts/hubspot-embed.ts` in hive (Work Stream B1) | Step 1 |
| 3 | Set `embed_meta` watermarks to current timestamp | Step 2 |
| 4 | Run `hubspot-embed.ts --dry-run` to verify 0 new records | Step 3 |
| 5 | Run `hubspot-embed.ts` (incremental) to confirm no-op | Step 4 |
| 6 | Update KB MCP server MongoDB connection (Work Stream B2) | Step 2 |
| 7 | Update marketing repo: env var rename, remove embed step (Work Stream A) | Steps 5, 6 |
| 8 | Update crontab: marketing at 3am, hive embed at 4am | Step 7 |
| 9 | Monitor first nightly run | Step 8 |

Steps 2 and 6 can be done in parallel. Work Stream A (step 7) should be last since it removes the old pipeline.

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Local MongoDB staging data diverges from Atlas after seeding | Stale KB data until marketing pipeline points at local | Low | Seed immediately before switching marketing pipeline; verify counts |
| Text builder functions ported incorrectly | Embedding text differs from original, affecting search quality | Medium | Diff ported functions against marketing originals line by line; spot-check 10 records per type |
| Ollama service unavailable during nightly embed | Embed run fails, Qdrant goes stale for one day | Low | Embed script retries with backoff; Ollama runs as KeepAlive LaunchAgent; alert on embed failure |
| Qdrant upsert fails mid-batch | Partial data in Qdrant | Low | Qdrant upserts are idempotent (deterministic point IDs); re-run safely processes remaining records |
| Timing overlap between marketing extract (3am) and hive embed (4am) | Embed reads incomplete staging data | Low | Marketing pipeline completes in ~30 minutes; 1-hour gap is sufficient. Add a simple lock file or completion marker if needed |
| `embed_meta` watermark set incorrectly | Either misses records (set too late) or re-embeds everything (set too early) | Medium | Verify watermark against actual `extractedAt` timestamps in staging; `--reembed` flag available for recovery |
| Disk space on Mac Mini for local MongoDB + Qdrant | Services fail | Low | HubSpot staging is ~500MB; Qdrant vectors ~280MB; well within available disk. Monitor with periodic checks |

---

## Rollback Plan

### Full Rollback (revert to Atlas + Voyage pipeline)

1. Restore marketing repo's `hubspot-embed.ts` and `run-nightly.sh` to pre-change state
2. Restore `MONGODB_ATLAS_URI` and `VOYAGE_API_KEY` in marketing `.env`
3. Revert KB MCP server MongoDB connection to Atlas
4. Restore crontab to original schedule (marketing handles all 3 steps at 3am)
5. KB MCP server continues reading from Qdrant (Phase 3 is independent) — only the write path reverts

### Partial Rollback (keep hive embed, revert marketing)

If the marketing repo changes cause issues but the hive embed script works:

1. Keep marketing pipeline unchanged (still writes to Atlas via Voyage)
2. Run hive embed script against Atlas staging collections instead of local MongoDB (change `MONGODB_STAGING_URI` to Atlas URI temporarily)
3. This gives a dual-write situation until marketing is ready to switch

### Recovery from Bad Embed

If the hive embed script produces bad data in Qdrant:

1. Stop the cron job
2. Re-run `scripts/migrate-to-qdrant.ts` from Phase 2 to reload all data from Atlas `rag_*` collections
3. Reset `embed_meta` watermarks
4. Debug and fix the embed script before re-enabling
