# Domain Search Split — Implementation Specs

## 1. Shared Module: `src/search/search-shared.ts`

### SearchBackend Interface

```typescript
export interface SearchBackend {
  qdrant: QdrantClient;
  db: Db | null;               // null if MongoDB unavailable
  stageMap: Map<string, string>;
  pipelineMap: Map<string, string>;
  backend: "qdrant" | "atlas";
}
```

### createSearchBackend()

```typescript
export async function createSearchBackend(opts?: {
  requireAtlas?: boolean;  // CRM server sets this when KB_BACKEND=atlas
}): Promise<SearchBackend>
```

Behavior:
- Reads env vars: `KB_BACKEND`, `OLLAMA_URL`, `QDRANT_URL`, `KB_EMBED_MODEL`, `MONGODB_STAGING_URI`, `MONGODB_ATLAS_URI`, `VOYAGEAI_API_KEY`.
- Initializes Qdrant client and verifies connectivity (unless atlas-only).
- Connects to MongoDB if URI is available. Loads stage mappings from `staging_pipelines` collection.
- If `requireAtlas` is true and MongoDB is unavailable, throws.
- Returns a `SearchBackend` object. Callers store this and pass it to helper functions.

### Exported Functions

```typescript
// Embedding
export async function embed(text: string, backend: "qdrant" | "atlas"): Promise<number[]>;
export async function embedOllama(text: string): Promise<number[]>;
export async function embedVoyage(text: string): Promise<number[]>;

// Qdrant search
export async function searchQdrant(
  qdrant: QdrantClient,
  collection: string,
  queryVector: number[],
  limit: number,
  filters?: Record<string, any>,
): Promise<any[]>;

// Stage resolution
export function resolveStage(stageMap: Map<string, string>, stageId: string): string;
export function resolvePipeline(pipelineMap: Map<string, string>, pipelineId: string): string;
export function enrichEmbeddingText(stageMap: Map<string, string>, text: string): string;

// Result formatting
export function formatResult(r: any, index: number, config: FieldConfig): string;

// Types
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface FieldConfig {
  idFields: { hubspotId?: boolean; dodiId?: boolean };
  displayFields: FieldDef[];
  stageMap?: Map<string, string>;
}

export interface FieldDef {
  key: string;        // payload field name
  label: string;      // display label
  prefix?: string;    // e.g. "$" for monetary values
  resolve?: "stage";  // apply resolveStage() to value
}
```

### Env Var Constants (exported)

```typescript
export const KB_BACKEND: "qdrant" | "atlas";
export const OLLAMA_URL: string;
export const QDRANT_URL: string;
export const EMBED_MODEL: string;
export const MONGO_URI: string;
export const VOYAGE_KEY: string;
```

---

## 2. CRM Search Server: `src/search/crm-search-mcp-server.ts`

### Server Identity

```typescript
const server = new McpServer({ name: "crm-search", version: "1.0.0" });
```

### Collections

| objectType | Qdrant Collection | Atlas Collection |
|-----------|-------------------|-----------------|
| contact | contacts | rag_contacts |
| company | contacts | rag_contacts |
| deal | deals | rag_deals |
| activity | activities | rag_activities |
| all | contacts, deals, activities | rag_contacts, rag_deals, rag_activities |

### Tool: crm_search

```typescript
inputSchema: {
  query: z.string().describe("Natural language search query"),
  objectType: z.enum(["contact", "company", "deal", "activity", "all"])
    .optional().default("all"),
  limit: z.number().optional().default(10),
}
```

Behavior:
- Embed query, search target collections in parallel.
- Deals: filter `pipeline: "default"`, 3x oversampling (fetch `limit * 3`, post-filter, take top `limit`).
- Merge results across collections, sort by score descending, take top N.
- Atlas backend: `$vectorSearch` aggregation pipeline with `$match` for deals pipeline filter.

### Tool: crm_find_similar

