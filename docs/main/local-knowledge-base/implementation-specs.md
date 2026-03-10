# Local Knowledge Base — Implementation Specs

## 1. Qdrant Collection Schema

All collections use 1024-dimension vectors (bge-large output) with cosine distance.

### CRM Collections (migrated from Atlas)

#### `contacts`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  hubspotId: keyword (indexed)
  dodiId: keyword (indexed)
  objectType: keyword (indexed)  // "contact" | "company"
  embeddingText: text
  name: keyword
  email: keyword
  phone: keyword
  company: keyword
  lifecyclestage: keyword
  city: keyword
  state: keyword
  syncedAt: datetime
```

#### `deals`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  hubspotId: keyword (indexed)
  dodiId: keyword (indexed)
  objectType: keyword (indexed)  // "deal"
  embeddingText: text
  dealname: keyword
  amount: float
  dealstage: keyword
  pipeline: keyword (indexed)  // filter: "default" for Sales Pipeline
  closedate: keyword
  contactNames: keyword[]
  syncedAt: datetime
```

#### `activities`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  hubspotId: keyword (indexed)
  objectType: keyword (indexed)  // "task" | "note" | "call" | "email" | "meeting" | "communication" | "form_submission"
  embeddingText: text
  engagementType: keyword
  timestamp: datetime
  contactNames: keyword[]
  syncedAt: datetime
```

### Operational Collections (new, from dodi_v2 master DB)

#### `persons`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  dodiId: keyword (indexed)
  objectType: keyword  // "person"
  embeddingText: text
  name: keyword
  email: keyword
  phone: keyword
  address: text
  updatedAt: datetime
```

#### `projects`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  dodiId: keyword (indexed)
  objectType: keyword  // "project"
  embeddingText: text
  name: keyword
  status: keyword (indexed)
  customerName: keyword
  address: text
  createdAt: datetime
  updatedAt: datetime
```

#### `designs`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  dodiId: keyword (indexed)
  objectType: keyword  // "design"
  embeddingText: text
  name: keyword
  projectId: keyword (indexed)
  style: keyword
  dimensions: text
  updatedAt: datetime
```

#### `quotes`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  dodiId: keyword (indexed)
  objectType: keyword  // "quote"
  embeddingText: text
  projectId: keyword (indexed)
  total: float
  status: keyword (indexed)
  lineItemCount: integer
  updatedAt: datetime
```

#### `orders`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  dodiId: keyword (indexed)
  objectType: keyword  // "order"
  embeddingText: text
  projectId: keyword (indexed)
  total: float
  status: keyword (indexed)
  updatedAt: datetime
```

#### `jobs`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  dodiId: keyword (indexed)
  objectType: keyword  // "job"
  embeddingText: text
  projectId: keyword (indexed)
  status: keyword (indexed)
  operations: text
  startDate: datetime
  endDate: datetime
  updatedAt: datetime
```

#### `operational_tasks`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  dodiId: keyword (indexed)
  objectType: keyword  // "operational_task"
  embeddingText: text
  projectId: keyword (indexed)
  status: keyword (indexed)
  assignee: keyword
  updatedAt: datetime
```

Note: Named `operational_tasks` to avoid collision with CRM "task" activities in the `activities` collection. The `objectType` value is `operational_task` for filtering.

#### `parts`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  dodiId: keyword (indexed)
  objectType: keyword  // "part"
  embeddingText: text
  family: keyword (indexed)
  name: keyword
  unit: keyword
  price: float
  cost: float          // internal only — sanitized for customer context
  margin: float        // internal only — sanitized for customer context
  updatedAt: datetime
```

#### `cases`
```
vectors: { size: 1024, distance: "Cosine" }
payload fields:
  dodiId: keyword (indexed)
  objectType: keyword  // "case"
  embeddingText: text
  projectId: keyword (indexed)
  caseType: keyword
  status: keyword (indexed)
  description: text
  updatedAt: datetime
