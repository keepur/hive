# HubSpot Data Jailbreak — Implementation Specs

## File Index

### New Files
| File | Purpose |
|------|---------|
| `src/hubspot/hubspot-client.ts` | Read-only HubSpot v3 API client with rate limiting |
| `src/hubspot/hubspot-sync.ts` | CLI extraction + dodi transformation + Atlas embedding |
| `src/hubspot/crm-search-mcp-server.ts` | Vector search MCP server over Atlas data |
| `agents-templates/sdr/agent.yaml.tpl` | SDR agent configuration |
| `agents-templates/sdr/system-prompt.md.tpl` | SDR role definition and guidelines |
| `agents-templates/sdr/soul.md.tpl` | SDR personality |

### Modified Files
| File | Change |
|------|--------|
| `src/config.ts` | Add hubspot, atlas, voyageai config sections |
| `src/agents/agent-runner.ts` | Register `crm-search` MCP server in `buildMcpServers()` |
| `.env.example` | Document HUBSPOT_API_KEY, MONGODB_ATLAS_URI, VOYAGEAI_API_KEY, DODI_MONGODB_URI |
| `package.json` | Add `sync:hubspot` and `sync:hubspot:full` scripts |

---

## Spec 1: HubSpot API Client (`src/hubspot/hubspot-client.ts`)

### Interface

```typescript
export class HubSpotClient {
  constructor(apiKey: string);

  // Property discovery
  getProperties(objectType: string): Promise<HubSpotProperty[]>;

  // Paginated extraction (async generator)
  listAll(objectType: string, properties: string[]): AsyncGenerator<HubSpotRecord[]>;

  // Associations (v4 API)
  getAssociations(fromType: string, fromId: string, toType: string): Promise<HubSpotAssociation[]>;
  getBatchAssociations(fromType: string, fromIds: string[], toType: string): Promise<Map<string, string[]>>;

  // Reference data
  listPipelines(): Promise<HubSpotPipeline[]>;
  listOwners(): Promise<HubSpotOwner[]>;

  // Engagements
  listEngagements(objectType: string, objectId: string): Promise<HubSpotEngagement[]>;
}
```

### Types

```typescript
interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
}

interface HubSpotAssociation {
  toObjectId: string;
  associationTypes: { category: string; typeId: number; label: string | null }[];
}

interface HubSpotPipeline {
  id: string;
  label: string;
  stages: { id: string; label: string; displayOrder: number }[];
}

interface HubSpotOwner {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

interface HubSpotEngagement {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}
```

### Rate Limiter

```typescript
class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests = 95;
  private readonly windowMs = 10_000;

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => t > now - this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      const waitMs = this.timestamps[0] + this.windowMs - now + 50;
      await new Promise(r => setTimeout(r, waitMs));
    }
    this.timestamps.push(Date.now());
  }
}
```

### Pagination Strategy

HubSpot search API has a 10,000 result limit. For datasets exceeding this, split by `createdate` ranges:
1. First attempt: standard pagination with `after` cursor
2. If result count hits 10,000: split time range in half and recurse

### Patterns to Follow
- `src/quo/quo-mcp-server.ts` lines 35-57 — raw `fetch()` API helper pattern
- `src/linear/linear-client.ts` — typed client class with `createLogger()`

---

## Spec 2: Sync Pipeline (`src/hubspot/hubspot-sync.ts`)

### CLI Interface

```
Usage: npx tsx src/hubspot/hubspot-sync.ts [options]

Options:
  --full          Full extraction (all records)
  --incremental   Only records updated since last sync (default)
  --dry-run       Preview counts without writing
  --skip-embed    Skip vector embedding step
  --objects TYPE  Sync specific type only: contacts|companies|deals|tasks|activities
```

### Pipeline Steps