```typescript
inputSchema: {
  hubspotId: z.string().describe("HubSpot ID of the source record"),
  objectType: z.enum(["contact", "company", "deal", "activity"]),
  limit: z.number().optional().default(5),
}
```

Behavior:
- Fetch source record's embedding vector via Qdrant scroll (filter by hubspotId) or MongoDB findOne.
- Search same collection using source vector. Exclude source from results.
- Deals: apply `pipeline: "default"` filter.

### Tool: crm_timeline

```typescript
inputSchema: {
  name: z.string().describe("Person or company name"),
  limit: z.number().optional().default(20),
}
```

Behavior:
- Embed `"all activities for {name}"`, search `activities` collection.
- Sort results chronologically by `timestamp` (Qdrant) or `properties.hs_timestamp` (Atlas).
- Format with date, engagement type, body, score.

### Tool: crm_stats

```typescript
inputSchema: {
  metric: z.enum(["pipeline", "lifecycle", "activity_types", "overview"])
    .optional().default("overview"),
}
```

Behavior:
- `overview`: point counts for contacts (broken down by contact/company), deals (pipeline=default), activities.
- `pipeline`: MongoDB aggregation on deals by dealstage, with stage name resolution and amount totals.
- `lifecycle`: MongoDB aggregation on contacts by lifecyclestage.
- `activity_types`: MongoDB aggregation on activities by hs_engagement_type.
- Pipeline/lifecycle/activity_types require MongoDB. If unavailable in Qdrant mode, return informative message.

### FieldConfig for CRM

```typescript
const CRM_FIELDS: FieldConfig = {
  idFields: { hubspotId: true, dodiId: true },
  displayFields: [
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "amount", label: "Amount", prefix: "$" },
    { key: "dealstage", label: "Stage", resolve: "stage" },
    { key: "dealname", label: "Deal" },
    { key: "lifecyclestage", label: "Lifecycle" },
    { key: "engagementType", label: "Type" },
    { key: "customerName", label: "Customer" },
    { key: "projectName", label: "Project" },
  ],
  // Atlas variant: fields are under r.properties instead of top-level
};
```

---

## 3. Product Search Server: `src/search/product-search-mcp-server.ts`

### Server Identity

```typescript
const server = new McpServer({ name: "product-search", version: "1.0.0" });
```

### Collections

| objectType | Qdrant Collection |
|-----------|-------------------|
| part | parts |
| product_family | product_families |
| design | designs |
| design_iteration | design_iterations |
| all | parts, product_families, designs, design_iterations |

### Tool: product_search

```typescript
inputSchema: {
  query: z.string().describe("Natural language search query (e.g., 'shaker door styles', 'soft-close hinge options')"),
  objectType: z.enum(["part", "product_family", "design", "design_iteration", "all"])
    .optional().default("all"),
  limit: z.number().optional().default(10),
}
```

Behavior:
- Embed query, search target collections in parallel.
- No special filtering or oversampling.
- Merge, sort by score, take top N.
- Gracefully handle missing collections (e.g., `design_iterations` may not exist yet).

### Tool: product_stats

```typescript
inputSchema: {
  metric: z.enum(["overview"]).optional().default("overview"),
}
```

Behavior:
- Query point counts from all product collections via `qdrant.getCollection()`.
- Display per-collection counts and total.

### FieldConfig for Product

```typescript
const PRODUCT_FIELDS: FieldConfig = {
  idFields: { dodiId: true },
  displayFields: [
    { key: "family", label: "Family" },
    { key: "familyType", label: "Type" },
    { key: "price", label: "Price", prefix: "$" },
    { key: "vendor", label: "Vendor" },
    { key: "status", label: "Status" },
    { key: "customerName", label: "Customer" },
    { key: "projectName", label: "Project" },
  ],
};
```

---

## 4. Ops Search Server: `src/search/ops-search-mcp-server.ts`

### Server Identity

```typescript
const server = new McpServer({ name: "ops-search", version: "1.0.0" });
```

### Collections

