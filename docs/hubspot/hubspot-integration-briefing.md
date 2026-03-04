# HubSpot Integration — Branch Briefing

## What This Branch Does

This branch adds a complete HubSpot data pipeline: **Extract → Embed → Search**. It pulls 5 years of CRM and activity data from HubSpot, generates vector embeddings via Voyage AI, stores everything in MongoDB Atlas, and exposes semantic search to agents via an MCP server.

The goal: give our sales and customer service agents a "brain" — semantic access to every customer interaction we've ever had.

---

## Architecture

```
HubSpot API  →  hubspot-extract.ts  →  staging_* collections (Atlas)
                                              ↓
                                     hubspot-embed.ts  →  rag_* collections (Atlas, vectorized)
                                              ↓
                                     crm-search-mcp-server.ts  →  agents query via MCP
```

There's also a `hubspot-sync.ts` (Stage 2 transform into dodi_v2 schemas) but that's separate from the embedding pipeline and not yet been run against production.

---

## Files Added

| File | Purpose |
|------|---------|
| `src/hubspot/hubspot-client.ts` | HubSpot v3 API client — rate limiter, retry with exponential backoff, CRM search with automatic 10k-limit bisection, batch associations, forms, files |
| `src/hubspot/hubspot-extract.ts` | Stage 1: Pull raw data from HubSpot API into `staging_*` collections. Supports incremental extraction via per-object watermarks |
| `src/hubspot/hubspot-embed.ts` | Stage 2: Read staging data, build embedding text per object type, call Voyage AI, write vectors to `rag_*` collections |
| `src/hubspot/hubspot-sync.ts` | Stage 2 alt: Transform staging data into dodi_v2 schemas + embeddings (couples sync with embedding — the standalone embed pipeline above is preferred) |
| `src/hubspot/crm-search-mcp-server.ts` | MCP server exposing `crm_search`, `crm_find_similar`, `crm_timeline`, `crm_stats` tools via Atlas Vector Search |

---

## What Data We Extracted

Full extraction completed **2026-03-04**. All data lives in the Atlas `hubspot` database.

### Staging Collections (raw HubSpot data)

| Collection | Records | Description |
|------------|---------|-------------|
| `staging_contacts` | 7,918 | People — name, email, phone, lifecycle stage, owner |
| `staging_companies` | 4,884 | Organizations — name, domain, industry, address |
| `staging_deals` | 2,147 | Sales opportunities — amount, stage, pipeline, close date |
| `staging_tasks` | 35,907 | To-do items — subject, body, status, priority |
| `staging_notes` | 931 | Free-form notes attached to contacts/deals |
| `staging_calls` | 7,136 | Call logs — direction, duration, disposition, body/transcript |
| `staging_communications` | 6,961 | SMS messages — body, channel type |
| `staging_emails` | 22,947 | Email history — subject, body (plain text), sender, recipient, direction |
| `staging_meetings` | 1,574 | Meeting records — title, outcome, location, notes |
| `staging_forms` | 14 | HubSpot form definitions |
| `staging_form_submissions` | 3,082 | Form submission data with field values |
| `staging_files` | 794 | File manager metadata (not file contents) |
| `staging_owners` | 9 | HubSpot users/owners |
| `staging_pipelines` | 4 (31 stages) | Deal pipelines and stage definitions |
| `staging_associations` | 75,480 | Relationship links (contact→company, deal→contact, email→contact, etc.) |

**Skipped**: `tickets` and `feedback_submissions` — API key lacks the required HubSpot scopes. Can be added later by enabling those scopes in the HubSpot private app.

### RAG Collections (vectorized for search)

| Collection | Records | Object Types |
|------------|---------|--------------|
| `rag_contacts` | ~12,800 | contacts + companies |
| `rag_deals` | ~2,147 | deals |
| `rag_activities` | ~58,500 | tasks, notes, calls, SMS, emails, meetings, form submissions |

Each document contains: `hubspotId`, `objectType`, `embeddingText` (the text that was embedded), `embedding` (1024-dim float vector), `properties` (raw fields for display), `embeddedAt`.