```

---

## 2. Ollama Integration

### Endpoint

```
URL: http://localhost:11434/api/embed
Model: bge-large
Dimensions: 1024
```

### Embedding Function (replaces Voyage AI)

```typescript
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = "bge-large";

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embeddings[0];
}
```

### Batch Embedding (for pipeline)

```typescript
async function embedBatch(texts: string[]): Promise<number[][]> {
  // Ollama /api/embed supports array input natively
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embeddings;
}
```

### Key Differences from Voyage AI

- No API key required
- No rate limiting (local inference)
- No `input_type` parameter (bge-large handles query/document uniformly)
- Output is 1024 dimensions (same as Voyage-4-lite)
- Batch size can be larger since there are no API limits (but memory-bound; use batches of 100)

---

## 3. KB MCP Server Changes

### File: `src/search/knowledge-base-mcp-server.ts`

### New Dependencies

```
@qdrant/js-client-rest
```

### Env Var Changes

```
Remove: VOYAGEAI_API_KEY
Add:    OLLAMA_URL (default: http://localhost:11434)
        QDRANT_URL (default: http://localhost:6333)
        KB_EMBED_MODEL (default: bge-large)
Keep:   MONGODB_ATLAS_URI (for fallback and kb_stats aggregations)
Add:    KB_BACKEND (qdrant | atlas, default: qdrant)
```

### Query Flow (new)

```
1. Agent calls kb_search(query, objectType, limit)
2. Embed query via Ollama (< 200ms)
3. Determine target Qdrant collections from objectType
4. Run parallel Qdrant searches across all target collections (< 100ms)
5. Merge results, sort by score, take top N
6. If context == "customer", pass through Haiku sanitization (< 500ms)
7. Format and return results
```

### Collection Mapping Update

```typescript
function collectionsForType(objectType: string): string[] {
  const CRM_COLLECTIONS = ["contacts", "deals", "activities"];
  const OPS_COLLECTIONS = [
    "persons", "projects", "designs", "quotes",
    "orders", "jobs", "operational_tasks", "parts", "cases",
  ];

  switch (objectType) {
    case "all":       return [...CRM_COLLECTIONS, ...OPS_COLLECTIONS];
    case "contact":
    case "company":   return ["contacts"];
    case "deal":      return ["deals"];
    case "activity":  return ["activities"];
    case "person":    return ["persons"];
    case "project":   return ["projects"];
    case "design":    return ["designs"];
    case "quote":     return ["quotes"];
    case "order":     return ["orders"];
    case "job":       return ["jobs"];
    case "task":      return ["operational_tasks"];
    case "part":      return ["parts"];
    case "case":      return ["cases"];
    default:          return CRM_COLLECTIONS;
  }
}
```

### Qdrant Search Function

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://localhost:6333" });

async function searchQdrant(
  collection: string,
  queryVector: number[],
  limit: number,
  filters?: Record<string, any>,
): Promise<any[]> {
  const filter = filters ? { must: Object.entries(filters).map(([key, value]) => ({
    key,
    match: { value },
  })) } : undefined;

  const results = await qdrant.search(collection, {
    vector: queryVector,
    limit,
    with_payload: true,
    filter,
  });

  return results.map((r) => ({
    ...r.payload,
    score: r.score,
  }));
}
```

### Parallel Search (replaces sequential Atlas aggregations)

```typescript
// Current: sequential (slow)
for (const col of collections) {
  const results = await db.collection(col.name).aggregate([...]).toArray();
  allResults.push(...results);
}

// New: parallel (fast)
const searchPromises = collections.map((col) =>
  searchQdrant(col, queryVector, limit, col === "deals" ? { pipeline: "default" } : undefined)
);
const resultArrays = await Promise.all(searchPromises);
const allResults = resultArrays.flat();
```

---

## 4. Pipeline Changes

### File: `~/github/marketing/projects/hubspot-pipeline/src/hubspot-embed.ts`

### Changes

1. **Replace `embedBatch()` function**: Voyage AI HTTP call → Ollama local call (see Section 2)
2. **Replace MongoDB writes → Qdrant upserts**:

```typescript
import { QdrantClient } from "@qdrant/js-client-rest";

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://localhost:6333" });

// Replace ragCol.bulkWrite() with:
async function upsertToQdrant(
  collection: string,
  points: { id: string; vector: number[]; payload: Record<string, any> }[],
): Promise<void> {
  await qdrant.upsert(collection, {
    wait: true,
    points: points.map((p) => ({
      id: p.id,  // Use hubspotId as point ID (convert to UUID or use integer hash)
      vector: p.vector,
      payload: p.payload,
    })),
  });
}
```

3. **Update constants**:
   - `EMBED_DIMENSIONS`: 1024 (unchanged — bge-large matches Voyage-4-lite)
   - `EMBED_BATCH_SIZE`: 128 → 100 (no API rate limits, memory-bound)
   - Remove `VOYAGE_MODEL`
   - Remove `MAX_RETRIES` for Voyage (Ollama is local, retries are simpler)

4. **Remove `ensureVectorIndex()`**: Qdrant indexes are created at collection creation time (Phase 1)

5. **Update RAG collection mapping**: `rag_contacts` → `contacts`, `rag_deals` → `deals`, `rag_activities` → `activities`

6. **Point ID strategy**: Qdrant requires UUID or integer point IDs. Use a deterministic UUID v5 from `${objectType}:${hubspotId}` to enable upserts.

---

## 5. dodi_v2 Data Extraction

### Source: Local MongoDB `master` database

### Embedding Text Formats

```typescript
function personEmbedText(doc: any): string {
  const parts = [`Person: ${doc.name || "Unknown"}`];
  if (doc.email) parts.push(`Email: ${doc.email}`);
  if (doc.phone) parts.push(`Phone: ${doc.phone}`);
  if (doc.address) parts.push(`Address: ${formatAddress(doc.address)}`);
  if (doc.company) parts.push(`Company: ${doc.company}`);
  return parts.join(". ") + ".";
}

function projectEmbedText(doc: any): string {
  const parts = [`Project: ${doc.name || "Unknown"}`];
  if (doc.status) parts.push(`Status: ${doc.status}`);
  if (doc.customer?.name) parts.push(`Customer: ${doc.customer.name}`);
  if (doc.address) parts.push(`Address: ${formatAddress(doc.address)}`);
  if (doc.createdAt) parts.push(`Created: ${doc.createdAt.toISOString().split("T")[0]}`);
  if (doc.description) parts.push(`Description: ${truncate(doc.description, 500)}`);
  return parts.join(". ") + ".";
}

function designEmbedText(doc: any): string {
  const parts = [`Design: ${doc.name || "Unknown"}`];
  if (doc.project?.name) parts.push(`Project: ${doc.project.name}`);
  if (doc.style) parts.push(`Style: ${doc.style}`);
  if (doc.dimensions) parts.push(`Dimensions: ${doc.dimensions}`);
  if (doc.material) parts.push(`Material: ${doc.material}`);
  if (doc.finish) parts.push(`Finish: ${doc.finish}`);
  return parts.join(". ") + ".";
}

function quoteEmbedText(doc: any): string {
  const parts = [`Quote: ${doc.name || doc._id}`];
  if (doc.project?.name) parts.push(`Project: ${doc.project.name}`);
  if (doc.total) parts.push(`Total: $${doc.total.toLocaleString()}`);
  if (doc.status) parts.push(`Status: ${doc.status}`);
  if (doc.lineItems?.length) parts.push(`Line items: ${doc.lineItems.length}`);
  if (doc.createdAt) parts.push(`Date: ${doc.createdAt.toISOString().split("T")[0]}`);
  return parts.join(". ") + ".";
}

function orderEmbedText(doc: any): string {
  const parts = [`Order: ${doc.name || doc._id}`];
  if (doc.project?.name) parts.push(`Project: ${doc.project.name}`);
  if (doc.total) parts.push(`Total: $${doc.total.toLocaleString()}`);
  if (doc.status) parts.push(`Status: ${doc.status}`);
  if (doc.createdAt) parts.push(`Date: ${doc.createdAt.toISOString().split("T")[0]}`);
  return parts.join(". ") + ".";
}

function jobEmbedText(doc: any): string {
  const parts = [`Job: ${doc.name || doc._id}`];
  if (doc.project?.name) parts.push(`Project: ${doc.project.name}`);
  if (doc.status) parts.push(`Status: ${doc.status}`);
  if (doc.operations) parts.push(`Operations: ${truncate(doc.operations, 500)}`);
  if (doc.startDate) parts.push(`Start: ${doc.startDate.toISOString().split("T")[0]}`);
  if (doc.endDate) parts.push(`End: ${doc.endDate.toISOString().split("T")[0]}`);
  return parts.join(". ") + ".";
}

function operationalTaskEmbedText(doc: any): string {
  const parts = [`Task: ${doc.name || doc.title || "(untitled)"}`];
  if (doc.project?.name) parts.push(`Project: ${doc.project.name}`);
  if (doc.status) parts.push(`Status: ${doc.status}`);
  if (doc.assignee) parts.push(`Assignee: ${doc.assignee}`);
  if (doc.dueDate) parts.push(`Due: ${doc.dueDate.toISOString().split("T")[0]}`);
  if (doc.description) parts.push(`Description: ${truncate(doc.description, 500)}`);
  return parts.join(". ") + ".";
}

function partEmbedText(doc: any): string {
  const parts = [`Part: ${doc.name || "Unknown"}`];
  if (doc.family) parts.push(`Family: ${doc.family}`);
  if (doc.unit) parts.push(`Unit: ${doc.unit}`);
  if (doc.price) parts.push(`Price: $${doc.price}`);
  // Cost and margin included in embedding text for internal search relevance
  // but stripped by sanitization layer for customer context
  if (doc.cost) parts.push(`Cost: $${doc.cost}`);
  if (doc.description) parts.push(`Description: ${truncate(doc.description, 300)}`);
  return parts.join(". ") + ".";
}

function caseEmbedText(doc: any): string {
  const parts = [`Case: ${doc.title || doc.type || "Unknown"}`];
  if (doc.project?.name) parts.push(`Project: ${doc.project.name}`);
  if (doc.type) parts.push(`Type: ${doc.type}`);
  if (doc.status) parts.push(`Status: ${doc.status}`);
  if (doc.description) parts.push(`Description: ${truncate(doc.description, 500)}`);
  if (doc.createdAt) parts.push(`Date: ${doc.createdAt.toISOString().split("T")[0]}`);
  return parts.join(". ") + ".";
}
```

### Incremental Strategy

```typescript
// Store last-run timestamps per collection in local MongoDB (hive.kb_sync_state)
interface SyncState {
  collection: string;
  lastSyncedAt: Date;
  recordCount: number;
}

// Query: only records updated since last sync
const query = lastSyncedAt
  ? { updatedAt: { $gt: lastSyncedAt } }
  : {};  // First run: process all

const cursor = masterDb.collection(collectionName).find(query).sort({ updatedAt: 1 });
```

### Pipeline Schedule

```
# crontab addition
0 4 * * *  cd ~/github/hive && node dist/scripts/dodi-embed.js >> ~/logs/dodi-embed.log 2>&1
```

Runs at 4am, after the HubSpot pipeline (3am).

---

## 6. Sanitization Layer

### Context Parameter

Add to `kb_search`, `kb_find_similar`, and `kb_timeline` tool schemas:

```typescript
context: z
  .enum(["internal", "customer"])
  .optional()
  .default("internal")
  .describe("Query context. 'customer' triggers sanitization to strip sensitive internal data."),
```

### Haiku Sanitization Function

```typescript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

const SANITIZATION_PROMPT = `You are a data sanitization filter. Your job is to remove sensitive internal business data from search results before they are shown to a customer.

REMOVE the following from the results:
- Cost prices, margins, markups, supplier costs
- Internal notes, strategy comments, competitive analysis
- Competitor names and comparisons
- Supplier/vendor names and details
- Internal meeting notes and strategy discussions
- Employee performance notes
- Any commentary clearly intended for internal use only

PRESERVE the following:
- Product names, descriptions, specifications, dimensions
- Retail/list prices (customer-facing prices)
- Project names, statuses, dates
- Contact names, emails, phone numbers
- Design styles, materials, finishes
- Order and quote statuses and totals (retail)
- Job statuses and dates

Return the sanitized results in the same format. If an entire result is purely internal (e.g., a strategy note with no customer-relevant content), replace it with "[Result filtered — internal only]".

Do NOT add any commentary. Return only the sanitized results.`;

async function sanitizeForCustomer(rawResults: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-20250414",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `Sanitize these search results for a customer:\n\n${rawResults}`,
      },
    ],
    system: SANITIZATION_PROMPT,
  });

  const block = response.content[0];
  return block.type === "text" ? block.text : rawResults;
}
```

### Integration Point

```typescript
// In kb_search handler, after formatting results:
const formatted = topResults.map((r, i) => formatResult(r, i + 1)).join("\n\n");

const output = context === "customer"
  ? await sanitizeForCustomer(formatted)
  : formatted;

return { content: [{ type: "text", text: `Found ${topResults.length} results:\n\n${output}` }] };
```

### Fields to Watch Per Collection

| Collection | Sensitive Fields | Action |
|------------|-----------------|--------|
| parts | cost, margin, supplier | Strip from results |
| deals | internal notes, strategy comments, competitor mentions | Strip or redact |
| activities | internal meeting notes, strategy discussions | Strip entire result if purely internal |
| quotes | cost breakdown, margin calculation | Strip cost columns, keep retail total |
| orders | cost breakdown | Strip cost columns, keep retail total |
| jobs | internal operations notes | Strip internal commentary |

---

## 7. Launchd Service Configuration

### Ollama — `~/Library/LaunchAgents/com.dodi.ollama.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dodi.ollama</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/ollama</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/mokie/logs/ollama.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/mokie/logs/ollama.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OLLAMA_HOST</key>
    <string>127.0.0.1:11434</string>
  </dict>
</dict>
</plist>
```

### Qdrant — `~/Library/LaunchAgents/com.dodi.qdrant.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dodi.qdrant</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/qdrant</string>
    <string>--config-path</string>
    <string>/opt/homebrew/etc/qdrant/config.yaml</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/mokie/logs/qdrant.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/mokie/logs/qdrant.error.log</string>
  <key>WorkingDirectory</key>
  <string>/opt/homebrew/var/qdrant</string>
</dict>
</plist>
```

---

## 8. Testing Plan

### Latency Benchmarks

| Metric | Current (Atlas+Voyage) | Target (Qdrant+Ollama) |
|--------|----------------------|----------------------|
| Query embedding | 200-500ms | < 100ms |
| Single collection search | 3-5s | < 50ms |
| Full kb_search (all types) | ~16s | < 1s |
| 3-5 searches per agent turn | 50-80s | 3-5s |

Benchmark script: time 100 sequential `kb_search` calls, record p50/p95/p99.

### Search Quality Comparison

1. Define 20+ test queries covering:
   - Name lookups ("find John Smith")
   - Semantic queries ("homeowners in Austin who purchased cabinets")
   - Deal queries ("deals over $50k closed in 2024")
   - Activity queries ("recent calls with Acme Corp")
   - Mixed queries ("projects with kitchen remodel")

2. For each query, record top-5 results from both Atlas and Qdrant
3. Score relevance: count how many of Atlas top-5 appear in Qdrant top-5
4. Accept if 80%+ overlap on relevant results (exact ordering may differ due to different embedding models)

### Sanitization Coverage

Test with 10+ examples containing:
- Part records with cost/margin fields
- Deal records with internal strategy notes
- Activity records with competitor mentions
- Quote records with cost breakdowns
- Mixed results with both safe and sensitive content

Verify:
- All cost/margin/supplier data stripped
- Product names and specs preserved
- Sanitized output is well-formatted
- No false positives on customer-safe data

### Integration Tests

- [ ] `kb_search` with each `objectType` value returns results
- [ ] `kb_search` with `objectType: "all"` searches CRM + operational data
- [ ] `kb_find_similar` works with Qdrant-stored embeddings
- [ ] `kb_timeline` returns chronologically sorted results
- [ ] `kb_stats` overview includes both CRM and operational counts
- [ ] `context: "customer"` triggers sanitization
- [ ] `context: "internal"` (or omitted) returns raw results
- [ ] Nightly HubSpot pipeline writes to Qdrant successfully
- [ ] Nightly operational pipeline runs incrementally
- [ ] Fallback to Atlas works when `KB_BACKEND=atlas`

---

## 9. Config Changes

### New Environment Variables

Add to Hive `.env`:
```
OLLAMA_URL=http://localhost:11434
QDRANT_URL=http://localhost:6333
KB_BACKEND=qdrant
```

Add to hubspot-pipeline `.env`:
```
OLLAMA_URL=http://localhost:11434
QDRANT_URL=http://localhost:6333
```

Remove from hubspot-pipeline `.env` (after Phase 4):
```
VOYAGE_API_KEY  (can be removed once Atlas fallback is no longer needed)
```

### hive.yaml Changes

No changes required. The KB MCP server reads from env vars, not `hive.yaml`. The MCP server command in agent configs already references `knowledge-base-mcp-server`, which will be updated in place.

### Package Dependencies

Add to Hive `package.json`:
```
@qdrant/js-client-rest: ^1.x
```

Add to hubspot-pipeline `package.json`:
```
@qdrant/js-client-rest: ^1.x
```

Remove from hubspot-pipeline (after Phase 4, when Atlas fallback retired):
```
# No packages to remove — MongoDB client stays for staging collections
```

### Crontab Updates

```
# Existing (unchanged)
0 1 * * *  cd ~/github/marketing/projects/permit-monitor && ...
0 3 * * *  cd ~/github/marketing/projects/hubspot-pipeline && ...

# New
0 4 * * *  cd ~/github/hive && node dist/scripts/dodi-embed.js >> ~/logs/dodi-embed.log 2>&1
```