| objectType | Qdrant Collection |
|-----------|-------------------|
| person | persons |
| project | projects |
| quote | quotes |
| order | orders |
| job | jobs |
| task | operational_tasks |
| case | cases |
| comment | comments |
| all | (all 8 above) |

### Tool: ops_search

```typescript
inputSchema: {
  query: z.string().describe("Natural language search query (e.g., 'kitchen remodel in progress', 'delayed orders')"),
  objectType: z.enum(["person", "project", "quote", "order", "job", "task", "case", "comment", "all"])
    .optional().default("all"),
  limit: z.number().optional().default(10),
}
```

Behavior:
- Embed query, search target collections in parallel.
- No special filtering or oversampling.
- Merge, sort by score, take top N.

### Tool: ops_stats

```typescript
inputSchema: {
  metric: z.enum(["overview"]).optional().default("overview"),
}
```

Behavior:
- Query point counts from all ops collections via `qdrant.getCollection()`.
- Display per-collection counts and total.

### FieldConfig for Ops

```typescript
const OPS_FIELDS: FieldConfig = {
  idFields: { dodiId: true },
  displayFields: [
    { key: "status", label: "Status" },
    { key: "total", label: "Total", prefix: "$" },
    { key: "customerName", label: "Customer" },
    { key: "projectName", label: "Project" },
    { key: "author", label: "Author" },
    { key: "targetId", label: "Target" },
  ],
};
```

---

## 5. Agent Runner Changes: `src/agents/agent-runner.ts`

Replace lines 287-304 (the `knowledge-base` registration block) with:

```typescript
// ── Domain Search Servers ──────────────────────────────────────
// Shared env vars for all search servers
const searchEnv: Record<string, string> = {
  OLLAMA_URL: process.env.OLLAMA_URL ?? "http://localhost:11434",
  QDRANT_URL: process.env.QDRANT_URL ?? "http://localhost:6333",
};
if (process.env.KB_EMBED_MODEL) searchEnv.KB_EMBED_MODEL = process.env.KB_EMBED_MODEL;
if (process.env.MONGODB_ATLAS_URI) searchEnv.MONGODB_ATLAS_URI = process.env.MONGODB_ATLAS_URI;
if (process.env.MONGODB_STAGING_URI) searchEnv.MONGODB_STAGING_URI = process.env.MONGODB_STAGING_URI;
if (process.env.VOYAGEAI_API_KEY) searchEnv.VOYAGEAI_API_KEY = process.env.VOYAGEAI_API_KEY;

// CRM Search — contacts, deals, activities (supports atlas legacy fallback)
const crmSearchEnv = { ...searchEnv, KB_BACKEND: process.env.KB_BACKEND ?? "qdrant" };
servers["crm-search"] = {
  type: "stdio",
  command: "node",
  args: [resolve("dist/search/crm-search-mcp-server.js")],
  env: crmSearchEnv,
};

// Product Search — parts, product families, designs (Qdrant only)
servers["product-search"] = {
  type: "stdio",
  command: "node",
  args: [resolve("dist/search/product-search-mcp-server.js")],
  env: searchEnv,
};

// Ops Search — persons, projects, quotes, orders, jobs, tasks, cases (Qdrant only)
servers["ops-search"] = {
  type: "stdio",
  command: "node",
  args: [resolve("dist/search/ops-search-mcp-server.js")],
  env: searchEnv,
};
```

Key differences from the old registration:
- Three entries instead of one.
- `KB_BACKEND` only passed to `crm-search` (product/ops are Qdrant-only).
- Shared env extracted into `searchEnv` to avoid repetition.

---

## 6. Agent Template Changes (All 9)

### chief-of-staff/agent.yaml.tpl (Mokie)

```yaml
# Replace:
  - knowledge-base
# With:
  - crm-search
  - product-search
  - ops-search
```

### sdr/agent.yaml.tpl (Milo)

```yaml
# Replace:
  - knowledge-base
# With:
  - crm-search
```

