# Local KB Pipeline — Implementation Specs

## 1. File Change List

### Marketing Repo (`~/github/marketing/projects/hubspot-pipeline/`)

| File | Change |
|------|--------|
| `src/hubspot-extract.ts` | Rename env var `MONGODB_ATLAS_URI` → `MONGODB_STAGING_URI` (3 occurrences) |
| `src/hubspot-sync.ts` | Rename env var `MONGODB_ATLAS_URI` → `MONGODB_STAGING_URI` (same pattern) |
| `src/hubspot-embed.ts` | Delete or archive. Embedding moves to hive. |
| `run-nightly.sh` | Remove embed step (step 2/3). Pipeline becomes: extract → sync (2 steps). |
| `.env` | Change `MONGODB_ATLAS_URI=mongodb+srv://...` → `MONGODB_STAGING_URI=mongodb://localhost:27017/hubspot`. Remove `VOYAGE_API_KEY`. |

### Hive Repo

| File | Change |
|------|--------|
| `scripts/hubspot-embed.ts` | **New file.** Embed script ported from marketing, replacing Voyage → Ollama and Atlas → Qdrant. |
| `src/search/knowledge-base-mcp-server.ts` | Line 26: Add `MONGODB_STAGING_URI` support. Use `MONGODB_STAGING_URI ?? MONGODB_ATLAS_URI` for the MongoDB connection. |
| `src/agents/agent-runner.ts` | Pass `MONGODB_STAGING_URI` env var to the KB MCP server subprocess environment. |
| `package.json` | Add script: `"embed:hubspot": "npx tsx scripts/hubspot-embed.ts"` |

---

## 2. `scripts/hubspot-embed.ts` Architecture

### 2.1 Config Constants

```typescript
const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-large";
const EMBED_DIMS = parseInt(process.env.EMBED_DIMS ?? "1024");
const EMBED_BATCH_SIZE = 100;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const MONGODB_STAGING_URI = process.env.MONGODB_STAGING_URI ?? "mongodb://localhost:27017/hubspot";
const UUID_NAMESPACE = "..."; // Same namespace as migrate-to-qdrant.ts for deterministic IDs
```

### 2.2 Reuse from `scripts/migrate-to-qdrant.ts`

The following utilities are reused directly (import or copy):

- **`uuidV5(name: string): string`** — Deterministic UUID v5 from a name string using a fixed namespace. Used to generate stable Qdrant point IDs from `${objectType}:${hubspotId}`.
- **`pointId(objectType: string, hubspotId: string): string`** — Wrapper that calls `uuidV5()` with the composite key.
- **`embedBatch(texts: string[]): Promise<number[][]>`** — Batch embed via Ollama `/api/embed` endpoint with retry logic. Handles Ollama errors and returns array of 1024-dim vectors.
- **Config pattern** — `EMBED_MODEL`, `EMBED_DIMS`, `EMBED_BATCH_SIZE` constants follow the same naming convention.

### 2.3 Port from Marketing `hubspot-embed.ts`

The following are ported from the marketing repo with minimal changes:

#### Text Builder Functions (10 total)

All text builders follow the same pattern: assemble a descriptive string from document fields for embedding.

| Function | Source Collection | Key Fields |
|----------|-----------------|------------|
| `contactText(doc)` | staging_contacts | name, email, phone, company, lifecycle stage, city/state |
| `companyText(doc)` | staging_companies | name, domain, industry, city/state, description |
| `dealText(doc)` | staging_deals | dealname, amount, stage (mapped via stageMap), close date, contact names |
| `taskText(doc)` | staging_tasks | subject, body (HTML stripped), status, contact names, timestamp |
| `noteText(doc)` | staging_notes | body (HTML stripped), contact names, timestamp |
| `callText(doc)` | staging_calls | body, disposition, duration, contact names, timestamp |
| `communicationText(doc)` | staging_communications | body, channel, contact names, timestamp |
| `emailText(doc)` | staging_emails | subject, body (HTML stripped, truncated), from/to, contact names, timestamp |
| `meetingText(doc)` | staging_meetings | title, body (HTML stripped), start/end time, contact names |
| `formSubmissionText(doc)` | staging_form_submissions | form title, page URL, field values, contact names, timestamp |

#### Helper Functions