```
1. Connect to dodi MongoDB + Atlas
2. Load sync metadata (last sync timestamp)
3. Fetch HubSpot properties → log field counts
4. Fetch owners → build ownerIdMap
5. Fetch pipelines → build stageIdMap
6. Sync contacts → Persons (upsert on hubspotId)
7. Sync companies → Orgs (upsert on hubspotId)
8. Resolve contact↔company associations
9. Sync deals → Deals (upsert, resolve contactId/orgId via idMap)
10. Sync engagements → hubspot_activities_raw (insert)
11. Sync tasks → Tasks (upsert)
12. Generate embeddings → write to Atlas RAG collections
13. Update sync metadata
14. Print summary (created/updated/skipped/errors per type)
```

### dodi Schema Transformation Functions

#### `transformContact(record: HubSpotRecord, ownerMap: Map): Partial<IPerson>`

```typescript
{
  firstName: record.properties.firstname ?? "",
  lastName: record.properties.lastname ?? "",
  name: `${firstname} ${lastname}`.trim(),
  email: record.properties.email?.toLowerCase() ?? "",
  phone: {
    number: normalizePhone(record.properties.phone),  // → "(XXX) XXX-XXXX"
    canReceiveText: true,
  },
  address: record.properties.city ? {
    street1: record.properties.address ?? "",
    vicinity: {
      city: record.properties.city ?? "",
      state: record.properties.state ?? "",
      zipcode: record.properties.zip ?? "",
      state_name: record.properties.state ?? "",
      county: "",
      timezone: "",
      label: `${city}, ${state}`,
    },
  } : undefined,
  website: record.properties.website ?? undefined,
  tags: buildTags(record.properties),  // lifecyclestage, hs_lead_status, jobtitle
  scope: "default",
  // Migration metadata (stored but not part of IPerson):
  _hubspot: {
    id: record.id,
    ownerId: record.properties.hubspot_owner_id,
    ownerName: ownerMap.get(record.properties.hubspot_owner_id),
    importedAt: new Date(),
  },
}
```

#### `transformCompany(record: HubSpotRecord): Partial<IOrg>`

```typescript
{
  name: record.properties.name ?? "",
  email: record.properties.email ?? "",
  phone: {
    number: normalizePhone(record.properties.phone),
    canReceiveText: false,
  },
  website: record.properties.domain ?? "",
  address: /* same pattern as contacts */,
  discriminator: OrgDiscriminator.Business,  // = 1
  tags: [record.properties.industry].filter(Boolean),
  scope: "default",
  _hubspot: { id: record.id, importedAt: new Date() },
}
```

#### `transformDeal(record: HubSpotRecord, idMap, stageMap): Partial<IDeal>`

```typescript
{
  name: record.properties.dealname ?? "",
  docType: "deals",
  value: record.properties.amount ? {
    amount: parseFloat(record.properties.amount),
    uom: record.properties.deal_currency_code ?? "USD",
  } : undefined,
  state: stageMap.get(record.properties.dealstage) ?? record.properties.dealstage ?? "LEAD",
  probability: record.properties.hs_deal_stage_probability
    ? parseInt(record.properties.hs_deal_stage_probability) : undefined,
  expectedCloseDate: record.properties.closedate
    ? new Date(record.properties.closedate) : undefined,
  contactId: idMap.get(`contact:${associatedContactId}`),
  orgId: idMap.get(`company:${associatedCompanyId}`),
  source: mapDealSource(record.properties.hs_analytics_source),
  scope: "default",
  _hubspot: { id: record.id, pipeline: record.properties.pipeline, importedAt: new Date() },
}
```

### Phone Normalization

Reuse pattern from existing `src/contacts/import-hubspot.ts` lines 26-43:
- Strip non-digits
- Handle 11-digit numbers starting with 1
- Validate 10-digit US numbers
- Format as `(XXX) XXX-XXXX`

### ID Mapping

```typescript
const idMap = new Map<string, string>();
// During contact sync: idMap.set(`contact:${hubspotId}`, dodiPersonId)
// During company sync: idMap.set(`company:${hubspotId}`, dodiOrgId)
// During deal sync: look up contactId/orgId from idMap
```

### Embedding Text Composition