### marketing-manager/agent.yaml.tpl (River)

```yaml
# Replace:
  - knowledge-base
# With:
  - crm-search
```

### executive-assistant/agent.yaml.tpl (Rae)

```yaml
# Replace:
  - knowledge-base
# With:
  - crm-search
```

### devops/agent.yaml.tpl (Colt)

```yaml
# Replace:
  - knowledge-base
# With:
  - crm-search
```

### customer-success/agent.yaml (Jessica)

```yaml
# Replace:
  - knowledge-base
# With:
  - crm-search
  - product-search
```

### product-manager/agent.yaml.tpl (Chloe)

```yaml
# Replace:
  - knowledge-base
# With:
  - crm-search
  - product-search
```

### product-specialist/agent.yaml.tpl (Wyatt)

```yaml
# Add (new capability, after catalog):
  - product-search
```

Current Wyatt servers list is: `memory`, `catalog`, `slack`, `callback`. After change: `memory`, `catalog`, `product-search`, `slack`, `callback`.

### production-support/agent.yaml (Sige)

```yaml
# Replace:
  - knowledge-base
# With:
  - ops-search
```

---

## 7. Testing Plan

### Build Verification

```bash
npm run build   # Must compile with no errors
```

### Server Startup Smoke Test

Each server should start and list its tools via MCP protocol:

```bash
# CRM Search
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | \
  OLLAMA_URL=http://localhost:11434 QDRANT_URL=http://localhost:6333 \
  node dist/search/crm-search-mcp-server.js

# Product Search
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | \
  OLLAMA_URL=http://localhost:11434 QDRANT_URL=http://localhost:6333 \
  node dist/search/product-search-mcp-server.js

# Ops Search
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | \
  OLLAMA_URL=http://localhost:11434 QDRANT_URL=http://localhost:6333 \
  node dist/search/ops-search-mcp-server.js
```

### Functional Test Queries

**CRM Search:**
- `crm_search({ query: "homeowners in Austin", objectType: "contact" })` — should return contacts only
- `crm_search({ query: "deals over $50k", objectType: "deal" })` — deals filtered to Sales Pipeline
- `crm_search({ query: "recent emails about kitchen remodel" })` — cross-type CRM results
- `crm_timeline({ name: "Corey Banner" })` — chronological activity list
- `crm_find_similar({ hubspotId: "<known-id>", objectType: "deal" })` — similar deals
- `crm_stats({ metric: "pipeline" })` — deal stage breakdown with amounts
- `crm_stats({ metric: "overview" })` — counts for contacts, companies, deals, activities

**Product Search:**
- `product_search({ query: "shaker style cabinet doors" })` — parts and product families
- `product_search({ query: "soft close hinge", objectType: "part" })` — parts only
- `product_stats({ metric: "overview" })` — counts per product collection

**Ops Search:**
- `ops_search({ query: "kitchen remodel projects in progress" })` — projects, jobs
- `ops_search({ query: "delayed orders", objectType: "order" })` — orders only
- `ops_search({ query: "assembly issues" })` — cases, comments, jobs
- `ops_stats({ metric: "overview" })` — counts per ops collection

### Domain Isolation Verification

- CRM search must never return parts, projects, jobs, or designs.
- Product search must never return contacts, deals, or activities.
- Ops search must never return contacts, deals, parts, or product families.

### Agent Template Verification

```bash
npm run setup:agents
# Then verify:
grep -r "knowledge-base" agents/        # Should return nothing
grep -r "crm-search" agents/            # Should match expected agents
grep -r "product-search" agents/        # Should match Mokie, Jessica, Chloe, Wyatt
grep -r "ops-search" agents/            # Should match Mokie, Sige
```

### Regression Check

```bash
# No remaining references to old server
grep -r "knowledge-base" src/           # Should return nothing
grep -r "knowledge-base" agents-templates/  # Should return nothing
ls dist/search/knowledge-base-mcp-server.js  # Should not exist after clean build
```