**Atlas Vector Search indexes** named `vector_index` have been created on all three `rag_*` collections with cosine similarity and an `objectType` filter field.

---

## Keys & Environment

All keys go in `.env` (gitignored). Three are needed:

```env
HUBSPOT_API_KEY=pat-na1-...        # HubSpot private app token (already have)
MONGODB_ATLAS_URI=mongodb+srv://...  # Atlas cluster, /hubspot database (already configured)
VOYAGE_API_KEY=pa-...              # Voyage AI API key (already have, payment method added)
```

- **HubSpot**: Private app token with CRM read scopes. Missing scopes for tickets and feedback submissions.
- **MongoDB Atlas**: Same cluster as dodi_v2 production (`production.mjswk.mongodb.net`) but separate `hubspot` database.
- **Voyage AI**: Using `voyage-4-lite` model ($0.02/M tokens, 200M tokens free). Payment method is on file to unlock standard rate limits (16M TPM / 2000 RPM). As of this extraction, ~8.4M of the 200M free tokens have been used.

---

## How to Run

### Extraction (HubSpot → staging)

```bash
# Incremental (default) — only pulls records modified since last run
npx tsx src/hubspot/hubspot-extract.ts

# Full re-extraction
npx tsx src/hubspot/hubspot-extract.ts --full

# Dry run (preview counts, no writes)
npx tsx src/hubspot/hubspot-extract.ts --dry-run

# Single object type
npx tsx src/hubspot/hubspot-extract.ts --objects emails
```

Run tracking: each run creates a document in `staging_runs`. Per-object watermarks are stored in `staging_meta` for incremental mode. If a run fails mid-way, watermarks are not updated — the next run picks up from the last successful watermarks.

### Embedding (staging → rag vectors)

```bash
# Incremental (default) — only embeds records not yet in rag_* collections
npx tsx src/hubspot/hubspot-embed.ts

# Force re-embed everything
npx tsx src/hubspot/hubspot-embed.ts --reembed

# Dry run
npx tsx src/hubspot/hubspot-embed.ts --dry-run

# Single object type
npx tsx src/hubspot/hubspot-embed.ts --objects emails
```

### MCP Server (agents use this)

The `crm-search-mcp-server.ts` runs as a stdio subprocess of agent sessions. It needs `MONGODB_ATLAS_URI` and `VOYAGE_API_KEY` (uses Voyage to embed the query at search time, must match the document embedding model — currently `voyage-4-lite`).

Tools it exposes:
- **crm_search** — natural language semantic search across all CRM data
- **crm_find_similar** — find records similar to a given record
- **crm_timeline** — chronological activity history for a person/company
- **crm_stats** — pipeline, lifecycle, and activity statistics

---

## Key Technical Details

- **10k search limit bisection**: HubSpot's CRM search API caps at 10k results. The client automatically detects this and bisects the date range, recursively splitting until each slice is under 10k. This is how we got all 22,947 emails out despite the limit.
- **Date field quirk**: Core CRM objects (contacts, companies, deals) use `createdate` for search filters. All other objects (tasks, notes, calls, emails, etc.) must use `hs_createdate` — using `createdate` returns a 400 error.
- **Retry logic**: Both `hubspot-client.ts` and `hubspot-embed.ts` have exponential backoff retry on transient errors (429, 502, 503, network failures).
- **Embedding model consistency**: The MCP server's query embedding model MUST match the document embedding model. Both are set to `voyage-4-lite`. If you change one, change the other.
- **bulkWrite everywhere**: All MongoDB writes use `bulkWrite` with `ordered: false` for batch performance.

---

## What's Not Done Yet

- **Tickets & feedback submissions**: Need additional HubSpot scopes enabled in the private app settings
- **Scheduled runs**: No cron/scheduler yet — extraction and embedding are manual CLI runs
- **hubspot-sync.ts**: The dodi_v2 transform pipeline exists but hasn't been run against production (it writes to dodi's MongoDB, separate from the embedding pipeline)
- **SDR agent**: Template exists in `agents-templates/sdr/` but hasn't been tested with the live vector search