```typescript
function buildEmbeddingText(record: any, objectType: string): string {
  // Contact: "Contact: John Smith. Email: john@example.com. Company: Acme Corp. Role: CEO. Stage: customer."
  // Company: "Company: Acme Corp. Domain: acme.com. Industry: Construction. Location: Austin, TX."
  // Deal: "Deal: Kitchen Renovation. Amount: $45,000. Stage: Proposal. Pipeline: Sales."
  // Activity: "Note: Called about cabinet order. Date: 2024-03-15."
}
```

### Sync Metadata Collection (`hubspot_sync_meta`)

```typescript
{
  _id: "hubspot_sync",
  lastFullSync: Date,
  lastIncrementalSync: Date,
  counts: {
    contacts: { total: number, lastSync: number },
    companies: { total: number, lastSync: number },
    deals: { total: number, lastSync: number },
    activities: { total: number, lastSync: number },
    tasks: { total: number, lastSync: number },
  },
}
```

---

## Spec 3: CRM Search MCP Server (`src/hubspot/crm-search-mcp-server.ts`)

### Bootstrap

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient } from "mongodb";

const ATLAS_URI = process.env.MONGODB_ATLAS_URI ?? "";
const VOYAGE_KEY = process.env.VOYAGEAI_API_KEY ?? "";

if (!ATLAS_URI || !VOYAGE_KEY) {
  process.stderr.write("crm-search: MONGODB_ATLAS_URI and VOYAGEAI_API_KEY required\n");
  process.exit(1);
}
```

### Tools

#### `crm_search`
```typescript
inputSchema: {
  query: z.string().describe("Natural language search query"),
  objectType: z.enum(["contact", "company", "deal", "activity", "all"]).optional().default("all"),
  limit: z.number().optional().default(10),
  dateFrom: z.string().optional().describe("ISO date — records after this date"),
  dateTo: z.string().optional().describe("ISO date — records before this date"),
}
```

Implementation: embed query with Voyage AI → `$vectorSearch` on Atlas → merge results → return formatted text.

#### `crm_find_similar`
```typescript
inputSchema: {
  recordId: z.string().describe("MongoDB _id of the source record"),
  collection: z.enum(["rag_contacts", "rag_deals", "rag_activities", "rag_tasks"]),
  limit: z.number().optional().default(5),
}
```

Implementation: fetch source record's embedding → `$vectorSearch` excluding source → return similar records.

#### `crm_timeline`
```typescript
inputSchema: {
  name: z.string().describe("Person or company name to look up"),
  limit: z.number().optional().default(20),
}
```

Implementation: find person/org by name → find all activities referencing their ID → sort by timestamp → return formatted timeline.

#### `crm_stats`
```typescript
inputSchema: {
  metric: z.enum(["pipeline", "lifecycle", "activity_types", "overview"]).optional().default("overview"),
}
```

Implementation: aggregation queries on RAG collections → return formatted stats.

### Voyage AI Embedding Helper

```typescript
async function embed(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "voyage-3-lite", input: [text] }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}
```

### Pattern to Follow
- `src/contacts/contacts-mcp-server.ts` — MongoDB-backed MCP server with lazy connection
- `src/linear/linear-mcp-server.ts` — tool registration and error handling patterns

---

## Spec 4: Config Wiring

### `src/config.ts` — Add after `resend` block (~line 103):

```typescript
hubspot: {
  apiKey: optional("HUBSPOT_API_KEY", ""),
},
mongo: {
  // existing uri, dbName entries...
  atlasUri: optional("MONGODB_ATLAS_URI", ""),
},
dodi: {
  mongoUri: optional("DODI_MONGODB_URI", ""),
},
voyageai: {
  apiKey: optional("VOYAGEAI_API_KEY", ""),
},
```

### `src/agents/agent-runner.ts` — Add in `buildMcpServers()` (after Linear block ~line 177):

```typescript
if (config.mongo.atlasUri && config.voyageai.apiKey) {
  servers["crm-search"] = {
    type: "stdio",
    command: "node",
    args: [resolve("dist/hubspot/crm-search-mcp-server.js")],
    env: {
      MONGODB_ATLAS_URI: config.mongo.atlasUri,
      VOYAGEAI_API_KEY: config.voyageai.apiKey,
    },
  };
}
```

### `.env.example` — Add:

```
# HubSpot Data Extraction
HUBSPOT_API_KEY=              # Private app access token (pat-na1-xxx)