- **`stripHtml(html: string): string`** — Removes HTML tags, decodes entities, collapses whitespace. Used by task, note, email, meeting text builders.
- **`truncate(text: string, maxLen: number): string`** — Truncates text to `maxLen` characters with ellipsis. Used to cap long email bodies and note content.

#### Enrichment Loaders

Three functions that pre-load lookup data before the main processing loop:

- **`loadContactNames(): Promise<Map<string, string>>`** — Reads `staging_contacts` to build a `hubspotId → name` map. Used by deal and activity text builders to resolve associated contact IDs to names.
- **`loadActivityContactNames(): Promise<Map<string, string[]>>`** — Reads association data to build `activityId → contactName[]` map. Used by all activity text builders.
- **`loadStageMap(): Promise<Map<string, string>>`** — Reads deal stage metadata to build `stageId → stageName` map. Used by the deal text builder to include human-readable stage names.

#### OBJECT_CONFIGS Array

Defines the mapping from staging collections to Qdrant targets and which text builder to use:

```typescript
const OBJECT_CONFIGS = [
  { staging: "staging_contacts",         qdrant: "contacts",   objectType: "contact",         textBuilder: contactText },
  { staging: "staging_companies",        qdrant: "contacts",   objectType: "company",         textBuilder: companyText },
  { staging: "staging_deals",            qdrant: "deals",      objectType: "deal",            textBuilder: dealText },
  { staging: "staging_tasks",            qdrant: "activities", objectType: "task",            textBuilder: taskText },
  { staging: "staging_notes",            qdrant: "activities", objectType: "note",            textBuilder: noteText },
  { staging: "staging_calls",            qdrant: "activities", objectType: "call",            textBuilder: callText },
  { staging: "staging_communications",   qdrant: "activities", objectType: "communication",   textBuilder: communicationText },
  { staging: "staging_emails",           qdrant: "activities", objectType: "email",           textBuilder: emailText },
  { staging: "staging_meetings",         qdrant: "activities", objectType: "meeting",         textBuilder: meetingText },
  { staging: "staging_form_submissions", qdrant: "activities", objectType: "form_submission", textBuilder: formSubmissionText },
];
```

### 2.4 Write Fresh

The following components are new to the hive embed script:

#### Qdrant Upsert

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";

const qdrant = new QdrantClient({ url: QDRANT_URL });

async function upsertPoints(
  collection: string,
  points: { id: string; vector: number[]; payload: Record<string, any> }[],
): Promise<void> {
  await qdrant.upsert(collection, {
    wait: true,
    points: points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
    })),
  });
}
```

#### Payload Builders

Payloads must match what the KB MCP server expects. The structure is flat, with `hubspotId`, `objectType`, `embeddingText`, and type-specific fields.

**Contacts collection payloads (`contact` / `company`):**
```typescript
{
  hubspotId: string,
  objectType: "contact" | "company",
  embeddingText: string,
  name: string,
  email: string,
  phone: string,
  company: string,           // contact only
  lifecyclestage: string,    // contact only
  city: string,
  state: string,
  domain: string,            // company only
  industry: string,          // company only
  syncedAt: ISO string,
}
```

**Deals collection payload:**
```typescript
{
  hubspotId: string,
  objectType: "deal",
  embeddingText: string,
  dealname: string,
  amount: number,
  dealstage: string,
  pipeline: string,
  closedate: string,
  contactNames: string[],
  syncedAt: ISO string,
}
```

**Activities collection payloads (task, note, call, communication, email, meeting, form_submission):**
```typescript
{
  hubspotId: string,
  objectType: "task" | "note" | "call" | "communication" | "email" | "meeting" | "form_submission",
  embeddingText: string,
  engagementType: string,    // same as objectType
  timestamp: ISO string,     // activity timestamp
  contactNames: string[],
  syncedAt: ISO string,
}
```

#### Incremental Logic

```typescript
// Read watermark
const meta = await metaCol.findOne({ objectType });
const lastEmbedAt = meta?.lastEmbedAt ?? null;

// Query only new/changed records
const query = lastEmbedAt
  ? { extractedAt: { $gt: lastEmbedAt } }
  : {};  // First run: process all

const records = await stagingCol.find(query).sort({ extractedAt: 1 }).toArray();

