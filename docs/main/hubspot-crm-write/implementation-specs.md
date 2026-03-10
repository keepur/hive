# Implementation Specs: HubSpot CRM Write

## Files

| File | Action | Description |
|------|--------|-------------|
| `src/hubspot/hubspot-api-client.ts` | Create | HubSpot v3 API client with rate limiting, retry, CRUD |
| `src/hubspot/hubspot-crm-mcp-server.ts` | Create | MCP server with 9 CRM tools |
| `src/agents/agent-runner.ts` | Modify | Register `hubspot-crm` server (after knowledge-base block, ~line 262) |
| `src/config.ts` | Modify | Add `hubspot.apiKey` config entry |
| `agents-templates/customer-success/agent.yaml` | Modify | Add `hubspot-crm` to servers |
| `agents-templates/sdr/agent.yaml.tpl` | Modify | Add `hubspot-crm` to servers |
| `agents-templates/chief-of-staff/agent.yaml.tpl` | Modify | Add `knowledge-base` + `hubspot-crm` to servers |

## API Client Interface

```typescript
class HubSpotApiClient {
  constructor(apiKey: string)

  // Contacts
  findContact(query: string): Promise<HubSpotObject | null>  // search by email or name
  createContact(properties: Record<string, string>): Promise<HubSpotObject>
  updateContact(id: string, properties: Record<string, string>): Promise<void>

  // Deals
  getDeal(id: string): Promise<HubSpotObject>
  createDeal(properties: Record<string, string>): Promise<HubSpotObject>
  updateDeal(id: string, properties: Record<string, string>): Promise<void>

  // Notes & Tasks
  createNote(body: string): Promise<HubSpotObject>
  createTask(properties: Record<string, string>): Promise<HubSpotObject>
  updateTask(id: string, properties: Record<string, string>): Promise<void>

  // Associations
  associate(fromType: string, fromId: string, toType: string, toId: string): Promise<void>
}

interface HubSpotObject {
  id: string
  properties: Record<string, string | null>
  createdAt: string
  updatedAt: string
}
```

## MCP Tool Schemas

### hubspot_find_contact
- `query` (string, required) — email address or name to search
- Returns: contact ID + key properties, or "not found"

### hubspot_create_contact
- `email` (string, required)
- `firstname` (string, optional)
- `lastname` (string, optional)
- `phone` (string, optional)
- `company` (string, optional)
- `jobtitle` (string, optional)
- `lifecyclestage` (string, optional) — e.g. "lead", "opportunity", "customer"
- `associateDealId` (string, optional)
- Returns: created contact ID + properties

### hubspot_update_contact
- `id` (string, required) — HubSpot contact ID
- `properties` (string, required) — JSON object of properties to update
- Returns: confirmation

### hubspot_create_deal
- `dealname` (string, required)
- `pipeline` (string, optional, default "default")
- `dealstage` (string, required) — stage ID or label
- `amount` (string, optional)
- `closedate` (string, optional) — ISO date
- `hubspot_owner_id` (string, optional)
- `associateContactId` (string, optional)
- Returns: created deal ID + properties

### hubspot_update_deal
- `id` (string, required) — HubSpot deal ID
- `properties` (string, required) — JSON object of properties to update
- Returns: confirmation

### hubspot_create_note
- `body` (string, required) — note content (HTML supported)
- `contactId` (string, optional) — associate with contact
- `dealId` (string, optional) — associate with deal
- Returns: created note ID

### hubspot_create_task
- `subject` (string, required)
- `body` (string, optional)
- `status` (enum: NOT_STARTED, IN_PROGRESS, COMPLETED, optional, default NOT_STARTED)
- `priority` (enum: LOW, MEDIUM, HIGH, optional)
- `dueDate` (string, optional) — ISO date
- `hubspot_owner_id` (string, optional)
- `contactId` (string, optional)
- `dealId` (string, optional)
- Returns: created task ID

### hubspot_update_task
- `id` (string, required) — HubSpot task ID
- `properties` (string, required) — JSON object (status, body, priority, etc.)
- Returns: confirmation

### hubspot_associate
- `fromType` (enum: contact, deal, note, task)
- `fromId` (string, required)
- `toType` (enum: contact, deal, note, task)
- `toId` (string, required)
- Returns: confirmation

## Association Type ID Map

```typescript
const ASSOCIATION_TYPES: Record<string, Record<string, number>> = {
  contact: { deal: 4 },
  deal: { contact: 3 },
  note: { contact: 202, deal: 214 },
  task: { contact: 204, deal: 216 },
};
```

## Agent Runner Wiring

Insert after the `knowledge-base` block (~line 262 in agent-runner.ts):

```typescript
const hubspotApiKey = process.env.HUBSPOT_API_KEY ?? "";
if (hubspotApiKey) {
  servers["hubspot-crm"] = {
    type: "stdio",
    command: "node",
    args: [resolve("dist/hubspot/hubspot-crm-mcp-server.js")],
    env: { HUBSPOT_API_KEY: hubspotApiKey },
  };
}
```

## Config Entry

Add to `src/config.ts` after the `resend` block:

```typescript
hubspot: {
  apiKey: optional("HUBSPOT_API_KEY", ""),
},
```

## Testing

1. `npm run build` — compiles without errors
2. Manual: `echo '{}' | HUBSPOT_API_KEY=test node dist/hubspot/hubspot-crm-mcp-server.js` — server starts
3. Integration: create test contact via agent, verify in HubSpot UI