# dodi MongoDB (for structured data migration)
DODI_MONGODB_URI=             # dodi_v2's MongoDB connection string

# MongoDB Atlas (for vector search / RAG)
MONGODB_ATLAS_URI=            # Atlas cluster connection string

# Voyage AI (for embeddings)
VOYAGEAI_API_KEY=             # Voyage AI API key
```

### `package.json` — Add scripts:

```json
"sync:hubspot": "npx tsx src/hubspot/hubspot-sync.ts",
"sync:hubspot:full": "npx tsx src/hubspot/hubspot-sync.ts --full"
```

---

## Spec 5: SDR Agent Template

### `agents-templates/sdr/agent.yaml.tpl`

```yaml
id: sdr
name: "{{agent.name}}"
icon: ":rocket:"
model: claude-sonnet-4-6
channels:
  - sales
  - leads
keywords:
  - lead
  - prospect
  - outreach
  - follow up
  - pipeline
  - deal
  - qualify
isDefault: false
schedule:
  - cron: "0 8 * * 1-5"
    task: morning-pipeline-review
  - cron: "0 14 * * 1-5"
    task: afternoon-follow-ups
  - cron: "0 17 * * 5"
    task: weekly-pipeline-summary
budgetUsd: 50
maxTurns: 30
servers:
  - memory
  - contacts
  - crm-search
  - resend
  - brave-search
  - slack
  - google
  - tasks
```

### `agents-templates/sdr/system-prompt.md.tpl`

SDR role: lead qualification, outbound outreach, follow-up management, CRM search, pipeline reporting. Uses `crm_search` for historical data, `brave_web_search` for prospect research, `send_email` for outreach, `contacts_search` for contact lookup.

### `agents-templates/sdr/soul.md.tpl`

Personality: sharp, prepared, persistent, honest. Prioritizes research before outreach. Conversational and specific in emails. Concise in Slack updates. Detailed in CRM notes.

---

## Testing Plan

### Phase 1 Verification
```bash
# Compile and test API client connectivity
npm run build
HUBSPOT_API_KEY=xxx npx tsx -e "
  import { HubSpotClient } from './dist/hubspot/hubspot-client.js';
  const c = new HubSpotClient(process.env.HUBSPOT_API_KEY);
  const props = await c.getProperties('contacts');
  console.log('Contact properties:', props.length);
  const owners = await c.listOwners();
  console.log('Owners:', owners.length);
"
```

### Phase 2 Verification
```bash
# Dry run to preview counts
npm run sync:hubspot -- --dry-run

# Full sync
npm run sync:hubspot:full

# Verify in dodi DB
mongosh "$DODI_MONGODB_URI" --eval "
  db.Persons.countDocuments({'_hubspot.id': {$exists: true}});
  db.Bizz.countDocuments({'_hubspot.id': {$exists: true}});
  db.Deals.countDocuments({'_hubspot.id': {$exists: true}});
"
```

### Phase 3 Verification
```bash
# Verify Atlas vectors
mongosh "$MONGODB_ATLAS_URI" --eval "
  db.rag_contacts.countDocuments({embedding: {$exists: true}});
"
```

### Phase 4 Verification
- Start dev server with `crm-search` enabled
- Send Slack message to an agent with `crm-search` in its server list
- Ask: "search for homeowners in Austin" → verify `crm_search` tool is called and returns results

### Phase 5 Verification
- Generate SDR agent: `npm run setup:agents`
- Send test message in #sales channel
- Verify SDR responds using CRM search tools