// After successful embed + upsert:
const maxExtractedAt = records[records.length - 1].extractedAt;
await metaCol.updateOne(
  { objectType },
  { $set: { lastEmbedAt: maxExtractedAt, recordCount: records.length, updatedAt: new Date() } },
  { upsert: true },
);
```

#### CLI Argument Parsing

```typescript
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const reembed = args.includes("--reembed");
const objectsIdx = args.indexOf("--objects");
const objectsFilter = objectsIdx !== -1 ? args[objectsIdx + 1] : null;
```

- `--dry-run` — Log record counts per object type, skip embedding and upsert
- `--reembed` — Ignore `lastEmbedAt` watermarks, process all records
- `--objects TYPE` — Only process the specified object type (e.g., `--objects deal`)

### 2.5 Main Processing Loop

```
1. Connect to local MongoDB (hubspot database)
2. Connect to Qdrant
3. Load enrichment data (contactNames, activityContactNames, stageMap)
4. For each OBJECT_CONFIG (filtered by --objects if specified):
   a. Read watermark from embed_meta (skip if --reembed)
   b. Query staging collection for records with extractedAt > lastEmbedAt
   c. If --dry-run, log count and continue
   d. Build embedding text for each record using the text builder
   e. Batch embed via Ollama (EMBED_BATCH_SIZE at a time)
   f. Build payloads for Qdrant
   g. Batch upsert to Qdrant
   h. Update watermark in embed_meta
   i. Log summary (records processed, time elapsed)
5. Disconnect and exit
```

---

## 3. Embed Metadata Schema

### Collection: `hubspot.embed_meta`

One document per object type, tracking the incremental high-water mark.

```typescript
interface EmbedMeta {
  objectType: string;      // "contact" | "company" | "deal" | "task" | "note" | "call" | "communication" | "email" | "meeting" | "form_submission"
  lastEmbedAt: Date;       // Max extractedAt of the last processed batch
  recordCount: number;     // Number of records processed in the last run
  updatedAt: Date;         // When this metadata was last updated
}
```

### Seeding Watermarks

After the initial data seed (mongodump/mongorestore from Atlas), watermarks should be set to the current timestamp so the first incremental run finds 0 new records. Qdrant already has all existing data from the Phase 2 migration.

```bash
# Set watermarks via mongosh
mongosh hubspot --eval '
  const now = new Date();
  const types = ["contact","company","deal","task","note","call","communication","email","meeting","form_submission"];
  types.forEach(t => db.embed_meta.updateOne(
    { objectType: t },
    { $set: { lastEmbedAt: now, recordCount: 0, updatedAt: now } },
    { upsert: true }
  ));
'
```

---

## 4. Collection Mapping

| Staging Source (local MongoDB `hubspot`) | Qdrant Target | `objectType` Value |
|---|---|---|
| `staging_contacts` | `contacts` | `contact` |
| `staging_companies` | `contacts` | `company` |
| `staging_deals` | `deals` | `deal` |
| `staging_tasks` | `activities` | `task` |
| `staging_notes` | `activities` | `note` |
| `staging_calls` | `activities` | `call` |
| `staging_communications` | `activities` | `communication` |
| `staging_emails` | `activities` | `email` |
| `staging_meetings` | `activities` | `meeting` |
| `staging_form_submissions` | `activities` | `form_submission` |

Note: Contacts and companies share the `contacts` Qdrant collection, differentiated by `objectType`. All activity types share the `activities` Qdrant collection, differentiated by `objectType` and `engagementType`.

---

## 5. KB MCP Server Changes

### File: `src/search/knowledge-base-mcp-server.ts`

**Current (line 26 area):**
```typescript
const ATLAS_URI = process.env.MONGODB_ATLAS_URI ?? "";
```

**Updated:**
```typescript
const MONGO_URI = process.env.MONGODB_STAGING_URI ?? process.env.MONGODB_ATLAS_URI ?? "";
```

The MongoDB connection (around line 42) should use `MONGO_URI` instead of `ATLAS_URI`. This allows the KB MCP server to read deal stage mappings and other lookup data from local MongoDB while keeping Atlas as a fallback.

### File: `src/agents/agent-runner.ts`

Add `MONGODB_STAGING_URI` to the environment variables passed to the KB MCP server subprocess, alongside existing env vars like `MONGODB_ATLAS_URI`, `QDRANT_URL`, and `OLLAMA_URL`.

---

## 6. Environment Variable Changes

### Marketing Repo (`~/github/marketing/projects/hubspot-pipeline/.env`)

| Variable | Before | After |
|----------|--------|-------|
| `MONGODB_ATLAS_URI` | `mongodb+srv://...` | **Removed** |
| `MONGODB_STAGING_URI` | (not set) | `mongodb://localhost:27017/hubspot` |
| `VOYAGE_API_KEY` | `pa-...` | **Removed** |

### Hive Repo (`.env`)

| Variable | Before | After |
|----------|--------|-------|
| `MONGODB_STAGING_URI` | (not set) | `mongodb://localhost:27017/hubspot` |

The following variables are already set from Phases 1-3 and remain unchanged:

- `OLLAMA_URL=http://localhost:11434`
- `QDRANT_URL=http://localhost:6333`

### Embed Script Defaults

The embed script uses these defaults if env vars are not set:

| Variable | Default |
|----------|---------|
| `MONGODB_STAGING_URI` | `mongodb://localhost:27017/hubspot` |
| `OLLAMA_URL` | `http://localhost:11434` |
| `QDRANT_URL` | `http://localhost:6333` |
| `EMBED_MODEL` | `bge-large` |
| `EMBED_DIMS` | `1024` |

---

## 7. Cron Schedule Updates

### Before

```crontab
# Marketing: extract + embed + sync at 3am
0 3 * * *  cd ~/github/marketing/projects/hubspot-pipeline && ./run-nightly.sh >> logs/hubspot-pipeline.log 2>&1
```

### After

```crontab
# Marketing: extract + sync at 3am (embed step removed)
0 3 * * *  cd ~/github/marketing/projects/hubspot-pipeline && ./run-nightly.sh >> logs/hubspot-pipeline.log 2>&1

# Hive: embed HubSpot data at 4am (after marketing extract completes)
0 4 * * *  cd ~/services/hive && npx tsx scripts/hubspot-embed.ts >> logs/hubspot-embed.log 2>&1
```

The 1-hour gap between extract (3am) and embed (4am) provides margin for the marketing pipeline to complete. The marketing pipeline typically finishes in ~30 minutes.

---

## 8. Package.json Update

Add to the `scripts` section:

```json
{
  "embed:hubspot": "npx tsx scripts/hubspot-embed.ts"
}
```

No new dependencies are needed. `@qdrant/js-client-rest` is already in `package.json` from Phase 3. The `uuid` package (for v5 UUIDs) is already available from `migrate-to-qdrant.ts`.

---

## 9. What to Reuse vs Port vs Write Fresh

| Component | Source | Action |
|-----------|--------|--------|
| `uuidV5()` / `pointId()` | `scripts/migrate-to-qdrant.ts` | **Reuse** — import or copy. Same deterministic ID generation for Qdrant points. |
| `embedBatch()` | `scripts/migrate-to-qdrant.ts` | **Reuse** — Ollama batch embedding with retry. Identical interface. |
| Config constants (`EMBED_MODEL`, `EMBED_DIMS`, etc.) | `scripts/migrate-to-qdrant.ts` | **Reuse** — same naming convention and defaults. |
| 10 text builder functions | Marketing `hubspot-embed.ts` | **Port** — copy and adapt. Same logic, minor adjustments for field naming if staging schema differs from rag schema. |
| `stripHtml()`, `truncate()` | Marketing `hubspot-embed.ts` | **Port** — copy directly, no changes needed. |
| 3 enrichment loaders | Marketing `hubspot-embed.ts` | **Port** — copy and update MongoDB connection to use local staging URI. |
| `OBJECT_CONFIGS` array | Marketing `hubspot-embed.ts` | **Port** — update collection names from `rag_*` to Qdrant collection names. |
| Qdrant upsert logic | N/A | **Write fresh** — uses `@qdrant/js-client-rest` SDK. |
| Payload builders | N/A | **Write fresh** — flat structure matching KB MCP server expectations (see Section 2.4). |
| Incremental logic (`embed_meta`) | N/A | **Write fresh** — watermark tracking, `extractedAt` comparison, metadata updates. |
| CLI argument parsing | N/A | **Write fresh** — `--dry-run`, `--reembed`, `--objects TYPE`. |
| Main processing loop | N/A | **Write fresh** — orchestrates the full pipeline: connect, load enrichments, iterate configs, embed, upsert, update watermarks. |
